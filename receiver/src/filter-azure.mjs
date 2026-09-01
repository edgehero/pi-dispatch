/**
 * The Azure DevOps trigger gate. Pure, total, and offline-testable, like its three siblings.
 *
 * The evaluation ORDER is the same fail-closed one, but step 0 does more work here than anywhere else,
 * because Azure is the only forge that identifies an actor two different ways:
 *   0. The actor must resolve to a GUID or a parseable address. Neither is a reject.
 *   1. The bot-loop guard, UNCONDITIONALLY, before any authority or tag check.
 *   2. The authority gate, for every trigger type.
 *   3. Route on the event id.
 *
 * WHY STEP 0 IS THE SHARPEST HAZARD ON THIS FORGE. `filter.mjs` rejects a non-NUMBER `sender.id` first, and
 * its header explains why: `undefined === selfId` is false, so a malformed payload would fall through and
 * ENQUEUE. That guard is correct on GitHub precisely because it demands a number -- and Azure has no
 * numbers. A pull-request actor is a GUID string; a work-item actor is `"Display Name <email>"`. Relaxing
 * the type check is exactly where the fail-open comes back, so `selfId` here is a two-field
 * `{ id, email }` and the comparison is explicit on both, with neither side allowed to be empty. The
 * consequence of getting it wrong is the one `filter-gitlab.mjs:11` exists to prevent: the harness's own
 * work-item comments re-trigger jobs, whose comments re-trigger jobs.
 *
 * TAGS ARE MATCHED ON THE DIFF, NEVER THE SET. Azure has no `labeled` event; a tag change arrives as
 * `workitem.updated` carrying a `{ oldValue, newValue }` pair. Matching the current set would fire the
 * trigger again on every later edit of any field -- a paid run per typo fix, forever. `filter-gitlab.mjs`
 * documents this trap for GitLab's `changes.labels`; Azure is its second customer, and `no-label-change`
 * is the same drop reason on purpose.
 */

import { createHash } from "node:crypto";
import { escapeRegExp, firstMatchingRule, labelSet, matchedLabel, matchesRule } from "./predicate.mjs";
import { PR_COMMENT_EVENT, PR_EVENTS, WORK_ITEM_EVENTS } from "./azure-subset.mjs";

/** The `pull_request` actions a trigger may name, mirrored from the loader's azure vocabulary. */
const PR_ACTION_FOR = {
	"git.pullrequest.created": "created",
	"git.pullrequest.updated": "updated",
};

/**
 * Decide. Returns `{ enqueue: false, reason }` or `{ enqueue: true, job }`.
 *
 * `selfId` is `{ id, email }` -- see the header for why it is not one value.
 */
export function filterAzure(subset, triggers, knownFlows, selfId, authorized, deliveryId) {
	const actor = subset?.actor ?? {};
	const hasId = typeof actor.id === "string" && actor.id !== "";
	const hasEmail = typeof actor.email === "string" && actor.email !== "";

	// (0) Fail-closed on identity. MUST precede the self compare.
	if (!hasId && !hasEmail) {
		return { enqueue: false, reason: "missing-sender-id" };
	}

	// (1) Bot-loop guard, unconditional. Both forms are compared, and an EMPTY side never matches: a
	// deployment whose selfId resolved only one of the two must not silently match every actor on the
	// other.
	const selfGuid = typeof selfId?.id === "string" && selfId.id !== "" ? selfId.id : null;
	const selfEmail = typeof selfId?.email === "string" && selfId.email !== "" ? selfId.email.toLowerCase() : null;
	if ((hasId && selfGuid !== null && actor.id === selfGuid) || (hasEmail && selfEmail !== null && actor.email === selfEmail)) {
		return { enqueue: false, reason: "self" };
	}

	// (2) The authority gate, for EVERY trigger type. Strict `!== true`, so anything that is not an
	// explicit yes refuses.
	if (authorized !== true) {
		return { enqueue: false, reason: "author-not-allowed" };
	}

	// (3) Route on the Service Hook event id.
	const event = subset.eventType;
	const group = triggers ?? {};
	let resolved;

	if (WORK_ITEM_EVENTS.has(event)) {
		resolved = event === "workitem.commented" ? routeComment(subset, group, knownFlows, "issue") : routeWorkItemTag(subset, group, event);
	} else if (event === PR_COMMENT_EVENT) {
		resolved = routeComment(subset, group, knownFlows, "pull_request");
	} else if (PR_EVENTS.has(event)) {
		resolved = routePullRequest(subset, group, PR_ACTION_FOR[event]);
	} else {
		return { enqueue: false, reason: "unhandled-event" };
	}

	if (!resolved.enqueue) return resolved; // carries the drop reason

	// WHICH REPOSITORY the job clones. A pull-request event names its own and that is authoritative. A WORK
	// ITEM names none -- Azure work items belong to a project, and a project may hold many repositories --
	// so the matched rule's `run.repository` supplies it. The loader requires that field on exactly the
	// azure trigger types a work item can fire, so reaching here without one is not possible; the guard is
	// here anyway because "not possible" and "cannot happen" are different claims and only one is testable.
	const scope = resolveScope(subset, resolved);
	if (scope === null) {
		return { enqueue: false, reason: "no-repository" };
	}
	resolved.repo = scope.repo;
	resolved.azure = scope.azure;

	const job = {
		// `<project>/<repository>`, WITHOUT the organization -- exactly as a gitlab job's `repo` omits the
		// instance. A deployment has one AZURE_ORG_URL, so the org is constant across every azure job here
		// and repeating it in a pause-window scope and a run-record label would be noise, not information.
		repo: resolved.repo,
		// The structured triple the API paths need, alongside the human-readable label -- the same split
		// gitlab makes when it carries `projectId` next to `repo`.
		azure: resolved.azure,
		target: resolved.target,
		// EXACTLY ONE of flow/command, decided by the matched rule (issue #189; the shared parser enforces
		// the exclusivity at load). A command rule dispatches a registered pi extension command instead of
		// resolving a flow, and its job must carry NO flow key at all. The spread keeps a flow rule's
		// literal byte-identical to what it always was -- the same move filter.mjs makes.
		...(resolved.command !== undefined ? { command: resolved.command } : { flow: resolved.flow }),
		...(resolved.packages !== undefined ? { packages: resolved.packages } : {}),
		...(resolved.image !== undefined ? { image: resolved.image } : {}),
		// #227. A SEPARATE spread, and this is the whole of the bug it replaces: folded into the `image`
		// conditional above, a trigger that named a venue but no image had its venue silently dropped here --
		// it loaded, validated, reached this function on the rule, and then ran on the default. That is
		// exactly the destructive absence `validateBackend`'s near-miss sweep refuses a misspelling for,
		// arriving through the plumbing instead of the spelling, one file downstream of the guard.
		...(resolved.backend !== undefined ? { backend: resolved.backend } : {}),
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
		...(resolved.waitFor !== undefined ? { waitFor: resolved.waitFor } : {}),
		...(resolved.instructions !== undefined ? { instructions: resolved.instructions } : {}),
		...(resolved.resume !== undefined ? { resume: resolved.resume } : {}),
		// How many independent sandboxes race this flow (REQ-REPLICA-RUNS). At JOB level and conditional for the
		// reasons filter.mjs states in full: receiver.mjs reads this to decide how many times to enqueue, and an
		// unflagged job's data must stay byte-identical to today's.
		...(resolved.replicas !== undefined ? { replicas: resolved.replicas } : {}),
		trigger: {
			event,
			action: resolved.action,
			deliveryId,
			// A GUID when the delivery carried one, else a HASH of the address -- never the address itself.
			// A work-item payload offers nothing but `"Display Name <email>"`, and this object is copied
			// verbatim into /job/event.json and summarised into the durable run record, both of which are
			// PII-free BY CONSTRUCTION. Hashing keeps "the same actor twice" answerable without putting
			// somebody's email in a file the agent reads and an operator greps -- the same move
			// `session-key.mjs` makes for branch names.
			sender: { id: hasId ? actor.id : stableActorId(actor.email) },
			matched: resolved.matched,
			...(resolved.comment ? { comment: resolved.comment } : {}),
		},
	};
	return { enqueue: true, job };
}

/**
 * Work-item tag path. The DIFF is the trigger.
 *
 * `workitem.created` has no diff and is matched on the set it arrived with, which is correct and not an
 * exception: a work item created already carrying the tag has changed from having none.
 */
function routeWorkItemTag(subset, triggers, event) {
	if (event === "workitem.updated") {
		const changes = subset.tagChanges;
		if (changes === undefined) {
			// An update that changed no tags. Dropping it here is what stops every later edit of any field on
			// a tagged work item from starting another paid run.
			return { enqueue: false, reason: "no-label-change" };
		}
		// Verbatim, matching `labelSet`'s own semantics -- it does not case-fold, and a diff that did would
		// disagree with the predicate that runs against it two lines later.
		const previous = labelSet(changes.previous);
		const added = changes.current.filter((t) => !previous.has(t.name));
		if (added.length === 0) {
			// Tags changed, but only by REMOVAL. Removing a tag must never start a paid run -- the same rule
			// Forgejo's `label_cleared` gets.
			return { enqueue: false, reason: "no-label-change" };
		}
		return matchLabelRules(subset, triggers, added, "updated");
	}
	return matchLabelRules(subset, triggers, subset.tags ?? [], "created");
}

function matchLabelRules(subset, triggers, labels, action) {
	const L = labelSet(labels);
	const rule = firstMatchingRule(triggers.label, L);
	if (rule === undefined) {
		return { enqueue: false, reason: "no-allowlisted-label" };
	}
	return {
		enqueue: true,
		action,
		// A command rule (issue #189) skips flow resolution entirely: the tag match IS the dispatch.
		...(rule.command !== undefined ? { command: rule.command } : { flow: rule.flow }),
		repository: rule.repository,
		packages: rule.packages,
		image: rule.image, backend: rule.backend,
		skillsDir: rule.skillsDir,
		secrets: rule.secrets,
		secretsProfile: rule.secretsProfile,
		waitFor: rule.waitFor,
		instructions: rule.instructions,
		resume: rule.resume,
		replicas: rule.replicas,
		matched: { index: rule.index, type: "label", label: matchedLabel(L, rule.predicate) },
		target: { type: "issue", number: subset.target?.number, title: subset.target?.title, body: subset.target?.body },
	};
}

/** Comment path, on either a work item or a pull request. The authority gate above has already run. */
function routeComment(subset, triggers, knownFlows, targetType) {
	const phrase = triggers.comment?.phrase;
	const body = subset.comment;
	if (typeof phrase !== "string" || typeof body !== "string" || !body.includes(phrase)) {
		return { enqueue: false, reason: "no-trigger-phrase" };
	}
	// On a COMMAND rule (issue #189) the flow-resolution block below -- default flow, the `<phrase> <flow>`
	// trailing-word override, and the `no-flow` refusal -- is deliberately UNREACHABLE: the phrase alone
	// fires, and trailing comment text stays DATA (the handler reads the delivery via /job/event.json). An
	// active override would hand any authorized member two levers the trigger's author never granted:
	// retarget the command onto a known flow by appending its name, or veto it (the `no-flow` arm) with a
	// word that resolves nowhere. Same rationale, same shape as filter.mjs's routeComment.
	const command = triggers.comment.command;
	let flow;
	if (command === undefined) {
		flow = triggers.comment?.defaultFlow;
		const match = body.match(new RegExp(escapeRegExp(phrase) + "\\s+(\\S+)"));
		if (match && knownFlows?.has(match[1])) {
			flow = match[1];
		}
		if (flow === null || flow === undefined || flow === "") {
			return { enqueue: false, reason: "no-flow" };
		}
	}
	return {
		enqueue: true,
		action: "commented",
		...(command !== undefined ? { command } : { flow }),
		repository: triggers.comment.repository,
		packages: triggers.comment.packages,
		image: triggers.comment.image, backend: triggers.comment.backend,
		skillsDir: triggers.comment.skillsDir,
		secrets: triggers.comment.secrets,
		secretsProfile: triggers.comment.secretsProfile,
		waitFor: triggers.comment.waitFor,
		instructions: triggers.comment.instructions,
		resume: triggers.comment.resume,
		replicas: triggers.comment.replicas,
		matched: { index: triggers.comment.index, type: "comment", phrase },
		// No author_association: Azure has none, and the authority that admitted this comment was resolved
		// from the graph, not read off the body.
		comment: { body },
		target: { type: targetType, number: subset.target?.number, title: subset.target?.title, body: subset.target?.body },
	};
}

/** Pull-request path. */
function routePullRequest(subset, triggers, action) {
	if (typeof action !== "string") {
		return { enqueue: false, reason: "unhandled-event" };
	}
	// Azure attaches no labels to a pull request, so a predicate cannot narrow one and a rule that carries
	// a positive selector would never match. The loader refuses such a rule at load; here the action alone
	// selects, and the actor's membership is the gate.
	for (const rule of triggers.pullRequest ?? []) {
		if (!rule.actions.has(action)) continue;
		return {
			enqueue: true,
			action,
			// A command rule (issue #189) skips flow resolution entirely: the rule match IS the dispatch.
			...(rule.command !== undefined ? { command: rule.command } : { flow: rule.flow }),
			repository: rule.repository,
			packages: rule.packages,
			image: rule.image, backend: rule.backend,
			skillsDir: rule.skillsDir,
			secrets: rule.secrets,
			secretsProfile: rule.secretsProfile,
			waitFor: rule.waitFor,
			instructions: rule.instructions,
			resume: rule.resume,
			replicas: rule.replicas,
			matched: { index: rule.index, type: "pull_request", action },
			target: {
				type: "pull_request",
				number: subset.target?.number,
				title: subset.target?.title,
				body: subset.target?.body,
				head: subset.target?.head,
				base: subset.target?.base,
			},
		};
	}
	return { enqueue: false, reason: "no-matching-pr-trigger" };
}

/**
 * The `{ repo, azure }` scope for this job, or `null` when the delivery and the rule between them do not
 * name a repository.
 *
 * The project comes from the payload in both cases -- a delivery always names its project. Only the
 * REPOSITORY differs: present on a pull-request event, absent on a work item and supplied by the rule.
 */
function resolveScope(subset, resolved) {
	const project = subset.project?.name;
	const projectId = subset.project?.id;
	const repository = subset.repository?.name ?? resolved.repository;
	if (typeof project !== "string" || project === "" || typeof repository !== "string" || repository === "") {
		return null;
	}
	return {
		repo: `${project}/${repository}`,
		azure: {
			project,
			...(typeof projectId === "string" && projectId !== "" ? { projectId } : {}),
			repository,
			// The repository ID is what every Azure git API path actually takes. It is present on a
			// pull-request delivery and absent on a work item, where the host resolves it by name instead.
			...(typeof subset.repository?.id === "string" && subset.repository.id !== "" ? { repositoryId: subset.repository.id } : {}),
		},
	};
}

/**
 * A stable, opaque id for an actor known only by email address.
 *
 * Truncated to 16 hex characters: long enough that a collision is not a practical concern for the number
 * of humans in one Azure DevOps organization, short enough to read in a log line. Not reversible, and not
 * meant to be -- its only job is to let two records be compared for "same person".
 */
function stableActorId(email) {
	return `azid-${createHash("sha256").update(String(email)).digest("hex").slice(0, 16)}`;
}
