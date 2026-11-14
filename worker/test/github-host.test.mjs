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
				// A function answers per call (a paged read); anything else is the answer every time.
				const canned = typeof routes[route] === "function" ? routes[route](params) : routes[route];
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

const REPO_ROUTE = "GET /repos/{owner}/{repo}";
const BRANCH_ROUTE = "GET /repos/{owner}/{repo}/branches/{branch}";
const RULES_ROUTE = "GET /repos/{owner}/{repo}/rules/branches/{branch}";
/** A branch answer: `protected`, and a classic rule (`protection.enabled`) when `classic`. */
const branchBody = (isProtected, classic = false) => ({ name: "main", commit: { sha: "abc" }, protected: isProtected, protection: { enabled: classic } });
/** One rule as GitHub's branch rules read answers it. */
const rule = (type, parameters) => ({ type, ruleset_source_type: "Organization", ruleset_source: "octo", ruleset_id: 7, ...(parameters ? { parameters } : {}) });
const pullRequestRule = (count) => rule("pull_request", { required_approving_review_count: count, dismiss_stale_reviews_on_push: false });
/** The host over a fake whose reads answer `branch` and `rules` (a canned body, a function of the params, or an Error). */
function hostAnswering({ repoAnswer = { default_branch: "main" }, branch = branchBody(true, true), rules } = {}) {
	const octokitFor = fakeOctokitFor({ [REPO_ROUTE]: repoAnswer, [BRANCH_ROUTE]: branch, ...(rules === undefined ? {} : { [RULES_ROUTE]: rules }) });
	return { host: makeGitHubHost({ octokitFor }), octokitFor, routes: () => octokitFor.constructions.flatMap((c) => c.calls.map((call) => call.route)) };
}

test("isDefaultBranchProtected: a classic rule admits the branch from the branch read alone, as the old check did (issue #876)", async () => {
	const octokitFor = fakeOctokitFor({ [REPO_ROUTE]: { default_branch: "trunk" }, [BRANCH_ROUTE]: branchBody(true, true) });
	assert.equal(await makeGitHubHost({ octokitFor }).isDefaultBranchProtected(REPO, "tok"), true);
	const calls = octokitFor.constructions[0].calls;
	assert.deepEqual(calls.map((c) => c.route), [REPO_ROUTE, BRANCH_ROUTE], "no rules read, and never the protection endpoint, which needs Administration: read");
	assert.deepEqual(calls[1].params, { owner: "owner", repo: "name", branch: "trunk" });
	assert.equal(octokitFor.constructions.length, 1, "one client, for this token");
});

test("isDefaultBranchProtected: protected false refuses from the branch read alone", async () => {
	const { host, routes } = hostAnswering({ branch: branchBody(false) });
	assert.equal(await host.isDefaultBranchProtected(REPO, "tok"), false);
	assert.deepEqual(routes(), [REPO_ROUTE, BRANCH_ROUTE]);
});

test("isDefaultBranchProtected: a ruleset that blocks nothing does not protect -- protected: true from copilot_code_review alone refuses (issue #876)", async () => {
	// Measured read-only on 2026-11-14: github/scientist@main answers protected: true, protection.enabled: false, and
	// these two organization rules are all it has. Read as protected, every repository of such an organization would
	// pass while nothing stopped the job's token pushing to the default branch.
	const { host, routes, octokitFor } = hostAnswering({ branch: branchBody(true, false), rules: [rule("copilot_code_review", { review_on_push: false }), rule("license_compliance_scanning")] });
	assert.equal(await host.isDefaultBranchProtected(REPO, "tok"), false);
	assert.deepEqual(routes(), [REPO_ROUTE, BRANCH_ROUTE, RULES_ROUTE]);
	assert.deepEqual(octokitFor.constructions[0].calls[2].params, { owner: "owner", repo: "name", branch: "main", per_page: 100, page: 1 });
});

test("isDefaultBranchProtected: a ruleset's pull_request rule protects only when it requires an approval (issue #876)", async () => {
	for (const [rules, expected, why] of [
		[[pullRequestRule(1)], true, "one approval"],
		[[rule("deletion"), pullRequestRule(2)], true, "two approvals beside another rule"],
		[[pullRequestRule(0), pullRequestRule(0), pullRequestRule(1)], true, "rulesets aggregate: the strictest pull_request rule counts"],
		[[pullRequestRule(0)], false, "no approval: the agent could open and merge its own pull request"],
		[[rule("deletion"), rule("non_fast_forward"), rule("required_linear_history")], false, "rules that stop no push of a new commit"],
		[[rule("pull_request")], false, "no parameters"],
		[[pullRequestRule("1")], false, "a count that is not an integer"],
		[[], false, "no active rule (an evaluated or disabled ruleset is not returned)"],
	]) {
		const { host } = hostAnswering({ branch: branchBody(true, false), rules });
		assert.equal(await host.isDefaultBranchProtected(REPO, "tok"), expected, why);
	}
});

test("isDefaultBranchProtected: the rules read is paged, stops at the first qualifying rule, and retries past its cap (issue #876)", async () => {
	const full = Array.from({ length: 100 }, () => rule("deletion"));
	const asked = [];
	const { host } = hostAnswering({ branch: branchBody(true, false), rules: (params) => (asked.push(params.page), params.page === 1 ? full : params.page === 2 ? [pullRequestRule(1)] : new Error("read past the answer")) });
	assert.equal(await host.isDefaultBranchProtected(REPO, "tok"), true, "a qualifying rule on the second page");
	assert.deepEqual(asked, [1, 2]);

	const { host: shortSecond } = hostAnswering({ branch: branchBody(true, false), rules: (params) => (params.page === 1 ? full : [rule("deletion")]) });
	assert.equal(await shortSecond.isDefaultBranchProtected(REPO, "tok"), false, "a short page is the last");

	const pages = [];
	const { host: endless } = hostAnswering({ branch: branchBody(true, false), rules: (params) => (pages.push(params.page), full) });
	await assert.rejects(() => endless.isDefaultBranchProtected(REPO, "tok"), (e) => e.piDispatchRetry === true && /more than 1000 active rules/.test(e.message));
	assert.equal(pages.length, 10, "bounded");
});

test("isDefaultBranchProtected: an empty repository's missing default branch is unprotected, determinately (issue #876)", async () => {
	// GitHub answers an empty repository's default branch 404 "Branch not found". The repository read just succeeded,
	// so this is no blind token; the protection endpoint's 404 refused it as unprotected-branch before #876 too.
	const { host, routes } = hostAnswering({ branch: Object.assign(httpError(404), { message: "Branch not found" }) });
	assert.equal(await host.isDefaultBranchProtected(REPO, "tok"), false);
	assert.deepEqual(routes(), [REPO_ROUTE, BRANCH_ROUTE]);
});

test("isDefaultBranchProtected: an answer of the wrong shape is retried, never read as unprotected (issue #876)", async () => {
	for (const body of [{ name: "main" }, { name: "main", protected: null }, { name: "main", protected: "false" }, { name: "main", protected: 0 }, null]) {
		await assert.rejects(
			() => hostAnswering({ branch: body }).host.isDefaultBranchProtected(REPO, "tok"),
			(e) => e.piDispatchRetry === true && e.name === "InfraRetry" && /without a boolean protected/.test(e.message),
			JSON.stringify(body),
		);
	}
	for (const rules of [{ rules: [] }, null, "pull_request"]) {
		await assert.rejects(
			() => hostAnswering({ branch: branchBody(true, false), rules }).host.isDefaultBranchProtected(REPO, "tok"),
			(e) => e.piDispatchRetry === true && /without a list/.test(e.message),
			JSON.stringify(rules),
		);
	}
	for (const repoAnswer of [{}, { default_branch: "" }, { default_branch: 7 }]) {
		await assert.rejects(
			() => hostAnswering({ repoAnswer }).host.isDefaultBranchProtected(REPO, "tok"),
			(e) => e.piDispatchRetry === true && /no default branch/.test(e.message),
			JSON.stringify(repoAnswer),
		);
	}
});

/** A 403 as octokit builds one: `HttpError`, a status, GitHub's message, and the response's headers. */
function forbidden(message, headers = { "content-type": "application/json; charset=utf-8" }) {
	return Object.assign(new Error(message), { name: "HttpError", status: 403, response: { headers } });
}
/** The same answer placed at each of the three reads in turn. */
const atEachRead = (answer) => [
	hostAnswering({ repoAnswer: answer }).host,
	hostAnswering({ branch: answer }).host,
	hostAnswering({ branch: branchBody(true, false), rules: answer }).host,
];

test("isDefaultBranchProtected: a 403 that is no rate limit refuses determinately as branch-protection-unreadable, at any of the three reads (issue #876)", async () => {
	// GitHub's answer to a token that may not make the read: a fine-grained token without access to the repository's
	// contents, a token not authorized for an organization's single sign-on. Each is the same on every retry.
	for (const answer of [
		forbidden("Resource not accessible by personal access token"),
		forbidden("Resource not accessible by integration"),
		forbidden("Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization."),
		forbidden("Resource not accessible by integration", {}),
		httpError(403),
	]) {
		for (const host of atEachRead(answer)) {
			await assert.rejects(
				() => host.isDefaultBranchProtected(REPO, "tok"),
				(e) => {
					assert.equal(e.piDispatchConfig, true, "determinate: not retried");
					assert.notEqual(e.name, "InfraRetry");
					assert.equal(e.reason, "branch-protection-unreadable");
					assert.equal(e.cause, answer, "GitHub's error rides as the cause, for a request id");
					return true;
				},
				answer.message,
			);
		}
	}
});

test("isDefaultBranchProtected: a rate-limited 403 is retried at any of the three reads, by every signal transient.mjs reads (issue #876)", async () => {
	for (const answer of [
		forbidden("API rate limit exceeded for installation", { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1999999999" }),
		forbidden("You have exceeded a secondary rate limit", { "content-type": "application/json", "retry-after": "60" }),
		forbidden("You have exceeded a secondary rate limit. Please wait a few minutes before you try again."),
		forbidden("<html>Access denied</html>", { "content-type": "text/html" }),
	]) {
		for (const host of atEachRead(answer)) {
			await assert.rejects(
				() => host.isDefaultBranchProtected(REPO, "tok"),
				(e) => e.piDispatchRetry === true && e.name === "InfraRetry" && e.piDispatchConfig !== true,
				answer.message,
			);
		}
	}
});

test("isDefaultBranchProtected: every other refusal is retried at any read, but the branch read's 404 (issue #876)", async () => {
	for (const status of [401, 404, 429, 500, 502]) {
		const hosts = atEachRead(httpError(status));
		const retried = status === 404 ? [hosts[0], hosts[2]] : hosts;
		for (const host of retried) {
			await assert.rejects(
				() => host.isDefaultBranchProtected(REPO, "tok"),
				(e) => e.piDispatchRetry === true && e.piDispatchConfig !== true,
				String(status),
			);
		}
	}
	// A plain Error with no status (a client fault) is retried too.
	await assert.rejects(() => hostAnswering({ branch: branchBody(true, false), rules: new Error("socket hang up") }).host.isDefaultBranchProtected(REPO, "tok"), (e) => e.piDispatchRetry === true);
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
