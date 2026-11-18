import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { makeConsumerSupervisor, makeConsumerFailureShutdown } from "../src/consumer-supervision.mjs";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turn = () => new Promise((r) => setImmediate(r));
function fixture() {
	let at = 1000;
	const failures = [];
	const supervisor = makeConsumerSupervisor({ now: () => at, monotonic: () => at, onFatal: (f) => failures.push(f) });
	const make = (role = "shared") => {
		const loop = deferred();
		const client = () => Object.assign(new EventEmitter(), { status: "ready" });
		const w = {
			connection: { _client: client() }, blockingConnection: { _client: client() },
			paused: false, isPaused() { return this.paused; }, isRateLimited: () => false,
			run: () => loop.promise, close: async () => loop.resolve(), pause() { this.paused = true; },
			_getNextJob: async () => null, moveToActive: async () => null, waitForJob: async () => 0,
			processFn: async (job, token, signal) => ({ job, token, signal }),
		};
		supervisor.attach(w, role);
		return { w, loop };
	};
	return { supervisor, failures, make, advance: (ms) => { at += ms; }, snapshot: () => JSON.parse(supervisor.snapshot(1000)).rows };
}

test("all three consumer roles fail on either terminal connection, never on a recoverable close", async () => {
	for (const role of ["shared", "host", "sandbox"]) for (const which of ["connection", "blockingConnection"]) {
		const f = fixture(), { w } = f.make(role);
		await turn();
		const c = w[which]._client;
		c.status = "reconnecting"; c.emit("close"); c.emit("reconnecting");
		await turn();
		assert.deepEqual(f.failures, []);
		assert.equal(f.snapshot()[0].connection, "reconnecting");
		c.status = "ready"; c.emit("ready");
		assert.equal(f.snapshot()[0].connection, "ready");
		c.status = "end"; c.emit("end");
		await turn();
		assert.deepEqual(f.failures, [{ role, reason: "connection-ended" }]);
		c.emit("end"); await w.close(); await turn();
		assert.equal(f.failures.length, 1);
	}
});

test("unexpected loop return and rejection fail; pause, stop and direct close are expected", async () => {
	for (const action of ["return", "reject", "pause", "stop", "close"]) {
		const f = fixture(), { w, loop } = f.make();
		await turn();
		if (action === "pause") w.pause();
		if (action === "stop") f.supervisor.stop();
		if (action === "close") await w.close();
		if (action === "reject") loop.reject(new Error("private error")); else loop.resolve();
		await turn();
		assert.equal(f.failures.length, ["return", "reject"].includes(action) ? 1 : 0, action);
	}
});

test("fetch success is distinct from attempts, and processing includes the whole preflight with signal intact", async () => {
	const f = fixture();
	const { w } = f.make();
	await w._getNextJob();
	assert.equal(f.snapshot()[0].lastSuccessAt, null);
	await w.moveToActive();
	f.advance(250);
	assert.equal(f.snapshot()[0].successAgeMs, 250);
	const signal = new AbortController().signal;
	const pending = w.processFn("job", "token", signal);
	assert.equal(f.snapshot()[0].active, 1);
	assert.deepEqual(await pending, { job: "job", token: "token", signal });
	assert.equal(f.snapshot()[0].active, 0);
	assert.equal(f.snapshot()[0].lastTakenAt, 1250);
	await w.close();
});

test("failure shutdown starts once and exits infra even when cleanup never settles", async () => {
	let fire, stopped = 0;
	const exits = [], logs = [];
	const shutdown = makeConsumerFailureShutdown({ stop: () => { stopped++; return new Promise(() => {}); }, exit: (c) => exits.push(c), log: (...x) => logs.push(x), setTimeoutFn: (fn) => { fire = fn; return 1; }, clearTimeoutFn: () => {}, timeoutMs: 7 });
	const first = shutdown({ role: "shared", reason: "loop-ended" });
	assert.equal(shutdown({ role: "host", reason: "connection-ended" }), first);
	await turn(); fire(); await first;
	assert.equal(stopped, 1);
	assert.deepEqual(exits, [1]);
	assert.deepEqual(logs[1], ["consumer_shutdown_timeout", { ms: 7 }]);
});

test("the observation adapter follows the pinned artifact's real consumer and connection path", () => {
	const root = dirname(createRequire(import.meta.url).resolve("bullmq/package.json"));
	const worker = readFileSync(join(root, "dist/esm/classes/worker.js"), "utf8");
	for (const text of ["this._getNextJob(client, bclient, token, { block: true })", "this.processFn = processor;", "this.processorAcceptsSignal = processor.length >= 3;", "this.processFn(job, token, signal)", "return Infinity;", "this.running = false;", "async moveToActive(client, token, name)", "async waitForJob(bclient, blockUntil)"]) assert.ok(worker.includes(text), text);
	const connection = readFileSync(join(root, "dist/esm/classes/redis-connection.js"), "utf8");
	assert.ok(connection.indexOf("this._client = createIORedisClient(ioredisClient)") < connection.indexOf("await RedisConnection.waitUntilReady(this._client)"));
	const adapter = readFileSync(join(root, "dist/esm/classes/ioredis-client.js"), "utf8");
	assert.ok(adapter.includes("Reflect.get(target, prop, target)"));
});


test("a loop restarted after local pause remains supervised", async () => {
	const f = fixture(), { w, loop } = f.make();
	await turn();
	w.pause(); loop.resolve(); await turn();
	assert.deepEqual(f.failures, []);
	w.paused = false;
	await w.run(); await turn();
	assert.deepEqual(f.failures, [{ role: "shared", reason: "loop-ended" }]);
});
