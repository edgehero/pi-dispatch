import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { makeReceiver } from "../src/receiver.mjs";
import { makeResolveForgejoAuthority } from "../src/forgejo-members.mjs";

const SELF_ID = 999;
const FORGEJO_SECRET = "forgejo-secret";

function forgeTriggers({ knownFlows, ...group }) {
	return {
		github: { label: [], comment: null, pullRequest: [] },
		gitlab: { label: [], comment: null, pullRequest: [] },
		forgejo: group,
		knownFlows,
	};
}

// `servesGithub: true`: a deployment serving BOTH forges, which is what the routing test below needs -- a
// forgejo delivery sent to `/` must reach the github arm and be refused by github's secret. On a
// github-free deployment `/` does not exist at all (issue #99), and that is pinned in receiver.test.mjs.
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

/** Forgejo's signature is GitHub's, computed the same way over the same bytes. */
const sign = (secret, raw) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

function mockReq({ url = "/forgejo", method = "POST", headers = {}, raw = "" } = {}) {
	const req = new EventEmitter();
	req.url = url;
	req.method = method;
	req.headers = {
		"content-type": "application/json",
		// The three headers Forgejo sends VERBATIM, GitHub's names and all.
		"x-github-event": "issues",
		"x-github-delivery": "fj-guid-1",
		"x-hub-signature-256": sign(FORGEJO_SECRET, raw),
		...headers,
	};
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
	action: "label_updated",
	sender: { id: 7, login: "dev" },
	issue: { number: 5, title: "T", body: "B", labels: [{ name: "pi:frontend" }] },
	repository: { full_name: "acme/widgets" },
});

function build({ authorized = true, resolve, forgejo = true, logs = [], cfg: cfgOver = cfg, queue: queueOver } = {}) {
	const { calls, queue: recording } = recordingQueue();
	const queue = queueOver ?? recording;
	const handler = makeReceiver({
		queue,
		selfId: 1,
		cfg: cfgOver,
		log: (o) => logs.push(o),
		forgejo: forgejo ? { secret: FORGEJO_SECRET, selfId: SELF_ID, resolveAuthority: resolve ?? (async () => ({ authorized })) } : null,
	});
	return { handler, calls, logs };
}

test("a collaborator-labelled issue enqueues exactly one forgejo job and answers 202", async () => {
	const { handler, calls } = build();
	const res = mockRes();
	await drive(handler, mockReq({ raw: LABELLED }), res, LABELLED);

	assert.equal(res.statusCode, 202);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, "forgejo", "the BullMQ job name discriminates the forge for the worker");
	assert.equal(calls[0].data.kind, "forgejo");
	assert.equal(calls[0].data.repo, "acme/widgets");
	assert.equal(calls[0].data.flow, "frontend-fix");
	assert.equal(calls[0].opts.jobId, "fj-fj-guid-1", "the fj- prefix keeps every forge's id space disjoint");
});

test("verification is GitHub's, unmodified -- a forged signature is 401 and never reaches the gate", async () => {
	// The point of the Forgejo arm: `verify.mjs` needed ZERO changes. Forgejo computes
	// hex(hmac-sha256(secret, body)) and sets X-Hub-Signature-256 to "sha256=<sig>", which is byte-for-byte
	// what the existing handler already reads. CONST-HMAC-OVER-RAW-BODY is satisfied by existing code.
	const { handler, calls } = build();
	const res = mockRes();
	await drive(handler, mockReq({ raw: LABELLED, headers: { "x-hub-signature-256": sign("wrong-secret", LABELLED) } }), res, LABELLED);
	assert.equal(res.statusCode, 401);
	assert.equal(calls.length, 0);
});

test("the forgejo secret is its OWN -- github's secret must not verify a forgejo delivery", async () => {
	// One `Webhooks({ secret })` per construction is why this is a separate handler on a separate path.
	// Sharing a secret between forges would let either forge's operator forge the other's deliveries.
	const { handler, calls } = build();
	const res = mockRes();
	await drive(handler, mockReq({ raw: LABELLED, headers: { "x-hub-signature-256": sign(cfg.webhookSecret, LABELLED) } }), res, LABELLED);
	assert.equal(res.statusCode, 401);
	assert.equal(calls.length, 0);
});

test("an unconfigured forgejo endpoint is 404, never 401 -- 401 reads as 'armed but mis-keyed'", async () => {
	const { handler, calls } = build({ forgejo: false });
	const res = mockRes();
	await drive(handler, mockReq({ raw: LABELLED }), res, LABELLED);
	assert.equal(res.statusCode, 404);
	assert.equal(calls.length, 0);
});

test("an indeterminate permission lookup is 503 (redeliverable), never 204", async () => {
	// 204 would drop real work during an outage, and on the wire it is indistinguishable from a stranger
	// being correctly refused. Forgejo redelivers, and the stable GUID dedups the retry.
	const logs = [];
	const { handler, calls } = build({ resolve: async () => ({ indeterminate: "collaborator permission lookup returned 500" }), logs });
	const res = mockRes();
	await drive(handler, mockReq({ raw: LABELLED }), res, LABELLED);
	assert.equal(res.statusCode, 503);
	assert.equal(calls.length, 0);
	assert.equal(logs.at(-1).event, "forgejo_permission_lookup_failed");
	assert.equal(JSON.stringify(logs).includes("dev"), false, "the reason names the lookup, never the actor (no-pii-in-logs)");
});

test("a refused actor is 204 with a drop reason, and no job", async () => {
	const logs = [];
	const { handler, calls } = build({ authorized: false, logs });
	const res = mockRes();
	await drive(handler, mockReq({ raw: LABELLED }), res, LABELLED);
	assert.equal(res.statusCode, 204);
	assert.equal(calls.length, 0);
	assert.equal(logs.at(-1).reason, "author-not-allowed");
});

test("routing is by PATH -- a forgejo delivery to / is handled by github, whose secret rejects it", async () => {
	// Forgejo emits X-GitHub-* on every delivery, so headers cannot tell the two apart. The operator picks
	// the path when they configure the webhook; the sender never picks which gate it faces.
	const { handler, calls } = build();
	const res = mockRes();
	await drive(handler, mockReq({ url: "/", raw: LABELLED }), res, LABELLED);
	assert.equal(res.statusCode, 401, "signed with forgejo's secret, checked against github's");
	assert.equal(calls.length, 0);
});

// --- the permission resolver ---

const okResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("admin and write authorize; read and none do not", async () => {
	const at = (permission) => makeResolveForgejoAuthority({ apiUrl: "https://fj", token: "t", fetchFn: async () => okResponse({ permission }) });
	for (const p of ["admin", "write"]) {
		assert.deepEqual(await at(p)("acme/widgets", "alice"), { authorized: true }, `${p} can push, which is the property the constitution requires`);
	}
	for (const p of ["read", "none"]) {
		assert.deepEqual(await at(p)("acme/widgets", "alice"), { authorized: false }, `${p} cannot push a branch`);
	}
	// An EMPTY permission is not a determinate "read" -- it is a shape this code does not recognise, and it
	// must go to the indeterminate arm rather than be rounded down to a refusal.
	assert.ok((await at("")("acme/widgets", "alice")).indeterminate, "an empty permission is unrecognised, not a denial");
});

test("the lookup asks the collaborator-permission endpoint with the token in an Authorization header", async () => {
	let seen = null;
	const resolve = makeResolveForgejoAuthority({
		apiUrl: "https://fj.example.com/",
		token: "tok",
		fetchFn: async (url, init) => ((seen = { url, init }), okResponse({ permission: "write" })),
	});
	await resolve("acme/widgets", "alice");
	assert.equal(seen.url, "https://fj.example.com/api/v1/repos/acme/widgets/collaborators/alice/permission");
	assert.equal(seen.init.headers.Authorization, "token tok");
	assert.equal(seen.init.redirect, "error", "a 30x must not be followed -- the request carries the token");
});

test("404 is a determinate non-collaborator; every other failure is indeterminate", async () => {
	const at = (status) => makeResolveForgejoAuthority({ apiUrl: "https://fj", token: "t", fetchFn: async () => okResponse({}, status) });
	assert.deepEqual(await at(404)("acme/widgets", "alice"), { authorized: false });
	for (const status of [401, 403, 429, 500, 502]) {
		assert.ok((await at(status)("acme/widgets", "alice")).indeterminate, `${status} must not read as "not a collaborator"`);
	}
	const network = makeResolveForgejoAuthority({
		apiUrl: "https://fj",
		token: "t",
		fetchFn: async () => {
			throw new Error("ECONNREFUSED");
		},
	});
	assert.ok((await network("acme/widgets", "alice")).indeterminate);
});

test("a 200 with no permission string is indeterminate, never a refusal", async () => {
	// Answering false would turn an upstream schema change into a silent, permanent refusal of every trigger.
	for (const permission of [40, null, undefined, {}, ["write"]]) {
		const resolve = makeResolveForgejoAuthority({ apiUrl: "https://fj", token: "t", fetchFn: async () => okResponse({ permission }) });
		assert.ok((await resolve("acme/widgets", "alice")).indeterminate, `permission ${JSON.stringify(permission)} is not a string this code understands`);
	}
});

test("a malformed repo or login refuses WITHOUT a lookup -- neither becomes a path segment unchecked", async () => {
	// A slash or a `..` in either half would reach a different endpoint than this function believes it is
	// asking, and the answer would be attributed to the wrong repository or the wrong person.
	let called = false;
	const resolve = makeResolveForgejoAuthority({ apiUrl: "https://fj", token: "t", fetchFn: async () => ((called = true), okResponse({ permission: "admin" })) });
	for (const [repo, login] of [
		["acme", "alice"],
		["a/b/c", "alice"],
		["acme/widgets", "../admin"],
		["acme/widgets", "a/b"],
		["acme/widgets", ""],
		[undefined, "alice"],
		["acme/widgets", undefined],
	]) {
		assert.deepEqual(await resolve(repo, login), { authorized: false }, `${JSON.stringify([repo, login])} must refuse`);
	}
	assert.equal(called, false, "there is nothing to ask about -- determinate, not a failure");
});
const LABEL_GROUP = { label: [{ index: 0, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix" }], comment: { index: 1, phrase: "@pi", defaultFlow: "triage" }, pullRequest: [], knownFlows: new Set(["frontend-fix", "triage"]) };

// --- replica fanout: one delivery, N jobs (REQ-REPLICA-RUNS, #187) ---

/** The label config above, with `replicas` on the matched rule. */
const replicaCfg = { ...cfg, triggers: forgeTriggers({ ...LABEL_GROUP, label: [{ ...LABEL_GROUP.label[0], replicas: 2 }] }) };

test("forgejo: a replicas: 2 trigger enqueues TWICE from one delivery, with distinct ids on BOTH dedup layers", async () => {
	const { handler, calls, logs } = build({ cfg: replicaCfg });
	const res = mockRes();
	await drive(handler, mockReq({ raw: LABELLED }), res, LABELLED);

	assert.equal(res.statusCode, 202);
	assert.equal(calls.length, 2, "one delivery, two independent jobs");
	assert.deepEqual(calls.map((c) => c.data.replica), [1, 2]);
	assert.deepEqual(calls.map((c) => c.data.replicas), [2, 2]);
	// Layer one: a duplicate `queue.add` under a taken jobId is SILENTLY ignored, so identical ids would
	// make the second replica vanish with no error surface at all.
	assert.deepEqual(calls.map((c) => c.opts.jobId), [`fj-fj-guid-1-r1`, `fj-fj-guid-1-r2`]);
	// Layer two: the 10-minute semantic window would otherwise coalesce the pair, since without `:r<i>`
	// both replicas compose the identical key.
	assert.deepEqual(calls.map((c) => c.opts.deduplication.id), [`acme/widgets#5:frontend-fix:r1`, `acme/widgets#5:frontend-fix:r2`]);
	assert.equal(logs.find((l) => l.event === "enqueued")?.replicas, 2, "the log says how many, so a pair is explainable from the receiver's own output");
});

test("forgejo: a throw on the SECOND replica answers 503 and leaves the first enqueued", async () => {
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
	await drive(handler, mockReq({ raw: LABELLED }), res, LABELLED);

	assert.equal(res.statusCode, 503);
	assert.deepEqual(seen, [`fj-fj-guid-1-r1`], "replica 1 is already in the queue and stays there");
});

test("forgejo: an unflagged trigger still enqueues EXACTLY once, with no replica key and today's jobId", async () => {
	const { handler, calls } = build();
	const res = mockRes();
	await drive(handler, mockReq({ raw: LABELLED }), res, LABELLED);

	assert.equal(calls.length, 1);
	assert.equal("replica" in calls[0].data, false);
	assert.equal("replicas" in calls[0].data, false);
	assert.equal(calls[0].opts.jobId, "fj-fj-guid-1");
});
