/**
 * Host-side GitHub reads and writes the worker performs AROUND a job, distinct from anything the
 * agent does inside its container: resolve the default-branch tip, decide whether that branch is
 * protected, and post an outcome comment back to the triggering issue.
 *
 * REQ-BRANCH-PROTECTION-PRECONDITION / CONST-MERGE-NEVER-AUTOMATIC: `isDefaultBranchProtected` is
 * the free gate the processor consults before spending. The agent's scoped token carries
 * contents:write, which covers push AND merge, so branch protection is the only technical barrier
 * to a self-merge. A transient read failure must therefore NOT collapse to "unprotected" and let
 * the job run: only a determinate answer that no classic rule and no ruleset requiring an approved
 * pull request covers the default branch drives the policy refusal; a determinate 403 (the token may
 * not read, issue #876) is a refusal of its own; any other error, and an answer of the wrong shape,
 * is retryable and never a silent `false`.
 *
 * REQ-JOB-STATUS-COMMENTS: `postStatusComment` reports outcome to the issue or PR. It is content-
 * agnostic -- the no-trigger-phrase guard belongs to the caller -- and never logs the comment body or
 * any issue/PR-derived content (no-pii-in-logs); a job is identified by `repo#number` alone.
 *
 * CONST-TOKEN-SCOPED-PER-JOB: the token is minted per job and passed to every method. Each method
 * constructs a FRESH Octokit through the injected `octokitFor(token)`; no client is cached or reused
 * across calls, so one job's short-lived credential never bleeds into another job's request.
 *
 * `octokitFor` is injected -- defaulting to the real `@octokit/rest` -- so the module is testable
 * offline against a fake `request(route, params)`, matching the identity.mjs / get-token.mjs
 * convention. This module calls NO merge API of any kind.
 */

import { Octokit } from "@octokit/rest";
import { BRANCH_PROTECTION_UNREADABLE } from "./comment-tables.mjs";
import { configError } from "./config.mjs";
import { octokitLogOptions } from "./octokit-log.mjs";
import { PARKED_LABEL } from "./parked.mjs";
import { InfraRetry } from "./processor.mjs";
import { commentIdOf, isStatusCommentId } from "./status-comment.mjs";
import { isTransientStatus, octokitHeaderReader } from "./transient.mjs";

/**
 * Build the host surface. `octokitFor` is `(token) => new Octokit({ auth: token, ...octokitLogOptions(log) })`; inject a fake
 * to test offline. `log` is the caller's `(event, fields)` logger for the client's own warnings
 * (`octokitLog`, issue #530). Returns `{ resolveDefaultBranchSha, isDefaultBranchProtected, postStatusComment, editStatusComment, ... }`.
 */
export function makeGitHubHost({ log, octokitFor = (token) => new Octokit({ auth: token, ...octokitLogOptions(log) }) } = {}) {
	/**
	 * Resolve the default branch and its tip SHA with FRESH API calls only -- never a webhook field.
	 * `GET /repos/{owner}/{repo}` yields `default_branch`; `GET .../branches/{branch}` yields the tip.
	 * Returns `{ branch, sha }` so the caller has both the name and the commit to clone at.
	 */
	async function resolveDefaultBranchSha(repo, token) {
		const [owner, name] = splitRepo(repo);
		const octokit = octokitFor(token);
		const { data: repoData } = await octokit.request("GET /repos/{owner}/{repo}", {
			owner,
			repo: name,
		});
		const branch = repoData.default_branch;
		const { data: branchData } = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", {
			owner,
			repo: name,
			branch,
		});
		return { branch, sha: branchData.commit.sha };
	}

	/**
	 * Whether the default branch is protected in the sense the never-merge backstop needs: a classic branch
	 * protection rule covers it, or an ACTIVE ruleset requires an approved pull request for it.
	 *
	 * THREE READS, the third only when the second cannot settle it (issue #876):
	 * 1. `GET /repos/{o}/{r}` names the default branch (Metadata: read).
	 * 2. `GET /repos/{o}/{r}/branches/{branch}` (Contents: read). `protection.enabled` is the classic rule, and
	 *    `true` admits the branch, as the old check admitted any classic rule. `protected: false` refuses it.
	 * 3. When `protected` is true with no classic rule, a RULESET set it, and GitHub sets the flag for ANY active
	 *    ruleset, including ones that block nothing: measured read-only on 2026-11-14, `github/scientist@main`
	 *    answers `protected: true` with `protection.enabled: false`, and its only rules are `copilot_code_review`
	 *    and `license_compliance_scanning`, from organization rulesets (GitHub's own setup for automatic Copilot
	 *    reviews is such a ruleset, often organization-wide). Reading the flag alone would admit every repository
	 *    of such an organization while nothing stops the job's contents:write from pushing to the default branch.
	 *    So `GET /repos/{o}/{r}/rules/branches/{branch}` (Metadata: read, which every token has, an answer draft's
	 *    narrowed one included) is read, and the branch counts only with a `pull_request` rule whose
	 *    `required_approving_review_count` is at least 1. GitHub documents that this read returns the rules of
	 *    active rulesets only ("Rules in rulesets with "evaluate" or "disabled" enforcement statuses are not
	 *    returned"), so a ruleset that is only evaluated never counts.
	 *
	 * WHY AN APPROVAL, AND NOT ANY `pull_request` RULE. A pull request rule with no required approval stops a
	 * direct push but not the agent opening a pull request and merging it with its own contents:write token. An
	 * approval is what a self-merge cannot supply, since GitHub does not let a pull request's author approve it.
	 * The classic arm is not held to the same bar, because the old check admitted any classic rule and this
	 * change refuses nothing it admitted; that leniency is the residual `REQ-BRANCH-PROTECTION-PRECONDITION` names.
	 *
	 * WHY NOT `.../branches/{branch}/protection`, which this read used, with its 404 as "unprotected". It needs
	 * Administration: read ("Permissions required for GitHub Apps"), which the App `pi-dispatch setup github`
	 * makes never asked for, so every job on such an App was answered 403 and retried into a failure, and it sees
	 * no ruleset, so a branch protected by rulesets alone was refused.
	 *
	 * A determinate 403 on any of the three throws a config error tagged `reason: BRANCH_PROTECTION_UNREADABLE`,
	 * which the processor returns as a refusal. Any other error, a missing default branch, a `protected` that is
	 * not a boolean and a rules answer that is not a list are retryable (InfraRetry), NOT `false`: a blip, or a
	 * GitHub that changed its answer's shape, must not read as "unprotected" and bypass the never-merge backstop.
	 * The one 404 that answers is the branch read's, below.
	 */
	async function isDefaultBranchProtected(repo, token) {
		const [owner, name] = splitRepo(repo);
		const octokit = octokitFor(token);
		const failed = (error, what) => {
			if (error instanceof InfraRetry) return error;
			// A 403 that is not a rate limit (issue #876) is the token being refused the read: a fine-grained token
			// without access to the repository's contents, a token not yet authorized for an organization's single
			// sign-on. Each answers the same on every retry, so it used to be retried into a `worker-error` failure
			// that named no cause. It is neither `true` nor `false`: the backstop is unconfirmed, so the job must not
			// run, and "unprotected" would send the operator to fix the wrong thing. `isTransientStatus` is the
			// project's one rule for a 403 (transient.mjs): GitHub's primary limit (`x-ratelimit-remaining: 0`), its
			// secondary limit by header or by body, and a proxy's non-JSON page in front of the API all stay
			// retryable. The cause rides along so the refusal's log line can name GitHub's request id.
			if (error?.status === 403 && !isTransientStatus(403, octokitHeaderReader(error), error?.message)) {
				return Object.assign(configError(`github-host: the token may not read ${what} of ${owner}/${name} (status 403)`), { reason: BRANCH_PROTECTION_UNREADABLE, cause: error });
			}
			return new InfraRetry(`github-host: ${what} of ${owner}/${name} could not be read (status ${error?.status ?? "unknown"})`);
		};

		let repoData;
		try {
			({ data: repoData } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo: name }));
		} catch (error) {
			throw failed(error, "the repository");
		}
		const branch = repoData?.default_branch;
		if (typeof branch !== "string" || branch === "") {
			throw new InfraRetry(`github-host: ${owner}/${name} reported no default branch`);
		}

		let branchData;
		try {
			({ data: branchData } = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", { owner, repo: name, branch }));
		} catch (error) {
			// An EMPTY repository: it names a default branch that has no commit yet, and GitHub answers that branch
			// 404 "Branch not found". The repository read just succeeded with this token, so the repository is
			// visible, and a branch that does not exist is not protected: `unprotected-branch`, as the protection
			// endpoint's 404 answered it before #876, and determinately, since a retry of an empty repository is only
			// told the same thing again. The one other way here, the default branch renamed between the two reads, is
			// refused the same way, and the next trigger reads the new name.
			if (error?.status === 404) return false;
			throw failed(error, "the default branch");
		}
		if (typeof branchData?.protected !== "boolean") {
			throw new InfraRetry(`github-host: the default branch of ${owner}/${name} came back without a boolean protected`);
		}
		if (branchData.protection?.enabled === true) return true;
		if (branchData.protected === false) return false;

		// A ruleset set the flag. Paged (GitHub's maximum page is 100), and stopped at the first qualifying rule.
		for (let page = 1; page <= RULES_PAGE_CAP; page++) {
			let rules;
			try {
				({ data: rules } = await octokit.request("GET /repos/{owner}/{repo}/rules/branches/{branch}", { owner, repo: name, branch, per_page: RULES_PER_PAGE, page }));
			} catch (error) {
				throw failed(error, "the default branch's rules");
			}
			if (!Array.isArray(rules)) {
				throw new InfraRetry(`github-host: the default branch's rules of ${owner}/${name} came back without a list`);
			}
			if (rules.some(requiresApprovedPullRequest)) return true;
			if (rules.length < RULES_PER_PAGE) return false;
		}
		// More active rules than the cap reads, none of them a qualifying one: not a determinate answer, so retried
		// and failed with this sentence rather than read as unprotected.
		throw new InfraRetry(`github-host: the default branch of ${owner}/${name} has more than ${RULES_PAGE_CAP * RULES_PER_PAGE} active rules`);
	}

	/**
	 * Post `text` as a comment on `target` -- the job's discriminated `{ type, number }`.
	 * Content-agnostic: `text` is passed through as `body` verbatim, never inspected, filtered, or logged.
	 *
	 * `target.type` is deliberately UNREAD here: on GitHub an issue and a pull request share one number
	 * sequence and one `/issues/{n}/comments` endpoint, so posting to a PR number comments on the PR
	 * conversation. The parameter is the whole target rather than a bare number because that is what a
	 * forge whose issue and merge-request comments are DIFFERENT endpoints needs, and a host method that
	 * cannot be called uniformly is not a seam. Passing the number alone would push that discrimination
	 * into the caller, where it would have to know which forge it was talking to.
	 */
	async function postStatusComment(repo, target, text, token) {
		const [owner, name] = splitRepo(repo);
		const octokit = octokitFor(token);
		const { data } = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
			owner,
			repo: name,
			issue_number: target?.number,
			body: text,
		});
		// The created comment's id, for the status commenter (issue #644). A 2xx with no usable id is still a posted
		// comment, so it answers `{ id: null }` rather than throwing a retry that would post a second one.
		return { id: commentIdOf(data?.id) };
	}

	/**
	 * Replace the body of the status comment `id` this host posted (issue #644, status-comment.mjs). The id is the
	 * plain issue-comment id: one `PATCH /repos/{o}/{r}/issues/comments/{id}` serves issues and pull requests alike,
	 * so `target` is unread here for the reason `postStatusComment` gives. The id is checked against
	 * `STATUS_COMMENT_ID_RE` before it reaches a route. An HTTP failure throws octokit's own error, which carries
	 * `status`, so the caller can tell a 403/404/429 (stop editing) from a blip.
	 */
	async function editStatusComment(repo, target, id, text, token) {
		const [owner, name] = splitRepo(repo);
		if (!isStatusCommentId(id) || !/^[0-9]+$/.test(id)) {
			throw configError(`github-host: malformed status comment id: ${JSON.stringify(id)}`);
		}
		const octokit = octokitFor(token);
		await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
			owner,
			repo: name,
			comment_id: id,
			body: text,
		});
	}

	/**
	 * The head ref of a pull request, and the repository that ref lives in, from ONE fresh API call
	 * (REQ-RESUMABLE-SESSION, INT-SESSION-STORE-CONTRACT).
	 *
	 * Fresh rather than off the payload, for two reasons that are not the same. An `issue_comment` on a
	 * pull request -- which is how review feedback actually arrives -- carries no head at all, so the
	 * payload route simply cannot answer for the case this feature exists to serve. And
	 * `head.repo.full_name` in a webhook body is attacker-supplied: it decides the fork gate, so it must
	 * come from the forge rather than from the sender.
	 *
	 * Both fields are returned together deliberately. A caller that got the ref without the repo could
	 * key a session on a stranger's branch name; returning the pair makes the fork check available
	 * wherever the ref is.
	 */
	async function resolvePullRequestHead(job, token) {
		const [owner, name] = splitRepo(job);
		const octokit = octokitFor(token);
		const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
			owner,
			repo: name,
			pull_number: job?.target?.number,
		});
		return { headRef: data?.head?.ref, headRepo: data?.head?.repo?.full_name };
	}

	/**
	 * Add or remove the parked marker on an issue (issue #625, parked.mjs). GitHub creates a label the repository lacks
	 * when it is added, so there is nothing to create first. Removing a label the issue does not carry is a 404, which is
	 * the state asked for. The caller treats any throw as fail-open: the session store's sidecar, not this label, decides.
	 */
	async function setParkedLabel(repo, target, on, token, label = PARKED_LABEL) {
		const [owner, name] = splitRepo(repo);
		const octokit = octokitFor(token);
		if (on) {
			await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { owner, repo: name, issue_number: target?.number, labels: [label] });
			return;
		}
		try {
			await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", { owner, repo: name, issue_number: target?.number, name: label });
		} catch (error) {
			if (error?.status !== 404) throw error;
		}
	}

	return { resolveDefaultBranchSha, isDefaultBranchProtected, postStatusComment, editStatusComment, resolvePullRequestHead, setParkedLabel };
}

/** GitHub's largest page for the branch rules read, and how many pages are read before the answer is retried. */
const RULES_PER_PAGE = 100;
const RULES_PAGE_CAP = 10;

/**
 * Whether one rule from `GET .../rules/branches/{branch}` stops a self-merge: a `pull_request` rule that requires at
 * least one approving review (see `isDefaultBranchProtected` for why the approval and not the rule alone). A rule
 * whose count is missing or not an integer does not count.
 */
function requiresApprovedPullRequest(rule) {
	const count = rule?.parameters?.required_approving_review_count;
	return rule?.type === "pull_request" && Number.isInteger(count) && count >= 1;
}

/**
 * Split `"owner/name"` into `[owner, name]`, throwing configError unless both parts are non-empty.
 *
 * Accepts the job itself or a bare `"owner/name"`. Taking the job is what lets every forge's host expose
 * the same three signatures while reading whatever identifies a target on its own side -- GitLab's takes
 * the numeric project id off the same object, because its `group/subgroup/project` paths have no fixed
 * segment count and this split would pass on one while silently naming the parent group.
 */
function splitRepo(ref) {
	const repo = typeof ref === "object" && ref !== null ? ref.repo : ref;
	const segments = String(repo ?? "").split("/");
	const [owner, name] = segments;
	// EXACTLY two segments, not "at least two". The docstring above already describes what a longer path
	// does to this split, and until now the code did not guard it: "org/project/repo" yields owner="org",
	// name="project", both non-empty -- so it passes, and every call silently names a DIFFERENT repository
	// than the job asked for. Azure DevOps is org/project/repo and GitLab is group/subgroup/project, so the
	// wrong answer here is reachable by configuration, not only by a bug.
	if (segments.length !== 2 || !owner || !name) {
		throw configError(`github-host: malformed repo: ${JSON.stringify(repo)} (expected exactly "owner/name")`);
	}
	return [owner, name];
}
