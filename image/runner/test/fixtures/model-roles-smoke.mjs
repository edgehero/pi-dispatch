// Offline image capability proof. The tool's child-spawn seam records resolved argv without spending tokens.
import assert from "node:assert/strict";
import { createRoleSubagents, readRoleInputs, roleSubagentShadow } from "../../src/model-roles.mjs";
const inputs = readRoleInputs();
assert.ok(inputs, "the declared role inputs must be read");
let starts = 0;
const extension = createRoleSubagents(inputs, { runChild: async ({ model }) => { starts++; return { exitCode: 0, text: model }; } });
let tool;
const tools = [];
extension.factories[0].factory({ registerTool: (value) => { tool = value; tools.push({ ...value, sourceInfo: { path: "<inline:job-role-subagent>" } }); }, getAllTools: () => tools, on() {} });
assert.equal(roleSubagentShadow(tools), null);
const ctx = { cwd: "/workspace", model: { provider: "test", id: "parent" } };
for (const [agent, model] of [["scout", "test/small"], ["inherited", "test/parent"]]) {
	const result = await tool.execute("id", { agent, task: "find" }, undefined, undefined, ctx);
	assert.equal(result.isError, undefined);
	assert.equal(result.content[0].text, model);
}
assert.equal((await tool.execute("id", { agent: "unknown-role", task: "find" }, undefined, undefined, ctx)).details.reason, "unknown-role");
assert.equal((await tool.execute("id", { agent: "off-list", task: "find" }, undefined, undefined, ctx)).details.reason, "model-not-allowed");
assert.equal(starts, 2, "policy refusals must not start children");
assert.equal(extension.snapshot().refusals.length, 2);
assert.match(extension.snapshot().refusals[0].agentHash, /^[a-f0-9]{64}$/);
console.log("model role capability holds");
