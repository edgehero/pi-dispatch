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
/** Each package's way back: what Undo restores. Not a stage, so it is never a retired tree. */
export const UNDO_DIR = ".undo";

/**
 * The directory of one stage: readable, unique and a plain path segment. The name stays in it because doctor and the admin-name check
 * read it (`ADMIN_RE` is deliberately unanchored). A build's `+` is not allowed in a segment, and the version on the manifest stays exact.
 */
export function stagedTreeName(base, version, unique = randomBytes(4).toString("hex")) {
	const head = `${base}--${String(version).replace(/[^0-9A-Za-z.-]/g, "_")}`;
	return `${head.slice(0, 118)}--${unique}`;
}

/**
 * The base a stage's directory was named from: what stays the same between stages of one package. Read from the right, because a package's own name may hold `--` (npm allows it), and
 * a directory from before per-stage names is its own base.
 */
export function stagedStem(dir) {
	return /^(.+)--\d+\.\d+\.\d+[^/]*--[0-9a-f]{8}$/.exec(dir)?.[1] ?? dir;
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
 * What a service's npm gets of the worker's environment. It holds every token the deployment has, and npm has no reason to see them. Reaching a registry takes these
 * and nothing else, and a private registry's credentials live in the service account's `.npmrc`, which npm reads for itself. The registry itself is kept, and
 * `PI_UPDATES_REGISTRY` is honoured here as it is by the look: dropping it would resolve a private name from the public registry, which is dependency confusion. `import-pi` keeps
 * the operator's whole environment: they run it at their own keyboard.
 */
export function serviceNpmEnv(env = process.env) {
	const kept = {};
	for (const [key, value] of Object.entries(env)) {
		if (/^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TMPDIR|TEMP|TMP|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NPM_CONFIG_REGISTRY|npm_config_registry)$/.test(key)) kept[key] = value;
	}
	if (env.PI_UPDATES_REGISTRY) kept.npm_config_registry = env.PI_UPDATES_REGISTRY;
	return kept;
}

/** npm said this exact version does not exist, as opposed to could not be asked. `E404` and `ETARGET` are its only two ways of saying so. */
const npmSaysNotFound = (detail) => /\b(?:E404|ETARGET)\b/.test(detail);
/** npm said this package can never install as asked, whenever it is asked. Retrying these would repeat the attempt every couple of minutes for ever. */
const npmSaysNever = (detail) => /\b(?:EUNSUPPORTEDPROTOCOL|ERESOLVE|EINTEGRITY|EINVALIDPACKAGENAME|EINVALIDTAGNAME|ENOVERSIONS)\b/.test(detail);

/** A failed npm call's kind. Anything npm did not name is infrastructure, so that a registry outage is never a verdict on a package. */
export function npmFailureKind(error) {
	const detail = String(error?.stderr ?? error?.message ?? "");
	return npmSaysNotFound(detail) ? "not-found" : npmSaysNever(detail) ? "policy" : "infra";
}

/**
 * Whether a resolved tree holds anything that is not a registry tarball with a hash, as a sentence, else null. THIS IS WHAT MAKES A SERVICE'S INSTALL SAFE, and `--ignore-scripts`
 * is not: npm runs a git dependency's `prepare` to build it, whatever that flag says, as this account and outside any container, and a tarball URL has npm fetch wherever the package
 * said. A `file:` dependency links a path on this host into the tree. So a service resolves first with `--package-lock-only`, which fetches metadata and runs nothing, refuses a tree
 * holding any of these, and only then installs exactly that tree. `.github/scripts/pi-bump.mjs` holds pi's own tree to the same rule.
 */
export function lockfileProblem(lock, origins) {
	const packages = lock?.packages;
	if (packages === null || typeof packages !== "object") return "npm resolved no tree";
	for (const [path, entry] of Object.entries(packages)) {
		if (path === "" || entry?.inBundle === true) continue; // the root, and what a checked tarball carries inside itself
		const name = path.split("node_modules/").pop();
		if (entry?.link === true) return `${name} is a link to a path on this host`;
		let origin = null;
		try { origin = new URL(entry?.resolved).origin; } catch { /* a git+ssh URL or none at all has no origin we accept */ }
		if (!origin || !origins.includes(origin)) return `${name} does not come from a configured registry`;
		if (typeof entry?.integrity !== "string" || !/^sha(?:1|256|384|512)-/.test(entry.integrity)) return `${name} has no integrity hash`;
	}
	return null;
}

/** The origins this account's npm resolves from: its registry and any scoped ones. Read from npm itself, so that an `.npmrc` means what it means to npm. */
async function registryOrigins({ exec, npmBin, options }) {
	const { stdout } = await exec(npmBin, ["config", "list", "--json"], options);
	const config = JSON.parse(String(stdout));
	const origins = [];
	for (const [key, value] of Object.entries(config)) {
		if (key !== "registry" && !/^@[^:]+:registry$/.test(key)) continue;
		try { origins.push(new URL(value).origin); } catch { /* not a URL: npm could not use it either */ }
	}
	return origins;
}

/**
 * Install and ASSERT one package inside its private staging dir, returning the path to assert-clean source.
 * Throws on any failure; the caller decides whether that is fatal (a declared pin) or a drop (a discovered
 * one). Every assertion here is about one property: the staged dir must be SELF-CONTAINED, because at job
 * time it is resolved from a read-only mount with no network and no install step.
 */
export async function preparePackage({ fs, exec, out = () => {}, entry, staging, npmBin, platform, warnings = [], timeoutMs, env, resolveFirst = false }) {
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
	const flags = ["--omit=dev", "--omit=peer", "--omit=optional", "--ignore-scripts", "--install-strategy=nested", "--no-audit", "--no-fund", "--loglevel=error"];
	const spec = `${entry.name}@${entry.version}`;
	out(`  staging ${spec} -> packages/${entry.dir}\n`);
	const options = npmExecOptions(platform, staging, { timeoutMs, env });
	try {
		if (resolveFirst) {
			await exec(npmBin, ["install", spec, "--package-lock-only", ...flags], options);
			const problem = lockfileProblem(JSON.parse(fs.readFileSync(join(staging, "package-lock.json"), "utf8")), await registryOrigins({ exec, npmBin, options }));
			if (problem) throw new PackageStageError("policy", `${spec} cannot be staged by a service: ${problem}. Nothing was installed.`);
			await exec(npmBin, ["ci", ...flags], options);
		} else {
			await exec(npmBin, ["install", spec, ...flags], options);
		}
	} catch (error) {
		if (error instanceof PackageStageError) throw error;
		const detail = String(error?.stderr ?? error?.message ?? "").trim();
		throw new PackageStageError(npmFailureKind(error), `npm install failed for ${spec}: ${detail}`);
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

/** The most files a digest reads. A tree past it has no digest, which the page reads as nothing to compare: no third party's package may hold the worker's loop by size. */
const DIGEST_FILES_MAX = 200_000;

/**
 * A digest of a resolved tree, so that the page can say when the canaried tree and the adopted tree differ: a package has no lockfile,
 * so its transitive dependencies float. A symlink is hashed by its target and never followed (node_modules/.bin holds them). It gives way every few hundred files, because a canary's
 * install runs in the worker that renews paid job locks (`doctor-spawner.mjs` on why a blocked loop fails them). `null` when the tree is past its bound.
 */
export async function treeDigest(root, { fs }) {
	const lines = [];
	let seen = 0;
	const walk = async (path) => {
		if (++seen > DIGEST_FILES_MAX) throw new RangeError("tree too large");
		if (seen % 256 === 0) await new Promise((resolve) => setImmediate(resolve));
		const stat = fs.lstatSync(path);
		const rel = relative(root, path).split("\\").join("/");
		if (stat.isSymbolicLink()) lines.push(`${rel}\0link\0${fs.readlinkSync(path)}\0`);
		else if (stat.isDirectory()) for (const name of fs.readdirSync(path)) await walk(join(path, name));
		else if (stat.isFile()) lines.push(`${rel}\0file\0${createHash("sha256").update(fs.readFileSync(path)).digest("hex")}\0`);
	};
	try {
		await walk(root);
	} catch (error) {
		if (error instanceof RangeError) return null;
		throw error;
	}
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
		const source = await preparePackage({ fs, exec, out, entry, staging, npmBin, platform, warnings, timeoutMs, env, resolveFirst: true });
		const dir = stagedTreeName(entry.dir ?? stagedDirName(entry.name), entry.version, unique);
		// renameSync, never copyTree: copyTree's symlink guard uses statSync, which FOLLOWS links, so it
		// would copy the target of every node_modules/.bin symlink instead of skipping it.
		fs.renameSync(source, join(packagesRoot, dir));
		return { dir, warnings };
	} finally {
		// Off the loop where the fs offers it: a staging tree can hold every file of a package's dependencies.
		await (fs.promises?.rm ? fs.promises.rm(staging, { recursive: true, force: true }) : fs.rmSync(staging, { recursive: true, force: true }));
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
		if (name === STAGE_MANIFEST || name === RETIRED_FILE || name === LOCK_DIR || name === UNDO_DIR || name.endsWith(".tmp") || named.has(name)) continue;
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
 * One stage at a time on one overlay, also across hosts on a shared home (`docs/multi-host.md`). `mkdir` is atomic on NFS too, which `open(O_EXCL)` was not on older clients. The holder
 * renews its time while it works, so a slow install is not taken for a crash, and everything it does to the lock it does under its own token: release removes only its own lock, and
 * `stillHeld` lets it stop before the commit if it slept past the limit and a peer took over. Taking a stale lock is by rename, so that two hosts cannot both remove it, and the rename
 * is checked afterwards, since a peer may have taken the lock between the read that judged it stale and the rename: that lock is put back.
 * Returns the callback's result; throws `PackageStageError("infra")` when a live peer holds it, since trying again later can succeed.
 */
export async function withStageLock({ fs, packagesRoot, now = Date.now, staleMs = STAGE_LOCK_STALE_MS, renewMs = staleMs / 3, holder = "" }, callback) {
	const lock = join(packagesRoot, LOCK_DIR);
	const holderFile = (dir) => join(dir, "holder.json");
	const token = randomBytes(8).toString("hex");
	const stamp = () => {
		const temp = `${holderFile(lock)}.${token}.tmp`;
		fs.writeFileSync(temp, `${JSON.stringify({ at: now(), holder, token })}\n`);
		fs.renameSync(temp, holderFile(lock));
	};
	const readHolder = (dir) => {
		try { return JSON.parse(fs.readFileSync(holderFile(dir), "utf8")); } catch { return null; }
	};
	const acquire = () => {
		fs.mkdirSync(lock);
		try { stamp(); } catch { /* an empty lock still holds, until its age says otherwise */ }
	};
	try {
		acquire();
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		const seen = readHolder(lock);
		const at = seen?.at ?? modifiedAt(fs, lock);
		if (!Number.isFinite(at) || now() - at < staleMs) throw new PackageStageError("infra", `another stage holds ${LOCK_DIR} on this overlay`);
		const stale = `${lock}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			fs.renameSync(lock, stale);
		} catch {
			throw new PackageStageError("infra", `another stage took ${LOCK_DIR} on this overlay`);
		}
		if (readHolder(stale)?.token !== seen?.token) {
			try { fs.renameSync(stale, lock); } catch { /* its holder's release finds nothing, and its commit check says so */ }
			throw new PackageStageError("infra", `another stage took ${LOCK_DIR} on this overlay`);
		}
		fs.rmSync(stale, { recursive: true, force: true });
		try {
			acquire();
		} catch {
			throw new PackageStageError("infra", `another stage took ${LOCK_DIR} on this overlay`);
		}
	}
	const stillHeld = () => readHolder(lock)?.token === token;
	const renewing = setInterval(() => {
		try { if (stillHeld()) stamp(); } catch { /* the next tick, or its age says so */ }
	}, renewMs);
	renewing.unref?.();
	try {
		return await callback({ stillHeld });
	} finally {
		clearInterval(renewing);
		if (stillHeld()) fs.rmSync(lock, { recursive: true, force: true });
	}
}

/** Where a deployment's overlay keeps its staged packages. */
export const packagesRootOf = (globalPiDir) => join(globalPiDir, PACKAGES_SUBDIR);
