import assert from "node:assert/strict";
import { test } from "node:test";
import { makeInFlight } from "../src/scoped-limits.mjs";
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
	r.pexpires = [];
	r.pexpire = async (k, ms) => (r.pexpires.push({ key: k, ms }), 1);
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
	r.hincrby = async (k, f, by) => {
		const h = hashes.get(k) ?? new Map();
		hashes.set(k, h);
		const next = (Number(h.get(f)) || 0) + by;
		h.set(f, String(next));
		return next;
	};
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

function harness({ redis = fakeRedis(), deps = {}, afterMaxMs, waitState, checkSlots } = {}) {
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
		...(checkSlots ? { checkSlots } : {}),
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

// --- the check lease is released on EVERY exit ---------------------------------------------------------
//
// The supersede claim sits between the lease acquire and the check loop, and both of its exits leave the
// gate. Until this pair existed, both walked out holding the slot: at the shipped default of one, a single
// `wait-superseded` wedged every wait check on the worker until it restarted, and the symptom was a later
// job recording `wait-expired`/`max-wait-unchecked` -- capacity blamed for a leak.

test("a wait-superseded refusal on the polled path RELEASES the check slot", { skip }, async () => {
	const checkSlots = makeInFlight();
	const state = { ...makeWaitState({ redis: fakeRedis(), now: () => NOW }), claim: async () => ({ heldBy: "gh-other" }) };
	const { job } = spyJob(forge([{ profile: "jira" }]));
	const { processor, seen } = harness({
		waitState: state,
		checkSlots,
		deps: { waitProfileDeclared: () => true, checkWait: async () => ({ verdict: "go" }) },
	});

	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(result.reason, "wait-superseded");
	assert.equal(checkSlots.count("wait-check"), 0, "the slot the gate took before the claim is given back");
	assert.equal(seen.containerCalls, 0);

	// The proof that matters is the NEXT job: with one slot, a leak would throttle it forever.
	const { job: second } = spyJob(forge([{ profile: "jira" }]), { id: "gh-2", deduplicationId: "acme/web#8:deploy" });
	const clean = { ...makeWaitState({ redis: fakeRedis(), now: () => NOW }), claim: async () => ({ ok: true }) };
	const run = harness({ waitState: clean, checkSlots, deps: { waitProfileDeclared: () => true, checkWait: async () => ({ verdict: "go" }) } });
	await run.processor(second, "tok", new AbortController().signal);
	assert.equal(run.seen.containerCalls, 1, "the next job wins the lease and runs, rather than throttling behind a leaked slot");
	assert.ok(!run.seen.logs.some((l) => l.e === "wait_check_throttled"), "and is never throttled at all");
});

test("an unverifiable holder re-defers and RELEASES the check slot", { skip }, async () => {
	const checkSlots = makeInFlight();
	const state = { ...makeWaitState({ redis: fakeRedis(), now: () => NOW }), claim: async () => ({ retry: true, holder: null }) };
	const { job, moves } = spyJob(forge([{ profile: "jira" }]));
	const { processor, seen } = harness({
		waitState: state,
		checkSlots,
		deps: { waitProfileDeclared: () => true, checkWait: async () => ({ verdict: "go" }) },
	});

	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(moves[0].ts, NOW + mod.SUPERSEDE_RECHECK_MS);
	assert.equal(checkSlots.count("wait-check"), 0, "a throw out of the gate releases too -- the finally covers both exits");
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

// --- tier 2: the polled conditions -------------------------------------------------------------------

const GO = { verdict: "go", fault: false };
const NOT_YET = { verdict: "hold", fault: false };
const CANNOT_TELL = { verdict: "hold", fault: true };
const NEVER = { verdict: "refuse", fault: false };

function tier2(overrides = {}) {
	const redis = fakeRedis();
	const state = makeWaitState({ redis, now: () => NOW });
	const seen = { containerCalls: 0, records: [], logs: [], comments: [], asked: [] };
	const processor = mod.makeProcessor({
		cancelJob: () => {}, stopContainer: () => {}, redis,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		now: () => NOW, recordRun: (r) => seen.records.push(r), timeoutMs: 100000,
		waitState: state,
		random: () => 0, // no jitter, so a delay assertion is exact
		concurrencyNow: () => 3,
		checkSlotCount: () => 1,
		intervalMs: () => 60_000,
		maxWaitMs: () => 24 * 3600 * 1000,
		maxChecks: () => 96,
		maxFaults: () => 5,
		...overrides,
		deps: {
			mintToken: async () => "tok", isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => (seen.containerCalls++, { code: 0, aborted: false, turns: 3 }),
			cleanup: async () => {}, comment: async (_j, t) => seen.comments.push(t), log: (e, f) => seen.logs.push({ e, f }),
			isJobLive: async () => true,
			checkWait: async (profile, target, ctx) => (seen.asked.push({ profile, target, hasSignal: Boolean(ctx?.signal) }), GO),
			...(overrides.deps ?? {}),
		},
	});
	return { processor, seen, redis, state };
}

test("every profile answering go runs the job, asked in the operator's order with an id-only target", { skip }, async () => {
	const { processor, seen } = tier2();
	const { job } = spyJob(forge([{ profile: "jira" }, { profile: "deploy" }]));
	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(result.outcome, "completed");
	assert.equal(seen.containerCalls, 1);
	assert.deepEqual(seen.asked.map((a) => a.profile), ["jira", "deploy"], "sequential, in writing order");
	assert.equal(seen.asked[0].target, "acme/web#7", "an id-only target, never a title or a body");
	assert.equal(seen.asked[0].hasSignal, true, "and abortable, so a shutdown does not strand a check");
});

test("exit 3 holds on the backoff and stops asking at the first condition that did not clear", { skip }, async () => {
	const seen0 = [];
	const { processor, seen } = tier2({ deps: { checkWait: async (profile) => (seen0.push(profile), profile === "jira" ? NOT_YET : GO) } });
	const { job, moves } = spyJob(forge([{ profile: "jira" }, { profile: "deploy" }]));
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(seen0, ["jira"], "the second is never asked -- a conjunction is decided by the first no");
	assert.equal(moves[0].ts, NOW + 60_000, "the base cadence on a fresh hold");
	assert.equal(seen.records.length, 0, "a hold is not a run");
	assert.equal(seen.containerCalls, 0);
});

test("exit 2 is terminal -- `wait-refused`, never asked again", { skip }, async () => {
	const { processor, seen, redis } = tier2({ deps: { checkWait: async () => NEVER } });
	const { job, moves } = spyJob(forge([{ profile: "jira" }]));
	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(result.reason, "wait-refused");
	assert.equal(result.budgetReserved, false);
	assert.equal(redis.incrCalls, 0);
	assert.equal(moves.length, 0, "terminal means terminal: not held, not retried");
	assert.ok(seen.comments[0].includes("jira"));
	assert.ok(seen.comments[0].includes("never clear"));
});

test("consecutive cannot-tell answers terminate as `wait-unanswerable`, naming the CHECK", { skip }, async () => {
	// OQ-030: most CLIs exit 1 for everything, so without this bound a typo'd check holds for the whole
	// maximum wait and then blames the condition rather than the script.
	const { processor, seen, state } = tier2({ maxFaults: () => 3, deps: { checkWait: async () => CANNOT_TELL } });
	const { job } = spyJob(forge([{ profile: "jira" }]));
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(await state.counters(job.id), { checks: 2, faults: 2, throttles: 0 }, "and no lease denials: the checks ran");

	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(result.reason, "wait-unanswerable");
	assert.ok(seen.comments.at(-1).includes("jira"), "the message names the check, not the condition");
	assert.ok(seen.comments.at(-1).includes("could not answer"));
});

test("an answered check RESETS the fault count -- a script that recovers carries no debt", { skip }, async () => {
	let answer = CANNOT_TELL;
	const { processor, state } = tier2({ maxFaults: () => 3, deps: { checkWait: async () => answer } });
	const { job } = spyJob(forge([{ profile: "jira" }]));
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal((await state.counters(job.id)).faults, 2);

	answer = NOT_YET; // the outage ends; the check answers "not yet" properly
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal((await state.counters(job.id)).faults, 0, "consecutive, not cumulative");
	assert.equal((await state.counters(job.id)).checks, 3, "while the check count only ever grows");
});

test("the per-job check count is a bound nothing else provides, and the LAST check still decides", { skip }, async () => {
	// CONST-BUDGET-BEFORE-TOKENS counts container starts, so a check is invisible to every spend ceiling.
	const { processor, seen, redis } = tier2({ maxChecks: () => 2, deps: { checkWait: async () => NOT_YET } });
	const { job } = spyJob(forge([{ profile: "jira" }]));
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(result.reason, "wait-expired", "exactly maxChecks checks ran, and the last one was still asked");
	assert.equal(redis.incrCalls, 0);
	assert.ok(seen.comments.at(-1).includes("2 checks"));
	assert.ok(seen.comments.at(-1).includes("jira"), "and it names the check it gave up on");
});

test("a condition that clears on the DECIDING wake runs, under either terminal bound", { skip }, async () => {
	// This is the guarantee the whole after-the-check ordering exists for, and it was untrue at every
	// shipped default while the count bound was tested first: `PI_WAIT_MAX_CHECKS` fires around 19.9h at
	// the default cadence, well before `PI_WAIT_MAX_MS` at 24h, so the bound that actually terminated a
	// job was the one that refused WITHOUT asking.
	let answer = NOT_YET;
	const byCount = tier2({ maxChecks: () => 2, deps: { checkWait: async () => answer } });
	const a = spyJob(forge([{ profile: "jira" }]), { id: "gh-count" });
	await assert.rejects(() => byCount.processor(a.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	answer = GO; // it clears exactly on the wake that would have exhausted the count
	const ranA = await byCount.processor(a.job, "tok", new AbortController().signal);
	assert.equal(ranA.outcome, "completed", "the count bound asked before it gave up");

	// And the same for the maximum hold.
	const redis = fakeRedis();
	const aged = makeWaitState({ redis, now: () => NOW - 25 * 3600 * 1000 });
	await aged.hold("gh-age", { dedupId: "acme/web#7:deploy#0", untilMs: NOW });
	const byAge = tier2({ maxWaitMs: () => 24 * 3600 * 1000, waitState: makeWaitState({ redis, now: () => NOW }), deps: { checkWait: async () => GO } });
	const b = spyJob(forge([{ profile: "jira" }]), { id: "gh-age" });
	const ranB = await byAge.processor(b.job, "tok", new AbortController().signal);
	assert.equal(ranB.outcome, "completed", "the hold bound asked too");
});

test("a job that can never win the lease still has a clock and a ceiling", { skip }, async () => {
	// The lease bounds how much a worker spends checking. Without a clock on the starved path it turns into
	// the starvation it exists to prevent: no `since`, so no elapsed, so the maximum hold is unreachable and
	// the job re-wakes forever with no record and no bound.
	const busy = (await import("../src/scoped-limits.mjs")).makeInFlight();
	busy.tryAcquire("wait-check", 1);
	const redis = fakeRedis();
	const old = makeWaitState({ redis, now: () => NOW - 25 * 3600 * 1000 });
	await old.hold("gh-starved", { dedupId: "acme/web#7:deploy#0", untilMs: NOW });
	const { processor, seen } = tier2({ checkSlots: busy, maxWaitMs: () => 24 * 3600 * 1000, waitState: makeWaitState({ redis, now: () => NOW }), deps: { checkWait: async () => GO } });
	const { job } = spyJob(forge([{ profile: "jira" }]), { id: "gh-starved" });

	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(result.reason, "wait-expired");
	assert.ok(seen.comments.at(-1).includes("could not run the check often enough"), "and it blames the deployment's capacity, not the condition");

	// A fresh starved job stamps its clock on the first denial, so the ceiling is reachable at all.
	const fresh = fakeRedis();
	const freshState = makeWaitState({ fresh, redis: fresh, now: () => NOW });
	const f = tier2({ checkSlots: busy, waitState: freshState, deps: { checkWait: async () => GO } });
	const fj = spyJob(forge([{ profile: "jira" }]), { id: "gh-fresh" });
	await assert.rejects(() => f.processor(fj.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(await freshState.heldForMs("gh-fresh"), 0, "stamped, so elapsed can grow from here");
});

test("the maximum hold is tested AFTER the check, so a condition that clears on the deciding wake RUNS", { skip }, async () => {
	// Without this ordering the backoff's quantisation makes "cleared at t+1s, declared never-cleared at
	// t+900s" structural -- a lie in the durable record and in a public forge comment.
	const redis = fakeRedis();
	const state = makeWaitState({ redis, now: () => NOW - 25 * 3600 * 1000 });
	await state.hold("gh-1", { dedupId: "acme/web#7:deploy#0", untilMs: NOW });
	// The processor is built against the aged state directly.
	const aged = mod.makeProcessor({
		cancelJob: () => {}, stopContainer: () => {}, redis,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		now: () => NOW, recordRun: () => {}, timeoutMs: 100000,
		waitState: makeWaitState({ redis, now: () => NOW }), random: () => 0,
		maxWaitMs: () => 24 * 3600 * 1000, maxChecks: () => 96, maxFaults: () => 5, intervalMs: () => 60_000,
		concurrencyNow: () => 3, checkSlotCount: () => 1,
		deps: {
			mintToken: async () => "tok", isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => ({ code: 0, aborted: false, turns: 3 }),
			cleanup: async () => {}, comment: async () => {}, log: () => {}, isJobLive: async () => true,
			checkWait: async () => GO,
		},
	});
	const { job } = spyJob(forge([{ profile: "jira" }]));
	const result = await aged(job, "tok", new AbortController().signal);
	assert.equal(result.outcome, "completed", "it cleared on the final check, so it ran");
});

test("a job past the maximum hold whose check still says not-yet expires, naming the check", { skip }, async () => {
	const redis = fakeRedis();
	const past = makeWaitState({ redis, now: () => NOW - 25 * 3600 * 1000 });
	await past.hold("gh-1", { dedupId: "acme/web#7:deploy#0", untilMs: NOW });
	const seen = { comments: [] };
	const aged = mod.makeProcessor({
		cancelJob: () => {}, stopContainer: () => {}, redis,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		now: () => NOW, recordRun: () => {}, timeoutMs: 100000,
		waitState: makeWaitState({ redis, now: () => NOW }), random: () => 0,
		maxWaitMs: () => 24 * 3600 * 1000, maxChecks: () => 96, maxFaults: () => 5, intervalMs: () => 60_000,
		concurrencyNow: () => 3, checkSlotCount: () => 1,
		deps: {
			mintToken: async () => "tok", isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => ({ code: 0, aborted: false }),
			cleanup: async () => {}, comment: async (_j, t) => seen.comments.push(t), log: () => {}, isJobLive: async () => true,
			checkWait: async () => NOT_YET,
		},
	});
	const { job } = spyJob(forge([{ profile: "jira" }]));
	const result = await aged(job, "tok", new AbortController().signal);
	assert.equal(result.reason, "wait-expired");
	assert.ok(seen.comments.at(-1).includes("jira"));
});

test("the check lease bounds duty cycle, and never takes the worker's last free slot", { skip }, async () => {
	// slots x timeout is the most wall-clock a worker can spend answering questions instead of running
	// jobs, and it is the bound the issue's own economics table demands.
	let spawns = 0;
	const slots = (await import("../src/scoped-limits.mjs")).makeInFlight();
	slots.tryAcquire("wait-check", 1); // someone else is mid-check
	const { processor, seen } = tier2({ checkSlots: slots, deps: { checkWait: async () => (spawns++, GO) } });
	const { job, moves } = spyJob(forge([{ profile: "jira" }]));

	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(spawns, 0, "denied the lease, so it spawned NOTHING -- the whole point of the bound");
	assert.ok(seen.logs.some((l) => l.e === "wait_check_throttled"), "and the overflow is logged, never absorbed");
	assert.equal(moves[0].ts, NOW + 15_000, "re-asks at a quarter of the cadence, not the full backoff");

	// And the clamp is driven, not asserted as arithmetic: with PI_CONCURRENCY at 2 the effective ceiling is
	// 1 however large the configured slot count is, so a check can never take the worker's last free slot.
	const soloSlots = (await import("../src/scoped-limits.mjs")).makeInFlight();
	soloSlots.tryAcquire("wait-check", 1); // one check already running
	let soloSpawns = 0;
	const solo = tier2({ concurrencyNow: () => 2, checkSlotCount: () => 9999, checkSlots: soloSlots, deps: { checkWait: async () => (soloSpawns++, GO) } });
	const soloJob = spyJob(forge([{ profile: "jira" }]), { id: "gh-solo" });
	await assert.rejects(() => solo.processor(soloJob.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(soloSpawns, 0, "a configured 9999 is still clamped to concurrency - 1");

	// At concurrency 1 the clamp floors at 1 rather than 0, or nothing could ever check at all.
	const oneSlots = (await import("../src/scoped-limits.mjs")).makeInFlight();
	let oneSpawns = 0;
	const one = tier2({ concurrencyNow: () => 1, checkSlotCount: () => 9999, checkSlots: oneSlots, deps: { checkWait: async () => (oneSpawns++, GO) } });
	const oneJob = spyJob(forge([{ profile: "jira" }]), { id: "gh-one" });
	await one.processor(oneJob.job, "tok", new AbortController().signal);
	assert.equal(oneSpawns, 1, "floored at one: max(1, concurrency - 1) never reaches zero");
});

test("`wait_cleared` fires only for a job that actually held", { skip }, async () => {
	// Without the guard it fires on the first pickup of a job whose instant had already passed, and again
	// on every scope-busy re-check after that -- asserting a wait ended that never began.
	const { processor, seen } = tier2({ deps: { checkWait: async () => GO } });
	const { job } = spyJob(forge([{ after: iso(NOW - 1000) }]));
	await processor(job, "tok", new AbortController().signal);
	assert.equal(seen.logs.filter((l) => l.e === "wait_cleared").length, 0, "it never waited, so nothing cleared");

	// A job that DID hold logs it once, with how long it waited.
	const redis = fakeRedis();
	const earlier = makeWaitState({ redis, now: () => NOW - 120_000 });
	await earlier.hold("gh-held", { dedupId: "acme/web#7:deploy#0", untilMs: NOW });
	const ran = tier2({ deps: { checkWait: async () => GO } });
	const held = spyJob(forge([{ after: iso(NOW - 1000) }]), { id: "gh-held" });
	const withState = mod.makeProcessor({
		cancelJob: () => {}, stopContainer: () => {}, redis,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		now: () => NOW, recordRun: () => {}, timeoutMs: 100000, waitState: makeWaitState({ redis, now: () => NOW }),
		deps: { mintToken: async () => "t", isDefaultBranchProtected: async () => true, prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }), runContainer: async () => ({ code: 0, aborted: false }), cleanup: async () => {}, comment: async () => {}, log: (e, f) => ran.seen.logs.push({ e, f }), isJobLive: async () => true },
	});
	await withState(held.job, "tok", new AbortController().signal);
	const cleared = ran.seen.logs.filter((l) => l.e === "wait_cleared");
	assert.equal(cleared.length, 1);
	assert.equal(cleared[0].f.heldForMs, 120_000, "and says how long, from the hold clock rather than the enqueue one");
});

test("a job that LOST the lease never extends the winner's hold", { skip }, async () => {
	// `hold` re-reads before extending. Without that, the loser's own hold would push out the winner's
	// lease, handing it a longer deafening window than its own hold ever asked for.
	const redis = fakeRedis();
	const state = makeWaitState({ redis, now: () => NOW });
	const key = "wait:key:acme/web#7:deploy#0";
	await redis.set(key, "gh-winner");
	const before = redis.ttls?.get?.(key);
	await state.hold("gh-loser", { dedupId: "acme/web#7:deploy#0", untilMs: NOW + 3600 * 1000 });
	assert.equal(await redis.get(key), "gh-winner", "the loser did not take the lease");
	assert.equal(redis.pexpires.filter((p) => p.key === key).length, 0, "and did not extend it either");
});

test("an undeclared profile refuses per delivery, naming the profile and never a path", { skip }, async () => {
	const { processor, seen } = tier2({ deps: { checkWait: async (p) => ({ profileUnknown: p }) } });
	const { job } = spyJob(forge([{ profile: "jira" }]));
	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(result.reason, "wait-profile-unknown");
	assert.ok(seen.comments[0].includes("jira"));
	assert.equal(seen.comments[0].includes("/"), false, "a declared resolver's location is vault topology");
});

test("an unrecorded hold reads as ABSENT, never as held since the epoch", { skip }, async () => {
	// `Number(null)` is 0, so the obvious spelling makes a job with no `since` read as held for 56 years,
	// and every bound measured from it -- the maximum hold above all -- fires on the first check. This is
	// the pin for that, because the polled tier's own tests all write a hold before they read one.
	const redis = fakeRedis();
	const state = makeWaitState({ redis, now: () => NOW });
	assert.equal(await state.heldForMs("never-held"), null);
	await redis.hset("wait:job:blank", "since", "");
	assert.equal(await state.heldForMs("blank"), null);
	await redis.hset("wait:job:junk", "since", "not-a-number");
	assert.equal(await state.heldForMs("junk"), null);
	await redis.hset("wait:job:zero", "since", "0");
	assert.equal(await state.heldForMs("zero"), null, "epoch zero is the same absence wearing a number");

	// And a real hold still measures.
	const earlier = makeWaitState({ redis, now: () => NOW - 90_000 });
	await earlier.hold("gh-1", { dedupId: "d", untilMs: NOW });
	assert.equal(await state.heldForMs("gh-1"), 90_000);
});

test("a run of lease denials raises `wait_capacity_exceeded` ONCE, and a granted lease ends the run", { skip }, async () => {
	// The lease caps how much wall-clock this worker spends checking, which is what it is for. Being AT
	// that cap constantly is the failure the issue's economics describe -- paid jobs starving behind checks
	// that spend nothing -- and it arrives silently unless something says so.
	const busy = (await import("../src/scoped-limits.mjs")).makeInFlight();
	busy.tryAcquire("wait-check", 1);
	const { processor, seen, state } = tier2({ checkSlots: busy, deps: { checkWait: async () => GO } });
	const { job } = spyJob(forge([{ profile: "jira" }]));

	for (let i = 0; i < 7; i += 1) {
		await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	}
	const alarms = seen.logs.filter((l) => l.e === "wait_capacity_exceeded");
	assert.equal(alarms.length, 1, "once per episode -- an alarm that repeats every re-check is the always-on amber this project rejects");
	assert.equal(alarms[0].f.denials, 5);
	assert.ok(alarms[0].f.hint.includes("PI_WAIT_CHECK_SLOTS"), "and it names what to turn");
	assert.equal((await state.counters(job.id)).throttles, 7);

	// The lease frees and the next wake checks. The check must answer NOT YET here, not go: a `go` clears
	// the whole hold hash on its way out, which would make the counter read zero whether or not the grant
	// path clears it -- and the path that matters is the one where the job keeps waiting.
	busy.release("wait-check");
	const holding = tier2({ checkSlots: busy, waitState: state, deps: { checkWait: async () => NOT_YET } });
	await assert.rejects(() => holding.processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal((await state.counters(job.id)).throttles, 0, "the run of denials ends on a granted lease, so a later episode alarms again");
	assert.equal((await state.counters(job.id)).checks, 1, "and the check it was granted actually ran");
});

test("the REAL checker composed with the REAL gate: every exit code reaches its decision", { skip }, async () => {
	// Every other test on either side of this seam hand-writes the other side's shape -- the gate tests use
	// verdict literals, the checker tests use a fake spawn. So the one thing neither covers is the contract
	// BETWEEN them: that `decideWait`'s output, wrapped by `makeWaitChecker`, is what the gate branches on.
	// Renaming a field on either side would leave both suites green.
	const { makeWaitChecker } = await import("../src/wait-check.mjs");

	const run = async (exitCode) => {
		const redis = fakeRedis();
		const seen = { containerCalls: 0, comments: [], logs: [] };
		const spawnFn = () => {
			const handlers = new Map();
			const child = { stdout: { on: (e, f) => handlers.set(`o:${e}`, f) }, stderr: { on: (e, f) => handlers.set(`e:${e}`, f) }, on: (e, f) => handlers.set(e, f), kill: () => {} };
			queueMicrotask(() => handlers.get("exit")?.(exitCode, null));
			return child;
		};
		const checkWait = makeWaitChecker({ profiles: { jira: "/opt/pi/wait.sh" }, spawnFn, realExecutablePath: (p) => p, log: () => {} });
		const processor = mod.makeProcessor({
			cancelJob: () => {}, stopContainer: () => {}, redis,
			getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
			now: () => NOW, recordRun: () => {}, timeoutMs: 100000, random: () => 0,
			waitState: makeWaitState({ redis, now: () => NOW }),
			maxFaults: () => 5, maxChecks: () => 96, maxWaitMs: () => 24 * 3600 * 1000, intervalMs: () => 60_000,
			concurrencyNow: () => 3, checkSlotCount: () => 1,
			deps: {
				mintToken: async () => "t", isDefaultBranchProtected: async () => true,
				prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
				runContainer: async () => (seen.containerCalls++, { code: 0, aborted: false, turns: 1 }),
				cleanup: async () => {}, comment: async (_j, t) => seen.comments.push(t), log: (e, f) => seen.logs.push({ e, f }),
				isJobLive: async () => true, waitProfileDeclared: (n) => n === "jira", checkWait,
			},
		});
		const { job, moves } = spyJob(forge([{ profile: "jira" }]), { id: `gh-${exitCode}` });
		try {
			return { result: await processor(job, "tok", new AbortController().signal), moves, seen };
		} catch (e) {
			return { deferred: e.name === "DelayedError", moves, seen };
		}
	};

	const go = await run(0);
	assert.equal(go.result.outcome, "completed", "exit 0 reaches the container");
	assert.equal(go.seen.containerCalls, 1);

	const notYet = await run(3);
	assert.equal(notYet.deferred, true, "exit 3 reaches a deferral");
	assert.equal(notYet.seen.containerCalls, 0);

	const never = await run(2);
	assert.equal(never.result.reason, "wait-refused", "exit 2 reaches the terminal refusal");

	const cannotTell = await run(1);
	assert.equal(cannotTell.deferred, true, "exit 1 holds");

	const weird = await run(6);
	assert.equal(weird.deferred, true, "and an unrecognised code holds too, per the protocol's own rule");
});

test("an undeclared profile is refused BEFORE any hold, not after a day of waiting", { skip }, async () => {
	// The ordering rule this gate states is determinate-refusals-then-holds. Declared-ness is a table
	// lookup, so leaving it inside the check made `[{after: tomorrow}, {profile: "typo"}]` wait a full day
	// and THEN refuse -- the exact sentence the rule promises will not happen.
	const { processor, seen } = tier2({ deps: { waitProfileDeclared: (n) => n === "jira", checkWait: async () => GO } });
	const { job, moves } = spyJob(forge([{ after: iso(NOW + 24 * 3600 * 1000) }, { profile: "typo" }]));
	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(result.reason, "wait-profile-unknown");
	assert.equal(moves.length, 0, "refused now, not held to the instant first");
	assert.ok(seen.comments[0].includes("typo"));
});

test("an abort is not the script faulting, and costs the job neither a check nor a fault", { skip }, async () => {
	const { processor, seen, state } = tier2({ deps: { checkWait: async () => ({ verdict: "hold", fault: false, aborted: true }) } });
	const { job, moves } = spyJob(forge([{ profile: "jira" }]));
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(await state.counters(job.id), { checks: 0, faults: 0, throttles: 0 }, "a rolling deploy must not spend a job's budget on its own restarts");
	assert.equal(moves[0].ts, NOW + 11_000, "and re-asks promptly rather than at the full backoff -- nothing was learned");
	assert.ok(seen.logs.some((l) => l.e === "wait_check_aborted"));
});

test("a counter always carries a TTL, even when it CREATES the hold hash", { skip }, async () => {
	// A job's first polled wake has held nothing yet, so `noteCheck`/`noteThrottle` create the hash. A path
	// that then exits before `hold` would leave a key with no expiry -- breaking the invariant that there is
	// no index set to leak because "every hash carries a TTL", and giving the panel a row nothing can remove.
	const redis = fakeRedis();
	const state = makeWaitState({ redis, now: () => NOW });
	await state.noteCheck("gh-fresh", { fault: false });
	assert.ok(redis.pexpires.some((p) => p.key === "wait:job:gh-fresh"), "noteCheck expires the hash it created");
	await state.noteThrottle("gh-fresh2", { denied: true });
	assert.ok(redis.pexpires.some((p) => p.key === "wait:job:gh-fresh2"), "and so does noteThrottle");
});

test("a sibling held through an outage does not run a second time on the same intent", { skip }, async () => {
	// The lease alone cannot close this: both jobs are delayed and Redis-persisted, while the lease is not,
	// so an outage longer than the lease TTL leaves two holders each finding no holder and each running.
	const redis = fakeRedis();
	const state = makeWaitState({ redis, now: () => NOW });
	const a = spyJob(forge([{ profile: "jira" }]), { id: "gh-a" });
	const b = spyJob(forge([{ profile: "jira" }]), { id: "gh-b" }); // same target, same trigger index

	// Both were held before the outage; both hold clocks exist, neither lease survives.
	const before = makeWaitState({ redis, now: () => NOW - 600_000 });
	await before.hold("gh-a", { dedupId: "acme/web#7:deploy#0", untilMs: NOW });
	await before.hold("gh-b", { dedupId: "acme/web#7:deploy#0", untilMs: NOW });
	await redis.del("wait:key:acme/web#7:deploy#0");

	const { processor, seen } = tier2({ waitState: state, deps: { checkWait: async () => GO } });
	const first = await processor(a.job, "tok", new AbortController().signal);
	assert.equal(first.outcome, "completed", "the first one clears and runs");
	assert.equal(seen.containerCalls, 1);

	const second = await processor(b.job, "tok", new AbortController().signal);
	assert.equal(second.reason, "wait-superseded", "and the second finds the answer rather than repeating the work");
	assert.equal(seen.containerCalls, 1, "one intent, one paid run");
	assert.ok(seen.comments.at(-1).includes("already finished waiting"));
});

test("the throttle floor stays distinguishable from the scope re-check by wake instant", { skip }, async () => {
	// Nothing records WHY a job sits in the delayed set, so the instants are the only evidence there is --
	// which is the second load-bearing job INT-WAIT-PROFILES-CONTRACT gives the interval floor. A throttle or
	// abort re-ask landing on exactly SCOPE_BUSY_RECHECK_MS would make the two indistinguishable.
	assert.notEqual(mod.SCOPE_BUSY_RECHECK_MS, 11_000);
	const { processor } = tier2({ deps: { checkWait: async () => ({ verdict: "hold", fault: false, aborted: true }) } });
	const { job, moves } = spyJob(forge([{ profile: "jira" }]));
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.notEqual(moves[0].ts - NOW, mod.SCOPE_BUSY_RECHECK_MS);
});

test("the maximum hold is never overshot by a cadence longer than what is left of it", { skip }, async () => {
	// The bound is tested when a wake arrives and the cadence decides when that is, so without a clamp an
	// hourly interval under a fifteen-minute maximum holds for the full hour: 400% of the configured bound.
	const { processor } = tier2({ intervalMs: () => 3600_000, maxWaitMs: () => 900_000, deps: { checkWait: async () => NOT_YET } });
	const { job, moves } = spyJob(forge([{ profile: "jira" }]));
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.ok(moves[0].ts - NOW <= 900_000, `deferred ${moves[0].ts - NOW}ms, past the 900000ms budget`);
});

test("a verdict this gate does not understand HOLDS -- the default branch is never `run`", { skip }, async () => {
	// Everything above tests for a specific shape, and "otherwise" at this gate means starting a paid
	// container. The checker is a DI seam, so its guarantees are this caller's to enforce.
	for (const bad of [undefined, null, {}, { verdict: "GO" }, "hold", { verdict: "go " }, 0]) {
		const { processor, seen } = tier2({ deps: { checkWait: async () => bad } });
		const { job } = spyJob(forge([{ profile: "jira" }]), { id: `gh-${JSON.stringify(bad)}` });
		await assert.rejects(() => processor(job, "tok", new AbortController().signal), (e) => e.name === "DelayedError", `verdict ${JSON.stringify(bad)} must not run the job`);
		assert.equal(seen.containerCalls, 0);
		assert.ok(seen.logs.some((l) => l.e === "wait_check_unintelligible"));
	}
});

test("an unusable target REFUSES rather than burning the fault budget", { skip }, async () => {
	// The old shape held and counted, so five wakes later the job died `wait-unanswerable` blaming the
	// operator's check for a value it was never handed -- which is what the guard's own comment calls wrong.
	const { processor, seen } = tier2({ deps: { checkWait: async () => ({ verdict: "hold", fault: true, unusableTarget: true }) } });
	const { job, moves } = spyJob(forge([{ profile: "jira" }]));
	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(result.reason, "wait-unreadable");
	assert.equal(moves.length, 0, "determinate, so refused now rather than after five holds");
	assert.ok(seen.comments[0].includes("cannot be handed"));
});

test("two `after` conditions are unreadable, not silently resolved to one of them", { skip }, async () => {
	// The loader refuses a second `after`, so a job carrying one arrived from something newer or something
	// wrong -- and `afterMs` would otherwise answer with whichever parses first and run immediately.
	const { processor, seen } = tier2({ deps: { checkWait: async () => GO } });
	const { job, moves } = spyJob(forge([{ after: iso(NOW - 1000) }, { after: iso(NOW + 3600_000) }]));
	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(result.reason, "wait-unreadable");
	assert.equal(seen.containerCalls, 0, "never the earlier instant silently winning");
	assert.equal(moves.length, 0);
});
