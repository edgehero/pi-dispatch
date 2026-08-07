/**
 * Staged pi packages (issue #58): pinned third-party pi packages that live INSIDE the operator's global
 * overlay at `<PI_GLOBAL_PI_DIR>/packages/<dir>/`. That overlay is already mounted `/opt/pi-global:ro`
 * into every job container (REQ-GLOBAL-PI-OVERLAY), so staged packages need no new mount and no new
 * trust boundary -- they ride the one the overlay already established.
 *
 * A staged package is a SELF-CONTAINED directory (its `package.json` plus its own `node_modules/`).
 * pi's package resolver treats any spec that is not `npm:`/`git:`/a URL as a LOCAL path: it resolves the
 * directory in place -- no install, no network, no writes -- and a `pi` manifest there contributes
 * extensions, skills, prompts and themes. That is precisely what lets a job container load them with
 * network egress denied, which is the whole point of staging at all.
 *
 * Versions are EXACT, never a range (CONST-PI-VERSION-PINNED): a floating range turns a silent upstream
 * minor into every queued job becoming a no-op with NO signal -- the queue still reports success, the
 * worst failure class available. Pinning converts that into an operator-visible edit of a version string.
 *
 * Three directions, three error policies:
 *   - `parsePackagesFile` reads the OPERATOR's `pi-packages.json` before anything is staged. Pure and
 *     fs-free (mirrors triggers.mjs), fail-loud `configError` naming the offending package.
 *   - `mergeHostPackages` folds in what host-pi.mjs discovered in the operator's own pi setup (issue #102).
 *     Declared entries win; a discovered one that fails validation is DROPPED with a reason rather than
 *     taking the declared set down with it.
 *   - `readStageManifest` reads the file the STAGER wrote, at job-wiring time. It NEVER throws: a corrupt
 *     manifest must degrade to "no staged packages", not crash the worker mid-queue.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configError } from "./config.mjs";
// ENTRY_NAME_RE / ADMIN_RE are import-pi's -- imported rather than re-declared so the staged dir charset
// and the admin block cannot drift between the stager and this validator (doctor.mjs sets the precedent
// of importing from import-pi.mjs).
import { ADMIN_RE, ENTRY_NAME_RE } from "./import-pi.mjs";
// The container-side mount point is docker-run.mjs's fact -- IMPORTED, never re-typed, so the mount and the
// packages root below cannot drift apart while both test suites stay green. docker-run.mjs is dependency-free
// (it builds an argv array and nothing else), so this costs no cycle and no weight in the admin's bundle.
import { CONTAINER_GLOBAL_PI_DIR } from "./docker-run.mjs";

/** Staged packages live under `<globalPiDir>/packages/` -- a subdir of the overlay, not a new mount. */
export const PACKAGES_SUBDIR = "packages";
/** The stager's receipt, written alongside the staged dirs: what was staged, at which exact version. */
export const STAGE_MANIFEST = "packages.json";
/** Where the staged packages land inside the job container -- the overlay mount plus the one subdir. */
export const CONTAINER_PACKAGES_ROOT = `${CONTAINER_GLOBAL_PI_DIR}/${PACKAGES_SUBDIR}`;

/** An exact semver -- prerelease and build metadata allowed, ranges/tags/wildcards are not. */
export const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** An npm package name: lowercase, optionally `@scope/`-prefixed. */
export const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * The pi resource kinds a package may contribute by convention dir, when it carries no `pi` manifest.
 * Lives here rather than in import-pi.mjs because host-pi.mjs needs the same list to decide whether a
 * package the operator installed is a pi package at all, and a third module importing from import-pi.mjs
 * would add an edge to the import-pi <-> packages cycle that only survives because both sides use their
 * bindings at call time.
 *
 * This list is pi's, not ours: at the 0.80.7 pin `collectPackageResources` falls through to exactly these
 * four directory names when `readPiManifest` returns null, so a package with no `pi` key and a `skills/`
 * dir IS a pi package. See host-pi.mjs's PINNED_PI_NEEDLES for the assertion that keeps that true.
 */
export const RESOURCE_DIRS = ["extensions", "skills", "prompts", "themes"];

/** Where a staged entry came from: the operator's file, or discovery of their pi setup. */
export const FROM_DECLARED = "pi-packages";
export const FROM_HOST = "host";

/** npm's hard limit on a package name; a longer one could never have been published. */
const MAX_NAME_LENGTH = 214;
/** The staged dir name doubles as a path segment in the container, so it stays short and flat. */
const MAX_DIR_LENGTH = 64;

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

/**
 * The default staged dir for a package name: `@scope/name` -> `scope__name`. A flat, slash-free segment,
 * because the staged dir is one path component under `packages/` -- keeping the scope in the name (rather
 * than nesting a `scope/` dir) keeps `<packages>/<dir>` a single validated segment on both host and
 * container.
 */
export function stagedDirName(name) {
	return String(name).replace(/^@/, "").replace(/\//g, "__");
}

/**
 * Parse, validate, and normalize the operator's packages file TEXT. Returns `[{ name, version, dir }]`
 * with unknown fields dropped. Throws `configError` (fail-loud) naming the offending package. `path` is
 * for error messages only -- this function touches no filesystem.
 */
export function parsePackagesFile(text, path) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw configError(`packages file is not valid JSON: ${path} (${error.message})`);
	}

	const entries = parsed?.packages;
	if (!Array.isArray(entries)) {
		throw configError(`packages file must have a "packages" array: ${path}`);
	}

	const seenDirs = new Map();
	return entries.map((entry, index) => normalizePackage(entry, index, path, seenDirs));
}

function normalizePackage(entry, index, path, seenDirs) {
	const at = `package at index ${index}`;

	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
		throw configError(`${at}: must be an object: ${path}`);
	}

	const { name, version } = entry;
	if (!isNonEmptyString(name)) {
		throw configError(`${at}: "name" must be a non-empty string: ${path}`);
	}
	if (name.length > MAX_NAME_LENGTH) {
		throw configError(`package "${name.slice(0, 40)}...": name exceeds npm's ${MAX_NAME_LENGTH}-character limit: ${path}`);
	}
	if (!NPM_NAME_RE.test(name)) {
		throw configError(`package "${name}": name must be a valid npm package name (lowercase, optionally "@scope/"-prefixed): ${path}`);
	}
	// The admin package can enqueue paid jobs -- staging it into an overlay that every job container reads
	// is the same recursion vector import-pi already blocks for the admin extension.
	if (ADMIN_RE.test(name)) {
		throw configError(`package "${name}": refused -- the pi-dispatch admin package must never be staged into a job overlay (it can enqueue paid jobs: a recursion vector): ${path}`);
	}

	if (!isNonEmptyString(version)) {
		throw configError(`package "${name}": "version" must be a non-empty string (an exact version, e.g. "1.4.2"): ${path}`);
	}
	// Exact versions only (CONST-PI-VERSION-PINNED). Stated in full because the refusal looks pedantic
	// until you know the failure mode it prevents.
	if (!EXACT_VERSION_RE.test(version)) {
		throw configError(
			`package "${name}": version must be an EXACT version like "1.4.2", got ${JSON.stringify(version)} -- ` +
				`a floating range turns a silent upstream minor into every queued job becoming a no-op with no signal, ` +
				`and the queue still reports success (CONST-PI-VERSION-PINNED): ${path}`,
		);
	}

	if (entry.dir !== undefined && !isNonEmptyString(entry.dir)) {
		throw configError(`package "${name}": "dir" must be a non-empty string when present: ${path}`);
	}
	const dir = entry.dir ?? stagedDirName(name);
	// Length first: the charset regex also caps at 64, but "too long" and "bad characters" are different
	// operator mistakes and deserve different fixes.
	if (dir.length > MAX_DIR_LENGTH) {
		throw configError(`package "${name}": dir ${JSON.stringify(dir)} exceeds ${MAX_DIR_LENGTH} characters -- set a shorter explicit "dir": ${path}`);
	}
	if (!ENTRY_NAME_RE.test(dir)) {
		throw configError(`package "${name}": dir ${JSON.stringify(dir)} is not a safe directory name (letters, digits, "._-", no slashes, no "..") -- set an explicit "dir": ${path}`);
	}
	if (ADMIN_RE.test(dir)) {
		throw configError(`package "${name}": dir ${JSON.stringify(dir)} is refused -- the admin name is blocked in a job overlay: ${path}`);
	}
	if (seenDirs.has(dir)) {
		throw configError(`package "${name}": dir "${dir}" is already used by "${seenDirs.get(dir)}" -- two packages cannot share one staged dir; set an explicit "dir" on one of them: ${path}`);
	}
	seenDirs.set(dir, name);

	return { name, version, dir };
}

/** The `path` a discovered candidate reports as its origin, and the suffix stripped off its error text. */
const DISCOVERED_AT = "your pi setup";

/**
 * Normalize ONE candidate discovered in the host's pi setup, returning `{ entry }` or `{ reason }` instead
 * of throwing (issue #102).
 *
 * Deliberately a try/catch around the SAME `normalizePackage` the declared path uses. Every rule that
 * guards a declared entry -- the admin block, the exact-version rule, the name charset, the dir length and
 * the dir-collision check -- therefore reaches discovery by reuse rather than by a second implementation.
 * A parallel implementation would eventually drift, and the rule it would drift away from is the one that
 * keeps the admin package (which can enqueue paid jobs) out of every job container.
 *
 * Why a reason and not a throw: a declared pin is a promise the operator made, so failing it refuses the
 * whole stage. A discovered package is an inference WE made, and taking the operator's declared set down
 * because of it would be the wrong trade. A named skip is not a silent one.
 */
export function normalizeDiscoveredPackage(candidate, seenDirs = new Map()) {
	try {
		return { entry: normalizePackage(candidate, 0, DISCOVERED_AT, seenDirs) };
	} catch (error) {
		const suffix = `: ${DISCOVERED_AT}`;
		const message = String(error?.message ?? error);
		return { reason: message.endsWith(suffix) ? message.slice(0, -suffix.length) : message };
	}
}

/**
 * Merge the packages the operator DECLARED in `pi-packages.json` with the ones discovered in their pi setup.
 * Returns `{ entries, overrides, dropped }` (issue #102).
 *
 * A declared entry WINS, matched by name, and keeps its position: that is what lets an operator pin an
 * older version than their host happens to run, which is the whole reason `pi-packages.json` survives as a
 * layer rather than being replaced by discovery. When the two disagree on the version, the shadowed host
 * version is reported in `overrides` so the printed list can say so out loud -- an operator who pinned 2.0.1
 * while running 2.3.0 should learn it here, not from a flow behaving differently in a job than it does
 * interactively.
 *
 * Collisions are resolved the same direction: `seenDirs` is seeded with the declared dirs BEFORE any
 * candidate is normalized, so `normalizePackage`'s own duplicate-dir refusal fires on the discovered side
 * and the declared entry survives untouched.
 */
export function mergeHostPackages(declared = [], discovered = []) {
	const entries = declared.map((entry) => ({ ...entry, from: FROM_DECLARED }));
	const seenDirs = new Map(entries.map((entry) => [entry.dir, entry.name]));
	const declaredByName = new Map(entries.map((entry) => [entry.name, entry]));
	const overrides = [];
	const dropped = [];

	for (const candidate of discovered) {
		const shadowing = declaredByName.get(candidate?.name);
		if (shadowing) {
			if (shadowing.version !== candidate.version) {
				overrides.push({ name: shadowing.name, declared: shadowing.version, host: candidate.version });
			}
			continue;
		}
		const result = normalizeDiscoveredPackage(candidate, seenDirs);
		if (result.reason) {
			dropped.push({ name: candidate?.name ?? "(unnamed)", reason: result.reason });
			continue;
		}
		entries.push({ ...result.entry, from: FROM_HOST });
	}

	return { entries, overrides, dropped };
}

/**
 * Read the stager's manifest from `<globalPiDir>/packages/packages.json`. Returns `{ stagedAt, packages }`
 * or `null` when there is nothing usable there. NEVER throws -- this runs on the job path, where a corrupt
 * or half-written manifest must mean "no staged packages" rather than a crashed worker.
 *
 * Entries are re-validated on the way in (the file is a host artifact that an operator may have hand-edited
 * between stage time and job time): a `dir` that is not a plain segment would otherwise flow straight into
 * a container path.
 *
 * `from` is a CLOSED enum with a default, never a pass-through (issue #102): anything that is not exactly
 * "host" reads as "pi-packages", so a hand-edited receipt cannot inject a string that reaches a printed
 * doctor line. A receipt written before #102 has no `from` at all and correctly reads as declared. Every
 * other unknown key is still dropped, which is what keeps an older worker safe against a newer receipt.
 */
export function readStageManifest({ globalPiDir, readFile = readFileSync, fileExists = existsSync } = {}) {
	if (!globalPiDir) return null;
	const path = join(globalPiDir, PACKAGES_SUBDIR, STAGE_MANIFEST);
	try {
		if (!fileExists(path)) return null;
		const parsed = JSON.parse(readFile(path, "utf8"));
		if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.packages)) return null;

		const packages = [];
		for (const entry of parsed.packages) {
			if (entry === null || typeof entry !== "object") return null;
			const { name, version, dir } = entry;
			if (!isNonEmptyString(name) || !isNonEmptyString(version) || !isNonEmptyString(dir)) return null;
			if (!ENTRY_NAME_RE.test(dir) || dir.length > MAX_DIR_LENGTH) return null;
			packages.push({ name, version, dir, from: entry.from === FROM_HOST ? FROM_HOST : FROM_DECLARED });
		}
		return { stagedAt: typeof parsed.stagedAt === "string" ? parsed.stagedAt : null, packages };
	} catch {
		return null; // missing, unreadable, or garbage -- all mean "nothing staged"
	}
}

/**
 * The CONTAINER paths of the staged packages, in manifest order -- what gets handed to pi as local package
 * specs. Built with template literals and never `path.join`: the worker may run on Windows, where `join`
 * yields backslashes, and these are paths INSIDE a Linux container.
 */
export function containerPackagePaths(manifest) {
	const packages = manifest?.packages;
	if (!Array.isArray(packages)) return [];
	return packages.filter((p) => isNonEmptyString(p?.dir)).map((p) => `${CONTAINER_PACKAGES_ROOT}/${p.dir}`);
}
