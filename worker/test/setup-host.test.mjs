import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { tempDir } from "./helpers/temp-dir.mjs";
import { runSetupHost, runSetupHostCli } from "../src/setup-host.mjs";
import { SETUP_OPERATIONS, SETUP_EFFECTS, validSetupRequest, validSetupResult } from "../src/setup-contract.mjs";
import { resolveSetupWorkerEntry } from "../src/setup-host-entry.mjs";

const id = "a".repeat(32);
const request = (operation, phase = "plan", rest = {}) => ({ version: 1, id, phase, operation, ...rest });
function host(text = "PI_PROVIDER=anthropic\nANTHROPIC_API_KEY=\n") {
	const cwd = fs.realpathSync(tempDir("setup-host-"));
	fs.writeFileSync(join(cwd, ".env"), text, { mode: 0o600 });
	return { cwd, home: cwd, env: {}, platform: "linux", uid: process.getuid(), account: "operator", hostname: () => "host1", resolveEntry: () => ({ entry: "/opt/worker/src/cli.mjs", version: "4.3.1" }), providerCandidates: async () => ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] };
}

test("setup protocol rejects unregistered commands/fields, cross-component results and private output", () => {
	assert.equal(validSetupRequest(request("setup-doctor")), true);
	for (const bad of [{ path: "/tmp" }, { command: "echo" }, { input: { value: "secret" } }, { version: 2 }, { phase: "shell" }, { operation: "up" }]) assert.equal(validSetupRequest({ ...request("setup-doctor"), ...bad }), false);
	const result = { version: 1, id, operation: "setup-doctor", state: "planned", reason: "ready", plan: { digest: "b".repeat(64), component: "doctor", manager: "systemd", host: "h", account: "u", effects: ["publish-doctor"] } };
	assert.equal(validSetupResult(result), true);
	for (const bad of [{ ...result, stderr: "secret" }, { ...result, plan: { ...result.plan, component: "worker" } }, { ...result, plan: { ...result.plan, account: "" } }, { ...result, plan: { ...result.plan, effects: ["publish-doctor", "publish-doctor"] } }]) assert.equal(validSetupResult(bad), false);
	assert.equal(new Set(SETUP_OPERATIONS).size, SETUP_OPERATIONS.length);
	assert.equal(new Set(SETUP_EFFECTS).size, SETUP_EFFECTS.length);
});

test("API-key plan writes nothing; confirm writes only its canonical slot and never returns the secret", async () => {
	const deps = host("PI_PROVIDER=anthropic\nANTHROPIC_API_KEY=\nUNRELATED=keep-me\n");
	const path = join(deps.cwd, ".env");
	const before = fs.readFileSync(path, "utf8");
	const p = await runSetupHost(request("setup-provider-key", "plan", { input: { key: "ANTHROPIC_API_KEY" } }), deps);
	assert.equal(p.state, "planned");
	assert.equal(p.plan.key, "ANTHROPIC_API_KEY");
	assert.equal(fs.readFileSync(path, "utf8"), before);
	const result = await runSetupHost(request("setup-provider-key", "apply", { expected: p.plan.digest, input: { key: p.plan.key, value: "private-example-key" } }), deps);
	assert.equal(result.state, "applied");
	assert.match(fs.readFileSync(path, "utf8"), /ANTHROPIC_API_KEY=private-example-key/);
	assert.match(fs.readFileSync(path, "utf8"), /UNRELATED=keep-me/);
	assert.equal(JSON.stringify(result).includes("private-example-key"), false);
	assert.equal(fs.statSync(path).mode & 0o077, 0);
	assert.equal(fs.existsSync(join(deps.cwd, ".pi-dispatch-setup.lock")), false);
});

test("API-key refusals preserve bytes: stale input, unsafe file, unsupported slot and precedence conflicts", async () => {
	for (const [text, input, env, reason] of [
		["ANTHROPIC_API_KEY=already\n", {}, {}, "key-present"],
		["ANTHROPIC_API_KEY=\nANTHROPIC_API_KEY=\n", {}, {}, "env-unsafe"],
		["ANTHROPIC_AUTH_TOKEN=bearer\n", {}, {}, "provider-shadowed"],
		["PI_AUTH_CONNECTIONS_FILE=connections.json\n", {}, {}, "env-unsafe"],
		["", { key: "ANTHROPIC_AUTH_TOKEN" }, {}, "provider-unsupported"],
		["", {}, { ANTHROPIC_API_KEY: "parent-secret" }, "provider-shadowed"],
	]) {
		const deps = { ...host(text), env };
		const got = await runSetupHost(request("setup-provider-key", "plan", { input }), deps);
		assert.equal(got.reason, reason);
		assert.equal(fs.readFileSync(join(deps.cwd, ".env"), "utf8"), text);
	}
	const deps = host();
	const p = await runSetupHost(request("setup-provider-key"), deps);
	fs.appendFileSync(join(deps.cwd, ".env"), "OTHER=changed\n");
	assert.equal((await runSetupHost(request("setup-provider-key", "apply", { expected: p.plan.digest, input: { value: "new-key" } }), deps)).reason, "plan-stale");
	fs.chmodSync(join(deps.cwd, ".env"), 0o644);
	assert.equal((await runSetupHost(request("setup-provider-key"), deps)).reason, "env-unsafe");
});

test("key values cannot introduce commands/OAuth/control bytes or exceed the bound", async () => {
	const deps = host();
	const p = await runSetupHost(request("setup-provider-key"), deps);
	for (const value of [" ", "!command", "$SECRET", "`id`", "a\nb", "sk-ant-oat-subscription", "x".repeat(4097)]) {
		const result = await runSetupHost(request("setup-provider-key", "apply", { expected: p.plan.digest, input: { value } }), deps);
		assert.equal(result.reason, "key-invalid");
	}
	assert.equal(fs.readFileSync(join(deps.cwd, ".env"), "utf8"), "PI_PROVIDER=anthropic\nANTHROPIC_API_KEY=\n");
});

test("provider selection follows the validated settings overlay and specific subscription binding", async () => {
	const deps = host("PI_PROVIDER=anthropic\nPI_SETTINGS_FILE=settings.json\nPI_AUTH_CONNECTIONS_FILE=connections.json\n");
	deps.providerCandidates = async (provider) => provider === "openai" ? ["OPENAI_API_KEY"] : ["ANTHROPIC_API_KEY"];
	fs.writeFileSync(join(deps.cwd, "settings.json"), JSON.stringify({ provider: "openai" }));
	fs.writeFileSync(join(deps.cwd, "connections.json"), JSON.stringify({ version: 1, connections: [{ id: "claude", provider: "anthropic", adapter: "pi-claude-oauth@0.4.2", ownerHost: "host1" }], bindings: { anthropic: "claude" } }));
	// Use the canonical parser's current supported adapter rather than duplicating its catalog in this fixture.
	const { COMMUNITY_AUTH_ADAPTERS } = await import("../src/community-auth-adapters.mjs");
	const adapter = Object.keys(COMMUNITY_AUTH_ADAPTERS).find((name) => COMMUNITY_AUTH_ADAPTERS[name].provider === "anthropic");
	const row = COMMUNITY_AUTH_ADAPTERS[adapter];
	fs.writeFileSync(join(deps.cwd, "connections.json"), JSON.stringify({ version: 1, connections: [{ id: "claude", provider: "anthropic", adapter, ownerHost: "host1", ...(row.community ? { root: "/opt/adapter", digest: "a".repeat(64) } : {}) }], bindings: { anthropic: "claude" } }));
	const p = await runSetupHost(request("setup-provider-key"), deps);
	assert.equal(p.state, "planned");
	assert.equal(p.plan.provider, "openai");
	assert.equal(p.plan.key, "OPENAI_API_KEY");
	fs.writeFileSync(join(deps.cwd, "settings.json"), JSON.stringify({ provider: "anthropic" }));
	assert.equal((await runSetupHost(request("setup-provider-key"), deps)).reason, "provider-managed");
	fs.writeFileSync(join(deps.cwd, "settings.json"), JSON.stringify({ provider: "openai", maxTurns: 2 }));
	assert.equal((await runSetupHost(request("setup-provider-key", "apply", { expected: p.plan.digest, input: { value: "do-not-save" } }), deps)).reason, "plan-stale");
});

test("readiness identity is the configured worker name rather than the machine hostname", async () => {
	const deps = host("PI_WORKER_NAME=registered-worker\n");
	deps.servicePlan = async () => ({ effects: ["start-worker"], active: false });
	const p = await runSetupHost(request("setup-worker-start"), deps);
	assert.equal(p.plan.host, "host1");
	assert.equal(p.plan.workerName, "registered-worker");
});

test("provider settings and policy snapshots refuse writable ancestors and a final-file swap before open", async () => {
	for (const key of ["PI_SETTINGS_FILE", "PI_AUTH_CONNECTIONS_FILE"]) {
		const deps = host(`${key}=source/config.json\n`);
		const source = join(deps.cwd, "source");
		fs.mkdirSync(source, { mode: 0o777 });
		fs.chmodSync(source, 0o777);
		fs.writeFileSync(join(source, "config.json"), key === "PI_SETTINGS_FILE" ? "{}" : JSON.stringify({ version: 1, connections: [], bindings: {} }));
		assert.equal((await runSetupHost(request("setup-provider-key"), deps)).reason, "env-unsafe", key);
		fs.chmodSync(source, 0o700);
		const path = join(source, "config.json");
		const replacement = join(deps.cwd, "replacement.json");
		fs.writeFileSync(replacement, fs.readFileSync(path));
		let swapped = false;
		const raceFs = { ...fs, openSync(file, flags, ...rest) {
			if (file === path && !swapped) { swapped = true; fs.unlinkSync(path); fs.symlinkSync(replacement, path); }
			return fs.openSync(file, flags, ...rest);
		} };
		assert.equal((await runSetupHost(request("setup-provider-key"), { ...deps, fs: raceFs })).reason, "env-unsafe", key);
		assert.equal(swapped, true);
		assert.equal(fs.readFileSync(join(deps.cwd, ".env"), "utf8"), `${key}=source/config.json\n`);
	}
});

test("the final rename check catches a change made while its temporary file is written", async () => {
	const deps = host();
	const p = await runSetupHost(request("setup-provider-key"), deps);
	let raced = false;
	const path = join(deps.cwd, ".env");
	const raceFs = { ...fs, closeSync(fd) {
		fs.closeSync(fd);
		if (!raced && fs.existsSync(`${path}.tmp`)) { raced = true; fs.appendFileSync(path, "OTHER=concurrent\n"); }
	} };
	const result = await runSetupHost(request("setup-provider-key", "apply", { expected: p.plan.digest, input: { value: "do-not-save" } }), { ...deps, fs: raceFs });
	assert.equal(raced, true);
	assert.equal(result.reason, "plan-stale");
	assert.match(fs.readFileSync(path, "utf8"), /OTHER=concurrent/);
	assert.equal(fs.readFileSync(path, "utf8").includes("do-not-save"), false);
	assert.equal(fs.existsSync(`${path}.tmp`), false);
});

test("service confirm rechecks the actual plan and serializes concurrent effects", async () => {
	const deps = host();
	let active = false, release, entered;
	const started = new Promise((done) => { entered = done; });
	const plan = () => ({ effects: ["start-worker"], before: "unit", active });
	Object.assign(deps, { servicePlan: async () => plan(), runService: async () => { entered(); await new Promise((done) => { release = done; }); active = true; return 0; } });
	const p = await runSetupHost(request("setup-worker-start"), deps);
	const apply = request("setup-worker-start", "apply", { expected: p.plan.digest });
	const pending = runSetupHost(apply, deps);
	await started;
	assert.equal((await runSetupHost(apply, deps)).reason, "setup-busy");
	release();
	assert.equal((await pending).state, "applied");
	assert.equal((await runSetupHost(apply, deps)).reason, "plan-stale");
});

test("lost service readback reports uncertainty instead of a false no-change/success", async () => {
	const deps = host();
	let dispatched = false;
	Object.assign(deps, { servicePlan: async () => dispatched ? { refusal: "unavailable" } : { effects: ["start-worker"], before: "unit", active: false }, runService: async () => { dispatched = true; return 1; } });
	const p = await runSetupHost(request("setup-worker-start"), deps);
	const got = await runSetupHost(request("setup-worker-start", "apply", { expected: p.plan.digest }), deps);
	assert.equal(got.state, "unknown");
	assert.equal(got.reason, "process-failed");
});

test("fixed stdin CLI rejects excess input and unknown fields, emits typed JSON only", async () => {
	const deps = host();
	let out = "";
	assert.equal(await runSetupHostCli({ ...deps, input: Readable.from([JSON.stringify(request("setup-provider-key"))]), out: (value) => { out += value; } }), 0);
	assert.equal(validSetupResult(JSON.parse(out)), true);
	for (const text of ["{", "x".repeat(65537), JSON.stringify({ ...request("setup-doctor"), argv: ["bad"] })]) {
		out = "";
		assert.equal(await runSetupHostCli({ ...deps, input: Readable.from([text]), out: (value) => { out += value; } }), 2);
		assert.equal(out, "");
	}
});

test("the durable entry resolver accepts the worker artifact and refuses disposable cache targets", () => {
	assert.ok(resolveSetupWorkerEntry().entry.endsWith("/worker/src/cli.mjs"));
	const base = tempDir("setup-entry-");
	const root = join(base, "_npx", "123", "worker");
	fs.mkdirSync(join(root, "src"), { recursive: true });
	fs.writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@edgehero/pi-dispatch", version: "4.3.1" }));
	fs.writeFileSync(join(root, "src", "cli.mjs"), "");
	assert.equal(resolveSetupWorkerEntry({ entry: join(root, "src", "cli.mjs") }).refusal, "unsafe-entry");
	const durable = join(base, "durable");
	fs.mkdirSync(join(durable, "src"), { recursive: true });
	fs.writeFileSync(join(durable, "package.json"), JSON.stringify({ name: "@edgehero/pi-dispatch", version: "4.3.1" }));
	const entry = join(durable, "src", "cli.mjs"); fs.writeFileSync(entry, "");
	assert.ok(resolveSetupWorkerEntry({ entry }).entry);
	fs.chmodSync(join(durable, "src"), 0o777);
	assert.equal(resolveSetupWorkerEntry({ entry }).refusal, "unsafe-entry");
	fs.chmodSync(join(durable, "src"), 0o755);
	fs.chmodSync(join(durable, "package.json"), 0o666);
	assert.equal(resolveSetupWorkerEntry({ entry }).refusal, "unsafe-entry");
});
