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

const USED = { memPeak: 2147483648, swapPeak: 0, oomKills: 0, memSomeUsec: 1, memFullUsec: 0, cpuUsec: 600000000, throttledUsec: 5, throttled: 1, pidsPeak: 40 };

function harness(runContainer, { cancelReq = undefined, redisOver = {}, depsOver = {} } = {}) {
	const records = [];
	const logs = [];
	const redis = { incr: async () => 1, decr: async () => 0, expire: async () => {}, ...redisOver };
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
			...depsOver,
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
	// Issue #644: the run's progress summary survives the same rebuild, beside the resources.
	const PROGRESS = { turns: 3, steps: 2, interrupted: 1, longestInterruptedMs: 900 };
	const { processor, records, logs } = harness(async () => ({ code: 1, aborted: false, turns: 1, resources: USED, progress: PROGRESS }), { cancelReq: "1" });
	const result = await processor(job(), "tok", new AbortController().signal);
	assert.equal(result.reason, "operator-cancel");
	assert.ok(logs.some((l) => l.event === "job_cancelled_instead_of_retry" && l.spent === true), "the conversion path, not the raced exit");
	assert.deepEqual(records.at(-1).result.resources, USED);
	assert.deepEqual(records.at(-1).result.progress, PROGRESS);
});

test("a verified line whose provider failure could not be recorded keeps what the job said, with the image: `absent` would be false (#800)", { skip }, async () => {
	const IMAGE = { ok: true, image: "pi-job:4.3.1", imageDigest: `sha256:${"a".repeat(64)}`, piVersion: "1.5.0", capabilities: ["exitAuth"] };
	const LOADED = { v: 1, runner: "reported", at: "ready", cut: null, image: null, imageDigest: null, imagePi: null, pi: "1.5.0", flow: null, sources: [], mcp: [], tools: { active: 3, own: ["read"], job: [] }, problems: { failed: 0, dropped: 0, mcp: 0 }, leftOut: null };
	const ran = async () => ({ code: 1, aborted: false, exitAuth: "verified", exitLineCode: 1, turns: 1, providerFailure: { kind: "quota-exhausted" }, loaded: LOADED });
	const blip = async () => {
		throw new Error("valkey blip");
	};
	const { processor, records } = harness(ran, { redisOver: { set: blip, psetex: blip, pexpire: blip, eval: blip, hset: blip, mget: async () => [], get: async () => null, del: blip, sadd: blip, smembers: async () => [] }, depsOver: { imagePreflight: async () => IMAGE } });
	await assert.rejects(() => processor(job(), "tok", new AbortController().signal), (error) => error.name === "InfraRetry" && error.message === "the provider failure could not be recorded");
	const { buildRecord } = await import("../src/run-history.mjs");
	const record = buildRecord(records.at(-1));
	assert.equal(record.reason, "container-infra-exit");
	assert.equal(record.loaded.runner, "reported");
	assert.equal(record.loaded.at, "ready");
	assert.deepEqual([record.loaded.pi, record.loaded.tools.active], ["1.5.0", 3]);
	assert.deepEqual([record.loaded.image, record.loaded.imageDigest, record.loaded.imagePi], [IMAGE.image, IMAGE.imageDigest, "1.5.0"]);
});

test("a cancel read only when a spent attempt fails keeps what that attempt loaded through the same rebuild (#800)", { skip }, async () => {
	const LOADED = { v: 1, runner: "absent", at: null, cut: null, image: null, imageDigest: null, imagePi: null, pi: null, flow: null, sources: [], mcp: null, tools: null, problems: null, leftOut: { tools: ["bash"], packages: false, overlayExtensions: false, restricted: false } };
	const { processor, records } = harness(async () => ({ code: 1, aborted: false, turns: 1, loaded: LOADED }), { cancelReq: "1" });
	const result = await processor(job(), "tok", new AbortController().signal);
	assert.equal(result.reason, "operator-cancel");
	assert.deepEqual(records.at(-1).result.loaded, LOADED);
});
