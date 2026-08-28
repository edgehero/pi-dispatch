import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { makeReceiver } from "../src/receiver.mjs";

const SECRET = "test-webhook-secret";
const SELF_ID = 999;

/**
 * Rules are grouped PER FORGE at load (receiver/src/config.mjs), so the github gate reads
 * `cfg.triggers.github`; `knownFlows` stays above the groups as the whole file's flow vocabulary.
 * The fixture stays flat and is wrapped here, so regrouping never edits an assertion.
 */
function forgeTriggers({ knownFlows, ...group }) {
	return { github: group, knownFlows };
}
// `servesGithub: true` is what mounts `/` at all (issue #99): the loader decides it from the triggers file
// plus GITHUB_AUTH_SOURCE, and this fixture is a github-serving deployment, so it says so explicitly. A
// fixture that omitted it would 404 every delivery below, which is the point of the pair of tests at the
// bottom of this file.
const cfg = {
	webhookSecret: SECRET,
	servesGithub: true,
	triggers: forgeTriggers({
		label: [{ index: 0, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix" }],
		comment: { index: 1, phrase: "@pi", defaultFlow: null },
		pullRequest: [
			{ index: 2, actions: new Set(["opened", "synchronize"]), predicate: {}, flow: "review" },
			{ index: 3, actions: new Set(["review_submitted"]), reviewStates: null, predicate: {}, flow: "address-review" },
		],
		knownFlows: new Set(["frontend-fix", "review", "address-review"]),
	}),
};

/** GitHub's `X-Hub-Signature-256` shape, computed the same way GitHub computes it. */
function sign(secret, raw) {
	return "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

/** EventEmitter-backed request mock: real streams are EventEmitters, so `on`/`emit` come for free. */
function mockReq({ method = "POST", headers = {} } = {}) {
	const req = new EventEmitter();
	req.method = method;
	req.headers = headers;
	req.destroyed = false;
	req.destroy = () => {
		req.destroyed = true;
	};
	return req;
}

/** Plain object response mock recording writeHead/statusCode/end -- no real socket. */
function mockRes() {
	return {
		statusCode: 0,
		headersSent: false,
		body: undefined,
		writeHead(status, headers) {
			this.statusCode = status;
			this.headers = headers;
			this.headersSent = true;
			return this;
		},
		end(body) {
			this.body = body;
			this.ended = true;
			return this;
		},
	};
}

/** Drive a handler: attach synchronously, then feed the raw bytes and await completion. */
async function drive(handler, req, res, raw) {
	const done = handler(req, res);
	if (raw !== undefined) {
		req.emit("data", Buffer.from(raw, "utf8"));
		req.emit("end");
	}
	await done;
}

/** Build the request headers GitHub sends, signing `raw` (or `signBytes` when it differs). */
function headersFor(event, delivery, raw, signBytes = raw) {
	return {
		"content-type": "application/json",
		"x-hub-signature-256": sign(SECRET, signBytes),
		"x-github-event": event,
		"x-github-delivery": delivery,
	};
}

/** A queue whose `add` records every call and returns a jobId, mirroring BullMQ's add contract. */
function recordingQueue() {
	const calls = [];
	const queue = {
		add: async (name, data, opts) => {
			calls.push({ name, data, opts });
			return { id: opts?.jobId };
		},
	};
	return { calls, queue };
}

test("signed issues.labeled (pi:frontend) enqueues one github job and responds 202", async () => {
	const delivery = "d-labeled";
	const payload = {
		action: "labeled",
		sender: { id: 1 },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B", labels: [{ name: "pi:frontend" }] },
	};
	const raw = JSON.stringify(payload);

	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	const req = mockReq({ headers: headersFor("issues", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, "github");
	assert.equal(calls[0].data.kind, "github");
	assert.equal(calls[0].data.flow, "frontend-fix");
	assert.equal(calls[0].data.target.type, "issue");
	assert.equal(calls[0].data.target.number, 42);
	assert.equal(calls[0].opts.jobId, "gh-" + delivery);
	assert.equal(res.statusCode, 202);
});

test("signed issue_comment with `@pi <flow>` enqueues 202: trigger.comment rides the job, never the log", async () => {
	const delivery = "d-comment";
	const payload = {
		action: "created",
		sender: { id: 1, login: "octocat-the-login" },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B" },
		comment: { author_association: "OWNER", body: "@pi frontend-fix comment-body-marker" },
	};
	const raw = JSON.stringify(payload);

	const logs = [];
	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: (entry) => logs.push(entry) });
	const req = mockReq({ headers: headersFor("issue_comment", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(res.statusCode, 202);
	assert.equal(calls.length, 1);
	// The enqueued job carries the invoking comment and the match record end to end.
	assert.deepEqual(calls[0].data.trigger.comment, { body: "@pi frontend-fix comment-body-marker", author_association: "OWNER" });
	assert.deepEqual(calls[0].data.trigger.matched, { index: 1, type: "comment", phrase: "@pi" });

	// no-pii-in-logs: the comment body is job DATA, never log material -- the enqueued line carries
	// stable identifiers only, and no login appears anywhere in it.
	const enqueued = logs.find((entry) => entry.event === "enqueued");
	assert.ok(enqueued, "an enqueued log line is emitted");
	const line = JSON.stringify(enqueued);
	assert.equal(line.includes("comment-body-marker"), false, "the enqueued log line must not carry the comment body");
	assert.equal(line.includes("octocat-the-login"), false, "the enqueued log line must not carry a login");
	assert.equal(line.includes("login"), false);
});

test("signed pull_request.opened by a collaborator enqueues a pull_request job and responds 202", async () => {
	const delivery = "d-propen";
	const payload = {
		action: "opened",
		sender: { id: 1 },
		repository: { full_name: "octo/repo" },
		pull_request: {
			number: 12,
			title: "PR T",
			body: "PR B",
			author_association: "COLLABORATOR",
			labels: [],
			head: { ref: "feat", sha: "abc", repo: { full_name: "octo/repo" } },
			base: { ref: "main" },
		},
	};
	const raw = JSON.stringify(payload);

	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	const req = mockReq({ headers: headersFor("pull_request", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].data.flow, "review");
	assert.equal(calls[0].data.target.type, "pull_request");
	assert.equal(calls[0].data.target.number, 12);
	assert.equal(calls[0].data.target.head.ref, "feat");
	assert.equal(res.statusCode, 202);
});

/** A `pull_request_review.submitted` payload whose two associations are independently settable. */
function reviewPayload({ author = "NONE", reviewer = "COLLABORATOR", state = "changes_requested", body = "rename the helper" } = {}) {
	return {
		action: "submitted",
		sender: { id: 1 },
		repository: { full_name: "octo/repo" },
		pull_request: {
			number: 12,
			title: "PR T",
			body: "PR B",
			author_association: author,
			labels: [],
			head: { ref: "feat", sha: "abc", repo: { full_name: "fork/x" } },
			base: { ref: "main" },
		},
		review: { id: 777, body, state, author_association: reviewer },
	};
}

test("a signed pull_request_review from a collaborator on a STRANGER's PR enqueues and responds 202", async () => {
	const delivery = "d-review";
	const raw = JSON.stringify(reviewPayload());

	const logs = [];
	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: (o) => logs.push(o) });
	const req = mockReq({ headers: headersFor("pull_request_review", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(res.statusCode, 202);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].data.flow, "address-review");
	assert.equal(calls[0].data.target.type, "pull_request");
	assert.equal(calls[0].opts.jobId, `gh-${delivery}`, "the delivery GUID is still the dedup key on this event");
	assert.deepEqual(calls[0].data.trigger.review, { id: 777, body: "rename the helper", state: "changes_requested", author_association: "COLLABORATOR" });
	// no-pii-in-logs: the review body is untrusted user text and must never reach a log line.
	assert.equal(JSON.stringify(logs).includes("rename the helper"), false, "the review body must not appear in the log sink");
});

test("a signed pull_request_review from a STRANGER is dropped 204, and the LOG says which gate refused it", async () => {
	// The mirror of the test above: the PR author is now an OWNER and the reviewer a stranger. Reading
	// pull_request.author_association would enqueue this, so the pair is what proves the gate's subject.
	const delivery = "d-review-stranger";
	const raw = JSON.stringify(reviewPayload({ author: "OWNER", reviewer: "NONE" }));

	const logs = [];
	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: (o) => logs.push(o) });
	const req = mockReq({ headers: headersFor("pull_request_review", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(res.statusCode, 204);
	assert.equal(calls.length, 0, "a stranger's review must not launch a paid run");
	assert.deepEqual(logs.at(-1), { event: "dropped", delivery, reason: "review-author-not-allowed" });
});

test("signed pull_request.opened from a fork author (NONE) is dropped 204, nothing enqueued", async () => {
	const delivery = "d-prfork";
	const payload = {
		action: "opened",
		sender: { id: 1 },
		repository: { full_name: "octo/repo" },
		pull_request: {
			number: 13,
			title: "PR T",
			body: "PR B",
			author_association: "NONE",
			labels: [],
			head: { ref: "feat", sha: "abc", repo: { full_name: "attacker/repo" } },
			base: { ref: "main" },
		},
	};
	const raw = JSON.stringify(payload);

	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	const req = mockReq({ headers: headersFor("pull_request", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(calls.length, 0, "a fork PR must not auto-fire a paid job");
	assert.equal(res.statusCode, 204);
});

test("self-comment (sender.id === selfId) is dropped 204, nothing enqueued", async () => {
	const delivery = "d-self";
	const payload = {
		action: "created",
		sender: { id: SELF_ID },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B" },
		comment: { author_association: "OWNER", body: "@pi" },
	};
	const raw = JSON.stringify(payload);

	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	const req = mockReq({ headers: headersFor("issue_comment", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(calls.length, 0);
	assert.equal(res.statusCode, 204);
});

test("a signature over different bytes is rejected 401 before onVerified -- nothing enqueued", async () => {
	const delivery = "d-401";
	const payload = {
		action: "labeled",
		sender: { id: 1 },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B", labels: [{ name: "pi:frontend" }] },
	};
	const raw = JSON.stringify(payload);

	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	// Signature computed over tampered bytes: D2 rejects before onVerified runs.
	const req = mockReq({ headers: headersFor("issues", delivery, raw, raw + "tampered") });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(res.statusCode, 401);
	assert.equal(calls.length, 0);
});

test("Valkey down: an enqueue that throws maps to 503, no unhandled rejection", async () => {
	const rejections = [];
	const onRej = (e) => rejections.push(e);
	process.on("unhandledRejection", onRej);
	try {
		const delivery = "d-valkey";
		const payload = {
			action: "labeled",
			sender: { id: 1 },
			repository: { full_name: "octo/repo" },
			issue: { number: 42, title: "T", body: "B", labels: [{ name: "pi:frontend" }] },
		};
		const raw = JSON.stringify(payload);

		const queue = {
			add: async () => {
				throw new Error("ECONNREFUSED");
			},
		};
		const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
		const req = mockReq({ headers: headersFor("issues", delivery, raw) });
		const res = mockRes();
		await drive(handler, req, res, raw);

		// Let any stray rejection surface before asserting.
		await new Promise((r) => setImmediate(r));

		assert.equal(res.statusCode, 503);
		assert.equal(rejections.length, 0, "enqueue failure must be handled, not an unhandled rejection");
	} finally {
		process.removeListener("unhandledRejection", onRej);
	}
});

test("malformed JSON with a VALID signature responds 400, nothing enqueued", async () => {
	const delivery = "d-badjson";
	const raw = "{ not valid json";

	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	// Sign the exact malformed bytes so verification passes and the parse is what fails.
	const req = mockReq({ headers: headersFor("issues", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(res.statusCode, 400);
	assert.equal(calls.length, 0);
});

test("NONE-author comment is dropped 204, nothing enqueued", async () => {
	const delivery = "d-none";
	const payload = {
		action: "created",
		sender: { id: 1 },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B" },
		comment: { author_association: "NONE", body: "@pi" },
	};
	const raw = JSON.stringify(payload);

	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	const req = mockReq({ headers: headersFor("issue_comment", delivery, raw) });
	const res = mockRes();
	await drive(handler, req, res, raw);

	assert.equal(calls.length, 0);
	assert.equal(res.statusCode, 204);
});

// --- replica fanout: one delivery, N jobs (REQ-REPLICA-RUNS) ---

/** The label config above, with `replicas` on the matched rule. */
const replicaCfg = {
	webhookSecret: SECRET,
	servesGithub: true,
	triggers: forgeTriggers({
		label: [{ index: 0, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix", replicas: 2 }],
		comment: { index: 1, phrase: "@pi", defaultFlow: null },
		pullRequest: [],
		knownFlows: new Set(["frontend-fix"]),
	}),
};

const LABELED_PAYLOAD = {
	action: "labeled",
	sender: { id: 1 },
	repository: { full_name: "octo/repo" },
	issue: { number: 42, title: "T", body: "B", labels: [{ name: "pi:frontend" }] },
};

test("a replicas: 2 trigger enqueues TWICE from one delivery, with distinct ids, and still answers 202", async () => {
	const delivery = "d-replicas";
	const raw = JSON.stringify(LABELED_PAYLOAD);
	const logs = [];
	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg: replicaCfg, log: (e) => logs.push(e) });
	const res = mockRes();
	await drive(handler, mockReq({ headers: headersFor("issues", delivery, raw) }), res, raw);

	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map((c) => c.opts.jobId), [`gh-${delivery}-r1`, `gh-${delivery}-r2`]);
	assert.deepEqual(calls.map((c) => c.data.replica), [1, 2]);
	assert.deepEqual(calls.map((c) => c.data.replicas), [2, 2]);
	// Both dedup layers diverge, not just the id: an identical semantic key would coalesce the second job
	// into the first's 10-minute window and it would never run.
	assert.equal(new Set(calls.map((c) => c.opts.deduplication.id)).size, 2);
	assert.equal(res.statusCode, 202);
	assert.equal(logs.find((l) => l.event === "enqueued")?.replicas, 2, "the log says how many, so a pair is explainable from the receiver's own output");
});

test("a throw on the SECOND replica answers 503 and leaves the first enqueued -- the retry is idempotent by construction", async () => {
	// No compensating logic exists and none is needed: GitHub redelivers, replica 1 dedups on its own
	// now-taken jobId, and replica 2 enqueues. The retry converges on exactly two jobs, never three.
	const delivery = "d-replicas-fail";
	const raw = JSON.stringify(LABELED_PAYLOAD);
	const calls = [];
	const queue = {
		add: async (name, data, opts) => {
			if (data.replica === 2) throw new Error("valkey down");
			calls.push(opts.jobId);
			return { id: opts.jobId };
		},
	};
	const res = mockRes();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg: replicaCfg, log: () => {} });
	await drive(handler, mockReq({ headers: headersFor("issues", delivery, raw) }), res, raw);

	assert.equal(res.statusCode, 503, "retryable, so GitHub redelivers");
	assert.deepEqual(calls, [`gh-${delivery}-r1`], "replica 1 is already in the queue and stays there");
});

// --- the `/` route exists only where github is served (issue #99) ----------------------------------

/**
 * A GitLab-only deployment as the loader produces it: `servesGithub: false`, no webhook secret (there is
 * no endpoint for one to protect), and an empty github group. The github arm is not built at all, so `/`
 * has no handler -- and `selfId` is undefined here on purpose, because a deployment that resolves no
 * GitHub identity is exactly the one that must not be answering GitHub deliveries.
 */
const githubFreeCfg = {
	servesGithub: false,
	triggers: {
		github: { label: [], comment: null, pullRequest: [] },
		gitlab: { label: [{ index: 0, predicate: { any: ["pi:frontend"] }, flow: "gl-fix" }], comment: null, pullRequest: [] },
		knownFlows: new Set(["gl-fix"]),
	},
};

test("POST / on a github-free deployment is 404 -- not 401, not 405 -- and nothing is enqueued", async () => {
	// 404 for the same reason the other three forges' unconfigured paths answer 404: a 401 says "armed, and
	// you got the secret wrong", and an operator who reads that will spend an hour rotating a secret for an
	// endpoint that does not exist. 405 would be just as misleading -- it discusses the method of a live
	// endpoint. The status has to say "there is nothing here".
	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: undefined, cfg: githubFreeCfg, log: () => {} });

	const raw = JSON.stringify(LABELED_PAYLOAD);
	const post = mockRes();
	await drive(handler, mockReq({ headers: headersFor("issues", "d-nogithub", raw) }), post, raw);
	assert.equal(post.statusCode, 404);
	assert.match(String(post.body), /not configured/, "the body says the forge is unconfigured, like every other arm's 404");
	assert.equal(calls.length, 0, "and no job: an absent endpoint cannot spend money");

	// A well-formed GET must not fall through to the verified handler's 405 either -- that would be a live
	// endpoint discussing methods.
	const get = mockRes();
	await drive(handler, mockReq({ method: "GET", headers: {} }), get, undefined);
	assert.equal(get.statusCode, 404, "not 405");
});

test("an unrouted path on a github-free deployment is 404 too -- the fallthrough itself is gone", async () => {
	// `/` and every unrouted path share the github fallthrough, so removing the arm must remove all of it.
	const { queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: undefined, cfg: githubFreeCfg, log: () => {} });
	const raw = JSON.stringify(LABELED_PAYLOAD);
	const req = mockReq({ headers: headersFor("issues", "d-unrouted", raw) });
	req.url = "/anything";
	const res = mockRes();
	await drive(handler, req, res, raw);
	assert.equal(res.statusCode, 404);
});

test("the SAME bad-signature delivery is still 401 where github IS served -- both directions, one pair", async () => {
	// The regression this pair pins is bidirectional: making `/` conditional must not soften the trust
	// boundary for the deployments that do serve github. Same bytes, same tampered signature, two configs.
	const raw = JSON.stringify(LABELED_PAYLOAD);
	const headers = headersFor("issues", "d-pair", raw, raw + "tampered");

	const served = mockRes();
	const { calls, queue } = recordingQueue();
	await drive(makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} }), mockReq({ headers }), served, raw);
	assert.equal(served.statusCode, 401, "github served: the HMAC boundary answers, exactly as before");

	const free = mockRes();
	await drive(makeReceiver({ queue, selfId: undefined, cfg: githubFreeCfg, log: () => {} }), mockReq({ headers }), free, raw);
	assert.equal(free.statusCode, 404, "github not served: there is no boundary to fail, because there is no endpoint");
	assert.equal(calls.length, 0);
});

test("an unflagged trigger still enqueues EXACTLY once, with no replica key and today's jobId", async () => {
	const delivery = "d-noreplicas";
	const raw = JSON.stringify(LABELED_PAYLOAD);
	const { calls, queue } = recordingQueue();
	const res = mockRes();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg, log: () => {} });
	await drive(handler, mockReq({ headers: headersFor("issues", delivery, raw) }), res, raw);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].opts.jobId, `gh-${delivery}`);
	assert.equal("replica" in calls[0].data, false);
	assert.equal("replicas" in calls[0].data, false);
	assert.equal(res.statusCode, 202);
});

// --- close triggers: the closer-authority lookup (issue #231) --------------------------------------

/**
 * A deployment with an issue close one-shot armed, beside the label/comment rules the base cfg carries,
 * so the zero-lookup pins below can drive NON-close deliveries against a config where close rules exist.
 */
const closeCfg = {
	webhookSecret: SECRET,
	servesGithub: true,
	triggers: forgeTriggers({
		label: [{ index: 0, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix" }],
		comment: { index: 1, phrase: "@pi", defaultFlow: "triage" },
		pullRequest: [],
		issue: [{ index: 2, actions: new Set(["closed"]), number: 40, once: true, flow: "deploy" }],
		prClose: [],
		knownFlows: new Set(["frontend-fix", "triage", "deploy"]),
	}),
};

/** A signed-shape `issues.closed` payload for the armed one-shot's item, overridable per case. */
function closedPayload({ number = 40, senderId = 7 } = {}) {
	return {
		action: "closed",
		sender: { id: senderId, login: "closer-login-marker" },
		repository: { full_name: "octo/repo" },
		issue: { number, title: "T", body: "B" },
	};
}

/** A resolver fake recording every (repo, login) it was asked, answering `result`. */
function resolverFake(result) {
	const calls = [];
	return { calls, resolveAuthority: async (repo, login) => (calls.push([repo, login]), result) };
}

test("an authorized closer: the resolver is asked ONCE with (repo, login), 202, and trigger.sender carries the id ONLY", async () => {
	const delivery = "d-close-ok";
	const raw = JSON.stringify(closedPayload());
	const { calls, queue } = recordingQueue();
	const resolver = resolverFake({ authorized: true });
	const logs = [];
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg: closeCfg, log: (o) => logs.push(o), resolveAuthority: resolver.resolveAuthority });
	const res = mockRes();
	await drive(handler, mockReq({ headers: headersFor("issues", delivery, raw) }), res, raw);

	assert.equal(res.statusCode, 202);
	assert.deepEqual(resolver.calls, [["octo/repo", "closer-login-marker"]], "one lookup, addressed by the subset's repo and the closer's login");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].data.flow, "deploy");
	// THE pin: the login entered the subset for the lookup and must go NO further. The job's descriptive
	// trigger context stays `{ id }`, byte-identical to every pre-#231 job.
	assert.deepEqual(calls[0].data.trigger.sender, { id: 7 });
	assert.equal(JSON.stringify(calls[0].data).includes("closer-login-marker"), false, "no login anywhere in the enqueued job");
	assert.equal(JSON.stringify(logs).includes("closer-login-marker"), false, "and none in any log line (no-pii-in-logs)");
});

test("an unauthorized closer is dropped 204, and the LOG says the closer gate refused it", async () => {
	const delivery = "d-close-refused";
	const raw = JSON.stringify(closedPayload());
	const { calls, queue } = recordingQueue();
	const resolver = resolverFake({ authorized: false });
	const logs = [];
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg: closeCfg, log: (o) => logs.push(o), resolveAuthority: resolver.resolveAuthority });
	const res = mockRes();
	await drive(handler, mockReq({ headers: headersFor("issues", delivery, raw) }), res, raw);

	assert.equal(res.statusCode, 204);
	assert.equal(calls.length, 0, "a stranger's close must not fire the one-shot");
	assert.deepEqual(logs.at(-1), { event: "dropped", delivery, reason: "closer-not-allowed" });
});

test("an indeterminate lookup is 503 permission-lookup-failed (redeliverable), never 204, and the log names the lookup", async () => {
	// 204 would drop real work during an outage, and on the wire it is indistinguishable from a stranger
	// being correctly refused. GitHub redelivers; the GUID jobId coalesces the retry.
	const delivery = "d-close-indet";
	const raw = JSON.stringify(closedPayload());
	const { calls, queue } = recordingQueue();
	const resolver = resolverFake({ indeterminate: "status-502" });
	const logs = [];
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg: closeCfg, log: (o) => logs.push(o), resolveAuthority: resolver.resolveAuthority });
	const res = mockRes();
	await drive(handler, mockReq({ headers: headersFor("issues", delivery, raw) }), res, raw);

	assert.equal(res.statusCode, 503);
	assert.deepEqual(JSON.parse(res.body), { error: "permission-lookup-failed" });
	assert.equal(calls.length, 0);
	assert.deepEqual(logs.at(-1), { event: "github_permission_lookup_failed", delivery, reason: "status-502" });
	assert.equal(JSON.stringify(logs).includes("closer-login-marker"), false, "the reason names the lookup, never the actor (no-pii-in-logs)");
});

test("ZERO lookups for every delivery no armed close rule wants -- label, comment, wrong number, self-close", async () => {
	// The acceptance pins from CONST-TRIGGER-AUTHOR-GATE's close arm: the lookup is a paid network step,
	// and every path but "a close an armed rule matches" must stay payload-only. The resolver fake WOULD
	// authorize, so any stray call also shows up as a wrongly-enqueued job -- but the call count is the
	// assertion.
	const { calls, queue } = recordingQueue();
	const resolver = resolverFake({ authorized: true });
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg: closeCfg, log: () => {}, resolveAuthority: resolver.resolveAuthority });

	// A labeled delivery, close rules armed elsewhere in the same group: the label route asks no
	// authority question, and its job still enqueues.
	const labeled = JSON.stringify(LABELED_PAYLOAD);
	await drive(handler, mockReq({ headers: headersFor("issues", "d-close-z1", labeled) }), mockRes(), labeled);
	assert.equal(resolver.calls.length, 0, "a labeled delivery costs no lookup");
	assert.equal(calls.length, 1, "and still enqueues on its own gate");

	// A comment delivery: author_association is the gate, payload-only as ever.
	const comment = JSON.stringify({
		action: "created",
		sender: { id: 7, login: "closer-login-marker" },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B" },
		comment: { author_association: "OWNER", body: "@pi" },
	});
	await drive(handler, mockReq({ headers: headersFor("issue_comment", "d-close-z2", comment) }), mockRes(), comment);
	assert.equal(resolver.calls.length, 0, "a comment delivery costs no lookup");

	// A close the one-shot does not name: findCloseRule misses, so there is nothing to gate.
	const wrongNumber = JSON.stringify(closedPayload({ number: 41 }));
	const missRes = mockRes();
	await drive(handler, mockReq({ headers: headersFor("issues", "d-close-z3", wrongNumber) }), missRes, wrongNumber);
	assert.equal(resolver.calls.length, 0, "a close matching no armed rule costs no lookup");
	assert.equal(missRes.statusCode, 204);

	// The harness closing its own issue -- the natural last act of the very flow the trigger armed. The
	// self guard runs BEFORE the lookup, so it costs nothing and can never 503-loop on an outage.
	const selfClose = JSON.stringify(closedPayload({ senderId: SELF_ID }));
	const selfRes = mockRes();
	await drive(handler, mockReq({ headers: headersFor("issues", "d-close-z4", selfClose) }), selfRes, selfClose);
	assert.equal(resolver.calls.length, 0, "a self-close costs no lookup");
	assert.equal(selfRes.statusCode, 204);

	assert.equal(calls.length, 2, "exactly the label and comment jobs -- no close enqueued anywhere here");
});

test("an armed close rule with NO resolver wired answers 503, never an unbacked verdict", async () => {
	// Defensive-only in a wired receiver (start.mjs hard-fails on github auth before mounting `/`), so the
	// handler is constructed directly without the dep, which is the only way to reach the branch. Fail
	// closed but retryable: a wiring fault must not read as a stranger being correctly refused.
	const delivery = "d-close-nodep";
	const raw = JSON.stringify(closedPayload());
	const { calls, queue } = recordingQueue();
	const handler = makeReceiver({ queue, selfId: SELF_ID, cfg: closeCfg, log: () => {} });
	const res = mockRes();
	await drive(handler, mockReq({ headers: headersFor("issues", delivery, raw) }), res, raw);

	assert.equal(res.statusCode, 503);
	assert.deepEqual(JSON.parse(res.body), { error: "permission-lookup-failed" });
	assert.equal(calls.length, 0);
});
