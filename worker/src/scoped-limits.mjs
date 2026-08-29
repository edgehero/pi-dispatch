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
 * Custom: scoped limits validated inline per triggers.mjs/pause-windows.mjs precedent; zod not in deps
 */

import { createHash } from "node:crypto";
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { configError } from "./config.mjs";
import { scopeOf } from "./pause-windows.mjs";

/** The schema version this build reads and writes. A file declaring a higher one is refused loudly. */
export const SCOPED_LIMITS_VERSION = 1;

/** The four limit fields a row may carry, in display order. */
const LIMIT_FIELDS = ["day", "week", "month", "concurrent"];

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
 * (every row rebuilt as an explicit `{ scope, day, week, month, concurrent }` literal, `null` for absent
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
		throw configError(`scoped-limits file must have "version": 1 (an integer >= 1): ${path}`);
	}
	if (version > SCOPED_LIMITS_VERSION) {
		throw configError(`scoped-limits file written by a newer pi-dispatch (version ${version}; this build understands ${SCOPED_LIMITS_VERSION}): ${path}`);
	}
	if (!Array.isArray(parsed.limits)) {
		throw configError(`scoped-limits file must have a "limits" array: ${path}`);
	}
	const rows = parsed.limits.map((row, index) => normalizeLimit(row, index, path));
	const seen = new Map();
	rows.forEach((row, index) => {
		if (seen.has(row.scope)) {
			// Two rows for one scope is a precedence question with no right answer; the admin's
			// edit-in-place never produces one, so a duplicate is always a hand-edit mistake.
			throw configError(`scoped limit at index ${index}: duplicate scope ${JSON.stringify(row.scope)} (first at index ${seen.get(row.scope)}): ${path}`);
		}
		seen.set(row.scope, index);
	});
	return rows;
}

function normalizeLimit(row, index, path) {
	const at = `scoped limit at index ${index}`;
	if (row === null || typeof row !== "object" || Array.isArray(row)) {
		throw configError(`${at}: must be an object: ${path}`);
	}
	if (!isNonEmptyString(row.scope)) throw configError(`${at}: scope must be a non-empty string: ${path}`);
	const trimmed = row.scope.trim().normalize("NFC"); // the same NFC canonicalScope applies job-side
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
	const norm = {
		// An absolute path is stored resolved so a `/srv/site/` row governs `/srv/site` jobs -- the same
		// collapse canonicalScope applies on the job side. isAbsolute is PLATFORM-NATIVE on purpose, so a
		// foreign-platform row (a windows drive path on a POSIX worker) stays verbatim and is inert here;
		// the doctor's unreferenced-scope advisory names it. Resolving it instead would "work" only by
		// both sides mangling into the same cwd-prefixed string -- a match by accident, not by contract.
		scope: isAbsolute(trimmed) ? resolve(trimmed) : trimmed,
		day: null,
		week: null,
		month: null,
		concurrent: null,
	};
	let any = false;
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
		throw configError(`${at}: at least one of day, week, month, concurrent is required (a row that limits nothing is a row an operator sets and then trusts): ${path}`);
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
 * The exact-match row for a canonical scope, or null. Exact string equality only -- the pause matcher's
 * semantics minus its "*" (refused above). With duplicates refused there is no precedence ladder.
 */
export function limitFor(limits, scope) {
	if (!Array.isArray(limits) || !isNonEmptyString(scope)) return null;
	return limits.find((l) => l.scope === scope) ?? null;
}

/**
 * The scoped budget windows this job reserves against, or null when nothing applies (no row for the
 * scope, or the row is concurrency-only). The returned `scope` is CANONICAL so the redis counters are
 * spelling-stable. Shaped like the global `caps` object so `reserveBudget` consumes it unchanged.
 */
export function budgetCapsFor(job, limits) {
	const scope = canonicalScope(job);
	const row = limitFor(limits, scope);
	if (!row || (row.day === null && row.week === null && row.month === null)) return null;
	return { scope, caps: { day: row.day, week: row.week, month: row.month } };
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
	const configured = limitFor(limits, scope)?.concurrent ?? Infinity;
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
	const h = createHash("sha256").update(String(scope)).digest("hex").slice(0, 16);
	return `budget:s:${h}`;
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
