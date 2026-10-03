import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
import { COST_CAP, MODEL_NOT_ALLOWED, TOKEN_BUDGET } from "../src/outcome.mjs";
import { CHILD_METER_PATH, entryKind, injectChildMeter, libraryLoadHook, MODEL_RUNTIME_SUFFIX, patchModelRuntime, PI_ENTRIES, PI_SUBCOMMANDS, preload, USAGE_METER_URL } from "../src/child-preload.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #500 part C, the pure halves (DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY): the runner's ledger directory, the
 * control files a child reads, the child's meter start with its install injected, and the preload's decisions with
 * everything it touches injected. child-meter.integration.test.mjs runs the same code in real pi children.
 */

// ── the runner's side ─────────────────────────────────────────────────────────────────────────────────────

test("openChildLedger: a 0700 directory under the temp root, the two variables, and the preload appended to NODE_OPTIONS once", () => {
	const root = tempDir("pi-dispatch-ledger-root-");
	const env = { NODE_OPTIONS: "--max-old-space-size=512" };
	const opened = openChildLedger({ env, pid: 4242, preloadUrl: "file:///app/image/runner/src/child-preload.mjs", tmp: () => root });
	assert.equal(opened.error, undefined);
	assert.ok(opened.dir.startsWith(join(root, "pi-dispatch-meter-")), opened.dir);
	assert.equal(statSync(opened.dir).mode & 0o777, 0o700);
	assert.equal(env[CHILD_LEDGER_ENV], opened.dir);
	assert.equal(env[RUNNER_PID_ENV], "4242");
	// What the operator's NODE_OPTIONS held is kept, in front.
	assert.equal(env.NODE_OPTIONS, "--max-old-space-size=512 --import=file:///app/image/runner/src/child-preload.mjs");
	openChildLedger({ env, pid: 4242, preloadUrl: "file:///app/image/runner/src/child-preload.mjs", tmp: () => root });
	assert.equal(env.NODE_OPTIONS, "--max-old-space-size=512 --import=file:///app/image/runner/src/child-preload.mjs", "never twice");
	const bare = {};
	openChildLedger({ env: bare, pid: 1, preloadUrl: "file:///p.mjs", tmp: () => root });
	assert.equal(bare.NODE_OPTIONS, "--import=file:///p.mjs");
});

test("openChildLedger: a directory that cannot be made leaves the environment untouched and names a code, never a path", () => {
	const env = { NODE_OPTIONS: "--x" };
	const mkdtemp = () => {
		throw Object.assign(new Error("EROFS: /tmp/secret"), { code: "EROFS" });
	};
	const opened = openChildLedger({ env, pid: 1, preloadUrl: "file:///p.mjs", mkdtemp, tmp: () => "/nowhere" });
	assert.deepEqual(opened, { error: "EROFS" });
	assert.deepEqual(env, { NODE_OPTIONS: "--x" });
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

// ── the preload ───────────────────────────────────────────────────────────────────────────────────────────

/** A realpath over a fake tree: links resolve through `links`, every other path is itself, `missing` throws. */
function fakeRealpath({ links = {}, missing = [] } = {}) {
	return (path) => {
		if (missing.includes(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		return links[path] ?? path;
	};
}
const ROOT = "/app/node_modules/@earendil-works/pi-coding-agent";

test("entryKind: the four pinned entries by realpath (the .bin link included); anything else, or anything unresolvable, is not pi", () => {
	const options = { packageDir: () => ROOT, realpath: fakeRealpath({ links: { "/app/node_modules/.bin/pi": `${ROOT}/dist/bundle/cli.js` }, missing: ["/gone.js"] }) };
	assert.equal(entryKind(`${ROOT}/dist/bundle/cli.js`, options), "cli");
	assert.equal(entryKind("/app/node_modules/.bin/pi", options), "cli");
	assert.equal(entryKind(`${ROOT}/dist/cli.js`, options), "cli");
	assert.equal(entryKind(`${ROOT}/dist/bundle/rpc-entry.js`, options), "rpc");
	assert.equal(entryKind(`${ROOT}/dist/rpc-entry.js`, options), "rpc");
	assert.equal(entryKind("/workspace/cli.js", options), null, "a file merely named cli.js");
	assert.equal(entryKind("/app/image/runner/run-job.mjs", options), null, "the nested runner is part D's");
	assert.equal(entryKind("/gone.js", options), null);
	assert.equal(entryKind(undefined, options), null);
	assert.equal(entryKind(`${ROOT}/dist/cli.js`, { ...options, packageDir: () => { throw new Error("no pi"); } }), null);
	assert.deepEqual(PI_ENTRIES.map((e) => `${e.kind}:${e.path}`), ["cli:dist/bundle/cli.js", "cli:dist/cli.js", "rpc:dist/bundle/rpc-entry.js", "rpc:dist/rpc-entry.js"]);
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
});

test("patchModelRuntime: the pinned shape gets the class, the module's own compat copy and the catalog; any other shape hands over no class", () => {
	const pinned = 'import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";\nexport class ModelRuntime {\n}\n';
	const patched = patchModelRuntime(pinned, "file:///app/image/runner/src/usage-meter.mjs");
	assert.ok(patched.startsWith(pinned), "the module's own source is untouched, only appended to");
	assert.match(patched, /import \* as __piDispatchCompat from "@earendil-works\/pi-ai\/compat";/);
	assert.match(patched, /import \* as __piDispatchUsageMeter from "file:\/\/\/app\/image\/runner\/src\/usage-meter\.mjs";/);
	assert.match(patched, /globalThis\[Symbol\.for\("pi-dispatch\.child-meter"\)\]\?\.library\?\.\(\{ ModelRuntime, compat: __piDispatchCompat, providers: builtinProviderCatalog, meter: __piDispatchUsageMeter \}\);\n$/);
	const moved = patchModelRuntime("export class ModelRuntime {}\n", "file:///u.mjs");
	assert.doesNotMatch(moved, /pi-ai\/compat/, "no import that might not resolve");
	assert.match(moved, /library\?\.\(\{ ModelRuntime: null, compat: null, providers: null, meter: __piDispatchUsageMeter \}\);/);
	assert.equal(USAGE_METER_URL, new URL("../src/usage-meter.mjs", import.meta.url).href);
	assert.equal(Symbol.for("pi-dispatch.child-meter"), CHILD_METER_HANDOFF, "the preload's key is usage-meter.mjs's");
});

test("libraryLoadHook: every other module passes straight through; model-runtime.js is patched; a failure returns pi's own source", () => {
	const seen = [];
	const next = (url) => {
		seen.push(url);
		return { format: "module", source: new TextEncoder().encode('import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";\nexport class ModelRuntime {}\n') };
	};
	const other = libraryLoadHook("file:///app/node_modules/x/index.js", {}, next);
	assert.ok(other.source instanceof Uint8Array, "untouched");
	const url = `file://${ROOT}/dist/core/model-runtime.js`;
	assert.ok(url.endsWith(MODEL_RUNTIME_SUFFIX));
	const patched = libraryLoadHook(url, {}, next);
	assert.match(patched.source, /__piDispatchCompat/);
	assert.deepEqual(libraryLoadHook(url, {}, () => ({ format: "commonjs", source: null })), { format: "commonjs", source: null });
	const broken = { format: "module", get source() { throw new Error("boom"); } };
	assert.equal(libraryLoadHook(url, {}, () => broken), broken);
});

test("preload: nothing without a ledger directory; an entry is injected and stubbed; a subcommand is not; any other process gets the hook", async () => {
	const realpath = fakeRealpath();
	const packageDir = () => ROOT;
	const noHooks = () => assert.fail("no hook may be registered here");
	assert.equal(await preload({ env: {}, argv: ["node", `${ROOT}/dist/cli.js`], global: {}, packageDir, realpath, registerHooks: noHooks }), "none");

	const dir = tempDir("pi-dispatch-preload-");
	const argv = ["node", `${ROOT}/dist/cli.js`, "-p", "hi"];
	const global = {};
	const meter = await import(USAGE_METER_URL);
	assert.equal(await preload({ env: { PI_DISPATCH_CHILD_LEDGER: dir }, argv, pid: 77, global, packageDir, realpath, registerHooks: noHooks, importMeter: async () => meter }), "entry");
	assert.deepEqual(argv.slice(2), ["-e", CHILD_METER_PATH, "-p", "hi"]);
	assert.equal(global[CHILD_METER_HANDOFF].meter, meter, "the meter module is handed over");
	const [stub] = readdirSync(dir);
	assert.match(stub, /^77\.[0-9a-f]{16}\.json$/);
	assert.equal(global[CHILD_METER_HANDOFF].name, stub);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, stub), "utf8")), meter.childLedger({ state: "starting" }));

	const sub = ["node", `${ROOT}/dist/cli.js`, "install", "npm:x"];
	assert.equal(await preload({ env: { PI_DISPATCH_CHILD_LEDGER: dir }, argv: sub, global: {}, packageDir, realpath, registerHooks: noHooks }), "subcommand");
	assert.deepEqual(sub.slice(2), ["install", "npm:x"]);

	const hooks = [];
	const plain = {};
	assert.equal(await preload({ env: { PI_DISPATCH_CHILD_LEDGER: dir }, argv: ["node", "/workspace/script.mjs"], global: plain, packageDir, realpath, registerHooks: (h) => hooks.push(h) }), "library");
	assert.equal(hooks.length, 1);
	assert.equal(hooks[0].load, libraryLoadHook);
	assert.equal(typeof plain[CHILD_METER_HANDOFF].library, "function");
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
	// With the meter module and no class (a model-runtime.js the hook does not recognise): the child is unmetered.
	const meter = await import(USAGE_METER_URL);
	global[CHILD_METER_HANDOFF].library({ ModelRuntime: null, compat: null, providers: null, meter });
	await new Promise((resolve) => setImmediate(resolve));
	const [file] = readdirSync(dir);
	assert.equal(JSON.parse(readFileSync(join(dir, file), "utf8")).metered, false);
});
