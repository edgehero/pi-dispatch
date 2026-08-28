/**
 * Project ONLY the fields the Forgejo gate and job are allowed to see (`INT-FORGEJO-PAYLOAD-SUBSET`).
 *
 * A sibling of `parseSubset` (GitHub) and `parseGitLabSubset`, not a reuse of either. Forgejo's payload is
 * the closest of the three to GitHub's -- `modules/structs/hook.go` carries the same JSON tags for
 * `action`, `issue.{number,title,body}`, `issue.labels[].name`, `comment.body`, `repository.full_name` and
 * `pull_request.{number,title,body,labels,head,base}` -- which is exactly why it gets its own projection
 * rather than sharing GitHub's. "Almost the same" is the shape that breaks quietly, and there are three
 * differences, each of which is a wrong job rather than an error:
 *
 *   1. NO `author_association`. Forgejo has no such concept anywhere. GitHub's gate reads that field, so
 *      against a Forgejo body it is `undefined` and the gate denies everything -- which fails closed, and
 *      is therefore the RIGHT accident, but it means the comment and PR-auto paths are simply dead until
 *      an authority verdict is resolved from the API instead (forgejo-members.mjs).
 *   2. `is_pull` AT TOP LEVEL, not `issue.pull_request`. Get this wrong and every comment on a pull request
 *      routes as an ISSUE target, so the envelope tells the agent to open `pi/issue-<n>` for something that
 *      is already a pull request. Wrong work, no error, and a run that looks like it succeeded.
 *   3. `sender.login` IS CARRIED, where GitHub's subset deliberately excludes it. It is personal data, and
 *      it is here for exactly one consumer -- the collaborator-permission lookup, which is by username
 *      because that is the only key Forgejo's endpoint takes. Same justification, and same obligation, as
 *      `user.username` in the GitLab subset: it exists to have been asked about, and `no-pii-in-logs`
 *      applies to everything the resolution path writes down.
 *
 * Everything else in the delivery is ignored.
 */

/**
 * Forgejo's issue/PR action vocabulary, mapped to the words this codebase's gate is written in.
 *
 * This map is why the module exists in the shape it does. Forgejo's `HookEventType.Event()` reports
 * `issue_label` as `X-GitHub-Event: issues` and `pull_request_label` as `pull_request`, so a label change
 * arrives looking exactly like a GitHub label event -- and then says `"action": "label_updated"`. Against
 * GitHub's vocabulary that passes the event check, fails the action check, and falls out as
 * `unhandled-event`: HTTP 200, no job, no error, and nothing that says why. An operator watching a trigger
 * that never fires has nothing to look at.
 *
 * So the mapping is explicit and tested, never incidental. Two rules it encodes:
 *   - `label_cleared` maps to NOTHING, permanently. It has no GitHub counterpart and must not acquire one:
 *     REMOVING a label must never start a paid run.
 *   - An action that is recognised but not actionable drops under its OWN reason, so "Forgejo sent
 *     something we understand and chose to ignore" is distinguishable from "we did not recognise this".
 */
const ISSUE_ACTIONS = {
	opened: "opened",
	reopened: "reopened",
	label_updated: "labeled",
	// The close trigger (issue #231) made `closed` actionable, so it moved OUT of IGNORED_ACTIONS
	// below. It sits in BOTH maps deliberately: the maps are selected by EVENT NAME, so `closed` on
	// `issues` and `closed` on `pull_request` are two different routes sharing a spelling, not one
	// word listed twice -- the never-in-two rule below is about a map versus the ignored set.
	closed: "closed",
};

const PR_ACTIONS = {
	opened: "opened",
	reopened: "reopened",
	label_updated: "labeled",
	synchronized: "synchronize",
	closed: "closed", // issue #231 -- see the note on ISSUE_ACTIONS
};

/**
 * Recognised, and deliberately not actionable. Named so the drop reason can say which it was.
 *
 * DISJOINT from both action maps, and that is an invariant rather than an accident: `mapAction`
 * would happily route a word that also sat here, and this set's claim of "ignored" would then be a
 * lie the drop reason repeats to an operator. `closed` lived here until issue #231 made closes
 * routable; it MOVED into the maps rather than gaining a twin.
 */
const IGNORED_ACTIONS = new Set([
	"label_cleared", // removing a label must never start a paid run
	"edited",
	"assigned",
	"unassigned",
	"milestoned",
	"demilestoned",
	"reviewed",
	"review_requested",
	"review_request_removed",
]);

/** Forgejo's word for this event's action, in this codebase's vocabulary, or `null` when it maps to none. */
export function mapAction(eventName, action) {
	const table = eventName === "pull_request" ? PR_ACTIONS : ISSUE_ACTIONS;
	return Object.hasOwn(table, action) ? table[action] : null;
}

/** Whether Forgejo names this action at all -- distinguishes "ignored on purpose" from "never heard of it". */
export function isRecognizedAction(action) {
	return IGNORED_ACTIONS.has(action) || Object.hasOwn(ISSUE_ACTIONS, action) || Object.hasOwn(PR_ACTIONS, action);
}

export function parseForgejoSubset(payload) {
	const pr = payload.pull_request;
	return {
		// Forgejo's raw action word, kept verbatim: the gate maps it, and the job's trigger records what the
		// forge actually said rather than our translation of it.
		action: payload.action,
		sender: { id: payload.sender?.id, login: payload.sender?.login },
		issue: {
			number: payload.issue?.number,
			title: payload.issue?.title,
			body: payload.issue?.body,
			labels: Array.isArray(payload.issue?.labels) ? payload.issue.labels.map((l) => ({ name: l?.name })) : [],
		},
		comment: { body: payload.comment?.body },
		// TOP-LEVEL on Forgejo, and a boolean rather than a presence marker for an object. This is the field
		// that decides whether a comment routes as a pull request or an issue.
		isPull: payload.is_pull === true,
		pull_request: pr
			? {
					number: pr.number,
					title: pr.title,
					body: pr.body,
					labels: Array.isArray(pr.labels) ? pr.labels.map((l) => ({ name: l?.name })) : [],
					// head/base are attacker-controlled fork DATA, projected for the flow's event.json and NEVER
					// used as a clone ref -- the worker clones the base default-branch SHA
					// (INT-WEBHOOK-PAYLOAD-SUBSET's acceptance clause, which holds here for the same reason).
					head: { ref: pr.head?.ref, sha: pr.head?.sha, repo: { full_name: pr.head?.repo?.full_name } },
					base: { ref: pr.base?.ref },
				}
			: undefined,
		repository: { full_name: payload.repository?.full_name },
	};
}
