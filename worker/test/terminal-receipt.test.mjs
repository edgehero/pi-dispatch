import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalReceipt } from "../src/terminal-receipt.mjs";

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
