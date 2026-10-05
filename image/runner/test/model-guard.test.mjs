import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import {
	assertPoliciesEnforceable,
	createModelGuard,
	createPolicyGuard,
	createUsageMeter,
	installProcessUsageMeter,
	makeHardStopStream,
	policyEnforcement,
	VIRTUAL_MODEL_API,
	wrapModelRuntime,
	wrapProviderStreams,
	DISPATCH_MARK,
	dispatchToken,
} from "../src/usage-meter.mjs";
import { COST_CAP, decideExit, EXIT_POLICY, MODEL_NOT_ALLOWED, MODEL_POLICY_UNENFORCEABLE } from "../src/outcome.mjs";
import { FABLE_5 } from "./helpers/catalog-models.mjs";

/**
 * Issue #502, part 4: the allowed-model list, checked before every provider call (REQ-MODEL-POLICY,
 * DES-MODEL-POLICY-AT-THE-PROVIDER-WRAPPER). PURE, like cost-guard.test.mjs: no pi import, no filesystem. The
 * behaviour against the real SDK (setModel, a second session, an extension's ctx.modelRegistry call, a virtual
 * router) is usage-meter.integration.test.mjs's.
 */

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
const answer = (extra = {}) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { total: 0 } }, ...extra });

const LISTED = Object.freeze({ id: "listed-1", api: "openai-completions", provider: "local", baseUrl: "http://127.0.0.1:1", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1000, compat: { maxTokensField: "max_tokens" } });
const UNLISTED = Object.freeze({ ...LISTED, id: "unlisted-1" });
const LIST = Object.freeze([{ provider: "local", model: "listed-1" }]);
const VIRTUAL = Object.freeze({ api: VIRTUAL_MODEL_API, provider: "router", id: "auto" });
const call = (model, method = "streamSimple") => ({ method, model, args: [{}, {}] });

/** A ModelRuntime stand-in whose virtual model routes to `route` and re-enters `this.streamSimple`, as pi's does. */
function fakeRuntimeClass({ route = LISTED, message = answer() } = {}) {
	const calls = [];
	const settled = () => {
		const stream = new FakeStream();
		stream.end(message);
		return stream;
	};
	class FakeRuntime {
		streamSimple(model, context, options) {
			calls.push(`streamSimple:${model.id}`);
			if (model.api === VIRTUAL_MODEL_API) {
				const inner = this.streamSimple(route, context, options);
				const outer = new FakeStream();
				inner.result().then((m) => outer.end(m));
				return outer;
			}
			return settled();
		}
		stream(model) {
			calls.push(`stream:${model.id}`);
			return settled();
		}
		streamDeferred(model) {
			calls.push(`streamDeferred:${model.id}`);
			return settled();
		}
		async classify(model) {
			calls.push(`classify:${model.id}`);
			return { answers: {}, usage: { cost: { total: 0 } } };
		}
		async generateImages(model) {
			calls.push(`generateImages:${model.id}`);
			return { output: [], usage: { cost: { total: 0 } } };
		}
	}
	return { FakeRuntime, calls };
}

/** The meter, the brake and the policy guard, wired as run-job.mjs wires them. */
function wired({ allowedModels = LIST, maxCostMicros = null, route, message } = {}) {
	const { FakeRuntime, calls } = fakeRuntimeClass({ route, message });
	const stops = [];
	const logged = [];
	const meter = createUsageMeter({ maxCostMicros, allowedModels, onStop: (reason) => stops.push(reason) });
	const guard = createPolicyGuard({ maxCostMicros, allowedModels, log: (event, fields) => logged.push({ event, fields }), env: {} });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop, guard });
	return { runtime: new FakeRuntime(), calls, meter, guard, stops, logged, layer };
}

// ── The guard alone ──────────────────────────────────────────────────────────────────────────────────────

test("a listed pair passes; an unlisted pair is refused, counted, and logged with numbers only", () => {
	const logged = [];
	const guard = createModelGuard({ allowedModels: LIST, log: (event, fields) => logged.push({ event, fields }) });
	assert.deepEqual([...guard.enforces], [MODEL_NOT_ALLOWED]);
	assert.equal(guard.admit(call(LISTED)), null);
	assert.equal(guard.admit(call(UNLISTED)), MODEL_NOT_ALLOWED);
	assert.equal(guard.admit(call(UNLISTED, "classify")), MODEL_NOT_ALLOWED);
	assert.deepEqual(guard.snapshot(), { modelRefused: 2 });
	assert.deepEqual(logged, [
		{ event: "model_refused", fields: { method: "streamSimple", why: "unlisted", refused: 1 } },
		{ event: "model_refused", fields: { method: "classify", why: "unlisted", refused: 2 } },
	]);
	assert.ok(!JSON.stringify(logged).includes("unlisted-1"), "never a model id on the refusal line");
});

test("the pair is compared whole and case-sensitively: the same id under another provider is refused", () => {
	const guard = createModelGuard({ allowedModels: LIST });
	assert.equal(guard.admit(call({ ...LISTED, provider: "openrouter" })), MODEL_NOT_ALLOWED, "same id, another provider");
	assert.equal(guard.admit(call({ ...LISTED, provider: "Local" })), MODEL_NOT_ALLOWED, "provider case");
	assert.equal(guard.admit(call({ ...LISTED, id: "Listed-1" })), MODEL_NOT_ALLOWED, "model case");
	// A model id may carry `/`; the pair cannot be confused by where the split falls.
	const slashed = createModelGuard({ allowedModels: [{ provider: "openrouter", model: "anthropic/claude-x" }] });
	assert.equal(slashed.admit(call({ ...LISTED, provider: "openrouter", id: "anthropic/claude-x" })), null);
	assert.equal(slashed.admit(call({ ...LISTED, provider: "openrouter/anthropic", id: "claude-x" })), MODEL_NOT_ALLOWED);
	// A call with no model, or ids that are not strings, can never be on a list.
	assert.equal(guard.admit(call(undefined)), MODEL_NOT_ALLOWED);
	assert.equal(guard.admit(call({ provider: "local" })), MODEL_NOT_ALLOWED);
	assert.throws(() => createModelGuard({ allowedModels: [] }), /invalid PI_ALLOWED_MODELS/);
});

// ── The guard in the meter's two halves ──────────────────────────────────────────────────────────────────

test("an unlisted classify model is refused with the hard-stop result, and stops the job", async () => {
	const { runtime, calls, meter, stops, layer } = wired();
	try {
		const refused = await runtime.classify(UNLISTED, {}, {});
		assert.equal(refused.errorMessage, "pi-dispatch: model not allowed");
		assert.equal(refused.stopReason, "aborted");
		assert.deepEqual(calls, [], "never dispatched");
		assert.deepEqual([meter.state.stopReason, stops], [MODEL_NOT_ALLOWED, [MODEL_NOT_ALLOWED]]);
	} finally {
		layer.restore();
	}
});

test("every runtime method is judged: each of the five refuses an unlisted model and admits a listed one", async () => {
	for (const method of ["streamSimple", "stream", "streamDeferred", "classify", "generateImages"]) {
		const { runtime, calls, guard, layer } = wired();
		try {
			const refused = await (method === "classify" || method === "generateImages" ? runtime[method](UNLISTED, {}, {}) : runtime[method](UNLISTED, {}, {}).result());
			assert.equal(refused.errorMessage, "pi-dispatch: model not allowed", method);
			assert.deepEqual([calls, guard.snapshot().modelRefused], [[], 1], method);
		} finally {
			layer.restore();
		}
		const listed = wired();
		try {
			const passed = method === "classify" || method === "generateImages" ? await listed.runtime[method](LISTED, {}, {}) : await listed.runtime[method](LISTED, {}, {}).result();
			assert.notEqual(passed.errorMessage, "pi-dispatch: model not allowed", method);
			assert.deepEqual(listed.calls, [`${method}:listed-1`], method);
		} finally {
			listed.layer.restore();
		}
	}
});

test("a virtual model passes on streamSimple, and its physical route is judged: listed passes, unlisted is refused", async () => {
	const passing = wired({ route: LISTED });
	try {
		const result = await passing.runtime.streamSimple(VIRTUAL, {}, {}).result();
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(passing.calls, ["streamSimple:auto", "streamSimple:listed-1"]);
		assert.equal(passing.meter.state.stopReason, null, "the virtual entry is not on the list, and was not asked about");
	} finally {
		passing.layer.restore();
	}
	const routed = wired({ route: UNLISTED });
	try {
		const result = await routed.runtime.streamSimple(VIRTUAL, {}, {}).result();
		assert.equal(result.errorMessage, "pi-dispatch: model not allowed", "the router's pick is what the list judges");
		assert.deepEqual(routed.calls, ["streamSimple:auto"], "the unlisted physical call never reached the provider");
		assert.deepEqual([routed.meter.state.stopReason, routed.guard.snapshot().modelRefused], [MODEL_NOT_ALLOWED, 1]);
	} finally {
		routed.layer.restore();
	}
});

test("only streamSimple skips a virtual model: on any other method it is judged as itself, and refused", async () => {
	for (const method of ["stream", "streamDeferred", "classify", "generateImages"]) {
		const { runtime, calls, guard, layer } = wired();
		try {
			const refused = await (method === "classify" || method === "generateImages" ? runtime[method](VIRTUAL, {}, {}) : runtime[method](VIRTUAL, {}, {}).result());
			assert.equal(refused.errorMessage, "pi-dispatch: model not allowed", method);
			assert.deepEqual([calls, guard.snapshot().modelRefused], [[], 1], method);
		} finally {
			layer.restore();
		}
	}
});

test("a runtime call's forward to another model is a full call on the list: judged, prepared and counted (PR #547's review, round 3)", async () => {
	const PROXY = Object.freeze({ ...LISTED, id: "proxy-1", provider: "proxy" });
	// Another model on the SAME provider is another pair too.
	const SIBLING = Object.freeze({ ...LISTED, id: "listed-2" });
	const list = [...LIST, { provider: "proxy", model: "proxy-1" }, { provider: "local", model: "listed-2" }];
	const meter = createUsageMeter({ allowedModels: list });
	const logged = [];
	const guard = createPolicyGuard({ allowedModels: list, log: (event, fields) => logged.push({ event, fields }) });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const reached = [];
	const sent = [];
	const inner = {
		streamSimple: (model, _context, options) => {
			reached.push(model.id);
			const stream = new FakeStream();
			(async () => {
				try {
					const payload = (await options?.onPayload?.({ model: model.id, messages: [] }, model)) ?? { model: model.id };
					sent.push(payload.model);
					stream.end(answer());
				} catch (error) {
					stream.end({ role: "assistant", stopReason: "error", errorMessage: error.message, usage: answer().usage });
				}
			})();
			return stream;
		},
	};
	const dispatch = new AsyncLocalStorage();
	const compat = wrapProviderStreams({ inner, fallbackModels: null, meter, hardStop, guard, dispatch });
	const forward = async (to, options = {}) => {
		const token = dispatchToken(PROXY);
		return dispatch.run(token, () => compat.streamSimple(to, {}, { ...options, [DISPATCH_MARK]: token }).result());
	};
	// A listed forward, to another model on the same provider: dispatched and counted under its own model.
	const listed = await forward(SIBLING);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual([listed.stopReason, reached, meter.state.calls, guard.snapshot().modelRefused], ["stop", ["listed-2"], 1, 0]);
	// A forward whose own onPayload rewrites the model is prepared like any call: refused, why payload.
	const rewritten = await forward(SIBLING, { onPayload: (payload) => ({ ...payload, model: "unlisted-x" }) });
	assert.match(rewritten.errorMessage, /model not allowed/);
	assert.deepEqual([sent, logged.at(-1)?.fields?.why], [["listed-2"], "payload"], "the rewritten model never reached a request");
	// An unlisted forward: refused on the list before it is sent.
	const refused = await forward(UNLISTED);
	assert.equal(refused.errorMessage, "pi-dispatch: model not allowed");
	assert.deepEqual([reached, meter.state.stopReason], [["listed-2", "listed-2"], MODEL_NOT_ALLOWED]);
});

test("a listed forward on anthropic-messages logs model_fallback when a fallback answered, like any listed call", async () => {
	const REQUESTED = Object.freeze({ ...LISTED, api: "anthropic-messages", provider: "anthropic", id: "big-1", compat: { allowedFallbackModels: [{ provider: "anthropic", model: "small-1" }] } });
	const list = [{ provider: "anthropic", model: "big-1" }, { provider: "anthropic", model: "small-1" }, { provider: "proxy", model: "proxy-1" }];
	const meter = createUsageMeter({ allowedModels: list });
	const logged = [];
	const guard = createPolicyGuard({ allowedModels: list, log: (event, fields) => logged.push({ event, fields }) });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const inner = {
		streamSimple: () => {
			const stream = new FakeStream();
			stream.end({ ...answer(), responseModel: "small-1" });
			return stream;
		},
	};
	const dispatch = new AsyncLocalStorage();
	const compat = wrapProviderStreams({ inner, fallbackModels: null, meter, hardStop, guard, dispatch });
	const token = dispatchToken({ provider: "proxy", id: "proxy-1", api: "proxy-api" });
	await dispatch.run(token, () => compat.streamSimple(REQUESTED, {}, { [DISPATCH_MARK]: token }).result());
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(logged.filter((line) => line.event === "model_fallback").map((line) => line.fields), [{ provider: "anthropic", requested: "big-1", answered: "small-1" }]);
});

test("the compat half judges a legacy call on the list, and skips a call the runtime half already judged", async () => {
	const meter = createUsageMeter({ allowedModels: LIST });
	const guard = createPolicyGuard({ allowedModels: LIST });
	const hardStop = makeHardStopStream({ createStream: () => new FakeStream() });
	const reached = [];
	const inner = {
		streamSimple: (model) => {
			reached.push(model.id);
			const stream = new FakeStream();
			stream.end(answer());
			return stream;
		},
		stream: (model) => {
			reached.push(model.id);
			const stream = new FakeStream();
			stream.end(answer());
			return stream;
		},
	};
	const dispatch = new AsyncLocalStorage();
	const compat = wrapProviderStreams({ inner, fallbackModels: null, meter, hardStop, guard, dispatch });
	// The runtime call's own re-entry (its token, in its options, on its model): judged there, not here.
	const token = dispatchToken(UNLISTED);
	await dispatch.run(token, () => compat.streamSimple(UNLISTED, {}, { [DISPATCH_MARK]: token })).result();
	assert.deepEqual([reached, guard.snapshot().modelRefused], [["unlisted-1"], 0], "inside the runtime dispatch: judged there, not here");
	await compat.stream(LISTED, {}, {}).result();
	const refused = await compat.streamSimple(UNLISTED, {}, {}).result();
	assert.equal(refused.errorMessage, "pi-dispatch: model not allowed");
	assert.deepEqual([reached, meter.state.stopReason, guard.snapshot().modelRefused], [["unlisted-1", "listed-1"], MODEL_NOT_ALLOWED, 1]);
});

// ── The policy guard: order, snapshot, enforcement ───────────────────────────────────────────────────────

test("the model check runs before the cost check: an unlisted call under a cap it would also pass is model-not-allowed", async () => {
	// A cap of 0 refuses every priced call. The unlisted call must be named by the list, and the cost guard must
	// never have been asked about it (nothing in flight, nothing refused).
	const { runtime, calls, meter, guard, logged, layer } = wired({ maxCostMicros: 0 });
	try {
		const refused = await runtime.streamSimple(UNLISTED, {}, {}).result();
		assert.equal(refused.errorMessage, "pi-dispatch: model not allowed");
		assert.equal(meter.state.stopReason, MODEL_NOT_ALLOWED);
		assert.deepEqual(calls, []);
		assert.deepEqual([guard.cost.state.refused, guard.cost.state.inflight], [0, 0], "the cost guard was never asked");
		assert.deepEqual(logged.map((entry) => entry.event), ["model_refused"]);
		assert.deepEqual(guard.snapshot(), { costCapMicros: 0, costRefused: 0, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0, modelRefused: 1 });
	} finally {
		layer.restore();
	}
	// A LISTED call under the same cap is still the cap's to refuse.
	const capped = wired({ maxCostMicros: 0 });
	try {
		const refused = await capped.runtime.streamSimple(LISTED, {}, {}).result();
		assert.equal(refused.errorMessage, "pi-dispatch: cost cap reached");
		assert.deepEqual([capped.meter.state.stopReason, capped.guard.snapshot().modelRefused, capped.guard.snapshot().costRefused], [COST_CAP, 0, 1]);
	} finally {
		capped.layer.restore();
	}
	assert.deepEqual([...createPolicyGuard({ maxCostMicros: 0, allowedModels: LIST }).enforces], [MODEL_NOT_ALLOWED, COST_CAP]);
});

test("the exit line gains modelRefused only when a list is set", () => {
	assert.equal(createPolicyGuard({}), null, "neither policy: no guard, so nothing is spread onto the exit line");
	assert.deepEqual(Object.keys(createPolicyGuard({ maxCostMicros: 5 }).snapshot()), ["costCapMicros", "costRefused", "boundExceeded", "longContext", "costUnjudged", "costUnanswered"], "a cap alone: the cost fields, byte-identical to before");
	assert.deepEqual(createPolicyGuard({ allowedModels: LIST }).snapshot(), { modelRefused: 0 });
	assert.deepEqual(Object.keys(createPolicyGuard({ maxCostMicros: 5, allowedModels: LIST }).snapshot()).at(-1), "modelRefused", "after the cost fields, the worker's TOKEN_KEYS order");
	assert.deepEqual([...createPolicyGuard({ maxCostMicros: 5 }).enforces], [COST_CAP]);
	assert.deepEqual([...createPolicyGuard({ allowedModels: LIST }).enforces], [MODEL_NOT_ALLOWED]);
});

test("a refused call exits 2 / model-not-allowed through decideExit", async () => {
	const { runtime, meter, layer } = wired();
	try {
		await runtime.streamSimple(UNLISTED, {}, {}).result();
	} finally {
		layer.restore();
	}
	const outcome = decideExit({ budgetAborted: false, budgetTurns: 1, meterStop: meter.state.stopReason, tokenAborted: false, terminal: { stopReason: "aborted", errorMessage: "pi-dispatch: model not allowed" } });
	assert.deepEqual([outcome.code, outcome.reason], [EXIT_POLICY, MODEL_NOT_ALLOWED]);
});

// ── Server-side fallbacks: every one listed, then logged ─────────────────────────────────────────────────

const FABLE_FALLBACKS = [{ provider: "anthropic", model: "claude-opus-4-8" }, { provider: "anthropic", model: "claude-opus-5" }];

test("a fallback pi would send must be listed too: anthropic-messages sends compat.allowedFallbackModels as fallbacks", async () => {
	const logged = [];
	const guard = createModelGuard({ allowedModels: [{ provider: "anthropic", model: FABLE_5.id }], log: (event, fields) => logged.push(fields) });
	assert.equal(guard.admit(call(FABLE_5)), MODEL_NOT_ALLOWED, "fable-5 is listed, its fallbacks are not");
	assert.deepEqual(logged, [{ method: "streamSimple", why: "fallback", refused: 1 }]);
	// The pair is the MODEL's provider and the fallback's id, which is all pi sends, whatever the entry's provider says.
	const withBoth = createModelGuard({ allowedModels: [{ provider: "anthropic", model: FABLE_5.id }, ...FABLE_FALLBACKS] });
	assert.equal(withBoth.admit(call(FABLE_5)), null);
	const elsewhere = { ...FABLE_5, compat: { allowedFallbackModels: [{ provider: "somebody-else", model: "claude-opus-5" }] } };
	assert.equal(withBoth.admit(call(elsewhere)), null, "anthropic/claude-opus-5 is listed, and that is what is sent");
	const unlistedId = { ...FABLE_5, compat: { allowedFallbackModels: [{ provider: "anthropic", model: "claude-mystery" }] } };
	assert.equal(withBoth.admit(call(unlistedId)), MODEL_NOT_ALLOWED);
	// Another api never sends the field, so it does not decide the call there.
	const other = createModelGuard({ allowedModels: [{ provider: "local", model: "listed-1" }] });
	assert.equal(other.admit(call({ ...LISTED, compat: { allowedFallbackModels: [{ provider: "local", model: "x" }] } })), null);
});

test("model_fallback: logged when the answer came from one of the requested model's fallbacks, whatever the entry's provider", async () => {
	const list = [{ provider: "anthropic", model: FABLE_5.id }, ...FABLE_FALLBACKS];
	for (const [label, model] of [
		["the catalog's fable-5", FABLE_5],
		["an entry whose provider field differs", { ...FABLE_5, compat: { allowedFallbackModels: [{ provider: "elsewhere", model: "claude-opus-4-8" }] } }],
	]) {
		const { runtime, meter, logged, layer } = wired({ allowedModels: list, message: answer({ responseModel: "claude-opus-4-8" }) });
		try {
			const result = await runtime.streamSimple(model, {}, {}).result();
			await flush();
			assert.equal(result.stopReason, "stop", label);
			assert.equal(meter.state.stopReason, null, `${label}: a listed fallback is not refused`);
			assert.deepEqual(logged, [{ event: "model_fallback", fields: { provider: "anthropic", requested: "claude-fable-5", answered: "claude-opus-4-8" } }], label);
		} finally {
			layer.restore();
		}
	}
});

test("model_fallback: an alias (openai-completions' responseModel) or an answer outside the fallback list is not logged", async () => {
	const list = [{ provider: "anthropic", model: FABLE_5.id }, ...FABLE_FALLBACKS, { provider: "local", model: "listed-1" }];
	for (const [label, model, responseModel] of [
		["a completions alias", LISTED, "listed-1-2026-01-01"],
		["a completions model that carries fallbacks (only anthropic-messages sends them)", { ...LISTED, compat: { allowedFallbackModels: [{ provider: "local", model: "listed-2" }] } }, "listed-2"],
		["the requested id itself", FABLE_5, FABLE_5.id],
		["a name that is not one of its fallbacks", FABLE_5, "claude-somebody-else"],
	]) {
		const { runtime, logged, meter, layer } = wired({ allowedModels: list, message: answer({ responseModel }) });
		try {
			await runtime.streamSimple(model, {}, {}).result();
			await flush();
			assert.deepEqual([logged, meter.state.stopReason], [[], null], label);
		} finally {
			layer.restore();
		}
	}
});

// ── PR #538's review: what else picks the model that answers ─────────────────────────────────────────────

test("samplingParams naming a routing field refuse a listed call, from the model or the call, in both halves", async () => {
	for (const api of ["openai-completions", "openai-responses", "azure-openai-responses"]) {
		const base = { ...LISTED, api };
		for (const [label, model, options] of [
			["the call's samplingParams", base, { samplingParams: { model: "big-unlisted" } }],
			["the catalog's samplingParams", { ...base, samplingParams: { model: "big-unlisted" } }, {}],
			["a `models` fallback list", base, { samplingParams: { models: ["big-unlisted"] } }],
			["a modelId", base, { samplingParams: { modelId: "big-unlisted" } }],
			["a gateway's providerOptions", base, { samplingParams: { providerOptions: { gateway: { models: ["anthropic/claude-opus-5"] } } } }],
			// pi 1.0.2's per-level params (issue #587): resolveSamplingParams merges the level pi picks per call, so a
			// routing key under ANY level refuses, whatever level this call would ask for.
			["a thinking level's model", { ...base, samplingParamsByThinkingLevel: { high: { model: "big-unlisted" } } }, {}],
			["a level the call does not ask for", { ...base, samplingParamsByThinkingLevel: { off: { temperature: 0 }, xhigh: { models: ["big-unlisted"] } } }, { reasoning: "low" }],
			["an unreadable level", { ...base, samplingParamsByThinkingLevel: { high: "model=big-unlisted" } }, {}],
			["an unreadable level map", { ...base, samplingParamsByThinkingLevel: [{ model: "big-unlisted" }] }, {}],
		]) {
			const { runtime, calls, meter, logged, layer } = wired();
			try {
				const refused = await runtime.streamSimple(model, {}, options).result();
				assert.equal(refused.errorMessage, "pi-dispatch: model not allowed", `${api}: ${label}`);
				assert.deepEqual([calls, meter.state.stopReason, logged[0]?.fields.why], [[], MODEL_NOT_ALLOWED, "sampling"], `${api}: ${label}`);
			} finally {
				layer.restore();
			}
			const compatMeter = createUsageMeter({ allowedModels: LIST });
			const reached = [];
			const compat = wrapProviderStreams({ inner: { streamSimple: (m) => (reached.push(m.id), new FakeStream()) }, fallbackModels: null, meter: compatMeter, hardStop: makeHardStopStream({ createStream: () => new FakeStream() }), guard: createPolicyGuard({ allowedModels: LIST }) });
			const legacy = await compat.streamSimple(model, {}, options).result();
			assert.deepEqual([legacy.errorMessage, reached, compatMeter.state.stopReason], ["pi-dispatch: model not allowed", [], MODEL_NOT_ALLOWED], `compat ${api}: ${label}`);
		}
	}
	// Every other key passes under a list alone: it changes how the model answers, never which model answers. (The
	// cost guard, under a cap, keeps its own wider price rule.)
	const guard = createModelGuard({ allowedModels: LIST });
	for (const samplingParams of [{ temperature: 0.2, max_tokens: 10, n: 1 }, { min_p: 0.05 }, { reasoning_effort: "high" }, { chat_template_kwargs: { enable_thinking: false } }, { service_tier: "priority" }]) {
		assert.equal(guard.admit({ method: "streamSimple", model: LISTED, args: [{}, { samplingParams }] }), null, JSON.stringify(samplingParams));
		assert.equal(guard.admit({ method: "streamSimple", model: { ...LISTED, samplingParams }, args: [{}, {}] }), null, `catalog ${JSON.stringify(samplingParams)}`);
	}
	assert.equal(guard.admit({ method: "streamSimple", model: { ...LISTED, api: "anthropic-messages" }, args: [{}, { samplingParams: { model: "x" } }] }), null);
	// The same under a thinking level: price and sampling knobs pass, the level map itself is no routing key.
	assert.equal(guard.admit({ method: "streamSimple", model: { ...LISTED, samplingParamsByThinkingLevel: { off: { temperature: 0.2 }, high: { max_tokens: 10, min_p: 0.05 } } }, args: [{}, {}] }), null);
});

test("on azure, a per-call deployment name or deployment map refuses a listed call; so does a caller's own fetch anywhere", () => {
	const azure = { ...LISTED, api: "azure-openai-responses" };
	const guard = createModelGuard({ allowedModels: LIST });
	assert.equal(guard.admit({ method: "streamSimple", model: azure, args: [{}, {}] }), null);
	assert.equal(guard.admit({ method: "streamSimple", model: azure, args: [{}, { azureDeploymentName: "gpt-big-unlisted" }] }), MODEL_NOT_ALLOWED);
	assert.equal(guard.admit({ method: "streamSimple", model: azure, args: [{}, { env: { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "listed-1=gpt-big-unlisted" } }] }), MODEL_NOT_ALLOWED);
	assert.equal(guard.admit({ method: "streamSimple", model: LISTED, args: [{}, { azureDeploymentName: "x" }] }), null, "only azure reads it");
	assert.equal(guard.snapshot().modelRefused, 2);
	// A caller's own fetch sends after every hook, on any api: refused under a list.
	assert.equal(guard.admit({ method: "streamSimple", model: LISTED, args: [{}, { fetch: globalThis.fetch }] }), MODEL_NOT_ALLOWED);
	assert.equal(guard.snapshot().modelRefused, 3);
});

test("on provider azure, a deployment name or map refuses on EVERY api it serves, openai-completions included (issue #587)", () => {
	// pi 1.0.3's azure provider rewrites payload.model to resolveDeploymentName(...) inside an onPayload wrapper of its
	// own (providers/azure.js), outside the guard's, for its openai-completions models too (azure/deepseek-v4-pro).
	const list = [{ provider: "azure", model: "deepseek-v4-pro" }, { provider: "azure", model: "gpt-5.4" }];
	const guard = createModelGuard({ allowedModels: list });
	for (const api of ["openai-completions", "azure-openai-responses", "some-future-api"]) {
		const model = { ...LISTED, provider: "azure", id: api === "openai-completions" ? "deepseek-v4-pro" : "gpt-5.4", api, baseUrl: "" };
		assert.equal(guard.admit({ method: "streamSimple", model, args: [{}, {}] }), null, `${api}: a plain listed call passes`);
		assert.equal(guard.admit({ method: "streamSimple", model, args: [{}, { azureDeploymentName: "gpt-big-unlisted" }] }), MODEL_NOT_ALLOWED, `${api}: a deployment name`);
		assert.equal(guard.admit({ method: "stream", model, args: [{}, { env: { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${model.id}=gpt-big-unlisted` } }] }), MODEL_NOT_ALLOWED, `${api}: a deployment map`);
	}
	assert.equal(guard.snapshot().modelRefused, 6);
	// Another provider on openai-completions never reads either option.
	const other = createModelGuard({ allowedModels: LIST });
	assert.equal(other.admit({ method: "streamSimple", model: LISTED, args: [{}, { azureDeploymentName: "x", env: { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "listed-1=x" } }] }), null);
});

// ── Issue #587's gate: the sampling layers pi reads are the ones the guards judged ───────────────────────

/** A runtime that records the model and options each call was dispatched with, by reference, as pi receives them. */
function recordingRuntimeClass() {
	const dispatched = [];
	class FakeRuntime {
		streamSimple(model, _context, options) {
			dispatched.push({ model, options });
			const stream = new FakeStream();
			stream.end(answer());
			return stream;
		}
	}
	return { FakeRuntime, dispatched };
}

function recorded({ allowedModels = LIST, maxCostMicros = null } = {}) {
	const { FakeRuntime, dispatched } = recordingRuntimeClass();
	const meter = createUsageMeter({ maxCostMicros, allowedModels, onStop: () => {} });
	const logged = [];
	const guard = createPolicyGuard({ maxCostMicros, allowedModels, log: (event, fields) => logged.push({ event, fields }), env: {} });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop: makeHardStopStream({ createStream: () => new FakeStream() }), guard });
	return { runtime: new FakeRuntime(), dispatched, meter, logged, layer };
}

test("a level map or a layer that is not plain own data refuses: inherited, non-enumerable, accessor, a class (issue #587)", async () => {
	// pi reads `byLevel?.[level]` by property access, so an inherited or non-enumerable level reaches the request while
	// Object.values() never sees it. Each shape refuses under a list and under a cap; nothing is dispatched.
	const hidden = () => {
		const levels = {};
		Object.defineProperty(levels, "off", { value: { model: "unlisted-1", max_tokens: 5_000_000 }, enumerable: false });
		return levels;
	};
	const accessor = () => ({ get off() { return { model: "unlisted-1" }; } });
	const layerAccessor = () => ({ off: { get model() { return "unlisted-1"; } } });
	class Levels { constructor() { this.off = { temperature: 0 }; } }
	const shapes = [
		["an inherited level", () => ({ samplingParamsByThinkingLevel: Object.create({ off: { model: "unlisted-1", max_tokens: 5_000_000 } }) })],
		["a non-enumerable level", () => ({ samplingParamsByThinkingLevel: hidden() })],
		["an accessor level", () => ({ samplingParamsByThinkingLevel: accessor() })],
		["an accessor inside a level", () => ({ samplingParamsByThinkingLevel: layerAccessor() })],
		["a class instance as the map", () => ({ samplingParamsByThinkingLevel: new Levels() })],
		["inherited samplingParams", () => ({ samplingParams: Object.create({ model: "unlisted-1" }) })],
	];
	for (const [label, extra] of shapes) {
		for (const policy of [{ allowedModels: LIST }, { allowedModels: null, maxCostMicros: 1_000_000_000 }]) {
			const { runtime, dispatched, meter, layer } = recorded(policy);
			try {
				const result = await runtime.streamSimple({ ...LISTED, ...extra() }, {}, {}).result();
				assert.equal(result.stopReason, "aborted", `${label}, ${policy.allowedModels ? "list" : "cap"}`);
				assert.deepEqual([dispatched.length, meter.state.stopReason], [0, policy.allowedModels ? MODEL_NOT_ALLOWED : COST_CAP], `${label}, ${policy.allowedModels ? "list" : "cap"}`);
			} finally {
				layer.restore();
			}
		}
	}
});

test("the sampling layers and options pi receives are copies: a mutation after the call returns changes nothing sent (issue #587)", async () => {
	// pi reads the model's and the call's sampling parameters after an await (prepareRequest), so the caller's own objects
	// could be changed between the guard's verdict and the request. The guard judges one deep copy and pi gets it.
	for (const where of ["samplingParams", "level", "options", "env"]) {
		const { runtime, dispatched, meter, layer } = recorded({ maxCostMicros: 1_000_000_000 });
		try {
			const model = { ...LISTED, samplingParams: {}, samplingParamsByThinkingLevel: { off: {} }, cost: { ...LISTED.cost }, compat: { ...LISTED.compat } };
			const options = { samplingParams: {}, env: {} };
			const stream = runtime.streamSimple(model, {}, options);
			const target = { samplingParams: model.samplingParams, level: model.samplingParamsByThinkingLevel.off, options: options.samplingParams, env: options.env }[where];
			target.model = "unlisted-1";
			target.max_tokens = 5_000_000;
			target.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = "listed-1=big";
			model.cost.output = 0;
			model.compat.maxTokensField = "max_completion_tokens";
			await stream.result();
			assert.equal(meter.state.stopReason, null, where);
			assert.equal(dispatched.length, 1, where);
			const sent = dispatched[0];
			assert.notEqual(sent.model, model, `${where}: the model pi gets is the guard's copy`);
			assert.deepEqual({ ...sent.model.samplingParams }, {}, `${where}: model samplingParams`);
			assert.deepEqual({ ...sent.model.samplingParamsByThinkingLevel.off }, {}, `${where}: the off level`);
			assert.deepEqual({ ...sent.options.samplingParams }, {}, `${where}: the call's samplingParams`);
			assert.deepEqual({ ...sent.options.env }, {}, `${where}: the call's env`);
			assert.equal(sent.model.cost.output, 2, `${where}: the cost the bound was judged on`);
			assert.equal(sent.model.compat.maxTokensField, "max_tokens", `${where}: the compat the bound was judged on`);
		} finally {
			layer.restore();
		}
	}
});

test("the compat half hands its provider the same copies, and refuses an inherited level too (issue #587)", async () => {
	const sent = [];
	const meter = createUsageMeter({ allowedModels: LIST });
	const inner = { streamSimple: (model, _context, options) => (sent.push({ model, options }), new FakeStream()) };
	const compat = wrapProviderStreams({ inner, fallbackModels: null, meter, hardStop: makeHardStopStream({ createStream: () => new FakeStream() }), guard: createPolicyGuard({ allowedModels: LIST }) });
	const model = { ...LISTED, samplingParamsByThinkingLevel: { off: {} } };
	const options = { samplingParams: {} };
	compat.streamSimple(model, {}, options);
	model.samplingParamsByThinkingLevel.off.model = "unlisted-1";
	options.samplingParams.model = "unlisted-1";
	assert.equal(sent.length, 1);
	assert.deepEqual([{ ...sent[0].model.samplingParamsByThinkingLevel.off }, { ...sent[0].options.samplingParams }], [{}, {}]);
	const refused = await compat.streamSimple({ ...LISTED, samplingParamsByThinkingLevel: Object.create({ off: { model: "unlisted-1" } }) }, {}, {}).result();
	assert.deepEqual([refused.errorMessage, sent.length, meter.state.stopReason], ["pi-dispatch: model not allowed", 1, MODEL_NOT_ALLOWED]);
});

/** A runtime whose provider runs options.onPayload on `{ model }` before it sends, as every pinned api does, and records what it sent. */
function payloadRuntimeClass() {
	const sent = [];
	class FakeRuntime {
		streamSimple(model, _context, options) {
			const stream = new FakeStream();
			(async () => {
				try {
					const payload = { model: model.id, messages: [] };
					const next = await options?.onPayload?.(payload, model);
					sent.push((next ?? payload).model);
					stream.end(answer());
				} catch (error) {
					stream.end({ role: "assistant", stopReason: "error", errorMessage: error.message, content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } });
				}
			})();
			return stream;
		}
		stream(model, context, options) {
			return this.streamSimple(model, context, options);
		}
	}
	return { FakeRuntime, sent };
}

test("a payload hook that changes the model fails the call before it is sent and stops the job; one that does not passes", async () => {
	const { FakeRuntime, sent } = payloadRuntimeClass();
	const stops = [];
	const logged = [];
	const meter = createUsageMeter({ allowedModels: LIST, onStop: (reason) => stops.push(reason) });
	const guard = createPolicyGuard({ allowedModels: LIST, log: (event, fields) => logged.push(fields) });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop: makeHardStopStream({ createStream: () => new FakeStream() }), guard });
	try {
		const runtime = new FakeRuntime();
		// No hook at all, and a hook that touches nothing that routes: sent as asked.
		await runtime.streamSimple(LISTED, {}).result();
		await runtime.streamSimple(LISTED, {}, { onPayload: (payload) => ({ ...payload, temperature: 0 }) }).result();
		// A hook that mutates in place and returns nothing is read too.
		const inPlace = await runtime.stream(LISTED, {}, { onPayload: (payload) => void (payload.fallbacks = [{ model: "big-unlisted" }]) }).result();
		assert.deepEqual(sent, ["listed-1", "listed-1"]);
		assert.equal(inPlace.errorMessage, "pi-dispatch: model not allowed");
		assert.deepEqual([stops, guard.snapshot().modelRefused, logged.map((fields) => fields.why)], [[MODEL_NOT_ALLOWED], 1, ["payload"]]);
	} finally {
		layer.restore();
	}
	// The returned-payload path, on a fresh meter.
	const second = payloadRuntimeClass();
	const meter2 = createUsageMeter({ allowedModels: LIST });
	const layer2 = wrapModelRuntime({ ModelRuntime: second.FakeRuntime, meter: meter2, hardStop: makeHardStopStream({ createStream: () => new FakeStream() }), guard: createPolicyGuard({ allowedModels: LIST }) });
	try {
		const rewritten = await new second.FakeRuntime().streamSimple(LISTED, {}, { onPayload: (payload) => ({ ...payload, model: "big-unlisted" }) }).result();
		assert.equal(rewritten.errorMessage, "pi-dispatch: model not allowed");
		assert.deepEqual([second.sent, meter2.state.stopReason], [[], MODEL_NOT_ALLOWED]);
	} finally {
		layer2.restore();
	}
	// Under a list the payload check is installed ALWAYS, also on a call that passed no options at all, so whatever pi
	// hands the provider as onPayload is the guard's wrapper.
	const always = payloadRuntimeClass();
	const given = [];
	class Listed extends always.FakeRuntime {
		streamSimple(model, context, options) {
			given.push(options);
			return super.streamSimple(model, context, options);
		}
	}
	const layer4 = wrapModelRuntime({ ModelRuntime: Listed, meter: createUsageMeter({ allowedModels: LIST }), hardStop: makeHardStopStream({ createStream: () => new FakeStream() }), guard: createPolicyGuard({ allowedModels: LIST }) });
	try {
		await new Listed().streamSimple(LISTED, {}).result();
		await new Listed().streamSimple(LISTED, {}, { maxTokens: 5 }).result();
		assert.deepEqual(given.map((options) => typeof options?.onPayload), ["function", "function"]);
		assert.equal(given[1].maxTokens, 5, "the caller's other options are kept");
	} finally {
		layer4.restore();
	}
	// With no list, options pass through untouched: no onPayload is added.
	const plain = payloadRuntimeClass();
	const seen = [];
	class Spy extends plain.FakeRuntime {
		streamSimple(model, context, options) {
			seen.push(options);
			return super.streamSimple(model, context, options);
		}
	}
	const layer3 = wrapModelRuntime({ ModelRuntime: Spy, meter: createUsageMeter({ maxCostMicros: 1_000_000_000 }), hardStop: makeHardStopStream({ createStream: () => new FakeStream() }), guard: createPolicyGuard({ maxCostMicros: 1_000_000_000 }) });
	try {
		const options = { maxTokens: 10 };
		await new Spy().streamSimple(LISTED, {}, options).result();
		// The caller's own keys and nothing else: no onPayload is added. The copy carries only the dispatch mark (issue
		// #543), a symbol, so it never reaches a payload.
		assert.deepEqual([Object.keys(seen[0]), seen[0].maxTokens, Object.getOwnPropertySymbols(seen[0])], [["maxTokens"], 10, [DISPATCH_MARK]], "a cap alone adds no onPayload");
	} finally {
		layer3.restore();
	}
});

/** One call on a fresh payload runtime under a list, with the given call options; what was sent, and the guard. */
async function payloadCall(options, { method = "streamSimple", payloadOf } = {}) {
	const sent = [];
	class FakeRuntime {
		streamSimple(model, _context, given) {
			const stream = new FakeStream();
			(async () => {
				try {
					const payload = payloadOf ? payloadOf(model) : { model: model.id, messages: [] };
					const next = await given?.onPayload?.(payload, model);
					// What a provider puts on the wire: pi uses the hook's result when there is one.
					sent.push(JSON.parse(JSON.stringify(next === undefined ? payload : next)));
					stream.end(answer());
				} catch (error) {
					stream.end({ role: "assistant", stopReason: "error", errorMessage: error.message, content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } });
				}
			})();
			return stream;
		}
		async classify(model, _context, given) {
			const payload = payloadOf ? payloadOf(model) : { model: model.id };
			try {
				const next = await given?.onPayload?.(payload, model);
				sent.push(JSON.parse(JSON.stringify(next === undefined ? payload : next)));
				return { answers: {}, usage: { cost: { total: 0 } } };
			} catch (error) {
				return { answers: {}, stopReason: "error", errorMessage: error.message, usage: { cost: { total: 0 } } };
			}
		}
		generateImages(model, context, given) {
			return this.classify(model, context, given).then((r) => ({ ...r, output: [] }));
		}
	}
	const meter = createUsageMeter({ allowedModels: LIST });
	const guard = createPolicyGuard({ allowedModels: LIST });
	const layer = wrapModelRuntime({ ModelRuntime: FakeRuntime, meter, hardStop: makeHardStopStream({ createStream: () => new FakeStream() }), guard });
	try {
		const runtime = new FakeRuntime();
		const result = method === "streamSimple" ? await runtime.streamSimple(LISTED, {}, options).result() : await runtime[method](LISTED, {}, options);
		return { result, sent, meter, guard };
	} finally {
		layer.restore();
	}
}

test("a payload hook cannot slip a model past the check with toJSON or an accessor: the copy checked is the copy sent", async () => {
	const toUnlisted = function () {
		return { ...this, model: "big-unlisted", toJSON: undefined };
	};
	const getterPayload = (payload) => {
		let reads = 0;
		const out = { ...payload };
		Object.defineProperty(out, "model", { enumerable: true, get: () => (reads++ === 0 ? "listed-1" : "big-unlisted") });
		return out;
	};
	for (const [label, onPayload] of [
		["a returned payload with its own toJSON", (payload) => ({ ...payload, toJSON: () => ({ ...payload, model: "big-unlisted" }) })],
		["a returned payload with an inherited toJSON", (payload) => Object.assign(Object.create({ toJSON: toUnlisted }), payload)],
		["a toJSON set in place", (payload) => void (payload.toJSON = () => ({ ...payload, toJSON: undefined, model: "big-unlisted" }))],
		["an accessor on model", getterPayload],
		["an accessor on model that never changes its answer", (payload) => Object.defineProperty({ ...payload }, "model", { enumerable: true, get: () => "listed-1" })],
	]) {
		const { result, sent, meter, guard } = await payloadCall({ onPayload });
		assert.equal(result.errorMessage, "pi-dispatch: model not allowed", label);
		assert.deepEqual([sent, meter.state.stopReason, guard.snapshot().modelRefused], [[], MODEL_NOT_ALLOWED, 1], label);
	}
	// A nested toJSON inside a routing value is resolved to what it serialises to, then compared.
	const nested = await payloadCall({ onPayload: (payload) => ({ ...payload, fallbacks: [{ toJSON: () => ({ model: "big-unlisted" }) }] }) });
	assert.deepEqual([nested.sent, nested.meter.state.stopReason], [[], MODEL_NOT_ALLOWED]);
	// A getter nested inside a routing value is read once, into the copy: what was compared is what is sent.
	let reads = 0;
	const nestedGetter = await payloadCall(
		{ onPayload: (payload) => ({ ...payload, fallbacks: [{ get model() {
			return reads++ === 0 ? "listed-2" : "big-unlisted";
		} }] }) },
		{ payloadOf: (model) => ({ model: model.id, fallbacks: [{ model: "listed-2" }] }) },
	);
	assert.deepEqual(nestedGetter.sent, [{ model: "listed-1", fallbacks: [{ model: "listed-2" }] }], "the unlisted id never reaches the wire");
	// The copy is what pi gets back, also when the hook returned nothing: never the hook's own object, never undefined.
	const guard = createModelGuard({ allowedModels: LIST });
	const wrapped = (onPayload) => guard.prepare({ method: "streamSimple", args: [{}, { onPayload }], stop: () => {} })[1].onPayload;
	const payload = { model: "listed-1", messages: [] };
	const fromNothing = await wrapped(() => undefined)(payload, LISTED);
	assert.ok(fromNothing !== undefined && fromNothing !== payload, "a copy, even when the hook returned nothing");
	assert.deepEqual(fromNothing, payload);
	const own = { model: "listed-1", messages: [{ role: "user", content: "edited" }] };
	const fromHook = await wrapped(() => own)(payload, LISTED);
	assert.ok(fromHook !== own, "never the hook's own object");
	assert.deepEqual(fromHook, own);
	assert.deepEqual(await wrapped(undefined)(payload, LISTED), payload, "no hook at all: the payload's copy");
});

test("the payload check is deny by default: only the messages and the sampling knobs may change", async () => {
	const google = (model) => ({ model: model.id, contents: [{ role: "user", parts: [{ text: "hi" }] }], config: { temperature: 0.5, tools: [{ x: 1 }], abortSignal: new AbortController().signal } });
	const bedrockPayload = (model) => ({ modelId: model.id, messages: [{ role: "user", content: [{ image: { source: { bytes: new Uint8Array([1, 2, 3]) } } }] }], inferenceConfig: { maxTokens: 10 } });
	const pass = [
		["a no-op hook", undefined, (payload) => payload],
		["a temperature edit", undefined, (payload) => ({ ...payload, temperature: 0 })],
		["a messages edit in place", undefined, (payload) => void payload.messages.push({ role: "user", content: "more" })],
		["a sampling knob added", undefined, (payload) => ({ ...payload, max_tokens: 5, top_p: 0.9 })],
		// pi's payloads carry keys set to undefined, at the top and nested; a JSON clone drops them, and JSON drops
		// them on the wire too, so the bytes are the same.
		["a JSON clone of a payload with undefined keys", (model) => ({ model: model.id, messages: [], prompt_cache_key: undefined, additionalModelRequestFields: undefined, options: { a: 1, b: undefined }, config: { temperature: 0.5, thinkingConfig: undefined } }), (payload) => JSON.parse(JSON.stringify(payload))],
		["a key set to undefined by the hook where pi had none", undefined, (payload) => ({ ...payload, prompt_cache_key: undefined })],
		["a nested key set to undefined by the hook where pi had none", (model) => ({ model: model.id, messages: [], options: { a: 1 } }), (payload) => ({ ...payload, options: { a: 1, b: undefined } })],
		["google's config sampling fields", google, (payload) => ({ ...payload, config: { ...payload.config, temperature: 0, topP: 0.9, maxOutputTokens: 7 } })],
		["bedrock's bytes untouched", bedrockPayload, (payload) => ({ ...payload, messages: payload.messages })],
		["bytes outside the editable keys, copied but equal", (model) => ({ model: model.id, audio: new Uint8Array([1, 2, 3]) }), (payload) => ({ ...payload, audio: new Uint8Array([1, 2, 3]) })],
	];
	for (const [label, payloadOf, onPayload] of pass) {
		const { result, sent, meter } = await payloadCall({ onPayload }, payloadOf ? { payloadOf } : {});
		assert.equal(result.stopReason, "stop", `${label}: ${result.errorMessage}`);
		assert.deepEqual([sent.length, meter.state.stopReason], [1, null], label);
	}
	const refuse = [
		["a model rewrite", undefined, (payload) => ({ ...payload, model: "big-unlisted" })],
		["google's config.httpOptions (the URL path picks the model)", google, (payload) => ({ ...payload, config: { ...payload.config, httpOptions: { baseUrl: "http://x/models/UNLISTED:streamGenerateContent#" } } })],
		["another config field changed", google, (payload) => ({ ...payload, config: { ...payload.config, tools: [] } })],
		["a gateway's providerOptions added", undefined, (payload) => ({ ...payload, providerOptions: { gateway: { models: ["anthropic/claude-opus-5"] } } })],
		["an unknown key added", undefined, (payload) => ({ ...payload, route: "fallback" })],
		["a stored prompt reference added (openai-responses)", undefined, (payload) => ({ ...payload, prompt: { id: "pmpt_x" } })],
		["metadata added (a proxy can route on its tags)", undefined, (payload) => ({ ...payload, metadata: { tags: ["big"] } })],
		["a value given to a key pi left undefined", (model) => ({ model: model.id, messages: [], prompt_cache_key: undefined }), (payload) => ({ ...payload, prompt_cache_key: "elsewhere" })],
		["a setting kept below the top (bedrock's inferenceConfig)", (model) => ({ modelId: model.id, messages: [], inferenceConfig: { temperature: 1 } }), (payload) => ({ ...payload, inferenceConfig: { temperature: 0 } })],
		["a key pi set, cleared to undefined, is a removal only when it had a value", (model) => ({ model: model.id, messages: [], store: false }), (payload) => ({ ...payload, store: undefined })],
		["a key removed", undefined, ({ model, ...rest }) => (void model, rest)],
		["a nested change in place", google, (payload) => void (payload.config.tools[0].x = 2)],
		["bedrock's inferenceConfig changed", bedrockPayload, (payload) => ({ ...payload, messages: payload.messages, inferenceConfig: { maxTokens: 11 } })],
		["bytes changed outside the editable keys", (model) => ({ model: model.id, audio: new Uint8Array([1, 2, 3]) }), (payload) => ({ ...payload, audio: new Uint8Array([1, 2, 4]) })],
		["an array", undefined, (payload) => [payload]],
		["a class instance", undefined, (payload) => Object.assign(new (class Payload {})(), payload)],
	];
	for (const [label, payloadOf, onPayload] of refuse) {
		const { result, sent, meter, guard } = await payloadCall({ onPayload }, payloadOf ? { payloadOf } : {});
		assert.equal(result.errorMessage, "pi-dispatch: model not allowed", label);
		assert.deepEqual([sent, meter.state.stopReason, guard.snapshot().modelRefused], [[], MODEL_NOT_ALLOWED, 1], label);
	}
});

test("the caller's onPayload runs with the this pi gives it", async () => {
	const guard = createModelGuard({ allowedModels: LIST });
	let seenThis;
	const callerOptions = { onPayload() {
		seenThis = this;
	} };
	const wrapped = guard.prepare({ method: "streamSimple", args: [{}, callerOptions], stop: () => {} })[1];
	// pi calls it as a method of the options object the provider received.
	const providerOptions = { ...wrapped, apiKey: "k" };
	await providerOptions.onPayload({ model: "listed-1" }, LISTED);
	assert.equal(seenThis, providerOptions);
});

test("the payload check covers every door: classify and generateImages, the legacy compat half, and bedrock's modelId", async () => {
	for (const method of ["classify", "generateImages"]) {
		const { result, sent, meter } = await payloadCall({ onPayload: (payload) => ({ ...payload, model: "big-unlisted" }) }, { method });
		assert.equal(result.errorMessage, "pi-dispatch: model not allowed", method);
		assert.deepEqual([sent, meter.state.stopReason], [[], MODEL_NOT_ALLOWED], method);
	}
	// bedrock-converse-stream names the model as modelId.
	const bedrock = await payloadCall({ onPayload: (payload) => ({ ...payload, modelId: "big-unlisted" }) }, { payloadOf: (model) => ({ modelId: model.id, messages: [] }) });
	assert.deepEqual([bedrock.sent, bedrock.meter.state.stopReason], [[], MODEL_NOT_ALLOWED]);
	// A legacy compat call outside the runtime half's dispatch gets the same wrapper.
	const meter = createUsageMeter({ allowedModels: LIST });
	const sent = [];
	const inner = {
		streamSimple: (model, _context, options) => {
			const stream = new FakeStream();
			(async () => {
				try {
					const payload = { model: model.id };
					const next = await options?.onPayload?.(payload, model);
					sent.push((next ?? payload).model);
					stream.end(answer());
				} catch (error) {
					stream.end({ role: "assistant", stopReason: "error", errorMessage: error.message, content: [], usage: { cost: { total: 0 } } });
				}
			})();
			return stream;
		},
	};
	const compat = wrapProviderStreams({ inner, fallbackModels: null, meter, hardStop: makeHardStopStream({ createStream: () => new FakeStream() }), guard: createPolicyGuard({ allowedModels: LIST }), dispatch: new AsyncLocalStorage() });
	await compat.streamSimple(LISTED, {}, {}).result();
	const legacy = await compat.streamSimple(LISTED, {}, { onPayload: (payload) => ({ ...payload, model: "big-unlisted" }) }).result();
	assert.equal(legacy.errorMessage, "pi-dispatch: model not allowed");
	assert.deepEqual([sent, meter.state.stopReason], [["listed-1"], MODEL_NOT_ALLOWED]);
});

test("the compat half judges and dispatches one copy of the model too", async () => {
	const meter = createUsageMeter({ allowedModels: LIST });
	const reached = [];
	const compat = wrapProviderStreams({ inner: { streamSimple: (m) => (reached.push(m.id), Object.assign(new FakeStream(), {})) }, fallbackModels: null, meter, hardStop: makeHardStopStream({ createStream: () => new FakeStream() }), guard: createPolicyGuard({ allowedModels: LIST }) });
	let reads = 0;
	const shifty = { ...LISTED };
	Object.defineProperty(shifty, "id", { enumerable: true, get: () => (reads++ === 0 ? "listed-1" : "big-unlisted") });
	compat.streamSimple(shifty, {}, {});
	assert.deepEqual([reached, meter.state.stopReason], [["listed-1"], null]);
});

test("the model is read once: a getter cannot answer the guard with one id and the provider with another", async () => {
	const { runtime, calls, meter, layer } = wired();
	try {
		let reads = 0;
		const shifty = { ...LISTED };
		Object.defineProperty(shifty, "id", { enumerable: true, get: () => (reads++ === 0 ? "listed-1" : "big-unlisted") });
		await runtime.streamSimple(shifty, {}, {}).result();
		assert.deepEqual([calls, meter.state.stopReason], [["streamSimple:listed-1"], null], "judged and dispatched on the same copy");
	} finally {
		layer.restore();
	}
});

test("the policy guard hands an admitted call to the cost guard too: a cheap call under a cap settles at its metered cost", async () => {
	const { runtime, guard, layer } = wired({ maxCostMicros: 1_000_000_000, message: answer({ usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { total: 0.25 } } }) });
	try {
		await runtime.streamSimple(LISTED, {}, {}).result();
		await flush();
		assert.deepEqual([guard.cost.state.spent, guard.cost.state.inflight], [250_000, 0], "spent is the metered cost, and nothing is left in flight");
	} finally {
		layer.restore();
	}
});

// ── Installed: enforcement and the compat re-arm gap ─────────────────────────────────────────────────────

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
	const { FakeRuntime } = fakeRuntimeClass();
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
	handle.uninstall();
	return { handle, logged };
}

test("a list is enforceable once the model guard is installed; the fallback bus meter or no brake still refuses it", async () => {
	const meter = createUsageMeter({ allowedModels: LIST });
	const { handle } = await install({ copy: fakeCopy(["openai-completions"]), meter, guard: createPolicyGuard({ allowedModels: LIST }) });
	assert.deepEqual([handle.ok, handle.brake, [...handle.enforces]], [true, true, [MODEL_NOT_ALLOWED]]);
	assert.doesNotThrow(() => assertPoliciesEnforceable({ allowedModels: LIST, ...policyEnforcement(handle) }));
	const refuses = (facts) => assert.throws(() => assertPoliciesEnforceable({ allowedModels: LIST, ...facts }), (error) => error.piDispatchExit === EXIT_POLICY && error.piDispatchReason === MODEL_POLICY_UNENFORCEABLE);
	refuses(policyEnforcement({ ...handle, ok: false }));
	refuses(policyEnforcement({ ...handle, brake: false }));
	// A cost guard alone cannot pass for the list.
	const costOnly = await install({ copy: fakeCopy(["openai-completions"]), meter: createUsageMeter({ maxCostMicros: 5, allowedModels: LIST }), guard: createPolicyGuard({ maxCostMicros: 5 }) });
	refuses(policyEnforcement(costOnly.handle));
});

test("under a list alone, a displaced compat entry stops the job as model-not-allowed with modelRefused 0", async () => {
	const copy = fakeCopy(["anthropic-messages", "openai-completions"]);
	const stops = [];
	const meter = createUsageMeter({ allowedModels: LIST, onStop: (reason) => stops.push(reason) });
	const guard = createPolicyGuard({ allowedModels: LIST });
	const { handle, logged } = await install({ copy, meter, guard });
	handle.arm();
	assert.equal(meter.state.stopReason, null, "an idempotent re-arm displaced nothing");
	copy.reset();
	handle.arm();
	assert.deepEqual([meter.state.stopReason, stops, guard.snapshot()], [MODEL_NOT_ALLOWED, [MODEL_NOT_ALLOWED], { modelRefused: 0 }]);
	assert.deepEqual(logged.filter((entry) => entry.event === "model_guard_displaced").map((entry) => entry.fields), [{ apis: 2 }]);
	// Under a cap as well, the cap's stop wins as before, with costUnjudged as its evidence.
	const both = fakeCopy(["anthropic-messages"]);
	const capped = createUsageMeter({ maxCostMicros: 1000, allowedModels: LIST });
	const bothGuard = createPolicyGuard({ maxCostMicros: 1000, allowedModels: LIST });
	const second = await install({ copy: both, meter: capped, guard: bothGuard });
	both.reset();
	second.handle.arm();
	assert.deepEqual([capped.state.stopReason, bothGuard.snapshot().costUnjudged, bothGuard.snapshot().modelRefused], [COST_CAP, 1, 0]);
	assert.deepEqual(second.logged.filter((entry) => entry.event.endsWith("_displaced")).map((entry) => entry.event), ["cost_guard_displaced"]);
});
