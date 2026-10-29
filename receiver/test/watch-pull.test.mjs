import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, appendFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeWatchPullAdapter } from "../src/watch-pull.mjs";
const NOW = Date.parse("2026-01-01T00:00:00Z"); const now = () => NOW;
const fields = { service: "checkout" };
test("file collector checkpoints complete lines, handles appends and refuses symlinks", async () => {
	const folder = tempDir("watch-file-"); const path = join(folder, "input.log"); writeFileSync(path, "error secret\npartial");
	const adapter = makeWatchPullAdapter({ kind: "file", path, fields }, { now });
	const first = await adapter.poll(); assert.equal(first.findings.length, 1); assert.equal(first.findings[0].samples[0], "[redacted]"); assert.equal(first.cursor.offset, 13);
	appendFileSync(path, " tail\n"); const second = await adapter.poll(first.cursor); assert.equal(second.findings.length, 1); assert.ok(second.cursor.offset > first.cursor.offset);
	const link = join(folder, "link"); symlinkSync(path, link); await assert.rejects(makeWatchPullAdapter({ kind: "file", path: link, fields }, { now }).poll(), /unavailable/);
});
test("file collector refuses oversized unterminated lines and excessive batches", async () => {
	const path = join(tempDir("watch-file-bound-"), "input.log"); writeFileSync(path, "x".repeat(65536)); await assert.rejects(makeWatchPullAdapter({ kind: "file", path, fields }, { now }).poll());
	writeFileSync(path, "x\n".repeat(101)); await assert.rejects(makeWatchPullAdapter({ kind: "file", path, fields }, { now }).poll());
});
test("journald invokes bounded argv without a shell and advances only validated cursors", async () => {
	const calls = []; const adapter = makeWatchPullAdapter({ kind: "journald", unit: "service.service", fields }, { now, run: async (...args) => { calls.push(args); return { stdout: JSON.stringify({ __CURSOR: "cursor-1", MESSAGE: "private message" }) + "\n" }; } });
	const result = await adapter.poll({ after: "cursor-0" }); assert.equal(result.cursor.after, "cursor-1"); assert.equal(result.findings[0].samples[0], "[redacted]"); assert.equal(calls[0][0], "journalctl"); assert.ok(calls[0][1].includes("--after-cursor")); assert.equal(calls[0][2].maxBuffer, 65536);
	await assert.rejects(adapter.poll({ after: "bad\ncursor" }));
});
test("Loki collector keeps credentials on host and avoids repeats at timestamp boundary", async () => {
	const calls = []; const ns = String(BigInt(NOW) * 1000000n);
	const adapter = makeWatchPullAdapter({ kind: "loki", url: "https://loki.example", query: '{service="checkout"}', secretEnv: "LOKI_TOKEN", fields }, { now, env: { LOKI_TOKEN: "host-secret" }, fetchFn: async (url, options) => { calls.push({ url: String(url), options }); return new Response(JSON.stringify({ status: "success", data: { resultType: "streams", result: [{ stream: { level: "error" }, values: [[ns, "private message"]] }] } })); } });
	const first = await adapter.poll(); assert.equal(first.findings.length, 1); assert.equal(first.findings[0].samples[0], "[redacted]"); assert.doesNotMatch(JSON.stringify(first), /host-secret|private message/); assert.equal(calls[0].options.headers.authorization, "Bearer host-secret"); assert.equal(calls[0].options.redirect, "error");
	assert.equal((await adapter.poll(first.cursor)).findings.length, 0);
});
test("Loki collector refuses endpoint credentials, missing host secret and unbounded responses", async () => {
	await assert.rejects(makeWatchPullAdapter({ kind: "loki", url: "https://user:secret@loki.example", query: "x", fields }, { now }).poll());
	await assert.rejects(makeWatchPullAdapter({ kind: "loki", url: "https://loki.example", query: "x", secretEnv: "MISSING", fields }, { now, env: {} }).poll(), /credential/);
	await assert.rejects(makeWatchPullAdapter({ kind: "loki", url: "https://loki.example", query: "x", fields }, { now, fetchFn: async () => new Response("x".repeat(65537)) }).poll(), /limit/);
});
