import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DOCKER_NEVER_STARTED_EXITS } from "./backends.mjs";
import { CONTAINER_GLOBAL_PI_DIR, CONTAINER_HOME, memoryBytesOfArgs } from "./container-spec.mjs";
import { layoutFor } from "./job-layout.mjs";
import { cpuCeilingCenti, cpuRangeRefusal, DEFAULT_JOB_SIZE } from "./job-size.mjs";
import { buildDockerRunArgs, CONTAINER_SESSION_FILE, insideDir } from "./docker-run.mjs";
import { createJobNetwork, egressEnv, networkNameFor, removeJobNetwork } from "./egress.mjs";
import { buildContainerEnv } from "./env-allowlist.mjs";
import { authenticExitLines } from "./run-history.mjs";
import { resolveJobImage } from "./image-preflight.mjs";
import { LIVE_FILE_NAME, stageLiveFile } from "./live-transcript.mjs";
import { steerTargetOf } from "./inbox-relay.mjs";
import { InfraRetry } from "./processor.mjs";
import { makeRedactor, secretValuesOf } from "./redact-secrets.mjs";
import { makeSteerAck } from "./steer-ack.mjs";
import { keyFrame } from "./steer-framing.mjs";
import { makeStderrTranscript } from "./stderr-transcript.mjs";

/**
 * The real `runContainer` the processor injects. Launches one job container and returns
 * `{ code, aborted, turns, tokens, session, usage, context, exitReason, resources?, exitOomKilled?, memoryLimit?, progress? }`, where `aborted` records whether the WORKER initiated the stop (docker stop on
 * the 30-min timeout or graceful shutdown), which the processor classifies as POLICY (no retry) per
 * INT-RUNNER-EXIT-CODE-PROTOCOL. The numeric `code` alone cannot say this: a worker SIGKILL and a
 * kernel OOM both surface as 137, so the abort FLAG -- not the code -- is the discriminator.
 *
 * `spawn` (not execFile) because a non-zero exit is NORMAL here: exit 1 (infra) and 2 (policy) are
 * expected outcomes, not errors to reject on. The exit code comes from the `close` event.
 *
 * The container is stopped on abort by the worker wiring (index.mjs onAbort -> docker stop), which
 * causes `docker run` to exit and this promise to resolve. We only handle the entry case here: if
 * the signal is ALREADY aborted (the 30-min timeout fired during a slow prepare), do not start a
 * container at all.
 *
 * Output is streamed to `onOutput` (default: the worker's stdout) so the operator watches the agent
 * work on their own machine -- the natural local UX. When raw capture is enabled
 * (`PI_CAPTURE_JOB_LOGS`), the same output is tee'd to a host-only, gitignored `logs/<jobId>.log`
 * that is never mounted into the container and may contain agent-echoed issue text (PII). The
 * worker's event log and the `.json` status record stay id-only.
 */
export function makeRunContainer({
	image, // the DEPLOYMENT default (PI_JOB_IMAGE); a trigger's own run.image overrides it per job
	hostEnv = process.env,
	onOutput = (c) => process.stdout.write(c),
	openJobLog = () => ({ write() {}, close: async () => ({ turns: null, tokens: null, session: null, usage: null, context: null, exitReason: null }) }),
	spawnFn = spawn,
	globalPiDir = null, // REQ-GLOBAL-PI-OVERLAY: operator's global pi overlay dir, mounted :ro; null = off
	allowGlobalExtensions = true, // REQ-GLOBAL-PI-OVERLAY: the staged overlay's extensions load unless PI_GLOBAL_ALLOW_EXTENSIONS=0
	// REQ-GLOBAL-PI-OVERLAY: container paths of the operator-staged packages. An array, or a RESOLVER called
	// once per job (issue #102): the wired worker passes a resolver so a re-stage lands on the next job with
	// no restart, while the array form stays valid for every caller that has a fixed set.
	packagePaths = [],
	forwardEnv = [],
	authFromPi = false, // fall back to ~/.pi/agent/auth.json for the provider key when the env has none
	forgeHosts = {}, // per-forge self-hosted instance URLs, so a forge CLI in the container talks to the right one
	egress = false, // REQ-EGRESS-ALLOWLIST: put this job on its own --internal network behind the allowlist proxy
	egressProxy, // the proxy component attached to that network; undefined = egress.mjs's default name
	// Issue #345: the exits this runtime spells "never started", after which the cidfile says whether a container was
	// created anyway; and the host fs the cidfile is read and removed through. Seams for the tests.
	neverStartedExits = DOCKER_NEVER_STARTED_EXITS,
	fs = { readFileSync, rmSync },
	detachedCheck = {}, // the clock and bounds `stopDetached` takes, a seam so a test does not wait out a real 10 s
	// Issue #354: the runtime's CLI and its argv builder, a PAIR. Every spawn below names `bin` -- the run, the job
	// network's create and teardown, the detached check -- so a podman venue cannot run its container under one binary
	// and look for it (or remove its network) under another. The defaults are the local venue's, byte-identical.
	bin = "docker",
	buildArgs = buildDockerRunArgs,
	// Issue #452, gate round 4: `(job) => runtime | undefined`, the runtime THIS job was ADMITTED on (recorded per job),
	// handed to the teardown's detach gate so the teardown never reads the daemon again; `undefined` falls back to a read.
	// `log` names a teardown the gate refused, which leaves the job's network for the boot reaper.
	teardownRuntime = null,
	log = () => {},
	// Issue #545: the per-job exit-line key, 32 random bytes as hex. A seam so a test can name the key it verifies with.
	mintExitKey = () => randomBytes(32).toString("hex"),
	// Issue #596: called when the runtime refused this job's `--cpus` as above its CPU count (`cpu_ceiling_stale`), so
	// the wiring drops the cached runtime facts the ceiling came from and the next pickup reads them again. The local
	// venue's is the job-user resolver's `invalidate`; a no-op elsewhere (Podman accepts any `--cpus`, measured).
	onCpuCeilingStale = () => {},
	// Issue #643: `({ file, jobId, redact, job }) => { start, finish, progressSummary? } | null`, the live transcript
	// publisher's opener (live-transcript.mjs `makeLiveTranscriptOpener`), which since issue #644 also reads run progress.
	// Null publishes nothing: a deployment with PI_LIVE_TRANSCRIPTS=0 and PI_RUN_PROGRESS=0, one without a Valkey client,
	// and every caller that predates the feature.
	openLiveTranscript = null,
	// Issue #645: stages the live transcript file for a `run.recover` job the preparer staged none for (both live switches
	// off). A seam so a test can refuse it.
	stageLive = stageLiveFile,
	// Issue #645: the bound on each step of stopping a container whose unpause never took.
	checkpointStopTimeoutMs = 15_000,
	// Issue #646: `({ runId, jobId, inboxDir, targetKey, ref, forge }) => relay`, the inbox relay's opener (inbox-relay.mjs
	// `makeInboxRelay`, bound in start.mjs to the worker's Valkey client and host name). Null arms no job: a steer job is
	// then run without steering and its record says `steerSkipped: "no-transcript"`, never a silent no-op. Issue #686: a
	// stdin-steered attempt opens it with `inboxDir: null` and `frames: { exitKey, macRunId }`, then `attach`es the pipe.
	openInboxRelay = null,
	// Issue #646: the host fs the inbox directory is made and removed through. A seam for the tests.
	inboxFs = { mkdirSync, rmSync },
	// Issue #683: the venue's file layout (job-layout.mjs). `mounts` for every binding venue, byte-identical to before;
	// `sandbox` for a copying one (`openshell`), which moves the session file and the staged packages' container paths
	// under /sandbox and writes PI_JOB_LAYOUT.
	layout = "mounts",
	// Issue #683: the container's memory bound in bytes, given the argv and the options it was built from. Both binding
	// builders spell it `--memory=`, so the default reads the argv; a venue whose argv carries no such flag (an `exec`
	// into a sandbox sized at create) says it from the job's size instead.
	memoryLimitOf = (args) => memoryBytesOfArgs(args),
	// Issue #683: a copying venue's own steps around the CLI child, each awaited. `stageRun({ args, opts })` runs after the
	// argv is built and before the spawn (the venue's create, policy read-back and upload); a throw there is
	// `container-never-started`, refunded and retried, since nothing ran. `collectRun(result)` runs once the child has
	// closed (the download), and returns the result to resolve with. `teardownRun()` runs in the `finally`, on every
	// path a `stageRun` was begun on (the delete). Each is handed THIS attempt's build options (`opts`, the name among
	// them), so a venue running several jobs at once acts on its own sandbox only. Absent, a binding venue's run is
	// exactly what it was.
	stageRun = null,
	collectRun = null,
	teardownRun = null,
	// Issue #686: how this venue's session file reaches the host while the job runs. `file` for every binding venue (the
	// live tail reads the bind-mounted file, byte-identical to before); `stdio` for a copying one (`openshell`), whose
	// runner mirrors the file's lines over the CLI's stderr as records signed with the exit key, which this side
	// verifies and pushes into the same publisher (stderr-transcript.mjs). A CONSTRUCTION option, the venue's own
	// statement beside `layout`, rather than read off the call bag's `binds`: `binds` reaches a steer job only (the
	// registry adds it for that one question), while every job of a copying venue needs this answer, and a venue that
	// copies but cannot mirror (none today) is then named for what it is (`venue-copies`) instead of guessed from a flag.
	transcript = "file",
	// Issue #686: the stderr demux's factory (stderr-transcript.mjs). A seam so a test can make it fail.
	makeDemux = makeStderrTranscript,
	// Review round 1, M1: how long a stdin-steered attempt's pipe stays open after an exit-shaped line that does not verify.
	stdinExitGraceMs = 5_000,
	// Issue #686 part 3, review round 2 of #714: `({ opts, aborted }) => boolean`, a binding venue whose box OUTLIVES its CLI
	// child (`openshell-bind`: the sandbox stays after the exec, and a process the agent left behind can still write the
	// bound host tree). Awaited once the child has closed and BEFORE the transcript's final read and the sink's close, so
	// the last lines and the processor's reads both see a tree nothing writes any more. `false` (not confirmed gone) puts
	// `lingering: true` on the result, which the processor reads (no exit checkpoint; the named result where a retry
	// would be wrong). Absent, every venue's run is exactly what it was.
	settleRun = null,
	// Issue #704 part 3: this venue hands a project secret bundle's plain variables to the runner by FILE (the job
	// directory's bundle-env.json, which its `stageRun` writes), so an attempt with plain bundle variables gets
	// PI_BUNDLE_ENV=1. A construction option, the venue's own statement like `transcript`: every binding venue passes
	// them as env and leaves it off, so its env is byte-identical.
	bundleEnvFile = false,
	// Issue #730: this venue's connections are mediated by a broker that must read the caller's memory (OpenShell), so
	// every attempt gets PI_RUNNER_OBSERVABLE=1 and its key holders start from the readable node. Every other venue
	// leaves it off and its env is byte-identical.
	observableRunner = false,
}) {
	// Refused at construction rather than written into a job's env: a guessed layout reads nothing.
	const paths = layoutFor(layout);
	// async so a synchronous throw (e.g. buildContainerEnv on an unconfigured provider) surfaces as
	// a rejection, uniformly awaitable by the processor and by tests.
	// `relabel` (issue #355) is the processor's, off the same job-user answer as `user`: true where the daemon confines
	// containers with SELinux, so the worker's own per-job mounts carry `:Z`. Defaults off, so a caller that predates it
	// builds exactly the argv it always did.
	// `modelEndpoints` (issue #503) is the pickup's endpoint snapshot, the one the free credential gate decided on, so a
	// keyless provider's PI_DISPATCH_KEYLESS is written from the same declaration and never from a second read.
	// `exitAuth` (issue #545) is the processor's, off the image preflight: true when the job image declares `exitAuth`, so
	// its runner reads a key from stdin and signs its exit line with it. Defaults off, so a caller that predates it, and
	// every image that does not declare it, runs exactly as before and is read exactly as before.
	// `size` (issue #596) is the job's `{ memMiB, cpuCenti, source }`, resolved at pickup from the limits snapshot and
	// handed here as an argument, never through `job.data`; absent, the built-in 4g and 2. `hostCpus` is the runtime's own
	// CPU count from the job user's facts read, which sets the `--cpus` ceiling; null leaves `--cpus` off (fails open, and
	// says so in `cpu_ceiling_unknown`). `cpuBudgetCenti` (phase 2) is the host's CPU budget at pickup, which replaces that
	// ceiling while it is in force (`cpuCeilingCenti`).
	// `unenforced` (issue #596) is the size flags this runtime said it drops (`unenforcedSizeFlags`: `--memory-swap` where
	// Docker reports SwapLimit false, `--cpu-shares` where it reports CPUShares false), logged per job as
	// `size_bound_unenforced` so a run past its size's bound is named where it happens. The flags stay on the argv.
	// `jobId` (issue #643) is the queue's job id, which names the live transcript stream as it names the run record
	// (`run:live:` and `runs:rec:`, both through `sanitizeJobId`); absent, no stream is published.
	// `onLive(finish)` (issue #644) hears this attempt's bounded, idempotent publisher finish once the publisher is open, so
	// the processor can end it when it stops waiting for a container whose stop did not take (index.mjs
	// `boundAfterAbort`). Without it the publisher ends only on the CLI child's `close` or `error`, which never comes
	// for that container: the progress key's heartbeat rewrote it as running for its whole 7-day window.
	// `checkpoint` (issue #645) is the processor's open args for the run checkpointer (`{ runId, attempt, baseSha, branch,
	// secretValues, meta }`), honoured only beside `recover: true`; `pause`/`unpause` are this job's venue's freezer verbs,
	// which the backend registry puts on the call bag (absent for a venue that cannot freeze: no live checkpoints then).
	// `binds` (issue #646) is the venue's own statement that it bind-mounts (the backend bundle's `binds`, which the registry
	// puts on the call bag of a steer job only): a copying venue would upload `/inbox` once, at the start, so no message
	// written later would ever arrive. Absent is false: a job is steer-armed only on a venue that SAYS it binds.
	// `transcriptStderr` (issue #686) is the processor's, off the image preflight like `exitAuth`: true when the job image
	// declares `transcriptStderr`, so its runner can mirror the session file over stderr. Read only on a `stdio` venue.
	// `steerStdin` (issue #686, part 2) is the processor's too: true when the job image declares `steerStdin`, so its
	// runner reads steer messages as MAC'd frames on stdin. Read only for a steer job on a venue that copies (`binds` not
	// true); a binding venue keeps the read-only mount whatever the image declares.
	// `bundleKeys` (issue #704 part 3) is the processor's `{ endpoints, plain }` split of a project secret bundle's received
	// variables: handed on in the build options for a venue whose own layer holds credentials (openshell), which binds the
	// first kind to their hosts and passes the second as values. Every other venue ignores it: the values are in `secrets`.
	return async function runContainer({ job, token, prepared, secrets = {}, bundleKeys = null, name, signal, user = null, home = null, relabel = false, modelEndpoints = null, exitAuth = false, transcriptStderr = false, steerStdin = false, size = DEFAULT_JOB_SIZE, hostCpus = null, cpuBudgetCenti = null, unenforced = [], jobId = null, onLive = null, recover = false, recovering = false, checkpoint = null, pause = null, unpause = null, binds = false }) {
		if (signal?.aborted) return { code: 137, aborted: true, turns: null, tokens: null, session: null, usage: null, context: null, exitReason: null }; // killed before it could start
		// Minted per attempt, held in this closure and the sink's, and handed to the container on its stdin only: never in
		// the argv (a host `ps` shows it), never in the env (the container's /proc/1/environ shows it), never logged.
		const exitKey = exitAuth === true ? mintExitKey() : null;
		// Issue #341. `user` and `home` travel as a PAIR: a uid with no passwd entry in the image gets `HOME=/` from
		// Docker and `HOME=/workspace` from Podman (measured), so a `--user` without this HOME is refused here rather
		// than started. The builder does not insist, because `doctor --live`'s probes run `--user` with no environment.
		if (user !== null && home !== CONTAINER_HOME) {
			throw new Error(`runContainer: a job user (${user}) must be paired with HOME=${CONTAINER_HOME}`);
		}

		// Issue #643: the directory holding this job's transcript file, mounted at /session. A resume job's is its staged
		// transcript, exactly as before; every other job's is the empty live file the preparer staged beside it
		// (`prepared.live`, live-transcript.mjs `stageLiveFile`). Resume itself stays keyed on `prepared.session` alone:
		// `awaitInput` below, the promotion and the record's `session` read nothing else.
		let transcriptDir = prepared.session?.hostDir ?? prepared.live?.hostDir ?? null;
		// Issue #645: an armed job keeps its transcript on the host whatever the live switches say. The checkpoints copy it,
		// a salvage reads it from a crashed attempt's job dir, and the live checkpoints are driven by its lines, so with
		// PI_LIVE_TRANSCRIPTS=0 and PI_RUN_PROGRESS=0 (no file staged by the preparer) it is staged here. Not for a resume
		// job, whose staged transcript already is the file.
		const armed = recover === true && checkpoint !== null && typeof checkpoint === "object";

		// Issue #686 (DES-OPENSHELL-VENUE): whether this attempt's transcript comes over the CLI's stderr. Decided BEFORE
		// steering, because a stdin-steered attempt's acks come back through it. Asked only where
		// something would read it (an opener and a job id) on a venue whose session file is not on the host while it runs,
		// and armed only when every part exists: the venue mirrors (`transcript: "stdio"`), the image's runner can
		// (`transcriptStderr`), and there is an exit key to verify the records with. A missing part is a NAMED skip
		// (`live_transcript_skipped`); the job still runs, with no live transcript and no progress, as before this issue.
		const liveReadable = typeof openLiveTranscript === "function" && jobId !== null && jobId !== undefined;
		let liveSkipped = null;
		if (liveReadable && (transcript === "stdio" || layout !== "mounts")) {
			if (transcript !== "stdio") liveSkipped = "venue-copies";
			else if (transcriptStderr !== true) liveSkipped = "no-capability";
			else if (exitKey === null) liveSkipped = "no-exit-key";
		}
		const stdioArmed = liveReadable && transcript === "stdio" && liveSkipped === null;
		if (liveSkipped !== null) log("live_transcript_skipped", { container: name, reason: liveSkipped });

		// Issue #646 (DES-STEER-VIA-READONLY-INBOX-MOUNT): whether this attempt is steer-ARMED. Asked by the job's data
		// (`steer: true`, which the trigger's `run.steer` puts there and the image preflight already checked the image for),
		// and armed only when every part of the channel exists: a venue that binds mounts, an exit key to verify the
		// delivery acks with, and something to read those acks (a transcript tail) and to write the files (the relay).
		// Each missing part is a NAMED skip on the record (`steerSkipped`); the job still runs, as it would without
		// `run.steer`, and a message for it is refused at push because nothing ever registers it as open.
		//
		// Issue #686 (INT-STEER-INBOX-CONTRACT's second transport): on a venue that COPIES (`binds` not true) the inbox part
		// is the exec's stdin instead of the mount, when the image's runner reads frames (`steerStdin`). Its parts are the
		// same key, a relay, and the stdio transcript (`stdioArmed`, above), which is where the acks come back; without that
		// the attempt is `no-transcript`, as a binding venue without a tail is. An image without `steerStdin` there is
		// skipped exactly as before, `venue-copies`. A binding venue never takes this path, whatever the image declares.
		const steerAsked = job?.steer === true;
		const viaStdin = binds !== true && steerStdin === true;
		let steerSkipped = null;
		if (steerAsked) {
			if (binds !== true && steerStdin !== true) steerSkipped = "venue-copies";
			else if (exitKey === null) steerSkipped = "no-exit-key";
			else if (typeof openInboxRelay !== "function" || typeof openLiveTranscript !== "function" || jobId === null || jobId === undefined) steerSkipped = "no-transcript";
			else if (viaStdin && !stdioArmed) steerSkipped = "no-transcript";
		}
		if (transcriptDir === null && (recover === true || (steerAsked && steerSkipped === null)) && typeof stageLive === "function") {
			try {
				transcriptDir = stageLive(prepared.jobDir)?.hostDir ?? null;
			} catch {
				transcriptDir = null;
			}
		}
		if (steerAsked && steerSkipped === null && transcriptDir === null) steerSkipped = "no-transcript";
		// The inbox: `<jobDir>.inbox`, BESIDE the job directory (`/job` is merge-gated input only, and the processor removes
		// the job directory itself), mode 0700, made fresh per attempt (a retry's messages are written again into its own),
		// removed in this function's `finally`. Then the relay, built now (it starts with the container) because the env
		// and the argv below depend on whether the attempt is armed.
		const inboxDir = `${prepared.jobDir}.inbox`;
		let inboxMade = false;
		let relay = null;
		// The stdin transport has no directory: its messages go down the pipe.
		if (steerAsked && steerSkipped === null && !viaStdin) {
			try {
				inboxFs.rmSync(inboxDir, { recursive: true, force: true });
				inboxFs.mkdirSync(inboxDir, { mode: 0o700 });
				inboxMade = true;
			} catch {
				steerSkipped = "no-inbox";
			}
		}
		if (steerAsked && steerSkipped === null) {
			try {
				// `runId` is the RUN's id (`jobId` here is `runIdOf(job)`, index.mjs), so a #645 recovery writes the same inbox.
				// Issue #686: the stdin transport's relay MACs each frame under this attempt's key and the container's PI_JOB_ID
				// (`name`, as the ack's `ackRunId`); a binding venue's relay is opened with exactly the arguments it always was.
				relay = openInboxRelay({ runId: jobId, jobId, inboxDir: viaStdin ? null : inboxDir, ...steerTargetOf(job), ...(viaStdin ? { frames: { exitKey, macRunId: name } } : {}) }) ?? null;
			} catch {
				relay = null;
			}
			if (relay === null) steerSkipped = "no-transcript";
		}
		const steerArmed = steerAsked && steerSkipped === null;
		// Issue #686: this attempt's key goes down stdin as frame 1 and the pipe stays OPEN for the relay's frames.
		const stdinSteered = steerArmed && viaStdin;
		if (steerSkipped !== null) log("steer_skipped", { container: name, reason: steerSkipped });
		// The ack consumer, handed to the live tail below. It verifies under THIS attempt's exit key, against the very string
		// put in the container's PI_JOB_ID (`jobId: name` in the env below), which is what the runner MACs: one value on both
		// sides by construction. The per-attempt key is the domain separation between attempts; the string only has to match.
		const steerAck = steerArmed ? makeSteerAck({ exitKey, ackRunId: name, relay, jobId, log }) : null;

		const removeInbox = () => {
			if (!inboxMade) return;
			try {
				inboxFs.rmSync(inboxDir, { recursive: true, force: true });
			} catch {
				// best effort: a leftover directory holds framed text the worker wrote, beside the job dir the sweep removes
			}
		};

		// Closed env allowlist: only the provider key + the declared PI_* vars. Throws (config) if
		// the provider is unconfigured, which the processor turns into a policy refusal that refunds the
		// reserve. That sentence was aspirational until issue #310: the processor did not read the
		// `piDispatchConfig` tag at all, so the throw fell through to a bare rethrow with the budget kept.
		// The common case no longer reaches here either, because the processor probes the same resolution
		// among its free gates, ahead of the mint and the clone.
		// Issue #646: a throw from here to the spawn (an unconfigured provider, a refused argv, a network that would not build)
		// happens before the `finally` below exists, so the inbox directory made above is removed on the way out.
		const beforeSpawn = (fn) => {
			try {
				return fn();
			} catch (error) {
				removeInbox();
				throw error;
			}
		};
		const env = beforeSpawn(() => buildContainerEnv({
			provider: job.provider,
			model: job.model,
			fork: job.fork ?? null,
			thinkingLevel: job.thinkingLevel ?? null,
			maxTurns: job.maxTurns,
			maxTokens: job.maxTokens, // optional per-job token budget (issue #25); undefined => runner meter only
			maxCostMicros: job.maxCostMicros ?? null, // issue #501: effectiveJobOf's min of trigger and deployment; null => no cap
			jobId: name,
			githubToken: token ?? undefined,
			// Which forge minted it, so the token lands in that forge's own variable names and no other.
			forgeKind: job?.kind,
			forgeHosts,
			hostEnv,
			egress, // REQ-EGRESS-ALLOWLIST: emits HTTPS_PROXY/HTTP_PROXY/NO_PROXY/NODE_USE_ENV_PROXY, or nothing
			egressProxy,
			allowGlobalExtensions, // REQ-GLOBAL-PI-OVERLAY: false emits the explicit PI_GLOBAL_ALLOW_EXTENSIONS=0 opt-out
			// REQ-GLOBAL-PI-OVERLAY: the per-job value comes off `job` (like maxTurns), the staged set off
			// the closure (like allowGlobalExtensions) -- so a trigger can withhold what the operator staged.
			// `!== false`, because staged packages LOAD unless a trigger explicitly opts out
			// (INT-TRIGGERS-FILE-CONTRACT). The strictness that used to live in this `=== true` did not
			// disappear, it moved: parseTriggers refuses any non-boolean run.packages fail-loud at load, so a
			// hand-edited string "false" never becomes job data this comparison could misread as an opt-out.
			// The opt-out short-circuits BEFORE the resolver runs: a trigger that withheld the staged set has no
			// reason to make the worker read the manifest on its behalf.
			// Issue #683: the staged packages' container paths are the overlay's, so on the sandbox layout their prefix moves
			// with it (`/opt/pi-global` to `/sandbox/pi-global`). A path not under the overlay is passed as it was.
			packagePaths: (job.packages === false ? [] : typeof packagePaths === "function" ? packagePaths() : packagePaths).map((p) => (layout !== "mounts" && typeof p === "string" && p.startsWith(`${CONTAINER_GLOBAL_PI_DIR}/`) ? `${paths.global}${p.slice(CONTAINER_GLOBAL_PI_DIR.length)}` : p)),
			forwardEnv, // extra host var names to forward (e.g. a custom provider's key)
			// REQ-RESUMABLE-SESSION: the fixed container path, emitted only when this job HAS a transcript file, which
			// since issue #643 is every prepared job (the live file), resume or not. The constant is imported rather than
			// re-typed so the mount below and this variable name one path -- two literals is how they drift with both
			// suites green. On an empty file the runner opens a fresh session there (image/runner/src/session.mjs), the
			// same path a cold-starting resume job takes, so the image needs no change.
			// Issue #683: under the layout's session directory, which on `mounts` is CONTAINER_SESSION_FILE exactly.
			sessionFile: transcriptDir ? (layout === "mounts" ? CONTAINER_SESSION_FILE : `${paths.session}/current.jsonl`) : undefined,
			layout,
			// Issue #189: the flow name, structurally, so the runner can verify it against the loaded
			// skill set. Off `job` like maxTurns; absent (a bare run.task cron job) emits no variable.
			flow: typeof job.flow === "string" && job.flow.trim() !== "" ? job.flow : undefined,
			// Issue #189: the command name, structurally, so the runner can refuse an unregistered one
			// before any spend (command-unregistered). Same guard shape as `flow` directly above, and
			// mutually exclusive with it by parse -- a job carries one or the other, never both.
			command: typeof job.command === "string" && job.command.trim() !== "" ? job.command : undefined,
			// Issue #291: the trigger's tool denylist, off `job` like command/flow. The loader guarantees a
			// non-empty validated array; the guard is the same defensive shape `flow` above wears, so a
			// hand-built job with junk in the field emits no variable rather than an empty one.
			excludeTools: Array.isArray(job.excludeTools) && job.excludeTools.length > 0 ? job.excludeTools : undefined,
			// REQ-MCP-OPERATOR-SERVERS: the trigger's MCP server names, off `job` like excludeTools.
			mcpServers: Array.isArray(job.mcp) && job.mcp.length > 0 ? job.mcp : undefined,
			// Issue #625: whether the runner offers the tool a parked run ends on. Only beside a staged transcript: the
			// runner refuses the flag without one (await-input-without-session), so a job whose resume degraded to no
			// mount is not armed into that refusal.
			awaitInput: job.awaitInput === true && prepared.session ? true : undefined,
			// Issue #644: whether the runner offers `report_progress`, off `job` like awaitInput (env-allowlist.mjs maps it to
			// PI_REPORT_PROGRESS=1). The worker reads the phases it reports only for the same job (`job.progress` below).
			reportProgress: job.progress === true ? true : undefined,
			// Issue #645, durable runs: off the call bag, NOT off `job`. Whether this attempt keeps checkpoints and whether it
			// is the continuation of a lost one are the processor's decisions, made against the checkpoint store and the
			// image's `recover` capability; a `job.recover` read here would arm a container the processor never cleared.
			// Strict `=== true` both ways, so a truthy non-boolean arms nothing.
			recover: recover === true,
			recovering: recovering === true,
			// Issue #646: PI_STEER=1, only for an ARMED attempt (above), never off `job.steer` alone: the runner refuses the
			// flag without a readable /inbox and a key, and a job the worker could not arm must not be refused for it.
			steer: steerArmed,
			// Issue #502: the effective allowed-model list, off `job` like excludeTools. index.mjs `effectiveJobOf` folds
			// the deployment's PI_ALLOWED_MODELS in under the trigger's own, so `job.models` is already the one list.
			allowedModels: Array.isArray(job.models) && job.models.length > 0 ? job.models : null,
			authFromPi, // source the provider key from pi's auth.json when the env has none
			// REQ-TRIGGER-SECRETS: this trigger's resolved secrets, fetched by the processor BEFORE anything
			// spent. Off the call bag rather than off `job` or the closure: it is neither a per-job fact the
			// record may carry nor a deployment setting, it is a live credential, and `token` is its precedent.
			secrets,
			home: user !== null ? home : null, // issue #341: HOME only beside --user, assigned after the forward loops
			modelEndpoints, // issue #503: the keyless branch of the credential, from the gate's own snapshot
			exitAuth: exitKey !== null, // issue #545: PI_EXIT_AUTH=stdin, only when a key is actually handed over below
			// Issue #686: PI_TRANSCRIPT=stderr, only for an attempt armed above, never off the image's label alone: the
			// worker must be reading the records, or they would reach the job log as noise.
			transcriptStderr: stdioArmed,
			// Issue #686: PI_EXIT_AUTH=stdin-frames, only for an attempt armed above for stdin steering (beside PI_STEER=1).
			steerStdin: stdinSteered,
			bundleEnvFile: bundleEnvFile === true && Array.isArray(bundleKeys?.plain) && bundleKeys.plain.length > 0,
			observableRunner: observableRunner === true,
		}));

		// `-net` on this container's own name (egress.mjs). null when no policy is armed, and docker-run's
		// guard then omits the flag entirely, so the argv is byte-identical to one built before this feature.
		const network = egress ? networkNameFor(name) : null;

		// Issue #345: BESIDE the job directory, never inside the `/job:ro` mount. Removed first because the docker CLI refuses
		// to start with an existing cidfile; every attempt's job dir is a fresh mkdtemp, so a leftover is not expected, and
		// this keeps one from turning into a start failure if a caller ever reuses a directory.
		const cidFile = `${prepared.jobDir}.cid`;
		try {
			fs.rmSync(cidFile, { force: true });
		} catch {
			// an unremovable stale file makes the run itself fail to start, which is reported as that
		}

		const buildOpts = {
			// Same split as packagePaths above: the per-job value off `job`, the deployment value off the closure,
			// so a trigger can name its own toolchain (INT-TRIGGERS-FILE-CONTRACT). Resolved through the SAME
			// function the pre-spend preflight uses (image-preflight.mjs), so the tag that was checked is the tag
			// that runs -- one answer by construction, not two call sites that happen to agree.
			image: resolveJobImage(job, image),
			env,
			jobDir: prepared.jobDir,
			workspace: prepared.workspace,
			outboxDir: prepared.outboxDir, // undefined for github jobs -> docker-run's guard skips the /outbox mount
			// The job's OWN copy, under jobDir -- never the shared store. Undefined only when no transcript file was staged
			// (a caller that predates issue #643, or a staging that failed), and docker-run's guard then skips the mount.
			sessionDir: transcriptDir ?? undefined,
			// Issue #646: the inbox, read-only at /inbox, for an armed attempt only; undefined leaves the argv byte-identical.
			steerInboxDir: steerArmed && !stdinSteered ? inboxDir : undefined,
			globalPiDir, // undefined/null -> docker-run's guard skips the /opt/pi-global mount
			name,
			size, // issue #596: memory, swap equal to it, the CPU weight and /dev/shm, through containerSpec's one function
			hostCpus, // issue #596: the `--cpus` ceiling every job shares; null leaves the flag off
			cpuBudgetCenti, // issue #596, phase 2: the host's CPU budget, the ceiling while it is in force
			network, // REQ-EGRESS-ALLOWLIST: null when no policy is armed, and the flag is then absent
			user, // issue #341: the worker's own "<uid>:<gid>" on a daemon that enforces bind-mount ownership, else null
			cidFile, // issue #345: where the CLI writes this attempt's container ID, read below when the run exits "never started"
			// Issue #355. `=== true`, so only the processor's boolean re-owns anything. The workspace is relabelled only when the
			// worker made it: a forge job's is its own clone under the job dir, a local job's IS the operator's folder, which a
			// private label would take from every other container and from the operator's own labelling.
			relabel: relabel === true,
			// Both facts, the kind the preparers branch on AND containment in this job's own directory, so a kind added later
			// that works on a folder in place fails closed rather than relabelling it.
			workspaceOwned: job?.kind !== "local" && insideDir(prepared.jobDir, prepared.workspace),
			// Issue #545: `-i`, so the container's stdin is the pipe the key is written to. Absent otherwise, and the argv is
			// byte-identical to one built before the signed exit line.
			...(exitKey !== null ? { extraFlags: ["-i"] } : {}),
			// Issue #704 part 3: absent without a bundle, so every other build is byte-identical.
			...(bundleKeys !== null && typeof bundleKeys === "object" ? { bundleKeys } : {}),
		};
		const args = beforeSpawn(() => buildArgs(buildOpts));

		// Issue #596: the memory bound this container actually got, in bytes, read off the argv the runtime is handed (both
		// builders spell it `--memory=`, from the job's size), never re-derived from the environment or the size. The
		// processor confirms an OOM only when the run's peak reached 90% of it. null when the argv names none.
		const memoryLimit = memoryLimitOf(args, buildOpts);
		if (!args.some((a) => typeof a === "string" && a.startsWith("--cpus="))) log("cpu_ceiling_unknown", { container: name });
		if (Array.isArray(unenforced) && unenforced.length > 0) log("size_bound_unenforced", { container: name, flags: unenforced.filter((f) => typeof f === "string" && /^--[a-z-]{1,32}$/.test(f)) });

		// REQ-EGRESS-ALLOWLIST. This job's own --internal network, created here rather than at boot because
		// it holds exactly two endpoints -- this container and the proxy -- and that is what makes job-to-job
		// traffic structurally impossible rather than merely discouraged. A shared network could not do it:
		// `enable_icc=false` would block job-to-job AND job-to-proxy, since ICC governs every container pair
		// on the bridge and the proxy is a container.
		//
		// A failure to build it is INFRA, not policy: nothing has been spent, a retry may well succeed, and
		// `container-never-started` is literally true, so the reservation is given back (processor.mjs).
		if (network && !(await createJobNetwork(spawnFn, { network, proxy: egressProxy, bin }))) {
			removeInbox();
			throw new InfraRetry("container-never-started", { reason: "container-never-started" });
		}

		// Issue #683: a copying venue's create and upload, before anything spawns the job. Its teardown is owed from the
		// moment it begins, so a stage that fails half way (a sandbox made, an upload refused) is still deleted.
		let staged = false;
		const teardown = async () => {
			if (!staged || typeof teardownRun !== "function") return;
			try {
				await teardownRun({ opts: buildOpts });
			} catch {
				// best effort: the reaper deletes what this left, by the job's label
			}
		};
		if (typeof stageRun === "function") {
			staged = true;
			try {
				// Issue #684: the job and the pickup's endpoint snapshot ride with it, for the venue's per-job network policy.
				await stageRun({ args, opts: buildOpts, signal, job, modelEndpoints });
			} catch (cause) {
				await teardown();
				removeInbox();
				if (network) await removeJobNetwork(spawnFn, { network, proxy: egressProxy, bin });
				if (cause instanceof InfraRetry) throw cause;
				throw new InfraRetry("container-never-started", { cause, reason: "container-never-started" });
			}
			// A stop that landed while the venue was still creating or uploading (the job's timeout, a shutdown): its own
			// stop found nothing to delete yet, so nothing would stop the exec. The run ends here, as stopped, and the
			// teardown deletes what the stage made.
			if (signal?.aborted) {
				await teardown();
				removeInbox();
				if (network) await removeJobNetwork(spawnFn, { network, proxy: egressProxy, bin });
				return { code: 137, aborted: true, turns: null, tokens: null, session: null, usage: null, context: null, exitReason: null };
			}
		}

		// Issue #643: the live transcript publisher, opened only beside a transcript file, an opener and a job id. Its
		// redactor is built from THIS job's env (the secret-bearing keys, redact-secrets.mjs) plus the two credentials that
		// are not in it by name or at all: the minted token and the exit-line key. An opener that throws costs the stream,
		// never the run.
		let live = null;
		// Issue #645: a container whose unpause failed UNPAUSE_TRIES times never runs again, and the worker would wait on it
		// for the whole job timeout. It is killed (SIGKILL reaches a frozen container: the runtime thaws it to deliver it),
		// then removed if the kill was refused, and the run ends as an infrastructure exit (`checkpointStopped`).
		let checkpointStopped = false;
		const stopFrozen = async () => {
			checkpointStopped = true;
			log("checkpoint_container_stopped", { container: name });
			const killed = await dockerStep(spawnFn, ["kill", name], checkpointStopTimeoutMs, bin);
			if (killed.code !== 0) await dockerStep(spawnFn, ["rm", "-f", name], checkpointStopTimeoutMs, bin);
		};
		// Issue #686: on a copying venue the host file is the upload's copy, never written while the job runs, so it is not
		// tailed: the transcript is the stderr records' (`stdioArmed`) or there is none (`liveSkipped`).
		if (liveReadable && liveSkipped === null && (stdioArmed || transcriptDir)) {
			try {
				// `workerSet`: the proxy variables count as structural only with the values this worker wrote for this job's
				// egress; a proxy URL an operator forwarded with PI_EGRESS=0 is redacted like any other forwarded value.
				const workerSet = egressEnv({ proxy: egressProxy, armed: egress });
				// `job` (issue #644) for its two switches, `progress` (read phases) and `statusComment` (the forge comment).
				// `checkpoint` (issue #645): the open args this side adds to the processor's, the container's name and venue
				// verbs, the workspace and job dir, and `onStop` for an unpause that never took. Only for an armed job.
				const checkpointArgs = armed
					? {
							...checkpoint,
							containerName: name,
							pause: typeof pause === "function" ? pause : null,
							unpause: typeof unpause === "function" ? unpause : null,
							workspace: prepared.workspace ?? null,
							jobDir: prepared.jobDir ?? null,
							onStop: () => stopFrozen(),
						}
					: null;
				// The stdio source has no file; a checkpoint copies a host file, so none is opened on it (a copying venue refuses
				// `run.recover` before spend). The steer acks ride it as they ride a tailed file (issue #686): the records are
				// the session's lines, so a delivered message's `custom_message` reaches the ack consumer the same way.
				const source = stdioArmed ? { source: "stdio", file: null } : { file: join(transcriptDir, LIVE_FILE_NAME) };
				live = openLiveTranscript({ ...source, jobId, redact: makeRedactor({ values: secretValuesOf(env, [token, exitKey], { workerSet }) }), job, ...(checkpointArgs && !stdioArmed ? { checkpoint: checkpointArgs } : {}), ...(steerAck ? { steer: steerAck } : {}) }) ?? null;
			} catch {
				live = null;
			}
		}
		// Issue #644: no publisher means no progress, so a trigger's `run.statusComment` cannot be honoured. Said once, by
		// reason: both switches off (no opener), or no transcript file or job id to read progress from. Issue #686: a
		// copying venue's skipped transcript is `no-transcript` too (its own reason is on `live_transcript_skipped`); before
		// the openshell bundle was handed the opener it read `progress-off` there, which named the wrong switch.
		if (job?.statusComment === true && live === null) log("status_comment_skipped", { jobId: jobId ?? null, reason: typeof openLiveTranscript === "function" ? "no-transcript" : "progress-off" });
		// Bounded and never throwing (live-transcript.mjs); called at most once, and always BEFORE this function resolves,
		// so before the processor's `finally` removes the job directory the file lives in.
		const finishLive = async (outcome) => {
			try {
				await live?.finish(outcome);
			} catch {}
		};
		// Issue #646: an armed attempt whose tail could not be opened can deliver messages that no ack will ever count; they
		// settle as late. Said, never silent.
		if (steerArmed && live === null) log("steer_acks_unread", { container: name });
		// Issue #646: the relay's end, AFTER the tail's final read (`finishLive`), so a last-moment ack is handed to the relay
		// and marked before the liveness keys go; the settle step's close (index.mjs) then sees it as delivered. Once.
		let relayStopping = null;
		const stopRelay = () => {
			relayStopping ??= (async () => {
				try {
					await steerAck?.drain();
				} catch {}
				try {
					await relay?.stop();
				} catch {}
			})();
			return relayStopping;
		};
		// Issue #645: the checkpoint handle the opener built for an armed job, or null. Never throws (run-checkpoint.mjs).
		const ckpt = live?.checkpoint && typeof live.checkpoint.close === "function" ? live.checkpoint : null;
		const closeCheckpoint = async () => {
			try {
				return await ckpt?.close();
			} catch {
				return null;
			}
		};
		// What the processor is handed: `exit()` once the container is dead (an infra exit of an armed job), `close()`
		// before its cleanup, `stats()` for the record's counts. Spread only when there is a handle, so every other run
		// resolves the very object it always did.
		const checkpointResult = ckpt
			? {
					checkpoint: {
						exit: (opts) => ckpt.exit(opts),
						close: () => closeCheckpoint(),
						stats: () => ckpt.stats(),
					},
				}
			: {};
		if (live !== null && typeof onLive === "function") {
			try {
				onLive(finishLive);
			} catch {}
		}

		// Host-side per-job log sink, teed off `onOutput`. `name` is `pi-job-<jobId>`; the sink
		// sanitizes internally. No container mount, no env var -- the sink lives on this side only.
		// Issue #683: a staged venue's teardown is owed from here, so a synchronous throw before the `try` below still
		// deletes what the stage made.
		let sink;
		try {
			sink = openJobLog(name, { exitKey });
		} catch (error) {
			await teardown();
			removeInbox();
			throw error;
		}
		// Issue #596: the head of the CLI's stderr, kept only to recognise the runtime's refusal of a stale `--cpus`
		// (`cpuRangeRefusal`). Bounded, and never logged: only the count it names leaves this function.
		let stderrHead = "";
		const STDERR_HEAD_MAX = 4096;
		// Issue #686: an armed attempt's stderr goes through the record demux first. Records are verified under THIS
		// attempt's exit key against the string in the container's PI_JOB_ID (`name`, as the steer ack's `ackRunId`), and
		// their lines pushed into the publisher; every other byte is passed on unchanged to the tee and the head below.
		// Demuxed even when the opener returned no publisher, so the records never reach the job log or the terminal.
		const demux = stdioArmed
			? makeDemux({
					key: exitKey,
					runId: name,
					onBaseline: (size) => live?.setBaseline?.(size),
					onLine: (line, end) => live?.push?.(line, end),
					onGap: (missing) => live?.skip?.(missing),
					onReset: (size) => live?.reset?.(size),
				})
			: null;
		let demuxEnded = false;
		// A demux that threw is not asked again for this attempt (none is known to throw). Its error carries what that chunk
		// had already passed on and the part of it not yet read, so the output is exactly: those passed bytes, then what it
		// held (`end()`), then the unread rest, then every later chunk as it comes. No byte twice, and no completed
		// record's bytes. A throw that carries neither (not the demux's own) passes the chunk on whole.
		let demuxFailed = false;
		const endDemux = () => {
			if (demux === null || demuxEnded) return Buffer.alloc(0);
			demuxEnded = true;
			const counts = demux.stats();
			// Counts only, never a payload: a forged record is the agent's text.
			if (counts.unverified > 0) log("transcript_record_unverified", { container: name, count: counts.unverified });
			if (counts.replayed > 0 || counts.gaps > 0 || counts.oversize > 0) log("transcript_record_dropped", { container: name, replayed: counts.replayed, gaps: counts.gaps, oversize: counts.oversize });
			return demux.end();
		};

		const run = new Promise((resolve, reject) => {
			const child = spawnFn(bin, args, { stdio: [exitKey !== null ? "pipe" : "ignore", "pipe", "pipe"] });
			// Issue #686: a stdin-steered attempt's key is frame 1, written at the spawn, and the pipe is NOT closed: it is
			// handed to the relay, which writes each message as a frame after it and closes the pipe at its stop. The relay
			// writes nothing before the publisher's baseline (the runner's signed baseline record and the lines up to it, so a
			// resumed transcript's acks are known first). The runner reads exactly frame 1 before pi loads, so the key is out
			// of the pipe before any tool exists, as on every other attempt.
			if (stdinSteered) {
				child.stdin?.on("error", () => {});
				const first = keyFrame(exitKey);
				try {
					child.stdin?.write(first);
				} catch {}
				relay?.attach?.(child.stdin, { written: first.length });
				// The baseline, when this side already knows it: a job with no staged session (not a resume, not a recovery)
				// uploads the empty live file the preparer made, so its transcript has no prior line and nothing to
				// re-baseline against. Released here, at the spawn, rather than when the runner's baseline record comes back
				// over stderr (about 600 ms in, measured on Docker): a message queued before the start then reaches the runner
				// before its first agent_start, where pi polls its steering queue once before the first model call, instead
				// of racing the run. A staged transcript waits for the record as before (the ack's `onBaseline` is once only).
				if (!prepared.session && recover !== true) {
					try {
						steerAck?.onBaseline();
					} catch {}
				}
			}
			try {
				live?.start();
			} catch {}
			// Issue #646: registered live with the container, so a push is accepted only while there is a run to read it.
			void relay?.start();
			if (exitKey !== null && !stdinSteered) {
				// Written and closed at once: the runner drains stdin to EOF before anything else runs, so the key is out of
				// the pipe before any tool exists. A CLI that died first makes this EPIPE, which is the run failing, reported
				// by `error` or `close` below; the listener only keeps the write's own error from crashing the worker.
				child.stdin?.on("error", () => {});
				child.stdin?.end(`${exitKey}\n`);
			}
			// A throwing sink.write is swallowed so a misbehaving sink cannot break the tee or hang the run.
			const tee = (chunk) => {
				onOutput(chunk);
				try {
					sink.write(chunk);
				} catch {}
			};
			child.stdout?.on("data", tee);
			// Review round 1, M1: a stdin-steered attempt's pipe is ended as soon as the runner's exit line is out, so a CLI
			// that waited for EOF before it exits could never wait on the relay (OpenShell 0.1.4 does not wait, measured on
			// the real gateway; this is the defence, and the close at the relay's stop stays). A line that VERIFIES under the
			// attempt's key ends it at once; an exit-shaped line that does not (the supervisor's unkeyed one, a forgery) ends
			// it after `stdinExitGraceMs`, so a forged line can only cut steering short, never hold the pipe open. Lines are
			// cut on newlines from a bounded buffer; a line past the bound is skipped.
			if (stdinSteered) {
				let held = "";
				let graceTimer = null;
				const STDIN_LINE_MAX = 256 * 1024;
				let stdinClosed = false;
				// Said once, by which line ended it: a pipe ended early is steering cut short for the rest of the attempt, and
				// every message accepted after it settles `late` (the relay writes nothing more).
				const closeNow = (reason) => {
					if (graceTimer) clearTimeout(graceTimer);
					graceTimer = null;
					if (stdinClosed) return;
					stdinClosed = true;
					log("steer_stdin_closed", { container: name, reason });
					try {
						relay?.closeStdin?.();
					} catch {}
				};
				child.stdout?.on("data", (chunk) => {
					held += String(chunk);
					let nl = held.indexOf("\n");
					while (nl !== -1) {
						const line = held.slice(0, nl);
						held = held.slice(nl + 1);
						if (line.includes('{"event":"exit"')) {
							if (authenticExitLines(line, exitKey) !== "") closeNow("exit-verified");
							else if (graceTimer === null && !stdinClosed) {
								graceTimer = setTimeout(() => closeNow("exit-unverified"), stdinExitGraceMs);
								graceTimer.unref?.();
							}
						}
						nl = held.indexOf("\n");
					}
					if (held.length > STDIN_LINE_MAX) held = "";
				});
				child.on("close", () => {
					if (graceTimer) clearTimeout(graceTimer);
				});
			}
			const stderrOut = (chunk) => {
				if (chunk.length === 0) return;
				if (stderrHead.length < STDERR_HEAD_MAX) stderrHead = (stderrHead + String(chunk)).slice(0, STDERR_HEAD_MAX);
				tee(chunk);
			};
			child.stderr?.on("data", (chunk) => {
				if (demux === null || demuxFailed) {
					if (stderrHead.length < STDERR_HEAD_MAX) stderrHead = (stderrHead + String(chunk)).slice(0, STDERR_HEAD_MAX);
					tee(chunk);
					return;
				}
				let out;
				try {
					out = demux.push(chunk);
				} catch (error) {
					demuxFailed = true;
					log("transcript_demux_failed", { container: name });
					const carried = Buffer.isBuffer(error?.passed) && Buffer.isBuffer(error?.rest);
					out = carried ? Buffer.concat([error.passed, endDemux(), error.rest]) : Buffer.concat([endDemux(), Buffer.from(chunk)]);
				}
				stderrOut(out);
			});
			// docker not found / daemon down -- a transient infra fault, so tag it retryable
			// (CONST-RETRY-INFRA-ONLY). `reason` also cues the processor to release the budget slot,
			// since a container that never started spent nothing.
			child.on("error", (err) => {
				stderrOut(endDemux());
				void closeCheckpoint();
				void finishLive("failed").then(stopRelay);
				sink.close().catch(() => {}); // best-effort teardown; a rejecting close cannot leak an unhandled rejection
				reject(new InfraRetry("container-never-started", { cause: err, reason: "container-never-started" }));
			});
			child.on("close", async (code) => {
				const aborted = signal?.aborted === true; // capture BEFORE the await
				// Issue #686: the demux's held tail (a last line with no newline) goes out before anything closes, and every
				// record it completed is in the publisher before the final flush below.
				stderrOut(endDemux());
				// Issue #686 part 3, review round 2: the venue's box ended and confirmed gone first (see `settleRun`).
				let settled = null;
				if (typeof settleRun === "function") {
					try {
						settled = (await settleRun({ opts: buildOpts, aborted })) === true;
					} catch {
						settled = false;
					}
				}
				const lingered = settled === false ? { lingering: true } : {};
				// Issue #645: no live checkpoint starts once the container is gone (a quiet point in the final read would
				// pause a dead container). Closing first, and awaiting it after the final read, lets a live one in flight
				// finish, its pointer included, before this promise resolves and the processor's cleanup can run.
				const ckptClosed = closeCheckpoint();
				// Issue #643, ORDER LOAD-BEARING: the transcript's last lines are read and published HERE, before the sink
				// closes and before this promise resolves, because the processor removes the job directory (and the file in
				// it) as soon as it has the result. The outcome is the exit's own reading, the most this side knows.
				await finishLive(liveOutcomeOf(code, aborted, neverStartedExits));
				// Issue #644: the run record's `progress`, read once the final snapshot was taken. Only when the opener ran the
				// progress reducer for this job; absent otherwise, so every other run resolves the object it always did.
				let progress = null;
				try {
					progress = live?.progressSummary?.() ?? null;
				} catch {
					progress = null;
				}
				const ranProgress = progress !== null && typeof progress === "object" ? { progress } : {};
				await ckptClosed;
				const stoppedForCheckpoint = checkpointStopped ? { checkpointStopped: true } : {};
				// A rejecting sink.close is swallowed so a misbehaving sink cannot hang the run; turns/tokens/session/usage/context/exitReason fall back to null.
				let turns = null;
				let tokens = null;
				let session = null;
				let usage = null;
				let context = null;
				// Issue #437: the runner's exit-2 reason, already filtered by parseExitReason to the closed
				// RUNNER_POLICY_REASONS set and to a line that itself said code 2. The processor still decides
				// the retry class from `code` alone; this only picks the label inside exit 2.
				let exitReason = null;
				// Issue #501 (PR #542's review, round 3): the decisive exit line's own `code` (decisiveExitLine), which the
				// dollar settlement compares with the container's real exit code before it trusts that line's cost.
				let exitLineCode = null;
				// Issue #507: the cost guard's rule on a `cost-cap` line, already filtered by parseExitWhy to COST_CAP_WHYS.
				let exitWhy = null;
				// Issue #545: null (no key issued), "verified" or "unverified" (a key, and no exit line carried it).
				let exitAuthResult = null;
				// Issue #596: what the container used, off its exit line (parseExitResources), or null.
				let resources = null;
				// Issue #596: the image's supervisor reported the runner killed for memory (parseExitOomKilled).
				let exitOomKilled = false;
				// Issue #645: a recovered run's runner counts (parseExitRecovery), `{ orphans, replayed, interrupted, notStarted }`
				// each an integer or null, or null when the line carried none.
				let recovery = null;
				// Issue #646: a steer-armed runner's inbox counts (parseExitSteer), `{ delivered, pending }`, or null.
				let steerCounts = null;
				try {
					// `context = null` is a DEFAULT rather than a plain destructure: an injected sink that
					// predates the field returns no such key, and `undefined` would then reach the record's
					// shape where every other absence is spelled `null`.
					// `exitReason` defaults the same way, for the same reason.
					({ turns, tokens, session, usage, context = null, exitReason = null, exitLineCode = null, exitWhy = null, exitAuth: exitAuthResult = null, resources = null, exitOomKilled = false, recovery = null, steer: steerCounts = null } = await sink.close());
				} catch {
					turns = null;
					tokens = null;
					session = null;
					usage = null;
					context = null;
					exitReason = null;
					exitLineCode = null;
					exitWhy = null;
					resources = null;
					exitOomKilled = false;
					recovery = null;
					steerCounts = null;
					// The sink could not say, and a key was issued: nothing it returned was verified.
					exitAuthResult = exitKey !== null ? "unverified" : null;
				}
				// A sink that predates the field returned none; with a key issued, that is still nothing verified.
				if (exitKey !== null && exitAuthResult !== "verified") {
					exitAuthResult = "unverified";
					turns = null;
					tokens = null;
					session = null;
					usage = null;
					context = null;
					exitReason = null;
					exitLineCode = null;
					exitWhy = null;
					resources = null;
					exitOomKilled = false;
					recovery = null;
					steerCounts = null;
				}
				// Spread only when a key was issued, so a run without one resolves the very object it always did.
				const auth = exitKey !== null ? { exitAuth: exitAuthResult } : {};
				// `exitWhy` only when the line named one, so every other run resolves the object it always did.
				const why = exitWhy !== null ? { exitWhy } : {};
				// `resources` (issue #596) only when the exit line carried a block, so every other run resolves the object it always did.
				// `memoryLimit` only beside the OOM report, the one place it is read, for the same reason.
				const used = { ...(resources !== null && resources !== undefined ? { resources } : {}), ...(exitOomKilled === true ? { exitOomKilled: true, memoryLimit } : {}) };
				// `recovery` (issue #645) only when the exit line carried the block, so every other run resolves the object it always did.
				const recovered = recovery !== null && typeof recovery === "object" ? { recovery } : {};
				// Issue #646, review finding F3: the deliveries the runner's SIGNED exit line names are marked before the relay
				// stops. The transcript is the agent's to break (a symlink swapped in makes the tail refuse it), so the acks
				// it carries are not the only witness: the exit line is signed with the key the agent never sees, and with a
				// key issued every field above is nulled unless it verified. The tail's acks are drained first, so these marks
				// only add what the transcript could not say. Then the relay stops, after which the settle step closes.
				if (steerArmed && exitAuthResult === "verified" && Array.isArray(steerCounts?.deliveredIds)) {
					try {
						await steerAck?.drain();
					} catch {}
					for (const id of steerCounts.deliveredIds) {
						try {
							await relay?.delivered(id);
						} catch {}
					}
				}
				await stopRelay();
				// Issue #646: only for a job that asked for steering, so every other run resolves the object it always did.
				// `steer` is the runner's own count (advisory, like `recovery`), without the ids; `steerSkipped` the verdict.
				const steerShown = steerCounts !== null && typeof steerCounts === "object" ? { delivered: steerCounts.delivered ?? null, pending: steerCounts.pending ?? null } : null;
				const steered = steerAsked ? { ...(steerArmed && steerShown !== null ? { steer: steerShown } : {}), ...(steerSkipped !== null ? { steerSkipped } : {}) } : {};
				// Issue #712: the named live-transcript skip, for the record's `liveSkipped`, only when there was one.
				const liveShown = liveSkipped !== null ? { liveSkipped } : {};
				resolve(aborted ? { code: code ?? 137, aborted: true, turns, tokens, session, usage, context, exitReason, exitLineCode, ...why, ...used, ...auth, ...ranProgress, ...recovered, ...steered, ...liveShown, ...checkpointResult, ...stoppedForCheckpoint, ...lingered } : { code: code ?? 1, aborted: false, turns, tokens, session, usage, context, exitReason, exitLineCode, ...why, ...used, ...auth, ...ranProgress, ...recovered, ...steered, ...liveShown, ...checkpointResult, ...stoppedForCheckpoint, ...lingered });
			});
		});

		// The network outlives the container by exactly this `finally`. Best-effort and never throwing: the
		// container has already exited, its code is the job's answer, and a teardown fault must not rewrite
		// that answer. What a failure leaves behind is a memberless network, which the boot reaper sweeps.
		try {
			const result = await run;
			// Issue #596: the runtime refused the ceiling as above its CPU count. The count it was computed from is stale
			// (Docker Desktop's VM given fewer CPUs since the facts were read), and every later job would fail the same
			// way until a restart, so the facts are dropped and the next pickup reads them again. This attempt stays a
			// never-started one (refunded and retried as infrastructure), and the line names both counts.
			const runtimeCpus = !result.aborted && (neverStartedExits ?? []).includes(result.code) && Number.isSafeInteger(hostCpus) ? cpuRangeRefusal(stderrHead) : null;
			if (runtimeCpus !== null) {
				log("cpu_ceiling_stale", { container: name, cpus: (cpuCeilingCenti(hostCpus, cpuBudgetCenti) ?? 0) / 100, hostCpus, runtimeCpus });
				try {
					onCpuCeilingStale();
				} catch {
					// a wiring fault must not rewrite this attempt's answer; the facts age out on their own (`maxAgeMs`)
				}
			}
			// Issue #345: an exit that says "never started" is checked against the cidfile BEFORE the network goes, so a
			// container found running is stopped while its network still exists. Only when the worker did not abort it.
			if (!result.aborted && (neverStartedExits ?? []).includes(result.code) && (await stopDetached({ spawnFn, cidFile, fs, bin, ...detachedCheck }))) {
				return { ...result, detached: true };
			}
			// Issue #683: a copying venue brings its outputs back before the processor reads them. Its own throw stands.
			if (typeof collectRun === "function") return await collectRun(result, { opts: buildOpts });
			return result;
		} finally {
			await teardown();
			if (network) {
				await removeJobNetwork(spawnFn, {
					network,
					proxy: egressProxy,
					bin,
					...(typeof teardownRuntime === "function" ? { readRuntime: async () => teardownRuntime(job) } : {}),
					onRefused: (reason) => log("job_network_not_removed", { network, reason }),
				});
			}
			try {
				fs.rmSync(cidFile, { force: true });
			} catch {
				// best effort: a leftover file is removed before this job's next attempt starts
			}
			// Issue #646: the relay is stopped on every path (a throw before the spawn included), then its directory goes.
			await stopRelay();
			removeInbox();
		}
	};
}

/**
 * The `end` entry's outcome from what `runContainer` knows when the container exits (issue #643): a worker stop and
 * the runner's exit 2 are policy, exit 0 completed, exit 1 failed, and anything else (an OOM kill, a runtime's own
 * code) `unknown`, since only the processor's classification can say more. One exception to `unknown`: an exit this
 * runtime spells "never started" (`neverStartedExits`, 125 to 127 on Docker) is `failed`, the same word the spawn
 * error path uses, because the container never ran: the attempt is over and did nothing, and the processor retries it
 * as infrastructure under the same job id, whose first write then replaces this stream.
 */
export function liveOutcomeOf(code, aborted, neverStartedExits = []) {
	if (aborted) return "policy";
	if (code === 0) return "completed";
	if (code === 2) return "policy";
	if (code === 1) return "failed";
	if (Array.isArray(neverStartedExits) && neverStartedExits.includes(code)) return "failed";
	return "unknown";
}

/** The detached check's whole bound, retries included, so a daemon that stopped answering cannot hold the slot for long. */
export const DETACHED_CHECK_TIMEOUT_MS = 10_000;
/** The least time any single step of it is given, so the last one tried at the deadline is not killed before it is sent. */
export const DETACHED_MIN_STEP_MS = 5_000;

/**
 * Whether THIS attempt created a container that is still there after `docker run` exited "never started" (issue #345), and
 * if so stop and remove it by ID. Measured on rootful Podman 5.8.2: killing the API service mid-job made the docker CLI
 * exit 125 while the container kept running, outside every abort and every refund.
 *
 * The cidfile is the evidence it was THIS attempt's: the docker CLI writes the ID right after a successful create and
 * removes the file when nothing was created, so a plain name conflict (another attempt's live container) leaves no ID and
 * is never touched. On Podman the service also deletes the file when it removes the container (measured), which reads
 * as nothing to check, the same as a container already gone. With an ID, `ps -a --no-trunc --filter id=` answers
 * (`--no-trunc`, because `{{.ID}}` prints 12 characters and the cidfile holds 64):
 *   - nothing at all: nothing runs on, so never started, as before;
 *   - this ID listed `created`: created and never started, so it is removed and still counts as never started;
 *   - this ID in any other state, any other output (a daemon that ignored `--no-trunc`), or `ps` failing or timing out:
 *     this attempt's container may be running, so it is stopped and removed best effort, and the run is DETACHED (it
 *     did start, so its slot is not refunded).
 *
 * A `ps`, `stop` or `rm` that fails is ASKED AGAIN until `timeoutMs` has passed since the check began: measured with
 * Podman's service SIGKILLed, the CLI exits 125 within tens of milliseconds and a single `ps` meets a refused connection,
 * so a restarting service would never be asked to stop the container. Each try is bounded by what is left of the deadline,
 * but never below `minStepMs`, so the step that runs at the deadline (a `stop` that waited out its grace period, then the
 * `rm -f`) still has time to reach the daemon. Worst case: the deadline plus two of those.
 */
export async function stopDetached({ spawnFn, cidFile, fs, timeoutMs = DETACHED_CHECK_TIMEOUT_MS, minStepMs = DETACHED_MIN_STEP_MS, now = () => Date.now(), delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), retryMs = 500, run = dockerStep, bin = "docker" }) {
	let id;
	try {
		id = String(fs.readFileSync(cidFile, "utf8")).trim();
	} catch {
		return false;
	}
	if (!/^[0-9a-f]{64}$/.test(id)) return false;
	const deadline = now() + timeoutMs;
	// One step, asked again while it fails and the check's own deadline has not passed; each try is bounded by what is left.
	const step = async (args) => {
		for (;;) {
			const result = await run(spawnFn, args, Math.max(minStepMs, deadline - now()), bin);
			if (result.code === 0 || now() + retryMs >= deadline) return result;
			await delay(retryMs);
		}
	};
	const listed = await step(["ps", "-a", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}} {{.State}}"]);
	const lines = listed.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	if (listed.code === 0 && lines.length === 0) return false;
	const line = lines.find((l) => l.startsWith(`${id} `));
	if (listed.code === 0 && lines.length === 1 && line && /^created$/i.test(line.slice(id.length + 1).trim())) {
		await step(["rm", "-f", id]);
		return false;
	}
	await step(["stop", id]);
	await step(["rm", "-f", id]);
	return true;
}

/** One bounded CLI step under `bin`: `{ code, stdout }`, `code: null` when it could not run or overran. Never throws. */
function dockerStep(spawnFn, args, timeoutMs, bin = "docker") {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnFn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			resolve({ code: null, stdout: "" });
			return;
		}
		let stdout = "";
		let done = false;
		const finish = (code) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ code, stdout });
		};
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			finish(null);
		}, timeoutMs);
		child.stdout?.on("data", (d) => (stdout += d));
		child.on("error", () => finish(null));
		child.on("close", (code) => finish(code));
	});
}
