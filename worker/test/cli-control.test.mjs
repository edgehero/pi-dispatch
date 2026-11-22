import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { entryExitCode, killSwitchShortNote, main } from "../src/cli.mjs";
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
				// A registry and a keyspace scan that do not answer: only the shared queue and this host's own are named.
				makeRedisClient: () => ({ on() {}, disconnect() {}, async smembers() { throw new Error("registry boom"); }, async scan() { throw new Error("scan refused"); } }),
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
	assert.equal(killSwitchShortNote(true), "the list of queues may be short: the host registry or the look for queues could not be read, so other queues may exist and were not paused. Pause the fleet again once Valkey answers");
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
	// A pause that fails part-way over such a set says it too, under the queues it reached.
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
	assert.equal(said.join(""), `error: could not pause the whole deployment at redis://127.0.0.1:1/15\n  paused: pi-jobs\n  failed at: pi-jobs@hosta\n  down\n  and ${killSwitchShortNote(true)}\n`);
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
 * "counted, state unknown", the reverse. `probe` stands in for the probe when given, and `probeError` is an error the
 * probe reports as it connects.
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
					const paused = kind === "running, uncounted" ? false : kind === "counted, state unknown" ? null : kind;
					const counted = kind === "counted, state unknown" || (paused !== null && kind !== "running, uncounted");
					dropAfter.push(connection.disconnectTimeout);
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
	return { code, status: JSON.parse(output), err: errs.join(""), ms: performance.now() - started, asked, closed, dropAfter };
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
	assert.match(err, /^error: Valkey at redis:\/\/127\.0\.0\.1:6379 did not answer within 0\.3 seconds: is it running\? .*\n {2}the line above leaves out the paused state and counts of pi-jobs\n$/);
	assert.deepEqual(closed, [], "the deadline was spent before the queues: none was built, so none is left half open");
	// A connection that never came up is said in the connection's own words, as before the deadline.
	const unreached = await silentStatus({ probeError: "nothing answers VALKEY_URL (127.0.0.1:6379), so whose Valkey it is cannot be judged yet" });
	assert.equal(unreached.code, 1);
	assert.match(unreached.err, /^error: could not reach Valkey at redis:\/\/127\.0\.0\.1:6379: is it running\? .*\n {2}nothing answers VALKEY_URL \(127\.0\.0\.1:6379\), so whose Valkey it is cannot be judged yet\n {2}the line above leaves out the paused state and counts of pi-jobs\n$/);
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
	assert.equal(silent.code, 0, "complete false already says the list may be short");
	assert.deepEqual(silent.status, { item: "owner/repo#12", jobs: [], windows: [], complete: false, unavailableQueues: ["pi-jobs"], discoveryIncomplete: true, fleet: "registry timeout" });
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
