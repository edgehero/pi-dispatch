import assert from "node:assert/strict";
import { test } from "node:test";
import { makeResolveAzureAuthority } from "../src/azure-members.mjs";

const ORG = "https://dev.azure.com/contoso";
const PROJECT = "proj-guid";
const CONTAINER = "vssgp.project-container";
const ACTOR = "aad.actor-descriptor";
const EMAIL = "dev@example.com";

/** The membership answer that makes the actor a member of PROJECT (transitively -- `direction=up`). */
const MEMBER_OF_PROJECT = [{ containerDescriptor: "vssgp.some-team" }, { containerDescriptor: CONTAINER }];

/**
 * One canned Graph response. `continuation` is emitted as the REAL header name Azure uses
 * (`X-MS-ContinuationToken`) inside a real `Headers`, deliberately: the module reads it lower-cased, and
 * only a case-insensitive container proves those are the same header. A fake that echoed back whatever key
 * the implementation happened to ask for would pass while the production lookup read nothing.
 */
function graphRes(status, body = {}, continuation = null) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers(continuation ? { "X-MS-ContinuationToken": continuation } : {}),
		json: async () => body,
	};
}

/**
 * A fake Graph host that THROWS on an unrouted path, so a wrong endpoint is a test failure rather than a
 * silent miss.
 *
 * `pageFor(i)` drives `GET /_apis/graph/users` per request: either `{ users, continuation }` or a bare HTTP
 * status for a mid-pagination failure. It is a function rather than an array so a test can offer an
 * ENDLESS run of pages and let the module's own cap be the thing that stops it.
 *
 * Every call is recorded with the `continuationToken` query parameter it carried, which is the assertion
 * that matters most here: following pagination means sending back exactly the token the previous response
 * returned, and nothing else in the request changes.
 */
function fakeGraph({ pageFor = () => ({ users: [], continuation: null }), descriptors = { [PROJECT]: CONTAINER }, memberships = MEMBER_OF_PROJECT } = {}) {
	const calls = [];
	let userRequests = 0;
	const fetchFn = async (url) => {
		const u = new URL(String(url));
		calls.push({ path: u.pathname, continuationToken: u.searchParams.get("continuationToken"), subjectTypes: u.searchParams.get("subjectTypes") });
		if (u.pathname.endsWith("/_apis/graph/users")) {
			const page = pageFor(userRequests++);
			return typeof page === "number" ? graphRes(page) : graphRes(200, { value: page.users }, page.continuation);
		}
		const descriptor = u.pathname.match(/\/_apis\/graph\/descriptors\/([^/]+)$/);
		if (descriptor) return graphRes(200, { value: descriptors[decodeURIComponent(descriptor[1])] ?? null });
		if (u.pathname.includes("/_apis/graph/memberships/")) return graphRes(200, { value: memberships });
		throw new Error(`unrouted ${u.pathname}`);
	};
	return { calls, fetchFn, userCalls: () => calls.filter((c) => c.path.endsWith("/_apis/graph/users")) };
}

const resolver = (fetchFn) => makeResolveAzureAuthority({ orgUrl: ORG, token: "pat", fetchFn });

// --- the paginated user list: the work-item path, and the defect it used to carry ---

test("an actor on the SECOND page is authorized, and the follow-up request carries the continuation token", async () => {
	// The whole defect in one fixture: with a single-page lookup this actor resolved to nobody, the gate
	// refused, and the receiver answered a determinate 204 -- so work-item triggers never fired for anyone
	// past the first page of the organisation's directory.
	const g = fakeGraph({
		pageFor: (i) =>
			i === 0
				? { users: [{ mailAddress: "someone@example.com", descriptor: "aad.someone" }], continuation: "PAGE-2-TOKEN" }
				: { users: [{ mailAddress: EMAIL, descriptor: ACTOR }], continuation: null },
	});
	// Mixed case on purpose: the address is matched case-insensitively, as it was before.
	assert.deepEqual(await resolver(g.fetchFn)(PROJECT, { email: "Dev@Example.COM" }), { authorized: true });
	const users = g.userCalls();
	assert.equal(users.length, 2, "the second page is fetched");
	assert.equal(users[0].continuationToken, null, "the first request carries no token -- identical to the single-page lookup");
	assert.equal(users[1].continuationToken, "PAGE-2-TOKEN", "the follow-up sends back exactly the token the response returned");
	assert.equal(users[1].subjectTypes, "aad,msa", "and nothing else about the request changes across pages");
	assert.ok(
		g.calls.some((c) => c.path.includes("/_apis/graph/memberships/")),
		"the descriptor found on page 2 is then used for the membership check",
	);
});

test("an actor on the FIRST page costs exactly one request -- nobody pays for pagination that was not needed", async () => {
	const g = fakeGraph({ pageFor: () => ({ users: [{ principalName: EMAIL, descriptor: ACTOR }], continuation: "MORE-PAGES-EXIST" }) });
	assert.deepEqual(await resolver(g.fetchFn)(PROJECT, { email: EMAIL }), { authorized: true });
	assert.equal(g.userCalls().length, 1, "the loop stops at the hit even though Azure offered another page");
});

test("an actor absent from a listing that ENDS is a determinate refusal", async () => {
	// A page with no continuation token means the whole directory was read. That is the one case where
	// "not found" is honest, so it stays `authorized: false` and the receiver keeps answering 204.
	const g = fakeGraph({
		pageFor: (i) => (i === 0 ? { users: [{ mailAddress: "a@example.com", descriptor: "aad.a" }], continuation: "PAGE-2-TOKEN" } : { users: [{ mailAddress: "b@example.com", descriptor: "aad.b" }], continuation: null }),
	});
	assert.deepEqual(await resolver(g.fetchFn)(PROJECT, { email: EMAIL }), { authorized: false });
	assert.equal(g.userCalls().length, 2, "both pages are read before refusing");
	assert.ok(
		!g.calls.some((c) => !c.path.endsWith("/_apis/graph/users")),
		"an unresolved actor short-circuits: no project descriptor and no membership lookup follow",
	);
});

test("a listing that keeps offering pages is INDETERMINATE at the cap, never a refusal", async () => {
	// The distinction this fix exists for: the search was abandoned, not completed. Answering `false` here
	// would bury an exhausted crawl inside a 204 that reads exactly like a stranger being turned away;
	// indeterminate makes the receiver answer 503, which Azure resends for about 3 minutes, then on probation.
	const g = fakeGraph({ pageFor: (i) => ({ users: [{ mailAddress: `nobody-${i}@example.com`, descriptor: `aad.n${i}` }], continuation: `TOKEN-${i + 1}` }) });
	const verdict = await resolver(g.fetchFn)(PROJECT, { email: EMAIL });
	assert.equal(verdict.authorized, undefined, "no boolean verdict is invented");
	assert.match(verdict.indeterminate, /azure users lookup did not reach the actor within 20 pages/);
	assert.equal(g.userCalls().length, 20, "bounded: one delivery can never turn into an unbounded directory crawl");
	assert.equal(g.userCalls().at(-1).continuationToken, "TOKEN-19", "each request carries the token from the page before it");
	assert.ok(!verdict.indeterminate.includes(EMAIL), "the address is personal data and never reaches a reason string");
});

test("a non-2xx MID-pagination is indeterminate, exactly as a first-page failure always was", async () => {
	const g = fakeGraph({ pageFor: (i) => (i === 0 ? { users: [], continuation: "PAGE-2-TOKEN" } : 500) });
	const verdict = await resolver(g.fetchFn)(PROJECT, { email: EMAIL });
	assert.deepEqual(verdict, { indeterminate: "azure lookup returned 500" });
	assert.equal(g.userCalls().length, 2, "the failure stops the walk where it happened");
});

test("a page in an unrecognised shape is indeterminate, not an empty page to keep walking past", async () => {
	const g = fakeGraph({ pageFor: () => ({ users: undefined, continuation: "PAGE-2-TOKEN" }) });
	assert.deepEqual(await resolver(g.fetchFn)(PROJECT, { email: EMAIL }), { indeterminate: "azure users lookup returned no array" });
	assert.equal(g.userCalls().length, 1);
});

// --- the pull-request path, which never paginated and must not start ---

test("an actor named by GUID takes the direct descriptor lookup and never lists users", async () => {
	const g = fakeGraph({ descriptors: { [PROJECT]: CONTAINER, "actor-guid": ACTOR } });
	assert.deepEqual(await resolver(g.fetchFn)(PROJECT, { id: "actor-guid" }), { authorized: true });
	assert.equal(g.userCalls().length, 0, "a PR payload carries a GUID -- the paginated list is not involved");
});

test("a GUID that resolves to no descriptor is a determinate refusal", async () => {
	const g = fakeGraph({ descriptors: { [PROJECT]: CONTAINER } });
	assert.deepEqual(await resolver(g.fetchFn)(PROJECT, { id: "stranger-guid" }), { authorized: false });
});

test("a member of no project container is refused; a missing project descriptor is indeterminate", async () => {
	const notAMember = fakeGraph({ descriptors: { [PROJECT]: CONTAINER, "actor-guid": ACTOR }, memberships: [{ containerDescriptor: "vssgp.other-project" }] });
	assert.deepEqual(await resolver(notAMember.fetchFn)(PROJECT, { id: "actor-guid" }), { authorized: false });

	// A 200 whose shape we do not recognise must not turn an upstream change into a permanent refusal.
	const noProject = fakeGraph({ descriptors: { "actor-guid": ACTOR } });
	assert.deepEqual(await resolver(noProject.fetchFn)(PROJECT, { id: "actor-guid" }), { indeterminate: "azure project descriptor lookup returned no descriptor" });
});

test("an actor the delivery never named, and a payload with no project, are both determinate refusals", async () => {
	const g = fakeGraph();
	assert.deepEqual(await resolver(g.fetchFn)(PROJECT, {}), { authorized: false });
	assert.deepEqual(await resolver(g.fetchFn)("", { email: EMAIL }), { authorized: false });
	assert.equal(g.calls.length, 0, "neither case asks Azure anything");
});
