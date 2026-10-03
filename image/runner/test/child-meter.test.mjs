import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { closeSync as closeSyncReal, constants as constantsReal, fstatSync as fstatSyncReal, mkdirSync, openSync as openSyncReal, readdirSync, readFileSync, renameSync as renameSyncReal, rmSync as rmSyncReal, statSync, symlinkSync, writeFileSync, writeSync as writeSyncReal } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	CHILD_LEDGER_ENV,
	CHILD_LEDGER_NAME,
	CHILD_METER_HANDOFF,
	childLedgerName,
	openChildLedger,
	parseChildLedger,
	readExternal,
	readStop,
	RUNNER_PID_ENV,
	spentFile,
	startChildMeter,
	stopFile,
	writeFileAtomic,
} from "../src/usage-meter.mjs";
import * as usageMeter from "../src/usage-meter.mjs";
import { COST_CAP, MODEL_NOT_ALLOWED, TOKEN_BUDGET } from "../src/outcome.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The preload is CommonJS (it is loaded with --require); requiring it here runs its top level, which does nothing
// without PI_DISPATCH_CHILD_LEDGER in this process's environment.
const {
	CHILD_METER_PATH,
	compatResolvesFrom,
	entryKind,
	exitsBeforeExtensions,
	injectChildMeter,
	makeLibraryLoadHook,
	MODEL_RUNTIME_SUFFIX,
	patchModelRuntime,
	PI_ENTRIES,
	PI_SUBCOMMANDS,
	preload,
	USAGE_METER_PATH,
	USAGE_METER_URL,
} = createRequire(import.meta.url)("../src/child-preload.cjs");

/**
 * Issue #500 part C, the pure halves (DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY): the runner's ledger directory, the
 * control files a child reads, the child's meter start with its install injected, and the preload's decisions with
 * everything it touches injected. child-meter.integration.test.mjs runs the same code in real pi children.
 */

// ── the runner's side ─────────────────────────────────────────────────────────────────────────────────────

test("openChildLedger: a 0700 directory under the temp root, absolute, the two variables, and the preload required once through NODE_OPTIONS", () => {
	const root = tempDir("pi-dispatch-ledger-root-");
	const env = { NODE_OPTIONS: "--max-old-space-size=512" };
	const opened = openChildLedger({ env, pid: 4242, preloadPath: "/app/image/runner/src/child-preload.cjs", tmp: () => root });
	assert.equal(opened.error, undefined);
	assert.ok(opened.dir.startsWith(join(root, "pi-dispatch-meter-")), opened.dir);
	assert.equal(statSync(opened.dir).mode & 0o777, 0o700);
	assert.equal(env[CHILD_LEDGER_ENV], opened.dir);
	assert.equal(env[RUNNER_PID_ENV], "4242");
	// --require, which every Node accepts in NODE_OPTIONS (Node 16 refuses --import there). The operator's value is kept, in front.
	assert.equal(env.NODE_OPTIONS, "--max-old-space-size=512 --require=/app/image/runner/src/child-preload.cjs");
	openChildLedger({ env, pid: 4242, preloadPath: "/app/image/runner/src/child-preload.cjs", tmp: () => root });
	assert.equal(env.NODE_OPTIONS, "--max-old-space-size=512 --require=/app/image/runner/src/child-preload.cjs", "never twice");
	const spaced = {};
	openChildLedger({ env: spaced, pid: 1, preloadPath: "/a b/child-preload.cjs", tmp: () => root });
	assert.equal(spaced.NODE_OPTIONS, '--require="/a b/child-preload.cjs"', "a path with a space is quoted");
});

test("openChildLedger: a relative TMPDIR still gives an absolute directory", () => {
	const root = tempDir("pi-dispatch-ledger-rel-");
	const relative = join(root, "sub");
	mkdirSync(relative);
	const cwd = process.cwd();
	process.chdir(root);
	try {
		const env = {};
		const opened = openChildLedger({ env, pid: 1, preloadPath: "/p.cjs", tmp: () => "sub" });
		assert.equal(dirname(opened.dir), join(process.cwd(), "sub"), "absolute, so every child resolves the same directory whatever its cwd");
		assert.equal(env.PI_DISPATCH_CHILD_LEDGER, opened.dir);
	} finally {
		process.chdir(cwd);
	}
});

test("openChildLedger: a directory that cannot be made deletes both names, leaves NODE_OPTIONS alone, and names a code, never a path", () => {
	const env = { NODE_OPTIONS: "--x", PI_DISPATCH_CHILD_LEDGER: "/inherited", PI_DISPATCH_RUNNER_PID: "9" };
	const mkdtemp = () => {
		throw Object.assign(new Error("EROFS: /tmp/secret"), { code: "EROFS" });
	};
	const opened = openChildLedger({ env, pid: 1, preloadPath: "/p.cjs", mkdtemp, tmp: () => "/nowhere" });
	assert.deepEqual(opened, { error: "EROFS" });
	assert.deepEqual(env, { NODE_OPTIONS: "--x" }, "no child is pointed anywhere, not even at an inherited directory");
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

test("startChildMeter: installs on the class it is given with brake, isStopped and the injected compat copy, writes running, and done at exit", async () => {
	const fake = fakeInstall();
	const { child, exits, read, dir } = await startIn({ install: fake.install });
	assert.equal(fake.calls.length, 1);
	const given = fake.calls[0];
	assert.equal(given.ModelRuntime, ChildRuntime);
	assert.equal(given.compat, FAKE_COMPAT);
	assert.equal(given.brake, true);
	assert.equal(given.guard, null, "no policy, no guard");
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
	// judge() asks isStopped before every dispatch: the first ask writes the ledger, before the call goes out.
	assert.equal(fake2.calls[0].isStopped(), null);
	assert.deepEqual(JSON.parse(readFileSync(join(dir2, name), "utf8")).state, "running");
	exits2[0]();
	assert.equal(JSON.parse(readFileSync(join(dir2, name), "utf8")).state, "done");
});

test("startChildMeter: once a ledger write fails the child is stopped for every later call and unmetered in every later write", async () => {
	const fake = fakeInstall();
	const dir = tempDir("pi-dispatch-child-fail-");
	const name = "97.0123456789abcdef.json";
	let failing = false;
	const writeFs = { ...realWriteFs(), openSync: (...args) => {
		if (failing) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
		return realWriteFs().openSync(...args);
	} };
	await startChildMeter({ ModelRuntime: ChildRuntime, compat: FAKE_COMPAT, env: {}, dir, name, writeFs, install: fake.install, onExit: () => {} });
	const { meter, isStopped } = fake.calls[0];
	meter.record({ input: 5, output: 5, totalTokens: 10, cost: { total: 0.001 } }, { provider: "fake", model: "m1", sessionId: "s" });
	assert.equal(isStopped(), null, "a healthy ledger: go");
	failing = true;
	meter.record({ input: 5, output: 5, totalTokens: 10, cost: { total: 0.001 } }, { provider: "fake", model: "m1", sessionId: "s" });
	assert.equal(isStopped(), TOKEN_BUDGET, "the write failed: no further call may go out that the ledger cannot record");
	failing = false;
	assert.equal(isStopped(), TOKEN_BUDGET, "and it stays stopped");
	meter.record({ input: 5, output: 5, totalTokens: 10, cost: { total: 0.001 } }, { provider: "fake", model: "m1", sessionId: "s" });
	assert.equal(JSON.parse(readFileSync(join(dir, name), "utf8")).metered, false, "the next write that succeeds says unmetered");
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
	assert.equal(entryKind("/app/image/runner/run-job.mjs", options), null, "the nested runner is part D's");
	assert.equal(entryKind("/gone.js", options), null);
	assert.equal(entryKind(undefined, options), null);
	assert.equal(entryKind(`${ROOT}/dist/cli.js`, { ...options, packageDir: () => { throw new Error("no pi"); } }), null);
	assert.deepEqual(PI_ENTRIES.map((e) => `${e.kind}:${e.path}`), ["cli:dist/bundle/cli.js", "cli:dist/bundle/cli-runtime.js", "cli:dist/cli.js", "rpc:dist/bundle/rpc-entry.js", "rpc:dist/rpc-entry.js"]);
});

test("injectChildMeter: -e goes FIRST, before the spawner's own -e and before any `--`; a CLI subcommand is left alone; rpc always", () => {
	const argv = (...rest) => ["/usr/local/bin/node", `${ROOT}/dist/bundle/cli.js`, ...rest];
	const spawned = argv("--mode", "json", "-p", "-e", "theirs.ts", "--", "-e", "message");
	assert.equal(injectChildMeter(spawned, "cli", "/m.ts"), true);
	assert.deepEqual(spawned.slice(2), ["-e", "/m.ts", "--mode", "json", "-p", "-e", "theirs.ts", "--", "-e", "message"]);
	const bare = argv();
	injectChildMeter(bare, "cli", "/m.ts");
	assert.deepEqual(bare.slice(2), ["-e", "/m.ts"]);
	for (const sub of PI_SUBCOMMANDS) {
		const cmd = argv(sub, "x");
		assert.equal(injectChildMeter(cmd, "cli", "/m.ts"), false, sub);
		assert.deepEqual(cmd.slice(2), [sub, "x"]);
	}
	// rpc-entry prepends `--mode rpc` itself, so its args[0] is never a subcommand.
	const rpc = argv("list");
	assert.equal(injectChildMeter(rpc, "rpc", "/m.ts"), true);
	assert.deepEqual(rpc.slice(2), ["-e", "/m.ts", "list"]);
	assert.ok(CHILD_METER_PATH.endsWith("/image/runner/src/child-meter.ts"));
	// The flags that exit before extensions load, read before any `--` only.
	assert.equal(exitsBeforeExtensions(["--version"]), true);
	assert.equal(exitsBeforeExtensions(["-p", "--export", "s.jsonl"]), true);
	assert.equal(exitsBeforeExtensions(["-p", "--", "--version"]), false, "after `--` it is a message");
	assert.equal(exitsBeforeExtensions(["-p", "hi"]), false);
});

test("patchModelRuntime: the pinned shape gets the class, the module's own compat copy and the catalog; any other shape, or no ./compat, hands over no class", () => {
	const pinned = 'import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";\nexport class ModelRuntime {\n}\n';
	const patched = patchModelRuntime(pinned, { usageMeterUrl: "file:///app/image/runner/src/usage-meter.mjs" });
	assert.ok(patched.startsWith(pinned), "the module's own source is untouched, only appended to");
	assert.match(patched, /import \* as __piDispatchCompat from "@earendil-works\/pi-ai\/compat";/);
	assert.match(patched, /import \* as __piDispatchUsageMeter from "file:\/\/\/app\/image\/runner\/src\/usage-meter\.mjs";/);
	assert.match(patched, /globalThis\[Symbol\.for\("pi-dispatch\.child-meter"\)\]\?\.library\?\.\(\{ ModelRuntime, compat: __piDispatchCompat, providers: builtinProviderCatalog, meter: __piDispatchUsageMeter \}\);\n$/);
	for (const moved of [patchModelRuntime("export class ModelRuntime {}\n", { usageMeterUrl: "file:///u.mjs" }), patchModelRuntime(pinned, { compat: false, usageMeterUrl: "file:///u.mjs" })]) {
		assert.doesNotMatch(moved, /pi-ai\/compat/, "no import that might not resolve");
		assert.match(moved, /library\?\.\(\{ ModelRuntime: null, compat: null, providers: null, meter: __piDispatchUsageMeter \}\);/);
	}
	assert.equal(USAGE_METER_URL, new URL("../src/usage-meter.mjs", import.meta.url).href);
	assert.equal(USAGE_METER_PATH, new URL("../src/usage-meter.mjs", import.meta.url).pathname);
	assert.equal(Symbol.for("pi-dispatch.child-meter"), CHILD_METER_HANDOFF, "the preload's key is usage-meter.mjs's");
});

test("compatResolvesFrom: true only when the pi-ai that url resolves exports ./compat", () => {
	const root = tempDir("pi-dispatch-compat-");
	const manifest = join(root, "package.json");
	writeFileSync(manifest, JSON.stringify({ exports: { ".": "./i.js", "./compat": "./c.js" } }));
	assert.equal(compatResolvesFrom("file:///x", { findPackageJSON: () => manifest }), true);
	writeFileSync(manifest, JSON.stringify({ exports: { ".": "./i.js", "./providers/*": "./p/*.js" } }));
	assert.equal(compatResolvesFrom("file:///x", { findPackageJSON: () => manifest }), false);
	assert.equal(compatResolvesFrom("file:///x", { findPackageJSON: undefined }), false, "a Node with no findPackageJSON cannot tell: no class");
	assert.equal(compatResolvesFrom("file:///x", { findPackageJSON: () => { throw new Error("not found"); } }), false);
});

test("the load hook: every other module passes untouched; model-runtime.js is matched on its path, query or not; a pinned bundle file is reported; a failure returns pi's own source", () => {
	const source = new TextEncoder().encode('import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";\nexport class ModelRuntime {}\n');
	const loaded = [];
	const next = (url) => {
		loaded.push(url);
		return { format: "module", source };
	};
	let bundles = 0;
	const hook = makeLibraryLoadHook({ packageDir: () => ROOT, onBundle: () => { bundles += 1; }, compatResolves: () => true });
	const other = hook("file:///app/node_modules/x/index.js", {}, next);
	assert.equal(other.source, source, "untouched");
	const url = `file://${ROOT}/dist/core/model-runtime.js`;
	assert.ok(url.endsWith(MODEL_RUNTIME_SUFFIX));
	for (const variant of [url, `${url}?x=1`, `${url}#h`]) assert.match(hook(variant, {}, next).source, /__piDispatchCompat/, variant);
	const noCompat = makeLibraryLoadHook({ packageDir: () => ROOT, compatResolves: () => false });
	assert.match(noCompat(url, {}, next).source, /ModelRuntime: null/);
	assert.deepEqual(hook(url, {}, () => ({ format: "commonjs", source: null })), { format: "commonjs", source: null });
	const broken = { format: "module", get source() { throw new Error("boom"); } };
	assert.equal(hook(url, {}, () => broken), broken);
	// The pinned bundle, any file, with a query too; another copy's bundle is not the pinned one.
	hook(`file://${ROOT}/dist/bundle/index.js`, {}, next);
	hook(`file://${ROOT}/dist/bundle/chunks/chunk-X.js?v=2`, {}, next);
	assert.equal(bundles, 2);
	hook("file:///workspace/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js", {}, next);
	assert.equal(bundles, 2);
});

test("preload: nothing without a ledger directory; an entry is injected and stubbed; a subcommand is not; any other process gets the hook", () => {
	const realpath = fakeRealpath();
	const packageDir = () => ROOT;
	const noHooks = () => assert.fail("no hook may be registered here");
	assert.equal(preload({ env: {}, argv: ["node", `${ROOT}/dist/cli.js`], global: {}, packageDir, realpath, registerHooks: noHooks }), "none");

	const dir = tempDir("pi-dispatch-preload-");
	const argv = ["node", `${ROOT}/dist/cli.js`, "-p", "hi"];
	const global = {};
	const exits = [];
	assert.equal(preload({ env: { PI_DISPATCH_CHILD_LEDGER: dir }, argv, pid: 77, global, packageDir, realpath, registerHooks: noHooks, loadMeter: () => usageMeter, onExit: (l) => exits.push(l) }), "entry");
	assert.deepEqual(argv.slice(2), ["-e", CHILD_METER_PATH, "-p", "hi"]);
	assert.equal(global[CHILD_METER_HANDOFF].meter, usageMeter, "the meter module is handed over");
	assert.equal(exits.length, 0, "a session run has no exit rewrite: the meter's own exit write is the one");
	const [stub] = readdirSync(dir);
	assert.match(stub, /^77\.[0-9a-f]{16}\.json$/);
	assert.equal(global[CHILD_METER_HANDOFF].name, stub);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, stub), "utf8")), usageMeter.childLedger({ state: "starting" }));

	const sub = ["node", `${ROOT}/dist/cli.js`, "install", "npm:x"];
	assert.equal(preload({ env: { PI_DISPATCH_CHILD_LEDGER: dir }, argv: sub, global: {}, packageDir, realpath, registerHooks: noHooks }), "subcommand");
	assert.deepEqual(sub.slice(2), ["install", "npm:x"]);

	const hooks = [];
	const plain = {};
	assert.equal(preload({ env: { PI_DISPATCH_CHILD_LEDGER: dir }, argv: ["node", "/workspace/script.mjs"], global: plain, packageDir, realpath, registerHooks: (h) => hooks.push(h) }), "library");
	assert.equal(hooks.length, 1);
	assert.equal(typeof hooks[0].load, "function");
	assert.equal(typeof plain[CHILD_METER_HANDOFF].library, "function");
});

test("preload: `pi --version` (or --export) ends its stub `done`, not `starting`, unless the meter started after all", () => {
	const dir = tempDir("pi-dispatch-preload-version-");
	const exits = [];
	const global = {};
	preload({ env: { PI_DISPATCH_CHILD_LEDGER: dir }, argv: ["node", `${ROOT}/dist/bundle/cli.js`, "--version"], pid: 5, global, packageDir: () => ROOT, realpath: fakeRealpath(), registerHooks: undefined, loadMeter: () => usageMeter, onExit: (l) => exits.push(l) });
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
	assert.equal(preload({ ...options, global: {}, registerHooks: undefined }), "library");
	const global = {};
	assert.equal(preload({ ...options, global, registerHooks: () => { throw new Error("unsupported"); } }), "library");
	// A handler handed something unusable writes nothing it should not and does not throw.
	assert.doesNotThrow(() => global[CHILD_METER_HANDOFF].library({ ModelRuntime: null, compat: null, providers: null, meter: null }));
	assert.deepEqual(readdirSync(dir), []);
	// With the meter module and no class (a model-runtime.js the hook does not recognise): the child is unmetered at once.
	global[CHILD_METER_HANDOFF].library({ ModelRuntime: null, compat: null, providers: null, meter: usageMeter });
	await new Promise((resolve) => setImmediate(resolve));
	const [file] = readdirSync(dir);
	assert.equal(JSON.parse(readFileSync(join(dir, file), "utf8")).metered, false);
});
