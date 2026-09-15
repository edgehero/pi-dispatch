import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { DOCKER_NEVER_STARTED_EXITS } from "./backends.mjs";
import { CONTAINER_HOME } from "./container-spec.mjs";
import { buildDockerRunArgs, CONTAINER_SESSION_FILE } from "./docker-run.mjs";
import { createJobNetwork, networkNameFor, removeJobNetwork } from "./egress.mjs";
import { buildContainerEnv } from "./env-allowlist.mjs";
import { resolveJobImage } from "./image-preflight.mjs";
import { InfraRetry } from "./processor.mjs";

/**
 * The real `runContainer` the processor injects. Launches one job container and returns
 * `{ code, aborted, turns, tokens, session, usage, context }`, where `aborted` records whether the WORKER initiated the stop (docker stop on
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
	openJobLog = () => ({ write() {}, close: async () => ({ turns: null, tokens: null, session: null, usage: null, context: null }) }),
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
}) {
	// async so a synchronous throw (e.g. buildContainerEnv on an unconfigured provider) surfaces as
	// a rejection, uniformly awaitable by the processor and by tests.
	return async function runContainer({ job, token, prepared, secrets = {}, name, signal, user = null, home = null }) {
		if (signal?.aborted) return { code: 137, aborted: true, turns: null, tokens: null, session: null, usage: null, context: null }; // killed before it could start
		// Issue #341. `user` and `home` travel as a PAIR: a uid with no passwd entry in the image gets `HOME=/` from
		// Docker and `HOME=/workspace` from Podman (measured), so a `--user` without this HOME is refused here rather
		// than started. The builder does not insist, because `doctor --live`'s probes run `--user` with no environment.
		if (user !== null && home !== CONTAINER_HOME) {
			throw new Error(`runContainer: a job user (${user}) must be paired with HOME=${CONTAINER_HOME}`);
		}

		// Closed env allowlist: only the provider key + the declared PI_* vars. Throws (config) if
		// the provider is unconfigured, which the processor turns into a policy refusal that refunds the
		// reserve. That sentence was aspirational until issue #310: the processor did not read the
		// `piDispatchConfig` tag at all, so the throw fell through to a bare rethrow with the budget kept.
		// The common case no longer reaches here either, because the processor probes the same resolution
		// among its free gates, ahead of the mint and the clone.
		const env = buildContainerEnv({
			provider: job.provider,
			model: job.model,
			maxTurns: job.maxTurns,
			maxTokens: job.maxTokens, // optional per-job token budget (issue #25); undefined => runner meter only
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
			packagePaths: job.packages === false ? [] : typeof packagePaths === "function" ? packagePaths() : packagePaths,
			forwardEnv, // extra host var names to forward (e.g. a custom provider's key)
			// REQ-RESUMABLE-SESSION: the fixed container path, emitted only when this job HAS a transcript.
			// The constant is imported rather than re-typed so the mount below and this variable name one
			// path -- two literals is how they drift with both suites green.
			sessionFile: prepared.session ? CONTAINER_SESSION_FILE : undefined,
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
			authFromPi, // source the provider key from pi's auth.json when the env has none
			// REQ-TRIGGER-SECRETS: this trigger's resolved secrets, fetched by the processor BEFORE anything
			// spent. Off the call bag rather than off `job` or the closure: it is neither a per-job fact the
			// record may carry nor a deployment setting, it is a live credential, and `token` is its precedent.
			secrets,
			home: user !== null ? home : null, // issue #341: HOME only beside --user, assigned after the forward loops
		});

		// `-net` on this container's own name (egress.mjs). null when no policy is armed, and docker-run's
		// guard then omits the flag entirely, so the argv is byte-identical to one built before this feature.
		const network = egress ? networkNameFor(name) : null;

		// Issue #345: BESIDE the job directory, never inside the `/job:ro` mount, and removed first, because the docker CLI
		// refuses to start with an existing cidfile. A stale one left by a crash would otherwise fail every retry of the job.
		const cidFile = `${prepared.jobDir}.cid`;
		try {
			fs.rmSync(cidFile, { force: true });
		} catch {
			// an unremovable stale file makes the run itself fail to start, which is reported as that
		}

		const args = buildDockerRunArgs({
			// Same split as packagePaths above: the per-job value off `job`, the deployment value off the closure,
			// so a trigger can name its own toolchain (INT-TRIGGERS-FILE-CONTRACT). Resolved through the SAME
			// function the pre-spend preflight uses (image-preflight.mjs), so the tag that was checked is the tag
			// that runs -- one answer by construction, not two call sites that happen to agree.
			image: resolveJobImage(job, image),
			env,
			jobDir: prepared.jobDir,
			workspace: prepared.workspace,
			outboxDir: prepared.outboxDir, // undefined for github jobs -> docker-run's guard skips the /outbox mount
			// The job's OWN copy, under jobDir -- never the shared store. Undefined when the trigger did not
			// arm run.resume or no key resolved, and docker-run's guard then skips the mount entirely.
			sessionDir: prepared.session?.hostDir,
			globalPiDir, // undefined/null -> docker-run's guard skips the /opt/pi-global mount
			name,
			network, // REQ-EGRESS-ALLOWLIST: null when no policy is armed, and the flag is then absent
			user, // issue #341: the worker's own "<uid>:<gid>" on a daemon that enforces bind-mount ownership, else null
			cidFile, // issue #345: where the CLI writes this attempt's container ID, read below when the run exits "never started"
		});

		// REQ-EGRESS-ALLOWLIST. This job's own --internal network, created here rather than at boot because
		// it holds exactly two endpoints -- this container and the proxy -- and that is what makes job-to-job
		// traffic structurally impossible rather than merely discouraged. A shared network could not do it:
		// `enable_icc=false` would block job-to-job AND job-to-proxy, since ICC governs every container pair
		// on the bridge and the proxy is a container.
		//
		// A failure to build it is INFRA, not policy: nothing has been spent, a retry may well succeed, and
		// `container-never-started` is literally true, so the reservation is given back (processor.mjs).
		if (network && !(await createJobNetwork(spawnFn, { network, proxy: egressProxy }))) {
			throw new InfraRetry("container-never-started", { reason: "container-never-started" });
		}

		// Host-side per-job log sink, teed off `onOutput`. `name` is `pi-job-<jobId>`; the sink
		// sanitizes internally. No container mount, no env var -- the sink lives on this side only.
		const sink = openJobLog(name);

		const run = new Promise((resolve, reject) => {
			const child = spawnFn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
			// A throwing sink.write is swallowed so a misbehaving sink cannot break the tee or hang the run.
			const tee = (chunk) => {
				onOutput(chunk);
				try {
					sink.write(chunk);
				} catch {}
			};
			child.stdout?.on("data", tee);
			child.stderr?.on("data", tee);
			// docker not found / daemon down -- a transient infra fault, so tag it retryable
			// (CONST-RETRY-INFRA-ONLY). `reason` also cues the processor to release the budget slot,
			// since a container that never started spent nothing.
			child.on("error", (err) => {
				sink.close().catch(() => {}); // best-effort teardown; a rejecting close cannot leak an unhandled rejection
				reject(new InfraRetry("container-never-started", { cause: err, reason: "container-never-started" }));
			});
			child.on("close", async (code) => {
				const aborted = signal?.aborted === true; // capture BEFORE the await
				// A rejecting sink.close is swallowed so a misbehaving sink cannot hang the run; turns/tokens/session/usage/context fall back to null.
				let turns = null;
				let tokens = null;
				let session = null;
				let usage = null;
				let context = null;
				try {
					// `context = null` is a DEFAULT rather than a plain destructure: an injected sink that
					// predates the field returns no such key, and `undefined` would then reach the record's
					// shape where every other absence is spelled `null`.
					({ turns, tokens, session, usage, context = null } = await sink.close());
				} catch {
					turns = null;
					tokens = null;
					session = null;
					usage = null;
					context = null;
				}
				resolve(aborted ? { code: code ?? 137, aborted: true, turns, tokens, session, usage, context } : { code: code ?? 1, aborted: false, turns, tokens, session, usage, context });
			});
		});

		// The network outlives the container by exactly this `finally`. Best-effort and never throwing: the
		// container has already exited, its code is the job's answer, and a teardown fault must not rewrite
		// that answer. What a failure leaves behind is a memberless network, which the boot reaper sweeps.
		try {
			const result = await run;
			// Issue #345: an exit that says "never started" is checked against the cidfile BEFORE the network goes, so a
			// container found running is stopped while its network still exists. Only when the worker did not abort it.
			if (!result.aborted && (neverStartedExits ?? []).includes(result.code) && (await stopDetached({ spawnFn, cidFile, fs }))) {
				return { ...result, detached: true };
			}
			return result;
		} finally {
			if (network) await removeJobNetwork(spawnFn, { network, proxy: egressProxy });
			try {
				fs.rmSync(cidFile, { force: true });
			} catch {
				// best effort: a leftover file is removed before this job's next attempt starts
			}
		}
	};
}

/** Each docker step of the detached check is bounded, so a daemon that stopped answering cannot hold the slot. */
export const DETACHED_CHECK_TIMEOUT_MS = 10_000;

/**
 * Whether THIS attempt created a container that is still there after `docker run` exited "never started" (issue #345), and
 * if so stop and remove it by ID. Measured on rootful Podman 5.8.2: killing the API service mid-job made the docker CLI
 * exit 125 while the container kept running, outside every abort and every refund.
 *
 * The cidfile is the evidence it was THIS attempt's: the docker CLI writes the ID right after a successful create and
 * removes the file when nothing was created, so a plain name conflict (another attempt's live container) leaves no ID and
 * is never touched. With an ID, `ps -a --no-trunc --filter id=` answers (`--no-trunc`, because `{{.ID}}` prints 12
 * characters and the cidfile holds 64):
 *   - nothing at all: nothing runs on, so never started, as before;
 *   - this ID listed `created`: created and never started, so it is removed and still counts as never started;
 *   - this ID in any other state, any other output (a daemon that ignored `--no-trunc`), or `ps` failing or timing out:
 *     this attempt's container may be running, so it is stopped and removed best effort, and the run is DETACHED (it
 *     did start, so its slot is not refunded).
 */
export async function stopDetached({ spawnFn, cidFile, fs, timeoutMs = DETACHED_CHECK_TIMEOUT_MS }) {
	let id;
	try {
		id = String(fs.readFileSync(cidFile, "utf8")).trim();
	} catch {
		return false;
	}
	if (!/^[0-9a-f]{64}$/.test(id)) return false;
	const listed = await dockerStep(spawnFn, ["ps", "-a", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}} {{.State}}"], timeoutMs);
	const lines = listed.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	if (listed.code === 0 && lines.length === 0) return false;
	const line = lines.find((l) => l.startsWith(`${id} `));
	if (listed.code === 0 && lines.length === 1 && line && /^created$/i.test(line.slice(id.length + 1).trim())) {
		await dockerStep(spawnFn, ["rm", "-f", id], timeoutMs);
		return false;
	}
	await dockerStep(spawnFn, ["stop", id], timeoutMs);
	await dockerStep(spawnFn, ["rm", "-f", id], timeoutMs);
	return true;
}

/** One bounded docker step: `{ code, stdout }`, `code: null` when it could not run or overran. Never throws. */
function dockerStep(spawnFn, args, timeoutMs) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnFn("docker", args, { stdio: ["ignore", "pipe", "ignore"] });
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
