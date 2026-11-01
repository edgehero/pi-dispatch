import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { planServiceSetup, runService } from "../src/service.mjs";

function service() {
	const home = fs.realpathSync(tempDir("setup-service-"));
	const cwd = join(home, "deployment");
	fs.mkdirSync(cwd);
	fs.writeFileSync(join(cwd, ".env"), "PI_BACKENDS=local\n", { mode: 0o600 });
	const calls = [];
	const deps = { platform: "linux", euid: process.getuid(), home, cwd, fs, env: { USER: "operator" }, out: () => {}, err: () => {}, moduleDir: dirname(fileURLToPath(new URL("../src/cli.mjs", import.meta.url))), spawn(cmd, args) {
		calls.push([cmd, ...args]);
		const child = new EventEmitter();
		child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
		queueMicrotask(() => {
			const path = join(home, ".config", "systemd", "user", "pi-dispatch-worker.service");
			const present = fs.existsSync(path);
			child.stdout.emit("data", args.includes("show") ? present ? `LoadState=loaded\nActiveState=inactive\nFragmentPath=${path}\nDropInPaths=\nWorkingDirectory=${cwd}\nExecStart={ path=${process.execPath} ; argv[]=${process.execPath} ${deps.moduleDir}/cli.mjs worker ; ignore_errors=no ; }\n` : "LoadState=not-found\nActiveState=inactive\n" : "");
			child.emit("close", 0);
		});
		return child;
	} };
	return { deps, calls };
}

function queries(answer) {
	return (_cmd, args) => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
		queueMicrotask(() => { const got = answer(args); child.stdout.emit("data", got.stdout ?? ""); child.emit("close", got.code ?? 0); });
		return child;
	};
}

test("host setup is an explicit console argument on both user managers and absent by default", async () => {
	for (const platform of ["linux", "darwin"]) {
		const { deps } = service();
		let granted = "", plain = "";
		assert.equal(await runService(["render", "--console", "--host-setup"], { ...deps, platform, euid: 501, resolveConsole: () => "/opt/admin/dist/console.mjs", out: (text) => { granted += text; } }), 0);
		assert.match(granted, /--host-setup/);
		assert.equal(await runService(["render", "--console"], { ...deps, platform, euid: 501, resolveConsole: () => "/opt/admin/dist/console.mjs", out: (text) => { plain += text; } }), 0);
		assert.equal(plain.includes("--host-setup"), false);
	}
});

test("host grant is refused for other services/scopes/verbs, Windows and cache-backed entries before changes", async () => {
	for (const argv of [["render", "--host-setup"], ["render", "--receiver", "--host-setup"], ["render", "--console", "--host-setup", "--system"], ["start", "--console", "--host-setup"]]) {
		const { deps, calls } = service();
		assert.notEqual(await runService(argv, { ...deps, resolveConsole: () => "/opt/admin/dist/console.mjs" }), 0);
		assert.deepEqual(calls, []);
	}
	for (const patch of [{ platform: "win32" }, { resolveConsole: () => "/home/user/.npm/_npx/a/admin/dist/console.mjs" }]) {
		const { deps, calls } = service();
		assert.notEqual(await runService(["install", "--console", "--host-setup"], { ...deps, resolveConsole: () => "/opt/admin/dist/console.mjs", ...patch }), 0);
		assert.deepEqual(calls, []);
	}
});

test("service setup planner is a mutation-free real installer plan and checks exact unit identity", async () => {
	const { deps, calls } = service();
	const p = await planServiceSetup(["install"], deps);
	assert.equal(p.refusal, undefined);
	assert.equal(p.before, null);
	assert.deepEqual(p.effects, ["write-worker-unit", "start-worker"]);
	assert.equal(fs.existsSync(p.path), false);
	assert.equal(calls.every((argv) => argv[0] === "systemctl" && (argv.includes("show") || argv.includes("show-environment"))), true);
	fs.mkdirSync(dirname(p.path), { recursive: true });
	fs.writeFileSync(p.path, p.text);
	const start = await planServiceSetup(["start"], deps);
	assert.equal(start.refusal, undefined);
	assert.equal(start.active, false);
	assert.equal((await planServiceSetup(["install"], deps)).refusal, "service-exists");
	fs.appendFileSync(p.path, "\nExecStartPost=/arbitrary-program\n");
	assert.equal((await planServiceSetup(["start"], deps)).refusal, "foreign-service");
});

test("missing receiver is a determinate pre-write refusal", async () => {
	const { deps, calls } = service();
	assert.equal((await planServiceSetup(["install", "--receiver"], { ...deps, resolveReceiver: () => null })).refusal, "missing-receiver");
	assert.deepEqual(calls, []);
});

test("the existing-console bootstrap planner requires its exact granted render and effective systemd command", async () => {
	const { deps } = service();
	const consoleEntry = "/opt/admin/dist/console.mjs";
	const options = { ...deps, setupConsoleGrant: true, resolveConsole: () => consoleEntry };
	const install = await planServiceSetup(["install", "--console", "--host-setup"], options);
	assert.equal(install.refusal, undefined);
	const path = join(deps.home, ".config", "systemd", "user", "pi-dispatch-console.service");
	fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, install.text);
	const base = { LoadState: "loaded", ActiveState: "active", FragmentPath: path, DropInPaths: "", WorkingDirectory: deps.cwd, ExecStart: `{ path=${process.execPath} ; argv[]=${process.execPath} ${consoleEntry} serve --deployment ${deps.cwd} --host-setup ; ignore_errors=no ; }` };
	const planWith = async (overrides = {}) => planServiceSetup(["start", "--console"], { ...options, spawn: queries(args => ({ stdout: args.includes("show") ? Object.entries({ ...base, ...overrides }).map(([key, value]) => `${key}=${value}`).join("\n") : "" })) });
	assert.equal((await planWith()).refusal, undefined);
	for (const overrides of [{ DropInPaths: "/other.conf" }, { WorkingDirectory: deps.home }, { FragmentPath: join(deps.home, "other.service") }, { ExecStart: base.ExecStart.replace("serve --deployment", "other-command --deployment") }]) assert.equal((await planWith(overrides)).refusal, "foreign-service");
	fs.appendFileSync(path, "\nExecStartPost=/other-command # --host-setup\n");
	assert.equal((await planWith()).refusal, "foreign-service", "preserving the entry and grant as substrings is insufficient");
});

test("launchd setup compares the loaded job with its plist and refuses cached foreign jobs even without a plist", async () => {
	const { deps } = service();
	const options = { ...deps, platform: "darwin" };
	const p = await planServiceSetup(["install"], { ...options, spawn: queries(args => ({ code: args[1]?.includes("/com.pi-dispatch.worker") ? 113 : 0 })) });
	assert.equal(p.refusal, undefined);
	fs.mkdirSync(dirname(p.path), { recursive: true }); fs.writeFileSync(p.path, p.text);
	const wrapper = join(deps.moduleDir, "..", "deploy", "worker-env-wrapper.sh");
	const argv = ["/bin/sh", wrapper, process.execPath, join(deps.moduleDir, "cli.mjs"), "worker"];
	const loaded = (extra = "") => `path = ${p.path}\nstate = running\nworking directory = ${deps.cwd}\narguments = {\n${argv.join("\n")}\n}\n${extra}`;
	const planWith = (text) => planServiceSetup(["start"], { ...options, spawn: queries(args => ({ stdout: args[1]?.includes("/com.pi-dispatch.worker") ? text : "" })) });
	assert.equal((await planWith(loaded())).refusal, undefined);
	assert.equal((await planWith(loaded().replace("\nworker\n", "\nforeign\n"))).refusal, "foreign-service");
	fs.unlinkSync(p.path);
	assert.equal((await planServiceSetup(["install"], { ...options, spawn: queries(args => ({ stdout: args[1]?.includes("/com.pi-dispatch.worker") ? loaded() : "" })) })).refusal, "foreign-service");
});
