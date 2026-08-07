/**
 * Read the operator's OWN pi setup: which packages they installed with `pi install`, and which of their
 * extensions they turned off with `pi config` (issue #102).
 *
 * Why this exists. `import-pi` used to stage packages from `pi-packages.json` and nothing else, so a package
 * the operator had already installed never reached a job and re-running the import did not change that. The
 * only road in was to declare it a second time, by hand, with an exact version, while the docs promised the
 * import staged "your host pi setup". This module closes that gap by reading what pi itself recorded.
 *
 * Why a separate module from import-pi.mjs. `doctor` is a first-class consumer -- it reports host packages
 * that are not staged and version drift between the two -- and it needs those facts with no overlay write,
 * no `out` stream and none of the stager's print side effects. So this module returns structured facts and
 * every caller renders them its own way.
 *
 * What it must never become. Nothing on the worker's BOOT path may import this file. It reads host paths and
 * may spawn a package manager, and neither belongs anywhere near `start.mjs`.
 *
 * Everything here MIRRORS a private detail of the pinned pi (0.80.7) rather than calling it: pi exports no
 * public answer to "where is this package installed" or "is this resource enabled", and importing the whole
 * coding-agent SDK to read two well-known paths is not worth the weight. That mirroring is a real risk --
 * pi could change the grammar and we would silently start staging something the operator turned off -- so it
 * is pinned twice: `worker/test/host-pi.pinned.test.mjs` asserts the pinned artifact still reads the way this
 * file assumes, and `.github/scripts/host-pi-canary.mjs` runs the same needles against pi@latest for advance
 * warning. Both import PINNED_PI_NEEDLES from here so the pin and the canary cannot drift apart. The residual
 * is `OQ-018`, recorded rather than glossed: the pins catch a moved internal, not a mirror that was checking
 * the wrong lines all along.
 *
 * Where it cannot decide, it says so. A glob in an enablement pattern is NOT evaluated (we do not carry a
 * matcher), the extension is copied, and the caller prints that it could not be honoured. Fail open, and say
 * which.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { EXACT_VERSION_RE, RESOURCE_DIRS, stagedDirName } from "./packages.mjs";

/** pi's user-scope npm install root: `<agentDir>/npm/node_modules/<name>` (getManagedNpmInstallPath). */
export const AGENT_NPM_SUBDIR = "npm";
/** pi's user-scope git install root: `<agentDir>/git/<host>/<path>` (getGitInstallRoot). */
export const AGENT_GIT_SUBDIR = "git";
/** pi's own settings file. READ here, never copied into the overlay -- reading is not copying. */
export const AGENT_SETTINGS_FILE = "settings.json";

/**
 * The exact source strings this module assumes are still present in the pinned pi. Consumed by the pinned
 * test (build gate) and by the release canary (advance warning) so a pi bump that moves any of them fails a
 * test here rather than silently changing what lands in every job container.
 */
export const PINNED_PI_NEEDLES = {
	"dist/core/package-manager.js": [
		// The two install roots we resolve by hand.
		'return join(this.agentDir, "npm", "node_modules", source.name);',
		'return join(this.agentDir, "git");',
		// The user-scope legacy fallback, and its precedence: managed path first, global root only if absent.
		"return this.getPnpmGlobalPackagePath(source.name) ?? join(this.getGlobalNpmRoot(), source.name);",
		'this.runNpmCommandSync(["root", "-g"]).trim()',
		'this.runNpmCommandSync(["list", "-g", "--depth", "0", "--json"])',
		// A package with no `pi` key is still a pi package when it ships a convention dir.
		"return pkg.pi ?? null;",
		// The enablement grammar: which prefixes are overrides, and the order they resolve in.
		'return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));',
		"function isEnabledByOverrides(filePath, patterns, baseDir) {",
		// The npm spec split that yields a name from `@scope/name@version`.
		"const match = spec.match(/^(@?[^@]+(?:\\/[^@]+)?)(?:@(.+))?$/);",
	],
	"dist/core/settings-manager.d.ts": [
		"export type PackageSource = string | {",
		"    autoload?: boolean;",
		"    packages?: PackageSource[];",
		"    extensions?: string[];",
	],
};

/**
 * Resolve the host's pi agent dir the way pi's getAgentDir() does: env override, else `~/.pi/agent`.
 * Lives here now (it moved out of import-pi.mjs) because discovery, the extension read and doctor all
 * need the same answer.
 */
export function agentDirFrom(env = process.env) {
	return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * Parse `<agentDir>/settings.json` TEXT. Pure, fs-free, and it NEVER throws: one bad file on the operator's
 * host must not be able to block their overlay refresh, most of which (models, skills, persona) does not
 * depend on this file at all.
 *
 * Only three keys are read, and every other key in pi's Settings is ignored by construction rather than by a
 * schema -- a schema here would be a second, drifting copy of pi's own type.
 *   packages    the operator's declared install list, the source of truth for discovery
 *   extensions  the top-level override patterns that decide which auto-discovered extensions load
 *   npmCommand  only to learn whether the host runs npm, pnpm or bun, for the legacy global lookup
 *
 * `state` is "ok", "malformed" (not JSON, or not an object), or "packages-not-an-array".
 */
export function parseHostSettings(text) {
	const empty = { state: "malformed", packages: [], patterns: [], npmCommand: null };
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return empty;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return empty;

	const patterns = Array.isArray(parsed.extensions) ? parsed.extensions.filter((p) => typeof p === "string") : [];
	const npmCommand = Array.isArray(parsed.npmCommand) ? parsed.npmCommand.filter((p) => typeof p === "string") : null;
	if (parsed.packages !== undefined && !Array.isArray(parsed.packages)) {
		return { state: "packages-not-an-array", packages: [], patterns, npmCommand };
	}
	return { state: "ok", packages: Array.isArray(parsed.packages) ? parsed.packages : [], patterns, npmCommand };
}

/** pi's own npm spec split: `@scope/name@1.2.3` -> name `@scope/name`, version `1.2.3` (parseNpmSpec). */
const NPM_SPEC_RE = /^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/;

/**
 * Classify one `settings.packages` source string, mirroring pi's parseSource narrowly.
 * Returns `{ kind, name, spec, requested, raw }` where kind is "npm", "git" or "local".
 *
 * `requested` is whatever version the operator typed and is reported, never trusted: it may be a range, and
 * a range is exactly what CONST-PI-VERSION-PINNED forbids. The version that gets pinned is always read back
 * off the installed directory.
 */
export function parsePackageSource(source) {
	const raw = typeof source === "string" ? source.trim() : "";
	if (raw === "") return { kind: "local", name: null, spec: null, requested: null, raw };

	if (raw.startsWith("npm:")) {
		const spec = raw.slice("npm:".length).trim();
		const match = spec.match(NPM_SPEC_RE);
		if (!match) return { kind: "npm", name: spec, spec, requested: null, raw };
		return { kind: "npm", name: match[1], spec, requested: match[2] ?? null, raw };
	}
	// A relative or absolute path is pi's "local" source. Checked BEFORE the git shapes because `./a/b`
	// would otherwise read as a host-and-path pair.
	if (/^[.~/]/.test(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
		return { kind: "local", name: raw, spec: null, requested: null, raw };
	}
	// Everything else is a git source as far as staging is concerned: `git:host/path`, an ssh or https URL,
	// or the bare `host/owner/repo` form pi accepts. We stage none of them, so the only job of this branch
	// is to name the thing accurately in the printed reason.
	const name = raw.startsWith("git:") ? raw.slice("git:".length) : raw;
	return { kind: "git", name, spec: null, requested: null, raw };
}

/** The prefixes pi treats as overrides; a plain pattern is not one (getOverridePatterns). */
function isOverridePattern(pattern) {
	return typeof pattern === "string" && (pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}

/** Any minimatch magic we decline to interpret. Deliberately over-broad: a false "unknown" only costs a note. */
const GLOB_RE = /[*?[\]{}()]/;

const toPosix = (p) => String(p).split("\\").join("/");
/** pi's normalizeExactPattern: a leading "./" is stripped before comparison. */
const normalizeExact = (pattern) => toPosix(pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern);

/**
 * Is this resource enabled, given pi's top-level override patterns? Returns true, false, or **null** for
 * "we refuse to guess" (mirrors isEnabledByOverrides).
 *
 * `candidate` is `{ rel, name, abs }`: the path relative to the agent dir, the basename, and the absolute
 * path. pi compares `+`/`-` patterns EXACTLY and only against `rel` and `abs`; it compares `!` patterns with
 * minimatch and also against the basename. That asymmetry is pi's, not a simplification.
 *
 * Precedence is pi's, and it is why this is resolved in three passes rather than one loop: `-` beats `+`
 * beats `!`. So a `-` hit is final, a `+` hit is final, and only then does an unevaluable `!` glob matter --
 * which is what keeps `-a/b.js` a determinate answer even when some other pattern is a glob we skipped.
 *
 * The null case is the honest one. We carry no matcher (the worker has four runtime dependencies and none is
 * a glob library, and adding one to read another tool's config is not the trade), so a `!` glob means we do
 * not know. The caller copies the extension and prints that it could not honour the pattern.
 */
export function isEnabledByPatterns(candidate, patterns = []) {
	const overrides = patterns.filter(isOverridePattern);
	if (overrides.length === 0) return true;

	const exactHit = (pattern) => {
		const normalized = normalizeExact(pattern);
		return normalized === candidate.rel || normalized === candidate.abs;
	};
	for (const pattern of overrides) {
		if (pattern.startsWith("-") && exactHit(pattern.slice(1))) return false;
	}
	for (const pattern of overrides) {
		if (pattern.startsWith("+") && exactHit(pattern.slice(1))) return true;
	}

	let unknown = false;
	for (const pattern of overrides) {
		if (!pattern.startsWith("!")) continue;
		const body = pattern.slice(1);
		if (GLOB_RE.test(body)) {
			unknown = true;
			continue;
		}
		const normalized = toPosix(body);
		if (normalized === candidate.rel || normalized === candidate.name || normalized === candidate.abs) return false;
	}
	return unknown ? null : true;
}

/** pi's resolveExtensionEntries: the package's own `pi.extensions[]`, else index.ts, else index.js, else none. */
function resolveExtensionEntries(fs, dir) {
	const packageJsonPath = join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		try {
			const declared = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))?.pi?.extensions;
			if (Array.isArray(declared)) {
				const entries = declared.filter((p) => typeof p === "string").map((p) => resolve(dir, p)).filter((p) => fs.existsSync(p));
				if (entries.length > 0) return entries;
			}
		} catch {
			// Unreadable or malformed: fall through to the index convention, exactly as pi does.
		}
	}
	for (const index of ["index.ts", "index.js"]) {
		const candidate = join(dir, index);
		if (fs.existsSync(candidate)) return [candidate];
	}
	return [];
}

/**
 * The entry files pi would load for one child of `<agentDir>/extensions/`. A `.ts`/`.js` FILE is its own
 * entry; a DIRECTORY resolves through the package manifest or the index convention. Anything else
 * contributes nothing, which is why an empty result means "leave it alone" rather than "disabled".
 */
export function extensionEntryPaths(fs, extDir, name) {
	const child = join(extDir, name);
	let st;
	try {
		st = fs.statSync(child);
	} catch {
		return [];
	}
	if (st.isDirectory()) return resolveExtensionEntries(fs, child);
	if (/\.(ts|js)$/.test(name)) return [child];
	return [];
}

/**
 * Which of the host's extensions are turned OFF in pi. Returns `{ disabled, unevaluated }` -- a Set of child
 * names not to copy, and the names whose state we declined to guess.
 *
 * This runs on EVERY import, not just under --with-packages: the extensions copy has shipped since long
 * before discovery existed, and an extension the operator explicitly disabled has been loading in every job
 * container the whole time. That is the live half of issue #102.
 */
export function hostExtensionState({ fs, agentDir, patterns = [] }) {
	const disabled = new Set();
	const unevaluated = [];
	const extDir = join(agentDir, "extensions");
	if (!fs.existsSync(extDir)) return { disabled, unevaluated };

	const overrides = patterns.filter(isOverridePattern);
	if (overrides.length === 0) return { disabled, unevaluated };

	// pi checks the extensions dir ITSELF for entries first, and when it finds them the whole directory is a
	// single extension rather than a parent of many. In that layout no per-child verdict exists to compute,
	// so we say so instead of inventing one.
	if (resolveExtensionEntries(fs, extDir).length > 0) {
		unevaluated.push("extensions/ (the directory itself resolves as one extension, so per-name state does not apply)");
		return { disabled, unevaluated };
	}

	let names;
	try {
		names = fs.readdirSync(extDir);
	} catch {
		return { disabled, unevaluated };
	}

	for (const name of names) {
		if (name.startsWith(".") || name === "node_modules") continue;
		const entries = extensionEntryPaths(fs, extDir, name);
		if (entries.length === 0) continue; // pi loads nothing from it, so the copy is inert either way

		let allDisabled = true;
		let anyUnknown = false;
		for (const entry of entries) {
			const verdict = isEnabledByPatterns({ rel: toPosix(relative(agentDir, entry)), name: basename(entry), abs: toPosix(entry) }, overrides);
			if (verdict === null) anyUnknown = true;
			if (verdict !== false) allDisabled = false;
		}
		// An extension is off only when EVERY entry it loads is off. Unknown wins over disabled: we would
		// rather copy something the operator turned off, and print that we could not tell, than quietly
		// withhold a tool their flows were written against.
		if (anyUnknown) unevaluated.push(name);
		else if (allDisabled) disabled.add(name);
	}
	return { disabled, unevaluated };
}

/** pi's getPackageManagerName: the token after the last `--`, else the command, basename, minus .cmd/.exe. */
function packageManagerName(npmCommand) {
	if (!Array.isArray(npmCommand) || npmCommand.length === 0) return "npm";
	const separatorIndex = npmCommand.lastIndexOf("--");
	const command = separatorIndex >= 0 ? npmCommand[separatorIndex + 1] : npmCommand[0];
	return command ? basename(command).replace(/\.(cmd|exe)$/i, "") : "";
}

/**
 * The host's global package root, for pi's LEGACY fallback only. One lazy probe per run, memoised, and every
 * failure degrades to `null` with a reason rather than throwing: this shells out to whatever package manager
 * the operator configured, on their machine, and a feature that reads their setup must not be able to break
 * their import because `pnpm` was not on PATH.
 */
function makeGlobalRootProbe({ exec, npmCommand, platform }) {
	let cached;
	const manager = packageManagerName(npmCommand);
	const [command, ...prefixArgs] = Array.isArray(npmCommand) && npmCommand.length > 0 ? npmCommand : [platform === "win32" ? "npm.cmd" : "npm"];

	const run = async (args) => {
		// shell:true on win32 for the same CVE-2024-27980 reason import-pi documents: a .cmd cannot be
		// spawned without one. Safe here for the same reason too -- argv is literal flags and nothing else.
		const options = platform === "win32" ? { shell: true } : {};
		const { stdout } = await exec(command, [...prefixArgs, ...args], options);
		return String(stdout ?? "").trim();
	};

	return {
		manager,
		async resolve(name) {
			if (cached === undefined) {
				cached = { root: null, pnpm: null, reason: null };
				try {
					if (manager === "pnpm") {
						cached.pnpm = JSON.parse(await run(["list", "-g", "--depth", "0", "--json"]));
					} else if (manager === "bun") {
						cached.root = join(dirnameOf(await run(["pm", "bin", "-g"])), "install", "global", "node_modules");
					} else {
						cached.root = await run(["root", "-g"]);
					}
				} catch (error) {
					cached.reason = `could not ask ${manager} for its global root (${String(error?.message ?? error).split("\n")[0]})`;
				}
			}
			if (cached.pnpm) {
				for (const entry of Array.isArray(cached.pnpm) ? cached.pnpm : []) {
					const path = entry?.dependencies?.[name]?.path;
					if (typeof path === "string" && path !== "") return { path, reason: null };
				}
				return { path: null, reason: null };
			}
			if (cached.root) return { path: join(cached.root, name), reason: null };
			return { path: null, reason: cached.reason };
		},
	};
}

/** `path.dirname` over a possibly-Windows path, without importing win32-specific helpers. */
function dirnameOf(p) {
	const normalized = toPosix(p).replace(/\/+$/, "");
	const cut = normalized.lastIndexOf("/");
	return cut <= 0 ? normalized : normalized.slice(0, cut);
}

/**
 * Discover the packages the operator installed in pi, from `settings.packages`.
 *
 * Why settings and not a walk of `<agentDir>/npm/node_modules`: pi installs with plain npm and default
 * hoisting (getNpmInstallArgs), so in that tree an installed package and a transitive dependency are
 * indistinguishable. A walk would stage third-party code into every job container because it happened to be
 * hoisted next to something the operator did ask for. Settings carries intent, git sources and enablement;
 * the only thing it lacks is a trustworthy version, and that is read back off the install dir.
 *
 * When settings is absent or malformed we discover NOTHING. We deliberately do not fall back to the walk:
 * inferring intent from a hoisted tree is the failure this function exists to avoid, and it would be worst
 * exactly when the operator's config is already broken.
 */
export async function discoverHostPackages({ agentDir, settings, fs, exec, platform = process.platform }) {
	const sources = settings?.state === "ok" ? settings.packages : [];
	if (sources.length === 0) return [];

	const probe = makeGlobalRootProbe({ exec, npmCommand: settings.npmCommand, platform });
	const managedRoot = join(agentDir, AGENT_NPM_SUBDIR, "node_modules");
	const found = [];

	for (const source of sources) {
		// A PackageSource is either the bare spec string or an object carrying the spec plus filters.
		const spec = typeof source === "string" ? source : source?.source;
		if (typeof spec !== "string") continue;
		const parsed = parsePackageSource(spec);
		const autoload = typeof source === "object" && source !== null ? source.autoload : undefined;
		const filtered = typeof source === "object" && source !== null && RESOURCE_DIRS.some((kind) => Array.isArray(source[kind]));
		const forced = typeof source === "object" && source !== null && RESOURCE_DIRS.some((kind) => (source[kind] ?? []).some?.((p) => typeof p === "string" && p.startsWith("+")));
		const base = { source: spec, kind: parsed.kind, name: parsed.name, version: null, installPath: null, resolvedVia: null, isPiPackage: null, autoload, filtered, forced, skip: null };

		if (parsed.kind === "git") {
			found.push({ ...base, skip: "git source, and pi-packages.json pins an npm name plus an exact version only" });
			continue;
		}
		if (parsed.kind === "local") {
			found.push({ ...base, skip: "local path source, staged from your own filesystem rather than a registry" });
			continue;
		}

		// pi's getNpmInstallPath for scope "user": the managed path, and ONLY if that is absent, the legacy
		// global root. Replicating the precedence matters as much as replicating the paths -- honouring the
		// global copy when a managed one exists would stage a different build than the operator runs.
		let installPath = join(managedRoot, parsed.name);
		let resolvedVia = "managed";
		if (!fs.existsSync(installPath)) {
			const legacy = await probe.resolve(parsed.name);
			if (legacy.path && fs.existsSync(legacy.path)) {
				installPath = legacy.path;
				resolvedVia = probe.manager === "pnpm" ? "pnpm-global" : probe.manager === "bun" ? "bun-global" : "legacy-global";
			} else {
				found.push({ ...base, skip: legacy.reason ?? `not installed at ${managedRoot}, and not in ${probe.manager}'s global root either` });
				continue;
			}
		}

		let pkg;
		try {
			pkg = JSON.parse(fs.readFileSync(join(installPath, "package.json"), "utf8"));
		} catch {
			found.push({ ...base, installPath, resolvedVia, skip: `no readable package.json at ${installPath}` });
			continue;
		}

		// The same field pi reads (getInstalledNpmVersion), re-checked against the pin rule before it can
		// become one. A prerelease passes; anything that is not a concrete version does not.
		const version = typeof pkg.version === "string" ? pkg.version : null;
		if (!version || !EXACT_VERSION_RE.test(version)) {
			found.push({ ...base, installPath, resolvedVia, skip: `installed version ${JSON.stringify(pkg.version ?? null)} is not an exact version (CONST-PI-VERSION-PINNED)` });
			continue;
		}

		// pi's own predicate: a `pi` manifest OR a convention dir. A package with neither contributes nothing
		// and would stage as a silent no-op.
		const isPiPackage = (pkg.pi !== null && typeof pkg.pi === "object") || RESOURCE_DIRS.some((kind) => fs.existsSync(join(installPath, kind)));
		const entry = { ...base, version, installPath, resolvedVia, isPiPackage, dir: stagedDirName(parsed.name) };
		if (!isPiPackage) {
			found.push({ ...entry, skip: `contributes no pi resources (no "pi" manifest and none of ${RESOURCE_DIRS.join("/")})` });
			continue;
		}
		// autoload:false with no `+` pattern anywhere is the closest thing pi has to "disabled": its delta
		// filter starts from nothing and re-adds only what a `+` names. With a `+` present, or with per-kind
		// filters, the package IS partly live, and staging is all-or-nothing on a directory, so it stages and
		// the caller warns.
		if (autoload === false && !forced) {
			found.push({ ...entry, skip: "autoload is off in your pi settings" });
			continue;
		}
		found.push(entry);
	}
	return found;
}

/**
 * The one call each command site makes. Reads pi's settings once, derives the extension enablement state
 * always, and discovers packages only when the caller asked for them.
 *
 * The two halves stay separate on purpose: the package half must not run without `--with-packages`, because
 * that is what keeps a flagless import free of any packages output at all.
 */
export async function readHostPi({ agentDir, fs = { existsSync, readFileSync, readdirSync, statSync }, exec, platform = process.platform, withPackages = false }) {
	const settingsPath = join(agentDir, AGENT_SETTINGS_FILE);
	let settings = { state: "absent", packages: [], patterns: [], npmCommand: null };
	if (fs.existsSync(settingsPath)) {
		try {
			settings = parseHostSettings(fs.readFileSync(settingsPath, "utf8"));
		} catch {
			settings = { state: "malformed", packages: [], patterns: [], npmCommand: null };
		}
	}

	const extensions = hostExtensionState({ fs, agentDir, patterns: settings.patterns });
	const packages = withPackages ? await discoverHostPackages({ agentDir, settings, fs, exec, platform }) : [];
	return { agentDir, settingsPath, settingsState: settings.state, packages, extensions };
}
