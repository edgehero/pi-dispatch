import assert from "node:assert/strict";
import { test } from "node:test";
import { makeProcessor } from "../src/index.mjs";
import { SubscriptionWait } from "../src/subscription-wait.mjs";
import { runJob } from "../src/processor.mjs";

const NOW = Date.UTC(2030, 0, 1);
function fixture(wait) {
	const values = new Map(), seen = [], records = [], hashes = [];
	const redis = {
		get: async key => values.get(key) ?? null,
		set: async (key, value) => { values.set(key, value); return "OK"; },
		incr: async key => { seen.push("reserve"); const value = Number(values.get(key) ?? 0) + 1; values.set(key, value); return value; },
		decr: async key => { const value = Number(values.get(key) ?? 0) - 1; values.set(key, value); return value; },
		expire: async () => 1,
		multi() { const chain = { del: () => chain, hset: (key, ...args) => { hashes.push({ key, fields: Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]])) }); return chain; }, pexpire: () => chain, exec: async () => [[null, 1], [null, 1], [null, 1]] }; return chain; },
	};
	let prepared = { ok: false, wait, until: NOW + 30_000 };
	let atPrepare = () => {};
	const process = makeProcessor({ redis, concurrency: 1, now: () => NOW, cancelJob() {}, stopContainer() {}, getSettings: () => ({ provider: "openai", model: "model", maxTurns: 5, dailyCap: 10, concurrency: 1, softHoldPct: null }), recordRun: value => records.push(value), deps: {
		now: new Date(NOW), imagePreflight: async () => ({ ok: true, capabilities: ["subscriptionAuth", "modelPolicy"] }), subscriptionAuthRequired: async () => true,
		prepareSubscriptionAuth: async () => { atPrepare(); return prepared; },
		mintToken: async () => { seen.push("mint"); return "token"; }, isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => { seen.push("clone"); return { workspaceDir: "/w", jobDir: "/j" }; }, cleanup: async () => {}, comment: async () => {}, log: () => {},
		runContainer: async () => { seen.push("run"); return { code: 0, aborted: false }; },
	} });
	const job = { id: "subscription-wait", queueName: "test", name: "github", attemptsMade: 1, opts: { attempts: 2 }, data: { kind: "github", repo: "org/repo", provider: "openai", model: "model", models: ["openai/model"] }, moveToDelayed: async (until, token) => { seen.push("defer"); assert.equal(until, NOW + 30_000); assert.equal(token, "lock"); } };
	return { process, job, seen, hashes, records, allow() { prepared = { ok: true, snapshots: [] }; }, atPrepare(fn) { atPrepare = fn; } };
}

test("known subscription delays are closed host control flow, not queued retry properties", () => {
	for (const wait of ["subscription-auth", "subscription-quota", "subscription-owner"]) assert.equal(new SubscriptionWait({ wait, until: NOW }).budgetReserved, false);
	for (const value of [{ wait: "attacker", until: NOW }, { wait: "subscription-auth", until: Infinity }, { wait: "subscription-auth", until: "tomorrow" }]) assert.throws(() => new SubscriptionWait(value), /invalid subscription admission wait/);
});

test("runJob returns a free known-time wait through its typed channel before mint, clone and reserve", async () => {
	let calls = 0;
	await assert.rejects(runJob({ kind: "github", provider: "openai", model: "model" }, { now: new Date(NOW), prepareSubscriptionAuth: async () => ({ ok: false, wait: "subscription-auth", until: NOW + 30_000, unavailable: false }), mintToken: async () => { calls++; }, prepareWorkspace: async () => { calls++; }, redis: { incr: async () => { calls++; } } }), error => error instanceof SubscriptionWait && error.until === NOW + 30_000);
	assert.equal(calls, 0);
});

test("selected preparation auth/quota/owner races delay without spending an attempt and release the host slot", async () => {
	for (const wait of ["subscription-auth", "subscription-quota", "subscription-owner"]) {
		const f = fixture(wait);
		await assert.rejects(() => f.process(f.job, "lock", new AbortController().signal), { name: "DelayedError" });
		assert.deepEqual(f.seen, ["defer"]);
		assert.equal(f.job.attemptsMade, 1);
		assert.deepEqual(f.records, [], "a free delay does not create a failed or terminal run");
		assert.equal(f.hashes.at(-1).fields.why, wait);
		f.allow();
		const result = await f.process({ ...f.job, id: "after-delay" }, "lock", new AbortController().signal);
		assert.equal(result.outcome, "completed", "the delayed job cannot strand the only host slot");
		assert.ok(f.seen.includes("run"));
	}
});

test("a cancel acknowledged while subscription preparation waits ends the job instead of delaying it", async () => {
	const f = fixture("subscription-auth"), controller = new AbortController();
	f.atPrepare(() => controller.abort("operator-cancel"));
	const result = await f.process(f.job, "lock", controller.signal);
	assert.equal(result.reason, "operator-cancel");
	assert.equal(f.seen.includes("defer"), false);
	assert.equal(f.seen.includes("mint"), false);
});
