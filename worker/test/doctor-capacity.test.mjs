import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPACITY_WINDOWS, computeCapacity } from "../src/capacity.mjs";
import { readCapacityRecords } from "../src/capacity-records.mjs";
import { capacityChecks, doctorCapacity } from "../src/doctor.mjs";
import { RUNS_HORIZON, RUNS_INDEX, runRecordKey } from "../src/run-mirror.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Doctor's capacity lines (issue #599, phase 2): one fact per host, never a warning. Every instant is an offset from
// one injected NOW.
const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const M = 60 * 1000;
const H = 60 * M;
const DAY = 24 * H;
const W = CAPACITY_WINDOWS["7d"];
const iso = (ms) => new Date(ms).toISOString();
const CAP = { slots: 4, memMiB: 16384, cpuCenti: 800, cpus: 8 };
const run = (jobId, from, to, extra = {}) => ({ jobId, host: "a", project: "web", startedAt: iso(NOW - from * H), endedAt: iso(NOW - to * H), queuedAt: iso(NOW - from * H - 40_000), capacity: CAP, size: { memMiB: 4096, cpuCenti: 200, source: "project" }, resources: { cpuUsec: 3600e6 }, ...extra });
const week = (records, opts = {}) => computeCapacity({ records, windowStartMs: NOW - W.ms, nowMs: NOW, bucketMs: W.bucketMs, ...opts });

test("one fact line per host: busy, slots, promises, CPU used, waits and the busiest project", () => {
	const lines = capacityChecks(week([run("1", 10, 8), run("2", 9, 7)]));
	assert.deepEqual(lines, [{ ok: true, label: "Host a: last 7d busy 1.8% (avg 0 of 4 slots, full 0%), promised 0.6% memory / 0.6% CPU, used 0.1% CPU of 8, wait p50 40s p95 40s, most busy: web" }]);
});

test("a host with no budget and no CPU count says only what it knows", () => {
	const plain = { slots: 2, memMiB: null, cpuCenti: null, cpus: null };
	const [line] = capacityChecks(week([run("1", 2, 1, { capacity: plain, resources: undefined, queuedAt: undefined, project: null })]));
	assert.equal(line.label, "Host a: last 7d busy 0.6% (avg 0 of 2 slots, full 0%), most busy: (no project)");
	assert.equal(line.ok, true);
	assert.equal(line.warn, undefined, "never a warning");
});

test("the coverage clauses: running now, a cut history, this host's files only, not shared, running jobs not counted", () => {
	const live = [{ name: "a", concurrency: "4", routes: "true", staleMs: 1000, jobs: [{ id: "x", p: "web", m: 4096, c: 200, at: NOW - H, o: false }], jobsMore: 2 }, { name: "b", routes: "false", staleMs: 1000, jobs: [], jobsMore: 0 }];
	const report = week([run("1", 30, 29)], { live, coverage: { source: "mirror+local", localHost: "z", local: { fromMs: NOW - DAY }, mirror: { fromMs: NOW - 2 * DAY, truncated: true, hosts: ["a"] } } });
	const labels = capacityChecks(report).map((c) => c.label);
	// Two hours busy (the record's and the running job's) over the 48 the mirror covers.
	assert.equal(labels[0], "Host a: last 7d busy 4.2% (avg 0 of 4 slots, full 0%), promised 1% memory / 1% CPU, used 0.3% CPU of 8, wait p50 40s p95 40s, most busy: web; 1 running now, counted to now; history from 2026-10-06 12:00 UTC only (the run mirror holds nothing older), earlier time counted as neither busy nor idle; 2 running now not counted");
	assert.equal(labels[1], "Host b: last 7d no history here; no source here holds its runs (a worker without PI_WORKER_NAME writes no run mirror)");
	const local = capacityChecks(week([run("1", 2, 1)], { coverage: { source: "local", localHost: "a", local: { fromMs: NOW - W.ms }, mirror: null } }));
	assert.match(local[0].label, /; this host's files only$/);
	assert.deepEqual(capacityChecks(week([])), [], "no host: no line");
});

test("no control character reaches a line, whatever the report holds", () => {
	const report = week([run("1", 2, 1)]);
	report.hosts[0].name = "a\u001b[2Jb\u0007";
	report.hosts[0].projects[0].project = "w\u009beb";
	assert.doesNotMatch(capacityChecks(report)[0].label, /[\u0000-\u001f\u007f-\u009f]/);
});

test("doctorCapacity reads through its seam over the last 7 days, and a slow or failing read costs one line, never the run", async () => {
	const asked = [];
	const read = async ({ signal, ...args }) => (asked.push({ ...args, signal: signal instanceof AbortSignal }), { records: [run("1", 2, 1)], coverage: { source: "local", localHost: "a", local: { fromMs: args.sinceMs }, mirror: null } });
	const env = { PI_LOGS_DIR: "/srv/logs", PI_LOG_RETENTION_DAYS: "3" };
	const lines = await doctorCapacity({ seams: { readCapacity: read, wallClock: () => NOW }, env, home: "/home/op", url: "redis://v:6379", hosts: [], localHost: "a" });
	assert.deepEqual(asked, [{ url: "redis://v:6379", logsDir: "/srv/logs", sinceMs: NOW - W.ms, nowMs: NOW, retentionDays: 3, localHost: "a", signal: true }]);
	assert.match(lines[0].label, /^Host a: last 7d busy/);
	const slow = await doctorCapacity({ seams: { readCapacity: () => new Promise(() => {}), wallClock: () => NOW, capacityTimeoutMs: 20 }, env, home: "/h", url: null, hosts: [], localHost: "a" });
	assert.deepEqual(slow, [{ ok: true, label: "Capacity: the run history did not answer in time, so nothing is shown (pi-dispatch capacity waits up to 2 s per Valkey call)" }]);
	// The read it gave up on is told to stop.
	let told = null;
	await doctorCapacity({ seams: { readCapacity: ({ signal }) => new Promise(() => signal.addEventListener("abort", () => (told = true))), wallClock: () => NOW, capacityTimeoutMs: 10 }, env, home: "/h", url: null, hosts: [], localHost: "a" });
	assert.equal(told, true);
	const broken = await doctorCapacity({ seams: { readCapacity: () => {
		throw new Error("boom\u001b[2J");
	}, wallClock: () => NOW }, env: {}, home: "/h", url: null, hosts: [], localHost: "a" });
	assert.equal(broken.length, 1);
	assert.equal(broken[0].ok, true);
	assert.doesNotMatch(broken[0].label, /\u001b/);
	// A retention that is not a number reads as the worker's default, 30 days.
	const asked30 = [];
	await doctorCapacity({ seams: { readCapacity: async (a) => (asked30.push(a.retentionDays), { records: [], coverage: {} }), wallClock: () => NOW }, env: { PI_LOG_RETENTION_DAYS: "x" }, home: "/h", url: null, hosts: [], localHost: "a" });
	assert.deepEqual(asked30, [30]);
});

test("a full mirror (5000 runs) costs doctor well under a second: twelve bounded round trips and one sweep", async () => {
	const index = [];
	const kv = new Map();
	for (let i = 0; i < 5000; i++) {
		const end = NOW - Math.floor((i * W.ms) / 5000);
		const r = { jobId: `gh-${i}`, host: `h${i % 3}`, project: `p${i % 7}`, startedAt: iso(end - 20 * M), endedAt: iso(end), queuedAt: iso(end - 21 * M), capacity: CAP, size: { memMiB: 2048, cpuCenti: 100, source: "project" }, resources: { cpuUsec: 600e6 } };
		index.push([r.jobId, end]);
		kv.set(runRecordKey(r.jobId), JSON.stringify(r));
	}
	const calls = [];
	const redis = {
		zcard: async (k) => (calls.push("zcard"), k === RUNS_INDEX ? index.length : 0),
		zrange: async () => (calls.push("zrange"), [index.at(-1)[0], String(index.at(-1)[1])]),
		zscore: async (k) => (calls.push("zscore"), k === RUNS_HORIZON ? null : null),
		zrevrangebyscore: async (_k, _max, min) => (calls.push("zrevrangebyscore"), index.filter(([, s]) => s > Number(min.slice(1))).flatMap(([id, s]) => [id, String(s)])),
		mget: async (...keys) => (calls.push("mget"), keys.map((k) => kv.get(k) ?? null)),
	};
	const logsDir = tempDir("pi-doctor-capacity-");
	const started = performance.now();
	const lines = await doctorCapacity({ seams: { readCapacity: (args) => readCapacityRecords({ ...args, redis }), wallClock: () => NOW }, env: { PI_LOGS_DIR: logsDir }, home: "/h", url: "redis://v", hosts: [], localHost: "h0" });
	const ms = performance.now() - started;
	assert.deepEqual(lines.map((l) => l.label.slice(0, 7)), ["Host h0", "Host h1", "Host h2"]);
	assert.equal(calls.length, 3 + 1 + 10, "ZCARD, the oldest, the horizon, the range, then ten MGETs of 500");
	assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
});

test("the line says when a host's list of running jobs could not be read", () => {
	const [line] = capacityChecks(week([run("1", 2, 1)], { live: [{ name: "a", routes: "true", staleMs: 1000, jobs: null, jobsUnreadable: true }] }));
	assert.match(line.label, /; its running jobs could not be read, not counted$/);
});

test("a Valkey that accepts the connection and never answers: the default read gives up within its bound and leaves no socket open", async () => {
	const net = await import("node:net");
	const sockets = new Set();
	const server = net.createServer((s) => (sockets.add(s), s.on("data", () => {})));
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	try {
		const t0 = performance.now();
		const lines = await doctorCapacity({ seams: { capacityTimeoutMs: 300 }, env: { PI_LOGS_DIR: tempDir("pi-doctor-hang-") }, home: "/h", url: `redis://127.0.0.1:${port}/13`, hosts: [], localHost: "a" });
		assert.match(lines[0].label, /did not answer in time/);
		assert.ok(performance.now() - t0 < 1500);
		// Closed by the time doctor has its line, not a tick later.
		const clientSockets = process._getActiveHandles().filter((h) => h?.constructor?.name === "Socket" && !h.destroyed && h.remotePort === port);
		assert.equal(clientSockets.length, 0, "the client's socket is closed when doctor returns");
	} finally {
		for (const s of sockets) s.destroy();
		server.close();
	}
});

test("a doctor that gave up on a Valkey that never answers exits at once: nothing of the read holds the process", async () => {
	const { spawn } = await import("node:child_process");
	const doctorUrl = new URL("../src/doctor.mjs", import.meta.url).href;
	const script = `
		import net from "node:net";
		const { doctorCapacity } = await import(${JSON.stringify(doctorUrl)});
		const server = net.createServer((s) => s.on("data", () => {}));
		await new Promise((r) => server.listen(0, "127.0.0.1", r));
		server.unref();
		const t0 = Date.now();
		const lines = await doctorCapacity({ seams: { capacityTimeoutMs: Number(process.argv[1]) }, env: { PI_LOGS_DIR: process.argv[2] }, home: "/h", url: "redis://127.0.0.1:" + server.address().port + "/13", hosts: [], localHost: "a" });
		process.on("exit", () => console.log(JSON.stringify({ returnedMs: Date.now() - t0 - 0, label: lines[0]?.label ?? null, exitMs: Date.now() - t0 })));
	`;
	const runChild = (timeoutMs) =>
		new Promise((resolve, reject) => {
			const child = spawn(process.execPath, ["--input-type=module", "-e", script, String(timeoutMs), tempDir("pi-doctor-exit-")], { stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
			child.on("close", () => (clearTimeout(kill), out ? resolve(JSON.parse(out.trim().split("\n").at(-1))) : reject(new Error("no output"))));
		});
	// Doctor's own bound first: the read is stopped and the process ends right after the line.
	const stopped = await runChild(300);
	assert.match(stopped.label, /did not answer in time/);
	assert.ok(stopped.exitMs < 1000, `exited ${stopped.exitMs} ms after it began`);
	// The connection's own bound (2 s) before doctor's: the report is this host's files, said, and nothing lingers.
	const local = await runChild(10_000);
	assert.ok(local.label === null || !/did not answer in time/.test(local.label), "the connection bound answered first");
	assert.ok(local.exitMs < 3000, `exited ${local.exitMs} ms after it began`);
});
