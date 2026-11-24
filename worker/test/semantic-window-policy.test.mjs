import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { InfraRetry, RECOVERY_ENQUEUED, RECOVERY_SUPERSEDED } from "../src/processor.mjs";
import { semanticWindowDisposition, shouldReleaseSemanticWindow } from "../src/semantic-window-policy.mjs";
import { makeFindSecretBundle } from "../src/triggers-file.mjs";
import { cancelReqKey, cancelAckKey } from "../src/cancel-state.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

let makeProcessor;
let importError;
try {
	({ makeProcessor } = await import("../src/index.mjs"));
} catch (error) {
	importError = error;
}
if (!makeProcessor && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`semantic-window lifecycle tests are REQUIRED here but the worker could not import.\n${importError}`);
}
const skip = makeProcessor ? false : `worker dependencies unavailable (node ${process.version}); CI runs these`;
const NOW = Date.UTC(2026, 10, 15, 12);

test("the window follows the terminal policy class, including future refusal reasons and paid cancels", () => {
	for (const reason of ["secret-bundle-trigger-changed", "operator-cancel", "agent-cancel", "future-policy-gate", "runner-policy"]) {
		for (const budgetReserved of [false, true, null]) {
			assert.equal(shouldReleaseSemanticWindow({ outcome: "policy", reason, budgetReserved }), true, `${reason}/${budgetReserved}`);
		}
	}
	// The exclusions are lifecycle handoffs, pinned to the processor's tokens, not a catalogue of refusals.
	for (const reason of [RECOVERY_ENQUEUED, RECOVERY_SUPERSEDED]) {
		assert.equal(shouldReleaseSemanticWindow({ outcome: "policy", reason }), false, reason);
	}
	for (const result of [null, undefined, false, "policy", [], {}, { outcome: "completed", reason: "operator-cancel" }, { outcome: "failed", reason: "operator-cancel" }, { outcome: "policy" }, { outcome: "policy", reason: "" }, { outcome: "policy", reason: " " }, { outcome: "policy", reason: "bad\nreason" }, { outcome: "policy", reason: "x".repeat(65) }]) {
		assert.equal(shouldReleaseSemanticWindow(result), false, JSON.stringify(result));
	}
});

test("ingress can distinguish malformed policy results from retained legacy return values", () => {
	for (const result of [{ outcome: "policy" }, { outcome: "policy", reason: null }, { outcome: "policy", reason: 7 }, { outcome: "policy", reason: "" }, { outcome: "policy", reason: "not a token" }, { outcome: "policy", reason: "x".repeat(65) }]) {
		assert.equal(semanticWindowDisposition(result), "invalid", JSON.stringify(result));
		assert.equal(shouldReleaseSemanticWindow(result), false, "worker cleanup keeps its terminal outcome and the window");
	}
	for (const result of [null, undefined, false, 0, "done", [], {}, { outcome: "completed" }, { outcome: "failed" }, { outcome: "new-outcome" }, { outcome: "policy", reason: RECOVERY_ENQUEUED }, { outcome: "policy", reason: RECOVERY_SUPERSEDED }]) {
		assert.equal(semanticWindowDisposition(result), "retain", JSON.stringify(result));
	}
	assert.equal(semanticWindowDisposition({ outcome: "policy", reason: "future-policy-gate" }), "release");
});

function harness({ deps = {}, options = {}, data = {}, jobFields = {}, controller = new AbortController() } = {}) {
	const ops = [];
	const records = [];
	const logs = [];
	const keys = new Map();
	const redis = {
		incr: async () => (ops.push("reserve"), 1),
		decr: async () => (ops.push("release-hold"), 0),
		expire: async () => {},
		get: async (key) => keys.get(key) ?? null,
		set: async (key, value) => (keys.set(key, value), "OK"),
		del: async (key) => (keys.delete(key), 1),
	};
	const job = {
		id: "gh-window-original",
		name: "github",
		attemptsMade: 0,
		opts: { attempts: 2 },
		timestamp: NOW,
		deduplicationId: "acme/site#7:fix",
		data: { kind: "github", repo: "acme/site", target: { type: "issue", number: 7 }, flow: "fix", trigger: { deliveryId: "window-original", matched: { index: 0, type: "label", any: ["fix"] } }, ...data },
		removeDeduplicationKey: async () => (ops.push("release-window"), true),
		moveToDelayed: async () => ops.push("delay"),
		...jobFields,
	};
	const processor = makeProcessor({
		redis,
		now: () => NOW,
		cancelJob: (_id, reason) => controller.abort(reason),
		stopContainer: async () => ops.push("stop"),
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		recordRun: (record) => (ops.push("record"), records.push(record)),
		timeoutMs: 100_000,
		...options,
		deps: {
			now: new Date(NOW),
			mintToken: async () => (ops.push("mint"), "tok"),
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => (ops.push("prepare"), { workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => (ops.push("container"), { code: 0, aborted: false, turns: 1 }),
			cleanup: async () => ops.push("cleanup"),
			comment: async () => ops.push("comment"),
			log: (event, fields) => logs.push({ event, ...fields }),
			...deps,
		},
	});
	return { job, controller, keys, ops, records, logs, run: () => processor(job, "lock-token", controller.signal) };
}

test("a changed secret-bundle trigger releases its window after the actual free refusal, before any paid work", { skip }, async () => {
	const triggersPath = join(tempDir("pi-window-bundle-"), "triggers.json");
	writeFileSync(triggersPath, JSON.stringify({
		triggers: [{ on: { type: "label", any: ["fix"] }, run: { kind: "github", flow: "corrected-fix" } }],
		secretBundles: { site: { profile: "site-env", ref: "site", project: "site" } },
	}));
	const h = harness({
		options: { projects: () => [{ id: "site", members: ["github:acme/site"] }] },
		deps: { findSecretBundle: makeFindSecretBundle({ triggersPath }) },
	});
	const result = await h.run();
	assert.deepEqual([result.outcome, result.reason, result.budgetReserved], ["policy", "secret-bundle-trigger-changed", false]);
	assert.equal(h.ops.filter((op) => op === "release-window").length, 1);
	assert.ok(h.ops.indexOf("record") < h.ops.indexOf("release-window"));
	assert.equal(h.ops.includes("mint"), false);
	assert.equal(h.ops.includes("reserve"), false);
	assert.equal(h.ops.includes("container"), false);
});

test("the outer boundary also covers a future pre-pickup policy gate, after its record", { skip }, async () => {
	const h = harness({ deps: { checkSandboxWorkspace: async () => ({ outcome: "policy", reason: "future-policy-gate" }) } });
	const result = await h.run();
	assert.equal(result.reason, "future-policy-gate");
	// Issue #969: a future gate that forgets its own comment still tells the item, through the refusal net's fixed
	// fallback (the catalog cannot explain a token it does not know), before the window is released.
	assert.deepEqual(h.ops, ["record", "comment", "release-window"]);
});

test("operator and agent cancellation release only after the running attempt finishes cleanup and records", { skip }, async () => {
	for (const reason of ["operator-cancel", "agent-cancel"]) {
		const entered = Promise.withResolvers();
		const finish = Promise.withResolvers();
		const cleaning = Promise.withResolvers();
		const cleaned = Promise.withResolvers();
		const h = harness({ deps: {
			runContainer: async () => { entered.resolve(); await finish.promise; return { code: 137, aborted: true, turns: 1 }; },
			cleanup: async () => { cleaning.resolve(); await cleaned.promise; },
		} });
		const running = h.run();
		await entered.promise;
		h.controller.abort(reason);
		assert.equal(h.ops.includes("release-window"), false, "the acknowledged cancel is not the terminal result");
		finish.resolve();
		await cleaning.promise;
		assert.equal(h.ops.includes("release-window"), false, "cleanup must finish first");
		cleaned.resolve();
		const result = await running;
		assert.deepEqual([result.outcome, result.reason, result.budgetReserved], ["policy", reason, true]);
		assert.ok(h.ops.indexOf("record") < h.ops.indexOf("release-window"));
		assert.equal(h.ops.at(-1), "release-window");
	}
});

test("a cancellation that replaces a pending infrastructure retry releases the window without retrying", { skip }, async () => {
	for (const [spent, deps] of [
		[false, { prepareWorkspace: async () => { throw new InfraRetry("clone unavailable", { reason: "container-never-started", budgetReserved: false }); } }],
		[true, { runContainer: async () => ({ code: 1, aborted: false, turns: 1 }) }],
	]) {
		const h = harness({ deps });
		h.keys.set(cancelReqKey(h.job.id), "operator-cancel");
		const result = await h.run();
		assert.deepEqual([result.outcome, result.reason, result.budgetReserved], ["policy", "operator-cancel", spent]);
		assert.ok(h.logs.some((line) => line.event === "job_cancelled_instead_of_retry"));
		assert.equal(h.keys.has(cancelAckKey(h.job.id)), true);
		assert.equal(h.ops.includes("delay"), false);
		assert.equal(h.ops.at(-1), "release-window");
	}
});

test("a window release fault cannot turn the terminal refusal into a retry", { skip }, async () => {
	const h = harness({
		deps: { checkSandboxWorkspace: async () => ({ outcome: "policy", reason: "future-policy-gate" }) },
		jobFields: { removeDeduplicationKey: async () => { throw Object.assign(new Error("unavailable"), { code: "ECONNREFUSED" }); } },
	});
	assert.equal((await h.run()).reason, "future-policy-gate");
	assert.equal(h.records.length, 1);
	assert.ok(h.logs.some((line) => line.code === "ECONNREFUSED"));
});

test("success, infrastructure retry, deferral and recovery handoffs retain their window", { skip }, async () => {
	const success = harness();
	assert.equal((await success.run()).outcome, "completed");
	assert.equal(success.ops.includes("release-window"), false);
	const retry = harness({ deps: { runContainer: async () => ({ code: 1, aborted: false }) } });
	await assert.rejects(retry.run(), (error) => error instanceof InfraRetry);
	assert.equal(retry.ops.includes("release-window"), false);
	const delayed = harness({ options: { triggersNewer: () => true } });
	await assert.rejects(delayed.run(), (error) => error.name === "DelayedError");
	assert.equal(delayed.ops.includes("delay"), true);
	assert.equal(delayed.ops.includes("release-window"), false);
	for (const reason of [RECOVERY_ENQUEUED, RECOVERY_SUPERSEDED]) {
		const recovery = harness({ deps: { checkSandboxWorkspace: async () => ({ outcome: "policy", reason }) } });
		assert.equal((await recovery.run()).reason, reason);
		assert.equal(recovery.ops.includes("release-window"), false, reason);
	}
});

test("a lost-lock replay of a recorded policy result closes its own window without running again", { skip }, async () => {
	const h = harness({
		jobFields: { stalledCounter: 1 },
		options: { settledRecord: async () => ({ outcome: "policy", reason: "operator-cancel", budgetReserved: true }) },
	});
	assert.equal((await h.run()).reason, "operator-cancel");
	assert.deepEqual(h.ops, ["release-window"]);
});
