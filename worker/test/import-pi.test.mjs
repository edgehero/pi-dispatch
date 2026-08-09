import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImportPi, findLiteralSecret } from "../src/import-pi.mjs";

function capture() {
	const buf = [];
	return { out: (s) => buf.push(s), text: () => buf.join("") };
}

/**
 * A host ~/.pi/agent fixture with the full surface: safe + secret-bearing + extensions.
 *
 * `settings` writes pi's own settings.json (a string writes it verbatim, for the malformed cases) and
 * `installed` materialises `npm/node_modules/<name>` the way `pi install` would, so discovery has something
 * real to find (issue #102).
 */
function hostAgent({ models, withAuth = true, withExtensions = false, settings, installed = [] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-"));
	if (settings !== undefined) writeFileSync(join(dir, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
	for (const pkg of installed) {
		const target = join(dir, "npm", "node_modules", pkg.name);
		mkdirSync(target, { recursive: true });
		// `resourceDir: null` means it ships NO pi convention dir, which is how a non-pi package looks.
		if (pkg.resourceDir !== null) mkdirSync(join(target, pkg.resourceDir ?? "skills"), { recursive: true });
		writeFileSync(join(target, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version }));
	}
	if (models !== null) writeFileSync(join(dir, "models.json"), models ?? JSON.stringify({ providers: { anthropic: { name: "Anthropic" } } }));
	mkdirSync(join(dir, "skills", "tidy"), { recursive: true });
	writeFileSync(join(dir, "skills", "tidy", "SKILL.md"), "---\nname: tidy\n---\nTidy up.\n");
	writeFileSync(join(dir, "APPEND_SYSTEM.md"), "Be terse.\n");
	if (withAuth) writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-secret" } }));
	if (withExtensions) {
		mkdirSync(join(dir, "extensions", "my-tool"), { recursive: true });
		writeFileSync(join(dir, "extensions", "my-tool", "index.mjs"), "export default () => {};\n");
		mkdirSync(join(dir, "extensions", "pi-dispatch-admin"), { recursive: true });
		writeFileSync(join(dir, "extensions", "pi-dispatch-admin", "index.mjs"), "export default () => {};\n");
	}
	return dir;
}
const overlayDir = () => mkdtempSync(join(tmpdir(), "pi-overlay-"));
const run = (from, to, extra = [], out, deps = {}) => runImportPi(["--from", from, "--to", to, ...extra], { out, ...deps });

test("import-pi copies models/skills/persona and NEVER auth.json", async () => {
	const from = hostAgent();
	const to = overlayDir();
	const { out } = capture();

	const code = await run(from, to, [], out);

	assert.equal(code, 0);
	assert.ok(existsSync(join(to, "models.json")), "models.json copied");
	assert.ok(existsSync(join(to, "skills", "tidy", "SKILL.md")), "skill copied");
	assert.ok(existsSync(join(to, "APPEND_SYSTEM.md")), "persona copied");
	assert.equal(existsSync(join(to, "auth.json")), false, "auth.json must NEVER be copied — the credential stays in env");
});

test("a symlinked skill directory is NOT staged (it was, BY CONTENT, before the shared copier)", async () => {
	// The guard here used to be `statSync(p).isSymbolicLink?.()`, and statSync FOLLOWS links, so it was
	// permanently false: the link's TARGET was walked and its contents copied into an overlay that is
	// :ro-mounted into every adversarial-input container. This is the regression test for that.
	const from = hostAgent();
	const secretDir = mkdtempSync(join(tmpdir(), "pi-host-secret-"));
	writeFileSync(join(secretDir, "SKILL.md"), "HOST-TREE-SENTINEL");
	symlinkSync(secretDir, join(from, "skills", "aliased"));
	const to = overlayDir();
	const { out, text } = capture();

	const code = await run(from, to, [], out);

	assert.equal(code, 0);
	assert.ok(existsSync(join(to, "skills", "tidy", "SKILL.md")), "the real skill must still stage");
	assert.ok(!existsSync(join(to, "skills", "aliased")), "a symlinked skill dir was staged");
	assert.ok(!readdirSync(to, { recursive: true }).some((r) => {
		const p = join(to, r);
		return statSync(p).isFile() && readFileSync(p, "utf8").includes("HOST-TREE-SENTINEL");
	}), "the symlink target's CONTENTS were staged");
	assert.ok(text().includes("symlink"), "the operator must be told what was skipped");
});

test("import-pi refuses a models.json with a literal key and writes nothing", async () => {
	const from = hostAgent({ models: JSON.stringify({ providers: { custom: { name: "Custom", apiKey: "sk-live-literal" } } }) });
	const to = join(mkdtempSync(join(tmpdir(), "pi-overlay-")), "out"); // does not exist yet
	const { out, text } = capture();

	const code = await run(from, to, [], out);

	assert.equal(code, 1);
	assert.match(text(), /literal secret at providers\.custom\.apiKey/);
	assert.equal(existsSync(join(to, "models.json")), false, "a refused import writes no overlay at all");
});

test("import-pi copies extensions BY DEFAULT, with no flag at all", async () => {
	const from = hostAgent({ withExtensions: true });
	const to = overlayDir();
	const { out, text } = capture();

	const code = await run(from, to, [], out);

	assert.equal(code, 0);
	assert.ok(existsSync(join(to, "extensions", "my-tool")), "the operator's own extension is staged without asking");
	assert.match(text(), /1 extension -- these LOAD in every job; VET THESE/, "the count row states the new posture");
	assert.match(text(), /PI_GLOBAL_ALLOW_EXTENSIONS=0/, "the next steps name the off switch, not an arming switch");
});

test("import-pi PRINTS the list of extensions it staged, not just a count", async () => {
	// The one moment an operator can read what is about to run inside every job container. A bare count
	// leaves them re-deriving the list from a directory the worker host never shows them.
	const from = hostAgent({ withExtensions: true });
	mkdirSync(join(from, "extensions", "second-tool"), { recursive: true });
	writeFileSync(join(from, "extensions", "second-tool", "index.mjs"), "export default () => {};\n");
	const { out, text } = capture();

	await run(from, overlayDir(), [], out);

	assert.match(text(), /2 extensions -- these LOAD in every job; VET THESE/);
	assert.match(text(), /^\s+- my-tool$/m, "each staged extension is listed by name");
	assert.match(text(), /^\s+- second-tool$/m);
	assert.doesNotMatch(text(), /- pi-dispatch-admin/, "the blocked one is never listed as staged");
});

test("import-pi still hard-blocks the admin extension, default-on or not (recursion vector)", async () => {
	const from = hostAgent({ withExtensions: true });
	const to = overlayDir();
	const { out, text } = capture();

	await run(from, to, [], out);

	assert.equal(existsSync(join(to, "extensions", "pi-dispatch-admin")), false, "it can enqueue paid jobs -- never into a job container");
	assert.match(text(), /blocked extension "pi-dispatch-admin"/);
	assert.match(text(), /1 extension --/, "and it is not counted among the staged");
});

test("--no-extensions is the escape hatch, and --with-extensions still parses as a no-op", async () => {
	const from = hostAgent({ withExtensions: true });

	const noExt = overlayDir();
	const { out, text } = capture();
	await run(from, noExt, ["--no-extensions"], out);
	assert.equal(existsSync(join(noExt, "extensions")), false, "--no-extensions copies nothing from extensions/");
	assert.match(text(), /skipped -- --no-extensions was passed/);

	// An existing setup script that still passes the old flag keeps working and keeps meaning the same thing.
	const legacy = overlayDir();
	await run(from, legacy, ["--with-extensions"], () => {});
	assert.ok(existsSync(join(legacy, "extensions", "my-tool")), "the legacy flag is redundant, never an error");
});

test("import-pi errors clearly when the source agent dir is absent", async () => {
	const { out, text } = capture();
	const code = await run(join(tmpdir(), "nope-does-not-exist-xyz"), overlayDir(), [], out);
	assert.equal(code, 1);
	assert.match(text(), /no pi setup found/);
});

// --- packages staging (issue #58) -------------------------------------------------------------------
//
// npm is INJECTED: the stub records the argv it was handed and materializes the fixture npm would have
// produced, so the assertions are about the contract (self-contained dir, exact version, containment)
// rather than about the network.

const PKG = "@quintinshaw/pi-dynamic-workflows";
const PKG_DIR = "quintinshaw__pi-dynamic-workflows";

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** Write a `pi-packages.json` somewhere and return its path. */
function packagesFile(packages) {
	const path = join(mkdtempSync(join(tmpdir(), "pi-pkgs-")), "pi-packages.json");
	writeJson(path, { packages });
	return path;
}

/** The default fixture: a real-shaped pi package -- a `pi` manifest plus its one dependency, nested inside. */
function goodPackage(pkgDir, name, version, overrides = {}) {
	const dep = join(pkgDir, "node_modules", "left-pad");
	mkdirSync(dep, { recursive: true });
	writeJson(join(dep, "package.json"), { name: "left-pad", version: "1.0.0" });
	writeJson(join(pkgDir, "package.json"), { name, version, dependencies: { "left-pad": "^1.0.0" }, pi: { extensions: ["./dist/index.js"] }, ...overrides });
}

/**
 * An injected npm. Records every call; `materialize` builds `<cwd>/node_modules/<name>` in its place --
 * `options.cwd` IS the install target, exactly as real npm treats it now that `--prefix` is gone from argv.
 */
function npmStub(materialize = goodPackage) {
	const calls = [];
	const exec = async (file, args, options) => {
		calls.push({ file, args, options });
		const prefix = options.cwd;
		const spec = args[1];
		const at = spec.lastIndexOf("@");
		const [name, version] = [spec.slice(0, at), spec.slice(at + 1)];
		const pkgDir = join(prefix, "node_modules", name);
		mkdirSync(pkgDir, { recursive: true });
		materialize(pkgDir, name, version);
		return { stdout: "", stderr: "" };
	};
	return { exec, calls };
}

const readManifest = (to) => JSON.parse(readFileSync(join(to, "packages", "packages.json"), "utf8"));

test("--with-packages stages a pinned package into packages/<dir> and writes the stage manifest", async () => {
	const from = hostAgent();
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }, { name: "pi-widgets", version: "1.4.2", dir: "widgets" }]);
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(from, to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 0);
	assert.ok(existsSync(join(to, "packages", PKG_DIR, "package.json")), "a scoped name stages as scope__name");
	assert.ok(existsSync(join(to, "packages", PKG_DIR, "node_modules", "left-pad")), "the staged dir is SELF-CONTAINED");
	assert.ok(existsSync(join(to, "packages", "widgets", "package.json")), "an explicit dir wins over the derived one");
	assert.equal(existsSync(join(to, "packages", ".staging-0")), false, "the staging dir is cleaned up");

	const manifest = readManifest(to);
	assert.deepEqual(manifest.packages, [
		{ name: PKG, version: "0.1.0", dir: PKG_DIR, from: "pi-packages" },
		{ name: "pi-widgets", version: "1.4.2", dir: "widgets", from: "pi-packages" },
	]);
	assert.match(manifest.stagedAt, /^\d{4}-\d{2}-\d{2}T/);
	assert.match(text(), /packages\/.*2 packages -- third-party code, VET THESE/);
	assert.match(text(), /Staged packages load in every job -- set `run\.packages: false`/, "next steps name the opt-out, since staging is what loads them");
	assert.equal(calls.length, 2, "one npm install per package");
});

/** The load-bearing flags, asserted from every argv the stager builds regardless of platform. */
const NPM_FLAGS = ["--ignore-scripts", "--omit=dev", "--omit=peer", "--omit=optional", "--install-strategy=nested", "--no-audit", "--no-fund"];

/**
 * The property `shell: true` on win32 rests on: argv is literal flags plus ONE validated `name@version`
 * token, and carries no filesystem path at all (the install target travels as `options.cwd`, never as
 * `--prefix <staging>`). Re-introducing a path here would break the safety argument in import-pi.mjs.
 */
function assertArgvHasNoPath(args, staging) {
	assert.equal(args.includes("--prefix"), false, "--prefix is gone -- the install target is options.cwd");
	assert.equal(args.some((a) => a.includes(staging)), false, "the staging path must never appear in argv");
	assert.equal(
		args.some((a) => a.startsWith("/") || a.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(a)),
		false,
		"no absolute path may reach argv -- that is what makes shell:true safe on win32",
	);
	for (const flag of NPM_FLAGS) assert.ok(args.includes(flag), `argv must include ${flag}`);
}

test("the npm invocation is an ARRAY argv with the load-bearing flags, and never a shell string", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec, calls } = npmStub();

	await run(hostAgent(), to, ["--with-packages", "--packages-file", file], () => {}, { exec, platform: "linux" });

	const [{ file: bin, args, options }] = calls;
	assert.equal(bin, "npm");
	assert.ok(Array.isArray(args), "argv is an ARRAY");
	assert.equal(args[0], "install");
	assert.equal(args[1], `${PKG}@0.1.0`, "name and version travel as ONE argv element, never concatenated into a command");
	assertArgvHasNoPath(args, options.cwd);
	// NEGATIVE: nothing here may be a shell string -- a package name from a config file must never be able
	// to become shell syntax on the operator's host.
	assert.equal(args.some((a) => /[;&|`$><]/.test(a)), false, "no shell metacharacter reaches the runner");
	assert.equal(args.some((a) => a.includes("npm ") || a.trim().includes(" install ")), false, "the command is never one packed string");
	assert.equal(options.shell ?? false, false, "off win32 there is no shell at all");
});

test("on win32 npm.cmd is spawned WITH shell:true -- without it Node throws EINVAL and --with-packages is dead", async () => {
	// Since Node 18.20.2/20.12.2 (CVE-2024-27980) a .cmd cannot be spawned without a shell, and this package
	// floors at Node >=22.19 -- so the win32 branch only works if BOTH halves are present together.
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec, calls } = npmStub();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], () => {}, { exec, platform: "win32" });

	assert.equal(code, 0, "the win32 path must stage successfully, not fail on spawn");
	const [{ file: bin, args, options }] = calls;
	assert.equal(bin, "npm.cmd", "npm ships as npm.cmd on Windows");
	assert.equal(options.shell, true, "npm.cmd needs shell:true or Node throws EINVAL before npm ever runs");
	// And the reason that is safe: no path in argv, both remaining tokens regex-validated.
	assert.equal(args[1], `${PKG}@0.1.0`);
	assertArgvHasNoPath(args, options.cwd);
	assert.equal(args.some((a) => /[\s;&|`$><^%"()]/.test(a)), false, "no cmd metacharacter or space can survive into the command line");
});

test("off win32 npm is spawned as a plain binary with NO shell", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec, calls } = npmStub();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], () => {}, { exec, platform: "linux" });

	assert.equal(code, 0);
	const [{ file: bin, args, options }] = calls;
	assert.equal(bin, "npm");
	assert.equal(options.shell ?? false, false, "a POSIX host must never get a shell -- there is no EINVAL to work around");
	assertArgvHasNoPath(args, options.cwd);
});

test("the staged tree still lands under options.cwd, so the assertions and the rename still hold", async () => {
	// The one behavioural risk of dropping --prefix: npm installs into the cwd's node_modules, which is where
	// the dependency-completeness check and the renameSync of <staging>/node_modules/<name> both look.
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec, calls } = npmStub();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], () => {}, { exec, platform: "win32" });

	assert.equal(code, 0);
	assert.match(calls[0].options.cwd, /\.staging-0$/, "the cwd IS the private staging dir npm must install into");
	assert.ok(existsSync(join(to, "packages", PKG_DIR, "package.json")), "the package was renamed out of <cwd>/node_modules/<name>");
	assert.ok(existsSync(join(to, "packages", PKG_DIR, "node_modules", "left-pad")), "and its nested dependency came with it");
});

test("--with-packages refuses the admin package outright and stages NOTHING", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: "@edgehero/pi-dispatch-admin", version: "1.0.0" }]);
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 1);
	assert.match(text(), /admin/);
	assert.equal(existsSync(join(to, "packages")), false, "no packages dir is created at all");
	assert.equal(calls.length, 0, "npm is never invoked for a refused file");
});

test("--with-packages refuses a RANGE version and stages nothing", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "^0.1.0" }]);
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 1);
	assert.match(text(), /EXACT version/);
	assert.equal(existsSync(join(to, "packages")), false);
	assert.equal(calls.length, 0);
});

test("--with-packages refuses a package npm staged at the wrong version", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec } = npmStub((pkgDir, name) => goodPackage(pkgDir, name, "0.2.0"));
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 1);
	assert.match(text(), /"0\.2\.0".*"0\.1\.0"/);
	assert.equal(existsSync(join(to, "packages", PKG_DIR)), false);
});

test("--with-packages refuses a package whose dependency was hoisted out of the package dir", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	// npm hoisted left-pad to the staging root: the staged dir could not import it with no network.
	const { exec } = npmStub((pkgDir, name, version) => {
		writeJson(join(pkgDir, "package.json"), { name, version, dependencies: { "left-pad": "^1.0.0" }, pi: { extensions: ["./index.js"] } });
	});
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 1);
	assert.match(text(), /left-pad/);
	assert.equal(existsSync(join(to, "packages", PKG_DIR)), false, "a half-staged set is never left behind");
});

test("--with-packages refuses a package that contributes no pi resources (it would be a silent no-op)", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: "pi-widgets", version: "1.0.0" }]);
	const { exec } = npmStub((pkgDir, name, version) => writeJson(join(pkgDir, "package.json"), { name, version }));
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 1);
	assert.match(text(), /is not a pi package/);
	assert.equal(existsSync(join(to, "packages")), false);
});

test("a package with no pi manifest but a convention dir (skills/) is staged", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: "pi-widgets", version: "1.0.0" }]);
	const { exec } = npmStub((pkgDir, name, version) => {
		mkdirSync(join(pkgDir, "skills", "tidy"), { recursive: true });
		writeFileSync(join(pkgDir, "skills", "tidy", "SKILL.md"), "---\nname: tidy\n---\n");
		writeJson(join(pkgDir, "package.json"), { name, version });
	});

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], () => {}, { exec });

	assert.equal(code, 0);
	assert.ok(existsSync(join(to, "packages", "pi-widgets", "skills", "tidy", "SKILL.md")));
});

test('--with-packages refuses a pi manifest entry containing ".."', async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec } = npmStub((pkgDir, name, version) => goodPackage(pkgDir, name, version, { pi: { extensions: ["../../../etc/passwd"] } }));
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 1);
	assert.match(text(), /leaves the package dir/);
	assert.equal(existsSync(join(to, "packages", PKG_DIR)), false);
});

test("a package declaring a postinstall script is staged WITH a warn row (--ignore-scripts left it incomplete)", async () => {
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec } = npmStub((pkgDir, name, version) => goodPackage(pkgDir, name, version, { scripts: { postinstall: "node build.js" }, optionalDependencies: { fsevents: "^2" } }));
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--packages-file", file], out, { exec });

	assert.equal(code, 0, "a warning is not a refusal");
	assert.ok(existsSync(join(to, "packages", PKG_DIR, "package.json")), "it is still staged");
	assert.match(text(), /WARN:.*scripts\.postinstall, optionalDependencies.*INCOMPLETE/);
	assert.deepEqual(readManifest(to).packages.length, 1);
});

// The refusal is scoped to the declared-only mode now (issue #102): with discovery on, a missing file just
// means "nothing declared" because settings.packages is the other source. `--no-host-packages` is the mode
// in which the file IS the only source, so it is the mode in which its absence is still fatal.
test("--with-packages --no-host-packages fails loud when the packages file is missing", async () => {
	const to = overlayDir();
	const { out, text } = capture();

	const code = await run(hostAgent(), to, ["--with-packages", "--no-host-packages", "--packages-file", join(tmpdir(), "nope-pi-packages.json")], out, { exec: npmStub().exec });

	assert.equal(code, 1);
	assert.match(text(), /needs a packages file/);
	assert.equal(existsSync(join(to, "packages")), false);
});

test("without --with-packages nothing is staged and the rest of the import is unchanged", async () => {
	const from = hostAgent();
	const to = overlayDir();
	const file = packagesFile([{ name: PKG, version: "0.1.0" }]);
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(from, to, ["--packages-file", file], out, { exec });

	assert.equal(code, 0);
	assert.equal(existsSync(join(to, "packages")), false, "no packages dir without the flag");
	assert.equal(calls.length, 0, "npm is never invoked without the flag");
	assert.ok(existsSync(join(to, "models.json")) && existsSync(join(to, "skills", "tidy", "SKILL.md")), "the existing import still happens");
	assert.equal(/packages\//.test(text()), false, "and the table gains no packages row");
});

test("re-running without the flag keeps an existing packages/ and reports it dormant", async () => {
	const from = hostAgent();
	const to = overlayDir();
	const { exec } = npmStub();
	await run(from, to, ["--with-packages", "--packages-file", packagesFile([{ name: PKG, version: "0.1.0" }])], () => {}, { exec });

	const { out, text } = capture();
	const code = await run(from, to, [], out);

	assert.equal(code, 0);
	assert.match(text(), /packages\/\s+kept -- re-run with --with-packages to refresh/);
	assert.ok(existsSync(join(to, "packages", PKG_DIR, "package.json")), "the staged packages survive a plain re-run");
	assert.deepEqual(readManifest(to).packages.length, 1, "and so does the stage manifest");
});

test("findLiteralSecret: catches literal apiKey and auth headers, passes env/command indirections", () => {
	assert.equal(findLiteralSecret({ providers: { p: { apiKey: "sk-literal" } } }), "providers.p.apiKey");
	assert.equal(findLiteralSecret({ providers: { p: { apiKey: "$MY_KEY" } } }), null, "$ENV reference is not a literal");
	assert.equal(findLiteralSecret({ providers: { p: { apiKey: "!op read x" } } }), null, "!command is not a literal");
	assert.equal(findLiteralSecret({ providers: { p: { headers: { Authorization: "Bearer sk-x" } } } }), "providers.p.headers.Authorization");
	assert.equal(findLiteralSecret({ providers: { p: { headers: { "Content-Type": "application/json" } } } }), null, "a non-secret header is fine");
	assert.equal(findLiteralSecret({ providers: {} }), null);
});

// --- discovery from the operator's own pi setup (issue #102) -------------------------------------------
//
// The gap this closes: a package installed with `pi install` never reached a job, and re-running import-pi
// did not change that. The rule these tests pin is that discovery adds CANDIDATES, never exemptions --
// every gate the declared path runs still runs on a discovered entry.

const HOST_PKG = "@acme/pi-house-skills";

test("--with-packages stages what pi has installed, at the host's EXACT version, named with its provenance", async () => {
	const from = hostAgent({ settings: { packages: [`npm:${HOST_PKG}@^1`] }, installed: [{ name: HOST_PKG, version: "1.4.2" }] });
	const to = overlayDir();
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(from, to, ["--with-packages", "--packages-file", packagesFile([])], out, { exec });

	assert.equal(code, 0);
	// The source declared a RANGE and the pin came off disk. Capturing rather than inheriting is what keeps
	// CONST-PI-VERSION-PINNED true through the discovery path.
	assert.equal(calls.length, 1);
	assert.equal(calls[0].args[1], `${HOST_PKG}@1.4.2`);
	// The discovery path is a SECOND producer of this argv, so the win32 shell:true safety argument now
	// rests on it too.
	assertArgvHasNoPath(calls[0].args, calls[0].options.cwd);

	assert.deepEqual(readManifest(to).packages, [{ name: HOST_PKG, version: "1.4.2", dir: "acme__pi-house-skills", from: "host" }]);
	assert.match(text(), /^\s+- @acme\/pi-house-skills@1\.4\.2 \(from your pi setup\)$/m, "provenance rides on the name row, so the vetting list says where each came from");
	assert.match(text(), /re-run with --no-host-packages/, "and the run whose meaning changed names how to get the old one back");
});

test("an explicit pi-packages.json entry WINS over the discovered one, and the override is printed", async () => {
	// The reason pi-packages.json survives as a layer: pinning OLDER than the host runs is a legitimate act.
	const from = hostAgent({ settings: { packages: [`npm:${HOST_PKG}`] }, installed: [{ name: HOST_PKG, version: "2.3.0" }] });
	const to = overlayDir();
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(from, to, ["--with-packages", "--packages-file", packagesFile([{ name: HOST_PKG, version: "2.0.1" }])], out, { exec });

	assert.equal(code, 0);
	assert.equal(calls.length, 1, "the two are ONE package, not two");
	assert.equal(calls[0].args[1], `${HOST_PKG}@2.0.1`, "the declared version is the one staged");
	assert.equal(readManifest(to).packages[0].from, "pi-packages");
	assert.match(text(), /overrides your pi setup's 2\.3\.0/, "the shadowed host version is stated, since nothing else would ever say so");
});

test("--no-host-packages stages only what pi-packages.json declares, byte for byte as before", async () => {
	const from = hostAgent({ settings: { packages: [`npm:${HOST_PKG}`] }, installed: [{ name: HOST_PKG, version: "1.4.2" }] });
	const to = overlayDir();
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(from, to, ["--with-packages", "--no-host-packages", "--packages-file", packagesFile([{ name: PKG, version: "0.1.0" }])], out, { exec });

	assert.equal(code, 0);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].args[1], `${PKG}@0.1.0`);
	assert.equal(readManifest(to).packages.length, 1);
	assert.equal(/from your pi setup/.test(text()), false, "the escape hatch restores the old behaviour, output included");
});

test("a git-sourced host package is skipped with a NAMED reason and never reaches npm", async () => {
	const from = hostAgent({ settings: { packages: ["git:github.com/acme/pi-thing"] } });
	const to = overlayDir();
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(from, to, ["--with-packages", "--packages-file", packagesFile([])], out, { exec });

	assert.equal(code, 0);
	assert.equal(calls.length, 0, "pi-packages.json pins an npm name plus an exact semver, and a ref is neither");
	assert.match(text(), /host packages\s+1 skipped -- not staged/);
	assert.match(text(), /git:github\.com\/acme\/pi-thing \(git source/, "silence here is how an operator concludes auto-import is broken");
});

test("a host package that contributes no pi resources is named, not staged, and never reaches npm", async () => {
	const from = hostAgent({ settings: { packages: ["npm:not-a-pi-package"] }, installed: [{ name: "not-a-pi-package", version: "1.0.0", resourceDir: null }] });
	const to = overlayDir();
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(from, to, ["--with-packages", "--packages-file", packagesFile([])], out, { exec });

	assert.equal(code, 0);
	assert.equal(calls.length, 0);
	assert.match(text(), /not-a-pi-package \(contributes no pi resources/);
});

test("a host package pi is not autoloading is skipped; one it partly loads stages WHOLE, with a warning", async () => {
	// Staging copies a directory, so "the package minus one skill" is not expressible. Say that rather than
	// pretend the host's filter travelled with it.
	const from = hostAgent({
		settings: { packages: [{ source: "npm:off-pkg", autoload: false }, { source: "npm:partial-pkg", autoload: false, skills: ["+skills/keep.md"] }] },
		installed: [{ name: "off-pkg", version: "1.0.0" }, { name: "partial-pkg", version: "1.0.0" }],
	});
	const to = overlayDir();
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(from, to, ["--with-packages", "--packages-file", packagesFile([])], out, { exec });

	assert.equal(code, 0);
	assert.equal(calls.length, 1, "only the partly-loaded one stages");
	assert.match(text(), /off-pkg \(autoload is off in your pi settings\)/);
	assert.match(text(), /your pi settings load only part of partial-pkg; the overlay stages ALL of it/);
});

test("a DISCOVERED admin package is dropped with a reason and the rest of the stage still lands", async () => {
	// Contrast with the declared case above, which refuses everything: an operator running the panel has the
	// admin installed, and zeroing their whole overlay refresh over it would be the wrong trade. The block
	// itself still holds -- it reaches discovery because discovery reuses the declared entry's validator.
	const from = hostAgent({ settings: { packages: ["npm:pi-dispatch-admin", `npm:${HOST_PKG}`] }, installed: [{ name: "pi-dispatch-admin", version: "0.5.0" }, { name: HOST_PKG, version: "1.4.2" }] });
	const to = overlayDir();
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(from, to, ["--with-packages", "--packages-file", packagesFile([])], out, { exec });

	assert.equal(code, 0, "a discovery-side refusal is not the operator's config error and must not block their stage");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].args[1], `${HOST_PKG}@1.4.2`);
	assert.match(text(), /pi-dispatch-admin.*recursion vector/s);
	assert.deepEqual(readManifest(to).packages.map((p) => p.name), [HOST_PKG]);
});

test("--with-packages with NO packages file stages the host's packages instead of refusing", async () => {
	const from = hostAgent({ settings: { packages: [`npm:${HOST_PKG}`] }, installed: [{ name: HOST_PKG, version: "1.4.2" }] });
	const to = overlayDir();
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(from, to, ["--with-packages", "--packages-file", join(tmpdir(), "nope-pi-packages.json")], out, { exec });

	assert.equal(code, 0, "with a second source of entries, a missing file just means nothing was declared");
	assert.equal(calls.length, 1);
	assert.equal(/needs a packages file/.test(text()), false);
});

test("an unreadable settings.json says so and still stages what pi-packages.json declares", async () => {
	// Exit 0 deliberately: one bad file on the host must not block the models/skills/persona half of the
	// import, none of which depends on it.
	const from = hostAgent({ settings: "{ this is not json" });
	const to = overlayDir();
	const { exec, calls } = npmStub();
	const { out, text } = capture();

	const code = await run(from, to, ["--with-packages", "--packages-file", packagesFile([{ name: PKG, version: "0.1.0" }])], out, { exec });

	assert.equal(code, 0);
	assert.equal(calls.length, 1, "the declared entry is unaffected");
	assert.match(text(), /settings\.json\s+UNREADABLE/);
});

// --- the extensions half: an extension disabled in pi used to load in every job ------------------------

/** A host agent whose extensions/ children carry pi's own entry convention (index.js, not .mjs). */
function hostAgentWithEntries(names, settings) {
	const dir = hostAgent({ settings });
	for (const name of names) {
		mkdirSync(join(dir, "extensions", name), { recursive: true });
		writeFileSync(join(dir, "extensions", name, "index.js"), "export default () => {};\n");
	}
	return dir;
}

test("an extension disabled in pi is NOT copied, and is reported by omission plus its own row", async () => {
	const from = hostAgentWithEntries(["live", "retired"], { extensions: ["-extensions/retired/index.js"] });
	const to = overlayDir();
	const { out, text } = capture();

	const code = await run(from, to, [], out);

	assert.equal(code, 0);
	assert.ok(existsSync(join(to, "extensions", "live")), "the live one still travels");
	assert.equal(existsSync(join(to, "extensions", "retired")), false, "until #102 this ran in every job container");
	assert.match(text(), /extensions\/\s+1 extension -- these LOAD in every job; VET THESE/, "the count is what is LIVE");
	assert.match(text(), /^\s+- live$/m);
	assert.match(text(), /extensions \(off\)\s+1 disabled in your pi settings, not copied/);
	assert.match(text(), /^\s+- retired$/m);
});

test("a glob pattern copies everything and SAYS it could not honour it, rather than guessing", async () => {
	const from = hostAgentWithEntries(["tool"], { extensions: ["!extensions/**"] });
	const to = overlayDir();
	const { out, text } = capture();

	const code = await run(from, to, [], out);

	assert.equal(code, 0);
	assert.ok(existsSync(join(to, "extensions", "tool")), "fail OPEN: never withhold a tool the flows were written against on a guess");
	assert.match(text(), /cannot evaluate[\s\S]*tool/, "and say which, so the operator can check it themselves");
});

// --- argv hygiene, which the new flag makes load-bearing ----------------------------------------------

test("an unknown flag is REFUSED, because a typo must not be able to widen what loads", async () => {
	const { out, text } = capture();
	// Before discovery a typo was harmless. Now `--no-host-package` (singular) would silently mean
	// "third-party code you did not expect runs in every job container".
	const code = await run(hostAgent(), overlayDir(), ["--with-packages", "--no-host-package"], out, { exec: npmStub().exec });

	assert.equal(code, 1);
	assert.match(text(), /unknown flag "--no-host-package"/);
	assert.match(text(), /--no-host-packages/, "the error names the accepted spelling");
});

test("--host-packages is accepted as a no-op, the way --with-extensions is", async () => {
	const from = hostAgent({ settings: { packages: [`npm:${HOST_PKG}`] }, installed: [{ name: HOST_PKG, version: "1.4.2" }] });
	const { exec, calls } = npmStub();
	const { out } = capture();

	const code = await run(from, overlayDir(), ["--with-packages", "--host-packages", "--packages-file", packagesFile([])], out, { exec });

	assert.equal(code, 0);
	assert.equal(calls.length, 1);
});
