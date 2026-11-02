/**
 * Scoped pause windows (REQ-SCOPED-PAUSE-WINDOWS): hold a folder/repo's runs "between certain times" and
 * resume automatically after. One `pause-windows.json` of `{ scope, from, to, tz?, days?, dateFrom?, dateTo? }`
 * entries; the worker defers a job whose scope is inside an active window via BullMQ's own delayed set
 * (DES-SCOPED-PAUSE-VIA-MOVE-TO-DELAYED). Deferred, never dropped — a paused github issue job runs after the
 * window, not lost.
 *
 * This module is pure and fs-injectable (mirrors triggers.mjs/schedules.mjs): `parsePauseWindows` validates
 * the file TEXT fail-loud, `loadPauseWindows` layers the one fs read on top, and `pauseUntilMs` is the
 * timezone-aware predicate the processor gate consumes. Timezones are handled with the built-in `Intl`
 * (no dependency, DST-correct via a one-pass offset correction).
 *
 * Custom: pause windows validated inline per triggers.mjs/config.mjs precedent; zod not in deps
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { configError } from "./config.mjs";
import { FORGE_KINDS, isForgeKind } from "./forges.mjs";
import { neededVersion, underDeclared, valueNeededVersion, valueUnderDeclared, versionProblem } from "./store-version.mjs";

/**
 * The highest pause windows file version this build reads (issue #761, `DES-STORE-VERSION-WHEN-NEEDED`): a top-level
 * `version`, absent meaning 1, written only when a window uses a field that needs more, so every file of today's
 * fields stays byte-identical.
 */
export const PAUSE_WINDOWS_VERSION = 1;

/**
 * The window fields `normalizeWindow` reads, in its order. The console's whole-list action checks a submitted window
 * against this list, and the version table's keys must come from it; a test holds it to the normalizer's own reads.
 */
export const PAUSE_WINDOW_FIELDS = Object.freeze(["scope", "from", "to", "tz", "days", "dateFrom", "dateTo"]);

/**
 * Each window field whose ABSENCE an older build would misread (a field that narrows when a window pauses, so a build
 * that drops it pauses at the wrong time), with the version that introduced it. Empty until a field needs one.
 */
export const PAUSE_WINDOW_FIELD_VERSIONS = Object.freeze({});

/**
 * Each EXISTING window field whose range a later release widens, as `field -> (value) => version` (the shared rule,
 * `valueNeededVersion`): a new `scope` form, say, or a new `days` form. An older build would refuse the whole file as
 * broken, keep its last good windows and run the jobs the new file pauses; a stamp makes it defer them instead.
 * Empty until a value needs one.
 */
export const PAUSE_WINDOW_VALUE_VERSIONS = Object.freeze({});

/**
 * The lowest version a list of RAW windows needs, from each window's own keys and their values: 1 while nothing needs
 * more. The highest window wins, whatever its place in the list.
 */
export function pauseWindowsVersionFor(windows, { table = PAUSE_WINDOW_FIELD_VERSIONS, valueTable = PAUSE_WINDOW_VALUE_VERSIONS } = {}) {
	let needed = 1;
	for (const w of Array.isArray(windows) ? windows : []) {
		if (w === null || typeof w !== "object") continue;
		const needs = Math.max(neededVersion(Object.keys(w), table), valueNeededVersion(w, valueTable));
		if (needs > needed) needed = needs;
	}
	return needed;
}

/**
 * Whether a writer must refuse the parsed document `doc`: `{ newer, message }` when its raw `version` is newer than
 * this build reads (`newer: true`) or is not an integer of 1 or more (`newer: false`), else null. The RAW version
 * only, never the full parser, so a file with one bad window can still be fixed by deleting that window; a writer
 * refuses the newer case (it would lose what a newer release wrote) and repairs the rest, the recorded posture.
 */
export function pauseWindowsVersionRefusal(doc, { supported = PAUSE_WINDOWS_VERSION } = {}) {
	if (doc === null || typeof doc !== "object" || Array.isArray(doc) || !Object.hasOwn(doc, "version")) return null;
	return versionProblem(doc.version, { supported, what: "pause-windows file" });
}

/**
 * The pause windows file text for `windows`, written over the parsed document `doc` the write started from (issue
 * #761): 2-space JSON and a trailing newline. Every top-level key of `doc` other than `windows` and `version` is
 * carried in its original place (the file is shared, and a writer from an older release must not delete a block a
 * newer one added), `windows` keeps its position (first when `doc` had none, the repair-from-empty shape), and
 * `version` leads only when the windows need more than 1. A `doc` whose only key is `windows`, or no `doc`, gives
 * exactly the bytes this file was always written with, `JSON.stringify({ windows }, null, 2)` plus the newline.
 * Built with `Object.defineProperty`, so a carried key named `__proto__` stays data.
 */
export function pauseWindowsText(doc, windows, { table = PAUSE_WINDOW_FIELD_VERSIONS, valueTable = PAUSE_WINDOW_VALUE_VERSIONS } = {}) {
	const rest = doc !== null && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
	const out = {};
	const put = (key, value) => Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
	const version = pauseWindowsVersionFor(windows, { table, valueTable });
	if (version > 1) put("version", version);
	if (!Object.hasOwn(rest, "windows")) put("windows", windows);
	for (const key of Object.keys(rest)) {
		if (key === "version") continue;
		put(key, key === "windows" ? windows : rest[key]);
	}
	return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * The weekdays a window's `days` may name, Sunday-first to match JS getUTCDay() and the Intl weekday index used in
 * zonedParts(). A `days` entry is read by its first three letters, lowercased. EXPORTED for the version bolt (issue
 * #761): a form added here is one an older build refuses, so it needs a `PAUSE_WINDOW_VALUE_VERSIONS.days` rule.
 */
export const DAYS = Object.freeze(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
const DAY_SET = new Set(DAYS);

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

/** "HH:MM" -> minutes since midnight in [0,1439]; throws `configError` on anything malformed. */
function parseHHMM(value, label, at, path) {
	const m = isNonEmptyString(value) ? /^([0-9]{1,2}):([0-9]{2})$/.exec(value.trim()) : null;
	if (!m) throw configError(`${at}: ${label} must be "HH:MM": ${JSON.stringify(value)} (${path})`);
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (h > 23 || min > 59) throw configError(`${at}: ${label} out of range 00:00-23:59: ${JSON.stringify(value)} (${path})`);
	return h * 60 + min;
}

/** Validate a "YYYY-MM-DD" calendar date; throws `configError` when malformed. */
function assertDate(value, label, at, path) {
	const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(String(value).trim());
	const mo = m && Number(m[2]);
	const d = m && Number(m[3]);
	if (!m || mo < 1 || mo > 12 || d < 1 || d > 31) {
		throw configError(`${at}: ${label} must be "YYYY-MM-DD": ${JSON.stringify(value)} (${path})`);
	}
}

/** Confirm an IANA zone by constructing a formatter (throws for an unknown zone); returns the zone. */
function validateTz(tz, at, path) {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return tz;
	} catch {
		throw configError(`${at}: tz is not a valid IANA timezone: ${JSON.stringify(tz)} (${path})`);
	}
}

/**
 * Parse, validate, and normalize the pause-windows file text. Returns an array of normalized windows
 * (unknown fields dropped; `fromMin`/`toMin` precomputed). Throws `configError` (fail-loud) on any malformed
 * entry. `path` is for messages only.
 *
 * The file's `version` is judged FIRST, before the windows (issue #761): a newer file's windows may use a shape this
 * build would call malformed, and the true message is "upgrade". A newer file throws a configError with
 * `.newer === true` (the worker defers jobs rather than misread a pause); a broken `version`, or a window using a field
 * or a value that needs a higher version than the file declares, throws the ordinary configError. `supported`, `table`
 * and `valueTable` are injectable for tests.
 */
export function parsePauseWindows(text, path, { supported = PAUSE_WINDOWS_VERSION, table = PAUSE_WINDOW_FIELD_VERSIONS, valueTable = PAUSE_WINDOW_VALUE_VERSIONS } = {}) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw configError(`pause-windows file is not valid JSON: ${path} (${error.message})`);
	}
	const problem = pauseWindowsVersionRefusal(parsed, { supported });
	if (problem) {
		const error = configError(`${problem.message}: ${path}`);
		if (problem.newer) error.newer = true;
		throw error;
	}
	const windows = parsed?.windows;
	if (!Array.isArray(windows)) {
		throw configError(`pause-windows file must have a "windows" array: ${path}`);
	}
	const normalized = windows.map((w, index) => normalizeWindow(w, index, path));
	windows.forEach((w, index) => {
		const short = underDeclared(Object.keys(w), table, parsed.version);
		if (short) throw configError(`pause window at index ${index}: ${short.field} needs pause-windows file version ${short.needs}, and the file declares ${parsed.version ?? 1}: ${path}`);
		const shortValue = valueUnderDeclared(w, valueTable, parsed.version);
		if (shortValue) throw configError(`pause window at index ${index}: ${shortValue.field} holds a value that needs pause-windows file version ${shortValue.needs}, and the file declares ${parsed.version ?? 1}: ${path}`);
	});
	return normalized;
}

function normalizeWindow(w, index, path) {
	const at = `pause window at index ${index}`;
	if (w === null || typeof w !== "object") throw configError(`${at}: must be an object: ${path}`);
	if (!isNonEmptyString(w.scope)) throw configError(`${at}: scope must be a non-empty string: ${path}`);
	// Issue #498: a qualified scope (`github:acme/web`) pauses one forge's repo, and a near miss (`gitub:acme/web`)
	// is refused rather than kept as a window that pauses nothing. A bare or folder scope is stored exactly as it was.
	let scope = w.scope.trim();
	if (scope !== "*") {
		let parsed;
		try {
			parsed = parseScopeString(scope);
		} catch (error) {
			throw configError(`${at}: ${error.message}: ${path}`);
		}
		if (parsed.type === "qualified") scope = `${parsed.kind}:${parsed.repo}`;
	}

	const fromMin = parseHHMM(w.from, "from", at, path);
	const toMin = parseHHMM(w.to, "to", at, path);
	// A from==to window would pause 24h forever and busy-defer; refuse it — remove the trigger instead.
	if (fromMin === toMin) {
		throw configError(`${at}: from and to must differ (a 24h pause is not expressible; remove the trigger): ${path}`);
	}

	const tz = w.tz === undefined ? "UTC" : validateTz(w.tz, at, path);

	let days = null;
	if (w.days !== undefined) {
		if (!Array.isArray(w.days) || w.days.length === 0) {
			throw configError(`${at}: days must be a non-empty array of weekday names (mon..sun): ${path}`);
		}
		days = w.days.map((d) => {
			const key = String(d).trim().toLowerCase().slice(0, 3);
			if (!DAY_SET.has(key)) throw configError(`${at}: unknown weekday ${JSON.stringify(d)} (use mon..sun): ${path}`);
			return key;
		});
	}

	let dateFrom = null;
	let dateTo = null;
	if (w.dateFrom !== undefined) { assertDate(w.dateFrom, "dateFrom", at, path); dateFrom = String(w.dateFrom).trim(); }
	if (w.dateTo !== undefined) { assertDate(w.dateTo, "dateTo", at, path); dateTo = String(w.dateTo).trim(); }
	if (dateFrom && dateTo && dateFrom > dateTo) throw configError(`${at}: dateFrom must be <= dateTo: ${path}`);

	const norm = { scope, from: w.from.trim(), to: w.to.trim(), fromMin, toMin, tz };
	if (days) norm.days = days;
	if (dateFrom) norm.dateFrom = dateFrom;
	if (dateTo) norm.dateTo = dateTo;
	return norm;
}

/**
 * Load and validate the pause-windows file named by `config.pauseWindowsFile`. Returns `[]` when the file is
 * unset (the feature is disabled — a valid deployment). `readFileSync`/`existsSync` are injectable for tests.
 */
export function loadPauseWindows(config, { readFileSync = fsReadFileSync, existsSync = fsExistsSync } = {}) {
	const path = config.pauseWindowsFile;
	if (path === null || path === undefined) return [];
	if (!existsSync(path)) throw configError(`pause-windows file does not exist: ${path}`);
	return parsePauseWindows(readFileSync(path, "utf8"), path);
}

// ── the timezone-aware predicate ────────────────────────────────────────────────────────────────────────

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock parts of instant `ms` in `tz`: `{ y, mo, d, hh, mi, dow }` (dow 0=Sun..6=Sat). */
function zonedParts(tz, ms, formatters = null) {
	const fmt = formatters?.get(tz) ?? new Intl.DateTimeFormat("en-US", {
		timeZone: tz, hour12: false,
		year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
	});
	if (formatters && !formatters.has(tz)) formatters.set(tz, fmt);
	const p = {};
	for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
	let hh = Number(p.hour);
	if (hh === 24) hh = 0; // some ICU builds render midnight as "24"
	return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), hh, mi: Number(p.minute), dow: WEEKDAY_INDEX[p.weekday] };
}

/**
 * Epoch ms for a wall-clock time `(y,mo,d,hh,mi)` in `tz`. One-pass offset correction: format the naive-UTC
 * guess back in `tz`, diff to recover the zone offset, subtract. Correct except the ~1h DST-transition seam,
 * which is immaterial for a pause boundary.
 */
function wallToMs(tz, y, mo, d, hh, mi, formatters = null) {
	const guess = Date.UTC(y, mo - 1, d, hh, mi);
	const shown = zonedParts(tz, guess, formatters);
	const shownAsUtc = Date.UTC(shown.y, shown.mo - 1, shown.d, shown.hh, shown.mi);
	return guess - (shownAsUtc - guess);
}

/** The date `delta` days from `parts`' date, computed at local noon to dodge DST edges. Returns zoned parts. */
function shiftDay(tz, parts, delta, formatters = null) {
	const noon = wallToMs(tz, parts.y, parts.mo, parts.d, 12, 0, formatters);
	return zonedParts(tz, noon + delta * 86400000, formatters);
}

function ymd(parts) {
	return `${String(parts.y).padStart(4, "0")}-${String(parts.mo).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
}

/** Whether a window occurrence STARTING on `parts`' day is allowed by its `days` and `dateFrom`/`dateTo`. */
function qualifies(w, parts) {
	if (w.days && !w.days.includes(DAYS[parts.dow])) return false;
	const date = ymd(parts);
	if (w.dateFrom && date < w.dateFrom) return false;
	if (w.dateTo && date > w.dateTo) return false;
	return true;
}

/** The end epoch ms of the window occurrence active at `nowMs`, or null if `now` is not inside `w`. Exported
 * so the admin panel can mark a single window "currently paused · resumes in …" without a synthetic job.
 * An optional caller-owned formatter cache lets a bounded calendar projection reuse clocks; the worker default
 * still constructs its clock per call, and both paths evaluate exactly the same wall-time rules. */
export function windowEndAt(w, nowMs, formatters = null) {
	const p = zonedParts(w.tz, nowMs, formatters);
	const nowMin = p.hh * 60 + p.mi;
	const endAt = (dateParts) => wallToMs(w.tz, dateParts.y, dateParts.mo, dateParts.d, Math.floor(w.toMin / 60), w.toMin % 60, formatters);

	if (w.fromMin < w.toMin) {
		// Same-day window: [from, to) today, starting today.
		if (nowMin >= w.fromMin && nowMin < w.toMin && qualifies(w, p)) return endAt(p);
		return null;
	}
	// Overnight window (from > to): started tonight (>= from, today qualifies) -> ends tomorrow at `to`,
	// or started last night (< to, yesterday qualified) -> ends today at `to`.
	if (nowMin >= w.fromMin && qualifies(w, p)) return endAt(shiftDay(w.tz, p, 1, formatters));
	if (nowMin < w.toMin && qualifies(w, shiftDay(w.tz, p, -1, formatters))) return endAt(p);
	return null;
}

/**
 * The scope key a window matches against: the folder for a local job, the repo for any forge-backed one.
 * Keyed on local rather than on a list of forges, so a new forge is scoped by its `repo` automatically --
 * an enumeration that forgot one would make that forge's jobs unpausable, which is a silent failure.
 */
export function scopeOf(job) {
	return job?.kind === "local" ? job?.folder : job?.repo;
}

/**
 * The forge-qualified scope of a job (issue #498): `<kind>:<repo>` (NFC) for a forge job, such as `github:acme/web` or
 * `forgejo:acme/web`, the folder unchanged for a local job, and null when a forge job has no `kind` or no `repo`.
 * `scopeOf` keeps returning the bare repo, because existing pause windows and scoped-limit rows match on it; this is
 * the second spelling a row may use to name exactly one forge's repo.
 */
export function qualifiedScopeOf(job) {
	if (job?.kind === "local") return job?.folder ?? null;
	if (!isNonEmptyString(job?.kind) || !isNonEmptyString(job?.repo)) return null;
	return `${job.kind}:${job.repo}`.normalize("NFC");
}

/**
 * One segment of a forge repo path: no `/`, `#`, `:` or control character, and no whitespace at its start or end.
 * Whitespace INSIDE a segment is allowed for every forge, because Azure DevOps project and repository names may hold
 * spaces (`Fabrikam Fiber/Web App`) and the receiver copies them verbatim. One rule for every kind is the simpler one;
 * its cost is that `github:acme web` loads as a cap that guards nothing, as a mistyped bare row always has.
 */
const REPO_SEGMENT = "[^/\\s#:\\u0000-\\u001f\\u007f](?:[^/#:\\u0000-\\u001f\\u007f]*[^/\\s#:\\u0000-\\u001f\\u007f])?";
/** A forge repo path: two or more `REPO_SEGMENT`s joined by single `/`, so none is empty. */
const QUALIFIED_REPO = new RegExp(`^${REPO_SEGMENT}(?:/${REPO_SEGMENT})+$`, "u");

/**
 * Classify a scope as written in an operator file (issue #498): `{ type, kind, repo }` where `type` is
 *   - `local`: an absolute folder path (platform-native `isAbsolute`), or a path with a one-letter drive prefix
 *     (`C:\srv`), which keeps the handling it always had: verbatim, and inert on a POSIX worker;
 *   - `qualified`: `<forge kind>:<repo>`, `kind` one of `FORGE_KINDS` and `repo` the NFC rest;
 *   - `bare`: anything else, such as `owner/name`, which matches that repo on every forge.
 * A `<word>:` prefix (no `/` before the first `:`) that is not a forge kind THROWS a `configError` naming the known
 * kinds: `gitub:acme/web` would otherwise be a row that guards nothing while it reads as a cap. For the same reason a
 * qualified repo must have a forge repo's shape (`QUALIFIED_REPO`): two or more `/`-separated segments, so no leading
 * or trailing `/` and no `//`, no control character, `#` or `:` in any segment, and no whitespace at a segment's start
 * or end (inside one it is allowed: Azure DevOps names may hold spaces). That refuses the
 * likely slips (`github:acme/web/`, a `#12` pasted from a run target, a doubled `github:github:` prefix), each of which
 * no delivery's repo can ever equal. The split is at the
 * FIRST `:`, which is safe because no forge allows `:` in a repo or project path: GitHub, GitLab and Forgejo names
 * are `[A-Za-z0-9._-]` segments, and Azure DevOps refuses `:` in project and repository names. `"*"` is the caller's
 * business (pause windows accept it, scoped limits refuse it) and is not classified here. The message carries no path:
 * the caller adds which entry and which file.
 */
export function parseScopeString(text) {
	const scope = String(text).trim().normalize("NFC");
	if (isAbsolute(scope) || /^[A-Za-z]:/.test(scope)) return { type: "local", kind: null, repo: null };
	const m = /^([^/\\:]+):(.*)$/s.exec(scope);
	if (m === null) return { type: "bare", kind: null, repo: null };
	if (!isForgeKind(m[1])) throw configError(`scope ${JSON.stringify(scope)} starts with an unknown prefix "${m[1]}:" (a forge-qualified scope starts with one of ${FORGE_KINDS.join(", ")}, such as github:owner/name)`);
	if (m[2].trim() === "") throw configError(`scope ${JSON.stringify(scope)} names a forge and no repo (write ${m[1]}:owner/name)`);
	const repo = m[2].trim();
	if (!QUALIFIED_REPO.test(repo)) throw configError(`scope ${JSON.stringify(scope)} is not a forge repo after "${m[1]}:" (write ${m[1]}:owner/name: segments separated by single "/", no "#", ":" or control characters, and no space at the start or end of a segment), so it would guard nothing`);
	return { type: "qualified", kind: m[1], repo };
}

/**
 * A row scope as a forge comment names it (issue #498): the repo without its forge prefix, so a refusal posted on
 * `acme/web` reads "acme/web" whether the row was written bare or qualified. Any other scope is returned unchanged.
 */
export function unqualifiedScope(scope) {
	if (typeof scope !== "string") return scope;
	const colon = scope.indexOf(":");
	return colon > 0 && isForgeKind(scope.slice(0, colon)) ? scope.slice(colon + 1) : scope;
}

/**
 * When, in epoch ms, the current pause for this job's scope ends — or `null` when the job is not paused. A
 * job is paused if `now` falls inside any scope-matching window (`scope === "*"` matches every scope); the
 * latest end among active windows is returned so a single deferral clears them all (re-checked on wake).
 * A window matches on the RAW `scopeOf` value (so every existing bare window keeps matching every forge, as before)
 * or on the job's `qualifiedScopeOf` (issue #498: `github:acme/web` pauses the GitHub job and not the Forgejo one).
 */
export function pauseUntilMs(windows, job, nowMs) {
	if (!Array.isArray(windows) || windows.length === 0) return null;
	const scope = scopeOf(job);
	if (!isNonEmptyString(scope)) return null;
	const qualified = qualifiedScopeOf(job);
	let end = null;
	for (const w of windows) {
		if (w.scope !== "*" && w.scope !== scope && w.scope !== qualified) continue;
		const e = windowEndAt(w, nowMs);
		if (e !== null && (end === null || e > end)) end = e;
	}
	return end;
}
