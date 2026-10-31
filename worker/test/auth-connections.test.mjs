import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, statSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { createAuthStore, authError } from "../src/auth-store.mjs";
import { createAuthService, parseAuthConnections, AUTH_SNAPSHOT_MARGIN_MS } from "../src/auth-connections.mjs";

const instant = 1_800_000_000_000;
const now = () => instant;
const policy = { version: 1, connections: [{ id: "chatgpt", provider: "openai", adapter: "openai-chatgpt", ownerHost: "host-a" }], bindings: { openai: "chatgpt" } };
const fresh = () => ({ access: "access-secret", refresh: "refresh-secret", expires: instant + 3600_000 });
function setup(override = {}) {
	const storeDir = join(tempDir("dispatch-auth-"), "private");
	const store = createAuthStore({ dir: storeDir });
	const adapter = { async login() { return fresh(); }, async refresh() { return fresh(); }, async validate() {}, ...override };
	const service = createAuthService({ policy, host: "host-a", now, store, adapters: { "openai-chatgpt": adapter } });
	return { service, store, storeDir, adapter };
}

test("auth policy rejects unknown version, cross-provider binding, relative roots and unreviewed credit", () => {
	for (const input of [{ ...policy, version: 2 }, { ...policy, bindings: { anthropic: "chatgpt" } }, { ...policy, connections: [{ ...policy.connections[0], extraUsageCreditMicros: -1 }] }, { ...policy, connections: [{ id: "claude", provider: "anthropic", adapter: "pi-anthropic-oauth@0.3.6", ownerHost: "host-a", root: "relative", digest: "a".repeat(64) }] }]) assert.throws(() => parseAuthConnections(input), /auth-/);
	assert.equal(parseAuthConnections(policy).connections[0].adapter, "openai-chatgpt");
});

test("unmanaged providers stay unmanaged; selected disconnected provider never falls through to ambient keys", async () => {
	const { service } = setup();
	assert.deepEqual(await service.prepareSnapshot("anthropic", { deadlineAt: instant + 1000 }), { ok: true, managed: false, snapshot: null });
	assert.equal((await service.check("openai")).reason, "auth-reauth-required");
});

test("status and read-only credential checks do not create an absent private store", async () => {
	const { service, storeDir, store } = setup();
	assert.equal(existsSync(storeDir), false);
	assert.equal(store.read("chatgpt"), null);
	assert.equal((await service.status())[0].state, "disconnected");
	assert.equal((await service.check("openai", { readOnly: true })).reason, "auth-reauth-required");
	assert.equal(existsSync(storeDir), false);
});

test("login persists private credentials, while status and snapshot expose separate explicit shapes", async () => {
	const { service, storeDir } = setup();
	await service.login("chatgpt");
	const status = await service.status();
	assert.equal(status[0].state, "connected");
	assert.equal(status[0].compatibility, "verified");
	assert.equal(JSON.stringify(status).includes("secret"), false);
	assert.equal(statSync(storeDir).mode & 0o777, 0o700);
	assert.equal(statSync(join(storeDir, "chatgpt.json")).mode & 0o777, 0o600);
	const { snapshot } = await service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 });
	assert.deepEqual(snapshot.env, { OPENAI_API_KEY: "access-secret" });
	assert.equal(JSON.stringify(snapshot).includes("refresh-secret"), false);
	assert.equal(await service.validateSnapshot(snapshot), true);
	assert.equal(await service.validateSnapshot({ ...snapshot, env: { OPENAI_API_KEY: "different-secret" } }), false);
	assert.equal(await service.validateSnapshot({ ...snapshot, env: { ...snapshot.env, ANTHROPIC_OAUTH_TOKEN: "extra" } }), false);
	await service.logout("chatgpt");
	assert.equal(await service.validateSnapshot(snapshot), false);
	assert.equal(readFileSync(join(storeDir, "chatgpt.json"), "utf8").includes("refresh-secret"), false);
});

test("serialized parallel jobs refresh a rotating credential once, then share its durable replacement", async () => {
	let refreshes = 0;
	const { service, store } = setup({ async login() { return { ...fresh(), expires: instant + 10_000 }; }, async refresh({ credential }) { refreshes++; assert.equal(credential.refresh, "refresh-secret"); await Promise.resolve(); return { ...fresh(), refresh: "rotated-secret" }; } });
	await service.login("chatgpt");
	const results = await Promise.all([service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 }), service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 })]);
	assert.equal(refreshes, 1);
	assert.equal(results.every((r) => r.ok), true);
	assert.equal(store.read("chatgpt").credential.refresh, "rotated-secret");
	assert.equal(results[0].snapshot.generation, results[1].snapshot.generation);
});

test("ambiguous rotation leaves a durable refusal marker and never retries the old token", async () => {
	let calls = 0;
	const { service, store } = setup({ async login() { return { ...fresh(), expires: instant + 10_000 }; }, async refresh() { calls++; throw new Error("provider echoed access-secret"); } });
	await service.login("chatgpt");
	const first = await service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 });
	assert.equal(first.reason, "auth-refresh-uncertain");
	assert.equal(store.read("chatgpt").state, "refresh-uncertain");
	assert.equal((await service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 })).reason, "auth-refresh-uncertain");
	assert.equal(calls, 1);
	assert.equal(JSON.stringify(await service.status()).includes("secret"), false);
});

test("known transient renewal failure preserves credentials while terminal failure requires reconnect", async () => {
	for (const transient of [true, false]) {
		const { service, store } = setup({ async login() { return { ...fresh(), expires: instant + 10_000 }; }, async refresh() { throw authError(transient ? "auth-network-unavailable" : "auth-reauth-required", { transient }); } });
		await service.login("chatgpt");
		const result = await service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 });
		assert.equal(result.ok, false);
		assert.equal(store.read("chatgpt").state, transient ? "connected" : "reauth-required");
		assert.equal(store.read("chatgpt").credential !== null, transient);
	}
});

test("token lifetime must cover the complete remaining deadline and margin even after successful refresh", async () => {
	const { service } = setup({ async login() { return { ...fresh(), expires: instant + 10_000 }; }, async refresh() { return { ...fresh(), expires: instant + 30 * 60_000 + AUTH_SNAPSHOT_MARGIN_MS }; } });
	await service.login("chatgpt");
	assert.equal((await service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 })).reason, "auth-snapshot-too-short");
});

test("owner mismatch and unsupported routes refuse without renewal or credential disclosure", async () => {
	let calls = 0;
	const { service, store } = setup({ async refresh() { calls++; return fresh(); } });
	await service.login("chatgpt");
	assert.equal((await service.check("openai", { api: "openai-decisions" })).reason, "auth-capability-unsupported");
	assert.equal((await service.check("openai", { baseUrl: "https://attacker.invalid" })).reason, "auth-endpoint-unsupported");
	const other = createAuthService({ policy, host: "host-b", store, now, adapters: {} });
	assert.equal((await other.check("openai")).reason, "auth-owner-host");
	assert.equal((await other.status())[0].accountGroup, null);
	assert.equal(calls, 0);
});

test("same connection reconnect preserves account cooldown identity and replaces credential generation", async () => {
	const { service } = setup();
	const first = await service.login("chatgpt");
	const second = await service.login("chatgpt");
	assert.equal(first.accountGroup, second.accountGroup);
	assert.ok(second.generation > first.generation);
});

test("store refuses group-readable secrets and unparseable files", async () => {
	const { service, storeDir, store } = setup();
	await service.login("chatgpt");
	const path = join(storeDir, "chatgpt.json");
	chmodSync(path, 0o640);
	assert.throws(() => store.read("chatgpt"), /auth-store-permissions/);
	chmodSync(path, 0o600); writeFileSync(path, "not json");
	assert.throws(() => store.read("chatgpt"), /auth-store-invalid/);
});

test("a job arriving after the renewal marker waits for the replacement instead of refusing", async () => {
	let start;
	const started = new Promise((resolve) => { start = resolve; });
	let finish;
	const finishing = new Promise((resolve) => { finish = resolve; });
	const { service } = setup({ async login() { return { ...fresh(), expires: instant + 10_000 }; }, async refresh() { start(); await finishing; return { ...fresh(), refresh: "replacement" }; } });
	await service.login("chatgpt");
	const first = service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 });
	await started;
	const second = service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 });
	finish();
	assert.equal((await first).ok, true);
	assert.equal((await second).ok, true);
});

test("cancelled caller cannot interrupt rotation persistence or receive a usable snapshot", async () => {
	const caller = new AbortController();
	const { service, store } = setup({ async login() { return { ...fresh(), expires: instant + 10_000 }; }, async refresh({ signal }) { caller.abort(); assert.equal(signal.aborted, false); return { ...fresh(), refresh: "replacement" }; } });
	await service.login("chatgpt");
	await assert.rejects(service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000, signal: caller.signal }));
	assert.equal(store.read("chatgpt").credential.refresh, "replacement");
	assert.equal(store.read("chatgpt").state, "connected");
});

test("all unknown policy keys and malformed monitor selections fail closed", () => {
	for (const input of [{ ...policy, surprise: true }, { ...policy, connections: [{ ...policy.connections[0], env: { OPENAI_API_KEY: "bad" } }] }, { ...policy, connections: [{ ...policy.connections[0], quotaWindows: ["five-hour", "five-hour"] }] }, { ...policy, connections: [{ ...policy.connections[0], quotaWindows: ["invented"] }] }]) assert.throws(() => parseAuthConnections(input), /auth-policy-invalid/);
	assert.deepEqual(parseAuthConnections(policy).connections[0].quotaWindows, ["five-hour", "seven-day"]);
	assert.deepEqual(parseAuthConnections({ ...policy, connections: [{ ...policy.connections[0], quotaWindows: ["five-hour"] }] }).connections[0].quotaWindows, ["five-hour"]);
});

test("credit/monitor policy edits and provider rebindings invalidate already prepared snapshots", async () => {
	let current = structuredClone(policy);
	const storeDir = join(tempDir("auth-rebind-"), "private");
	const service = createAuthService({ readPolicy: () => current, storeDir, host: "host-a", now, adapters: { "openai-chatgpt": { async login() { return fresh(); } } } });
	await service.login("chatgpt");
	const { snapshot } = await service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 });
	assert.equal(await service.validateSnapshot(snapshot), true);
	current = { ...current, connections: [{ ...current.connections[0], extraUsageCreditMicros: 1_000_000 }] };
	assert.equal(await service.validateSnapshot(snapshot), false);
	current = { ...current, bindings: {} };
	assert.equal(await service.validateSnapshot(snapshot), false);
});

test("binding edits during remote renewal refuse the old prepared connection after preserving rotation", async () => {
	let current = structuredClone(policy);
	const storeDir = join(tempDir("auth-renew-rebind-"), "private");
	const store = createAuthStore({ dir: storeDir });
	const service = createAuthService({ readPolicy: () => current, store, host: "host-a", now, adapters: { "openai-chatgpt": { async login() { return { ...fresh(), expires: instant + 10_000 }; }, async refresh() { current = { ...current, bindings: {} }; return { ...fresh(), refresh: "rotated" }; } } } });
	await service.login("chatgpt");
	assert.equal((await service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 })).reason, "auth-binding-changed");
	assert.equal(store.read("chatgpt").credential.refresh, "rotated");
});

test("API-key-shaped OpenAI values cannot enter through login, refresh or an edited private store", async () => {
	const first = setup({ async login() { return { ...fresh(), access: "sk-paid-key" }; } });
	await assert.rejects(first.service.login("chatgpt"), /auth-credential-invalid/);
	const second = setup({ async login() { return { ...fresh(), expires: instant + 10_000 }; }, async refresh() { return { ...fresh(), access: "sk-paid-key" }; } });
	await second.service.login("chatgpt");
	assert.equal((await second.service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 })).ok, false);
	const third = setup();
	await third.service.login("chatgpt");
	const path = join(third.storeDir, "chatgpt.json");
	const saved = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ ...saved, credential: { ...saved.credential, access: "sk-paid-key" } }));
	assert.equal((await third.service.check("openai")).reason, "auth-credential-invalid");
});

test("known earliest refresh time defers freely without invoking renewal or writing an uncertain marker", async () => {
	let calls = 0;
	const { service, store } = setup({ async login() { return { ...fresh(), expires: instant + 10_000, earliestRefreshAt: instant + 60_000 }; }, async refresh() { calls++; return fresh(); } });
	await service.login("chatgpt");
	const before = structuredClone(store.read("chatgpt"));
	assert.deepEqual(await service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 }), { ok: false, reason: "auth-refresh-too-early", wait: "subscription-auth", until: instant + 60_000, unavailable: false });
	assert.equal(calls, 0);
	assert.deepEqual(store.read("chatgpt"), before);
});

test("local logout clears credentials even when its adapter is missing or tampered", async () => {
	for (const code of ["ENOENT", "auth-adapter-unpinned"]) {
		let broken = false;
		let revoked = 0;
		const { service, store } = setup({ async validate() { if (broken) { const error = new Error(code); error.code = code; throw error; } }, async revoke() { revoked++; return { confirmed: true }; } });
		await service.login("chatgpt");
		const { snapshot } = await service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 });
		broken = true;
		assert.deepEqual(await service.logout("chatgpt"), { id: "chatgpt", state: "disconnected", remoteRevocationConfirmed: false });
		assert.equal(store.read("chatgpt").credential, null);
		assert.equal(await service.validateSnapshot(snapshot), false);
		assert.equal(revoked, 0);
	}
});

test("damaged live policy refuses determinately without falling through to an API credential", async () => {
	let current = structuredClone(policy);
	const service = createAuthService({ readPolicy: () => current, storeDir: join(tempDir("auth-live-policy-"), "private"), host: "host-a", now, adapters: { "openai-chatgpt": { async login() { return fresh(); } } } });
	await service.login("chatgpt");
	assert.equal((await service.check("openai")).ok, true);
	current = "{ damaged policy";
	assert.deepEqual(await service.check("openai"), { ok: false, managed: true, reason: "auth-policy-invalid", unavailable: false });
	assert.deepEqual(await service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 }), { ok: false, managed: true, reason: "auth-policy-invalid", unavailable: false });
});

test("transient policy I/O stays retryable and emits a closed reason without private paths", async () => {
	const service = createAuthService({ readPolicy() { throw Object.assign(new Error("EIO /private/operator/credential-secret"), { code: "EIO" }); }, storeDir: join(tempDir("auth-policy-io-"), "private"), host: "host-a", now, adapters: {} });
	const result = await service.check("openai");
	assert.deepEqual(result, { ok: false, managed: true, reason: "auth-policy-unavailable", unavailable: true });
	assert.equal(JSON.stringify(result).includes("operator"), false);
	assert.equal(JSON.stringify(result).includes("credential-secret"), false);
});

test("policy damage or I/O between preview and preparation retains the correct refusal class", async () => {
	for (const transient of [false, true]) {
		let armed = false;
		let reads = 0;
		const service = createAuthService({ readPolicy() { if (armed && ++reads === 2) { if (transient) throw Object.assign(new Error("/private/operator/secret"), { code: "EIO" }); return "{ damaged"; } return policy; }, storeDir: join(tempDir("auth-policy-race-"), "private"), host: "host-a", now, adapters: { "openai-chatgpt": { async login() { return fresh(); } } } });
		await service.login("chatgpt"); armed = true;
		const result = await service.prepareSnapshot("openai", { deadlineAt: instant + 30 * 60_000 });
		assert.equal(result.ok, false);
		assert.equal(result.managed, true);
		assert.equal(result.unavailable, transient);
		assert.equal(result.reason, transient ? "auth-state-unavailable" : "auth-policy-invalid");
		assert.equal(JSON.stringify(result).includes("operator"), false);
	}
});

test("Anthropic login, refresh and stored rows cannot substitute an API key or malformed bearer", async () => {
	const id = "claude";
	const adapterId = "pi-anthropic-oauth@0.3.6";
	const claudePolicy = { version: 1, connections: [{ id, provider: "anthropic", adapter: adapterId, ownerHost: "host-a", root: "/reviewed/claude", digest: "a".repeat(64) }], bindings: { anthropic: id } };
	for (const bad of ["sk-ant-api03-not-oauth", "sk-ant-oat with spaces"]) {
		const storeDir = join(tempDir("claude-invalid-"), "private");
		const store = createAuthStore({ dir: storeDir });
		let loginAccess = bad;
		const adapter = { validate() {}, login: async () => ({ ...fresh(), access: loginAccess, expires: instant + 10_000 }), refresh: async () => ({ ...fresh(), access: bad }) };
		const service = createAuthService({ policy: claudePolicy, host: "host-a", now, store, adapters: { [adapterId]: adapter } });
		await assert.rejects(service.login(id), /auth-credential-invalid/);
		loginAccess = "sk-ant-oat-valid-fixture";
		await service.login(id);
		assert.equal((await service.prepareSnapshot("anthropic", { deadlineAt: instant + 30 * 60_000 })).ok, false, "invalid renewal cannot enter a snapshot");
		await service.login(id);
		const path = join(storeDir, `${id}.json`);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...saved, credential: { ...saved.credential, access: bad } }));
		assert.equal((await service.check("anthropic")).reason, "auth-credential-invalid");
		const prepared = await service.prepareSnapshot("anthropic", { deadlineAt: instant + 30 * 60_000 });
		assert.equal(prepared.ok, false);
		assert.equal(prepared.snapshot, undefined);
	}
});

test("logout after an adapter change does not invent remote revocation of the old grant", async () => {
	const { service, storeDir } = setup();
	await service.login("chatgpt");
	const path = join(storeDir, "chatgpt.json");
	const saved = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ ...saved, adapter: "previous-adapter" }));
	const result = await service.logout("chatgpt");
	assert.equal(result.remoteRevocationConfirmed, false);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).credential, null);
});
