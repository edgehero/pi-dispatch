import assert from "node:assert/strict";
import { test } from "node:test";
import { filterGitLab } from "../src/filter-gitlab.mjs";
import { parseGitLabSubset } from "../src/gitlab-subset.mjs";

const SELF_ID = 999;
const MEMBER = 7;

const triggers = {
	label: [{ index: 2, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix" }],
	comment: { index: 4, phrase: "@pi", defaultFlow: "triage" },
	pullRequest: [
		{ index: 6, actions: new Set(["update"]), predicate: { any: ["pi:review"] }, flow: "review" },
		{ index: 8, actions: new Set(["open", "approved"]), predicate: {}, flow: "autoreview" },
	],
};
const knownFlows = new Set(["frontend-fix", "triage", "review", "autoreview", "docs"]);

const PROJECT = { id: 42, path_with_namespace: "group/sub/proj", default_branch: "main" };
const label = (name) => ({ title: name });

/** An `Issue Hook` payload. `changes` is how GitLab reports a label being added. */
function issuePayload(over = {}) {
	return {
		object_kind: "issue",
		user: { id: MEMBER, username: "dev" },
		project: PROJECT,
		object_attributes: { iid: 5, title: "T", description: "B", action: "update", labels: [label("pi:frontend")] },
		changes: { labels: { previous: [], current: [label("pi:frontend")] } },
		...over,
	};
}

function mrPayload(over = {}) {
	return {
		object_kind: "merge_request",
		user: { id: MEMBER, username: "dev" },
		project: PROJECT,
		object_attributes: { iid: 12, title: "MR", description: "D", action: "open", labels: [] },
		...over,
	};
}

function notePayload(over = {}) {
	return {
		object_kind: "note",
		user: { id: MEMBER, username: "dev" },
		project: PROJECT,
		object_attributes: { action: "create", note: "@pi please", noteable_type: "Issue" },
		issue: { iid: 5, title: "T", description: "B", labels: [] },
		...over,
	};
}

const run = (payload, { authorized = true, selfId = SELF_ID, delivery = "wh-1" } = {}) =>
	filterGitLab(parseGitLabSubset(payload), triggers, knownFlows, selfId, authorized, delivery);

// --- the label diff (the repeat-paid-run bug this design exists to prevent) ---

test("adding an allowlisted label enqueues exactly the matched rule's flow", () => {
	const r = run(issuePayload());
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "frontend-fix");
	assert.deepEqual(r.job.trigger.matched, { index: 2, type: "label", label: "pi:frontend" });
});

test("a LATER update of an already-labelled issue enqueues NOTHING", () => {
	// The whole reason the gate reads changes.labels instead of the current label set. GitLab has no
	// `labeled` action: retitling, reassigning or re-milestoning an issue all arrive as `update` with the
	// trigger label still present. Matching the current set would start a paid run on every one of them.
	const retitled = issuePayload({
		object_attributes: { iid: 5, title: "T2", description: "B", action: "update", labels: [label("pi:frontend")] },
		changes: { title: { previous: "T", current: "T2" } },
	});
	const r = run(retitled);
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-label-change", "an update that moved no label must not re-fire the trigger");
});

test("REMOVING the allowlisted label never fires -- a diff is directional", () => {
	const removed = issuePayload({
		object_attributes: { iid: 5, title: "T", description: "B", action: "update", labels: [] },
		changes: { labels: { previous: [label("pi:frontend")], current: [] } },
	});
	assert.equal(run(removed).enqueue, false, "un-labelling must never start a paid run");
});

test("a label added ALONGSIDE existing ones fires on the addition, not on the set", () => {
	const added = issuePayload({
		object_attributes: { iid: 5, title: "T", description: "B", action: "update", labels: [label("keep"), label("pi:frontend")] },
		changes: { labels: { previous: [label("keep")], current: [label("keep"), label("pi:frontend")] } },
	});
	assert.equal(run(added).enqueue, true);
});

test("an issue OPENED already carrying the label fires -- there is no previous set to diff against", () => {
	const opened = issuePayload({
		object_attributes: { iid: 5, title: "T", description: "B", action: "open", labels: [label("pi:frontend")] },
		changes: {},
	});
	assert.equal(run(opened).enqueue, true, "every label on a new issue arrived with it");
});

// --- the access gate ---

test("an unauthorized actor is refused on EVERY trigger type, label included", () => {
	// GitHub can treat a label as the approval because only collaborators can apply one. On GitLab a Guest
	// can set labels on an issue they are creating, so the label proves nothing and the verdict is the gate.
	// Which ROLE clears it is the resolver's business now (gitlab-members.mjs, and its own tests); what this
	// file owns is that a `false` verdict stops every trigger type, not only the ones without a label.
	for (const [name, payload] of [["issue", issuePayload()], ["merge_request", mrPayload()], ["note", notePayload()]]) {
		const r = run(payload, { authorized: false });
		assert.equal(r.enqueue, false, `${name} must not enqueue for an unauthorized actor`);
		assert.equal(r.reason, "author-not-allowed");
	}
});

test("only an explicit `true` clears the gate -- nothing truthy, nothing coerced", () => {
	assert.equal(run(issuePayload(), { authorized: true }).enqueue, true);
	// Called directly, not through `run`, whose default would substitute a passing verdict for `undefined`
	// and quietly turn this into an assertion about the helper. A resolver that returned the wrong shape,
	// or a caller that read the wrong field, lands here -- and must refuse rather than pass.
	for (const authorized of [undefined, null, "true", 1, 30, {}]) {
		const r = filterGitLab(parseGitLabSubset(issuePayload()), triggers, knownFlows, SELF_ID, authorized, "wh-x");
		assert.equal(r.enqueue, false, `a ${JSON.stringify(authorized)} verdict must fail closed, never coerce`);
		assert.equal(r.reason, "author-not-allowed");
	}
});

test("the bot-loop guard runs BEFORE the access gate, so our own comment cannot recurse", () => {
	// Under a project access token the harness IS a member and would clear the access gate -- so ordering
	// is what stops the harness's own status comment from starting another job.
	const r = run(notePayload({ user: { id: SELF_ID, username: "pi-bot" } }), { authorized: true });
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "self");
});

test("a missing user.id is refused before the self compare -- undefined must not fall through", () => {
	const r = run(issuePayload({ user: {} }), { authorized: true });
	assert.equal(r.reason, "missing-sender-id");
});

// --- routing ---

test("a note on a merge request routes a pull_request target, not an issue", () => {
	// Routing this wrong mints an issue branch for something that is already an MR: wrong work, no error,
	// and it reads as a successful run.
	const r = run(notePayload({
		object_attributes: { action: "create", note: "@pi look", noteable_type: "MergeRequest" },
		merge_request: { iid: 12, title: "MR", description: "D", labels: [] },
	}));
	assert.equal(r.enqueue, true);
	assert.equal(r.job.target.type, "pull_request");
	assert.equal(r.job.target.number, 12);
});

test("an unpredicated MR rule fires on its named actions; a predicated one still needs the label added", () => {
	assert.equal(run(mrPayload()).job.flow, "autoreview", "action open matches the unpredicated rule");
	assert.equal(run(mrPayload({ object_attributes: { iid: 12, title: "MR", description: "D", action: "approved", labels: [] } })).job.flow, "autoreview");

	const labelled = mrPayload({
		object_attributes: { iid: 12, title: "MR", description: "D", action: "update", labels: [label("pi:review")] },
		changes: { labels: { previous: [], current: [label("pi:review")] } },
	});
	assert.equal(run(labelled).job.flow, "review");

	const plainUpdate = mrPayload({ object_attributes: { iid: 12, title: "MR", description: "D", action: "update", labels: [label("pi:review")] } });
	assert.equal(run(plainUpdate).enqueue, false, "an update that added no label must not match the label-gated rule");
});

test("a comment override names a known flow; an unknown one falls back to the default", () => {
	assert.equal(run(notePayload({ object_attributes: { action: "create", note: "@pi docs", noteable_type: "Issue" } })).job.flow, "docs");
	assert.equal(run(notePayload({ object_attributes: { action: "create", note: "@pi nonesuch", noteable_type: "Issue" } })).job.flow, "triage");
});

test("unhandled object kinds and actions drop with a reason, never silently", () => {
	assert.equal(run({ ...issuePayload(), object_kind: "push" }).reason, "unhandled-event");
	assert.equal(run(mrPayload({ object_attributes: { iid: 1, action: "merge", labels: [] } })).reason, "unhandled-event");
	assert.equal(run(notePayload({ object_attributes: { action: "update", note: "@pi", noteable_type: "Issue" } })).reason, "unhandled-event");
});

// --- the job ---

test("the job carries the numeric project id and the iid, and never the username", () => {
	const r = run(issuePayload());
	assert.equal(r.job.projectId, 42, "every GitLab API path takes the numeric id");
	assert.equal(r.job.repo, "group/sub/proj", "the nested path survives intact -- it is a label, never split");
	assert.equal(r.job.target.number, 5, "iid, not the global id");
	assert.equal("username" in r.job.trigger.sender, false, "username is personal data with no downstream reader");
	assert.equal(JSON.stringify(r.job).includes("dev"), false, "no part of the job may carry the actor's username");
});

test("packages and image ride the JOB from the matched rule, never inside trigger", () => {
	const t = {
		...triggers,
		label: [{ index: 2, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix", packages: false, image: "my-python:1.2.0" }],
	};
	const r = filterGitLab(parseGitLabSubset(issuePayload()), t, knownFlows, SELF_ID, true, "wh-9");
	assert.equal(r.job.packages, false);
	assert.equal(r.job.image, "my-python:1.2.0");
	// `trigger` is copied verbatim into /job/event.json; an execution knob has no business describing the
	// agent's own view of what fired it.
	assert.equal("image" in r.job.trigger, false);
	assert.equal("packages" in r.job.trigger, false);
});

test("an unflagged rule yields a job with no packages or image key at all", () => {
	const r = run(issuePayload());
	assert.deepEqual(Object.keys(r.job), ["repo", "projectId", "target", "flow", "trigger"]);
});

// --- run.command rules (issue #189): the matched rule dispatches a registered pi extension command ---

// Grouped exactly as loadReceiverConfig emits command rules: `flow`/`defaultFlow` are own-keys holding
// undefined (config.mjs enumerates every field by name), `command` is the line the worker forwards as
// PI_COMMAND. Deliberately MIXED with a flow rule: the channel is decided per RULE, by whichever matched.
const cmdTriggers = {
	label: [
		{ index: 1, predicate: { any: ["pi:standup"] }, flow: undefined, command: "standup" },
		{ index: 2, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix", command: undefined },
	],
	comment: { index: 4, phrase: "@pi", defaultFlow: undefined, command: "wf run nightly" },
	pullRequest: [{ index: 8, actions: new Set(["open"]), predicate: {}, flow: undefined, command: "check" }],
};
const runCmd = (payload) => filterGitLab(parseGitLabSubset(payload), cmdTriggers, knownFlows, SELF_ID, true, "wh-cmd");

test("a note command rule fires on the phrase alone -- command on the JOB, no flow key anywhere", () => {
	// The sharp half of this pin is the config shape: defaultFlow undefined plus a bare phrase is EXACTLY
	// what routeNote refuses as `no-flow` on a flow rule. On a command rule that refusal must be unreachable.
	const r = runCmd(notePayload({ object_attributes: { action: "create", note: "@pi", noteable_type: "Issue" } }));
	assert.equal(r.enqueue, true, "no-flow must be unreachable for a command rule");
	assert.equal(r.job.command, "wf run nightly");
	assert.equal("flow" in r.job, false, "a command job carries NO flow key -- absent, not present-and-undefined");
	assert.deepEqual(Object.keys(r.job), ["repo", "projectId", "target", "command", "trigger"]);
	assert.deepEqual(r.job.trigger.matched, { index: 4, type: "comment", phrase: "@pi" });
});

test("the `<phrase> <word>` override channel is INERT on a command rule -- trailing words neither retarget nor veto", () => {
	// "docs" IS a known flow here. On a flow rule this note would run `docs`; on a command rule it must
	// not -- an authorized member may INVOKE the trigger, never re-aim it at a flow its author did not name.
	const retarget = runCmd(notePayload({ object_attributes: { action: "create", note: "@pi docs", noteable_type: "Issue" } }));
	assert.equal(retarget.enqueue, true);
	assert.equal(retarget.job.command, "wf run nightly");
	assert.equal("flow" in retarget.job, false, "a known flow name after the phrase must not turn a command job into a flow job");

	// And an unknown trailing word must not SUPPRESS the command via the no-flow arm: trailing text is
	// data, riding trigger.comment into /job/event.json for the handler to read.
	const noise = runCmd(notePayload({ object_attributes: { action: "create", note: "@pi nonesuch entirely", noteable_type: "Issue" } }));
	assert.equal(noise.enqueue, true, "a trailing non-flow word must not become a no-flow refusal");
	assert.equal(noise.job.command, "wf run nightly");
	assert.deepEqual(noise.job.trigger.comment, { body: "@pi nonesuch entirely" });
});

test("label and merge-request command rules enqueue command jobs -- command at JOB level, never inside trigger", () => {
	const standup = issuePayload({
		object_attributes: { iid: 5, title: "T", description: "B", action: "update", labels: [label("pi:standup")] },
		changes: { labels: { previous: [], current: [label("pi:standup")] } },
	});
	const labeled = runCmd(standup);
	assert.equal(labeled.enqueue, true);
	assert.equal(labeled.job.command, "standup");
	assert.equal("flow" in labeled.job, false);
	assert.equal("command" in labeled.job.trigger, false, "an execution knob, never inside trigger/event.json");
	assert.deepEqual(labeled.job.trigger.matched, { index: 1, type: "label", label: "pi:standup" });

	const mr = runCmd(mrPayload());
	assert.equal(mr.enqueue, true);
	assert.equal(mr.job.command, "check");
	assert.equal("flow" in mr.job, false);
	assert.equal("command" in mr.job.trigger, false);
	assert.deepEqual(mr.job.trigger.matched, { index: 8, type: "pull_request", action: "open" });
});

test("a mixed group routes per rule: the flow label rule still emits a byte-identical flow job beside the command rules", () => {
	const r = runCmd(issuePayload());
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "frontend-fix");
	assert.equal("command" in r.job, false, "a flow job grows no command key -- its enqueued bytes must not change");
	assert.deepEqual(Object.keys(r.job), ["repo", "projectId", "target", "flow", "trigger"]);
});

// --- run.replicas rides the matched rule onto the job (REQ-REPLICA-RUNS, #187) ---

test("gitlab: replicas rides the matched rule onto the job, at JOB level and never inside trigger", () => {
	// receiver.mjs reads job.replicas to decide how many times to enqueue. Inside `trigger` it would be
	// copied verbatim into /job/event.json instead, where a count of jobs to create is not a fact about the
	// delivery -- and the fanout would silently be one, which is the shape this whole feature exists to avoid.
	const t = { ...triggers, label: [{ index: 2, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix", replicas: 2 }] };
	const r = filterGitLab(parseGitLabSubset(issuePayload()), t, knownFlows, SELF_ID, true, "wh-9");
	assert.equal(r.job.replicas, 2);
	assert.equal("replicas" in r.job.trigger, false);
});

test("gitlab: an unflagged rule emits no replicas key at all -- absent, not present-and-undefined", () => {
	assert.equal("replicas" in run(issuePayload()).job, false);
});
