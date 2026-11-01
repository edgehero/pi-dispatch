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
	return { cwd, home: cwd, env: {}, platform: "linux", uid: process.getuid(), account: "operator", hostname: () => "host1", resolveEntry: () => ({ entry: "/opt/worker/src/cli.mjs", version: "4.3.1" }), providerNames: async () => ["anthropic", "openai"], providerCandidates: async (provider) => provider === "anthropic" ? ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] : ["OPENAI_API_KEY"] };
}

async function pinnedProviders(deps) {
	const { piProviders, providerKeyCandidates } = await import("../src/env-allowlist.mjs");
	return { ...deps, providerNames: async () => piProviders(), providerCandidates: async (provider) => providerKeyCandidates(provider) };
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
	for (const value of [" ", "!command", "$SECRET", "`id`", "a b", "a\nb", "sk-ant-oat-subscription", "x".repeat(4097)]) {
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

test("selected-provider Add preserves every other key and the effective default; previews cannot retarget a shared slot", async () => {
	const deps = await pinnedProviders(host("PI_PROVIDER=anthropic\nANTHROPIC_API_KEY=existing-anthropic\nPI_SETTINGS_FILE=settings.json\nUNRELATED=preserve\n"));
	const path = join(deps.cwd, ".env");
	const settings = JSON.stringify({ provider: "anthropic", maxTurns: 7 });
	fs.writeFileSync(join(deps.cwd, "settings.json"), settings);
	for (const [provider, key] of [["openai", "OPENAI_API_KEY"], ["deepseek", "DEEPSEEK_API_KEY"]]) {
		const p = await runSetupHost(request("setup-provider-key", "plan", { input: { provider } }), deps);
		assert.equal(p.state, "planned");
		assert.equal(p.plan.provider, provider);
		assert.equal(p.plan.key, key);
		assert.equal(p.plan.mode, "add");
		assert.equal(p.plan.source, "none");
		assert.equal(validSetupResult(p), true);
		const result = await runSetupHost(request("setup-provider-key", "apply", { expected: p.plan.digest, input: { provider, value: `private-${provider}` } }), deps);
		assert.equal(result.state, "applied");
	}
	const after = fs.readFileSync(path, "utf8");
	assert.match(after, /PI_PROVIDER=anthropic\nANTHROPIC_API_KEY=existing-anthropic\nPI_SETTINGS_FILE=settings.json\nUNRELATED=preserve\n/);
	assert.match(after, /OPENAI_API_KEY=private-openai\nDEEPSEEK_API_KEY=private-deepseek\n/);
	assert.equal(fs.readFileSync(join(deps.cwd, "settings.json"), "utf8"), settings);
	const p = await runSetupHost(request("setup-provider-key", "plan", { input: { provider: "moonshotai" } }), deps);
	assert.deepEqual(p.plan.aliases, ["moonshotai", "moonshotai-cn"]);
	const swapped = await runSetupHost(request("setup-provider-key", "apply", { expected: p.plan.digest, input: { provider: "moonshotai-cn", value: "do-not-save" } }), deps);
	assert.equal(swapped.reason, "plan-stale", "the selected provider is bound even when two providers share the same key name");
	assert.equal(fs.readFileSync(path, "utf8"), after);
});

test("provider selection and alias groups are derived exhaustively from the actual pinned mapping", async () => {
	const deps = await pinnedProviders(host("PI_AUTH_FROM_PI=0\n"));
	const { apiKeyVariable, needsHostAuthentication, nonApiKeyKind } = await import("../src/provider-key.mjs");
	const names = await deps.providerNames();
	for (const provider of names) {
		const key = apiKeyVariable(await deps.providerCandidates(provider));
		const p = await runSetupHost(request("setup-provider-key", "plan", { input: { provider } }), deps);
		if (needsHostAuthentication(provider)) { assert.equal(p.reason, "provider-host-auth", provider); continue; }
		if (!key || nonApiKeyKind(key) !== null) { assert.equal(p.reason, "provider-unsupported", provider); continue; }
		const expected = [];
		for (const name of names) if (apiKeyVariable(await deps.providerCandidates(name)) === key) expected.push(name);
		assert.equal(p.state, "planned", provider);
		assert.deepEqual(p.plan.aliases, expected.sort(), provider);
		assert.equal(p.plan.key, key, provider);
	}
	const unchanged = fs.readFileSync(join(deps.cwd, ".env"), "utf8");
	for (const provider of ["__proto__", "constructor", "unknown-custom-provider"]) for (const operation of ["setup-provider-key", "setup-provider-key-replace"]) {
		assert.equal((await runSetupHost(request(operation, "plan", { input: { provider } }), deps)).reason, "provider-unsupported");
		assert.equal((await runSetupHost(request(operation, "apply", { expected: "f".repeat(64), input: { provider, value: "unknown-route-never-written" } }), deps)).reason, "provider-unsupported");
		assert.equal(fs.readFileSync(join(deps.cwd, ".env"), "utf8"), unchanged);
	}
});

test("every browser-eligible pinned provider round-trips Add and Replace through the real job credential resolver", async t => {
	const { piProviders, providerKeyCandidates, resolveProviderCredential } = await import("../src/env-allowlist.mjs");
	const { apiKeyVariable, needsHostAuthentication, nonApiKeyKind } = await import("../src/provider-key.mjs");
	const { deploymentServiceEnv } = await import("../src/service-env.mjs");
	const names = piProviders().sort();
	const eligible = names.filter(provider => {
		const key = apiKeyVariable(providerKeyCandidates(provider));
		return key !== null && nonApiKeyKind(key) === null && !needsHostAuthentication(provider);
	});
	const variables = [...new Set(names.flatMap(providerKeyCandidates))];
	assert.ok(eligible.length > 0, "the exhaustive round trip cannot pass without exercising a provider");
	for (const provider of eligible) await t.test(provider, async () => {
		const key = apiKeyVariable(providerKeyCandidates(provider));
		const otherKey = key === "ANTHROPIC_API_KEY" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
		const base = `# retained deployment context\nPI_AUTH_FROM_PI=0\nPI_PROVIDER=anthropic\nPI_MODEL=retained-default-model\nPI_SETTINGS_FILE=settings.json\nPI_TRIGGERS_FILE=triggers.json\nPI_AUTH_CONNECTIONS_FILE=connections.json\nPI_ALLOWED_MODELS=anthropic/retained-default-model\nPI_MAX_COST_USD=2\nPI_EGRESS=1\nUNRELATED=preserve-exactly\n${otherKey}=unrelated-private-value\n`;
		const deps = await pinnedProviders(host(base));
		const envPath = join(deps.cwd, ".env");
		const files = {
			"settings.json": JSON.stringify({ provider: "anthropic", model: "retained-overlay-model", maxTurns: 7 }),
			"triggers.json": JSON.stringify({ triggers: [], modelRoles: { default: { code: "anthropic/retained-role-model" } } }),
			// A declared but unbound connection must not block an unrelated API-key route or be rewritten.
			"connections.json": JSON.stringify({ version: 1, connections: [{ id: "unused-chatgpt", provider: "openai", adapter: "openai-chatgpt", ownerHost: "host1" }], bindings: {} }),
		};
		for (const [file, text] of Object.entries(files)) fs.writeFileSync(join(deps.cwd, file), text, { mode: 0o600 });
		const aliases = names.filter(name => apiKeyVariable(providerKeyCandidates(name)) === key).sort();
		const first = `private-add-${provider}`;
		const replacement = `private-replace-${provider}`;
		const plan = await runSetupHost(request("setup-provider-key", "plan", { input: { provider } }), deps);
		assert.equal(plan.state, "planned");
		assert.equal(validSetupResult(plan), true);
		assert.equal(plan.plan.provider, provider);
		assert.equal(plan.plan.key, key);
		assert.equal(plan.plan.mode, "add");
		assert.equal(plan.plan.source, "none");
		assert.deepEqual(plan.plan.aliases, aliases);
		assert.equal(fs.readFileSync(envPath, "utf8"), base, "Add planning does not write");
		const added = await runSetupHost(request("setup-provider-key", "apply", { expected: plan.plan.digest, input: { provider, value: first } }), deps);
		assert.equal(added.state, "applied");
		assert.equal(validSetupResult(added), true);
		assert.equal(fs.readFileSync(envPath, "utf8"), `${base}${key}=${first}\n`, "Add changes only the selected canonical slot");
		const resolveWritten = expected => {
			const loaded = deploymentServiceEnv({ env: {}, dir: deps.cwd, keys: variables, fs, uid: deps.uid, platform: deps.platform });
			assert.equal(loaded.unreadable, null);
			assert.equal(loaded.untrusted, null);
			assert.deepEqual(loaded.unread, []);
			for (const name of aliases) assert.deepEqual(resolveProviderCredential({ provider: name, hostEnv: loaded.env, authFromPi: false, agentDir: join(deps.cwd, "agent"), readFile() { assert.fail("a saved environment key must not fall back to any host credential store"); } }), { [key]: expected }, `${name} resolves the saved slot without another provider's key`);
		};
		resolveWritten(first);
		assert.equal((await runSetupHost(request("setup-provider-key", "plan", { input: { provider } }), deps)).reason, "key-present", "Add never becomes an upsert");
		const replace = await runSetupHost(request("setup-provider-key-replace", "plan", { input: { provider } }), deps);
		assert.equal(replace.state, "planned");
		assert.equal(validSetupResult(replace), true);
		assert.equal(replace.plan.provider, provider);
		assert.equal(replace.plan.key, key);
		assert.equal(replace.plan.mode, "replace");
		assert.equal(replace.plan.source, "deployment-env");
		assert.deepEqual(replace.plan.aliases, aliases);
		assert.equal(fs.readFileSync(envPath, "utf8"), `${base}${key}=${first}\n`, "Replace planning preserves the old value");
		const replaced = await runSetupHost(request("setup-provider-key-replace", "apply", { expected: replace.plan.digest, input: { provider, value: replacement } }), deps);
		assert.equal(replaced.state, "applied");
		assert.equal(validSetupResult(replaced), true);
		assert.equal(fs.readFileSync(envPath, "utf8"), `${base}${key}=${replacement}\n`, "Replace preserves unrelated/default/model/budget/egress declarations byte for byte");
		resolveWritten(replacement);
		for (const [file, text] of Object.entries(files)) assert.equal(fs.readFileSync(join(deps.cwd, file), "utf8"), text, `${file} stays byte identical`);
		assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
		assert.equal(fs.existsSync(`${envPath}.tmp`), false);
		assert.equal(fs.existsSync(join(deps.cwd, ".pi-dispatch-setup.lock")), false);
		const replies = JSON.stringify([plan, added, replace, replaced]);
		assert.equal(replies.includes(first), false);
		assert.equal(replies.includes(replacement), false);
	});
});

test("host-auth routes cannot paste tokens through Add or Replace, while a pinned Hugging Face API token remains eligible", async () => {
	const { HOST_AUTH_PROVIDERS } = await import("../src/provider-key.mjs");
	for (const provider of HOST_AUTH_PROVIDERS) {
		const deps = await pinnedProviders(host("PI_AUTH_FROM_PI=0\nCOPILOT_GITHUB_TOKEN=old-token\n"));
		const before = fs.readFileSync(join(deps.cwd, ".env"), "utf8");
		for (const operation of ["setup-provider-key", "setup-provider-key-replace"]) {
			const p = await runSetupHost(request(operation, "plan", { input: { provider } }), deps);
			assert.equal(p.reason, "provider-host-auth", provider);
			const direct = await runSetupHost(request(operation, "apply", { expected: "f".repeat(64), input: { provider, value: "raw-token-never-written" } }), deps);
			assert.equal(direct.reason, "provider-host-auth", provider);
		}
		assert.equal(fs.readFileSync(join(deps.cwd, ".env"), "utf8"), before);
	}
	const deps = await pinnedProviders(host("PI_AUTH_FROM_PI=0\n"));
	const p = await runSetupHost(request("setup-provider-key", "plan", { input: { provider: "huggingface" } }), deps);
	assert.equal(p.plan.key, "HF_TOKEN");
	assert.equal((await runSetupHost(request("setup-provider-key", "apply", { expected: p.plan.digest, input: { provider: "huggingface", value: "hf-private-key" } }), deps)).state, "applied");
	assert.match(fs.readFileSync(join(deps.cwd, ".env"), "utf8"), /HF_TOKEN=hf-private-key/);
});

test("Add and Replace have distinct preconditions; replacing a shared slot updates only that slot", async () => {
	for (const line of ["", "OPENAI_API_KEY=\n"]) {
		const deps = await pinnedProviders(host(`PI_PROVIDER=anthropic\n${line}`));
		assert.equal((await runSetupHost(request("setup-provider-key-replace", "plan", { input: { provider: "openai" } }), deps)).reason, "key-missing");
	}
	const text = "PI_PROVIDER=anthropic\nANTHROPIC_API_KEY=unrelated-private\nMOONSHOT_API_KEY=old-private\nUNRELATED=keep\n";
	const deps = await pinnedProviders(host(text));
	const path = join(deps.cwd, ".env");
	assert.equal((await runSetupHost(request("setup-provider-key", "plan", { input: { provider: "moonshotai-cn" } }), deps)).reason, "key-present");
	const p = await runSetupHost(request("setup-provider-key-replace", "plan", { input: { provider: "moonshotai-cn" } }), deps);
	assert.equal(p.plan.mode, "replace"); assert.equal(p.plan.source, "deployment-env");
	assert.deepEqual(p.plan.aliases, ["moonshotai", "moonshotai-cn"]);
	assert.equal(validSetupResult(p), true);
	for (const change of [{ mode: "add" }, { source: "none" }, { aliases: [] }, { aliases: ["moonshotai-cn", "moonshotai-cn"] }]) assert.equal(validSetupResult({ ...p, plan: { ...p.plan, ...change } }), false);
	assert.equal(JSON.stringify(p).includes("old-private"), false);
	assert.equal(fs.readFileSync(path, "utf8"), text, "preview never replaces the key");
	const result = await runSetupHost(request("setup-provider-key-replace", "apply", { expected: p.plan.digest, input: { provider: "moonshotai-cn", value: "new-private" } }), deps);
	assert.equal(result.state, "applied");
	assert.equal(fs.readFileSync(path, "utf8"), text.replace("MOONSHOT_API_KEY=old-private", "MOONSHOT_API_KEY=new-private"));
	assert.equal(fs.statSync(path).mode & 0o777, 0o600);
	assert.equal(JSON.stringify(result).includes("new-private"), false);
	assert.equal((await runSetupHost(request("setup-provider-key-replace", "apply", { expected: p.plan.digest, input: { provider: "moonshotai-cn", value: "replay" } }), deps)).reason, "plan-stale");
});

test("Replace never restores an old key and refuses every stale source, mode and provider swap", async () => {
	for (const kind of ["changed-file", "same-bytes-new-inode", "changed-default", "changed-mode", "other-provider", "other-operation"]) {
		const text = "PI_PROVIDER=anthropic\nOPENAI_API_KEY=old-openai\nDEEPSEEK_API_KEY=old-deepseek\n";
		const deps = await pinnedProviders(host(text));
		const path = join(deps.cwd, ".env");
		const p = await runSetupHost(request("setup-provider-key-replace", "plan", { input: { provider: "openai" } }), deps);
		if (kind === "changed-file") fs.appendFileSync(path, "OTHER=concurrent\n");
		if (kind === "same-bytes-new-inode") { fs.renameSync(path, `${path}.before`); fs.writeFileSync(path, text, { mode: 0o600 }); }
		if (kind === "changed-default") fs.writeFileSync(path, text.replace("PI_PROVIDER=anthropic", "PI_PROVIDER=deepseek"));
		if (kind === "changed-mode") fs.chmodSync(path, 0o644);
		const before = fs.readFileSync(path, "utf8");
		const got = await runSetupHost(request(kind === "other-operation" ? "setup-provider-key" : "setup-provider-key-replace", "apply", { expected: p.plan.digest, input: { provider: kind === "other-provider" ? "deepseek" : "openai", value: "do-not-save" } }), deps);
		assert.equal(got.state, "refused", kind);
		assert.equal(fs.readFileSync(path, "utf8"), before, kind);
	}
});

test("replacement checks the selected managed provider and refuses inherited or bearer/OAuth shadowing", async () => {
	for (const operation of ["setup-provider-key", "setup-provider-key-replace"]) {
		for (const extra of ["ANTHROPIC_AUTH_TOKEN=bearer\n", "ANTHROPIC_OAUTH_TOKEN=oauth\n"]) {
			const deps = await pinnedProviders(host(`ANTHROPIC_API_KEY=${operation.endsWith("replace") ? "old-key" : ""}\n${extra}`));
			assert.equal((await runSetupHost(request(operation, "plan", { input: { provider: "anthropic" } }), deps)).reason, "provider-shadowed");
		}
		const deps = await pinnedProviders(host(`PI_PROVIDER=anthropic\nPI_AUTH_CONNECTIONS_FILE=connections.json\nOPENAI_API_KEY=${operation.endsWith("replace") ? "old-key" : ""}\n`));
		fs.writeFileSync(join(deps.cwd, "connections.json"), JSON.stringify({ version: 1, connections: [{ id: "chatgpt", provider: "openai", adapter: "openai-chatgpt", ownerHost: "host1" }], bindings: { openai: "chatgpt" } }));
		assert.equal((await runSetupHost(request(operation, "plan", { input: { provider: "openai" } }), deps)).reason, "provider-managed");
		fs.writeFileSync(join(deps.cwd, "connections.json"), JSON.stringify({ version: 1, connections: [], bindings: {} }));
		assert.equal((await runSetupHost(request(operation, "plan", { input: { provider: "openai" } }), { ...deps, env: { OPENAI_API_KEY: "inherited" } })).reason, "provider-shadowed");
	}
});

test("Add identifies an overridden pi API-key fallback without exposing it, and binds that source through rename", async () => {
	const deps = await pinnedProviders(host("PI_PROVIDER=anthropic\nPI_CODING_AGENT_DIR=agent\n"));
	const dir = join(deps.cwd, "agent"); fs.mkdirSync(dir, { mode: 0o700 });
	const path = join(dir, "auth.json");
	const auth = JSON.stringify({ openai: { type: "api_key", key: "private-fallback-canary" }, anthropic: { type: "oauth", access: "private-oauth-canary" } });
	fs.writeFileSync(path, auth, { mode: 0o600 });
	const p = await runSetupHost(request("setup-provider-key", "plan", { input: { provider: "openai" } }), deps);
	assert.equal(p.plan.source, "pi-api-key");
	assert.equal(JSON.stringify(p).includes("private-fallback-canary"), false);
	const other = await runSetupHost(request("setup-provider-key", "plan", { input: { provider: "anthropic" } }), deps);
	assert.equal(other.plan.source, "none", "plain OAuth is not admitted as an API-key fallback");
	let raced = false;
	const envPath = join(deps.cwd, ".env");
	const io = { ...fs, closeSync(fd) {
		fs.closeSync(fd);
		if (!raced && fs.existsSync(`${envPath}.tmp`)) { raced = true; fs.appendFileSync(path, "\n"); }
	} };
	const result = await runSetupHost(request("setup-provider-key", "apply", { expected: p.plan.digest, input: { provider: "openai", value: "do-not-save" } }), { ...deps, fs: io });
	assert.equal(result.reason, "plan-stale");
	assert.equal(fs.readFileSync(envPath, "utf8"), "PI_PROVIDER=anthropic\nPI_CODING_AGENT_DIR=agent\n");
	assert.equal(fs.existsSync(`${envPath}.tmp`), false);
	assert.equal(fs.readFileSync(path, "utf8"), `${auth}\n`, "the credential source is never rewritten by this writer");
});

test("Replace transforms only descriptor-judged bytes and detects a last-moment concurrent edit", async () => {
	for (const kind of ["transient-path-read", "during-temp-write"]) {
		const text = "PI_PROVIDER=anthropic\nOPENAI_API_KEY=old-key\nUNRELATED=original\n";
		const deps = await pinnedProviders(host(text));
		const path = join(deps.cwd, ".env");
		const p = await runSetupHost(request("setup-provider-key-replace", "plan", { input: { provider: "openai" } }), deps);
		let raced = false;
		const io = { ...fs, readFileSync(file, ...args) {
			if (kind === "transient-path-read" && file === path) return Buffer.from(text.replace("UNRELATED=original", "UNRELATED=transient-competing-content"));
			return fs.readFileSync(file, ...args);
		}, closeSync(fd) {
			fs.closeSync(fd);
			if (kind === "during-temp-write" && !raced && fs.existsSync(`${path}.tmp`)) { raced = true; fs.appendFileSync(path, "ARRIVAL=concurrent\n"); }
		} };
		const got = await runSetupHost(request("setup-provider-key-replace", "apply", { expected: p.plan.digest, input: { provider: "openai", value: "new-key" } }), { ...deps, fs: io });
		if (kind === "transient-path-read") {
			assert.equal(got.state, "applied");
			assert.equal(fs.readFileSync(path, "utf8"), text.replace("OPENAI_API_KEY=old-key", "OPENAI_API_KEY=new-key"));
		} else {
			assert.equal(got.reason, "plan-stale");
			assert.equal(fs.readFileSync(path, "utf8"), `${text}ARRIVAL=concurrent\n`);
		}
		assert.equal(fs.existsSync(`${path}.tmp`), false);
	}
});

test("Replace keeps same-value input unchanged and enforces the UTF-8 4 KiB bound", async () => {
	const deps = await pinnedProviders(host("OPENAI_API_KEY=old-key\n"));
	const path = join(deps.cwd, ".env");
	const apply = async (value) => {
		const p = await runSetupHost(request("setup-provider-key-replace", "plan", { input: { provider: "openai" } }), deps);
		return runSetupHost(request("setup-provider-key-replace", "apply", { expected: p.plan.digest, input: { provider: "openai", value } }), deps);
	};
	const before = fs.statSync(path);
	assert.equal((await apply("old-key")).state, "unchanged");
	assert.equal(fs.statSync(path).ino, before.ino);
	assert.equal(fs.statSync(path).mtimeMs, before.mtimeMs);
	for (const value of ["!command", "$KEY", "key`value", "sk-ant-oat-subscription", "a b", "a\nb", "x".repeat(4097), "é".repeat(2049)]) {
		assert.equal((await apply(value)).reason, "key-invalid");
		assert.equal(fs.readFileSync(path, "utf8"), "OPENAI_API_KEY=old-key\n");
	}
	assert.equal((await apply("é".repeat(2048))).state, "applied");
	assert.equal(fs.statSync(path).mode & 0o777, 0o600);
});

test("Add fills a loader-proven empty quoted slot; nonempty literal whitespace still requires Replace", async () => {
	for (const [line, mode] of [["OPENAI_API_KEY=\n", "add"], ["OPENAI_API_KEY=   \n", "add"], ['OPENAI_API_KEY=""\n', "add"], ['OPENAI_API_KEY=" "\n', "replace"], ["OPENAI_API_KEY=setup-preview-placeholder\n", "replace"]]) {
		const deps = await pinnedProviders(host(line));
		const operation = mode === "add" ? "setup-provider-key" : "setup-provider-key-replace";
		if (mode === "replace") assert.equal((await runSetupHost(request("setup-provider-key", "plan", { input: { provider: "openai" } }), deps)).reason, "key-present");
		const p = await runSetupHost(request(operation, "plan", { input: { provider: "openai" } }), deps);
		assert.equal(p.state, "planned", line);
		assert.equal(p.plan.mode, mode);
		assert.equal((await runSetupHost(request(operation, "apply", { expected: p.plan.digest, input: { provider: "openai", value: "new-key" } }), deps)).state, "applied");
		assert.equal(fs.readFileSync(join(deps.cwd, ".env"), "utf8"), "OPENAI_API_KEY=new-key\n");
	}
});
