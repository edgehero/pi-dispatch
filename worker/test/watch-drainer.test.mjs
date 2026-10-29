import assert from "node:assert/strict";
import { test } from "node:test";
import { makeWatchDrainer } from "../src/watch-drainer.mjs";
const settled = () => new Promise(resolve => setImmediate(resolve));
function setup(runtime, log = () => {}) {
	let tick; let unreferenced = false; let cleared = 0;
	const handle = { unref() { unreferenced = true; } };
	const drainer = makeWatchDrainer({ runtime, log, setInterval: (callback, ms) => { tick = callback; assert.equal(ms, 5000); return handle; }, clearInterval: timer => { assert.equal(timer, handle); cleared++; } });
	return { drainer, tick: () => tick(), unreferenced: () => unreferenced, cleared: () => cleared };
}
test("a source added after empty boot is drained without restarting and shutdown removes the unref timer", async () => {
	const sources = []; const recovered = [];
	const f = setup({ async drain() { for (const source of sources) recovered.push(source); } });
	assert.equal(f.unreferenced(), true); f.tick(); await settled(); assert.deepEqual(recovered, []);
	sources.push("new-reviewed-source"); f.tick(); await settled(); assert.deepEqual(recovered, ["new-reviewed-source"]);
	f.drainer.close(); f.drainer.close(); assert.equal(f.cleared(), 1); f.tick(); await settled(); assert.equal(recovered.length, 1);
});
test("slow drains never overlap and errors log a fixed token without exception text", async () => {
	let calls = 0; let reject; const logs = [];
	const f = setup({ drain() { calls++; return new Promise((_resolve, fail) => { reject = fail; }); } }, (...args) => logs.push(args));
	f.tick(); await settled(); f.tick(); await settled(); assert.equal(calls, 1);
	reject(new Error("private-token-value")); await settled(); assert.deepEqual(logs, [["watch-handoff-unavailable", {}]]);
	f.tick(); await settled(); assert.equal(calls, 2); f.drainer.close(); reject(new Error("private-after-close")); await settled(); assert.equal(logs.length, 1);
});
