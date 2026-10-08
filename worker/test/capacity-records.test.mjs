import assert from "node:assert/strict";
import { test } from "node:test";
import * as nodeFs from "node:fs";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAPACITY_MGET_CHUNK, readCapacityRecords, readLocalWindow, readMirrorWindow } from "../src/capacity-records.mjs";
import { RUNS_INDEX, RUNS_INDEX_MAX, mirrorWindowMs, runRecordKey } from "../src/run-mirror.mjs";
import { SIZING_RECORD_MAX_BYTES } from "../src/size-records.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The records a capacity report reads (issue #599, DES-CAPACITY-FROM-RECORDS): the run mirror (a fake Valkey here) and
// the local files, merged, with what they cover. The clock is injected (`nowMs`), and every file's mtime is set from it.

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const H = 60 * 60 * 1000;
const DAY = 24 * H;
const SINCE = NOW - 7 * DAY;
const rec = (jobId, endAgo, extra = {}) => ({ jobId, host: "a", startedAt: new Date(NOW - endAgo - H).toISOString(), endedAt: new Date(NOW - endAgo).toISOString(), ...extra });

/**
 * A fake Valkey holding the mirror's index and bodies, answering the four reads the reader makes and recording every
 * call, so a test can see that it never writes. `size` overrides ZCARD (a cap without 5,000 bodies).
 */
function fakeMirror(records, { size = null, hang = false } = {}) {
	const index = new Map(records.map((r) => [r.jobId, Date.parse(r.endedAt)]));
	const kv = new Map(records.map((r) => [runRecordKey(r.jobId), JSON.stringify(r)]));
	const calls = [];
	const answer = (name, value) => {
		calls.push(name);
		return hang ? new Promise(() => {}) : Promise.resolve(value);
	};
	const sorted = () => [...index.entries()].sort((a, b) => a[1] - b[1]);
	return {
		calls,
		kv,
		index,
		zcard: (key) => answer("zcard", key === RUNS_INDEX ? (size ?? index.size) : 0),
		zrange: (key, start, stop, withScores) => {
			assert.deepEqual([key, start, stop, withScores], [RUNS_INDEX, 0, 0, "WITHSCORES"]);
			const first = sorted()[0];
			return answer("zrange", first ? [first[0], String(first[1])] : []);
		},
		zrevrangebyscore: (key, max, min) => {
			assert.deepEqual([key, max], [RUNS_INDEX, "+inf"]);
			const floor = Number(min.slice(1));
			assert.equal(min[0], "(", "exclusive: a run that ended at the window's start spent none of it");
			return answer("zrevrangebyscore", sorted().filter(([, s]) => s > floor).reverse().map(([id]) => id));
		},
		mget: (...keys) => {
			calls.push(`mget:${keys.length}`);
			return answer("mget", keys.map((k) => kv.get(k) ?? null));
		},
	};
}

/** A call that throws an fs error with this code. */
function thrower(code) {
	return () => {
		throw Object.assign(new Error(code), { code });
	};
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

test("the mirror is read in bounded round trips: ZCARD, the oldest score, one range over the window, MGET in chunks", async () => {
	const records = Array.from({ length: 1200 }, (_, i) => rec(`m${i}`, i * 60 * 1000));
	const redis = fakeMirror(records);
	const read = await readMirrorWindow(redis, { sinceMs: SINCE });
	assert.equal(read.state, "ok");
	assert.equal(read.records.length, 1200);
	assert.equal(CAPACITY_MGET_CHUNK, 500);
	assert.deepEqual(redis.calls.filter((c) => c.startsWith("mget:")), ["mget:500", "mget:500", "mget:200"]);
	assert.deepEqual(redis.calls.filter((c) => !c.startsWith("mget")), ["zcard", "zrange", "zrevrangebyscore"], "READ-ONLY: nothing pruned, nothing written");
	assert.equal(read.truncated, false);
});

test("truncated only at the cap and only when the oldest kept run ended after the window began", async () => {
	const kept = [rec("new", H), rec("old", 3 * DAY)];
	const atCap = await readMirrorWindow(fakeMirror(kept, { size: RUNS_INDEX_MAX }), { sinceMs: SINCE });
	assert.deepEqual([atCap.truncated, atCap.oldestMs], [true, NOW - 3 * DAY]);
	const below = await readMirrorWindow(fakeMirror(kept, { size: RUNS_INDEX_MAX - 1 }), { sinceMs: SINCE });
	assert.equal(below.truncated, false, "under the cap nothing was cut");
	const reachesBack = await readMirrorWindow(fakeMirror([...kept, rec("older", 8 * DAY)], { size: RUNS_INDEX_MAX }), { sinceMs: SINCE });
	assert.equal(reachesBack.truncated, false, "at the cap, but its oldest run is older than the window: the window is whole");

	const merged = await readCapacityRecords({ redis: fakeMirror(kept, { size: RUNS_INDEX_MAX }), logsDir: tempDir("pi-cap-records-"), sinceMs: SINCE, nowMs: NOW, retentionDays: 30 });
	assert.deepEqual([merged.coverage.truncated, merged.coverage.fromMs, merged.coverage.source], [true, NOW - 3 * DAY, "mirror"]);
});

test("an absent index is off, and a Valkey that does not answer is unreachable within the bound; both read the local files and say so", async () => {
	const dir = tempDir("pi-cap-records-");
	writer(dir)("l.json", JSON.stringify(rec("local", H)));
	const off = await readCapacityRecords({ redis: fakeMirror([]), logsDir: dir, sinceMs: SINCE, nowMs: NOW });
	assert.deepEqual([off.coverage.source, off.coverage.mirrored, off.records.map((r) => r.jobId)], ["local", false, ["local"]]);
	assert.match(off.coverage.reason, /no run mirror/);

	const hung = fakeMirror([rec("m", H)], { hang: true });
	const down = await readCapacityRecords({ redis: hung, logsDir: dir, sinceMs: SINCE, nowMs: NOW, timeoutMs: 20 });
	assert.deepEqual([down.coverage.source, down.coverage.mirrored, down.records.map((r) => r.jobId)], ["local", false, ["local"]]);
	assert.match(down.coverage.reason, /run mirror unreachable \(timeout\)/);
	const thrown = await readCapacityRecords({ redis: { zcard: () => Promise.reject(new Error("ECONNREFUSED")) }, logsDir: dir, sinceMs: SINCE, nowMs: NOW });
	assert.match(thrown.coverage.reason, /unreachable \(ECONNREFUSED\)/);
	const none = await readCapacityRecords({ redis: null, logsDir: dir, sinceMs: SINCE, nowMs: NOW });
	assert.equal(none.coverage.source, "local");
});

test("the local read: an mtime prefilter (never opened), the 256 KiB cap (skipped and counted), and only the window's records", () => {
	const dir = tempDir("pi-cap-records-");
	const write = writer(dir);
	write("in.json", JSON.stringify(rec("in", 2 * DAY)));
	write("edge.json", JSON.stringify(rec("edge", 2 * DAY)), 8 * DAY); // the window plus its day of skew: still opened
	write("stale.json", JSON.stringify(rec("stale", H)), 8 * DAY + 1); // a millisecond older: not opened, whatever it says
	write("ended-before.json", JSON.stringify(rec("ended-before", 7 * DAY + 1)));
	write("big.json", JSON.stringify(rec("big", H, { pad: "x".repeat(SIZING_RECORD_MAX_BYTES) })));
	write("junk.json", "{");
	write("array.json", "[1]");
	write("nojob.json", JSON.stringify({ endedAt: new Date(NOW).toISOString() }));
	write("run.log", "not a record");
	const opened = [];
	const fs = {
		readdirSync: (p) => nodeFs.readdirSync(p),
		statSync: (p) => nodeFs.statSync(p),
		readFileSync: (p) => (opened.push(p.split("/").at(-1)), nodeFs.readFileSync(p)),
	};
	const read = readLocalWindow(dir, { sinceMs: SINCE, fs });
	assert.deepEqual(read.records.map((r) => r.jobId).sort(), ["edge", "in"]);
	assert.equal(read.skipped, 1);
	assert.ok(!opened.includes("stale.json"), "the prefilter: a file last written before the window is not opened");
	assert.ok(!opened.includes("big.json"), "the cap: judged on the stat, never parsed");
	assert.ok(!opened.includes("run.log"));
	assert.deepEqual(readLocalWindow(join(dir, "absent"), { sinceMs: SINCE }), { records: [], skipped: 0, unreachable: null }, "an absent directory holds no records");
	const denied = readLocalWindow(dir, { sinceMs: SINCE, fs: { readdirSync: thrower("EACCES") } });
	assert.match(denied.unreachable, /EACCES/);
});

test("both sources merge to one record per job, the later end winning; the retention and the mirror's window bound the history", async () => {
	const dir = tempDir("pi-cap-records-");
	const write = writer(dir);
	// The same job: attempt 1 failed here, attempt 2 ran on another host and was mirrored (a retry can move).
	write("j.json", JSON.stringify(rec("j", 3 * H, { outcome: "failed" })));
	write("only-local.json", JSON.stringify(rec("only-local", H)));
	const redis = fakeMirror([rec("j", H, { host: "b", outcome: "completed" }), rec("only-mirror", 2 * H, { host: "b" })]);
	const read = await readCapacityRecords({ redis, logsDir: dir, sinceMs: SINCE, nowMs: NOW, retentionDays: 3, localHost: "a" });
	assert.deepEqual(read.records.map((r) => [r.jobId, r.host]).sort(), [["j", "b"], ["only-local", "a"], ["only-mirror", "b"]]);
	assert.deepEqual([read.coverage.source, read.coverage.localHost, read.coverage.localHosts], ["mirror+local", "a", ["a"]]);
	assert.equal(read.coverage.fromMs, NOW - 3 * DAY, "three days of retention: nothing older can be shown");
	assert.equal(read.coverage.reason, null);
	// Kept forever on disk, the mirror still holds no more than its own window.
	const forever = await readCapacityRecords({ redis, logsDir: dir, sinceMs: NOW - 100 * DAY, nowMs: NOW, retentionDays: 0 });
	assert.equal(forever.coverage.fromMs, NOW - mirrorWindowMs(0));
	const localThree = await readCapacityRecords({ redis: null, logsDir: dir, sinceMs: SINCE, nowMs: NOW, retentionDays: 3 });
	assert.equal(localThree.coverage.fromMs, NOW - 3 * DAY, "the files alone: their retention bounds the history");
	const localForever = await readCapacityRecords({ redis: null, logsDir: dir, sinceMs: NOW - 100 * DAY, nowMs: NOW, retentionDays: 0 });
	assert.equal(localForever.coverage.fromMs, NOW - 100 * DAY, "local files kept forever cover the whole window");
});

test("an expired or unparseable mirrored body is skipped, never shown, and never pruned by this reader", async () => {
	const redis = fakeMirror([rec("ok", H), rec("gone", H), rec("bad", H)]);
	redis.kv.delete(runRecordKey("gone"));
	redis.kv.set(runRecordKey("bad"), "{");
	const read = await readMirrorWindow(redis, { sinceMs: SINCE });
	assert.deepEqual(read.records.map((r) => r.jobId), ["ok"]);
	assert.ok(redis.index.has("gone"), "the index member stays: a report writes nothing");
});
