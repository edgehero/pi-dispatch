import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { steerTargetOf } from "@edgehero/pi-dispatch/inbox-relay";
import { forgeMessageId, steerTargetKey } from "@edgehero/pi-dispatch/steer-inbox";
import { filter } from "../src/filter.mjs";
import { filterAzure } from "../src/filter-azure.mjs";
import { filterForgejo } from "../src/filter-forgejo.mjs";
import { filterGitLab } from "../src/filter-gitlab.mjs";
import { steerModeOf } from "../src/predicate.mjs";
import { parseSubset, makeReceiver } from "../src/receiver.mjs";
import { FORGE_GATE_ASSOCIATION, STEER_FANOUT_LIMIT, trySteer } from "../src/steer.mjs";
import { startPoller as startPollerReal } from "../src/poller.mjs";
import { parseGitLabSubset } from "../src/gitlab-subset.mjs";
import { parseForgejoSubset } from "../src/forgejo-subset.mjs";
import { parseAzureSubset } from "../src/azure-subset.mjs";

// Issue #646, part 2: a phrase comment from an admitted author on a steer-armed trigger is handed to the inbox of a run
// of that trigger already going on the same issue or pull request, instead of starting a second paid job. Every fake
// here is the ioredis surface steer-inbox.mjs calls (eval, zrangebyscore, multi); the one live test at the bottom runs
// the same path against a real Valkey with the worker's own registerLive.

const NOW = 1_800_000_000_000;
const clock = () => NOW;
// A body no log line may ever carry: the guard for no-pii-in-logs.
const MARK = "zq-steer-body-marker-7c1";
const GH_SECRET = "gh-secret";
const FJ_SECRET = "forgejo-secret";
const GL_TOKEN = "gl-token";
const AZ_BASIC = Buffer.from("hooks:s3cret", "utf8").toString("base64");
const PARKED = "pi-awaiting-input";

const commentRule = (extra = {}) => ({ index: 1, phrase: "@pi", defaultFlow: "triage", steer: true, resume: true, ...extra });
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

/** The steer-inbox calls, recorded; `members` is what the target ZSET holds, `outcomes` what each run's push answers. */
function fakeRedis({ members = [], outcomes = {}, failLookup = false, failPush = false, failStore = false, failMarker = false, marked = [] } = {}) {
	const r = {
		zcalls: [],
		pushes: [],
		fallbacks: [],
		order: [],
		// Every Valkey call of any kind, so a test can say a refusal touched nothing.
		touched: 0,
		// The plain keys: the steered-delivery markers, and the poller's cursors when it shares this fake.
		kv: new Map(marked.map((k) => [k, "1"])),
		sets: [],
		async get(k) {
			r.touched += 1;
			return r.kv.has(k) ? r.kv.get(k) : null;
		},
		async set(k, v, ...opts) {
			r.touched += 1;
			if (failMarker && k.startsWith("steer:steered:")) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
			r.sets.push([k, String(v), ...opts]);
			if (opts.includes("NX") && r.kv.has(k)) return null;
			r.kv.set(k, String(v));
			return "OK";
		},
		async exists(k) {
			r.touched += 1;
			if (failMarker) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
			return r.kv.has(k) ? 1 : 0;
		},
		async zrangebyscore(key, min, max, _limit, offset, count) {
			r.touched += 1;
			r.zcalls.push({ key, min, max, offset, count });
			if (failLookup) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
			return members.slice(0, count);
		},
		async eval(_script, nkeys, ...rest) {
			r.touched += 1;
			const keys = rest.slice(0, nkeys);
			const args = rest.slice(nkeys);
			// The fallback store (one script on the fallback hash) and the push (keyed by the open key) share `eval`.
			if (keys[0].startsWith("run:inbox:fallback:")) {
				if (failStore) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
				r.fallbacks.push({ key: keys[0], id: args[0], job: JSON.parse(args[1]) });
				r.order.push(`store:${keys[0].split(":").at(-1)}`);
				return "ok";
			}
			if (failPush) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
			const runId = keys[0].slice("run:steer:open:".length);
			r.pushes.push({ runId, id: args[0], entry: JSON.parse(args[1]) });
			r.order.push(`push:${runId}`);
			return outcomes[runId] ?? "ok";
		},
		multi() {
			r.touched += 1;
			const ops = [];
			const m = {
				hset: (k, f, v) => (ops.push(["hset", k, f, v]), m),
				pexpire: (k, t) => (ops.push(["pexpire", k, t]), m),
				async exec() {
					if (failStore) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
					for (const [op, k, f, v] of ops) if (op === "hset") (r.fallbacks.push({ key: k, id: f, job: JSON.parse(v) }), r.order.push(`store:${k.split(":").at(-1)}`));
					return ops.map(() => [null, 1]);
				},
			};
			return m;
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

/**
 * One row per forge: how its comment delivery is spelled, signed and addressed. `admitted` is the author gate's input:
 * the association on GitHub, the resolver's verdict elsewhere.
 */
const FORGES = {
	github: {
		raw: ({ body, admitted = true, labels = [], delivery }) => JSON.stringify({ action: "created", sender: { id: 5 }, repository: { full_name: "o/r" }, issue: { number: 7, title: "T", body: "B", labels: labels.map((name) => ({ name })) }, comment: { body, author_association: admitted ? "OWNER" : "NONE" }, _d: delivery }),
		req: (raw, delivery) => request("/", { "x-github-event": "issue_comment", "x-github-delivery": delivery, "x-hub-signature-256": sign(GH_SECRET, raw) }),
		target: { repo: "o/r", targetType: "issue", number: 7 },
	},
	gitlab: {
		raw: ({ body, labels = [] }) => JSON.stringify({ object_kind: "note", user: { id: 5, username: "dev" }, project: { id: 42, path_with_namespace: "g/p", default_branch: "main" }, object_attributes: { note: body, noteable_type: "Issue", action: "create" }, issue: { iid: 7, title: "T", description: "B", labels: labels.map((title) => ({ title })) } }),
		req: (_raw, delivery) => request("/gitlab", { "x-gitlab-event": "Note Hook", "webhook-id": delivery, "x-gitlab-token": GL_TOKEN }),
		target: { repo: "g/p", targetType: "issue", number: 7 },
	},
	forgejo: {
		raw: ({ body, labels = [] }) => JSON.stringify({ action: "created", sender: { id: 5, login: "dev" }, repository: { full_name: "acme/w" }, issue: { number: 7, title: "T", body: "B", labels: labels.map((name) => ({ name })) }, comment: { body }, is_pull: false }),
		req: (raw, delivery) => request("/forgejo", { "x-github-event": "issue_comment", "x-github-delivery": delivery, "x-hub-signature-256": sign(FJ_SECRET, raw) }),
		target: { repo: "acme/w", targetType: "issue", number: 7 },
	},
	azure: {
		raw: ({ body, labels = [], delivery }) => JSON.stringify({ id: delivery, eventType: "workitem.commented", resourceContainers: { project: { id: "proj-guid" } }, resource: { workItemId: 7, fields: { "System.ChangedBy": { newValue: "Dev <dev@example.com>" }, "System.History": { newValue: body } }, revision: { fields: { "System.Title": "T", "System.TeamProject": "Fabrikam", "System.Tags": labels.join("; ") } } } }),
		req: () => request("/azure", { authorization: `Basic ${AZ_BASIC}` }),
		target: { repo: "Fabrikam/widgets", targetType: "issue", number: 7 },
	},
};

function build({ redis = fakeRedis(), admitted = true, cfg = cfgWith(), steerRedis, now = clock } = {}) {
	const calls = [];
	const logs = [];
	const queue = { add: async (name, data, opts) => (calls.push({ name, data, opts }), { id: opts?.jobId }) };
	const resolveAuthority = async () => ({ authorized: admitted });
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

async function deliver(forge, { body = `@pi ${MARK}`, delivery = "d-1", labels, admitted = true, redis, cfg, steerRedis, now } = {}) {
	const b = build({ redis, admitted, cfg, steerRedis, now });
	const raw = FORGES[forge].raw({ body, admitted, labels, delivery });
	const res = await drive(b.handler, FORGES[forge].req(raw, delivery), raw);
	return { ...b, res };
}

const noBodyInLogs = (logs) => {
	for (const line of logs) assert.ok(!JSON.stringify(line).includes(MARK), `a log line carries the comment body: ${JSON.stringify(line)}`);
};

// ---------------------------------------------------------------------------------------------------------------
// The `later` grammar (pure)
// ---------------------------------------------------------------------------------------------------------------

test("the later grammar: lowercase whole word, right after the FIRST phrase, spaces or tabs between", () => {
	const rows = [
		["@pi later also bump the docs", "followUp"],
		["@pi later", "followUp"],
		["@pi\tlater\nthen the docs", "followUp"],
		["@pi   later.", "steer"],
		["@pi Later also", "steer"],
		["@pi LATER", "steer"],
		["@pi laterx", "steer"],
		["@pi later-on", "steer"],
		["@pilater", "steer"],
		["@pi\nlater", "steer"],
		["@pi \nlater", "steer"],
		["@pi fix the date. @pi later", "steer"],
		["@pi later and @pi now", "followUp"],
		["first line\n@pi later", "followUp"],
		["@pi please do it later", "steer"],
	];
	for (const [body, mode] of rows) assert.equal(steerModeOf(body, "@pi"), mode, JSON.stringify(body));
	assert.equal(steerModeOf("no phrase", "@pi"), "steer");
	assert.equal(steerModeOf(undefined, "@pi"), "steer");
});

// ---------------------------------------------------------------------------------------------------------------
// The filters: steerMode only on the steer path, never inside `trigger`, never for a stranger
// ---------------------------------------------------------------------------------------------------------------

/** Each forge's pure gate over a comment, with the author gate's input. */
const GATES = {
	github: ({ body, admitted = true, labels, cfg = cfgWith() }) => filter("issue_comment", parseSubset(JSON.parse(FORGES.github.raw({ body, admitted, labels }))), cfg, 999, "d-1"),
	gitlab: ({ body, admitted = true, labels, cfg = cfgWith() }) => filterGitLab(parseGitLabSubset(JSON.parse(FORGES.gitlab.raw({ body, labels }))), cfg.triggers.gitlab, cfg.triggers.knownFlows, 999, admitted, "d-1"),
	forgejo: ({ body, admitted = true, labels, cfg = cfgWith() }) => filterForgejo("issue_comment", parseForgejoSubset(JSON.parse(FORGES.forgejo.raw({ body, labels }))), cfg.triggers.forgejo, cfg.triggers.knownFlows, 999, admitted, "d-1"),
	azure: ({ body, admitted = true, labels, cfg = cfgWith() }) => filterAzure(parseAzureSubset(JSON.parse(FORGES.azure.raw({ body, labels, delivery: "d-1" }))), cfg.triggers.azure, cfg.triggers.knownFlows, { id: "self-guid", email: "bot@example.com" }, admitted, "d-1"),
};

for (const forge of Object.keys(GATES)) {
	test(`${forge}: a phrase comment on a steer-armed trigger carries steerMode at job level, and later picks followUp`, () => {
		const r = GATES[forge]({ body: "@pi stop refactoring" });
		assert.equal(r.enqueue, true);
		assert.equal(r.job.steerMode, "steer");
		assert.equal(r.job.steer, true);
		assert.equal("steerMode" in r.job.trigger, false, "never inside trigger, which is copied into /job/event.json");
		assert.equal(GATES[forge]({ body: "@pi later open the PR" }).job.steerMode, "followUp");
	});

	test(`${forge}: a comment from someone the author gate refuses never gets steerMode`, () => {
		const r = GATES[forge]({ body: "@pi later do it", admitted: false });
		assert.deepEqual(r, { enqueue: false, reason: "author-not-allowed" });
	});

	test(`${forge}: phrase-free, parked-reply and command paths are byte-identical to an unarmed trigger's`, () => {
		const unarmed = cfgWith(commentRule({ steer: undefined }));
		// Phrase-free: dropped either way, the same reason.
		assert.deepEqual(GATES[forge]({ body: "just a remark" }), GATES[forge]({ body: "just a remark", cfg: unarmed }));
		// A parked reply: the same job but for the trigger's own `steer: true`, and no steerMode.
		const parked = GATES[forge]({ body: "the answer is 42", labels: [PARKED] });
		assert.equal(parked.enqueue, true);
		assert.equal(parked.job.parkedReply, true);
		assert.equal("steerMode" in parked.job, false);
		const parkedUnarmed = GATES[forge]({ body: "the answer is 42", labels: [PARKED], cfg: unarmed });
		assert.equal(JSON.stringify({ ...parked.job, steer: undefined }), JSON.stringify({ ...parkedUnarmed.job, steer: undefined }));
		// A phrase comment on an unarmed trigger: no steer, no steerMode, the job it always was.
		const plain = GATES[forge]({ body: "@pi go", cfg: unarmed });
		assert.equal("steer" in plain.job, false);
		assert.equal("steerMode" in plain.job, false);
		// A command rule (the loader refuses steer beside command; a drifted file still cannot steer).
		const cmd = GATES[forge]({ body: "@pi go", cfg: cfgWith(commentRule({ command: "wf run", defaultFlow: undefined })) });
		assert.equal(cmd.enqueue, true);
		assert.equal("steerMode" in cmd.job, false);
	});
}

// ---------------------------------------------------------------------------------------------------------------
// trySteer
// ---------------------------------------------------------------------------------------------------------------

const ghJob = (extra = {}) => ({ ...GATES.github({ body: `@pi ${MARK}` }).job, ...extra });

test("trySteer: the target key is the worker relay's own, the lookup is bounded, and the entry is the contract's", async () => {
	const redis = fakeRedis({ members: ["gh-run1"] });
	const logs = [];
	const r = await trySteer({ redis, job: ghJob(), kind: "github", now: clock, log: (l) => logs.push(l) });
	assert.deepEqual(r, { steered: 1, runIds: ["gh-run1"] });
	const relayKey = steerTargetOf({ ...ghJob(), kind: "github" }).targetKey;
	assert.equal(relayKey, steerTargetKey({ kind: "github", ...FORGES.github.target }));
	assert.deepEqual(redis.zcalls, [{ key: relayKey, min: `(${NOW}`, max: "+inf", offset: 0, count: STEER_FANOUT_LIMIT }]);
	assert.equal(redis.pushes.length, 1);
	assert.deepEqual(redis.pushes[0].entry, { v: 1, id: forgeMessageId("d-1"), mode: "steer", source: "forge", author: { kind: "forge", id: 5, association: "OWNER" }, text: `@pi ${MARK}`, at: NOW, deliveryId: "d-1" });
	assert.equal(redis.fallbacks.length, 1);
	const fb = redis.fallbacks[0];
	assert.equal(fb.key, "run:inbox:fallback:gh-run1");
	assert.equal(fb.id, forgeMessageId("d-1"));
	assert.equal(fb.job.kind, "github");
	assert.equal(fb.job.jobId, "gh-d-1", "the fallback carries its delivery-GUID job id, so two runs' fallbacks make one job");
	assert.equal("steerMode" in fb.job, false);
	assert.equal(fb.job.trigger.deliveryId, "d-1");
	noBodyInLogs(logs);
});

test("trySteer: zero members, every run gone, closed or full, and a Valkey fault all return null with a reason", async () => {
	const cases = [
		[{ members: [] }, "steer_fell_through", "no-live-run"],
		[{ members: ["a"], outcomes: { a: "gone" } }, "steer_fell_through", "gone"],
		[{ members: ["a"], outcomes: { a: "closed" } }, "steer_fell_through", "closed"],
		[{ members: ["a", "b"], outcomes: { a: "full", b: "closed" } }, "steer_fell_through", "mixed"],
		[{ failLookup: true }, "steer_lookup_failed", "ECONNREFUSED"],
		[{ members: ["a"], failPush: true }, "steer_lookup_failed", "ECONNRESET"],
		[{ members: ["a"], failStore: true }, "steer_lookup_failed", "ECONNRESET"],
	];
	for (const [opts, event, reason] of cases) {
		const logs = [];
		const r = await trySteer({ redis: fakeRedis(opts), job: ghJob(), kind: "github", now: clock, log: (l) => logs.push(l) });
		assert.equal(r, null, JSON.stringify(opts));
		const line = logs.find((l) => l.event === event);
		assert.ok(line, `${JSON.stringify(opts)}: ${JSON.stringify(logs)}`);
		assert.equal(line.reason, reason);
		assert.equal(line.delivery, "d-1");
		noBodyInLogs(logs);
	}
	// A failed fallback store skips that run's push: a message accepted with nothing to start could go late silently.
	const noStore = fakeRedis({ members: ["a"], failStore: true });
	await trySteer({ redis: noStore, job: ghJob(), kind: "github", now: clock });
	assert.equal(noStore.pushes.length, 0);
});

const withBody = (body) => ghJob({ trigger: { ...ghJob().trigger, comment: { body, author_association: "OWNER" } } });

test("trySteer: an unsendable body is refused before Valkey as steer_comment_skipped, with its reason", async () => {
	for (const [body, reason] of [[`@pi ${MARK}${"x".repeat(9000)}`, "too-large"], [" \t\n  ", "empty"], ["@pi \ud800 fix", "malformed"]]) {
		const redis = fakeRedis({ members: ["a"] });
		const logs = [];
		assert.equal(await trySteer({ redis, job: withBody(body), kind: "github", now: clock, log: (l) => logs.push(l) }), null);
		assert.deepEqual(logs, [{ event: "steer_comment_skipped", delivery: "d-1", kind: "github", reason }], reason);
		assert.equal(redis.touched, 0, `${reason}: no Valkey call`);
	}
});

test("trySteer: no delivery id, a refusable entry and a job with no target fall through with their reason and touch no Valkey", async () => {
	const base = ghJob();
	const cases = [
		[{ ...base, trigger: { ...base.trigger, deliveryId: undefined } }, "no-delivery-id"],
		[{ ...base, trigger: { ...base.trigger, sender: { id: -3 } } }, "entry-refused"],
		[{ ...base, trigger: { ...base.trigger, comment: { ...base.trigger.comment, author_association: "lower case" } } }, "entry-refused"],
		[{ ...base, target: { type: "issue", number: undefined } }, "no-target"],
		[{ ...base, repo: undefined }, "no-target"],
	];
	for (const [job, reason] of cases) {
		const redis = fakeRedis({ members: ["a"] });
		const logs = [];
		assert.equal(await trySteer({ redis, job, kind: "github", now: clock, log: (l) => logs.push(l) }), null, reason);
		assert.equal(logs.length, 1, reason);
		assert.equal(logs[0].event, "steer_fell_through");
		assert.equal(logs[0].reason, reason);
		assert.equal(redis.touched, 0, `${reason}: liveRunsForTarget and every other Valkey method stay uncalled`);
	}
});

test("trySteer: a job with no or a bogus steerMode logs nothing and calls no Valkey method", async () => {
	for (const steerMode of [undefined, null, "", "Steer", "followup", "later", 1, true]) {
		const redis = fakeRedis({ members: ["a"] });
		const logs = [];
		assert.equal(await trySteer({ redis, job: ghJob({ steerMode }), kind: "github", now: clock, log: (l) => logs.push(l) }), null, String(steerMode));
		assert.deepEqual(logs, [], String(steerMode));
		assert.equal(redis.touched, 0, String(steerMode));
	}
});

test("trySteer: the fanout is exactly four, whatever the target holds", async () => {
	const redis = fakeRedis({ members: ["r1", "r2", "r3", "r4", "r5"] });
	assert.deepEqual(await trySteer({ redis, job: ghJob(), kind: "github", now: clock }), { steered: 4, runIds: ["r1", "r2", "r3", "r4"] });
	assert.equal(STEER_FANOUT_LIMIT, 4);
	assert.equal(redis.zcalls[0].count, 4);
	assert.equal(redis.pushes.length, 4);
});

test("trySteer: one run erroring and one gone is a mixed fall-through, not a lookup failure", async () => {
	const redis = fakeRedis({ members: ["a", "b"], outcomes: { b: "gone" } });
	// Run "a" errors at its push; "b" answers gone.
	const realEval = redis.eval;
	redis.eval = async (script, n, ...rest) => {
		if (rest[0] === "run:steer:open:a") throw Object.assign(new Error("down"), { code: "ECONNRESET" });
		return realEval(script, n, ...rest);
	};
	const logs = [];
	assert.equal(await trySteer({ redis, job: ghJob(), kind: "github", now: clock, log: (l) => logs.push(l) }), null);
	assert.equal(logs.some((l) => l.event === "steer_lookup_failed"), false);
	const line = logs.find((l) => l.event === "steer_fell_through");
	assert.equal(line.reason, "mixed");
	assert.deepEqual(line.outcomes, { error: 1, gone: 1 });
});

test("trySteer: a steer leaves the delivery's marker, NX with the 31-day retention", async () => {
	const redis = fakeRedis({ members: ["r1"] });
	await trySteer({ redis, job: ghJob(), kind: "github", now: clock });
	assert.deepEqual(redis.sets, [["steer:steered:gh-d-1", "1", "EX", 31 * 24 * 3600, "NX"]]);
	// Nothing steered, no marker.
	const none = fakeRedis({ members: ["r1"], outcomes: { r1: "closed" } });
	await trySteer({ redis: none, job: ghJob(), kind: "github", now: clock });
	assert.deepEqual(none.sets, []);
	// A marker write that fails is logged, and the comment is still steered.
	const logs = [];
	const failing = fakeRedis({ members: ["r1"], failMarker: true });
	assert.deepEqual(await trySteer({ redis: failing, job: ghJob(), kind: "github", now: clock, log: (l) => logs.push(l) }), { steered: 1, runIds: ["r1"] });
	assert.deepEqual(logs, [{ event: "steer_marker_failed", delivery: "d-1", kind: "github", op: "write", reason: "ECONNRESET" }]);
});

test("trySteer: a delivery steered before, whose run has ended, is redelivered: answered, never a fall-through", async () => {
	for (const opts of [{ members: [] }, { members: ["r1"], outcomes: { r1: "closed" } }, { members: ["r1", "r2"], outcomes: { r1: "gone", r2: "full" } }]) {
		const logs = [];
		const redis = fakeRedis({ ...opts, marked: ["steer:steered:gh-d-1"] });
		assert.deepEqual(await trySteer({ redis, job: ghJob(), kind: "github", now: clock, log: (l) => logs.push(l) }), { steered: 0, runIds: [], redelivered: true });
		assert.equal(logs.at(-1).event, "steer_redelivered");
		assert.equal(logs.some((l) => l.event === "steer_fell_through"), false);
	}
	// Another delivery's marker does not shield this one, and an unreadable marker falls through (to the GUID-keyed enqueue).
	assert.equal(await trySteer({ redis: fakeRedis({ marked: ["steer:steered:gh-other"] }), job: ghJob(), kind: "github", now: clock }), null);
	const logs = [];
	assert.equal(await trySteer({ redis: fakeRedis({ failMarker: true }), job: ghJob(), kind: "github", now: clock, log: (l) => logs.push(l) }), null);
	assert.deepEqual(logs.map((l) => l.event), ["steer_marker_failed", "steer_fell_through"]);
});

test("trySteer: a job without steerMode is not a steer and touches nothing; a missing client falls through loudly", async () => {
	const redis = fakeRedis({ members: ["a"] });
	const { steerMode: _m, ...plain } = ghJob();
	assert.equal(await trySteer({ redis, job: plain, kind: "github", now: clock }), null);
	assert.equal(redis.zcalls.length, 0);
	const logs = [];
	assert.equal(await trySteer({ redis: null, job: ghJob(), kind: "github", now: clock, log: (l) => logs.push(l) }), null);
	assert.deepEqual(logs, [{ event: "steer_lookup_failed", delivery: "d-1", kind: "github", reason: "no-client" }]);
});

test("trySteer: a non-GitHub author is framed by the gate's verdict, and the forge's own target key", async () => {
	for (const forge of ["gitlab", "forgejo"]) {
		const redis = fakeRedis({ members: ["r1"] });
		const job = GATES[forge]({ body: "@pi go" }).job;
		assert.deepEqual(await trySteer({ redis, job, kind: forge, now: clock }), { steered: 1, runIds: ["r1"] });
		assert.deepEqual(redis.pushes[0].entry.author, { kind: "forge", id: 5, association: FORGE_GATE_ASSOCIATION });
		assert.equal(redis.zcalls[0].key, steerTargetKey({ kind: forge, ...FORGES[forge].target }));
	}
});

// ---------------------------------------------------------------------------------------------------------------
// The receiver arms
// ---------------------------------------------------------------------------------------------------------------

for (const forge of ["github", "gitlab", "forgejo"]) {
	test(`${forge}: a phrase comment with a live run answers 202 steered and enqueues NOTHING`, async () => {
		const { res, calls, logs, redis } = await deliver(forge, { redis: fakeRedis({ members: ["run-a"] }) });
		assert.equal(res.statusCode, 202);
		assert.deepEqual(JSON.parse(res.body), { status: "steered", runs: 1 });
		assert.equal(calls.length, 0, "no second paid job");
		assert.equal(redis.pushes.length, 1);
		const line = logs.find((l) => l.event === "steered");
		assert.equal(line.delivery, "d-1");
		assert.equal(line.mode, "steer");
		assert.equal(line.runs, 1);
		assert.deepEqual(line.runIds, ["run-a"]);
		noBodyInLogs(logs);
	});

	test(`${forge}: a stranger's phrase comment is dropped and never reaches an inbox`, async () => {
		const { res, calls, redis } = await deliver(forge, { admitted: false, redis: fakeRedis({ members: ["run-a"] }) });
		assert.equal(res.statusCode, 204);
		assert.equal(calls.length, 0);
		assert.equal(redis.zcalls.length + redis.pushes.length, 0);
	});

	test(`${forge}: no live run, a closed run or a Valkey fault falls through to today's enqueue, without steerMode`, async () => {
		for (const redis of [fakeRedis(), fakeRedis({ members: ["a"], outcomes: { a: "closed" } }), fakeRedis({ failLookup: true })]) {
			const { res, calls, logs } = await deliver(forge, { redis });
			assert.equal(res.statusCode, 202);
			assert.deepEqual(JSON.parse(res.body), { status: "queued" });
			assert.equal(calls.length, 1);
			assert.equal("steerMode" in calls[0].data, false);
			assert.equal(calls[0].data.steer, true);
			assert.ok(logs.some((l) => l.event === "enqueued"));
			noBodyInLogs(logs);
		}
	});
}

test("github: replicas of a run all take the comment, and a later comment arrives as a follow-up", async () => {
	const { res, calls, redis, logs } = await deliver("github", { body: `@pi later ${MARK}`, redis: fakeRedis({ members: ["r1", "r2", "r3"] }) });
	assert.deepEqual(JSON.parse(res.body), { status: "steered", runs: 3 });
	assert.equal(calls.length, 0);
	assert.deepEqual(redis.pushes.map((p) => p.runId), ["r1", "r2", "r3"]);
	assert.ok(redis.pushes.every((p) => p.entry.mode === "followUp" && p.entry.text === `@pi later ${MARK}`), "the whole body, verbatim, with the grammar word kept");
	assert.deepEqual(redis.fallbacks.map((f) => f.key), ["run:inbox:fallback:r1", "run:inbox:fallback:r2", "run:inbox:fallback:r3"]);
	assert.equal(logs.find((l) => l.event === "steered").mode, "followUp");
});

test("each run's fallback is stored BEFORE its push, so a close between the two cannot strand a late message", async () => {
	const redis = fakeRedis({ members: ["r1", "r2"] });
	await trySteer({ redis, job: ghJob(), kind: "github", now: clock });
	assert.deepEqual(redis.order, ["store:r1", "push:r1", "store:r2", "push:r2"]);
});

test("github: one run of two refusing still steers, and the half-miss is logged", async () => {
	const { res, calls, logs } = await deliver("github", { redis: fakeRedis({ members: ["r1", "r2"], outcomes: { r2: "full" } }) });
	assert.deepEqual(JSON.parse(res.body), { status: "steered", runs: 1 });
	assert.equal(calls.length, 0);
	assert.deepEqual(logs.find((l) => l.event === "steer_partial"), { event: "steer_partial", delivery: "d-1", kind: "github", runs: 2, steered: 1, outcomes: { ok: 1, full: 1 } });
});

test("github: a redelivered GUID the run already holds is `dup`, still steered, and still not enqueued", async () => {
	const { res, calls } = await deliver("github", { redis: fakeRedis({ members: ["r1"], outcomes: { r1: "dup" } }) });
	assert.deepEqual(JSON.parse(res.body), { status: "steered", runs: 1 });
	assert.equal(calls.length, 0);
});

test("github: phrase-free and parked-reply deliveries never ask Valkey and enqueue exactly what an unarmed trigger would", async () => {
	for (const [body, labels] of [["@pi go", []], ["the answer is 42", [PARKED]]]) {
		const armed = await deliver("github", { body, labels, redis: fakeRedis({ members: ["r1"] }), cfg: cfgWith(commentRule({ steer: undefined })) });
		const steerArmed = await deliver("github", { body, labels, redis: fakeRedis({ members: ["r1"] }) });
		if (body === "@pi go") {
			// The armed trigger's phrase comment DOES steer; the unarmed one enqueues: the arm is the only difference.
			assert.equal(armed.calls.length, 1);
			assert.equal(steerArmed.calls.length, 0);
			continue;
		}
		assert.equal(steerArmed.redis.zcalls.length, 0, "a parked reply is an answer, never a steer");
		assert.equal(steerArmed.calls.length, 1);
		assert.equal(JSON.stringify({ ...steerArmed.calls[0].data, steer: undefined }), JSON.stringify({ ...armed.calls[0].data, steer: undefined }));
		assert.deepEqual(steerArmed.calls[0].opts, armed.calls[0].opts);
	}
});

test("github: the default steer client is the shared queue's own connection", async () => {
	const redis = fakeRedis({ members: ["r1"] });
	const calls = [];
	const queue = { client: Promise.resolve(redis), add: async (name, data, opts) => (calls.push(data), { id: opts?.jobId }) };
	const handler = makeReceiver({ queue, selfId: 999, cfg: cfgWith(), log: () => {}, now: clock });
	const raw = FORGES.github.raw({ body: "@pi go", delivery: "d-1" });
	const res = await drive(handler, FORGES.github.req(raw, "d-1"), raw);
	assert.deepEqual(JSON.parse(res.body), { status: "steered", runs: 1 });
	assert.equal(calls.length, 0);
});

test("azure: the sender is an address digest (`azid-` and 16 hex) the inbox accepts as a forge author, so the comment steers", async () => {
	const { res, calls, logs, redis } = await deliver("azure", { redis: fakeRedis({ members: ["run-a"] }) });
	assert.equal(res.statusCode, 202);
	assert.deepEqual(JSON.parse(res.body), { status: "steered", runs: 1 });
	assert.equal(calls.length, 0, "steered, not enqueued");
	assert.ok(redis.zcalls.length > 0, "the live runs were read");
	noBodyInLogs(logs);
});

test("every arm: a redelivered GUID steered before, whose run has ended, answers steered with no runs and enqueues NOTHING", async () => {
	for (const forge of ["github", "gitlab", "forgejo", "azure"]) {
		const jobId = { github: "gh-d-1", gitlab: "gl-d-1", forgejo: "fj-d-1", azure: "az-d-1" }[forge];
		const { res, calls, logs } = await deliver(forge, { redis: fakeRedis({ members: [], marked: [`steer:steered:${jobId}`] }) });
		assert.equal(res.statusCode, 202, forge);
		assert.deepEqual(JSON.parse(res.body), { status: "steered", runs: 0 }, forge);
		assert.equal(calls.length, 0, `${forge}: REQ-DEDUP-BY-DELIVERY-GUID holds for a steered comment too`);
		assert.deepEqual(logs.find((l) => l.event === "steer_redelivered"), { event: "steer_redelivered", delivery: "d-1", kind: forge, reason: "no-live-run" });
		assert.equal(logs.some((l) => l.event === "steered" || l.event === "enqueued"), false);
	}
});

test("github: on a fall-through the job the router and the enqueue see carries no steerMode", async () => {
	const routed = [];
	const calls = [];
	const queue = { add: async (name, data, opts) => (calls.push(data), { id: opts?.jobId }) };
	const router = { queueFor: async (kind, job) => (routed.push(job), queue) };
	const handler = makeReceiver({ queue, router, selfId: 999, cfg: cfgWith(), log: () => {}, steerRedis: () => fakeRedis(), now: clock });
	const raw = FORGES.github.raw({ body: "@pi go", delivery: "d-1" });
	await drive(handler, FORGES.github.req(raw, "d-1"), raw);
	assert.equal(routed.length, 1);
	assert.equal("steerMode" in routed[0], false);
	assert.equal(calls.length, 1);
	assert.equal("steerMode" in calls[0], false);
});

test("a steer client that throws or rejects: the comment is still enqueued, and the missing client is logged", async () => {
	for (const steerRedis of [() => { throw new Error("boom"); }, () => Promise.reject(new Error("boom")), () => undefined]) {
		const { res, calls, logs } = await deliver("github", { steerRedis });
		assert.deepEqual(JSON.parse(res.body), { status: "queued" });
		assert.equal(calls.length, 1);
		assert.deepEqual(logs.find((l) => l.event === "steer_lookup_failed"), { event: "steer_lookup_failed", delivery: "d-1", kind: "github", reason: "no-client" });
	}
});

test("forgejo: the arm looks up the forgejo target key and stores a forgejo fallback", async () => {
	const { redis } = await deliver("forgejo", { redis: fakeRedis({ members: ["r1"] }) });
	assert.equal(redis.zcalls[0].key, steerTargetKey({ kind: "forgejo", ...FORGES.forgejo.target }));
	assert.notEqual(redis.zcalls[0].key, steerTargetKey({ kind: "github", ...FORGES.forgejo.target }));
	assert.equal(redis.fallbacks[0].job.kind, "forgejo");
	assert.equal(redis.fallbacks[0].job.jobId, "fj-d-1");
	assert.deepEqual(redis.sets[0].slice(0, 1), ["steer:steered:fj-d-1"]);
});

test("azure: a stranger's comment is dropped and never reaches an inbox", async () => {
	const { res, calls, redis } = await deliver("azure", { admitted: false, redis: fakeRedis({ members: ["run-a"] }) });
	assert.equal(res.statusCode, 204);
	assert.equal(calls.length + redis.zcalls.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// The poller
// ---------------------------------------------------------------------------------------------------------------

/** The poller's cursor store plus the steer calls. */
function pollerRedis(steer) {
	const hashes = new Map();
	return Object.assign(steer, {
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

async function poll({ steer, body = `@pi ${MARK}` }) {
	const comment = { id: 350, user: { id: 5 }, author_association: "OWNER", body, created_at: "2026-08-02T12:00:30Z", updated_at: "2026-08-02T12:00:30Z", issue_url: "https://api.github.com/repos/o/r/issues/7" };
	const routes = [
		["/repos/o/r/issues/events", []],
		["/repos/o/r/issues/comments", [comment]],
		["/repos/o/r/pulls?state=open", []],
		["/repos/o/r/issues/7", { number: 7, title: "T", body: "B", labels: [] }],
	];
	const triggers = JSON.stringify({ triggers: [{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "triage", steer: true } }] });
	const queued = [];
	const out = [];
	const clockState = { ms: POLL_NOW };
	let remaining = 2;
	let poller;
	poller = await startPollerReal(
		{ POLL_REPOS: "o/r" },
		{
			judgeValkey: async () => {},
			fetchFn: async (url) => {
				for (const [path, reply] of routes) if (url.includes(path)) return ghResponse(200, reply);
				throw new Error(`unrouted ${url}`);
			},
			redis: pollerRedis(steer),
			queueFn: async (job) => void queued.push(job),
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

test("poller parity: the same comment steers a live run exactly as the webhook does, and counts it", async () => {
	const steer = fakeRedis({ members: ["r1"] });
	const { queued, out } = await poll({ steer });
	assert.equal(queued.length, 0);
	const line = out.find((o) => o.event === "steered");
	assert.deepEqual(line, { event: "steered", delivery: "poll-c350", repo: "o/r", target: "issue#7", mode: "steer", runs: 1, runIds: ["r1"] });
	assert.equal(out.filter((o) => o.event === "poll_cycle").at(-1).steered, 1);
	assert.equal(out.filter((o) => o.event === "poll_cycle")[0].steered, undefined, "a cycle that steered nothing keeps its old line");
	for (const o of out) assert.ok(!JSON.stringify(o).includes(MARK));

	// The webhook twin, under the rule the poller's file loads (index 0, no resume), pushes the same entry but for the
	// delivery's own id and GUID.
	const hook = await deliver("github", { redis: fakeRedis({ members: ["r1"] }), cfg: cfgWith(commentRule({ index: 0, resume: undefined })) });
	const strip = (e) => ({ ...e, id: "x", deliveryId: "x", at: 0 });
	assert.deepEqual(strip(steer.pushes[0].entry), strip(hook.redis.pushes[0].entry));
	const stripJob = (j) => ({ ...j, jobId: "x", trigger: { ...j.trigger, deliveryId: "x" } });
	assert.deepEqual(stripJob(steer.fallbacks[0].job), stripJob(hook.redis.fallbacks[0].job));
});

test("poller: a retried cycle's comment steered before is never enqueued, and not counted again", async () => {
	const { queued, out } = await poll({ steer: fakeRedis({ marked: ["steer:steered:gh-poll-c350"] }) });
	assert.equal(queued.length, 0);
	assert.ok(out.some((o) => o.event === "steer_redelivered" && o.delivery === "poll-c350"));
	assert.equal(out.some((o) => o.event === "steered"), false);
	assert.equal(out.filter((o) => o.event === "poll_cycle").at(-1).steered, undefined);
});

test("poller: with no live run the comment is enqueued as before, without steerMode", async () => {
	const { queued, out } = await poll({ steer: fakeRedis() });
	assert.equal(queued.length, 1);
	assert.equal("steerMode" in queued[0], false);
	assert.equal(queued[0].steer, true);
	assert.ok(out.some((o) => o.event === "steer_fell_through" && o.reason === "no-live-run"));
});

// ---------------------------------------------------------------------------------------------------------------
// End to end against a real Valkey, with the worker's own registration
// ---------------------------------------------------------------------------------------------------------------

const valkeyUrl = process.env.VALKEY_TEST_URL;
if (!valkeyUrl && process.env.PI_DISPATCH_REQUIRE_RECEIVER_TESTS === "1") throw new Error("the receiver steer test is REQUIRED here (PI_DISPATCH_REQUIRE_RECEIVER_TESTS=1) but VALKEY_TEST_URL is not set");
const live = valkeyUrl ? false : "VALKEY_TEST_URL not set; the steer end-to-end test needs a real Valkey";

test("live Valkey: a run the worker registered takes the comment, a redelivery is dup, and a closed run falls through", { skip: live }, async () => {
	const { makeRedisClient } = await import("@edgehero/pi-dispatch/connection");
	const { closeInbox, readFallbacks, readInbox, registerLive } = await import("@edgehero/pi-dispatch/steer-inbox");
	// Database 3: no other test file in the repository selects it.
	const url = new URL(valkeyUrl);
	url.pathname = "/3";
	const redis = makeRedisClient(url.toString());
	redis.on("error", () => {});
	try {
		await redis.flushdb();
		const now = Date.now();
		const runId = "gh-live-run";
		const runJob = { kind: "github", repo: "o/r", target: { type: "issue", number: 7 } };
		const { targetKey } = steerTargetOf(runJob);
		assert.deepEqual(await registerLive({ redis, runId, targetKey, host: "h1", now }), { ok: true });

		// One injected clock for both sides: the member is scored `now + 30 s`, and the receiver reads it at `now`.
		const at = () => now;
		const first = await deliver("github", { delivery: "live-d1", steerRedis: () => redis, body: `@pi later ${MARK}`, now: at });
		assert.deepEqual(JSON.parse(first.res.body), { status: "steered", runs: 1 });
		assert.equal(first.calls.length, 0);
		const inbox = await readInbox({ redis, runId });
		assert.equal(inbox.entries.length, 1);
		assert.equal(inbox.entries[0].id, forgeMessageId("live-d1"));
		assert.equal(inbox.entries[0].mode, "followUp");
		assert.equal(inbox.state[forgeMessageId("live-d1")], "queued");
		const { jobs } = await readFallbacks({ redis, runId });
		assert.equal(jobs[forgeMessageId("live-d1")].jobId, "gh-live-d1");
		assert.equal(jobs[forgeMessageId("live-d1")].kind, "github");

		const again = await deliver("github", { delivery: "live-d1", steerRedis: () => redis, body: `@pi later ${MARK}`, now: at });
		assert.deepEqual(JSON.parse(again.res.body), { status: "steered", runs: 1 }, "dup: the run already holds this GUID's message");
		assert.equal(again.calls.length, 0);
		assert.equal((await readInbox({ redis, runId })).entries.length, 1);

		const closed = await closeInbox({ redis, runId, targetKey });
		assert.equal(closed.state[forgeMessageId("live-d1")], "late");
		// The run has ended: a redelivery of the steered GUID is answered by its marker, never enqueued.
		const late = await deliver("github", { delivery: "live-d1", steerRedis: () => redis, body: `@pi later ${MARK}`, now: at });
		assert.deepEqual(JSON.parse(late.res.body), { status: "steered", runs: 0 });
		assert.equal(late.calls.length, 0);
		assert.ok(Number(await redis.ttl("steer:steered:gh-live-d1")) > 30 * 24 * 3600);
		const after = await deliver("github", { delivery: "live-d2", steerRedis: () => redis, now: at });
		assert.deepEqual(JSON.parse(after.res.body), { status: "queued" });
		assert.equal(after.calls.length, 1);
		assert.ok(after.logs.some((l) => l.event === "steer_fell_through" && l.reason === "no-live-run"));
		noBodyInLogs([...first.logs, ...again.logs, ...after.logs]);
	} finally {
		await redis.flushdb().catch(() => {});
		await redis.quit().catch(() => {});
	}
});
