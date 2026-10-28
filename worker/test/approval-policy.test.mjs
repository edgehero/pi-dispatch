import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalActor, approvalAudit, approvalConfigDigest, approvalReply, approvalRequestId, makeCheckApprovalPolicy, validateApprovalConfig } from "../src/approval-policy.mjs";
import { parseTriggers } from "../src/triggers.mjs";

const run = (extra = {}) => ({ kind: "github", flow: "fix", resume: true, gates: ["deploy:staging", "budget-raise"], maxCostUsd: "1.00", gateBudgetRaiseUsd: "3.00", gateTimeout: 2, ...extra });
const entry = (value = run()) => ({ on: { type: "comment", phrase: "@pi" }, run: value });
const parse = (value) => parseTriggers(JSON.stringify({ triggers: [value] }), "/triggers.json");

test("gate schema is opt-in and validates action names, bounds and resumable forge prerequisites", () => {
	assert.deepEqual(validateApprovalConfig({ kind: "github" }), {});
	assert.deepEqual(validateApprovalConfig(run()), { gates: ["deploy:staging", "budget-raise"], gateBudgetRaiseUsd: "3.00", gateTimeout: 2 });
	const bad = [
		{ gates: [] }, { gates: "deploy:staging" }, { gates: ["deploy:staging", "deploy:staging"] }, { gates: ["Deploy"] },
		{ gates: ["deploy:staging:extra"] }, { gates: ["x".repeat(81)] }, { gates: Array.from({ length: 33 }, (_, i) => `gate-${i}`) },
		{ resume: false }, { kind: "local" }, { command: "fix" }, { replicas: 2 }, { recover: true }, { awaitInput: false },
		{ gateTimeout: 0 }, { gateTimeout: 366 }, { gateTimeout: 1.5 }, { gateTimeout: "2" },
		{ maxCostUsd: undefined }, { gateBudgetRaiseUsd: undefined }, { gateBudgetRaiseUsd: "1.00" }, { gateBudgetRaiseUsd: "0.99" },
		{ gates: ["deploy:staging"], gateBudgetRaiseUsd: "3.00" },
	];
	for (const extra of bad) assert.throws(() => validateApprovalConfig(run(extra)), undefined, JSON.stringify(extra));
	for (const gate of ["push", "push-default-branch", "pr-open", "open-pr", "merge", "approve"]) assert.throws(() => validateApprovalConfig(run({ gates: [gate], gateBudgetRaiseUsd: undefined })), /enforcement boundary/);
});

test("every forge's normalized rules retain gate policy and arm parking", () => {
	for (const kind of ["github", "gitlab", "forgejo", "azure"]) {
		// Azure has no issue-close trigger, and GitLab names that action close rather than closed.
		const rules = [{ type: "comment", phrase: "@pi" }, { type: "label", any: ["pi:fix"] }];
		if (kind !== "azure") rules.push({ type: "issue", action: [kind === "gitlab" ? "close" : "closed"] });
		for (const on of rules) {
			const input = { on, run: run({ kind, ...(kind === "azure" ? { repository: "repo" } : {}) }) };
			const normalized = parse(input)[0].run;
			assert.deepEqual(normalized.gates, input.run.gates, `${kind}/${on.type}`);
			assert.equal(normalized.gateTimeout, 2);
			assert.equal(normalized.gateBudgetRaiseUsd, "3.00");
			assert.equal(normalized.awaitInput, true);
		}
	}
});

test("loader rejects invalid gate policy as a named configuration refusal", () => {
	for (const value of [run({ gates: ["push"] }), run({ gateTimeout: 0 }), run({ gateBudgetRaiseUsd: "0.50" }), run({ recover: true })]) assert.throws(() => parse(entry(value)), (error) => error.piDispatchConfig === true && error.message.includes("/triggers.json"));
});

test("policy digest binds declared gates, timeout and both monetary caps", () => {
	const original = approvalConfigDigest(run());
	for (const extra of [{ gates: ["deploy:production"] }, { gateTimeout: 3 }, { gateBudgetRaiseUsd: "4.00" }, { maxCostUsd: "0.50" }]) assert.notEqual(approvalConfigDigest(run(extra)), original);
	assert.equal(approvalConfigDigest(run({ model: "other", title: "private" })), original);
});

test("live policy lookup fails closed on missing, changed or unreadable declarations", () => {
	let text = JSON.stringify({ triggers: [entry()] });
	const fs = { readFileSync() { if (text === null) throw new Error("private path"); return text; } };
	const check = makeCheckApprovalPolicy({ triggersPath: "/triggers.json", parseTriggers, fs });
	const job = { ...run(), trigger: { matched: { index: 0, type: "comment" } } };
	assert.deepEqual(check(job), { ok: true, digest: approvalConfigDigest(run()) });
	text = JSON.stringify({ triggers: [entry(run({ gateTimeout: 3 }))] });
	assert.deepEqual(check(job), { refused: "approval-policy-changed" });
	text = JSON.stringify({ triggers: [] });
	assert.deepEqual(check(job), { refused: "approval-policy-changed" });
	text = null;
	assert.deepEqual(check(job), { refused: "approval-policy-unavailable" });
});

test("only exact approve and decline commands decide; ordinary replies return questions", () => {
	assert.deepEqual(approvalReply(" /approve\n"), { decision: "approved", text: "" });
	assert.deepEqual(approvalReply("/decline"), { decision: "declined", text: "" });
	assert.deepEqual(approvalReply("/decline needs another review\nfirst"), { decision: "declined", text: "needs another review\nfirst" });
	for (const text of ["/approve please", "yes", "/approved", "/declined", "What does deployment change?"]) assert.deepEqual(approvalReply(text), { decision: "question", text });
	const long = "x".repeat(9000);
	assert.equal(approvalReply(long).text, long, "the private store must see the entire reply to refuse overflow rather than silently cut it");
	assert.equal(approvalReply(`/decline ${long}`).text, long);
	assert.deepEqual(approvalReply("@pi /approve", { phrase: "@pi" }), { decision: "approved", text: "" });
	assert.deepEqual(approvalReply("@pi\n/decline explain first", { phrase: "@pi" }), { decision: "declined", text: "explain first" });
	assert.deepEqual(approvalReply("@pigeon /approve", { phrase: "@pi" }), { decision: "question", text: "@pigeon /approve" });
	assert.deepEqual(approvalReply("other @pi /approve", { phrase: "@pi" }), { decision: "question", text: "other @pi /approve" });
});

test("request IDs bind both run and tool call, and actor/audit values reveal no display names or text", () => {
	const id = approvalRequestId("run-1", "call-1");
	assert.match(id, /^[0-9a-f]{64}$/);
	assert.notEqual(approvalRequestId("run-1", "call-2"), id);
	assert.notEqual(approvalRequestId("run-2", "call-1"), id);
	assert.deepEqual(approvalActor({}), null);
	for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) assert.equal(approvalActor({ trigger: { sender: { id } } }), null);
	assert.equal(approvalActor({ trigger: { sender: { id: 123 } } }).kind, "forge");
	const actor = approvalActor({ console: { by: "alice" } });
	assert.equal(actor.kind, "operator");
	assert.match(actor.id, /^[0-9a-f]{64}$/);
	assert.equal(approvalActor({ console: { by: "panel" } }).kind, "panel");
	const audit = approvalAudit({ requestId: id, action: "deploy:staging", summary: "private summary", decision: { decision: "declined", actor, at: 1234, text: "private reason" } });
	assert.deepEqual(Object.keys(audit), ["requestId", "action", "decision", "actorKind", "actorId", "decidedAt"]);
	assert.equal(JSON.stringify(audit).includes("private"), false);
	assert.equal(JSON.stringify(audit).includes("alice"), false);
});
