/**
 * Why a job waits (issue #737): the closed vocabulary the worker writes into `defer:job:<id>` when it puts a job back
 * on the delayed set, and the rules a reader holds each field to. A LEAF: it imports nothing, so the admin console can
 * import it (`@edgehero/pi-dispatch/defer-reasons`) without pulling the worker's dependencies into its bundle. The
 * writer is `defer-write.mjs`; the reader is the admin's `readWaiting`.
 *
 * The record is the worker's own words for its own decision, written at the moment it defers, so a reader never has to
 * guess a reason from a job's data (which it must not read: `INT-WAIT-PROFILES-CONTRACT`) or from its timing. A job
 * with no record says so ("No reason was recorded"), and one whose record names a reason this console does not know
 * says that; each is true, never a guess. Every value is judged here on the way in (`deferHsetArgs`) and on the way out
 * (`parseDefer`), because the hash lives in a shared Valkey that anything with its URL can write.
 */

/** The hash's key prefix; the job's id follows it. */
export const DEFER_KEY = "defer:job:";

/** The defer record's key for a job id. */
export const deferKey = (jobId) => `${DEFER_KEY}${jobId}`;

/**
 * The buckets a console groups waiting jobs by, in the order it shows them. The last four are the reader's own and no
 * reason in `DEFER_WHYS` is in them: `paused` holds a job in a paused queue, `due` a delayed job whose due instant has
 * passed with no worker taking it (judged from the delayed set and the read's clock, whatever its record says),
 * `unknown` a job whose record names a reason this console does not know (it has the reason charset but is not in
 * `DEFER_WHYS`: most often a newer worker's), and `none` a job with no record, or with one whose reason fails the
 * charset (no reason at all). Each title is true of every job in its bucket, which is why a reason this console cannot
 * explain has a bucket of its own rather than sharing `none`'s "No reason was recorded".
 */
export const DEFER_BUCKETS = Object.freeze(["slot", "run", "check", "retry", "pause", "ready", "paused", "due", "unknown", "none"]);

/** Each bucket's words: a waitlist's title and its short form (a chip, a row's tag). */
export const DEFER_BUCKET_WORDS = Object.freeze({
	slot: Object.freeze({ title: "Waiting for a free slot", short: "Free slot" }),
	run: Object.freeze({ title: "Waiting for another run to finish", short: "Another run" }),
	check: Object.freeze({ title: "Waiting on a time or a check", short: "Time or check" }),
	retry: Object.freeze({ title: "Retry backoff", short: "Retry backoff" }),
	pause: Object.freeze({ title: "In a pause window", short: "Pause window" }),
	ready: Object.freeze({ title: "Waiting for its host to get ready", short: "Host getting ready" }),
	paused: Object.freeze({ title: "In a paused queue", short: "Queue paused" }),
	due: Object.freeze({ title: "Due, and no worker has taken it", short: "Due, not taken" }),
	unknown: Object.freeze({ title: "A reason this console does not know", short: "Unknown reason" }),
	none: Object.freeze({ title: "No reason was recorded", short: "No reason recorded" }),
});

/**
 * The `due` bucket's line, whose `{due}` is the job's due instant (the delayed set's, drawn as a `<time>`). Not a reason
 * in `DEFER_WHYS`: no worker records it, since the job is overdue exactly because no worker has looked at it since.
 */
export const DEFER_DUE_SENTENCE = "Due since {due}; no worker has taken it";

/**
 * Every reason the worker can record: its bucket and the sentence a console shows, whose `{placeholders}` the
 * console fills from the record's own fields (escaped; times drawn as `<time>`). A reason not in this table is
 * written by nobody: `deferHsetArgs` throws on one (a programming error), and `parseDefer` reads one as unknown.
 */
export const DEFER_WHYS = Object.freeze({
	canary: Object.freeze({ bucket: "run", sentence: "Waiting for the operator model canary to finish" }),
	"pause-window": Object.freeze({ bucket: "pause", sentence: "In a pause window until {until}" }),
	"size-never-fits": Object.freeze({ bucket: "slot", sentence: "Its size fits no slot on {host}; another host may take it" }),
	"host-slot": Object.freeze({ bucket: "slot", sentence: "{host} has no free job slot" }),
	"scope-folder": Object.freeze({ bucket: "slot", sentence: "Its folder is busy with another run" }),
	"scope-repo": Object.freeze({ bucket: "slot", sentence: "Its repository's concurrent limit is full" }),
	"scope-project": Object.freeze({ bucket: "slot", sentence: "Its project's concurrent limit is full" }),
	endpoint: Object.freeze({ bucket: "slot", sentence: "Every slot of model endpoint {endpoint} is taken" }),
	"model-cooldown": Object.freeze({ bucket: "check", sentence: "No reviewed model is available; a model is cooling down. Asks again at {until}" }),
	"model-window": Object.freeze({ bucket: "check", sentence: "No reviewed model is available; a model's dollar window is full. Asks again at {until}" }),
	"host-budget": Object.freeze({ bucket: "slot", sentence: "{host}'s budget has no room for it yet" }),
	"bundle-profile": Object.freeze({ bucket: "slot", sentence: "Waits for a host that serves its secret bundle profile" }),
	chained: Object.freeze({ bucket: "run", sentence: "Chained after {holder}; starts when its folder is free" }),
	"recovery-wait": Object.freeze({ bucket: "run", sentence: "Recovers run {holder}, whose attempt is still running" }),
	"wait-after": Object.freeze({ bucket: "check", sentence: "Held until {until}" }),
	"wait-hold": Object.freeze({ bucket: "check", sentence: "Held on its wait check; asks again at {until}" }),
	"wait-throttled": Object.freeze({ bucket: "check", sentence: "Its wait check waits for a free check slot" }),
	"wait-supersede": Object.freeze({ bucket: "check", sentence: "Asks again whether the delivery holding its target still waits" }),
	"wait-aborted": Object.freeze({ bucket: "check", sentence: "Its wait check was stopped by a restart or a cancel; asks again soon" }),
	"wait-unclear": Object.freeze({ bucket: "check", sentence: "Its wait check answered in a way the worker cannot read; asks again at {until}" }),
	"podman-restart": Object.freeze({ bucket: "ready", sentence: "Waits for rootful Podman's service on {host} to restart" }),
	"netns-keeper": Object.freeze({ bucket: "ready", sentence: "Waits for the network keeper on {host} to settle" }),
	retry: Object.freeze({ bucket: "retry", sentence: "Attempt {attempt} of {attempts} at {until}" }),
});

/** The hash's fields, in the order a reader's HMGET asks for them. `n` is the writer's own nonce, never shown. */
export const DEFER_FIELDS = Object.freeze(["why", "at", "until", "project", "host", "holder", "endpoint", "budgetWhy", "trigger", "attempt", "attempts", "n"]);

/** A reason's charset: what `parseDefer` takes as a reason word at all (a word outside the table reads as unknown). */
export const DEFER_WHY_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** The writer's nonce: 16 hex characters, so a compare-and-delete can tell its own record from another worker's. */
export const DEFER_N_RE = /^[0-9a-f]{16}$/;
/** A job id the record may name (`holder`). Pinned equal to the admin reader's `RUN_ID_RE` by a test. */
export const DEFER_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
/** A project id. A copy of `project-id.mjs`'s `PROJECT_ID_RE`, pinned equal to it by a test (this module imports nothing). */
export const DEFER_PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A host's name. A copy of `worker-name.mjs`'s `WORKER_NAME_RE`, pinned equal to it by a test. */
export const DEFER_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A model endpoint's id. A copy of `model-endpoints.mjs`'s `MODEL_ENDPOINT_ID_RE`, pinned equal to it by a test. */
export const DEFER_ENDPOINT_RE = /^[a-z0-9-]{1,32}$/;

/**
 * The last instant a UTC date-time can be written with a four-digit year: 9999-12-31T23:59:59.999Z. Every instant this
 * leaf passes on (`at`, `until`, a due time) is at most this, so a console can always draw it. NOT the latest instant a
 * JavaScript Date holds (8.64e15 ms, in the year 275760): `toISOString` writes a year past 9999 as six digits with a
 * sign (`+275760-09-13T00:00:00.000Z`), and a console that draws the first sixteen characters as `YYYY-MM-DD HH:MM`
 * would show a date that is not the instant's.
 */
export const DEFER_TIME_MAX_MS = 253402300799999;

/** How long a record outlives the job's due time, so a record is still there while the job is promoted and picked up. */
export const DEFER_TTL_SLACK_MS = 60_000;
/** A record's lifetime: until the job is due, plus the slack, and never less than the slack. */
export const deferTtlMs = (untilMs, nowMs) => Math.max(DEFER_TTL_SLACK_MS, untilMs - nowMs + DEFER_TTL_SLACK_MS);

/** BullMQ 5.80.4 stores a delayed job's score as `due * 4096 + counter` (getDelayedScore.lua); the due is the quotient. */
export const DELAYED_SCORE_SHIFT = 4096;
/**
 * A delayed zset score's due time in ms, or null for anything that is not a non-negative number whose quotient is an
 * instant a console can draw (at most `DEFER_TIME_MAX_MS`): a score anything with the URL wrote can be any double, and a
 * due time past that range has no date to show. Only a number or a non-empty string is a score: `Number(null)` and
 * `Number("")` are 0, and a ZSCORE of a missing member (null) must read as no due time, never as one at the epoch.
 */
export const dueOfScore = (score) => {
	if (typeof score !== "number" && !(typeof score === "string" && score.trim() !== "")) return null;
	const n = Number(score);
	if (!Number.isFinite(n) || n < 0) return null;
	const due = Math.floor(n / DELAYED_SCORE_SHIFT);
	return Number.isSafeInteger(due) && due <= DEFER_TIME_MAX_MS ? due : null;
};

/**
 * Whether a `repeat:` job is its scheduler's CURRENT next run: BullMQ names that run `repeat:<key>:<next>`, where
 * `<next>` is the scheduler's score in the queue's repeat zset (`isJobSchedulerJob.lua`). Only that run is "scheduled,
 * not in line": a `repeat:` job a gate deferred after the scheduler minted its successor is a real run that waits.
 */
export function isSchedulerNext(jobId, rjk, nextRaw) {
	if (typeof jobId !== "string" || typeof rjk !== "string" || rjk === "") return false;
	let next;
	if (typeof nextRaw === "number") {
		if (!Number.isFinite(nextRaw)) return false;
		next = String(nextRaw);
	} else if (typeof nextRaw === "string" && nextRaw !== "") {
		next = nextRaw;
	} else {
		return false;
	}
	return jobId === `repeat:${rjk}:${next}`;
}

/** A decimal safe integer, from a number or its string form, or null. */
function intOf(value) {
	if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
	if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) return null;
	const n = Number(value);
	return Number.isSafeInteger(n) ? n : null;
}

/** An integer within [lo, hi], or null. */
function intIn(value, lo, hi) {
	const n = intOf(value);
	return n !== null && n >= lo && n <= hi ? n : null;
}

/** A string that passes `re`, or null. */
const textOf = (value, re) => (typeof value === "string" && re.test(value) ? value : null);

/** Each field's rule: the value as the record holds it (a number or a string), or null when it fails. */
const FIELD_RULES = Object.freeze({
	why: (v) => (typeof v === "string" && Object.hasOwn(DEFER_WHYS, v) ? v : null),
	at: (v) => intIn(v, 0, DEFER_TIME_MAX_MS),
	until: (v) => intIn(v, 0, DEFER_TIME_MAX_MS),
	project: (v) => textOf(v, DEFER_PROJECT_RE),
	host: (v) => textOf(v, DEFER_HOST_RE),
	holder: (v) => textOf(v, DEFER_ID_RE),
	endpoint: (v) => textOf(v, DEFER_ENDPOINT_RE),
	budgetWhy: (v) => textOf(v, DEFER_WHY_RE),
	trigger: (v) => intIn(v, 0, 9999),
	attempt: (v) => intIn(v, 1, 1000),
	attempts: (v) => intIn(v, 1, 1000),
	n: (v) => textOf(v, DEFER_N_RE),
});

/**
 * The HSET arguments for a record, `[field, value, ...]`, each value judged by its field's rule and left out when it
 * fails (a record with a missing field is still worth writing; one with a wrong field is not worth trusting). A
 * reason not in `DEFER_WHYS` throws: every call site names its reason by a literal, so an unknown one is a bug.
 */
export function deferHsetArgs(rec) {
	const why = rec?.why;
	if (typeof why !== "string" || !Object.hasOwn(DEFER_WHYS, why)) throw new RangeError(`defer-reasons: unknown reason ${JSON.stringify(why)}`);
	const args = [];
	for (const field of DEFER_FIELDS) {
		const value = FIELD_RULES[field](rec[field]);
		if (value !== null) args.push(field, String(value));
	}
	return args;
}

/**
 * A record from an HMGET of `DEFER_FIELDS`, in that order: null when there is no `why` (no record, or none worth
 * reading); otherwise every field, each null when it is absent or fails its rule. A `why` with the reason charset but
 * not in the table is read as unknown (`known` false, bucket `unknown`): a newer worker's reason an older console does
 * not know. A `why` outside the charset is no reason at all (`why` null, bucket `none`). The nonce `n` is the writer's
 * and is never returned.
 */
export function parseDefer(values) {
	if (!Array.isArray(values)) return null;
	const raw = values[0];
	if (raw === null || raw === undefined || raw === "") return null;
	const why = typeof raw === "string" && DEFER_WHY_RE.test(raw) ? raw : null;
	const known = why !== null && Object.hasOwn(DEFER_WHYS, why);
	const at = (i) => values[i];
	return {
		why,
		known,
		bucket: known ? DEFER_WHYS[why].bucket : why !== null ? "unknown" : "none",
		at: FIELD_RULES.at(at(1)),
		until: FIELD_RULES.until(at(2)),
		project: FIELD_RULES.project(at(3)),
		host: FIELD_RULES.host(at(4)),
		holder: FIELD_RULES.holder(at(5)),
		endpoint: FIELD_RULES.endpoint(at(6)),
		budgetWhy: FIELD_RULES.budgetWhy(at(7)),
		trigger: FIELD_RULES.trigger(at(8)),
		attempt: FIELD_RULES.attempt(at(9)),
		attempts: FIELD_RULES.attempts(at(10)),
	};
}
