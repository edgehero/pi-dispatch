import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createAwaitInput } from "../src/await-input.mjs";
import { exactArguments, rawTypeProblem } from "../src/exact-arguments.mjs";
import { createRequestApproval } from "../src/request-approval.mjs";
import { createReportProgress } from "../src/report-progress.mjs";

const registered = (extension) => {
	const tools = [];
	for (const { factory } of extension.factories) factory({ registerTool: (tool) => tools.push(tool), on() {}, registerCommand() {}, registerShortcut() {}, registerFlag() {} });
	return tools;
};

test("every tool the runner defines goes through the rule: a new one cannot skip it", () => {
	const source = new URL("../src/", import.meta.url), direct = [];
	for (const file of readdirSync(source).filter((name) => name.endsWith(".mjs") && name !== "exact-arguments.mjs")) {
		for (const line of readFileSync(new URL(file, source), "utf8").split("\n")) {
			if (!/\.registerTool\(/.test(line)) continue;
			// Two sanctioned shapes, each built from already-wrapped tools; their tests below hold that.
			if (file === "watch-tools.mjs" && line.includes("for (const tool of exact)")) continue;
			if (file === "answerer.mjs" && /api\.registerTool\(t(ool)?\)/.test(line)) continue;
			direct.push(`${file}: ${line.trim().slice(0, 80)}`);
		}
	}
	assert.deepEqual(direct, [], "register through registerExact, or exactArguments the tool first");
});

test("a real report_progress refuses what pi 1.5.0 would have converted, and takes what is right", () => {
	const [tool] = registered(createReportProgress());
	for (const args of [{ phase: "p", done: 2.7 }, { phase: "p", done: -0.5 }, { phase: "p", done: "12n" }, { phase: "p", total: "3" }, { phase: null }, { phase: 7 }, { phase: "p", note: null }]) {
		assert.throws(() => tool.prepareArguments(args), Error, JSON.stringify(args));
	}
	for (const args of [{ phase: "p" }, { phase: "p", done: 2, total: 3, note: "ok" }]) assert.deepEqual(tool.prepareArguments(args), args);
});

test("a real request_approval refuses a null summary, which would have reached a person as the word null", () => {
	const [tool] = registered(createRequestApproval(["deploy"]));
	assert.throws(() => tool.prepareArguments({ action: "deploy", summary: null }));
	assert.throws(() => tool.prepareArguments({ action: 1, summary: "s" }));
	assert.deepEqual(tool.prepareArguments({ action: "deploy", summary: "s" }), { action: "deploy", summary: "s" });
});

test("a real await_input takes no argument at all, and refuses a wrong type if it is given one", () => {
	const [tool] = registered(createAwaitInput());
	assert.deepEqual(tool.prepareArguments({}), {});
	assert.equal(tool.prepareArguments(undefined), undefined, "pi may call a no-argument tool with nothing");
	assert.throws(() => tool.prepareArguments({ questionCommentId: 12 }));
});

test("arrays are not wrapped, whole numbers are whole, and nested types are judged", () => {
	const schema = { type: "object", properties: { tasks: { type: "array", items: { type: "object", properties: { task: { type: "string" } } } }, issue: { type: "integer" }, sources: { type: "array", items: { type: "string" } }, flag: { type: "boolean" } } };
	for (const [args, where] of [
		[{ tasks: { task: "x" } }, "arguments.tasks"], [{ tasks: [{ task: null }] }, "arguments.tasks[0].task"],
		[{ issue: 2.5 }, "arguments.issue"], [{ issue: "2" }, "arguments.issue"], [{ sources: "s1" }, "arguments.sources"], [{ sources: [1] }, "arguments.sources[0]"], [{ flag: "1" }, "arguments.flag"],
	]) assert.match(rawTypeProblem(schema, args), new RegExp(where.replace(/[.[\]]/g, "\\$&")), JSON.stringify(args));
	assert.equal(rawTypeProblem(schema, { tasks: [{ task: "x" }], issue: 2, sources: ["s1"], flag: true }), null);
	assert.equal(rawTypeProblem({ type: ["string", "null"] }, null), null, "a schema that allows null allows it");
	assert.equal(rawTypeProblem({ anyOf: [{ type: "string" }, { type: "integer" }] }, 4), null);
	assert.ok(rawTypeProblem({ anyOf: [{ type: "string" }, { type: "integer" }] }, 4.5));
});

test("the problem names the place and never repeats the value; a tool's closed refusal word replaces it", () => {
	const tool = exactArguments({ parameters: { type: "object", properties: { draft: { type: "string" } } } });
	assert.throws(() => tool.prepareArguments({ draft: 12345 }), (error) => error.message.includes("arguments.draft") && !error.message.includes("12345"));
	const closed = exactArguments({ parameters: { type: "object", properties: { draft: { type: "string" } } } }, { refusal: JSON.stringify({ reason: "answer-draft-refused" }) });
	assert.throws(() => closed.prepareArguments({ draft: null }), /answer-draft-refused/);
});
