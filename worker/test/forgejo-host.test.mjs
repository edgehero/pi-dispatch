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

/**
 * A fake that answers `{ status, body }` per `METHOD path`, may answer one key differently on each call (an array),
 * records every call, and THROWS on an unrouted one. The bodies below are Forgejo 14.0.5's, measured, cut to the
 * fields this code reads.
 */
function forgejoFake(routes) {
	const seen = {};
	const fn = async (url, init = {}) => {
		const key = `${init.method ?? "GET"} ${String(url).replace(/^https?:\/\/[^/]+/, "")}`;
		fn.calls.push({ key, init });
		if (!Object.hasOwn(routes, key)) throw new Error(`unrouted ${key}`);
		const n = (seen[key] = (seen[key] ?? 0) + 1);
		const r = Array.isArray(routes[key]) ? routes[key][Math.min(n, routes[key].length) - 1] : routes[key];
		return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
	};
	fn.calls = [];
	return fn;
}
const LABELS = "/api/v1/repos/acme/widgets/labels";
const ISSUE_LABELS = "/api/v1/repos/acme/widgets/issues/7/labels";
const page = (n) => `GET ${LABELS}?page=${n}&limit=50`;
const lbl = (id, name = "pi-awaiting-input") => ({ id, name, color: "fbca04" });

test("parking a repository that has no marker label creates it once and attaches it by its id", async () => {
	const fetchFn = forgejoFake({
		[page(1)]: { status: 200, body: [lbl(1, "ai")] },
		[page(2)]: { status: 200, body: [] },
		[`POST ${LABELS}`]: { status: 201, body: lbl(2) },
		[`POST ${ISSUE_LABELS}`]: { status: 200, body: [lbl(2)] },
	});
	await makeForgejoHost({ apiUrl: API, fetchFn }).setParkedLabel(REPO, { type: "issue", number: 7 }, true, "tok");
	assert.deepEqual(fetchFn.calls.map((c) => c.key), [page(1), page(2), `POST ${LABELS}`, `POST ${ISSUE_LABELS}`]);
	assert.equal(JSON.parse(fetchFn.calls[2].init.body).name, "pi-awaiting-input");
	assert.deepEqual(JSON.parse(fetchFn.calls[3].init.body), { labels: [2] }, "by id: by name, Forgejo attaches every label of that name");
});

test("parking again reuses the existing label rather than creating a duplicate, which Forgejo 14 would accept with 201", async () => {
	// Measured: a second POST /labels with the same name answered 201 and made label #3 beside #2. The fake leaves that
	// route out, so a create here would throw as unrouted.
	const fetchFn = forgejoFake({
		[page(1)]: { status: 200, body: [lbl(1, "ai"), lbl(2)] },
		[page(2)]: { status: 200, body: [] },
		[`POST ${ISSUE_LABELS}`]: { status: 200, body: [lbl(2)] },
	});
	await makeForgejoHost({ apiUrl: API, fetchFn }).setParkedLabel(REPO, { type: "issue", number: 7 }, true, "tok");
	assert.deepEqual(fetchFn.calls.map((c) => c.key), [page(1), page(2), `POST ${ISSUE_LABELS}`]);
	assert.deepEqual(JSON.parse(fetchFn.calls[2].init.body), { labels: [2] });
});

test("a repository that already holds duplicates gets the LOWEST id attached, and no third copy", async () => {
	// The lab repository's labels after two parks under 4.3.0: ai #1, pi-awaiting-input #2 and #3. Paged across two pages
	// to pin that the lookup reads past the first one.
	const fetchFn = forgejoFake({
		[page(1)]: { status: 200, body: [lbl(1, "ai"), lbl(3)] },
		[page(2)]: { status: 200, body: [lbl(2), lbl(4, "pi-awaiting-input-old")] },
		[page(3)]: { status: 200, body: [] },
		[`POST ${ISSUE_LABELS}`]: { status: 200, body: [lbl(2)] },
	});
	await makeForgejoHost({ apiUrl: API, fetchFn }).setParkedLabel(REPO, { type: "issue", number: 7 }, true, "tok");
	assert.deepEqual(JSON.parse(fetchFn.calls.at(-1).init.body), { labels: [2] }, "exact name only, lowest id");
});

test("a forge that refuses the duplicate name (409/422) is read again rather than failing the park", async () => {
	const fetchFn = forgejoFake({
		[page(1)]: [{ status: 200, body: [] }, { status: 200, body: [lbl(5)] }],
		[page(2)]: { status: 200, body: [] },
		[`POST ${LABELS}`]: { status: 409, body: { message: "label exists" } },
		[`POST ${ISSUE_LABELS}`]: { status: 200, body: [lbl(5)] },
	});
	await makeForgejoHost({ apiUrl: API, fetchFn }).setParkedLabel(REPO, { type: "issue", number: 7 }, true, "tok");
	assert.deepEqual(JSON.parse(fetchFn.calls.at(-1).init.body), { labels: [5] });
});

test("clearing removes EVERY marker the issue carries, by id, so an issue left with two by 4.3.0 heals", async () => {
	// Measured: the issue carried #2 and #3, and DELETE .../labels/pi-awaiting-input answered 204 and took off one.
	const fetchFn = forgejoFake({
		[`GET ${ISSUE_LABELS}`]: { status: 200, body: [lbl(1, "ai"), lbl(2), lbl(3)] },
		[`DELETE ${ISSUE_LABELS}/2`]: { status: 204, body: null },
		[`DELETE ${ISSUE_LABELS}/3`]: { status: 204, body: null },
	});
	await makeForgejoHost({ apiUrl: API, fetchFn }).setParkedLabel(REPO, { type: "issue", number: 7 }, false, "tok");
	assert.deepEqual(fetchFn.calls.map((c) => c.key), [`GET ${ISSUE_LABELS}`, `DELETE ${ISSUE_LABELS}/2`, `DELETE ${ISSUE_LABELS}/3`], "the `ai` label is not touched");
});

test("clearing an issue that carries no marker sends no DELETE at all, and a missing issue is already clear", async () => {
	const none = forgejoFake({ [`GET ${ISSUE_LABELS}`]: { status: 200, body: [lbl(1, "ai")] } });
	await makeForgejoHost({ apiUrl: API, fetchFn: none }).setParkedLabel(REPO, { type: "issue", number: 7 }, false, "tok");
	assert.deepEqual(none.calls.map((c) => c.key), [`GET ${ISSUE_LABELS}`]);
	const gone = forgejoFake({ [`GET ${ISSUE_LABELS}`]: { status: 404, body: { message: "not found" } } });
	await makeForgejoHost({ apiUrl: API, fetchFn: gone }).setParkedLabel(REPO, { type: "issue", number: 7 }, false, "tok");
});

test("a removal Forgejo answers 404 or 422 is already gone; any other refusal still throws for the log", async () => {
	// 422 is Forgejo 14.0.5's measured answer for a label that does not exist:
	// {"message":"label does not exist [label_id: 0, repo_id: 1]"} (the label was removed between the read and the delete).
	for (const status of [404, 422]) {
		const fetchFn = forgejoFake({
			[`GET ${ISSUE_LABELS}`]: { status: 200, body: [lbl(2)] },
			[`DELETE ${ISSUE_LABELS}/2`]: { status, body: { message: "label does not exist [label_id: 0, repo_id: 1]" } },
		});
		await makeForgejoHost({ apiUrl: API, fetchFn }).setParkedLabel(REPO, { type: "issue", number: 7 }, false, "tok");
	}
	const refused = forgejoFake({
		[`GET ${ISSUE_LABELS}`]: { status: 200, body: [lbl(2)] },
		[`DELETE ${ISSUE_LABELS}/2`]: { status: 403, body: {} },
	});
	await assert.rejects(() => makeForgejoHost({ apiUrl: API, fetchFn: refused }).setParkedLabel(REPO, { type: "issue", number: 7 }, false, "tok"), /returned 403/);
	// Only the removal reads 422 as done: attaching the marker still refuses on it.
	const adding = forgejoFake({
		[page(1)]: { status: 200, body: [lbl(2)] },
		[page(2)]: { status: 200, body: [] },
		[`POST ${ISSUE_LABELS}`]: { status: 422, body: {} },
	});
	await assert.rejects(() => makeForgejoHost({ apiUrl: API, fetchFn: adding }).setParkedLabel(REPO, { type: "issue", number: 7 }, true, "tok"), /returned 422/);
});

test("the label lookup is bounded, so a server that never sends an empty page cannot hold a teardown", async () => {
	const fetchFn = async (url) => (fetchFn.n++, { ok: true, status: 200, json: async () => [lbl(9, "other")] });
	fetchFn.n = 0;
	await assert.rejects(() => makeForgejoHost({ apiUrl: API, fetchFn }).setParkedLabel(REPO, { type: "issue", number: 7 }, true, "tok"), /pages of labels/);
	assert.equal(fetchFn.n, 20);
});
