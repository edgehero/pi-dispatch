/**
 * The refusal net (issue #969, `REQ-JOB-STATUS-COMMENTS`, `DES-TERMINAL-COMMENTS-AND-FAILURE-HOOK`).
 *
 * A forge job refused before it spent anything must say why on the item that asked for it: a label trigger fires on the
 * add, so a refusal that posts nothing leaves the requester (a person, or a dispatcher that reads the label as "a job is
 * requested") waiting for a job that will never come. Most refusals post their own fixed sentence at their call site.
 * Several did not: the pickup's model selection (`auth-mixed-billing`, `model-selection-policy-changed`, the other
 * `auth-*` and `subscription-*` refusals), `settings-overlay-invalid`, the processor's subscription admission, and the
 * prepare stage's refusals (`sha-gone`, the `pi-*` caps, the `skills-dir-*` refusals; OQ-023, accepted as "noticed rather
 * than designed").
 *
 * WHY ONE NET AND NOT A COMMENT AT EACH SITE. There are more than eighty returned refusals between the pickup and the
 * container, and every silent one found was silent by omission, not by decision. A comment added at each site fixes
 * those and misses the next one written. So the pickup counts what an attempt posts (`attemptComment`), and an attempt
 * that ends as a refusal before spend having posted NOTHING posts the reason catalog's sentence for its reason. The
 * catalog's sentences are fixed and path-free by its own rule and test, so each one may be posted as it stands, and an
 * operator reading `docs/reasons.md` reads word for word what the issue was told.
 *
 * WHAT IT NEVER DOES. It never throws, never changes the result, never retries, and never runs for a throw (a deferral,
 * an infrastructure retry, a held wait), so `CONST-RETRY-INFRA-ONLY` and `CONST-BUDGET-BEFORE-TOKENS` stand as they were:
 * it posts after the refusal, through the same adapter every refusal comment uses, which mints exactly as they do.
 *
 * WHAT IT LEAVES ALONE, and why each:
 *   - a local job: `REQ-LOCAL-JOB-VISIBILITY` already puts the reason on the `job_completed` line, and a cron package
 *     canary (always local) has no item to tell;
 *   - an answer draft, a watch and a question grouping: each has its own surface and its own refusal handling;
 *   - a lost-lock replay: the first attempt already ran this net before its completion was refused;
 *   - the reasons in SILENT_REFUSALS, each silent by a recorded decision.
 *
 * NO PHRASE GUARD, unlike the label receipt (terminal-receipt.mjs): no refusal comment has ever carried one, the bot-loop
 * guard drops the worker's own comments before any phrase is matched (receiver/src/filter.mjs), and the sentence posted
 * here is one the catalog already holds for that reason.
 */

import { CANCELLED_BEFORE_START_COMMENT, REFUSED_UNEXPLAINED_COMMENT } from "./comment-tables.mjs";
import { isForgeKind } from "./forges.mjs";
import { explainReason } from "./reason-catalog.mjs";

/**
 * Refusals before spend that stay silent on the item by decision, each with its why. A test holds every key to the
 * reason catalog and to the list in `DES-TERMINAL-COMMENTS-AND-FAILURE-HOOK`, both ways.
 */
export const SILENT_REFUSALS = Object.freeze({
	"not-parked": "a phrase-free reply to an item that is not parked is an ordinary comment, not a request; taking the stale parked label off is the visible act, and a comment on every such reply is the every-delivery hazard OQ-023 named",
	"recovery-superseded": "the outcome that superseded the recovery already said what it had to (processor.mjs), and docs/reasons.md says nothing is posted",
	"answer-draft-refused": "the draft's provenance check gates every credential mint, a refusal comment's included, and the adapter would drop the post anyway",
	"answer-draft-config-changed": "as answer-draft-refused: the provenance check gates every credential mint, and the adapter would drop the post anyway",
	"duplicate-request": "the notice posts its own fixed comment, and a notice too malformed to word is answered by the record alone (duplicate-notice.mjs)",
});

/**
 * Wrap the comment adapter for ONE attempt and count the calls made through it. The count is of calls MADE, not of
 * posts that succeeded: the adapter swallows a failed POST and logs it, and a second post after it would put the same
 * refusal on the item twice. `comment` is null when there is no adapter, so `if (said.comment)` reads as `if (deps.comment)`
 * did. Never shared between jobs: the processor's deps are, so the count must not live on them.
 */
export function attemptComment(comment) {
	let count = 0;
	return {
		comment: typeof comment === "function" ? (data, text) => { count += 1; return comment(data, text); } : null,
		posted: () => count,
	};
}

/**
 * The text the net posts for this attempt, or null when it posts nothing: `{ text, unexplained }`, where `unexplained`
 * says the catalog had no sentence for the reason and the fixed fallback was chosen. Pure, and never throws.
 */
export function refusalNetText({ data, result, posted = 0, replay = false } = {}) {
	try {
		if (result === null || typeof result !== "object" || result.outcome !== "policy" || result.budgetReserved !== false) return null;
		const reason = result.reason;
		if (typeof reason !== "string" || reason === "") return null;
		if (posted !== 0 || replay === true) return null;
		if (data === null || typeof data !== "object" || !isForgeKind(data.kind)) return null;
		if (data.target === null || typeof data.target !== "object") return null;
		if (data.answerDraft || data.purpose === "answer-draft" || data.watch || data.questionGrouping) return null;
		if (Object.hasOwn(SILENT_REFUSALS, reason)) return null;
		// The pickup's cancel rewrite (index.mjs) turns a refusal that ended after the operator's cancel was acknowledged
		// into `operator-cancel`; the catalog's sentence for that token is the general one shared with a cancel mid-run,
		// so the net posts the before-start sentence the pickup's own cancel posts.
		if (reason === "operator-cancel") return { text: CANCELLED_BEFORE_START_COMMENT, unexplained: false };
		const explained = explainReason(reason, { why: typeof result.why === "string" ? result.why : null });
		if (explained.known === true && typeof explained.sentence === "string" && explained.sentence !== "") return { text: explained.sentence, unexplained: false };
		return { text: REFUSED_UNEXPLAINED_COMMENT, unexplained: true };
	} catch {
		return null;
	}
}
