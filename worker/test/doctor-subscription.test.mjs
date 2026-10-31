import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { collectChecks, runDoctor } from "./helpers/doctor.mjs";
import { doctorSubscriptionCredentials, subscriptionCredentialCheck, listedProviderCredentialChecks, WORKER_SERVICE_KEYS } from "../src/doctor.mjs";

const instant = 1_800_000_000_000;
const now = () => instant;
const env = { PI_PROVIDER: "openai", PI_MODEL: "gpt-5.5", PI_WORKER_NAME: "owner-a", PI_AUTH_CONNECTIONS_FILE: "connections.json", PI_AUTH_STORE_DIR: "private", GITHUB_AUTH_SOURCE: "invalid-forge-value" };
const ready = { ok: true, managed: true, provider: "openai", id: "selected", ownerHost: "owner-a", expiresAt: instant - 1, credential: "never-print-credential", subject: "never-print-subject" };
function missingBinary() {
	const child = new EventEmitter();
	child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
	queueMicrotask(() => child.emit("error", Object.assign(new Error("not installed"), { code: "ENOENT" })));
	return child;
}

test("doctor builds only the local auth subset despite broken forge config, with no renewal or network", async () => {
	const root = tempDir("doctor-sub-auth-");
	let checks = 0;
	const metadata = await doctorSubscriptionCredentials(env, { cwd: root, home: root, now, configure({ config, redis, now: clock }) {
		assert.equal(redis, null);
		assert.equal(clock, now);
		assert.equal(config.authConnectionsFile, join(root, "connections.json"));
		assert.equal(config.authStoreDir, join(root, "private"));
		assert.equal(config.workerName, "owner-a");
		assert.equal(config.github, undefined);
		return { auth: { async check() { checks++; return ready; }, async login() { throw new Error("login forbidden"); }, async prepareSnapshot() { throw new Error("refresh forbidden"); }, async usage() { throw new Error("network forbidden"); } } };
	} });
	assert.equal((await metadata.check("openai")).ok, true);
	assert.equal((await metadata.check("openai")).ok, true);
	assert.equal(checks, 1, "one cached read-only check per provider");
	const line = subscriptionCredentialCheck("openai", ready);
	assert.equal(line.ok, true, "expired access remains renewable, rather than requiring sign-in");
	assert.match(line.label, /owner owner-a/);
	assert.doesNotMatch(JSON.stringify(line), /never-print/);
});

test("doctor reports closed subscription states and never recommends an API key for a selected binding", () => {
	for (const reason of ["auth-reauth-required", "auth-refresh-uncertain", "auth-adapter-unpinned", "auth-owner-host", "provider-secret-and-path"]) {
		const line = subscriptionCredentialCheck("openai", { ...ready, ok: false, reason });
		assert.equal(line.ok, false);
		assert.doesNotMatch(JSON.stringify(line), /never-print|provider-secret-and-path|API key|OPENAI_API_KEY/);
		if (reason === "auth-owner-host") assert.equal(line.warn, true);
		if (reason === "auth-reauth-required") assert.match(line.fix, /auth login selected/);
	}
});

test("unreadable subscription policy fails loudly while an unset policy preserves ordinary credentials", async () => {
	const ordinary = await doctorSubscriptionCredentials({});
	assert.deepEqual(await ordinary.check("openai"), { ok: true, managed: false });
	const unavailable = await doctorSubscriptionCredentials(env, { configure() { throw new Error("private/path and token"); } });
	assert.deepEqual(await unavailable.check("openai"), { ok: false, managed: true, reason: "auth-policy-invalid" });
});

test("allowed-model credential diagnostics defer managed providers to their explicit subscription verdict", () => {
	const subjects = [{ label: "trigger 1", main: { provider: "anthropic", id: "m" }, list: [{ provider: "anthropic", id: "m" }, { provider: "openai", id: "n" }], secretNames: [] }];
	const options = { candidatesOf: () => ["OPENAI_API_KEY"] };
	assert.equal(listedProviderCredentialChecks(subjects, options).length, 1);
	assert.deepEqual(listedProviderCredentialChecks(subjects, { ...options, subscriptionChecks: new Map([["openai", ready]]) }), []);
	assert.deepEqual(listedProviderCredentialChecks(subjects, { ...options, subscriptionChecks: new Map([["openai", { ok: false, managed: true, reason: "auth-reauth-required" }]]) }), []);
	assert.ok(WORKER_SERVICE_KEYS.includes("PI_AUTH_CONNECTIONS_FILE"));
	assert.ok(WORKER_SERVICE_KEYS.includes("PI_AUTH_STORE_DIR"));
});

test("actual doctor collection selects subscription metadata instead of its legacy API-key failure", async () => {
	const root = tempDir("doctor-sub-collect-");
	const checks = await collectChecks(env, { cwd: root, home: root, out() {}, spawn: missingBinary, fileExists: () => false, probeValkey: async () => false, nodeVersion: "22.19.0", platform: "linux", agentDir: join(root, "agent"), wallClock: now, subscriptionFactory: () => ({ auth: { async check(provider) { return provider === "openai" ? ready : { ok: true, managed: false }; } } }) });
	const line = checks.find((row) => row.id === "provider.key");
	assert.equal(line.ok, true);
	assert.match(line.label, /Subscription credential selected/);
	assert.doesNotMatch(JSON.stringify(line), /set OPENAI_API_KEY|never-print/);
});

test("real local auth metadata on an absent store remains read-only", async () => {
	const root = tempDir("doctor-sub-absent-");
	const policy = join(root, "connections.json");
	const privateDir = join(root, "private");
	writeFileSync(policy, JSON.stringify({ version: 1, connections: [{ id: "selected", provider: "openai", adapter: "openai-chatgpt", ownerHost: "owner-a" }], bindings: { openai: "selected" } }), { mode: 0o600 });
	const metadata = await doctorSubscriptionCredentials({ PI_AUTH_CONNECTIONS_FILE: policy, PI_AUTH_STORE_DIR: privateDir, PI_WORKER_NAME: "owner-a" }, { cwd: root, home: root, now });
	assert.equal((await metadata.check("openai")).reason, "auth-reauth-required");
	assert.equal(existsSync(privateDir), false);
});

test("doctor entry reads subscription paths from the deployment service env without requiring valid forge setup", async () => {
	const root = tempDir("doctor-sub-service-");
	writeFileSync(join(root, ".env"), `PI_PROVIDER=openai\nPI_MODEL=gpt-5.5\nPI_WORKER_NAME=owner-a\nPI_AUTH_CONNECTIONS_FILE=${join(root, "connections.json")}\nPI_AUTH_STORE_DIR=${join(root, "private")}\nGITHUB_AUTH_SOURCE=invalid-forge-value\n`);
	let captured;
	let text = "";
	await runDoctor({}, { cwd: root, home: root, out(value) { text += value; }, spawn: missingBinary, fileExists: existsSync, probeValkey: async () => false, nodeVersion: "22.19.0", platform: "linux", agentDir: join(root, "agent"), wallClock: now, subscriptionFactory({ config, redis }) { captured = config; assert.equal(redis, null); return { auth: { async check() { return ready; } } }; } });
	assert.equal(captured.authConnectionsFile, join(root, "connections.json"));
	assert.equal(captured.authStoreDir, join(root, "private"));
	assert.match(text, /Subscription credential selected/);
	assert.doesNotMatch(text, /set OPENAI_API_KEY in \.env|never-print/);
});
