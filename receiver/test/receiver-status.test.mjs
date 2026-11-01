import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { makeReceiver } from "../src/receiver.mjs";
import { makeReceiverObservations, RECEIVER_FORGES, RECEIVER_OUTCOMES } from "@edgehero/pi-dispatch/receiver-status";

const AT = Date.UTC(2026, 10, 1, 12);
const now = () => AT;
const SECRET = "secret";
const SENTINEL = "PRIVATE-PAYLOAD-HEADER-REPOSITORY";
const sign = (raw) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
function request(forge, raw, headers = {}) {
	const req = new EventEmitter();
	req.method = "POST"; req.url = { github: "/", gitlab: "/gitlab", forgejo: "/forgejo", azure: "/azure" }[forge]; req.destroy = () => {};
	req.headers = { "content-type": "application/json", "x-github-event": "issue_comment", "x-github-delivery": SENTINEL, "x-hub-signature-256": sign(raw), "x-gitlab-event": "Note Hook", "webhook-id": SENTINEL, "x-gitlab-token": SECRET, "x-auth": SECRET, ...headers };
	return req;
}
function rawOf(forge, body = "@pi work") {
	if (forge === "gitlab") return JSON.stringify({ object_kind: "note", user: { id: 5, username: SENTINEL }, project: { id: 42, path_with_namespace: `g/${SENTINEL}`, default_branch: "main" }, object_attributes: { note: body, noteable_type: "Issue", action: "create" }, issue: { iid: 7, title: SENTINEL, description: SENTINEL, labels: [] } });
	if (forge === "azure") return JSON.stringify({ id: SENTINEL, eventType: "workitem.commented", resourceContainers: { project: { id: "proj-guid" } }, resource: { workItemId: 7, fields: { "System.ChangedBy": { newValue: "Dev <dev@example.com>" }, "System.History": { newValue: body } }, revision: { fields: { "System.Title": SENTINEL, "System.TeamProject": SENTINEL, "System.Tags": "" } } } });
	return JSON.stringify({ action: "created", sender: { id: 5, login: SENTINEL }, repository: { full_name: `g/${SENTINEL}` }, issue: { number: 7, title: SENTINEL, body: SENTINEL, labels: [] }, comment: { body, author_association: "OWNER" }, is_pull: false });
}
function build(forge, { disabled = false, dedup = false, lookup = false, enqueue = false, error = false, observations = makeReceiverObservations({ now }) } = {}) {
	let adds = 0; let clients = 0;
	const rule = { index: 1, phrase: "@pi", defaultFlow: "triage", repository: "widgets" };
	const groups = Object.fromEntries(RECEIVER_FORGES.map((f) => [f, { label: [], comment: rule, pullRequest: [], issue: [{ index: 2, actions: new Set(["closed"]), number: 7, once: true, flow: "triage" }] }]));
	const queue = { get client() { clients++; throw new Error("request telemetry must stay in memory"); }, add: async (_name, _data, opts) => { adds++; if (enqueue) throw new Error("infrastructure"); return { id: dedup ? "survivor" : opts.jobId }; } };
	const resolveAuthority = async () => lookup ? { indeterminate: "lookup-failed" } : { authorized: true };
	const handler = makeReceiver({ queue, selfId: 999, cfg: { servesGithub: !disabled, webhookSecret: SECRET, triggers: { ...groups, knownFlows: new Set(["triage"]) } }, log: error ? () => { throw new Error("sink"); } : () => {}, now, observations,
		gitlab: disabled ? null : { mode: "token", secret: SECRET, selfId: 999, resolveAuthority }, forgejo: disabled ? null : { secret: SECRET, selfId: 999, resolveAuthority }, azure: disabled ? null : { mode: "header", headerName: "x-auth", secret: SECRET, selfId: { id: "self", email: "bot@example.com" }, resolveAuthority }, resolveAuthority });
	return { handler, observations, adds: () => adds, clients: () => clients };
}
async function drive(handler, req, raw) {
	const res = { statusCode: 0, headersSent: false, body: null, ended: false, writeHead(status) { this.statusCode = status; this.headersSent = true; }, end(body) { this.ended = true; this.body = body; return this; } };
	const p = handler(req, res); req.emit("data", Buffer.from(raw)); req.emit("end"); await p; return res;
}

for (const forge of RECEIVER_FORGES) {
	test(`${forge}: each reachable status is counted after its answer with no telemetry storage command (#775)`, async () => {
		const cases = [
			["queued", 202, {}, {}], ["deduplicated", 202, { dedup: true }, {}], ["dropped", 204, {}, {}, "no phrase"],
			["not-configured", 404, { disabled: true }, {}], ["unauthorized", 401, {}, { "x-hub-signature-256": "wrong", "x-gitlab-token": "wrong", "x-auth": "wrong" }],
			["malformed", 400, {}, {}, "invalid-json"], ["malformed", 405, {}, {}, null, "GET"], ["malformed", 413, {}, { "content-length": "99999999" }], ["malformed", 415, {}, { "content-type": "text/plain" }],
			["enqueue-failed", 503, { enqueue: true }, {}], ["error", 500, { error: true }, {}],
		];
		if (forge !== "github") cases.push(["lookup-failed", 503, { lookup: true }, {}]);
		for (const [word, status, options, headers, body, method] of cases) {
			const fixture = build(forge, options);
			const raw = body === "invalid-json" ? "{" : rawOf(forge, body ?? "@pi work");
			const req = request(forge, raw, headers); if (method) req.method = method;
			let answered = false;
			const observe = fixture.observations.observe;
			fixture.observations.observe = (...args) => { assert.equal(answered, true, "res.end returned before recording"); observe(...args); };
			// Observe the real end boundary without weakening its real routing/verification behavior.
			const res = { statusCode: 0, headersSent: false, writeHead(s) { this.statusCode = s; this.headersSent = true; }, end() { answered = true; } };
			const p = fixture.handler(req, res); req.emit("data", Buffer.from(raw)); req.emit("end"); await p;
			assert.equal(res.statusCode, status, `${word}/${status}`);
			const result = fixture.observations.snapshot();
			for (const f of RECEIVER_FORGES) for (const w of RECEIVER_OUTCOMES) assert.equal(result[f][w].hours.reduce((n, r) => n + r[1], 0), f === forge && w === word ? 1 : 0, `${word}: ${f}/${w}`);
			assert.equal(fixture.clients(), 0); assert.doesNotMatch(JSON.stringify(result), new RegExp(SENTINEL));
		}
	});
}

test("GitHub's closer lookup failure uses the separate 503 outcome (#775)", async () => {
	const fixture = build("github", { lookup: true });
	const raw = JSON.stringify({ action: "closed", sender: { id: 5, login: SENTINEL }, repository: { full_name: `g/${SENTINEL}` }, issue: { number: 7 } });
	const req = request("github", raw, { "x-github-event": "issues" });
	const res = await drive(fixture.handler, req, raw);
	assert.equal(res.statusCode, 503); assert.equal(fixture.observations.snapshot().github["lookup-failed"].hours.at(-1)[1], 1); assert.equal(fixture.clients(), 0);
});

test("unrouted paths stay GitHub, healthz has no new route, watch paths stay excluded and a broken observer cannot affect answers (#775)", async () => {
	const fixture = build("github"); const raw = rawOf("github");
	for (const url of ["/", "/elsewhere", "/healthz"]) { const req = request("github", raw); req.url = url; assert.equal((await drive(fixture.handler, req, raw)).statusCode, 202); }
	assert.equal(fixture.observations.snapshot().github.queued.hours.at(-1)[1], 3);
	for (const url of ["/watch", "/watch/no-source"]) { const req = request("github", raw); req.url = url; await drive(fixture.handler, req, raw); }
	assert.equal(fixture.observations.snapshot().github.queued.hours.at(-1)[1], 3);
	const broken = build("github", { observations: { observe() { throw new Error("sink"); } } });
	assert.equal((await drive(broken.handler, request("github", raw), raw)).statusCode, 202);
});

test("same-id redelivery stays queued and concurrent requests cannot exchange response tags (#775)", async () => {
	const fixture = build("github"); const raw = rawOf("github");
	const replies = await Promise.all(Array.from({ length: 20 }, () => drive(fixture.handler, request("github", raw), raw)));
	assert.ok(replies.every((r) => r.statusCode === 202)); assert.equal(fixture.observations.snapshot().github.queued.hours.at(-1)[1], 20); assert.equal(fixture.clients(), 0);
});
