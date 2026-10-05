import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import {
	BOUND_OVERHEAD_TOKENS,
	callCostBound,
	completionsOwnServer,
	IMAGE_RESIZE_MAX,
	IMAGE_TOKEN_CEILINGS,
	SAMPLING_SAFE_KEYS,
	createCostGuard,
	createPolicyGuard,
	createUsageMeter,
	installProcessUsageMeter,
	makeHardStopStream,
	meterStopHandler,
	policyEnforcement,
	PRICED_APIS,
	VIRTUAL_MODEL_API,
	wrapModelRuntime,
	wrapProviderStreams,
	DISPATCH_MARK,
	dispatchToken,
} from "../src/usage-meter.mjs";
import { COST_CAP, MODEL_NOT_ALLOWED, TOKEN_BUDGET } from "../src/outcome.mjs";
import { dollarSettlement } from "../../../worker/src/dollar-budget.mjs";
import { AZURE_GPT_5_4, CODEX_SPARK, FABLE_5, GPT_5_4, GPT_5_5, GPT_5_5_CODEX, SONNET_4_5 } from "./helpers/catalog-models.mjs";

/**
 * Issue #501, part 2: the per-job cost cap, checked before every provider call (REQ-TOKEN-ACCOUNTING-AND-CAPS (d),
 * DES-DOLLAR-RESERVE-AND-SETTLE). PURE, like usage-meter.test.mjs: no pi import, no filesystem. The catalog rows
 * priced here are copies, held to the pinned catalog by pinned-api.test.mjs; every expected number is worked by
 * hand in its assertion message, so a wrong bound reads as arithmetic, not as a mystery integer.
 */

/** A context whose JSON is exactly `bytes` long, so inputBound is bytes + BOUND_OVERHEAD_TOKENS. */
function contextOfBytes(bytes) {
	const context = { m: "x".repeat(bytes - 8) };
	assert.equal(Buffer.byteLength(JSON.stringify(context)), bytes);
	return context;
}
/** The context whose inputBound is exactly `tokens`. */
const inputOf = (tokens) => contextOfBytes(tokens - BOUND_OVERHEAD_TOKENS);
const NO_ENV = Object.freeze({});

const FLAT = Object.freeze({ id: "flat", api: "openai-completions", provider: "local", baseUrl: "http://127.0.0.1:1", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1000, compat: { maxTokensField: "max_tokens" } });

test("callCostBound: a flat model is input bytes + overhead at the dearest input rate, plus its output cap", () => {
	assert.equal(BOUND_OVERHEAD_TOKENS, 8192);
	assert.equal(callCostBound("streamSimple", FLAT, inputOf(10_000), {}, NO_ENV), 10_000 * 1 + 1000 * 2, "no maxTokens asked: the model's 1000");
	assert.equal(callCostBound("streamSimple", FLAT, inputOf(10_000), { maxTokens: 100 }, NO_ENV), 10_000 + 100 * 2, "openai-completions sends a positive maxTokens");
	assert.equal(callCostBound("streamSimple", FLAT, inputOf(10_000), { maxTokens: 0 }, NO_ENV), 12_000, "0 is not sent (`if (options?.maxTokens)`), so the model's cap applies");
	// The byte bound is NOT the window: a context past contextWindow still costs its bytes.
	assert.equal(callCostBound("streamSimple", FLAT, inputOf(100_000), {}, NO_ENV), 100_000 + 2000, "contextWindow 32768 does not cap the input bound");
	// Bytes, not characters: a 3-byte character counts 3.
	const wide = { m: "€".repeat(1000) };
	assert.equal(callCostBound("streamSimple", FLAT, wide, {}, NO_ENV), (8 + 3000 + 8192) * 1 + 2000);
});

test("callCostBound: gpt-5.4's tier applies once the input bound passes 272k, and the responses multiplier is 2", () => {
	// openai on api.openai.com with no `sk-` key in the options: max_output_tokens may be dropped (Sign in with
	// ChatGPT), so the output bound is the model's 128000 whatever the caller asked.
	assert.equal(callCostBound("streamSimple", GPT_5_4, inputOf(200_000), { maxTokens: 100 }, NO_ENV), (200_000 * 2.5 + 128_000 * 15) * 2, "base rates: (500000 + 1920000) x 2");
	assert.equal(callCostBound("streamSimple", GPT_5_4, inputOf(300_000), {}, NO_ENV), (300_000 * 5 + 128_000 * 22.5) * 2, "tier above 272k: (1500000 + 2880000) x 2");
	assert.equal(callCostBound("streamSimple", GPT_5_4, inputOf(272_000), {}, NO_ENV), (272_000 * 2.5 + 128_000 * 15) * 2, "exactly 272k is not above the tier's threshold");
	// An `sk-` key the caller passed: max_output_tokens is sent, so the caller's cap bounds the output.
	assert.equal(callCostBound("streamSimple", GPT_5_4, inputOf(200_000), { maxTokens: 100, apiKey: "sk-test" }, NO_ENV), (200_000 * 2.5 + 100 * 15) * 2);
});

test("callCostBound: sonnet-4.5 prices a 1h cache write at 2 x input only when retention is long, resolved as pi does", () => {
	const short = 100_000 * 3.75 + 64_000 * 15; // cacheWrite 3.75 is the dearest input-side rate
	const long = 100_000 * 6 + 64_000 * 15; // 2 x input 3 = 6
	const ctx = inputOf(100_000);
	assert.equal(callCostBound("streamSimple", SONNET_4_5, ctx, {}, NO_ENV), short);
	assert.equal(callCostBound("streamSimple", SONNET_4_5, ctx, { cacheRetention: "long" }, NO_ENV), long, "options.cacheRetention");
	assert.equal(callCostBound("streamSimple", SONNET_4_5, ctx, { env: { PI_CACHE_RETENTION: "long" } }, NO_ENV), long, "options.env.PI_CACHE_RETENTION");
	assert.equal(callCostBound("streamSimple", SONNET_4_5, ctx, {}, { PI_CACHE_RETENTION: "long" }), long, "the process env");
	assert.equal(callCostBound("streamSimple", SONNET_4_5, ctx, { cacheRetention: "short" }, { PI_CACHE_RETENTION: "long" }), short, "an explicit cacheRetention wins over the env");
	assert.equal(callCostBound("streamSimple", SONNET_4_5, ctx, { env: { PI_CACHE_RETENTION: "short" } }, { PI_CACHE_RETENTION: "long" }), short, "options.env wins over the process env (getProviderEnvValue's ||)");
	assert.equal(callCostBound("streamSimple", { ...SONNET_4_5, api: "bedrock-converse-stream" }, ctx, { cacheRetention: "long" }, NO_ENV), long, "bedrock reports cacheWrite1h too");
	assert.equal(callCostBound("streamSimple", { ...FLAT, cost: SONNET_4_5.cost, maxTokens: 64_000 }, ctx, { cacheRetention: "long" }, NO_ENV), short, "no other api writes a 1h entry");
});

test("callCostBound: the synthetic long-context tier above 200k on the two Anthropic apis, for a table with no tiers", () => {
	// 2 x input, cache read and cache write, 1.5 x output: input 6, output 22.5, cacheRead 0.6, cacheWrite 7.5.
	assert.equal(callCostBound("streamSimple", SONNET_4_5, inputOf(300_000), {}, NO_ENV), 300_000 * 7.5 + 64_000 * 22.5);
	assert.equal(callCostBound("streamSimple", SONNET_4_5, inputOf(300_000), { cacheRetention: "long" }, NO_ENV), 300_000 * 12 + 64_000 * 22.5, "1h write at 2 x the tier's input");
	assert.equal(callCostBound("streamSimple", SONNET_4_5, inputOf(200_000), {}, NO_ENV), 200_000 * 3.75 + 64_000 * 15, "exactly 200k is not above it");
	// A catalog tier, where one exists, is the price: no synthetic one on top.
	const tiered = { ...SONNET_4_5, cost: { ...SONNET_4_5.cost, tiers: [{ inputTokensAbove: 500_000, input: 4, output: 16, cacheRead: 0.4, cacheWrite: 5 }] } };
	assert.equal(callCostBound("streamSimple", tiered, inputOf(300_000), {}, NO_ENV), 300_000 * 3.75 + 64_000 * 15);
	// Not on other apis.
	assert.equal(callCostBound("streamSimple", { ...FLAT, maxTokens: 10 }, inputOf(300_000), {}, NO_ENV), 300_000 + 20);
});

test("callCostBound: gpt-5.5 is multiplied by 2.5 on responses and on codex; codex never sends maxTokens", () => {
	const gpt55 = (200_000 * 5 + 128_000 * 30) * 2.5;
	assert.equal(callCostBound("streamSimple", GPT_5_5, inputOf(200_000), {}, NO_ENV), gpt55);
	assert.equal(callCostBound("streamSimple", GPT_5_5_CODEX, inputOf(200_000), {}, NO_ENV), gpt55);
	assert.equal(callCostBound("streamSimple", GPT_5_5_CODEX, inputOf(200_000), { maxTokens: 100 }, NO_ENV), gpt55, "codex puts no max_output_tokens on the request");
	assert.equal(callCostBound("streamSimple", CODEX_SPARK, inputOf(10_000), {}, NO_ENV), (10_000 * 1.75 + 128_000 * 14) * 2, "any other codex model: x 2");
});

test("callCostBound: azure applies no service-tier multiplier, and raises the output to 16 like openai-responses", () => {
	assert.equal(callCostBound("streamSimple", AZURE_GPT_5_4, inputOf(10_000), { maxTokens: 1 }, NO_ENV), 10_000 * 2.5 + 16 * 15, "x 1, and 1 token asked is 16 sent");
	assert.equal(callCostBound("streamSimple", AZURE_GPT_5_4, inputOf(10_000), { maxTokens: 100 }, NO_ENV), 10_000 * 2.5 + 100 * 15);
	const custom = { ...GPT_5_4, baseUrl: "http://127.0.0.1:1/v1" }; // not api.openai.com: max_output_tokens is sent
	assert.equal(callCostBound("streamSimple", custom, inputOf(10_000), { maxTokens: 1 }, NO_ENV), (10_000 * 2.5 + 16 * 15) * 2);
	assert.equal(callCostBound("streamSimple", { ...custom, compat: { supportsMaxOutputTokens: false } }, inputOf(10_000), { maxTokens: 1 }, NO_ENV), (10_000 * 2.5 + 128_000 * 15) * 2, "a model that does not send max_output_tokens");
});

test("callCostBound: an Anthropic model's fallback rates are tables too", () => {
	// fable-5's two fallbacks are cheaper today, so its own table is the bound.
	assert.equal(callCostBound("streamSimple", FABLE_5, inputOf(100_000), {}, NO_ENV), 100_000 * 12.5 + 128_000 * 50);
	// Nothing guarantees that: a dearer fallback is the bound.
	const cheap = { ...FABLE_5, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
	assert.equal(callCostBound("streamSimple", cheap, inputOf(100_000), {}, NO_ENV), 100_000 * 12.5 * 0.5 + 128_000 * 25, "the opus fallback: 6.25 and 25");
	// And a fallback's own long-context tier.
	assert.equal(callCostBound("streamSimple", cheap, inputOf(300_000), {}, NO_ENV), 300_000 * 12.5 + 128_000 * 37.5);
});

test("callCostBound: reasoning raises the output to the model's cap; classify is input only, or unboundable", () => {
	assert.equal(callCostBound("streamSimple", SONNET_4_5, inputOf(100_000), { maxTokens: 1000 }, NO_ENV), 100_000 * 3.75 + 1000 * 15);
	assert.equal(callCostBound("streamSimple", SONNET_4_5, inputOf(100_000), { maxTokens: 1000, reasoning: "high" }, NO_ENV), 100_000 * 3.75 + 64_000 * 15, "a thinking budget can lift maxTokens up to model.maxTokens");
	assert.equal(callCostBound("streamSimple", { ...SONNET_4_5, maxTokens: undefined }, inputOf(100_000), { maxTokens: 1000, reasoning: "high" }, NO_ENV), Infinity, "no model cap to raise to");
	assert.equal(callCostBound("classify", { ...FLAT, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }, inputOf(10_000), {}, NO_ENV), 10_000);
	assert.equal(callCostBound("classify", FLAT, inputOf(10_000), {}, NO_ENV), Infinity, "an output rate with no output bound");
});

test("callCostBound: all-zero rates are 0, an unpriced api or a broken table is Infinity", () => {
	const zero = { ...FLAT, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const cycle = {};
	cycle.self = cycle;
	assert.equal(callCostBound("streamSimple", zero, inputOf(10_000), {}, NO_ENV), 0);
	assert.equal(callCostBound("streamSimple", zero, cycle, {}, NO_ENV), 0, "a zero-rated model never needs the context");
	assert.equal(callCostBound("streamSimple", { ...zero, maxTokens: undefined }, inputOf(10_000), {}, NO_ENV), 0);
	assert.equal(callCostBound("streamSimple", { ...FLAT, api: "pi-messages" }, inputOf(10_000), {}, NO_ENV), Infinity, "pi-messages prices itself");
	assert.equal(callCostBound("streamSimple", { ...FLAT, api: "llama-cpp-classify" }, inputOf(10_000), {}, NO_ENV), Infinity);
	assert.equal(callCostBound("streamSimple", FLAT, cycle, {}, NO_ENV), Infinity, "a context that does not serialise");
	assert.equal(callCostBound("streamSimple", { ...FLAT, maxTokens: undefined }, inputOf(10_000), {}, NO_ENV), Infinity, "no output bound at all");
	for (const broken of [{ input: 1, output: 2, cacheRead: 0 }, { input: Number.NaN, output: 2, cacheRead: 0, cacheWrite: 0 }, { input: -1, output: 2, cacheRead: 0, cacheWrite: 0 }, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: [{ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }] }]) {
		assert.equal(callCostBound("streamSimple", { ...FLAT, cost: broken }, inputOf(10_000), {}, NO_ENV), Infinity, JSON.stringify(broken));
	}
	assert.equal(PRICED_APIS.length, 11);
	assert.ok(Object.isFrozen(PRICED_APIS));
});

test("callCostBound rounds UP to a whole micro-dollar", () => {
	const fractional = { ...FLAT, cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 } };
	assert.equal(callCostBound("streamSimple", fractional, inputOf(10_004), {}, NO_ENV), 1001, "1000.4 micro-dollars is 1001, never 1000");
});

// ── The guard ──────────────────────────────────────────────────────────────────────────────────────────

class FakeStream {
	constructor() {
		this.settled = new Promise((resolve, reject) => {
			this.settle = resolve;
			this.fail = reject;
		});
		this.settled.catch(() => {});
	}
	push() {}
	end(message) {
		this.settle(message);
	}
	result() {
		return this.settled;
	}
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** A settled, successful call's message: some input (a call reporting none is charged its bound), stopReason stop. */
const message = (cost, extra = {}) => ({ role: "assistant", stopReason: "stop", usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, ...extra, cost: { total: cost, ...(extra.cost ?? {}) } } });
const call = (model = FLAT) => ({ method: "streamSimple", model, args: [{}, {}] });

test("the guard admits while spent + in-flight + bound stays at or under the cap, and sums parallel calls", async () => {
	const logged = [];
	const guard = createCostGuard({ capMicros: 1000, bound: () => 600, log: (event, fields) => logged.push({ event, fields }) });
	assert.deepEqual([...guard.enforces], [COST_CAP]);
	const first = new FakeStream();
	assert.equal(guard.admit(call()), null, "0 + 0 + 600 <= 1000");
	guard.bind(first);
	assert.equal(guard.state.inflight, 600);
	// The parallel call: judged against the first one's worst case, which has not settled.
	assert.equal(guard.admit(call()), COST_CAP, "0 + 600 + 600 > 1000");
	assert.deepEqual(logged, [{ event: "cost_refused", fields: { bound: 600, spent: 0, inflight: 600, cap: 1000 } }], "numbers only");
	first.end(message(0.0001)); // 100 micro-dollars
	await flush();
	assert.deepEqual([guard.state.spent, guard.state.inflight], [100, 0], "the bound is replaced by the real cost");
	assert.equal(guard.admit(call()), null, "100 + 0 + 600 <= 1000");
	assert.deepEqual(guard.snapshot(), { costCapMicros: 1000, costRefused: 1, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0 });
});

test("the guard's comparison is strictly greater: landing exactly on the cap is allowed", () => {
	const guard = createCostGuard({ capMicros: 1200, bound: () => 600 });
	assert.equal(guard.admit(call()), null);
	guard.bind(new FakeStream());
	assert.equal(guard.admit(call()), null, "0 + 600 + 600 == 1200 is not over the cap");
	guard.bind(new FakeStream());
	assert.equal(guard.admit(call()), COST_CAP, "1800 > 1200");
	// A cap of 0 admits a zero-rated call and nothing else.
	const zero = createCostGuard({ capMicros: 0, bound: () => 0 });
	assert.equal(zero.admit(call()), null);
});

test("the guard refuses what it cannot bound: Infinity, generateImages, streamDeferred", () => {
	const logged = [];
	const guard = createCostGuard({ capMicros: 1_000_000_000, log: (event, fields) => logged.push(fields) });
	assert.equal(guard.admit({ method: "streamSimple", model: { ...FLAT, api: "pi-messages" }, args: [{}, {}] }), COST_CAP);
	assert.equal(guard.admit({ method: "generateImages", model: FLAT, args: [{}, {}] }), COST_CAP);
	assert.equal(guard.admit({ method: "streamDeferred", model: FLAT, args: [{ id: "h" }, {}] }), COST_CAP);
	assert.equal(guard.state.refused, 3);
	for (const fields of logged) assert.deepEqual(fields, { why: "unboundable", spent: 0, inflight: 0, cap: 1_000_000_000 });
	assert.throws(() => createCostGuard({ capMicros: -1 }), /invalid PI_MAX_COST_MICROS/);
});

test("settle: cost rounds up, a cost over its bound counts boundExceeded, and an unknown cost stays charged at the bound", async () => {
	const guard = createCostGuard({ capMicros: 10_000_000, bound: () => 1000 });
	const settleWith = async (outcome) => {
		const stream = new FakeStream();
		assert.equal(guard.admit(call()), null);
		guard.bind(stream);
		outcome(stream);
		await flush();
	};
	await settleWith((s) => s.end(message(0.0000001))); // 0.1 micro-dollar
	assert.equal(guard.state.spent, 1, "ceil, the money-safe way");
	await settleWith((s) => s.end(message(0.002))); // 2000 > 1000
	assert.deepEqual([guard.state.spent, guard.state.boundExceeded], [2001, 1]);
	await settleWith((s) => s.fail(new Error("transport died")));
	assert.equal(guard.state.spent, 3001, "a rejected call stays charged at its bound");
	await settleWith((s) => s.end({ role: "assistant", usage: { input: 10, cost: {} } }));
	assert.equal(guard.state.spent, 4001, "a call with no finite cost.total stays charged at its bound");
	assert.equal(guard.state.inflight, 0);
	// A result promise (classify, generateImages) settles the same way.
	assert.equal(guard.admit({ method: "classify", model: FLAT, args: [{}, {}] }), null);
	guard.bind(Promise.resolve({ usage: { input: 10, cost: { total: 0.0005 } } }));
	await flush();
	assert.equal(guard.state.spent, 4501);
});

test("settle: a dispatch that threw leaves its admission charged at the bound, and the next admit is not confused by it", () => {
	const guard = createCostGuard({ capMicros: 1700, bound: () => 600 });
	assert.equal(guard.admit(call()), null); // ...and the dispatch threw: no bind
	assert.equal(guard.admit(call()), null);
	assert.deepEqual([guard.state.spent, guard.state.inflight], [600, 600], "the stale slot moved to spent, the new one is in flight");
	guard.bind(new FakeStream());
	assert.equal(guard.admit(call()), COST_CAP, "600 + 600 + 600 > 1700; had the thrown call been forgotten, 0 + 600 + 600 would pass");
});

test("settle: a long-context Anthropic call is counted and charged at the synthetic tier", async () => {
	const guard = createCostGuard({ capMicros: 100_000_000, bound: () => 50_000_000 });
	const settleOn = async (model, usage) => {
		const stream = new FakeStream();
		assert.equal(guard.admit(call(model)), null);
		guard.bind(stream);
		stream.end({ role: "assistant", usage });
		await flush();
	};
	// 250k input priced by pi at the base rate: input $0.75, output $0.15.
	await settleOn(SONNET_4_5, { input: 250_000, output: 10_000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.75, output: 0.15, cacheRead: 0, cacheWrite: 0, total: 0.9 } });
	assert.deepEqual([guard.state.longContext, guard.state.spent], [1, 2 * 750_000 + 1.5 * 150_000], "charged at 2 x input and 1.5 x output");
	// Cache counts toward the 200k; under it, or with catalog tiers, or on another api: not counted.
	await settleOn(SONNET_4_5, { input: 1000, output: 0, cacheRead: 199_000, cacheWrite: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
	assert.equal(guard.state.longContext, 2);
	await settleOn(SONNET_4_5, { input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });
	await settleOn(GPT_5_4, { input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });
	await settleOn({ ...FLAT, api: "anthropic-messages" }, { input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });
	assert.equal(guard.state.longContext, 3, "only the flat table with no tiers on anthropic-messages counted");
});

// ── The guard in the meter's two halves ─────────────────────────────────────────────────────────────────

const PHYSICAL = Object.freeze({ ...FLAT, id: "physical" });
const VIRTUAL = Object.freeze({ api: VIRTUAL_MODEL_API, provider: "router", id: "auto" });

function fakeRuntimeClass(settle) {
	const calls = [];
	class FakeRuntime {
		streamSimple(model, context, options) {
			calls.push(model.id);
			if (model.api === VIRTUAL_MODEL_API) {
				const inner = this.streamSimple(PHYSICAL, context, options);
				const outer = new FakeStream();
				inner.result().then((m) => outer.end(m));
				return outer;
			}
			const stream = new FakeStream();
			settle(stream);
			return stream;
		}
		stream(model) {
			calls.push(model.id);
			const stream = new FakeStream();
			settle(stream);
			return stream;
		}
		streamDeferred(model) {
			calls.push(model.id);
			return new FakeStream();
		}
		async classify(model) {
			calls.push(model.id);
			return { usage: { cost: { total: 0 } } };
		}
		async generateImages(model) {
			calls.push(model.id);
			return { output: [], usage: { cost: { total: 0 } } };
		}
	}
	return { FakeRuntime, calls };
}

test("a refused call gets the cost-cap hard stop, stops the job once, and never reaches the provider", async () => {
	const { FakeRuntime, calls } = fakeRuntimeClass((s) => s.end(message(0.0004)));
	const stops = [];
	const meter = createUsageMeter({ maxCostMicros: 1000, onStop: (reason) => stops.push(reason) });
	const guard = createCostGuard({ capMicros: 1000, bound: () => 600 });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop, guard });
	try {
		const runtime = new FakeRuntime();
		await runtime.streamSimple(PHYSICAL, {}, {}).result(); // 600 in flight, settles at 400
		await flush();
		assert.equal(guard.state.spent, 400);
		const refused = await runtime.streamSimple(PHYSICAL, {}, {}).result(); // 400 + 600 = 1000: admitted
		await flush();
		assert.notEqual(refused.errorMessage, "pi-dispatch: cost cap reached");
		const third = await runtime.streamSimple(PHYSICAL, {}, {}).result(); // 800 + 600 > 1000
		assert.equal(third.stopReason, "aborted");
		assert.equal(third.errorMessage, "pi-dispatch: cost cap reached");
		assert.equal(third.usage.cost.total, 0);
		assert.deepEqual(stops, [COST_CAP]);
		assert.equal(calls.length, 2, "the refused call was never dispatched");
		assert.deepEqual([guard.state.refused, meter.state.stopReason], [1, COST_CAP]);
		await runtime.stream(PHYSICAL, {}, {}).result();
		assert.equal(guard.state.refused, 1, "once stopped, the stop answers first: the guard is not asked again");
	} finally {
		layer.restore();
	}
});

test("a virtual model is bounded once, on its physical re-entry, and its physical call is what settles", async () => {
	const { FakeRuntime, calls } = fakeRuntimeClass((s) => s.end(message(0.0001)));
	const meter = createUsageMeter({ maxCostMicros: 10_000 });
	const bounded = [];
	const guard = createCostGuard({ capMicros: 10_000, bound: (method, model) => (bounded.push(model.id), 600) });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop, guard });
	try {
		await new FakeRuntime().streamSimple(VIRTUAL, {}, {}).result();
		await flush();
		assert.deepEqual(calls, ["auto", "physical"]);
		assert.deepEqual(bounded, ["physical"], "bounded once, as the model that answers");
		assert.deepEqual([guard.state.spent, guard.state.inflight], [100, 0]);
	} finally {
		layer.restore();
	}
});

test("every runtime method is judged: the stream methods and both result methods", async () => {
	const { FakeRuntime, calls } = fakeRuntimeClass((s) => s.end(message(0)));
	const meter = createUsageMeter({ maxCostMicros: 1_000_000 });
	const guard = createCostGuard({ capMicros: 1_000_000 });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop, guard });
	try {
		const runtime = new FakeRuntime();
		const images = await runtime.generateImages(FLAT, {}, {});
		assert.equal(images.errorMessage, "pi-dispatch: cost cap reached", "generateImages is refused under a cap");
		assert.deepEqual(images.output, []);
		assert.deepEqual(calls, []);
		assert.equal(meter.state.stopReason, COST_CAP);
	} finally {
		layer.restore();
	}
});

test("issue #543: inside a runtime call's context the compat half skips only that call's own re-entry on its own pair, once", async () => {
	// The context alone used to decide, so a legacy call a hook, an onPayload or a timer scheduled there made was
	// judged and counted by neither half. Now only the call whose options carry the context's token, on the token's
	// model, the first time, is the runtime call's own dispatch.
	const meter = createUsageMeter({ maxCostMicros: 1_000_000 });
	const asked = [];
	// The api is recorded when it is not FLAT's, so the test can tell which same-pair call was skipped.
	const guard = { enforces: [COST_CAP], admit: ({ model }) => (asked.push(model.api === FLAT.api ? model.id : `${model.id}@${model.api}`), null) };
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const reached = [];
	const inner = {
		streamSimple: (model) => {
			reached.push(model.id);
			const stream = new FakeStream();
			stream.end(message(0.0003));
			return stream;
		},
	};
	const dispatch = new AsyncLocalStorage();
	const compat = wrapProviderStreams({ inner, fallbackModels: null, meter, hardStop, guard, dispatch });
	const OTHER = { ...FLAT, id: "other" };
	const token = dispatchToken(FLAT);
	let late;
	await dispatch.run(token, async () => {
		await compat.streamSimple(FLAT, {}, { [DISPATCH_MARK]: token }).result(); // the re-entry: skipped
		await compat.streamSimple(FLAT, {}, {}).result(); // a hook's call on the same model, no mark: judged
		await compat.streamSimple(FLAT, {}, { [DISPATCH_MARK]: token }).result(); // the token again: already used
		await compat.streamSimple(OTHER, {}, { [DISPATCH_MARK]: dispatchToken(OTHER) }).result(); // another call's token
		late = new Promise((resolve) => setTimeout(() => resolve(compat.streamSimple(OTHER, {}, {}).result()), 1)); // scheduled here
	});
	await late;
	// Another runtime call: its token on ANOTHER pair is a forward, a full call judged and counted on its own model
	// (PR #547's reviews); it does not use the token up, so the call's own re-entry on its pair is still skipped once.
	const second = dispatchToken(FLAT);
	await dispatch.run(second, async () => {
		await compat.streamSimple(OTHER, {}, { [DISPATCH_MARK]: second }).result(); // the forward: judged, counted
		await compat.streamSimple({ ...FLAT, api: "openai-responses" }, {}, { [DISPATCH_MARK]: second }).result(); // same pair, another api: judged
		await compat.streamSimple(FLAT, {}, { [DISPATCH_MARK]: second }).result(); // the re-entry: skipped
	});
	await flush();
	assert.deepEqual(reached, ["flat", "flat", "flat", "other", "other", "other", "flat", "flat"], "every call reached its provider");
	assert.deepEqual(asked, ["flat", "flat", "other", "other", "other", "flat@openai-responses"], "all but the two exact re-entries were judged: the other api is not one");
	assert.equal(meter.state.calls, 6, "and counted");
});

/**
 * A proxy provider behind the runtime half (PR #547's review, round 3): its streamSimple forwards, after an await, to
 * pi-ai's legacy streamSimple on another model with the options spread, and answers with what the forward answered
 * (`answer: "pass"`) or with a zero-usage message of its own (`answer: "zero"`, a proxy that drops usage).
 */
function proxyRig({ capMicros = null, bounds = {}, answer = "pass", forwardUsage = message(0.0005) }) {
	const meter = createUsageMeter({ maxCostMicros: capMicros });
	const guard = capMicros === null ? null : createCostGuard({ capMicros, bound: (_method, model) => bounds[model.id] });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const dispatch = new AsyncLocalStorage();
	const reached = [];
	const inner = {
		streamSimple: (model) => {
			reached.push(model.id);
			const stream = new FakeStream();
			stream.end(forwardUsage);
			return stream;
		},
	};
	const compatEntry = wrapProviderStreams({ inner, fallbackModels: null, meter, hardStop, guard, dispatch });
	const DEAR = { ...FLAT, id: "dear", provider: "upstream" };
	class ProxyRuntime {
		streamSimple(_model, context, options) {
			const outer = new FakeStream();
			(async () => {
				await flush();
				const forwarded = await compatEntry.streamSimple(DEAR, context, { ...options }).result();
				outer.end(answer === "pass" || forwarded.stopReason === "aborted" ? forwarded : message(0, { input: 0, totalTokens: 0 }));
			})();
			return outer;
		}
		stream() {
			return new FakeStream();
		}
	}
	const layer = wrapModelRuntime({ ModelRuntime: ProxyRuntime, meter, hardStop, guard, dispatch });
	const CHEAP = { ...FLAT, id: "cheap", provider: "proxy" };
	return { meter, guard, reached, layer, run: () => new ProxyRuntime().streamSimple(CHEAP, {}, {}).result() };
}

test("a proxy's forward to another model is a full call on its own bound, and the runtime call keeps its own (PR #547's reviews)", async () => {
	// Cheap outer, dear target, under a cap the target's bound passes: refused before it is sent.
	const capped = proxyRig({ capMicros: 1000, bounds: { cheap: 100, dear: 2000 } });
	try {
		const refused = await capped.run();
		await flush();
		assert.equal(refused.errorMessage, "pi-dispatch: cost cap reached");
		assert.deepEqual([capped.reached, capped.meter.state.stopReason, capped.guard.state.inflight, capped.meter.state.calls], [[], COST_CAP, 0, 1], "nothing sent; only the runtime call counted");
	} finally {
		capped.layer.restore();
	}
	// Both bounds held at once (100 + 800 fits 1000; with 950 it would not), and both calls charged and counted: a
	// passthrough proxy is counted for both calls, the documented residual.
	const fits = proxyRig({ capMicros: 1000, bounds: { cheap: 100, dear: 800 } });
	try {
		const answered = await fits.run();
		await flush();
		assert.equal(answered.stopReason, "stop");
		assert.deepEqual([fits.reached, fits.guard.state.inflight, fits.guard.state.spent, fits.meter.state.calls, fits.meter.usageSnapshot().models.map((row) => row.model).sort()], [["dear"], 0, 1000, 2, ["cheap", "dear"]]);
	} finally {
		fits.layer.restore();
	}
	const both = proxyRig({ capMicros: 1000, bounds: { cheap: 100, dear: 950 } });
	try {
		const refused = await both.run();
		await flush();
		assert.equal(refused.errorMessage, "pi-dispatch: cost cap reached", "the runtime call's bound stays in flight while its forward is judged");
	} finally {
		both.layer.restore();
	}
	// A proxy that drops usage: the forward's usage is still counted.
	const zero = proxyRig({ answer: "zero" });
	try {
		await zero.run();
		await flush();
		assert.deepEqual([zero.meter.state.calls, zero.meter.state.total], [2, 10], "the target's 10 tokens counted, the runtime call's zero beside it");
	} finally {
		zero.layer.restore();
	}
});

test("the compat half judges a legacy call and settles it, and skips a call the runtime half already judged", async () => {
	const meter = createUsageMeter({ maxCostMicros: 1000 });
	const guard = createCostGuard({ capMicros: 1000, bound: () => 600 });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const reached = [];
	const inner = {
		streamSimple: (model) => {
			reached.push(model.id);
			const stream = new FakeStream();
			stream.end(message(0.0003));
			return stream;
		},
	};
	const dispatch = new AsyncLocalStorage();
	const compat = wrapProviderStreams({ inner, fallbackModels: null, meter, hardStop, guard, dispatch });
	// Inside the runtime half's dispatch: routed, never judged twice, never settled twice.
	const token = dispatchToken(FLAT);
	await dispatch.run(token, () => compat.streamSimple(FLAT, {}, { [DISPATCH_MARK]: token })).result();
	await flush();
	assert.deepEqual([guard.state.spent, guard.state.inflight, reached.length], [0, 0, 1]);
	await compat.streamSimple(FLAT, {}, {}).result(); // 0 + 0 + 600: admitted, settles at 300
	await flush();
	await compat.streamSimple(FLAT, {}, {}).result(); // 300 + 0 + 600: admitted, settles at 600
	await flush();
	assert.equal(guard.state.spent, 600);
	const refused = await compat.streamSimple(FLAT, {}, {}).result(); // 600 + 600 > 1000
	assert.equal(refused.errorMessage, "pi-dispatch: cost cap reached");
	assert.deepEqual([reached.length, meter.state.stopReason], [3, COST_CAP]);
});

test("the guard contract: a falsy non-null admit answer is a bug and throws, never a silent stop or pass", () => {
	const meter = createUsageMeter({ maxCostMicros: 0 });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	for (const answer of [false, 0, ""]) {
		const compat = wrapProviderStreams({ inner: { streamSimple: () => new FakeStream() }, fallbackModels: null, meter, hardStop, guard: { admit: () => answer } });
		assert.throws(() => compat.streamSimple(FLAT, {}, {}), /unknown meter stop/, JSON.stringify(answer));
		assert.equal(meter.state.stopReason, null);
	}
	for (const answer of [null, undefined]) {
		const compat = wrapProviderStreams({ inner: { streamSimple: () => new FakeStream() }, fallbackModels: null, meter, hardStop, guard: { admit: () => answer } });
		assert.doesNotThrow(() => compat.streamSimple(FLAT, {}, {}), "null and undefined pass, and a guard with no bind is fine");
	}
});

// ── PR #533's review: run-job's stop handler and the enforcement facts ───────────────────────────────────────

test("meterStopHandler: every stop aborts, and only a token stop logs token_budget_exceeded", () => {
	for (const [reason, logged] of [[TOKEN_BUDGET, [42]], [COST_CAP, []], [MODEL_NOT_ALLOWED, []]]) {
		const tokenAborts = [];
		let aborts = 0;
		meterStopHandler({ onTokenAbort: (detail) => tokenAborts.push(detail), abort: () => (aborts += 1) })(reason, 42);
		assert.deepEqual([tokenAborts, aborts], [logged, 1], reason);
	}
	// A token stop with a cause (issue #500 part E: an unmetered child, a failed children hook) is not the cap being
	// passed: its own line says why, so token_budget_exceeded is not logged. It still aborts.
	for (const cause of ["unmetered-child", "children-hook"]) {
		const tokenAborts = [];
		let aborts = 0;
		meterStopHandler({ onTokenAbort: (detail) => tokenAborts.push(detail), abort: () => (aborts += 1) })(TOKEN_BUDGET, { cause });
		assert.deepEqual([tokenAborts, aborts], [[], 1], cause);
	}
});

test("policyEnforcement: the brake counts only on an installed meter", () => {
	assert.deepEqual(policyEnforcement({ ok: true, brake: true, enforces: [COST_CAP] }), { meterOk: true, brake: true, enforces: [COST_CAP] });
	assert.deepEqual(policyEnforcement({ ok: false, brake: true, enforces: [COST_CAP] }), { meterOk: false, brake: false, enforces: [] }, "the fallback bus meter has no brake that answers before a call");
	assert.deepEqual(policyEnforcement({ ok: true, brake: false, enforces: [COST_CAP] }), { meterOk: true, brake: false, enforces: [COST_CAP] });
	assert.deepEqual(policyEnforcement({ ok: true, brake: "yes" }), { meterOk: true, brake: false, enforces: [] }, "only a real true");
});

// ── PR #533's review: the compat half's re-arm gap under a cost cap ───────────────────────────────────────

function fakeCopy(apis) {
	const registry = new Map();
	const seed = () => {
		for (const api of apis) registry.set(api, { api, streamSimple: () => new FakeStream(), stream: () => new FakeStream() });
	};
	seed();
	return {
		reset() {
			registry.clear();
			seed();
		},
		module: {
			registerApiProvider: (provider) => registry.set(provider.api, { api: provider.api, stream: provider.stream, streamSimple: provider.streamSimple }),
			getApiProvider: (api) => registry.get(api) ?? null,
			getApiProviders: () => [...registry.values()],
			createAssistantMessageEventStream: () => new FakeStream(),
		},
	};
}

async function install({ copy, meter, guard }) {
	const { FakeRuntime } = fakeRuntimeClass(() => {});
	const logged = [];
	const compatUrl = "file:///app/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js";
	const handle = await installProcessUsageMeter({
		ModelRuntime: FakeRuntime,
		meter,
		guard,
		log: (event, fields) => logged.push({ event, fields }),
		resolve: (spec) => (spec === "@earendil-works/pi-coding-agent" ? "file:///app/node_modules/@earendil-works/pi-coding-agent/dist/index.js" : "file:///app/node_modules/@earendil-works/pi-ai/dist/compat.js"),
		exists: () => true,
		load: async (url) => {
			if (url === compatUrl) return copy.module;
			throw Object.assign(new Error("no module"), { code: "ERR_MODULE_NOT_FOUND" });
		},
		loadExtensionModules: async () => ({ "@earendil-works/pi-ai": copy.module }),
		readText: () => "{}",
		rearmMs: 60_000,
		platform: "darwin",
	});
	return { handle, logged };
}

test("under a cost cap, a displaced compat entry stops the job: a legacy call may have passed the cap unseen", async () => {
	const copy = fakeCopy(["anthropic-messages", "openai-completions"]);
	const stops = [];
	const meter = createUsageMeter({ maxCostMicros: 1000, onStop: (reason) => stops.push(reason) });
	const { handle, logged } = await install({ copy, meter, guard: createCostGuard({ capMicros: 1000 }) });
	handle.uninstall();
	assert.deepEqual([...handle.enforces], [COST_CAP], "the installed guard enforces the cap");
	handle.arm();
	assert.equal(meter.state.stopReason, null, "an idempotent re-arm displaced nothing");
	copy.reset(); // resetApiProviders(): AgentSession.reload(), or an extension
	handle.arm();
	assert.equal(meter.state.stopReason, COST_CAP);
	assert.deepEqual(stops, [COST_CAP]);
	assert.deepEqual(logged.filter((entry) => entry.event === "cost_guard_displaced").map((entry) => entry.fields), [{ apis: 2 }]);
	// Without a cost cap the re-arm is today's: re-wrap and count, no stop.
	const uncapped = createUsageMeter({ maxTokens: 10 });
	const other = fakeCopy(["anthropic-messages"]);
	const second = await install({ copy: other, meter: uncapped, guard: null });
	second.handle.uninstall();
	other.reset();
	second.handle.arm();
	assert.deepEqual([second.handle.rearms, uncapped.state.stopReason], [1, null]);
});

// ── Review round 1 of #534 ─────────────────────────────────────────────────────────────────────────────────


test("a charge is never below zero", async () => {
	const guard = createCostGuard({ capMicros: 10_000, bound: () => 1000 });
	const stream = new FakeStream();
	guard.admit(call());
	guard.bind(stream);
	stream.end(message(-0.0005));
	await flush();
	assert.equal(guard.state.spent, 0);
});

test("an image block counts at least its api's per-image ceiling, not its base64 bytes, once per reference", () => {
	assert.deepEqual({ ...IMAGE_RESIZE_MAX }, { width: 2000, height: 2000 });
	// The arithmetic behind each constant, restated so a changed constant is a changed sum here too.
	assert.deepEqual({ ...IMAGE_TOKEN_CEILINGS }, { "openai-completions": 2833 + 8 * 5667, "openai-responses": 48_169, "azure-openai-responses": 48_169, "openai-codex-responses": 48_169, "mistral-conversations": 125 * 125 + 125, default: Math.ceil((2000 * 2000) / 750) });
	const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
	const blockBytes = Buffer.byteLength(JSON.stringify(image));
	const context = { messages: [{ role: "user", content: [{ type: "text", text: "look" }, image] }] };
	const bytes = Buffer.byteLength(JSON.stringify(context));
	const zeroOut = (api) => ({ ...FLAT, api, maxTokens: 1, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } });
	assert.equal(callCostBound("streamSimple", zeroOut("anthropic-messages"), context, {}, NO_ENV), bytes + 8192 + (5334 - blockBytes));
	assert.equal(callCostBound("streamSimple", zeroOut("openai-completions"), context, {}, NO_ENV), bytes + 8192 + (48_169 - blockBytes), "gpt-4o-mini's tiles at the worst aspect in the box");
	assert.equal(callCostBound("streamSimple", zeroOut("mistral-conversations"), context, {}, NO_ENV), bytes + 8192 + (15_750 - blockBytes));
	assert.equal(callCostBound("streamSimple", zeroOut("google-generative-ai"), context, {}, NO_ENV), bytes + 8192 + (5334 - blockBytes));
	// 100 tiny images on sonnet-4.5: the review's 348,308 under-bound now covers the real ~492,030.
	const hundred = { messages: [{ role: "user", content: Array.from({ length: 100 }, () => ({ ...image })) }] };
	assert.ok(callCostBound("streamSimple", { ...SONNET_4_5, maxTokens: 1 }, hundred, {}, NO_ENV) > 100 * 5334 * 3.75);
	// Ten references to ONE block are sent ten times, so they count ten times.
	const shared = { messages: [{ role: "user", content: Array.from({ length: 10 }, () => image) }] };
	const sharedBytes = Buffer.byteLength(JSON.stringify(shared));
	assert.equal(callCostBound("streamSimple", zeroOut("anthropic-messages"), shared, {}, NO_ENV), sharedBytes + 8192 + 10 * (5334 - blockBytes));
	// A model that declares a bigger resize box scales its api's ceiling by area; a smaller one never lowers it.
	const big = { ...zeroOut("anthropic-messages"), inputLimits: { images: { resize: { maxWidth: 4000, maxHeight: 4000 } } } };
	assert.equal(callCostBound("streamSimple", big, context, {}, NO_ENV), bytes + 8192 + (4 * 5334 - blockBytes));
	const small = { ...zeroOut("anthropic-messages"), inputLimits: { images: { resize: { maxWidth: 100, maxHeight: 100 } } } };
	assert.equal(callCostBound("streamSimple", small, context, {}, NO_ENV), bytes + 8192 + (5334 - blockBytes));
	// An image whose bytes already exceed the ceiling counts its bytes.
	const huge = { messages: [{ role: "user", content: [{ type: "image", data: "x".repeat(10_000), mimeType: "image/png" }] }] };
	assert.equal(callCostBound("streamSimple", zeroOut("anthropic-messages"), huge, {}, NO_ENV), Buffer.byteLength(JSON.stringify(huge)) + 8192);
});

test("samplingParams that override the output cap widen the bound, n multiplies it, a bad value is Infinity", () => {
	const ctx = inputOf(10_000);
	const base = 10_000 + 1000 * 2;
	assert.equal(callCostBound("streamSimple", FLAT, ctx, {}, NO_ENV), base);
	assert.equal(callCostBound("streamSimple", { ...FLAT, samplingParams: { max_tokens: 5000 } }, ctx, {}, NO_ENV), 10_000 + 5000 * 2, "the model's own samplingParams");
	assert.equal(callCostBound("streamSimple", FLAT, ctx, { samplingParams: { max_completion_tokens: 3000 } }, NO_ENV), 10_000 + 3000 * 2, "the call's");
	assert.equal(callCostBound("streamSimple", FLAT, ctx, { samplingParams: { max_tokens: 10 } }, NO_ENV), base, "a smaller value never lowers the bound");
	assert.equal(callCostBound("streamSimple", FLAT, ctx, { samplingParams: { n: 3 } }, NO_ENV), 10_000 + 3 * 1000 * 2);
	for (const bad of [{ max_tokens: null }, { max_tokens: "5000" }, { max_completion_tokens: Number.NaN }, { n: 1.5 }, { n: 0 }]) {
		assert.equal(callCostBound("streamSimple", FLAT, ctx, { samplingParams: bad }, NO_ENV), Infinity, JSON.stringify(bad));
	}
	const azure = { ...AZURE_GPT_5_4, samplingParams: { max_output_tokens: 200_000 } };
	assert.equal(callCostBound("streamSimple", azure, ctx, {}, NO_ENV), 10_000 * 2.5 + 200_000 * 15);
	const custom = { ...GPT_5_4, baseUrl: "http://127.0.0.1:1/v1" };
	assert.equal(callCostBound("streamSimple", custom, ctx, { maxTokens: 100, samplingParams: { max_output_tokens: 1000 } }, NO_ENV), (10_000 * 2.5 + 1000 * 15) * 2);
	// Not on an api that does not merge them after the cap.
	assert.equal(callCostBound("streamSimple", { ...SONNET_4_5, samplingParams: { max_tokens: 999_999 } }, inputOf(100_000), {}, NO_ENV), 100_000 * 3.75 + 64_000 * 15);
});

test("a present maxTokens that is not a finite number is unboundable; null is absent", () => {
	const ctx = inputOf(10_000);
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "100", true]) {
		assert.equal(callCostBound("streamSimple", FLAT, ctx, { maxTokens: bad }, NO_ENV), Infinity, String(bad));
	}
	assert.equal(callCostBound("streamSimple", FLAT, ctx, { maxTokens: null }, NO_ENV), 12_000);
});

test("issue #507: on a server outside pi's catalog, openai-completions is bounded only by a cap sent as max_tokens", () => {
	const ctx = inputOf(10_000);
	// The e2e model: priced qwen2.5:3b on Ollama, maxTokens 256, no compat. pi sends max_completion_tokens, which Ollama
	// 0.35.0 ignores (20 asked, 440 answered), so neither the asked cap nor the model's bounds anything.
	const ollama = { ...FLAT, baseUrl: "http://host.docker.internal:11434/v1", compat: undefined, maxTokens: 256 };
	assert.equal(callCostBound("streamSimple", ollama, ctx, {}, NO_ENV), Infinity, "pi's default field on the operator's server");
	assert.equal(callCostBound("streamSimple", ollama, ctx, { maxTokens: 20 }, NO_ENV), Infinity, "an asked cap that travels as max_completion_tokens");
	assert.equal(callCostBound("streamSimple", { ...ollama, compat: { maxTokensField: "max_completion_tokens" } }, ctx, {}, NO_ENV), Infinity, "said explicitly, it is still a field the server may ignore");
	assert.equal(callCostBound("streamSimple", { ...ollama, compat: { supportsStore: false } }, ctx, {}, NO_ENV), Infinity, "a compat without the field");
	assert.equal(callCostBound("streamSimple", { ...ollama, baseUrl: "not a url" }, ctx, {}, NO_ENV), Infinity, "a baseUrl that does not parse");
	// With max_tokens the cap on the wire bounds it: streamSimple always sends one, a raw stream only the caller's.
	const fixed = { ...ollama, compat: { maxTokensField: "max_tokens" } };
	assert.equal(callCostBound("streamSimple", fixed, ctx, {}, NO_ENV), 10_000 + 256 * 2, "streamSimple sends model.maxTokens");
	assert.equal(callCostBound("streamSimple", fixed, ctx, { maxTokens: 20 }, NO_ENV), 10_000 + 20 * 2);
	assert.equal(callCostBound("stream", fixed, ctx, { maxTokens: 20 }, NO_ENV), 10_000 + 20 * 2);
	assert.equal(callCostBound("stream", fixed, ctx, {}, NO_ENV), Infinity, "a raw stream with no cap sends none");
	// A host pi's catalog serves keeps pi's own choice of field: openrouter sends max_completion_tokens and reads it.
	const openrouter = { ...ollama, provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" };
	assert.equal(callCostBound("streamSimple", openrouter, ctx, {}, NO_ENV), 10_000 + 256 * 2);
	assert.equal(callCostBound("stream", openrouter, ctx, {}, NO_ENV), 10_000 + 256 * 2, "the hosted server stops at the model's own limit");
	// Zero-rated stays 0 wherever it runs, and other apis are untouched.
	assert.equal(callCostBound("streamSimple", { ...ollama, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, ctx, {}, NO_ENV), 0);
	assert.equal(callCostBound("streamSimple", { ...ollama, api: "anthropic-messages" }, ctx, {}, NO_ENV), 10_000 + 256 * 2);
	assert.equal(completionsOwnServer(ollama), true);
	assert.equal(completionsOwnServer(openrouter), false);
	assert.equal(completionsOwnServer({ ...ollama, api: "openai-responses" }), false);
});

test("a displacement under the cap is counted on the exit line as costUnjudged", async () => {
	const copy = fakeCopy(["anthropic-messages", "openai-completions"]);
	const meter = createUsageMeter({ maxCostMicros: 1000 });
	const guard = createCostGuard({ capMicros: 1000 });
	const { handle } = await install({ copy, meter, guard });
	handle.uninstall();
	assert.equal(guard.snapshot().costUnjudged, 0);
	copy.reset();
	handle.arm();
	copy.reset();
	handle.arm(); // a second displacement after the stop is still evidence
	assert.equal(guard.snapshot().costUnjudged, 4);
	assert.equal(meter.state.stopReason, COST_CAP);
});

test("only streamSimple skips a virtual model; stream and streamDeferred on one are judged, and refused as unboundable", async () => {
	const { FakeRuntime, calls } = fakeRuntimeClass((s) => s.end(message(0)));
	const logged = [];
	const meter = createUsageMeter({ maxCostMicros: 1_000_000_000 });
	const guard = createCostGuard({ capMicros: 1_000_000_000, log: (event, fields) => logged.push(fields) });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	for (const method of ["stream", "streamDeferred"]) {
		const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter: createUsageMeter({ maxCostMicros: 1_000_000_000 }), hardStop, guard });
		try {
			const answer = await new FakeRuntime()[method](VIRTUAL, {}, {}).result();
			assert.equal(answer.errorMessage, "pi-dispatch: cost cap reached", method);
		} finally {
			layer.restore();
		}
	}
	assert.deepEqual(calls, [], "neither reached the runtime");
	assert.deepEqual(logged.map((fields) => fields.why), ["unboundable", "unboundable"]);
	assert.equal(meter.state.stopReason, null);
});



test("samplingParams holding any key outside the safe list make the call unboundable", () => {
	const ctx = inputOf(10_000);
	assert.deepEqual([...SAMPLING_SAFE_KEYS], ["temperature", "top_p", "top_k", "seed", "stop", "presence_penalty", "frequency_penalty", "max_tokens", "max_completion_tokens", "max_output_tokens", "n"]);
	assert.equal(callCostBound("streamSimple", { ...FLAT, samplingParams: { temperature: 0.2, top_p: 0.9, seed: 1, stop: ["x"] } }, ctx, {}, NO_ENV), 12_000, "price-neutral knobs");
	for (const unsafe of [{ model: "o1-pro" }, { service_tier: "priority" }, { tools: [] }, { logprobs: true }]) {
		assert.equal(callCostBound("streamSimple", { ...FLAT, samplingParams: unsafe }, ctx, {}, NO_ENV), Infinity, `model's ${JSON.stringify(unsafe)}`);
		assert.equal(callCostBound("streamSimple", FLAT, ctx, { samplingParams: unsafe }, NO_ENV), Infinity, `call's ${JSON.stringify(unsafe)}`);
	}
	// On an api that does not merge them, they reach no request.
	assert.equal(callCostBound("streamSimple", { ...SONNET_4_5, samplingParams: { model: "x" } }, inputOf(100_000), {}, NO_ENV), 100_000 * 3.75 + 64_000 * 15);
});

test("a failed call that STARTED is charged at least its bound; one that never started is metered and counted", async () => {
	const guard = createCostGuard({ capMicros: 100_000_000, bound: () => 1000 });
	const settleWith = async (msg) => {
		const stream = new FakeStream();
		assert.equal(guard.admit(call()), null);
		guard.bind(stream);
		stream.end(msg);
		await flush();
		return guard.snapshot();
	};
	const failed = ({ content = [], output = 0, input = 0, cost = 0, stopReason = "error" } = {}) => ({ role: "assistant", stopReason, content, usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } });
	// Never started: a 429 or 5xx before the stream, or an in-band error after message_start (its usage only).
	let snap = await settleWith(failed());
	assert.deepEqual([guard.state.spent, snap.costUnanswered], [0, 1], "a 429: metered 0, counted");
	snap = await settleWith(failed({ input: 500, cost: 0.0002 }));
	assert.deepEqual([guard.state.spent, snap.costUnanswered], [200, 2], "input alone is not a start: metered, counted");
	snap = await settleWith(failed({ stopReason: "aborted" }));
	assert.deepEqual([guard.state.spent, snap.costUnanswered], [200, 3], "aborted before anything came back");
	// Started: any content block. Usage counts do not decide it.
	snap = await settleWith(failed({ content: [{ type: "text", text: "partial" }] }));
	assert.deepEqual([guard.state.spent, snap.costUnanswered], [1200, 3], "content came back: at least the bound");
	snap = await settleWith(failed({ content: [{ type: "toolCall", id: "t", name: "x", arguments: {} }], stopReason: "aborted" }));
	assert.equal(guard.state.spent, 2200);
	// anthropic-messages copies message_start's output_tokens (Anthropic sends 1) into usage.output, so an in-band
	// overloaded_error right after message_start reports one output token and no content: not a start.
	snap = await settleWith(failed({ input: 25, output: 1, cost: 0.000125 }));
	assert.deepEqual([guard.state.spent, snap.costUnanswered], [2325, 4], "an output count alone is not a start");
	snap = await settleWith(failed({ content: [{ type: "text", text: "x" }], cost: 0.005 }));
	assert.deepEqual([guard.state.spent, guard.state.boundExceeded], [7325, 1], "a partial cost above the bound is still its cost");
	// A started call that DID report its input (anthropic's message_start) is still charged its bound, not its partial cost.
	await settleWith(failed({ content: [{ type: "text", text: "x" }], input: 500, cost: 0.0001 }));
	assert.equal(guard.state.spent, 8325, "its input was reported, and it is still the bound");
	// A successful call that reports no input at all is broken reporting: the bound. Cache-only input is input.
	await settleWith({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });
	assert.equal(guard.state.spent, 9325);
	await settleWith({ role: "assistant", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 7, cacheWrite: 0, cost: { total: 0.0001 } } });
	await settleWith({ role: "assistant", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 7, cost: { total: 0.0001 } } });
	await settleWith(message(0.0001));
	assert.equal(guard.state.spent, 9625, "whole, successful calls settle at their cost");
	assert.equal(guard.snapshot().costUnanswered, 4);
	// So a retry loop of cut streams that had started cannot run under the cap, while a 429 streak can retry.
	const tight = createCostGuard({ capMicros: 2500, bound: () => 1000 });
	const loop = async (msg) => {
		let admitted = 0;
		for (let i = 0; i < 10; i++) {
			if (tight.admit(call()) !== null) break;
			admitted += 1;
			const stream = new FakeStream();
			tight.bind(stream);
			stream.end(msg);
			await flush();
		}
		return admitted;
	};
	assert.equal(await loop(failed()), 10, "ten 429s in a row are all admitted: nothing was billed");
	assert.equal(await loop(failed({ content: [{ type: "text", text: "x" }] })), 2, "two started-then-cut calls fit 2500 at 1000 each");
});

test("an admitted dispatch that threw, or returned no answer object, counts costUnanswered; a slot a synchronous forward flushed does not (issue #571)", async () => {
	const UP = { ...FLAT, provider: "anthropic", id: "up" };
	const zeros = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
	class Router {
		streamSimple(model, context, options) {
			if (model.id === "boom") throw new Error("provider setup failed");
			const stream = new FakeStream();
			if (model.id === "proxy") {
				// A synchronous forward: the upstream is admitted while this call's own slot is still unbound.
				const forward = this.streamSimple(UP, context, options);
				forward.result().then((answer) => stream.end({ ...answer, usage: zeros }));
				return stream;
			}
			stream.end({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { total: 0.0045 } } });
			return stream;
		}
	}
	const meter = createUsageMeter({ maxTokens: null, maxCostMicros: 100_000 });
	const guard = createCostGuard({ capMicros: 100_000, bound: () => 10_000 });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const layer = wrapModelRuntime({ ModelRuntime: Router, meter, hardStop, guard });
	try {
		const runtime = new Router();
		await runtime.streamSimple({ ...FLAT, provider: "router", id: "proxy" }, {}, {}).result();
		await flush();
		assert.deepEqual([meter.state.calls, guard.snapshot().costUnanswered, meter.snapshot().costUnreported], [2, 0, 0], "the forward's flush is not a lost answer");
		const settled = dollarSettlement({ tokens: { ...meter.snapshot(), unmeteredChildren: 0, ...guard.snapshot() }, usage: meter.usageSnapshot(), reservedMicros: 100_000, trusted: true });
		assert.deepEqual(settled, { settledMicros: 4500, basis: "metered" }, "a synchronous forward under a cap settles metered at the upstream's cost");
		assert.throws(() => runtime.streamSimple({ ...FLAT, id: "boom" }, {}, {}), /provider setup failed/, "the throw is not swallowed");
		assert.equal(guard.state.unanswered, 1, "a dispatch that threw is counted");
		assert.equal(guard.state.inflight, 0, "and settled at once, at its bound");
	} finally {
		layer.restore();
	}
	// A dispatch that returned neither a stream nor a promise: counted.
	const odd = createCostGuard({ capMicros: 100_000, bound: () => 1000 });
	odd.admit(call());
	odd.bind({});
	assert.deepEqual([odd.state.spent, odd.state.unanswered], [1000, 1]);
	// A slot flushed by the next admit or the snapshot: charged its bound, not counted.
	const flushed = createCostGuard({ capMicros: 100_000, bound: () => 1000 });
	flushed.admit(call());
	flushed.admit(call());
	assert.deepEqual([flushed.snapshot().costUnanswered, flushed.state.spent], [0, 2000]);
	// A zero-rated call (bound 0) costs nothing, answered or not.
	const free = createCostGuard({ capMicros: 0, bound: () => 0 });
	free.admit(call());
	free.bind({});
	assert.equal(free.snapshot().costUnanswered, 0);
});

test("a stream method whose dispatch answered with a promise: a stream it resolves to is metered and settled from its result, a rejection is unpriced (issue #571)", async () => {
	const whole = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { total: 0.0045 } } };
	// pi-ai's legacy streamSimple hands a registry entry's answer on as it is: an entry answering Promise<stream>.
	const inner = {
		streamSimple: async (model) => {
			if (model.id === "down") throw new Error("async provider failed");
			const stream = new FakeStream();
			stream.end(whole);
			return stream;
		},
		stream: () => null,
	};
	const meter = createUsageMeter({ maxTokens: null, maxCostMicros: 100_000 });
	const guard = createCostGuard({ capMicros: 100_000, bound: () => 10_000 });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const compat = wrapProviderStreams({ inner, fallbackModels: { getProvider: () => null }, meter, hardStop, guard, dispatch: new AsyncLocalStorage() });
	// A caller that awaits the promise gets a working stream, and its spend is on the line.
	const answer = await (await compat.streamSimple({ ...FLAT, id: "up" }, {}, {})).result();
	await flush();
	assert.equal(answer.usage.cost.total, 0.0045);
	assert.deepEqual([meter.state.calls, meter.state.unresolved, meter.state.cost, guard.state.spent, guard.state.inflight], [1, 0, 0.0045, 4500, 0], "metered and settled at its cost, not unseen");
	const settled = dollarSettlement({ tokens: { ...meter.snapshot(), unmeteredChildren: 0, ...guard.snapshot() }, usage: meter.usageSnapshot(), reservedMicros: 100_000, trusted: true });
	assert.deepEqual(settled, { settledMicros: 4500, basis: "metered" });
	// A promise that rejects: charged its bound, and a call with no usage on the line (unpriced), so the run floors.
	await assert.rejects(compat.streamSimple({ ...FLAT, id: "down" }, {}, {}), /async provider failed/);
	await flush();
	assert.deepEqual([meter.state.calls, meter.state.unpriced, guard.state.spent, guard.snapshot().costUnanswered], [2, 1, 14_500, 0]);
});

test("a promise of a stream: resolving to something that is not a stream is unpriced at the bound, and an async forward is metered once (issue #571)", async () => {
	const whole = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { total: 0.0045 } } };
	const setup = (streamSimple) => {
		const meter = createUsageMeter({ maxTokens: null, maxCostMicros: 1_000_000 });
		const guard = createCostGuard({ capMicros: 1_000_000, bound: () => 10_000 });
		const box = {};
		box.compat = wrapProviderStreams({ inner: { streamSimple: (...args) => streamSimple(box, ...args), stream: () => null }, fallbackModels: { getProvider: () => null }, meter, hardStop: makeHardStopStream({ createStream: () => new FakeStream() }), guard, dispatch: new AsyncLocalStorage() });
		return { meter, guard, compat: box.compat };
	};
	// An async entry that resolves to a message rather than a stream: no usage to settle from.
	const odd = setup(async () => whole);
	await odd.compat.streamSimple({ ...FLAT, id: "odd" }, {}, {});
	await flush();
	assert.deepEqual([odd.meter.state.unpriced, odd.meter.state.cost, odd.guard.state.spent], [1, 0, 10_000], "the meter's unpriced, the guard's bound");
	// An async router entry that forwards through the legacy call and resolves to the forward's own stream.
	const routed = setup((box, model, context, options) => {
		if (model.id === "router") {
			return (async () => {
				await null;
				return box.compat.streamSimple({ ...FLAT, id: "upstream" }, context, options);
			})();
		}
		const stream = new FakeStream();
		stream.end(whole);
		return stream;
	});
	await (await routed.compat.streamSimple({ ...FLAT, id: "router" }, {}, {})).result();
	await flush();
	assert.deepEqual([routed.meter.state.calls, routed.meter.state.total, routed.meter.state.cost, routed.meter.state.unresolved], [2, 1100, 0.0045, 0], "the forward's usage counted once");
});

test("the guard charges a call its bound by the meter's own predicate: an Anthropic answer whose output count stuck at 1 stops a $2 job at the cap (issue #571)", async () => {
	const CLAUDE = { ...FLAT, api: "anthropic-messages", provider: "anthropic", id: "claude-x" };
	const stuck = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "x".repeat(60_000) }], usage: { input: 2000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2001, cost: { total: 0.006015 } } };
	const { FakeRuntime, calls } = fakeRuntimeClass((s) => s.end(stuck));
	const stops = [];
	const meter = createUsageMeter({ maxTokens: null, maxCostMicros: 2_000_000, onStop: (reason) => stops.push(reason) });
	const guard = createCostGuard({ capMicros: 2_000_000, bound: () => 600_000 });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop, guard });
	try {
		const runtime = new FakeRuntime();
		for (let i = 0; i < 10 && meter.state.stopReason === null; i++) {
			await runtime.streamSimple(CLAUDE, {}, {}).result();
			await flush();
		}
		assert.deepEqual([calls.length, guard.state.spent, stops], [3, 1_800_000, [COST_CAP]], "three bounds fit $2, the fourth is refused");
		assert.equal(meter.snapshot().costUnreported, 3, "and each is counted by the meter, by the same predicate");
	} finally {
		layer.restore();
	}
});

test("the image ceiling is the larger of the api's and the model family's", () => {
	const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
	const blockBytes = Buffer.byteLength(JSON.stringify(image));
	const context = { messages: [{ role: "user", content: [image] }] };
	const bytes = Buffer.byteLength(JSON.stringify(context));
	const zeroOut = (api, id) => ({ ...FLAT, api, id, maxTokens: 1, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } });
	// vercel-ai-gateway serves OpenAI's gpt-4o-mini over anthropic-messages; Bedrock serves Pixtral over converse.
	assert.equal(callCostBound("streamSimple", zeroOut("anthropic-messages", "openai/gpt-4o-mini"), context, {}, NO_ENV), bytes + 8192 + (48_169 - blockBytes));
	assert.equal(callCostBound("streamSimple", zeroOut("bedrock-converse-stream", "mistral.pixtral-large-2502-v1:0"), context, {}, NO_ENV), bytes + 8192 + (15_750 - blockBytes));
	assert.equal(callCostBound("streamSimple", zeroOut("anthropic-messages", "o3-mini"), context, {}, NO_ENV), bytes + 8192 + (48_169 - blockBytes), "the o-series");
	assert.equal(callCostBound("streamSimple", zeroOut("anthropic-messages", "claude-opus-4-1"), context, {}, NO_ENV), bytes + 8192 + (5334 - blockBytes), "no family match: the api's");
	assert.equal(callCostBound("streamSimple", zeroOut("openai-completions", "pixtral-12b"), context, {}, NO_ENV), bytes + 8192 + (48_169 - blockBytes), "the larger of the two");
});

test("with no cap there is no guard, so the exit line carries no cost counter at all", () => {
	// run-job spreads costGuard.snapshot() only when a guard exists (pinned in compose.test.mjs); the meter's own
	// snapshot, all a no-cap job emits, has none of the guard's keys.
	const keys = Object.keys(createUsageMeter({ maxTokens: null }).snapshot());
	for (const key of ["costCapMicros", "costRefused", "boundExceeded", "longContext", "costUnjudged", "costUnanswered"]) assert.ok(!keys.includes(key), key);
	assert.deepEqual(Object.keys(createCostGuard({ capMicros: 0 }).snapshot()), ["costCapMicros", "costRefused", "boundExceeded", "longContext", "costUnjudged", "costUnanswered"]);
});

// ── Issue #500: spend in other processes (`external`) ──────────────────────────────────────────────────────

test("external: the guard judges spent + inflight + external() + bound, read at every admit", async () => {
	let outside = 301;
	const logged = [];
	const guard = createCostGuard({ capMicros: 1000, bound: () => 600, external: () => outside, log: (event, fields) => logged.push(fields) });
	assert.equal(guard.admit(call()), null, "0 + 0 + 301 + 600 <= 1000");
	const first = new FakeStream();
	guard.bind(first);
	first.end(message(0.0001));
	await flush();
	assert.equal(guard.admit(call()), COST_CAP, "100 + 0 + 301 + 600 > 1000: the outside spend is what tips it");
	assert.deepEqual(logged, [{ bound: 600, external: 301, spent: 100, inflight: 0, cap: 1000 }], "numbers only, the outside part named");
	outside = 0;
	assert.equal(guard.admit(call()), null, "read again at the next admit, not once");
});

test("external fails closed: a non-number, NaN, Infinity, a negative or a throw refuses the call", () => {
	for (const answer of [undefined, null, "5", Number.NaN, Infinity, -1, () => {
		throw new Error("ENOENT");
	}]) {
		const logged = [];
		const guard = createCostGuard({ capMicros: 1_000_000, bound: () => 1, external: typeof answer === "function" ? answer : () => answer, log: (event, fields) => logged.push(fields) });
		assert.equal(guard.admit(call()), COST_CAP, String(answer));
		assert.deepEqual(logged, [{ why: "external", spent: 0, inflight: 0, cap: 1_000_000 }], String(answer));
	}
	assert.throws(() => createCostGuard({ capMicros: 1, external: 5 }), /external must be a function/);
});

test("spend() reports spent and in-flight; the snapshot, and so the exit line, is unchanged with or without external", async () => {
	const guard = createCostGuard({ capMicros: 10_000, bound: () => 600, external: () => 0 });
	guard.admit(call());
	const done = new FakeStream();
	guard.bind(done);
	guard.admit(call());
	guard.bind(new FakeStream());
	done.end(message(0.000_25));
	await flush();
	assert.deepEqual(guard.spend(), { spentMicros: 250, inflightMicros: 600 });
	const line = '{"costCapMicros":10000,"costRefused":0,"boundExceeded":0,"longContext":0,"costUnjudged":0,"costUnanswered":0}';
	assert.equal(JSON.stringify(guard.snapshot()), line, "external set: the exit line's cost fields are byte-identical");
	assert.equal(JSON.stringify(createCostGuard({ capMicros: 10_000, bound: () => 600 }).snapshot()), line);
	const policy = createPolicyGuard({ maxCostMicros: 1000, external: () => 2000, env: {} });
	assert.equal(policy.admit({ method: "streamSimple", model: { ...FLAT, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, args: [{}, {}] }), COST_CAP, "createPolicyGuard hands external to the cost guard");
	assert.deepEqual(Object.keys(policy.snapshot()), ["costCapMicros", "costRefused", "boundExceeded", "longContext", "costUnjudged", "costUnanswered"]);
	assert.deepEqual(policy.spend(), { spentMicros: 0, inflightMicros: 0 });
	assert.deepEqual(createPolicyGuard({ allowedModels: [{ provider: "p", model: "m" }] }).spend(), { spentMicros: 0, inflightMicros: 0 }, "zeros without a cap");
});
