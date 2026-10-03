import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// Pure: no static pi import in their module graph, so they load unconditionally and the gate below applies to pi only.
import { createChildWatch, linuxProc } from "../src/child-watch.mjs";
import { COST_CAP, TOKEN_BUDGET } from "../src/outcome.mjs";
import { CHILD_LEDGER_NAME, createUsageMeter, STOP_MESSAGES } from "../src/usage-meter.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #500 part E, with REAL pi children: the parent's hook (child-watch.mjs) folds what a pi child's own meter
 * writes, its STOP brakes that child's next call, and on Linux its detector finds a pi child that reports through no
 * ledger at all. The parent here is this test process with a meter and the hook, ticked by hand between the child's
 * prompts; the child is pi's bundle rpc entry, started with the preload in NODE_OPTIONS exactly as run-job.mjs sets it,
 * on an offline provider (the baseUrl is port 1, the key a literal).
 *
 * Gated like loader.test.mjs (CI sets PI_DISPATCH_REQUIRE_LOADER_TESTS=1, which turns a skip into a failure). The
 * detector tests also need /proc, so they run on Linux only (CI's runners; a macOS laptop runs them in the image).
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
if (!piIndexUrl && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") {
	throw new Error(`the parent-fold proof is REQUIRED here but pi could not be imported -- a skip would hide the gap #500 names.\n${importError}`);
}
const skip = piIndexUrl ? false : `pi not installed (node ${process.version} < 22.19.0); CI runs these`;
const linuxOnly = skip || (process.platform === "linux" ? false : "the detector reads /proc: Linux only");

const PRELOAD_URL = new URL("../src/child-preload.mjs", import.meta.url).href;
const RPC_ENTRY = piIndexUrl ? join(dirname(dirname(fileURLToPath(piIndexUrl))), "dist", "bundle", "rpc-entry.js") : "";
const USAGE = { input: 500, output: 277, cacheRead: 0, cacheWrite: 0, totalTokens: 777, cost: { input: 0.0005, output: 0.000277, cacheRead: 0, cacheWrite: 0, total: 0.000777 } };

/** The offline provider as an extension file; every call that reaches it is appended to FAKE_CALLS. */
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

function world({ api = "pi-dispatch-child-fake" } = {}) {
	const root = tempDir("pi-dispatch-watch-it-");
	const ledger = tempDir("pi-dispatch-meter-");
	const provider = join(root, "fake-provider.ts");
	const calls = join(root, "calls.log");
	writeFileSync(provider, FAKE_PROVIDER);
	writeFileSync(calls, "");
	const env = {
		HOME: root,
		TMPDIR: root,
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_OFFLINE: "1",
		NODE_OPTIONS: `--import=${PRELOAD_URL}`,
		PI_DISPATCH_CHILD_LEDGER: ledger,
		FAKE_API: api,
		FAKE_CALLS: calls,
	};
	return { root, ledger, provider, env, callCount: () => readFileSync(calls, "utf8").split("\n").filter(Boolean).length };
}

/**
 * Start an rpc child and drive it: one prompt per entry of `prompts`, each sent after the previous agent_end, with
 * `between(index)` run (and awaited) before each later prompt; stdin closed after the last. Resolves at its exit.
 */
function rpcChild(w, { env = w.env, prompts, between = async () => {}, onSpawn = () => {} }) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [RPC_ENTRY, "--no-session", "-e", w.provider, "--model", "fake/m1"], { env, cwd: w.root, stdio: ["pipe", "pipe", "pipe"] });
		onSpawn(child);
		let stdout = "";
		let stderr = "";
		let sent = 0;
		let ends = 0;
		const send = () => child.stdin.write(`${JSON.stringify({ id: `p${sent}`, type: "prompt", message: prompts[sent] })}\n`) && (sent += 1);
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`child timed out\n${stderr}`));
		}, 60_000);
		child.stdout.on("data", async (chunk) => {
			stdout += chunk;
			const seen = stdout.split("\n").filter((line) => line.includes('"type":"agent_end"')).length;
			if (seen === ends) return;
			ends = seen;
			if (sent < prompts.length) {
				await between(sent);
				send();
			} else child.stdin.end();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, pid: child.pid });
		});
		if (prompts.length > 0) send();
	});
}

const stopOf = (dir) => JSON.parse(readFileSync(join(dir, "STOP"), "utf8"));
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a parent plus a pi child pushed over maxTokens: STOP is written and the child's next call is braked (issue #500)", { skip }, async () => {
	const w = world();
	const meter = createUsageMeter({ maxTokens: 1000, rootSessionId: "root" });
	const hook = createChildWatch({ dir: w.ledger, meter, proc: null });
	// The parent's own 300 tokens; the child's first call (777) takes the job past 1000.
	meter.record({ input: 300, output: 0, totalTokens: 300, cost: { total: 0.0003 } }, { sessionId: "root", provider: "fake", modelId: "m1" });
	const result = await rpcChild(w, { prompts: ["one", "two"], between: () => hook.sample() });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(meter.state.stopReason, TOKEN_BUDGET);
	assert.deepEqual(stopOf(w.ledger), { v: 1, reason: TOKEN_BUDGET });
	assert.equal(w.callCount(), 1, "the second call never reached the provider");
	assert.match(result.stdout, new RegExp(STOP_MESSAGES[TOKEN_BUDGET]), "the child answered it with the brake");
	hook.teardown();
	const snap = meter.snapshot();
	assert.deepEqual([snap.total, snap.childTotal, snap.childProcesses, snap.unmeteredChildren], [1077, 777, 1, 0]);
	assert.equal(snap.rootTotal + snap.otherTotal + snap.looseTotal + snap.childTotal, snap.total);
});

test("the same under a dollar cap: the child judges against SPENT, the parent stops cost-cap and the child is braked (issue #500)", { skip }, async () => {
	// A priced api, so the child's guard has a finite bound to judge.
	const w = world({ api: "openai-completions" });
	const cap = 1_000_000;
	const meter = createUsageMeter({ maxTokens: null, maxCostMicros: cap, rootSessionId: "root" });
	let own = { spentMicros: 900_000, inflightMicros: 0 };
	const hook = createChildWatch({ dir: w.ledger, meter, guard: () => ({ spend: () => own }), proc: null });
	hook.sample();
	assert.deepEqual(JSON.parse(readFileSync(join(w.ledger, "SPENT"), "utf8")), { v: 1, total: 900_000, byLedger: {} });
	let spent;
	const result = await rpcChild(w, {
		env: { ...w.env, PI_MAX_COST_MICROS: String(cap) },
		prompts: ["one", "two"],
		between: () => {
			// The parent spent 99,500 more meanwhile: 999,500 plus the child's 777 passes the cap.
			own = { spentMicros: 999_500, inflightMicros: 0 };
			hook.sample();
			spent = JSON.parse(readFileSync(join(w.ledger, "SPENT"), "utf8"));
		},
	});
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 1, "the child's first call fit under SPENT; its second was braked");
	assert.equal(meter.state.stopReason, COST_CAP);
	assert.deepEqual(stopOf(w.ledger), { v: 1, reason: COST_CAP });
	assert.match(result.stdout, new RegExp(STOP_MESSAGES[COST_CAP]));
	const [name] = readdirSync(w.ledger).filter((file) => CHILD_LEDGER_NAME.test(file));
	assert.deepEqual(spent, { v: 1, total: 999_500 + 777, byLedger: { [name]: 777 } }, "SPENT carries each ledger's part");
	hook.teardown();
	assert.equal(meter.snapshot().childTotal, 777);
});

/**
 * The detector on the real /proc, narrowed to the children this test started: `node --test` runs files in parallel,
 * and another file's pi children are not this parent's. In a job the scan is the whole container.
 */
function ownProc(pids) {
	const real = linuxProc();
	return { scan: () => real.scan().filter((pid) => pids.has(pid)), alive: (pid) => real.alive(pid) };
}

/** A pi child that reports through no ledger: its spawner cleared the environment (no preload, no ledger variable). */
async function unmeteredChild({ maxTokens }) {
	const w = world();
	const pids = new Set();
	const meter = createUsageMeter({ maxTokens, rootSessionId: "root" });
	const logged = [];
	const hook = createChildWatch({ dir: w.ledger, meter, proc: ownProc(pids), log: (event, fields) => logged.push({ event, fields }) });
	const env = { HOME: w.root, TMPDIR: w.root, PI_CODING_AGENT_DIR: w.env.PI_CODING_AGENT_DIR, PI_OFFLINE: "1", FAKE_API: w.env.FAKE_API, FAKE_CALLS: w.env.FAKE_CALLS };
	let child;
	const done = rpcChild(w, { env, prompts: [], onSpawn: (spawned) => {
		child = spawned;
		pids.add(spawned.pid);
	} });
	// The child waits on its stdin; three ticks a little apart, the way the meter's interval runs them.
	for (let tick = 0; tick < 3; tick += 1) {
		await settle(200);
		hook.sample();
	}
	child.stdin.end();
	const result = await done;
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(readdirSync(w.ledger).filter((file) => CHILD_LEDGER_NAME.test(file)), [], "it wrote no ledger");
	return { meter, logged, teardown: hook.teardown(), pid: result.pid };
}

test("a pi child whose spawner cleared the environment (`env: {}`) is unmetered, and under a token cap it is a breach (issue #500)", { skip: linuxOnly }, async () => {
	const { meter, logged, teardown, pid } = await unmeteredChild({ maxTokens: 1_000_000 });
	assert.equal(meter.state.stopReason, TOKEN_BUDGET);
	assert.equal(meter.snapshot().unmeteredChildren, 1);
	assert.deepEqual(logged.filter((line) => line.event === "unmetered_child"), [{ event: "unmetered_child", fields: { why: "no-ledger", pid, unmetered: 1 } }]);
	assert.deepEqual(teardown, { distinct: 1, peak: 1, unmetered: 1 });
});

test("an uncapped job does not stop on an unmetered pi child, and records it as a floor (issue #500)", { skip: linuxOnly }, async () => {
	const { meter, teardown } = await unmeteredChild({ maxTokens: null });
	assert.equal(meter.state.stopReason, null);
	assert.equal(meter.snapshot().unmeteredChildren, 1);
	assert.equal(teardown.unmetered, 1);
});

test("a metered pi child seen on every tick is never counted unmetered (issue #500)", { skip: linuxOnly }, async () => {
	const w = world();
	const pids = new Set();
	const meter = createUsageMeter({ maxTokens: 1_000_000, rootSessionId: "root" });
	const hook = createChildWatch({ dir: w.ledger, meter, proc: ownProc(pids) });
	const result = await rpcChild(w, {
		prompts: ["one", "two"],
		onSpawn: (child) => pids.add(child.pid),
		between: async () => {
			for (let tick = 0; tick < 3; tick += 1) {
				await settle(100);
				hook.sample();
			}
		},
	});
	assert.equal(result.code, 0, result.stderr);
	assert.equal(w.callCount(), 2);
	const teardown = hook.teardown();
	assert.deepEqual(teardown, { distinct: 1, peak: 1, unmetered: 0 });
	assert.equal(meter.state.stopReason, null);
	assert.deepEqual([meter.snapshot().childTotal, meter.snapshot().childProcesses], [1554, 1]);
	assert.equal(existsSync(w.ledger), false, "removed after the final fold");
});
