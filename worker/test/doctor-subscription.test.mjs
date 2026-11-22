import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { collectChecks, runDoctor } from "./helpers/doctor.mjs";
import { doctorSubscriptionCredentials, subscriptionCredentialCheck, listedProviderCredentialChecks, notionalCapChecks, WORKER_SERVICE_KEYS } from "../src/doctor.mjs";
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

test("doctor says a capped mixed pool's draws each bill their own class, the cap bounding the billed ones, and warns when a connection's paid usage is below it (issues #968, #1008)", async () => {
	const capped = await poolChecks({ maxCostUsd: "2" });
	const fact = capped.find((c) => MIXED.test(c.label));
	assert.equal(fact.ok, true);
	assert.match(fact.label, /each draw bills its own candidate's class, and the job's \$2\.00 cap bounds the API-key draws and a draw on a connection with paid extra usage/);
	assert.match(fact.label, /a draw on a subscription without paid extra usage is notional: its calls leave the cap and the dollar windows/);
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

test("doctor's mixed pool line names the trigger's subscription allowance read from the file, or says it sets none (issue #1008)", async () => {
	const fact = async (run) => (await poolChecks(run)).find((c) => MIXED.test(c.label));
	const set = await fact({ maxCostUsd: "2", maxSubscriptionUsd: "12.50" });
	assert.equal(set.ok, true);
	assert.match(set.label, /a draw on a subscription without paid extra usage is notional: its calls leave the cap and the dollar windows, and the trigger's \$12\.50 run\.maxSubscriptionUsd \(its calls' settled list price, checked between calls\), its quota and the job's turn and time limits bound it/);
	assert.match((await fact({ maxCostUsd: "2" })).label, /only its quota and the job's turn and time limits bound it, as the trigger sets no run\.maxSubscriptionUsd/);
	const warning = (await capChecks({ provider: "anthropic", model: "claude-sonnet-4-5", models: ["anthropic/claude-sonnet-4-5"], maxCostUsd: "2" })).find((c) => BOUNDS_NOTHING.test(c.label));
	assert.match(warning.fix, /^set run\.maxSubscriptionUsd to give its subscription calls a list-price allowance/);
	assert.match(warning.label, /so its jobs are bounded only by the subscription's quota and their turn and time limits$/);
	// A trigger that sets one is bounded by it, and the line says so rather than "only the quota".
	const allowed = (await capChecks({ provider: "anthropic", model: "claude-sonnet-4-5", models: ["anthropic/claude-sonnet-4-5"], maxCostUsd: "2", maxSubscriptionUsd: "12.50" })).find((c) => BOUNDS_NOTHING.test(c.label));
	assert.match(allowed.label, /so its jobs are bounded by its \$12\.50 run\.maxSubscriptionUsd at list price, the subscription's quota and their turn and time limits$/);
	assert.match(allowed.fix, /^limit its turns or minutes/);
});

test("doctor says nothing of a random pool in one billing class on this host, capped or not (issue #968)", async () => {
	assert.equal((await poolChecks({}, { row: { ok: true, managed: false } })).some((c) => MIXED.test(c.label)), false, "nothing bound here: all API keys");
	assert.equal((await poolChecks({}, { candidates: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"] })).some((c) => MIXED.test(c.label)), false, "all subscription");
});

// Issue #1008: a trigger whose own run.maxCostUsd bounds nothing on this host, because every model it may call is on a
// subscription connection without paid extra usage, whose calls are notional.
const BOUNDS_NOTHING = /bounds nothing on this host/;
async function capChecks(run, { row = claude } = {}) {
	const root = tempDir("doctor-notional-cap-");
	const path = join(root, "triggers.json");
	writeFileSync(path, JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [{ on: { type: "label", any: ["pi:sub"] }, run: { kind: "github", flow: "deploy", ...run } }] }));
	return collectChecks({ ...env, PI_TRIGGERS_FILE: path, PI_MAX_COST_USD: "5" }, { cwd: root, home: root, out() {}, spawn: missingBinary, fileExists: (p) => p === path, probeValkey: async () => false, nodeVersion: "22.19.0", platform: "linux", agentDir: join(root, "agent"), wallClock: now, modelCatalog: async () => null, subscriptionFactory: () => ({ auth: { async check(provider) { return provider === "anthropic" ? row : { ok: true, managed: false }; } } }) });
}

test("doctor warns when a trigger's own run.maxCostUsd bounds nothing on this host: every model it may call is a notional subscription (issue #1008)", async () => {
	const single = { provider: "anthropic", model: "claude-sonnet-4-5", models: ["anthropic/claude-sonnet-4-5"], maxCostUsd: "2" };
	const warning = (await capChecks(single)).find((c) => BOUNDS_NOTHING.test(c.label));
	assert.equal(warning.ok, false);
	assert.equal(warning.warn, true, "a warning: the cap may still be needed");
	assert.match(warning.label, /^label trigger #0: its run\.maxCostUsd \(\$2\.00\) bounds nothing on this host: every model it may call is on a subscription connection without paid extra usage \(anthropic\)/);
	assert.match(warning.fix, /run\.maxTurns, run\.maxMinutes/);
	const pool = { models: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"], modelSelection: { strategy: "random", candidates: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"] }, maxCostUsd: "2" };
	assert.equal((await capChecks(pool)).filter((c) => BOUNDS_NOTHING.test(c.label)).length, 1, "a random pool of notional candidates, one line for the trigger");
	// Each of these leaves the cap something to bound, or no cap of the trigger's own: no line.
	for (const [why, run, row] of [
		["paid extra usage", single, { ...claude, extraUsageCreditMicros: 5_000_000 }],
		["an API-key model in the list", { ...single, models: [...single.models, "openrouter/deepseek/deepseek-chat"] }, claude],
		["an API-key candidate in the pool", { ...pool, models: mixedPool, modelSelection: { strategy: "random", candidates: mixedPool } }, claude],
		["the deployment's cap alone", { ...single, maxCostUsd: undefined }, claude],
		["nothing bound here", single, { ok: true, managed: false }],
	]) assert.equal((await capChecks(run, { row })).some((c) => BOUNDS_NOTHING.test(c.label)), false, why);
});

test("a failed or unreadable subscription check never reads as notional: no false bounds-nothing line (issue #1008)", async () => {
	// Doctor answers `managed: true` for a check that failed, for any provider: such a verdict states no credit, so it
	// proves nothing about whether the connection's calls are billed.
	const subject = { label: "label trigger #0", main: { provider: "anthropic", id: "claude-sonnet-4-5" }, list: [{ provider: "anthropic", id: "claude-sonnet-4-5" }], auxiliaryModels: [], decisionModel: null, triggerCap: 2_000_000 };
	for (const [why, verdict] of [
		["another owner host", { ok: false, managed: true, reason: "auth-owner-host", unavailable: false }],
		["sign-in required", { ok: false, managed: true, reason: "auth-reauth-required", unavailable: false }],
		["sign-in required with paid extra usage", { ok: false, managed: true, reason: "auth-reauth-required", extraUsageCreditMicros: 5_000_000 }],
		["an unreadable policy", { ok: false, managed: true, reason: "auth-policy-invalid" }],
		["a failed check that names no credit", { ok: false, managed: true, extraUsageCreditMicros: null }],
		["a check that names no credit", { ok: true, managed: true }],
	]) assert.deepEqual(notionalCapChecks([subject], { verdictOf: () => verdict }), [], why);
	assert.equal(notionalCapChecks([subject], { verdictOf: () => ({ ok: true, managed: true, extraUsageCreditMicros: null }) }).length, 1, "the premise: a successful check with no credit warns");
	const openrouter = { ...subject, main: { provider: "openrouter", id: "deepseek/deepseek-chat" }, list: [{ provider: "openrouter", id: "deepseek/deepseek-chat" }] };
	assert.deepEqual(notionalCapChecks([openrouter], { verdictOf: () => ({ ok: true, managed: true, extraUsageCreditMicros: null }) }), [], "a provider no subscription adapter serves is never notional");
	// Through collection: a connections file that does not load, and a check that throws, on an API-key-only trigger.
	const run = { provider: "openrouter", model: "deepseek/deepseek-chat", models: ["openrouter/deepseek/deepseek-chat"], maxCostUsd: "2" };
	for (const [why, factory] of [["a connections file that does not load", () => { throw new Error("malformed"); }], ["a check that throws", () => ({ auth: { async check() { throw new Error("eio"); } } })]]) {
		const root = tempDir("doctor-notional-failed-");
		const path = join(root, "triggers.json");
		writeFileSync(path, JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [{ on: { type: "label", any: ["pi:api"] }, run: { kind: "github", flow: "deploy", ...run } }] }));
		const checks = await collectChecks({ ...env, PI_TRIGGERS_FILE: path, PI_MAX_COST_USD: "5" }, { cwd: root, home: root, out() {}, spawn: missingBinary, fileExists: (p) => p === path, probeValkey: async () => false, nodeVersion: "22.19.0", platform: "linux", agentDir: join(root, "agent"), wallClock: now, modelCatalog: async () => null, subscriptionFactory: factory });
		assert.equal(checks.some((c) => BOUNDS_NOTHING.test(c.label)), false, why);
	}
});
