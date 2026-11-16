import assert from "node:assert/strict";
import { test } from "node:test";
import { identityForModelSelection, modelSelectionKey, modelSelectionPolicyDigest, readModelSelection, commitModelSelection, armModelSelection, reuseModelSelection, allowModelSelectionQuotaReselection, markModelSelectionNeverStarted, finishModelSelection, keepModelSelection, dropModelSelection } from "../src/model-selection-state.mjs";
import { MODEL_ATTEMPT_FINISHED_TTL_MS } from "../src/retention.mjs";
import { modelSelectionRedis } from "./helpers/model-selection-redis.mjs";

const NOW = 1_800_000_000_000;
const pool = ["openai/a", "anthropic/b"];
const id = "opaque-queue-job-generation";
const seed = (redis) => commitModelSelection(redis, id, { ref: pool[0], candidates: pool, now: () => NOW });
const proof = { code: 1, exitLineCode: 1, exitAuth: "verified", toolsStarted: false, replaySafe: true, providerFailure: { kind: "quota-exhausted", subscriptionProvider: "openai", subscriptionCode: "usage_limit_reached" } };

test("selection identity distinguishes queues, occurrences and new jobs reusing ids at the same instant", () => {
	const job = { queueName: "github", id: "j", timestamp: NOW, data: { modelSelectionGeneration: "12345678-1234-4234-8234-123456789abc" } };
	const base = identityForModelSelection(job);
	for (const changed of [{ ...job, queueName: "local" }, { ...job, id: "other" }, { ...job, timestamp: NOW + 1 }, { ...job, data: { modelSelectionGeneration: "12345678-1234-4234-8234-123456789abd" } }]) assert.notEqual(identityForModelSelection(changed), base);
	assert.equal(identityForModelSelection({ ...job, queueName: undefined }, { queueName: "github" }), base);
	for (const changed of [{ ...job, data: {} }, { ...job, timestamp: undefined }, { ...job, id: null }, { ...job, queueName: undefined }]) assert.equal(identityForModelSelection(changed), null);
	assert.equal(modelSelectionPolicyDigest(pool), modelSelectionPolicyDigest([...pool].reverse()));
	assert.notEqual(modelSelectionPolicyDigest(pool), modelSelectionPolicyDigest(["openai/A", pool[1]]));
	assert.match(modelSelectionKey(base), /^dispatch:model-selection:v1:[a-f0-9]{64}$/);
});

test("initial selection and arming each have one CAS winner, with no state TTL while retry is possible", async () => {
	const redis = modelSelectionRedis();
	const choices = await Promise.all(pool.map((ref) => commitModelSelection(redis, id, { ref, candidates: pool, now: () => NOW })));
	assert.equal(choices.filter((choice) => choice.ok).length, 1);
	const state = await readModelSelection(redis, id);
	assert.equal(state.phase, "selected");
	assert.equal(redis.ttls.has(modelSelectionKey(id)), false);
	const arms = await Promise.all([armModelSelection(redis, id, state), armModelSelection(redis, id, state)]);
	assert.equal(arms.filter((arm) => arm.ok).length, 1);
	assert.equal((await readModelSelection(redis, id)).phase, "execution-possible");
	assert.equal((await allowModelSelectionQuotaReselection(redis, id, state, { beforeStart: true, quotaConfirmed: true })).ok, false, "stale selected token cannot clear a possible execution");
});

test("quota reselection requires trusted prestart or matching signed replay proof plus authoritative persistence", async () => {
	for (const patch of [{ toolsStarted: true }, { replaySafe: undefined }, { exitAuth: "unverified" }, { exitLineCode: 0 }, { code: 0, exitLineCode: 0 }, { aborted: true }, { lingering: true }, { providerFailure: { kind: "overloaded", subscriptionProvider: "openai" } }, { providerFailure: { kind: "quota-exhausted", subscriptionProvider: "anthropic" } }]) {
		const redis = modelSelectionRedis();
		const state = (await armModelSelection(redis, id, (await seed(redis)).state)).state;
		assert.equal((await allowModelSelectionQuotaReselection(redis, id, state, { result: { ...proof, ...patch }, quotaConfirmed: true })).ok, false);
		assert.equal((await readModelSelection(redis, id)).phase, "execution-possible");
	}
	const redis = modelSelectionRedis();
	let state = (await seed(redis)).state;
	assert.equal((await allowModelSelectionQuotaReselection(redis, id, state, { beforeStart: true })).ok, false);
	state = (await armModelSelection(redis, id, state)).state;
	assert.equal((await allowModelSelectionQuotaReselection(redis, id, state, { beforeStart: true, quotaConfirmed: true })).ok, false);
	assert.equal((await allowModelSelectionQuotaReselection(redis, id, state, { result: proof, quotaConfirmed: false })).ok, false);
	state = (await allowModelSelectionQuotaReselection(redis, id, state, { result: proof, quotaConfirmed: true })).state;
	assert.equal(state.phase, "quota-reselectable");
	const replacement = await commitModelSelection(redis, id, { expected: state, ref: pool[1], candidates: pool, modelWhy: "random-subscription-limit", previous: pool[0], attempt: 2, now: () => NOW });
	assert.equal(replacement.ok, true);
	assert.equal(replacement.state.previous, pool[0]);
	assert.equal((await allowModelSelectionQuotaReselection(redis, id, state, { result: proof, quotaConfirmed: true })).ok, false);
});

test("positive never-started evidence reopens only selection, never changes its model", async () => {
	const redis = modelSelectionRedis();
	let state = (await armModelSelection(redis, id, (await seed(redis)).state)).state;
	assert.equal((await markModelSelectionNeverStarted(redis, id, state)).ok, false);
	state = (await markModelSelectionNeverStarted(redis, id, state, { proven: true })).state;
	assert.equal(state.ref, pool[0]);
	assert.equal(state.phase, "selected");
	assert.equal((await allowModelSelectionQuotaReselection(redis, id, state, { beforeStart: true, quotaConfirmed: true })).ok, true);
});

test("finished retention preserves phase through Retry and late old completion cannot expire a newer attempt", async () => {
	const redis = modelSelectionRedis();
	let state = (await armModelSelection(redis, id, (await seed(redis)).state)).state;
	assert.equal(await finishModelSelection(redis, id, { attempt: 1, expectedRevision: state.revision - 1 }), false);
	assert.equal(await finishModelSelection(redis, id, { attempt: 1, expectedRevision: state.revision }), true);
	assert.equal(redis.ttls.get(modelSelectionKey(id)), MODEL_ATTEMPT_FINISHED_TTL_MS);
	assert.equal((await readModelSelection(redis, id)).phaseBeforeFinish, "execution-possible");
	assert.equal(await keepModelSelection(redis, id), true);
	assert.equal(redis.ttls.has(modelSelectionKey(id)), false);
	state = (await reuseModelSelection(redis, id, await readModelSelection(redis, id), { attempt: 2 })).state;
	assert.equal(state.phase, "execution-possible");
	assert.equal(await keepModelSelection(redis, id), true);
	assert.equal((await readModelSelection(redis, id)).revision, state.revision, "late console retry cleanup must not invalidate the new pickup's spawn token");
	assert.equal((await armModelSelection(redis, id, state)).ok, true);
	assert.equal(await finishModelSelection(redis, id, { attempt: 1 }), false);
	assert.equal(redis.ttls.has(modelSelectionKey(id)), false);
	await dropModelSelection(redis, id);
	assert.equal(await readModelSelection(redis, id), null);
	assert.equal(await finishModelSelection(redis, id, { attempt: 2 }), false);
	assert.equal(await keepModelSelection(redis, id), false);
});

test("malformed or mismatched state refuses, newer state holds, and infrastructure reads throw", async () => {
	const redis = modelSelectionRedis();
	const state = (await seed(redis)).state;
	for (const value of ["{", "null", JSON.stringify({ ...state, identityDigest: "0".repeat(64) }), JSON.stringify({ ...state, phase: "arbitrary" }), JSON.stringify({ ...state, unexpected: true })]) {
		redis.store.set(modelSelectionKey(id), value);
		assert.deepEqual(await readModelSelection(redis, id), { invalid: true });
	}
	redis.store.set(modelSelectionKey(id), JSON.stringify({ version: 2 }));
	assert.deepEqual(await readModelSelection(redis, id), { newer: true });
	await assert.rejects(readModelSelection({ get: async () => { throw new Error("unavailable"); } }, id), /unavailable/);
});
