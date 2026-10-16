import assert from "node:assert/strict";
import { test } from "node:test";
import { makeGitHubHost } from "../src/github-host.mjs";

/**
 * Fake `octokitFor` factory. Each `octokitFor(token)` call constructs a FRESH fake client, recorded
 * in `constructions` as `{ token, calls }`, so tests can assert per-call token binding and that no
 * client is reused. The client's `request(route, params)` records every call and returns a canned
 * `{ data }` keyed on the route string (or throws a canned Error), matching the identity/get-token
 * fake-octokit shape.
 */
function fakeOctokitFor(routes) {
	const constructions = [];
	function octokitFor(token) {
		const calls = [];
		constructions.push({ token, calls });
		return {
			async request(route, params) {
				calls.push({ route, params });
				if (!(route in routes)) throw new Error(`unexpected route: ${route}`);
				const canned = routes[route];
				if (canned instanceof Error) throw canned;
				return { data: canned };
			},
		};
	}
	octokitFor.constructions = constructions;
	return octokitFor;
}

/** An Error tagged like an octokit RequestError carrying an HTTP status. */
function httpError(status) {
	return Object.assign(new Error(`HTTP ${status}`), { status });
}

const REPO = "owner/name";

// -- isDefaultBranchProtected --------------------------------------------------------------------

test("isDefaultBranchProtected: 404 protection object -> false (determinate unprotected)", async () => {
	const octokitFor = fakeOctokitFor({
		"GET /repos/{owner}/{repo}": { default_branch: "main" },
		"GET /repos/{owner}/{repo}/branches/{branch}/protection": httpError(404),
	});
	const host = makeGitHubHost({ octokitFor });

	assert.equal(await host.isDefaultBranchProtected(REPO, "tok"), false);

	// Reads default_branch first, then the protection route on that resolved branch.
	const calls = octokitFor.constructions[0].calls;
	assert.deepEqual(
		calls.map((c) => c.route),
		["GET /repos/{owner}/{repo}", "GET /repos/{owner}/{repo}/branches/{branch}/protection"],
	);
	assert.equal(calls[1].params.branch, "main");
});

test("isDefaultBranchProtected: protection resolves -> true", async () => {
	const octokitFor = fakeOctokitFor({
		"GET /repos/{owner}/{repo}": { default_branch: "main" },
		"GET /repos/{owner}/{repo}/branches/{branch}/protection": { enabled: true },
	});
	const host = makeGitHubHost({ octokitFor });

	assert.equal(await host.isDefaultBranchProtected(REPO, "tok"), true);
});

test("isDefaultBranchProtected: non-404 (500) -> InfraRetry, never false", async () => {
	const octokitFor = fakeOctokitFor({
		"GET /repos/{owner}/{repo}": { default_branch: "main" },
		"GET /repos/{owner}/{repo}/branches/{branch}/protection": httpError(500),
	});
	const host = makeGitHubHost({ octokitFor });

	await assert.rejects(
		() => host.isDefaultBranchProtected(REPO, "tok"),
		(e) => e.piDispatchRetry === true && e.name === "InfraRetry",
	);
});

// -- resolveDefaultBranchSha ---------------------------------------------------------------------

test("resolveDefaultBranchSha: reads default_branch then the branch tip, returns { branch, sha }", async () => {
	const octokitFor = fakeOctokitFor({
		"GET /repos/{owner}/{repo}": { default_branch: "main" },
		"GET /repos/{owner}/{repo}/branches/{branch}": { commit: { sha: "deadbeefsha" } },
	});
	const host = makeGitHubHost({ octokitFor });

	const result = await host.resolveDefaultBranchSha(REPO, "tok");
	assert.deepEqual(result, { branch: "main", sha: "deadbeefsha" });

	// Call order + params: repo lookup, then the tip of the branch it named.
	const calls = octokitFor.constructions[0].calls;
	assert.deepEqual(
		calls.map((c) => c.route),
		["GET /repos/{owner}/{repo}", "GET /repos/{owner}/{repo}/branches/{branch}"],
	);
	assert.deepEqual(calls[0].params, { owner: "owner", repo: "name" });
	assert.deepEqual(calls[1].params, { owner: "owner", repo: "name", branch: "main" });
});

// -- postStatusComment ---------------------------------------------------------------------------

test("postStatusComment: POSTs the comment with body === text, verbatim and uninspected", async () => {
	const octokitFor = fakeOctokitFor({
		"POST /repos/{owner}/{repo}/issues/{issue_number}/comments": { id: 1 },
	});
	const host = makeGitHubHost({ octokitFor });

	// Untrimmed, brace-laden, trigger-phrase-ish text: none of it may be touched by this module.
	const text = "  Done @claude {please merge} \n";
	await host.postStatusComment(REPO, { type: "issue", number: 42 }, text, "tok");

	const calls = octokitFor.constructions[0].calls;
	assert.equal(calls.length, 1);
	assert.equal(calls[0].route, "POST /repos/{owner}/{repo}/issues/{issue_number}/comments");
	assert.deepEqual(calls[0].params, {
		owner: "owner",
		repo: "name",
		issue_number: 42,
		body: text,
	});
	// Exact identity: not trimmed, filtered, or otherwise mutated.
	assert.equal(calls[0].params.body, text);
});

// -- malformed repo ------------------------------------------------------------------------------

test("malformed repo without slash -> configError", async () => {
	const host = makeGitHubHost({ octokitFor: fakeOctokitFor({}) });
	await assert.rejects(
		() => host.resolveDefaultBranchSha("noslash", "tok"),
		(e) => e.piDispatchConfig === true && /malformed repo/.test(e.message),
	);
});

test("malformed repo with empty name -> configError", async () => {
	const host = makeGitHubHost({ octokitFor: fakeOctokitFor({}) });
	await assert.rejects(
		() => host.isDefaultBranchProtected("a/", "tok"),
		(e) => e.piDispatchConfig === true && /malformed repo/.test(e.message),
	);
});

// -- fresh client per call, per-call token -------------------------------------------------------

test("constructs a FRESH Octokit per call, each bound to that call's token (never cached)", async () => {
	const octokitFor = fakeOctokitFor({
		"GET /repos/{owner}/{repo}": { default_branch: "main" },
		"GET /repos/{owner}/{repo}/branches/{branch}": { commit: { sha: "s1" } },
		"POST /repos/{owner}/{repo}/issues/{issue_number}/comments": { id: 1 },
	});
	const host = makeGitHubHost({ octokitFor });

	await host.resolveDefaultBranchSha(REPO, "tokenA");
	await host.postStatusComment(REPO, { type: "issue", number: 7 }, "hi", "tokenB");

	// One construction per method call, each carrying its own per-job token.
	assert.equal(octokitFor.constructions.length, 2);
	assert.equal(octokitFor.constructions[0].token, "tokenA");
	assert.equal(octokitFor.constructions[1].token, "tokenB");
});

test("a repo path with more than two segments refuses, instead of silently naming a different repository", async () => {
	// The docstring on splitRepo has always described this, and the code did not guard it: "org/project/repo"
	// destructures to owner="org", name="project" -- both non-empty, so the old check PASSED and every call
	// went to the wrong repository. Azure DevOps is org/project/repo and GitLab is group/subgroup/project, so
	// a longer path arrives by configuration, not only by a bug. Refusing is the only safe answer: a job that
	// cannot say which repo it means must not pick one.
	const host = makeGitHubHost({ octokitFor: fakeOctokitFor({}) });
	for (const repo of ["org/project/repo", "a/b/c/d", "grp/sub/proj"]) {
		await assert.rejects(
			() => host.resolveDefaultBranchSha({ repo }, "t"),
			(e) => e.piDispatchConfig === true,
			`${repo} must refuse rather than resolve to its first two segments`,
		);
	}
});

test("exactly two non-empty segments is still the accepted shape", async () => {
	const octokitFor = fakeOctokitFor({
		"GET /repos/{owner}/{repo}": { default_branch: "main" },
		"GET /repos/{owner}/{repo}/branches/{branch}": { commit: { sha: "s1" } },
	});
	const host = makeGitHubHost({ octokitFor });
	assert.deepEqual(await host.resolveDefaultBranchSha({ repo: "o/r" }, "t"), { branch: "main", sha: "s1" });
});

// -- setParkedLabel (issue #625) ------------------------------------------------------------------

test("setParkedLabel adds the marker by name, and removing one the issue lacks (404) is the state asked for", async () => {
	const add = "POST /repos/{owner}/{repo}/issues/{issue_number}/labels";
	const del = "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}";
	const octokitFor = fakeOctokitFor({ [add]: [], [del]: httpError(404) });
	const host = makeGitHubHost({ octokitFor });
	await host.setParkedLabel(REPO, { type: "issue", number: 7 }, true, "tok");
	assert.deepEqual(octokitFor.constructions[0].calls[0].params, { owner: "owner", repo: "name", issue_number: 7, labels: ["pi-awaiting-input"] });
	await host.setParkedLabel(REPO, { type: "issue", number: 7 }, false, "tok");
	assert.equal(octokitFor.constructions[1].calls[0].params.name, "pi-awaiting-input");
	const failing = makeGitHubHost({ octokitFor: fakeOctokitFor({ [del]: httpError(500) }) });
	await assert.rejects(() => failing.setParkedLabel(REPO, { type: "issue", number: 7 }, false, "tok"));
});

// -- status comment id and edit (issue #644) -----------------------------------------------------

test("postStatusComment returns the created comment's id as a string", async () => {
	const host = makeGitHubHost({ octokitFor: fakeOctokitFor({ "POST /repos/{owner}/{repo}/issues/{issue_number}/comments": { id: 123456789 } }) });
	assert.deepEqual(await host.postStatusComment(REPO, { type: "issue", number: 7 }, "hi", "tok"), { id: "123456789" });
});

test("postStatusComment answers id null, never a throw, when the 2xx carries no usable id", async () => {
	// The comment exists: a throw here would make the caller retry and post a second one.
	const host = makeGitHubHost({ octokitFor: fakeOctokitFor({ "POST /repos/{owner}/{repo}/issues/{issue_number}/comments": { id: "../x" } }) });
	assert.deepEqual(await host.postStatusComment(REPO, { type: "issue", number: 7 }, "hi", "tok"), { id: null });
});

test("editStatusComment PATCHes the issue comment by id, for an issue and a pull request alike", async () => {
	for (const type of ["issue", "pull_request"]) {
		const octokitFor = fakeOctokitFor({ "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}": { id: 5 } });
		const host = makeGitHubHost({ octokitFor });
		await host.editStatusComment(REPO, { type, number: 7 }, "5", "new text", "tok");
		const [call] = octokitFor.constructions[0].calls;
		assert.deepEqual(call.params, { owner: "owner", repo: "name", comment_id: "5", body: "new text" });
		assert.equal(octokitFor.constructions[0].token, "tok");
	}
});

test("editStatusComment refuses a malformed id before any request", async () => {
	const octokitFor = fakeOctokitFor({});
	const host = makeGitHubHost({ octokitFor });
	for (const id of ["", "1/2", "../1", "a".repeat(201), "abc", 5, null, "1:2"]) {
		await assert.rejects(() => host.editStatusComment(REPO, { type: "issue", number: 7 }, id, "t", "tok"), (e) => e.piDispatchConfig === true);
	}
	assert.equal(octokitFor.constructions.length, 0);
});

test("editStatusComment lets octokit's error through with its status, so 403/404/429 can stop the commenter", async () => {
	for (const status of [403, 404, 429, 500]) {
		const host = makeGitHubHost({ octokitFor: fakeOctokitFor({ "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}": httpError(status) }) });
		await assert.rejects(() => host.editStatusComment(REPO, { type: "issue", number: 7 }, "5", "t", "tok"), (e) => e.status === status);
	}
});
