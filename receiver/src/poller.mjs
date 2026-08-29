/**
 * The polling producer (issue #81, second half): the same trigger gate and the same queue as the
 * webhook receiver, fed by READING api.github.com instead of by being reachable from it. It makes the
 * public webhook URL optional -- no DNS, no tunnel, no inbound port -- at the accepted cost of ~one
 * cycle (default 60s) of latency.
 *
 * TRUST FRAMING, stated once: the webhook path's HMAC gate defends an INBOUND surface, where anyone
 * who can reach the port can hand us a payload. Polling has no inbound surface to defend -- every
 * byte processed here arrived over TLS from api.github.com on a connection this process opened with
 * the operator's own credential. What the HMAC bought there, the outbound TLS handshake buys here.
 *
 * REUSE, NEVER RE-DERIVE -- the design rule this whole module is built around:
 *   - Each REST object is reshaped into the WEBHOOK PAYLOAD it corresponds to, then run through the
 *     receiver's own `parseSubset` and the UNCHANGED `filter()` with the same cfg/selfId. The gate --
 *     label allowlist, author_association, PR author gate, bot-loop guard -- has exactly one
 *     implementation, and the poller cannot drift from it because it never reimplements a byte of it.
 *   - A verdict's job is enqueued via the shared `enqueueGitHubJob`, replica fanout and all,
 *     mirroring receiver.mjs line for line.
 *   - The poller never interprets issue/comment/PR text itself: bodies pass through as DATA into the
 *     same subset fields the webhook path fills (CONST-ISSUE-TEXT-IS-DATA).
 *
 * WHAT IS POLLED, covering all three webhook trigger types:
 *   - label:        GET /repos/{o}/{r}/issues/events -- `labeled` entries cover issues AND PRs (a PR
 *                   is an issue here; `issue.pull_request` marks it, exactly the discriminator the
 *                   webhook subset uses). PR label events fetch the PR object once so the synthesized
 *                   payload carries the same author_association/labels/head/base a `pull_request
 *                   labeled` delivery would.
 *   - comment:      GET /repos/{o}/{r}/issues/comments?since=<cursor> -- PR conversation comments ARE
 *                   issue comments, so one endpoint covers both, as one webhook event does. The
 *                   comment object lacks the issue fields the subset needs (number/title/body/marker),
 *                   so each NEW comment fetches its issue once.
 *   - pull_request: GET /repos/{o}/{r}/pulls?state=open, diffed against a per-PR head-sha snapshot:
 *                   unknown number -> `opened`; known number, new sha -> `synchronize`; a number that
 *                   left the open list and came back -> `reopened` (best-effort: the list shows
 *                   presence, not transitions, so close->reopen inside one cycle is invisible, and a
 *                   reopen that also pushed fires a single `reopened` where webhooks would fire two
 *                   events -- the fresh sha still rides the job's target).
 *   - reviews:      GET /repos/{o}/{r}/pulls/{n}/reviews for each OPEN pr, cursor = last processed
 *                   review id (numeric and monotonic, so the events discipline applies). Issue #66's
 *                   fourth source, and it exists because the alternative was a `review_submitted`
 *                   trigger that loads clean under polling and can never fire -- the silently dead
 *                   trigger this project refuses everywhere else. Only open PRs are swept: a review on
 *                   a closed PR has nothing left to act on, the same call `merge`/`close` get in the
 *                   action vocabulary. REST spells `state` in upper case where the webhook spells it
 *                   lower; `parseSubset` folds it, so both transports produce the same job.
 *   - closed:       the SAME /issues/events feed as `label` -- `closed` entries carry the CLOSER as
 *                   `actor` and cover issues AND PRs (`issue.pull_request` is the discriminator again,
 *                   and a MERGED PR emits `closed` here too, which is what lets a close trigger release
 *                   post-merge work). Consumed only when a close rule is armed (hasCloseTriggers), so an
 *                   unarmed deployment's cycle stays byte-identical to a pre-#231 run: no PR fetch, no
 *                   permission traffic. The closer's write access is resolved via the shared
 *                   collaborator-permission lookup BEFORE the gate, mirroring the webhook arm
 *                   (issue #231; see `gate` for the indeterminate-lookup retry bound).
 *
 * DEDUP IDS (REQ-DEDUP-BY-DELIVERY-GUID): polling has no delivery GUID, so each source mints a
 * deterministic stand-in that is stable across retried cycles -- `poll-e<eventId>` (the /issues/events
 * feed: label AND close entries, one feed so one id family),
 * `poll-c<commentId>` (comments), `poll-pr<number>-<headSha7>` (PR actions; sha-keyed so a retried
 * cycle cannot double-enqueue while a real new push mints a new id -- with the honest corollary that
 * a same-sha reopen inside the retention window coalesces with its own `opened` job), and
 * `poll-rv<reviewId>` (reviews; a review id is immutable, so the id alone is the identity). The shared
 * `gh-` prefix is added by enqueueGitHubJob's jobId path, same as for webhook deliveries.
 *
 * CURSORS AND ETAGS live in redis, namespaced per repo:
 *   poll:<owner/repo>:cursor:events    last processed /issues/events id (numeric, monotonic)
 *   poll:<owner/repo>:cursor:comments  newest processed comment updated_at (second-precision ISO)
 *   poll:<owner/repo>:cursor:prs       ISO of when the PR snapshot was armed (presence = armed)
 *   poll:<owner/repo>:cursor:reviews   last processed review id (numeric, monotonic; presence = armed)
 *   poll:<owner/repo>:prs              hash: PR number -> head sha while open, "closed" once gone
 *   poll:<owner/repo>:etag:<endpoint>  conditional-GET validator (endpoint: events|comments|pulls)
 *   poll:<owner/repo>:etag:reviews     hash: PR number -> that PR's reviews-endpoint validator. A HASH
 *                                      rather than a key per PR, so the family below stays enumerable
 *                                      and `touchRepo` can still refresh it as a unit.
 *   poll:<owner/repo>:close-gate:<delivery>  consecutive INDETERMINATE closer-lookup attempts for ONE
 *                                      close event (issue #231). Deliberately OUTSIDE the touched
 *                                      family, with a short ~1-day TTL of its own: the counter must
 *                                      decay with the outage it measures, not live with the repo.
 * All keys carry a ~35-day TTL and are refreshed TOGETHER after each successful repo poll. 35 days
 * deliberately exceeds the 31-day gh-* jobId retention (REQ-DEDUP-BY-DELIVERY-GUID): the cursor and
 * the jobId are the poller's two dedup layers, and refreshing/expiring the cursor family as a unit
 * means an actively polled repo always has a coherent live family, while a repo REMOVED from the set
 * decays cleanly past both windows and re-arms from scratch if it ever returns. A partially expired
 * family (say, the armed marker without the sha hash) would misread every open PR as newly opened.
 *
 * FIRST BOOT / NEW REPO: cursors are initialized to NOW / the current ids WITHOUT enqueuing anything.
 * A fresh poller must not replay a repo's backlog -- a label applied months ago was a human approval
 * for THAT moment's issue text and budget, not a standing order; the operator arms polling from now.
 *
 * WHICH REPOS: POLL_REPOS wins when set (see poller-config.mjs). With GITHUB_AUTH_SOURCE=app and no
 * POLL_REPOS, the App installation's repository list is the source of truth, refreshed every
 * DISCOVERY_EVERY cycles so an operator who installs the App on a new repo gets polling without a
 * restart. Zero repos from either mechanism fails loud at boot.
 *
 * POLITENESS: per-endpoint-per-repo ETags make the idle steady state nearly free (304s do not count
 * against the rate limit, per GitHub's docs); `x-poll-interval` is honored as the MINIMUM cycle
 * delay when present; an exhausted rate limit (403/429 with x-ratelimit-remaining: 0) sleeps until
 * x-ratelimit-reset plus jitter and says so.
 *
 * FAILURE ISOLATION: one repo's API error skips that repo for the cycle, logged, and never kills the
 * loop -- one archived or deleted repo must not stall nine live ones. Config errors are tagged
 * `piDispatchConfig` and exit 2 via the receiver bin's entryExitCode; graceful shutdown on
 * SIGTERM/SIGINT finishes the in-flight repo, prints the cycle summary, and closes redis/queue.
 *
 * no-pii-in-logs, same as the receiver: stable identifiers only (repo full_name, delivery stand-in,
 * flow, reasons, counts) -- never a title, a body, or a login.
 */

import { createSign } from "node:crypto";
import { readFile as fsReadFile } from "node:fs/promises";
import { configError } from "@edgehero/pi-dispatch/config";
import { parseConnection } from "@edgehero/pi-dispatch/connection";
import { makeGitHubAuth } from "@edgehero/pi-dispatch/get-token";
import { enqueueGitHubJob, makeQueue } from "@edgehero/pi-dispatch/queue";
import { filter, hasCloseTriggers, wantsCloserAuthority } from "./filter.mjs";
import { makeResolveGitHubAuthority } from "./github-members.mjs";
import { parseSubset } from "./receiver.mjs";
import { loadPollerConfig } from "./poller-config.mjs";

const API_URL = "https://api.github.com";
// 35 days: strictly outlives the 31-day gh-* job retention -- see the header's cursor/TTL section.
const CURSOR_TTL_SECONDS = 35 * 24 * 3600;
// Installation repo-list refresh cadence, in cycles (~10 minutes at the default interval): fresh
// enough that a newly installed repo starts polling soon, cheap enough to be invisible in the quota.
const DISCOVERY_EVERY = 10;
// Page bounds. The events endpoint has no `since`, so a backlog deeper than this is skipped with an
// explicit log line rather than stalling the cycle; comments self-heal (the cursor advances and the
// next cycle picks up the rest); the open-PR list just caps how many open PRs the diff can see.
const MAX_EVENT_PAGES = 5;
const MAX_PR_PAGES = 10;
// How many open PRs one cycle sweeps for reviews. This is a REQUEST bound, not a page bound: the reviews
// endpoint is per-PR, so an unbounded sweep would spend one request per open PR per cycle. 50 covers any
// repo a single poller realistically services, and the overflow is logged rather than silently dropped.
const MAX_REVIEW_PRS = 50;
// The hash value marking a PR that left the open list. Cannot collide with a head sha (hex only).
const CLOSED_MARKER = "closed";
// The closer-authority retry bound (issue #231): how many consecutive cycles an INDETERMINATE
// collaborator-permission lookup may hold the events cursor before the close is dropped loudly.
// ~20 cycles at the default 60s interval is a real outage, not a blip; see `gate` for the tradeoff.
const CLOSE_GATE_MAX_ATTEMPTS = 20;
// The retry counter's own TTL: it measures ONE outage around ONE event, so it decays in a day rather
// than riding the 35-day cursor family (touchRepo never refreshes it -- see the module header).
const CLOSE_GATE_TTL_SECONDS = 24 * 3600;

/** Thrown by the API helper when the credential's quota is exhausted; carries the reset time in ms. */
class RateLimited extends Error {
	constructor(resetMs) {
		super("github rate limit exhausted");
		this.resetMs = resetMs;
	}
}

/**
 * Boot the poller: config, HARD-FAIL identity, repo set, then the cycle loop. Collaborators are
 * injected with real defaults (start.mjs's convention), so the whole producer is testable offline
 * with no GitHub, no Valkey, and no timers:
 *   { fetchFn, redis, queueFn, out, now, random, sleep, selfIdFn, tokenFn, fsDeps }
 * Returns `{ stop, done }`: `stop()` ends the loop after the in-flight work; `done` resolves once
 * owned connections are closed.
 */
export async function startPoller(env = process.env, deps = {}) {
	const {
		fetchFn = globalThis.fetch,
		out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`),
		now = Date.now,
		random = Math.random,
		sleep,
		redis,
		queueFn,
		selfIdFn,
		tokenFn,
		readFile = fsReadFile,
		fsDeps = {},
		makeAuth = makeGitHubAuth,
		makeQueueFn = makeQueue,
		makeResolveGitHubAuthority: makeResolveGitHubAuthorityFn = makeResolveGitHubAuthority,
	} = deps;

	const cfg = loadPollerConfig(env, fsDeps);

	// HARD-FAIL identity resolution, exactly start.mjs's boot gate and for the same reason: selfId is
	// the bot-loop guard's sole input, and a poller running without it would read the harness's own
	// completion comment next cycle and enqueue it -- an unbounded paid recursion, only slower than the
	// webhook version. No try/catch: an unresolvable identity must prevent the loop from ever starting.
	let auth = null;
	const getAuth = async () => (auth ??= await makeAuth(cfg.github));
	const selfId = selfIdFn ? await selfIdFn(cfg.github) : (await getAuth()).selfId;
	out({ event: "self_identity", id: selfId, source: cfg.github.source });

	// The polling credential comes from the same auth config the worker validates. pat/gh hand back
	// the operator's own token via the shared mintToken; the app source mints an installation token
	// itself (below) because the worker's mint is per-repo-scoped BY DESIGN (CONST-TOKEN-SCOPED-PER-JOB
	// bounds a token that enters a sandbox) while this one never leaves this process and must both read
	// every polled repo and list the installation -- a scope no single-repo token can carry.
	const mintToken = tokenFn ?? (cfg.github.source === "app"
		? makeAppInstallationTokenFn(cfg.github, { fetchFn, readFile, now })
		: async () => (await getAuth()).mintToken());

	// The closer-authority resolver (issue #231), built over the poller's OWN mint above -- the injected
	// factory default, start.mjs's convention. On the app source that mint hands back the CACHED,
	// UNSCOPED installation token (makeAppInstallationTokenFn below), and the resolver's job-shaped
	// `{ repo }` argument is simply ignored by it. That is fine for what this token does here: one
	// read-only permission lookup that never leaves this process. The webhook arm's per-delivery
	// metadata:read narrowing (start.mjs) is the stricter posture; the poller's cache is the deliberate
	// cost tradeoff its own header already records (the credential must read every polled repo anyway),
	// and github-members.mjs names this cache as the recorded fallback to per-delivery minting.
	const resolveCloserAuthority = makeResolveGitHubAuthorityFn({ mintToken, fetchFn });

	// Cursor store. ioredis is imported lazily so tests injecting a fake never load the driver. The
	// client rides out disconnects (ioredis reconnects on its own) -- same posture as the receiver's
	// queue connection: a long-running producer should survive a Valkey restart.
	let redisClient = redis ?? null;
	let ownRedis = false;
	if (redisClient === null) {
		const { default: Redis } = await import("ioredis");
		redisClient = new Redis(cfg.valkeyUrl);
		ownRedis = true;
	}

	// The enqueue seam. The default is the shared enqueueGitHubJob over a real queue -- never a local
	// re-spelling of queue.add (DES-TRIGGER-OUTSIDE-PI's producer rule: dedup/retention has one owner).
	let queue = null;
	let enqueue = queueFn ?? null;
	if (enqueue === null) {
		queue = makeQueueFn(parseConnection(cfg.valkeyUrl));
		enqueue = (job) => enqueueGitHubJob(queue, job);
	}

	const closeOwned = async () => {
		if (queue) await queue.close();
		if (ownRedis) await redisClient.quit();
	};

	const ctx = { cfg, selfId, fetchFn, redis: redisClient, enqueue, out, now, random, resolveCloserAuthority };

	// The repo set: explicit POLL_REPOS, or the App installation's list (cfg.repos === null only when
	// the source is app -- poller-config enforces it). An empty discovery is a config error, not an
	// idle loop: a poller watching nothing must refuse to start, not report healthy cycles forever.
	let repos = cfg.repos;
	if (repos === null) {
		try {
			repos = await discoverRepos(ctx, makeApi(ctx, await mintToken(), emptyStats()));
		} catch (err) {
			await closeOwned();
			throw err;
		}
		if (repos.length === 0) {
			await closeOwned();
			throw configError(
				"the App installation grants no repositories -- install the GitHub App on the repos to poll, or set POLL_REPOS=owner/name[,owner/name...] explicitly",
			);
		}
		out({ event: "poll_repos_discovered", repos: repos.length });
	}

	out({ event: "poller_started", repos: repos.length, intervalSeconds: cfg.intervalSeconds, valkey: cfg.valkeyUrl, discovery: cfg.repos === null });

	let stopped = false;
	let wake;
	const stopWaker = new Promise((resolve) => {
		wake = resolve;
	});
	const stop = () => {
		stopped = true;
		wake();
	};
	const sleepFn = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

	const done = (async () => {
		let cycleNo = 0;
		while (!stopped) {
			const stats = emptyStats();
			const startedAt = now();
			let rateResetMs = null;

			// A token-mint failure (network blip, gh relogin) skips the cycle with a log line rather than
			// killing the loop: genuinely bad auth config already hard-failed at the identity boot gate.
			let token = null;
			try {
				token = await mintToken();
			} catch (err) {
				out({ event: "poll_token_failed", reason: err?.message });
			}

			if (token !== null) {
				const api = makeApi(ctx, token, stats);

				// Low-frequency installation-list refresh. A refresh failure KEEPS the current list -- a
				// discovery outage must not stop polling the repos already armed.
				if (cfg.repos === null && cycleNo > 0 && cycleNo % DISCOVERY_EVERY === 0) {
					try {
						const found = await discoverRepos(ctx, api);
						if (found.length > 0) repos = found;
						else out({ event: "poll_discovery_empty", kept: repos.length });
					} catch (err) {
						if (err instanceof RateLimited) rateResetMs = err.resetMs;
						else out({ event: "poll_discovery_failed", reason: err?.message });
					}
				}

				if (rateResetMs === null) {
					for (const repo of repos) {
						if (stopped) break; // graceful: finish the in-flight repo, not the whole roster
						try {
							await pollRepo(ctx, api, repo, stats);
						} catch (err) {
							if (err instanceof RateLimited) {
								// The quota is credential-global, so one repo hitting it means they all would:
								// abort the roster and sleep out the reset instead of burning N more refusals.
								rateResetMs = err.resetMs;
								out({ event: "poll_rate_limited", resetAt: new Date(err.resetMs).toISOString() });
								break;
							}
							// One repo's failure is one repo's failure: log and keep going -- an archived or
							// deleted repo must not stall the live ones. Its cursors simply do not advance, so
							// nothing is lost if it comes back.
							out({ event: "poll_repo_failed", repo, reason: err?.message });
						}
					}
				}
			}

			cycleNo++;
			out({ event: "poll_cycle", repos: repos.length, fetched: stats.fetched, enqueued: stats.enqueued, notModified: stats.notModified, ms: now() - startedAt });
			if (stopped) break;

			// The delay: the configured interval, raised by any x-poll-interval hint seen this cycle, and
			// raised again past the rate-limit reset (plus jitter, so a fleet of pollers does not return
			// in one synchronized stampede).
			let delayMs = Math.max(cfg.intervalSeconds, stats.minDelaySeconds) * 1000;
			if (rateResetMs !== null) delayMs = Math.max(delayMs, rateResetMs - now() + jitterMs(random));
			await Promise.race([sleepFn(delayMs), stopWaker]);
		}
		await closeOwned();
	})();

	// Signal handlers only on a real run (no injected sleep) -- start.mjs's rule, same reason: under
	// test injection the fakes are per-test, and a process-wide handler would leak across tests.
	if (sleep === undefined) {
		const shutdown = async (signal) => {
			out({ event: "poller_stopping", signal });
			stop();
			await done;
			process.exit(0);
		};
		process.once("SIGTERM", () => void shutdown("SIGTERM"));
		process.once("SIGINT", () => void shutdown("SIGINT"));
	}

	return { stop, done };
}

function emptyStats() {
	return { fetched: 0, enqueued: 0, notModified: 0, minDelaySeconds: 0 };
}

/** 1-30s of jitter for the post-rate-limit wake, spread by the injected `random`. */
function jitterMs(random) {
	return 1_000 + Math.floor(random() * 29_000);
}

/** The redis key family for one repo -- see the schema table in the module header. */
function keyNames(repo) {
	const p = `poll:${repo}`;
	return {
		events: `${p}:cursor:events`,
		comments: `${p}:cursor:comments`,
		prsArmed: `${p}:cursor:prs`,
		prs: `${p}:prs`,
		etagEvents: `${p}:etag:events`,
		etagComments: `${p}:etag:comments`,
		etagPulls: `${p}:etag:pulls`,
		reviews: `${p}:cursor:reviews`,
		etagReviews: `${p}:etag:reviews`,
	};
}

async function setWithTtl(ctx, key, value) {
	await ctx.redis.set(key, value, "EX", CURSOR_TTL_SECONDS);
}

/** Refresh the whole key family together -- coherence over per-key precision (see module header). */
async function touchRepo(ctx, repo) {
	const k = keyNames(repo);
	for (const key of [k.events, k.comments, k.prsArmed, k.prs, k.etagEvents, k.etagComments, k.etagPulls, k.reviews, k.etagReviews]) {
		await ctx.redis.expire(key, CURSOR_TTL_SECONDS);
	}
}

/** Second-precision ISO (GitHub's own timestamp shape), so cursor comparisons never mix precisions. */
function isoSeconds(ms) {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A per-cycle GitHub API view: one token, one stats object, ETag discipline in one place.
 *
 * `get(path, etagKey, revalidate)`: when `etagKey` is set the stored validator is sent as
 * If-None-Match and the fresh one stored on 200; a 304 is counted and returned as `{ notModified }`.
 * `revalidate: false` (used while ARMING, i.e. no cursor yet) still STORES the response's ETag but
 * never sends one -- arming needs the body, and a stray stored validator answering 304 on an unarmed
 * endpoint would leave it unarmed forever.
 *
 * `etagKey` may also be `{ key, field }`, which stores the validator in a HASH field instead. That form
 * exists for the per-PR reviews endpoint (issue #66): one validator per open PR would otherwise mean an
 * unbounded key family that `touchRepo` cannot enumerate, and the whole TTL argument in the header rests
 * on the family being refreshable as a unit. The conditional-GET discipline stays in this one place.
 *
 * An exhausted quota (403/429 with x-ratelimit-remaining: 0) throws RateLimited for the cycle loop
 * to sleep out; any other non-2xx throws a plain error for per-repo isolation to log.
 */
function makeApi(ctx, token, stats) {
	return {
		async get(path, etagKey = null, revalidate = true) {
			const headers = {
				accept: "application/vnd.github+json",
				"user-agent": "pi-dispatch-poller",
				"x-github-api-version": "2022-11-28",
				authorization: `Bearer ${token}`,
			};
			if (etagKey && revalidate) {
				const etag = etagKey.field === undefined ? await ctx.redis.get(etagKey) : await ctx.redis.hget(etagKey.key, etagKey.field);
				if (etag) headers["if-none-match"] = etag;
			}
			const res = await ctx.fetchFn(`${API_URL}${path}`, { headers });

			const pollHint = Number(res.headers?.get?.("x-poll-interval"));
			if (Number.isFinite(pollHint) && pollHint > stats.minDelaySeconds) stats.minDelaySeconds = pollHint;

			if (res.status === 304) {
				stats.notModified += 1;
				return { notModified: true };
			}
			if ((res.status === 403 || res.status === 429) && res.headers?.get?.("x-ratelimit-remaining") === "0") {
				const reset = Number(res.headers.get("x-ratelimit-reset"));
				throw new RateLimited(Number.isFinite(reset) && reset > 0 ? reset * 1000 : ctx.now() + 60_000);
			}
			if (!res.ok) {
				throw new Error(`GET ${path} -> HTTP ${res.status}`);
			}
			if (etagKey) {
				const tag = res.headers?.get?.("etag");
				if (tag && etagKey.field === undefined) {
					await ctx.redis.set(etagKey, tag, "EX", CURSOR_TTL_SECONDS);
				} else if (tag) {
					// The hash carries no TTL of its own here; `touchRepo` expires it with the rest of the family.
					await ctx.redis.hset(etagKey.key, etagKey.field, tag);
					await ctx.redis.expire(etagKey.key, CURSOR_TTL_SECONDS);
				}
			}
			stats.fetched += 1;
			return { json: await res.json() };
		},
	};
}

/**
 * List the App installation's repositories (paginated). Archived repos are not filtered here: an
 * archived repo simply produces nothing, and per-repo error isolation covers any oddity -- fewer
 * special cases beats a slightly shorter roster.
 */
async function discoverRepos(ctx, api) {
	const names = [];
	for (let page = 1; page <= 10; page++) {
		const r = await api.get(`/installation/repositories?per_page=100&page=${page}`);
		const batch = Array.isArray(r.json?.repositories) ? r.json.repositories : [];
		for (const item of batch) {
			if (typeof item?.full_name === "string" && item.full_name !== "") names.push(item.full_name);
		}
		if (batch.length < 100) break;
	}
	return names;
}

/** One repo, one cycle: the three endpoints, then a TTL touch so the key family ages as a unit. */
async function pollRepo(ctx, api, repo, stats) {
	await pollLabelEvents(ctx, api, repo, stats);
	await pollComments(ctx, api, repo, stats);
	await pollPulls(ctx, api, repo, stats);
	await touchRepo(ctx, repo);
}

/**
 * The label feed: /issues/events, cursor = last processed event id (numeric and monotonic, which is
 * what makes per-event cursor advancement safe here -- each processed event's own id IS the resume
 * point, so a mid-list failure retries exactly the unprocessed tail and nothing twice).
 */
async function pollLabelEvents(ctx, api, repo, stats) {
	const k = keyNames(repo);
	const cursorRaw = await ctx.redis.get(k.events);
	const armed = cursorRaw !== null;

	const first = await api.get(`/repos/${repo}/issues/events?per_page=100`, k.etagEvents, armed);
	if (first.notModified) return;
	const pageOne = Array.isArray(first.json) ? first.json : [];

	if (!armed) {
		// ARM WITHOUT REPLAY: record the newest id and enqueue nothing -- the backlog's labels were
		// approvals for a different moment (module header). An empty repo arms at 0.
		const maxId = pageOne.reduce((m, e) => (typeof e?.id === "number" && e.id > m ? e.id : m), 0);
		await setWithTtl(ctx, k.events, String(maxId));
		ctx.out({ event: "poll_armed", repo, endpoint: "events", cursor: maxId });
		return;
	}

	const cursor = Number(cursorRaw);
	// The endpoint is newest-first with no `since`, so page deeper only while the OLDEST fetched entry
	// is still newer than the cursor. Beyond the page bound the remainder is skipped -- said out loud,
	// because a silent gap here would be labels that never fire.
	let events = pageOne;
	let page = 2;
	while (events.length > 0 && lastId(events) > cursor && page <= MAX_EVENT_PAGES) {
		const more = await api.get(`/repos/${repo}/issues/events?per_page=100&page=${page}`);
		const batch = Array.isArray(more.json) ? more.json : [];
		if (batch.length === 0) break;
		events = events.concat(batch);
		page++;
	}
	if (events.length > 0 && lastId(events) > cursor && page > MAX_EVENT_PAGES) {
		ctx.out({ event: "poll_events_gap", repo, cursor });
	}

	const fresh = events
		.filter((e) => typeof e?.id === "number" && e.id > cursor)
		.sort((a, b) => a.id - b.id); // oldest first: process in the order the webhooks would have fired
	for (const ev of fresh) {
		if (ev.event === "labeled" && ev.issue) {
			await handleLabeledEvent(ctx, api, repo, ev, stats);
		} else if (ev.event === "closed" && ev.issue && hasCloseTriggers(ctx.cfg?.triggers?.github)) {
			// The coarse hasCloseTriggers guard IS the byte-identity switch (issue #231): with no close
			// rule armed, a `closed` entry takes the same do-nothing path every unhandled event always
			// has -- no PR fetch, no permission traffic, a cycle indistinguishable from a pre-#231 run.
			// An entry with no `issue` field is malformed and skipped the same way, never thrown on.
			try {
				await handleClosedEvent(ctx, api, repo, ev, stats);
			} catch (err) {
				// The scoped catch that keeps a close-gate spell from starving the WHOLE repo: a throw
				// here (an indeterminate closer lookup below its bound, a PR fetch blip) must hold THIS
				// feed's cursor before the failed event -- a monotone cursor cannot skip one entry and
				// come back -- but the comment and pull feeds have their OWN cursors and their own real
				// work, so ending only the events feed for this cycle lets pollRepo continue to them.
				// RateLimited still propagates: the quota is credential-global and pollRepo's caller
				// sleeps the whole roster out, which no per-feed catch may swallow.
				if (err instanceof RateLimited) throw err;
				ctx.out({ event: "poll_close_gate_retry", repo, delivery: `poll-e${ev.id}`, reason: err?.message });
				return;
			}
		}
		// Advance ONLY after the event is handled: an enqueue/fetch failure above leaves the cursor on
		// the last success, so the retry next cycle resumes at the exact failed event. Unmatched and
		// unarmed closes advance past here exactly like every unhandled event always has.
		await setWithTtl(ctx, k.events, String(ev.id));
	}
}

function lastId(events) {
	const id = events[events.length - 1]?.id;
	return typeof id === "number" ? id : Number.MAX_SAFE_INTEGER; // malformed tail: stop paging, keep what we have
}

/**
 * One `labeled` event -> the webhook payload it corresponds to -> the unchanged gate.
 *
 * The issue-vs-PR split mirrors the webhook exactly: the events feed hands us the ISSUE view, whose
 * `pull_request` field is the same presence marker parseSubset reads on an issue_comment. An issue
 * routes as `issues labeled` with the issue object as-is. A PR must route as `pull_request labeled`,
 * and the issue view lacks what that path gates on (author_association, the PR's own labels,
 * head/base), so the PR object is fetched once per event -- the price of field-for-field parity with
 * the webhook subset, paid only on NEW labeled events.
 */
async function handleLabeledEvent(ctx, api, repo, ev, stats) {
	const deliveryId = `poll-e${ev.id}`;
	if (ev.issue.pull_request != null) {
		const pr = (await api.get(`/repos/${repo}/pulls/${ev.issue.number}`)).json;
		const payload = { action: "labeled", sender: { id: ev.actor?.id }, pull_request: pr, repository: { full_name: repo } };
		await gate(ctx, "pull_request", payload, deliveryId, stats);
	} else {
		const payload = { action: "labeled", sender: { id: ev.actor?.id }, issue: ev.issue, repository: { full_name: repo } };
		await gate(ctx, "issues", payload, deliveryId, stats);
	}
}

/**
 * One `closed` event -> the webhook payload it corresponds to -> the unchanged gate (issue #231).
 * handleLabeledEvent's twin, split on the same discriminator: the events feed hands us the ISSUE
 * view, and `issue.pull_request` marks a PR. An issue routes as `issues closed` with the issue object
 * as-is; a PR must route as `pull_request closed`, and the issue view lacks the PR fields the job's
 * target carries (title/body/head/base as the webhook subset shapes them), so the PR object is
 * fetched once per event -- field-for-field parity again, paid only on NEW closed events under an
 * ARMED close rule (the caller's hasCloseTriggers guard). A MERGED PR emits `closed` in this feed
 * too, exactly as the webhook's `closed` action covers merged -- which is what lets a prClose
 * trigger release post-merge work over polling.
 *
 * A failing PR fetch rides the labeled twin's own retry discipline: the throw holds the events
 * cursor and retries next cycle (scoped to this feed since #231). Unbounded on purpose -- unlike an
 * indeterminate LOOKUP, a fetch failure here has no counter, because the one input that could make
 * it permanent (a deleted PR) is a GitHub-support-only operation the labeled path has carried
 * unbounded since it shipped, and a bound would spend its complexity on a case nobody can produce.
 *
 * `sender` carries the closer's LOGIN as well as the id, alone among this module's synthesized
 * payloads: the collaborator-permission lookup is by username because that is the only key GitHub's
 * endpoint takes. Same justification and same obligation as the webhook subset's `sender.login`
 * (parseSubset): it exists to have been asked about, it is never logged, and the job literal keeps
 * `trigger.sender` at `{ id }` alone.
 */
async function handleClosedEvent(ctx, api, repo, ev, stats) {
	const deliveryId = `poll-e${ev.id}`;
	const sender = { id: ev.actor?.id, login: ev.actor?.login };
	if (ev.issue.pull_request != null) {
		const pr = (await api.get(`/repos/${repo}/pulls/${ev.issue.number}`)).json;
		const payload = { action: "closed", sender, pull_request: pr, repository: { full_name: repo } };
		await gate(ctx, "pull_request", payload, deliveryId, stats);
	} else {
		const payload = { action: "closed", sender, issue: ev.issue, repository: { full_name: repo } };
		await gate(ctx, "issues", payload, deliveryId, stats);
	}
}

/**
 * The comment feed: /issues/comments?since=<cursor>, cursor = newest processed updated_at.
 *
 * `since` selects by UPDATE time, but the webhook path only ever consumes `issue_comment created` --
 * so a returned comment counts as NEW exactly when its created_at is later than the cycle-start
 * cursor; an edit of an older comment is skipped, as the webhook filter would have skipped the
 * `edited` action. The strict compare leaves a sub-second race (a comment created in the same second
 * as the cursor, after the fetch) which the NEXT cycle's inclusive `since` cannot re-distinguish; the
 * alternative (>=) would re-enqueue the boundary comment every idle cycle forever, leaning on jobId
 * dedup to absorb the noise. One-second blindness loses to permanent noise.
 *
 * The cursor is persisted once, AFTER the list: comment timestamps are not identities, so a per-item
 * cursor could strand a same-second neighbor on a crash. A mid-list failure therefore retries the
 * whole batch next cycle, and `gh-poll-c<id>` jobId dedup absorbs the overlap.
 */
async function pollComments(ctx, api, repo, stats) {
	const k = keyNames(repo);
	const cursor = await ctx.redis.get(k.comments);
	if (cursor === null) {
		// ARM WITHOUT REPLAY, and without even a fetch: "everything before now is history" needs no body.
		await setWithTtl(ctx, k.comments, isoSeconds(ctx.now()));
		ctx.out({ event: "poll_armed", repo, endpoint: "comments" });
		return;
	}

	const r = await api.get(
		`/repos/${repo}/issues/comments?sort=updated&direction=asc&since=${encodeURIComponent(cursor)}&per_page=100`,
		k.etagComments,
	);
	if (r.notModified) return;
	const comments = Array.isArray(r.json) ? r.json : [];

	let advanced = cursor;
	for (const c of comments) {
		if (typeof c?.id === "number" && typeof c?.created_at === "string" && c.created_at > cursor) {
			await handleComment(ctx, api, repo, c, stats);
		}
		if (typeof c?.updated_at === "string" && c.updated_at > advanced) advanced = c.updated_at;
	}
	if (advanced !== cursor) await setWithTtl(ctx, k.comments, advanced);
	// A backlog deeper than one page self-heals: the cursor advanced to this page's newest update, so
	// the next cycle's `since` picks up the remainder -- no pagination loop to bound here.
}

/**
 * One new comment -> the `issue_comment created` payload -> the unchanged gate. The comment object
 * names its issue only by URL, so the issue is fetched once per NEW comment (rare and cheap) to fill
 * the subset's issue fields -- number, title, body, and the pull_request marker that makes a PR
 * conversation comment route as a pull_request target, exactly as the webhook payload's issue does.
 */
async function handleComment(ctx, api, repo, c, stats) {
	const number = issueNumberOf(c.issue_url);
	if (number === null) return;
	const issue = (await api.get(`/repos/${repo}/issues/${number}`)).json;
	const payload = {
		action: "created",
		sender: { id: c.user?.id },
		issue,
		comment: { body: c.body, author_association: c.author_association },
		repository: { full_name: repo },
	};
	await gate(ctx, "issue_comment", payload, `poll-c${c.id}`, stats);
}

/** `.../repos/o/r/issues/17` -> 17, or null when the URL does not end in an issue number. */
function issueNumberOf(issueUrl) {
	const m = /\/issues\/(\d+)$/.exec(String(issueUrl ?? ""));
	return m ? Number(m[1]) : null;
}

/**
 * The PR feed: the full open list, diffed against the per-PR head-sha snapshot (see module header
 * for the opened/synchronize/reopened derivation and its stated approximations). One more is worth
 * naming here: the list has no "who did this", so `sender` is the PR AUTHOR -- exact for `opened`,
 * an approximation for `synchronize`/`reopened` where the webhook names the pusher/reopener. The
 * bot-loop guard consequence is the safe direction for the common case: the harness's own PRs carry
 * its own user id and stay self-filtered on every action.
 */
async function pollPulls(ctx, api, repo, stats) {
	const k = keyNames(repo);
	const armed = (await ctx.redis.get(k.prsArmed)) !== null;

	const first = await api.get(`/repos/${repo}/pulls?state=open&sort=updated&direction=asc&per_page=100`, k.etagPulls, armed);
	if (first.notModified) {
		// Reviews still sweep on this path, and that is deliberate rather than defensive. Whether submitting
		// a review perturbs the open-PR LIST is GitHub's business, not a property this project should bet
		// correctness on: if it does not, an unswept 304 cycle would mean review triggers that fire only when
		// something else happens to touch the PR. `null` tells pollReviews to take its sweep set from the
		// snapshot hash instead of a list it does not have.
		await pollReviews(ctx, api, repo, null, stats);
		return;
	}
	let open = Array.isArray(first.json) ? first.json : [];
	let batch = open;
	let page = 2;
	while (batch.length === 100 && page <= MAX_PR_PAGES) {
		const more = await api.get(`/repos/${repo}/pulls?state=open&sort=updated&direction=asc&per_page=100&page=${page}`);
		batch = Array.isArray(more.json) ? more.json : [];
		open = open.concat(batch);
		page++;
	}

	if (!armed) {
		// ARM WITHOUT REPLAY: snapshot the open set so the next cycle diffs against reality. The hash is
		// written before the armed marker, so a crash between the two re-arms cleanly (marker-without-
		// hash is the dangerous order -- it would read every open PR as newly opened).
		for (const pr of open) {
			if (pr?.number != null) await ctx.redis.hset(k.prs, String(pr.number), pr.head?.sha ?? "");
		}
		await ctx.redis.expire(k.prs, CURSOR_TTL_SECONDS);
		await setWithTtl(ctx, k.prsArmed, isoSeconds(ctx.now()));
		ctx.out({ event: "poll_armed", repo, endpoint: "pulls", open: open.length });
		// Reviews arm on this cycle too. Returning without them would leave the reviews cursor unset for a
		// whole extra cycle, and the first cycle that DID arm it would silently swallow every review
		// submitted in between -- arming twice against one snapshot, losing the window between the two.
		await pollReviews(ctx, api, repo, open, stats);
		return;
	}

	const known = await ctx.redis.hgetall(k.prs);
	const seen = new Set();
	for (const pr of open) {
		if (pr?.number == null) continue;
		const field = String(pr.number);
		seen.add(field);
		const sha = pr.head?.sha ?? "";
		const prev = known[field];
		let action = null;
		if (prev === undefined) action = "opened";
		else if (prev === CLOSED_MARKER) action = "reopened";
		else if (prev !== sha) action = "synchronize";
		if (action === null) continue;

		const payload = { action, sender: { id: pr.user?.id }, pull_request: pr, repository: { full_name: repo } };
		await gate(ctx, "pull_request", payload, `poll-pr${pr.number}-${sha.slice(0, 7)}`, stats);
		// Snapshot after the gate, so a failed enqueue retries this PR next cycle at the same sha.
		await ctx.redis.hset(k.prs, field, sha);
	}
	// A known PR absent from the full open list left it (closed one way or another); mark it so a
	// later reappearance reads as `reopened` rather than as brand new.
	for (const field of Object.keys(known)) {
		if (!seen.has(field) && known[field] !== CLOSED_MARKER) {
			await ctx.redis.hset(k.prs, field, CLOSED_MARKER);
		}
	}

	// Reviews ride the SAME open-PR list this function already paid for -- one /pulls response feeds both
	// sources, which is the whole reason this call lives here rather than in its own pollRepo step.
	await pollReviews(ctx, api, repo, open, stats);
}

/**
 * The review feed (issue #66): GET /repos/{o}/{r}/pulls/{n}/reviews per OPEN pr, cursor = last processed
 * review id.
 *
 * Review ids are numeric and monotonic, but this sweep reads MANY endpoints (one per open PR) whose ids
 * interleave, so the cursor is persisted ONCE at the end -- the comments-feed discipline, not the label
 * feed's per-item one. Advancing per review would be actively wrong here: PR #1's review 200 followed by
 * PR #2's review 150 would leave the cursor at 150 and re-enqueue 200 next cycle, or (writing the running
 * max) would strand 150 forever if the sweep died between the two. Persisting once means a mid-sweep
 * failure retries the WHOLE sweep, and the reviews already enqueued dedup on their `gh-poll-rv<id>`
 * jobIds -- the same idempotence the replica fanout in `gate` leans on.
 *
 * COST is why the per-PR ETag exists. Without it a 50-open-PR repo spends 50 requests a cycle forever;
 * with it the idle steady state is 50 * 304, which GitHub does not charge against the rate limit. The
 * validators live in one hash (see keyNames) so the key family stays enumerable for touchRepo.
 *
 * A review on a CLOSED pr is never seen, deliberately: the open list is the sweep set, and a job started
 * by a review of a merged PR has nothing left to act on -- the same call `merge` and `close` get in the
 * action vocabulary.
 */
async function pollReviews(ctx, api, repo, open, stats) {
	const k = keyNames(repo);
	const cursorRaw = await ctx.redis.get(k.reviews);
	const armed = cursorRaw !== null;
	const cursor = armed ? Number(cursorRaw) : 0;

	// The sweep set. `open` is the list pollPulls just fetched; `null` means it got a 304 and the snapshot
	// hash is the only record of which PRs are open. Numbers are enough to drive the sweep -- the PR OBJECT
	// is only needed for a PR that turns out to have a new review, and is fetched lazily below, which is
	// the same once-per-new-event fetch handleLabeledEvent and handleComment already do.
	let numbers;
	if (open !== null) {
		numbers = open.filter((pr) => pr?.number != null).map((pr) => pr.number);
	} else {
		const known = await ctx.redis.hgetall(k.prs);
		numbers = Object.entries(known)
			.filter(([, sha]) => sha !== CLOSED_MARKER)
			.map(([field]) => Number(field))
			.filter((n) => Number.isFinite(n))
			.sort((a, b) => a - b);
	}

	// Bounded, and said out loud when it bites: a silent cap reads as coverage.
	if (numbers.length > MAX_REVIEW_PRS) {
		ctx.out({ event: "poll_reviews_gap", repo, open: numbers.length, swept: MAX_REVIEW_PRS });
	}
	const bounded = numbers.slice(0, MAX_REVIEW_PRS);
	const byNumber = new Map((open ?? []).filter((pr) => pr?.number != null).map((pr) => [pr.number, pr]));

	let maxId = cursor;
	for (const number of bounded) {
		const field = String(number);
		// While ARMING, `revalidate: false` for the same reason every other source uses it: arming needs
		// the body, and a stored validator answering 304 on an unarmed endpoint would strand it unarmed.
		const res = await api.get(`/repos/${repo}/pulls/${number}/reviews?per_page=100`, { key: k.etagReviews, field }, armed);
		if (res.notModified) continue;
		const reviews = Array.isArray(res.json) ? res.json : [];

		let pr = byNumber.get(number) ?? null;
		for (const review of reviews) {
			if (typeof review?.id !== "number" || review.id <= cursor) continue;
			if (review.id > maxId) maxId = review.id;
			if (!armed) continue; // ARM WITHOUT REPLAY: learn the high-water mark, enqueue nothing.

			// Lazily, and at most once per PR per cycle: only a PR with a genuinely new review costs this.
			if (pr === null) {
				pr = (await api.get(`/repos/${repo}/pulls/${number}`)).json ?? null;
				byNumber.set(number, pr);
			}

			// The webhook's own payload shape, so the SAME parseSubset + filter decide. `sender` is the
			// REVIEWER, which is what keeps the bot-loop guard correct: a review the harness itself posted
			// carries our own id and drops as `self` before any gate runs. `state` arrives upper-case from
			// REST and parseSubset folds it; that fold is what makes this job identical to the webhook twin's.
			const payload = { action: "submitted", sender: { id: review.user?.id }, pull_request: pr, review, repository: { full_name: repo } };
			await gate(ctx, "pull_request_review", payload, `poll-rv${review.id}`, stats);
		}
	}

	// Once, after the whole sweep -- see the header of this function for why per-item would be wrong.
	// Arming ALWAYS writes, even at 0: a repo whose open PRs carry no reviews yet must still become armed,
	// or it stays on the `revalidate: false` path and re-fetches every PR in full, every cycle, forever.
	if (!armed) {
		await setWithTtl(ctx, k.reviews, String(maxId));
		ctx.out({ event: "poll_armed", repo, endpoint: "reviews", cursor: maxId });
	} else if (maxId !== cursor) {
		await setWithTtl(ctx, k.reviews, String(maxId));
	}
}

/**
 * The single choke point every synthesized payload passes through, and deliberately the receiver's
 * exact pipeline: parseSubset -> (closer-authority resolution, close deliveries only) -> filter
 * (UNCHANGED, same cfg/selfId) -> replica fanout -> enqueueGitHubJob, with the receiver's own log
 * shapes. Partial replica failure is idempotent for the same reason it is there: the failed cycle
 * re-runs, replicas 1..k-1 dedup on their taken jobIds.
 *
 * The authority step (issue #231) mirrors the webhook arm's placement exactly -- after the subset,
 * before the gate -- and `wantsCloserAuthority` is the same shared derivation, so only a close
 * delivery an armed close rule matches ever costs a lookup: it is false by construction for every
 * other source this module synthesizes (label, comment, PR diff, review), for a self-close, and for
 * a close nothing wants. A DETERMINATE answer rides into filter as the sixth argument, so a
 * stranger's close is the filter's own `closer-not-allowed` drop and the events cursor advances
 * past it -- an unauthorized close never wedges the feed.
 *
 * An INDETERMINATE lookup has no honest verdict, and the webhook arm's answer (503, forge
 * redelivers) has no analogue here -- the poller IS its own redelivery. So: bounded retry, then a
 * loud skip. Below the bound this THROWS, on purpose, into pollLabelEvents' scoped catch: the cycle
 * logs `poll_close_gate_retry`, the events cursor is still sitting BEFORE this event (the caller
 * advances it only after a handler returns), so the next cycle retries exactly this close -- and
 * only the EVENTS feed ends for the cycle, because a monotone cursor cannot skip an entry and come
 * back, while the comment and pull feeds run on their own cursors and must not starve behind a
 * close-gate spell. The attempt counter lives in redis (INCR + its own short TTL), not in memory,
 * so a restart mid-outage cannot reset the bound. AT the bound the close is dropped WITHOUT
 * enqueueing and the cursor advances: one close dropped loudly (`poll_close_gate_gave_up`, with the
 * delivery id an operator can act on) beats later label and close events wedged forever behind a
 * lookup that may never come back -- after ~20 cycles this is an outage, not a blip. A crash
 * between the give-up log and the cursor write re-logs the give-up once on restart (attempt 21):
 * self-limiting, and preferable to advancing before the operator has a line to act on. The counter
 * is not deleted on a determinate answer; its TTL decays it, and the cursor has moved past the
 * delivery id for good.
 */
async function gate(ctx, eventName, payload, deliveryId, stats) {
	const subset = parseSubset(payload);

	let closerAuthorized;
	if (wantsCloserAuthority(eventName, subset, ctx.cfg?.triggers?.github, ctx.selfId)) {
		const repo = subset.repository?.full_name;
		const resolved = await ctx.resolveCloserAuthority(repo, subset.sender?.login);
		if (resolved.indeterminate) {
			const counterKey = `poll:${repo}:close-gate:${deliveryId}`;
			const attempts = await ctx.redis.incr(counterKey);
			await ctx.redis.expire(counterKey, CLOSE_GATE_TTL_SECONDS);
			if (attempts < CLOSE_GATE_MAX_ATTEMPTS) {
				// The reason names the lookup, never the actor (no-pii-in-logs): resolver reasons are
				// fixed tokens, and this message becomes pollRepo's poll_repo_failed line.
				throw new Error(`closer permission lookup indeterminate (${resolved.indeterminate})`);
			}
			ctx.out({ event: "poll_close_gate_gave_up", repo, delivery: deliveryId, reason: resolved.indeterminate });
			return;
		}
		closerAuthorized = resolved.authorized;
	}

	const result = filter(eventName, subset, ctx.cfg, ctx.selfId, deliveryId, closerAuthorized);
	if (!result.enqueue) {
		ctx.out({ event: "dropped", delivery: deliveryId, reason: result.reason });
		return;
	}
	const replicas = result.job.replicas ?? 1;
	for (let i = 1; i <= replicas; i++) {
		await ctx.enqueue(replicas > 1 ? { ...result.job, replica: i } : result.job);
	}
	stats.enqueued += replicas;
	ctx.out({ event: "enqueued", delivery: deliveryId, repo: result.job.repo, target: `${result.job.target.type}#${result.job.target.number}`, flow: result.job.flow, replicas });
}

/**
 * The default app-source polling credential: a self-minted, UNSCOPED installation token, cached until
 * ~5 minutes before its 1-hour expiry.
 *
 * Two deliberate departures from the worker's mint, both explained by where the token goes. The
 * worker's `mintToken` scopes to ONE repo because its token enters a sandbox with adversarial text
 * (CONST-TOKEN-SCOPED-PER-JOB bounds that blast radius); this token never leaves this process, and it
 * must read every polled repo AND call GET /installation/repositories -- a scope no single-repo token
 * has. And the mint is a hand-rolled RS256 App JWT + one POST rather than @octokit/auth-app, because
 * the receiver package does not depend on that library and a hoisted import it never declared would
 * break a standalone install; the mint is small enough to own (node:crypto signs, fetch posts).
 */
function makeAppInstallationTokenFn(github, { fetchFn, readFile, now }) {
	let cached = null; // { token, expiresAtMs }
	return async () => {
		if (cached !== null && cached.expiresAtMs - now() > 5 * 60_000) return cached.token;
		// Inline key (GITHUB_APP_PRIVATE_KEY) when the operator supplied one, the file otherwise. The shared
		// loadGitHubAuth normalised and shape-checked it at load and refuses both-set, so there is nothing to
		// decide here (issue #208).
		const pem = github.privateKey ?? (await readFile(github.privateKeyPath, "utf8"));
		const jwt = appJwt(github.appId, pem, now());
		const res = await fetchFn(`${API_URL}/app/installations/${github.installationId}/access_tokens`, {
			method: "POST",
			headers: {
				accept: "application/vnd.github+json",
				"user-agent": "pi-dispatch-poller",
				"x-github-api-version": "2022-11-28",
				authorization: `Bearer ${jwt}`,
			},
		});
		if (!res.ok) throw new Error(`installation token mint -> HTTP ${res.status}`);
		const body = await res.json();
		if (typeof body?.token !== "string" || body.token === "") {
			// The money-hole invariant, same as get-token.mjs: an empty token must never flow onward.
			throw new Error("installation token mint returned no token");
		}
		cached = { token: body.token, expiresAtMs: Date.parse(body.expires_at ?? "") || now() + 55 * 60_000 };
		return cached.token;
	};
}

/** GitHub App JWT (RS256): iat backdated 60s for clock skew, 9-minute expiry (below the 10-min cap). */
function appJwt(appId, privateKeyPem, nowMs) {
	const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
	const iat = Math.floor(nowMs / 1000) - 60;
	const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat, exp: iat + 600, iss: String(appId) })}`;
	const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem).toString("base64url");
	return `${unsigned}.${signature}`;
}
