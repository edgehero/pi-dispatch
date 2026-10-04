/**
 * Delegated allocation, the pure half (issue #504; INT-PRIORITIES-PLAN-CONTRACT,
 * DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE). An agent writes PRIORITIES, never dollar numbers: a plan of integer
 * weights per project (and per member repo), and this module does the arithmetic inside the operator's envelope
 * (envelope.mjs). Models reason poorly about a shared budget, and weights make every invariant checkable.
 *
 * PURE and import-light (`node:crypto` and the import-free project id rule): the worker, the admin extension and a
 * test all call it, and none of them may drag config.mjs's fs and os in with it. Nothing here reads a clock, a file or
 * Valkey. The callers pass `now`, the envelope and the current effective vector.
 *
 * Money is integer micro-dollars as a Number at every edge (money.mjs). Inside `allocate` and `rebase` it is BigInt:
 * a remainder times a weight can pass 2^53 (a $1,000,000 remainder is 1e12 micro-dollars, times 1000 is 1e15, and the
 * step blend multiplies a difference by another amount), and a float there would drift by a micro-dollar, which a
 * property test of "sums to the total" then catches only sometimes. Each Number that comes in is checked as a safe,
 * non-negative integer, and each that goes out is below the total, which was such an integer.
 *
 * Agent-authored text never leaves this module in a refusal: every refusal is a fixed enum and a field name from a
 * fixed list (`PLAN_FIELDS`), so a refusal can enter a log line, an audit row or a tool result as it stands.
 */

import { createHash } from "node:crypto";
import { isProjectId } from "./project-id.mjs";

/** The highest plan version this build reads. A plan declaring a higher one is refused (`plan-invalid`, `version`). */
export const PLAN_VERSION = 1;
/** The highest weight a plan may give. Integers from 0, so every share is a ratio of small integers. */
export const WEIGHT_MAX = 1000;
/** The longest `reason`, in code points. A note for the panel, not a document. */
export const REASON_MAX = 200;
/** The largest plan text read, in bytes (UTF-8). The job-side collector refuses a larger file before reading it. */
export const PLAN_MAX_BYTES = 16 * 1024;
/** The plan lifetime used when neither the caller nor the envelope gives one. */
export const DEFAULT_MAX_PLAN_DAYS = 14;
/**
 * The envelope entry for every scope in no envelope project. `PROJECT_ID_RE` forbids `_`, so no real project can
 * collide with it, and its dollar keys (`scopeDollarKeyPrefix("project:_other")`) cannot either.
 */
export const OTHER = "_other";
/** The two writers that may send a plan: the operator's session tool and a flagged portfolio job (issue #505). */
export const PLAN_WRITERS = Object.freeze(["operator-session", "portfolio-job"]);

/** The two refusals `parsePlan` returns. `plan-incomplete` is also a rung of the apply ladder (`planRefusal`). */
export const PLAN_INVALID = "plan-invalid";
export const PLAN_INCOMPLETE = "plan-incomplete";

/**
 * The fields a refusal names: a fixed list, so a refusal never echoes a key or a value the agent wrote. An unknown
 * key is named by WHERE it sits (`plan`, `projects`, `projects.repos`), never by its own spelling.
 */
export const PLAN_FIELDS = Object.freeze([
	"body",
	"plan",
	"version",
	"basis",
	"validUntil",
	"projects",
	"projects.id",
	"projects.weight",
	"projects.reason",
	"projects.repos",
	"projects.repos.ref",
	"projects.repos.weight",
]);

/** Why a field was refused: a fixed list too. */
export const PLAN_RULES = Object.freeze(["json", "too-large", "shape", "unknown-key", "missing", "type", "range", "newer", "format", "duplicate", "unknown-id", "control-char", "too-long", "past", "too-far", "missing-project", "missing-repo", "unknown-ref"]);

/** The apply ladder's refusals in their order (DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE). `plan-busy` is the lock's. */
export const PLAN_LADDER = Object.freeze(["delegation-off", "writer-not-allowed", "plan-duplicate", "plan-stale", "plan-too-soon", "plan-incomplete", "plan-busy"]);

const PLAN_KEYS = new Set(["version", "basis", "validUntil", "projects"]);
const PROJECT_KEYS = new Set(["id", "weight", "reason", "repos"]);
const REPO_KEYS = new Set(["ref", "weight"]);
const BASIS_RE = /^[0-9a-f]{16}$/;
const REF_RE = /^[0-9a-f]{8}$/;
// A UTC instant as `Date.prototype.toISOString` writes it, seconds required, milliseconds optional, `Z` only. An offset
// or a date alone is refused: a plan is compared against a clock on every host, and one spelling is one instant.
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// Refused in a reason rather than stripped: every control (C0, DEL, C1), every format character (the bidi controls and
// isolates, zero-width characters, the byte order mark, the tag block, and the joiners too, so an emoji sequence is
// refused: a reason is a short note, not a place for pictures), a lone surrogate, a private-use or unassigned code
// point, and the line and paragraph separators. Each can change what a reader of the panel sees or draw as nothing, and
// stripping would store text the writer did not write.
const REASON_REFUSED = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
/** At most this many projects, and repos per project, in a plan: a bound on the work a plan can ask for. */
const LIST_MAX = 256;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The longest plan life any caller may ask for: a year, the envelope's own ceiling. */
const MAX_PLAN_DAYS = 366;
/** The largest magnitude a Date holds (ECMA-262: 8.64e15 ms either side of the epoch). */
const MAX_DATE_MS = 8.64e15;

/**
 * The canonical JSON of a JSON-able value: object keys sorted at every depth, no whitespace. The input of `planId`,
 * so two plans that differ only in key order are one plan.
 */
export function canonicalJson(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * A plan's id: the first 16 hex digits of sha256 over its canonical JSON. `plan` is the canonical plan `parsePlan`
 * returns (projects sorted by id, repos by ref, an absent optional field absent), so a plan written twice with its
 * projects in another order has one id, and a re-collected file is a `plan-duplicate`.
 */
export function planId(plan) {
	return sha256(canonicalJson(plan)).slice(0, 16);
}

/**
 * A member's reference in a plan: the first 8 hex digits of sha256 over the member's canonical scope, the spelling
 * projects.json stores and `projectOf` matches (`github:acme/web`, or a resolved folder). A plan names repos by ref so
 * that no path and no repository name ever appears in it.
 */
export function scopeRef(scope) {
	return sha256(String(scope)).slice(0, 8);
}

/** The ids an envelope governs, sorted: every key of its floors, `_other` always among them. */
export function envelopeEntries(envelope) {
	return Object.keys(envelope?.floors ?? {}).sort();
}

function refuse(reason, field, rule, extra = {}) {
	return { ok: false, reason, field, rule, ...extra };
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKey(object, allowed) {
	return Object.keys(object).some((k) => !allowed.has(k));
}

function isWeight(value) {
	return Number.isInteger(value) && value >= 0 && value <= WEIGHT_MAX;
}

/**
 * Parse and judge a priorities plan's TEXT (INT-PRIORITIES-PLAN-CONTRACT). Returns `{ ok: true, plan, id, validUntil }`
 * or a refusal `{ ok: false, reason, field, rule }`: `reason` is `plan-invalid` or `plan-incomplete`, `field` is one of
 * `PLAN_FIELDS` and `rule` one of `PLAN_RULES`. One refusal, the first found, in the order the fields are listed.
 *
 * `plan` is the CANONICAL plan, the input of `planId`: `{ version, basis, validUntil?, projects }` with `projects`
 * sorted by id as `{ id, weight, reason?, repos? }` and `repos` sorted by ref, and a written `validUntil` in the
 * one spelling `toISOString` gives (milliseconds always shown). An optional field the writer left out stays out, so the
 * id is a property of what was written: a plan with no `validUntil` re-collected tomorrow has the same id. `validUntil` beside it is the RESOLVED instant (ISO): the written one, or `now` plus `maxPlanDays`.
 *
 * Options:
 *   - `envelope` (the normalized envelope, envelope.mjs): every id must be one of its entries, and every entry must be
 *     named, else `plan-incomplete` on `projects`. Without it the check is structural only (the runner's pre-check).
 *   - `projects` (the parsed projects.json): a project that lists `repos` must name every member by `scopeRef`, else
 *     `plan-incomplete` on `projects.repos`; a ref that is no member is `plan-invalid`. Without it, refs are checked
 *     for form only.
 *   - `now` (ms or Date, required when `validUntil` matters, which is always): the clock the instant is judged by.
 *   - `maxPlanDays`: the longest a plan may live; else the envelope's, else `DEFAULT_MAX_PLAN_DAYS`.
 *
 * A `plan-incomplete` refusal also carries `plan`, `id` and `validUntil`: the apply ladder puts that rung after the
 * duplicate, stale and too-soon rungs (`planRefusal`), and those need the id.
 */
export function parsePlan(text, { envelope = null, projects = null, now, maxPlanDays } = {}) {
	if (typeof text !== "string") return refuse(PLAN_INVALID, "body", "type");
	if (Buffer.byteLength(text, "utf8") > PLAN_MAX_BYTES) return refuse(PLAN_INVALID, "body", "too-large");
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		// Never the parser's message: it quotes the text around the fault, and the text is agent-authored.
		return refuse(PLAN_INVALID, "body", "json");
	}
	if (!isPlainObject(raw)) return refuse(PLAN_INVALID, "plan", "shape");
	if (unknownKey(raw, PLAN_KEYS)) return refuse(PLAN_INVALID, "plan", "unknown-key");

	if (raw.version === undefined) return refuse(PLAN_INVALID, "version", "missing");
	if (!Number.isInteger(raw.version) || raw.version < 1) return refuse(PLAN_INVALID, "version", "type");
	if (raw.version > PLAN_VERSION) return refuse(PLAN_INVALID, "version", "newer");

	// Required, with null spelled out: "I saw no plan" must be written, so a writer that forgot the field is told so
	// rather than read as a first plan.
	if (!("basis" in raw)) return refuse(PLAN_INVALID, "basis", "missing");
	if (raw.basis !== null && (typeof raw.basis !== "string" || !BASIS_RE.test(raw.basis))) return refuse(PLAN_INVALID, "basis", "format");

	const nowMs = now instanceof Date ? now.getTime() : now;
	if (!Number.isFinite(nowMs)) throw new TypeError("parsePlan: `now` (ms or a Date) is required");
	const days = maxPlanDays ?? envelope?.delegation?.maxPlanDays ?? DEFAULT_MAX_PLAN_DAYS;
	if (!Number.isInteger(days) || days < 1 || days > MAX_PLAN_DAYS) throw new TypeError(`parsePlan: maxPlanDays must be an integer from 1 to ${MAX_PLAN_DAYS}`);
	const limitMs = nowMs + days * DAY_MS;
	// Both instants must be ones a Date can hold, so `toISOString` below can never throw a RangeError: a bad clock is
	// the caller's defect, and it is reported as one, never as a crash in the middle of a judgement.
	if (Math.abs(nowMs) > MAX_DATE_MS || Math.abs(limitMs) > MAX_DATE_MS) throw new TypeError("parsePlan: `now` plus maxPlanDays is outside the range a Date can hold");
	let validUntilMs = limitMs;
	if (raw.validUntil !== undefined) {
		if (typeof raw.validUntil !== "string" || !INSTANT_RE.test(raw.validUntil)) return refuse(PLAN_INVALID, "validUntil", "format");
		const ms = Date.parse(raw.validUntil);
		// `Date.parse` accepts 2026-02-30 and rolls it over; the round trip refuses what is not a real instant.
		if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== raw.validUntil.slice(0, 19)) return refuse(PLAN_INVALID, "validUntil", "format");
		if (ms <= nowMs) return refuse(PLAN_INVALID, "validUntil", "past");
		if (ms > limitMs) return refuse(PLAN_INVALID, "validUntil", "too-far");
		validUntilMs = ms;
	}

	if (!Array.isArray(raw.projects)) return refuse(PLAN_INVALID, "projects", raw.projects === undefined ? "missing" : "type");
	const entries = envelope ? envelopeEntries(envelope) : null;
	if (raw.projects.length > LIST_MAX) return refuse(PLAN_INVALID, "projects", "too-long");
	const members = membersById(projects);
	const out = [];
	const seen = new Set();
	for (const entry of raw.projects) {
		if (!isPlainObject(entry)) return refuse(PLAN_INVALID, "projects", "shape");
		if (unknownKey(entry, PROJECT_KEYS)) return refuse(PLAN_INVALID, "projects", "unknown-key");
		if (entry.id === undefined) return refuse(PLAN_INVALID, "projects.id", "missing");
		if (entry.id !== OTHER && !isProjectId(entry.id)) return refuse(PLAN_INVALID, "projects.id", "format");
		if (seen.has(entry.id)) return refuse(PLAN_INVALID, "projects.id", "duplicate");
		if (entries && !entries.includes(entry.id)) return refuse(PLAN_INVALID, "projects.id", "unknown-id");
		seen.add(entry.id);
		if (entry.weight === undefined) return refuse(PLAN_INVALID, "projects.weight", "missing");
		if (!Number.isInteger(entry.weight)) return refuse(PLAN_INVALID, "projects.weight", "type");
		if (!isWeight(entry.weight)) return refuse(PLAN_INVALID, "projects.weight", "range");
		const project = { id: entry.id, weight: entry.weight };
		if (entry.reason !== undefined) {
			if (typeof entry.reason !== "string" || entry.reason.trim() === "") return refuse(PLAN_INVALID, "projects.reason", "type");
			if (REASON_REFUSED.test(entry.reason)) return refuse(PLAN_INVALID, "projects.reason", "control-char");
			if ([...entry.reason].length > REASON_MAX) return refuse(PLAN_INVALID, "projects.reason", "too-long");
			project.reason = entry.reason;
		}
		if (entry.repos !== undefined) {
			const repos = parseRepos(entry.repos, entry.id, members);
			if (!repos.ok) return repos;
			project.repos = repos.repos;
		}
		out.push(project);
	}
	out.sort((a, b) => compareIds(a.id, b.id));
	// A written `validUntil` enters the canonical plan as `toISOString` writes it, so `...00Z` and `...00.000Z`, one
	// instant, give one id.
	const plan = { version: raw.version, basis: raw.basis, ...(raw.validUntil !== undefined ? { validUntil: new Date(validUntilMs).toISOString() } : {}), projects: out };
	const id = planId(plan);
	const validUntil = new Date(validUntilMs).toISOString();
	if (entries && entries.some((e) => !seen.has(e))) return refuse(PLAN_INCOMPLETE, "projects", "missing-project", { plan, id, validUntil });
	if (members) {
		for (const project of out) {
			if (!project.repos) continue;
			const want = members.get(project.id) ?? [];
			if (want.some((ref) => !project.repos.some((r) => r.ref === ref))) return refuse(PLAN_INCOMPLETE, "projects.repos", "missing-repo", { plan, id, validUntil });
		}
	}
	return { ok: true, plan, id, validUntil };
}

/** Each project's member refs, from the parsed projects.json, or null when it was not given. */
function membersById(projects) {
	if (!Array.isArray(projects)) return null;
	const out = new Map();
	for (const p of projects) out.set(p?.id, (Array.isArray(p?.members) ? p.members : []).map(scopeRef));
	return out;
}

function parseRepos(repos, projectId, members) {
	if (!Array.isArray(repos) || repos.length === 0) return refuse(PLAN_INVALID, "projects.repos", "type");
	// `_other` has no members: a scope in no project has no ref a plan could name.
	if (projectId === OTHER) return refuse(PLAN_INVALID, "projects.repos", "unknown-ref");
	if (repos.length > LIST_MAX) return refuse(PLAN_INVALID, "projects.repos", "too-long");
	const known = members ? members.get(projectId) ?? [] : null;
	const out = [];
	for (const repo of repos) {
		if (!isPlainObject(repo)) return refuse(PLAN_INVALID, "projects.repos", "shape");
		if (unknownKey(repo, REPO_KEYS)) return refuse(PLAN_INVALID, "projects.repos", "unknown-key");
		if (repo.ref === undefined) return refuse(PLAN_INVALID, "projects.repos.ref", "missing");
		if (typeof repo.ref !== "string" || !REF_RE.test(repo.ref)) return refuse(PLAN_INVALID, "projects.repos.ref", "format");
		if (out.some((r) => r.ref === repo.ref)) return refuse(PLAN_INVALID, "projects.repos.ref", "duplicate");
		if (known && !known.includes(repo.ref)) return refuse(PLAN_INVALID, "projects.repos.ref", "unknown-ref");
		if (repo.weight === undefined) return refuse(PLAN_INVALID, "projects.repos.weight", "missing");
		if (!Number.isInteger(repo.weight)) return refuse(PLAN_INVALID, "projects.repos.weight", "type");
		if (!isWeight(repo.weight)) return refuse(PLAN_INVALID, "projects.repos.weight", "range");
		out.push({ ref: repo.ref, weight: repo.weight });
	}
	out.sort((a, b) => compareIds(a.ref, b.ref));
	return { ok: true, repos: out };
}

/** Code-unit order, the tie-break every rule here uses: ids and refs are ASCII, so this is plain ascending order. */
function compareIds(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The first rung of the apply ladder a parsed plan stops on, or null when it may apply (the lock, `plan-busy`, is the
 * caller's). Pure: the order is DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE's, and it is here so the worker and the admin
 * judge a plan by one function.
 *
 *   - `envelope`: the normalized envelope, or null (no envelope: delegation is off);
 *   - `writer`: who sent the plan, one of `PLAN_WRITERS`;
 *   - `parsed`: what `parsePlan` returned, `ok` or a `plan-incomplete` refusal (a `plan-invalid` one never gets here);
 *   - `current`: the applied state, `{ planId, lastPlanAt }`, or null when none is stored. `planId` is the id the
 *     next plan's `basis` must name (null for the neutral state, so a first plan sends `basis: null`); `lastPlanAt`
 *     is when a writer's plan last applied (ISO), or null, so neutral, expiry and re-base never start an interval;
 *   - `now`: ms or a Date.
 */
export function planRefusal({ envelope, writer, parsed, current, now }) {
	const delegation = envelope?.delegation;
	if (!delegation?.enabled) return "delegation-off";
	if (!PLAN_WRITERS.includes(writer) || !delegation.writers.includes(writer)) return "writer-not-allowed";
	const currentId = current?.planId ?? null;
	if (parsed.id === currentId) return "plan-duplicate";
	if (parsed.plan.basis !== currentId) return "plan-stale";
	const nowMs = now instanceof Date ? now.getTime() : now;
	const last = current?.lastPlanAt ? Date.parse(current.lastPlanAt) : NaN;
	if (Number.isFinite(last) && nowMs - last < delegation.minIntervalHours * 60 * 60 * 1000) return "plan-too-soon";
	if (parsed.ok === false && parsed.reason === PLAN_INCOMPLETE) return "plan-incomplete";
	return null;
}

// ── the arithmetic ─────────────────────────────────────────────────────────────────────────────────────────

/** A Number micro-dollar amount as BigInt, or a TypeError: every amount that comes in is a safe, non-negative integer. */
function micros(value, what) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${what} must be a non-negative safe integer of micro-dollars`);
	return BigInt(value);
}

/** Floor division for BigInt (BigInt `/` truncates toward zero, which is wrong for a negative numerator). */
function floorDiv(a, b) {
	const q = a / b;
	return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

/**
 * Split `amount` between `keys` in proportion to `weights` (BigInt, each >= 0), by largest remainder: each key gets
 * floor(amount * w / W), and the micro-dollars left go one each to the largest fractional remainders, ties to the
 * earlier key in `keys` order. Sums exactly to `amount` when any weight is above 0; all zero gives every key 0n.
 */
function largestRemainder(amount, keys, weights) {
	const total = keys.reduce((s, k) => s + weights[k], 0n);
	const out = {};
	if (total === 0n) {
		for (const k of keys) out[k] = 0n;
		return out;
	}
	const rems = [];
	let given = 0n;
	for (const k of keys) {
		const product = amount * weights[k];
		out[k] = product / total;
		given += out[k];
		rems.push({ k, rem: product % total });
	}
	let left = amount - given;
	rems.sort((a, b) => (a.rem === b.rem ? 0 : a.rem > b.rem ? -1 : 1)); // stable, so ties keep `keys` order
	for (let i = 0; left > 0n; i++, left--) out[rems[i].k] += 1n;
	return out;
}

/** The normalized envelope's numbers as BigInt, checked: `{ total, floors: { id: bigint }, entries }`. */
function envelopeNumbers(envelope) {
	const entries = envelopeEntries(envelope);
	if (!entries.includes(OTHER)) throw new TypeError(`the envelope must carry ${OTHER} among its floors`);
	const total = micros(envelope?.totalMicros, "envelope.totalMicros");
	const floors = {};
	let sum = 0n;
	for (const id of entries) {
		floors[id] = micros(envelope.floors[id], `envelope.floors.${id}`);
		sum += floors[id];
	}
	if (sum > total) throw new TypeError("the envelope's floors exceed its total");
	return { total, floors, entries };
}

/** A vector `{ allocations, unallocated }` as BigInt over exactly `entries`, checked to sum to `total`. */
function vectorNumbers(vector, entries, total, what) {
	const keys = Object.keys(vector?.allocations ?? {}).sort();
	if (keys.length !== entries.length || keys.some((k, i) => k !== entries[i])) throw new TypeError(`${what} must cover exactly the envelope's entries (rebase it first)`);
	const out = {};
	let sum = 0n;
	for (const id of entries) {
		out[id] = micros(vector.allocations[id], `${what}.allocations.${id}`);
		sum += out[id];
	}
	const unallocated = micros(vector.unallocated ?? 0, `${what}.unallocated`);
	if (sum + unallocated !== total) throw new TypeError(`${what} does not sum to the envelope's total`);
	return { allocations: out, unallocated };
}

/** The unallocated money's key in a step vector. It sorts before every id, so a tie in the re-rounding favours it. */
const UNALLOCATED = "";

function toNumbers(allocations, unallocated) {
	const out = {};
	for (const [k, v] of Object.entries(allocations)) out[k] = Number(v);
	return { allocations: out, unallocated: Number(unallocated) };
}

/**
 * The deterministic allocation (DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE). Returns
 * `{ allocations: { id: micros }, unallocated, clamped, target, repos }`, every amount a Number of micro-dollars:
 *
 *   1. FLOORS first: every entry gets its floor, and `R = total - sum(floors)` is what the weights split.
 *   2. The TARGET: `floor(R * w / W)` each, then the micro-dollars left one each by largest fractional remainder, ties
 *      by id ascending, so the target sums to the total exactly. All weights 0: floors only, and R stays UNALLOCATED,
 *      the money-safe direction.
 *   3. The STEP, only when `current` (the effective vector now applied) is given: `S = floor(total * maxStepPct / 100)`
 *      and `D` the largest move of any entry, the unallocated money counted as one more entry. `D <= S` applies the
 *      target. Otherwise every entry moves the same fraction S/D of its way, and the blend is re-rounded by largest
 *      remainder (ties: the unallocated money first, then id ascending). Both ends of the blend keep every floor and
 *      the total, so the blend does; and a value within S of the start rounds to an integer within S of it, so no
 *      entry ever moves by more than S. `clamped` says the step bound.
 *   4. REPO shares, for each project whose weights list `repos` (`{ projectId: { ref: weight } }`): the project's
 *      allocation split by largest remainder, ties by ref ascending, with no floors and no step. All repo weights 0
 *      gives each repo 0.
 *
 * `weights` must name every envelope entry with an integer 0 to `WEIGHT_MAX`. `current` must cover exactly the
 * entries and sum to the total (re-base it with `rebase` after an envelope change). Throws a TypeError on any input
 * that breaks those rules: a caller with a bad vector has a defect, and a guessed answer here would be a money answer.
 * Never returns more than the total, in any entry or in the sum.
 */
export function allocate({ envelope, weights, current = null, repos = null }) {
	const { total, floors, entries } = envelopeNumbers(envelope);
	const w = {};
	for (const id of entries) {
		if (!isWeight(weights?.[id])) throw new TypeError(`weights.${id} must be an integer from 0 to ${WEIGHT_MAX}`);
		w[id] = BigInt(weights[id]);
	}
	for (const id of Object.keys(weights ?? {})) if (!entries.includes(id)) throw new TypeError(`weights.${id} is not an envelope entry`);

	// 1 and 2: floors, then the remainder by weight.
	const remainder = total - entries.reduce((s, id) => s + floors[id], 0n);
	const anyWeight = entries.some((id) => w[id] > 0n);
	const shares = largestRemainder(anyWeight ? remainder : 0n, entries, w);
	const targetAlloc = {};
	for (const id of entries) targetAlloc[id] = floors[id] + shares[id];
	const targetUnallocated = anyWeight ? 0n : remainder;

	// 3: the step.
	let alloc = targetAlloc;
	let unallocated = targetUnallocated;
	let clamped = false;
	if (current !== null) {
		const pct = envelope?.delegation?.maxStepPct;
		if (!Number.isInteger(pct) || pct < 1 || pct > 100) throw new TypeError("envelope.delegation.maxStepPct must be an integer from 1 to 100 to apply a step");
		const before = vectorNumbers(current, entries, total, "current");
		const keys = [UNALLOCATED, ...entries];
		const b = { [UNALLOCATED]: before.unallocated, ...before.allocations };
		const t = { [UNALLOCATED]: targetUnallocated, ...targetAlloc };
		const step = (total * BigInt(pct)) / 100n;
		let largest = 0n;
		for (const k of keys) {
			const move = t[k] > b[k] ? t[k] - b[k] : b[k] - t[k];
			if (move > largest) largest = move;
		}
		if (largest > step) {
			clamped = true;
			const blended = blend(keys, b, t, step, largest);
			unallocated = blended[UNALLOCATED];
			alloc = {};
			for (const id of entries) alloc[id] = blended[id];
		}
	}

	// 4: repo shares inside each project's (stepped) allocation.
	const repoOut = {};
	for (const [projectId, repoWeights] of Object.entries(repos ?? {})) {
		if (!entries.includes(projectId) || projectId === OTHER) throw new TypeError(`repos.${projectId} is not an envelope project`);
		const refs = Object.keys(repoWeights ?? {}).sort();
		const rw = {};
		for (const ref of refs) {
			if (!isWeight(repoWeights[ref])) throw new TypeError(`repos.${projectId}.${ref} must be an integer from 0 to ${WEIGHT_MAX}`);
			rw[ref] = BigInt(repoWeights[ref]);
		}
		const split = largestRemainder(alloc[projectId], refs, rw);
		repoOut[projectId] = {};
		for (const ref of refs) repoOut[projectId][ref] = Number(split[ref]);
	}

	return { ...toNumbers(alloc, unallocated), clamped, target: toNumbers(targetAlloc, targetUnallocated), repos: repoOut };
}

/**
 * The step blend, re-rounded: each key moves `(t - b) * S / D` from `b`, floored, and the micro-dollars the floors
 * left (the fractional parts sum to a whole number, because the moves sum to 0) go one each to the largest fractional
 * parts, ties in `keys` order. Exact in BigInt.
 */
function blend(keys, b, t, step, largest) {
	const out = {};
	const fracs = [];
	let sum = 0n;
	for (const k of keys) {
		const scaled = (t[k] - b[k]) * step;
		const whole = floorDiv(scaled, largest);
		out[k] = b[k] + whole;
		sum += out[k];
		fracs.push({ k, frac: scaled - whole * largest });
	}
	const total = keys.reduce((s, k) => s + b[k], 0n);
	let left = total - sum;
	fracs.sort((a, c) => (a.frac === c.frac ? 0 : a.frac > c.frac ? -1 : 1));
	for (let i = 0; left > 0n; i++, left--) out[fracs[i].k] += 1n;
	return out;
}

/**
 * The neutral allocation: the envelope's `defaultWeights`, no step. What every host computes with no applied plan,
 * after a flush, after expiry and when delegation is off.
 */
export function neutralAllocation(envelope) {
	return allocate({ envelope, weights: envelope?.defaultWeights, current: null });
}

/**
 * Project an effective vector onto a changed envelope (a new total, new floors, an entry added or removed), with NO
 * step: an envelope change is the operator's act. Returns `{ allocations, unallocated }` over the new envelope's
 * entries, summing to its total.
 *
 * The weights are the vector's CURRENT above-floor shares, never a plan's weights: an entry weighs
 * `max(0, allocation - its new floor)`, and the unallocated money weighs what it holds. So a plan that was clamped
 * part of the way to its target stays part of the way: it cannot reach its target through an envelope edit. An entry
 * the new envelope adds weighs 0 (it gets its floor). An entry the new envelope drops brings its whole allocation to
 * `_other`'s weight, because its jobs join `_other`. All weights 0 leaves the headroom unallocated.
 */
export function rebase(vector, envelope) {
	const { total, floors, entries } = envelopeNumbers(envelope);
	const old = vector?.allocations ?? {};
	const weights = { [UNALLOCATED]: micros(vector?.unallocated ?? 0, "vector.unallocated") };
	for (const id of entries) weights[id] = 0n;
	for (const id of Object.keys(old).sort()) {
		const amount = micros(old[id], `vector.allocations.${id}`);
		if (entries.includes(id)) {
			weights[id] += amount > floors[id] ? amount - floors[id] : 0n;
		} else {
			weights[OTHER] += amount;
		}
	}
	const remainder = total - entries.reduce((s, id) => s + floors[id], 0n);
	const keys = [UNALLOCATED, ...entries];
	const anyWeight = keys.some((k) => weights[k] > 0n);
	const shares = largestRemainder(remainder, keys, weights);
	const alloc = {};
	for (const id of entries) alloc[id] = floors[id] + shares[id];
	return toNumbers(alloc, anyWeight ? shares[UNALLOCATED] : remainder);
}
