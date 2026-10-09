import assert from "node:assert/strict";
import { test } from "node:test";
import * as nodeFs from "node:fs";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAPACITY_MGET_CHUNK, readCapacityRecords, readLocalWindow, readMirrorWindow } from "../src/capacity-records.mjs";
import { READ_SCRIPT, RUNS_HORIZON, RUNS_HORIZON_MEMBER, RUNS_INDEX, RUNS_INDEX_MAX, RUNS_SINCE, mirrorWindowMs, runRecordKey } from "../src/run-mirror.mjs";
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
 * A fake Valkey holding the mirror's index, bodies, horizon and start, answering the reader's one snapshot script
 * (`READ_SCRIPT`, run against Valkey in run-mirror.integration.test.mjs) and its MGETs, and recording every call, so a
 * test can see that it never writes. `size` overrides the index's size (a cap without 5,000 bodies). `since` is the
 * mirror's start (`runs:since`'s `at`), by default long before any window here; null is an index without one;
 * `sinceHeld` false is a start whose run is no longer in the index.
 */
function fakeMirror(records, { size = null, hang = false, horizon = null, since = NOW - 100 * DAY, sinceHeld = true } = {}) {
	const index = new Map(records.map((r) => [r.jobId, Date.parse(r.endedAt)]));
	const kv = new Map(records.map((r) => [runRecordKey(r.jobId), JSON.stringify(r)]));
	const calls = [];
	const answer = (name, value) => {
		calls.push(name);
		return hang ? new Promise(() => {}) : Promise.resolve(value);
	};
	const sorted = () => [...index.entries()].sort((a, b) => a[1] - b[1]);
	const fake = {
		calls,
		kv,
		index,
		sinceAt: since === null ? null : String(since),
		eval: (script, nkeys, ...rest) => {
			assert.equal(script, READ_SCRIPT);
			assert.deepEqual([nkeys, ...rest.slice(0, 4)], [3, RUNS_INDEX, RUNS_HORIZON, RUNS_SINCE, RUNS_HORIZON_MEMBER]);
			const min = rest[4];
			const n = size ?? index.size;
			if (n === 0) return answer("eval", [0]);
			const first = sorted()[0];
			const range = sorted().filter(([, sc]) => sc > Number(min)).reverse().flatMap(([id, sc]) => [id, String(sc)]);
			return answer("eval", [n, first ? String(first[1]) : null, horizon === null ? null : String(horizon), fake.sinceAt, fake.sinceAt !== null && sinceHeld ? 1 : 0, range]);
		},
		mget: (...keys) => {
			calls.push(`mget:${keys.length}`);
			return answer("mget", keys.map((k) => kv.get(k) ?? null));
		},
	};
	return fake;
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

test("the mirror is read in bounded round trips: one snapshot script, then MGET in chunks", async () => {
	const records = Array.from({ length: 1200 }, (_, i) => rec(`m${i}`, i * 60 * 1000));
	const redis = fakeMirror(records);
	const read = await readMirrorWindow(redis, { sinceMs: SINCE, nowMs: NOW });
	assert.equal(read.state, "ok");
	assert.equal(read.records.length, 1200);
	assert.equal(CAPACITY_MGET_CHUNK, 500);
	assert.deepEqual(redis.calls.filter((c) => c.startsWith("mget:")), ["mget:500", "mget:500", "mget:200"]);
	assert.deepEqual(redis.calls.filter((c) => !c.startsWith("mget")), ["eval"], "ONE snapshot of the index, then the bodies; READ-ONLY: nothing pruned, nothing written");
	assert.deepEqual([read.truncated, read.fromMs], [false, SINCE]);
});

test("the mirror's history starts at the latest of its cap, the fleet horizon and an expired body, and any of them past the window truncates it", async () => {
	const kept = [rec("new", H), rec("old", 3 * DAY)];
	const atCap = await readMirrorWindow(fakeMirror(kept, { size: RUNS_INDEX_MAX }), { sinceMs: SINCE, nowMs: NOW });
	assert.deepEqual([atCap.truncated, atCap.fromMs], [true, NOW - 3 * DAY], "at the cap the oldest kept run is the start");
	const below = await readMirrorWindow(fakeMirror(kept, { size: RUNS_INDEX_MAX - 1 }), { sinceMs: SINCE, nowMs: NOW });
	assert.equal(below.truncated, false, "under the cap nothing was cut");
	const reachesBack = await readMirrorWindow(fakeMirror([...kept, rec("older", 8 * DAY)], { size: RUNS_INDEX_MAX }), { sinceMs: SINCE, nowMs: NOW });
	assert.equal(reachesBack.truncated, false, "at the cap, but its oldest run is older than the window: the window is whole");
	// A peer whose short retention trimmed the shared index raised the horizon: nothing older is there, whatever this
	// reader's own retention says.
	const trimmed = await readMirrorWindow(fakeMirror(kept, { horizon: NOW - DAY }), { sinceMs: SINCE, nowMs: NOW });
	assert.deepEqual([trimmed.truncated, trimmed.fromMs], [true, NOW - DAY]);
	const oldHorizon = await readMirrorWindow(fakeMirror(kept, { horizon: NOW - 9 * DAY }), { sinceMs: SINCE, nowMs: NOW });
	assert.deepEqual([oldHorizon.truncated, oldHorizon.fromMs], [false, SINCE], "a horizon before the window cuts nothing of it");
	// A body that expired while its member stayed (its writer has not trimmed since): the mirror shows nothing before it.
	const expiring = fakeMirror([rec("live", H), rec("expired", 2 * DAY), rec("older-expired", 4 * DAY)]);
	expiring.kv.delete(runRecordKey("expired"));
	expiring.kv.delete(runRecordKey("older-expired"));
	const expired = await readMirrorWindow(expiring, { sinceMs: SINCE, nowMs: NOW });
	assert.deepEqual([expired.truncated, expired.fromMs, expired.records.map((r) => r.jobId)], [true, NOW - 2 * DAY, ["live"]]);
	// Never deeper than any writer keeps a run.
	const deep = await readMirrorWindow(fakeMirror(kept), { sinceMs: NOW - 100 * DAY, nowMs: NOW });
	assert.equal(deep.fromMs, NOW - mirrorWindowMs(0));

	const merged = await readCapacityRecords({ redis: fakeMirror(kept, { size: RUNS_INDEX_MAX }), logsDir: tempDir("pi-cap-records-"), sinceMs: SINCE, nowMs: NOW, retentionDays: 30 });
	assert.deepEqual(merged.coverage.mirror, { fromMs: NOW - 3 * DAY, truncated: true, hosts: ["a"] });
	assert.equal(merged.coverage.source, "mirror+local");
});

test("the mirror's history starts no earlier than the mirror itself: its start, else its oldest run, and no index covers nothing", async () => {
	const kept = [rec("new", H), rec("old", 3 * DAY)];
	// The start the write that created the index recorded: a new deployment, or one whose keys were lost and recreated.
	const started = await readMirrorWindow(fakeMirror(kept, { since: NOW - 2 * DAY }), { sinceMs: SINCE, nowMs: NOW });
	assert.deepEqual([started.truncated, started.fromMs], [true, NOW - 2 * DAY], "nothing before the mirror started is idle");
	const before = await readMirrorWindow(fakeMirror(kept, { since: SINCE - DAY }), { sinceMs: SINCE, nowMs: NOW });
	assert.deepEqual([before.truncated, before.fromMs], [false, SINCE], "a start before the window cuts nothing of it");
	// No start, an index there (written before the key existed, or the key was lost): from its oldest run, never the
	// window's start.
	const unmarked = await readMirrorWindow(fakeMirror(kept, { since: null }), { sinceMs: SINCE, nowMs: NOW });
	assert.deepEqual([unmarked.truncated, unmarked.fromMs], [true, NOW - 3 * DAY]);
	// A start whose run is gone (it outlived its index, and an older worker recreated it): not trusted, from the oldest run.
	const stale = await readMirrorWindow(fakeMirror(kept, { since: SINCE - DAY, sinceHeld: false }), { sinceMs: SINCE, nowMs: NOW });
	assert.deepEqual([stale.truncated, stale.fromMs], [true, NOW - 3 * DAY]);
	const garbled = fakeMirror(kept);
	garbled.sinceAt = "soon";
	assert.equal((await readMirrorWindow(garbled, { sinceMs: SINCE, nowMs: NOW })).fromMs, NOW - 3 * DAY, "a start that is not a number is no start");
	// No index: the mirror covers nothing, so a named host's history is not here at all.
	const none = await readMirrorWindow(fakeMirror([], { since: NOW - 2 * DAY }), { sinceMs: SINCE, nowMs: NOW });
	assert.deepEqual([none.state, none.fromMs], ["off", null]);
	// The latest bound wins: a horizon past the start cuts further.
	const both = await readMirrorWindow(fakeMirror(kept, { since: NOW - 2 * DAY, horizon: NOW - DAY }), { sinceMs: SINCE, nowMs: NOW });
	assert.equal(both.fromMs, NOW - DAY);
});

test("a mirrored body over 256 KiB is skipped and counted, as a local file is", async () => {
	const redis = fakeMirror([rec("ok", H), rec("big", H, { pad: "x".repeat(SIZING_RECORD_MAX_BYTES) })]);
	const read = await readMirrorWindow(redis, { sinceMs: SINCE, nowMs: NOW });
	assert.deepEqual([read.records.map((r) => r.jobId), read.skipped], [["ok"], 1]);
	const both = await readCapacityRecords({ redis, logsDir: tempDir("pi-cap-records-"), sinceMs: SINCE, nowMs: NOW });
	assert.equal(both.coverage.skipped, 1);
	assert.match(both.coverage.reason, /1 record over 256 KiB skipped/);
});

test("an absent index is off, and a Valkey that does not answer is unreachable within the bound; both read the local files and say so", async () => {
	const dir = tempDir("pi-cap-records-");
	writer(dir)("l.json", JSON.stringify(rec("local", H)));
	const off = await readCapacityRecords({ redis: fakeMirror([]), logsDir: dir, sinceMs: SINCE, nowMs: NOW });
	assert.deepEqual([off.coverage.source, off.coverage.mirror, off.mirrorState, off.records.map((r) => r.jobId)], ["local", null, "off", ["local"]]);
	assert.match(off.coverage.reason, /no run mirror/);

	const hung = fakeMirror([rec("m", H)], { hang: true });
	const down = await readCapacityRecords({ redis: hung, logsDir: dir, sinceMs: SINCE, nowMs: NOW, timeoutMs: 20 });
	assert.deepEqual([down.coverage.source, down.coverage.mirror, down.records.map((r) => r.jobId)], ["local", null, ["local"]]);
	assert.equal(down.mirrorState, "unreachable (timeout)");
	assert.match(down.coverage.reason, /run mirror unreachable \(timeout\)/);
	const thrown = await readCapacityRecords({ redis: { eval: () => Promise.reject(new Error("ECONNREFUSED")) }, logsDir: dir, sinceMs: SINCE, nowMs: NOW });
	assert.match(thrown.coverage.reason, /unreachable \(ECONNREFUSED\)/);
	const none = await readCapacityRecords({ redis: null, logsDir: dir, sinceMs: SINCE, nowMs: NOW });
	assert.equal(none.coverage.source, "local");
	const refused = await readCapacityRecords({ redis: null, logsDir: dir, sinceMs: SINCE, nowMs: NOW, noMirrorReason: "Valkey refused (WRONGPASS)" });
	assert.equal(refused.coverage.reason, "Valkey refused (WRONGPASS)", "the caller's reason, not \"no run mirror\"");
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
	assert.deepEqual(readLocalWindow(join(dir, "absent"), { sinceMs: SINCE }), { records: [], skipped: 0, unreachable: null, absent: true }, "an absent directory holds no records, and says it is absent");
	const denied = readLocalWindow(dir, { sinceMs: SINCE, fs: { readdirSync: thrower("EACCES") } });
	assert.match(denied.unreachable, /EACCES/);
});

test("the local files cover this host to their retention; an absent or unreadable directory covers nothing", async () => {
	const dir = tempDir("pi-cap-records-");
	writer(dir)("l.json", JSON.stringify(rec("local", H, { host: "here" })));
	const three = await readCapacityRecords({ redis: null, logsDir: dir, sinceMs: SINCE, nowMs: NOW, retentionDays: 3, localHost: "here" });
	assert.deepEqual([three.coverage.local, three.coverage.localHost, three.coverage.localHosts], [{ fromMs: NOW - 3 * DAY }, "here", ["here"]]);
	const forever = await readCapacityRecords({ redis: null, logsDir: dir, sinceMs: NOW - 100 * DAY, nowMs: NOW, retentionDays: 0 });
	assert.deepEqual(forever.coverage.local, { fromMs: NOW - 100 * DAY }, "files kept forever cover the whole window");
	const absent = await readCapacityRecords({ redis: null, logsDir: join(dir, "nope"), sinceMs: SINCE, nowMs: NOW });
	assert.equal(absent.coverage.local, null);
	assert.match(absent.coverage.reason, /no logs directory here/);
	const denied = await readCapacityRecords({ redis: null, logsDir: dir, sinceMs: SINCE, nowMs: NOW, fs: { readdirSync: thrower("EACCES") } });
	assert.equal(denied.coverage.local, null);
	assert.match(denied.coverage.reason, /EACCES/);
});

test("both sources merge to one record per job, the later end winning, and each names the hosts it holds", async () => {
	const dir = tempDir("pi-cap-records-");
	const write = writer(dir);
	// The same job: attempt 1 failed here, attempt 2 ran on another host and was mirrored (a retry can move).
	write("j.json", JSON.stringify(rec("j", 3 * H, { outcome: "failed" })));
	write("only-local.json", JSON.stringify(rec("only-local", H)));
	const redis = fakeMirror([rec("j", H, { host: "b", outcome: "completed" }), rec("only-mirror", 2 * H, { host: "b" })]);
	const read = await readCapacityRecords({ redis, logsDir: dir, sinceMs: SINCE, nowMs: NOW, retentionDays: 3, localHost: "a" });
	assert.deepEqual(read.records.map((r) => [r.jobId, r.host]).sort(), [["j", "b"], ["only-local", "a"], ["only-mirror", "b"]]);
	assert.deepEqual([read.coverage.source, read.coverage.localHosts, read.coverage.mirror.hosts], ["mirror+local", ["a"], ["b"]]);
	assert.equal(read.coverage.mirror.fromMs, SINCE, "the reader's own retention does not bound the fleet's mirror; the horizon does");
	assert.equal(read.coverage.reason, null);
});

test("an expired or unparseable mirrored body is skipped, never shown, and never pruned by this reader", async () => {
	const redis = fakeMirror([rec("ok", H), rec("gone", H), rec("bad", H)]);
	redis.kv.delete(runRecordKey("gone"));
	redis.kv.set(runRecordKey("bad"), "{");
	const read = await readMirrorWindow(redis, { sinceMs: SINCE, nowMs: NOW });
	assert.deepEqual(read.records.map((r) => r.jobId), ["ok"]);
	assert.ok(redis.index.has("gone"), "the index member stays: a report writes nothing");
});
