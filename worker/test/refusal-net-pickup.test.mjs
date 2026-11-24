import assert from "node:assert/strict";
import { test } from "node:test";
import { InfraRetry } from "../src/processor.mjs";
import { REFUSAL_COMMENTS } from "../src/comment-tables.mjs";
import { explainReason } from "../src/reason-catalog.mjs";

// The refusal net through the real pickup (issue #969): every way a forge job is refused before spend ends with exactly
// one comment on its item, the call site's own where it has one and the catalog's sentence where it had none, and a
// deferral, a retry, a replay or a silent-by-decision refusal posts nothing the net added.

let makeProcessor;
let importError;
try {
	({ makeProcessor } = await import("../src/index.mjs"));
} catch (error) {
	importError = error;
}
if (!makeProcessor && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`refusal net pickup tests are REQUIRED here but the worker could not import.\n${importError}`);
}
const skip = makeProcessor ? false : `worker dependencies unavailable (node ${process.version}); CI runs these`;
const NOW = Date.UTC(2026, 10, 24, 12);
const SETTINGS = { provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null };

function harness({ deps = {}, options = {}, data = {}, jobFields = {} } = {}) {
	const ops = [];
	const texts = [];
	const logs = [];
	const keys = new Map();
	const controller = new AbortController();
	const redis = {
		incr: async () => (ops.push("reserve"), 1),
		decr: async () => (ops.push("release-hold"), 0),
		expire: async () => {},
		get: async (key) => keys.get(key) ?? null,
		set: async (key, value) => (keys.set(key, value), "OK"),
		del: async (key) => (keys.delete(key), 1),
	};
	const job = {
		id: "gh-poll-e42",
		name: "github",
		attemptsMade: 0,
		opts: { attempts: 2 },
		timestamp: NOW,
		data: { kind: "github", repo: "acme/site", target: { type: "pull_request", number: 7 }, flow: "review", trigger: { event: "pull_request", action: "labeled", deliveryId: "poll-e42", matched: { index: 0, type: "pull_request", action: "labeled" } }, ...data },
		moveToDelayed: async () => ops.push("delay"),
		...jobFields,
	};
	const processor = makeProcessor({
		redis,
		now: () => NOW,
		cancelJob: (_id, reason) => controller.abort(reason),
		stopContainer: async () => ops.push("stop"),
		getSettings: () => SETTINGS,
		recordRun: () => ops.push("record"),
		timeoutMs: 100_000,
		...options,
		deps: {
			now: new Date(NOW),
			mintToken: async () => (ops.push("mint"), "tok"),
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => (ops.push("prepare"), { workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => (ops.push("container"), { code: 0, aborted: false, turns: 1 }),
			cleanup: async () => ops.push("cleanup"),
			comment: async (_data, text) => (ops.push("comment"), texts.push(text)),
			log: (event, fields) => logs.push({ event, ...fields }),
			...deps,
		},
	});
	return { job, ops, texts, logs, run: () => processor(job, "lock-token", controller.signal) };
}

const sentence = (reason) => explainReason(reason).sentence;

test("a pickup selection refusal that said nothing now posts its catalog sentence once, before spend", { skip }, async (t) => {
	const cases = [
		["auth-route-unbounded (an auxiliary grant with no cap)", { data: { auxiliaryModels: [], models: ["anthropic/m"] } }, "auth-route-unbounded", REFUSAL_COMMENTS["auth-route-unbounded"]],
		["model-selection-policy-changed (a queued job after a pool edit)", { data: { modelSelection: { strategy: "random", candidates: ["anthropic/a", "openai/b"] } }, deps: { checkModelSelectionPolicy: async () => ({ refused: "model-selection-policy-changed" }) } }, "model-selection-policy-changed", sentence("model-selection-policy-changed")],
		["auth-mixed-billing (the subscription runtime's refusal)", { deps: { subscriptionRuntime: { check: async () => ({ ok: false, reason: "auth-mixed-billing" }) } } }, "auth-mixed-billing", sentence("auth-mixed-billing")],
		["settings-overlay-invalid", { options: { getSettings: () => ({ ...SETTINGS, invalid: true }) } }, "settings-overlay-invalid", sentence("settings-overlay-invalid")],
	];
	for (const [label, setup, reason, text] of cases) {
		await t.test(label, async () => {
			const h = harness(setup);
			const result = await h.run();
			assert.deepEqual([result.outcome, result.reason, result.budgetReserved], ["policy", reason, false]);
			assert.deepEqual(h.texts, [text]);
			for (const paid of ["mint", "reserve", "container"]) assert.equal(h.ops.includes(paid), false, `${paid} never happened`);
			assert.ok(h.ops.indexOf("record") < h.ops.indexOf("comment"), "recorded first, then told");
			assert.deepEqual(h.logs.filter((line) => line.event.startsWith("refusal_net_")).map((line) => [line.event, line.reason]), [["refusal_net_posted", reason]]);
		});
	}
});

test("a prepare-stage refusal (OQ-023) posts its catalog sentence once: the processor's comment seam is the counted one", { skip }, async () => {
	const h = harness({ deps: { prepareWorkspace: async () => ({ outcome: "policy", reason: "sha-gone" }) } });
	const result = await h.run();
	assert.deepEqual([result.outcome, result.reason, result.budgetReserved], ["policy", "sha-gone", false]);
	assert.deepEqual(h.texts, [sentence("sha-gone")]);
	assert.equal(h.ops.includes("container"), false);
});

test("a refusal that already commented through the processor is not told twice", { skip }, async () => {
	const h = harness({ deps: { isDefaultBranchProtected: async () => false } });
	const result = await h.run();
	assert.equal(result.reason, "unprotected-branch");
	assert.deepEqual(h.texts, [REFUSAL_COMMENTS["unprotected-branch"]], "the processor's own comment, and no second one from the net");
	assert.equal(h.logs.some((line) => line.event.startsWith("refusal_net_")), false);
});

test("silent by decision, a malformed notice, a replay, a deferral and a retry add nothing", { skip }, async (t) => {
	await t.test("not-parked: an ordinary reply to an item that is not parked", async () => {
		const h = harness({ data: { parkedReply: true } });
		const result = await h.run();
		assert.equal(result.reason, "not-parked");
		assert.deepEqual(h.texts, []);
	});
	await t.test("a duplicate notice too malformed to word", async () => {
		const h = harness({ data: { duplicateOf: "not a job id!" } });
		const result = await h.run();
		assert.equal(result.reason, "duplicate-request");
		assert.deepEqual(h.texts, []);
	});
	await t.test("a lost-lock replay of a refusal the first attempt already told", async () => {
		const h = harness({ jobFields: { stalledCounter: 1 }, options: { settledRecord: async () => ({ outcome: "policy", reason: "auth-mixed-billing", exitCode: null, budgetReserved: false }) } });
		const result = await h.run();
		assert.deepEqual([result.outcome, result.reason, result.budgetReserved], ["policy", "auth-mixed-billing", false]);
		assert.ok(h.logs.some((line) => line.event === "job_lost_lock_after_completion"), "the replay path, not a fresh refusal");
		assert.deepEqual(h.texts, []);
	});
	await t.test("a pause window defers: a throw, never a result", async () => {
		const h = harness({ options: { pauseUntil: () => NOW + 60_000 } });
		await assert.rejects(h.run());
		assert.ok(h.ops.includes("delay"), "deferred to the delayed set");
		assert.deepEqual(h.texts, []);
	});
	await t.test("an infrastructure retry throws past the net", async () => {
		const h = harness({ deps: { prepareWorkspace: async () => { throw new InfraRetry("clone failed", { reason: "container-never-started", budgetReserved: false }); } } });
		await assert.rejects(h.run(), InfraRetry);
		assert.deepEqual(h.texts, []);
	});
});
