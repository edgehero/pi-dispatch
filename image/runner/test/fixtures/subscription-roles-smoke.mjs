/**
 * Offline proof of the `subscriptionRoles` capability (issue #946) against the image's own runner code: on a subscription
 * whose adapter the runner admitted and sealed, the job's `subagent` tool runs its child inside the runner, on that sealed
 * runtime, and the parent goes on. Everything a job builds for it is the runner's own: the credential and registration
 * guards (subscription-credentials.mjs, community-auth-adapter.mjs), the process meter and the model guard
 * (usage-meter.mjs), the role tool (model-roles.mjs), the in-process child (role-child-session.mjs) and its loader
 * (loader.mjs). Only the adapter is a stand-in: an inline factory registering a marked transport that answers locally,
 * the way the runner's own tests register one. No network, no provider and no real credential: the access token is a
 * fake string, and nothing is dialled.
 *
 * Proved: the parent's call answers with the child's text and the parent's next turn runs; the child's call carried the
 * subscription's token, was counted by the meter as a second session and judged by the model guard; the child was told
 * the guardrails and the agent's prompt, held the agent's tools less the trigger's exclusions and no `subagent`; no
 * provider was registered or unregistered after the seal, so the admission still holds; and before the seal the same
 * call is refused as `subscription-child-unsupported`, with nothing started. *
 * And the wiring, which a fixture that builds the modules itself cannot prove: `verifySubscriptionRolesRunner` runs the
 * runner itself, `run-job.mjs`, as the worker starts it, on an OpenAI subscription with a role map, every request answered
 * inside the process (`subscriptionRunnerJob`). Run directly, as the image's conformance script does, this file runs both.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pi from "@earendil-works/pi-coding-agent";
import { installSubscriptionRegistrationGuard } from "../../src/community-auth-adapter.mjs";
import { jobSettings } from "../../src/config.mjs";
import { buildRoleChildResourceLoader } from "../../src/loader.mjs";
import { DEFAULT_MERGE_RULE, MERGE_POLICY_INPUT, PERMITTED_MERGE_RULE } from "../../src/merge-policy.mjs";
import { createRoleSubagents } from "../../src/model-roles.mjs";
import { createJobModelRuntime, loadPiAuthStorage } from "../../src/model-runtime.mjs";
import { createRoleChildSessions } from "../../src/role-child-session.mjs";
import { installSubscriptionCredentials } from "../../src/subscription-credentials.mjs";
import { createPolicyGuard, createUsageMeter, installProcessUsageMeter, notionalProviders } from "../../src/usage-meter.mjs";

export const ADAPTER = "pi-anthropic-oauth@0.3.11";
export const TOKEN = "sk-ant-oat01-fixture-not-a-token";
const MARKER = Symbol.for("pi-dispatch.subscription-adapter");
const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * A subscription job's runner as far as the prompt, in `root`: the runtime, both subscription guards, the meter and the
 * model guard installed, and a staged role map. `answer(call)` scripts the fake transport: given `{ who, turn, context,
 * options }` it returns the assistant content of that call (`who` is "root" or "child", `turn` counts that one's calls).
 * Returns what a test needs, and `close()`, which uninstalls everything in the order the runner would.
 */
export async function subscriptionJob({ root, answer, agents, extraModels = [], excludeTools = [], mayMerge = false, inProcess = true, childPi = null, settings = jobSettings({ maxRetries: 7 }) }) {
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	const jobPiDir = join(root, "job", "pi");
	const globalPiDir = join(root, "global");
	for (const dir of [agentDir, workspace, join(jobPiDir, "skills"), globalPiDir]) mkdirSync(dir, { recursive: true });
	const guardrailsPath = join(root, "HARD_RULES.md");
	writeFileSync(guardrailsPath, "GUARDRAILS-SENTINEL\n");
	const env = { ANTHROPIC_OAUTH_TOKEN: TOKEN };
	const now = Date.now();
	const entries = [{ provider: "anthropic", adapter: ADAPTER, connectionId: "fixture", generation: 1, expiresAt: now + 3_600_000, deadlineAt: now + 1_800_000, root: "/opt/fixture-adapter", digest: "a".repeat(64) }];
	const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, AuthStorage: await loadPiAuthStorage(), agentDir, modelsPath: join(agentDir, "models.json"), subscriptionAuth: entries, env });
	const credentials = installSubscriptionCredentials({ ModelRuntime: pi.ModelRuntime, entries, env });
	const registration = installSubscriptionRegistrationGuard({ ModelRuntime: pi.ModelRuntime, entries });
	const listed = modelRuntime.getModels("anthropic").filter((model) => model.api === "anthropic-messages" && !(model.compat?.allowedFallbackModels?.length));
	assert.ok(listed.length >= 2, "the pinned catalog holds Anthropic models");
	const parent = `anthropic/${listed[0].id}`;
	const allowedModels = [{ provider: "anthropic", model: listed[0].id }];
	const sessionManager = pi.SessionManager.inMemory(workspace);
	const rootSessionId = sessionManager.getSessionId();
	const logged = [];
	const stops = [];
	const log = (event, fields) => logged.push({ event, fields });
	const subscriptionAdmission = (provider) => registration.admitted(provider);
	const notional = notionalProviders({ subscriptions: entries, subscriptionAdmission, allowedModels });
	const meter = createUsageMeter({ maxTokens: null, allowedModels, rootSessionId, notionalProviders: notional, onStop: (reason) => stops.push(reason) });
	const guard = createPolicyGuard({ allowedModels, log, env, subscriptionAdmission, subscriptions: entries, notional });
	const installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: modelRuntime, meter, guard, log });
	assert.equal(installed.ok, true, `the meter installs: ${JSON.stringify(logged)}`);
	// Every registration call on any runtime from here on, beside the guard's own wrappers.
	const registrations = [];
	const spied = new Map();
	for (const name of ["registerProvider", "registerNativeProvider", "unregisterProvider"]) {
		const inner = pi.ModelRuntime.prototype[name];
		const spy = function (...args) {
			registrations.push(name);
			return inner.apply(this, args);
		};
		spied.set(name, { inner, spy });
		pi.ModelRuntime.prototype[name] = spy;
	}
	const calls = [];
	const streamSimple = function (model, context, options) {
		const who = options?.sessionId === rootSessionId ? "root" : "child";
		const turn = calls.filter((call) => call.who === who).length + 1;
		// At the pin the system prompt and the tools a call offers ride its system messages (`sections`, `toolsAdded`).
		const system = (context.messages ?? []).filter((message) => message.role === "system");
		const call = { who, turn, model: model.id, sessionId: options?.sessionId, token: options?.apiKey === TOKEN, system: JSON.stringify(system), tools: system.flatMap((message) => message.toolsAdded ?? []).map((tool) => tool.name), context, options };
		calls.push(call);
		const stream = installed.module.createAssistantMessageEventStream();
		const content = answer(call);
		const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: USAGE, timestamp: Date.now() };
		// A call the test holds open ("hold") answers only when its signal aborts, as a real transport does.
		if (content === "hold") {
			const aborted = () => {
				stream.push({ type: "error", reason: "aborted", error: { ...base, content: [], stopReason: "aborted", errorMessage: "aborted" } });
				stream.end();
			};
			if (options?.signal?.aborted) queueMicrotask(aborted);
			else options?.signal?.addEventListener("abort", aborted, { once: true });
			return stream;
		}
		const stopReason = content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
		queueMicrotask(() => {
			stream.push({ type: "done", reason: stopReason, message: { ...base, content, stopReason } });
			stream.end();
		});
		return stream;
	};
	Object.defineProperty(streamSimple, MARKER, { value: ADAPTER });
	const adapter = (api) => api.registerProvider("anthropic", { api: "anthropic-messages", streamSimple });
	// The root's settings as the runner builds them (config.mjs `jobSettings`), which a child copies.
	const settingsManager = pi.SettingsManager.inMemory(settings);
	// `agents` may be a function of the catalog's models, for an agent that names one; `extraModels` widens the role map's
	// list (never the job's allowed list) by catalog index.
	const inputs = { document: { version: 1, roles: {}, parent, models: [parent, ...extraModels.map((index) => `anthropic/${listed[index].id}`)] }, agents: typeof agents === "function" ? agents(listed) : agents };
	const roleChildren = inProcess ? { subscriptions: entries.map((row) => row.provider), admitted: (provider) => registration.admitted(provider), inProcess: createRoleChildSessions({ modelRuntime, settingsManager, agentDir, ...(childPi && { pi: childPi }), loader: ({ agentPrompt, settingsManager: settings }) => buildRoleChildResourceLoader({ cwd: workspace, guardrailsPath, jobPiDir, globalPiDir, triggerSkillsDir: join(root, "job", "trigger-skills"), agentDir, mayMerge, settingsManager: settings, agentPrompt }) }) } : {};
	// A separate pi process is never the route here: counted, never started.
	const processStarts = [];
	const runChild = async (call) => {
		processStarts.push(call.model);
		return { exitCode: 1, text: "a separate pi process" };
	};
	const roleSubagents = createRoleSubagents(inputs, { runChild, excludeTools, ...roleChildren });
	const resourceLoader = new pi.DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager, noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, extensionFactories: [adapter, ...roleSubagents.factories] });
	await resourceLoader.reload();
	const { session } = await pi.createAgentSession({ cwd: workspace, agentDir, modelRuntime, model: listed[0], settingsManager, sessionManager, resourceLoader, ...(excludeTools.length > 0 && { excludeTools }) });
	const sealedAt = registrations.length;
	/** The same tool, outside the session (the closure it shares is the one the session's copy runs). */
	const tool = () => {
		let found;
		roleSubagents.factories[0].factory({ registerTool: (value) => { found = value; }, on() {} });
		return found;
	};
	const context = () => ({ cwd: workspace, model: session.model, thinkingLevel: session.thinkingLevel });
	return {
		session, modelRuntime, registration, meter, guard, calls, logged, stops, roleSubagents, listed, parent, tool, context, rootSessionId, processStarts,
		seal: () => registration.seal(modelRuntime),
		registrationsAfterSeal: () => registrations.slice(sealedAt),
		async close() {
			session.dispose();
			installed.uninstall();
			for (const [name, { inner, spy }] of spied) if (pi.ModelRuntime.prototype[name] === spy) pi.ModelRuntime.prototype[name] = inner;
			registration.uninstall();
			credentials.uninstall();
			await modelRuntime.refresh({ allowNetwork: false });
		},
	};
}

export async function verifySubscriptionRoles(root) {
	const job = await subscriptionJob({
		root,
		agents: [{ name: "checker", description: "checks the work", content: "AGENT-PROMPT-SENTINEL", tools: ["read", "bash"] }],
		excludeTools: ["bash"],
		answer: ({ who, turn }) => who === "root" && turn === 1
			? [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { agent: "checker", task: "check the work" } }]
			: [{ type: "text", text: who === "root" ? "parent done" : "checked by the child" }],
	});
	try {
		// Before the seal the provider is not admitted, so the call is refused before any child exists.
		const early = await job.tool().execute("early", { agent: "checker", task: "too early" }, undefined, undefined, job.context());
		assert.equal(early.details.reason, "subscription-child-unsupported");
		assert.equal(job.calls.length, 0, "nothing started before the seal");
		job.seal();
		await job.session.prompt("Run the checker once.");
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(job.processStarts, [], "no separate pi process was started");
		assert.deepEqual(job.calls.map((call) => `${call.who}:${call.turn}`), ["root:1", "child:1", "root:2"], "the child answered in process and the parent went on");
		const child = job.calls[1];
		assert.equal(child.model, job.listed[0].id, "an agent with no model line inherits the parent's");
		assert.ok(job.calls.every((call) => call.token), "every call carried the subscription's token");
		assert.ok(child.system.includes("GUARDRAILS-SENTINEL") && child.system.includes("AGENT-PROMPT-SENTINEL"), "the child was told the guardrails and its agent's prompt");
		assert.deepEqual(child.tools, ["read"], "the agent's tools less the trigger's exclusions, and no subagent");
		const result = job.session.state.messages.find((message) => message.role === "toolResult");
		assert.equal(result?.isError, false);
		assert.equal(result?.content?.[0]?.text, "checked by the child");
		assert.equal(job.session.state.messages.at(-1).content[0].text, "parent done");
		const totals = job.meter.snapshot();
		assert.deepEqual([totals.calls, totals.sessions], [3, 2], "the meter counted the child's call, as another session's");
		assert.ok(totals.otherTotal > 0 && totals.rootTotal > 0);
		assert.equal(job.meter.state.stopReason, null);
		assert.equal(job.guard.snapshot().modelRefused, 0, "the model guard judged and admitted every call");
		assert.deepEqual(job.registrationsAfterSeal(), [], "no provider was registered or unregistered after the seal");
		assert.equal(job.registration.admitted("anthropic"), true, "so the admission still holds");
		assert.deepEqual(job.roleSubagents.snapshot().refusals.map((row) => row.reason), ["subscription-child-unsupported"], "only the call before the seal was refused");
	} finally {
		await job.close();
	}
}

/**
 * The baked runner itself (run-job.mjs), started as the worker starts it, on an OpenAI subscription (`openai-chatgpt`,
 * which needs no staged package), with a role map: the wiring as a job meets it, not a copy of it. Its container mounts
 * live under `root` (fixtures/remap-roots.mjs), and a preload replaces `fetch` before the runner loads, so every request
 * is answered here and none can reach a network: the parent's first call asks for the `subagent`, the child answers, the
 * parent's next call ends the job. `latch` adds an overlay extension that registers `openai` again when the parent calls
 * the tool, which latches the guard's conflict before the tool runs. `mayMerge` stages the job's merge permission.
 * Resolves with the exit code, the decisive exit line and what each request carried.
 */
export async function subscriptionRunnerJob({ root, latch = false, mayMerge = false, ownProcesses = false, tool = "subagent", extension = null, notional = false, allowanceMicros = null, maxCostMicros = null, timeoutMs = 60_000 }) {
	for (const dir of ["job/pi/skills", "workspace", "session", "outbox", "opt/pi-global/extensions", "opt/pi-dispatch", "home", "tmp"]) mkdirSync(join(root, dir), { recursive: true });
	writeFileSync(join(root, "job", "prompt.md"), "Run the checker once.\n");
	// The image's guardrails carry the default merge rule; this file does too, so the merge permission is told as it is.
	writeFileSync(join(root, "opt", "pi-dispatch", "HARD_RULES.md"), `GUARDRAILS-SENTINEL\n\n${DEFAULT_MERGE_RULE}\n`);
	for (const name of ["OUTBOX_PROTOCOL.md", "PORTFOLIO_PROTOCOL.md", "ARTIFACTS_PROTOCOL.md"]) writeFileSync(join(root, "opt", "pi-dispatch", name), `## ${name}\n`);
	if (mayMerge) writeFileSync(join(root, "job", "merge-policy.json"), MERGE_POLICY_INPUT);
	const ref = "openai/gpt-4.1";
	writeFileSync(join(root, "job", "model-roles.json"), JSON.stringify({ version: 1, roles: {}, parent: ref, models: [ref] }));
	writeFileSync(join(root, "job", "agents.json"), JSON.stringify({ version: 1, agents: [{ name: "checker", description: "checks the work", content: "AGENT-PROMPT-SENTINEL" }] }));
	if (extension !== null) writeFileSync(join(root, "opt", "pi-global", "extensions", "job-tool.js"), extension);
	if (latch) writeFileSync(join(root, "opt", "pi-global", "extensions", "latch.js"), `export default function (pi) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "subagent") return;
		try { pi.registerProvider("openai", { api: "openai-responses", streamSimple() {} }); } catch {}
	});
}
`);
	const requests = join(root, "requests.jsonl");
	// Every request answered in the process and nothing let out (fixtures/offline-fetch.mjs), in the runner and in any pi
	// child it starts, which inherits the preload and these variables.
	const preload = fileURLToPath(new URL("./offline-fetch.mjs", import.meta.url));
	const escaped = (text) => JSON.stringify(text).slice(1, -1);
	const offline = {
		OFFLINE_FETCH_LOG: requests,
		OFFLINE_FETCH_TOOL: tool,
		OFFLINE_FETCH_ARGS: JSON.stringify(tool === "subagent" ? { agent: "checker", task: "check the work" } : {}),
		OFFLINE_FETCH_ANSWER: "checked by the child",
		OFFLINE_FETCH_PROBES: JSON.stringify({ guardrails: "GUARDRAILS-SENTINEL", agentPrompt: "AGENT-PROMPT-SENTINEL", defaultMerge: escaped(DEFAULT_MERGE_RULE.slice(0, 40)), permittedMerge: escaped(PERMITTED_MERGE_RULE.slice(0, 40)) }),
	};
	const at = Date.now();
	const binding = { provider: "openai", adapter: "openai-chatgpt", connectionId: "fixture", generation: 1, expiresAt: at + 2 * 3_600_000, deadlineAt: at + 1_800_000, ...(notional ? { notional: true } : {}) };
	const child = spawn(process.execPath, [`--import=${fileURLToPath(new URL("./remap-roots.mjs", import.meta.url))}`, fileURLToPath(new URL("../../run-job.mjs", import.meta.url))], {
		env: {
			PATH: process.env.PATH,
			HOME: join(root, "home"),
			TMPDIR: join(root, "tmp"),
			PI_DISPATCH_TEST_ROOT: root,
			PI_JOB_ID: "pi-job-subscription-roles",
			PI_PROVIDER: "openai",
			PI_MODEL: "gpt-4.1",
			PI_ALLOWED_MODELS: ref,
			PI_MAX_TURNS: "4",
			PI_OFFLINE: "1",
			PI_SUBSCRIPTION_AUTH: JSON.stringify([binding]),
			OPENAI_API_KEY: "fixture.oauth.access",
			PI_MODEL_ROLES_FILE: "/job/model-roles.json",
			PI_AGENTS_FILE: "/job/agents.json",
			NODE_OPTIONS: `--import=${preload}`,
			...offline,
			...(allowanceMicros !== null ? { PI_SUBSCRIPTION_ALLOWANCE_MICROS: String(allowanceMicros) } : {}),
			...(maxCostMicros !== null ? { PI_MAX_COST_MICROS: String(maxCostMicros) } : {}),
			// A suite on a Linux host runs other jobs beside this one; the runner's child detector is then shown only this
			// job's own processes, as in a container (fixtures/remap-roots.mjs). The image's own run, in a container, needs none.
			...(ownProcesses ? { PI_DISPATCH_TEST_OWN_PROC: "1" } : {}),
		},
		cwd: join(root, "workspace"),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	const code = await new Promise((resolve) => child.on("close", (exitCode) => resolve(exitCode)));
	clearTimeout(timer);
	const lines = stdout.split("\n").flatMap((line) => { try { return line.startsWith("{") ? [JSON.parse(line)] : []; } catch { return []; } });
	const sent = existsSync(requests) ? readFileSync(requests, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	return { code, exit: lines.findLast((line) => line.event === "exit"), lines, requests: sent, stderr };
}

/** The runner's own wiring: the parent's call answered by an in-process child, admitted, metered, and the job completes. */
export async function verifySubscriptionRolesRunner(root, { ownProcesses = false } = {}) {
	const job = await subscriptionRunnerJob({ root, ownProcesses });
	const said = `${JSON.stringify(job.exit)}\n${job.stderr.slice(-2000)}`;
	assert.equal(job.code, 0, said);
	assert.deepEqual(job.requests.map((request) => request.who), ["root", "child", "root"], `the child answered in process and the parent went on: ${said}`);
	assert.ok(job.requests.every((request) => request.token && request.model === "gpt-4.1"), "every call carried the subscription's token");
	const [, child] = job.requests;
	assert.ok(!child.tools.includes("subagent"), "the child has no subagent of its own");
	assert.ok(child.guardrails && child.agentPrompt && child.defaultMerge && !child.permittedMerge, "the child was told the guardrails, for this job's merge permission, and its agent's prompt");
	assert.deepEqual(job.exit.modelRoles, { refusals: [] });
	assert.deepEqual([job.exit.tokens.calls, job.exit.tokens.sessions, job.exit.tokens.childProcesses, job.exit.tokens.modelRefused], [3, 2, 0, 0], "metered as a second session of the runner, no separate process, nothing refused");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	for (const proof of [verifySubscriptionRoles, verifySubscriptionRolesRunner]) {
		const root = mkdtempSync(join(tmpdir(), "pi-subscription-roles-"));
		try {
			await proof(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
	console.log("subscription role capability holds");
}
