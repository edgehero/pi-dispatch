import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { addToken } from "../src/console-tokens.mjs";
import { DEPLOYMENT_FILES, cleanedNpxEnv, ownPackageVersions, runSelfInstall, selfInstallArgs } from "../src/console-install.mjs";
import { runInit } from "../src/init.mjs";
import { setupCachePath } from "../src/setup-host-entry.mjs";
import { runConsoleUp, runningFromNpmCache, tightenedUmask } from "../src/console-bootstrap.mjs";

// `npx @edgehero/pi-dispatch up --console` (issue #849). The order is the contract: every refusal that needs nothing installed comes
// before anything touches the folder.

const VERSIONS = { version: "5.1.0", piVersion: "1.5.0" };

function harness({ answer = "y" } = {}) {
	const cwd = fs.realpathSync(tempDir("console-install-"));
	const installs = [], handovers = [], asked = [], lines = [];
	const deps = {
		fs, cwd, home: fs.realpathSync(tempDir("console-install-home-")), platform: "linux", euid: process.getuid(), env: { PATH: "/home/me/.npm/_npx/abc/node_modules/.bin:/usr/bin", npm_config_yes: "true", KEEP: "1" }, tightenUmask: () => {},
		out: (text) => lines.push(text), prompt: async (question) => { asked.push(question); return answer; },
		consoleCommand: async () => ({ code: 0, stdout: "" }), refuse: (text) => { lines.push(`up --console: ${text}\n`); return 2; },
		ownPackage: () => VERSIONS, trustedFile: () => true,
		npmInstall: async (args, options) => {
			installs.push({ args, options, packageJsonFirst: fs.existsSync(join(options.cwd, "package.json")) });
			const pkg = join(options.cwd, "node_modules", "@edgehero", "pi-dispatch");
			fs.mkdirSync(join(pkg, "src"), { recursive: true });
			fs.writeFileSync(join(pkg, "src", "cli.mjs"), "");
			fs.writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@edgehero/pi-dispatch", version: VERSIONS.version }));
			return 0;
		},
		handOver: async (bin, args, options) => { handovers.push({ bin, args, options }); return 0; },
	};
	return { deps, installs, handovers, asked, lines, cwd };
}

const untouched = (cwd) => assert.deepEqual(fs.readdirSync(cwd), [], "the folder stays exactly as it was");

test("one answer installs exact pins and hands over with that answer, so nothing is asked twice", async () => {
	const { deps, installs, handovers, asked, cwd, lines } = harness();
	assert.equal(await runSelfInstall(["--console"], deps), 0);
	assert.equal(asked.length, 1, asked.join(" | "));
	assert.deepEqual(installs.map((row) => row.args), [selfInstallArgs(VERSIONS)]);
	assert.equal(installs[0].packageJsonFirst, true, "npm must find this folder's package.json, or it settles on a project above it");
	for (const options of [installs[0].options, handovers[0]?.options]) assert.deepEqual(options.env, { PATH: "/usr/bin", KEEP: "1" }, "neither the install nor the durable path inherits npx");
	assert.equal(handovers.length, 1);
	assert.deepEqual(handovers[0].args.slice(1), ["up", "--console", "--yes"]);
	assert.match(lines.join(""), /npm install @edgehero\/pi-dispatch-admin@5\.1\.0/, "the command is shown before it runs");
	assert.equal(handovers[0].args[0], join(cwd, "node_modules", "@edgehero", "pi-dispatch", "src", "cli.mjs"));
	assert.equal(JSON.parse(fs.readFileSync(join(cwd, "package.json"), "utf8")).private, true, "npm cannot settle on a project above this folder");
	assert.equal(installs[0].options.cwd, join(cwd, ".pi-dispatch-install"), "built aside, and moved into place only once npm has succeeded");
	assert.equal(fs.existsSync(join(cwd, ".pi-dispatch-install")), false, "and the staging folder is gone");
});

test("the install is exact, scriptless and carries every package the service needs", () => {
	const args = selfInstallArgs(VERSIONS);
	for (const want of ["@edgehero/pi-dispatch@5.1.0", "@edgehero/pi-dispatch-admin@5.1.0", "@earendil-works/pi-coding-agent@1.5.0", "--save-exact", "--ignore-scripts"]) assert.ok(args.includes(want), want);
	assert.equal(args.some((arg) => /[\^~]|latest/.test(arg)), false);
});

test("this package's versions are read from its own package.json and are exact", () => {
	const own = ownPackageVersions();
	assert.match(own.version, /^\d+\.\d+\.\d+/);
	assert.match(own.piVersion, /^\d+\.\d+\.\d+$/);
});

test("a version that is not exact is refused before anything else", async () => {
	for (const ownPackage of [() => ({ version: "latest", piVersion: "1.5.0" }), () => ({ version: "5.1.0", piVersion: "^1.5.0" }), () => { throw new Error("gone"); }]) {
		const { deps, installs, cwd } = harness();
		assert.equal(await runSelfInstall(["--console"], { ...deps, ownPackage }), 2);
		assert.deepEqual(installs, []);
		untouched(cwd);
	}
});

test("every refusal that needs nothing installed leaves the folder as it was", async () => {
	const scenarios = {
		platform: (h) => { h.deps.platform = "win32"; },
		manager: (h) => { h.deps.consoleCommand = async () => ({ code: 1, stdout: "" }); },
		home: (h) => { h.deps.home = h.cwd; },
		"a unit already exists": (h) => {
			const units = join(h.deps.home, ".config", "systemd", "user");
			fs.mkdirSync(units, { recursive: true });
			fs.writeFileSync(join(units, "pi-dispatch-console.service"), "");
		},
	};
	for (const [name, set] of Object.entries(scenarios)) {
		const h = harness();
		set(h);
		assert.equal(await runSelfInstall(["--console"], h.deps), 2, name);
		assert.deepEqual([h.installs, h.handovers, h.asked], [[], [], []], name);
		untouched(h.cwd);
	}
});

test("a folder holding someone's project is refused, and one with pi-dispatch installed names its own binary", async () => {
	const project = harness();
	fs.writeFileSync(join(project.cwd, "main.go"), "");
	assert.equal(await runSelfInstall(["--console"], project.deps), 2);
	assert.deepEqual(project.installs, []);
	assert.match(project.lines.join(""), /already holds other files/);
	const installed = harness();
	fs.mkdirSync(join(installed.cwd, "node_modules", ".bin"), { recursive: true });
	fs.mkdirSync(join(installed.cwd, "node_modules", "@edgehero", "pi-dispatch", "src"), { recursive: true });
	fs.writeFileSync(join(installed.cwd, "node_modules", "@edgehero", "pi-dispatch", "src", "cli.mjs"), "");
	fs.symlinkSync(join("..", "@edgehero", "pi-dispatch", "src", "cli.mjs"), join(installed.cwd, "node_modules", ".bin", "pi-dispatch"));
	assert.equal(await runSelfInstall(["--console"], installed.deps), 2);
	assert.deepEqual(installed.installs, []);
	assert.match(installed.lines.join(""), /\.\/node_modules\/\.bin\/pi-dispatch up --console/);
});

test("housekeeping files, a deployment init wrote, and our own leftovers are accepted", async () => {
	for (const [name, text] of [[".DS_Store", ""], [".git", null], [".env", "VALKEY_PASSWORD=abc\n"], ["triggers.json", "{}"]]) {
		const h = harness();
		if (text === null) fs.mkdirSync(join(h.cwd, name)); else fs.writeFileSync(join(h.cwd, name), text, { mode: 0o600 });
		assert.equal(await runSelfInstall(["--console", "--yes"], h.deps), 0, name);
		assert.equal(h.installs.length, 1, name);
	}
	const retry = harness();
	fs.writeFileSync(join(retry.cwd, "package.json"), JSON.stringify({ name: "pi-dispatch-deployment", private: true }));
	fs.mkdirSync(join(retry.cwd, "node_modules", "planted"), { recursive: true });
	assert.equal(await runSelfInstall(["--console", "--yes"], retry.deps), 0, "a failed install can be retried");
	assert.equal(fs.existsSync(join(retry.cwd, "node_modules", "planted")), false, "and nothing it left stays beside what was installed");
});

test("the install is built aside, so an interrupted one leaves nothing npx could trip over and the same command recovers", async () => {
	const h = harness();
	const install = h.deps.npmInstall;
	h.deps.npmInstall = async (args, options) => {
		fs.mkdirSync(join(options.cwd, "node_modules", "@edgehero", "pi-dispatch"), { recursive: true });
		fs.writeFileSync(join(options.cwd, "node_modules", "@edgehero", "pi-dispatch", "package.json"), "{}");
		return null;
	};
	assert.equal(await runSelfInstall(["--console", "--yes"], h.deps), 2);
	assert.equal(fs.existsSync(join(h.cwd, "node_modules")), false, "no half-installed package where npx would find it");
	h.deps.npmInstall = install;
	assert.equal(await runSelfInstall(["--console", "--yes"], h.deps), 0, "the same command works again, with no cleanup");
	assert.equal(fs.existsSync(join(h.cwd, ".pi-dispatch-install")), false);
	assert.equal(fs.existsSync(join(h.cwd, "node_modules", "@edgehero", "pi-dispatch", "src", "cli.mjs")), true);
});

test("the pins npm recorded end up in the folder", async () => {
	const h = harness();
	const install = h.deps.npmInstall;
	h.deps.npmInstall = async (args, options) => {
		const code = await install(args, options);
		fs.writeFileSync(join(options.cwd, "package.json"), JSON.stringify({ name: "pi-dispatch-deployment", private: true, dependencies: { a: "1.0.0" } }));
		fs.writeFileSync(join(options.cwd, "package-lock.json"), "{}");
		return code;
	};
	assert.equal(await runSelfInstall(["--console", "--yes"], h.deps), 0);
	assert.deepEqual(JSON.parse(fs.readFileSync(join(h.cwd, "package.json"), "utf8")).dependencies, { a: "1.0.0" });
	assert.equal(fs.existsSync(join(h.cwd, "package-lock.json")), true);
});

test("a .bin planted beside our own package.json is a leftover, not an installation to send someone to", async () => {
	const h = harness();
	fs.writeFileSync(join(h.cwd, "package.json"), JSON.stringify({ name: "pi-dispatch-deployment", private: true }));
	fs.mkdirSync(join(h.cwd, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(join(h.cwd, "node_modules", ".bin", "pi-dispatch"), "planted");
	assert.equal(await runSelfInstall(["--console", "--yes"], h.deps), 0);
	assert.equal(h.installs.length, 1);
	assert.equal(fs.existsSync(join(h.cwd, "node_modules", ".bin", "pi-dispatch")), false);
});

test("the leftover is judged again just before it is removed, and removing it is said", async () => {
	const said = harness();
	fs.writeFileSync(join(said.cwd, "package.json"), JSON.stringify({ name: "pi-dispatch-deployment", private: true }));
	fs.mkdirSync(join(said.cwd, "node_modules", "x"), { recursive: true });
	await runSelfInstall(["--console", "--yes"], said.deps);
	assert.match(said.lines.join(""), /removing what an earlier install left/);
	const swapped = harness();
	fs.writeFileSync(join(swapped.cwd, "package.json"), JSON.stringify({ name: "pi-dispatch-deployment", private: true }));
	fs.mkdirSync(join(swapped.cwd, "node_modules", "x"), { recursive: true });
	const install = swapped.deps.npmInstall;
	swapped.deps.npmInstall = async (args, options) => { fs.writeFileSync(join(swapped.cwd, "package.json"), '{"name":"mine"}'); return install(args, options); };
	assert.equal(await runSelfInstall(["--console", "--yes"], swapped.deps), 2);
	assert.equal(fs.existsSync(join(swapped.cwd, "node_modules", "x")), true, "not ours any more, so not removed");
});

test("a file that appeared while npm ran is not replaced by the move into place", async () => {
	for (const [name, text] of [["package.json", '{"name":"mine"}'], ["package-lock.json", "{}"]]) {
		const h = harness();
		const install = h.deps.npmInstall;
		h.deps.npmInstall = async (args, options) => { fs.writeFileSync(join(h.cwd, name), text); return install(args, options); };
		assert.equal(await runSelfInstall(["--console", "--yes"], h.deps), 2, name);
		assert.equal(fs.readFileSync(join(h.cwd, name), "utf8"), text, name);
		assert.deepEqual(h.handovers, [], name);
	}
});

test("the real umask is what gets tightened", async () => {
	const h = harness();
	delete h.deps.tightenUmask;
	const before = process.umask(0o002);
	try {
		await runSelfInstall(["--console", "--yes"], h.deps);
		assert.equal(process.umask(), 0o022);
	} finally { process.umask(before); }
});

test("a project's .env is named in the refusal, and a project under a loose umask hears about the project, not the mode", async () => {
	const h = harness();
	fs.writeFileSync(join(h.cwd, ".env"), "API_URL=x\n", { mode: 0o600 });
	fs.chmodSync(h.cwd, 0o775);
	assert.equal(await runSelfInstall(["--console", "--yes"], h.deps), 2);
	assert.match(h.lines.join(""), /already holds other files \(\.env\)/);
});

test("several operators and no terminal to ask on is refused before the install", async () => {
	const h = harness();
	fs.writeFileSync(join(h.cwd, "triggers.json"), "{}");
	for (const name of ["one", "two"]) addToken({ path: join(h.cwd, "console-tokens.json"), name, role: "operator" });
	assert.equal(await runSelfInstall(["--console", "--yes"], { ...h.deps, isTTY: false }), 2);
	assert.deepEqual(h.installs, []);
});

test("the refusal for another deployment's service names that deployment and a command that works there", async () => {
	const h = harness();
	const owner = fs.realpathSync(tempDir("console-install-owner-"));
	fs.mkdirSync(join(owner, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(join(owner, "node_modules", ".bin", "pi-dispatch"), "");
	const units = join(h.deps.home, ".config", "systemd", "user");
	fs.mkdirSync(units, { recursive: true });
	fs.writeFileSync(join(units, "pi-dispatch-console.service"), `[Service]\nWorkingDirectory=${owner}\n`);
	assert.equal(await runSelfInstall(["--console", "--yes"], h.deps), 2);
	assert.ok(h.lines.join("").includes(`, for ${owner}`), h.lines.join(""));
	assert.ok(h.lines.join("").includes(`${owner}/node_modules/.bin/pi-dispatch service uninstall --console`), h.lines.join(""));
});

test("a package.json that only claims our name is someone's, because overrides or dependencies would redirect the pinned install", async () => {
	for (const extra of [{ overrides: { dep: "evil" } }, { dependencies: { a: "1.0.0" } }, { scripts: {} }]) {
		const h = harness();
		fs.writeFileSync(join(h.cwd, "package.json"), JSON.stringify({ name: "pi-dispatch-deployment", private: true, ...extra }));
		assert.equal(await runSelfInstall(["--console", "--yes"], h.deps), 2, JSON.stringify(extra));
		assert.deepEqual(h.installs, []);
	}
});

test("a commented key, or real files beside deployment evidence, is no deployment; what init scaffolds is", async () => {
	const commented = harness();
	fs.writeFileSync(join(commented.cwd, ".env"), "# VALKEY_PASSWORD=x\n", { mode: 0o600 });
	assert.equal(await runSelfInstall(["--console", "--yes"], commented.deps), 2);
	const beside = harness();
	fs.writeFileSync(join(beside.cwd, "triggers.json"), "{}");
	fs.writeFileSync(join(beside.cwd, "app.py"), "");
	assert.equal(await runSelfInstall(["--console", "--yes"], beside.deps), 2);
	assert.deepEqual([commented.installs, beside.installs], [[], []]);
	assert.match(beside.lines.join(""), /app\.py/);
	const scaffolded = fs.realpathSync(tempDir("console-install-init-"));
	await runInit(scaffolded, { out: () => {} });
	for (const name of fs.readdirSync(scaffolded)) assert.ok(DEPLOYMENT_FILES.has(name), `init writes ${name}, so a deployment may hold it`);
});

test("a folder opened to others is checked again after the wait, and anything planted during it stops the install", async () => {
	const h = harness();
	fs.chmodSync(h.cwd, 0o775);
	h.deps.prompt = async () => { fs.writeFileSync(join(h.cwd, ".npmrc"), "registry=https://evil.example/\n"); return "y"; };
	assert.equal(await runSelfInstall(["--console"], h.deps), 2);
	assert.deepEqual(h.installs, []);
	assert.match(h.lines.join(""), /appeared in this folder/);
	const gitted = harness();
	fs.mkdirSync(join(gitted.cwd, ".git"));
	fs.chmodSync(gitted.cwd, 0o775);
	assert.equal(await runSelfInstall(["--console", "--yes"], gitted.deps), 0, "a folder with only .git is as empty as the folder check calls it");
});

test("the umask tightens the two bits and only those", () => {
	assert.equal(tightenedUmask(0o002), 0o022);
	assert.equal(tightenedUmask(0o022), 0o022);
	assert.equal(tightenedUmask(0o077), 0o077);
});

test("the stores of pnpm, yarn and bun are caches as npm's is", () => {
	for (const path of ["/Users/me/Library/Caches/pnpm/dlx/abc/node_modules/x", "/tmp/xfs-1a/dlx-123/node_modules/x", "/private/tmp/bunx-501-pkg/node_modules/x", "/home/me/.yarn/berry/cache/x"]) assert.equal(setupCachePath(path), true, path);
	for (const path of ["/srv/dlxproject/deployment", "/srv/dlx/deploy/node_modules/x", "/home/me/dlx-2/deploy", "/home/me/bunx-experiments/deploy"]) assert.equal(setupCachePath(path), false, path);
});

test("an operator name that cannot be used is refused before the install, with one operator or several", async () => {
	for (const names of [["one"], ["one", "two"]]) {
		const h = harness();
		fs.writeFileSync(join(h.cwd, "triggers.json"), "{}");
		for (const name of names) addToken({ path: join(h.cwd, "console-tokens.json"), name, role: "operator" });
		assert.equal(await runSelfInstall(["--console", "--yes", "--name", "nobody"], h.deps), 2, names.join());
		assert.deepEqual(h.installs, []);
	}
});

test("a wrongly named installed package is not trusted", async () => {
	const h = harness();
	const install = h.deps.npmInstall;
	h.deps.npmInstall = async (args, options) => {
		const code = await install(args, options);
		fs.writeFileSync(join(options.cwd, "node_modules", "@edgehero", "pi-dispatch", "package.json"), JSON.stringify({ name: "other", version: VERSIONS.version }));
		return code;
	};
	assert.equal(await runSelfInstall(["--console", "--yes"], h.deps), 2);
	assert.deepEqual(h.handovers, []);
});

test("a .env alone proves nothing, and a folder's npm settings or modules are refused even beside a real deployment", async () => {
	const web = (h) => { fs.writeFileSync(join(h.cwd, ".env"), "API_URL=https://x\n", { mode: 0o600 }); };
	const deployed = (h) => { fs.writeFileSync(join(h.cwd, ".env"), "VALKEY_PASSWORD=abc\n", { mode: 0o600 }); };
	const cases = {
		"a web project's .env": (h) => { web(h); },
		".npmrc beside a real .env": (h) => { deployed(h); fs.writeFileSync(join(h.cwd, ".npmrc"), "registry=https://evil.example/\n"); },
		"someone's package.json": (h) => { deployed(h); fs.writeFileSync(join(h.cwd, "package.json"), '{"name":"mine"}'); },
		"node_modules": (h) => { deployed(h); fs.mkdirSync(join(h.cwd, "node_modules", ".bin"), { recursive: true }); },
	};
	for (const [name, set] of Object.entries(cases)) {
		const h = harness();
		set(h);
		assert.equal(await runSelfInstall(["--console", "--yes"], h.deps), 2, name);
		assert.deepEqual(h.installs, [], name);
	}
});

test("a planted launchctl never runs: the probe's PATH has no folder's .bin", async () => {
	const h = harness();
	let probedWith;
	h.deps.env = { PATH: `${h.cwd}/node_modules/.bin:/x/node_modules/.bin/:/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/usr/bin` };
	h.deps.consoleCommand = async (_bin, _args, options) => { probedWith = options.env.PATH; return { code: 0, stdout: "" }; };
	await runSelfInstall(["--console", "--yes"], h.deps);
	assert.equal(probedWith, "/usr/bin");
});

test("a name that cannot be the first operator, a folder in a cache and a writable parent are refused before the install", async () => {
	const badName = harness();
	assert.equal(await runSelfInstall(["--console", "--yes", "--name", "Not Valid"], badName.deps), 2);
	assert.deepEqual(badName.installs, []);
	untouched(badName.cwd);
	const held = harness();
	addToken({ path: join(held.cwd, "console-tokens.json"), name: "operator", role: "viewer" });
	fs.writeFileSync(join(held.cwd, "triggers.json"), "{}");
	assert.equal(await runSelfInstall(["--console", "--yes"], held.deps), 2);
	assert.deepEqual(held.installs, []);
	const root = fs.realpathSync(tempDir("console-install-"));
	const cached = harness();
	const inCache = join(root, ".cache", "d");
	fs.mkdirSync(inCache, { recursive: true });
	assert.equal(await runSelfInstall(["--console", "--yes"], { ...cached.deps, cwd: inCache }), 2);
	assert.deepEqual(cached.installs, []);
	assert.deepEqual(fs.readdirSync(inCache), []);
	const open = harness();
	const looseParent = join(root, "loose");
	fs.mkdirSync(join(looseParent, "d"), { recursive: true });
	fs.chmodSync(looseParent, 0o777);
	assert.equal(await runSelfInstall(["--console", "--yes"], { ...open.deps, cwd: join(looseParent, "d") }), 2);
	assert.deepEqual(open.installs, []);
	fs.chmodSync(looseParent, 0o755);
});

test("Ubuntu's default umask: an empty loose folder is tightened after the answer, not refused, and the umask is set for the install", async () => {
	const h = harness();
	fs.chmodSync(h.cwd, 0o775);
	let umaskSet = false;
	h.deps.tightenUmask = () => { umaskSet = true; };
	assert.equal(await runSelfInstall(["--console", "--yes"], h.deps), 0);
	assert.equal(umaskSet, true);
	assert.equal(fs.statSync(h.cwd).mode & 0o022, 0);
	const declined = harness({ answer: "n" });
	fs.chmodSync(declined.cwd, 0o775);
	await runSelfInstall(["--console"], declined.deps);
	assert.equal(fs.statSync(declined.cwd).mode & 0o022, 0o020, "no answer, no change");
	const full = harness();
	fs.writeFileSync(join(full.cwd, "triggers.json"), "{}");
	fs.chmodSync(full.cwd, 0o775);
	assert.equal(await runSelfInstall(["--console", "--yes"], full.deps), 2, "a folder with things in it could have had them planted through that bit");
	assert.deepEqual(full.installs, []);
});

test("if the steps after the install fail, the shortcut is there and the retry is named", async () => {
	const h = harness();
	const realInstall = h.deps.npmInstall;
	h.deps.npmInstall = async (args, options) => {
		const code = await realInstall(args, options);
		fs.mkdirSync(join(options.cwd, "node_modules", ".bin"), { recursive: true });
		fs.writeFileSync(join(options.cwd, "node_modules", ".bin", "pi-dispatch"), "");
		return code;
	};
	h.deps.handOver = async () => 2;
	assert.equal(await runSelfInstall(["--console", "--yes"], h.deps), 2);
	assert.equal(fs.lstatSync(join(h.cwd, "pi-dispatch")).isSymbolicLink(), true);
	assert.match(h.lines.join(""), /Fix what is printed above, then run this in this folder: \.\/pi-dispatch up --console/);
});

test("an existing deployment is never asked the one question: on one in use, yes could restart a live queue", async () => {
	const h = harness({ answer: "y" });
	fs.writeFileSync(join(h.cwd, "triggers.json"), "{}");
	fs.writeFileSync(join(h.cwd, ".env"), "VALKEY_PASSWORD=abc\n", { mode: 0o600 });
	assert.equal(await runSelfInstall(["--console"], h.deps), 0);
	assert.deepEqual(h.asked.map((q) => /Run that in this folder/.test(q)), [true]);
	assert.deepEqual(h.handovers[0].args.slice(1), ["up", "--console", "--ask-each"]);
});

test("the cache is judged on the real path, and only npx's own", () => {
	const of = (path) => runningFromNpmCache({ entry: path, realpath: (p) => p });
	assert.equal(of("/home/me/.npm/_npx/abc/node_modules/@edgehero/pi-dispatch/src/console-bootstrap.mjs"), true);
	assert.equal(of("/srv/deploy/node_modules/@edgehero/pi-dispatch/src/console-bootstrap.mjs"), false);
	assert.equal(of("/home/me/.cache/deploy/node_modules/@edgehero/pi-dispatch/src/console-bootstrap.mjs"), false, "a durable install under .cache must not be told to install itself");
	assert.equal(runningFromNpmCache({ entry: "/x", realpath: () => { throw new Error("gone"); } }), false);
	assert.equal(runningFromNpmCache({ entry: "/srv/link", realpath: () => "/home/me/.npm/_npx/a/x.mjs" }), true, "npx reaches it through a link");
});

test("the real trust check refuses a group-writable installed file", async () => {
	const h = harness();
	delete h.deps.trustedFile;
	const install = h.deps.npmInstall;
	h.deps.npmInstall = async (args, options) => {
		const code = await install(args, options);
		fs.chmodSync(join(options.cwd, "node_modules", "@edgehero", "pi-dispatch", "src", "cli.mjs"), 0o666);
		return code;
	};
	assert.equal(await runSelfInstall(["--console", "--yes"], h.deps), 2);
	assert.deepEqual(h.handovers, []);
});

test("no answer leaves the folder as it was", async () => {
	for (const answer of ["n", "", "maybe"]) {
		const h = harness({ answer });
		assert.equal(await runSelfInstall(["--console"], h.deps), 0, answer);
		assert.deepEqual([h.installs, h.handovers], [[], []], answer);
		untouched(h.cwd);
	}
});

test("asking each step asks about the install too, and forwards that choice", async () => {
	let turn = 0;
	const h = harness();
	h.deps.prompt = async (question) => { h.asked.push(question); return turn++ === 0 ? "a" : "y"; };
	assert.equal(await runSelfInstall(["--console"], h.deps), 0);
	assert.equal(h.asked.length, 2);
	assert.match(h.asked[1], /Run that in this folder/);
	assert.deepEqual(h.handovers[0].args.slice(1), ["up", "--console", "--ask-each"]);
	const refused = harness();
	let n = 0;
	refused.deps.prompt = async () => (n++ === 0 ? "a" : "n");
	assert.equal(await runSelfInstall(["--console"], refused.deps), 0);
	assert.deepEqual(refused.installs, []);
	untouched(refused.cwd);
});

test("--yes and --ask-each answer the question without asking it, and other flags cross the handover", async () => {
	const yes = harness();
	await runSelfInstall(["--console", "--yes", "--name", "rob", "--no-open"], yes.deps);
	assert.deepEqual(yes.asked, []);
	assert.deepEqual(yes.handovers[0].args.slice(1), ["up", "--console", "--yes", "--name", "rob", "--no-open"]);
});

test("npm failing, an untrusted result or a wrong version stops before anything is started", async () => {
	const failed = harness();
	failed.deps.npmInstall = async () => 1;
	assert.equal(await runSelfInstall(["--console"], failed.deps), 2);
	assert.deepEqual(failed.handovers, []);
	const untrusted = harness();
	untrusted.deps.trustedFile = () => null;
	assert.equal(await runSelfInstall(["--console"], untrusted.deps), 2);
	assert.deepEqual(untrusted.handovers, []);
	const wrong = harness();
	wrong.deps.ownPackage = () => ({ version: "9.9.9", piVersion: "1.5.0" });
	assert.equal(await runSelfInstall(["--console"], wrong.deps), 2);
	assert.deepEqual(wrong.handovers, []);
});

test("npx's own exports and what it put on PATH do not reach the install or the service; a person's registry and PATH do", () => {
	const env = {
		PATH: "/home/me/.npm/_npx/abc/node_modules/.bin:/here/node_modules/.bin:/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/home/me/.cache/tool/bin:/usr/bin", HOME: "/home/me", INIT_CWD: "/x", npm_command: "exec", npm_config_yes: "true", npm_config_package: "@edgehero/pi-dispatch@5.1.0",
		npm_config_local_prefix: "/x", npm_lifecycle_event: "npx", npm_execpath: "/n", npm_config_registry: "https://registry.example/",
	};
	assert.deepEqual(cleanedNpxEnv(env), { PATH: "/home/me/.cache/tool/bin:/usr/bin", HOME: "/home/me", npm_config_registry: "https://registry.example/" });
	assert.equal(cleanedNpxEnv({ PATH: "node_modules/.bin:/usr/bin" }).PATH, "/usr/bin", "a relative one too");
	// NOT derived, on purpose: which `npm_*` keys npx sets is npm's behaviour and exists nowhere in this repository to derive from. The list
	// was taken from a real `npx --ignore-scripts` run; `NPX_ENV_RE` is an allowlist so an unlisted key is kept, the safe direction.
});

test("up --console goes this way only from npm's cache", async () => {
	const h = harness();
	const code = await runConsoleUp(["--console"], { ...h.deps, fromNpmCache: () => true, runUpFn: async () => { throw new Error("the cache run never runs up itself"); } });
	assert.equal(code, 0);
	assert.equal(h.installs.length, 1);
	assert.equal(h.handovers.length, 1);
});
