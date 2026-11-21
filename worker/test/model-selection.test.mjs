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
// The policy seam names each root candidate's own billing class (issue #968); `every` gives the whole pool one.
const every = (billing, refs = pool) => Object.fromEntries(refs.map((ref) => [ref, billing]));

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
	const policy = async () => ({ ok: true, managed: true, classes: every("subscription"), bindings: Object.fromEntries(pool.map((ref) => [ref, binding])) });
	const options = { subscriptionPolicyCheck: policy, subscriptionCheck: async () => ({ ok: true, managed: true, binding }) };
	const first = await select(redis, options);
	assert.equal(first.selection.billing, "subscription");
	assert.equal(first.selection.binding, binding);
	assert.equal(first.job.modelSelectionBinding, binding);
	assert.equal((await select(redis, { ...options, subscriptionPolicyCheck: async () => ({ ok: true, managed: false, classes: every("api") }) })).refused, "auth-binding-changed");
	assert.equal((await select(redis, { ...options, subscriptionPolicyCheck: async () => ({ ok: true, managed: true, classes: every("subscription"), bindings: { [pool[0]]: "b".repeat(64) } }) })).refused, "auth-binding-changed");
	assert.equal((await select(modelSelectionRedis(), { ...options, subscriptionCheck: async () => ({ ok: true, managed: [] }) })).refused, "auth-binding-changed");
	assert.equal((await select(modelSelectionRedis(), { ...options, subscriptionCheck: async () => ({ ok: true, managed: true, binding: "b".repeat(64) }) })).refused, "auth-binding-changed");
	const refreshed = await select(modelSelectionRedis(), { ...options, subscriptionPolicyCheck: async () => ({ ok: true, managed: true, classes: every("subscription"), bindings: {} }) });
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

// Issue #968: a pool mixing one API-key candidate with two subscription candidates, under the trigger's own cap.
const mixed = ["openrouter/x", "anthropic/b", "anthropic/d"];
const BINDING = "c".repeat(64);
const classOf = (ref) => ref.startsWith("anthropic/") ? "subscription" : "api";
const mixedJob = (patch = {}) => ({ models: [...mixed], modelSelection: { strategy: "random", candidates: [...mixed] }, maxCostUsd: "1", maxCostMicros: 1_000_000, ...patch });
const mixedPolicy = async () => ({ ok: true, managed: true, classes: Object.fromEntries(mixed.map((ref) => [ref, classOf(ref)])), bindings: Object.fromEntries(mixed.map((ref) => [ref, classOf(ref) === "subscription" ? BINDING : null])) });
// The live per-candidate check: anthropic bound (exhausted where `blocked` says so), openrouter an API key.
const live = (blocked = () => false) => async (candidate) => candidate.provider === "anthropic" ? (blocked(candidate) ? exhausted(NOW + 100_000) : { ok: true, managed: true, binding: BINDING }) : { ok: true, managed: [], binding: null };
// Production passes both seams; an embedder may pass the per-candidate one alone, which classifies the same way.
const bothSeams = (check) => [{ subscriptionPolicyCheck: mixedPolicy, subscriptionCheck: check }, { subscriptionCheck: check }];

test("a pool mixing billing classes draws either class under the trigger's cap, and the choice carries its own class and binding", async () => {
	for (const [randomInt, ref, billing, binding] of [[(max) => max - 1, mixed[0], "api", null], [() => 0, mixed[1], "subscription", BINDING]]) {
		for (const seams of bothSeams(live())) {
			const redis = modelSelectionRedis();
			const picked = await select(redis, { ...seams, randomInt }, mixedJob());
			assert.equal(picked.ref, ref);
			assert.equal(picked.selection.billing, billing);
			assert.equal(picked.selection.binding, binding);
			assert.equal(picked.job.modelSelectionBilling, billing);
			assert.equal(picked.job.modelSelectionBinding, binding);
			const again = await select(redis, { ...seams, retry: true, attempt: 2, randomInt: () => assert.fail("a retry keeps its choice") }, mixedJob());
			assert.equal(again.ref, ref);
			assert.equal(again.job.modelSelectionBilling, billing, "a retry stays in the class its draw billed");
		}
	}
});

test("a pool mixing billing classes without the trigger's own positive cap refuses before any draw, lease, candidate check or state", async () => {
	const untouched = { randomInt: () => assert.fail("no draw"), acquireEndpoints: async () => assert.fail("no lease"), checkCandidate: async () => assert.fail("no credential check") };
	// A deployment cap alone (maxCostMicros set, no trigger value) does not count, and a malformed or zero value fails closed.
	for (const patch of [{ maxCostUsd: undefined }, { maxCostUsd: null }, { maxCostUsd: "not dollars" }, { maxCostUsd: "0" }, { maxCostMicros: null }, { maxCostMicros: 0 }]) {
		// Neither quota nor the authored order hides a class: an exhausted subscription candidate still counts as one.
		for (const order of [mixed, [...mixed].reverse()]) {
			for (const seams of [{ subscriptionPolicyCheck: mixedPolicy, subscriptionCheck: async () => assert.fail("no candidate auth read") }, { subscriptionCheck: live(() => true) }]) {
				const redis = modelSelectionRedis();
				assert.equal((await select(redis, { ...seams, ...untouched }, mixedJob({ modelSelection: { strategy: "random", candidates: order }, ...patch }))).refused, "auth-route-unbounded", JSON.stringify(patch));
				assert.equal(await readModelSelection(redis, "job"), null, "nothing is committed");
			}
		}
	}
	// A continuation is judged on the same pool.
	const continuation = { lockedModel: mixed[0], subscriptionPolicyCheck: mixedPolicy, subscriptionCheck: async () => assert.fail("no candidate auth read"), ...untouched };
	assert.equal((await select(modelSelectionRedis(), continuation, mixedJob({ maxCostUsd: undefined, modelSelectionContinuation: { ref: mixed[0], billing: "api", binding: null } }))).refused, "auth-route-unbounded");
});

test("a mixed pool whose trigger lost its cap refuses a retry before the stored choice is touched", async () => {
	const redis = modelSelectionRedis();
	await select(redis, { subscriptionPolicyCheck: mixedPolicy, subscriptionCheck: live() }, mixedJob());
	const before = redis.store.get(modelSelectionKey("job"));
	const refused = await select(redis, { subscriptionPolicyCheck: mixedPolicy, subscriptionCheck: async () => assert.fail("no candidate auth read"), retry: true, attempt: 2, randomInt: () => assert.fail("no draw") }, mixedJob({ maxCostUsd: undefined }));
	assert.equal(refused.refused, "auth-route-unbounded");
	assert.equal(redis.store.get(modelSelectionKey("job")), before, "byte-identical: the retry claimed no attempt and moved no revision");
});

test("a pool of API-key candidates alone needs no cap, as before", async () => {
	const apiOnly = ["openrouter/x", "openai/y"];
	const job = { models: apiOnly, modelSelection: { strategy: "random", candidates: apiOnly }, maxCostMicros: null };
	for (const seams of [{ subscriptionPolicyCheck: async () => ({ ok: true, managed: false, classes: every("api", apiOnly), bindings: every(null, apiOnly) }), subscriptionCheck: async () => ({ ok: true, managed: [] }) }, { subscriptionCheck: async () => ({ ok: true, managed: [] }) }]) {
		const picked = await select(modelSelectionRedis(), seams, job);
		assert.equal(picked.ref, apiOnly[0]);
		assert.equal(picked.selection.billing, "api");
	}
});

test("a whole-pool policy refusal stops before any draw or candidate check", async () => {
	let checks = 0;
	const refused = await select(modelSelectionRedis(), { randomInt: () => assert.fail("policy before draw"), subscriptionPolicyCheck: async (whole) => { assert.equal(whole.provider, undefined); assert.deepEqual(whole.models, pool); return { ok: false, reason: "local-folder-holds-subscription-auth" }; }, subscriptionCheck: async () => { checks++; } });
	assert.equal(refused.refused, "local-folder-holds-subscription-auth");
	assert.equal(checks, 0);
});

test("a first draw passes over a quota-blocked subscription candidate and commits the API-key candidate as api", async () => {
	for (const seams of bothSeams(live(() => true))) {
		const redis = modelSelectionRedis();
		const picked = await select(redis, { ...seams, randomInt: () => 0 }, mixedJob());
		assert.equal(picked.ref, mixed[0]);
		assert.equal(picked.selection.billing, "api");
		assert.equal(picked.selection.binding, null);
		assert.equal(picked.job.modelWhy, "random");
		assert.equal((await readModelSelection(redis, "job")).phase, "selected");
	}
});

// The reselection cases run with both seams, as production passes them: the per-candidate seam alone reads an exhausted
// candidate's binding as absent, and refuses a committed subscription choice before any reselection.
test("a quota reselection stays in the drawn class: the API-key candidate is passed over unread and another subscription is chosen", async () => {
	const redis = modelSelectionRedis();
	const first = await select(redis, { subscriptionPolicyCheck: mixedPolicy, subscriptionCheck: live(), randomInt: () => 0 }, mixedJob());
	assert.equal(first.ref, mixed[1]);
	assert.equal(first.selection.billing, "subscription");
	const asked = [];
	const logs = [];
	let draws = 0;
	const check = live((candidate) => candidate.model === "b");
	const next = await select(redis, {
		subscriptionPolicyCheck: mixedPolicy,
		subscriptionCheck: async (candidate) => { asked.push(`${candidate.provider}/${candidate.model}`); return check(candidate); },
		randomInt: (max) => { draws++; return max - 1; },
		log: (event, fields) => logs.push({ event, ...fields }),
	}, mixedJob());
	assert.equal(next.ref, mixed[2]);
	assert.equal(next.selection.billing, "subscription");
	assert.equal(next.selection.binding, BINDING);
	assert.equal(next.job.modelWhy, "random-subscription-limit");
	assert.equal(next.job.modelSelectionInfo.previous, mixed[1]);
	assert.equal(asked.includes(mixed[0]), false, "the API-key candidate's auth is never read during the reselection");
	assert.deepEqual(logs.filter((row) => row.model === mixed[0]), [{ event: "model_candidate_skipped", model: mixed[0], reason: "auth-mixed-billing" }]);
	assert.equal(draws, 2, "the reselection permutes the whole pool, as a first draw does");
});

test("a drawn subscription class with every candidate exhausted waits, and never commits the other class", async () => {
	const redis = modelSelectionRedis();
	await select(redis, { subscriptionPolicyCheck: mixedPolicy, subscriptionCheck: live(), randomInt: () => 0 }, mixedJob());
	const waited = await select(redis, { subscriptionPolicyCheck: mixedPolicy, subscriptionCheck: live(() => true), acquireEndpoints: async () => assert.fail("no lease"), checkCandidate: async () => assert.fail("no credential check") }, mixedJob());
	assert.equal(waited.wait, "subscription-quota");
	const state = await readModelSelection(redis, "job");
	assert.equal(state.ref, mixed[1]);
	assert.equal(state.billing, "subscription");
	assert.equal(state.phase, "quota-reselectable");
});

test("a committed API-key choice refuses once its own provider is bound, and an undrawn candidate's change keeps the choice", async () => {
	const redis = modelSelectionRedis();
	const first = await select(redis, { subscriptionPolicyCheck: mixedPolicy, subscriptionCheck: live() }, mixedJob());
	assert.equal(first.ref, mixed[0]);
	assert.equal(first.selection.billing, "api");
	const bound = async () => ({ ok: true, managed: true, classes: every("subscription", mixed), bindings: every(BINDING, mixed) });
	assert.equal((await select(redis, { subscriptionPolicyCheck: bound, subscriptionCheck: async () => assert.fail("refused before any candidate read"), randomInt: () => assert.fail("no draw") }, mixedJob())).refused, "auth-binding-changed");
	// One undrawn candidate turning API while the other stays a subscription: the pool still mixes, the drawn ref is unchanged.
	const changed = async () => ({ ok: true, managed: true, classes: { [mixed[0]]: "api", [mixed[1]]: "api", [mixed[2]]: "subscription" }, bindings: { [mixed[0]]: null, [mixed[1]]: null, [mixed[2]]: BINDING } });
	const kept = await select(redis, { subscriptionPolicyCheck: changed, subscriptionCheck: async () => ({ ok: true, managed: [], binding: null }), randomInt: () => assert.fail("no draw") }, mixedJob());
	assert.equal(kept.ref, mixed[0]);
	assert.equal(kept.job.modelSelectionBilling, "api");
});

test("a continuation's class must be its locked candidate's own class on this host", async () => {
	const options = { subscriptionPolicyCheck: mixedPolicy, subscriptionCheck: live(), randomInt: () => assert.fail("no continuation draw") };
	const api = await select(modelSelectionRedis(), { ...options, lockedModel: mixed[0] }, mixedJob({ modelSelectionContinuation: { ref: mixed[0], billing: "api", binding: null } }));
	assert.equal(api.ref, mixed[0]);
	assert.equal(api.selection.billing, "api");
	for (const [ref, continuity] of [[mixed[0], { billing: "subscription", binding: BINDING }], [mixed[1], { billing: "api", binding: null }]]) {
		assert.equal((await select(modelSelectionRedis(), { ...options, lockedModel: ref }, mixedJob({ modelSelectionContinuation: { ref, ...continuity } }))).refused, "model-selection-continuation-unavailable", ref);
	}
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
	const options = { lockedModel: pool[1], subscriptionPolicyCheck: async () => ({ ok: true, managed: true, classes: every("subscription"), bindings: { [pool[1]]: binding } }), subscriptionCheck: async () => ({ ok: true, managed: true, binding }), randomInt: () => assert.fail("no continuation draw") };
	const next = await select(modelSelectionRedis(), options, { modelSelectionContinuation: continuity });
	assert.equal(next.ref, pool[1]);
	assert.equal(next.selection.binding, binding);
	for (const patch of [{ billing: "api", binding: null }, { billing: undefined }, { binding: undefined }, { ref: pool[0] }]) {
		assert.equal((await select(modelSelectionRedis(), options, { modelSelectionContinuation: { ...continuity, ...patch } })).refused, "model-selection-continuation-unavailable");
	}
	assert.equal((await select(modelSelectionRedis(), { ...options, subscriptionPolicyCheck: async () => ({ ok: true, managed: true, classes: every("subscription"), bindings: { [pool[1]]: "b".repeat(64) } }) }, { modelSelectionContinuation: continuity })).refused, "auth-binding-changed");
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

test("random choice keeps only its selected root and the explicit auxiliary ceiling", async () => {
	const auxiliaryModels = ["openrouter/frontier", pool[1]];
	const seen = [];
	const picked = await select(modelSelectionRedis(), {
		subscriptionPolicyCheck: async candidate => { seen.push(candidate.models); return { ok: true, managed: true, classes: every("subscription"), bindings: Object.fromEntries(pool.map(ref => [ref, "a".repeat(64)])) }; },
		subscriptionCheck: async candidate => { seen.push(candidate.models); return { ok: true, managed: [{ provider: "openai" }, { provider: "anthropic" }], rootManaged: true, binding: "a".repeat(64) }; },
	}, { models: [...pool, auxiliaryModels[0]], auxiliaryModels });
	assert.equal(picked.ref, pool[0]);
	assert.deepEqual(seen[0], [...pool, auxiliaryModels[0]]);
	assert.deepEqual(picked.job.models, [pool[0], ...auxiliaryModels]);
	assert.deepEqual(picked.job.modelSelection.candidates, pool);
});

test("an exhausted auxiliary does not grant a selected root permission to change", async () => {
	const redis = modelSelectionRedis();
	const auxiliaryModels = ["anthropic/aux"];
	const policy = async () => ({ ok: true, managed: false, classes: every("api") });
	const override = { models: [...pool, ...auxiliaryModels], auxiliaryModels };
	const first = await select(redis, { subscriptionPolicyCheck: policy, subscriptionCheck: async () => ({ ok: true, rootManaged: false, managed: [{ provider: "anthropic" }] }) }, override);
	assert.equal(first.selection.billing, "api");
	const waited = await select(redis, { subscriptionPolicyCheck: policy, subscriptionCheck: async () => ({ ...exhausted(NOW + 120_000), rootManaged: false, auxiliary: true }) }, override);
	assert.equal(waited.wait, "subscription-quota");
	assert.equal((await readModelSelection(redis, "job")).phase, "selected");
});
