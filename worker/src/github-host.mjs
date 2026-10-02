/**
 * Host-side GitHub reads and writes the worker performs AROUND a job, distinct from anything the
 * agent does inside its container: resolve the default-branch tip, decide whether that branch is
 * protected, and post an outcome comment back to the triggering issue.
 *
 * REQ-BRANCH-PROTECTION-PRECONDITION / CONST-MERGE-NEVER-AUTOMATIC: `isDefaultBranchProtected` is
 * the free gate the processor consults before spending. The agent's scoped token carries
 * contents:write, which covers push AND merge, so branch protection is the only technical barrier
 * to a self-merge. A transient read failure must therefore NOT collapse to "unprotected" and let
 * the job run: only a real 404 (the repo has no protection object) is the determinate unprotected
 * state that drives the policy refusal; any other error is retryable and never a silent `false`.
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
import { configError } from "./config.mjs";
import { octokitLogOptions } from "./octokit-log.mjs";
import { InfraRetry } from "./processor.mjs";

/**
 * Build the host surface. `octokitFor` is `(token) => new Octokit({ auth: token, ...octokitLogOptions(log) })`; inject a fake
 * to test offline. `log` is the caller's `(event, fields)` logger for the client's own warnings
 * (`octokitLog`, issue #530). Returns `{ resolveDefaultBranchSha, isDefaultBranchProtected, postStatusComment }`.
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
	 * True when the default branch has a protection object, false when it provably does not (404).
	 * A non-404 error is retryable, NOT `false`: a transient blip must not read as "unprotected" and
	 * bypass the never-merge backstop.
	 */
	async function isDefaultBranchProtected(repo, token) {
		const [owner, name] = splitRepo(repo);
		const octokit = octokitFor(token);
		const { data: repoData } = await octokit.request("GET /repos/{owner}/{repo}", {
			owner,
			repo: name,
		});
		const branch = repoData.default_branch;
		try {
			await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}/protection", {
				owner,
				repo: name,
				branch,
			});
			return true;
		} catch (error) {
			// A missing protection object is a real, determinate state -- the repo is unprotected.
			if (error?.status === 404) return false;
			// Any other status is retryable rather than resolved. A 403 (the token lacks the scope to
			// read protection) is treated as InfraRetry here too: acceptable for v1, though it could be
			// a permanent config error. Collapsing non-404 to false would silently bypass never-merge.
			throw new InfraRetry(
				`github-host: branch-protection read failed for ${owner}/${name} (status ${error?.status ?? "unknown"})`,
			);
		}
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
		await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
			owner,
			repo: name,
			issue_number: target?.number,
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

	return { resolveDefaultBranchSha, isDefaultBranchProtected, postStatusComment, resolvePullRequestHead };
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
