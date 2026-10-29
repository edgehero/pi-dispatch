// env-internal PI_MODEL_ROLES_FILE: worker-staged read-only model policy.
// env-internal PI_AGENTS_FILE: worker-staged trusted agent definitions.
/** Issue #717: resolve reviewed roles before a child exists. The normal child meter remains authoritative. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configError } from "./outcome.mjs";
import { RUN_JOB_PATH } from "./child-route.mjs";
import { LAYOUT } from "./layout.mjs";

export const ROLE_SUBAGENT_TOOL = "subagent";
export const ROLE_SUBAGENT_FACTORY = "job-role-subagent";
const OURS = `<inline:${ROLE_SUBAGENT_FACTORY}>`;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Same grammar as worker/src/model-ref.mjs, pinned by a differential test across the boundary.
export const roleModelPair = (value) => {
	if (typeof value !== "string" || !/^[\x21-\x7E]+$/.test(value)) return false;
	const slash = value.indexOf("/");
	return slash > 0 && /^(?=.{1,64}$)[a-z0-9][a-z0-9._-]*$/.test(value.slice(0, slash).toLowerCase()) && /^(?=.{1,64}$)[~@]?[a-z0-9][a-z0-9._:/@_-]*$/.test(value.slice(slash + 1).toLowerCase());
};
const pair = roleModelPair;
const role = (value) => typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
const bounded = (value, max) => typeof value === "string" && value.length <= max;

export function validateRoleInputs(document, agents) {
	if (!object(document) || document.version !== 1 || !object(document.roles) || !pair(document.parent) || !Array.isArray(document.models) || document.models.length < 1 || document.models.length > 16 || !document.models.every(pair)) throw configError("the model role input is invalid", "model-roles-invalid");
	if (Object.keys(document.roles).length > 32 || !Object.entries(document.roles).every(([name, model]) => role(name) && !["inherit", "constructor", "prototype"].includes(name) && pair(model))) throw configError("the model role map is invalid", "model-roles-invalid");
	if (!object(agents) || agents.version !== 1 || !Array.isArray(agents.agents) || agents.agents.length > 128) throw configError("the agent snapshot is invalid", "model-roles-invalid");
	const names = new Set();
	for (const agent of agents.agents) {
		if (!object(agent) || !role(agent.name) || names.has(agent.name) || !bounded(agent.description, 4096) || !bounded(agent.content, 131072) || (agent.model !== undefined && !bounded(agent.model, 256)) || (agent.tools !== undefined && (!Array.isArray(agent.tools) || agent.tools.length > 128 || !agent.tools.every((tool) => bounded(tool, 128) && tool.length > 0)))) throw configError("an agent snapshot entry is invalid", "model-roles-invalid");
		names.add(agent.name);
	}
	return { document: structuredClone(document), agents: structuredClone(agents.agents) };
}

export function readRoleInputs(env = process.env, read = readFileSync) {
	const path = env.PI_MODEL_ROLES_FILE;
	if (path === undefined || path === "") return null;
	// A closed path prevents an environment typo from turning a workspace file into operator policy.
	if (path !== `${LAYOUT.job}/model-roles.json` || env.PI_AGENTS_FILE !== `${LAYOUT.job}/agents.json`) throw configError("the model role input paths are invalid", "model-roles-invalid");
	try {
		const roles = read(path, "utf8");
		const agents = read(env.PI_AGENTS_FILE, "utf8");
		if (roles.length > 262144 || agents.length > 16777216) throw new Error("too large");
		return validateRoleInputs(JSON.parse(roles), JSON.parse(agents));
	} catch {
		throw configError("the model role inputs cannot be read", "model-roles-invalid");
	}
}

export function resolveAgentModel(value, document, parent = document.parent) {
	const inherited = value === undefined || value === "inherit";
	const name = typeof value === "string" ? value.replace(/^role:/, "") : "";
	const model = inherited ? parent : Object.hasOwn(document.roles, name) ? document.roles[name] : pair(value) ? value : null;
	if (model === null || !pair(model)) return { reason: "unknown-role" };
	if (!document.models.includes(model)) return { reason: "model-not-allowed" };
	return { model };
}

/** The same nested-runner route the pinned pi example uses, with bounded output and guaranteed prompt cleanup. */
export async function runRoleChild({ agent, task, model, signal, cwd, thinkingLevel }, { spawnChild = spawn } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-role-agent-"));
	try {
		const prompt = join(dir, "system.md");
		writeFileSync(prompt, agent.content, { mode: 0o600 });
		const args = [RUN_JOB_PATH, "--mode", "json", "-p", "--no-session", "--model", model, "--append-system-prompt", prompt];
		if (thinkingLevel) args.push("--thinking", thinkingLevel);
		if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
		args.push("--", task);
		return await new Promise((resolve) => {
			const child = spawnChild(process.execPath, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			let size = 0;
			let limited = false;
			let settled = false;
			const abort = () => child.kill("SIGTERM");
			const finish = (result) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				resolve(result);
			};
			child.stdout.on("data", (chunk) => {
				size += chunk.length;
				if (size > 1048576) { limited = true; abort(); return; }
				output += chunk.toString();
			});
			// Provider diagnostics may contain secrets; never forward raw stderr to a tool result.
			child.stderr.on("data", () => {});
			child.once("error", () => finish({ exitCode: 1, text: "the subagent process could not start" }));
			child.once("close", (code) => {
				let text = "";
				for (const line of output.split("\n")) {
					try {
						const event = JSON.parse(line);
						if (event.type === "message_end" && event.message?.role === "assistant") text = (event.message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
					} catch { /* A child's non-protocol stdout is never a result. */ }
				}
				finish({ exitCode: limited ? 1 : code ?? 1, text: limited ? "the subagent exceeded its output limit" : text || "the subagent returned no text" });
			});
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function roleSubagentShadow(tools) {
	return tools.some((tool) => tool.name === ROLE_SUBAGENT_TOOL && tool.sourceInfo?.path !== OURS) ? ROLE_SUBAGENT_TOOL : null;
}

export function createRoleSubagents(inputs, { runChild = runRoleChild } = {}) {
	const { document, agents } = validateRoleInputs(inputs.document, { version: 1, agents: inputs.agents });
	const refusals = [];
	const refuse = (name, reason) => {
		if (refusals.length < 8) refusals.push({ agentHash: createHash("sha256").update(String(name)).digest("hex"), reason });
		return { content: [{ type: "text", text: `Subagent ${JSON.stringify(name)} refused: ${reason}` }], details: { reason }, isError: true };
	};
	return {
		snapshot: () => ({ refusals: structuredClone(refusals) }),
		factories: [{ name: ROLE_SUBAGENT_FACTORY, factory: (api) => {
			api.registerTool({
				name: ROLE_SUBAGENT_TOOL, label: "subagent", description: `Delegate to a reviewed agent snapshot. Available agents: ${agents.map((agent) => `${agent.name}: ${agent.description}`).join("; ")}`,
				parameters: { type: "object", properties: { agent: { type: "string" }, task: { type: "string", minLength: 1, maxLength: 131072 }, tasks: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", properties: { agent: { type: "string" }, task: { type: "string" } }, required: ["agent", "task"], additionalProperties: false } }, chain: { type: "array", minItems: 1, maxItems: 16, items: { type: "object", properties: { agent: { type: "string" }, task: { type: "string" } }, required: ["agent", "task"], additionalProperties: false } } }, additionalProperties: false },
				async execute(_id, args, signal, _update, ctx) {
					const validTask = (task) => object(task) && Object.keys(task).every((key) => key === "agent" || key === "task") && bounded(task.agent, 64) && bounded(task.task, 131072) && task.task.trim();
					if (!object(args)) return refuse("", "invalid-arguments");
					const modes = Number(args.agent !== undefined || args.task !== undefined) + Number(args.tasks !== undefined) + Number(args.chain !== undefined);
					if (modes !== 1 || Object.keys(args).some((key) => !["agent", "task", "tasks", "chain"].includes(key))) return refuse("", "invalid-arguments");
					const tasks = args.tasks ?? args.chain ?? [args];
					if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > (args.chain ? 16 : args.tasks ? 4 : 1) || !tasks.every(validTask)) return refuse("", "invalid-arguments");
					// Validate the entire batch before any child starts, so a later typo cannot spend on its siblings.
					for (const task of tasks) {
						const agent = agents.find((candidate) => candidate.name === task.agent);
						if (!agent) return refuse(task.agent, "unknown-agent");
						const parent = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : document.parent;
						const resolved = resolveAgentModel(agent.model, document, parent);
						if (resolved.reason) return refuse(agent.name, resolved.reason);
					}
					const execute = async (args) => {
					if (!bounded(args.task, 131072)) return refuse(args.agent, "invalid-arguments");
					const agent = agents.find((candidate) => candidate.name === args.agent);
					const parent = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : document.parent;
					const result = resolveAgentModel(agent.model, document, parent);
					if (result.reason) return refuse(agent.name, result.reason);
					if (signal?.aborted) return refuse(agent.name, "aborted");
					const child = await runChild({ agent, task: args.task, model: result.model, cwd: ctx.cwd, signal, ...((agent.model === undefined || agent.model === "inherit") && { thinkingLevel: ctx.thinkingLevel }) });
					return { content: [{ type: "text", text: child.text }], details: { agent: agent.name, model: result.model, exitCode: child.exitCode }, ...(child.exitCode !== 0 && { isError: true }) };
					};
					if (args.tasks) {
						const results = await Promise.all(tasks.map(execute));
						return { content: results.flatMap((result) => result.content), details: { results: results.map((result) => result.details) }, ...(results.some((result) => result.isError) && { isError: true }) };
					}
					let result;
					let previous = "";
					for (const task of tasks) {
						result = await execute({ ...task, task: args.chain ? task.task.replaceAll("{previous}", previous) : task.task });
						if (result.isError) return result;
						previous = result.content.map((part) => part.text).join("\n");
					}
					return result;
				},
			});
			api.on("tool_call", (event) => event.toolName === ROLE_SUBAGENT_TOOL && roleSubagentShadow(api.getAllTools()) ? { block: true, reason: "another extension registered the job's subagent tool" } : undefined);
		} }],
	};
}
