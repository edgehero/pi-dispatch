/**
 * `run.waitFor`: holding a job until a condition clears (issue #230).
 *
 * Two tiers, split by WHO CAN ANSWER, and the split is not cosmetic: one tier is free and the other
 * spawns a process.
 *
 *   { "after": "2026-09-01T09:00:00Z" }   tier 1 -- a wall-clock instant, answered in-process from the
 *                                         clock alone. One exact `moveToDelayed`, no polling at all.
 *   { "profile": "jira" }                 tier 2 -- an operator-declared executable answers go / not yet
 *                                         / cannot tell / never. Polled, and every poll is bounded.
 *
 * This module holds the two halves that BOTH the loader and the gate must agree on, so neither side
 * re-derives them: what a legal `after` instant is, and what `PI_WAIT_PROFILES` declares. The trigger-side
 * validator lives in `triggers.mjs` beside its siblings (`validateSecretsProfile`'s split), and reads this
 * file rather than restating it. The spawner that runs a profile will do the same when it lands; NOTHING
 * evaluates a wait yet, and this module is the only part of the feature currently wired to anything.
 *
 * PURE, FS-FREE AND ENV-FREE, for `secret-profiles.mjs`' reason: `config.mjs` imports this module and
 * `admin/build.mjs` inlines that chain into the published console. Whether a declared path EXISTS is asked
 * once, on the worker that is about to spawn it.
 *
 * `configError` is a local copy rather than an import from `config.mjs`, which imports this module. The
 * cycle would resolve (function declarations hoist) but would be a trap for the next reader -- the same
 * duplication, for the same reason, is in `secret-profiles.mjs` and `env-allowlist.mjs`.
 */

import { isAbsolute } from "node:path";

function configError(message) {
	const error = new Error(message);
	error.piDispatchConfig = true;
	return error;
}

/**
 * The condition keys this version understands. `exclusive` is deliberately ABSENT and is refused by name
 * in `triggers.mjs`: issue #242 shipped an always-on one-job-per-folder mutex at this very gate, so the
 * condition it asked for is structural now, and `scoped-limits.json` covers the wider per-scope case.
 * Accepting-and-ignoring it would be the silent no-op this project refuses.
 */
export const WAIT_CONDITION_KEYS = ["after", "profile"];

/**
 * The ceiling on conditions per trigger. Four, on `SECRETS_MAX`'s reasoning rather than `REPLICAS_MAX`':
 * this multiplies no spend, but every `profile` condition is a subprocess evaluated before the container,
 * so an unbounded array is an unbounded slot occupancy. Four is generous for a conjunction a human wrote.
 */
export const WAIT_CONDITION_MAX = 4;

/**
 * The re-check cadence floor, and the ceiling the elapsed-derived backoff climbs to.
 *
 * CLAMPED UP, NEVER REFUSED, which is the poller's posture and its reason verbatim: "a typo'd `1` must not
 * turn the harness into a hammer". Note what that does and does not cover -- `positiveInt` still refuses
 * `0`, a negative, a fraction and a non-number at boot, so only a positive integer BELOW the floor is
 * quietly raised. The floor is 30s rather than the poller's because there is no third party asking for
 * politeness here; what it protects is this worker's own concurrency slots.
 *
 * The floor is also load-bearing in a second place, and lowering it would break that silently: it is what
 * lets a held job be told apart from a scope deferral, whose re-check is `SCOPE_BUSY_RECHECK_MS` (5s). Any
 * value at or below that would make the two indistinguishable by wake instant.
 *
 * `WAIT_INTERVAL_MAX_MS` is the ceiling the backoff climbs to, and it is a ceiling on the BACKOFF, never on
 * the operator: the rule the backoff must implement is `min(max(base·2^k, base), max(WAIT_INTERVAL_MAX_MS,
 * base))`, so an operator who deliberately configured an hourly cadence to save money keeps it. Writing the
 * cap as a bare `min(..., 900_000)` is the obvious spelling and it silently turns their hour into fifteen
 * minutes -- a 4x cost overrun, in the direction they were trying to avoid, from a knob this file documents
 * as clamped UPWARD.
 */
export const WAIT_INTERVAL_FLOOR_MS = 30_000;
export const WAIT_INTERVAL_MAX_MS = 900_000;

/**
 * The default ceiling on how far out an `after` instant may sit, and deliberately NOT the maximum hold.
 *
 * An `after` polls nothing: it is one exact `moveToDelayed` to an instant, self-terminating and costing
 * nothing while it waits, so bounding it by the polling budget would refuse "hold this until the
 * maintenance window next month" for a reason about subprocesses it never runs. Thirty days is a bound on
 * how far ahead a REVIEWED FILE may schedule, not a bound on cost.
 *
 * A literal shared by `config.mjs` and the processor's own default, so a bare `makeProcessor` under test
 * and a wired worker agree on what "too far" means.
 */
export const WAIT_AFTER_MAX_DEFAULT_MS = 30 * 24 * 3600 * 1000;

/**
 * How long to wait before the next check, given the configured base and how long this job has been held.
 *
 * Doubles every ten base periods and settles at `WAIT_INTERVAL_MAX_MS` -- **or at `base`, whichever is
 * larger**. That `Math.max` is the whole reason this is a function and not a constant the caller clamps
 * against: the obvious spelling, `Math.min(grown, WAIT_INTERVAL_MAX_MS)`, silently turns a deliberately
 * configured hourly cadence into a fifteen-minute one, which is a 4x cost overrun in exactly the direction
 * the operator was economising. Shipped with the constant so the rule cannot be re-derived wrongly later.
 *
 * DERIVED FROM ELAPSED, never stored: a deferral consumes no attempt (`moveToDelayed` passes
 * `skipAttempt: true`), so `attemptsMade` cannot carry a retry count and nothing else may either. Reading
 * the schedule off the clock makes it survive a worker restart for free.
 */
export function waitBackoffMs(baseMs, elapsedMs) {
	const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : WAIT_INTERVAL_FLOOR_MS;
	const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
	const grown = base * 2 ** Math.floor(elapsed / (10 * base));
	return Math.min(Math.max(grown, base), Math.max(WAIT_INTERVAL_MAX_MS, base));
}

/**
 * An ISO-8601 instant that carries its own zone: `Z`, `z`, or a numeric offset. Seconds and fractional
 * seconds are optional.
 *
 * THE ZONE IS REQUIRED, and that is the whole point of not using bare `Date.parse`. `Date.parse` accepts
 * "2026-09-01T09:00:00" and resolves it against the WORKER'S local zone, so the same reviewed file would
 * hold a job for a different instant on a machine in Amsterdam than on one in UTC, silently, with nothing
 * in the file to explain the difference. `pause-windows.mjs` solves the same problem the other way (an
 * explicit `tz` field, defaulting to UTC) because its times recur; a one-shot instant can simply carry its
 * own offset, so requiring one is cheaper than inventing a second timezone field.
 *
 * The TIME fields are range-bounded in the pattern rather than left to `Date.parse`, for the same reason the
 * calendar is re-checked below: `Date.parse` reads `T24:00:00` as the next day's midnight, so an hour field
 * nobody can write on a clock would silently produce a hold one day later than the file says. `:60` in the
 * minute or second field is refused for the same reason (there are no leap seconds to honour here, and a
 * value that rolls is worse than a value that refuses).
 */
const AFTER_INSTANT = /^\d{4}-\d{2}-\d{2}[Tt]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * A profile name. The same charset `triggers.mjs` allows in `run.waitFor[].profile`, and a local copy for
 * `secret-profiles.mjs`' stated reason: a name that failed here after passing there would be an
 * operator-visible contradiction between two files meant to agree. `,` and `:` are excluded because they
 * are `PI_WAIT_PROFILES`' own separators, so a name carrying either could not round-trip.
 */
const PROFILE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The epoch ms of a legal `after` value, or `null` when the text is not one.
 *
 * ONE DEFINITION, READ BY BOTH SIDES. The loader calls this to refuse a malformed instant at load; the
 * pickup gate calls it to decide how long to hold. A second spelling in either place is how a file that
 * loads clean starts holding for an instant nobody wrote.
 */
export function parseAfterInstant(text) {
	if (typeof text !== "string" || !AFTER_INSTANT.test(text)) return { error: "shape" };
	const ms = Date.parse(text);
	if (!Number.isFinite(ms)) return { error: "calendar" }; // an out-of-range month: "2026-13-01T00:00Z"
	// An out-of-range DAY does not reach that check, and this is the surprise worth refusing: `Date.parse`
	// rejects month 13 but silently ROLLS "2026-02-31T00:00:00Z" forward to March 3rd. An operator who
	// mistyped a date would get a hold that ends on a day they did not write, with the file still reading
	// as though they had. The calendar fields are checked against the date part alone, so an offset in the
	// text cannot move the day being validated: the operator wrote that date, whatever zone it is in.
	const [year, month, day] = text.slice(0, 10).split("-").map(Number);
	const probe = new Date(Date.UTC(year, month - 1, day));
	// `Date.UTC` maps a two-digit year onto 19xx, so a year below 100 would fail the comparison below and
	// refuse for a reason that has nothing to do with the operator's date. Absurd as a wait, but a refusal
	// the code did not mean to make is still a refusal nobody can act on.
	if (year < 100) probe.setUTCFullYear(year);
	if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
		return { error: "calendar" };
	}
	return { ms };
}

/**
 * The epoch ms of a legal `after` value, or `null`. The runtime spelling of `parseAfterInstant`, which the
 * gate wants because at pickup there is nothing to say: the loader already refused anything unparseable, so
 * by then the only question is what instant to hold until.
 */
export function afterInstantMs(text) {
	const parsed = parseAfterInstant(text);
	return parsed.error ? null : parsed.ms;
}

/**
 * Parse `PI_WAIT_PROFILES`: `name:/abs/path,other:/abs/other`. Returns `{ [name]: path }`, empty when
 * unset. Throws (config-tagged, so the worker refuses to boot) on anything malformed.
 *
 * The twin of `parseSecretProfiles`, deliberately duplicated rather than generalised into a shared helper.
 * The two variables mean different things (one resolves a value, one answers a question), they will drift
 * apart as this one grows bounds the other has no use for, and a shared parser would have to be told which
 * variable name to put in every error message -- which is the only part an operator reads.
 *
 * SET-BUT-GARBLED FAILS LOUD: a silently dropped entry is a profile the operator believes is wired, and
 * every trigger naming it would refuse at delivery time with the operator looking at the line that appears
 * to declare it. Each entry splits on its FIRST colon, so `prod:C:\pi\wait.cmd` parses on Windows.
 */
export function parseWaitProfiles(raw) {
	if (raw === undefined || raw === null || String(raw).trim() === "") return Object.create(null);
	// PROTOTYPE-FREE, and that is a correctness requirement rather than hygiene: a profile named `toString`
	// or `constructor` passes ID_CHARSET, so on a `{}` table `profiles[name]` answers with an inherited
	// FUNCTION instead of `undefined` and the gate's "is this profile declared?" check silently says yes --
	// for a name no operator declared, with the variable unset entirely. `Object.create(null)` also stops
	// `name in profiles` from reporting a duplicate that was never written.
	const profiles = Object.create(null);
	for (const entry of String(raw).split(",")) {
		const text = entry.trim();
		if (text === "") continue; // a trailing comma is a typo, not a declaration
		const cut = text.indexOf(":");
		if (cut <= 0) {
			throw configError(`PI_WAIT_PROFILES entries must be name:/absolute/path, got ${JSON.stringify(text)}`);
		}
		const name = text.slice(0, cut).trim();
		const path = text.slice(cut + 1).trim();
		if (!PROFILE_NAME.test(name)) {
			throw configError(`PI_WAIT_PROFILES profile name ${JSON.stringify(name)} may use letters, digits, dot, dash and underscore only`);
		}
		if (name in profiles) {
			throw configError(`PI_WAIT_PROFILES declares ${JSON.stringify(name)} twice -- one of the two is not the check you think is running`);
		}
		if (path === "" || !isAbsolutePath(path)) {
			throw configError(`PI_WAIT_PROFILES profile ${JSON.stringify(name)} needs an ABSOLUTE path to its check -- a service manager's working directory is not your shell's, so a relative path is a different file on every host`);
		}
		profiles[name] = path;
	}
	return profiles;
}

/** Absolute on this platform, accepting a Windows drive letter or UNC root as `service.mjs` does. */
function isAbsolutePath(path) {
	return isAbsolute(path) || /^([A-Za-z]:[\\/]|\\\\)/.test(path);
}

/**
 * True when this job carries any wait condition at all. The ONE guard every wait code path is behind, so
 * an unflagged job takes zero new branches and its record, job data and key set stay byte-identical to a
 * run prepared before this field existed.
 */
export function waitArmed(job) {
	return Array.isArray(job?.waitFor) && job.waitFor.length > 0;
}

/**
 * The `after` instant this job is holding for, or `null`. At most one `after` per array is legal (the
 * loader refuses a second), so this is a lookup, not a fold.
 */
export function afterMs(job) {
	if (!waitArmed(job)) return null;
	for (const condition of job.waitFor) {
		const ms = afterInstantMs(condition?.after);
		if (ms !== null) return ms;
	}
	return null;
}

/**
 * The conditions on this job that this worker cannot read, as written.
 *
 * The loader refuses all of these, and the loader is a DIFFERENT PROCESS: `job.data.waitFor` reaches the
 * gate over Redis from the receiver, so a receiver newer than the worker can enqueue a condition shape this
 * build has no branch for. Returning them rather than ignoring them is what lets the gate refuse instead of
 * silently treating an unreadable condition as a satisfied one -- the forward half of the same version skew
 * `makeCheckWaitSkew` closes backward.
 *
 * Deliberately structural rather than a re-run of the loader's validator: this asks only "can I act on
 * this?", so a future worker that learns a new condition answers differently here without the two
 * validators having to agree on every message.
 */
export function unreadableConditions(job) {
	if (!waitArmed(job)) return [];
	// A SECOND `after` is unreadable even though each one parses: the conjunction has no defined meaning
	// with two instants, `afterMs` answers with whichever comes first, and the loader refuses the shape --
	// so a job carrying one arrived from something newer or something wrong, which is this function's whole
	// subject. Counted here rather than in the shape filter below, which sees one condition at a time.
	let afters = 0;
	for (const c of job.waitFor) if (c && typeof c === "object" && !Array.isArray(c) && Object.keys(c)[0] === "after") afters += 1;
	if (afters > 1) return [...job.waitFor];
	return job.waitFor.filter((condition) => {
		if (condition === null || typeof condition !== "object" || Array.isArray(condition)) return true;
		const keys = Object.keys(condition);
		if (keys.length !== 1 || !WAIT_CONDITION_KEYS.includes(keys[0])) return true;
		if (keys[0] === "after") return afterInstantMs(condition.after) === null;
		return !isDeclarableName(condition.profile);
	});
}

/** A profile name this worker will put in a log line and a public comment. See `waitLabel`. */
function isDeclarableName(value) {
	return typeof value === "string" && PROFILE_NAME.test(value);
}

/**
 * The profile names this job waits on, in the operator's writing order. Order matters here even though the
 * conditions are a CONJUNCTION and the tiers are evaluated cheapest-first: within tier 2 the checks run
 * sequentially, and naming the first one that says "not yet" is what makes a held row readable.
 */
export function waitProfileNames(job) {
	if (!waitArmed(job)) return [];
	const names = [];
	for (const condition of job.waitFor) {
		// Charset-checked HERE, not merely upstream. The loader enforces the same set, but that runs in a
		// different process and this value ends up in a PUBLIC forge comment and a log line: a name carrying
		// a backtick breaks the code span it is rendered in, and one carrying a newline is a log injection.
		// The module that makes the no-attacker-bytes claim is the one that has to enforce it -- the same
		// reasoning as this file's prototype-free profile table.
		if (isDeclarableName(condition?.profile)) names.push(condition.profile);
	}
	return names;
}

/**
 * A short, PII-free label for what this job is waiting on, for the held row and the log line.
 *
 * Every byte of it is checked HERE against `PROFILE_NAME` or the instant grammar, rather than trusted to
 * have been checked by the loader in another process. Nothing attacker-chosen can reach it,
 * which is the property that lets it sit in a panel row and a log line at all (`INT-RUN-HISTORY-FILE-CONTRACT`'s
 * PII-free-by-construction rule, applied to a surface that is not the record).
 */
export function waitLabel(job) {
	if (!waitArmed(job)) return null;
	const parts = [];
	for (const condition of job.waitFor) {
		// Both arms are re-validated for the reason waitProfileNames states: this string is rendered to
		// operators, and "it was validated upstream" is a claim about another process.
		if (afterInstantMs(condition?.after) !== null) parts.push(`after ${condition.after}`);
		else if (isDeclarableName(condition?.profile)) parts.push(condition.profile);
	}
	return parts.length > 0 ? parts.join(" + ") : null;
}
