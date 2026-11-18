import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DUPLICATE_NOTICE_SUFFIX, DUPLICATE_REQUEST_REASON, duplicateNoticeData, duplicateOfId, duplicateRequestComment, isDuplicateNotice } from "../src/duplicate-notice.mjs";
import { makeProcessor } from "../src/index.mjs";
import { JOB_DATA_VERSION_FIELD, withJobDataVersion } from "../src/job-data-version.mjs";
import { explainReason } from "../src/reason-catalog.mjs";
import { withDeferRecords } from "./helpers/defer-redis.mjs";

const NOW = Date.UTC(2026, 10, 18, 8, 59, 30);
const ENDS = Date.UTC(2026, 10, 18, 9, 7, 12);
const dropped = {
	kind: "gitlab", repo: "group/app", projectId: 41, target: { type: "pull_request", number: 12, title: "private title", body: "private body" },
	flow: "review", provider: "anthropic", model: "m", models: ["anthropic/m"], maxCostUsd: 2, secrets: { TOKEN: "op://vault/item" }, instructions: "private instruction",
	trigger: { event: "merge_request", action: "update", deliveryId: "dl-2", sender: { id: 5 }, matched: { index: 0, type: "label", label: "pi:go" } },
};

test("a notice carries where to comment and what it answers, never a run field, an instruction or the item's text", () => {
	const data = duplicateNoticeData(dropped, { survivingJobId: "gl-dl-1", windowEndsAt: ENDS });
	assert.deepEqual(data, {
		kind: "gitlab", repo: "group/app", projectId: 41, target: { type: "pull_request", number: 12 }, flow: "review",
		trigger: { event: "merge_request", action: "update", deliveryId: "dl-2", matched: { index: 0, type: "label", label: "pi:go" } },
		duplicateOf: "gl-dl-1", windowEndsAt: ENDS,
	});
	assert.equal(JSON.stringify(data).includes("private"), false);
	assert.deepEqual(duplicateNoticeData({ ...dropped, flow: undefined, command: "lint" }, { survivingJobId: "gl-dl-1", windowEndsAt: null }).command, "lint");
	assert.equal(duplicateNoticeData(dropped, { survivingJobId: "gl-dl-1", windowEndsAt: -1.5 }).windowEndsAt, null);
	assert.throws(() => duplicateNoticeData(dropped, { survivingJobId: "gl-dl-1 @everyone", windowEndsAt: ENDS }), /surviving job id/);
	assert.equal(withJobDataVersion(data)[JOB_DATA_VERSION_FIELD], 10, "a notice is always stamped: an older worker holds it rather than run it");
	assert.equal(DUPLICATE_NOTICE_SUFFIX, "-dup");
});

test("the comment: fixed words, the ended job's id and a UTC time, and nothing for data no producer writes", () => {
	const data = duplicateNoticeData(dropped, { survivingJobId: "gl-dl-1", windowEndsAt: ENDS });
	assert.equal(duplicateRequestComment(data), "pi-dispatch did not start a job for this request. Job `gl-dl-1` took the same request on this item less than 10 minutes ago and has already ended, and requests for one flow on one item are joined for 10 minutes from the first. Ask again after 09:07 UTC, or re-run job `gl-dl-1` from the console.");
	assert.match(duplicateRequestComment({ ...data, windowEndsAt: null }), /Ask again later, or re-run job `gl-dl-1`/);
	for (const duplicateOf of ["", "x".repeat(201), "gl-1\n@team", "[link](https://x)", 7]) {
		assert.equal(duplicateRequestComment({ ...data, duplicateOf }), null, JSON.stringify(duplicateOf));
		assert.equal(duplicateOfId({ ...data, duplicateOf }), null);
	}
	assert.equal(isDuplicateNotice(data), true);
	assert.equal(isDuplicateNotice(dropped), false);
	assert.equal(explainReason(DUPLICATE_REQUEST_REASON).known, true, "the console can say what it means");
});

function harness() {
	const calls = [];
	const records = [];
	const comments = [];
	const logs = [];
	const redis = withDeferRecords({ async incr() { calls.push("reserve"); return 1; }, async decr() { calls.push("refund"); return 0; }, async expire() {} });
	const processor = makeProcessor({
		cancelJob() {}, stopContainer() {}, redis, hostName: "h", now: () => NOW,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		// Everything that could hold a job first must not see a notice.
		pauseUntil: () => { calls.push("pause"); return null; },
		recordRun: (record) => records.push(record), timeoutMs: 100_000,
		deps: {
			async mintToken() { calls.push("mint"); return "token"; },
			async prepareWorkspace() { calls.push("prepare"); return { workspaceDir: "/w", jobDir: "/j" }; },
			async runContainer() { calls.push("container"); return { code: 0, aborted: false }; },
			async cleanup() { calls.push("cleanup"); },
			async comment(job, text) { comments.push({ job, text }); },
			log: (event, fields) => logs.push({ event, fields }),
		},
	});
	return { calls, records, comments, logs, run: (job) => processor(job, "attempt", new AbortController().signal) };
}

test("the worker answers a notice before every gate: one comment, a record, nothing held, minted or spent, no window freed", async () => {
	const h = harness();
	const data = withJobDataVersion(duplicateNoticeData(dropped, { survivingJobId: "gl-dl-1", windowEndsAt: ENDS }));
	let released = 0;
	const job = { id: "gl-dl-2-dup", name: "gitlab", data, attemptsMade: 0, async moveToDelayed() { assert.fail("a notice is never held"); }, removeDeduplicationKey: async () => { released++; return true; } };
	assert.deepEqual(await h.run(job), { outcome: "policy", reason: "duplicate-request", budgetReserved: false });
	assert.deepEqual(h.calls, [], "no pause read, mint, preparation, container or reservation");
	assert.equal(released, 0, "it holds no window (no deduplicationId), so the policy release frees nothing");
	assert.equal(h.comments.length, 1);
	assert.equal(h.comments[0].job, data, "posted on the item the notice names");
	assert.equal(h.comments[0].text, duplicateRequestComment(data));
	assert.equal(h.records.length, 1);
	assert.equal(h.records[0].result.reason, "duplicate-request");
	assert.deepEqual(h.logs.find((l) => l.event === "refused_duplicate_request").fields, { jobId: "gl-dl-2-dup", survivingJobId: "gl-dl-1" });
});

test("a notice no producer writes is still never run: refused with no comment, and its log names no bad id", async () => {
	const h = harness();
	const data = { ...duplicateNoticeData(dropped, { survivingJobId: "gl-dl-1", windowEndsAt: ENDS }), duplicateOf: "<script>" };
	const job = { id: "gl-x-dup", name: "gitlab", data, attemptsMade: 0, async moveToDelayed() { assert.fail("never held"); } };
	assert.equal((await h.run(job)).reason, "duplicate-request");
	assert.deepEqual(h.calls, []);
	assert.equal(h.comments.length, 0);
	assert.equal(h.logs.find((l) => l.event === "refused_duplicate_request").fields.survivingJobId, null);
});

test("the module is a leaf, since the receiver loads it through the queue", () => {
	const source = readFileSync(new URL("../src/duplicate-notice.mjs", import.meta.url), "utf8");
	assert.deepEqual([...source.matchAll(/^import .*$/gm)], []);
});
