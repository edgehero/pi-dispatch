/**
 * The Forgejo/Gitea trigger gate. Pure, total, and offline-testable: this module imports nothing
 * side-effecting, does no I/O and never throws, so the security-critical decision can be exercised
 * without a server, a socket, or a queue.
 *
 * The evaluation ORDER is fail-closed and load-bearing, and is the same order both other gates use:
 *   0. A non-numeric `sender.id` is rejected FIRST. It must precede the `=== selfId` compare, because
 *      `undefined === selfId` is `false` and would fall through to enqueue -- failing OPEN on a malformed
 *      payload. Missing identity is a reject, never a pass.
 *   1. The bot-loop guard runs UNCONDITIONALLY, before any authority or label check. Under a hand-minted
 *      Forgejo token the harness IS a repository collaborator and would clear the gate, so a status
 *      comment it posts -- or its own push to a PR head, which fires `synchronized` -- is an event that
 *      passes: an unbounded paid recursion. Gating this drop behind the authority check reintroduces it.
 *   2. The authority gate, for EVERY trigger type.
 *   3. Only then route on event + action.
 *
 * WHY THE AUTHORITY GATE COVERS LABELS TOO, unlike GitHub's. On GitHub the label path needs no author
 * check because applying a label already required write access, so the label IS the approval. That is very
 * probably true on Forgejo as well -- issue #61 argues it, and Forgejo's permission model agrees on
 * inspection. It is not, however, something this project has verified against a running instance across
 * versions, and the cost of being wrong is a stranger starting paid jobs. So the gate does not rest on it:
 * `authorized` is required for every trigger type, and if the label really is self-gating then this check
 * is redundant rather than wrong. That is the cheaper direction to be wrong in.
 *
 * `authorized` is resolved by the receiver BEFORE this function (forgejo-members.mjs) and passed in,
 * occupying the slot `author_association` holds on the GitHub side: the lookup is a network call, and
 * putting a fetch inside the gate would destroy the purity that makes it testable.
 *
 * ACTIONS ARRIVE IN FORGEJO'S OWN WORDS and are mapped explicitly (forgejo-subset.mjs). A recognised
 * action that is not actionable drops under its OWN reason rather than as `unhandled-event`, so an
 * operator whose trigger never fires can tell "Forgejo said something we deliberately ignore" from "we did
 * not recognise this at all". `label_cleared` is the case that matters: removing a label must never start
 * a paid run, and it must be visible that it was seen and refused.
 */

import { escapeRegExp, firstMatchingRule, labelSet, matchedLabel, matchesRule } from "./predicate.mjs";
import { findCloseRule } from "./close.mjs";
import { isRecognizedAction, mapAction } from "./forgejo-subset.mjs";

const LABEL_ACTIONS = new Set(["opened", "labeled", "reopened"]);
const PR_ACTIONS = new Set(["labeled", "opened", "synchronize", "reopened"]);

/**
 * Decide. Returns `{ enqueue: false, reason }` or `{ enqueue: true, job }`.
 *
 * `subset` is a `parseForgejoSubset` projection; `triggers` is the forgejo rule group; `knownFlows` is the
 * whole file's flow vocabulary; `authorized` is the receiver's resolved verdict; `deliveryId` is the
 * `X-GitHub-Delivery` GUID, which Forgejo emits and keeps stable across its own retries.
 */
export function filterForgejo(eventName, subset, triggers, knownFlows, selfId, authorized, deliveryId) {
	// (0) Fail-closed on identity. MUST precede the self compare -- see header.
	if (typeof subset?.sender?.id !== "number") {
		return { enqueue: false, reason: "missing-sender-id" };
	}

	// (1) Bot-loop guard: unconditional, independent of the authority outcome below.
	if (subset.sender.id === selfId) {
		return { enqueue: false, reason: "self" };
	}

	// (2) The authority gate, for EVERY trigger type. Strict `!== true` so anything that is not an explicit
	// yes -- undefined, a stray truthy value, a resolver that returned the wrong shape -- refuses.
	if (authorized !== true) {
		return { enqueue: false, reason: "author-not-allowed" };
	}

	// (3) Map Forgejo's action word, then route. The mapping is what stops `label_updated` and
	// `synchronized` -- one letter from GitHub's words -- from falling out as unrecognised.
	const raw = subset.action;
	const group = triggers ?? {};
	// Recognised and deliberately ignored, versus never heard of. Two reasons, because they call for two
	// different operator responses: one is "that is not a trigger", the other is "check your action
	// vocabulary against your forge's".
	const unactionable = () => ({ enqueue: false, reason: isRecognizedAction(raw) ? "action-not-actionable" : "unhandled-event" });
	let resolved;

	if (eventName === "issue_comment") {
		// Deliberately OUTSIDE the action map. A comment's `created` is the same word on Forgejo as on
		// GitHub, and a comment carries no label semantics to translate -- mapping it would only create a
		// place for it to fall through.
		if (raw !== "created") return unactionable();
		resolved = routeComment(subset, group, knownFlows);
	} else {
		const action = mapAction(eventName, raw);
		if (action === null) return unactionable();
		if (eventName === "issues" && LABEL_ACTIONS.has(action)) {
			resolved = routeIssueLabel(subset, group);
		} else if (eventName === "issues" && action === "closed") {
			// The close trigger (issue #231). `group.issue` holds ONLY close rules (the loader admits no
			// other issue kind), and this arm can never contend with the label one: `closed` is not in
			// LABEL_ACTIONS and must not become so -- a close is a statement about an item, not a label move.
			resolved = routeIssueClose(subset, group, authorized);
		} else if (eventName === "pull_request" && raw === "closed") {
			// The RAW word, for routePullRequest's reason below: the close vocabulary is the forge's own
			// (PR_CLOSE_ACTIONS, which the loader validated the rule against). Checked BEFORE the PR_ACTIONS
			// arm, though today they cannot overlap; `group.prClose` was split from `group.pullRequest` at
			// load, so a close rule is unreachable from routePullRequest and vice versa.
			resolved = routePullRequestClose(subset, group, authorized);
		} else if (eventName === "pull_request" && PR_ACTIONS.has(action)) {
			// The RAW word, not the mapped one. A trigger file names actions in the forge's own vocabulary
			// (`label_updated`, `synchronized`) because that is what an operator reads in Forgejo's docs and
			// what the loader validates against -- so the rule match has to be against the same words. The
			// mapped action decided WHICH route; it must not also decide which rule.
			resolved = routePullRequest(subset, group, raw);
		} else {
			return { enqueue: false, reason: "unhandled-event" };
		}
	}

	if (!resolved.enqueue) return resolved; // carries the drop reason

	// The job literal mirrors the other two forges' exactly -- `repo`, `target`, `flow`, the three
	// conditional execution knobs, and a descriptive `trigger`. `sender.login` is in the subset but is NOT
	// carried here: it exists for the permission lookup and nowhere else, and this object is copied verbatim
	// into /job/event.json, which must stay free of personal data.
	const job = {
		repo: subset.repository?.full_name,
		target: resolved.target,
		// EXACTLY ONE of flow/command, decided by the matched rule (issue #189; the shared parser enforces
		// the exclusivity at load). A command rule dispatches a registered pi extension command instead of
		// resolving a flow, and its job must carry NO flow key at all. The spread keeps a flow rule's
		// literal byte-identical to what it always was -- the same move filter.mjs makes.
		...(resolved.command !== undefined ? { command: resolved.command } : { flow: resolved.flow }),
		...(resolved.packages !== undefined ? { packages: resolved.packages } : {}),
		...(resolved.image !== undefined ? { image: resolved.image } : {}),
		// The trigger's injected skills dir (REQ-PER-TRIGGER-SKILLS), at JOB level beside image/packages and
		// NEVER inside `trigger`. That placement is sharpest here of all: `trigger` is carried into
		// /job/event.json, and a worker-host path in an agent-readable file is the leak prepare-local's
		// basename(folder) restraint already exists to prevent.
		...(resolved.skillsDir !== undefined ? { skillsDir: resolved.skillsDir } : {}),
		// REQ-TRIGGER-SECRETS. Conditional exactly like skillsDir above, so a trigger that binds no
		// secret enqueues the job data it always has. The map holds REFERENCES, never values: the
		// receiver has no resolver and reaches no vault -- the worker resolves them pre-spend.
		...(resolved.secrets !== undefined ? { secrets: resolved.secrets } : {}),
		...(resolved.secretsProfile !== undefined ? { secretsProfile: resolved.secretsProfile } : {}),
		...(resolved.instructions !== undefined ? { instructions: resolved.instructions } : {}),
		...(resolved.resume !== undefined ? { resume: resolved.resume } : {}),
		// How many independent sandboxes race this flow (REQ-REPLICA-RUNS). At JOB level and conditional for the
		// reasons filter.mjs states in full: receiver.mjs reads this to decide how many times to enqueue, and an
		// unflagged job's data must stay byte-identical to today's.
		...(resolved.replicas !== undefined ? { replicas: resolved.replicas } : {}),
		trigger: {
			event: eventName,
			// Forgejo's OWN word, not our translation of it. The run record should say what the forge said.
			action: raw,
			deliveryId,
			sender: { id: subset.sender.id },
			matched: resolved.matched,
			...(resolved.comment ? { comment: resolved.comment } : {}),
		},
	};
	return { enqueue: true, job };
}

/** Issue label path: the label predicate selects, and the resolved permission has already gated. */
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
		secrets: rule.secrets,
		secretsProfile: rule.secretsProfile,
		instructions: rule.instructions,
		resume: rule.resume,
		replicas: rule.replicas,
		matched: { index: rule.index, type: "label", label: matchedLabel(L, rule.predicate) },
		target: { type: "issue", number: subset.issue?.number, title: subset.issue?.title, body: subset.issue?.body },
	};
}

/** Comment path. The authority gate above has already run, so this only has to match the phrase. */
function routeComment(subset, triggers, knownFlows) {
	const phrase = triggers.comment?.phrase;
	const body = subset.comment?.body;
	if (typeof phrase !== "string" || typeof body !== "string" || !body.includes(phrase)) {
		return { enqueue: false, reason: "no-trigger-phrase" };
	}
	// On a COMMAND rule (issue #189) the flow-resolution block below -- default flow, the `<phrase> <flow>`
	// trailing-word override, and the `no-flow` refusal -- is deliberately UNREACHABLE: the phrase alone
	// fires, and trailing comment text stays DATA (the handler reads the delivery via /job/event.json). An
	// active override would hand any authorized collaborator two levers the trigger's author never granted:
	// retarget the command onto a known flow by appending its name, or veto it (the `no-flow` arm) with a
	// word that resolves nowhere. Same rationale, same shape as filter.mjs's routeComment.
	const command = triggers.comment.command;
	let flow;
	if (command === undefined) {
		// Default to the configured flow; an explicit `<phrase> <flow>` overrides only when `<flow>` is a known
		// flow name, so a comment cannot summon an unlisted flow.
		flow = triggers.comment?.defaultFlow;
		const match = body.match(new RegExp(escapeRegExp(phrase) + "\\s+(\\S+)"));
		if (match && knownFlows?.has(match[1])) {
			flow = match[1];
		}
		if (flow === null || flow === undefined || flow === "") {
			return { enqueue: false, reason: "no-flow" };
		}
	}
	// `is_pull` is TOP-LEVEL on Forgejo, where GitHub carries `issue.pull_request`. Reading the wrong one
	// routes every pull-request comment as an issue, and the envelope then tells the agent to open
	// `pi/issue-<n>` for something that is already a pull request: wrong work, no error, and a run that
	// looks successful. The issue number IS the PR number here, exactly as on GitHub.
	const isPR = subset.isPull === true;
	return {
		enqueue: true,
		...(command !== undefined ? { command } : { flow }),
		packages: triggers.comment.packages,
		image: triggers.comment.image,
		skillsDir: triggers.comment.skillsDir,
		secrets: triggers.comment.secrets,
		secretsProfile: triggers.comment.secretsProfile,
		instructions: triggers.comment.instructions,
		resume: triggers.comment.resume,
		replicas: triggers.comment.replicas,
		matched: { index: triggers.comment.index, type: "comment", phrase },
		// The invoking comment rides on the trigger. No author_association: Forgejo has none, and the
		// authority that admitted this comment was resolved from the API, not read off the body.
		comment: { body: subset.comment.body },
		target: { type: isPR ? "pull_request" : "issue", number: subset.issue?.number, title: subset.issue?.title, body: subset.issue?.body },
	};
}

/** Pull-request path. `action` is Forgejo's OWN word, matching the vocabulary the loader validated. */
function routePullRequest(subset, triggers, action) {
	const pr = subset.pull_request;
	if (!pr) {
		return { enqueue: false, reason: "missing-pull-request" };
	}
	const L = labelSet(pr.labels);
	for (const rule of triggers.pullRequest ?? []) {
		if (!rule.actions.has(action)) continue;
		if (rule.predicate && !matchesRule(L, rule.predicate)) continue;
		return {
			enqueue: true,
			// A command rule (issue #189) skips flow resolution entirely: the rule match IS the dispatch.
			...(rule.command !== undefined ? { command: rule.command } : { flow: rule.flow }),
			packages: rule.packages,
			image: rule.image,
			skillsDir: rule.skillsDir,
			secrets: rule.secrets,
			secretsProfile: rule.secretsProfile,
			instructions: rule.instructions,
			resume: rule.resume,
			replicas: rule.replicas,
			matched: { index: rule.index, type: "pull_request", action },
			target: {
				type: "pull_request",
				number: pr.number,
				title: pr.title,
				body: pr.body,
				head: pr.head,
				base: pr.base,
			},
		};
	}
	return { enqueue: false, reason: "no-matching-pr-trigger" };
}

/**
 * Issue close path (issue #231). `findCloseRule` is the ONE derivation of "which close rule wants
 * this delivery" (close.mjs), shared with the receiver's pre-lookup check -- two hand-rolled copies
 * a network call apart is the drift that module's header warns against.
 *
 * The `closer-not-allowed` gate below is belt-and-braces and UNREACHABLE today: gate (2) in
 * `filterForgejo` already refused every non-true verdict before routing, and on a webhook close
 * delivery the SENDER is the closer, so the verdict that gate consumed is the closer's. It stays
 * anyway, because this route's own contract is the closer's authority: if the global gate ever moves,
 * or a resolver starts returning a shape it never has, a close must fail closed under its own token
 * rather than route on a stale assumption about the caller.
 */
function routeIssueClose(subset, triggers, authorized) {
	const number = subset.issue?.number;
	// Integer or refuse, the github arms' rule: an UNNARROWED rule matches an undefined number, so a
	// degenerate shape would otherwise enqueue a numberless target.
	if (!Number.isInteger(number)) {
		return { enqueue: false, reason: "missing-issue-number" };
	}
	// "closed" is PR_CLOSE_ACTIONS.forgejo -- the forge's own word, the one the loader validated the
	// rule's action list against, exactly as routePullRequest matches raw vocabulary.
	const found = findCloseRule(triggers.issue, "closed", number);
	if (found.rule === undefined) {
		return { enqueue: false, reason: found.reason };
	}
	if (authorized !== true) {
		return { enqueue: false, reason: "closer-not-allowed" };
	}
	const rule = found.rule;
	return {
		enqueue: true,
		...(rule.command !== undefined ? { command: rule.command } : { flow: rule.flow }),
		packages: rule.packages, // the MATCHED rule's fields -- rules in one file may differ on them
		image: rule.image,
		skillsDir: rule.skillsDir,
		secrets: rule.secrets,
		secretsProfile: rule.secretsProfile,
		instructions: rule.instructions,
		resume: rule.resume,
		replicas: rule.replicas,
		// `once: true` rides `matched` ONLY when armed (spreading false is a no-op), so the enqueue path
		// can see a disarm is owed without re-reading the rule table -- and a plain close rule's matched
		// record stays byte-identical to the other routes' shape.
		matched: { index: rule.index, type: "issue", action: "closed", number, ...(rule.once === true && { once: true }) },
		target: { type: "issue", number, title: subset.issue?.title, body: subset.issue?.body },
	};
}

/** PR close path (issue #231). Same shape and same belt-and-braces closer gate as routeIssueClose. */
function routePullRequestClose(subset, triggers, authorized) {
	const pr = subset.pull_request;
	// Object AND integer number, the github arm's rule: a shape without a usable number must refuse
	// before any rule is consulted.
	if (!pr || !Number.isInteger(pr.number)) {
		return { enqueue: false, reason: "missing-pull-request" };
	}
	const found = findCloseRule(triggers.prClose, "closed", pr.number);
	if (found.rule === undefined) {
		return { enqueue: false, reason: found.reason };
	}
	if (authorized !== true) {
		return { enqueue: false, reason: "closer-not-allowed" }; // unreachable behind gate (2) -- see routeIssueClose
	}
	const rule = found.rule;
	return {
		enqueue: true,
		...(rule.command !== undefined ? { command: rule.command } : { flow: rule.flow }),
		packages: rule.packages,
		image: rule.image,
		skillsDir: rule.skillsDir,
		secrets: rule.secrets,
		secretsProfile: rule.secretsProfile,
		instructions: rule.instructions,
		resume: rule.resume,
		replicas: rule.replicas,
		// No `number` on a PR close's matched record -- parallel to routePullRequest's, where the item
		// number is the target's business; the issue route carries it because the github design does.
		matched: { index: rule.index, type: "pull_request", action: "closed", ...(rule.once === true && { once: true }) },
		target: {
			type: "pull_request",
			number: pr.number,
			title: pr.title,
			body: pr.body,
			head: pr.head,
			base: pr.base,
		},
	};
}
