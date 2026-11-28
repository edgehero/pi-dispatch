/** What the control store's refusals tell a browser terminal: one rule for an attached session and for its admission. */

// A store that could not be read, or answered with nothing that parses, is no evidence anyone revoked the operator.
const STORE_UNANSWERED = Object.freeze(["control-unavailable", "control-invalid", "intent-invalid"]);
// Four words say more exactly than a revocation how an attachment ended.
const PASSED = Object.freeze(["window-lost", "watch-disabled", "watch-removed", "driver-ended"]);

/**
 * Which words each kind of answer passes through, and what any other word ends as. A renewal (`renewAttachment`, at the
 * upgrade, while a watch waits for its roster and in a session) passes the four and reads every other word as the
 * store's refusal of this authority, as it always has. An answer that starts a session (`startDriver`, `readyWatch`)
 * also answers words no renewal does, such as `roster-unseen`, that say nothing of the console, so any other word is
 * unconfirmed authority there. A driver's control passes nothing: its `driver-ended` says the room is gone, and the
 * driver's own page would read that as another driver leaving.
 */
export const GATEWAY_ANSWERS = Object.freeze({
	renewal: Object.freeze({ passed: PASSED, other: "session-ended" }),
	start: Object.freeze({ passed: PASSED, other: "authorization-unavailable" }),
	control: Object.freeze({ passed: Object.freeze([]), other: "authorization-unavailable" }),
});

/**
 * The ending for a store refusal (issues #1039, #1048, #1123). `lapsed` says whether it was read at or after the
 * gateway's own deadline for that authority. The store says `authorization-expired` of a revoked operator and of a
 * lease that ran out alike, and that deadline is never later than the store's expiry, so a refusal read before it is
 * the store's word (`authorization-expired` is the console's revocation, `session-ended`), and one read at or after it
 * is the lapse, `authorization-unavailable`, whatever its word.
 */
export function endingFor(refused, lapsed, answer = GATEWAY_ANSWERS.renewal) {
	if (lapsed || STORE_UNANSWERED.includes(refused)) return "authorization-unavailable";
	if (refused === "authorization-expired") return "session-ended";
	return answer.passed.includes(refused) ? refused : answer.other;
}
