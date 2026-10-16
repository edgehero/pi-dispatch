import assert from "node:assert/strict";
import { test } from "node:test";
import { gitlabRemoteUrl, makeGitLabHost, matchesBranch } from "../src/gitlab-host.mjs";

const TOKEN = "glpat-x";
const JOB = { kind: "gitlab", repo: "group/sub/proj", projectId: 42 };

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A fake fetch driven by a `path -> response` map, recording every call. */
function fakeFetch(routes) {
	const calls = [];
	const fn = async (url, init) => {
		calls.push({ url, init });
		const path = url.replace("https://gl.test/api/v4", "");
		const hit = routes[`${init?.method ?? "GET"} ${path}`] ?? routes[path];
		if (hit === undefined) throw new Error(`unrouted ${init?.method ?? "GET"} ${path}`);
		return typeof hit === "function" ? hit() : hit;
	};
	fn.calls = calls;
	return fn;
}

const host = (routes) => makeGitLabHost({ apiUrl: "https://gl.test", fetchFn: fakeFetch(routes) });

// -- resolveDefaultBranchSha ----------------------------------------------------------------------

test("resolveDefaultBranchSha reads the project then the branch tip, keyed on the NUMERIC id", async () => {
	const fetchFn = fakeFetch({
		"/projects/42": json({ default_branch: "main" }),
		"/projects/42/repository/branches/main": json({ commit: { id: "deadbeef" } }),
	});
	const h = makeGitLabHost({ apiUrl: "https://gl.test", fetchFn });
	assert.deepEqual(await h.resolveDefaultBranchSha(JOB, TOKEN), { branch: "main", sha: "deadbeef" });

	// The nested path never enters a URL. github-host's owner/name split would not fail on
	// `group/sub/proj` -- it would SUCCEED and silently address `group/sub`.
	assert.ok(fetchFn.calls.every((c) => !c.url.includes("group")), "no request may be keyed on the project path");
	assert.equal(fetchFn.calls[0].init.headers["PRIVATE-TOKEN"], TOKEN);
});

test("a branch name with a slash is URL-encoded", async () => {
	const fetchFn = fakeFetch({
		"/projects/42": json({ default_branch: "release/1.x" }),
		"/projects/42/repository/branches/release%2F1.x": json({ commit: { id: "abc" } }),
	});
	const h = makeGitLabHost({ apiUrl: "https://gl.test", fetchFn });
	assert.equal((await h.resolveDefaultBranchSha(JOB, TOKEN)).sha, "abc");
});

test("a project with no default branch is a config error, not a null sha the fetch would choke on", async () => {
	const h = host({ "/projects/42": json({ default_branch: null }) });
	await assert.rejects(() => h.resolveDefaultBranchSha(JOB, TOKEN), (e) => e.piDispatchConfig === true);
});

test("a transient read is retryable, and the error never echoes the token", async () => {
	const h = host({ "/projects/42": json({ message: `401 Unauthorized for ${TOKEN}` }, 500) });
	await assert.rejects(
		() => h.resolveDefaultBranchSha(JOB, TOKEN),
		(e) => e.piDispatchRetry === true && !e.message.includes(TOKEN),
		"a GitLab error body can quote the request, and the request carried the token",
	);
});

// -- isDefaultBranchProtected ---------------------------------------------------------------------

test("a protected default branch reports true; an empty protection list reports false", async () => {
	const protectedHost = host({
		"/projects/42": json({ default_branch: "main" }),
		"/projects/42/protected_branches": json([{ name: "main" }]),
	});
	assert.equal(await protectedHost.isDefaultBranchProtected(JOB, TOKEN), true);

	// `[]` is a DETERMINATE answer, which is exactly what a 404 could not have been -- a 404 is
	// indistinguishable from a project that does not exist or a token that cannot see it.
	const openHost = host({
		"/projects/42": json({ default_branch: "main" }),
		"/projects/42/protected_branches": json([]),
	});
	assert.equal(await openHost.isDefaultBranchProtected(JOB, TOKEN), false);
});

test("a WILDCARD rule covering the default branch reports protected", async () => {
	// An exact-name lookup would report `main` unprotected here and refuse a job that should have run.
	for (const rule of ["*", "m*", "mai*n"]) {
		const h = host({
			"/projects/42": json({ default_branch: "main" }),
			"/projects/42/protected_branches": json([{ name: rule }]),
		});
		assert.equal(await h.isDefaultBranchProtected(JOB, TOKEN), true, `rule ${rule} covers main`);
	}
});

test("NO error path returns false -- collapsing one would silently bypass the never-merge backstop", async () => {
	// The trap issue #61 documents in the other direction: carrying a forge's 404 semantics across a
	// boundary made every branch report unprotected.
	for (const status of [401, 403, 404, 429, 500, 502]) {
		const h = host({
			"/projects/42": json({ default_branch: "main" }),
			"/projects/42/protected_branches": json({}, status),
		});
		await assert.rejects(() => h.isDefaultBranchProtected(JOB, TOKEN), (e) => e.piDispatchRetry === true, `status ${status} must be retryable, never false`);
	}
	const nonArray = host({
		"/projects/42": json({ default_branch: "main" }),
		"/projects/42/protected_branches": json({ name: "main" }),
	});
	await assert.rejects(() => nonArray.isDefaultBranchProtected(JOB, TOKEN), (e) => e.piDispatchRetry === true);
});

test("matchesBranch treats * as the only wildcard and escapes every other metacharacter", () => {
	assert.equal(matchesBranch("release/*", "release/1.2/hotfix"), true, "* spans / -- GitLab's own semantics");
	assert.equal(matchesBranch("main", "main"), true);
	assert.equal(matchesBranch("main", "mainline"), false);
	// A stray metacharacter in operator config must not widen what counts as protected.
	assert.equal(matchesBranch("v1.0", "v1x0"), false, ". is a literal, not any-char");
	assert.equal(matchesBranch("a+b", "aab"), false);
	assert.equal(matchesBranch("", "main"), false);
	assert.equal(matchesBranch(undefined, "main"), false);
});

// -- postStatusComment ----------------------------------------------------------------------------

test("a note goes to the endpoint the target's TYPE names -- issues and merge requests differ", async () => {
	// Unlike GitHub, where both share /issues/{n}/comments. Posting an MR's iid to the issues path would
	// comment on a different object, or on nothing, without erroring.
	for (const [type, collection] of [["issue", "issues"], ["pull_request", "merge_requests"]]) {
		const fetchFn = fakeFetch({ [`POST /projects/42/${collection}/5/notes`]: json({ id: 1 }, 201) });
		const h = makeGitLabHost({ apiUrl: "https://gl.test", fetchFn });
		await h.postStatusComment(JOB, { type, number: 5 }, "  done {verbatim}  ", TOKEN);
		assert.equal(fetchFn.calls[0].url, `https://gl.test/api/v4/projects/42/${collection}/5/notes`);
		assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), { body: "  done {verbatim}  " }, "the text is passed through uninspected");
	}
});

test("a failed note is retryable and never echoes the token", async () => {
	const h = host({ "POST /projects/42/issues/5/notes": json({ message: TOKEN }, 500) });
	await assert.rejects(
		() => h.postStatusComment(JOB, { type: "issue", number: 5 }, "hi", TOKEN),
		(e) => e.piDispatchRetry === true && !e.message.includes(TOKEN),
	);
});

test("a job with no numeric project id is a config error, never a request against a guessed path", async () => {
	const h = host({});
	for (const ref of [{ repo: "group/proj" }, { projectId: "42" }, null, "group/proj"]) {
		await assert.rejects(() => h.resolveDefaultBranchSha(ref, TOKEN), (e) => e.piDispatchConfig === true);
	}
});

// -- the clone URL -------------------------------------------------------------------------------

test("gitlabRemoteUrl keeps the nested path WHOLE and carries no credential", () => {
	assert.equal(gitlabRemoteUrl("https://gl.test", "group/sub/proj"), "https://gl.test/group/sub/proj.git");
	assert.equal(gitlabRemoteUrl("https://gl.test/", "group/sub/proj"), "https://gl.test/group/sub/proj.git", "a trailing slash must not double up");
	assert.equal(gitlabRemoteUrl(undefined, "g/p"), "https://gitlab.com/g/p.git");

	// A subgroup dropped here would clone a DIFFERENT project that may well exist, and the job would run
	// against it and report success.
	assert.ok(gitlabRemoteUrl("https://gl.test", "a/b/c/d").endsWith("/a/b/c/d.git"));
	// The token reaches git only through GIT_ASKPASS; a URL is a thing the agent can read back out of
	// .git/config in the workspace it is standing in.
	assert.equal(gitlabRemoteUrl("https://gl.test", "g/p").includes("@"), false);

	for (const repo of ["", undefined, null]) {
		assert.throws(() => gitlabRemoteUrl("https://gl.test", repo), (e) => e.piDispatchConfig === true);
	}
});

// -- setParkedLabel (issue #625) ------------------------------------------------------------------

test("setParkedLabel adds and removes the marker with one PUT on the issue, by name", async () => {
	const fetchFn = fakeFetch({ "PUT /projects/42/issues/5": json({ iid: 5 }) });
	const h = makeGitLabHost({ apiUrl: "https://gl.test", fetchFn });
	await h.setParkedLabel(JOB, { type: "issue", number: 5 }, true, TOKEN);
	await h.setParkedLabel(JOB, { type: "issue", number: 5 }, false, TOKEN);
	assert.deepEqual(fetchFn.calls.map((c) => JSON.parse(c.init.body)), [{ add_labels: "pi-awaiting-input" }, { remove_labels: "pi-awaiting-input" }]);
	await assert.rejects(() => host({ "PUT /projects/42/issues/5": json({}, 403) }).setParkedLabel(JOB, { type: "issue", number: 5 }, true, TOKEN));
});

// -- status note id and edit (issue #644) ---------------------------------------------------------

test("postStatusComment returns the created note's id, and id null (never a throw) on a body without one", async () => {
	assert.deepEqual(await host({ "POST /projects/42/issues/5/notes": json({ id: 991 }, 201) }).postStatusComment(JOB, { type: "issue", number: 5 }, "hi", TOKEN), { id: "991" });
	const broken = { ok: true, status: 201, json: async () => { throw new SyntaxError("x"); } };
	assert.deepEqual(await host({ "POST /projects/42/issues/5/notes": broken }).postStatusComment(JOB, { type: "issue", number: 5 }, "hi", TOKEN), { id: null });
});

test("editStatusComment PUTs the note on the collection the target's type names, as the post chose it", async () => {
	for (const [type, collection] of [["issue", "issues"], ["pull_request", "merge_requests"]]) {
		const fetchFn = fakeFetch({ [`PUT /projects/42/${collection}/5/notes/991`]: json({ id: 991 }) });
		const h = makeGitLabHost({ apiUrl: "https://gl.test/", fetchFn });
		await h.editStatusComment(JOB, { type, number: 5 }, "991", "new", TOKEN);
		assert.equal(fetchFn.calls[0].url, `https://gl.test/api/v4/projects/42/${collection}/5/notes/991`);
		assert.equal(fetchFn.calls[0].init.method, "PUT");
		assert.equal(fetchFn.calls[0].init.headers["PRIVATE-TOKEN"], TOKEN);
		assert.equal(fetchFn.calls[0].init.redirect, "error");
		assert.deepEqual(JSON.parse(fetchFn.calls[0].init.body), { body: "new" });
	}
});

test("editStatusComment refuses a malformed note id before any request", async () => {
	const fetchFn = fakeFetch({});
	const h = makeGitLabHost({ apiUrl: "https://gl.test", fetchFn });
	for (const id of ["", "1/2", "..", "a".repeat(201), "wi:1", 991]) {
		await assert.rejects(() => h.editStatusComment(JOB, { type: "issue", number: 5 }, id, "t", TOKEN), (e) => e.piDispatchConfig === true);
	}
	assert.equal(fetchFn.calls.length, 0);
});

test("a failed edit throws with the HTTP status set and never echoes the token", async () => {
	for (const status of [403, 404, 429, 500]) {
		const h = host({ "PUT /projects/42/issues/5/notes/991": json({ message: TOKEN }, status) });
		await assert.rejects(
			() => h.editStatusComment(JOB, { type: "issue", number: 5 }, "991", "t", TOKEN),
			(e) => e.status === status && e.piDispatchRetry === true && !e.message.includes(TOKEN),
		);
	}
});
