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

/**
 * Observe the real consumer path (worker.js mainLoop calls _getNextJob, NOT public getNextJob). No scheduling
 * logic is copied. waitForJob swallows connection errors and returns Infinity, which is not a successful read.
 * processFn wraps the entire processor, including preflight, and retains the signal arity decided at construction.
 * RedisConnection.init creates _client before its first await; waiting on .client would hide a failed startup.
 * Pinned by consumer-supervision.test.mjs against the installed worker/redis-connection/ioredis-client files.
 */
export function observeConsumer(worker, events) {
	for (const [method, before, after] of [
		["_getNextJob", () => events.fetch(), () => {}],
		["moveToActive", () => {}, () => events.success()],
		["waitForJob", () => {}, (value) => { if (Number.isFinite(value)) events.success(); }],
	]) {
		const original = worker[method];
		if (typeof original !== "function") continue;
		worker[method] = async function (...args) {
			before();
			const value = await original.apply(this, args);
			after(value);
			return value;
		};
	}
	const process = worker.processFn;
	if (typeof process === "function") worker.processFn = async function (...args) {
		events.taken();
		try { return await process.apply(this, args); }
		finally { events.finished(); }
	};
	const clients = [worker.connection?._client, worker.blockingConnection?._client].filter(Boolean);
	const listeners = [];
	for (const client of clients) for (const event of ["ready", "close", "reconnecting", "end"]) {
		const fn = () => events.connection();
		client.on(event, fn);
		listeners.push(() => client.removeListener(event, fn));
	}
	return {
		connection() {
			const statuses = clients.map((c) => c.status);
			if (statuses.includes("end")) return "ended";
			if (statuses.length === 2 && statuses.every((s) => s === "ready")) return "ready";
			if (statuses.some((s) => s === "reconnecting" || s === "close")) return "reconnecting";
			return "starting";
		},
		rateLimited: () => worker.isRateLimited?.() === true,
		close: () => { for (const remove of listeners) remove(); },
	};
}

/** The key prefix every queue's keys share (queue-keys.js: `constructor(prefix = 'bull')`). */
export const BULL_PREFIX = "bull";

/** The per-queue keys this project reads, each `bull:<queue>:<type>` (queue-keys.js `getKeys`). */
export const QUEUE_KEY = Object.freeze({ meta: "meta", wait: "wait", paused: "paused", delayed: "delayed", prioritized: "prioritized", repeat: "repeat", completed: "completed", failed: "failed" });

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
 * which `fromJSON` reads first), its stall count (`stc`), and its completed result (`returnvalue`).
 */
export const JOB_FIELD = Object.freeze({ name: "name", data: "data", timestamp: "timestamp", dedupId: "deid", schedulerKey: "rjk", attempts: "atm", attemptsOld: "attemptsMade", stalls: "stc", result: "returnvalue" });

/** The stored semantic key (scripts.js removeDeduplicationKey, removeDeduplicationKey-1.lua). */
export const semanticWindowKeyOf = (queue, id) => queueKeyOf(queue, `de:${id}`);

/**
 * The SCAN pattern for every semantic window of one item, `de:<item>:*` (issue #932, `pi-dispatch status --target`).
 * The caller's item holds no glob character (`parseSemanticItem`), so it is matched as it is.
 */
export const semanticWindowItemPatternOf = (queue, item) => semanticWindowKeyOf(queue, `${item}:*`);

/** The dedup id a semantic window key holds, the inverse of `semanticWindowKeyOf`, or null for any other key. */
export function semanticIdOfKey(queue, key) {
	const prefix = semanticWindowKeyOf(queue, "");
	return typeof key === "string" && key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : null;
}

// Issue #899: a completed refusal may still own its TTL key. Read its actual hash, not queue.add's returned Job:
// job.js create builds that object from the INCOMING data, then replaces only its id with the surviving id.
// getState-8.lua judges completion by membership in the completed set, and failure (attempts used up) by the failed
// set, checked in that order; moveToFinished-14.lua writes the result under returnvalue. Issue #932 adds the failed
// answer and the key's PTTL: a request joined to an owner that has ENDED is never served, so its producer says so on
// the forge, with the time the window closes. All reads and ownership are one snapshot, so a disappearing owner is
// never called live.
const READ_SEMANTIC_OWNER = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return {"changed"} end
if redis.call("HGET", KEYS[2], "${JOB_FIELD.dedupId}") ~= ARGV[2] then return {"invalid"} end
local ttl = redis.call("PTTL", KEYS[1])
if redis.call("ZSCORE", KEYS[3], ARGV[1]) then
  local result = redis.call("HGET", KEYS[2], "${JOB_FIELD.result}")
  if not result then return {"invalid"} end
  return {"completed", result, ttl}
end
if redis.call("ZSCORE", KEYS[4], ARGV[1]) then return {"failed", "", ttl} end
return {"retained", "", ttl}
`;

// The predicate belongs to the caller. This script checks the exact bytes it judged, together with terminal state
// and ownership, before deleting. A public retry, replacement owner, or result edit between reads makes it a no-op.
// Comparing JSON.stringify(parsed) would not compare the bytes stored by an older writer (or even its key order).
const RELEASE_COMPLETED_SEMANTIC_OWNER = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call("HGET", KEYS[2], "${JOB_FIELD.dedupId}") ~= ARGV[2] then return 0 end
if not redis.call("ZSCORE", KEYS[3], ARGV[1]) then return 0 end
if redis.call("HGET", KEYS[2], "${JOB_FIELD.result}") ~= ARGV[3] then return 0 end
return redis.call("DEL", KEYS[1])
`;

const semanticOwnerKeys = (queue, dedupId, jobId) => [semanticWindowKeyOf(queue, dedupId), jobKeyOf(queue, jobId), queueKeyOf(queue, QUEUE_KEY.completed)];

/**
 * Atomic snapshot of the key's actual owner, including the raw result witness for a conditional release: `state` is
 * `changed`, `invalid`, `completed`, `failed` (it used up its attempts) or `retained` (anything still live: waiting,
 * delayed, active, prioritized, paused), and `pttlMs` the key's own PTTL (-1 for no expiry), or null when not read.
 */
export async function readSemanticWindowOwner(queue, dedupId, jobId) {
	const reply = await (await queue.client).eval(READ_SEMANTIC_OWNER, 4, ...semanticOwnerKeys(queue, dedupId, jobId), queueKeyOf(queue, QUEUE_KEY.failed), jobId, dedupId);
	if (!Array.isArray(reply) || !["changed", "invalid", "retained", "completed", "failed"].includes(reply[0])) throw new Error("semantic-window-state-unavailable");
	return { state: reply[0], rawResult: reply[0] === "completed" ? reply[1] : undefined, pttlMs: Number.isSafeInteger(reply[2]) ? reply[2] : null };
}

/** Delete only the terminal owner whose exact result the caller classified; false means it must read again. */
export async function releaseCompletedSemanticWindow(queue, dedupId, jobId, rawResult) {
	return (await (await queue.client).eval(RELEASE_COMPLETED_SEMANTIC_OWNER, 3, ...semanticOwnerKeys(queue, dedupId, jobId), jobId, dedupId, rawResult)) === 1;
}

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
 * Whether Valkey refused a queue's pause or resume before its script ran (issues #1007 and #1014), so the queue did not
 * change: an ACL that denies EVAL or EVALSHA, a read-only replica, a Valkey still loading, one busy with another script,
 * a replica whose master is down, or a script it does not hold (ioredis sends EVAL on that one itself). Only these
 * codes, and only with no sign of the script in the message: a Lua script is not rolled back when it errors, and an
 * error raised inside one names it ("... script: <sha>, on @user_script:57."). pause-7.lua moves the jobs (RENAME) and
 * sets or deletes the meta `paused` field before its XADD to the events stream, so a WRONGTYPE there follows a switch
 * that already happened (measured: an events key holding a string, the queue paused, the reply an error), and an ACL
 * failure inside a script comes after the writes before it. The CLI's `pause` and `resume` and the console's switch
 * both judge by this one rule.
 */
export function refusedBeforeScript(error) {
	const message = String(error?.message ?? "");
	return error?.name === "ReplyError" && /^(NOPERM|READONLY|LOADING|BUSY|MASTERDOWN|NOSCRIPT)\b/.test(message) && !/user_script/.test(message);
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

// Read only the next candidates' stamps, never Job.data. LINDEX -1 is the next FIFO candidate (moveToActive-11.lua
// uses RPOPLPUSH); the priority head is ZRANGE 0 0 (moveJobFromPrioritizedToActive.lua uses ZPOPMIN).
const CONSUMER_DEMAND = `
local paused = redis.call("HEXISTS", KEYS[1], "${META_FIELD.paused}")
local cutoff = tonumber(ARGV[1]) - tonumber(ARGV[2])
local due = redis.call("ZRANGE", KEYS[4], 0, 0, "WITHSCORES")
local overdue = 0
if #due == 2 and math.floor(tonumber(due[2]) / ${DELAYED_SCORE_SHIFT}) < cutoff then overdue = 1 end
local waiting = redis.call("LINDEX", KEYS[2], -1)
local priority = redis.call("ZRANGE", KEYS[3], 0, 0)
for _, id in ipairs({waiting or "", priority[1] or ""}) do
  if id ~= "" then
    local stamp = tonumber(redis.call("HGET", ARGV[3] .. id, "${JOB_FIELD.timestamp}"))
    if stamp and stamp < cutoff then overdue = 1 end
  end
end
return {paused, overdue}
`;

export async function readConsumerDemand(redis, name, { now, graceMs }) {
	const keys = [QUEUE_KEY.meta, QUEUE_KEY.wait, QUEUE_KEY.prioritized, QUEUE_KEY.delayed].map((type) => queueKey(name, type));
	const result = await redis.eval(CONSUMER_DEMAND, keys.length, ...keys, now, graceMs, queueKey(name, ""));
	if (!Array.isArray(result) || result.length !== 2 || result.some((n) => n !== 0 && n !== 1)) return null;
	return { paused: result[0] === 1, overdue: result[1] === 1 };
}

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
