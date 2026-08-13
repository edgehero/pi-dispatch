import { spawn } from "node:child_process";
import { buildDockerRunArgs, CONTAINER_SESSION_FILE } from "./docker-run.mjs";
import { buildContainerEnv } from "./env-allowlist.mjs";
import { resolveJobImage } from "./image-preflight.mjs";
import { InfraRetry } from "./processor.mjs";

/**
 * The real `runContainer` the processor injects. Launches one job container and returns
 * `{ code, aborted, turns, tokens, session, usage }`, where `aborted` records whether the WORKER initiated the stop (docker stop on
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
	openJobLog = () => ({ write() {}, close: async () => ({ turns: null, tokens: null, session: null, usage: null }) }),
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
}) {
	// async so a synchronous throw (e.g. buildContainerEnv on an unconfigured provider) surfaces as
	// a rejection, uniformly awaitable by the processor and by tests.
	return async function runContainer({ job, token, prepared, name, signal }) {
		if (signal?.aborted) return { code: 137, aborted: true, turns: null, tokens: null, session: null, usage: null }; // killed before it could start

		// Closed env allowlist: only the provider key + the declared PI_* vars. Throws (config) if
		// the provider is unconfigured -- the processor turns that into a pre-spend refusal.
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
			authFromPi, // source the provider key from pi's auth.json when the env has none
		});

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
		});

		// Host-side per-job log sink, teed off `onOutput`. `name` is `pi-job-<jobId>`; the sink
		// sanitizes internally. No container mount, no env var -- the sink lives on this side only.
		const sink = openJobLog(name);

		return await new Promise((resolve, reject) => {
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
				// A rejecting sink.close is swallowed so a misbehaving sink cannot hang the run; turns/tokens/session/usage fall back to null.
				let turns = null;
				let tokens = null;
				let session = null;
				let usage = null;
				try {
					({ turns, tokens, session, usage } = await sink.close());
				} catch {
					turns = null;
					tokens = null;
					session = null;
					usage = null;
				}
				resolve(aborted ? { code: code ?? 137, aborted: true, turns, tokens, session, usage } : { code: code ?? 1, aborted: false, turns, tokens, session, usage });
			});
		});
	};
}
