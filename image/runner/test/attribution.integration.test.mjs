import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { chatServer, jobTree, put, runRealJob } from "./helpers/real-job.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #1119, end to end: the headers a job's request carries to a provider pi attributes requests on. pi 1.6.1 added
 * its attribution headers (OpenRouter's `HTTP-Referer`, `X-OpenRouter-Title` and `X-OpenRouter-Categories`) only while
 * install telemetry was on, and a job kept it off; pi 1.7.0 removed telemetry and adds them to every session request.
 * The runner takes them back out (usage-meter.mjs, withoutAttribution), so a job sends what it sent at 1.6.1. The
 * control is the same request through pi with no runner, which carries them: without it, an absence below would say
 * nothing. The `openrouter` provider points at a loopback server, and pi attributes on the provider id, not the host.
 *
 * Gated like loader.test.mjs: a skip is NOT a pass, and CI sets PI_DISPATCH_REQUIRE_LOADER_TESTS=1.
 */
let pi;
let importError;
try {
	pi = await import("@earendil-works/pi-coding-agent");
} catch (error) {
	importError = error;
}
if (!pi && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`the attribution proof is REQUIRED here but pi could not be imported.\n${importError}`);
const skip = pi ? false : `pi not installed (node ${process.version}); CI runs these`;

const ATTRIBUTION = ["http-referer", "x-openrouter-title", "x-openrouter-categories"];
const MODEL = { id: "m1", name: "m1", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000, compat: { maxTokensField: "max_tokens" } };
const overlay = (base) => JSON.stringify({ providers: { openrouter: { baseUrl: base, apiKey: "attribution-fake-key", api: "openai-completions", models: [MODEL] } } });
const attribution = (headers) => Object.fromEntries(ATTRIBUTION.filter((name) => name in headers).map((name) => [name, headers[name]]));

test("the control: pi 1.7.0 with no runner sends its attribution to OpenRouter on a session's request", { skip }, async () => {
	const server = await chatServer();
	try {
		const root = tempDir("pi-dispatch-attribution-");
		const modelsPath = join(root, "models.json");
		put(root, "/models.json", overlay(server.base));
		const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir: root, modelsPath });
		const settingsManager = pi.SettingsManager.inMemory({ retry: { enabled: false } });
		const resourceLoader = new pi.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true });
		await resourceLoader.reload();
		const { session } = await pi.createAgentSession({ cwd: root, agentDir: root, modelRuntime, model: modelRuntime.getModel("openrouter", MODEL.id), settingsManager, sessionManager: pi.SessionManager.inMemory(root), resourceLoader });
		try {
			await session.prompt("hello");
		} finally {
			session.dispose();
		}
		assert.equal(server.calls(), 1);
		assert.deepEqual(attribution(server.headers()[0]), { "http-referer": "https://pi.dev", "x-openrouter-title": "pi", "x-openrouter-categories": "cli-agent" });
	} finally {
		await server.close();
	}
});

test("a job's request to OpenRouter carries no attribution header, and pi's own User-Agent as before", { skip }, async () => {
	const server = await chatServer();
	try {
		const root = jobTree({ base: server.base });
		put(root, "/opt/pi-global/models.json", overlay(server.base));
		const { exit, stderr } = await runRealJob(root, { PI_PROVIDER: "openrouter", PI_MODEL: MODEL.id });
		assert.equal(exit?.code, 0, `${JSON.stringify(exit)}\n${stderr}`);
		assert.equal(server.calls(), 1);
		const [headers] = server.headers();
		assert.deepEqual(attribution(headers), {}, "the job sent pi's attribution");
		assert.match(headers["user-agent"], /^pi\/\d+\.\d+\.\d+ \(/, "the detailed User-Agent pi sends is unchanged");
		assert.equal(headers.authorization, "Bearer attribution-fake-key", "the request is the job's own");
	} finally {
		await server.close();
	}
});
