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
 * PR GATE (security-critical), three arms, and WHICH FIELD each reads is the load-bearing part:
 *   - `labeled` is self-gating: only collaborators can apply labels, so the label predicate IS the
 *     approval, exactly as on the issue label path. No author check at all, deliberately.
 *   - auto actions (`opened|synchronize|reopened`) fire only when the PR `author_association` is a
 *     collaborator, so a stranger's fork PR never auto-fires.
 *   - a submitted review (`review_submitted`, issue #66) fires on the REVIEWER's
 *     `review.author_association`, NEVER the PR author's. This is the first GitHub event where the actor
 *     and the PR author are DIFFERENT PEOPLE, which is why the auto-action shortcut of gating on the PR
 *     author does not carry: a collaborator reviewing a stranger's fork PR must run, and a stranger
 *     reviewing their own PR must not. Reading `pr.author_association` here inverts both halves at once.
 * All three are hard-coded here, never config-optional -- an ungated auto-trigger is an unbounded paid run
 * started by whoever opens a fork PR (CONST-TRIGGER-AUTHOR-GATE, job-budget rules).
 *
 * `selfId` is the numeric id of whichever identity posts as the harness (the App's bot user, or the PAT
 * user); `deliveryId` is the `X-GitHub-Delivery` GUID, carried into the job for downstream dedup.
 */
import { escapeRegExp, firstMatchingRule, labelSet, matchedLabel, matchesRule } from "./predicate.mjs";

const AUTHOR_ALLOWLIST = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const LABEL_ACTIONS = new Set(["opened", "labeled", "reopened"]);
const PR_ACTIONS = new Set(["labeled", "opened", "synchronize", "reopened"]);
const PR_AUTO_ACTIONS = new Set(["opened", "synchronize", "reopened"]);
// The triggers.json word for a submitted review, and the raw action GitHub sends on the
// `pull_request_review` event. They differ on purpose -- see the routing block below.
const REVIEW_ACTION = "review_submitted";
const REVIEW_EVENT_ACTION = "submitted";
// PR_AUTO_ACTIONS is deliberately NOT extended with REVIEW_ACTION: it exists only to select the
// `pr-author-not-allowed` drop reason, and the review path has reasons of its own.

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
	} else if (eventName === "pull_request_review" && action === REVIEW_EVENT_ACTION) {
		// A SECOND event name on the SAME route, not a fifth on.type (issue #66): a review is an event about
		// a pull request, and GitLab's analogue `approved` already rides on.type "pull_request", so a new
		// type would make one forge's review a type and the other's an action. The route is handed the
		// CANONICAL word because that is what triggers.json spells and what the rule loop matches --
		// `submitted` alone would be meaningless in a pull_request action list.
		//
		// `edited` and `dismissed` fall through to unhandled-event deliberately: an edit would re-fire on
		// text the harness has already been paid to read, and a dismissal removes a verdict rather than
		// stating one.
		resolved = routePullRequest(subset, triggers, REVIEW_ACTION);
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
		// EXACTLY ONE of flow/command, decided by the matched rule (issue #189; the shared parser enforces
		// the exclusivity at load). A command rule dispatches a registered pi extension command instead of
		// resolving a flow, and its job must carry NO flow key at all -- a present-and-undefined flow would
		// change the enqueued bytes for every consumer that serializes the job. The spread keeps a flow
		// rule's literal byte-identical to what it always was.
		...(resolved.command !== undefined ? { command: resolved.command } : { flow: resolved.flow }),
		...(resolved.packages !== undefined ? { packages: resolved.packages } : {}),
		...(resolved.image !== undefined ? { image: resolved.image } : {}),
		// The trigger's injected skills dir (REQ-PER-TRIGGER-SKILLS), at JOB level beside image/packages and
		// NEVER inside `trigger`. That placement is sharpest here of all: `trigger` is carried into
		// /job/event.json, and a worker-host path in an agent-readable file is the leak prepare-local's
		// basename(folder) restraint already exists to prevent.
		...(resolved.skillsDir !== undefined ? { skillsDir: resolved.skillsDir } : {}),
		...(resolved.instructions !== undefined ? { instructions: resolved.instructions } : {}),
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
			// The invoking review, present only on the review route (issue #66), sibling of `comment` and
			// carried for the same reason: without it a "Request changes: rename the helper" review starts a
			// job that cannot know what was asked. All four fields are named by INT-WEBHOOK-PAYLOAD-SUBSET and
			// the body stays DATA all the way down (CONST-ISSUE-TEXT-IS-DATA).
			//
			// NOTE the pair above: `event` is `pull_request_review` and `action` is the raw `submitted`,
			// byte-for-byte what GitHub sent. `matched.action` is the canonical `review_submitted`, because
			// `matched` names the triggers.json entry that fired rather than the payload. This is the first
			// GitHub case where the two differ, and INT-CONTAINER-JOB-INPUTS says so.
			...(resolved.review ? { review: resolved.review } : {}),
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
		// A command rule (issue #189) skips flow resolution entirely: the label match IS the dispatch.
		...(rule.command !== undefined ? { command: rule.command } : { flow: rule.flow }),
		packages: rule.packages, // the MATCHED rule's fields -- rules in one file may differ on them
		image: rule.image,
		skillsDir: rule.skillsDir,
		instructions: rule.instructions,
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
	// On a COMMAND rule (issue #189) the whole flow-resolution block below -- default flow, the `<phrase>
	// <flow>` trailing-word override, and the `no-flow` refusal -- is deliberately UNREACHABLE: the phrase
	// alone fires the command, and everything after it is comment DATA (the handler can read the full
	// delivery via /job/event.json), never a flow lookup. Routing trailing words through the override
	// would hand any collaborator two levers this trigger's author never granted: retarget the command
	// trigger onto a known flow by appending its name, or suppress it outright (the `no-flow` arm) with a
	// word that resolves nowhere. Which flows exist is the operator's file's business, not the commenter's.
	const command = triggers.comment.command;
	let flow;
	if (command === undefined) {
		// Default to the configured flow; an explicit `<phrase> <flow>` overrides only when `<flow>` is a
		// known flow name, so a comment cannot summon an unlisted flow.
		flow = triggers.comment.defaultFlow;
		const match = body.match(new RegExp(escapeRegExp(phrase) + "\\s+(\\S+)"));
		if (match && knownFlows?.has(match[1])) {
			flow = match[1];
		}
		if (flow === null || flow === undefined || flow === "") {
			return { enqueue: false, reason: "no-flow" };
		}
	}
	// An issue_comment on a PR carries issue.pull_request; its issue.number IS the PR number and the
	// issue title/body are the PR's. Route it as a pull_request target so the flow gets PR context and
	// does not mint a fresh pi/issue-<n> branch. head/base are absent here (not in the comment payload);
	// the flow resolves them from the number via `gh`.
	const isPR = subset.issue?.pull_request === true;
	return {
		enqueue: true,
		...(command !== undefined ? { command } : { flow }),
		// The single comment trigger IS the matched rule here, so its opt-in is the job's. A `<phrase>
		// <flow>` override changes WHICH flow runs, never which triggers.json entry authorized it.
		packages: triggers.comment.packages,
		image: triggers.comment.image,
		skillsDir: triggers.comment.skillsDir,
		instructions: triggers.comment.instructions,
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
 * Whether the actor behind a PR event clears the write-access gate -- and WHICH actor that is.
 *
 * One expression rather than a branch inside the rule loop, deliberately (issue #66). A review is the
 * REVIEWER's say-so, never the PR author's: a collaborator reviewing a stranger's fork PR must run, and a
 * stranger reviewing their own PR must not. Reading `pr.author_association` for a review inverts both
 * halves at once, and an `authorOk` that means two different things depending on which `if` you are
 * standing in is exactly how that inversion gets silently reintroduced later. `labeled` reaches neither
 * branch: it is gated by its label predicate instead.
 */
function prAuthorOk(action, pr, review) {
	if (action === REVIEW_ACTION) return AUTHOR_ALLOWLIST.has(review?.author_association);
	return AUTHOR_ALLOWLIST.has(pr?.author_association);
}

/**
 * A `commented` review carrying nothing to act on.
 *
 * A review made only of INLINE comments arrives here with an empty body, because those comments ride
 * `pull_request_review_comment` -- an event this project does not ingest. The payload carries no
 * line-comment count and this module is pure, so it cannot tell "empty because it has line comments" from
 * "empty because it is empty", and buying a container for an empty string is the worse of the two errors.
 * The residual (a Comment-type review of line comments only never fires) is stated in SECURITY.md rather
 * than left to a drop reason.
 *
 * `approved` and `changes_requested` still fire with no body: there the verdict IS the signal.
 * Case-insensitive on `state` as belt-and-braces; `parseSubset` has already folded it.
 */
function isEmptyCommentedReview(review) {
	return String(review?.state ?? "").toLowerCase() === "commented" && String(review?.body ?? "").trim() === "";
}

/**
 * Pull-request path, three gates by action. `labeled` is gated by the label predicate
 * (collaborator-applied label = approval); auto actions (`opened|synchronize|reopened`) by the PR
 * author_association; `review_submitted` by the REVIEWER's (see `prAuthorOk`). All hard-coded, never
 * config-optional. A trigger's optional predicate only narrows; an empty predicate is vacuously true.
 * First matching rule (in file order) wins.
 */
function routePullRequest(subset, triggers, action) {
	const pr = subset.pull_request;
	if (pr === null || typeof pr !== "object") {
		return { enqueue: false, reason: "missing-pull-request" };
	}
	const L = labelSet(pr.labels);
	const isReview = action === REVIEW_ACTION;
	const review = subset.review;
	const authorOk = prAuthorOk(action, pr, review);

	// The review path refuses BEFORE the rule loop, in the order routeComment uses (author, then is there
	// anything to act on, then which rule). Two consequences worth stating rather than discovering:
	// security beats content when both are true, so a stranger's empty review reports the author refusal;
	// and an operator with no review rule armed sees these reasons rather than `no-matching-pr-trigger`,
	// which `pr-author-not-allowed` below already does and which is the right trade -- "nobody may start a
	// job this way" and "there is nothing here to act on" are both facts about the DELIVERY, true whatever
	// the trigger file says.
	if (isReview) {
		if (!authorOk) return { enqueue: false, reason: "review-author-not-allowed" };
		if (isEmptyCommentedReview(review)) return { enqueue: false, reason: "no-review-body" };
	}

	let stateSkipped = false;
	for (const rule of triggers.pullRequest ?? []) {
		if (!rule.actions.has(action)) continue;
		if (action === "labeled") {
			if (!matchesRule(L, rule.predicate)) continue;
		} else {
			// Auto action or review -- author_association is the hard gate; the predicate (if any) narrows.
			if (!authorOk) continue;
			if (!matchesRule(L, rule.predicate)) continue;
		}
		// The optional `on.reviewState` narrowing, checked LAST among a rule's tests so the flag below means
		// the verdict was the ONLY thing that failed. Unnarrowed rules carry null and fire on every verdict.
		if (isReview && rule.reviewStates !== null && rule.reviewStates !== undefined && !rule.reviewStates.has(review?.state)) {
			stateSkipped = true;
			continue;
		}
		return {
			enqueue: true,
			// A command rule (issue #189) skips flow resolution entirely: the rule match IS the dispatch.
			...(rule.command !== undefined ? { command: rule.command } : { flow: rule.flow }),
			packages: rule.packages, // the MATCHED rule's fields -- rules in one file may differ on them
			image: rule.image,
			skillsDir: rule.skillsDir,
			instructions: rule.instructions,
			resume: rule.resume,
			replicas: rule.replicas,
			matched: { index: rule.index, type: "pull_request", action },
			...(isReview ? { review: { id: review.id, body: review.body, state: review.state, author_association: review.author_association } } : {}),
			target: buildPrTarget(pr),
		};
	}

	// "Your rule exists, this verdict was not in your list" is a different operator response from "no rule
	// matched at all", so it gets its own reason -- the same call filter-forgejo.mjs makes for a recognised
	// but unactionable action.
	if (stateSkipped) {
		return { enqueue: false, reason: "review-state-not-matched" };
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
