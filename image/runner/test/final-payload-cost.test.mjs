import assert from "node:assert/strict";
import { test } from "node:test";
import { callCostBound, COST_WAIT, COST_WAIT_IDLE_MS, createCostGuard, createPolicyGuard, IMAGE_TOKEN_CEILINGS, WAIT_ABORTED_MESSAGE } from "../src/usage-meter.mjs";
import { COST_CAP } from "../src/outcome.mjs";
import { SONNET_4_5, GPT_5_4 } from "./helpers/catalog-models.mjs";

const context = { messages: [{ role: "user", content: "hello" }] };
const call = (model, options = {}) => ({ method: "streamSimple", model, args: [context, options] });
test("final serialized body growth is refused before the transport, using the same reservation", async () => {
	const original = callCostBound("streamSimple", SONNET_4_5, context, { maxTokens: 100 }, {});
	const guard = createCostGuard({ capMicros: original + 1000, env: {} });
	const request = call(SONNET_4_5, { maxTokens: 100, onPayload: (payload) => ({ ...payload, system: "x".repeat(100_000) }) });
	assert.equal(guard.admit(request), null);
	let reason = null;
	let sends = 0;
	const options = guard.prepare({ ...request, stop: (value) => { reason = value; } })[1];
	await assert.rejects(async () => { const body = await options.onPayload({ model: SONNET_4_5.id, max_tokens: 100, messages: [] }); JSON.stringify(body); sends += 1; });
	assert.equal(reason, COST_CAP);
	assert.equal(sends, 0);
	assert.equal(guard.spend().inflightMicros, original);
	guard.bind(undefined);
	assert.equal(guard.spend().inflightMicros, 0);
	assert.equal(guard.spend().spentMicros, original);
});
test("concurrent final payload reservations include other calls and never charge a ticket twice", async () => {
	const guard = createCostGuard({ capMicros: 300_000, env: {} });
	const request = call(SONNET_4_5, { maxTokens: 100 });
	assert.equal(guard.admit(request), null);
	const first = guard.prepare({ ...request, stop() {} })[1];
	let finish;
	guard.bind({ result: () => new Promise((resolve) => { finish = resolve; }) });
	assert.equal(guard.admit(request), null);
	const second = guard.prepare({ ...request, stop() {} })[1];
	guard.bind(new Promise(() => {}));
	await first.onPayload({ model: SONNET_4_5.id, max_tokens: 100, system: "a".repeat(50_000) });
	const held = guard.spend().inflightMicros;
	await assert.rejects(() => second.onPayload({ model: SONNET_4_5.id, max_tokens: 100, system: "b".repeat(50_000) }));
	assert.equal(guard.spend().inflightMicros, held);
	finish({ usage: { input: 1, output: 2, cost: { total: 0.00002 } }, stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(guard.spend().spentMicros, 20);
});
test("model and caller hooks run before the final cost check; permitted JSON is the measured JSON", async () => {
	const guard = createPolicyGuard({ maxCostMicros: 1_000_000, allowedModels: [{ provider: SONNET_4_5.provider, model: SONNET_4_5.id }], env: {} });
	const request = call(SONNET_4_5, { maxTokens: 100, cacheRetention: "long", onPayload: (payload) => { payload.system = "retained hard rule"; } });
	assert.equal(guard.admit(request), null);
	const options = guard.prepare({ ...request, stop() {} })[1];
	const body = await options.onPayload({ model: SONNET_4_5.id, max_tokens: 100, messages: [] });
	assert.equal(JSON.parse(JSON.stringify(body)).system, "retained hard rule");
	assert.ok(guard.spend().inflightMicros >= callCostBound("streamSimple", SONNET_4_5, context, request.args[1], {}, body));
});
test("ChatGPT omitted output limit stays bounded by catalog maximum after final shaping", async () => {
	const model = { ...GPT_5_4, baseUrl: "https://api.openai.com/v1" };
	const env = { OPENAI_API_KEY: "header.payload.signature" };
	const before = callCostBound("streamSimple", model, context, { maxTokens: 20 }, env);
	assert.ok(before > 0);
	const guard = createCostGuard({ capMicros: before + 100_000, env });
	const request = call(model, { maxTokens: 20 });
	assert.equal(guard.admit(request), null);
	const body = await guard.prepare({ ...request, stop() {} })[1].onPayload({ model: model.id, input: [] });
	assert.equal(body.max_output_tokens, undefined);
	assert.ok(guard.spend().inflightMicros >= before);
});

test("a final hook cannot remove or disable a local server's output cap", async () => {
	const model = { id: "local", provider: "local", api: "openai-completions", baseUrl: "http://localhost:1", maxTokens: 1000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, compat: { maxTokensField: "max_tokens" } };
	for (const disabled of [undefined, 0, -1, null]) {
		const guard = createCostGuard({ capMicros: 20_000, env: {} });
		const request = call(model, { maxTokens: 1 });
		assert.equal(guard.admit(request), null);
		const options = guard.prepare({ ...request, stop() {} })[1];
		await assert.rejects(() => options.onPayload({ model: model.id, max_tokens: disabled }));
		assert.equal(guard.refusedWhy(), "final-payload");
	}
});

test("final sampling multiplicity and one-hour cache writes are bounded from the wire", async () => {
	const model = { id: "hosted", provider: "openai", api: "openai-completions", baseUrl: "https://api.openai.com/v1", maxTokens: 1000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, compat: { maxTokensField: "max_tokens" } };
	const guard = createCostGuard({ capMicros: 20_000, env: {} });
	const request = call(model, { maxTokens: 1 });
	assert.equal(guard.admit(request), null);
	await assert.rejects(() => guard.prepare({ ...request, stop() {} })[1].onPayload({ model: model.id, max_tokens: 1, n: 100_000 }));
	const cached = createCostGuard({ capMicros: 100_000, env: {} });
	const cacheCall = call(SONNET_4_5, { maxTokens: 1, cacheRetention: "short" });
	assert.equal(cached.admit(cacheCall), null);
	const body = await cached.prepare({ ...cacheCall, stop() {} })[1].onPayload({ model: SONNET_4_5.id, max_tokens: 1, system: [{ type: "text", text: "cache", cache_control: { type: "ephemeral", ttl: "1h" } }] });
	const expected = callCostBound("streamSimple", SONNET_4_5, context, { maxTokens: 1, cacheRetention: "long" }, {}, body);
	assert.equal(cached.spend().inflightMicros, expected);
});

// ── Issue #985: the final bound is max(context, body), and a final payload that fits only later waits ─────────

const FLAT = Object.freeze({ id: "flat", api: "openai-completions", provider: "local", baseUrl: "http://127.0.0.1:1", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1000, compat: { maxTokensField: "max_tokens" } });
/** A value whose JSON is exactly `bytes` long. */
function ofBytes(bytes) {
	const value = { m: "x".repeat(bytes - 8) };
	assert.equal(Buffer.byteLength(JSON.stringify(value)), bytes);
	return value;
}
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value));
/** A provider stream the test settles by hand. */
function handStream() {
	let end;
	const settled = new Promise((resolve) => (end = resolve));
	return { stream: { result: () => settled }, end };
}
const answered = (cost) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { total: cost } } });
/** What pi's provider settles with when the request never went out (its catch around a throwing onPayload). */
const neverSent = { role: "assistant", stopReason: "error", content: [], errorMessage: "pi-dispatch: cost cap reached", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("issue #985: the final bound is the larger of the context's and the body's measure, never their sum", () => {
	const ctx = ofBytes(10_000);
	// FLAT: input 1 (the dearest input rate), output 2, 100 output tokens asked and sent as max_tokens.
	assert.equal(callCostBound("streamSimple", FLAT, ctx, { maxTokens: 100 }, {}), 10_000 + 8192 + 100 * 2, "no body: the context alone, as at admit");
	assert.equal(callCostBound("streamSimple", FLAT, ctx, { maxTokens: 100 }, {}, ofBytes(4_000)), 10_000 + 8192 + 100 * 2, "a body smaller than its context (a continued request) is bounded by the context");
	assert.equal(callCostBound("streamSimple", FLAT, ctx, { maxTokens: 100 }, {}, ofBytes(30_000)), 30_000 + 8192 + 100 * 2, "a larger body is bounded by itself, not by 40,000 bytes");
	// An image a hook added to the body counts at its api's ceiling, as an image in the context does.
	const image = { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } };
	const body = { messages: [{ role: "user", content: [image] }] };
	assert.equal(callCostBound("streamSimple", FLAT, { m: "" }, { maxTokens: 100 }, {}, body), bytesOf(body) + (IMAGE_TOKEN_CEILINGS["openai-completions"] - bytesOf(image)) + 8192 + 100 * 2);
	assert.equal(callCostBound("streamSimple", FLAT, ctx, { maxTokens: 100 }, {}, { n: 1n }), Infinity, "a body that does not serialise is unboundable");
});

test("issue #985: through the guard, a final payload's ticket grows to exactly the max(context, body) bound", { timeout: 10_000 }, async () => {
	const ctx = ofBytes(10_000);
	const request = { method: "streamSimple", model: FLAT, args: [ctx, { maxTokens: 100 }] };
	const atAdmit = 10_000 + 8192 + 200;
	const guard = createCostGuard({ capMicros: 1_000_000, env: {} });
	assert.equal(guard.admit(request), null);
	assert.equal(guard.spend().inflightMicros, atAdmit);
	const small = { model: "flat", max_tokens: 100, messages: [{ role: "user", content: "x" }] };
	await guard.prepare({ ...request, stop() {} })[1].onPayload(small);
	assert.equal(guard.spend().inflightMicros, atAdmit, "a body smaller than the context leaves the ticket as it was");
	const again = createCostGuard({ capMicros: 1_000_000, env: {} });
	assert.equal(again.admit(request), null);
	const large = { model: "flat", max_tokens: 100, messages: [{ role: "user", content: "y".repeat(30_000) }] };
	await again.prepare({ ...request, stop() {} })[1].onPayload(large);
	assert.equal(again.spend().inflightMicros, bytesOf(large) + 8192 + 200, "the body's measure alone, not the context's added to it");
});

/** Two calls on FLAT under `cap`: `other` admitted and in flight, then this one, waitable, with its final hook ready. */
function finalRace(cap) {
	const logged = [];
	const stops = [];
	const guard = createCostGuard({ capMicros: cap, env: {}, log: (event, fields) => logged.push({ event, fields }) });
	const within = (label) => assert.ok(guard.state.spent + guard.state.inflight <= cap, `${label}: ${guard.state.spent} + ${guard.state.inflight} > ${cap}`);
	const call = { method: "streamSimple", model: FLAT, args: [ofBytes(1_000), { maxTokens: 100 }], waitable: true, waiter: null };
	const other = handStream();
	assert.equal(guard.admit(call), null);
	guard.bind(other.stream);
	const mine = handStream();
	assert.equal(guard.admit(call), null);
	const options = guard.prepare({ ...call, stop: (reason) => stops.push(reason), stopped: () => null })[1];
	guard.bind(mine.stream);
	within("both admitted");
	return { guard, logged, stops, within, other, mine, options, admitBound: 1_000 + 8192 + 200 };
}

test("issue #985: a final payload that fits only once another hold settles releases its own, waits at the front holding nothing, and takes the larger hold back", { timeout: 10_000 }, async () => {
	const body = { model: "flat", max_tokens: 100, messages: [{ role: "user", content: "z".repeat(40_000) }] };
	const finalBound = bytesOf(body) + 8192 + 200;
	const { guard, logged, stops, within, other, options, admitBound } = finalRace(55_000);
	assert.ok(admitBound + finalBound > 55_000 && finalBound <= 55_000, "the premise: it fits once the other settles, not before");
	let sent = null;
	const sending = options.onPayload(body).then((value) => (sent = value));
	await flush();
	within("waiting");
	assert.equal(sent, null, "nothing is sent while it waits");
	assert.equal(guard.spend().inflightMicros, admitBound, "it released its own hold: only the other call's is held");
	assert.deepEqual(logged.map((entry) => entry.event), ["cost_wait"]);
	assert.equal(logged[0].fields.why, "final-payload");
	other.end(answered(0.00001)); // 10 micro-dollars
	await sending;
	within("retaken");
	assert.deepEqual(sent, body);
	assert.deepEqual([guard.state.spent, guard.state.inflight], [10, finalBound], "the larger hold, taken back");
	assert.deepEqual([stops, guard.state.refused, logged.at(-1).event], [[], 0, "cost_waited"]);
});

test("issue #985: a final payload whose wait can no longer help is refused final-payload, and its withheld request is not counted costUnanswered", { timeout: 10_000 }, async () => {
	const body = { model: "flat", max_tokens: 100, messages: [{ role: "user", content: "z".repeat(40_000) }] };
	const { guard, logged, stops, within, other, mine, options, admitBound } = finalRace(55_000);
	const sending = options.onPayload(body);
	sending.catch(() => {});
	await flush();
	// The other call STARTED and then failed: charged its bound, so no room appears.
	other.end({ ...answered(0), stopReason: "error" });
	await assert.rejects(sending, /cost cap reached/);
	within("refused");
	assert.deepEqual([guard.state.spent, guard.state.inflight, guard.refusedWhy(), stops], [admitBound, 0, "final-payload", ["cost-cap"]]);
	assert.equal(typeof logged.at(-1).fields.waited, "number", "its wait is on the refusal");
	// pi's provider ends the call it never sent: not started, and withheld, so not counted.
	mine.end(neverSent);
	await flush();
	assert.equal(guard.snapshot().costUnanswered, 0);
});

test("issue #985: any onPayload that throws withheld its request, so its settle is not counted costUnanswered; one that was sent and lost still is", { timeout: 10_000 }, async () => {
	const original = callCostBound("streamSimple", SONNET_4_5, context, { maxTokens: 100 }, {});
	for (const [label, hook] of [["a refused final payload", (payload) => ({ ...payload, system: "x".repeat(100_000) })], ["a caller's hook that threw", () => {
		throw new Error("hook refused");
	}]]) {
		const guard = createCostGuard({ capMicros: original + 1000, env: {} });
		const request = call(SONNET_4_5, { maxTokens: 100, onPayload: hook });
		assert.equal(guard.admit(request), null);
		const options = guard.prepare({ ...request, stop() {} })[1];
		const provider = handStream();
		guard.bind(provider.stream);
		await assert.rejects(options.onPayload({ model: SONNET_4_5.id, max_tokens: 100, messages: [] }), label);
		provider.end(neverSent);
		await flush();
		assert.equal(guard.snapshot().costUnanswered, 0, label);
		assert.ok(guard.state.spent + guard.state.inflight <= original + 1000, label);
	}
	const guard = createCostGuard({ capMicros: original + 1000, env: {} });
	const request = call(SONNET_4_5, { maxTokens: 100 });
	assert.equal(guard.admit(request), null);
	const options = guard.prepare({ ...request, stop() {} })[1];
	const provider = handStream();
	guard.bind(provider.stream);
	await options.onPayload({ model: SONNET_4_5.id, max_tokens: 100, messages: [] });
	provider.end({ ...neverSent, errorMessage: "429 rate limited" });
	await flush();
	assert.equal(guard.snapshot().costUnanswered, 1, "sent, then a 429: a provider may still bill it");
});

// ── Issue #985: every way out of a final payload's wait ─────────────────────────────────────────────────────
//
// Each test asserts the cap's invariant at every step (`within`): settled spend, plus what is held in flight, plus the
// outside spend, never passes the cap.

const LOCAL = Object.freeze({ id: "local", api: "openai-completions", provider: "local", baseUrl: "http://127.0.0.1:1" });

/** A guard whose bound is the model's `bound`, or the final body's `grow` when larger; an injected clock and timer. */
function finalWaitGuard({ cap, external = null, externalInflight = null, claim = null, outsideWaiting = null }) {
	const clock = { now: 0 };
	const timer = { run: null };
	const logged = [];
	const guard = createCostGuard({
		capMicros: cap,
		env: {},
		bound: (method, model, context, options, env, body) => (body === undefined ? model.bound : Math.max(model.bound, body.grow ?? 0)),
		external,
		externalInflight,
		claim,
		outsideWaiting,
		log: (event, fields) => logged.push({ event, fields }),
		now: () => clock.now,
		setTimer: (run) => ((timer.run = run), { unref() {} }),
		clearTimer: () => (timer.run = null),
	});
	const within = (label) => {
		const outside = external === null ? 0 : external();
		assert.ok(guard.state.spent + guard.state.inflight + outside <= cap, `${label}: spent ${guard.state.spent} + in flight ${guard.state.inflight} + outside ${outside} passed ${cap}`);
	};
	return { guard, clock, timer, logged, within };
}
const sizedCall = (bound, options = {}) => ({ method: "streamSimple", model: { ...LOCAL, bound }, args: [{}, options], waitable: true, waiter: null });
/** The body a provider builds: a positive max_tokens (a local server's must have one) and the size the bound reads. */
const grown = (grow) => ({ model: "local", max_tokens: 100, grow });
/** Track a promise's outcome without awaiting it: "pending", "sent" (resolved) or the rejection's message. */
function outcomeOf(promise) {
	const seen = { state: "pending" };
	promise.then(() => (seen.state = "sent"), (error) => (seen.state = error.message));
	return seen;
}

/** `other` (bound `otherBound`) admitted and in flight, then this call (bound `mineBound`, waitable) prepared and bound. */
function finalWaitRace(g, { otherBound, mineBound, options = {}, stopped = () => null, bindMine = true }) {
	const other = handStream();
	assert.equal(g.guard.admit({ ...sizedCall(otherBound), waitable: false }), null);
	g.guard.bind(other.stream);
	const mine = handStream();
	const request = sizedCall(mineBound, options);
	assert.equal(g.guard.admit(request), null);
	const stops = [];
	const prepared = g.guard.prepare({ ...request, stop: (reason) => stops.push(reason), stopped })[1];
	if (bindMine) g.guard.bind(mine.stream);
	return { other, mine, prepared, stops };
}

test("issue #985: a final payload's retake counts the outside spend that rose while it waited", { timeout: 10_000 }, async () => {
	let outside = 0;
	const g = finalWaitGuard({ cap: 1000, external: () => outside });
	const { other, prepared, stops } = finalWaitRace(g, { otherBound: 400, mineBound: 300 });
	const sending = outcomeOf(prepared.onPayload(grown(700))); // 400 + 700 > 1000; 700 fits once the other settles
	await flush();
	g.within("waiting, holding nothing");
	assert.equal(g.guard.state.inflight, 400);
	outside = 400; // a child spent meanwhile, within the cap: 0 + 400 + 400 <= 1000
	g.within("the outside spend rose");
	other.end(answered(0.00005)); // 50 micro-dollars
	await flush();
	g.within("after the other settled");
	assert.equal(sending.state, "pi-dispatch: cost cap reached", "50 + 400 + 700 > 1000: no retake, and waiting can no longer help");
	assert.deepEqual([g.guard.state.inflight, g.guard.refusedWhy(), stops], [0, "final-payload", ["cost-cap"]]);
});

test("issue #985: a final payload refused only by holds in another process releases its own, waits, and takes the larger hold back once they settle there", { timeout: 10_000 }, async () => {
	let outside = 500; // all of it in flight in another process (a sibling child, or the parent)
	let inflight = 500;
	const g = finalWaitGuard({ cap: 1000, external: () => outside, externalInflight: () => inflight });
	const mine = handStream();
	const request = sizedCall(300);
	assert.equal(g.guard.admit(request), null, "0 + 0 + 500 + 300 <= 1000");
	const stops = [];
	const prepared = g.guard.prepare({ ...request, stop: (reason) => stops.push(reason), stopped: () => null })[1];
	g.guard.bind(mine.stream);
	const sending = outcomeOf(prepared.onPayload(grown(700))); // 0 + 500 + 700 > 1000; 0 + 0 + 700 <= 1000 once the 500 settles
	await flush();
	g.within("waiting, holding nothing");
	assert.deepEqual([sending.state, g.guard.state.inflight], ["pending", 0], "its 300 given back while it waits");
	assert.deepEqual(g.logged.at(-1), { event: "cost_wait", fields: { why: "final-payload", bound: 700, spent: 0, inflight: 0, external: 500, externalInflight: 500, cap: 1000, waiting: 0 } });
	g.timer.run();
	await flush();
	assert.equal(sending.state, "pending", "nothing settled elsewhere yet");
	outside = 100; // settled there at 100
	inflight = 0;
	g.timer.run();
	await flush();
	g.within("retaken");
	assert.deepEqual([sending.state, g.guard.state.inflight, stops], ["sent", 700, []], "0 + 0 + 100 + 700 <= 1000");
});

test("issue #985: a final payload that waited takes its larger hold back only with the wait claim", { timeout: 10_000 }, async () => {
	let won = false;
	const g = finalWaitGuard({ cap: 1000, claim: () => won });
	const { other, prepared, stops } = finalWaitRace(g, { otherBound: 400, mineBound: 300 });
	const sending = outcomeOf(prepared.onPayload(grown(700))); // 400 + 700 > 1000; it fits once the other settles
	await flush();
	other.end(answered(0.00005));
	await flush();
	g.within("fits, claim lost");
	assert.deepEqual([sending.state, g.guard.state.inflight], ["pending", 0], "not retaken without the claim");
	won = true;
	g.timer.run();
	await flush();
	g.within("claimed");
	assert.deepEqual([sending.state, g.guard.state.inflight, stops], ["sent", 700, []]);
});

test("issue #985: while another process waits, a final payload that GROWS takes its turn for the growth; without it, it waits at the front and grows in its turn", { timeout: 10_000 }, async () => {
	let won = false;
	const g = finalWaitGuard({ cap: 1000, external: () => 0, externalInflight: () => 0, claim: () => won, outsideWaiting: () => true });
	const mine = handStream();
	const request = sizedCall(300);
	won = true;
	assert.equal(g.guard.admit(request), null, "admitted in its turn");
	won = false;
	const prepared = g.guard.prepare({ ...request, stop: () => {}, stopped: () => null })[1];
	g.guard.bind(mine.stream);
	const same = outcomeOf(prepared.onPayload(grown(300)));
	await flush();
	assert.equal(same.state, "sent", "a final payload that does not grow takes nothing more, so no turn");
	const second = handStream();
	won = true;
	const request2 = sizedCall(200);
	assert.equal(g.guard.admit(request2), null);
	won = false;
	const prepared2 = g.guard.prepare({ ...request2, stop: () => {}, stopped: () => null })[1];
	g.guard.bind(second.stream);
	const growing = outcomeOf(prepared2.onPayload(grown(400))); // 300 + 400 <= 1000 fits, but the growth is an admission
	await flush();
	g.within("growth without its turn");
	assert.deepEqual([growing.state, g.guard.state.inflight], ["pending", 300], "its 200 given back; it waits at the front");
	assert.equal(g.logged.at(-1).fields.why, "turn");
	won = true;
	g.timer.run();
	await flush();
	g.within("grown in its turn");
	assert.deepEqual([growing.state, g.guard.state.inflight], ["sent", 700]);
});

test("issue #985: while anyone waits, a growing final payload that may not wait and has no turn is refused under the rule turn; an aborted one gives up unsent, refusing nothing", { timeout: 10_000 }, async () => {
	for (const aborted of [false, true]) {
		let won = true;
		const g = finalWaitGuard({ cap: 1000, external: () => 0, externalInflight: () => 0, claim: () => won, outsideWaiting: () => true });
		const controller = new AbortController();
		const request = { ...sizedCall(200, aborted ? { signal: controller.signal } : {}), waitable: false };
		assert.equal(g.guard.admit(request), null, "admitted in its turn");
		won = false;
		const stops = [];
		const prepared = g.guard.prepare({ ...request, stop: (reason) => stops.push(reason), stopped: () => null })[1];
		g.guard.bind(handStream().stream);
		if (aborted) controller.abort();
		const sending = outcomeOf(prepared.onPayload(grown(400))); // 400 fits, but the growth has no turn
		await flush();
		g.within(aborted ? "aborted" : "refused");
		if (aborted) assert.deepEqual([sending.state, g.guard.state.refused, stops, g.guard.state.inflight], [WAIT_ABORTED_MESSAGE, 0, [], 200], "unsent, its 200 held to its settle");
		else assert.deepEqual([sending.state, g.guard.refusedWhy(), stops, g.guard.state.inflight], ["pi-dispatch: cost cap reached", "turn", ["cost-cap"], 200], "never grown without its turn, refused under the rule turn");
	}
});

test("issue #985: a final payload whose job stopped while it waited ends with that stop and is never sent", { timeout: 10_000 }, async () => {
	let stopReason = null;
	const g = finalWaitGuard({ cap: 1000 });
	const { other, prepared } = finalWaitRace(g, { otherBound: 400, mineBound: 300, stopped: () => stopReason });
	const sending = outcomeOf(prepared.onPayload(grown(700)));
	await flush();
	stopReason = "token_budget";
	other.end(answered(0.00005));
	await flush();
	g.within("after the stop");
	assert.equal(sending.state, "pi-dispatch: token cap exceeded", "room appeared, but the job had stopped");
	assert.deepEqual([g.guard.state.inflight, g.guard.state.refused, g.logged.some((entry) => entry.event === "cost_waited")], [0, 0, false], "not retaken, and no refusal of its own");
});

test("issue #985: a final payload whose call aborts while it waits ends at once, and is not sent when room appears", { timeout: 10_000 }, async () => {
	const g = finalWaitGuard({ cap: 1000 });
	const controller = new AbortController();
	const { other, prepared } = finalWaitRace(g, { otherBound: 400, mineBound: 300, options: { signal: controller.signal } });
	const sending = outcomeOf(prepared.onPayload(grown(700)));
	await flush();
	assert.equal(sending.state, "pending");
	controller.abort();
	await flush();
	g.within("aborted");
	assert.equal(sending.state, WAIT_ABORTED_MESSAGE);
	assert.equal(g.timer.run, null, "off the queue");
	other.end(answered(0.00005));
	await flush();
	g.within("after the other settled");
	assert.deepEqual([sending.state, g.guard.state.inflight], [WAIT_ABORTED_MESSAGE, 0], "never retaken");
});

test("issue #985: a final payload whose signal is already aborted never waits, so it holds no place at the front of the queue", { timeout: 10_000 }, async () => {
	const g = finalWaitGuard({ cap: 1000 });
	const controller = new AbortController();
	controller.abort();
	const { prepared } = finalWaitRace(g, { otherBound: 400, mineBound: 300, options: { signal: controller.signal } });
	const sending = outcomeOf(prepared.onPayload(grown(700)));
	await flush();
	g.within("ended");
	assert.equal(sending.state, WAIT_ABORTED_MESSAGE);
	assert.deepEqual([g.timer.run, g.guard.state.waited], [null, 0]);
	assert.deepEqual(g.logged.filter((entry) => entry.event === "cost_wait"), [], "a call that never waits logs no wait");
	assert.equal(g.guard.state.inflight, 700, "and keeps its hold until its provider ends it, as a refused call does");
	assert.equal(g.guard.admit({ ...sizedCall(400), waitable: false }), COST_CAP, "0 + 700 + 400 > 1000: the hold is still counted");
	g.within("a new call admitted");
});

test("issue #985: a final payload whose ticket was settled while it waited is refused, never retaken", { timeout: 10_000 }, async () => {
	const g = finalWaitGuard({ cap: 1000 });
	// The hook runs during the dispatch, before the bind (a provider that calls it synchronously), and waits.
	const { other, prepared, stops } = finalWaitRace(g, { otherBound: 400, mineBound: 300, bindMine: false });
	const sending = outcomeOf(prepared.onPayload(grown(700)));
	g.within("waiting");
	// The next admission flushes the slot the dispatch never bound: the ticket settles while its hook waits.
	assert.equal(g.guard.admit({ ...sizedCall(100), waitable: false }), null);
	g.guard.bind(handStream().stream);
	g.within("the slot flushed");
	other.end(answered(0.00005));
	await flush();
	g.within("after the other settled");
	assert.equal(sending.state, "pi-dispatch: cost cap reached");
	assert.deepEqual([g.guard.state.inflight, g.guard.refusedWhy(), stops], [100, "final-payload", ["cost-cap"]], "only the third call is held: nothing taken for a settled ticket");
});

test("issue #985: a final payload that waits COST_WAIT_IDLE_MS with no progress is refused final-payload", { timeout: 10_000 }, async () => {
	const g = finalWaitGuard({ cap: 1000 });
	const { prepared, stops } = finalWaitRace(g, { otherBound: 400, mineBound: 300 }); // the other call never settles
	const sending = outcomeOf(prepared.onPayload(grown(700)));
	await flush();
	g.clock.now = COST_WAIT_IDLE_MS - 1;
	g.timer.run();
	await flush();
	assert.equal(sending.state, "pending", "just under the limit");
	g.clock.now = COST_WAIT_IDLE_MS;
	g.timer.run();
	await flush();
	g.within("refused");
	assert.equal(sending.state, "pi-dispatch: cost cap reached");
	assert.deepEqual([g.guard.refusedWhy(), stops, g.logged.at(-1).fields.waited], ["final-payload", ["cost-cap"], COST_WAIT_IDLE_MS]);
	assert.equal(g.timer.run, null);
});

/** A waitable call queued the way the wrappers queue one; `verdicts` holds each retry's answer. */
function queuedCall(guard, bound) {
	const entry = { verdicts: [], stream: handStream(), waiter: null };
	assert.equal(guard.admit(sizedCall(bound)), COST_WAIT);
	entry.waiter = guard.wait(() => {
		const verdict = guard.admit({ ...sizedCall(bound), waiter: entry.waiter });
		entry.verdicts.push(verdict);
		if (verdict === COST_WAIT) return;
		if (verdict === null) guard.bind(entry.stream.stream);
		guard.leave(entry.waiter);
	});
	return entry;
}

test("issue #985: a final payload waits at the FRONT of the queue, ahead of calls that queued before it", { timeout: 10_000 }, async () => {
	const g = finalWaitGuard({ cap: 1000 });
	const { other, prepared } = finalWaitRace(g, { otherBound: 600, mineBound: 300 });
	const earlier = queuedCall(g.guard, 300); // 0 + 900 + 300 > 1000: it waits
	const sending = outcomeOf(prepared.onPayload(grown(700))); // 600 + 700 > 1000: release, and wait
	await flush();
	g.within("both waiting");
	other.end(answered(0.0001)); // 100: room for 700 or for 300, not for both
	await flush();
	g.within("after the settle");
	assert.equal(sending.state, "sent", "the admitted call's final payload goes first: 100 + 700 <= 1000");
	assert.ok(earlier.verdicts.length > 0 && earlier.verdicts.every((verdict) => verdict === COST_WAIT), `the earlier waiter waits on, 100 + 700 + 300 > 1000: ${earlier.verdicts.map(String).join(",")}`);
	assert.equal(g.guard.state.waited, 2, "two calls waited");
});

test("issue #985: a call that waited at admission and again at its final payload counts once in waited", { timeout: 10_000 }, async () => {
	const g = finalWaitGuard({ cap: 1000 });
	const first = handStream();
	assert.equal(g.guard.admit({ ...sizedCall(600), waitable: false }), null);
	g.guard.bind(first.stream);
	// This call waits at admission (0 + 600 + 500 > 1000), and is prepared and bound when its retry admits it.
	const request = sizedCall(500);
	assert.equal(g.guard.admit(request), COST_WAIT);
	let prepared = null;
	const waiter = g.guard.wait(() => {
		if (g.guard.admit({ ...request, waiter }) !== null) return;
		prepared = g.guard.prepare({ ...request, stop() {}, stopped: () => null })[1];
		g.guard.bind(handStream().stream);
		g.guard.leave(waiter);
	});
	first.end(answered(0.0001)); // 100: 100 + 500 <= 1000, admitted
	await flush();
	assert.ok(prepared, "admitted after its wait");
	const second = handStream();
	assert.equal(g.guard.admit({ ...sizedCall(300), waitable: false }), null); // 100 + 500 + 300 <= 1000
	g.guard.bind(second.stream);
	g.within("both in flight");
	const sending = outcomeOf(prepared.onPayload(grown(700))); // 100 + 300 + 700 > 1000: it waits again
	await flush();
	g.within("waiting again");
	assert.equal(g.logged.filter((entry) => entry.event === "cost_wait").length, 2, "it waited twice");
	assert.equal(g.guard.state.waited, 1, "one call");
	second.end(answered(0.0001));
	await flush();
	g.within("retaken");
	assert.deepEqual([sending.state, g.guard.state.waited, g.guard.state.inflight], ["sent", 1, 700]);
});

test("issue #985: a request already sent stays counted costUnanswered when a later onPayload call for it throws", { timeout: 10_000 }, async () => {
	// A provider may call the hook again for one request (bedrock rebuilds its body after a strict-tool refusal). Once a
	// body was returned, it may have gone out, so a later throw does not withhold the call.
	let calls = 0;
	const guard = createCostGuard({ capMicros: 1_000_000, env: {} });
	const request = call(SONNET_4_5, { maxTokens: 100, onPayload: (payload) => {
		calls += 1;
		if (calls === 2) throw new Error("hook refused the second body");
		return payload;
	} });
	assert.equal(guard.admit(request), null);
	const options = guard.prepare({ ...request, stop() {} })[1];
	const provider = handStream();
	guard.bind(provider.stream);
	await options.onPayload({ model: SONNET_4_5.id, max_tokens: 100, messages: [] });
	await assert.rejects(options.onPayload({ model: SONNET_4_5.id, max_tokens: 100, messages: [] }), /second body/);
	provider.end(neverSent);
	await flush();
	assert.equal(guard.snapshot().costUnanswered, 1);
	assert.ok(guard.state.spent + guard.state.inflight <= 1_000_000);
});
