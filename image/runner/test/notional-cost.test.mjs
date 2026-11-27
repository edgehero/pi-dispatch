import assert from "node:assert/strict";
import { test } from "node:test";
import { COST_WAIT, createCostGuard, createPolicyGuard, createUsageMeter, makeHardStopStream, notionalProviders, startChildMeter, wrapModelRuntime } from "../src/usage-meter.mjs";
import { COST_CAP, MODEL_NOT_ALLOWED } from "../src/outcome.mjs";
import { GPT_5_5, SONNET_4_5 } from "./helpers/catalog-models.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #1008: the per-job cost cap counts only calls that can be billed. A call on a subscription with no paid extra
 * usage (the worker marks its PI_SUBSCRIPTION_AUTH entry `notional: true`) is admitted with no bound, no hold and no
 * charge, while the meter still prices it into `tokens.cost` and `costNotional`. A provider is notional only on
 * positive evidence: the verified entry's marker, the parent's subscription admission and the model guard. Every other
 * case counts the call, and each test below asserts at every step that spent + in flight stays within the cap.
 */

const instant = 1_800_000_000_000;
const now = () => instant;
const TOKEN = "sk-ant-oat01-fixture";
// The entry as the worker writes it (env-allowlist.mjs), a subscription with no paid extra usage marked notional.
const entry = (extra = {}) => ({ provider: "anthropic", connectionId: "fixture", adapter: "@gotgenes/pi-anthropic-auth@3.4.3", generation: 1, expiresAt: instant + 3_600_000, deadlineAt: instant + 1_800_000, ...extra });
// An API-key auxiliary beside it (the issue's OpenRouter case).
const AUXILIARY = Object.freeze({ provider: "openrouter", id: "vendor/auxiliary-fixture", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", maxTokens: 1000, contextWindow: 32768, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, compat: { maxTokensField: "max_tokens" } });
const LIST = [SONNET_4_5, AUXILIARY].map(({ provider, id }) => ({ provider, model: id }));
const admission = (provider) => provider === "anthropic";
const call = (model, extra = {}) => ({ method: "streamSimple", model, args: [{ messages: [{ role: "user", content: "fixture" }] }, { maxTokens: 10, ...extra }] });
const answer = (cost) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { total: cost } } });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function policy({ cap, notional = notionalProviders({ subscriptions: [entry({ notional: true })], subscriptionAdmission: admission, allowedModels: LIST }), ...rest } = {}) {
	return createPolicyGuard({ maxCostMicros: cap, allowedModels: LIST, subscriptions: [entry({ notional: true })], subscriptionAdmission: admission, env: { ANTHROPIC_OAUTH_TOKEN: TOKEN }, now, notional, ...rest });
}

/** The cap as a hard bound, asserted at every step. */
function withinCap(guard, cap, at) {
	const { spentMicros, inflightMicros } = guard.spend();
	assert.ok(spentMicros + inflightMicros <= cap, `${at}: spent ${spentMicros} + in flight ${inflightMicros} within the cap ${cap}`);
}

test("a notional subscription call passes under a 1-micro cap with no hold and no charge, and an API-key call beside it is refused", async () => {
	const guard = policy({ cap: 1 });
	withinCap(guard, 1, "start");
	const request = call(SONNET_4_5);
	assert.equal(guard.admit(request), null, "admitted though its bound is far above the cap");
	withinCap(guard, 1, "admitted");
	assert.deepEqual(guard.spend(), { spentMicros: 0, inflightMicros: 0 }, "no hold");
	const prepared = guard.prepare({ ...request, stop: (reason) => assert.fail(`stopped: ${reason}`) });
	assert.equal(prepared[1].apiKey, TOKEN, "the model guard still injects the subscription's own key");
	// The final payload is re-bounded for a counted call only: a notional one meets the model guard's checks alone.
	await prepared[1].onPayload({ model: SONNET_4_5.id, max_tokens: 64_000, messages: [] });
	withinCap(guard, 1, "final payload");
	guard.bind({ result: () => Promise.resolve(answer(12.5)) });
	await flush();
	withinCap(guard, 1, "settled");
	assert.deepEqual(guard.spend(), { spentMicros: 0, inflightMicros: 0 }, "no charge: $12.50 at list price is notional");
	assert.equal(guard.admit(call(AUXILIARY)), COST_CAP, "an API-key call is still judged against the cap");
	withinCap(guard, 1, "refused");
	assert.equal(guard.snapshot().costRefused, 1);
	assert.equal(guard.refusedWhy(), "over-cap");
});

test("a mixed attempt: the subscription route is free and the API-key auxiliary is bounded, held and charged", async () => {
	// 20,000 micro-dollars holds the auxiliary's bound (about 8,300: 8,192 tokens and the context at $1, ten output
	// tokens at $2) but not the subscription call's (about 31,000: the same input at the $3.75 cache-write rate).
	const cap = 20_000;
	const guard = policy({ cap });
	const counted = createPolicyGuard({ maxCostMicros: cap, allowedModels: LIST, subscriptions: [entry({ notional: true })], subscriptionAdmission: admission, env: { ANTHROPIC_OAUTH_TOKEN: TOKEN }, now });
	assert.equal(counted.admit(call(SONNET_4_5)), COST_CAP, "the premise: without the set, the subscription call does not fit");
	assert.equal(guard.admit(call(SONNET_4_5)), null);
	withinCap(guard, cap, "subscription admitted");
	guard.bind({ result: () => Promise.resolve(answer(3)) });
	assert.equal(guard.admit(call(AUXILIARY)), null);
	withinCap(guard, cap, "auxiliary admitted");
	assert.ok(guard.spend().inflightMicros > 0, "the auxiliary holds its bound");
	guard.bind({ result: () => Promise.resolve(answer(0.000003)) });
	await flush();
	withinCap(guard, cap, "both settled");
	assert.deepEqual(guard.spend(), { spentMicros: 3, inflightMicros: 0 }, "only the auxiliary's 3 micro-dollars are charged");
});

test("the set reaches the cost guard only with the model guard and a subscription admission", () => {
	const set = new Set(["anthropic"]);
	// No list: no model guard, so a call's provider proves nothing about its credential. The cost guard counts it.
	const unlisted = createPolicyGuard({ maxCostMicros: 1, subscriptions: [entry({ notional: true })], subscriptionAdmission: admission, notional: set });
	assert.equal(unlisted.model, null);
	assert.equal(unlisted.admit(call(SONNET_4_5)), COST_CAP);
	// No admission (a child process): the model guard refuses the subscription call, and the cost half would count it.
	const unadmitted = policy({ cap: 1, subscriptionAdmission: null, notional: set });
	assert.equal(unadmitted.admit(call(SONNET_4_5)), MODEL_NOT_ALLOWED);
	assert.equal(unadmitted.cost.admit(call(SONNET_4_5)), COST_CAP, "the cost half charges it too");
	withinCap(unadmitted, 1, "no admission");
	// The cost guard on its own takes the set as given, and refuses anything else for it.
	assert.throws(() => createCostGuard({ capMicros: 1, notional: ["anthropic"] }), /notional must be a Set/);
	const bare = createCostGuard({ capMicros: 1, notional: set });
	assert.equal(bare.admit(call(SONNET_4_5)), null);
	assert.equal(bare.admit(call(AUXILIARY)), COST_CAP);
	assert.deepEqual(bare.spend(), { spentMicros: 0, inflightMicros: 0 });
});

test("notionalProviders: only a verified entry marked exactly true, with an admission and a model list, makes a provider notional", () => {
	const ok = { subscriptionAdmission: admission, allowedModels: LIST };
	assert.deepEqual([...notionalProviders({ ...ok, subscriptions: [entry({ notional: true })] })], ["anthropic"]);
	// The doubt cases, each counted: an entry with no marker (an older worker never writes it, nor does a worker for a
	// connection with paid extra usage), an older worker's exact entry, a marker that is not `true`, no admission (a
	// child process), no list or an empty one, and no verified list at all.
	const older = { provider: "anthropic", connectionId: "fixture", adapter: "@gotgenes/pi-anthropic-auth@3.4.3", generation: 1, expiresAt: instant + 3_600_000, deadlineAt: instant + 1_800_000, root: "/staged", digest: "a".repeat(64) };
	for (const [why, given] of [
		["no marker", { ...ok, subscriptions: [entry()] }],
		["an older worker's entry", { ...ok, subscriptions: [older] }],
		["a string", { ...ok, subscriptions: [entry({ notional: "true" })] }],
		["a number", { ...ok, subscriptions: [entry({ notional: 1 })] }],
		["no admission", { ...ok, subscriptionAdmission: null, subscriptions: [entry({ notional: true })] }],
		["an admission that is not a function", { ...ok, subscriptionAdmission: true, subscriptions: [entry({ notional: true })] }],
		["no list", { ...ok, allowedModels: null, subscriptions: [entry({ notional: true })] }],
		["an empty list", { ...ok, allowedModels: [], subscriptions: [entry({ notional: true })] }],
		["no verified entries", { ...ok, subscriptions: null }],
	]) assert.equal(notionalProviders(given).size, 0, why);
	// One connection with paid extra usage beside one without: only the unmarked one counts.
	const both = notionalProviders({ ...ok, subscriptions: [entry({ notional: true }), { ...entry(), provider: "openai", adapter: "openai-chatgpt" }] });
	assert.deepEqual([...both], ["anthropic"]);
	assert.notEqual(notionalProviders({ ...ok, subscriptions: [entry({ notional: true })] }), notionalProviders({ ...ok, subscriptions: [entry({ notional: true })] }), "a new set each time, never a shared one");
});

test("issue #1057: a ChatGPT entry the worker left unmarked (purchased credits declared) is counted: bounded, held and charged", async () => {
	// The entry as the worker writes it for an `openai-chatgpt` connection with `extraUsageCreditMicros` (no marker).
	const chatgpt = (extra = {}) => ({ provider: "openai", connectionId: "chatgpt", adapter: "openai-chatgpt", generation: 1, expiresAt: instant + 3_600_000, deadlineAt: instant + 1_800_000, ...extra });
	const list = [{ provider: "openai", model: GPT_5_5.id }];
	const admitted = (provider) => provider === "openai";
	const guardFor = (entry, cap) => {
		const notional = notionalProviders({ subscriptions: [entry], subscriptionAdmission: admitted, allowedModels: list });
		return { notional, guard: createPolicyGuard({ maxCostMicros: cap, allowedModels: list, subscriptions: [entry], subscriptionAdmission: admitted, env: { OPENAI_API_KEY: "fixture.oauth.access" }, now, notional }) };
	};
	const tight = guardFor(chatgpt(), 1);
	assert.equal(tight.notional.size, 0, "not notional");
	assert.equal(tight.guard.admit(call(GPT_5_5)), COST_CAP, "refused under a 1-micro cap before it is sent");
	withinCap(tight.guard, 1, "refused");
	// $10 holds the call's bound, which the guard puts at about $9.70.
	const cap = 10_000_000;
	const { guard } = guardFor(chatgpt(), cap);
	assert.equal(guard.admit(call(GPT_5_5)), null);
	assert.ok(guard.spend().inflightMicros > 0, "the call holds its bound");
	withinCap(guard, cap, "admitted");
	guard.bind({ result: () => Promise.resolve(answer(0.25)) });
	await flush();
	assert.deepEqual(guard.spend(), { spentMicros: 250_000, inflightMicros: 0 }, "and is charged what it cost");
	// The meter reads it as billed: in cost, nothing notional.
	const meter = createUsageMeter({ maxTokens: null, notionalProviders: tight.notional });
	meter.record(answer(0.25).usage, { provider: "openai", modelId: GPT_5_5.id });
	assert.deepEqual([meter.snapshot().cost, meter.snapshot().costNotional], [0.25, 0]);
	// The marker alone decides, on ChatGPT as on Claude: the same entry marked (no credit) passes the 1-micro cap free.
	const marked = guardFor(chatgpt({ notional: true }), 1);
	assert.deepEqual([...marked.notional], ["openai"]);
	assert.equal(marked.guard.admit(call(GPT_5_5)), null);
	assert.deepEqual(marked.guard.spend(), { spentMicros: 0, inflightMicros: 0 });
});

test("a child process never exempts a call, whatever its inherited entries say", async () => {
	// The child preload builds its guard from the environment alone: no verified entries, no admission, no set. Its model
	// guard reads the wall clock (no clock reaches a child), so the inherited entry is current by the wall clock too.
	const clock = Date.now();
	const inherited = entry({ notional: true, expiresAt: clock + 3_600_000, deadlineAt: clock + 1_800_000 });
	const env = { PI_MAX_COST_MICROS: "1", PI_SUBSCRIPTION_AUTH: JSON.stringify([inherited]), ANTHROPIC_OAUTH_TOKEN: TOKEN };
	for (const extra of [{}, { PI_ALLOWED_MODELS: `anthropic/${SONNET_4_5.id}` }]) {
		const calls = [];
		await startChildMeter({ ModelRuntime: class {}, compat: { module: { name: "compat" }, fallbackModels: null }, env: { ...env, ...extra }, dir: tempDir("pi-dispatch-notional-child-"), name: "96.0123456789abcdef.json", state: {}, install: async (options) => (calls.push(options), { ok: true, covers: () => false }), onExit: () => {} });
		const { guard, meter } = calls[0];
		assert.equal(guard.admit(call(SONNET_4_5)), extra.PI_ALLOWED_MODELS ? MODEL_NOT_ALLOWED : COST_CAP, "refused under the 1-micro cap");
		assert.deepEqual(guard.spend(), { spentMicros: 0, inflightMicros: 0 });
		meter.record(answer(2).usage, { provider: "anthropic", modelId: SONNET_4_5.id });
		assert.equal(Object.hasOwn(meter.snapshot(), "costNotional"), false, "a child's meter has no notional part");
	}
});

test("the meter prices a notional call into cost and costNotional, and writes the key only for a job with subscription entries", () => {
	const meter = createUsageMeter({ maxTokens: null, notionalProviders: new Set(["anthropic"]) });
	meter.record({ input: 1, output: 1, totalTokens: 2, cost: { total: 1.25 } }, { provider: "anthropic", modelId: "claude" });
	meter.record({ input: 1, output: 1, totalTokens: 2, cost: { total: 0.5 } }, { provider: "openrouter", modelId: "vendor/aux" });
	meter.record({ input: 1, output: 1, totalTokens: 2 }, { provider: "anthropic", modelId: "claude" });
	meter.record({ input: 1, output: 1, totalTokens: 2, cost: { total: -3 } }, { provider: "anthropic", modelId: "claude" });
	const snap = meter.snapshot();
	assert.equal(snap.cost, 1.75, "the list price stays in cost");
	assert.equal(snap.costNotional, 1.25, "an unpriced call adds nothing, a negative price adds 0");
	assert.equal(snap.unpriced, 1);
	const keys = Object.keys(snap);
	assert.equal(keys[keys.indexOf("costUnreported") + 1], "costNotional", "right after costUnreported, the worker's TOKEN_KEYS order");
	// The children's cost is all billed: in cost, never in costNotional.
	meter.setChildren({ totals: { input: 1, output: 1, total: 2, cost: 4, calls: 1, unresolved: 0, unpriced: 0, sessions: 1 }, rows: [], processes: 1, unmetered: 0, costUnreported: 0 });
	assert.deepEqual([meter.snapshot().cost, meter.snapshot().costNotional], [5.75, 1.25]);
	// Subscription entries, none notional (an older worker, or paid extra usage): present and 0.
	assert.equal(createUsageMeter({ notionalProviders: new Set() }).snapshot().costNotional, 0);
	// No subscription entries: the exit line is the one it was.
	const plain = createUsageMeter({ maxTokens: null });
	plain.record({ input: 1, output: 1, totalTokens: 2, cost: { total: 1.25 } }, { provider: "anthropic", modelId: "claude" });
	assert.equal(Object.hasOwn(plain.snapshot(), "costNotional"), false);
	assert.throws(() => createUsageMeter({ notionalProviders: ["anthropic"] }), /notionalProviders must be a Set/);
	// Never above cost, however the floating sums round: both are added in the same order.
	const sums = createUsageMeter({ notionalProviders: new Set(["anthropic"]) });
	for (let i = 0; i < 500; i++) {
		sums.record({ input: 1, totalTokens: 1, cost: { total: (i % 7) * 0.1 + 0.000001 * i } }, { provider: i % 3 === 0 ? "openrouter" : "anthropic", modelId: "m" });
		assert.ok(sums.snapshot().costNotional <= sums.snapshot().cost, `step ${i}`);
	}
});

test("through the runtime wrapper: the subscription call is dispatched and metered at list price, the API-key call is braked", async () => {
	const cap = 1;
	const dispatched = [];
	class FakeRuntime {
		streamSimple(model) {
			dispatched.push(model.provider);
			return { result: () => Promise.resolve(answer(model.provider === "anthropic" ? 12.5 : 0.25)) };
		}
	}
	const notional = notionalProviders({ subscriptions: [entry({ notional: true })], subscriptionAdmission: admission, allowedModels: LIST });
	const meter = createUsageMeter({ maxCostMicros: cap, allowedModels: LIST, notionalProviders: notional });
	const guard = policy({ cap, notional });
	const hardStop = makeHardStopStream({ createStream: () => ({ push() {}, end(message) { this.message = message; }, result() { return Promise.resolve(this.message); } }) });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop, guard });
	try {
		const runtime = new FakeRuntime();
		const first = await runtime.streamSimple(SONNET_4_5, { messages: [] }, { maxTokens: 10 }).result();
		await flush();
		withinCap(guard, cap, "subscription settled");
		assert.equal(first.usage.cost.total, 12.5);
		assert.deepEqual([meter.snapshot().cost, meter.snapshot().costNotional], [12.5, 12.5]);
		const second = await runtime.streamSimple(AUXILIARY, { messages: [] }, { maxTokens: 10 }).result();
		assert.equal(second.errorMessage, "pi-dispatch: cost cap reached");
		withinCap(guard, cap, "auxiliary refused");
		assert.deepEqual(dispatched, ["anthropic"], "the refused call never reached a provider");
		assert.equal(meter.state.stopReason, COST_CAP);
	} finally {
		layer.restore();
	}
});

test("a notional admit settles a billed call's open slot at its bound first, never with the notional call's answer", async () => {
	// A billed call admitted and not yet bound (a router's synchronous forward leaves its slot so) is flushed by the next
	// admit at its bound. A notional admit must flush it too: left open, the notional call's bind would settle the billed
	// slot from the notional answer's price and undercharge billed spend.
	const cap = 1000;
	const guard = createCostGuard({ capMicros: cap, bound: () => 600, notional: new Set(["anthropic"]) });
	assert.equal(guard.admit(call(AUXILIARY)), null);
	withinCap(guard, cap, "billed slot open");
	assert.deepEqual(guard.spend(), { spentMicros: 0, inflightMicros: 600 });
	assert.equal(guard.admit(call(SONNET_4_5)), null, "the notional call is admitted");
	withinCap(guard, cap, "notional admitted");
	assert.deepEqual(guard.spend(), { spentMicros: 600, inflightMicros: 0 }, "the open billed slot was charged its bound");
	guard.bind({ result: () => Promise.resolve(answer(0.0001)) });
	await flush();
	withinCap(guard, cap, "notional bound");
	assert.deepEqual(guard.spend(), { spentMicros: 600, inflightMicros: 0 }, "the notional answer settles nothing");
});

test("a notional call on a model that is not the pinned one is refused: its list price must be the pinned price", () => {
	const pinned = { api: SONNET_4_5.api, cost: SONNET_4_5.cost, compat: SONNET_4_5.compat };
	const guard = createCostGuard({ capMicros: 1, notional: new Set(["anthropic"]) });
	assert.equal(guard.admit({ ...call(SONNET_4_5), priced: pinned }), null, "the pinned price admits it");
	for (const [why, priced] of [["a repriced model", { ...pinned, cost: { ...pinned.cost, input: 0, output: 0, cacheWrite: 0 } }], ["no entry at all", null]]) {
		const refusing = createCostGuard({ capMicros: 1, notional: new Set(["anthropic"]) });
		assert.equal(refusing.admit({ ...call(SONNET_4_5), priced }), COST_CAP, why);
		assert.equal(refusing.refusedWhy(), "unboundable", why);
		assert.deepEqual(refusing.spend(), { spentMicros: 0, inflightMicros: 0 });
	}
});

test("a notional call skips the outside reading, the turn and the queue: admitted at once with no claim, no notice and nothing charged, while a billed call takes the turn and waits", async () => {
	const SUBSCRIPTION = { provider: "anthropic", id: SONNET_4_5.id, api: SONNET_4_5.api };
	const seams = (over) => {
		const seen = { claims: 0, reads: 0, notices: [] };
		const guard = createCostGuard({
			capMicros: 1000,
			bound: (_method, model) => (model.provider === "anthropic" ? 999_999 : 600),
			external: () => (seen.reads += 1, over.outside()),
			externalInflight: () => 0,
			claim: () => (seen.claims += 1, over.turn()),
			outsideWaiting: () => over.othersWait(),
			onQueue: (n) => seen.notices.push(n),
			now: () => 0,
			setTimer: () => ({ ref() {}, unref() {} }),
			clearTimer: () => {},
			notional: new Set(["anthropic"]),
		});
		return { guard, seen };
	};
	const untouched = (guard, at) => {
		assert.deepEqual(guard.charges(), { spentMicros: 0, liftedMicros: 0, waited: guard.charges().waited }, `${at}: nothing charged or lifted`);
		assert.equal(guard.refusal(), null, `${at}: no refusal's numbers`);
		assert.equal(guard.refusedWhy(), null, `${at}: no refusal`);
	};
	// Another process waits and the turn is not ours: a billed call may not take room, a notional one takes none.
	const world = { outside: () => 0, turn: () => false, othersWait: () => true };
	const { guard, seen } = seams(world);
	assert.equal(guard.admit({ ...call(SUBSCRIPTION), waitable: true }), null, "admitted at once");
	assert.deepEqual([seen.claims, seen.reads, guard.waiting(), seen.notices.length], [0, 0, 0, 0], "no claim, no outside reading, no queue");
	assert.deepEqual(guard.spend(), { spentMicros: 0, inflightMicros: 0 });
	untouched(guard, "beside a waiter elsewhere");
	assert.equal(guard.admit({ ...call(AUXILIARY), waitable: true }), COST_WAIT, "the billed call asks for the turn and, not getting it, waits");
	assert.equal(seen.claims, 1);
	// Nobody waits elsewhere: our own billed call holds, the next billed one queues behind it, and a notional call passes both.
	world.othersWait = () => false;
	world.turn = () => true;
	const fresh = seams(world);
	assert.equal(fresh.guard.admit({ ...call(AUXILIARY), waitable: true }), null);
	fresh.guard.bind({ result: () => new Promise(() => {}) });
	assert.equal(fresh.guard.admit({ ...call(AUXILIARY), waitable: true }), COST_WAIT, "the second billed call does not fit beside the first's hold");
	fresh.guard.wait(() => {});
	await flush();
	const before = { claims: fresh.seen.claims, reads: fresh.seen.reads, notices: [...fresh.seen.notices], spend: fresh.guard.spend(), charges: fresh.guard.charges() };
	assert.equal(fresh.guard.waiting(), 1, "the premise: a billed waiter is queued");
	assert.equal(fresh.guard.admit({ ...call(SUBSCRIPTION), waitable: true }), null, "never behind the queue");
	assert.deepEqual([fresh.seen.claims, fresh.seen.reads, fresh.seen.notices, fresh.guard.waiting()], [before.claims, before.reads, before.notices, 1], "the queue and the turn are as they were");
	fresh.guard.bind({ result: () => Promise.resolve(answer(12.5)) });
	await flush();
	assert.deepEqual([fresh.guard.spend(), fresh.guard.charges()], [before.spend, before.charges], "its answer settles nothing");
	untouched(fresh.guard, "beside our own waiter");
	// An outside reading that fails refuses a billed call; a notional call never reads it.
	const blind = seams({ outside: () => Number.NaN, turn: () => true, othersWait: () => false });
	assert.equal(blind.guard.admit({ ...call(SUBSCRIPTION), waitable: true }), null);
	untouched(blind.guard, "with no outside reading");
	assert.equal(blind.guard.admit({ ...call(AUXILIARY), waitable: true }), COST_CAP);
	assert.equal(blind.guard.refusedWhy(), "external");
});
