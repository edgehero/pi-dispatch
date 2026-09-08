/**
 * Resolve the acting GitHub identity's numeric `id` -- the value that appears in webhook
 * `sender.id`. The receiver's bot-loop guard compares an incoming `sender.id` against this to
 * refuse events the harness itself authored (an unbounded paid recursion otherwise). If the id
 * cannot be resolved the guard cannot arm, so this fails CLOSED: any failure throws a tagged
 * config error and the process must not boot.
 *
 * The `octokit` client is INJECTED, already authenticated by the caller (user token for pat/gh,
 * app-JWT for app). This module never constructs Octokit -- keeping it a pure, testable leaf, per
 * the budget.mjs convention.
 */

import { configError } from "./config.mjs";
import { isTransientStatus, octokitHeaderReader } from "./transient.mjs";

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
 * is the difference between a service that comes back and one that does not. `cli.mjs` maps a tagged
 * throw to `EXIT_POLICY` (2), which `RestartPreventExitStatus=2` and nssm's `AppExit 2 Exit` deliberately
 * leave stopped, and the worker's own best-effort boot catch leaves the forge credential-less for the
 * lifetime of the process, after which every job of that kind is publicly told the deployment is
 * misconfigured. A `GET /user` that timed out is none of those things, so it is reported as itself and
 * the supervisor gets its exit 1.
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
		// `isTransientStatus` answers TRUE for an absent or unparseable status, which is the right answer
		// for anything that reached here without being an HTTP refusal at all.
		const status = typeof error?.status === "number" ? error.status : undefined;
		if (isTransientStatus(status, octokitHeaderReader(error))) {
			throw new Error(`resolveSelfId: could not reach GitHub to resolve self identity: ${error.message}`, { cause: error });
		}
		throw configError(`resolveSelfId: could not resolve self identity: ${error.message}`);
	}

	if (!Number.isInteger(id)) {
		throw configError(`resolveSelfId: resolved id is not an integer: ${JSON.stringify(id)}`);
	}
	return id;
}
