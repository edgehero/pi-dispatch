/**
 * Resolve an Azure DevOps actor's project membership -- the enforcement half of
 * `CONST-TRIGGER-AUTHOR-GATE` on the Azure side.
 *
 * Azure has no `author_association` and no numeric access level. What it has is a graph of subjects and
 * groups, and "is this person a member of this project" is answered by walking it. That is TWO calls, not
 * one, which is a real cost this arm carries and the other three do not:
 *
 *   1. the actor -> a subject DESCRIPTOR. A pull-request payload gives a GUID, a work-item payload gives
 *      only an email address, so there are two lookups depending on which the event carried. The email one
 *      is a LIST walk and may itself span several requests -- see the pagination note on resolveDescriptor.
 *   2. the descriptor -> membership of the project's own group.
 *
 * Both can go indeterminate, so the indeterminate surface here is wider than GitLab's, not merely equal to
 * it. `OQ-013` is amended to say so rather than leaving it implied.
 *
 * The verdict shape is every other forge's: `{ authorized }` | `{ indeterminate }`. A determinate "not a
 * member" refuses; anything that could not be answered is a 503 so Azure redelivers.
 *
 * WHY MEMBERSHIP AND NOT A PERMISSION EVALUATION. Azure's Security namespace API can answer "may this
 * subject contribute to this repository" exactly, which is closer to the property the constitution wants.
 * It is not used, for one reason worth stating: it requires the caller to construct a security-namespace
 * token by hand, and a token constructed slightly wrong returns a confident answer about a DIFFERENT
 * object. Project membership is coarser and readable, and coarser-but-right beats exact-but-fragile on a
 * gate that decides whether a stranger can spend money.
 *
 * The email is never logged or returned; it is personal data with exactly one consumer, like Forgejo's
 * login and GitLab's username.
 */

import { fetchFailureReason } from "@edgehero/pi-dispatch/gitlab-identity";

/**
 * How many pages of the organisation's user list one delivery may walk while looking for an email address.
 *
 * The cap is counted in PAGES and not in users, because the page size is Azure's to choose and is not part
 * of the request -- what this bounds is request AMPLIFICATION: one webhook must never turn into an
 * unbounded crawl of a directory, and an org that grew a page while the loop was running must still
 * terminate. Twenty is chosen to be comfortably past any real organisation at Azure's own page size
 * (hundreds of subjects per page) and still a fixed number of round trips.
 *
 * Running out of pages is NOT a refusal -- see resolveDescriptor.
 */
const MAX_USER_PAGES = 20;

/**
 * Build the resolver.
 *
 * `orgUrl` is `https://dev.azure.com/<org>`; the Graph API lives on a DIFFERENT host
 * (`https://vssps.dev.azure.com/<org>`), which is derived here rather than asked for, so an operator
 * configures one URL and cannot get the pair inconsistent.
 *
 * Returns `resolveAuthority(projectId, actor)` where `actor` is `{ id }` or `{ email }`.
 */
export function makeResolveAzureAuthority({ orgUrl, token, fetchFn = fetch }) {
	const root = String(orgUrl ?? "").replace(/\/+$/, "");
	const vssps = root.replace("https://dev.azure.com", "https://vssps.dev.azure.com");
	// Azure authenticates a PAT as HTTP Basic with an empty username.
	const auth = `Basic ${Buffer.from(`:${token}`, "utf8").toString("base64")}`;

	/**
	 * One Graph GET. `{ body, continuation }` on a 2xx, `{ indeterminate }` on anything else -- the whole
	 * error taxonomy of this module lives here, once, so a new call site cannot invent a different one.
	 *
	 * `continuation` carries Azure's paging cursor for the LIST endpoints and is null for everything else.
	 * The Graph does not use a Link header and does not put the cursor in the body: a page that is not the
	 * last one returns an `X-MS-ContinuationToken` RESPONSE HEADER, which the caller sends back as a
	 * `continuationToken` QUERY PARAMETER on the next request. It is read here rather than in a sibling
	 * helper so the two single-object descriptor lookups and the membership lookup keep sharing one code
	 * path; they simply ignore a field Azure never sets for them.
	 *
	 * `headers.get` is called defensively. A real `Response` always has it, but `fetchFn` is injected, and a
	 * fake that returns a plain object must not turn a lookup into a TypeError -- which would escape as a
	 * throw rather than as this module's `{ indeterminate }`.
	 */
	async function get(url) {
		let res;
		try {
			res = await fetchFn(url, { headers: { Authorization: auth, accept: "application/json" }, redirect: "error" });
		} catch (err) {
			return { indeterminate: fetchFailureReason(err) };
		}
		if (!res.ok) {
			// Status only. An Azure error body can echo the request, and the request carried the token.
			return { indeterminate: `azure lookup returned ${res.status}` };
		}
		const continuation = typeof res.headers?.get === "function" ? res.headers.get("x-ms-continuationtoken") : null;
		try {
			return { body: await res.json(), continuation: continuation || null };
		} catch (err) {
			// A FIXED reason, never err.message: V8's JSON.parse errors quote the offending input,
			// so a failed res.json() here would carry response-body bytes into a log line -- the
			// no-pii-in-logs rule the github resolver states, applied to its elders (issue #231).
			return { indeterminate: "azure lookup returned unparseable JSON" };
		}
	}

	return async function resolveAuthority(projectId, actor) {
		if (typeof projectId !== "string" || projectId === "") {
			// The payload named no project, so there is nothing to ask about. Determinate, and refused.
			return { authorized: false };
		}

		const descriptor = await resolveDescriptor(actor);
		if (descriptor.indeterminate) return descriptor;
		if (descriptor.value === null) return { authorized: false };

		// The project's own scope descriptor -- the container every project member belongs to.
		const scope = await get(`${vssps}/_apis/graph/descriptors/${encodeURIComponent(projectId)}?api-version=7.1-preview.1`);
		if (scope.indeterminate) return scope;
		const container = scope.body?.value;
		if (typeof container !== "string" || container === "") {
			// A 200 whose shape we do not recognise is not a refusal: answering `false` here would turn an
			// upstream schema change into a silent, permanent refusal of every trigger.
			return { indeterminate: "azure project descriptor lookup returned no descriptor" };
		}

		// Membership is TRANSITIVE via `direction=up`: a member of a team inside the project is a member of
		// the project, and asking only for direct membership would refuse most real organisations -- the same
		// mistake `members/all` avoids on GitLab.
		//
		// This reads ONE page, unlike the users listing above, and that is a scope statement rather than a
		// claim: what is being listed here is one subject's own containers, not a directory, so the two are
		// not the same size of question. `get` surfaces `continuation` for this call too, so if this ever
		// needs following the mechanism is already here -- but no cap or verdict is invented for a paging
		// behaviour nothing in this codebase has observed on this endpoint.
		const memberships = await get(`${vssps}/_apis/graph/memberships/${encodeURIComponent(descriptor.value)}?direction=up&api-version=7.1-preview.1`);
		if (memberships.indeterminate) return memberships;
		const list = memberships.body?.value;
		if (!Array.isArray(list)) {
			return { indeterminate: "azure memberships lookup returned no array" };
		}
		return { authorized: list.some((m) => m?.containerDescriptor === container) };
	};

	/**
	 * The actor's subject descriptor: by GUID for a pull request, by email for a work item.
	 *
	 * THE EMAIL PATH IS PAGINATED, and that is the whole difficulty of this function. Azure's Graph has no
	 * lookup-by-mail-address endpoint, so the organisation's user list is fetched and filtered locally --
	 * and that list is paged. Reading only the first page meant that in any organisation whose directory
	 * exceeds one page, an actor beyond it resolved to nobody, which is DETERMINATE: the gate refused, the
	 * receiver answered 204, and work-item (tag and comment) triggers simply never fired for those people,
	 * behind a status indistinguishable from a stranger being correctly turned away. Pull requests were
	 * never affected -- a PR names its actor by GUID and takes the direct descriptor lookup above.
	 *
	 * So the pages are followed (see `get` for the header/query-parameter mechanism), and the three ways out
	 * are deliberately three different answers:
	 *
	 *   - FOUND, on any page -> the descriptor. The loop stops at the hit, so an actor on page 1 still costs
	 *     exactly one request; nobody pays for pagination that was not needed.
	 *   - the listing ENDED (a page with no continuation token) and the actor was not in it -> determinate
	 *     `null`, which the caller refuses. This is the honest refusal: the entire directory was read.
	 *   - the PAGE CAP was reached while Azure was still offering more -> `{ indeterminate }`, never `null`.
	 *     The search was abandoned, not completed, and the module's own docblock is explicit that
	 *     indeterminate and unauthorized must not be conflated: this way the receiver answers 503 and Azure
	 *     redelivers, instead of burying an exhausted search inside a 204 that reads as a policy decision.
	 *
	 * A FILTERED LOOKUP WOULD BE BETTER AND IS NOT USED. Nothing in the Graph surface this module already
	 * speaks offers a by-mail filter on `graph/users` (`subjectTypes` selects kinds of subject, not
	 * identities), and the endpoints that come close -- a subject query, the older Identities API -- return
	 * shapes this file has never handled and whose descriptor flavour may not be the one `graph/memberships`
	 * accepts. Guessing one would repeat exactly the mistake the security-namespace paragraph above refuses:
	 * a confident answer about a different object. The list walk is coarser and verifiable, so it stays.
	 *
	 * The address is still never logged or returned, including in the indeterminate reason.
	 */
	async function resolveDescriptor(actor) {
		if (typeof actor?.id === "string" && actor.id !== "") {
			const res = await get(`${vssps}/_apis/graph/descriptors/${encodeURIComponent(actor.id)}?api-version=7.1-preview.1`);
			if (res.indeterminate) return res;
			const value = res.body?.value;
			return { value: typeof value === "string" && value !== "" ? value : null };
		}
		if (typeof actor?.email === "string" && actor.email !== "") {
			const wanted = actor.email.toLowerCase();
			let token = null;
			for (let page = 0; page < MAX_USER_PAGES; page++) {
				// `subjectTypes=aad,msa` excludes groups and service principals, which cannot be the human this
				// gate is about. The continuation token is appended only when there is one, so the FIRST request
				// is byte-identical to the single-page one this replaced.
				const res = await get(`${vssps}/_apis/graph/users?subjectTypes=aad,msa&api-version=7.1-preview.1${token ? `&continuationToken=${encodeURIComponent(token)}` : ""}`);
				if (res.indeterminate) return res;
				const users = res.body?.value;
				if (!Array.isArray(users)) return { indeterminate: "azure users lookup returned no array" };
				const hit = users.find((u) => String(u?.principalName ?? "").toLowerCase() === wanted || String(u?.mailAddress ?? "").toLowerCase() === wanted);
				if (hit) return { value: typeof hit.descriptor === "string" ? hit.descriptor : null };
				if (!res.continuation) return { value: null }; // the list ended: a determinate "not in this org"
				token = res.continuation;
			}
			// Still more pages on offer. Nothing was decided, so nothing is refused.
			return { indeterminate: `azure users lookup did not reach the actor within ${MAX_USER_PAGES} pages` };
		}
		// Neither a GUID nor a parseable address: the delivery named nobody this gate can ask about.
		return { value: null };
	}
}
