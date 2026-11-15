import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { parseTriggersDocument, TRIGGERS_FILE_VERSION } from "../src/triggers.mjs";
import { makeCheckMergePolicy, mergePolicyDigest } from "../src/merge-policy.mjs";
import { makeCheckWaitSkew } from "../src/triggers-file.mjs";
import { InfraRetry, NewerReleaseHold, runJob } from "../src/processor.mjs";
import { MERGE_POLICY_COMMENTS } from "../src/comment-tables.mjs";

const RAW = { on: { type: "label", any: ["fix"] }, run: { kind: "github", flow: "fix", mayMerge: true, instructions: "Land the reviewed fix." } };
const textOf = (entries = [RAW], version = TRIGGERS_FILE_VERSION) => JSON.stringify({ version, triggers: entries });
function setup(raw = RAW, overrides = {}) {
	let text = textOf([raw]);
	const entry = parseTriggersDocument(text, "triggers.json").triggers[0];
	const job = { kind: entry.run.kind, repo: "org/repo", flow: entry.run.flow, target: { type: "issue", number: 7 },
		provider: "anthropic", model: "m", maxTurns: 20, mayMerge: true, mayMergePolicy: mergePolicyDigest(entry),
		trigger: { matched: { index: 0, type: entry.on.type }, deliveryId: "12345678-1234-4234-8234-123456789012" }, ...overrides };
	const fs = { readFileSync: () => text };
	return { job, entry, check: makeCheckMergePolicy({ triggersPath: "/triggers.json", fs }), replace: (next) => { text = next; } };
}

test("permission is bound to the whole normalized trigger, and a read is never cached", () => {
	const h = setup();
	assert.deepEqual(h.check(h.job), { ok: true });
	for (const run of [{ ...RAW.run, mayMerge: false }, { ...RAW.run, instructions: "Different instruction" }, { ...RAW.run, maxTurns: 2 }]) {
		h.replace(textOf([{ ...RAW, run }]));
		assert.deepEqual(h.check(h.job), { refused: "merge-policy-changed" });
	}
	h.replace(textOf([{ ...RAW, on: { type: "label", any: ["other"] } }]));
	assert.deepEqual(h.check(h.job), { refused: "merge-policy-changed" });
	h.replace(textOf([]));
	assert.deepEqual(h.check(h.job), { refused: "merge-policy-changed" });
	h.replace(textOf());
	assert.deepEqual(h.check(h.job), { ok: true });
	const reordered = { run: { instructions: RAW.run.instructions, mayMerge: true, flow: "fix", kind: "github" }, on: RAW.on };
	h.replace(textOf([reordered]));
	assert.deepEqual(h.check(h.job), { ok: true }, "JSON key order is not policy");
});

test("an absent or false queued opt-in never gains permission from the file", () => {
	let reads = 0;
	const check = makeCheckMergePolicy({ triggersPath: "/triggers.json", fs: { readFileSync: () => { reads++; return textOf(); } } });
	for (const job of [{}, { mayMerge: false }]) assert.deepEqual(check(job), { ok: true });
	assert.equal(reads, 0);
});

test("malformed queue claims, foreign identities and replacement entries cannot authorize a job", () => {
	const h = setup();
	for (const extra of [{ mayMerge: "true" }, { mayMerge: null }, { mayMerge: 1 }, { mayMerge: false }, { mayMerge: undefined },
		{ mayMergePolicy: null }, { mayMergePolicy: "x" }, { kind: "local" }, { command: "do it" },
		{ trigger: {} }, { trigger: { matched: { index: -1, type: "label" } } }]) {
		assert.deepEqual(h.check({ ...h.job, ...extra }), { refused: "merge-policy-invalid" });
	}
	for (const extra of [{ kind: "forgejo" }, { flow: "other" }, { mayMergePolicy: "b".repeat(64) },
		{ trigger: { matched: { index: 1, type: "label" } } }, { trigger: { matched: { index: 0, type: "issue" } } }]) {
		assert.deepEqual(h.check({ ...h.job, ...extra }), { refused: "merge-policy-changed" });
	}
	h.replace(textOf([{ ...RAW, run: { ...RAW.run, flow: "other" } }, RAW]));
	assert.deepEqual(h.check(h.job), { refused: "merge-policy-changed" }, "moving the original row does not borrow the replacement's permission");
});

test("unknown future files defer; invalid, missing and unreadable files never retain old permission", () => {
	const h = setup();
	assert.deepEqual(h.check(h.job), { ok: true });
	h.replace(textOf([RAW], TRIGGERS_FILE_VERSION + 1));
	assert.deepEqual(h.check(h.job), { newer: true });
	for (const text of ["broken", '{"version":4,"version":4,"triggers":[]}', textOf([RAW], 1)]) {
		h.replace(text);
		assert.deepEqual(h.check(h.job), { refused: "merge-policy-unavailable" });
	}
	assert.deepEqual(makeCheckMergePolicy()(h.job), { refused: "merge-policy-unavailable" });
	for (const code of ["ENOENT", "EIO", "EACCES"]) {
		const check = makeCheckMergePolicy({ triggersPath: "/triggers", fs: { readFileSync: () => { throw Object.assign(new Error("secret text"), { code }); } } });
		assert.deepEqual(check(h.job), code === "ENOENT" ? { refused: "merge-policy-unavailable" } : { unreadable: true });
	}
});

test("the MR label-match shape and a reviewed comment flow override remain eligible", () => {
	const mr = setup({ on: { type: "pull_request", action: ["update"], any: ["fix"] }, run: { ...RAW.run, kind: "gitlab" } }, { target: { type: "pull_request", number: 7 }, trigger: { matched: { index: 0, type: "label", label: "fix" } } });
	assert.deepEqual(mr.check(mr.job), { ok: true });
	const raw = { on: { type: "comment", phrase: "@pi" }, run: RAW.run };
	const h = setup(raw);
	h.replace(textOf([raw, { ...RAW, run: { ...RAW.run, flow: "review" } }]));
	assert.deepEqual(h.check({ ...h.job, flow: "review" }), { ok: true });
	h.replace(textOf([raw]));
	assert.deepEqual(h.check({ ...h.job, flow: "review" }), { refused: "merge-policy-changed" });
});

test("one-shot retry excuses only its own valid disarm, without ignoring any policy edit", () => {
	const raw = { on: { type: "issue", action: ["closed"], number: 7, once: true }, run: RAW.run };
	const h = setup(raw);
	for (const jobId of [undefined, "other", "own"]) {
		h.replace(textOf([{ ...raw, on: { ...raw.on, disarmed: { at: "2026-11-15T12:00:00Z", ...(jobId ? { jobId } : {}) } } }]));
		assert.deepEqual(h.check(h.job, { queueJobId: "own" }), jobId === "own" ? { ok: true } : { refused: "merge-policy-changed" });
	}
	h.replace(textOf([{ ...raw, on: { ...raw.on, disarmed: { at: "2026-11-15T12:00:00Z", jobId: "own" } }, run: { ...raw.run, instructions: "Changed" } }]));
	assert.deepEqual(h.check(h.job, { queueJobId: "own" }), { refused: "merge-policy-changed" });
});

test("a stale receiver that omitted the flag is refused by the authored-field skew check", async () => {
	const dir = tempDir("pi-merge-skew-");
	const path = join(dir, "triggers.json");
	writeFileSync(path, textOf());
	const { mayMerge, mayMergePolicy, ...job } = setup().job;
	assert.deepEqual(await makeCheckWaitSkew({ triggersPath: path })(job), { skewed: true, field: "mayMerge" });
});

function processorDeps(check) {
	const calls = [];
	const deps = {
		checkMergePolicy: check,
		redis: { incr: async () => (calls.push("reserve"), 1), expire: async () => {}, decr: async () => 0, get: async () => (calls.push("token-cap"), null) },
		caps: { day: 10, week: null, month: null }, tokenCap: 1000, now: new Date("2026-11-15T12:00:00Z"),
		imagePreflight: async () => (calls.push("image"), { ok: true, capabilities: ["mergePolicy"] }),
		mintToken: async () => (calls.push("mint"), "tok"), isDefaultBranchProtected: async () => (calls.push("protection"), true),
		prepareWorkspace: async () => (calls.push("prepare"), { workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async ({ job }) => (calls.push(["container", job.mayMerge]), { code: 0, aborted: false }),
		comment: async (_job, text) => calls.push(["comment", text]), cleanup: async () => {},
	};
	return { deps, calls };
}

test("policy refusals precede all paid gates, including recovery, and use fixed actionable comments", async () => {
	for (const reason of Object.keys(MERGE_POLICY_COMMENTS)) {
		for (const recovery of [false, true]) {
			const { deps, calls } = processorDeps(async () => ({ refused: reason }));
			const result = await runJob({ ...setup().job, ...(recovery ? { recover: true, recoveryOf: "gh-origin", recovery: 1 } : {}) }, deps);
			assert.equal(result.reason, reason);
			assert.equal(result.outcome, "policy");
			assert.equal(result.budgetReserved, false);
			assert.deepEqual(calls, [["comment", MERGE_POLICY_COMMENTS[reason]]]);
		}
	}
	const { deps, calls } = processorDeps(undefined);
	assert.equal((await runJob(setup().job, deps)).reason, "merge-policy-unavailable", "an unwired gate cannot authorize");
	assert.equal(calls.length, 1);
});

test("infrastructure failures retry and future policy defers before spending", async () => {
	for (const [verdict, type] of [[{ unreadable: true }, InfraRetry], [{ newer: true }, NewerReleaseHold]]) {
		const { deps, calls } = processorDeps(async () => verdict);
		await assert.rejects(runJob(setup().job, deps), type);
		assert.deepEqual(calls, []);
	}
});

test("a valid permission reaches the container while retaining the ordinary protection gate", async () => {
	const h = setup();
	const { deps, calls } = processorDeps(h.check);
	assert.equal((await runJob(h.job, deps)).outcome, "completed");
	assert.ok(calls.includes("protection"));
	assert.deepEqual(calls.at(-1), ["container", true]);
	const blocked = processorDeps(h.check);
	blocked.deps.isDefaultBranchProtected = async () => false;
	assert.equal((await runJob(h.job, blocked.deps)).reason, "unprotected-branch");
	assert.ok(!blocked.calls.includes("prepare"));
	assert.ok(!blocked.calls.includes("reserve"));
});
