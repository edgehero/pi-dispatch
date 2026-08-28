/**
 * Resolve a GitLab actor's project access level -- the enforcement half of `CONST-TRIGGER-AUTHOR-GATE` on
 * the GitLab side.
 *
 * GitHub puts `author_association` in the payload, so its gate is decidable from the delivery alone.
 * GitLab puts nothing equivalent anywhere in a webhook body, so the level has to be ASKED FOR. That single
 * fact shapes everything here:
 *
 *   - It runs in the receiver, between verification and `filterGitLab`, and only its VERDICT is passed into
 *     the gate. The gate stays pure, total and offline-testable; a fetch inside it would make the
 *     security-critical decision untestable without a server.
 *   - It runs AFTER verification, never before, so an unauthenticated flood cannot make this project issue
 *     API calls on an attacker's behalf.
 *   - It distinguishes "not a member" from "could not tell", and those are different answers. A 404 is
 *     determinate and yields `authorized: false`, which the gate refuses. Anything else -- a 5xx, a dead
 *     socket, a revoked token -- is INDETERMINATE, and the receiver answers 503 so GitLab redelivers.
 *     Collapsing indeterminate to "deny" would silently drop legitimate work during an outage, with a 204
 *     that reads exactly like a correctly-refused stranger.
 *
 * `members/all` and not `members`: the `all` variant includes membership inherited from a parent group,
 * which is how most real GitLab organisations grant access. The plain endpoint reports only direct members
 * and would refuse a maintainer who holds their role at the group level -- a denial that looks like a
 * policy decision and is really a wrong question.
 *
 * The username is never sent, logged or returned; the lookup is by numeric user id.
 */

import { fetchFailureReason } from "@edgehero/pi-dispatch/gitlab-identity";

/** GitLab's API path prefix. `apiUrl` is the instance root, e.g. `https://gitlab.com`. */
const API_PREFIX = "/api/v4";

/**
 * GitLab's Developer role. At or above it, an actor can push to the project, which is the property
 * CONST-TRIGGER-AUTHOR-GATE actually requires -- "write access or above", by whatever mechanism the forge
 * offers.
 *
 * The threshold lives HERE, with the lookup that produces the number, rather than in the gate. The gate's
 * job is "is this actor authorised", and every forge answers that differently: GitLab with an integer role,
 * Forgejo with a string enum, GitHub with a payload field, Azure DevOps with a group membership. Only the
 * VERDICT is common, so only the verdict crosses into the filter.
 */
const DEVELOPER = 30;

/**
 * Build the resolver. `token` is the same operator-supplied access token the worker uses; `fetchFn` is
 * injected so the whole module is testable offline.
 *
 * Returns `resolveAuthority(projectId, userId)` -> `{ authorized: boolean }` | `{ indeterminate: string }`.
 *
 * That two-armed shape is the one every forge's resolver returns, and it is deliberately not a bare
 * boolean: `false` and "could not tell" are different answers with different HTTP responses, and a type
 * that cannot express the difference would collapse them at the first call site that forgot.
 */
export function makeResolveAuthority({ apiUrl, token, fetchFn = fetch }) {
	return async function resolveAuthority(projectId, userId) {
		if (!Number.isInteger(projectId) || !Number.isInteger(userId)) {
			// Not a lookup failure -- the payload never named a project or an actor, so there is nothing to
			// ask about. Determinate, and refused.
			return { authorized: false };
		}
		const url = `${String(apiUrl).replace(/\/+$/, "")}${API_PREFIX}/projects/${projectId}/members/all/${userId}`;
		let res;
		try {
			res = await fetchFn(url, { headers: { "PRIVATE-TOKEN": token }, redirect: "error" });
		} catch (err) {
			return { indeterminate: fetchFailureReason(err) };
		}
		if (res.status === 404) {
			// GitLab's documented answer for "this user is not a member of this project", including via any
			// ancestor group. The one status this may read as a refusal rather than a failure.
			return { authorized: false };
		}
		if (!res.ok) {
			return { indeterminate: `members lookup returned ${res.status}` };
		}
		let body;
		try {
			body = await res.json();
		} catch (err) {
			// A FIXED reason, never err.message: V8's JSON.parse errors quote the offending input,
			// so a failed res.json() here would carry response-body bytes into a log line -- the
			// no-pii-in-logs rule the github resolver states, applied to its elders (issue #231).
			return { indeterminate: "members lookup returned unparseable JSON" };
		}
		const level = body?.access_level;
		if (!Number.isInteger(level)) {
			// A 200 whose shape we do not recognise is not a refusal. Reporting `authorized: false` here would
			// turn an upstream schema change into a silent, permanent refusal of every trigger.
			return { indeterminate: "members lookup returned no integer access_level" };
		}
		return { authorized: level >= DEVELOPER };
	};
}
