import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecord } from "../src/run-history.mjs";
import { NETNS_KEEPER_AFTER_PROXY_GRACE_MS, NETNS_KEEPER_MIN_AGE_MS, NETNS_KEEPER_YOUNG_HOLD_MAX_MS, NETNS_KEEPER_YOUNG_MARGIN_MS, judgeNetnsKeeper, netnsKeeperCrashLoopSentence, netnsKeeperLoopAgainSentence, netnsKeeperYoungWaitMs } from "../src/netns-keeper.mjs";
import { NETNS_KEEPER_CRASH_LOOP, NETNS_KEEPER_NOT_HOLDING } from "../src/processor.mjs";
import { sandboxKeeperCheck } from "../src/sandbox.mjs";

// Issue #476: a keeper that is merely young is not a keeper that does not hold. When the podman stack starts together,
// the worker read the keeper under a second after it started (measured 0.5 to 0.8 s on 4.9.3) and the 3 s age rule
// failed it: a boot warning with a wrong remedy, and a queued job's lost attempt. A young keeper whose only fault is its
// age is now waited out (boot, sandbox opener) or held for (a job, without an attempt), and a crash loop, which is young
// at every start, is named within a bound. index.mjs imports bullmq, so its tests skip below the node floor and
// hard-fail in CI, as podman-restart-hold.test.mjs does.
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`netns-keeper-young tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

const NOW = Date.UTC(2026, 8, 29, 12, 0);
const RUNNING = "running|bridge|pi-dispatch-netns-keeper,";
const read = (started, state = RUNNING) => ({ code: 0, stdout: `${state}|${started}\n` });

test("the judge marks a keeper young only when its age is its whole fault, with the wait it needs (#476)", () => {
	// The measured joint start: keeper 0.6 s old, the proxy 7 ms before it.
	const joint = judgeNetnsKeeper(read(NOW - 600), { now: NOW, proxyStartedMs: NOW - 607 });
	assert.equal(joint.holds, false, "still not held: doctor keeps its judgement");
	assert.match(joint.problem, /has been running for only 0\.6 s/);
	assert.deepEqual(joint.young, { startedMs: NOW - 600, ageMs: 600, waitMs: NETNS_KEEPER_MIN_AGE_MS - 600 + NETNS_KEEPER_YOUNG_MARGIN_MS });
	assert.equal(joint.young.waitMs, 3_400);
	// With no proxy start read, age is still the whole fault.
	assert.equal(judgeNetnsKeeper(read(NOW - 100), { now: NOW }).young?.waitMs, 3_900);
	// Old enough: holds, and no `young`.
	const old = judgeNetnsKeeper(read(NOW - NETNS_KEEPER_MIN_AGE_MS), { now: NOW, proxyStartedMs: NOW - NETNS_KEEPER_MIN_AGE_MS });
	assert.deepEqual([old.holds, old.young], [true, undefined]);
	// Young AND started out of order against the proxy: waiting cannot make its start earlier, so no `young`.
	const late = judgeNetnsKeeper(read(NOW - 500), { now: NOW, proxyStartedMs: NOW - 500 - NETNS_KEEPER_AFTER_PROXY_GRACE_MS - 1 });
	assert.deepEqual([late.holds, late.young], [false, undefined]);
	assert.match(late.problem, /has been running for only 0\.5 s/, "its words stay what they were");
	// Exactly at the grace is a joint start: young.
	assert.ok(judgeNetnsKeeper(read(NOW - 500), { now: NOW, proxyStartedMs: NOW - 500 - NETNS_KEEPER_AFTER_PROXY_GRACE_MS }).young);
	// Absent, stopped, off its bridge, on the wrong network, or with an unread start: never young.
	for (const [label, r] of [
		["absent", { code: 125, stdout: "" }],
		["exited", read(NOW - 100, "exited|bridge|pi-dispatch-netns-keeper,")],
		["none", read(NOW - 100, "running|none|none,")],
		["other network", read(NOW - 100, "running|bridge|podman,")],
		["unread start", { code: 0, stdout: `${RUNNING}|\n` }],
	]) {
		const j = judgeNetnsKeeper(r, { now: NOW, proxyStartedMs: NOW - 100 });
		assert.deepEqual([j.holds, j.young], [false, undefined], label);
	}
	// Without a clock (`up`, the detach gate) nothing is about age.
	assert.equal(judgeNetnsKeeper(read(NOW - 100)).young, undefined);
});

test("the young wait is bounded: never less than the margin, never more than the minimum age plus it (#476)", () => {
	assert.deepEqual([NETNS_KEEPER_MIN_AGE_MS, NETNS_KEEPER_YOUNG_MARGIN_MS, NETNS_KEEPER_YOUNG_HOLD_MAX_MS], [3_000, 1_000, 30_000]);
	assert.equal(netnsKeeperYoungWaitMs(0), 4_000);
	assert.equal(netnsKeeperYoungWaitMs(2_999), 1_001);
	assert.equal(netnsKeeperYoungWaitMs(3_500), 1_000);
	assert.equal(netnsKeeperYoungWaitMs(-5_000), 4_000, "a start read in the future waits the whole age, not more");
	assert.equal(netnsKeeperYoungWaitMs(Number.NaN), 4_000);
});

test("the crash-loop sentence names the loop, both starts, and where to look (#476)", () => {
	const said = netnsKeeperCrashLoopSentence({ was: NOW, now: NOW + 3_500, heldMs: 3_400, remedy: "start it as the worker's account: X" });
	assert.match(said, /^the rootless network keeper pi-dispatch-netns-keeper keeps restarting \(a crash loop\): a job waited for the one started at 2026-09-29T12:00:00\.000Z to have run 3 s, and started again at 2026-09-29T12:00:03\.500Z, /);
	assert.match(said, /so this job is retried rather than started\. To fix it, find why it exits \(journalctl --user -u pi-dispatch-netns-keeper\.service -n 50\), then start it as the worker's account: X$/);
	assert.match(netnsKeeperCrashLoopSentence({ was: NOW, heldMs: 3_400, problem: "is not under this account's Podman" }), /and 3\.4 s later it is not under this account's Podman, /);
	assert.match(netnsKeeperCrashLoopSentence({ was: NOW, now: NOW, heldMs: 30_000 }), /and 30 s later it still read as younger than 3 s, /);
});

// The processor's hold, over an injected egress preflight.
function spyJob(data) {
	const moves = [];
	const updates = [];
	const job = {
		id: "local-keeper",
		attemptsMade: 0,
		name: "local",
		data,
		moveToDelayed: async (ts, tok) => moves.push({ ts, tok }),
		updateData: async (d) => {
			updates.push(d);
			job.data = d;
		},
	};
	return { job, moves, updates };
}

const SENTENCE = "the rootless network keeper pi-dispatch-netns-keeper has been running for only 0.6 s, ... so this job is retried rather than started. To fix it, start it as the worker's account: X";
const young = (startedMs, at = NOW) => ({ unavailable: "pi-dispatch-egress-proxy", keeper: SENTENCE, remedy: "start it as the worker's account: X", problem: "has been running for only ...", young: { startedMs, ageMs: at - startedMs, waitMs: netnsKeeperYoungWaitMs(at - startedMs) } });
const gone = { unavailable: "pi-dispatch-egress-proxy", keeper: "the rootless network keeper pi-dispatch-netns-keeper is not under this account's Podman, ... so this job is retried rather than started", remedy: "start it as the worker's account: X", problem: "is not under this account's Podman" };

function harness({ now = () => NOW, egress, cancelReq = undefined, exitCode = 0 }) {
	const seen = { containerCalls: 0, records: [], logs: [], incr: 0, comments: [], redisOps: [] };
	const redis = { incr: async () => (seen.incr++, 1), decr: async () => 0, expire: async () => {} };
	// A cancel request key (issue #287's `cancel:req:<id>`), only when a test asks for one: `get` arms the cancel poll.
	if (cancelReq !== undefined) {
		const keys = new Map([[`cancel:req:local-keeper`, cancelReq]]);
		Object.assign(redis, {
			get: async (k) => keys.get(k) ?? null,
			set: async (k, v) => (seen.redisOps.push(["set", k]), keys.set(k, v), "OK"),
			del: async (k) => (seen.redisOps.push(["del", k]), keys.delete(k), 1),
		});
	}
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		now,
		recordRun: (r) => seen.records.push(r),
		timeoutMs: 100000,
		deps: {
			egressPreflight: async () => egress,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => (seen.containerCalls++, { code: exitCode, aborted: false, turns: 1 }),
			cleanup: async () => {},
			comment: async (_job, text) => void seen.comments.push(text),
			log: (event, fields) => seen.logs.push({ event, ...fields }),
		},
	});
	return { processor, seen };
}

const DATA = { kind: "local", folder: "/srv/site", flow: "tidy", task: "t" };

test("a job on a young keeper is delayed until it is old enough, without an attempt, then runs on the same attempt (#476)", { skip }, async () => {
	const { job, moves, updates } = spyJob({ ...DATA });
	const first = harness({ egress: young(NOW - 600) });
	await assert.rejects(() => first.processor(job, "the-token", new AbortController().signal), (err) => err.name === "DelayedError");
	assert.deepEqual(moves, [{ ts: NOW + 3_400, tok: "the-token" }], "until it is 3 s old plus the margin, with the worker's token");
	assert.deepEqual(updates.map((d) => [d.netnsKeeperHoldSinceMs, d.netnsKeeperHoldLastMs, d.netnsKeeperHoldStartedMs]), [[NOW, NOW, NOW - 600]], "the hold and the keeper start it waits on are stored");
	assert.deepEqual([first.seen.containerCalls, first.seen.incr, first.seen.records.length, job.attemptsMade], [0, 0, 0, 0], "nothing started, reserved, recorded or spent");
	assert.deepEqual(first.seen.logs.filter((l) => l.event === "netns_keeper_young_hold").map((l) => [l.keeperAgeMs, l.heldForMs, l.delayMs]), [[600, 0, 3_400]]);
	assert.ok(!first.seen.logs.some((l) => l.event === "egress_keeper_not_holding"), "no not-holding line for a keeper that is only young");
	// The pickup on time: the keeper is now old enough and holds.
	const later = harness({ now: () => NOW + 3_400, egress: { ok: true } });
	const result = await later.processor(job, "tok2", new AbortController().signal);
	assert.deepEqual([result.outcome, moves.length, later.seen.containerCalls], ["completed", 1, 1]);
});

test("a keeper that started again while the job waited is a crash loop: the job is not run, the loop is named (#476)", { skip }, async () => {
	const { job, moves } = spyJob({ ...DATA, netnsKeeperHoldSinceMs: NOW - 3_400, netnsKeeperHoldLastMs: NOW - 3_400, netnsKeeperHoldStartedMs: NOW - 4_000 });
	const { processor, seen } = harness({ egress: young(NOW - 500) });
	await assert.rejects(
		() => processor(job, "tok", new AbortController().signal),
		(err) => err.name === "InfraRetry" && err.reason === NETNS_KEEPER_CRASH_LOOP && err.budgetReserved === false && /keeps restarting \(a crash loop\)/.test(err.message) && /and started again at /.test(err.message),
	);
	assert.deepEqual([moves.length, seen.containerCalls, seen.incr, seen.records.length], [0, 0, 0, 1]);
	assert.deepEqual([buildRecord(seen.records[0]).outcome, buildRecord(seen.records[0]).reason], ["failed", "netns-keeper-crash-loop"], "the run record's own reason");
});

test("a keeper gone while the job waited on it is the loop's other face, named the same (#476)", { skip }, async () => {
	const { job } = spyJob({ ...DATA, netnsKeeperHoldSinceMs: NOW - 3_400, netnsKeeperHoldLastMs: NOW - 3_400, netnsKeeperHoldStartedMs: NOW - 4_000 });
	const { processor, seen } = harness({ egress: gone });
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (err) => err.reason === NETNS_KEEPER_CRASH_LOOP && /and 3\.4 s later it is not under this account's Podman, /.test(err.message));
	assert.deepEqual([seen.containerCalls, seen.records.length], [0, 1]);
	// With no hold in progress, the same read is today's ordinary retry, unchanged.
	const fresh = spyJob({ ...DATA });
	const plain = harness({ egress: gone });
	await assert.rejects(() => plain.processor(fresh.job, "tok", new AbortController().signal), (err) => err.name === "InfraRetry" && err.reason === NETNS_KEEPER_NOT_HOLDING && err.message === gone.keeper);
	assert.equal(fresh.moves.length, 0, "no deferral: the queue's attempts retry it");
	assert.ok(plain.seen.logs.some((l) => l.event === "egress_keeper_not_holding"));
});

test("the hold is bounded: a keeper still young after it fails the job named as a loop (#476)", { skip }, async () => {
	// The same start, still young (a start read in the future), 30 s into the hold.
	const { job, moves } = spyJob({ ...DATA, netnsKeeperHoldSinceMs: NOW - NETNS_KEEPER_YOUNG_HOLD_MAX_MS, netnsKeeperHoldLastMs: NOW - 4_000, netnsKeeperHoldStartedMs: NOW + 1_000 });
	const { processor } = harness({ egress: young(NOW + 1_000) });
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (err) => err.reason === NETNS_KEEPER_CRASH_LOOP && /and 30 s later it still read as younger than 3 s/.test(err.message));
	assert.equal(moves.length, 0);
	// One millisecond inside the bound: held again, the stored start kept.
	const inside = spyJob({ ...DATA, netnsKeeperHoldSinceMs: NOW - NETNS_KEEPER_YOUNG_HOLD_MAX_MS + 1, netnsKeeperHoldLastMs: NOW - 4_000, netnsKeeperHoldStartedMs: NOW + 1_000 });
	await assert.rejects(() => harness({ egress: young(NOW + 1_000) }).processor(inside.job, "tok", new AbortController().signal), (err) => err.name === "DelayedError");
	assert.equal(inside.updates[0].netnsKeeperHoldSinceMs, NOW - NETNS_KEEPER_YOUNG_HOLD_MAX_MS + 1);
});

test("a hold checked again after more than the bound starts afresh: a retry after its backoff is not a loop (#476)", { skip }, async () => {
	const { job, updates } = spyJob({ ...DATA, netnsKeeperHoldSinceMs: NOW - 90_000, netnsKeeperHoldLastMs: NOW - NETNS_KEEPER_YOUNG_HOLD_MAX_MS - 1, netnsKeeperHoldStartedMs: NOW - 90_000 });
	await assert.rejects(() => harness({ egress: young(NOW - 500) }).processor(job, "tok", new AbortController().signal), (err) => err.name === "DelayedError");
	assert.deepEqual([updates[0].netnsKeeperHoldSinceMs, updates[0].netnsKeeperHoldStartedMs], [NOW, NOW - 500], "a fresh hold on the keeper read now");
	// And a stale hold with the keeper gone is today's ordinary retry, not a loop.
	const stale = spyJob({ ...DATA, netnsKeeperHoldSinceMs: NOW - 90_000, netnsKeeperHoldLastMs: NOW - NETNS_KEEPER_YOUNG_HOLD_MAX_MS - 1, netnsKeeperHoldStartedMs: NOW - 90_000 });
	await assert.rejects(() => harness({ egress: gone }).processor(stale.job, "tok", new AbortController().signal), (err) => err.reason === NETNS_KEEPER_NOT_HOLDING);
	// Exactly at the bound is still the same hold.
	const edge = spyJob({ ...DATA, netnsKeeperHoldSinceMs: NOW - 10_000, netnsKeeperHoldLastMs: NOW - NETNS_KEEPER_YOUNG_HOLD_MAX_MS, netnsKeeperHoldStartedMs: NOW - 9_000 });
	await assert.rejects(() => harness({ egress: young(NOW - 500) }).processor(edge.job, "tok", new AbortController().signal), (err) => err.reason === NETNS_KEEPER_CRASH_LOOP);
});

// Gate of PR #479: the loop's retry comes after the queue's 60 s backoff, past the hold's 30 s window, and met a keeper
// restarted out of order (or none): it failed as netns-keeper-not-holding, and that record and comment replaced the
// loop's. Two attempts, as the queue runs them: the second is still named the loop.
test("a crash loop seen on attempt 1 still names attempt 2's keeper failure, whatever it found (#476, PR #479 gate)", { skip }, async () => {
	const { job } = spyJob({ ...DATA });
	// Attempt 1: young, held; then a new start: the loop.
	await assert.rejects(() => harness({ egress: young(NOW - 250) }).processor(job, "t1", new AbortController().signal), (err) => err.name === "DelayedError");
	const first = harness({ now: () => NOW + 3_750, egress: young(NOW + 3_400, NOW + 3_750) });
	await assert.rejects(() => first.processor(job, "t2", new AbortController().signal), (err) => err.reason === NETNS_KEEPER_CRASH_LOOP);
	assert.deepEqual(job.data.netnsKeeperLoopSeen, [NOW - 250, NOW + 3_400], "the starts seen, kept on the job");
	// Attempt 2, the queue's retry a minute later: the keeper restarted out of order against the proxy (not young).
	job.attemptsMade = 1;
	const lateKeeper = { ...gone, keeper: "the rootless network keeper pi-dispatch-netns-keeper started 64 s after the egress proxy did, ...", problem: "started 64 s after the egress proxy did, so it was down while the proxy ran", remedy: "restart the egress proxy once no job is running: P" };
	const second = harness({ now: () => NOW + 64_000, egress: lateKeeper });
	await assert.rejects(
		() => second.processor(job, "t3", new AbortController().signal),
		(err) => err.name === "InfraRetry" && err.reason === NETNS_KEEPER_CRASH_LOOP && err.budgetReserved === false && err.message.includes("an earlier attempt of this job saw it start at 2026-09-29T11:59:59.750Z and 2026-09-29T12:00:03.400Z, and now it started 64 s after the egress proxy did") && err.message.endsWith("then restart the egress proxy once no job is running: P"),
	);
	assert.deepEqual([second.seen.containerCalls, second.seen.records.length], [0, 1]);
	assert.deepEqual([buildRecord(second.seen.records[0]).outcome, buildRecord(second.seen.records[0]).reason], ["failed", "netns-keeper-crash-loop"], "the terminal attempt's record names the loop");
	// And a keeper gone on attempt 2 is named the loop too.
	const third = harness({ now: () => NOW + 64_000, egress: gone });
	await assert.rejects(() => third.processor(job, "t4", new AbortController().signal), (err) => err.reason === NETNS_KEEPER_CRASH_LOOP && /and now it is not under this account's Podman, /.test(err.message));
	// A young keeper on attempt 2 is still held, not failed: the marker names failures, it does not refuse a keeper.
	const { job: again } = spyJob({ ...DATA, netnsKeeperLoopSeen: [NOW - 90_000] });
	await assert.rejects(() => harness({ egress: young(NOW - 300) }).processor(again, "t5", new AbortController().signal), (err) => err.name === "DelayedError");
	// A job with no marker is today's ordinary not-holding retry.
	const { job: plain } = spyJob({ ...DATA });
	await assert.rejects(() => harness({ now: () => NOW + 64_000, egress: lateKeeper }).processor(plain, "t6", new AbortController().signal), (err) => err.reason === NETNS_KEEPER_NOT_HOLDING);
	// The gone-while-held path stores the marker too.
	const { job: died } = spyJob({ ...DATA, netnsKeeperHoldSinceMs: NOW - 3_400, netnsKeeperHoldLastMs: NOW - 3_400, netnsKeeperHoldStartedMs: NOW - 4_000 });
	await assert.rejects(() => harness({ egress: gone }).processor(died, "t7", new AbortController().signal), (err) => err.reason === NETNS_KEEPER_CRASH_LOOP);
	assert.deepEqual(died.data.netnsKeeperLoopSeen, [NOW - 4_000]);
	assert.match(netnsKeeperLoopAgainSentence({ seen: [NOW], problem: "is exited under this account's Podman" }), /saw it start at 2026-09-29T12:00:00\.000Z, and now it is exited under this account's Podman, .* then start it as the worker's account: systemctl --user restart pi-dispatch-netns-keeper\.service$/);
});

// Gate of PR #479: a cancel acknowledged between pickup and the hold went back to the delayed set and ran later.
test("an operator's cancel ends a job the young-keeper hold would delay, before it starts; a shutdown's abort keeps it held (#476, PR #479 gate)", { skip }, async () => {
	const aborted = (reason) => {
		const c = new AbortController();
		c.abort(reason);
		return c.signal;
	};
	const { job, moves, updates } = spyJob({ ...DATA });
	const h = harness({ egress: young(NOW - 600) });
	const result = await h.processor(job, "tok", aborted("operator-cancel"));
	assert.deepEqual([result.outcome, result.reason, result.budgetReserved], ["policy", "operator-cancel", false]);
	assert.deepEqual([moves.length, updates.length, h.seen.containerCalls, h.seen.incr], [0, 0, 0, 0], "not delayed, nothing started or reserved");
	assert.deepEqual(h.seen.comments, [mod.CANCELLED_BEFORE_START_COMMENT]);
	assert.deepEqual([buildRecord(h.seen.records[0]).outcome, buildRecord(h.seen.records[0]).reason], ["policy", "operator-cancel"]);
	// A request not yet polled: read, acknowledged and consumed as the poll would, and the job ends the same way.
	const req = spyJob({ ...DATA });
	const polled = harness({ egress: young(NOW - 600), cancelReq: "1" });
	assert.equal((await polled.processor(req.job, "tok", new AbortController().signal)).reason, "operator-cancel");
	assert.deepEqual(polled.seen.redisOps, [["set", "cancel:ack:local-keeper"], ["del", "cancel:req:local-keeper"]]);
	assert.equal(req.moves.length, 0);
	// No request: held as before.
	const none = spyJob({ ...DATA });
	await assert.rejects(() => harness({ egress: young(NOW - 600), cancelReq: null }).processor(none.job, "tok", new AbortController().signal), (err) => err.name === "DelayedError");
	assert.equal(none.moves.length, 1);
	// A shutdown is not a cancel: the job is kept, held.
	const shut = spyJob({ ...DATA });
	await assert.rejects(() => harness({ egress: young(NOW - 600) }).processor(shut.job, "tok", aborted("shutdown")), (err) => err.name === "DelayedError");
	assert.equal(shut.moves.length, 1);
});

// Gate of PR #479: the same question for an ORDINARY retryable failure, asked in the one place the holds ask it. A job
// whose cancel was acknowledged or requested is never handed back to the queue's retry.
test("an ordinary infra failure with a cancel pending ends the job as the operator's cancel, never a retry; a shutdown still retries (#476, PR #479 gate)", { skip }, async () => {
	const SILENT = { unavailable: "pi-dispatch-egress-proxy" }; // the daemon did not answer: InfraRetry container-never-started
	const aborted = (reason) => {
		const c = new AbortController();
		c.abort(reason);
		return c.signal;
	};
	// Plain, no cancel: the queue's retry, as before.
	const plain = spyJob({ ...DATA });
	await assert.rejects(() => harness({ egress: SILENT, cancelReq: null }).processor(plain.job, "tok", new AbortController().signal), (err) => err.name === "InfraRetry" && err.reason === "container-never-started");
	// A request pending: acknowledged, consumed, and the job ends as the cancel, recorded, one comment.
	const req = spyJob({ ...DATA });
	const pending = harness({ egress: SILENT, cancelReq: "1" });
	const result = await pending.processor(req.job, "tok", new AbortController().signal);
	assert.deepEqual([result.outcome, result.reason, result.budgetReserved], ["policy", "operator-cancel", false]);
	assert.deepEqual(pending.seen.redisOps, [["set", "cancel:ack:local-keeper"], ["del", "cancel:req:local-keeper"]]);
	assert.deepEqual(pending.seen.comments, [mod.CANCELLED_BEFORE_START_COMMENT]);
	assert.deepEqual([buildRecord(pending.seen.records[0]).outcome, buildRecord(pending.seen.records[0]).reason, pending.seen.records.length], ["policy", "operator-cancel", 1]);
	// Acknowledged already (the signal aborted as a cancel): the same end.
	const acked = harness({ egress: SILENT });
	assert.equal((await acked.processor(spyJob({ ...DATA }).job, "tok", aborted("operator-cancel"))).reason, "operator-cancel");
	// A shutdown is not a cancel: retried as before.
	await assert.rejects(() => harness({ egress: SILENT }).processor(spyJob({ ...DATA }).job, "tok", aborted("shutdown")), (err) => err.name === "InfraRetry");
	// A retry that already spent (the container ran and exited 1, infra): the record keeps what it spent, and the comment
	// is the processor's own operator-cancel sentence, not "before it started".
	const ran = harness({ egress: { ok: true }, cancelReq: "1", exitCode: 1 });
	const spent = await ran.processor(spyJob({ ...DATA }).job, "tok", new AbortController().signal);
	assert.deepEqual([spent.reason, spent.budgetReserved, spent.exitCode, ran.seen.containerCalls], ["operator-cancel", true, 1, 1]);
	assert.deepEqual(ran.seen.comments.at(-1), "Stopped: the operator cancelled this run. Partial work may exist. Not retried.");
});

// Gate round 2 of PR #479: the cancel poll ran until the finally, so a request that landed after the handler's question
// was acknowledged by the poll while the job still went to its hold and ran again. The poll is now stopped, and a tick in
// flight awaited, BEFORE the question. The reviewer's race: a fast poll, the request written during the hold's own
// `updateData`. It must NOT be acknowledged (the job is back in the queue, and the requester says nothing was changed).
function raceWorld({ updateData, get: slowGet, cancelJob, egressDelayMs = 0, onPreflight = null } = {}) {
	const keys = new Map();
	const ops = [];
	const redis = {
		incr: async () => 1,
		decr: async () => 0,
		expire: async () => {},
		get: async (k) => (slowGet ? slowGet(k, keys) : (keys.get(k) ?? null)),
		set: async (k, v) => (ops.push(["set", k]), keys.set(k, v), "OK"),
		del: async (k) => (ops.push(["del", k]), keys.delete(k), 1),
	};
	const moves = [];
	const records = [];
	const job = { id: "local-race", attemptsMade: 0, name: "local", data: { ...DATA }, moveToDelayed: async (ts) => moves.push(ts) };
	job.updateData = updateData ? (d) => updateData(d, job, keys) : async (d) => void (job.data = d);
	const processor = mod.makeProcessor({
		cancelJob: cancelJob ?? (() => true),
		stopContainer: () => {},
		redis,
		cancelPollMs: 5,
		now: () => NOW,
		recordRun: (r) => records.push(r),
		timeoutMs: 100000,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		deps: { egressPreflight: async () => (egressDelayMs ? await new Promise((r) => setTimeout(r, egressDelayMs)) : null, (onPreflight?.(keys), young(NOW - 600))), prepareWorkspace: async () => ({}), runContainer: async () => ({ code: 0 }), cleanup: async () => {}, comment: async () => {}, log: () => {} },
	});
	return { processor, job, keys, ops, moves, records };
}

test("a cancel that lands after the handler's question is never acknowledged, and the job is held (#476, PR #479 gate round 2)", { skip }, async () => {
	const w = raceWorld({
		updateData: async (d, job, keys) => {
			keys.set("cancel:req:local-race", "operator-cancel");
			await new Promise((r) => setTimeout(r, 40)); // eight poll periods: a live poll would read it
			job.data = d;
		},
	});
	await assert.rejects(() => w.processor(w.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(w.ops, [], "no ack written, no request consumed");
	assert.equal(w.keys.get("cancel:ack:local-race"), undefined);
	assert.equal(w.keys.get("cancel:req:local-race"), "operator-cancel", "left for the requester's own timeout to delete");
	assert.equal(w.moves.length, 1, "held, as the unacknowledged requester is told");
});

test("the poll is stopped BEFORE the question: a request landing during the question is never acknowledged (#476, PR #479 gate round 2)", { skip }, async () => {
	// Armed when the keeper read returns, with only microtasks between it and the handler: from then, every read of the
	// request answers what it held when sent (nothing) and the operator's request lands while it is in flight. Asked
	// after the poll stopped, nobody reads it again; a poll still live during the question would read it and ack it.
	let armed = false;
	const w = raceWorld({
		onPreflight: () => void (armed = true),
		egressDelayMs: 12,
		get: async (k, keys) => {
			const sent = keys.get(k) ?? null;
			if (k === "cancel:req:local-race" && armed) {
				keys.set(k, "operator-cancel");
				await new Promise((r) => setTimeout(r, 30));
			}
			return sent;
		},
	});
	await assert.rejects(() => w.processor(w.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	await new Promise((r) => setTimeout(r, 60));
	assert.deepEqual(w.ops, [], "no ack written, no request consumed");
	assert.equal(w.moves.length, 1);
});

test("a poll tick already in flight is awaited before the question, so one cancel is acknowledged once (#476, PR #479 gate round 2)", { skip }, async () => {
	const controller = new AbortController();
	let slowReads = 0;
	const w = raceWorld({
		// The request is already there; the poll's read of it is slow, so its tick is in flight when the handler runs.
		// A read answers what the key held when it was SENT, as Valkey does.
		get: async (k, keys) => {
			const sent = keys.get(k) ?? null;
			if (k === "cancel:req:local-race" && slowReads++ === 0) await new Promise((r) => setTimeout(r, 40));
			return sent;
		},
		cancelJob: (_id, reason) => (controller.abort(reason), true),
		// The keeper read takes long enough that the poll's first tick (5 ms) has started its slow read.
		egressDelayMs: 15,
	});
	w.keys.set("cancel:req:local-race", "operator-cancel");
	const result = await w.processor(w.job, "tok", controller.signal);
	await new Promise((r) => setTimeout(r, 80)); // a tick left running would finish here
	assert.equal(result.reason, "operator-cancel");
	assert.deepEqual(w.ops, [["set", "cancel:ack:local-race"], ["del", "cancel:req:local-race"]], "acknowledged once, by the tick, never twice");
	assert.equal(w.moves.length, 0);
});

test("the cancel record keeps the run's session, as the aborted-container path does (#476, PR #479 gate round 2)", { skip }, async () => {
	const SESSION = { key: "k", resumed: false, staged: true };
	const { job } = spyJob({ ...DATA });
	const h = harness({ egress: { unavailable: "p" }, cancelReq: "1" });
	// A retryable throw that carries the session the processor merged (`mergeSession`), as runJob's infra throws do.
	const { InfraRetry } = await import("../src/processor.mjs");
	const failing = mod.makeProcessor({
		cancelJob: () => true,
		stopContainer: () => {},
		redis: { incr: async () => 1, decr: async () => 0, expire: async () => {}, get: async (k) => (k === "cancel:req:local-keeper" ? "1" : null), set: async () => "OK", del: async () => 1 },
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		now: () => NOW,
		recordRun: (r) => h.seen.records.push(r),
		timeoutMs: 100000,
		deps: {
			egressPreflight: async () => ({ ok: true }),
			prepareWorkspace: async () => ({}),
			runContainer: async () => {
				throw new InfraRetry("infra failure, container exit 1", { exitCode: 1, turns: 2, tokens: null, session: SESSION, budgetReserved: true });
			},
			cleanup: async () => {},
			comment: async () => {},
			log: () => {},
		},
	});
	const result = await failing(job, "tok", new AbortController().signal);
	assert.deepEqual([result.reason, result.session, result.budgetReserved], ["operator-cancel", SESSION, true]);
	assert.deepEqual(h.seen.records.at(-1).result.session, SESSION);
});

test("the sandbox opener waits a young keeper out once, bounded, rather than refusing it (#476)", async () => {
	const info = async () => ({ answered: true, info: { version: "4.9.3" } });
	const run = async (answers, clock, proxyRead = { code: 0, stdout: `${clock - 700}\n` }) => {
		const slept = [];
		let i = 0;
		let t = clock;
		const readKeeper = async (args) => (args.at(-1) === "pi-dispatch-netns-keeper" ? answers[Math.min(i++, answers.length - 1)] : proxyRead);
		const answer = await sandboxKeeperCheck({ proxy: "pi-dispatch-egress-proxy", info, readKeeper, now: () => t, sleep: async (ms) => (slept.push(ms), (t += ms)) });
		return { answer, slept, reads: i };
	};
	// A keeper 0.6 s old: one wait of 3.4 s, then it holds.
	const held = await run([read(NOW - 600), read(NOW - 600)], NOW);
	assert.deepEqual([held.answer, held.slept, held.reads], [null, [3_400], 2]);
	// Restarted during the wait: refused, as a young keeper was before.
	const looped = await run([read(NOW - 600), read(NOW + 3_000)], NOW);
	assert.deepEqual([looped.answer?.refused, looped.slept, looped.reads], ["netns-keeper-not-holding", [3_400], 2]);
	assert.match(looped.answer.message, /has been running for only 0\.4 s/);
	// Absent: refused at once, no wait.
	const absent = await run([{ code: 125, stdout: "" }], NOW);
	assert.deepEqual([absent.answer?.refused, absent.slept, absent.reads], ["netns-keeper-not-holding", [], 1]);
	// The wait is the judge's, so capped at the minimum age plus the margin (a start read in the future, the proxy's start unread).
	const future = await run([read(NOW + 60_000), read(NOW - 60_000)], NOW, { code: 125, stdout: "" });
	assert.deepEqual(future.slept, [4_000]);
});
