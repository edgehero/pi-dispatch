import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync as closeSyncReal, constants as constantsReal, fstatSync as fstatSyncReal, lstatSync as lstatSyncReal, mkdirSync, openSync as openSyncReal, readdirSync, readFileSync, readSync as readSyncReal, renameSync as renameSyncReal, rmSync as rmSyncReal, statSync, symlinkSync, writeFileSync, writeSync as writeSyncReal } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	CHILD_LEDGER_ENV,
	CHILD_LEDGER_NAME,
	CHILD_METER_HANDOFF,
	childLedgerName,
	openChildLedger,
	parseChildLedger,
	pinPriceTable,
	PRICE_TABLE_ENV,
	publishPriceTable,
	readExternal,
	readPriceTable,
	readSpent,
	readStop,
	RUNNER_PID_ENV,
	spentFile,
	startChildMeter,
	stopFile,
	writeFileAtomic,
	COST_WAIT,
	makeDeferredStream,
	makeHardStopStream,
	STOP_MESSAGES,
	claimWait,
	waitClaimName,
	wrapModelRuntime,
} from "../src/usage-meter.mjs";
import * as usageMeter from "../src/usage-meter.mjs";
import { COST_CAP, MODEL_NOT_ALLOWED, TOKEN_BUDGET } from "../src/outcome.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Importing the preload runs its top level, which does nothing without PI_DISPATCH_CHILD_LEDGER in this environment.
import {
	CHILD_METER_PATH,
	entryKind,
	exitsBeforeExtensions,
	injectChildMeter,
	makeLibraryResolveHook,
	MODEL_RUNTIME_SUFFIX,
	PI_ENTRIES,
	PI_SUBCOMMANDS,
	preload,
	USAGE_METER_PATH,
	USAGE_METER_URL,
	wrapperSource,
} from "../src/child-preload.mjs";

/**
 * Issue #500 part C, the pure halves (DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY): the runner's ledger directory, the
 * control files a child reads, the child's meter start with its install injected, and the preload's decisions with
 * everything it touches injected. child-meter.integration.test.mjs runs the same code in real pi children.
 */

// ── the runner's side ─────────────────────────────────────────────────────────────────────────────────────

test("openChildLedger: a 0700 directory under the temp root, absolute, the two variables, and the preload imported once through NODE_OPTIONS", () => {
	const root = tempDir("pi-dispatch-ledger-root-");
	const env = { NODE_OPTIONS: "--max-old-space-size=512" };
	const opened = openChildLedger({ env, pid: 4242, preloadUrl: "file:///app/image/runner/src/child-preload.mjs", tmp: () => root, pidNamespace: () => null });
	assert.equal(opened.error, undefined);
	assert.ok(opened.dir.startsWith(join(root, "pi-dispatch-meter-")), opened.dir);
	assert.equal(statSync(opened.dir).mode & 0o777, 0o700);
	assert.equal(env[CHILD_LEDGER_ENV], opened.dir);
	assert.equal(env[RUNNER_PID_ENV], "4242", "no /proc: the pid alone");
	// With a pid namespace (Linux), it rides beside the pid, so a process in another namespace with this pid is nested.
	const linux = {};
	openChildLedger({ env: linux, pid: 7, preloadUrl: "file:///p.mjs", tmp: () => root, pidNamespace: () => "4026532560" });
	assert.equal(linux[RUNNER_PID_ENV], "7:4026532560");
	// --import, never --require: a hook registered from --require breaks every child that uses module.register or
	// --loader. The operator's value is kept, in front.
	assert.equal(env.NODE_OPTIONS, "--max-old-space-size=512 --import=file:///app/image/runner/src/child-preload.mjs");
	openChildLedger({ env, pid: 4242, preloadUrl: "file:///app/image/runner/src/child-preload.mjs", tmp: () => root });
	assert.equal(env.NODE_OPTIONS, "--max-old-space-size=512 --import=file:///app/image/runner/src/child-preload.mjs", "never twice");
});

test("openChildLedger: a relative TMPDIR still gives an absolute directory", () => {
	const root = tempDir("pi-dispatch-ledger-rel-");
	const relative = join(root, "sub");
	mkdirSync(relative);
	const cwd = process.cwd();
	process.chdir(root);
	try {
		const env = {};
		const opened = openChildLedger({ env, pid: 1, preloadUrl: "file:///p.mjs", tmp: () => "sub" });
		assert.equal(dirname(opened.dir), join(process.cwd(), "sub"), "absolute, so every child resolves the same directory whatever its cwd");
		assert.equal(env.PI_DISPATCH_CHILD_LEDGER, opened.dir);
	} finally {
		process.chdir(cwd);
	}
});

test("openChildLedger: a directory that cannot be made deletes the directory name, keeps this runner's pid, leaves NODE_OPTIONS alone, and names a code, never a path", () => {
	const env = { NODE_OPTIONS: "--x", PI_DISPATCH_CHILD_LEDGER: "/inherited", PI_DISPATCH_RUNNER_PID: "9" };
	const mkdtemp = () => {
		throw Object.assign(new Error("EROFS: /tmp/secret"), { code: "EROFS" });
	};
	const opened = openChildLedger({ env, pid: 1, preloadUrl: "file:///p.mjs", mkdtemp, tmp: () => "/nowhere", pidNamespace: () => null });
	assert.deepEqual(opened, { error: "EROFS" });
	// No child is pointed anywhere, not even at an inherited directory. The pid stays (issue #500 part D): a nested
	// runner below this one must still know it is nested, and then stops with exit 2 rather than run the job again.
	assert.deepEqual(env, { NODE_OPTIONS: "--x", PI_DISPATCH_RUNNER_PID: "1" });
});

// ── the control files ─────────────────────────────────────────────────────────────────────────────────────

test("STOP: missing is go, a reason is that stop, anything else is a stop (true), and a FIFO neither hangs nor passes", () => {
	const dir = tempDir("pi-dispatch-stop-");
	assert.equal(readStop({ dir }), null);
	writeFileAtomic({ dir, name: "STOP", text: JSON.stringify(stopFile(COST_CAP)) });
	assert.equal(readStop({ dir }), COST_CAP);
	writeFileAtomic({ dir, name: "STOP", text: JSON.stringify({ v: 1, reason: "nope" }) });
	assert.equal(readStop({ dir }), true);
	writeFileAtomic({ dir, name: "STOP", text: "not json" });
	assert.equal(readStop({ dir }), true);
	assert.throws(() => stopFile("nope"), /unknown meter stop/);
	const fifoDir = tempDir("pi-dispatch-stop-fifo-");
	execFileSync("mkfifo", [join(fifoDir, "STOP")]);
	assert.throws(() => readStop({ dir: fifoDir }), /unreadable STOP/, "a FIFO planted as STOP refuses (a stop), it never blocks");
});

test("SPENT: missing is 0, the job's total less this ledger's own part, malformed is Infinity", () => {
	const dir = tempDir("pi-dispatch-spent-");
	const own = "7.0123456789abcdef.json";
	assert.equal(readExternal({ dir, name: own }), 0);
	const fold = { files: new Map([[own, { high: { spentMicros: 300, inflightMicros: 20 } }], ["8.fedcba9876543210.json", { high: { spentMicros: 100, inflightMicros: 0 } }]]) };
	writeFileAtomic({ dir, name: "SPENT", text: JSON.stringify(spentFile(fold, 1000)) });
	assert.equal(readExternal({ dir, name: own }), 1100, "the parent's 1000 and the other child's 100, never its own 320");
	writeFileAtomic({ dir, name: "SPENT", text: "{" });
	assert.equal(readExternal({ dir, name: own }), Infinity);
});

test("readSpent (issue #985): the outside spend and its in-flight part from ONE read; 0 in flight from a parent that writes none", () => {
	const dir = tempDir("pi-dispatch-spent-");
	const own = "7.0123456789abcdef.json";
	assert.deepEqual(readSpent({ dir, name: own }), { external: 0, inflight: 0, gen: null, present: false, waiting: false, waitingSince: null }, "nothing written yet");
	const fold = { files: new Map([[own, { state: "running", high: { spentMicros: 300, inflightMicros: 20 } }], ["8.fedcba9876543210.json", { state: "running", high: { spentMicros: 100, inflightMicros: 40 } }]]) };
	writeFileAtomic({ dir, name: "SPENT", text: JSON.stringify(spentFile(fold, 1000, 250, 7)) });
	assert.deepEqual(readSpent({ dir, name: own }), { external: 1140, inflight: 290, gen: 7, present: true, waiting: false, waitingSince: null }, "the parent's 250 and the other child's 40 in flight, never its own 20; the file's generation; nobody waits");
	writeFileAtomic({ dir, name: "SPENT", text: JSON.stringify(spentFile(fold, 1000, 250, 7, 2, 5)) });
	assert.deepEqual(readSpent({ dir, name: own }), { external: 1140, inflight: 290, gen: 7, present: true, waiting: true, waitingSince: 5 }, "two calls wait in the job, since generation 5");
	writeFileAtomic({ dir, name: "SPENT", text: JSON.stringify({ v: 1, total: 1140, byLedger: {} }) });
	assert.deepEqual(readSpent({ dir, name: own }), { external: 1140, inflight: 0, gen: null, present: true, waiting: false, waitingSince: null }, "a parent from before issue #985's second part: no turn to take");
	for (const gen of [0, -1, 1.5, "7", null]) {
		writeFileAtomic({ dir, name: "SPENT", text: JSON.stringify({ ...spentFile(fold, 1000, 250), gen }) });
		assert.equal(readSpent({ dir, name: own }).gen, null, `a generation of ${JSON.stringify(gen)} is none`);
	}
	// With a generation, a count that is missing or not a count says someone may wait: fail toward taking the turn.
	for (const waiting of [undefined, -1, 1.5, "0", null]) {
		const { waiting: _drop, ...rest } = spentFile(fold, 1000, 250, 7);
		writeFileAtomic({ dir, name: "SPENT", text: JSON.stringify(waiting === undefined ? rest : { ...rest, waiting }) });
		assert.equal(readSpent({ dir, name: own }).waiting, true, `a waiting count of ${JSON.stringify(waiting)}`);
	}
	writeFileAtomic({ dir, name: "SPENT", text: JSON.stringify({ ...spentFile(fold, 1000, 250, 7, 1, 5), waitingSince: 9 }) });
	assert.equal(readSpent({ dir, name: own }).waitingSince, null, "a waitingSince after its own generation is none");
	writeFileAtomic({ dir, name: "SPENT", text: "{" });
	assert.deepEqual(readSpent({ dir, name: own }), { external: Infinity, inflight: 0, gen: null, present: true, waiting: true, waitingSince: null });
	const fifoDir = tempDir("pi-dispatch-spent-fifo-");
	execFileSync("mkfifo", [join(fifoDir, "SPENT")]);
	assert.throws(() => readSpent({ dir: fifoDir, name: own }), /unreadable SPENT/, "the cost guard reads the throw as Infinity");
});


test("writeFileAtomic: whole by rename, nothing left beside the file, and a ledger name is <pid>.<16 hex>.json", () => {
	const dir = tempDir("pi-dispatch-atomic-");
	writeFileAtomic({ dir, name: "a.json", text: "one" });
	writeFileAtomic({ dir, name: "a.json", text: "two" });
	assert.deepEqual(readdirSync(dir), ["a.json"]);
	assert.equal(readFileSync(join(dir, "a.json"), "utf8"), "two");
	assert.equal(statSync(join(dir, "a.json")).mode & 0o777, 0o600);
	const name = childLedgerName(31337);
	assert.match(name, CHILD_LEDGER_NAME);
	assert.ok(name.startsWith("31337."));
	assert.notEqual(childLedgerName(31337), name, "a fresh nonce per call");
});

test("writeFileAtomic: a FIFO or a symlink planted at a temporary name neither blocks the writer nor redirects it", () => {
	const dir = tempDir("pi-dispatch-atomic-planted-");
	const victim = join(tempDir("pi-dispatch-atomic-victim-"), "victim");
	writeFileSync(victim, "untouched");
	// The old scheme's predictable names, planted: they are simply never used.
	execFileSync("mkfifo", [join(dir, `STOP.${process.pid}.tmp`)]);
	symlinkSync(victim, join(dir, `SPENT.${process.pid}.tmp`));
	writeFileAtomic({ dir, name: "STOP", text: "s" });
	writeFileAtomic({ dir, name: "SPENT", text: "p" });
	assert.equal(readFileSync(join(dir, "STOP"), "utf8"), "s");
	assert.equal(readFileSync(join(dir, "SPENT"), "utf8"), "p");
	// A planted name that a writer DOES draw (a fixed random source here): created exclusively, so EEXIST, and the next
	// name is tried. Neither the FIFO (which would block an open for writing) nor the symlink is ever opened.
	const draws = [[0, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 0, 2], [0, 0, 0, 0, 0, 0, 0, 3]];
	const random = (bytes) => bytes.set(draws.shift()) ?? bytes;
	execFileSync("mkfifo", [join(dir, "L.json.0000000000000001.tmp")]);
	symlinkSync(victim, join(dir, "L.json.0000000000000002.tmp"));
	writeFileAtomic({ dir, name: "L.json", text: "ledger", random });
	assert.equal(readFileSync(join(dir, "L.json"), "utf8"), "ledger");
	assert.equal(readFileSync(victim, "utf8"), "untouched", "the symlink's target is never written");
	assert.equal(statSync(join(dir, "L.json")).isFile(), true);
	// A writer that cannot find a free name gives up with the error, and leaves nothing of its own behind.
	const always = (bytes) => bytes.fill(0);
	writeFileSync(join(dir, "M.json.0000000000000000.tmp"), "planted");
	assert.throws(() => writeFileAtomic({ dir, name: "M.json", text: "m", random: always }), (error) => error.code === "EEXIST");
	assert.equal(readdirSync(dir).includes("M.json"), false);
});

// ── the child's meter ─────────────────────────────────────────────────────────────────────────────────────

/** A fake install: records what it was given, answers `ok`, and covers exactly `covered`. */
function fakeInstall({ ok = true, covered = new Set() } = {}) {
	const calls = [];
	const install = async (options) => {
		calls.push(options);
		return ok ? { ok: true, covers: (runtime) => covered.has(runtime) } : { ok: false };
	};
	return { install, calls };
}

const FAKE_COMPAT = Object.freeze({ module: Object.freeze({ name: "compat" }), fallbackModels: null });
class ChildRuntime {}

/** Start a child meter in a fresh directory; `exits` holds the exit listeners it registered. */
async function startIn({ env = {}, install, ModelRuntime = ChildRuntime, compat = FAKE_COMPAT, state = {} } = {}) {
	const dir = tempDir("pi-dispatch-child-unit-");
	const name = "99.0123456789abcdef.json";
	const exits = [];
	const child = await startChildMeter({ ModelRuntime, compat, env, dir, name, state, install, onExit: (listener) => exits.push(listener) });
	const read = () => JSON.parse(readFileSync(join(dir, name), "utf8"));
	return { child, dir, name, exits, read, state };
}

test("the parent's pinned price table reaches a child through the ledger directory, checked by its hash (issue #587)", async () => {
	// A pi child has no runtime of the job's to pin from, and its own is the job's to poison, so it prices from the
	// parent's table: written once into the ledger directory, its sha256 in the environment the child inherits.
	const LISTED = { provider: "p", id: "m", api: "openai-completions", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, compat: { maxTokensField: "max_tokens" } };
	const table = pinPriceTable({ getAllModels: () => [LISTED] });
	const dir = tempDir("pi-dispatch-prices-");
	const env = {};
	publishPriceTable({ dir, table, env });
	assert.match(env[PRICE_TABLE_ENV], /^[0-9a-f]{64}$/);
	const read = readPriceTable({ dir, env });
	assert.deepEqual([...read.keys()], [...table.keys()]);
	assert.deepEqual(read.get([...table.keys()][0]), table.get([...table.keys()][0]));
	// Tampered, missing, or with no hash to check: an EMPTY table, so every capped call is refused, never unchecked.
	const tampered = tempDir("pi-dispatch-prices-");
	const tamperedEnv = {};
	publishPriceTable({ dir: tampered, table, env: tamperedEnv });
	const file = join(tampered, "PRICES");
	rmSyncReal(file, { force: true });
	writeFileSync(file, readFileSync(join(dir, "PRICES"), "utf8").replace('"output":2', '"output":0'));
	assert.equal(readPriceTable({ dir: tampered, env: tamperedEnv }).size, 0, "a file that does not match its hash");
	assert.equal(readPriceTable({ dir: tempDir("pi-dispatch-prices-"), env }).size, 0, "no file");
	assert.equal(readPriceTable({ dir, env: {} }).size, 0, "no hash");
	// The child meter installs with the table it read.
	const fake = fakeInstall();
	const childDir = tempDir("pi-dispatch-child-unit-");
	const childEnv = { PI_MAX_COST_MICROS: "1000000" };
	publishPriceTable({ dir: childDir, table, env: childEnv });
	await startChildMeter({ ModelRuntime: ChildRuntime, compat: FAKE_COMPAT, env: childEnv, dir: childDir, name: "98.0123456789abcdef.json", state: {}, install: fake.install, onExit: () => {} });
	assert.deepEqual([...fake.calls[0].prices.keys()], [...table.keys()]);
	const bare = fakeInstall();
	await startChildMeter({ ModelRuntime: ChildRuntime, compat: FAKE_COMPAT, env: { PI_MAX_COST_MICROS: "1000000" }, dir: tempDir("pi-dispatch-child-unit-"), name: "97.0123456789abcdef.json", state: {}, install: bare.install, onExit: () => {} });
	assert.ok(bare.calls[0].prices instanceof Map && bare.calls[0].prices.size === 0, "no table handed down: an empty one, never none");
});

test("startChildMeter: installs on the class it is given with brake, isStopped and the injected compat copy, writes running, and done at exit", async () => {
	const fake = fakeInstall();
	const { child, exits, read, dir } = await startIn({ install: fake.install });
	assert.equal(fake.calls.length, 1);
	const given = fake.calls[0];
	assert.equal(given.ModelRuntime, ChildRuntime);
	assert.equal(given.compat, FAKE_COMPAT);
	assert.equal(given.brake, true);
	assert.deepEqual([...given.guard.enforces], [], "no policy: a guard that enforces nothing, there only for the pre-dispatch write");
	assert.equal(given.meter.cap, null, "the token cap is the parent's, judged through STOP");
	assert.equal(typeof given.isStopped, "function");
	assert.equal(given.isStopped(), null);
	writeFileAtomic({ dir, name: "STOP", text: JSON.stringify(stopFile(TOKEN_BUDGET)) });
	assert.equal(given.isStopped(), TOKEN_BUDGET, "the install's isStopped reads the directory's STOP");
	assert.equal(child.ok, true);
	assert.deepEqual({ state: read().state, metered: read().metered }, { state: "running", metered: true });
	assert.ok(parseChildLedger(readFileSync(join(dir, "99.0123456789abcdef.json"), "utf8")), "a ledger the parent's parser accepts");
	// A recorded call reaches the ledger through onChange.
	given.meter.record({ input: 5, output: 5, totalTokens: 10, cost: { total: 0.001 } }, { provider: "fake", model: "m1", sessionId: "s" });
	assert.equal(read().totals.total, 10);
	assert.equal(exits.length, 1);
	exits[0]();
	assert.equal(read().state, "done");
	given.meter.record({ input: 5, output: 5, totalTokens: 10, cost: { total: 0.001 } }, { provider: "fake", model: "m1", sessionId: "s" });
	assert.equal(read().totals.total, 10, "nothing is written after done");
});

test("startChildMeter: the policies come from the inherited env, and a policy that does not parse leaves the child unmetered", async () => {
	const fake = fakeInstall();
	await startIn({ install: fake.install, env: { PI_ALLOWED_MODELS: "fake/m1", PI_MAX_COST_MICROS: "5000" } });
	const { guard, meter } = fake.calls[0];
	assert.deepEqual([...guard.enforces].sort(), [COST_CAP, MODEL_NOT_ALLOWED].sort());
	assert.equal(meter.costCap, 5000);
	assert.deepEqual(meter.allowed, [{ provider: "fake", model: "m1" }]);

	const bad = fakeInstall();
	const { read } = await startIn({ install: bad.install, env: { PI_MAX_COST_MICROS: "1e6" } });
	assert.equal(bad.calls.length, 0, "nothing installed on a policy that does not parse");
	assert.equal(read().metered, false);
});

test("startChildMeter: a failed install, no class or no compat copy is metered:false, and a session runtime the install does not cover turns the child unmetered for good", async () => {
	const failed = await startIn({ install: fakeInstall({ ok: false }).install });
	assert.equal(failed.read().metered, false);
	assert.equal(failed.child.ok, false);

	for (const missing of [{ ModelRuntime: null }, { compat: null }]) {
		const fake = fakeInstall();
		const started = await startIn({ install: fake.install, ...missing });
		assert.equal(fake.calls.length, 0);
		assert.equal(started.read().metered, false);
	}

	const own = new ChildRuntime();
	const fake = fakeInstall({ covered: new Set([own]) });
	const { child, read } = await startIn({ install: fake.install });
	assert.equal(child.verify(own), true);
	assert.equal(read().metered, true);
	assert.equal(child.verify(new ChildRuntime()), false, "a runtime of another copy is not covered");
	assert.equal(read().metered, false);
	assert.equal(child.verify(own), false, "and the child stays unmetered");
	fake.calls[0].meter.record({ input: 1, output: 1, totalTokens: 2, cost: { total: 0 } }, { provider: "fake", model: "m1" });
	assert.equal(read().metered, false);
	assert.equal(read().totals.total, 0, "an unmetered ledger carries zeros, never part of a count");
});

test("startChildMeter: one meter per process; a second class is installed with it, the same class is not installed twice", async () => {
	const fake = fakeInstall();
	const { child, state } = await startIn({ install: fake.install });
	class OtherCopy {}
	assert.equal(await startChildMeter({ ModelRuntime: ChildRuntime, compat: FAKE_COMPAT, env: {}, dir: "/unused", name: "x", state, install: fake.install }), child);
	assert.equal(fake.calls.length, 1);
	await startChildMeter({ ModelRuntime: OtherCopy, compat: FAKE_COMPAT, env: {}, dir: "/unused", name: "x", state, install: fake.install });
	assert.equal(fake.calls.length, 2);
	assert.equal(fake.calls[1].ModelRuntime, OtherCopy);
	assert.equal(fake.calls[1].meter, fake.calls[0].meter);
	assert.equal(fake.calls[1].guard, fake.calls[0].guard);
});

test("startChildMeter (library, lazy): nothing is written until the first call is about to go out, and a process that never calls leaves no file", async () => {
	const fake = fakeInstall();
	const dir = tempDir("pi-dispatch-child-lazy-");
	const name = "98.0123456789abcdef.json";
	const exits = [];
	await startChildMeter({ ModelRuntime: ChildRuntime, compat: FAKE_COMPAT, env: {}, dir, name, lazy: true, install: fake.install, onExit: (listener) => exits.push(listener) });
	assert.deepEqual(readdirSync(dir), [], "installed, nothing written");
	exits[0]();
	assert.deepEqual(readdirSync(dir), [], "and a process that exits without calling leaves nothing");

	const dir2 = tempDir("pi-dispatch-child-lazy2-");
	const fake2 = fakeInstall();
	const exits2 = [];
	await startChildMeter({ ModelRuntime: ChildRuntime, compat: FAKE_COMPAT, env: {}, dir: dir2, name, lazy: true, install: fake2.install, onExit: (listener) => exits2.push(listener) });
	// The guard is the last thing a call passes before dispatch: its admit writes the ledger, the call already counted.
	assert.equal(fake2.calls[0].isStopped(), null);
	assert.deepEqual(readdirSync(dir2), [], "a STOP check alone writes nothing");
	assert.equal(fake2.calls[0].guard.admit({ method: "streamSimple", model: { provider: "fake", id: "m1" }, args: [] }), null);
	const born = JSON.parse(readFileSync(join(dir2, name), "utf8"));
	assert.deepEqual({ state: born.state, calls: born.totals.calls, unresolved: born.totals.unresolved }, { state: "running", calls: 1, unresolved: 1 }, "born with the call in flight");
	exits2[0]();
	assert.equal(JSON.parse(readFileSync(join(dir2, name), "utf8")).state, "done");
});

test("startChildMeter: every call is on disk, in flight, before it is dispatched; a pre-dispatch write that fails refuses the call and stops the child", async () => {
	const fake = fakeInstall();
	const dir = tempDir("pi-dispatch-child-fail-");
	const name = "97.0123456789abcdef.json";
	let failing = false;
	const writeFs = { ...realWriteFs(), openSync: (...args) => {
		if (failing) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
		return realWriteFs().openSync(...args);
	} };
	await startChildMeter({ ModelRuntime: ChildRuntime, compat: FAKE_COMPAT, env: {}, dir, name, writeFs, install: fake.install, onExit: () => {} });
	const { meter, guard, isStopped } = fake.calls[0];
	const read = () => JSON.parse(readFileSync(join(dir, name), "utf8"));
	const call = { method: "streamSimple", model: { provider: "fake", id: "m1" }, args: [] };
	const usage = { input: 5, output: 5, totalTokens: 10, cost: { total: 0.001 } };
	// One call, the way judge() and the wrapper run it: admit (the pre-dispatch write), then observe, then settle.
	assert.equal(guard.admit(call), null);
	assert.deepEqual({ calls: read().totals.calls, unresolved: read().totals.unresolved }, { calls: 1, unresolved: 1 }, "on disk before it goes out");
	meter.observe({ result: () => Promise.resolve({ usage }) }, { provider: "fake", model: "m1", sessionId: "s" });
	assert.deepEqual({ calls: read().totals.calls, unresolved: read().totals.unresolved }, { calls: 1, unresolved: 1 }, "observed: the reservation is the call itself, never counted twice");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual({ calls: read().totals.calls, unresolved: read().totals.unresolved, total: read().totals.total }, { calls: 1, unresolved: 0, total: 10 }, "settled");
	assert.equal(isStopped(), null, "a healthy ledger: go");
	failing = true;
	assert.equal(guard.admit(call), TOKEN_BUDGET, "the write failed: this call is refused, so it never goes out unrecorded");
	failing = false;
	assert.equal(isStopped(), TOKEN_BUDGET, "and every later call is stopped");
	assert.equal(guard.admit(call), TOKEN_BUDGET);
	meter.record(usage, { provider: "fake", model: "m1", sessionId: "s" });
	assert.equal(read().metered, false, "the next write that succeeds says unmetered");
});

test("startChildMeter: an admitted call that is never observed stays counted, unresolved, so the ledger never shrinks", async () => {
	const fake = fakeInstall();
	const { read } = await startIn({ install: fake.install });
	const { guard, meter } = fake.calls[0];
	guard.admit({ method: "streamSimple", model: { provider: "fake", id: "m1" }, args: [] });
	assert.deepEqual({ calls: read().totals.calls, unresolved: read().totals.unresolved }, { calls: 1, unresolved: 1 });
	// The dispatch threw before the meter saw it; the next change (a stop, say) must not lower the count.
	meter.stop(TOKEN_BUDGET);
	assert.deepEqual({ calls: read().totals.calls, unresolved: read().totals.unresolved }, { calls: 1, unresolved: 1 });
	assert.ok(parseChildLedger(JSON.stringify(read())), "and the ledger stays one the parent's parser accepts");
});

test("startChildMeter: the policy guard still decides first; a refused call writes no reservation", async () => {
	const fake = fakeInstall();
	const { read } = await startIn({ install: fake.install, env: { PI_ALLOWED_MODELS: "fake/other" } });
	const { guard } = fake.calls[0];
	assert.equal(guard.admit({ method: "streamSimple", model: { provider: "fake", id: "m1" }, args: [] }), MODEL_NOT_ALLOWED);
	assert.equal(read().totals.calls, 0);
});

// ── Issue #985: a child's call waits for holds in other processes ───────────────────────────────────────────

/** Input free, 250 output tokens at $2 per million: a bound of 500 micro-dollars by the real callCostBound. */
const CHILD_MODEL = Object.freeze({ provider: "fake", id: "m1", api: "openai-completions", baseUrl: "http://127.0.0.1:1", cost: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0 }, maxTokens: 250, compat: { maxTokensField: "max_tokens" } });
const childCall = (waiter = null, model = CHILD_MODEL) => ({ method: "streamSimple", model, args: [{ messages: [] }, {}], waitable: true, waiter });
/**
 * A SPENT as the parent writes it: `total` outside, `inflight` of it in flight in other processes, its generation, and
 * how many calls wait in the job since which generation (the parent publishes a child's waiting from its ledger).
 */
const spentOf = (total, inflight, { gen = 1, waiting = 0, since = null } = {}) => JSON.stringify({ v: 1, total, byLedger: {}, inflight, inflightByLedger: {}, gen, waiting, ...(since === null ? {} : { waitingSince: since }) });
/** The ledger's reservation fields: what a call that waits must not change. */
const reservation = (ledger) => ({ calls: ledger.totals.calls, unresolved: ledger.totals.unresolved, inflightMicros: ledger.inflightMicros });
const microtask = () => new Promise((resolve) => setImmediate(resolve));

/** A fake interval for the child cost guard's drain, run by hand (`tick()`). */
function handTimer() {
	const timer = { armed: null };
	timer.set = (run) => (timer.armed = { run, unref() {}, ref() {} });
	timer.clear = (handle) => {
		if (timer.armed === handle) timer.armed = null;
	};
	timer.tick = () => timer.armed?.run();
	return timer;
}

/** A capped child (cap `cap`) in a fresh directory with a hand-run drain timer and a SPENT of `total`/`inflight`. */
async function waitingChild({ cap = 1000, total, inflight, writeFs } = {}) {
	const fake = fakeInstall();
	const timer = handTimer();
	const dir = tempDir("pi-dispatch-child-wait-");
	const name = "96.0123456789abcdef.json";
	writeFileAtomic({ dir, name: "SPENT", text: spentOf(total, inflight) });
	const child = await startChildMeter({ ModelRuntime: ChildRuntime, compat: FAKE_COMPAT, env: { PI_MAX_COST_MICROS: String(cap) }, dir, name, install: fake.install, onExit: () => {}, now: () => 0, setTimer: timer.set, clearTimer: timer.clear, ...(writeFs ? { writeFs } : {}) });
	const read = () => JSON.parse(readFileSync(join(dir, name), "utf8"));
	return { child, dir, name, read, timer, ...fake.calls[0] };
}

/**
 * A stream as pi's EventStream behaves for these tests: push() queues an event and a terminal one resolves result();
 * end() resolves result() with what it is given and ends the iteration.
 */
class ChildStream {
	constructor() {
		this.events = [];
		this.waiting = [];
		this.done = false;
		this.final = new Promise((resolve) => (this.resolve = resolve));
	}
	push(event) {
		if (this.done) return;
		if (event.type === "done" || event.type === "error") {
			this.done = true;
			this.resolve(event.type === "done" ? event.message : event.error);
		}
		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.events.push(event);
	}
	end(result) {
		this.done = true;
		if (result !== undefined) this.resolve(result);
		for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
	}
	async *[Symbol.asyncIterator]() {
		while (true) {
			if (this.events.length > 0) yield this.events.shift();
			else if (this.done) return;
			else {
				const next = await new Promise((resolve) => this.waiting.push(resolve));
				if (next.done) return;
				yield next.value;
			}
		}
	}
	result() {
		return this.final;
	}
}

/** Whether `promise` settles within a few event-loop turns. */
async function settlesSoon(promise) {
	const hung = new Promise((resolve) => setTimeout(() => resolve("hung"), 50));
	return Promise.race([Promise.resolve(promise).then(() => "settled", () => "settled"), hung]);
}

test("startChildMeter (issue #985): a call refused only by holds in other processes waits; COST_WAIT writes no reservation, its waiting is published, and the retry admitted in its turn writes its reservation before its dispatch", async () => {
	const { dir, read, guard, timer } = await waitingChild({ total: 700, inflight: 600 });
	assert.deepEqual([typeof guard.wait, typeof guard.leave, typeof guard.close, typeof guard.waiting], ["function", "function", "function", "function"], "the child's guard offers the cost guard's queue");
	const before = read();
	assert.equal(guard.admit(childCall()), COST_WAIT, "0 + 700 + 500 > 1000; 100 settled elsewhere + 500 <= 1000 once the 600 settles");
	assert.deepEqual(read(), before, "nothing written for a call that waits: it is not going out");
	const verdicts = [];
	let waiter = null;
	waiter = guard.wait(() => {
		const verdict = guard.admit(childCall(waiter));
		verdicts.push(verdict);
		// Admitted: its reservation is on disk already, before anything could be dispatched.
		if (verdict === null) verdicts.push(reservation(read()));
		if (verdict !== COST_WAIT) guard.leave(waiter);
	});
	await microtask();
	assert.deepEqual([reservation(read()), read().waiting], [reservation(before), 1], "no reservation; the wait itself is published, so every other process takes its turn");
	timer.tick();
	assert.deepEqual(verdicts, [COST_WAIT]);
	// The hold elsewhere settled at 50; the parent's next SPENT shows this child's waiting, since this generation.
	writeFileAtomic({ dir, name: "SPENT", text: spentOf(150, 0, { gen: 2, waiting: 1, since: 2 }) });
	timer.tick();
	assert.deepEqual(verdicts, [COST_WAIT, COST_WAIT], "it fits, but not in the first generation that shows the wait: a call elsewhere may have been admitted then without its turn");
	writeFileAtomic({ dir, name: "SPENT", text: spentOf(150, 0, { gen: 3, waiting: 1, since: 2 }) });
	timer.tick();
	assert.deepEqual(verdicts, [COST_WAIT, COST_WAIT, null, { calls: 1, unresolved: 1, inflightMicros: 500 }], "one reservation, written by the admission itself");
	assert.ok(readdirSync(dir).includes(waitClaimName(3)), "in generation 3's turn");
	await microtask();
	assert.equal(read().waiting, 0, "and the end of its wait published");
	assert.equal(read().waited, 1, "issue #985, part 3: the ledger counts the call that waited, for the parent's costWaited");
	assert.equal(timer.armed, null);
});

test("startChildMeter (issue #985): a child's first cost refusal reaches its ledger, its rule and its four numbers, for the parent to record", async () => {
	const { read, guard, child } = await waitingChild({ total: 900, inflight: 0 });
	assert.equal(Object.hasOwn(read(), "refusedWhy"), false, "nothing refused yet: no key");
	assert.equal(guard.admit(childCall()), COST_CAP, "0 + 0 + 900 + 500 > 1000, and the 900 elsewhere is settled: waiting cannot help");
	// The wrapper stops the child's meter on a refusal, which writes the ledger at once.
	child.meter.stop(COST_CAP);
	const ledger = read();
	assert.equal(ledger.refusedWhy, "over-cap");
	assert.deepEqual(ledger.costRefusal, { spentMicros: 0, inflightMicros: 0, externalMicros: 900, boundMicros: 500 });
	assert.equal(ledger.costRefused, 1);
});

test("startChildMeter (issue #985): the ledger shows the hold a call is sent under, written again as its onPayload returns; a write that fails then refuses the call", async () => {
	let failing = false;
	const writeFs = { ...realWriteFs(), openSync: (...args) => {
		if (failing) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
		return realWriteFs().openSync(...args);
	} };
	const { read, guard, isStopped } = await waitingChild({ cap: 100_000, total: 0, inflight: 0, writeFs });
	const prepared = () => {
		const call = childCall();
		assert.equal(guard.admit(call), null);
		const [, options] = guard.prepare({ ...call, stop: () => {}, stopped: () => null });
		guard.bind(new ChildStream());
		return options;
	};
	const first = prepared();
	assert.equal(read().inflightMicros, 500, "the pre-dispatch write: the admission's bound");
	// 1000 output tokens at $2 per million: the hold grows from 500 to 2000.
	assert.deepEqual(await first.onPayload({ model: "m1", max_tokens: 1000 }), { model: "m1", max_tokens: 1000 });
	assert.equal(read().inflightMicros, 2000, "on disk before the provider sends: the hold it is sent under");
	const second = prepared();
	failing = true;
	await assert.rejects(second.onPayload({ model: "m1", max_tokens: 1000 }), (error) => error.message === STOP_MESSAGES[TOKEN_BUDGET], "the write failed, so the hook throws and nothing is sent");
	failing = false;
	assert.equal(isStopped(), TOKEN_BUDGET, "and the child stops, as for a failed pre-dispatch write");
});

test("startChildMeter (issue #985): a parent's STOP reaches a child call waiting for room: the drain timer wakes it, it ends with the stop's hard stop, and the provider is never called", async () => {
	const { dir, read, meter, guard, isStopped, timer } = await waitingChild({ total: 700, inflight: 600 });
	const dispatched = [];
	class Runtime {
		streamSimple(model) {
			dispatched.push(model.id);
			return new ChildStream();
		}
	}
	const layer = wrapModelRuntime({ ModelRuntime: Runtime, meter, hardStop: makeHardStopStream({ createStream: () => new ChildStream() }), guard, isStopped, deferred: makeDeferredStream({ createStream: () => new ChildStream() }) });
	try {
		const before = read();
		const answer = new Runtime().streamSimple(CHILD_MODEL, { messages: [] }, {});
		timer.tick();
		assert.equal(await settlesSoon(answer.result()), "hung", "waiting: answered with a placeholder that has not ended");
		assert.deepEqual([dispatched, meter.state.stopReason, guard.snapshot().costRefused], [[], null, 0], "not dispatched, not refused, nothing stopped");
		assert.deepEqual([reservation(read()), read().waiting], [reservation(before), 1], "no reservation for it; its wait published");
		writeFileAtomic({ dir, name: "STOP", text: JSON.stringify(stopFile(COST_CAP)) });
		timer.tick();
		const final = await answer.result();
		assert.deepEqual({ stopReason: final.stopReason, errorMessage: final.errorMessage, total: final.usage.totalTokens }, { stopReason: "aborted", errorMessage: STOP_MESSAGES[COST_CAP], total: 0 });
		assert.deepEqual([dispatched, meter.state.stopReason, timer.armed], [[], COST_CAP, null], "the parent's stop is the child's, and the provider was never called");
	} finally {
		layer.restore();
	}
});

test("startChildMeter (issue #985): a parent's STOP reaches a child call waiting at its final payload, which holds the front of the queue, and it is never sent", async () => {
	const { dir, meter, guard, isStopped, timer } = await waitingChild({ total: 500, inflight: 500 });
	const sent = [];
	const failed = [];
	class Runtime {
		streamSimple(model, context, options) {
			const stream = new ChildStream();
			(async () => {
				try {
					// 350 output tokens at $2 per million: the final hold is 700, and 500 + 700 > 1000 while the parent's 500 is in flight.
					sent.push(await options.onPayload({ model: "m1", max_tokens: 350 }, model));
				} catch (error) {
					failed.push(error.message);
					const message = { role: "assistant", content: [], usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } }, stopReason: "aborted", errorMessage: error.message };
					stream.push({ type: "error", reason: "aborted", error: message });
				}
			})();
			return stream;
		}
	}
	const layer = wrapModelRuntime({ ModelRuntime: Runtime, meter, hardStop: makeHardStopStream({ createStream: () => new ChildStream() }), guard, isStopped, deferred: makeDeferredStream({ createStream: () => new ChildStream() }) });
	try {
		const answer = new Runtime().streamSimple({ ...CHILD_MODEL, maxTokens: 150 }, { messages: [] }, {}); // admitted at 300
		await settlesSoon(null);
		assert.deepEqual([sent, failed, guard.spend().inflightMicros], [[], [], 0], "waiting at the final payload, its 300 given back");
		timer.tick();
		assert.deepEqual([sent, failed], [[], []]);
		writeFileAtomic({ dir, name: "STOP", text: JSON.stringify(stopFile(COST_CAP)) });
		timer.tick();
		await settlesSoon(answer.result());
		assert.deepEqual([sent, failed, meter.state.stopReason, timer.armed], [[], [STOP_MESSAGES[COST_CAP]], COST_CAP, null], "ended by the parent's stop, never sent");
	} finally {
		layer.restore();
	}
});

test("claimWait (issue #985): one winner per generation, a planted name only loses it, and nothing invalid is ever won", () => {
	const dir = tempDir("pi-dispatch-claim-");
	assert.equal(waitClaimName(3), "CLAIM.3");
	assert.equal(CHILD_LEDGER_NAME.test(waitClaimName(3)), false, "never a ledger name: the fold does not read it");
	assert.equal(claimWait({ dir, gen: 3 }), true);
	assert.equal(claimWait({ dir, gen: 3 }), false, "taken");
	assert.equal(claimWait({ dir, gen: 4 }), true, "the next generation is a new name");
	execFileSync("mkfifo", [join(dir, waitClaimName(5))]);
	symlinkSync(join(dir, "elsewhere"), join(dir, waitClaimName(6)));
	assert.deepEqual([claimWait({ dir, gen: 5 }), claimWait({ dir, gen: 6 })], [false, false], "a FIFO or a link at the name is a lost claim, never opened");
	assert.equal(readdirSync(dir).includes("elsewhere"), false, "and the link's target is never created");
	for (const gen of [0, -1, 1.5, "7", null]) assert.equal(claimWait({ dir, gen }), false, JSON.stringify(gen));
	assert.equal(claimWait({ dir: join(dir, "gone"), gen: 1 }), false, "a directory that is gone: lost, the waiter waits on");
});

/** Children started in one ledger directory, each with its guard, meter and hand-run drain timer. */
async function childrenIn(dir, pids, { writeFsOf = () => undefined } = {}) {
	const children = [];
	for (const [pid, nonce] of pids) {
		const fake = fakeInstall();
		const timer = handTimer();
		const name = `${pid}.${nonce}.json`;
		const writeFs = writeFsOf(name);
		await startChildMeter({ ModelRuntime: ChildRuntime, compat: FAKE_COMPAT, env: { PI_MAX_COST_MICROS: "1000" }, dir, name, install: fake.install, onExit: () => {}, now: () => 0, setTimer: timer.set, clearTimer: timer.clear, ...(writeFs ? { writeFs } : {}) });
		children.push({ name, timer, guard: fake.calls[0].guard, meter: fake.calls[0].meter, verdicts: [], stream: null });
	}
	return children;
}

/** Queue a child's call the way the wrappers do: offered, told COST_WAIT, queued; bound and observed once admitted. */
function queueChildCall(child) {
	let waiter = null;
	waiter = child.guard.wait(() => {
		const verdict = child.guard.admit(childCall(waiter));
		child.verdicts.push(verdict);
		if (verdict === null) admitted(child);
		if (verdict !== COST_WAIT) child.guard.leave(waiter);
	});
}

/** An admitted child call, bound and observed as the wrapper does, so its settle reaches the ledger through the meter. */
function admitted(child) {
	child.guard.bind((child.stream = new ChildStream()));
	child.meter.observe(child.stream, { provider: "fake", model: "m1", sessionId: child.name });
}

/**
 * The parent's tick as child-watch writes SPENT: its own spend and in-flight, every child ledger folded (the real fold),
 * the generation, how many calls wait in the job (the real ledgerWaiting sum) and since which generation.
 */
function parentTicks(dir, parent) {
	const tick = { gen: 0, since: null, onOpen: null };
	// The fold's reads: `tick.onOpen(name)` runs right after a ledger is opened, so a test can land a step INSIDE the
	// tick, between the fold's read of a ledger (the file as it was) and the SPENT write.
	const foldFs = { readdirSync, lstatSync: lstatSyncReal, fstatSync: fstatSyncReal, readSync: readSyncReal, closeSync: closeSyncReal, constants: constantsReal, openSync: (path, flags) => {
		const fd = openSyncReal(path, flags);
		tick.onOpen?.(String(path).split("/").at(-1));
		return fd;
	} };
	tick.run = () => {
		tick.gen += 1;
		const fold = usageMeter.foldChildLedgers({ dir, fs: foldFs });
		tick.since = fold.liveWaiting > 0 ? (tick.since ?? tick.gen) : null;
		writeFileAtomic({ dir, name: "SPENT", text: JSON.stringify(spentFile(fold, parent.spent + parent.inflight, parent.inflight, tick.gen, fold.liveWaiting, tick.since)) });
	};
	return tick;
}

const holding = (children, parent) => parent.spent + parent.inflight + children.reduce((sum, child) => sum + child.guard.spend().spentMicros + child.guard.spend().inflightMicros, 0);
const settleChild = async (child) => {
	child.stream.push({ type: "done", reason: "stop", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 10, output: 1, totalTokens: 11, cost: { total: 0.00005 } } } });
	await microtask();
};

test("startChildMeter (issue #985): children waiting for the same room take turns, one per SPENT generation, so the room is never taken twice", async () => {
	const dir = tempDir("pi-dispatch-child-turns-");
	const children = await childrenIn(dir, [[11, "00000000000000aa"], [12, "00000000000000bb"]]);
	const parent = { spent: 0, inflight: 600 };
	const tick = parentTicks(dir, parent);
	const within = (label) => assert.ok(holding(children, parent) <= 1000, `${label}: the job holds ${holding(children, parent)} > 1000`);
	tick.run();
	for (const child of children) {
		assert.equal(child.guard.admit(childCall()), COST_WAIT, `${child.name}: 600 + 500 > 1000, 0 + 500 <= 1000 once the parent's 600 settles`);
		queueChildCall(child);
	}
	await microtask(); // both children publish their waiting
	Object.assign(parent, { spent: 100, inflight: 0 }); // the parent's call settled: room for ONE child call (100 + 500 + 500 > 1000)
	tick.run(); // the first generation that shows the waiting: no call that waited is admitted in it
	const [a, b] = children;
	a.timer.tick();
	assert.deepEqual(a.verdicts, [COST_WAIT]);
	tick.run();
	a.timer.tick();
	within("the first child took the room");
	b.timer.tick();
	within("the second child judged the same SPENT");
	assert.deepEqual([a.verdicts, b.verdicts], [[COST_WAIT, null], [COST_WAIT]], "one generation, one turn: the second waits though the room looked free to it");
	assert.deepEqual(readdirSync(dir).filter((file) => file.startsWith("CLAIM.")), [waitClaimName(tick.gen)]);
	tick.run(); // the next generation holds the first child's 500
	b.timer.tick();
	within("the next generation");
	assert.deepEqual(b.verdicts, [COST_WAIT, COST_WAIT], "100 + 500 + 500 > 1000: still no room");
	await settleChild(a);
	tick.run();
	b.timer.tick();
	within("the first child's call settled at 50");
	assert.deepEqual(b.verdicts, [COST_WAIT, COST_WAIT, null], "150 + 500 <= 1000");
});

test("startChildMeter (issue #985): while a child waits, a FRESH call in another child takes its turn too, so a waiter's turn and a fresh call never take one room in the same generation, in either order", async () => {
	for (const freshFirst of [false, true]) {
		const dir = tempDir("pi-dispatch-child-fresh-");
		const [waiting, fresh] = await childrenIn(dir, [[21, "00000000000000cc"], [22, "00000000000000dd"]]);
		const children = [waiting, fresh];
		const parent = { spent: 0, inflight: 600 };
		const tick = parentTicks(dir, parent);
		const within = (label) => assert.ok(holding(children, parent) <= 1000, `${freshFirst ? "fresh first" : "waiter first"}, ${label}: the job holds ${holding(children, parent)} > 1000`);
		tick.run();
		assert.equal(waiting.guard.admit(childCall()), COST_WAIT);
		queueChildCall(waiting);
		await microtask();
		Object.assign(parent, { spent: 100, inflight: 0 }); // room for ONE call of 500
		tick.run();
		tick.run(); // two generations that show the wait: the waiter's turn is open
		const freshCall = () => {
			const verdict = fresh.guard.admit(childCall());
			fresh.verdicts.push(verdict);
			if (verdict === null) admitted(fresh);
		};
		if (freshFirst) freshCall();
		waiting.timer.tick();
		if (!freshFirst) freshCall();
		within("one generation");
		const admittedNow = [waiting.verdicts.at(-1), fresh.verdicts.at(-1)].filter((verdict) => verdict === null).length;
		assert.equal(admittedNow, 1, `${freshFirst ? "fresh first" : "waiter first"}: exactly one call takes the room (waiter ${String(waiting.verdicts.at(-1))}, fresh ${String(fresh.verdicts.at(-1))})`);
		assert.equal(freshFirst ? waiting.verdicts.at(-1) : fresh.verdicts.at(-1), COST_WAIT, "the other waits for its turn");
	}
});

test("startChildMeter (issue #985): while a child waits, a FORWARD in another child (a call that may not wait) with no turn is refused, never admitted beside the waiter's turn", async () => {
	const dir = tempDir("pi-dispatch-child-forward-");
	const [waiting, forwarding] = await childrenIn(dir, [[23, "00000000000000ee"], [24, "00000000000000ff"]]);
	const parent = { spent: 0, inflight: 600 };
	const tick = parentTicks(dir, parent);
	tick.run();
	assert.equal(waiting.guard.admit(childCall()), COST_WAIT);
	queueChildCall(waiting);
	await microtask();
	Object.assign(parent, { spent: 100, inflight: 0 }); // room for ONE call of 500
	tick.run();
	tick.run();
	waiting.timer.tick();
	assert.deepEqual(waiting.verdicts, [null], "the waiter took the room in its turn");
	assert.equal(forwarding.guard.admit({ ...childCall(), waitable: false }), COST_CAP, "the forward fits by its SPENT, but the turn is the waiter's: refused, as before waiting existed");
	assert.ok(holding([waiting, forwarding], parent) <= 1000, `the job holds ${holding([waiting, forwarding], parent)}`);
});

test("startChildMeter (issue #985): no process takes the generation right after another's turn: what that turn admitted inside the parent's tick is missing from the next SPENT", async () => {
	const dir = tempDir("pi-dispatch-child-after-turn-");
	const [waiting, fresh] = await childrenIn(dir, [[27, "0000000000000c0c"], [28, "0000000000000d0d"]]);
	const parent = { spent: 0, inflight: 600 };
	const tick = parentTicks(dir, parent);
	const within = (label) => assert.ok(holding([waiting, fresh], parent) <= 1000, `${label}: the job holds ${holding([waiting, fresh], parent)} > 1000`);
	tick.run();
	assert.equal(waiting.guard.admit(childCall()), COST_WAIT);
	queueChildCall(waiting);
	await microtask();
	Object.assign(parent, { spent: 100, inflight: 0 }); // room for ONE call of 500
	tick.run();
	tick.run(); // generation 3: the waiter's turn is open
	// The parent's tick for generation 4 opens the waiter's ledger; right then the waiter takes generation 3's turn and is
	// admitted. The fold read the file as it was, so SPENT 4 holds 100, not 600.
	tick.onOpen = (file) => {
		if (file !== waiting.name) return;
		tick.onOpen = null;
		waiting.timer.tick();
	};
	tick.run();
	assert.deepEqual(waiting.verdicts, [null], "admitted in generation 3's turn, inside the tick");
	assert.equal(JSON.parse(readFileSync(join(dir, "SPENT"), "utf8")).total, 100, "the premise: SPENT 4 misses it");
	const verdict = fresh.guard.admit(childCall());
	within("the generation after the turn");
	assert.equal(verdict, COST_WAIT, "generation 4 follows the waiter's turn: the fresh call waits for the next");
	tick.run();
	assert.equal(fresh.guard.admit(childCall()), COST_WAIT, "SPENT 5 shows the 500: 100 + 500 + 500 > 1000");
	within("the next generation");
});

test("startChildMeter (issue #985): a call that waited is not admitted in the first generation that shows the wait: a call admitted without a turn inside that tick is missing from it", async () => {
	const dir = tempDir("pi-dispatch-child-first-gen-");
	const [waiting, fresh] = await childrenIn(dir, [[29, "0000000000000e0e"], [30, "0000000000000f0f"]]);
	const parent = { spent: 0, inflight: 600 };
	const tick = parentTicks(dir, parent);
	const within = (label) => assert.ok(holding([waiting, fresh], parent) <= 1000, `${label}: the job holds ${holding([waiting, fresh], parent)} > 1000`);
	const small = { ...CHILD_MODEL, maxTokens: 200 }; // a bound of 400
	tick.run(); // generation 1: nobody waits
	assert.equal(waiting.guard.admit(childCall()), COST_WAIT, "600 + 500 > 1000");
	queueChildCall(waiting);
	await microtask(); // the wait is in the waiter's ledger, not yet in any SPENT
	Object.assign(parent, { spent: 200, inflight: 0 }); // the parent's call settled at 200
	// Inside the parent's tick for generation 2, the other child, judging SPENT 1 (nobody waits, 600 + 400 <= 1000), is
	// admitted with no turn; the fold had already read its ledger, so SPENT 2, the first to show the wait, misses its 400.
	tick.onOpen = (file) => {
		if (file !== fresh.name) return;
		tick.onOpen = null;
		const verdict = fresh.guard.admit(childCall(null, small));
		fresh.verdicts.push(verdict);
		if (verdict === null) admitted(fresh);
	};
	tick.run();
	const spent = JSON.parse(readFileSync(join(dir, "SPENT"), "utf8"));
	assert.deepEqual([fresh.verdicts, spent.total, spent.waitingSince], [[null], 200, 2], "the premise: SPENT 2 shows the wait and misses the 400");
	waiting.timer.tick();
	within("the first generation that shows the wait");
	assert.deepEqual(waiting.verdicts, [COST_WAIT], "it fits by SPENT 2 (200 + 500), but a call admitted without a turn may be missing from it");
	tick.run();
	waiting.timer.tick();
	within("the next generation");
	assert.deepEqual(waiting.verdicts, [COST_WAIT, COST_WAIT], "SPENT 3 shows the 400: 200 + 400 + 500 > 1000");
});

test("startChildMeter (issue #985): a turn is never won twice across a generation boundary: a claim made on an older SPENT that a newer one overtook is lost", async () => {
	const dir = tempDir("pi-dispatch-child-boundary-");
	const hooked = { name: null, run: null };
	const writeFsOf = (name) => ({ ...realWriteFs(), openSync: (path, ...rest) => {
		if (name === hooked.name && String(path).includes("/CLAIM.") && hooked.run) {
			const run = hooked.run;
			hooked.run = null;
			run();
		}
		return realWriteFs().openSync(path, ...rest);
	} });
	const [waiting, fresh] = await childrenIn(dir, [[25, "0000000000000a0a"], [26, "0000000000000b0b"]], { writeFsOf });
	const parent = { spent: 0, inflight: 600 };
	const tick = parentTicks(dir, parent);
	const within = (label) => assert.ok(holding([waiting, fresh], parent) <= 1000, `${label}: the job holds ${holding([waiting, fresh], parent)} > 1000`);
	tick.run();
	assert.equal(waiting.guard.admit(childCall()), COST_WAIT);
	queueChildCall(waiting);
	await microtask();
	Object.assign(parent, { spent: 100, inflight: 0 }); // room for ONE call of 500
	tick.run();
	tick.run(); // generation 3: the waiter's turn is open
	// As the waiter creates generation 3's claim, the parent writes generation 4 and the other child calls: it finds no
	// claim for 3 (not created yet), takes 4, and is admitted.
	hooked.name = waiting.name;
	hooked.run = () => {
		tick.run();
		const verdict = fresh.guard.admit(childCall());
		fresh.verdicts.push(verdict);
		if (verdict === null) admitted(fresh);
	};
	waiting.timer.tick();
	within("both judged");
	assert.deepEqual([fresh.verdicts, waiting.verdicts], [[null], [COST_WAIT]], "the fresh call took generation 4's turn; the waiter's claim on 3 was overtaken, so it waits");
	assert.deepEqual(readdirSync(dir).filter((file) => file.startsWith("CLAIM.")).sort(), [waitClaimName(3), waitClaimName(4)]);
});

test("startChildMeter (issue #985): a child's turn is never the generation right after another process's turn, nor, for a call that waited, the first generation that shows the wait", async () => {
	const { dir, read, guard } = await waitingChild({ total: 0, inflight: 0 });
	writeFileAtomic({ dir, name: "SPENT", text: spentOf(0, 0, { gen: 5, waiting: 1, since: 3 }) }); // another child waits
	writeFileSync(join(dir, waitClaimName(4)), ""); // and another process took generation 4's turn
	assert.equal(guard.admit(childCall()), COST_WAIT, "it fits, but generation 5 follows another process's turn");
	assert.equal(reservation(read()).calls, 0);
	rmSyncReal(join(dir, waitClaimName(4)));
	assert.equal(guard.admit(childCall()), null, "with generation 4 free, it takes generation 5's turn");
	assert.ok(readdirSync(dir).includes(waitClaimName(5)));
	assert.equal(guard.admit(childCall()), null, "and keeps it for its next admission in generation 5");
});

/** The real fs functions writeFileAtomic uses, for a test that wraps one of them. */
function realWriteFs() {
	return { openSync: openSyncReal, fstatSync: fstatSyncReal, writeSync: writeSyncReal, closeSync: closeSyncReal, renameSync: renameSyncReal, rmSync: rmSyncReal, constants: constantsReal };
}

// ── the preload ───────────────────────────────────────────────────────────────────────────────────────────

/** A realpath over a fake tree: links resolve through `links`, every other path is itself, `missing` throws. */
function fakeRealpath({ links = {}, missing = [] } = {}) {
	return (path) => {
		if (missing.includes(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		return links[path] ?? path;
	};
}
const ROOT = "/app/node_modules/@earendil-works/pi-coding-agent";

test("entryKind: the five pinned entries by realpath (the .bin link included); anything else, or anything unresolvable, is not pi", () => {
	const options = { packageDir: () => ROOT, realpath: fakeRealpath({ links: { "/app/node_modules/.bin/pi": `${ROOT}/dist/bundle/cli.js` }, missing: ["/gone.js"] }) };
	assert.equal(entryKind(`${ROOT}/dist/bundle/cli.js`, options), "cli");
	assert.equal(entryKind("/app/node_modules/.bin/pi", options), "cli");
	assert.equal(entryKind(`${ROOT}/dist/bundle/cli-runtime.js`, options), "cli");
	assert.equal(entryKind(`${ROOT}/dist/cli.js`, options), "cli");
	assert.equal(entryKind(`${ROOT}/dist/bundle/rpc-entry.js`, options), "rpc");
	assert.equal(entryKind(`${ROOT}/dist/rpc-entry.js`, options), "rpc");
	assert.equal(entryKind("/workspace/cli.js", options), null, "a file merely named cli.js");
	assert.equal(entryKind("/app/image/runner/run-job.mjs", options), null, "not an entry: the nested runner is nestedRunnerKind's (child-route.mjs)");
	assert.equal(entryKind("/gone.js", options), null);
	assert.equal(entryKind(undefined, options), null);
	assert.equal(entryKind(`${ROOT}/dist/cli.js`, { ...options, packageDir: () => { throw new Error("no pi"); } }), null);
	assert.deepEqual(PI_ENTRIES.map((e) => `${e.kind}:${e.path}`), ["cli:dist/bundle/cli.js", "cli:dist/bundle/cli-runtime.js", "cli:dist/cli.js", "rpc:dist/bundle/rpc-entry.js", "rpc:dist/rpc-entry.js"]);
});

test("injectChildMeter: -e goes FIRST, before the spawner's own -e and before any `--`; a CLI subcommand is left alone; rpc always", () => {
	const argv = (...rest) => ["/usr/local/bin/node", `${ROOT}/dist/bundle/cli.js`, ...rest];
	const spawned = argv("--mode", "json", "-p", "-e", "theirs.ts", "--", "-e", "message");
	assert.equal(injectChildMeter(spawned, "cli", "/m.ts"), true);
	assert.deepEqual(spawned.slice(2), ["-e", "/m.ts", "--no-mcp", "--mode", "json", "-p", "-e", "theirs.ts", "--", "-e", "message"]);
	const bare = argv();
	injectChildMeter(bare, "cli", "/m.ts");
	assert.deepEqual(bare.slice(2), ["-e", "/m.ts", "--no-mcp"]);
	for (const sub of PI_SUBCOMMANDS) {
		const cmd = argv(sub, "x");
		assert.equal(injectChildMeter(cmd, "cli", "/m.ts"), false, sub);
		assert.deepEqual(cmd.slice(2), [sub, "x"]);
	}
	// Issue #1119: read as pi 1.7.0 reads it, after `--agent-dir <dir>` is taken out (before any `--` only).
	for (const args of [["--agent-dir", "/d", "list"], ["--agent-dir", "/d", "--agent-dir", "/e", "install", "npm:x"]]) {
		const cmd = argv(...args);
		assert.equal(injectChildMeter(cmd, "cli", "/m.ts"), false, args.join(" "));
		assert.deepEqual(cmd.slice(2), args);
	}
	const flagged = argv("--agent-dir", "/d", "-p", "list");
	assert.equal(injectChildMeter(flagged, "cli", "/m.ts"), true, "a prompt after the flag is still a session");
	assert.deepEqual(flagged.slice(2), ["-e", "/m.ts", "--no-mcp", "--agent-dir", "/d", "-p", "list"]);
	assert.equal(injectChildMeter(argv("--", "--agent-dir", "/d", "list"), "cli", "/m.ts"), true, "after `--` it is a message");
	// rpc-entry prepends `--mode rpc` itself, so its args[0] is never a subcommand.
	const rpc = argv("list");
	assert.equal(injectChildMeter(rpc, "rpc", "/m.ts"), true);
	assert.deepEqual(rpc.slice(2), ["-e", "/m.ts", "--no-mcp", "list"]);
	assert.ok(CHILD_METER_PATH.endsWith("/image/runner/src/child-meter.ts"));
	// The flags that exit before extensions load, read before any `--` only.
	assert.equal(exitsBeforeExtensions(["--version"]), true);
	assert.equal(exitsBeforeExtensions(["-p", "--export", "s.jsonl"]), true);
	assert.equal(exitsBeforeExtensions(["-p", "--", "--version"]), false, "after `--` it is a message");
	assert.equal(exitsBeforeExtensions(["-p", "hi"]), false);
	// pi 1.7.0 refuses an `--agent-dir` with no directory and exits before any extension loads.
	assert.equal(exitsBeforeExtensions(["-p", "--agent-dir"]), true);
	assert.equal(exitsBeforeExtensions(["--agent-dir", "", "-p"]), true);
	assert.equal(exitsBeforeExtensions(["--agent-dir", "/d", "-p"]), false);
	assert.equal(exitsBeforeExtensions(["-p", "--", "--agent-dir"]), false, "after `--` it is a message");
	assert.equal(exitsBeforeExtensions(["--agent-dir", "--version", "-p"]), false, "pi takes the flag as the directory");
	assert.equal(exitsBeforeExtensions(["--agent-dir", "/d", "--version"]), true);
});

test("wrapperSource: the real module once, re-exported whole, and its class, compat copy and catalog handed over; without them, no class", () => {
	const realUrl = `file://${ROOT}/dist/core/model-runtime.js?pi-dispatch-real=1`;
	const full = wrapperSource({ realUrl, compatUrl: "file:///c.js", providersUrl: "file:///p.js", usageMeterUrl: "file:///u.mjs" });
	assert.match(full, /^import \* as __piDispatchReal from "file:\/\/[^"]*model-runtime\.js\?pi-dispatch-real=1";$/m);
	assert.match(full, /^export \* from "file:\/\/[^"]*model-runtime\.js\?pi-dispatch-real=1";$/m);
	assert.match(full, /^import \* as __piDispatchCompat from "file:\/\/\/c\.js";$/m);
	assert.match(full, /\?\.library\?\.\(\{ ModelRuntime: __piDispatchReal\.ModelRuntime, compat: __piDispatchCompat, providers: __piDispatchProviders, meter: __piDispatchUsageMeter \}\);/);
	const none = wrapperSource({ realUrl, compatUrl: null, providersUrl: null, usageMeterUrl: "file:///u.mjs" });
	assert.doesNotMatch(none, /__piDispatchCompat/, "no import that might not resolve");
	assert.match(none, /library\?\.\(\{ ModelRuntime: null, compat: null, providers: null, meter: __piDispatchUsageMeter \}\);/);
	assert.match(none, /^export \* from /m, "the module is still re-exported whole");
	assert.equal(USAGE_METER_URL, new URL("../src/usage-meter.mjs", import.meta.url).href);
	assert.equal(USAGE_METER_PATH, new URL("../src/usage-meter.mjs", import.meta.url).pathname);
	assert.equal(Symbol.for("pi-dispatch.child-meter"), CHILD_METER_HANDOFF, "the preload's key is usage-meter.mjs's");
});

test("the resolve hook: every other resolution passes untouched; model-runtime.js resolves to the wrapper, on its path, query or not; the real module is not wrapped twice; a pinned bundle file is reported", () => {
	const runtimeUrl = `file://${ROOT}/dist/core/model-runtime.js`;
	assert.ok(runtimeUrl.endsWith(MODEL_RUNTIME_SUFFIX));
	const resolved = { "./x.js": "file:///app/node_modules/x/index.js", "@earendil-works/pi-ai/compat": "file:///ai/compat.js", "@earendil-works/pi-ai/providers/all": "file:///ai/all.js" };
	const next = (specifier) => ({ url: resolved[specifier] ?? specifier, format: "module" });
	let bundles = 0;
	const hook = makeLibraryResolveHook({ packageDir: () => ROOT, onBundle: () => { bundles += 1; }, readSource: () => "export class ModelRuntime {\n}\n" });
	assert.deepEqual(hook("./x.js", {}, next), { url: "file:///app/node_modules/x/index.js", format: "module" }, "untouched");
	const decode = (result) => decodeURIComponent(result.url.slice("data:text/javascript,".length));
	for (const variant of [runtimeUrl, `${runtimeUrl}?x=1`, `${runtimeUrl}#h`]) {
		const result = hook(variant, {}, next);
		assert.equal(result.shortCircuit, true);
		assert.ok(result.url.startsWith("data:text/javascript,"), variant);
		assert.match(decode(result), /__piDispatchReal\.ModelRuntime, compat: __piDispatchCompat/, variant);
	}
	assert.match(decode(hook(`${runtimeUrl}?x=1`, {}, next)), /model-runtime\.js\?x=1&pi-dispatch-real=1"/);
	// The wrapper's own import of the real module resolves to the real module.
	assert.deepEqual(hook(`${runtimeUrl}?pi-dispatch-real=1`, {}, next), { url: `${runtimeUrl}?pi-dispatch-real=1`, format: "module" });
	// A source without the class, or a pi-ai that cannot resolve ./compat: no class handed over.
	const moved = makeLibraryResolveHook({ packageDir: () => ROOT, readSource: () => "export const other = 1;\n" });
	assert.match(decode(moved(runtimeUrl, {}, next)), /ModelRuntime: null/);
	const noCompat = (specifier) => {
		if (specifier === "@earendil-works/pi-ai/compat") throw Object.assign(new Error("not exported"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
		return next(specifier);
	};
	assert.match(decode(hook(runtimeUrl, {}, noCompat)), /ModelRuntime: null/);
	// The pinned bundle, any file, with a query too; another copy's bundle is not the pinned one.
	hook(`file://${ROOT}/dist/bundle/index.js`, {}, next);
	hook(`file://${ROOT}/dist/bundle/chunks/chunk-X.js?v=2`, {}, next);
	assert.equal(bundles, 2);
	hook("file:///workspace/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js", {}, next);
	assert.equal(bundles, 2);
});

test("preload: nothing without a ledger directory; an entry is injected and stubbed; a subcommand gets a done ledger and no -e; any other process gets the hook", async () => {
	const realpath = fakeRealpath();
	const packageDir = () => ROOT;
	const noHooks = () => assert.fail("no hook may be registered here");
	assert.equal(await preload({ env: {}, argv: ["node", `${ROOT}/dist/cli.js`], global: {}, packageDir, realpath, registerHooks: noHooks }), "none");

	const dir = tempDir("pi-dispatch-preload-");
	const argv = ["node", `${ROOT}/dist/cli.js`, "-p", "hi"];
	const global = {};
	const exits = [];
	assert.equal(await preload({ env: { PI_DISPATCH_CHILD_LEDGER: dir }, argv, pid: 77, global, packageDir, realpath, registerHooks: noHooks, loadMeter: () => usageMeter, onExit: (l) => exits.push(l) }), "entry");
	assert.deepEqual(argv.slice(2), ["-e", CHILD_METER_PATH, "--no-mcp", "-p", "hi"]);
	assert.equal(global[CHILD_METER_HANDOFF].meter, usageMeter, "the meter module is handed over");
	assert.equal(exits.length, 0, "a session run has no exit rewrite: the meter's own exit write is the one");
	const [stub] = readdirSync(dir);
	assert.match(stub, /^77\.[0-9a-f]{16}\.json$/);
	assert.equal(global[CHILD_METER_HANDOFF].name, stub);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, stub), "utf8")), usageMeter.childLedger({ state: "starting" }));

	const sub = ["node", `${ROOT}/dist/cli.js`, "install", "npm:x"];
	const subDir = tempDir("pi-dispatch-preload-sub-");
	assert.equal(await preload({ env: { PI_DISPATCH_CHILD_LEDGER: subDir }, argv: sub, pid: 78, global: {}, packageDir, realpath, registerHooks: noHooks, loadMeter: () => usageMeter }), "subcommand");
	assert.deepEqual(sub.slice(2), ["install", "npm:x"], "no -e in front of a subcommand");
	// But a ledger for its pid, `done` with zeros (issue #500 part E): once setupCli has run, its command line reads only
	// `pi`, and the parent's detector would count a pi process with no ledger as unmetered.
	const [subStub] = readdirSync(subDir);
	assert.match(subStub, /^78\.[0-9a-f]{16}\.json$/);
	assert.deepEqual(JSON.parse(readFileSync(join(subDir, subStub), "utf8")), usageMeter.childLedger({ state: "done" }));

	const hooks = [];
	const plain = {};
	assert.equal(await preload({ env: { PI_DISPATCH_CHILD_LEDGER: dir }, argv: ["node", "/workspace/script.mjs"], global: plain, packageDir, realpath, registerHooks: (h) => hooks.push(h) }), "library");
	assert.equal(hooks.length, 1);
	assert.equal(typeof hooks[0].resolve, "function");
	assert.equal(hooks[0].load, undefined, "a resolve hook only: a load hook breaks `node --import tsx`");
	assert.equal(typeof plain[CHILD_METER_HANDOFF].library, "function");
});

test("preload: `pi --version` (or --export) ends its stub `done`, not `starting`, unless the meter started after all", async () => {
	const dir = tempDir("pi-dispatch-preload-version-");
	const exits = [];
	const global = {};
	await preload({ env: { PI_DISPATCH_CHILD_LEDGER: dir }, argv: ["node", `${ROOT}/dist/bundle/cli.js`, "--version"], pid: 5, global, packageDir: () => ROOT, realpath: fakeRealpath(), registerHooks: undefined, loadMeter: () => usageMeter, onExit: (l) => exits.push(l) });
	const [file] = readdirSync(dir);
	assert.equal(JSON.parse(readFileSync(join(dir, file), "utf8")).state, "starting");
	assert.equal(exits.length, 1);
	exits[0]();
	assert.deepEqual(JSON.parse(readFileSync(join(dir, file), "utf8")), usageMeter.childLedger({ state: "done" }));
	// Had the meter started, its own exit write is the truth and this one stands aside.
	global[CHILD_METER_HANDOFF].child = {};
	writeFileAtomic({ dir, name: file, text: "{}" });
	exits[0]();
	assert.equal(readFileSync(join(dir, file), "utf8"), "{}");
});

test("preload: total on a Node without registerHooks, or one where it throws; the library handler never throws either", async () => {
	const dir = tempDir("pi-dispatch-preload-old-");
	const options = { env: { PI_DISPATCH_CHILD_LEDGER: dir }, argv: ["node", "/workspace/script.mjs"], packageDir: () => ROOT, realpath: fakeRealpath() };
	assert.equal(await preload({ ...options, global: {}, registerHooks: undefined }), "library");
	const global = {};
	assert.equal(await preload({ ...options, global, registerHooks: () => { throw new Error("unsupported"); } }), "library");
	// A handler handed something unusable writes nothing it should not and does not throw.
	assert.doesNotThrow(() => global[CHILD_METER_HANDOFF].library({ ModelRuntime: null, compat: null, providers: null, meter: null }));
	assert.deepEqual(readdirSync(dir), []);
	// With the meter module and no class (a model-runtime.js the hook does not recognise): the child is unmetered at once.
	global[CHILD_METER_HANDOFF].library({ ModelRuntime: null, compat: null, providers: null, meter: usageMeter });
	await new Promise((resolve) => setImmediate(resolve));
	const [file] = readdirSync(dir);
	assert.equal(JSON.parse(readFileSync(join(dir, file), "utf8")).metered, false);
});

test("preload: the pinned-bundle rule never fires in a worker thread (a metered pi CLI's image and codemode workers)", async () => {
	for (const [isMain, expected] of [[false, 0], [true, 1]]) {
		const dir = tempDir("pi-dispatch-preload-worker-");
		const hooks = [];
		await preload({ env: { PI_DISPATCH_CHILD_LEDGER: dir }, argv: ["node", `${ROOT}/dist/bundle/cli.js`], global: {}, packageDir: () => ROOT, realpath: fakeRealpath({ missing: [`${ROOT}/dist/bundle/cli.js`] }), registerHooks: (h) => hooks.push(h), isMain, loadMeter: async () => usageMeter });
		hooks[0].resolve("./image-resize-worker.js", {}, () => ({ url: `file://${ROOT}/dist/bundle/chunks/image-resize-worker.js`, format: "module" }));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(readdirSync(dir).length, expected, isMain ? "the main thread of a non-entry process: unmetered" : "a worker thread: nothing");
	}
});
