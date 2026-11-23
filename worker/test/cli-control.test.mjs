import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { refusedBeforeScript } from "../src/bullmq-internals.mjs";
import { entryExitCode, killSwitchShortCause, killSwitchShortNote, main, statusShortNote } from "../src/cli.mjs";
import { POLLER_GRACE_MS, parsePollerStatus, pollerKey, triggersDigest } from "../src/poller-status.mjs";
import { readPollerFacts } from "../src/poller-facts.mjs";
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
		assert.equal(result.queuesMayBeShort, scanFails ? true : undefined, "said at the top too (issue #1043)");
		assert.deepEqual(result.waitingDetails.rows, []);
		assert.ok(!Object.hasOwn(result, "fleet"), "the registry answered; only the keyspace discovery failed");
		assert.ok(!output.includes("private connection detail"));
		assert.deepEqual(opened, ["pi-jobs"]);
		assert.deepEqual(closed, opened);
		assert.equal(disconnected, true);
	}
});

// Issue #964: the kill switch also flips this host's own queue, which the deployment's .env names, and says what a set
// of queues that may be short means. Fake clients: nothing is dialled.
test("pause and resume flip this host's own queue and say when the set of queues may be short, exiting 0 (#964)", async () => {
	const dir = tempDir("pd-964-cli-");
	const run = async (argv, envFile, env = {}, pauseFails = () => false) => {
		writeFileSync(join(dir, ".env"), envFile);
		const flipped = [];
		let out = "";
		const code = await main(argv, { VALKEY_URL: "redis://127.0.0.1:1/15", ...env }, {
			cwd: dir,
			write: (text) => { out += text; },
			valkeyRefusal: async () => null,
			controlClients: {
				// A registry and a keyspace scan that do not answer: only the shared queue and this host's own are named. This
				// host's queue has no meta key yet (EXISTS answers 0), so a resume has nothing to resume there.
				makeRedisClient: () => ({ on() {}, disconnect() {}, async smembers() { throw new Error("registry boom"); }, async scan() { throw new Error("scan refused"); }, async exists() { return 0; } }),
				// Each queue named with the database its connection selects, so the Valkey it was flipped on is seen.
				makeQueue: (connection, { name }) => ({ name, async pause() { if (pauseFails(name)) throw new Error("down"); flipped.push(`${connection.db}:${name}`); }, async resume() { flipped.push(`${connection.db}:${name}`); }, async close() {} }),
			},
		});
		return { code, flipped, out };
	};
	const paused = await run(["pause"], "PI_WORKER_NAME=hosta\n");
	assert.equal(paused.code, 0, paused.out);
	assert.deepEqual(paused.flipped, ["15:pi-jobs", "15:pi-jobs@hosta"]);
	assert.equal(paused.out, `paused: worker will stop taking new jobs (jobs still enqueue) [2 queues] [registry unreadable: registry boom] [queue scan incomplete]\n  but ${killSwitchShortNote(true)}\n`);
	// A resume reaches it only where the scan found it: a queue that does not exist has nothing to resume, and one built to
	// resume it would write its meta key.
	const resumed = await run(["resume"], "PI_WORKER_NAME=hosta\n");
	assert.deepEqual([resumed.code, resumed.flipped], [0, ["15:pi-jobs"]]);
	assert.equal(resumed.out, `resumed [registry unreadable: registry boom] [queue scan incomplete]\n  but ${killSwitchShortNote(false)}\n`);
	assert.equal(killSwitchShortNote(true), "the list of queues may be short: the host registry or the look for queues could not be read whole, so other queues may exist and were not paused. Pause the fleet again once Valkey answers");
	// The name is the deployment .env's alone, which the worker service runs. None declared there: the shared queue alone,
	// never one a hostname would name, and a name only this shell sets is said and left out. A name this shell sets
	// otherwise, or one the worker refuses, is said too, and the switch goes on.
	assert.deepEqual((await run(["pause"], "")).flipped, ["15:pi-jobs"]);
	const shellOnly = await run(["pause"], "", { PI_WORKER_NAME: "hostz" });
	assert.deepEqual(shellOnly.flipped, ["15:pi-jobs"]);
	assert.match(shellOnly.out, /\[this host's queue not added: PI_WORKER_NAME is set in this shell and not in .*\.env, which the service reads\]/);
	const refused = await run(["pause"], "PI_WORKER_NAME=runs.json\n");
	assert.deepEqual([refused.code, refused.flipped], [0, ["15:pi-jobs"]]);
	assert.match(refused.out, / \[this host's queue not added: PI_WORKER_NAME must not end in \.json or \.log: "runs\.json" would collide with the run-history filenames in PI_LOGS_DIR\]\n/);
	const hazard = await run(["pause"], 'PI_WORKER_NAME="hosta\n');
	assert.deepEqual(hazard.flipped, ["15:pi-jobs"]);
	assert.match(hazard.out, /\[this host's queue not added: .*\.env has a line for PI_WORKER_NAME that the service's loader may read differently, so it cannot be told \(pi-dispatch doctor names the line\)\]/);
	writeFileSync(join(dir, ".env"), "PI_WORKER_NAME=hosta\n");
	chmodSync(join(dir, ".env"), 0o000);
	let unreadable;
	try {
		unreadable = await main(["pause"], { VALKEY_URL: "redis://127.0.0.1:1/15" }, { cwd: dir, write: (text) => { unreadable = (unreadable ?? "") + text; }, valkeyRefusal: async () => null, controlClients: { makeRedisClient: () => ({ on() {}, disconnect() {}, async smembers() { return []; }, async scan() { return ["0", []]; } }), makeQueue: (_c, { name }) => ({ name, async pause() {}, async close() {} }) } }).then(() => unreadable);
	} finally {
		chmodSync(join(dir, ".env"), 0o600);
	}
	assert.match(unreadable, /\[this host's queue not added: .*\.env could not be read \(EACCES\), so PI_WORKER_NAME cannot be told\]\n$/);
	const torn = await run(["pause"], "PI_WORKER_NAME=hosta\n", { PI_WORKER_NAME: "hostz" });
	assert.deepEqual(torn.flipped, ["15:pi-jobs"]);
	assert.match(torn.out, /\[this host's queue not added: PI_WORKER_NAME is "hostz" in this shell and "hosta" in .*\.env: make them agree \(the service runs the file's\)\]/);
	// The deployment's Valkey alone: on a VALKEY_URL disagreement the .env's (database 14 here), never this shell's, and a
	// --valkey-url only where it names the .env's.
	const env14 = "VALKEY_URL=redis://127.0.0.1:1/14\nPI_WORKER_NAME=hosta\n";
	assert.deepEqual((await run(["pause"], env14)).flipped.sort(), ["14:pi-jobs", "14:pi-jobs@hosta", "15:pi-jobs"]);
	assert.deepEqual((await run(["pause", "--valkey-url", "redis://127.0.0.1:1/15"], env14)).flipped, ["15:pi-jobs"]);
	assert.deepEqual((await run(["pause", "--valkey-url", "redis://127.0.0.1:1/14"], env14)).flipped, ["14:pi-jobs", "14:pi-jobs@hosta"]);
	assert.deepEqual((await run(["pause", "--valkey-url", "redis://127.0.0.1:2/0"], "PI_WORKER_NAME=hosta\n")).flipped, ["0:pi-jobs"]);
	// A pause that fails part-way over such a set says it too, in the per-queue report (issue #1007), exit 1.
	const said = [];
	const write = process.stderr.write;
	process.stderr.write = (chunk) => (said.push(String(chunk)), true);
	let failed;
	try {
		failed = await run(["pause"], "PI_WORKER_NAME=hosta\n", {}, (name) => name === "pi-jobs@hosta");
	} finally {
		process.stderr.write = write;
	}
	assert.equal(failed.code, 1);
	assert.equal(said.join(""), `error: could not pause the whole deployment at redis://127.0.0.1:1/15 [registry unreadable: registry boom] [queue scan incomplete]\n  pi-jobs: paused\n  pi-jobs@hosta: sent, not confirmed (down); it may still be paused when Valkey answers\n  ${killSwitchShortNote(true)}\n  run pi-dispatch status once Valkey answers to see each queue, then pi-dispatch pause again\n`);
});

// Issue #1007: a resume after a scan that did not finish looks for this host's own queue's meta key itself (EXISTS, which
// writes nothing), so it resumes that queue where it exists and leaves it out where it does not.
test("a resume whose queue scan did not finish resumes this host's own queue where its meta key exists, and writes nothing for it where it does not (#1007)", async () => {
	const dir = tempDir("pd-1007-own-");
	writeFileSync(join(dir, ".env"), "PI_WORKER_NAME=hosta\n");
	const run = async (exists) => {
		const built = [];
		const asked = [];
		let out = "";
		const code = await main(["resume"], { VALKEY_URL: "redis://127.0.0.1:1/15" }, {
			cwd: dir,
			write: (text) => { out += text; },
			valkeyRefusal: async () => null,
			controlClients: {
				makeRedisClient: () => ({ on() {}, disconnect() {}, async smembers() { return []; }, async scan() { throw new Error("scan refused"); }, async exists(key) { asked.push(key); return exists; } }),
				makeQueue: (_c, { name }) => (built.push(name), { name, async resume() {}, async close() {} }),
			},
		});
		return { code, built, asked, out };
	};
	const there = await run(1);
	assert.deepEqual([there.code, there.built, there.asked], [0, ["pi-jobs", "pi-jobs@hosta"], ["bull:pi-jobs@hosta:meta"]]);
	assert.equal(there.out, `resumed [2 queues] [queue scan incomplete]\n  but ${killSwitchShortNote(false)}\n`);
	const absent = await run(0);
	assert.deepEqual([absent.code, absent.built, absent.asked], [0, ["pi-jobs"], ["bull:pi-jobs@hosta:meta"]], "no queue is built for it, so no meta key is written");
	assert.equal(absent.out, `resumed [queue scan incomplete]\n  but ${killSwitchShortNote(false)}\n`);
	// The report's first line names this host's queue that could not be added, as the line of a whole switch does: here
	// the shell's PI_WORKER_NAME is not the .env's, and the shared queue's resume fails.
	const errs = [];
	const origErr = process.stderr.write;
	process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
	let torn;
	try {
		torn = await main(["resume"], { VALKEY_URL: "redis://127.0.0.1:1/15", PI_WORKER_NAME: "hostz" }, {
			cwd: dir,
			write: () => {},
			valkeyRefusal: async () => null,
			controlClients: {
				makeRedisClient: () => ({ on() {}, disconnect() {}, async smembers() { return []; }, async scan() { throw new Error("scan refused"); }, async exists() { return 1; } }),
				makeQueue: (_c, { name }) => ({ name, async resume() { throw new Error("down"); }, async close() {} }),
			},
		});
	} finally {
		process.stderr.write = origErr;
	}
	assert.equal(torn, 1);
	assert.match(errs.join(""), /^error: could not resume the whole deployment at redis:\/\/127\.0\.0\.1:1\/15 \[queue scan incomplete\] \[this host's queue not added: PI_WORKER_NAME is "hostz" in this shell and "hosta" in .*\.env: make them agree \(the service runs the file's\)\]\n {2}pi-jobs: sent, not confirmed \(down\); it may still be resumed when Valkey answers\n/);
});

// Issue #1007: a resume on a Valkey that answers nothing, whose .env names this host's queue, ends at its deadline: the
// look for that queue's meta key is bounded too, where it held the command until it was killed.
test("a resume on a Valkey that answers nothing, with PI_WORKER_NAME in the .env, ends near its deadline with the report (#1007)", { timeout: 15_000 }, async () => {
	const dir = tempDir("pd-1007-frozen-own-");
	writeFileSync(join(dir, ".env"), "PI_WORKER_NAME=hosta\n");
	const asked = [];
	const errs = [];
	const hang = () => new Promise(() => {});
	const origErr = process.stderr.write;
	process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
	const started = performance.now();
	let code;
	try {
		code = await main(["resume"], { VALKEY_URL: "redis://127.0.0.1:1/15" }, {
			cwd: dir, statusDeadlineMs: 300, write: () => {}, valkeyRefusal: async () => null,
			controlClients: {
				makeRedisClient: () => ({ on() {}, disconnect() {}, smembers: hang, scan: hang, exists: (key) => (asked.push(key), hang()) }),
				makeQueue: () => { throw new Error("no queue is built once the deadline is spent"); },
			},
		});
	} finally {
		process.stderr.write = origErr;
	}
	const ms = performance.now() - started;
	assert.ok(ms < 500, `ended at its 300 ms deadline (took ${Math.round(ms)} ms)`);
	assert.deepEqual(asked, ["bull:pi-jobs@hosta:meta"]);
	assert.equal(code, 1);
	// This host's queue, whose meta key did not answer either, is named as not resumed (issue #1042): it may be paused.
	assert.equal(errs.join(""), "error: could not resume the whole deployment at redis://127.0.0.1:1/15 [registry unreadable: registry timeout] [queue scan incomplete]\n"
		+ "  pi-jobs: not sent (no connection within 0.3 seconds)\n"
		+ "  pi-jobs@hosta: not sent (whether it exists could not be read in time)\n"
		+ "  nothing changed\n"
		+ `  ${killSwitchShortNote(false)}\n`
		+ "  run pi-dispatch status once Valkey answers to see each queue, then pi-dispatch resume again\n");
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

test("status asks the shared rule: POLL_REPOS without GITHUB_INGEST expects a poller, an App taking webhooks does not (issue #970)", async () => {
	// #970's case for a poller set up by hand without GITHUB_INGEST: no heartbeat, an invalid file.
	const listed = await pollerStatus(deployment("POLL_REPOS=acme/web\n", PROBE_FILE));
	assert.equal(listed.code, 0);
	assert.equal(listed.status.pollers.expected, true);
	assert.match(listed.status.pollers.note, /^poller: no poller has published a heartbeat \(a poller older than this release publishes none\); the current triggers\.json is invalid, so a poller started on it refuses to start \(exit 2\): cron trigger "probe"/);
	// What `pi-dispatch setup github` writes with a webhook: nothing says a poller runs, and status says nothing of one.
	const app = await pollerStatus(deployment("GITHUB_AUTH_SOURCE=app\nWEBHOOK_SECRET=w\n", PROBE_FILE));
	assert.deepEqual(app.status.pollers, { expected: null, hosts: [], complete: true });
	// POLL_REPOS is asked for whether it names repositories, never which: two different lists agree, and neither is
	// printed; this shell naming none where the .env names some is a disagreement, said without a value.
	const lists = await pollerStatus(deployment("POLL_REPOS=acme/web\n", GOOD_FILE), { env: { POLL_REPOS: "acme/api,acme/x" } });
	assert.equal(lists.status.pollers.expected, true);
	assert.equal(lists.status.pollers.local, undefined);
	const split = await pollerStatus(deployment("POLL_REPOS=acme/web\n", GOOD_FILE), { env: { POLL_REPOS: " " } });
	assert.equal(split.status.pollers.expected, null);
	assert.match(split.status.pollers.local, /^POLL_REPOS is blank in this shell and names repositories in .*\.env \(neither value is shown\), so whether this deployment polls cannot be told/);
	for (const r of [lists, split]) assert.doesNotMatch(JSON.stringify(r.status), /acme\/(api|web|x)/);
});

test("a kept poller over this host's file: a watch secret or WEBHOOK_SECRET this shell alone sets leaves it judged, a setting this shell alone sets does not (issues #970, #994, #1006)", async () => {
	// A poller's start judges no watch source's secret (issue #994), so status resolves none: a shell that exports one
	// where the .env does not changes nothing the poller reads, and the file is judged as the poller would take it.
	const watched = JSON.stringify({ watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_PROD_SECRET", maxPerDay: 10 } }, triggers: [{ on: { type: "watch", id: "w1", source: "prod", fingerprint: ["service"], window: "10m", cooldown: "1h", maxPerDay: 2 }, run: { kind: "local", mode: "issue", issue: { kind: "github", repo: "acme/shop" } } }] });
	const kept = (text) => pollerRecord({ triggers: "kept", refusal: "refused", rejected: triggersDigest(text), rejectedAt: POLL_AT - 30_000 });
	const secret = await pollerStatus(deployment("GITHUB_INGEST=poll\n", watched), { records: { mini1: kept(watched) }, env: { WATCH_PROD_SECRET: "private-shell-value" } });
	assert.equal(secret.code, 0);
	assert.equal(secret.status.pollers.note, "poller: running on the previous triggers.json, it refused the current file, which this host's check takes: its settings differ from this shell's, so run pi-dispatch triggers check where it runs");
	assert.equal(secret.status.pollers.local, undefined);
	assert.doesNotMatch(JSON.stringify(secret.status), /private-shell-value|WATCH_PROD_SECRET|another host/);
	// WEBHOOK_SECRET is `serve`'s alone too (issue #1006: the poller refused one of spaces where serve serves GitHub, which
	// this file's GitHub rule makes it), so this shell alone setting it leaves the file judged as well.
	const hook = await pollerStatus(deployment("POLL_REPOS=o/r\n", GOOD_FILE), { records: { mini1: kept(GOOD_FILE) }, env: { WEBHOOK_SECRET: "private-shell-value" } });
	assert.equal(hook.status.pollers.note, "poller: running on the previous triggers.json, it refused the current file, which this host's check takes: its settings differ from this shell's, so run pi-dispatch triggers check where it runs");
	assert.equal(hook.status.pollers.local, undefined);
	assert.doesNotMatch(JSON.stringify(hook.status), /private-shell-value|another host/);
	// A setting only this shell has still leaves it unjudged: the file is still this host's.
	const setting = await pollerStatus(deployment("POLL_REPOS=o/r\n", PROBE_FILE), { records: { mini1: kept(PROBE_FILE) }, env: { GITHUB_INGEST: "poll" } });
	assert.match(setting.status.pollers.note, /^poller: running on the previous triggers\.json, it refused this host's file, which cannot be judged from this shell: GITHUB_INGEST is set in this shell and not in /);
});

test("POLL_REPOS this shell alone names, a .env line for it the loader may read otherwise, or a .env that cannot be read: not known, said, never a poller expected (issue #970)", async () => {
	const shellOnly = await pollerStatus(deployment("WEBHOOK_SECRET=w\n", GOOD_FILE), { env: { POLL_REPOS: "o/r" } });
	assert.equal(shellOnly.status.pollers.expected, null);
	assert.match(shellOnly.status.pollers.local, /^POLL_REPOS names repositories in this shell and has no line in .*\.env \(neither value is shown\)/);
	const unread = await pollerStatus(deployment('POLL_REPOS="$REPOS"\n', GOOD_FILE));
	assert.equal(unread.status.pollers.expected, null);
	assert.match(unread.status.pollers.local, /has a line for POLL_REPOS that the service's loader may read differently/);
	// An empty GITHUB_INGEST in this shell is unset and answers for itself, so POLL_REPOS is asked of a .env that is a folder.
	const folder = tempDir("pd-970-status-");
	mkdirSync(join(folder, ".env"));
	const blocked = await pollerStatus(folder, { env: { GITHUB_INGEST: "" } });
	assert.equal(blocked.status.pollers.expected, null);
	assert.match(blocked.status.pollers.local, /could not be read \(EISDIR\), so whether POLL_REPOS is set cannot be told$/);
	for (const r of [shellOnly, unread, blocked]) assert.equal(r.code, 0);
});

test("a kept poller over a file not read here is never said to run on another host's copy (issue #970)", async () => {
	const kept = pollerRecord({ triggers: "kept", refusal: "refused", rejected: triggersDigest(PROBE_FILE), rejectedAt: POLL_AT - 30_000 });
	const redis = { async sscan() { return ["0", ["mini1"]]; }, async mget() { return [kept]; }, async pttl() { return 40_000 + POLLER_GRACE_MS; } };
	// A file that would not open.
	const cwd = deployment("GITHUB_INGEST=poll\n", PROBE_FILE);
	const denied = (p) => {
		if (p.endsWith("triggers.json")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		return readFileSync(p, "utf8");
	};
	const closed = await readPollerFacts(redis, { env: {}, cwd, now: () => POLL_AT, readText: denied });
	assert.match(closed.note, /^poller: running on the previous triggers\.json; this host's file was not read here \(see local\), so whether the copy it refused is this one is not known/);
	assert.match(closed.local, /triggers\.json could not be read \(EACCES\)$/);
	// A setting this shell and the .env disagree on comes before the file is read.
	const split = await pollerStatus(deployment("GITHUB_INGEST=poll\nPI_WORKER_NAME=rvK\n", PROBE_FILE), { records: { mini1: kept }, env: { PI_WORKER_NAME: "mini9" } });
	assert.match(split.status.pollers.note, /^poller: running on the previous triggers\.json; this host's file was not read here/);
	for (const note of [closed.note, split.status.pollers.note]) assert.doesNotMatch(note, /another host/);
});

test("status hashes the file the services read, not one a PI_TRIGGERS_FILE of this shell alone names (issue #970)", async () => {
	const cwd = deployment("GITHUB_INGEST=poll\n", PROBE_FILE);
	writeFileSync(join(cwd, "other.json"), GOOD_FILE);
	const kept = pollerRecord({ triggers: "kept", refusal: "refused", rejected: triggersDigest(PROBE_FILE), rejectedAt: POLL_AT - 30_000 });
	const { status } = await pollerStatus(cwd, { records: { mini1: kept }, env: { PI_TRIGGERS_FILE: join(cwd, "other.json") } });
	assert.match(status.pollers.note, /^poller: running on the previous triggers\.json, it refused this host's file, which cannot be judged from this shell: PI_TRIGGERS_FILE is set in this shell and not in /);
});

test("a heartbeat is read and judged where the settings say nothing of a poller: an App taking webhooks with a kept poller (issue #970)", async () => {
	const kept = pollerRecord({ triggers: "kept", refusal: "refused", rejected: triggersDigest(PROBE_FILE), rejectedAt: POLL_AT - 30_000 });
	const { code, status } = await pollerStatus(deployment("GITHUB_AUTH_SOURCE=app\nWEBHOOK_SECRET=w\n", PROBE_FILE), { records: { mini1: kept } });
	assert.equal(code, 0);
	assert.equal(status.pollers.expected, null);
	assert.deepEqual(status.pollers.hosts.map((h) => [h.name, h.triggers]), [["mini1", "kept"]]);
	assert.match(status.pollers.note, /^poller: running on the previous triggers\.json, the current file is invalid: cron trigger "probe": run\.flow must be/);
});

test("GITHUB_INGEST decides where it is set: a POLL_REPOS this shell and the .env disagree on changes nothing and is never printed (issue #970)", async () => {
	const cwd = deployment("GITHUB_INGEST=poll\nPOLL_REPOS=o/r\n", PROBE_FILE);
	for (const shell of [{ POLL_REPOS: "o/r,o/x" }, { POLL_REPOS: "" }]) {
		const { code, status } = await pollerStatus(cwd, { env: shell });
		assert.equal(code, 0);
		assert.equal(status.pollers.expected, true, JSON.stringify(shell));
		assert.equal(status.pollers.local, undefined);
		assert.match(status.pollers.note, /^poller: no poller has published a heartbeat/);
		assert.doesNotMatch(JSON.stringify(status), /o\/r|o\/x/);
	}
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

// Issue #1003: a Valkey that takes the connection and answers nothing held `status` open with nothing printed.
/** A promise that never settles: every read of a Valkey that answers nothing. */
const never = () => new Promise(() => {});

/**
 * `status` (or `argv`, `status --target <item>`) under a short deadline, with stderr collected. `queues` maps a queue
 * name to its paused state: null, no answer; "running, uncounted", it says it runs and never gives its counts;
 * "counted, state unknown", the reverse; "wrongtype", Valkey answers its paused state with a WRONGTYPE error and
 * counts it; "wrongtype, uncounted", both reads answered with that error; "connection failed", both reads fail with
 * no answer (issue #1053). `probe` stands in for the probe when given, and `probeError` is an error the probe reports
 * as it connects. `status` is null where nothing was printed.
 */
async function silentStatus({ argv = ["status"], queues = { "pi-jobs": null }, deadlineMs = 300, probeAnswers = false, probe = null, probeError = null } = {}) {
	let output = "";
	const asked = [], closed = [], dropAfter = [];
	const errs = [];
	const origErr = process.stderr.write.bind(process.stderr);
	const started = performance.now();
	process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
	let code;
	try {
		// The shell names the same URL, so the only stderr is status's own.
		code = await main([...argv, "--valkey-url", "redis://127.0.0.1:6379"], { VALKEY_URL: "redis://127.0.0.1:6379" }, {
			now: () => new Date(1_800_000_000_000), statusDeadlineMs: deadlineMs, write: (text) => { output += text; },
			valkeyRefusal: async (url, env, opts) => (asked.push({ ...opts, calledAt: performance.now() }), null),
			controlClients: {
				// The probe takes every command and answers none, unless `probeAnswers`: then it names the host queues.
				makeRedisClient: (_url, options) => (dropAfter.push(options?.disconnectTimeoutMs), probe ?? (probeAnswers ? {
					on() {}, disconnect() {}, async smembers() { return []; },
					async scan() { return ["0", Object.keys(queues).filter((n) => n !== "pi-jobs").map((n) => `bull:${n}:meta`)]; },
				} : {
					on(event, listener) { if (event === "error" && probeError !== null) listener(new Error(probeError)); },
					disconnect() {}, smembers: never, scan: never, sscan: never, mget: never, pttl: never, hgetall: never, eval: never,
				})),
				makeQueue: (connection, { name }) => {
					const kind = queues[name];
					dropAfter.push(connection.disconnectTimeout);
					const wrongtype = () => Promise.reject(Object.assign(new Error("WRONGTYPE Operation against a key holding the wrong kind of value"), { name: "ReplyError" }));
					const lost = () => Promise.reject(new Error("Connection is closed."));
					if (kind === "wrongtype" || kind === "wrongtype, uncounted" || kind === "connection failed") {
						const counts = kind === "wrongtype" ? () => Promise.resolve({ waiting: 2, active: 1, paused: 0, delayed: 0, failed: 0 }) : kind === "connection failed" ? lost : wrongtype;
						return { name, client: { async zrange() { return []; } }, isPaused: kind === "connection failed" ? lost : wrongtype, getJobCounts: counts, async close() { closed.push(name); } };
					}
					const paused = kind === "running, uncounted" ? false : kind === "counted, state unknown" ? null : kind;
					const counted = kind === "counted, state unknown" || (paused !== null && kind !== "running, uncounted");
					return {
						name, client: paused === null ? never() : { async zrange() { return []; } },
						isPaused: () => (paused === null ? never() : Promise.resolve(paused)),
						getJobCounts: () => (counted ? Promise.resolve({ waiting: 2, active: 1, paused: paused ? 3 : 0, delayed: 0, failed: 0 }) : never()),
						async close() { closed.push(name); },
					};
				},
			},
		});
	} finally {
		process.stderr.write = origErr;
	}
	return { code, status: output === "" ? null : JSON.parse(output), err: errs.join(""), ms: performance.now() - started, asked, closed, dropAfter };
}

test("status against a Valkey that takes the connection and answers nothing prints what it could not read and ends at its deadline (issue #1003)", { timeout: 15_000 }, async () => {
	const { code, status, err, ms, asked, closed } = await silentStatus();
	assert.ok(ms < 1500, `ended at its 300 ms deadline, not at a read's own bound or never (took ${Math.round(ms)} ms)`);
	assert.equal(asked.length, 1);
	const left = asked[0]?.deadlineAt - asked[0]?.calledAt;
	assert.ok(left > 0 && left <= 300, "the refusal check's PING is held to the same deadline");
	assert.equal(code, 1, "status could not say whether the queue is paused or what it holds");
	assert.equal(status.pausedState, null, "unknown, never false (running) for a queue nobody read");
	assert.equal(status.partial, true);
	assert.deepEqual(status.unavailableQueues, ["pi-jobs"]);
	for (const count of ["waiting", "active", "paused", "delayed", "failed"]) assert.ok(!Object.hasOwn(status, count), `${count}: a count nobody read is not a zero`);
	assert.equal(status.fleet, "registry timeout");
	assert.equal(status.waitingDetails.partial, true);
	assert.deepEqual(status.waitingDetails.unavailableQueues, ["pi-jobs"]);
	assert.equal(status.pollers.complete, false);
	assert.deepEqual(status.consumers, []);
	assert.equal(status.queuesMayBeShort, true, "the registry and the scan did not answer (issue #1043)");
	const warned = `warning: ${statusShortNote(false)}\n`;
	assert.ok(err.startsWith(warned), err);
	assert.match(err.slice(warned.length), /^error: Valkey at redis:\/\/127\.0\.0\.1:6379 did not answer within 0\.3 seconds: is it running\? .*\n {2}the line above leaves out the paused state and counts of pi-jobs\n$/);
	assert.deepEqual(closed, [], "the deadline was spent before the queues: none was built, so none is left half open");
	// A connection that never came up is said in the connection's own words, as before the deadline.
	const unreached = await silentStatus({ probeError: "nothing answers VALKEY_URL (127.0.0.1:6379), so whose Valkey it is cannot be judged yet" });
	assert.equal(unreached.code, 1);
	assert.match(unreached.err, /\nerror: could not reach Valkey at redis:\/\/127\.0\.0\.1:6379: is it running\? .*\n {2}nothing answers VALKEY_URL \(127\.0\.0\.1:6379\), so whose Valkey it is cannot be judged yet\n {2}the line above leaves out the paused state and counts of pi-jobs\n$/);
});

test("status counts the queues that answered by its deadline and names the one that did not, and pausedState is decided only by what answered (issue #1003)", { timeout: 15_000 }, async () => {
	// One queue running is enough to say not every queue is paused.
	const running = await silentStatus({ probeAnswers: true, queues: { "pi-jobs": false, "pi-jobs@mini2": null } });
	assert.equal(running.code, 1);
	assert.ok(running.ms < 1500, `took ${Math.round(running.ms)} ms`);
	assert.equal(running.status.pausedState, false);
	assert.equal(running.status.pausedPartial, undefined);
	assert.deepEqual([running.status.waiting, running.status.active], [2, 1], "the queue that answered, alone");
	assert.deepEqual(running.status.unavailableQueues, ["pi-jobs@mini2"]);
	assert.deepEqual(running.status.waitingDetails.unavailableQueues, ["pi-jobs@mini2"]);
	assert.deepEqual(running.closed, ["pi-jobs", "pi-jobs@mini2"], "every queue built is closed");
	// ioredis' own disconnect timer (two seconds, ref'd) would hold the process past the line on a Valkey that never
	// closes the socket: the probe and every queue drop theirs at once.
	assert.deepEqual(running.dropAfter, [0, 0, 0]);
	assert.equal(running.err, "error: Valkey at redis://127.0.0.1:6379 did not answer every read within 0.3 seconds\n  the line above leaves out the paused state and counts of pi-jobs@mini2\n", "Valkey answered, so no \"is it running?\"");
	// Every queue that answered is paused, and one did not answer: it may be running.
	const unknown = await silentStatus({ probeAnswers: true, queues: { "pi-jobs": true, "pi-jobs@mini2": null } });
	assert.equal(unknown.status.pausedState, null);
	assert.equal(unknown.status.pausedPartial, undefined);
	assert.equal(unknown.status.paused, 3);
	// Paused and running both answered: partly paused, whatever the third says.
	const partly = await silentStatus({ probeAnswers: true, queues: { "pi-jobs": true, "pi-jobs@mini2": false, "pi-jobs@mini3": null } });
	assert.equal(partly.status.pausedState, false);
	assert.equal(partly.status.pausedPartial, true);
	assert.deepEqual(partly.status.pausedQueues, ["pi-jobs"]);
	assert.deepEqual(partly.status.unavailableQueues, ["pi-jobs@mini3"]);
	// A queue that gave one of the two is named too, and the sentence says which of the two each queue lacks.
	const halves = await silentStatus({ probeAnswers: true, queues: { "pi-jobs": true, "pi-jobs@mini2": "running, uncounted", "pi-jobs@mini3": "counted, state unknown", "pi-jobs@mini4": null } });
	assert.equal(halves.code, 1);
	assert.equal(halves.status.pausedState, false, "mini2 answered that it runs");
	assert.equal(halves.status.pausedPartial, true);
	assert.deepEqual(halves.status.pausedQueues, ["pi-jobs"]);
	assert.equal(halves.status.active, 2, "the counted queues' alone: pi-jobs and mini3");
	assert.deepEqual(halves.status.unavailableQueues, ["pi-jobs@mini2", "pi-jobs@mini3", "pi-jobs@mini4"]);
	assert.match(halves.err, /\n {2}the line above leaves out the paused state and counts of pi-jobs@mini4; the paused state of pi-jobs@mini3; the counts of pi-jobs@mini2\n$/);
	// Every queue answered: the line and the exit code as before.
	const whole = await silentStatus({ probeAnswers: true, queues: { "pi-jobs": true, "pi-jobs@mini2": true } });
	assert.equal(whole.code, 0);
	assert.equal(whole.status.pausedState, true);
	assert.ok(!Object.hasOwn(whole.status, "partial") && !Object.hasOwn(whole.status, "unavailableQueues"));
	assert.equal(whole.err, "");
	// A consumer's demand that does not answer ends at the deadline too, and reads as unknown, as it did at its own bound;
	// the queues answered, so the exit code is as before.
	const at = 1_800_000_000_000;
	const rows = ["shared", "host", "sandbox"].map((role) => ({ role, state: "running", connection: "ready", active: 0, rateLimited: false, lastFetchAt: at, lastSuccessAt: null, lastTakenAt: null, fetchAgeMs: 0, successAgeMs: null }));
	const demand = await silentStatus({
		queues: { "pi-jobs": false },
		probe: {
			on() {}, disconnect() {}, async smembers() { return ["build3"]; }, async scan() { return ["0", []]; }, async pttl() { return 90000; },
			async hgetall() { return { name: "build3", routes: "false", startedAt: String(at), beatAt: String(at), consumers: JSON.stringify({ v: 1, startedAt: at, rows: rows.filter((c) => c.role !== "host") }) }; },
			eval: never,
		},
	});
	assert.ok(demand.ms < 1500, `took ${Math.round(demand.ms)} ms`);
	assert.equal(demand.code, 0);
	assert.equal(demand.status.consumers[0].state, "unknown", "an unanswered demand corroborates no stall");
	assert.equal(demand.status.partial, undefined);
});

test("status run as its own process through a real Valkey's frozen proxy ends at its deadline and exits at its last line, the refusal check included (issue #1003, VALKEY_TEST_URL)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL", timeout: 30_000 }, async () => {
	const { freezingProxy } = await import("./helpers/freezing-proxy.mjs");
	const proxy = await freezingProxy(process.env.VALKEY_TEST_URL);
	proxy.freeze();
	// The real CLI's `main`, its real clients and its real refusal check, in a process of its own, which says how long
	// `main` took and how long the process outlived it: a client's disconnect timer outlives a socket nobody closes.
	const child = `
		const { main } = await import(${JSON.stringify(new URL("../src/cli.mjs", import.meta.url).href)});
		const started = performance.now();
		const code = await main(["status", "--valkey-url", process.env.VALKEY_URL], process.env, { statusDeadlineMs: 400 });
		const returned = performance.now();
		process.exitCode = code;
		process.on("exit", () => process.stderr.write("TIMES " + JSON.stringify({ main: returned - started, after: performance.now() - returned }) + "\\n"));
	`;
	let result;
	try {
		result = await new Promise((resolve) => {
			execFile(process.execPath, ["--input-type=module", "-e", child], { cwd: tempDir("pd-1003-status-"), env: { ...process.env, VALKEY_URL: proxy.url }, timeout: 20_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
		});
	} finally {
		proxy.close();
	}
	const times = JSON.parse(/^TIMES (.*)$/m.exec(result.stderr)?.[1] ?? "null");
	assert.ok(times, result.stderr);
	assert.ok(times.main < 3000, `main ended at its 400 ms deadline, before any read's own two seconds (took ${Math.round(times.main)} ms)`);
	assert.ok(times.after < 1000, `the process ended with its last line, not two seconds later (it lingered ${Math.round(times.after)} ms)`);
	assert.equal(result.code, 1);
	const status = JSON.parse(result.stdout);
	assert.equal(status.pausedState, null);
	assert.deepEqual(status.unavailableQueues, ["pi-jobs"]);
	assert.equal(status.pollers.complete, false);
	assert.match(result.stderr, /did not answer within 0\.4 seconds/);
	assert.doesNotMatch(result.stderr, /Unhandled error event/, "no queue was left to fail its ready check after it closed");
});

/** `argv` through a real Valkey's proxy that freezes once a queue's connection is ready: its reads go unanswered and BullMQ's close sends QUIT. */
async function frozenAfterReady(argv, deadlineMs) {
	const { makeQueue } = await import("../src/queue.mjs");
	const { freezingProxy } = await import("./helpers/freezing-proxy.mjs");
	const proxy = await freezingProxy(process.env.VALKEY_TEST_URL);
	let output = "";
	const origErr = process.stderr.write.bind(process.stderr);
	process.stderr.write = () => true;
	const started = performance.now();
	let code;
	try {
		code = await main([...argv, "--valkey-url", proxy.url], { VALKEY_URL: proxy.url }, {
			statusDeadlineMs: deadlineMs, cwd: tempDir("pd-1003-status-"), valkeyRefusal: async () => null, write: (text) => { output += text; },
			controlClients: {
				makeQueue: (connection, opts) => {
					const queue = makeQueue(connection, opts);
					const ready = queue.client.then(() => proxy.freeze());
					return {
						name: queue.name, client: ready.then(() => queue.client),
						isPaused: () => ready.then(() => queue.isPaused()),
						getJobCounts: (...states) => ready.then(() => queue.getJobCounts(...states)),
						close: () => queue.close(), disconnect: () => queue.disconnect(),
					};
				},
			},
		});
	} finally {
		process.stderr.write = origErr;
		proxy.close();
	}
	return { code, line: JSON.parse(output), ms: performance.now() - started };
}

test("status drops a queue whose Valkey stops answering after it is ready instead of waiting on its QUIT (issue #1003, VALKEY_TEST_URL)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL", timeout: 20_000 }, async () => {
	const { code, line, ms } = await frozenAfterReady(["status"], 800);
	assert.ok(ms < 1500, `ended at its 800 ms deadline, the close included (took ${Math.round(ms)} ms)`);
	assert.equal(code, 1);
	assert.ok(line.unavailableQueues.includes("pi-jobs"));
});

test("status --target against a Valkey that answers nothing ends at the same deadline, builds no queue once it is spent, and exits 0 with complete false (issue #1003)", { timeout: 15_000 }, async () => {
	const silent = await silentStatus({ argv: ["status", "--target", "owner/repo#12"] });
	assert.ok(silent.ms < 1500, `took ${Math.round(silent.ms)} ms`);
	const left = silent.asked[0]?.deadlineAt - silent.asked[0]?.calledAt;
	assert.ok(left > 0 && left <= 300, "the refusal check's PING is held to the deadline");
	assert.equal(silent.code, 0, "complete false already says the line may be short");
	assert.deepEqual(silent.status, { item: "owner/repo#12", jobs: [], windows: [], complete: false, unavailableQueues: ["pi-jobs"], discoveryIncomplete: true, queuesMayBeShort: true, fleet: "registry timeout" });
	assert.equal(silent.err, `warning: ${statusShortNote(true)}\n`, "the sentence under the line, as plain status says it (issue #1043)");
	assert.deepEqual(silent.closed, []);
	// The discovery answers and the queue does not: the read ends at the deadline, and the probe and the queue drop
	// their sockets at once.
	const quiet = await silentStatus({ argv: ["status", "--target", "owner/repo#12"], probeAnswers: true });
	assert.ok(quiet.ms < 1500, `took ${Math.round(quiet.ms)} ms`);
	assert.equal(quiet.code, 0);
	assert.equal(quiet.status.complete, false);
	assert.deepEqual(quiet.status.unavailableQueues, ["pi-jobs"]);
	assert.deepEqual(quiet.closed, ["pi-jobs"]);
	assert.deepEqual(quiet.dropAfter, [0, 0]);
});

test("status --target drops a queue whose Valkey stops answering after it is ready instead of waiting on its QUIT (issue #1003, VALKEY_TEST_URL)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL", timeout: 20_000 }, async () => {
	const { code, line, ms } = await frozenAfterReady(["status", "--target", "owner/repo#12"], 800);
	assert.ok(ms < 1500, `ended at its 800 ms deadline, the close included (took ${Math.round(ms)} ms)`);
	assert.equal(code, 0);
	assert.equal(line.complete, false);
	assert.ok(line.unavailableQueues.includes("pi-jobs"));
});

// Issue #1007: `pause` and `resume` waited for as long as a Valkey that stopped answering stayed so, printed nothing, and
// could leave the deployment half switched without saying so.
/**
 * `pause` or `resume` under a short deadline over fake queues, with stderr collected. `queues` maps a name to how its
 * queue behaves: "ok" (connected, and the write answered), "slow ok" (answered after 50 ms), "silent write" (connected,
 * the write never answered), "no connection" (never connected), "refused connection" (its connection failed), "valkey
 * error" (Valkey refused the EVALSHA before the script ran, the measured NOPERM), "lost after send" (the connection
 * closed under the write), and "script error, paused", "script error, running", "script error, unread" or "script
 * error, read refused" (an error raised inside the script, in Valkey's measured words, with the queue read back as
 * paused, as running, not answering, or answered with Valkey's own error). A probe that does not answer (`probeAnswers: false`) leaves the shared queue alone, the fail-open rule;
 * `probe` stands in for the probe when given.
 */
async function silentSwitch(cmd, { queues = { "pi-jobs": "ok" }, deadlineMs = 300, probeAnswers = true, probe = null } = {}) {
	let output = "";
	const wrote = [], closed = [], dropAfter = [], asked = [];
	const errs = [];
	const origErr = process.stderr.write.bind(process.stderr);
	const started = performance.now();
	process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
	const reply = (message) => Object.assign(new Error(message), { name: "ReplyError" });
	let code;
	try {
		code = await main([cmd, "--valkey-url", "redis://127.0.0.1:6379"], { VALKEY_URL: "redis://127.0.0.1:6379" }, {
			statusDeadlineMs: deadlineMs, cwd: tempDir("pd-1007-silent-"), write: (text) => { output += text; },
			valkeyRefusal: async (url, env, opts) => (asked.push({ ...opts, calledAt: performance.now() }), null),
			controlClients: {
				makeRedisClient: (_url, options) => (dropAfter.push(options?.disconnectTimeoutMs), probe ?? (probeAnswers ? {
					on() {}, disconnect() {}, async smembers() { return []; },
					async scan() { return ["0", Object.keys(queues).filter((n) => n !== "pi-jobs").map((n) => `bull:${n}:meta`)]; },
				} : { on() {}, disconnect() {}, smembers: never, scan: never })),
				makeQueue: (connection, { name }) => {
					const kind = queues[name];
					dropAfter.push(connection.disconnectTimeout);
					const act = () => {
						wrote.push(name);
						if (kind === "silent write") return never();
						if (kind === "slow ok") return new Promise((resolve) => setTimeout(resolve, 50));
						if (kind === "valkey error") return Promise.reject(reply(NOPERM_EVALSHA));
						if (kind === "lost after send") return Promise.reject(new Error("Connection is closed."));
						if (kind.startsWith("script error")) return Promise.reject(reply(WRONGTYPE_IN_SCRIPT));
						return Promise.resolve();
					};
					const readBack = { "script error, paused": true, "script error, running": false }[kind];
					const readRefused = kind === "script error, read refused";
					return {
						name,
						client: kind === "no connection" ? never() : kind === "refused connection" ? Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:6379")) : Promise.resolve({}),
						pause: act, resume: act,
						isPaused: () => (readRefused ? Promise.reject(reply("WRONGTYPE Operation against a key holding the wrong kind of value")) : readBack === undefined ? never() : Promise.resolve(readBack)),
						async close() { closed.push(name); },
					};
				},
			},
		});
	} finally {
		process.stderr.write = origErr;
	}
	return { code, out: output, err: errs.join(""), ms: performance.now() - started, wrote, closed, dropAfter, asked };
}

const PAUSE_NEXT = "  run pi-dispatch status once Valkey answers to see each queue, then pi-dispatch pause again\n";
// Valkey's own words, measured: an ACL that denies EVALSHA refuses before the script runs; an error inside a script
// names the script, and what the script wrote before it stays written.
const NOPERM_EVALSHA = "NOPERM User op has no permissions to run the 'evalsha' command";
const WRONGTYPE_IN_SCRIPT = "WRONGTYPE Operation against a key holding the wrong kind of value script: b4514f4b39660691beec2ab3023b9b46b093b439, on @user_script:57.";

test("a refusal counts as before the script only in the codes Valkey gives before running one, and never when the message names the script (issue #1007)", () => {
	const reply = (message) => Object.assign(new Error(message), { name: "ReplyError" });
	for (const message of [NOPERM_EVALSHA, "NOPERM User op has no permissions to run the 'eval' command", "READONLY You can't write against a read only replica.", "LOADING Valkey is loading the dataset in memory", "BUSY Valkey is busy running a script. You can only call SCRIPT KILL or SHUTDOWN NOSAVE.", "MASTERDOWN Link with MASTER is down and replica-serve-stale-data is set to 'no'.", "NOSCRIPT No matching script. Please use EVAL."]) {
		assert.equal(refusedBeforeScript(reply(message)), true, message);
	}
	for (const message of [WRONGTYPE_IN_SCRIPT, "ERR ACL failure in script: User op has no permissions to run the 'hset' command script: 5eded3bf426091e7c63bb61fea48e99bda3199fa, on @user_script:1.", "NOPERM inside script: 5eded3bf426091e7c63bb61fea48e99bda3199fa, on @user_script:1.", "OOM command not allowed when used memory > 'maxmemory'.", "ERR unknown command"]) {
		assert.equal(refusedBeforeScript(reply(message)), false, message);
	}
	assert.equal(refusedBeforeScript(new Error(NOPERM_EVALSHA)), false, "only Valkey's own reply");
});

test("pause ends at its deadline and says of each queue whether it was paused, sent and not confirmed, refused or not sent (issue #1007)", { timeout: 15_000 }, async () => {
	const mixed = await silentSwitch("pause", { queues: { "pi-jobs": "ok", "pi-jobs@mini2": "silent write", "pi-jobs@mini3": "no connection" } });
	assert.ok(mixed.ms < 500, `ended at its 300 ms deadline (took ${Math.round(mixed.ms)} ms)`);
	const left = mixed.asked[0]?.deadlineAt - mixed.asked[0]?.calledAt;
	assert.ok(left > 0 && left <= 300, "the refusal check's PING is held to the same deadline");
	assert.equal(mixed.code, 1, "a queue not confirmed is a failure");
	assert.equal(mixed.out, "");
	assert.equal(mixed.err, "error: could not pause the whole deployment at redis://127.0.0.1:6379\n"
		+ "  pi-jobs: paused\n"
		+ "  pi-jobs@mini2: sent, not confirmed (no answer within 0.3 seconds); it may still be paused when Valkey answers\n"
		+ "  pi-jobs@mini3: not sent (no connection within 0.3 seconds)\n" + PAUSE_NEXT);
	assert.deepEqual(mixed.wrote.sort(), ["pi-jobs", "pi-jobs@mini2"], "a queue that never connected was never written to");
	assert.deepEqual(mixed.closed.sort(), ["pi-jobs", "pi-jobs@mini2", "pi-jobs@mini3"]);
	assert.deepEqual(mixed.dropAfter, [0, 0, 0, 0], "the probe and each queue drop their sockets at once");
	// Valkey's own refusal changed nothing; a connection that failed first sent nothing; one that closed under the write
	// may have taken it. No "nothing changed" once a write left.
	const failed = await silentSwitch("pause", { queues: { "pi-jobs": "valkey error", "pi-jobs@mini2": "refused connection", "pi-jobs@mini3": "lost after send" } });
	assert.equal(failed.code, 1);
	assert.equal(failed.err, "error: could not pause the whole deployment at redis://127.0.0.1:6379\n"
		+ `  pi-jobs: refused by Valkey, unchanged (${NOPERM_EVALSHA})\n`
		+ "  pi-jobs@mini2: not sent (connect ECONNREFUSED 127.0.0.1:6379)\n"
		+ "  pi-jobs@mini3: sent, not confirmed (Connection is closed.); it may still be paused when Valkey answers\n" + PAUSE_NEXT);
	// A Valkey that answers nothing: the deadline is spent before any queue is built, nothing was sent, and the list
	// of queues itself may be short.
	const silent = await silentSwitch("pause", { probeAnswers: false });
	assert.ok(silent.ms < 500, `the writes share the deadline the discovery spent (took ${Math.round(silent.ms)} ms)`);
	assert.equal(silent.code, 1);
	assert.equal(silent.err, "error: could not pause the whole deployment at redis://127.0.0.1:6379 [registry unreadable: registry timeout] [queue scan incomplete]\n"
		+ "  pi-jobs: not sent (no connection within 0.3 seconds)\n"
		+ "  nothing changed\n"
		+ `  ${killSwitchShortNote(true)}\n` + PAUSE_NEXT);
	assert.deepEqual(silent.closed, [], "no queue was built once the deadline was spent");
	// Every queue at once: a queue whose write is never answered does not hold back the next one's.
	const atOnce = await silentSwitch("pause", { queues: { "pi-jobs": "silent write", "pi-jobs@mini2": "slow ok" } });
	assert.match(atOnce.err, /\n {2}pi-jobs@mini2: paused\n/);
	// An error raised inside the script may follow a switch it already made: the queue is read back and said as it is,
	// it counts as written (no "nothing changed"), and a read back that does not answer says it may have partly applied.
	const inScript = await silentSwitch("pause", { queues: { "pi-jobs": "script error, paused", "pi-jobs@mini2": "script error, running", "pi-jobs@mini3": "script error, unread" } });
	assert.equal(inScript.code, 1);
	assert.equal(inScript.err, "error: could not pause the whole deployment at redis://127.0.0.1:6379\n"
		+ `  pi-jobs: Valkey answered with an error (${WRONGTYPE_IN_SCRIPT}); it reads paused now\n`
		+ `  pi-jobs@mini2: Valkey answered with an error (${WRONGTYPE_IN_SCRIPT}); it reads running now, and part of the pause may have applied\n`
		+ `  pi-jobs@mini3: Valkey answered with an error (${WRONGTYPE_IN_SCRIPT}); it may have partly applied\n` + PAUSE_NEXT);
	// A read back that did not answer waits on Valkey; one that Valkey answered with an error (the meta key holding a
	// string, say) is Valkey answering, so the next step is putting its cause right.
	const unread = await silentSwitch("pause", { queues: { "pi-jobs": "script error, unread" } });
	assert.equal(unread.err, "error: could not pause the whole deployment at redis://127.0.0.1:6379\n"
		+ `  pi-jobs: Valkey answered with an error (${WRONGTYPE_IN_SCRIPT}); it may have partly applied\n` + PAUSE_NEXT);
	const readRefused = await silentSwitch("pause", { queues: { "pi-jobs": "script error, read refused" } });
	assert.equal(readRefused.err, "error: could not pause the whole deployment at redis://127.0.0.1:6379\n"
		+ `  pi-jobs: Valkey answered with an error (${WRONGTYPE_IN_SCRIPT}); it may have partly applied\n`
		+ "  run pi-dispatch status to see each queue, then pi-dispatch pause again once what Valkey refused or failed on is put right\n");
	// A refusal before the script changed nothing, and the next step is not waiting on Valkey.
	const refused = await silentSwitch("pause", { queues: { "pi-jobs": "valkey error" } });
	assert.equal(refused.err, "error: could not pause the whole deployment at redis://127.0.0.1:6379\n"
		+ `  pi-jobs: refused by Valkey, unchanged (${NOPERM_EVALSHA})\n`
		+ "  nothing changed\n"
		+ "  run pi-dispatch status to see each queue, then pi-dispatch pause again once what Valkey refused or failed on is put right\n");
	// A write sent and not answered is enough to fail: the queue may or may not be paused.
	const doubt = await silentSwitch("pause", { queues: { "pi-jobs": "ok", "pi-jobs@mini2": "silent write" } });
	assert.equal(doubt.code, 1);
	assert.equal(doubt.out, "", "never the line that says the deployment is paused");
	// Every queue answered: the line and the exit code as before.
	const whole = await silentSwitch("pause", { queues: { "pi-jobs": "ok", "pi-jobs@mini2": "ok", "pi-jobs@mini3": "ok" } });
	assert.deepEqual([whole.code, whole.out, whole.err], [0, "paused: worker will stop taking new jobs (jobs still enqueue) [3 queues]\n", ""]);
});

test("resume ends at its deadline, sends no resume after one that is not confirmed, and says of each queue what it is (issue #1007)", { timeout: 15_000 }, async () => {
	const stuck = await silentSwitch("resume", { queues: { "pi-jobs": "ok", "pi-jobs@mini2": "silent write", "pi-jobs@mini3": "ok" } });
	assert.ok(stuck.ms < 500, `took ${Math.round(stuck.ms)} ms`);
	assert.equal(stuck.code, 1);
	assert.equal(stuck.err, "error: could not resume the whole deployment at redis://127.0.0.1:6379\n"
		+ "  pi-jobs: resumed\n"
		+ "  pi-jobs@mini2: sent, not confirmed (no answer within 0.3 seconds); it may still be resumed when Valkey answers\n"
		+ "  pi-jobs@mini3: not sent (not tried after a queue whose resume is not confirmed: a resume that lands later starts jobs)\n"
		+ "  run pi-dispatch status once Valkey answers to see each queue, then pi-dispatch resume again; a resume not confirmed may start jobs when it lands\n");
	assert.deepEqual(stuck.wrote, ["pi-jobs", "pi-jobs@mini2"], "one after another, and none after the one in doubt");
	const left = stuck.asked[0]?.deadlineAt - stuck.asked[0]?.calledAt;
	assert.ok(left > 0 && left <= 300, "the refusal check's PING is held to the same deadline");
	// An error inside the script stops the resume as a doubt does, and the queue is said as Valkey holds it.
	const errored = await silentSwitch("resume", { queues: { "pi-jobs": "script error, running", "pi-jobs@mini2": "ok" } });
	assert.equal(errored.err, "error: could not resume the whole deployment at redis://127.0.0.1:6379\n"
		+ `  pi-jobs: Valkey answered with an error (${WRONGTYPE_IN_SCRIPT}); it reads running now\n`
		+ "  pi-jobs@mini2: not sent (not tried after a queue whose resume Valkey answered with an error)\n"
		+ "  run pi-dispatch status to see each queue, then pi-dispatch resume again once what Valkey refused or failed on is put right\n");
	assert.deepEqual(errored.wrote, ["pi-jobs"]);
	const refused = await silentSwitch("resume", { queues: { "pi-jobs": "valkey error", "pi-jobs@mini2": "ok" } });
	assert.match(refused.err, /\n {2}pi-jobs@mini2: not sent \(not tried after a queue whose resume Valkey refused\)\n {2}nothing changed\n/);
	const whole = await silentSwitch("resume", { queues: { "pi-jobs": "ok", "pi-jobs@mini2": "ok", "pi-jobs@mini3": "ok" } });
	assert.deepEqual([whole.code, whole.out, whole.err], [0, "resumed [3 queues]\n", ""]);
	assert.deepEqual(whole.wrote, ["pi-jobs", "pi-jobs@mini2", "pi-jobs@mini3"]);
});

/** `cmd` through a real Valkey's proxy that freezes at the first queue's write, so no write reaches Valkey. */
async function frozenAtWrite(cmd, deadlineMs) {
	const { makeQueue } = await import("../src/queue.mjs");
	const { freezingProxy } = await import("./helpers/freezing-proxy.mjs");
	const proxy = await freezingProxy(process.env.VALKEY_TEST_URL);
	const errs = [];
	const origErr = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
	const started = performance.now();
	let code;
	try {
		code = await main([cmd, "--valkey-url", proxy.url], { VALKEY_URL: proxy.url }, {
			statusDeadlineMs: deadlineMs, cwd: tempDir("pd-1007-switch-"), valkeyRefusal: async () => null, write: () => {},
			controlClients: {
				makeQueue: (connection, opts) => {
					const queue = makeQueue(connection, opts);
					const act = (verb) => () => { proxy.freeze(); return queue[verb](); };
					return { name: queue.name, client: queue.client, pause: act("pause"), resume: act("resume"), close: () => queue.close(), disconnect: () => queue.disconnect() };
				},
			},
		});
	} finally {
		process.stderr.write = origErr;
		proxy.close();
	}
	return { code, lines: errs.join("").split("\n"), ms: performance.now() - started };
}

test("pause and resume through a real Valkey that stops answering at the write end at their deadline and report the write as sent and not confirmed (issue #1007, VALKEY_TEST_URL)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL", timeout: 30_000 }, async () => {
	for (const cmd of ["pause", "resume"]) {
		const { code, lines, ms } = await frozenAtWrite(cmd, 800);
		assert.ok(ms < 1500, `${cmd} ended at its 800 ms deadline, the close included (took ${Math.round(ms)} ms)`);
		assert.equal(code, 1, cmd);
		assert.ok(lines.some((l) => / sent, not confirmed \(no answer within 0\.8 seconds\)/.test(l)), `${cmd}: ${lines.join(" / ")}`);
		assert.ok(!lines.some((l) => /: (paused|resumed)$/.test(l) || l === "  nothing changed"), "no write was answered, and one was sent");
	}
});

test("pause and resume against a real Valkey whose script fails after it switched the queue say the queue as Valkey holds it, never unchanged (issue #1007, VALKEY_TEST_URL)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL", timeout: 30_000 }, async () => {
	const { makeQueue } = await import("../src/queue.mjs");
	const { makeRedisClient } = await import("../src/connection.mjs");
	const url = process.env.VALKEY_TEST_URL;
	// Every queue the kill switch names is one of this test's own on that Valkey (its name prefixed), so no other test's
	// queue is paused, and the shared queue's events stream is never touched.
	const prefix = `pd1007-${process.pid}-${Date.now()}-`;
	const direct = makeRedisClient(url);
	direct.on("error", () => {});
	const run = async (cmd) => {
		const errs = [];
		const origErr = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
		try {
			const code = await main([cmd, "--valkey-url", url], { VALKEY_URL: url }, {
				cwd: tempDir("pd-1007-script-"), valkeyRefusal: async () => null, write: () => {},
				controlClients: { makeQueue: (connection, { name }) => makeQueue(connection, { name: `${prefix}${name}` }) },
			});
			return { code, err: errs.join("") };
		} finally {
			process.stderr.write = origErr;
		}
	};
	const meta = `bull:${prefix}pi-jobs:meta`;
	try {
		// BullMQ's pause script moves the jobs and flips the flag, then XADDs to the events stream: a string there fails
		// the script after the switch.
		await direct.set(`bull:${prefix}pi-jobs:events`, "not a stream");
		const paused = await run("pause");
		assert.equal(paused.code, 1);
		assert.match(paused.err, /\n {2}pi-jobs: Valkey answered with an error \(WRONGTYPE [^\n]*user_script[^\n]*\); it reads paused now\n/, paused.err);
		assert.doesNotMatch(paused.err, /nothing changed|refused by Valkey/);
		assert.equal(await direct.hexists(meta, "paused"), 1, "paused, as said");
		const resumed = await run("resume");
		assert.equal(resumed.code, 1);
		assert.match(resumed.err, /\n {2}pi-jobs: Valkey answered with an error \(WRONGTYPE [^\n]*\); it reads running now\n/, resumed.err);
		assert.equal(await direct.hexists(meta, "paused"), 0, "running again, as said: the dangerous direction");
	} finally {
		let cursor = "0";
		do {
			const [next, keys] = await direct.scan(cursor, "MATCH", `bull:${prefix}*`, "COUNT", 500);
			cursor = String(next);
			if (keys.length > 0) await direct.del(...keys);
		} while (cursor !== "0");
		direct.disconnect();
	}
});

test("pause and resume that confirm every queue they found over a list that may be short print the line and the fleet's sentence and exit 0, and one that also left a found queue unconfirmed exits 1 (issues #964, #1007)", { timeout: 15_000 }, async () => {
	// The scan failed: every queue found was paused, so the switch is said as done, with what a list that may be short
	// means under it (issue #964), as the console answers it.
	const unscanned = await silentSwitch("pause", { probe: { on() {}, disconnect() {}, async smembers() { return []; }, async scan() { throw new Error("scan refused"); } } });
	assert.deepEqual([unscanned.code, unscanned.err], [0, ""]);
	assert.equal(unscanned.out, `paused: worker will stop taking new jobs (jobs still enqueue) [queue scan incomplete]\n  but ${killSwitchShortNote(true)}\n`);
	// The registry could not be read: the same, for a resume.
	const blind = await silentSwitch("resume", { probe: { on() {}, disconnect() {}, async smembers() { throw new Error("registry refused"); }, async scan() { return ["0", []]; } } });
	assert.deepEqual([blind.code, blind.err], [0, ""]);
	assert.equal(blind.out, `resumed [registry unreadable: registry refused]\n  but ${killSwitchShortNote(false)}\n`);
	// A found queue not confirmed over such a list: the report, with the scan's words on its first line and the fleet's
	// sentence before what to do, exit 1.
	const doubt = await silentSwitch("pause", { queues: { "pi-jobs": "silent write" }, probe: { on() {}, disconnect() {}, async smembers() { return []; }, async scan() { throw new Error("scan refused"); } } });
	assert.deepEqual([doubt.code, doubt.out], [1, ""]);
	assert.equal(doubt.err, "error: could not pause the whole deployment at redis://127.0.0.1:6379 [queue scan incomplete]\n"
		+ "  pi-jobs: sent, not confirmed (no answer within 0.3 seconds); it may still be paused when Valkey answers\n"
		+ `  ${killSwitchShortNote(true)}\n` + PAUSE_NEXT);
});

// Issue #1042: Valkey answers one connection's commands in order, so the look for this host's own queue's meta key waited
// behind a scan that stalled on the probe's connection, until its bound, and the resume left that queue paused.
/**
 * A fake client that answers its commands in order, as one Valkey connection does: one that never settles holds the rest.
 * `hosts` are registry rows (`readLiveHosts` reads them by HGETALL); `disconnected` counts its `disconnect()` calls.
 */
function inOrderClient({ scan = never, exists = async () => 1, hosts = [] } = {}) {
	let last = Promise.resolve();
	const sent = [];
	const queued = (name, answer) => (...args) => {
		sent.push(name);
		const reply = last.then(() => answer(...args));
		last = reply.catch(() => {});
		return reply;
	};
	const client = {
		sent, disconnected: 0, on() {}, disconnect() { client.disconnected += 1; },
		smembers: queued("SMEMBERS", async () => hosts),
		hgetall: queued("HGETALL", async (key) => ({ name: String(key).split(":").at(-1), routes: "true", beatAt: "1800000000000" })),
		scan: queued("SCAN", scan), exists: queued("EXISTS", exists),
	};
	return client;
}

/**
 * `resume` from a deployment whose .env holds `envFile`, over `inOrderClient`s built from `client` (or `makeClient(i)`
 * for the i-th client asked for), with stderr collected; past the scan's own two seconds by default, so a scan that never
 * answers ends at its bound with time left to resume.
 */
async function resumeInOrder(dir, envFile, client = {}, { makeClient = null, deadlineMs = 3_000 } = {}) {
	writeFileSync(join(dir, ".env"), envFile);
	const clients = [];
	const resumed = [];
	const errs = [];
	let out = "";
	const origErr = process.stderr.write;
	process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
	const started = performance.now();
	let code;
	try {
		code = await main(["resume"], { VALKEY_URL: "redis://127.0.0.1:1/15" }, {
			cwd: dir, statusDeadlineMs: deadlineMs, write: (text) => { out += text; }, valkeyRefusal: async () => null,
			controlClients: {
				makeRedisClient: () => { const c = makeClient ? makeClient(clients.length) : inOrderClient(client); clients.push(c); return c; },
				makeQueue: (_c, { name }) => ({ name, client: Promise.resolve({}), async resume() { resumed.push(name); }, async close() {} }),
			},
		});
	} finally {
		process.stderr.write = origErr;
	}
	return { code, out, err: errs.join(""), resumed, clients, ms: performance.now() - started };
}

const replyError = (message) => Object.assign(new Error(message), { name: "ReplyError" });

test("a resume whose queue scan stalls reads this host's own queue on a connection of its own and resumes it, and names it when that read does not answer either (#1042)", { timeout: 20_000 }, async () => {
	const dir = tempDir("pd-1042-own-");
	const own = "PI_WORKER_NAME=hosta\n";
	// The scan never answers and the meta key exists: the resume reaches the queue, read on a client that sent no scan,
	// and that client is dropped once it answered.
	const stalled = await resumeInOrder(dir, own);
	assert.deepEqual([stalled.code, stalled.resumed], [0, ["pi-jobs", "pi-jobs@hosta"]], stalled.err);
	assert.equal(stalled.out, `resumed [2 queues] [queue scan incomplete]\n  but ${killSwitchShortNote(false)}\n`);
	const asking = stalled.clients.filter((c) => c.sent.includes("EXISTS"));
	assert.deepEqual(asking.map((c) => [c.sent, c.disconnected]), [[["EXISTS"], 1]], "the meta key is read on a client of its own, never behind the scan, and that client is dropped");
	// Valkey answers the read with an error: whether the queue exists is not known, so the report names it as not resumed,
	// exit 1, and the other queues are resumed as before. Valkey answered, so the advice is to put the cause right, not
	// to wait for an answer.
	const refused = await resumeInOrder(dir, own, { exists: () => Promise.reject(replyError("ERR unknown command 'exists', with args beginning with: 'bull:pi-jobs@hosta:meta' ")) });
	assert.deepEqual([refused.code, refused.resumed, refused.out], [1, ["pi-jobs"], ""]);
	assert.equal(refused.err, "error: could not resume the whole deployment at redis://127.0.0.1:1/15 [queue scan incomplete]\n"
		+ "  pi-jobs: resumed\n"
		+ "  pi-jobs@hosta: not sent (whether it exists could not be read: ERR unknown command 'exists', with args beginning with: 'bull:pi-jobs@hosta:meta' )\n"
		+ `  ${killSwitchShortNote(false)}\n`
		+ "  run pi-dispatch status to see each queue, then pi-dispatch resume again once what Valkey refused or failed on is put right\n");
	// A read whose connection was lost got no answer: then the advice is to wait for one.
	const lost = await resumeInOrder(dir, own, { exists: () => Promise.reject(new Error("Connection is closed.")) });
	assert.equal(lost.code, 1);
	assert.ok(lost.err.endsWith("  pi-jobs@hosta: not sent (whether it exists could not be read: Connection is closed.)\n"
		+ `  ${killSwitchShortNote(false)}\n`
		+ "  run pi-dispatch status once Valkey answers to see each queue, then pi-dispatch resume again\n"), lost.err);
	// A client that cannot even be made has answered nothing either, and the queue is named the same way.
	const unmade = await resumeInOrder(dir, own, {}, { makeClient: (i) => { if (i === 1) throw new Error("no client for that address"); return inOrderClient(); } });
	assert.equal(unmade.code, 1);
	assert.match(unmade.err, /\n {2}pi-jobs@hosta: not sent \(whether it exists could not be read: no client for that address\)\n/);
	// A scan that finished is the answer: a queue it did not name has no meta key, whatever the EXISTS said.
	const scanned = await resumeInOrder(dir, own, { scan: async () => ["0", []], exists: () => Promise.reject(new Error("Connection is closed.")) });
	assert.deepEqual([scanned.code, scanned.resumed, scanned.out, scanned.err], [0, ["pi-jobs"], "resumed\n", ""]);
});

test("a resume whose scan failed reaches this host's queue through the registry once, never also as not sent, when the look for its meta key gets an error (#1042)", { timeout: 15_000 }, async () => {
	const dir = tempDir("pd-1042-registry-");
	const res = await resumeInOrder(dir, "PI_WORKER_NAME=hosta\n", { hosts: ["hosta"], scan: () => Promise.reject(new Error("scan refused")), exists: () => Promise.reject(replyError("ERR unknown command 'exists'")) });
	assert.deepEqual([res.code, res.resumed, res.err], [0, ["pi-jobs", "pi-jobs@hosta"], ""]);
	assert.equal(res.out, `resumed [2 queues] [queue scan incomplete]\n  but ${killSwitchShortNote(false)}\n`);
});

test("a resume whose scan finished does not wait for a look at this host's queue that does not answer, and drops its client; one with no name for this host's queue makes none (#1042)", { timeout: 15_000 }, async () => {
	const dir = tempDir("pd-1042-scanned-");
	// The scan names the queue at once; the EXISTS client never answers. The deadline is three seconds and the look's own
	// bound two: a resume that waited for it would take two seconds.
	const res = await resumeInOrder(dir, "PI_WORKER_NAME=hosta\n", { scan: async () => ["0", ["bull:pi-jobs@hosta:meta"]], exists: never });
	assert.ok(res.ms < 1_000, `ended once the scan finished, not at the look's bound (took ${Math.round(res.ms)} ms)`);
	assert.deepEqual([res.code, res.resumed, res.out], [0, ["pi-jobs", "pi-jobs@hosta"], "resumed [2 queues]\n"]);
	const asking = res.clients.filter((c) => c.sent.includes("EXISTS"));
	assert.deepEqual(asking.map((c) => c.disconnected), [1], "its client is dropped, so it is not dialled again");
	// No PI_WORKER_NAME in the .env: no queue of this host's to look for, and no client is made for one.
	const unnamed = await resumeInOrder(dir, "", { scan: () => Promise.reject(new Error("scan refused")) });
	assert.deepEqual([unnamed.code, unnamed.clients.length, unnamed.clients[0].sent.includes("EXISTS")], [0, 1, false], "the probe alone");
});

// Issue #1043: a status whose registry or queue scan did not finish summed the queues it found and said so only inside
// `waitingDetails`, exit 0, while a queue it never found may hold paused or waiting jobs.
test("status over a list of queues that may be short says so at the top with the sentence under the line, exit 0, and a found queue that did not answer still exits 1 (#1043)", { timeout: 15_000 }, async () => {
	const warned = `warning: ${statusShortNote(false)}\n`;
	// The scan failed and the shared queue answered: the sums are what was found, said as such.
	const unscanned = await silentStatus({ queues: { "pi-jobs": true }, probe: { on() {}, disconnect() {}, async smembers() { return []; }, async scan() { throw new Error("scan refused"); } } });
	assert.equal(unscanned.code, 0, "a list that may be short is not a failure by itself");
	assert.equal(unscanned.status.queuesMayBeShort, true);
	assert.deepEqual([unscanned.status.pausedState, unscanned.status.paused, unscanned.status.partial], [true, 3, undefined]);
	assert.equal(unscanned.status.waitingDetails.discoveryIncomplete, true);
	assert.equal(unscanned.err, warned);
	assert.equal(statusShortNote(false), "the list of queues may be short: the host registry or the look for queues could not be read whole, so other queues may exist and the sums above leave them out. Run pi-dispatch status again once Valkey answers");
	// The registry could not be read, and a host queue the scan found did not answer: both, and exit 1 for the queue.
	const both = await silentStatus({ queues: { "pi-jobs": false, "pi-jobs@mini2": null }, probe: { on() {}, disconnect() {}, async smembers() { throw new Error("registry refused"); }, async scan() { return ["0", ["bull:pi-jobs@mini2:meta"]]; } } });
	assert.equal(both.code, 1);
	assert.deepEqual([both.status.queuesMayBeShort, both.status.partial, both.status.unavailableQueues, both.status.fleet], [true, true, ["pi-jobs@mini2"], "registry refused"]);
	assert.ok(both.err.startsWith(`${warned}error: Valkey at redis://127.0.0.1:6379 did not answer every read within 0.3 seconds\n`), both.err);
	// A whole list: no flag and no sentence, as before.
	const whole = await silentStatus({ queues: { "pi-jobs": false }, probeAnswers: true });
	assert.deepEqual([whole.code, Object.hasOwn(whole.status, "queuesMayBeShort"), whole.err], [0, false, ""]);
});

test("status and status --target over two Valkeys name which one each list-may-be-short line is about (#1043)", { timeout: 15_000 }, async () => {
	const dir = tempDir("pd-1043-two-");
	writeFileSync(join(dir, ".env"), "VALKEY_URL=redis://127.0.0.1:1/14\n");
	for (const argv of [["status"], ["status", "--target", "owner/repo#12"]]) {
		const errs = [];
		const origErr = process.stderr.write;
		process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
		let code;
		try {
			code = await main(argv, { VALKEY_URL: "redis://127.0.0.1:1/15" }, {
				cwd: dir, now: () => new Date(1_800_000_000_000), write: () => {}, valkeyRefusal: async () => null,
				controlClients: {
					makeRedisClient: () => ({ on() {}, disconnect() {}, async smembers() { return []; }, async scan() { throw new Error("scan refused"); } }),
					makeQueue: (_c, { name }) => ({ name, client: { async zrange() { return []; }, async scan() { return ["0", []]; } }, async isPaused() { return false; }, async getJobCounts() { return { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }; }, async getJobs() { return []; }, async close() {} }),
				},
			});
		} finally {
			process.stderr.write = origErr;
		}
		const warned = errs.join("").split("\n").filter((line) => line.includes("the list of queues may be short"));
		const note = statusShortNote(argv.length > 1);
		assert.deepEqual(warned.sort(), [`warning: [redis://127.0.0.1:1/14] ${note}`, `warning: [redis://127.0.0.1:1/15] ${note}`], `${argv.join(" ")} (exit ${code}): ${errs.join("")}`);
	}
});

/**
 * `argv` in this process, with the real clients, through a real Valkey's proxy that holds each connection's SCAN (or
 * `holdFrom`) and what that connection sends after it: a scan that does not finish while every other connection answers.
 * Each queue but `keep` is built under `prefix`, so no other test's queue is read or switched. Stderr is collected.
 */
async function throughHeldScan(argv, { prefix, keep = null, cwd, holdFrom = "SCAN" }) {
	const { makeQueue } = await import("../src/queue.mjs");
	const { freezingProxy } = await import("./helpers/freezing-proxy.mjs");
	const proxy = await freezingProxy(process.env.VALKEY_TEST_URL, { holdFrom });
	let out = "";
	const errs = [];
	const origErr = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
	const started = performance.now();
	try {
		const code = await main([...argv, "--valkey-url", proxy.url], { VALKEY_URL: proxy.url }, {
			cwd, valkeyRefusal: async () => null, write: (text) => { out += text; },
			controlClients: { makeQueue: (connection, { name }) => makeQueue(connection, { name: name === keep ? name : `${prefix}${name}` }) },
		});
		return { code, out, err: errs.join(""), ms: performance.now() - started };
	} finally {
		process.stderr.write = origErr;
		proxy.close();
	}
}

/** Every key under `pattern` on `direct`, deleted. */
async function dropKeys(direct, pattern) {
	let cursor = "0";
	do {
		const [next, keys] = await direct.scan(cursor, "MATCH", pattern, "COUNT", 500);
		cursor = String(next);
		if (keys.length > 0) await direct.del(...keys);
	} while (cursor !== "0");
}

test("a resume through a real Valkey whose queue scan does not finish resumes this host's own queue, and status there says its list may be short (issues #1042, #1043, VALKEY_TEST_URL)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL", timeout: 30_000 }, async () => {
	const { makeQueue } = await import("../src/queue.mjs");
	const { makeRedisClient, parseConnection } = await import("../src/connection.mjs");
	const url = process.env.VALKEY_TEST_URL;
	// This host's queue under a name of this test's own, since its meta key is read by name; every other queue prefixed.
	const worker = `pd1042-${process.pid}-${Date.now()}`;
	const own = `pi-jobs@${worker}`;
	const prefix = `${worker}-`;
	const cwd = tempDir("pd-1042-held-");
	writeFileSync(join(cwd, ".env"), `PI_WORKER_NAME=${worker}\n`);
	const direct = makeRedisClient(url);
	direct.on("error", () => {});
	try {
		const q = makeQueue(parseConnection(url), { name: own });
		await q.pause();
		await q.close();
		assert.equal(await direct.hexists(`bull:${own}:meta`, "paused"), 1);
		const resumed = await throughHeldScan(["resume"], { prefix, keep: own, cwd });
		assert.equal(resumed.code, 0, resumed.err);
		assert.match(resumed.out, /^resumed \[2 queues\].* \[queue scan incomplete\]\n/);
		assert.equal(await direct.hexists(`bull:${own}:meta`, "paused"), 0, "resumed, though the scan never named it");
		assert.ok(resumed.ms < 4500, `within the deadline (took ${Math.round(resumed.ms)} ms)`);
		// Conversely, the look for its meta key is held and the scan finishes, which answers it, so the resume does
		// not wait for the look's two seconds.
		const q2 = makeQueue(parseConnection(url), { name: own });
		await q2.pause();
		await q2.close();
		const scanned = await throughHeldScan(["resume"], { prefix, keep: own, cwd, holdFrom: "EXISTS" });
		assert.equal(scanned.code, 0, scanned.err);
		assert.equal(await direct.hexists(`bull:${own}:meta`, "paused"), 0, "resumed, the scan having named it");
		assert.ok(scanned.ms < 1500, `ended once the scan finished, not at the look's bound (took ${Math.round(scanned.ms)} ms)`);
		// `status` through the same held scan: the queues it found answered, so exit 0, and the line says at the top that its
		// sums may leave out queues it did not find.
		const status = await throughHeldScan(["status"], { prefix, cwd });
		assert.equal(status.code, 0, status.err);
		const line = JSON.parse(status.out);
		assert.deepEqual([line.queuesMayBeShort, line.waitingDetails.discoveryIncomplete, line.partial], [true, true, undefined]);
		assert.ok(status.err.startsWith(`warning: ${statusShortNote(false)}\n`), status.err);
	} finally {
		await dropKeys(direct, `bull:${prefix}*`);
		await dropKeys(direct, `bull:${own}:*`);
		direct.disconnect();
	}
});

// Issue #1053: one queue's read that Valkey answered with an error (its meta key holding a string) failed the whole
// `status`, said as a Valkey that could not be reached, while every other queue answered.
test("status names a queue whose read Valkey answered with an error, by the reply's code alone, reads and sums every other, exits 1, and says Valkey answered (#1053)", { timeout: 15_000 }, async () => {
	const res = await silentStatus({ queues: { "pi-jobs": false, "pi-jobs@hosta": true, "pi-jobs@hostb": "wrongtype" }, probeAnswers: true });
	assert.equal(res.code, 1, "a queue it found and did not read, the rule for one that did not answer");
	assert.deepEqual([res.status.partial, res.status.unavailableQueues, res.status.queueErrors], [true, ["pi-jobs@hostb"], { "pi-jobs@hostb": "WRONGTYPE" }]);
	assert.deepEqual([res.status.waiting, res.status.paused, res.status.pausedState, res.status.pausedPartial], [6, 3, false, true], "every queue's counts that answered are summed, hostb's included");
	assert.equal(res.err, "error: Valkey at redis://127.0.0.1:6379 answered a read with an error\n  the line above leaves out the paused state of pi-jobs@hostb (Valkey answered WRONGTYPE)\n");
	// Both of its reads answered with the error: its counts are left out too, and no other queue's.
	const both = await silentStatus({ queues: { "pi-jobs": true, "pi-jobs@hostb": "wrongtype, uncounted" }, probeAnswers: true });
	assert.deepEqual([both.code, both.status.unavailableQueues, both.status.queueErrors, both.status.waiting, both.status.pausedState], [1, ["pi-jobs@hostb"], { "pi-jobs@hostb": "WRONGTYPE" }, 2, null]);
	assert.match(both.err, /\n {2}the line above leaves out the paused state and counts of pi-jobs@hostb \(Valkey answered WRONGTYPE\)\n$/);
	// Beside a queue that did not answer in time, the first line says both.
	const mixed = await silentStatus({ queues: { "pi-jobs": false, "pi-jobs@hosta": null, "pi-jobs@hostb": "wrongtype" }, probeAnswers: true });
	assert.deepEqual([mixed.code, mixed.status.unavailableQueues, mixed.status.queueErrors], [1, ["pi-jobs@hosta", "pi-jobs@hostb"], { "pi-jobs@hostb": "WRONGTYPE" }]);
	assert.match(mixed.err, /^error: Valkey at redis:\/\/127\.0\.0\.1:6379 did not answer every read within 0\.3 seconds and answered a read with an error\n/);
	for (const r of [res, both, mixed]) assert.doesNotMatch(r.err, /could not reach|is it running|Operation against/, "Valkey answered, and with its code alone");
});

test("status beside a queue whose connection failed reads the rest, and says the connection's error; only when nothing answered is it a Valkey it could not reach (#1053)", { timeout: 15_000 }, async () => {
	const failed = await silentStatus({ queues: { "pi-jobs": false, "pi-jobs@hostb": "connection failed" }, probeAnswers: true });
	assert.deepEqual([failed.code, failed.status.unavailableQueues, Object.hasOwn(failed.status, "queueErrors"), failed.status.waiting], [1, ["pi-jobs@hostb"], false, 2]);
	assert.doesNotMatch(failed.err, /could not reach/);
	assert.match(failed.err, /\n {2}Connection is closed\.\n {2}the line above leaves out the paused state and counts of pi-jobs@hostb\n$/);
	// Every queue's reads failed with no answer: the connection's error, as before, with no line.
	const none = await silentStatus({ queues: { "pi-jobs": "connection failed", "pi-jobs@hostb": "connection failed" }, probeAnswers: true });
	assert.deepEqual([none.code, none.status], [1, null]);
	assert.match(none.err, /^error: could not reach Valkey at redis:\/\/127\.0\.0\.1:6379: .*\n {2}Connection is closed\.\n$/);
});

test("status through a real Valkey where one queue's meta key holds a string names that queue as answered with WRONGTYPE and reads the rest (#1053, VALKEY_TEST_URL)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL", timeout: 30_000 }, async () => {
	const { makeQueue } = await import("../src/queue.mjs");
	const { makeRedisClient, parseConnection } = await import("../src/connection.mjs");
	const url = process.env.VALKEY_TEST_URL;
	// The broken queue under a host queue name of this test's own, since the scan finds it by its meta key; every other
	// queue the status builds is prefixed, so no other test's queue is read.
	const host = `pd1053-${process.pid}-${Date.now()}`;
	const broken = `pi-jobs@${host}`;
	const prefix = `${host}-`;
	const direct = makeRedisClient(url);
	direct.on("error", () => {});
	let out = "";
	const errs = [];
	const origErr = process.stderr.write.bind(process.stderr);
	try {
		const seed = makeQueue(parseConnection(url), { name: broken });
		await seed.add("seed", { kind: "local" }, { jobId: "seed-1053" });
		await seed.close();
		await direct.del(`bull:${broken}:meta`);
		await direct.set(`bull:${broken}:meta`, "not a hash");
		process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
		const code = await main(["status", "--valkey-url", url], { VALKEY_URL: url }, {
			valkeyRefusal: async () => null, write: (text) => { out += text; },
			controlClients: { makeQueue: (connection, { name }) => makeQueue(connection, { name: name === broken ? name : `${prefix}${name}` }) },
		});
		process.stderr.write = origErr;
		const err = errs.join("");
		assert.equal(code, 1, err);
		const line = JSON.parse(out);
		assert.equal(line.queueErrors?.[broken], "WRONGTYPE", out);
		assert.ok(line.unavailableQueues.includes(broken));
		assert.ok(!line.unavailableQueues.includes("pi-jobs"), "the shared queue was read");
		assert.equal(typeof line.waiting, "number");
		assert.doesNotMatch(err, /could not reach|Operation against/, err);
		assert.match(err, new RegExp(`answered a read with an error\\n.*${broken} \\(Valkey answered WRONGTYPE\\)`), err);
	} finally {
		process.stderr.write = origErr;
		await dropKeys(direct, `bull:${prefix}*`);
		await dropKeys(direct, `bull:${broken}:*`);
		direct.disconnect();
	}
});

// Issue #1062: three registry hosts whose rows wait behind a scan that stalled on the probe's connection cost a bound
// each, so the resume's deadline was gone before its write, and the shared queue, which answered, was "not sent".
test("a resume behind a stalled scan with three registry hosts ends within its deadline, resumes the shared queue, and names the registry rows it did not read (#1062)", { timeout: 15_000 }, async () => {
	const dir = tempDir("pd-1062-registry-");
	const res = await resumeInOrder(dir, "", { hosts: ["hosta", "hostb", "hostc"], scan: never });
	assert.ok(res.ms < 2_800, `the registry's rows cost one bound, not three (took ${Math.round(res.ms)} ms of a three-second deadline)`);
	assert.deepEqual([res.code, res.resumed, res.err], [0, ["pi-jobs"], ""]);
	assert.equal(res.out, `resumed [registry incomplete: 3 of 3 host rows not read] [queue scan incomplete]\n  but ${killSwitchShortNote(false)}\n`);
});

test("status and status --target say registry rows not read in time as fleetIncomplete, with the list may be short, within the deadline (#1062)", { timeout: 15_000 }, async () => {
	const probe = { on() {}, disconnect() {}, async smembers() { return ["hosta", "hostb"]; }, hgetall: never, async scan() { return ["0", []]; } };
	const status = await silentStatus({ queues: { "pi-jobs": false }, probe, deadlineMs: 3_000 });
	assert.ok(status.ms < 2_800, `took ${Math.round(status.ms)} ms`);
	assert.deepEqual([status.code, status.status.fleetIncomplete, status.status.queuesMayBeShort, status.status.waitingDetails.discoveryIncomplete, status.status.fleet], [0, "2 of 2 host rows not read", true, true, undefined]);
	assert.equal(status.err, `warning: ${statusShortNote(false)}\n`);
	const target = await silentStatus({ argv: ["status", "--target", "owner/repo#12"], queues: { "pi-jobs": false }, probe, deadlineMs: 3_000 });
	assert.deepEqual([target.code, target.status.fleetIncomplete, target.status.queuesMayBeShort, target.status.complete], [0, "2 of 2 host rows not read", true, false]);
});

test("status and status --target name a host whose row Valkey answered with an error, with the reply's code, in hostErrors and in fleetIncomplete's words (#1036)", { timeout: 15_000 }, async () => {
	const wrongtype = () => Promise.reject(Object.assign(new Error("WRONGTYPE Operation against a key holding the wrong kind of value"), { name: "ReplyError" }));
	const row = { name: "hosta", beatAt: String(Date.now()) };
	const probe = { on() {}, disconnect() {}, async smembers() { return ["hosta", "hostw"]; }, hgetall: (key) => (key === "host:h:hostw" ? wrongtype() : Promise.resolve(row)), async scan() { return ["0", []]; } };
	const words = "1 of 2 host rows not read, of which Valkey answered with an error: hostw (WRONGTYPE)";
	const status = await silentStatus({ queues: { "pi-jobs": false }, probe, deadlineMs: 3_000 });
	assert.deepEqual([status.code, status.status.fleetIncomplete, status.status.hostErrors, status.status.queuesMayBeShort], [0, words, { hostw: "WRONGTYPE" }, true]);
	assert.doesNotMatch(JSON.stringify(status.status), /Operation against/);
	const target = await silentStatus({ argv: ["status", "--target", "owner/repo#12"], queues: { "pi-jobs": false }, probe, deadlineMs: 3_000 });
	assert.deepEqual([target.code, target.status.fleetIncomplete, target.status.hostErrors, target.status.complete], [0, words, { hostw: "WRONGTYPE" }, false]);
	// A row that got no answer has no code: no `hostErrors` key on either line.
	probe.hgetall = (key) => (key === "host:h:hostw" ? never() : Promise.resolve(row));
	const late = await silentStatus({ queues: { "pi-jobs": false }, probe, deadlineMs: 3_000 });
	assert.deepEqual([late.status.fleetIncomplete, Object.hasOwn(late.status, "hostErrors")], ["1 of 2 host rows not read", false]);
	const lateTarget = await silentStatus({ argv: ["status", "--target", "owner/repo#12"], queues: { "pi-jobs": false }, probe, deadlineMs: 3_000 });
	assert.equal(Object.hasOwn(lateTarget.status, "hostErrors"), false);
});

/**
 * A probe whose three discovery reads answer as `how` says (issue #1035): `index`, the registry's `host:live`; `rows`,
 * a host's row by its key; `scan`, the look for queues. A read not named answers well, with `hosta` and `hostw` live.
 */
function shortProbe({ index = null, rows = {}, scan = null } = {}) {
	return {
		on() {}, disconnect() {},
		smembers: () => (index ? index() : Promise.resolve(["hosta", "hostw"])),
		hgetall: (key) => (rows[key] ? rows[key]() : Promise.resolve({ name: key.slice("host:h:".length), routes: "true", beatAt: String(Date.now()) })),
		async pttl() { return 60_000; },
		async srem() { return 0; },
		scan: () => (scan ? scan() : Promise.resolve(["0", []])),
	};
}
const answeredWith = (code) => () => Promise.reject(Object.assign(new Error(`${code} said by Valkey about the key`), { name: "ReplyError" }));
const noAnswer = () => Promise.reject(new Error("Connection is closed."));

// Issue #1035: `pause` ended "Pause the fleet again once Valkey answers" and `status` "Run pi-dispatch status again
// once Valkey answers" with a host's row holding a string, which Valkey answers the same on every run.
test("pause, resume, status and status --target over a list that is short because Valkey answered a read with an error name the key and the code and say what its class supports, and to wait only for a read that got no answer (#1035)", { timeout: 30_000 }, async () => {
	const CASES = [
		// what, the reads, the cause, what a pause says under its line
		["a key of another type", { index: answeredWith("WRONGTYPE") }, { waits: false, errors: [{ key: "host:live", code: "WRONGTYPE", class: "key" }], more: 0, lasting: "key" },
			"the list of queues may be short: Valkey answers host:live with WRONGTYPE. Waiting does not change that: remove or repair that key, then pause again; other queues may exist and were not paused"],
		["a host's row of another type", { rows: { "host:h:hostw": answeredWith("WRONGTYPE") } }, { waits: false, errors: [{ key: "host:h:hostw", code: "WRONGTYPE", class: "key" }], more: 0, lasting: "key" },
			"the list of queues may be short: Valkey answers host:h:hostw with WRONGTYPE. Waiting does not change that: remove or repair that key, then pause again; other queues may exist and were not paused"],
		["a permission", { scan: answeredWith("NOPERM") }, { waits: false, errors: [{ key: null, code: "NOPERM", class: "permission" }], more: 0, lasting: "permission" },
			"the list of queues may be short: Valkey answers the look for queues with NOPERM. Waiting does not change that: fix this Valkey user's ACL, then pause again; other queues may exist and were not paused"],
		["a passing state", { index: answeredWith("BUSY") }, { waits: false, errors: [{ key: "host:live", code: "BUSY", class: "passing" }], more: 0, lasting: null },
			"the list of queues may be short: Valkey answers host:live with BUSY. A later read may succeed: pause the fleet again; other queues may exist and were not paused"],
		["a code of no class", { index: answeredWith("READONLY") }, { waits: false, errors: [{ key: "host:live", code: "READONLY", class: "other" }], more: 0, lasting: null },
			"the list of queues may be short: Valkey answers host:live with READONLY. Pause the fleet again once the list can be read whole; other queues may exist and were not paused"],
		["no answer", { index: noAnswer }, { waits: true, errors: [], more: 0, lasting: null },
			"the list of queues may be short: the host registry or the look for queues could not be read whole, so other queues may exist and were not paused. Pause the fleet again once Valkey answers"],
		["an error reply and a read with no answer", { rows: { "host:h:hostw": answeredWith("NOAUTH") }, scan: noAnswer }, { waits: true, errors: [{ key: "host:h:hostw", code: "NOAUTH", class: "permission" }], more: 0, lasting: "permission" },
			"the list of queues may be short: Valkey answers host:h:hostw with NOAUTH. Waiting does not change that: fix this Valkey user's ACL. Another read got no answer: pause the fleet again once Valkey answers and that is put right; other queues may exist and were not paused"],
	];
	for (const [what, reads, cause, note] of CASES) {
		const probe = () => shortProbe(reads);
		// Every queue a discovery can name here answers its switch.
		const queues = { "pi-jobs": "ok", "pi-jobs@hosta": "ok", "pi-jobs@hostw": "ok" };
		assert.equal(killSwitchShortNote(true, cause), note, what);
		const paused = await silentSwitch("pause", { queues, probe: probe(), deadlineMs: 3_000 });
		assert.deepEqual([paused.code, paused.err], [0, ""], what);
		assert.ok(paused.out.startsWith("paused: worker will stop taking new jobs (jobs still enqueue)") && paused.out.endsWith(`\n  but ${note}\n`), `${what}: ${paused.out}`);
		const resumed = await silentSwitch("resume", { queues, probe: probe(), deadlineMs: 3_000 });
		assert.ok(resumed.out.startsWith("resumed") && resumed.out.endsWith(`\n  but ${killSwitchShortNote(false, cause)}\n`), `${what}: ${resumed.out}`);
		// A pause that also left a found queue unconfirmed: the same sentence, in the report.
		const doubt = await silentSwitch("pause", { queues: { ...queues, "pi-jobs": "silent write" }, probe: probe(), deadlineMs: 600 });
		assert.equal(doubt.code, 1, what);
		assert.ok(doubt.err.includes(`\n  ${note}\n`), `${what}: ${doubt.err}`);
		// `status` and `status --target`: the warning under the line, with their own next step.
		const read = { "pi-jobs": false, "pi-jobs@hosta": false, "pi-jobs@hostw": false };
		const status = await silentStatus({ queues: read, probe: probe(), deadlineMs: 3_000 });
		assert.deepEqual([status.code, status.status.queuesMayBeShort, status.err], [0, true, `warning: ${statusShortNote(false, cause)}\n`], what);
		const target = await silentStatus({ argv: ["status", "--target", "owner/repo#12"], queues: read, probe: probe(), deadlineMs: 3_000 });
		assert.deepEqual([target.code, target.err], [0, `warning: ${statusShortNote(true, cause)}\n`], what);
		for (const said of [paused.out, resumed.out, doubt.err.split("\n").find((line) => line.includes("may be short")), status.err, target.err]) {
			assert.equal(/once Valkey answers/.test(said), cause.waits, `${what}: waiting is said exactly where a read waits: ${said}`);
			assert.doesNotMatch(said, /refus/i, what);
		}
	}
	assert.equal(statusShortNote(false, CASES[1][2]), "the list of queues may be short: Valkey answers host:h:hostw with WRONGTYPE. Waiting does not change that: remove or repair that key, then run pi-dispatch status again; other queues may exist and the sums above leave them out");
	// The cause from the two reads' own answers: nothing short gives none; a name that is no worker's never becomes a key.
	assert.equal(killSwitchShortCause({ hosts: [] }, { names: [], incomplete: false }), null);
	assert.deepEqual(killSwitchShortCause({ hosts: [], incomplete: "1 of 1 host rows not read", unreadHosts: ["bad name\n"], hostErrors: { "bad name\n": "WRONGTYPE" } }, { names: [] }), { waits: true, errors: [], more: 0, lasting: null });
	assert.deepEqual(killSwitchShortCause({ unreachable: "x", error: "WRONGTYPE Operation against a key" }, { names: [] }), { waits: true, errors: [], more: 0, lasting: null }, "a code is one word, never a client's sentence");
	const many = killSwitchShortCause({ hosts: [], incomplete: "x", unreadHosts: Array.from({ length: 23 }, (_, i) => `h${String(i).padStart(2, "0")}`), hostErrors: Object.fromEntries(Array.from({ length: 23 }, (_, i) => [`h${String(i).padStart(2, "0")}`, "WRONGTYPE"])) }, { names: [] });
	assert.deepEqual([many.errors.length, many.more, many.errors[0].key], [20, 3, "host:h:h00"]);
});

test("pause, resume and status through a real Valkey whose registry key holds a string, and one where a host's row does, name that key with WRONGTYPE and say to repair it, never to wait for Valkey (#1035, VALKEY_TEST_URL)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL", timeout: 60_000 }, async () => {
	const { Redis } = await import("ioredis");
	const { makeQueue } = await import("../src/queue.mjs");
	const { parseConnection } = await import("../src/connection.mjs");
	const url = process.env.VALKEY_TEST_URL;
	// The registry's keys under a prefix of this test's own, and every queue under a name of its own, so no other test's
	// registry row or queue is read as this deployment's or switched.
	const tag = `pd1035-${process.pid}-${Date.now()}`;
	const prefix = `${tag}:`;
	const own = new Redis({ ...parseConnection(url), keyPrefix: prefix });
	const plain = new Redis(parseConnection(url));
	for (const client of [own, plain]) client.on("error", () => {});
	const cwd = tempDir("pd-1035-live-");
	const run = async (argv) => {
		let out = "";
		const errs = [];
		const origErr = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
		try {
			const code = await main([...argv, "--valkey-url", url], { VALKEY_URL: url }, {
				cwd, valkeyRefusal: async () => null, write: (text) => { out += text; },
				controlClients: {
					makeRedisClient: (target) => new Redis({ ...parseConnection(target), keyPrefix: prefix }),
					makeQueue: (connection, { name }) => makeQueue(connection, { name: `${tag}-${name}` }),
				},
			});
			return { code, out, err: errs.join("") };
		} finally {
			process.stderr.write = origErr;
		}
	};
	const sentences = (key) => ({
		pause: `the list of queues may be short: Valkey answers ${key} with WRONGTYPE. Waiting does not change that: remove or repair that key, then pause again; other queues may exist and were not paused`,
		resume: `the list of queues may be short: Valkey answers ${key} with WRONGTYPE. Waiting does not change that: remove or repair that key, then resume again; other queues may exist and were not resumed`,
		status: `the list of queues may be short: Valkey answers ${key} with WRONGTYPE. Waiting does not change that: remove or repair that key, then run pi-dispatch status again; other queues may exist and the sums above leave them out`,
	});
	const over = async (key) => {
		const said = sentences(key);
		const paused = await run(["pause"]);
		assert.equal(paused.code, 0, paused.err);
		assert.ok(paused.out.endsWith(`\n  but ${said.pause}\n`), paused.out);
		assert.equal(await plain.hexists(`bull:${tag}-pi-jobs:meta`, "paused"), 1, "the shared queue was paused all the same");
		const resumed = await run(["resume"]);
		assert.equal(resumed.code, 0, resumed.err);
		assert.ok(resumed.out.endsWith(`\n  but ${said.resume}\n`), resumed.out);
		assert.equal(await plain.hexists(`bull:${tag}-pi-jobs:meta`, "paused"), 0);
		const status = await run(["status"]);
		assert.equal(status.code, 0, status.err);
		assert.equal(JSON.parse(status.out).queuesMayBeShort, true);
		assert.ok(status.err.includes(`warning: ${said.status}\n`), status.err);
		for (const text of [paused.out, resumed.out, status.err]) assert.doesNotMatch(text, /once Valkey answers|refus/i);
	};
	try {
		// The registry's index holds a string: Valkey answers its read with WRONGTYPE on every run.
		await own.set("host:live", "not a set");
		await over("host:live");
		// The index is a set again and one host's row holds a string.
		await own.del("host:live");
		await own.sadd("host:live", "hostw");
		await own.set("host:h:hostw", "not a hash");
		await over("host:h:hostw");
		// Repaired: read whole, and nothing is said of a short list.
		await own.del("host:h:hostw", "host:live");
		const whole = await run(["pause"]);
		assert.deepEqual([whole.code, /may be short/.test(whole.out)], [0, false], whole.out);
	} finally {
		await own.del("host:live", "host:h:hostw").catch(() => {});
		await dropKeys(plain, `bull:${tag}-*`).catch(() => {});
		await dropKeys(plain, `${prefix}*`).catch(() => {});
		own.disconnect();
		plain.disconnect();
	}
});

// Issue #1036: one hostErrors entry per broken row, with no bound: 23 rows gave 23.
test("status and status --target name at most twenty hosts in hostErrors and count the rest in hostErrorsMore (#1036)", { timeout: 15_000 }, async () => {
	const wrongtype = () => Promise.reject(Object.assign(new Error("WRONGTYPE Operation against a key holding the wrong kind of value"), { name: "ReplyError" }));
	const names = Array.from({ length: 23 }, (_, i) => `bad${String(i).padStart(2, "0")}`);
	const probe = { on() {}, disconnect() {}, async smembers() { return names; }, hgetall: wrongtype, async scan() { return ["0", []]; } };
	for (const argv of [["status"], ["status", "--target", "owner/repo#12"]]) {
		const got = await silentStatus({ argv, queues: { "pi-jobs": false }, probe, deadlineMs: 3_000 });
		assert.deepEqual([Object.keys(got.status.hostErrors), got.status.hostErrorsMore], [names.slice(0, 20), 3], argv.join(" "));
	}
	// Twenty or fewer: every one, and no count.
	probe.smembers = async () => names.slice(0, 20);
	const twenty = await silentStatus({ queues: { "pi-jobs": false }, probe, deadlineMs: 3_000 });
	assert.deepEqual([Object.keys(twenty.status.hostErrors).length, Object.hasOwn(twenty.status, "hostErrorsMore")], [20, false]);
});

test("a resume through a real Valkey whose scan stalls, with three registry hosts, ends within its deadline and resumes what it found (#1062, VALKEY_TEST_URL)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL", timeout: 30_000 }, async () => {
	const { makeQueue } = await import("../src/queue.mjs");
	const { makeRedisClient, parseConnection } = await import("../src/connection.mjs");
	const { HOST_SET, hostKey } = await import("../src/host-registry.mjs");
	const url = process.env.VALKEY_TEST_URL;
	const tag = `pd1062-${process.pid}-${Date.now()}`;
	const prefix = `${tag}-`;
	const hosts = ["a", "b", "c"].map((x) => `${tag}-${x}`);
	const cwd = tempDir("pd-1062-held-");
	const direct = makeRedisClient(url);
	direct.on("error", () => {});
	try {
		// Three live, routing rows of this test's own; every queue the resume builds is prefixed, the shared one paused.
		for (const name of hosts) {
			await direct.hset(hostKey(name), "name", name, "routes", "true", "beatAt", String(Date.now()));
			await direct.pexpire(hostKey(name), 60_000);
			await direct.sadd(HOST_SET, name);
		}
		const shared = makeQueue(parseConnection(url), { name: `${prefix}pi-jobs` });
		await shared.pause();
		await shared.close();
		const resumed = await throughHeldScan(["resume"], { prefix, cwd });
		assert.ok(resumed.ms < 4_500, `within the five-second deadline (took ${Math.round(resumed.ms)} ms)`);
		assert.equal(resumed.code, 0, resumed.err);
		assert.match(resumed.out, /^resumed \[registry incomplete: \d+ of \d+ host rows not read\] \[queue scan incomplete\]\n {2}but the list of queues may be short/);
		assert.equal(await direct.hexists(`bull:${prefix}pi-jobs:meta`, "paused"), 0, "the shared queue was resumed");
	} finally {
		for (const name of hosts) {
			await direct.del(hostKey(name));
			await direct.srem(HOST_SET, name);
		}
		await dropKeys(direct, `bull:${prefix}*`);
		direct.disconnect();
	}
});

test("status where every queue's reads are answered with an error and the registry and the scan are unread says Valkey answered, never that it could not be reached (#1053)", { timeout: 15_000 }, async () => {
	// An error reply is Valkey answering: "is it running?" only when nothing at all answered.
	// The scan ends at its two-second bound inside a three-second deadline, so the queue is built and read after it.
	const probe = { on() {}, disconnect() {}, async smembers() { throw new Error("registry refused"); }, scan: never };
	const res = await silentStatus({ queues: { "pi-jobs": "wrongtype, uncounted" }, probe, deadlineMs: 3_000 });
	assert.equal(res.code, 1);
	assert.deepEqual([res.status.unavailableQueues, res.status.queueErrors, res.status.fleet], [["pi-jobs"], { "pi-jobs": "WRONGTYPE" }, "registry refused"]);
	assert.match(res.err, /\nerror: Valkey at redis:\/\/127\.0\.0\.1:6379 answered a read with an error\n {2}the line above leaves out the paused state and counts of pi-jobs \(Valkey answered WRONGTYPE\)\n$/);
	assert.doesNotMatch(res.err, /could not reach|did not answer within|is it running/);
});

/** A probe whose registry lists hosta and hostb, hostb's row never answering, and whose scan ends at once, empty. */
const hostbUnread = () => ({
	on() {}, disconnect() {},
	async smembers() { return ["hosta", "hostb"]; },
	hgetall: (key) => (key === "host:h:hostb" ? never() : Promise.resolve({ name: "hosta", routes: "true", beatAt: "1800000000000" })),
	async scan() { return ["0", []]; },
});

test("a resume over a registry read in part whose scan finished says its list may be short, by the registry alone (#1062)", { timeout: 15_000 }, async () => {
	const res = await resumeInOrder(tempDir("pd-1062-part-"), "", {}, { makeClient: hostbUnread });
	assert.deepEqual([res.code, res.resumed, res.err], [0, ["pi-jobs", "pi-jobs@hosta"], ""]);
	assert.equal(res.out, `resumed [2 queues] [registry incomplete: 1 of 2 host rows not read]\n  but ${killSwitchShortNote(false)}\n`);
});

test("a resume that fails over a registry read in part names the registry on its first line and says the list may be short (#1062)", { timeout: 15_000 }, async () => {
	const dir = tempDir("pd-1062-failed-");
	writeFileSync(join(dir, ".env"), "");
	const errs = [];
	const origErr = process.stderr.write;
	process.stderr.write = (chunk) => (errs.push(String(chunk)), true);
	let code;
	try {
		code = await main(["resume"], { VALKEY_URL: "redis://127.0.0.1:1/15" }, {
			cwd: dir, statusDeadlineMs: 3_000, write: () => {}, valkeyRefusal: async () => null,
			controlClients: {
				makeRedisClient: hostbUnread,
				makeQueue: (_c, { name }) => ({ name, client: Promise.resolve({}), resume: () => Promise.reject(replyError("NOPERM this user has no permissions to run the 'evalsha' command")), async close() {} }),
			},
		});
	} finally {
		process.stderr.write = origErr;
	}
	const lines = errs.join("").split("\n");
	assert.equal(code, 1);
	assert.equal(lines[0], "error: could not resume the whole deployment at redis://127.0.0.1:1/15 [registry incomplete: 1 of 2 host rows not read]");
	assert.ok(lines.includes(`  ${killSwitchShortNote(false)}`), errs.join(""));
});
