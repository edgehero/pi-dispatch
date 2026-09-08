/**
 * Host-side GitLab reads and writes the worker performs AROUND a job -- the counterpart of
 * github-host.mjs, returning the identical three methods so the processor never learns which forge it is
 * talking to: resolve the default-branch tip, decide whether that branch is protected, and post an outcome
 * note back to the triggering issue or merge request.
 *
 * KEYED ON THE NUMERIC PROJECT ID, never on the path. A GitLab project is `group/subgroup/project` with no
 * fixed segment count, so github-host's `owner/name` split does not merely fail on one -- it SUCCEEDS
 * wrongly, since both halves come back non-empty and the project silently becomes its own parent group.
 * The id is in every webhook payload and rides the job, so the grammar never has to be parsed at all.
 *
 * REQ-BRANCH-PROTECTION-PRECONDITION / CONST-MERGE-NEVER-AUTOMATIC: `isDefaultBranchProtected` is the free
 * gate the processor consults before spending. GitHub can lean on a 404 from its protection endpoint as
 * the determinate "unprotected" state; GitLab has no such 404 to lean on, and issue #61 documents what
 * happens when that assumption is carried across a forge boundary -- every branch reports unprotected and
 * the never-merge backstop is silently disarmed. So this reads the protected-branches LIST, which answers
 * 200 with an array, and treats every non-200 as retryable. There is no code path that turns an error into
 * `false`.
 *
 * CONST-TOKEN-SCOPED-PER-JOB: the token is passed to every method and used for that request only; no
 * client is cached, so one job's credential never bleeds into another's request.
 *
 * `fetchFn` is injected so the module is testable offline. This module calls NO merge API of any kind.
 */

import { configError } from "./config.mjs";
import { InfraRetry } from "./processor.mjs";
import { fetchFailureReason } from "./gitlab-identity.mjs";
import { isDeterminateFetchFailure } from "./transient.mjs";

const API_PREFIX = "/api/v4";

/** Build the host surface. Returns `{ resolveDefaultBranchSha, isDefaultBranchProtected, postStatusComment }`. */
export function makeGitLabHost({ apiUrl = "https://gitlab.com", fetchFn = fetch } = {}) {
	const root = `${String(apiUrl).replace(/\/+$/, "")}${API_PREFIX}`;

	/** GET a JSON body, or throw InfraRetry. `notFound` maps a 404 to a value instead of an error. */
	async function get(path, token, { notFound } = {}) {
		let res;
		try {
			res = await fetchFn(`${root}${path}`, { headers: { "PRIVATE-TOKEN": token }, redirect: "error" });
		} catch (err) {
			// The one condition where the identity modules and this one now agree, because the issue's
			// acceptance asks for exactly that (#316): a TLS trust failure, a protocol mismatch and a URL
			// that always redirects are the operator's, and retrying them twice before failing tells
			// nobody anything. Everything else here stays unconditionally retryable, which is right for a
			// per-job call behind the queue: a wrong retry costs one more attempt, a wrong refusal costs
			// the delivery and posts publicly that the deployment is misconfigured.
			if (isDeterminateFetchFailure(err)) {
				throw configError(`gitlab-host: GET ${path} failed (${fetchFailureReason(err)})`);
			}
			throw new InfraRetry(`gitlab-host: GET ${path} failed (${fetchFailureReason(err)})`);
		}
		if (res.status === 404 && notFound !== undefined) return notFound;
		if (!res.ok) {
			// Status only, never the body: a GitLab error body can echo the request, and the request
			// carried the token.
			throw new InfraRetry(`gitlab-host: GET ${path} returned ${res.status}`);
		}
		try {
			return await res.json();
		} catch (err) {
			throw new InfraRetry(`gitlab-host: GET ${path} returned unparseable JSON (${err?.message ?? "unknown"})`);
		}
	}

	/**
	 * Resolve the default branch and its tip SHA with FRESH API calls only -- never a webhook field.
	 * Returns `{ branch, sha }`.
	 */
	async function resolveDefaultBranchSha(projectRef, token) {
		const id = projectId(projectRef);
		const project = await get(`/projects/${id}`, token);
		const branch = project?.default_branch;
		if (typeof branch !== "string" || branch === "") {
			// An empty repository has no default branch, and no commit to clone at. Determinate, not
			// transient -- but there is nothing this method can return that means "there is no tip", so it
			// is a config error rather than a silent undefined sha the fetch would fail on later.
			throw configError(`gitlab-host: project ${id} reports no default branch (an empty repository has no commit to clone)`);
		}
		const data = await get(`/projects/${id}/repository/branches/${encodeURIComponent(branch)}`, token);
		const sha = data?.commit?.id;
		if (typeof sha !== "string" || sha === "") {
			throw new InfraRetry(`gitlab-host: project ${id} branch ${branch} returned no commit id`);
		}
		return { branch, sha };
	}

	/**
	 * True when the default branch is covered by a protection rule, false when it provably is not.
	 *
	 * Reads the LIST rather than asking for one branch by name, for two reasons that both matter. GitLab
	 * protection entries may be WILDCARDS (`release/*`, `*`), so an exact-name lookup under-reports a
	 * branch that is protected by a pattern -- it would report unprotected and refuse a job that should
	 * have run. And a list answers 200 with `[]` for "nothing is protected", which is a determinate
	 * answer, where a 404 would be indistinguishable from a project that does not exist or a token that
	 * cannot see it.
	 *
	 * A non-200 is retryable, never `false`: collapsing an error to unprotected would silently bypass the
	 * never-merge backstop.
	 */
	async function isDefaultBranchProtected(projectRef, token) {
		const id = projectId(projectRef);
		const project = await get(`/projects/${id}`, token);
		const branch = project?.default_branch;
		if (typeof branch !== "string" || branch === "") return false;
		const rules = await get(`/projects/${id}/protected_branches`, token);
		if (!Array.isArray(rules)) {
			throw new InfraRetry(`gitlab-host: project ${id} protected_branches returned a non-array`);
		}
		return rules.some((rule) => matchesBranch(rule?.name, branch));
	}

	/**
	 * Post `text` as a note on `target`. Content-agnostic: `text` is passed through as `body` verbatim,
	 * never inspected, filtered, or logged.
	 *
	 * `target.type` IS read here, unlike on GitHub: issues and merge requests are separate endpoints and
	 * separate number sequences, so posting an MR's iid to the issues path comments on a different object
	 * -- or on nothing -- without erroring.
	 */
	async function postStatusComment(projectRef, target, text, token) {
		const id = projectId(projectRef);
		const collection = target?.type === "pull_request" ? "merge_requests" : "issues";
		const path = `/projects/${id}/${collection}/${target?.number}/notes`;
		let res;
		try {
			res = await fetchFn(`${root}${path}`, {
				method: "POST",
				headers: { "PRIVATE-TOKEN": token, "content-type": "application/json" },
				body: JSON.stringify({ body: text }),
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
				throw configError(`gitlab-host: POST ${path} failed (${fetchFailureReason(err)})`);
			}
			throw new InfraRetry(`gitlab-host: POST ${path} failed (${fetchFailureReason(err)})`);
		}
		if (!res.ok) {
			throw new InfraRetry(`gitlab-host: POST ${path} returned ${res.status}`);
		}
	}

	/**
	 * The source branch of a merge request, and whether it lives in this project (REQ-RESUMABLE-SESSION).
	 *
	 * GitLab's own fork test is project-id equality -- `source_project_id` vs `target_project_id` -- which
	 * is stronger than comparing paths, since a path can be renamed and an id cannot. So the fork gate is
	 * answered here, in the forge's own terms, and reported back as the base repo's name when the source
	 * IS this project. That keeps session-key.mjs forge-blind: it compares two strings and never has to
	 * learn what a project id means.
	 */
	async function resolvePullRequestHead(job, token) {
		const id = projectId(job);
		const mr = await get(`/projects/${id}/merge_requests/${encodeURIComponent(job?.target?.number)}`, token);
		const sameProject = mr?.source_project_id != null && mr.source_project_id === mr.target_project_id;
		return { headRef: mr?.source_branch, headRepo: sameProject ? job?.repo : null };
	}

	return { resolveDefaultBranchSha, isDefaultBranchProtected, postStatusComment, resolvePullRequestHead };
}

/**
 * A GitLab protection rule name matched against a branch. `*` is GitLab's only wildcard and matches any
 * run of characters, `/` included -- so `release/*` covers `release/1.2/hotfix`.
 *
 * Every other regex metacharacter in the rule is escaped first. A branch protection rule is operator
 * config, but treating it as a pattern would let a stray `.` or `+` silently widen or narrow which
 * branches count as protected, and this answer gates whether a job is allowed to spend.
 */
export function matchesBranch(rule, branch) {
	if (typeof rule !== "string" || rule === "") return false;
	if (rule === branch) return true;
	if (!rule.includes("*")) return false;
	const pattern = rule
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${pattern}$`).test(branch);
}

/**
 * The numeric project id a job carries. Accepts the id itself or a job-shaped `{ projectId }`; refuses
 * anything else rather than falling back to a path, because a path would have to be URL-encoded and a
 * wrong encoding is a request against a different project.
 */
function projectId(ref) {
	const id = typeof ref === "object" && ref !== null ? ref.projectId : ref;
	if (!Number.isInteger(id)) {
		throw configError(`gitlab-host: expected a numeric project id, got ${JSON.stringify(ref)}`);
	}
	return id;
}

/**
 * The TOKENLESS HTTPS clone URL for a GitLab project: `<instance>/<group>/<sub>/<project>.git`.
 *
 * The path is used whole and never split -- unlike an API call, a clone URL wants exactly the nested path
 * GitLab reports, and reassembling it from parts is how a subgroup gets dropped.
 *
 * No credential appears here, by construction. The token reaches git only through the GIT_ASKPASS helper
 * (prepare-github.mjs), so it never enters argv, `.git/config`, or a remote URL an agent could read back
 * out of the workspace it is standing in.
 */
export function gitlabRemoteUrl(apiUrl, repo) {
	const root = String(apiUrl ?? "https://gitlab.com").replace(/\/+$/, "");
	const path = String(repo ?? "").replace(/^\/+/, "");
	if (path === "") {
		throw configError("gitlab-host: cannot build a clone URL for a job with no project path");
	}
	return `${root}/${path}.git`;
}
