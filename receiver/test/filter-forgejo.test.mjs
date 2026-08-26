import assert from "node:assert/strict";
import { test } from "node:test";
import { filterForgejo } from "../src/filter-forgejo.mjs";
import { isRecognizedAction, mapAction, parseForgejoSubset } from "../src/forgejo-subset.mjs";

const SELF_ID = 999;
const MEMBER = 7;
const REPO = { full_name: "acme/widgets" };
const label = (name) => ({ name });

const triggersRaw = {
	label: [{ index: 0, predicate: { any: ["pi:go"] }, flow: "fix" }],
	comment: { index: 1, phrase: "@pi", defaultFlow: "triage" },
	pullRequest: [
		{ index: 2, actions: new Set(["label_updated"]), predicate: { any: ["pi:review"] }, flow: "review" },
		{ index: 3, actions: new Set(["synchronized", "opened"]), predicate: null, flow: "ci" },
	],
};
const knownFlows = new Set(["fix", "triage", "review", "ci"]);

const issuePayload = (over = {}) => ({
	action: "label_updated",
	sender: { id: MEMBER, login: "alice" },
	issue: { number: 7, title: "T", body: "B", labels: [label("pi:go")] },
	repository: REPO,
	...over,
});

const commentPayload = (over = {}) => ({
	action: "created",
	sender: { id: MEMBER, login: "alice" },
	issue: { number: 7, title: "T", body: "B", labels: [] },
	comment: { body: "@pi please look" },
	repository: REPO,
	...over,
});

const prPayload = (over = {}) => ({
	action: "label_updated",
	sender: { id: MEMBER, login: "alice" },
	pull_request: {
		number: 12,
		title: "PT",
		body: "PB",
		labels: [label("pi:review")],
		head: { ref: "feature", sha: "abc", repo: { full_name: "acme/widgets" } },
		base: { ref: "main" },
	},
	repository: REPO,
	...over,
});

const run = (eventName, payload, { authorized = true, selfId = SELF_ID } = {}) =>
	filterForgejo(eventName, parseForgejoSubset(payload), triggersRaw, knownFlows, selfId, authorized, "fj-1");

// --- the action map: issue #61's Gap 2, which is a SILENT failure ---

test("label_updated fires a label trigger -- against GitHub's vocabulary it would be a silent 200", () => {
	// Forgejo reports issue_label events as X-GitHub-Event: issues with action label_updated. Read against
	// GitHub's LABEL_ACTIONS that passes the event check, fails the action check, and falls out as
	// unhandled-event: HTTP 200, no job, no error, nothing that says why.
	const r = run("issues", issuePayload());
	assert.equal(r.enqueue, true, "a labelled issue must start its job");
	assert.equal(r.job.flow, "fix");
	assert.equal(r.job.trigger.action, "label_updated", "the record says what the forge said, not our translation");
});

test("label_cleared NEVER enqueues, and drops under its own reason", () => {
	// Removing a label must not start a paid run. It has no GitHub counterpart, so there is nothing for it
	// to inherit that rule from -- it has to be stated, and it has to be visible that it was seen.
	const r = run("issues", issuePayload({ action: "label_cleared" }));
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "action-not-actionable", "recognised and deliberately ignored, not unrecognised");
});

test("synchronized fires a PR trigger -- Forgejo's spelling of synchronize", () => {
	const r = run("pull_request", prPayload({ action: "synchronized" }));
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "ci");
});

test("a recognised-but-ignored action is distinguishable from one we never heard of", () => {
	// Two reasons because they call for two different operator responses: "that is not a trigger" versus
	// "check your action vocabulary against your forge's".
	for (const action of ["closed", "edited", "assigned", "reviewed", "milestoned"]) {
		assert.equal(run("issues", issuePayload({ action })).reason, "action-not-actionable", action);
	}
	for (const action of ["banana", "", "labeled", "synchronize"]) {
		// Note `labeled` and `synchronize`: GitHub's words are NOT Forgejo's, and a payload carrying them is
		// not something Forgejo sends.
		assert.equal(run("issues", issuePayload({ action })).reason, "unhandled-event", action);
	}
});

test("mapAction and isRecognizedAction agree on what the map covers", () => {
	for (const action of ["label_updated", "opened", "reopened"]) {
		assert.notEqual(mapAction("issues", action), null, `${action} maps`);
		assert.equal(isRecognizedAction(action), true);
	}
	assert.equal(mapAction("issues", "label_cleared"), null, "maps to nothing, permanently");
	assert.equal(isRecognizedAction("label_cleared"), true, "but it IS recognised, which is why it gets its own reason");
	assert.equal(mapAction("issues", "synchronized"), null, "synchronized is a pull_request action, not an issue one");
	assert.notEqual(mapAction("pull_request", "synchronized"), null);
});

// --- routing: issue #61's Gap 3 ---

test("a comment on a pull request routes a pull_request target, never a fresh pi/issue branch", () => {
	// Forgejo puts is_pull at TOP LEVEL; GitHub puts issue.pull_request. Reading the wrong one routes every
	// PR comment as an issue, and the envelope then tells the agent to open pi/issue-<n> for something that
	// is already a pull request: wrong work, no error, a run that looks successful.
	const r = run("issue_comment", commentPayload({ is_pull: true }));
	assert.equal(r.enqueue, true);
	assert.equal(r.job.target.type, "pull_request");
	assert.equal(r.job.target.number, 7, "the issue number IS the PR number on Forgejo, as on GitHub");
});

test("a comment on a plain issue still routes an issue target", () => {
	const r = run("issue_comment", commentPayload());
	assert.equal(r.job.target.type, "issue");
});

// --- the authority gate ---

test("an unauthorized actor is refused on EVERY trigger type, label included", () => {
	// Unlike GitHub, the label path is gated too. The label very probably IS self-gating on Forgejo, but
	// this project has not verified that against a running instance across versions, and the cost of being
	// wrong is a stranger starting paid jobs. Redundant beats unverified.
	for (const [name, event, payload] of [
		["issue label", "issues", issuePayload()],
		["comment", "issue_comment", commentPayload()],
		["pull_request", "pull_request", prPayload()],
	]) {
		const r = run(event, payload, { authorized: false });
		assert.equal(r.enqueue, false, `${name} must not enqueue for an unauthorized actor`);
		assert.equal(r.reason, "author-not-allowed");
	}
});

test("only an explicit `true` clears the gate -- nothing truthy, nothing coerced", () => {
	// Called directly, not through `run`, whose default would substitute a passing verdict for `undefined`
	// and quietly turn this into an assertion about the helper.
	for (const authorized of [undefined, null, "true", 1, {}]) {
		const r = filterForgejo("issues", parseForgejoSubset(issuePayload()), triggersRaw, knownFlows, SELF_ID, authorized, "fj-x");
		assert.equal(r.enqueue, false, `a ${JSON.stringify(authorized)} verdict must fail closed`);
		assert.equal(r.reason, "author-not-allowed");
	}
});

test("the bot-loop guard runs BEFORE the authority gate, so our own comment cannot recurse", () => {
	// Under a hand-minted Forgejo token the harness IS a collaborator and would clear the gate -- so
	// ordering is what stops its own status comment from starting another job.
	const r = run("issue_comment", commentPayload({ sender: { id: SELF_ID, login: "pi-bot" } }), { authorized: true });
	assert.equal(r.reason, "self");
});

test("a missing sender.id is refused before the self compare -- undefined must not fall through", () => {
	const r = run("issues", issuePayload({ sender: { login: "nobody" } }));
	assert.equal(r.reason, "missing-sender-id");
});

// --- the job ---

test("the job carries no sender.login -- it exists for the permission lookup and nowhere else", () => {
	const r = run("issues", issuePayload());
	assert.equal(JSON.stringify(r.job).includes("alice"), false, "the job is copied verbatim into /job/event.json, which must stay free of personal data");
});

test("a PR rule matches on Forgejo's OWN action word, the one the trigger file names", () => {
	// The trigger file says `label_updated` because that is what an operator reads in Forgejo's docs and
	// what the loader validates. Matching rules against the MAPPED word instead would make every Forgejo PR
	// trigger dead while every other test still passed.
	const r = run("pull_request", prPayload({ action: "label_updated" }));
	assert.equal(r.enqueue, true);
	assert.equal(r.job.trigger.matched.index, 2, "the label_updated rule, not the synchronized one");
	assert.equal(r.job.trigger.matched.action, "label_updated", "the matched record names the forge's own word, so it lines up with the triggers file");
});

// --- run.command rules (issue #189): the matched rule dispatches a registered pi extension command ---

// Grouped exactly as loadReceiverConfig emits command rules: `flow`/`defaultFlow` are own-keys holding
// undefined (config.mjs enumerates every field by name), `command` is the line the worker forwards as
// PI_COMMAND. Deliberately MIXED with a flow rule: the channel is decided per RULE, by whichever matched.
const cmdTriggersRaw = {
	label: [
		{ index: 1, predicate: { any: ["pi:standup"] }, flow: undefined, command: "standup" },
		{ index: 0, predicate: { any: ["pi:go"] }, flow: "fix", command: undefined },
	],
	comment: { index: 2, phrase: "@pi", defaultFlow: undefined, command: "wf run nightly" },
	pullRequest: [{ index: 3, actions: new Set(["synchronized"]), predicate: null, flow: undefined, command: "check" }],
};
const runCmd = (eventName, payload) => filterForgejo(eventName, parseForgejoSubset(payload), cmdTriggersRaw, knownFlows, SELF_ID, true, "fj-cmd");

test("a comment command rule fires on the phrase alone -- command on the JOB, no flow key anywhere", () => {
	// defaultFlow undefined plus a bare phrase is EXACTLY what routeComment refuses as `no-flow` on a flow
	// rule. On a command rule that refusal must be unreachable -- there is no flow to resolve.
	const r = runCmd("issue_comment", commentPayload({ comment: { body: "@pi" } }));
	assert.equal(r.enqueue, true, "no-flow must be unreachable for a command rule");
	assert.equal(r.job.command, "wf run nightly");
	assert.equal("flow" in r.job, false, "a command job carries NO flow key -- absent, not present-and-undefined");
	assert.deepEqual(Object.keys(r.job), ["repo", "target", "command", "trigger"]);
	assert.deepEqual(r.job.trigger.matched, { index: 2, type: "comment", phrase: "@pi" });
});

test("the `<phrase> <word>` override channel is INERT on a command rule -- trailing words neither retarget nor veto", () => {
	// "fix" IS a known flow here. On a flow rule this comment would run `fix`; on a command rule it must
	// not -- an authorized collaborator may INVOKE the trigger, never re-aim it at a flow its author did
	// not name.
	const retarget = runCmd("issue_comment", commentPayload({ comment: { body: "@pi fix" } }));
	assert.equal(retarget.enqueue, true);
	assert.equal(retarget.job.command, "wf run nightly");
	assert.equal("flow" in retarget.job, false, "a known flow name after the phrase must not turn a command job into a flow job");

	// And an unknown trailing word must not SUPPRESS the command via the no-flow arm: trailing text is
	// data, riding trigger.comment into /job/event.json for the handler to read.
	const noise = runCmd("issue_comment", commentPayload({ comment: { body: "@pi nonesuch entirely" } }));
	assert.equal(noise.enqueue, true, "a trailing non-flow word must not become a no-flow refusal");
	assert.equal(noise.job.command, "wf run nightly");
	assert.deepEqual(noise.job.trigger.comment, { body: "@pi nonesuch entirely" });
});

test("label and pull_request command rules enqueue command jobs -- command at JOB level, never inside trigger", () => {
	const labeled = runCmd("issues", issuePayload({ issue: { number: 7, title: "T", body: "B", labels: [label("pi:standup")] } }));
	assert.equal(labeled.enqueue, true);
	assert.equal(labeled.job.command, "standup");
	assert.equal("flow" in labeled.job, false);
	assert.equal("command" in labeled.job.trigger, false, "an execution knob, never inside trigger/event.json");
	assert.deepEqual(labeled.job.trigger.matched, { index: 1, type: "label", label: "pi:standup" });

	const pr = runCmd("pull_request", prPayload({ action: "synchronized" }));
	assert.equal(pr.enqueue, true);
	assert.equal(pr.job.command, "check");
	assert.equal("flow" in pr.job, false);
	assert.equal("command" in pr.job.trigger, false);
	assert.deepEqual(pr.job.trigger.matched, { index: 3, type: "pull_request", action: "synchronized" });
});

test("a mixed group routes per rule: the flow label rule still emits a byte-identical flow job beside the command rules", () => {
	const r = runCmd("issues", issuePayload());
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "fix");
	assert.equal("command" in r.job, false, "a flow job grows no command key -- its enqueued bytes must not change");
	assert.deepEqual(Object.keys(r.job), ["repo", "target", "flow", "trigger"]);
});

// --- run.replicas rides the matched rule onto the job (REQ-REPLICA-RUNS, #187) ---

test("forgejo: replicas rides the matched rule onto the job, at JOB level and never inside trigger", () => {
	const t = { ...triggersRaw, label: [{ ...triggersRaw.label[0], replicas: 2 }] };
	const r = filterForgejo("issues", parseForgejoSubset(issuePayload()), t, knownFlows, SELF_ID, true, "fj-9");
	assert.equal(r.job.replicas, 2);
	assert.equal("replicas" in r.job.trigger, false);
});

test("forgejo: an unflagged rule emits no replicas key at all -- absent, not present-and-undefined", () => {
	assert.equal("replicas" in run("issues", issuePayload()).job, false);
});

test("secrets and secretsProfile ride the JOB from the matched rule, never inside trigger (#225)", () => {
	const t = { ...triggersRaw, label: [{ index: 0, predicate: { any: ["pi:go"] }, flow: "fix", secrets: { STRIPE_KEY: "op://ci/stripe/api-key" }, secretsProfile: "prod" }] };
	const r = filterForgejo("issues", parseForgejoSubset(issuePayload()), t, knownFlows, SELF_ID, true, "fj-secrets");
	assert.equal(r.enqueue, true);
	assert.deepEqual(r.job.secrets, { STRIPE_KEY: "op://ci/stripe/api-key" });
	assert.equal(r.job.secretsProfile, "prod");
	// `trigger` is copied verbatim into /job/event.json, which the agent reads: a reference list there
	// would hand it the map of the operator's vault.
	assert.equal("secrets" in r.job.trigger, false);
	assert.equal("secretsProfile" in r.job.trigger, false);
});
