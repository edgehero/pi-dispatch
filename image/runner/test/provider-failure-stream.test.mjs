import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { createJobModelRuntime, loadPiAuthStorage } from "../src/model-runtime.mjs";
import { classifyProviderFailure, installProviderFailureObserver, SSE_FRAME_CAP } from "../src/provider-failure.mjs";
import { HEADERS, PI_MESSAGE, SENTENCE, SHAPES, USAGE_LIMIT, WORKPLACE_LIMIT } from "./fixtures/chatgpt-usage-limit.mjs";

// Issue #960: a ChatGPT subscription past its usage limit answers HTTP 200 with the refusal as an event, so the closed
// code is read off the event stream on its way to pi. Every case here holds one side of that read: what it finds, what
// it must leave alone, and that the bytes pi reads are the bytes the provider sent.

const NOW = Date.parse("2026-01-01T00:00:00Z");
const error = (errorMessage) => ({ role: "assistant", stopReason: "error", errorMessage });
const quota = (subscriptionCode = USAGE_LIMIT, extra = {}) => ({ kind: "quota-exhausted", subscriptionCode, subscriptionProvider: "openai", ...extra });
const sse = (events) => events.map(([event, data]) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`).join("");
const created = (pad = "") => ["response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [], pad } }];
/** A successful Responses stream, with a character UTF-8 writes in two bytes, so a chunk split can land inside it. */
const SUCCESS = sse([
	created(),
	["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } }],
	["response.content_part.added", { type: "response.content_part.added", output_index: 0, item_id: "msg_1", content_index: 0, part: { type: "output_text", text: "", annotations: [] } }],
	["response.output_text.delta", { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: "ok é" }],
	["response.output_text.done", { type: "response.output_text.done", output_index: 0, item_id: "msg_1", content_index: 0, text: "ok é" }],
	["response.content_part.done", { type: "response.content_part.done", output_index: 0, item_id: "msg_1", content_index: 0, part: { type: "output_text", text: "ok é", annotations: [] } }],
	["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok é", annotations: [] }] } }],
	["response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }],
]);

/** A body handed over in `size`-byte chunks, so lines, events and characters are split wherever a socket might split them. */
function chunked(text, size = 7) {
	const bytes = Buffer.from(text, "utf8");
	let at = 0;
	return new ReadableStream({ pull(controller) { if (at >= bytes.length) return controller.close(); controller.enqueue(new Uint8Array(bytes.subarray(at, at + size))); at += size; } });
}
const answer = (body, init = {}) => new Response(body, { status: 200, headers: HEADERS, ...init });

/** A runtime whose one stream call makes one fetch through the observer's wrapper and hands back what pi would read. */
function fakeRuntime() {
	const seen = [];
	class Runtime {
		streamSimple(model, context, options) {
			const done = (async () => {
				const response = await options.fetch("https://unused.invalid/v1/responses", { method: "POST" });
				seen.push(response);
				if (context.read !== false) seen.push(Buffer.from(await response.arrayBuffer()).toString("utf8"));
				return context.message;
			})();
			return { result: () => done };
		}
	}
	return { Runtime, seen };
}
async function observed(model, body, { message = error(SENTENCE), init } = {}) {
	const { Runtime, seen } = fakeRuntime();
	const observer = installProviderFailureObserver({ ModelRuntime: Runtime, now: () => NOW });
	const source = body instanceof Response ? body : answer(body, init);
	try {
		await new Runtime().streamSimple(model, { message }, { fetch: async () => source }).result();
		return { failure: observer.failure(message), source, response: seen[0], text: seen[1] };
	} finally { observer.uninstall(); }
}
const CHATGPT = { provider: "openai", api: "openai-responses" };

test("each refusal shape gives the quota triple, whole or split into chunks of any size, with CRLF or LF lines", async () => {
	for (const [name, shape] of Object.entries(SHAPES)) {
		for (const code of [USAGE_LIMIT, WORKPLACE_LIMIT]) {
			assert.deepEqual((await observed(CHATGPT, shape(code))).failure, quota(code), `${name} ${code}`);
			for (const size of [1, 3, 7, 64]) assert.deepEqual((await observed(CHATGPT, chunked(shape(code), size), {})).failure, quota(code), `${name} ${code} in ${size}-byte chunks`);
			assert.deepEqual((await observed(CHATGPT, chunked(shape(code).replaceAll("\n", "\r\n"), 5))).failure, quota(code), `${name} ${code} with CRLF`);
			assert.deepEqual((await observed(CHATGPT, chunked(shape(code).replaceAll("\n", "\r"), 2))).failure, quota(code), `${name} ${code} with CR`);
		}
	}
	// An event the stream ended without its closing blank line is still delivered by the SDK, so it is read too.
	assert.deepEqual((await observed(CHATGPT, SHAPES.EVENT().trimEnd())).failure, quota());
});

test("a reset the refusal names is kept under the fields the 429 body already reads; none at all keeps none", async () => {
	const at = NOW + 5 * 3_600_000;
	assert.deepEqual((await observed(CHATGPT, SHAPES.EVENT(USAGE_LIMIT, { resets_at: at / 1000 }))).failure, quota(USAGE_LIMIT, { resetAt: at }));
	assert.deepEqual((await observed(CHATGPT, SHAPES.TOP_LEVEL(USAGE_LIMIT, { reset_at: new Date(at).toISOString() }))).failure, quota(USAGE_LIMIT, { resetAt: at }));
	assert.deepEqual((await observed(CHATGPT, SHAPES.FAILED(USAGE_LIMIT, { resets_at: at }))).failure, quota(USAGE_LIMIT, { resetAt: at }));
	assert.deepEqual((await observed(CHATGPT, SHAPES.EVENT(USAGE_LIMIT, { resets_at: (NOW - 1000) / 1000 }))).failure, quota(), "a reset already past is no reset");
	assert.deepEqual((await observed(CHATGPT, SHAPES.EVENT(), { init: { headers: { ...HEADERS, "retry-after": String(7 * 86_400) } } })).failure, quota(USAGE_LIMIT, { resetAt: NOW + 7 * 86_400_000 }), "a header reset backs a code with none, to a subscription's longer bound, as on a 429");
});

test("the retryable subscription outages and every other code latch nothing, in any shape", async () => {
	for (const code of ["subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable", "insufficient_quota_typo", "server_error", null]) {
		for (const [name, shape] of Object.entries(SHAPES)) assert.equal((await observed(CHATGPT, shape(code), { message: error("Usage data could not be read.") })).failure, null, `${name} ${code}`);
	}
});

test("prose that holds the sentence, or even the code, is never the code: only a structured field is", async () => {
	for (const message of [SENTENCE, `${USAGE_LIMIT}: ${SENTENCE}`, `Error Code ${WORKPLACE_LIMIT}: ${SENTENCE}`]) {
		assert.equal(classifyProviderFailure(error(message)), null, message);
		assert.equal(classifyProviderFailure(error(message), { status: 200 }), null, message);
	}
	// The code in the event's message, in another field, in a delta's text, in a comment, or in a `thread.*` event the SDK
	// never throws on: no measured code.
	for (const body of [
		sse([created(), ["error", { type: "error", code: null, message: `${USAGE_LIMIT}: ${SENTENCE}` }]]),
		sse([created(), ["error", { type: "error", message: SENTENCE, param: USAGE_LIMIT }]]),
		sse([created(), ["response.output_text.delta", { type: "response.output_text.delta", delta: JSON.stringify({ error: { code: USAGE_LIMIT } }) }]]),
		sse([created(), ["thread.message.delta", { type: "thread.message.delta", error: { code: USAGE_LIMIT } }]]),
		`${sse([created()])}: ${JSON.stringify({ error: { code: USAGE_LIMIT } })}\n\n`,
	]) assert.equal((await observed(CHATGPT, body, { message: error(`${USAGE_LIMIT}: ${SENTENCE}`) })).failure, null, body);
});

test("any event the SDK throws on is read, as the SDK reads it: a top-level error on any event not named thread.*", async () => {
	for (const name of ["response.in_progress", "response.output_text.delta", "response.completed", "anything.else"]) {
		const body = sse([created(), [name, { type: name, error: { code: USAGE_LIMIT, message: SENTENCE } }]]);
		assert.deepEqual((await observed(CHATGPT, chunked(body, 3))).failure, quota(), name);
	}
	// The SDK's own throw comes before pi-ai's: data with both a top-level `error` and `type: "error"` fails on `error`.
	assert.deepEqual((await observed(CHATGPT, sse([created(), [null, { type: "error", code: "server_error", error: { code: USAGE_LIMIT } }]]))).failure, quota());
	assert.equal((await observed(CHATGPT, sse([created(), [null, { type: "error", code: USAGE_LIMIT, error: { code: "server_error" } }]]))).failure, null);
	// A key spelled with a JSON escape is the same key to the SDK, so it is parsed and read too.
	assert.deepEqual((await observed(CHATGPT, `${sse([created()])}event: response.in_progress\ndata: {"\\u0065rror":{"code":"${USAGE_LIMIT}"}}\n\n`)).failure, quota());
	// `event: error` with data that is not an object still fails the call (the SDK throws it), so it is the first failure.
	assert.equal((await observed(CHATGPT, `${sse([created(), ["error", "busy"]])}${SHAPES.EVENT().split("\n\n").slice(1).join("\n\n")}`)).failure, null);
	// The end marker stops the SDK, so an event after it is never read.
	assert.equal((await observed(CHATGPT, `${sse([created()])}data: [DONE]\n\n${SHAPES.TOP_LEVEL().split("\n\n").slice(1).join("\n\n")}`)).failure, null);
});

test("reading stops where the SDK stops: at data that is not JSON and at a named event with no data", async () => {
	const later = SHAPES.EVENT().split("\n\n").slice(1).join("\n\n");
	for (const [label, body] of [
		["malformed data, then the refusal", `${sse([created()])}event: response.output_text.delta\ndata: {not json\n\n${later}`],
		["malformed unnamed data, then the refusal", `${sse([created()])}data: [1,\n\n${later}`],
		["a named event with no data, then the refusal", `${sse([created()])}event: response.in_progress\n\n${later}`],
	]) {
		const read = await observed(CHATGPT, chunked(body, 5));
		assert.equal(read.failure, null, label);
		assert.equal(read.text, body, `${label}: every byte reaches pi`);
	}
	// The control: a frame with neither a name nor data (a comment, a lone id) is no event to the SDK, and reading goes on.
	assert.deepEqual((await observed(CHATGPT, `${sse([created()])}: keep-alive\n\nid: 7\n\n${later}`)).failure, quota());
});

test("reading stops at the first failing event, as the SDK does: a later refusal is never the evidence", async () => {
	const first = sse([created(), ["error", { type: "error", code: "server_error", message: "Something went wrong." }]]);
	assert.equal((await observed(CHATGPT, `${first}${SHAPES.EVENT().split("\n\n").slice(1).join("\n\n")}`)).failure, null);
	assert.equal((await observed(CHATGPT, `${sse([created(), ["response.failed", { type: "response.failed", response: { error: null } }]])}${SHAPES.EVENT().split("\n\n").slice(1).join("\n\n")}`)).failure, null);
});

test("a fault inside the reader leaves the bytes and pi's result as they were, and reads nothing after it", async () => {
	// Malformed data that looks like a failure: the parse throws inside the reader, which then stops reading.
	const hostile = `${sse([created()])}event: error\ndata: {"error": not json\n\n${SHAPES.EVENT().split("\n\n").slice(1).join("\n\n")}`;
	for (const size of [hostile.length, 4]) {
		const read = await observed(CHATGPT, chunked(hostile, size));
		assert.equal(read.text, hostile, `${size}-byte chunks: every byte reaches pi`);
		assert.equal(read.failure, null, "the refusal after the fault is not read: the SDK stopped at the malformed event too");
	}
});

test("a successful stream reaches pi byte for byte, in the same chunks' worth of order, with no failure", async () => {
	for (const size of [1, 2, 7, 4096]) {
		const read = await observed(CHATGPT, chunked(SUCCESS, size), { message: { role: "assistant", stopReason: "stop" } });
		assert.equal(read.text, SUCCESS, `${size}-byte chunks`);
		assert.notEqual(read.response, read.source, "the body is read through the pass-through");
		assert.equal(read.response.status, 200);
		assert.equal(read.response.headers.get("content-type"), HEADERS["content-type"]);
		assert.equal(read.failure, null);
	}
	// The bytes of a refusal reach pi unchanged too: the read is never a rewrite.
	assert.equal((await observed(CHATGPT, chunked(SHAPES.EVENT(), 3))).text, SHAPES.EVENT());
});

test("pi's cancel reaches the provider's body at once, and nothing is read ahead of what pi asked for", { timeout: 10_000 }, async () => {
	let pulls = 0;
	let cancelled = null;
	const body = new ReadableStream({
		// Long enough that anything draining it ahead of pi shows in the count; finite, so such a drain ends.
		pull(controller) { pulls += 1; if (pulls > 2000) return controller.close(); controller.enqueue(new TextEncoder().encode(sse([created("x".repeat(100))]))); },
		cancel(reason) { cancelled = reason ?? "cancelled"; },
	}, { highWaterMark: 0 });
	const { Runtime, seen } = fakeRuntime();
	const observer = installProviderFailureObserver({ ModelRuntime: Runtime, now: () => NOW });
	try {
		await new Runtime().streamSimple(CHATGPT, { message: error(SENTENCE), read: false }, { fetch: async () => answer(body) }).result();
		const reader = seen[0].body.getReader();
		for (let i = 0; i < 3; i++) assert.equal((await reader.read()).done, false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(pulls <= 5, `${pulls} pulls for three reads: a long body is passed on as asked, never drained ahead`);
		await reader.cancel("pi aborted");
		// The pipe hands the cancel on in its own microtasks, never by waiting for more bytes.
		for (let i = 0; i < 10 && cancelled === null; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(cancelled, "pi aborted");
	} finally { observer.uninstall(); }
});

test("the refusal after a response.created larger than one event's cap is still found; a refusal past the cap is not read", async () => {
	const pad = "p".repeat(SSE_FRAME_CAP * 2);
	assert.deepEqual((await observed(CHATGPT, chunked(sse([created(pad)]) + SHAPES.EVENT().split("\n\n").slice(1).join("\n\n"), 4096))).failure, quota());
	assert.deepEqual((await observed(CHATGPT, chunked(sse([[null, { type: "response.created", pad }]]) + SHAPES.TOP_LEVEL().split("\n\n").slice(1).join("\n\n"), 4096))).failure, quota(), "an unnamed event over the cap is dropped, and the next one read");
	const oversize = sse([created(), ["error", { type: "error", code: USAGE_LIMIT, message: "m".repeat(SSE_FRAME_CAP) }]]);
	assert.equal((await observed(CHATGPT, chunked(oversize, 4096))).failure, null, "an event past the cap is never parsed");
	assert.equal((await observed(CHATGPT, chunked(oversize, 4096))).text, oversize, "and still passed on whole");
	// The cap holds for an event's data as a whole: several data lines, each under it, that together pass it.
	const half = "h".repeat(SSE_FRAME_CAP / 2);
	const split = `${sse([created()])}event: error\ndata: {"type":"error",\ndata: "code":"${USAGE_LIMIT}",\ndata: "a":"${half}",\ndata: "b":"${half}"}\n\n`;
	assert.equal((await observed(CHATGPT, chunked(split, 4096))).failure, null, "data past the cap across lines is never parsed");
	const small = `${sse([created()])}event: error\ndata: {"type":"error",\ndata: "code":"${USAGE_LIMIT}"}\n\n`;
	assert.deepEqual((await observed(CHATGPT, small)).failure, quota(), "the control: data on several lines under the cap is joined and read");
});

test("only OpenAI's Responses stream is read: another provider, another api, an error status or another type keeps pi's own response", async () => {
	for (const [model, init] of [
		[{ provider: "groq", api: "openai-responses" }, {}],
		[{ provider: "openai", api: "openai-completions" }, {}],
		[{ provider: "anthropic", api: "anthropic-messages" }, {}],
		[{ provider: "azure", api: "azure-openai-responses" }, {}],
		[CHATGPT, { headers: { "content-type": "application/json" } }],
		[CHATGPT, { status: 500 }],
	]) {
		const read = await observed(model, SHAPES.EVENT(), { init });
		assert.equal(read.response, read.source, `${JSON.stringify(model)} ${JSON.stringify(init)}: the same Response object`);
		assert.equal(read.failure?.subscriptionCode, undefined);
	}
});

test("nested stream wrappers read each byte once and both hold the code", async () => {
	class Runtime {
		streamSimple(model, context, options) { return this.stream(model, context, options); }
		stream(model, context, options) {
			const done = (async () => { await (await options.fetch("https://unused.invalid")).arrayBuffer(); return context.message; })();
			return { result: () => done };
		}
	}
	const Original = globalThis.TransformStream;
	let made = 0;
	globalThis.TransformStream = class extends Original { constructor(...args) { made += 1; super(...args); } };
	const observer = installProviderFailureObserver({ ModelRuntime: Runtime, now: () => NOW });
	try {
		const message = error(SENTENCE);
		await new Runtime().streamSimple(CHATGPT, { message }, { fetch: async () => answer(SHAPES.EVENT()) }).result();
		assert.equal(made, 1, "one pass-through, not one per wrapper");
		assert.deepEqual(observer.failure(message), quota());
	} finally { observer.uninstall(); globalThis.TransformStream = Original; }
});

test("a request pi gave up on and retried cannot hand its late refusal to the retry", async () => {
	let first;
	class Runtime {
		streamSimple(model, context, options) {
			const done = (async () => {
				first = await options.fetch("https://unused.invalid");
				await (await options.fetch("https://unused.invalid")).arrayBuffer();
				await first.arrayBuffer();
				return context.message;
			})();
			return { result: () => done };
		}
	}
	const answers = [answer(SHAPES.EVENT()), answer(SUCCESS)];
	const observer = installProviderFailureObserver({ ModelRuntime: Runtime, now: () => NOW });
	try {
		const message = error("Connection error.");
		await new Runtime().streamSimple(CHATGPT, { message }, { fetch: async () => answers.shift() }).result();
		assert.equal(observer.failure(message), null, "the superseded stream's refusal stays its own");
	} finally { observer.uninstall(); }
});

let pi;
try { pi = await import("@earendil-works/pi-coding-agent"); } catch (cause) {
	if (process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw cause;
}

async function pinnedRuntime() {
	const root = tempDir("pi-failure-stream-");
	const AuthStorage = await loadPiAuthStorage();
	const runtime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, AuthStorage, agentDir: root, modelsPath: join(root, "models.json"), readFile: () => "{}" });
	const model = runtime.getModels("openai").find((m) => m.api === "openai-responses");
	assert.ok(model, "the pin must retain an openai/openai-responses catalog model");
	return { runtime, model };
}
const ASK = { messages: [{ role: "user", content: "test", timestamp: 0 }], tools: [] };

test("the pinned openai-responses adapter gives pi the issue's exact message and the runner the quota triple, in one request", { skip: !pi }, async () => {
	const { runtime, model } = await pinnedRuntime();
	for (const [name, shape] of Object.entries(SHAPES)) {
		for (const code of [USAGE_LIMIT, WORKPLACE_LIMIT]) {
			let calls = 0;
			const observer = installProviderFailureObserver({ ModelRuntime: pi.ModelRuntime, now: () => NOW });
			try {
				// A non-`sk-` key on api.openai.com is pi's Sign in with ChatGPT route, the connection the issue ran on.
				const terminal = await runtime.streamSimple(model, ASK, { apiKey: "fixture.oauth.access", fetch: async () => (calls += 1, answer(chunked(shape(code), 5))) }).result();
				assert.equal(terminal.stopReason, "error");
				if (code === USAGE_LIMIT) assert.equal(terminal.errorMessage, PI_MESSAGE[name], `${name}: the message pi prints`);
				assert.equal(calls, 1, `${name}: no retry inside the call`);
				assert.deepEqual(observer.failure(terminal), quota(code), `${name} ${code}`);
			} finally { observer.uninstall(); }
		}
	}
	// The control: the same message with nothing read off the stream is not quota.
	assert.equal(classifyProviderFailure(error(PI_MESSAGE.EVENT), { status: 200 }), null);
});

test("the pinned adapter completes a successful stream read through the pass-through, with no failure", { skip: !pi }, async () => {
	const { runtime, model } = await pinnedRuntime();
	const observer = installProviderFailureObserver({ ModelRuntime: pi.ModelRuntime, now: () => NOW });
	try {
		const terminal = await runtime.streamSimple(model, ASK, { apiKey: "fixture.oauth.access", fetch: async () => answer(chunked(SUCCESS, 3)) }).result();
		assert.equal(terminal.stopReason, "stop");
		assert.equal(terminal.content.map((part) => part.text).join(""), "ok é");
		assert.equal(terminal.usage.output, 2);
		assert.equal(observer.failure(terminal), null);
	} finally { observer.uninstall(); }
});

test("over a real socket through pi's own undici, each refusal shape still gives the quota triple (loopback, no key)", { skip: !pi }, async () => {
	const { loadPiUndici } = await import("../src/env-proxy.mjs");
	const undici = loadPiUndici();
	const { runtime, model } = await pinnedRuntime();
	let body = "";
	let requests = 0;
	const server = createServer((req, res) => {
		requests += 1;
		req.resume();
		res.writeHead(200, HEADERS);
		// The created event first, the refusal in a later write, as a server flushes them.
		const [head, ...rest] = body.split("\n\n");
		res.write(`${head}\n\n`);
		setTimeout(() => res.end(rest.join("\n\n")), 5);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${server.address().port}/v1/responses`;
	try {
		for (const [name, shape] of Object.entries(SHAPES)) {
			body = shape();
			requests = 0;
			const observer = installProviderFailureObserver({ ModelRuntime: pi.ModelRuntime, now: () => NOW });
			try {
				const terminal = await runtime.streamSimple(model, ASK, { apiKey: "fixture.oauth.access", fetch: (_input, init) => undici.fetch(url, init) }).result();
				assert.equal(terminal.errorMessage, PI_MESSAGE[name], name);
				assert.equal(requests, 1, name);
				assert.deepEqual(observer.failure(terminal), quota(), name);
			} finally { observer.uninstall(); }
		}
	} finally {
		server.closeAllConnections?.();
		await new Promise((resolve) => server.close(resolve));
	}
});
