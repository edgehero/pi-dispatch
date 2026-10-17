/**
 * The durable inbox of a running job (issue #646, INT-STEER-INBOX-CONTRACT, DES-STEER-TARGET-POINTER-IS-LIVENESS-NOT-INDEX).
 *
 * One module for every side that touches it: the worker's relay (registers the run, writes queued messages into the
 * read-only `/inbox` mount, marks them), the CLI and the console (push an operator's message, withdraw one, list them
 * without their text), and the receiver (PR 2: find a target's live runs and push a comment into each). Exported as
 * `@edgehero/pi-dispatch/steer-inbox`.
 *
 * KEYS (runId is `job.data.recoveryOf ?? job.id`, recovery-queue.mjs `runIdOf`, spelled through `sanitizeJobId`):
 *   run:steer:target:<sha256(kind\0repo\0targetType\0number) hex32>  ZSET runId -> expiresAtMs, PEXPIRE 60 s
 *   run:steer:open:<runId>          STRING host name, PX 30 s: the ONE authority on whether a run takes messages
 *   run:inbox:<runId>               LIST of entry JSON, append only
 *   run:inbox:state:<runId>         HASH id -> queued|written|delivered|withdrawn|late, plus `_bytes` and `_count`
 *   run:inbox:fallback:<runId>      HASH id -> the job the receiver would have enqueued (forge source, PR 2)
 *   run:inbox:closed:<runId>        STRING, set by the final close
 *
 * EVERY STATE CHANGE IS ONE LUA SCRIPT. Push, withdraw, close and the relay's mark are each a compare and set against
 * the state hash, run atomically by Valkey. The load-bearing one is the pair push and close: close sets `closed`,
 * drops the open key and the target member, turns every queued or written message into `late`, and returns the list,
 * all in one script, while push refuses on `closed` or a missing open key in its own. So a message is either in
 * close's reply (and the settle step answers it) or refused at push (and its sender is told): there is no interleaving
 * in which it is accepted and then silently never seen. A client-side read then write would have exactly that gap.
 *
 * NEVER THROWS. Every export returns a value or `{ error }`. A validation refusal is `{ error: "refused", reason }`,
 * whose reason is fit for an operator; a Valkey fault is `{ error: <code> }` and names no key or value. Callers must
 * fail loudly on either, never treat it as an empty inbox.
 *
 * CAPS. Two are per run and enforced inside the push script, so concurrent pushers cannot race past them: 16 messages
 * and 64 KiB of text (UTF-8 bytes). Two are per message and checked in JavaScript before Valkey is touched: 8 KiB of
 * text after the scrub, and 16 KiB for the framed inbox file (STEER_FILE_MAX_BYTES). Over a cap is refused, never cut:
 * a truncated message is one the person did not send. The run counters count every message ever accepted, withdrawn
 * ones too, so withdraw and push again cannot flood a run.
 */

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { ANSWER_TEXT_MAX_BYTES, boundAnswerText, scrubAnswerText } from "./console-answer.mjs";
import { TOKEN_NAME_RE } from "./console-tokens.mjs";
import { sanitizeJobId } from "./run-history.mjs";
// The author charsets come from the framing, so what the inbox accepts is exactly what the framing can attribute.
import { ASSOCIATION_RE, FORGE_USER_RE, STEER_FILE_MAX_BYTES, STEER_ID_RE, STEER_REF_WORST, steerFileJson } from "./steer-framing.mjs";

export const STEER_MAX_MESSAGES = 16;
/** The console answer's own bound: one rule for a person's text typed at the deployment, whatever it is for. */
export const STEER_TEXT_MAX_BYTES = ANSWER_TEXT_MAX_BYTES;
export const STEER_TOTAL_MAX_BYTES = 64 * 1024;
/** The inbox keys live an hour, refreshed by the relay while the run lives, so a crashed worker leaves no residue. */
export const STEER_INBOX_TTL_MS = 60 * 60 * 1000;
/** The open key's life: the relay refreshes it every 2 s, so 30 s of silence means the run is gone. */
export const STEER_OPEN_TTL_MS = 30 * 1000;
/** The target pointer's own expiry, twice a member's score horizon, so no live member outlives the ZSET it sits in. */
export const STEER_TARGET_TTL_MS = 60 * 1000;
export { STEER_ID_RE };
export const STEER_MODES = Object.freeze(["steer", "followUp"]);
export const STEER_SOURCES = Object.freeze(["forge", "console", "cli", "panel"]);
export const STEER_STATES = Object.freeze(["queued", "written", "delivered", "withdrawn", "late"]);

const DELIVERY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const HOST_MAX = 255;

const sha32 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const nowOf = (now) => (typeof now === "function" ? now() : now);
const isMs = (n) => Number.isSafeInteger(n) && n >= 0;
const validRunId = (runId) => (typeof runId === "string" && runId !== "") || (Number.isSafeInteger(runId) && runId >= 0);
const codeOf = (error) => (typeof error?.code === "string" && error.code !== "" ? error.code : "valkey");
const refused = (reason) => ({ error: "refused", reason });

/** The target pointer key for one forge target, or null when any part is missing or not plain. */
export function steerTargetKey({ kind, repo, targetType, number } = {}) {
	if (typeof kind !== "string" || kind === "" || typeof repo !== "string" || repo === "" || typeof targetType !== "string" || targetType === "") return null;
	const n = typeof number === "string" && /^[1-9][0-9]{0,15}$/.test(number) ? Number(number) : number;
	if (!Number.isSafeInteger(n) || n < 1) return null;
	return `run:steer:target:${sha32(`${kind}\0${repo}\0${targetType}\0${n}`)}`;
}

export function steerOpenKey(runId) {
	return `run:steer:open:${sanitizeJobId(runId)}`;
}

export function inboxKeys(runId) {
	const id = sanitizeJobId(runId);
	return { list: `run:inbox:${id}`, state: `run:inbox:state:${id}`, fallback: `run:inbox:fallback:${id}`, closed: `run:inbox:closed:${id}` };
}

/** A forge message's id: the delivery GUID's digest, so a redelivered webhook is the same message and pushes `dup`. */
export function forgeMessageId(deliveryId) {
	return typeof deliveryId === "string" && deliveryId !== "" ? sha32(`forge\0${deliveryId}`) : null;
}

/** An operator message's id: 16 random bytes. `randomBytes` is the seam. */
export function operatorMessageId(randomBytes = nodeRandomBytes) {
	return Buffer.from(randomBytes(16)).toString("hex");
}

/**
 * Characters a model reads and a person reviewing the text does not see, removed on the steer path on top of the
 * console answer's scrub: the Unicode tag block (U+E0000 to U+E007F, which spells hidden ASCII a model decodes), the
 * zero width space, non-joiner and joiner (U+200B to U+200D), the word joiner and the invisible operators (U+2060 to
 * U+2064), the Mongolian vowel separator (U+180E) and the byte order mark (U+FEFF). The cost is that an emoji built
 * with a zero width joiner arrives as its separate emoji; the meaning survives, hidden text does not.
 *
 * Kept on this path and not added to `scrubAnswerText`, whose output a parked answer's trail comment quotes on the
 * forge (where U+200B is the mention neutraliser itself); widening that function is a change to a shipped feature.
 */
const STEER_INVISIBLE_RE = /[\u{E0000}-\u{E007F}\u200b-\u200d\u2060-\u2064\u180e\ufeff]/gu;

/**
 * Backtick look-alikes folded to the ASCII backtick (U+FF40 fullwidth grave accent, U+02CB modifier letter grave,
 * U+1FEF Greek varia), so `fenceBlock` counts them in the run it must out-length and a row of them cannot read to the
 * model as a closing fence.
 *
 * WHY NOT NFKC. NFKC would fold these too, but it rewrites far more than look-alikes: it turns a CJK writer's fullwidth
 * punctuation into ASCII, ligatures and superscripts into letters and digits, and can lengthen text past the byte cap
 * it was measured under (one code point, U+FDFA, becomes eighteen). The framing promises the message verbatim; the
 * fence is defense in depth (placement as a user turn is the boundary), so the one look-alike class that touches the
 * fence is folded, and nothing else is rewritten.
 */
const BACKTICK_LOOKALIKE_RE = /[\uff40\u02cb\u1fef]/g;

/** The steer scrub: the console answer's rule, then the invisible characters removed and the look-alikes folded. */
export function scrubSteerText(raw) {
	return scrubAnswerText(raw).replace(STEER_INVISIBLE_RE, "").replace(BACKTICK_LOOKALIKE_RE, "`");
}

/** Whether a string holds an unpaired surrogate (malformed UTF-16, which UTF-8 cannot carry faithfully). */
const malformed = (s) => (typeof s.isWellFormed === "function" ? !s.isWellFormed() : /\p{Surrogate}/u.test(s));

/**
 * Bound a steer text: `{ text }` scrubbed (`scrubSteerText`) and within STEER_TEXT_MAX_BYTES, else `{ refusal }`. The
 * size and emptiness decision is `boundAnswerText`'s, run on the steer scrub's output (its own scrub is idempotent on
 * it), so the two features cannot disagree on what fits; the words are this feature's, since an answer's refusal says
 * "answer". An unpaired surrogate is refused rather than replaced: the text is malformed, and a U+FFFD the person never
 * typed is a message they did not send. No refusal ever quotes the text.
 */
export function boundSteerText(raw) {
	if (typeof raw === "string" && malformed(raw)) return { refusal: "the message is malformed text (it holds an unpaired UTF-16 surrogate); nothing was sent" };
	const text = scrubSteerText(raw);
	const bounded = boundAnswerText(text);
	if (!bounded.refusal) return bounded;
	if (text.trim() === "") return { refusal: "the message is empty (after control and invisible characters are removed); nothing was sent" };
	return { refusal: `the message is ${Buffer.byteLength(text, "utf8")} bytes, above the ${STEER_TEXT_MAX_BYTES}-byte limit; shorten it. Nothing was sent` };
}

/**
 * The entry as the inbox stores it, or `{ refusal }`. Only the contract's fields are kept; the source and the author
 * must agree (a forge source has a forge author, every other source an operator one), and the text is bounded and
 * scrubbed here, so whatever reaches Valkey is what the relay frames. A message whose inbox file would exceed
 * STEER_FILE_MAX_BYTES (a long backtick run lengthens the fence; quotes and backslashes double in JSON) is refused now,
 * because once accepted it could never be written.
 */
export function normalizeSteerEntry(entry, now = Date.now) {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { refusal: "the message is not an object" };
	if (typeof entry.id !== "string" || !STEER_ID_RE.test(entry.id)) return { refusal: "the message id is not 32 lowercase hex characters" };
	if (!STEER_MODES.includes(entry.mode)) return { refusal: `the mode is not one of ${STEER_MODES.join(", ")}` };
	if (!STEER_SOURCES.includes(entry.source)) return { refusal: `the source is not one of ${STEER_SOURCES.join(", ")}` };
	const a = entry.author;
	let author;
	if (entry.source === "forge") {
		const id = typeof a?.id === "number" ? String(a.id) : a?.id;
		if (a?.kind !== "forge" || typeof id !== "string" || !FORGE_USER_RE.test(id) || typeof a.association !== "string" || !ASSOCIATION_RE.test(a.association)) {
			return { refusal: "a forge message needs a forge author with a numeric user id and an association" };
		}
		author = { kind: "forge", id: Number(id), association: a.association };
	} else {
		if (a?.kind !== "operator" || typeof a.by !== "string" || !TOKEN_NAME_RE.test(a.by)) return { refusal: "an operator message needs an operator author named by a token-name word" };
		author = { kind: "operator", by: a.by };
	}
	const bounded = boundSteerText(entry.text);
	if (bounded.refusal) return { refusal: bounded.refusal };
	const at = entry.at === undefined ? nowOf(now) : entry.at;
	if (!isMs(at)) return { refusal: "the message time is not a millisecond timestamp" };
	const out = { v: 1, id: entry.id, mode: entry.mode, source: entry.source, author, text: bounded.text, at };
	if (entry.deliveryId !== undefined) {
		if (typeof entry.deliveryId !== "string" || !DELIVERY_ID_RE.test(entry.deliveryId)) return { refusal: "the delivery id is not a plain delivery GUID" };
		out.deliveryId = entry.deliveryId;
	}
	if (entry.hop !== undefined) {
		if (!Number.isSafeInteger(entry.hop) || entry.hop < 0 || entry.hop > 8) return { refusal: "the hop is not a small non-negative integer" };
		out.hop = entry.hop;
	}
	if (steerFileJson({ entry: out, ref: STEER_REF_WORST, forge: "x".repeat(16) }) === null) {
		return { refusal: `the message, framed for the run, would be above the ${STEER_FILE_MAX_BYTES}-byte inbox file limit (long runs of backticks, quotes and backslashes count extra); shorten it. Nothing was sent` };
	}
	return { entry: out };
}

// dup FIRST, before closed and gone: a redelivered webhook GUID of a message the run already holds is that message,
// whatever became of the run since (close answered it as late, or it was delivered). Saying `closed` instead would make
// the receiver enqueue its fallback job a second time for one comment.
// closed BEFORE gone: close also deletes the open key, and "the run has finished" is the truer of the two answers.
// KEYS: open, closed, list, state. ARGV: id, entry JSON, text bytes, max count, max bytes, ttl ms.
const PUSH_SCRIPT = `if redis.call('HEXISTS', KEYS[4], ARGV[1]) == 1 then return 'dup' end
if redis.call('EXISTS', KEYS[2]) == 1 then return 'closed' end
if redis.call('EXISTS', KEYS[1]) == 0 then return 'gone' end
local count = tonumber(redis.call('HGET', KEYS[4], '_count') or '0') or 0
local bytes = tonumber(redis.call('HGET', KEYS[4], '_bytes') or '0') or 0
local add = tonumber(ARGV[3])
if count + 1 > tonumber(ARGV[4]) or bytes + add > tonumber(ARGV[5]) then return 'full' end
redis.call('RPUSH', KEYS[3], ARGV[2])
redis.call('HSET', KEYS[4], ARGV[1], 'queued', '_count', count + 1, '_bytes', bytes + add)
redis.call('PEXPIRE', KEYS[3], ARGV[6])
redis.call('PEXPIRE', KEYS[4], ARGV[6])
return 'ok'`;

// queued or written -> withdrawn; anything else is left as it is. Returns the state it found (nil when unknown).
// KEYS: state. ARGV: id.
const WITHDRAW_SCRIPT = `local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur then return false end
if cur == 'queued' or cur == 'written' then redis.call('HSET', KEYS[1], ARGV[1], 'withdrawn') end
return cur`;

// The final close. KEYS: closed, open, list, state[, target]. ARGV: target member (the raw runId), ttl ms.
const CLOSE_SCRIPT = `redis.call('SET', KEYS[1], '1', 'PX', ARGV[2])
redis.call('DEL', KEYS[2])
if #KEYS >= 5 then redis.call('ZREM', KEYS[5], ARGV[1]) end
local st = redis.call('HGETALL', KEYS[4])
for i = 1, #st, 2 do
	local v = st[i + 1]
	if string.sub(st[i], 1, 1) ~= '_' and (v == 'queued' or v == 'written') then redis.call('HSET', KEYS[4], st[i], 'late') end
end
redis.call('PEXPIRE', KEYS[3], ARGV[2])
redis.call('PEXPIRE', KEYS[4], ARGV[2])
return {redis.call('LRANGE', KEYS[3], 0, -1), redis.call('HGETALL', KEYS[4])}`;

// Compare and set. KEYS: state. ARGV: id, to, from...
const MARK_SCRIPT = `local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur then return {0, false} end
for i = 3, #ARGV do
	if cur == ARGV[i] then
		redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
		return {1, cur}
	end
end
return {0, cur}`;

/** A flat HGETALL reply (or ioredis's object form) as `{ state, count, bytes }`: ids only in `state`. */
function stateOf(reply) {
	const pairs = Array.isArray(reply) ? reply.flatMap((v, i, all) => (i % 2 === 0 ? [[v, all[i + 1]]] : [])) : Object.entries(reply ?? {});
	const state = {};
	let count = 0;
	let bytes = 0;
	for (const [k, v] of pairs) {
		if (k === "_count") count = Number(v) || 0;
		else if (k === "_bytes") bytes = Number(v) || 0;
		else if (STEER_ID_RE.test(k) && STEER_STATES.includes(v)) state[k] = v;
	}
	return { state, count, bytes };
}

/** LRANGE reply to entries; a line that does not parse as an entry object is dropped, never surfaced as text. */
function entriesOf(list) {
	const out = [];
	for (const line of Array.isArray(list) ? list : []) {
		try {
			const e = JSON.parse(line);
			if (e && typeof e === "object" && typeof e.id === "string" && STEER_ID_RE.test(e.id)) out.push(e);
		} catch {}
	}
	return out;
}

/**
 * Push one message into a run's inbox: "ok", "dup", "closed", "gone" or "full", else `{ error }`. The text is bounded
 * and the entry validated before Valkey is touched (a free refusal goes first). `now` stamps `at` when the entry has
 * none.
 */
export async function pushSteer({ redis, runId, entry, now = Date.now } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	const norm = normalizeSteerEntry(entry, now);
	if (norm.refusal) return refused(norm.refusal);
	const k = inboxKeys(runId);
	const bytes = Buffer.byteLength(norm.entry.text, "utf8");
	try {
		const r = await redis.eval(PUSH_SCRIPT, 4, steerOpenKey(runId), k.closed, k.list, k.state, norm.entry.id, JSON.stringify(norm.entry), String(bytes), String(STEER_MAX_MESSAGES), String(STEER_TOTAL_MAX_BYTES), String(STEER_INBOX_TTL_MS));
		return ["ok", "dup", "closed", "gone", "full"].includes(r) ? r : { error: "bad-reply" };
	} catch (error) {
		return { error: codeOf(error) };
	}
}

/**
 * Withdraw one message: `{ prior }`, the state it was in. `queued` is a guaranteed withdrawal (the relay never wrote
 * it); `written` is best effort (the file was in the run's inbox, and the runner may have read it before the relay
 * unlinks it). Any other prior is left unchanged. `prior: null` means the run's inbox has no such message.
 */
export async function withdrawSteer({ redis, runId, id } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	if (typeof id !== "string" || !STEER_ID_RE.test(id)) return refused("the message id is not 32 lowercase hex characters");
	try {
		const r = await redis.eval(WITHDRAW_SCRIPT, 1, inboxKeys(runId).state, id);
		if (r === null || r === undefined) return { prior: null };
		return STEER_STATES.includes(r) ? { prior: r } : { error: "bad-reply" };
	} catch (error) {
		return { error: codeOf(error) };
	}
}

/**
 * The final close (settle, at a FINAL outcome only): `{ entries, state, count, bytes }` with every message the run
 * ever accepted, the formerly queued or written ones now `late`. After it every push is refused. `targetKey` is the
 * run's pointer, null for a run without one.
 */
export async function closeInbox({ redis, runId, targetKey = null } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	if (targetKey !== null && (typeof targetKey !== "string" || !targetKey.startsWith("run:steer:target:"))) return refused("the target key is not a steer target key");
	const k = inboxKeys(runId);
	const keys = [k.closed, steerOpenKey(runId), k.list, k.state, ...(targetKey ? [targetKey] : [])];
	try {
		const r = await redis.eval(CLOSE_SCRIPT, keys.length, ...keys, String(runId), String(STEER_INBOX_TTL_MS));
		if (!Array.isArray(r) || r.length !== 2) return { error: "bad-reply" };
		return { entries: entriesOf(r[0]), ...stateOf(r[1]) };
	} catch (error) {
		return { error: codeOf(error) };
	}
}

/**
 * Everything in the inbox, text included: `{ entries, state, count, bytes, closed }`. For the worker's relay only;
 * a surface that shows the inbox to a person uses `listInboxPublic`.
 */
export async function readInbox({ redis, runId } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	const k = inboxKeys(runId);
	try {
		const res = await redis.multi().lrange(k.list, 0, -1).hgetall(k.state).exists(k.closed).exec();
		if (!Array.isArray(res) || res.length !== 3) return { error: "bad-reply" };
		const failed = res.find(([err]) => err);
		if (failed) return { error: codeOf(failed[0]) };
		return { entries: entriesOf(res[0][1]), ...stateOf(res[1][1]), closed: Number(res[2][1]) === 1 };
	} catch (error) {
		return { error: codeOf(error) };
	}
}

/**
 * The inbox as a person may see it: `{ entries: [{ id, mode, source, state, at, bytes }], closed }`, NEVER the text
 * (the console state API and the CLI show it; INT-CONSOLE-STATE-API carries no attacker-chosen string).
 */
export async function listInboxPublic({ redis, runId } = {}) {
	const r = await readInbox({ redis, runId });
	if (r.error) return r;
	const entries = r.entries.map((e) => ({
		id: e.id,
		mode: STEER_MODES.includes(e.mode) ? e.mode : null,
		source: STEER_SOURCES.includes(e.source) ? e.source : null,
		state: r.state[e.id] ?? null,
		at: isMs(e.at) ? e.at : null,
		bytes: typeof e.text === "string" ? Buffer.byteLength(e.text, "utf8") : 0,
	}));
	return { entries, closed: r.closed };
}

/** One message's state: a STEER_STATES word, null when unknown, or `{ error }`. The CLI's poll. */
export async function messageState({ redis, runId, id } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	if (typeof id !== "string" || !STEER_ID_RE.test(id)) return refused("the message id is not 32 lowercase hex characters");
	try {
		const v = await redis.hget(inboxKeys(runId).state, id);
		if (v === null || v === undefined) return null;
		return STEER_STATES.includes(v) ? v : { error: "bad-reply" };
	} catch (error) {
		return { error: codeOf(error) };
	}
}

/**
 * The relay's compare and set: `{ ok, prior }`. `ok` is true only when the message was in one of `from` and is now
 * `to`; otherwise nothing changed and `prior` says what it is (null when unknown). Used for queued -> written,
 * written|queued -> delivered, delivered -> written when a retry re-baselines, withdrawn -> delivered when a verified
 * ack shows the agent received a message withdrawn too late, and any state -> late. The script allows any listed
 * transition; which ones are legitimate is the caller's rule, not this function's.
 */
export async function markState({ redis, runId, id, from, to } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	if (typeof id !== "string" || !STEER_ID_RE.test(id)) return refused("the message id is not 32 lowercase hex characters");
	if (!STEER_STATES.includes(to)) return refused("the target state is not a steer state");
	if (!Array.isArray(from) || from.length === 0 || !from.every((s) => STEER_STATES.includes(s))) return refused("the from states are not steer states");
	try {
		const r = await redis.eval(MARK_SCRIPT, 1, inboxKeys(runId).state, id, to, ...from);
		if (!Array.isArray(r)) return { error: "bad-reply" };
		const prior = r[1] === null || r[1] === undefined || r[1] === false ? null : r[1];
		return { ok: Number(r[0]) === 1, prior };
	} catch (error) {
		return { error: codeOf(error) };
	}
}

/**
 * Register a run as live, or refresh it (the relay calls this every 2 s): one MULTI that sets the open key (PX 30 s),
 * scores the run in its target's ZSET at `now + 30 s` (PEXPIRE 60 s, and drops members already expired so a target
 * steered by many runs over its life does not grow), and refreshes the inbox keys' hour. `targetKey` null for a run
 * no forge comment can reach (local, cron): the operator surfaces still find it by its open key. `{ ok: true }` or
 * `{ error }`.
 */
export async function registerLive({ redis, runId, targetKey = null, host, now = Date.now } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	if (targetKey !== null && (typeof targetKey !== "string" || !targetKey.startsWith("run:steer:target:"))) return refused("the target key is not a steer target key");
	if (typeof host !== "string" || host === "" || host.length > HOST_MAX) return refused("the host name is missing or too long");
	const t = nowOf(now);
	if (!isMs(t)) return refused("now is not a millisecond timestamp");
	const k = inboxKeys(runId);
	try {
		const m = redis.multi().set(steerOpenKey(runId), host, "PX", STEER_OPEN_TTL_MS);
		if (targetKey) m.zremrangebyscore(targetKey, "-inf", t).zadd(targetKey, t + STEER_OPEN_TTL_MS, String(runId)).pexpire(targetKey, STEER_TARGET_TTL_MS);
		m.pexpire(k.list, STEER_INBOX_TTL_MS).pexpire(k.state, STEER_INBOX_TTL_MS).pexpire(k.fallback, STEER_INBOX_TTL_MS);
		const res = await m.exec();
		if (!Array.isArray(res)) return { error: "bad-reply" };
		const failed = res.find(([err]) => err);
		if (failed) return { error: codeOf(failed[0]) };
		return { ok: true };
	} catch (error) {
		return { error: codeOf(error) };
	}
}

/** The relay's 2 s refresh: the same writes as `registerLive`, named apart so a log line says which. */
export function refreshLive(args) {
	return registerLive(args);
}

/**
 * The relay's exit: drop the run from its target and delete the open key. Not a close (an InfraRetry or a recovery
 * handoff leaves the inbox open for the next attempt); `closeInbox` is the final one.
 */
export async function unregisterLive({ redis, runId, targetKey = null } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	if (targetKey !== null && (typeof targetKey !== "string" || !targetKey.startsWith("run:steer:target:"))) return refused("the target key is not a steer target key");
	try {
		const m = redis.multi().del(steerOpenKey(runId));
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
 * The runs live on a target: at most `limit` runIds whose score (expiresAtMs) is after `now`, else `{ error }`. A
 * member whose relay stopped refreshing is ignored the moment its score passes, whatever the ZSET's own TTL says.
 */
export async function liveRunsForTarget({ redis, targetKey, now = Date.now, limit = 4 } = {}) {
	if (typeof targetKey !== "string" || !targetKey.startsWith("run:steer:target:")) return refused("the target key is not a steer target key");
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

/** Whether a run takes messages now: true or false, or `{ error }`. */
export async function isOpen({ redis, runId } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	try {
		return Number(await redis.exists(steerOpenKey(runId))) === 1;
	} catch (error) {
		return { error: codeOf(error) };
	}
}

/**
 * Store the job a forge message would have started had no run been live (PR 2's late branch A enqueues it). The job is
 * stored as JSON under the message id with the inbox's hour. `{ ok: true }` or `{ error }`.
 */
export async function storeFallback({ redis, runId, id, job } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	if (typeof id !== "string" || !STEER_ID_RE.test(id)) return refused("the message id is not 32 lowercase hex characters");
	let body;
	try {
		body = JSON.stringify(job);
	} catch {
		return refused("the fallback job does not serialise");
	}
	if (typeof body !== "string" || !job || typeof job !== "object") return refused("the fallback job is not an object");
	const k = inboxKeys(runId).fallback;
	try {
		const res = await redis.multi().hset(k, id, body).pexpire(k, STEER_INBOX_TTL_MS).exec();
		if (!Array.isArray(res)) return { error: "bad-reply" };
		const failed = res.find(([err]) => err);
		if (failed) return { error: codeOf(failed[0]) };
		return { ok: true };
	} catch (error) {
		return { error: codeOf(error) };
	}
}

/** Every stored fallback job, `{ jobs: { id: job } }` (a value that does not parse is dropped), or `{ error }`. */
export async function readFallbacks({ redis, runId } = {}) {
	if (!validRunId(runId)) return refused("no run id");
	try {
		const r = await redis.hgetall(inboxKeys(runId).fallback);
		const jobs = {};
		for (const [id, v] of Object.entries(r ?? {})) {
			if (!STEER_ID_RE.test(id)) continue;
			try {
				const job = JSON.parse(v);
				if (job && typeof job === "object") jobs[id] = job;
			} catch {}
		}
		return { jobs };
	} catch (error) {
		return { error: codeOf(error) };
	}
}
