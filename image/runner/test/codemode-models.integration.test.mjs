import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { createPolicyGuard, createUsageMeter, installProcessUsageMeter } from "../src/usage-meter.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { trackPiRefreshes } from "./helpers/track-pi-refreshes.mjs";

/**
 * REQ-MCP-OPERATOR-SERVERS, codemode's `models.*` (DES-MCP-CODEMODE-MODELS): a codemode script's
 * `models.classify()` and `models.generateImages()` run on the runner's main thread through the session's
 * ModelRegistry, which forwards to `ModelRuntime.prototype.classify` / `generateImages`, the two result methods the
 * process-wide meter wraps. This is the proof that lets the job turn them on: pi's REAL codemode tool, run in a REAL
 * session against a stub classifier and image server, with the runner's real meter and guards installed, and every
 * call the stub sees counted. A builtin provider is pointed at the stub through models.json (`baseUrl`), since a
 * models.json entry cannot declare a classifier or an image model; openrouter serves both kinds.
 */
let pi;
let importError;
try {
	pi = await import("@earendil-works/pi-coding-agent");
	trackPiRefreshes(pi.ModelRuntime);
} catch (error) {
	importError = error;
}
if (!pi && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`the codemode models proof is REQUIRED here but pi could not be imported.\n${importError}`);
const skip = pi ? false : `pi not installed (node ${process.version}); CI runs these`;

/** Priced input-only classifier (bounded), and a priced image model (never boundable). */
const CLASSIFIER = { provider: "openrouter", id: "typesafe/jev-1.13" };
const PAINTER = { provider: "openrouter", id: "google/gemini-2.5-flash-image" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A stub of both wire formats (pi-ai typesafe-system-one and openrouter-images), counting what reached it. */
async function stubServer() {
	const seen = { classify: 0, images: 0 };
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const reply = (value) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
			if (req.url.endsWith("/systemone")) {
				seen.classify++;
				const { questions } = JSON.parse(body);
				const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul", noul: 0.9 }]));
				return reply({ answers, usage: { input_tokens: 1200, output_tokens: 0 } });
			}
			if (req.url.endsWith("/chat/completions")) {
				seen.images++;
				return reply({ id: "img-1", choices: [{ message: { role: "assistant", content: "done", images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }] } }], usage: { prompt_tokens: 50, completion_tokens: 1290 } });
			}
			res.writeHead(404).end();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { seen, base: `http://127.0.0.1:${server.address().port}/api/v1`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The runner's model runtime on a models.json that points openrouter at the stub, and the meter as the runner installs it. */
async function job({ base, maxCostMicros = null, allowedModels = null }) {
	const root = tempDir("pi-dispatch-codemode-");
	const modelsPath = join(root, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ providers: { openrouter: { baseUrl: base, apiKey: "stub-key" } } }));
	const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir: root, modelsPath });
	const stops = [];
	const logged = [];
	const log = (event, fields) => logged.push({ event, fields });
	const sessionManager = pi.SessionManager.inMemory(root);
	const meter = createUsageMeter({ maxTokens: null, maxCostMicros, allowedModels, rootSessionId: sessionManager.getSessionId(), onStop: (reason) => stops.push(reason) });
	const guard = createPolicyGuard({ maxCostMicros, allowedModels, log });
	const installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: modelRuntime, meter, ...(guard && { guard }), log });
	assert.equal(installed.ok, true, JSON.stringify(logged));
	const settingsManager = pi.SettingsManager.inMemory({});
	const resourceLoader = new pi.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noContextFiles: true, noSkills: true, noExtensions: true, extensionFactories: [{ name: "job-codemode", factory: pi.createCodemodeExtension({ models: true }) }] });
	await resourceLoader.reload();
	const model = modelRuntime.getModel("openrouter", "openai/gpt-4o-mini") ?? modelRuntime.getAll?.()[0];
	const { session } = await pi.createAgentSession({ cwd: root, agentDir: root, modelRuntime, model, settingsManager, sessionManager, resourceLoader });
	const run = async (code) => {
		const tool = session.getToolDefinition("codemode");
		const ctx = session.extensionRunner.createToolContext("call-1", undefined);
		return tool.execute("call-1", { code }, undefined, undefined, ctx);
	};
	const text = (result) => result.content.map((block) => block.text ?? "").join("\n");
	return {
		run,
		text,
		meter,
		guard,
		stops,
		logged,
		row: (id) => meter.usageSnapshot()?.models.find((entry) => entry.model === id),
		close: () => {
			session.dispose();
			installed.uninstall();
		},
	};
}

const classify = (n = 1) => `
const model = { provider: "${CLASSIFIER.provider}", id: "${CLASSIFIER.id}" };
const context = { state: { text: "ship it" }, questions: { ok: { type: "bool", instructions: "Is it positive?", criteria: { true: "positive", false: "negative" } } } };
const results = await Promise.all(Array.from({ length: ${n} }, () => models.classify(model, context)));
return results.map((r) => r.stopReason + ":" + (r.errorMessage ?? "")).join(",");`;
const paint = `
const result = await models.generateImages({ provider: "${PAINTER.provider}", id: "${PAINTER.id}" }, { input: [{ type: "text", text: "a dot" }] });
return result.stopReason + ":" + (result.errorMessage ?? "") + ":" + result.output.filter((b) => b.type === "image").length;`;

test("no policy: a script's classify and generateImages are metered, each in its own ledger row with the provider's own cost", { skip }, async () => {
	const stub = await stubServer();
	const j = await job({ base: stub.base });
	try {
		assert.match(j.text(await j.run(classify())), /stop:/);
		assert.match(j.text(await j.run(paint)), /stop::1/);
		assert.deepEqual(stub.seen, { classify: 1, images: 1 });
		assert.equal(j.row(CLASSIFIER.id)?.calls, 1);
		assert.equal(j.row(CLASSIFIER.id)?.input, 1200);
		assert.equal(j.row(PAINTER.id)?.calls, 1);
		assert.ok(j.row(PAINTER.id).cost > 0, "the image call's cost reaches the ledger");
		assert.ok(j.meter.state.cost > 0);
		assert.equal(j.meter.state.stopReason, null);
	} finally {
		j.close();
		await stub.close();
	}
});

test("under a cost cap, classify is admitted and charged, and generateImages is refused as unboundable before it reaches the provider", { skip }, async () => {
	const stub = await stubServer();
	const j = await job({ base: stub.base, maxCostMicros: 1_000_000 });
	try {
		assert.match(j.text(await j.run(classify())), /stop:/);
		assert.equal(stub.seen.classify, 1);
		assert.ok(j.guard.snapshot().costRefused === 0);
		assert.match(j.text(await j.run(paint)), /aborted:pi-dispatch: cost cap reached:0/);
		assert.equal(stub.seen.images, 0, "the image call never reached the provider");
		assert.deepEqual(j.stops, ["cost-cap"]);
		assert.equal(j.guard.snapshot().costRefused, 1);
		assert.ok(j.logged.some((entry) => entry.event === "cost_refused" && entry.fields.why === "unboundable"), JSON.stringify(j.logged));
	} finally {
		j.close();
		await stub.close();
	}
});

test("under a cap too small for its bound, classify is refused before it reaches the provider, and the job stops", { skip }, async () => {
	const stub = await stubServer();
	const j = await job({ base: stub.base, maxCostMicros: 1 });
	try {
		assert.match(j.text(await j.run(classify())), /aborted:pi-dispatch: cost cap reached/);
		assert.equal(stub.seen.classify, 0);
		assert.deepEqual(j.stops, ["cost-cap"]);
	} finally {
		j.close();
		await stub.close();
	}
});

test("concurrent classify calls are each judged against the bounds already in flight: past the cap, the rest are refused unsent", { skip }, async () => {
	const stub = await stubServer();
	// One bound is a few hundred micro-dollars; a cap of 1000 admits two or three at once, never all eight.
	const j = await job({ base: stub.base, maxCostMicros: 1000 });
	try {
		const out = j.text(await j.run(classify(8)));
		assert.ok(stub.seen.classify >= 1 && stub.seen.classify < 8, `${stub.seen.classify} reached the provider: ${out}`);
		assert.match(out, /aborted:pi-dispatch: cost cap reached/);
		assert.ok(j.meter.state.cost * 1e6 <= 1000, `the metered total ${j.meter.state.cost} passed the cap`);
	} finally {
		j.close();
		await stub.close();
	}
});

test("under a model list, a classifier on it is admitted and an image model off it is refused unsent", { skip }, async () => {
	const stub = await stubServer();
	const j = await job({ base: stub.base, allowedModels: [{ provider: CLASSIFIER.provider, model: CLASSIFIER.id }] });
	try {
		assert.match(j.text(await j.run(classify())), /stop:/);
		assert.match(j.text(await j.run(paint)), /aborted:pi-dispatch: model not allowed:0/);
		assert.deepEqual(stub.seen, { classify: 1, images: 0 });
		assert.deepEqual(j.stops, ["model-not-allowed"]);
		assert.equal(j.guard.snapshot().modelRefused, 1);
	} finally {
		j.close();
		await stub.close();
	}
});

test("a script's own model object cannot redirect a call: the model is resolved again from the catalog, so a crafted baseUrl is never dialled", { skip }, async () => {
	const stub = await stubServer();
	const elsewhere = await stubServer();
	const j = await job({ base: stub.base });
	try {
		const code = `return (await models.classify({ provider: "${CLASSIFIER.provider}", id: "${CLASSIFIER.id}", baseUrl: "${elsewhere.base}", headers: { "x-leak": "1" } }, { state: {}, questions: { ok: { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } } } })).stopReason;`;
		assert.match(j.text(await j.run(code)), /stop/);
		assert.deepEqual([stub.seen.classify, elsewhere.seen.classify], [1, 0]);
	} finally {
		j.close();
		await stub.close();
		await elsewhere.close();
	}
});
