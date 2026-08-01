/**
 * branch.mjs -- a job's target reference: the number, validated, and the branch derived from it.
 *
 * Both halves lived in github-prompt.mjs, and while the prompt was the only reader that was right: two
 * small helpers next to the prose explaining them, with gitlab-prompt.mjs importing the number check
 * because refusing a non-positive-integer reference is not a fact about GitHub.
 *
 * The session store changed the shape. It keys on the same `pi/issue-<n>` string the prompt names
 * (REQ-RESUMABLE-SESSION), so the branch now has two readers that must agree -- and it cannot import it
 * from github-prompt.mjs without a cycle, since the prompt would import the branch back. Hence a leaf
 * module with no imports of its own.
 *
 * The drift this forecloses is the silent kind. A second copy of `pi/issue-${n}` would not fail: it would
 * resolve a key for a branch the agent was never told to push to, so every resume would miss and every
 * job would look like an ordinary cold start. Making the two readers call one function is the whole
 * reason this file exists.
 *
 * THE THIRD FACT, added with replica runs (REQ-REPLICA-RUNS), and the most important one here:
 * `session-key.mjs` calls this with ONE argument and must keep doing so. That is safe only because
 * `triggers.mjs` refuses `run.replicas` together with `run.resume` -- relax that refusal and every replica
 * of one issue resolves the same session key, sharing a transcript and fighting the one-writer lock. The
 * coupling is stated in both files, because a reader arriving at either one has to be able to see it.
 *
 * `dataRegion` deliberately stays in github-prompt.mjs -- it is about placing untrusted text below the
 * isolation delimiter (CONST-ISSUE-TEXT-IS-DATA), which is a prompt concern, not a reference concern.
 */

/** The number must be trustworthy; a positive integer is the only accepted issue/PR/MR reference. */
export function normalizeNumber(number) {
	const n = Number(number);
	if (!Number.isInteger(n) || n <= 0) {
		const error = new Error(`invalid target number (must be a positive integer): ${String(number)}`);
		error.piDispatchConfig = true;
		throw error;
	}
	return n;
}

/**
 * A replica index must be as trustworthy as the number, and STRICTER: `normalizeNumber` coerces because a
 * target number arrives from a forge payload and may be a string, and the prompt and the session key must
 * not disagree over which of them was handed one. A replica index has no such origin -- it is minted by
 * `triggers.mjs` as an integer and carried on job data by our own code -- so a string here is a caller bug,
 * and `job-id.mjs` refuses one on the same grounds. If one of the two coerced and the other did not, a
 * `"2"` would produce `pi/issue-7-r2` alongside an unsuffixed jobId, and the two would disagree about
 * whether the run is a replica at all.
 */
function positiveReplica(replica) {
	if (!Number.isInteger(replica) || replica <= 0) {
		const error = new Error(`invalid replica index (must be a positive integer): ${String(replica)}`);
		error.piDispatchConfig = true;
		throw error;
	}
	return replica;
}

/**
 * The branch an issue-triggered job commits to, on both forges.
 *
 * Derived solely from the issue number -- a stable, forge-assigned integer -- and never from the mutable
 * title or body, so a re-run of the same issue always converges on the same branch. That convergence is
 * what makes the branch usable as a session key at all: it is the only host-computable join between an
 * issue and the pull/merge request its job opened (DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED).
 *
 * A REPLICA breaks that convergence on purpose (REQ-REPLICA-RUNS). Two replicas of one issue exist to
 * produce two independent pull requests, so they must not share a branch -- one branch would make them a
 * push race, not a comparison. The suffix is SYMMETRIC: with `replicas: 2` the branches are
 * `pi/issue-7-r1` and `pi/issue-7-r2`, and neither is "the original", which is the whole point. An
 * unflagged run passes no second argument and mints exactly the string it minted before.
 *
 * @param {number|string} number - The issue's number/iid. Must normalise to a positive integer.
 * @param {number} [replica] - The 1-based replica index, or undefined for an unreplicated run.
 * @returns {string} e.g. `pi/issue-7`, or `pi/issue-7-r2` for replica 2.
 * @throws {Error} tagged `piDispatchConfig` when the number or the replica is not a positive integer.
 */
export function issueBranch(number, replica) {
	const base = `pi/issue-${normalizeNumber(number)}`;
	if (replica === undefined) return base; // byte-identical to an unreplicated run
	return `${base}-r${positiveReplica(replica)}`;
}
