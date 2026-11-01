import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { runConsoleUp, verifyConsolePeer } from "../src/console-bootstrap.mjs";
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
	assert.ok(calls.some((argv) => argv.includes("link") && argv.includes("/setup")));
	assert.ok(rows.some((row) => row.action === "token-added"));
	assert.equal(await runConsoleUp(["--console", "--yes"], deps), 0);
	assert.deepEqual(readTokensFile({ path: file }).file.tokens, first.tokens);
	assert.equal(rows.filter((row) => row.action === "token-added").length, 1);
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
	for (const fail of ["service", "health", "link"]) {
		const { deps, lines, cwd } = harness();
		if (fail === "service") deps.runServiceFn = async () => 1;
		if (fail === "health") deps.probeConsole = async () => ({ state: "not-running" });
		if (fail === "link") deps.consoleCommand = async (_bin, args) => ({ code: args.includes("link") ? 1 : 0, stdout: "" });
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
	assert.ok(calls.some((args) => args.includes("link") && args.includes("--port") && args.includes("4790")));
	assert.match(lines.join(""), /ssh -L 4790:/);
	assert.match(lines.join(""), /--name operator --port 4790 --next \/setup/);
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
