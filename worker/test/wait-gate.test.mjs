import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCheckWaitSkew } from "../src/triggers-file.mjs";
import { WAIT_AFTER_MAX_DEFAULT_MS } from "../src/wait-for.mjs";
import { makeWaitState } from "../src/wait-state.mjs";

// index.mjs imports bullmq; skip below the node floor / without deps, hard-fail in CI (mirrors pause-gate).
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`wait-gate tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

const NOW = Date.UTC(2026, 7, 30, 12, 0); // 2026-08-30 12:00 UTC
const iso = (ms) => new Date(ms).toISOString();

/** A redis whose INCR is spied (a deferred job must burn no budget slot) plus the hash/set ops wait state uses. */
function fakeRedis() {
	const store = new Map();
	const hashes = new Map();
	const sets = new Map();
	const r = { incrCalls: 0, store, hashes, sets };
	r.incr = async () => (r.incrCalls++, 1);
	r.decr = async () => 0;
	r.expire = async () => {};
	r.pexpire = async () => 1;
	r.hsetnx = async (k, f, v) => {
		const h = hashes.get(k) ?? new Map();
		hashes.set(k, h);
		if (h.has(f)) return 0;
		h.set(f, v);
		return 1;
	};
	r.hset = async (k, ...kv) => {
		const h = hashes.get(k) ?? new Map();
		hashes.set(k, h);
		for (let i = 0; i < kv.length; i += 2) h.set(kv[i], kv[i + 1]);
		return 1;
	};
	r.hget = async (k, f) => hashes.get(k)?.get(f) ?? null;
	r.sadd = async (k, v) => (sets.set(k, (sets.get(k) ?? new Set()).add(v)), 1);
	r.srem = async (k, v) => (sets.get(k)?.delete(v), 1);
	r.del = async (k) => (store.delete(k), hashes.delete(k), 1);
	r.get = async (k) => store.get(k) ?? null;
	r.set = async (k, v, ...opts) => {
		if (opts.includes("NX") && store.has(k)) return null;
		store.set(k, v);
		return "OK";
	};
	return r;
}

/** A BullMQ-shaped job recording the (timestamp, token) it was deferred with. */
function spyJob(data, { id = "gh-1", deduplicationId = "acme/web#7:deploy" } = {}) {
	const moves = [];
	return { job: { id, attemptsMade: 0, name: data.kind, data, deduplicationId, timestamp: NOW - 5 * 3600 * 1000, moveToDelayed: async (ts, tok) => moves.push({ ts, tok }) }, moves };
}

function harness({ redis = fakeRedis(), deps = {}, afterMaxMs, waitState } = {}) {
	const seen = { containerCalls: 0, records: [], logs: [], comments: [] };
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		now: () => NOW,
		recordRun: (r) => seen.records.push(r),
		timeoutMs: 100000,
		...(afterMaxMs ? { afterMaxMs } : {}),
		...(waitState ? { waitState } : {}),
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => (seen.containerCalls++, { code: 0, aborted: false, turns: 3 }),
			cleanup: async () => {},
			comment: async (_j, text) => seen.comments.push(text),
			log: (e, f) => seen.logs.push({ e, f }),
			...deps,
		},
	});
	return { processor, seen, redis };
}

const forge = (waitFor) => ({ kind: "github", repo: "acme/web", target: { number: 7 }, flow: "deploy", trigger: { deliveryId: "d", sender: { id: 1 }, matched: { index: 0, type: "label" } }, ...(waitFor !== undefined && { waitFor }) });

// --- the `after` hold ---------------------------------------------------------------------------------

test("a future `after` defers to the EXACT instant, spends nothing, and starts no container", { skip }, async () => {
	const until = NOW + 3 * 3600 * 1000;
	const { job, moves } = spyJob(forge([{ after: iso(until) }]));
	const { processor, seen, redis } = harness();

	await assert.rejects(() => processor(job, "the-token", new AbortController().signal), (e) => e.name === "DelayedError");

	assert.equal(moves.length, 1);
	assert.equal(moves[0].ts, until, "deferred to the operator's own instant, not to a re-check cadence -- an `after` polls nothing");
	assert.equal(moves[0].tok, "the-token");
	assert.equal(redis.incrCalls, 0, "no budget slot on the defer path");
	assert.equal(seen.containerCalls, 0);
	assert.equal(seen.records.length, 0, "a hold is not a run: no record, and moveToDelayed consumes no attempt");
	assert.ok(seen.logs.some((l) => l.e === "wait_deferred"), "and it is VISIBLE -- the pause gate's silence is what this issue exists to fix");
});

test("a past `after` runs, and the boundary tick runs rather than busy-deferring", { skip }, async () => {
	for (const [label, until] of [
		["already past", NOW - 1000],
		["exactly now", NOW],
		["inside the 1s guard", NOW + 500],
	]) {
		const { job, moves } = spyJob(forge([{ after: iso(until) }]));
		const { processor, seen } = harness();
		const result = await processor(job, "tok", new AbortController().signal);
		assert.equal(moves.length, 0, label);
		assert.equal(result.outcome, "completed", label);
		assert.equal(seen.containerCalls, 1, label);
	}
});

test("an `after` fifty hours out is ADMITTED -- the ceiling is not the polling budget", { skip }, async () => {
	// The bound that governs here is PI_WAIT_AFTER_MAX_MS (30 days), NOT the maximum hold. An `after` is one
	// exact moveToDelayed, self-terminating and costing nothing while it waits, so bounding it by a budget
	// meant for subprocesses would refuse the most obvious use of the field there is.
	const until = NOW + 50 * 3600 * 1000;
	const { job, moves } = spyJob(forge([{ after: iso(until) }]));
	const { processor } = harness();
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(moves[0].ts, until);
});

test("an `after` beyond the ceiling refuses at FIRST pickup, with its own reason", { skip }, async () => {
	const until = NOW + WAIT_AFTER_MAX_DEFAULT_MS + 60_000;
	const { job, moves } = spyJob(forge([{ after: iso(until) }]));
	const { processor, seen, redis } = harness();

	const result = await processor(job, "tok", new AbortController().signal);

	assert.equal(result.outcome, "policy");
	assert.equal(result.reason, "wait-after-beyond-max", "its own token: nothing expired, so `wait-expired` would be a lie");
	assert.equal(result.budgetReserved, false);
	assert.equal(redis.incrCalls, 0);
	assert.equal(moves.length, 0, "refused NOW rather than held for a month and then refused");
	assert.equal(seen.records.length, 1, "and it is durable: a refusal an operator can find");
	assert.equal(seen.comments.length, 1);
});

// --- profiles, before an enforcement slice exists ------------------------------------------------------

test("a profile condition refuses pre-spend while no checker is wired -- never runs unchecked", { skip }, async () => {
	const { job, moves } = spyJob(forge([{ profile: "jira" }]));
	const { processor, seen, redis } = harness();

	const result = await processor(job, "tok", new AbortController().signal);

	assert.equal(result.reason, "wait-profile-unknown");
	assert.equal(result.budgetReserved, false);
	assert.equal(redis.incrCalls, 0);
	assert.equal(seen.containerCalls, 0, "the failure this refusal exists to prevent: a wait that silently passed");
	assert.equal(moves.length, 0);
	assert.ok(seen.comments[0].includes("jira"), "the comment names the operator's own profile name");
	assert.ok(!seen.comments[0].includes("/"), "and never a path -- a declared resolver's location is vault topology");
});

test("a determinate refusal comes BEFORE a hold: an unanswerable profile does not wait a day first", { skip }, async () => {
	const { job, moves } = spyJob(forge([{ after: iso(NOW + 24 * 3600 * 1000) }, { profile: "jira" }]));
	const { processor } = harness();
	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(result.reason, "wait-profile-unknown");
	assert.equal(moves.length, 0, "refused now, not held to the instant and refused tomorrow");
});

// --- the wait state -----------------------------------------------------------------------------------

test("`since` is stamped once and is NOT job.timestamp -- pause and backoff time are not wait time", { skip }, async () => {
	const redis = fakeRedis();
	const state = makeWaitState({ redis, now: () => NOW });
	const until = NOW + 3600 * 1000;
	const { job } = spyJob(forge([{ after: iso(until) }]));
	const { processor } = harness({ redis, waitState: state });

	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");

	const since = Number(await redis.hget(`wait:job:${job.id}`, "since"));
	assert.equal(since, NOW, "the hold clock starts when the hold does");
	assert.notEqual(since, job.timestamp, "and job.timestamp is five hours older -- that is queue time, not wait time");

	// A re-pick must not restart it, or the bound would never be reached.
	const later = makeWaitState({ redis, now: () => NOW + 600_000 });
	await later.hold(job.id, { dedupId: job.deduplicationId, untilMs: until });
	assert.equal(Number(await redis.hget(`wait:job:${job.id}`, "since")), NOW, "HSETNX, not HSET");
	assert.equal(await later.heldForMs(job.id), 600_000);
});

test("a second delivery for a LIVE held target is superseded rather than held beside it", { skip }, async () => {
	const redis = fakeRedis();
	const state = makeWaitState({ redis, now: () => NOW });
	const until = NOW + 3600 * 1000;
	const live = new Set(["gh-1"]);
	const first = spyJob(forge([{ after: iso(until) }]), { id: "gh-1" });
	const second = spyJob(forge([{ after: iso(until) }]), { id: "gh-2" }); // same deduplicationId: same target+flow

	const { processor } = harness({ redis, waitState: state, deps: { isJobLive: async (id) => live.has(id) } });
	await assert.rejects(() => processor(first.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");

	const result = await processor(second.job, "tok", new AbortController().signal);
	assert.equal(result.reason, "wait-superseded", "both would clear together and both would be paid");
	assert.equal(second.moves.length, 0);

	// And when the holder clears, the target is free again.
	await state.release("gh-1", { dedupId: `${first.job.deduplicationId}#0` });
	const third = spyJob(forge([{ after: iso(until) }]), { id: "gh-3" });
	live.add("gh-3");
	await assert.rejects(() => processor(third.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(third.moves.length, 1, "a delivery after the hold cleared is admitted, not deafened");
});

test("a VANISHED holder's lease is taken over, never left as a tombstone", { skip }, async () => {
	// The lease is sized to the hold, so a 30-day `after` writes a 31-day key. If that holder leaves the
	// queue by any route except the clean one -- cancelled, removed, obliterated -- the key would otherwise
	// refuse every later delivery for that target until it expired, and a refused forge delivery is gone.
	const redis = fakeRedis();
	const state = makeWaitState({ redis, now: () => NOW });
	const until = NOW + 3600 * 1000;
	const first = spyJob(forge([{ after: iso(until) }]), { id: "gh-1" });
	const live = new Set(["gh-1"]);
	const { processor, seen } = harness({ redis, waitState: state, deps: { isJobLive: async (id) => live.has(id) } });
	await assert.rejects(() => processor(first.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");

	live.delete("gh-1"); // the holder is gone from the queue, its lease still in redis
	const second = spyJob(forge([{ after: iso(until) }]), { id: "gh-2" });
	live.add("gh-2");
	await assert.rejects(() => processor(second.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(second.moves.length, 1, "the work is not dropped on the floor");
	assert.ok(seen.logs.some((l) => l.e === "wait_lease_taken_over"), "and the takeover is visible");
	assert.equal(await redis.get("wait:key:acme/web#7:deploy#0"), "gh-2", "the lease now names the live holder");
});

test("an unverifiable holder decides NOTHING -- it re-asks rather than admitting or refusing", { skip }, async () => {
	// With no probe wired the holder cannot be checked, and BOTH two-way answers are wrong: admitting puts
	// two jobs on one target and pays for both, refusing drops a delivery no webhook resends. So the gate
	// re-defers and asks again.
	const redis = fakeRedis();
	const state = makeWaitState({ redis, now: () => NOW });
	const until = NOW + 3600 * 1000;
	const first = spyJob(forge([{ after: iso(until) }]), { id: "gh-1" });
	const second = spyJob(forge([{ after: iso(until) }]), { id: "gh-2" });
	const { processor, seen } = harness({ redis, waitState: state }); // no isJobLive
	await assert.rejects(() => processor(first.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	await assert.rejects(() => processor(second.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(second.moves.length, 1);
	assert.equal(second.moves[0].ts, NOW + mod.SUPERSEDE_RECHECK_MS, "a short re-ask, not the hold instant");
	assert.equal(await redis.get(`wait:key:${second.job.deduplicationId}#0`), "gh-1", "and it did NOT take the lease: only one job holds this target");
	assert.ok(seen.logs.some((l) => l.e === "wait_supersede_unverified"), "and never silently");

	// A probe that THROWS is the same as no probe -- it has not told us the holder is alive.
	const third = spyJob(forge([{ after: iso(until) }]), { id: "gh-3" });
	const thrower = harness({ redis, waitState: state, deps: { isJobLive: async () => { throw new Error("redis blip"); } } });
	await assert.rejects(() => thrower.processor(third.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(third.moves.length, 1);
});

test("a condition this worker cannot READ refuses -- the forward half of the version skew", { skip }, async () => {
	// The loader refuses all of these, and the loader is a different process: job.data.waitFor arrives over
	// redis from the receiver, so a newer receiver can enqueue a shape this worker has no branch for.
	for (const bad of [[{ blocked: "x" }], [{ after: "tomorrow" }], [{ after: "2026-09-01T09:00:00" }], [{}], [{ profile: "has space" }], ["jira"], [null]]) {
		const { job, moves } = spyJob(forge(bad));
		const { processor, seen } = harness();
		const result = await processor(job, "tok", new AbortController().signal);
		assert.equal(result.reason, "wait-unreadable", `expected a refusal for ${JSON.stringify(bad)}`);
		assert.equal(seen.containerCalls, 0, "never a paid run that logged wait_cleared without evaluating anything");
		assert.equal(moves.length, 0);
	}
});

test("a profile name that could break a comment or a log line never reaches one", { skip }, async () => {
	// waitLabel's own doc claims nothing attacker-chosen reaches a panel row or a log line. That claim is
	// enforced in wait-for.mjs rather than trusted to the loader one process away.
	const { job } = spyJob(forge([{ profile: "`; rm -rf /`\n@everyone" }]));
	const { processor, seen } = harness();
	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(result.reason, "wait-unreadable", "an undeclarable name is unreadable, not a profile to name back");
	assert.equal(seen.comments.filter((c) => c.includes("@everyone")).length, 0, "and it is not echoed into a public comment");
	assert.equal(seen.logs.filter((l) => JSON.stringify(l.f).includes("@everyone")).length, 0);
});

test("the wait state fails OPEN: a dead redis costs a panel row, never a refusal", { skip }, async () => {
	const dead = { incr: async () => 1, decr: async () => 0, expire: async () => {} };
	for (const op of ["hsetnx", "hset", "hget", "pexpire", "sadd", "srem", "del", "get", "set"]) {
		dead[op] = async () => {
			throw new Error("ECONNREFUSED");
		};
	}
	const state = makeWaitState({ redis: dead, now: () => NOW });
	// A redis fault reached us before any decision was made, so `claim` decides NOTHING: admitting would
	// risk two paid runs for one intent, refusing would risk dropping a delivery no webhook resends.
	assert.deepEqual(await state.claim("gh-1", { dedupId: "x", untilMs: NOW + 1000 }), { retry: true, holder: null });
	assert.equal(await state.heldForMs("gh-1"), null);
	await state.hold("gh-1", { dedupId: "x", untilMs: NOW + 1000 });
	await state.release("gh-1", { dedupId: "x" });

	// The gate turns that into a short re-defer: nothing held, nothing refused, nothing run.
	const { job, moves } = spyJob(forge([{ after: iso(NOW + 3600 * 1000) }]));
	const { processor, seen } = harness({ redis: dead, waitState: state });
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(moves.length, 1);
	assert.equal(moves[0].ts, NOW + mod.SUPERSEDE_RECHECK_MS, "re-asks shortly, rather than holding to the instant on an unverified target");
	assert.ok(seen.logs.some((l) => l.e === "wait_supersede_unverified"));
});

// --- composition with the gates around it -------------------------------------------------------------

test("pause outranks wait: a paused job defers to the window, not to its instant", { skip }, async () => {
	const windowEnd = NOW + 600_000;
	const { job, moves } = spyJob(forge([{ after: iso(NOW + 3 * 3600 * 1000) }]));
	const { processor } = harness();
	const paused = mod.makeProcessor({
		cancelJob: () => {}, stopContainer: () => {}, redis: fakeRedis(),
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		pauseUntil: () => windowEnd, now: () => NOW, recordRun: () => {}, timeoutMs: 100000,
		deps: { mintToken: async () => "tok", isDefaultBranchProtected: async () => true, prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }), runContainer: async () => ({ code: 0, aborted: false }), cleanup: async () => {}, comment: async () => {}, log: () => {} },
	});
	await assert.rejects(() => paused(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(moves[0].ts, windowEnd, "a paused job burns no wait evaluation, exactly as it burns no scope re-check");
	assert.ok(processor);
});

test("a job with no waitFor takes a byte-identical path, and `deps: {}` does not TypeError", { skip }, async () => {
	const { job, moves } = spyJob(forge(undefined));
	const { processor, seen, redis } = harness();
	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(moves.length, 0);
	assert.equal(result.outcome, "completed");
	assert.equal(seen.containerCalls, 1);
	assert.equal(redis.hashes.size, 0, "an unflagged job creates no wait key at all");
	assert.equal(redis.sets.size, 0);

	// The bare wiring: makeProcessor gives `deps` no default and the gate's optional chaining is what keeps
	// a `deps: {}` wiring from throwing on the log and comment seams.
	const bare = mod.makeProcessor({
		cancelJob: () => {}, stopContainer: () => {}, redis: fakeRedis(),
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		recordRun: () => {}, timeoutMs: 100000, now: () => NOW, deps: {},
	});
	const held = spyJob(forge([{ profile: "jira" }]), { id: "gh-bare" });
	const bareResult = await bare(held.job, "tok", new AbortController().signal);
	assert.equal(bareResult.reason, "wait-profile-unknown", "refuses cleanly with no log and no comment seam wired");
});

// --- the skew detector --------------------------------------------------------------------------------

const triggersFile = (entries) => ({ readFileSync: () => JSON.stringify({ triggers: entries }) });

test("the skew detector refuses a job whose AUTHORED trigger declares conditions it arrived without", { skip }, async () => {
	const authored = [{ on: { type: "label", any: ["pi:deploy"] }, run: { kind: "github", flow: "deploy", waitFor: [{ profile: "jira" }, { after: "2026-09-01T09:00:00Z" }] } }];
	const check = makeCheckWaitSkew({ triggersPath: "/triggers.json", fs: triggersFile(authored) });

	const job = { trigger: { matched: { index: 0, type: "label" } }, kind: "github", flow: "deploy" };
	assert.deepEqual(await check(job), { skewed: true, conditions: 2 }, "the file says wait, the job says nothing -- a stale service dropped the field");

	assert.deepEqual(await check({ ...job, waitFor: [{ profile: "jira" }] }), { ok: true }, "the field arrived; whether it is SATISFIED is the gate's business");

	// The identity guard is wider than flow, because a false refusal here is a dropped paid delivery with a
	// message telling the operator to upgrade something that is already current.
	assert.deepEqual(await check({ ...job, kind: "gitlab" }), { ok: true }, "a different forge at this index -- a stray triggers.json at the worker's cwd");
	assert.deepEqual(await check({ ...job, trigger: { matched: { index: 0, type: "comment" } } }), { ok: true }, "a different on-type at this index -- an insertion or a reorder");
});

test("the skew detector fails OPEN on everything it cannot answer", { skip }, async () => {
	const authored = [{ on: { type: "label", any: ["pi:deploy"] }, run: { kind: "github", flow: "deploy", waitFor: [{ profile: "jira" }] } }];
	const job = { trigger: { matched: { index: 0, type: "label" } }, kind: "github", flow: "deploy" };

	const unreadable = makeCheckWaitSkew({ triggersPath: "/t.json", fs: { readFileSync: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); } } });
	assert.deepEqual(await unreadable(job), { ok: true }, "a broken read must never wedge every job");

	const garbage = makeCheckWaitSkew({ triggersPath: "/t.json", fs: { readFileSync: () => "{ not json" } });
	assert.deepEqual(await garbage(job), { ok: true });

	const unset = makeCheckWaitSkew({ triggersPath: "" });
	assert.deepEqual(await unset(job), { ok: true });

	const check = makeCheckWaitSkew({ triggersPath: "/t.json", fs: triggersFile(authored) });
	assert.deepEqual(await check({ trigger: {}, kind: "github", flow: "deploy" }), { ok: true }, "a cron or CLI job carries no matched index");
	assert.deepEqual(await check({ trigger: { matched: { index: 9, type: "label" } }, kind: "github", flow: "deploy" }), { ok: true }, "an index past the end");
	// The identity guard: triggerIndex is a RAW array position, so an edit between enqueue and pickup can
	// put a different trigger here. Unknown must not refuse.
	assert.deepEqual(await check({ trigger: { matched: { index: 0, type: "label" } }, kind: "github", flow: "other" }), { ok: true }, "a different flow at this index");
	assert.deepEqual(await check({ trigger: { matched: { index: 0, type: "label" } }, kind: "github", command: "x" }), { ok: true }, "a command job where a flow was authored");
	const noWait = makeCheckWaitSkew({ triggersPath: "/t.json", fs: triggersFile([{ on: { type: "label" }, run: { kind: "github", flow: "deploy" } }]) });
	assert.deepEqual(await noWait(job), { ok: true }, "the ordinary case: nothing authored, nothing missing");
});

test("the skew detector caches by mtime, and a rewritten file invalidates it", { skip }, async () => {
	// It has to look at EVERY forge job (a skewed job carries nothing to narrow by), so the read is a stat
	// on the steady path rather than a read-and-parse. The cache must not outlive an operator's edit.
	let reads = 0;
	let mtimeMs = 1000;
	let body = JSON.stringify({ triggers: [{ on: { type: "label" }, run: { kind: "github", flow: "deploy", waitFor: [{ profile: "jira" }] } }] });
	const fs = {
		statSync: () => ({ mtimeMs, size: body.length }),
		readFileSync: () => (reads++, body),
	};
	const check = makeCheckWaitSkew({ triggersPath: "/t.json", fs });
	const job = { trigger: { matched: { index: 0, type: "label" } }, kind: "github", flow: "deploy" };

	assert.deepEqual(await check(job), { skewed: true, conditions: 1 });
	assert.deepEqual(await check(job), { skewed: true, conditions: 1 });
	assert.deepEqual(await check(job), { skewed: true, conditions: 1 });
	assert.equal(reads, 1, "three jobs, one parse");

	body = JSON.stringify({ triggers: [{ on: { type: "label" }, run: { kind: "github", flow: "deploy" } }] });
	mtimeMs = 2000; // the operator removed the conditions
	assert.deepEqual(await check(job), { ok: true }, "the edit takes effect");
	assert.equal(reads, 2);

	// An fs with no statSync (every test fake, and any fs that cannot stat) falls back to reading each time
	// rather than caching forever.
	let plainReads = 0;
	const plain = makeCheckWaitSkew({ triggersPath: "/t.json", fs: { readFileSync: () => (plainReads++, JSON.stringify({ triggers: [{ on: { type: "label" }, run: { kind: "github", flow: "deploy", waitFor: [{ profile: "jira" }] } }] })) } });
	await plain(job);
	await plain(job);
	assert.equal(plainReads, 2, "no stat, no cache -- correctness over the optimisation");
});

test("a gate-written record has the same key set as any other terminal record", { skip }, async () => {
	// The gate builds its result literal by hand, above the try, so a future widening of buildRecord would
	// silently give these refusals a different shape from every other one.
	const { buildRecord } = await import("../src/run-history.mjs");
	const { job } = spyJob(forge([{ profile: "jira" }]));
	const { processor, seen } = harness();
	await processor(job, "tok", new AbortController().signal);
	assert.equal(seen.records.length, 1);

	const gateRecord = buildRecord(seen.records[0]);
	const ordinary = buildRecord({ job, result: { outcome: "completed", reason: null, exitCode: 0, turns: 3, tokens: null, budgetReserved: true }, startedAt: "2026-08-30T12:00:00.000Z", endedAt: "2026-08-30T12:00:01.000Z" });
	assert.deepEqual(Object.keys(gateRecord).sort(), Object.keys(ordinary).sort(), "same shape, whichever side of the try wrote it");
	assert.equal(gateRecord.reason, "wait-profile-unknown");
	assert.equal(gateRecord.attempt, 0, "a hold consumes no attempt, so the refusal that ends one records none");
	assert.equal(gateRecord.target, "acme/web#7", "the id-only target, never a title");
});

test("the supersede lease reads the field BullMQ actually sets", { skip }, async () => {
	// The harness's spyJob sets `deduplicationId` itself, so every supersede test above would pass even if
	// bullmq named this field something else and the gate always saw undefined. Pin it against the pin.
	const { readFileSync } = await import("node:fs");
	const { createRequire } = await import("node:module");
	const { dirname, join } = await import("node:path");
	// Resolved rather than path-guessed: bullmq is hoisted to the repo root, so a relative walk from this
	// file is a claim about the install layout instead of about the pinned package.
	const entry = createRequire(import.meta.url).resolve("bullmq");
	const src = readFileSync(join(dirname(entry), "classes", "job.js"), "utf8");
	assert.match(src, /this\.deduplicationId = opts\.deduplication/, "bullmq sets deduplicationId at construction");
	assert.match(src, /job\.deduplicationId = json\.deid/, "and restores it from the persisted hash at pickup");
});
