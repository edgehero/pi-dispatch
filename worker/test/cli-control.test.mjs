import assert from "node:assert/strict";
import { test } from "node:test";
import { entryExitCode, main } from "../src/cli.mjs";

// pause/resume/status dynamic-import bullmq/ioredis only when they reach the queue. The USAGE,
// entryExitCode, and unknown-command paths return before any import, so they run everywhere; the
// fail-fast-against-a-down-Valkey path needs the deps and is gated below the node floor.
let depsOk = false;
try {
	await import("../src/connection.mjs");
	depsOk = true;
} catch {}
const needsDeps = depsOk ? false : `queue deps not installed (node ${process.version} < 22.19.0); CI runs these`;

/**
 * Run `fn` with a collector it must pass into the code under test; returns the concatenated output.
 *
 * The collector is INJECTED into the code under test, never installed over `process.stdout.write`.
 * `node --test` runs each file in a child process that serialises its own results over that same stdout,
 * so a helper holding a replacement across an `await` swallows the runner's result frames -- three tests
 * in `worker/test/start-wiring.test.mjs` were reported as never existing at all, exit code 0 (issue #266).
 */
async function captureStdout(fn) {
	let out = "";
	const write = (chunk) => ((out += chunk), true);
	await fn(write);
	return out;
}

test("usage lists the pause/resume/status/cancel control commands", async () => {
	let code;
	const out = await captureStdout(async (write) => {
		code = await main([], {}, { write });
	});
	assert.equal(code, 0);
	assert.match(out, /\bpause\b/);
	assert.match(out, /\bresume\b/);
	assert.match(out, /\bstatus\b/);
	assert.match(out, /\bcancel <jobId>/);
});

test("entryExitCode maps a tagged config error to EXIT_POLICY (2), everything else to 1", () => {
	// A config error is a determinate refusal (never retried); anything else is infra (retryable).
	assert.equal(entryExitCode({ piDispatchConfig: true }), 2);
	assert.equal(entryExitCode(new Error("x")), 1);
	assert.equal(entryExitCode(undefined), 1);
});

test("an unknown command still exits 1", async () => {
	assert.equal(await main(["frobnicate"], {}), 1);
});

test("status marks a failed queue scan incomplete even when the registry and visible queue answer", async () => {
	for (const scanFails of [false, true]) {
		let disconnected = false;
		const opened = [], closed = [];
		let output = "";
		const code = await main(["status", "--valkey-url", "redis://127.0.0.1:6379"], {}, {
			now: () => new Date(1_800_000_000_000),
			write: (text) => { output += text; }, valkeyRefusal: async () => null,
			controlClients: {
				makeRedisClient: () => ({
					on() {}, disconnect() { disconnected = true; },
					async smembers() { return []; },
					async scan() {
						if (scanFails) throw new Error("scan refused: private connection detail");
						return ["0", []];
					},
				}),
				makeQueue: (_connection, { name }) => {
					opened.push(name);
					return {
						name, client: { async zrange() { return []; } },
						async isPaused() { return false; },
						async getJobCounts() { return { waiting: 1, active: 0, paused: 0, delayed: 0, failed: 0 }; },
						async close() { closed.push(name); },
					};
				},
			},
		});
		assert.equal(code, 0);
		const result = JSON.parse(output);
		assert.equal(result.waiting, 1);
		assert.equal(result.waitingDetails.partial, scanFails);
		assert.equal(result.waitingDetails.discoveryIncomplete, scanFails ? true : undefined);
		assert.deepEqual(result.waitingDetails.rows, []);
		assert.ok(!Object.hasOwn(result, "fleet"), "the registry answered; only the keyspace discovery failed");
		assert.ok(!output.includes("private connection detail"));
		assert.deepEqual(opened, ["pi-jobs"]);
		assert.deepEqual(closed, opened);
		assert.equal(disconnected, true);
	}
});

// Issue #464 (gate round 3): the kill switch and status judge the Valkey before they talk to it.
test("pause, resume and status stop on the Valkey refusal before they talk to it (#464)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL" }, async () => {
	for (const cmd of ["pause", "resume", "status"]) {
		const asked = [];
		const code = await main([cmd], { VALKEY_URL: process.env.VALKEY_TEST_URL }, { write: () => {}, valkeyRefusal: async (url) => (asked.push(url), "the Valkey VALKEY_URL reaches is refused: held by op2") });
		assert.equal(code, 1, cmd);
		assert.deepEqual(asked, [process.env.VALKEY_TEST_URL], cmd);
	}
});

test("pause fails fast (does not hang) when Valkey is unreachable", { skip: needsDeps }, async () => {
	const start = Date.now();
	const code = await main(["pause"], { VALKEY_URL: "redis://127.0.0.1:1" });
	assert.equal(code, 1, "an unreachable Valkey is a clean error, not a hang");
	assert.ok(Date.now() - start < 15000, "must fail fast, well under any CI timeout");
});

test("resume fails fast (does not hang) when Valkey is unreachable", { skip: needsDeps }, async () => {
	const start = Date.now();
	const code = await main(["resume"], { VALKEY_URL: "redis://127.0.0.1:1" });
	assert.equal(code, 1);
	assert.ok(Date.now() - start < 15000, "must fail fast");
});

test("status fails fast (does not hang) when Valkey is unreachable", { skip: needsDeps }, async () => {
	const start = Date.now();
	const code = await main(["status"], { VALKEY_URL: "redis://127.0.0.1:1" });
	assert.equal(code, 1);
	assert.ok(Date.now() - start < 15000, "must fail fast");
});

test("cancel fails fast (does not hang) when Valkey is unreachable", { skip: needsDeps }, async () => {
	const start = Date.now();
	const code = await main(["cancel", "j1"], { VALKEY_URL: "redis://127.0.0.1:1" });
	assert.equal(code, 1, "an unreachable Valkey is a clean error, not a hang");
	assert.ok(Date.now() - start < 15000, "must fail fast, well under any CI timeout");
});

// Issue #646: the steer verb is routed, documented, and refuses for free before it reaches Valkey.
test("usage lists steer and its withdraw form", async () => {
	let code;
	const out = await captureStdout(async (write) => {
		code = await main(["--help"], {}, { write });
	});
	assert.equal(code, 0);
	assert.match(out, /pi-dispatch steer <jobId> \[--later\] <text…\|->/);
	assert.match(out, /pi-dispatch steer --withdraw <jobId> <msgId>/);
	assert.match(out, /guaranteed while it is queued, best effort once written/);
});

test("steer refuses a flag-looking word, a missing message and a missing job id before Valkey", async () => {
	// A Valkey that would hang if contacted; every one of these must return without it.
	const env = { VALKEY_URL: "redis://127.0.0.1:1" };
	const start = Date.now();
	assert.equal(await main(["steer", "j1", "use", "--force"], env, { write: () => true }), 1, "an unknown flag is refused, not dropped from the text");
	assert.equal(await main(["steer", "j1", "--later=yes"], env, { write: () => true }), 1);
	assert.equal(await main(["steer"], env, { write: () => true }), 1);
	assert.equal(await main(["steer", "j1"], env, { write: () => true }), 1);
	assert.equal(await main(["steer", "--withdraw", "j1", "not-an-id"], env, { write: () => true }), 1);
	assert.ok(Date.now() - start < 5000, "no network wait");
});

test("steer fails fast (does not hang) when Valkey is unreachable", { skip: needsDeps }, async () => {
	const start = Date.now();
	const code = await main(["steer", "j1", "hello"], { VALKEY_URL: "redis://127.0.0.1:1" });
	assert.equal(code, 1, "an unreachable Valkey is a clean error, not a hang");
	assert.ok(Date.now() - start < 15000, "must fail fast, well under any CI timeout");
});

test("steer --withdraw fails fast (does not hang) when Valkey is unreachable", { skip: needsDeps }, async () => {
	const start = Date.now();
	const code = await main(["steer", "--withdraw", "j1", "ab".repeat(16)], { VALKEY_URL: "redis://127.0.0.1:1" });
	assert.equal(code, 1);
	assert.ok(Date.now() - start < 15000, "must fail fast");
});

test("status reports a failed owned consumer beside a fresh heartbeat without changing queue state (#924)", async () => {
	let output = "", ended = false;
	const at = 1_800_000_000_000;
	const rows = ["shared", "host", "sandbox"].map((role) => ({ role, state: "running", connection: role === "host" ? "ended" : "ready", active: 0, rateLimited: false, lastFetchAt: at, lastSuccessAt: at, lastTakenAt: null, fetchAgeMs: 0, successAgeMs: 0 }));
	const code = await main(["status", "--valkey-url", "redis://127.0.0.1:6379"], {}, {
		now: () => new Date(at), write: (text) => { output += text; }, valkeyRefusal: async () => null,
		controlClients: {
			makeRedisClient: () => ({
				on() {}, disconnect() { ended = true; },
				async smembers() { return ["build3"]; }, async scan() { return ["0", []]; }, async pttl() { return 90000; },
				async hgetall() { return { name: "build3", routes: "true", startedAt: String(at), beatAt: String(at), consumers: JSON.stringify({ v: 1, startedAt: at, rows }) }; },
				async eval() { assert.equal(ended, false, "demand is read before the probe closes"); return [0, 0]; },
			}),
			makeQueue: (_connection, { name }) => ({ name, client: { async zrange() { return []; } }, async isPaused() { return false; }, async getJobCounts() { return { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }; }, async close() {} }),
		},
	});
	assert.equal(code, 0, "status reports facts; doctor owns the failing diagnostic exit");
	const status = JSON.parse(output);
	assert.equal(status.pausedState, false);
	assert.equal(status.consumers[0].state, "failed");
	assert.deepEqual(status.consumers[0].rows.map((c) => c.verdict), ["idle", "failed", "idle"]);
	assert.ok(status.consumers[0].rows.every((c) => typeof c.queue === "string"));
});
