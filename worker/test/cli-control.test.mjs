import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { entryExitCode, main } from "../src/cli.mjs";
import { POLLER_GRACE_MS, parsePollerStatus, pollerKey, triggersDigest } from "../src/poller-status.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

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

// Issue #970: `status` reads the pollers' heartbeats and judges this host's triggers file beside them.
const POLL_AT = 1_800_000_000_000;
// #970's own edit: a cron trigger with neither run.flow nor run.command, which every reader refuses.
const PROBE_FILE = JSON.stringify({ triggers: [{ on: { type: "cron", id: "probe", pattern: "0 4 3 1 *" }, run: { kind: "local", folder: "/srv/probe", task: "probe" } }] });
const GOOD_FILE = JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix" } }] });

/** A deployment folder: its `.env` and, when given, its triggers file. */
function deployment(envText, triggers = null) {
	const dir = tempDir("pd-970-status-");
	writeFileSync(join(dir, ".env"), envText);
	if (triggers !== null) writeFileSync(join(dir, "triggers.json"), triggers);
	return dir;
}

/** A poller record as the heartbeat writes it, checked to be one a reader takes. */
function pollerRecord(fields = {}) {
	const raw = JSON.stringify({ v: 1, name: "mini1", version: "5.4.2", startedAt: POLL_AT - 600_000, at: POLL_AT - 20_000, ttlMs: 60_000 + POLLER_GRACE_MS, nextAt: POLL_AT + 40_000, intervalSeconds: 60, repos: 2, triggers: "current", refusal: null, running: triggersDigest(GOOD_FILE), rejected: null, rejectedAt: null, ...fields });
	assert.ok(parsePollerStatus(raw), "the fixture is a record the reader takes");
	return raw;
}

/** `status` over a probe whose index holds `records` (name -> raw), each with `left` ms of TTL. */
async function pollerStatus(cwd, { records = {}, left = 40_000 + POLLER_GRACE_MS, env = {}, probe = null } = {}) {
	let output = "";
	const keys = Object.fromEntries(Object.entries(records).map(([name, raw]) => [pollerKey(name), raw]));
	const code = await main(["status", "--valkey-url", "redis://127.0.0.1:6379"], env, {
		cwd, now: () => new Date(POLL_AT), write: (text) => { output += text; }, valkeyRefusal: async () => null,
		controlClients: {
			makeRedisClient: () => probe ?? ({
				on() {}, disconnect() {},
				async smembers() { return []; }, async scan() { return ["0", []]; },
				async sscan(key) { return key === "poller:live" ? ["0", Object.keys(records)] : ["0", []]; },
				async mget(...wanted) { return wanted.map((k) => keys[k] ?? null); },
				async pttl(k) { return keys[k] ? left : -2; },
			}),
			makeQueue: (_connection, { name }) => ({ name, client: { async zrange() { return []; } }, async isPaused() { return false; }, async getJobCounts() { return { waiting: 2, active: 1, paused: 0, delayed: 0, failed: 0 }; }, async close() {} }),
		},
	});
	return { code, status: JSON.parse(output) };
}

test("status says a poller runs on the previous triggers.json and why, when the file it refused is this host's (issue #970)", async () => {
	const cwd = deployment("GITHUB_INGEST=poll\n", PROBE_FILE);
	const kept = { triggers: "kept", refusal: "refused", rejected: triggersDigest(PROBE_FILE), rejectedAt: POLL_AT - 30_000 };
	const { code, status } = await pollerStatus(cwd, { records: { mini1: pollerRecord(kept) } });
	assert.equal(code, 0, "status reports facts and exits 0 whatever the poller says");
	assert.equal(status.pollers.expected, true);
	assert.equal(status.pollers.complete, true);
	assert.equal(status.pollers.hosts.length, 1);
	assert.equal(status.pollers.hosts[0].ageMs, 20_000, "the record's TTL minus what is left of it, Valkey's count");
	assert.match(status.pollers.note, /^poller: running on the previous triggers\.json, the current file is invalid: cron trigger "probe": run\.flow must be/, "issue #970's sentence, with this host's reason");
	assert.equal(status.pollers.local, undefined);
	// The rest of the line is as before.
	assert.equal(status.pausedState, false);
	assert.equal(status.waiting, 2);
	assert.equal(status.active, 1);
	assert.deepEqual(status.consumers, []);
	assert.ok(status.waitingDetails);

	// The copy it refused is another: this host's file is not the one to fix, or not yet read.
	const other = await pollerStatus(cwd, { records: { mini1: pollerRecord({ ...kept, rejected: triggersDigest("another host's copy") }) } });
	assert.match(other.status.pollers.note, /^poller: running on the previous triggers\.json; the copy it refused is not this host's file \(another host's copy, or this one changed since: it reads its file again by 2027-01-15T08:00:40\.000Z\), so run pi-dispatch triggers check where it runs$/);
	// A missing file names no reason, since there is no text to judge.
	const missing = await pollerStatus(cwd, { records: { mini1: pollerRecord({ ...kept, refusal: "missing", rejected: null }) } });
	assert.equal(missing.status.pollers.note, "poller: running on the previous triggers.json, the current file is missing where it runs");
	// On the current file, but not this host's copy: when it reads its file again.
	const behind = await pollerStatus(deployment("GITHUB_INGEST=poll\n", GOOD_FILE.replace("fix", "triage")), { records: { mini1: pollerRecord() } });
	assert.match(behind.status.pollers.note, /^poller: running on a triggers\.json that is not this host's file .*reads its file again by 2027-01-15T08:00:40\.000Z\)$/);
	// On this host's file, current: nothing to say.
	const healthy = await pollerStatus(deployment("GITHUB_INGEST=poll\n", GOOD_FILE), { records: { mini1: pollerRecord() } });
	assert.equal(healthy.status.pollers.note, undefined);
	assert.equal(healthy.status.pollers.hosts[0].triggers, "current");
});

test("status names each poller when more than one publishes, and says of one whose heartbeat it cannot read that it cannot (issue #970)", async () => {
	const cwd = deployment("GITHUB_INGEST=poll\n", PROBE_FILE);
	const kept = pollerRecord({ triggers: "kept", refusal: "refused", rejected: triggersDigest(PROBE_FILE), rejectedAt: POLL_AT - 30_000 });
	const newer = JSON.stringify({ ...JSON.parse(pollerRecord({ name: "mini2" })), v: 2 });
	const { code, status } = await pollerStatus(cwd, { records: { mini1: kept, mini2: newer } });
	assert.equal(code, 0);
	assert.deepEqual(status.pollers.hosts.map((h) => [h.name, h.unreadable === true]), [["mini1", false], ["mini2", true]]);
	assert.equal(status.pollers.complete, false, "a record it cannot read is a record it does not know");
	assert.match(status.pollers.note, /^poller on mini1: running on the previous triggers\.json, the current file is invalid: cron trigger "probe": run\.flow must be .*; poller on mini2: its heartbeat cannot be read \(written by another release, or damaged\)$/);
});

test("status says no poller has published where the deployment polls, with why a poller would refuse this host's file, and exits 0 (issue #970)", async () => {
	const none = await pollerStatus(deployment("GITHUB_INGEST=poll\n", PROBE_FILE));
	assert.equal(none.code, 0);
	assert.deepEqual({ ...none.status.pollers, note: undefined }, { expected: true, hosts: [], complete: true, note: undefined });
	assert.match(none.status.pollers.note, /^poller: no poller has published a heartbeat \(a poller older than this release publishes none\); the current triggers\.json is invalid, so a poller started on it refuses to start \(exit 2\): cron trigger "probe": run\.flow must be/, "issue #970's own case: the poller exited 2 on this file");
	const good = await pollerStatus(deployment("GITHUB_INGEST=both\n", GOOD_FILE));
	assert.equal(good.status.pollers.note, "poller: no poller has published a heartbeat (a poller older than this release publishes none)");
	// An incomplete read proves no absence.
	const blind = await pollerStatus(deployment("GITHUB_INGEST=poll\n", GOOD_FILE), { probe: { on() {}, disconnect() {}, async smembers() { return []; }, async scan() { return ["0", []]; } } });
	assert.equal(blind.code, 0, "a probe that cannot scan the index fails nothing");
	assert.equal(blind.status.pollers.complete, false);
	assert.equal(blind.status.pollers.note, "poller: the heartbeats could not be read completely, so whether a poller runs is not known");
	// No poller is expected under webhook, or said of when GITHUB_INGEST is unset, and the file is then not read.
	for (const [envText, expected] of [["GITHUB_INGEST=webhook\n", false], ["", null]]) {
		const { code, status } = await pollerStatus(deployment(envText));
		assert.equal(code, 0);
		assert.deepEqual(status.pollers, { expected, hosts: [], complete: true }, JSON.stringify(envText));
	}
	// A setting this shell and the .env disagree on is said, and fails nothing.
	const split = await pollerStatus(deployment("GITHUB_INGEST=poll\n", GOOD_FILE), { env: { GITHUB_INGEST: "webhook" } });
	assert.equal(split.code, 0);
	assert.equal(split.status.pollers.expected, null);
	assert.match(split.status.pollers.local, /^GITHUB_INGEST is "webhook" in this shell and "poll" in .*\.env: make them agree/);
});
