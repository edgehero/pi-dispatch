import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { collectChecks, runDoctor } from "./helpers/doctor.mjs";
import { doctorSubscriptionCredentials, subscriptionCredentialCheck, listedProviderCredentialChecks, WORKER_SERVICE_KEYS } from "../src/doctor.mjs";
import { TRIGGERS_FILE_VERSION } from "../src/triggers.mjs";

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

// Issue #968: a random pool whose candidates fall in both billing classes on this host. anthropic is bound to a connection
// here and openrouter is not, so the pool holds one subscription candidate and one API-key candidate.
const claude = { ok: true, managed: true, provider: "anthropic", id: "claude", connectionId: "claude", ownerHost: "owner-a", extraUsageCreditMicros: null };
const mixedPool = ["anthropic/claude-sonnet-4-5", "openrouter/deepseek/deepseek-chat"];
const MIXED = /random pool mixes billing classes on this host/;
async function poolChecks(run, { row = claude, shell = {}, candidates = mixedPool } = {}) {
	const root = tempDir("doctor-mixed-pool-");
	const path = join(root, "triggers.json");
	writeFileSync(path, JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [{ on: { type: "label", any: ["pi:mixed"] }, run: { kind: "github", flow: "deploy", models: candidates, modelSelection: { strategy: "random", candidates }, ...run } }] }));
	// No model catalog: these lines need no pi, so they are said when pi-ai does not load too.
	return collectChecks({ ...env, PI_TRIGGERS_FILE: path, ...shell }, { cwd: root, home: root, out() {}, spawn: missingBinary, fileExists: (p) => p === path, probeValkey: async () => false, nodeVersion: "22.19.0", platform: "linux", agentDir: join(root, "agent"), wallClock: now, modelCatalog: async () => null, subscriptionFactory: () => ({ auth: { async check(provider) { return provider === "anthropic" ? row : { ok: true, managed: false }; } } }) });
}

test("doctor fails a random pool mixing billing classes on this host without a cap of its trigger's own, naming the trigger and both classes (issue #968)", async () => {
	// A deployment cap alone does not count, and a connection that cannot authorize now still makes its provider a subscription.
	for (const [shell, row] of [[{}, claude], [{ PI_MAX_COST_USD: "5" }, claude], [{}, { ok: false, managed: true, reason: "auth-reauth-required", provider: "anthropic" }]]) {
		const lines = (await poolChecks({}, { shell, row })).filter((c) => MIXED.test(c.label));
		assert.equal(lines.length, 1, JSON.stringify({ shell, row: row.reason ?? "ready" }));
		assert.equal(lines[0].ok, false);
		assert.notEqual(lines[0].warn, true, "a failure, not a warning: every job of the trigger is refused");
		assert.match(lines[0].label, /^label trigger #0: .*\(subscription: anthropic\/claude-sonnet-4-5; API key: openrouter\/deepseek\/deepseek-chat\) and the trigger sets no positive run\.maxCostUsd$/);
		assert.match(lines[0].fix, /^set a positive run\.maxCostUsd, or keep the pool in one billing class/);
		assert.match(lines[0].fix, /auth-route-unbounded/);
	}
});

test("doctor says a capped mixed pool's draws each bill their own class under the cap, and warns when a connection's paid usage is below it (issue #968)", async () => {
	const capped = await poolChecks({ maxCostUsd: "2" });
	const fact = capped.find((c) => MIXED.test(c.label));
	assert.equal(fact.ok, true);
	assert.match(fact.label, /each draw bills its own candidate's class, and every draw runs under the job's \$2\.00 cap, a subscription draw too/);
	assert.equal(capped.some((c) => /auth-credit-cap-required/.test(c.label)), false, "no paid usage on the connection, no warning");
	const credit = await poolChecks({ maxCostUsd: "2" }, { row: { ...claude, extraUsageCreditMicros: 1_000_000 } });
	const warning = credit.find((c) => /auth-credit-cap-required/.test(c.label));
	assert.equal(warning.ok, false);
	assert.equal(warning.warn, true);
	assert.match(warning.label, /^label trigger #0: the subscription connection for anthropic allows paid extra usage up to \$1\.00 a job, below this pool's \$2\.00 cap/);
	assert.match(warning.fix, /at most 1\.00/);
	const fits = await poolChecks({ maxCostUsd: "1" }, { row: { ...claude, extraUsageCreditMicros: 1_000_000 } });
	assert.equal(fits.some((c) => /auth-credit-cap-required/.test(c.label)), false, "a cap at the connection's ceiling is admitted");
});

test("doctor says nothing of a random pool in one billing class on this host, capped or not (issue #968)", async () => {
	assert.equal((await poolChecks({}, { row: { ok: true, managed: false } })).some((c) => MIXED.test(c.label)), false, "nothing bound here: all API keys");
	assert.equal((await poolChecks({}, { candidates: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"] })).some((c) => MIXED.test(c.label)), false, "all subscription");
});
