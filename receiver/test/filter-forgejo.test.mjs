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
	//
	// EVOLUTION (issue #231): `closed` is no longer in this list. It sat in IGNORED_ACTIONS until close
	// triggers made it routable; a close with nothing armed now drops `no-matching-close-trigger` (pinned
	// below, in the close section) where it used to drop `action-not-actionable`.
	for (const action of ["edited", "assigned", "reviewed", "milestoned"]) {
		assert.equal(run("issues", issuePayload({ action })).reason, "action-not-actionable", action);
	}
	for (const action of ["banana", "", "labeled", "synchronize"]) {
		// Note `labeled` and `synchronize`: GitHub's words are NOT Forgejo's, and a payload carrying them is
		// not something Forgejo sends.
		assert.equal(run("issues", issuePayload({ action })).reason, "unhandled-event", action);
	}
});

test("mapAction and isRecognizedAction agree on what the map covers", () => {
	for (const action of ["label_updated", "opened", "reopened", "closed"]) {
		assert.notEqual(mapAction("issues", action), null, `${action} maps`);
		assert.equal(isRecognizedAction(action), true);
	}
	assert.equal(mapAction("issues", "label_cleared"), null, "maps to nothing, permanently");
	assert.equal(isRecognizedAction("label_cleared"), true, "but it IS recognised, which is why it gets its own reason");
	assert.equal(mapAction("issues", "synchronized"), null, "synchronized is a pull_request action, not an issue one");
	assert.notEqual(mapAction("pull_request", "synchronized"), null);
	// `closed` moved OUT of the ignored set when issue #231 made it routable: it must map on BOTH events
	// (the maps are selected by event name, so this is two routes sharing a spelling, not a double
	// listing) -- were it still ignored too, the drop table would claim "ignored" for a word that routes.
	assert.equal(mapAction("issues", "closed"), "closed");
	assert.equal(mapAction("pull_request", "closed"), "closed");
	assert.equal(isRecognizedAction("closed"), true);
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

// --- close triggers (issue #231): `closed` routes over the loader's split-out issue/prClose groups ---

// Grouped exactly as loadReceiverConfig emits close rules: `issue` holds the on.type "issue" rules,
// `prClose` the pull_request rules whose action list is the close word -- split from `pullRequest` at
// load, so neither close route and neither classic route can ever read the other's rules. `number` and
// `once` ride as the loader normalized them (absent stays undefined).
const closeTriggersRaw = {
	...triggersRaw,
	issue: [
		{ index: 4, actions: new Set(["closed"]), number: 7, once: true, flow: "wrapup" },
		{ index: 5, actions: new Set(["closed"]), number: undefined, once: undefined, flow: "sweep" },
	],
	prClose: [{ index: 6, actions: new Set(["closed"]), number: undefined, once: undefined, flow: "pr-wrap" }],
};
const runClose = (eventName, payload, { authorized = true } = {}) =>
	filterForgejo(eventName, parseForgejoSubset(payload), closeTriggersRaw, knownFlows, SELF_ID, authorized, "fj-1");

test("an issue `closed` fires the armed close rule, and a one-shot says so on matched", () => {
	const r = runClose("issues", issuePayload({ action: "closed" }));
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "wrapup", "the number-7 rule is first in file order and names this item");
	// `once: true` is what tells the enqueue path a disarm is owed -- lose it here and the one-shot
	// fires forever while the file still says once.
	assert.deepEqual(r.job.trigger.matched, { index: 4, type: "issue", action: "closed", number: 7, once: true });
	assert.equal(r.job.trigger.action, "closed", "the record says what the forge said");
	assert.deepEqual(r.job.target, { type: "issue", number: 7, title: "T", body: "B" });
});

test("an unnarrowed close rule takes any other item's close -- and matched carries NO once key", () => {
	const r = runClose("issues", issuePayload({ action: "closed", issue: { number: 9, title: "T9", body: "B9", labels: [] } }));
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "sweep", "the narrowed rule skipped #9; the unnarrowed one is next in file order");
	// Absent, never present-and-undefined: a plain close rule's matched record must stay byte-identical
	// in shape to the other routes', or every serialized job grows a key today's consumers never saw.
	assert.deepEqual(r.job.trigger.matched, { index: 5, type: "issue", action: "closed", number: 9 });
});

test("a pull_request `closed` fires the prClose rule with a full PR target", () => {
	const r = runClose("pull_request", prPayload({ action: "closed" }));
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "pr-wrap");
	// No `number` on a PR close's matched record, parallel to the classic PR route's -- the item number
	// is the target's business.
	assert.deepEqual(r.job.trigger.matched, { index: 6, type: "pull_request", action: "closed" });
	assert.equal(r.job.target.type, "pull_request");
	assert.equal(r.job.target.number, 12);
	assert.equal(r.job.target.head.sha, "abc", "the flow's event.json still gets head/base, same as any PR route");
});

test("a close rule narrowed to ANOTHER item refuses under its own token", () => {
	// `close-number-not-matched` and `no-matching-close-trigger` call for different operator responses:
	// "your one-shot exists and a different item closed" is not "nothing is armed", and a panel must be
	// able to tell them apart.
	const t = { ...triggersRaw, issue: [{ index: 4, actions: new Set(["closed"]), number: 8, once: true, flow: "wrapup" }] };
	const r = filterForgejo("issues", parseForgejoSubset(issuePayload({ action: "closed" })), t, knownFlows, SELF_ID, true, "fj-1");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "close-number-not-matched");
});

test("a `closed` with nothing armed drops `no-matching-close-trigger` -- it used to be `action-not-actionable`", () => {
	// EVOLUTION (issue #231): `closed` sat in IGNORED_ACTIONS, so this exact delivery dropped as
	// "recognised and deliberately ignored". Now the word routes, and the reason names what an operator
	// should actually check: no close rule is armed for this item. `triggersRaw` has no issue/prClose
	// groups at all, which is also the every-deployment-before-this-feature shape.
	assert.equal(run("issues", issuePayload({ action: "closed" })).reason, "no-matching-close-trigger");
	assert.equal(run("pull_request", prPayload({ action: "closed" })).reason, "no-matching-close-trigger");
});

test("an unauthorized sender's close dies at the GLOBAL gate: author-not-allowed, never closer-not-allowed", () => {
	// On a webhook close delivery the sender IS the closer, so the pre-route authority gate already
	// refused this actor before any close route ran. The route's own closer gate is belt-and-braces
	// against resolver-shape drift and must stay UNREACHABLE here -- if this ever reports
	// closer-not-allowed, the global gate moved.
	for (const [event, payload] of [["issues", issuePayload({ action: "closed" })], ["pull_request", prPayload({ action: "closed" })]]) {
		const r = runClose(event, payload, { authorized: false });
		assert.equal(r.enqueue, false);
		assert.equal(r.reason, "author-not-allowed");
	}
});

test("arming close rules changes label and PR routing not at all -- byte-identical jobs", () => {
	// The close groups are SEPARATE arrays the classic routes never read; adding them to a deployment
	// must not perturb one byte of what an existing trigger enqueues, or every dedup key and every
	// downstream consumer shifts under an operator who only added a close rule.
	for (const [event, payload] of [["issues", issuePayload()], ["pull_request", prPayload()]]) {
		const plain = run(event, payload);
		const armed = runClose(event, payload);
		assert.equal(JSON.stringify(armed.job), JSON.stringify(plain.job));
	}
});
