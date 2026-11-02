/**
 * Staging one third-party pi package (issue #796, `DES-PACKAGE-UPDATES-PREPARED-NOT-APPLIED`).
 *
 * The assertions here are what `import-pi --with-packages` always ran. They moved out because a person's Adopt and a canary need
 * them too, and neither can run `import-pi`: it reads the account's paths and working directory, rewrites models, MCP and extensions,
 * and reinstalls every package. The service account usually is not the operator's.
 *
 * WHY A DIRECTORY PER STAGE. `rename` cannot replace a non-empty directory, and swapping one in place would change the tree under a
 * running job's bind mount, so an atomic swap was never available. Each stage gets a directory of its own, nothing already staged is
 * touched, and the manifest (temp and rename) is the single commit point. `start.mjs` reads that manifest at each job start, so a job
 * sees the old set or the new set and never half of either. An old tree is removed only after a delay longer than any job.
 */
import { createHash, randomBytes } from "node:crypto";
import { join, relative } from "node:path";
import { PACKAGES_SUBDIR, RESOURCE_DIRS, STAGE_MANIFEST, stagedDirName } from "./packages.mjs";

/**
 * What kind of failure this is, because `CONST-RETRY-INFRA-ONLY` depends on it. `not-found` and `policy` are determinate: the same
 * request can never succeed, so they are refusals. `infra` (a registry that cannot be reached, a timeout) can, so it is retried.
 */
export class PackageStageError extends Error {
	constructor(kind, message) {
		super(message);
		this.name = "PackageStageError";
		this.kind = kind;
	}
}

/** How long one `npm install` may take in a service. An operator at the keyboard of `import-pi` has Ctrl-C, a worker's child does not. */
export const SERVICE_NPM_TIMEOUT_MS = 180_000;

/** How long a tree the manifest stopped naming is kept: longer than any job, so a running job never loses a file it imports lazily. */
export const STAGED_TREE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** The longest a stage may hold the lock. A holder older than this crashed: the longest stage is a few npm timeouts. */
export const STAGE_LOCK_STALE_MS = 30 * 60 * 1000;

const LOCK_DIR = ".stage.lock";
const RETIRED_FILE = ".retired.json";
const STAGING_PREFIX = ".staging-";

/**
 * The directory of one stage: readable, unique and a plain path segment. The name stays in it because doctor and the admin-name check
 * read it (`ADMIN_RE` is deliberately unanchored). A build's `+` is not allowed in a segment, and the version on the manifest stays exact.
 */
export function stagedTreeName(base, version, unique = randomBytes(4).toString("hex")) {
	const head = `${base}--${String(version).replace(/[^0-9A-Za-z.-]/g, "_")}`;
	return `${head.slice(0, 118)}--${unique}`;
}

/** The first string anywhere in a `pi` manifest that leaves the package dir, or null when all are contained. */
function findEscapingEntry(value) {
	if (typeof value === "string") {
		return /^[\\/]/.test(value) || value.split(/[\\/]/).includes("..") ? value : null;
	}
	if (Array.isArray(value) || (value !== null && typeof value === "object")) {
		for (const child of Object.values(value)) {
			const hit = findEscapingEntry(child);
			if (hit) return hit;
		}
	}
	return null;
}

/**
 * The exec options for one `npm install`: always `cwd: <staging>` (that IS the install target now that
 * `--prefix` is gone), plus `shell: true` on win32 and nowhere else.
 *
 * WHY shell:true is REQUIRED on win32: npm ships there as `npm.cmd`, and since Node 18.20.2 / 20.12.2
 * (CVE-2024-27980) spawning a `.cmd`/`.bat` WITHOUT a shell throws EINVAL outright. This package floors at
 * Node >=22.19, so every Node it can run on has that behaviour -- without this, `--with-packages` fails on
 * every Windows host with a misleading "spawn npm.cmd EINVAL" and the branch above is dead on arrival.
 *
 * WHY shell:true is SAFE HERE SPECIFICALLY, which it would NOT be in general: with `--prefix` replaced by
 * `cwd`, argv holds no filesystem path at all -- only literal flags this file spells out, plus the single
 * `name@version` token, and BOTH halves of that token were validated before anything was created (packages.mjs
 * rejects any name failing NPM_NAME_RE and any version failing EXACT_VERSION_RE, neither of which admits a
 * space, quote, or cmd metacharacter). So no operator-supplied string that could survive as shell syntax ever
 * reaches the command line. Re-introducing a path -- or loosening either regex -- breaks that argument, so
 * this option must be revisited together with them.
 */
export function npmExecOptions(platform, staging, { timeoutMs, env } = {}) {
	return { ...(staging ? { cwd: staging } : {}), ...(platform === "win32" ? { shell: true } : {}), ...(timeoutMs ? { timeout: timeoutMs } : {}), ...(env ? { env } : {}) };
}

/**
 * What a service's npm gets of the worker's environment. It holds every token the deployment has, and `--ignore-scripts` means no package
 * code runs, but npm has no reason to see them either. Reaching the registry takes these and nothing else. `import-pi` keeps the operator's
 * whole environment: they run it at their own keyboard, and it is how a private registry's credentials reach npm.
 */
export function serviceNpmEnv(env = process.env) {
	const kept = {};
	for (const [key, value] of Object.entries(env)) {
		if (/^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TMPDIR|TEMP|TMP|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy)$/.test(key)) kept[key] = value;
	}
	return kept;
}

/** npm said this exact version does not exist, as opposed to could not be asked. `E404` and `ETARGET` are its only two ways of saying so. */
const npmSaysNotFound = (detail) => /\b(?:E404|ETARGET)\b/.test(detail);

/** A failed npm call's kind. Anything npm did not name as absent is infrastructure, so that a registry outage is never a verdict on a package. */
export function npmFailureKind(error) {
	return npmSaysNotFound(String(error?.stderr ?? error?.message ?? "")) ? "not-found" : "infra";
}

/**
 * Install and ASSERT one package inside its private staging dir, returning the path to assert-clean source.
 * Throws on any failure; the caller decides whether that is fatal (a declared pin) or a drop (a discovered
 * one). Every assertion here is about one property: the staged dir must be SELF-CONTAINED, because at job
 * time it is resolved from a read-only mount with no network and no install step.
 */
export async function preparePackage({ fs, exec, out = () => {}, entry, staging, npmBin, platform, warnings = [], timeoutMs, env }) {
	fs.mkdirSync(staging, { recursive: true });
	// A private root package.json pins npm's idea of "the project" to the staging dir, so it cannot
	// walk up and install into (or read config from) the operator's own checkout.
	fs.writeFileSync(join(staging, "package.json"), `${JSON.stringify({ name: "pi-dispatch-staging", private: true, ...(entry.name === "pi-anthropic-oauth" ? { overrides: { "@anthropic-ai/sdk": "0.124.0" } } : {}) })}\n`);

	// ARRAY argv, never a shell string: the name and version come from a config file and must never be
	// able to become shell syntax on the operator's host. The install target is the exec's `cwd`, NOT a
	// `--prefix <staging>` pair -- npm installs into the cwd's node_modules by default, and dropping the
	// flag removes the only filesystem PATH from argv. What is left is nothing but literal flags and one
	// `name@version` token already validated against NPM_NAME_RE + EXACT_VERSION_RE; that is the property
	// npmExecOptions relies on below.
	//
	// --ignore-scripts is load-bearing: without it the lifecycle scripts of this package AND of every
	// transitive dependency would run as the operator, on the operator's host, at stage time.
	// --omit=peer because pi aliases its own packages for extensions at load time, so a staged peer
	// copy is ignored dead weight -- and a floating pi version at that (CONST-PI-VERSION-PINNED).
	// --install-strategy=nested asks npm to keep every dependency inside the package dir; step 4 below
	// ASSERTS the result rather than trusting the flag, whose name and default have moved across npm
	// versions.
	const args = [
		"install",
		`${entry.name}@${entry.version}`,
		"--omit=dev",
		"--omit=peer",
		"--omit=optional",
		"--ignore-scripts",
		"--install-strategy=nested",
		"--no-audit",
		"--no-fund",
		"--loglevel=error",
	];
	out(`  staging ${entry.name}@${entry.version} -> packages/${entry.dir}\n`);
	try {
		await exec(npmBin, args, npmExecOptions(platform, staging, { timeoutMs, env }));
	} catch (error) {
		const detail = String(error?.stderr ?? error?.message ?? "").trim();
		throw new PackageStageError(npmFailureKind(error), `npm install failed for ${entry.name}@${entry.version}: ${detail}`);
	}

	const source = join(staging, "node_modules", entry.name);
	let pkg;
	try {
		pkg = JSON.parse(fs.readFileSync(join(source, "package.json"), "utf8"));
	} catch {
		throw new PackageStageError("policy", `${entry.name}@${entry.version}: npm reported success but there is no readable package.json at ${join(source, "package.json")}`);
	}
	if (pkg.version !== entry.version) {
		throw new PackageStageError("policy", `${entry.name}: npm staged version ${JSON.stringify(pkg.version)}, not the pinned ${JSON.stringify(entry.version)} (CONST-PI-VERSION-PINNED)`);
	}

	// Dependency completeness -- catches hoisting whatever npm's flag defaults do this month. A
	// hoisted dependency would only surface as an import failure inside a job, hours later.
	for (const dep of Object.keys(pkg.dependencies ?? {})) {
		if (!fs.existsSync(join(source, "node_modules", dep))) {
			throw new PackageStageError("policy", `${entry.name}: dependency "${dep}" is not inside the package dir -- npm hoisted it out, so the staged copy could not import it at run time (no network at job time)`);
		}
	}

	// A package that contributes no pi resources loads as a silent no-op; staging exists to turn that
	// run-time nothing into a stage-time error the operator can act on.
	const manifest = pkg.pi !== null && typeof pkg.pi === "object" ? pkg.pi : null;
	const hasResourceDir = RESOURCE_DIRS.some((name) => fs.existsSync(join(source, name)));
	if (!manifest && !hasResourceDir) {
		throw new PackageStageError("policy", `${entry.name} is not a pi package -- no "pi" manifest in package.json and none of ${RESOURCE_DIRS.join("/")}; it would load as a silent no-op`);
	}

	// Containment: manifest entries are resolved relative to the package dir at job time, so one that
	// climbs out of it would reach the rest of the read-only overlay.
	const escaping = manifest && findEscapingEntry(manifest);
	if (escaping) {
		throw new PackageStageError("policy", `${entry.name}: pi manifest entry ${JSON.stringify(escaping)} leaves the package dir (no ".." segment, no leading "/")`);
	}

	// Warn, do not refuse: --ignore-scripts means a build/postinstall step did NOT run and an optional
	// dependency was NOT fetched, so such a package is staged INCOMPLETE and may fail at run time.
	const scriptKeys = ["install", "preinstall", "postinstall"].filter((key) => typeof pkg.scripts?.[key] === "string");
	const hasOptional = Object.keys(pkg.optionalDependencies ?? {}).length > 0;
	if (scriptKeys.length > 0 || hasOptional) {
		const declares = [...scriptKeys.map((key) => `scripts.${key}`), ...(hasOptional ? ["optionalDependencies"] : [])].join(", ");
		warnings.push({ dir: entry.dir, reason: `${entry.name} declares ${declares} -- staged with --ignore-scripts, so it is INCOMPLETE and may fail at run time` });
	}

	if (["pi-anthropic-oauth@0.3.6", "@gotgenes/pi-anthropic-auth@3.4.3"].includes(`${entry.name}@${entry.version}`)) {
		// Read-only host-pi consumers, including the scratch canary, have no lifecycle dependencies installed.
		const { prepareCommunityAuthAdapter } = await import("./community-auth-patches.mjs");
		const receipt = prepareCommunityAuthAdapter({ adapter: `${entry.name}@${entry.version}`, root: source, fs });
		out(`  reviewed subscription adapter ${receipt.adapter}: ${receipt.digest}\n`);
	}
	return source;
}

/** A staging directory's unique name. A fixed `.staging-<i>` would delete a peer's work on a shared home. */
export const newStagingDir = (packagesRoot, unique = randomBytes(6).toString("hex")) => join(packagesRoot, `${STAGING_PREFIX}${unique}`);

/**
 * A digest of a resolved tree, so that the page can say when the canaried tree and the adopted tree differ: a package has no lockfile,
 * so its transitive dependencies float. A symlink is hashed by its target and never followed (node_modules/.bin holds them).
 */
export function treeDigest(root, { fs }) {
	const lines = [];
	const walk = (path) => {
		const stat = fs.lstatSync(path);
		const rel = relative(root, path).split("\\").join("/");
		if (stat.isSymbolicLink()) lines.push(`${rel}\0link\0${fs.readlinkSync(path)}\0`);
		else if (stat.isDirectory()) for (const name of fs.readdirSync(path)) walk(join(path, name));
		else if (stat.isFile()) lines.push(`${rel}\0file\0${createHash("sha256").update(fs.readFileSync(path)).digest("hex")}\0`);
	};
	walk(root);
	return createHash("sha256").update(lines.sort().join("")).digest("hex");
}

/**
 * Install one package and move it to a new directory of its own, leaving what is staged alone. Nothing refers to the result until a caller
 * writes the manifest. Returns `{ dir, warnings }`, and removes its staging directory whichever way it ends.
 */
export async function stagePackageTree({ fs, exec, out, entry, packagesRoot, npmBin, platform, timeoutMs, env, unique }) {
	const staging = newStagingDir(packagesRoot);
	const warnings = [];
	try {
		const source = await preparePackage({ fs, exec, out, entry, staging, npmBin, platform, warnings, timeoutMs, env });
		const dir = stagedTreeName(entry.dir ?? stagedDirName(entry.name), entry.version, unique);
		// renameSync, never copyTree: copyTree's symlink guard uses statSync, which FOLLOWS links, so it
		// would copy the target of every node_modules/.bin symlink instead of skipping it.
		fs.renameSync(source, join(packagesRoot, dir));
		return { dir, warnings };
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

/** Write the manifest, the commit point. Temp and rename, on the same filesystem: a reader sees the old file or the new one, never half. */
export function writeStageManifest({ fs, packagesRoot, manifest, unique = randomBytes(6).toString("hex") }) {
	const path = join(packagesRoot, STAGE_MANIFEST);
	const temp = `${path}.${unique}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
	try {
		fs.renameSync(temp, path);
	} catch (error) {
		fs.rmSync(temp, { force: true });
		throw error;
	}
}

/**
 * Note the trees the manifest stopped naming, and remove those noted longer ago than the delay. The delay is measured from when a tree left
 * the manifest, not from when it was installed, and only under the stage lock. A tree that is named again (Undo) is simply no longer retired.
 * Failures are ignored by design: a tree kept too long costs disk, and the manifest has already committed.
 */
export function pruneStagedTrees({ fs, packagesRoot, manifest, now = Date.now, keepMs = STAGED_TREE_KEEP_MS }) {
	const named = new Set((manifest?.packages ?? []).map((p) => p.dir));
	const path = join(packagesRoot, RETIRED_FILE);
	let retired = {};
	try {
		const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) retired = parsed;
	} catch { /* none yet, or unreadable: every tree starts its delay again, which only keeps it longer */ }
	const kept = {};
	const at = now();
	let names = [];
	try { names = fs.readdirSync(packagesRoot); } catch { return; }
	for (const name of names) {
		if (name === STAGE_MANIFEST || name === RETIRED_FILE || name === LOCK_DIR || name.endsWith(".tmp") || named.has(name)) continue;
		// A staging directory carries no version and no record: it is a peer's until it is older than any stage could be.
		const since = name.startsWith(STAGING_PREFIX) ? modifiedAt(fs, join(packagesRoot, name)) ?? at : Number.isFinite(retired[name]) ? retired[name] : at;
		const limit = name.startsWith(STAGING_PREFIX) ? STAGE_LOCK_STALE_MS : keepMs;
		if (at - since >= limit) {
			try { fs.rmSync(join(packagesRoot, name), { recursive: true, force: true }); continue; } catch { /* kept for the next stage */ }
		}
		if (!name.startsWith(STAGING_PREFIX)) kept[name] = since;
	}
	try { writeRetired(fs, path, kept); } catch { /* the delay restarts next time */ }
}

function modifiedAt(fs, path) {
	try { return fs.statSync(path).mtimeMs; } catch { return null; }
}

function writeRetired(fs, path, value) {
	const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(value)}\n`);
	fs.renameSync(temp, path);
}

/**
 * One stage at a time on one overlay, also across hosts on a shared home (`docs/multi-host.md`). `mkdir` is atomic on NFS too, which `open(O_EXCL)`
 * was not on older clients. A holder older than `STAGE_LOCK_STALE_MS` crashed, and its lock is taken by rename, so that two hosts cannot both think they removed it.
 * Returns the callback's result; throws `PackageStageError("infra")` when a live peer holds it, since trying again later can succeed.
 */
export async function withStageLock({ fs, packagesRoot, now = Date.now, staleMs = STAGE_LOCK_STALE_MS, holder = "" }, callback) {
	const lock = join(packagesRoot, LOCK_DIR);
	const acquire = () => {
		fs.mkdirSync(lock);
		try { fs.writeFileSync(join(lock, "holder.json"), `${JSON.stringify({ at: now(), holder })}\n`); } catch { /* an empty lock still holds */ }
	};
	try {
		acquire();
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		let at = null;
		try { at = JSON.parse(fs.readFileSync(join(lock, "holder.json"), "utf8"))?.at; } catch { at = modifiedAt(fs, lock); }
		if (!Number.isFinite(at) || now() - at < staleMs) throw new PackageStageError("infra", `another stage holds ${LOCK_DIR} on this overlay`);
		const stale = `${lock}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			fs.renameSync(lock, stale);
			fs.rmSync(stale, { recursive: true, force: true });
			acquire();
		} catch {
			throw new PackageStageError("infra", `another stage took ${LOCK_DIR} on this overlay`);
		}
	}
	try {
		return await callback();
	} finally {
		fs.rmSync(lock, { recursive: true, force: true });
	}
}

/** Where a deployment's overlay keeps its staged packages. */
export const packagesRootOf = (globalPiDir) => join(globalPiDir, PACKAGES_SUBDIR);
