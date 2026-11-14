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
import { githubFailureFields, stderrJson } from "./octokit-log.mjs";
import { isDeterminateFetchFailure, isTransientStatus, octokitHeaderReader, transientError } from "./transient.mjs";

/**
 * The repository permissions a GitHub App needs for everything the worker does with its installation tokens (issue
 * #876). `pi-dispatch setup github` asks for exactly these (`buildManifest`), and the worker's boot check below compares
 * an installation's grant with them, so the App the wizard makes and the line that says what an installation lacks
 * read one list.
 *
 * - `contents`: the agent pushes its branch, and the worker reads the default branch, its `protected` flag among it
 *   (`REQ-BRANCH-PROTECTION-PRECONDITION`, `github-host.mjs`), with Contents: read.
 * - `pull_requests`: the agent opens its pull request.
 * - `issues`: the worker's status and refusal comments, and the agent's own replies.
 * - `metadata`: GitHub grants it to every App and requires it.
 *
 * NOT `administration`, which the dedicated protection endpoint needs. The branch's `protected` flag answers the same
 * question, counts rulesets too, and needs nothing beyond Contents: read, so no job's token carries a read of the
 * repository's settings (issue #876).
 */
export const GITHUB_APP_PERMISSIONS = Object.freeze({ contents: "write", pull_requests: "write", issues: "write", metadata: "read" });

/** GitHub's permission levels in order. A level this table does not know ranks as none, so it is named, never passed. */
const PERMISSION_RANK = Object.freeze({ read: 1, write: 2, admin: 3 });
const rankOf = (level) => (typeof level === "string" && Object.hasOwn(PERMISSION_RANK, level) ? PERMISSION_RANK[level] : 0);

/**
 * Read the App installation's granted permissions with the App JWT and log one line naming each one below `required`
 * (issue #876). Answers `{ missing }` (such as `["issues:write"]`, empty when the grant covers every one), or `null`
 * when the grant could not be read.
 *
 * NEVER THROWS, and that is the contract rather than a convenience. This is a diagnosis at boot, not a gate: each
 * job's own reads are the gates, the protection read among them, which refuses a job whose token cannot read the
 * default branch (`branch-protection-unreadable`). A failed read here (GitHub down, a rate limit, an App JWT GitHub refuses) therefore
 * says only that the read failed (`github_app_permissions_unread`, with GitHub's status and request id, never the
 * response) and stops nothing. Reading the grant at boot is what doctor cannot do: doctor never reads the private key
 * whole, so it has no JWT to ask with.
 *
 * Why the INSTALLATION and not the App: the App's settings can ask for a permission that the installation has not yet
 * accepted, and GitHub mints tokens from the installation's grant, so the installation is the one that decides.
 *
 * `octokit` is the App-JWT client `makeGitHubAuth` builds (its auth strategy sends the JWT on `/app/installations/*`);
 * `log` is the caller's `(event, fields)` logger, a JSON line on stderr when none is given.
 */
export async function checkAppPermissions({ octokit, installationId, log = stderrJson, required = GITHUB_APP_PERMISSIONS }) {
	let granted;
	try {
		const { data } = await octokit.request("GET /app/installations/{installation_id}", { installation_id: installationId });
		granted = data?.permissions;
	} catch (error) {
		log("github_app_permissions_unread", { ...githubFailureFields(error) });
		return null;
	}
	if (granted === null || typeof granted !== "object" || Array.isArray(granted)) {
		log("github_app_permissions_unread", { why: "no-permissions-object" });
		return null;
	}
	const missing = Object.entries(required)
		.filter(([name, level]) => rankOf(Object.hasOwn(granted, name) ? granted[name] : undefined) < rankOf(level))
		.map(([name, level]) => `${name}:${level}`);
	if (missing.length > 0) {
		log("github_app_permission_missing", {
			missing,
			fix: "in the GitHub App's settings, set each named repository permission to at least that level (read is Read-only, write is Read and write), then accept the change on the App's installation (docs/github.md#app-permissions)",
		});
	}
	return { missing };
}

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
		// The RequestError rides as `cause` (issue #530's review), so the failure line can name GitHub's request id.
		throw Object.assign(configError(`resolveSelfId: could not resolve self identity: ${error.message}`), { cause: error });
	}

	if (!Number.isInteger(id)) {
		throw configError(`resolveSelfId: resolved id is not an integer: ${JSON.stringify(id)}`);
	}
	return id;
}
