import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSandboxRef, resolveSandboxRef, sandboxRemoteUrl, sandboxRepoProblem } from "../src/sandbox-refs.mjs";

const sha = "a".repeat(40);
const config = { gitlab: { apiUrl: "https://gitlab.example" }, forgejo: { apiUrl: "https://forgejo.example" }, azure: { orgUrl: "https://dev.azure.com/org" } };

test("branch, tag, default, SHA and served PR head refs stay distinct across forges", async () => {
	for (const ref of ["HEAD", "feature/human", "refs/tags/v1.2.3", "refs/heads/main", sha, "b".repeat(64)]) {
		assert.equal((await resolveSandboxRef({ kind: "github", repo: "owner/repo", ref })).fetchRef, ref);
	}
	for (const [kind, expected] of [["github", "refs/pull/42/head"], ["forgejo", "refs/pull/42/head"], ["gitlab", "refs/merge-requests/42/head"]]) {
		assert.equal((await resolveSandboxRef({ kind, repo: "owner/repo", ref: "pr:42" })).fetchRef, expected);
	}
	assert.equal(parseSandboxRef("42").type, "ref", "a branch named 42 is not a request number");
	assert.equal(parseSandboxRef("pr:42").type, "pull_request");
});

test("hostile refspecs, options and expressions are refused before Git receives them", () => {
	for (const ref of ["", "-u", "--upload-pack=evil", "main:refs/heads/stolen", "a\nb", "refs/../main", "a@{1}", "HEAD~1", "heads/*", "x\\y", "refs/heads/.hidden", "refs/heads/a.lock", "a//b", "a ", "pr:0", "pr:01", "pr:1;echo"]) {
		assert.equal(parseSandboxRef(ref).refused, "sandbox-ref-invalid", ref);
	}
});

test("origins come from configured forge hosts, preserving nested GitLab and structured Azure scope", () => {
	assert.equal(sandboxRemoteUrl("github", "owner/repo", config), "https://github.com/owner/repo.git");
	assert.equal(sandboxRemoteUrl("gitlab", "group/subgroup/repo", config), "https://gitlab.example/group/subgroup/repo.git");
	assert.equal(sandboxRemoteUrl("forgejo", "owner/repo", config), "https://forgejo.example/owner/repo.git");
	assert.equal(sandboxRemoteUrl("forgejo", "owner/repo", { forgejo: { apiUrl: "http://forgejo.internal:3000" } }), "http://forgejo.internal:3000/owner/repo.git", "a configured forge keeps the same transport its jobs use");
	assert.equal(sandboxRemoteUrl("azure", "Project Name/repo", config), "https://dev.azure.com/org/Project%20Name/_git/repo");
	for (const repo of ["https://evil/repo", "owner/../repo", "owner/-repo", "owner/repo?token=x", "owner/repo%2f..", "owner/repo#head", "owner/repo\n"]) assert.ok(sandboxRepoProblem(repo, "github"), repo);
	assert.ok(sandboxRepoProblem("owner/sub/repo", "github"), "a GitHub path cannot silently become its parent repo");
	assert.throws(() => sandboxRemoteUrl("gitlab", "group/repo", { gitlab: { apiUrl: "https://secret@evil" } }), /credential-free/);
});

test("Azure PR resolution admits the served source commit, not its merge commit or attacker branch text", async () => {
	const calls = [];
	const fetchFn = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ lastMergeSourceCommit: { commitId: sha }, lastMergeCommit: { commitId: "b".repeat(40) }, sourceRefName: "--evil" }) }; };
	assert.deepEqual(await resolveSandboxRef({ kind: "azure", repo: "Project Name/repo", ref: "pr:42", config, token: "private", fetchFn }), { fetchRef: sha });
	assert.equal(calls.length, 1);
	assert.match(calls[0].url, /Project%20Name\/_apis\/git\/repositories\/repo\/pullrequests\/42\?api-version=7.1$/);
	assert.equal(calls[0].options.redirect, "error");
	assert.equal(calls[0].options.headers.Authorization, `Basic ${Buffer.from(":private").toString("base64")}`);
	assert.doesNotMatch(calls[0].url, /private/);
});

test("missing Azure PRs return a refusal; transient lookup failures throw; malformed API data never selects a ref", async () => {
	const base = { kind: "azure", repo: "project/repo", ref: "pr:42", config, token: "private" };
	assert.equal((await resolveSandboxRef({ ...base, fetchFn: async () => ({ ok: false, status: 404 }) })).refused, "sandbox-ref-unavailable");
	await assert.rejects(resolveSandboxRef({ ...base, fetchFn: async () => ({ ok: false, status: 503 }) }), /temporarily/);
	await assert.rejects(resolveSandboxRef({ ...base, fetchFn: async () => { throw new Error("ECONNRESET"); } }), /did not answer/);
	assert.equal((await resolveSandboxRef({ ...base, fetchFn: async () => ({ ok: true, json: async () => ({ sourceRefName: "refs/heads/main" }) }) })).refused, "sandbox-ref-unavailable");
});
