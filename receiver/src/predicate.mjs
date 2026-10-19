/**
 * The label predicate and its helpers: the `{any, all, none}` evaluation every forge's gate runs, plus the
 * two small readers around it.
 *
 * Shared rather than copied (issue #42). This is the rule that decides whether an event becomes a paid
 * agent run, and on the github label path it IS the approval gate (CONST-TRIGGER-AUTHOR-GATE). Two
 * implementations of that would eventually disagree, and the forge whose copy drifted would be the one
 * quietly running work nobody approved.
 *
 * Pure and total: reads only its arguments, touches no I/O, never throws -- which is what keeps each
 * forge's gate decidable offline, without a server, a socket, or a queue.
 */

/** The set of label names present on an issue/PR; non-string names are dropped. */
export function labelSet(labels) {
	const arr = Array.isArray(labels) ? labels : [];
	return new Set(arr.map((l) => l?.name).filter((n) => typeof n === "string"));
}

/** First rule (in file order) whose predicate matches `L`, or undefined. The rule carries its raw-file `index`. */
export function firstMatchingRule(rules, L) {
	for (const rule of rules ?? []) {
		if (matchesRule(L, rule.predicate)) return rule;
	}
	return undefined;
}

/**
 * The label that satisfied a matched rule's positive selector, for `trigger.matched.label`: the first
 * `any` entry present in `L`, else `all[0]` (all ⊆ L holds whenever the rule matched, so membership is
 * guaranteed), else null. Deterministic in rule order -- honest about WHICH label opened the gate, not
 * merely that one did.
 */
export function matchedLabel(L, predicate) {
	const anyHit = (predicate?.any ?? []).find((x) => L.has(x));
	if (anyHit !== undefined) return anyHit;
	return predicate?.all?.[0] ?? null;
}

/**
 * Per-rule label predicate over the label set `L`:
 *   (any empty OR L∩any ≠ ∅) AND (all ⊆ L) AND (L∩none = ∅).
 * An empty `any` is vacuously true, so the `all`/`none` clauses carry the requirement; the loader
 * guarantees at least one positive selector where the predicate is the approval gate (label triggers and
 * `labeled` PR triggers), so a validated approval rule can never match every event. Reads only its
 * arguments and never throws -- the gate's purity extends here, and the defensive `?? []` covers a rule
 * the loader has already validated.
 */
export function matchesRule(L, rule) {
	const any = rule?.any ?? [];
	const all = rule?.all ?? [];
	const none = rule?.none ?? [];
	if (any.length > 0 && !any.some((x) => L.has(x))) return false;
	if (!all.every((x) => L.has(x))) return false;
	if (none.some((x) => L.has(x))) return false;
	return true;
}

/** Escape a literal string for safe embedding in a RegExp -- the trigger phrase is config, not a pattern. */
export function escapeRegExp(literal) {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which way a phrase comment steers a running job (issue #646): `"followUp"` when the word right after the FIRST
 * occurrence of the phrase is `later` (lowercase, a whole word, separated from the phrase by spaces or tabs only),
 * else `"steer"`. The caller has already established that the body holds the phrase.
 *
 * The first occurrence only, and the word immediately after it only: anywhere else `later` is ordinary prose ("fix it
 * later today" further down must not turn a correction into a follow-up). A newline between the phrase and the word
 * does not count, because a phrase on its own line followed by a paragraph that opens with "Later" or "later" is
 * prose, not a grammar word. Case-sensitive for the same reason. The delivered text is always the whole body: the
 * word chooses the mode, it is never stripped.
 */
export function steerModeOf(body, phrase) {
	if (typeof body !== "string" || typeof phrase !== "string" || phrase === "") return "steer";
	const at = body.indexOf(phrase);
	if (at < 0) return "steer";
	return /^[ \t]+later(?=\s|$)/.test(body.slice(at + phrase.length)) ? "followUp" : "steer";
}

/**
 * A filter's drop result as the receiver sees it (issue #638, DES-AWAIT-INPUT-ENDS-THE-JOB). A comment route that
 * dropped a phrase-free reply ONLY because the parked marker was not on the issue yet returns `heldResolved`, the route
 * it would have taken with the marker; this turns that into `heldCandidate`, the JOB that route builds, through the
 * filter's own `build`, and returns every other drop exactly as it came (no key added, so its bytes are today's). A
 * candidate whose build refuses (an Azure work item with no repository) is no candidate.
 *
 * Why the filter says it and not the receiver: the agent posts its question itself and only then calls the tool, so a
 * person can answer in the seconds before the run has parked and the marker is set. Whether that reply would have
 * resumed the run is a question about the trigger file and the payload, which only the filter reads; whether a run is
 * parking right now is a Valkey question, which only the receiver asks. Still a drop: the filter stays pure.
 */
export function heldCandidateOr(dropped, build) {
	if (dropped?.heldResolved === undefined) return dropped;
	const { heldResolved, ...drop } = dropped;
	const built = build(heldResolved);
	return built?.enqueue === true ? { ...drop, heldCandidate: built.job } : drop;
}
