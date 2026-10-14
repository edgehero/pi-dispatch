/**
 * The Forgejo/Gitea half of the per-job forge dependency (`DES-FORGE-IS-A-PER-JOB-DEPENDENCY`): the same
 * four methods `makeGitHubHost` and `makeGitLabHost` expose, against Forgejo's `/api/v1`.
 *
 * BRANCH PROTECTION IS THE REASON TO READ THIS FILE. `github-host.mjs` treats a 404 from
 * `/repos/{o}/{r}/branches/{b}/protection` as "not protected", which is correct on GitHub, where that
 * endpoint exists and 404 means "no protection on this branch". Forgejo has no such endpoint at all -- it
 * uses `/branch_protections`, a different path with a different shape -- so carrying GitHub's assumption
 * across would make EVERY branch report unprotected and silently disarm the backstop that stops the agent
 * pushing to a protected branch. Issue #61 records this, and `REQ-BRANCH-PROTECTION-PRECONDITION` already
 * cites it by number as the failure that ordering exists to avoid.
 *
 * And the fix is not simply "call the other endpoint". Forgejo's rules are GLOB patterns: a rule named
 * `release/*` protects `release/1.0` while `GET /branch_protections/release/1.0` returns 404. So this
 * LISTS the rules and matches each pattern against the branch, exactly as the GitLab host does -- and it
 * reuses that host's `matchesBranch` rather than writing a second globber, because two implementations of
 * "which branches does this rule cover" is two chances to widen it.
 *
 * A non-2xx is retryable, never `false`. Collapsing an error into "unprotected" is the same fail-open in a
 * different costume.
 */

import { configError } from "./config.mjs";
import { PARKED_LABEL } from "./parked.mjs";
import { InfraRetry } from "./processor.mjs";
import { fetchFailureReason } from "./gitlab-identity.mjs";
import { matchesBranch } from "./gitlab-host.mjs";
import { isDeterminateFetchFailure } from "./transient.mjs";

const API_PREFIX = "/api/v1";

/** How many pages of repository labels the parked marker's lookup reads before it gives up (50 a page at most). */
const MAX_LABEL_PAGES = 20;

/** Build the host surface. Returns the same four methods every forge host exposes. */
export function makeForgejoHost({ apiUrl, fetchFn = fetch } = {}) {
	const root = `${String(apiUrl ?? "").replace(/\/+$/, "")}${API_PREFIX}`;

	/** GET a JSON body, or throw InfraRetry. `notFound` maps a 404 to a value instead of an error. */
	async function get(path, token, { notFound } = {}) {
		let res;
		try {
			res = await fetchFn(`${root}${path}`, { headers: { Authorization: `token ${token}` }, redirect: "error" });
		} catch (err) {
			// The one condition where the identity modules and this one now agree, because the issue's
			// acceptance asks for exactly that (#316): a TLS trust failure, a protocol mismatch and a URL
			// that always redirects are the operator's, and retrying them twice before failing tells
			// nobody anything. Everything else here stays unconditionally retryable, which is right for a
			// per-job call behind the queue: a wrong retry costs one more attempt, a wrong refusal costs
			// the delivery and posts publicly that the deployment is misconfigured.
			if (isDeterminateFetchFailure(err)) {
				throw configError(`forgejo-host: GET ${path} failed (${fetchFailureReason(err)})`);
			}
			throw new InfraRetry(`forgejo-host: GET ${path} failed (${fetchFailureReason(err)})`);
		}
		if (res.status === 404 && notFound !== undefined) return notFound;
		if (!res.ok) {
			// Status only, never the body: a Forgejo error body can echo the request, and the request
			// carried the token.
			throw new InfraRetry(`forgejo-host: GET ${path} returned ${res.status}`);
		}
		try {
			return await res.json();
		} catch (err) {
			throw new InfraRetry(`forgejo-host: GET ${path} returned unparseable JSON (${err?.message ?? "unknown"})`);
		}
	}

	/**
	 * Resolve the default branch and its tip SHA with FRESH API calls only -- never a webhook field.
	 * Returns `{ branch, sha }`.
	 */
	async function resolveDefaultBranchSha(ref, token) {
		const [owner, name] = splitRepo(ref);
		const repo = await get(`/repos/${owner}/${name}`, token);
		const branch = repo?.default_branch;
		if (typeof branch !== "string" || branch === "") {
			throw new InfraRetry(`forgejo-host: ${owner}/${name} reported no default_branch`);
		}
		const info = await get(`/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}`, token);
		// Gitea's Branch carries its tip as `commit.id`; some versions and forks also expose `commit.sha`.
		// Both are read, and neither being a string is a hard failure rather than an undefined SHA -- a job
		// that cannot name the commit it is standing on must not proceed to clone something else.
		const sha = info?.commit?.id ?? info?.commit?.sha;
		if (typeof sha !== "string" || sha === "") {
			throw new InfraRetry(`forgejo-host: branch ${branch} reported no commit id`);
		}
		return { branch, sha };
	}

	/**
	 * Whether the default branch is covered by any protection rule.
	 *
	 * See the module header: this is the endpoint and the glob matching that GitHub's 404 rule would have
	 * got wrong in two independent ways.
	 */
	async function isDefaultBranchProtected(ref, token) {
		const [owner, name] = splitRepo(ref);
		const repo = await get(`/repos/${owner}/${name}`, token);
		const branch = repo?.default_branch;
		if (typeof branch !== "string" || branch === "") return false;
		const rules = await get(`/repos/${owner}/${name}/branch_protections`, token);
		if (!Array.isArray(rules)) {
			throw new InfraRetry(`forgejo-host: ${owner}/${name} branch_protections returned a non-array`);
		}
		// `rule_name` is the current field; `branch_name` is its deprecated predecessor and is still what
		// older instances send. Reading only the new one would report every branch on an older Forgejo as
		// unprotected -- the same class of silent fail-open this file exists to avoid.
		return rules.some((rule) => matchesBranch(rule?.rule_name ?? rule?.branch_name, branch));
	}

	/**
	 * Post `text` as a comment on `target`. Content-agnostic: passed through verbatim, never inspected,
	 * filtered, or logged.
	 *
	 * `target.type` is NOT read here, unlike on GitLab. Forgejo follows GitHub: a pull request IS an issue
	 * with the same index, so one endpoint serves both and there is no way to comment on the wrong object.
	 */
	async function postStatusComment(ref, target, text, token) {
		const [owner, name] = splitRepo(ref);
		const path = `/repos/${owner}/${name}/issues/${encodeURIComponent(target?.number)}/comments`;
		let res;
		try {
			res = await fetchFn(`${root}${path}`, {
				method: "POST",
				headers: { Authorization: `token ${token}`, "content-type": "application/json" },
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
				throw configError(`forgejo-host: POST ${path} failed (${fetchFailureReason(err)})`);
			}
			throw new InfraRetry(`forgejo-host: POST ${path} failed (${fetchFailureReason(err)})`);
		}
		if (!res.ok) {
			throw new InfraRetry(`forgejo-host: POST ${path} returned ${res.status}`);
		}
	}

	/**
	 * The head branch of a pull request, and whether it lives in this repository (REQ-RESUMABLE-SESSION).
	 *
	 * The fork gate is answered HERE, in the forge's own terms, and reported back as a repo name -- which
	 * is what keeps `session-key.mjs` forge-blind: it compares two strings and never learns what a fork
	 * means on any particular forge.
	 */
	async function resolvePullRequestHead(job, token) {
		const [owner, name] = splitRepo(job);
		const pr = await get(`/repos/${owner}/${name}/pulls/${encodeURIComponent(job?.target?.number)}`, token);
		return { headRef: pr?.head?.ref, headRepo: pr?.head?.repo?.full_name };
	}

	/**
	 * Add or remove the parked marker on an issue (issue #625, parked.mjs). The caller treats any throw as fail-open: the
	 * session store's sidecar, not this label, decides whether a reply resumes anything.
	 *
	 * BY ID, AFTER A LOOKUP, because Forgejo does not refuse a duplicate label name. Measured on 14.0.5: a second
	 * `POST /repos/{o}/{r}/labels {"name":"pi-awaiting-input",...}` answers 201 and creates ANOTHER repository label of
	 * that name (the repository's labels became ai #1, pi-awaiting-input #2, pi-awaiting-input #3 after the second park);
	 * adding by name then attaches EVERY label of that name (the issue carried #2 and #3, two adds in its timeline); and
	 * removing by name took off only ONE (204, #3 stayed). So the marker outlived the resumed run for good, each park added
	 * a repository label, and every later plain reply was routed, to end as `not-parked`. The 409/422 this used to accept
	 * on the create never happens on Forgejo 14.
	 *
	 * Adding: list the repository's labels, create one only when none has the exact name, and attach the LOWEST id, so a
	 * repository that already holds duplicates stops growing them and the issue gets one marker. Removing: read the
	 * labels the issue actually carries and remove every one of that name by id, so an issue that holds two from before
	 * this fix is cleared too. The duplicate repository labels themselves are left alone: deleting a repository's labels
	 * is the operator's call, and a spare one carried by no issue routes nothing (docs/forgejo.md says how to tidy them).
	 */
	async function setParkedLabel(ref, target, on, token) {
		const [owner, name] = splitRepo(ref);
		const send = async (method, path, body, accept = []) => {
			let res;
			try {
				res = await fetchFn(`${root}${path}`, {
					method,
					headers: { Authorization: `token ${token}`, "content-type": "application/json" },
					...(body !== undefined && { body: JSON.stringify(body) }),
					redirect: "error",
				});
			} catch (err) {
				throw new InfraRetry(`forgejo-host: ${method} ${path} failed (${fetchFailureReason(err)})`);
			}
			if (!res.ok && !accept.includes(res.status)) throw new InfraRetry(`forgejo-host: ${method} ${path} returned ${res.status}`);
			return res;
		};
		const issue = `/repos/${owner}/${name}/issues/${encodeURIComponent(target?.number)}/labels`;
		const markers = (labels) => (Array.isArray(labels) ? labels : []).filter((l) => l?.name === PARKED_LABEL && Number.isSafeInteger(l?.id)).map((l) => l.id);
		if (on) {
			let ids = await repoLabelIds(owner, name, token, markers);
			if (ids.length === 0) {
				const res = await send("POST", `/repos/${owner}/${name}/labels`, { name: PARKED_LABEL, color: "#fbca04", description: "pi-dispatch: the last run is waiting for an answer" }, [409, 422]);
				// A forge that DOES refuse the duplicate (409/422, a Gitea or a later Forgejo) raced another park to it: list
				// again. A 201 hands back the label, so no second read is needed.
				const created = res.ok ? await res.json().catch(() => null) : null;
				ids = Number.isSafeInteger(created?.id) ? [created.id] : await repoLabelIds(owner, name, token, markers);
			}
			if (ids.length === 0) throw new InfraRetry(`forgejo-host: ${owner}/${name} has no ${PARKED_LABEL} label after creating it`);
			await send("POST", issue, { labels: [Math.min(...ids)] });
			return;
		}
		// Already gone is success: 404 (no such issue) and, on the removal, 422 -- Forgejo's answer when no such label
		// exists (measured on 14.0.5: {"message":"label does not exist [label_id: 0, repo_id: 1]"}). Matched on the status
		// alone: in 14.0.5's DeleteIssueLabel the only 422 is "label does not exist", the binding's own 422 needs a request
		// body and none is sent, and the message is free to change between versions. A stray 422 read as gone would leave
		// a stale marker, which decides nothing.
		const carried = markers(await get(issue, token, { notFound: [] }));
		for (const id of carried) await send("DELETE", `${issue}/${id}`, undefined, [404, 422]);
	}

	/**
	 * The ids of every repository label named `PARKED_LABEL`, in id order. Paged until an EMPTY page rather than until a
	 * short one, because the instance caps the page size (`MAX_RESPONSE_ITEMS`) below what was asked for, and a short page
	 * is then every page. Bounded, so a server that never returns an empty page cannot hold a job's teardown.
	 */
	async function repoLabelIds(owner, name, token, markers) {
		const ids = [];
		for (let page = 1; page <= MAX_LABEL_PAGES; page++) {
			const labels = await get(`/repos/${owner}/${name}/labels?page=${page}&limit=50`, token);
			if (!Array.isArray(labels) || labels.length === 0) return ids.sort((a, b) => a - b);
			ids.push(...markers(labels));
		}
		throw new InfraRetry(`forgejo-host: ${owner}/${name} lists more than ${MAX_LABEL_PAGES} pages of labels`);
	}

	return { resolveDefaultBranchSha, isDefaultBranchProtected, postStatusComment, resolvePullRequestHead, setParkedLabel };
}

/**
 * The `owner/name` a job names. EXACTLY two non-empty segments, for the reason `github-host.mjs` now also
 * enforces: a longer path destructures to its first two segments with both non-empty, so it would pass a
 * looser check and address a different repository.
 */
function splitRepo(ref) {
	const repo = typeof ref === "object" && ref !== null ? ref.repo : ref;
	const segments = String(repo ?? "").split("/");
	const [owner, name] = segments;
	if (segments.length !== 2 || !owner || !name) {
		throw configError(`forgejo-host: malformed repo: ${JSON.stringify(repo)} (expected exactly "owner/name")`);
	}
	return [encodeURIComponent(owner), encodeURIComponent(name)];
}

/**
 * The TOKENLESS HTTPS clone URL for a Forgejo repository: `<instance>/<owner>/<name>.git`.
 *
 * No credential appears here, by construction. The token reaches git only through the GIT_ASKPASS helper
 * (prepare-github.mjs), so it never enters argv, `.git/config`, or a remote URL an agent could read back
 * out of the workspace it is standing in.
 */
export function forgejoRemoteUrl(apiUrl, repo) {
	const root = String(apiUrl ?? "").replace(/\/+$/, "");
	if (root === "") {
		throw configError("forgejo-host: cannot build a clone URL without FORGEJO_URL");
	}
	const path = String(repo ?? "").replace(/^\/+/, "");
	if (path === "") {
		throw configError("forgejo-host: cannot build a clone URL for a job with no repository");
	}
	return `${root}/${path}.git`;
}
