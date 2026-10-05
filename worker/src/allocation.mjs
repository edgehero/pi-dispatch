/**
 * Delegated allocation, the stateful half (issue #504 part B; DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE,
 * REQ-DELEGATED-ALLOCATION). `priorities.mjs` is the arithmetic and `envelope.mjs` the operator's file; this module
 * holds the APPLIED split in Valkey, applies a plan under the ladder, writes the audit, and turns the split into the
 * dollar ledgers a job reserves in.
 *
 * Valkey keys:
 *   - `alloc:plan` (`ALLOC_PLAN_KEY`): the applied state as JSON, the effective micro-dollar vector a job reserves
 *     against and the "current" of the next step. Always present once any host has looked: the neutral state (the
 *     envelope's default weights, no plan) is PERSISTED with `SET NX`, writer `default`, so a reference always exists.
 *   - `alloc:lock` (`ALLOC_LOCK_KEY`): `SET NX PX 5000`, the `fleet-lease.mjs` idiom, released only by its holder. It
 *     exists ONLY so a concurrent apply refuses as `plan-busy`; it is not what keeps two writes apart.
 *   - `alloc:envelope:expected` (`ALLOC_EXPECTED_KEY`): the envelope digest the operator's admin writer stores before
 *     it writes the file (issue #504 part C). A host re-bases the fleet only when its own digest equals it.
 *   - `alloc:log` (`ALLOC_LOG_KEY`): a VIEW, `LPUSH` then `LTRIM` to `ALLOC_LOG_MAX`, of the audit rows without reasons.
 *
 * EVERY change of `alloc:plan` is a compare-and-set (`CAS_SCRIPT`): a Lua script that compares the stored plan id and
 * envelope digest with the ones the writer read, and writes in the same step. A lock alone would not do: a lock that
 * expires mid-write lets a second writer overwrite the first with no error, while a CAS makes the write itself the
 * check. Expiry (writer `expiry`), a re-base (`envelope-change`) and a revert (`operator-revert`) go through it too.
 *
 * The audit FILE is the record (`PI_LOGS_DIR/allocations/YYYY-MM.jsonl` on the host that acted, appended with
 * O_APPEND). For a plan or a revert the row is written FIRST, then the CAS, and a CAS that fails then adds an
 * `apply-failed` row: a writer's change never exists without its row, and a row whose change did not happen is
 * followed by the row that says so (unless the CAS itself throws, when that second row is not written: a named gap).
 * For the system's own changes (the neutral seed, expiry, a re-base) only the CAS winner writes, after it won, so two
 * hosts that see one expired plan write exactly one `expired` row; a row the file then refuses is lost (the change is
 * done and a retry cannot write it back), logged as `allocation_audit_row_lost` and still pushed to `alloc:log`.
 *
 * Reasons are agent text. They live in `alloc:plan` and the audit file only, never in `alloc:log`, a tool result, a
 * run record or a log line.
 */

import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { isAbsolute, join } from "node:path";
import { envelopeDigest } from "./envelope.mjs";
import { RELEASE_IF_MINE } from "./fleet-lease.mjs";
import { OTHER, allocate, envelopeEntries, neutralAllocation, parsePlan, planRefusal, rebase, repoShares, scopeRef } from "./priorities.mjs";
import { dollarCapsFor, scopeDollarKeyPrefix } from "./scoped-limits.mjs";

export const ALLOC_PLAN_KEY = "alloc:plan";
export const ALLOC_LOCK_KEY = "alloc:lock";
export const ALLOC_LOG_KEY = "alloc:log";
export const ALLOC_EXPECTED_KEY = "alloc:envelope:expected";
/** How many outcomes `alloc:log` keeps, newest first. A view; the files keep everything their retention allows. */
export const ALLOC_LOG_MAX = 500;
/** The lock's life. Long enough for one apply's GET, compute, file append and CAS; short enough that a crash frees it. */
export const ALLOC_LOCK_MS = 5000;
/** The state record's shape version. */
export const ALLOC_STATE_VERSION = 1;

/**
 * What a host publishes as `fpEnvelope` (INT-HOST-REGISTRY-CONTRACT) with no envelope: a name, never empty, so doctor can
 * tell a host without an envelope from a worker too old to publish the field.
 */
export const NO_ENVELOPE_FINGERPRINT = "none";

/** The refusal reason of a full window whose binding cap came from the allocation (or the envelope total). */
export const ALLOCATION_CAP_REASON = "allocation-cap";
/** The free pre-spend refusal of a host whose envelope digest is not the applied plan's. */
export const ENVELOPE_MISMATCH_REASON = "envelope-mismatch";

/** Who changed the state: the two plan writers, the operator's revert, and the system's own three. */
export const STATE_WRITERS = Object.freeze(["default", "expiry", "envelope-change", "operator-revert", "operator-session", "portfolio-job"]);
/** What an audit row says happened. */
export const AUDIT_OUTCOMES = Object.freeze(["applied", "duplicate", "refused", "apply-failed", "neutral", "expired", "rebased", "reverted", "envelope-changed-externally"]);

/**
 * The compare-and-set. KEYS[1] `alloc:plan`; ARGV[1] the plan id the writer read (`""` for none), ARGV[2] the envelope
 * digest it read, ARGV[3] the new state. Writes and returns 1 only when the stored state still has both; else 0. A
 * stored value that does not decode is never overwritten here (`SEED_SCRIPT` is for that).
 */
export const CAS_SCRIPT = `local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local ok, s = pcall(cjson.decode, cur)
if not ok or type(s) ~= 'table' then return 0 end
local id = s['planId']
if type(id) ~= 'string' then id = '' end
if id ~= ARGV[1] then return 0 end
if s['envelopeDigest'] ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[3])
return 1`;

/**
 * The neutral seed and its expected digest, in ONE step. KEYS[1] `alloc:plan`, KEYS[2] `alloc:envelope:expected`;
 * ARGV[1] the seed, ARGV[2] its envelope digest, ARGV[3] `nx` (no state: `SET NX`) or `eq` (a state that does not
 * decode: replace it only while it is still exactly ARGV[4]). A FRESH seed (`nx`) sets `expected` to its digest
 * UNCONDITIONALLY: a stale `expected` left by an earlier split (deleted with `alloc:plan` alone) must not survive a new
 * seed, or a host carrying that old envelope would re-base the fleet onto it. A REPLACEMENT (`eq`) sets it only when it
 * is absent: the plan was there and unreadable, so the `expected` beside it still names the fleet's envelope, and a
 * stale host that happens to reconcile first must not take the fleet. Returns 1 when the seed landed, else 0.
 */
export const SEED_SCRIPT = `if ARGV[3] == 'nx' then
  if redis.call('SET', KEYS[1], ARGV[1], 'NX') then redis.call('SET', KEYS[2], ARGV[2]) return 1 end
  return 0
end
if redis.call('GET', KEYS[1]) == ARGV[4] then
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('SET', KEYS[2], ARGV[2], 'NX')
  return 1
end
return 0`;

function iso(now) {
	return new Date(now instanceof Date ? now.getTime() : now).toISOString();
}

function nowMs(now) {
	return now instanceof Date ? now.getTime() : now;
}

/** A state's vector, as `allocate` and `rebase` take it. */
function vectorOf(state) {
	return { allocations: { ...(state?.allocations ?? {}) }, unallocated: state?.unallocated ?? 0 };
}

/** The micro-dollars of a state, for an audit row's `before` and `after`: amounts only, never a reason. */
function amountsOf(state) {
	if (!state) return null;
	return { allocations: { ...(state.allocations ?? {}) }, unallocated: state.unallocated ?? 0, repos: state.repos ?? {} };
}

/**
 * The neutral state of an envelope: its default weights, no step, no plan. `writer` is `default` for the seed and
 * `expiry` or `envelope-change` when a plan gives way to it. `lastPlanAt` carries over from the state it replaces
 * (null for the seed), so neutral never starts an interval of its own.
 */
export function neutralState(envelope, digest, now, { writer = "default", lastPlanAt = null } = {}) {
	const n = neutralAllocation(envelope);
	return {
		version: ALLOC_STATE_VERSION,
		planId: null,
		basis: null,
		writer,
		jobId: null,
		triggerId: null,
		appliedAt: iso(now),
		lastPlanAt,
		validUntil: null,
		envelopeDigest: digest,
		weights: { ...envelope.defaultWeights },
		repoWeights: {},
		reasons: {},
		allocations: n.allocations,
		unallocated: n.unallocated,
		repos: {},
		clamped: false,
	};
}

/** A safe, non-negative integer of micro-dollars: the only amount a state may hold. */
function isMicros(value) {
	return Number.isSafeInteger(value) && value >= 0;
}

/** Every amount of a state is micro-dollars: the allocations, the unallocated money and each repo share. */
function amountsAreMicros(s) {
	const values = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.values(o) : null);
	const allocations = values(s.allocations);
	// Every vector carries `_other` (envelope.mjs always adds it), so an allocations object without it is no vector.
	if (!allocations || !allocations.every(isMicros) || !Object.hasOwn(s.allocations, OTHER)) return false;
	if (!isMicros(s.unallocated ?? 0)) return false;
	const repos = values(s.repos ?? {});
	return repos !== null && repos.every((r) => values(r)?.every(isMicros) === true);
}

/**
 * Parse a stored state. Null when absent; the state when it is this build's version with a digest and amounts that
 * are all safe non-negative integers of micro-dollars; `{ newer: true }` for a state a NEWER build wrote (version above
 * `ALLOC_STATE_VERSION`), which this build neither trusts nor overwrites; else `{ corrupt: text }`, which the next
 * reconcile replaces with the neutral split. A string, a negative, a fraction or a missing allocation is corrupt: an
 * amount the reserve would compare against as a number it is not.
 */
export function parseState(text) {
	if (text === null || text === undefined) return null;
	try {
		const s = JSON.parse(text);
		if (s && typeof s === "object" && Number.isInteger(s.version) && s.version > ALLOC_STATE_VERSION) return { newer: true };
		if (s && typeof s === "object" && s.version === ALLOC_STATE_VERSION && typeof s.envelopeDigest === "string" && amountsAreMicros(s)) return s;
	} catch {}
	return { corrupt: String(text) };
}

/** The audit row shared by the file and `alloc:log`. `reasons` is added for the file alone. */
function auditRow({ at, host, writer, outcome, reason = null, field = null, rule = null, planId = null, basis = null, weights = null, repoWeights = null, before = null, after = null, clamped = null, envelopeDigest = null }) {
	return {
		v: 1,
		at,
		host,
		writer: writer?.kind ?? null,
		jobId: writer?.jobId ?? null,
		triggerId: writer?.triggerId ?? null,
		outcome,
		reason,
		...(field ? { field, rule } : {}),
		planId,
		basis,
		weights,
		repoWeights,
		before,
		after,
		clamped,
		envelopeDigest,
	};
}

/**
 * The audit file writer (`PI_LOGS_DIR/allocations/YYYY-MM.jsonl`, the UTC month of the row). Appended with the `a`
 * flag, which is O_APPEND: one row is one write, and rows from two processes on one host never interleave inside a
 * line. Created 0700 and 0600, like the run history. `append` THROWS on a failure: the file is the record, so a plan
 * whose row cannot be written does not apply.
 */
export function makeAllocationAudit({ logsDir, fs = nodeFs }) {
	const dir = join(logsDir, "allocations");
	return {
		dir,
		append(row) {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			fs.appendFileSync(join(dir, `${String(row.at).slice(0, 7)}.jsonl`), `${JSON.stringify(row)}\n`, { flag: "a", mode: 0o600 });
		},
	};
}

/**
 * The reaper of the audit files (`allocations/YYYY-MM.jsonl`), on `PI_LOG_RETENTION_DAYS` like the run history: a file
 * whose last write (mtime) is older than the retention goes. 0 keeps everything. A sibling of `makeLogReaper`, which
 * reaps only the top-level `.log` and `.json` files and never descends. Only names of the `YYYY-MM.jsonl` shape are
 * touched, so nothing an operator put there is removed. Never throws.
 */
export function makeAllocationLogReaper({ logsDir, retentionDays, fs = nodeFs, log = () => {}, now = () => Date.now() }) {
	const dir = join(logsDir, "allocations");
	return function reapAllocationLogs() {
		if (retentionDays === 0) return;
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch (err) {
			if (err?.code === "ENOENT") return;
			log("allocation_log_reaper_skipped", { reason: err?.code ?? "error" });
			return;
		}
		const cutoff = now() - retentionDays * 86400000;
		for (const name of names) {
			if (!/^\d{4}-\d{2}\.jsonl$/.test(name)) continue;
			try {
				const st = fs.lstatSync(join(dir, name));
				if (st.isFile() && st.mtimeMs < cutoff) {
					fs.unlinkSync(join(dir, name));
					log("reaped_allocation_log", { file: name });
				}
			} catch (err) {
				log("allocation_log_reaper_skipped", { file: name, reason: err?.code ?? "error" });
			}
		}
	};
}

/**
 * The applied split, shared by every host through Valkey. One per worker process. `audit` is
 * `makeAllocationAudit(...)` (or a test's), `host` this worker's name for the rows. Every method takes the host's
 * live `envelope` (parsed, never null here: with no envelope nothing in this module runs) and its `digest`, and an
 * injected `now`.
 */
export function makeAllocationState({ redis, host = "", audit, log = () => {}, lockMs = ALLOC_LOCK_MS, token = () => randomUUID(), prefix = null }) {
	// The four keys. `prefix` exists for the live Valkey tests alone, so a test never touches a deployment's `alloc:*`.
	const PLAN = prefix ? `${prefix}:plan` : ALLOC_PLAN_KEY;
	const LOCK = prefix ? `${prefix}:lock` : ALLOC_LOCK_KEY;
	const LOG = prefix ? `${prefix}:log` : ALLOC_LOG_KEY;
	const EXPECTED = prefix ? `${prefix}:envelope:expected` : ALLOC_EXPECTED_KEY;
	// The digests this host already wrote an `envelope-changed-externally` row for: one row per digest per process, not
	// one per pickup. A restart writes it again, once.
	const reportedExternal = new Set();
	let reportedNewer = false;
	let reportedUngoverned = false;

	async function pushLog(row) {
		try {
			await redis.lpush(LOG, JSON.stringify(row));
			await redis.ltrim(LOG, 0, ALLOC_LOG_MAX - 1);
		} catch (err) {
			// A view: losing a row here loses nothing the file does not hold.
			log("allocation_log_push_failed", { code: typeof err?.code === "string" ? err.code : "error" });
		}
	}

	/** File row (with the reasons when given), then the `alloc:log` view without them. */
	async function record(row, reasons = null) {
		audit.append(reasons && Object.keys(reasons).length > 0 ? { ...row, reasons } : row);
		await pushLog(row);
	}

	/**
	 * The row of a SYSTEM change (the seed, expiry, a re-base) that has already happened: the CAS or the seed landed, so
	 * a file that refuses the row cannot undo it and a retry cannot write it back. Never throws: the loss is logged with
	 * the outcome, the plan id and both digests (never a reason), and the `alloc:log` view still gets the row.
	 */
	async function recordSystem(row, fromDigest) {
		try {
			audit.append(row);
		} catch (err) {
			log("allocation_audit_row_lost", { outcome: row.outcome, planId: row.planId ?? null, from: fromDigest ?? null, to: row.envelopeDigest ?? null, code: typeof err?.code === "string" ? err.code : "error" });
		}
		await pushLog(row);
	}

	async function cas(current, next) {
		const r = await redis.eval(CAS_SCRIPT, 1, PLAN, current.planId ?? "", current.envelopeDigest, JSON.stringify(next));
		return Number(r) === 1;
	}

	/** The stored state, seeding the neutral one when there is none (and replacing one that does not decode). */
	async function ensure(envelope, digest, now) {
		const text = await redis.get(PLAN);
		const state = parseState(text);
		if (state?.newer) return state;
		if (state && state.corrupt === undefined) return state;
		const seed = neutralState(envelope, digest, now);
		const body = JSON.stringify(seed);
		// The seed's digest becomes the expected one in the same script: the host that wrote the split names the envelope it
		// was made for, so a host with another envelope, or a hand edit, meets a mismatch rather than re-basing.
		const corrupt = state?.corrupt !== undefined;
		const won = Number(await redis.eval(SEED_SCRIPT, 2, PLAN, EXPECTED, body, digest, corrupt ? "eq" : "nx", corrupt ? state.corrupt : "")) === 1;
		if (won) {
			if (corrupt) log("allocation_state_unreadable_replaced", {});
			await recordSystem(auditRow({ at: iso(now), host, writer: { kind: "default" }, outcome: "neutral", weights: seed.weights, after: amountsOf(seed), clamped: false, envelopeDigest: digest }), null);
			return seed;
		}
		const again = parseState(await redis.get(PLAN));
		return again && again.corrupt === undefined ? again : seed;
	}

	/** `alloc:envelope:expected`, seeded with `seedDigest` (the APPLIED state's digest, never a differing host's) when absent. */
	async function expectedDigest(seedDigest) {
		const expected = await redis.get(EXPECTED);
		if (expected !== null && expected !== undefined) return expected;
		await redis.set(EXPECTED, seedDigest, "NX");
		return redis.get(EXPECTED);
	}

	/**
	 * Bring the stored state in line with this host's envelope, and say whether the host may enforce it. Called at boot,
	 * on every envelope reload, and at each pickup (cheap: one GET, and a write only when something is due). Returns
	 * `{ state, mismatch }`: `mismatch` true means this host's digest is not the applied state's, and its governed jobs
	 * refuse as `envelope-mismatch` until it is.
	 *
	 *   1. No state (a first boot, a flush): the neutral one, `SET NX`.
	 *   2. Another digest: a RE-BASE when this host's digest equals `alloc:envelope:expected` (an absent expected is
	 *      seeded with this host's digest, silently), CAS from the old digest to the new; otherwise a mismatch, and one
	 *      `envelope-changed-externally` row. So a hand edit on one host cannot re-base the fleet.
	 *   3. Delegation off with a plan applied: neutral at once (`envelope-change`).
	 *   4. A plan past its `validUntil`: neutral (`expiry`).
	 * Each change is a CAS; the loser re-reads and goes round again (at most a few times: each round is someone's win).
	 */
	async function reconcile({ envelope, digest = envelopeDigest(envelope), now }) {
		for (let round = 0; round < 4; round++) {
			const state = await ensure(envelope, digest, now);
			if (state.newer) {
				// A newer build wrote it: its fields may bound what this build cannot read, so governed jobs refuse here
				// (money-safe) and the state is left exactly as it is for the build that understands it.
				if (!reportedNewer) {
					reportedNewer = true;
					log("allocation_state_newer", { reason: "alloc:plan was written by a newer pi-dispatch; upgrade this worker" });
				}
				return { state: null, mismatch: true };
			}
			if (state.envelopeDigest !== digest) {
				// Absent (a flush of the key alone, or a state from before the key existed): seeded with the APPLIED digest, so
				// the differing host is the one that mismatches, never the fleet that agrees with the split.
				const expected = await expectedDigest(state.envelopeDigest);
				if (expected !== digest) {
					if (!reportedExternal.has(digest)) {
						await record(auditRow({ at: iso(now), host, writer: { kind: "envelope-change" }, outcome: "envelope-changed-externally", reason: ENVELOPE_MISMATCH_REASON, planId: state.planId, before: amountsOf(state), envelopeDigest: digest }));
						// After the row: a row that failed to write is tried again at the next reconcile, not forgotten.
						reportedExternal.add(digest);
						log("envelope_changed_externally", { digest, applied: state.envelopeDigest });
					}
					return { state, mismatch: true };
				}
				const next = rebased(state, envelope, digest, now);
				if (await cas(state, next)) {
					await recordSystem(auditRow({ at: iso(now), host, writer: { kind: "envelope-change" }, outcome: "rebased", planId: next.planId, weights: next.weights, repoWeights: next.repoWeights, before: amountsOf(state), after: amountsOf(next), clamped: false, envelopeDigest: digest }), state.envelopeDigest);
					log("allocation_rebased", { from: state.envelopeDigest, to: digest });
					return { state: next, mismatch: false };
				}
				continue;
			}
			// The state agrees with this host: its digest is the expected one, so seed the key if it is absent.
			await expectedDigest(digest);
			if (state.planId !== null && !envelope.delegation?.enabled) {
				const next = neutralState(envelope, digest, now, { writer: "envelope-change", lastPlanAt: state.lastPlanAt ?? null });
				if (await cas(state, next)) {
					await recordSystem(auditRow({ at: iso(now), host, writer: { kind: "envelope-change" }, outcome: "neutral", reason: "delegation-off", planId: null, weights: next.weights, before: amountsOf(state), after: amountsOf(next), clamped: false, envelopeDigest: digest }), state.envelopeDigest);
					return { state: next, mismatch: false };
				}
				continue;
			}
			if (state.validUntil && Date.parse(state.validUntil) <= nowMs(now)) {
				const next = neutralState(envelope, digest, now, { writer: "expiry", lastPlanAt: state.lastPlanAt ?? null });
				if (await cas(state, next)) {
					await recordSystem(auditRow({ at: iso(now), host, writer: { kind: "expiry" }, outcome: "expired", planId: state.planId, weights: next.weights, before: amountsOf(state), after: amountsOf(next), clamped: false, envelopeDigest: digest }), state.envelopeDigest);
					log("allocation_expired", {});
					return { state: next, mismatch: false };
				}
				continue;
			}
			return { state, mismatch: false };
		}
		// Four lost rounds in a row: other hosts are changing the state as fast as this one reads it. Read once more and
		// answer from that; the next pickup reconciles again.
		const state = await ensure(envelope, digest, now);
		if (state.newer) return { state: null, mismatch: true };
		return { state, mismatch: state.envelopeDigest !== digest };
	}

	/**
	 * For a host WITHOUT an envelope: is the fleet governed (an applied split exists in `alloc:plan`)? One `EXISTS`. Such
	 * a host would otherwise reserve against the operator's caps alone beside hosts that enforce the split, so its jobs
	 * refuse as `envelope-mismatch` until the envelope is installed here, or delegation is turned off fleet-wide by
	 * removing the envelope from every host AND deleting `alloc:plan` and `alloc:envelope:expected`. Said loudly once per process, at the first true:
	 * the first pickup it refuses. Doctor names such a host before any job (`appliedSplitChecks`).
	 */
	async function fleetGoverned() {
		const governed = Number(await redis.exists(PLAN)) > 0;
		if (governed && !reportedUngoverned) {
			reportedUngoverned = true;
			log("envelope_absent_fleet_governed", { fix: "install the fleet's envelope here (PI_ENVELOPE_FILE), or remove it from every host and DEL alloc:plan alloc:envelope:expected" });
		}
		return governed;
	}

	/** The state projected onto a changed envelope: neutral for a neutral state or with delegation off, else `rebase`. */
	function rebased(state, envelope, digest, now) {
		if (state.planId === null || !envelope.delegation?.enabled) {
			return neutralState(envelope, digest, now, { writer: "envelope-change", lastPlanAt: state.lastPlanAt ?? null });
		}
		const v = rebase(vectorOf(state), envelope);
		const entries = envelopeEntries(envelope);
		const keep = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => entries.includes(k)));
		const repoWeights = keep(state.repoWeights);
		const weights = {};
		for (const id of entries) weights[id] = state.weights?.[id] ?? 0;
		return {
			...state,
			writer: "envelope-change",
			jobId: null,
			triggerId: null,
			appliedAt: iso(now),
			envelopeDigest: digest,
			weights,
			repoWeights,
			reasons: keep(state.reasons),
			allocations: v.allocations,
			unallocated: v.unallocated,
			repos: repoShares(v.allocations, repoWeights),
			clamped: false,
		};
	}

	async function takeLock() {
		const mine = `${host}#${token()}`;
		const got = await redis.set(LOCK, mine, "PX", lockMs, "NX");
		return got === null || got === undefined ? null : mine;
	}

	async function releaseLock(mine) {
		try {
			// Only while the value is still ours: a lock that expired and was taken by another apply is theirs.
			await redis.eval(RELEASE_IF_MINE, 1, LOCK, mine);
		} catch (err) {
			log("allocation_lock_release_failed", { code: typeof err?.code === "string" ? err.code : "error" });
		}
	}

	/**
	 * Apply a priorities plan (`text`, agent-authored) for `writer` `{ kind, jobId?, triggerId? }`. Returns
	 * `{ outcome, reason, planId?, field?, rule? }` with `outcome` one of `applied`, `duplicate`, `refused`,
	 * `apply-failed`. Every outcome is recorded in the file and in `alloc:log`. Never returns reason text.
	 *
	 * Order: a plan that is not well formed (`plan-invalid`, naming one field), then the ladder: `delegation-off`,
	 * `writer-not-allowed`, `envelope-mismatch` (this host's envelope is not the applied state's), `plan-duplicate` (a
	 * no-op), `plan-stale`, `plan-too-soon`, `plan-incomplete`, `plan-busy` (the lock). Then the step is computed
	 * against the APPLIED vector, the row is written, and the CAS compares the id and digest read; a lost CAS adds an
	 * `apply-failed` row and answers `plan-stale`. The lock is released only while it is still ours.
	 *
	 * Throws only on infrastructure (Valkey, or the audit file): such a plan has not applied.
	 */
	async function applyPlan({ envelope, digest = envelope ? envelopeDigest(envelope) : null, projects = null, text, writer, now }) {
		const at = iso(now);
		const kind = writer?.kind ?? null;
		const parsed = parsePlan(text, { envelope, projects, now: nowMs(now) });
		const refused = async (reason, extra = {}, state = null) => {
			await record(auditRow({ at, host, writer, outcome: reason === "plan-duplicate" ? "duplicate" : "refused", reason, ...extra, before: amountsOf(state), envelopeDigest: digest ?? null }));
			return { outcome: reason === "plan-duplicate" ? "duplicate" : "refused", reason, ...(extra.planId ? { planId: extra.planId } : {}), ...(extra.field ? { field: extra.field, rule: extra.rule } : {}) };
		};
		if (!parsed.ok && parsed.reason !== "plan-incomplete") return refused(parsed.reason, { field: parsed.field, rule: parsed.rule });
		if (!envelope) return refused("delegation-off", { planId: parsed.id, basis: parsed.plan.basis });
		const ids = { planId: parsed.id, basis: parsed.plan.basis };
		const first = planRefusal({ envelope, writer: kind, parsed, current: null, now: nowMs(now) });
		if (first === "delegation-off" || first === "writer-not-allowed") return refused(first, ids);
		const { state, mismatch } = await reconcile({ envelope, digest, now });
		if (mismatch) return refused(ENVELOPE_MISMATCH_REASON, ids, state);
		const rung = planRefusal({ envelope, writer: kind, parsed, current: { planId: state.planId, lastPlanAt: state.lastPlanAt }, now: nowMs(now) });
		if (rung) return refused(rung, ids, state);
		const mine = await takeLock();
		if (mine === null) return refused("plan-busy", ids, state);
		try {
			const weights = {};
			const repoWeights = {};
			const reasons = {};
			for (const p of parsed.plan.projects) {
				weights[p.id] = p.weight;
				if (p.repos) repoWeights[p.id] = Object.fromEntries(p.repos.map((r) => [r.ref, r.weight]));
				if (p.reason !== undefined) reasons[p.id] = p.reason;
			}
			const result = allocate({ envelope, weights, current: vectorOf(state), repos: repoWeights });
			const next = {
				version: ALLOC_STATE_VERSION,
				planId: parsed.id,
				basis: parsed.plan.basis,
				writer: kind,
				jobId: writer?.jobId ?? null,
				triggerId: writer?.triggerId ?? null,
				appliedAt: at,
				lastPlanAt: at,
				validUntil: parsed.validUntil,
				envelopeDigest: digest,
				weights,
				repoWeights,
				reasons,
				allocations: result.allocations,
				unallocated: result.unallocated,
				repos: result.repos,
				clamped: result.clamped,
			};
			const row = auditRow({ at, host, writer, outcome: "applied", planId: next.planId, basis: next.basis, weights, repoWeights, before: amountsOf(state), after: amountsOf(next), clamped: next.clamped, envelopeDigest: digest });
			// THE FILE FIRST: a change that happened always has its row. Then the CAS, which is the write.
			audit.append(Object.keys(reasons).length > 0 ? { ...row, reasons } : row);
			if (!(await cas(state, next))) {
				await record(auditRow({ at, host, writer, outcome: "apply-failed", reason: "plan-stale", planId: next.planId, basis: next.basis, before: amountsOf(state), envelopeDigest: digest }));
				return { outcome: "apply-failed", reason: "plan-stale", planId: next.planId };
			}
			await pushLog(row);
			log("allocation_applied", { writer: kind, planId: next.planId, clamped: next.clamped });
			return { outcome: "applied", reason: null, planId: next.planId, clamped: next.clamped };
		} finally {
			await releaseLock(mine);
		}
	}

	/**
	 * The operator's revert to an earlier outcome (issue #504 part C calls it; the panel's history reads `alloc:log`).
	 * `target` is an `alloc:log` row: its `planId`, `weights` and `repoWeights`. An operator act, so it skips the
	 * interval and the step rules: the target weights apply in full against the CURRENT envelope. It is still a CAS
	 * on the state it read, written after its row like a plan, and still refused while delegation is off (neutral is
	 * then the only state), while this host's envelope is not the applied one, or while another apply holds the lock.
	 * Weights that do not cover exactly the envelope's entries (an older envelope's row) refuse as `plan-incomplete`.
	 */
	async function revert({ envelope, digest = envelope ? envelopeDigest(envelope) : null, target, now }) {
		const at = iso(now);
		const writer = { kind: "operator-revert" };
		const weights = target?.weights ?? null;
		const entries = envelope ? envelopeEntries(envelope) : [];
		const refused = async (reason, state = null) => {
			await record(auditRow({ at, host, writer, outcome: "refused", reason, planId: target?.planId ?? null, before: amountsOf(state), envelopeDigest: digest ?? null }));
			return { outcome: "refused", reason };
		};
		if (!envelope?.delegation?.enabled) return refused("delegation-off");
		const keys = Object.keys(weights ?? {}).sort();
		if (keys.length !== entries.length || keys.some((k, i) => k !== entries[i])) return refused("plan-incomplete");
		const { state, mismatch } = await reconcile({ envelope, digest, now });
		if (mismatch) return refused(ENVELOPE_MISMATCH_REASON, state);
		const mine = await takeLock();
		if (mine === null) return refused("plan-busy", state);
		try {
			const repoWeights = Object.fromEntries(Object.entries(target?.repoWeights ?? {}).filter(([k]) => entries.includes(k) && k !== OTHER));
			const result = allocate({ envelope, weights, current: null, repos: repoWeights });
			const validUntil = new Date(nowMs(now) + envelope.delegation.maxPlanDays * 86400000).toISOString();
			const next = {
				version: ALLOC_STATE_VERSION,
				planId: typeof target?.planId === "string" ? target.planId : null,
				basis: state.planId,
				writer: "operator-revert",
				jobId: null,
				triggerId: null,
				appliedAt: at,
				lastPlanAt: at,
				validUntil: typeof target?.planId === "string" ? validUntil : null,
				envelopeDigest: digest,
				weights: { ...weights },
				repoWeights,
				reasons: {},
				allocations: result.allocations,
				unallocated: result.unallocated,
				repos: result.repos,
				clamped: false,
			};
			const row = auditRow({ at, host, writer, outcome: "reverted", planId: next.planId, basis: next.basis, weights: next.weights, repoWeights, before: amountsOf(state), after: amountsOf(next), clamped: false, envelopeDigest: digest });
			audit.append(row);
			if (!(await cas(state, next))) {
				await record(auditRow({ at, host, writer, outcome: "apply-failed", reason: "plan-stale", planId: next.planId, before: amountsOf(state), envelopeDigest: digest }));
				return { outcome: "apply-failed", reason: "plan-stale" };
			}
			await pushLog(row);
			return { outcome: "reverted", reason: null, planId: next.planId };
		} finally {
			await releaseLock(mine);
		}
	}

	/**
	 * A plan refused BEFORE `applyPlan` could judge it (issue #505): the job-side collector's own rungs
	 * (`plan-absent`, `plan-not-portfolio`, `plan-oversize`, `plan-not-regular-file`, `plan-unreadable`,
	 * `plan-parse-error`). `plan-absent` (issue #507) is a confirmed portfolio job that wrote no plan at all. One row in
	 * the file and one in `alloc:log`, like every refusal `applyPlan` writes, so none of them is silent. The reason is a
	 * fixed token and the plan body is never read into it: a refused file may not even be a plan. Throws like `record`
	 * on an infrastructure fault; the collector catches it.
	 */
	async function recordRefusal({ writer, reason, field = null, rule = null, digest = null, now }) {
		await record(auditRow({ at: iso(now), host, writer, outcome: "refused", reason, field, rule, envelopeDigest: digest }));
	}

	/**
	 * The newest `alloc:log` row a writer of `kind` wrote for the trigger `triggerId` (issue #505, the snapshot's
	 * `lastAttempt`), or null. `alloc:log` is newest first and carries no reasons, so the row holds only what a snapshot
	 * may show. A row that does not parse is skipped. Throws on a Valkey fault.
	 */
	async function lastAttempt({ kind = "portfolio-job", triggerId }) {
		const rows = await redis.lrange(LOG, 0, ALLOC_LOG_MAX - 1);
		for (const text of Array.isArray(rows) ? rows : []) {
			let row;
			try {
				row = JSON.parse(text);
			} catch {
				continue;
			}
			if (row?.writer === kind && row?.triggerId === triggerId) return row;
		}
		return null;
	}

	return { reconcile, applyPlan, revert, fleetGoverned, recordRefusal, lastAttempt };
}

/**
 * The job a project member stands for: a folder member is a local job on that folder, a forge member
 * (`<kind>:<repo>`, as projects.json stores it) a job of that kind on that repo. Used to find the scoped-limits row a
 * member's jobs match, by the job matcher itself (`dollarCapsFor`), rather than by comparing strings a second way.
 */
export function memberJob(member) {
	if (typeof member !== "string" || member === "") return null;
	if (isAbsolute(member)) return { kind: "local", folder: member };
	const at = member.indexOf(":");
	return at > 0 ? { kind: member.slice(0, at), repo: member.slice(at + 1) } : null;
}

/**
 * THE key prefix a member's repo share reserves and settles in (issue #505 review): the operator row its jobs match
 * when that row has dollar windows (`dollarCapsFor`, so a bare `acme/web` row is the key of the member
 * `github:acme/web`), else the synthetic ledger keyed by the member scope. `governedDollars` (enforcement) and the
 * portfolio snapshot (what a manager reads) both call this, so the counter read is always the counter written. Pass
 * `row` when the matched ledger is already in hand (null for none), else `limits` to match it here.
 */
export function memberDollarKeyPrefix(member, { row, limits = null } = {}) {
	const ledger = row !== undefined ? row : dollarCapsFor(memberJob(member), limits);
	return ledger?.keyPrefix ?? scopeDollarKeyPrefix(member);
}

/**
 * The dollar inputs of one governed job (issue #504 part B, `DES-DOLLAR-RESERVE-AND-SETTLE`): the operator's ledgers
 * narrowed by the applied split for the envelope's window. PURE. `operator` is what the job would reserve in with no
 * envelope (`dollarCaps`, `scopedDollars`, `projectDollars`, each possibly null); `member` is the pickup's
 * `{ id, member }` (the project id and `memberScopeOf`), or null for a job in no project. Returns
 * `{ dollarCaps, dollarCapSource, scopedDollars, projectDollars, otherDollars }`.
 *
 *   - the deployment: `min(operator cap, envelope total)` for the window; with no operator cap the total alone;
 *   - an envelope project: its row's ledger with `min(row, allocation)` for the window, or with no row a SYNTHETIC
 *     ledger keyed `scopeDollarKeyPrefix("project:<id>")` (the key a row would have), so it reserves, joins the
 *     job-cost ledgers and settles to the job's cost like any project row;
 *   - its member's repo share, when the plan gave one: the member's row ledger with `min(row, share)`, or a synthetic
 *     one keyed by the member scope;
 *   - `_other` (no project, or a project the envelope does not name): a ledger of its own, keyed
 *     `scopeDollarKeyPrefix("project:_other")` (`PROJECT_ID_RE` forbids `_`, so no real project shares the key), in
 *     the `otherDollars` slot; a real project outside the envelope keeps its own row besides.
 * Every ledger carries `capSource: { day, week, month }`, `operator` or `allocation` for the window that bound it (a
 * tie is `operator`), null for a window it does not have. The processor names a refusal `allocation-cap` from it.
 */
export function governedDollars({ envelope, state, member = null, operator = {} }) {
	const w = envelope.window;
	const entries = envelopeEntries(envelope);
	const entry = member && entries.includes(member.id) && member.id !== OTHER ? member.id : OTHER;
	const sourceOf = (caps) => ({ day: caps?.day == null ? null : "operator", week: caps?.week == null ? null : "operator", month: caps?.month == null ? null : "operator" });
	const narrow = (ledger, scope, amount, keyPrefix = scopeDollarKeyPrefix(scope)) => {
		const base = ledger ?? { scope, keyPrefix, caps: { day: null, week: null, month: null } };
		const caps = { day: base.caps?.day ?? null, week: base.caps?.week ?? null, month: base.caps?.month ?? null };
		const capSource = sourceOf(caps);
		if (caps[w] === null || amount < caps[w]) {
			caps[w] = amount;
			capSource[w] = "allocation";
		}
		return { ...base, caps, capSource };
	};
	const withSource = (ledger) => (ledger ? { ...ledger, capSource: sourceOf(ledger.caps) } : null);

	const deployment = narrow(operator.dollarCaps ? { caps: operator.dollarCaps } : null, "deployment", envelope.totalMicros);
	const out = {
		dollarCaps: deployment.caps,
		dollarCapSource: deployment.capSource,
		scopedDollars: withSource(operator.scopedDollars ?? null),
		projectDollars: withSource(operator.projectDollars ?? null),
		otherDollars: null,
	};
	if (entry === OTHER) {
		out.otherDollars = narrow(null, `project:${OTHER}`, state.allocations[OTHER] ?? 0);
		return out;
	}
	out.projectDollars = narrow(operator.projectDollars ?? null, `project:${entry}`, state.allocations[entry] ?? 0);
	const share = state.repos?.[entry]?.[scopeRef(member.member)];
	if (Number.isSafeInteger(share)) out.scopedDollars = narrow(operator.scopedDollars ?? null, member.member, share, memberDollarKeyPrefix(member.member, { row: operator.scopedDollars ?? null }));
	return out;
}
