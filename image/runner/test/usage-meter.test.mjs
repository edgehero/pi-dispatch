import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import { RESOURCE_KEYS } from "../src/cgroup-usage.mjs";
import { pathToFileURL } from "node:url";
import {
	assertPoliciesEnforceable,
	CHILD_LEDGER_ROWS,
	createPolicyGuard,
	createUsageMeter,
	defaultHardStopResult,
	installProcessUsageMeter,
	makeHardStopStream,
	METER_PROVIDER_PREFIX,
	piOwnPackageDir,
	resolvePiAiCompat,
	RUNTIME_RESULT_METHODS,
	RUNTIME_STREAM_METHODS,
	STOP_MESSAGES,
	VIRTUAL_MODEL_API,
	wrapModelRuntime,
	wrapProviderStreams,
	DISPATCH_MARK,
	dispatchToken,
	pricedModel,
	unreportedUsage,
} from "../src/usage-meter.mjs";
import { COST_CAP, COST_CAP_UNENFORCEABLE, EXIT_POLICY, MODEL_NOT_ALLOWED, MODEL_POLICY_UNENFORCEABLE, TOKEN_BUDGET } from "../src/outcome.mjs";

/**
 * These tests are PURE: no pi import, no skip gate, no filesystem. Every pi-shaped dependency of
 * usage-meter.mjs is injected, which is the whole point of splitting it that way -- the module that
 * decides how much a job is allowed to spend must be verifiable without a provider, a network, or a
 * particular node_modules layout on the machine running CI.
 */

/**
 * Stands in for pi-ai's EventStream with the two properties the meter depends on: `result()` is a
 * MEMOISED promise resolved on the terminal event, and it is independent of the async iterator, so
 * observing the result does not consume the stream. Mirrors dist/utils/event-stream.js.
 */
class FakeStream {
	constructor() {
		this.events = [];
		this.ended = false;
		this.resultCalls = 0;
		this.settled = new Promise((resolve, reject) => {
			this.settle = resolve;
			this.fail = reject;
		});
		this.settled.catch(() => {}); // keep an intentionally rejected fixture from tripping node:test
	}
	push(event) {
		this.events.push(event);
	}
	end(message) {
		this.ended = true;
		this.settle(message);
	}
	result() {
		this.resultCalls += 1;
		return this.settled;
	}
	async *[Symbol.asyncIterator]() {
		for (const event of this.events) yield event;
	}
}

/**
 * Same shape as token-budget.test.mjs's helper -- one usage object per billed provider call. The
 * cache-split fields default to 0 so the flat-total tests read exactly as before, while the ledger
 * tests can exercise the split the flat totals deliberately collapse.
 */
const usage = ({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cacheWrite1h = 0, reasoning = 0, total = input + output, cost = 0 }) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	cacheWrite1h,
	reasoning,
	totalTokens: total,
	cost: { total: cost },
});

/** The assistant message a settled provider stream resolves to. */
const settledWith = (u) => ({ role: "assistant", usage: u });

const MODEL = { api: "anthropic-messages", provider: "anthropic", id: "claude-x" };

/** A settled stream that carries the given usage, ready for observe(). */
function streamOf(u) {
	const stream = new FakeStream();
	stream.end(settledWith(u));
	return stream;
}

/** Drain a stream so "observe did not consume it" is checked against real iteration. */
async function drain(stream) {
	const out = [];
	for await (const event of stream) out.push(event);
	return out;
}

/** Let the observe() result-handler microtasks run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------------------------
// createUsageMeter
// ---------------------------------------------------------------------------------------------

test("accumulates input/output/billed total/cost across records", () => {
	const meter = createUsageMeter({ maxTokens: null });

	meter.record(usage({ input: 100, output: 20, total: 500, cost: 0.01 }));
	meter.record(usage({ input: 200, output: 30, total: 700, cost: 0.02 }));

	assert.equal(meter.state.input, 300);
	assert.equal(meter.state.output, 50);
	// totalTokens is the BILLED total (input + output + cache), so it exceeds input + output. Same
	// deliberate asymmetry as token-budget.mjs.
	assert.equal(meter.state.total, 1200);
	assert.equal(Math.round(meter.state.cost * 100) / 100, 0.03);
	assert.equal(meter.state.unpriced, 0);
	assert.equal(meter.snapshot().metered, true);
});

test("splits tokens across root / other / loose and keeps the sum invariant", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root-1" });

	meter.record(usage({ total: 100 }), { sessionId: "root-1" });
	meter.record(usage({ total: 200 }), { sessionId: "child-a" });
	meter.record(usage({ total: 300 }), { sessionId: "child-b" });
	meter.record(usage({ total: 400 }), { sessionId: "child-a" }); // repeat id, still one session
	meter.record(usage({ total: 50 })); // no ctx at all
	meter.record(usage({ total: 25 }), { sessionId: "" }); // empty id is not a session

	assert.equal(meter.state.rootTotal, 100);
	assert.equal(meter.state.otherTotal, 900, "subagent spend the per-session bus cannot see");
	assert.equal(meter.state.looseTotal, 75);
	assert.equal(
		meter.state.rootTotal + meter.state.otherTotal + meter.state.looseTotal,
		meter.state.total,
		"the split must partition the billed total exactly",
	);
	assert.equal(meter.snapshot().sessions, 3, "root-1, child-a, child-b -- distinct non-empty ids");
});

test("with no rootSessionId every attributed call is other, never root", () => {
	const meter = createUsageMeter({ maxTokens: null });
	meter.record(usage({ total: 10 }), { sessionId: "s1" });
	meter.record(usage({ total: 5 }));
	assert.equal(meter.state.rootTotal, 0, "an absent root must not swallow unattributed calls");
	assert.equal(meter.state.otherTotal, 10);
	assert.equal(meter.state.looseTotal, 5);
});

test("onStop fires exactly once, synchronously, on the first crossing record, naming the token cap", () => {
	const fired = [];
	const meter = createUsageMeter({ maxTokens: 1000, onStop: (reason, total) => fired.push([reason, total]) });

	meter.record(usage({ total: 500 }));
	assert.deepEqual(fired, [], "must not fire at or below the cap");
	assert.equal(meter.state.breached, false);
	assert.equal(meter.state.stopReason, null);

	meter.record(usage({ total: 600 })); // 1100 cumulative -> over
	assert.deepEqual(fired, [["token_budget", 1100]], "fires inside record(), before it returns");
	assert.equal(meter.state.breached, true);
	assert.equal(meter.state.stopReason, "token_budget");

	meter.record(usage({ total: 900 }));
	meter.record(usage({ total: 900 }));
	assert.deepEqual(fired, [["token_budget", 1100]], "exactly once, however much more arrives");
	assert.equal(meter.state.total, 2900, "accumulation continues so the overshoot stays visible");
});

test("a null or absent cap is a pure meter, not an error", () => {
	assert.doesNotThrow(() => createUsageMeter({ maxTokens: null }));
	assert.doesNotThrow(() => createUsageMeter({}));
	const meter = createUsageMeter({ maxTokens: null, onStop: () => assert.fail("no cap, no stop") });
	meter.record(usage({ total: 10_000_000 }));
	assert.equal(meter.state.breached, false);
});

test("rejects a nonsensical cap with attachTokenBudget's exact verdict", () => {
	// Both read the same PI_MAX_TOKENS knob; two different verdicts on one value would be a trap.
	for (const bad of [0, -1, 1.5, Number.NaN]) {
		assert.throws(() => createUsageMeter({ maxTokens: bad }), /invalid PI_MAX_TOKENS/);
	}
});

test("observe returns the same stream object and does not consume it", async () => {
	const meter = createUsageMeter({ maxTokens: null });
	const stream = new FakeStream();
	stream.push({ type: "text_delta", delta: "a" });
	stream.push({ type: "text_delta", delta: "b" });
	stream.end(settledWith(usage({ input: 7, output: 3, total: 10 })));

	const returned = meter.observe(stream, { sessionId: "s1" });

	assert.equal(returned, stream, "no proxy, no wrapper -- pi compares stream identity downstream");
	const events = await drain(stream);
	assert.equal(events.length, 2, "result() must not steal events from the iterator");
	await flush();
	assert.equal(meter.state.total, 10);
});

test("unresolved rises on observe and falls on settle; a hung stream stays counted", async () => {
	const meter = createUsageMeter({ maxTokens: null });

	const settledStream = new FakeStream();
	meter.observe(settledStream);
	assert.equal(meter.state.unresolved, 1);
	assert.equal(meter.state.calls, 1);
	settledStream.end(settledWith(usage({ total: 42 })));
	await flush();
	assert.equal(meter.state.unresolved, 0);
	assert.equal(meter.state.total, 42);

	const hung = new FakeStream(); // never ends
	meter.observe(hung);
	await flush();
	assert.equal(meter.state.unresolved, 1, "an unsettled call means the totals are a floor");
	assert.equal(meter.state.calls, 2);
});

test("a rejected result() is swallowed, clears unresolved, and counts as unpriced on its own row", async () => {
	const meter = createUsageMeter({ maxTokens: null });
	const stream = new FakeStream();
	meter.observe(stream, { provider: MODEL.provider, modelId: MODEL.id });
	stream.fail(new Error("transport died"));
	await flush();
	assert.equal(meter.state.unresolved, 0);
	assert.equal(meter.state.total, 0);
	// Issue #501: what a rejected call spent is unknown, and a dollar settlement must not read unknown as zero.
	assert.equal(meter.state.unpriced, 1);
	assert.deepEqual(meter.usageSnapshot().models.map((row) => [row.model, row.calls, row.unpriced]), [[MODEL.id, 1, 1]]);
	const promised = Promise.reject(new Error("no"));
	meter.observeResult(promised, {});
	await flush();
	assert.equal(meter.state.unpriced, 2, "the result methods too");
});

test("observing the same stream twice counts it once", async () => {
	// ModelRegistry.refresh() re-applies our stored configs as fresh entry objects, so a wrapper chain
	// can form across a reload and hand the identical stream to every link.
	const meter = createUsageMeter({ maxTokens: null });
	const stream = streamOf(usage({ total: 60 }));
	meter.observe(stream);
	meter.observe(stream);
	await flush();
	assert.equal(meter.state.calls, 1);
	assert.equal(meter.state.total, 60);
});

test("counts unpriced calls instead of pricing them at zero", async () => {
	const meter = createUsageMeter({ maxTokens: null });

	meter.record({ input: 1, output: 1, totalTokens: 2 }); // no cost object at all
	meter.record({ input: 1, output: 1, totalTokens: 2, cost: {} }); // cost, no total
	meter.record({ input: 1, output: 1, totalTokens: 2, cost: { total: "1.5" } }); // not a number
	meter.record({ input: 1, output: 1, totalTokens: 2, cost: { total: Number.NaN } });

	assert.equal(meter.state.unpriced, 4);
	assert.equal(meter.state.cost, 0);
	assert.equal(Number.isNaN(meter.state.cost), false, "a NaN cost would poison the whole run record");
	assert.equal(meter.state.total, 8, "unpriced calls still count their tokens");

	meter.record(usage({ total: 5, cost: 0.25 }));
	assert.equal(meter.state.cost, 0.25);
	assert.equal(meter.state.unpriced, 4);
});

// ---------------------------------------------------------------------------------------------
// usageSnapshot -- the per-(provider,model) ledger (issue #53)
// ---------------------------------------------------------------------------------------------

test("lands every call on its (provider, model) row and keeps the rows a partition of the total", async () => {
	const meter = createUsageMeter({ maxTokens: null });

	// Two calls on one pair, carrying the cache split the flat totals collapse; one on a second pair.
	meter.observe(
		streamOf(usage({ input: 10, output: 5, cacheRead: 80, cacheWrite: 4, cacheWrite1h: 2, reasoning: 3, total: 101, cost: 0.25 })),
		{ sessionId: "s1", provider: "anthropic", modelId: "claude-x" },
	);
	meter.observe(streamOf(usage({ input: 1, output: 2, total: 49, cost: 0.5 })), { sessionId: "s2", provider: "anthropic", modelId: "claude-x" });
	meter.observe(streamOf(usage({ input: 3, output: 4, total: 30, cost: 0.125 })), { provider: "openai", modelId: "gpt-y" });
	// A call with no model ctx at all, and one with only HALF a pair: both must land on "other" --
	// counted, never guessed onto a model.
	meter.observe(streamOf(usage({ total: 7 })));
	meter.observe(streamOf(usage({ total: 5 })), { provider: "anthropic" });
	await flush();

	const snap = meter.usageSnapshot();
	assert.equal(snap.v, 1);
	assert.equal(snap.piAi, null, "no installer ran, so the pricing provenance is unknown -- and says so");
	assert.equal(snap.truncated, 0, "model-less calls are not truncation; no named row was folded");
	assert.deepEqual(snap.models, [
		{ provider: "anthropic", model: "claude-x", calls: 2, input: 11, output: 7, cacheRead: 80, cacheWrite: 4, cacheWrite1h: 2, reasoning: 3, total: 150, cost: 0.75, unpriced: 0 },
		{ provider: "openai", model: "gpt-y", calls: 1, input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 30, cost: 0.125, unpriced: 0 },
		{ provider: "other", model: "other", calls: 2, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 12, cost: 0, unpriced: 0 },
	]);
	// THE invariant the worker's reader leans on: every record lands on exactly one row, so the rows
	// partition the billed total -- same shape of claim as the root/other/loose split above.
	assert.equal(
		snap.models.reduce((sum, row) => sum + row.total, 0),
		meter.state.total,
		"the ledger rows must sum to the flat billed total exactly",
	);
});

test("caps the ledger at 8 named rows and folds the overflow numerically into other", async () => {
	const meter = createUsageMeter({ maxTokens: null });
	for (let i = 1; i <= 10; i += 1) {
		meter.observe(streamOf(usage({ input: i, total: i * 10, cost: 0.25 })), { provider: "prov", modelId: `model-${i}` });
	}
	meter.observe(streamOf(usage({ total: 5 }))); // model-less: lands on other, must NOT count as truncated
	await flush();

	const snap = meter.usageSnapshot();
	assert.equal(snap.models.length, 9, "8 named rows plus the fold row");
	assert.equal(snap.truncated, 2, "only folded NAMED rows count; the model-less call was never a row to lose");
	assert.deepEqual(
		snap.models.slice(0, 8).map((row) => row.model),
		["model-10", "model-9", "model-8", "model-7", "model-6", "model-5", "model-4", "model-3"],
		"kept rows are the top 8 by billed total, descending",
	);
	const other = snap.models.at(-1);
	assert.equal(other.provider, "other");
	assert.equal(other.model, "other");
	assert.equal(other.calls, 3, "two folded rows plus one model-less call");
	assert.equal(other.total, 35, "20 + 10 folded, 5 model-less -- the fold is numeric, never lossy");
	assert.equal(other.input, 3, "2 + 1 from the folded rows' own numerics");
	assert.equal(other.cost, 0.5);
	assert.equal(
		snap.models.reduce((sum, row) => sum + row.total, 0),
		meter.state.total,
		"the numeric fold preserves the partition invariant",
	);
	// Re-emittable: the fold must work on a copy of the bucket, not compound into live state.
	assert.deepEqual(meter.usageSnapshot(), snap);
});

test("prices each row separately and counts a costless call as unpriced on ITS row", async () => {
	const meter = createUsageMeter({ maxTokens: null });
	meter.observe(streamOf(usage({ total: 10, cost: 0.25 })), { provider: "anthropic", modelId: "claude-x" });
	meter.observe(streamOf({ input: 1, output: 1, totalTokens: 2 }), { provider: "anthropic", modelId: "claude-x" }); // no cost object at all
	meter.observe(streamOf(usage({ total: 3, cost: 0.5 })), { provider: "openai", modelId: "gpt-y" });
	await flush();

	const [anthropic, openai] = meter.usageSnapshot().models;
	assert.equal(anthropic.calls, 2);
	assert.equal(anthropic.cost, 0.25);
	assert.equal(anthropic.unpriced, 1, "counted on the row, never priced at zero -- the flat counter's rule, per model");
	assert.equal(openai.cost, 0.5);
	assert.equal(openai.unpriced, 0);
	assert.equal(meter.state.unpriced, 1, "the row counters mirror the flat one; they do not replace it");
});

test("usageSnapshot is null until a call is observed, and piAi is null until the installer stamps it", async () => {
	const meter = createUsageMeter({ maxTokens: null });
	assert.equal(meter.usageSnapshot(), null, "zero calls -> no usage key on the exit line, not an empty ledger");

	meter.setPiAiVersion("0.80.7"); // a stamp must not conjure a ledger out of zero calls
	assert.equal(meter.usageSnapshot(), null);

	meter.observe(streamOf(usage({ total: 1 })), { provider: "p", modelId: "m" });
	await flush();
	assert.equal(meter.usageSnapshot().piAi, "0.80.7");

	// Anything that is not a non-empty string is ignored, never stored: piAi is a version or null.
	for (const bad of ["", 42, null, undefined, { version: "9.9.9" }]) meter.setPiAiVersion(bad);
	assert.equal(meter.usageSnapshot().piAi, "0.80.7");
});

test("the worst-case exit line fits the worker's 8 KiB recovery tail with headroom", async () => {
	// The worker rebuilds `turns`/`tokens`/`usage` from a bounded tail of container stdout
	// (worker/src/run-history.mjs, TAIL_CAP_BYTES = 8 KiB), and a line the tail truncates loses ALL
	// token accounting at once -- so this budget is load-bearing, and the 8-row cap is what upholds
	// it. Maximal by construction: 9 distinct models with 64-char provider AND model ids (one folds),
	// a model-less call to force the other row, 8-digit token counts everywhere, every session
	// distinct. If this ever fails, shrink the cap in usage-meter.mjs; do not widen this number.
	// The 5000 budgets THIS line only, which is a completed run's: no `message` and no `context` key. The
	// full worst case (this ledger plus `context`, the longest session reason and the 2000-character capped
	// message a provider-refusal exit carries) is measured against the tail in
	// worker/test/run-history.test.mjs, which holds it under 6 KiB; that, not this number, is the headroom.
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root-0" });
	const wide = (prefix, i) => `${prefix}-${i}`.padEnd(64, "x");
	for (let i = 0; i < 9; i += 1) {
		meter.observe(
			streamOf(usage({
				input: 99_999_999,
				output: 99_999_999,
				cacheRead: 99_999_999,
				cacheWrite: 99_999_999,
				cacheWrite1h: 99_999_999,
				reasoning: 99_999_999,
				total: 99_999_999,
				cost: 99_999.99,
			})),
			{ sessionId: `session-${i}`, provider: wide("provider", i), modelId: wide("model", i) },
		);
	}
	meter.observe(streamOf(usage({ total: 99_999_999 })));
	await flush();
	meter.setPiAiVersion("88.88.88");

	const ledger = meter.usageSnapshot();
	assert.equal(ledger.models.length, 9, "the worst case must actually be built: 8 named rows of 64-char ids plus other");
	assert.equal(ledger.truncated, 1);
	const line = JSON.stringify({
		event: "exit",
		jobId: "repeat:very-long-schedule-name:1767225600000",
		code: 0,
		reason: "completed",
		turns: 4096,
		tokens: meter.snapshot(),
		usage: ledger,
		session: { resumed: false, reason: "absent" },
		// Issue #596: the cgroup block, every key at the largest safe integer, the most it can serialise to.
		resources: Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Number.MAX_SAFE_INTEGER])),
	});
	assert.ok(line.includes('"resources":{"memPeak":9007199254740991,'), "the worst case must carry the block");
	assert.ok(line.length < 5000, `the worst-case exit line must leave tail headroom; got ${line.length} chars`);
});

// ---------------------------------------------------------------------------------------------
// observeResult (classify, generateImages)
// ---------------------------------------------------------------------------------------------

test("observeResult counts a promise-returning call and records its result's usage", async () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	let settle;
	const promise = new Promise((resolve) => {
		settle = resolve;
	});
	assert.equal(meter.observeResult(promise, { sessionId: "root", provider: "p", modelId: "m" }), promise, "the promise is returned untouched");
	assert.equal(meter.state.calls, 1);
	assert.equal(meter.state.unresolved, 1, "unsettled until the result arrives");
	settle({ usage: usage({ input: 4, output: 1, cost: 0.2 }) });
	await flush();
	assert.equal(meter.state.unresolved, 0);
	assert.equal(meter.state.rootTotal, 5);
	assert.equal(meter.usageSnapshot().models[0].model, "m");
	// A result without usage (a local classifier) is COUNTED as unpriced, never priced at zero.
	meter.observeResult(Promise.resolve({ answers: {} }), {});
	await flush();
	assert.equal(meter.state.calls, 2);
	assert.equal(meter.state.unpriced, 1);
	// A rejection is swallowed and still clears unresolved.
	meter.observeResult(Promise.reject(new Error("boom")), {});
	await flush();
	assert.equal(meter.state.unresolved, 0);
});

// ---------------------------------------------------------------------------------------------
// wrapModelRuntime -- THE choke point at 0.99.1
// ---------------------------------------------------------------------------------------------

/**
 * A ModelRuntime-shaped class. The methods read `this.tag`, so a wrapper that dropped `this` fails here, and
 * streamSimple re-enters itself for a virtual model exactly as the real one does (model-runtime.js:489-509).
 */
function fakeRuntimeClass() {
	const calls = [];
	class FakeRuntime {
		constructor(tag = "rt") {
			this.tag = tag;
		}
		streamSimple(model, context, options) {
			calls.push({ method: "streamSimple", tag: this.tag, model: model.id });
			if (model.api === VIRTUAL_MODEL_API) {
				// Like the real one: the routed call's stream is a NEW object (lazyStream) that forwards the
				// physical call's result, so identity dedupe cannot hide a double count here.
				const inner = this.streamSimple({ ...PHYSICAL }, context, options);
				const outer = new FakeStream();
				inner.result().then((message) => outer.end(message));
				return outer;
			}
			return streamOf(usage({ input: 10, output: 5, cost: 0.5 }));
		}
		stream(model) {
			calls.push({ method: "stream", tag: this.tag, model: model.id });
			return streamOf(usage({ input: 1, output: 1 }));
		}
		streamDeferred(model) {
			calls.push({ method: "streamDeferred", tag: this.tag, model: model.id });
			return streamOf(usage({ input: 2, output: 2 }));
		}
		async classify(model) {
			calls.push({ method: "classify", tag: this.tag, model: model.id });
			return { answers: {}, usage: usage({ input: 3, output: 0, cost: 0.01 }), stopReason: "stop" };
		}
		async generateImages(model) {
			calls.push({ method: "generateImages", tag: this.tag, model: model.id });
			return { output: [], usage: usage({ input: 0, output: 7, cost: 0.07 }), stopReason: "stop" };
		}
		getModel() {
			return null;
		}
	}
	return { FakeRuntime, calls };
}
const PHYSICAL = { api: "anthropic-messages", provider: "anthropic", id: "claude-physical" };
const VIRTUAL = { api: VIRTUAL_MODEL_API, provider: "router", id: "auto" };

test("the runtime layer counts every model-calling method, with sessionId and the dispatched model, and keeps `this`", async () => {
	const { FakeRuntime, calls } = fakeRuntimeClass();
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter });
	try {
		assert.deepEqual(layer.methods, [...RUNTIME_STREAM_METHODS, ...RUNTIME_RESULT_METHODS]);
		const runtime = new FakeRuntime("mine");
		runtime.streamSimple(MODEL, [], { sessionId: "root" });
		runtime.stream(MODEL, [], { sessionId: "child" });
		// streamDeferred's options are its THIRD argument (model, handle, options), like the other two.
		runtime.streamDeferred(MODEL, { id: "h" }, { sessionId: "child" });
		await runtime.classify(MODEL, {}, { sessionId: "child" });
		await runtime.generateImages(MODEL, {}, {});
		await flush();

		assert.deepEqual(calls.map((c) => c.tag), ["mine", "mine", "mine", "mine", "mine"], "every original ran with its own `this`");
		assert.equal(meter.state.calls, 5);
		assert.equal(meter.state.rootTotal, 15);
		assert.equal(meter.state.otherTotal, 2 + 4 + 3, "stream, streamDeferred and classify carried the child's id");
		assert.equal(meter.state.looseTotal, 7, "generateImages carried none");
		assert.equal(meter.state.cost, 0.5 + 0.01 + 0.07);
		const [row] = meter.usageSnapshot().models;
		assert.deepEqual([row.provider, row.model, row.calls], [MODEL.provider, MODEL.id, 5], "the ledger names the model dispatched on");
	} finally {
		layer.restore();
	}
});

test("a virtual model is counted ONCE, as the physical model it routed to", async () => {
	// ModelRuntime.streamSimple routes a pi-virtual model and calls this.streamSimple again with the physical
	// model; counting both would double every routed request and put a model nobody billed in the ledger.
	const { FakeRuntime, calls } = fakeRuntimeClass();
	const meter = createUsageMeter({ maxTokens: null });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter });
	try {
		new FakeRuntime().streamSimple(VIRTUAL, [], { sessionId: "s" });
		await flush();
		assert.deepEqual(calls.map((c) => c.model), ["auto", "claude-physical"], "the premise: the virtual call re-entered");
		assert.equal(meter.state.calls, 1);
		assert.deepEqual(meter.usageSnapshot().models.map((r) => r.model), ["claude-physical"]);
	} finally {
		layer.restore();
	}
});

test("past the cap the runtime layer's brake answers every method without calling the provider", async () => {
	const { FakeRuntime, calls } = fakeRuntimeClass();
	const meter = createUsageMeter({ maxTokens: 10 });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream(), message: "cap" });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop });
	try {
		meter.record(usage({ total: 99 }));
		const runtime = new FakeRuntime();
		for (const method of RUNTIME_STREAM_METHODS) {
			const message = await runtime[method](MODEL, [], {}).result();
			assert.equal(message.stopReason, "aborted", `${method}: an abort, never an error pi would retry`);
			assert.equal(message.usage.totalTokens, 0);
		}
		const classified = await runtime.classify(MODEL, {}, {});
		assert.deepEqual([classified.stopReason, classified.usage.totalTokens, classified.model], ["aborted", 0, MODEL.id]);
		assert.deepEqual(classified.answers, {});
		const images = await runtime.generateImages(MODEL, {}, {});
		assert.deepEqual([images.stopReason, images.usage.cost.total], ["aborted", 0]);
		assert.deepEqual(images.output, []);
		// A virtual model is braked too: past the cap nothing is dispatched, routed or not.
		await runtime.streamSimple(VIRTUAL, [], {}).result();
		assert.equal(calls.length, 0, "no provider may be reached once the cap is blown");
		assert.equal(meter.state.calls, 0, "a braked call is not a call");
		assert.equal(meter.state.total, 99);
	} finally {
		layer.restore();
	}
});

test("an uncapped runtime layer never brakes, even after a breach", () => {
	const { FakeRuntime, calls } = fakeRuntimeClass();
	const meter = createUsageMeter({ maxTokens: 10 });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop: null });
	try {
		meter.record(usage({ total: 99 }));
		new FakeRuntime().streamSimple(MODEL, [], {});
		assert.equal(calls.length, 1, "no hard-stop stream means the call goes through; the session abort is the other half");
	} finally {
		layer.restore();
	}
});

test("covers() is the acceptance test: an instance of the class, with no own method shadowing a wrapper", () => {
	const { FakeRuntime } = fakeRuntimeClass();
	const { FakeRuntime: Other } = fakeRuntimeClass();
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter: createUsageMeter({}) });
	try {
		assert.equal(layer.covers(new FakeRuntime()), true);
		assert.equal(layer.covers(new Other()), false, "an instance of ANOTHER copy of the class dispatches around us");
		const shadowed = new FakeRuntime();
		shadowed.streamSimple = FakeRuntime.prototype.streamSimple.bind(shadowed);
		assert.equal(layer.covers(shadowed), false, "an own property wins over the prototype");
		assert.equal(layer.covers(null), false);
	} finally {
		layer.restore();
	}
});

test("restore() puts the originals back, and never tears a later layer out from under itself", async () => {
	const { FakeRuntime } = fakeRuntimeClass();
	const original = FakeRuntime.prototype.streamSimple;
	const first = createUsageMeter({});
	const firstLayer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter: first });
	assert.notEqual(FakeRuntime.prototype.streamSimple, original);
	firstLayer.restore();
	assert.equal(FakeRuntime.prototype.streamSimple, original, "a lone layer restores exactly");

	const inner = createUsageMeter({});
	const outer = createUsageMeter({});
	const innerLayer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter: inner });
	const outerLayer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter: outer });
	const outerWrapper = FakeRuntime.prototype.streamSimple;
	innerLayer.restore();
	assert.equal(FakeRuntime.prototype.streamSimple, outerWrapper, "the outer layer stays installed");
	new FakeRuntime().streamSimple(MODEL, [], {});
	await flush();
	assert.equal(outer.state.calls, 1);
	assert.equal(inner.state.calls, 0, "the restored inner layer passes through without counting");
	outerLayer.restore();
	// What is left is the inner layer's wrapper, switched to pass-through: calls reach the original and
	// neither meter counts them.
	new FakeRuntime().streamSimple(MODEL, [], {});
	await flush();
	assert.deepEqual([inner.state.calls, outer.state.calls], [0, 1]);
});

// ---------------------------------------------------------------------------------------------
// wrapProviderStreams -- the compat half, for legacy extension calls
// ---------------------------------------------------------------------------------------------

/** A builtin provider as pi-ai's catalog holds it: its models, and its own stream functions. */
function fakeProvider(id, models) {
	const calls = [];
	return {
		id,
		calls,
		getModels: () => models,
		streamSimple(model, context, options) {
			calls.push({ kind: "streamSimple", model, options });
			return streamOf(usage({ input: 10, output: 5, total: 15, cost: 0.5 }));
		},
		stream(model, context, options) {
			calls.push({ kind: "stream", model, options });
			return streamOf(usage({ input: 10, output: 5, total: 15, cost: 0.5 }));
		},
	};
}

/** A `Models`-shaped stand-in for pi-ai's builtinModels() catalog collection. */
function fakeCatalog(providers) {
	const calls = [];
	return {
		calls,
		getProvider: (id) => providers.find((p) => p.id === id),
		streamSimple(model, context, options) {
			calls.push({ kind: "streamSimple", model, options });
			return streamOf(usage({ input: 20, output: 5, total: 25, cost: 0.7 }));
		},
		stream(model, context, options) {
			calls.push({ kind: "stream", model, options });
			return streamOf(usage({ input: 20, output: 5, total: 25, cost: 0.7 }));
		},
	};
}

/** A registry-entry-shaped stand-in for a registered api provider. */
function fakeInner() {
	const calls = [];
	const streams = (kind) => (model, context, options) => {
		calls.push({ kind, model, context, options });
		return streamOf(usage({ input: 1, output: 2, total: 3, cost: 0.1 }));
	};
	return { api: MODEL.api, calls, streamSimple: streams("streamSimple"), stream: streams("stream") };
}

test("routes a model of a builtin provider to that provider's own stream, as compat itself would", async () => {
	// Overriding a builtin api makes compat's getBuiltinProviderForModel answer undefined, so compat hands us
	// the models it would otherwise have sent to its builtin provider (pi-ai 0.99.1 compat.js). The decision is
	// the PROVIDER's: any model of it on the same api, so an operator's extra model id under a builtin
	// provider still takes the provider's path.
	const meter = createUsageMeter({ maxTokens: null });
	const provider = fakeProvider("anthropic", [MODEL]);
	const catalog = fakeCatalog([provider]);
	const inner = fakeInner();
	const wrapper = wrapProviderStreams({ inner, fallbackModels: catalog, meter });

	const stream = wrapper.streamSimple({ ...MODEL, id: "operator-added" }, [], { sessionId: "child-9" });
	await flush();

	assert.equal(provider.calls.length, 1);
	assert.equal(catalog.calls.length, 0, "a non-cloudflare builtin skips the collection's auth layer, exactly as compat does");
	assert.equal(inner.calls.length, 0);
	assert.equal(provider.calls[0].options.sessionId, "child-9", "options must pass through intact");
	assert.equal(meter.state.total, 15);
	assert.equal(meter.state.otherTotal, 15, "sessionId from StreamOptions is what makes attribution work");
	assert.equal(typeof stream.result, "function");
});

test("routes a cloudflare model through the catalog collection, whose auth layer substitutes its placeholders", async () => {
	const meter = createUsageMeter({ maxTokens: null });
	const model = { api: "openai-completions", provider: "cloudflare-workers-ai", id: "cf-1" };
	const provider = fakeProvider("cloudflare-workers-ai", [model]);
	const catalog = fakeCatalog([provider]);
	const inner = fakeInner();
	const wrapper = wrapProviderStreams({ inner, fallbackModels: catalog, meter });
	wrapper.streamSimple(model, [], {});
	wrapper.stream(model, [], {});
	await flush();
	assert.deepEqual(catalog.calls.map((c) => c.kind), ["streamSimple", "stream"]);
	assert.equal(provider.calls.length, 0);
	assert.equal(inner.calls.length, 0);
	assert.equal(meter.state.total, 50);
});

test("routes a non-catalog provider, or a catalog provider with no model on this api, to the registry entry", async () => {
	const meter = createUsageMeter({ maxTokens: null });
	const provider = fakeProvider("anthropic", [{ ...MODEL, api: "openai-completions" }]);
	const catalog = fakeCatalog([provider]);
	const inner = fakeInner();
	const wrapper = wrapProviderStreams({ inner, fallbackModels: catalog, meter });
	wrapper.streamSimple({ api: "openai-completions", provider: "acme", id: "acme-1" }, [], {});
	// An operator override can repoint a catalog provider's model at another api; compat compares apis.
	wrapper.streamSimple(MODEL, [], {});
	await flush();
	assert.equal(inner.calls.length, 2);
	assert.equal(provider.calls.length + catalog.calls.length, 0);
	assert.equal(meter.state.looseTotal, 6);
});

test("with no catalog loaded everything falls back to the registry entry, stream and streamSimple alike", async () => {
	const meter = createUsageMeter({ maxTokens: null });
	const inner = fakeInner();
	const wrapper = wrapProviderStreams({ inner, fallbackModels: null, meter });
	wrapper.streamSimple(MODEL, [], {});
	wrapper.stream(MODEL, [], {});
	await flush();
	assert.deepEqual(inner.calls.map((c) => c.kind), ["streamSimple", "stream"]);
	assert.equal(meter.state.calls, 2, "compat's stream() is a model call too: registerApiProvider wraps both");
});

test("a compat call made inside the same install's runtime dispatch is routed but not counted twice", async () => {
	// Trap #5: pi composes a provider with no builtin base so that its stream, INSIDE ModelRuntime.streamSimple
	// and after awaits, resolves the api in the compat registry. The runtime half has already counted that
	// call; the shared AsyncLocalStorage is how the compat wrapper knows.
	const meter = createUsageMeter({ maxTokens: null });
	const dispatch = new AsyncLocalStorage();
	const inner = fakeInner();
	const compatEntry = wrapProviderStreams({ inner, fallbackModels: null, meter, dispatch });
	class ComposingRuntime {
		streamSimple(model, context, options) {
			const outer = new FakeStream();
			(async () => {
				await flush(); // the lazyStream setup's awaits: the marker must survive them
				const message = await compatEntry.streamSimple(model, context, options).result();
				outer.end(message);
			})();
			return outer;
		}
		stream() {
			return streamOf(usage({}));
		}
	}
	const layer = wrapModelRuntime({ ModelRuntime: ComposingRuntime, meter, dispatch });
	try {
		await new ComposingRuntime().streamSimple(MODEL, [], {}).result();
		await flush();
		assert.equal(inner.calls.length, 1, "the composed call still reached its provider");
		assert.equal(meter.state.calls, 1, "counted once, by the runtime half");
		assert.equal(meter.state.total, 3);
		// Outside any runtime dispatch the same entry counts, as a legacy extension call must.
		compatEntry.streamSimple(MODEL, [], {});
		await flush();
		assert.equal(meter.state.calls, 2);
	} finally {
		layer.restore();
	}
});

test("hands the meter the model identity compat dispatched on, so the ledger row is never a guess", async () => {
	const meter = createUsageMeter({ maxTokens: null });
	const inner = fakeInner();
	wrapProviderStreams({ inner, fallbackModels: null, meter }).streamSimple(MODEL, [], { sessionId: "s1" });
	await flush();

	const [row] = meter.usageSnapshot().models;
	assert.equal(row.provider, MODEL.provider);
	assert.equal(row.model, MODEL.id);
	assert.equal(row.calls, 1);
});

test("after a breach the compat half's hard stop replaces the call entirely", async () => {
	const meter = createUsageMeter({ maxTokens: 10 });
	const provider = fakeProvider("anthropic", [MODEL]);
	const catalog = fakeCatalog([provider]);
	const inner = fakeInner();
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream(), message: "cap" });
	const wrapper = wrapProviderStreams({ inner, fallbackModels: catalog, meter, hardStop });

	meter.record(usage({ total: 99 })); // breach
	assert.equal(meter.state.breached, true);

	const stream = wrapper.streamSimple(MODEL, [], { sessionId: "child-1" });
	const message = await stream.result();

	assert.equal(inner.calls.length + provider.calls.length + catalog.calls.length, 0, "no provider may be reached once the cap is blown");
	// "aborted", not "error": pi's isRetryableAssistantError returns false unless stopReason is
	// "error", so this terminal message cannot spin pi's auto-retry into paid retries.
	assert.equal(message.stopReason, "aborted");
	assert.equal(message.usage.totalTokens, 0);
	assert.equal(message.usage.cost.total, 0);
	assert.equal(message.role, "assistant");
	assert.equal(message.api, MODEL.api);
	assert.equal(message.provider, MODEL.provider);
	assert.equal(message.model, MODEL.id);
	assert.equal(stream.events[0].type, "error");
	assert.equal(stream.events[0].reason, "aborted");
	assert.equal(meter.state.total, 99, "a stopped call must not add usage of its own");
});

test("an unarmed hard stop never blocks, even after a breach", async () => {
	const meter = createUsageMeter({ maxTokens: 10 });
	const inner = fakeInner();
	meter.record(usage({ total: 99 }));
	wrapProviderStreams({ inner, fallbackModels: null, meter, hardStop: null }).streamSimple(MODEL, [], {});
	assert.equal(inner.calls.length, 1, "uncapped jobs must never have a call stopped");
});

test("makeHardStopStream refuses to run without an injected stream factory", () => {
	// Defaulting it would mean importing pi statically, which is the bug this module exists to avoid.
	assert.throws(() => makeHardStopStream({}), /createStream/);
});

// ---------------------------------------------------------------------------------------------
// resolvePiAiCompat
// ---------------------------------------------------------------------------------------------

const AGENT_ENTRY = "file:///app/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const HOISTED_COMPAT = "file:///app/node_modules/@earendil-works/pi-ai/dist/compat.js";
const NESTED_COMPAT =
	"file:///app/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js";

function fakeResolve(map) {
	return (specifier) => {
		if (!(specifier in map)) throw new Error(`Cannot find package '${specifier}'`);
		return map[specifier];
	};
}

/** An `exists` that answers true only for these file paths (as the URLs the resolver asks with). */
function onDisk(...paths) {
	const urls = new Set(paths.map((path) => pathToFileURL(path).href));
	return (url) => urls.has(url);
}
const NESTED_AI = "/app/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai";
const HOISTED_AI = "/app/node_modules/@earendil-works/pi-ai";

test("prefers pi's OWN pi-ai copy, the one pi-coding-agent's own imports resolve to, in a nested layout", () => {
	// The shrinkwrapped layout up to pi 0.99.1: pi's copy nested under it, the worker's hoisted. Both offered, pi's first.
	const candidates = resolvePiAiCompat({
		resolve: fakeResolve({
			"@earendil-works/pi-coding-agent": AGENT_ENTRY,
			"@earendil-works/pi-ai/compat": HOISTED_COMPAT,
		}),
		exists: onDisk(`${NESTED_AI}/package.json`, `${NESTED_AI}/dist/compat.js`, `${HOISTED_AI}/package.json`, `${HOISTED_AI}/dist/compat.js`),
	});
	assert.deepEqual(candidates, [
		{ tag: "pi", url: NESTED_COMPAT },
		{ tag: "hoisted", url: HOISTED_COMPAT },
	]);
});

test("in a flat layout pi's own copy IS the hoisted one, offered once (issue #587)", () => {
	// pi 1.0.3: no shrinkwrap, one copy at the top. pi's own lookup walks past its package to /app/node_modules.
	const candidates = resolvePiAiCompat({
		resolve: fakeResolve({
			"@earendil-works/pi-coding-agent": AGENT_ENTRY,
			"@earendil-works/pi-ai/compat": HOISTED_COMPAT,
		}),
		exists: onDisk(`${HOISTED_AI}/package.json`, `${HOISTED_AI}/dist/compat.js`),
	});
	assert.deepEqual(candidates, [{ tag: "pi", url: HOISTED_COMPAT }]);
	assert.equal(piOwnPackageDir("pi-agent-core", { resolve: fakeResolve({ "@earendil-works/pi-coding-agent": AGENT_ENTRY }), exists: onDisk(`${HOISTED_AI}/package.json`) }), null, "a package nobody installed is null, not a guess");
});

test("pi's lookup walks the directories Node's own does, in Node's order, and never into a node_modules/node_modules", () => {
	// Node's list for a package at /app/node_modules/@earendil-works/pi-coding-agent (Module._nodeModulePaths, measured):
	// its own node_modules, /app/node_modules/@earendil-works/node_modules, /app/node_modules, /node_modules. Never
	// /app/node_modules/node_modules: a directory that is itself a node_modules is skipped.
	const scope = "/app/node_modules/@earendil-works/node_modules/@earendil-works/pi-ai";
	const decoy = "/app/node_modules/node_modules/@earendil-works/pi-ai";
	const resolve = fakeResolve({ "@earendil-works/pi-coding-agent": AGENT_ENTRY });
	assert.equal(piOwnPackageDir("pi-ai", { resolve, exists: onDisk(`${decoy}/package.json`) }), null);
	assert.equal(piOwnPackageDir("pi-ai", { resolve, exists: onDisk(`${decoy}/package.json`, `${HOISTED_AI}/package.json`) }), HOISTED_AI);
	assert.equal(piOwnPackageDir("pi-ai", { resolve, exists: onDisk(`${scope}/package.json`, `${HOISTED_AI}/package.json`) }), scope, "nearer wins");
	assert.equal(piOwnPackageDir("pi-ai", { resolve, exists: onDisk(`${NESTED_AI}/package.json`, `${scope}/package.json`) }), NESTED_AI, "nearest wins");
	assert.equal(piOwnPackageDir("pi-ai", { resolve, exists: onDisk("/node_modules/@earendil-works/pi-ai/package.json") }), "/node_modules/@earendil-works/pi-ai", "the walk reaches the root");
});

test("falls back to a bare specifier's copy when pi's own lookup finds nothing", () => {
	const candidates = resolvePiAiCompat({
		resolve: fakeResolve({
			"@earendil-works/pi-coding-agent": AGENT_ENTRY,
			"@earendil-works/pi-ai/compat": HOISTED_COMPAT,
		}),
		exists: () => false,
	});
	assert.deepEqual(candidates, [{ tag: "hoisted", url: HOISTED_COMPAT }]);
});

test("an unresolvable package yields no candidate rather than throwing", () => {
	assert.deepEqual(resolvePiAiCompat({ resolve: fakeResolve({}), exists: () => true }), []);
	assert.equal(piOwnPackageDir("pi-ai", { resolve: fakeResolve({}), exists: () => true }), null);
	const onlyAgent = resolvePiAiCompat({
		resolve: fakeResolve({ "@earendil-works/pi-coding-agent": AGENT_ENTRY }),
		exists: () => true,
	});
	assert.deepEqual(onlyAgent, [{ tag: "pi", url: NESTED_COMPAT }]);
});

// ---------------------------------------------------------------------------------------------
// installProcessUsageMeter
// ---------------------------------------------------------------------------------------------

/**
 * A pi-ai compat copy: a module-level api-provider registry plus the compat exports we touch. Two of these
 * exist on a dev box and only ONE is the module pi hands its extensions, which is the whole reason the
 * installer checks identity instead of trusting a resolved path.
 */
function fakeCopy(apis = []) {
	const registry = new Map();
	const seedBuiltins = () => {
		for (const api of apis) registry.set(api, { api, streamSimple: () => streamOf(usage({ total: 1 })), stream: () => streamOf(usage({ total: 1 })) });
	};
	seedBuiltins();
	return {
		registry,
		// resetApiProviders(): clears every registration, then re-registers the builtins as FRESH
		// objects. This is what AgentSession.reload() triggers, and why the compat half must be re-armable.
		reset() {
			registry.clear();
			seedBuiltins();
		},
		module: {
			// Like the real one: every registration stores a FRESH provider object, filed under a sourceId.
			registerApiProvider: (provider, sourceId) => registry.set(provider.api, { api: provider.api, stream: provider.stream, streamSimple: provider.streamSimple, sourceId }),
			getApiProvider: (api) => registry.get(api) ?? null,
			getApiProviders: () => [...registry.values()],
			createAssistantMessageEventStream: () => new FakeStream(),
		},
	};
}

/** The sibling the installer loads for builtinModels(), resolved relative to the accepted compat url. */
const NESTED_PROVIDERS = new URL("./providers/all.js", NESTED_COMPAT).href;

function installArgs({ copy, extensionCopy = copy, ...rest }) {
	const { FakeRuntime } = fakeRuntimeClass();
	return {
		ModelRuntime: FakeRuntime,
		meter: createUsageMeter({ maxTokens: null }),
		resolve: fakeResolve({
			"@earendil-works/pi-coding-agent": AGENT_ENTRY,
			"@earendil-works/pi-ai/compat": HOISTED_COMPAT,
		}),
		exists: () => true,
		load: async (url) => {
			if (url === NESTED_COMPAT) return copy.module;
			// The default fixture has NO providers/all.js -- the degraded case, so it is the one the
			// baseline tests assert against rather than the one they quietly assume away.
			const error = new Error(`no such module: ${url}`);
			error.code = "ERR_MODULE_NOT_FOUND";
			throw error;
		},
		// What pi hands an extension for a bare pi-ai import: the oracle the compat half is accepted against.
		loadExtensionModules: async () => ({ "@earendil-works/pi-ai": extensionCopy?.module }),
		rearmMs: 60_000,
		platform: "darwin",
		...rest,
	};
}

test("installs the runtime half and the compat half, and says so on one line", async () => {
	const copy = fakeCopy(["anthropic-messages", "openai-completions"]);
	const args = installArgs({ copy });
	const logged = [];
	const handle = await installProcessUsageMeter({ ...args, log: (event, fields) => logged.push({ event, fields }) });
	handle.uninstall();

	assert.equal(handle.ok, true);
	assert.deepEqual(handle.methods, [...RUNTIME_STREAM_METHODS, ...RUNTIME_RESULT_METHODS]);
	assert.equal(handle.tag, "pi");
	assert.equal(handle.module, copy.module);
	assert.deepEqual(handle.apis, ["anthropic-messages", "openai-completions"]);
	assert.equal(handle.rearms, 0);
	for (const api of handle.apis) {
		assert.equal(copy.registry.get(api).sourceId, `${METER_PROVIDER_PREFIX}:${api}`, "one registration per api id, under our sourceId");
	}
	assert.deepEqual(logged, [
		{
			event: "usage_meter",
			fields: {
				ok: true,
				methods: [...RUNTIME_STREAM_METHODS, ...RUNTIME_RESULT_METHODS],
				compat: "pi",
				apis: ["anthropic-messages", "openai-completions"],
				// This fixture ships no providers/all.js and the meter is uncapped, so BOTH degradations
				// are present -- and both are stated. Reporting a bare ok:true here is the exact failure
				// these fields exist to remove.
				fallback: false,
				fallbackError: "ERR_MODULE_NOT_FOUND",
				capped: false,
				costCapped: false,
				listed: false,
				brake: false,
			},
		},
		{ event: "usage_meter_teardown", fields: { rearms: 0, apis: 2, rearmMs: 60_000 } },
	]);
	assert.equal(handle.children, null, "child sampling is Linux-only and degrades to null elsewhere");
});

test("a healthy meter reports its catalog and its brake as present", async () => {
	// The POSITIVE half. Without it, `fallback:false, brake:false` could be hard-wired and every
	// assertion above would still pass while the two fields said nothing about anything.
	const copy = fakeCopy(["anthropic-messages"]);
	const logged = [];
	const handle = await installProcessUsageMeter({
		...installArgs({ copy }),
		meter: createUsageMeter({ maxTokens: 1000 }),
		load: async (url) => {
			if (url === NESTED_COMPAT) return copy.module;
			if (url === NESTED_PROVIDERS) return { builtinModels: () => fakeCatalog([]) };
			throw new Error(`no such module: ${url}`);
		},
		log: (event, fields) => logged.push({ event, fields }),
	});
	handle.uninstall();

	assert.deepEqual(logged[0].fields, {
		ok: true,
		methods: [...RUNTIME_STREAM_METHODS, ...RUNTIME_RESULT_METHODS],
		compat: "pi",
		apis: ["anthropic-messages"],
		fallback: true,
		capped: true,
		costCapped: false,
		listed: false,
		brake: true,
	});
	assert.equal("fallbackError" in logged[0].fields, false, "a healthy load must not report a reason");
	assert.equal("compatError" in logged[0].fields, false);
});

test("a sibling that loads but exposes no builtinModels() is reported, not passed off as healthy", async () => {
	const copy = fakeCopy(["anthropic-messages"]);
	const logged = [];
	const handle = await installProcessUsageMeter({
		...installArgs({ copy }),
		load: async (url) => {
			if (url === NESTED_COMPAT) return copy.module;
			if (url === NESTED_PROVIDERS) return {};
			throw new Error(`no such module: ${url}`);
		},
		log: (event, fields) => logged.push({ event, fields }),
	});
	handle.uninstall();

	assert.equal(logged[0].fields.fallback, false);
	assert.equal(logged[0].fields.fallbackError, "no-builtin-models");
});

test("a cap with no stream factory is logged as capped-but-brakeless", async () => {
	// The silent one: the accepted module exposes neither createAssistantMessageEventStream nor
	// AssistantMessageEventStream, so the pre-dispatch brake vanishes and the cap can only be enforced
	// after a call has already been paid for. capped:true + brake:false is what says so.
	const copy = fakeCopy(["anthropic-messages"]);
	delete copy.module.createAssistantMessageEventStream;
	const logged = [];
	const handle = await installProcessUsageMeter({
		...installArgs({ copy }),
		meter: createUsageMeter({ maxTokens: 1000 }),
		log: (event, fields) => logged.push({ event, fields }),
	});
	handle.uninstall();

	assert.equal(logged[0].fields.capped, true);
	assert.equal(logged[0].fields.brake, false);
});

test("the compat copy is accepted by IDENTITY with the one pi hands extensions, never by path", async () => {
	// The exact failure trap #1 names: the nested copy imports cleanly and has every export, and is still
	// the wrong one when pi hands its extensions another. Here the extension-facing module is the HOISTED
	// fixture, so the nested one must be rejected and the hoisted one accepted.
	const nested = fakeCopy(["anthropic-messages"]);
	const hoisted = fakeCopy(["anthropic-messages"]);
	const handle = await installProcessUsageMeter({
		...installArgs({ copy: nested, extensionCopy: hoisted }),
		load: async (url) => {
			if (url === NESTED_COMPAT) return nested.module;
			if (url === HOISTED_COMPAT) return hoisted.module;
			throw new Error(`no such module: ${url}`);
		},
	});
	handle.uninstall();

	assert.equal(handle.ok, true);
	assert.equal(handle.tag, "hoisted", "acceptance is decided by identity, not by resolved path");
	assert.equal(nested.registry.get("anthropic-messages").sourceId, undefined, "the rejected copy is left alone");
	assert.equal(hoisted.registry.get("anthropic-messages").sourceId, `${METER_PROVIDER_PREFIX}:anthropic-messages`);
});

test("no provable compat copy degrades the meter LOUDLY and leaves the runtime half metering", async () => {
	// The compat half serves legacy extension calls only; a session's own calls go through ModelRuntime. So
	// losing it is `compat: false` with a reason on the line, never ok:false (which would drop the whole job
	// to the per-session bus meter) and never a silent ok:true either.
	const blind = fakeCopy(["anthropic-messages"]);
	const logged = [];
	const meter = createUsageMeter({ maxTokens: 1000, rootSessionId: "root" });
	const args = installArgs({ copy: blind, extensionCopy: fakeCopy([]) });
	const handle = await installProcessUsageMeter({
		...args,
		meter,
		load: async (url) => {
			if (url === NESTED_COMPAT || url === HOISTED_COMPAT) return blind.module;
			throw new Error(`no such module: ${url}`);
		},
		log: (event, fields) => logged.push({ event, fields }),
	});
	try {
		assert.equal(handle.ok, true);
		assert.equal(handle.tag, null);
		assert.equal(handle.module, null);
		assert.deepEqual(logged[0].fields, {
			ok: true,
			methods: [...RUNTIME_STREAM_METHODS, ...RUNTIME_RESULT_METHODS],
			compat: false,
			compatError: "no-candidate-matched",
			tried: ["pi", "hoisted"],
			apis: [],
			capped: true,
			costCapped: false,
			listed: false,
			// The brake's stream factory comes from the accepted copy, so without one the cap is
			// enforced only through session.abort(): capped-but-brakeless, said out loud.
			brake: false,
		});
		assert.equal(JSON.stringify(logged).includes("/"), false, "logs ship: tags only, never a filesystem path");
		assert.equal(blind.registry.get("anthropic-messages").sourceId, undefined, "nothing was registered into an unproven copy");
		new args.ModelRuntime().streamSimple(MODEL, [], { sessionId: "root" });
		await flush();
		assert.equal(meter.state.rootTotal, 15, "the runtime half meters regardless");
	} finally {
		handle.uninstall();
	}
});

test("extension modules that cannot be read are a named compat degradation, not a crash", async () => {
	const copy = fakeCopy(["anthropic-messages"]);
	const logged = [];
	const handle = await installProcessUsageMeter({
		...installArgs({ copy }),
		loadExtensionModules: async () => {
			const error = new Error("Cannot find module /some/path/virtual-modules.js");
			error.code = "ERR_MODULE_NOT_FOUND";
			throw error;
		},
		log: (event, fields) => logged.push({ event, fields }),
	});
	handle.uninstall();
	assert.equal(handle.ok, true);
	assert.equal(logged[0].fields.compat, false);
	assert.equal(logged[0].fields.compatError, "ERR_MODULE_NOT_FOUND", "a code, never the message: it carries a path");
	assert.deepEqual(logged[0].fields.tried, []);
});

test("returns ok:false only when the RUNTIME half cannot meter, so the caller falls back", async () => {
	const copy = fakeCopy(["anthropic-messages"]);
	for (const ModelRuntime of [undefined, class {}, class { streamSimple() {} }]) {
		const logged = [];
		const handle = await installProcessUsageMeter({ ...installArgs({ copy }), ModelRuntime, log: (event, fields) => logged.push({ event, fields }) });
		assert.equal(handle.ok, false);
		assert.doesNotThrow(() => handle.arm());
		assert.doesNotThrow(() => handle.uninstall());
		assert.deepEqual(logged, [{ event: "usage_meter_unavailable", fields: { reason: "no-runtime-methods" } }]);
	}
	assert.equal(copy.registry.get("anthropic-messages").sourceId, undefined, "a failed install arms nothing");
});

test("an instance that does not dispatch through the wrappers is refused, and the prototype is restored", async () => {
	// The runtime analogue of the old mutation probe: run-job hands over the instance the session will use,
	// and an instance of another class copy (or one with an own method) would be metered by nothing.
	const copy = fakeCopy(["anthropic-messages"]);
	const args = installArgs({ copy });
	const { FakeRuntime: Other } = fakeRuntimeClass();
	const original = args.ModelRuntime.prototype.streamSimple;
	const logged = [];
	const handle = await installProcessUsageMeter({ ...args, runtime: new Other(), log: (event, fields) => logged.push({ event, fields }) });
	assert.equal(handle.ok, false);
	assert.deepEqual(logged, [{ event: "usage_meter_unavailable", fields: { reason: "runtime-not-covered" } }]);
	assert.equal(args.ModelRuntime.prototype.streamSimple, original, "a refused install leaves no wrapper behind");

	const again = installArgs({ copy: fakeCopy([]) });
	const accepted = await installProcessUsageMeter({ ...again, runtime: new again.ModelRuntime() });
	assert.equal(accepted.ok, true, "the instance the session will use, of the class that was wrapped, is accepted");
	accepted.uninstall();
});

test("uninstall() restores the prototype and reports the compat half's re-arm count", async () => {
	// The gap: resetApiProviders() wipes the compat wrappers and replays nothing, so a legacy registry call
	// landing before the next poll is metered NOWHERE. rearms > 0 is the only evidence such a window existed.
	const copy = fakeCopy(["anthropic-messages", "openai-completions"]);
	const args = installArgs({ copy });
	const original = args.ModelRuntime.prototype.stream;
	const logged = [];
	const handle = await installProcessUsageMeter({ ...args, log: (event, fields) => logged.push({ event, fields }) });
	assert.notEqual(args.ModelRuntime.prototype.stream, original);

	copy.reset();
	handle.arm();
	handle.uninstall();
	handle.uninstall(); // idempotent: a second teardown must not double the record

	assert.equal(args.ModelRuntime.prototype.stream, original, "the runtime half is undone at teardown");
	const teardown = logged.filter((entry) => entry.event === "usage_meter_teardown");
	assert.equal(teardown.length, 1);
	assert.deepEqual(teardown[0].fields, { rearms: 2, apis: 2, rearmMs: 60_000 });
});

test("arm() re-wraps the compat half after a simulated resetApiProviders() and counts the re-arm", async () => {
	const copy = fakeCopy(["anthropic-messages", "openai-completions"]);
	const handle = await installProcessUsageMeter(installArgs({ copy }));
	handle.uninstall();

	const beforeReset = copy.registry.get("anthropic-messages");
	handle.arm();
	assert.equal(handle.rearms, 0, "an already-wrapped entry must not be wrapped again");
	assert.equal(copy.registry.get("anthropic-messages"), beforeReset, "arm() is idempotent while armed");

	copy.reset();
	handle.arm();

	assert.equal(handle.rearms, 2, "one per api id re-wrapped after the wipe");
	assert.deepEqual(handle.apis, ["anthropic-messages", "openai-completions"]);
	assert.notEqual(copy.registry.get("anthropic-messages"), beforeReset);
});

test("a wrapped compat api routes real calls through the meter", async () => {
	const copy = fakeCopy(["anthropic-messages"]);
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root-1" });
	const handle = await installProcessUsageMeter(installArgs({ copy, meter }));
	handle.uninstall();

	// Exactly what compat does once the api id is overridden: resolve the entry, call streamSimple.
	const entry = copy.registry.get("anthropic-messages");
	entry.streamSimple(MODEL, [], { sessionId: "child-3" });
	entry.stream(MODEL, [], { sessionId: "root-1" });
	await flush();

	assert.equal(meter.state.calls, 2);
	assert.equal(meter.state.total, 2);
	assert.equal(meter.state.otherTotal, 1, "a subagent call the session bus would have missed entirely");
	assert.equal(meter.state.rootTotal, 1);
});

test("the installer stamps the meter with the accepted copy's package version, via the injected reader", async () => {
	const copy = fakeCopy(["anthropic-messages"]);
	const meter = createUsageMeter({ maxTokens: null });
	const reads = [];
	const args = installArgs({ copy, meter });
	const handle = await installProcessUsageMeter({
		...args,
		readText: (path) => {
			reads.push(path);
			return JSON.stringify({ name: "a-package", version: "0.99.1" });
		},
	});
	try {
		// ../package.json RELATIVE TO the accepted compat url: the copy the identity check proved, never
		// whichever copy a bare specifier would have resolved -- the same discipline as the providers/all.js sibling.
		assert.deepEqual(reads, [
			"/app/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/package.json",
		]);
		new args.ModelRuntime().streamSimple(MODEL, [], {});
		await flush();
		assert.equal(meter.usageSnapshot().piAi, "0.99.1", "the version priced with, stamped before the first call");
	} finally {
		handle.uninstall();
	}
});

test("a failed version probe is silent -- no extra log line, no path, and the meter still installs", async () => {
	// The failure path may not log AT ALL: an error message here would carry the resolved package.json
	// path, and the no-path rule for shipped run logs has no exception for optional extras.
	const copy = fakeCopy(["anthropic-messages"]);
	const meter = createUsageMeter({ maxTokens: null });
	const logged = [];
	const args = installArgs({ copy, meter });
	const handle = await installProcessUsageMeter({
		...args,
		readText: () => {
			throw new Error("ENOENT: /some/resolved/path/package.json");
		},
		log: (event, fields) => logged.push({ event, fields }),
	});
	try {
		assert.equal(handle.ok, true, "a version is optional; failing to read one must not degrade the meter");
		new args.ModelRuntime().streamSimple(MODEL, [], {});
		await flush();
		assert.equal(meter.usageSnapshot().piAi, null, "unknown stays null -- never guessed, never defaulted");
	} finally {
		handle.uninstall();
	}
	assert.deepEqual(logged.map((entry) => entry.event), ["usage_meter", "usage_meter_teardown"]);
});

// ── Issues #501/#502, PR 1: one stop for every policy ─────────────────────────────────────────────────
//
// The seams the cost cap and the model list sit on. No guard ships yet, so these hold the shape: one stop
// reason, first wins; a brake armed by any of the three policies; a guard hook offered every physical call;
// and a runner that refuses a policy it cannot enforce before a call.

test("the meter's stop is first-wins: a later stop never overwrites the reason, and onStop fires once", () => {
	const fired = [];
	const meter = createUsageMeter({ maxTokens: 10, maxCostMicros: 0, onStop: (reason) => fired.push(reason) });
	assert.equal(meter.stop(COST_CAP), true, "the first stop wins");
	assert.equal(meter.state.stopReason, COST_CAP);
	assert.equal(meter.stop(MODEL_NOT_ALLOWED), false, "a second stop is refused");
	meter.record(usage({ total: 99 })); // crosses the token cap AFTER the cost stop
	assert.equal(meter.state.stopReason, COST_CAP, "the cause stays the first stop, not the last thing to notice");
	assert.equal(meter.state.breached, false, "breached means the token cap was the stop, and it was not");
	assert.deepEqual(fired, [COST_CAP]);
	assert.throws(() => meter.stop("made-up"), /unknown meter stop/, "a reason with no message is a bug, never a silent stop");
});

test("STOP_MESSAGES names every meter stop, and breached is a read-only view of the token stop", () => {
	assert.deepEqual(Object.keys(STOP_MESSAGES).sort(), [COST_CAP, MODEL_NOT_ALLOWED, TOKEN_BUDGET].sort());
	assert.equal(STOP_MESSAGES[TOKEN_BUDGET], "pi-dispatch: token cap exceeded", "the token stop's message is unchanged");
	assert.ok(Object.isFrozen(STOP_MESSAGES));
	const meter = createUsageMeter({ maxTokens: null });
	meter.stop(TOKEN_BUDGET);
	assert.equal(meter.state.breached, true);
	assert.equal(defaultHardStopResult("classify", MODEL).errorMessage, STOP_MESSAGES[TOKEN_BUDGET]);
});

test("the meter carries the cost cap and the list, 0 included, and refuses nonsense", () => {
	assert.equal(createUsageMeter({}).costCap, null);
	assert.equal(createUsageMeter({}).allowed, null);
	assert.equal(createUsageMeter({ maxCostMicros: 0 }).costCap, 0, "0 is the strictest cap, never 'off'");
	const list = [{ provider: "anthropic", model: "claude-x" }];
	assert.deepEqual(createUsageMeter({ allowedModels: list }).allowed, list);
	for (const bad of [-1, 1.5, Number.NaN, "5"]) assert.throws(() => createUsageMeter({ maxCostMicros: bad }), /invalid PI_MAX_COST_MICROS/);
	for (const bad of [[], "a/b"]) assert.throws(() => createUsageMeter({ allowedModels: bad }), /invalid PI_ALLOWED_MODELS/);
});

test("the brake answers each stop with that stop's own message, on both halves", async () => {
	const { FakeRuntime, calls } = fakeRuntimeClass();
	const meter = createUsageMeter({ maxCostMicros: 0 });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop });
	try {
		meter.stop(COST_CAP);
		const runtime = new FakeRuntime();
		for (const method of RUNTIME_STREAM_METHODS) {
			assert.equal((await runtime[method](MODEL, [], {}).result()).errorMessage, "pi-dispatch: cost cap reached", method);
		}
		for (const method of RUNTIME_RESULT_METHODS) {
			assert.equal((await runtime[method](MODEL, {}, {})).errorMessage, "pi-dispatch: cost cap reached", method);
		}
		const inner = fakeInner();
		const compat = wrapProviderStreams({ inner, fallbackModels: null, meter, hardStop });
		assert.equal((await compat.streamSimple(MODEL, [], {}).result()).errorMessage, "pi-dispatch: cost cap reached");
		assert.equal(calls.length + inner.calls.length, 0, "a stopped job reaches no provider, whichever policy stopped it");
	} finally {
		layer.restore();
	}
});

test("the guard seam: a physical call is offered to the guard before dispatch, and a refusal stops the job", async () => {
	const { FakeRuntime, calls } = fakeRuntimeClass();
	const fired = [];
	const meter = createUsageMeter({ allowedModels: [{ provider: "anthropic", model: "claude-physical" }], onStop: (reason) => fired.push(reason) });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const offered = [];
	const guard = {
		enforces: [MODEL_NOT_ALLOWED],
		admit: ({ method, model }) => {
			offered.push(`${method}:${model.id}`);
			return model.id === "claude-physical" ? null : MODEL_NOT_ALLOWED;
		},
	};
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop, guard });
	try {
		const runtime = new FakeRuntime();
		// A virtual model is NOT offered: its physical re-entry is, so one request is judged once.
		await runtime.streamSimple(VIRTUAL, [], {}).result();
		assert.deepEqual(offered, ["streamSimple:claude-physical"]);
		assert.equal(meter.state.stopReason, null);
		// The refused call is the FIRST one braked: it never reaches the provider.
		const refused = await runtime.classify(MODEL, {}, {});
		assert.equal(refused.errorMessage, "pi-dispatch: model not allowed");
		assert.equal(meter.state.stopReason, MODEL_NOT_ALLOWED);
		assert.deepEqual(fired, [MODEL_NOT_ALLOWED]);
		assert.deepEqual(calls.map((c) => c.model), ["auto", "claude-physical"], "the refused classify was never dispatched");
		// And once stopped, the guard is not asked again: the stop answers first.
		await runtime.streamSimple(PHYSICAL, [], {}).result();
		assert.equal(offered.length, 2);
	} finally {
		layer.restore();
	}
});

test("the guard is never consulted without a brake, nor by the compat half inside a runtime dispatch", async () => {
	const { FakeRuntime, calls } = fakeRuntimeClass();
	const meter = createUsageMeter({ maxCostMicros: 0 });
	const guard = { admit: () => assert.fail("no brake, so no refusal could be answered: the guard must not be asked") };
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop: null, guard });
	try {
		new FakeRuntime().streamSimple(MODEL, [], {});
		assert.equal(calls.length, 1);
	} finally {
		layer.restore();
	}
	// The compat half: a call from inside the runtime half's dispatch was judged there already.
	const dispatch = new AsyncLocalStorage();
	const inner = fakeInner();
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const asked = [];
	const compat = wrapProviderStreams({ inner, fallbackModels: null, meter, hardStop, dispatch, guard: { admit: ({ model }) => (asked.push(model.id), COST_CAP) } });
	const token = dispatchToken(MODEL);
	dispatch.run(token, () => compat.streamSimple(MODEL, [], { [DISPATCH_MARK]: token }));
	assert.deepEqual([asked.length, inner.calls.length], [0, 1], "inside the runtime dispatch: routed, never judged twice");
	const refused = await compat.streamSimple(MODEL, [], {}).result();
	assert.deepEqual([asked.length, inner.calls.length, refused.errorMessage], [1, 1, "pi-dispatch: cost cap reached"], "a legacy call is judged and refused here");
	assert.equal(meter.state.stopReason, COST_CAP);
});

test("the brake is armed by ANY policy: a cost cap alone, or a list alone, arms it like a token cap", async () => {
	for (const [label, meterArgs, costCapped, listed] of [
		["cost cap", { maxCostMicros: 0 }, true, false],
		["model list", { allowedModels: [{ provider: "anthropic", model: "claude-x" }] }, false, true],
	]) {
		const copy = fakeCopy(["anthropic-messages"]);
		const logged = [];
		const handle = await installProcessUsageMeter({
			...installArgs({ copy }),
			meter: createUsageMeter(meterArgs),
			log: (event, fields) => logged.push({ event, fields }),
		});
		handle.uninstall();
		assert.equal(handle.brake, true, `${label}: armed`);
		assert.deepEqual(handle.enforces, [], `${label}: no guard handed to this install`);
		assert.deepEqual([logged[0].fields.capped, logged[0].fields.costCapped, logged[0].fields.listed, logged[0].fields.brake], [false, costCapped, listed, true], label);
	}
	// And none of the three: no brake, which is today's line for an uncapped job.
	const handle = await installProcessUsageMeter({ ...installArgs({ copy: fakeCopy(["anthropic-messages"]) }) });
	handle.uninstall();
	assert.equal(handle.brake, false);
});

test("assertPoliciesEnforceable: a cap or a list the runner cannot enforce before a call is refused, the list first", () => {
	const healthy = { meterOk: true, brake: true, enforces: [COST_CAP, MODEL_NOT_ALLOWED] };
	const list = [{ provider: "anthropic", model: "claude-x" }];
	assert.doesNotThrow(() => assertPoliciesEnforceable({ ...healthy, maxCostMicros: 5, allowedModels: list }));
	// Neither policy set: nothing to enforce, whatever the meter's state. This is every job today.
	assert.doesNotThrow(() => assertPoliciesEnforceable({ meterOk: false, brake: false }));
	// Per policy: a guard for one does not pass for the other.
	assert.doesNotThrow(() => assertPoliciesEnforceable({ ...healthy, enforces: [COST_CAP], maxCostMicros: 5 }));
	assert.throws(() => assertPoliciesEnforceable({ ...healthy, enforces: [COST_CAP], maxCostMicros: 5, allowedModels: list }), (error) => error.piDispatchReason === MODEL_POLICY_UNENFORCEABLE);
	assert.throws(() => assertPoliciesEnforceable({ ...healthy, enforces: [MODEL_NOT_ALLOWED], maxCostMicros: 5, allowedModels: list }), (error) => error.piDispatchReason === COST_CAP_UNENFORCEABLE);
	for (const [label, broken] of [
		["meter not installed (the fallback bus meter)", { meterOk: false }],
		["no hard-stop stream", { brake: false }],
		["no guard", { enforces: [] }],
	]) {
		const state = { ...healthy, ...broken };
		for (const [policy, args, reason] of [
			["cost cap", { maxCostMicros: 0 }, COST_CAP_UNENFORCEABLE],
			["list", { allowedModels: list }, MODEL_POLICY_UNENFORCEABLE],
			["both, the list named first", { maxCostMicros: 1, allowedModels: list }, MODEL_POLICY_UNENFORCEABLE],
		]) {
			assert.throws(
				() => assertPoliciesEnforceable({ ...state, ...args }),
				(error) => error.piDispatchExit === EXIT_POLICY && error.piDispatchReason === reason && !error.message.includes("claude-x"),
				`${label}, ${policy}`,
			);
		}
	}
});

// ---------------------------------------------------------------------------------------------
// Issue #500: the seams a child meter and the parent's fold use (not wired into run-job.mjs yet)
// ---------------------------------------------------------------------------------------------

/** A fold as foldChildLedgers returns it, with only what setChildren reads. */
function childFold({ totals = {}, rows = [], processes = 1, unmetered = 0 } = {}) {
	return {
		processes,
		unmetered,
		totals: { input: 0, output: 0, total: 0, cost: 0, calls: 0, unresolved: 0, unpriced: 0, sessions: 0, ...totals },
		rows,
	};
}
/** A ledger row with the ten numerics, zero unless given. */
const ledgerRow = (provider, model, fields = {}) => ({ provider, model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 0, cost: 0, unpriced: 0, ...fields });

test("onChange fires when a call is observed and again when it settles, for streams and for promises", async () => {
	const seen = [];
	const meter = createUsageMeter({ maxTokens: null, onChange: () => seen.push([meter.state.calls, meter.state.unresolved, meter.state.total]) });
	const stream = new FakeStream();
	meter.observe(stream, { sessionId: "s", provider: "p", modelId: "m" });
	assert.deepEqual(seen, [[1, 1, 0]], "on observe: the call is counted, and unresolved, before any answer");
	stream.end(settledWith(usage({ input: 3, output: 2 })));
	await flush();
	assert.deepEqual(seen.at(-1), [1, 0, 5], "on settle: the usage is in");
	let resolve;
	meter.observeResult(new Promise((done) => (resolve = done)), {});
	assert.deepEqual(seen.at(-1), [2, 1, 5]);
	resolve({ usage: usage({ input: 1 }) });
	await flush();
	assert.deepEqual(seen.at(-1), [2, 0, 6]);
	assert.equal(seen.length, 4, "exactly once per observe and once per settle");
	meter.setChildren(childFold({ totals: { total: 9, calls: 1 }, rows: [ledgerRow(null, null, { calls: 1, total: 9 })] }));
	assert.equal(seen.length, 4, "a fold is the parent's own tick, not a change to report");
});

test("a throwing onChange never reaches the provider call or the settle", async () => {
	const meter = createUsageMeter({ maxTokens: null, onChange: () => {
		throw new Error("disk full");
	} });
	const stream = streamOf(usage({ input: 4 }));
	assert.equal(meter.observe(stream, {}), stream);
	await flush();
	assert.deepEqual([meter.state.calls, meter.state.unresolved, meter.state.total], [1, 0, 4]);
});

test("rows(): first-seen order, a model-less row with null ids, copies, and a partition of the settled totals", () => {
	const meter = createUsageMeter({ maxTokens: null });
	meter.record(usage({ input: 1, total: 1, cost: 0.1 }), { provider: "p", modelId: "small" });
	meter.record(usage({ input: 100, total: 100, cost: 2 }), { provider: "p", modelId: "big" });
	meter.record({ input: 7, totalTokens: 7 }, {}); // no cost at all: unpriced
	// An id the worker's rule refuses (a space, and an uppercase-only spelling is fine) folds into the model-less row.
	meter.record(usage({ input: 5, total: 5, cost: 0.5 }), { provider: "p", modelId: "has space" });
	meter.record(usage({ input: 2, total: 2, cost: 0.2 }), { provider: "OpenAI", modelId: "GPT-X" });
	const rows = meter.rows();
	assert.deepEqual(rows.map((row) => [row.provider, row.model]), [["p", "small"], ["p", "big"], ["OpenAI", "GPT-X"], [null, null]], "first seen, not top by total: a written row never moves into the bucket");
	assert.deepEqual([rows[3].calls, rows[3].total, rows[3].unpriced], [2, 12, 1]);
	for (const key of ["input", "total", "unpriced"]) assert.equal(rows.reduce((sum, row) => sum + row[key], 0), meter.state[key], key);
	assert.equal(rows.reduce((sum, row) => sum + row.calls, 0), 5, "one per settled call");
	rows[0].total = 999;
	assert.equal(meter.rows()[0].total, 1, "copies: the caller cannot reach live state");
});

test("rows() keeps at most CHILD_LEDGER_ROWS rows, the overflow folded into the model-less row", () => {
	const meter = createUsageMeter({ maxTokens: null });
	for (let i = 0; i < CHILD_LEDGER_ROWS + 10; i += 1) meter.record(usage({ input: 1, total: 1 }), { provider: "p", modelId: `m${i}` });
	const rows = meter.rows();
	assert.equal(rows.length, CHILD_LEDGER_ROWS);
	assert.equal(rows.at(-2).model, `m${CHILD_LEDGER_ROWS - 2}`, "the first CHILD_LEDGER_ROWS - 1 seen stay named");
	assert.deepEqual([rows.at(-1).provider, rows.at(-1).calls], [null, 11]);
	assert.equal(rows.reduce((sum, row) => sum + row.total, 0), CHILD_LEDGER_ROWS + 10);
});

test("with no children the snapshot is the pre-#500 line plus costUnreported (issue #571): the three child keys appear only after setChildren, before it", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	meter.record(usage({ input: 10, output: 5, cost: 0.25 }), { sessionId: "root", provider: "p", modelId: "m" });
	assert.equal(
		JSON.stringify(meter.snapshot()),
		'{"input":10,"output":5,"total":15,"cost":0.25,"metered":true,"rootTotal":15,"otherTotal":0,"looseTotal":0,"sessions":1,"calls":0,"unresolved":0,"unpriced":0,"costUnreported":0}',
	);
	meter.setChildren(childFold({ processes: 0 }));
	assert.deepEqual(Object.keys(meter.snapshot()).slice(-4), ["childTotal", "childProcesses", "unmeteredChildren", "costUnreported"], "appended after unpriced, in this order");
	assert.deepEqual(meter.snapshot().childTotal, 0);
});

test("setChildren: the totals include the children, root/other/loose stay the parent's, and the four parts sum to total", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	meter.record(usage({ input: 10, output: 5, cost: 1 }), { sessionId: "root" });
	meter.record(usage({ input: 4, output: 0, cost: 0.5 }), { sessionId: "sub" });
	meter.record(usage({ input: 1, output: 0 }));
	const before = meter.snapshot();
	meter.setChildren(childFold({
		processes: 3,
		unmetered: 1,
		totals: { input: 100, output: 20, total: 150, cost: 2.5, calls: 4, unresolved: 1, unpriced: 1, sessions: 2 },
	}));
	const after = meter.snapshot();
	assert.deepEqual([after.rootTotal, after.otherTotal, after.looseTotal], [before.rootTotal, before.otherTotal, before.looseTotal], "parent-only");
	assert.deepEqual(
		[after.input, after.output, after.total, after.cost, after.calls, after.unresolved, after.unpriced, after.sessions],
		[before.input + 100, before.output + 20, before.total + 150, before.cost + 2.5, before.calls + 4, before.unresolved + 1, before.unpriced + 1, before.sessions + 2],
	);
	assert.deepEqual([after.childTotal, after.childProcesses, after.unmeteredChildren], [150, 3, 1]);
	assert.equal(after.rootTotal + after.otherTotal + after.looseTotal + after.childTotal, after.total, "root + other + loose + child == total");
	// Cumulative: a later fold REPLACES the last one, it is never added to it.
	meter.setChildren(childFold({ processes: 3, unmetered: 1, totals: { total: 160 } }));
	assert.equal(meter.snapshot().total, before.total + 160);
});

test("the token cap is judged on parent plus children, on a fold and on a parent record", () => {
	const stops = [];
	const meter = createUsageMeter({ maxTokens: 100, onStop: (reason, detail) => stops.push([reason, detail]) });
	meter.record(usage({ input: 60 }));
	meter.setChildren(childFold({ totals: { total: 30 } }));
	assert.equal(meter.state.stopReason, null, "60 + 30 is under 100");
	meter.record(usage({ input: 20 }));
	assert.deepEqual(stops, [[TOKEN_BUDGET, 110]], "the parent's record crosses with the children counted");

	const byFold = createUsageMeter({ maxTokens: 100 });
	byFold.record(usage({ input: 60 }));
	byFold.setChildren(childFold({ totals: { total: 41 } }));
	assert.equal(byFold.state.stopReason, TOKEN_BUDGET, "the fold itself crosses");
});

test("usageSnapshot merges the children's rows before the 8-row cut, and the rows still sum to the total", () => {
	const meter = createUsageMeter({ maxTokens: null });
	for (let i = 0; i < 8; i += 1) meter.record(usage({ input: 10 + i, cost: 0.01 }), { provider: "p", modelId: `m${i}` });
	meter.record(usage({ input: 3 }), {});
	meter.setChildren(childFold({
		totals: { total: 1000 + 50 + 5, calls: 3 },
		rows: [ledgerRow("p", "m0", { calls: 1, total: 1000, input: 1000, cost: 1 }), ledgerRow("c", "child-only", { calls: 1, total: 50, input: 50 }), ledgerRow(null, null, { calls: 1, total: 5, input: 5 })],
	}));
	const { models, truncated } = meter.usageSnapshot();
	assert.deepEqual([models[0].provider, models[0].model, models[0].total, models[0].calls], ["p", "m0", 1010, 2], "a child row lands on the parent's row for its pair, which then ranks first");
	assert.equal(models[1].model, "child-only", "a child-only pair ranks on its merged total");
	assert.equal(truncated, 1, "nine named rows: the smallest parent row is cut");
	const other = models.at(-1);
	assert.deepEqual([other.provider, other.calls], ["other", 3], "the cut row, the parent's model-less call and the child's model-less row");
	assert.equal(models.reduce((sum, row) => sum + row.total, 0), meter.snapshot().total);
	assert.equal(meter.rows()[0].total, 10, "the merge never touches the parent's live row");
	assert.equal(meter.usageSnapshot().models[0].total, 1010, "a second snapshot does not compound the merge");
});

test("usageSnapshot is emitted when only the children made calls", () => {
	const meter = createUsageMeter({ maxTokens: null });
	assert.equal(meter.usageSnapshot(), null);
	meter.setChildren(childFold({ totals: { total: 7, calls: 1 }, rows: [ledgerRow("p", "m", { calls: 1, total: 7 })] }));
	assert.deepEqual(meter.usageSnapshot().models.map((row) => [row.model, row.total]), [["m", 7]]);
});

test("isStopped is asked before dispatch on every runtime method, and its reason becomes the meter's stop", async () => {
	const { FakeRuntime, calls } = fakeRuntimeClass();
	const order = [];
	let answer = null;
	const meter = createUsageMeter({ maxTokens: null });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const layer = wrapModelRuntime({
		ModelRuntime: FakeRuntime,
		meter,
		hardStop,
		isStopped: () => {
			order.push(`asked:${calls.length}`);
			return answer;
		},
	});
	try {
		const runtime = new FakeRuntime();
		runtime.streamSimple(MODEL, [], {});
		assert.deepEqual(order, ["asked:0"], "asked before the provider was reached");
		assert.equal(calls.length, 1, "null is go");
		answer = COST_CAP;
		for (const method of RUNTIME_STREAM_METHODS) {
			assert.equal((await runtime[method](MODEL, [], {}).result()).errorMessage, STOP_MESSAGES[COST_CAP], method);
		}
		for (const method of RUNTIME_RESULT_METHODS) assert.equal((await runtime[method](MODEL, {}, {})).stopReason, "aborted", method);
		assert.equal(calls.length, 1, "a stopped call reaches no provider");
		assert.equal(meter.state.stopReason, COST_CAP);
	} finally {
		layer.restore();
	}
});

test("isStopped fails closed: a garbled answer or a throw is a token-cap stop; with no brake it is never asked", async () => {
	for (const answer of [true, "STOP", 1, () => {
		throw new Error("EIO");
	}]) {
		const { FakeRuntime, calls } = fakeRuntimeClass();
		const meter = createUsageMeter({ maxTokens: null });
		const layer = wrapModelRuntime({
			ModelRuntime: FakeRuntime,
			meter,
			hardStop: makeHardStopStream({ createStream: () => new FakeStream() }),
			isStopped: typeof answer === "function" ? answer : () => answer,
		});
		try {
			await new FakeRuntime().streamSimple(MODEL, [], {}).result();
			assert.equal(calls.length, 0, String(answer));
			assert.equal(meter.state.stopReason, TOKEN_BUDGET, String(answer));
		} finally {
			layer.restore();
		}
	}
	const { FakeRuntime, calls } = fakeRuntimeClass();
	let asked = 0;
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter: createUsageMeter({}), isStopped: () => (asked += 1, COST_CAP) });
	try {
		new FakeRuntime().streamSimple(MODEL, [], {});
		assert.deepEqual([asked, calls.length], [0, 1], "no hard stop to answer with, so no stop to ask about");
	} finally {
		layer.restore();
	}
});

test("isStopped on the compat half: asked before dispatch, and a stop answers with the hard stop", async () => {
	const inner = fakeInner();
	const meter = createUsageMeter({ maxTokens: null });
	let answer = null;
	const asked = [];
	const compat = wrapProviderStreams({
		inner,
		fallbackModels: null,
		meter,
		hardStop: makeHardStopStream({ createStream: () => new FakeStream() }),
		isStopped: () => {
			asked.push(inner.calls.length);
			return answer;
		},
	});
	compat.streamSimple(MODEL, [], {});
	assert.deepEqual([asked, inner.calls.length], [[0], 1]);
	answer = MODEL_NOT_ALLOWED;
	assert.equal((await compat.stream(MODEL, [], {}).result()).errorMessage, STOP_MESSAGES[MODEL_NOT_ALLOWED]);
	assert.equal(inner.calls.length, 1);
	assert.equal(meter.state.stopReason, MODEL_NOT_ALLOWED);
});

test("install: an injected compat copy skips resolution, and its catalog and version come with it", async () => {
	const copy = fakeCopy(["anthropic-messages"]);
	const meter = createUsageMeter({ maxTokens: null });
	const logged = [];
	const handle = await installProcessUsageMeter({
		...installArgs({ copy }),
		meter,
		resolve: () => assert.fail("an injected copy is never resolved"),
		exists: () => assert.fail("nor looked for"),
		load: async () => assert.fail("nor loaded"),
		loadExtensionModules: async () => assert.fail("nor checked against the extension modules"),
		readText: () => assert.fail("nor stamped from disk"),
		compat: { module: copy.module, fallbackModels: fakeCatalog([]), version: "9.9.9" },
		log: (event, fields) => logged.push({ event, fields }),
	});
	handle.uninstall();
	assert.equal(handle.tag, "injected");
	assert.equal(handle.module, copy.module);
	assert.deepEqual(handle.apis, ["anthropic-messages"]);
	assert.equal(copy.registry.get("anthropic-messages").sourceId, `${METER_PROVIDER_PREFIX}:anthropic-messages`);
	assert.deepEqual([logged[0].fields.compat, logged[0].fields.fallback, "fallbackError" in logged[0].fields], ["injected", true, false]);
	meter.observe(streamOf(usage({ input: 1 })), { provider: "p", modelId: "m" });
	assert.equal(meter.usageSnapshot().piAi, "9.9.9");

	const bare = await installProcessUsageMeter({ ...installArgs({ copy: fakeCopy(["anthropic-messages"]) }), compat: { module: fakeCopy([]).module }, log: (event, fields) => logged.push({ event, fields }) });
	bare.uninstall();
	assert.equal(logged.at(-2).fields.fallbackError, "no-builtin-models", "no catalog handed over is named, as for a copy on disk");
	const wrong = await installProcessUsageMeter({ ...installArgs({ copy: fakeCopy([]) }), compat: { module: {} }, log: (event, fields) => logged.push({ event, fields }) });
	wrong.uninstall();
	assert.deepEqual([wrong.ok, wrong.tag, logged.at(-2).fields.compat, logged.at(-2).fields.compatError], [true, null, false, "injected-not-compat"]);
});

test("install: brake:true arms the hard stop with no policy, and isStopped then brakes both halves", async () => {
	const copy = fakeCopy(["anthropic-messages"]);
	const args = installArgs({ copy });
	const meter = createUsageMeter({ maxTokens: null });
	let stop = null;
	const logged = [];
	const handle = await installProcessUsageMeter({ ...args, meter, brake: true, isStopped: () => stop, log: (event, fields) => logged.push({ event, fields }) });
	try {
		assert.equal(handle.brake, true);
		assert.deepEqual([logged[0].fields.capped, logged[0].fields.costCapped, logged[0].fields.listed, logged[0].fields.brake], [false, false, false, true]);
		const runtime = new args.ModelRuntime();
		stop = TOKEN_BUDGET;
		assert.equal((await runtime.streamSimple(MODEL, [], {}).result()).stopReason, "aborted");
		const legacy = copy.registry.get("anthropic-messages");
		assert.equal((await legacy.streamSimple(MODEL, [], {}).result()).errorMessage, STOP_MESSAGES[TOKEN_BUDGET]);
		assert.equal(meter.state.calls, 0);
	} finally {
		handle.uninstall();
	}
	const plain = await installProcessUsageMeter({ ...installArgs({ copy: fakeCopy(["anthropic-messages"]) }) });
	plain.uninstall();
	assert.equal(plain.brake, false, "without brake:true or a policy there is still no brake");
});

test("install: the children hook replaces the sampler, runs on the tick, and adds its teardown fields; with no policy a throw is logged once", async () => {
	const copy = fakeCopy([]);
	const logged = [];
	let samples = 0;
	const hook = {
		sample: () => {
			samples += 1;
			throw Object.assign(new Error("/proc/secret/path"), { code: "EACCES" });
		},
		teardown: () => ({ distinct: 2, peak: 1, unmetered: 0 }),
	};
	const handle = await installProcessUsageMeter({ ...installArgs({ copy }), rearmMs: 5, platform: "linux", children: hook, log: (event, fields) => logged.push({ event, fields }) });
	assert.equal(handle.children, hook, "the hook, not the Linux sampler");
	await new Promise((resolve) => setTimeout(resolve, 40));
	handle.uninstall();
	assert.ok(samples >= 2, "sample() runs on every tick, and a throw does not stop the timer");
	assert.deepEqual(logged.filter((line) => line.event === "usage_meter_children_failed"), [{ event: "usage_meter_children_failed", fields: { reason: "EACCES" } }], "once, by code, never the message");
	assert.deepEqual(logged.at(-1).event, "usage_meter_teardown");
	const { childrenFailed, ...rest } = logged.at(-1).fields;
	assert.ok(childrenFailed >= 2, "every failed tick is counted on the teardown line");
	assert.deepEqual(rest, { rearms: 0, apis: 0, rearmMs: 5, distinct: 2, peak: 1, unmetered: 0 });
});

// ---------------------------------------------------------------------------------------------
// Issue #500, review fixes: saturation, high-water, fail-closed hook and brake, onChange on a stop
// ---------------------------------------------------------------------------------------------

test("setChildren saturates a number it cannot carry at MAX_SAFE_INTEGER, never at 0", () => {
	const meter = createUsageMeter({ maxTokens: 500 });
	const M = Number.MAX_SAFE_INTEGER;
	meter.setChildren(childFold({
		totals: { input: Infinity, output: Number.NaN, total: 1e308, cost: -1, calls: M * 2, unresolved: M + 2, unpriced: "3", sessions: undefined },
		rows: [ledgerRow("p", "m", { calls: 1, total: Infinity, cost: 1e308 })],
	}));
	const snap = meter.snapshot();
	for (const key of ["input", "output", "total", "cost", "calls", "unresolved", "unpriced", "sessions"]) assert.equal(snap[key], M, key);
	assert.equal(meter.state.stopReason, TOKEN_BUDGET, "too much to count is over any cap");
	const [row] = meter.usageSnapshot().models;
	assert.deepEqual([row.total, row.cost], [M, M]);
	for (const r of meter.usageSnapshot().models) for (const [key, value] of Object.entries(r)) if (typeof value === "number") assert.ok(Number.isFinite(value), `${key}: no Infinity reaches the exit line as null`);
});

test("setChildren keeps a high-water mark: a fold with less never lowers the totals or a row, but unresolved and unmetered follow the fold", () => {
	const meter = createUsageMeter({ maxTokens: 1000 });
	meter.setChildren(childFold({ processes: 2, unmetered: 1, totals: { input: 900, total: 900, cost: 5, calls: 3, unresolved: 1, sessions: 1 }, rows: [ledgerRow("p", "m", { calls: 2, input: 900, total: 900, cost: 5 })] }));
	meter.setChildren(childFold({ processes: 0, unmetered: 0 }));
	const snap = meter.snapshot();
	// unmetered follows the fold (issue #500 part E's review): the children hook keeps that count itself, and may
	// un-count a child that was slow to start.
	assert.deepEqual([snap.total, snap.cost, snap.calls, snap.unresolved, snap.childProcesses, snap.unmeteredChildren], [900, 5, 3, 0, 2, 0]);
	assert.deepEqual(meter.usageSnapshot().models.map((row) => [row.model, row.total, row.cost]), [["m", 900, 5]]);
});

test("record clamps a negative usage field or price at 0, still priced", () => {
	const meter = createUsageMeter({ maxTokens: null });
	meter.record({ input: -5, output: 3, totalTokens: -2, cacheRead: -1, cost: { total: -0.5 } }, { provider: "p", modelId: "m" });
	assert.deepEqual([meter.state.input, meter.state.output, meter.state.total, meter.state.cost, meter.state.unpriced], [0, 3, 0, 0, 0]);
	const [row] = meter.rows();
	assert.deepEqual([row.input, row.cacheRead, row.cost, row.unpriced], [0, 0, 0, 0]);
});

test("rows() folds an id that is not printable ASCII (U+212A KELVIN SIGN lowercases to k) into the model-less row", () => {
	const meter = createUsageMeter({ maxTokens: null });
	meter.record(usage({ input: 4 }), { provider: "p", modelId: "\u212Aimi" });
	meter.record(usage({ input: 1 }), { provider: "p", modelId: "kimi" });
	assert.deepEqual(meter.rows().map((row) => [row.model, row.total]), [["kimi", 1], [null, 4]]);
});

test("a stop fires onChange, so a guard refusal reaches the child ledger with its counter already raised", () => {
	const { FakeRuntime, calls } = fakeRuntimeClass();
	const seen = [];
	const meter = createUsageMeter({ allowedModels: [{ provider: "anthropic", model: "ok" }], onChange: () => seen.push(guard.snapshot().modelRefused) });
	const guard = createPolicyGuard({ allowedModels: [{ provider: "anthropic", model: "ok" }] });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop: makeHardStopStream({ createStream: () => new FakeStream() }), guard });
	try {
		new FakeRuntime().streamSimple(MODEL, [], {});
		assert.equal(calls.length, 0);
		assert.deepEqual(seen, [1], "one change, fired after modelRefused rose");
	} finally {
		layer.restore();
	}
	const stops = [];
	const plain = createUsageMeter({ maxTokens: null, onChange: () => stops.push(plain.state.stopReason) });
	plain.stop(COST_CAP);
	plain.stop(TOKEN_BUDGET);
	assert.deepEqual(stops, [COST_CAP], "only the stop that wins");
});

test("install: brake:true or isStopped with no hard stop to build is a failed install, not a silent one", async () => {
	for (const extra of [{ brake: true }, { isStopped: () => null }]) {
		const copy = fakeCopy(["anthropic-messages"]);
		delete copy.module.createAssistantMessageEventStream;
		const logged = [];
		const args = installArgs({ copy });
		const before = args.ModelRuntime.prototype.streamSimple;
		const handle = await installProcessUsageMeter({ ...args, ...extra, log: (event, fields) => logged.push({ event, fields }) });
		assert.equal(handle.ok, false, Object.keys(extra)[0]);
		assert.deepEqual(logged, [{ event: "usage_meter_unavailable", fields: { reason: "no-hard-stop" } }]);
		assert.equal(args.ModelRuntime.prototype.streamSimple, before, "nothing was wrapped");
	}
	const wrong = await installProcessUsageMeter({ ...installArgs({ copy: fakeCopy([]) }), compat: { module: {} }, brake: true });
	assert.equal(wrong.ok, false, "an injected copy that is not compat has no stream factory either");
});

test("install: a throwing children hook stops a meter with a policy, by the unmetered-child rule; teardown fields never overwrite the meter's", async () => {
	const cases = [
		[{ maxCostMicros: 100, maxTokens: 10 }, COST_CAP],
		[{ maxTokens: 10, allowedModels: [{ provider: "p", model: "m" }] }, TOKEN_BUDGET],
		[{ allowedModels: [{ provider: "p", model: "m" }] }, MODEL_NOT_ALLOWED],
	];
	for (const [policy, reason] of cases) {
		const meter = createUsageMeter({ maxTokens: null, ...policy });
		const logged = [];
		const handle = await installProcessUsageMeter({
			...installArgs({ copy: fakeCopy([]) }),
			meter,
			rearmMs: 5,
			children: { sample: () => {
				throw new Error("fold");
			}, teardown: () => ({ rearms: 99, apis: 99, rearmMs: 1, childrenFailed: 0, unmetered: 3 }) },
			log: (event, fields) => logged.push({ event, fields }),
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		handle.uninstall();
		assert.equal(meter.state.stopReason, reason, JSON.stringify(policy));
		const teardown = logged.at(-1).fields;
		assert.deepEqual([teardown.rearms, teardown.apis, teardown.rearmMs, teardown.unmetered], [0, 0, 5, 3], "the hook's colliding keys are dropped, its own kept");
		assert.ok(teardown.childrenFailed >= 1);
	}
	const throwingTeardown = createUsageMeter({ maxTokens: 10 });
	const handle = await installProcessUsageMeter({ ...installArgs({ copy: fakeCopy([]) }), meter: throwingTeardown, children: { sample: () => {}, teardown: () => {
		throw new Error("last fold");
	} } });
	handle.uninstall();
	assert.equal(throwingTeardown.state.stopReason, TOKEN_BUDGET, "the last fold failing at teardown fails closed too");
});

// ---------------------------------------------------------------------------------------------
// Issue #571: an answer whose usage is broken counts costUnreported, in the meter, capped or not
// ---------------------------------------------------------------------------------------------

const PRICED = { api: "openai-completions", provider: "lan", id: "priced", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, compat: { maxTokensField: "max_tokens" } };
const PRICED_ANTHROPIC = { ...PRICED, api: "anthropic-messages", provider: "anthropic", id: "claude-x" };
const FREE = { ...PRICED, id: "free", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const TEXT = [{ type: "text", text: "a long answer" }];
const answer = ({ stopReason = "stop", content = TEXT, input = 0, output = 0, cacheRead = 0, cost = 0 } = {}) => ({ role: "assistant", stopReason, content, usage: { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { total: cost } } });

test("pricedModel: any rate above 0 in the table, a tier or an allowed fallback; a missing table is priced", () => {
	assert.equal(pricedModel(PRICED), true);
	assert.equal(pricedModel(FREE), false);
	assert.equal(pricedModel({ ...FREE, cost: { ...FREE.cost, tiers: [{ inputTokensAbove: 10, input: 0, output: 3, cacheRead: 0, cacheWrite: 0 }] } }), true, "a priced tier");
	assert.equal(pricedModel({ ...FREE, compat: { allowedFallbackModels: [{ provider: "a", model: "b", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }] } }), true, "a priced fallback");
	assert.equal(pricedModel({ ...FREE, cost: undefined }), true, "no table: not proof of a free call");
	assert.equal(pricedModel({ ...FREE, cost: { input: "1", output: 0 } }), true, "a rate that is not a number");
	assert.equal(pricedModel({ ...FREE, cost: { input: 0, output: 0 } }), false, "absent rates are 0");
});

test("unreportedUsage: zero input, a started failure, and content with no output count are broken; an unanswered call is not", () => {
	assert.equal(unreportedUsage(answer(), "openai-completions"), true, "pi's zeros for a missing usage block");
	assert.equal(unreportedUsage(answer({ input: 0, output: 500, cost: 0.001 }), "openai-completions"), true, "no input side");
	assert.equal(unreportedUsage(answer({ cacheRead: 1000, output: 200, cost: 0.001 }), "openai-completions"), false, "cache-only input is input");
	assert.equal(unreportedUsage(answer({ stopReason: "error", input: 100, output: 1, cost: 0.0001 }), "anthropic-messages"), true, "failed after it started: partial");
	assert.equal(unreportedUsage(answer({ stopReason: "aborted", content: [] }), "openai-completions"), false, "never started: costUnanswered's, not this");
	assert.equal(unreportedUsage(answer({ stopReason: "toolUse", content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }], input: 5000, cost: 0.005 }), "openai-completions"), true, "output 0 with a tool call: the final usage chunk was lost");
	assert.equal(unreportedUsage(answer({ content: [{ type: "text", text: "x".repeat(20000) }], input: 1200, output: 1, cost: 0.0012 }), "anthropic-messages"), true, "output stuck at message_start's 1");
	assert.equal(unreportedUsage(answer({ content: [{ type: "text", text: "yes" }], input: 1200, output: 1, cost: 0.0012 }), "openai-completions"), false, "1 output token elsewhere is a count");
	assert.equal(unreportedUsage(answer({ content: [{ type: "text", text: "" }], input: 1200, output: 0, cost: 0.0012 }), "openai-completions"), false, "an empty answer with output 0 is consistent");
	assert.equal(unreportedUsage(answer({ input: 100, output: 20, cost: 0.0001 }), "anthropic-messages"), false, "a whole answer");
	assert.equal(unreportedUsage({ stopReason: "stop", content: TEXT, usage: { input: 0, cost: {} } }, "openai-completions"), false, "no finite cost: the meter's unpriced already");
	assert.equal(unreportedUsage(undefined, "openai-completions"), false);
});

test("the meter counts costUnreported on an uncapped run, on a priced model, before the change hook writes, never for a forward", async () => {
	const seen = [];
	const meter = createUsageMeter({ maxTokens: null, onChange: () => seen.push(meter.state.unreported) });
	const observe = (message, model, extra = {}) => {
		const stream = new FakeStream();
		stream.end(message);
		meter.observe(stream, { provider: model.provider, modelId: model.id, model, ...extra });
	};
	observe(answer(), PRICED);
	await flush();
	assert.equal(meter.snapshot().costUnreported, 1, "no cap, no guard: still counted");
	assert.equal(seen.at(-1), 1, "the settle's ledger write already carries it");
	observe(answer(), FREE);
	observe(answer({ input: 10, output: 5, cost: 0.00002 }), PRICED);
	observe(answer({ stopReason: "error", content: [] }), PRICED);
	observe(answer(), PRICED, { forwarded: () => true });
	await flush();
	assert.equal(meter.snapshot().costUnreported, 1, "free, whole, unanswered and forwarded calls are not counted");
	// A caller with no model in its context (outside the two wrappers) is never counted.
	meter.observe(streamOf(usage({})), { provider: "lan", modelId: "priced" });
	await flush();
	assert.equal(meter.snapshot().costUnreported, 1);
	// The result methods too: a classify that reports no input.
	meter.observeResult(Promise.resolve({ answers: {}, stopReason: "stop", usage: usage({}) }), { provider: "lan", modelId: "priced", model: PRICED });
	await flush();
	assert.equal(meter.snapshot().costUnreported, 2);
	// The children's count is added, as a high-water mark.
	meter.setChildren({ processes: 1, unmetered: 0, totals: { input: 0, output: 0, total: 0, cost: 0, calls: 1, unresolved: 0, unpriced: 0, sessions: 1 }, rows: [], costUnreported: 3 });
	meter.setChildren({ processes: 1, unmetered: 0, totals: { input: 0, output: 0, total: 0, cost: 0, calls: 1, unresolved: 0, unpriced: 0, sessions: 1 }, rows: [], costUnreported: 1 });
	assert.equal(meter.snapshot().costUnreported, 5);
});

test("a router that forwards asynchronously is not counted for its own zero usage, through either half; one that does not forward is (issue #571)", async () => {
	const UPSTREAM = { ...PRICED_ANTHROPIC, id: "upstream" };
	const PROXY = { ...PRICED, provider: "router", id: "proxy" };
	const LONE = { ...PRICED, provider: "router", id: "lone" };
	const dispatch = new AsyncLocalStorage();
	const meter = createUsageMeter({ maxTokens: null });
	const catalog = fakeCatalog([]);
	const BROKEN = { ...UPSTREAM, id: "broken" };
	const compatWrapper = wrapProviderStreams({ inner: { streamSimple: (model) => { if (model.id === "broken") throw new Error("upstream setup failed"); const s = new FakeStream(); s.end(answer({ input: 1000, output: 100, cost: 0.0045 })); return s; }, stream: () => null }, fallbackModels: catalog, meter, dispatch });
	class Router {
		streamSimple(model, context, options) {
			const outer = new FakeStream();
			if (model.id === "upstream") {
				outer.end(answer({ input: 1000, output: 100, cost: 0.0045 }));
				return outer;
			}
			if (model.id.startsWith("catch-")) {
				try {
					if (model.id === "catch-runtime") this.streamSimple(BROKEN, context, options);
					else compatWrapper.streamSimple(BROKEN, context, { ...options });
				} catch {
					// the forward failed; the router answers itself
				}
				outer.end(answer());
				return outer;
			}
			if (model.id === "broken") throw new Error("upstream setup failed");
			(async () => {
				await Promise.resolve();
				if (model.id === "proxy") await this.streamSimple(UPSTREAM, context, options).result();
				if (model.id === "proxy-legacy") await compatWrapper.streamSimple(UPSTREAM, context, { ...options }).result();
				await new Promise((resolve) => setTimeout(resolve, 1));
				outer.end(answer());
			})();
			return outer;
		}
	}
	const layer = wrapModelRuntime({ ModelRuntime: Router, meter, dispatch });
	try {
		const runtime = new Router();
		await runtime.streamSimple(PROXY, {}, {}).result();
		await runtime.streamSimple({ ...PROXY, id: "proxy-legacy" }, {}, {}).result();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual([meter.state.calls, meter.snapshot().costUnreported], [4, 0], "two forwards, metered upstream, the routers' zeros not counted");
		assert.ok(Math.abs(meter.state.cost - 0.009) < 1e-12, "the cost is the upstream's");
		await runtime.streamSimple(LONE, {}, {}).result();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(meter.snapshot().costUnreported, 1, "a provider that answered zeros with no forward is counted");
		// A forward that THROWS, which the router catches and answers itself with zeros: the same counters through
		// either half, because both mark the forward before they dispatch it.
		const before = meter.snapshot().costUnreported;
		await runtime.streamSimple({ ...PROXY, id: "catch-runtime" }, {}, {}).result();
		await runtime.streamSimple({ ...PROXY, id: "catch-legacy" }, {}, {}).result();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(meter.snapshot().costUnreported, before, "a forward that threw still marks the call that made it, in both halves");
	} finally {
		layer.restore();
	}
});
