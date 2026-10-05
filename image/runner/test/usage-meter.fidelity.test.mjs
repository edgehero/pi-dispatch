import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { createUsageMeter, installProcessUsageMeter } from "../src/usage-meter.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * WIRE FIDELITY: installing the meter must not change the request a provider sends, on any path it wraps,
 * and must count each request exactly once.
 *
 * Three paths, because the 0.99.1 meter (issue #509) sits on two choke points and they meet on a third:
 *   1. THE SESSION PATH for a builtin model: ModelRuntime.streamSimple, which is what createAgentSession's
 *      streamFn calls. The runtime half only observes here, so identity of the request is the claim.
 *   2. THE COMPAT PATH for a builtin model: pi-ai's legacy global streamSimple, what an extension reaches
 *      with a bare pi-ai import. Overriding a builtin api id flips compat's own dispatch (its
 *      getBuiltinProviderForModel answers undefined), and the compat wrapper reproduces that branch --
 *      "I reproduced it correctly" is a claim about behaviour, so the same request is sent through each
 *      and what arrived is compared.
 *   3. THE COMPOSED PATH: a custom models.json provider on a builtin api with no builtin base, which pi
 *      composes so that its stream resolves the api in the compat registry -- through the compat wrapper,
 *      INSIDE a runtime call. Counted twice unless the two halves agree who counts (trap #5 in
 *      usage-meter.mjs); an operator overlay provider is exactly this shape.
 *
 * A silently altered request is the worst possible failure mode here -- an auth header dropped or a
 * placeholder left unsubstituted turns into a provider error that looks like a model problem, on every
 * job, with the metering change three commits back. This test is what makes that impossible to ship.
 *
 * No credential and no internet: the fixture repoints a builtin provider's baseUrl at a loopback
 * server that speaks just enough of the wire protocol to settle a stream, and the key is a literal
 * sentinel. Gated exactly like loader.test.mjs -- CI sets PI_DISPATCH_REQUIRE_LOADER_TESTS=1 so a skip
 * is a hard failure, because an unrun fidelity check must not read as green.
 */
let pi;
let importError;
try {
	pi = await import("@earendil-works/pi-coding-agent");
} catch (error) {
	importError = error;
}

const required = process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1";
if (!pi && required) {
	throw new Error(
		`the usage-meter fidelity check is REQUIRED here but pi could not be imported -- a skip would hide a changed wire request.\n${importError}`,
	);
}
const skip = pi ? false : `pi not installed (node ${process.version} < 22.19.0); CI runs these`;

/**
 * A builtin provider on the plainest of the builtin apis. The api id must be a BUILTIN one or the test
 * proves nothing -- a custom api never had a catalog path to diverge from in the first place.
 */
const BUILTIN_PROVIDER = "groq";
const BUILTIN_API = "openai-completions";
/** Literal, so nothing is read from the environment. Asserted on the wire, which catches env leakage. */
const FIDELITY_KEY = "pi-dispatch-fidelity-key-sentinel";
/** A custom provider with NO builtin base, on the same builtin api: the composed path (path 3). */
const CUSTOM_PROVIDER = "pi-dispatch-fidelity-custom";
const CUSTOM_MODEL = "custom-1";

/** Minimal OpenAI-compatible SSE: one content delta, one finish with usage, then [DONE]. */
function writeStubStream(res) {
	const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
	res.writeHead(200, { "content-type": "text/event-stream" });
	chunk({
		id: "fidelity",
		object: "chat.completion.chunk",
		created: 0,
		model: "stub",
		choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
	});
	chunk({
		id: "fidelity",
		object: "chat.completion.chunk",
		created: 0,
		model: "stub",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
	});
	res.write("data: [DONE]\n\n");
	res.end();
}

/** A loopback endpoint that records what arrived and answers well enough to settle the stream. */
async function startCapturingServer(captures) {
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			captures.push({
				method: req.method,
				path: req.url,
				headers: { ...req.headers },
				body: Buffer.concat(chunks).toString("utf8"),
			});
			writeStubStream(res);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Separate the api key from everything else, so the comparison is explicitly "identical MODULO the
 * key" rather than accidentally passing because both requests were unauthenticated.
 */
function splitAuth(capture) {
	const { authorization, ...headers } = capture.headers;
	return { authorization, rest: { method: capture.method, path: capture.path, headers, body: capture.body } };
}

test("installing the meter changes no request on any wrapped path, and counts each exactly once", { skip }, async () => {
	const captures = [];
	const endpoint = await startCapturingServer(captures);
	const root = tempDir("pi-dispatch-fidelity-");
	let installed;
	try {
		const base = `http://127.0.0.1:${endpoint.port}/v1`;
		// Override-only config for the builtin: no `models` key, so the BUILTIN catalog entries survive and
		// only their baseUrl moves. The custom provider declares its own model on the same api.
		const modelsPath = join(root, "models.json");
		writeFileSync(
			modelsPath,
			`${JSON.stringify(
				{
					providers: {
						[BUILTIN_PROVIDER]: { baseUrl: base, apiKey: FIDELITY_KEY },
						[CUSTOM_PROVIDER]: {
							baseUrl: base,
							apiKey: FIDELITY_KEY,
							api: BUILTIN_API,
							models: [{ id: CUSTOM_MODEL, name: "fidelity custom", api: BUILTIN_API, reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
						},
					},
				},
				null,
				"\t",
			)}\n`,
		);

		const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir: root, modelsPath });
		// Resolved from the catalog rather than hardcoded: a pin bump that retires one model id must not
		// fail this as if fidelity had broken.
		const model = modelRuntime.getModels(BUILTIN_PROVIDER).find((m) => m.api === BUILTIN_API);
		assert.ok(model, `the pinned catalog must still ship a ${BUILTIN_PROVIDER} model on ${BUILTIN_API}`);
		assert.equal(model.baseUrl, base, "the models.json override must have applied");
		const custom = modelRuntime.getModel(CUSTOM_PROVIDER, CUSTOM_MODEL);
		assert.ok(custom, "the custom provider's model must resolve");

		const context = {
			systemPrompt: "fidelity system prompt",
			messages: [{ role: "user", content: "fidelity user message", timestamp: 0 }],
			tools: [],
		};
		const options = { temperature: 0, maxTokens: 16, sessionId: "pi-dispatch-fidelity-session" };
		const send = async (label, streamFn) => {
			const message = await streamFn().result();
			assert.notEqual(message.stopReason, "error", `${label} failed: ${message.errorMessage}`);
		};

		// BASELINES -- no meter anywhere yet.
		await send("runtime baseline", () => modelRuntime.streamSimple(model, context, options));
		await send("composed baseline", () => modelRuntime.streamSimple(custom, context, options));

		const meter = createUsageMeter({});
		installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: modelRuntime, meter, log: () => {} });
		assert.equal(installed.ok, true, "the runtime half must install at the pin");
		assert.equal(installed.tag, "pi", "the compat half must accept pi's own copy at the pin");
		const compat = installed.module;

		// METERED -- the same two requests through the wrapped runtime (the compat half armed as well).
		await send("runtime metered", () => modelRuntime.streamSimple(model, context, options));
		await send("composed metered", () => modelRuntime.streamSimple(custom, context, options));
		assert.equal(meter.state.calls, 2, `each runtime request counted ONCE, the composed one included; got ${meter.state.calls}`);

		// THE COMPAT PATH. resetApiProviders() is what AgentSession.reload() calls; it clears every registration
		// and re-registers the builtins as the instances compat compares against, so this really is the
		// untouched legacy path. The runtime half is still installed and must not see either request.
		const compatOptions = { ...options, apiKey: FIDELITY_KEY };
		compat.resetApiProviders();
		await send("compat baseline", () => compat.streamSimple(model, context, compatOptions));
		assert.equal(meter.state.calls, 2, "a legacy compat call never enters a ModelRuntime, and the wrappers are wiped");
		installed.arm();
		await send("compat metered", () => compat.streamSimple(model, context, compatOptions));

		assert.equal(captures.length, 6, "every request must have reached the endpoint");
		const [runtimeBefore, composedBefore, runtimeAfter, composedAfter, compatBefore, compatAfter] = captures.map(splitAuth);

		// THE ASSERTIONS. Method, path, every non-auth header, and the serialised body -- byte for byte.
		assert.deepEqual(runtimeAfter.rest, runtimeBefore.rest, "the metered runtime request differs from the unmetered one");
		assert.deepEqual(composedAfter.rest, composedBefore.rest, "the metered composed request differs from the unmetered one");
		assert.deepEqual(compatAfter.rest, compatBefore.rest, "the metered compat request differs from the unmetered one");

		// ...and the key, checked separately so "identical" cannot mean "both unauthenticated". Equality
		// with the literal sentinel also catches a real credential leaking in from the environment.
		for (const [label, before, after] of [["runtime", runtimeBefore, runtimeAfter], ["composed", composedBefore, composedAfter], ["compat", compatBefore, compatAfter]]) {
			assert.equal(before.authorization, `Bearer ${FIDELITY_KEY}`, `the ${label} baseline lost or altered its api key`);
			assert.equal(after.authorization, before.authorization, `the metered ${label} request altered the api key`);
		}

		// THE CONTROL: proof the metered requests actually went THROUGH the wrappers. Without this the
		// deepEquals above would pass trivially if the install had silently done nothing -- which is
		// precisely the silent no-op failure mode usage-meter.mjs is shaped around.
		assert.equal(meter.state.calls, 3, "exactly the three metered requests may be observed -- not a baseline, not a double count");
		assert.equal(meter.state.total, 3 * 14, "the meter must have read the stub's usage off each settled stream");
		assert.deepEqual(
			meter.usageSnapshot().models.map((row) => [row.provider, row.model, row.calls]).sort(),
			[[BUILTIN_PROVIDER, model.id, 2], [CUSTOM_PROVIDER, CUSTOM_MODEL, 1]].sort(),
			"each request on the row of the model it was dispatched on",
		);
	} finally {
		installed?.uninstall();
		await endpoint.close();
		rmSync(root, { recursive: true, force: true });
	}
});
