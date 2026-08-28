/**
 * The ONE derivation of "which close rule matches this delivery" (issue #231), shared by every
 * forge's close route and by the GitHub arm's wants-authority predicate. Two copies of a gate
 * decision is the shape filter.mjs's prAuthorOk comment warns against, and here the two callers are
 * a NETWORK CALL apart: the receiver asks "does any rule want this close" before spending a
 * permission lookup, and the filter asks it again to route -- if those two answers could drift, a
 * delivery could cost a lookup it then drops, or worse, route a close the lookup never gated.
 *
 * Total and throw-free like predicate.mjs: rules are loader-validated shapes, the inputs are
 * adversarial payload fields, and the receiver's gates must never throw on data.
 */

/**
 * Find the first rule (file order, firstMatchingRule's convention) whose action set has this close
 * word and whose `number` narrowing (when present) names this item. Returns:
 *   { rule }                                  -- matched; the caller gates and enqueues
 *   { reason: "close-number-not-matched" }    -- a close rule is armed but names a different item
 *   { reason: "no-matching-close-trigger" }   -- nothing armed wants this close
 * The two refusal tokens are distinct because they call for different operator responses: "your
 * one-shot exists and this was a different item closing" and "nothing is armed" read nothing alike
 * from a panel.
 */
export function findCloseRule(rules, closeWord, number) {
	let numberSkipped = false;
	for (const rule of rules ?? []) {
		if (!rule.actions?.has(closeWord)) continue;
		if (rule.number !== undefined && rule.number !== number) {
			numberSkipped = true;
			continue;
		}
		return { rule };
	}
	return { reason: numberSkipped ? "close-number-not-matched" : "no-matching-close-trigger" };
}
