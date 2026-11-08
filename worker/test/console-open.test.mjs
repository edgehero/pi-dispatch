import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { runConsoleOpen } from "../src/console-open.mjs";

// `pi-dispatch console` (issue #849): owns the service, and hands the credential to the admin's `open`.

function harness({ running = true, unit = false } = {}) {
	const cwd = fs.realpathSync(tempDir("console-open-"));
	const calls = [], rows = [], lines = [];
	const home = cwd;
	fs.writeFileSync(join(cwd, ".env"), "", { mode: 0o600 });
	let up = running;
	const deps = {
		fs, cwd, home, platform: "linux", euid: process.getuid(), env: {}, now: () => 1_800_000_000_000, consoleWaitMs: 0, sleep: async () => {},
		out: (text) => lines.push(text), audit: { append: (row) => { rows.push(row); return { seq: rows.length }; } },
		readTokens: () => ({ file: { tokens: [{ name: "rob", role: "operator" }] } }), resolveConsole: () => "/opt/admin/dist/console.mjs", consoleUnit: () => (unit ? "/unit" : null), probeConsole: async () => ({ state: up ? "running" : "not-running" }),
		runServiceFn: async (args) => { calls.push(["service", ...args]); up = true; return 0; },
		consoleOpen: async (bin, args) => { calls.push(["open", ...args]); return 0; },
	};
	return { deps, calls, rows, lines, cwd };
}

test("a running console goes straight to the admin's open, and no service is touched", async () => {
	const { deps, calls, rows, cwd } = harness();
	assert.equal(await runConsoleOpen([], deps), 0);
	assert.deepEqual(calls, [["open", "/opt/admin/dist/console.mjs", "open", "--deployment", cwd]]);
	assert.deepEqual(rows, []);
});

test("a stopped console with a service is started, with its audit row first, then opened", async () => {
	const { deps, calls, rows, lines } = harness({ running: false, unit: true });
	assert.equal(await runConsoleOpen([], deps), 0);
	assert.deepEqual(calls.map((row) => row[0]), ["service", "open"]);
	assert.deepEqual(calls[0], ["service", "start", "--console"]);
	assert.deepEqual(rows.map((row) => [row.kind, row.outcome]), [["setup-console-start", "ok"]]);
	assert.match(lines.join(""), /Starting its service/);
});

test("a stopped console with no service is refused and says what would set one up", async () => {
	const { deps, calls, lines } = harness({ running: false });
	assert.equal(await runConsoleOpen([], deps), 2);
	assert.deepEqual(calls, []);
	assert.match(lines.join(""), /pi-dispatch up --console/);
});

test("an unwritable audit log starts nothing, a refused start and a silent service both refuse", async () => {
	const audit = harness({ running: false, unit: true });
	audit.deps.audit = { append() { throw new Error("disk full"); } };
	assert.equal(await runConsoleOpen([], audit.deps), 2);
	assert.deepEqual(audit.calls, []);
	const refused = harness({ running: false, unit: true });
	refused.deps.runServiceFn = async () => 1;
	assert.equal(await runConsoleOpen([], refused.deps), 2);
	assert.deepEqual(refused.rows.map((row) => row.outcome), ["ok", "failed"]);
	assert.equal(refused.calls.some((row) => row[0] === "open"), false);
	const silent = harness({ running: false, unit: true });
	silent.deps.runServiceFn = async () => 0;
	assert.equal(await runConsoleOpen([], silent.deps), 2);
	assert.equal(silent.calls.some((row) => row[0] === "open"), false);
});

test("a missing console package names the command that installs it", async () => {
	const { deps, lines } = harness();
	assert.equal(await runConsoleOpen([], { ...deps, resolveConsole: () => null }), 2);
	assert.match(lines.join(""), /pi-dispatch up --console/);
});

test("--name, --next and --port are passed along, and a socket gets the tunnel's port", async () => {
	const { deps, calls, cwd } = harness();
	deps.readTokens = () => ({ file: { tokens: [{ name: "rob", role: "operator" }] } });
	await runConsoleOpen(["--name", "rob", "--next", "/setup"], deps);
	assert.deepEqual(calls[0].slice(2), ["open", "--deployment", cwd, "--name", "rob", "--next", "/setup"]);
	const socket = harness();
	const dir = join(socket.cwd, "s");
	fs.mkdirSync(dir, { mode: 0o700 });
	fs.writeFileSync(join(socket.cwd, ".env"), `PI_CONSOLE_LISTEN=unix:${join(dir, "c.sock")}\n`, { mode: 0o600 });
	await runConsoleOpen([], socket.deps);
	assert.deepEqual(socket.calls[0].slice(-2), ["--port", "4790"]);
});

test("the admin's exit code is the command's", async () => {
	const { deps } = harness();
	assert.equal(await runConsoleOpen([], { ...deps, consoleOpen: async () => 7 }), 7);
	assert.equal(await runConsoleOpen([], { ...deps, consoleOpen: async () => null }), 2);
});

test("a unit is this deployment's own or it is not started: another's could hold a host-setup grant", async () => {
	const { deps, calls, rows, lines, cwd } = harness({ running: false });
	let asked;
	deps.consoleUnit = (query) => { asked = query; return null; };
	assert.equal(await runConsoleOpen([], deps), 2);
	assert.equal(asked.cwd, cwd);
	assert.deepEqual([calls, rows], [[], []]);
	assert.match(lines.join(""), /no service for this deployment/);
});

test("arguments are read strictly: --help does nothing else, an unknown flag and a stray positional are refused, --name= is honoured", async () => {
	const help = harness({ running: false, unit: true });
	assert.equal(await runConsoleOpen(["--help"], help.deps), 0);
	assert.deepEqual(help.calls, []);
	assert.match(help.lines.join(""), /usage: pi-dispatch console/);
	const typo = harness();
	assert.equal(await runConsoleOpen(["--nmae", "x"], typo.deps), 2);
	assert.deepEqual(typo.calls, []);
	const stray = harness();
	assert.equal(await runConsoleOpen(["somewhere"], stray.deps), 2);
	assert.deepEqual(stray.calls, []);
	const inline = harness();
	inline.deps.readTokens = () => ({ file: { tokens: [{ name: "rob", role: "operator" }] } });
	await runConsoleOpen(["--name=rob"], inline.deps);
	assert.deepEqual(inline.calls[0].slice(-2), ["--name", "rob"]);
	const other = harness();
	const elsewhere = fs.realpathSync(tempDir("console-open-other-"));
	fs.writeFileSync(join(elsewhere, ".env"), "", { mode: 0o600 });
	await runConsoleOpen([`--deployment=${elsewhere}`], other.deps);
	assert.deepEqual(other.calls[0].slice(3), ["--deployment", elsewhere]);
});

test("a folder that is no deployment says where to run it, and a differing shell address is refused", async () => {
	const none = harness();
	fs.rmSync(join(none.cwd, ".env"));
	assert.equal(await runConsoleOpen([], none.deps), 2);
	assert.match(none.lines.join(""), /Run this from your deployment folder, or pass --deployment/);
	const differs = harness();
	differs.deps.env = { PI_CONSOLE_LISTEN: "127.0.0.1:9999" };
	assert.equal(await runConsoleOpen([], differs.deps), 2);
	assert.deepEqual(differs.calls, []);
});

test("an unsafe .env and an unknown address are each refused before anything starts", async () => {
	const unsafe = harness();
	fs.chmodSync(join(unsafe.cwd, ".env"), 0o666);
	assert.equal(await runConsoleOpen([], unsafe.deps), 2);
	assert.match(unsafe.lines.join(""), /unsafe or cannot be read/);
	assert.deepEqual(unsafe.calls, []);
	const unknown = harness();
	fs.writeFileSync(join(unknown.cwd, ".env"), "PI_CONSOLE_LISTEN=127.0.0.1:0\n", { mode: 0o600 });
	assert.equal(await runConsoleOpen([], unknown.deps), 2);
	assert.match(unknown.lines.join(""), /no concrete local address/);
});

test("what the admin would refuse is refused before a service starts", async () => {
	const tokenOf = (name, role = "operator") => ({ name, role });
	const cases = [
		[{ refusal: "group-writable" }, /cannot be used/],
		[{ file: { tokens: [] } }, /no operator token yet/],
		[{ file: { tokens: [tokenOf("a"), tokenOf("b")] } }, /2 operator tokens/],
	];
	for (const [read, said] of cases) {
		const h = harness({ running: false, unit: true });
		h.deps.readTokens = () => read;
		assert.equal(await runConsoleOpen([], h.deps), 2, String(said));
		assert.deepEqual([h.calls, h.rows], [[], []], String(said));
		assert.match(h.lines.join(""), said);
	}
});

test("an entry kept for an unknown role is passed through, so the admin can explain it (issue #761)", async () => {
	const h = harness();
	h.deps.readTokens = () => ({ file: { tokens: [{ name: "a", role: "operator" }], carry: { kept: [{ name: "kept", role: "auditor" }] } } });
	await runConsoleOpen(["--name", "kept"], h.deps);
	assert.deepEqual(h.calls[0].slice(-2), ["--name", "kept"]);
});

test("a shell PI_LOGS_DIR differing from the deployment's would split the audit chain, so it is refused", async () => {
	const h = harness();
	h.deps.env = { PI_LOGS_DIR: "/elsewhere" };
	assert.equal(await runConsoleOpen([], h.deps), 2);
	assert.deepEqual(h.calls, []);
});

test("a typo costs nothing: bad values are refused before a service starts or a row is written", async () => {
	for (const argv of [["--next", "/evil"], ["--port", "abc"], ["--port", "99999"], ["--port", "0"], ["--deployment="], ["--name", "nobody"]]) {
		const h = harness({ running: false, unit: true });
		h.deps.readTokens = () => ({ file: { tokens: [{ name: "rob", role: "operator" }] } });
		assert.equal(await runConsoleOpen(argv, h.deps), 2, argv.join(" "));
		assert.deepEqual([h.calls, h.rows], [[], []], argv.join(" "));
	}
});

test("every console setting that differs from the deployment's is refused, not only the address", async () => {
	const h = harness();
	h.deps.env = { PI_CONSOLE_TOKENS_FILE: "/elsewhere/tokens.json" };
	assert.equal(await runConsoleOpen([], h.deps), 2);
	assert.deepEqual(h.calls, []);
});

test("the real lookup finds only this deployment's unit: another's is not started", async () => {
	const h = harness({ running: false });
	delete h.deps.consoleUnit;
	const units = join(h.cwd, ".config", "systemd", "user");
	fs.mkdirSync(units, { recursive: true });
	fs.writeFileSync(join(units, "pi-dispatch-console.service"), "[Service]\nWorkingDirectory=/srv/someone-else\n");
	assert.equal(await runConsoleOpen([], h.deps), 2);
	assert.deepEqual(h.calls, []);
	fs.writeFileSync(join(units, "pi-dispatch-console.service"), `[Service]\nWorkingDirectory=${h.cwd}\n`);
	assert.equal(await runConsoleOpen([], h.deps), 0);
	assert.deepEqual(h.calls.map((row) => row[0]), ["service", "open"]);
});

test("from elsewhere, the commands it names are absolute; nothing relative is offered where it would not work", async () => {
	const h = harness({ running: false });
	fs.mkdirSync(join(h.cwd, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(join(h.cwd, "node_modules", ".bin", "pi-dispatch-console"), "");
	const elsewhere = fs.realpathSync(tempDir("console-open-other-"));
	await runConsoleOpen(["--deployment", h.cwd], { ...h.deps, cwd: elsewhere });
	assert.ok(h.lines.join("").includes(`${h.cwd}/node_modules/.bin/pi-dispatch-console serve`), h.lines.join(""));
});

test("a file someone else put at ./pi-dispatch is never offered as the command", async () => {
	const h = harness({ running: false });
	fs.mkdirSync(join(h.cwd, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(join(h.cwd, "node_modules", ".bin", "pi-dispatch"), "");
	fs.writeFileSync(join(h.cwd, "pi-dispatch"), "someone's script");
	await runConsoleOpen([], h.deps);
	assert.match(h.lines.join(""), /Run \.\/node_modules\/\.bin\/pi-dispatch up --console/);
});

test("the command is routed by the worker's own main", async () => {
	const { main } = await import("../src/cli.mjs");
	assert.equal(await main(["console", "--help"], {}), 0, "an unrouted command would be refused as unknown");
});

test("what it tells someone to run exists where they are standing", async () => {
	const h = harness({ running: false });
	fs.mkdirSync(join(h.cwd, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(join(h.cwd, "node_modules", ".bin", "pi-dispatch-console"), "");
	fs.writeFileSync(join(h.cwd, "node_modules", ".bin", "pi-dispatch"), "");
	fs.symlinkSync(join("node_modules", ".bin", "pi-dispatch"), join(h.cwd, "pi-dispatch"));
	await runConsoleOpen([], h.deps);
	assert.match(h.lines.join(""), /Run \.\/pi-dispatch up --console/);
	assert.match(h.lines.join(""), /\.\/node_modules\/\.bin\/pi-dispatch-console serve/);
});
