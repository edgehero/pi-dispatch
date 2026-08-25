import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { filter } from "../src/filter.mjs";
import { parseSubset } from "../src/receiver.mjs";
import { loadReceiverConfig } from "../src/config.mjs";
import { loadPollerConfig } from "../src/poller-config.mjs";
import { startPoller } from "../src/poller.mjs";
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
			return route.replies[Math.min(n, route.replies.length - 1)];
		}
		throw new Error(`fakeFetch: unrouted ${url}`);
	};
	fn.calls = calls;
	return fn;
}

/** Map-backed redis fake exposing its state (kv/hashes/ttls) so cursors and TTLs are assertable. */
function fakeRedis() {
	const kv = new Map();
	const hashes = new Map();
	const ttls = new Map();
	return {
		kv,
		hashes,
		ttls,
		async get(key) {
			return kv.has(key) ? kv.get(key) : null;
		},
		async set(key, value, ex, ttl) {
			kv.set(key, String(value));
			if (ex === "EX") ttls.set(key, ttl);
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
			if (kv.has(key) || hashes.has(key)) ttls.set(key, ttl);
		},
		async quit() {},
	};
}

/**
 * Boot the poller with everything faked and run exactly `cycles` cycles: the injected sleep counts
 * cycle boundaries, advances the fake clock, and calls stop() after the last one.
 */
async function runPoller({ env = { POLL_REPOS: "o/r" }, cycles = 1, routes = [], redis = fakeRedis(), selfId = SELF, fsDeps = FS } = {}) {
	const queued = [];
	const out = [];
	const sleeps = [];
	const clock = { ms: NOW };
	const fetchFn = fakeFetch(routes);
	let remaining = cycles;
	let poller;
	poller = await startPoller(env, {
		fetchFn,
		redis,
		queueFn: async (job) => {
			queued.push(job);
		},
		out: (obj) => out.push(obj),
		now: () => clock.ms,
		random: () => 0.5,
		selfIdFn: async () => selfId,
		tokenFn: async () => "poll-token",
		fsDeps,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock.ms += ms;
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

async function withStdout(fn) {
	const written = [];
	const real = process.stdout.write;
	process.stdout.write = (chunk) => {
		written.push(String(chunk));
		return true;
	};
	try {
		return { result: await fn(), out: written.join("") };
	} finally {
		process.stdout.write = real;
	}
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
	assert.equal(redis.ttls.get("poll:o/r:cursor:reviews"), 35 * 24 * 3600, "the reviews cursor carries the same 35-day TTL as the rest of the family");
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
		{ path: "/repos/o/r/pulls?state=open", replies: [ghResponse(200, [PR9A])] },
	];
	const { redis } = await runPoller({ cycles: 1, routes });
	const ttl = 35 * 24 * 3600;
	for (const key of ["poll:o/r:cursor:events", "poll:o/r:cursor:comments", "poll:o/r:cursor:prs", "poll:o/r:prs"]) {
		assert.equal(redis.ttls.get(key), ttl, `${key} must expire with the rest of its family`);
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

	const { result, out } = await withStdout(() =>
		main(["--help"], {}, {
			start: async () => assert.fail("help must not boot the receiver"),
			startPoll: async () => assert.fail("help must not boot the poller"),
		}),
	);
	assert.equal(result, 0);
	assert.match(out, /pi-dispatch-receiver poll/);
	assert.match(out, /POLL_REPOS/, "usage names where poll's config comes from, so help is actionable");
});
