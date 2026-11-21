import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { filter } from "../src/filter.mjs";
import { parseSubset } from "../src/receiver.mjs";
import { loadReceiverConfig } from "../src/config.mjs";
import { loadPollerConfig } from "../src/poller-config.mjs";
import { CATCH_UP_CAP_MINUTES, CURSOR_TTL_SECONDS, cancellableSleep, startPoller as startPollerReal } from "../src/poller.mjs";
import { FORGE_JOB_RETENTION_S } from "@edgehero/pi-dispatch/retention";
import { TRIGGERS_FILE_VERSION, parseTriggers } from "@edgehero/pi-dispatch/triggers";
import { makeCheckMergePolicy, mergePolicyDigest } from "@edgehero/pi-dispatch/merge-policy";
import { enqueueGitHubJob } from "@edgehero/pi-dispatch/queue";
import { POLLER_CYCLE_BEAT_MS, POLLER_GRACE_MS, POLLER_LIVE, parsePollerStatus, pollerKey, triggersDigest } from "@edgehero/pi-dispatch/poller-status";
import { RECEIVER_VERSION } from "../src/version.mjs";

// Issue #464 (gate round 3): never this host's Valkey. Every start here is judged as answering, unless a test judges it.
const startPoller = (env, deps = {}) => startPollerReal(env, { judgeValkey: async () => {}, ...deps });
import { readFileSync } from "node:fs";
import { main } from "../src/cli.mjs";

// Every collaborator is injected -- fetch, redis, queue, clock, sleep, identity, token -- so this
// suite runs offline with no GitHub, no Valkey, and no timers, mirroring receiver.test.mjs's posture.
// The load-bearing test is the SUBSET PARITY one: for each REST shape the poller consumes, the
// equivalent webhook delivery is run through the same filter() and the enqueued payloads must match
// field-for-field, so the polling producer can never drift from the gate the webhook path uses.

const SELF = 999001;
const NOW = Date.parse("2026-08-02T12:00:00Z");

// One trigger of each webhook type (same fixture idiom as config.test.mjs); indices are raw-file positions.
const TRIGGERS_JSON = JSON.stringify({
	triggers: [
		{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix" } },
		{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "triage" } },
		{ on: { type: "pull_request", action: ["labeled"], any: ["pi:review"] }, run: { kind: "github", flow: "review" } },
		{ on: { type: "pull_request", action: ["opened", "synchronize", "reopened"] }, run: { kind: "github", flow: "review" } },
		{ on: { type: "pull_request", action: ["review_submitted"] }, run: { kind: "github", flow: "address-review" } },
	],
});
const FS = { fileExists: () => true, readFile: () => TRIGGERS_JSON };

// ---------------------------------------------------------------------------------------------------
// REST fixtures. The SAME objects are reused to build the webhook twins, which is the point: given
// equivalent upstream data, the two producers' plumbing must land the identical job.
// ---------------------------------------------------------------------------------------------------

const REPOSITORY = { full_name: "o/r" };
const ISSUE7 = { number: 7, title: "T7", body: "B7", labels: [{ name: "pi:fix" }] };
const ISSUE8 = { number: 8, title: "T8", body: "B8", labels: [{ name: "pi:review" }], pull_request: { url: "https://api.github.com/repos/o/r/pulls/8" } };
const PR8 = {
	number: 8,
	title: "T8",
	body: "B8",
	author_association: "MEMBER",
	labels: [{ name: "pi:review" }],
	user: { id: 5 },
	head: { ref: "feat", sha: "beef".repeat(10), repo: { full_name: "o/r" } },
	base: { ref: "main" },
};
const prNine = (sha) => ({
	number: 9,
	title: "T9",
	body: "B9",
	author_association: "COLLABORATOR",
	labels: [],
	user: { id: 6 },
	head: { ref: "fix", sha, repo: { full_name: "x/fork" } },
	base: { ref: "main" },
});
const PR9A = prNine("a".repeat(40));
const PR9B = prNine("b".repeat(40));
const PR9C = prNine("c".repeat(40));

const EV100 = { id: 100, event: "labeled", actor: { id: 5 }, label: { name: "pi:fix" }, issue: ISSUE7 };
const EV201 = { id: 201, event: "labeled", actor: { id: 5 }, label: { name: "pi:fix" }, issue: ISSUE7 };
const EV202 = { id: 202, event: "labeled", actor: { id: 5 }, label: { name: "pi:review" }, issue: ISSUE8 };

// Reviews as the REST list endpoint returns them. `state` is UPPER case here and lower case on the
// webhook -- the one field where the two producers disagree at the source, folded by parseSubset.
const RV500 = { id: 500, user: { id: 5 }, author_association: "MEMBER", state: "APPROVED", body: "seeded, must not replay" };
const RV600 = { id: 600, user: { id: 5 }, author_association: "MEMBER", state: "CHANGES_REQUESTED", body: "rename the helper" };

const C301 = { id: 301, user: { id: 5 }, author_association: "OWNER", body: "@pi do it", created_at: "2026-08-02T12:00:30Z", updated_at: "2026-08-02T12:00:30Z", issue_url: "https://api.github.com/repos/o/r/issues/7" };
const C302 = { id: 302, user: { id: 5 }, author_association: "OWNER", body: "@pi fix this", created_at: "2026-08-02T12:00:31Z", updated_at: "2026-08-02T12:00:31Z", issue_url: "https://api.github.com/repos/o/r/issues/8" };

// ---------------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------------

function ghResponse(status, body, headers = {}) {
	const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
		json: async () => body,
	};
}

/** Route by first matching substring; each route's replies are consumed in order (the last repeats). */
function fakeFetch(routes) {
	const calls = [];
	const counts = new Map();
	const fn = async (url, opts = {}) => {
		calls.push({ url, headers: opts.headers ?? {}, method: opts.method ?? "GET" });
		for (const route of routes) {
			if (!url.includes(route.path)) continue;
			const n = counts.get(route.path) ?? 0;
			counts.set(route.path, n + 1);
			const reply = route.replies[Math.min(n, route.replies.length - 1)];
			return typeof reply === "function" ? reply({ url, headers: opts.headers ?? {} }) : reply;
		}
		throw new Error(`fakeFetch: unrouted ${url}`);
	};
	fn.calls = calls;
	return fn;
}

/**
 * Map-backed redis fake exposing its state (kv/hashes/ttls) so cursors and TTLs are assertable. `ttls` holds the TTL
 * a key was last GIVEN; `ttl()` answers what is LEFT of it under `clock`, the same clock object runPoller advances, so
 * a TTL counts down as the poller sleeps, the way Valkey's does (issue #880's check reads that remainder). `setTtl`
 * and `clearTtl` seed and remove one, and a plain SET clears it, as in Valkey. Keys are not evicted when their TTL
 * runs out: no test here waits 35 days. `ttlFailures` makes the first n TTL reads answer a Valkey error reply.
 *
 * The heartbeat (issue #970) needs a SET with PX (`ttls` then holds seconds, as for EX), a SET answering "OK" as
 * Valkey's does, the index's SADD, SREM and SSCAN (`sets`), and the one script it runs, the index prune, which removes
 * a member whose record key is absent. `dels` holds the cursor family's DELs only (issue #880's "one DEL, of the whole
 * family"); the heartbeat's own go to `statusDels`.
 */
function fakeRedis({ ttlFailures = 0, clock = { ms: NOW } } = {}) {
	const kv = new Map();
	const hashes = new Map();
	const ttls = new Map();
	const expiresAt = new Map();
	const sets = new Map();
	let failuresLeft = ttlFailures;
	const setTtl = (key, ttl) => {
		ttls.set(key, ttl);
		expiresAt.set(key, clock.ms + ttl * 1000);
	};
	const clearTtl = (key) => {
		ttls.delete(key);
		expiresAt.delete(key);
	};
	return {
		kv,
		hashes,
		ttls,
		sets,
		ttlReads: [],
		dels: [],
		statusDels: [],
		setTtl,
		clearTtl,
		async get(key) {
			return kv.has(key) ? kv.get(key) : null;
		},
		async set(key, value, ex, ttl) {
			kv.set(key, String(value));
			if (ex === "EX") setTtl(key, ttl);
			else if (ex === "PX") setTtl(key, ttl / 1000);
			else clearTtl(key);
			return "OK";
		},
		async sadd(key, ...members) {
			if (!sets.has(key)) sets.set(key, new Set());
			let added = 0;
			for (const m of members) if (!sets.get(key).has(String(m))) (sets.get(key).add(String(m)), added++);
			return added;
		},
		async srem(key, ...members) {
			let removed = 0;
			for (const m of members) if (sets.get(key)?.delete(String(m))) removed++;
			return removed;
		},
		// One page holds the whole set: the cursor always comes back "0".
		async sscan(key) {
			return ["0", [...(sets.get(key) ?? [])]];
		},
		// The index prune's script (receiver-status.mjs, pruneLiveIndex): KEYS[1] the index, KEYS[2..] the members' record
		// keys, ARGV the members; a member whose record key is absent leaves the index.
		async eval(_script, numKeys, ...args) {
			const [index, ...recordKeys] = args.slice(0, numKeys);
			const members = args.slice(numKeys);
			let removed = 0;
			recordKeys.forEach((k, i) => {
				if (!kv.has(k) && !hashes.has(k) && sets.get(index)?.delete(String(members[i]))) removed++;
			});
			return removed;
		},
		async hgetall(key) {
			return Object.fromEntries(hashes.get(key) ?? []);
		},
		async hget(key, field) {
			const h = hashes.get(key);
			return h?.has(String(field)) ? h.get(String(field)) : null;
		},
		async hset(key, field, value) {
			if (!hashes.has(key)) hashes.set(key, new Map());
			hashes.get(key).set(String(field), String(value));
		},
		async expire(key, ttl) {
			if (kv.has(key) || hashes.has(key)) setTtl(key, ttl);
		},
		// Valkey's TTL: -2 for a missing key, -1 for one with no expiry, else the seconds left, rounded as Valkey does.
		// The failure is the kind the poller's client surfaces: its offline queue WAITS out a dropped connection, so
		// what reaches the check is an error reply (a replica still loading, a password changed underneath it).
		async ttl(key) {
			this.ttlReads.push(key);
			if (failuresLeft > 0) {
				failuresLeft -= 1;
				throw Object.assign(new Error("LOADING Valkey is loading the dataset in memory"), { name: "ReplyError" });
			}
			if (!kv.has(key) && !hashes.has(key)) return -2;
			return expiresAt.has(key) ? Math.round((expiresAt.get(key) - clock.ms) / 1000) : -1;
		},
		// Valkey's DEL: any number of keys, answering how many existed.
		async del(...keys) {
			(keys.every((key) => String(key).startsWith("poller:")) ? this.statusDels : this.dels).push(keys);
			let removed = 0;
			for (const key of keys) {
				const existed = kv.has(key) || hashes.has(key);
				kv.delete(key);
				hashes.delete(key);
				clearTtl(key);
				if (existed) removed += 1;
			}
			return removed;
		},
		// ioredis INCR: missing key counts as 0, the incremented value is stored as a string and
		// returned as a number. The close-gate retry counter (issue #231) is the only consumer.
		async incr(key) {
			const next = (Number(kv.get(key)) || 0) + 1;
			kv.set(key, String(next));
			return next;
		},
		async quit() {},
	};
}

/**
 * Boot the poller with everything faked and run exactly `cycles` cycles: the injected sleep counts
 * cycle boundaries, advances the fake clock, and calls stop() after the last one. `clock` may be shared
 * with the fake Redis so its TTLs count down with the sleeps (issue #880), and with a second runPoller to
 * play a restart. `nap(ms, n)` says how far the clock moves in cycle n's wait: by default the whole wait,
 * a part of it to stop the poller in the middle of it, more than it for a host that slept. `tokenFn`
 * overrides the mint, and `selfIdFn` the boot's identity lookup (issue #947 edits the file while it runs).
 */
async function runPoller({ env = { POLL_REPOS: "o/r" }, cycles = 1, routes = [], clock = { ms: NOW }, redis = fakeRedis({ clock }), selfId = SELF, selfIdFn = async () => selfId, fsDeps = FS, queueFn: queueFnOver, localEventStore, nap = (ms) => ms, tokenFn = async () => "poll-token" } = {}) {
	const queued = [];
	const out = [];
	const sleeps = [];
	const fetchFn = fakeFetch(routes);
	let remaining = cycles;
	let poller;
	poller = await startPoller(env, {
		fetchFn,
		redis,
		// Overridable (issue #289) so a test can answer with the dedup shape; the default returns
		// undefined, which the poller must read as created -- the pre-#289 seam contract exactly.
		queueFn:
			queueFnOver ??
			(async (job) => {
				queued.push(job);
			}),
		out: (obj) => out.push(obj),
		now: () => clock.ms,
		random: () => 0.5,
		selfIdFn,
		tokenFn,
		fsDeps,
		localEventStore,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock.ms += nap(ms, sleeps.length);
			remaining -= 1;
			if (remaining <= 0) poller.stop();
		},
	});
	await poller.done;
	return { queued, out, sleeps, fetch: fetchFn, redis, clock };
}

/**
 * The full three-cycle scenario behind the parity and dedup-id tests: cycle 1 arms against a seeded
 * backlog, cycle 2 delivers one of each fresh shape (labeled issue, labeled PR, issue comment, PR
 * comment, PR opened), cycle 3 delivers the PR push (synchronize).
 */
function scenarioRoutes() {
	return [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [EV100]), ghResponse(200, [EV202, EV201, EV100])] },
		{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [C301, C302])] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, []), ghResponse(200, [PR9A]), ghResponse(200, [PR9B])] },
		// The reviews sweep runs on every cycle that reaches an open PR. Routed even though it yields
		// nothing here: unrouted would THROW, and pollRepo's per-repo isolation would swallow it into a
		// `poll_repo_failed` line while every assertion below stayed green. See the guard in each test.
		{ path: "/repos/o/r/pulls/9/reviews", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/pulls/8", replies: [ghResponse(200, PR8)] },
		{ path: "/repos/o/r/issues/7", replies: [ghResponse(200, ISSUE7)] },
		{ path: "/repos/o/r/issues/8", replies: [ghResponse(200, ISSUE8)] },
	];
}

/** The job with its deliveryId normalized -- the ONE field that legitimately differs between producers. */
function stripDelivery(job) {
	return { ...job, trigger: { ...job.trigger, deliveryId: "normalized" } };
}

/**
 * Assert the cycle did not quietly fall over. `pollRepo` catches per repo so one dead repo cannot stall
 * the roster, which means ANY throw inside a feed -- an unrouted fetch, a redis method the fake forgot --
 * becomes one log line and zero failed assertions. Every scenario test calls this, because "green because
 * nothing ran" is precisely the failure this suite exists to prevent.
 */
function assertNoRepoFailure(out) {
	const failed = out.filter((o) => o.event === "poll_repo_failed");
	assert.deepEqual(failed, [], `the cycle swallowed a failure: ${JSON.stringify(failed)}`);
}

// The collector is INJECTED into the code under test, never installed over `process.stdout.write`.
// `node --test` runs each file in a child process that serialises its own results over that same stdout,
// so a helper holding a replacement across an `await` swallows the runner's result frames -- three tests
// in `worker/test/start-wiring.test.mjs` were reported as never existing at all, exit code 0 (issue #266).
async function withStdout(fn) {
	const written = [];
	const write = (chunk) => (written.push(String(chunk)), true);
	return { result: await fn(write), out: written.join("") };
}

// ---------------------------------------------------------------------------------------------------
// THE core test: subset parity with the webhook path
// ---------------------------------------------------------------------------------------------------

test("SUBSET PARITY: every polled REST shape enqueues field-for-field what its webhook delivery would", async () => {
	const cfg = loadPollerConfig({ POLL_REPOS: "o/r" }, FS);
	const { queued, out } = await runPoller({ cycles: 3, routes: scenarioRoutes() });
	assertNoRepoFailure(out);
	assert.equal(queued.length, 6, "one job per fresh shape: labeled issue, labeled PR, 2 comments, PR opened, PR synchronize");
	const byDelivery = new Map(queued.map((j) => [j.trigger.deliveryId, j]));

	// Each poll job's webhook twin, built from the SAME upstream objects the fake API served.
	const twins = [
		["poll-e201", "issues", { action: "labeled", sender: { id: 5 }, issue: ISSUE7, repository: REPOSITORY }],
		["poll-e202", "pull_request", { action: "labeled", sender: { id: 5 }, pull_request: PR8, repository: REPOSITORY }],
		["poll-c301", "issue_comment", { action: "created", sender: { id: 5 }, issue: ISSUE7, comment: C301, repository: REPOSITORY }],
		["poll-c302", "issue_comment", { action: "created", sender: { id: 5 }, issue: ISSUE8, comment: C302, repository: REPOSITORY }],
		[`poll-pr9-${"a".repeat(7)}`, "pull_request", { action: "opened", sender: { id: 6 }, pull_request: PR9A, repository: REPOSITORY }],
		[`poll-pr9-${"b".repeat(7)}`, "pull_request", { action: "synchronize", sender: { id: 6 }, pull_request: PR9B, repository: REPOSITORY }],
	];
	for (const [pollDelivery, eventName, webhookPayload] of twins) {
		const verdict = filter(eventName, parseSubset(webhookPayload), cfg, SELF, `wh-${pollDelivery}`);
		assert.equal(verdict.enqueue, true, `the webhook twin of ${pollDelivery} must clear the gate`);
		const polled = byDelivery.get(pollDelivery);
		assert.ok(polled, `the poller must have enqueued ${pollDelivery} (got ${[...byDelivery.keys()].join(", ")})`);
		assert.deepEqual(stripDelivery(polled), stripDelivery(verdict.job), `${pollDelivery}: enqueue payloads must match field-for-field`);
	}

	// The comment twins exercised both flow resolutions: default ("@pi do it" -> triage) and the
	// known-flow override ("@pi fix this" -> fix) -- and the PR comment landed as a pull_request target.
	assert.equal(byDelivery.get("poll-c301").flow, "triage");
	assert.equal(byDelivery.get("poll-c302").flow, "fix");
	assert.equal(byDelivery.get("poll-c302").target.type, "pull_request");
});

test("dedup ids: poll-e<eventId> / poll-c<commentId> / poll-pr<number>-<sha7>, sha-keyed so a new push mints a new id", async () => {
	const { queued } = await runPoller({ cycles: 3, routes: scenarioRoutes() });
	const ids = queued.map((j) => j.trigger.deliveryId).sort();
	assert.deepEqual(ids, ["poll-c301", "poll-c302", "poll-e201", "poll-e202", `poll-pr9-${"a".repeat(7)}`, `poll-pr9-${"b".repeat(7)}`]);
	for (const id of ids) {
		assert.match(id, /^poll-(e\d+|c\d+|pr\d+-[0-9a-f]{7})$/, `${id}: a stable, retry-deterministic stand-in for the delivery GUID`);
	}
});

// ---------------------------------------------------------------------------------------------------
// The reviews source (issue #66)
// ---------------------------------------------------------------------------------------------------

/** Routes for the review scenario. The `/reviews` route MUST precede `/pulls/9`: fakeFetch matches by
 *  substring, and `/repos/o/r/pulls/9/reviews` contains `/repos/o/r/pulls/9`. */
function reviewRoutes({ pulls, reviews }) {
	return [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/pulls/9/reviews", replies: reviews },
		{ path: "/repos/o/r/pulls/9", replies: [ghResponse(200, PR9A)] },
		{ path: "/repos/o/r/pulls?state=open", replies: pulls },
	];
}

test("a polled App review admits the same local listener without queuing payload text", async () => {
	const trigger = { on: { type: "pull_request", forge: "github", id: "app-review", action: ["review_submitted"], reviewAuthors: ["review-app[bot]"] }, run: { kind: "local", folder: "/srv/automation", command: "sweep", worker: "runner-a" } };
	const fsDeps = { fileExists: () => true, readFile: () => JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [trigger] }) };
	const review = { ...RV600, user: { id: 23, login: "review-app[bot]" }, author_association: "NONE" };
	const admitted = [];
	const { queued, out, redis } = await runPoller({
		cycles: 3,
		fsDeps,
		localEventStore: { signal: async (input) => { admitted.push(input); return { accepted: true, coalesced: false }; } },
		routes: reviewRoutes({ pulls: [ghResponse(200, [PR9A])], reviews: [ghResponse(200, []), ghResponse(200, [review])] }),
	});
	assertNoRepoFailure(out);
	assert.deepEqual(queued, []);
	assert.equal(admitted.length, 1);
	assert.equal(admitted[0].deliveryId, "poll-rv600");
	assert.equal(admitted[0].trigger.on.id, "app-review");
	assert.deepEqual(Object.keys(admitted[0]), ["trigger", "deliveryId"]);
	assert.equal(JSON.stringify(admitted).includes(RV600.body), false);
	assert.equal(JSON.stringify(out).includes("review-app[bot]"), false);
	assert.equal(redis.kv.get("poll:o/r:cursor:reviews"), "600");
	assert.deepEqual(out.filter(line => line.event === "poll_cycle").map(line => line.localAccepted ?? 0), [0, 1, 0]);
});

test("local signal admission failure holds the polling cursor and retries the same delivery", async () => {
	const trigger = { on: { type: "pull_request", forge: "github", id: "review", action: ["review_submitted"] }, run: { kind: "local", folder: "/srv/automation", command: "sweep", worker: "runner-a" } };
	const fsDeps = { fileExists: () => true, readFile: () => JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [trigger] }) };
	const attempts = [];
	const cursors = [];
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	const { out } = await runPoller({
		cycles: 3,
		fsDeps, clock, redis,
		localEventStore: { signal: async (input) => {
			attempts.push(input.deliveryId);
			if (attempts.length === 1) throw new Error("signal-unavailable");
			return { accepted: true, coalesced: false };
		} },
		nap: (ms) => { cursors.push(redis.kv.get("poll:o/r:cursor:reviews")); return ms; },
		routes: reviewRoutes({ pulls: [ghResponse(200, [PR9A])], reviews: [ghResponse(200, []), ghResponse(200, [RV600])] }),
	});
	assert.deepEqual(attempts, ["poll-rv600", "poll-rv600"]);
	assert.deepEqual(cursors, ["0", "0", "600"]);
	assert.deepEqual(out.filter(line => line.event === "poll_repo_failed").map(line => line.reason), ["local-event-state-unavailable"]);
});

test("a polled App close uses its exact local grant and durably retries before advancing the event cursor", async () => {
	const trigger = { on: { type: "pull_request", forge: "github", id: "app-close", action: ["closed"], closeActors: ["closer-app[bot]"] }, run: { kind: "local", folder: "/srv/automation", command: "sweep", worker: "runner-a" } };
	const fsDeps = { fileExists: () => true, readFile: () => JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [trigger] }) };
	const closed = { id: 201, event: "closed", actor: { id: 23, login: "closer-app[bot]" }, issue: ISSUE8 };
	const calls = [], cursors = [];
	const clock = { ms: NOW }, redis = fakeRedis({ clock });
	const { queued, out, fetch } = await runPoller({
		cycles: 4, fsDeps, clock, redis,
		localEventStore: { signal: async input => {
			calls.push(input);
			if (calls.length === 1) throw new Error("transient-store-failure");
			return { accepted: true, coalesced: false };
		} },
		nap: ms => { cursors.push(redis.kv.get("poll:o/r:cursor:events")); return ms; },
		routes: [
			{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [EV100]), ghResponse(200, [closed, EV100])] },
			{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [])] },
			{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [])] },
			{ path: "/repos/o/r/pulls/8", replies: [ghResponse(200, { ...PR8, merged: true })] },
		],
	});
	assert.deepEqual(queued, []);
	assert.deepEqual(calls.map(c => c.deliveryId), ["poll-e201", "poll-e201"]);
	assert.deepEqual(Object.keys(calls[1]), ["trigger", "deliveryId"]);
	assert.equal(calls[1].trigger.on.id, "app-close");
	assert.deepEqual(cursors, ["100", "100", "201", "201"]);
	assertNoRepoFailure(out);
	assert.deepEqual(out.filter(line => line.event === "poll_close_gate_retry").map(line => line.reason), ["local-event-state-unavailable"]);
	assert.deepEqual(out.filter(line => line.event === "poll_cycle").map(line => line.localAccepted ?? 0), [0, 0, 1, 0]);
	assert.equal(fetch.calls.some(call => call.url.includes("/collaborators/")), false, "the App's reviewed grant avoids the collaborator endpoint that reports none");
	assert.equal(JSON.stringify(out).includes("closer-app[bot]"), false);
	assert.equal(JSON.stringify(calls).includes(PR8.body), false);
});

test("review validators wait for the whole sweep: a later App review admission failure cannot hide behind 304", async () => {
	const trigger = { on: { type: "pull_request", forge: "github", id: "reviews", action: ["review_submitted"], reviewAuthors: ["review-app[bot]"] }, run: { kind: "local", folder: "/srv/automation", command: "sweep", worker: "runner-a" } };
	const fsDeps = { fileExists: () => true, readFile: () => JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [trigger] }) };
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	const pr10 = { ...PR9A, number: 10 };
	const conditional = (tag, body) => ({ headers }) => headers["if-none-match"] === tag ? ghResponse(304) : ghResponse(200, body, { etag: tag });
	const review = (id) => ({ ...RV600, id, user: { id: 5, login: "review-app[bot]" }, author_association: "NONE" });
	const attempts = [];
	const receipts = new Set();
	const boundaries = [];
	let fail = true;
	await runPoller({
		cycles: 4, clock, redis, fsDeps,
		localEventStore: { async signal(input) {
			attempts.push(input.deliveryId);
			if (input.deliveryId === "poll-rv601" && fail) { fail = false; throw new Error("transient signal failure"); }
			const coalesced = receipts.has(input.deliveryId);
			receipts.add(input.deliveryId);
			return { accepted: true, coalesced };
		} },
		nap: (ms) => {
			boundaries.push({ cursor: redis.kv.get("poll:o/r:cursor:reviews"), tags: Object.fromEntries(redis.hashes.get("poll:o/r:etag:reviews") ?? []) });
			return ms;
		},
		routes: [
			{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [])] },
			{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [])] },
			{ path: "/repos/o/r/pulls/9/reviews", replies: [ghResponse(200, [], { etag: "seed-9" }), conditional("new-9", [review(600)])] },
			{ path: "/repos/o/r/pulls/10/reviews", replies: [ghResponse(200, [], { etag: "seed-10" }), conditional("new-10", [review(601)])] },
			{ path: "/repos/o/r/pulls/9", replies: [ghResponse(200, PR9A)] },
			{ path: "/repos/o/r/pulls/10", replies: [ghResponse(200, pr10)] },
			{ path: "/repos/o/r/pulls?state=open", replies: [conditional("pulls", [PR9A, pr10])] },
		],
	});
	assert.deepEqual(attempts, ["poll-rv600", "poll-rv601", "poll-rv600", "poll-rv601"]);
	assert.deepEqual([...receipts], ["poll-rv600", "poll-rv601"]);
	assert.deepEqual(boundaries, [
		{ cursor: "0", tags: { 9: "seed-9", 10: "seed-10" } },
		{ cursor: "0", tags: { 9: "seed-9", 10: "seed-10" } },
		{ cursor: "601", tags: { 9: "new-9", 10: "new-10" } },
		{ cursor: "601", tags: { 9: "new-9", 10: "new-10" } },
	]);
});

test("review validators never precede the durable cursor, including an uncertain cursor write", async () => {
	for (const committedBeforeFailure of [false, true]) {
		const clock = { ms: NOW };
		const redis = fakeRedis({ clock });
		const set = redis.set.bind(redis);
		let fail = true;
		redis.set = async (key, value, ...args) => {
			if (key === "poll:o/r:cursor:reviews" && value === "600" && fail) {
				fail = false;
				if (committedBeforeFailure) await set(key, value, ...args);
				throw new Error("cursor write did not confirm");
			}
			return set(key, value, ...args);
		};
		const boundaries = [];
		const { queued } = await runPoller({
			cycles: 3, clock, redis,
			nap: (ms) => { boundaries.push(redis.hashes.get("poll:o/r:etag:reviews")?.get("9")); return ms; },
			routes: reviewRoutes({ pulls: [ghResponse(200, [PR9A])], reviews: [
				ghResponse(200, [], { etag: "seed" }),
				({ headers }) => headers["if-none-match"] === "new" ? ghResponse(304) : ghResponse(200, [RV600], { etag: "new" }),
			] }),
		});
		assert.deepEqual(boundaries, ["seed", "seed", "new"], `cursor committed before failure: ${committedBeforeFailure}`);
		assert.equal(redis.kv.get("poll:o/r:cursor:reviews"), "600");
		assert.equal(queued.filter(job => job.trigger.deliveryId === "poll-rv600").length, committedBeforeFailure ? 1 : 2, "uncertain cursor can only repeat a delivery id, never skip its work");
	}
});

test("event, comment and PR validators do not acknowledge failed local admission", async () => {
	const cases = [
		{ feed: "events", on: { type: "label", any: ["pi:fix"] }, initial: [EV100], fresh: [EV201], delivery: "poll-e201" },
		{ feed: "comments", on: { type: "comment", phrase: "@pi" }, fresh: [C301], delivery: "poll-c301" },
		{ feed: "pulls", on: { type: "pull_request", action: ["opened"] }, initial: [], fresh: [PR9A], delivery: `poll-pr9-${"a".repeat(7)}` },
	];
	for (const fixture of cases) {
		const clock = { ms: NOW };
		const redis = fakeRedis({ clock });
		const trigger = { on: { ...fixture.on, forge: "github", id: "listener" }, run: { kind: "local", folder: "/srv/automation", command: "sweep", worker: "runner-a" } };
		const fsDeps = { fileExists: () => true, readFile: () => JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [trigger] }) };
		const attempts = [];
		const boundaries = [];
		const replies = (feed) => feed !== fixture.feed ? [ghResponse(200, [])] : [
			...(fixture.initial ? [ghResponse(200, fixture.initial, { etag: "seed" })] : []),
			({ headers }) => headers["if-none-match"] === "new" ? ghResponse(304) : ghResponse(200, fixture.fresh, { etag: "new" }),
		];
		await runPoller({
			cycles: 3, clock, redis, fsDeps,
			localEventStore: { async signal(input) {
				attempts.push(input.deliveryId);
				if (attempts.length === 1) throw new Error("transient admission failure");
				return { accepted: true, coalesced: false };
			} },
			nap: (ms) => { boundaries.push(redis.kv.get(`poll:o/r:etag:${fixture.feed}`)); return ms; },
			routes: [
				{ path: "/issues/events?per_page=100&page=", replies: [ghResponse(200, [])] },
				{ path: "/repos/o/r/issues/events", replies: replies("events") },
				{ path: "/repos/o/r/issues/comments", replies: replies("comments") },
				{ path: "/repos/o/r/issues/7", replies: [ghResponse(200, ISSUE7)] },
				{ path: "/repos/o/r/pulls/9/reviews", replies: [ghResponse(200, [])] },
				{ path: "/repos/o/r/pulls?state=open", replies: replies("pulls") },
			],
		});
		assert.deepEqual(attempts, [fixture.delivery, fixture.delivery], fixture.feed);
		const previous = fixture.initial ? "seed" : undefined;
		assert.deepEqual(boundaries, [previous, previous, "new"], fixture.feed);
	}
});

test("reviews arm WITHOUT replay: a review that predates the cursor never fires, the next one does", async () => {
	const { queued, out, redis } = await runPoller({
		cycles: 2,
		routes: reviewRoutes({
			pulls: [ghResponse(200, [PR9A])],
			reviews: [ghResponse(200, [RV500]), ghResponse(200, [RV500, RV600])],
		}),
	});
	assertNoRepoFailure(out);

	assert.ok(
		out.some((o) => o.event === "poll_armed" && o.endpoint === "reviews" && o.cursor === 500),
		"cycle 1 learns the high-water mark and enqueues nothing -- a review submitted months ago was an approval for THAT moment",
	);
	// PR 9 also arrives as `opened` on cycle 1's PR diff, so filter by the review's own delivery id.
	const reviewJobs = queued.filter((j) => j.trigger.deliveryId.startsWith("poll-rv"));
	assert.equal(reviewJobs.length, 1, "only the review submitted AFTER arming fires");
	assert.equal(reviewJobs[0].trigger.deliveryId, "poll-rv600");
	assert.equal(reviewJobs[0].flow, "address-review");
	assert.equal(redis.kv.get("poll:o/r:cursor:reviews"), "600", "the cursor advances once, after the whole sweep");
});

test("a re-polled review does not fire twice, and the per-PR validator rides in a hash", async () => {
	const { queued, out, fetch, redis } = await runPoller({
		cycles: 3,
		routes: reviewRoutes({
			pulls: [ghResponse(200, [PR9A])],
			// Same list every cycle after the new review lands: the cursor, not the endpoint, is what dedups.
			reviews: [ghResponse(200, [], { etag: 'W/"r1"' }), ghResponse(200, [RV600]), ghResponse(200, [RV600])],
		}),
	});
	assertNoRepoFailure(out);
	assert.deepEqual(
		queued.filter((j) => j.trigger.deliveryId.startsWith("poll-rv")).map((j) => j.trigger.deliveryId),
		["poll-rv600"],
		"cycle 3 sees the same review and must not re-enqueue it",
	);

	const reviewCalls = fetch.calls.filter((c) => c.url.includes("/pulls/9/reviews"));
	assert.equal(reviewCalls[0].headers["if-none-match"], undefined, "arming must not send a validator");
	assert.equal(reviewCalls[1].headers["if-none-match"], 'W/"r1"', "the armed cycle revalidates with the stored per-PR validator");
	assert.equal(redis.hashes.get("poll:o/r:etag:reviews")?.get("9"), 'W/"r1"', "validators live in ONE hash keyed by PR number, so touchRepo can still expire the family as a unit");
	assert.equal(redis.ttls.get("poll:o/r:cursor:reviews"), 35 * 24 * 3600 + 60, "the reviews cursor carries the same 35-day TTL as the rest of the family, plus the wait (#880)");
});

test("a 304 on the open-PR list still sweeps reviews, taking its PR numbers from the snapshot hash", async () => {
	// The load-bearing case for not betting on whether a review perturbs the /pulls list. Cycle 2's list
	// is unchanged, and the review must still be found.
	const { queued, out, fetch } = await runPoller({
		cycles: 2,
		routes: reviewRoutes({
			pulls: [ghResponse(200, [PR9A], { etag: 'W/"p1"' }), ghResponse(304, null)],
			reviews: [ghResponse(200, []), ghResponse(200, [RV600])],
		}),
	});
	assertNoRepoFailure(out);
	assert.deepEqual(
		queued.filter((j) => j.trigger.deliveryId.startsWith("poll-rv")).map((j) => j.trigger.deliveryId),
		["poll-rv600"],
		"a 304 on /pulls must not make review triggers fire only when something else touches the PR",
	);
	assert.ok(
		fetch.calls.some((c) => /\/pulls\/9(\?|$)/.test(c.url.replace("https://api.github.com", ""))),
		"with no list in hand the PR object is fetched lazily, once, and only because a NEW review turned up",
	);
});

test("SUBSET PARITY for a review, including the case GitHub itself is inconsistent about", async () => {
	const cfg = loadPollerConfig({ POLL_REPOS: "o/r" }, FS);
	const { queued, out } = await runPoller({
		cycles: 2,
		routes: reviewRoutes({ pulls: [ghResponse(200, [PR9A])], reviews: [ghResponse(200, []), ghResponse(200, [RV600])] }),
	});
	assertNoRepoFailure(out);
	const polled = queued.find((j) => j.trigger.deliveryId === "poll-rv600");
	assert.ok(polled, "the poller must have enqueued the review");

	// The webhook twin carries the SAME review with GitHub's OTHER spelling of state: the list endpoint
	// says CHANGES_REQUESTED, the webhook says changes_requested. If the fold ever moves out of
	// parseSubset, one transport starts writing a state the gate and the flow do not recognise.
	const webhookPayload = {
		action: "submitted",
		sender: { id: 5 },
		pull_request: PR9A,
		review: { ...RV600, state: "changes_requested" },
		repository: REPOSITORY,
	};
	const verdict = filter("pull_request_review", parseSubset(webhookPayload), cfg, SELF, "wh-poll-rv600");
	assert.equal(verdict.enqueue, true, "the webhook twin must clear the gate");
	assert.deepEqual(stripDelivery(polled), stripDelivery(verdict.job), "REST and webhook must land the identical job");
	assert.equal(polled.trigger.review.state, "changes_requested", "the upper-case REST spelling is folded, not carried");
});

// ---------------------------------------------------------------------------------------------------
// ETag / politeness / rate limits
// ---------------------------------------------------------------------------------------------------

test("ETag discipline: the stored validator rides If-None-Match and a 304 skips the endpoint", async () => {
	const routes = [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [], { etag: 'W/"e1"' }), ghResponse(304, null)] },
		{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [])] },
	];
	const { queued, out, fetch, redis } = await runPoller({ cycles: 2, routes });

	const eventCalls = fetch.calls.filter((c) => c.url.includes("/issues/events"));
	assert.equal(eventCalls.length, 2);
	assert.equal(eventCalls[0].headers["if-none-match"], undefined, "arming has no validator yet and must not send one");
	assert.equal(eventCalls[1].headers["if-none-match"], 'W/"e1"', "the armed cycle revalidates with the stored ETag");
	assert.equal(redis.kv.get("poll:o/r:etag:events"), 'W/"e1"', "the validator is stored under the per-endpoint key");

	assert.equal(queued.length, 0);
	const cycles = out.filter((o) => o.event === "poll_cycle");
	assert.equal(cycles[1].notModified >= 1, true, "the 304 is visible in the cycle summary");
});

test("x-poll-interval is honored as the MINIMUM cycle delay when it exceeds the configured interval", async () => {
	const routes = [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [], { "x-poll-interval": "300" })] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [])] },
	];
	const { sleeps } = await runPoller({ cycles: 1, routes });
	assert.deepEqual(sleeps, [300_000], "GitHub asked for 300s; the 60s default must lose to it");
});

test("an exhausted rate limit aborts the roster and sleeps until x-ratelimit-reset plus jitter", async () => {
	const reset = NOW / 1000 + 120;
	const routes = [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(403, { message: "rate limited" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) })] },
	];
	const { out, sleeps, fetch, queued } = await runPoller({ cycles: 1, routes });
	assert.equal(fetch.calls.length, 1, "the quota is credential-global: no further endpoint is tried this cycle");
	assert.equal(queued.length, 0);
	assert.ok(out.some((o) => o.event === "poll_rate_limited"), "the sleep is said out loud");
	// 120s to reset + deterministic jitter (random()=0.5 -> 1000 + 14500 ms), beating the 60s interval.
	assert.deepEqual(sleeps, [135_500]);
});

// ---------------------------------------------------------------------------------------------------
// Arming, cursors, TTLs
// ---------------------------------------------------------------------------------------------------

test("first boot arms cursors from the seeded backlog and enqueues NOTHING -- old labels are not standing orders", async () => {
	const oldComment = { ...C301, id: 250, created_at: "2026-08-02T11:00:00Z", updated_at: "2026-08-02T11:00:00Z" };
	const routes = [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [EV202, EV201])] },
		{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [oldComment])] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [PR9A])] },
	];
	const { queued, redis, out } = await runPoller({ cycles: 2, routes });

	assert.equal(queued.length, 0, "neither the arming cycle nor the unchanged next cycle may replay history");
	assert.equal(redis.kv.get("poll:o/r:cursor:events"), "202", "events cursor = newest seen id");
	assert.equal(redis.kv.get("poll:o/r:cursor:comments"), "2026-08-02T12:00:00Z", "comments cursor = arm time (second-precision ISO)");
	assert.ok(redis.kv.get("poll:o/r:cursor:prs"), "the PR snapshot is marked armed");
	assert.deepEqual(await redis.hgetall("poll:o/r:prs"), { 9: "a".repeat(40) }, "open PRs snapshot without enqueuing");
	assert.equal(out.filter((o) => o.event === "poll_armed").length, 3, "all three endpoints armed, said out loud");
});

test("cursor keys carry the ~35-day TTL (outliving the 31-day gh-* jobId retention)", async () => {
	const routes = [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [EV201])] },
		{ path: "/repos/o/r/pulls/9/reviews", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [PR9A])] },
	];
	const { redis, out } = await runPoller({ cycles: 1, routes });
	// Polled THROUGH: a repo that fails is not renewed at the end of the cycle (#880), and this test once passed on
	// the TTLs the writes alone set, with the reviews sweep unrouted and the repo failing.
	assertNoRepoFailure(out);
	// Renewed at the end of the cycle to the TTL plus the 60-second wait before the next poll (issue #880).
	const ttl = 35 * 24 * 3600 + 60;
	for (const key of ["poll:o/r:cursor:events", "poll:o/r:cursor:comments", "poll:o/r:cursor:prs", "poll:o/r:prs"]) {
		assert.equal(redis.ttls.get(key), ttl, `${key} must expire with the rest of its family`);
	}
});

test("the cursor TTL is derived from the gh-* job retention and strictly outlives it, in seconds (#761)", () => {
	// Derived AND pinned: the literal 35 days above still holds, and a change to the retention moves the cursor with it.
	assert.ok(CURSOR_TTL_SECONDS > FORGE_JOB_RETENTION_S, "the cursor must outlive the job id it backs up");
	assert.equal(CURSOR_TTL_SECONDS, FORGE_JOB_RETENTION_S + 4 * 86_400);
	assert.equal(CURSOR_TTL_SECONDS, 35 * 24 * 3600);
});

// ---------------------------------------------------------------------------------------------------
// The catch-up horizon (issue #880): a poller started again after a long stop starts from now
// ---------------------------------------------------------------------------------------------------

// Every key of one repo's cursor family, spelled out rather than imported: a re-arm must delete exactly these, and
// a key added to keyNames without this list moving is a family member nobody decided about.
const FAMILY = ["cursor:events", "cursor:comments", "cursor:prs", "prs", "etag:events", "etag:comments", "etag:pulls", "cursor:reviews", "etag:reviews"].map((k) => `poll:o/r:${k}`);

/**
 * The family a poller leaves behind when its next poll has been due for `stoppedSeconds` at NOW: every key present,
 * each with CURSOR_TTL_SECONDS minus that left (a negative `stoppedSeconds` is a restart inside the planned wait).
 * Events cursor 100, the comments cursor at the stop, PR 9 open at sha a, the reviews cursor 500, and an old
 * validator on every endpoint. The redis must run on a clock at NOW, as runPoller's default one does.
 */
function seedFamily(redis, stoppedSeconds) {
	const at = new Date(NOW - Math.max(0, stoppedSeconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
	const values = { "cursor:events": "100", "cursor:comments": at, "cursor:prs": at, "cursor:reviews": "500", "etag:events": 'W/"old-e"', "etag:comments": 'W/"old-c"', "etag:pulls": 'W/"old-p"' };
	for (const [k, v] of Object.entries(values)) redis.kv.set(`poll:o/r:${k}`, v);
	redis.hashes.set("poll:o/r:prs", new Map([["9", PR9A.head.sha]]));
	redis.hashes.set("poll:o/r:etag:reviews", new Map([["9", 'W/"old-r"']]));
	for (const key of FAMILY) redis.setTtl(key, CURSOR_TTL_SECONDS - stoppedSeconds);
}

// A comment made five minutes before NOW: inside the gap of every stop these tests seed, after the comments cursor of
// a ten-minute one, before the cursor a re-arm at NOW writes.
const C_GAP = { ...C301, id: 310, created_at: "2026-08-02T11:55:00Z", updated_at: "2026-08-02T11:55:00Z" };

/** What GitHub shows a poller coming back: one of each source that moved while it was stopped. */
function gapRoutes() {
	return [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [EV202, EV201, EV100])] },
		{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [C_GAP])] },
		{ path: "/repos/o/r/pulls/9/reviews", replies: [ghResponse(200, [RV500, RV600])] },
		{ path: "/repos/o/r/pulls/8", replies: [ghResponse(200, PR8)] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [PR9B])] },
		{ path: "/repos/o/r/issues/7", replies: [ghResponse(200, ISSUE7)] },
	];
}
const GAP_JOBS = ["poll-c310", "poll-e201", "poll-e202", `poll-pr9-${"b".repeat(7)}`, "poll-rv600"];

/** A repo with nothing but label events: each argument is one cycle's page, a reply as is or a list for a 200. */
function eventRoutes(...pages) {
	return [
		{ path: "/repos/o/r/issues/events", replies: pages.map((p) => (Array.isArray(p) ? ghResponse(200, p) : p)) },
		{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [])] },
	];
}
const deliveries = (queued) => queued.map((j) => j.trigger.deliveryId).sort();
const lines = (out, event) => out.filter((o) => o.event === event);
const resumedOrRearmed = (out) => out.filter((o) => o.event === "poll_resumed" || o.event === "poll_rearmed").map(({ event, stoppedMinutes }) => [event, stoppedMinutes]);

test("a poller started again inside the catch-up horizon resumes on every feed and says how far back it reached (#880)", async () => {
	const redis = fakeRedis();
	seedFamily(redis, 10 * 60);
	const { queued, out } = await runPoller({ redis, routes: gapRoutes() });
	assertNoRepoFailure(out);
	assert.deepEqual(deliveries(queued), GAP_JOBS, "a label, a comment, a push and a review from the ten minutes it was down");
	assert.deepEqual(lines(out, "poll_resumed"), [{ event: "poll_resumed", repo: "o/r", stoppedMinutes: 10, horizonMinutes: 60 }]);
	assert.deepEqual(lines(out, "poll_rearmed"), []);
	assert.deepEqual(lines(out, "poll_armed"), [], "a resumed family is not armed again");
	assert.deepEqual(redis.dels, [], "and nothing of it is deleted");
});

test("a poller started again past the horizon re-arms every feed from now and enqueues nothing from the gap (#880)", async () => {
	const redis = fakeRedis();
	seedFamily(redis, 2 * 3600);
	redis.kv.set("poll:o/r:close-gate:poll-e90", "3");
	const { queued, out, fetch } = await runPoller({ redis, cycles: 2, routes: gapRoutes() });
	assertNoRepoFailure(out);
	assert.deepEqual(queued, [], "neither the arming cycle nor the next one acts on what happened while it was stopped");
	assert.deepEqual(lines(out, "poll_rearmed"), [{ event: "poll_rearmed", repo: "o/r", stoppedMinutes: 120, horizonMinutes: 60 }]);
	assert.ok(out.findIndex((o) => o.event === "poll_rearmed") < out.findIndex((o) => o.event === "poll_armed"), "the line comes before the feeds re-arm");
	assert.deepEqual(lines(out, "poll_armed").map((o) => o.endpoint).sort(), ["comments", "events", "pulls", "reviews"], "each feed re-armed through its own first-boot branch");
	assert.deepEqual(lines(out, "poll_resumed"), []);

	// ONE DEL, of the whole family touchRepo refreshes, and nothing outside it.
	assert.equal(redis.dels.length, 1);
	assert.deepEqual([...redis.dels[0]].sort(), [...FAMILY].sort());
	assert.equal(redis.kv.get("poll:o/r:close-gate:poll-e90"), "3", "a close-gate counter is left to its own one-day TTL");

	// The cursors now say NOW, as a first boot's would.
	assert.equal(redis.kv.get("poll:o/r:cursor:events"), "202");
	assert.equal(redis.kv.get("poll:o/r:cursor:comments"), "2026-08-02T12:00:00Z");
	assert.equal(redis.kv.get("poll:o/r:cursor:reviews"), "600");
	assert.deepEqual(await redis.hgetall("poll:o/r:prs"), { 9: "b".repeat(40) }, "the snapshot is the open list of now, and the push it shows is not a synchronize");
	for (const key of ["poll:o/r:etag:events", "poll:o/r:etag:comments", "poll:o/r:etag:pulls"]) assert.equal(redis.kv.has(key), false, `${key} went with its cursor`);
	assert.equal(redis.hashes.has("poll:o/r:etag:reviews"), false);
	assert.equal(fetch.calls.find((c) => c.url.includes("/issues/events")).headers["if-none-match"], undefined, "arming sends no validator");
});

test("the horizon is inclusive at its edge, a second past it re-arms, and the minutes logged round up (#880)", async () => {
	for (const [stopped, expected] of [[3600, ["poll_resumed", 60]], [3601, ["poll_rearmed", 61]]]) {
		const redis = fakeRedis();
		seedFamily(redis, stopped);
		const { out } = await runPoller({ redis, routes: gapRoutes() });
		assertNoRepoFailure(out);
		assert.deepEqual(resumedOrRearmed(out), [expected], `${stopped}s overdue`);
	}
});

test("POLL_CATCHUP_MINUTES=0 never catches up: a minute away, and even a restart inside the same second, re-arm (#880)", async () => {
	for (const stopped of [60, 0]) {
		const redis = fakeRedis();
		seedFamily(redis, stopped);
		const { queued, out } = await runPoller({ env: { POLL_REPOS: "o/r", POLL_CATCHUP_MINUTES: "0" }, redis, routes: gapRoutes() });
		assertNoRepoFailure(out);
		assert.deepEqual(queued, [], `${stopped}s`);
		assert.deepEqual(lines(out, "poll_rearmed"), [{ event: "poll_rearmed", repo: "o/r", stoppedMinutes: stopped / 60, horizonMinutes: 0 }]);
	}
});

test("a restart inside the planned wait reads as 0 minutes away: the age is clamped at 0, never negative (#880)", async () => {
	const redis = fakeRedis();
	seedFamily(redis, -5 * 60); // its next poll was five minutes off when it was started again
	const { queued, out } = await runPoller({ redis, routes: gapRoutes() });
	assertNoRepoFailure(out);
	assert.deepEqual(lines(out, "poll_resumed"), [{ event: "poll_resumed", repo: "o/r", stoppedMinutes: 0, horizonMinutes: 60 }]);
	// The comment from 11:55 predates the comments cursor such a recent poll left (NOW), so it is not new; the rest is.
	assert.deepEqual(deliveries(queued), GAP_JOBS.filter((id) => id !== "poll-c310"));
});

test("a horizon at or past the cursor TTL is the poller from before #880: it resumes and reads nothing to decide it", async () => {
	assert.equal(CATCH_UP_CAP_MINUTES, CURSOR_TTL_SECONDS / 60);
	assert.equal(CATCH_UP_CAP_MINUTES, 35 * 24 * 60);
	for (const value of [String(CATCH_UP_CAP_MINUTES), "100000"]) {
		const redis = fakeRedis();
		seedFamily(redis, 30 * 24 * 3600);
		redis.clearTtl("poll:o/r:cursor:events"); // even an undated cursor resumes, as it always did
		const { queued, out } = await runPoller({ env: { POLL_REPOS: "o/r", POLL_CATCHUP_MINUTES: value }, redis, routes: gapRoutes() });
		assertNoRepoFailure(out);
		assert.deepEqual(deliveries(queued), GAP_JOBS, `${value}: thirty days stopped, and the gap is caught up`);
		assert.deepEqual(redis.ttlReads, [], `${value}: no TTL is read`);
		assert.deepEqual(redis.dels, []);
		assert.equal(out.some((o) => o.event === "poll_rearmed" || o.event === "poll_resumed"), false);
	}
});

test("a family that cannot be dated is re-armed: an events cursor without a TTL, or a family without its events cursor (#880)", async () => {
	const undated = fakeRedis();
	seedFamily(undated, 60);
	undated.clearTtl("poll:o/r:cursor:events");
	const partial = fakeRedis();
	seedFamily(partial, 60);
	partial.kv.delete("poll:o/r:cursor:events");
	for (const [name, redis] of [["no TTL", undated], ["no events cursor", partial]]) {
		const { queued, out } = await runPoller({ redis, routes: gapRoutes() });
		assertNoRepoFailure(out);
		assert.deepEqual(queued, [], `${name}: a gap nobody can measure is not replayed`);
		assert.deepEqual(lines(out, "poll_rearmed"), [{ event: "poll_rearmed", repo: "o/r", stoppedMinutes: null, horizonMinutes: 60 }], name);
	}
});

test("a first boot has nothing to date: no rearm line, only the feeds' own arming (#880)", async () => {
	const { queued, out, redis } = await runPoller({ routes: gapRoutes() });
	assertNoRepoFailure(out);
	assert.deepEqual(queued, []);
	assert.deepEqual(redis.ttlReads, ["poll:o/r:cursor:events"], "the check ran");
	assert.deepEqual(lines(out, "poll_rearmed"), []);
	assert.deepEqual(lines(out, "poll_resumed"), []);
	assert.equal(lines(out, "poll_armed").length, 4);
});

test("an error reply to the check skips the repo, loudly, until a check succeeds; it never polls from undated cursors (#880)", async () => {
	const clock = { ms: NOW };
	const redis = fakeRedis({ ttlFailures: 1, clock });
	seedFamily(redis, 10 * 60);
	const { queued, out } = await runPoller({ clock, redis, cycles: 2, routes: gapRoutes() });
	assertNoRepoFailure(out);
	const failed = lines(out, "poll_catchup_check_failed");
	assert.equal(failed.length, 1);
	assert.equal(failed[0].repo, "o/r");
	assert.match(failed[0].reason, /^LOADING /);
	const cycles = lines(out, "poll_cycle");
	assert.equal(cycles[0].fetched, 0, "cycle 1 reads nothing of the repo whose check failed");
	assert.ok(out.indexOf(failed[0]) < out.indexOf(cycles[0]));
	assert.deepEqual(redis.ttlReads, Array(2).fill("poll:o/r:cursor:events"), "checked again before cycle 2 polled it");
	assert.deepEqual(lines(out, "poll_resumed").map((o) => o.stoppedMinutes), [11], "and dated then, the failed cycle counted");
	assert.deepEqual(deliveries(queued), GAP_JOBS);
	assert.ok(cycles[1].fetched > 0, "cycle 2 polled it");
});

test("a repository the App installation lists again is checked before its first poll back (#880)", async () => {
	const env = { GITHUB_AUTH_SOURCE: "app", GITHUB_APP_ID: "7", GITHUB_APP_INSTALLATION_ID: "11", GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem" };
	const list = (...names) => ghResponse(200, { total_count: names.length, repositories: names.map((full_name) => ({ full_name })) });
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	seedFamily(redis, 2 * 3600);
	const routes = [
		// Boot lists o/a alone; the refresh on the eleventh cycle lists o/r again.
		{ path: "/installation/repositories", replies: [list("o/a"), list("o/a", "o/r")] },
		{ path: "/repos/o/a/issues/events", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/a/issues/comments", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/a/pulls?state=open", replies: [ghResponse(200, [])] },
		...gapRoutes(),
	];
	const { queued, out } = await runPoller({ env, cycles: 11, routes, clock, redis });
	assertNoRepoFailure(out);
	assert.deepEqual(redis.ttlReads, ["poll:o/a:cursor:events", "poll:o/r:cursor:events"], "o/a before its first poll, o/r before its first poll back");
	assert.deepEqual(lines(out, "poll_rearmed"), [{ event: "poll_rearmed", repo: "o/r", stoppedMinutes: 130, horizonMinutes: 60 }], "two hours, and the ten cycles it waited out of the list");
	assert.deepEqual(queued, [], "its family from before it left is not resumed");
});

// The review of #880's first version: the age counted from the LAST poll, so the wait the poller had planned before
// its next one was read as time away. These restart a real loop on a shared clock and Valkey fake, the second poller
// reading what the first one's renewals left behind, counted down by the clock.

test("a stop during the planned wait is not time away: an hour's interval, stopped at its end and started a minute later, catches up (#880)", async () => {
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	const env = { POLL_REPOS: "o/r", POLL_INTERVAL_SECONDS: "3600" };
	await runPoller({ env, clock, redis, routes: eventRoutes([EV100]) });
	clock.ms += 60_000;
	const { queued, out } = await runPoller({ env, clock, redis, routes: eventRoutes([EV201, EV100]) });
	assertNoRepoFailure(out);
	assert.deepEqual(resumedOrRearmed(out), [["poll_resumed", 1]], "one minute past when its next poll was due, not 61");
	assert.deepEqual(deliveries(queued), ["poll-e201"], "the label applied in that hour starts its job");
});

test("a stop one minute into an hour's wait, started again at once, reads 0 minutes and catches up (#880)", async () => {
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	const env = { POLL_REPOS: "o/r", POLL_INTERVAL_SECONDS: "3600" };
	await runPoller({ env, clock, redis, routes: eventRoutes([EV100]), nap: () => 60_000 });
	const { queued, out } = await runPoller({ env, clock, redis, routes: eventRoutes([EV201, EV100]) });
	assertNoRepoFailure(out);
	assert.deepEqual(resumedOrRearmed(out), [["poll_resumed", 0]]);
	assert.deepEqual(deliveries(queued), ["poll-e201"]);
});

test("a one-minute horizon is not 0 at the default interval: a restart 30 seconds after the next poll was due catches up (#880)", async () => {
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	const env = { POLL_REPOS: "o/r", POLL_CATCHUP_MINUTES: "1" };
	await runPoller({ env, clock, redis, routes: eventRoutes([EV100]) });
	clock.ms += 30_000;
	const { queued, out } = await runPoller({ env, clock, redis, routes: eventRoutes([EV201, EV100]) });
	assertNoRepoFailure(out);
	assert.deepEqual(resumedOrRearmed(out), [["poll_resumed", 1]]);
	assert.deepEqual(deliveries(queued), ["poll-e201"]);
});

test("a rate-limit sleep is a planned wait too: stopped 80 minutes into a 90-minute reset, it catches up (#880)", async () => {
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	const reset = (NOW + 60_000) / 1000 + 90 * 60; // cycle 2 starts a minute after NOW and is told to wait 90 minutes
	const first = await runPoller({
		clock,
		redis,
		cycles: 2,
		routes: eventRoutes([EV100], ghResponse(403, { message: "rate limited" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) })),
		nap: (ms, n) => (n === 1 ? ms : 80 * 60_000),
	});
	assert.equal(first.sleeps[1], 90 * 60_000 + 15_500, "the reset plus the fixed jitter");
	const { queued, out } = await runPoller({ clock, redis, routes: eventRoutes([EV201, EV100]) });
	assertNoRepoFailure(out);
	assert.deepEqual(resumedOrRearmed(out), [["poll_resumed", 0]]);
	assert.deepEqual(deliveries(queued), ["poll-e201"]);
});

test("an idle cycle, every endpoint a 304, renews every key of the family to the TTL plus the wait (#880)", async () => {
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	seedFamily(redis, 2 * 3600);
	const routes = [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(304, null)] },
		{ path: "/repos/o/r/issues/comments", replies: [ghResponse(304, null)] },
		{ path: "/repos/o/r/pulls/9/reviews", replies: [ghResponse(304, null)] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(304, null)] },
	];
	const { out } = await runPoller({ env: { POLL_REPOS: "o/r", POLL_CATCHUP_MINUTES: "180" }, clock, redis, routes });
	assertNoRepoFailure(out);
	assert.deepEqual(resumedOrRearmed(out), [["poll_resumed", 120]]);
	assert.equal(lines(out, "poll_cycle")[0].notModified, 4, "nothing was written: every key's TTL can only have come from the renewal");
	for (const key of FAMILY) {
		assert.equal(redis.ttls.get(key), CURSOR_TTL_SECONDS + 60, `${key} renewed to the TTL plus the 60-second wait`);
		assert.equal(await redis.ttl(key), CURSOR_TTL_SECONDS, `${key}: once the wait has passed, the next poll is due now, 0 minutes overdue`);
	}
});

test("a graceful stop renews what the cycle polled with no wait, so a restart reads the stop itself (#880)", async () => {
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	seedFamily(redis, 10 * 60);
	let poller;
	const out = [];
	poller = await startPoller({ POLL_REPOS: "o/r" }, {
		fetchFn: fakeFetch(gapRoutes()),
		redis,
		// Stop while the repo is being polled: the in-flight repo finishes, then the loop ends.
		queueFn: async () => poller.stop(),
		out: (o) => out.push(o),
		now: () => clock.ms,
		random: () => 0.5,
		selfIdFn: async () => SELF,
		tokenFn: async () => "poll-token",
		fsDeps: FS,
		sleep: async () => assert.fail("a stopped poller never waits"),
	});
	await poller.done;
	assertNoRepoFailure(out);
	for (const key of FAMILY) assert.equal(await redis.ttl(key), CURSOR_TTL_SECONDS, `${key}: due at the stop`);
});

test("the check waits for the repo's first poll: a token mint that fails for two hours at boot counts toward the age (#880)", async () => {
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	seedFamily(redis, 10 * 60);
	let mints = 0;
	const { queued, out } = await runPoller({
		env: { POLL_REPOS: "o/r", POLL_INTERVAL_SECONDS: "3600" },
		clock,
		redis,
		cycles: 3,
		routes: gapRoutes(),
		tokenFn: async () => {
			mints += 1;
			if (mints <= 2) throw new Error("gh auth token: not logged in");
			return "poll-token";
		},
	});
	assertNoRepoFailure(out);
	assert.equal(lines(out, "poll_token_failed").length, 2);
	assert.deepEqual(resumedOrRearmed(out), [["poll_rearmed", 130]], "checked when it was first polled, two hours and ten minutes on");
	assert.deepEqual(queued, []);
});

test("a wait that ends later than the horizon is read as a host suspend and every repo is checked again; a shorter one is not (#880)", async () => {
	const run = (env, lateMs) => runPoller({ env, cycles: 2, routes: eventRoutes([EV100], [EV201, EV100]), nap: (ms, n) => (n === 1 ? ms + lateMs : ms) });

	const slept = await run({ POLL_REPOS: "o/r" }, 2 * 3600_000);
	assertNoRepoFailure(slept.out);
	assert.deepEqual(lines(slept.out, "poll_woke_late"), [{ event: "poll_woke_late", lateMinutes: 120, horizonMinutes: 60 }]);
	assert.deepEqual(resumedOrRearmed(slept.out), [["poll_rearmed", 120]], "dated from Valkey's TTL, which the suspend ran down");
	assert.deepEqual(slept.queued, [], "the label from while the host slept is not acted on");

	for (const [env, lateMs, why] of [[{ POLL_REPOS: "o/r" }, 30 * 60_000, "inside the horizon"], [{ POLL_REPOS: "o/r", POLL_CATCHUP_MINUTES: "0" }, 30_000, "under the one-minute floor, at a horizon of 0"]]) {
		const late = await run(env, lateMs);
		assertNoRepoFailure(late.out);
		assert.deepEqual(lines(late.out, "poll_woke_late"), [], why);
		assert.deepEqual(deliveries(late.queued), ["poll-e201"], `${why}: caught up as a running poller does`);
	}
});

// ---------------------------------------------------------------------------------------------------
// Event semantics
// ---------------------------------------------------------------------------------------------------

test("reopened: a PR that left the open list and came back enqueues `reopened`, not `opened`", async () => {
	const routes = [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, []), ghResponse(200, [PR9A]), ghResponse(200, []), ghResponse(200, [PR9C])] },
	];
	const { queued, redis } = await runPoller({ cycles: 4, routes });
	assert.deepEqual(
		queued.map((j) => [j.trigger.action, j.trigger.deliveryId]),
		[
			["opened", `poll-pr9-${"a".repeat(7)}`],
			["reopened", `poll-pr9-${"c".repeat(7)}`],
		],
		"disappearance marks the PR closed; reappearance is the (best-effort) reopen, never a second opened",
	);
	assert.deepEqual(await redis.hgetall("poll:o/r:prs"), { 9: "c".repeat(40) });
});

test("an edited old comment is skipped (webhook parity: only `created` fires) -- and its issue is never fetched", async () => {
	const edited = { ...C301, id: 500, created_at: "2026-08-02T11:00:00Z", updated_at: "2026-08-02T12:00:40Z" };
	const routes = [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [edited])] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [])] },
	];
	const { queued, fetch, redis } = await runPoller({ cycles: 2, routes });
	assert.equal(queued.length, 0);
	assert.ok(!fetch.calls.some((c) => c.url.includes("/issues/7")), "the per-comment issue fetch is paid only for NEW comments");
	assert.equal(redis.kv.get("poll:o/r:cursor:comments"), "2026-08-02T12:00:40Z", "the cursor still advances past the edit");
});

test("bot-loop guard holds end-to-end: a comment authored by selfId is dropped by the shared filter, never enqueued", async () => {
	const selfComment = { ...C301, id: 400, user: { id: SELF } };
	const routes = [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [selfComment])] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/issues/7", replies: [ghResponse(200, ISSUE7)] },
	];
	const { queued, out } = await runPoller({ cycles: 2, routes });
	assert.equal(queued.length, 0, "the harness's own completion comment must never become another paid job");
	assert.ok(
		out.some((o) => o.event === "dropped" && o.reason === "self" && o.delivery === "poll-c400"),
		"the drop is the filter's own `self` verdict, observable per delivery",
	);
});

// ---------------------------------------------------------------------------------------------------
// run.command triggers through the polling producer (issue #189)
// ---------------------------------------------------------------------------------------------------

test("a comment command trigger fires through the poller: command on the job, no flow key, override inert end-to-end", async () => {
	// The SAME filter serves both producers, so a command rule must ride the polled feed exactly as it
	// rides a webhook. The comment's trailing words are "fix this" -- and `fix` IS a known flow (the label
	// rule's) -- which makes this the end-to-end retarget pin: through config loading, the poller's comment
	// feed and the shared gate, the trailing known-flow word must stay DATA and the job must stay a
	// command job.
	const cmdTriggers = JSON.stringify({
		triggers: [
			{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix" } },
			{ on: { type: "comment", phrase: "@pi-run" }, run: { kind: "github", command: "wf run nightly" } },
		],
	});
	const cmdComment = { id: 350, user: { id: 5 }, author_association: "OWNER", body: "@pi-run fix this", created_at: "2026-08-02T12:00:30Z", updated_at: "2026-08-02T12:00:30Z", issue_url: "https://api.github.com/repos/o/r/issues/7" };
	const routes = [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [cmdComment])] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/issues/7", replies: [ghResponse(200, ISSUE7)] },
	];
	const { queued, out } = await runPoller({ cycles: 2, routes, fsDeps: { fileExists: () => true, readFile: () => cmdTriggers } });
	assertNoRepoFailure(out);

	assert.equal(queued.length, 1, "cycle 1 arms; cycle 2 delivers exactly the command comment");
	const job = queued[0];
	assert.equal(job.trigger.deliveryId, "poll-c350");
	assert.equal(job.command, "wf run nightly");
	assert.equal("flow" in job, false, "a trailing known-flow word must not turn the command job into a flow job (or into a no-flow drop)");
	assert.deepEqual(job.trigger.matched, { index: 1, type: "comment", phrase: "@pi-run" });
	assert.equal(job.trigger.comment.body, "@pi-run fix this", "the trailing words ride as data for the handler, via event.json");
});

// ---------------------------------------------------------------------------------------------------
// The closed source (issue #231)
// ---------------------------------------------------------------------------------------------------

// A trigger file with BOTH close groups armed, plus the label rule so the no-lookup-for-other-sources
// pin below runs against a file where close rules genuinely exist. Indices are raw-file positions.
const CLOSE_TRIGGERS_JSON = JSON.stringify({
	triggers: [
		{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix" } },
		{ on: { type: "issue", action: ["closed"] }, run: { kind: "github", flow: "post-close" } },
		{ on: { type: "pull_request", action: ["closed"] }, run: { kind: "github", flow: "post-merge" } },
	],
});
const CLOSE_FS = { fileExists: () => true, readFile: () => CLOSE_TRIGGERS_JSON };

const ISSUE20 = { number: 20, title: "T20", body: "B20", labels: [] };
// The closer rides `actor` in the events feed (live-verified against api.github.com: `closed`
// entries carry actor {id, login}, a PR appears with issue.pull_request set, and a MERGED PR emits
// a `closed` entry too). EV701 reuses ISSUE8, whose pull_request marker routes it down the PR arm.
const EV700 = { id: 700, event: "closed", actor: { id: 5, login: "alice" }, issue: ISSUE20 };
const EV701 = { id: 701, event: "closed", actor: { id: 5, login: "alice" }, issue: ISSUE8 };
// The inert seed every scenario keeps at the tail of the feed, scenarioRoutes' own convention: the
// events endpoint pages while the OLDEST fetched entry is newer than the cursor, and fakeFetch
// repeats its last reply -- an armed-at-empty feed would page the same reply MAX_EVENT_PAGES times
// and hand the loop five copies of every event.
const EV698 = { id: 698, event: "assigned", actor: { id: 5, login: "alice" }, issue: ISSUE20 };

/** Routes for the closed scenarios. `/collaborators/` and `/pulls/8` are registered FIRST: fakeFetch
 *  matches by substring, first hit wins, and the broader routes would otherwise shadow them. */
function closeRoutes({ events, permission = [ghResponse(200, { permission: "admin" })] }) {
	return [
		{ path: "/collaborators/", replies: permission },
		{ path: "/repos/o/r/pulls/8", replies: [ghResponse(200, PR8)] },
		{ path: "/repos/o/r/issues/events", replies: events },
		{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [])] },
	];
}

const collaboratorCalls = (fetch) => fetch.calls.filter((c) => c.url.includes("/collaborators/"));

test("SUBSET PARITY for a close: issue and PR `closed` events enqueue what their webhook twins would (issue #231)", async () => {
	const cfg = loadPollerConfig({ POLL_REPOS: "o/r" }, CLOSE_FS);
	const { queued, out, fetch } = await runPoller({
		cycles: 2,
		routes: closeRoutes({ events: [ghResponse(200, [EV698]), ghResponse(200, [EV701, EV700, EV698])] }),
		fsDeps: CLOSE_FS,
	});
	assertNoRepoFailure(out);
	assert.equal(queued.length, 2, "one job per fresh close: the issue and the PR");
	const byDelivery = new Map(queued.map((j) => [j.trigger.deliveryId, j]));

	// The webhook twins, built from the SAME upstream objects, with the closer PRE-AUTHORIZED (the
	// sixth argument) exactly as the receiver hands it to filter after its own lookup.
	const twins = [
		["poll-e700", "issues", { action: "closed", sender: { id: 5, login: "alice" }, issue: ISSUE20, repository: REPOSITORY }],
		["poll-e701", "pull_request", { action: "closed", sender: { id: 5, login: "alice" }, pull_request: PR8, repository: REPOSITORY }],
	];
	for (const [pollDelivery, eventName, webhookPayload] of twins) {
		const verdict = filter(eventName, parseSubset(webhookPayload), cfg, SELF, `wh-${pollDelivery}`, true);
		assert.equal(verdict.enqueue, true, `the webhook twin of ${pollDelivery} must clear the gate`);
		const polled = byDelivery.get(pollDelivery);
		assert.ok(polled, `the poller must have enqueued ${pollDelivery} (got ${[...byDelivery.keys()].join(", ")})`);
		assert.deepEqual(stripDelivery(polled), stripDelivery(verdict.job), `${pollDelivery}: enqueue payloads must match field-for-field`);
	}
	assert.equal(byDelivery.get("poll-e700").flow, "post-close");
	assert.equal(byDelivery.get("poll-e700").target.type, "issue");
	assert.equal(byDelivery.get("poll-e701").flow, "post-merge");
	assert.equal(byDelivery.get("poll-e701").target.type, "pull_request");

	// The resolver saw (repo, login) -- by username, the only key the endpoint takes -- once per close,
	// authenticated with the poller's OWN cached token, never a job credential.
	const lookups = collaboratorCalls(fetch);
	assert.deepEqual(
		lookups.map((c) => c.url),
		[
			"https://api.github.com/repos/o/r/collaborators/alice/permission",
			"https://api.github.com/repos/o/r/collaborators/alice/permission",
		],
	);
	assert.equal(lookups[0].headers.authorization, "Bearer poll-token");
	// The PR arm pays its object fetch ONCE per closed event.
	assert.equal(fetch.calls.filter((c) => c.url.endsWith("/repos/o/r/pulls/8")).length, 1, "the PR object is fetched once, only for the PR close");
});

test("an unauthorized closer is the filter's own drop, and the cursor advances -- a stranger's close never wedges the feed", async () => {
	const { queued, out, redis, fetch } = await runPoller({
		cycles: 3,
		routes: closeRoutes({
			events: [ghResponse(200, [EV698]), ghResponse(200, [EV700, EV698])],
			permission: [ghResponse(200, { permission: "read" })],
		}),
		fsDeps: CLOSE_FS,
	});
	assertNoRepoFailure(out);
	assert.equal(queued.length, 0, "read access cannot start a paid job");
	assert.ok(
		out.some((o) => o.event === "dropped" && o.reason === "closer-not-allowed" && o.delivery === "poll-e700"),
		"the refusal is the shared filter's verdict, observable per delivery",
	);
	assert.equal(redis.kv.get("poll:o/r:cursor:events"), "700", "the events cursor advances past the refused close");
	assert.equal(collaboratorCalls(fetch).length, 1, "cycle 3 does not refetch or re-resolve the already-advanced-past close");
});

test("an INDETERMINATE closer lookup fails the repo's cycle LOUDLY and the next cycle retries exactly that event", async () => {
	const { queued, out, redis, fetch } = await runPoller({
		cycles: 3,
		routes: closeRoutes({
			events: [ghResponse(200, [EV698]), ghResponse(200, [EV700, EV698])],
			permission: [ghResponse(500, { message: "boom" })],
		}),
		fsDeps: CLOSE_FS,
	});
	assert.equal(queued.length, 0, "no verdict, no spend");
	// The failure is SCOPED to the events feed (poll_close_gate_retry), never the whole repo: a
	// close-gate spell must not starve the comment and pull feeds, which run on their own cursors --
	// so the per-repo poll_repo_failed line must NOT appear for what is one feed holding one event.
	assertNoRepoFailure(out);
	const failures = out.filter((o) => o.event === "poll_close_gate_retry" && o.repo === "o/r" && o.delivery === "poll-e700");
	assert.equal(failures.length, 2, "cycles 2 and 3 each surface the outage instead of guessing an answer");
	assert.match(failures[0].reason, /indeterminate.*status-500/, "the reason names the lookup outcome, never the actor");
	assert.equal(redis.kv.get("poll:o/r:cursor:events"), "698", "the cursor stays BEFORE the event, so the retry resumes exactly there");
	assert.equal(collaboratorCalls(fetch).length, 2, "cycle 3 re-resolved exactly the failed close");
	assert.equal(redis.kv.get("poll:o/r:close-gate:poll-e700"), "2", "the retry counter is per event, in redis, so a restart cannot reset the bound");
	assert.equal(redis.ttls.get("poll:o/r:close-gate:poll-e700"), 24 * 3600, "the counter decays with the outage (~1 day), outside the touched cursor family");
	assert.ok(!out.some((o) => o.event === "poll_close_gate_gave_up"), "below the bound the poller never gives up");
	// The non-starvation pin: the comment feed still fetched on both post-arming cycles, spell
	// included (cycle 1 arms without a fetch) -- the scoped catch ends only the events feed, and
	// reverting it to a repo-wide throw drops this to zero.
	const commentFetches = fetch.calls.filter((c) => c.url.includes("/issues/comments"));
	assert.equal(commentFetches.length, 2, "a close-gate spell must not starve the repo's other feeds");
});

test("at the retry bound the close gate gives up LOUDLY: logged with the delivery, cursor advanced, nothing enqueued", async () => {
	const redis = fakeRedis();
	// Seed the counter one below the bound: 19 failed cycles already happened -- a real outage, not a blip.
	redis.kv.set("poll:o/r:close-gate:poll-e700", "19");
	const { queued, out, fetch } = await runPoller({
		cycles: 3,
		redis,
		routes: closeRoutes({
			events: [ghResponse(200, [EV698]), ghResponse(200, [EV700, EV698])],
			permission: [ghResponse(500, { message: "still down" })],
		}),
		fsDeps: CLOSE_FS,
	});
	// The give-up is deliberately NOT a repo failure: the cycle completes and the sources behind the
	// same cursor keep working. One close dropped loudly beats the whole repo wedged forever.
	assertNoRepoFailure(out);
	assert.ok(
		out.some((o) => o.event === "poll_close_gate_gave_up" && o.repo === "o/r" && o.delivery === "poll-e700" && o.reason === "status-500"),
		"the drop is said out loud with the delivery id an operator can act on",
	);
	assert.deepEqual(queued, [], "a close whose authority was never established must not spend");
	assert.equal(redis.kv.get("poll:o/r:cursor:events"), "700", "the cursor advances past the given-up close");
	assert.equal(collaboratorCalls(fetch).length, 1, "cycle 3 does not resurrect the given-up close");
});

test("no close rule armed: a closed event costs NOTHING -- the cycle is byte-identical to the unhandled-event path", async () => {
	// Default FS: the close-less trigger file. The twin run carries the SAME ids wearing an event this
	// poller has never handled, i.e. the pre-#231 do-nothing path, and every observable output -- log
	// lines, cycle stats, request traffic, cursors -- must be indistinguishable.
	const run = (cycle2Events) =>
		runPoller({
			cycles: 2,
			routes: [
				{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [EV698]), ghResponse(200, [...cycle2Events, EV698])] },
				{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [])] },
				{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [])] },
			],
		});
	const withCloses = await run([EV701, EV700]);
	const withInert = await run([{ ...EV701, event: "assigned" }, { ...EV700, event: "assigned" }]);
	assertNoRepoFailure(withCloses.out);
	assert.deepEqual(withCloses.queued, []);
	assert.equal(withCloses.fetch.calls.some((c) => c.url.includes("/collaborators/")), false, "zero permission traffic");
	assert.equal(withCloses.fetch.calls.some((c) => c.url.includes("/pulls/8")), false, "zero PR fetches for the closed PR");
	assert.deepEqual(withCloses.out, withInert.out, "log and stat output identical to a run where the closes were any unhandled event");
	assert.deepEqual(
		withCloses.fetch.calls.map((c) => c.url),
		withInert.fetch.calls.map((c) => c.url),
		"request traffic identical too",
	);
});

test("arming replay safety: closes fetched on the arming cycle set the high-water mark and enqueue NOTHING", async () => {
	const { queued, out, redis, fetch } = await runPoller({
		cycles: 2,
		routes: closeRoutes({ events: [ghResponse(200, [EV701, EV700])] }),
		fsDeps: CLOSE_FS,
	});
	assertNoRepoFailure(out);
	assert.ok(
		out.some((o) => o.event === "poll_armed" && o.endpoint === "events" && o.cursor === 701),
		"the backlog's closes arm the cursor, exactly as the labeled source pins it",
	);
	assert.deepEqual(queued, [], "a close from before arming was an approval for THAT moment, not a standing order");
	assert.equal(collaboratorCalls(fetch).length, 0, "pre-arm closes cost no lookup");
	assert.equal(fetch.calls.filter((c) => c.url.endsWith("/repos/o/r/pulls/8")).length, 0, "and no PR fetch");
	assert.equal(redis.kv.get("poll:o/r:cursor:events"), "701");
});

test("self-closer: the harness closing its own issue costs no lookup and starts no job", async () => {
	// The natural last act of the very flow a close trigger arms. wantsCloserAuthority refuses the
	// lookup before it is spent; the shared filter's bot-loop guard makes the drop observable.
	const selfClose = { id: 702, event: "closed", actor: { id: SELF, login: "pi-bot" }, issue: ISSUE20 };
	const { queued, out, fetch } = await runPoller({
		cycles: 2,
		routes: closeRoutes({ events: [ghResponse(200, [EV698]), ghResponse(200, [selfClose, EV698])] }),
		fsDeps: CLOSE_FS,
	});
	assertNoRepoFailure(out);
	assert.equal(collaboratorCalls(fetch).length, 0, "no permission traffic for a self-close");
	assert.deepEqual(queued, []);
	assert.ok(out.some((o) => o.event === "dropped" && o.reason === "self" && o.delivery === "poll-e702"), "the drop is the filter's own `self` verdict");
});

test("a closed event with NO issue field is skipped without throwing, and the cursor advances past it", async () => {
	const noIssue = { id: 703, event: "closed", actor: { id: 5, login: "alice" } };
	const { queued, out, redis, fetch } = await runPoller({
		cycles: 2,
		routes: closeRoutes({ events: [ghResponse(200, [EV698]), ghResponse(200, [noIssue, EV698])] }),
		fsDeps: CLOSE_FS,
	});
	assertNoRepoFailure(out);
	assert.deepEqual(queued, []);
	assert.equal(collaboratorCalls(fetch).length, 0);
	assert.equal(redis.kv.get("poll:o/r:cursor:events"), "703", "a malformed entry advances past like any unhandled event");
});

test("non-close sources never take the authority path, even with close rules armed", async () => {
	// wantsCloserAuthority is false for them by construction -- this pins it end-to-end: a labeled
	// event under a file that ALSO arms close rules fires its label job with zero permission traffic.
	const labeled = { ...EV201, id: 705 };
	const { queued, out, fetch } = await runPoller({
		cycles: 2,
		routes: closeRoutes({ events: [ghResponse(200, [EV698]), ghResponse(200, [labeled, EV698])] }),
		fsDeps: CLOSE_FS,
	});
	assertNoRepoFailure(out);
	assert.equal(queued.length, 1, "the label rule fires as it always has");
	assert.equal(queued[0].trigger.deliveryId, "poll-e705");
	assert.equal(queued[0].flow, "fix");
	assert.equal(collaboratorCalls(fetch).length, 0, "no lookup rides along with a labeled event");
});

// ---------------------------------------------------------------------------------------------------
// Failure isolation and repo discovery
// ---------------------------------------------------------------------------------------------------

test("one repo's API error skips that repo for the cycle and never stalls the others", async () => {
	const routes = [
		{ path: "/repos/o/a/issues/events", replies: [ghResponse(500, { message: "boom" })] },
		{ path: "/repos/o/b/issues/events", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/b/pulls?state=open", replies: [ghResponse(200, [])] },
	];
	const { out, fetch } = await runPoller({ env: { POLL_REPOS: "o/a,o/b" }, cycles: 1, routes });
	assert.ok(
		out.some((o) => o.event === "poll_repo_failed" && o.repo === "o/a" && /HTTP 500/.test(o.reason)),
		"the failure is logged with the repo and the status",
	);
	assert.ok(fetch.calls.some((c) => c.url.includes("/repos/o/b/pulls")), "o/b still polled all its endpoints");
	assert.equal(out.filter((o) => o.event === "poll_cycle").length, 1, "the cycle completes and summarizes");
});

test("GITHUB_AUTH_SOURCE=app with no POLL_REPOS discovers the installation's repositories and polls them", async () => {
	const env = { GITHUB_AUTH_SOURCE: "app", GITHUB_APP_ID: "7", GITHUB_APP_INSTALLATION_ID: "11", GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem" };
	const routes = [
		{ path: "/installation/repositories", replies: [ghResponse(200, { total_count: 2, repositories: [{ full_name: "o/a" }, { full_name: "o/b" }] })] },
		{ path: "/repos/o/a/issues/events", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/a/pulls?state=open", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/b/issues/events", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/b/pulls?state=open", replies: [ghResponse(200, [])] },
	];
	const { out, fetch } = await runPoller({ env, cycles: 1, routes });
	assert.ok(fetch.calls[0].url.includes("/installation/repositories"), "discovery runs before any repo poll");
	assert.ok(out.some((o) => o.event === "poll_repos_discovered" && o.repos === 2));
	for (const repo of ["o/a", "o/b"]) {
		assert.ok(fetch.calls.some((c) => c.url.includes(`/repos/${repo}/issues/events`)), `${repo} is polled`);
	}
});

test("an inline App key mints the poll token without touching the filesystem (issue #208)", async () => {
	// No tokenFn here: this drives the REAL makeAppInstallationTokenFn, which is the only place the
	// receiver reads the key. `readFile` throws, so a deployment with no key file on disk proves it.
	// A REAL key: the receiver signs an App JWT with it, so a fixture string only proves the crypto
	// rejects a fixture string. Generated here rather than at module scope -- one test needs it.
	const { privateKey: PEM } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
	const env = { GITHUB_AUTH_SOURCE: "app", GITHUB_APP_ID: "7", GITHUB_APP_INSTALLATION_ID: "11", GITHUB_APP_PRIVATE_KEY: PEM, POLL_REPOS: "o/a" };
	const routes = [
		{ path: "/app/installations/11/access_tokens", replies: [ghResponse(201, { token: "ghs_polled" })] },
		{ path: "/repos/o/a/issues/events", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/a/pulls?state=open", replies: [ghResponse(200, [])] },
	];
	const fetchFn = fakeFetch(routes);
	// The injected sleep runs INSIDE startPoller, before its binding settles, so it cannot reach for
	// `poller.stop()` the way runPoller does. It parks forever instead; stop() below is seen by the
	// loop's own `if (stopped) break` at the end of cycle one, so the delay is never reached.
	const never = new Promise(() => {});
	const poller = await startPoller(env, {
		fetchFn,
		redis: fakeRedis(),
		queueFn: async () => {},
		out: () => {},
		now: () => NOW,
		random: () => 0.5,
		selfIdFn: async () => SELF,
		readFile: async () => assert.fail("an inline key must never send the receiver to the filesystem"),
		fsDeps: FS,
		sleep: () => never,
	});
	poller.stop();
	await poller.done;
	const mint = fetchFn.calls.find((c) => c.url.includes("/access_tokens"));
	assert.ok(mint, "the installation token was minted from the inline key");
	assert.equal(mint.method, "POST");
	assert.match(mint.headers.authorization, /^Bearer /, "signed as an App JWT built from the key we supplied");
});

test("zero repos from discovery fails loud at boot, naming both mechanisms", async () => {
	const env = { GITHUB_AUTH_SOURCE: "app", GITHUB_APP_ID: "7", GITHUB_APP_INSTALLATION_ID: "11", GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem" };
	const routes = [{ path: "/installation/repositories", replies: [ghResponse(200, { total_count: 0, repositories: [] })] }];
	await assert.rejects(
		startPoller(env, {
			fetchFn: fakeFetch(routes),
			redis: fakeRedis(),
			queueFn: async () => assert.fail("nothing may enqueue"),
			out: () => {},
			now: () => NOW,
			selfIdFn: async () => SELF,
			tokenFn: async () => "poll-token",
			fsDeps: FS,
			sleep: async () => assert.fail("the loop must never start"),
		}),
		(e) => e.piDispatchConfig === true && /POLL_REPOS/.test(e.message),
		"an empty roster must refuse to start, not report healthy cycles forever",
	);
});

// ---------------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------------

test("POLL_REPOS parsing: trim, dedupe, owner/name validation, and the no-repos-no-app refusal", () => {
	const cfg = loadPollerConfig({ POLL_REPOS: " o/a , o/b ,o/a " }, FS);
	assert.deepEqual(cfg.repos, ["o/a", "o/b"], "trimmed and deduped, in order");
	assert.equal(cfg.intervalSeconds, 60);
	assert.ok(!("webhookSecret" in cfg), "the placeholder secret must never escape the loader");

	assert.throws(() => loadPollerConfig({ POLL_REPOS: "not-a-repo" }, FS), (e) => e.piDispatchConfig === true);
	assert.throws(() => loadPollerConfig({ POLL_REPOS: " , " }, FS), (e) => e.piDispatchConfig === true);
	// Unset + a non-app source names BOTH mechanisms in the refusal.
	assert.throws(() => loadPollerConfig({}, FS), (e) => e.piDispatchConfig === true && /POLL_REPOS/.test(e.message) && /app/.test(e.message));
	// Unset + app source defers to installation discovery.
	const appCfg = loadPollerConfig({ GITHUB_AUTH_SOURCE: "app", GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2", GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem" }, FS);
	assert.equal(appCfg.repos, null);
});

test("POLL_INTERVAL_SECONDS: default 60, floored at 30 so a typo cannot hammer the API", () => {
	assert.equal(loadPollerConfig({ POLL_REPOS: "o/r", POLL_INTERVAL_SECONDS: "5" }, FS).intervalSeconds, 30);
	assert.equal(loadPollerConfig({ POLL_REPOS: "o/r", POLL_INTERVAL_SECONDS: "90" }, FS).intervalSeconds, 90);
	assert.throws(() => loadPollerConfig({ POLL_REPOS: "o/r", POLL_INTERVAL_SECONDS: "x" }, FS), (e) => e.piDispatchConfig === true);
});

test("POLL_CATCHUP_MINUTES: default 60, 0 allowed as never, no ceiling at the loader, junk refuses (#880)", () => {
	assert.equal(loadPollerConfig({ POLL_REPOS: "o/r" }, FS).catchUpMinutes, 60);
	assert.equal(loadPollerConfig({ POLL_REPOS: "o/r", POLL_CATCHUP_MINUTES: "" }, FS).catchUpMinutes, 60);
	assert.equal(loadPollerConfig({ POLL_REPOS: "o/r", POLL_CATCHUP_MINUTES: "0" }, FS).catchUpMinutes, 0);
	assert.equal(loadPollerConfig({ POLL_REPOS: "o/r", POLL_CATCHUP_MINUTES: " 45 " }, FS).catchUpMinutes, 45);
	assert.equal(loadPollerConfig({ POLL_REPOS: "o/r", POLL_CATCHUP_MINUTES: "100000" }, FS).catchUpMinutes, 100000, "the poller clamps it at the cursor TTL, where it means the same");
	for (const junk of ["x", "-1", "1.5", "60m"]) {
		assert.throws(
			() => loadPollerConfig({ POLL_REPOS: "o/r", POLL_CATCHUP_MINUTES: junk }, FS),
			(e) => e.piDispatchConfig === true && /POLL_CATCHUP_MINUTES/.test(e.message),
			junk,
		);
	}
});

test("GITHUB_INGEST: webhook refuses poll at boot naming both ways on; poll, both and unset start it (issue #879)", () => {
	assert.throws(
		() => loadPollerConfig({ POLL_REPOS: "o/r", GITHUB_INGEST: "webhook" }, FS),
		(e) => e.piDispatchConfig === true && /GITHUB_INGEST=webhook/.test(e.message) && /GITHUB_INGEST=both/.test(e.message) && /poll to poll only/.test(e.message),
		"a webhook-only deployment is never polled by accident, and the refusal says how to poll on purpose",
	);
	for (const ingest of [undefined, "", "poll", "both"]) {
		const env = { POLL_REPOS: "o/r", ...(ingest === undefined ? {} : { GITHUB_INGEST: ingest }) };
		assert.deepEqual(loadPollerConfig(env, FS).repos, ["o/r"], `GITHUB_INGEST=${ingest}`);
	}
	// A word outside the three refuses here as it does for serve: one parse, so the two commands cannot disagree on it.
	assert.throws(() => loadPollerConfig({ POLL_REPOS: "o/r", GITHUB_INGEST: "pol" }, FS), (e) => e.piDispatchConfig === true && /GITHUB_INGEST must be/.test(e.message));
	// `both` routes serve's secret requirement through as ever: an absent secret is papered over for this call only.
	assert.ok(!("webhookSecret" in loadPollerConfig({ POLL_REPOS: "o/r", GITHUB_INGEST: "both" }, FS)));
});

test("WEBHOOK_SECRET: not required for poll, still required for serve", () => {
	// The poller has nothing to verify -- its credential authenticates the other direction -- so the
	// same env that boots poll must still refuse to boot serve.
	const env = { POLL_REPOS: "o/r" };
	assert.doesNotThrow(() => loadPollerConfig(env, FS));
	assert.throws(() => loadReceiverConfig(env, FS), /WEBHOOK_SECRET/);
});

// ---------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------

test("cli: `poll` dispatches to startPoller with the bin's env, and --help names the command", async () => {
	const calls = [];
	const fake = async (env) => {
		calls.push(env);
		return { stop() {}, done: Promise.resolve() };
	};
	const env = { POLL_REPOS: "o/r" };
	assert.equal(await main(["poll"], env, { startPoll: fake }), 0);
	assert.equal(calls[0], env, "the poller boots from the env main was handed, never an ambient process.env");

	const { result, out } = await withStdout((write) =>
		main(["--help"], {}, {
			write,
			start: async () => assert.fail("help must not boot the receiver"),
			startPoll: async () => assert.fail("help must not boot the poller"),
		}),
	);
	assert.equal(result, 0);
	assert.match(out, /pi-dispatch-receiver poll/);
	assert.match(out, /POLL_REPOS/, "usage names where poll's config comes from, so help is actionable");
});

// ---------------------------------------------------------------------------------------------------
// The transient-boot retry (issue #318): the poller's identity gate is the same hard-fail gate serve
// has, so it retries under the same window -- a pure-polling deployment loses work to a stopped
// process just as surely as a webhook one.
// ---------------------------------------------------------------------------------------------------

const EMPTY_POLL_ROUTES = () => [
	{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [])] },
	{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [])] },
	{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [])] },
];

test("the poller's boot gate retries a transient identity failure, then the loop starts (issue #318)", async () => {
	const out = [];
	const sleeps = [];
	const clock = { ms: NOW };
	let idCalls = 0;
	let poller;
	poller = await startPoller({ POLL_REPOS: "o/r" }, {
		fetchFn: fakeFetch(EMPTY_POLL_ROUTES()),
		redis: fakeRedis(),
		queueFn: async () => {},
		out: (obj) => out.push(obj),
		now: () => clock.ms,
		random: () => 0.5,
		selfIdFn: async () => {
			idCalls++;
			if (idCalls === 1) throw new Error("connect ECONNREFUSED 10.0.0.5:443");
			return SELF;
		},
		tokenFn: async () => "poll-token",
		fsDeps: FS,
		// The retry's sleep arrives while `poller` is still unassigned (boot has not returned), so the
		// optional stop() below is a no-op for it; the first CYCLE sleep then stops the loop.
		sleep: async (ms) => {
			sleeps.push(ms);
			clock.ms += ms;
			poller?.stop();
		},
	});
	await poller.done;
	assert.equal(idCalls, 2, "the transient failure was retried, once, and the second answer stood");
	assert.equal(sleeps[0], 5_000, "the first recorded sleep is the retry gap -- it ran BEFORE any cycle");
	assert.ok(out.some((l) => l.event === "identity_retry" && l.forge === "github"), "the retry says so on the wire");
	assert.ok(out.some((l) => l.event === "self_identity" && l.id === SELF));
	assert.ok(out.some((l) => l.event === "poll_cycle"), "and the loop really started afterwards");
});

test("the poller's getAuth re-invokes makeAuth on retry: the cache memoizes SUCCESS, never failure (issue #318)", async () => {
	// `auth ??= await makeAuth(...)` assigns only when the mint RESOLVES. Caching the PROMISE instead
	// would memoize the first failure and turn the retry loop into a rethrow spinner -- this is the test
	// the source comment in poller.mjs points at.
	let mints = 0;
	const out = [];
	const clock = { ms: NOW };
	let poller;
	poller = await startPoller({ POLL_REPOS: "o/r" }, {
		fetchFn: fakeFetch(EMPTY_POLL_ROUTES()),
		redis: fakeRedis(),
		queueFn: async () => {},
		out: (obj) => out.push(obj),
		now: () => clock.ms,
		random: () => 0.5,
		makeAuth: async () => {
			mints++;
			if (mints === 1) throw new Error("gh answered 502 mid-restart");
			return { selfId: SELF, source: "gh", mintToken: async () => "poll-token" };
		},
		tokenFn: async () => "poll-token",
		fsDeps: FS,
		sleep: async (ms) => {
			clock.ms += ms;
			poller?.stop();
		},
	});
	await poller.done;
	assert.equal(mints, 2, "the retry re-invoked makeAuth instead of rethrowing a cached failure");
	assert.ok(out.some((l) => l.event === "self_identity" && l.id === SELF));
});

test("a tagged identity refusal stops the poller boot same-tick: no sleep, no loop (issue #318)", async () => {
	const sleeps = [];
	await assert.rejects(
		startPoller({ POLL_REPOS: "o/r" }, {
			fetchFn: async () => assert.fail("the loop must never start on a determinate refusal"),
			redis: fakeRedis(),
			queueFn: async () => {},
			out: () => {},
			now: () => NOW,
			random: () => 0.5,
			selfIdFn: async () => {
				throw Object.assign(new Error("bad credential"), { piDispatchConfig: true });
			},
			tokenFn: async () => "t",
			fsDeps: FS,
			sleep: async (ms) => sleeps.push(ms),
		}),
		(e) => e.piDispatchConfig === true,
	);
	assert.deepEqual(sleeps, [], "retrying a misconfiguration only hides the message");
});

test("loadPollerConfig passes the retry window THROUGH the receiver loader: one parse, one floor (issue #318)", () => {
	assert.equal(loadPollerConfig({ POLL_REPOS: "o/r" }, FS).identityRetryWindowMs, 600_000);
	assert.equal(loadPollerConfig({ POLL_REPOS: "o/r", RECEIVER_IDENTITY_RETRY_SECONDS: "10" }, FS).identityRetryWindowMs, 60_000, "the floor holds on the poll path too");
	assert.throws(() => loadPollerConfig({ POLL_REPOS: "o/r", RECEIVER_IDENTITY_RETRY_SECONDS: "x" }, FS), (e) => e.piDispatchConfig === true);
});

// ---------------------------------------------------------------------------------------------------
// Shutdown hygiene (issue #325): the poller's contract is "after `done`, the poller is gone", and an
// inter-cycle sleep that survives stop() is a ref'd timer holding the event loop for up to a full poll
// interval in any caller that stops the poller without exiting the process. Production's
// process.exit(0) masked it; these are the pins that close it.
// ---------------------------------------------------------------------------------------------------

test("cancellableSleep: cancel DESTROYS the armed timer, and an uncancelled one still sleeps", async () => {
	// async_hooks is the honest meter (the settleWithin pin's pattern): destroy fires for a cleared
	// timer a tick late, so the census settles across two setImmediates. The cancelled sleep is 1s so
	// a broken cancel cannot mask itself by firing between those ticks, and a mutant run lingers one
	// second, not thirty.
	const { createHook } = await import("node:async_hooks");
	const live = new Set();
	const hook = createHook({
		init(id, type) {
			if (type === "Timeout") live.add(id);
		},
		destroy(id) {
			live.delete(id);
		},
	});
	hook.enable();
	try {
		const before = new Set(live);
		const nap = cancellableSleep(1_000);
		nap.then(() => assert.fail("a cancelled sleep must never resolve"));
		nap.cancel();
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		assert.deepEqual([...live].filter((id) => !before.has(id)), [], "the cancelled timer must be DESTROYED, not merely orphaned");

		// The control, and the winning-side path in one: it really sleeps, and cancel on an
		// already-fired timer is a safe no-op (every normal cycle now clears a fired timer).
		const slept = cancellableSleep(5);
		await slept;
		slept.cancel();
	} finally {
		hook.disable();
	}
});

test("stop() while parked on the REAL default sleep: the race is won, the timer is cleared, nothing leaks (issue #325)", async () => {
	// The first test ever to exercise the stopWaker-wins path: runPoller's injected sleep resolves (the
	// SLEEP side wins its race), and the park-forever test above leaves through the loop's own
	// `if (stopped) break`, so neither could see a timer surviving stop() -- and neither could kill a
	// stop() that no longer wakes the race, which is what the 2s sentinel below is for (a no-wake
	// mutant waits out the real >=30s interval floor and loses to it).
	const { createHook } = await import("node:async_hooks");
	const live = new Set();
	const hook = createHook({
		init(id, type) {
			if (type === "Timeout") live.add(id);
		},
		destroy(id) {
			live.delete(id);
		},
	});
	const sigListeners = () => process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
	const sigBefore = sigListeners();
	hook.enable();
	// Declared OUTSIDE the try so the finally can always stop it: an assertion failing between boot
	// and stop() would otherwise leave a REAL-timer poller looping for the life of the test process.
	let poller;
	try {
		const before = new Set(live);
		const liveDelta = () => [...live].filter((id) => !before.has(id));
		let parked;
		const cycleSeen = new Promise((resolve) => (parked = resolve));
		poller = await startPoller({ POLL_REPOS: "o/r" }, {
			fetchFn: fakeFetch(EMPTY_POLL_ROUTES()),
			redis: fakeRedis(),
			queueFn: async () => {},
			out: (obj) => {
				if (obj.event === "poll_cycle") parked();
			},
			now: () => NOW,
			random: () => 0.5,
			selfIdFn: async () => SELF,
			tokenFn: async () => "poll-token",
			fsDeps: FS,
			// NO sleep key: the REAL cancellableSleep default arms a real ref'd timer (the interval is
			// the real floored >=30s; this test never waits it out). signals: false is what makes that
			// armable under test at all -- without the seam, the real default came bundled with real
			// process-wide SIGTERM/SIGINT handlers.
			signals: false,
		});
		await cycleSeen;
		// Drain the destroy queue BEFORE counting: with every fake resolving on the microtask queue,
		// the whole boot-to-park burst runs inside one macrotask, and a cleared timer's destroy (the
		// boot gate's identity fuse here) is only processed on an event-loop turn -- "destroy fires a
		// tick late" means a MACROTASK, measured: sampled without this, the long-cleared fuse still
		// counted as live and this assertion read 2.
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		// The stretch from the poll_cycle line to sleepFn(delayMs) is SYNCHRONOUS, so the timer was
		// armed before the first microtask above ran. Exactly one: the anti-vacancy guard -- a
		// refactor that reaches `break` instead of the race would make the leak assertions below
		// vacuously green.
		assert.equal(liveDelta().length, 1, "the loop is PARKED on one armed real timer");

		poller.stop();
		const sentinel = cancellableSleep(2_000);
		const winner = await Promise.race([poller.done.then(() => "done"), sentinel.then(() => "stuck")]);
		sentinel.cancel();
		assert.equal(winner, "done", "stop() must win the race promptly -- a stop that no longer wakes waits out the full interval");

		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		assert.deepEqual(liveDelta(), [], "after `done`, no timer armed by the poller remains (the acceptance, verbatim)");
		assert.equal(sigListeners(), sigBefore, "the real default armed WITHOUT process-wide handlers leaking across tests");
	} finally {
		poller?.stop();
		await poller?.done.catch(() => {});
		hook.disable();
	}
});

test("the inter-cycle race rides the cancellable sleep, and the signal gate is its own seam (source pin)", () => {
	const src = readFileSync(new URL("../src/poller.mjs", import.meta.url), "utf8");
	assert.match(src, /const nap = sleepFn\(delayMs\);/, "the race must HOLD its sleep, or there is nothing to clear");
	assert.match(src, /nap\.cancel\?\.\(\);/, "the loser is cancelled whichever side settles");
	assert.match(src, /signals = sleep === undefined,/, "the production default keeps handlers on real runs -- cli.mjs passes no deps");
	assert.ok(!/await Promise\.race\(\[sleepFn\(delayMs\), stopWaker\]\);/.test(src), "the bare leaking race must stay gone");
	assert.ok(!src.includes("if (sleep === undefined) {"), "the gate reads the seam, not the sleep's undefined-ness");
	// The ref stays: between cycles this timer is the only thing holding a pure-poll process open
	// (cli.mjs awaits `done`), so an unref here is a poller that can exit mid-wait. Load-bearing, not
	// style.
	assert.ok(!/\.unref\(/.test(src), "the inter-cycle timer must stay REF'D");
});

test("a rejecting sleep still propagates through the cancel finally (issue #325)", async () => {
	// The review pass measured this and left it unpinned; pinned here so it stays true: the
	// `finally { nap.cancel?.(); }` around the race must never swallow or replace a rejecting
	// sleep -- a broken sleep is a loud loop death surfacing through `done`, not a silent wedge.
	let calls = 0;
	const boom = new Error("sleep exploded");
	const poller = await startPoller({ POLL_REPOS: "o/r" }, {
		fetchFn: fakeFetch(EMPTY_POLL_ROUTES()),
		redis: fakeRedis(),
		queueFn: async () => {},
		out: () => {},
		now: () => NOW,
		random: () => 0.5,
		selfIdFn: async () => SELF,
		tokenFn: async () => "poll-token",
		fsDeps: FS,
		sleep: async () => {
			calls++;
			throw boom;
		},
	});
	await assert.rejects(poller.done, (e) => e === boom, "the SAME error object, not a wrapper and not a swallow");
	assert.equal(calls, 1, "the first inter-cycle sleep is what exploded");
});

test("poller: a semantic-window swallow is its own out-line with the survivor, and `enqueued` counts only created (issue #289)", async () => {
	// Every enqueue answers the dedup shape: nothing is created, so no `enqueued` line may claim
	// otherwise, and each swallow names the job that answered instead.
	const queued = [];
	const { out } = await runPoller({
		cycles: 3,
		routes: scenarioRoutes(),
		queueFn: async (job) => {
			queued.push(job);
			return { jobId: `computed-${queued.length}`, deduplicated: true, survivingJobId: "the-survivor" };
		},
	});
	assertNoRepoFailure(out);
	assert.ok(queued.length > 0, "the scenario really enqueued (this test would be vacuous otherwise)");
	assert.ok(!out.some((l) => l.event === "enqueued"), "enqueued means created, and nothing was");
	const dedup = out.filter((l) => l.event === "deduplicated");
	assert.equal(dedup.length, queued.length, "one line per swallow");
	assert.ok(dedup.every((l) => l.survivingJobId === "the-survivor" && typeof l.jobId === "string"));
});

test("poller: a swallow's line says whether its owner ended and names the notice, or that adding it failed (issue #932)", async () => {
	const answers = [
		{ survivor: "ended", notice: "gh-poll-e1-dup" },
		{ survivor: "live" },
		{ survivor: "ended", noticeFailed: true },
		{ survivor: "bogus", notice: 7, noticeFailed: "yes" },
	];
	const queued = [];
	const { out } = await runPoller({
		cycles: 3,
		routes: scenarioRoutes(),
		queueFn: async (job) => {
			queued.push(job);
			return { jobId: `computed-${queued.length}`, deduplicated: true, survivingJobId: "the-survivor", ...answers[(queued.length - 1) % answers.length] };
		},
	});
	assertNoRepoFailure(out);
	const dedup = out.filter((l) => l.event === "deduplicated");
	assert.ok(dedup.length >= answers.length, "the scenario swallowed enough deliveries to see every answer");
	const facts = dedup.slice(0, answers.length).map(({ survivor, notice, noticeFailed }) => ({ survivor, notice, noticeFailed }));
	assert.deepEqual(facts, [
		{ survivor: "ended", notice: "gh-poll-e1-dup", noticeFailed: undefined },
		{ survivor: "live", notice: undefined, noticeFailed: undefined },
		{ survivor: "ended", notice: undefined, noticeFailed: true },
		{ survivor: undefined, notice: undefined, noticeFailed: undefined },
	], "only the shapes the queue answers are logged");
});

// ---------------------------------------------------------------------------------------------------
// The triggers file, followed while the poller runs (issue #947)
// ---------------------------------------------------------------------------------------------------

// The file every scenario boots on, and the rules its edits add. Indices are raw-file positions, so an appended rule
// leaves the label rule at 0 and the comment rule at 1.
const FOLLOW_RULES = [
	{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix" } },
	{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "triage" } },
];
const followText = (...extra) => JSON.stringify({ triggers: [...FOLLOW_RULES, ...extra] });
const BENCH_RULE = { on: { type: "label", any: ["pi:bench"] }, run: { kind: "github", flow: "bench" } };
const ISSUE11 = { number: 11, title: "T11", body: "B11", labels: [{ name: "pi:bench" }] };
const EV210 = { id: 210, event: "labeled", actor: { id: 5 }, label: { name: "pi:bench" }, issue: ISSUE11 };
const EV203 = { ...EV201, id: 203 };
// Issue #970's entry: a cron trigger with neither run.flow nor run.command, which every reader of the file refuses.
const PROBE_CRON = { on: { type: "cron", id: "probe", pattern: "0 4 3 1 *" }, run: { kind: "local", folder: "/srv/probe", task: "probe" } };

/** A triggers file the test edits while the poller runs: every read answers `file.text`, and `null` is no file. */
function liveFile(text) {
	const file = { text };
	file.deps = {
		fileExists: () => file.text !== null,
		readFile: () => {
			if (file.text === null) throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
			return file.text;
		},
	};
	return file;
}

/** A label feed: the arming cycle sees EV100 alone, each later cycle the next reply (the last repeats). */
function labelRoutes(...later) {
	return [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [EV100]), ...later] },
		{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [])] },
	];
}

const jobsOf = (queued) => queued.map((j) => [j.trigger.deliveryId, j.flow]);

test("a label trigger added while the poller runs is queued at its next cycle, with one triggers_reloaded (issue #947)", async () => {
	const file = liveFile(followText());
	const { queued, out } = await runPoller({
		cycles: 2,
		fsDeps: file.deps,
		routes: labelRoutes(ghResponse(200, [EV210, EV100])),
		nap: (ms, n) => {
			if (n === 1) file.text = followText(BENCH_RULE);
			return ms;
		},
	});
	assertNoRepoFailure(out);
	assert.deepEqual(jobsOf(queued), [["poll-e210", "bench"]], "the rule added after the start fires, where the boot copy dropped it as no-allowlisted-label");
	assert.deepEqual(lines(out, "dropped"), []);
	assert.equal(lines(out, "triggers_reloaded").length, 1, "one line for the one edit");
	assert.ok(out.findIndex((o) => o.event === "triggers_reloaded") > out.findIndex((o) => o.event === "poll_cycle"), "and it is the edit's: a quiet boot reloads nothing");
});

test("an edit made while the boot resolves its identity (a gate that may retry for minutes) is taken at the first cycle (issue #947)", async () => {
	const file = liveFile(followText());
	const { queued, out } = await runPoller({
		cycles: 2,
		fsDeps: file.deps,
		routes: labelRoutes(ghResponse(200, [EV210, EV100])),
		selfIdFn: async () => {
			file.text = followText(BENCH_RULE);
			return SELF;
		},
	});
	assertNoRepoFailure(out);
	assert.equal(lines(out, "triggers_reloaded").length, 1, "the boot copy is not taken for the file");
	assert.ok(out.findIndex((o) => o.event === "triggers_reloaded") < out.findIndex((o) => o.event === "poll_cycle"), "taken before the first cycle judges anything");
	assert.deepEqual(jobsOf(queued), [["poll-e210", "bench"]]);
});

test("the follower's baseline is the boot load's own read: a file that differs from it afterwards is served in the first cycle (issue #947)", async () => {
	// The boot load is the first read; every later read is the edited file. A baseline read anywhere after the boot load
	// would already hold the edit, so the first cycle would judge on the boot copy and say nothing.
	let reads = 0;
	const fsDeps = { fileExists: () => true, readFile: () => (reads++ === 0 ? followText() : followText(BENCH_RULE)) };
	const redis = fakeRedis();
	seedFamily(redis, 60);
	const { queued, out } = await runPoller({ redis, fsDeps, routes: eventRoutes([EV210, EV100]) });
	assertNoRepoFailure(out);
	assert.equal(lines(out, "poll_resumed").length, 1, "the premise: a resumed family, so the one cycle judges events");
	assert.deepEqual(jobsOf(queued), [["poll-e210", "bench"]], "the edit is served in the first cycle");
	assert.equal(lines(out, "triggers_reloaded").length, 1);
});

test("an edit landing between a cycle's fetch and its judgement is judged on the edit, for a label event and a comment (issue #947)", async () => {
	// The events reply carries the edit, after the cycle's own read: the event is fetched on one file, judged on the next.
	const labelFile = liveFile(followText());
	const label = await runPoller({
		cycles: 2,
		fsDeps: labelFile.deps,
		routes: labelRoutes(() => {
			labelFile.text = followText(BENCH_RULE);
			return ghResponse(200, [EV210, EV100]);
		}),
	});
	assertNoRepoFailure(label.out);
	assert.deepEqual(jobsOf(label.queued), [["poll-e210", "bench"]]);

	// A comment's issue is fetched after the comment feed, so the edit lands where only `gate`'s own read can see it.
	const commentFile = liveFile(followText());
	const retargeted = JSON.stringify({ triggers: [FOLLOW_RULES[0], { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "bench" } }] });
	const comment = await runPoller({
		cycles: 2,
		fsDeps: commentFile.deps,
		routes: [
			{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [EV100])] },
			{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [C301])] },
			{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [])] },
			{
				path: "/repos/o/r/issues/7",
				replies: [
					() => {
						commentFile.text = retargeted;
						return ghResponse(200, ISSUE7);
					},
				],
			},
		],
	});
	assertNoRepoFailure(comment.out);
	assert.deepEqual(jobsOf(comment.queued), [["poll-c301", "bench"]], "the comment runs the flow the file names when it is judged");
});

test("issue #970's edit, a cron trigger without run.flow, keeps the running rules with one line, and putting the file back says reloaded (issue #947)", async () => {
	const good = followText();
	const file = liveFile(good);
	const { queued, out } = await runPoller({
		cycles: 4,
		fsDeps: file.deps,
		routes: labelRoutes(ghResponse(200, [EV201, EV100])),
		nap: (ms, n) => {
			if (n === 1) file.text = followText(PROBE_CRON);
			if (n === 3) file.text = good;
			return ms;
		},
	});
	assertNoRepoFailure(out);
	assert.deepEqual(jobsOf(queued), [["poll-e201", "fix"]], "the label the running rules hold still fires while the file is refused");
	const invalid = lines(out, "triggers_reload_invalid");
	assert.equal(invalid.length, 1, "said once over the two cycles that read the refused text");
	assert.equal(invalid[0].kept, true);
	assert.match(invalid[0].reason, /run\.flow/, "the loader's own reason, naming the field");
	assert.equal(lines(out, "triggers_reloaded").length, 1);
	const at = (event) => out.flatMap((o, i) => (o.event === event ? [i] : []));
	const [reloaded] = at("triggers_reloaded");
	const cycleEnds = at("poll_cycle");
	assert.ok(at("triggers_reload_invalid")[0] < cycleEnds[1], "the refusal is said in the first cycle that reads it");
	assert.ok(reloaded > cycleEnds[2] && reloaded < cycleEnds[3], "and the good file back is a change, said in the cycle that reads it");
});

test("an edited mayMerge trigger queues the edit's digest, which the pickup check accepts, and withdrawing mayMerge withdraws it from the job (issue #947)", async () => {
	const doc = (run) => JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix", ...run } }] });
	const edited = doc({ mayMerge: true, instructions: "Second." });
	const withdrawn = doc({ instructions: "Second." });
	const file = liveFile(doc({ mayMerge: true, instructions: "First." }));
	// Through the poller's own enqueue, so what is judged below is the job data a worker picks up.
	const stored = [];
	const queue = { add: async (_name, data, opts) => (stored.push(JSON.parse(JSON.stringify(data))), { id: opts.jobId }) };
	const { out } = await runPoller({
		cycles: 3,
		fsDeps: file.deps,
		queueFn: (job) => enqueueGitHubJob(queue, job),
		routes: labelRoutes(ghResponse(200, [EV201, EV100]), ghResponse(200, [EV203, EV201, EV100])),
		nap: (ms, n) => {
			if (n === 1) file.text = edited;
			if (n === 2) file.text = withdrawn;
			return ms;
		},
	});
	assertNoRepoFailure(out);
	assert.deepEqual(jobsOf(stored), [["poll-e201", "fix"], ["poll-e203", "fix"]]);
	const [mayMergeJob, plainJob] = stored;
	assert.equal(mayMergeJob.mayMergePolicy, mergePolicyDigest(parseTriggers(edited, "/t.json")[0]), "the merge policy digest is the edited entry's, not the boot copy's");
	const check = makeCheckMergePolicy({ triggersPath: "/t.json", fs: { readFileSync: () => edited } });
	assert.deepEqual(check(mayMergeJob), { ok: true }, "so the worker's pickup check over the current file takes it (#947's merge-policy-changed refusal)");
	assert.equal("mayMerge" in plainJob, false, "a withdrawn permission is not carried by a later job");
	assert.equal("mayMergePolicy" in plainJob, false);
});

test("a close rule added mid-fetch decides whether that cycle's close is consumed, and reaches the resolver and the gate (issue #947)", async () => {
	const withClose = followText({ on: { type: "issue", action: ["closed"] }, run: { kind: "github", flow: "post-close" } });
	const file = liveFile(followText());
	const { queued, out, fetch } = await runPoller({
		cycles: 2,
		fsDeps: file.deps,
		routes: closeRoutes({
			events: [
				ghResponse(200, [EV698]),
				() => {
					file.text = withClose;
					return ghResponse(200, [EV700, EV698]);
				},
			],
		}),
	});
	assertNoRepoFailure(out);
	assert.deepEqual(jobsOf(queued), [["poll-e700", "post-close"]], "the close guard read the rule the edit added, so the close was not passed over");
	assert.equal(collaboratorCalls(fetch).length, 1, "the closer was looked up once, as an armed close rule asks");
});

test("one judgement reads one version: an edit landing during the closer's permission lookup waits for the next follow (issue #947)", async () => {
	// The lookup is the await between the authority test and the filter. The edit retargets the close rule's flow, so a
	// follow anywhere after the authority test would queue the job with a flow its authority was never asked for.
	const closeRule = (flow) => ({ on: { type: "issue", action: ["closed"] }, run: { kind: "github", flow } });
	const file = liveFile(followText(closeRule("post-close")));
	const { queued, out, fetch } = await runPoller({
		cycles: 3,
		fsDeps: file.deps,
		routes: closeRoutes({
			events: [ghResponse(200, [EV698]), ghResponse(200, [EV700, EV698])],
			permission: [
				() => {
					file.text = followText(closeRule("post-close-edited"));
					return ghResponse(200, { permission: "admin" });
				},
			],
		}),
	});
	assertNoRepoFailure(out);
	assert.equal(collaboratorCalls(fetch).length, 1, "the premise: the authority was asked, under the rule read before the lookup");
	assert.deepEqual(jobsOf(queued), [["poll-e700", "post-close"]], "the filter judged on the same version the authority test read");
	const at = (event) => out.findIndex((o) => o.event === event);
	assert.equal(lines(out, "triggers_reloaded").length, 1, "the edit is taken at the next follow");
	assert.ok(at("triggers_reloaded") > at("enqueued"), "after this judgement, not inside it");
});

test("a triggers file that goes missing keeps the running rules with one line, and its return says reloaded (issue #947)", async () => {
	const good = followText();
	const file = liveFile(good);
	const { queued, out } = await runPoller({
		cycles: 4,
		fsDeps: file.deps,
		routes: labelRoutes(ghResponse(200, [EV201, EV100])),
		nap: (ms, n) => {
			if (n === 1) file.text = null;
			if (n === 3) file.text = good;
			return ms;
		},
	});
	assertNoRepoFailure(out);
	assert.deepEqual(jobsOf(queued), [["poll-e201", "fix"]], "the rules the poller runs on outlive the file");
	const invalid = lines(out, "triggers_reload_invalid");
	assert.equal(invalid.length, 1);
	assert.equal(invalid[0].kept, true);
	assert.match(invalid[0].reason, /triggers file not found/);
	assert.equal(lines(out, "triggers_reloaded").length, 1);
	assert.ok(out.findIndex((o) => o.event === "triggers_reloaded") > out.indexOf(invalid[0]));
});

test("the poller starts on a file whose watch source's secret is unset and follows an edit that adds another, judging no watch secret (issues #947, #994)", async () => {
	// Only `serve` verifies watch pushes with a source's secret, so only it refuses one that is unset. The poller used to
	// refuse the file at its start (exit 2, not restarted) over a setting it never reads, and a source naming
	// WEBHOOK_SECRET passed only on the boot's placeholder, so its follow had to judge on the boot's environment.
	for (const secretEnv of ["WATCH_SIGNING", "WEBHOOK_SECRET"]) {
		const source = (name) => ({ [name]: { verify: "hmac-sha256", secretEnv, maxPerDay: 10 } });
		const doc = (sources, ...extra) => JSON.stringify({ watchSources: sources, triggers: [...FOLLOW_RULES, ...extra] });
		const file = liveFile(doc(source("prod")));
		const { queued, out } = await runPoller({
			cycles: 2,
			fsDeps: file.deps,
			routes: labelRoutes(ghResponse(200, [EV210, EV100])),
			nap: (ms, n) => {
				if (n === 1) file.text = doc({ ...source("prod"), ...source("alt") }, BENCH_RULE);
				return ms;
			},
		});
		assertNoRepoFailure(out);
		assert.deepEqual(lines(out, "triggers_reload_invalid"), [], secretEnv);
		assert.equal(lines(out, "triggers_reloaded").length, 1, secretEnv);
		assert.deepEqual(jobsOf(queued), [["poll-e210", "bench"]], `${secretEnv}: the edit was taken`);
	}
});

test("the poller follows the file by reading it, never through a watch (issue #947, source pin)", () => {
	// A watch needs a debounce timer, and no timer the poller arms may outlive `done` (the async_hooks test above) nor be
	// unref'd (the pin above); the header says why a read at each judgement is as fresh for a loop that judges only inside
	// its cycles. This keeps the reason in the loop's header.
	const src = readFileSync(new URL("../src/poller.mjs", import.meta.url), "utf8");
	assert.ok(!/\bwatch(File)?\s*\(/.test(src), "no fs.watch or fs.watchFile call");
	assert.ok(!/import\s*\{[^}]*\bwatch(File)?\b[^}]*\}\s*from\s*"node:fs/.test(src), "and no watch imported");
	assert.match(src, /THE TRIGGERS FILE IS FOLLOWED, NOT WATCHED \(issue #947\)/, "the header paragraph that says why");
	assert.match(src, /makeTriggersFollower\(/, "the follow is config.mjs's, the loader serve's watch reloads through");
});

const semanticValkeyUrl = process.env.VALKEY_TEST_URL;
if (!semanticValkeyUrl && process.env.PI_DISPATCH_REQUIRE_RECEIVER_TESTS === "1") throw new Error("the #899 poller integration requires VALKEY_TEST_URL");
const semanticSkip = semanticValkeyUrl ? false : "VALKEY_TEST_URL not set; poller semantic-window integration skipped";

/** A real old-worker result, deliberately finalized without the new worker's eager window release. */
async function semanticPollWorld(reason) {
	const { randomUUID } = await import("node:crypto");
	const { Queue, Worker } = await import("bullmq");
	const { parseConnection } = await import("@edgehero/pi-dispatch/connection");
	const { enqueueGitHubJob } = await import("@edgehero/pi-dispatch/queue");
	const connection = parseConnection(semanticValkeyUrl);
	const queue = new Queue(`poll-policy-${randomUUID()}`, { connection });
	const worker = new Worker(queue.name, null, { connection, autorun: false });
	const close = async () => {
		await worker.close();
		await queue.obliterate({ force: true }).catch(() => {});
		await queue.close();
	};
	try {
		const cfg = loadPollerConfig({ POLL_REPOS: "o/r" }, FS);
		const first = filter("issues", parseSubset({ action: "labeled", sender: { id: 5 }, issue: ISSUE7, repository: REPOSITORY }), cfg, SELF, "poll-e100");
		assert.equal(first.enqueue, true);
		await enqueueGitHubJob(queue, first.job);
		const active = await worker.getNextJob("original-token", { block: false });
		await active.moveToCompleted({ outcome: "policy", reason, budgetReserved: reason === "operator-cancel" }, "original-token", false);
		assert.equal(await queue.getDeduplicationJobId(active.deduplicationId), "gh-poll-e100", "the reproducer starts with the stale window still held");
		return { queue, worker, enqueue: (job, target = queue) => enqueueGitHubJob(target, job), close };
	} catch (error) {
		await close();
		throw error;
	}
}

function semanticPollRoutes(events) {
	return [
		{ path: "/repos/o/r/issues/events", replies: [ghResponse(200, [EV100]), ghResponse(200, events)] },
		{ path: "/repos/o/r/issues/comments", replies: [ghResponse(200, [])] },
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [])] },
	];
}

for (const reason of ["secret-bundle-trigger-changed", "operator-cancel"]) {
	test(`poller re-label after ${reason} enqueues a replacement and counts only the real survivor (#899)`, { skip: semanticSkip }, async () => {
		const world = await semanticPollWorld(reason);
		try {
			const { out, redis } = await runPoller({ cycles: 2, clock: { ms: Date.now() }, routes: semanticPollRoutes([{ ...EV201, id: 203 }, EV201, EV100]), queueFn: world.enqueue });
			assertNoRepoFailure(out);
			assert.deepEqual(out.filter((line) => line.event === "enqueued").map((line) => [line.delivery, line.replicas]), [["poll-e201", 1]]);
			assert.deepEqual(out.filter((line) => line.event === "deduplicated").map((line) => [line.delivery, line.survivingJobId]), [["poll-e203", "gh-poll-e201"]]);
			assert.deepEqual(out.filter((line) => line.event === "poll_cycle").map((line) => line.enqueued), [0, 1]);
			assert.equal(redis.kv.get("poll:o/r:cursor:events"), "203");
			const replacement = await world.worker.getNextJob("replacement-token", { block: false });
			assert.equal(replacement.id, "gh-poll-e201");
			await replacement.moveToCompleted({ outcome: "completed" }, "replacement-token", false);
		} finally {
			await world.close();
		}
	});
}

test("poller keeps the event cursor when semantic repair fails, then retries that label rather than losing it (#899)", { skip: semanticSkip }, async () => {
	const world = await semanticPollWorld("secret-bundle-trigger-changed");
	try {
		const client = await world.queue.client;
		let faults = 1;
		const faulted = {
			name: world.queue.name,
			toKey: world.queue.toKey.bind(world.queue),
			add: world.queue.add.bind(world.queue),
			client: Promise.resolve({ eval: (...args) => {
				if (faults-- > 0) throw new Error("semantic-read-unavailable");
				return client.eval(...args);
			} }),
		};
		const clock = { ms: Date.now() };
		const redis = fakeRedis({ clock });
		const cursors = [];
		const attempted = [];
		const { out } = await runPoller({
			cycles: 3, clock, redis, routes: semanticPollRoutes([EV201, EV100]),
			queueFn: (job) => { attempted.push(job.trigger.deliveryId); return world.enqueue(job, faulted); },
			nap: (ms) => { cursors.push(redis.kv.get("poll:o/r:cursor:events")); return ms; },
		});
		assert.deepEqual(attempted, ["poll-e201", "poll-e201"], "the failed event is offered again with the same delivery id");
		assert.deepEqual(cursors, ["100", "100", "201"], "no cursor advances past a failed repair");
		assert.deepEqual(out.filter((line) => line.event === "poll_repo_failed").map((line) => line.reason), ["semantic-read-unavailable"]);
		assert.deepEqual(out.filter((line) => line.event === "poll_cycle").map((line) => line.enqueued), [0, 0, 1]);
		assert.deepEqual(out.filter((line) => line.event === "deduplicated"), [], "a failed lookup is never reported as a handled duplicate");
		assert.deepEqual(out.filter((line) => line.event === "enqueued").map((line) => line.delivery), ["poll-e201"]);
		assert.ok(await world.queue.getJob("gh-poll-e201"));
	} finally {
		await world.close();
	}
});

// Issue #464 (gate round 3): the poller judges its Valkey before it builds its own clients, as the receiver does.
test("the poller judges VALKEY_URL before building its own Valkey clients, and a refusal stops it (#464)", async () => {
	const refusal = Object.assign(new Error("the Valkey VALKEY_URL reaches is refused"), { piDispatchConfig: true, valkeyRefused: true });
	let queues = 0;
	const base = { fetchFn: fakeFetch(EMPTY_POLL_ROUTES()), out: () => {}, now: () => NOW, random: () => 0.5, selfIdFn: async () => SELF, tokenFn: async () => "poll-token", fsDeps: FS, sleep: async () => {}, signals: false };
	// Settled either way, so a poller that starts after all is stopped and fails this test rather than running on.
	let started = null;
	const err = await startPollerReal({ POLL_REPOS: "o/r", VALKEY_URL: "redis://localhost:16583" }, {
		...base,
		makeQueueFn: () => (queues++, { close: async () => {} }),
		makeRedisFn: () => (queues++, fakeRedis()),
		judgeValkey: async (url) => {
			assert.equal(url, "redis://localhost:16583");
			throw refusal;
		},
	}).then(
		(p) => ((started = p), null),
		(e) => e,
	);
	if (started) {
		started.stop();
		await started.done.catch(() => {});
	}
	assert.equal(err, refusal, "the refusal stops the poller from starting");
	assert.equal(queues, 0, "no client of its own was built");
	// With its clients injected (a test's fakes), nothing of its own is built and nothing is judged.
	let judged = 0;
	const poller = await startPollerReal({ POLL_REPOS: "o/r" }, { ...base, redis: fakeRedis(), queueFn: async () => {}, judgeValkey: async () => judged++, sleep: async () => poller?.stop() });
	poller.stop();
	await poller.done.catch(() => {});
	assert.equal(judged, 0);
});

// ---------------------------------------------------------------------------------------------------
// The heartbeat (issue #970): what `pi-dispatch status` and Connections read of a running poller
// ---------------------------------------------------------------------------------------------------

const STATUS_ENV = { POLL_REPOS: "o/r", PI_WORKER_NAME: "mini1" };

/** Each heartbeat SET as it lands, with the mode and TTL it was given and the record parsed as a reader parses it. */
function recordingStatus(redis) {
	const beats = [];
	const set = redis.set.bind(redis);
	redis.set = async (key, value, mode, ttl) => {
		if (String(key).startsWith("poller:h:")) beats.push({ key, raw: value, record: parsePollerStatus(value), mode, ttl });
		return set(key, value, mode, ttl);
	};
	return beats;
}

test("the poller beats after its start, at each cycle's top and before each wait, and its record goes when it stops (issue #970)", async () => {
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	const beats = recordingStatus(redis);
	const { out, sleeps } = await runPoller({ env: STATUS_ENV, cycles: 2, clock, redis, routes: EMPTY_POLL_ROUTES() });
	assertNoRepoFailure(out);
	assert.deepEqual(lines(out, "poller_status_unavailable"), [], "every beat landed");
	assert.deepEqual(sleeps, [60_000, 60_000]);
	assert.ok(beats.every((b) => b.key === pollerKey("mini1") && b.record !== null), "one record, under the poller's own name, and readable");
	// The start's beat and each cycle's top carry the grace; the beat before each wait carries the wait plus the grace,
	// and says when the next cycle starts.
	assert.deepEqual(beats.map((b) => [b.mode, b.ttl, b.record.ttlMs, b.record.nextAt]), [
		["PX", POLLER_GRACE_MS, POLLER_GRACE_MS, null],
		["PX", POLLER_GRACE_MS, POLLER_GRACE_MS, null],
		["PX", 60_000 + POLLER_GRACE_MS, 60_000 + POLLER_GRACE_MS, NOW + 60_000],
		["PX", POLLER_GRACE_MS, POLLER_GRACE_MS, null],
		["PX", 60_000 + POLLER_GRACE_MS, 60_000 + POLLER_GRACE_MS, NOW + 120_000],
	]);
	assert.deepEqual(beats[2].record, { v: 1, name: "mini1", version: RECEIVER_VERSION, startedAt: NOW, at: NOW, ttlMs: 60_000 + POLLER_GRACE_MS, nextAt: NOW + 60_000, intervalSeconds: 60, repos: 1, triggers: "current", refusal: null, running: triggersDigest(TRIGGERS_JSON), rejected: null, rejectedAt: null });
	assert.equal(lines(out, "poller_started").length, 1);
	// Stopped: the record and its index entry are gone at once, not after the TTL.
	assert.equal(redis.kv.has(pollerKey("mini1")), false);
	assert.equal(redis.sets.get(POLLER_LIVE)?.has("mini1"), false);
	assert.deepEqual(redis.statusDels, [[pollerKey("mini1")]]);
});

test("an invalid edit makes the record say kept, with the refused text's digest and never its reason, and the file back says current (issue #970)", async () => {
	const good = followText();
	const bad = followText(PROBE_CRON);
	const file = liveFile(good);
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	const beats = recordingStatus(redis);
	const { out } = await runPoller({
		env: STATUS_ENV,
		cycles: 4,
		clock,
		redis,
		fsDeps: file.deps,
		routes: labelRoutes(ghResponse(200, [EV100])),
		nap: (ms, n) => {
			if (n === 1) file.text = bad;
			if (n === 2) file.text = null;
			if (n === 3) file.text = good;
			return ms;
		},
	});
	assertNoRepoFailure(out);
	assert.equal(lines(out, "triggers_reload_invalid").length, 2, "the refused text and the missing file, each said once");
	// Each cycle's top: the beat right after the follow.
	const tops = beats.filter((b) => b.record.nextAt === null).slice(1);
	assert.deepEqual(tops.map(({ record: r }) => [r.triggers, r.refusal, r.running, r.rejected, r.rejectedAt]), [
		["current", null, triggersDigest(good), null, null],
		["kept", "refused", triggersDigest(good), triggersDigest(bad), NOW + 60_000],
		["kept", "missing", triggersDigest(good), null, NOW + 120_000],
		["current", null, triggersDigest(good), null, null],
	]);
	for (const { raw } of beats) assert.doesNotMatch(raw, /run\.flow|probe|triggers\.json|srv/, "no reason, path or trigger text enters Valkey");
});

test("a rate-limited cycle's beat outlives its hour of sleep and says when it polls next, where a fixed TTL would read as no poller (issue #970)", async () => {
	const reset = NOW / 1000 + 3600;
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	const beats = recordingStatus(redis);
	const { out, sleeps } = await runPoller({
		env: STATUS_ENV,
		clock,
		redis,
		routes: [{ path: "/repos/o/r/issues/events", replies: [ghResponse(403, { message: "rate limited" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) })] }],
	});
	assert.equal(lines(out, "poll_rate_limited").length, 1);
	const [wait] = sleeps;
	assert.equal(wait, 3_600_000 + 15_500, "an hour to the reset, and the jitter");
	const before = beats.at(-1).record;
	assert.equal(before.nextAt, NOW + wait);
	assert.equal(before.ttlMs, wait + POLLER_GRACE_MS, "the record outlives the whole sleep by the grace");
	assert.ok(beats[0].record.ttlMs < wait, "the grace alone would have expired during it");
});

test("a heartbeat write that fails is said once per failure streak, without its error, while the cycles go on as before (issue #970)", async () => {
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	const set = redis.set.bind(redis);
	let writes = 0;
	redis.set = async (key, ...rest) => {
		// Every heartbeat write fails but the sixth (the third cycle's top): two streaks, the second one write long.
		if (String(key).startsWith("poller:h:") && ++writes !== 6) throw new Error("READONLY You can't write against a read only replica PRIVATE_DETAIL");
		return set(key, ...rest);
	};
	const { out, queued } = await runPoller({ env: STATUS_ENV, cycles: 3, clock, redis, routes: scenarioRoutes() });
	assertNoRepoFailure(out);
	assert.equal(writes, 7, "the start's beat, and three cycles of two");
	assert.deepEqual(lines(out, "poller_status_unavailable"), [{ event: "poller_status_unavailable", reason: "write" }, { event: "poller_status_unavailable", reason: "write" }], "one line per streak, a fixed reason");
	assert.doesNotMatch(JSON.stringify(out), /PRIVATE_DETAIL|READONLY/);
	assert.equal(lines(out, "poll_cycle").length, 3);
	assert.equal(queued.length, 6, "the scenario's six jobs, as with no heartbeat at all");
});

test("a PI_WORKER_NAME a worker would refuse publishes no heartbeat, says so once, and polls (issue #970)", async () => {
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	const beats = recordingStatus(redis);
	const { out, queued } = await runPoller({ env: { POLL_REPOS: "o/r", PI_WORKER_NAME: "no spaces allowed" }, cycles: 3, clock, redis, routes: scenarioRoutes() });
	assertNoRepoFailure(out);
	assert.deepEqual(beats, []);
	assert.deepEqual(lines(out, "poller_status_unavailable"), [{ event: "poller_status_unavailable", reason: "identity" }]);
	assert.equal(queued.length, 6);
	assert.equal(redis.sets.has(POLLER_LIVE), false);
});

test("a cycle longer than the grace beats between repositories once a minute, so its record never expires while it polls (issue #970)", async () => {
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	const beats = recordingStatus(redis);
	// Twelve repositories, two requests each in the cycle that arms them, every request 15 s: a six-minute cycle, past the
	// five-minute grace.
	const slow = () => {
		clock.ms += 15_000;
		return ghResponse(200, []);
	};
	const repos = Array.from({ length: 12 }, (_, i) => `o/r${i + 1}`).join(",");
	const { out, sleeps } = await runPoller({
		env: { POLL_REPOS: repos, PI_WORKER_NAME: "mini1" },
		clock,
		redis,
		routes: [
			{ path: "/issues/events", replies: [slow] },
			{ path: "/issues/comments", replies: [slow] },
			{ path: "/pulls?state=open", replies: [slow] },
		],
	});
	assertNoRepoFailure(out);
	assert.equal(lines(out, "poller_status_unavailable").length, 0);
	const cycle = lines(out, "poll_cycle")[0];
	assert.ok(cycle.ms > POLLER_GRACE_MS, `the cycle took ${cycle.ms} ms, longer than the grace`);
	assert.equal(cycle.ms, 360_000);
	// The start's and the top's beats at NOW, one before every repository a minute or more after the last (every second
	// repository from the third, and the renewal's first), then the beat before the wait.
	const at = beats.map((b) => [b.record.at - NOW, b.record.ttlMs, b.record.nextAt]);
	assert.deepEqual(at, [
		[0, POLLER_GRACE_MS, null],
		[0, POLLER_GRACE_MS, null],
		...[60_000, 120_000, 180_000, 240_000, 300_000, 360_000].map((ms) => [ms, POLLER_GRACE_MS, null]),
		[360_000, sleeps[0] + POLLER_GRACE_MS, NOW + 360_000 + sleeps[0]],
	]);
	for (let i = 1; i < beats.length; i++) {
		const gap = beats[i].record.at - beats[i - 1].record.at;
		assert.ok(gap < beats[i - 1].record.ttlMs, `beat ${i} lands before the one before it expires`);
		if (i > 1 && beats[i].record.nextAt === null) assert.ok(gap >= POLLER_CYCLE_BEAT_MS, `beat ${i}: at most once a minute`);
	}
});

test("one repository's long request loop beats once a minute too: 24 open pull requests' reviews on a slow API keep the record alive (issue #970)", async () => {
	const clock = { ms: NOW };
	const redis = fakeRedis({ clock });
	const beats = recordingStatus(redis);
	const slow = (body) => () => {
		clock.ms += 15_000;
		return ghResponse(200, body);
	};
	const open = Array.from({ length: 24 }, (_, i) => ({ ...prNine("c".repeat(40)), number: 100 + i }));
	const { out, sleeps } = await runPoller({
		env: STATUS_ENV,
		clock,
		redis,
		routes: [
			{ path: "/issues/events", replies: [slow([])] },
			{ path: "/issues/comments", replies: [slow([])] },
			{ path: "/pulls?state=open", replies: [slow(open)] },
			{ path: "/reviews", replies: [slow([])] },
		],
	});
	assertNoRepoFailure(out);
	const cycle = lines(out, "poll_cycle")[0];
	assert.ok(cycle.ms > POLLER_GRACE_MS, `one repository took ${cycle.ms} ms, longer than the grace`);
	const inCycle = beats.slice(2, -1);
	assert.ok(inCycle.length >= 5, `${inCycle.length} beats inside the one repository's poll`);
	for (let i = 1; i < beats.length; i++) {
		const gap = beats[i].record.at - beats[i - 1].record.at;
		assert.ok(gap < beats[i - 1].record.ttlMs, `beat ${i} lands before the one before it expires (gap ${gap} ms)`);
		if (i > 1 && beats[i].record.nextAt === null) assert.ok(gap >= POLLER_CYCLE_BEAT_MS, `beat ${i}: at most once a minute`);
	}
	assert.equal(beats.at(-1).record.nextAt, NOW + cycle.ms + sleeps[0]);
});
