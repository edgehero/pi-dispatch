import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	ACTIVITY_FILE,
	ACTIVITY_IDLE_ENV,
	ACTIVITY_NET_FLOOR_BYTES,
	ACTIVITY_SAMPLE_MS,
	ACTIVITY_STALL_ENV,
	ACTIVITY_STOP_SETTLE_MS,
	activityFileWriter,
	activitySettleMs,
	createActivityWatch,
	readActivityLimits,
	readNetBytes,
} from "../src/activity.mjs";
import { readCgroupCpuUsec } from "../src/cgroup-usage.mjs";
import { decideExit, EXIT_POLICY } from "../src/outcome.mjs";
import { createTranscriptMirror, RECORD_ACTIVITY, transcriptRecordMac, TRANSCRIPT_RECORD_MARKER } from "../src/transcript-mirror.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const MIN = 60_000;

/**
 * A watch on a fake clock with fake readers. `cpu` is the cgroup's total, `own` the runner's own CPU, `net` the bytes on
 * the interfaces; a test moves them and the clock, then calls `tick()` (one sample at the watch's interval).
 */
function harness({ idleMs = 15 * MIN, stallMs = 240 * MIN, sampleMs = ACTIVITY_SAMPLE_MS, cpu = 0, own = 0, net = 0, signature = () => "0:0" } = {}) {
	const h = { t: 1_000_000, cpu, own, net, stops: [], counters: [], logs: [] };
	h.watch = createActivityWatch({
		limits: { idleMs, stallMs },
		sampleMs,
		now: () => h.t,
		timers: { setInterval: () => null, clearInterval: () => {} },
		readCpuUsec: () => h.cpu,
		readOwnCpuUsec: () => h.own,
		readNet: () => h.net,
		meterSignature: () => signature(h),
		writeCounters: (c) => h.counters.push({ ...c }),
		onStop: (reason) => h.stops.push(reason),
		log: (event, fields) => h.logs.push({ event, ...fields }),
	});
	h.watch.start();
	h.tick = (ms = sampleMs) => {
		h.t += ms;
		h.watch.sample();
	};
	/** Advance `total` ms in sample-sized steps, running `during` before each sample. */
	h.run = (total, during = () => {}) => {
		for (let done = 0; done < total; done += sampleMs) {
			during(h);
			h.tick();
		}
	};
	return h;
}

test("the limits are read from the worker's two variables, which then leave the environment", () => {
	const env = { [ACTIVITY_IDLE_ENV]: "900000", [ACTIVITY_STALL_ENV]: "14400000", OTHER: "x" };
	assert.deepEqual(readActivityLimits(env), { idleMs: 900000, stallMs: 14400000 });
	assert.deepEqual(env, { OTHER: "x" });
	assert.deepEqual(readActivityLimits({}), { idleMs: null, stallMs: null });
	assert.deepEqual(readActivityLimits({ [ACTIVITY_IDLE_ENV]: "" }), { idleMs: null, stallMs: null });
});

test("a broken limit is refused as a config error, never guessed around", () => {
	for (const bad of ["-1", "1.5", "15m", "999", "99999999999", " 900000", "0x10"]) {
		assert.throws(() => readActivityLimits({ [ACTIVITY_IDLE_ENV]: bad }), (err) => err?.exitCode === EXIT_POLICY || /invalid PI_JOB_IDLE_MS/.test(err?.message), bad);
	}
});

test("nothing happening for the idle limit stops the job as idle, once", () => {
	const h = harness();
	h.run(15 * MIN - ACTIVITY_SAMPLE_MS);
	assert.deepEqual(h.stops, []);
	h.tick();
	assert.deepEqual(h.stops, ["idle"]);
	h.run(5 * MIN);
	assert.deepEqual(h.stops, ["idle"], "a stop is decided once");
	assert.equal(h.logs.filter((l) => l.event === "activity_stop").length, 1);
});

test("a step resets both clocks; a tool's output resets only the idle clock", () => {
	const h = harness({ idleMs: 15 * MIN, stallMs: 30 * MIN });
	h.run(14 * MIN);
	h.watch.observe({ type: "tool_execution_start" });
	h.run(14 * MIN);
	assert.deepEqual(h.stops, [], "a step 14 minutes in reset the idle clock");
	// Output every minute keeps the job from being idle, but the agent takes no step: it stalls at 30 minutes after its last step.
	h.run(17 * MIN, (x) => {
		if (x.t % MIN < ACTIVITY_SAMPLE_MS) x.watch.observe({ type: "tool_execution_update" });
	});
	assert.deepEqual(h.stops, ["stalled"]);
});

test("a background build the agent waits on with a silent sleep is activity, not idleness (CPU of other processes)", () => {
	const h = harness();
	// 50% of a core used by other processes, every sample, for an hour: no event at all.
	h.run(60 * MIN, (x) => {
		x.cpu += (ACTIVITY_SAMPLE_MS * 1000) / 2;
	});
	assert.deepEqual(h.stops, []);
	// The build ends; nothing else happens: idle 15 minutes later.
	h.run(15 * MIN);
	assert.deepEqual(h.stops, ["idle"]);
});

test("a test stuck in an endless loop keeps the CPU busy, so it is stopped as stalled at the stall limit, not before", () => {
	const h = harness();
	h.run(240 * MIN - ACTIVITY_SAMPLE_MS, (x) => {
		x.cpu += ACTIVITY_SAMPLE_MS * 1000;
	});
	assert.deepEqual(h.stops, []);
	h.cpu += ACTIVITY_SAMPLE_MS * 1000;
	h.tick();
	assert.deepEqual(h.stops, ["stalled"]);
});

test("a run that keeps taking steps for eight hours is never stopped", () => {
	const h = harness();
	h.run(8 * 60 * MIN, (x) => {
		if (x.t % (10 * MIN) < ACTIVITY_SAMPLE_MS) x.watch.observe({ type: "turn_start" });
	});
	assert.deepEqual(h.stops, []);
});

test("the runner's own CPU never counts: only what other processes used", () => {
	const h = harness();
	h.run(15 * MIN, (x) => {
		x.cpu += ACTIVITY_SAMPLE_MS * 1000;
		x.own += ACTIVITY_SAMPLE_MS * 1000;
	});
	assert.deepEqual(h.stops, ["idle"]);
});

test("CPU under the floor (an idle file watcher) is not activity", () => {
	const h = harness();
	h.run(15 * MIN, (x) => {
		x.cpu += (ACTIVITY_SAMPLE_MS * 1000) / 100; // 1% of a core
	});
	assert.deepEqual(h.stops, ["idle"]);
});

test("bytes on the network (a CI watch polling a remote) are activity; a quiet connection is not", () => {
	const busy = harness();
	busy.run(30 * MIN, (x) => {
		x.net += ACTIVITY_NET_FLOOR_BYTES;
	});
	assert.deepEqual(busy.stops, []);
	const quiet = harness();
	quiet.run(15 * MIN, (x) => {
		x.net += 100;
	});
	assert.deepEqual(quiet.stops, ["idle"]);
});

test("a change in what the meter counted is a step: an in-process subagent or a child pi process", () => {
	let calls = 0;
	const h = harness({ idleMs: 15 * MIN, stallMs: 30 * MIN, signature: () => `${calls}:0` });
	h.run(60 * MIN, (x) => {
		if (x.t % (10 * MIN) < ACTIVITY_SAMPLE_MS) calls += 1;
	});
	assert.deepEqual(h.stops, []);
});

test("pi's retry back-off suspends both clocks until its delay has passed", () => {
	const h = harness({ idleMs: 15 * MIN, stallMs: null });
	h.watch.observe({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 40 * MIN });
	h.run(40 * MIN);
	assert.deepEqual(h.stops, []);
	h.run(15 * MIN);
	assert.deepEqual(h.stops, ["idle"]);
});

test("a freeze (a sample far later than its interval) shifts the clocks instead of reading as idleness", () => {
	const h = harness();
	h.run(10 * MIN);
	h.tick(30 * MIN); // the container was paused for half an hour
	assert.deepEqual(h.stops, []);
	h.run(4 * MIN);
	assert.deepEqual(h.stops, []);
	h.run(2 * MIN);
	assert.deepEqual(h.stops, ["idle"]);
});

test("an unreadable cgroup reads as cpu:false and never as activity", () => {
	const h = harness();
	h.watch.stop();
	const w = createActivityWatch({
		limits: { idleMs: MIN, stallMs: null },
		sampleMs: 1000,
		now: () => h.t,
		timers: { setInterval: () => null, clearInterval: () => {} },
		readCpuUsec: () => null,
		readOwnCpuUsec: () => 0,
		readNet: () => {
			throw new Error("no /proc");
		},
		onStop: (reason) => h.stops.push(reason),
	});
	w.start();
	for (let i = 0; i < 60; i++) {
		h.t += 1000;
		w.sample();
	}
	assert.deepEqual(h.stops, ["idle"]);
	assert.deepEqual({ cpu: w.fields().cpu, net: w.fields().net }, { cpu: false, net: false });
});

test("after a stop, every new turn is aborted again, as the turn budget does", () => {
	const h = harness();
	h.run(15 * MIN);
	assert.deepEqual(h.stops, ["idle"]);
	h.watch.observe({ type: "turn_start" });
	h.watch.observe({ type: "message_update" });
	h.watch.observe({ type: "turn_start" });
	assert.deepEqual(h.stops, ["idle", "idle", "idle"]);
});

test("the counters only grow, change only on a sample that saw something, and carry no time", () => {
	const h = harness();
	assert.deepEqual(h.counters, [{ steps: 1, active: 1 }], "the baseline is written at start");
	h.tick();
	assert.equal(h.counters.length, 1, "a sample that saw nothing writes nothing");
	h.watch.observe({ type: "tool_execution_update" });
	h.tick();
	h.watch.observe({ type: "turn_end" });
	h.tick();
	assert.deepEqual(h.counters, [
		{ steps: 1, active: 1 },
		{ steps: 1, active: 2 },
		{ steps: 2, active: 3 },
	]);
});

test("the exit line's field: whole seconds since the last step and activity, and which probes read", () => {
	const h = harness();
	h.watch.observe({ type: "turn_start" });
	h.run(2 * MIN);
	h.watch.observe({ type: "tool_execution_update" });
	h.run(MIN);
	assert.deepEqual(h.watch.fields(), { sinceStepS: 180, sinceActivityS: 60, cpu: true, net: true });
});

test("the sample interval follows a short limit, never below a quarter second", () => {
	const watch = (limits) => createActivityWatch({ limits, timers: { setInterval: () => null, clearInterval: () => {} } });
	assert.equal(watch({ idleMs: 15 * MIN, stallMs: 240 * MIN }).interval, ACTIVITY_SAMPLE_MS);
	assert.equal(watch({ idleMs: 4000, stallMs: null }).interval, 1000);
	assert.equal(watch({ idleMs: null, stallMs: 1000 }).interval, 250);
});

test("the settle bound is a minute, or the shortest limit when shorter, never under five seconds", () => {
	assert.equal(activitySettleMs({ idleMs: 15 * MIN, stallMs: 240 * MIN }), ACTIVITY_STOP_SETTLE_MS);
	assert.equal(activitySettleMs({ idleMs: 3000, stallMs: null }), 5000);
	assert.equal(activitySettleMs({ idleMs: null, stallMs: 20_000 }), 20_000);
});

test("decideExit names an activity stop as a policy exit, after the spend stops and before the aborted message", () => {
	const aborted = { role: "assistant", stopReason: "aborted", content: [] };
	assert.deepEqual(decideExit({ budgetAborted: false, tokenAborted: false, activityStop: "idle", terminal: aborted }), { code: EXIT_POLICY, reason: "idle" });
	assert.deepEqual(decideExit({ budgetAborted: false, tokenAborted: false, activityStop: "stalled", terminal: aborted }), { code: EXIT_POLICY, reason: "stalled" });
	assert.equal(decideExit({ budgetAborted: true, budgetTurns: 31, tokenAborted: false, activityStop: "idle", terminal: aborted }).reason, "turn_budget");
	assert.equal(decideExit({ budgetAborted: false, meterStop: "cost-cap", tokenAborted: false, activityStop: "idle", terminal: aborted }).reason, "cost-cap");
	assert.notEqual(decideExit({ budgetAborted: false, tokenAborted: false, activityStop: "anything", terminal: aborted }).reason, "anything");
});

test("the counters file is written atomically beside the session file and never through a link", () => {
	const dir = tempDir("activity-");
	const session = join(dir, "current.jsonl");
	fs.writeFileSync(session, "");
	const write = activityFileWriter(session);
	write({ steps: 3, active: 7 });
	assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, ACTIVITY_FILE), "utf8")), { v: 1, steps: 3, active: 7 });
	// A link planted where the temp file goes is not followed: the write fails quietly and the outside file is untouched.
	const outside = join(dir, "outside.txt");
	fs.writeFileSync(outside, "keep");
	fs.symlinkSync(outside, join(dir, `.${ACTIVITY_FILE}.tmp`));
	write({ steps: 4, active: 8 });
	assert.equal(fs.readFileSync(outside, "utf8"), "keep");
	assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, ACTIVITY_FILE), "utf8")), { v: 1, steps: 3, active: 7 });
	// No session file, no writer.
	assert.doesNotThrow(() => activityFileWriter(undefined)({ steps: 1, active: 1 }));
});

test("on a copying venue the counters ride the transcript mirror as a signed `a` record after the baseline", () => {
	const dir = tempDir("activity-mirror-");
	const file = join(dir, "current.jsonl");
	fs.writeFileSync(file, "");
	const out = [];
	const mirror = createTranscriptMirror({ file, key: "k".repeat(64), runId: "run-1", write: (text) => out.push(text), timers: { setInterval: () => null, clearInterval: () => {} } });
	mirror.activity({ steps: 1, active: 1 });
	assert.equal(out.length, 0, "nothing before start");
	mirror.start();
	mirror.activity({ steps: 2, active: 5 });
	assert.equal(out.length, 2);
	const [seq, type, end, mac, payload] = out[1].slice(TRANSCRIPT_RECORD_MARKER.length).trim().split(" ");
	assert.deepEqual([seq, type, end], ["2", RECORD_ACTIVITY, "0"]);
	const bytes = Buffer.from(payload, "base64");
	assert.deepEqual(JSON.parse(bytes.toString("utf8")), { v: 1, steps: 2, active: 5 });
	assert.equal(mac, transcriptRecordMac("k".repeat(64), "run-1", 2, RECORD_ACTIVITY, 0, bytes));
});

test("the network reader sums every interface but loopback, and says null when there is none", () => {
	const dev = (rows) => ({ readFileSync: () => `Inter-|   Receive\n face |bytes\n${rows.join("\n")}\n` });
	const row = (name, rx, tx) => `  ${name}: ${rx} 1 0 0 0 0 0 0 ${tx} 1 0 0 0 0 0 0`;
	assert.equal(readNetBytes({ fs: dev([row("lo", 999, 999), row("eth0", 100, 50), row("eth1", 1, 2)]) }), 153);
	assert.equal(readNetBytes({ fs: dev([row("lo", 999, 999)]) }), null);
	assert.equal(readNetBytes({ fs: { readFileSync: () => { throw new Error("ENOENT"); } } }), null);
});

test("the CPU reader takes usage_usec from the job's own v2 cgroup, and null when there is none", () => {
	const files = {
		"/sys/fs/cgroup/cgroup.controllers": "cpu memory",
		"/proc/self/cgroup": "0::/\n",
		"/sys/fs/cgroup/cpu.stat": "usage_usec 123456\nuser_usec 100000\nsystem_usec 23456\n",
	};
	const fake = (map) => ({ readFileSync: (p) => (p in map ? map[p] : (() => { throw new Error("ENOENT"); })()), existsSync: (p) => p in map });
	assert.equal(readCgroupCpuUsec({ fs: fake(files) }), 123456);
	assert.equal(readCgroupCpuUsec({ fs: fake({}) }), null);
	assert.equal(readCgroupCpuUsec({ fs: fake({ ...files, "/proc/self/cgroup": "0::/../escape\n" }) }), null);
});
