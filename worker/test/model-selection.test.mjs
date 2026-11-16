import assert from "node:assert/strict";
import { test } from "node:test";
import { selectRandomModelJob, shuffledModels } from "../src/model-selection.mjs";
import { readModelSelection, modelSelectionKey, armModelSelection, allowModelSelectionQuotaReselection } from "../src/model-selection-state.mjs";
import { modelCooldownKey } from "../src/model-cooldowns.mjs";
import { parseScopedLimits, modelDollarRows } from "../src/scoped-limits.mjs";
import { dayKey } from "../src/budget.mjs";
import { modelSelectionRedis } from "./helpers/model-selection-redis.mjs";

const NOW = 1_800_000_000_000;
const pool = ["openai/a", "anthropic/b", "openai/c"];
const job = () => ({ provider: "ignored", model: "default", models: [...pool], modelSelection: { strategy: "random", candidates: [...pool] }, maxCostMicros: 100 });
const select = (redis, options = {}, override = {}) => selectRandomModelJob({ ...job(), ...override }, { redis, id: "job", now: () => NOW, randomInt: (max) => max - 1, checkCandidate: async () => null, ...options });
const exhausted = (until) => ({ ok: false, managed: true, wait: "subscription-quota", status: { state: "exhausted", until }, until: until ?? NOW + 60_000 });

test("exhaustive permutations choose each eligible candidate equally, independent of unavailable entries", async () => {
	for (const authored of [pool, [...pool].reverse()]) {
		const counts = new Map(pool.map((ref) => [ref, 0]));
		for (let a = 0; a < 3; a++) for (let b = 0; b < 2; b++) {
			const draws = [a, b];
			const picked = await select(modelSelectionRedis(), { randomInt: () => draws.shift(), checkCandidate: async (candidate) => candidate.model === "c" ? "model-unpriced" : null }, { modelSelection: { strategy: "random", candidates: authored } });
			counts.set(picked.ref, counts.get(picked.ref) + 1);
			assert.deepEqual(picked.job.models, [picked.ref]);
			assert.deepEqual(picked.job.modelSelection.candidates, authored);
			assert.deepEqual(picked.job.modelSelectionInfo, { strategy: "random", candidates: authored });
		}
		assert.deepEqual([...counts.values()], [3, 3, 0]);
	}
	assert.throws(() => shuffledModels(pool, () => -1), /invalid random/);
});

test("the whole pool is authorized before randomness and no implicit default joins it", async () => {
	const noDraw = () => assert.fail("no random draw for invalid policy");
	assert.equal((await select(modelSelectionRedis(), { randomInt: noDraw }, { models: pool.slice(0, 2) })).refused, "model-selection-policy-changed");
	for (const value of [null, { strategy: "weighted", candidates: pool }, { strategy: "random", candidates: [] }]) assert.equal((await select(modelSelectionRedis(), { randomInt: noDraw }, { modelSelection: value })).refused, "model-selection-no-candidate");
	assert.equal((await select(modelSelectionRedis(), { randomInt: noDraw }, { models: undefined })).refused, "model-selection-no-candidate", "the candidate pool cannot grant its own authority");
	const picked = await select(modelSelectionRedis());
	assert.equal(picked.ref, pool[0]);
	assert.equal(picked.job.model, "a");
});

test("billing and account identity remain pinned across retries and changes between inspection and candidate checks", async () => {
	const redis = modelSelectionRedis();
	const binding = "a".repeat(64);
	const policy = async () => ({ ok: true, managed: true, bindings: Object.fromEntries(pool.map((ref) => [ref, binding])) });
	const options = { subscriptionPolicyCheck: policy, subscriptionCheck: async () => ({ ok: true, managed: true, binding }) };
	const first = await select(redis, options);
	assert.equal(first.selection.billing, "subscription");
	assert.equal(first.selection.binding, binding);
	assert.equal(first.job.modelSelectionBinding, binding);
	assert.equal((await select(redis, { ...options, subscriptionPolicyCheck: async () => ({ ok: true, managed: false }) })).refused, "auth-binding-changed");
	assert.equal((await select(redis, { ...options, subscriptionPolicyCheck: async () => ({ ok: true, managed: true, bindings: { [pool[0]]: "b".repeat(64) } }) })).refused, "auth-binding-changed");
	assert.equal((await select(modelSelectionRedis(), { ...options, subscriptionCheck: async () => ({ ok: true, managed: [] }) })).refused, "auth-binding-changed");
	assert.equal((await select(modelSelectionRedis(), { ...options, subscriptionCheck: async () => ({ ok: true, managed: true, binding: "b".repeat(64) }) })).refused, "auth-binding-changed");
	const refreshed = await select(modelSelectionRedis(), { ...options, subscriptionPolicyCheck: async () => ({ ok: true, managed: true, bindings: {} }) });
	assert.equal(refreshed.selection.binding, binding, "a binding that becomes readable after inspection still enters the durable choice");
});

test("internal fixed-route jobs and command jobs refuse random selection before any draw", async () => {
	for (const patch of [{ command: "true" }, { canary: true }, { packageCanary: {} }, { watch: {} }, { answerDraft: {} }, { questionGrouping: {} }, { watchDecisionModel: { provider: "openai", id: "a" } }]) {
		assert.equal((await select(modelSelectionRedis(), { randomInt: () => assert.fail("unsupported selection") }, patch)).refused, "model-selection-no-candidate");
	}
});

test("ordinary retries, unspent deferrals and reordered pools reuse the committed exact choice", async () => {
	const redis = modelSelectionRedis();
	const first = await select(redis);
	for (const options of [{}, { retry: true, attempt: 2 }]) {
		const next = await select(redis, { ...options, randomInt: () => assert.fail("no second draw") }, { modelSelection: { strategy: "random", candidates: [...pool].reverse() } });
		assert.equal(next.ref, first.ref);
		assert.deepEqual(next.job.modelSelectionInfo.candidates, pool, "historical snapshot is the one used to draw");
	}
	assert.equal((await select(redis, {}, { modelSelection: { strategy: "random", candidates: pool.slice(1) } })).refused, "model-selection-policy-changed");
	assert.equal((await select(redis, {}, { modelSelection: { strategy: "random", candidates: pool.slice(0, 2) } })).refused, "model-selection-policy-changed", "even a nonselected removal cannot mutate the logical run's reviewed pool");
	const added = [...pool, "anthropic/d"];
	assert.equal((await select(redis, { randomInt: () => assert.fail("no draw around changed pool") }, { models: added, modelSelection: { strategy: "random", candidates: added } })).refused, "model-selection-policy-changed");
	assert.equal((await select(modelSelectionRedis(), { retry: true })).refused, "model-selection-state-unavailable");
	assert.equal((await select(modelSelectionRedis(), { retry: true, retryNeverStarted: true })).ref, pool[0]);
});

test("whole-pool billing checks cannot hide behind quota or permutation order and consume no candidate resources", async () => {
	for (const authored of [pool, [...pool].reverse()]) {
		const result = await select(modelSelectionRedis(), { randomInt: () => assert.fail("policy before draw"), subscriptionCheck: async (candidate) => candidate.provider === "openai" ? exhausted(NOW + 7 * 86_400_000) : { ok: true, managed: [] }, acquireEndpoints: async () => assert.fail("no leases") }, { modelSelection: { strategy: "random", candidates: authored } });
		assert.equal(result.refused, "auth-mixed-billing");
	}
	let checks = 0;
	assert.equal((await select(modelSelectionRedis(), { subscriptionPolicyCheck: async (whole) => { assert.equal(whole.provider, undefined); assert.deepEqual(whole.models, pool); return { ok: false, reason: "auth-mixed-billing" }; }, subscriptionCheck: async () => { checks++; } })).refused, "auth-mixed-billing");
	assert.equal(checks, 0);
});

test("shared subscription exhaustion excludes every affected model and retains truthful reset evidence", async () => {
	const result = await select(modelSelectionRedis(), { subscriptionCheck: async (candidate) => candidate.provider === "openai" ? exhausted(NOW + 7 * 86_400_000) : { ok: true, managed: true, binding: "a".repeat(64) } });
	assert.equal(result.ref, pool[1]);
	const all = await select(modelSelectionRedis(), { subscriptionCheck: async () => exhausted(NOW + 7 * 86_400_000), checkCandidate: async () => assert.fail("no credentials while quota blocked") });
	assert.deepEqual(all, { wait: "subscription-quota", until: NOW + 60_000, resetAt: NOW + 7 * 86_400_000 });
	const unknown = await select(modelSelectionRedis(), { subscriptionCheck: async (candidate) => exhausted(candidate.model === "a" ? null : NOW + 120_000) });
	assert.equal(unknown.resetAt, NOW + 120_000, "unknown alternatives cannot discard another observed reset");
	assert.equal(unknown.until, NOW + 60_000);
	assert.equal((await select(modelSelectionRedis(), { subscriptionCheck: async () => exhausted(null) })).resetAt, null, "polling does not manufacture a provider reset");
	const redis = modelSelectionRedis();
	redis.store.set(modelCooldownKey(pool[0]), JSON.stringify({ kind: "overloaded", until: NOW + 300_000 }));
	const combined = await select(redis, { subscriptionCheck: async (candidate) => exhausted(candidate.model === "a" ? NOW + 120_000 : NOW + 600_000) });
	assert.equal(combined.resetAt, NOW + 300_000, "both the chosen alternative's quota and cooldown must clear");
});

test("prestart authoritative quota can replace a selected choice but no other availability loss does", async () => {
	const redis = modelSelectionRedis();
	await select(redis);
	const next = await select(redis, { subscriptionCheck: async (candidate) => candidate.model === "a" ? exhausted(NOW + 100_000) : { ok: true, managed: true, binding: "a".repeat(64) } });
	assert.equal(next.ref, pool[1]);
	assert.equal(next.job.modelWhy, "random-subscription-limit");
	assert.equal(next.job.modelSelectionInfo.previous, pool[0]);
	const stable = modelSelectionRedis();
	await select(stable);
	assert.equal((await select(stable, { checkCandidate: async () => "provider-unconfigured", randomInt: () => assert.fail("no reroll") })).refused, "model-selection-no-candidate");
	assert.equal((await readModelSelection(stable, "job")).ref, pool[0]);
});

test("possible execution stays pinned even when quota blocks; only signed persisted quota permission permits the next draw", async () => {
	const redis = modelSelectionRedis();
	const first = await select(redis);
	const state = (await armModelSelection(redis, "job", first.selection)).state;
	const blocked = { subscriptionCheck: async (candidate) => candidate.model === "a" ? exhausted(NOW + 100_000) : { ok: true, managed: true, binding: "a".repeat(64) } };
	assert.equal((await select(redis, { ...blocked, retry: true, randomInt: () => assert.fail("unsafe replay") })).wait, "subscription-quota");
	assert.equal((await select(redis, { ...blocked, retry: true, retryNeverStarted: true, randomInt: () => assert.fail("stale never-started record cannot permit a new draw") })).wait, "subscription-quota");
	assert.equal((await readModelSelection(redis, "job")).phase, "execution-possible");
	const result = { code: 1, exitLineCode: 1, exitAuth: "verified", toolsStarted: false, replaySafe: true, providerFailure: { kind: "quota-exhausted", subscriptionProvider: "openai" } };
	assert.equal((await allowModelSelectionQuotaReselection(redis, "job", state, { result, quotaConfirmed: true })).ok, true);
	const next = await select(redis, { ...blocked, retry: true, attempt: 2 });
	assert.equal(next.ref, pool[1]);
	assert.equal(next.selection.attempt, 2);
});

test("recovery locks the originating exact model and refuses revoked or conflicting choices", async () => {
	const redis = modelSelectionRedis();
	assert.equal((await select(redis, { lockedModel: pool[1], retry: true, randomInt: () => assert.fail("no recovery draw") })).ref, pool[1]);
	assert.equal((await select(redis, { lockedModel: pool[0] })).refused, "model-selection-policy-changed");
	assert.equal((await select(modelSelectionRedis(), { lockedModel: "openai/revoked" })).refused, "model-selection-policy-changed");
	const blocked = await select(redis, { lockedModel: pool[1], subscriptionCheck: async () => exhausted(NOW + 100_000) });
	assert.equal(blocked.wait, "subscription-quota");
	assert.equal((await readModelSelection(redis, "job")).phase, "selected");
});

test("parked continuation pins its originating billing/account before the first commit and rejects missing binding", async () => {
	const binding = "a".repeat(64);
	const continuity = { ref: pool[1], billing: "subscription", binding };
	const options = { lockedModel: pool[1], subscriptionPolicyCheck: async () => ({ ok: true, managed: true, bindings: { [pool[1]]: binding } }), subscriptionCheck: async () => ({ ok: true, managed: true, binding }), randomInt: () => assert.fail("no continuation draw") };
	const next = await select(modelSelectionRedis(), options, { modelSelectionContinuation: continuity });
	assert.equal(next.ref, pool[1]);
	assert.equal(next.selection.binding, binding);
	for (const patch of [{ billing: "api", binding: null }, { billing: undefined }, { binding: undefined }, { ref: pool[0] }]) {
		assert.equal((await select(modelSelectionRedis(), options, { modelSelectionContinuation: { ...continuity, ...patch } })).refused, "model-selection-continuation-unavailable");
	}
	assert.equal((await select(modelSelectionRedis(), { ...options, subscriptionPolicyCheck: async () => ({ ok: true, managed: true, bindings: { [pool[1]]: "b".repeat(64) } }) }, { modelSelectionContinuation: continuity })).refused, "auth-binding-changed");
	assert.equal((await select(modelSelectionRedis(), options, { modelSelectionRecovery: continuity })).selection.binding, binding);
});

test("cooldown, model dollar room, credential refusal and endpoint busy are candidate gates before commitment", async () => {
	for (const reason of ["model-unknown", "model-unpriced", "provider-unconfigured", "model-host-unlisted"]) assert.equal((await select(modelSelectionRedis(), { checkCandidate: async (candidate) => candidate.model === "a" ? reason : null })).ref, pool[1]);
	const redis = modelSelectionRedis();
	redis.store.set(modelCooldownKey(pool[0]), JSON.stringify({ kind: "overloaded", until: NOW + 120_000 }));
	assert.equal((await select(redis)).ref, pool[1]);
	const capped = modelSelectionRedis();
	const limits = parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: `model:${pool[0]}`, dayUsd: "0.0001" }] }), "limits.json");
	capped.store.set(dayKey(new Date(NOW), modelDollarRows(limits, [pool[0]])[0].keyPrefix), "1");
	assert.equal((await select(capped, { limits })).ref, pool[1]);
	const releases = [];
	assert.equal((await select(modelSelectionRedis(), { acquireEndpoints: async (candidate) => candidate.model !== "a", releaseEndpoints: async (candidate) => releases.push(candidate.model) })).ref, pool[1]);
	assert.deepEqual(releases, ["a"]);
	assert.equal((await select(modelSelectionRedis(), { acquireEndpoints: async () => false })).wait, "endpoint");
});

test("concurrent picks agree on one committed choice and release the losing candidate lease", async () => {
	const redis = modelSelectionRedis();
	let acquired = 0;
	let releaseBarrier;
	const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
	const released = [];
	const options = { acquireEndpoints: async () => { if (++acquired === 2) releaseBarrier(); await barrier; return true; }, releaseEndpoints: async (candidate) => released.push(candidate.model) };
	const picked = await Promise.all([select(redis, options), select(redis, { ...options, randomInt: () => 0 })]);
	assert.equal(picked[0].ref, picked[1].ref);
	assert.equal(released.length, 1);
	assert.equal((await readModelSelection(redis, "job")).ref, picked[0].ref);
});

test("store faults throw and release candidate holds; corrupt and future versions never redraw", async () => {
	const redis = modelSelectionRedis();
	let released = 0;
	redis.eval = async () => { throw new Error("offline"); };
	await assert.rejects(select(redis, { releaseEndpoints: async () => { released++; } }), /offline/);
	assert.equal(released, 1);
	for (const [raw, expected] of [["broken", { refused: "model-selection-state-unavailable" }], [JSON.stringify({ version: 2 }), { newer: true }]]) {
		redis.store.set(modelSelectionKey("job"), raw);
		assert.deepEqual(await select(redis, { randomInt: () => assert.fail("no draw") }), expected);
	}
});
