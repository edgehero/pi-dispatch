import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { parseSandboxSession, readSandboxSessions, renewSandboxSession, requestSandboxEnd, sandboxEndKey, sandboxSessionKey, sandboxSessionMember, sandboxSessionTick, SANDBOX_SESSION_TTL_MS } from "../src/sandbox-sessions.mjs";
import { inspectSandboxSession, makeSandboxMonitor, runSandboxSessionMonitor, watchSandboxSession } from "../src/sandbox-session-watch.mjs";

const at = 1_800_000_000_000;
const session = { v: 1, host: "mini1", id: "repeat:build:123", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "podman", by: "ops", since: at - 5000, at };
function store(over = {}) {
	const calls = [];
	return { calls, time: async () => [String(at / 1000), "0"], eval: async (...v) => (calls.push(["eval", ...v]), 1), zadd: async (...v) => calls.push(["zadd", ...v]), zremrangebyscore: async (...v) => calls.push(["prune", ...v]), get: async () => null, set: async (...v) => calls.push(["set", ...v]), del: async (...v) => calls.push(["del", ...v]), ...over };
}

test("session parser projects a private bounded record and rejects malformed identities and instants", () => {
	assert.deepEqual(parseSandboxSession({ ...session, token: "must disappear", input: "not retained" }), session);
	for (const bad of [{ host: "-oops" }, { host: 1 }, { id: "../bad" }, { id: "x\n" }, { nonce: "short" }, { containerId: "name-reused" }, { venue: "openshell" }, { by: "user\nsecret" }, { since: at + 1 }, { at: Infinity }]) assert.equal(parseSandboxSession({ ...session, ...bad }), null);
});

test("renew writes an expiring incarnation and prunes crashed index entries, refusing a replaced lease", async () => {
	const redis = store();
	assert.equal(await renewSandboxSession(redis, session, { now: () => at + 1000 }), true);
	assert.equal(redis.calls[0][3], sandboxSessionKey(session.host, session.id));
	assert.match(redis.calls[0][7], /"at":1800000001000/);
	assert.equal(redis.calls[0][8], String(SANDBOX_SESSION_TTL_MS));
	assert.equal(await renewSandboxSession(store({ eval: async () => 0 }), session, { now: () => at }), false);
});

test("private reads distinguish malformed, expired, truncated and unreachable observations", async () => {
	const member = sandboxSessionMember(session.host, session.id);
	const redis = { time: async () => [String(at / 1000), "0"], zrangebyscore: async () => [member], mget: async () => [JSON.stringify(session)] };
	assert.equal((await readSandboxSessions(redis, { now: () => at })).sessions[0].id, session.id);
	assert.equal((await readSandboxSessions(redis, { now: () => at + SANDBOX_SESSION_TTL_MS + 1 })).sessions.length, 1, "console clock skew does not expire a live Valkey key");
	assert.equal((await readSandboxSessions({ ...redis, mget: async () => [null] }, { now: () => at })).sessions.length, 0, "an expired key is absent");
	assert.equal((await readSandboxSessions({ ...redis, mget: async () => ["{bad"] }, { now: () => at })).unreadable, 1);
	assert.equal((await readSandboxSessions({ zrangebyscore: async () => { throw new Error("credential must never reach result"); } }, { now: () => at })).unreachable, true);
	const crowded = { time: redis.time, zrangebyscore: async () => Array.from({ length: 257 }, (_, i) => sandboxSessionMember("other", `job-${i}`)), mget: async () => [] };
	const scoped = await readSandboxSessions(crowded, { hosts: ["mini1"], now: () => at });
	assert.deepEqual(scoped.sessions, []);
	assert.equal(scoped.more, 1, "a requested host beyond the global cap is unknown, never a certain empty list");
	assert.equal(scoped.noticesUnavailable, true, "the independently capped notices also disclose a partial read");
	const corruptNotice = await readSandboxSessions({ ...redis, zrangebyscore: async (key) => key === "sandbox:notices" ? [member] : [], mget: async () => ["private malformed content"] }, { now: () => at });
	assert.deepEqual(corruptNotice.notices, []);
	assert.equal(corruptNotice.noticesUnavailable, true);
	assert.ok(!JSON.stringify(corruptNotice).includes("private malformed content"));
});

test("End never writes a request for an expired or replacement session", async () => {
	for (const current of [null, { ...session, nonce: "c".repeat(32) }, { ...session, containerId: "d".repeat(64) }]) {
		const redis = store({ get: async () => current && JSON.stringify(current) });
		assert.equal((await requestSandboxEnd({ redis, ...session, now: () => at })).refused, "session-changed");
		assert.equal(redis.calls.length, 0);
	}
});

test("End records success only after an acknowledgement and removes its timed-out request", async () => {
	const redis = store({ get: async (key) => key === sandboxSessionKey(session.host, session.id) ? JSON.stringify(session) : "ended" });
	assert.deepEqual(await requestSandboxEnd({ redis, ...session, now: () => at }), { ended: true });
	assert.equal(redis.calls[0][1], sandboxEndKey(session.nonce));
	const noAck = store({ get: async (key) => key === sandboxSessionKey(session.host, session.id) ? JSON.stringify(session) : null });
	assert.deepEqual(await requestSandboxEnd({ redis: noAck, ...session, now: () => at, ackTimeoutMs: 0 }), { timeout: true });
	assert.equal(noAck.calls.at(-1)[0], "eval");
});

// Issue #843: what End answers when Valkey fails goes by where it failed.
const lostAnswer = () => Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", valkeyMayStillRun: true });
const settled = () => new Promise((resolve) => setImmediate(resolve));
const sessionRead = (ack) => async (key) => (key === sandboxSessionKey(session.host, session.id) ? JSON.stringify(session) : ack(key));

test("End's read of the session fails without the mark, whatever the client put on it: nothing was written", async () => {
	const shared = lostAnswer();
	const redis = store({ get: async () => { throw shared; } });
	const err = await requestSandboxEnd({ redis, ...session, now: () => at, timeoutMs: null }).catch((e) => e);
	assert.equal(err.message, "Command timed out");
	assert.equal(err.code, "ETIMEDOUT");
	assert.equal(err.valkeyMayStillRun, undefined, "a read that reached a socket changed nothing");
	assert.equal(shared.valkeyMayStillRun, true, "the client's own error keeps its mark: ioredis hands one error to every command it flushes");
	assert.equal(err.cause, shared);
	assert.equal(redis.calls.length, 0, "no request, and nothing to take back");
	const plain = new Error("Stream isn't writeable and enableOfflineQueue options is false");
	assert.equal(await requestSandboxEnd({ redis: store({ get: async () => { throw plain; } }), ...session, now: () => at, timeoutMs: null }).catch((e) => e), plain, "an unmarked error is thrown as it is");
});

test("End's request that was never sent, or that Valkey refused, changed nothing and takes nothing back", async () => {
	for (const error of [Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT" }), Object.assign(new Error("READONLY You can't write against a read only replica."), { name: "ReplyError" })]) {
		const redis = store({ get: sessionRead(() => null), set: async () => { throw error; } });
		const err = await requestSandboxEnd({ redis, ...session, now: () => at, timeoutMs: null }).catch((e) => e);
		await settled();
		assert.equal(err, error);
		assert.equal(err.valkeyMayStillRun, undefined);
		assert.deepEqual(redis.calls, [], "no removal is sent for a request that is not there");
	}
});

test("End's request that reached a Valkey which stopped answering keeps its mark and is taken back without waiting", async () => {
	const error = lostAnswer();
	let release;
	const redis = store({ get: sessionRead(() => null), set: async () => { throw error; }, eval: (...v) => (redis.calls.push(["eval", ...v]), new Promise((resolve) => { release = resolve; })) });
	const err = await requestSandboxEnd({ redis, ...session, now: () => at, timeoutMs: null, random: () => "e".repeat(32) }).catch((e) => e);
	assert.equal(err, error);
	assert.equal(err.valkeyMayStillRun, true, "the confirm and the audit row say it may or may not have been made");
	await settled();
	assert.equal(redis.calls.length, 1, "the answer did not wait for the removal, which is still unanswered here");
	const [verb, script, keys, key, value] = redis.calls[0];
	assert.deepEqual([verb, keys, key], ["eval", 1, sandboxEndKey(session.nonce)]);
	assert.match(script, /redis\.call\('GET',KEYS\[1\]\)==ARGV\[1\]/, "compare and delete: a later request for this shell is never the one removed");
	assert.deepEqual(JSON.parse(value), { host: session.host, id: session.id, nonce: session.nonce, containerId: session.containerId, requestId: "e".repeat(32) });
	release(1);
});

test("a read of End's acknowledgment that throws, after the request was written, takes the request back and says so", async () => {
	// Valkey not answering, a connection that went, and Valkey answering the read with an error of its own: the request stands in each.
	for (const error of [lostAnswer(), new Error("Connection is closed."), Object.assign(new Error("LOADING Valkey is loading the dataset in memory"), { name: "ReplyError" })]) {
		const redis = store({ get: sessionRead(() => { throw error; }), eval: (...v) => (redis.calls.push(["eval", ...v]), new Promise(() => {})) });
		assert.deepEqual(await requestSandboxEnd({ redis, ...session, now: () => at, timeoutMs: null }), { unconfirmed: true }, "never a throw, which would read as nothing written");
		await settled();
		assert.deepEqual(redis.calls.map((c) => c[0]), ["set", "eval"]);
		assert.equal(redis.calls[1][3], sandboxEndKey(session.nonce));
		assert.equal(redis.calls[1][4], redis.calls[0][2], "its own request, by value");
	}
});

test("End's own acknowledgment timeout reads what the removal answered: a request already gone is looked up once more", async () => {
	const run = async ({ removed, late }) => {
		let removedYet = false;
		const redis = store({ get: sessionRead(() => { if (removedYet && late instanceof Error) throw late; return removedYet ? late : null; }), eval: async (...v) => { redis.calls.push(["eval", ...v]); removedYet = true; if (removed instanceof Error) throw removed; return removed; } });
		return { out: await requestSandboxEnd({ redis, ...session, now: () => at, ackTimeoutMs: 0, timeoutMs: null }), calls: redis.calls.map((c) => c[0]) };
	};
	// The monitor took the request between the last poll and the removal, and has answered since.
	assert.deepEqual(await run({ removed: 0, late: "ended" }), { out: { ended: true }, calls: ["set", "eval"] });
	assert.equal((await run({ removed: 0, late: "stop-failed" })).out.refused, "stop-failed");
	// Gone and not answered: it expired, or the monitor is still stopping the container.
	assert.deepEqual((await run({ removed: 0, late: null })).out, { timeout: true });
	// Gone, and the one more read of the acknowledgment fails: still the ambiguous answer, never a throw after the request was written.
	assert.deepEqual((await run({ removed: 0, late: new Error("Command timed out") })).out, { timeout: true });
	// Taken back by this caller. A monitor that read it a moment earlier may still stop the container, so an acknowledgment
	// is not looked for again and the answer stays the ambiguous one.
	assert.deepEqual((await run({ removed: 1, late: "ended" })).out, { timeout: true });
	// A removal that was not answered says nothing either way.
	assert.deepEqual((await run({ removed: new Error("Command timed out"), late: "ended" })).out, { timeout: true });
});

test("End's timeoutMs of null leaves each command to the client's own bound, and a number is this module's timer", async () => {
	// Never answered: with a timer of its own End rejects with its own words, which cannot say whether the SET was sent.
	const silent = store({ get: sessionRead(() => null), set: () => new Promise(() => {}) });
	await assert.rejects(requestSandboxEnd({ redis: silent, ...session, now: () => at, timeoutMs: 20 }), /sandbox control timed out/);
	// With none, the client's error is the one that arrives, mark and all, however long it took.
	const error = lostAnswer();
	const slow = store({ get: sessionRead(() => null), set: () => new Promise((_resolve, reject) => setTimeout(reject, 60, error)) });
	assert.equal(await requestSandboxEnd({ redis: slow, ...session, now: () => at, timeoutMs: null }).catch((e) => e), error);
});

test("monitor End uses immutable ID and acknowledges only a confirmed disappearance", async () => {
	const redis = store({ get: async () => JSON.stringify({ ...session, requestId: "c".repeat(32) }) });
	let stopped = null;
	const inspect = async () => stopped ? { present: false } : { present: true, containerId: session.containerId, nonce: session.nonce };
	const result = await sandboxSessionTick({ redis, session, inspect, stop: async (id) => (stopped = id, true), now: () => at });
	assert.equal(stopped, session.containerId);
	assert.deepEqual(result, { gone: true, ended: true });
	assert.equal(redis.calls.find((c) => c[0] === "set")[2], "ended");
	const failed = store({ get: async () => JSON.stringify({ ...session, requestId: "c".repeat(32) }) });
	const still = await sandboxSessionTick({ redis: failed, session, inspect: async () => ({ present: true, containerId: session.containerId, nonce: session.nonce }), stop: async () => true, now: () => at });
	assert.equal(still.stopFailed, true);
	assert.equal(failed.calls.find((c) => c[0] === "set")[2], "stop-failed");
});

test("unknown runtime and stale End cannot stop or acknowledge a replacement", async () => {
	for (const state of [{ unknown: true }, { present: true, containerId: "c".repeat(64), nonce: session.nonce }]) {
		const redis = store({ get: async () => JSON.stringify(session) });
		await sandboxSessionTick({ redis, session, inspect: async () => state, stop: async () => assert.fail("must not stop"), now: () => at });
		assert.equal(redis.calls.length, 0);
	}
	const redis = store({ get: async () => JSON.stringify({ ...session, nonce: "c".repeat(32) }) });
	assert.equal((await sandboxSessionTick({ redis, session, inspect: async () => ({ present: true, ...session }), stop: async () => assert.fail("stale request"), now: () => at })).live, true);
});

test("inspect separates absent, stopped and unavailable runtime states without publishing stderr", async () => {
	assert.deepEqual(await inspectSandboxSession({ bin: "podman", name: "x", run: async () => ({ code: 1, stderr: "no such container" }) }), { present: false });
	assert.deepEqual(await inspectSandboxSession({ bin: "podman", name: "x", run: async () => ({ code: 1, stderr: "permission denied secret" }) }), { unknown: true });
	const found = await inspectSandboxSession({ bin: "podman", name: "x", run: async () => ({ code: 0, stdout: JSON.stringify([{ Id: session.containerId, State: { Running: true }, Config: { Labels: { "org.pi-dispatch.sandbox-session": session.nonce } } }]) }) });
	assert.equal(found.containerId, session.containerId);
	assert.equal(found.running, true);
});

test("detached monitor renews until actual exit and cleans only its own absent container's network", async () => {
	let sleeps = 0;
	let cleaned = 0;
	const redis = store();
	const inspect = async () => sleeps < 2 ? { present: true, containerId: session.containerId, nonce: session.nonce } : { present: false };
	assert.deepEqual(await watchSandboxSession({ metadata: { ...session, name: "pi-sandbox-run" }, redis, inspect, stop: async () => assert.fail(), cleanup: async () => cleaned++, now: () => at + sleeps * 1000, sleep: async () => sleeps++, foregroundDone: () => true }), { gone: true });
	assert.equal(redis.calls.filter((c) => c[0] === "eval" && c[1].includes("redis.call('SET'")).length, 2);
	assert.equal(cleaned, 1);
	assert.equal(sleeps, 2, "foreground returning did not end tracking of its live container");
});

test("a refused or failed monitored network cleanup is reported without claiming removal", async () => {
	for (const [cleanup, reason] of [[async () => false, "network-kept"], [async () => { throw new Error("private daemon failure"); }, "network-cleanup-failed"]]) {
		const notices = [];
		await watchSandboxSession({ metadata: { ...session, name: "pi-sandbox-run", network: "pi-sandbox-run-net" }, redis: store(), inspect: async () => ({ present: false }), cleanup, now: () => at, foregroundDone: () => true, report: async (why) => notices.push(why) });
		assert.deepEqual(notices, [reason]);
	}
});

test("monitor IPC carries admitted runtime evidence and labels only this session's container", async () => {
	const child = new EventEmitter();
	const messages = [];
	child.send = (m) => { messages.push(m); queueMicrotask(() => child.emit("message", { ready: true })); };
	child.unref = () => {};
	child.channel = { unref() {} };
	child.connected = true;
	const admittedRuntime = { podman: false, rootless: false, version: "28.0.0" };
	const monitor = makeSandboxMonitor({ env: { VALKEY_PASSWORD: "host-only-secret" }, config: { workerName: "mini1", valkeyUrl: "redis://unused", egressProxy: "proxy" }, now: () => at, spawnMonitor: (_file, args, options) => { assert.deepEqual(args, []); assert.equal(options.env.VALKEY_PASSWORD, "host-only-secret"); return child; } });
	const args = ["run", "--rm", "image:last"];
	const handle = await monitor({ resolved: { manifest: { jobId: "gh-1" }, venue: "local", name: "pi-sandbox-gh-1" }, args, network: "pi-sandbox-gh-1-net", runtime: "docker", admittedRuntime });
	assert.deepEqual(messages[0].admittedRuntime, admittedRuntime);
	assert.equal(args.at(-1), "image:last");
	assert.ok(args.some((v) => v.startsWith("org.pi-dispatch.sandbox-session=")));
	assert.ok(!args.join(" ").includes("host-only-secret"));
	assert.equal(handle.ownsNetwork, true);
	handle.finish();
	assert.deepEqual(messages[1], { foregroundDone: true });
});

test("a failed startup diagnostic delete cannot strand a launched shell without a resilient monitor", async () => {
	let slept = 0, ready = false, removed = false;
	const admittedRuntime = { podman: false, rootless: false, version: "28.0.0" };
	const redis = store({ connect: async () => {}, ping: async () => "PONG", del: async () => { throw new Error("store dropped after ping"); } });
	const result = await runSandboxSessionMonitor({ metadata: { ...session, name: "pi-sandbox-gh-1", network: "pi-sandbox-gh-1-net", proxy: "proxy", bin: "docker", admittedRuntime }, redis, ready: () => ready = true, watchOptions: { now: () => at, inspect: async () => slept ? { present: false } : { present: true, nonce: session.nonce, containerId: session.containerId }, sleep: async () => { assert.equal(ready, true); slept++; } }, removeNetwork: async (_spawn, options) => { assert.deepEqual(await options.readRuntime(), admittedRuntime); removed = true; return true; } });
	assert.deepEqual(result, { gone: true });
	assert.equal(slept, 1, "the live shell continued through a monitor tick after the startup delete failed");
	assert.equal(removed, true, "the confirmed exit used the admitted runtime's guarded cleanup");
});
