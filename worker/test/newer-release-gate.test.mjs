import assert from "node:assert/strict";
import { test } from "node:test";
import { modelAttemptKey } from "../src/model-failover.mjs";
import { makeSettledRecord, newerRecord } from "../src/run-history.mjs";
import { makeInFlight, rowScopeFor } from "../src/scoped-limits.mjs";
import { deferFieldsOf, withDeferRecords } from "./helpers/defer-redis.mjs";

// A job queued by a newer pi-dispatch (issue #761): the processor defers it before any gate reads its data, so it
// waits for a worker that can read it, and nothing is spent, recorded, settled or posted. And a run record a newer
// pi-dispatch wrote: the processor reads its stable core only, wherever it meets one.

// index.mjs imports bullmq; skip below the node floor / without deps, hard-fail in CI (mirrors pause-gate).
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`newer-release gate tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

const NOW = Date.UTC(2026, 10, 2, 9, 0);

function harness(extra = {}, depsExtra = {}) {
	const seen = { calls: [], records: 0, incr: 0, recorded: [], logs: [] };
	const touch = (name) => async (...args) => {
		seen.calls.push(name);
		return name === "prepareWorkspace" ? { workspaceDir: "/w", jobDir: "/j" } : name === "runContainer" ? { code: 0, aborted: false, turns: 1 } : undefined;
	};
	const redis = { get: async () => null, set: async () => "OK", incr: async () => (seen.incr++, 1), decr: async () => 0, expire: async () => {} };
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings: () => {
			seen.calls.push("getSettings");
			return { provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null };
		},
		pauseUntil: () => {
			seen.calls.push("pauseUntil");
			return null;
		},
		projects: () => {
			seen.calls.push("projects");
			return [];
		},
		now: () => NOW,
		recordRun: (args) => {
			seen.records++;
			seen.recorded.push(args);
		},
		timeoutMs: 100000,
		...extra,
		deps: {
			mintToken: touch("mintToken"),
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: touch("prepareWorkspace"),
			runContainer: touch("runContainer"),
			cleanup: async () => {},
			comment: touch("comment"),
			settleInbox: touch("settleInbox"),
			answerDraftRuntime: { resolve: touch("answerDraftRuntime") },
			log: (event, fields) => seen.logs.push([event, fields]),
			...depsExtra,
		},
	});
	return { processor, seen };
}

function spyJob(data) {
	const moves = [];
	return { job: { id: "gh-1", attemptsMade: 0, name: data.kind, data, moveToDelayed: async (ts, tok) => moves.push({ ts, tok }) }, moves };
}

test("a job whose dataVersion is above this build's waits ten minutes for an upgrade, before any gate or spend", { skip }, async () => {
	const { processor, seen } = harness();
	const { job, moves } = spyJob({ kind: "github", repo: "acme/web", target: { number: 1 }, flow: "fix", dataVersion: 2, trigger: { deliveryId: "d", sender: { id: 1 } } });
	await assert.rejects(() => processor(job, "the-token", new AbortController().signal), (err) => err.name === "DelayedError");
	assert.deepEqual(moves, [{ ts: NOW + mod.NEWER_RELEASE_RECHECK_MS, tok: "the-token" }]);
	assert.equal(mod.NEWER_RELEASE_RECHECK_MS, 600_000);
	assert.deepEqual(seen.calls, [], "no gate read the job, no settings read, nothing minted, cloned or run, no comment, no inbox settled");
	assert.equal(seen.records, 0, "no record: a deferral is not an outcome");
	assert.equal(seen.incr, 0, "no budget slot");
});

test("a dataVersion that is not an integer cannot be read here either, and waits the same way", { skip }, async () => {
	for (const odd of ["2", 0, 1.5, null]) {
		const { processor, seen } = harness();
		const { job, moves } = spyJob({ kind: "local", folder: "/srv/site", flow: "tidy", task: "t", dataVersion: odd });
		await assert.rejects(() => processor(job, "tok", new AbortController().signal), (err) => err.name === "DelayedError", JSON.stringify(odd));
		assert.equal(moves.length, 1);
		assert.deepEqual(seen.calls, []);
	}
});

test("a job with no dataVersion, or this build's own, runs as before", { skip }, async () => {
	for (const data of [{ kind: "local", folder: "/srv/site", flow: "tidy", task: "t" }, { kind: "local", folder: "/srv/site", flow: "tidy", task: "t", dataVersion: 1 }]) {
		const { processor, seen } = harness();
		const { job, moves } = spyJob(data);
		const result = await processor(job, "tok", new AbortController().signal);
		assert.equal(moves.length, 0);
		assert.equal(result.outcome, "completed");
		assert.ok(seen.calls.includes("runContainer"));
	}
});

// A run record a newer pi-dispatch wrote (`v` above this build's RUN_RECORD_VERSION, or a `v` no release writes): its
// stable core keeps its meaning (`RECORD_CORE_FIELDS`), and nothing else in it reaches what this build returns,
// writes or chooses. Each record below carries fields this build would act on if it believed them.
const iso = (ms) => new Date(ms).toISOString();
const core = (fields = {}) => ({ jobId: "gh-1", attempt: 1, outcome: "policy", startedAt: iso(NOW - 60_000), endedAt: iso(NOW - 1_000), host: "other-host", kind: "github", project: null, ...fields });
const HOSTILE = { reason: "runner-policy", exitCode: 2, turns: 9, tokens: { anything: 1 }, budgetReserved: { meaningChanged: true } };
const NOT_READABLE = [2, 0, "2", 1.5, null];

test("a lost-lock replay of a record a newer pi-dispatch wrote returns its outcome alone, never its other fields", { skip }, async () => {
	const stalled = (record) => {
		const { processor, seen } = harness({ settledRecord: makeSettledRecord({ readRecord: () => record }) });
		const { job } = spyJob({ kind: "github", repo: "acme/web", target: { number: 1 }, flow: "fix", trigger: { deliveryId: "d", sender: { id: 1 } } });
		job.stalledCounter = 1;
		job.timestamp = NOW - 120_000;
		return { run: () => processor(job, "tok", new AbortController().signal), seen };
	};
	for (const v of NOT_READABLE) {
		const newer = stalled({ ...core(), ...HOSTILE, v });
		assert.deepEqual(await newer.run(), { outcome: "policy", reason: null, exitCode: null, turns: null, tokens: null, budgetReserved: null }, `v ${JSON.stringify(v)}: no reason to page on, no usage, no reservation`);
		assert.deepEqual(newer.seen.logs.filter(([event]) => event === "job_lost_lock_after_completion").map(([, fields]) => fields), [{ jobId: "gh-1", outcome: "policy" }], "its reason is not logged either");
		assert.equal(newer.seen.records, 0, "the attempt is settled, so nothing is written over the record");
		assert.deepEqual(newer.seen.calls, ["getSettings"], "no container: the head's settings check, then the replay");
	}
	// A record this build can read replays every field, as it always did.
	for (const v of [1, undefined]) {
		const today = stalled({ ...core(), ...HOSTILE, budgetReserved: true, ...(v === undefined ? {} : { v }) });
		assert.deepEqual(await today.run(), { outcome: "policy", reason: "runner-policy", exitCode: 2, turns: 9, tokens: { anything: 1 }, budgetReserved: true });
		assert.deepEqual(today.seen.logs.filter(([event]) => event === "job_lost_lock_after_completion").map(([, fields]) => fields), [{ jobId: "gh-1", outcome: "policy", reason: "runner-policy" }]);
	}
});

const TOUCH = { v: 1, id: "c".repeat(64), type: "touch", runId: "source-park", cause: "question-answer", at: NOW - 5_000 };

test("a retry carries the prior attempt's touches forward only from a record this build can read", { skip }, async () => {
	for (const v of [...NOT_READABLE, 1, undefined]) {
		const carried = v === 1 || v === undefined;
		const prior = { ...core({ outcome: "failed" }), ...HOSTILE, touches: [TOUCH], touchLineageSkipped: "source-unavailable", ...(v === undefined ? {} : { v }) };
		const { processor, seen } = harness({ previousRecord: async () => prior });
		const { job } = spyJob({ kind: "local", folder: "/srv/site", flow: "tidy", task: "t" });
		job.attemptsMade = 1;
		assert.equal((await processor(job, "tok", new AbortController().signal)).outcome, "completed");
		const written = seen.recorded.at(-1).result;
		assert.deepEqual(written.touches, carried ? [TOUCH] : undefined, `v ${JSON.stringify(v)}`);
		assert.equal(written.touchLineageSkipped, carried ? "source-unavailable" : undefined, `v ${JSON.stringify(v)}`);
		for (const key of ["reason", "exitCode", "turns", "tokens", "budgetReserved"]) assert.notDeepEqual(written[key], HOSTILE[key], `v ${JSON.stringify(v)}: ${key} is this attempt's own`);
	}
});

// A failover retry (issue #502) chooses its model from the previous attempt's record and the model attempt key. A record
// a newer pi-dispatch wrote cannot say the attempt never started a container (that is in `reason`, `budgetReserved` and
// `exitCode`, outside its core), so with no key to lock to the job waits for a host that can read it: refusing it would
// comment, record and use up the delivery over work nothing is wrong with.
const FAILOVER_JOB = { kind: "github", repo: "org/repo", target: { number: 1 }, flow: "fix", provider: "openai", model: "primary", models: ["openai/primary", "anthropic/fallback"], fallbackModels: ["anthropic/fallback"], trigger: { deliveryId: "d", sender: { id: 1 } } };
const NEVER_STARTED = { reason: "container-never-started", budgetReserved: false, exitCode: null };

// The job's project, so the deferral's record is seen to carry it.
const PROJECTS = [{ id: "web", members: ["github:org/repo"] }];
// Enqueued two minutes before NOW: `core()`'s record (started a minute before NOW) is this job's.
const ENQUEUED = NOW - 120_000;

/**
 * A failover retry of gh-1 whose previous record is `prior`; `attempt` is the model attempt key's row, or none. `job`
 * overrides the queue job's fields (`attemptsMade` 1 and `timestamp` ENQUEUED unless given), `data` its data, `deps`
 * the processor's deps, and `getKey` answers the model attempt key's read in place of `attempt`. `previousRecord` reads
 * the previous record in place of answering `prior`.
 */
function failoverRetry({ prior, attempt = null, job: jobFields = {}, data = FAILOVER_JOB, deps = {}, getKey = null, previousRecord = async () => prior }) {
	const containers = [];
	const keysRead = [];
	const counts = { incr: 0 };
	const inFlight = makeInFlight();
	const attemptKey = modelAttemptKey(`${mod.QUEUE}:gh-1`);
	const redis = withDeferRecords({
		get: async (key) => {
			keysRead.push(key);
			if (key === attemptKey && getKey) return getKey();
			return key === attemptKey && attempt ? JSON.stringify(attempt) : null;
		},
		set: async () => "OK",
		incr: async () => (counts.incr++, 1),
		decr: async () => 0,
		expire: async () => {},
	});
	const { processor, seen } = harness(
		{
			redis,
			inFlight,
			getSettings: () => ({ provider: "openai", model: "primary", maxTurns: 5, dailyCap: 10, concurrency: 3, softHoldPct: null }),
			projects: () => PROJECTS,
			previousRecord,
			modelEndpoints: () => [],
			overlayModels: () => null,
		},
		{
			imagePreflight: async () => ({ ok: true, capabilities: ["exitAuth", "modelPolicy", "modelFailover"] }),
			checkFailoverCandidate: async () => null,
			mintToken: async () => (seen.calls.push("mintToken"), "scoped"),
			runContainer: async (ctx) => (containers.push(`${ctx.job.provider}/${ctx.job.model}`), { code: 0, aborted: false }),
			...deps,
		},
	);
	const { job, moves } = spyJob(data);
	Object.assign(job, { attemptsMade: 1, timestamp: ENQUEUED }, jobFields);
	return { run: () => processor(job, "the-token", new AbortController().signal), seen, moves, containers, keysRead, counts, inFlight, redis };
}

/** The `newer_release_hold` lines a run logged. */
const holdsOf = (r) => r.seen.logs.filter(([event]) => event === "newer_release_hold").map(([, fields]) => fields);

test("a failover retry whose previous record a newer pi-dispatch wrote, with no model attempt to lock to, waits ten minutes: nothing recorded, posted, reserved or run", { skip }, async () => {
	for (const v of NOT_READABLE) {
		const r = failoverRetry({ prior: { ...core({ outcome: "failed" }), ...NEVER_STARTED, v } });
		await assert.rejects(r.run, (err) => err.name === "DelayedError", `v ${JSON.stringify(v)}`);
		assert.deepEqual(r.moves, [{ ts: NOW + mod.NEWER_RELEASE_RECHECK_MS, tok: "the-token" }], `v ${JSON.stringify(v)}`);
		assert.deepEqual(holdsOf(r), [{ jobId: "gh-1", what: "the previous attempt's run record", delayMs: mod.NEWER_RELEASE_RECHECK_MS }], `v ${JSON.stringify(v)}: the store is named, never a value of it`);
		const reason = deferFieldsOf(r.redis, "gh-1");
		assert.deepEqual([reason?.why, reason?.project], ["newer-release", "web"], `v ${JSON.stringify(v)}: the reason the console shows, under the job's project`);
		assert.equal(r.seen.records, 0, `v ${JSON.stringify(v)}: no refusal recorded`);
		assert.deepEqual(r.seen.calls.filter((c) => ["mintToken", "prepareWorkspace", "runContainer", "comment", "settleInbox"].includes(c)), [], `v ${JSON.stringify(v)}: nothing minted, cloned, run or posted`);
		assert.deepEqual(r.containers, []);
		assert.equal(r.counts.incr, 0, `v ${JSON.stringify(v)}: no budget slot`);
		assert.equal(r.inFlight.count(rowScopeFor(FAILOVER_JOB, [])), 0, `v ${JSON.stringify(v)}: the repo slot the pickup took went back before the move`);
		assert.deepEqual(r.keysRead, [modelAttemptKey(`${mod.QUEUE}:gh-1`)], `v ${JSON.stringify(v)}: the model attempt key was asked, and nothing named a model`);
	}
});

test("a failover retry keeps today's answers: a model attempt key locks it to its model, and a record this build can read lets a never-started attempt choose again", { skip }, async () => {
	// The newer record, but the model attempt key names the model the previous attempt chose: the retry stays on it.
	for (const v of NOT_READABLE) {
		const locked = failoverRetry({ prior: { ...core({ outcome: "failed" }), ...NEVER_STARTED, v }, attempt: { ref: "anthropic/fallback", safe: false, failure: null } });
		const result = await locked.run();
		assert.equal(result.outcome, "completed", `v ${JSON.stringify(v)}: ${JSON.stringify(result)}`);
		assert.deepEqual(locked.containers, ["anthropic/fallback"], `v ${JSON.stringify(v)}`);
		assert.deepEqual(locked.moves, []);
		assert.equal(locked.seen.logs.some(([event]) => event === "newer_release_hold"), false);
	}
	// A record this build can read: the attempt provably never started a container, so the retry chooses again, from the
	// primary, without waiting.
	for (const v of [1, undefined]) {
		const today = failoverRetry({ prior: { ...core({ outcome: "failed" }), ...NEVER_STARTED, ...(v === undefined ? {} : { v }) } });
		const result = await today.run();
		assert.equal(result.outcome, "completed", JSON.stringify(result));
		assert.deepEqual(today.containers, ["openai/primary"]);
		assert.deepEqual(today.moves, []);
	}
	// A readable record that does not prove that, and no key: refused, free, as it always was.
	const started = failoverRetry({ prior: { ...core({ outcome: "failed" }), reason: "infra", budgetReserved: true, exitCode: 1 } });
	const refused = await started.run();
	assert.equal(refused.reason, "model-failover-no-candidate");
	assert.equal(refused.budgetReserved, false);
	assert.deepEqual(started.containers, []);
	assert.deepEqual(started.moves, []);
});

// Only the previous attempt's own record holds the retry (`recordOfThisJob`, the rule the lost-lock checks share): the
// same id, the previous attempt, and not older than the job. A record that is not, however new its release, says nothing
// about the attempt being retried, so the retry goes as one with no record: refused, free, with no key to lock to.
test("a failover retry waits only on its own previous attempt's record: a stale record under a reused id, an earlier attempt's or another job's is no record", { skip }, async () => {
	const newer = (fields = {}) => ({ ...core({ outcome: "failed", ...fields }), ...NEVER_STARTED, v: 2 });
	const longAgo = iso(ENQUEUED - 20 * 86_400_000);
	for (const [label, prior, job] of [
		["a stale record an older job left under the same id", newer({ startedAt: longAgo, endedAt: longAgo }), {}],
		["an earlier attempt's record", newer({ attempt: 1 }), { attemptsMade: 2 }],
		["another job's record", newer({ jobId: "gh-2" }), {}],
		["no record at all", null, {}],
	]) {
		const r = failoverRetry({ prior, job });
		const refused = await r.run();
		assert.equal(refused.reason, "model-failover-no-candidate", `${label}: ${JSON.stringify(refused)}`);
		assert.equal(refused.budgetReserved, false, `${label}: free`);
		assert.deepEqual(r.moves, [], `${label}: not held`);
		assert.deepEqual(holdsOf(r), [], label);
		assert.deepEqual(r.containers, [], label);
	}
	// Its own previous attempt's record holds it, after a failure (BullMQ counted that attempt) and after a scheduled job's
	// stall (BullMQ did not, so the stalled attempt carries this pickup's own number).
	for (const [label, prior, job] of [
		["the attempt before, after a failure", newer({ attempt: 2 }), { attemptsMade: 2 }],
		["the stalled attempt of a scheduled job", newer({ attempt: 1 }), { attemptsMade: 0, stalledCounter: 1 }],
		["a record with no start that ended after the job existed", newer({ startedAt: null }), {}],
	]) {
		const r = failoverRetry({ prior, job });
		await assert.rejects(r.run, (err) => err.name === "DelayedError", label);
		assert.deepEqual(holdsOf(r).map((fields) => fields.what), ["the previous attempt's run record"], label);
	}
});

// On a fleet the previous record is read from two sides, this host's file and the fleet's copy, and the higher attempt is
// kept. Ids are reused, so one side can hold a stale record an older job left at a higher attempt while this job's own
// previous record is on the other. The wait judges the record that passes the rule (`previousRecord`'s `keep`, applied to
// each side before the higher attempt is kept), so the stale one hides nothing.
test("a failover retry still waits when a stale record at a higher attempt on one side hides its own previous record, a newer pi-dispatch's, on the other", { skip }, async () => {
	const longAgo = iso(ENQUEUED - 20 * 86_400_000);
	/** Both sides as `previousRecord` reads them: `keep` holds each to the rule before the higher attempt is kept. */
	const twoSides = (local, mirrored, reads) => async (jobId, { keep = null } = {}) => {
		reads.push([jobId, typeof keep === "function"]);
		return newerRecord(...[local, mirrored].map((record) => (typeof keep === "function" && !keep(record) ? null : record)));
	};
	for (const staleRelease of [{ v: 2 }, {}]) {
		const stale = { ...core({ outcome: "failed", attempt: 3, startedAt: longAgo, endedAt: longAgo }), reason: "infra", budgetReserved: true, exitCode: 1, ...staleRelease };
		for (const [label, own, job, sides] of [
			["stale here, its own in the fleet's copy", 1, {}, (s, o) => [s, o]],
			["its own here, stale in the fleet's copy", 1, {}, (s, o) => [o, s]],
			["a scheduled job's stall, stale in the fleet's copy", 1, { attemptsMade: 0, stalledCounter: 1 }, (s, o) => [o, s]],
			["after the second failure, stale here", 2, { attemptsMade: 2 }, (s, o) => [s, o]],
		]) {
			const name = `${label}, the stale record ${staleRelease.v ? "newer" : "readable"}`;
			const reads = [];
			const r = failoverRetry({ previousRecord: twoSides(...sides(stale, { ...core({ outcome: "failed", attempt: own }), ...NEVER_STARTED, v: 2 }), reads), job });
			await assert.rejects(r.run, (err) => err.name === "DelayedError", name);
			assert.deepEqual(r.moves, [{ ts: NOW + mod.NEWER_RELEASE_RECHECK_MS, tok: "the-token" }], name);
			assert.deepEqual(holdsOf(r).map((fields) => fields.what), ["the previous attempt's run record"], name);
			assert.equal(deferFieldsOf(r.redis, "gh-1")?.why, "newer-release", name);
			assert.deepEqual(reads, [["gh-1", false], ["gh-1", true]], `${name}: the pickup's read, then both sides again, each held to the rule`);
			assert.deepEqual(r.keysRead, [modelAttemptKey(`${mod.QUEUE}:gh-1`)], `${name}: the model attempt key, once`);
			assert.deepEqual(r.containers, [], name);
			assert.equal(r.seen.records, 0, `${name}: no refusal recorded`);
		}
	}
	// The stale record alone, on either side: no record of its own, so refused, free, as before.
	const stale = { ...core({ outcome: "failed", attempt: 3, startedAt: longAgo, endedAt: longAgo }), ...NEVER_STARTED, v: 2 };
	const alone = failoverRetry({ previousRecord: twoSides(stale, null, []) });
	assert.equal((await alone.run()).reason, "model-failover-no-candidate");
	assert.deepEqual(alone.moves, []);
});

test("a recovery retry never waits on a newer previous record: it is locked to its checkpoint's model", { skip }, async () => {
	const manifests = [];
	const r = failoverRetry({
		prior: { ...core({ outcome: "failed" }), ...NEVER_STARTED, v: 2 },
		data: { ...FAILOVER_JOB, recover: true, recoveryOf: "gh-0" },
		deps: { workspaceCheckpointer: { readManifest: async (runId) => (manifests.push(runId), { ok: true, manifest: { provider: "anthropic", model: "fallback" } }) } },
	});
	let outcome;
	try {
		outcome = await r.run();
	} catch (error) {
		outcome = error;
	}
	assert.notEqual(outcome?.name, "DelayedError", JSON.stringify(outcome));
	assert.deepEqual(r.moves, [], "not held");
	assert.deepEqual(holdsOf(r), []);
	assert.deepEqual(manifests, ["gh-0"], "the checkpoint named the model");
	assert.equal(r.keysRead.includes(modelAttemptKey(`${mod.QUEUE}:gh-1`)), true, "the selection, not the wait, read the key");
});

test("a fault reading the model attempt key is retried as infrastructure, never a wait", { skip }, async () => {
	for (const [label, getKey] of [["a Valkey fault", async () => { throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }); }], ["a malformed key", async () => "{not json"]]) {
		const r = failoverRetry({ prior: { ...core({ outcome: "failed" }), ...NEVER_STARTED, v: 2 }, getKey });
		await assert.rejects(r.run, (err) => err.name === "InfraRetry" && err.reason === "container-never-started", label);
		assert.deepEqual(r.moves, [], `${label}: not held`);
		assert.deepEqual(holdsOf(r), [], label);
		assert.deepEqual(r.containers, [], label);
		assert.equal(r.seen.calls.includes("mintToken"), false, `${label}: nothing minted`);
	}
});
