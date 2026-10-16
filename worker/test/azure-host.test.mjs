import assert from "node:assert/strict";
import { test } from "node:test";
import { azureRemoteUrl, makeAzureHost, policyProtects, stripRefsHeads } from "../src/azure-host.mjs";

const JOB = { repo: "Fabrikam/widgets", azure: { project: "Fabrikam", repository: "widgets", repositoryId: "repo-guid" } };
const ORG = "https://dev.azure.com/contoso";

/** A path -> response map that THROWS on an unrouted call, so a wrong endpoint is a failure, not a miss. */
function fakeFetch(routes) {
	const fn = async (url, init = {}) => {
		// The org URL carries a PATH segment (`/contoso`), unlike every other forge's instance root, so the
		// whole root is stripped rather than just the host.
		const path = String(url).replace(ORG, "");
		const key = `${init.method ?? "GET"} ${path.split("?")[0]}`;
		fn.calls.push({ key, url: String(url), init });
		if (!Object.hasOwn(routes, key)) throw new Error(`unrouted ${key}`);
		const r = routes[key];
		if (typeof r === "number") return { ok: r >= 200 && r < 300, status: r, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => r };
	};
	fn.calls = [];
	return fn;
}

const REPO_ROUTE = "GET /Fabrikam/_apis/git/repositories/repo-guid";
const REPO_BODY = { id: "repo-guid", name: "widgets", defaultBranch: "refs/heads/main" };

// --- branch policies: the fail-open this host exists to avoid ---

test("a BLOCKING enabled policy on the exact ref protects it", () => {
	const policy = { isEnabled: true, isBlocking: true, settings: { scope: [{ refName: "refs/heads/main", matchKind: "Exact", repositoryId: null }] } };
	assert.equal(policyProtects(policy, "main", "repo-guid"), true);
});

test("an ADVISORY policy does not protect -- isEnabled alone would report a branch protected that is not", () => {
	// A policy that is enabled but not blocking does not stop a push. Reading only isEnabled is the
	// cheapest possible mistake here and it disarms the backstop while looking correct.
	const policy = { isEnabled: true, isBlocking: false, settings: { scope: [{ refName: "refs/heads/main", matchKind: "Exact" }] } };
	assert.equal(policyProtects(policy, "main", "repo-guid"), false);
	assert.equal(policyProtects({ ...policy, isEnabled: false, isBlocking: true }, "main", "repo-guid"), false);
});

test("a PREFIX policy protects a branch it does not name -- the Azure-shaped fail-open", () => {
	// `refs/heads/releases/` with matchKind Prefix covers `refs/heads/releases/1.0`. Comparing refName for
	// equality reports that branch unprotected: the same class of error as carrying GitHub's 404 rule to
	// Forgejo, arrived at from a different direction.
	const policy = { isEnabled: true, isBlocking: true, settings: { scope: [{ refName: "refs/heads/releases/", matchKind: "Prefix" }] } };
	assert.equal(policyProtects(policy, "releases/1.0", "repo-guid"), true);
	assert.equal(policyProtects(policy, "main", "repo-guid"), false);
});

test("a scope with repositoryId null applies to EVERY repository in the project", () => {
	// This is how most default-branch policies are actually written. Requiring a repository match would
	// miss all of them and report every branch unprotected.
	const policy = { isEnabled: true, isBlocking: true, settings: { scope: [{ refName: "refs/heads/main", matchKind: "Exact", repositoryId: null }] } };
	assert.equal(policyProtects(policy, "main", "some-other-repo"), true);
});

test("a scope naming a DIFFERENT repository does not protect this one", () => {
	const policy = { isEnabled: true, isBlocking: true, settings: { scope: [{ refName: "refs/heads/main", matchKind: "Exact", repositoryId: "other-repo" }] } };
	assert.equal(policyProtects(policy, "main", "repo-guid"), false);
});

test("a malformed policy protects nothing rather than throwing on the money path", () => {
	for (const policy of [null, {}, { isEnabled: true, isBlocking: true }, { isEnabled: true, isBlocking: true, settings: { scope: "no" } }]) {
		assert.equal(policyProtects(policy, "main", "repo-guid"), false, JSON.stringify(policy));
	}
});

test("isDefaultBranchProtected asks the git policy endpoint, not the legacy one", () => {
	// Microsoft's own reference says the plain /_apis/policy/configurations `scope` parameter is legacy and
	// "does not support hierarchical nesting" -- which is exactly the nesting a Prefix rule relies on.
	const fetchFn = fakeFetch({
		[REPO_ROUTE]: REPO_BODY,
		"GET /Fabrikam/_apis/git/policy/configurations": { value: [{ isEnabled: true, isBlocking: true, settings: { scope: [{ refName: "refs/heads/main", matchKind: "Exact" }] } }] },
	});
	const host = makeAzureHost({ orgUrl: ORG, fetchFn });
	return host.isDefaultBranchProtected(JOB, "t").then((r) => {
		assert.equal(r, true);
		assert.ok(fetchFn.calls.some((c) => c.url.includes("refName=refs%2Fheads%2Fmain")), "the ref is passed fully qualified, as Azure's scopes are");
	});
});

test("a non-2xx from the policy endpoint is retryable, NEVER false", async () => {
	// A token that cannot read policies returns 401/403. Collapsing that into "unprotected" turns a
	// permissions mistake into a silently disarmed backstop.
	for (const status of [401, 403, 429, 500]) {
		const host = makeAzureHost({ orgUrl: ORG, fetchFn: fakeFetch({ [REPO_ROUTE]: REPO_BODY, "GET /Fabrikam/_apis/git/policy/configurations": status }) });
		await assert.rejects(() => host.isDefaultBranchProtected(JOB, "t"), `${status} must not read as unprotected`);
	}
});

// --- the rest of the host surface ---

test("resolveDefaultBranchSha strips refs/heads and reads the tip from branch stats", async () => {
	const host = makeAzureHost({
		orgUrl: ORG,
		fetchFn: fakeFetch({
			[REPO_ROUTE]: REPO_BODY,
			"GET /Fabrikam/_apis/git/repositories/repo-guid/stats/branches": { commit: { commitId: "abc123" } },
		}),
	});
	assert.deepEqual(await host.resolveDefaultBranchSha(JOB, "t"), { branch: "main", sha: "abc123" });
});

test("a pull request comment is a THREAD, and a work item comment is not -- two APIs, two body shapes", async () => {
	const prFetch = fakeFetch({ [REPO_ROUTE]: REPO_BODY, "POST /Fabrikam/_apis/git/repositories/repo-guid/pullRequests/12/threads": { id: 1 } });
	await makeAzureHost({ orgUrl: ORG, fetchFn: prFetch }).postStatusComment(JOB, { type: "pull_request", number: 12 }, "hi", "t");
	const thread = JSON.parse(prFetch.calls.at(-1).init.body);
	assert.equal(thread.comments[0].content, "hi", "Azure has no bare comment on a pull request -- every one lives in a thread");

	const wiFetch = fakeFetch({ "POST /Fabrikam/_apis/wit/workItems/7/comments": { id: 1 } });
	await makeAzureHost({ orgUrl: ORG, fetchFn: wiFetch }).postStatusComment(JOB, { type: "issue", number: 7 }, "hi", "t");
	assert.equal(JSON.parse(wiFetch.calls.at(-1).init.body).text, "hi");
	assert.ok(wiFetch.calls.at(-1).url.includes("api-version=7.1-preview.4"), "the preview api-version is pinned, not floated");
});

test("a fork pull request reports no head repo, which is what makes session-key refuse it", async () => {
	const host = (pr) =>
		makeAzureHost({
			orgUrl: ORG,
			fetchFn: fakeFetch({ [REPO_ROUTE]: REPO_BODY, "GET /Fabrikam/_apis/git/repositories/repo-guid/pullrequests/12": pr }),
		});
	const forked = await host({ sourceRefName: "refs/heads/pi/issue-7", forkSource: { repository: { id: "other" } } }).resolvePullRequestHead({ ...JOB, target: { number: 12 } }, "t");
	assert.equal(forked.headRepo, null, "a fork must resolve no session");
	const own = await host({ sourceRefName: "refs/heads/pi/issue-7", repository: { id: "repo-guid" } }).resolvePullRequestHead({ ...JOB, target: { number: 12 } }, "t");
	assert.deepEqual(own, { headRef: "pi/issue-7", headRepo: "Fabrikam/widgets" });
});

test("a job with no azure scope refuses rather than guessing a project", async () => {
	const host = makeAzureHost({ orgUrl: ORG, fetchFn: fakeFetch({}) });
	await assert.rejects(() => host.resolveDefaultBranchSha({ repo: "Fabrikam/widgets" }, "t"), (e) => e.piDispatchConfig === true);
});

test("the clone URL is Azure's _git form, built from the scope and never from the repo label", () => {
	// The label is `project/repo`; the URL is `<org>/<project>/_git/<repo>`. Reassembling one from the
	// other is how the wrong repository gets cloned.
	assert.equal(azureRemoteUrl(ORG, JOB), "https://dev.azure.com/contoso/Fabrikam/_git/widgets");
	assert.throws(() => azureRemoteUrl(null, JOB), (e) => e.piDispatchConfig === true);
	assert.throws(() => azureRemoteUrl(ORG, { repo: "Fabrikam/widgets" }), (e) => e.piDispatchConfig === true);
});

test("stripRefsHeads is idempotent and total", () => {
	assert.equal(stripRefsHeads("refs/heads/main"), "main");
	assert.equal(stripRefsHeads("main"), "main");
	assert.equal(stripRefsHeads(undefined), undefined);
});

// -- setParkedLabel (issue #625) ------------------------------------------------------------------

test("setParkedLabel rewrites the work item's tags whole: adds the marker beside the rest, and removes only it", async () => {
	const item = "/Fabrikam/_apis/wit/workitems/7";
	const fetchFn = fakeFetch({ [`GET ${item}`]: { fields: { "System.Tags": "triaged; pi-awaiting-input" } }, [`PATCH ${item}`]: {} });
	const host = makeAzureHost({ orgUrl: ORG, fetchFn });
	await host.setParkedLabel(JOB, { type: "issue", number: 7 }, true, "tok");
	await host.setParkedLabel(JOB, { type: "issue", number: 7 }, false, "tok");
	const patches = fetchFn.calls.filter((c) => c.key.startsWith("PATCH"));
	assert.deepEqual(patches.map((c) => JSON.parse(c.init.body)[0].value), ["triaged; pi-awaiting-input", "triaged"], "never a second copy, never another tag lost");
	assert.equal(patches[0].init.headers["content-type"], "application/json-patch+json");
});

// --- status comment id and edit (issue #644) ---

const THREAD_ROUTE = "POST /Fabrikam/_apis/git/repositories/repo-guid/pullRequests/12/threads";

test("postStatusComment returns <thread>:<comment> for a pull request and wi:<comment> for a work item", async () => {
	const pr = makeAzureHost({ orgUrl: ORG, fetchFn: fakeFetch({ [REPO_ROUTE]: REPO_BODY, [THREAD_ROUTE]: { id: 88, comments: [{ id: 1 }] } }) });
	assert.deepEqual(await pr.postStatusComment(JOB, { type: "pull_request", number: 12 }, "hi", "t"), { id: "88:1" });
	const wi = makeAzureHost({ orgUrl: ORG, fetchFn: fakeFetch({ "POST /Fabrikam/_apis/wit/workItems/7/comments": { id: 4021, workItemId: 7 } }) });
	assert.deepEqual(await wi.postStatusComment(JOB, { type: "issue", number: 7 }, "hi", "t"), { id: "wi:4021" });
	const bare = makeAzureHost({ orgUrl: ORG, fetchFn: fakeFetch({ [REPO_ROUTE]: REPO_BODY, [THREAD_ROUTE]: { id: 88 } }) });
	assert.deepEqual(await bare.postStatusComment(JOB, { type: "pull_request", number: 12 }, "hi", "t"), { id: null }, "a thread with no comment id is no id, never half of one");
});

test("editStatusComment PATCHes the thread comment with content, on the stable api-version", async () => {
	const fetchFn = fakeFetch({ [REPO_ROUTE]: REPO_BODY, "PATCH /Fabrikam/_apis/git/repositories/repo-guid/pullRequests/12/threads/88/comments/1": { id: 1 } });
	await makeAzureHost({ orgUrl: ORG, fetchFn }).editStatusComment(JOB, { type: "pull_request", number: 12 }, "88:1", "new", "t");
	const call = fetchFn.calls.at(-1);
	assert.deepEqual(JSON.parse(call.init.body), { content: "new" });
	assert.ok(call.url.endsWith("?api-version=7.1"));
	assert.equal(call.init.headers.Authorization, `Basic ${Buffer.from(":t").toString("base64")}`);
	assert.equal(call.init.redirect, "error");
});

test("editStatusComment PATCHes the work item comment with text, on the pinned preview api-version", async () => {
	const fetchFn = fakeFetch({ "PATCH /Fabrikam/_apis/wit/workItems/7/comments/4021": { id: 4021 } });
	await makeAzureHost({ orgUrl: ORG, fetchFn }).editStatusComment(JOB, { type: "issue", number: 7 }, "wi:4021", "new", "t");
	const call = fetchFn.calls.at(-1);
	assert.deepEqual(JSON.parse(call.init.body), { text: "new" });
	assert.ok(call.url.endsWith("?api-version=7.1-preview.4"));
});

test("editStatusComment refuses a malformed id, or one whose form disagrees with the target, before any request", async () => {
	const fetchFn = fakeFetch({});
	const host = makeAzureHost({ orgUrl: ORG, fetchFn });
	const cases = [
		["pull_request", "wi:4021"],
		["issue", "88:1"],
		["pull_request", "88"],
		["pull_request", "88:1:2"],
		["issue", "wi:"],
		["issue", "wi:1/2"],
		["issue", `wi:${"1".repeat(200)}`],
		["issue", 4021],
	];
	for (const [type, id] of cases) {
		await assert.rejects(() => host.editStatusComment(JOB, { type, number: 7 }, id, "t", "t"), (e) => e.piDispatchConfig === true, `${type} ${id}`);
	}
	assert.equal(fetchFn.calls.length, 0);
});

test("a failed edit throws with the HTTP status set", async () => {
	for (const status of [403, 404, 429, 503]) {
		const host = makeAzureHost({ orgUrl: ORG, fetchFn: fakeFetch({ "PATCH /Fabrikam/_apis/wit/workItems/7/comments/4021": status }) });
		await assert.rejects(() => host.editStatusComment(JOB, { type: "issue", number: 7 }, "wi:4021", "t", "t"), (e) => e.status === status && e.piDispatchRetry === true);
	}
});
