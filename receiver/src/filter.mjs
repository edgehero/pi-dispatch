/**
 * The trigger gate: decide whether a verified webhook becomes a paid agent job, and if so with what
 * shape. This is CONST-TRIGGER-AUTHOR-GATE made executable -- the independent controls it names (label
 * allowlist, comment author_association, pull_request author gate, bot-loop guard) plus the
 * INT-WEBHOOK-PAYLOAD-SUBSET extraction that keeps the job carrying only the named fields.
 *
 * Pure and total: imports nothing, touches no I/O, and NEVER throws. A rejected event returns
 * `{ enqueue: false, reason }`; an accepted one returns `{ enqueue: true, job }`. Purity is the point --
 * the whole gate is decidable offline from its inputs, so the security-critical decision is unit testable
 * without a server, a socket, or a queue.
 *
 * The evaluation ORDER is fail-closed and load-bearing:
 *   0. A non-numeric `sender.id` is rejected FIRST. It must precede the `=== selfId` compare, because
 *      `undefined === selfId` is `false` and would fall through to enqueue -- failing OPEN on a
 *      malformed payload. Missing identity is a reject, never a pass.
 *   1. The bot-loop guard (`sender.id === selfId`) runs UNCONDITIONALLY, before any author/label check.
 *      Under a PAT the harness is repo OWNER and would clear the author gate, so a completion comment the
 *      harness posts -- or the flow's own push to a PR head, which fires `pull_request.synchronize` -- is
 *      an event that passes the gate: an unbounded paid recursion. Gating this drop behind the author
 *      check would reintroduce exactly that loop.
 *   2. Only then route on event + action: issue label, author-gated comment, or pull_request.
 *
 * PR AUTHOR GATE (security-critical): auto actions (`opened|synchronize|reopened`) fire ONLY when the PR
 * `author_association` is a collaborator. This is hard-coded here, never config-optional -- a fork PR from
 * a stranger would otherwise launch an unbounded paid run (CONST-TRIGGER-AUTHOR-GATE, job-budget rules).
 * PR labeling is self-gating: only collaborators can apply labels, so the label predicate IS the approval,
 * exactly as on the issue label path.
 *
 * `selfId` is the numeric id of whichever identity posts as the harness (the App's bot user, or the PAT
 * user); `deliveryId` is the `X-GitHub-Delivery` GUID, carried into the job for downstream dedup.
 */
import { escapeRegExp, firstMatchingRule, labelSet, matchedLabel, matchesRule } from "./predicate.mjs";

const AUTHOR_ALLOWLIST = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const LABEL_ACTIONS = new Set(["opened", "labeled", "reopened"]);
const PR_ACTIONS = new Set(["labeled", "opened", "synchronize", "reopened"]);
const PR_AUTO_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export function filter(eventName, subset, cfg, selfId, deliveryId) {
	// (0) Fail-closed on identity. MUST precede the self compare -- see header, ordering constraint.
	if (typeof subset?.sender?.id !== "number") {
		return { enqueue: false, reason: "missing-sender-id" };
	}

	// (1) Bot-loop guard: unconditional, independent of the author/label outcome below.
	if (subset.sender.id === selfId) {
		return { enqueue: false, reason: "self" };
	}

	// (2) Route on event + action -> resolve { flow, target } or a drop reason.
	// Only the GITHUB rule group is ever read here: rules are grouped per forge at load
	// (receiver/src/config.mjs), so a rule an operator wrote for another forge is not merely unmatched,
	// it is unreachable from this gate.
	const action = subset.action;
	const triggers = cfg?.triggers?.github ?? {};
	let resolved;

	if (eventName === "issues" && LABEL_ACTIONS.has(action)) {
		resolved = routeIssueLabel(subset, triggers);
	} else if (eventName === "issue_comment" && action === "created") {
		resolved = routeComment(subset, triggers, cfg?.triggers?.knownFlows);
	} else if (eventName === "pull_request" && PR_ACTIONS.has(action)) {
		resolved = routePullRequest(subset, triggers, action);
	} else {
		return { enqueue: false, reason: "unhandled-event" };
	}

	if (!resolved.enqueue) return resolved; // carries the drop reason

	// (3) Build the job from the INT-WEBHOOK-PAYLOAD-SUBSET fields only. No sender.login (not in the
	// subset), no provider/model/maxTurns (the worker fills defaults), no field outside the subset --
	// with two trigger-context additions (issue #49): `matched` is harness-computed, the filter's own
	// decision record naming the triggers.json entry that fired (not payload data at all); `comment`,
	// present only on the comment route, carries the invoking comment's body/author_association, both
	// fields INT-WEBHOOK-PAYLOAD-SUBSET already names.
	//
	// `packages` and `image` are harness-computed EXECUTION knobs read off the matched triggers.json entry
	// (like `matched`), never payload data -- REQ-GLOBAL-PI-OVERLAY's per-trigger control over loading the
	// operator-staged pi packages, and INT-TRIGGERS-FILE-CONTRACT's per-trigger container image. Both sit at
	// JOB level, NOT inside `trigger`: `trigger` is the descriptive context object carried verbatim into
	// /job/event.json (INT-CONTAINER-JOB-INPUTS) and must stay descriptive, so an execution switch has no
	// business there. Both are omitted entirely when the matched rule did not set them, so an unflagged
	// trigger's job literal is byte-identical to today's.
	const job = {
		repo: subset.repository?.full_name,
		target: resolved.target,
		flow: resolved.flow,
		...(resolved.packages !== undefined ? { packages: resolved.packages } : {}),
		...(resolved.image !== undefined ? { image: resolved.image } : {}),
		// Conditional like packages/image, and for the same reason: an unflagged job's data must stay
		// byte-identical to today's, so the key is absent rather than present-and-undefined.
		...(resolved.resume !== undefined ? { resume: resolved.resume } : {}),
		// How many independent sandboxes race this flow (REQ-REPLICA-RUNS). At JOB level like the rest, never
		// inside `trigger`, and for the sharpest version of that reason: this is the caller's fanout count --
		// receiver.mjs reads it to decide how many times to enqueue -- and a descriptive context object copied
		// into /job/event.json is no place for the number of jobs to create.
		...(resolved.replicas !== undefined ? { replicas: resolved.replicas } : {}),
		trigger: {
			event: eventName,
			action,
			deliveryId,
			sender: { id: subset.sender.id },
			matched: resolved.matched,
			...(resolved.comment ? { comment: resolved.comment } : {}),
		},
	};
	return { enqueue: true, job };
}

/** Issue label path: the label allowlist IS the human approval gate -- only collaborators can label. */
function routeIssueLabel(subset, triggers) {
	const L = labelSet(subset.issue?.labels);
	const rule = firstMatchingRule(triggers.label, L);
	if (rule === undefined) {
		return { enqueue: false, reason: "no-allowlisted-label" };
	}
	return {
		enqueue: true,
		flow: rule.flow,
		packages: rule.packages, // the MATCHED rule's fields -- rules in one file may differ on them
		image: rule.image,
		resume: rule.resume,
		replicas: rule.replicas,
		matched: { index: rule.index, type: "label", label: matchedLabel(L, rule.predicate) },
		target: { type: "issue", number: subset.issue?.number, title: subset.issue?.title, body: subset.issue?.body },
	};
}

/**
 * Comment path: author_association is the approval gate (no label event to carry it).
 *
 * `knownFlows` is passed separately because it is NOT a per-forge rule -- it is the whole file's flow
 * vocabulary, and it bounds which names a comment may summon rather than which rules may match.
 */
function routeComment(subset, triggers, knownFlows) {
	if (!AUTHOR_ALLOWLIST.has(subset.comment?.author_association)) {
		return { enqueue: false, reason: "author-not-allowed" };
	}
	const phrase = triggers.comment?.phrase;
	const body = subset.comment?.body;
	if (typeof phrase !== "string" || typeof body !== "string" || !body.includes(phrase)) {
		return { enqueue: false, reason: "no-trigger-phrase" };
	}
	// Default to the configured flow; an explicit `<phrase> <flow>` overrides only when `<flow>` is a
	// known flow name, so a comment cannot summon an unlisted flow.
	let flow = triggers.comment?.defaultFlow;
	const match = body.match(new RegExp(escapeRegExp(phrase) + "\\s+(\\S+)"));
	if (match && knownFlows?.has(match[1])) {
		flow = match[1];
	}
	if (flow === null || flow === undefined || flow === "") {
		return { enqueue: false, reason: "no-flow" };
	}
	// An issue_comment on a PR carries issue.pull_request; its issue.number IS the PR number and the
	// issue title/body are the PR's. Route it as a pull_request target so the flow gets PR context and
	// does not mint a fresh pi/issue-<n> branch. head/base are absent here (not in the comment payload);
	// the flow resolves them from the number via `gh`.
	const isPR = subset.issue?.pull_request === true;
	return {
		enqueue: true,
		flow,
		// The single comment trigger IS the matched rule here, so its opt-in is the job's. A `<phrase>
		// <flow>` override changes WHICH flow runs, never which triggers.json entry authorized it.
		packages: triggers.comment.packages,
		image: triggers.comment.image,
		resume: triggers.comment.resume,
		replicas: triggers.comment.replicas,
		matched: { index: triggers.comment.index, type: "comment", phrase },
		// The invoking comment rides on the trigger: body and author_association are both named by
		// INT-WEBHOOK-PAYLOAD-SUBSET, and the body stays DATA all the way down (CONST-ISSUE-TEXT-IS-DATA).
		comment: { body: subset.comment.body, author_association: subset.comment.author_association },
		target: { type: isPR ? "pull_request" : "issue", number: subset.issue?.number, title: subset.issue?.title, body: subset.issue?.body },
	};
}

/**
 * Pull-request path. `labeled` is gated by the label predicate (collaborator-applied label = approval);
 * auto actions (`opened|synchronize|reopened`) are gated by the PR author_association (hard-coded, never
 * config-optional). A trigger's optional predicate only narrows an auto action; an empty predicate is
 * vacuously true. First matching rule (in file order) wins.
 */
function routePullRequest(subset, triggers, action) {
	const pr = subset.pull_request;
	if (pr === null || typeof pr !== "object") {
		return { enqueue: false, reason: "missing-pull-request" };
	}
	const L = labelSet(pr.labels);
	const authorOk = AUTHOR_ALLOWLIST.has(pr.author_association);

	for (const rule of triggers.pullRequest ?? []) {
		if (!rule.actions.has(action)) continue;
		if (action === "labeled") {
			if (!matchesRule(L, rule.predicate)) continue;
		} else {
			// Auto action -- author_association is the hard gate; the predicate (if any) narrows scope.
			if (!authorOk) continue;
			if (!matchesRule(L, rule.predicate)) continue;
		}
		return {
			enqueue: true,
			flow: rule.flow,
			packages: rule.packages, // the MATCHED rule's fields -- rules in one file may differ on them
			image: rule.image,
			resume: rule.resume,
			replicas: rule.replicas,
			matched: { index: rule.index, type: "pull_request", action },
			target: buildPrTarget(pr),
		};
	}

	// Surface the security-relevant author drop distinctly from a plain no-match so it is observable.
	if (PR_AUTO_ACTIONS.has(action) && !authorOk) {
		return { enqueue: false, reason: "pr-author-not-allowed" };
	}
	return { enqueue: false, reason: "no-matching-pr-trigger" };
}

/** Build the pull_request target. head/base are carried as DATA only -- never a clone ref (see header). */
function buildPrTarget(pr) {
	const target = { type: "pull_request", number: pr.number, title: pr.title, body: pr.body };
	if (pr.head) target.head = { ref: pr.head.ref, sha: pr.head.sha, repo: pr.head.repo?.full_name };
	if (pr.base) target.base = { ref: pr.base.ref };
	return target;
}
