import { execFile } from "node:child_process";
import { lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseDocument } from "yaml";
import { GIT_READ_FLAGS } from "./git-hardening.mjs";
import { MODEL_ROLE_RE } from "./model-roles.mjs";

// env-internal PATH: the host git executable search path, never passed to a job as policy.
const exec = promisify(execFile);
const gitRead = async (workspace, args) => (await exec("git", [...GIT_READ_FLAGS, `--git-dir=${join(workspace, ".git")}`, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } })).stdout;

export function parseAgentDefinition(text) {
	try {
		if (typeof text !== "string" || text.length > 131072) throw new Error("agent definition is too large");
		const match = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
		if (!match) throw new Error("agent definition needs frontmatter");
		const doc = parseDocument(match[1], { uniqueKeys: true, maxAliasCount: 0 });
		if (doc.errors.length) throw new Error("agent frontmatter is invalid");
		const meta = doc.toJS({ maxAliasCount: 0 });
		if (!meta || typeof meta.name !== "string" || !MODEL_ROLE_RE.test(meta.name) || typeof meta.description !== "string" || meta.description.length > 4096 || (meta.model !== undefined && (typeof meta.model !== "string" || meta.model.length > 256))) throw new Error("agent frontmatter needs a bounded name, description and optional model");
		const tools = typeof meta.tools === "string" ? meta.tools.split(",").map((v) => v.trim()).filter(Boolean) : meta.tools;
		if (tools !== undefined && (!Array.isArray(tools) || tools.length > 128 || !tools.every((v) => typeof v === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(v)))) throw new Error("agent tools must be tool names");
		return { name: meta.name, description: meta.description, content: match[2], ...(meta.model !== undefined ? { model: meta.model } : {}), ...(tools !== undefined ? { tools } : {}) };
	} catch { throw Object.assign(new Error("agent frontmatter is invalid"), { piDispatchConfig: true }); }
}

/** Read blobs at the captured base, never agent-written worktree files or symlinks. */
export async function snapshotAgents({ workspace, sha }, { git = gitRead } = {}) {
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) || !lstatSync(join(workspace, ".git")).isDirectory()) throw new Error("agent snapshot needs a base commit");
	const tree = await git(workspace, ["ls-tree", "-r", "-z", sha, "--", ".pi/agents"]);
	const files = tree.split("\0").filter(Boolean).map((line) => line.match(/^(100644|100755) blob ([a-f0-9]+)\t(\.pi\/agents\/[^/]+\.md)$/)).filter(Boolean);
	if (files.length > 128) throw Object.assign(new Error("too many agent definitions"), { piDispatchConfig: true });
	const agents = [];
	for (const file of files) agents.push(parseAgentDefinition(await git(workspace, ["cat-file", "blob", file[2]])));
	if (new Set(agents.map((a) => a.name)).size !== agents.length) throw Object.assign(new Error("duplicate agent names"), { piDispatchConfig: true });
	return { version: 1, agents };
}

export async function stageModelRoleInputs(job, prepared, options = {}) {
	if (!job.modelRoles) return;
	const agents = await snapshotAgents(prepared, options);
	// JSON escaping can multiply a valid Markdown body's size. Refuse here, before reserves,
	// rather than let the runner reject its otherwise valid immutable input after container startup.
	const encodedAgents = JSON.stringify(agents);
	if (Buffer.byteLength(encodedAgents, "utf8") > 16 * 1024 * 1024) throw Object.assign(new Error("the agent snapshot exceeds 16 MiB"), { piDispatchConfig: true });
	writeFileSync(join(prepared.jobDir, "agents.json"), encodedAgents, { mode: 0o444, flag: "wx" });
	writeFileSync(join(prepared.jobDir, "model-roles.json"), JSON.stringify({ version: 1, roles: job.modelRoles, parent: `${job.provider}/${job.model}`, models: job.models }), { mode: 0o444, flag: "wx" });
}
