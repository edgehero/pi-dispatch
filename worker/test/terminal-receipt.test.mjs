import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ENDED_RECEIPT_SENTENCE, endedReceipt, terminalReceipt } from "../src/terminal-receipt.mjs";
import { REASONS } from "../src/reason-catalog.mjs";
import { WORKER_ERROR } from "../src/record-reason.mjs";

const completed = { outcome: "completed", exitCode: 0 };
const job = () => ({ id: "gh-poll-e1234", finishedOn: 123, data: { kind: "github", repo: "o/r", target: { type: "pull_request", number: 12 }, trigger: { event: "pull_request", action: "labeled", deliveryId: "poll-e1234", matched: { type: "pull_request", action: "labeled", index: 0 } } } });
const receipt = "<!-- pi-dispatch-terminal:v1 job=gh-poll-e1234 -->\npi-dispatch finished this job. This receipt records scheduling completion only; it does not verify the work.";

test("a completed label job gets the exact bounded scheduling receipt even without artifacts or statusComment", () => {
	assert.equal(terminalReceipt({ job: job(), result: completed }), receipt);
	assert.equal(terminalReceipt({ job: job(), result: { ...completed, artifacts: { kept: 1, bytes: 2, dropped: {} } } }), receipt);
	const issue = job();
	issue.data.target.type = "issue";
	issue.data.trigger.event = "issues";
	issue.data.trigger.matched = { type: "label", label: "private-label" };
	assert.equal(terminalReceipt({ job: issue, result: completed }), receipt);
	assert.ok(receipt.length < 200);
});

test("no completion proof for retries, recovery, stops, parked input, or incomplete queue transitions", () => {
	for (const result of [undefined, {}, { outcome: "failed" }, { outcome: "policy", exitCode: 2 }, { outcome: "completed" }, { ...completed, exitCode: 1 }, ...["recovery-enqueued", "awaiting-input", "awaiting-approval"].map((reason) => ({ ...completed, reason })), ...["aborted", "detached", "lingering"].map((flag) => ({ ...completed, [flag]: true }))]) {
		assert.equal(terminalReceipt({ job: job(), result }), null);
	}
	for (const finishedOn of [undefined, null, 0, -1, 1.5, "123", Infinity]) assert.equal(terminalReceipt({ job: { ...job(), finishedOn }, result: completed }), null);
	for (const extra of [{ recoveryOf: "gh-poll-e1234" }, { recovery: 1 }, { replica: 1 }, { replicas: 2 }, { answerDraft: true }, { purpose: "answer-draft" }]) {
		const input = job();
		Object.assign(input.data, extra);
		assert.equal(terminalReceipt({ job: input, result: completed }), null);
	}
});

test("receipt identity is bound to the original poll label route and matching issue or PR target", () => {
	const changes = [
		(j) => { j.id = "gh-poll-e9999"; },
		(j) => { j.id += ".r1"; },
		(j) => { j.id += "-r1"; },
		(j) => { j.data.kind = "gitlab"; },
		(j) => { j.data.trigger.event = "issue_comment"; },
		(j) => { j.data.trigger.action = "opened"; },
		(j) => { j.data.trigger.action = "synchronize"; },
		(j) => { j.data.trigger.matched.action = "synchronize"; },
		(j) => { j.data.trigger.matched.type = "comment"; },
		(j) => { j.data.target.type = "issue"; },
		(j) => { j.data.target.number = 0; },
		(j) => { delete j.data.trigger; },
	];
	for (const change of changes) {
		const input = job();
		change(input);
		assert.equal(terminalReceipt({ job: input, result: completed }), null);
	}
	for (const id of ["0", "01", "-1", "1.5", "9007199254740992", "1\n", "1234 -->", "1".repeat(1000)]) {
		const input = job();
		input.id = `gh-poll-e${id}`;
		input.data.trigger.deliveryId = `poll-e${id}`;
		assert.equal(terminalReceipt({ job: input, result: completed }), null);
	}
});

test("receipt text cannot contain input text, and a colliding source phrase suppresses it", () => {
	const input = job();
	input.data.target.body = "private body";
	input.data.target.title = "private title";
	input.data.trigger.comment = { body: "private comment" };
	assert.equal(terminalReceipt({ job: input, result: completed }), receipt);
	input.data.trigger.matched.phrase = "FINISHED THIS JOB";
	assert.equal(terminalReceipt({ job: input, result: completed }), null);
	input.data.trigger.matched.phrase = "@pi repair";
	assert.equal(terminalReceipt({ job: input, result: completed }), receipt);
});

// Issue #971: the ended receipt, for a label job that refused, stopped or failed. It shares the v1 binding exactly.
const refusedResult = { outcome: "policy", reason: "auth-mixed-billing", exitCode: null, budgetReserved: false };
const ended = (end, reason) => `<!-- pi-dispatch-ended:v1 job=gh-poll-e1234 end=${end}${reason ? ` reason=${reason}` : ""} -->\n${ENDED_RECEIPT_SENTENCE}`;
const infra = (reason) => Object.assign(new Error("container exited 1"), reason === undefined ? {} : { reason });

test("a label job that ended without completing gets its class and reason, and the completion receipt stays v1", () => {
	assert.equal(endedReceipt({ job: job(), result: refusedResult }), ended("refused", "auth-mixed-billing"));
	assert.equal(endedReceipt({ job: job(), result: { outcome: "policy", reason: "cost-cap", budgetReserved: true, exitCode: 2 } }), ended("stopped", "cost-cap"));
	assert.equal(endedReceipt({ job: job(), result: { outcome: "policy", reason: "operator-cancel", budgetReserved: true } }), ended("stopped", "operator-cancel"));
	assert.equal(endedReceipt({ job: job(), error: infra("container-infra-exit") }), ended("failed", "container-infra-exit"));
	assert.equal(endedReceipt({ job: job(), error: infra() }), ended("failed", WORKER_ERROR), "an error with no token is the record's worker-error");
	assert.ok(Object.hasOwn(REASONS, WORKER_ERROR));
	// A completion is v1's, never the ended receipt's, and v1 never answers an ended job.
	assert.equal(endedReceipt({ job: job(), result: completed }), null);
	assert.equal(terminalReceipt({ job: job(), result: refusedResult }), null);
});

test("an ended receipt names only a reason docs/reasons.md explains, and never anything a job or an error wrote", () => {
	for (const reason of ["future-gate", "__proto__", "Has Spaces", "x".repeat(65), "a-->b", 7, null]) {
		assert.equal(endedReceipt({ job: job(), result: { ...refusedResult, reason } }), ended("refused", null), String(reason));
	}
	assert.equal(endedReceipt({ job: job(), error: infra("not a token -->") }), ended("failed", WORKER_ERROR));
	const input = job();
	input.data.target.title = "private title";
	input.data.trigger.comment = { body: "private comment" };
	const text = endedReceipt({ job: input, result: { ...refusedResult, why: "private why" } });
	assert.equal(text, ended("refused", "auth-mixed-billing"));
	assert.doesNotMatch(text, /private/);
	// The longest token a record can carry keeps the receipt small and plain.
	const longest = Object.keys(REASONS).reduce((a, b) => (b.length > a.length ? b : a));
	const big = endedReceipt({ job: { ...job(), id: "gh-poll-e9007199254740991", data: { ...job().data, trigger: { ...job().data.trigger, deliveryId: "poll-e9007199254740991" } } }, result: { ...refusedResult, reason: longest } });
	assert.ok(Buffer.byteLength(big) < 512 && /^[\x20-\x7e\n]+$/.test(big), big);
	assert.doesNotMatch(ENDED_RECEIPT_SENTENCE, /[\n<>@`]|--/);
});

test("no ended receipt for a completion, a park, a returned failure, an unknown reservation or a transition not made", () => {
	for (const result of [undefined, null, "policy", {}, completed, { outcome: "completed", reason: "awaiting-input", budgetReserved: true }, { outcome: "failed", reason: "recovery-enqueued", budgetReserved: false }, { ...refusedResult, budgetReserved: null }, { ...refusedResult, budgetReserved: undefined }, { ...refusedResult, budgetReserved: "false" }]) {
		assert.equal(endedReceipt({ job: job(), result }), null, JSON.stringify(result));
	}
	assert.equal(endedReceipt(), null);
	for (const finishedOn of [undefined, null, 0, -1, 1.5, "123", Infinity]) {
		assert.equal(endedReceipt({ job: { ...job(), finishedOn }, result: refusedResult }), null);
		assert.equal(endedReceipt({ job: { ...job(), finishedOn }, error: infra("container-infra-exit") }), null);
	}
});

test("the ended receipt is bound exactly as v1: the original poll label route, its target, its own queue job", () => {
	const changes = [
		(j) => { j.id = "gh-poll-e9999"; },
		(j) => { j.id += "-r1"; },
		(j) => { j.data.kind = "gitlab"; },
		(j) => { j.data.trigger.event = "issue_comment"; },
		(j) => { j.data.trigger.action = "opened"; },
		(j) => { j.data.trigger.matched.type = "comment"; },
		(j) => { j.data.target.type = "issue"; },
		(j) => { j.data.target.number = 0; },
		(j) => { j.data.trigger.deliveryId = "0a1b2c3d-webhook-guid"; j.id = "gh-0a1b2c3d-webhook-guid"; },
		(j) => { j.id = "gh-poll-e1234-dup"; },
		(j) => { delete j.data.trigger; },
		...[{ recoveryOf: "gh-poll-e1234" }, { recovery: 1 }, { replica: 1 }, { replicas: 2 }, { answerDraft: true }, { purpose: "answer-draft" }].map((extra) => (j) => { Object.assign(j.data, extra); }),
	];
	for (const change of changes) {
		const input = job();
		change(input);
		assert.equal(endedReceipt({ job: input, result: refusedResult }), null, String(change));
		assert.equal(endedReceipt({ job: input, error: infra("container-infra-exit") }), null, String(change));
	}
	const input = job();
	input.data.trigger.matched.phrase = "ENDED THIS JOB";
	assert.equal(endedReceipt({ job: input, result: refusedResult }), null, "a colliding phrase suppresses it, as v1");
});

test("the ended receipt's body is the one INT-FORGE-ENDED-RECEIPT pins", () => {
	const spec = readFileSync(new URL("../../specs/interfaces.md", import.meta.url), "utf8");
	const at = spec.indexOf("## INT-FORGE-ENDED-RECEIPT");
	assert.ok(at !== -1, "the entry exists");
	const fence = spec.slice(at).match(/```text\n([^\n]+)\n([^\n]+)\n```/);
	assert.ok(fence, "the entry pins the body in a text block");
	assert.equal(fence[1], "<!-- pi-dispatch-ended:v1 job=gh-poll-e<ID> end=<END> reason=<REASON> -->");
	assert.equal(fence[2], ENDED_RECEIPT_SENTENCE);
	assert.equal(ended("refused", "auth-mixed-billing").split("\n")[1], fence[2]);
});

// The pinned dependency's real completion method, with only its I/O replaced: a record/processor return is too early.
let Worker;
try { ({ Worker } = await import("bullmq")); } catch (error) {
	if (process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw error;
}
test("pinned BullMQ awaits the completion transition before emitting, and emits nothing when that transition fails", { skip: !Worker && "worker dependencies not installed" }, async () => {
	let release;
	const transition = new Promise((resolve) => { release = resolve; });
	const input = job();
	delete input.finishedOn;
	input.moveToCompleted = async () => { await transition; input.finishedOn = 123; };
	const receipts = [];
	const worker = { connection: { closing: false }, emit: (name, emittedJob, result) => { assert.equal(name, "completed"); receipts.push(terminalReceipt({ job: emittedJob, result })); } };
	const pending = Worker.prototype.handleCompleted.call(worker, completed, input, "token");
	await Promise.resolve();
	assert.deepEqual(receipts, []);
	release();
	await pending;
	assert.deepEqual(receipts, [receipt]);
	input.moveToCompleted = async () => { throw new Error("lost lock"); };
	await assert.rejects(Worker.prototype.handleCompleted.call(worker, completed, input, "token"), /lost lock/);
	assert.deepEqual(receipts, [receipt], "a failed final transition must not publish another receipt");
});
