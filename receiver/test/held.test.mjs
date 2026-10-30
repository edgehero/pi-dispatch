import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { awaitTargetKeyOf, closeHeld, recentlyParked, registerAwaitLive } from "@edgehero/pi-dispatch/held-replies";
import { forgeMessageId, steerTargetKey } from "@edgehero/pi-dispatch/steer-inbox";
import { filter } from "../src/filter.mjs";
import { filterAzure } from "../src/filter-azure.mjs";
import { filterForgejo } from "../src/filter-forgejo.mjs";
import { filterGitLab } from "../src/filter-gitlab.mjs";
import { holdAfterDedup, holdBeforeLabel, wantsHoldAfterDedup } from "../src/held.mjs";
import { makeReceiver, parseSubset } from "../src/receiver.mjs";
import { fallbackJobOf } from "../src/steer.mjs";
import { startPoller } from "../src/poller.mjs";
import { parseGitLabSubset } from "../src/gitlab-subset.mjs";
import { parseForgejoSubset } from "../src/forgejo-subset.mjs";
import { parseAzureSubset } from "../src/azure-subset.mjs";

// Issue #638: an answer to a run that is parking right now is held, never swallowed. Two receiver paths: (a) a resume
// comment the semantic window deduplicated against a live awaitInput run is held under the surviving run; (b) a
// phrase-free reply the filter dropped only for the missing parked marker (`heldCandidate`) is held under every live
// awaitInput run on its target. Everything else answers exactly as before.

const NOW = 1_800_000_000_000;
const clock = () => NOW;
// A body no log line may carry (no-pii-in-logs).
const MARK = "zq-held-body-marker-3b9";
const GH_SECRET = "gh-secret";
const FJ_SECRET = "forgejo-secret";
const GL_TOKEN = "gl-token";
const AZ_BASIC = Buffer.from("hooks:s3cret", "utf8").toString("base64");
const PARKED = "pi-awaiting-input";

const commentRule = (extra = {}) => ({ index: 1, phrase: "@pi", defaultFlow: "triage", resume: true, awaitInput: true, ...extra });
const empty = { label: [], comment: null, pullRequest: [] };
function cfgWith(rule = commentRule()) {
	return {
		webhookSecret: GH_SECRET,
		servesGithub: true,
		triggers: {
			github: { ...empty, comment: rule },
			gitlab: { ...empty, comment: rule },
			forgejo: { ...empty, comment: rule },
			azure: { ...empty, comment: { ...rule, repository: "widgets" } },
			knownFlows: new Set(["triage"]),
		},
	};
}

/** The held-replies calls a receiver makes (zrangebyscore, eval), recorded; `members` per key, `outcomes` per run. */
function fakeRedis({ members = {}, outcomes = {}, failLookup = false, failHold = false, parked = [] } = {}) {
	const r = {
		touched: 0,
		zcalls: [],
		holds: [],
		// The parked markers a park's take raised (`run:await:parked:<hex32>`), by await target key.
		async exists(k) {
			r.touched += 1;
			return parked.some((t) => k === `run:await:parked:${t.slice("run:await:target:".length)}`) ? 1 : 0;
		},
		async zrangebyscore(key, min, max, _limit, offset, count) {
			r.touched += 1;
			r.zcalls.push({ key, min, max, offset, count });
			if (failLookup) throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
			return (members[key] ?? []).slice(0, count);
		},
		async eval(_script, nkeys, ...rest) {
			r.touched += 1;
			const keys = rest.slice(0, nkeys);
			const args = rest.slice(nkeys);
			if (failHold) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
			assert.ok(keys[0].startsWith("run:await:open:"), "a hold, never a steer push");
			const runId = keys[0].slice("run:await:open:".length);
			r.holds.push({ runId, keys, entry: JSON.parse(args[1]) });
			return outcomes[runId] ?? "ok";
		},
	};
	return r;
}

const sign = (secret, raw) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
function mockRes() {
	return {
		statusCode: 0,
		body: undefined,
		writeHead(s) {
			this.statusCode = s;
		},
		end(b) {
			this.body = b;
		},
	};
}
async function drive(handler, req, raw) {
	const res = mockRes();
	const p = handler(req, res);
	req.emit("data", Buffer.from(raw, "utf8"));
	req.emit("end");
	await p;
	return res;
}
function request(url, headers) {
	const req = new EventEmitter();
	req.url = url;
	req.method = "POST";
	req.headers = { "content-type": "application/json", ...headers };
	req.destroy = () => {};
	return req;
}

/** One row per forge: its comment delivery, signed and addressed, and the target and arm grammar it logs. */
const FORGES = {
	github: {
		raw: ({ body, labels = [], pr = false }) => JSON.stringify({ action: "created", sender: { id: 5 }, repository: { full_name: "o/r" }, issue: { number: 7, title: "T", body: "B", labels: labels.map((name) => ({ name })), ...(pr ? { pull_request: { url: "x" } } : {}) }, comment: { body, author_association: "OWNER" } }),
		req: (raw, delivery) => request("/", { "x-github-event": "issue_comment", "x-github-delivery": delivery, "x-hub-signature-256": sign(GH_SECRET, raw) }),
		target: { repo: "o/r", targetType: "issue", number: 7 },
		logTarget: "issue#7",
		gate: ({ body, labels = [], pr, cfg = cfgWith() }) => filter("issue_comment", parseSubset(JSON.parse(FORGES.github.raw({ body, labels, pr }))), cfg, 999, "d-1"),
	},
	gitlab: {
		raw: ({ body, labels = [], pr = false }) => JSON.stringify({ object_kind: "note", user: { id: 5, username: "dev" }, project: { id: 42, path_with_namespace: "g/p", default_branch: "main" }, object_attributes: { note: body, noteable_type: pr ? "MergeRequest" : "Issue", action: "create" }, ...(pr ? { merge_request: { iid: 7, title: "T", description: "B", labels: labels.map((title) => ({ title })), source_branch: "f", target_branch: "main" } } : { issue: { iid: 7, title: "T", description: "B", labels: labels.map((title) => ({ title })) } }) }),
		req: (_raw, delivery) => request("/gitlab", { "x-gitlab-event": "Note Hook", "webhook-id": delivery, "x-gitlab-token": GL_TOKEN }),
		target: { repo: "g/p", targetType: "issue", number: 7 },
		logTarget: "g/p#7",
		gate: ({ body, labels = [], pr, cfg = cfgWith() }) => filterGitLab(parseGitLabSubset(JSON.parse(FORGES.gitlab.raw({ body, labels, pr }))), cfg.triggers.gitlab, cfg.triggers.knownFlows, 999, true, "d-1"),
	},
	forgejo: {
		raw: ({ body, labels = [], pr = false }) => JSON.stringify({ action: "created", sender: { id: 5, login: "dev" }, repository: { full_name: "acme/w" }, issue: { number: 7, title: "T", body: "B", labels: labels.map((name) => ({ name })) }, comment: { body }, is_pull: pr }),
		req: (raw, delivery) => request("/forgejo", { "x-github-event": "issue_comment", "x-github-delivery": delivery, "x-hub-signature-256": sign(FJ_SECRET, raw) }),
		target: { repo: "acme/w", targetType: "issue", number: 7 },
		logTarget: "issue#7",
		gate: ({ body, labels = [], pr, cfg = cfgWith() }) => filterForgejo("issue_comment", parseForgejoSubset(JSON.parse(FORGES.forgejo.raw({ body, labels, pr }))), cfg.triggers.forgejo, cfg.triggers.knownFlows, 999, true, "d-1"),
	},
	azure: {
		raw: ({ body, labels = [], delivery = "d-1" }) => JSON.stringify({ id: delivery, eventType: "workitem.commented", resourceContainers: { project: { id: "proj-guid" } }, resource: { workItemId: 7, fields: { "System.ChangedBy": { newValue: "Dev <dev@example.com>" }, "System.History": { newValue: body } }, revision: { fields: { "System.Title": "T", "System.TeamProject": "Fabrikam", "System.Tags": labels.join("; ") } } } }),
		req: () => request("/azure", { authorization: `Basic ${AZ_BASIC}` }),
		target: { repo: "Fabrikam/widgets", targetType: "issue", number: 7 },
		logTarget: "Fabrikam/widgets#7",
		gate: ({ body, labels = [], cfg = cfgWith() }) => filterAzure(parseAzureSubset(JSON.parse(FORGES.azure.raw({ body, labels, delivery: "d-1" }))), cfg.triggers.azure, cfg.triggers.knownFlows, { id: "self-guid", email: "bot@example.com" }, true, "d-1"),
	},
};

const awaitKeyOf = (forge) => awaitTargetKeyOf({ kind: forge, repo: FORGES[forge].target.repo, target: { type: "issue", number: 7 } });

/** A receiver over a fake queue; `survivor` makes every add a semantic-window swallow by that job. */
function build({ redis = fakeRedis(), cfg = cfgWith(), survivor = null, steerRedis, now = clock } = {}) {
	const calls = [];
	const logs = [];
	const queue = { add: async (name, data, opts) => (calls.push({ name, data, opts }), { id: survivor ?? opts?.jobId }) };
	const resolveAuthority = async () => ({ authorized: true });
	const handler = makeReceiver({
		queue,
		selfId: 999,
		cfg,
		log: (o) => logs.push(o),
		gitlab: { mode: "token", secret: GL_TOKEN, selfId: 999, resolveAuthority },
		forgejo: { secret: FJ_SECRET, selfId: 999, resolveAuthority },
		azure: { mode: "basic", secret: AZ_BASIC, selfId: { id: "self-guid", email: "bot@example.com" }, resolveAuthority },
		steerRedis: steerRedis ?? (() => redis),
		now,
	});
	return { handler, calls, logs, redis };
}

async function deliver(forge, { body = `${MARK} the answer`, delivery = "d-1", labels, redis, cfg, survivor, steerRedis } = {}) {
	const b = build({ redis, cfg, survivor, steerRedis });
	const raw = FORGES[forge].raw({ body, labels, delivery });
	const res = await drive(b.handler, FORGES[forge].req(raw, delivery), raw);
	return { ...b, res };
}

const noBodyInLogs = (logs) => {
	for (const line of logs) assert.ok(!JSON.stringify(line).includes(MARK), `a log line carries the comment body: ${JSON.stringify(line)}`);
};

// ---------------------------------------------------------------------------------------------------------------
// The filters: heldCandidate only when the missing marker is the ONLY reason, and it is the parked-reply job itself
// ---------------------------------------------------------------------------------------------------------------

for (const forge of Object.keys(FORGES)) {
	const gate = FORGES[forge].gate;

	test(`${forge}: a phrase-free reply missing only the marker is still a drop, carrying the parked-reply job byte for byte`, () => {
		const drop = gate({ body: "the answer is 42" });
		const withMarker = gate({ body: "the answer is 42", labels: [PARKED] });
		assert.equal(withMarker.enqueue, true);
		assert.equal(withMarker.job.parkedReply, true);
		assert.deepEqual(Object.keys(drop), ["enqueue", "reason", "heldCandidate"]);
		assert.equal(drop.enqueue, false);
		assert.equal(drop.reason, "no-trigger-phrase", "the same drop reason as before, for the log and the 204");
		assert.equal(JSON.stringify(drop.heldCandidate), JSON.stringify(withMarker.job), "built by the same function: the same bytes, key order included");
	});

	test(`${forge}: every other drop and every enqueue carries no heldCandidate, byte-identical to before`, () => {
		const rows = [
			[{ body: "the answer", cfg: cfgWith(commentRule({ resume: undefined })) }, { enqueue: false, reason: "no-trigger-phrase" }, "no run.resume"],
			[{ body: "the answer", cfg: cfgWith(commentRule({ command: "wf run", defaultFlow: undefined })) }, { enqueue: false, reason: "no-trigger-phrase" }, "a command rule"],
			[{ body: "the answer", cfg: cfgWith(commentRule({ defaultFlow: undefined })) }, { enqueue: false, reason: "no-trigger-phrase" }, "the parked route would refuse no-flow"],
		];
		if (forge !== "azure") rows.push([{ body: "the answer", pr: true }, { enqueue: false, reason: "no-trigger-phrase" }, "a pull request keeps its phrase"]);
		for (const [args, want, label] of rows) assert.deepEqual(gate(args), want, label);
		assert.equal("heldCandidate" in gate({ body: "the answer", labels: [PARKED] }), false, "with the marker it is enqueued, as before");
		assert.equal("heldCandidate" in gate({ body: "@pi go" }), false, "a phrase comment is enqueued, as before");
		assert.equal("parkedReply" in gate({ body: "@pi go" }).job, false);
	});
}

test("github: a stranger's phrase-free reply is refused by the author gate first, with no candidate", () => {
	const raw = JSON.parse(FORGES.github.raw({ body: "the answer" }));
	raw.comment.author_association = "NONE";
	assert.deepEqual(filter("issue_comment", parseSubset(raw), cfgWith(), 999, "d-1"), { enqueue: false, reason: "author-not-allowed" });
});

// ---------------------------------------------------------------------------------------------------------------
// The webhook arms, (b): a phrase-free reply before the marker
// ---------------------------------------------------------------------------------------------------------------

for (const forge of Object.keys(FORGES)) {
	test(`${forge}: a phrase-free reply before the marker, with a live await run, is HELD (202 held), not enqueued, and logged by id`, async () => {
		const key = awaitKeyOf(forge);
		const { res, calls, logs, redis } = await deliver(forge, { redis: fakeRedis({ members: { [key]: ["run-1"] } }) });
		assert.equal(res.statusCode, 202);
		assert.deepEqual(JSON.parse(res.body), { status: "held", runs: 1 });
		assert.equal(calls.length, 0, "nothing enqueued");
		assert.deepEqual(redis.zcalls.map((z) => z.key), [key], "the await target, never the steer one");
		assert.notEqual(key, steerTargetKey({ kind: forge, ...FORGES[forge].target }));
		const h = redis.holds[0];
		assert.equal(h.runId, "run-1");
		assert.equal(h.entry.id, forgeMessageId("d-1"));
		assert.equal(h.entry.route, "pre-label");
		assert.equal(h.entry.at, NOW, "the receipt is the injected receiver clock, independent of forge payload timestamps");
		assert.equal(h.entry.fallback.parkedReply, true);
		assert.equal(h.entry.fallback.kind, forge);
		// The fallback is exactly the job the marker would have enqueued, as the late steer stores it (one spelling).
		assert.deepEqual(h.entry.fallback, JSON.parse(JSON.stringify(fallbackJobOf(FORGES[forge].gate({ body: `${MARK} the answer`, labels: [PARKED] }).job, forge))));
		assert.deepEqual(logs.find((l) => l.event === "held"), { event: "held", delivery: "d-1", repo: FORGES[forge].target.repo, target: FORGES[forge].logTarget, route: "pre-label", runId: "run-1" });
		assert.equal(logs.some((l) => l.event === "dropped"), false);
		noBodyInLogs(logs);
	});

	test(`${forge}: with no live await run the drop is today's, byte-identical: 204, no body, the same dropped line`, async () => {
		const held = await deliver(forge, { redis: fakeRedis() });
		const before = await deliver(forge, { cfg: cfgWith(commentRule({ resume: undefined })), redis: fakeRedis() });
		for (const r of [held, before]) {
			assert.equal(r.res.statusCode, 204);
			assert.equal(r.res.body, undefined);
			assert.deepEqual(r.logs, [{ event: "dropped", delivery: "d-1", reason: "no-trigger-phrase" }]);
			assert.equal(r.calls.length, 0);
		}
		assert.equal(before.redis.touched, 0, "a drop with no candidate never asks Valkey");
	});
}

for (const forge of Object.keys(FORGES)) {
	test(`${forge}: review round 2: a phrase-free reply delivered AFTER the park's take (the run off its target, the marker raised) is enqueued as a parked reply, never dropped`, async () => {
		const key = awaitKeyOf(forge);
		const { res, calls, logs } = await deliver(forge, { redis: fakeRedis({ parked: [key] }) });
		assert.equal(res.statusCode, 202);
		assert.deepEqual(JSON.parse(res.body), { status: "queued" });
		assert.equal(calls.length, 1, "enqueued as the job the label would have routed");
		assert.equal(calls[0].data.parkedReply, true);
		assert.ok(calls[0].opts.deduplication, "with the window, so it coalesces against the taken job");
		assert.deepEqual(logs.find((l) => l.event === "held_after_park"), { event: "held_after_park", delivery: "d-1", kind: forge, repo: FORGES[forge].target.repo, target: FORGES[forge].logTarget });
		assert.equal(logs.some((l) => l.event === "dropped"), false);
		noBodyInLogs(logs);
	});
}

test("a marker for ANOTHER target, or a live run that takes the reply, means no parked-reply enqueue", async () => {
	const other = await deliver("github", { redis: fakeRedis({ parked: [awaitTargetKeyOf({ kind: "github", repo: "o/r", target: { type: "issue", number: 8 } })] }) });
	assert.equal(other.res.statusCode, 204);
	const key = awaitKeyOf("github");
	const live = await deliver("github", { redis: fakeRedis({ members: { [key]: ["r1"] }, parked: [key] }) });
	assert.deepEqual(JSON.parse(live.res.body), { status: "held", runs: 1 }, "a live run holds it first");
	assert.equal(live.calls.length, 0);
});

test("a hold every run refuses (gone, closed, a reply outside the vocabulary), a lookup fault, a hold fault or no client: today's drop exactly", async () => {
	const key = awaitKeyOf("github");
	const cases = [
		fakeRedis({ members: { [key]: ["r1", "r2"] }, outcomes: { r1: "gone", r2: "closed" } }),
		fakeRedis({ members: { [key]: ["r1"] }, outcomes: { r1: "full" } }),
		fakeRedis({ failLookup: true }),
		fakeRedis({ members: { [key]: ["r1"] }, failHold: true }),
	];
	for (const redis of cases) {
		const { res, logs, calls } = await deliver("github", { redis });
		assert.equal(res.statusCode, 204);
		assert.deepEqual(logs.at(-1), { event: "dropped", delivery: "d-1", reason: "no-trigger-phrase" });
		assert.equal(calls.length, 0);
		assert.ok(logs.some((l) => l.event === "held_fell_through"));
		noBodyInLogs(logs);
	}
	for (const steerRedis of [() => null, () => { throw new Error("x"); }, async () => Promise.reject(new Error("y"))]) {
		const { res, logs } = await deliver("github", { steerRedis });
		assert.equal(res.statusCode, 204);
		assert.deepEqual(logs.at(-1), { event: "dropped", delivery: "d-1", reason: "no-trigger-phrase" });
	}
});

test("one of two runs holding is held; `dup` (a redelivery the run holds) counts as held", async () => {
	const key = awaitKeyOf("github");
	const { res, logs } = await deliver("github", { redis: fakeRedis({ members: { [key]: ["r1", "r2"] }, outcomes: { r1: "closed", r2: "dup" } }) });
	assert.deepEqual(JSON.parse(res.body), { status: "held", runs: 1 });
	assert.deepEqual(logs.filter((l) => l.event === "held").map((l) => l.runId), ["r2"]);
});

// ---------------------------------------------------------------------------------------------------------------
// The webhook arms, (a): a resume comment the window swallowed
// ---------------------------------------------------------------------------------------------------------------

for (const forge of Object.keys(FORGES)) {
	test(`${forge}: a resume comment deduplicated against a live awaitInput run is HELD under the surviving id (202 held)`, async () => {
		const { res, calls, logs, redis } = await deliver(forge, { body: `@pi ${MARK}`, survivor: "survivor-1", redis: fakeRedis() });
		assert.equal(calls.length, 1, "the enqueue ran and was swallowed");
		assert.equal(res.statusCode, 202);
		assert.deepEqual(JSON.parse(res.body), { status: "held", runs: 1 });
		assert.equal(redis.zcalls.length, 0, "the survivor IS the run: no target lookup");
		const h = redis.holds[0];
		assert.equal(h.runId, "survivor-1");
		assert.equal(h.entry.route, "dedup");
		assert.equal(h.entry.fallback.jobId, calls[0].opts.jobId, "the fallback is the job that was swallowed, under its own delivery id");
		assert.equal(h.entry.fallback.kind, forge);
		assert.ok(logs.some((l) => l.event === "deduplicated" && l.survivingJobId === "survivor-1"), "the swallow is still said");
		assert.deepEqual(logs.find((l) => l.event === "held"), { event: "held", delivery: "d-1", repo: calls[0].data.repo, target: FORGES[forge].logTarget, route: "dedup", runId: "survivor-1" });
		noBodyInLogs(logs);
	});
}

test("a swallowed comment the survivor refuses, or that is not a resume comment of an awaitInput trigger, answers deduplicated as before", async () => {
	const refusing = await deliver("github", { body: "@pi go", survivor: "s1", redis: fakeRedis({ outcomes: { s1: "gone" } }) });
	assert.deepEqual(JSON.parse(refusing.res.body), { status: "deduplicated" });
	for (const rule of [commentRule({ awaitInput: undefined }), commentRule({ resume: undefined })]) {
		const r = await deliver("github", { body: "@pi go", survivor: "s1", cfg: cfgWith(rule), redis: fakeRedis() });
		assert.deepEqual(JSON.parse(r.res.body), { status: "deduplicated" });
		assert.equal(r.redis.touched, 0, "never asks Valkey");
		assert.deepEqual(r.logs.map((l) => l.event), ["deduplicated"]);
	}
	const created = await deliver("github", { body: "@pi go", redis: fakeRedis() });
	assert.deepEqual(JSON.parse(created.res.body), { status: "queued" });
	assert.equal(created.redis.touched, 0, "a job that was created holds nothing");
});

test("wantsHoldAfterDedup and the two entry points never throw and need a comment match, resume and awaitInput", async () => {
	const job = { repo: "o/r", resume: true, awaitInput: true, target: { type: "issue", number: 7 }, trigger: { deliveryId: "d-9", matched: { type: "comment" } } };
	const outcome = { created: 0, deduplicated: [{ jobId: "gh-d-9", survivingJobId: "s" }] };
	assert.equal(wantsHoldAfterDedup(job, outcome), true);
	assert.equal(wantsHoldAfterDedup({ ...job, trigger: { ...job.trigger, matched: { type: "label" } } }, outcome), false, "a label re-add is coalesced as always");
	assert.equal(wantsHoldAfterDedup(job, { created: 1, deduplicated: [] }), false);
	assert.equal(wantsHoldAfterDedup(null, outcome), false);
	assert.equal(await holdAfterDedup({ redis: null, job, kind: "github", outcome, now: clock }), null);
	assert.equal(await holdAfterDedup({ redis: fakeRedis(), job: { ...job, trigger: { matched: { type: "comment" } } }, kind: "github", outcome, now: clock }), null, "no delivery id, no hold");
	assert.equal(await holdBeforeLabel({ redis: fakeRedis(), candidate: { ...job, parkedReply: undefined }, kind: "github", now: clock }), null);
	assert.equal(await holdBeforeLabel({ redis: { zrangebyscore: () => { throw new Error("sync"); } }, candidate: { ...job, parkedReply: true }, kind: "github", now: clock }), null);
});

// ---------------------------------------------------------------------------------------------------------------
// The poller, at its own seam
// ---------------------------------------------------------------------------------------------------------------

function pollerRedis(held) {
	const hashes = new Map();
	const kv = new Map();
	return Object.assign(held, {
		async get(k) {
			return kv.has(k) ? kv.get(k) : null;
		},
		async set(k, v) {
			kv.set(k, String(v));
			return "OK";
		},
		async hgetall(k) {
			return Object.fromEntries(hashes.get(k) ?? []);
		},
		async hget(k, f) {
			return hashes.get(k)?.get(String(f)) ?? null;
		},
		async hset(k, f, v) {
			if (!hashes.has(k)) hashes.set(k, new Map());
			hashes.get(k).set(String(f), String(v));
		},
		async expire() {},
		async incr() {
			return 1;
		},
		async quit() {},
	});
}

const ghResponse = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body });
const POLL_NOW = Date.parse("2026-08-02T12:00:00Z");

async function poll({ held, body, enqueueAnswer = null }) {
	const comment = { id: 350, user: { id: 5 }, author_association: "OWNER", body, created_at: "2026-08-02T12:00:30Z", updated_at: "2026-08-02T12:00:30Z", issue_url: "https://api.github.com/repos/o/r/issues/7" };
	const routes = [
		["/repos/o/r/issues/events", []],
		["/repos/o/r/issues/comments", [comment]],
		["/repos/o/r/pulls?state=open", []],
		["/repos/o/r/issues/7", { number: 7, title: "T", body: "B", labels: [] }],
	];
	const triggers = JSON.stringify({ triggers: [{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "triage", resume: true, awaitInput: true } }] });
	const queued = [];
	const out = [];
	const clockState = { ms: POLL_NOW };
	let remaining = 2;
	let poller;
	poller = await startPoller(
		{ POLL_REPOS: "o/r" },
		{
			judgeValkey: async () => {},
			fetchFn: async (url) => {
				for (const [path, reply] of routes) if (url.includes(path)) return ghResponse(200, reply);
				throw new Error(`unrouted ${url}`);
			},
			redis: pollerRedis(held),
			queueFn: async (job) => (queued.push(job), enqueueAnswer),
			out: (o) => out.push(o),
			now: () => clockState.ms,
			random: () => 0.5,
			selfIdFn: async () => 999001,
			tokenFn: async () => "t",
			fsDeps: { fileExists: () => true, readFile: () => triggers },
			sleep: async (ms) => {
				clockState.ms += ms;
				if (--remaining <= 0) poller.stop();
			},
		},
	);
	await poller.done;
	assert.deepEqual(out.filter((o) => o.event === "poll_repo_failed"), []);
	return { queued, out };
}

test("poller parity, (b): a phrase-free reply before the marker is held for a live await run, counted, never enqueued", async () => {
	const held = fakeRedis({ members: { [awaitKeyOf("github")]: ["r1"] } });
	const { queued, out } = await poll({ held, body: `${MARK} the answer` });
	assert.equal(queued.length, 0);
	assert.equal(held.holds[0].entry.route, "pre-label");
	assert.equal(held.holds[0].entry.fallback.parkedReply, true);
	assert.deepEqual(out.find((o) => o.event === "held"), { event: "held", delivery: "poll-c350", repo: "o/r", target: "issue#7", route: "pre-label", runId: "r1" });
	assert.equal(out.filter((o) => o.event === "poll_cycle").at(-1).held, 1);
	assert.equal(out.some((o) => o.event === "dropped"), false);
	for (const o of out) assert.ok(!JSON.stringify(o).includes(MARK));
	const none = await poll({ held: fakeRedis(), body: `${MARK} the answer` });
	assert.ok(none.out.some((o) => o.event === "dropped" && o.reason === "no-trigger-phrase"), "no live run: today's drop");
});

test("poller parity, review round 2: a phrase-free reply after the park's take is enqueued as a parked reply while the marker stands", async () => {
	const { queued, out } = await poll({ held: fakeRedis({ parked: [awaitKeyOf("github")] }), body: `${MARK} the answer` });
	assert.equal(queued.length, 1);
	assert.equal(queued[0].parkedReply, true);
	assert.ok(out.some((o) => o.event === "held_after_park"));
	assert.equal(out.some((o) => o.event === "dropped"), false);
});

test("poller parity, (a): a resume comment swallowed by a live awaitInput run is held under the survivor", async () => {
	const held = fakeRedis();
	const { queued, out } = await poll({ held, body: `@pi ${MARK}`, enqueueAnswer: { jobId: "gh-poll-c350", deduplicated: true, survivingJobId: "s1" } });
	assert.equal(queued.length, 1);
	assert.equal(held.holds[0].runId, "s1");
	assert.equal(held.holds[0].entry.route, "dedup");
	assert.ok(out.some((o) => o.event === "deduplicated"));
	assert.deepEqual(out.find((o) => o.event === "held"), { event: "held", delivery: "poll-c350", repo: "o/r", target: "issue#7", route: "dedup", runId: "s1" });
	assert.equal(out.filter((o) => o.event === "poll_cycle").at(-1).held, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// End to end against a real Valkey, with the worker's own registration and close
// ---------------------------------------------------------------------------------------------------------------

const valkeyUrl = process.env.VALKEY_TEST_URL;
if (!valkeyUrl && process.env.PI_DISPATCH_REQUIRE_RECEIVER_TESTS === "1") throw new Error("the receiver held test is REQUIRED here (PI_DISPATCH_REQUIRE_RECEIVER_TESTS=1) but VALKEY_TEST_URL is not set");
const live = valkeyUrl ? false : "VALKEY_TEST_URL not set; the held end-to-end test needs a real Valkey";

test("live Valkey: a run the worker registered holds the pre-label reply, a redelivery is dup, and a settled run falls through", { skip: live }, async () => {
	const { makeRedisClient } = await import("@edgehero/pi-dispatch/connection");
	// Database 0, the worker held-replies test's and the queue tests': never flushed by anyone, every key here under a run
	// id this test makes unique and carrying a TTL (every numbered database is flushed or must be empty for another file).
	const url = new URL(valkeyUrl);
	url.pathname = "/0";
	const redis = makeRedisClient(url.toString());
	redis.on("error", () => {});
	const runId = `gh-recv-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const repo = `o/${runId}`;
	const cfg = cfgWith();
	const raw = (delivery) => JSON.stringify({ action: "created", sender: { id: 5 }, repository: { full_name: repo }, issue: { number: 7, title: "T", body: "B", labels: [] }, comment: { body: "the answer", author_association: "OWNER" }, _d: delivery });
	const send = async (delivery) => {
		// The real clock on both sides: the worker's registration scores the run against it.
		const b = build({ redis, cfg, now: Date.now });
		const body = raw(delivery);
		return { ...b, res: await drive(b.handler, request("/", { "x-github-event": "issue_comment", "x-github-delivery": delivery, "x-hub-signature-256": sign(GH_SECRET, body) }), body) };
	};
	try {
		const targetKey = awaitTargetKeyOf({ kind: "github", repo, target: { type: "issue", number: 7 } });
		assert.deepEqual(await registerAwaitLive({ redis, runId, targetKey, host: "h1" }), { ok: true });
		const one = await send("live-d-1");
		assert.deepEqual(JSON.parse(one.res.body), { status: "held", runs: 1 });
		assert.deepEqual(JSON.parse((await send("live-d-1")).res.body), { status: "held", runs: 1 }, "a redelivery is dup: still held, still one entry");
		const closed = await closeHeld({ redis, runId, targetKey, parked: true });
		assert.equal(closed.entries.length, 1);
		assert.equal(await recentlyParked({ redis, targetKey }), true);
		assert.equal(closed.entries[0].fallback.parkedReply, true);
		assert.equal(closed.entries[0].fallback.jobId, "gh-live-d-1");
		const after = await send("live-d-2");
		assert.deepEqual(JSON.parse(after.res.body), { status: "queued" }, "a run that just parked: enqueued as a parked reply, not dropped");
		await redis.del(`run:await:parked:${targetKey.slice("run:await:target:".length)}`);
		const later = await send("live-d-3");
		assert.equal(later.res.statusCode, 204, "no live run and no park: today's drop");
	} finally {
		await redis.quit().catch(() => {});
	}
});
