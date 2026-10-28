import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FAILURE_KINDS, MAX_RESET_MS } from "../../image/runner/src/provider-failure.mjs";
import { PROVIDER_FAILURE_KINDS } from "../src/model-failover-protocol.mjs";
import { test } from "node:test";
import { FAILOVER_PRICED_APIS, MODEL_COOLDOWN_MAX_MS, checkFailoverCandidate, failoverEgressRequired, failoverModelView, markModelCooldown, modelCooldownKey, readModelAttempt, readModelCooldown, readModelCooldowns, selectFailoverJob, writeModelAttempt } from "../src/model-failover.mjs";
import { makeProcessor } from "../src/index.mjs";
import { parseExitProviderFailure, parseExitReplaySafe, parseExitToolsStarted, buildRecord, makeLogSink } from "../src/run-history.mjs";
import { modelDollarRows, parseScopedLimits, makeInFlight } from "../src/scoped-limits.mjs";
import { dayKey } from "../src/budget.mjs";
import { makeCollectChain } from "../src/outbox.mjs";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const primary = "openai/primary";
const fallback = "anthropic/fallback";
const job = () => ({ kind: "github", repo: "org/repo", provider: "openai", model: "primary", models: [primary, fallback], fallbackModels: [fallback], maxCostMicros: 100 });
function fakeRedis() {
	const store = new Map();
	const writes = [];
	return {
		store, writes,
		get: async (key) => store.get(key) ?? null,
		set: async (key, value, ...args) => { writes.push({ key, value, args }); store.set(key, value); return "OK"; },
		incr: async (key) => { const n = Number(store.get(key) ?? 0) + 1; store.set(key, String(n)); return n; },
		decr: async (key) => { const n = Number(store.get(key) ?? 0) - 1; store.set(key, String(n)); return n; },
		expire: async () => 1,
		eval: async (_script, _count, key, until, value, ttl) => {
			const old = JSON.parse(store.get(key) ?? "null");
			if (old?.until > Number(until)) return 0;
			writes.push({ key, value, ttl }); store.set(key, value); return 1;
		},
	};
}
const select = (redis, overrides = {}) => selectFailoverJob(job(), { redis, id: "queue:j", now: () => NOW, checkCandidate: async () => null, ...overrides });

test("the worker's eligibility APIs equal the runner's pinned cost-bound APIs", () => {
	const source = readFileSync(new URL("../../image/runner/src/usage-meter.mjs", import.meta.url), "utf8");
	const body = source.match(/export const PRICED_APIS = Object\.freeze\(\[([\s\S]*?)\]\)/)[1];
	assert.deepEqual(FAILOVER_PRICED_APIS, [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
	assert.deepEqual(PROVIDER_FAILURE_KINDS, FAILURE_KINDS, "the signed wire vocabulary has one closed meaning");
	assert.equal(MODEL_COOLDOWN_MAX_MS, MAX_RESET_MS, "worker TTL and measured runner reset use the same bound");
});

test("overlay token defaults agree with the pinned composer, and explicit default OpenShell requires egress", async () => {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const source = readFileSync(join(dirname(entry), "core/provider-composer.js"), "utf8");
	const contextWindow = Number(source.match(/contextWindow: definition\.contextWindow \?\? (\d+)/)[1]);
	const maxTokens = Number(source.match(/maxTokens: definition\.maxTokens \?\? (\d+)/)[1]);
	const models = { providers: { custom: { api: "openai-completions", baseUrl: "https://custom.example/v1", models: [{ id: "m" }] } } };
	const view = failoverModelView("custom/m", { models });
	assert.equal(view.contextWindow, contextWindow);
	assert.equal(view.maxTokens, maxTokens);
	assert.equal(failoverEgressRequired({}, { defaultBackend: "openshell", egress: false }), true);
	assert.equal(failoverEgressRequired({}, { defaultBackend: "openshell-bind", egress: false }), true);
	assert.equal(failoverEgressRequired({ backend: "local" }, { defaultBackend: "openshell", egress: false }), false);
	assert.equal(failoverEgressRequired({}, { defaultBackend: "local", egress: true }), true);
});

test("cooldowns cap resets, keep the longest concurrent reset, expire by the injected clock and expose only closed facts", async () => {
	const redis = fakeRedis();
	await markModelCooldown(redis, primary, { kind: "quota-exhausted", resetAt: NOW + 90 * MODEL_COOLDOWN_MAX_MS, secret: "never" }, { now: () => NOW });
	await markModelCooldown(redis, primary, { kind: "overloaded", resetAt: NOW + 10_000 }, { now: () => NOW });
	assert.deepEqual(await readModelCooldown(redis, primary, { now: () => NOW }), { ref: primary, kind: "quota-exhausted", until: NOW + MODEL_COOLDOWN_MAX_MS });
	assert.equal(redis.writes[0].ttl, MODEL_COOLDOWN_MAX_MS);
	assert.deepEqual(await readModelCooldowns(redis, [primary, primary, fallback], { now: () => NOW }), [{ ref: primary, kind: "quota-exhausted", until: NOW + MODEL_COOLDOWN_MAX_MS }]);
	assert.equal(await readModelCooldown(redis, primary, { now: () => NOW + MODEL_COOLDOWN_MAX_MS }), null);
	assert.equal(await markModelCooldown(redis, primary, { kind: "context-overflow" }, { now: () => NOW }), null);
	assert.ok(!JSON.stringify(redis.writes).includes("never"));
	redis.store.set(modelCooldownKey(primary), "broken");
	await assert.rejects(() => readModelCooldown(redis, primary, { now: () => NOW }), /invalid model cooldown/);
	for (const row of [{ kind: "context-overflow", until: NOW + 1000 }, { kind: "rate-limited", until: Number.MAX_SAFE_INTEGER }]) {
		redis.store.set(modelCooldownKey(primary), JSON.stringify(row));
		await assert.rejects(() => readModelCooldown(redis, primary, { now: () => NOW }), /invalid model cooldown/);
	}
});

test("selection keeps the reviewed ceiling intact, chooses ordered singleton executable models and records why", async () => {
	const redis = fakeRedis();
	const seen = [];
	const picked = await select(redis, { checkCandidate: async (candidate) => { seen.push(candidate.models); return null; } });
	assert.deepEqual(picked.job.models, [primary]);
	assert.equal(picked.job.modelWhy, "primary");
	await markModelCooldown(redis, primary, { kind: "rate-limited", resetAt: NOW + 120_000 }, { now: () => NOW });
	const next = await select(redis);
	assert.equal(next.ref, fallback);
	assert.equal(next.job.modelWhy, "fallback-cooldown");
	assert.deepEqual(next.job.models, [fallback]);
	assert.deepEqual(job().models, [primary, fallback]);
	assert.deepEqual(seen, [[primary]]);
});

test("candidate rejection is named and free; absent ceiling and malformed lists never run", async () => {
	for (const reason of ["model-unknown", "model-unpriced", "provider-unconfigured", "model-host-unlisted"]) {
		const logs = [];
		const redis = fakeRedis();
		const picked = await select(redis, { checkCandidate: async (candidate) => candidate.model === "primary" ? reason : null, log: (event, fields) => logs.push({ event, fields }) });
		assert.equal(picked.ref, fallback);
		assert.equal(picked.job.modelWhy, "fallback-unavailable");
		assert.deepEqual(logs[0], { event: "model_candidate_skipped", fields: { model: primary, reason } });
		assert.equal(redis.writes.length, 0);
	}
	for (const overrides of [{ models: undefined }, { fallbackModels: ["openai/off-list"] }, { fallbackModels: "bad" }]) {
		assert.equal((await selectFailoverJob({ ...job(), ...overrides }, { redis: fakeRedis(), now: () => NOW })).refused, "model-failover-no-candidate");
	}
	assert.equal((await select(fakeRedis(), { checkCandidate: async () => "model-unpriced" })).refused, "model-failover-no-candidate");
});

test("all cooling defers without spending; a busy endpoint skips to the next candidate", async () => {
	const redis = fakeRedis();
	for (const ref of [primary, fallback]) await markModelCooldown(redis, ref, { kind: "quota-exhausted" }, { now: () => NOW });
	assert.deepEqual(await select(redis), { wait: "model-cooldown", until: NOW + 60_000 });
	assert.equal((await select(fakeRedis(), { acquireEndpoints: async (candidate) => candidate.model !== "primary" })).ref, fallback);
	assert.equal((await select(fakeRedis(), { acquireEndpoints: async () => false })).wait, "endpoint");
});

test("per-model dollar windows select only a model that can cover the entire reservation", async () => {
	const redis = fakeRedis();
	const limits = parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: `model:${primary}`, dayUsd: "0.0001" }] }), "limits.json");
	const row = modelDollarRows(limits, [primary])[0];
	redis.store.set(dayKey(new Date(NOW), row.keyPrefix), "1");
	const picked = await select(redis, { limits });
	assert.equal(picked.ref, fallback);
	assert.equal(picked.job.modelWhy, "fallback-window");
	assert.equal(redis.writes.length, 0);
	const uncapped = { ...job(), maxCostMicros: null, fallbackModels: [primary], models: [primary] };
	assert.equal((await selectFailoverJob(uncapped, { redis, limits, now: () => NOW, checkCandidate: async () => null })).refused, "model-failover-no-candidate", "missing cap is a permanent candidate problem, never an infinite window wait");
	assert.equal((await selectFailoverJob(uncapped, { redis, limits, now: () => NOW, checkCandidate: async () => null, reservationFor: () => 0 })).ref, primary, "a proven zero-rated model reserves zero even without a configured cap");
});

test("retries switch only with persisted safe provider failure; crashes and tools keep the previous model", async () => {
	const redis = fakeRedis();
	await markModelCooldown(redis, primary, { kind: "overloaded" }, { now: () => NOW });
	assert.equal((await select(redis, { retry: true })).refused, "model-failover-no-candidate", "missing attempt state never guesses a previous model");
	assert.equal((await select(redis, { retry: true, retryNeverStarted: true })).ref, primary, "a trusted never-started record proves no model ran");
	await writeModelAttempt(redis, "queue:j", { ref: fallback });
	assert.ok(redis.writes.every((row) => !row.args?.includes("PX")), "attempt locks cannot expire during an arbitrarily long pause");
	assert.equal((await select(redis, { retry: true })).ref, fallback, "even a prior fallback stays fixed after a crash");
	assert.equal((await select(redis, { retry: true, now: () => NOW + 90 * 24 * 3600_000 })).ref, fallback, "a pause longer than retention never permits unsafe cross-model replay");
	await writeModelAttempt(redis, "queue:j", { ref: primary, safe: true, failure: { kind: "rate-limited" } });
	assert.equal((await select(redis, { retry: true })).ref, fallback);
	assert.equal((await select(redis, { retry: true, recoveryModel: primary })).ref, primary, "checkpoint model outranks cooldown and safe retry");
});

test("context overflow requires strictly larger known context, never a global cooldown", async () => {
	const redis = fakeRedis();
	await writeModelAttempt(redis, "queue:j", { ref: primary, safe: true, failure: { kind: "context-overflow" } });
	const picked = await select(redis, { retry: true, modelView: (ref) => ({ contextWindow: ref === primary ? 100 : 200 }) });
	assert.equal(picked.ref, fallback);
	assert.equal(picked.job.modelWhy, "fallback-context");
	assert.equal((await select(redis, { retry: true, modelView: () => ({ contextWindow: 100 }) })).refused, "model-failover-no-candidate");
	assert.equal((await select(redis, { retry: true, modelView: () => ({ contextWindow: null }) })).refused, "model-failover-no-candidate");
});

test("the next attempt excludes its failed model even when retry backoff outlasted Retry-After", async () => {
	const redis = fakeRedis();
	await markModelCooldown(redis, primary, { kind: "rate-limited", resetAt: NOW + 1000 }, { now: () => NOW });
	await writeModelAttempt(redis, "queue:j", { ref: primary, safe: true, failure: { kind: "rate-limited" } });
	assert.equal((await select(redis, { retry: true, now: () => NOW + 60_000 })).ref, fallback);
	assert.equal((await select(redis, { now: () => NOW + 60_000 })).ref, primary, "a different job can use the expired primary");
	assert.equal((await selectFailoverJob({ ...job(), fallbackModels: [primary] }, { redis, id: "queue:j", retry: true, now: () => NOW + 60_000, checkCandidate: async () => null })).refused, "model-failover-no-candidate", "the same failed model is not a transient wait when no alternative exists");
});

test("corrupt safe-attempt state never authorizes a model switch", async () => {
	const redis = fakeRedis();
	await writeModelAttempt(redis, "queue:j", { ref: primary, safe: true });
	await assert.rejects(() => readModelAttempt(redis, "queue:j"), /invalid model attempt/);
});

test("catalog candidate checks reject unknown/unboundable/credential/host candidates before spend", async () => {
	const models = { providers: { custom: { api: "openai-completions", baseUrl: "https://allowed.example/v1", models: [{ id: "m", name: "m", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }] } } };
	const candidate = { provider: "custom", model: "m", models: ["custom/m"] };
	const options = { models, credential: async () => ({ ok: true }), allowlist: ["allowed.example"], egress: true };
	assert.equal(await checkFailoverCandidate(candidate, options), "model-unpriced", "own completions require explicit max_tokens cap");
	models.providers.custom.compat = { maxTokensField: "max_tokens" };
	assert.equal(await checkFailoverCandidate(candidate, options), null);
	assert.equal(await checkFailoverCandidate(candidate, { ...options, credential: async () => ({ ok: false }) }), "provider-unconfigured");
	assert.equal(await checkFailoverCandidate(candidate, { ...options, allowlist: [] }), "model-host-unlisted");
	assert.equal(await checkFailoverCandidate({ ...candidate, model: "missing" }, options), "model-unknown");
	models.providers.custom.api = "pi-messages";
	assert.equal(await checkFailoverCandidate(candidate, options), "model-unpriced");
});

test("exit signal parsers accept closed data only and record the actual selected model", () => {
	const line = (fields) => JSON.stringify({ event: "exit", code: 1, ...fields });
	assert.deepEqual(parseExitProviderFailure(line({ providerFailure: { kind: "quota-exhausted", resetAt: NOW, text: "secret" } })), { kind: "quota-exhausted", resetAt: NOW });
	assert.equal(parseExitProviderFailure(line({ providerFailure: { kind: "arbitrary" } })), null);
	assert.equal(parseExitProviderFailure(line({ code: 2, providerFailure: { kind: "rate-limited" } })), null);
	assert.equal(parseExitToolsStarted(line({ toolsStarted: false })), false);
	assert.equal(parseExitReplaySafe(line({ replaySafe: "false" })), null);
	const record = buildRecord({ job: { id: "j", data: job() }, result: { outcome: "completed", provider: "anthropic", model: "fallback", modelWhy: "fallback-cooldown" } });
	assert.equal(record.provider, "anthropic");
	assert.equal(record.model, "fallback");
	assert.equal(record.modelWhy, "fallback-cooldown");
});

test("a real sink accepts failover evidence only from the signed decisive line, even when logs are disabled", async () => {
	const key = "ab".repeat(32);
	const genuine = { event: "exit", code: 1, reason: "error", providerFailure: { kind: "rate-limited", resetAt: NOW + 1000 }, toolsStarted: false, replaySafe: true };
	const body = JSON.stringify(genuine);
	const signed = `${body.slice(0, -1)},"auth":"${createHmac("sha256", key).update(body).digest("hex")}"}`;
	const forged = JSON.stringify({ ...genuine, providerFailure: { kind: "quota-exhausted" } });
	const read = async (text, options) => {
		const sink = makeLogSink({ enabled: false })("j", options);
		sink.write(Buffer.from(text));
		return sink.close();
	};
	const verified = await read(`${signed}\n${forged}\n`, { exitKey: key });
	assert.deepEqual(verified.providerFailure, genuine.providerFailure);
	assert.equal(verified.toolsStarted, false);
	assert.equal(verified.replaySafe, true);
	for (const options of [{ exitKey: key }, {}]) {
		const unsigned = await read(`${forged}\n`, options);
		assert.equal(unsigned.providerFailure, undefined);
		assert.equal(unsigned.toolsStarted, undefined);
		assert.equal(unsigned.replaySafe, undefined);
	}
});

function pickupFixture({ redis = fakeRedis(), container, endpoints = [], endpointSlots = makeInFlight(), checkCandidate = async () => null, data = {}, extraDeps = {}, extraOptions = {} } = {}) {
	const seen = [];
	const records = [];
	const processor = makeProcessor({
		redis, cancelJob: () => {}, stopContainer: () => {}, now: () => NOW,
		getSettings: () => ({ provider: "openai", model: "primary", maxTurns: 5, dailyCap: 10, concurrency: 3, softHoldPct: null }),
		modelEndpoints: () => endpoints, overlayModels: () => null, endpointSlots,
		recordRun: (record) => records.push(record),
		deps: { imagePreflight: async () => ({ ok: true, capabilities: ["exitAuth", "modelPolicy", "modelFailover"] }), now: new Date(NOW), checkFailoverCandidate: checkCandidate, mintToken: async () => (seen.push("mint"), "token"), isDefaultBranchProtected: async () => true, prepareWorkspace: async () => (seen.push("clone"), { workspaceDir: "/w", jobDir: "/j" }), cleanup: async () => {}, comment: async () => {}, log: () => {}, runContainer: async (ctx) => { seen.push(ctx.job); return container ? container(ctx) : { code: 0, aborted: false }; }, ...extraDeps },
		...extraOptions,
	});
	const queueJob = { id: "j", attemptsMade: 0, name: "github", data: { ...job(), ...data }, moveToDelayed: async () => seen.push("defer") };
	return { redis, processor, queueJob, records, seen, run: () => processor(queueJob, "lock", new AbortController().signal) };
}

test("pickup retries a signed 429 on fallback, transports singleton models and records before/after attribution", async () => {
	let attempt = 0;
	const fixture = pickupFixture({ container: async () => ++attempt === 1 ? { code: 1, exitLineCode: 1, exitAuth: "verified", aborted: false, providerFailure: { kind: "rate-limited", resetAt: NOW + 120_000 }, toolsStarted: false, replaySafe: true } : { code: 0, aborted: false } });
	await assert.rejects(fixture.run, { name: "InfraRetry" });
	fixture.queueJob.attemptsMade = 1;
	assert.equal((await fixture.run()).outcome, "completed");
	const containers = fixture.seen.filter((entry) => typeof entry === "object");
	assert.deepEqual(containers.map((entry) => [entry.provider, entry.model, entry.models]), [["openai", "primary", [primary]], ["anthropic", "fallback", [fallback]]]);
	assert.equal(fixture.records[0].error.providerFailure.kind, "rate-limited");
	assert.equal(fixture.records[1].result.modelWhy, "fallback-cooldown");
});

test("pickup cannot switch on tool activity, missing auth, missing replay proof or mismatched exit code", async () => {
	for (const override of [{ toolsStarted: true }, { exitAuth: "unverified" }, { replaySafe: undefined }, { exitLineCode: 0 }]) {
		const fixture = pickupFixture({ container: async () => ({ code: 1, exitLineCode: 1, exitAuth: "verified", aborted: false, providerFailure: { kind: "overloaded" }, toolsStarted: false, replaySafe: true, ...override }) });
		await assert.rejects(fixture.run, { name: "InfraRetry" });
		fixture.queueJob.attemptsMade = 1;
		await assert.rejects(fixture.run, { name: "InfraRetry" });
		assert.deepEqual(fixture.seen.filter((entry) => typeof entry === "object").map((entry) => entry.model), ["primary", "primary"]);
	}
});

test("pickup all-cooling deferral and all-invalid refusal precede mint, clone and count reservation", async () => {
	const cooling = pickupFixture();
	for (const ref of [primary, fallback]) await markModelCooldown(cooling.redis, ref, { kind: "quota-exhausted" }, { now: () => NOW });
	await assert.rejects(cooling.run, { name: "DelayedError" });
	assert.deepEqual(cooling.seen, ["defer"]);
	const invalid = pickupFixture({ checkCandidate: async () => "model-unpriced" });
	assert.equal((await invalid.run()).reason, "model-failover-no-candidate");
	assert.deepEqual(invalid.seen, []);
});

test("pickup skips a busy primary endpoint and releases every fallback lease after its container", async () => {
	const endpointSlots = makeInFlight();
	endpointSlots.tryAcquire("openai", 1);
	const released = [];
	const endpoints = ["openai", "anthropic"].map((id) => ({ id, host: `${id}.example`, port: 443, slots: 1 }));
	const fixture = pickupFixture({ endpointSlots, endpoints, extraOptions: {
		endpointSetFor: ({ job: candidate }) => endpoints.filter((endpoint) => endpoint.id === candidate.provider),
		endpointLease: { acquire: async (_id, { keyArgs }) => ({ release: async () => released.push(keyArgs) }) },
	} });
	assert.equal((await fixture.run()).model, "fallback");
	assert.equal(released.length, 1);
	assert.equal(endpointSlots.tryAcquire("anthropic", 1), true, "the selected endpoint is returned");
	assert.equal(endpointSlots.tryAcquire("openai", 1), false, "another job's busy primary is untouched");
});

test("a cooldown-store fault retries infrastructure before any paid step", async () => {
	const redis = fakeRedis();
	redis.get = async () => { throw new Error("offline"); };
	const fixture = pickupFixture({ redis });
	await assert.rejects(fixture.run, { name: "InfraRetry", reason: "container-never-started" });
	assert.deepEqual(fixture.seen, []);
});

test("signed provider failures diagnose legacy jobs without changing their executable policy", async () => {
	const fixture = pickupFixture({ data: { fallbackModels: undefined }, container: async () => ({ code: 1, exitLineCode: 1, exitAuth: "verified", aborted: false, providerFailure: { kind: "quota-exhausted" }, toolsStarted: false, replaySafe: true }) });
	await assert.rejects(fixture.run, { name: "InfraRetry" });
	assert.deepEqual(fixture.seen.find((entry) => typeof entry === "object").models, [primary, fallback]);
	assert.equal(fixture.records[0].error.providerFailure.kind, "quota-exhausted");
	assert.equal(fixture.records[0].error.modelWhy, undefined);
	assert.ok(fixture.redis.writes.every((row) => row.key.startsWith("dispatch:model-cooldown:")), "no retry lock or other fresh redis dependency for legacy jobs");
});

test("all recovering jobs pin the checkpoint model before image checks, even with no fallback configuration", async () => {
	const checked = [];
	const fixture = pickupFixture({ data: { recoveryOf: "old", recover: true, fallbackModels: undefined, models: undefined }, extraDeps: {
		workspaceCheckpointer: { readManifest: async () => ({ ok: true, manifest: { provider: "anthropic", model: "fallback" } }) },
		imagePreflight: async (candidate) => { checked.push(candidate); return { missing: "old-image" }; },
	} });
	assert.equal((await fixture.run()).reason, "job-image-missing");
	assert.deepEqual(checked.map((candidate) => [candidate.provider, candidate.model]), [["anthropic", "fallback"]]);
	assert.deepEqual(fixture.seen, []);
	const missing = pickupFixture({ data: { recoveryOf: "old", recover: true, fallbackModels: undefined }, extraDeps: { workspaceCheckpointer: { readManifest: async () => ({ absent: true }) } } });
	assert.equal((await missing.run()).reason, "recovery-checkpoint-absent");
	assert.deepEqual(missing.seen, []);
});

test("checkpoint model outside the current reviewed ceiling refuses before any token or clone", async () => {
	const fixture = pickupFixture({ data: { recoveryOf: "old", recover: true, fallbackModels: undefined, models: [primary] }, extraDeps: { workspaceCheckpointer: { readManifest: async () => ({ ok: true, manifest: { provider: "anthropic", model: "fallback" } }) } } });
	assert.equal((await fixture.run()).reason, "model-not-allowed");
	assert.deepEqual(fixture.seen, []);
});

test("an opt-in job requires an image declaring authenticated model failover, before spend", async () => {
	for (const image of [{ modelFailoverUnsupported: "old", declared: ["modelPolicy", "exitAuth"] }, { ok: true, capabilities: ["modelPolicy", "modelFailover"] }]) {
		const fixture = pickupFixture({ extraDeps: { imagePreflight: async () => image } });
		assert.equal((await fixture.run()).reason, "job-image-model-failover-unsupported");
		assert.deepEqual(fixture.seen, []);
	}
});

test("post-exit cooldown persistence failure remains spent infrastructure with the actual metered fields", async () => {
	const redis = fakeRedis();
	redis.eval = async () => { throw new Error("offline after exit"); };
	const tokens = { input: 3, output: 1, total: 4, cost: 0.01, metered: true };
	const usage = { v: 1, piAi: "1.4.0", truncated: 0, models: [{ provider: "openai", model: "primary", calls: 1, cost: 0.01, total: 4 }] };
	const fixture = pickupFixture({ redis, container: async () => ({ code: 1, exitLineCode: 1, exitAuth: "verified", aborted: false, providerFailure: { kind: "rate-limited" }, toolsStarted: false, replaySafe: true, turns: 1, tokens, usage }) });
	await assert.rejects(fixture.run, (error) => {
		assert.equal(error.name, "InfraRetry");
		assert.equal(error.reason, "container-infra-exit");
		assert.equal(error.budgetReserved, true);
		assert.equal(error.exitCode, 1);
		assert.equal(error.provider, "openai");
		assert.equal(error.model, "primary");
		assert.deepEqual(error.tokens, tokens);
		assert.deepEqual(error.usage, usage);
		return true;
	});
	assert.equal(fixture.records[0].error.providerFailure.kind, "rate-limited");
});

test("a selected parent gives its outbox child the original reviewed ceiling, keeping inherited failover usable", async () => {
	const children = [];
	const request = JSON.stringify({ flow: "ok", task: "follow up", models: ["attacker/off-list"], fallbackModels: ["attacker/off-list"], reviewedModels: ["attacker/off-list"] });
	const collect = makeCollectChain({
		queue: {}, enqueue: async (_queue, child) => { children.push(child); return child.jobId; },
		readFlowGate: async () => ({ gate: "allow" }), config: { chainMaxPerJob: 2, chainDepthMax: 1 },
		fs: { readdirSync: () => ["request-1.json"], statSync: () => ({ size: Buffer.byteLength(request) }), lstatSync: () => ({ isFile: () => true }), readFileSync: () => request },
	});
	const fixture = pickupFixture({ data: { kind: "local", folder: "/srv/repo", flow: "ok", task: "parent" }, extraDeps: {
		prepareWorkspace: async () => ({ workspace: "/srv/repo", workspaceDir: "/srv/repo", jobDir: "/j", sha: "base" }),
		collectChain: collect,
	} });
	await markModelCooldown(fixture.redis, primary, { kind: "rate-limited", resetAt: NOW + 120_000 }, { now: () => NOW });
	assert.equal((await fixture.run()).outcome, "completed");
	const parentContainer = fixture.seen.find((entry) => typeof entry === "object");
	assert.equal(parentContainer.model, "fallback");
	assert.deepEqual(parentContainer.models, [fallback], "the executable policy stays narrow");
	assert.equal(children.length, 1);
	assert.deepEqual(children[0].models, [primary, fallback], "index binds the real queue job to the collector, preserving reviewed authorization");
	assert.deepEqual(children[0].fallbackModels, [fallback]);
	assert.equal(JSON.stringify(children[0]).includes("attacker"), false);
	const childChoice = await selectFailoverJob({ ...children[0], maxCostMicros: 100 }, { redis: fixture.redis, id: "queue:child", now: () => NOW, checkCandidate: async () => null });
	assert.equal(childChoice.ref, fallback, "the inherited fallback remains eligible under its inherited reviewed list");
	assert.deepEqual(childChoice.job.models, [fallback]);
});
