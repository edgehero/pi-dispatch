import { createHash } from "node:crypto";
import { issueBranch } from "./branch.mjs";
import { isForgeKind } from "./forges.mjs";

/**
 * session-key.mjs -- which persisted transcript, if any, a job runs on.
 *
 * PURE and TOTAL, no I/O, no throw. That is the same discipline filter.mjs holds, and for the same
 * reason: the cross-repo and cross-PR safety of this whole feature lives in this one function, and a
 * security-critical decision that needs a network to test is a decision nobody re-tests.
 *
 * DERIVED, NEVER LOOKED UP (DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED). There is no index mapping "PR #123"
 * to "the job that opened it" and there will not be one: an index is a query surface, and this project
 * deliberately has no database (INT-RUN-HISTORY-FILE-CONTRACT). The key is computed from what the job
 * already carries, so a mismatch is unrepresentable rather than merely unlikely.
 *
 * WHAT THE KEY ACTUALLY BINDS, stated honestly because the flattering version is wrong. It is tempting
 * to say issue numbers never recycle, so `pi/issue-<n>` names one issue's lineage forever. It does not.
 * `pi/issue-<n>` is asked for by a prompt and by a hard rule; nothing verifies that a pull request is
 * actually on it, and a branch -- unlike an issue number -- can be deleted and re-created by anyone who
 * can push. The key is a NAME, and its namespace is the base repository's push-access population. That
 * is one step wider than the population CONST-NO-CONTEXT-FILES-MANDATORY already trusts. The residual
 * is OQ-014; what bounds it is here, in the two rules below.
 *
 * Rule one: the repository half is always the BASE repo. A fork's `full_name` is attacker-chosen and
 * must never select a directory. Rule two: a fork resolves NO KEY AT ALL -- returning null rather than
 * setting a flag a later stage has to remember to check. Without it, a stranger who forks, names a
 * branch `pi/issue-7` and gets a collaborator to act on the pull request would be handed issue 7's
 * transcript.
 *
 * The returned string is a HASH, not a path built from the branch. A ref is attacker-influenced free
 * text and validating it into a safe path segment is the losing half of that argument; hashing makes
 * traversal unreachable. It also keeps a directory listing PII-free by construction, the same property
 * `local:<basename>` gives the run record.
 */

/** Long enough that a collision is not a thing to reason about, short enough to read in a log line. */
const KEY_LENGTH = 32;

/**
 * @param {object} job - The job data (`kind`, `repo`, `target`, `trigger`).
 * @param {object} [resolved] - `{ headRef, headRepo }` for a pull/merge-request target, from the FORGE
 *   API rather than the webhook payload. Absent or incomplete means no key, which is a cold start.
 * @returns {string|null} A hex key, or `null` when this job has no durable identity to resume against.
 */
export function sessionKeyFor(job, resolved = {}) {
	const parts = keyParts(job, resolved);
	if (parts === null) return null;
	// NUL-delimited so ("a", "bc") and ("ab", "c") cannot collide -- the same reasoning job-id.mjs uses.
	return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, KEY_LENGTH);
}

/**
 * The key's material, before hashing. Exported for tests and for the operator-facing `doctor` line: the
 * hash is deliberately unreadable, so the one place that can explain a directory is the function that
 * built it.
 */
export function keyParts(job, resolved = {}) {
	const kind = job?.kind;

	// Keyed on "is this a forge job", never on a list of forge names. An enumeration that forgot one would
	// not throw: every job on that forge would resolve no key and cold-start forever, which looks exactly
	// like a deployment that never armed run.resume. `local` is handled below, on its own terms.
	if (isForgeKind(kind)) {
		const repo = job?.repo;
		if (typeof repo !== "string" || repo === "") return null;

		if (job?.target?.type === "pull_request") {
			const { headRef, headRepo } = resolved;
			if (typeof headRef !== "string" || headRef === "") return null;
			// THE FORK GATE. Absence of a key, never a boolean: there is no later stage that could forget
			// to check this, because there is nothing to check -- the job simply has no session.
			if (typeof headRepo !== "string" || headRepo !== repo) return null;
			return [kind, repo, headRef];
		}

		// An issue-triggered job's branch is the one its own envelope names, minted by the same function
		// (branch.mjs) so the two cannot drift. issueBranch throws on a non-positive-integer number; this
		// function is total, so that becomes "no key" rather than a failed job.
		//
		// ONE ARGUMENT, DELIBERATELY, and it must stay that way (REQ-REPLICA-RUNS). `issueBranch` takes an
		// optional replica index and a replica job's envelope names `pi/issue-<n>-r<i>`, so this call is
		// knowingly resolving a key for a branch that job was not told to push to. That is safe only because
		// `triggers.mjs` refuses `run.replicas` together with `run.resume`: a replica job never resumes, so
		// the key it would resolve is never read. Relax that refusal and every replica of one issue resolves
		// the SAME key -- one transcript, N writers, fighting the store's one-writer lock. If the refusal
		// ever goes, the replica index has to arrive here too. The coupling is stated in branch.mjs as well.
		try {
			return [kind, repo, issueBranch(job?.target?.number)];
		} catch {
			return null;
		}
	}

	if (kind === "local") {
		// A cron job's scheduler id is the strongest key here and the only one chosen by nobody untrusted:
		// it is operator-authored, [A-Za-z0-9._-]+, unique across the triggers file, and stable across
		// fires. A nightly job that remembers last night is the safest instance of this feature.
		const id = job?.trigger?.id;
		if (typeof id !== "string" || id === "") return null;
		return ["local", "", id];
	}

	// Everything else -- a CLI `pi-dispatch run`, a chained /outbox child -- has no trigger entry that
	// could have armed run.resume, so there is nothing to honour and no stable identity to key on. A job
	// kind that is neither a forge nor local lands here too, which is the safe direction: no session.
	return null;
}
