import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trackPiRefreshes } from "./track-pi-refreshes.mjs";

/**
 * Issue #645: a real pi session on a scripted offline model, shared by recover.test.mjs and the child it kills
 * (fixtures/recover-child.mjs). The model is report-progress.test.mjs's: declared in a models.json of its own (a
 * literal key, baseUrl on the unbound port 1) and served by a streamSimple registered on the runtime, so nothing is
 * dialled. Builtin tools stay ON (unlike the progress tests' `noTools: "builtin"`): recovery is about them.
 *
 * pi is handed in rather than imported, so a file that gates on pi being importable can import this one first.
 */

export const PROVIDER = "pi-dispatch-recover-fake";
export const MODEL_ID = "fake-1";
export const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** The directories and files a session needs, under `root` (a directory the caller made). */
export function sessionFixture(root) {
	const workspace = join(root, "workspace");
	const jobPi = join(root, "job", "pi");
	const sessionDir = join(root, "session");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(join(jobPi, "skills"), { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	const guardrailsPath = join(root, "HARD_RULES.md");
	writeFileSync(guardrailsPath, "## Operating rules\n");
	const outboxProtocolPath = join(root, "OUTBOX_PROTOCOL.md");
	writeFileSync(outboxProtocolPath, "## Outbox\n");
	// Staged empty, as the worker stages PI_SESSION_FILE on a cold start (INT-SESSION-STORE-CONTRACT).
	const sessionFile = join(sessionDir, "current.jsonl");
	writeFileSync(sessionFile, "", { flag: "a" });
	return { root, workspace, jobPi, guardrailsPath, outboxProtocolPath, sessionFile };
}

/** An assistant message in the shape the scripted model produces. */
export function assistantMessage(content, { stopReason = content.some((part) => part.type === "toolCall") ? "toolUse" : "stop", api = "pi-dispatch-recover-api" } = {}) {
	return { role: "assistant", content, api, provider: PROVIDER, model: MODEL_ID, usage: USAGE, stopReason, timestamp: Date.now() };
}

/**
 * The runtime: one assistant message per call from `script` (the last repeats), each request's context kept in
 * `contexts` so a test can read what the model was sent. `onCall(n)` (1-based), when given, runs before call n is
 * answered, so a test can change the world while that request is in flight (inbox.test.mjs writes a steer file there).
 */
export async function scriptedRuntime({ pi, piAi, createJobModelRuntime }, root, api, script, { onCall, reasoning = false } = {}) {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const modelsPath = join(agentDir, "models.json");
	const definition = { id: MODEL_ID, name: "fake", api, reasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 };
	writeFileSync(modelsPath, `${JSON.stringify({ providers: { [PROVIDER]: { apiKey: "pi-dispatch-recover-fake-key", baseUrl: "http://127.0.0.1:1", api, models: [definition] } } })}\n`);
	// A registration starts its own unawaited refresh. Awaiting the explicit refresh below cannot settle that
	// sibling, whose credential read can recreate auth.json after this test's temporary directory was removed.
	trackPiRefreshes(pi.ModelRuntime);
	const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir, modelsPath });
	const contexts = [];
	modelRuntime.registerProvider(PROVIDER, {
		api,
		streamSimple(model, context, options) {
			contexts.push({ model, messages: context.messages.slice(), reasoning: options?.reasoning });
			onCall?.(contexts.length);
			const content = script[Math.min(contexts.length - 1, script.length - 1)];
			const message = { ...assistantMessage(content, { api: model.api }), provider: model.provider, model: model.id };
			const stream = piAi.createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message }));
			return stream;
		},
	});
	await modelRuntime.refresh({ allowNetwork: false });
	return { agentDir, modelRuntime, model: modelRuntime.getModel(PROVIDER, MODEL_ID), contexts };
}

/** A real AgentSession over `sessionManager`, with the runner's loader and the given inline extension factories. */
export async function scriptedSession(deps, f, { api, script, sessionManager, extensionFactories = [], excludeTools = [], onCall, reasoning = false, thinkingLevel }) {
	const { pi, loaderModule } = deps;
	const loader = await loaderModule.buildLoadedResourceLoader({ cwd: f.workspace, jobPiDir: f.jobPi, guardrailsPath: f.guardrailsPath, outboxProtocolPath: f.outboxProtocolPath, packagePaths: [], ...(extensionFactories.length > 0 && { extensionFactories }) });
	const runtime = await scriptedRuntime(deps, f.root, api, script, { onCall, reasoning });
	const { session } = await pi.createAgentSession({
		cwd: f.workspace,
		agentDir: runtime.agentDir,
		modelRuntime: runtime.modelRuntime,
		model: runtime.model,
		...(thinkingLevel !== undefined && { thinkingLevel }),
		settingsManager: pi.SettingsManager.inMemory({}),
		sessionManager,
		resourceLoader: loader,
		...(excludeTools.length > 0 && { excludeTools }),
	});
	return { session, contexts: runtime.contexts, model: runtime.model, loader };
}
