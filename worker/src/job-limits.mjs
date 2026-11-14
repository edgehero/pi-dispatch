import * as nodeFs from "node:fs";
import { join } from "node:path";

/**
 * A running job's limits (issue #888, `REQ-JOB-ACTIVITY-LIMITS`, `DES-JOB-ACTIVITY-WATCH`): when the worker stops a job.
 *
 * The runner judges idle and stalled itself (image/runner/src/activity.mjs) and stops the job with a policy exit; this
 * module is the worker's half:
 *   - which limits a job runs under (`effectiveJobLimits`: the trigger's, else the deployment's);
 *   - the BACKSTOP for a runner too wedged to stop its own job (`makeActivityBackstop`): it reads the counters the runner
 *     writes (`INT-JOB-ACTIVITY-FILE`), stamps each change with this worker's clock, and asks for a stop a grace period
 *     after the runner should have stopped itself;
 *   - the wall-clock FALLBACK for a job no watch covers, which is exactly today's 30 minutes.
 *
 * WHY A FALLBACK AT ALL. A job whose image predates the watch (no `idleWatch` in its capabilities label, a derived image
 * built from an older base), whose venue has no channel for the counters, or which holds a credential that expires while
 * it runs (a GitHub App token, a subscription snapshot: until their refresh lands) must not run unbounded: it keeps the
 * 30-minute wall clock, and its record says so (`limits.basis: "wall-clock"`, `limits.why`). Fail open and say which.
 */

export {
	ACTIVITY_FILE,
	ACTIVITY_POLL_MS,
	BACKSTOP_GRACE_MS,
	effectiveJobLimits,
	JOB_IDLE_MINUTES_DEFAULT,
	JOB_IDLE_MINUTES_MAX,
	JOB_LIMIT_FIELDS,
	JOB_MINUTES_MAX,
	JOB_STALL_MINUTES_DEFAULT,
	malformedJobLimits,
	validateJobLimits,
	WALL_CLOCK_FALLBACK_MINUTES,
	WALL_CLOCK_FALLBACK_MS,
	WATCH_DECISION_RECHECK_MS,
	WATCH_MAX_MINUTES,
} from "./job-limit-rules.mjs";
import { ACTIVITY_FILE, BACKSTOP_GRACE_MS } from "./job-limit-rules.mjs";
const ACTIVITY_FILE_MAX_BYTES = 256;

/** `{ steps, active }` from the counters' bytes, or null for anything that is not exactly their shape. */
export function parseActivityCounters(text) {
	if (typeof text !== "string" || text.length > ACTIVITY_FILE_MAX_BYTES) return null;
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value) || value.v !== 1) return null;
	if (!Number.isSafeInteger(value.steps) || value.steps < 0 || !Number.isSafeInteger(value.active) || value.active < 0) return null;
	return { steps: value.steps, active: value.active };
}

/**
 * Read `activity.json` in `dir` (the job's own transcript directory on the host), or null. The directory is the job's to
 * write, so the file is read as the live tail reads the transcript: `lstat` first, a regular file only, opened
 * `O_NOFOLLOW | O_NONBLOCK`, at most a few hundred bytes. Never throws.
 */
export function readActivityFile(dir, { fs = nodeFs } = {}) {
	if (typeof dir !== "string" || dir === "") return null;
	const path = join(dir, ACTIVITY_FILE);
	let fd = null;
	try {
		const info = fs.lstatSync(path);
		if (!info.isFile() || info.size > ACTIVITY_FILE_MAX_BYTES) return null;
		fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
		const buf = Buffer.alloc(ACTIVITY_FILE_MAX_BYTES + 1);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		return parseActivityCounters(buf.subarray(0, n).toString("utf8"));
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {}
		}
	}
}

/**
 * The worker's backstop: `makeActivityBackstop({ idleMs, stallMs, graceMs, now, onStop })` ->
 * `{ observe(counters), check(), state }`.
 *
 *   - `observe({ steps, active })` takes the counters as read; a change of either is stamped with THIS clock (`now`).
 *     A counter that went DOWN (the file replaced, a forgery) is taken as the new reading and stamped, never trusted to
 *     mean anything else: the runner's own judgement does not read it.
 *   - `check()` asks for a stop, once: `idle` when `active` has not changed for idleMs + graceMs, `stalled` when `steps`
 *     has not changed for stallMs + graceMs (stallMs null or 0: never). Both clocks start at the backstop's creation,
 *     which is the container's start: a runner that never writes is a runner that never judged.
 *   - `state`: `{ lastStepAt, lastActivityAt, stopped, readings }`, the record's two times (this worker's clock).
 */
export function makeActivityBackstop({ idleMs, stallMs = null, graceMs = BACKSTOP_GRACE_MS, now = () => Date.now(), onStop = () => {} }) {
	const started = now();
	const state = { lastStepAt: started, lastActivityAt: started, stopped: null, readings: 0 };
	let last = null;
	return {
		state,
		observe(counters) {
			if (counters === null || typeof counters !== "object") return;
			const at = now();
			state.readings += 1;
			if (last === null || counters.steps !== last.steps) state.lastStepAt = at;
			if (last === null || counters.active !== last.active || counters.steps !== last.steps) state.lastActivityAt = at;
			last = { steps: counters.steps, active: counters.active };
		},
		check() {
			if (state.stopped !== null) return state.stopped;
			const at = now();
			let reason = null;
			if (Number.isSafeInteger(stallMs) && stallMs > 0 && at - state.lastStepAt >= stallMs + graceMs) reason = "stalled";
			else if (Number.isSafeInteger(idleMs) && idleMs > 0 && at - state.lastActivityAt >= idleMs + graceMs) reason = "idle";
			if (reason === null) return null;
			state.stopped = reason;
			try {
				onStop(reason);
			} catch {}
			return reason;
		},
	};
}
