import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { makeReceiver } from "../src/receiver.mjs";

/**
 * Issue #644: the worker may post ONE status comment per opted-in job and then EDIT it every 30 s or so. Every edit
 * is a comment event on the forge, so these pin, through the whole receiver (verify, parse, gate, enqueue), that an
 * edit of that comment enqueues nothing on any of the four forges.
 *
 * Two guards hold it, and each case is checked against both: the bot-loop guard (the editor is the harness's own
 * identity) and the comment route itself (only a CREATED comment routes; an edit is never a new request). The second
 * matters because a maintainer can edit someone else's comment on GitHub, and the status text could be edited to hold
 * the trigger phrase. A positive control per forge proves the same receiver does enqueue a new comment, so a drop is
 * never a harness that cannot enqueue at all.
 */

const SELF_ID = 999;
const MEMBER = 7;
const AZ_SELF = { id: "self-guid", email: "pi-bot@example.com" };
const AZ_MEMBER = "member-guid";
const GH_SECRET = "gh-secret";
const FJ_SECRET = "forgejo-secret";
const GL_TOKEN = "a-shared-secret";
const AZ_BASIC = Buffer.from("hooks:s3cret", "utf8").toString("base64");
const STATUS = "pi-dispatch job `abc`: running. Turn 7, 12 steps (1 failed). Phase 2 of 4 (3/10).";
const STATUS_WITH_PHRASE = `${STATUS} @pi triage`;

const comment = { index: 1, phrase: "@pi", defaultFlow: "triage" };
const empty = { label: [], comment: null, pullRequest: [] };
const cfg = {
	webhookSecret: GH_SECRET,
	servesGithub: true,
	triggers: {
		github: { ...empty, comment },
		gitlab: { ...empty, comment },
		forgejo: { ...empty, comment },
		azure: { ...empty, comment: { ...comment, repository: "widgets" } },
		knownFlows: new Set(["triage"]),
	},
};

const sign = (secret, raw) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

function mockRes() {
	return {
		statusCode: 0,
		headersSent: false,
		body: undefined,
		writeHead(s) {
			this.statusCode = s;
			this.headersSent = true;
		},
		end(b) {
			this.body = b;
		},
	};
}

/** One delivery through a fresh receiver serving all four forges; answers the jobs it enqueued and the logs. */
async function deliver({ url, headers, payload }) {
	const raw = JSON.stringify(payload);
	const calls = [];
	const logs = [];
	const handler = makeReceiver({
		queue: { add: async (name, data, opts) => (calls.push({ name, data, opts }), { id: opts?.jobId }) },
		selfId: SELF_ID,
		cfg,
		log: (o) => logs.push(o),
		gitlab: { mode: "token", secret: GL_TOKEN, selfId: SELF_ID, resolveAuthority: async () => ({ authorized: true }) },
		forgejo: { secret: FJ_SECRET, selfId: SELF_ID, resolveAuthority: async () => ({ authorized: true }) },
		azure: { mode: "basic", secret: AZ_BASIC, selfId: AZ_SELF, resolveAuthority: async () => ({ authorized: true }) },
	});
	const req = new EventEmitter();
	req.url = url;
	req.method = "POST";
	req.headers = { "content-type": "application/json", ...headers(raw) };
	req.destroy = () => {};
	const res = mockRes();
	const p = handler(req, res);
	req.emit("data", Buffer.from(raw, "utf8"));
	req.emit("end");
	await p;
	return { calls, logs, status: res.statusCode };
}

/** Assert a delivery enqueued nothing, was acknowledged, and dropped for `reason` (never a verify or parse failure). */
function assertDropped(r, reason, label = "") {
	assert.equal(r.calls.length, 0, `${label} enqueued`);
	assert.ok(r.status >= 200 && r.status < 300, `${label} a dropped delivery is still acknowledged (got ${r.status})`);
	assert.deepEqual(r.logs.filter((l) => l.event === "dropped").map((l) => l.reason), [reason], label);
}

// --- GitHub: issue_comment, action `edited` ---

const github = (action, senderId, body) =>
	deliver({
		url: "/",
		headers: (raw) => ({ "x-github-event": "issue_comment", "x-github-delivery": `gh-${action}-${senderId}`, "x-hub-signature-256": sign(GH_SECRET, raw) }),
		payload: {
			action,
			sender: { id: senderId, login: "someone" },
			repository: { full_name: "octo/repo" },
			issue: { number: 42, title: "T", body: "B" },
			comment: { id: 5, body, author_association: senderId === SELF_ID ? "NONE" : "OWNER" },
			...(action === "edited" && { changes: { body: { from: "old" } } }),
		},
	});

test("github: a new comment with the phrase enqueues (the control)", async () => {
	assert.equal((await github("created", MEMBER, "@pi please")).calls.length, 1);
});

test("github: the bot editing its own status comment enqueues nothing", async () => {
	assertDropped(await github("edited", SELF_ID, STATUS), "self");
});

test("github: a maintainer editing the status comment to hold the phrase enqueues nothing", async () => {
	assertDropped(await github("edited", MEMBER, STATUS_WITH_PHRASE), "unhandled-event");
});

// --- GitLab: Note Hook, object_attributes.action `update` ---

const gitlab = (action, userId, note, noteableType = "Issue") =>
	deliver({
		url: "/gitlab",
		headers: () => ({ "x-gitlab-event": "Note Hook", "webhook-id": `gl-${action}-${userId}-${noteableType}`, "x-gitlab-token": GL_TOKEN }),
		payload: {
			object_kind: "note",
			event_type: "note",
			user: { id: userId, username: "someone" },
			project: { id: 42, path_with_namespace: "group/sub/proj", default_branch: "main" },
			object_attributes: { id: 991, action, note, noteable_type: noteableType },
			...(noteableType === "Issue"
				? { issue: { iid: 5, title: "T", description: "B", labels: [] } }
				: { merge_request: { iid: 6, title: "M", description: "B", source_branch: "f", target_branch: "main", source_project_id: 42, target_project_id: 42, labels: [] } }),
		},
	});

test("gitlab: a new note with the phrase enqueues (the control)", async () => {
	assert.equal((await gitlab("create", MEMBER, "@pi please")).calls.length, 1);
});

test("gitlab: the bot updating its own status note enqueues nothing, on an issue and a merge request", async () => {
	for (const type of ["Issue", "MergeRequest"]) {
		assertDropped(await gitlab("update", SELF_ID, STATUS, type), "self", type);
	}
});

test("gitlab: a member updating the status note to hold the phrase enqueues nothing", async () => {
	for (const type of ["Issue", "MergeRequest"]) {
		assertDropped(await gitlab("update", MEMBER, STATUS_WITH_PHRASE, type), "unhandled-event", type);
	}
});

// --- Forgejo/Gitea: issue_comment, action `edited` ---

const forgejo = (action, senderId, body) =>
	deliver({
		url: "/forgejo",
		headers: (raw) => ({ "x-github-event": "issue_comment", "x-github-delivery": `fj-${action}-${senderId}`, "x-hub-signature-256": sign(FJ_SECRET, raw) }),
		payload: {
			action,
			sender: { id: senderId, login: "someone" },
			repository: { full_name: "acme/widgets" },
			issue: { number: 7, title: "T", body: "B", labels: [] },
			comment: { id: 314, body },
			...(action === "edited" && { changes: { body: { from: "old" } } }),
		},
	});

test("forgejo: a new comment with the phrase enqueues (the control)", async () => {
	assert.equal((await forgejo("created", MEMBER, "@pi please")).calls.length, 1);
});

test("forgejo: the bot editing its own status comment enqueues nothing", async () => {
	assertDropped(await forgejo("edited", SELF_ID, STATUS), "self");
});

test("forgejo: a collaborator editing the status comment to hold the phrase enqueues nothing", async () => {
	assertDropped(await forgejo("edited", MEMBER, STATUS_WITH_PHRASE), "action-not-actionable");
});

// --- Azure DevOps ---
//
// Azure has no `edited` action. The events the receiver subscribes to that a comment edit can produce are the pull
// request comment event (`ms.vss-code.git-pullrequest-comment-event`, whose payload carries the comment and its author)
// and, for a work item, `workitem.updated` / `workitem.commented`. Azure lets only a comment's author edit it, so the
// editor is the harness itself and the bot-loop guard drops each of them; a work item update by anyone else that changes
// no tag drops as `no-label-change`.

const azure = (payload) =>
	deliver({ url: "/azure", headers: () => ({ authorization: `Basic ${AZ_BASIC}` }), payload: { resourceContainers: { project: { id: "proj-guid" } }, ...payload } });

const prComment = (authorId, content, id) => ({
	id,
	eventType: "ms.vss-code.git-pullrequest-comment-event",
	resource: {
		comment: { id: 1, content, author: { id: authorId }, publishedDate: "2026-10-16T10:00:00Z", lastContentUpdatedDate: "2026-10-16T10:05:00Z" },
		pullRequest: { pullRequestId: 12, title: "PT", description: "PB", repository: { id: "repo-guid", name: "widgets", project: { id: "proj-guid", name: "Fabrikam" } } },
	},
});

const workItemEvent = (eventType, changedBy, id, history) => ({
	id,
	eventType,
	resource: {
		id: 7,
		workItemId: 7,
		fields: { "System.ChangedBy": { oldValue: "A <a@example.com>", newValue: changedBy }, ...(history && { "System.History": { newValue: history } }) },
		revision: { fields: { "System.Title": "T", "System.Description": "B", "System.Tags": "", "System.TeamProject": "Fabrikam" } },
	},
});

test("azure: a new pull request comment with the phrase from a member enqueues (the control)", async () => {
	assert.equal((await azure(prComment(AZ_MEMBER, "@pi please", "az-control"))).calls.length, 1);
});

test("azure: the bot's own pull request comment event (an edit of the status comment) enqueues nothing", async () => {
	assertDropped(await azure(prComment(AZ_SELF.id, STATUS_WITH_PHRASE, "az-pr-edit")), "self");
});

test("azure: a work item update or comment event by the bot enqueues nothing", async () => {
	for (const eventType of ["workitem.updated", "workitem.commented"]) {
		assertDropped(await azure(workItemEvent(eventType, "pi-bot <pi-bot@example.com>", `az-${eventType}`, STATUS_WITH_PHRASE)), "self", eventType);
	}
});

test("azure: a work item update by a member that changes no tag enqueues nothing", async () => {
	assertDropped(await azure(workItemEvent("workitem.updated", "Dev <dev@example.com>", "az-wi-member", STATUS_WITH_PHRASE)), "no-label-change");
});
