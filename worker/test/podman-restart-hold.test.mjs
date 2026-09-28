import assert from "node:assert/strict";
import { test } from "node:test";
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
	assert.deepEqual(updates.map((d) => d.podmanRestartHoldSinceMs), [NOW], "the hold's start is stored on the job");
	assert.deepEqual([seen.containerCalls, seen.incr, seen.records.length], [0, 0, 0], "nothing started, reserved or recorded per deferral");
	assert.deepEqual(seen.logs.filter((l) => l.event === "podman_restart_hold").map((l) => [l.heldForMs, l.delayMs]), [[0, 60_000]]);
	// The next pickup, 59 minutes into the hold: delayed again, the stored start kept, not rewritten.
	const later = harness({ now: () => NOW + PODMAN_RESTART_HOLD_MAX_MS - 60_000 });
	await assert.rejects(() => later.processor(job, "tok2", new AbortController().signal), (err) => err.name === "DelayedError");
	assert.equal(moves.length, 2);
	assert.equal(updates.length, 1, "the stored start is not rewritten");
});

test("a hold past an hour fails the job for good with its own reason token, recorded once (#448)", { skip }, async () => {
	const { job, moves } = spyJob({ kind: "local", folder: "/srv/site", flow: "tidy", task: "t", podmanRestartHoldSinceMs: NOW });
	assert.equal(PODMAN_RESTART_HOLD_MAX_MS, 3_600_000);
	const { processor, seen } = harness({ now: () => NOW + PODMAN_RESTART_HOLD_MAX_MS });
	await assert.rejects(
		() => processor(job, "tok", new AbortController().signal),
		(err) => err.name === "UnrecoverableError" && err.reason === PODMAN_RESTART_HOLD_EXPIRED && /^held 60 min for rootful Podman's service to restart, and it did not: rootful Podman's service may still hold/.test(err.message),
	);
	assert.deepEqual([moves.length, seen.containerCalls, seen.records.length], [0, 0, 1]);
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
