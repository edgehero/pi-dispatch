import assert from "node:assert/strict";
import { test } from "node:test";
import { makeProcessor } from "../src/index.mjs";
import { InfraRetry } from "../src/processor.mjs";
import { identityForModelSelection, readModelSelection, modelSelectionKey, finishModelSelection } from "../src/model-selection-state.mjs";
import { MODEL_SELECTION_FINISH } from "../src/model-selection-record.mjs";
import { modelSelectionRedis } from "./helpers/model-selection-redis.mjs";

const NOW = 1_800_000_000_000;
const pool = ["openai/a", "anthropic/b"];
function fixture({ container = async () => ({ code: 0, aborted: false }), runtime, data = {}, deps = {}, options = {}, redis = modelSelectionRedis(), jobId = "random-j" } = {}) {
	const seen = [], records = [];
	const processor = makeProcessor({
		redis, cancelJob: () => {}, stopContainer: () => {}, now: () => NOW,
		getSettings: () => ({ provider: "openai", model: "default", maxTurns: 5, dailyCap: 10, concurrency: 3, softHoldPct: null }),
		modelEndpoints: () => [], overlayModels: () => null, recordRun: (record) => records.push(record),
		deps: { imagePreflight: async () => ({ ok: true, capabilities: ["exitAuth", "modelPolicy", "modelFailover"] }), now: new Date(NOW), checkFailoverCandidate: async () => null, randomInt: (max) => max - 1, mintToken: async () => (seen.push("mint"), "token"), isDefaultBranchProtected: async () => true, prepareWorkspace: async () => (seen.push("clone"), { workspaceDir: "/w", jobDir: "/j" }), cleanup: async () => {}, comment: async () => {}, log: () => {}, runContainer: async (ctx) => { seen.push(ctx.job); return container(ctx); }, ...(runtime ? { subscriptionRuntime: runtime } : {}), ...deps },
		...options,
	});
	const queued = { queueName: "github", id: jobId, timestamp: NOW, attemptsMade: 0, name: "github", data: { kind: "github", repo: "org/repo", models: pool, modelSelection: { strategy: "random", candidates: pool }, modelSelectionGeneration: "12345678-1234-4234-8234-123456789abc", maxCostMicros: 100, ...data }, moveToDelayed: async (until) => seen.push({ delayed: until }) };
	return { redis, queued, seen, records, id: identityForModelSelection(queued), run: () => processor(queued, "lock", new AbortController().signal) };
}

const exhausted = () => ({ ok: false, managed: true, wait: "subscription-quota", until: NOW + 7 * 86_400_000, status: { state: "exhausted", bindingValid: true, until: NOW + 7 * 86_400_000 } });
const runtime = (overrides = {}) => ({ inspectPolicy: async () => ({ ok: true }), check: async () => ({ ok: true, managed: [] }), prepare: async () => ({ ok: true, snapshots: [] }), validate: async () => true, observe: async () => undefined, ...overrides });
const signedQuota = { code: 1, exitLineCode: 1, exitAuth: "verified", aborted: false, toolsStarted: false, replaySafe: true, providerFailure: { kind: "quota-exhausted", subscriptionProvider: "openai", subscriptionCode: "usage_limit_reached", resetAt: NOW + 120_000 } };

test("pickup commits and arms the selected singleton, publishes actual model and revision-guarded lifecycle stamp", async () => {
	const f = fixture();
	const result = await f.run();
	assert.equal(result.outcome, "completed");
	assert.equal(result.model, "a");
	const run = f.seen.find((value) => value?.model);
	assert.deepEqual(run.models, [pool[0]]);
	assert.deepEqual(run.modelSelection.candidates, pool);
	assert.equal((await readModelSelection(f.redis, f.id)).phase, "execution-possible");
	assert.deepEqual(f.queued[MODEL_SELECTION_FINISH], { attempt: 1, revision: 2 });
	assert.equal(await finishModelSelection(f.redis, f.id, { attempt: f.queued[MODEL_SELECTION_FINISH].attempt, expectedRevision: f.queued[MODEL_SELECTION_FINISH].revision }), true);
});

test("prestart exhausted quota yields a free bounded reconsideration then draws an eligible different subscription", async () => {
	let blocked = false;
	const f = fixture({ runtime: runtime({ check: async (job) => blocked && job.provider === "openai" ? exhausted() : { ok: true, managed: true }, prepare: async (job) => { if (job.provider === "openai") { blocked = true; return exhausted(); } return { ok: true, snapshots: [] }; } }) });
	await assert.rejects(f.run, { name: "DelayedError" });
	assert.deepEqual(f.seen, [{ delayed: NOW + 1_000 }]);
	assert.equal((await readModelSelection(f.redis, f.id)).phase, "quota-reselectable");
	assert.equal((await f.run()).model, "b");
	assert.equal(f.records.at(-1).result.modelWhy, "random-subscription-limit");
	assert.equal(f.seen.filter((value) => value?.model).length, 1);
});

test("quota exhausted between selector and immediate recheck also reconsiders before a weekly delay", async () => {
	let reads = 0;
	const f = fixture({ runtime: runtime({ check: async (job) => job.provider === "openai" && ++reads > 1 ? exhausted() : { ok: true, managed: true } }) });
	await assert.rejects(f.run, { name: "DelayedError" });
	assert.deepEqual(f.seen, [{ delayed: NOW + 1_000 }]);
	assert.equal((await readModelSelection(f.redis, f.id)).phase, "quota-reselectable");
	assert.equal((await f.run()).model, "b");
});

for (const stage of ["immediate recheck", "subscription prepare"]) test(`auxiliary quota exhausted during ${stage} preserves the selected root`, async () => {
	let reads = 0;
	const auxiliaryModels = ["openrouter/frontier"];
	const auxiliaryWait = () => ({ ...exhausted(), auxiliary: true });
	const f = fixture({
		data: { models: [...pool, ...auxiliaryModels], auxiliaryModels, maxCostUsd: "1" },
		deps: { imagePreflight: async () => ({ ok: true, capabilities: ["exitAuth", "modelPolicy", "modelFailover", "costCap"] }) },
		runtime: runtime({
			check: async () => stage === "immediate recheck" && ++reads > 1 ? auxiliaryWait() : { ok: true, managed: true },
			prepare: async () => stage === "subscription prepare" ? auxiliaryWait() : assert.fail("the immediate recheck must defer first"),
		}),
	});
	await assert.rejects(f.run, { name: "DelayedError" });
	assert.deepEqual(f.seen, [{ delayed: stage === "immediate recheck" ? NOW + 60_000 : NOW + 7 * 86_400_000 }]);
	const selected = await readModelSelection(f.redis, f.id);
	assert.equal(selected.phase, "selected", "an unrelated provider cannot grant root quota reselection");
	assert.equal(selected.ref, pool[0]);
});

test("signed safe quota can reselect only after successful observation and the existing next queue attempt", async () => {
	let blocked = false;
	let executions = 0;
	const f = fixture({ container: async () => ++executions === 1 ? signedQuota : { code: 0, aborted: false }, runtime: runtime({ check: async (job) => blocked && job.provider === "openai" ? exhausted() : { ok: true, managed: true }, observe: async () => { blocked = true; return { quotaExhausted: true }; } }) });
	await assert.rejects(f.run, { name: "InfraRetry" });
	assert.equal(executions, 1, "no recursive execution within a queue attempt");
	assert.equal((await readModelSelection(f.redis, f.id)).phase, "quota-reselectable");
	f.queued.attemptsMade = 1;
	assert.equal((await f.run()).model, "b");
	assert.deepEqual(f.seen.filter((value) => value?.model).map((value) => value.models), [[pool[0]], [pool[1]]]);
});

test("unsafe tools, missing signed proof and generic throttles never grant a replacement", async () => {
	for (const [patch, observation] of [[{ toolsStarted: true }, { quotaExhausted: true }], [{ replaySafe: undefined }, { quotaExhausted: true }], [{ exitAuth: "unverified" }, { quotaExhausted: true }], [{}, undefined]]) {
		const f = fixture({ container: async () => ({ ...signedQuota, ...patch }), runtime: runtime({ observe: async () => observation }) });
		await assert.rejects(f.run, { name: "InfraRetry" });
		assert.equal((await readModelSelection(f.redis, f.id)).phase, "execution-possible");
		f.queued.attemptsMade = 1;
		try { await f.run(); } catch (error) { assert.ok(["DelayedError", "InfraRetry"].includes(error.name)); }
		assert.ok(f.seen.filter((value) => value?.model).every((value) => value.model === "a"));
	}
});

test("a crash stays pinned and a positive never-started runtime verdict restores selected phase", async () => {
	for (const [reason, phase] of [["container-infra-exit", "execution-possible"], ["container-never-started", "selected"]]) {
		const f = fixture({ container: async () => { throw new InfraRetry("runtime failed", { reason }); } });
		await assert.rejects(f.run, { name: "InfraRetry" });
		assert.equal((await readModelSelection(f.redis, f.id)).phase, phase);
		f.queued.attemptsMade = 1;
		await assert.rejects(f.run, { name: "InfraRetry" });
		assert.deepEqual(f.seen.filter((value) => value?.model).map((value) => value.model), ["a", "a"]);
	}
});

test("missing, corrupt and newer selection state refuse or hold before mint/clone, including first-attempt stalls", async () => {
	for (const raw of [undefined, "broken", JSON.stringify({ version: 2 })]) {
		const f = fixture();
		f.queued.stalledCounter = 1;
		if (raw !== undefined) f.redis.store.set(modelSelectionKey(f.id), raw);
		if (raw?.includes('"version":2')) await assert.rejects(f.run, { name: "DelayedError" });
		else assert.equal((await f.run()).reason, "model-selection-state-unavailable");
		assert.equal(f.seen.includes("mint"), false);
		assert.equal(f.seen.includes("clone"), false);
	}
});

test("queued conflicting fixed policies and absent permission ceilings refuse before spending", async () => {
	for (const data of [{ provider: "openai" }, { model: "a" }, { provider: null }, { fallbackModels: [] }, { models: undefined }]) {
		const f = fixture({ data, deps: { randomInt: () => assert.fail("no invalid-policy draw") } });
		assert.equal((await f.run()).reason, Object.hasOwn(data, "models") ? "model-selection-no-candidate" : "model-selection-policy-changed");
		assert.deepEqual(f.seen, []);
	}
});

test("checkpoint recovery locks its physical model before image validation and cannot draw around revoked permission", async () => {
	const seen = [];
	const f = fixture({ data: { recoveryOf: "old", recover: true }, deps: { workspaceCheckpointer: { readManifest: async () => ({ ok: true, manifest: { provider: "anthropic", model: "b" }, modelSelection: { ref: pool[1], billing: null, binding: null } }) }, imagePreflight: async (candidate) => { seen.push(candidate); return { missing: "old-image" }; } } });
	assert.equal((await f.run()).reason, "job-image-missing");
	assert.deepEqual(seen.map((value) => value.models), [[pool[1]]]);
	assert.deepEqual(f.seen, []);
});

test("random recovery annotation missing, invalid, newer or unavailable cannot start a fresh paid run", async () => {
	for (const modelSelection of [undefined, { invalid: true }, { newer: true }, { unavailable: true }]) {
		const f = fixture({ data: { recoveryOf: "old", recover: true }, deps: { workspaceCheckpointer: { readManifest: async () => ({ ok: true, manifest: { provider: "anthropic", model: "b" }, modelSelection }) } } });
		if (modelSelection?.newer) await assert.rejects(f.run, { name: "DelayedError" });
		else if (modelSelection?.unavailable) await assert.rejects(f.run, { name: "InfraRetry" });
		else assert.equal((await f.run()).reason, "model-selection-continuation-unavailable");
		assert.equal(f.seen.includes("mint"), false);
		assert.equal(f.seen.includes("clone"), false);
	}
});

test("random recovery rereads its checkpoint binding before spending and refuses an intervening change", async () => {
	let reads = 0;
	const f = fixture({ data: { recoveryOf: "old", recovery: 1, recover: true }, deps: {
		imagePreflight: async () => ({ ok: true, piVersion: "1.5.2", capabilities: ["recover", "modelPolicy", "modelFailover", "exitAuth"] }),
		workspaceCheckpointer: { readManifest: async () => ({ ok: true, manifest: { provider: "anthropic", model: "b", piVersion: "1.5.2", venue: "local" }, modelSelection: { ref: pool[1], billing: ++reads === 1 ? null : "api", binding: null } }), remove: async () => ({ removed: true }) },
		runBudgetLedger: { remove: async () => {} }, readCheckpointPointer: async () => ({ attempt: 1 }), enqueueRecovery: async () => ({}),
	} });
	assert.equal((await f.run()).reason, "model-selection-continuation-unavailable");
	assert.equal(reads, 2);
	assert.deepEqual(f.seen, []);
});

test("an explicitly marked human continuation cannot draw when its host binding reader is missing", async () => {
	for (const data of [{ resume: true, parkedReply: true }, { resume: true, approvalRequestId: "request-1" }, { parkedReply: true }]) {
		const f = fixture({ data });
		const result = await f.run();
		assert.equal(result.reason, "model-selection-continuation-unavailable");
		assert.equal(await readModelSelection(f.redis, f.id), null);
		assert.deepEqual(f.seen, []);
	}
});


test("raw auxiliary jobs cannot acquire their explicit ceiling or cap from deployment defaults", async () => {
	const auxiliaryModels = ["openrouter/frontier"];
	for (const omitted of ["models", "maxCostUsd"]) {
		const f = fixture({
			data: { models: [...pool, ...auxiliaryModels], auxiliaryModels, maxCostUsd: "1", [omitted]: undefined },
			deps: { allowedModels: [...pool, ...auxiliaryModels] },
			options: { getSettings: () => ({ provider: "openai", model: "default", maxTurns: 5, dailyCap: 10, concurrency: 3, maxCostUsd: "5", softHoldPct: null }) },
			runtime: runtime({ inspectPolicy: async () => assert.fail("invalid queued authority reaches no auth inspection") }),
		});
		const result = await f.run();
		assert.equal(result.reason, "auth-route-unbounded");
		assert.equal(result.budgetReserved, false);
		assert.deepEqual(f.seen, []);
		assert.equal(await readModelSelection(f.redis, f.id), null);
	}
});

// Issue #968: a pool mixing billing classes on this host, openai/a an API key and anthropic/b a subscription.
const BINDING = "d".repeat(64);
const mixedCheck = (job) => job.provider === "anthropic" ? { ok: true, managed: [{ provider: "anthropic" }], rootManaged: true, binding: BINDING } : { ok: true, managed: [], binding: null };
const mixedPolicy = (classes) => async () => ({ ok: true, managed: true, classes, bindings: Object.fromEntries(Object.entries(classes).map(([ref, billing]) => [ref, billing === "subscription" ? BINDING : null])) });
const capped = { imagePreflight: async () => ({ ok: true, capabilities: ["exitAuth", "modelPolicy", "modelFailover", "costCap"] }) };

test("a pool mixing billing classes with no cap of its trigger's own is refused before anything is reserved or stored (issue #968)", async () => {
	const f = fixture({
		runtime: runtime({ inspectPolicy: mixedPolicy({ [pool[0]]: "api", [pool[1]]: "subscription" }), check: async () => assert.fail("no candidate auth read") }),
		deps: { randomInt: () => assert.fail("no draw") },
		// The deployment's cap gives the job a cap to run under, and still does not stand in for the trigger's.
		options: { getSettings: () => ({ provider: "openai", model: "default", maxTurns: 5, dailyCap: 10, concurrency: 3, maxCostUsd: "5", softHoldPct: null }) },
	});
	const result = await f.run();
	assert.equal(result.reason, "auth-route-unbounded");
	assert.equal(result.budgetReserved, false);
	assert.deepEqual(f.seen, []);
	assert.equal(await readModelSelection(f.redis, f.id), null);
});

test("with the trigger's cap, an API-key draw from a mixed pool reaches the subscription check, preparation and the container as api (issue #968)", async () => {
	const stages = [];
	const f = fixture({
		data: { maxCostUsd: "1" },
		deps: capped,
		runtime: runtime({
			inspectPolicy: mixedPolicy({ [pool[0]]: "api", [pool[1]]: "subscription" }),
			check: async (job) => { stages.push(["check", job.provider, job.modelSelectionBilling]); return mixedCheck(job); },
			prepare: async (job) => { stages.push(["prepare", job.provider, job.modelSelectionBilling]); return { ok: true, snapshots: [] }; },
		}),
	});
	const result = await f.run();
	assert.equal(result.outcome, "completed");
	assert.equal(result.model, "a");
	const state = await readModelSelection(f.redis, f.id);
	assert.equal(state.billing, "api");
	assert.equal(state.binding, null);
	assert.ok(stages.some(([stage]) => stage === "check") && stages.some(([stage]) => stage === "prepare"), JSON.stringify(stages));
	assert.ok(stages.every(([, provider, billing]) => provider === "openai" && billing === "api"), JSON.stringify(stages));
	assert.equal(f.seen.find((value) => value?.model).modelSelectionBilling, "api");
});

test("a pre-start quota reselection in a mixed pool stays in the subscription class it drew (issue #968)", async () => {
	const three = ["anthropic/b", "openai/a", "anthropic/c"];
	const asked = [];
	let reads = 0;
	const f = fixture({
		data: { models: three, modelSelection: { strategy: "random", candidates: three }, maxCostUsd: "1" },
		deps: capped,
		runtime: runtime({
			inspectPolicy: mixedPolicy({ [three[0]]: "subscription", [three[1]]: "api", [three[2]]: "subscription" }),
			check: async (job) => { asked.push(`${job.provider}/${job.model}`); return job.model === "b" && ++reads > 1 ? exhausted() : mixedCheck(job); },
		}),
	});
	await assert.rejects(f.run, { name: "DelayedError" });
	assert.equal((await readModelSelection(f.redis, f.id)).phase, "quota-reselectable");
	const result = await f.run();
	assert.equal(result.model, "c");
	assert.equal(f.records.at(-1).result.modelWhy, "random-subscription-limit");
	assert.equal((await readModelSelection(f.redis, f.id)).billing, "subscription");
	assert.equal(asked.includes(three[1]), false, "the API-key candidate is never asked about");
});

test("issue #1106: the runner's exit for OpenRouter's budget 403 cools the drawn model, the next random draw skips it, its retry waits, and the record keeps the provider's message", async () => {
	const { capExitMessage, classifyStopReason } = await import("../../image/runner/src/outcome.mjs");
	const { classifyProviderFailure } = await import("../../image/runner/src/provider-failure.mjs");
	const { createExitWriter } = await import("../../image/runner/src/exit-line.mjs");
	const { buildRecord, makeLogSink, providerMessageOf } = await import("../src/run-history.mjs");
	const { makeRedactor } = await import("../src/redact-secrets.mjs");
	const { MODEL_COOLDOWN_MAX_MS, MODEL_RECHECK_MS, readModelCooldown } = await import("../src/model-failover.mjs");
	// The exit line the runner writes for the measured answer (pi's message, the observer's 403), signed and read back by
	// the worker's own sink, then redacted and bounded as runContainer does: what the processor gets from the container.
	const budget = '403: {"message":"Workspace monthly budget of $50.00 exceeded. Contact your org admin. $50.07 of $50.00 used; resets 2026-12-01T00:00:00.000Z.","code":403,"metadata":{"limit_source":"openrouter_workspace_budget","scope":"workspace","limit_usd":50}}';
	const terminal = { role: "assistant", stopReason: "error", errorMessage: budget };
	const measured = { status: 403 };
	const outcome = classifyStopReason(terminal, () => false, measured);
	const providerFailure = classifyProviderFailure(terminal, measured);
	const key = "ab".repeat(32);
	let line = "";
	createExitWriter({ key, jobId: "random-j", write: (text) => (line += text), exit() {} }).writeExit({ ...capExitMessage(outcome), turns: 1, toolsStarted: false, replaySafe: true, ...(providerFailure ? { providerFailure } : {}) });
	const sink = makeLogSink({ enabled: false })("random-j", { exitKey: key });
	sink.write(Buffer.from(line));
	const closed = await sink.close();
	const exit = { code: outcome.code, aborted: false, ...closed, providerMessage: providerMessageOf(closed.providerMessage, { redact: makeRedactor({ values: ["sk-or-v1-test-not-a-key"] }) }) };

	const openrouter = "openrouter/deepseek/deepseek-v4.1-flash-1017";
	const drawn = [openrouter, "anthropic/b"];
	const logs = [];
	const f = fixture({ container: async () => exit, data: { models: drawn, modelSelection: { strategy: "random", candidates: drawn } }, deps: { log: (event, fields) => logs.push({ event, fields }) } });
	await assert.rejects(f.run, (error) => error.name === "InfraRetry" && error.reason === "container-infra-exit", "exit 1: the retryable infrastructure exit, never the credential refusal");
	assert.equal(f.seen.filter((value) => value?.model).length, 1);
	assert.equal(f.seen.find((value) => value?.model).provider, "openrouter", "the draw landed on the OpenRouter model");
	// The existing quota road: a six-hour cooldown on the exact model, shared by every worker.
	assert.deepEqual(await readModelCooldown(f.redis, openrouter, { now: () => NOW }), { ref: openrouter, kind: "quota-exhausted", until: NOW + MODEL_COOLDOWN_MAX_MS });
	// The record: container-infra-exit with the signed evidence and the provider's own words, which the log line carries too.
	const record = buildRecord(f.records.at(-1));
	assert.equal(record.reason, "container-infra-exit");
	assert.deepEqual(record.providerFailure, { kind: "quota-exhausted" });
	assert.equal(record.providerMessage, budget);
	assert.deepEqual(logs.filter((row) => row.event === "provider_error").map((row) => row.fields), [{ jobId: "random-j", provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017", reason: "error", message: budget }]);

	// Another job's random draw over the same pool passes the cooling model over and runs the other candidate.
	const next = fixture({ redis: f.redis, jobId: "random-k", data: { models: drawn, modelSelection: { strategy: "random", candidates: drawn } } });
	assert.equal((await next.run()).model, "b");
	assert.deepEqual(next.seen.filter((value) => value?.model).map((value) => value.models), [["anthropic/b"]]);
	assert.equal("providerMessage" in buildRecord(next.records.at(-1)), false, "a run with no provider error keeps no message");
	// The failed job keeps its API-key draw (issue #968): its retry waits, free, rechecking each minute, while the model cools.
	f.queued.attemptsMade = 1;
	await assert.rejects(f.run, { name: "DelayedError" });
	assert.deepEqual(f.seen.at(-1), { delayed: NOW + MODEL_RECHECK_MS });
	assert.equal(f.seen.filter((value) => value?.model).length, 1, "no second container while it cools");

	// A refused credential stays the policy stop, not retried, and its record and log keep the provider's words too.
	const refusal = "401: Incorrect API key provided.";
	const refusedLogs = [];
	const refused = fixture({ jobId: "random-r", container: async () => ({ code: 2, aborted: false, exitAuth: "verified", exitLineCode: 2, exitReason: "provider-auth-refused", providerMessage: refusal }), data: { models: drawn, modelSelection: { strategy: "random", candidates: drawn } }, deps: { log: (event, fields) => refusedLogs.push({ event, fields }) } });
	const policy = await refused.run();
	assert.deepEqual([policy.outcome, policy.reason], ["policy", "provider-auth-refused"]);
	assert.equal(buildRecord(refused.records.at(-1)).providerMessage, refusal);
	assert.deepEqual(refusedLogs.filter((row) => row.event === "provider_error").map((row) => row.fields.reason), ["provider-auth-refused"]);
});

test("issue #1106: the provider's message is kept only off a verified line that names the container's own exit and was not stopped by the worker", async () => {
	const { buildRecord } = await import("../src/run-history.mjs");
	const said = "403: Workspace monthly budget exceeded.";
	const verified = { code: 1, aborted: false, exitAuth: "verified", exitLineCode: 1, providerMessage: said };
	for (const [patch, why] of [[{ exitLineCode: 2 }, "a line naming another code than the container's"], [{ exitLineCode: null }, "no decisive line"], [{ code: 137, exitLineCode: 137, aborted: true }, "a container the worker stopped"], [{ exitAuth: "unverified" }, "an unverified line"]]) {
		const logs = [];
		const f = fixture({ container: async () => ({ ...verified, ...patch }), deps: { log: (event, fields) => logs.push({ event, fields }) } });
		try { await f.run(); } catch {}
		assert.equal("providerMessage" in buildRecord(f.records.at(-1)), false, why);
		assert.equal(logs.some((row) => row.event === "provider_error"), false, why);
	}
	// The control: the same answer with a matching, verified, unstopped line keeps it.
	const f = fixture({ container: async () => verified });
	await assert.rejects(f.run, { name: "InfraRetry" });
	assert.equal(buildRecord(f.records.at(-1)).providerMessage, said);
});
