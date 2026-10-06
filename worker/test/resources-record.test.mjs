import assert from "node:assert/strict";
import { test } from "node:test";

// Issue #596: what a container used reaches the run record through the real processor wiring (index.mjs makeProcessor),
// including an operator's cancel acknowledged while the container ran, which rebuilds the result from the error.
// index.mjs imports bullmq, so these skip below the node floor and hard-fail in CI, as pause-gate.test.mjs does.
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`resources-record tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

const USED = { memPeak: 2147483648, oomKills: 0, memSomeUsec: 1, memFullUsec: 0, cpuUsec: 600000000, throttledUsec: 5, throttled: 1, pidsPeak: 40 };

function harness(runContainer, { cancelReq = undefined } = {}) {
	const records = [];
	const logs = [];
	const redis = { incr: async () => 1, decr: async () => 0, expire: async () => {} };
	if (cancelReq !== undefined) {
		const keys = new Map([["cancel:req:local-r", cancelReq]]);
		Object.assign(redis, { get: async (k) => keys.get(k) ?? null, set: async (k, v) => (keys.set(k, v), "OK"), del: async (k) => (keys.delete(k), 1) });
	}
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		now: () => Date.UTC(2026, 9, 6, 12, 0),
		recordRun: (r) => records.push(r),
		timeoutMs: 100000,
		deps: {
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer,
			cleanup: async () => {},
			comment: async () => {},
			log: (event, fields) => logs.push({ event, ...fields }),
		},
	});
	return { processor, records, logs };
}

const job = () => ({ id: "local-r", attemptsMade: 0, name: "local", data: { kind: "local", folder: "/srv/site", flow: "tidy", task: "t" }, moveToDelayed: async () => {}, updateData: async () => {} });

test("a completed run's record carries its resources", { skip }, async () => {
	const { processor, records } = harness(async () => ({ code: 0, aborted: false, turns: 1, resources: USED }));
	const result = await processor(job(), "tok", new AbortController().signal);
	assert.equal(result.outcome, "completed");
	assert.deepEqual(records.at(-1).result.resources, USED);
});

test("a cancel acknowledged while the container ran keeps what that container used", { skip }, async () => {
	const ac = new AbortController();
	// The container exits 1 on its own after the operator's cancel was acknowledged: the job ends as the cancel, and the
	// spent attempt's resources stay with it, beside its tokens and dollars.
	const { processor, records } = harness(async () => {
		ac.abort("operator-cancel");
		return { code: 1, aborted: false, turns: 1, resources: USED };
	});
	const result = await processor(job(), "tok", ac.signal);
	assert.equal(result.reason, "operator-cancel");
	assert.deepEqual(result.resources, USED);
	assert.deepEqual(records.at(-1).result?.resources ?? records.at(-1).error?.resources, USED);
});

test("a cancel read only when a spent attempt fails ends as the cancel and keeps that attempt's resources", { skip }, async () => {
	// The request is already waiting when the container exits 1, so the job ends as the cancel instead of retrying
	// (INT-CANCEL-CHANNEL-CONTRACT), with the result rebuilt from the InfraRetry: its resources must survive that rebuild.
	const { processor, records, logs } = harness(async () => ({ code: 1, aborted: false, turns: 1, resources: USED }), { cancelReq: "1" });
	const result = await processor(job(), "tok", new AbortController().signal);
	assert.equal(result.reason, "operator-cancel");
	assert.ok(logs.some((l) => l.event === "job_cancelled_instead_of_retry" && l.spent === true), "the conversion path, not the raced exit");
	assert.deepEqual(records.at(-1).result.resources, USED);
});
