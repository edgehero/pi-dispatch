/**
 * Resolve the harness's own Forgejo user id -- the value the bot-loop guard compares every delivery's
 * sender against.
 *
 * WHY THIS IS NOT SIMPLY `GET /user`, and why it can be configured instead.
 *
 * Issue #61 argues the bot-loop guard survives on Forgejo because `GET /user` has a direct equivalent. It
 * does. But the same issue's acceptance criteria mandate a REPO-SCOPED token, to satisfy the scope half of
 * `CONST-TOKEN-SCOPED-PER-JOB` -- and a Forgejo repo-scoped token may carry only `read:repository`,
 * `write:repository`, `read:issue` and `write:issue`. `read:user` is not among them, so the very token the
 * documentation tells an operator to mint may be unable to answer "who am I".
 *
 * Those two requirements cannot both be met by one mechanism, so the operator gets a second one:
 * `FORGEJO_BOT_ID`, the numeric id of the account the token belongs to, read straight off its profile.
 * When set it is used as-is and no call is made.
 *
 * WHAT MUST NOT HAPPEN is running with an unresolved id. `filter-forgejo.mjs` compares
 * `sender.id === selfId`, and `undefined` is never equal to a number -- so an unresolved identity does not
 * disable the guard loudly, it disables it SILENTLY, and the harness's own status comment becomes another
 * paid job, and that job's comment becomes another. So this throws, the caller does not catch, and the
 * receiver refuses to boot. A Forgejo endpoint that cannot identify itself must not accept deliveries.
 */

import { configError } from "./config.mjs";
import { isDeterminateFetchFailure, isJsonContentType, isTransientStatus, responseHeaderReader, transientError } from "./transient.mjs";
import { fetchFailureReason } from "./gitlab-identity.mjs";

const API_PREFIX = "/api/v1";

/**
 * The harness's own numeric Forgejo user id.
 *
 * `botId` short-circuits the call entirely -- it is the answer for a repo-scoped token that cannot ask.
 * Otherwise `GET /api/v1/user`, whose failure is reported with the scope hint, because a 403 here has
 * exactly one likely cause and telling the operator beats making them find it.
 */
export async function resolveForgejoSelfId({ apiUrl, token, botId = null, fetchFn = fetch }) {
	if (botId !== null && botId !== undefined && botId !== "") {
		const id = Number(botId);
		if (!Number.isInteger(id) || id <= 0) {
			throw configError(`FORGEJO_BOT_ID must be a positive integer user id (got ${JSON.stringify(botId)})`);
		}
		return id;
	}

	const url = `${String(apiUrl).replace(/\/+$/, "")}${API_PREFIX}/user`;
	let res;
	try {
		res = await fetchFn(url, { headers: { Authorization: `token ${token}` }, redirect: "error" });
	} catch (err) {
		// Transient, EXCEPT for the trust and redirect faults below, which is where this deliberately
		// diverges from forgejo-host.mjs: the host retries every rejection unconditionally, and being
		// unconditional is correct there because a job retry is cheap. A boot refusal is not (issue #316).
		if (isDeterminateFetchFailure(err)) throw configError(`could not resolve the forgejo bot identity from ${url}: ${fetchFailureReason(err)}`);
		throw transientError(`could not resolve the forgejo bot identity from ${url}: ${fetchFailureReason(err)}`, err);
	}
	if (res.status === 403 || res.status === 401) {
		// The likely cause, named. A repo-scoped Forgejo token cannot carry `read:user`, so this is the
		// expected outcome of following the scoping advice -- not a misconfiguration to go hunting for.
		throw configError(
			`the forgejo token cannot read its own user (${res.status}). A repository-scoped token carries only read/write:repository and read/write:issue, so it cannot call GET /user -- set FORGEJO_BOT_ID to the harness account's numeric id instead, or widen the token to include read:user`,
		);
	}
	if (!res.ok) {
		// The status only. A Forgejo error body can echo the request, and the request carried the token.
		// 401 and 403 were answered above, where they name the scope fix; what is left splits on the
		// shared rule, so a self-hosted instance answering 502 mid-restart no longer reads as a
		// misconfiguration the operator has to go and find.
		if (isTransientStatus(res.status, responseHeaderReader(res))) {
			throw transientError(`could not resolve the forgejo bot identity: GET /user returned ${res.status}`);
		}
		throw configError(`could not resolve the forgejo bot identity: GET /user returned ${res.status}`);
	}
	let body;
	try {
		body = await res.json();
	} catch (err) {
		// A body that will not parse is ambiguous in the expensive direction, so the CONTENT TYPE
		// decides it. A truncated JSON body is transient. An HTML page is not: it is a Cloudflare
		// Access or OIDC portal answering instead of the forge, and no amount of restarting gets past
		// one (issue #316).
		const contentType = responseHeaderReader(res);
		if (contentType("content-type") !== undefined && !isJsonContentType(contentType)) {
			throw configError(`could not resolve the forgejo bot identity: GET /user answered ${String(contentType("content-type"))} instead of JSON, so something other than the Forgejo API replied`);
		}
		throw transientError(`could not resolve the forgejo bot identity: unparseable JSON from GET /user (${err?.message ?? "unknown"})`, err);
	}
	const id = body?.id;
	if (!Number.isInteger(id)) {
		throw configError("could not resolve the forgejo bot identity: GET /user returned no integer id");
	}
	return id;
}
