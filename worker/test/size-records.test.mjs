import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SIZING_MTIME_DAYS, SIZING_RECORD_MAX_BYTES, readSizingRecords } from "../src/size-records.mjs";
import { SUGGEST_WINDOW_RUNS } from "../src/size-suggest.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The run records a size suggestion reads (issue #596, phase 3, DES-SIZE-SUGGESTIONS), shared by doctor and the admin:
// an mtime prefilter, a size cap per file, the newest 50 per project. The clock is injected (`nowMs`), and every file's
// mtime is set from it, never left at the wall clock's.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

function rec({ i = 0, project = "web", ago = i + 1 } = {}) {
	return { jobId: `job-${project}-${i}`, project, endedAt: new Date(NOW - ago * MIN).toISOString() };
}
function writer(dir) {
	return (name, body, ageMs = 0) => {
		const p = join(dir, name);
		writeFileSync(p, body);
		const t = (NOW - ageMs) / 1000;
		utimesSync(p, t, t);
		return p;
	};
}

test("the bounds are the plan's: 256 KiB a file, the window plus a day of mtime", () => {
	assert.deepEqual([SIZING_RECORD_MAX_BYTES, SIZING_MTIME_DAYS, SUGGEST_WINDOW_RUNS], [256 * 1024, 31, 50]);
});

test("it reads the window's run records by mtime and skips junk; an absent directory holds none", () => {
	const dir = tempDir("pi-sizing-records-");
	const write = writer(dir);
	write("a.json", JSON.stringify(rec({ i: 1 })));
	write("b.json", JSON.stringify(rec({ i: 2 })), 31 * DAY); // exactly the window plus its day: read
	write("c.json", JSON.stringify(rec({ i: 3 })), 31 * DAY + 1); // a millisecond older: not even opened
	write("d.json", "{ not json");
	write("e.log", JSON.stringify(rec({ i: 5 }))); // a record's own log is never read, whatever it holds
	write("g.json", JSON.stringify({ ...rec({ i: 6 }), project: 7 })); // no string project: no suggestion could read it
	write("h.json", JSON.stringify({ ...rec({ i: 7 }), endedAt: "soon" }));
	mkdirSync(join(dir, "f.json"));
	const got = readSizingRecords(dir, { nowMs: NOW });
	assert.deepEqual([got.records.map((r) => r.jobId).sort(), got.skipped, got.unreachable], [["job-web-1", "job-web-2"], 0, null]);
	assert.deepEqual(readSizingRecords(join(dir, "nope"), { nowMs: NOW }), { records: [], skipped: 0, unreachable: null });
	// a path that is not a directory cannot be listed: unreachable, said
	assert.match(readSizingRecords(join(dir, "a.json"), { nowMs: NOW }).unreachable, /^logs dir unreadable \(ENOTDIR\)$/);
});

test("a file over 256 KiB is skipped and counted, never parsed; one at exactly the cap is read", () => {
	const dir = tempDir("pi-sizing-cap-");
	const write = writer(dir);
	const body = JSON.stringify(rec({ i: 1 }));
	const exact = body + " ".repeat(SIZING_RECORD_MAX_BYTES - Buffer.byteLength(body));
	write("exact.json", exact);
	write("over.json", `${exact} `);
	write("over2.json", `${exact}  `);
	const got = readSizingRecords(dir, { nowMs: NOW });
	assert.deepEqual([got.records.length, got.skipped], [1, 2]);
	// a file that grows between the stat and the read is skipped too
	const growing = { readdirSync: () => ["x.json"], statSync: () => ({ isFile: () => true, mtimeMs: NOW, size: 10 }), readFileSync: () => Buffer.alloc(SIZING_RECORD_MAX_BYTES + 1, 32) };
	assert.deepEqual(readSizingRecords("/logs", { nowMs: NOW, fs: growing }), { records: [], skipped: 1, unreachable: null });
	// the size is judged from the stat, before the file is opened; and only a regular file is opened at all
	const opened = [];
	const fake = (st) => ({ readdirSync: () => ["x.json"], statSync: () => ({ isFile: () => true, mtimeMs: NOW, size: 10, ...st }), readFileSync: (p) => (opened.push(p), Buffer.from(JSON.stringify(rec()))) });
	assert.deepEqual([readSizingRecords("/logs", { nowMs: NOW, fs: fake({ size: SIZING_RECORD_MAX_BYTES + 1 }) }).skipped, opened.length], [1, 0]);
	assert.deepEqual([readSizingRecords("/logs", { nowMs: NOW, fs: fake({ isFile: () => false }) }).records.length, opened.length], [0, 0]);
	assert.deepEqual([readSizingRecords("/logs", { nowMs: NOW, fs: fake({}) }).records.length, opened.length], [1, 1]);
	// an old file over the cap is neither opened nor counted
	write("old.json", `${exact} `, 40 * DAY);
	assert.equal(readSizingRecords(dir, { nowMs: NOW }).skipped, 2);
});

test("only the newest 50 per project are kept, by endedAt", () => {
	const dir = tempDir("pi-sizing-newest-");
	const write = writer(dir);
	for (let i = 0; i < 60; i++) write(`w${i}.json`, JSON.stringify(rec({ i, project: "web" })));
	for (let i = 0; i < 3; i++) write(`a${i}.json`, JSON.stringify(rec({ i, project: "api" })));
	const got = readSizingRecords(dir, { nowMs: NOW }).records;
	const web = got.filter((r) => r.project === "web").map((r) => Number(r.jobId.split("-").at(-1))).sort((a, b) => a - b);
	assert.deepEqual(web, Array.from({ length: 50 }, (_, i) => i), "the 50 that ended last");
	assert.equal(got.filter((r) => r.project === "api").length, 3);
});
