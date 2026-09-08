/**
 * Resolve the harness's own Azure DevOps identity -- BOTH forms, because Azure identifies an actor two
 * different ways depending on the event.
 *
 * `GET {org}/_apis/connectionData` answers with `authenticatedUser`, which carries the GUID and the
 * account name (a UPN / email) in one response. That is the whole reason this is one call rather than two:
 * a pull-request delivery names the actor by GUID, a work-item delivery names them only as
 * `"Display Name <email>"`, and the bot-loop guard has to be able to recognise the harness in EITHER.
 *
 * WHY BOTH, AND WHY A MISSING ONE IS NOT FATAL. `filter-azure.mjs` compares each form independently and
 * treats an EMPTY side as "never matches". So resolving only the GUID leaves the guard working on
 * pull-request events and blind on work-item comments -- which is a real gap, but a narrower one than
 * refusing to boot at all, and it is visible in the startup log line rather than inferred. What is NOT
 * tolerated is resolving NEITHER: that is a guard that can never fire, and it throws.
 */

import { configError } from "./config.mjs";
import { isDeterminateFetchFailure, isJsonContentType, isTransientStatus, responseHeaderReader, transientError } from "./transient.mjs";
import { fetchFailureReason } from "./gitlab-identity.mjs";

/**
 * The harness's `{ id, email }` on this organization. `id` is the identity GUID; `email` is lowercased so
 * the comparison in the gate can be, too.
 *
 * Throws when neither can be established -- see the header.
 */
export async function resolveAzureSelfId({ orgUrl, token, fetchFn = fetch }) {
	const root = String(orgUrl ?? "").replace(/\/+$/, "");
	// Azure authenticates a PAT as HTTP Basic with an empty username.
	const auth = `Basic ${Buffer.from(`:${token}`, "utf8").toString("base64")}`;
	const url = `${root}/_apis/connectionData?api-version=7.1-preview.1`;

	let res;
	try {
		res = await fetchFn(url, { headers: { Authorization: auth, accept: "application/json" }, redirect: "error" });
	} catch (err) {
		// Transient, EXCEPT for the trust and redirect faults below. azure-host.mjs retries every
		// rejection unconditionally; that is right for a job and wrong for a boot, which is the whole
		// distinction issue #316 turns on.
		if (isDeterminateFetchFailure(err)) throw configError(`could not resolve the azure bot identity from ${url}: ${fetchFailureReason(err)}`);
		throw transientError(`could not resolve the azure bot identity from ${url}: ${fetchFailureReason(err)}`, err);
	}
	if (!res.ok) {
		// The status only. An Azure error body can echo the request, and the request carried the token.
		if (isTransientStatus(res.status, responseHeaderReader(res))) {
			throw transientError(`could not resolve the azure bot identity: connectionData returned ${res.status}`);
		}
		throw configError(`could not resolve the azure bot identity: connectionData returned ${res.status}`);
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
			throw configError(`could not resolve the azure bot identity: connectionData answered ${String(contentType("content-type"))} instead of JSON. Azure answers an expired or invalid PAT with 203 and a sign-in page, which is what this usually is`);
		}
		throw transientError(`could not resolve the azure bot identity: unparseable JSON from connectionData (${err?.message ?? "unknown"})`, err);
	}

	const user = body?.authenticatedUser ?? {};
	const id = typeof user.id === "string" && user.id !== "" ? user.id : null;
	// The account name lives in a properties bag, and its shape differs between hosted and server
	// deployments; `providerDisplayName` is a display name and is deliberately NOT used, because a display
	// name is attacker-settable and comparing against one is how a stranger becomes the harness.
	const raw = user.properties?.Account?.$value ?? user.properties?.Account ?? null;
	const email = typeof raw === "string" && raw.includes("@") ? raw.trim().toLowerCase() : null;

	if (id === null && email === null) {
		throw configError(
			"could not resolve the azure bot identity: connectionData named neither an id nor an account address, so the bot-loop guard could never recognise this harness's own activity",
		);
	}
	return { id, email };
}
