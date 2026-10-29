import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWatchBoard, WATCH_BOARD_MAX_BYTES } from "../src/watch-board.mjs";
const block = (type, fields) => ({ id: type, type, traceId: "1-0", ...fields });
const board = (blocks) => ({ version: 1, blocks });
test("six fixed inert board block types validate and preserve trace provenance", () => {
	const value = board([block("number", { value: 37 }), block("line", { points: [{ x: "15:00", y: 2 }] }), block("table", { columns: ["service"], rows: [["checkout"]] }), block("note", { text: "<script>alert(1)</script>" }), block("hypotheses", { items: ["pool exhaustion"] }), block("timeline", { items: [{ at: "2026-01-01T00:00:00Z", text: "started" }] })]);
	assert.deepEqual(validateWatchBoard(value, { traceIds: new Set(["1-0"]) }), { ok: true, board: value });
	assert.equal(validateWatchBoard(value, { traceIds: new Set() }).ok, false);
});
test("board size is measured in bytes before JSON parsing, including multibyte text", () => {
	assert.equal(validateWatchBoard(" ".repeat(WATCH_BOARD_MAX_BYTES + 1)).reason, "watch-board-oversize");
	assert.equal(validateWatchBoard("é".repeat(WATCH_BOARD_MAX_BYTES / 2 + 1)).reason, "watch-board-oversize");
	const raw = JSON.stringify(board([]));
	assert.equal(validateWatchBoard(raw + " ".repeat(WATCH_BOARD_MAX_BYTES - Buffer.byteLength(raw))).ok, true);
});
test("invalid boards cannot contain executable schema, unknown properties or duplicate ids", () => {
	for (const value of [null, [], { version: 2, blocks: [] }, board([block("html", { html: "attack" })]), board([block("note", { text: "safe", url: "https://attacker" })]), board([block("note", { text: "one" }), block("note", { text: "two" })]), board([block("note", { text: "a\u0000b" })]), board([block("table", { columns: ["one"], rows: [["a", "b"]] })]), board([block("line", { points: [{ x: 0, y: null }] })]), board([block("timeline", { items: [{ at: "invalid", text: "a" }] })])]) assert.equal(validateWatchBoard(value).reason, "watch-board-invalid");
	assert.equal(validateWatchBoard('{"version":1,"blocks":[],"__proto__":{}}').ok, false);
	const circular = {}; circular.self = circular;
	assert.equal(validateWatchBoard(circular).ok, false);
});
test("validation returns an isolated document and bounded nested collections", () => {
	const value = board([block("note", { text: "original" })]);
	const accepted = validateWatchBoard(value);
	value.blocks[0].text = "changed";
	assert.equal(accepted.board.blocks[0].text, "original");
	assert.equal(validateWatchBoard(board([block("hypotheses", { items: Array(33).fill("x") })])).ok, false);
	assert.equal(validateWatchBoard(board([block("line", { points: Array(257).fill({ x: 0, y: 1 }) })])).ok, false);
});
