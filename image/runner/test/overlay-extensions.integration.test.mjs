import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// Pure: no static pi import in their module graph. loader.mjs imports pi, so it is loaded with pi below.
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { createUsageMeter, installProcessUsageMeter } from "../src/usage-meter.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #544, end to end: a loose `extensions/foo.js` in the operator overlay loads in a job and acts during
 * its run, and a broken one beside it is logged by name.
 *
 * Driven through the runner's own pieces the way run-job.mjs wires them: the job's ModelRuntime, the
 * process-wide meter installed BEFORE the loader (issue #543), buildLoadedResourceLoader with the overlay and
 * the runner's log writer, and a real pi session prompted against an offline provider (the fixture shape of
 * compaction-refused.integration.test.mjs; its port-1 baseUrl is never dialled). run-job.mjs itself reads the
 * fixed container paths, so this is the closest a host test gets; the image check runs it in a container.
 *
 * Gated like loader.test.mjs: a skip is NOT a pass, and CI sets PI_DISPATCH_REQUIRE_LOADER_TESTS=1.
 */
let pi;
let loaderModule;
let importError;
try {
	pi = await import("@earendil-works/pi-coding-agent");
	loaderModule = await import("../src/loader.mjs");
} catch (error) {
	importError = error;
}
if (!pi && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") {
	throw new Error(`the #544 overlay proof is REQUIRED here but pi could not be imported.\n${importError}`);
}
const skip = pi ? false : `pi not installed (node ${process.version} < 22.19.0); CI runs these`;

const PROVIDER = "pi-dispatch-fake";
const MODEL_ID = "fake-1";
const API = "pi-dispatch-544";
const BROKEN_SENTINEL = "BROKEN-SOURCE-SENTINEL-544";
const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** An overlay whose extensions/ holds a loose foo.js that writes a marker at agent_end, and a broken.js. */
function overlay(marker) {
	const dir = tempDir("pi-global-544-");
	mkdirSync(join(dir, "extensions"), { recursive: true });
	writeFileSync(
		join(dir, "extensions", "foo.js"),
		`import { writeFileSync } from "node:fs";\n\nexport default function (api) {\n\tapi.on("agent_end", () => {\n\t\twriteFileSync(${JSON.stringify(marker)}, "foo ran\\n");\n\t});\n}\n`,
	);
	writeFileSync(join(dir, "extensions", "broken.js"), `export default function ( { ${BROKEN_SENTINEL}\n`);
	return dir;
}

test("a loose overlay extensions/foo.js acts in a job, and a broken one beside it is logged by name (issue #544)", { skip }, async () => {
	const root = tempDir("pi-dispatch-544-");
	const workspace = join(root, "workspace");
	const jobPi = join(root, "job", "pi");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(jobPi, { recursive: true });
	const guardrailsPath = join(root, "HARD_RULES.md");
	writeFileSync(guardrailsPath, "## Operating rules\nNever merge.\n");
	const marker = join(root, "foo-ran");
	const globalPiDir = overlay(marker);

	const modelsPath = join(root, "models.json");
	writeFileSync(modelsPath, `${JSON.stringify({ providers: { [PROVIDER]: { apiKey: "pi-dispatch-fake-key-sentinel", baseUrl: "http://127.0.0.1:1", api: API, models: [{ id: MODEL_ID, name: "pi-dispatch fake", api: API, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] } } })}\n`);
	const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir: root, modelsPath });
	const settingsManager = pi.SettingsManager.inMemory({});
	const sessionManager = pi.SessionManager.inMemory(workspace);
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: sessionManager.getSessionId() });
	const installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: modelRuntime, meter, log: () => {} });
	assert.equal(installed.ok, true);
	const calls = [];
	modelRuntime.registerProvider(PROVIDER, {
		api: API,
		streamSimple(m) {
			calls.push(m.id);
			const stream = installed.module.createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "done" }], api: m.api, provider: m.provider, model: m.id, usage: USAGE, stopReason: "stop", timestamp: Date.now() } });
			return stream;
		},
	});
	await modelRuntime.refresh({ allowNetwork: false });

	const logged = [];
	let session;
	try {
		const resourceLoader = await loaderModule.buildLoadedResourceLoader({
			cwd: workspace,
			jobPiDir: jobPi,
			globalPiDir,
			guardrailsPath,
			outboxProtocolPath: join(root, "absent-outbox-protocol.md"),
			outboxMount: join(root, "absent-outbox"),
			triggerSkillsDir: join(root, "absent-trigger-skills"),
			allowGlobalExtensions: true,
			packagePaths: [],
			settingsManager,
			log: (event, fields) => logged.push({ event, ...fields }),
		});
		({ session } = await pi.createAgentSession({ cwd: workspace, agentDir: root, modelRuntime, model: modelRuntime.getModel(PROVIDER, MODEL_ID), settingsManager, sessionManager, resourceLoader, noTools: "all" }));
		await session.prompt("do the task");
	} finally {
		session?.dispose();
		installed.uninstall();
	}

	assert.deepEqual(calls, [MODEL_ID], "the job ran its one call");
	assert.ok(existsSync(marker), "the loose overlay extension did not act during the job");
	assert.equal(readFileSync(marker, "utf8"), "foo ran\n");

	const failures = logged.filter((line) => line.event === "extension_load_failed");
	assert.deepEqual(failures, [{ event: "extension_load_failed", extensions: [{ entry: "broken.js", root: join(globalPiDir, "extensions"), kind: "load" }] }], JSON.stringify(logged));
	assert.ok(!JSON.stringify(logged).includes(BROKEN_SENTINEL), "the broken extension's source reached the log");
});
