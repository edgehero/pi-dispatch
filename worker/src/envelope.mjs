/**
 * The allocation envelope (issue #504, INT-ENVELOPE-FILE-CONTRACT): the operator's outer limits for delegated
 * allocation. One `envelope.json` of a total per window, a floor per project, default weights and the delegation
 * rules. An agent's plan moves headroom between projects INSIDE it (priorities.mjs); nothing an agent writes reaches
 * this file.
 *
 * Pure and fs-injectable, on the scoped-limits.mjs and projects.mjs pattern: `parseEnvelope` judges the file TEXT
 * fail-loud, `loadEnvelope` layers the one fs read on top. The worker will hold the parsed envelope in a watched ref
 * with a last-good copy, as it does the projects file.
 *
 * `version` is REQUIRED and a newer one is refused: this is a money file, and a field an old build silently drops
 * could widen what a plan may move. Unknown keys are REFUSED here, stricter than the operator-file policy that drops
 * them in scoped-limits.json and projects.json: a mistyped `maxStepPct` dropped in silence would read as a bound the
 * file does not hold, and every key in this file is a bound.
 *
 * Every refusal names the field, never a value: a value typed into the wrong field could be anything.
 *
 * Custom: envelope validated inline per scoped-limits.mjs precedent; zod not in deps
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, realpathSync as fsRealpathSync, statSync as fsStatSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { configError } from "./config.mjs";
import { fingerprint } from "./fingerprint.mjs";
import { formatMicros, parseUsdMicros } from "./money.mjs";
import { OTHER, PLAN_WRITERS, WEIGHT_MAX } from "./priorities.mjs";
import { isProjectId } from "./project-id.mjs";

/** The highest schema version this build reads. A file declaring a higher one is refused loudly. */
export const ENVELOPE_VERSION = 1;
/** The windows an envelope may govern: the UTC day, the Monday week and the month of budget.mjs's keys. */
export const ENVELOPE_WINDOWS = Object.freeze(["day", "week", "month"]);
/** Each window's operator dollar field on a scoped-limits row (`project:<id>`). */
const WINDOW_USD_FIELD = Object.freeze({ day: "dayUsd", week: "weekUsd", month: "monthUsd" });
/** Each window's row fields that bound it: its own and every LONGER window's, since a week cap also caps each day in it. */
const BOUNDING_FIELDS = Object.freeze({ day: ["dayUsd", "weekUsd", "monthUsd"], week: ["weekUsd", "monthUsd"], month: ["monthUsd"] });

/** The longest interval and plan lifetime a file may set: a year. Beyond it a value is a typo, not a policy. */
const MAX_INTERVAL_HOURS = 24 * 366;
const MAX_PLAN_DAYS = 366;

const TOP_KEYS = new Set(["version", "window", "totalUsd", "floorsUsd", "defaultWeights", "delegation"]);
const DELEGATION_KEYS = new Set(["enabled", "writers", "maxStepPct", "minIntervalHours", "maxPlanDays"]);

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refuseUnknown(object, allowed, at, path) {
	const extra = Object.keys(object).filter((k) => !allowed.has(k)).length;
	// Counted, never quoted: the key itself may be anything an editor produced.
	if (extra > 0) throw configError(`envelope file: ${at} has ${extra} unknown key(s); the fields are ${[...allowed].join(", ")}: ${path}`);
}

/**
 * A floor: `parseUsdMicros`'s rules (a plain decimal, at most 6 decimals, a string recommended), except that 0 is a
 * floor and not a refusal. A floor of 0 is the honest "no guaranteed share", and `_other`'s default.
 */
function floorMicros(value, field, path) {
	if (value === 0 || (typeof value === "string" && /^0(\.0{1,6})?$/.test(value))) return 0;
	try {
		return parseUsdMicros(value, field);
	} catch (error) {
		throw configError(`envelope file: ${error.message.replace(/above 0/, "of 0 or more")}: ${path}`);
	}
}

/**
 * Parse, validate and normalize the envelope file TEXT. Returns
 * `{ version, window, totalMicros, floors, defaultWeights, delegation }`:
 *   - `floors`: `{ id: micros }` for every project the file names and `_other` (floor 0 when absent);
 *   - `defaultWeights`: `{ id: weight }` for the same entries, each 1 when absent;
 *   - `delegation`: `{ enabled, writers, maxStepPct, minIntervalHours, maxPlanDays }`, `enabled` false and the rest
 *     null when the file has no `delegation`.
 * Throws `configError` on anything malformed. `path` is for messages only.
 *
 * `projects` (the parsed projects.json) and `limits` (the parsed scoped-limits.json) are what the floors are judged
 * against: a floor names a project or `_other`, and a project's operator dollar row for the envelope's window may not
 * sit below its floor. `maxCostMicros` is the deployment's per-job cost cap, or null: an envelope needs one, because
 * every governed job reserves its per-job cap against its project's allocation.
 */
export function parseEnvelope(text, path, { projects = [], limits = [], maxCostMicros = null } = {}) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		// Not the parser's own message: it quotes file text around the fault.
		const at = /position (\d+)/.exec(String(error?.message))?.[1];
		throw configError(`envelope file is not valid JSON${at === undefined ? "" : ` (at character ${at})`}: ${path}`);
	}
	if (!isPlainObject(raw)) throw configError(`envelope file must be an object with "version", "window", "totalUsd" and "floorsUsd": ${path}`);
	const version = raw.version;
	if (!Number.isInteger(version) || version < 1) throw configError(`envelope file must have "version": ${ENVELOPE_VERSION} (an integer >= 1): ${path}`);
	if (version > ENVELOPE_VERSION) throw configError(`envelope file written by a newer pi-dispatch (version ${version}; this build understands ${ENVELOPE_VERSION}): ${path}`);
	refuseUnknown(raw, TOP_KEYS, "the file", path);

	// A per-job cap first: without one no governed job can reserve, so every such job would refuse as a configuration
	// error, and an envelope that admits nothing is a mistake the boot should name.
	// A positive safe integer of micro-dollars, nothing else: 0 would be a cap that admits no priced call, and a string
	// or a float here is a caller's defect that must not read as "a cap is set".
	if (!Number.isSafeInteger(maxCostMicros) || maxCostMicros <= 0) {
		throw configError(`envelope file needs a per-job cost cap: set PI_MAX_COST_USD (each job governed by the envelope reserves its per-job cap against its project's allocation): ${path}`);
	}

	if (!ENVELOPE_WINDOWS.includes(raw.window)) throw configError(`envelope file: window must be one of ${ENVELOPE_WINDOWS.join(", ")}: ${path}`);
	const window = raw.window;

	let totalMicros;
	try {
		totalMicros = parseUsdMicros(raw.totalUsd, "totalUsd");
	} catch (error) {
		throw configError(`envelope file: ${error.message}: ${path}`);
	}

	if (!isPlainObject(raw.floorsUsd)) throw configError(`envelope file: floorsUsd must be an object of project id to dollars: ${path}`);
	const known = new Set((Array.isArray(projects) ? projects : []).map((p) => p?.id));
	const floors = {};
	for (const id of Object.keys(raw.floorsUsd).sort()) {
		checkEntryId(id, known, "floorsUsd", path);
		floors[id] = floorMicros(raw.floorsUsd[id], `floorsUsd.${id}`, path);
	}
	if (floors[OTHER] === undefined) floors[OTHER] = 0;
	const sum = Object.values(floors).reduce((s, v) => s + v, 0);
	if (sum > totalMicros) throw configError(`envelope file: the floors add up to ${formatMicros(sum)}, above totalUsd ${formatMicros(totalMicros)}: ${path}`);

	const defaultWeights = {};
	if (raw.defaultWeights !== undefined) {
		if (!isPlainObject(raw.defaultWeights)) throw configError(`envelope file: defaultWeights must be an object of project id to weight: ${path}`);
		for (const id of Object.keys(raw.defaultWeights)) {
			checkEntryId(id, known, "defaultWeights", path);
			if (floors[id] === undefined) throw configError(`envelope file: defaultWeights.${id} names a project with no floor; add it to floorsUsd (0 is a floor): ${path}`);
			const w = raw.defaultWeights[id];
			if (!Number.isInteger(w) || w < 0 || w > WEIGHT_MAX) throw configError(`envelope file: defaultWeights.${id} must be an integer from 0 to ${WEIGHT_MAX}: ${path}`);
		}
	}
	for (const id of Object.keys(floors).sort()) defaultWeights[id] = raw.defaultWeights?.[id] ?? 1;

	checkRowsAgainstFloors(floors, window, limits, path);
	const delegation = parseDelegation(raw.delegation, path);
	return { version, window, totalMicros, floors, defaultWeights, delegation };
}

/** A key of `floorsUsd` or `defaultWeights`: `_other`, or a project id that projects.json has. */
function checkEntryId(id, known, field, path) {
	if (id === OTHER) return;
	// The id is quoted only once it is known to match the id charset: it then cannot carry a control byte or a path.
	if (!isProjectId(id)) throw configError(`envelope file: a key of ${field} is neither ${OTHER} nor a project id: ${path}`);
	if (!known.has(id)) throw configError(`envelope file: ${field}.${id} names a project that is not in the projects file; add the project there first, or remove the key: ${path}`);
}

/**
 * A project's operator dollar row (`project:<id>` in scoped-limits.json) for the envelope's window OR A LONGER ONE, below
 * the project's floor, refuses the file and names both. The allocation can only lower a project's cap
 * (`min(row, allocation)`), so such a floor promises money the operator's own row never lets the project spend: a
 * `weekUsd` of $1 bounds every day of that week, so a day floor of $50 under it is as empty as a day row of $1. A
 * shorter row (a `dayUsd` under a week envelope) is not compared: seven days of it may still reach the floor.
 */
function checkRowsAgainstFloors(floors, window, limits, path) {
	for (const [id, floor] of Object.entries(floors)) {
		if (id === OTHER || floor === 0) continue;
		const row = (Array.isArray(limits) ? limits : []).find((l) => l?.scope === `project:${id}`);
		for (const field of BOUNDING_FIELDS[window]) {
			const value = row?.[field];
			if (value === null || value === undefined) continue;
			const cap = parseUsdMicros(value, field);
			if (cap < floor) {
				throw configError(`envelope file: floorsUsd.${id} (${formatMicros(floor)}) is above the scoped-limits row project:${id} ${field} (${formatMicros(cap)}); lower the floor or raise the row: ${path}`);
			}
		}
	}
}

/** The `delegation` block, normalized. Absent means off. When on, every bound is required: none has a silent default. */
function parseDelegation(raw, path) {
	if (raw === undefined) return { enabled: false, writers: [], maxStepPct: null, minIntervalHours: null, maxPlanDays: null };
	if (!isPlainObject(raw)) throw configError(`envelope file: delegation must be an object: ${path}`);
	refuseUnknown(raw, DELEGATION_KEYS, "delegation", path);
	if (typeof raw.enabled !== "boolean") throw configError(`envelope file: delegation.enabled must be true or false: ${path}`);
	const out = { enabled: raw.enabled, writers: [], maxStepPct: null, minIntervalHours: null, maxPlanDays: null };
	const need = raw.enabled;
	if (raw.writers !== undefined || need) {
		if (!Array.isArray(raw.writers) || raw.writers.length === 0 || raw.writers.some((w) => !PLAN_WRITERS.includes(w)) || new Set(raw.writers).size !== raw.writers.length) {
			throw configError(`envelope file: delegation.writers must be a non-empty list of distinct writers from ${PLAN_WRITERS.join(", ")}: ${path}`);
		}
		out.writers = [...raw.writers].sort();
	}
	if (raw.maxStepPct !== undefined || need) {
		// 0 is refused: delegation that may move nothing is delegation off, and `enabled: false` says that plainly.
		if (!Number.isInteger(raw.maxStepPct) || raw.maxStepPct < 1 || raw.maxStepPct > 100) {
			throw configError(`envelope file: delegation.maxStepPct must be an integer from 1 to 100 (to stop plans, set delegation.enabled to false): ${path}`);
		}
		out.maxStepPct = raw.maxStepPct;
	}
	if (raw.minIntervalHours !== undefined || need) {
		if (!Number.isInteger(raw.minIntervalHours) || raw.minIntervalHours < 0 || raw.minIntervalHours > MAX_INTERVAL_HOURS) {
			throw configError(`envelope file: delegation.minIntervalHours must be an integer from 0 to ${MAX_INTERVAL_HOURS}: ${path}`);
		}
		out.minIntervalHours = raw.minIntervalHours;
	}
	if (raw.maxPlanDays !== undefined || need) {
		if (!Number.isInteger(raw.maxPlanDays) || raw.maxPlanDays < 1 || raw.maxPlanDays > MAX_PLAN_DAYS) {
			throw configError(`envelope file: delegation.maxPlanDays must be an integer from 1 to ${MAX_PLAN_DAYS}: ${path}`);
		}
		out.maxPlanDays = raw.maxPlanDays;
	}
	return out;
}

/**
 * Load and validate the envelope file named by `config.envelopeFile`. Returns null when it is unset: no envelope, no
 * delegation anywhere, and every cap exactly as the operator's rows and windows set it. An empty string is a value, so
 * it reaches `existsSync` and is refused, the rule the projects and scoped-limits keys follow. `context` is
 * `parseEnvelope`'s. `readFileSync`/`existsSync` are injectable for tests.
 */
export function loadEnvelope(config, context = {}, { readFileSync = fsReadFileSync, existsSync = fsExistsSync } = {}) {
	const path = config.envelopeFile;
	if (path === null || path === undefined) return null;
	if (!existsSync(path)) throw configError(`envelope file does not exist: ${path}`);
	return parseEnvelope(readFileSync(path, "utf8"), path, context);
}

/**
 * The 16-hex digest of a normalized envelope (`fingerprint.mjs`: sorted keys, sha256). Two hosts with one envelope
 * have one digest, whatever the file's whitespace or key order; a host whose digest differs from the applied plan's
 * refuses governed jobs (issue #504 part 7). A digest, never the values, so it is admissible in a host row.
 */
export function envelopeDigest(envelope) {
	return fingerprint(envelope);
}

/** A file's identity: its device and inode, as `stat` with `bigint` reports them. Two names of one file share it. */
function identityOf(stat) {
	return `${stat.dev}:${stat.ino}`;
}

/**
 * `stat(path)` with `bigint`, following links as the kernel does, or null when nothing is there (ENOENT, ENOTDIR). Any
 * other failure is a configuration error naming the path: a path the worker cannot stat is one it cannot vouch for.
 */
function statOrNull(path, statSync, what) {
	try {
		return statSync(path, { bigint: true });
	} catch (error) {
		if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
		throw configError(`${what} ${JSON.stringify(String(path))} cannot be read (${error?.code ?? "error"}), so the envelope's containment check cannot judge it`);
	}
}

/**
 * The job path's candidate locations, as path strings to `stat`. A job path's spelling is never a reason to refuse;
 * instead it is judged at every location it can name:
 *   - the KERNEL's: absolutized WITHOUT normalizing (a relative path is appended to the working directory) and handed
 *     raw to `stat`, so `/srv/a/link/../b` follows the link first, then `..`;
 *   - the TEXTUAL one, `resolve(raw)`: what a container runtime mounts. Docker cleans a bind source as text before
 *     mounting it, so `T/link/../b` mounts `T/b` whatever `T/link` points at, and a container can write there;
 *   - for a RELATIVE path, both again against the shell's working directory: the Docker and Podman CLIs absolutize a
 *     relative bind source with Go's `filepath.Abs`, whose `os.Getwd` returns `$PWD` when `$PWD` names the working
 *     directory, possibly through a symlink or a firmlink, so `./../y` from such a cwd reaches the LOGICAL parent,
 *     not the physical one `process.cwd()` gives. Added when `$PWD` is absolute and has the cwd's identity (device and
 *     inode): Go's own `SameFile` test, so this is exactly when Go uses it.
 */
function jobPathCandidates(path, cwd, env, statSync) {
	const bases = [cwd];
	if (!isAbsolute(path)) {
		// env-internal PWD: the shell's logical working directory, read only to see the cwd the way Go's os.Getwd does.
		const pwd = env?.PWD;
		if (typeof pwd === "string" && isAbsolute(pwd) && pwd !== cwd) {
			let same = false;
			try {
				same = identityOf(statSync(pwd, { bigint: true })) === identityOf(statSync(cwd, { bigint: true }));
			} catch {
				same = false;
			}
			if (same) bases.push(pwd);
		}
	}
	const candidates = [];
	for (const base of isAbsolute(path) ? [null] : bases) {
		const raw = base === null ? path : `${base}${sep}${path}`;
		candidates.push(raw, resolve(raw));
	}
	return candidates;
}

/**
 * The envelope path, checked to be its own CANONICAL path, and its real path back. Absolute, and
 * `realpathSync.native(path) === path`: no symlink anywhere on the way, no `.` or `..`, no case variant, no firmlink
 * spelling. A symlink on the way could sit inside a job path, however far up the chain, and the job could repoint it;
 * requiring the canonical path removes every such link instead of chasing them. The refusal names the canonical path
 * to write instead, when there is one. The FILE must exist (the check runs with a successful load) and must have one
 * link: a hard link elsewhere is the same file under a name this check cannot see, and it could sit in a job path.
 */
function canonicalEnvelopePath(path, realpath, statSync) {
	const text = String(path);
	if (!isAbsolute(text)) throw configError(`the envelope path ${JSON.stringify(text)} must be absolute: write its canonical path, with no symlink, "." or ".." in it`);
	let real;
	try {
		real = realpath(text);
	} catch (error) {
		throw configError(`the envelope path ${JSON.stringify(text)} cannot be resolved (${error?.code ?? "error"}); the containment check needs the file to exist at its canonical path`);
	}
	if (real !== text) {
		throw configError(`the envelope path ${JSON.stringify(text)} is not its own canonical path; write ${JSON.stringify(real)} instead (no symlink, ".", "..", case variant or alias anywhere on the way), so no link a job can repoint leads to it`);
	}
	const stat = statSync(text, { bigint: true });
	// Before the link count: a directory's nlink counts its subdirectories, so "has 3 hard links" would misname it.
	if (!stat.isFile()) {
		throw configError(`the envelope path ${JSON.stringify(text)} is not a regular file; point it at the envelope file itself`);
	}
	if (stat.nlink > 1n) {
		throw configError(`the envelope file ${JSON.stringify(text)} has ${stat.nlink} hard links; a second name of the file could sit inside a job path, so keep exactly one`);
	}
	return real;
}

/**
 * The identities (device and inode) of the envelope file and every directory above it. A job path "contains" the
 * envelope exactly when one of its locations has one of these identities: identity, not spelling, so a firmlink
 * (`/System/Volumes/Data/Users` and `/Users` on macOS), a bind-mount alias, a case variant or any other second name of
 * a job path is judged as the directory it is. Equality counts: a job path that IS the envelope's folder exposes the
 * file as surely as its parent does.
 */
function envelopeIdentities(real, statSync) {
	const out = new Set();
	let p = real;
	for (;;) {
		const st = statOrNull(p, statSync, "the envelope path's ancestor");
		if (st !== null) out.add(identityOf(st));
		const parent = dirname(p);
		if (parent === p) break;
		p = parent;
	}
	return out;
}

/**
 * The first host path a job container can see that holds the envelope file, as `{ kind, path }`, or null. The boot
 * refuses an envelope inside one (issue #504 part 3): a job that can write the envelope can write its own bounds.
 * `kind` is `cron-folder` (a cron trigger's `run.folder`, bind-mounted read-write), `run-root` (a
 * `PI_DISPATCH_RUN_ROOTS` root, where `dispatch_run` and chained jobs run), `skills-dir` (a trigger's `run.skillsDir`,
 * copied in) or `global-pi-dir` (`PI_GLOBAL_PI_DIR`). `path` is the configured job path, as the operator wrote it.
 *
 * The envelope path must be its own canonical path, and the file must have one link (`canonicalEnvelopePath`).
 * Containment is then decided by FILE IDENTITY (device and inode), never by comparing path strings: a job path contains
 * the envelope when any of its locations (`jobPathCandidates`) is the envelope's folder or a directory above it
 * (`envelopeIdentities`). A job path is skipped only when none of its locations exists. Residual, named: a host bind
 * mount of the envelope's folder placed under a job path is a second view this check cannot see; do not make one.
 *
 * Throws `configError` when the envelope path is not canonical or the file has more than one link, when a run root is
 * relative, and when a path cannot be read for a reason other than its absence. `realpathSync`, `statSync`, `cwd` and
 * `env` are injectable for tests.
 */
export function envelopeInsideJobPaths(envelopePath, { cronFolders = [], runRoots = [], skillsDirs = [], globalPiDir = null } = {}, { realpathSync = fsRealpathSync.native, statSync = fsStatSync, cwd = process.cwd(), env = process.env } = {}) {
	const real = canonicalEnvelopePath(envelopePath, realpathSync, statSync);
	// A relative run root is refused under an envelope, as `PI_GLOBAL_PI_DIR` and `run.skillsDir` already must be
	// absolute: the worker would judge it against its own working directory, while the admin's `dispatch_run` resolves
	// it in the operator's pi process, so the two could mean different folders.
	for (const root of runRoots ?? []) {
		if (typeof root === "string" && root.trim() !== "" && !isAbsolute(root)) {
			throw configError(`the run root ${JSON.stringify(root)} in PI_DISPATCH_RUN_ROOTS is relative; with an envelope set, every run root must be an absolute path, so the worker and the admin judge one folder`);
		}
	}
	const identities = envelopeIdentities(real, statSync);
	const groups = [
		["cron-folder", cronFolders],
		["run-root", runRoots],
		["skills-dir", skillsDirs],
		["global-pi-dir", globalPiDir === null || globalPiDir === undefined ? [] : [globalPiDir]],
	];
	for (const [kind, paths] of groups) {
		for (const p of paths ?? []) {
			if (typeof p !== "string" || p.trim() === "") continue;
			for (const candidate of jobPathCandidates(p, cwd, env, statSync)) {
				const st = statOrNull(candidate, statSync, "a job path");
				if (st !== null && identities.has(identityOf(st))) return { kind, path: p };
			}
		}
	}
	return null;
}
