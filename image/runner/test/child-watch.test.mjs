import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CMDLINE_BYTES, createChildWatch, ENVIRON_BYTES, isPiProcess, linuxProc, NO_LEDGER_TICKS, PF_FORKNOEXEC, PRELOAD_FLAG, STARTING_CPU_MS, STARTING_FINAL_MS, STARTING_WALL_MS } from "../src/child-watch.mjs";
import { COST_CAP, MODEL_NOT_ALLOWED, TOKEN_BUDGET } from "../src/outcome.mjs";
import { childLedger, CHILD_LEDGER_MAX_FILES, createCostGuard, createPolicyGuard, createUsageMeter, foldChildLedgers, writeFileAtomic } from "../src/usage-meter.mjs";
import { dollarSettlement } from "../../../worker/src/dollar-budget.mjs";
import { parseExitTokens } from "../../../worker/src/run-history.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #500 part E: the parent's children hook (child-watch.mjs; DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY). A real
 * ledger directory and real files, written the way a child writes them; the process table is injected (`proc`), so the
 * detector's rules run on any platform. child-watch.integration.test.mjs runs real pi children against the hook.
 */

/** A ledger row with the ten numerics, zero unless given. */
const row = (provider, model, fields = {}) => ({ provider, model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 0, cost: 0, unpriced: 0, ...fields });

/** A well-formed ledger: `calls` settled calls of `each` tokens on one pair, plus `unresolved` calls in flight. */
function ledger({ state = "running", metered = true, calls = 1, each = 100, provider = "fake", model = "m1", unresolved = 0, spentMicros = 0, inflightMicros = 0, costRefused = 0, modelRefused = 0, cost = 0.001, floor = {} } = {}) {
	const rows = calls === 0 ? [] : [row(provider, model, { calls, input: calls * each, total: calls * each, cost: calls * cost })];
	return {
		v: 2,
		state,
		metered,
		totals: { input: calls * each, output: 0, total: calls * each, cost: calls * cost, calls: calls + unresolved, unresolved, unpriced: 0, sessions: calls === 0 ? 0 : 1 },
		rows,
		spentMicros,
		inflightMicros,
		costRefused,
		modelRefused,
		boundExceeded: 0,
		costUnanswered: 0,
		longContext: 0,
		costUnjudged: 0,
		...floor,
	};
}

/** Write a child's ledger as a child does: whole, by rename. */
function writeLedger(dir, pid, body, nonce = "0123456789abcdef") {
	const name = `${pid}.${nonce}.json`;
	writeFileAtomic({ dir, name, text: JSON.stringify(body) });
	return name;
}

/**
 * A process table: `live` the pi pids scan() finds, `alive` the pids that exist (live ones included), `cpu` a pid's CPU
 * time in ms (0 unless set), `environ` a pid's start environment as linuxProc gives it (null, unreadable, unless set).
 */
function fakeProc({ live = [], alive = [], cpu = {}, environ = {} } = {}) {
	const table = { live: [...live], alive: new Set([...live, ...alive]), cpu: { ...cpu }, environ: { ...environ } };
	return {
		table,
		scan: () => [...table.live],
		alive: (pid) => table.alive.has(pid),
		cpuMs: (pid) => table.cpu[pid] ?? 0,
		environ: (pid) => (Object.hasOwn(table.environ, pid) ? table.environ[pid] : null),
	};
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
	assert.deepEqual(stopOf(dir), { v: 1, reason: TOKEN_BUDGET }, "the directory and its STOP stay: the container ends right after");
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

test("under a model list: a named child row off the PARENT's list, or a child's modelRefused, is model-not-allowed; a model-less row is the child guard's to judge (issue #500)", () => {
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
	// A model-less row: an allowed model whose id the row rule refuses (a long ARN) lands there, so it is not judged by
	// the parent. The child's own guard judged the call against the list it inherited.
	const meter = createUsageMeter({ maxTokens: null, allowedModels: listed, rootSessionId: "root" });
	const { dir, hook } = watch({ meter });
	const modelless = ledger({ calls: 0 });
	modelless.totals = { ...modelless.totals, input: 10, total: 10, calls: 1 };
	modelless.rows = [row(null, null, { calls: 1, input: 10, total: 10 })];
	writeLedger(dir, 5, modelless);
	hook.sample();
	assert.equal(meter.state.stopReason, null);
});

test("a child's modelRefused with no list on the parent stops nothing: that list was the spawner's, for that child (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const { dir, hook } = watch({ meter });
	writeLedger(dir, 5, ledger({ calls: 0, modelRefused: 2 }));
	hook.sample();
	assert.equal(meter.state.stopReason, null);
});

test("the cost stop is judged on SETTLED spend: in-flight bounds past the cap do not stop the job (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: null, maxCostMicros: 1_000_000, rootSessionId: "root" });
	const { dir, hook } = watch({ meter, guard: () => ({ spend: () => ({ spentMicros: 900_000, inflightMicros: 50_000 }) }) });
	writeLedger(dir, 9, ledger({ calls: 0, spentMicros: 90_000, inflightMicros: 200_000 }));
	hook.sample();
	assert.equal(meter.state.stopReason, null, "990,000 settled is under 1,000,000, whatever is in flight");
	assert.equal(hook.external(), 290_000, "but the parent's guard sees the children's in-flight bounds");
});

test("a child with no cost guard (its spawner dropped PI_MAX_COST_MICROS) is charged its metered cost: the stop, external() and SPENT (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: null, maxCostMicros: 1_000_000, rootSessionId: "root" });
	const { dir, hook } = watch({ meter, guard: () => ({ spend: () => ({ spentMicros: 0, inflightMicros: 0 }) }) });
	// Five calls at $0.3 each, spentMicros 0: $1.5 against a $1 cap.
	const name = writeLedger(dir, 9, ledger({ calls: 5, cost: 0.3, spentMicros: 0 }));
	hook.sample();
	assert.equal(meter.state.stopReason, COST_CAP);
	assert.equal(hook.external(), 1_500_000);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "SPENT"), "utf8")), { v: 1, total: 1_500_000, byLedger: { [name]: 1_500_000 } });
});

test("SPENT is written only under a dollar cap (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
	const { dir, hook } = watch({ meter });
	writeLedger(dir, 9, ledger({ spentMicros: 5 }));
	hook.sample();
	assert.equal(existsSync(join(dir, "SPENT")), false);
});

test("the worker keeps the child keys: a runner's exit line round-trips byte-identically, and an unmetered child floors the settlement (issue #500 part F)", () => {
	const cap = 1_000_000;
	const meter = createUsageMeter({ maxTokens: null, maxCostMicros: cap, rootSessionId: "root" });
	const guard = createPolicyGuard({ maxCostMicros: cap, allowedModels: [{ provider: "fake", model: "m1" }], env: {} });
	const { dir, hook } = watch({ meter, guard: () => guard });
	meter.record(usage(120), { sessionId: "root", provider: "fake", modelId: "m1" });
	writeLedger(dir, 31, ledger({ state: "done", calls: 2, each: 300 }));
	hook.sample();
	const line = () => ({ ...meter.snapshot(), ...hook.guardFields(guard.snapshot()) });
	const tokens = line();
	assert.deepEqual([tokens.childTotal, tokens.childProcesses, tokens.unmeteredChildren], [600, 1, 0]);
	const kept = parseExitTokens(JSON.stringify({ event: "exit", tokens }));
	assert.equal(JSON.stringify(kept), JSON.stringify(tokens), "every key the runner writes is on the worker's closed list, in its order");
	assert.equal(kept.rootTotal + kept.otherTotal + kept.looseTotal + kept.childTotal, kept.total);
	const settle = (fields) => dollarSettlement({ tokens: fields, usage: meter.usageSnapshot(), reservedMicros: cap, trusted: true });
	assert.equal(settle(kept).basis, "metered", "metered children are part of the metered cost");
	// A pi child that reports through no ledger: counted, and the record that the worker keeps says so.
	writeLedger(dir, 32, ledger({ metered: false, calls: 0 }));
	hook.sample();
	const floored = parseExitTokens(JSON.stringify({ event: "exit", tokens: line() }));
	assert.equal(floored.unmeteredChildren, 1);
	assert.equal(settle(floored).basis, "floor");
});

test("a child's floor counters reach the exit line: a child call that never started floors the job exactly as a parent call would (issue #500)", async () => {
	const cap = 1_000_000;
	const failed = { role: "assistant", stopReason: "error", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } };
	const noUsage = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] };
	/** One call through a meter and a cost guard, answered with `message`. */
	async function call(meter, guard, message) {
		const stream = { result: () => Promise.resolve(message) };
		assert.equal(guard.admit({ method: "streamSimple", model: { provider: "fake", id: "m1" }, args: [{}, {}] }), null);
		guard.bind(stream);
		meter.observe(stream, { sessionId: "s", provider: "fake", modelId: "m1" });
		await new Promise((resolve) => setImmediate(resolve));
	}
	const settle = (meter, guard, extra = (fields) => fields) => dollarSettlement({ tokens: { ...meter.snapshot(), ...extra(guard.snapshot()) }, usage: meter.usageSnapshot(), reservedMicros: cap, trusted: true });
	for (const [label, message] of [["a call that never started", failed], ["an answer with no usage", noUsage]]) {
		// The parent makes the call itself.
		const parent = createUsageMeter({ maxTokens: null, maxCostMicros: cap, rootSessionId: "root" });
		const direct = createCostGuard({ capMicros: cap, bound: () => 1000 });
		// With its children hook, as in a job: the child keys are on the line at zero, so only the call floors it.
		watch({ meter: parent, guard: () => direct });
		await call(parent, direct, message);
		const own = settle(parent, direct);
		// A child makes it, and the parent folds its ledger.
		const childMeter = createUsageMeter({ maxTokens: null, rootSessionId: "child" });
		const childGuard = createCostGuard({ capMicros: cap, bound: () => 1000 });
		await call(childMeter, childGuard, message);
		const folding = createUsageMeter({ maxTokens: null, maxCostMicros: cap, rootSessionId: "root" });
		const parentOnly = createPolicyGuard({ maxCostMicros: cap, env: {} });
		const { dir, hook } = watch({ meter: folding, guard: () => parentOnly });
		writeLedger(dir, 12, childLedger({ state: "done", meter: childMeter, guard: childGuard }));
		hook.sample();
		const viaChild = settle(folding, parentOnly, (fields) => hook.guardFields(fields));
		assert.equal(own.basis, "floor", `${label}: the parent's own call floors`);
		assert.equal(viaChild.basis, "floor", `${label}: so does the child's`);
	}
	// And a clean child call settles metered: the counters are added, not invented.
	const childMeter = createUsageMeter({ maxTokens: null, rootSessionId: "child" });
	const childGuard = createCostGuard({ capMicros: cap, bound: () => 1000 });
	await call(childMeter, childGuard, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 500, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 510, cost: { total: 0.0005 } } });
	const folding = createUsageMeter({ maxTokens: null, maxCostMicros: cap, rootSessionId: "root" });
	const parentOnly = createPolicyGuard({ maxCostMicros: cap, env: {} });
	const { dir, hook } = watch({ meter: folding, guard: () => parentOnly });
	writeLedger(dir, 12, childLedger({ state: "done", meter: childMeter, guard: childGuard }));
	hook.sample();
	assert.equal(settle(folding, parentOnly, (fields) => hook.guardFields(fields)).basis, "metered");
	const fields = hook.guardFields(parentOnly.snapshot());
	assert.deepEqual([fields.costUnanswered, fields.boundExceeded, fields.costRefused], [0, 0, 0]);
	assert.deepEqual(hook.guardFields({ modelRefused: 1 }), { modelRefused: 1 }, "only the keys the parent's guard writes");
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

test("the unmetered stop carries its cause, so run-job's handler does not log token_budget_exceeded for it (issue #500)", () => {
	const stops = [];
	const meter = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root", onStop: (reason, detail) => stops.push([reason, detail]) });
	const { hook } = watch({ meter, proc: fakeProc({ live: [44] }) });
	for (let tick = 0; tick <= NO_LEDGER_TICKS; tick += 1) hook.sample();
	assert.deepEqual(stops, [[TOKEN_BUDGET, { cause: "unmetered-child", unmetered: 1 }]]);
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

test("a pi process first seen in the teardown pass with no ledger is not counted; one a tick before is (issue #500 part F)", () => {
	// An honest child caught at teardown in its first milliseconds, before its preload wrote the stub, looks the same.
	const fresh = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
	const late = fakeProc({ live: [] });
	const first = watch({ meter: fresh, proc: late });
	first.hook.sample();
	late.table.live = [58];
	late.table.alive.add(58);
	assert.deepEqual(first.hook.teardown(), { distinct: 1, peak: 1, unmetered: 0 });
	assert.equal(fresh.state.stopReason, null, "the job's exit is its own");
	// Seen by the last tick before teardown, still with no ledger: counted, and the capped job stops.
	const seenOnce = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
	const second = watch({ meter: seenOnce, proc: fakeProc({ live: [59] }) });
	second.hook.sample();
	assert.equal(second.hook.teardown().unmetered, 1);
	assert.equal(seenOnce.state.stopReason, TOKEN_BUDGET);
});

test("a pi process seen alive whose ledger never appeared counts at teardown, even when it lived less than two ticks (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const proc = fakeProc({ live: [50] });
	const { hook } = watch({ meter, proc });
	hook.sample();
	proc.table.live = [];
	proc.table.alive.delete(50);
	hook.sample();
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 0, "gone before its two ticks");
	assert.deepEqual(hook.teardown(), { distinct: 1, peak: 1, unmetered: 1 });
	assert.equal(meter.snapshot().unmeteredChildren, 1);
});

test("a pi process that stops looking like one (its title changed after the fact) is still judged at two ticks while it lives (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
	const proc = fakeProc({ live: [51] });
	const { hook } = watch({ meter, proc });
	hook.sample();
	proc.table.live = [];
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 0);
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 1, "no longer in the scan, still alive, no ledger");
	assert.equal(meter.state.stopReason, TOKEN_BUDGET);
});

/** A start environment as linuxProc reads it: the job's ledger entry and the preload in NODE_OPTIONS unless left out. */
const envOf = (dir, { ledger: withLedger = true, preload = true, extra = [], complete = true } = {}) => ({
	entries: [...extra, "HOME=/home/pi", ...(withLedger ? [`PI_DISPATCH_CHILD_LEDGER=${dir}`] : []), `NODE_OPTIONS=--no-warnings${preload ? ` ${PRELOAD_FLAG}` : ""}`, ""],
	complete,
});

test("a pi process whose environment lacks this job's ledger directory OR the preload is unmetered, whatever ledger names its pid; an unreadable environment keeps the ledger rule (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
	const proc = fakeProc({ live: [60, 61, 62, 63] });
	const { dir, hook, logged } = watch({ meter, proc });
	proc.table.environ = {
		// Its spawner scrubbed everything and forged a `done` ledger for it.
		60: envOf(dir, { ledger: false, preload: false }),
		// A nested runner on the non-dumpable runner-node: its environment cannot be read.
		61: null,
		// Its spawner kept the ledger variable and dropped NODE_OPTIONS: no preload, so no meter, and a forged ledger.
		62: envOf(dir, { preload: false }),
		// An honest child.
		63: envOf(dir),
	};
	writeLedger(dir, 60, ledger({ state: "done", calls: 0 }), "aaaaaaaaaaaaaaaa");
	writeLedger(dir, 61, ledger(), "bbbbbbbbbbbbbbbb");
	writeLedger(dir, 62, ledger({ state: "done", calls: 0 }), "cccccccccccccccc");
	writeLedger(dir, 63, ledger(), "dddddddddddddddd");
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 2, "pids 60 and 62");
	assert.equal(meter.snapshot().childProcesses, 4, "no process counted twice");
	assert.deepEqual(logged.find((line) => line.event === "unmetered_child").fields, { why: "environ", pid: 60, unmetered: 2 });
	assert.equal(meter.state.stopReason, TOKEN_BUDGET);
});

test("an environment read that filled ENVIRON_BYTES without both entries is unknown, not unmetered; the exact entries are matched; it is read once (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
	const proc = fakeProc({ live: [70, 71, 72] });
	let reads = 0;
	const environ = proc.environ;
	proc.environ = (pid) => {
		reads += 1;
		return environ(pid);
	};
	const { dir, hook } = watch({ meter, proc });
	proc.table.environ = {
		// A 70 KB variable in front of ours: the read stopped before them.
		70: { entries: [`BIG=${"x".repeat(ENVIRON_BYTES - 10)}`], complete: false },
		// A prefix of the directory is not the directory; another preload is not ours.
		71: envOf(`${dir}-other`),
		72: { entries: [`PI_DISPATCH_CHILD_LEDGER=${dir}`, `NODE_OPTIONS=--import=${PRELOAD_FLAG.slice("--import=".length)}x`, ""], complete: true },
	};
	for (const pid of [70, 71, 72]) writeLedger(dir, pid, ledger(), `${pid}`.padStart(16, "0"));
	hook.sample();
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 2, "pids 71 and 72; pid 70 keeps the ledger rule, and has one");
	assert.equal(reads, 3, "once per process");
});

test("a live `starting` ledger is stuck past 3 s of its CPU or 60 s since first sight; un-counted once it runs (issue #500)", () => {
	let clock = 0;
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const proc = fakeProc({ live: [61, 62, 64], cpu: { 61: 0, 62: 0, 64: 0 } });
	const { dir, hook } = watch({ meter, proc, now: () => clock });
	writeLedger(dir, 61, ledger({ state: "starting", calls: 0 }), "bbbbbbbbbbbbbbbb");
	writeLedger(dir, 62, ledger({ state: "starting", calls: 0 }), "dddddddddddddddd");
	writeLedger(dir, 64, ledger({ state: "starting", calls: 0 }), "eeeeeeeeeeeeeeee");
	hook.sample();
	proc.table.cpu[61] = STARTING_CPU_MS;
	proc.table.cpu[62] = STARTING_CPU_MS + 1;
	clock = STARTING_WALL_MS;
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 1, "pid 62 used more than 3 s of CPU without installing; pid 61 exactly 3 s, and 60 s exactly");
	clock = STARTING_WALL_MS + 1;
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 3, "past 60 s, CPU or not");
	writeLedger(dir, 62, ledger({ state: "running", calls: 0 }), "dddddddddddddddd");
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 2, "pid 62 installed after all: judged by its file from here on");
});

test("a dead process's `starting` ledger is done only when it was seen under 60 s, used under 3 s of CPU and holds no spend; judged once (issue #500)", () => {
	let clock = 0;
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const proc = fakeProc({ live: [80, 81, 82], cpu: { 80: 300, 81: 900, 82: 300 } });
	const { dir, hook } = watch({ meter, proc, now: () => clock });
	writeLedger(dir, 80, ledger({ state: "starting", calls: 0 }), "a".repeat(16));
	writeLedger(dir, 81, ledger({ state: "starting", calls: 0 }), "b".repeat(16));
	writeLedger(dir, 82, ledger({ state: "starting", calls: 0 }), "c".repeat(16));
	// Never seen alive: died before the first tick with spend in its stub (not one the preload wrote).
	writeLedger(dir, 83, ledger({ state: "starting", calls: 1 }), "d".repeat(16));
	hook.sample();
	// pid 80 dies at once; pid 81 at 59 s; pid 82 lives on past 60 s of wall... then dies (already stuck).
	proc.table.alive.delete(80);
	proc.table.live = [81, 82];
	clock = 59_000;
	hook.sample();
	proc.table.alive.delete(81);
	proc.table.live = [82];
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 1, "only pid 83: 80 and 81 ended before their meter, quietly");
	clock = 61_000;
	hook.sample();
	proc.table.alive.delete(82);
	proc.table.live = [];
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 2, "pid 82 outlived the wall grace");
	// The pid comes back as something else, CPU-heavy: its stub was settled and retired, never judged again.
	proc.table.alive.add(80);
	proc.table.cpu[80] = 60_000;
	hook.sample();
	assert.equal(hook.teardown().unmetered, 2);
});

test("a meterless child whose ledger stays `starting` while it makes calls is caught, live, at teardown, or past the CPU grace (issue #500)", () => {
	// The lab shape: 31 calls in about 37 s at 720 ms of CPU, its stub never leaving `starting`, alive at teardown.
	let clock = 0;
	const meter = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
	const proc = fakeProc({ live: [91], cpu: { 91: 250 } });
	const { dir, hook, logged } = watch({ meter, proc, now: () => clock });
	writeLedger(dir, 91, ledger({ state: "starting", calls: 0 }));
	for (let second = 0; second < 37; second += 1) {
		clock = second * 1000;
		proc.table.cpu[91] = 250 + second * 12;
		hook.sample();
	}
	assert.equal(meter.snapshot().unmeteredChildren, 0, "under both graces while it runs");
	assert.equal(hook.teardown().unmetered, 1, "a live `starting` ledger first seen 36 s before teardown is unmetered at teardown");
	assert.equal(meter.state.stopReason, TOKEN_BUDGET);
	assert.equal(logged.filter((line) => line.event === "unmetered_child").length, 1);
	// The unit shape of the same review, past the CPU grace (4 s of CPU and climbing): caught live, at the first tick.
	const heavy = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
	const busy = fakeProc({ live: [92], cpu: { 92: 4000 } });
	const second = watch({ meter: heavy, proc: busy });
	writeLedger(second.dir, 92, ledger({ state: "starting", calls: 0 }));
	second.hook.sample();
	assert.equal(heavy.snapshot().unmeteredChildren, 1);
	// An honest child that starts in the job's last tick is not: it was first seen less than 10 s before teardown.
	const late = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
	const third = watch({ meter: late, proc: fakeProc({ live: [93], cpu: { 93: 100 } }) });
	third.hook.sample();
	writeLedger(third.dir, 93, ledger({ state: "starting", calls: 0 }));
	assert.equal(third.hook.teardown().unmetered, 0);
});

test("at teardown a live `starting` ledger counts only when first seen 10 s or more before: an honest job ending while children start exits clean (issue #500)", () => {
	assert.equal(STARTING_FINAL_MS, 10_000, "the M5 grace (OQ-011)");
	/** A job whose child's stub stays `starting` from first sight until teardown `seenFor` ms later, one tick a second. */
	function endAfter(seenFor) {
		let clock = 0;
		const meter = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
		const proc = fakeProc({ live: [95], cpu: { 95: 200 } });
		const { dir, hook } = watch({ meter, proc, now: () => clock });
		writeLedger(dir, 95, ledger({ state: "starting", calls: 0 }));
		for (; clock < seenFor; clock += 1000) hook.sample();
		clock = seenFor;
		return { torn: hook.teardown(), meter };
	}
	// Ten ticks, 9.999 s: an honest child under load can take that long to install its meter.
	const fresh = endAfter(9_999);
	assert.equal(fresh.torn.unmetered, 0, "seen for ten ticks but under 10 s");
	assert.equal(fresh.meter.state.stopReason, null, "the job's exit is its own");
	const stale = endAfter(10_000);
	assert.equal(stale.torn.unmetered, 1, "10 s exactly");
	assert.equal(stale.meter.state.stopReason, TOKEN_BUDGET);
});

test("the `starting` CPU grace is 3 s: an honest child slow to install under load is not stuck, a busier one is (issue #500)", () => {
	assert.equal(STARTING_CPU_MS, 3_000);
	const meter = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
	// An honest child reached 0.67 s under load on arm64; 2 s is past the old 1 s grace and well inside this one.
	const proc = fakeProc({ live: [96, 97], cpu: { 96: 2_000, 97: 3_001 } });
	const { dir, hook } = watch({ meter, proc });
	writeLedger(dir, 96, ledger({ state: "starting", calls: 0 }), "6".repeat(16));
	writeLedger(dir, 97, ledger({ state: "starting", calls: 0 }), "7".repeat(16));
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 1, "pid 97 only");
	// Dead, judged once at retirement by the same grace.
	proc.table.live = [];
	proc.table.alive.delete(96);
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 1, "pid 96 ended before its meter at 2 s of CPU: done, quietly");
});

test("off Linux (a proc with no cpuMs), the `starting` grace is 60 s of wall time on a monotonic clock (issue #500)", () => {
	let clock = 0;
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const { cpuMs, ...proc } = fakeProc({ live: [61] });
	assert.equal(typeof cpuMs, "function");
	const { dir, hook } = watch({ meter, proc, now: () => clock });
	writeLedger(dir, 61, ledger({ state: "starting", calls: 0 }));
	hook.sample();
	clock = STARTING_WALL_MS;
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 0);
	clock = STARTING_WALL_MS + 1;
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 1);
});

test("520 SIGKILLed children's ledgers (`running` with a call in flight, or `starting`) do not flood: a dead pid's file is retired as it stands (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const proc = fakeProc();
	const { dir, hook } = watch({ meter, proc });
	for (let child = 0; child < 520; child += 1) {
		const body = child % 2 === 0 ? ledger({ calls: 1, unresolved: 1 }) : ledger({ state: "starting", calls: 0 });
		writeLedger(dir, 20_000 + child, body, child.toString(16).padStart(16, "0"));
		if (child % 10 === 9) hook.sample();
	}
	hook.sample();
	writeLedger(dir, 30_000, ledger({ calls: 1 }));
	proc.table.alive.add(30_000);
	hook.sample();
	const snap = meter.snapshot();
	assert.deepEqual([snap.unmeteredChildren, snap.childProcesses, snap.unresolved], [0, 521, 260], "no flood; every killed call still unresolved");
	assert.equal(snap.childTotal, 261 * 100);
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

test("520 short pi children over a job's life (`pi --version`, `pi list`) do not flood: a dead child's `done` ledger is retired (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
	const proc = fakeProc();
	const { dir, hook, logged } = watch({ meter, proc });
	for (let child = 0; child < 520; child += 1) {
		const pid = 1000 + child;
		// One child at a time, as a loop runs them: alive while it runs, its ledger `done`, then gone.
		writeLedger(dir, pid, childLedger({ state: "done" }), child.toString(16).padStart(16, "0"));
		if (child % 10 === 9) hook.sample();
	}
	hook.sample();
	assert.equal(meter.state.stopReason, null);
	assert.deepEqual([meter.snapshot().childProcesses, meter.snapshot().unmeteredChildren], [520, 0]);
	assert.equal(logged.filter((line) => line.event === "unmetered_child").length, 0);
	// A retired file is never read again, so rewriting it changes nothing; its name does not count again.
	writeLedger(dir, 1000, ledger({ calls: 3 }), "0".repeat(16));
	hook.sample();
	assert.deepEqual([meter.snapshot().childProcesses, meter.snapshot().childTotal], [520, 0]);
});

test("with no retirement (no detector, off Linux) `done` files still do not count against the open-file cap (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
	const { dir, hook } = watch({ meter });
	for (let child = 0; child < CHILD_LEDGER_MAX_FILES + 8; child += 1) writeLedger(dir, 7000 + child, childLedger({ state: "done" }), child.toString(16).padStart(16, "0"));
	writeLedger(dir, 9999, ledger({ calls: 1 }));
	hook.sample();
	assert.deepEqual([meter.snapshot().unmeteredChildren, meter.snapshot().childProcesses, meter.snapshot().childTotal], [0, CHILD_LEDGER_MAX_FILES + 9, 100]);
	assert.equal(meter.state.stopReason, null);
});

test("the open-file cap still floods: more than CHILD_LEDGER_MAX_FILES live ledgers at once are unmetered (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const proc = fakeProc({ alive: Array.from({ length: CHILD_LEDGER_MAX_FILES + 3 }, (_, index) => 5000 + index) });
	const { dir, hook } = watch({ meter, proc });
	for (let child = 0; child < CHILD_LEDGER_MAX_FILES + 3; child += 1) writeLedger(dir, 5000 + child, ledger({ calls: 0 }), child.toString(16).padStart(16, "0"));
	hook.sample();
	assert.equal(meter.snapshot().unmeteredChildren, 3);
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

test("a ledger path the agent replaced with a file is not made over; it is counted lost (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const made = [];
	const { dir, hook } = watch({ meter, mkdir: (path) => made.push(path) });
	rmSync(dir, { recursive: true });
	writeFileSync(dir, "not a directory");
	hook.sample();
	assert.deepEqual(made, [], "nothing is made over what stands there");
	assert.equal(meter.snapshot().unmeteredChildren, 1);
	rmSync(dir);
});

test("teardown writes STOP FIRST, then folds once more (a child's last write counts); the directory and its STOP stay (issue #500)", () => {
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
	assert.deepEqual(stopOf(dir), { v: 1, reason: TOKEN_BUDGET }, "STOP stays for any child still alive");
	// After teardown nothing more is written, and a second teardown is the first one's answer.
	rmSync(join(dir, "STOP"));
	made.hook.stopped(COST_CAP);
	made.hook.sample();
	assert.equal(existsSync(join(dir, "STOP")), false);
	assert.deepEqual(made.hook.teardown(), torn);
});

test("stopped() writes STOP the moment the meter stops (run-job calls it from onStop) (issue #500)", () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const { dir, hook } = watch({ meter });
	hook.stopped(MODEL_NOT_ALLOWED);
	assert.deepEqual(stopOf(dir), { v: 1, reason: MODEL_NOT_ALLOWED });
	assert.deepEqual(readdirSync(dir), ["STOP"], "no temporary file left behind");
});

test("isPiProcess: argv[0] `pi` or `pi-rpc`, or argv[1] (the script) realpathing to a pi entry or run-job.mjs; no other argument counts (issue #500)", () => {
	const targets = new Set(["/app/node_modules/pi/dist/bundle/cli.js", "/app/node_modules/pi/dist/rpc-entry.js", "/app/image/runner/run-job.mjs"]);
	const links = new Map([["/app/node_modules/.bin/cli.js", "/app/node_modules/pi/dist/bundle/cli.js"], ["/elsewhere/cli.js", "/elsewhere/cli.js"]]);
	const resolve = (path) => (targets.has(path) ? path : links.get(path) ?? null);
	const basenames = new Set(["cli.js", "cli-runtime.js", "rpc-entry.js", "run-job.mjs"]);
	const is = (argv) => isPiProcess(argv, { basenames, targets, resolve });
	assert.equal(is(["pi"]), true, "setupCli's title");
	assert.equal(is(["pi-rpc"]), true, "the rpc entries' title");
	assert.equal(is(["node", "/app/node_modules/pi/dist/rpc-entry.js"]), true);
	assert.equal(is(["/opt/pi-dispatch/runner-node", "/app/image/runner/run-job.mjs", "-p", "x"]), true, "a runner a spawner started with its marker cleared");
	assert.equal(is(["node", "/app/node_modules/.bin/cli.js"]), true, "by realpath");
	assert.equal(is(["node", "/elsewhere/cli.js"]), false, "another file of the same name");
	assert.equal(is(["tail", "-f", "/app/image/runner/run-job.mjs"]), false, "reading the runner is not running it");
	assert.equal(is(["less", "/app/image/runner/run-job.mjs"]), true, "argv[1] is the script position, whatever reads it (fail closed)");
	assert.equal(is(["node", "--no-warnings", "/app/node_modules/pi/dist/rpc-entry.js"]), false, "only argv[1]; such a process is matched by its title once pi sets it");
	assert.equal(is(["node", "script.mjs", "pi"]), false, "`pi` counts only as argv[0]");
	assert.equal(is(["pip"]), false);
	assert.equal(is([]), false);
});

/** A fake /proc for linuxProc: `files` maps a path to its text; reads are counted per path. */
function fakeProcFs(files, { names, realpath }) {
	const reads = new Map();
	const fds = new Map();
	let next = 3;
	return {
		reads,
		fs: {
			readdirSync: () => [...names],
			openSync: (path) => {
				if (!Object.hasOwn(files, path)) throw Object.assign(new Error("gone"), { code: "ENOENT" });
				const fd = next++;
				fds.set(fd, { data: Buffer.from(files[path], "latin1"), at: 0 });
				reads.set(path, (reads.get(path) ?? 0) + 1);
				return fd;
			},
			readSync: (fd, buffer, offset, length) => {
				const open = fds.get(fd);
				const n = open.data.copy(buffer, offset, open.at, open.at + length);
				open.at += n;
				return n;
			},
			closeSync: (fd) => fds.delete(fd),
			realpathSync: realpath,
		},
	};
}

const stat = (pid, { state = "S", flags = 0, utime = 0, stime = 0 } = {}) => `${pid} (a) b) ${state} 1 1 1 0 -1 ${flags} 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0`;

test("linuxProc: null off Linux; on Linux it skips itself, pid 1 and a fork that has not exec'd, splits on NUL, resolves a relative script in the process's cwd; zombies are dead; CPU and environment (issue #500)", () => {
	assert.equal(linuxProc({ platform: "darwin" }), null);
	const files = {
		"/proc/1/cmdline": "pi\0",
		"/proc/10/cmdline": "pi\0\0\0\0\0\0",
		"/proc/10/stat": stat(10, { utime: 150, stime: 50 }),
		"/proc/11/cmdline": "node\0dist/cli.js\0-p\0x\0",
		"/proc/11/stat": stat(11),
		"/proc/12/cmdline": "node\0/tmp/other.js\0",
		"/proc/13/cmdline": "pi-rpc\0",
		// The runner forked a tool and the child has not exec'd yet: its command line is still the runner's.
		"/proc/14/cmdline": "/opt/pi-dispatch/runner-node\0/runner/run-job.mjs\0",
		"/proc/14/stat": stat(14, { flags: 0x400100 | PF_FORKNOEXEC }),
		"/proc/15/cmdline": "/opt/pi-dispatch/runner-node\0/runner/run-job.mjs\0",
		"/proc/15/stat": stat(15, { flags: 0x400100 }),
		"/proc/21/stat": stat(21, { state: "Z" }),
		// Its command line says pi, but its stat is gone: it exited (or it is read in the wrong order). Skipped.
		"/proc/16/cmdline": "pi\0",
		"/proc/10/environ": "HOME=/home/pi\0PI_DISPATCH_CHILD_LEDGER=/tmp/pi-dispatch-meter-x\0",
		"/proc/11/environ": `BIG=${"x".repeat(ENVIRON_BYTES)}\0PI_DISPATCH_CHILD_LEDGER=/tmp/pi-dispatch-meter-x\0`,
	};
	const { fs } = fakeProcFs(files, {
		names: ["1", "10", "11", "12", "13", "14", "15", "16", "self", "net"],
		realpath: (path) => {
			if (path === "/proc/11/cwd/dist/cli.js") return "/pkg/dist/cli.js";
			if (path === "/pkg/dist/cli.js" || path === "/runner/run-job.mjs") return path;
			throw Object.assign(new Error("no"), { code: "ENOENT" });
		},
	});
	const proc = linuxProc({ self: 13, platform: "linux", packageDir: () => "/pkg", runJob: "/runner/run-job.mjs", fs });
	assert.deepEqual(proc.scan(), [10, 11, 15], "pid 1, itself (13), the unexec'd fork (14) and one with no stat (16) are skipped; 12 is not pi");
	assert.equal(proc.alive(10), true);
	assert.equal(proc.alive(21), false, "a zombie has exited");
	assert.equal(proc.alive(22), false);
	assert.equal(proc.cpuMs(10), 2000, "utime + stime, at 100 ticks a second");
	assert.deepEqual(proc.environ(10), { entries: ["HOME=/home/pi", "PI_DISPATCH_CHILD_LEDGER=/tmp/pi-dispatch-meter-x", ""], complete: true });
	assert.equal(proc.environ(11).complete, false, "a read that filled ENVIRON_BYTES may have more");
	assert.equal(proc.environ(15), null, "unreadable");
});

test("linuxProc: a command line is read only to CMDLINE_BYTES, and a scan stops at its time budget and goes on next tick (issue #500)", () => {
	// A process whose argv is `cli.js` a hundred thousand times: one bounded read, and argv[1] alone is resolved.
	const long = `sh\0${"cli.js\0".repeat(100_000)}`;
	let resolves = 0;
	const names = Array.from({ length: 10 }, (_, index) => String(100 + index));
	const files = Object.fromEntries(names.flatMap((name) => [[`/proc/${name}/cmdline`, long], [`/proc/${name}/stat`, stat(Number(name))]]));
	const { fs, reads: opened } = fakeProcFs(files, { names, realpath: (path) => {
		resolves += 1;
		throw Object.assign(new Error("no"), { code: "ENOENT" });
	} });
	let clock = 0;
	const reads = [];
	const realRead = fs.readSync;
	fs.readSync = (fd, buffer, offset, length, position) => {
		reads.push(length);
		clock += 30;
		return realRead(fd, buffer, offset, length, position);
	};
	const proc = linuxProc({ self: 1, platform: "linux", packageDir: () => "/pkg", runJob: "/runner/run-job.mjs", fs, now: () => clock, budgetMs: 100 });
	assert.deepEqual(proc.scan(), []);
	assert.ok(reads.every((length) => length <= CMDLINE_BYTES), "no read past the cap");
	const cmdlines = () => [...opened.keys()].filter((path) => path.endsWith("/cmdline")).length;
	const first = cmdlines();
	assert.ok(first < names.length, `the budget stopped the scan early (${first} processes)`);
	proc.scan();
	assert.ok(cmdlines() > first, "the next tick goes on where it stopped");
	// One realpath per process (its script), plus the six targets once: never one per argument.
	assert.equal(resolves, cmdlines() + 6, `${resolves} realpath calls`);
});
