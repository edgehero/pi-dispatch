import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FIRST_CALL_MIN_CONTEXT_BYTES, FIRST_CALL_SHORT_TASK_BYTES } from "../src/model-catalog.mjs";

/**
 * The two constants' reason, against the pinned pi. The floor (`FIRST_CALL_MIN_CONTEXT_BYTES`) stays a lower bound only while it is
 * below what pi's default prompt and tools come to, and the amount a person is told (`FIRST_CALL_SHORT_TASK_BYTES`) only while it is
 * above that with a short task. Their comments once carried pi 0.99.1's numbers past the bump that moved them, so the order is held
 * here, and the numbers themselves are not: they name pi's install path, and a path is no reason for a pin bump to go red.
 */
const piRoot = new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/core/", import.meta.url);

// A skip rather than a silent pass when pi is not installed (a bare worker/ checkout), escalated in the CI posture.
const skip = existsSync(fileURLToPath(new URL("system-prompt.js", piRoot))) ? false : "pi is not installed (run npm install at the repo root)";
if (skip && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("pi must be importable here in CI; a skip would hide the two constants drifting from the pin.");

test("pi's default prompt and tools sit between the floor and a short task's amount", { skip }, async () => {
	const { buildSystemPrompt } = await import(new URL("system-prompt.js", piRoot).href);
	const tools = await import(new URL("tools/index.js", piRoot).href);
	const cwd = "/workspace";
	const defs = [tools.createReadToolDefinition, tools.createBashToolDefinition, tools.createEditToolDefinition, tools.createWriteToolDefinition].map((factory) => factory(cwd));
	const snippets = Object.fromEntries(defs.filter((def) => def.promptSnippet).map((def) => [def.name, def.promptSnippet]));
	const guidelines = Object.fromEntries(defs.filter((def) => def.promptGuidelines).map((def) => [def.name, def.promptGuidelines]));
	const systemPrompt = buildSystemPrompt({ cwd, selectedTools: defs.map((def) => def.name), toolSnippets: snippets, toolGuidelines: guidelines });
	const schemas = defs.map((def) => ({ name: def.name, description: def.description, parameters: def.parameters }));
	const bytes = (messages) => Buffer.byteLength(JSON.stringify({ systemPrompt, messages, tools: schemas }), "utf8");
	const bare = bytes([]);
	const oneLine = bytes([{ role: "user", content: [{ type: "text", text: "Add a line to the README saying hello." }], timestamp: 1 }]);
	assert.ok(bare > FIRST_CALL_MIN_CONTEXT_BYTES, `${bare} bytes: the floor would no longer be a lower bound for a job that adds nothing. Re-read firstCallFloorMicros against the new pi.`);
	assert.ok(oneLine < FIRST_CALL_SHORT_TASK_BYTES, `${oneLine} bytes: the amount a person is told would no longer cover a short task. Re-measure FIRST_CALL_SHORT_TASK_BYTES against the new pi.`);
});
