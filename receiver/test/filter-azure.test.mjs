import assert from "node:assert/strict";
import { test } from "node:test";
import { filterAzure } from "../src/filter-azure.mjs";
import { actorOf, extractEmail, parseAzureSubset, parseTags, tagChange } from "../src/azure-subset.mjs";

const SELF = { id: "self-guid", email: "pi-bot@example.com" };
const MEMBER = "member-guid";
const PROJECT = { id: "proj-guid", baseUrl: "https://dev.azure.com/contoso/" };

const triggers = {
	label: [{ index: 0, predicate: { any: ["pi:go"] }, flow: "fix", repository: "widgets" }],
	comment: { index: 1, phrase: "@pi", defaultFlow: "triage", repository: "widgets" },
	pullRequest: [{ index: 2, actions: new Set(["created", "updated"]), predicate: null, flow: "review" }],
};
const knownFlows = new Set(["fix", "triage", "review"]);

const workItem = (over = {}) => ({
	id: "delivery-guid",
	eventType: "workitem.updated",
	resourceContainers: { project: PROJECT },
	resource: {
		id: 7,
		fields: {
			"System.ChangedBy": { oldValue: "A <a@example.com>", newValue: "Dev Person <dev@example.com>" },
			"System.Tags": { oldValue: "", newValue: "pi:go" },
		},
		revision: { fields: { "System.Title": "T", "System.Description": "B", "System.Tags": "pi:go", "System.TeamProject": "Fabrikam" } },
	},
	...over,
});

const pullRequest = (over = {}) => ({
	id: "delivery-guid",
	eventType: "git.pullrequest.created",
	resourceContainers: { project: PROJECT },
	resource: {
		pullRequestId: 12,
		title: "PT",
		description: "PB",
		sourceRefName: "refs/heads/feature",
		targetRefName: "refs/heads/main",
		createdBy: { id: MEMBER },
		repository: { id: "repo-guid", name: "widgets", project: { id: "proj-guid", name: "Fabrikam" } },
	},
	...over,
});

const run = (payload, { authorized = true, selfId = SELF } = {}) =>
	filterAzure(parseAzureSubset(payload), triggers, knownFlows, selfId, authorized, "delivery-guid");

// --- the tag DIFF, which is the expensive thing to get wrong ---

test("a work-item update that ADDS an allowlisted tag enqueues", () => {
	const r = run(workItem());
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "fix");
	assert.equal(r.job.repo, "Fabrikam/widgets", "the project comes from the payload; the repository from run.repository");
	assert.deepEqual(r.job.azure, { project: "Fabrikam", projectId: "proj-guid", repository: "widgets" });
});

test("an update that changed NO tags never enqueues -- the trap that would bill a run per typo fix", () => {
	// Azure has no `labeled` event. Matching the current tag SET instead of the change would fire this
	// trigger again on every later edit of any field on a tagged work item, forever.
	const noTagChange = workItem({
		resource: {
			id: 7,
			fields: { "System.ChangedBy": { oldValue: "A <a@example.com>", newValue: "Dev Person <dev@example.com>" }, "System.Title": { oldValue: "T", newValue: "T2" } },
			revision: { fields: { "System.Title": "T2", "System.Tags": "pi:go", "System.TeamProject": "Fabrikam" } },
		},
	});
	const r = run(noTagChange);
	assert.equal(r.enqueue, false, "the work item still CARRIES pi:go -- matching the set would fire here");
	assert.equal(r.reason, "no-label-change");
});

test("a tag REMOVAL never enqueues -- the same rule Forgejo's label_cleared gets", () => {
	const removed = workItem({
		resource: {
			id: 7,
			fields: { "System.ChangedBy": { newValue: "Dev <dev@example.com>" }, "System.Tags": { oldValue: "pi:go;other", newValue: "other" } },
			revision: { fields: { "System.Tags": "other", "System.TeamProject": "Fabrikam" } },
		},
	});
	assert.equal(run(removed).reason, "no-label-change");
});

test("a work item CREATED already carrying the tag enqueues -- it changed from having none", () => {
	const created = {
		id: "d",
		eventType: "workitem.created",
		resourceContainers: { project: PROJECT },
		resource: { id: 7, fields: { "System.CreatedBy": "Dev <dev@example.com>", "System.Tags": "pi:go", "System.Title": "T", "System.TeamProject": "Fabrikam" } },
	};
	assert.equal(run(created).enqueue, true);
});

test("tagChange and parseTags handle both spacings and an absent previous value", () => {
	// Which separator spacing Azure uses has varied across versions; a tag list that silently matched
	// nothing because of a space would look exactly like a trigger nobody armed.
	assert.deepEqual(parseTags("a;b"), [{ name: "a" }, { name: "b" }]);
	assert.deepEqual(parseTags("a; b ; "), [{ name: "a" }, { name: "b" }]);
	assert.deepEqual(parseTags(undefined), []);
	assert.deepEqual(tagChange({ "System.Tags": { newValue: "a" } }), { previous: [], current: [{ name: "a" }] }, "a first tag on an untagged item is a real change");
	assert.equal(tagChange({}), undefined, "no tag field at all is not a change");
});

// --- the dual-identity bot-loop guard ---

test("the harness's own work-item comment drops as self, matched on the ADDRESS", () => {
	// A work-item payload names the actor only as "Display Name <email>". If the guard compared only GUIDs
	// it would never match here, and the harness's own status comments would re-trigger jobs whose comments
	// re-trigger jobs.
	const own = workItem({
		eventType: "workitem.commented",
		resource: {
			id: 7,
			fields: { "System.ChangedBy": "pi-dispatch <PI-BOT@Example.com>", "System.History": "@pi done" },
			revision: { fields: { "System.TeamProject": "Fabrikam" } },
		},
	});
	assert.equal(run(own).reason, "self", "compared case-insensitively -- Azure does not normalise case");
});

test("a display name CONTAINING the bot address is not the bot -- the spoofable-substring case", () => {
	// The display half is attacker-settable. A substring test would let this read as the harness (silencing
	// a real trigger) or, on the authority side, as somebody else entirely.
	const impostor = workItem({
		eventType: "workitem.commented",
		resource: {
			id: 7,
			fields: { "System.ChangedBy": "pi-bot@example.com is not me <mallory@evil.test>", "System.History": "@pi run" },
			revision: { fields: { "System.TeamProject": "Fabrikam" } },
		},
	});
	const r = run(impostor);
	assert.notEqual(r.reason, "self", "the anchored match must read the address, not the display name");
	assert.equal(r.enqueue, true);
});

test("the harness's own pull-request activity drops as self, matched on the GUID", () => {
	assert.equal(run(pullRequest({ resource: { ...pullRequest().resource, createdBy: { id: SELF.id } } })).reason, "self");
});

test("an EMPTY side of selfId never matches -- a half-resolved identity must not match every actor", () => {
	// resolveAzureSelfId tolerates one of the two forms being absent. That must degrade to "cannot
	// recognise myself on those events", never to "everybody is me".
	const halfGuid = run(workItem(), { selfId: { id: "self-guid", email: null } });
	assert.equal(halfGuid.enqueue, true, "an email-only actor must not match a null self email");
	const halfEmail = run(pullRequest(), { selfId: { id: null, email: "pi-bot@example.com" } });
	assert.equal(halfEmail.enqueue, true, "a guid-only actor must not match a null self guid");
});

test("an actor that resolves to NEITHER form is refused before the self compare", () => {
	const anonymous = workItem({ resource: { id: 7, fields: { "System.Tags": { newValue: "pi:go" } }, revision: { fields: { "System.TeamProject": "Fabrikam" } } } });
	assert.equal(run(anonymous).reason, "missing-sender-id");
});

test("extractEmail is anchored, lowercases, and refuses a bare display name", () => {
	assert.equal(extractEmail("Dev Person <Dev@Example.com>"), "dev@example.com");
	assert.equal(extractEmail("dev@example.com"), "dev@example.com");
	assert.equal(extractEmail("a@b.test <c@d.test>"), "c@d.test", "the TRAILING angle-bracketed address wins");
	assert.equal(extractEmail("Dev Person"), null);
	assert.equal(extractEmail(undefined), null);
});

test("actorOf prefers a GUID and falls back to the address", () => {
	assert.deepEqual(actorOf({ resource: { createdBy: { id: "g" } } }), { id: "g" });
	assert.deepEqual(actorOf({ resource: { fields: { "System.ChangedBy": "D <e@f.test>" } } }), { email: "e@f.test" });
	assert.deepEqual(actorOf({ resource: {} }), {});
});

// --- the gate and routing ---

test("an unauthorized actor is refused on EVERY trigger type", () => {
	for (const [name, payload] of [["work item", workItem()], ["pull request", pullRequest()]]) {
		const r = run(payload, { authorized: false });
		assert.equal(r.reason, "author-not-allowed", name);
	}
});

test("only an explicit `true` clears the gate", () => {
	for (const authorized of [undefined, null, "true", 1, {}]) {
		const r = filterAzure(parseAzureSubset(workItem()), triggers, knownFlows, SELF, authorized, "d");
		assert.equal(r.enqueue, false, `a ${JSON.stringify(authorized)} verdict must fail closed`);
	}
});

test("a pull request event uses the payload's own repository, never run.repository", () => {
	const r = run(pullRequest());
	assert.equal(r.job.repo, "Fabrikam/widgets");
	assert.equal(r.job.azure.repositoryId, "repo-guid", "the id the git APIs actually take");
	assert.equal(r.job.target.head.ref, "feature", "refs/heads/ is stripped -- the rest of this codebase does not qualify refs");
});

test("a pull-request comment routes a pull_request target and carries the comment text", () => {
	const commented = {
		id: "d",
		eventType: "ms.vss-code.git-pullrequest-comment-event",
		resourceContainers: { project: PROJECT },
		resource: {
			comment: { content: "@pi please look", author: { id: MEMBER } },
			pullRequest: { pullRequestId: 12, title: "PT", description: "PB", repository: { id: "repo-guid", name: "widgets", project: { name: "Fabrikam" } } },
		},
	};
	const r = run(commented);
	assert.equal(r.enqueue, true);
	assert.equal(r.job.target.type, "pull_request");
	assert.equal(r.job.flow, "triage");
});

test("an unhandled event id drops rather than routing somewhere plausible", () => {
	assert.equal(run(workItem({ eventType: "git.push" })).reason, "unhandled-event");
	assert.equal(run(workItem({ eventType: "workitem.deleted" })).reason, "unhandled-event");
});

test("the job carries no email address -- an opaque stable id stands in for it", () => {
	// The job is copied verbatim into /job/event.json and summarised into the durable run record, both of
	// which are PII-free BY CONSTRUCTION. A work-item payload offers nothing but "Display Name <email>",
	// so the address is hashed rather than carried.
	const r = run(workItem());
	const serialized = JSON.stringify(r.job);
	assert.equal(serialized.includes("dev@example.com"), false, "no address may reach event.json or the run record");
	assert.equal(serialized.includes("Dev Person"), false, "nor a display name");
	assert.match(r.job.trigger.sender.id, /^azid-[0-9a-f]{16}$/);
});

test("the same actor hashes to the same id, and a different one does not", () => {
	// The id has one job: letting two records be compared for "same person". A per-delivery value would
	// look identical in a single record and be useless across two.
	const a = run(workItem()).job.trigger.sender.id;
	const b = run(workItem()).job.trigger.sender.id;
	assert.equal(a, b);
	const other = workItem({
		resource: {
			id: 7,
			fields: { "System.ChangedBy": { newValue: "Other <other@example.com>" }, "System.Tags": { oldValue: "", newValue: "pi:go" } },
			revision: { fields: { "System.Tags": "pi:go", "System.TeamProject": "Fabrikam" } },
		},
	});
	assert.notEqual(run(other).job.trigger.sender.id, a);
});

test("a pull-request job still carries the GUID verbatim -- it is already opaque", () => {
	assert.equal(run(pullRequest()).job.trigger.sender.id, MEMBER);
});

// --- run.command rules (issue #189): the matched rule dispatches a registered pi extension command ---

// Grouped exactly as loadReceiverConfig emits command rules: `flow`/`defaultFlow` are own-keys holding
// undefined (config.mjs enumerates every field by name), `command` is the line the worker forwards as
// PI_COMMAND. `repository` still rides the work-item rules: a command job clones like any other, and the
// loader requires the field on azure label/comment triggers whatever the dispatch channel.
const cmdTriggers = {
	label: [{ index: 0, predicate: { any: ["pi:go"] }, flow: undefined, command: "standup", repository: "widgets" }],
	comment: { index: 1, phrase: "@pi", defaultFlow: undefined, command: "wf run nightly", repository: "widgets" },
	pullRequest: [{ index: 2, actions: new Set(["created"]), predicate: null, flow: undefined, command: "check" }],
};
const runCmd = (payload) => filterAzure(parseAzureSubset(payload), cmdTriggers, knownFlows, SELF, true, "delivery-guid");

/** A `workitem.commented` delivery carrying `body` as the comment text. */
const commented = (body) => workItem({
	eventType: "workitem.commented",
	resource: {
		id: 7,
		fields: { "System.ChangedBy": "Dev Person <dev@example.com>", "System.History": body },
		revision: { fields: { "System.Title": "T", "System.Description": "B", "System.TeamProject": "Fabrikam" } },
	},
});

test("a comment command rule fires on the phrase alone -- command on the JOB, no flow key anywhere", () => {
	// defaultFlow undefined plus a bare phrase is EXACTLY what routeComment refuses as `no-flow` on a flow
	// rule. On a command rule that refusal must be unreachable -- there is no flow to resolve.
	const r = runCmd(commented("@pi"));
	assert.equal(r.enqueue, true, "no-flow must be unreachable for a command rule");
	assert.equal(r.job.command, "wf run nightly");
	assert.equal("flow" in r.job, false, "a command job carries NO flow key -- absent, not present-and-undefined");
	assert.deepEqual(Object.keys(r.job), ["repo", "azure", "target", "command", "trigger"]);
	assert.deepEqual(r.job.trigger.matched, { index: 1, type: "comment", phrase: "@pi" });
});

test("the `<phrase> <word>` override channel is INERT on a command rule -- trailing words neither retarget nor veto", () => {
	// "fix" IS a known flow here. On a flow rule this comment would run `fix`; on a command rule it must
	// not -- an authorized member may INVOKE the trigger, never re-aim it at a flow its author did not name.
	const retarget = runCmd(commented("@pi fix"));
	assert.equal(retarget.enqueue, true);
	assert.equal(retarget.job.command, "wf run nightly");
	assert.equal("flow" in retarget.job, false, "a known flow name after the phrase must not turn a command job into a flow job");

	// And an unknown trailing word must not SUPPRESS the command via the no-flow arm: trailing text is
	// data, riding trigger.comment into /job/event.json for the handler to read.
	const noise = runCmd(commented("@pi nonesuch entirely"));
	assert.equal(noise.enqueue, true, "a trailing non-flow word must not become a no-flow refusal");
	assert.equal(noise.job.command, "wf run nightly");
	assert.deepEqual(noise.job.trigger.comment, { body: "@pi nonesuch entirely" });
});

test("tag and pull_request command rules enqueue command jobs -- command at JOB level, never inside trigger", () => {
	const tagged = runCmd(workItem());
	assert.equal(tagged.enqueue, true);
	assert.equal(tagged.job.command, "standup");
	assert.equal("flow" in tagged.job, false);
	assert.equal("command" in tagged.job.trigger, false, "an execution knob, never inside trigger/event.json");
	assert.equal(tagged.job.repo, "Fabrikam/widgets", "run.repository still resolves the clone scope for a command job");
	assert.deepEqual(tagged.job.trigger.matched, { index: 0, type: "label", label: "pi:go" });

	const pr = runCmd(pullRequest());
	assert.equal(pr.enqueue, true);
	assert.equal(pr.job.command, "check");
	assert.equal("flow" in pr.job, false);
	assert.equal("command" in pr.job.trigger, false);
	assert.deepEqual(pr.job.trigger.matched, { index: 2, type: "pull_request", action: "created" });
});

test("a flow rule still emits a byte-identical flow job -- no command key, same key order as always", () => {
	// The original flow fixtures, untouched by the feature: the conditional spread must leave their
	// enqueued bytes exactly as they were.
	const r = run(workItem());
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "fix");
	assert.equal("command" in r.job, false, "a flow job grows no command key");
	assert.deepEqual(Object.keys(r.job), ["repo", "azure", "target", "flow", "trigger"]);
});

// --- run.replicas rides the matched rule onto the job (REQ-REPLICA-RUNS, #187) ---

test("azure: replicas rides the matched rule onto the job, at JOB level and never inside trigger", () => {
	const t = { ...triggers, label: [{ ...triggers.label[0], replicas: 2 }] };
	const r = filterAzure(parseAzureSubset(workItem()), t, knownFlows, SELF, true, "delivery-guid");
	assert.equal(r.job.replicas, 2);
	assert.equal("replicas" in r.job.trigger, false);
});

test("azure: an unflagged rule emits no replicas key at all -- absent, not present-and-undefined", () => {
	assert.equal("replicas" in run(workItem()).job, false);
});

test("secrets and secretsProfile ride the JOB from the matched rule, never inside trigger (#225)", () => {
	const t = { ...triggers, label: [{ index: 0, predicate: { any: ["pi:go"] }, flow: "fix", repository: "widgets", secrets: { STRIPE_KEY: "op://ci/stripe/api-key" }, secretsProfile: "prod" }] };
	const r = filterAzure(parseAzureSubset(workItem()), t, knownFlows, SELF, true, "az-secrets");
	assert.equal(r.enqueue, true);
	assert.deepEqual(r.job.secrets, { STRIPE_KEY: "op://ci/stripe/api-key" });
	assert.equal(r.job.secretsProfile, "prod");
	// `trigger` is copied verbatim into /job/event.json, which the agent reads: a reference list there
	// would hand it the map of the operator's vault.
	assert.equal("secrets" in r.job.trigger, false);
	assert.equal("secretsProfile" in r.job.trigger, false);
});
