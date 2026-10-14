import assert from "node:assert/strict";
import { test } from "node:test";
import { forgejoRemoteUrl, makeForgejoHost } from "../src/forgejo-host.mjs";

/** A path -> response map that THROWS on an unrouted call, so a wrong endpoint is a failure, not a miss. */
function fakeFetch(routes) {
	const fn = async (url, init = {}) => {
		const path = String(url).replace(/^https?:\/\/[^/]+/, "");
		const method = init.method ?? "GET";
		const key = `${method} ${path}`;
		fn.calls.push({ key, init });
		if (!Object.hasOwn(routes, key)) throw new Error(`unrouted ${key}`);
		const r = routes[key];
		if (typeof r === "number") return { ok: r >= 200 && r < 300, status: r, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => r };
	};
	fn.calls = [];
	return fn;
}

const REPO = { repo: "acme/widgets" };
const API = "https://fj.example.com";

test("resolveDefaultBranchSha reads the default branch and its tip, from the API and never a payload", async () => {
	const fetchFn = fakeFetch({
		"GET /api/v1/repos/acme/widgets": { default_branch: "main" },
		"GET /api/v1/repos/acme/widgets/branches/main": { name: "main", commit: { id: "abc123" } },
	});
	const host = makeForgejoHost({ apiUrl: API, fetchFn });
	assert.deepEqual(await host.resolveDefaultBranchSha(REPO, "t"), { branch: "main", sha: "abc123" });
	assert.equal(fetchFn.calls[0].init.headers.Authorization, "token t");
	assert.equal(fetchFn.calls[0].init.redirect, "error", "a 30x must not be followed -- the request carries the token");
});

test("a branch whose commit has no id is a retryable failure, never an undefined SHA", async () => {
	// A job that cannot name the commit it is standing on must not go on to clone something else.
	const host = makeForgejoHost({
		apiUrl: API,
		fetchFn: fakeFetch({
			"GET /api/v1/repos/acme/widgets": { default_branch: "main" },
			"GET /api/v1/repos/acme/widgets/branches/main": { name: "main", commit: {} },
		}),
	});
	await assert.rejects(() => host.resolveDefaultBranchSha(REPO, "t"));
});

// --- branch protection: issue #61's Gap 5, and the reason this host exists ---

test("protection is read from branch_protections -- GitHub's /protection path is never called", async () => {
	// github-host treats a 404 from /branches/{b}/protection as "not protected". Forgejo has no such
	// endpoint AT ALL, so carrying that rule across would report every branch unprotected and silently
	// disarm the never-merge backstop. `fakeFetch` throws on an unrouted call, so if this host ever asked
	// for GitHub's path the test fails rather than quietly returning false.
	const fetchFn = fakeFetch({
		"GET /api/v1/repos/acme/widgets": { default_branch: "main" },
		"GET /api/v1/repos/acme/widgets/branch_protections": [{ rule_name: "main" }],
	});
	const host = makeForgejoHost({ apiUrl: API, fetchFn });
	assert.equal(await host.isDefaultBranchProtected(REPO, "t"), true);
	assert.equal(
		fetchFn.calls.some((c) => c.key.includes("/protection")),
		false,
		"GitHub's protection endpoint must never be consulted on Forgejo",
	);
});

test("a GLOB rule protects the branch it covers but does not name", async () => {
	// `release/*` protects `release/1.0`, while GET /branch_protections/release/1.0 would 404. Calling the
	// per-name endpoint instead of listing would be a second fail-open hiding behind the first fix.
	const host = (rules, branch) =>
		makeForgejoHost({
			apiUrl: API,
			fetchFn: fakeFetch({
				"GET /api/v1/repos/acme/widgets": { default_branch: branch },
				"GET /api/v1/repos/acme/widgets/branch_protections": rules,
			}),
		});
	assert.equal(await host([{ rule_name: "release/*" }], "release/1.0").isDefaultBranchProtected(REPO, "t"), true);
	assert.equal(await host([{ rule_name: "release/*" }], "main").isDefaultBranchProtected(REPO, "t"), false);
	assert.equal(await host([], "main").isDefaultBranchProtected(REPO, "t"), false, "no rules is a determinate 'not protected'");
});

test("the deprecated branch_name field is honoured too -- an older instance must not report unprotected", async () => {
	const host = makeForgejoHost({
		apiUrl: API,
		fetchFn: fakeFetch({
			"GET /api/v1/repos/acme/widgets": { default_branch: "main" },
			"GET /api/v1/repos/acme/widgets/branch_protections": [{ branch_name: "main" }],
		}),
	});
	assert.equal(await host.isDefaultBranchProtected(REPO, "t"), true);
});

test("a non-2xx from either protection call is retryable, NEVER false", async () => {
	// Collapsing an error into "unprotected" is the same fail-open in a different costume: the job would be
	// admitted to push to a branch a human is supposed to gate.
	for (const status of [401, 403, 429, 500, 502]) {
		const host = makeForgejoHost({
			apiUrl: API,
			fetchFn: fakeFetch({
				"GET /api/v1/repos/acme/widgets": { default_branch: "main" },
				"GET /api/v1/repos/acme/widgets/branch_protections": status,
			}),
		});
		await assert.rejects(() => host.isDefaultBranchProtected(REPO, "t"), `${status} must not read as unprotected`);
	}
});

test("branch_protections returning a non-array is retryable, never an empty result", async () => {
	const host = makeForgejoHost({
		apiUrl: API,
		fetchFn: fakeFetch({
			"GET /api/v1/repos/acme/widgets": { default_branch: "main" },
			"GET /api/v1/repos/acme/widgets/branch_protections": { rules: [] },
		}),
	});
	await assert.rejects(() => host.isDefaultBranchProtected(REPO, "t"));
});

// --- comments and PR head ---

test("a comment goes to the issues endpoint for BOTH target types -- a PR is an issue on Forgejo", async () => {
	// Unlike GitLab, where posting an MR's iid to the issues path comments on a different object without
	// erroring, Forgejo follows GitHub: one index, one endpoint, no way to hit the wrong object.
	for (const type of ["issue", "pull_request"]) {
		const fetchFn = fakeFetch({ "POST /api/v1/repos/acme/widgets/issues/7/comments": { id: 1 } });
		const host = makeForgejoHost({ apiUrl: API, fetchFn });
		await host.postStatusComment(REPO, { type, number: 7 }, "hello", "t");
		assert.equal(JSON.parse(fetchFn.calls[0].init.body).body, "hello", `${type}: the text is passed through verbatim`);
	}
});

test("resolvePullRequestHead reports the head ref and the head repo, so the fork gate stays forge-blind", async () => {
	const host = makeForgejoHost({
		apiUrl: API,
		fetchFn: fakeFetch({
			"GET /api/v1/repos/acme/widgets/pulls/12": { head: { ref: "pi/issue-7", repo: { full_name: "acme/widgets" } } },
		}),
	});
	assert.deepEqual(await host.resolvePullRequestHead({ repo: "acme/widgets", target: { number: 12 } }, "t"), {
		headRef: "pi/issue-7",
		headRepo: "acme/widgets",
	});
});

test("a fork PR reports the FORK's repo, which is what makes session-key refuse it", async () => {
	const host = makeForgejoHost({
		apiUrl: API,
		fetchFn: fakeFetch({
			"GET /api/v1/repos/acme/widgets/pulls/12": { head: { ref: "pi/issue-7", repo: { full_name: "stranger/widgets" } } },
		}),
	});
	const { headRepo } = await host.resolvePullRequestHead({ repo: "acme/widgets", target: { number: 12 } }, "t");
	assert.notEqual(headRepo, "acme/widgets", "session-key compares these two strings and resolves no key when they differ");
});

// --- repo shape and clone URL ---

test("a repo path with more than two segments refuses rather than addressing another repository", async () => {
	const host = makeForgejoHost({ apiUrl: API, fetchFn: fakeFetch({}) });
	for (const repo of ["acme", "a/b/c", "grp/sub/proj"]) {
		await assert.rejects(() => host.resolveDefaultBranchSha({ repo }, "t"), (e) => e.piDispatchConfig === true, repo);
	}
});

test("the clone URL is tokenless, and refuses without an instance URL", () => {
	// The token reaches git only through GIT_ASKPASS, so it never enters argv, .git/config, or a remote URL
	// the agent could read back out of the workspace it is standing in.
	assert.equal(forgejoRemoteUrl("https://fj.example.com/", "acme/widgets"), "https://fj.example.com/acme/widgets.git");
	assert.throws(() => forgejoRemoteUrl(null, "acme/widgets"), (e) => e.piDispatchConfig === true, "no default instance to guess");
	assert.throws(() => forgejoRemoteUrl(API, ""), (e) => e.piDispatchConfig === true);
});

// -- setParkedLabel (issue #625) ------------------------------------------------------------------

test("setParkedLabel creates the repository label (an existing one is fine), adds it by name, and removes it by name", async () => {
	const fetchFn = fakeFetch({
		"POST /api/v1/repos/acme/widgets/labels": 409,
		"POST /api/v1/repos/acme/widgets/issues/7/labels": [],
		"DELETE /api/v1/repos/acme/widgets/issues/7/labels/pi-awaiting-input": 404,
	});
	const host = makeForgejoHost({ apiUrl: API, fetchFn });
	await host.setParkedLabel(REPO, { type: "issue", number: 7 }, true, "tok");
	assert.deepEqual(fetchFn.calls.map((c) => c.key), ["POST /api/v1/repos/acme/widgets/labels", "POST /api/v1/repos/acme/widgets/issues/7/labels"]);
	assert.deepEqual(JSON.parse(fetchFn.calls[1].init.body), { labels: ["pi-awaiting-input"] });
	await host.setParkedLabel(REPO, { type: "issue", number: 7 }, false, "tok");
	const refused = makeForgejoHost({ apiUrl: API, fetchFn: fakeFetch({ "POST /api/v1/repos/acme/widgets/labels": 201, "POST /api/v1/repos/acme/widgets/issues/7/labels": 403 }) });
	await assert.rejects(() => refused.setParkedLabel(REPO, { type: "issue", number: 7 }, true, "tok"));
});

test("clearing the marker in a repository that never had the label is already-gone, not a failure", async () => {
	// Measured on Forgejo 14.0.5: DELETE /repos/{o}/{r}/issues/{n}/labels/pi-awaiting-input answers 422
	// {"message":"label does not exist [label_id: 0, repo_id: 1]"} when the repository has no such label, so every
	// completed non-parked run on an awaitInput trigger logged parked_label_failed ... returned 422.
	const fetchFn = async (url, init = {}) => {
		fetchFn.calls.push(`${init.method} ${String(url).replace(/^https?:\/\/[^/]+/, "")}`);
		return { ok: false, status: 422, json: async () => ({ message: "label does not exist [label_id: 0, repo_id: 1]" }) };
	};
	fetchFn.calls = [];
	const host = makeForgejoHost({ apiUrl: API, fetchFn });
	await host.setParkedLabel(REPO, { type: "issue", number: 7 }, false, "tok");
	assert.deepEqual(fetchFn.calls, ["DELETE /api/v1/repos/acme/widgets/issues/7/labels/pi-awaiting-input"]);
	// Only the removal reads 422 as done: adding the marker to an issue still refuses on it.
	const adding = makeForgejoHost({ apiUrl: API, fetchFn: fakeFetch({ "POST /api/v1/repos/acme/widgets/labels": 201, "POST /api/v1/repos/acme/widgets/issues/7/labels": 422 }) });
	await assert.rejects(() => adding.setParkedLabel(REPO, { type: "issue", number: 7 }, true, "tok"), /returned 422/);
	// And any other refusal of the removal still throws, so a real failure is still logged.
	const refused = makeForgejoHost({ apiUrl: API, fetchFn: fakeFetch({ "DELETE /api/v1/repos/acme/widgets/issues/7/labels/pi-awaiting-input": 403 }) });
	await assert.rejects(() => refused.setParkedLabel(REPO, { type: "issue", number: 7 }, false, "tok"), /returned 403/);
});
