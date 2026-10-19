/**
 * Held replies (issue #638, DES-AWAIT-INPUT-ENDS-THE-JOB, INT-STEER-INBOX-CONTRACT): an answer to a run that is parking
 * right now is never swallowed.
 *
 * THE GAP IT CLOSES. A run armed with `run.awaitInput` posts its question as a forge comment itself, and only then calls
 * the tool and ends. The processor parks it (promotes the session with the `parked` mark, releases the run's semantic
 * window, posts the fixed comment, sets the parked marker), and only from then on does a reply start a resumed job. A
 * person can answer in the seconds before that, and such a reply met one of two walls: deduplicated against the run
 * that still holds the window (the receiver answered `deduplicated` and nothing ran), or, on an issue without the
 * phrase, dropped by the filter because the marker was not on the issue yet (`no-trigger-phrase`). Both are held here
 * instead, and the run's park takes the first one as its resumed job (held-settle.mjs).
 *
 * ONE module for both sides, exported as `@edgehero/pi-dispatch/held-replies` the way steer-inbox.mjs is: the worker
 * registers its awaitInput runs live and settles them (held-settle.mjs), the receiver finds a target's live runs and
 * holds a reply under one. Light on purpose (no queue library, no processor), because the receiver imports it.
 *
 * KEYS OF THEIR OWN, NOT THE STEER INBOX. A held reply is not a steer: the run it waits on has stopped taking input (it
 * asked and is ending), and the job it becomes is a new run, never a message written into this one. Sharing
 * `run:steer:target:*` would put every awaitInput run in front of `trySteer`, which would push a phrase comment into an
 * inbox nothing reads (an awaitInput run need not be steer-armed); writing a held reply into `run:inbox:*` would let
 * the relay frame it as a steer for a run that is already gone. So the keys are spelled apart, and nothing that reads
 * one set reads the other (runId is `runIdOf(job)`, spelled through `sanitizeJobId`):
 *   run:await:target:<the same 32-hex hash steerTargetKey makes>  ZSET runId -> expiresAtMs, PEXPIRE 60 s
 *   run:await:open:<runId>        STRING host name, PX 30 s: the one authority on whether a run takes a held reply
 *   run:held:<runId>              LIST of entry JSON { id, at, route, fallback }, append only, PEXPIRE 1 h
 *   run:held:closed:<runId>       STRING, set by the settle's close, PX 1 h
 *   run:await:parked:<the same 32-hex hash>  STRING the run id, PX 60 s: set by the park's close, so a reply delivered
 *                                 after the run left its target is still routed as a parked reply
 * The target hash is the steer one's, derived from it (`awaitTargetKeyOf`), never spelled again: a key computed two
 * ways is a key that one day differs, and then a reply is held under a target no run registered.
 *
 * THE HOLD AND THE CLOSE ARE EACH ONE LUA SCRIPT, the steer inbox's push and close pair for its reason: `holdReply`
 * refuses `closed` once the close ran and `gone` once the run stopped refreshing, and `closeHeld` sets `closed`, drops
 * the liveness keys and returns the list in one step. So a reply is either in the close's reply (and the settle answers
 * it) or refused at the hold (and the receiver answers exactly as it did before this feature). There is no interleaving
 * in which a reply is accepted and then never seen.
 *
 * BOUNDED. At most HELD_MAX_ENTRIES per run, enforced in the script so concurrent receivers cannot race past it (the
 * oldest entry is evicted to make room), and HELD_ENTRY_MAX_BYTES per entry, checked before Valkey is touched: an entry
 * over it is refused, never cut, and the receiver falls back to today's answer.
 *
 * NEVER THROWS. Every export returns a value or `{ error }`: a validation refusal is `{ error: "refused", reason }`, a
 * Valkey fault `{ error: <code> }`, naming no key and no value.
 */

import { steerTargetOf } from "./inbox-relay.mjs";
import { sanitizeJobId } from "./run-history.mjs";
import { STEER_ID_RE } from "./steer-framing.mjs";

const STEER_TARGET_PREFIX = "run:steer:target:";
export const AWAIT_TARGET_PREFIX = "run:await:target:";
/** The open key's life: the keeper refreshes it every 2 s, so 30 s of silence means the run is gone. */
export const AWAIT_OPEN_TTL_MS = 30 * 1000;
/** The target pointer's own expiry, twice a member's score horizon (steer-inbox.mjs's STEER_TARGET_TTL_MS rule). */
export const AWAIT_TARGET_TTL_MS = 60 * 1000;
/**
 * The held list and the closed key live an hour, above the 10-minute semantic window (queue.mjs SEMANTIC_WINDOW_MS):
 * a reply can be held only while that window could swallow it, so an hour outlives every case, and a crashed worker
 * leaves no residue past it.
 */
export const HELD_TTL_MS = 60 * 60 * 1000;
/** The most replies one run holds: the first is started, the rest are answered once, so more buys nothing. */
export const HELD_MAX_ENTRIES = 20;
/**
 * The most one entry may weigh as JSON. The fallback job carries the comment and the issue's title and body (a forge
 * caps each near 64 K characters, so up to four times that in UTF-8, and JSON escaping can double it), so 1 MiB fits
 * any real delivery and still bounds a run at HELD_MAX_ENTRIES MiB.
 */
export const HELD_ENTRY_MAX_BYTES = 1024 * 1024;
export const HELD_ROUTES = Object.freeze(["dedup", "pre-label"]);
export const HELD_OUTCOMES = Object.freeze(["ok", "dup", "closed", "gone"]);
/**
 * How long a target says "a run just parked here" after the park's take closed its list (review round 2). A phrase-free
 * reply posted just before the label went on can be DELIVERED after the take, when the run is already off its target, so
 * the receiver finds no live run and the filter dropped it for the missing label: lost. While this marker stands the
 * receiver enqueues such a reply as an ordinary parked reply instead (it then coalesces against the taken job, or
 * resumes the parked session itself). A minute covers webhook delivery delay; after it the label is on, and the reply
 * routes normally.
 */
export const AWAIT_PARKED_TTL_MS = 60 * 1000;
export const AWAIT_PARKED_PREFIX = "run:await:parked:";

const HOST_MAX = 255;
const nowOf = (now) => (typeof now === "function" ? now() : now);
const isMs = (n) => Number.isSafeInteger(n) && n >= 0;
const validRunId = (runId) => (typeof runId === "string" && runId !== "") || (Number.isSafeInteger(runId) && runId >= 0);
const codeOf = (error) => (typeof error?.code === "string" && error.code !== "" ? error.code : "valkey");
const refused = (reason) => ({ error: "refused", reason });
const isAwaitTarget = (k) => typeof k === "string" && k.startsWith(AWAIT_TARGET_PREFIX) && /^[0-9a-f]{32}$/.test(k.slice(AWAIT_TARGET_PREFIX.length));

/**
 * The await target pointer for a job (job data as queued, `kind` included), or null for a local or cron job, a job with
 * no target number, or anything not plain. The steer target's hash with this module's prefix: derived, never spelled.
 */
export function awaitTargetKeyOf(job, { targetOf = steerTargetOf } = {}) {
	try {
		const { targetKey } = targetOf(job);
		if (typeof targetKey !== "string" || !targetKey.startsWith(STEER_TARGET_PREFIX)) return null;
		return `${AWAIT_TARGET_PREFIX}${targetKey.slice(STEER_TARGET_PREFIX.length)}`;
	} catch {
		return null;
	}
}

export function awaitOpenKey(runId) {
	return `run:await:open:${sanitizeJobId(runId)}`;
}

export function heldKeys(runId) {
	const id = sanitizeJobId(runId);
	return { list: `run:held:${id}`, closed: `run:held:closed:${id}` };
}

/**
 * The entry as the list stores it, or `{ refusal }`. Only the contract's fields, in a FIXED order with `id` first, so
 * the hold script can recognise a listed id by the JSON's prefix without parsing it in Lua. `fallback` is the job the
 * receiver would have enqueued (receiver/src/steer.mjs `fallbackJobOf`): it holds the comment and the issue text, which
 * is why this list is read by the settle alone and never shown on any surface.
 */
export function normalizeHeldEntry(entry, now = Date.now) {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { refusal: "the held reply is not an object" };
	if (typeof entry.id !== "string" || !STEER_ID_RE.test(entry.id)) return { refusal: "the held reply id is not 32 lowercase hex characters" };
	if (!HELD_ROUTES.includes(entry.route)) return { refusal: `the route is not one of ${HELD_ROUTES.join(", ")}` };
	const at = entry.at === undefined ? nowOf(now) : entry.at;
	if (!isMs(at)) return { refusal: "the held reply time is not a millisecond timestamp" };
	const fb = entry.fallback;
	if (!fb || typeof fb !== "object" || Array.isArray(fb)) return { refusal: "the fallback job is not an object" };
	const out = { id: entry.id, at, route: entry.route, fallback: fb };
	let json;
	try {
		json = JSON.stringify(out);
	} catch {
		return { refusal: "the fallback job does not serialise" };
	}
	if (typeof json !== "string") return { refusal: "the fallback job does not serialise" };
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes > HELD_ENTRY_MAX_BYTES) return { refusal: `the held reply is ${bytes} bytes, above the ${HELD_ENTRY_MAX_BYTES}-byte limit` };
	return { entry: out, json };
}

// closed FIRST: the close also deletes the open key, and "the run has settled" is the truer of the two answers. Then
// gone, then dup (an entry whose JSON starts with this id's prefix: a redelivered webhook GUID is the same reply).
// AT THE CAP THE OLDEST ENTRY GOES, never the new one (review round 2): the keeper registers a run for its whole pickup,
// so on a busy issue a long run's list fills with comments made long before the agent asked anything, and refusing the
// newest (`full`, the first version) refused exactly the one reply likely to be the answer. The oldest is the one the
// take's lookback would drop anyway (held-settle.mjs HELD_LOOKBACK_MS).
// KEYS: open, closed, list. ARGV: id prefix, entry JSON, max entries, ttl ms.
const HOLD_SCRIPT = `if redis.call('EXISTS', KEYS[2]) == 1 then return 'closed' end
if redis.call('EXISTS', KEYS[1]) == 0 then return 'gone' end
local items = redis.call('LRANGE', KEYS[3], 0, -1)
for i = 1, #items do
	if string.sub(items[i], 1, #ARGV[1]) == ARGV[1] then return 'dup' end
end
redis.call('RPUSH', KEYS[3], ARGV[2])
redis.call('LTRIM', KEYS[3], -tonumber(ARGV[3]), -1)
redis.call('PEXPIRE', KEYS[3], ARGV[4])
return 'ok'`;

/**
 * Hold one reply for a live run: "ok", "dup", "closed" or "gone", else `{ error }` (at the cap the oldest entry is evicted). Validated before Valkey is
 * touched. `ok` and `dup` mean the run's settle will see it; every other answer means it will not, and the caller
 * answers exactly as it did before held replies existed.
 */
export async function holdReply({ redis, runId, entry, now = Date.now } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	const norm = normalizeHeldEntry(entry, now);
	if (norm.refusal) return refused(norm.refusal);
	const k = heldKeys(runId);
	try {
		const r = await redis.eval(HOLD_SCRIPT, 3, awaitOpenKey(runId), k.closed, k.list, `{"id":"${norm.entry.id}"`, norm.json, String(HELD_MAX_ENTRIES), String(HELD_TTL_MS));
		return HELD_OUTCOMES.includes(r) ? r : { error: "bad-reply" };
	} catch (error) {
		return { error: codeOf(error) };
	}
}

// The settle's close. KEYS: closed, open, list[, target]. ARGV: target member (the raw runId), ttl ms. `first` says
// whether THIS call made the closing transition: a run settled twice (the processor, then BullMQ's failed listener for
// the same thrown failure) gets the list back both times, and only the first may act on it (steer-inbox.mjs's rule).
// KEYS[5], when present, is the target's parked marker, set in the same script as the close (the park's take only), so
// there is no instant in which the run is off its target and the marker is not yet up. ARGV[3]: its ttl ms.
const CLOSE_SCRIPT = `local first = 1 - redis.call('EXISTS', KEYS[1])
redis.call('SET', KEYS[1], '1', 'PX', ARGV[2])
redis.call('DEL', KEYS[2])
if #KEYS >= 4 then redis.call('ZREM', KEYS[4], ARGV[1]) end
if #KEYS >= 5 then redis.call('SET', KEYS[5], ARGV[1], 'PX', ARGV[3]) end
redis.call('PEXPIRE', KEYS[3], ARGV[2])
return {redis.call('LRANGE', KEYS[3], 0, -1), first}`;

/** The parked marker of an await target (`run:await:parked:<the same hex32>`), or null for anything else. */
export function awaitParkedKeyOf(targetKey) {
	return isAwaitTarget(targetKey) ? `${AWAIT_PARKED_PREFIX}${targetKey.slice(AWAIT_TARGET_PREFIX.length)}` : null;
}

/** Whether a run parked on this await target within AWAIT_PARKED_TTL_MS: true, false, or `{ error }`. */
export async function recentlyParked({ redis, targetKey } = {}) {
	const key = awaitParkedKeyOf(targetKey);
	if (key === null) return refused("the target key is not an await target key");
	try {
		return Number(await redis.exists(key)) === 1;
	} catch (error) {
		return { error: codeOf(error) };
	}
}

/** LRANGE reply to entries; a line that does not parse as an entry is dropped, never surfaced as text. */
function entriesOf(list) {
	const out = [];
	for (const line of Array.isArray(list) ? list : []) {
		try {
			const e = JSON.parse(line);
			if (e && typeof e === "object" && typeof e.id === "string" && STEER_ID_RE.test(e.id) && HELD_ROUTES.includes(e.route) && e.fallback && typeof e.fallback === "object") out.push(e);
		} catch {}
	}
	return out;
}

/**
 * The close (the park's take, else the settle at a FINAL outcome): `{ entries, first }`, every reply the run ever held, in the order held.
 * After it every hold is refused. `targetKey` is the run's await pointer, null for a run without one.
 */
export async function closeHeld({ redis, runId, targetKey = null, parked = false } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	if (targetKey !== null && !isAwaitTarget(targetKey)) return refused("the target key is not an await target key");
	const k = heldKeys(runId);
	// `parked` (the park's take): also raise the target's parked marker, in the same script.
	const keys = [k.closed, awaitOpenKey(runId), k.list, ...(targetKey ? [targetKey, ...(parked === true ? [awaitParkedKeyOf(targetKey)] : [])] : [])];
	try {
		const r = await redis.eval(CLOSE_SCRIPT, keys.length, ...keys, String(runId), String(HELD_TTL_MS), String(AWAIT_PARKED_TTL_MS));
		if (!Array.isArray(r) || r.length !== 2) return { error: "bad-reply" };
		return { entries: entriesOf(r[0]), first: Number(r[1]) === 1 };
	} catch (error) {
		return { error: codeOf(error) };
	}
}

// KEYS: list, closed. Acts only while `closed` exists, so no reply held for the new run can be in what it deletes.
const RESET_SCRIPT = `if redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
redis.call('DEL', KEYS[1], KEYS[2])
return 1`;

/**
 * Reset a CLOSED held list for a new run under the same run id (a console retry keeps the job id): the previous run is
 * settled and its replies answered, and while its `closed` stood every hold for the new run would be refused for an
 * hour. Called by the keeper before it registers, the steer relay's `resetClosedInbox` rule. `{ reset }` or `{ error }`.
 */
export async function resetClosedHeld({ redis, runId } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	const k = heldKeys(runId);
	try {
		return { reset: Number(await redis.eval(RESET_SCRIPT, 2, k.list, k.closed)) === 1 };
	} catch (error) {
		return { error: codeOf(error) };
	}
}

/**
 * Register a run as live on its await target, or refresh it (the keeper calls this every 2 s): ONE MULTI that sets the
 * open key (PX 30 s), scores the run in the target's ZSET at `now + 30 s` (PEXPIRE 60 s, members already expired
 * dropped) and keeps the held list's hour. `targetKey` null for a run no forge reply can reach: nothing to register,
 * so `{ ok: true }` without a call. `{ ok: true }` or `{ error }`.
 */
export async function registerAwaitLive({ redis, runId, targetKey, host, now = Date.now } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	if (targetKey === null || targetKey === undefined) return { ok: true };
	if (!isAwaitTarget(targetKey)) return refused("the target key is not an await target key");
	if (typeof host !== "string" || host === "" || host.length > HOST_MAX) return refused("the host name is missing or too long");
	const t = nowOf(now);
	if (!isMs(t)) return refused("now is not a millisecond timestamp");
	try {
		const res = await redis
			.multi()
			.set(awaitOpenKey(runId), host, "PX", AWAIT_OPEN_TTL_MS)
			.zremrangebyscore(targetKey, "-inf", t)
			.zadd(targetKey, t + AWAIT_OPEN_TTL_MS, String(runId))
			.pexpire(targetKey, AWAIT_TARGET_TTL_MS)
			.pexpire(heldKeys(runId).list, HELD_TTL_MS)
			.exec();
		if (!Array.isArray(res)) return { error: "bad-reply" };
		const failed = res.find(([err]) => err);
		if (failed) return { error: codeOf(failed[0]) };
		return { ok: true };
	} catch (error) {
		return { error: codeOf(error) };
	}
}

/** The keeper's 2 s refresh: the same writes as `registerAwaitLive`, named apart so a log line says which. */
export function refreshAwaitLive(args) {
	return registerAwaitLive(args);
}

/** Drop the run from its target and delete the open key, now. Not a close: the held list stays for the settle. */
export async function unregisterAwaitLive({ redis, runId, targetKey = null } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	if (targetKey !== null && !isAwaitTarget(targetKey)) return refused("the target key is not an await target key");
	try {
		const m = redis.multi().del(awaitOpenKey(runId));
		if (targetKey) m.zrem(targetKey, String(runId));
		const res = await m.exec();
		if (!Array.isArray(res)) return { error: "bad-reply" };
		const failed = res.find(([err]) => err);
		if (failed) return { error: codeOf(failed[0]) };
		return { ok: true };
	} catch (error) {
		return { error: codeOf(error) };
	}
}

/**
 * The awaitInput runs live on a target: at most `limit` runIds whose score is after `now`, else `{ error }`. A member
 * whose keeper stopped refreshing is ignored the moment its score passes, whatever the ZSET's own TTL says.
 */
export async function liveAwaitRunsForTarget({ redis, targetKey, now = Date.now, limit = 4 } = {}) {
	if (!isAwaitTarget(targetKey)) return refused("the target key is not an await target key");
	const t = nowOf(now);
	if (!isMs(t)) return refused("now is not a millisecond timestamp");
	const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 64) : 4;
	try {
		const r = await redis.zrangebyscore(targetKey, `(${t}`, "+inf", "LIMIT", 0, n);
		return Array.isArray(r) ? r.filter((m) => typeof m === "string" && m !== "") : { error: "bad-reply" };
	} catch (error) {
		return { error: codeOf(error) };
	}
}
