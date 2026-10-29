import assert from "node:assert/strict";
import { test } from "node:test";
import { createWatchTools, validateWatchTools } from "../src/watch-tools.mjs";
const config = { version: 1, decisionModel: { provider: "openrouter", id: "typesafe/jev-1.13" }, queries: { errors: { endpoint: "https://logs.internal/query", query: "errors last hour", headers: { authorization: "secret-value" } } } };
function fixture({ fetch, runtime } = {}) {
	const lines = []; const files = [];
	const instance = createWatchTools({ config, runtime: runtime ?? { getModelsOfType: () => [{ provider: "openrouter", id: "typesafe/jev-1.13", cost: { input: 1, output: 0 } }], classify: async () => ({ stopReason: "stop", answers: { act: { choice: "ignore" } }, usage: { cost: 0.001 } }) }, fetch: fetch ?? (async () => new Response(JSON.stringify({ rows: [{ count: 2 }] }))), fs: { appendFileSync(_path, line) { lines.push(JSON.parse(line)); }, writeFileSync(path, text) { files.push({ path, text }); } }, now: () => 123 });
	return { ...instance, lines, files, tool: (name) => instance.tools.find((tool) => tool.name === name) };
}
test("reviewed queries refuse endpoint/query overrides and never trace credentials", async () => {
	let called = 0;
	const f = fixture({ fetch: async (url, options) => { called++; assert.equal(url, config.queries.errors.endpoint); assert.equal(options.redirect, "error"); assert.equal(options.headers.authorization, "secret-value"); assert.deepEqual(JSON.parse(options.body), { query: "errors last hour" }); return new Response('{"rows":[{"count":2}]}'); } });
	for (const args of [{ name: "unknown" }, { name: "errors", query: "delete" }, { name: "errors", endpoint: "https://attacker" }]) assert.equal((await f.tool("query_logs").execute("q", args)).isError, true);
	assert.equal(called, 0);
	const answer = await f.tool("query_logs").execute("q", { name: "errors" });
	assert.equal(answer.isError, undefined);
	assert.equal(JSON.parse(answer.content[0].text).traceId, "watch-2");
	assert.equal(called, 1); assert.deepEqual(f.lines.map((l) => l.status), ["started", "completed"]);
	assert.equal(JSON.stringify(f.lines).includes("secret-value"), false);
});
test("query response byte and row caps, transport failure and malformed JSON are traced as failed", async () => {
	for (const response of [() => new Response("x".repeat(65537)), () => new Response(JSON.stringify(Array(101).fill(0))), () => new Response("invalid"), () => { throw new Error("credential private"); }]) {
		const f = fixture({ fetch: async () => response() });
		const result = await f.tool("query_logs").execute("q", { name: "errors" });
		assert.equal(result.isError, true); assert.equal(f.lines.at(-1).status, "failed"); assert.equal(JSON.stringify(result).includes("private"), false);
	}
});
test("query sources require reviewed HTTPS, no URL credentials, unsafe headers or unknown config", () => {
	for (const query of [{ endpoint: "http://logs", query: "q" }, { endpoint: "https://secret@logs", query: "q" }, { endpoint: "https://logs", query: "q", headers: { host: "attacker" } }, { endpoint: "https://logs", query: "q", headers: { authorization: "x\r\ny" } }]) assert.throws(() => validateWatchTools({ version: 1, queries: { q: query } }));
	assert.throws(() => validateWatchTools({ version: 1, script: "run" }));
});
test("decide calls only the reviewed runtime classifier and records both stages", async () => {
	const f = fixture();
	const response = await f.tool("decide").execute("d", { state: { count: 4 }, questions: { act: { type: "choice", criteria: { ignore: "noise" } } } });
	assert.equal(response.isError, undefined); assert.equal(JSON.parse(response.content[0].text).traceId, "watch-2"); assert.deepEqual(f.lines.map((l) => l.kind), ["decide", "decide"]); assert.equal(f.lines[0].state.count, 4);
	assert.equal((await f.tool("decide").execute("d", { model: "attacker", state: {}, questions: {} })).isError, true);
	const unavailable = fixture({ runtime: { getModelsOfType: () => [] } });
	assert.equal((await unavailable.tool("decide").execute("d", { state: {}, questions: {} })).isError, true);
	const failed = fixture({ runtime: { getModelsOfType: () => [{ id: config.decisionModel.id, cost: { input: 1, output: 0 } }], classify() { throw new Error("private"); } } });
	assert.equal((await failed.tool("decide").execute("d", { state: {}, questions: {} })).isError, true); assert.equal(failed.lines.at(-1).status, "failed");
});
test("board proposals use only the fixed outbox path; oversize is refused before write", async () => {
	const f = fixture();
	assert.equal((await f.tool("board_write").execute("b", { board: { version: 1, blocks: [] } })).isError, undefined);
	assert.equal(f.files[0].path, "/outbox/board.json"); assert.equal(f.lines.at(-1).status, "proposed");
	assert.equal((await f.tool("board_write").execute("b", { path: "/workspace/x", board: { version: 1, blocks: [] } })).isError, true);
	assert.equal((await f.tool("board_write").execute("b", { board: { version: 1, blocks: [{ text: "x".repeat(16384) }] } })).isError, true);
	assert.equal(f.files.length, 1);
});
test("trace cap refuses more queries before fetch and caps file entries", async () => {
	let calls = 0; const f = fixture({ fetch: async () => { calls++; return new Response("[]"); } });
	for (let i = 0; i < 100; i++) await f.tool("query_logs").execute(`q${i}`, { name: "errors" });
	assert.ok(calls <= 63); assert.ok(f.lines.length <= 128);
});
