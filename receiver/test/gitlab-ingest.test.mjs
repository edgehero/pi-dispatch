import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { makeReceiver } from "../src/receiver.mjs";
import { makeResolveAuthority } from "../src/gitlab-members.mjs";

const SELF_ID = 999;
const SHARED_TOKEN = "a-shared-secret";

function forgeTriggers({ knownFlows, ...group }) {
	return { github: { label: [], comment: null, pullRequest: [] }, gitlab: group, knownFlows };
}

// `servesGithub: true`: this fixture is a deployment serving BOTH forges, which is what lets the routing
// test below assert that `/` still reaches the github arm (and is refused there for want of a signature)
// rather than being served by the gitlab one. A github-free deployment 404s `/` instead -- issue #99, pinned
// in receiver.test.mjs.
const cfg = {
	webhookSecret: "gh-secret",
	servesGithub: true,
	triggers: forgeTriggers({
		label: [{ index: 0, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix" }],
		comment: { index: 1, phrase: "@pi", defaultFlow: "triage" },
		pullRequest: [],
		knownFlows: new Set(["frontend-fix", "triage"]),
	}),
};

function mockReq({ url = "/gitlab", method = "POST", headers = {} } = {}) {
	const req = new EventEmitter();
	req.url = url;
	req.method = method;
	req.headers = { "content-type": "application/json", "x-gitlab-event": "Issue Hook", "webhook-id": "wh-1", "x-gitlab-token": SHARED_TOKEN, ...headers };
	req.destroy = () => {};
	return req;
}

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

async function drive(handler, req, res, raw) {
	const p = handler(req, res);
	req.emit("data", Buffer.from(raw, "utf8"));
	req.emit("end");
	await p;
}

function recordingQueue() {
	const calls = [];
	return { calls, queue: { add: async (name, data, opts) => (calls.push({ name, data, opts }), { id: opts?.jobId }) } };
}

const LABELLED = JSON.stringify({
	object_kind: "issue",
	user: { id: 7, username: "dev" },
	project: { id: 42, path_with_namespace: "group/sub/proj", default_branch: "main" },
	object_attributes: { iid: 5, title: "T", description: "B", action: "update", labels: [{ title: "pi:frontend" }] },
	changes: { labels: { previous: [], current: [{ title: "pi:frontend" }] } },
});

/** A receiver whose gitlab arm resolves every actor to `authorized`, in token mode. */
function build({ authorized = true, resolve, logs = [], cfg: cfgOver = cfg, queue: queueOver } = {}) {
	const { calls, queue: recording } = recordingQueue();
	const queue = queueOver ?? recording;
	const handler = makeReceiver({
		queue,
		selfId: 1,
		cfg: cfgOver,
		log: (o) => logs.push(o),
		gitlab: {
			mode: "token",
			secret: SHARED_TOKEN,
			selfId: SELF_ID,
			resolveAuthority: resolve ?? (async () => ({ authorized })),
		},
	});
	return { handler, calls, logs };
}

test("a member-labelled issue enqueues exactly one gitlab job and answers 202", async () => {
	const { handler, calls } = build();
	const res = mockRes();
	await drive(handler, mockReq(), res, LABELLED);

	assert.equal(res.statusCode, 202);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, "gitlab", "the BullMQ job name discriminates the forge for the worker");
	assert.equal(calls[0].data.kind, "gitlab");
	assert.equal(calls[0].data.repo, "group/sub/proj");
	assert.equal(calls[0].data.projectId, 42);
	assert.equal(calls[0].data.flow, "frontend-fix");
	assert.equal(calls[0].opts.jobId, "gl-wh-1", "the gl- prefix keeps the two forges' id spaces disjoint");
});

test("a replayed delivery resolves to the same jobId, so BullMQ rejects the duplicate", async () => {
	const { handler, calls } = build();
	for (const _ of [1, 2]) await drive(handler, mockReq(), mockRes(), LABELLED);
	assert.equal(calls.length, 2, "the receiver enqueues both -- dedup is the queue's EXISTS jobId, not a receiver check");
	assert.equal(calls[0].opts.jobId, calls[1].opts.jobId, "and the ids match, which is what makes the second a no-op");
});

test("an issue and a merge request numbered alike do NOT share a semantic dedup key", async () => {
	// GitLab numbers issues and merge requests in separate per-project sequences, so #5 and !5 are
	// different objects. One key for both would silently coalesce one into the other's window.
	const { handler, calls } = build();
	await drive(handler, mockReq(), mockRes(), LABELLED);
	assert.equal(calls[0].opts.deduplication.id, "group/sub/proj#5:frontend-fix");

	// The same project, the same flow, the same number -- and a merge request rather than an issue.
	const mrCfg = {
		...cfg,
		triggers: { ...cfg.triggers, gitlab: { ...cfg.triggers.gitlab, pullRequest: [{ index: 2, actions: new Set(["open"]), predicate: {}, flow: "frontend-fix" }] } },
	};
	const { calls: mrCalls, queue: mrQueue } = recordingQueue();
	const mrHandler = makeReceiver({
		queue: mrQueue,
		selfId: 1,
		cfg: mrCfg,
		log: () => {},
		gitlab: { mode: "token", secret: SHARED_TOKEN, selfId: SELF_ID, resolveAuthority: async () => ({ authorized: true }) },
	});
	await drive(
		mrHandler,
		mockReq({ headers: { "webhook-id": "wh-2", "x-gitlab-event": "Merge Request Hook" } }),
		mockRes(),
		JSON.stringify({
			object_kind: "merge_request",
			user: { id: 7 },
			project: { id: 42, path_with_namespace: "group/sub/proj" },
			object_attributes: { iid: 5, title: "MR", description: "D", action: "open", labels: [] },
		}),
	);

	assert.equal(mrCalls.length, 1);
	assert.equal(mrCalls[0].opts.deduplication.id, "group/sub/proj!5:frontend-fix", "! for a merge request, GitLab's own notation");
	assert.notEqual(calls[0].opts.deduplication.id, mrCalls[0].opts.deduplication.id, "one key for both would coalesce one object into the other's window");
});

test("a non-member is dropped 204 and never reaches the queue", async () => {
	const { handler, calls, logs } = build({ authorized: false });
	const res = mockRes();
	await drive(handler, mockReq(), res, LABELLED);
	assert.equal(res.statusCode, 204);
	assert.equal(calls.length, 0);
	assert.ok(logs.some((l) => l.event === "dropped" && l.reason === "author-not-allowed"));
});

test("an INDETERMINATE access lookup is 503, not a silent drop", async () => {
	// The distinction that matters operationally: 204 means "correctly refused", 503 means "ask again".
	// Collapsing the second into the first drops real work during an outage and looks identical on the wire.
	const { handler, calls, logs } = build({ resolve: async () => ({ indeterminate: "members lookup returned 502" }) });
	const res = mockRes();
	await drive(handler, mockReq(), res, LABELLED);
	assert.equal(res.statusCode, 503, "GitLab redelivers, and the stable webhook-id dedups the retry");
	assert.equal(calls.length, 0);
	const line = logs.find((l) => l.event === "gitlab_access_lookup_failed");
	assert.ok(line, "the failure is observable");
	assert.equal(JSON.stringify(line).includes("dev"), false, "and it never names the actor -- username is personal data");
});

test("a forged token is 401 before any field of the body is read", async () => {
	const { handler, calls } = build({ resolve: async () => assert.fail("the gate must never run on an unverified body") });
	const res = mockRes();
	await drive(handler, mockReq({ headers: { "x-gitlab-token": "guessed" } }), res, LABELLED);
	assert.equal(res.statusCode, 401);
	assert.equal(calls.length, 0);
});

test("routing is by PATH: /gitlab is the gitlab arm, / stays github, and an unconfigured gitlab is 404", async () => {
	const { handler } = build();
	// `/` carries no gitlab headers and a github signature it cannot produce -- it must reach the github
	// arm and be refused there, never be served by the gitlab one.
	const ghRes = mockRes();
	await drive(handler, mockReq({ url: "/" }), ghRes, LABELLED);
	assert.equal(ghRes.statusCode, 401, "the github arm answered: it wants an X-Hub-Signature-256");

	const { queue } = recordingQueue();
	const noGitlab = makeReceiver({ queue, selfId: 1, cfg, log: () => {} });
	const res = mockRes();
	await drive(noGitlab, mockReq(), res, LABELLED);
	assert.equal(res.statusCode, 404, "an endpoint that answers is an endpoint an operator can believe is armed");
});

test("a query string and a trailing slash still route to /gitlab", async () => {
	const { handler, calls } = build();
	for (const url of ["/gitlab?x=1", "/gitlab/"]) {
		await drive(handler, mockReq({ url, headers: { "webhook-id": `wh-${url}` } }), mockRes(), LABELLED);
	}
	assert.equal(calls.length, 2);
});

// --- the authority resolver ---

const okResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("resolveAuthority asks the inherited-membership endpoint by numeric id", async () => {
	let seen = null;
	const resolve = makeResolveAuthority({
		apiUrl: "https://gitlab.example.com/",
		token: "tok",
		fetchFn: async (url, init) => ((seen = { url, init }), okResponse({ access_level: 40 })),
	});
	assert.deepEqual(await resolve(42, 7), { authorized: true }, "Maintainer (40) is above Developer");
	assert.equal(seen.url, "https://gitlab.example.com/api/v4/projects/42/members/all/7", "members/all -- the plain endpoint misses group-inherited access and would refuse a real maintainer");
	assert.equal(seen.init.headers["PRIVATE-TOKEN"], "tok");
});

test("404 is a determinate non-member; every other failure is indeterminate", async () => {
	const at = (status) => makeResolveAuthority({ apiUrl: "https://gl", token: "t", fetchFn: async () => okResponse({}, status) });
	assert.deepEqual(await at(404)(42, 7), { authorized: false });
	for (const status of [401, 403, 429, 500, 502]) {
		const r = await at(status)(42, 7);
		assert.ok(r.indeterminate, `${status} must not read as "not a member"`);
	}
	const network = makeResolveAuthority({ apiUrl: "https://gl", token: "t", fetchFn: async () => { throw new Error("ECONNREFUSED"); } });
	assert.ok((await network(42, 7)).indeterminate);
});

test("a 200 with no integer access_level is indeterminate, never a refusal", async () => {
	// Reporting `authorized: false` would turn an upstream schema change into a silent, permanent refusal
	// of every trigger.
	const resolve = makeResolveAuthority({ apiUrl: "https://gl", token: "t", fetchFn: async () => okResponse({ access_level: "40" }) });
	assert.ok((await resolve(42, 7)).indeterminate);
});

test("a payload that named no project or actor refuses without a lookup", async () => {
	let called = false;
	const resolve = makeResolveAuthority({ apiUrl: "https://gl", token: "t", fetchFn: async () => ((called = true), okResponse({})) });
	assert.deepEqual(await resolve(undefined, 7), { authorized: false });
	assert.deepEqual(await resolve(42, undefined), { authorized: false });
	assert.equal(called, false, "there is nothing to ask about -- determinate, not a failure");
});

test("the Developer threshold is the resolver's, and every role at or above it authorizes", async () => {
	// These assertions used to live in filter-gitlab's suite, where they described the gate. They belong
	// here: the gate now asks "is this actor authorized", and WHICH GitLab role answers yes is a fact about
	// GitLab, resolved alongside the lookup that produces the number. Guest (10) and Reporter (20) cannot
	// push a branch, so a job started on their say-so would be doing work they could not do themselves --
	// which is the line CONST-TRIGGER-AUTHOR-GATE draws.
	const at = (access_level) => makeResolveAuthority({ apiUrl: "https://gl", token: "t", fetchFn: async () => okResponse({ access_level }) });
	for (const level of [30, 40, 50]) {
		assert.deepEqual(await at(level)(42, 7), { authorized: true }, `access_level ${level} is at or above Developer`);
	}
	for (const level of [0, 5, 10, 20, 29]) {
		assert.deepEqual(await at(level)(42, 7), { authorized: false }, `access_level ${level} is below Developer and cannot push`);
	}
});
const LABEL_GROUP = { label: [{ index: 0, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix" }], comment: { index: 1, phrase: "@pi", defaultFlow: "triage" }, pullRequest: [], knownFlows: new Set(["frontend-fix", "triage"]) };

// --- replica fanout: one delivery, N jobs (REQ-REPLICA-RUNS, #187) ---

/** The label config above, with `replicas` on the matched rule. */
const replicaCfg = { ...cfg, triggers: forgeTriggers({ ...LABEL_GROUP, label: [{ ...LABEL_GROUP.label[0], replicas: 2 }] }) };

test("gitlab: a replicas: 2 trigger enqueues TWICE from one delivery, with distinct ids on BOTH dedup layers", async () => {
	const { handler, calls, logs } = build({ cfg: replicaCfg });
	const res = mockRes();
	await drive(handler, mockReq(), res, LABELLED);

	assert.equal(res.statusCode, 202);
	assert.equal(calls.length, 2, "one delivery, two independent jobs");
	assert.deepEqual(calls.map((c) => c.data.replica), [1, 2]);
	assert.deepEqual(calls.map((c) => c.data.replicas), [2, 2]);
	// Layer one: a duplicate `queue.add` under a taken jobId is SILENTLY ignored, so identical ids would
	// make the second replica vanish with no error surface at all.
	assert.deepEqual(calls.map((c) => c.opts.jobId), [`gl-wh-1-r1`, `gl-wh-1-r2`]);
	// Layer two: the 10-minute semantic window would otherwise coalesce the pair, since without `:r<i>`
	// both replicas compose the identical key.
	assert.deepEqual(calls.map((c) => c.opts.deduplication.id), [`group/sub/proj#5:frontend-fix:r1`, `group/sub/proj#5:frontend-fix:r2`]);
	assert.equal(logs.find((l) => l.event === "enqueued")?.replicas, 2, "the log says how many, so a pair is explainable from the receiver's own output");
});

test("gitlab: a throw on the SECOND replica answers 503 and leaves the first enqueued", async () => {
	// No compensating logic exists and none is needed: the forge redelivers, replica 1 dedups on its own
	// now-taken jobId and replica 2 enqueues. The retry converges on exactly two jobs, never three.
	const seen = [];
	const queue = {
		add: async (name, data, opts) => {
			if (data.replica === 2) throw new Error("valkey down");
			seen.push(opts.jobId);
			return { id: opts.jobId };
		},
	};
	const { handler } = build({ cfg: replicaCfg, queue });
	const res = mockRes();
	await drive(handler, mockReq(), res, LABELLED);

	assert.equal(res.statusCode, 503);
	assert.deepEqual(seen, [`gl-wh-1-r1`], "replica 1 is already in the queue and stays there");
});

test("gitlab: an unflagged trigger still enqueues EXACTLY once, with no replica key and today's jobId", async () => {
	const { handler, calls } = build();
	const res = mockRes();
	await drive(handler, mockReq(), res, LABELLED);

	assert.equal(calls.length, 1);
	assert.equal("replica" in calls[0].data, false);
	assert.equal("replicas" in calls[0].data, false);
	assert.equal(calls[0].opts.jobId, "gl-wh-1");
});
