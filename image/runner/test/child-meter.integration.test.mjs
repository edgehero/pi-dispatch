import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
// Pure: no static pi import in their module graph, so they load unconditionally and the gate below applies to pi only.
import { CHILD_LEDGER_NAME, foldChildLedgers, parseChildLedger, resolvePiAiCompat, spentFile, STOP_MESSAGES, stopFile, writeFileAtomic } from "../src/usage-meter.mjs";
import { TOKEN_BUDGET } from "../src/outcome.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * THE PROOF for issue #500 part C (DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY): a pi CHILD process, started the ways a
 * job starts one, meters its own calls on its own ModelRuntime and reports them through a ledger file the parent's
 * fold reads. Real processes, real pi: the preload goes in through NODE_OPTIONS exactly as run-job.mjs sets it, and
 * the provider is an offline extension that answers every call with the same usage, so a ledger can be compared to it
 * number for number. Nothing is dialled (the baseUrl is port 1) and no credential is read (the key is a literal).
 *
 * Gated like loader.test.mjs: CI sets PI_DISPATCH_REQUIRE_LOADER_TESTS=1, which turns a skip into a failure.
 */
let piIndexUrl;
let importError;
try {
	piIndexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	await import(piIndexUrl);
} catch (error) {
	piIndexUrl = undefined;
	importError = error;
}
const required = process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1";
if (!piIndexUrl && required) {
	throw new Error(`the child-meter proof is REQUIRED here but pi could not be imported -- a skip would hide the gap #500 names.\n${importError}`);
}
const skip = piIndexUrl ? false : `pi not installed (node ${process.version} < 22.19.0); CI runs these`;

const PRELOAD_PATH = fileURLToPath(new URL("../src/child-preload.cjs", import.meta.url));
const PI_ROOT = piIndexUrl ? dirname(dirname(fileURLToPath(piIndexUrl))) : "";
const entry = (path) => join(PI_ROOT, path);

/** The usage every fake call reports. Its cost matches the model's rates (1 USD per million tokens each way). */
const USAGE = { input: 500, output: 277, cacheRead: 0, cacheWrite: 0, totalTokens: 777, cost: { input: 0.0005, output: 0.000277, cacheRead: 0, cacheWrite: 0, total: 0.000777 } };

/**
 * The offline provider, as an extension file. `.ts` so pi's loader transforms it and maps its pi-ai import to the
 * child's own copy wherever the file sits (child-meter.ts has the measurement). Every call is appended to FAKE_CALLS,
 * which is how a test proves a braked or refused call never reached the provider.
 */
const FAKE_PROVIDER = `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
export default function fakeProvider(pi) {
	const api = process.env.FAKE_API;
	pi.registerProvider("fake", {
		baseUrl: "http://127.0.0.1:1",
		apiKey: "pi-dispatch-child-fake-key",
		api,
		models: [{ id: "m1", name: "m1", api, reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
		streamSimple(model) {
			appendFileSync(process.env.FAKE_CALLS, "call\\n");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id, usage: ${JSON.stringify(USAGE)}, stopReason: "stop", timestamp: Date.now() } }));
			return stream;
		},
	});
}
`;

/** One test's world: an agent dir, a ledger dir (0700, as mkdtemp makes it), the provider file and its call log. */
function world({ api = "pi-dispatch-child-fake" } = {}) {
	const root = tempDir("pi-dispatch-child-");
	const agentDir = join(root, "agent");
	const ledger = tempDir("pi-dispatch-meter-");
	const provider = join(root, "fake-provider.ts");
	const calls = join(root, "calls.log");
	writeFileSync(provider, FAKE_PROVIDER);
	writeFileSync(calls, "");
	const env = {
		HOME: root,
		// Each child's own temp directory, inside this test's: pi's jiti cache and Node's compile cache land there and go
		// with it, so the suite's TMPDIR ends empty.
		TMPDIR: root,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		NODE_OPTIONS: `--require=${PRELOAD_PATH}`,
		PI_DISPATCH_CHILD_LEDGER: ledger,
		FAKE_API: api,
		FAKE_CALLS: calls,
	};
	return { root, agentDir, ledger, provider, calls, env, callCount: () => readFileSync(calls, "utf8").split("\n").filter(Boolean).length };
}

/** Run `node <args>` to its exit, stdin closed unless `drive` takes it. Resolves `{ code, stdout, stderr }`. */
function run(args, { env, cwd, drive = null, timeoutMs = 60_000 }) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { env, cwd, stdio: [drive ? "pipe" : "ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`child timed out: ${args.join(" ")}\n${stderr}`));
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			drive?.onStdout(stdout, child);
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
		drive?.start(child);
	});
}

/** The ledger files in `dir`, each parsed by the parent's own parser, plus the parent's fold of them. */
function ledgers(dir) {
	const names = readdirSync(dir).filter((name) => CHILD_LEDGER_NAME.test(name));
	const parsed = names.map((name) => ({ name, raw: JSON.parse(readFileSync(join(dir, name), "utf8")), ledger: parseChildLedger(readFileSync(join(dir, name), "utf8")) }));
	return { names, parsed, fold: foldChildLedgers({ dir }) };
}

/** One child's ledger, done and metered, whose totals and single row are the fake usage `calls` times over. */
function assertMetered(dir, { calls = 1 } = {}) {
	const { names, parsed, fold } = ledgers(dir);
	assert.equal(names.length, 1, `exactly one ledger file, got ${JSON.stringify(readdirSync(dir))}`);
	const [{ raw, ledger }] = parsed;
	assert.ok(ledger, "the parent's parser accepts the child's ledger whole");
	assert.equal(raw.state, "done");
	assert.equal(raw.metered, true);
	assert.deepEqual(raw.totals, { input: 500 * calls, output: 277 * calls, total: 777 * calls, cost: raw.totals.cost, calls, unresolved: 0, unpriced: 0, sessions: raw.totals.sessions });
	assert.ok(Math.abs(raw.totals.cost - 0.000777 * calls) < 1e-12, `cost ${raw.totals.cost}`);
	assert.equal(raw.rows.length, 1);
	assert.equal(raw.rows[0].provider, "fake");
	assert.equal(raw.rows[0].model, "m1");
	assert.equal(raw.rows[0].calls, calls);
	assert.equal(raw.rows[0].total, 777 * calls);
	assert.equal(fold.processes, 1);
	assert.equal(fold.unmetered, 0);
	assert.equal(fold.totals.total, 777 * calls);
	return raw;
}

const printArgs = (w, ...extra) => ["--mode", "json", "-p", "--no-session", ...extra, "-e", w.provider, "--model", "fake/m1"];

for (const [label, path] of [["the bundle (the package bin)", "dist/bundle/cli.js"], ["dist/cli.js", "dist/cli.js"]]) {
	test(`a pi child started from ${label} leaves a ledger equal to its usage (issue #500)`, { skip }, async () => {
		const w = world();
		const result = await run([entry(path), ...printArgs(w), "hello"], { env: w.env, cwd: w.root });
		assert.equal(result.code, 0, result.stderr);
		assert.equal(w.callCount(), 1);
		assertMetered(w.ledger);
	});
}

test("-ne keeps the injected meter: the child is metered (issue #500)", { skip }, async () => {
	const w = world();
	const result = await run([entry("dist/bundle/cli.js"), ...printArgs(w, "-ne"), "hello"], { env: w.env, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	assertMetered(w.ledger);
});

test("a message after `--` stays a message and the child is metered: the meter goes in front, never at the end (issue #500)", { skip }, async () => {
	const w = world();
	const result = await run([entry("dist/bundle/cli.js"), ...printArgs(w), "--", "hello"], { env: w.env, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	// One call: an -e appended after "--" would have been two more prompts (measured), each a paid call.
	assert.equal(w.callCount(), 1);
	assertMetered(w.ledger);
});

/** Drive an rpc child: one prompt per entry of `before`, each sent after the previous agent_end; then close stdin. */
function rpcDriver(prompts, { between = () => {} } = {}) {
	let sent = 0;
	let ends = 0;
	const send = (child) => child.stdin.write(`${JSON.stringify({ id: `p${sent}`, type: "prompt", message: prompts[sent] })}\n`) && (sent += 1);
	return {
		start: (child) => send(child),
		onStdout: (stdout, child) => {
			const seen = stdout.split("\n").filter((line) => line.includes('"type":"agent_end"')).length;
			if (seen === ends) return;
			ends = seen;
			if (sent < prompts.length) {
				between(sent);
				send(child);
			} else child.stdin.end();
		},
	};
}

test("a pi child started from the rpc entry (dist/rpc-entry.js) leaves a ledger equal to its usage (issue #500)", { skip }, async () => {
	const w = world();
	const result = await run([entry("dist/rpc-entry.js"), "--no-session", "-e", w.provider, "--model", "fake/m1"], { env: w.env, cwd: w.root, drive: rpcDriver(["hello"]) });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 1);
	assertMetered(w.ledger);
});

test("a STOP the parent writes brakes the child's NEXT call, in the bundle's rpc entry (issue #500)", { skip }, async () => {
	const w = world();
	const drive = rpcDriver(["one", "two"], { between: () => writeFileAtomic({ dir: w.ledger, name: "STOP", text: JSON.stringify(stopFile(TOKEN_BUDGET)) }) });
	const result = await run([entry("dist/bundle/rpc-entry.js"), "--no-session", "-e", w.provider, "--model", "fake/m1"], { env: w.env, cwd: w.root, drive });
	assert.equal(result.code, 0, result.stderr);
	// The first call reached the provider; the second was answered by the brake and never did.
	assert.equal(w.callCount(), 1);
	assert.match(result.stdout, new RegExp(STOP_MESSAGES[TOKEN_BUDGET]));
	assertMetered(w.ledger, { calls: 1 });
});

test("a pi subcommand gets no injection and leaves no ledger (issue #500)", { skip }, async () => {
	const w = world();
	const result = await run([entry("dist/bundle/cli.js"), "list"], { env: w.env, cwd: w.root });
	// `pi list` with an injected -e in front runs a chat turn instead (measured); untouched it lists nothing and exits 0.
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 0);
	assert.deepEqual(readdirSync(w.ledger), []);
});

test("an off-list model is refused in the child, with modelRefused 1 in its ledger (issue #500)", { skip }, async () => {
	const w = world();
	const result = await run([entry("dist/bundle/cli.js"), ...printArgs(w), "hello"], { env: { ...w.env, PI_ALLOWED_MODELS: "fake/other" }, cwd: w.root });
	assert.equal(w.callCount(), 0, "the refused call never reached the provider");
	assert.match(result.stdout, new RegExp(STOP_MESSAGES["model-not-allowed"]));
	const { parsed } = ledgers(w.ledger);
	assert.equal(parsed.length, 1);
	assert.ok(parsed[0].ledger, "the ledger is well formed");
	assert.equal(parsed[0].raw.metered, true);
	assert.equal(parsed[0].raw.modelRefused, 1);
	assert.equal(parsed[0].raw.totals.total, 0);
});

test("a SPENT that leaves no room under the child's cost cap refuses its call; with room it passes (issue #500)", { skip }, async () => {
	// A priced api, so the guard has a finite bound to judge (an unpriced one is refused at any cap).
	const roomy = world({ api: "openai-completions" });
	const capped = { PI_MAX_COST_MICROS: "1000000" };
	const ok = await run([entry("dist/bundle/cli.js"), ...printArgs(roomy), "hello"], { env: { ...roomy.env, ...capped }, cwd: roomy.root });
	assert.equal(ok.code, 0, ok.stderr);
	assert.equal(roomy.callCount(), 1, "with no SPENT the call fits the cap");
	const okLedger = assertMetered(roomy.ledger);
	assert.equal(okLedger.spentMicros, 777);
	assert.equal(okLedger.costRefused, 0);

	const tight = world({ api: "openai-completions" });
	// The rest of the job has spent all but one micro-dollar.
	writeFileAtomic({ dir: tight.ledger, name: "SPENT", text: JSON.stringify(spentFile(null, 999_999)) });
	const refused = await run([entry("dist/bundle/cli.js"), ...printArgs(tight), "hello"], { env: { ...tight.env, ...capped }, cwd: tight.root });
	assert.equal(tight.callCount(), 0, "the refused call never reached the provider");
	assert.match(refused.stdout, new RegExp(STOP_MESSAGES["cost-cap"]));
	const { parsed } = ledgers(tight.ledger);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].raw.costRefused, 1);
	assert.equal(parsed[0].raw.totals.total, 0);
});

test("a child whose spawner cleared the environment leaves no ledger file (issue #500)", { skip }, async () => {
	const w = world();
	// What `env: {}` costs the preload: no NODE_OPTIONS and no ledger variable. Only what pi needs to run offline here.
	const env = { HOME: w.root, PI_CODING_AGENT_DIR: w.agentDir, PI_OFFLINE: "1", FAKE_API: w.env.FAKE_API, FAKE_CALLS: w.calls };
	const result = await run([entry("dist/bundle/cli.js"), ...printArgs(w), "hello"], { env, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 1, "the child ran and spent");
	assert.deepEqual(readdirSync(w.ledger), [], "and reported nothing: the parent's detector is what sees it");
});

test("a plain node child gets no injection, starts normally and leaves no ledger (issue #500)", { skip }, async () => {
	const w = world();
	const result = await run(["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "a", "--", "b"], { env: w.env, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), ["a", "--", "b"]);
	assert.deepEqual(readdirSync(w.ledger), []);
});

/** A Node script that runs pi as a LIBRARY (pi-subagents' background runner does): its own runtime, one call. */
function libraryScript(w, { from = piIndexUrl, calls = 1 } = {}) {
	const modelsPath = join(w.root, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ providers: { fake: { apiKey: "pi-dispatch-child-fake-key", baseUrl: "http://127.0.0.1:1", api: w.env.FAKE_API, models: [{ id: "m1", name: "m1", api: w.env.FAKE_API, reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] } } }));
	const script = join(w.root, "library-child.mjs");
	writeFileSync(script, `import { appendFileSync } from "node:fs";
const pi = await import(${JSON.stringify(from)});
const compat = await import(${JSON.stringify(resolvePiAiCompat()[0].url)});
const runtime = await pi.ModelRuntime.create({ authPath: ${JSON.stringify(join(w.agentDir, "auth.json"))}, modelsPath: ${JSON.stringify(modelsPath)}, allowModelNetwork: false });
runtime.registerProvider("fake", {
	api: ${JSON.stringify(w.env.FAKE_API)},
	streamSimple(model) {
		appendFileSync(process.env.FAKE_CALLS, "call\\n");
		const stream = compat.createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id, usage: ${JSON.stringify(USAGE)}, stopReason: "stop", timestamp: Date.now() } }));
		return stream;
	},
});
await runtime.refresh({ allowNetwork: false });
let stopReason = null;
for (let i = 0; i < ${calls}; i += 1) stopReason = (await runtime.streamSimple(runtime.getModel("fake", "m1"), { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { sessionId: "library-1", maxRetries: 0 }).result()).stopReason;
process.stdout.write(JSON.stringify({ stopReason }));
`);
	return script;
}

test("a Node child that runs pi as a library is metered through the preload's load hook (issue #500)", { skip }, async () => {
	const w = world();
	const result = await run([libraryScript(w)], { env: w.env, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { stopReason: "stop" });
	assert.equal(w.callCount(), 1);
	assertMetered(w.ledger);
});

test("the preload on a Node without module.registerHooks does not throw: a library child runs, unmetered (issue #500)", { skip }, async () => {
	const w = world();
	// Simulated: a first preload removes registerHooks from node:module before ours reads it.
	const shim = join(w.root, "no-register-hooks.cjs");
	writeFileSync(shim, `const builtin = require("node:module");\ndelete builtin.registerHooks;\nbuiltin.syncBuiltinESMExports();\n`);
	const env = { ...w.env, NODE_OPTIONS: `--require=${shim} --require=${PRELOAD_PATH}` };
	const probe = await run(["--input-type=module", "-e", "import * as m from 'node:module'; process.stdout.write(typeof m.registerHooks)"], { env, cwd: w.root });
	assert.equal(probe.stdout, "undefined", "the shim must hide registerHooks, or this test proves nothing");
	const result = await run([libraryScript(w)], { env, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 1);
	assert.deepEqual(readdirSync(w.ledger), [], "no hook, so no ledger: the parent's detector is what sees this child");
});

test("a pi child started from the bundle's cli-runtime.js (what the bin loads) is metered too (issue #500)", { skip }, async () => {
	const w = world();
	const result = await run([entry("dist/bundle/cli-runtime.js"), ...printArgs(w), "hello"], { env: w.env, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 1);
	assertMetered(w.ledger);
});

test("`pi --version` exits before the meter can start, and its ledger ends done with zeros, never `starting` (issue #500)", { skip }, async () => {
	const w = world();
	const result = await run([entry("dist/bundle/cli.js"), "--version"], { env: w.env, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	const { parsed, fold } = ledgers(w.ledger);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].raw.state, "done");
	assert.equal(parsed[0].raw.metered, true);
	assert.equal(parsed[0].raw.totals.calls, 0);
	assert.equal(fold.unmetered, 0);
});

test("a library child that only imports pi and never calls leaves no ledger at all (issue #500)", { skip }, async () => {
	const w = world();
	const result = await run([libraryScript(w, { calls: 0 })], { env: w.env, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(readdirSync(w.ledger), [], "a test suite that imports pi hundreds of times cannot flood the directory");
});

test("model-runtime.js imported with a query string is still metered: the hook matches the path (issue #500)", { skip }, async () => {
	const w = world();
	const result = await run([libraryScript(w, { from: `${new URL("./core/model-runtime.js", piIndexUrl).href}?x=1` })], { env: w.env, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 1);
	assertMetered(w.ledger);
});

test("a process that loads the pinned bundle by path (no -e reached it) records itself unmetered (issue #500)", { skip }, async () => {
	const w = world();
	const result = await run([libraryScript(w, { from: pathToFileURL(entry("dist/bundle/index.js")).href })], { env: w.env, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 1, "the call ran: the bundle's own class is out of the hook's reach");
	const { parsed, fold } = ledgers(w.ledger);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].raw.metered, false);
	assert.equal(fold.unmetered, 1, "the parent counts it unmetered, the floor");
});

test("a foreign pi copy whose pi-ai has no ./compat is not patched with an import that cannot link: it runs, unmetered (issue #500)", { skip }, async () => {
	const w = world();
	const modules = join(w.root, "app", "node_modules", "@earendil-works");
	const agent = join(modules, "pi-coding-agent");
	const ai = join(modules, "pi-ai");
	mkdirSync(join(agent, "dist", "core"), { recursive: true });
	mkdirSync(ai, { recursive: true });
	writeFileSync(join(agent, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", exports: { ".": "./dist/core/model-runtime.js" } }));
	writeFileSync(join(agent, "dist", "core", "model-runtime.js"), 'import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";\nexport class ModelRuntime {\n}\nexport const seen = typeof builtinProviderCatalog;\n');
	writeFileSync(join(ai, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", type: "module", exports: { "./providers/all": "./all.js" } }));
	writeFileSync(join(ai, "all.js"), "export const builtinModels = () => null;\n");
	const app = join(w.root, "app", "app.mjs");
	writeFileSync(app, 'import { seen } from "@earendil-works/pi-coding-agent";\nprocess.stdout.write(`hi ${seen}`);\n');
	const result = await run([app], { env: w.env, cwd: join(w.root, "app") });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stdout, "hi object");
	const { parsed } = ledgers(w.ledger);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].raw.metered, false);
});

test("a child whose ledger can no longer be written is stopped: the call after the failed write never reaches the provider (issue #500)", { skip }, async () => {
	const w = world();
	const drive = rpcDriver(["one", "two", "three"], { between: (sent) => {
		// After the first answer the directory becomes unwritable (a full or read-only /tmp behaves the same).
		if (sent === 1) chmodSync(w.ledger, 0o500);
	} });
	let result;
	try {
		result = await run([entry("dist/bundle/rpc-entry.js"), "--no-session", "-e", w.provider, "--model", "fake/m1"], { env: w.env, cwd: w.root, drive });
	} finally {
		chmodSync(w.ledger, 0o700);
	}
	assert.equal(result.code, 0, result.stderr);
	// Call two went out and its write failed (the ledger cannot be updated before a call, only when it is seen); call
	// three was braked. Before this fix all three went out under a ledger that said one call and metered.
	assert.equal(w.callCount(), 2);
	assert.match(result.stdout, new RegExp(STOP_MESSAGES[TOKEN_BUDGET]));
	const { parsed } = ledgers(w.ledger);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].raw.totals.calls, 1, "the last write that succeeded");
});
