/**
 * The per-run budget ledger (issue #645, durable runs): a DURABLE record of every dollar hold a run has taken, so a
 * recovered run never reserves, settles or releases the same hold twice, and never releases a hold whose container
 * may still be alive.
 *
 * Why it exists: before #645 a dollar hold (`reserveDollars`'s `{ amountMicros, keys, ledgers }`) lived only in the
 * worker's memory. A worker that crashed between the reservation and the settlement left the hold counted at the
 * floor in every window it touched, which is the money-safe side, but the retry then reserved AGAIN, and nothing
 * anywhere remembered that the first hold existed. A recovery that wanted to release it could not know whether its
 * container was still running and spending under it.
 *
 * One hash per run, `run:budget:<sanitized run id>` (the run mirror's `sanitizeJobId`, so every per-run key of the
 * deployment spells a run the same way), with fields:
 *   - `slot`: "held" once the run's job-count slots are reserved (`claimSlot`), so a recovery carries them instead of
 *     reserving them a second time;
 *   - `seq`: the last container number handed out (`nextSeq`): attempt 1 is 1, attempt 2 is 2, a recovery's first
 *     container the next one. A container number is never reused, so a hold is addressed by it unambiguously;
 *   - `h<seq>`: the hold container `seq` ran under, as JSON, validated before it is written (`validHold`);
 *   - `s<seq>`: that hold's state, `held` and then exactly one of the terminal states `settled`, `released` or
 *     `settled-crashed`. A terminal state never changes again: every transition is one Lua script that moves a hold
 *     only FROM `held` (a compare-and-set, the idiom of dollar-budget.mjs's SETTLE_SCRIPT), so two racing callers
 *     cannot both move it, and nothing can move it back;
 *   - `at`: the injected clock at the last write, for doctor (how stale a ledger is), never for a decision.
 * The hash is PEXPIREd `ttlMs` (35 days by default, past the longest dollar window a hold can sit in: a month) on
 * every write, so a run that never reaches `remove` cannot leave it behind for ever.
 *
 * `settled-crashed` is the one state that needs a word. A crashed attempt's real spend is UNKNOWN: its transcript's
 * usage is agent-writable, so it cannot be trusted to settle down from. Its hold is therefore settled AT THE FLOOR:
 * the window keys already hold the whole reservation, so the settlement is bookkeeping only. Nothing is INCRBY'd and
 * nothing refunded; the state change only records that this hold is finished and must never be released, settled or
 * carried as a remainder by anyone. That is why this module never touches a `budget:usd:*` key itself.
 *
 * Every method NEVER throws on a Valkey failure (or on a client that throws synchronously): it logs the error's code
 * (`run_budget_ledger_error`, with the operation, never a run id, a key or a value) and returns `{ error }`, where
 * `error` is a short code. The caller decides; for every write that guards money the decision is an InfraRetry, and
 * the method's JSDoc says which. A bad argument (a seq that is not a positive integer, a hold of the wrong shape) is
 * also returned as `{ error }`, not thrown: the processor turns either into the same never-started retry, and a
 * TypeError escaping a budget path would be retried as an unknown failure instead.
 *
 * `redis` is any ioredis-compatible client with `eval`, `hgetall` and `del`, injected so the error paths are testable
 * with a fake; the transitions themselves are tested against a real Valkey, because the atomicity of the scripts is
 * the whole argument.
 */

import { DOLLAR_KEY_PREFIX } from "./dollar-budget.mjs";
import { sanitizeJobId } from "./run-history.mjs";

/** The key prefix of every run's budget ledger. */
export const RUN_BUDGET_KEY_PREFIX = "run:budget:";
/** The default TTL: 35 days, past a month window (the longest a hold's keys live), refreshed on every write. */
export const RUN_BUDGET_TTL_MS = 35 * 24 * 3600 * 1000;
/** The most window keys a recorded hold may carry: every ledger reserveDollars can be handed today fits well inside. */
export const RUN_BUDGET_MAX_KEYS = 16;
/** A hold's states. `held` is the only one a transition starts from; the other three are terminal. */
export const RUN_BUDGET_STATES = Object.freeze(["held", "settled", "released", "settled-crashed"]);

/** The ledger key of `runId`. */
export function runBudgetKeyFor(runId) {
	return `${RUN_BUDGET_KEY_PREFIX}${sanitizeJobId(runId)}`;
}

// claimSlot: set `slot` only when absent. Returns 1 when this call set it, 0 when it already existed. The TTL is
// refreshed either way: a recovery claiming a carried slot is activity on the run.
const CLAIM_SCRIPT = `local set = redis.call('HSETNX', KEYS[1], 'slot', 'held')
redis.call('HSET', KEYS[1], 'at', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return set`;

// recordHold: write `h<seq>` and `s<seq>` = held only when `s<seq>` is absent. A seq that already has a state (held or
// terminal) is never overwritten: overwriting a terminal state with `held` would let it be settled a second time.
const RECORD_SCRIPT = `if redis.call('HEXISTS', KEYS[1], 's' .. ARGV[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'h' .. ARGV[1], ARGV[2], 's' .. ARGV[1], 'held', 'at', ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1`;

// settle / release: `held` -> ARGV[2], only from `held`. HGET of an absent field is false in Lua, never 'held'.
const MOVE_SCRIPT = `if redis.call('HGET', KEYS[1], 's' .. ARGV[1]) ~= 'held' then return 0 end
redis.call('HSET', KEYS[1], 's' .. ARGV[1], ARGV[2], 'at', ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1`;

// settleCrashed: every `s<k>` == held with k < ARGV[1] becomes settled-crashed, in ONE script, so two recoveries that
// race see the holds once between them: the second runs after the first has moved them all and finds none. Returns
// the seqs it moved. The pattern is anchored and digits-only, so `slot` and `seq` (which also start with "s") never
// match. Nothing is written, and the TTL is not touched, when no hold moved: a ledger that has expired is not revived.
const CRASHED_SCRIPT = `local flat = redis.call('HGETALL', KEYS[1])
local below = tonumber(ARGV[1])
local moved = {}
for i = 1, #flat, 2 do
	local k = string.match(flat[i], '^s(%d+)$')
	if k and flat[i + 1] == 'held' and tonumber(k) < below then
		redis.call('HSET', KEYS[1], flat[i], 'settled-crashed')
		moved[#moved + 1] = tonumber(k)
	end
end
if #moved > 0 then
	redis.call('HSET', KEYS[1], 'at', ARGV[3])
	redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return moved`;

// nextSeq: HINCRBY and the TTL in one script, so a container number is never handed out on a key with no expiry.
const SEQ_SCRIPT = `local n = redis.call('HINCRBY', KEYS[1], 'seq', 1)
redis.call('HSET', KEYS[1], 'at', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return n`;

const isSeq = (n) => Number.isSafeInteger(n) && n >= 1;
const isDollarKey = (k) => typeof k === "string" && k.length > DOLLAR_KEY_PREFIX.length + 1 && k.length <= 256 && k.startsWith(`${DOLLAR_KEY_PREFIX}:`);
const isDollarPrefix = (p) => typeof p === "string" && p.length <= 256 && (p === DOLLAR_KEY_PREFIX || p.startsWith(`${DOLLAR_KEY_PREFIX}:`));

/**
 * The hold as it is stored, `{ amountMicros, keys, ledgers? }`, or `null` when `hold` is not the shape
 * `reserveDollars` returns: `amountMicros` a non-negative safe integer, `keys` an array of at most
 * `RUN_BUDGET_MAX_KEYS` distinct `budget:usd:*` keys, and `ledgers`, when present, `[{ keyPrefix, keys }]` whose keys
 * flatten, in order, to exactly `keys` (holdLedgers' grouping). Only those fields are kept: a hold is settled later by
 * exactly these keys, so anything else written beside them would be a field nobody validated.
 *
 * `ledgers` is optional because reserveDollars' zero-amount hold (`{ amountMicros: 0, keys: [] }`) carries none.
 */
export function validHold(hold) {
	if (!hold || typeof hold !== "object" || Array.isArray(hold)) return null;
	const { amountMicros, keys, ledgers } = hold;
	if (!Number.isSafeInteger(amountMicros) || amountMicros < 0) return null;
	if (!Array.isArray(keys) || keys.length > RUN_BUDGET_MAX_KEYS || !keys.every(isDollarKey)) return null;
	if (new Set(keys).size !== keys.length) return null;
	if (ledgers === undefined) return { amountMicros, keys: [...keys] };
	if (!Array.isArray(ledgers) || ledgers.length > RUN_BUDGET_MAX_KEYS) return null;
	const out = [];
	for (const l of ledgers) {
		if (!l || typeof l !== "object" || !isDollarPrefix(l.keyPrefix) || !Array.isArray(l.keys) || l.keys.length === 0) return null;
		out.push({ keyPrefix: l.keyPrefix, keys: [...l.keys] });
	}
	const flat = out.flatMap((l) => l.keys);
	if (flat.length !== keys.length || flat.some((k, i) => k !== keys[i])) return null;
	// Each ledger's keys sit under its own prefix: a hold whose model ledger names a deployment key is not reserveDollars'.
	if (!out.every((l) => l.keys.every((k) => k.startsWith(`${l.keyPrefix}:`)))) return null;
	return { amountMicros, keys: [...keys], ledgers: out };
}

/**
 * Build the ledger. `now` (ms since the epoch) stamps `at`; `ttlMs` is the hash's expiry, refreshed on every write;
 * `log(event, fields)` receives `run_budget_ledger_error` with `{ op, code }` and never a run id, a key or a value.
 * A `ttlMs` that is not a positive safe integer is a wiring defect and throws here, at construction, never per call.
 */
export function makeRunBudgetLedger({ redis, now = Date.now, ttlMs = RUN_BUDGET_TTL_MS, log = () => {} } = {}) {
	if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError("ttlMs must be a positive safe integer of milliseconds");
	const ttl = String(ttlMs);
	const at = () => String(now());

	async function attempt(op, fn) {
		try {
			return { value: await fn() };
		} catch (error) {
			const code = typeof error?.code === "string" ? error.code : "valkey";
			log("run_budget_ledger_error", { op, code });
			return { error: code };
		}
	}

	return {
		/**
		 * Claim the run's job-count slot: "new" when this call claimed it (the caller reserves the job-count ledgers, as
		 * every job did before #645), "carried" when an earlier attempt already had (a recovery skips reserveLedgers:
		 * the slot it would take is the one the crashed attempt is still counted in). `{ error }` on a Valkey fault: the
		 * caller cannot know which, so it reserves nothing and throws a never-started InfraRetry.
		 */
		async claimSlot(runId) {
			const r = await attempt("claimSlot", () => redis.eval(CLAIM_SCRIPT, 1, runBudgetKeyFor(runId), ttl, at()));
			if (r.error) return { error: r.error };
			return Number(r.value) === 1 ? "new" : "carried";
		},

		/**
		 * Record the hold container `seq` runs under, as `held`, only when that seq has no record yet.
		 *
		 * THE CONTRACT: a run.recover job never runs a container without a durable hold record. The caller reserves the
		 * dollars, calls this, and on ANY `{ error }` (`"bad-seq"`, `"bad-hold"`, `"exists"`, or a Valkey code) releases
		 * the hold it just reserved (`releaseDollars`) and throws a never-started InfraRetry; the container starts only
		 * after `{ ok: true }`. A hold that is not recorded is a hold a later recovery cannot see, so it could neither be
		 * settled at the floor nor kept from a double release. `"exists"` means the seq was already used, which only a
		 * caller that skipped `nextSeq` can cause; the recorded hold is left exactly as it was.
		 */
		async recordHold(runId, seq, hold) {
			if (!isSeq(seq)) return { error: "bad-seq" };
			const stored = validHold(hold);
			if (!stored) return { error: "bad-hold" };
			const r = await attempt("recordHold", () => redis.eval(RECORD_SCRIPT, 1, runBudgetKeyFor(runId), String(seq), JSON.stringify(stored), ttl, at()));
			if (r.error) return { error: r.error };
			return Number(r.value) === 1 ? { ok: true } : { error: "exists" };
		},

		/** `held` -> `settled` for container `seq`: "moved", or "not-held" when it is absent or already terminal. */
		settle(runId, seq) {
			return move("settle", runId, seq, "settled");
		},

		/**
		 * `held` -> `released` for container `seq`: "moved", or "not-held". Only "moved" licenses the caller to give the
		 * dollars back (`releaseDollars`): a "not-held" hold was already settled or released by someone else, and giving
		 * it back again would refund money twice.
		 */
		release(runId, seq) {
			return move("release", runId, seq, "released");
		},

		/**
		 * Settle at the floor every hold still `held` below container `belowSeq` (the holds of the run's earlier, crashed
		 * containers), in one atomic script: `{ settled: [seq, ...] }`, ascending, or `{ error }`. Bookkeeping only: the
		 * window keys keep the whole reservation, which is what a crashed attempt of unknown spend is charged.
		 *
		 * The CALLER MUST HAVE CONFIRMED those containers are dead before calling (the same host's boot reaper has
		 * removed them, or the running-jobs check shows none of the run's containers alive). A hold settled here can
		 * never be released, which is the safe direction, but a container still alive under it would keep spending
		 * against a hold that is already closed, and its own settlement would then find it "not-held".
		 *
		 * Exactly once: two recoveries racing each run the script whole, so the second sees the holds already moved and
		 * returns `{ settled: [] }`.
		 */
		async settleCrashed(runId, belowSeq) {
			if (!isSeq(belowSeq)) return { error: "bad-seq" };
			const r = await attempt("settleCrashed", () => redis.eval(CRASHED_SCRIPT, 1, runBudgetKeyFor(runId), String(belowSeq), ttl, at()));
			if (r.error) return { error: r.error };
			const settled = (Array.isArray(r.value) ? r.value : []).map(Number).sort((a, b) => a - b);
			return { settled };
		},

		/**
		 * The next container number of the run (attempt 1 is 1, attempt 2 is 2, a recovery's first container the next),
		 * or `{ error }`: the caller cannot record a hold without one, so it throws a never-started InfraRetry before
		 * reserving anything.
		 */
		async nextSeq(runId) {
			const r = await attempt("nextSeq", () => redis.eval(SEQ_SCRIPT, 1, runBudgetKeyFor(runId), ttl, at()));
			if (r.error) return { error: r.error };
			const n = Number(r.value);
			return isSeq(n) ? n : { error: "bad-reply" };
		},

		/**
		 * The ledger as `{ slot, seq, at, holds: [{ seq, state, amountMicros }] }` (holds ascending; `slot` null when not
		 * claimed; `amountMicros` null for a hold record that does not parse), `{ absent: true }` when there is none, or
		 * `{ error }`. For doctor and tests; no decision reads it, because a read followed by a write is exactly the race
		 * the scripts exist to avoid.
		 */
		async read(runId) {
			const r = await attempt("read", () => redis.hgetall(runBudgetKeyFor(runId)));
			if (r.error) return { error: r.error };
			const h = r.value && typeof r.value === "object" ? r.value : {};
			if (Object.keys(h).length === 0) return { absent: true };
			const holds = [];
			for (const [field, state] of Object.entries(h)) {
				const m = /^s(\d+)$/.exec(field);
				if (!m) continue;
				const seq = Number(m[1]);
				let amountMicros = null;
				try {
					const parsed = JSON.parse(h[`h${seq}`]);
					if (Number.isSafeInteger(parsed?.amountMicros)) amountMicros = parsed.amountMicros;
				} catch {
					// an unparseable record reads as an unknown amount; doctor says so rather than guessing
				}
				holds.push({ seq, state, amountMicros });
			}
			holds.sort((a, b) => a.seq - b.seq);
			const stamp = Number(h.at);
			return { slot: h.slot ?? null, seq: Number(h.seq) || 0, at: Number.isFinite(stamp) ? stamp : null, holds };
		},

		/** Delete the ledger at the run's final outcome: `{ ok: true }` or `{ error }` (the TTL removes it anyway). */
		async remove(runId) {
			const r = await attempt("remove", () => redis.del(runBudgetKeyFor(runId)));
			return r.error ? { error: r.error } : { ok: true };
		},
	};

	async function move(op, runId, seq, to) {
		if (!isSeq(seq)) return { error: "bad-seq" };
		const r = await attempt(op, () => redis.eval(MOVE_SCRIPT, 1, runBudgetKeyFor(runId), String(seq), to, ttl, at()));
		if (r.error) return { error: r.error };
		return Number(r.value) === 1 ? "moved" : "not-held";
	}
}
