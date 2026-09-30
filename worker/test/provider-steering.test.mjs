import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTAINER_ENV_NAMES } from "../src/reserved-env.mjs";
import { classifyFile, classifyFiles, lex, skeleton, stringConstants } from "./helpers/env-reads.mjs";
import { PROVIDER_STEERING_VARS } from "../src/provider-steering.mjs";

// The bolt (issues #314, #511). A hand-written table that restates a derivable source is either derived
// or pinned, never trusted, and this one is pinned in BOTH directions against the pinned artifacts. The
// point is not that today's list is right; it is that a pi bump which starts reading a new steering
// variable fails HERE rather than opening a hole nobody notices.

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const RUNNER_DIR = join(REPO, "image/runner");

/**
 * The directory `spec` resolves to from `fromDir`, found by walking up the `node_modules` chain the way
 * node itself does. `createRequire().resolve` cannot do this for pi's packages: their `exports` maps have
 * only an `import` condition, so a require-style resolve throws on the very packages this file reads.
 */
function packageRoot(spec, fromDir) {
	for (let d = fromDir; ; d = dirname(d)) {
		const candidate = join(d, "node_modules", spec);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		if (dirname(d) === d) return undefined;
	}
}

let piEntry;
let importError;
try {
	piEntry = fileURLToPath(await import.meta.resolve("@earendil-works/pi-ai"));
} catch (error) {
	importError = error;
}
// The copy the runner dispatches through: pi-coding-agent, and the pi-ai IT resolves (nested under it
// today). Both copies are scanned, because the hoisted one is what this file resolves and the nested one
// is what runs.
const codingAgentRoot = packageRoot("@earendil-works/pi-coding-agent", RUNNER_DIR);
const runnerPiAiRoot = codingAgentRoot && packageRoot("@earendil-works/pi-ai", codingAgentRoot);
if ((!piEntry || !runnerPiAiRoot) && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`provider-steering tests are REQUIRED here but pi-ai or pi-coding-agent could not be resolved.\n${importError ?? ""}`);
}
const skip = piEntry && runnerPiAiRoot ? false : "pi-ai or pi-coding-agent not installed; CI runs these";
const hoistedPiAiRoot = piEntry && dirname(dirname(piEntry));

// Spelled out rather than imported, for the reason the literal pin at the bottom of this file gives: a test
// that iterates the constant the code reads is correct at any value. RETAINED mirrors the module's
// RETAINED_KEY_VARIABLES and RESIDUAL its UNREACHABLE_BY_SCAN.
const RETAINED = new Set(["ANTHROPIC_AUTH_TOKEN"]);
const RESIDUAL = new Set(["AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "ALL_PROXY", "http_proxy", "https_proxy"]);
// HOMEDRIVE and HOMEPATH join them from issue #511: @smithy/core reads them in the same home-directory
// helper as HOME and USERPROFILE, for the same reason.
const RUNTIME_NOT_PROVIDER = ["HOME", "PATH", "APPDATA", "USERPROFILE", "XDG_CONFIG_HOME", "HOMEDRIVE", "HOMEPATH"];

// The pins below are the classifier's own output at the 0.99.1 pin, reviewed; each test says what they mean.
// Every counted occurrence in every scanned file that names nothing, WITH ITS COUNT, per package version and
// file (see the test that reads it). A JSON file rather than a literal here because it is long and is only
// ever replaced wholesale from the failure message, after reading what changed.
const SITES_FILE = new URL("./fixtures/provider-steering-sites.json", import.meta.url);

const OUTSIDE_PI_NAMESPACE = [
	"CI", "COLORFGBG", "COLORTERM", "COLUMNS", "DISPLAY", "EDITOR", "GHOSTTY_RESOURCES_DIR", "HF_HOME",
	"HF_TOKEN", "HF_TOKEN_PATH", "HTTPS_PROXY", "HTTP_PROXY", "ITERM_SESSION_ID", "KITTY_WINDOW_ID", "LINES",
	"LLAMA_API_KEY", "LLAMA_BASE_URL", "MOSH_CONNECTION", "PNPM_HOME", "ProgramFiles", "SHELL", "SSH_CLIENT",
	"SSH_CONNECTION", "SSH_TTY", "STY", "SystemRoot", "TERM", "TERMINAL_EMULATOR", "TERMUX_VERSION",
	"TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TMUX", "VISUAL", "WARP_SESSION_ID", "WARP_TERMINAL_SESSION_UUID",
	"WAYLAND_DISPLAY", "WEZTERM_PANE", "WINDIR", "WSLENV", "WSL_DISTRO_NAME", "WSL_INTEROP", "WT_SESSION",
	"XDG_CACHE_HOME", "XDG_SESSION_TYPE", "ZELLIJ", "cwd", "error", "hasError", "is", "off", "stack",
];

/** Every .js/.mjs/.cjs file under `dir`, ignoring nested dependencies and any path `skipDir` names. */
function sourcesUnder(dir, skipDir = () => false) {
	const files = [];
	const walk = (d) => {
		for (const entry of readdirSync(d)) {
			if (entry === "node_modules") continue;
			const p = `${d}/${entry}`;
			if (statSync(p).isDirectory()) {
				if (!skipDir(p)) walk(p);
			}
			// Every build. pi-ai is `"type": "module"` so it loads the .js tree, the SDKs ship .mjs and .cjs
			// side by side, and reading one of them would measure a build pi may never run.
			else if (/\.(js|mjs|cjs)$/.test(p)) files.push(p);
		}
	};
	walk(dir);
	return files;
}

/** Where a name came from, as a failure message should say it: the package path and the file. */
const origin = (file) => relative(REPO, file).replace(/^.*?node_modules\//, "").replace(/\/node_modules\//g, " > ");

/**
 * The environment names read under `dir`, each with the file it was first seen in, and every file's SITES
 * (the counted occurrences that name nothing) as { text: count }. The classifier is in
 * `helpers/env-reads.mjs`, and its header states the rule. `constants` adds values evaluated elsewhere
 * (pi's config.js).
 */
function readsIn(dir, { skipDir, constants = {} } = {}) {
	const files = sourcesUnder(dir, skipDir);
	const r = classifyFiles(files, { evaluated: constants });
	return { files, names: r.names, sites: r.sites, viaConstants: r.viaEvaluated, helpers: r.helpers };
}

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*)["']([^."'][^"']*)["']/g;

/** The packages the sources under `dir` import, reduced to package names, builtins and pi's own excluded. */
function importedPackages(dir, skipDir) {
	const builtin = new Set(builtinModules);
	const specs = new Set();
	for (const file of sourcesUnder(dir, skipDir)) {
		for (const m of readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER)) {
			if (m[1].startsWith("node:")) continue;
			const spec = m[1].startsWith("@") ? m[1].split("/").slice(0, 2).join("/") : m[1].split("/")[0];
			if (builtin.has(spec) || spec.startsWith("@earendil-works/")) continue;
			specs.add(spec);
		}
	}
	return specs;
}

const declaredDependencies = (root) => new Set(Object.keys(JSON.parse(readFileSync(`${root}/package.json`, "utf8")).dependencies ?? {}));

/**
 * What one copy of pi-ai and the SDKs it reaches read, TWO hops deep.
 *
 * Hop 1 is the packages pi-ai's own dist imports, discovered from pi's import statements rather than
 * listed: a hardcoded pair once covered two of the five SDKs pi builds clients with. Hop 2 is, for each
 * of those, the packages its sources import AND its package.json declares in `dependencies`, resolved
 * from that package's own directory. The intersection is what keeps an optional peer out (openai imports
 * `undici` but does not declare it, so it resolves only by an accident of layout). Hop 2 is where
 * google-auth-library, @smithy/core and the AWS credential chain are.
 */
function sdkClosure(piAiRoot) {
	const packages = [{ spec: "@earendil-works/pi-ai", root: piAiRoot, hop: 0, dir: `${piAiRoot}/dist` }];
	const hop1 = new Map();
	for (const spec of importedPackages(`${piAiRoot}/dist`)) {
		const root = packageRoot(spec, piAiRoot);
		if (root) hop1.set(spec, root); // unresolvable: a types-only or optional import
	}
	const seen = new Set([piAiRoot, ...hop1.values()]);
	for (const [spec, root] of hop1) packages.push({ spec, root, hop: 1, dir: root });
	for (const [, root] of hop1) {
		const declared = declaredDependencies(root);
		for (const spec of importedPackages(root)) {
			if (!declared.has(spec)) continue;
			const dep = packageRoot(spec, root);
			if (!dep || seen.has(dep)) continue;
			seen.add(dep);
			packages.push({ spec, root: dep, hop: 2, dir: dep });
		}
	}
	const names = new Map();
	for (const p of packages) {
		p.reads = readsIn(p.dir);
		for (const [name, file] of p.reads.names) if (!names.has(name)) names.set(name, file);
	}
	return { packages, names };
}

/** pi-coding-agent's dist, minus `dist/bundle/`: the vendored single-file build the runner does not load. */
const notBundle = (p) => p === `${codingAgentRoot}/dist/bundle`;

/**
 * pi's OWN namespace: every `${APP_NAME}_*` name pi-coding-agent and the pi packages it declares read.
 *
 * pi reads its agent and session directories through keys it builds at runtime from APP_NAME
 * (`${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`), so config.js is imported to evaluate them. It is the one
 * module of pi this file imports, and each identifier resolved through it is asserted to be imported FROM
 * it by the file that reads it. Names outside the namespace (the terminal, the OS, the proxy variables)
 * are not pi's configuration; they are left out here and pinned in OUTSIDE_PI_NAMESPACE.
 */
async function piNamespace() {
	const config = await import(pathToFileURL(`${codingAgentRoot}/dist/config.js`).href);
	const constants = Object.fromEntries(Object.entries(config).filter(([, v]) => typeof v === "string"));
	const prefix = `${config.APP_NAME.toUpperCase()}_`;
	const sources = [{ spec: "@earendil-works/pi-coding-agent", root: codingAgentRoot, reads: readsIn(`${codingAgentRoot}/dist`, { skipDir: notBundle, constants }) }];
	// And pi's other packages, followed through declared dependencies inside @earendil-works only: pi-tui
	// reads its own PI_* switches, and it runs inside the same process. Each one's dist, the build that
	// loads, not its build scripts.
	const queue = [codingAgentRoot];
	const seen = new Set(queue);
	while (queue.length) {
		const from = queue.shift();
		for (const spec of declaredDependencies(from)) {
			if (!spec.startsWith("@earendil-works/")) continue;
			const root = packageRoot(spec, from);
			if (!root || seen.has(root)) continue;
			seen.add(root);
			queue.push(root);
			assert.ok(existsSync(`${root}/dist`), `${origin(root)} has no dist to scan`);
			sources.push({ spec, root, reads: readsIn(`${root}/dist`) });
		}
	}
	const names = new Map();
	for (const { reads } of sources) for (const [name, file] of reads.names) if (name.startsWith(prefix) && !names.has(name)) names.set(name, file);
	return { names, prefix, sources, config };
}

/**
 * The pi-namespace names the runner itself assigns before pi runs, derived from the runner's own source.
 * A trigger binding one of these is overwritten before pi reads it, so it steers nothing.
 */
function runnerAssigned(prefix) {
	const assigned = new Map();
	const re = new RegExp(String.raw`\benv\.(${prefix}[A-Z0-9_]+)\s*=(?!=)`, "g");
	for (const file of sourcesUnder(`${RUNNER_DIR}/src`)) {
		for (const m of readFileSync(file, "utf8").matchAll(re)) assigned.set(m[1], file);
	}
	return assigned;
}

let derivation;
async function derive() {
	if (derivation) return derivation;
	const hoisted = sdkClosure(hoistedPiAiRoot);
	const runner = sdkClosure(runnerPiAiRoot);
	const sdk = new Map([...runner.names, ...hoisted.names]);
	const pi = await piNamespace();
	const assigned = runnerAssigned(pi.prefix);
	derivation = { hoisted, runner, sdk, pi, assigned };
	return derivation;
}

test("the set is exactly what the pinned sources read, minus the key variables, plus the named exceptions", { skip }, async () => {
	const { hoisted, runner, sdk, pi, assigned } = await derive();

	// Guards before the comparison. An extractor that matched nothing would pass a subtraction and fail an
	// equality in a way that reads like a list problem rather than a scanner problem.
	assert.ok(sdk.size > 60, `the extractors matched ${sdk.size} names, too few to be real`);
	for (const closure of [hoisted, runner]) {
		const specs = closure.packages.map((p) => p.spec);
		for (const spec of ["@anthropic-ai/sdk", "openai", "@google/genai", "google-auth-library", "@smithy/core"]) {
			assert.ok(specs.includes(spec), `${spec} is no longer reached from ${origin(closure.packages[0].root)} -- check what replaced it BEFORE touching the list`);
		}
		// openai imports undici but does not declare it: the declared-dependency filter keeps it out.
		assert.equal(specs.includes("undici"), false, "hop 2 followed an undeclared optional import");
	}

	// A provider's KEY variables are `providerKeyCandidates`' business, refused pre-spend against the job's
	// own provider, and the bound that gate keeps is deliberate: an anthropic job may bind OPENAI_API_KEY
	// for a flow that talks to OpenAI. Subtracted HERE rather than by hand in the module, so the two stay one
	// derivation. The one the module keeps anyway is asserted in its own test below.
	const { piProviders, providerKeyCandidates } = await import("../src/env-allowlist.mjs");
	const providerKeys = new Set(piProviders().flatMap((id) => providerKeyCandidates(id)));
	assert.ok(providerKeys.size > 25, `only ${providerKeys.size} provider key variables; the subtraction below is probably reading the wrong thing`);
	const derived = new Map(sdk);
	for (const name of providerKeys) derived.delete(name);

	// The operating-system variables the Anthropic SDK reads (issue #509): the four directory variables
	// locate its default config directory, and PATH is read by its agent toolset, which pi does not use.
	// Each is asserted to be FOUND before it is subtracted, so a subtraction nothing needs any more fails
	// here instead of sitting in the list unexamined.
	for (const name of RUNTIME_NOT_PROVIDER) {
		assert.ok(derived.has(name), `${name} is no longer read by the scanned sources: drop it from RUNTIME_NOT_PROVIDER`);
		derived.delete(name);
	}

	// pi's own namespace, minus what the worker owns (CONTAINER_ENV_NAMES, reserved already) and what the
	// runner overwrites before pi runs. Each subtracted name must still be read by pi, so a subtraction that
	// stopped being needed is noticed.
	assert.ok(assigned.size > 0, "the runner assigns no pi variable any more: the runner-subtraction regex is reading nothing");
	for (const [name, file] of assigned) {
		assert.ok(pi.names.has(name), `the runner assigns ${name} (${origin(file)}) but pi no longer reads it: the subtraction is stale`);
	}
	for (const [name, file] of pi.names) {
		if (CONTAINER_ENV_NAMES.has(name) || assigned.has(name)) continue;
		if (!derived.has(name)) derived.set(name, file);
	}

	const missing = [...derived.keys()].filter((n) => !PROVIDER_STEERING_VARS.has(n)).sort();
	const extra = [...PROVIDER_STEERING_VARS].filter((n) => !derived.has(n) && !RESIDUAL.has(n) && !RETAINED.has(n)).sort();
	assert.deepEqual(
		missing.map((n) => `${n} (${origin(derived.get(n))})`),
		[],
		"the pinned sources read these names and the reserved set does not know about them. Do NOT delete this assertion: add them to worker/src/provider-steering.mjs, because a trigger can bind anything this set does not name.",
	);
	assert.deepEqual(
		extra,
		[],
		`the reserved set names ${extra.join(", ")}, which nothing in the pinned sources reads any more. Remove them, or the set has stopped being a derivation.`,
	);
});

test("the retained key variable is still a key variable pi reads AND a name the scan finds (#509)", { skip }, async () => {
	// ANTHROPIC_AUTH_TOKEN became a pi key variable at 0.99.1, so the subtraction above would drop it and
	// the set would release a name refused at load since #314. The module keeps it by name; this pins both
	// facts that make that a choice rather than drift.
	const { providerKeyCandidates } = await import("../src/env-allowlist.mjs");
	const { sdk } = await derive();
	for (const name of RETAINED) {
		assert.ok(PROVIDER_STEERING_VARS.has(name), `${name} must be reserved`);
		assert.ok(providerKeyCandidates("anthropic").includes(name), `${name} is no longer a pi key variable: the ordinary derivation owns it again, drop it from RETAINED_KEY_VARIABLES`);
		assert.ok(sdk.has(name), `${name} is no longer read by the scanned sources: re-check whether reserving it still means anything`);
	}
});

test("each source the derivation depends on still yields names, in BOTH copies", { skip }, async () => {
	// The failure this guards is silent: a package whose names the extractors cannot see contributes zero,
	// the union stays above the size guard because the other sources carry it, and the bolt passes while
	// covering less than it says. Asserted per source and per copy, because the two copies of
	// google-auth-library are different versions (the runner's nests under pi-coding-agent).
	const { hoisted, runner, pi } = await derive();
	const expected = {
		"@earendil-works/pi-ai": ["AZURE_OPENAI_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK", "CLOUDFLARE_ACCOUNT_ID"],
		"@anthropic-ai/sdk": ["ANTHROPIC_BASE_URL"],
		openai: ["OPENAI_BASE_URL", "AZURE_OPENAI_ENDPOINT"],
		"@google/genai": ["GOOGLE_GEMINI_BASE_URL", "GOOGLE_VERTEX_BASE_URL", "GOOGLE_GENAI_ACCESS_TOKEN"],
		// Hop 2. The lowercase twin is the exact-match case the issue was filed about, the constant
		// resolution is the only way @smithy/core's config file is seen, and the selector form
		// (`booleanSelector(env, ENV_USE_FIPS_ENDPOINT, ...)`) the only way its endpoint switches are.
		"google-auth-library": ["GOOGLE_CLOUD_QUOTA_PROJECT", "google_application_credentials"],
		"@smithy/core": ["AWS_CONFIG_FILE", "AWS_USE_FIPS_ENDPOINT", "AWS_ENDPOINT_URL"],
	};
	for (const closure of [hoisted, runner]) {
		for (const [spec, needles] of Object.entries(expected)) {
			const found = new Set(closure.packages.filter((p) => p.spec === spec).flatMap((p) => [...p.reads.names.keys()]));
			for (const needle of needles) {
				assert.ok(found.has(needle), `${spec} (from ${origin(closure.packages[0].root)}) no longer yields ${needle} -- the accessor it used has changed, so this source is contributing nothing`);
			}
		}
	}
	// The runner's copy of google-auth-library is the one that runs; the scan must actually read it.
	if (existsSync(`${codingAgentRoot}/node_modules/google-auth-library`)) {
		const gal = runner.packages.filter((p) => p.spec === "google-auth-library").map((p) => p.root);
		assert.ok(gal.some((r) => r.startsWith(`${codingAgentRoot}/node_modules/`)), "the runner closure is not reading the google-auth-library nested under pi-coding-agent");
	}
	for (const needle of ["PI_CODING_AGENT_DIR", "PI_RADIUS_GATEWAY", "PI_TUI_ESC_TIMEOUT"]) {
		assert.ok(pi.names.has(needle), `pi-coding-agent no longer yields ${needle}: its namespace scan is contributing less than it says`);
	}
});

/** Every scanned package once per copy, with the key a pin files it under. */
function everyPackage({ hoisted, runner, pi }) {
	return [...hoisted.packages, ...runner.packages, ...pi.sources];
}

/** `actual` must equal `pinned`; the message carries the actual value as JSON, ready to review and paste. */
function assertPinned(actual, pinned, why) {
	assert.deepEqual(actual, pinned, `${why}\nactual: ${JSON.stringify(actual, null, "\t")}`);
}

/** `${spec}@${version}/${file}` for a scanned file: the key the per-file pin uses. */
function siteKey(spec, root, file) {
	const { version } = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
	return `${spec}@${version}/${relative(root, file)}`;
}

test("every counted occurrence that names nothing is pinned, per file, WITH ITS COUNT", { skip }, async () => {
	// The rule that makes the derivation complete by construction (issue #511, gate rounds 1 and 2). The
	// classifier counts every occurrence that can reach the environment (every `env` token, every
	// `process["env"]`, every use of an alias of one, every call of a named helper). An occurrence either
	// names a variable, which the equality test sees, or it is a SITE, pinned here by file and text with a
	// count. So a new occurrence ANYWHERE either names something or changes a count: a helper that reads
	// `process.env[name]` for a new caller, `const v = env(); v.X` where X did not resolve, a key built at
	// runtime, a new spread of the environment into a child. Keyed by package VERSION too, because the two
	// copies differ (google-auth-library 10.9.1 hoisted, 10.6.2 for the runner); a key both copies share
	// must agree, so an edit to one copy of the same version fails here as well.
	const all = everyPackage(await derive());
	const actual = {};
	const disagree = [];
	for (const { spec, root, reads } of all) {
		for (const [file, counts] of reads.sites) {
			const key = siteKey(spec, root, file);
			if (actual[key] && JSON.stringify(actual[key]) !== JSON.stringify(counts)) disagree.push(key);
			actual[key] = counts;
		}
	}
	assert.deepEqual(disagree, [], "two copies of the same package version disagree about these files: one of them was edited");
	const pinned = JSON.parse(readFileSync(SITES_FILE, "utf8"));
	const changed = [...new Set([...Object.keys(actual), ...Object.keys(pinned)])].filter((k) => JSON.stringify(actual[k] ?? null) !== JSON.stringify(pinned[k] ?? null)).sort();
	const paste = Object.fromEntries(changed.map((k) => [k, actual[k] ?? null]));
	assert.deepEqual(
		changed,
		[],
		`these files' environment sites changed. Read each one: if it reads a variable the classifier cannot name, reserve that variable (or teach helpers/env-reads.mjs the form); only then replace these entries in test/fixtures/provider-steering-sites.json (null means remove the entry):\n${JSON.stringify(paste, null, "\t")}`,
	);
});

test("the helpers are DERIVED from the sources, and the known ones are among them", { skip }, async () => {
	// A helper is any named function one of whose own parameters is the key of an environment read; its
	// CALL sites are counted like reads. The SDKs' named readers are asserted to fall out of that rule, so
	// the rule rather than a list is what covers them, and a new caller of an existing helper (the gate's
	// `resolveEnvConfigValue("NEW")` demonstration) names its variable or changes a count.
	const all = everyPackage(await derive());
	const derived = new Set(all.flatMap(({ reads }) => [...reads.helpers.keys()]));
	for (const name of ["getProviderEnvValue", "readEnv", "getEnv", "resolveEnvConfigValue"]) {
		assert.ok(derived.has(name), `${name} is no longer derived as a helper`);
	}
});

test("the tokenizer that strips comments is checked against an independent parser on every scanned file", { skip }, async () => {
	// The classifier ignores comments, strings and regex literals, so a lexer that misread a `/` or a
	// template would hide or invent occurrences. skeleton() rebuilds each file from the lexer's own view
	// (comments gone, every literal minimal); if the lexer misread anything, that no longer parses. The
	// independent parser is esbuild, installed at the root by `npm ci` for the admin build. Absent, the
	// check is skipped locally and fails in CI, where PI_DISPATCH_REQUIRE_WORKER_TESTS is set.
	let esbuild;
	try {
		esbuild = createRequire(join(REPO, "admin/package.json"))("esbuild");
	} catch (error) {
		if (process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error(`esbuild is required to check the tokenizer: ${error.message}`);
		return;
	}
	const all = everyPackage(await derive());
	const files = new Set(all.flatMap(({ reads }) => reads.files));
	assert.ok(files.size > 1000, `only ${files.size} files scanned`);
	// Warnings off by name: on a large minified file (pi's 3.7 MB bundle chunk) collecting them turned a
	// 141 ms parse into a hang, and a check that can wedge CI is worse than none.
	const options = { loader: "js", logLevel: "silent", logOverride: { "impossible-typeof": "silent", "duplicate-case": "silent", "duplicate-object-key": "silent" } };
	const broken = [];
	for (const file of files) {
		const src = readFileSync(file, "utf8");
		try {
			esbuild.transformSync(src, options);
		} catch {
			continue; // not a file esbuild parses as it stands; nothing to compare
		}
		try {
			esbuild.transformSync(skeleton(src), options);
		} catch (error) {
			broken.push(`${origin(file)}: ${error.errors?.[0]?.text ?? error.message}`);
		}
	}
	assert.deepEqual(broken, [], "the tokenizer misread these files");
});

test("the names pi reads outside its own namespace are pinned, so dropping them is a decision on record", { skip }, async () => {
	// The namespace rule keeps pi's own `PI_*` configuration and leaves the rest: the terminal, the OS, the
	// editor, the proxy variables (egress-reserved), and the llama.cpp extension's LLAMA_BASE_URL (whose
	// provider the worker cannot select, asserted below). Some are not environment reads at all: pi-agent-core
	// calls its execution context `env` (`env.cwd`). Pinned, so a new name pi starts reading outside its
	// namespace is looked at rather than silently skipped. Names the SDK derivation reserves anyway are left
	// out of this list.
	const { pi, sdk } = await derive();
	const dropped = new Set();
	for (const { reads } of pi.sources) for (const name of reads.names.keys()) if (!name.startsWith(pi.prefix) && !sdk.has(name)) dropped.add(name);
	assertPinned([...dropped].sort(), OUTSIDE_PI_NAMESPACE, "pi reads a new name outside its PI_* namespace: decide whether it steers anything before updating this pin");
});

test("pi's namespace is read through config.js alone, outside the vendored bundle", { skip }, async () => {
	const { pi } = await derive();
	// The runner imports pi through `exports["."]`; if that ever moves INTO dist/bundle, skipping the bundle
	// would skip the code that runs.
	const pkg = JSON.parse(readFileSync(`${codingAgentRoot}/package.json`, "utf8"));
	const entry = pkg.exports["."].import ?? pkg.exports["."].default;
	assert.ok(entry && !entry.includes("/bundle/"), `pi-coding-agent's entry ${entry} is inside dist/bundle, which this scan skips`);
	// The two directory keys are resolved through config.js, and each file that reads one imports it from
	// there, so the value evaluated is the value read.
	const coding = pi.sources[0].reads;
	assert.deepEqual([...coding.viaConstants.keys()].sort(), ["ENV_AGENT_DIR", "ENV_SESSION_DIR"], "the set of keys resolved through config.js changed");
	for (const [id, file] of coding.viaConstants) {
		if (file === `${codingAgentRoot}/dist/config.js`) {
			assert.match(readFileSync(file, "utf8"), new RegExp(String.raw`export const ${id}\s*=`), `config.js reads ${id} without defining it`);
			continue;
		}
		assert.match(readFileSync(file, "utf8"), new RegExp(String.raw`import\s*\{[^}]*\b${id}\b[^}]*\}\s*from\s*["'][./]*config\.js["']`), `${origin(file)} does not import ${id} from config.js`);
	}
	assert.equal(pi.prefix, "PI_", "APP_NAME changed, and with it every name in pi's namespace");
});

test("the runner's own writes are derived, and only those are subtracted from pi's namespace", { skip }, async () => {
	const { assigned } = await derive();
	// Pinned for the reader, derived for the bolt: the assertion that matters is in the equality test.
	assert.deepEqual([...assigned.keys()].sort(), ["PI_OFFLINE", "PI_TELEMETRY"]);
	// And a write is not a read: pi assigns PI_CODING_AGENT for its children and never reads it.
	assert.equal(PROVIDER_STEERING_VARS.has("PI_CODING_AGENT"), false, "PI_CODING_AGENT is written by pi, not read");
});

test("the llama.cpp extension provider is not one the worker can select, so its reads stay outside", { skip }, async () => {
	// pi-coding-agent reads LLAMA_BASE_URL both through the extension context (`ctx.env("LLAMA_BASE_URL")`)
	// and through `process.env.LLAMA_BASE_URL` (provider.js, its login prompt). The scan FINDS both, and the
	// namespace rule leaves them out with the rest of OUTSIDE_PI_NAMESPACE. That is safe only while the
	// worker cannot dispatch to this provider, which is what this pins.
	const provider = readFileSync(`${codingAgentRoot}/dist/extensions/llama/provider.js`, "utf8");
	const id = /LLAMA_PROVIDER_ID\s*=\s*["']([^"']+)["']/.exec(provider)?.[1];
	assert.ok(id, "the llama provider id moved");
	const { pi } = await derive();
	assert.ok(pi.sources[0].reads.names.has("LLAMA_BASE_URL"), "the scan no longer finds pi's LLAMA_BASE_URL read");
	assert.ok(OUTSIDE_PI_NAMESPACE.includes("LLAMA_BASE_URL"));
	const { piProviders } = await import("../src/env-allowlist.mjs");
	assert.equal(piProviders().includes(id), false, `${id} is now a provider the worker dispatches to: reserve its LLAMA_* reads`);
});

test("the residuals are the ONLY hand-written members, and they are still unfindable", { skip }, async () => {
	// "Derived, never curated" has to be true or said. These four are read through keys the source builds
	// at runtime, so no classifier names them; that is asserted, so the day one of them becomes findable it
	// moves out of the residual list rather than sitting there unexamined. The sites that build their keys
	// are in the per-file pin, which is the evidence rather than folklore.
	const { sdk, pi } = await derive();
	for (const name of RESIDUAL) {
		assert.ok(PROVIDER_STEERING_VARS.has(name), `${name} must be reserved`);
		assert.equal(sdk.has(name) || pi.names.has(name), false, `${name} is now reachable by the scan: move it out of UNREACHABLE_BY_SCAN so the derivation owns it`);
	}
	const sites = Object.entries(JSON.parse(readFileSync(SITES_FILE, "utf8")));
	const siteIn = (prefix, needle) => sites.some(([k, counts]) => k.startsWith(prefix) && Object.keys(counts).some((t) => t.includes(needle)));
	assert.ok(siteIn("@smithy/core@", "ENV_ENDPOINT_URL, ...serviceSuffixParts"), "the smithy AWS_ENDPOINT_URL_<SERVICE> key is gone: re-check AWS_ENDPOINT_URL_BEDROCK_RUNTIME");
	assert.ok(siteIn("@earendil-works/pi-ai@", "[uppercaseKey]"), "pi's proxy reader no longer builds its keys: re-check the proxy residuals");
	const proxy = readFileSync(`${dirname(piEntry)}/utils/node-http-proxy.js`, "utf8");
	assert.match(proxy, /toLowerCase\(\)/, "pi's proxy reader no longer lowercases its key, so the lowercase spellings may no longer be read");
	assert.match(proxy, /\$\{protocol\}_proxy/, "pi no longer builds `${protocol}_proxy`: re-check http_proxy and https_proxy");
});

test("the copy of pi this bolt resolves and the copy the runner dispatches through agree", { skip }, async () => {
	// `image/runner/src/usage-meter.mjs` carries this repo's own warning that `import.meta.resolve` lies
	// here: the runner runs pi through pi-coding-agent, which nests its OWN pi-ai. Both closures feed the
	// set, but pi-ai itself is also compared directly, so a divergence is named rather than absorbed.
	const { hoisted, runner } = await derive();
	assert.notEqual(runner.packages[0].root, hoisted.packages[0].root, "the runner closure is reading the hoisted pi-ai, so this is a set against itself");
	const nestedNames = runner.packages[0].reads.names;
	assert.ok(nestedNames.size > 20, `the nested copy yielded ${nestedNames.size} names, so this is measuring an empty directory rather than a second pi`);
	assert.deepEqual(
		[...nestedNames.keys()].sort(),
		[...hoisted.packages[0].reads.names.keys()].sort(),
		"the nested pi-ai the runner dispatches through reads a DIFFERENT set of provider variables than the hoisted one",
	);
});

test("the names that motivated the issues are all in, and an ordinary secret is not", { skip }, () => {
	// A literal pin beside the derivation, because a derived set is correct at any value and therefore
	// blind to a change IN that value. Each of these was measured redirecting or substituting for real.
	for (const name of [
		"AZURE_OPENAI_BASE_URL",
		"AZURE_OPENAI_RESOURCE_NAME",
		"ANTHROPIC_BASE_URL",
		"ANTHROPIC_AUTH_TOKEN",
		// Measured at the 0.99.1 pin (issue #509; env-allowlist.test.mjs pins it): each replaces the
		// credential header pi's own request carries.
		"ANTHROPIC_CUSTOM_HEADERS",
		"OPENAI_BASE_URL",
		"OPENAI_CUSTOM_HEADERS",
		"GOOGLE_GEMINI_BASE_URL",
		"GOOGLE_VERTEX_BASE_URL",
		"AWS_ENDPOINT_URL",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_BEDROCK_SKIP_AUTH",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
		// Issue #511: the lowercase twins google-auth-library reads, the quota project, and pi's own
		// agent directory.
		"google_application_credentials",
		"gcloud_project",
		"google_cloud_project",
		"GOOGLE_CLOUD_QUOTA_PROJECT",
		"PI_CODING_AGENT_DIR",
	]) {
		assert.ok(PROVIDER_STEERING_VARS.has(name), `${name} must be reserved`);
	}
	// And the bound. Reserving every name would make run.secrets useless, which is the feature this
	// protects rather than replaces. Matching is exact: a lowercase spelling no pinned source reads stays
	// bindable, and so does a provider key variable's lowercase form.
	for (const name of ["STRIPE_KEY", "MY_APP_TOKEN", "DATABASE_URL", "NPM_TOKEN", "SENTRY_DSN", "openai_base_url", "anthropic_api_key"]) {
		assert.equal(PROVIDER_STEERING_VARS.has(name), false, `${name} is an operator's own secret and must stay bindable`);
	}
});

test("bedrock is why the key variables stay in this set rather than being left to the pre-spend gate", { skip }, async () => {
	// `providerKeyCandidates("amazon-bedrock")` is empty, so the pre-spend gate reserved NOTHING at all for
	// a bedrock deployment: a trigger could bind AWS_SECRET_ACCESS_KEY outright and every job of it would
	// run on the trigger author's account. Asserted against pi's real answer, not a fixture.
	const { providerKeyCandidates } = await import("../src/env-allowlist.mjs");
	assert.deepEqual(providerKeyCandidates("amazon-bedrock"), [], "if bedrock ever gains a key variable, this test's premise is gone and the comment above needs revisiting");
	for (const name of ["AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"]) {
		assert.ok(PROVIDER_STEERING_VARS.has(name), `${name} is reserved by THIS set or by nothing`);
	}
});

test("this set and the pre-spend provider gate are COMPLEMENTARY, not one subsuming the other", { skip }, async () => {
	// Worth pinning because it is easy to conclude the wrong thing in either direction. This set is derived
	// from what pi and its SDKs READ, minus the key variables, so provider key variables are not in here:
	// 37 of 38 at the 0.99.1 pin are outside the set (the one inside is the retained ANTHROPIC_AUTH_TOKEN),
	// and 32 of them are not even read by name in a scanned SDK source. So the pre-spend gate and doctor's
	// per-provider check both still have work to do, and a fixture using one of the names both cover
	// would silently stop exercising them -- which is exactly what happened to two doctor tests when this
	// landed.
	const { piProviders, providerKeyCandidates } = await import("../src/env-allowlist.mjs");
	const keys = new Set(piProviders().flatMap((p) => providerKeyCandidates(p)));
	const outside = [...keys].filter((k) => !PROVIDER_STEERING_VARS.has(k));
	assert.ok(outside.length > 20, `only ${outside.length} provider key variables sit outside this set; if that ever reaches zero, the pre-spend gate is dead code and should be reasoned about rather than left`);
	assert.ok(outside.includes("HF_TOKEN") && outside.includes("ANTHROPIC_OAUTH_TOKEN"), "the doctor fixtures depend on these two being outside");
});

test("the classifier names every access form it claims to, and counts everything else as a site", () => {
	// Pinned against a fixture rather than only through the pinned sources, because a form the sources do
	// not use today would otherwise have no test at all. Every line is one form (issue #511, gate rounds 1
	// and 2). The comment and string lines must contribute nothing.
	const src = [
		'const K = "CONST_KEY";',
		"process.env.DOT_READ;",
		'process.env["BRACKET_READ"];',
		"process.env?.OPTIONAL_READ;",
		"process.env?.['OPTIONAL_BRACKET'];",
		"process.env[K];",
		"const { DESTRUCTURED, RENAMED: r, DEFAULTED = 1 } = process.env;",
		"const e = process.env; e.ALIAS_READ;",
		'if ("IN_CHECK" in process.env) {}',
		"const f = (env) => env[K] ?? env.SELECTOR_DOT;",
		'async function g(ctx) { return ctx.env("CTX_CALL"); }',
		"booleanSelector(env, K2, SelectorType.ENV);",
		'const K2 = "SELECTOR_ARG";',
		'deno.env.get("GET_CALL");',
		"const envVars = env(); envVars.ENV_CALL_ALIAS;",
		"env().ENV_CALL_DIRECT;",
		'process["env"]["BRACKET_PROCESS"];',
		'process["env"].BRACKET_PROCESS_DOT;',
		"function h() { const { env: pe } = process; return pe.DESTRUCTURED_PROCESS_ALIAS; }",
		"function i() { const { env: { NESTED_DESTRUCTURE } } = process; }",
		'import { env as nodeEnv } from "node:process";',
		"nodeEnv.IMPORTED_ALIAS;",
		"function j(env) { const local = env; return local.PARAM_ALIAS; }",
		"function getProviderEnvValue(name, env) { return env?.[name] || process.env[name]; }",
		'getProviderEnvValue("HELPER_LITERAL");',
		"const resolveCfg = (key, env) => env?.[key];",
		"resolveCfg(K, {});",
		"// process.env.IN_A_LINE_COMMENT",
		"/* process.env.IN_A_BLOCK_COMMENT */",
		'const s = "process.env.IN_A_STRING";',
		"const re = /process.env.IN_A_REGEX/;",
		"process.env.WRITTEN = 1;",
		"delete process.env.DELETED;",
		"process.env[`TEMPLATE_${x}`];",
		"function helper(name) { return process.env[name]; }",
		"getProviderEnvValue(someName);",
		"spawn(cmd, { env: { ...process.env } });",
		'import "./utils/env.js";',
		"ctx.env.fileInfo(path);",
	].join("\n");
	const constants = stringConstants(lex(src).code);
	// Two passes, as classifyFiles runs them: the first derives the helpers, the second counts their calls.
	const helpers = new Map(classifyFile(src, (id) => constants.get(id)).helpers.map(({ name, index }) => [name, index]));
	assert.deepEqual([...helpers.keys()].sort(), ["getProviderEnvValue", "helper", "resolveCfg"], "the helpers are derived from their own parameter reads");
	const r = classifyFile(src, (id) => constants.get(id), helpers);
	const names = new Set(r.names);
	for (const name of [
		"DOT_READ", "BRACKET_READ", "OPTIONAL_READ", "OPTIONAL_BRACKET", "CONST_KEY", "DESTRUCTURED", "RENAMED", "DEFAULTED",
		"ALIAS_READ", "IN_CHECK", "SELECTOR_DOT", "CTX_CALL", "SELECTOR_ARG", "GET_CALL", "ENV_CALL_ALIAS", "ENV_CALL_DIRECT",
		"BRACKET_PROCESS", "BRACKET_PROCESS_DOT", "DESTRUCTURED_PROCESS_ALIAS", "NESTED_DESTRUCTURE", "IMPORTED_ALIAS", "PARAM_ALIAS",
		"HELPER_LITERAL", "CONST_KEY",
	]) {
		assert.ok(names.has(name), `${name} is not classified as a read`);
	}
	for (const name of ["IN_A_LINE_COMMENT", "IN_A_BLOCK_COMMENT", "IN_A_STRING", "IN_A_REGEX", "WRITTEN", "DELETED", "js", "fileInfo"]) {
		assert.equal(names.has(name), false, `${name} is not a read`);
	}
	// And each of these is a SITE, so the per-file count sees it: a write, a delete, a template key, a
	// helper's parameter read, a helper called with a variable, the environment spread into a child, and a
	// method on some other `env`.
	for (const needle of ["WRITTEN = 1", "delete", "TEMPLATE_", "process.env[name]", "getProviderEnvValue(someName)", "...process.env", "env.fileInfo"]) {
		assert.ok(r.sites.some((t) => t.includes(needle)), `no site for ${needle}`);
	}
});

test("this module imports nothing", () => {
	// `triggers.mjs` is the shared validator: the receiver loads it and admin/build.mjs inlines it into the
	// published console, so nothing this module reaches may drag pi or node:fs into that graph. Same rule
	// as reserved-env.mjs, provider-key.mjs and json-duplicates.mjs.
	const src = readFileSync(new URL("../src/provider-steering.mjs", import.meta.url), "utf8");
	assert.equal(/^\s*import\s/m.test(src), false, "provider-steering.mjs must stay import-free");
});
