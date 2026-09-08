/**
 * The Azure DevOps half of the per-job forge dependency: the same four methods every host exposes, against
 * `dev.azure.com/{org}/{project}/_apis`.
 *
 * BRANCH PROTECTION IS THE HARD PART, and it is hard in a way neither other forge prepared us for. Azure
 * has no "protected" flag. It has POLICIES, and "is this branch protected" is a question you answer by
 * evaluating a list:
 *
 *   - a policy counts only when `isEnabled` AND `isBlocking`. A policy that is enabled but advisory does
 *     not stop a push, so reading `isEnabled` alone would report a branch protected that is not;
 *   - each policy carries a `settings.scope[]` of `{ refName, matchKind, repositoryId }`, and `matchKind`
 *     is `Exact` or `Prefix`. A Prefix policy on `refs/heads/releases/` protects `refs/heads/releases/1.0`
 *     WITHOUT naming it -- so comparing refName for equality reports that branch unprotected, which is the
 *     same class of fail-open as carrying GitHub's 404 rule to Forgejo, arrived at from a different
 *     direction;
 *   - a scope entry with `repositoryId: null` applies to EVERY repository in the project, which is how most
 *     organisations write a default-branch policy. Requiring a repository match would miss all of them.
 *
 * A non-2xx is retryable, never `false`. And note the token dependency: this endpoint needs `vso.code` to
 * read. A token that cannot read policies returns 401/403, which must NOT collapse into "unprotected" --
 * that would turn a permissions mistake into a silently disarmed backstop.
 */

import { configError } from "./config.mjs";
import { InfraRetry } from "./processor.mjs";
import { fetchFailureReason } from "./gitlab-identity.mjs";
import { isDeterminateFetchFailure } from "./transient.mjs";

const API_VERSION = "7.1";

/** Build the host surface. `orgUrl` is `https://dev.azure.com/<org>`. */
export function makeAzureHost({ orgUrl, fetchFn = fetch } = {}) {
	const root = String(orgUrl ?? "").replace(/\/+$/, "");

	function authHeader(token) {
		// Azure authenticates a PAT as HTTP Basic with an empty username.
		return `Basic ${Buffer.from(`:${token}`, "utf8").toString("base64")}`;
	}

	async function get(path, token) {
		const url = `${root}${path}`;
		let res;
		try {
			res = await fetchFn(url, { headers: { Authorization: authHeader(token), accept: "application/json" }, redirect: "error" });
		} catch (err) {
			// The one condition where the identity modules and this one now agree, because the issue's
			// acceptance asks for exactly that (#316): a TLS trust failure, a protocol mismatch and a URL
			// that always redirects are the operator's, and retrying them twice before failing tells
			// nobody anything. Everything else here stays unconditionally retryable, which is right for a
			// per-job call behind the queue: a wrong retry costs one more attempt, a wrong refusal costs
			// the delivery and posts publicly that the deployment is misconfigured.
			if (isDeterminateFetchFailure(err)) {
				throw configError(`azure-host: GET ${path} failed (${fetchFailureReason(err)})`);
			}
			throw new InfraRetry(`azure-host: GET ${path} failed (${fetchFailureReason(err)})`);
		}
		if (!res.ok) {
			// Status only, never the body: an Azure error body can echo the request, and the request carried
			// the token.
			throw new InfraRetry(`azure-host: GET ${path} returned ${res.status}`);
		}
		try {
			return await res.json();
		} catch (err) {
			throw new InfraRetry(`azure-host: GET ${path} returned unparseable JSON (${err?.message ?? "unknown"})`);
		}
	}

	/** The `{ project, repository, repositoryId }` a job names, refusing rather than guessing. */
	function scopeOf(ref) {
		const azure = typeof ref === "object" && ref !== null ? ref.azure : null;
		const project = azure?.project;
		const repository = azure?.repository;
		if (typeof project !== "string" || project === "" || typeof repository !== "string" || repository === "") {
			throw configError(`azure-host: job carries no azure project/repository scope: ${JSON.stringify(ref?.repo ?? ref)}`);
		}
		return { project, repository, repositoryId: azure?.repositoryId ?? null };
	}

	/** The repository record, by id when the delivery carried one and by name when it did not. */
	async function repoOf(ref, token) {
		const { project, repository, repositoryId } = scopeOf(ref);
		const key = repositoryId ?? repository;
		return await get(`/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(key)}?api-version=${API_VERSION}`, token);
	}

	/**
	 * Resolve the default branch and its tip SHA with FRESH API calls only -- never a webhook field.
	 * Azure reports the default branch fully qualified (`refs/heads/main`); the rest of this codebase does
	 * not, so it is stripped here and re-qualified where the API needs it.
	 */
	async function resolveDefaultBranchSha(ref, token) {
		const { project } = scopeOf(ref);
		const repo = await repoOf(ref, token);
		const branch = stripRefsHeads(repo?.defaultBranch);
		if (typeof branch !== "string" || branch === "") {
			throw new InfraRetry("azure-host: repository reported no defaultBranch");
		}
		const id = repo?.id;
		if (typeof id !== "string" || id === "") {
			throw new InfraRetry("azure-host: repository reported no id");
		}
		const stats = await get(
			`/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(id)}/stats/branches?name=${encodeURIComponent(branch)}&api-version=${API_VERSION}`,
			token,
		);
		const sha = stats?.commit?.commitId;
		if (typeof sha !== "string" || sha === "") {
			throw new InfraRetry(`azure-host: branch ${branch} reported no commit id`);
		}
		return { branch, sha };
	}

	/** Whether any enabled, BLOCKING policy covers the default branch. See the module header. */
	async function isDefaultBranchProtected(ref, token) {
		const { project } = scopeOf(ref);
		const repo = await repoOf(ref, token);
		const branch = stripRefsHeads(repo?.defaultBranch);
		if (typeof branch !== "string" || branch === "") return false;
		const repositoryId = repo?.id ?? null;
		// The `git` variant, not `/_apis/policy/configurations`: Microsoft's own reference says the plain
		// one's `scope` parameter is legacy and "does not support hierarchical nesting", which is exactly the
		// nesting a Prefix rule relies on.
		const body = await get(
			`/${encodeURIComponent(project)}/_apis/git/policy/configurations?repositoryId=${encodeURIComponent(repositoryId ?? "")}&refName=${encodeURIComponent(qualify(branch))}&api-version=${API_VERSION}`,
			token,
		);
		const policies = body?.value;
		if (!Array.isArray(policies)) {
			throw new InfraRetry("azure-host: policy configurations returned no array");
		}
		return policies.some((p) => policyProtects(p, branch, repositoryId));
	}

	/**
	 * Post `text` as a comment on `target`. Content-agnostic: passed through verbatim.
	 *
	 * The two target types use DIFFERENT APIs and different body shapes, and neither resembles the other
	 * three forges' single `POST .../comments`:
	 *   - a pull request comment is a THREAD (`POST .../pullRequests/{id}/threads`), because Azure has no
	 *     bare comment on a pull request -- every comment lives in one;
	 *   - a work item comment is `POST .../wit/workItems/{id}/comments`, on a PREVIEW api-version. That is
	 *     pinned deliberately: a preview API can change, and discovering it changed through a broken status
	 *     comment beats discovering it through a silently unpinned one.
	 */
	async function postStatusComment(ref, target, text, token) {
		const { project } = scopeOf(ref);
		const isPr = target?.type === "pull_request";
		let path;
		let body;
		if (isPr) {
			const repo = await repoOf(ref, token);
			path = `/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo?.id)}/pullRequests/${encodeURIComponent(target?.number)}/threads?api-version=${API_VERSION}`;
			// commentType 1 is "text"; status 1 is "active". A thread carrying one comment is Azure's
			// equivalent of the single comment every other forge posts.
			body = { comments: [{ parentCommentId: 0, content: text, commentType: 1 }], status: 1 };
		} else {
			path = `/${encodeURIComponent(project)}/_apis/wit/workItems/${encodeURIComponent(target?.number)}/comments?api-version=7.1-preview.4`;
			body = { text };
		}
		let res;
		try {
			res = await fetchFn(`${root}${path}`, {
				method: "POST",
				headers: { Authorization: authHeader(token), "content-type": "application/json" },
				body: JSON.stringify(body),
				redirect: "error",
			});
		} catch (err) {
			// The one condition where the identity modules and this one now agree, because the issue's
			// acceptance asks for exactly that (#316): a TLS trust failure, a protocol mismatch and a URL
			// that always redirects are the operator's, and retrying them twice before failing tells
			// nobody anything. Everything else here stays unconditionally retryable, which is right for a
			// per-job call behind the queue: a wrong retry costs one more attempt, a wrong refusal costs
			// the delivery and posts publicly that the deployment is misconfigured.
			if (isDeterminateFetchFailure(err)) {
				throw configError(`azure-host: POST ${path} failed (${fetchFailureReason(err)})`);
			}
			throw new InfraRetry(`azure-host: POST ${path} failed (${fetchFailureReason(err)})`);
		}
		if (!res.ok) {
			throw new InfraRetry(`azure-host: POST ${path} returned ${res.status}`);
		}
	}

	/**
	 * The source branch of a pull request, and whether it lives in this repository.
	 *
	 * Azure's fork test is repository-ID equality -- `forkSource` is present only on a fork, and the PR's
	 * own `repository.id` names where the source branch lives. The gate is answered HERE, in the forge's own
	 * terms, and reported back as the job's own repo label so `session-key.mjs` stays forge-blind.
	 */
	async function resolvePullRequestHead(job, token) {
		const { project } = scopeOf(job);
		const repo = await repoOf(job, token);
		const pr = await get(
			`/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo?.id)}/pullrequests/${encodeURIComponent(job?.target?.number)}?api-version=${API_VERSION}`,
			token,
		);
		const sameRepo = pr?.forkSource == null && (pr?.repository?.id == null || pr.repository.id === repo?.id);
		return { headRef: stripRefsHeads(pr?.sourceRefName), headRepo: sameRepo ? job?.repo : null };
	}

	return { resolveDefaultBranchSha, isDefaultBranchProtected, postStatusComment, resolvePullRequestHead };
}

/**
 * Whether one policy configuration protects `branch`.
 *
 * Every clause here is load-bearing; see the module header for what each one being wrong would cost.
 */
export function policyProtects(policy, branch, repositoryId) {
	if (policy?.isEnabled !== true || policy?.isBlocking !== true) return false;
	const scopes = policy?.settings?.scope;
	if (!Array.isArray(scopes)) return false;
	const target = qualify(branch);
	return scopes.some((scope) => {
		// `repositoryId: null` means "every repository in the project" -- how most default-branch policies
		// are written. Requiring a match would miss all of them.
		if (scope?.repositoryId != null && repositoryId != null && scope.repositoryId !== repositoryId) return false;
		const refName = scope?.refName;
		if (typeof refName !== "string" || refName === "") return false;
		const kind = String(scope?.matchKind ?? "Exact").toLowerCase();
		if (kind === "prefix") return target.startsWith(refName);
		return target === refName;
	});
}

/** `main` -> `refs/heads/main`, idempotently. Azure's policy scopes are always fully qualified. */
function qualify(branch) {
	return String(branch).startsWith("refs/") ? String(branch) : `refs/heads/${branch}`;
}

/** `refs/heads/main` -> `main`. Azure qualifies its refs; the rest of this codebase does not. */
export function stripRefsHeads(ref) {
	return typeof ref === "string" ? ref.replace(/^refs\/heads\//, "") : undefined;
}

/**
 * The TOKENLESS HTTPS clone URL for an Azure repository: `<org>/<project>/_git/<repo>`.
 *
 * No credential appears here, by construction. The token reaches git only through the GIT_ASKPASS helper.
 */
export function azureRemoteUrl(orgUrl, job) {
	const root = String(orgUrl ?? "").replace(/\/+$/, "");
	if (root === "") {
		throw configError("azure-host: cannot build a clone URL without AZURE_ORG_URL");
	}
	const project = job?.azure?.project;
	const repository = job?.azure?.repository;
	if (typeof project !== "string" || project === "" || typeof repository !== "string" || repository === "") {
		throw configError(`azure-host: cannot build a clone URL for a job with no azure scope: ${JSON.stringify(job?.repo)}`);
	}
	return `${root}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}`;
}
