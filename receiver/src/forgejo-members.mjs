/**
 * Resolve a Forgejo actor's repository permission -- the enforcement half of `CONST-TRIGGER-AUTHOR-GATE`
 * on the Forgejo side.
 *
 * Forgejo has no `author_association`; the concept is GitHub's. What it has instead is
 * `GET /repos/{owner}/{repo}/collaborators/{collaborator}/permission`, which answers
 * `{ permission: "admin"|"write"|"read"|"none" }`. `admin` and `write` are the honest analogue of
 * `OWNER|MEMBER|COLLABORATOR`: they are exactly the levels that can push a branch, which is the property
 * the constitution actually requires.
 *
 * The shape of this module is the GitLab resolver's, for the same three reasons, and they are worth
 * restating rather than cross-referencing:
 *   - it runs in the RECEIVER, between verification and the gate, so `filterForgejo` stays pure, total and
 *     offline-testable -- a fetch inside the gate would make the security-critical decision untestable
 *     without a server;
 *   - it runs AFTER verification, so an unauthenticated flood cannot make this project call Forgejo;
 *   - it returns a two-armed verdict, because "not a collaborator" and "could not tell" are different
 *     answers. A 404 is determinate and refuses; anything else is INDETERMINATE and the receiver answers
 *     503, so Forgejo redelivers and the stable `X-GitHub-Delivery` GUID dedups the retry. Collapsing
 *     indeterminate to "deny" would drop real work during an outage behind a 204 that looks exactly like a
 *     stranger being correctly refused.
 *
 * The username is required (Forgejo's endpoint takes no numeric id) and is never logged or returned.
 */

import { fetchFailureReason } from "@edgehero/pi-dispatch/gitlab-identity";

/** Forgejo/Gitea's API path prefix. `apiUrl` is the instance root, e.g. `https://codeberg.org`. */
const API_PREFIX = "/api/v1";

/**
 * The permission levels that can push to the repository. `read` and `none` cannot, so a job started on
 * their say-so would be doing work the actor could not do themselves -- the line CONST-TRIGGER-AUTHOR-GATE
 * draws.
 */
const WRITE_PERMISSIONS = new Set(["admin", "write"]);

/**
 * Build the resolver. `token` is the same operator-supplied access token the worker uses; `fetchFn` is
 * injected so the whole module is testable offline.
 *
 * Returns `resolveAuthority(repoFullName, login)` -> `{ authorized: boolean }` | `{ indeterminate: string }`
 * -- the same shape every forge's resolver returns.
 */
export function makeResolveForgejoAuthority({ apiUrl, token, fetchFn = fetch }) {
	return async function resolveAuthority(repoFullName, login) {
		// Both halves have to be present AND well-formed before they become path segments. A slash or a `..`
		// in either would reach a different endpoint than the one this function believes it is asking, and
		// the answer would be attributed to the wrong repository or the wrong person.
		const repo = typeof repoFullName === "string" ? repoFullName.split("/") : [];
		if (repo.length !== 2 || !repo[0] || !repo[1] || typeof login !== "string" || login === "" || /[/?#]/.test(login)) {
			// Not a lookup failure -- the payload never named a repository and an actor we could ask about.
			// Determinate, and refused.
			return { authorized: false };
		}
		const root = String(apiUrl).replace(/\/+$/, "") + API_PREFIX;
		const url = `${root}/repos/${encodeURIComponent(repo[0])}/${encodeURIComponent(repo[1])}/collaborators/${encodeURIComponent(login)}/permission`;
		let res;
		try {
			// `redirect: "error"` so an instance that 30x-es this path cannot silently send the token
			// somewhere else -- the same rule the GitLab host applies.
			res = await fetchFn(url, { headers: { Authorization: `token ${token}` }, redirect: "error" });
		} catch (err) {
			return { indeterminate: fetchFailureReason(err) };
		}
		if (res.status === 404) {
			// Forgejo's answer for "no such collaborator on this repository". The one status that may read as
			// a refusal rather than a failure.
			return { authorized: false };
		}
		if (!res.ok) {
			// Note what is NOT here: the response body. A Forgejo error body can echo the request, and the
			// request carried the token.
			return { indeterminate: `collaborator permission lookup returned ${res.status}` };
		}
		let body;
		try {
			body = await res.json();
		} catch (err) {
			// A FIXED reason, never err.message: V8's JSON.parse errors quote the offending input,
			// so a failed res.json() here would carry response-body bytes into a log line -- the
			// no-pii-in-logs rule the github resolver states, applied to its elders (issue #231).
			return { indeterminate: "collaborator permission lookup returned unparseable JSON" };
		}
		const permission = body?.permission;
		if (typeof permission !== "string" || permission === "") {
			// A 200 whose shape we do not recognise is not a refusal. Answering `false` here would turn an
			// upstream schema change into a silent, permanent refusal of every trigger.
			return { indeterminate: "collaborator permission lookup returned no permission string" };
		}
		return { authorized: WRITE_PERMISSIONS.has(permission) };
	};
}
