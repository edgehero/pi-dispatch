import assert from "node:assert/strict";
import { test } from "node:test";
import { filter } from "../src/filter.mjs";

/**
 * Wrap a flat trigger group in the shape `loadReceiverConfig` now produces: rules are grouped PER FORGE
 * (receiver/src/config.mjs), so the github gate reads `cfg.triggers.github`, while `knownFlows` stays
 * above the groups because it is the whole file's flow vocabulary and not one forge's rules.
 *
 * The fixtures below stay written flat and are wrapped here, so regrouping the config never edits an
 * assertion -- what these tests pin is the JOB the gate emits, and that is unchanged.
 */
function forgeCfg(flat) {
	const { knownFlows, ...group } = flat.triggers;
	return { triggers: { github: group, knownFlows } };
}

// The grouped webhook triggers, mirroring loadReceiverConfig's `cfg.triggers` shape (label rules, the
// single comment trigger, pull_request rules, and the knownFlows set for comment `<phrase> <flow>` overrides).
// Rule `index` values are deliberately NON-CONTIGUOUS: the filter must pass the loader's raw-file index
// through to `trigger.matched.index` verbatim, never recompute a position of its own.
const cfgRaw = {
	triggers: {
		label: [{ index: 2, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix" }],
		comment: { index: 4, phrase: "@pi", defaultFlow: "triage" },
		pullRequest: [],
		knownFlows: new Set(["frontend-fix", "triage"]),
	},
};
const cfg = forgeCfg(cfgRaw);
// A richer label allowlist exercising every predicate clause: any-of-many, a required `all`, exclusion
// `none`, and a second flow to prove first-match-in-file-order and single-clause routing.
const matrixCfgRaw = {
	triggers: {
		label: [
			{ index: 2, predicate: { any: ["ai-fix", "urgent-fix"], all: ["triaged"], none: ["blocked", "wontfix"] }, flow: "fix" },
			{ index: 5, predicate: { any: ["ai-review"] }, flow: "review" },
		],
		comment: { index: 7, phrase: "@pi", defaultFlow: "triage" },
		pullRequest: [],
		knownFlows: new Set(["fix", "review", "triage"]),
	},
};
const matrixCfg = forgeCfg(matrixCfgRaw);
// Pull-request triggers: a labeled rule (predicate = approval) and an auto rule (author gate = approval).
const prCfgRaw = {
	triggers: {
		label: [],
		comment: { index: 1, phrase: "@pi", defaultFlow: "triage" },
		pullRequest: [
			{ index: 3, actions: new Set(["labeled"]), predicate: { any: ["pi:review"] }, flow: "review" },
			{ index: 6, actions: new Set(["opened", "synchronize", "reopened"]), predicate: {}, flow: "autoreview" },
			{ index: 8, actions: new Set(["review_submitted"]), reviewStates: null, predicate: {}, flow: "reviewfix" },
		],
		knownFlows: new Set(["review", "autoreview", "triage", "reviewfix"]),
	},
};
const prCfg = forgeCfg(prCfgRaw);
// The same file with the review rule narrowed to one verdict, for the on.reviewState cases.
const reviewStateCfg = forgeCfg({
	triggers: {
		...prCfgRaw.triggers,
		pullRequest: [{ index: 8, actions: new Set(["review_submitted"]), reviewStates: new Set(["changes_requested"]), predicate: {}, flow: "reviewfix" }],
	},
});
const SELF_ID = 999;

/** A well-formed `issue_comment.created` subset, overridable per case. */
function commentSubset(over = {}) {
	return {
		action: "created",
		sender: { id: 7 },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B", pull_request: false },
		comment: { author_association: "OWNER", body: "@pi go" },
		...over,
	};
}

/** A well-formed `issues.labeled` subset, overridable per case. */
function issuesSubset(over = {}) {
	return {
		action: "labeled",
		sender: { id: 7 },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B", labels: [{ name: "pi:frontend" }] },
		...over,
	};
}

/** An `issues.labeled` subset carrying exactly the named labels -- for the predicate matrix. */
function labeledSubset(labelNames) {
	return issuesSubset({ issue: { number: 42, title: "T", body: "B", labels: labelNames.map((name) => ({ name })) } });
}

/** A well-formed `pull_request` subset, overridable per case. */
function prSubset({ action = "opened", senderId = 7, author = "COLLABORATOR", labels = [] } = {}) {
	return {
		action,
		sender: { id: senderId },
		repository: { full_name: "octo/repo" },
		pull_request: {
			number: 12,
			title: "PR T",
			body: "PR B",
			author_association: author,
			labels: labels.map((name) => ({ name })),
			head: { ref: "feat", sha: "abc", repo: { full_name: "fork/x" } },
			base: { ref: "main" },
		},
	};
}

/**
 * A `pull_request_review.submitted` subset (issue #66).
 *
 * `author` is the PR AUTHOR's association and `reviewer` the REVIEWER's, and they are independently
 * settable on purpose: which of the two gates the delivery is the entire issue, and a fixture that
 * couples them cannot express the case that catches the inversion.
 *
 * `state` defaults lower case because parseSubset folds it before the filter ever sees it.
 */
function reviewSubset({ senderId = 7, author = "NONE", reviewer = "COLLABORATOR", state = "approved", body = "looks good", labels = [] } = {}) {
	return {
		...prSubset({ action: "submitted", senderId, author, labels }),
		review: { id: 555, body, state, author_association: reviewer },
	};
}

// -- identity + bot-loop guards (unchanged, load-bearing order) -----------------------------------

test("self-comment is dropped even though it would clear the author gate + phrase (PAT owner mode)", () => {
	const subset = commentSubset({ sender: { id: SELF_ID } });
	const r = filter("issue_comment", subset, cfg, SELF_ID, "d-self");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "self");
	assert.equal(r.job, undefined);
});

test("missing sender.id rejects BEFORE the self compare (fail-closed, not fall-through to enqueue)", () => {
	for (const sender of [undefined, {}, { id: undefined }, { id: "7" }, { id: "999" }]) {
		const subset = commentSubset({ sender });
		const r = filter("issue_comment", subset, cfg, SELF_ID, "d-nosender");
		assert.equal(r.enqueue, false, `sender=${JSON.stringify(sender)} must not enqueue`);
		assert.equal(r.reason, "missing-sender-id");
	}
});

test("a valid label event with a missing sender.id fails closed (missing-sender-id, not enqueue)", () => {
	const r = filter("issues", issuesSubset({ sender: { id: undefined } }), cfg, SELF_ID, "d-x");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "missing-sender-id");
});

// -- issue label path -----------------------------------------------------------------------------

test("comment from a non-collaborator (author_association NONE) is dropped", () => {
	const subset = commentSubset({ comment: { author_association: "NONE", body: "@pi go" } });
	const r = filter("issue_comment", subset, cfg, SELF_ID, "d-none");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "author-not-allowed");
});

test("a labeled issue whose label is not in the allowlist is dropped, no job", () => {
	const subset = issuesSubset({ issue: { number: 42, title: "T", body: "B", labels: [{ name: "bug" }] } });
	const r = filter("issues", subset, cfg, SELF_ID, "d-bug");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-allowlisted-label");
	assert.equal(r.job, undefined);
});

test("a labeled issue with an allowlisted label enqueues, carrying only subset fields", () => {
	const r = filter("issues", issuesSubset(), cfg, SELF_ID, "guid-abc");
	assert.equal(r.enqueue, true);
	assert.equal(r.reason, undefined);
	assert.deepEqual(r.job, {
		repo: "octo/repo",
		target: { type: "issue", number: 42, title: "T", body: "B" },
		flow: "frontend-fix",
		trigger: {
			event: "issues",
			action: "labeled",
			deliveryId: "guid-abc",
			sender: { id: 7 },
			matched: { index: 2, type: "label", label: "pi:frontend" },
		},
	});
	assert.equal("login" in r.job.trigger.sender, false);
	// A label-triggered job carries NO comment key at all -- `comment` exists only on the comment route.
	assert.equal("comment" in r.job.trigger, false);
	for (const forbidden of ["provider", "model", "maxTurns", "issueNumber", "title", "body"]) {
		assert.equal(forbidden in r.job, false, `job must not carry a top-level ${forbidden}`);
	}
	assert.deepEqual(Object.keys(r.job).sort(), ["flow", "repo", "target", "trigger"]);
});

test("first-matching label wins when several are present", () => {
	const subset = issuesSubset({ issue: { number: 42, title: "T", body: "B", labels: [{ name: "bug" }, { name: "pi:frontend" }] } });
	const r = filter("issues", subset, cfg, SELF_ID, "d-multi");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "frontend-fix");
});

test("issues.opened and issues.reopened also route the label path", () => {
	for (const action of ["opened", "reopened"]) {
		const r = filter("issues", issuesSubset({ action }), cfg, SELF_ID, "d-" + action);
		assert.equal(r.enqueue, true);
		assert.equal(r.job.trigger.action, action);
		assert.equal(r.job.target.type, "issue");
	}
});

test("predicate: an `any` hit with all required labels and no exclusion enqueues the flow", () => {
	const r = filter("issues", labeledSubset(["ai-fix", "triaged"]), matrixCfg, SELF_ID, "d-m1");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "fix");
});

test("predicate: an `any` hit missing a required `all` label is dropped (all makes it stricter)", () => {
	const r = filter("issues", labeledSubset(["ai-fix"]), matrixCfg, SELF_ID, "d-m2");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-allowlisted-label");
});

test("predicate: a `none` label suppresses the flow (exclusion brake); no other flow matches", () => {
	const r = filter("issues", labeledSubset(["ai-fix", "triaged", "blocked"]), matrixCfg, SELF_ID, "d-m3");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-allowlisted-label");
});

test("predicate: the first flow in file order wins when several rules could match", () => {
	const r = filter("issues", labeledSubset(["ai-fix", "triaged", "ai-review"]), matrixCfg, SELF_ID, "d-m5");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "fix");
});

test("predicate: a label matching only the second flow routes to it (single-clause any)", () => {
	const r = filter("issues", labeledSubset(["ai-review"]), matrixCfg, SELF_ID, "d-m6");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "review");
});

// -- trigger.matched on the label path ------------------------------------------------------------

test("matched reports the WINNING rule's raw-file index and the any-hit label, per rule", () => {
	// First rule wins: index 2 (non-contiguous, so a recomputed array position would be caught), and the
	// label is the `any` entry actually present -- urgent-fix, not the rule's first-listed ai-fix.
	const first = filter("issues", labeledSubset(["urgent-fix", "triaged"]), matrixCfg, SELF_ID, "d-mi1");
	assert.equal(first.enqueue, true);
	assert.deepEqual(first.job.trigger.matched, { index: 2, type: "label", label: "urgent-fix" });

	// Second rule wins: its own index (5), its own any-hit.
	const second = filter("issues", labeledSubset(["ai-review"]), matrixCfg, SELF_ID, "d-mi2");
	assert.equal(second.enqueue, true);
	assert.deepEqual(second.job.trigger.matched, { index: 5, type: "label", label: "ai-review" });
});

test("a rule matched via an `all`-only predicate reports all[0] as the matched label", () => {
	// No `any` clause: the positive selector is `all`, and all ⊆ L on a match guarantees membership.
	const allOnlyCfg = forgeCfg({
		triggers: {
			label: [{ index: 9, predicate: { all: ["triaged", "approved"] }, flow: "fix" }],
			comment: null,
			pullRequest: [],
			knownFlows: new Set(["fix"]),
		},
	});
	const r = filter("issues", labeledSubset(["approved", "triaged"]), allOnlyCfg, SELF_ID, "d-mi3");
	assert.equal(r.enqueue, true);
	assert.deepEqual(r.job.trigger.matched, { index: 9, type: "label", label: "triaged" });
});

// -- comment path ---------------------------------------------------------------------------------

test("comment with the phrase but no defaultFlow and no @pi <flow> is dropped as no-flow", () => {
	const noDefault = forgeCfg({ triggers: { ...cfgRaw.triggers, comment: { index: 4, phrase: "@pi", defaultFlow: null } } });
	const subset = commentSubset({ comment: { author_association: "MEMBER", body: "@pi please help" } });
	const r = filter("issue_comment", subset, noDefault, SELF_ID, "d-noflow");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-flow");
});

test("an explicit `@pi <flow>` names a known flow value and enqueues even with defaultFlow null", () => {
	const noDefault = forgeCfg({ triggers: { ...cfgRaw.triggers, comment: { index: 4, phrase: "@pi", defaultFlow: null } } });
	const subset = commentSubset({ comment: { author_association: "COLLABORATOR", body: "@pi frontend-fix please" } });
	const r = filter("issue_comment", subset, noDefault, SELF_ID, "d-explicit");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "frontend-fix");
	// The flow-override changes WHICH flow runs, never the match record: matched.phrase stays the
	// configured phrase, not the override word.
	assert.deepEqual(r.job.trigger.matched, { index: 4, type: "comment", phrase: "@pi" });
});

test("a comment lacking the trigger phrase is dropped", () => {
	const subset = commentSubset({ comment: { author_association: "OWNER", body: "just a normal comment" } });
	const r = filter("issue_comment", subset, cfg, SELF_ID, "d-nophrase");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-trigger-phrase");
});

test("a valid comment with the default flow enqueues an issue target with defaultFlow", () => {
	const subset = commentSubset({ comment: { author_association: "OWNER", body: "hey @pi take a look" } });
	const r = filter("issue_comment", subset, cfg, SELF_ID, "d-default");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "triage");
	assert.equal(r.job.target.type, "issue");
	// The invoking comment rides on the trigger -- exactly the two subset fields, nothing else.
	assert.deepEqual(r.job.trigger.comment, { body: "hey @pi take a look", author_association: "OWNER" });
	assert.deepEqual(r.job.trigger.matched, { index: 4, type: "comment", phrase: "@pi" });
});

test("a comment ON A PR (issue.pull_request present) routes a pull_request target, not an issue", () => {
	const subset = commentSubset({ issue: { number: 55, title: "PR T", body: "PR B", pull_request: true }, comment: { author_association: "OWNER", body: "@pi go" } });
	const r = filter("issue_comment", subset, cfg, SELF_ID, "d-prcomment");
	assert.equal(r.enqueue, true);
	// Target unchanged by the trigger-context work: still the PR's number/title/body from subset.issue.
	assert.deepEqual(r.job.target, { type: "pull_request", number: 55, title: "PR T", body: "PR B" });
	assert.equal(r.job.flow, "triage");
	// The PR-comment variant carries the invoking comment too -- same contract as an issue comment.
	assert.deepEqual(r.job.trigger.comment, { body: "@pi go", author_association: "OWNER" });
	assert.deepEqual(r.job.trigger.matched, { index: 4, type: "comment", phrase: "@pi" });
});

// -- pull_request path ----------------------------------------------------------------------------

test("a PR labeled with a matching predicate enqueues a pull_request target with head/base as data", () => {
	const r = filter("pull_request", prSubset({ action: "labeled", labels: ["pi:review"] }), prCfg, SELF_ID, "d-prlabel");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "review");
	assert.deepEqual(r.job.target, {
		type: "pull_request",
		number: 12,
		title: "PR T",
		body: "PR B",
		head: { ref: "feat", sha: "abc", repo: "fork/x" },
		base: { ref: "main" },
	});
	assert.equal(r.job.trigger.event, "pull_request");
	// matched names the labeled rule (raw-file index 3) and the action that satisfied its action set.
	assert.deepEqual(r.job.trigger.matched, { index: 3, type: "pull_request", action: "labeled" });
	assert.equal("comment" in r.job.trigger, false);
});

test("a PR labeled with a non-matching label is dropped (no-matching-pr-trigger)", () => {
	const r = filter("pull_request", prSubset({ action: "labeled", labels: ["chore"] }), prCfg, SELF_ID, "d-prlabel2");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-matching-pr-trigger");
});

test("PR opened by a COLLABORATOR auto-fires (author gate satisfied)", () => {
	const r = filter("pull_request", prSubset({ action: "opened", author: "COLLABORATOR" }), prCfg, SELF_ID, "d-propen");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "autoreview");
	assert.equal(r.job.target.type, "pull_request");
	// The auto rule sits at raw-file index 6; matched.action is the action that fired, not the rule's set.
	assert.deepEqual(r.job.trigger.matched, { index: 6, type: "pull_request", action: "opened" });
});

test("PR opened by a non-collaborator (fork, author NONE) is dropped -- the hard author gate", () => {
	for (const author of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR"]) {
		const r = filter("pull_request", prSubset({ action: "opened", author }), prCfg, SELF_ID, "d-fork");
		assert.equal(r.enqueue, false, `author=${author} must not auto-fire`);
		assert.equal(r.reason, "pr-author-not-allowed");
	}
});

test("PR opened with a missing author_association is dropped (has(undefined) === false)", () => {
	const subset = prSubset({ action: "opened" });
	delete subset.pull_request.author_association;
	const r = filter("pull_request", subset, prCfg, SELF_ID, "d-noauthor");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "pr-author-not-allowed");
});

test("PR synchronize/reopened by a collaborator auto-fires; by a fork author is dropped", () => {
	const ok = filter("pull_request", prSubset({ action: "synchronize", author: "MEMBER" }), prCfg, SELF_ID, "d-sync");
	assert.equal(ok.enqueue, true);
	assert.equal(ok.job.flow, "autoreview");
	assert.deepEqual(ok.job.trigger.matched, { index: 6, type: "pull_request", action: "synchronize" });

	const forked = filter("pull_request", prSubset({ action: "reopened", author: "NONE" }), prCfg, SELF_ID, "d-reopen");
	assert.equal(forked.enqueue, false);
	assert.equal(forked.reason, "pr-author-not-allowed");
});

test("a PR synchronize from the harness's own push (sender.id === selfId) is dropped by the bot-loop guard", () => {
	// The flow pushing to a PR head fires pull_request.synchronize; the unconditional self guard breaks the loop.
	const r = filter("pull_request", prSubset({ action: "synchronize", senderId: SELF_ID, author: "OWNER" }), prCfg, SELF_ID, "d-selfpush");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "self");
});

test("a PR labeled action does NOT require the author gate (collaborator-applied label is the approval)", () => {
	// author NONE, but a collaborator applied the pi:review label -> labeling is the approval.
	const r = filter("pull_request", prSubset({ action: "labeled", author: "NONE", labels: ["pi:review"] }), prCfg, SELF_ID, "d-prlabel-fork");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "review");
});

test("an unsupported PR action (closed) is dropped as unhandled-event", () => {
	const r = filter("pull_request", prSubset({ action: "closed" }), prCfg, SELF_ID, "d-prclosed");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "unhandled-event");
});

// -- pull_request_review: the INVERTED author gate (issue #66) ------------------------------------
//
// These two tests are a PAIR and must stay one. Each delivery sets review.author_association and
// pull_request.author_association to DIFFERENT values, in opposite directions, so that reading the wrong
// one fails exactly one of them. A suite that only ever tests deliveries where the two agree would pass
// against a gate that reads the PR author, which is the bug this whole change exists to avoid.

test("a COLLABORATOR reviewing a STRANGER's fork PR runs -- the gate is the REVIEWER's association", () => {
	const r = filter("pull_request_review", reviewSubset({ author: "NONE", reviewer: "COLLABORATOR" }), prCfg, SELF_ID, "d-rev-fork");
	assert.equal(r.enqueue, true, "reading pull_request.author_association here would refuse the whole feature");
	assert.equal(r.job.flow, "reviewfix");
	assert.deepEqual(r.job.trigger.matched, { index: 8, type: "pull_request", action: "review_submitted" });
});

test("a STRANGER reviewing an OWNER's PR is refused -- the PR author's standing must not rescue it", () => {
	for (const reviewer of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR"]) {
		const r = filter("pull_request_review", reviewSubset({ author: "OWNER", reviewer }), prCfg, SELF_ID, "d-rev-stranger");
		assert.equal(r.enqueue, false, `reviewer=${reviewer} must not fire`);
		assert.equal(r.reason, "review-author-not-allowed");
	}
	// And the absent field, deleted rather than passed as undefined so the fixture default cannot mask it.
	const missing = reviewSubset({ author: "OWNER" });
	delete missing.review.author_association;
	const r = filter("pull_request_review", missing, prCfg, SELF_ID, "d-rev-noassoc");
	assert.equal(r.enqueue, false, "a review with no association at all must not fire");
	assert.equal(r.reason, "review-author-not-allowed");
});

test("a review delivery carrying no review object at all is refused (has(undefined) === false)", () => {
	const subset = reviewSubset({ author: "OWNER" });
	delete subset.review;
	const r = filter("pull_request_review", subset, prCfg, SELF_ID, "d-rev-noreview");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "review-author-not-allowed");
});

test("the harness's own review is dropped by the bot-loop guard, BEFORE the new gate runs", () => {
	// A flow that runs `gh pr review` fires pull_request_review.submitted as our own identity. The guard
	// is unconditional and costs nothing here -- but a review bot reviewing every push is a loop it
	// cannot see, which is why SECURITY.md names that vector.
	const r = filter("pull_request_review", reviewSubset({ senderId: SELF_ID, reviewer: "OWNER" }), prCfg, SELF_ID, "d-rev-self");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "self");
});

test("the accepted job says what GitHub said (event + raw action) while `matched` says what the FILE said", () => {
	const r = filter("pull_request_review", reviewSubset({ reviewer: "MEMBER" }), prCfg, SELF_ID, "d-rev-shape");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.trigger.event, "pull_request_review");
	assert.equal(r.job.trigger.action, "submitted", "the payload's own word, byte-for-byte");
	assert.equal(r.job.trigger.matched.action, "review_submitted", "the triggers.json word, which GitHub never sent");
	assert.deepEqual(r.job.trigger.review, { id: 555, body: "looks good", state: "approved", author_association: "MEMBER" });
	assert.equal("user" in r.job.trigger.review, false, "no login rides the job -- sender.id is the only identity");
	// The target is the PR, head/base carried as DATA exactly as on any other pull_request action.
	assert.deepEqual(r.job.target, {
		type: "pull_request",
		number: 12,
		title: "PR T",
		body: "PR B",
		head: { ref: "feat", sha: "abc", repo: "fork/x" },
		base: { ref: "main" },
	});
});

test("`review` rides ONLY the review route -- no other trigger grows the key", () => {
	const cases = [
		["issues", issuesSubset(), cfg],
		["issue_comment", commentSubset(), cfg],
		["pull_request", prSubset({ action: "labeled", labels: ["pi:review"] }), prCfg],
		["pull_request", prSubset({ action: "opened" }), prCfg],
	];
	for (const [event, subset, c] of cases) {
		const r = filter(event, subset, c, SELF_ID, `d-norev-${event}`);
		assert.equal(r.enqueue, true);
		assert.equal("review" in r.job.trigger, false, `${event} must not grow a review key`);
	}
});

test("an empty-bodied `commented` review is dropped as no-review-body, in either of GitHub's spellings", () => {
	// A Comment-type review of line comments only arrives exactly like this: the remarks ride
	// pull_request_review_comment, an event this project does not ingest, and the filter is pure so it
	// cannot tell that from a genuinely empty review. Refusing is the cheaper error.
	for (const state of ["commented", "COMMENTED"]) {
		for (const body of [null, "", "   \n\t "]) {
			const r = filter("pull_request_review", reviewSubset({ reviewer: "OWNER", state, body }), prCfg, SELF_ID, "d-rev-empty");
			assert.equal(r.enqueue, false, `state=${state} body=${JSON.stringify(body)} must not buy a container`);
			assert.equal(r.reason, "no-review-body");
		}
		// The absent key, deleted rather than passed as undefined so the fixture default cannot mask it.
		const noBody = reviewSubset({ reviewer: "OWNER", state });
		delete noBody.review.body;
		const r = filter("pull_request_review", noBody, prCfg, SELF_ID, "d-rev-nobody");
		assert.equal(r.enqueue, false, `state=${state} with no body key must not buy a container`);
		assert.equal(r.reason, "no-review-body");
	}
});

test("a `commented` review WITH a body fires -- the drop is about emptiness, not about the verdict", () => {
	const r = filter("pull_request_review", reviewSubset({ reviewer: "OWNER", state: "commented", body: "please rename x" }), prCfg, SELF_ID, "d-rev-cmt");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.trigger.review.body, "please rename x");
});

test("an empty-bodied approve or request-changes still fires -- there the VERDICT is the signal", () => {
	for (const state of ["approved", "changes_requested"]) {
		const r = filter("pull_request_review", reviewSubset({ reviewer: "OWNER", state, body: "" }), prCfg, SELF_ID, "d-rev-verdict");
		assert.equal(r.enqueue, true, `${state} with no summary is still a maintainer's decision`);
		assert.equal(r.job.trigger.review.state, state);
	}
});

test("when a stranger submits an EMPTY review, the security reason wins over the content one", () => {
	const r = filter("pull_request_review", reviewSubset({ author: "OWNER", reviewer: "NONE", state: "commented", body: "" }), prCfg, SELF_ID, "d-rev-both");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "review-author-not-allowed", "both are true; the one an operator must act on is the gate");
});

test("pull_request_review actions other than `submitted` are dropped as unhandled-event", () => {
	for (const action of ["edited", "dismissed"]) {
		const subset = { ...reviewSubset({ reviewer: "OWNER" }), action };
		const r = filter("pull_request_review", subset, prCfg, SELF_ID, "d-rev-other");
		assert.equal(r.enqueue, false, `${action} must not start a paid run`);
		assert.equal(r.reason, "unhandled-event");
	}
});

test("the canonical word is not accepted from the wire, and the raw word is not accepted from the file", () => {
	// `review_submitted` is a triggers.json word; GitHub never sends it. And `submitted` on the plain
	// `pull_request` event is not a thing either. Neither direction may route.
	const asWireAction = filter("pull_request", { ...reviewSubset({ reviewer: "OWNER" }), action: "review_submitted" }, prCfg, SELF_ID, "d-rev-wire");
	assert.equal(asWireAction.enqueue, false);
	assert.equal(asWireAction.reason, "unhandled-event");

	const asPlainPr = filter("pull_request", reviewSubset({ reviewer: "OWNER" }), prCfg, SELF_ID, "d-rev-plain");
	assert.equal(asPlainPr.enqueue, false);
	assert.equal(asPlainPr.reason, "unhandled-event");
});

test("a review label predicate narrows exactly as it does for an auto action", () => {
	const narrowed = forgeCfg({
		triggers: {
			...prCfgRaw.triggers,
			pullRequest: [{ index: 8, actions: new Set(["review_submitted"]), reviewStates: null, predicate: { any: ["pi:review"] }, flow: "reviewfix" }],
		},
	});
	const hit = filter("pull_request_review", reviewSubset({ reviewer: "OWNER", labels: ["pi:review"] }), narrowed, SELF_ID, "d-rev-lab1");
	assert.equal(hit.enqueue, true);
	const miss = filter("pull_request_review", reviewSubset({ reviewer: "OWNER", labels: ["chore"] }), narrowed, SELF_ID, "d-rev-lab2");
	assert.equal(miss.enqueue, false);
	assert.equal(miss.reason, "no-matching-pr-trigger");
});

test("a review with no review rule armed at all drops as a plain no-match", () => {
	const noReviewRule = forgeCfg({ triggers: { ...prCfgRaw.triggers, pullRequest: [{ index: 6, actions: new Set(["opened"]), predicate: {}, flow: "autoreview" }] } });
	const r = filter("pull_request_review", reviewSubset({ reviewer: "OWNER" }), noReviewRule, SELF_ID, "d-rev-norule");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "no-matching-pr-trigger");
});

// -- on.reviewState: narrowing which verdicts may spend --------------------------------------------

test("on.reviewState fires on a listed verdict and refuses an unlisted one under its OWN reason", () => {
	const hit = filter("pull_request_review", reviewSubset({ reviewer: "OWNER", state: "changes_requested" }), reviewStateCfg, SELF_ID, "d-rvs-hit");
	assert.equal(hit.enqueue, true);
	assert.equal(hit.job.flow, "reviewfix");

	for (const state of ["approved", "commented"]) {
		const miss = filter("pull_request_review", reviewSubset({ reviewer: "OWNER", state }), reviewStateCfg, SELF_ID, "d-rvs-miss");
		assert.equal(miss.enqueue, false, `${state} is not in the narrowing and must not spend`);
		// Distinct from no-matching-pr-trigger on purpose: "your rule exists, this verdict was not in your
		// list" and "no rule matched at all" call for different operator responses.
		assert.equal(miss.reason, "review-state-not-matched");
	}
});

test("an unnarrowed rule (reviewStates null) fires on every verdict -- the narrowing only ever subtracts", () => {
	for (const state of ["approved", "changes_requested"]) {
		const r = filter("pull_request_review", reviewSubset({ reviewer: "OWNER", state }), prCfg, SELF_ID, "d-rvs-open");
		assert.equal(r.enqueue, true, `${state} must fire when no reviewState is configured`);
	}
});

test("a narrowed rule still loses to the gate: an unlisted verdict from a STRANGER reports the gate", () => {
	const r = filter("pull_request_review", reviewSubset({ author: "OWNER", reviewer: "NONE", state: "approved" }), reviewStateCfg, SELF_ID, "d-rvs-stranger");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "review-author-not-allowed");
});

// -- the per-trigger pi-packages opt-in (REQ-GLOBAL-PI-OVERLAY) -----------------------------------

// The flag rides on the RULE, so these configs deliberately disagree between rules: the filter must read it
// off whichever rule actually matched. Indices stay non-contiguous, as above.
const pkgCfgRaw = {
	triggers: {
		label: [
			{ index: 2, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix", packages: true },
			{ index: 5, predicate: { any: ["pi:docs"] }, flow: "docs" },
		],
		comment: { index: 4, phrase: "@pi", defaultFlow: "triage", packages: true },
		pullRequest: [
			{ index: 3, actions: new Set(["labeled"]), predicate: { any: ["pi:review"] }, flow: "review", packages: true },
			{ index: 6, actions: new Set(["opened"]), predicate: {}, flow: "autoreview" },
		],
		knownFlows: new Set(["frontend-fix", "docs", "triage", "review", "autoreview"]),
	},
};
const pkgCfg = forgeCfg(pkgCfgRaw);

test("a matched label/comment/PR rule with packages: true puts packages on the JOB", () => {
	const labeled = filter("issues", issuesSubset(), pkgCfg, SELF_ID, "d-pkg-label");
	assert.equal(labeled.enqueue, true);
	assert.equal(labeled.job.packages, true);

	const commented = filter("issue_comment", commentSubset(), pkgCfg, SELF_ID, "d-pkg-comment");
	assert.equal(commented.enqueue, true);
	assert.equal(commented.job.packages, true);

	const pr = filter("pull_request", prSubset({ action: "labeled", labels: ["pi:review"] }), pkgCfg, SELF_ID, "d-pkg-pr");
	assert.equal(pr.enqueue, true);
	assert.equal(pr.job.packages, true);
});

test("packages is a job-level execution knob and NEVER reaches trigger -- it must not land in /job/event.json", () => {
	// `trigger` is the descriptive context object carried verbatim into the container's event.json; an
	// execution switch appearing there would be indistinguishable from webhook-described fact.
	for (const [event, subset, delivery] of [
		["issues", issuesSubset(), "d-nt-label"],
		["issue_comment", commentSubset(), "d-nt-comment"],
		["pull_request", prSubset({ action: "labeled", labels: ["pi:review"] }), "d-nt-pr"],
	]) {
		const r = filter(event, subset, pkgCfg, SELF_ID, delivery);
		assert.equal(r.enqueue, true, `${event} must enqueue`);
		assert.equal(r.job.packages, true);
		assert.equal("packages" in r.job.trigger, false, `${event}: packages must not sit inside trigger`);
	}
});

test("an UNFLAGGED rule yields a job whose keys are exactly today's four -- byte-identical, no packages key", () => {
	const labeled = filter("issues", labeledSubset(["pi:docs"]), pkgCfg, SELF_ID, "d-unflagged-label");
	assert.equal(labeled.enqueue, true);
	assert.equal(labeled.job.flow, "docs");
	assert.deepEqual(Object.keys(labeled.job), ["repo", "target", "flow", "trigger"]);

	const pr = filter("pull_request", prSubset({ action: "opened", author: "COLLABORATOR" }), pkgCfg, SELF_ID, "d-unflagged-pr");
	assert.equal(pr.enqueue, true);
	assert.equal(pr.job.flow, "autoreview");
	assert.deepEqual(Object.keys(pr.job), ["repo", "target", "flow", "trigger"]);

	// The whole pre-existing suite runs against configs with no packages key at all -- prove that shape too.
	const legacy = filter("issues", issuesSubset(), cfg, SELF_ID, "d-unflagged-legacy");
	assert.deepEqual(Object.keys(legacy.job), ["repo", "target", "flow", "trigger"]);
});

// -- the per-trigger job image (issue #41) --------------------------------------------------------

const imgCfgRaw = {
	triggers: {
		label: [{ index: 2, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix", image: "node-playwright:1.4.0" }],
		comment: { index: 4, phrase: "@pi", defaultFlow: "triage", image: "my-python:1.2.0" },
		pullRequest: [{ index: 3, actions: new Set(["labeled"]), predicate: { any: ["pi:review"] }, flow: "review", image: "reviewer:2.0" }],
		knownFlows: new Set(["frontend-fix", "triage", "review"]),
	},
};
const imgCfg = forgeCfg(imgCfgRaw);

test("a matched label/comment/PR rule with an image puts image on the JOB", () => {
	const labeled = filter("issues", labeledSubset(["pi:frontend"]), imgCfg, SELF_ID, "d-img-label");
	assert.equal(labeled.job.image, "node-playwright:1.4.0");

	const commented = filter("issue_comment", commentSubset("@pi"), imgCfg, SELF_ID, "d-img-comment");
	assert.equal(commented.job.image, "my-python:1.2.0");

	const pr = filter("pull_request", prSubset({ action: "labeled", labels: ["pi:review"] }), imgCfg, SELF_ID, "d-img-pr");
	assert.equal(pr.job.image, "reviewer:2.0");
});

test("image is a job-level execution knob and NEVER reaches trigger -- it must not land in /job/event.json", () => {
	// `trigger` is copied verbatim into the container's event.json. Which image the harness chose is not
	// something the agent's view of its own trigger should describe, and putting it there would make an
	// execution decision look like webhook context.
	for (const [event, subset, delivery] of [
		["issues", labeledSubset(["pi:frontend"]), "d-img-t1"],
		["issue_comment", commentSubset("@pi"), "d-img-t2"],
		["pull_request", prSubset({ action: "labeled", labels: ["pi:review"] }), "d-img-t3"],
	]) {
		const r = filter(event, subset, imgCfg, SELF_ID, delivery);
		assert.ok(r.job.image, `${event}: the job carries it`);
		assert.equal("image" in r.job.trigger, false, `${event}: image must not sit inside trigger`);
	}
});

test("an unflagged rule yields a job with no image key at all -- byte-identical to today's", () => {
	const noImg = forgeCfg({ triggers: { ...imgCfgRaw.triggers, label: [{ index: 2, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix" }] } });
	const labeled = filter("issues", labeledSubset(["pi:frontend"]), noImg, SELF_ID, "d-img-none");
	assert.deepEqual(Object.keys(labeled.job), ["repo", "target", "flow", "trigger"]);
});

test("image comes from the FIRST matching rule when two rules name different images", () => {
	// The sharp case: not flag-vs-no-flag but image-A-vs-image-B. Picking the wrong one runs the whole job
	// in a toolchain the matched flow was not written for.
	const bothCfg = forgeCfg({
		triggers: {
			label: [
				{ index: 2, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix", image: "node-playwright:1.4.0" },
				{ index: 5, predicate: { any: ["pi:docs"] }, flow: "docs", image: "my-python:1.2.0" },
			],
			comment: null,
			pullRequest: [],
			knownFlows: new Set(["frontend-fix", "docs"]),
		},
	});
	const first = filter("issues", labeledSubset(["pi:frontend", "pi:docs"]), bothCfg, SELF_ID, "d-img-first");
	assert.equal(first.job.flow, "frontend-fix");
	assert.equal(first.job.image, "node-playwright:1.4.0", "the image belongs to the rule that actually matched");

	const reversed = forgeCfg({ triggers: { ...bothCfg.triggers.github, label: [...bothCfg.triggers.github.label].reverse(), knownFlows: bothCfg.triggers.knownFlows } });
	const second = filter("issues", labeledSubset(["pi:frontend", "pi:docs"]), reversed, SELF_ID, "d-img-second");
	assert.equal(second.job.flow, "docs");
	assert.equal(second.job.image, "my-python:1.2.0");
});

test("packages comes from the FIRST matching rule when two rules differ, exactly like flow", () => {
	// One event, both label rules eligible; file order decides, so the flag cannot be picked up from a
	// later rule that merely happens to also match.
	const bothCfg = forgeCfg({
		triggers: {
			label: [
				{ index: 2, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix" },
				{ index: 5, predicate: { any: ["pi:docs"] }, flow: "docs", packages: true },
			],
			comment: null,
			pullRequest: [],
			knownFlows: new Set(["frontend-fix", "docs"]),
		},
	});
	const first = filter("issues", labeledSubset(["pi:frontend", "pi:docs"]), bothCfg, SELF_ID, "d-firstwins");
	assert.equal(first.enqueue, true);
	assert.equal(first.job.flow, "frontend-fix", "the first rule in file order wins");
	assert.equal("packages" in first.job, false, "the loser's flag must not bleed onto the job");

	// Reverse the file order: now the flagged rule is first and its flag is the one that applies.
	const reversed = forgeCfg({ triggers: { ...bothCfg.triggers.github, label: [...bothCfg.triggers.github.label].reverse(), knownFlows: bothCfg.triggers.knownFlows } });
	const second = filter("issues", labeledSubset(["pi:frontend", "pi:docs"]), reversed, SELF_ID, "d-firstwins2");
	assert.equal(second.job.flow, "docs");
	assert.equal(second.job.packages, true);
});

// -- unhandled events -----------------------------------------------------------------------------

test("an unhandled event is dropped as unhandled-event", () => {
	const r = filter("push", { action: undefined, sender: { id: 7 } }, cfg, SELF_ID, "d-push");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "unhandled-event");
});

test("an unhandled action on a handled event is dropped as unhandled-event", () => {
	const r = filter("issues", issuesSubset({ action: "closed" }), cfg, SELF_ID, "d-closed");
	assert.equal(r.enqueue, false);
	assert.equal(r.reason, "unhandled-event");
});

// run.resume rides the MATCHED rule, exactly as packages/image do -- rules in one file may differ on it,
// so a job's transcript is decided by the entry that authorized it and not by the file as a whole.
const resumeCfg = forgeCfg({
	triggers: {
		label: [
			{ index: 0, predicate: { any: ["pi:fix"] }, flow: "fix", resume: true },
			{ index: 1, predicate: { any: ["pi:docs"] }, flow: "docs" },
		],
		comment: { index: 2, phrase: "@pi", defaultFlow: "triage", resume: true },
		pullRequest: [{ index: 3, actions: new Set(["synchronize"]), predicate: {}, flow: "review", resume: true }],
		knownFlows: new Set(["fix", "docs", "triage", "review"]),
	},
});

test("a matched rule's run.resume reaches the JOB, and an unflagged rule omits the key entirely", () => {
	const labelled = filter("issues", { sender: { id: 1 }, action: "labeled", issue: { number: 7, title: "T", body: "B", labels: [{ name: "pi:fix" }] } }, resumeCfg, 99, "d1");
	assert.equal(labelled.job.resume, true, "an armed trigger must carry the flag to the worker, or the store never sees it");

	// Absent rather than present-and-undefined: an unflagged job's data must stay byte-identical to what
	// it was before this feature, so the key is conditionally spread exactly as packages/image are.
	const docs = filter("issues", { sender: { id: 1 }, action: "labeled", issue: { number: 8, title: "T", body: "B", labels: [{ name: "pi:docs" }] } }, resumeCfg, 99, "d2");
	assert.equal("resume" in docs.job, false);

	const commented = filter("issue_comment", { sender: { id: 1 }, action: "created", comment: { body: "@pi", author_association: "OWNER" }, issue: { number: 9, title: "T", body: "B", labels: [] } }, resumeCfg, 99, "d3");
	assert.equal(commented.job.resume, true);
});

// --- replicas ride the MATCHED rule onto the job (REQ-REPLICA-RUNS) ---

test("replicas rides the matched rule onto the job, at JOB level and never inside trigger", () => {
	// `trigger` is the descriptive context object copied verbatim into /job/event.json. This is the count of
	// jobs to create -- the receiver reads it to decide how many times to enqueue -- so it has no business
	// there. Asserted on ALL THREE routes: one shared job literal, three places that resolve into it.
	const labelCfg = forgeCfg({ triggers: { ...cfgRaw.triggers, label: [{ index: 2, predicate: { any: ["pi:frontend"] }, flow: "frontend-fix", replicas: 2 }] } });
	const l = filter("issues", labeledSubset(["pi:frontend"]), labelCfg, SELF_ID, "d-rep-label");
	assert.equal(l.job.replicas, 2);
	assert.equal("replicas" in l.job.trigger, false);

	const commentCfg = forgeCfg({ triggers: { ...cfgRaw.triggers, comment: { index: 4, phrase: "@pi", defaultFlow: "triage", replicas: 3 } } });
	const c = filter("issue_comment", commentSubset(), commentCfg, SELF_ID, "d-rep-comment");
	assert.equal(c.job.replicas, 3);
	assert.equal("replicas" in c.job.trigger, false);

	const prReplicaCfg = forgeCfg({ triggers: { ...prCfgRaw.triggers, pullRequest: [{ index: 6, actions: new Set(["opened"]), predicate: {}, flow: "autoreview", replicas: 2 }] } });
	const p = filter("pull_request", prSubset({ action: "opened" }), prReplicaCfg, SELF_ID, "d-rep-pr");
	assert.equal(p.job.replicas, 2);
	assert.equal("replicas" in p.job.trigger, false);
});

test("an unflagged rule emits no replicas key at all -- absent, not present-and-undefined", () => {
	// The same byte-identical bar packages/image/resume hold: the key must be missing, so the enqueued job
	// data and its dedup id are the exact strings they were before the feature.
	for (const [event, subset, c] of [
		["issues", labeledSubset(["pi:frontend"]), cfg],
		["issue_comment", commentSubset(), cfg],
		["pull_request", prSubset({ action: "opened" }), prCfg],
	]) {
		const r = filter(event, subset, c, SELF_ID, "d-plain");
		assert.equal(r.enqueue, true);
		assert.equal("replicas" in r.job, false, `${event} must emit no replicas key`);
	}
});
