import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverHostPackages, extensionEntryPaths, hostExtensionState, isEnabledByPatterns, parseHostSettings, parsePackageSource, readHostPi } from "../src/host-pi.mjs";

/**
 * host-pi.mjs mirrors private details of the pinned pi, so these tests pin the MIRROR. What they do not do
 * is prove the mirror still matches pi -- that is host-pi.pinned.test.mjs's job, against the real artifact.
 *
 * Real fs in a tmpdir (the import-pi.test.mjs posture); only `exec` is faked, and only where the legacy
 * global lookup is under test.
 */

const agentDir = () => mkdtempSync(join(tmpdir(), "pi-agent-"));

/** A host agent dir with a settings.json and, optionally, packages installed under npm/node_modules. */
function hostSetup({ settings, installed = [] } = {}) {
	const dir = agentDir();
	if (settings !== undefined) writeFileSync(join(dir, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
	for (const pkg of installed) {
		const target = join(dir, "npm", "node_modules", pkg.name);
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, ...(pkg.pi ? { pi: pkg.pi } : {}) }));
		for (const conventionDir of pkg.dirs ?? []) mkdirSync(join(target, conventionDir), { recursive: true });
	}
	return dir;
}

/** An `exec` that answers one command shape and records every call, so a probe can be asserted or refused. */
function execStub(answers = {}) {
	const calls = [];
	return {
		calls,
		exec: async (file, args) => {
			calls.push({ file, args });
			const key = args.join(" ");
			if (!(key in answers)) throw new Error(`unexpected exec: ${file} ${key}`);
			return { stdout: answers[key] };
		},
	};
}
const noExec = execStub().exec;

// --- parseHostSettings: pure over TEXT, and it NEVER throws ------------------------------------------

test("parseHostSettings reads only the three keys it needs and ignores the rest of pi's settings", () => {
	const got = parseHostSettings(JSON.stringify({ packages: ["npm:@a/b"], extensions: ["-extensions/x/index.js"], npmCommand: ["pnpm"], theme: "dark", defaultModel: "sonnet" }));
	assert.equal(got.state, "ok");
	assert.deepEqual(got.packages, ["npm:@a/b"]);
	assert.deepEqual(got.patterns, ["-extensions/x/index.js"]);
	assert.deepEqual(got.npmCommand, ["pnpm"]);
});

test("parseHostSettings never throws: garbage, a non-object, and a non-array packages key all degrade", () => {
	assert.equal(parseHostSettings("{ not json").state, "malformed");
	assert.equal(parseHostSettings("[]").state, "malformed", "an array is not a settings object");
	assert.equal(parseHostSettings("null").state, "malformed");
	assert.equal(parseHostSettings("{}").state, "ok", "an empty settings file is valid and declares nothing");

	// The extension patterns still apply when only `packages` is the wrong shape -- one broken key must not
	// cost the operator the enablement state of the other.
	const partial = parseHostSettings(JSON.stringify({ packages: "not-an-array", extensions: ["-extensions/x/index.js"] }));
	assert.equal(partial.state, "packages-not-an-array");
	assert.deepEqual(partial.packages, []);
	assert.deepEqual(partial.patterns, ["-extensions/x/index.js"]);
});

// --- parsePackageSource: pi's own spec split ---------------------------------------------------------

test("parsePackageSource splits a scoped name from its version, which is the trap in the spec grammar", () => {
	// Two "@" characters: a naive lastIndexOf would take the scope apart instead of the version.
	assert.deepEqual(parsePackageSource("npm:@acme/x@1.2.3"), { kind: "npm", name: "@acme/x", spec: "@acme/x@1.2.3", requested: "1.2.3", raw: "npm:@acme/x@1.2.3" });
	assert.equal(parsePackageSource("npm:@acme/x").name, "@acme/x", "no version at all is the common case");
	assert.equal(parsePackageSource("npm:plain@^1").name, "plain");
	assert.equal(parsePackageSource("npm:plain@^1").requested, "^1", "a range is REPORTED and never trusted as a pin");
});

test("parsePackageSource classifies git and local sources, since neither can be staged", () => {
	assert.equal(parsePackageSource("git:github.com/acme/thing").kind, "git");
	assert.equal(parsePackageSource("git:github.com/acme/thing").name, "github.com/acme/thing");
	assert.equal(parsePackageSource("github.com/acme/thing").kind, "git");
	assert.equal(parsePackageSource("./local/thing").kind, "local");
	assert.equal(parsePackageSource("/abs/thing").kind, "local");
	assert.equal(parsePackageSource("~/thing").kind, "local");
});

// --- isEnabledByPatterns: pi's override grammar, including the state we refuse to guess ---------------

const candidate = { rel: "extensions/my-tool/index.js", name: "index.js", abs: "/home/rob/.pi/agent/extensions/my-tool/index.js" };

test("isEnabledByPatterns defaults to enabled, and a plain pattern is not an override at all", () => {
	assert.equal(isEnabledByPatterns(candidate, []), true);
	// getOverridePatterns keeps only !/+/- prefixed entries; a bare pattern belongs to a different code path
	// in pi and must not read as an exclusion here.
	assert.equal(isEnabledByPatterns(candidate, ["extensions/other/index.js"]), true);
});

test("isEnabledByPatterns resolves in pi's precedence: '-' beats '+' beats '!'", () => {
	assert.equal(isEnabledByPatterns(candidate, ["-extensions/my-tool/index.js"]), false, "what `pi config` actually writes");
	assert.equal(isEnabledByPatterns(candidate, ["!extensions/my-tool/index.js"]), false);
	assert.equal(isEnabledByPatterns(candidate, ["!extensions/my-tool/index.js", "+extensions/my-tool/index.js"]), true, "+ re-enables after !");
	assert.equal(isEnabledByPatterns(candidate, ["+extensions/my-tool/index.js", "-extensions/my-tool/index.js"]), false, "- wins outright, whatever the order");
	assert.equal(isEnabledByPatterns(candidate, ["!index.js"]), false, "! also matches the basename, which + and - do not");
	assert.equal(isEnabledByPatterns(candidate, ["+index.js"]), true, "+ is EXACT against rel/abs only, so a basename never force-includes");
	assert.equal(isEnabledByPatterns(candidate, ["-./extensions/my-tool/index.js"]), false, "a leading ./ is stripped before comparison");
});

// The honesty property: three states, not two. Fail open, and say which.
test("isEnabledByPatterns returns null for a glob rather than guessing, unless an exact rule already decided", () => {
	assert.equal(isEnabledByPatterns(candidate, ["!extensions/**"]), null, "we carry no matcher, so this is UNKNOWN and never a silent 'enabled'");
	assert.equal(isEnabledByPatterns(candidate, ["!extensions/**", "-extensions/my-tool/index.js"]), false, "an exact '-' is determinate even beside a glob");
	assert.equal(isEnabledByPatterns(candidate, ["!extensions/**", "+extensions/my-tool/index.js"]), true, "so is an exact '+'");
	assert.equal(isEnabledByPatterns(candidate, ["!other/**"]), null, "a glob we cannot evaluate is unknown even when it looks unrelated");
});

// --- hostExtensionState ------------------------------------------------------------------------------

/** The subset of the fs bag host-pi reads through. readHostPi builds this same shape by default. */
const fsBag = { existsSync, readFileSync, readdirSync, statSync };

function withExtensions(names) {
	const dir = agentDir();
	for (const [name, files] of Object.entries(names)) {
		const target = join(dir, "extensions", name);
		mkdirSync(target, { recursive: true });
		for (const [file, body] of Object.entries(files)) writeFileSync(join(target, file), body);
	}
	return dir;
}

test("hostExtensionState names the extensions pi has turned off, and leaves the rest alone", () => {
	const dir = withExtensions({ live: { "index.js": "" }, retired: { "index.js": "" } });
	const state = hostExtensionState({ fs: fsBag, agentDir: dir, patterns: ["-extensions/retired/index.js"] });
	assert.deepEqual([...state.disabled], ["retired"]);
	assert.deepEqual(state.unevaluated, []);
});

test("hostExtensionState resolves the entry file the way pi does, so pi.extensions[] is honoured", () => {
	const dir = withExtensions({ tool: { "main.js": "", "package.json": JSON.stringify({ pi: { extensions: ["main.js"] } }) } });
	assert.deepEqual(extensionEntryPaths(fsBag, join(dir, "extensions"), "tool"), [join(dir, "extensions", "tool", "main.js")]);
	const state = hostExtensionState({ fs: fsBag, agentDir: dir, patterns: ["-extensions/tool/main.js"] });
	assert.deepEqual([...state.disabled], ["tool"], "the pattern names the ENTRY, not the directory");
});

test("hostExtensionState copies rather than withholds when it cannot evaluate the pattern", () => {
	const dir = withExtensions({ tool: { "index.js": "" } });
	const state = hostExtensionState({ fs: fsBag, agentDir: dir, patterns: ["!extensions/**"] });
	assert.equal(state.disabled.size, 0, "an unknown verdict must never withhold a tool the flows were written against");
	assert.deepEqual(state.unevaluated, ["tool"], "and it is named, so the operator can check it themselves");
});

test("hostExtensionState leaves an entry-less directory alone: pi loads nothing from it either way", () => {
	const dir = withExtensions({ notes: { "README.md": "" } });
	const state = hostExtensionState({ fs: fsBag, agentDir: dir, patterns: ["-extensions/notes/index.js"] });
	assert.equal(state.disabled.size, 0);
	assert.deepEqual(state.unevaluated, []);
});

test("hostExtensionState does nothing at all when pi declares no override patterns", () => {
	const dir = withExtensions({ tool: { "index.js": "" } });
	const state = hostExtensionState({ fs: fsBag, agentDir: dir, patterns: [] });
	assert.equal(state.disabled.size, 0);
});

// --- discoverHostPackages ----------------------------------------------------------------------------

const settingsOf = (packages, extra = {}) => ({ state: "ok", packages, patterns: [], npmCommand: null, ...extra });

test("discoverHostPackages reads the version off the INSTALLED package, never out of the source string", async () => {
	// The source declares a range; the pin must come from disk. This is the whole reason discovery captures
	// rather than inherits (CONST-PI-VERSION-PINNED).
	const dir = hostSetup({ installed: [{ name: "@acme/x", version: "1.4.2", dirs: ["skills"] }] });
	const found = await discoverHostPackages({ agentDir: dir, settings: settingsOf(["npm:@acme/x@^1"]), fs: fsBag, exec: noExec });
	assert.equal(found.length, 1);
	assert.equal(found[0].version, "1.4.2");
	assert.equal(found[0].resolvedVia, "managed");
	assert.equal(found[0].skip, null);
	assert.equal(found[0].dir, "acme__x", "the staged dir is derived the same way a declared entry's is");
});

test("discoverHostPackages accepts a convention dir with no pi key, because pi does", async () => {
	// The issue proposed requiring a `pi` key. pi 0.80.7 falls through to the convention dirs, so requiring
	// it would silently drop a whole legitimate class -- see host-pi.pinned.test.mjs.
	const dir = hostSetup({ installed: [{ name: "conv", version: "1.0.0", dirs: ["skills"] }, { name: "manifested", version: "2.0.0", pi: { extensions: [] } }, { name: "neither", version: "3.0.0" }] });
	const found = await discoverHostPackages({ agentDir: dir, settings: settingsOf(["npm:conv", "npm:manifested", "npm:neither"]), fs: fsBag, exec: noExec });
	assert.equal(found.find((p) => p.name === "conv").skip, null, "a skills/ dir alone makes it a pi package");
	assert.equal(found.find((p) => p.name === "manifested").skip, null);
	assert.match(found.find((p) => p.name === "neither").skip, /contributes no pi resources/, "and one with neither is named, not silently dropped");
});

test("discoverHostPackages names every source it cannot stage instead of ignoring it", async () => {
	const dir = hostSetup({ installed: [] });
	const found = await discoverHostPackages({ agentDir: dir, settings: settingsOf(["git:github.com/acme/thing", "./local/thing", "npm:missing"]), fs: fsBag, exec: execStub({ "root -g": "/nowhere" }).exec });
	assert.match(found.find((p) => p.kind === "git").skip, /git source/);
	assert.match(found.find((p) => p.kind === "local").skip, /local path source/);
	assert.match(found.find((p) => p.name === "missing").skip, /not installed at/);
});

test("discoverHostPackages skips a package pi is not autoloading, and stages one it only partly loads", async () => {
	const dir = hostSetup({ installed: [{ name: "off", version: "1.0.0", dirs: ["skills"] }, { name: "partial", version: "1.0.0", dirs: ["skills"] }] });
	const found = await discoverHostPackages({
		agentDir: dir,
		settings: settingsOf([
			{ source: "npm:off", autoload: false },
			{ source: "npm:partial", autoload: false, skills: ["+skills/keep.md"] },
		]),
		fs: fsBag,
		exec: noExec,
	});
	assert.match(found.find((p) => p.name === "off").skip, /autoload is off/);
	// A `+` means part of it IS live, and staging copies a whole directory, so it stages and the caller warns.
	assert.equal(found.find((p) => p.name === "partial").skip, null);
	assert.equal(found.find((p) => p.name === "partial").forced, true);
});

test("discoverHostPackages refuses a version that is not exact, rather than staging a moving target", async () => {
	const dir = hostSetup({ installed: [{ name: "weird", version: "not-a-version", dirs: ["skills"] }] });
	const found = await discoverHostPackages({ agentDir: dir, settings: settingsOf(["npm:weird"]), fs: fsBag, exec: noExec });
	assert.match(found[0].skip, /is not an exact version \(CONST-PI-VERSION-PINNED\)/);
});

test("discoverHostPackages discovers nothing from malformed settings, and never falls back to a node_modules walk", async () => {
	// A walk would be worst exactly here: pi's tree is hoisted, so it cannot tell an installed package from a
	// transitive dependency, and inferring intent from it while the config is broken is the failure this
	// function exists to avoid.
	const dir = hostSetup({ installed: [{ name: "hoisted-dep", version: "1.0.0", dirs: ["skills"] }] });
	assert.deepEqual(await discoverHostPackages({ agentDir: dir, settings: { state: "malformed", packages: [], patterns: [], npmCommand: null }, fs: fsBag, exec: noExec }), []);
});

// --- the legacy global fallback, and its precedence ---------------------------------------------------

test("discoverHostPackages falls back to the global npm root ONLY when the managed path is absent", async () => {
	const globalRoot = mkdtempSync(join(tmpdir(), "npm-global-"));
	mkdirSync(join(globalRoot, "legacy", "skills"), { recursive: true });
	writeFileSync(join(globalRoot, "legacy", "package.json"), JSON.stringify({ name: "legacy", version: "0.9.0" }));

	const dir = hostSetup({ installed: [{ name: "managed", version: "1.0.0", dirs: ["skills"] }] });
	const { exec, calls } = execStub({ "root -g": globalRoot });
	const found = await discoverHostPackages({ agentDir: dir, settings: settingsOf(["npm:managed", "npm:legacy"]), fs: fsBag, exec });

	assert.equal(found.find((p) => p.name === "managed").resolvedVia, "managed", "honouring a global copy over a managed one would stage a different build than the operator runs");
	assert.equal(found.find((p) => p.name === "legacy").resolvedVia, "legacy-global");
	assert.equal(found.find((p) => p.name === "legacy").version, "0.9.0");
	assert.equal(calls.length, 1, "one lazy probe per run, memoised, not one per package");
});

test("discoverHostPackages asks pnpm the pnpm way when the host configured it", async () => {
	const pnpmRoot = mkdtempSync(join(tmpdir(), "pnpm-global-"));
	mkdirSync(join(pnpmRoot, "skills"), { recursive: true });
	writeFileSync(join(pnpmRoot, "package.json"), JSON.stringify({ name: "viapnpm", version: "2.0.0" }));

	const dir = hostSetup({ installed: [] });
	const { exec, calls } = execStub({ "list -g --depth 0 --json": JSON.stringify([{ dependencies: { viapnpm: { path: pnpmRoot } } }]) });
	const found = await discoverHostPackages({ agentDir: dir, settings: settingsOf(["npm:viapnpm"], { npmCommand: ["pnpm"] }), fs: fsBag, exec });

	assert.equal(found[0].resolvedVia, "pnpm-global");
	assert.equal(found[0].version, "2.0.0");
	assert.equal(calls[0].file, "pnpm");
});

test("discoverHostPackages degrades to a named reason when the probe fails, never a crash", async () => {
	const dir = hostSetup({ installed: [] });
	const exec = async () => {
		throw new Error("spawn pnpm ENOENT");
	};
	const found = await discoverHostPackages({ agentDir: dir, settings: settingsOf(["npm:missing"], { npmCommand: ["pnpm"] }), fs: fsBag, exec });
	assert.match(found[0].skip, /could not ask pnpm for its global root/, "a feature that reads the operator's setup must not break their import");
});

// --- readHostPi: the one call each command site makes -------------------------------------------------

test("readHostPi reports an absent settings file as absent, discovering nothing and refusing nothing", async () => {
	const dir = agentDir();
	const got = await readHostPi({ agentDir: dir, exec: noExec, withPackages: true });
	assert.equal(got.settingsState, "absent");
	assert.deepEqual(got.packages, []);
	assert.equal(got.extensions.disabled.size, 0);
});

test("readHostPi does NOT discover packages unless the caller asked for them", async () => {
	// This is what keeps a flagless `import-pi` free of any packages output at all, by construction rather
	// than by a filter downstream.
	const dir = hostSetup({ settings: { packages: ["npm:@acme/x"] }, installed: [{ name: "@acme/x", version: "1.0.0", dirs: ["skills"] }] });
	assert.deepEqual((await readHostPi({ agentDir: dir, exec: noExec, withPackages: false })).packages, []);
	assert.equal((await readHostPi({ agentDir: dir, exec: noExec, withPackages: true })).packages.length, 1);
});

test("readHostPi still applies extension state when settings.json is unreadable JSON", async () => {
	const dir = hostSetup({ settings: "{ not json" });
	const got = await readHostPi({ agentDir: dir, exec: noExec, withPackages: true });
	assert.equal(got.settingsState, "malformed");
	assert.deepEqual(got.packages, [], "nothing is inferred from a broken config");
	assert.equal(got.extensions.disabled.size, 0, "and nothing is withheld either");
});
