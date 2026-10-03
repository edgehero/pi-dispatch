import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
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

const PRELOAD_URL = new URL("../src/child-preload.mjs", import.meta.url).href;
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
		models: [{ id: "m1", name: "m1", api, reasoning: false, input: process.env.FAKE_IMAGES ? ["text", "image"] : ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
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
		NODE_OPTIONS: `--import=${PRELOAD_URL}`,
		PI_DISPATCH_CHILD_LEDGER: ledger,
		FAKE_API: api,
		FAKE_CALLS: calls,
	};
	return { root, agentDir, ledger, provider, calls, env, callCount: () => readFileSync(calls, "utf8").split("\n").filter(Boolean).length };
}

/** Run `node <args>` to its exit, stdin closed unless `drive` takes it. Resolves `{ code, stdout, stderr, pid }`. */
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
			resolve({ code, stdout, stderr, pid: child.pid });
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

test("a pi subcommand gets no injection, and one ledger `done` with zeros for its pid (issue #500)", { skip }, async () => {
	const w = world();
	const result = await run([entry("dist/bundle/cli.js"), "list"], { env: w.env, cwd: w.root });
	// `pi list` with an injected -e in front runs a chat turn instead (measured); untouched it lists nothing and exits 0.
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 0);
	// The ledger is what tells the parent's detector this `pi` process is accounted for (part E).
	const { names, parsed, fold } = ledgers(w.ledger);
	assert.equal(names.length, 1);
	assert.equal(names[0].split(".")[0], String(result.pid));
	assert.equal(parsed[0].raw.state, "done");
	assert.equal(parsed[0].raw.totals.calls, 0);
	assert.equal(fold.unmetered, 0);
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
	const shim = join(w.root, "no-register-hooks.mjs");
	writeFileSync(shim, `import { createRequire, syncBuiltinESMExports } from "node:module";\nconst builtin = createRequire(import.meta.url)("node:module");\ndelete builtin.registerHooks;\nsyncBuiltinESMExports();\n`);
	const env = { ...w.env, NODE_OPTIONS: `--import=${pathToFileURL(shim).href} --import=${PRELOAD_URL}` };
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

test("three children whose ledger dir turns unwritable mid-run: every call that reached the provider is in a ledger, none escapes (issue #500)", { skip }, async () => {
	const w = world();
	for (let child = 0; child < 3; child += 1) {
		// Each child sends one prompt, then the directory becomes unwritable (a full or read-only /tmp behaves the same)
		// and it sends another. The second call's pre-dispatch write fails, so that call is refused before it goes out.
		const drive = rpcDriver(["warm", "escape"], { between: () => chmodSync(w.ledger, 0o500) });
		let result;
		try {
			result = await run([entry("dist/bundle/rpc-entry.js"), "--no-session", "-e", w.provider, "--model", "fake/m1"], { env: w.env, cwd: w.root, drive });
		} finally {
			chmodSync(w.ledger, 0o700);
		}
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, new RegExp(STOP_MESSAGES[TOKEN_BUDGET]));
	}
	const { parsed, fold } = ledgers(w.ledger);
	assert.equal(parsed.length, 3);
	assert.equal(w.callCount(), 3, "only the three warm calls reached the provider");
	assert.equal(fold.totals.calls, w.callCount(), "and the ledgers count every one of them");
	assert.equal(fold.totals.total, 777 * 3);
});

/** A PNG of `size` x `size` grey pixels, built here so the test needs no image file. */
function png(size) {
	const chunk = (type, data) => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const rows = Buffer.alloc(size * (1 + size * 3), 0x80);
	for (let y = 0; y < size; y += 1) rows[y * (1 + size * 3)] = 0;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("a metered pi child that reads an image leaves exactly one ledger, metered: its resize worker is not the bundle rule's (issue #500)", { skip }, async () => {
	const w = world();
	const image = join(w.root, "shot.png");
	writeFileSync(image, png(50));
	const result = await run([entry("dist/bundle/cli.js"), ...printArgs(w), `@${image}`, "describe"], { env: { ...w.env, FAKE_IMAGES: "1" }, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 1);
	assertMetered(w.ledger);
});

/** Run a Node child that uses asynchronous loader hooks, with and without the preload: the same output, rc 0. */
async function sameWithPreload(w, args, { nodeOptions = "" } = {}) {
	const plain = await run(args, { env: { ...w.env, NODE_OPTIONS: nodeOptions }, cwd: w.root });
	const preloaded = await run(args, { env: { ...w.env, NODE_OPTIONS: `${nodeOptions} ${w.env.NODE_OPTIONS}`.trim() }, cwd: w.root });
	assert.equal(plain.code, 0, plain.stderr);
	assert.equal(preloaded.code, 0, preloaded.stderr);
	assert.equal(preloaded.stdout, plain.stdout);
	assert.deepEqual(readdirSync(w.ledger), []);
	return preloaded.stdout;
}

/**
 * An asynchronous loader: answers one virtual specifier, strips the one type annotation of a .ts file, and hands a
 * `.cts` file back as CommonJS with no source, for Node to load (tsx does exactly that; a synchronous LOAD hook of the
 * preload's, even one that only passed through, then failed Node's validation and killed `node --import tsx`).
 */
const LOADER = `export async function resolve(specifier, context, next) {
	if (specifier === "virtual:hello") return { url: "virtual:hello", shortCircuit: true };
	return next(specifier, context);
}
export async function load(url, context, next) {
	if (url === "virtual:hello") return { format: "module", source: "export default 'hello from a loader';", shortCircuit: true };
	if (url.endsWith(".cts")) {
		await next(url, { ...context, format: "commonjs" });
		return { format: "commonjs", source: undefined, shortCircuit: true };
	}
	if (url.endsWith(".ts")) {
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(new URL(url), "utf8").replace(/: string/g, "");
		return { format: "module", source, shortCircuit: true };
	}
	return next(url, context);
}
`;

test("children that use asynchronous loader hooks still run: module.register, --loader, and a tsx-style --import (issue #500)", { skip }, async () => {
	const w = world();
	const loader = join(w.root, "loader.mjs");
	writeFileSync(loader, LOADER);
	// module.register at run time, then an import through it.
	const registers = join(w.root, "registers.mjs");
	writeFileSync(registers, `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(loader).href)});\nconst { default: text } = await import("virtual:hello");\nprocess.stdout.write(text);\n`);
	assert.equal(await sameWithPreload(w, [registers]), "hello from a loader");
	// --loader on the command line.
	const main = join(w.root, "main.mjs");
	writeFileSync(main, `const { default: text } = await import("virtual:hello");\nprocess.stdout.write(text);\n`);
	assert.equal(await sameWithPreload(w, ["--no-warnings", "--loader", pathToFileURL(loader).href, main]), "hello from a loader");
	// tsx's shape: `node --import <a file that calls module.register>` running a .ts file (tsx itself is not a dependency
	// here; the real tsx was run by hand, see the PR).
	const tsxLike = join(w.root, "tsx-like.mjs");
	writeFileSync(tsxLike, `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(loader).href)});\n`);
	const typed = join(w.root, "typed.ts");
	writeFileSync(join(w.root, "legacy.cts"), `module.exports = " and cjs ok";\n`);
	writeFileSync(typed, `const greeting: string = "typed ok";\nconst { default: legacy } = await import("./legacy.cts");\nprocess.stdout.write(greeting + legacy);\n`);
	assert.equal(await sameWithPreload(w, ["--no-warnings", "--experimental-strip-types", typed], { nodeOptions: `--import=${pathToFileURL(tsxLike).href}` }), "typed ok and cjs ok");
});

// ── the nested runner (issue #500 part D) ────────────────────────────────────────────────────────────────

const RUN_JOB = fileURLToPath(new URL("../run-job.mjs", import.meta.url));

/**
 * A probe preload that records every path under /job any fs call of the process names (sync, callback and promise
 * forms, the ES named imports included through syncBuiltinESMExports), appended to JOB_PROBE.
 */
const JOB_PROBE = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const seen = (path) => {
	const text = path instanceof URL ? path.pathname : typeof path === "string" ? path : Buffer.isBuffer(path) ? path.toString() : "";
	if (text === "/job" || text.startsWith("/job/")) fs.appendFileSync(process.env.JOB_PROBE, text + "\\n");
};
const wrap = (owner, name) => {
	const real = owner[name];
	if (typeof real !== "function") return;
	owner[name] = Object.assign(function (path, ...rest) {
		seen(path);
		return real.call(this, path, ...rest);
	}, real);
};
for (const name of ["readFileSync", "existsSync", "statSync", "lstatSync", "accessSync", "openSync", "readdirSync", "realpathSync", "readFile", "stat", "lstat", "access", "open", "readdir", "createReadStream"]) wrap(fs, name);
for (const name of ["readFile", "stat", "lstat", "access", "open", "readdir"]) wrap(fs.promises, name);
syncBuiltinESMExports();
`;

/**
 * One nested runner's world: the pi child world, plus PI_DISPATCH_RUNNER_PID naming another process (this test's, as
 * the job's runner would be its parent) and the /job probe loaded before the preload.
 */
function nestedWorld() {
	const w = world();
	const probe = join(w.root, "job-probe.mjs");
	const jobReads = join(w.root, "job-reads.log");
	writeFileSync(probe, JOB_PROBE);
	writeFileSync(jobReads, "");
	const env = { ...w.env, PI_DISPATCH_RUNNER_PID: String(process.pid), JOB_PROBE: jobReads, NODE_OPTIONS: `--import=${pathToFileURL(probe).href} ${w.env.NODE_OPTIONS}` };
	return { ...w, probe, env, jobReads: () => readFileSync(jobReads, "utf8").split("\n").filter(Boolean) };
}

/** The ledger directories a process made under `root` (its TMPDIR): openChildLedger's prefix. */
const ownLedgerDirs = (root) => readdirSync(root).filter((name) => name.startsWith("pi-dispatch-meter-"));

test("the /job probe sees a read through an ES named import, so an empty probe log means something (issue #500)", { skip }, async () => {
	const w = nestedWorld();
	const result = await run(["--input-type=module", "-e", 'import { existsSync } from "node:fs"; existsSync("/job/prompt.md");'], { env: w.env, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(w.jobReads(), ["/job/prompt.md"]);
});

test("a nested runner runs as the pi CLI: metered once in the INHERITED ledger, no /job read, no exit line, no ledger dir of its own (issue #500)", { skip }, async () => {
	const w = nestedWorld();
	const result = await run([RUN_JOB, ...printArgs(w), "hello"], { env: w.env, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 1, "one call, the CLI's prompt: the job prompt was not run");
	// pi's own JSON events, as the stock subagent example parses them.
	assert.match(result.stdout, /"type":"agent_end"/);
	assert.doesNotMatch(result.stdout, /"event":"exit"/, "a nested runner writes no exit line");
	assert.doesNotMatch(result.stdout, /"event":/, "and none of the runner's log lines");
	assertMetered(w.ledger);
	assert.equal(ledgers(w.ledger).names[0].split(".")[0], String(result.pid), "the one ledger is the nested runner's own");
	assert.deepEqual(w.jobReads(), [], "nothing under /job was read");
	assert.deepEqual(ownLedgerDirs(w.root), [], "no ledger directory of its own");
});

test("a nested runner that makes no call ends its one ledger `done`, as a pi CLI child does: one meter, not the library hook's too (issue #500)", { skip }, async () => {
	const w = nestedWorld();
	// --help loads the extensions (so the meter starts) and exits without a call.
	const result = await run([RUN_JOB, "--help"], { env: w.env, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 0);
	const { parsed, fold } = ledgers(w.ledger);
	assert.equal(parsed.length, 1, `exactly one ledger, got ${JSON.stringify(readdirSync(w.ledger))}`);
	assert.equal(parsed[0].raw.state, "done");
	assert.equal(parsed[0].raw.metered, true);
	assert.equal(parsed[0].raw.totals.calls, 0);
	assert.equal(fold.unmetered, 0);
});

test("a nested runner whose spawner replaced NODE_OPTIONS still loads the meter itself, -e first (issue #500)", { skip }, async () => {
	const w = nestedWorld();
	const result = await run([RUN_JOB, ...printArgs(w), "hello"], { env: { ...w.env, NODE_OPTIONS: "--no-warnings" }, cwd: w.root });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 1);
	assertMetered(w.ledger);
});

test("a nested runner with an open stdin and an inherited PI_EXIT_AUTH drains nothing: an rpc session on that stdin runs (issue #500)", { skip }, async () => {
	const w = nestedWorld();
	// readExitKey would block here until stdin closed, swallowing the prompt below as a key; the driver closes stdin
	// only after agent_end, so a drain is a timeout.
	const result = await run([RUN_JOB, "--mode", "rpc", "--no-session", "-e", w.provider, "--model", "fake/m1"], { env: { ...w.env, PI_EXIT_AUTH: "stdin" }, cwd: w.root, drive: rpcDriver(["hello"]), timeoutMs: 30_000 });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 1);
	assert.doesNotMatch(result.stdout, /"event":"exit"/);
	assertMetered(w.ledger);
});

for (const [label, ledgerEnv] of [["missing", (w) => join(w.root, "gone")], ["unset (the job runner could not make one)", () => undefined]]) {
	test(`a nested runner whose ledger directory is ${label} exits 2 with one stderr line, before pi runs (issue #500)`, { skip }, async () => {
		const w = nestedWorld();
		const env = { ...w.env };
		const dir = ledgerEnv(w);
		if (dir === undefined) delete env.PI_DISPATCH_CHILD_LEDGER;
		else env.PI_DISPATCH_CHILD_LEDGER = dir;
		const result = await run([RUN_JOB, ...printArgs(w), "hello"], { env, cwd: w.root });
		assert.equal(result.code, 2);
		assert.equal(result.stderr.split("\n").filter(Boolean).length, 1, result.stderr);
		assert.match(result.stderr, /nested runner cannot be metered/);
		assert.equal(result.stdout, "");
		assert.equal(w.callCount(), 0);
		assert.deepEqual(w.jobReads(), []);
		assert.deepEqual(ownLedgerDirs(w.root), []);
	});
}

test("a nested runner loaded some other way than `node run-job.mjs` (imported from `node -e`) exits 2 and runs nothing (issue #500)", { skip }, async () => {
	const w = nestedWorld();
	const result = await run(["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(RUN_JOB).href)});`], { env: w.env, cwd: w.root });
	assert.equal(result.code, 2);
	assert.equal(result.stderr.split("\n").filter(Boolean).length, 1, result.stderr);
	assert.match(result.stderr, /\(not-run-job\); exit 2/);
	assert.equal(result.stdout, "");
	assert.equal(w.callCount(), 0);
	assert.deepEqual(readdirSync(w.ledger), []);
	assert.deepEqual(w.jobReads(), []);
});

test("a nested runner whose ledger directory is a link exits 2, and nothing is written through the link (issue #500)", { skip }, async () => {
	const w = nestedWorld();
	const link = join(w.root, "ledger-link");
	symlinkSync(w.ledger, link);
	const result = await run([RUN_JOB, ...printArgs(w), "hello"], { env: { ...w.env, PI_DISPATCH_CHILD_LEDGER: link }, cwd: w.root });
	assert.equal(result.code, 2);
	assert.match(result.stderr, /\(not-a-directory\); exit 2/);
	assert.equal(w.callCount(), 0);
	assert.deepEqual(readdirSync(w.ledger), [], "no orphan `starting` stub");
});
