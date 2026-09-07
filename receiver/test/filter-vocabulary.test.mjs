import { test } from "node:test";
import assert from "node:assert/strict";
import { PR_ACTIONS as LOADER_PR_ACTIONS, PR_CLOSE_ACTIONS } from "@edgehero/pi-dispatch/triggers";
import { PR_ACTIONS as GITHUB_ROUTED } from "../src/filter.mjs";
import { MR_ACTIONS as GITLAB_ROUTED } from "../src/filter-gitlab.mjs";
import { PR_ACTIONS as FORGEJO_ROUTED } from "../src/filter-forgejo.mjs";
import { PR_ACTION_FOR } from "../src/filter-azure.mjs";
import { mapAction } from "../src/forgejo-subset.mjs";

/**
 * The receiver's four PR route gates against the loader's vocabulary they mirror.
 *
 * The hazard is a SILENCE, which is why this is worth a test at all: a word the loader accepts and a
 * route gate does not means the trigger validates, writes, live-reloads and then never fires -- the
 * delivery falls out as `unhandled-event` and nobody is reading drop reasons. The opposite direction
 * enqueues on an event no trigger can name. Both are on a PAID path.
 *
 * PINNED rather than DERIVED, deliberately. The relation is not one formula but three -- minus-close,
 * minus-close-minus-review, and translate-then-minus-close -- so a derive would replace four readable
 * literals with three hand-written expressions, each able to be wrong in the same silent way, and would
 * hide the very words a reviewer of a security-relevant filter needs to see beside the payload. Encoding
 * the RELATION and letting it fail loudly keeps both.
 *
 * Each test names its own exclusions rather than sharing a helper: the exclusions are the interesting
 * part, and `filter-gitlab.test.mjs` records what it cost the last time one was wrong ("`close` was
 * simply not in MR_ACTIONS, so a closing MR read as an event this...").
 */

const minus = (set, ...excluded) => new Set([...set].filter((a) => !excluded.includes(a)));

test("github's routed PR actions are the loader's github set minus the close word and minus review_submitted", () => {
	// Both exclusions are ROUTES, not gaps: `closed` reaches findCloseRule and `review_submitted` its own
	// arm on the pull_request_review event, so neither belongs in the action gate.
	assert.deepEqual(GITHUB_ROUTED, minus(LOADER_PR_ACTIONS.github, PR_CLOSE_ACTIONS.github, "review_submitted"));
	// Asserted as absences too, so a future "fix" that closes the apparent gap by adding them -- and
	// thereby double-routes a close or a review -- fails here rather than in production.
	assert.equal(GITHUB_ROUTED.has(PR_CLOSE_ACTIONS.github), false, "the close word is routed by findCloseRule, never by this gate");
	assert.equal(GITHUB_ROUTED.has("review_submitted"), false, "a submitted review has its own arm");
});

test("gitlab's routed MR actions are the loader's gitlab set minus the close word", () => {
	// No review analogue to exclude: gitlab's `approved` is one verdict rather than every verdict, so it
	// rides `pull_request` and is genuinely in both sets.
	assert.deepEqual(GITLAB_ROUTED, minus(LOADER_PR_ACTIONS.gitlab, PR_CLOSE_ACTIONS.gitlab));
	assert.equal(GITLAB_ROUTED.has(PR_CLOSE_ACTIONS.gitlab), false, "close is routed separately here too");
	assert.ok(GITLAB_ROUTED.has("approved"), "approved is a gitlab MR action, not a review route");
});

test("forgejo's routed PR actions are the loader's forgejo set translated by mapAction, minus the close word", () => {
	// This is the test that explains the single most confusing line in the four filter files: forgejo's
	// gate reads in GITHUB spellings while the loader stores forgejo's own, because forgejo-subset's
	// mapAction translates the raw word into this codebase's vocabulary before the gate sees it. Built by
	// mapping rather than asserted as a literal, so the translation is the thing under test.
	const translated = new Set([...minus(LOADER_PR_ACTIONS.forgejo, PR_CLOSE_ACTIONS.forgejo)].map((a) => mapAction("pull_request", a)));
	assert.deepEqual(FORGEJO_ROUTED, translated);
	assert.equal(translated.has(null), false, "every non-close forgejo action must translate to something");
});

test("azure's event-to-action map has the loader's azure vocabulary as its values, and no close word exists on either side", () => {
	assert.deepEqual(new Set(Object.values(PR_ACTION_FOR)), LOADER_PR_ACTIONS.azure);
	// Recorded beside the equality because it is WHY azure is the one forge whose gate equals the loader
	// exactly: an abandon arrives as a plain `updated` with nothing in the projected subset to tell it
	// apart, so there is no close word to subtract. If one is ever added, this line is the reminder that
	// this test must gain a subtraction like its three siblings.
	assert.equal(PR_CLOSE_ACTIONS.azure, undefined, "azure has no close word -- INT-AZURE-PAYLOAD-SUBSET is the gap");
});
