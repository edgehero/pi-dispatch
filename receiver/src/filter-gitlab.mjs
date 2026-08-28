/**
 * The GitLab trigger gate: decide whether a verified GitLab webhook becomes a paid agent job, and with
 * what shape. The counterpart of filter.mjs, and pure for the same reason -- imports nothing side-effecting,
 * touches no I/O, and NEVER throws -- so the security-critical decision is unit testable offline, without a
 * server, a socket, or a GitLab.
 *
 * The evaluation ORDER is fail-closed and load-bearing, mirroring filter.mjs:
 *   0. A non-numeric `user.id` is rejected FIRST, before the self compare -- `undefined === selfId` is
 *      false and would fall through to enqueue, failing OPEN on a malformed payload.
 *   1. The bot-loop guard runs UNCONDITIONALLY. Under a project access token the harness is a project
 *      member and would clear the access gate, so its own status comment is an event that passes -- an
 *      unbounded paid recursion. Gating this behind the access check would reintroduce exactly that loop.
 *   2. THEN the access gate, then the route.
 *
 * WHY THE ACCESS GATE COVERS LABEL TRIGGERS TOO, unlike GitHub.
 *
 * `CONST-TRIGGER-AUTHOR-GATE` rests on "only collaborators can apply labels -- therefore the label IS the
 * human approval step". On GitLab that premise does not hold, in three independent ways: the minimum role
 * for label management has differed across versions, Ultimate's custom roles let an operator grant it at
 * any level, and a Guest can set labels on an issue AT CREATION -- so a stranger can open an issue already
 * carrying the trigger label. A label therefore proves nothing here on its own, and every gitlab trigger
 * is gated on the actor's resolved authority regardless of type. That verdict is produced by the receiver
 * BEFORE this function (gitlab-members.mjs) and passed in, occupying the slot `author_association` holds
 * on the GitHub side: the lookup is a network call, and putting a fetch inside the gate would destroy the
 * purity that makes the gate testable.
 *
 * What crosses that boundary is a BOOLEAN, not GitLab's role integer. Every forge answers "may this actor
 * start a job" in its own vocabulary -- an integer role here, a string enum on Forgejo, a payload field on
 * GitHub, a group membership on Azure DevOps -- and only the answer is common. The `>= 30` threshold lives
 * with the lookup that produces the number; this file owns what to DO about the verdict, which is the part
 * that has to be the same everywhere.
 *
 * WHY A LABEL RULE MATCHES THE DIFF AND NOT THE LABEL SET.
 *
 * GitLab has no `labeled` action. Adding a label arrives as `action: "update"` carrying
 * `changes.labels: { previous, current }`. Matching the CURRENT set -- the shape the GitHub path uses --
 * would re-fire on every subsequent edit of that issue, because the label is still there: retitle it,
 * reassign it, change its milestone, and each one starts another paid run. So the label set a rule is
 * tested against is `current \ previous`, the labels THIS event added, and an `update` carrying no
 * `changes.labels` matches nothing.
 */

import { firstMatchingRule, labelSet, matchedLabel } from "./predicate.mjs";
import { findCloseRule } from "./close.mjs";

/**
/** The merge-request actions a trigger may name, mirrored from the loader's gitlab vocabulary. */
const MR_ACTIONS = new Set(["open", "update", "reopen", "approved"]);

/**
 * Decide. Returns `{ enqueue: false, reason }` or `{ enqueue: true, job }`.
 *
 * `subset` is a `parseGitLabSubset` projection; `triggers` is the gitlab rule group; `authorized` is the
 * receiver's resolved verdict for this actor; `deliveryId` is the stable `webhook-id`, carried into the job
 * for dedup.
 */
export function filterGitLab(subset, triggers, knownFlows, selfId, authorized, deliveryId) {
	// (0) Fail-closed on identity. MUST precede the self compare -- see header.
	if (typeof subset?.user?.id !== "number") {
		return { enqueue: false, reason: "missing-sender-id" };
	}

	// (1) Bot-loop guard: unconditional, independent of the access outcome below.
	if (subset.user.id === selfId) {
		return { enqueue: false, reason: "self" };
	}

	// (2) The access gate, for EVERY trigger type. See the header for why a label does not substitute.
	// Strict `!== true`, so anything that is not an explicit yes -- undefined, a stray truthy value, a
	// resolver that returned the wrong shape -- refuses rather than passes.
	if (authorized !== true) {
		return { enqueue: false, reason: "author-not-allowed" };
	}

	// (3) Route on the object kind.
	const kind = subset.objectKind;
	let resolved;
	if (kind === "issue") {
		if (subset.action === "close") {
			// The close trigger (issue #231), tried FIRST -- and the label walk only as a FALLBACK -- because
			// a real GitLab delivery can close and label in one call (a quick action comment, or the sidebar
			// edited during close). One delivery, one job: when an armed close rule wants this close it fires
			// and the label rule does NOT, so the two rule kinds cannot double-bill a single click.
			resolved = routeIssueClose(subset, triggers, authorized);
			if (!resolved.enqueue && resolved.reason !== "closer-not-allowed" && subset.labelChanges) {
				// No close rule took it, and this close also MOVED labels (`changes.labels`, the exact field
				// `addedLabels` reads for every non-open action). Label rules fired on such closes before close
				// routing existed and must keep doing so byte-identically -- including on ANY close refusal, so
				// a one-shot armed for a DIFFERENT item cannot eat a label trigger it was never about, and
				// including the label walk's own refusal reasons when nothing matches. The `closer-not-allowed`
				// exclusion is belt-and-braces with the route's own unreachable gate: a close a drifted
				// resolver refused must stay refused, never demoted into a label job.
				resolved = routeLabel(subset, triggers, "issue");
			}
		} else {
			resolved = routeLabel(subset, triggers, "issue");
		}
	} else if (kind === "merge_request") {
		// An MR close routes over `group.prClose` ALONE (issue #231), with no label fallback: unlike the
		// issue arm above, MR_ACTIONS never contained "close", so no MR rule ever fired on a close and
		// there is nothing for a fallback to keep working. MR_ACTIONS stays untouched for the same reason
		// in the other direction -- close rules can never reach routeMergeRequest, because the loader split
		// them into `prClose` at group time, so the two rule kinds are mutually unreachable by construction.
		resolved = subset.action === "close" ? routeMergeRequestClose(subset, triggers, authorized) : routeMergeRequest(subset, triggers);
	} else if (kind === "note") {
		resolved = routeNote(subset, triggers, knownFlows);
	} else {
		return { enqueue: false, reason: "unhandled-event" };
	}

	if (!resolved.enqueue) return resolved; // carries the drop reason

	// (4) Build the job from the INT-GITLAB-PAYLOAD-SUBSET fields only. `user.username` is deliberately
	// NOT carried: it exists so the receiver could resolve an access level, and it is personal data with no
	// downstream reader (no-pii-in-logs). `projectId` rides the job because every GitLab API path the
	// worker needs takes the numeric id -- a `group/subgroup/project` path has no fixed segment count, and
	// splitting one is how a nested project silently becomes its own parent group.
	const job = {
		repo: subset.project?.path,
		projectId: subset.project?.id,
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
		// Conditional like packages/image, and for the same reason: an unflagged job's data must stay
		// byte-identical to today's, so the key is absent rather than present-and-undefined.
		...(resolved.resume !== undefined ? { resume: resolved.resume } : {}),
		// How many independent sandboxes race this flow (REQ-REPLICA-RUNS). At JOB level and conditional for the
		// reasons filter.mjs states in full: receiver.mjs reads this to decide how many times to enqueue, and an
		// unflagged job's data must stay byte-identical to today's.
		...(resolved.replicas !== undefined ? { replicas: resolved.replicas } : {}),
		trigger: {
			event: kind,
			action: subset.action,
			deliveryId,
			sender: { id: subset.user.id },
			matched: resolved.matched,
			...(resolved.comment ? { comment: resolved.comment } : {}),
		},
	};
	return { enqueue: true, job };
}

/**
 * Issue path. Fires on the labels THIS event added, never on the labels the issue happens to carry.
 *
 * `open` is included because an issue can be created with labels already on it, and that is a real
 * trigger -- but only because the access gate above has already established the creator is a member. On
 * GitHub the same case is safe for a different reason (only collaborators can apply labels at all).
 */
function routeLabel(subset, triggers, targetType) {
	const added = addedLabels(subset);
	if (added === null) return { enqueue: false, reason: "no-label-change" };

	const rule = firstMatchingRule(triggers?.label, added);
	if (!rule) return { enqueue: false, reason: "no-allowlisted-label" };
	return {
		enqueue: true,
		// A command rule (issue #189) skips flow resolution entirely: the label match IS the dispatch.
		...(rule.command !== undefined ? { command: rule.command } : { flow: rule.flow }),
		packages: rule.packages,
		image: rule.image,
		skillsDir: rule.skillsDir,
		secrets: rule.secrets,
		secretsProfile: rule.secretsProfile,
		instructions: rule.instructions,
		resume: rule.resume,
		replicas: rule.replicas,
		matched: { index: rule.index, type: "label", label: matchedLabel(added, rule.predicate) },
		target: buildTarget(subset, targetType),
	};
}

/**
 * The label set an event ADDED, or `null` when it added none.
 *
 * `open` is the one case where there is no diff and the whole set is the addition: the issue did not
 * exist before, so every label on it arrived with it. Every other action needs `changes.labels`, and its
 * absence means no label moved -- which is precisely the case that must not re-fire.
 */
function addedLabels(subset) {
	if (subset.action === "open") {
		const L = labelSet(subset.target?.labels);
		return L.size > 0 ? L : null;
	}
	const changes = subset.labelChanges;
	if (!changes) return null;
	const previous = labelSet(changes.previous);
	const added = new Set();
	for (const name of labelSet(changes.current)) {
		if (!previous.has(name)) added.add(name);
	}
	return added.size > 0 ? added : null;
}

/**
 * Merge-request path. A rule carrying a positive selector is label-gated and matches the added labels
 * exactly as an issue rule does; a rule without one fires on its named actions alone -- which is safe here
 * only because the access gate already ran, and is why the loader does not demand a positive selector on
 * a gitlab MR rule the way it does on a github `labeled` one.
 */
function routeMergeRequest(subset, triggers) {
	const action = subset.action;
	if (!MR_ACTIONS.has(action)) return { enqueue: false, reason: "unhandled-event" };

	const added = addedLabels(subset);
	for (const rule of triggers?.pullRequest ?? []) {
		if (!rule.actions.has(action)) continue;
		const positive = (rule.predicate?.any?.length ?? 0) + (rule.predicate?.all?.length ?? 0) > 0;
		if (positive) {
			if (added === null || !firstMatchingRule([rule], added)) continue;
			return mrResult(subset, rule, { index: rule.index, type: "label", label: matchedLabel(added, rule.predicate) });
		}
		return mrResult(subset, rule, { index: rule.index, type: "pull_request", action });
	}
	return { enqueue: false, reason: "no-matching-pr-trigger" };
}

function mrResult(subset, rule, matched) {
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
		matched,
		target: buildTarget(subset, "pull_request"),
	};
}

/**
 * Issue close path (issue #231). `findCloseRule` is the ONE derivation of "which close rule wants
 * this delivery" (close.mjs), shared with the receiver's pre-lookup check -- two hand-rolled copies
 * a network call apart is the drift that module's header warns against.
 *
 * The `closer-not-allowed` gate below is belt-and-braces and UNREACHABLE today: gate (2) in
 * `filterGitLab` already refused every non-true verdict before routing, and on a webhook close
 * delivery the ACTOR is the closer, so the verdict that gate consumed is the closer's. It stays
 * anyway, because this route's own contract is the closer's authority: if the global gate ever
 * moves, or a resolver starts returning a shape it never has, a close must fail closed under its own
 * token rather than route on a stale assumption about the caller.
 */
function routeIssueClose(subset, triggers, authorized) {
	const number = subset.target?.iid;
	// Integer or refuse, the github arms' rule: an UNNARROWED rule matches an undefined number, so a
	// degenerate shape would otherwise enqueue a numberless target. GitLab sends integer iids.
	if (!Number.isInteger(number)) {
		return { enqueue: false, reason: "missing-issue-number" };
	}
	// "close" is PR_CLOSE_ACTIONS.gitlab -- the forge's own word, the one the loader validated the
	// rule's action list against. GitLab really does say "close", not "closed".
	const found = findCloseRule(triggers?.issue, "close", number);
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
		matched: { index: rule.index, type: "issue", action: "close", number, ...(rule.once === true && { once: true }) },
		target: buildTarget(subset, "issue"),
	};
}

/** MR close path (issue #231). Same shape and same belt-and-braces closer gate as routeIssueClose. */
function routeMergeRequestClose(subset, triggers, authorized) {
	// The issue arm's integer guard, same reason.
	if (!Number.isInteger(subset.target?.iid)) {
		return { enqueue: false, reason: "missing-pull-request" };
	}
	const found = findCloseRule(triggers?.prClose, "close", subset.target?.iid);
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
		// No `number` on an MR close's matched record -- parallel to routeMergeRequest's, where the item
		// number is the target's business; the issue route carries it because the github design does.
		matched: { index: rule.index, type: "pull_request", action: "close", ...(rule.once === true && { once: true }) },
		target: buildTarget(subset, "pull_request"),
	};
}

/**
 * Note (comment) path. `noteable_type` states whether the comment is on an issue or a merge request --
 * GitHub infers the same thing from the presence of `issue.pull_request`. Routing it wrong would mint an
 * issue branch for something that is already a merge request: wrong work, no error, and it looks like a
 * successful run.
 */
function routeNote(subset, triggers, knownFlows) {
	if (subset.action !== "create") return { enqueue: false, reason: "unhandled-event" };

	const phrase = triggers?.comment?.phrase;
	const body = subset.note;
	if (typeof phrase !== "string" || typeof body !== "string" || !body.includes(phrase)) {
		return { enqueue: false, reason: "no-trigger-phrase" };
	}
	// On a COMMAND rule (issue #189) the flow-resolution block below -- default flow, the `<phrase> <flow>`
	// trailing-word override, and the `no-flow` refusal -- is deliberately UNREACHABLE: the phrase alone
	// fires, and trailing note text stays DATA (the handler reads the delivery via /job/event.json). An
	// active override would hand any authorized member two levers the trigger's author never granted:
	// retarget the command onto a known flow by appending its name, or veto it (the `no-flow` arm) with a
	// word that resolves nowhere. Same rationale, same shape as filter.mjs's routeComment.
	const command = triggers.comment.command;
	let flow;
	if (command === undefined) {
		// Default to the configured flow; an explicit `<phrase> <flow>` overrides only when `<flow>` is a
		// known flow name, so a comment cannot summon an unlisted flow.
		flow = triggers.comment?.defaultFlow;
		const match = body.match(new RegExp(escapeLiteral(phrase) + "\\s+(\\S+)"));
		if (match && knownFlows?.has(match[1])) flow = match[1];
		if (flow === null || flow === undefined || flow === "") {
			return { enqueue: false, reason: "no-flow" };
		}
	}
	const targetType = subset.noteableType === "MergeRequest" ? "pull_request" : "issue";
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
		target: buildTarget(subset, targetType),
		// The invoking comment rides the job as DATA (CONST-ISSUE-TEXT-IS-DATA). No author_association
		// counterpart exists on GitLab: the approval is the resolved access level, which is a harness
		// decision and belongs in `matched`, not in a field that looks like payload.
		comment: { body },
	};
}

/** Escape a literal for embedding in a RegExp -- the trigger phrase is config, not a pattern. */
function escapeLiteral(literal) {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The job's target. `iid` is the per-project number a human sees and an API path takes; `id` would be a
 * global key naming somebody else's issue. `type` uses the SHARED vocabulary (`issue` / `pull_request`)
 * rather than GitLab's nouns, because it discriminates a job shape the worker already understands.
 */
function buildTarget(subset, type) {
	return {
		type,
		number: subset.target?.iid,
		title: subset.target?.title,
		body: subset.target?.description,
	};
}
