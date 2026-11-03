/**
 * BullMQ's internals, in one place (issue #761): every fact this project reads or writes past BullMQ's public API. The
 * key names (`bull:<queue>:<type>`), the job hash's field names, the meta hash's flags, the delayed set's score, the
 * `repeat:<scheduler>:<slot>` id a job scheduler mints (and this project's hand-fire id, `manual:<id>:<ms>`, which is
 * built to the same shape), and the two rules a custom job id must pass. Every other file imports them from here, so a
 * BullMQ bump that moves one of them is a change to one file, and `worker/test/bullmq-internals.test.mjs` refuses a
 * second spelling anywhere in the source trees.
 *
 * Each fact was read from the shipped files of bullmq `BULLMQ_VERIFIED_VERSION`, cited beside it, and is pinned three
 * ways: the unit test holds the text of each cited file, the integration test holds the behaviour against a real
 * Valkey, and a pins test holds every workspace's bullmq, ioredis and cron-parser pin to the lockfile and to that
 * version. A bump re-reads the cited files; the tests say which one moved.
 *
 * A LEAF: it imports nothing, so the receiver and the admin console import it (`@edgehero/pi-dispatch/bullmq-internals`)
 * without the worker's dependencies. It never names the library in a string either: valkey-clients.test.mjs allows that
 * only in the files that construct the library's classes.
 *
 * What stays where it is: BullMQ's public API (`Queue`, `Worker`, `getJobs`, the state names), which semver governs and
 * a bump's changelog announces, and this project's own names (`QUEUE`, `hostQueueName`, `sanitizeJobId`).
 */

/** The bullmq release every fact below was read from. The installed package must be this version (the pins test). */
export const BULLMQ_VERIFIED_VERSION = "5.80.4";

/** The key prefix every queue's keys share (queue-keys.js: `constructor(prefix = 'bull')`). */
export const BULL_PREFIX = "bull";

/** The per-queue keys this project reads, each `bull:<queue>:<type>` (queue-keys.js `getKeys`). */
export const QUEUE_KEY = Object.freeze({ meta: "meta", wait: "wait", paused: "paused", delayed: "delayed", prioritized: "prioritized", repeat: "repeat" });

/** A queue's key for `type` (queue-keys.js `toKey`: `${prefix}:${name}:${type}`). A job's own hash is `type` = its id. */
export const queueKey = (queueName, type, prefix = BULL_PREFIX) => `${prefix}:${queueName}:${type}`;

/** A queue's key for `type`: the queue's own `toKey` where it has one (it knows its prefix), else `queueKey`. */
export function queueKeyOf(q, type) {
	return typeof q?.toKey === "function" ? q.toKey(type) : queueKey(q?.name, type);
}

/** A job's own hash in queue `q`: BullMQ keys it by the bare id under the queue's prefix. */
export const jobKeyOf = (q, jobId) => queueKeyOf(q, jobId);

/**
 * The fields of a job's own hash this project reads, as job.js `fromJSON` reads them: its kind (`name`), its data, its
 * enqueue instant, its dedup id (`deid`), its scheduler (`rjk`), its attempts (`atm`, and the older `attemptsMade`,
 * which `fromJSON` reads first) and its stall count (`stc`).
 */
export const JOB_FIELD = Object.freeze({ name: "name", data: "data", timestamp: "timestamp", dedupId: "deid", schedulerKey: "rjk", attempts: "atm", attemptsOld: "attemptsMade", stalls: "stc" });

/** The meta hash's fields: the pause flag (pause-7.lua writes `1`, a resume deletes it) and the library's version. */
export const META_FIELD = Object.freeze({ paused: "paused", version: "version" });

/**
 * Whether a queue's meta `paused` field says paused, as BullMQ reads it: the field's PRESENCE (`HEXISTS` in
 * isQueuePaused.lua, and getTargetQueueList.lua, where any string is true), whatever it holds, so `"0"` and `""` are
 * paused too. `cmd` is the command the reader sent: `HEXISTS` answers 1 for a field that is there, `HGET` the value,
 * null for none.
 */
export function isPausedFlag(cmd, value) {
	if (cmd === "hexists") return value === 1 || value === "1";
	return value !== null && value !== undefined;
}

/**
 * The version in a meta hash's `version` field (`libName:version`, queue.js `metaValues`), or null. NOT a fleet fact:
 * every process that constructs a Queue writes it, so in a fleet of mixed versions it holds whichever wrote last. Only
 * the integration test reads it, to prove the library it ran against is the verified one.
 */
export function metaVersionOf(raw) {
	const m = typeof raw === "string" ? /^bullmq:(\d+\.\d+\.\d+)$/.exec(raw) : null;
	return m ? m[1] : null;
}

/** A SCAN pattern for the meta key of every queue whose name starts with `namePrefix`. */
export const metaKeyPattern = (namePrefix) => queueKey(`${namePrefix}*`, QUEUE_KEY.meta);

/**
 * The queue a meta key belongs to (`bull:<name>:meta`), or null. A queue's name holds no `:` (queue-base.js refuses
 * one), so a key whose middle does is some other key a pattern's `*` matched: a job's own hash, whose custom id may
 * hold two colons (`bull:pi-jobs:a:b:meta`).
 */
export function queueNameOfMetaKey(key) {
	if (typeof key !== "string") return null;
	const head = `${BULL_PREFIX}:`;
	const tail = `:${QUEUE_KEY.meta}`;
	if (!key.startsWith(head) || !key.endsWith(tail) || key.length <= head.length + tail.length) return null;
	const name = key.slice(head.length, -tail.length);
	return name.includes(":") ? null : name;
}

/** A delayed job's score is `due * 4096 + a counter` (getDelayedScore.lua: `delayedTimestamp * 0x1000`). */
export const DELAYED_SCORE_SHIFT = 4096;

/**
 * The latest due time `dueOfScore` passes on: a copy of `DEFER_TIME_MAX_MS` (defer-reasons.mjs, which says why), pinned
 * equal to it by a test, because this module imports nothing.
 */
export const SCORE_DUE_MAX_MS = 253402300799999;

/**
 * A delayed zset score's due time in ms, or null for anything that is not a non-negative number whose quotient is an
 * instant a console can draw (at most `SCORE_DUE_MAX_MS`): a score anything with the URL wrote can be any double, and a
 * due time past that range has no date to show. Only a number or a non-empty string is a score: `Number(null)` and
 * `Number("")` are 0, and a ZSCORE of a missing member (null) must read as no due time, never as one at the epoch.
 */
export const dueOfScore = (score) => {
	if (typeof score !== "number" && !(typeof score === "string" && score.trim() !== "")) return null;
	const n = Number(score);
	if (!Number.isFinite(n) || n < 0) return null;
	const due = Math.floor(n / DELAYED_SCORE_SHIFT);
	return Number.isSafeInteger(due) && due <= SCORE_DUE_MAX_MS ? due : null;
};

/** The prefix of every job a job scheduler mints (job-scheduler.js `getSchedulerNextJobId`, addJobScheduler-11.lua). */
export const SCHEDULER_JOB_PREFIX = "repeat";

/**
 * The prefix of a cron trigger's run fired by hand (`manualTriggerJobId`, job-id.mjs). This project's own, but built
 * to BullMQ's shape: a custom id with a `:` must split into exactly three parts (`customJobIdAllowed`), as a
 * scheduler's does, so every reader of a cron run reads both with one grammar.
 */
export const MANUAL_JOB_PREFIX = "manual";

/** The most digits a slot holds: a JavaScript Date's last instant, 8.64e15 ms, is 16 digits. */
export const SLOT_DIGITS_MAX = 16;

/** What a scheduler's run id adds to its scheduler's id: the prefix, two colons and a slot. */
export const SCHEDULER_JOB_ID_OVERHEAD = `${SCHEDULER_JOB_PREFIX}::`.length + SLOT_DIGITS_MAX;

/**
 * The longest scheduler id a reader of Valkey or a surface that prints one takes, and the charset (the triggers
 * loader's `ID_CHARSET`, which refuses a `:`). Bounded where it is read, because anything holding the Valkey's URL can
 * write a scheduler key or a job id, and a surface prints it in running text. 200, not the loader's `CRON_ID_MAX`: a
 * scheduler that an earlier release upserted for a longer id is still in Valkey after an upgrade (every release before
 * issue #761 took a cron id of any length), and a surface must still name it so an operator can find and remove it. A
 * reader of run RECORDS takes any length (`cronRunOf` without `idMax`): a record is this deployment's own history.
 */
export const SCHEDULER_ID_MAX = 200;
export const SCHEDULER_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

/** The job id a scheduler mints for its run at `ms`: `repeat:<id>:<ms>` (job-scheduler.js, addJobScheduler-11.lua). */
export const schedulerJobId = (schedulerId, ms) => `${SCHEDULER_JOB_PREFIX}:${schedulerId}:${ms}`;

/** A cron run's job id: the prefix, the trigger's id in the loader's charset, and a slot in decimal with no leading 0. */
const CRON_RUN_RE = /^(repeat|manual):([A-Za-z0-9._-]+):(0|[1-9][0-9]{0,15})$/;

/**
 * A cron trigger's run, from its job id: `{ kind, id, ms }`, `kind` `"repeat"` (its scheduler minted it) or `"manual"`
 * (fired by hand), `id` the trigger's (the scheduler's) id and `ms` the slot. Null for any other id. Strict: both
 * writers mint the slot from a number, so it is plain digits, and the id is in the loader's charset, which has held
 * since the first release. `ms` past `Number.MAX_SAFE_INTEGER` (no Date reaches it) is not exact, so a caller that
 * makes an instant of it checks `Number.isSafeInteger`.
 *
 * `idMax` bounds the id for a reader of Valkey or a surface (`SCHEDULER_ID_MAX`); a reader of run records passes none,
 * since every release before issue #761 took a cron id of any length and its records must still be read.
 */
export function cronRunOf(jobId, { idMax = Infinity } = {}) {
	const m = typeof jobId === "string" ? CRON_RUN_RE.exec(jobId) : null;
	if (m === null || m[2].length > idMax) return null;
	return { kind: m[1], id: m[2], ms: Number(m[3]) };
}

/** The two job id prefixes of a cron trigger's runs, `repeat:<id>:` and `manual:<id>:`, for a scan by prefix. */
export const cronRunPrefixes = (id) => [`${SCHEDULER_JOB_PREFIX}:${id}:`, `${MANUAL_JOB_PREFIX}:${id}:`];

/**
 * Whether a job id is in a scheduler's namespace (`repeat:`), whether or not the rest parses: the stall guard counts
 * such a job and logs one it cannot parse. A hand-fired `manual:` run is not a scheduler's job.
 */
export const isSchedulerJobId = (jobId) => typeof jobId === "string" && jobId.startsWith(`${SCHEDULER_JOB_PREFIX}:`);

/**
 * The scheduled-for instant of a scheduler's run, read from its id (DES-CRON-VIA-BULLMQ-SCHEDULER), or null. A
 * `manual:` run has no scheduled instant (`manualTriggerJobId` floors its time to the minute), so it reads as null.
 */
export function scheduledForMillis(jobId) {
	const run = cronRunOf(jobId);
	return run !== null && run.kind === SCHEDULER_JOB_PREFIX ? run.ms : null;
}

/**
 * Whether a `repeat:` job is its scheduler's CURRENT next run: BullMQ names that run `repeat:<key>:<next>`, where
 * `<next>` is the scheduler's score in the queue's repeat zset (isJobSchedulerJob.lua). Only that run is "scheduled,
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
	return jobId === schedulerJobId(rjk, next);
}

/**
 * Whether `queue.add` takes `id` as a custom job id (job.js `validateOptions`): not an integer's own spelling ("Custom
 * Id cannot be integers", `${parseInt(id, 10)}` === id, so `"NaN"` too), and a `:` only when the id splits into exactly
 * three parts ("Custom Id cannot contain :"), the shape a scheduler's own ids have. An empty id is no custom id at all.
 */
export function customJobIdAllowed(id) {
	if (typeof id !== "string" || id === "") return false;
	if (`${parseInt(id, 10)}` === id) return false;
	return !id.includes(":") || id.split(":").length === 3;
}
