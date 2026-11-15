import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, symlinkSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { tempDir } from "./helpers/temp-dir.mjs";
import { HISTORY_CURSOR_TTL_MS, HISTORY_FILE_MAX, HISTORY_PAGE_SIZE, makeHistoryReader, historyQuery, historyRow, readHostHistory, serveHistory } from "../src/history-reader.mjs";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const query = { start: NOW - 86_400_000, end: NOW, project: null };
const record = (id, extra = {}) => ({ jobId: id, v: 1, project: "web", host: "worker-a", outcome: "completed", startedAt: new Date(NOW - 3600000).toISOString(), endedAt: new Date(NOW - 60000).toISOString(), ...extra });
const seed = (dir, r) => writeFileSync(join(dir, r.jobId + ".json"), JSON.stringify(r));

test("retained files beyond the hot index are reachable in bounded pages, with no duplicate at page boundaries", async () => {
	const dir = tempDir("history-pages-");
	for (let n = 0; n < 231; n++) seed(dir, record("gh-" + n));
	const reader = makeHistoryReader({ logsDir: dir, now: () => NOW });
	try {
		const ids = []; let cursor = null;
		do {
			const page = await reader.page(query, cursor);
			assert.equal(page.partial, false); assert.ok(page.runs.length <= HISTORY_PAGE_SIZE);
			ids.push(...page.runs.map((r) => r.jobId)); cursor = page.next;
		} while (cursor);
		assert.equal(ids.length, 231); assert.equal(new Set(ids).size, 231);
	} finally { await reader.close(); }
});

test("range reads include runs spanning either boundary, filter projects and find the previous run", async () => {
	const dir = tempDir("history-overlap-");
	seed(dir, record("gh-spans", { startedAt: new Date(query.start - 1000).toISOString(), endedAt: new Date(query.end + 1000).toISOString() }));
	seed(dir, record("gh-older", { startedAt: new Date(query.start - 3000).toISOString(), endedAt: new Date(query.start - 2000).toISOString() }));
	seed(dir, record("gh-other", { project: "other" }));
	const reader = makeHistoryReader({ logsDir: dir, now: () => NOW });
	try {
		const p = await reader.page({ ...query, project: "web" });
		assert.deepEqual(p.runs.map((r) => r.jobId), ["gh-spans"]);
		assert.equal(p.olderAt, query.start - 2000);
	} finally { await reader.close(); }
});

test("bad records, oversized files and symlinks cannot become a whole empty history", async () => {
	const dir = tempDir("history-bad-");
	writeFileSync(join(dir, "bad.json"), "{");
	writeFileSync(join(dir, "big.json"), " ".repeat(HISTORY_FILE_MAX + 1));
	const outside = tempDir("history-outside-"); seed(outside, record("outside"));
	symlinkSync(join(outside, "outside.json"), join(dir, "linked.json"));
	const reader = makeHistoryReader({ logsDir: dir, now: () => NOW });
	try { const p = await reader.page(query); assert.equal(p.partial, true); assert.equal(p.runs.length, 0); } finally { await reader.close(); }
});

test("cursor expiry and range binding are explicit, and an id read cannot escape the logs directory", async () => {
	const dir = tempDir("history-expiry-");
	for (let n = 0; n < 101; n++) seed(dir, record("gh-" + n));
	let now = NOW;
	const reader = makeHistoryReader({ logsDir: dir, now: () => now });
	try {
		const first = await reader.page(query);
		assert.ok(first.next);
		assert.equal((await reader.page({ ...query, project: "other" }, first.next)).error, "cursor-expired");
		now += HISTORY_CURSOR_TTL_MS;
		assert.equal((await reader.page(query, first.next)).error, "cursor-expired");
		assert.equal((await reader.page({ id: "../other" })).error, "invalid-query");
		assert.equal((await reader.page({ id: "gh-0" })).record.jobId, "gh-0");
	} finally { await reader.close(); }
});

test("a newer record is readable at its core, and metadata never carries free text or loaded names", () => {
	const row = historyRow(record("gh-new", { v: 99, loaded: { tools: ["hostile"] }, failedReason: "private", target: "other", reason: "private" }));
	assert.equal(row.jobId, "gh-new"); assert.equal(row.target, null); assert.equal(row.reason, null);
	assert.ok(!("loaded" in row)); assert.ok(!("failedReason" in row));
	assert.equal(historyQuery({ start: -1, end: NOW }), null);
});

function bus() {
	const clients = new Set();
	const make = () => {
		const c = new EventEmitter(); c.channels = new Set(); clients.add(c);
		c.duplicate = make; c.subscribe = async (channel) => { c.channels.add(channel); };
		c.publish = async (channel, body) => { for (const peer of clients) if (peer.channels.has(channel)) peer.emit("message", channel, body); };
		c.disconnect = () => clients.delete(c);
		return c;
	};
	return { redis: make(), clients };
}

test("a remote page and an old record are read over transient pub/sub, with clients closed", async () => {
	const dir = tempDir("history-remote-"); seed(dir, record("gh-remote"));
	const { redis, clients } = bus();
	const service = await serveHistory({ redis, host: "worker-a", reader: makeHistoryReader({ logsDir: dir, now: () => NOW }) });
	try {
		const p = await readHostHistory({ redis, host: "worker-a", query });
		assert.equal(p.runs[0].jobId, "gh-remote");
		const one = await readHostHistory({ redis, host: "worker-a", query: { id: "gh-remote" } });
		assert.equal(one.record.jobId, "gh-remote");
		assert.equal(clients.size, 2);
	} finally { await service.close(); redis.disconnect(); }
	assert.equal(clients.size, 0);
});
