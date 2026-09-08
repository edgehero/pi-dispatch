/**
 * Resolve the acting GitHub identity's numeric `id` -- the value that appears in webhook
 * `sender.id`. The receiver's bot-loop guard compares an incoming `sender.id` against this to
 * refuse events the harness itself authored (an unbounded paid recursion otherwise). If the id
 * cannot be resolved the guard cannot arm, so this fails CLOSED: any failure throws and the
 * process must not boot. WHICH failure it throws is what decides whether the process comes back
 * (issue #316): a determinate fault is tagged and stays stopped, a transient one is untagged and
 * is restarted.
 *
 * The `octokit` client is INJECTED, already authenticated by the caller (user token for pat/gh,
 * app-JWT for app). This module never constructs Octokit -- keeping it a pure, testable leaf, per
 * the budget.mjs convention.
 */

import { configError } from "./config.mjs";
import { isDeterminateFetchFailure, isTransientStatus, octokitHeaderReader, transientError } from "./transient.mjs";

/**
 * Resolve the acting identity's numeric user id from `auth = { source, octokit }`.
 *
 * - `pat` / `gh`: the token belongs to a user -- `GET /user` yields that user's id.
 * - `app`: the token is an app-JWT. `GET /app` yields the app `slug`; the bot USER whose id shows
 *   up in `sender.id` is `slug[bot]`, resolved via `GET /users/{username}`. The App id is a
 *   different number and would never match `sender.id`, so the two-step is required.
 *
 * Returns an integer id. Throws `configError` on unknown/missing source, missing octokit, a determinate
 * octokit refusal, or a non-integer id.
 *
 * A TRANSIENT octokit rejection throws UNTAGGED instead (issue #316). The tag is not decoration here: it
 * is the difference between a service that comes back and one that does not. `receiver/src/cli.mjs` maps
 * a tagged throw to `EXIT_POLICY` (2), which `RestartPreventExitStatus=2` and nssm's `AppExit 2 Exit`
 * deliberately leave stopped; and on the worker, whose `cli.mjs` never sees this because `start.mjs`
 * catches it best-effort, the tag decides whether that forge stays credential-less for the lifetime of
 * the process, after which every job of that kind is publicly told the deployment is misconfigured. A
 * `GET /user` that timed out is none of those things.
 *
 * TWO THINGS THE STATUS ALONE CANNOT TELL YOU, both of which have to be answered before it is consulted.
 * `@octokit/request`'s fetch wrapper turns EVERY network rejection into `RequestError(message, 500)` and
 * keeps the original as `cause`, so a private CA or a redirect arrives wearing a transient status and the
 * determinate check has to run first. And an ABSENT status means the failure never reached the HTTP layer
 * at all, because octokit always sets one: it came from local code, which in practice means signing the
 * App JWT with a key that is not PKCS//8 -- the commonest App setup mistake there is, and one that no
 * amount of restarting fixes.
 */
export async function resolveSelfId(auth) {
	const source = auth?.source;
	const octokit = auth?.octokit;

	if (source !== "pat" && source !== "gh" && source !== "app") {
		throw configError(`resolveSelfId: unknown auth source: ${source}`);
	}
	if (!octokit) {
		throw configError("resolveSelfId: missing octokit client");
	}

	let id;
	try {
		if (source === "app") {
			const { data: app } = await octokit.request("GET /app");
			const { data: bot } = await octokit.request("GET /users/{username}", {
				username: `${app.slug}[bot]`,
			});
			id = bot.id;
		} else {
			const { data: user } = await octokit.request("GET /user");
			id = user.id;
		}
	} catch (error) {
		// Order is load-bearing; see the docblock. Trust and redirect faults are wearing a 500, and a
		// status-less rejection never reached the network.
		const status = typeof error?.status === "number" ? error.status : undefined;
		if (!isDeterminateFetchFailure(error) && status !== undefined && isTransientStatus(status, octokitHeaderReader(error), error?.message)) {
			throw transientError(`resolveSelfId: could not reach GitHub to resolve self identity: ${error.message}`, error);
		}
		throw configError(`resolveSelfId: could not resolve self identity: ${error.message}`);
	}

	if (!Number.isInteger(id)) {
		throw configError(`resolveSelfId: resolved id is not an integer: ${JSON.stringify(id)}`);
	}
	return id;
}
