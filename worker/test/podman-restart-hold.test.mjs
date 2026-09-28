import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecord } from "../src/run-history.mjs";
import { PODMAN_RESTART_HOLD_EXPIRED, PODMAN_RESTART_HOLD_MAX_MS, PODMAN_RESTART_HOLD_RECHECK_MS } from "../src/runtime-observations.mjs";

// Issue #448, gate round 2 of PR #473: a local job held until rootful Podman's service restarts is moved back to the
// delayed set WITHOUT spending an attempt, every PODMAN_RESTART_HOLD_RECHECK_MS, until the hold has lasted
// PODMAN_RESTART_HOLD_MAX_MS; then it fails for good with its own reason token. index.mjs imports bullmq, so these skip
// below the node floor and hard-fail in CI, as pause-gate.test.mjs does.
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`podman-restart-hold tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

const NOW = Date.UTC(2026, 8, 28, 12, 0);
const EVIDENCE = "/etc/containers/containers.conf.d/zz.conf was removed after the running podman.service started, and a running Podman service keeps the containers.conf it started with, so a key removed since may still reach every local job";

function spyJob(data) {
	const moves = [];
	const updates = [];
	const job = {
		id: "local-hold",
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

function harness({ now = () => NOW, observed = { ok: true, podmanConfRefused: { reason: "podman-conf-widens-job", key: null, rootful: true, restart: true, retry: true, message: "Not run yet: ...", evidence: EVIDENCE } } } = {}) {
	const seen = { containerCalls: 0, records: [], logs: [], incr: 0 };
	const redis = { incr: async () => (seen.incr++, 1), decr: async () => 0, expire: async () => {} };
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		now,
		recordRun: (r) => seen.records.push(r),
		timeoutMs: 100000,
		deps: {
			observationPreflight: async () => observed,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => (seen.containerCalls++, { code: 0, aborted: false, turns: 1 }),
			cleanup: async () => {},
			comment: async () => {},
			log: (event, fields) => seen.logs.push({ event, ...fields }),
		},
	});
	return { processor, seen };
}

test("a job held for podman.service's restart is delayed a minute without an attempt, and its hold start is kept (#448)", { skip }, async () => {
	const { job, moves, updates } = spyJob({ kind: "local", folder: "/srv/site", flow: "tidy", task: "t" });
	const { processor, seen } = harness();
	await assert.rejects(() => processor(job, "the-token", new AbortController().signal), (err) => err.name === "DelayedError");
	assert.deepEqual(moves, [{ ts: NOW + PODMAN_RESTART_HOLD_RECHECK_MS, tok: "the-token" }], "one minute on, with the worker's token");
	assert.equal(PODMAN_RESTART_HOLD_RECHECK_MS, 60_000);
	assert.deepEqual(updates.map((d) => [d.podmanRestartHoldSinceMs, d.podmanRestartHoldLastMs]), [[NOW, NOW]], "the hold's start and its last check are stored on the job");
	assert.deepEqual([seen.containerCalls, seen.incr, seen.records.length], [0, 0, 0], "nothing started, reserved or recorded per deferral");
	assert.deepEqual(seen.logs.filter((l) => l.event === "podman_restart_hold").map((l) => [l.heldForMs, l.delayMs]), [[0, 60_000]]);
	// The next pickup, on time: delayed again, the stored start kept.
	const later = harness({ now: () => NOW + 60_000 });
	await assert.rejects(() => later.processor(job, "tok2", new AbortController().signal), (err) => err.name === "DelayedError");
	assert.equal(moves.length, 2);
	assert.deepEqual(updates.at(-1).podmanRestartHoldSinceMs, NOW, "the stored start is kept while the checks come on time");
	assert.deepEqual(later.seen.logs.filter((l) => l.event === "podman_restart_hold").map((l) => l.heldForMs), [60_000]);
});

test("a hold that comes back after a gap (a paused queue, no worker running) starts its hour afresh (#448)", { skip }, async () => {
	// Gate round 3 of PR #473 (raw 51): the hour kept counting through `pi-dispatch pause`.
	const { job, updates } = spyJob({ kind: "local", folder: "/srv/site", flow: "tidy", task: "t", podmanRestartHoldSinceMs: NOW - 50 * 60_000, podmanRestartHoldLastMs: NOW - 2 * PODMAN_RESTART_HOLD_RECHECK_MS - 1 });
	const { processor, seen } = harness();
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (err) => err.name === "DelayedError");
	assert.deepEqual([updates[0].podmanRestartHoldSinceMs, updates[0].podmanRestartHoldLastMs], [NOW, NOW], "the start is reset");
	assert.equal(seen.logs.find((l) => l.event === "podman_restart_hold").heldForMs, 0);
	// Exactly two recheck periods late is still on time: the start is kept.
	const onTime = spyJob({ kind: "local", folder: "/srv/site", flow: "tidy", task: "t", podmanRestartHoldSinceMs: NOW - 50 * 60_000, podmanRestartHoldLastMs: NOW - 2 * PODMAN_RESTART_HOLD_RECHECK_MS });
	await assert.rejects(() => harness().processor(onTime.job, "tok", new AbortController().signal), (err) => err.name === "DelayedError");
	assert.equal(onTime.updates[0].podmanRestartHoldSinceMs, NOW - 50 * 60_000);
});

test("a hold past an hour fails the job for good with its own reason token, recorded once (#448)", { skip }, async () => {
	const { job, moves } = spyJob({ kind: "local", folder: "/srv/site", flow: "tidy", task: "t", podmanRestartHoldSinceMs: NOW, podmanRestartHoldLastMs: NOW + PODMAN_RESTART_HOLD_MAX_MS - 60_000 });
	assert.equal(PODMAN_RESTART_HOLD_MAX_MS, 3_600_000);
	const { processor, seen } = harness({ now: () => NOW + PODMAN_RESTART_HOLD_MAX_MS });
	await assert.rejects(
		() => processor(job, "tok", new AbortController().signal),
		(err) => err.name === "UnrecoverableError" && err.reason === PODMAN_RESTART_HOLD_EXPIRED && /^held 60 min for rootful Podman's service to restart, and it did not: rootful Podman's service may still hold/.test(err.message),
	);
	assert.deepEqual([moves.length, seen.containerCalls, seen.records.length], [0, 0, 1]);
	// Gate round 3 of PR #473 (raw 50): recorded with the token its comment and hook carry, not container-never-started.
	assert.deepEqual([seen.records[0].error.reason, seen.records[0].error.budgetReserved], [PODMAN_RESTART_HOLD_EXPIRED, false]);
	const record = buildRecord(seen.records[0]);
	assert.deepEqual([record.outcome, record.reason], ["failed", "podman-service-restart-hold-expired"], "the run record's reason");
});

test("a job the service no longer holds runs, and a moment's failed read is still the queue's ordinary retry (#448)", { skip }, async () => {
	const ran = spyJob({ kind: "local", folder: "/srv/site", flow: "tidy", task: "t", podmanRestartHoldSinceMs: NOW - 600_000 });
	const clear = harness({ observed: { ok: true } });
	const result = await clear.processor(ran.job, "tok", new AbortController().signal);
	assert.deepEqual([result.outcome, ran.moves.length, clear.seen.containerCalls], ["completed", 0, 1]);
	const busy = spyJob({ kind: "local", folder: "/srv/site", flow: "tidy", task: "t" });
	const transient = harness({ observed: { ok: true, podmanConfRefused: { reason: "podman-conf-widens-job", key: null, rootful: true, transient: true, message: "Not read yet: ...", evidence: "/etc/containers/containers.conf could not be read (EMFILE)" } } });
	await assert.rejects(() => transient.processor(busy.job, "tok", new AbortController().signal), (err) => err.name === "InfraRetry" && err.holdUntilRestart === undefined);
	assert.equal(busy.moves.length, 0, "no deferral: the queue's attempts retry it");
});
