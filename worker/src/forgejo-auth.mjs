/**
 * Forgejo/Gitea authentication for the worker: the counterpart of get-token.mjs and gitlab-auth.mjs,
 * yielding the identical `{ mintToken, selfId, source }` shape so nothing downstream branches on which
 * forge a job belongs to.
 *
 * CONST-TOKEN-SCOPED-PER-JOB, stated honestly. Forgejo has no App, no installation token, and no per-job
 * mint. What it does have -- and this is the interesting part -- is a REPO-SCOPED access token, which
 * GitLab's project token also gives but GitHub's classic PAT does not. So Forgejo and Azure DevOps fail
 * OPPOSITE halves of this constraint, and it is worth being precise about which:
 *
 *   - repo-scoped         YES, and better than GitLab's. A "specific repositories" token reaches only the
 *                         repositories the operator selected.
 *   - minimally-permissioned  YES, and this is the good news: such a token may carry ONLY
 *                         `read:repository`, `write:repository`, `read:issue` and `write:issue`. There is
 *                         no all-or-nothing `api` scope to fall back to, as there is on GitLab.
 *   - host-held           YES; it lives in the worker's env and reaches a container only as an env value.
 *   - env-injected        YES; never written to /workspace, .git/config, argv, or a log.
 *   - not merge-capable   YES in practice; branch protection is the barrier and no merge API is called.
 *                         But the author gate makes the account a repository ADMIN (Forgejo answers a lookup
 *                         of another user's permission only to an admin), and an admin's write:repository
 *                         token can lift that protection. OQ-043 records it, and what would close it.
 *   - short-lived         NO. The operator mints it by hand. Forgejo offers no installation-token
 *                         equivalent, so there is no path to a bounded expiry at all.
 *
 * That last row is the whole exception, and it is the one the constitution names as the blast-radius
 * bound -- "a when, not an if" for an agent induced to exfiltrate its environment. It is inherited from
 * the accepted `gh`/`pat` gap rather than being a new class, but unlike GitHub there is no stronger path
 * to prefer, so the docs must say so where an operator chooses.
 *
 * The narrow scope has one consequence that is NOT cosmetic: a repo-scoped token cannot call `GET /user`,
 * so the bot-loop guard's identity has to come from `FORGEJO_BOT_ID` instead. See forgejo-identity.mjs --
 * and note that an unresolved identity throws here rather than degrading, because a receiver that cannot
 * recognise its own comments turns them into more paid jobs.
 *
 * All side-effecting collaborators are INJECTED, so the module is testable offline with no Forgejo.
 */

import { configError } from "./config.mjs";
import { resolveForgejoSelfId } from "./forgejo-identity.mjs";

/**
 * Build the auth surface for `cfg = { source, apiUrl, tokenVar, botId }`.
 *
 * Fails CLOSED at construction: an empty token or an unresolvable identity throws before returning, so a
 * misconfigured worker refuses to boot rather than running jobs it cannot report on.
 */
export async function makeForgejoAuth(cfg, deps = {}) {
	const { env = process.env, fetchFn = fetch } = deps;
	const source = cfg?.source;
	if (source !== "pat") {
		// `app` is the value most likely to arrive here, from an operator copying the GitHub block. It is
		// refused by name rather than ignored, because an App is not merely unconfigured on Forgejo -- it
		// does not exist, and a worker that quietly fell back to `pat` would hide that.
		throw configError(`makeForgejoAuth: unknown or missing source: ${JSON.stringify(source)} (only "pat" is supported -- Forgejo has no App or installation-token equivalent)`);
	}

	const tokenVar = cfg.tokenVar ?? "FORGEJO_TOKEN";
	const token = requireToken(env[tokenVar], tokenVar);
	const selfId = await resolveForgejoSelfId({ apiUrl: cfg.apiUrl, token, botId: cfg.botId ?? null, fetchFn });

	// Ignores the job by design: one operator-supplied token serves every repository this deployment
	// services, exactly as the gitlab and github `pat` sources do. The parameter exists so the shape matches.
	const mintToken = async () => requireToken(token, tokenVar);
	return { mintToken, selfId, source };
}

/**
 * The money-hole invariant, mirrored from get-token.mjs: return a trimmed non-empty token, or throw.
 *
 * An empty credential would reach env-allowlist's truthiness check as falsy, the token would be OMITTED
 * from the container env entirely, and the job would run anonymously -- a silent, paid, useless run rather
 * than an error.
 */
function requireToken(raw, what) {
	const token = typeof raw === "string" ? raw.trim() : "";
	if (token === "") {
		throw configError(`${what} is empty or unset; refusing to hand a job an empty Forgejo credential`);
	}
	return token;
}
