import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { callCostBound, COST_WAIT, COST_WAIT_IDLE_MS, createCostGuard, createPolicyGuard, IMAGE_TOKEN_CEILINGS, PRICED_APIS, resolvePiAiCompat, WAIT_ABORTED_MESSAGE } from "../src/usage-meter.mjs";
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

// ── Issues #1067 and #1059: the final payload's copy, and the cap a mistral body sends ─────────────────────

/** A Google model at the payload level (no transport), for the one place a body may carry a signal. */
const GEMINI = Object.freeze({ id: "gemini-probe", api: "google-generative-ai", provider: "google", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 });
/**
 * Two objects Node's AbortSignal `aborted` getter takes for a signal, since it only looks for a symbol a real signal
 * carries as its own: a real signal given another prototype, and an object given a real signal's own symbols. Each
 * one's toJSON answers a short text the first time and `long` characters after, so the bound and the wire would differ.
 */
function forgedSignals(long = 100_000) {
	let reads = 0;
	const twoFaced = () => (reads++ === 0 ? "hi" : "x".repeat(long));
	const swapped = new AbortController().signal;
	Object.setPrototypeOf(swapped, Object.create(AbortSignal.prototype, { toJSON: { value: twoFaced } }));
	const source = new AbortController().signal;
	const lookalike = Object.create({ toJSON: twoFaced });
	for (const symbol of Object.getOwnPropertySymbols(source)) lookalike[symbol] = source[symbol];
	return { swapped, lookalike };
}
/** What the guard hands on for `body` (or its refusal), and the body its bound read. */
async function finalPayload(body, model = SONNET_4_5) {
	let measured;
	const guard = createCostGuard({ capMicros: 1_000_000, env: {}, bound: (...args) => {
		if (args[5] !== undefined) measured = args[5];
		return callCostBound(...args);
	} });
	const request = call(model, { maxTokens: 100 });
	assert.equal(guard.admit(request), null);
	const stopped = [];
	const options = guard.prepare({ ...request, stop: (reason) => stopped.push(reason) })[1];
	try {
		return { handed: await options.onPayload(body), measured, guard };
	} catch (error) {
		return { refused: error, stopped, guard };
	}
}

test("issue #1067: the final payload's copy reads values as JSON did, keeps google's signal at config.abortSignal only, copies bytes, and refuses what it cannot bound", async () => {
	const base = { model: SONNET_4_5.id, max_tokens: 100, messages: [{ role: "user", content: "hi" }] };
	// Read as JSON reads them, so the body measured is the body sent: undefined keys left out, undefined array entries
	// and numbers that are not finite sent as null. The bound measures the very object handed on, and its JSON is the
	// old clone's.
	const loose = { ...base, skipped: undefined, temperature: Number.NaN, list: [undefined, Number.POSITIVE_INFINITY, 0, 1] };
	const read = await finalPayload(loose);
	assert.equal(read.measured, read.handed, "the bound read the object handed on");
	assert.notEqual(read.handed, loose, "never the hook's object");
	assert.equal(Object.hasOwn(read.handed, "skipped"), false);
	assert.deepEqual([read.handed.temperature, read.handed.list], [null, [null, null, 0, 1]]);
	assert.equal(JSON.stringify(read.handed), JSON.stringify(loose), "what the old JSON clone measured and sent");
	// A shared reference is no cycle (JSON writes it twice), and an own `__proto__` key stays a key.
	const shared = { text: "same" };
	const twice = await finalPayload({ ...base, a: shared, b: shared });
	assert.deepEqual([twice.handed.a, twice.handed.b], [shared, shared]);
	assert.notEqual(twice.handed.a, shared);
	const keyed = await finalPayload({ ...base, tool: JSON.parse('{"__proto__": {"x": 1}}') });
	assert.deepEqual([Object.hasOwn(keyed.handed.tool, "__proto__"), Object.getPrototypeOf(keyed.handed.tool) === Object.prototype], [true, true]);
	// A hook that keeps its object and changes it after the check changes nothing that is sent.
	const kept = { ...base, messages: [{ role: "user", content: "checked" }] };
	const after = await finalPayload(kept);
	kept.messages.push({ role: "user", content: "x".repeat(100_000) });
	assert.deepEqual(after.handed.messages, [{ role: "user", content: "checked" }]);
	// Bytes copied into a new array of the same kind.
	const bytes = new Uint8Array([137, 80, 78, 71]);
	const buffer = Buffer.from([1, 2, 3]);
	const special = await finalPayload({ ...base, image: { bytes, buffer } });
	const { bytes: copied, buffer: copiedBuffer } = special.handed.image;
	assert.deepEqual([Object.getPrototypeOf(copied) === Uint8Array.prototype, [...copied], copied === bytes], [true, [137, 80, 78, 71], false]);
	assert.deepEqual([Buffer.isBuffer(copiedBuffer), [...copiedBuffer], copiedBuffer === buffer], [true, [1, 2, 3], false]);
	bytes[0] = 0;
	assert.equal(copied[0], 137, "a copy, not a view");
	assert.equal(JSON.stringify(special.measured), JSON.stringify({ ...base, image: { bytes: new Uint8Array([137, 80, 78, 71]), buffer } }), "measured as the old clone measured: bytes as numbers");
	// The call's signal by reference, live, at google's `config.abortSignal`, the one place it is kept.
	const google = { model: GEMINI.id, contents: [{ role: "user", parts: [{ text: "hi" }] }], config: { maxOutputTokens: 100, automaticContinuation: false } };
	const controller = new AbortController();
	const live = await finalPayload({ ...google, config: { ...google.config, abortSignal: controller.signal } }, GEMINI);
	assert.equal(live.handed.config.abortSignal, controller.signal, "the call's own signal");
	assert.equal(live.measured, live.handed);
	// Everything else that is not plain data: unboundable, refused like any final payload that cannot be bounded.
	const cycle = { ...base };
	cycle.self = cycle;
	const real = () => new AbortController().signal;
	const proxied = new Proxy(real(), {});
	const marked = real();
	marked.extra = "x";
	const { swapped, lookalike } = forgedSignals();
	const atConfig = (abortSignal) => [{ ...google, config: { ...google.config, abortSignal } }, GEMINI];
	for (const [label, body, model] of [
		["an own toJSON", { ...base, toJSON: () => ({}) }],
		["a function", { ...base, tools: [{ run() {} }] }],
		["a Date", { ...base, metadata: { at: new Date(0) } }],
		["a Map", { ...base, metadata: new Map() }],
		["a class instance", { ...base, metadata: new (class Box {})() }],
		["a cycle", cycle],
		["a DataView", { ...base, image: new DataView(new ArrayBuffer(4)) }],
		["another typed array", { ...base, image: new Float64Array(4) }],
		["a symbol", { ...base, tag: Symbol("x") }],
		["a bigint", { ...base, seed: 1n }],
		["an array as the body", [base]],
		["something posing as a signal at google's config.abortSignal", ...atConfig(Object.create(AbortSignal.prototype))],
		["a Proxy of a signal at google's config.abortSignal", ...atConfig(proxied)],
		["a signal with a key of its own at google's config.abortSignal", ...atConfig(marked)],
		["a real signal with a swapped prototype at google's config.abortSignal", ...atConfig(swapped)],
		["an object given a real signal's own symbols at google's config.abortSignal", ...atConfig(lookalike)],
		["a real signal with a swapped prototype in a message", { ...base, messages: [{ role: "user", content: swapped }] }],
		["an object given a real signal's own symbols in a message", { ...base, messages: [{ role: "user", content: lookalike }] }],
		["a real signal at the top of a Google body", { ...google, abortSignal: real() }, GEMINI],
		["a real signal at another key of google's config", { ...google, config: { ...google.config, timeoutSignal: real() } }, GEMINI],
		["a real signal in a Google body's contents", { ...google, contents: [{ role: "user", parts: [{ text: "hi", signal: real() }] }] }, GEMINI],
		["a real signal in a nested config of a Google body", { ...google, contents: [{ role: "user", parts: [{ text: "hi" }], config: { abortSignal: real() } }] }, GEMINI],
		["a real signal at config.abortSignal of another api's body", { ...base, config: { abortSignal: real() } }],
		["a real signal in another api's message", { ...base, messages: [{ role: "user", content: real() }] }],
	]) {
		const outcome = await finalPayload(body, model);
		assert.ok(outcome.refused, `${label}: refused`);
		assert.deepEqual([outcome.guard.refusedWhy(), outcome.stopped], ["final-payload", [COST_CAP]], label);
	}
});

test("issue #1059: only mistral-conversations reads a camelCase maxTokens; on another api a hook's maxTokens beside max_tokens leaves the bound at max_tokens, the cap sent", async () => {
	// anthropic-messages sends `max_tokens` and carries any other key as it is: a hook's `maxTokens: 10` caps nothing.
	const body = { model: SONNET_4_5.id, max_tokens: 50_000, maxTokens: 10, messages: [{ role: "user", content: "hi" }] };
	const outcome = await finalPayload(body);
	assert.equal(outcome.refused, undefined);
	assert.equal(outcome.guard.spend().inflightMicros, callCostBound("streamSimple", SONNET_4_5, context, { maxTokens: 50_000 }, {}, outcome.measured), "held at the max_tokens sent");
	assert.ok(outcome.guard.spend().inflightMicros > callCostBound("streamSimple", SONNET_4_5, context, { maxTokens: 10 }, {}, outcome.measured));
});

// The tests below send real calls through pi-ai's own api modules, the copy the runner meters, over a stub transport
// or a loopback server: no provider, no key, no outside connection.
const piAiCompat = resolvePiAiCompat()[0]?.url ?? null;
if (!piAiCompat && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error("pi-ai must be installed here; a skip would hide what its api modules put in a body");
const skip = piAiCompat ? false : "pi-ai not installed; CI runs these";
const piApi = (api) => import(new URL(`./api/${api}.js`, piAiCompat).href);
const FAKE_KEY = "sk-test-final-payload";
const GOOGLE_APIS = ["google-generative-ai", "google-vertex"];
const piModel = (api, fields) => ({ name: fields.id, api, reasoning: false, input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000, ...fields });
const googleModel = (api, url) => piModel(api, { id: "gemini-probe", provider: api === "google-vertex" ? "google-vertex" : "google", baseUrl: `${url}/${api === "google-vertex" ? "v1" : "v1beta"}` });
const piContext = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

/** Admit, prepare and dispatch one streamSimple call through `guard` on pi's own module for the model's api. */
async function sendThrough(guard, model, options, stopped = []) {
	const request = { method: "streamSimple", model, args: [piContext, options] };
	assert.equal(guard.admit(request), null);
	const args = guard.prepare({ ...request, stop: (reason) => stopped.push(reason) });
	const stream = (await piApi(model.api)).streamSimple(model, args[0], args[1]);
	guard.bind(stream);
	return stream;
}

/** A loopback Gemini endpoint: each request gets one text chunk, then the end of the stream or, held, nothing more until the client goes. */
async function geminiServer() {
	const requests = [];
	const arrivals = [];
	let hold = false;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const seen = { body: JSON.parse(body) };
			seen.closed = new Promise((resolve) => res.on("close", resolve));
			requests.push(seen);
			arrivals.shift()?.();
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (finishReason) => `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, ...(finishReason ? { finishReason } : {}) }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } })}\r\n\r\n`;
			if (hold) res.write(chunk());
			else res.end(chunk("STOP"));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		requests,
		url: `http://127.0.0.1:${server.address().port}`,
		hold: (value) => (hold = value),
		arrival: () => new Promise((resolve) => arrivals.push(resolve)),
		close: () => {
			server.closeAllConnections();
			return new Promise((resolve) => server.close(resolve));
		},
	};
}

test("issue #1067: a Google call under a $50 cap is sent with its signal live and answered, and aborting the signal ends it (google-generative-ai, google-vertex)", { skip, timeout: 30_000 }, async () => {
	const server = await geminiServer();
	try {
		for (const api of GOOGLE_APIS) {
			const model = googleModel(api, server.url);
			const guards = [["a cap", () => createCostGuard({ capMicros: 50_000_000, env: {} })], ["a cap and a model list", () => createPolicyGuard({ maxCostMicros: 50_000_000, allowedModels: [{ provider: model.provider, model: model.id }], env: {} })]];
			for (const [label, makeGuard] of guards) {
				const where = `${api} under ${label}`;
				server.hold(false);
				const sent = server.requests.length;
				const answered = await (await sendThrough(makeGuard(), model, { apiKey: FAKE_KEY, maxTokens: 100, signal: new AbortController().signal })).result();
				assert.deepEqual([answered.stopReason, answered.errorMessage, answered.content.map((block) => block.text)], ["stop", undefined, ["ok"]], `${where}: answered`);
				assert.equal(server.requests.length, sent + 1, `${where}: one request`);
				assert.equal(server.requests.at(-1).body.generationConfig.maxOutputTokens, 100, `${where}: with the cap the bound read`);
				// The signal pi put in the body is the one @google/genai listens on: aborting it ends the call, and the
				// request it made goes with it.
				server.hold(true);
				const controller = new AbortController();
				const arrived = server.arrival();
				const held = await sendThrough(makeGuard(), model, { apiKey: FAKE_KEY, maxTokens: 100, signal: controller.signal });
				await arrived;
				controller.abort();
				const aborted = await held.result();
				assert.equal(aborted.stopReason, "aborted", `${where}: aborted`);
				await server.requests.at(-1).closed;
			}
		}
	} finally {
		await server.close();
	}
});

test("issue #1067: under a cap, a Google body is refused before anything is sent when a hook leaves automatic continuation unset or on, or puts anything but the call's real signal at config.abortSignal", { skip, timeout: 30_000 }, async () => {
	const server = await geminiServer();
	try {
		for (const api of GOOGLE_APIS) {
			const model = googleModel(api, server.url);
			for (const [label, hook, sends] of [
				["config rebuilt without the key", (payload) => {
					const { automaticContinuation, ...config } = payload.config;
					return { ...payload, config };
				}, false],
				["the key turned on", (payload) => ({ ...payload, config: { ...payload.config, automaticContinuation: true } }), false],
				["no config at all", ({ config, ...payload }) => payload, false],
				["config rebuilt with the key kept", (payload) => ({ ...payload, config: { ...payload.config } }), true],
				// The signal is kept only at config.abortSignal, and only a real one: never anything Node's getter merely accepts.
				["the call's signal swapped for a real signal with another prototype", (payload) => ({ ...payload, config: { ...payload.config, abortSignal: forgedSignals().swapped } }), false],
				["the call's signal swapped for an object given a real signal's own symbols", (payload) => ({ ...payload, config: { ...payload.config, abortSignal: forgedSignals().lookalike } }), false],
				["the call's signal also at the top of the body", (payload) => ({ ...payload, abortSignal: payload.config.abortSignal }), false],
			]) {
				const where = `${api}, ${label}`;
				const guard = createCostGuard({ capMicros: 50_000_000, env: {} });
				const stopped = [];
				const sent = server.requests.length;
				const result = await (await sendThrough(guard, model, { apiKey: FAKE_KEY, maxTokens: 100, signal: new AbortController().signal, onPayload: hook }, stopped)).result();
				assert.equal(server.requests.length, sent + (sends ? 1 : 0), `${where}: ${sends ? "sent" : "nothing sent"}`);
				if (sends) {
					assert.equal(result.stopReason, "stop", where);
					continue;
				}
				assert.equal(result.stopReason, "error", where);
				assert.deepEqual([guard.refusedWhy(), stopped], ["final-payload", [COST_CAP]], where);
			}
		}
	} finally {
		await server.close();
	}
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
const codexKey = () => {
	const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "none" })}.${part({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })}.sig`;
};
/** One call per priced api, as pi builds it; the three classifier apis classify (no output is priced). Hosts are loopback, never reached. */
const PER_API = {
	"anthropic-messages": { provider: "anthropic", id: "messages-probe" },
	"azure-openai-responses": { provider: "azure", id: "gpt-probe", baseUrl: "http://127.0.0.1:9/openai/v1" },
	"bedrock-converse-stream": { provider: "amazon-bedrock", id: "converse-probe" },
	"cloudflare-workers-ai-system-one": { provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef-probe", classify: true },
	"google-generative-ai": { provider: "google", id: "gemini-probe" },
	"google-vertex": { provider: "google-vertex", id: "gemini-probe" },
	"mistral-conversations": { provider: "mistral", id: "mistral-probe" },
	"openai-codex-responses": { provider: "openai-codex", id: "gpt-probe", apiKey: codexKey() },
	"openai-completions": { provider: "local", id: "local-probe", compat: { maxTokensField: "max_tokens" } },
	"openai-decisions": { provider: "openai", id: "decisions-probe", classify: true },
	"openai-responses": { provider: "openai", id: "gpt-probe" },
	"typesafe-system-one": { provider: "typesafe", id: "system-one-probe", classify: true },
};

test("issues #1067 and #1059: one call of each priced api, as pi builds it, passes the final payload check as before, and pi is handed the body the bound read: google's signal live, bedrock's image still bytes", { skip, timeout: 30_000 }, async () => {
	assert.deepEqual(Object.keys(PER_API).sort(), [...PRICED_APIS].sort(), "a priced api with no row here");
	const chat = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image", data: PNG, mimeType: "image/png" }], timestamp: 0 }] };
	const classifying = { state: { a: 1 }, questions: { q: { type: "bool", instructions: "is it", criteria: { true: "yes", false: "no" } } } };
	const STOPPED = new Error("stopped before the transport");
	for (const [api, { classify, apiKey = FAKE_KEY, ...fields }] of Object.entries(PER_API)) {
		const model = piModel(api, { baseUrl: "http://127.0.0.1:9/v1", ...fields, ...(classify ? { cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } } : {}) });
		const method = classify ? "classify" : "streamSimple";
		const context = classify ? classifying : chat;
		const controller = new AbortController();
		let original;
		let measured;
		const options = { apiKey, signal: controller.signal, fetch: async () => assert.fail(`${api}: reached the transport`), ...(classify ? {} : { maxTokens: 100 }), onPayload: (payload) => void (original = payload) };
		const guard = createCostGuard({ capMicros: 50_000_000, env: {}, bound: (...args) => {
			if (args[5] !== undefined) measured = args[5];
			return callCostBound(...args);
		} });
		const request = { method, model, args: [context, options] };
		assert.equal(guard.admit(request), null, api);
		const args = guard.prepare({ ...request, stop() {} });
		// The guard's hook is the last one before pi sends: record what it hands on, then stop pi there.
		const guarded = args[1].onPayload;
		let handed;
		let refused;
		args[1] = { ...args[1], onPayload: async function (payload, payloadModel) {
			try {
				handed = await guarded.call(this, payload, payloadModel);
			} catch (error) {
				refused = error;
			}
			throw STOPPED;
		} };
		const module = await piApi(api);
		if (classify) await module.classify(model, args[0], args[1]);
		else await module.streamSimple(model, args[0], args[1]).result();
		assert.equal(refused, undefined, `${api}: refused`);
		assert.ok(original && handed, `${api}: pi built a body and the guard handed one on`);
		assert.notEqual(handed, original, `${api}: never pi's own object`);
		assert.equal(measured, handed, `${api}: the bound read the very body handed on`);
		assert.equal(JSON.stringify(handed), JSON.stringify(original), `${api}: the bytes the old JSON clone measured`);
		if (GOOGLE_APIS.includes(api)) {
			assert.equal(original.config.abortSignal, controller.signal, `${api}: pi puts the call's signal in the body`);
			assert.equal(handed.config.abortSignal, controller.signal, `${api}: the signal handed on is the call's, live`);
		}
		if (api === "bedrock-converse-stream") {
			const bytesOf = (body) => body.messages[0].content.find((block) => block.image).image.source.bytes;
			assert.equal(Object.getPrototypeOf(bytesOf(handed)), Uint8Array.prototype, "bedrock's image bytes are handed on as a Uint8Array");
			assert.notEqual(bytesOf(handed), bytesOf(original), "copied, not pi's array");
			assert.deepEqual([...bytesOf(handed)], [...Buffer.from(PNG, "base64")], "the same bytes");
		}
	}
});

test("issue #1059: a hook that raises mistral's camelCase maxTokens on a capped call is bounded at the value sent, and refused once that no longer fits; issue #1067: a signal it puts in the body is refused unsent", { skip, timeout: 30_000 }, async () => {
	const model = piModel("mistral-conversations", { provider: "mistral", id: "mistral-probe", baseUrl: "http://127.0.0.1:9" });
	const answer = `data: ${JSON.stringify({ id: "m1", object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`;
	const atCatalog = callCostBound("streamSimple", model, piContext, { maxTokens: model.maxTokens }, {});
	// Each row: the hook, the cap, then the cap pi sends and the one the bound must read (absent: the catalog maximum),
	// and the cap the check read before (only `max_tokens`), which held the call lower. `null` in place of them: refused.
	for (const [label, hook, capMicros, sent] of [
		["raised above the catalog maximum", (payload) => ({ ...payload, maxTokens: 50_000 }), 50_000_000, { wire: 50_000, bound: 50_000, before: undefined }],
		// pi's wire step renames `maxTokens` to `max_tokens` over the one the hook left, so `null` sends no cap at all.
		["removed with null beside a small max_tokens", (payload) => ({ ...payload, maxTokens: null, max_tokens: 10 }), 50_000_000, { wire: null, bound: undefined, before: 10 }],
		// Room for the catalog maximum and a few thousand bytes of body, not for 50,000 output tokens.
		["raised past what the cap has room for", (payload) => ({ ...payload, maxTokens: 50_000 }), atCatalog + 5_000, null],
		// Issue #1067: a signal outside google's config is refused, so a toJSON cannot answer the bound and the wire apart.
		["a real signal with another prototype as a message", (payload) => ({ ...payload, messages: [{ role: "user", content: forgedSignals(2_000_000).swapped }] }), 50_000_000, null],
		["an object given a real signal's own symbols as a message", (payload) => ({ ...payload, messages: [{ role: "user", content: forgedSignals(2_000_000).lookalike }] }), 50_000_000, null],
	]) {
		let measured;
		const guard = createCostGuard({ capMicros, env: {}, bound: (...args) => {
			if (args[5] !== undefined) measured = args[5];
			return callCostBound(...args);
		} });
		const bodies = [];
		const held = [];
		const fetch = async (url, init) => {
			bodies.push(JSON.parse(init.body));
			held.push(guard.spend().inflightMicros);
			return new Response(answer, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		const stopped = [];
		const result = await (await sendThrough(guard, model, { apiKey: FAKE_KEY, maxTokens: 100, fetch, onPayload: hook }, stopped)).result();
		if (sent === null) {
			assert.deepEqual([bodies.length, result.stopReason, guard.refusedWhy(), stopped], [0, "error", "final-payload", [COST_CAP]], `${label}: refused unsent`);
			continue;
		}
		assert.deepEqual([bodies.length, result.stopReason], [1, "stop"], `${label}: sent and answered`);
		assert.equal(bodies[0].max_tokens, sent.wire, `${label}: the cap on the wire`);
		assert.equal(held[0], callCostBound("streamSimple", model, piContext, { maxTokens: sent.bound }, {}, measured), `${label}: held at the cap sent`);
		assert.ok(held[0] > callCostBound("streamSimple", model, piContext, { maxTokens: sent.before }, {}, measured), `${label}: above what the check read before`);
	}
});
