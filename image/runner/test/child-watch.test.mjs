import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createChildWatch, isPiProcess, linuxProc, NO_LEDGER_TICKS, STARTING_GRACE_MS } from "../src/child-watch.mjs";
import { COST_CAP, MODEL_NOT_ALLOWED, TOKEN_BUDGET } from "../src/outcome.mjs";
import { createPolicyGuard, createUsageMeter, foldChildLedgers, writeFileAtomic } from "../src/usage-meter.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #500 part E: the parent's children hook (child-watch.mjs; DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY). A real
 * ledger directory and real files, written the way a child writes them; the process table is injected (`proc`), so the
 * detector's rules run on any platform. child-watch.integration.test.mjs runs real pi children against the hook.
 */

/** A ledger row with the ten numerics, zero unless given. */
const row = (provider, model, fields = {}) => ({ provider, model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 0, cost: 0, unpriced: 0, ...fields });

/** A well-formed ledger: `calls` settled calls of `each` tokens on one pair, plus `unresolved` calls in flight. */
function ledger({ state = "running", metered = true, calls = 1, each = 100, provider = "fake", model = "m1", unresolved = 0, spentMicros = 0, inflightMicros = 0, costRefused = 0, modelRefused = 0 } = {}) {
	const rows = calls === 0 ? [] : [row(provider, model, { calls, input: calls * each, total: calls * each, cost: calls * 0.001 })];
	return {
		v: 1,
		state,
		metered,
		totals: { input: calls * each, output: 0, total: calls * each, cost: calls * 0.001, calls: calls + unresolved, unresolved, unpriced: 0, sessions: calls === 0 ? 0 : 1 },
		rows,
		spentMicros,
		inflightMicros,
		costRefused,
		modelRefused,
	};
}

/** Write a child's ledger as a child does: whole, by rename. */
function writeLedger(dir, pid, body, nonce = "0123456789abcdef") {
	const name = `${pid}.${nonce}.json`;
	writeFileAtomic({ dir, name, text: JSON.stringify(body) });
	return name;
}

/** A process table: `live` the pi pids scan() finds, `alive` the pids that exist (live ones included). */
function fakeProc({ live = [], alive = [] } = {}) {
	const table = { live: [...live], alive: new Set([...live, ...alive]) };
	return { table, scan: () => [...table.live], alive: (pid) => table.alive.has(pid) };
}

/** A hook on a fresh directory, with its log. */
function watch({ meter, proc = null, guard = () => null, now = () => 0, ...rest } = {}) {
	const dir = tempDir("pi-dispatch-watch-");
	const logged = [];
	const hook = createChildWatch({ dir, meter, guard, proc, now, log: (event, fields) => logged.push({ event, fields }), ...rest });
	return { dir, hook, logged };
}

const stopOf = (dir) => JSON.parse(readFileSync(join(dir, "STOP"), "utf8"));
const usage = (total) => ({ input: total, output: 0, totalTokens: total, cost: { total: 0.001 } });

test("with no children the exit line is the one it was, plus the three child keys at zero, after unpriced (issue #500)", () => {
	const plain = createUsageMeter({ maxTokens: 10_000, rootSessionId: "root" });
	const watched = createUsageMeter({ maxTokens: 10_000, rootSessionId: "root" });
	const { dir, hook } = watch({ meter: watched });
	for (const meter of [plain, watched]) {
		meter.record(usage(120), { sessionId: "root", provider: "fake", modelId: "m1" });
		meter.record(usage(30), { sessionId: "sub", provider: "fake", modelId: "m2" });
	}
	hook.sample();
	hook.sample();
	const guard = createPolicyGuard({ maxCostMicros: 5_000_000, env: {} });
	const line = (meter) => JSON.stringify({ tokens: { ...meter.snapshot(), ...guard.snapshot() }, usage: meter.usageSnapshot() });
	const parsed = JSON.parse(line(watched));
	assert.deepEqual([parsed.tokens.childTotal, parsed.tokens.childProcesses, parsed.tokens.unmeteredChildren], [0, 0, 0]);
	const keys = Object.keys(parsed.tokens);
	assert.deepEqual(keys.slice(keys.indexOf("unpriced") + 1, keys.indexOf("unpriced") + 4), ["childTotal", "childProcesses", "unmeteredChildren"]);
	delete parsed.tokens.childTotal;
	delete parsed.tokens.childProcesses;
	delete parsed.tokens.unmeteredChildren;
	assert.equal(JSON.stringify(parsed), line(plain), "everything else byte-identical");
	// The keys are there before the first tick too: the hook hands over an empty fold when it is made.
	const early = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	createChildWatch({ dir, meter: early, proc: null });
	assert.deepEqual(Object.keys(early.snapshot()).slice(-3), ["childTotal", "childProcesses", "unmeteredChildren"]);
	assert.deepEqual(hook.teardown(), { distinct: null, peak: null, unmetered: 0 }, "no detector off Linux");
	assert.equal(watched.state.stopReason, null);
	assert.equal(existsSync(dir), false, "the ledger directory is removed after the final fold");
});

test("each tick folds the ledgers into the meter: totals, rows and the three keys (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const { dir, hook } = watch({ meter });
	meter.record(usage(50), { sessionId: "root", provider: "fake", modelId: "m1" });
	writeLedger(dir, 41, ledger({ calls: 2, each: 100 }));
	hook.sample();
	const snap = meter.snapshot();
	assert.deepEqual([snap.total, snap.childTotal, snap.childProcesses, snap.unmeteredChildren, snap.calls], [250, 200, 1, 0, 2], "record() counts no call; the child's two do");
	assert.equal(snap.rootTotal + snap.otherTotal + snap.looseTotal + snap.childTotal, snap.total);
	assert.deepEqual(meter.usageSnapshot().models.map((m) => [m.provider, m.model, m.calls, m.total]), [["fake", "m1", 3, 250]]);
});

test("parent plus children past maxTokens stops token_budget and writes STOP; a deleted STOP and a deleted directory come back (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: 1000, rootSessionId: "root" });
	const { dir, hook, logged } = watch({ meter });
	meter.record(usage(400), { sessionId: "root", provider: "fake", modelId: "m1" });
	writeLedger(dir, 7, ledger({ calls: 1, each: 500 }));
	hook.sample();
	assert.equal(meter.state.stopReason, null, "900 is under the cap");
	assert.equal(existsSync(join(dir, "STOP")), false, "no STOP before a stop");
	writeLedger(dir, 7, ledger({ calls: 2, each: 500 }));
	hook.sample();
	assert.equal(meter.state.stopReason, TOKEN_BUDGET);
	assert.deepEqual(stopOf(dir), { v: 1, reason: TOKEN_BUDGET });
	// The agent deletes STOP: the next tick writes it again.
	rmSync(join(dir, "STOP"));
	hook.sample();
	assert.deepEqual(stopOf(dir), { v: 1, reason: TOKEN_BUDGET }, "STOP is rewritten on every tick once stopped");
	// The agent deletes the whole directory: it is made again, STOP is back, and the loss is counted unmetered.
	rmSync(dir, { recursive: true });
	hook.sample();
	assert.deepEqual(stopOf(dir), { v: 1, reason: TOKEN_BUDGET });
	assert.ok(meter.snapshot().unmeteredChildren >= 1, "a lost directory is a breach");
	assert.equal(meter.snapshot().childTotal, 1000, "the high-water mark keeps what the lost file had reached");
	assert.equal(logged.filter((line) => line.event === "unmetered_child").length, 1);
});

test("under a dollar cap: SPENT is written each tick, external() is the children's spend, and the parent's plus the children's spend past the cap is cost-cap (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: null, maxCostMicros: 1_000_000, rootSessionId: "root" });
	let own = { spentMicros: 900_000, inflightMicros: 5_000 };
	const { dir, hook } = watch({ meter, guard: () => ({ spend: () => own }) });
	const name = writeLedger(dir, 9, ledger({ spentMicros: 60_000, inflightMicros: 2_000 }));
	hook.sample();
	assert.equal(meter.state.stopReason, null, "960,000 settled is under the cap");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "SPENT"), "utf8")), { v: 1, total: 905_000 + 62_000, byLedger: { [name]: 62_000 } });
	assert.equal(hook.external(), 62_000, "the parent's guard sees each child's spent and in-flight");
	own = { spentMicros: 950_000, inflightMicros: 0 };
	hook.sample();
	assert.equal(meter.state.stopReason, COST_CAP, "950,000 + 60,000 settled passes 1,000,000");
	assert.deepEqual(stopOf(dir), { v: 1, reason: COST_CAP });
});

test("a child's costRefused is cost-cap under a dollar cap; with no dollar cap it stops nothing (issue #500)", () => {
	const capped = createUsageMeter({ maxTokens: null, maxCostMicros: 1_000_000, rootSessionId: "root" });
	const a = watch({ meter: capped });
	writeLedger(a.dir, 9, ledger({ calls: 0, costRefused: 1 }));
	a.hook.sample();
	assert.equal(capped.state.stopReason, COST_CAP);
	const uncapped = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const b = watch({ meter: uncapped });
	writeLedger(b.dir, 9, ledger({ calls: 0, costRefused: 1 }));
	b.hook.sample();
	assert.equal(uncapped.state.stopReason, null);
});

test("under a model list: a child row off the PARENT's list, a model-less child row, or a child's modelRefused is model-not-allowed (issue #500)", () => {
	const listed = [{ provider: "fake", model: "m1" }];
	for (const [label, body, want] of [
		["a listed row", ledger({ provider: "fake", model: "m1" }), null],
		["a row the parent's list does not name (the child's own list was widened)", ledger({ provider: "fake", model: "other" }), MODEL_NOT_ALLOWED],
		["the same id under another provider", ledger({ provider: "other", model: "m1" }), MODEL_NOT_ALLOWED],
		["a refusal in the child", ledger({ calls: 0, modelRefused: 1 }), MODEL_NOT_ALLOWED],
	]) {
		const meter = createUsageMeter({ maxTokens: null, allowedModels: listed, rootSessionId: "root" });
		const { dir, hook } = watch({ meter });
		writeLedger(dir, 5, body);
		hook.sample();
		assert.equal(meter.state.stopReason, want, label);
		if (want !== null) assert.deepEqual(stopOf(dir), { v: 1, reason: want });
	}
	const meter = createUsageMeter({ maxTokens: null, allowedModels: listed, rootSessionId: "root" });
	const { dir, hook } = watch({ meter });
	const modelless = ledger({ calls: 0 });
	modelless.totals = { ...modelless.totals, input: 10, total: 10, calls: 1 };
	modelless.rows = [row(null, null, { calls: 1, input: 10, total: 10 })];
	writeLedger(dir, 5, modelless);
	hook.sample();
	assert.equal(meter.state.stopReason, MODEL_NOT_ALLOWED, "a call with no model cannot be on the list");
});

test("the detector: a registered child is metered however long it lives; a pi process with no ledger is unmetered after two ticks (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
	const proc = fakeProc({ live: [31, 32] });
	const { dir, hook, logged } = watch({ meter, proc });
	writeLedger(dir, 31, ledger());
	for (let tick = 0; tick < NO_LEDGER_TICKS; tick += 1) hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 0, "not yet: a child's preload may not have written its stub");
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 1, "pid 32 has no ledger two ticks on; pid 31 has one");
	assert.equal(meter.snapshot().childProcesses, 2, "both are child processes");
	assert.equal(meter.state.stopReason, TOKEN_BUDGET, "under a token cap an unmetered child is a breach");
	assert.deepEqual(logged.filter((line) => line.event === "unmetered_child"), [{ event: "unmetered_child", fields: { why: "no-ledger", pid: 32, unmetered: 1 } }]);
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 1, "counted once");
	assert.deepEqual(hook.teardown(), { distinct: 2, peak: 2, unmetered: 1 });
});

test("an unmetered child's stop: cost-cap under a dollar cap, else token_budget under a token cap, else model-not-allowed under a list; uncapped, a floor only (issue #500)", () => {
	for (const [options, want] of [
		[{ maxTokens: 1_000_000, maxCostMicros: 1_000_000, allowedModels: [{ provider: "fake", model: "m1" }] }, COST_CAP],
		[{ maxTokens: 1_000_000, allowedModels: [{ provider: "fake", model: "m1" }] }, TOKEN_BUDGET],
		[{ maxTokens: null, allowedModels: [{ provider: "fake", model: "m1" }] }, MODEL_NOT_ALLOWED],
		[{ maxTokens: null }, null],
	]) {
		const meter = createUsageMeter({ ...options, rootSessionId: "root" });
		const { hook, logged } = watch({ meter, proc: fakeProc({ live: [44] }) });
		for (let tick = 0; tick <= NO_LEDGER_TICKS; tick += 1) hook.sample();
		assert.equal(meter.state.stopReason, want, JSON.stringify(options));
		assert.equal(meter.snapshot().unmeteredChildren, 1, "the floor is recorded either way");
		assert.equal(logged.filter((line) => line.event === "unmetered_child").length, 1);
	}
});

test("a pi process seen alive whose ledger never appeared counts at teardown, even when it lived less than two ticks (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const proc = fakeProc({ live: [50] });
	const { hook } = watch({ meter, proc });
	hook.sample();
	proc.table.live = [];
	hook.sample();
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 0, "gone before its two ticks");
	assert.deepEqual(hook.teardown(), { distinct: 1, peak: 1, unmetered: 1 });
	assert.equal(meter.snapshot().unmeteredChildren, 1);
});

test("a `starting` ledger: a dead pid with zero spend is done, never unmetered; a live one past the grace is unmetered; a dead one with spend is too (issue #500)", () => {
	let clock = 0;
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const proc = fakeProc({ live: [61, 62], alive: [] });
	const { dir, hook } = watch({ meter, proc, now: () => clock });
	writeLedger(dir, 60, ledger({ state: "starting", calls: 0 }), "aaaaaaaaaaaaaaaa");
	writeLedger(dir, 61, ledger({ state: "starting", calls: 0 }), "bbbbbbbbbbbbbbbb");
	writeLedger(dir, 63, ledger({ state: "starting", calls: 1 }), "cccccccccccccccc");
	writeLedger(dir, 62, ledger({ state: "starting", calls: 0 }), "dddddddddddddddd");
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 1, "only the dead `starting` ledger with spend in it (pid 63)");
	clock = STARTING_GRACE_MS;
	writeLedger(dir, 62, ledger({ state: "running", calls: 0 }), "dddddddddddddddd");
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 1, "at the grace, not past it; pid 62's meter installed");
	clock = STARTING_GRACE_MS + 1;
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 2, "pid 61 is still `starting` and alive past the grace");
	assert.equal(hook.teardown().unmetered, 2, "pid 60, dead with zero spend, is done");
});

test("a child killed mid-call leaves `running` with unresolved: counted unresolved, not unmetered (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const proc = fakeProc({ live: [70] });
	const { dir, hook } = watch({ meter, proc });
	writeLedger(dir, 70, ledger({ calls: 1, unresolved: 1 }));
	hook.sample();
	proc.table.live = [];
	proc.table.alive.delete(70);
	hook.sample();
	const { unresolved, unmeteredChildren } = meter.snapshot();
	assert.deepEqual([unresolved, unmeteredChildren], [1, 0]);
	assert.equal(hook.teardown().unmetered, 0);
});

test("the parent's own failure to write STOP or SPENT is a breach (issue #500)", () => {
	const failing = { openSync: () => {
		throw Object.assign(new Error("denied"), { code: "EACCES" });
	} };
	const writeFs = new Proxy(failing, { get: (target, key) => target[key] ?? (key === "constants" ? { O_WRONLY: 1, O_CREAT: 64, O_EXCL: 128 } : () => {}) });
	// STOP: the meter stopped on its own; the STOP that cannot be written is counted unmetered, and logged.
	const stopped = createUsageMeter({ maxTokens: 10, rootSessionId: "root" });
	const a = watch({ meter: stopped, writeFs });
	stopped.record(usage(20), { sessionId: "root" });
	a.hook.sample();
	assert.equal(stopped.state.stopReason, TOKEN_BUDGET);
	assert.equal(stopped.snapshot().unmeteredChildren, 1);
	assert.deepEqual(a.logged.filter((line) => line.event === "unmetered_child").map((line) => line.fields.why), ["control-write"]);
	// SPENT under a dollar cap, before any stop: the job stops cost-cap.
	const capped = createUsageMeter({ maxTokens: null, maxCostMicros: 1_000_000, rootSessionId: "root" });
	const b = watch({ meter: capped, writeFs });
	b.hook.sample();
	assert.equal(capped.state.stopReason, COST_CAP);
	assert.equal(capped.snapshot().unmeteredChildren, 1);
});

test("teardown writes STOP FIRST, then folds once more (a child's last write counts), then removes the directory (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const order = [];
	let dir;
	const fold = (args) => {
		order.push(existsSync(join(dir, "STOP")) ? "fold after STOP" : "fold before STOP");
		return foldChildLedgers(args);
	};
	const made = watch({ meter, fold });
	dir = made.dir;
	made.hook.sample();
	writeLedger(dir, 80, ledger({ calls: 3, each: 10, unresolved: 1 }));
	const torn = made.hook.teardown();
	assert.deepEqual(order, ["fold before STOP", "fold after STOP"]);
	assert.equal(meter.snapshot().childTotal, 30, "the final fold read the write after the last tick");
	assert.equal(meter.snapshot().unresolved, 1, "a call in flight at the STOP stays unresolved");
	assert.equal(torn.unmetered, 0);
	assert.equal(meter.state.stopReason, null, "the teardown STOP brakes the children, not the job's outcome");
	assert.equal(existsSync(dir), false);
	// A stop after teardown writes nothing, so the directory is not made again.
	made.hook.stopped(TOKEN_BUDGET);
	made.hook.sample();
	assert.equal(existsSync(dir), false);
});

test("stopped() writes STOP the moment the meter stops (run-job calls it from onStop) (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const { dir, hook } = watch({ meter });
	hook.stopped(MODEL_NOT_ALLOWED);
	assert.deepEqual(stopOf(dir), { v: 1, reason: MODEL_NOT_ALLOWED });
	assert.deepEqual(readdirSync(dir), ["STOP"], "no temporary file left behind");
});

test("isPiProcess: argv[0] `pi` or `pi-rpc`, or an element that realpaths to a pi entry or run-job.mjs (issue #500)", () => {
	const targets = new Set(["/app/node_modules/pi/dist/bundle/cli.js", "/app/node_modules/pi/dist/rpc-entry.js", "/app/image/runner/run-job.mjs"]);
	const links = new Map([["/app/node_modules/.bin/cli.js", "/app/node_modules/pi/dist/bundle/cli.js"], ["/elsewhere/cli.js", "/elsewhere/cli.js"]]);
	const resolve = (path) => (targets.has(path) ? path : links.get(path) ?? null);
	const basenames = new Set(["cli.js", "cli-runtime.js", "rpc-entry.js", "run-job.mjs"]);
	const is = (argv) => isPiProcess(argv, { basenames, targets, resolve });
	assert.equal(is(["pi"]), true, "setupCli's title");
	assert.equal(is(["pi-rpc"]), true, "the rpc entries' title");
	assert.equal(is(["node", "--no-warnings", "/app/node_modules/pi/dist/rpc-entry.js"]), true, "any element, not only argv[1]");
	assert.equal(is(["/opt/pi-dispatch/runner-node", "/app/image/runner/run-job.mjs", "-p", "x"]), true, "a runner a spawner started with its marker cleared");
	assert.equal(is(["node", "/app/node_modules/.bin/cli.js"]), true, "by realpath");
	assert.equal(is(["node", "/elsewhere/cli.js"]), false, "another file of the same name");
	assert.equal(is(["node", "script.mjs", "pi"]), false, "`pi` counts only as argv[0]");
	assert.equal(is(["pip"]), false);
	assert.equal(is([]), false);
});

test("linuxProc: null off Linux; on Linux it skips itself and pid 1, splits the command line on NUL, resolves a relative element in the process's cwd, and a zombie is dead (issue #500)", () => {
	assert.equal(linuxProc({ platform: "darwin" }), null);
	const files = {
		"/proc/1/cmdline": "pi\0",
		"/proc/10/cmdline": "pi\0\0\0\0\0\0",
		"/proc/11/cmdline": "node\0dist/cli.js\0-p\0x\0",
		"/proc/12/cmdline": "node\0/tmp/other.js\0",
		"/proc/13/cmdline": "pi-rpc\0",
		"/proc/20/stat": "20 (pi) S 1 2 3",
		"/proc/21/stat": "21 (a) b) Z 1 2 3",
	};
	const fs = {
		readdirSync: () => ["1", "10", "11", "12", "13", "self", "net"],
		readFileSync: (path) => {
			if (Object.hasOwn(files, path)) return files[path];
			throw Object.assign(new Error("gone"), { code: "ENOENT" });
		},
		realpathSync: (path) => {
			if (path === "/proc/11/cwd/dist/cli.js") return "/pkg/dist/cli.js";
			if (path === "/pkg/dist/cli.js" || path === "/runner/run-job.mjs") return path;
			throw Object.assign(new Error("no"), { code: "ENOENT" });
		},
	};
	const proc = linuxProc({ self: 13, platform: "linux", packageDir: () => "/pkg", runJob: "/runner/run-job.mjs", fs });
	assert.deepEqual(proc.scan(), [10, 11], "pid 1 and itself (13) are skipped; 12 is not pi");
	assert.equal(proc.alive(20), true);
	assert.equal(proc.alive(21), false, "a zombie has exited");
	assert.equal(proc.alive(22), false);
});
