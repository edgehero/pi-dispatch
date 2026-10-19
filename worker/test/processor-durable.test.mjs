import assert from "node:assert/strict";
import { test } from "node:test";
import { forgeDeliveryJobId } from "../src/job-id.mjs";
import { InfraRetry, RECOVERY_CAP, RECOVERY_COMMENTS, RECOVERY_ENQUEUED, RECOVERY_RETRY_WAIT_MS, RecoveryWaitHold, runJob } from "../src/processor.mjs";
import { makeRunningJobs } from "../src/index.mjs";
import { buildRecord } from "../src/run-history.mjs";

// Issue #645, durable runs (wave 2, part B2a): the processor's half. Every collaborator is a hand-rolled fake: the
// checkpoint store, the run budget ledger (with the compare-and-set semantics of run-budget-ledger.mjs), the pointer and
// the enqueuer. The money half runs through the real dollar-budget.mjs over a keyed fake Valkey.

const USD = 1_000_000;
const NOW = new Date("2026-10-07T12:00:00Z");
const DAY = "budget:usd:2026-10-07";
const BASE = "b".repeat(40);
const PI = "1.2.0";
const HOST = "h1";

/** A keyed fake: the job-count INCR/DECR and the dollar INCRBY/DECRBY on one store (processor-dollars.test.mjs's). */
function keyedRedis() {
	const store = new Map();
	const ops = [];
	const at = (k) => store.get(k) ?? 0;
	return {
		store,
		ops,
		async incr(k) {
			ops.push(["incr", k]);
			store.set(k, at(k) + 1);
			return at(k);
		},
		async decr(k) {
			ops.push(["decr", k]);
			store.set(k, at(k) - 1);
			return at(k);
		},
		async incrby(k, n) {
			ops.push(["incrby", k, n]);
			store.set(k, at(k) + n);
			return at(k);
		},
		async decrby(k, n) {
			ops.push(["decrby", k, n]);
			store.set(k, at(k) - n);
			return at(k);
		},
		async eval(_script, _n, k, arg) {
			const d = Number(arg);
			ops.push(["settle", k, d]);
			if (!store.has(k)) return [1, 0];
			store.set(k, Math.max(0, at(k) + d));
			return [0, at(k)];
		},
		async expire() {},
		async get() {
			return null;
		},
		async del(k) {
			ops.push(["del", k]);
			store.delete(k);
			return 1;
		},
	};
}

/** The run budget ledger, in memory, with run-budget-ledger.mjs's transitions: every move only FROM `held`. */
function fakeLedger({ fail = {} } = {}) {
	const runs = new Map();
	const calls = [];
	const run = (id) => {
		if (!runs.has(id)) runs.set(id, { slot: null, seq: 0, holds: new Map() });
		return runs.get(id);
	};
	const move = (op, id, seq, to) => {
		calls.push([op, id, seq]);
		if (fail[op]) return { error: "valkey" };
		const h = run(id).holds.get(seq);
		if (!h || h.state !== "held") return "not-held";
		h.state = to;
		return "moved";
	};
	return {
		runs,
		calls,
		async claimSlot(id) {
			calls.push(["claimSlot", id]);
			if (fail.claimSlot) return { error: "valkey" };
			const r = run(id);
			if (r.slot) return "carried";
			r.slot = "held";
			return "new";
		},
		async nextSeq(id) {
			calls.push(["nextSeq", id]);
			if (fail.nextSeq) return { error: "valkey" };
			return ++run(id).seq;
		},
		async recordHold(id, seq, hold) {
			calls.push(["recordHold", id, seq]);
			if (fail.recordHold) return { error: "valkey" };
			const r = run(id);
			if (r.holds.has(seq)) return { error: "exists" };
			r.holds.set(seq, { state: "held", amountMicros: hold.amountMicros });
			return { ok: true };
		},
		settle: (id, seq) => move("settle", id, seq, "settled"),
		release: (id, seq) => move("release", id, seq, "released"),
		async settleCrashed(id, below) {
			calls.push(["settleCrashed", id, below]);
			const settled = [];
			for (const [seq, h] of run(id).holds) if (h.state === "held" && seq < below) (h.state = "settled-crashed"), settled.push(seq);
			return { settled };
		},
		async remove(id) {
			calls.push(["remove", id]);
			runs.delete(id);
			return { ok: true };
		},
	};
}

const MANIFEST = { v: 1, runId: "x", seq: 4, attempt: 1, host: HOST, kind: "live", quiesced: "frozen", at: 1, transcript: { bytes: 1, sha256: "0".repeat(64) }, workspace: { commit: "c".repeat(40), baseSha: BASE, objectFormat: "sha1", partial: false, ignoredDropped: false, counts: {}, git: {} }, piVersion: PI, imageDigest: null, venue: "local", provider: "anthropic", model: "m" };

function fakeCheckpointer(calls, { manifest = MANIFEST, restore = { written: 2, removed: 0 }, prime = { ok: true } } = {}) {
	const stores = new Set();
	return {
		stores,
		async primeBase(args) {
			calls.push(["primeBase", args.runId, args.baseSha, args.objectFormat]);
			stores.add(args.runId);
			return prime;
		},
		async readManifest(runId) {
			calls.push(["readManifest", runId]);
			return manifest === null ? { absent: true } : { ok: true, manifest, transcriptPath: "/store/cp-4/transcript.jsonl" };
		},
		async restore(args) {
			calls.push(["restore", args.runId, args.intoWorkspace]);
			return restore;
		},
		baseSourceUrl: (runId) => `file:///store/${runId}/repo.git`,
		async remove(runId) {
			calls.push(["store-remove", runId]);
			stores.delete(runId);
			return { removed: true };
		},
	};
}

const job = { kind: "github", repo: "org/repo", provider: "anthropic", model: "m", maxTurns: 20, recover: true, trigger: { deliveryId: "d1" } };
const RUN = forgeDeliveryJobId("github", "d1");
const recoveryJob = (n = 1) => ({ ...job, recoveryOf: RUN, recovery: n });

function deps(overrides = {}) {
	const calls = [];
	const logs = [];
	const redis = overrides.redis ?? keyedRedis();
	const pointers = new Map([[RUN, { v: 1, host: HOST, hostQueue: null, seq: 4, attempt: 1, at: 1, jobDir: "job-abc" }]]);
	const base = {
		redis,
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		imagePreflight: async () => ({ ok: true, piVersion: PI, capabilities: ["recover"], imageDigest: "sha256:" + "d".repeat(64) }),
		mintToken: async () => (calls.push(["mint"]), "tok"),
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async (_j, _t, opts) => (calls.push(["prepare", opts?.pin ?? null]), { workspace: "/j/workspace", jobDir: "/j", sha: BASE }),
		runContainer: async (ctx) => (calls.push(["run-container", { recover: ctx.recover ?? false, recovering: ctx.recovering ?? false, checkpoint: ctx.checkpoint ?? null }]), { code: 0, aborted: false }),
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => calls.push(["cleanup"]),
		comment: async (_j, t) => calls.push(["comment", t]),
		log: (event, fields) => logs.push([event, fields]),
		now: NOW,
		hostName: HOST,
		runBudgetLedger: fakeLedger(),
		readCheckpointPointer: async ({ runId }) => (calls.push(["readPointer", runId]), pointers.get(runId) ?? null),
		removeCheckpointPointer: async ({ runId }) => (calls.push(["pointer-remove", runId]), pointers.delete(runId)),
		enqueueRecovery: async ({ cause }) => (calls.push(["enqueue", cause]), { enqueued: true, jobId: `${RUN}.r1`, n: 1 }),
		stageRecovered: async (args) => (calls.push(["stageRecovered", args.jobDir, args.transcriptPath]), { hostDir: "/j/session", key: null, resume: true, reason: "recovered", bytes: 1 }),
		resetTrustPaths: async (args) => (calls.push(["resetTrustPaths", args.workspace, args.baseSha]), { deleted: 1, written: 1 }),
		baseHasExtensions: async (args) => (calls.push(["baseHasExtensions", args.baseSha]), false),
	};
	const d = { ...base, ...overrides, redis };
	if (!Object.hasOwn(overrides, "workspaceCheckpointer")) d.workspaceCheckpointer = fakeCheckpointer(calls);
	return { deps: d, calls, logs, redis, pointers, ledger: d.runBudgetLedger };
}

const names = (calls) => calls.map((c) => c[0]);

// ── gate order ──────────────────────────────────────────────────────────────────────────────────────────────────

test("every new refusal comes before the mint, the claim and every reserve", async () => {
	const cases = [
		["recover-store-unset", job, { workspaceCheckpointer: null }],
		["recovery-cap", recoveryJob(RECOVERY_CAP + 1), {}],
		["recovery-cap", recoveryJob(0), {}],
		["recovery-checkpoint-absent", recoveryJob(1), { workspaceCheckpointer: fakeCheckpointer([], { manifest: null }) }],
		["recovery-checkpoint-absent", recoveryJob(1), { workspaceCheckpointer: fakeCheckpointer([], { manifest: { ...MANIFEST, piVersion: "1.1.0" } }) }],
		["recovery-checkpoint-absent", recoveryJob(1), { workspaceCheckpointer: fakeCheckpointer([], { manifest: { ...MANIFEST, venue: "podman" } }) }],
		["recovery-checkpoint-absent", recoveryJob(1), { workspaceCheckpointer: fakeCheckpointer([], { manifest: { ...MANIFEST, host: "elsewhere" } }) }],
	];
	for (const [reason, j, over] of cases) {
		const { deps: d, calls, redis, ledger } = deps(over);
		const r = await runJob(j, d);
		assert.deepEqual([r.outcome, r.reason, r.budgetReserved], ["policy", reason, false], reason);
		assert.ok(!names(calls).includes("mint"), `${reason}: before the mint`);
		assert.ok(!names(calls).includes("prepare"), `${reason}: before the clone`);
		assert.equal(redis.ops.filter((o) => o[0] === "incr" || o[0] === "incrby").length, 0, `${reason}: nothing reserved`);
		assert.ok(!ledger.calls.some((c) => c[0] === "claimSlot" || c[0] === "nextSeq"), `${reason}: no claim`);
		assert.ok(calls.some((c) => c[0] === "comment" && c[1] === RECOVERY_COMMENTS[reason]), `${reason}: its fixed comment`);
	}
});

test("a superseded recovery (its run's pointer AND store are gone) is refused silently, before the mint, and cleans up nothing", async () => {
	const { deps: d, calls, pointers } = deps({ workspaceCheckpointer: fakeCheckpointer([], { manifest: null }) });
	pointers.clear();
	const r = await runJob(recoveryJob(1), d);
	assert.deepEqual([r.outcome, r.reason], ["policy", "recovery-superseded"]);
	assert.ok(!names(calls).includes("comment"), "no comment");
	assert.ok(!names(calls).includes("mint"));
	assert.ok(!names(calls).includes("store-remove"), "an empty pointer read never deletes a store");
	assert.ok(!names(calls).includes("pointer-remove"));
	assert.ok(!d.runBudgetLedger.calls.some((c) => c[0] === "remove"));
});

test("a recovery whose base still runs here is HELD (no attempt), before the mint", async () => {
	const { deps: d, calls } = deps({ runningJobs: { list: () => [{ id: RUN }] } });
	await assert.rejects(runJob(recoveryJob(1), d), (e) => e instanceof RecoveryWaitHold && e.reason === "container-never-started" && e.recoveryWaitMs > 0);
	assert.ok(!names(calls).includes("mint"));
});

test("a missing pointer beside a store that is still there (a Valkey blip reads as null) is retried, never superseded", async () => {
	const { deps: d, calls, pointers } = deps();
	pointers.clear();
	await assert.rejects(runJob(recoveryJob(1), d), (e) => e instanceof InfraRetry && e.reason === "container-never-started");
	assert.ok(!names(calls).includes("mint"));
	assert.ok(!names(calls).includes("store-remove"));
});

test("a pointer read that throws is retried, never read as superseded", async () => {
	const { deps: d } = deps({ readCheckpointPointer: async () => Promise.reject(new Error("ECONNRESET")) });
	await assert.rejects(runJob(recoveryJob(1), d), (e) => e instanceof InfraRetry && e.reason === "container-never-started");
});

test("an armed job on a wiring with a store but no ledger is config-refused before the mint", async () => {
	const { deps: d, calls } = deps({ runBudgetLedger: null });
	const r = await runJob(job, d);
	assert.deepEqual([r.outcome, r.reason], ["policy", "config-refused"]);
	assert.ok(!names(calls).includes("mint"));
});

// ── recovery job ────────────────────────────────────────────────────────────────────────────────────────────────

test("a recovery job clones from the store (pin), then restore, trust reset and stageRecovered, and runs recovering", async () => {
	const { deps: d, calls, ledger } = deps();
	const r = await runJob(recoveryJob(1), d);
	assert.equal(r.outcome, "completed");
	const prep = calls.filter((c) => c[0] === "prepare");
	assert.equal(prep.length, 1, "one prepare");
	assert.deepEqual(prep[0][1], { sha: BASE, from: `file:///store/${RUN}/repo.git` }, "the clone path is the store's, at the checkpoint's base");
	const order = names(calls).filter((n) => ["prepare", "restore", "resetTrustPaths", "stageRecovered", "run-container"].includes(n));
	assert.deepEqual(order, ["prepare", "restore", "resetTrustPaths", "stageRecovered", "run-container"]);
	assert.deepEqual(calls.find((c) => c[0] === "resetTrustPaths").slice(1), ["/j/workspace", BASE]);
	assert.ok(!names(calls).includes("primeBase"), "a recovery never re-primes");
	const run = calls.find((c) => c[0] === "run-container")[1];
	assert.equal(run.recover, true);
	assert.equal(run.recovering, true);
	assert.equal(run.checkpoint.runId, RUN);
	assert.equal(run.checkpoint.baseSha, BASE);
	assert.equal(run.checkpoint.attempt, 1, "the container number from the ledger");
	assert.deepEqual(run.checkpoint.secretValues, ["tok"]);
	assert.deepEqual(r.recovered, { from: "live", n: 1, fromAttempt: 1, checkpointSeq: 4, orphans: null, replayed: null, interrupted: null, notStarted: null });
	assert.equal(ledger.calls.filter((c) => c[0] === "settleCrashed").length, 1);
});

test("settleCrashed is called once, at recovery start, with this container's number, and settles the crashed hold", async () => {
	const ledger = fakeLedger();
	// The base: seq 1, a recorded hold the crash left `held`.
	await ledger.claimSlot(RUN);
	await ledger.nextSeq(RUN);
	await ledger.recordHold(RUN, 1, { amountMicros: 2 * USD, keys: [DAY] });
	ledger.calls.length = 0;
	const { deps: d } = deps({ runBudgetLedger: ledger });
	await runJob(recoveryJob(1), d);
	const sc = ledger.calls.filter((c) => c[0] === "settleCrashed");
	assert.deepEqual(sc, [["settleCrashed", RUN, 2]]);
	assert.ok(ledger.calls.findIndex((c) => c[0] === "settleCrashed") < ledger.calls.findIndex((c) => c[0] === "remove"));
	// settled-crashed, never released: the completed recovery then removed the ledger at the run's final outcome.
	assert.equal(ledger.runs.has(RUN), false);
});

test("a restore the store refuses is recovery-checkpoint-absent, before any reserve; one it skipped is a never-started retry", async () => {
	const a = deps({ workspaceCheckpointer: fakeCheckpointer([], { restore: { refused: "tampered" } }) });
	const r = await runJob(recoveryJob(1), a.deps);
	assert.deepEqual([r.outcome, r.reason], ["policy", "recovery-checkpoint-absent"]);
	assert.equal(a.redis.ops.filter((o) => o[0] === "incr").length, 0);
	const b = deps({ workspaceCheckpointer: fakeCheckpointer([], { restore: { skipped: "locked" } }) });
	await assert.rejects(runJob(recoveryJob(1), b.deps), (e) => e instanceof InfraRetry && e.reason === "container-never-started");
	assert.ok(!names(b.calls).includes("run-container"));
});

test("a trust reset that fails, or a transcript that cannot be staged, never starts the recovered container", async () => {
	for (const over of [{ resetTrustPaths: async () => Promise.reject(Object.assign(new Error("x"), { code: "GIT_DIR" })) }, { stageRecovered: async () => null }]) {
		const { deps: d, calls } = deps(over);
		await assert.rejects(runJob(recoveryJob(1), d), (e) => e instanceof InfraRetry && e.reason === "container-never-started");
		assert.ok(!names(calls).includes("run-container"));
	}
});

// ── fresh armed job ─────────────────────────────────────────────────────────────────────────────────────────────

test("a fresh armed forge job primes the store from its clone before the container, and passes the checkpoint args", async () => {
	const { deps: d, calls } = deps();
	const r = await runJob(job, d);
	assert.equal(r.outcome, "completed");
	const i = names(calls).indexOf("primeBase");
	assert.ok(i >= 0 && i < names(calls).indexOf("run-container"));
	assert.deepEqual(calls[i].slice(1), [RUN, BASE, "sha1"]);
	assert.deepEqual(calls.find((c) => c[0] === "prepare")[1], null, "no pin: an ordinary clone");
	const run = calls.find((c) => c[0] === "run-container")[1];
	assert.deepEqual([run.recover, run.recovering], [true, false]);
	assert.deepEqual(run.checkpoint.meta, { piVersion: PI, imageDigest: "sha256:" + "d".repeat(64), venue: "local", provider: "anthropic", model: "m" });
});

test("a base the store could not take: the run goes on, recoverSkipped base-unprimed in the record", async () => {
	const { deps: d } = deps({ workspaceCheckpointer: fakeCheckpointer([], { prime: { skipped: "base-too-large" } }) });
	const r = await runJob(job, d);
	assert.equal(r.outcome, "completed");
	assert.equal(r.recoverSkipped, "base-unprimed");
	assert.equal(buildRecord({ job: { id: RUN, data: job }, result: r }).recoverSkipped, "base-unprimed");
});

test("claimSlot 'carried' skips reserveLedgers; 'new' reserves exactly as before", async () => {
	const ledger = fakeLedger();
	await ledger.claimSlot(RUN);
	const carried = deps({ runBudgetLedger: ledger });
	const r = await runJob(job, carried.deps);
	assert.equal(r.outcome, "completed");
	assert.equal(carried.redis.ops.filter((o) => o[0] === "incr").length, 0, "no job-count INCR for a carried slot");
	assert.equal(r.budgetReserved, true, "the carried slot is still held, by the run");
	const fresh = deps();
	await runJob(job, fresh.deps);
	assert.deepEqual(fresh.redis.ops.filter((o) => o[0] === "incr").map((o) => o[1]), ["budget:2026-10-07"]);
});

test("a claim the ledger could not answer reserves nothing and is a never-started retry", async () => {
	const { deps: d, redis, calls } = deps({ runBudgetLedger: fakeLedger({ fail: { claimSlot: true } }) });
	await assert.rejects(runJob(job, d), (e) => e instanceof InfraRetry && e.reason === "container-never-started");
	assert.equal(redis.ops.length, 0);
	assert.ok(!names(calls).includes("run-container"));
});

test("a recordHold failure releases the hold and throws a never-started InfraRetry before any container", async () => {
	const { deps: d, calls, redis } = deps({ dollarCaps: { day: 10 * USD, week: null, month: null }, runBudgetLedger: fakeLedger({ fail: { recordHold: true } }) });
	await assert.rejects(runJob({ ...job, maxCostMicros: 2 * USD }, d), (e) => e instanceof InfraRetry && e.reason === "container-never-started" && e.dollars?.basis === "refunded");
	assert.ok(!names(calls).includes("run-container"));
	assert.equal(redis.store.get(DAY), 0, "the dollar hold given back whole");
	assert.deepEqual(redis.ops.filter((o) => o[1] === DAY).map((o) => o[0]).slice(0, 1), ["incrby"], "reserved once, then given back");
});

test("a recorded hold is settled through the ledger; a 'not-held' answer leaves the floor", async () => {
	const tokens = { input: 1, output: 1, total: 2, cost: 0.5, metered: true, unresolved: 0, unpriced: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, costCapMicros: 2 * USD, costRefused: 0, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0, costUnreported: 0 };
	const usage = { v: 1, piAi: null, truncated: 0, models: [{ provider: "anthropic", model: "m", calls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 2, cost: 0.5, unpriced: 0 }] };
	const runContainer = async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens, usage });
	const ok = deps({ dollarCaps: { day: 10 * USD, week: null, month: null }, runContainer });
	const r = await runJob({ ...job, maxCostMicros: 2 * USD }, ok.deps);
	assert.equal(r.dollars.basis, "metered");
	assert.ok(ok.ledger.calls.some((c) => c[0] === "settle"));
	const ledger = fakeLedger();
	ledger.settle = async () => "not-held";
	const floor = deps({ dollarCaps: { day: 10 * USD, week: null, month: null }, runContainer, runBudgetLedger: ledger });
	const f = await runJob({ ...job, maxCostMicros: 2 * USD }, floor.deps);
	assert.equal(f.dollars.basis, "floor");
	assert.equal(floor.redis.store.get(DAY), 2 * USD, "no window key moved");
});

// ── exits ───────────────────────────────────────────────────────────────────────────────────────────────────────

function checkpointHandle(calls, { exit = { seq: 5 }, close = { written: 3, failed: 1, skipped: 2, lastSeq: 5 } } = {}) {
	return {
		exit: async (opts) => (calls.push(["cp-exit", opts?.kind ?? null]), exit),
		close: async () => (calls.push(["cp-close"]), close),
		stats: () => ({ written: 0, failed: 0, skipped: 0 }),
	};
}

test("an infra exit of an armed job takes exit(), then enqueues a recovery, and RETURNS (no InfraRetry), keeping its checkpoint", async () => {
	const holder = { calls: null };
	const { deps: d, calls, ledger } = deps({ runContainer: async () => ({ code: 1, aborted: false, checkpoint: checkpointHandle(holder.calls) }) });
	holder.calls = calls;
	const r = await runJob(job, d);
	assert.deepEqual([r.outcome, r.reason, r.exitCode, r.budgetReserved], ["failed", RECOVERY_ENQUEUED, 1, true]);
	const order = names(calls).filter((n) => ["cp-exit", "cp-close", "enqueue", "cleanup"].includes(n));
	assert.deepEqual(order, ["cp-exit", "cp-close", "enqueue", "cleanup"]);
	assert.deepEqual(calls.find((c) => c[0] === "cp-exit"), ["cp-exit", "exit"], "an exit-kind checkpoint");
	assert.deepEqual(r.checkpoints, { written: 3, failed: 1, skipped: 2 });
	assert.ok(!names(calls).includes("store-remove"), "the checkpoint stays for the recovery");
	assert.ok(!names(calls).includes("pointer-remove"));
	assert.ok(!ledger.calls.some((c) => c[0] === "remove"));
	const rec = buildRecord({ job: { id: RUN, data: job }, result: r });
	assert.deepEqual([rec.outcome, rec.reason, rec.checkpoints], ["failed", RECOVERY_ENQUEUED, { written: 3, failed: 1, skipped: 2 }]);
});

test("an infra exit not enqueued (the enqueuer refused, or no checkpoint) throws today's InfraRetry", async () => {
	const a = deps({ runContainer: async () => ({ code: 1, aborted: false, checkpoint: checkpointHandle([]) }), enqueueRecovery: async () => ({ enqueued: false, reason: "cap" }) });
	await assert.rejects(runJob(job, a.deps), (e) => e instanceof InfraRetry && e.exitCode === 1 && e.checkpoints?.written === 3);
	const b = deps({ runContainer: async () => ({ code: 1, aborted: false }) });
	b.pointers.clear();
	await assert.rejects(runJob(job, b.deps), (e) => e instanceof InfraRetry);
	assert.ok(!names(b.calls).includes("enqueue"), "no pointer, no enqueue");
});

test("an unknown exit and a detached container of an armed job recover too; a never-started exit does not", async () => {
	for (const over of [{ code: 7 }, { code: 125, detached: true }]) {
		const { deps: d } = deps({ runContainer: async () => ({ aborted: false, checkpoint: checkpointHandle([]), ...over }) });
		const r = await runJob(job, d);
		assert.equal(r.reason, RECOVERY_ENQUEUED, JSON.stringify(over));
	}
	const holder = { calls: null };
	const { deps: d, calls } = deps({ runContainer: async () => ({ code: 125, aborted: false, checkpoint: checkpointHandle(holder.calls) }) });
	holder.calls = calls;
	await assert.rejects(runJob(job, d), (e) => e instanceof InfraRetry && e.reason === "container-never-started");
	assert.ok(names(calls).includes("cp-close"), "the handle WAS consulted (closed), so the no-exit assertion below is not vacuous");
	assert.ok(!names(calls).includes("enqueue"));
	assert.ok(!names(calls).includes("cp-exit"));
});

test("completed and policy exits never enqueue, and remove the store entry, the pointer and the ledger", async () => {
	for (const code of [0, 2]) {
		const holder = [];
		const { deps: d, calls, ledger, pointers } = deps({ runContainer: async () => ({ code, aborted: false, checkpoint: checkpointHandle(holder) }) });
		const r = await runJob(job, d);
		assert.equal(r.outcome, code === 0 ? "completed" : "policy");
		assert.ok(!names(calls).includes("enqueue"));
		assert.ok(!holder.some((c) => c[0] === "cp-exit"), "no exit checkpoint");
		assert.ok(holder.some((c) => c[0] === "cp-close"), "closed");
		assert.ok(calls.some((c) => c[0] === "store-remove" && c[1] === RUN));
		assert.ok(calls.some((c) => c[0] === "pointer-remove" && c[1] === RUN));
		assert.equal(pointers.has(RUN), false);
		assert.ok(ledger.calls.some((c) => c[0] === "remove" && c[1] === RUN));
	}
});

test("a worker abort of an armed job is policy: no exit checkpoint, no enqueue", async () => {
	const holder = [];
	const { deps: d, calls } = deps({ runContainer: async () => ({ code: 137, aborted: true, checkpoint: checkpointHandle(holder) }) });
	const r = await runJob(job, d);
	assert.deepEqual([r.outcome, r.reason], ["policy", "worker-abort"]);
	assert.ok(!holder.some((c) => c[0] === "cp-exit"));
	assert.ok(!names(calls).includes("enqueue"));
});

// Issue #686 part 3, review round 2 of #714: a venue whose box was not confirmed gone after the run (`lingering`).
test("a lingering box: no exit checkpoint on any exit; a forge infra exit still recovers, from the last committed checkpoint", async () => {
	const holder = [];
	const { deps: d, calls } = deps({ runContainer: async () => ({ code: 1, aborted: false, lingering: true, checkpoint: checkpointHandle(holder) }) });
	const r = await runJob(job, d);
	assert.equal(r.reason, RECOVERY_ENQUEUED, "infrastructure as before: the retry or recovery gets a fresh tree");
	assert.ok(!holder.some((c) => c[0] === "cp-exit"), "no snapshot of a tree something may still write");
	assert.ok(holder.some((c) => c[0] === "cp-close"), "the handle WAS consulted, so the no-exit assertion is not vacuous");
	assert.ok(names(calls).includes("enqueue"));
});

test("a lingering box (CONST-RETRY-INFRA-ONLY): a completed run and a folder job's infra exit RETURN the named result; exit 2 keeps its own", async () => {
	const { OPENSHELL_BIND_LINGERING } = await import("../src/backends.mjs");
	for (const [code, kindJob] of [[0, job], [1, { ...job, kind: "local", recover: false }], [7, { ...job, kind: "local", recover: false }]]) {
		const holder = [];
		const { deps: d, calls } = deps({ runContainer: async () => ({ code, aborted: false, lingering: true, checkpoint: checkpointHandle(holder) }) });
		const r = await runJob(kindJob, d);
		assert.deepEqual([r.outcome, r.reason, r.exitCode, r.budgetReserved], ["policy", OPENSHELL_BIND_LINGERING.reason, code, true], `exit ${code} on ${kindJob.kind}`);
		assert.ok(calls.some((c) => c[0] === "comment" && c[1] === OPENSHELL_BIND_LINGERING.comment), "its fixed comment");
		assert.ok(!names(calls).includes("enqueue"), "never a second agent on that tree");
		assert.ok(!holder.some((c) => c[0] === "cp-exit"));
	}
	const { deps: d } = deps({ runContainer: async () => ({ code: 2, aborted: false, lingering: true }) });
	const r = await runJob(job, d);
	assert.equal(r.outcome, "policy");
	assert.notEqual(r.reason, OPENSHELL_BIND_LINGERING.reason, "a determinate refusal keeps its own reason");
	const stopped = deps({ runContainer: async () => ({ code: 137, aborted: true, lingering: true }) });
	assert.equal((await runJob(job, stopped.deps)).reason, "worker-abort", "a stop stays a stop");
});

test("a container the checkpointer stopped (it could not unpause it) is an infra exit: exit checkpoint, recovery queued", async () => {
	const holder = [];
	const { deps: d, calls } = deps({ runContainer: async () => ({ code: 137, aborted: false, checkpointStopped: true, checkpoint: checkpointHandle(holder) }) });
	const r = await runJob(job, d);
	assert.equal(r.reason, RECOVERY_ENQUEUED);
	assert.ok(holder.some((c) => c[0] === "cp-exit"));
	assert.ok(names(calls).includes("enqueue"));
});

test("close() that answers nothing falls back to the handle's stats() function", async () => {
	const handle = { exit: async () => ({ seq: 1 }), close: async () => null, stats: () => ({ written: 7, failed: 0, skipped: 1 }) };
	const { deps: d } = deps({ runContainer: async () => ({ code: 0, aborted: false, checkpoint: handle }) });
	assert.deepEqual((await runJob(job, d)).checkpoints, { written: 7, failed: 0, skipped: 1 });
});

test("a handle that throws, or none at all, is no exit checkpoint and no failure", async () => {
	const bad = { exit: async () => Promise.reject(new Error("x")), close: async () => Promise.reject(new Error("y")) };
	const a = deps({ runContainer: async () => ({ code: 1, aborted: false, checkpoint: bad }) });
	assert.equal((await runJob(job, a.deps)).reason, RECOVERY_ENQUEUED);
	const b = deps({ runContainer: async () => ({ code: 1, aborted: false }) });
	assert.equal((await runJob(job, b.deps)).reason, RECOVERY_ENQUEUED, "the pointer of a live checkpoint is enough");
});

test("the runner's recovery counts reach the record's recovered, rebuilt", async () => {
	const { deps: d } = deps({ runContainer: async () => ({ code: 0, aborted: false, recovery: { orphans: 3, replayed: 1, interrupted: 1, notStarted: 1, path: "/etc/passwd" } }) });
	const r = await runJob(recoveryJob(2), d);
	const rec = buildRecord({ job: { id: `${RUN}.r2`, data: recoveryJob(2) }, result: r });
	assert.equal(rec.recoveryOf, RUN);
	assert.deepEqual(rec.recovered, { from: "live", n: 2, fromAttempt: 1, checkpointSeq: 4, orphans: 3, replayed: 1, interrupted: 1, notStarted: 1, countsFrom: "exit-line" });
});

test("a recovery with no exit line takes its counts from the transcript, labelled transcript, never into progress (#662)", async () => {
	const progress = { turns: 2, steps: 3, interrupted: 3, replayed: 2, recoveryInterrupted: 2, recoveryNotStarted: 1 };
	const { deps: d } = deps({ runContainer: async () => ({ code: 0, aborted: false, progress }) });
	const r = await runJob(recoveryJob(2), d);
	const rec = buildRecord({ job: { id: `${RUN}.r2`, data: recoveryJob(2) }, result: r });
	assert.deepEqual(rec.recovered, { from: "live", n: 2, fromAttempt: 1, checkpointSeq: 4, orphans: 5, replayed: 2, interrupted: 2, notStarted: 1, countsFrom: "transcript" });
	assert.deepEqual(rec.progress, { turns: 2, steps: 3, interrupted: 3, replayed: 2 }, "the reducer's recovery keys never reach progress");
});

test("the exit line wins over the transcript's counts; a transcript with no mark leaves the counts null (#662)", async () => {
	const progress = { replayed: 9, recoveryInterrupted: 9, recoveryNotStarted: 9 };
	const a = deps({ runContainer: async () => ({ code: 0, aborted: false, progress, recovery: { orphans: 1, replayed: 1, interrupted: 0, notStarted: 0 } }) });
	const ra = buildRecord({ job: { id: `${RUN}.r1`, data: recoveryJob(1) }, result: await runJob(recoveryJob(1), a.deps) });
	assert.deepEqual([ra.recovered.orphans, ra.recovered.replayed, ra.recovered.countsFrom], [1, 1, "exit-line"]);
	const b = deps({ runContainer: async () => ({ code: 0, aborted: false, progress: { turns: 4, steps: 2 } }) });
	const rb = buildRecord({ job: { id: `${RUN}.r1`, data: recoveryJob(1) }, result: await runJob(recoveryJob(1), b.deps) });
	assert.deepEqual(rb.recovered, { from: "live", n: 1, fromAttempt: 1, checkpointSeq: 4, orphans: null, replayed: null, interrupted: null, notStarted: null });
});

// ── local ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("a local job with run.recover is not armed: recoverSkipped local, no ledger, no store, today's run", async () => {
	const { deps: d, calls, ledger } = deps({ prepareWorkspace: async () => ({ workspace: "/f", jobDir: "/j" }) });
	const r = await runJob({ kind: "local", folder: "/f", task: "t", provider: "anthropic", model: "m", recover: true }, d);
	assert.equal(r.outcome, "completed");
	assert.equal(r.recoverSkipped, "local");
	assert.deepEqual(ledger.calls, []);
	assert.ok(!names(calls).includes("primeBase"));
	assert.deepEqual(calls.find((c) => c[0] === "run-container")[1], { recover: false, recovering: false, checkpoint: null });
	assert.equal(buildRecord({ job: { id: "local-1", data: { kind: "local", recover: true } }, result: r }).recoverSkipped, "local");
});

test("a job that never armed run.recover touches none of it and its result has no new key", async () => {
	const { deps: d, ledger, calls } = deps();
	const r = await runJob({ ...job, recover: undefined }, d);
	assert.deepEqual(ledger.calls, []);
	assert.ok(!names(calls).includes("primeBase"));
	for (const k of ["recoverSkipped", "recovered", "checkpoints"]) assert.equal(Object.hasOwn(r, k), false, k);
});

// ── the money property ──────────────────────────────────────────────────────────────────────────────────────────

/** A small seeded PRNG, so a failure names its seed and replays. */
function prng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test("PROPERTY: over random crash points, the dollar keys never exceed (containers started) x cap", async () => {
	const CAP = 2 * USD;
	const steps = ["complete", "policy", "infra", "crash", "recordFail", "seqFail", "neverStarted"];
	// The property must not pass vacuously: enough trials have to reach a recovery and settle a crashed hold.
	let recoveries = 0;
	let crashedSettled = 0;
	for (let seed = 1; seed <= 300; seed++) {
		const rand = prng(seed);
		const redis = keyedRedis();
		const ledger = fakeLedger();
		const store = { alive: true };
		const pointers = new Map();
		let containers = 0;
		let next = { j: { ...job, maxCostMicros: CAP } };
		const trail = [];
		while (next) {
			const current = next;
			next = null;
			const step = steps[Math.floor(rand() * steps.length)];
			trail.push(step);
			const n = current.j.recovery ?? 0;
			const realRecord = ledger._record ?? (ledger._record = ledger.recordHold);
			ledger.recordHold = step === "recordFail" ? async () => ({ error: "valkey" }) : realRecord;
			const realSeq = ledger._seq ?? (ledger._seq = ledger.nextSeq);
			ledger.nextSeq = step === "seqFail" ? async () => ({ error: "valkey" }) : realSeq;
			const tokens = { input: 1, output: 1, total: 2, cost: rand() * 2, metered: true, unresolved: 0, unpriced: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, costCapMicros: CAP, costRefused: 0, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0, costUnreported: 0 };
			const runContainer = async () => {
				containers++;
				pointers.set(RUN, { v: 1, host: HOST, hostQueue: null, seq: containers, attempt: containers, at: 1, jobDir: "job-x" });
				if (step === "crash") throw new Error("the worker died mid-run");
				if (step === "neverStarted") return { code: 125, aborted: false };
				const code = step === "complete" ? 0 : step === "policy" ? 2 : 1;
				return { code, aborted: false, exitLineCode: code, tokens };
			};
			const enqueueRecovery = async () => (n + 1 <= RECOVERY_CAP ? ((next = { j: { ...job, maxCostMicros: CAP, recoveryOf: RUN, recovery: n + 1 } }), { enqueued: true, jobId: `${RUN}.r${n + 1}`, n: n + 1 }) : { enqueued: false, reason: "cap" });
			const { deps: d } = deps({
				redis,
				dollarCaps: { day: 1000 * USD, week: null, month: null },
				runBudgetLedger: ledger,
				runContainer,
				enqueueRecovery,
				readCheckpointPointer: async ({ runId }) => pointers.get(runId) ?? null,
				removeCheckpointPointer: async ({ runId }) => pointers.delete(runId),
				workspaceCheckpointer: { ...fakeCheckpointer([]), readManifest: async () => (store.alive ? { ok: true, manifest: MANIFEST, transcriptPath: "/t" } : { absent: true }), remove: async () => ((store.alive = false), { removed: true }) },
			});
			if (current.j.recoveryOf) recoveries++;
			const settleCrashed = ledger.settleCrashed;
			ledger.settleCrashed = async (...a) => {
				const r = await settleCrashed(...a);
				crashedSettled += r.settled.length;
				return r;
			};
			try {
				await runJob(current.j, d);
			} catch {
				// A crash (the worker died) is continued by the stall path's recovery, as start.mjs would enqueue it; a
				// never-started or ledger fault is BullMQ's retry of the same attempt.
				if (step === "crash" && n + 1 <= RECOVERY_CAP && pointers.has(RUN)) next = { j: { ...job, maxCostMicros: CAP, recoveryOf: RUN, recovery: n + 1 } };
				else if (["recordFail", "seqFail", "neverStarted"].includes(step) && trail.length < 8) next = current;
			}
			const total = redis.store.get(DAY) ?? 0;
			assert.ok(total >= 0, `seed ${seed}: a negative window (${trail.join(",")})`);
			assert.ok(total <= containers * CAP, `seed ${seed}: ${total} > ${containers} x ${CAP} after ${trail.join(",")}`);
			ledger.settleCrashed = settleCrashed;
		}
	}
	assert.ok(recoveries > 50, `only ${recoveries} recoveries ran`);
	assert.ok(crashedSettled > 10, `only ${crashedSettled} crashed holds settled`);
});

test("a recovery asks for a salvage checkpoint after the pointer read and before the manifest read; a failing one is not fatal", async () => {
	const { deps: d, calls } = deps({ salvageCheckpoint: async (args) => (calls.push(["salvage", args.runId, args.attempt, args.pointer.jobDir]), { seq: 5 }) });
	const r = await runJob(recoveryJob(1), d);
	assert.equal(r.outcome, "completed");
	const order = names(calls).filter((n) => ["readPointer", "salvage", "readManifest"].includes(n));
	assert.deepEqual(order, ["readPointer", "salvage", "readManifest"]);
	assert.deepEqual(calls.find((c) => c[0] === "salvage").slice(1), [RUN, 1, "job-abc"]);
	const bad = deps({ salvageCheckpoint: async () => Promise.reject(new Error("x")) });
	assert.equal((await runJob(recoveryJob(1), bad.deps)).outcome, "completed");
	const fresh = deps({ salvageCheckpoint: async () => (calls.push(["salvage-fresh"]), { seq: 1 }) });
	await runJob(job, fresh.deps);
	assert.ok(!names(calls).includes("salvage-fresh"), "a fresh run never salvages");
});

// ── review round 1 ──────────────────────────────────────────────────────────────────────────────────────────────

test("the base-running check excludes the recovery's own entry, with the REAL running-jobs list", async () => {
	const ran = async (current, held) => {
		const runningJobs = makeRunningJobs();
		for (const id of held) runningJobs.add({ id });
		const { deps: d, calls } = deps({ runningJobs });
		try {
			await runJob(recoveryJob(current), d);
			return names(calls).includes("run-container") ? "ran" : "other";
		} catch (e) {
			return e instanceof RecoveryWaitHold ? "waits" : "threw";
		}
	};
	assert.equal(await ran(1, [`${RUN}.r1`]), "ran", "only itself: proceeds");
	assert.equal(await ran(1, [`${RUN}.r1`, RUN]), "waits", "the base is running here");
	assert.equal(await ran(2, [`${RUN}.r2`, `${RUN}.r1`]), "waits", "an earlier recovery is still running here");
	assert.equal(await ran(2, [`${RUN}.r2`, "other-job"]), "ran");
});

test("a fresh run whose base holds .pi/extensions is not armed: no ledger, no prime, no checkpoint args, recoverSkipped workspace-extensions", async () => {
	const { deps: d, calls, ledger } = deps({ baseHasExtensions: async () => true });
	const r = await runJob(job, d);
	assert.equal(r.outcome, "completed");
	assert.equal(r.recoverSkipped, "workspace-extensions");
	assert.deepEqual(ledger.calls, []);
	assert.ok(!names(calls).includes("primeBase"));
	assert.deepEqual(calls.find((c) => c[0] === "run-container")[1], { recover: false, recovering: false, checkpoint: null });
	assert.ok(!names(calls).includes("store-remove"), "not armed: no durable cleanup either");
	assert.equal(buildRecord({ job: { id: RUN, data: job }, result: r }).recoverSkipped, "workspace-extensions");
	// An infra exit of such a run is today's retry, never a recovery.
	const b = deps({ baseHasExtensions: async () => true, runContainer: async () => ({ code: 1, aborted: false }) });
	await assert.rejects(runJob(job, b.deps), (e) => e instanceof InfraRetry && e.recoverSkipped === "workspace-extensions");
	assert.ok(!names(b.calls).includes("enqueue"));
	// A base that could not be read is not armed either (fail closed), and says base-unprimed.
	const c = deps({ baseHasExtensions: async () => Promise.reject(new Error("x")) });
	const rc = await runJob(job, c.deps);
	assert.equal(rc.recoverSkipped, "base-unprimed");
	assert.deepEqual(c.ledger.calls, []);
});

test("a recovery of a base with .pi/extensions is refused as recovery-unsafe-extensions, before the restore and any reserve", async () => {
	const { deps: d, calls, redis } = deps({ baseHasExtensions: async () => true });
	const r = await runJob(recoveryJob(1), d);
	assert.deepEqual([r.outcome, r.reason], ["policy", "recovery-unsafe-extensions"]);
	assert.ok(calls.some((c) => c[0] === "comment" && c[1] === RECOVERY_COMMENTS["recovery-unsafe-extensions"]));
	assert.ok(!names(calls).includes("restore"));
	assert.equal(redis.ops.filter((o) => o[0] === "incr").length, 0);
});

test("every never-started fault of a RECOVERY job becomes a 60 s wait hold, never a spent attempt", async () => {
	const cases = {
		"pointer read throws": { readCheckpointPointer: async () => Promise.reject(new Error("x")) },
		"claimSlot error": { runBudgetLedger: fakeLedger({ fail: { claimSlot: true } }) },
		"nextSeq error, no dollar windows": { runBudgetLedger: fakeLedger({ fail: { nextSeq: true } }) },
		"recordHold error": { runBudgetLedger: fakeLedger({ fail: { recordHold: true } }), dollarCaps: { day: 10 * USD, week: null, month: null } },
		"restore skipped": { workspaceCheckpointer: fakeCheckpointer([], { restore: { skipped: "locked" } }) },
		"trust reset failed": { resetTrustPaths: async () => Promise.reject(new Error("x")) },
		"staging failed": { stageRecovered: async () => null },
		"store fetch failed": { prepareWorkspace: async () => Promise.reject(new InfraRetry("prepare-github: the checkpoint store's base commit could not be fetched", { reason: "container-never-started" })) },
		"extensions unreadable": { baseHasExtensions: async () => Promise.reject(new Error("x")) },
		"exit 125": { runContainer: async () => ({ code: 125, aborted: false }) },
	};
	for (const [name, over] of Object.entries(cases)) {
		const { deps: d } = deps(over);
		await assert.rejects(runJob({ ...recoveryJob(1), maxCostMicros: 2 * USD }, d), (e) => e instanceof RecoveryWaitHold && e.recoveryWaitMs === RECOVERY_RETRY_WAIT_MS && e.reason === "container-never-started", name);
	}
	// The pointer missing beside a store still there, too.
	const m = deps();
	m.pointers.clear();
	await assert.rejects(runJob(recoveryJob(1), m.deps), (e) => e instanceof RecoveryWaitHold && e.recoveryWaitMs === RECOVERY_RETRY_WAIT_MS);
	// A FRESH job's never-started fault stays an ordinary retry: it has its attempts.
	const f = deps({ runBudgetLedger: fakeLedger({ fail: { nextSeq: true } }) });
	await assert.rejects(runJob(job, f.deps), (e) => e instanceof InfraRetry && !(e instanceof RecoveryWaitHold) && e.reason === "container-never-started");
});

test("a pointer read that THROWS with the store absent is a wait hold, never recovery-superseded", async () => {
	const { deps: d, calls } = deps({ readCheckpointPointer: async () => Promise.reject(new Error("x")), workspaceCheckpointer: fakeCheckpointer([], { manifest: null }) });
	await assert.rejects(runJob(recoveryJob(1), d), (e) => e instanceof RecoveryWaitHold);
	assert.ok(!names(calls).includes("comment"));
});

test("a recovery whose container ran and ended infra, with no further recovery queued, RETURNS recovery-failed with its comment", async () => {
	// The pointer is there for the gates, and gone after the exit (nothing to continue from).
	let reads = 0;
	const pointerOnce = async () => (reads++ === 0 ? { v: 1, host: HOST, hostQueue: null, seq: 4, attempt: 1, at: 1, jobDir: "job-abc" } : null);
	for (const over of [{ enqueueRecovery: async () => ({ enqueued: false, reason: "cap" }) }, { readCheckpointPointer: pointerOnce }]) {
		const { deps: d, calls } = deps({ runContainer: async () => ({ code: 1, aborted: false }), ...over });
		const r = await runJob(recoveryJob(2), d);
		assert.deepEqual([r.outcome, r.reason, r.exitCode], ["failed", "recovery-failed", 1]);
		assert.ok(calls.some((c) => c[0] === "comment" && c[1] === RECOVERY_COMMENTS["recovery-failed"]));
		assert.ok(names(calls).includes("store-remove"), "the run's final outcome cleans up");
	}
	// One that WAS queued returns recovery-enqueued as the base does.
	const q = deps({ runContainer: async () => ({ code: 1, aborted: false }) });
	assert.equal((await runJob(recoveryJob(1), q.deps)).reason, RECOVERY_ENQUEUED);
});

test("a settled base record supersedes a recovery FIRST, before the pointer and store logic, silently and without cleanup", async () => {
	const seen = [];
	const readRecord = async (id) => (seen.push(id), id === RUN ? { jobId: RUN, outcome: "completed" } : null);
	// The half-failed cleanup: pointer deleted, store still there.
	const { deps: d, calls, pointers } = deps({ readRecord });
	pointers.clear();
	const r = await runJob(recoveryJob(2), d);
	assert.deepEqual([r.outcome, r.reason], ["policy", "recovery-superseded"]);
	assert.ok(!names(calls).includes("readPointer"), "decided before the pointer");
	assert.ok(!names(calls).includes("comment"));
	assert.ok(!names(calls).some((n) => n === "store-remove" || n === "pointer-remove"));
	assert.deepEqual(seen, [RUN]);
	// An earlier recovery's settled record counts too; a failed (recovery-enqueued) one does not.
	const r1 = deps({ readRecord: async (id) => (id === `${RUN}.r1` ? { jobId: id, outcome: "policy" } : id === RUN ? { jobId: RUN, outcome: "failed", reason: RECOVERY_ENQUEUED } : null) });
	assert.equal((await runJob(recoveryJob(2), r1.deps)).reason, "recovery-superseded");
	const notYet = deps({ readRecord: async (id) => (id === RUN ? { jobId: RUN, outcome: "failed", reason: RECOVERY_ENQUEUED } : null) });
	assert.equal((await runJob(recoveryJob(1), notYet.deps)).outcome, "completed");
	// A record under another id (sanitised names collide) is not this run's.
	const other = deps({ readRecord: async () => ({ jobId: "someone-else", outcome: "completed" }) });
	assert.equal((await runJob(recoveryJob(1), other.deps)).outcome, "completed");
});

test("a fresh or retried armed attempt never calls settleCrashed", async () => {
	const ledger = fakeLedger();
	for (let i = 0; i < 2; i++) {
		const { deps: d } = deps({ runBudgetLedger: ledger });
		await runJob(job, d).catch(() => {});
	}
	assert.ok(ledger.calls.some((c) => c[0] === "nextSeq"));
	assert.ok(!ledger.calls.some((c) => c[0] === "settleCrashed"));
});

test("a never-started throw whose ledger release answers 'not-held' gives nothing back: the floor", async () => {
	const ledger = fakeLedger();
	ledger.release = async () => "not-held";
	const { deps: d, redis } = deps({ runBudgetLedger: ledger, dollarCaps: { day: 10 * USD, week: null, month: null }, runContainer: async () => ({ code: 125, aborted: false }) });
	await assert.rejects(runJob({ ...job, maxCostMicros: 2 * USD }, d), (e) => e instanceof InfraRetry && e.dollars?.basis === "floor");
	assert.equal(redis.store.get(DAY), 2 * USD, "no window key moved back");
	assert.ok(!redis.ops.some((o) => o[1] === DAY && o[0] !== "incrby"), "no release op on the window key");
});

test("an OOM-killed armed exit takes no exit checkpoint and queues nothing", async () => {
	const holder = { calls: null };
	const { deps: d, calls } = deps({ runContainer: async () => ({ code: 137, aborted: false, exitOomKilled: true, exitAuth: "verified", memoryLimit: 100, resources: { memPeak: 95, oomKills: 1 }, checkpoint: checkpointHandle(holder.calls) }) });
	holder.calls = calls;
	const r = await runJob(job, d);
	assert.equal(r.outcome, "policy");
	assert.ok(names(calls).includes("cp-close"));
	assert.ok(!names(calls).includes("cp-exit"));
	assert.ok(!names(calls).includes("enqueue"));
});

test("recovered.from is the manifest's kind: exit and salvage", async () => {
	for (const kind of ["exit", "salvage"]) {
		const { deps: d } = deps({ workspaceCheckpointer: fakeCheckpointer([], { manifest: { ...MANIFEST, kind, seq: 7, attempt: 3 } }) });
		const r = await runJob(recoveryJob(1), d);
		assert.deepEqual([r.recovered.from, r.recovered.checkpointSeq, r.recovered.fromAttempt], [kind, 7, 3]);
	}
});

test("a refusal after a carried slot reports budgetReserved true", async () => {
	const ledger = fakeLedger();
	await ledger.claimSlot(RUN);
	const { deps: d } = deps({ runBudgetLedger: ledger, dollarCaps: { day: 1 * USD, week: null, month: null } });
	const r = await runJob({ ...job, maxCostMicros: 2 * USD }, d);
	assert.deepEqual([r.outcome, r.reason, r.budgetReserved], ["policy", "dollar-cap", true]);
});
