/**
 * Scoped limits (issue #242, INT-SCOPED-LIMITS-FILE-CONTRACT): per-scope run caps and per-scope
 * concurrency, where a scope is what `scopeOf` already answers -- the folder for a local job, the repo
 * for a forge one. One `scoped-limits.json` of `{ scope, day?, week?, month?, concurrent? }` entries:
 * the day/week/month caps refuse a job pre-spend (reason `scope-cap`, a policy refusal), `concurrent`
 * defers the excess through the delayed set (never a refusal -- a busy scope is transient state).
 *
 * This module is pure and fs-injectable (mirrors pause-windows.mjs in every respect): `parseScopedLimits`
 * validates the file TEXT fail-loud, `loadScopedLimits` layers the one fs read on top, and the small
 * helpers below are what the processor gate and the budget wiring consume. It also owns the in-process
 * in-flight counter (`makeInFlight`) so the counter is unit-testable without a bullmq import, the same
 * reason job-id.mjs is queue-free. The wiring that consumes all of this (the gate, the budget calls,
 * the admin surfaces) lands in this issue's later slices; the module ships first so the contract has
 * one implementation to bind to -- sentences below describing enforcement describe THOSE slices.
 *
 * The file is a SIBLING of pause-windows.json, not part of the settings overlay, deliberately: the
 * deferral gate runs before the per-job overlay read, so gate-read config must come from a watched
 * mutable ref, and the overlay's KNOWN_KEYS are flat scalars whose only map-shaped precedent
 * (secretProfiles) is deliberately model-unreachable -- the opposite of what these limits need.
 *
 * `version` is REQUIRED and fail-loud-on-newer (subscriptions.mjs's rule, adopted here because this is a
 * MONEY file): unknown fields are silently dropped per the operator-file policy, so a v2 cap field an old
 * worker drops would be a silently WIDENED spend limit. Pause-windows shipping without a version is a
 * sunk decision, not a precedent to extend to enforcement config.
 *
 * Version 2 (issues #501 part 5, #502 part 6) is exactly that case made real: dollar windows (`dayUsd`,
 * `weekUsd`, `monthUsd`) on a scope row, and `model:<provider>/<model>` rows carrying those alone. They are
 * DOLLAR ledgers (dollar-budget.mjs, built here by `dollarCapsFor` and `modelDollarRows`), never job-count ones,
 * so `budgetCapsFor`, `concurrencyFor` and the mutex never see them.
 *
 * Issue #498 adds the forge-qualified scope (`github:acme/web`), which names one forge's repo where a bare
 * `acme/web` names that repo on every forge. A job matches its qualified row first, then its bare row, and a file
 * holding both for one repo is refused. EVERY key (the job-count windows, the dollar windows, the in-process slot and
 * the fleet lease) is built from the MATCHED ROW's scope, never from the job's, so a bare row keeps exactly the key
 * it always had and a qualified row counts on its own.
 *
 * Custom: scoped limits validated inline per triggers.mjs/pause-windows.mjs precedent; zod not in deps
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { configError } from "./config.mjs";
import { DOLLAR_KEY_PREFIX } from "./dollar-budget.mjs";
import { hash16 } from "./fleet-lease.mjs";
import { splitModelEntry } from "./model-ref.mjs";
import { formatMicros, parseUsdMicros } from "./money.mjs";
import { parseScopeString, qualifiedScopeOf, scopeOf } from "./pause-windows.mjs";

/**
 * The highest schema version this build reads. A file declaring a higher one is refused loudly. The admin writes the
 * LOWEST version that expresses a file (`scopedLimitsVersionFor`), so a file with no dollar or model row stays 1.
 *
 * Version 2 (issues #501 part 5 and #502 part 6) adds dollar windows: `dayUsd`, `weekUsd` and `monthUsd` on a repo or
 * folder row, and `model:<provider>/<model>` rows that carry those three fields only. A version 1 file that uses
 * either is refused with an error naming version 2: a version 1 worker drops unknown fields, so a file that says 1
 * while it means 2 would read as a narrower cap on one build and no cap on another.
 *
 * A forge-qualified row (`github:acme/web`, issue #498) needs version 2 as well, for the same reason: every released
 * build reads `github:acme/web` as a plain repo string no job ever has, so a version 1 file holding one would be a
 * cap, a concurrency limit and a lease that one build enforces and another silently ignores. Version 2 makes every
 * older build refuse the file loudly instead.
 */
export const SCOPED_LIMITS_VERSION = 2;

/** The four job-count limit fields a row may carry, in display order. */
const LIMIT_FIELDS = ["day", "week", "month", "concurrent"];

/** The three dollar window fields (version 2), in display order. Each maps to a dollar window: day, week, month. */
export const USD_LIMIT_FIELDS = Object.freeze(["dayUsd", "weekUsd", "monthUsd"]);

/**
 * The scope prefix of a per-model row (issue #502 part 6): `model:<provider>/<model>`. Reserved in BOTH versions. A
 * version 1 file naming it is refused (naming version 2) rather than read as a folder called `model:...`.
 */
export const MODEL_SCOPE_PREFIX = "model:";

/** The dollar key prefix of a repo or folder row: `budget:usd:s:<hash16>` (the deployment's is `budget:usd`). */
export const SCOPE_DOLLAR_KEY_PREFIX = `${DOLLAR_KEY_PREFIX}:s`;
/** The dollar key prefix of a model row: `budget:usd:mdl:<hash16>`. `budget:usd:p:` stays reserved for #499. */
export const MODEL_DOLLAR_KEY_PREFIX = `${DOLLAR_KEY_PREFIX}:mdl`;

/** A scope that LOOKS like a model row (any case, `models`, spaces before the colon) but is not the exact prefix form. */
const MODEL_NEAR_MISS = /^models?\s*:/i;
/** The reserved project prefix and its near misses (`project:`, `Projects :`). */
const PROJECT_PREFIX = /^projects?\s*:/i;

/** Is this row scope a per-model row? */
export function isModelScope(scope) {
	return typeof scope === "string" && scope.startsWith(MODEL_SCOPE_PREFIX);
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

/**
 * The canonical scope string for a job: the RESOLVED folder path for a local job, the repo for a forge
 * one. `scopeOf` alone is not enough for enforcement: nothing on the trigger path normalizes
 * `run.folder`, so `/srv/site`, `/srv/site/`, `/srv//site`, `/srv/x/../site` and a padded spelling are
 * five distinct strings naming ONE directory -- an exact-string mutex keyed on the raw value would run
 * them concurrently in one working tree, which is the exact race the mutex exists to close.
 * `path.resolve` (not `normalize`, which keeps trailing slashes and whitespace) collapses them all; a
 * relative folder resolves against the worker's cwd, the same base `prepareWorkspace`'s existence check
 * uses; Unicode is NFC-normalized on both the job and the row side (see below). Two residuals,
 * deliberate: symlinks are NOT resolved (realpath is an fs call on the hot path and can throw), and
 * neither is filesystem case-insensitivity (on a default macOS/APFS volume `/Srv/Site` and `/srv/site`
 * are one directory and two scopes) -- the pause matcher lives with both.
 *
 * The pause matcher itself keeps the RAW `scopeOf` value: resolving there would silently change which
 * jobs an operator's existing trailing-slash window matches. The two features share the folder-vs-repo
 * split (`scopeOf`, defined once) but not the normalization, and this comment is where that difference
 * is recorded.
 *
 * A useful side effect: a resolved local scope is always an absolute path, and a repo string never is,
 * so a folder named `a/b` and a repo named `a/b` can no longer collide in the counters or the mutex.
 */
export function canonicalScope(job) {
	const scope = scopeOf(job);
	if (!isNonEmptyString(scope)) return null;
	// NFC on both kinds: macOS's filesystem hands paths back NFD while an admin dialog types NFC, so
	// "wéb" can arrive as two byte sequences naming one thing -- without this, an NFD-spelled forge
	// scope silently escapes an NFC-spelled cap (the local side would at least keep the structural
	// mutex). ASCII is fixed under NFC, so no existing key changes.
	return job?.kind === "local" ? resolve(scope.trim().normalize("NFC")) : scope.normalize("NFC");
}

/**
 * Parse, validate, and normalize the scoped-limits file TEXT. Returns the normalized `limits` array
 * (every row rebuilt as an explicit `{ scope, day, week, month, concurrent }` literal in a version 1 file, and
 * `{ scope, day, week, month, concurrent, dayUsd, weekUsd, monthUsd }` in a version 2 one, `null` for absent
 * fields, unknown fields dropped -- the operator-file policy). Throws `configError` (fail-loud) on any
 * malformed entry. `path` is for error messages only -- this function touches no filesystem.
 */
export function parseScopedLimits(text, path) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw configError(`scoped-limits file is not valid JSON: ${path} (${error.message})`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw configError(`scoped-limits file must be an object with "version" and "limits": ${path}`);
	}
	const version = parsed.version;
	if (!Number.isInteger(version) || version < 1) {
		throw configError(`scoped-limits file must have "version": 1 or ${SCOPED_LIMITS_VERSION} (an integer >= 1): ${path}`);
	}
	if (version > SCOPED_LIMITS_VERSION) {
		throw configError(`scoped-limits file written by a newer pi-dispatch (version ${version}; this build understands ${SCOPED_LIMITS_VERSION}): ${path}`);
	}
	if (!Array.isArray(parsed.limits)) {
		throw configError(`scoped-limits file must have a "limits" array: ${path}`);
	}
	const rows = parsed.limits.map((row, index) => normalizeLimit(row, index, path, version));
	refuseMixedForms(rows, path);
	const seen = new Map();
	rows.forEach((row, index) => {
		// A model row's identity is its LOWERCASED ref, the one its dollar key hashes (`modelDollarKeyPrefix`): two rows
		// differing only in case would be two caps on one counter.
		const id = isModelScope(row.scope) ? row.scope.toLowerCase() : row.scope;
		if (seen.has(id)) {
			// Two rows for one scope is a precedence question with no right answer; the admin's
			// edit-in-place never produces one, so a duplicate is always a hand-edit mistake.
			throw configError(`scoped limit at index ${index}: duplicate scope ${JSON.stringify(row.scope)} (first at index ${seen.get(id)}): ${path}`);
		}
		seen.set(id, index);
	});
	return rows;
}

/**
 * A bare row and a qualified row for one repo (`acme/web` beside `github:acme/web`) refuse the file, naming both
 * indexes (issue #498). Whatever fields either carries, count or dollar: one row applies to a job, and with both forms
 * present that rule would need a precedence ladder, which reads as one cap while the other silently stops counting.
 * Refusing is the simpler rule, and it is loud. Two qualified rows for one repo on two forges are fine.
 */
function refuseMixedForms(rows, path) {
	const bare = new Map();
	rows.forEach((row, index) => {
		if (!isModelScope(row.scope) && parseScopeString(row.scope).type === "bare") bare.set(row.scope, index);
	});
	rows.forEach((row, index) => {
		if (isModelScope(row.scope)) return;
		const parsed = parseScopeString(row.scope);
		if (parsed.type !== "qualified" || !bare.has(parsed.repo)) return;
		const other = bare.get(parsed.repo);
		throw configError(`scoped limit at index ${index}: ${JSON.stringify(row.scope)} and the bare ${JSON.stringify(parsed.repo)} at index ${other} name the same repo; keep one form (a bare row covers every forge, a qualified row one forge): ${path}`);
	});
}

/** A dollar field's value, or the refusal: `parseUsdMicros`'s rules (strings recommended), named by row and field. */
function usdField(value, field, at, path) {
	try {
		return parseUsdMicros(value, field);
	} catch (error) {
		throw configError(`${at}: ${error.message}: ${path}`);
	}
}

/**
 * A per-model row (version 2): `{ scope: "model:<provider>/<model>", dayUsd?, weekUsd?, monthUsd? }`. The ref follows
 * the allowed-model list's rule (`splitModelEntry`: split at the first `/`, each half a valid id). `day`, `week`,
 * `month` and `concurrent` are refused here: a model is not a scope a job runs IN, so a job-count cap or a
 * concurrency limit on it would read as enforced while nothing counts it.
 */
function normalizeModelLimit(row, trimmed, at, path, version) {
	if (version < 2) throw configError(`${at}: a "model:" row needs "version": 2 (this file says ${version}): ${path}`);
	const ref = splitModelEntry(trimmed.slice(MODEL_SCOPE_PREFIX.length));
	if (ref === null) throw configError(`${at}: a model row's scope must be model:<provider>/<model> (each 1 to 64 characters, no spaces): ${path}`);
	// The runner folds model-less and overflow calls into an `other/other` usage row, so a row naming that pair
	// could never be told apart from the fold.
	if (`${ref.provider}/${ref.model}`.toLowerCase() === "other/other") throw configError(`${at}: model:other/other names the usage ledger's fold row, not a model: ${path}`);
	for (const field of LIMIT_FIELDS) {
		if (row[field] !== undefined && row[field] !== null) throw configError(`${at}: a model row carries dayUsd, weekUsd and monthUsd only (${field} is refused): ${path}`);
	}
	const norm = { scope: `${MODEL_SCOPE_PREFIX}${ref.provider}/${ref.model}`, day: null, week: null, month: null, concurrent: null, dayUsd: null, weekUsd: null, monthUsd: null };
	let any = false;
	for (const field of USD_LIMIT_FIELDS) {
		if (row[field] === undefined || row[field] === null) continue;
		norm[field] = formatMicros(usdField(row[field], field, at, path));
		any = true;
	}
	if (!any) throw configError(`${at}: a model row needs at least one of dayUsd, weekUsd, monthUsd: ${path}`);
	return norm;
}

function normalizeLimit(row, index, path, version = SCOPED_LIMITS_VERSION) {
	const at = `scoped limit at index ${index}`;
	if (row === null || typeof row !== "object" || Array.isArray(row)) {
		throw configError(`${at}: must be an object: ${path}`);
	}
	if (!isNonEmptyString(row.scope)) throw configError(`${at}: scope must be a non-empty string: ${path}`);
	const trimmed = row.scope.trim().normalize("NFC"); // the same NFC canonicalScope applies job-side
	if (isModelScope(trimmed)) return normalizeModelLimit(row, trimmed, at, path, version);
	// A NEAR MISS of a reserved prefix is refused, never read as a repo or folder row (PR #549's review): a
	// mistyped `Model:openai/x`, `models:...` or `model :...` would otherwise parse as a repo scope no job ever has,
	// a dollar cap that governs nothing while the file reads as capping a model.
	if (MODEL_NEAR_MISS.test(trimmed)) throw configError(`${at}: a model row's scope is written exactly model:<provider>/<model> (lowercase "model", no space before the colon): ${path}`);
	// `project:` is reserved for project windows (#499) in every version, so that change needs no version 3.
	if (PROJECT_PREFIX.test(trimmed)) throw configError(`${at}: a "project:" scope is reserved for project windows (#499) and is not read by this build: ${path}`);
	if (trimmed === "*") {
		// "*" as ONE shared counter is redundant with the global caps, so the only useful reading is a
		// per-scope default -- the OPPOSITE of what "*" means one file over (pause-windows: one rule
		// matching all scopes). Refused rather than shipped divergent; a later version may adopt the
		// per-scope-default reading, with an exact row beating "*" (recorded in the contract).
		throw configError(`${at}: "*" is not supported -- add one row per scope (a per-scope default may adopt "*" later): ${path}`);
	}
	if (trimmed.includes("*")) {
		// No globs, enforced rather than described: an exact matcher makes "acme/*" a row that governs
		// nothing, and a silently inert money limit is the failure class this repo refuses outright.
		throw configError(`${at}: scopes match exactly; a scope containing "*" is refused (no globs): ${path}`);
	}
	// Issue #498: `<forge kind>:<repo>` names one forge's repo; an unknown `<word>:` prefix is refused naming the kinds.
	let form;
	try {
		form = parseScopeString(trimmed);
	} catch (error) {
		throw configError(`${at}: ${error.message}: ${path}`);
	}
	if (form.type === "qualified" && version < 2) throw configError(`${at}: a forge-qualified scope needs "version": 2 (this file says ${version}), so a build that predates it refuses the file rather than reading an inert repo string: ${path}`);
	const norm = {
		// An absolute path is stored resolved so a `/srv/site/` row governs `/srv/site` jobs -- the same
		// collapse canonicalScope applies on the job side. isAbsolute is PLATFORM-NATIVE on purpose, so a
		// foreign-platform row (a windows drive path on a POSIX worker) stays verbatim and is inert here;
		// the doctor's unreferenced-scope advisory names it. Resolving it instead would "work" only by
		// both sides mangling into the same cwd-prefixed string -- a match by accident, not by contract.
		scope: form.type === "qualified" ? `${form.kind}:${form.repo}` : isAbsolute(trimmed) ? resolve(trimmed) : trimmed,
		day: null,
		week: null,
		month: null,
		concurrent: null,
		// Version 2's dollar windows, each the canonical decimal string (`formatMicros`), so the admin's
		// read-modify-write writes back exactly what the parser accepts. `dollarCapsFor` turns them into integers.
		// Only in a version 2 file's rows: a version 1 file reads into exactly the five-key literal it always did.
		...(version >= 2 ? { dayUsd: null, weekUsd: null, monthUsd: null } : {}),
	};
	let any = false;
	for (const field of USD_LIMIT_FIELDS) {
		const value = row[field];
		if (value === undefined || value === null) continue;
		if (version < 2) throw configError(`${at}: ${field} needs "version": 2 (this file says ${version}): ${path}`);
		norm[field] = formatMicros(usdField(value, field, at, path));
		any = true;
	}
	for (const field of LIMIT_FIELDS) {
		const value = row[field];
		// Absent-or-null (subscriptions.mjs's rule): null is the normalizer's OWN output for an unset
		// field, so the parser must accept it back or it cannot re-parse what it produced -- the admin's
		// read-modify-write goes through this parser on both edges.
		if (value === undefined || value === null) continue;
		// 0 is refused, not "never run": budget.mjs's caps treat every configured window as >= 1, and
		// "never run this scope" already has two honest spellings (delete the trigger; a pause window).
		// isSafeInteger, not isInteger: 1e21 passes isInteger and reads as a limit while being
		// indistinguishable from unlimited -- a bound that cannot count is not a bound.
		if (!Number.isSafeInteger(value) || value < 1) {
			throw configError(`${at}: ${field} must be an integer >= 1: ${path}`);
		}
		norm[field] = value;
		any = true;
	}
	if (!any) {
		throw configError(`${at}: at least one of day, week, month, concurrent${version >= 2 ? ", dayUsd, weekUsd, monthUsd" : ""} is required (a row that limits nothing is a row an operator sets and then trusts): ${path}`);
	}
	return norm;
}

/**
 * Load and validate the scoped-limits file named by `config.scopedLimitsFile`. Returns `[]` when the file
 * is unset (no scoped caps or concurrency -- a valid deployment; the folder mutex holds regardless, it is
 * code, not configuration). `readFileSync`/`existsSync` are injectable for tests.
 */
export function loadScopedLimits(config, { readFileSync = fsReadFileSync, existsSync = fsExistsSync } = {}) {
	const path = config.scopedLimitsFile;
	if (path === null || path === undefined) return [];
	if (!existsSync(path)) throw configError(`scoped-limits file does not exist: ${path}`);
	return parseScopedLimits(readFileSync(path, "utf8"), path);
}

/**
 * The row that applies to this job, or null. Exact string equality only -- the pause matcher's semantics minus
 * its "*" (refused above). A forge job matches the row equal to its `qualifiedScopeOf` first (`github:acme/web`),
 * then the row equal to its canonical bare repo (`acme/web`); a local job matches its resolved folder. With
 * duplicates refused and a bare row beside a qualified row for one repo refused too, at most one of the two can
 * exist, so the order is not a precedence ladder: it only says where to look.
 */
export function limitFor(limits, job) {
	if (!Array.isArray(limits)) return null;
	// A model row is never a job's scope: it caps a model wherever it runs (`modelDollarRows`).
	const find = (scope) => (isNonEmptyString(scope) ? limits.find((l) => l.scope === scope && !isModelScope(l.scope)) ?? null : null);
	if (job?.kind !== "local") {
		const qualified = find(qualifiedScopeOf(job));
		if (qualified !== null) return qualified;
	}
	return find(canonicalScope(job));
}

/**
 * The scope every per-scope KEY of this job is built from (issue #498): the matched row's scope, or the job's
 * canonical scope when no row matches. The in-process slot, the fleet lease (`slot:s:<hash16>`), and through
 * `budgetCapsFor`/`dollarCapsFor` the job-count and dollar windows all hash this one string. Keyed by the ROW, never
 * the job: a bare `acme/web` row then keeps the exact key it had before qualified scopes existed (its counts carry
 * over, and the admin, which recomputes keys from rows, keeps reading them), and it stays ONE shared cap across
 * forges as written. The boot sweeper already hashes row scopes, so the gate and the sweeper are one rule.
 */
export function rowScopeFor(job, limits) {
	return limitFor(limits, job)?.scope ?? canonicalScope(job);
}

/**
 * The scoped budget windows this job reserves against, or null when nothing applies (no row for the
 * scope, or the row is concurrency-only). The returned `scope` is the MATCHED ROW's (issue #498), so the redis
 * counters are spelling-stable and a bare row keeps its key. Shaped like the global `caps` object so
 * `reserveBudget` consumes it unchanged.
 */
export function budgetCapsFor(job, limits) {
	const row = limitFor(limits, job);
	if (!row || (row.day === null && row.week === null && row.month === null)) return null;
	return { scope: row.scope, caps: { day: row.day, week: row.week, month: row.month } };
}

/** A row's dollar windows as integer micro-dollars `{ day, week, month }`, each null when unset, or null when none is. */
function usdCaps(row) {
	const caps = {};
	for (const [field, name] of [["dayUsd", "day"], ["weekUsd", "week"], ["monthUsd", "month"]]) {
		caps[name] = row?.[field] === null || row?.[field] === undefined ? null : parseUsdMicros(row[field], field);
	}
	return caps.day === null && caps.week === null && caps.month === null ? null : caps;
}

/**
 * The repo or folder dollar windows this job reserves in (issue #501 part 5), or null when its scope's row has none
 * (or there is no row). Ledger-shaped for `reserveDollars`: `{ scope, keyPrefix, caps }`, the caps in integer
 * micro-dollars and `keyPrefix` `budget:usd:s:<hash16>` of the same MATCHED ROW scope the job-count windows hash
 * (issue #498). A sibling of `budgetCapsFor`: the job-count and dollar windows of one row are separate ledgers.
 */
export function dollarCapsFor(job, limits) {
	const row = limitFor(limits, job);
	const caps = row ? usdCaps(row) : null;
	return caps === null ? null : { scope: row.scope, keyPrefix: scopeDollarKeyPrefix(row.scope), caps };
}

/**
 * The model dollar windows this job reserves in (issue #502 part 6), as ledgers `{ ref, keyPrefix, caps }` in file
 * order, where `ref` is the row's lowercased `provider/model`. `models` is the job's EFFECTIVE allowed-model list:
 *   - a list reserves in the rows of its listed models, compared ignoring case (the ledger lowercases ids, so the
 *     row and the usage row it settles from meet in lowercase);
 *   - no list (`null` or `undefined`) reserves in EVERY model row. An unrestricted job may switch to any model
 *     mid-run, so it could spend in any of them; reserving in none would let it run up a model's window unseen.
 *     This fails closed: an unrestricted job is refused when any model window is full, and the remedy is a list.
 * A job that reserves nothing at all (the zero-reservation rule, the processor's) reserves in none of these either.
 */
export function modelDollarRows(limits, models) {
	if (!Array.isArray(limits)) return [];
	const rows = limits.filter((l) => isModelScope(l?.scope));
	let wanted = null;
	if (Array.isArray(models)) wanted = new Set(models.filter((m) => typeof m === "string").map((m) => m.toLowerCase()));
	const out = [];
	for (const row of rows) {
		const ref = row.scope.slice(MODEL_SCOPE_PREFIX.length).toLowerCase();
		if (wanted !== null && !wanted.has(ref)) continue;
		const caps = usdCaps(row);
		if (caps !== null) out.push({ ref, keyPrefix: modelDollarKeyPrefix(ref), caps });
	}
	return out;
}

/**
 * The rows that carry a dollar window, as `[{ index, kind }]` (`kind` is `scope` or `model`), when the deployment has
 * NO per-job cap (`deploymentMaxCostUsd` null or undefined: env and overlay merged by the caller), else `[]` (PR #549's
 * review). Such a row refuses every job it applies to as `config-refused` unless the job's trigger sets its own
 * `run.maxCostUsd`, so the worker and doctor WARN, never refuse: a trigger may legitimately supply the cap. Index and
 * kind only, never the scope string (a folder scope is a host path).
 */
export function dollarRowsWithoutCap(limits, deploymentMaxCostUsd) {
	if (deploymentMaxCostUsd !== null && deploymentMaxCostUsd !== undefined) return [];
	const out = [];
	(limits ?? []).forEach((row, index) => {
		if (USD_LIMIT_FIELDS.some((f) => row?.[f] !== null && row?.[f] !== undefined)) out.push({ index, kind: isModelScope(row.scope) ? "model" : "scope" });
	});
	return out;
}

/**
 * The windows of dollar rows whose cap is BELOW the deployment's per-job cap, as `[{ index, kind, window }]` (PR
 * #549's review). A job reserves its whole per-job cap, so such a window refuses every job it applies to, every time,
 * until the cap is raised or the per-job cap lowered (a trigger's smaller `run.maxCostUsd` still fits). Doctor names
 * them; `[]` when no deployment cap is set or none is below it.
 */
export function dollarRowsBelowJobCap(limits, deploymentMaxCostUsd) {
	if (deploymentMaxCostUsd === null || deploymentMaxCostUsd === undefined) return [];
	const jobCap = parseUsdMicros(deploymentMaxCostUsd, "maxCostUsd");
	const out = [];
	(limits ?? []).forEach((row, index) => {
		for (const [field, window] of [["dayUsd", "day"], ["weekUsd", "week"], ["monthUsd", "month"]]) {
			if (row?.[field] === null || row?.[field] === undefined) continue;
			if (parseUsdMicros(row[field], field) < jobCap) out.push({ index, kind: isModelScope(row.scope) ? "model" : "scope", window });
		}
	});
	return out;
}

/**
 * The lowest file version that expresses `rows` (normalized or as the admin builds them): 2 when any row carries a
 * dollar field, is a model row or has a forge-qualified scope (issue #498), else 1. The admin writes this, so a file
 * with bare and folder job-count rows only stays a version 1 file that an older worker still reads.
 */
export function scopedLimitsVersionFor(rows) {
	const v2 = (rows ?? []).some((l) => {
		const scope = typeof l?.scope === "string" ? l.scope.trim() : l?.scope;
		return isModelScope(scope) || isQualifiedScope(scope) || USD_LIMIT_FIELDS.some((f) => l?.[f] !== null && l?.[f] !== undefined);
	});
	return v2 ? 2 : 1;
}

/** Is this written scope forge-qualified? False for anything `parseScopeString` refuses: the parser names that. */
function isQualifiedScope(scope) {
	if (typeof scope !== "string" || scope === "" || isModelScope(scope)) return false;
	try {
		return parseScopeString(scope).type === "qualified";
	} catch {
		return false;
	}
}

/**
 * The effective in-flight ceiling for this job's scope: `min(configured concurrent, structural)`, where
 * structural is 1 for a local job -- the folder mutex -- and unbounded otherwise. The mutex is
 * UNCONDITIONAL, in code, with no file configured and no off-switch: two agents in one bind-mounted
 * working tree is the race `run.replicas` is already refused on local jobs for, and a cron trigger
 * reaches it with no operator mistake at all (the scheduler mints the next occurrence at pickup and
 * promotes on time alone, so a slow run overlaps its own successor). A configured `concurrent` above 1
 * on a folder scope silently clamps to 1 rather than refusing at parse: scope strings are not reliably
 * typeable as folder-vs-repo (`"a/b"` is a legal relative folder and a legal repo), so a parse-time
 * classifier would misfire; min() cannot.
 *
 * No scope (a malformed payload) means no gate: Infinity, admit -- the job will fail its own validation
 * downstream, and holding a mutex slot under key `null` helps nobody.
 */
export function concurrencyFor(job, limits) {
	const scope = canonicalScope(job);
	if (scope === null) return Infinity;
	const structural = job?.kind === "local" ? 1 : Infinity;
	const configured = limitFor(limits, job)?.concurrent ?? Infinity;
	return Math.min(structural, configured);
}

/**
 * The redis key prefix for a scope's budget windows: `budget:s:<16 hex>`. Handed to
 * `reserveBudget`/`releaseBudget` as `keyPrefix`, so `dayKey`/`weekKey`/`monthKey` compose
 * `budget:s:<h>:YYYY-MM-DD` / `:w:...` / `:m:...` with zero new key-shape logic. A hash (the localJobId
 * idiom: sha256, first 16 hex) rather than an escape: a scope legally contains `:` and `/` (folder
 * paths, gitlab group/subgroup/project), which would collide with budget.mjs's own `w:`/`m:`/`t:`
 * sub-namespaces, and a bijective escape grammar is a new thing to get wrong with unbounded key lengths.
 * The one consumer that must map keys BACK to scopes is the admin's counter display, and it knows the
 * configured scopes -- it recomputes keys through this same export, so unreadability in redis-cli is the
 * accepted cost.
 */
export function scopeKeyPrefix(scope) {
	return `budget:s:${hash16(scope)}`;
}

/** A repo or folder's DOLLAR key prefix: `budget:usd:s:<hash16(scope)>`, the same hash as `scopeKeyPrefix`. */
export function scopeDollarKeyPrefix(scope) {
	return `${SCOPE_DOLLAR_KEY_PREFIX}:${hash16(scope)}`;
}

/**
 * A model's DOLLAR key prefix: `budget:usd:mdl:<hash16(lowercase provider/model)>`. LOWERCASED before hashing,
 * because the run record's ledger lowercases ids (`parseExitUsage`) and a model row settles from that ledger: one
 * model must be one counter whatever case a row, a list or the runner spells it in. `ref` is `provider/model`,
 * without the `model:` prefix.
 */
export function modelDollarKeyPrefix(ref) {
	return `${MODEL_DOLLAR_KEY_PREFIX}:${hash16(String(ref).toLowerCase())}`;
}

/** The dollar key prefix of one normalized row, scope or model: what the admin reads its counters under. */
export function dollarKeyPrefixFor(row) {
	return isModelScope(row?.scope) ? modelDollarKeyPrefix(row.scope.slice(MODEL_SCOPE_PREFIX.length)) : scopeDollarKeyPrefix(row?.scope);
}

/**
 * The per-process in-flight counter behind per-scope concurrency and the folder mutex. Process memory is
 * the CORRECT store, not a compromise: one worker per docker daemon is the shape DES-CONCURRENCY-3
 * assumes everywhere and `service install` enforces for installed units (`pi-dispatch start` holds no
 * lock, and two hand-run workers are already unsupported -- the second one's boot reaper kills the
 * first's live containers); the reaper removes every surviving `pi-job-*` container before the worker
 * starts draining, so a fresh, empty map is never wrong about a live container except when the reap
 * itself was skipped (`reaper_skipped`: docker missing/down at boot -- a state where no NEW container
 * can start either); and a Redis-held counter would survive a crash WRONGLY -- a claim for a container
 * the reaper just killed, demanding TTL/heartbeat machinery, a second source of truth about "what is
 * running" (the OQ-008 failure mode).
 *
 * `tryAcquire` is a synchronous check-and-increment: no await between the read and the take, so under
 * Node's single thread no interleaving exists at any concurrency. `release` never throws -- it runs in
 * the processor's finally, where a throw would mask the job's real error -- and clamps at zero.
 */
export function makeInFlight() {
	const counts = new Map();
	return {
		/** True and counted when under `limit`; false WITHOUT counting when at or over it. */
		tryAcquire(scope, limit) {
			const current = counts.get(scope) ?? 0;
			if (current >= limit) return false;
			counts.set(scope, current + 1);
			return true;
		},
		/** Decrement, deleting at zero; a release without a matching acquire is a no-op, never a throw. */
		release(scope) {
			const current = counts.get(scope) ?? 0;
			if (current <= 1) counts.delete(scope);
			else counts.set(scope, current - 1);
		},
		/** The current in-flight count for a scope (tests and future observability). */
		count(scope) {
			return counts.get(scope) ?? 0;
		},
	};
}
