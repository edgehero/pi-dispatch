import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createUsageMeter, installProcessUsageMeter } from "../src/usage-meter.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * WIRE FIDELITY: installing the meter must not change the request a provider sends.
 *
 * The worry this retires. Overriding a BUILTIN api id flips compat's own dispatch: once
 * `getApiProvider(api)` is no longer the builtin instance, `shouldUseBuiltinModels` returns false and
 * compat stops routing catalog models through its own `compatModels` collection and calls OUR wrapper
 * instead. The wrapper reproduces that catalog branch (usage-meter.mjs's `fallbackModels`) precisely
 * because two of the builtin providers substitute baseUrl placeholders and inject headers in that
 * layer -- but "I reproduced it correctly" is a claim about behaviour, and reading the code is how the
 * mistakes in this project's history were made. So: send the SAME request twice, once through each
 * path, and compare what actually arrived.
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

test("installing the meter does not change the request that reaches the provider", { skip }, async () => {
	const captures = [];
	const endpoint = await startCapturingServer(captures);
	const root = tempDir("pi-dispatch-fidelity-");
	let installed;
	try {
		// Override-only models.json config: no `models` key, so the BUILTIN catalog entries survive and
		// only their baseUrl moves. That is what keeps this a test of the builtin dispatch path.
		const modelsPath = join(root, "models.json");
		writeFileSync(
			modelsPath,
			`${JSON.stringify(
				{ providers: { [BUILTIN_PROVIDER]: { baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, apiKey: FIDELITY_KEY } } },
				null,
				"\t",
			)}\n`,
		);

		const authStorage = pi.AuthStorage.create(join(root, "auth.json"));
		const modelRegistry = pi.ModelRegistry.create(authStorage, modelsPath);
		// Resolved from the catalog rather than hardcoded: a pin bump that retires one model id must not
		// fail this as if fidelity had broken.
		const model = modelRegistry.getAll().find((m) => m.provider === BUILTIN_PROVIDER && m.api === BUILTIN_API);
		assert.ok(model, `the pinned catalog must still ship a ${BUILTIN_PROVIDER} model on ${BUILTIN_API}`);
		assert.equal(model.baseUrl, `http://127.0.0.1:${endpoint.port}/v1`, "the models.json override must have applied");

		const meter = createUsageMeter({});
		// Installed once, for two reasons: it is the only thing that can name WHICH of the two pi-ai
		// copies pi actually mutates (import.meta.resolve names the wrong one), and both requests must go
		// through that same copy or the comparison is between unrelated modules.
		installed = await installProcessUsageMeter({ modelRegistry, meter, log: () => {} });
		assert.equal(installed.ok, true, "the meter must find the pi-ai copy pi actually mutates");
		const compat = installed.module;

		// Auth resolved exactly as pi's own streamFn resolves it, so the only variable between the two
		// requests below is whether the meter's wrapper is in the dispatch chain.
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		assert.equal(auth.ok, true, `auth resolution failed: ${auth.error}`);
		const context = {
			systemPrompt: "fidelity system prompt",
			messages: [{ role: "user", content: "fidelity user message" }],
			tools: [],
		};
		const options = {
			apiKey: auth.apiKey,
			headers: auth.headers,
			temperature: 0,
			maxTokens: 16,
			sessionId: "pi-dispatch-fidelity-session",
		};

		// BASELINE -- no meter. resetApiProviders() is what AgentSession.reload() calls; it clears every
		// registration and re-registers the builtins as the instances shouldUseBuiltinModels compares
		// against, so this really is the untouched dispatch path.
		compat.resetApiProviders();
		const baseline = await compat.streamSimple(model, context, options).result();
		assert.notEqual(baseline.stopReason, "error", `baseline request failed: ${baseline.errorMessage}`);

		// METERED -- the wrappers back in place over the freshly reset builtins.
		installed.arm();
		const metered = await compat.streamSimple(model, context, options).result();
		assert.notEqual(metered.stopReason, "error", `metered request failed: ${metered.errorMessage}`);

		assert.equal(captures.length, 2, "both requests must have reached the endpoint");
		const [before, after] = captures.map(splitAuth);

		// THE ASSERTION. Method, path, every non-auth header, and the serialised body -- byte for byte.
		assert.deepEqual(after.rest, before.rest, "the metered request differs from the unmetered one");

		// ...and the key, checked separately so "identical" cannot mean "both unauthenticated". Equality
		// with the literal sentinel also catches a real credential leaking in from the environment.
		assert.equal(before.authorization, `Bearer ${FIDELITY_KEY}`, "the baseline request lost or altered its api key");
		assert.equal(after.authorization, before.authorization, "the metered request altered the api key");

		// THE CONTROL: proof the second request actually went THROUGH the wrapper. Without this the
		// deepEqual above would pass trivially if arm() had silently done nothing -- which is precisely
		// the silent no-op failure mode usage-meter.mjs is shaped around.
		assert.equal(meter.state.calls, 1, "exactly the metered request may be observed -- not the baseline, not neither");
		assert.equal(meter.state.total, 14, "the meter must have read the stub's usage off the settled stream");
	} finally {
		installed?.uninstall();
		await endpoint.close();
		rmSync(root, { recursive: true, force: true });
	}
});
