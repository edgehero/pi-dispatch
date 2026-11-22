import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertPoliciesEnforceable, createAllowanceGuard, createPolicyGuard, createUsageMeter, makeHardStopStream, notionalProviders, STOP_MESSAGES, wrapModelRuntime } from "../src/usage-meter.mjs";
import { parseRunnerEnv } from "../src/config.mjs";
import { COST_CAP, COST_CAP_UNENFORCEABLE, decideExit, EXIT_POLICY, SUBSCRIPTION_ALLOWANCE } from "../src/outcome.mjs";
import { SONNET_4_5 } from "./helpers/catalog-models.mjs";
import { verifySubscriptionAllowance } from "./fixtures/subscription-allowance-smoke.mjs";
import { createCostWarnings, LIMIT_WARNING_CUSTOM_TYPE, LIMIT_WARNINGS } from "../src/cost-warning.mjs";

/**
 * Issue #1008: the list-price allowance for subscription calls, `run.maxSubscriptionUsd`, sent to the runner as
 * PI_SUBSCRIPTION_ALLOWANCE_MICROS. A notional call (a subscription with no paid extra usage) is refused once the meter's
 * SETTLED notional cost is at or above the allowance, checked between calls: no bound, no hold, so a job may end above
 * its allowance by the calls in flight when it was reached. Running out stops the whole job as `subscription-allowance`.
 * The allowance never judges a billed call, and a billed call stays bounded by the cap, asserted at every step.
 */

const instant = 1_800_000_000_000;
const now = () => instant;
const TOKEN = "sk-ant-oat01-fixture";
const entry = (extra = {}) => ({ provider: "anthropic", connectionId: "fixture", adapter: "@gotgenes/pi-anthropic-auth@3.4.3", generation: 1, expiresAt: instant + 3_600_000, deadlineAt: instant + 1_800_000, notional: true, ...extra });
const AUXILIARY = Object.freeze({ provider: "openrouter", id: "vendor/auxiliary-fixture", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", maxTokens: 1000, contextWindow: 32768, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, compat: { maxTokensField: "max_tokens" } });
const LIST = [SONNET_4_5, AUXILIARY].map(({ provider, id }) => ({ provider, model: id }));
const admission = (provider) => provider === "anthropic";
const NOTIONAL = () => notionalProviders({ subscriptions: [entry()], subscriptionAdmission: admission, allowedModels: LIST });
const call = (model) => ({ method: "streamSimple", model, args: [{ messages: [{ role: "user", content: "fixture" }] }, { maxTokens: 10 }] });
const answer = (cost) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { total: cost } } });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const DOLLAR = 1_000_000;

/** The job's policy guard as run-job builds it: the model list, a subscription admission, the one notional set and the meter's own total. */
function policy({ cap = null, allowance = null, meter, notional = NOTIONAL(), ...rest }) {
	return createPolicyGuard({ maxCostMicros: cap, allowedModels: LIST, subscriptions: [entry()], subscriptionAdmission: admission, env: { ANTHROPIC_OAUTH_TOKEN: TOKEN }, now, notional, allowanceMicros: allowance, settledNotional: () => meter.notionalMicros(), ...rest });
}

/** The cap as a hard bound, asserted at every step of every test that has one. */
function withinCap(guard, cap, at) {
	const { spentMicros, inflightMicros } = guard.spend();
	assert.ok(spentMicros + inflightMicros <= cap, `${at}: spent ${spentMicros} + in flight ${inflightMicros} within the cap ${cap}`);
}

test("calls in flight when the allowance is reached still finish and count, so the job ends above it; the next subscription call is refused", async () => {
	const cap = 50_000;
	const meter = createUsageMeter({ maxTokens: null, maxCostMicros: cap, allowedModels: LIST, notionalProviders: NOTIONAL() });
	const guard = policy({ cap, allowance: 10 * DOLLAR, meter });
	// Three subscription calls start before any has settled: nothing is held, so each is admitted against $0 settled.
	const pending = [];
	for (let i = 0; i < 3; i++) {
		assert.equal(guard.admit(call(SONNET_4_5)), null, `call ${i} admitted with nothing settled`);
		withinCap(guard, cap, `call ${i} admitted`);
		let settle;
		pending.push(new Promise((resolve) => (settle = resolve)));
		guard.bind({ result: () => pending[i] });
		pending[i].settle = settle;
	}
	assert.equal(meter.notionalMicros(), 0, "nothing settled yet");
	// Each settles at $6 of list price, $18 in all: $8 past the $10 allowance, the overshoot by the calls in flight.
	for (const [i, promise] of pending.entries()) {
		promise.settle(answer(6));
		meter.record(answer(6).usage, { provider: "anthropic", modelId: SONNET_4_5.id });
		await flush();
		withinCap(guard, cap, `call ${i} settled`);
	}
	assert.equal(meter.notionalMicros(), 18 * DOLLAR);
	assert.deepEqual(guard.spend(), { spentMicros: 0, inflightMicros: 0 }, "the cap charged none of it");
	assert.equal(guard.admit(call(SONNET_4_5)), SUBSCRIPTION_ALLOWANCE, "the next subscription call is refused");
	withinCap(guard, cap, "refused");
	// The allowance never judges a billed call: the API-key auxiliary is still the cap's alone.
	assert.equal(guard.admit(call(AUXILIARY)), null, "a billed call is not refused by the allowance");
	withinCap(guard, cap, "billed admitted");
	assert.ok(guard.spend().inflightMicros > 0, "and the cap holds its bound as before");
});

test("at or above the allowance refuses, one micro-dollar below admits, read from the settled total at each call", () => {
	let settled = 0;
	const guard = createAllowanceGuard({ allowanceMicros: 5 * DOLLAR, notional: new Set(["anthropic"]), settled: () => settled });
	for (const [at, verdict] of [[0, null], [5 * DOLLAR - 1, null], [5 * DOLLAR, SUBSCRIPTION_ALLOWANCE], [5 * DOLLAR + 1, SUBSCRIPTION_ALLOWANCE]]) {
		settled = at;
		assert.equal(guard.admit(call(SONNET_4_5)), verdict, `settled ${at}`);
	}
	assert.equal(guard.state.refused, 2);
	assert.deepEqual(guard.snapshot(), { allowanceMicros: 5 * DOLLAR });
	// A malformed allowance reaches the runner as 0 (the worker's fail-closed reading): the first subscription call is refused.
	const closed = createAllowanceGuard({ allowanceMicros: 0, notional: new Set(["anthropic"]), settled: () => 0 });
	assert.equal(closed.admit(call(SONNET_4_5)), SUBSCRIPTION_ALLOWANCE);
	assert.equal(closed.admit(call(AUXILIARY)), null, "and a billed call still passes it");
});

test("the allowance never lets a billed call past the cap, and never counts one", async () => {
	const cap = 20_000;
	const meter = createUsageMeter({ maxTokens: null, maxCostMicros: cap, allowedModels: LIST, notionalProviders: NOTIONAL() });
	const guard = policy({ cap, allowance: 1000 * DOLLAR, meter });
	assert.equal(guard.admit(call(AUXILIARY)), null);
	withinCap(guard, cap, "first billed admitted");
	guard.bind({ result: () => Promise.resolve(answer(0.019)) });
	meter.record(answer(0.019).usage, { provider: "openrouter", modelId: AUXILIARY.id });
	await flush();
	withinCap(guard, cap, "first billed settled");
	assert.equal(meter.notionalMicros(), 0, "a billed call's price is never notional");
	// A second billed call does not fit the cap; the allowance's room changes nothing.
	assert.equal(guard.admit(call(AUXILIARY)), COST_CAP);
	withinCap(guard, cap, "second billed refused");
	// With an allowance and no cap at all, a billed call is not judged by anything here.
	const uncapped = policy({ allowance: 0, meter: createUsageMeter({ maxTokens: null, allowedModels: LIST, notionalProviders: NOTIONAL() }) });
	assert.equal(uncapped.admit(call(AUXILIARY)), null);
	assert.equal(uncapped.admit(call(SONNET_4_5)), SUBSCRIPTION_ALLOWANCE, "while the allowance of 0 refuses the subscription call");
});

test("the allowance judges only calls the cost guard admits without a charge: no proven subscription, nothing to refuse", () => {
	const meter = createUsageMeter({ maxTokens: null, notionalProviders: new Set() });
	// A child process (no admission) and a job with no model list: the provider does not prove the credential, so the set
	// never reaches the allowance, which refuses nothing, and the cap counts the call.
	for (const [why, guard] of [
		["no admission", policy({ allowance: 0, meter, subscriptionAdmission: null })],
		["no model list", createPolicyGuard({ allowanceMicros: 0, settledNotional: () => 0, notional: new Set(["anthropic"]), subscriptionAdmission: admission })],
		["no notional provider", policy({ allowance: 0, meter, notional: new Set() })],
	]) {
		assert.ok(guard.enforces.includes(SUBSCRIPTION_ALLOWANCE), `${why}: still installed, so the allowance is enforceable`);
		assert.equal(guard.allowance.admit(call(SONNET_4_5)), null, why);
	}
	// The set as given is a Set or nothing, and the reading is a function.
	assert.throws(() => createAllowanceGuard({ allowanceMicros: 1, notional: ["anthropic"], settled: () => 0 }), /notional must be a Set/);
	assert.throws(() => createAllowanceGuard({ allowanceMicros: 1, settled: null }), /settled must be a function/);
	for (const bad of [-1, 1.5, Number.NaN, "5", null]) assert.throws(() => createAllowanceGuard({ allowanceMicros: bad, settled: () => 0 }), /invalid PI_SUBSCRIPTION_ALLOWANCE_MICROS/, String(bad));
});

test("a reading that fails, or a model off its pinned price, refuses the subscription call: fail closed", () => {
	const logs = [];
	for (const reading of [() => { throw new Error("broken"); }, () => Number.NaN, () => -1, () => "0", () => Infinity]) {
		const guard = createAllowanceGuard({ allowanceMicros: DOLLAR, notional: new Set(["anthropic"]), settled: reading, log: (event, fields) => logs.push({ event, fields }) });
		assert.equal(guard.admit(call(SONNET_4_5)), SUBSCRIPTION_ALLOWANCE, String(reading));
	}
	assert.deepEqual(logs.at(-1), { event: "subscription_allowance_refused", fields: { why: "unreadable", allowance: DOLLAR } }, "numbers and a rule only");
	const pinned = { api: SONNET_4_5.api, cost: SONNET_4_5.cost, compat: SONNET_4_5.compat };
	const guard = createAllowanceGuard({ allowanceMicros: DOLLAR, notional: new Set(["anthropic"]), settled: () => 0 });
	assert.equal(guard.admit({ ...call(SONNET_4_5), priced: pinned }), null, "the pinned price admits it");
	assert.equal(guard.admit({ ...call(SONNET_4_5), priced: { ...pinned, cost: { ...pinned.cost, input: 0, output: 0 } } }), SUBSCRIPTION_ALLOWANCE, "a repriced model would settle at the caller's price");
});

test("through the runtime wrapper: the allowance stops the whole job, every later call is braked, and the exit is 2 subscription-allowance", async () => {
	const dispatched = [];
	class FakeRuntime {
		streamSimple(model) {
			dispatched.push(model.provider);
			return { result: () => Promise.resolve(answer(model.provider === "anthropic" ? 3 : 0.0001)) };
		}
	}
	const meter = createUsageMeter({ maxTokens: null, allowedModels: LIST, notionalProviders: NOTIONAL() });
	const guard = policy({ allowance: 5 * DOLLAR, meter });
	const hardStop = makeHardStopStream({ createStream: () => ({ push() {}, end(message) { this.message = message; }, result() { return Promise.resolve(this.message); } }) });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop, guard });
	try {
		const runtime = new FakeRuntime();
		for (let i = 0; i < 2; i++) {
			await runtime.streamSimple(SONNET_4_5, { messages: [] }, { maxTokens: 10 }).result();
			await flush();
		}
		assert.equal(meter.notionalMicros(), 6 * DOLLAR, "$6 settled, past the $5 allowance by the second call");
		const refused = await runtime.streamSimple(SONNET_4_5, { messages: [] }, { maxTokens: 10 }).result();
		assert.equal(refused.errorMessage, STOP_MESSAGES[SUBSCRIPTION_ALLOWANCE]);
		assert.equal(STOP_MESSAGES[SUBSCRIPTION_ALLOWANCE], "pi-dispatch: subscription allowance reached");
		assert.equal(meter.state.stopReason, SUBSCRIPTION_ALLOWANCE);
		// The whole job stops: a billed call after it is braked too, as after any stop.
		const after = await runtime.streamSimple(AUXILIARY, { messages: [] }, { maxTokens: 10 }).result();
		assert.equal(after.errorMessage, STOP_MESSAGES[SUBSCRIPTION_ALLOWANCE]);
		assert.deepEqual(dispatched, ["anthropic", "anthropic"], "neither refused call reached a provider");
		assert.deepEqual(decideExit({ budgetAborted: false, meterStop: meter.state.stopReason }), { code: EXIT_POLICY, reason: "subscription-allowance" });
	} finally {
		layer.restore();
	}
});

test("the exit line carries allowanceMicros after modelRefused only with an allowance; a job without one gets the guard it had before the allowance", () => {
	const meter = createUsageMeter({ maxTokens: null, notionalProviders: NOTIONAL() });
	const keys = Object.keys(policy({ cap: 1000, allowance: 7 * DOLLAR, meter }).snapshot());
	assert.deepEqual(keys.slice(-2), ["modelRefused", "allowanceMicros"], "the worker's TOKEN_KEYS order");
	assert.equal(policy({ cap: 1000, allowance: 7 * DOLLAR, meter }).snapshot().allowanceMicros, 7 * DOLLAR);
	const without = policy({ cap: 1000, meter });
	assert.equal(without.allowance, null);
	assert.equal(Object.hasOwn(without.snapshot(), "allowanceMicros"), false);
	assert.equal(without.enforces.includes(SUBSCRIPTION_ALLOWANCE), false);
	assert.equal(createPolicyGuard({ maxCostMicros: null, allowedModels: null }), null, "no policy at all is still no guard");
	// An allowance alone is a guard, refusing nothing without a proven subscription.
	const alone = createPolicyGuard({ allowanceMicros: DOLLAR, settledNotional: () => 0 });
	assert.deepEqual(alone.enforces, [SUBSCRIPTION_ALLOWANCE]);
	assert.deepEqual(alone.snapshot(), { allowanceMicros: DOLLAR });
});

test("an allowance the runner cannot apply before a call is refused as cost-cap-unenforceable, before any spend", () => {
	const facts = { meterOk: true, brake: true, enforces: [SUBSCRIPTION_ALLOWANCE] };
	assert.doesNotThrow(() => assertPoliciesEnforceable({ allowanceMicros: DOLLAR, ...facts }));
	assert.doesNotThrow(() => assertPoliciesEnforceable({ allowanceMicros: null, ...facts, enforces: [] }), "no allowance, nothing to enforce");
	for (const [why, given] of [["no meter", { ...facts, meterOk: false }], ["no brake", { ...facts, brake: false }], ["a guard for the cap only", { ...facts, enforces: [COST_CAP] }]]) {
		assert.throws(() => assertPoliciesEnforceable({ allowanceMicros: DOLLAR, ...given }), (error) => error.piDispatchExit === EXIT_POLICY && error.piDispatchReason === COST_CAP_UNENFORCEABLE && /^PI_SUBSCRIPTION_ALLOWANCE_MICROS is set but cannot be enforced before a call/.test(error.message), why);
	}
});

test("the meter's settled notional total in micro-dollars, rounded up, and 0 without subscription entries", () => {
	const meter = createUsageMeter({ maxTokens: null, notionalProviders: new Set(["anthropic"]) });
	assert.equal(meter.notionalMicros(), 0);
	meter.record({ input: 1, totalTokens: 1, cost: { total: 0.0000011 } }, { provider: "anthropic", modelId: "m" });
	assert.equal(meter.notionalMicros(), 2, "a fraction of a micro-dollar rounds up, so the allowance is reached no later than the dollars say");
	meter.record({ input: 1, totalTokens: 1, cost: { total: 4 } }, { provider: "openrouter", modelId: "m" });
	assert.equal(meter.notionalMicros(), 2, "a billed call adds nothing");
	const plain = createUsageMeter({ maxTokens: null });
	plain.record({ input: 1, totalTokens: 1, cost: { total: 4 } }, { provider: "anthropic", modelId: "m" });
	assert.equal(plain.notionalMicros(), 0);
	// A notional call whose cost cannot be read makes the total unknown, read as Infinity; costNotional stays what was read.
	for (const usage of [{ input: 1, totalTokens: 1 }, { input: 1, totalTokens: 1, cost: { total: Number.NaN } }, { input: 1, totalTokens: 1, cost: { total: -0.5 } }, { input: 1, totalTokens: 1, cost: { total: "1" } }, undefined]) {
		const broken = createUsageMeter({ maxTokens: null, notionalProviders: new Set(["anthropic"]) });
		broken.record({ input: 1, totalTokens: 1, cost: { total: 2 } }, { provider: "anthropic", modelId: "m" });
		broken.record(usage, { provider: "anthropic", modelId: "m" });
		assert.equal(broken.notionalMicros(), Infinity, JSON.stringify(usage ?? null));
		assert.equal(broken.snapshot().costNotional, 2, "the exit line keeps the sum of the prices that were read");
	}
	const billedBroken = createUsageMeter({ maxTokens: null, notionalProviders: new Set(["anthropic"]) });
	billedBroken.record({ input: 1, totalTokens: 1 }, { provider: "openrouter", modelId: "m" });
	assert.equal(billedBroken.notionalMicros(), 0, "a billed call's unreadable cost is the cap's floor rule, never the allowance's");
});

test("after a subscription call whose cost cannot be read, the next one is refused when an allowance is set, and nothing changes without one", async () => {
	for (const broken of [{ input: 10, output: 1, totalTokens: 11 }, { input: 10, output: 1, totalTokens: 11, cost: { total: Number.NaN } }, { input: 10, output: 1, totalTokens: 11, cost: { total: -1 } }, { input: 10, output: 1, totalTokens: 11, cost: { total: "0.01" } }]) {
		for (const allowance of [1000 * DOLLAR, null]) {
			const dispatched = [];
			class FakeRuntime {
				streamSimple(model) {
					dispatched.push(model.provider);
					return { result: () => Promise.resolve({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: dispatched.length === 1 ? broken : answer(0.01).usage }) };
				}
			}
			const meter = createUsageMeter({ maxTokens: null, allowedModels: LIST, notionalProviders: NOTIONAL() });
			const guard = policy({ allowance, meter, cap: allowance === null ? 1000 : null });
			const hardStop = makeHardStopStream({ createStream: () => ({ push() {}, end(message) { this.message = message; }, result() { return Promise.resolve(this.message); } }) });
			const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop, guard });
			try {
				const runtime = new FakeRuntime();
				await runtime.streamSimple(SONNET_4_5, { messages: [] }, { maxTokens: 10 }).result();
				await flush();
				const next = await runtime.streamSimple(SONNET_4_5, { messages: [] }, { maxTokens: 10 }).result();
				if (allowance === null) {
					assert.equal(next.errorMessage, undefined, `${JSON.stringify(broken.cost ?? null)}: no allowance, no stop`);
					assert.equal(meter.state.stopReason, null);
				} else {
					assert.equal(next.errorMessage, STOP_MESSAGES[SUBSCRIPTION_ALLOWANCE], `${JSON.stringify(broken.cost ?? null)}: fails closed`);
					assert.equal(meter.state.stopReason, SUBSCRIPTION_ALLOWANCE);
					assert.deepEqual(dispatched, ["anthropic"], "the refused call never reached a provider");
				}
			} finally {
				layer.restore();
			}
		}
	}
});

test("a model priced at zero is not bounded by the allowance, as the cap does not bound it: its calls add 0", () => {
	const meter = createUsageMeter({ maxTokens: null, notionalProviders: new Set(["anthropic"]) });
	const guard = createAllowanceGuard({ allowanceMicros: 1, notional: new Set(["anthropic"]), settled: () => meter.notionalMicros() });
	for (let i = 0; i < 50; i++) {
		assert.equal(guard.admit(call(SONNET_4_5)), null, `call ${i}`);
		meter.record({ input: 1000, output: 1000, totalTokens: 2000, cost: { total: 0 } }, { provider: "anthropic", modelId: "free" });
	}
	assert.equal(meter.notionalMicros(), 0);
});

test("under a cap, a notional call off its pinned price is refused by the cap's own rule first; without one, by the allowance", () => {
	const meter = createUsageMeter({ maxTokens: null, notionalProviders: NOTIONAL() });
	const pinned = { api: SONNET_4_5.api, cost: SONNET_4_5.cost, compat: SONNET_4_5.compat };
	const repriced = { ...call(SONNET_4_5), priced: { ...pinned, cost: { ...pinned.cost, input: 0, output: 0 } } };
	assert.equal(policy({ cap: 1_000_000, allowance: DOLLAR, meter }).admit(repriced), COST_CAP, "the cost guard stands before the allowance");
	assert.equal(policy({ allowance: DOLLAR, meter }).admit(repriced), SUBSCRIPTION_ALLOWANCE);
});

test("PI_SUBSCRIPTION_ALLOWANCE_MICROS is read by the cap's own rule: absent is no allowance, anything not a whole number refuses", () => {
	const base = { PI_PROVIDER: "anthropic", PI_MODEL: "claude", PI_MAX_TURNS: "5" };
	assert.equal(parseRunnerEnv(base).subscriptionAllowanceMicros, null);
	assert.equal(parseRunnerEnv({ ...base, PI_SUBSCRIPTION_ALLOWANCE_MICROS: "5000000" }).subscriptionAllowanceMicros, 5_000_000);
	assert.equal(parseRunnerEnv({ ...base, PI_SUBSCRIPTION_ALLOWANCE_MICROS: "0" }).subscriptionAllowanceMicros, 0);
	for (const bad of ["", "1e6", "+5", "-1", "1.5", "05"]) assert.throws(() => parseRunnerEnv({ ...base, PI_SUBSCRIPTION_ALLOWANCE_MICROS: bad }), /invalid PI_SUBSCRIPTION_ALLOWANCE_MICROS/, JSON.stringify(bad));
});

test("the image declares subscriptionAllowance, and verify-image.sh proves it with the baked runner's own allowance, offline", async () => {
	await verifySubscriptionAllowance();
	const docker = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
	const script = readFileSync(new URL("../../verify-image.sh", import.meta.url), "utf8");
	assert.match(docker, /LABEL dev\.pi-dispatch\.capabilities="[^"\n]*\bsubscriptionAllowance\b/);
	assert.match(script, /subscriptionAllowance\)[\s\S]*?--network none[\s\S]*?subscription-allowance-smoke\.mjs[\s\S]*?PI_SUBSCRIPTION_ALLOWANCE_MICROS=not-a-number[\s\S]*?;;/);
});

test("the warning at 70% of the subscription allowance: its own fixed text, once, on the meter's settled notional total, never on billed spend", () => {
	assert.match(LIMIT_WARNINGS["subscription-allowance"], /^pi-dispatch: about 70% of this job's subscription allowance is used\. Write your report now/);
	const meter = createUsageMeter({ maxTokens: null, notionalProviders: new Set(["anthropic"]) });
	const handlers = [];
	const sent = [];
	const warnings = createCostWarnings({ rootSessionId: "root" });
	// As run-job.mjs wires it: the allowance in micro-dollars, read through the meter's notionalMicros().
	warnings.watch({ name: "subscription-allowance", limit: 10 * DOLLAR, settled: () => meter.notionalMicros() });
	warnings.factory.factory({ on: (_event, handler) => handlers.push(handler), sendMessage: (message, options) => sent.push({ message, options }) });
	const turnEnd = () => handlers[0]({ type: "turn_end", toolResults: [{ role: "toolResult" }] }, { sessionManager: { getSessionId: () => "root" }, isIdle: () => false });
	meter.record({ input: 1, totalTokens: 1, cost: { total: 50 } }, { provider: "openrouter", modelId: "m" });
	meter.record({ input: 1, totalTokens: 1, cost: { total: 6.99 } }, { provider: "anthropic", modelId: "m" });
	turnEnd();
	assert.equal(sent.length, 0, "$6.99 of $10: billed spend never counts toward it");
	meter.record({ input: 1, totalTokens: 1, cost: { total: 0.01 } }, { provider: "anthropic", modelId: "m" });
	turnEnd();
	turnEnd();
	assert.deepEqual(sent, [{ message: { customType: LIMIT_WARNING_CUSTOM_TYPE, content: [{ type: "text", text: LIMIT_WARNINGS["subscription-allowance"] }], display: true, details: { limit: "subscription-allowance" } }, options: { deliverAs: "steer" } }], "at $7.00, once");
	assert.equal(warnings.warned("subscription-allowance"), true);
	// A total that cannot be read is no reading: no warning (the allowance refuses the next subscription call anyway).
	const broken = createUsageMeter({ maxTokens: null, notionalProviders: new Set(["anthropic"]) });
	const silent = createCostWarnings({ rootSessionId: "root" });
	silent.watch({ name: "subscription-allowance", limit: DOLLAR, settled: () => broken.notionalMicros() });
	const quiet = [];
	silent.factory.factory({ on: (_event, handler) => quiet.push(handler), sendMessage: () => assert.fail("no warning on an unknown total") });
	broken.record({ input: 1, totalTokens: 1 }, { provider: "anthropic", modelId: "m" });
	quiet[0]({ type: "turn_end", toolResults: [{ role: "toolResult" }] }, { sessionManager: { getSessionId: () => "root" }, isIdle: () => false });
});
