/**
 * The worker's half of "why does this job wait" (issue #737): every gate that puts a job back on the delayed set
 * writes its reason into `defer:job:<id>` (`defer-reasons.mjs` holds the vocabulary and the field rules) just before
 * BullMQ's move, through ONE function, `deferTo`, so no deferral can move a job without saying why. A retry after an
 * infrastructure failure, which BullMQ delays by itself after the processor throws, is noted by `noteRetry` before
 * the throw. Worker-only, and free of bullmq itself: the processor hands it BullMQ's `DelayedError` class (index.mjs
 * imports bullmq; `valkey-clients.test.mjs` keeps every other module from naming that library), so the throw is the
 * very class the processor's own catch tells a deferral apart by. The admin console never loads it (it reads the leaf).
 *
 * THE RECORD IS ADVISORY, so it FAILS OPEN and is BOUNDED. A deferral never fails or changes for its reason, and waits
 * for it at most `DEFER_WRITE_TIMEOUT_MS` (2 s): a write that fails or takes longer is logged once per episode and the
 * job is moved all the same, and a logger that throws is swallowed rather than rejecting the deferral. The bound is not
 * decoration: the worker's client queues commands during an outage rather than rejecting them
 * (`maxRetriesPerRequest: null`, the host registry's reason), so an unbounded write would hold a gate's deferral for
 * the whole outage. The move itself is BullMQ's, exactly as it was before this file.
 *
 * WRITE, THEN MOVE. A reader starts from the delayed set and looks up the records of the ids it finds there, so a
 * record written before the move is in place the moment the job is delayed, and one for a job that is still active
 * is never read. The write is one MULTI (`DEL`, `HSET`, `PEXPIRE`), so a reader never sees this deferral's fields
 * mixed with an earlier one's, and every record carries a TTL (`deferTtlMs`: the due time plus a minute's slack,
 * so the record outlives the promotion and the pickup that follows it).
 *
 * A MOVE THAT REJECTS (a lost lock, Valkey gone) leaves a record for a job that is not delayed, so its own record is
 * removed by a compare-and-delete on the writer's nonce (`n`): a plain DEL could remove the record another worker
 * wrote for a later deferral of the same job id. The rejection is rethrown unchanged, so it reaches BullMQ's
 * failed-attempt handling exactly as a raw `moveToDelayed` rejection always has.
 *
 * A TIMED-OUT WRITE MAY STILL LAND. The bound stops the waiting, not the command: a queued MULTI runs when the
 * connection comes back. That is why a timed-out write still returns its nonce: the compare-and-delete is sent on
 * the same connection after it, so it runs after the MULTI if that lands at all. A record that lands for a job that
 * then ran is not read while the job is not delayed, and expires with its TTL.
 *
 * WHAT A RECORD CANNOT PROMISE. A write that failed leaves the previous deferral's record, until it expires, beside a
 * job now delayed for another reason; and a job BullMQ delays by itself (a move's rejection retried, a backoff
 * `retryDelayOf` cannot know) gets no fresh record. Both show as a record whose `until` is not the job's due time in
 * the delayed set, which is how a reader tells a record that describes the wait from one that does not.
 */
import { randomBytes } from "node:crypto";
import { DEFER_N_RE, DEFER_WHY_RE, deferHsetArgs, deferKey, deferTtlMs } from "./defer-reasons.mjs";

/** How long a gate waits for its reason's write, and a failed move for its compare-and-delete, before going on. */
export const DEFER_WRITE_TIMEOUT_MS = 2_000;

/** Delete the record only while it still carries this writer's nonce: never another worker's later record. */
export const DEFER_CAD_LUA = "if redis.call('HGET', KEYS[1], 'n') == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

/**
 * The delay BullMQ will put on this job's retry after the current attempt throws, in ms, or null when it will not
 * retry it on a delay this function can know. Mirrors the pinned BullMQ's `shouldRetryJob` and its builtin backoff
 * strategies (job.js, backoffs.js at 5.80.4): it retries while `attemptsMade + 1 < opts.attempts` and the job is not
 * discarded; a number is a `fixed` backoff; `fixed` waits `delay`, `exponential` waits `round(2^attemptsMade * delay)`
 * (BullMQ calls the strategy with `attemptsMade + 1` and raises 2 to one less).
 *
 * Null for everything else, never a guess: a jittered backoff (its delay is random, so no instant could be told), a
 * custom strategy (it is the queue's code), and a delay at or below zero (BullMQ then retries at once, through the
 * wait list rather than the delayed set).
 */
export function retryDelayOf(job) {
	const attempts = job?.opts?.attempts;
	const made = job?.attemptsMade;
	if (!Number.isInteger(attempts) || !Number.isInteger(made) || made < 0) return null;
	if (!(made + 1 < attempts) || job.discarded === true) return null;
	const raw = job.opts.backoff;
	const backoff = Number.isFinite(raw) ? { type: "fixed", delay: raw } : raw;
	if (backoff === null || typeof backoff !== "object") return null;
	// BullMQ's own test (`jitter > 0`), so a value it ignores is ignored here too.
	if (backoff.jitter > 0) return null;
	const delay = backoff.delay;
	if (!Number.isFinite(delay) || delay <= 0) return null;
	if (backoff.type === "fixed") return delay;
	if (backoff.type === "exponential") return Math.round(2 ** made * delay);
	return null;
}

/** Settle `promise` or give up after `ms`, never rejecting: `{ value }`, `{ error }` or `{ timedOut: true }`. */
function settleWithin(promise, ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve({ timedOut: true }), ms);
		Promise.resolve(promise).then(
			(value) => {
				clearTimeout(timer);
				resolve({ value });
			},
			(error) => {
				clearTimeout(timer);
				resolve({ error });
			},
		);
	});
}

/** A failure's name for the log: a fixed word or an errno-like code, never an error's message (it can quote a URL). */
function failureOf(outcome) {
	if (outcome.timedOut) return "timeout";
	if (outcome.threw) return "threw";
	if (outcome.error) return typeof outcome.error.code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(outcome.error.code) ? outcome.error.code : "rejected";
	return "error-reply";
}

/**
 * Build the writer for one processor. `redis` is the processor's client; `DelayedError` is BullMQ's class (required:
 * a stand-in would pass BullMQ's name test and fail the processor's `instanceof`, so a deferral would read as a
 * failure there); `hostName` is this worker's declared name, recorded as the record's host when it passes the host
 * rule; `now` is the processor's clock, the one every gate's due time is computed from.
 *
 * Returns:
 *   - `writeReason(job, { why, untilMs, atMs, project, holder, endpoint, budgetWhy, attempt, attempts })`: the record's
 *     write, bounded. `atMs` is the record's `at`, by default the clock when the write is built; a caller that measured
 *     `untilMs` from its own reading passes that reading, so the two are exactly the delay apart. Resolves `{ n }` once
 *     the MULTI was sent (it landed, or may still land: see the header) and null when nothing was sent: a client with
 *     no `multi` (a bare test wiring), a job with no id, or a write that could not be built. Never rejects. `why` must
 *     be a reason of `DEFER_WHYS`; any other field that fails its rule is left out of the record rather than failing it.
 *   - `deferTo(job, token, untilMs, why, extra)`: the one deferral. Writes the reason, then `job.moveToDelayed(untilMs,
 *     token)`, then throws BullMQ's `DelayedError`, the throw by which BullMQ learns the job was deferred. NEVER
 *     returns. A rejected move removes this write's record and is rethrown unchanged.
 *   - `noteRetry(job, { project })`: before an infrastructure retry's throw, the `retry` record, when BullMQ will
 *     delay the retry by a known amount (`retryDelayOf`). Never throws.
 *
 * The log says `defer_reason_unwritten { why, reason }` on the first failed write and nothing more until a write
 * succeeds again, which says `defer_reason_restored { why }` once: an outage is one episode, not a line per wake.
 */
export function makeDeferTo({ redis, DelayedError, now = () => Date.now(), hostName = "", log = () => {}, nonce = () => randomBytes(8).toString("hex"), timeoutMs = DEFER_WRITE_TIMEOUT_MS } = {}) {
	if (typeof DelayedError !== "function") throw new TypeError("makeDeferTo needs BullMQ's DelayedError class, the one the processor's catch recognises a deferral by");
	let failing = false;
	const said = (why) => (typeof why === "string" && DEFER_WHY_RE.test(why) ? why : null);
	// Every line goes through `say`, so a logger that throws is swallowed here: the log describes a deferral, and a line
	// that could not be written must not turn the deferral into a rejection before its move (the job left active, BullMQ
	// counting a failed attempt). The episode's state is set before the line, so it holds even when the line is lost.
	const say = (event, fields) => {
		try {
			log(event, fields);
		} catch {
			// The line is lost, the deferral goes on.
		}
	};
	const failed = (why, outcome) => {
		if (failing) return;
		failing = true;
		say("defer_reason_unwritten", { why: said(why), reason: failureOf(outcome) });
	};
	const succeeded = (why) => {
		if (!failing) return;
		failing = false;
		say("defer_reason_restored", { why: said(why) });
	};

	const writeReason = async (job, { why, untilMs, atMs, project = null, holder, endpoint, budgetWhy, attempt, attempts } = {}) => {
		if (typeof redis?.multi !== "function") return null;
		if (typeof job?.id !== "string" || job.id === "") return null;
		let sent;
		let n = null;
		try {
			const at = Number.isFinite(atMs) ? Math.floor(atMs) : now();
			const drawn = nonce();
			n = typeof drawn === "string" && DEFER_N_RE.test(drawn) ? drawn : null;
			// Whole milliseconds: the record's rule takes integers, and a gate's arithmetic (a jittered delay, a keeper's
			// wait) need not produce one.
			const until = Number.isFinite(untilMs) ? Math.floor(untilMs) : null;
			const args = deferHsetArgs({ why, at, until, project, host: hostName, holder, endpoint, budgetWhy, trigger: job.data?.trigger?.matched?.index, attempt, attempts, n });
			const key = deferKey(job.id);
			const ttl = Math.ceil(deferTtlMs(until ?? at, at));
			sent = redis.multi().del(key).hset(key, ...args).pexpire(key, ttl).exec();
		} catch (error) {
			// Nothing was sent: a client whose transaction could not be built, or a reason outside the table (a defect at
			// the call site, which `defer-write.test.mjs` pins by literal).
			failed(why, { threw: true, error });
			return null;
		}
		const outcome = await settleWithin(sent, timeoutMs);
		const replies = outcome.value;
		const errorReply = Array.isArray(replies) ? replies.some((reply) => Array.isArray(reply) && reply[0]) : replies !== undefined;
		if (outcome.timedOut || outcome.error || errorReply) failed(why, outcome);
		else succeeded(why);
		return { n };
	};

	const deferTo = async (job, token, untilMs, why, extra = {}) => {
		const written = await writeReason(job, { ...extra, why, untilMs });
		try {
			await job.moveToDelayed(untilMs, token);
		} catch (error) {
			if (written?.n && typeof redis?.eval === "function") {
				let removal;
				try {
					removal = redis.eval(DEFER_CAD_LUA, 1, deferKey(job.id), written.n);
				} catch {
					removal = null;
				}
				await settleWithin(removal, timeoutMs);
			}
			throw error;
		}
		throw new DelayedError();
	};

	const noteRetry = async (job, { project = null } = {}) => {
		try {
			const delay = retryDelayOf(job);
			if (delay === null) return;
			const at = now();
			await writeReason(job, { why: "retry", untilMs: at + delay, atMs: at, project, attempt: job.attemptsMade + 2, attempts: job.opts.attempts });
		} catch {
			// Never in the way of the throw it precedes: the retry happens whether or not its reason was written.
		}
	};

	return { writeReason, deferTo, noteRetry };
}
