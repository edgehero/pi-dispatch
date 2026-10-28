import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { CODEMODE_WORKER_HEAP_MIB } from "../src/job-size.mjs";

// Execute the admission section of the installed artifact, not a copy of its logic. It imports no dependencies;
// keeping the real queue functions catches an upstream interpretation change as well as a renamed env read.
let source;
try {
	const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
	source = readFileSync(new URL("./extensions/codemode/execute.js", entry), "utf8");
} catch (error) {
	if (process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw error;
}
const skip = source ? false : "pinned pi artifact not installed; CI requires it";
function admission(env = {}) {
	const start = source.indexOf("const ARGS_PREVIEW_CHARS");
	const end = source.indexOf("const MODEL_TYPES");
	assert.ok(start >= 0 && end > start, "re-verify codemode's admission section at the new pin");
	return runInNewContext(`${source.slice(start, end)}\n({ maxCodemodeWorkers, reserveCodemodeWorker, releaseCodemodeWorker, heap: CODEMODE_MEMORY_LIMIT_BYTES, wait: CODEMODE_WORKER_WAIT_MS })`, { process: { env }, setTimeout, clearTimeout });
}

test("pinned codemode uses the reserved positive-integer env, 256 MiB QuickJS heaps, and a 60-second wait (#693)", { skip }, () => {
	const env = {};
	const pool = admission(env);
	assert.equal(pool.heap, CODEMODE_WORKER_HEAP_MIB * 1024 ** 2);
	assert.equal(pool.wait, 60_000);
	assert.equal(pool.maxCodemodeWorkers(), 2);
	for (const [value, want] of [["1", 1], ["8", 8], ["2048", 2048], ["0", 2], ["-1", 2], ["1.5", 2], ["nope", 2]]) {
		env.PI_CODEMODE_MAX_WORKERS = value;
		assert.equal(pool.maxCodemodeWorkers(), want, value);
	}
	assert.match(source, /memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES/);
	assert.match(source, /Math\.min\(deadline, CODEMODE_WORKER_WAIT_MS\)/);
	assert.match(source, /timeoutMs: Math\.max\(1, Math\.round\(deadline - waitedMs\)\)/);
});

test("pinned codemode queues at the configured ceiling and releases waiters in order (#693)", { skip }, async (t) => {
	const abort = new AbortController();
	t.after(() => abort.abort());
	const pool = admission({ PI_CODEMODE_MAX_WORKERS: "1" });
	assert.equal(await pool.reserveCodemodeWorker(undefined, 60_000), "reserved");
	const order = [];
	const second = pool.reserveCodemodeWorker(abort.signal, 60_000).then((value) => { order.push(2); return value; });
	const third = pool.reserveCodemodeWorker(abort.signal, 60_000).then((value) => { order.push(3); return value; });
	await Promise.resolve();
	assert.deepEqual(order, [], "busy workers wait instead of spawning past the limit");
	pool.releaseCodemodeWorker();
	assert.equal(await second, "reserved");
	assert.deepEqual(order, [2]);
	pool.releaseCodemodeWorker();
	assert.equal(await third, "reserved");
	assert.deepEqual(order, [2, 3]);
	pool.releaseCodemodeWorker();
});
