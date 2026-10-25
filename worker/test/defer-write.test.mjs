import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DEFER_WHYS, deferKey, deferTtlMs } from "../src/defer-reasons.mjs";
import { deferFieldsOf, deferRecordOf, withDeferRecords } from "./helpers/defer-redis.mjs";

// The worker's deferral writer (issue #737): every gate's move goes through `deferTo`, which records the gate's reason
// first, bounded and fail-open, and an infrastructure retry's backoff is noted by `noteRetry`. The writer throws the
// DelayedError class it is handed, BullMQ's; skip below the node floor / without deps, hard-fail in CI (mirrors
// pause-gate).
let mod;
let bullmq;
let importError;
try {
	mod = await import("../src/defer-write.mjs");
	bullmq = await import("bullmq");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`defer-write tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

const NOW = Date.UTC(2026, 9, 25, 12, 0);
/** The writer as the processor builds it: with BullMQ's own DelayedError class. */
const make = (opts) => mod.makeDeferTo({ DelayedError: bullmq.DelayedError, ...opts });
const N1 = "00000000000000a1";
const N2 = "00000000000000b2";

/** A job whose move is spied, and whose own order of events is shared with the redis fake's. */
function spyJob({ id = "gh-1", data = { kind: "github", trigger: { matched: { index: 3 } } }, move = null, events = [] } = {}) {
	const moves = [];
	return {
		job: { id, attemptsMade: 0, data, moveToDelayed: async (ts, tok) => (events.push("move"), moves.push({ ts, tok }), move ? move(ts, tok) : undefined) },
		moves,
		events,
	};
}

function writer({ redis = withDeferRecords({}), hostName = "build3", timeoutMs = 50, nonces = [N1, N2, N1, N2], now = () => NOW } = {}) {
	const logs = [];
	let i = 0;
	const d = make({ redis, now, hostName, log: (event, fields) => logs.push({ event, fields }), nonce: () => nonces[i++ % nonces.length], timeoutMs });
	return { ...d, redis, logs };
}

test("the reason is written BEFORE the move, as one transaction, and the move throws BullMQ's own DelayedError", { skip }, async () => {
	const events = [];
	const redis = withDeferRecords({});
	const multi = redis.multi;
	redis.multi = () => (events.push("write"), multi());
	const w = writer({ redis });
	const { job, moves } = spyJob({ events });
	await assert.rejects(() => w.deferTo(job, "the-token", NOW + 5_000, "host-slot", { project: "shop" }), (e) => e instanceof bullmq.DelayedError && e.name === "DelayedError");
	assert.deepEqual(events, ["write", "move"], "written first, so the record is there the moment the job is delayed");
	assert.deepEqual(moves, [{ ts: NOW + 5_000, tok: "the-token" }], "the gate's instant and the worker's token, unchanged");
	// DEL, HSET, PEXPIRE in one MULTI: an earlier deferral's fields never mix with this one's.
	const key = deferKey("gh-1");
	assert.deepEqual(redis.deferSent[0].map((op) => op[0]), ["del", "hset", "pexpire"]);
	assert.deepEqual(redis.deferSent[0][0], ["del", key]);
	assert.deepEqual(redis.deferSent[0][2], ["pexpire", key, deferTtlMs(NOW + 5_000, NOW)]);
	assert.deepEqual(deferFieldsOf(redis, "gh-1"), { why: "host-slot", at: String(NOW), until: String(NOW + 5_000), project: "shop", host: "build3", trigger: "3", n: N1 });
	assert.deepEqual(deferRecordOf(redis, "gh-1"), { why: "host-slot", known: true, bucket: "slot", at: NOW, until: NOW + 5_000, project: "shop", host: "build3", holder: null, endpoint: null, budgetWhy: null, trigger: 3, attempt: null, attempts: null });
	assert.deepEqual(w.logs, [], "a write that worked says nothing");
});

test("the writer is built only with BullMQ's DelayedError class: a stand-in would read as a failure in the processor's catch", { skip }, () => {
	for (const bad of [undefined, null, "DelayedError", {}]) assert.throws(() => mod.makeDeferTo({ redis: {}, DelayedError: bad }), TypeError, String(bad));
	assert.throws(() => mod.makeDeferTo(), TypeError);
	assert.equal(typeof make({ redis: {} }).deferTo, "function");
});

test("a field that fails its rule is left out, and the record is still written", { skip }, async () => {
	const w = writer({ hostName: "not a host name" });
	const { job } = spyJob({ data: { trigger: { matched: { index: 1.5 } } } });
	await assert.rejects(() => w.deferTo(job, "tok", NOW + 1_234.7, "chained", { project: "Shop", holder: "parent 1" }), (e) => e.name === "DelayedError");
	assert.deepEqual(deferFieldsOf(w.redis, "gh-1"), { why: "chained", at: String(NOW), until: String(NOW + 1_234), n: N1 }, "whole milliseconds for the due time; no host, project, holder or trigger that fails its rule");
	// A job with no id writes nothing (the key would name nobody), and still moves.
	const anonymous = spyJob();
	delete anonymous.job.id;
	await assert.rejects(() => w.deferTo(anonymous.job, "tok", NOW + 1_000, "host-slot"), (e) => e.name === "DelayedError");
	assert.equal(anonymous.moves.length, 1);
	assert.equal(w.redis.deferSent.length, 1);
});

test("no multi means no write: a bare wiring moves exactly as it always did, and says nothing", { skip }, async () => {
	const logs = [];
	const calls = [];
	const bare = new Proxy({}, { get: (_t, prop) => (calls.push(prop), undefined) });
	const d = make({ redis: bare, now: () => NOW, log: (event) => logs.push(event) });
	const { job, moves } = spyJob();
	await assert.rejects(() => d.deferTo(job, "tok", NOW + 5_000, "pause-window"), (e) => e.name === "DelayedError");
	assert.deepEqual(moves, [{ ts: NOW + 5_000, tok: "tok" }]);
	assert.deepEqual(calls, ["multi"], "only asked whether it can write");
	assert.deepEqual(logs, []);
	assert.equal(await d.writeReason(job, { why: "host-slot", untilMs: NOW }), null);
	for (const redis of [null, undefined, { multi: "no" }]) {
		const none = make({ redis, now: () => NOW });
		const s = spyJob();
		await assert.rejects(() => none.deferTo(s.job, "tok", NOW + 1, "host-slot"), (e) => e.name === "DelayedError");
		assert.equal(s.moves.length, 1);
	}
});

test("a failed write still moves: a rejected exec, an error reply, a transaction that cannot be built, an unknown reason", { skip }, async () => {
	const cases = [
		["rejected", { exec: async () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:6379"), { code: "ECONNREFUSED" })) }, "ECONNREFUSED"],
		["error reply", { exec: async (ops) => ops.map((_, i) => (i === 1 ? [new Error("WRONGTYPE"), null] : [null, 1])) }, "error-reply"],
		["aborted transaction", { exec: async () => null }, "error-reply"],
		["unnamed rejection", { exec: async () => Promise.reject(new Error("redis://:secret@host/0 went away")) }, "rejected"],
	];
	for (const [label, opts, reason] of cases) {
		const w = writer({ redis: withDeferRecords({}, opts) });
		const { job, moves } = spyJob();
		await assert.rejects(() => w.deferTo(job, "tok", NOW + 5_000, "host-slot"), (e) => e.name === "DelayedError", label);
		assert.deepEqual(moves, [{ ts: NOW + 5_000, tok: "tok" }], `${label}: moved all the same`);
		assert.deepEqual(w.logs, [{ event: "defer_reason_unwritten", fields: { why: "host-slot", reason } }], `${label}: said once, by a fixed word or a code`);
		assert.ok(!JSON.stringify(w.logs).includes("secret") && !JSON.stringify(w.logs).includes("10.0.0.9"), "never the error's message");
	}
	// A client whose transaction throws while it is built.
	const thrower = writer({ redis: { multi: () => ({ del: () => { throw new Error("boom"); } }) } });
	const t = spyJob();
	await assert.rejects(() => thrower.deferTo(t.job, "tok", NOW + 1, "endpoint", { endpoint: "lan-ollama" }), (e) => e.name === "DelayedError");
	assert.equal(t.moves.length, 1);
	assert.deepEqual(thrower.logs.map((l) => [l.event, l.fields.reason]), [["defer_reason_unwritten", "threw"]]);
	// A reason outside the table is a defect at the call site: no write, logged, and the job still moves.
	const unknown = writer();
	const u = spyJob();
	assert.equal(await unknown.writeReason(u.job, { why: "made-up", untilMs: NOW }), null, "never rejects");
	await assert.rejects(() => unknown.deferTo(u.job, "tok", NOW + 1, "made-up"), (e) => e.name === "DelayedError");
	assert.equal(u.moves.length, 1);
	assert.equal(unknown.redis.deferSent.length, 0);
	assert.deepEqual(unknown.logs, [{ event: "defer_reason_unwritten", fields: { why: "made-up", reason: "threw" } }]);
});

test("a slow write is waited for at most the bound, then the job moves; its nonce is kept, since the MULTI may still land", { skip }, async () => {
	let land;
	const redis = withDeferRecords({}, { exec: () => new Promise((resolve) => (land = resolve)) });
	const w = writer({ redis, timeoutMs: 20 });
	const { job, moves } = spyJob();
	const started = Date.now();
	await assert.rejects(() => w.deferTo(job, "tok", NOW + 5_000, "host-budget", { budgetWhy: "budget" }), (e) => e.name === "DelayedError");
	assert.ok(Date.now() - started < 1_000, "bounded, not waiting for the outage to end");
	assert.equal(moves.length, 1);
	assert.deepEqual(w.logs, [{ event: "defer_reason_unwritten", fields: { why: "host-budget", reason: "timeout" } }]);
	land([[null, 1]]);
	const slow = writer({ redis: withDeferRecords({}, { exec: () => new Promise(() => {}) }), timeoutMs: 10 });
	assert.deepEqual(await slow.writeReason(spyJob().job, { why: "host-slot", untilMs: NOW }), { n: N1 }, "sent, so its compare-and-delete can follow it");
});

test("a move that rejects is rethrown RAW, after the compare-and-delete removed this write's record", { skip }, async () => {
	const lost = new Error("Missing lock for job gh-1. moveToDelayed");
	const w = writer();
	const { job } = spyJob({ move: async () => Promise.reject(lost) });
	await assert.rejects(() => w.deferTo(job, "tok", NOW + 5_000, "scope-repo"), (e) => e === lost, "the very error, so BullMQ's failed-attempt handling sees what it always saw");
	assert.deepEqual(w.redis.deferRemovals, [{ key: deferKey("gh-1"), n: N1 }], "by this write's nonce");
	assert.equal(deferFieldsOf(w.redis, "gh-1"), null, "the record of a deferral that did not happen is gone");

	// Another worker's record for a later deferral of the same id (its own nonce) is left alone.
	const other = writer();
	const raced = spyJob({
		move: async () => {
			other.redis.deferHashes.get(deferKey("gh-1")).set("n", N2);
			throw lost;
		},
	});
	await assert.rejects(() => other.deferTo(raced.job, "tok", NOW + 5_000, "scope-repo"), (e) => e === lost);
	assert.equal(deferFieldsOf(other.redis, "gh-1").n, N2, "another writer's record survives");

	// No record written: nothing to remove, and the rejection is still raw.
	const bare = make({ redis: { eval: async () => assert.fail("no write, no delete") }, now: () => NOW });
	await assert.rejects(() => bare.deferTo(spyJob({ move: async () => Promise.reject(lost) }).job, "tok", NOW + 1, "host-slot"), (e) => e === lost);

	// A compare-and-delete that fails, or never answers, is bounded and swallowed: the move's rejection is what escapes.
	for (const evalFn of [async () => Promise.reject(new Error("down")), () => new Promise(() => {}), () => { throw new Error("sync"); }]) {
		const redis = withDeferRecords({});
		redis.eval = evalFn;
		const h = writer({ redis, timeoutMs: 10 });
		await assert.rejects(() => h.deferTo(spyJob({ move: async () => Promise.reject(lost) }).job, "tok", NOW + 1, "host-slot"), (e) => e === lost);
	}
	// A move that throws synchronously-ish (a TypeError from a broken job) is raw too.
	const broken = { id: "gh-9", data: {}, moveToDelayed: () => { throw new TypeError("not a job"); } };
	await assert.rejects(() => writer().deferTo(broken, "tok", NOW + 1, "host-slot"), (e) => e instanceof TypeError && e.message === "not a job");
});

test("an outage is ONE episode in the log: the first failure says so, the first success after it says so, nothing between", { skip }, async () => {
	let failing = true;
	const redis = withDeferRecords({}, { exec: async (ops) => (failing ? Promise.reject(Object.assign(new Error("x"), { code: "ETIMEDOUT" })) : ops.map(() => [null, 1])) });
	const w = writer({ redis });
	const defer = (why) => assert.rejects(() => w.deferTo(spyJob().job, "tok", NOW + 5_000, why), (e) => e.name === "DelayedError");
	for (let i = 0; i < 5; i++) await defer("host-slot");
	assert.deepEqual(w.logs, [{ event: "defer_reason_unwritten", fields: { why: "host-slot", reason: "ETIMEDOUT" } }], "five failures, one line");
	failing = false;
	await defer("endpoint");
	await defer("endpoint");
	assert.deepEqual(w.logs.at(-1), { event: "defer_reason_restored", fields: { why: "endpoint" } });
	assert.equal(w.logs.length, 2, "restored once");
	failing = true;
	await defer("wait-hold");
	assert.deepEqual(w.logs.at(-1), { event: "defer_reason_unwritten", fields: { why: "wait-hold", reason: "ETIMEDOUT" } }, "a new outage is a new episode");
	assert.equal(w.logs.length, 3);
});

test("a logger that throws is never in a deferral's way: the job still moves and throws DelayedError, and an episode is still said once", { skip }, async () => {
	let failing = true;
	const redis = withDeferRecords({}, { exec: async (ops) => (failing ? Promise.reject(Object.assign(new Error("x"), { code: "ECONNRESET" })) : ops.map(() => [null, 1])) });
	const said = [];
	const log = (event) => {
		said.push(event);
		throw new Error("the log's sink is gone");
	};
	const w = make({ redis, now: () => NOW, hostName: "build3", log, nonce: () => N1, timeoutMs: 50 });
	const defer = async (why) => {
		const { job, moves } = spyJob();
		await assert.rejects(() => w.deferTo(job, "tok", NOW + 5_000, why), (e) => e instanceof bullmq.DelayedError, `${why}: the deferral's own throw, never the log's`);
		assert.deepEqual(moves, [{ ts: NOW + 5_000, tok: "tok" }], `${why}: moved all the same`);
	};
	await defer("host-slot");
	await defer("host-slot");
	assert.deepEqual(await w.writeReason(spyJob().job, { why: "endpoint", untilMs: NOW }), { n: N1 }, "the write itself never rejects for its log either");
	failing = false;
	await defer("endpoint");
	assert.deepEqual(said, ["defer_reason_unwritten", "defer_reason_restored"], "the episode counted once each way, though both lines threw");
	// A transaction that cannot be built logs from the writer's own catch: that log throwing is swallowed too.
	const built = make({ redis: { multi: () => { throw new Error("down"); } }, now: () => NOW, log });
	assert.equal(await built.writeReason(spyJob().job, { why: "host-slot", untilMs: NOW }), null);
	const t = spyJob();
	await assert.rejects(() => built.deferTo(t.job, "tok", NOW + 1, "host-slot"), (e) => e instanceof bullmq.DelayedError);
	assert.equal(t.moves.length, 1);
});

test("retryDelayOf mirrors the pinned BullMQ's retry decision and builtin backoffs, and is null for what it cannot know", { skip }, () => {
	const job = (opts, attemptsMade = 0, extra = {}) => ({ attemptsMade, opts, ...extra });
	// The queue's own policy (queue.mjs): two attempts, exponential from a minute.
	const queuePolicy = { attempts: 2, backoff: { type: "exponential", delay: 60_000 } };
	assert.equal(mod.retryDelayOf(job(queuePolicy)), 60_000, "2^0 * delay before the second attempt");
	assert.equal(mod.retryDelayOf(job(queuePolicy, 1)), null, "the last attempt is not retried");
	assert.equal(mod.retryDelayOf(job({ attempts: 4, backoff: { type: "exponential", delay: 1_000 } }, 2)), 4_000, "2^2 * delay");
	assert.equal(mod.retryDelayOf(job({ attempts: 3, backoff: { type: "exponential", delay: 333 } }, 1)), 666);
	assert.equal(mod.retryDelayOf(job({ attempts: 3, backoff: { type: "fixed", delay: 5_000 } }, 1)), 5_000);
	assert.equal(mod.retryDelayOf(job({ attempts: 3, backoff: 7_000 })), 7_000, "a number is a fixed backoff");
	for (const [label, j] of [
		["jitter", job({ attempts: 3, backoff: { type: "fixed", delay: 5_000, jitter: 0.5 } })],
		["exponential jitter", job({ attempts: 3, backoff: { type: "exponential", delay: 5_000, jitter: 1 } })],
		["custom", job({ attempts: 3, backoff: { type: "mine", delay: 5_000 } })],
		["no backoff", job({ attempts: 3 })],
		["zero delay", job({ attempts: 3, backoff: { type: "fixed", delay: 0 } })],
		["negative", job({ attempts: 3, backoff: -5 })],
		["no attempts", job({ backoff: 5_000 })],
		["one attempt", job({ attempts: 1, backoff: 5_000 })],
		["discarded", job({ attempts: 3, backoff: 5_000 }, 0, { discarded: true })],
		["no opts", { attemptsMade: 0 }],
		["no attemptsMade", { opts: { attempts: 3, backoff: 5_000 } }],
		["null", null],
	]) {
		assert.equal(mod.retryDelayOf(j), null, label);
	}
	assert.equal(mod.retryDelayOf(job({ attempts: 3, backoff: { type: "fixed", delay: 5_000, jitter: 0 } })), 5_000, "jitter 0 is no jitter");
});

test("noteRetry records the retry's backoff as attempt N of M, and nothing when BullMQ will not delay a retry", { skip }, async () => {
	const w = writer();
	const job = { id: "gh-7", attemptsMade: 0, opts: { attempts: 2, backoff: { type: "exponential", delay: 60_000 } }, data: { trigger: { matched: { index: 0 } } } };
	await w.noteRetry(job, { project: "shop" });
	assert.deepEqual(deferRecordOf(w.redis, "gh-7"), { why: "retry", known: true, bucket: "retry", at: NOW, until: NOW + 60_000, project: "shop", host: "build3", holder: null, endpoint: null, budgetWhy: null, trigger: 0, attempt: 2, attempts: 2 });
	await w.noteRetry({ ...job, id: "gh-8", attemptsMade: 1 });
	assert.equal(deferFieldsOf(w.redis, "gh-8"), null, "the last attempt: no retry, no record");
	await w.noteRetry({ id: "gh-9", attemptsMade: 0, data: {} });
	assert.equal(deferFieldsOf(w.redis, "gh-9"), null, "a job with no retry policy");
	// Never in the way of the throw it precedes.
	const broken = writer({ redis: { multi: () => { throw new Error("down"); } } });
	await broken.noteRetry(job);
	await broken.noteRetry(null);
	await broken.noteRetry({ get opts() { throw new Error("getter"); } });
});

test("noteRetry reads the clock once: its record's at and until are the backoff apart, however the clock moves between reads", { skip }, async () => {
	let t = NOW;
	const w = writer({ now: () => t++ });
	await w.noteRetry({ id: "gh-10", attemptsMade: 0, opts: { attempts: 2, backoff: { type: "exponential", delay: 60_000 } }, data: {} });
	const record = deferRecordOf(w.redis, "gh-10");
	assert.equal(record.until - record.at, 60_000, "one instant, plus the delay BullMQ applies");
	assert.equal(record.at, NOW);
});

// --- the source: one deferral path, and every reason written by a site ------------------------------------------

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("BY SHAPE: no module in worker/src moves a job to the delayed set except through defer-write.mjs", () => {
	const offenders = [];
	for (const name of readdirSync(SRC, { recursive: true })) {
		if (!/\.mjs$/.test(name) || name === "defer-write.mjs") continue;
		if (/\.moveToDelayed\(/.test(strip(readFileSync(join(SRC, name), "utf8")))) offenders.push(name);
	}
	assert.deepEqual(offenders, [], "a deferral that bypasses deferTo records no reason");
	assert.match(strip(readFileSync(join(SRC, "defer-write.mjs"), "utf8")), /await job\.moveToDelayed\(untilMs, token\);/, "and the writer makes the one move");
});

test("BY SHAPE: every reason in the table is written by a site, and every site writes a reason from the table", () => {
	const index = strip(readFileSync(join(SRC, "index.mjs"), "utf8"));
	const sites = [...index.matchAll(/\bawait deferTo\(job, token, [^\n]*?, ("[^"]*"|why), /g)].map((m) => m[1]);
	assert.equal(sites.length, 18, "18 deferTo calls, one of them deferScope's; a new deferral must be counted here");
	assert.deepEqual(sites.filter((s) => s === "why"), ["why"], "only deferScope passes its caller's reason through");
	const literal = new Set(sites.filter((s) => s !== "why").map((s) => JSON.parse(s)));
	for (const m of index.matchAll(/\bawait deferScope\(("[^"]*"|scopeWhy), /g)) if (m[1] !== "scopeWhy") literal.add(JSON.parse(m[1]));
	assert.equal([...index.matchAll(/\bawait deferScope\(/g)].length, 4, "four scope deferrals");
	const scopeWhy = /const scopeWhy = ([^;]*);/.exec(index)?.[1];
	assert.ok(scopeWhy, "the repo or folder slot's reason is one expression");
	// The ternary's results, not the strings it compares against.
	for (const m of scopeWhy.matchAll(/[?:] "([^"]*)"/g)) literal.add(m[1]);
	assert.match(strip(readFileSync(join(SRC, "defer-write.mjs"), "utf8")), /why: "retry", untilMs: at \+ delay/);
	literal.add("retry");
	assert.deepEqual([...literal].sort(), Object.keys(DEFER_WHYS).sort(), "the table and the sites agree: no reason nobody writes, no site outside the table");
	// The four infrastructure retries note their backoff right before their throw.
	assert.equal([...index.matchAll(/await noteRetry\(job, \{ project \}\);\n\t+throw (?:loop|error);/g)].length, 4);
});
