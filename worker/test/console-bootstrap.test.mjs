import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { boundedCommand, ensureConsoleShortcut, flagValue, MANAGER_PROBE_MAX_BUFFER, runConsoleUp, upArgvOf, verifyConsolePeer } from "../src/console-bootstrap.mjs";
import { runUp } from "../src/up.mjs";
import { readTokensFile, addToken } from "../src/console-tokens.mjs";

function harness() {
	const cwd = fs.realpathSync(tempDir("console-bootstrap-"));
	const admin = join(cwd, "admin");
	fs.mkdirSync(join(admin, "dist"), { recursive: true });
	fs.writeFileSync(join(admin, "package.json"), JSON.stringify({ name: "@edgehero/pi-dispatch-admin", version: "4.3.1" }));
	const consoleEntry = join(admin, "dist", "console.mjs"); fs.writeFileSync(consoleEntry, "");
	const calls = [], rows = [], lines = [];
	const deps = { cwd, home: cwd, platform: "linux", euid: process.getuid(), env: {}, fs, now: () => 1_800_000_000_000, consoleWaitMs: 0,
		resolveSetupEntry: () => ({ entry: "/opt/worker/src/cli.mjs", version: "4.3.1" }), resolveConsole: () => consoleEntry,
		verifyConsolePeer: () => true,
		out: (text) => lines.push(text), prompt: async () => "yes", audit: { append: (row) => { rows.push(row); return { seq: rows.length }; } },
		consoleCommand: async (bin, args) => { calls.push([bin, ...args]); return { code: 0, stdout: args.includes("link") ? `http://127.0.0.1:4790/login/code#${"A".repeat(43)}&next=/setup\n` : "" }; },
		runUpFn: async () => { calls.push(["up"]); fs.writeFileSync(join(cwd, ".env"), `PI_LOGS_DIR=${join(cwd, "logs")}\n`, { mode: 0o600 }); return 1; },
		runServiceFn: async (args) => { calls.push(["service", ...args]); return 0; }, probeConsole: async () => ({ state: "running" }),
		consoleOpen: async (_bin, args) => { calls.push(["open", ...args]); return 0; },
	};
	return { deps, calls, rows, lines, cwd, consoleEntry };
}

test("up --console refuses missing admin before bootstrap, init, tokens, services or other subprocesses", async () => {
	const { deps, calls, lines, cwd } = harness();
	const before = fs.readdirSync(cwd);
	const code = await runUp(["--console", "--yes"], { ...deps, resolveConsole: () => null });
	assert.equal(code, 2);
	assert.deepEqual(calls, []);
	assert.deepEqual(fs.readdirSync(cwd), before);
	assert.equal(lines.join(""), "up --console: the admin package's built console is missing. Install exact matching @edgehero/pi-dispatch and @edgehero/pi-dispatch-admin versions durably in this deployment, then run its installed pi-dispatch up --console.\n");
});

test("console bootstrap composes the host commands, discards plaintext and preserves the operator on retry", async () => {
	const { deps, calls, rows, lines, cwd } = harness();
	assert.equal(await runConsoleUp(["--console", "--yes"], deps), 0);
	const file = join(cwd, "console-tokens.json");
	const first = readTokensFile({ path: file }).file;
	assert.equal(first.tokens.length, 1);
	assert.equal(first.tokens[0].role, "operator");
	assert.equal(lines.join("").includes("pdc_"), false);
	assert.equal(lines.join("").includes(first.tokens[0].sha256), false);
	assert.match(lines.join(""), /Doctor reports remaining setup/);
	assert.ok(calls.some((argv) => argv.join(" ") === "service install --console --host-setup"));
	assert.ok(calls.some((argv) => argv[0] === "open" && argv.includes("/setup")), "it opens the browser on /setup");
	assert.equal(calls.some((argv) => argv.includes("link")), false, "and mints no second link to print");
	assert.equal(lines.join("").includes("/login/code#"), false, "no code on this command's output");
	assert.ok(rows.some((row) => row.action === "token-added"));
	assert.equal(await runConsoleUp(["--console", "--yes"], deps), 0);
	assert.deepEqual(readTokensFile({ path: file }).file.tokens, first.tokens);
	assert.equal(rows.filter((row) => row.action === "token-added").length, 1);
});

test("a service manager that prints more than the small bound still answered: launchctl print gui/<uid> was 141 KiB on a real Mac", async () => {
	const loud = ["-e", "process.stdout.write('x'.repeat(200 * 1024))"];
	assert.equal((await boundedCommand(process.execPath, loud)).code, null, "every other command keeps the small bound");
	assert.equal((await boundedCommand(process.execPath, loud, { maxBuffer: MANAGER_PROBE_MAX_BUFFER })).code, 0, "and this much output is an answer");
	for (const [platform, bin] of [["linux", "systemctl"], ["darwin", "launchctl"]]) {
		const { deps } = harness();
		const seen = [];
		const answer = deps.consoleCommand;
		deps.platform = platform;
		deps.consoleCommand = async (name, args, options) => { seen.push({ name, options }); return answer(name, args, options); };
		await runConsoleUp(["--console", "--yes"], deps);
		const probe = seen.find((call) => call.name === bin);
		assert.ok(probe, `${platform} asks ${bin}`);
		assert.equal(probe.options.maxBuffer, MANAGER_PROBE_MAX_BUFFER, `${platform}: the probe takes the larger bound`);
	}
});

test("cache/version/platform/manager/token refusals happen before an up mutation", async () => {
	for (const mode of ["cache", "version", "platform", "manager", "tokens"]) {
		const { deps, calls, cwd } = harness();
		if (mode === "cache") deps.resolveSetupEntry = () => ({ refusal: "unsafe-entry" });
		if (mode === "version") fs.writeFileSync(join(cwd, "admin", "package.json"), JSON.stringify({ name: "@edgehero/pi-dispatch-admin", version: "0.1.0" }));
		if (mode === "platform") deps.platform = "win32";
		if (mode === "manager") deps.consoleCommand = async () => ({ code: 1, stdout: "" });
		if (mode === "tokens") fs.writeFileSync(join(cwd, "console-tokens.json"), "{}", { mode: 0o600 });
		assert.equal(await runConsoleUp(["--console", "--yes"], deps), 2, mode);
		assert.equal(calls.some((argv) => argv[0] === "up"), false, mode);
		assert.equal(fs.existsSync(join(cwd, ".env")), false, mode);
	}
});

test("ambiguous operator selection and decline preserve existing state", async () => {
	const { deps, calls, cwd } = harness();
	const path = join(cwd, "console-tokens.json");
	for (const name of ["one", "two"]) addToken({ path, name, role: "operator", now: deps.now });
	const before = fs.readFileSync(path, "utf8");
	assert.equal(await runConsoleUp(["--console", "--yes"], { ...deps, prompt: async () => "missing" }), 2);
	assert.equal(fs.readFileSync(path, "utf8"), before);
	assert.equal(calls.some((argv) => argv[0] === "up"), false);
});

test("failed service/health/link reports retained state and exact terminal recovery", async () => {
	for (const fail of ["service", "health", "open"]) {
		const { deps, lines, cwd } = harness();
		if (fail === "service") deps.runServiceFn = async () => 1;
		if (fail === "health") deps.probeConsole = async () => ({ state: "not-running" });
		if (fail === "open") deps.consoleOpen = async () => 1;
		assert.equal(await runConsoleUp(["--console", "--yes"], deps), 2, fail);
		assert.equal(readTokensFile({ path: join(cwd, "console-tokens.json") }).file.tokens.length, 1);
		assert.match(lines.join(""), /pi-dispatch-console link --deployment .* --name operator --next \/setup/);
		assert.equal(lines.join("").includes("pdc_"), false);
	}
});

test("audit failure prevents new token creation and console installation", async () => {
	const { deps, calls, cwd } = harness();
	assert.equal(await runConsoleUp(["--console", "--yes"], { ...deps, audit: { append() { throw new Error("disk full"); } } }), 2);
	assert.equal(fs.existsSync(join(cwd, "console-tokens.json")), false);
	assert.equal(calls.some((argv) => argv[0] === "service"), false);
});

test("a private socket gets an explicit tunnel port in both link and recovery", async () => {
	const { deps, calls, lines, cwd } = harness();
	const socketDir = join(cwd, "socket"); fs.mkdirSync(socketDir, { mode: 0o700 });
	const text = `PI_CONSOLE_LISTEN=unix:${join(socketDir, "console.sock")}\n`;
	fs.writeFileSync(join(cwd, ".env"), text, { mode: 0o600 });
	deps.runUpFn = async () => 0;
	assert.equal(await runConsoleUp(["--console", "--yes"], deps), 0);
	assert.ok(calls.some((args) => args[0] === "open" && args.includes("--port") && args.includes("4790")));
	const refused = harness();
	const dir = join(refused.cwd, "socket"); fs.mkdirSync(dir, { mode: 0o700 });
	fs.writeFileSync(join(refused.cwd, ".env"), `PI_CONSOLE_LISTEN=unix:${join(dir, "console.sock")}\n`, { mode: 0o600 });
	refused.deps.runUpFn = async () => 0;
	refused.deps.consoleOpen = async () => 1;
	assert.equal(await runConsoleUp(["--console", "--yes"], refused.deps), 2);
	assert.match(refused.lines.join(""), /--name operator --port 4790 --next \/setup/);
});

test("installed pi peer evidence is exact package metadata, never the registry's current version", () => {
	const root = tempDir("setup-peer-");
	const admin = join(root, "node_modules", "@edgehero", "pi-dispatch-admin");
	const peer = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
	fs.mkdirSync(join(admin, "dist"), { recursive: true }); fs.mkdirSync(join(peer, "dist", "bundle"), { recursive: true });
	const bin = join(peer, "dist", "bundle", "cli.js");
	fs.writeFileSync(bin, "");
	const entry = join(admin, "dist", "console.mjs");
	for (const [version, ok] of [["1.4.0", true], ["9.0.0", false]]) {
		fs.writeFileSync(join(peer, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, bin: { pi: "dist/bundle/cli.js" }, dependencies: { "@earendil-works/pi-ai": version } }));
		assert.equal(verifyConsolePeer(entry, { expected: "1.4.0" }), ok);
	}
	fs.writeFileSync(join(peer, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.4.0", bin: { pi: "dist/bundle/cli.js" } }));
	assert.equal(verifyConsolePeer(entry, { expected: "1.4.0" }), true);
	fs.chmodSync(bin, 0o666);
	assert.equal(verifyConsolePeer(entry, { expected: "1.4.0" }), false, "matching version cannot authorize a writable pi entry");
	fs.chmodSync(bin, 0o644);
	fs.chmodSync(join(peer, "package.json"), 0o666);
	assert.equal(verifyConsolePeer(entry, { expected: "1.4.0" }), false, "metadata must have the same durable trust boundary");
});

test("the bootstrap's executable peer contract holds against the repository's installed exact pi artifact", () => {
	const workerPackage = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const entry = fileURLToPath(new URL("../../admin/dist/console.mjs", import.meta.url));
	assert.equal(verifyConsolePeer(entry, { expected: workerPackage.dependencies["@earendil-works/pi-ai"] }), true);
});

test("an existing console requires the exact generated unit and loaded command before bootstrap mutates", async () => {
	const { deps, calls, cwd } = harness();
	const units = join(cwd, ".config", "systemd", "user");
	fs.mkdirSync(units, { recursive: true });
	fs.writeFileSync(join(units, "pi-dispatch-console.service"), "malformed but containing --host-setup");
	let planned = 0;
	deps.consoleServicePlan = async (argv, serviceDeps) => {
		planned++;
		assert.deepEqual(argv, ["start", "--console"]);
		assert.equal(serviceDeps.setupConsoleGrant, true);
		return { refusal: "foreign-service" };
	};
	assert.equal(await runConsoleUp(["--console", "--yes"], deps), 2);
	assert.equal(planned, 1);
	assert.deepEqual(calls, []);
	assert.equal(fs.existsSync(join(cwd, ".env")), false);
});

test("an existing granted console carries its exact preflight into the final service dispatch", async () => {
	const { deps, cwd } = harness();
	const units = join(cwd, ".config", "systemd", "user");
	fs.mkdirSync(units, { recursive: true });
	fs.writeFileSync(join(units, "pi-dispatch-console.service"), "validated by injected shared planner");
	const expected = { operation: "start", which: "console", before: "validated", loaded: true };
	deps.consoleServicePlan = async () => expected;
	deps.runServiceFn = async (argv, serviceDeps) => {
		assert.deepEqual(argv, ["start", "--console"]);
		assert.equal(serviceDeps.setupConsoleGrant, true);
		assert.equal(serviceDeps.setupExpected, expected);
		return 0;
	};
	assert.equal(await runConsoleUp(["--console", "--yes"], deps), 0);
});

test("an entry of a role this release does not know is no operator to reuse, and its name is not free (issue #761)", async () => {
	const { deps, calls, lines, cwd } = harness();
	const path = join(cwd, "console-tokens.json");
	const kept = { name: "operator", role: "auditor", sha256: "c".repeat(64), createdAt: "2026-10-02T00:00:00.000Z" };
	fs.writeFileSync(path, JSON.stringify({ version: 1, generation: 0, tokens: [kept] }), { mode: 0o600 });
	fs.chmodSync(path, 0o600);
	const before = fs.readFileSync(path, "utf8");
	// No known operator, so bootstrap would make one under the default name, which the kept entry holds.
	assert.equal(await runConsoleUp(["--console", "--yes"], deps), 2);
	assert.match(lines.join(""), /choose an unused valid operator name with --name; nothing was changed/);
	assert.equal(fs.readFileSync(path, "utf8"), before);
	assert.equal(calls.some((argv) => argv[0] === "up"), false);
});

// Issue #849: a first run asks one question.

function counting(deps, answer) {
	const asked = [];
	deps.prompt = async (question) => { asked.push(question); return answer; };
	return asked;
}

test("a fresh deployment asks one question, and yes to it is exactly --yes", async () => {
	const { deps, cwd } = harness();
	const asked = counting(deps, "y");
	let given;
	deps.runUpFn = async (argv) => { given = argv; fs.writeFileSync(join(cwd, ".env"), `PI_LOGS_DIR=${join(cwd, "logs")}\n`, { mode: 0o600 }); return 0; };
	assert.equal(await runConsoleUp(["--console"], deps), 0);
	assert.equal(asked.length, 1, asked.join(" | "));
	assert.deepEqual(given, ["--yes"], "up is told exactly what the flag would have told it");
	assert.equal(readTokensFile({ path: join(cwd, "console-tokens.json") }).file.tokens[0].name, "operator", "no prompt for a name");
});

test("answering a keeps every step's own question, and no answer stops with nothing changed", async () => {
	const each = harness();
	const asked = counting(each.deps, "a");
	await runConsoleUp(["--console"], each.deps);
	assert.equal(asked.length, 2, "the first-run question, then the bootstrap's own");
	assert.match(asked[1], /Proceed with console bootstrap/);
	assert.equal(each.calls.find((argv) => argv[0] === "up") !== undefined, false, "and a answers no to that second one, which is what a fake answering a does");
	const no = harness();
	const noAsked = counting(no.deps, "");
	assert.equal(await runConsoleUp(["--console"], no.deps), 0);
	assert.equal(noAsked.length, 1);
	assert.deepEqual(no.calls.filter((argv) => argv[0] !== "systemctl"), [], "nothing ran");
	assert.equal(fs.existsSync(join(no.cwd, ".env")), false);
	assert.equal(fs.existsSync(join(no.cwd, "console-tokens.json")), false);
});

test("--ask-each skips the question, so a caller that promised per-step consent keeps it", async () => {
	const { deps } = harness();
	const asked = counting(deps, "n");
	assert.equal(await runConsoleUp(["--console", "--ask-each"], deps), 0);
	assert.deepEqual(asked.map((q) => /Proceed with console bootstrap/.test(q)), [true]);
});

test("a deployment that already has an operator is not asked the first-run question", async () => {
	const { deps, cwd } = harness();
	addToken({ path: join(cwd, "console-tokens.json"), name: "one", role: "operator", now: deps.now });
	const asked = counting(deps, "y");
	await runConsoleUp(["--console"], deps);
	assert.deepEqual(asked.map((q) => /Proceed with console bootstrap/.test(q)), [true]);
});

test("--name names the first operator and is refused when it is no valid name", async () => {
	const { deps, cwd } = harness();
	assert.equal(await runConsoleUp(["--console", "--yes", "--name", "rob"], deps), 0);
	assert.equal(readTokensFile({ path: join(cwd, "console-tokens.json") }).file.tokens[0].name, "rob");
	const bad = harness();
	assert.equal(await runConsoleUp(["--console", "--yes", "--name", "Not Valid"], bad.deps), 2);
	assert.equal(fs.existsSync(join(bad.cwd, "console-tokens.json")), false);
});

test("--name picks among several operators without a prompt", async () => {
	const { deps, calls, cwd } = harness();
	const path = join(cwd, "console-tokens.json");
	for (const name of ["one", "two"]) addToken({ path, name, role: "operator", now: deps.now });
	const asked = counting(deps, "y");
	assert.equal(await runConsoleUp(["--console", "--yes", "--name", "two"], deps), 0);
	assert.deepEqual(asked, []);
	assert.ok(calls.some((argv) => argv[0] === "open" && argv.join(" ").includes("--name two")));
});

test("the flags only up --console reads never reach up, and a bad --name value is not swallowed as one", () => {
	assert.deepEqual(upArgvOf(["--console", "--no-open", "--ask-each", "--name", "rob", "--adopt-volume"]), ["--adopt-volume"]);
	assert.deepEqual(upArgvOf(["--name", "--adopt-volume"]), ["--adopt-volume"], "--name with no value takes nothing with it");
	assert.equal(flagValue(["--name", "rob"], "--name"), "rob");
	assert.equal(flagValue(["--name", "--yes"], "--name"), null);
	assert.equal(flagValue([], "--name"), null);
});

test("--no-open makes no code at all: the wizard signs the person in itself", async () => {
	const { deps, calls, lines } = harness();
	assert.equal(await runConsoleUp(["--console", "--yes", "--no-open"], deps), 0);
	assert.equal(calls.some((argv) => argv[0] === "open" || argv.includes("link")), false);
	assert.equal(lines.join("").includes("/login/code#"), false);
});

test("the way back in is said before the browser step, which can wait on a person", async () => {
	const { deps, lines } = harness();
	let saidBefore = false;
	deps.consoleOpen = async () => { saidBefore = lines.join("").includes("Get back in any time"); return 0; };
	assert.equal(await runConsoleUp(["--console", "--yes"], deps), 0);
	assert.equal(saidBefore, true);
});

test("the ./pi-dispatch shortcut is made once, relative, and never replaces something else", () => {
	const dir = tempDir("console-shortcut-");
	assert.equal(ensureConsoleShortcut(dir, fs), false, "nothing installed here, so nothing to point at");
	assert.equal(fs.existsSync(join(dir, "pi-dispatch")), false);
	fs.mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(join(dir, "node_modules", ".bin", "pi-dispatch"), "");
	assert.equal(ensureConsoleShortcut(dir, fs), true);
	assert.equal(fs.readlinkSync(join(dir, "pi-dispatch")), join("node_modules", ".bin", "pi-dispatch"));
	assert.equal(ensureConsoleShortcut(dir, fs), true, "again: already there");
	const taken = tempDir("console-shortcut-");
	fs.mkdirSync(join(taken, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(join(taken, "node_modules", ".bin", "pi-dispatch"), "");
	fs.writeFileSync(join(taken, "pi-dispatch"), "mine");
	assert.equal(ensureConsoleShortcut(taken, fs), false);
	assert.equal(fs.readFileSync(join(taken, "pi-dispatch"), "utf8"), "mine");
});

test("a live deployment with no operator is not asked the one question: yes there could restart its queue", async () => {
	const { deps, cwd } = harness();
	fs.writeFileSync(join(cwd, ".env"), `PI_LOGS_DIR=${join(cwd, "logs")}\n`, { mode: 0o600 });
	const asked = counting(deps, "y");
	await runConsoleUp(["--console"], deps);
	assert.deepEqual(asked.map((q) => /Proceed with console bootstrap/.test(q)), [true]);
});

test("--yes with --ask-each is refused rather than resolved", async () => {
	const { deps, calls } = harness();
	assert.equal(await runConsoleUp(["--console", "--yes", "--ask-each"], deps), 2);
	assert.deepEqual(calls, []);
});

test("--name=value reads like --name value and never reaches up", () => {
	assert.equal(flagValue(["--name=rob"], "--name"), "rob");
	assert.deepEqual(upArgvOf(["--name=rob", "--yes"]), ["--yes"]);
});

test("the shortcut is made by the real flow, and the way back in names it", async () => {
	const { deps, cwd, lines } = harness();
	fs.mkdirSync(join(cwd, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(join(cwd, "node_modules", ".bin", "pi-dispatch"), "");
	assert.equal(await runConsoleUp(["--console", "--yes"], deps), 0);
	assert.equal(fs.lstatSync(join(cwd, "pi-dispatch")).isSymbolicLink(), true);
	assert.match(lines.join(""), /Get back in any time: \.\/pi-dispatch console/);
});

test("a recovery line is one that works where the person is standing", async () => {
	const { deps, cwd, lines } = harness();
	fs.mkdirSync(join(cwd, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(join(cwd, "node_modules", ".bin", "pi-dispatch-console"), "");
	deps.consoleOpen = async () => 1;
	assert.equal(await runConsoleUp(["--console", "--yes"], deps), 2);
	assert.match(lines.join(""), /\.\/node_modules\/\.bin\/pi-dispatch-console link --deployment/);
});

test("the plain up step is told to leave its next steps to /setup", async () => {
	const { deps, cwd } = harness();
	let told;
	deps.runUpFn = async (_argv, upDeps) => { told = upDeps.skipNextSteps; fs.writeFileSync(join(cwd, ".env"), "", { mode: 0o600 }); return 0; };
	await runConsoleUp(["--console", "--yes"], deps);
	assert.equal(told, true);
});

test("with one operator, --name must be that operator: ignoring it would sign in someone not asked for", async () => {
	const { deps, cwd, calls } = harness();
	addToken({ path: join(cwd, "console-tokens.json"), name: "one", role: "operator", now: deps.now });
	assert.equal(await runConsoleUp(["--console", "--yes", "--name", "two"], deps), 2);
	assert.equal(calls.some((argv) => argv[0] === "up"), false);
});

test("a failed token write names the console command that exists here", async () => {
	const { deps, cwd, lines } = harness();
	fs.mkdirSync(join(cwd, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(join(cwd, "node_modules", ".bin", "pi-dispatch-console"), "");
	deps.addToken = () => ({ invalid: "no" });
	assert.equal(await runConsoleUp(["--console", "--yes"], deps), 2);
	assert.match(lines.join(""), /\.\/node_modules\/\.bin\/pi-dispatch-console token add/);
});

test("a durable worker with no admin package still refuses: only npm's cache installs", async () => {
	const { deps, calls } = harness();
	assert.equal(await runConsoleUp(["--console", "--yes"], { ...deps, resolveConsole: () => null, fromNpmCache: () => false }), 2);
	assert.deepEqual(calls, []);
});
