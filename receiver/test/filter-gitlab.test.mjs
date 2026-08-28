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

test("secrets and secretsProfile ride the JOB from the matched rule, never inside trigger (#225)", () => {
	const t = {
		...triggers,
		label: [{ index: 2, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix", secrets: { STRIPE_KEY: "op://ci/stripe/api-key" }, secretsProfile: "prod" }],
	};
	const r = filterGitLab(parseGitLabSubset(issuePayload()), t, knownFlows, SELF_ID, true, "wh-9");
	assert.deepEqual(r.job.secrets, { STRIPE_KEY: "op://ci/stripe/api-key" });
	assert.equal(r.job.secretsProfile, "prod");
	// `trigger` is copied verbatim into /job/event.json, which the AGENT reads. A reference list there
	// would hand the agent the map of the operator's vault, which is the one thing this feature is for
	// not doing. It rides the job for packages/image's reason, and for a sharper one.
	assert.equal("secrets" in r.job.trigger, false);
	assert.equal("secretsProfile" in r.job.trigger, false);
});

test("the receiver enqueues REFERENCES and never a value -- it has no resolver at all (#225)", () => {
	// The receiver runs on the trigger edge, often on a different host, and holds no manager credential.
	// Resolution is the worker's, pre-spend. This pins the division: whatever the operator wrote in the
	// file is what lands on the queue, verbatim and unresolved.
	const reference = "op://ci-vault/stripe/api-key";
	const t = { ...triggers, label: [{ index: 2, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix", secrets: { A: reference } }] };
	const r = filterGitLab(parseGitLabSubset(issuePayload()), t, knownFlows, SELF_ID, true, "wh-9");
	assert.equal(r.job.secrets.A, reference);
	assert.equal("secretsProfile" in r.job, false, "an unset profile stays absent, never present-and-undefined");
});

// --- close triggers (issue #231): `close` routes over the loader's split-out issue/prClose groups ---

// Grouped exactly as loadReceiverConfig emits close rules: `issue` holds the on.type "issue" rules,
// `prClose` the pull_request rules whose action list is the close word ("close" -- GitLab's own word,
// not GitHub's "closed") -- split from `pullRequest` at load, so neither close route and neither classic
// route can ever read the other's rules. `number`/`once` ride as the loader normalized them.
const closeTriggers = {
	...triggers,
	issue: [
		{ index: 10, actions: new Set(["close"]), number: 5, once: true, flow: "wrapup" },
		{ index: 11, actions: new Set(["close"]), number: undefined, once: undefined, flow: "sweep" },
	],
	prClose: [{ index: 12, actions: new Set(["close"]), number: undefined, once: undefined, flow: "mr-wrap" }],
};
const runClose = (payload, { authorized = true } = {}) => filterGitLab(parseGitLabSubset(payload), closeTriggers, knownFlows, SELF_ID, authorized, "wh-1");

/** An issue `close` delivery that moved NO labels: `changes` empty, which is how GitLab sends a plain close. */
const issueClosePayload = (over = {}) =>
	issuePayload({
		object_attributes: { iid: 5, title: "T", description: "B", action: "close", labels: [] },
		changes: {},
		...over,
	});

test("an issue `close` fires the armed close rule, and a one-shot says so on matched", () => {
	const r = runClose(issueClosePayload());
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "wrapup", "the iid-5 rule is first in file order and names this item");
	// `once: true` is what tells the enqueue path a disarm is owed -- lose it here and the one-shot
	// fires forever while the file still says once.
	assert.deepEqual(r.job.trigger.matched, { index: 10, type: "issue", action: "close", number: 5, once: true });
	assert.equal(r.job.trigger.action, "close", "the record says what the forge said");
	assert.deepEqual(r.job.target, { type: "issue", number: 5, title: "T", body: "B" });
});

test("an unnarrowed close rule takes any other item's close -- and matched carries NO once key", () => {
	const r = runClose(issueClosePayload({ object_attributes: { iid: 9, title: "T9", description: "B9", action: "close", labels: [] } }));
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "sweep", "the narrowed rule skipped iid 9; the unnarrowed one is next in file order");
	// Absent, never present-and-undefined: a plain close rule's matched record must stay byte-identical
	// in shape to the other routes', or every serialized job grows a key today's consumers never saw.
	assert.deepEqual(r.job.trigger.matched, { index: 11, type: "issue", action: "close", number: 9 });
});

test("a merge request `close` fires the prClose rule", () => {
	const r = runClose(mrPayload({ object_attributes: { iid: 12, title: "MR", description: "D", action: "close", labels: [] } }));
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "mr-wrap");
	// No `number` on an MR close's matched record, parallel to the classic MR route's -- the item number
	// is the target's business.
	assert.deepEqual(r.job.trigger.matched, { index: 12, type: "pull_request", action: "close" });
	assert.deepEqual(r.job.target, { type: "pull_request", number: 12, title: "MR", body: "D" });
});

test("a close rule narrowed to ANOTHER item refuses under its own token", () => {
	// `close-number-not-matched` and `no-matching-close-trigger` call for different operator responses:
	// "your one-shot exists and a different item closed" is not "nothing is armed", and a panel must be
	// able to tell them apart.
	const t = { ...triggers, issue: [{ index: 10, actions: new Set(["close"]), number: 8, once: true, flow: "wrapup" }] };
	const r = filterGitLab(parseGitLabSubset(issueClosePayload()), t, knownFlows, SELF_ID, true, "wh-1");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "close-number-not-matched");
});

test("an issue `close` with nothing armed and no label movement drops `no-matching-close-trigger` -- it used to be `no-label-change`", () => {
	// EVOLUTION (issue #231): before close routing, an issue `close` walked routeLabel like any other
	// non-open action, found no `changes.labels`, and dropped as `no-label-change` -- a reason about a
	// label event this never was. Now the close route answers first, and the reason names what an
	// operator should actually check: no close rule is armed for this item.
	const r = run(issueClosePayload());
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-matching-close-trigger");
});

test("a merge request `close` with nothing armed drops `no-matching-close-trigger` -- it used to be `unhandled-event`", () => {
	// EVOLUTION (issue #231): "close" was simply not in MR_ACTIONS, so a closing MR read as an event this
	// project had never heard of. It is heard of now; what is missing is a rule, and the reason says so.
	const r = run(mrPayload({ object_attributes: { iid: 12, title: "MR", description: "D", action: "close", labels: [] } }));
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-matching-close-trigger");
});

// A real GitLab delivery can close AND label in one call (a `/close /label ~x` quick action, or the
// sidebar edited during close). The pair below pins both halves of that coexistence: label rules keep
// firing on such closes exactly as they did before close routing existed, and an armed close rule takes
// the delivery INSTEAD -- one delivery, one job, close first, so the two rule kinds cannot double-bill
// a single click.
const closeAndLabelPayload = () =>
	issuePayload({
		object_attributes: { iid: 5, title: "T", description: "B", action: "close", labels: [label("pi:frontend")] },
		changes: { labels: { previous: [], current: [label("pi:frontend")] } },
	});

test("a close-and-label delivery with NO close rules fires the label rule byte-identically to today", () => {
	const r = run(closeAndLabelPayload());
	assert.equal(r.enqueue, true);
	// The FULL job literal, pinned: this is the byte-identity claim. The fallback hands the delivery to
	// routeLabel untouched, so nothing about the job -- not even trigger.action, which stays GitLab's
	// own "close" -- may differ from what this delivery enqueued before close routing existed.
	assert.deepEqual(r.job, {
		repo: "group/sub/proj",
		projectId: 42,
		target: { type: "issue", number: 5, title: "T", body: "B" },
		flow: "frontend-fix",
		trigger: {
			event: "issue",
			action: "close",
			deliveryId: "wh-1",
			sender: { id: MEMBER },
			matched: { index: 2, type: "label", label: "pi:frontend" },
		},
	});
});

test("a close-and-label delivery with a matching close rule fires the CLOSE rule and the label rule not at all", () => {
	const r = runClose(closeAndLabelPayload());
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "wrapup", "close takes precedence; the label rule must not also fire");
	assert.deepEqual(r.job.trigger.matched, { index: 10, type: "issue", action: "close", number: 5, once: true });
});

test("a close-and-label delivery whose close rule names ANOTHER item still fires the label rule", () => {
	// The fallback runs on ANY close refusal, number mismatch included: this delivery fired the label
	// rule before close routing existed, and a one-shot armed for a DIFFERENT item must not eat it.
	const t = { ...triggers, issue: [{ index: 10, actions: new Set(["close"]), number: 8, once: true, flow: "wrapup" }] };
	const r = filterGitLab(parseGitLabSubset(closeAndLabelPayload()), t, knownFlows, SELF_ID, true, "wh-1");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "frontend-fix");
	assert.deepEqual(r.job.trigger.matched, { index: 2, type: "label", label: "pi:frontend" });
});

test("an unauthorized actor's close dies at the GLOBAL gate: author-not-allowed, never closer-not-allowed", () => {
	// On a webhook close delivery the actor IS the closer, so the pre-route access gate already refused
	// them before any close route ran. The route's own closer gate is belt-and-braces against
	// resolver-shape drift and must stay UNREACHABLE here -- if this ever reports closer-not-allowed,
	// the global gate moved.
	for (const payload of [issueClosePayload(), closeAndLabelPayload(), mrPayload({ object_attributes: { iid: 12, title: "MR", description: "D", action: "close", labels: [] } })]) {
		const r = runClose(payload, { authorized: false });
		assert.equal(r.enqueue, false);
		assert.equal(r.reason, "author-not-allowed");
	}
});

test("an `update` still walks routeLabel byte-identically with close rules armed", () => {
	// The close arm keys on the action, so every non-close issue delivery must reach routeLabel exactly
	// as before -- arming a close rule must not perturb one byte of what a label trigger enqueues.
	const plain = run(issuePayload());
	const armed = runClose(issuePayload());
	assert.equal(plain.enqueue, true);
	assert.equal(JSON.stringify(armed.job), JSON.stringify(plain.job));
});
