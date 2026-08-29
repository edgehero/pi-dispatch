/**
 * The webhook receiver: a thin producer that turns a verified forge webhook into (at most) one queued
 * job -- or, when the matched trigger opted into `run.replicas`, into exactly that many independent ones
 * (REQ-REPLICA-RUNS, on every forge since #187; the poller stays github-only, so replicas on the other
 * three arrive by webhook alone). It composes the three pieces that own the hard parts -- `makeVerifiedHandler` (the
 * HMAC trust boundary), `filter` (the trigger/author gate), and the SHARED `enqueueGitHubJob` -- and adds
 * only the glue: parse the verified body, project the payload subset, route on the filter's verdict, and
 * map the outcome to a status code.
 *
 * DES-TRIGGER-OUTSIDE-PI: the trigger lives outside pi. This module imports the shared `enqueueGitHubJob`
 * and never re-implements `queue.add` -- the queue's jobId/dedup/retention policy has exactly one owner,
 * so there is no drift between what the receiver enqueues and what every other producer does.
 *
 * no-pii-in-logs: logs carry stable non-PII identifiers only -- the delivery GUID, repo full_name, issue
 * number, flow, and a drop/failure reason. Never an issue title/body, a comment body, or a login.
 *
 * DES-ADMIN-VIA-PI-EXTENSION: the receiver exposes only the webhook handler. There is no admin,
 * dashboard, or admin-extension route here -- the admin surface is a pi extension in the operator's
 * session and binds no port.
 */

import { makeVerifiedHandler } from "./verify.mjs";
import { filter, wantsCloserAuthority } from "./filter.mjs";
import { enqueueForgeJob, enqueueGitHubJob, enqueueGitLabJob } from "@edgehero/pi-dispatch/queue";
import { filterGitLab } from "./filter-gitlab.mjs";
import { parseGitLabSubset } from "./gitlab-subset.mjs";
import { makeGitLabVerifiedHandler } from "./verify-gitlab.mjs";
import { filterForgejo } from "./filter-forgejo.mjs";
import { parseForgejoSubset } from "./forgejo-subset.mjs";
import { filterAzure } from "./filter-azure.mjs";
import { parseAzureSubset } from "./azure-subset.mjs";
import { makeAzureVerifiedHandler } from "./verify-azure.mjs";

/** Write a small JSON body with an explicit status; a 204 carries no body. verify's `respond` is private. */
function respond(res, status, obj) {
	if (status === 204) {
		res.writeHead(204);
		res.end();
		return;
	}
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(obj ?? {}));
}

/**
 * Project ONLY the INT-WEBHOOK-PAYLOAD-SUBSET fields out of a parsed webhook payload. Nothing outside
 * this set flows onward to the filter or the job: the subset is the whole surface the trigger decision
 * and the enqueued job are allowed to see.
 */
export function parseSubset(payload) {
	const pr = payload.pull_request;
	return {
		action: payload.action,
		// `login` is CARRIED since issue #231, where this subset deliberately excluded it before. It is
		// personal data, and it is here for exactly one consumer -- the CLOSER's collaborator-permission
		// lookup, which is by username because that is the only key GitHub's endpoint takes. Same
		// justification, and same obligation, as `sender.login` in the Forgejo subset: it exists to have
		// been asked about, it is never logged (no-pii-in-logs covers everything the resolution path
		// writes down), and it is never enqueued -- the filter's job literal keeps `trigger.sender` at
		// `{ id }` alone.
		sender: { id: payload.sender?.id, login: payload.sender?.login },
		issue: {
			number: payload.issue?.number,
			title: payload.issue?.title,
			body: payload.issue?.body,
			labels: Array.isArray(payload.issue?.labels) ? payload.issue.labels.map((l) => ({ name: l?.name })) : [],
			// Presence marker only: an issue_comment on a PR carries issue.pull_request, so the comment path
			// routes it as a pull_request target. A boolean keeps a URL/login out of the subset.
			pull_request: payload.issue?.pull_request != null,
		},
		comment: { body: payload.comment?.body, author_association: payload.comment?.author_association },
		// pull_request event fields (labeled/opened/synchronize/reopened). head/base are attacker-controlled
		// fork DATA -- projected for the flow's event.json, NEVER used as a clone ref (the worker clones the
		// base default-branch SHA). Absent for non-PR events.
		pull_request: pr
			? {
					number: pr.number,
					title: pr.title,
					body: pr.body,
					author_association: pr.author_association,
					labels: Array.isArray(pr.labels) ? pr.labels.map((l) => ({ name: l?.name })) : [],
					head: { ref: pr.head?.ref, sha: pr.head?.sha, repo: { full_name: pr.head?.repo?.full_name } },
					base: { ref: pr.base?.ref },
				}
			: undefined,
		// pull_request_review event fields (issue #66). Shape-gated like `pull_request` above rather than
		// event-gated, for the same reason: this function never sees the event name, and a payload either
		// carries a review or it does not.
		//
		// `id` is here because a review's INLINE comments ride `pull_request_review_comment`, an event this
		// project deliberately does not ingest -- so the id is the only handle a flow has on them. No
		// `review.user`: the bot-loop guard reads `sender.id` and nothing else, a second identity field is a
		// second thing to keep in sync, and a login is PII with no reader (see issue.pull_request above).
		review: payload.review
			? {
					id: payload.review.id,
					body: payload.review.body,
					// Folded to lower case HERE, the one place both sources converge. The webhook sends
					// `approved`; GET /pulls/{n}/reviews sends `APPROVED`. The poller feeds this same function
					// with REST-derived payloads, so without the fold the identical logical review would produce
					// two different jobs depending on transport, and a polled `COMMENTED` would slip past the
					// empty-body check and buy a container for an empty string. (GitHub docs, not source at a
					// pin: filter.test.mjs drives both casings so the claim is pinned by behaviour.)
					state: typeof payload.review.state === "string" ? payload.review.state.toLowerCase() : payload.review.state,
					author_association: payload.review.author_association,
				}
			: undefined,
		repository: { full_name: payload.repository?.full_name },
	};
}

/**
 * Build the receiver's `node:http` handler.
 *
 * ROUTING BY PATH, not by header (issue #42). Each forge gets its own path, and with it its own secret and
 * its own trust regime, decided before a byte of the body is read. Discriminating on headers instead would
 * hand that choice to the sender: Forgejo emits `X-GitHub-*` on every delivery, so header-sniffing cannot
 * even tell two forges apart reliably, and a request that could select which gate it faced would always
 * select the weakest one available.
 *
 * `/` stays mapped to GitHub -- for a deployment that SERVES GitHub. Existing deployments configured their
 * webhook URL before any path existed, and silently 404-ing them would look exactly like the harness being
 * down, so the path itself never moves.
 *
 * A forge with no configuration gets no route at all -- not a route that answers 401. An endpoint that
 * responds to an unconfigured forge is an endpoint an operator can believe is armed. GitHub is no longer
 * the exception to that rule (issue #99): a GitLab-only / Forgejo-only / Azure-only deployment has
 * `cfg.servesGithub === false`, builds no github handler, and 404s `/`.
 *
 * The github arm is gated on `cfg.servesGithub` being TRUTHY, not on it not being `false`, and that
 * direction is load-bearing. `start.mjs` skips resolving the harness's GitHub identity when the property is
 * off, so a config object that somehow reached here without the property would otherwise mount `/` with
 * `selfId === undefined` -- a live endpoint whose bot-loop guard compares every `sender.id` against
 * undefined, i.e. never drops the harness's own comments. Absent property therefore means no route; the
 * failure of a forgotten property is a 404 an operator sees, never a paid recursion they get billed for.
 */
export function makeReceiver({ queue, selfId, cfg, log, gitlab = null, forgejo = null, azure = null, resolveAuthority }) {
	// Built only when the deployment serves GitHub. Construction is not free of the secret either: the
	// `new Webhooks({ secret })` inside makeVerifiedHandler throws "options.secret required" on an absent
	// one, so not building the arm is what lets a github-free deployment legitimately have no secret --
	// no placeholder, nothing papered over, and no handler holding a secret nobody chose.
	//
	// `resolveAuthority` is the GITHUB closer resolver (issue #231), riding top-level beside `selfId`
	// because github's dependencies always have -- the other forges bundle theirs in per-forge objects.
	// Optional, because only a close delivery an armed close rule matches ever consults it.
	const github = cfg.servesGithub ? makeGitHubHandler({ queue, selfId, cfg, log, resolveAuthority }) : null;

	// A TABLE, built once, rather than one `if` per forge. Two forges made that a single branch; four make
	// it a chain, and a chain is where one arm quietly ends up checked after the fallthrough. A path present
	// with a null handler is a CONFIGURED-OFF forge and answers 404; a path absent from the table entirely
	// falls through to GitHub, which is what keeps `/` working -- and a configured-off GitHub answers the
	// same 404 from the fallthrough itself, below.
	const routes = {
		"/gitlab": gitlab ? makeGitLabHandler({ queue, cfg, log, ...gitlab }) : null,
		"/forgejo": forgejo ? makeForgejoHandler({ queue, cfg, log, ...forgejo }) : null,
		"/azure": azure ? makeAzureHandler({ queue, cfg, log, ...azure }) : null,
	};

	return async function receiverHandler(req, res) {
		const path = pathOf(req.url);
		if (Object.hasOwn(routes, path)) {
			const handler = routes[path];
			// Not a 401. An endpoint that answers "unauthorized" for a forge nobody configured is an endpoint
			// an operator can believe is armed and merely mis-keyed.
			if (!handler) return respond(res, 404, { error: `${path.slice(1)} webhooks are not configured` });
			return await handler(req, res);
		}
		// The GitHub fallthrough (`/` and anything unrouted). Absent when the deployment serves no GitHub, and
		// 404 rather than 401 or 405 for the same reason the table's null arms are: a status that discusses
		// credentials or methods says "armed, and you got something wrong", and an operator who reads that
		// about an endpoint that cannot fire anything will go hunting for a mis-keyed secret for an hour. The
		// message is spelled out rather than derived from `path`, which is "/" here and would slice to nothing.
		if (!github) return respond(res, 404, { error: "github webhooks are not configured" });
		return await github(req, res);
	};
}

/** The path portion of a request URL, without query or trailing slash. Never throws on a malformed URL. */
function pathOf(url) {
	const raw = String(url ?? "/").split("?")[0];
	return raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/**
 * REPLICA FANOUT (REQ-REPLICA-RUNS). The one place a single delivery becomes more than one job, shared by
 * all four forge arms since #187 widened `run.replicas` past github.
 *
 * ONE body rather than four, for the reason `enqueueForgeJob` gives for collapsing its own wrappers
 * (queue.mjs): four copies is four places for one of them to be quietly weakened while every test stays
 * green. What would be weakened here is the `replicas > 1` conditional, whose whole job is byte-identity
 * for an unflagged delivery -- spread `replica: i` unconditionally in one arm and that forge's `data`, its
 * jobId and its dedup id all change for every ordinary job, with no test outside that forge to notice.
 *
 * Absent `replicas` is `1` and the call below is byte-identical to the single enqueue it replaced: no
 * `replica` key on the job, so the jobId, the dedup id and `data` are exactly what they were.
 *
 * PARTIAL FAILURE IS IDEMPOTENT BY CONSTRUCTION, which is why there is no compensating logic here: if
 * replica k throws, the caller's catch answers 503, the forge redelivers, replicas 1..k-1 dedup on their
 * own now-taken jobIds and k..n enqueue. The retry converges on exactly n jobs rather than n + (k-1).
 *
 * `enqueue` is a callback because the four arms spell their enqueue differently (a named github/gitlab
 * wrapper, or `enqueueForgeJob` with an explicit kind); the fanout itself is forge-blind.
 *
 * @returns {Promise<number>} how many jobs were enqueued, for the caller's `enqueued` log line.
 */
async function fanout(job, enqueue) {
	const replicas = job.replicas ?? 1;
	for (let i = 1; i <= replicas; i++) {
		await enqueue(replicas > 1 ? { ...job, replica: i } : job);
	}
	return replicas;
}

/**
 * The GitHub arm. Returns `makeVerifiedHandler`'s handler directly, so it only ever sees an already-verified
 * request. `onVerified` owns parse, filter, enqueue, and response; a good signature is the sole
 * precondition D2 guarantees before it runs.
 *
 * One step the pre-#231 arm did not have, and the ONLY GitHub path that pays a network call before the
 * gate: a close delivery an armed close rule matches has the CLOSER's authority resolved here, between
 * verification and the gate, because the payload carries no association for the closer at all
 * (github-members.mjs). `wantsCloserAuthority` is the same findCloseRule derivation the filter's route
 * uses, so a lookup is never spent on a delivery the gate then ignores -- every label, comment, PR and
 * review delivery, and every close nothing wants, stays payload-only and byte-identical to before.
 */
function makeGitHubHandler({ queue, selfId, cfg, log, resolveAuthority }) {
	return makeVerifiedHandler({ secret: cfg.webhookSecret }, async ({ rawBody, event, delivery }, res) => {
		let subset;
		try {
			subset = parseSubset(JSON.parse(rawBody));
		} catch {
			return respond(res, 400, { error: "invalid-json" });
		}

		let closerAuthorized;
		if (wantsCloserAuthority(event, subset, cfg?.triggers?.github, selfId)) {
			if (!resolveAuthority) {
				// Defensive only: unreachable in a wired receiver -- start.mjs hard-fails on github auth
				// before `/` is ever mounted, and the resolver is built over that same auth object. Fail
				// closed but RETRYABLE, because a wiring fault must not read on the wire as a stranger
				// being correctly refused.
				return respond(res, 503, { error: "permission-lookup-failed" });
			}
			const resolved = await resolveAuthority(subset.repository?.full_name, subset.sender?.login);
			if (resolved.indeterminate) {
				// The reason names the lookup, never the actor -- `sender.login` is personal data and exists
				// here only to have been asked about (no-pii-in-logs).
				log?.({ event: "github_permission_lookup_failed", delivery, reason: resolved.indeterminate });
				// 503: GitHub redelivers, the GUID jobId coalesces the retry. GitHub's auto-redelivery is
				// weaker than GitLab's, so a lookup outage outlasting the window can lose a webhook-only
				// deployment's close -- the polling transport's closed source is the backstop where the
				// poller runs, with its own bounded retry against the same lookup.
				return respond(res, 503, { error: "permission-lookup-failed" });
			}
			closerAuthorized = resolved.authorized;
		}

		const result = filter(event, subset, cfg, selfId, delivery, closerAuthorized);
		if (!result.enqueue) {
			log?.({ event: "dropped", delivery, reason: result.reason });
			return respond(res, 204);
		}

		// Fanout (REQ-REPLICA-RUNS) lives in `fanout` above; the 202/503 decision stays here, where it always was.
		let replicas;
		try {
			replicas = await fanout(result.job, (j) => enqueueGitHubJob(queue, j));
		} catch (err) {
			// Own try/catch so a Valkey-down enqueue is a 503 (retryable), not verify's outer 500.
			log?.({ event: "enqueue_failed", delivery, reason: err?.message });
			return respond(res, 503, { error: "enqueue-failed" }); // GitHub redelivers; dedup by GUID coalesces
		}

		log?.({ event: "enqueued", delivery, repo: result.job.repo, target: `${result.job.target.type}#${result.job.target.number}`, flow: result.job.flow, replicas });
		return respond(res, 202, { status: "queued" });
	});
}

/**
 * The GitLab arm. Same shape as the GitHub one -- verify, project, gate, enqueue, respond -- with one step
 * the GitHub path does not need: the actor's project access level is RESOLVED here, between verification
 * and the gate, because GitLab puts no `author_association` in the payload (gitlab-members.mjs).
 *
 * That resolution is a network call, and its three outcomes are deliberately not two:
 *   - a determinate verdict (authorized or not) is handed to the gate, which decides;
 *   - an INDETERMINATE lookup is a 503, so GitLab redelivers and the stable `webhook-id` dedups the
 *     retry. Answering 204 would drop real work during an outage, and it would look on the wire exactly
 *     like a stranger being correctly refused.
 * The lookup runs only for events that could still fire -- after verification, and after the payload has
 * been projected -- so an unauthenticated flood cannot make this project call GitLab at all.
 */
function makeGitLabHandler({ queue, cfg, log, mode, secret, selfId, resolveAuthority, now }) {
	return makeGitLabVerifiedHandler({ mode, secret, ...(now ? { now } : {}) }, async ({ rawBody, delivery }, res) => {
		let subset;
		try {
			subset = parseGitLabSubset(JSON.parse(rawBody));
		} catch {
			return respond(res, 400, { error: "invalid-json" });
		}

		const resolved = await resolveAuthority(subset.project?.id, subset.user?.id);
		if (resolved.indeterminate) {
			// The reason names the lookup, never the actor -- `user.username` is personal data and exists
			// only to have been asked about (no-pii-in-logs).
			log?.({ event: "gitlab_access_lookup_failed", delivery, reason: resolved.indeterminate });
			return respond(res, 503, { error: "access-lookup-failed" });
		}

		const result = filterGitLab(subset, cfg.triggers?.gitlab, cfg.triggers?.knownFlows, selfId, resolved.authorized, delivery);
		if (!result.enqueue) {
			log?.({ event: "dropped", delivery, reason: result.reason });
			return respond(res, 204);
		}

		let replicas;
		try {
			replicas = await fanout(result.job, (j) => enqueueGitLabJob(queue, j));
		} catch (err) {
			log?.({ event: "enqueue_failed", delivery, reason: err?.message });
			return respond(res, 503, { error: "enqueue-failed" }); // GitLab redelivers; dedup by webhook-id coalesces
		}

		// `!` for a merge request, `#` for an issue -- GitLab's own notation, and the same discrimination
		// the semantic dedup key makes, because the two are separate number sequences.
		const sep = result.job.target.type === "pull_request" ? "!" : "#";
		log?.({ event: "enqueued", delivery, repo: result.job.repo, target: `${result.job.repo}${sep}${result.job.target.number}`, flow: result.job.flow, replicas });
		return respond(res, 202, { status: "queued" });
	});
}

/**
 * The Forgejo arm. Structurally the GitLab one -- verify, project, RESOLVE, gate, enqueue, respond -- with
 * one difference that is worth stating because it is invisible in the code: the verification step is
 * GITHUB'S, unmodified.
 *
 * Forgejo signs the raw body with HMAC-SHA256 and sends `X-Hub-Signature-256`, `X-GitHub-Delivery` and
 * `X-GitHub-Event`, which is byte-for-byte what `makeVerifiedHandler` already reads. So
 * CONST-HMAC-OVER-RAW-BODY is satisfied here by EXISTING code rather than new code, and
 * REQ-DEDUP-BY-DELIVERY-GUID transfers with no adaptation at all. What Forgejo needs is its own SECRET,
 * which is why it is a separate handler and a separate path: `makeVerifiedHandler` closes over one secret
 * per construction, and serving two sources from one would mean either sharing a secret between forges or
 * letting the request choose which one it was checked against.
 */
function makeForgejoHandler({ queue, cfg, log, secret, selfId, resolveAuthority }) {
	return makeVerifiedHandler({ secret }, async ({ rawBody, event, delivery }, res) => {
		let subset;
		try {
			subset = parseForgejoSubset(JSON.parse(rawBody));
		} catch {
			return respond(res, 400, { error: "invalid-json" });
		}

		const resolved = await resolveAuthority(subset.repository?.full_name, subset.sender?.login);
		if (resolved.indeterminate) {
			// The reason names the lookup, never the actor -- `sender.login` is personal data and exists here
			// only to have been asked about (no-pii-in-logs).
			log?.({ event: "forgejo_permission_lookup_failed", delivery, reason: resolved.indeterminate });
			return respond(res, 503, { error: "permission-lookup-failed" });
		}

		const result = filterForgejo(event, subset, cfg.triggers?.forgejo, cfg.triggers?.knownFlows, selfId, resolved.authorized, delivery);
		if (!result.enqueue) {
			log?.({ event: "dropped", delivery, reason: result.reason });
			return respond(res, 204);
		}

		let replicas;
		try {
			replicas = await fanout(result.job, (j) => enqueueForgeJob(queue, "forgejo", j));
		} catch (err) {
			log?.({ event: "enqueue_failed", delivery, reason: err?.message });
			return respond(res, 503, { error: "enqueue-failed" }); // Forgejo redelivers; dedup by GUID coalesces
		}

		log?.({ event: "enqueued", delivery, repo: result.job.repo, target: `${result.job.target.type}#${result.job.target.number}`, flow: result.job.flow, replicas });
		return respond(res, 202, { status: "queued" });
	});
}

/**
 * The Azure DevOps arm. The same five steps, with two things no other arm has.
 *
 * THE DELIVERY ID COMES OUT OF THE BODY. Azure sends no delivery-id header, so the dedup key
 * (REQ-DEDUP-BY-DELIVERY-GUID) is the payload's own top-level `id` GUID. `verify-gitlab.mjs` refuses to do
 * this and 400s instead -- correctly, for a forge that HAS a header. Azure has none, so the choice is a
 * body-derived key or no dedup at all, and the ordering is unaffected: the body is parsed here, inside
 * `onVerified`, after the credential check. A delivery with no `id` is refused rather than run
 * undeduplicated.
 *
 * THE ACTOR MAY BE AN EMAIL. A pull-request delivery names a GUID; a work item names only
 * `"Display Name <email>"`. Both the resolver and the bot-loop guard handle both forms -- see
 * filter-azure.mjs, where the ordering constraint is stated in full.
 */
function makeAzureHandler({ queue, cfg, log, mode, secret, headerName, selfId, resolveAuthority }) {
	return makeAzureVerifiedHandler({ mode, secret, headerName }, async ({ rawBody }, res) => {
		let subset;
		try {
			subset = parseAzureSubset(JSON.parse(rawBody));
		} catch {
			return respond(res, 400, { error: "invalid-json" });
		}

		const delivery = subset.id;
		if (typeof delivery !== "string" || delivery === "") {
			// Without it there is no dedup key, and a redelivery would be billed as new work. A synthesised
			// key would dedup some redeliveries and bill for the rest -- a weaker guarantee wearing
			// REQ-DEDUP-BY-DELIVERY-GUID's name, which is worse than a clear refusal.
			return respond(res, 400, { error: "missing-delivery-id" });
		}

		const resolved = await resolveAuthority(subset.project?.id, subset.actor);
		if (resolved.indeterminate) {
			// The reason names the lookup, never the actor -- an email address is personal data and exists
			// here only to have been asked about (no-pii-in-logs).
			log?.({ event: "azure_membership_lookup_failed", delivery, reason: resolved.indeterminate });
			return respond(res, 503, { error: "membership-lookup-failed" });
		}

		const result = filterAzure(subset, cfg.triggers?.azure, cfg.triggers?.knownFlows, selfId, resolved.authorized, delivery);
		if (!result.enqueue) {
			log?.({ event: "dropped", delivery, reason: result.reason });
			return respond(res, 204);
		}

		let replicas;
		try {
			replicas = await fanout(result.job, (j) => enqueueForgeJob(queue, "azure", j));
		} catch (err) {
			log?.({ event: "enqueue_failed", delivery, reason: err?.message });
			return respond(res, 503, { error: "enqueue-failed" });
		}

		// `!` for a pull request, `#` for a work item -- Azure numbers them separately, and this is the same
		// discrimination the semantic dedup key makes.
		const sep = result.job.target.type === "pull_request" ? "!" : "#";
		log?.({ event: "enqueued", delivery, repo: result.job.repo, target: `${result.job.repo}${sep}${result.job.target.number}`, flow: result.job.flow, replicas });
		return respond(res, 202, { status: "queued" });
	});
}
