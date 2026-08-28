/**
 * Resolve a GitHub CLOSER's repository permission -- the enforcement half of `CONST-TRIGGER-AUTHOR-GATE`'s
 * close arm on the GitHub side.
 *
 * Every other GitHub route reads an association straight off the payload and pays no lookup. A close
 * cannot: an issue's own author can close it with no write access whatsoever, and on a pull request
 * `author_association` names the AUTHOR, a different person from the closer -- the review inversion a
 * second time. The payload carries NO association for the closer at all, so the closer is resolved by
 * login through `GET /repos/{owner}/{repo}/collaborators/{username}/permission`, whose legacy
 * `permission` field answers `"admin"|"write"|"read"|"none"`. `admin` and `write` are exactly the levels
 * that can push a branch, which is the property the constitution actually requires.
 *
 * The shape of this module is the Forgejo resolver's, for the same three reasons, restated rather than
 * cross-referenced:
 *   - it runs in the RECEIVER, between verification and the gate, so `filter` stays pure, total and
 *     offline-testable -- a fetch inside the gate would make the security-critical decision untestable
 *     without a server;
 *   - it runs AFTER verification -- and, unlike every sibling resolver, only for a close delivery an
 *     armed close rule actually matches (`wantsCloserAuthority`), so every other GitHub path stays
 *     payload-only and lookup-free, and an unauthenticated flood cannot make this project call GitHub;
 *   - it returns a two-armed verdict, because "not a collaborator" and "could not tell" are different
 *     answers. A 404 is determinate and refuses; anything unrecognised is INDETERMINATE and the receiver
 *     answers 503, so GitHub redelivers and the stable `X-GitHub-Delivery` GUID dedups the retry.
 *     Collapsing indeterminate to "deny" would drop real work during an outage behind a 204 that looks
 *     exactly like a stranger being correctly refused.
 *
 * One difference from every sibling: there is no operator token in config to close over. The GitHub arm
 * holds the boot-time auth object instead, so the credential is MINTED per call. On the App source the
 * caller asks the mint to scope it to the one repository AND narrow it to metadata:read, so what this
 * function holds cannot write even if leaked; on pat/gh no narrowing exists (the operator's standing
 * token is what it is, and it already lives in this process's env), so what the wiring buys there is
 * one read with a credential the receiver held anyway. Never a job credential on any source, and no
 * container ever receives it (`CONST-TOKEN-SCOPED-PER-JOB`, whose per-job wording start.mjs's header
 * records). Closes are rare, so per-delivery minting is the recorded cost; the poller's token cache is
 * the fallback if that changes.
 *
 * The username is required (the endpoint takes no numeric id) and is never logged or returned. One
 * honest bound on that claim, shared with every sibling resolver: the network-throw arm returns
 * `fetchFailureReason(err)`, and undici's error messages carry the HOST, never the request path --
 * so the guarantee on that one arm rests on undici's phrasing rather than a fixed token, exactly as
 * it does in the forgejo/gitlab/azure resolvers. Every arm this module authors itself is a fixed
 * string.
 */

import { fetchFailureReason } from "@edgehero/pi-dispatch/gitlab-identity";

/** GitHub's API root. Not configurable: this arm serves github.com, the forges with a host knob have their own resolvers. */
const API_ROOT = "https://api.github.com";

/**
 * The permission levels that can push to the repository. `read` and `none` cannot, so a job started on
 * their say-so would be doing work the actor could not do themselves -- the line CONST-TRIGGER-AUTHOR-GATE
 * draws. Two members is the COMPLETE honest mapping, not a shortcut: GitHub folds `maintain` into `write`
 * and `triage` into `read` in this legacy field, so every role that can push already reads as one of
 * these. The response's richer `role_name` is deliberately not read -- it can name Ultimate custom roles
 * this code has no table to rank, and ranking them wrongly fails OPEN.
 */
const WRITE_PERMISSIONS = new Set(["admin", "write"]);

/**
 * Build the resolver. `mintToken` is the boot auth object's own minter (it takes a job-shaped `{ repo }`
 * and scopes the token to it); `fetchFn` is injected so the whole module is testable offline.
 *
 * Returns `resolveAuthority(repoFullName, login)` -> `{ authorized: boolean }` | `{ indeterminate: string }`
 * -- the same shape every forge's resolver returns.
 */
export function makeResolveGitHubAuthority({ mintToken, fetchFn = fetch }) {
	return async function resolveAuthority(repoFullName, login) {
		// Both halves have to be present AND well-formed before they become path segments. A slash or a `..`
		// in either would reach a different endpoint than the one this function believes it is asking, and
		// the answer would be attributed to the wrong repository or the wrong person. Whitespace joins the
		// refused set here because a GitHub login can never carry it, so its presence is a malformed payload,
		// not a user. Determinate refusals, before the mint: nothing is asked about, so nothing is spent.
		const repo = typeof repoFullName === "string" ? repoFullName.split("/") : [];
		// The repo halves get the login's charset discipline PLUS the dot-segment refusal: a half of
		// exactly "." or ".." would URL-normalize the request onto a different endpoint than the one
		// this function believes it is asking (a repo NAME may contain dots -- "next.js" is real -- so
		// only the two pure dot segments are refused, never dots inside a name).
		const badHalf = (h) => !h || h === "." || h === ".." || /[/?#\s]/.test(h);
		if (repo.length !== 2 || badHalf(repo[0]) || badHalf(repo[1]) || typeof login !== "string" || login === "" || /[/?#\s]/.test(login)) {
			// Not a lookup failure -- the payload never named a repository and an actor we could ask about.
			return { authorized: false };
		}
		// Minted per call, repo-scoped (the auth object's minter reads `job.repo`). A mint failure is
		// INDETERMINATE -- the closer's standing was never established -- and the reason is a fixed token,
		// never the thrown message: configError texts name auth sources and key paths, which have no
		// business in a per-delivery log line.
		let token;
		try {
			token = await mintToken({ repo: repoFullName });
		} catch {
			return { indeterminate: "token-mint-failed" };
		}
		const url = `${API_ROOT}/repos/${encodeURIComponent(repo[0])}/${encodeURIComponent(repo[1])}/collaborators/${encodeURIComponent(login)}/permission`;
		let res;
		try {
			// `redirect: "error"` so a 30x on this path cannot silently send the token somewhere else -- the
			// same rule the Forgejo and GitLab resolvers apply.
			res = await fetchFn(url, {
				headers: {
					accept: "application/vnd.github+json",
					"x-github-api-version": "2022-11-28",
					authorization: `Bearer ${token}`,
				},
				redirect: "error",
			});
		} catch (err) {
			return { indeterminate: fetchFailureReason(err) };
		}
		if (res.status === 404) {
			// Unknown user or unknown repository -- determinate, and refused. NOT the usual non-collaborator
			// answer: see the `permission: "none"` note below.
			return { authorized: false };
		}
		if (!res.ok) {
			// Status only. What is NOT here: the response body -- a GitHub error body can echo the request,
			// and the request carried the token.
			return { indeterminate: `status-${res.status}` };
		}
		let body;
		try {
			body = await res.json();
		} catch {
			// A fixed token, deliberately WITHOUT the parse error's message -- a divergence from the Forgejo
			// resolver worth its own line: V8's JSON.parse errors quote the offending input, and the input
			// here is the response body, which must never reach a returned string.
			return { indeterminate: "collaborator permission lookup returned unparseable JSON" };
		}
		const permission = body?.permission;
		if (typeof permission !== "string" || permission === "") {
			// A 200 whose shape we do not recognise is not a refusal. Answering `false` here would turn an
			// upstream schema change into a silent, permanent refusal of every close trigger.
			return { indeterminate: "collaborator permission lookup returned no permission string" };
		}
		// The NORMAL answer for a non-collaborator is a 200 with `permission: "none"` -- GitHub answers the
		// question for any visible user rather than 404ing strangers -- so this line, not the 404 arm above,
		// is where most unauthorized closers are refused.
		return { authorized: WRITE_PERMISSIONS.has(permission) };
	};
}
