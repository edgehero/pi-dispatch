/**
 * The pure half of a job's limits (issue #888, `REQ-JOB-ACTIVITY-LIMITS`): the defaults, the ranges, the trigger fields'
 * validation and the effective limits. A LEAF with no imports at all, on purpose: `triggers.mjs` validates the three
 * `run` fields with it, and that file is pure and fs-free because the receiver loads it and `admin/build.mjs` inlines it
 * into the published console (reserved-env.mjs says the same of its own list). The worker's half, which reads files and
 * keeps timers, is job-limits.mjs.
 */

/** The deployment defaults and the ranges a value may take, in whole minutes. */
export const JOB_IDLE_MINUTES_DEFAULT = 15;
export const JOB_STALL_MINUTES_DEFAULT = 240;
export const JOB_IDLE_MINUTES_MAX = 1440;
/** 30 days in minutes: a stall or a ceiling longer than that is a typo, not a plan. Under the runner's own 31-day bound. */
export const JOB_MINUTES_MAX = 30 * 24 * 60;

/** The wall clock a job keeps when no watch covers it: today's REQ-JOB-TIMEOUT-30M, now a fallback. */
export const WALL_CLOCK_FALLBACK_MINUTES = 30;
export const WALL_CLOCK_FALLBACK_MS = WALL_CLOCK_FALLBACK_MINUTES * 60 * 1000;
/**
 * Watch jobs keep a 30-minute ceiling of their own: a finding's decision and investigation are fresh bounded jobs (the
 * WatchBoard card says at most 30 minutes), and the watch's re-check of a deciding finding (`WATCH_DECISION_RECHECK_MS`)
 * is derived from it.
 */
export const WATCH_MAX_MINUTES = 30;
export const WATCH_DECISION_RECHECK_MS = (WATCH_MAX_MINUTES + 5) * 60 * 1000;
/**
 * How long after the runner should have stopped its own job the worker stops it instead. Two minutes: the runner samples
 * every 15 s and gives an abort up to a minute to settle before it exits by itself, so a runner that is still judging
 * always ends its job inside this.
 */
export const BACKSTOP_GRACE_MS = 2 * 60 * 1000;
/** How often the worker reads the counters. */
export const ACTIVITY_POLL_MS = 15_000;
/** The counters file the runner writes beside the session file (INT-JOB-ACTIVITY-FILE). */
export const ACTIVITY_FILE = "activity.json";

/** The limit names a job's data and a trigger's `run` carry, in whole minutes. */
export const JOB_LIMIT_FIELDS = Object.freeze(["idleTimeoutMinutes", "stallTimeoutMinutes", "maxMinutes"]);

const wholeIn = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

/**
 * Validate a trigger's three `run` limits: `{ idleTimeoutMinutes?, stallTimeoutMinutes?, maxMinutes? }` as present, or
 * throws `refuse(message)`. Whole minutes: idle 1 to 1440, stall 0 (off) to 43200 (30 days), max 1 to 43200. A value that is not
 * a whole number in range is refused, never rounded or clamped: a limit the loader bends is not the limit the file reads.
 */
export function validateJobLimits(run, refuse) {
	const out = {};
	const ranges = { idleTimeoutMinutes: [1, JOB_IDLE_MINUTES_MAX], stallTimeoutMinutes: [0, JOB_MINUTES_MAX], maxMinutes: [1, JOB_MINUTES_MAX] };
	for (const field of JOB_LIMIT_FIELDS) {
		const value = run?.[field];
		if (value === undefined || value === null) continue;
		const [min, max] = ranges[field];
		if (!wholeIn(value, min, max)) refuse(`run.${field} must be a whole number of minutes from ${min} to ${max}`);
		out[field] = value;
	}
	return out;
}

/**
 * The limits a job runs under: `{ idleMinutes, stallMinutes, maxMinutes }`, each a whole number of minutes, with
 * `stallMinutes` 0 for off and `maxMinutes` null for none.
 *   - idle and stall: the trigger's when it set one, else the deployment's. A trigger may raise either (a known slow
 *     tool) as well as lower it: neither bounds money, which the turn budget and the caps do.
 *   - max: the smaller of the trigger's and the deployment's, each counted only when set, `maxCostUsd`'s rule: an
 *     operator's ceiling is a ceiling.
 *   - a watch job: at most WATCH_MAX_MINUTES whatever else is set.
 * A malformed queued value (a job written by hand, a store edited) counts as not set, and is said by the caller.
 */
export function effectiveJobLimits(data, deployment = {}) {
	const pick = (value, min, max) => (wholeIn(value, min, max) ? value : null);
	const idleMinutes = pick(data?.idleTimeoutMinutes, 1, JOB_IDLE_MINUTES_MAX) ?? pick(deployment.idleMinutes, 1, JOB_IDLE_MINUTES_MAX) ?? JOB_IDLE_MINUTES_DEFAULT;
	const stallMinutes = pick(data?.stallTimeoutMinutes, 0, JOB_MINUTES_MAX) ?? pick(deployment.stallMinutes, 0, JOB_MINUTES_MAX) ?? JOB_STALL_MINUTES_DEFAULT;
	const ceilings = [pick(data?.maxMinutes, 1, JOB_MINUTES_MAX), pick(deployment.maxMinutes, 1, JOB_MINUTES_MAX), data?.watch ? WATCH_MAX_MINUTES : null].filter((v) => v !== null);
	return { idleMinutes, stallMinutes, maxMinutes: ceilings.length > 0 ? Math.min(...ceilings) : null };
}

/** Which of a job's three limit fields hold a value the worker cannot read (for one log line, by name only). */
export function malformedJobLimits(data) {
	const ranges = { idleTimeoutMinutes: [1, JOB_IDLE_MINUTES_MAX], stallTimeoutMinutes: [0, JOB_MINUTES_MAX], maxMinutes: [1, JOB_MINUTES_MAX] };
	return JOB_LIMIT_FIELDS.filter((field) => data?.[field] !== undefined && data?.[field] !== null && !wholeIn(data[field], ...ranges[field]));
}
