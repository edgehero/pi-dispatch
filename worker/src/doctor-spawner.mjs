/**
 * The worker's own doctor runs (issue #712, `DES-DOCTOR-RESULTS-PUBLISHED`).
 *
 * `pi-dispatch doctor` publishes what it found to Valkey (`doctor-results.mjs`), so the console and the `/dispatch`
 * panel can say WHY a host is unhealthy instead of "run pi-dispatch doctor for the reason". An operator runs doctor by
 * hand when something is already wrong, and a host nobody looked at would then publish nothing at all, so the worker
 * runs it too: once shortly after boot and then every `PI_DOCTOR_INTERVAL_HOURS` (24 by default, 0 = never).
 *
 * A CHILD PROCESS, the same CLI entry an operator types (`process.execPath <cli.mjs> doctor --publish`), and never the
 * doctor module called in-process. REJECTED: importing `runDoctor` here. Doctor is ten thousand lines of synchronous
 * file reads, `docker`/`podman` spawns and its own Valkey clients; inside the worker its stalls would land on the event
 * loop that renews BullMQ's job locks (`index.mjs` sets `maxStalledCount: 0`, so a loop blocked past the lock fails a
 * paid job), and a doctor fault would be the worker's fault. A child has its own loop, its own crash, and a kill.
 * It also judges exactly what an operator's run judges: one code path, one set of labels, one record shape.
 *
 * WHAT THE CHILD IS NOT GIVEN: `--live` (it starts real containers to read declarations back), `--secrets` (it runs
 * every bundle resolver against the operator's secret manager) and `--fix` (it changes the host). A plain doctor run
 * reads, and where the egress policy is armed it starts the egress canary's short-lived probe, which every plain
 * `pi-dispatch doctor` already does; nothing the worker runs here costs a provider call.
 *
 * The interval idiom is `retention-sweep.mjs`'s, down to the injected timer seams and the posture of `close()`:
 * unref'd so it never holds the process open, closed through `extraClosers` so a clean shutdown clears it. Two
 * divergences, marked at their sites: the first run is DELAYED rather than immediate, and a run in flight is KILLED on
 * close rather than drained.
 */
import { spawn as nodeSpawn } from "node:child_process";

/** The default cadence, as `SWEEP_INTERVAL_HOURS` is the sweep's. */
export const DOCTOR_INTERVAL_HOURS = 24;

/** The ceiling, for `SWEEP_INTERVAL_MAX_HOURS`'s reason: `setInterval` clamps a delay past 2^31-1 ms to 1 ms. */
export const DOCTOR_INTERVAL_MAX_HOURS = 168;

/**
 * How long one doctor run may take before the child is killed. A plain run on a healthy host takes seconds; its
 * slowest steps are bounded by doctor itself (30 s per runtime command, 5 s per Valkey connect, the egress canary's own
 * step bounds), so two minutes is a run that is wedged, not a run that is slow.
 */
export const DOCTOR_RUN_TIMEOUT_MS = 120_000;

/**
 * How long after boot the first run starts. DIVERGENCE from `host-registry.start`, which beats at once, and from the
 * sweep, which waits a whole interval. Not at once, because a worker that crash-loops under its service manager would
 * otherwise start one doctor per restart, each spawning runtime commands beside a boot that is already failing; a
 * minute is past every restart delay the shipped units use. Not a whole interval, because the first published result
 * is the one an operator opening the console after an install is looking for.
 */
export const DOCTOR_BOOT_DELAY_MS = 60_000;

/**
 * The one line doctor writes to stderr when it could not publish (`doctor.mjs`, `publishNote`). The spawner reads the
 * child's stderr for this prefix alone, so its log line can say whether the run reached Valkey without carrying any of
 * doctor's text: the rest of stderr is discarded unread.
 */
export const DOCTOR_PUBLISH_SKIPPED_PREFIX = "doctor: results not published";

/** How much of the child's stderr is kept to look for that prefix. Doctor writes nothing else there on a plain run. */
const STDERR_KEEP_BYTES = 4096;

/** How long `close()` waits for a killed child to be reaped, not unref'd for the registry's reason. */
const CLOSE_REAP_TIMEOUT_MS = 5_000;

/**
 * Build the spawner. `cliPath` is the worker's own `cli.mjs`; `env` and `cwd` are the worker's, so the child reads the
 * deployment the service reads (doctor resolves `.env` in its working directory).
 */
export function makeDoctorSpawner({
	cliPath,
	execPath = process.execPath,
	cwd = process.cwd(),
	env = process.env,
	intervalMs,
	bootDelayMs = DOCTOR_BOOT_DELAY_MS,
	timeoutMs = DOCTOR_RUN_TIMEOUT_MS,
	log = () => {},
	spawnFn = nodeSpawn,
	setIntervalFn = setInterval,
	clearIntervalFn = clearInterval,
	setTimeoutFn = setTimeout,
	clearTimeoutFn = clearTimeout,
	now = Date.now,
	platform = process.platform,
	// Signals a whole process group (`process.kill(-pid, sig)`), a seam so a test sees the group kill without a process.
	killGroup = (pid, sig) => process.kill(-pid, sig),
}) {
	// The interval in whole hours, handed to the child so its record carries the cadence it really runs at.
	const everyHours = Math.round(intervalMs / 3_600_000);
	// POSIX: the child leads its own process group, so a kill reaches what doctor itself started (a `docker` call, the
	// egress canary's probe) and not doctor alone (review round 1). Windows has no groups to signal: the plain kill.
	const grouped = platform !== "win32";
	const kill = (child) => {
		try {
			if (grouped && Number.isSafeInteger(child.pid) && child.pid > 0) killGroup(child.pid, "SIGKILL");
			else child.kill?.("SIGKILL");
		} catch {
			try {
				child.kill?.("SIGKILL");
			} catch {
				// a child that is already gone needs no kill
			}
		}
	};
	let timer = null;
	let bootTimer = null;
	let closed = false;
	// The run in flight, `{ child, done }`, or null.
	let running = null;

	function runOnce() {
		if (closed) return Promise.resolve();
		// No overlap, for the sweep's reason: a short interval against a slow host must not stack doctors that each spawn
		// the same runtime commands and race to publish. Said once per skipped tick, never queued.
		if (running) {
			log("doctor_overlapped", {});
			return Promise.resolve();
		}
		const startedAt = now();
		let child;
		try {
			child = spawnFn(execPath, [cliPath, "doctor", "--publish", `--by-worker=${everyHours}`], { cwd, env, stdio: ["ignore", "ignore", "pipe"], ...(grouped ? { detached: true } : {}) });
		} catch (err) {
			log("doctor_spawn_failed", { reason: err?.code ?? "spawn threw" });
			return Promise.resolve();
		}
		let stderr = "";
		let timedOut = false;
		let settled = false;
		// The TAIL is kept (review round 1): doctor writes its "not published" line last, after anything else a run may
		// put on stderr, so a kept head could miss it.
		child.stderr?.on?.("data", (chunk) => {
			stderr = (stderr + String(chunk)).slice(-STDERR_KEEP_BYTES);
		});
		// The kill timer is NOT unref'd: an unref'd timer does not fire when the hung child is the only thing left, which is
		// the case it exists for. It is cleared the moment the child settles.
		const killTimer = setTimeoutFn(() => {
			timedOut = true;
			kill(child);
		}, timeoutMs);
		const done = new Promise((resolve) => {
			const settle = (fields) => {
				if (settled) return;
				settled = true;
				clearTimeoutFn(killTimer);
				running = null;
				// Gated on `closed`, `host-registry`'s posture: a run that ends after the worker said it stopped must not speak
				// through the boot's log closure.
				if (!closed) log(fields.event, fields.data);
				resolve();
			};
			child.on?.("error", (err) => settle({ event: "doctor_spawn_failed", data: { reason: err?.code ?? "spawn failed" } }));
			child.on?.("close", (code, signal) => {
				const ms = now() - startedAt;
				if (timedOut) return settle({ event: "doctor_spawn_failed", data: { reason: "timeout", ms } });
				// `code` is doctor's own verdict (0 ready, 1 a check failed) and is reported as it is; whether the run reached
				// Valkey is the one stderr line doctor writes when it did not. No label, no path: names and integers only.
				settle({ event: "doctor_published", data: { code: code ?? null, signal: signal ?? null, ms, published: !stderr.includes(DOCTOR_PUBLISH_SKIPPED_PREFIX) } });
			});
		});
		running = { child, done };
		// The child must not hold the worker's event loop open either: a shutdown that reaches `process.exit` kills it.
		child.unref?.();
		return done;
	}

	return {
		runOnce,

		start() {
			if (closed || timer || bootTimer) return; // a second start would leak the first timers
			// A non-positive interval arms NOTHING, the sweep's guard; the caller already gates on the knob being > 0.
			if (!(intervalMs > 0)) return;
			bootTimer = setTimeoutFn(() => {
				bootTimer = null;
				void runOnce();
			}, bootDelayMs);
			bootTimer?.unref?.();
			timer = setIntervalFn(() => void runOnce(), intervalMs);
			timer?.unref?.();
		},

		/**
		 * `closed` first, so a tick already past its check cannot spawn after the closer reported done. DIVERGENCE from the
		 * sweep, which drains: a doctor run in flight is KILLED, because nothing it would still do matters to a worker that
		 * is stopping (its publish is best effort by contract, and a later run republishes), while waiting for it could hold
		 * a shutdown for its whole two-minute bound. The reap is bounded, so a child that ignores SIGKILL cannot hang exit.
		 */
		async close() {
			closed = true;
			if (timer) clearIntervalFn(timer);
			if (bootTimer) clearTimeoutFn(bootTimer);
			timer = null;
			bootTimer = null;
			const inFlight = running;
			if (!inFlight) return;
			kill(inFlight.child);
			await new Promise((resolve) => {
				const t = setTimeout(resolve, CLOSE_REAP_TIMEOUT_MS);
				inFlight.done.then(() => {
					clearTimeout(t);
					resolve();
				});
			});
		},
	};
}
