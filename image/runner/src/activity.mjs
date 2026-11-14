import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";
import { readCgroupCpuUsec } from "./cgroup-usage.mjs";
import { configError } from "./outcome.mjs";

/**
 * The activity watch (issue #888, `REQ-JOB-ACTIVITY-LIMITS`, `DES-JOB-ACTIVITY-WATCH`): a job is stopped when it is IDLE
 * or STALLED, never because it is old.
 *
 * TWO KINDS OF PROGRESS, because "the agent is doing something" and "the container is doing something" are different
 * questions and each limit needs a different one.
 *   - A STEP is the agent itself moving: any event on the root session's bus other than a tool's output update (a turn
 *     starting or ending, the model streaming, a tool call starting or ending, pi's own retry and compaction), and a
 *     change in what the process-wide meter has counted (`meterSignature`), which is how an in-process subagent session
 *     and a child pi process (folded in by child-watch.mjs) show up: neither reaches the root bus.
 *   - ACTIVITY is anything the agent may be WAITING ON: a running tool's output (`tool_execution_update`; pi's bash tool
 *     streams output as it comes), CPU used in the container by any process other than this runner, and bytes moved on
 *     the container's network interfaces. A test suite that prints nothing, a build the agent started in the background
 *     and then waits on with a silent `sleep`, `gh run watch` polling a remote CI: each is activity.
 *
 * TWO LIMITS:
 *   - IDLE (`PI_JOB_IDLE_MS`): neither a step nor activity for that long. Nothing is happening and nothing is being
 *     waited on, so the slot is held for nothing: a hung tool (a prompt waiting on stdin, a deadlock, a silent sleep
 *     with nothing behind it), a provider that never answers.
 *   - STALLED (`PI_JOB_STALL_MS`): no STEP for that long, however busy the container is. Activity alone cannot end a
 *     job, so a test stuck in an endless loop would hold its slot for ever; the stall limit is the bound on that, set
 *     long (the worker's default is four hours) so that a run that keeps working for eight hours is never cut off.
 * Spend is bounded elsewhere, as before (the turn budget, the token and cost caps), and a wall-clock ceiling, when an
 * operator sets one, is the worker's own timer.
 *
 * REJECTED: events only. The agent waiting on a background build with a silent `sleep 1200` makes no event for twenty
 * minutes while the build it waits on runs at full CPU; killing it is exactly the "stopped while working" #888 is about.
 * REJECTED: CPU only. A tool hung on a remote that answers slowly uses none, and the runner's own event loop is CPU too,
 * which is why the runner's own use (`process.cpuUsage`) is subtracted from the cgroup's total rather than counted.
 * REJECTED: judging from outside, by the worker alone. It cannot see pi's events, and on Docker Desktop the container's
 * cgroup lives in a VM the worker does not read. The worker is the BACKSTOP instead (counters, below).
 *
 * THE COUNTERS, for the worker (`INT-JOB-ACTIVITY-FILE`): `{ v: 1, steps, active }`, two integers that only grow.
 * `steps` grows on every sample that saw a step, `active` on every sample that saw a step or activity. No time is
 * written: the worker stamps each change with its OWN clock, so no container clock is ever trusted. They are written
 * to `activity.json` beside the session file (a writable bind on every binding venue) and, on a copying venue, sent as
 * a signed stderr record (transcript-mirror.mjs). The agent shares this process's uid and can write the file too: a
 * forged counter can only keep the WORKER's backstop from firing, and only for a runner that has also stopped judging
 * for itself, which is the residual `INT-JOB-ACTIVITY-FILE` names. The runner's own judgement, here, reads nothing the
 * agent can write.
 *
 * WHAT SUSPENDS THE CLOCKS. pi's auto-retry back-off (`auto_retry_start` carries `delayMs`): the job is waiting on a
 * provider by pi's own bounded rule, not idling. And a FREEZE: a sample that arrives more than FREEZE_GAP_TICKS late
 * (a checkpoint pauses the container, issue #645; an event loop held by synchronous work) shifts both clocks by the gap,
 * because a frozen process did nothing it could be blamed for; a runner frozen for good stops writing its counters and
 * meets the worker's backstop instead.
 */

/** The two env-internal limits, in milliseconds, written only by the worker into the job's closed env map. */
export const ACTIVITY_IDLE_ENV = "PI_JOB_IDLE_MS";
export const ACTIVITY_STALL_ENV = "PI_JOB_STALL_MS";
/** The longest limit read: 31 days. A worker never asks for more; anything past it is a broken value, refused. */
const ACTIVITY_LIMIT_MAX_MS = 31 * 24 * 60 * 60 * 1000;
/** The shortest: one second. The worker's settings are whole minutes; tests use seconds. */
const ACTIVITY_LIMIT_MIN_MS = 1000;
/** How often the watch samples, at most. Shorter for a short limit (a quarter of it), never below 250 ms. */
export const ACTIVITY_SAMPLE_MS = 15_000;
const ACTIVITY_SAMPLE_MIN_MS = 250;
/** A sample this many intervals late is a freeze, not idleness. */
export const FREEZE_GAP_TICKS = 3;
/** Other processes' CPU that counts as activity: 5% of one core over the sample. An idle file watcher or MCP server stays under it. */
export const ACTIVITY_CPU_FLOOR = 0.05;
/** Network bytes that count as activity in one sample: 4 KiB. An idle keep-alive connection moves none. */
export const ACTIVITY_NET_FLOOR_BYTES = 4096;
/**
 * How long a stopped job's abort may take to settle before the runner writes its exit line and exits anyway: a minute,
 * or the shortest limit when that is shorter (never below 5 s), so a job with a short limit is not held past it.
 */
export const ACTIVITY_STOP_SETTLE_MS = 60_000;
export function activitySettleMs({ idleMs = null, stallMs = null } = {}) {
	const shortest = Math.min(idleMs ?? Infinity, stallMs ?? Infinity);
	return Math.min(ACTIVITY_STOP_SETTLE_MS, Math.max(5000, shortest));
}
/** The two reasons a stop gives, on the exit line and the record (`INT-RUNNER-EXIT-CODE-PROTOCOL`). */
export const ACTIVITY_IDLE = "idle";
export const ACTIVITY_STALLED = "stalled";
/** The counters file, beside the session file. */
export const ACTIVITY_FILE = "activity.json";
/** The counters' format version. */
export const ACTIVITY_FILE_VERSION = 1;

function limitOf(raw, name) {
	if (raw === undefined || raw === "") return null;
	if (typeof raw !== "string" || !/^\d{1,11}$/.test(raw)) throw configError(`invalid ${name}`);
	const ms = Number(raw);
	if (ms < ACTIVITY_LIMIT_MIN_MS || ms > ACTIVITY_LIMIT_MAX_MS) throw configError(`invalid ${name}`);
	return ms;
}

/**
 * The limits the worker asked for: `{ idleMs, stallMs }`, each a whole number of milliseconds or null (not asked).
 * Both null is a worker that predates issue #888 or a run without the watch, and the watch is then not started at all,
 * so such a run is byte-identical to before. A value that is not a decimal integer in range is refused as a config
 * error (exit 2, before anything spends): the worker never writes one, so it is a fault to say, never to guess around.
 * Each name leaves the environment once read, so no tool or child sees it.
 */
export function readActivityLimits(env = process.env) {
	// env-internal PI_JOB_IDLE_MS, PI_JOB_STALL_MS: written by the worker into the job's closed env map, removed here once read.
	const idleMs = limitOf(env.PI_JOB_IDLE_MS, ACTIVITY_IDLE_ENV);
	const stallMs = limitOf(env.PI_JOB_STALL_MS, ACTIVITY_STALL_ENV);
	delete env.PI_JOB_IDLE_MS;
	delete env.PI_JOB_STALL_MS;
	return { idleMs, stallMs };
}

/** Bytes moved on every interface but loopback, from `/proc/net/dev`, or null when it cannot be read. Never throws. */
export function readNetBytes({ fs = nodeFs } = {}) {
	try {
		const text = String(fs.readFileSync("/proc/net/dev", "utf8"));
		let total = 0;
		let seen = false;
		for (const line of text.split("\n")) {
			const colon = line.indexOf(":");
			if (colon < 0) continue;
			const name = line.slice(0, colon).trim();
			if (name === "" || name === "lo") continue;
			const fields = line.slice(colon + 1).trim().split(/\s+/);
			// Receive bytes is the first field, transmit bytes the ninth.
			const rx = Number(fields[0]);
			const tx = Number(fields[8]);
			if (!Number.isSafeInteger(rx) || !Number.isSafeInteger(tx)) continue;
			total += rx + tx;
			seen = true;
		}
		return seen && Number.isSafeInteger(total) ? total : null;
	} catch {
		return null;
	}
}

/** This process's own CPU time in microseconds. */
function runnerCpuUsec() {
	const { user, system } = process.cpuUsage();
	return user + system;
}

/**
 * Write the counters to `activity.json` beside the session file, atomically (a temp file renamed over it), never
 * following a link the agent may have planted and never blocking on a FIFO. Returns a writer, or a no-op when there is
 * no session file. Never throws.
 */
export function activityFileWriter(sessionFile, { fs = nodeFs } = {}) {
	if (typeof sessionFile !== "string" || sessionFile === "") return () => {};
	const dir = dirname(sessionFile);
	const target = join(dir, ACTIVITY_FILE);
	const temp = join(dir, `.${ACTIVITY_FILE}.tmp`);
	const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
	return ({ steps, active }) => {
		let fd = null;
		try {
			fd = fs.openSync(temp, flags, 0o644);
			fs.writeSync(fd, `${JSON.stringify({ v: ACTIVITY_FILE_VERSION, steps, active })}\n`);
			fs.closeSync(fd);
			fd = null;
			fs.renameSync(temp, target);
		} catch {
			// A counter that could not be written is one the worker does not see: its backstop then fires a little early
			// (at the idle limit plus its grace from the last counter it read), which is the safe direction to fail.
		} finally {
			if (fd !== null) {
				try {
					fs.closeSync(fd);
				} catch {}
			}
		}
	};
}

/**
 * `createActivityWatch({ limits, onStop, ... })` -> `{ observe(event), start(), stop(), state, fields() }`.
 *
 *   - `observe(event)` is the session bus listener. After a stop it aborts again on every `turn_start`, as the turn
 *     budget does: pi starts a new run with a fresh AbortController, and one abort does not reach it.
 *   - `start()` takes the first sample (the baseline) and samples every `sampleMs` on an unref'd timer.
 *   - `fields()` is the exit line's `activity`: whole seconds since the last step and the last activity, and whether
 *     each probe could read (`cpu`, `net`); a probe that cannot read never counts as activity.
 *
 * Every seam is injected (`now`, `timers`, the readers, `meterSignature`, `writeCounters`) so a test drives it with a
 * fake clock and fake readers. Nothing here throws once built: a reader that throws reads as unreadable.
 */
export function createActivityWatch({
	limits,
	onStop,
	log = () => {},
	// Monotonic: only differences are read, and a wall clock stepped by NTP must not read as an hour of idleness.
	now = () => performance.now(),
	timers = { setInterval, clearInterval },
	sampleMs = null,
	readCpuUsec = () => readCgroupCpuUsec(),
	readOwnCpuUsec = runnerCpuUsec,
	readNet = () => readNetBytes(),
	meterSignature = () => null,
	writeCounters = () => {},
}) {
	const idleMs = limits?.idleMs ?? null;
	const stallMs = limits?.stallMs ?? null;
	const shortest = Math.min(idleMs ?? Infinity, stallMs ?? Infinity);
	const interval = sampleMs ?? Math.max(ACTIVITY_SAMPLE_MIN_MS, Math.min(ACTIVITY_SAMPLE_MS, Math.floor(shortest / 4)));
	const safe = (read) => {
		try {
			const value = read();
			return Number.isSafeInteger(value) && value >= 0 ? value : null;
		} catch {
			return null;
		}
	};
	const started = now();
	const state = {
		lastStepAt: started,
		lastActivityAt: started,
		suspendedUntil: 0,
		steps: 0,
		active: 0,
		stopped: null,
		cpu: null,
		net: null,
	};
	let stepSeen = false;
	let activitySeen = false;
	let lastTickAt = null;
	let prevCpu = null;
	let prevOwn = null;
	let prevNet = null;
	let prevSignature;
	let timer = null;

	const markStep = (at) => {
		state.lastStepAt = at;
		state.lastActivityAt = at;
		stepSeen = true;
		activitySeen = true;
	};
	const markActivity = (at) => {
		state.lastActivityAt = at;
		activitySeen = true;
	};

	function stopFor(reason) {
		if (state.stopped !== null) return;
		state.stopped = reason;
		const at = now();
		log("activity_stop", { reason, sinceStepS: Math.floor((at - state.lastStepAt) / 1000), sinceActivityS: Math.floor((at - state.lastActivityAt) / 1000) });
		try {
			onStop?.(reason);
		} catch {
			// the stop is recorded whatever the callback did
		}
	}

	function observe(event) {
		const type = event?.type;
		if (typeof type !== "string") return;
		if (state.stopped !== null) {
			if (type === "turn_start") {
				try {
					onStop?.(state.stopped);
				} catch {}
			}
			return;
		}
		const at = now();
		if (type === "tool_execution_update") {
			markActivity(at);
			return;
		}
		markStep(at);
		if (type === "auto_retry_start" && Number.isSafeInteger(event.delayMs) && event.delayMs > 0) {
			state.suspendedUntil = Math.max(state.suspendedUntil, at + event.delayMs);
		}
	}

	function sample() {
		const at = now();
		// A FREEZE: the sample came far later than its interval. The time the process could not run is not idleness.
		if (lastTickAt !== null) {
			const late = at - lastTickAt - interval;
			if (late > interval * (FREEZE_GAP_TICKS - 1)) {
				state.lastStepAt += late;
				state.lastActivityAt += late;
			}
		}
		const elapsed = lastTickAt === null ? 0 : at - lastTickAt;
		lastTickAt = at;

		const cpu = safe(readCpuUsec);
		const own = safe(readOwnCpuUsec);
		state.cpu = cpu !== null && own !== null;
		if (state.cpu && prevCpu !== null && prevOwn !== null && elapsed > 0) {
			const others = cpu - prevCpu - (own - prevOwn);
			if (others >= ACTIVITY_CPU_FLOOR * elapsed * 1000) markActivity(at);
		}
		prevCpu = cpu;
		prevOwn = own;

		const net = safe(readNet);
		state.net = net !== null;
		if (net !== null && prevNet !== null && net - prevNet >= ACTIVITY_NET_FLOOR_BYTES) markActivity(at);
		prevNet = net;

		let signature = null;
		try {
			signature = meterSignature();
		} catch {
			signature = null;
		}
		if (prevSignature !== undefined && signature !== null && signature !== prevSignature) markStep(at);
		prevSignature = signature;

		if (stepSeen) state.steps += 1;
		if (activitySeen) state.active += 1;
		if (stepSeen || activitySeen) {
			try {
				writeCounters({ steps: state.steps, active: state.active });
			} catch {}
		}
		stepSeen = false;
		activitySeen = false;

		if (state.stopped !== null) return;
		const stepAt = Math.max(state.lastStepAt, state.suspendedUntil);
		const activityAt = Math.max(state.lastActivityAt, state.suspendedUntil);
		if (stallMs !== null && at - stepAt >= stallMs) stopFor(ACTIVITY_STALLED);
		else if (idleMs !== null && at - activityAt >= idleMs) stopFor(ACTIVITY_IDLE);
	}

	return {
		state,
		interval,
		observe,
		sample,
		start() {
			if (timer !== null) return;
			// The baseline: the first counter write tells the worker the watch is running, and the first readings are the
			// ones every later sample is measured against.
			stepSeen = true;
			activitySeen = true;
			sample();
			timer = timers.setInterval(sample, interval);
			timer?.unref?.();
		},
		stop() {
			if (timer !== null) timers.clearInterval(timer);
			timer = null;
		},
		fields() {
			const at = now();
			return {
				sinceStepS: Math.max(0, Math.floor((at - state.lastStepAt) / 1000)),
				sinceActivityS: Math.max(0, Math.floor((at - state.lastActivityAt) / 1000)),
				cpu: state.cpu === true,
				net: state.net === true,
			};
		},
	};
}
