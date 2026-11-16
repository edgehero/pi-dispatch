import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { parseTriggers, TRIGGERS_FILE_VERSION } from "@edgehero/pi-dispatch/triggers";
import { loadReceiverConfig } from "../src/config.mjs";
import { groupTriggers } from "../src/trigger-groups.mjs";
import { filter } from "../src/filter.mjs";
import { parseGitLabSubset } from "../src/gitlab-subset.mjs";
import { parseForgejoSubset } from "../src/forgejo-subset.mjs";
import { parseAzureSubset } from "../src/azure-subset.mjs";
import { makeReceiver, parseSubset } from "../src/receiver.mjs";
import { hasLocalCloseListeners, localEventsWantCloserAuthority, makeLocalEventAdmission, matchingLocalEvents } from "../src/local-event-listeners.mjs";

const SELF = 999;
const SECRET = "local-event-test-secret";
const entry = (id, on = { type: "label", any: ["wake"] }, run = {}) => ({ on: { forge: "github", id, debounceSeconds: 10, ...on }, run: { kind: "local", folder: "/srv/automation", command: "sweep", worker: "runner-a", ...run } });
const document = (triggers) => JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers });
const parsed = (triggers) => parseTriggers(document(triggers), "fixture.json");
const groups = (triggers) => groupTriggers(parsed(triggers));
const rawIssue = { action: "labeled", sender: { id: 7, login: "personal-login" }, repository: { full_name: "o/r" }, issue: { number: 8, title: "EVENT_TITLE", body: "EVENT_BODY", labels: [{ name: "wake" }] } };
const issueInput = (triggers, overrides = {}) => ({ kind: "github", event: "issues", subset: parseSubset(rawIssue), triggers, selfId: SELF, deliveryId: "delivery-1", ...overrides });

test("local listeners match independently and leave the first forge match unchanged", () => {
	const old = { on: { type: "label", any: ["wake"] }, run: { kind: "github", flow: "fix" } };
	const onlyForge = groupTriggers(parsed([old]));
	const all = groups([entry("first"), entry("second"), old]);
	assert.deepEqual(matchingLocalEvents(issueInput(all)).map(t => t.on.id), ["first", "second"]);
	const before = filter("issues", parseSubset(rawIssue), { triggers: onlyForge }, SELF, "delivery-1");
	const after = filter("issues", parseSubset(rawIssue), { triggers: all }, SELF, "delivery-1");
	assert.equal(after.job.flow, before.job.flow);
	assert.deepEqual({ ...after.job.trigger.matched, index: 0 }, before.job.trigger.matched);
	assert.deepEqual([...all.knownFlows], ["fix"]);
	assert.equal(Object.hasOwn(onlyForge.github, "localEvents"), false, "old configuration keeps its exact grouped shape");
});

test("independent local comment listeners do not compete with the forge comment rule", () => {
	const triggers = groups([entry("comment-a", { type: "comment", phrase: "@sweep" }), entry("comment-b", { type: "comment", phrase: "@sweep" }), { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } }]);
	const subset = parseSubset({ ...rawIssue, action: "created", comment: { body: "@sweep EVENT_COMMAND_ARGUMENT @pi fix", author_association: "MEMBER" } });
	assert.deepEqual(matchingLocalEvents(issueInput(triggers, { event: "issue_comment", subset })).map(t => t.on.id), ["comment-a", "comment-b"]);
	assert.equal(filter("issue_comment", subset, { triggers }, SELF, "delivery-1").job.flow, "fix");
});

test("App review permission is per local listener, exact, and never overrides the self guard or forge gate", () => {
	const triggers = groups([entry("app-review", { type: "pull_request", action: ["review_submitted"], reviewAuthors: ["review-app[bot]"] }), entry("human-review", { type: "pull_request", action: ["review_submitted"] })]);
	const payload = { ...rawIssue, action: "submitted", pull_request: { number: 8, labels: [], author_association: "NONE", title: "EVENT_TITLE", body: "EVENT_BODY" }, review: { id: 17, user: { login: "Review-App[bot]" }, author_association: "NONE", state: "CHANGES_REQUESTED", body: "EVENT_REVIEW" } };
	const input = issueInput(triggers, { event: "pull_request_review", subset: parseSubset(payload) });
	assert.deepEqual(matchingLocalEvents(input).map(t => t.on.id), ["app-review"]);
	assert.deepEqual(matchingLocalEvents({ ...input, subset: parseSubset({ ...payload, sender: { id: SELF } }) }), []);
	assert.deepEqual(matchingLocalEvents({ ...input, subset: parseSubset({ ...payload, review: { ...payload.review, user: { login: "review-app[bot]-impostor" } } }) }), []);
	assert.deepEqual(matchingLocalEvents({ ...input, subset: parseSubset({ ...payload, review: { ...payload.review, user: {} } }) }), []);
	const human = parseSubset({ ...payload, review: { ...payload.review, author_association: "COLLABORATOR", user: {} } });
	assert.deepEqual(matchingLocalEvents({ ...input, subset: human }).map(t => t.on.id), ["app-review", "human-review"]);
	const forgeOnly = groups([{ on: { type: "pull_request", action: ["review_submitted"] }, run: { kind: "github", command: "sweep" } }]);
	assert.equal(filter(input.event, input.subset, { triggers: forgeOnly }, SELF, "delivery-1", undefined, { reviewAuthors: ["review-app[bot]"] }).reason, "review-author-not-allowed", "an allowlist has no authority outside matchOnly");
});

test("local close listeners request the same permission lookup and refuse an unauthorized closer", () => {
	const triggers = groups([entry("after-close", { type: "issue", action: ["closed"], number: 8 })]);
	const subset = parseSubset({ ...rawIssue, action: "closed" });
	assert.equal(hasLocalCloseListeners(triggers.github), true);
	assert.equal(localEventsWantCloserAuthority("issues", subset, triggers.github, SELF), true);
	assert.equal(localEventsWantCloserAuthority("issues", { ...subset, sender: { id: SELF } }, triggers.github, SELF), false);
	assert.deepEqual(matchingLocalEvents(issueInput(triggers, { subset })), []);
	assert.equal(matchingLocalEvents(issueInput(triggers, { subset, authorized: true })).length, 1);
	assert.deepEqual(matchingLocalEvents(issueInput(triggers, { subset, authorized: false })), []);
});

test("all source forges use their existing identity, permission and label-change gates", () => {
	const fixtures = [
		{ kind: "gitlab", subset: parseGitLabSubset({ object_kind: "issue", user: { id: 7 }, project: { id: 42, path_with_namespace: "o/r" }, object_attributes: { iid: 8, title: "EVENT_TITLE", description: "EVENT_BODY", action: "update", labels: [{ title: "wake" }] }, changes: { labels: { previous: [], current: [{ title: "wake" }] } } }), selfId: SELF },
		{ kind: "forgejo", event: "issues", subset: parseForgejoSubset({ ...rawIssue, action: "label_updated" }), selfId: SELF },
		{ kind: "azure", subset: parseAzureSubset({ id: "delivery-azure", eventType: "workitem.updated", resourceContainers: { project: { id: "project-guid" } }, resource: { id: 8, fields: { "System.ChangedBy": { newValue: "Member <member@example.com>" }, "System.Tags": { oldValue: "", newValue: "wake" } }, revision: { fields: { "System.Title": "EVENT_TITLE", "System.TeamProject": "Project", "System.Tags": "wake" } } } }), selfId: { id: "self-guid", email: "self@example.com" } },
	];
	for (const fixture of fixtures) {
		const triggers = groups([entry(`label-${fixture.kind}`, { type: "label", forge: fixture.kind, any: ["wake"] })]);
		const input = { ...fixture, triggers, deliveryId: "delivery-1" };
		assert.equal(matchingLocalEvents({ ...input, authorized: true }).length, 1, fixture.kind);
		assert.equal(matchingLocalEvents({ ...input, authorized: false }).length, 0, fixture.kind);
	}
});

test("admission persists only normalized configuration and delivery identity, and never opens a client on a drop", async () => {
	const triggers = groups([entry("sweep")]);
	const calls = [];
	const logs = [];
	const admit = makeLocalEventAdmission({ client: () => assert.fail("injected store needs no client"), store: { signal: async (input) => { calls.push(input); return { accepted: true, coalesced: false }; } }, now: () => 1000, log: (line) => logs.push(line) });
	await admit(issueInput(triggers));
	assert.deepEqual(calls, [{ trigger: triggers.github.localEvents[0], deliveryId: "delivery-1" }]);
	for (const text of ["EVENT_TITLE", "EVENT_BODY", "personal-login"]) assert.equal(JSON.stringify({ calls, logs }).includes(text), false);
	const dropped = makeLocalEventAdmission({ client: () => assert.fail("unmatched event must not read state"), now: () => 1000 });
	assert.deepEqual(await dropped(issueInput(triggers, { subset: { ...parseSubset(rawIssue), sender: { id: SELF } } })), []);
});

test("a local-only GitHub deployment enables and requires its authenticated webhook route", () => {
	const fs = { fileExists: () => true, readFile: () => document([entry("sweep")]) };
	assert.throws(() => loadReceiverConfig({}, fs), /WEBHOOK_SECRET/);
	const cfg = loadReceiverConfig({ WEBHOOK_SECRET: SECRET }, fs);
	assert.equal(cfg.servesGithub, true);
	assert.equal(cfg.triggers.github.localEvents.length, 1);
	assert.equal(cfg.triggers.github.label.length, 0);
});

async function deliver(handler, payload, { signature = true, event = "issues", delivery = "delivery-1" } = {}) {
	const raw = JSON.stringify(payload);
	const req = new EventEmitter();
	Object.assign(req, { method: "POST", url: "/", headers: { "content-type": "application/json", "x-hub-signature-256": signature ? `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}` : "sha256=invalid", "x-github-event": event, "x-github-delivery": delivery }, destroy() {} });
	const res = { statusCode: 0, writeHead(status) { this.statusCode = status; return this; }, end(body) { this.body = body; return this; } };
	const pending = handler(req, res);
	req.emit("data", Buffer.from(raw));
	req.emit("end");
	await pending;
	return { status: res.statusCode, body: res.body === undefined ? null : JSON.parse(res.body) };
}

test("webhook acceptance is durable, reports coalescing, and passes no event text to the store", async () => {
	const calls = [];
	const cfg = { servesGithub: true, webhookSecret: SECRET, triggers: groups([entry("sweep")]) };
	const handler = makeReceiver({ cfg, selfId: SELF, queue: { add: () => assert.fail("local admission never enqueues a forge job") }, localEventStore: { signal: async (input) => { calls.push(input); return { accepted: true, coalesced: calls.length > 1 }; } }, now: () => 1000 });
	assert.deepEqual(await deliver(handler, rawIssue), { status: 202, body: { status: "accepted", localEvents: { accepted: 1, coalesced: 0 } } });
	assert.deepEqual(await deliver(handler, rawIssue, { delivery: "delivery-2" }), { status: 202, body: { status: "accepted", localEvents: { accepted: 1, coalesced: 1 } } });
	assert.equal((await deliver(handler, rawIssue, { signature: false })).status, 401);
	assert.equal(calls.length, 2);
	assert.deepEqual(Object.keys(calls[0]), ["trigger", "deliveryId"]);
	assert.equal(JSON.stringify(calls).includes("EVENT_BODY"), false);
});

test("an unavailable signal store gives HTTP 503 instead of claiming acceptance", async () => {
	const cfg = { servesGithub: true, webhookSecret: SECRET, triggers: groups([entry("sweep")]) };
	const logs = [];
	const handler = makeReceiver({ cfg, selfId: SELF, queue: {}, log: (line) => logs.push(line), localEventStore: { signal: async () => { throw new Error("EVENT_BODY PRIVATE_CONFIG Redis diagnostic"); } }, now: () => 1000 });
	assert.deepEqual(await deliver(handler, rawIssue), { status: 503, body: { error: "enqueue-failed" } });
	assert.ok(logs.some(line => line.reason === "local-event-state-unavailable"));
	assert.doesNotMatch(JSON.stringify(logs), /EVENT_BODY|PRIVATE_CONFIG/);
});

test("a local App reviewer cannot bypass review-state, label or empty-commented narrowing", () => {
	const rule = entry("app-review", { type: "pull_request", action: ["review_submitted"], reviewAuthors: ["review-app[bot]"], reviewState: ["approved", "commented"], all: ["ready"], none: ["blocked"] });
	const triggers = groups([rule]);
	const payload = { ...rawIssue, action: "submitted", pull_request: { number: 8, author_association: "NONE", labels: [{ name: "ready" }] }, review: { id: 17, user: { login: "review-app[bot]" }, author_association: "NONE", state: "approved", body: "" } };
	const match = (p) => matchingLocalEvents(issueInput(triggers, { event: "pull_request_review", subset: parseSubset(p) }));
	assert.equal(match(payload).length, 1);
	assert.deepEqual(match({ ...payload, review: { ...payload.review, state: "changes_requested" } }), []);
	assert.deepEqual(match({ ...payload, review: { ...payload.review, state: "commented" } }), []);
	assert.deepEqual(match({ ...payload, pull_request: { ...payload.pull_request, labels: [] } }), []);
	assert.deepEqual(match({ ...payload, pull_request: { ...payload.pull_request, labels: [{ name: "ready" }, { name: "blocked" }] } }), []);
});

test("mixed listeners preserve ordinary queued responses and signal failure is safely retryable", async () => {
	const calls = [];
	const queued = [];
	const receipts = new Set();
	let failSecond = true;
	const cfg = { servesGithub: true, webhookSecret: SECRET, triggers: groups([entry("first"), entry("second"), { on: { type: "label", any: ["wake"] }, run: { kind: "github", flow: "fix" } }]) };
	const handler = makeReceiver({ cfg, selfId: SELF, queue: { async add(name, data, options) { queued.push({ name, data, options }); return { id: options.jobId }; } }, localEventStore: { async signal(input) {
		calls.push(input.trigger.on.id);
		if (input.trigger.on.id === "second" && failSecond) throw new Error("store down");
		const coalesced = receipts.has(input.trigger.on.id);
		receipts.add(input.trigger.on.id);
		return { accepted: true, coalesced };
	} }, now: () => 1000 });
	assert.equal((await deliver(handler, rawIssue)).status, 503);
	assert.equal(queued.length, 0);
	failSecond = false;
	const reply = await deliver(handler, rawIssue);
	assert.equal(reply.status, 202);
	assert.equal(reply.body.status, "queued");
	assert.deepEqual(reply.body.localEvents, { accepted: 2, coalesced: 1 });
	assert.equal(queued.length, 1);
	assert.equal(queued[0].data.flow, "fix");
	assert.deepEqual(calls, ["first", "second", "first", "second"]);
});
