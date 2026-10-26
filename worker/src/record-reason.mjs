/**
 * The run record's `reason` field (INT-RUN-HISTORY-FILE-CONTRACT): the token charset every reader holds it to, the
 * tokens for the failures that carried only a message, and the door every record goes through on its way in. A LEAF:
 * it imports nothing, so the admin console imports it (`@edgehero/pi-dispatch/record-reason`) without pulling in the
 * worker.
 *
 * A record's reason is a token, never free text: a thrown error's message can carry a forge's API path, a repository
 * name or a library's own words, and the record is read by every console role. So a result's reason that is no token
 * is recorded as no reason, and an error's as `worker-error`, the failure the worker has no reason of its own for.
 */

/** A record reason: lowercase letters, digits and dashes, 1 to 64 characters, starting with a letter or digit. */
export const RECORD_REASON_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The runner's infrastructure exit (exit code 1): the container ended on a fault the runner counts as infrastructure. */
export const CONTAINER_INFRA_EXIT = "container-infra-exit";
/** An exit code the runner never uses: the worker cannot tell what happened. */
export const CONTAINER_EXIT_UNKNOWN = "container-exit-unknown";
/** A failure the worker has no reason for: an error with no token (a forge or Valkey call that failed, a worker fault). */
export const WORKER_ERROR = "worker-error";

/**
 * The record's session reasons that say the conversation was NOT saved, and the ones that cannot say. A session is
 * written only by the store's promotion, on the completed branch, so every promote refusal and the `disabled` of a job
 * that keeps none says "not saved"; but `absent`, `not-a-regular-file` and `too-large` are written by the resolve step
 * and by the promote step alike, so from the record alone they do not tell a saved session from one that was not.
 * session-reasons.test.mjs derives both lists from the store's refusals.
 */
export const SESSION_NOT_SAVED = Object.freeze(["disabled", "key-not-a-directory", "locked", "promote-failed", "transcript-diverted"]);
export const SESSION_SAVE_AMBIGUOUS = Object.freeze(["absent", "not-a-regular-file", "too-large"]);

/** The door: a result's reason when it is a token, else null; an error's when it is a token, else `WORKER_ERROR`. */
export function recordReasonOf({ result = null, error = null } = {}) {
	if (result) return typeof result.reason === "string" && RECORD_REASON_RE.test(result.reason) ? result.reason : null;
	const r = error?.reason;
	return typeof r === "string" && RECORD_REASON_RE.test(r) ? r : WORKER_ERROR;
}
