import assert from "node:assert/strict";
import { test } from "node:test";
import { makeWatchStore, validateWatchBoard } from "../src/watch-store.mjs";
test("board schema refuses unknown blocks, HTML fields and oversized evidence", () => {
	assert.deepEqual(validateWatchBoard({ blocks: [] }), { blocks: [] });
	for (const board of [{ blocks: [{ id: "note-1", type: "html", traceId: "t", text: "x" }] }, { blocks: [{ id: "note-1", type: "note", traceId: "t", html: "x" }] }, { blocks: [{ id: "note-1", type: "note", traceId: "t", text: "x".repeat(16384) }] }, { blocks: [{ kind: "note" }] }]) assert.throws(() => validateWatchBoard(board));
});
test("unmatched findings create no store state and malformed board changes never issue eval", async () => {
	let calls = 0; const store = makeWatchStore({ eval() { calls++; } }, { now: () => 0 });
	assert.deepEqual(await store.ingest({ source: "prod", rule: { id: "r", match: { severity: ["critical"] } }, finding: { severity: "info" }, delivery: "d" }), { status: "unmatched", reason: "watch-unmatched" });
	await assert.rejects(store.mutateBoard("r", { action: "freeze", frozen: "yes" }, 0));
	await assert.rejects(store.mutateBoard("r", { action: "clear" }, -1)); assert.equal(calls, 0);
});
