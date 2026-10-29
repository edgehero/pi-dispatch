import assert from "node:assert/strict";
import { test } from "node:test";
import { makeWatchIssueAdapter } from "../src/watch-issue-adapter.mjs";
const marker = `pi-dispatch-watch:${"a".repeat(64)}`;
function adapter(kind, responses) {
	const calls = []; const api = makeWatchIssueAdapter({ getContext: async () => ({ apiUrl: "https://forge.example", token: "private-token-value" }), fetchFn: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(responses.shift()), { status: 200 }); } });
	return { api, calls, target: { kind, repo: "owner/repo" } };
}
test("three forge APIs create and update issues using their native body fields and methods", async () => {
	for (const kind of ["github", "gitlab", "forgejo"]) {
		const { api, calls, target } = adapter(kind, [{ number: 7, iid: 7 }, {}]);
		assert.deepEqual(await api.createIssue({ target, title: "title", body: "digest" }), { id: 7 }); await api.updateIssue({ target, id: 7, title: "next", body: "next digest" });
		assert.equal(calls[0].options.method, "POST"); assert.equal(calls[1].options.method, kind === "gitlab" ? "PUT" : "PATCH"); assert.equal(calls[0].options.redirect, "error");
		assert.equal(JSON.parse(calls[0].options.body)[kind === "gitlab" ? "description" : "body"], "digest");
		assert.match(calls[0].url, kind === "gitlab" ? /api\/v4\/projects\/owner%2Frepo\/issues$/ : kind === "forgejo" ? /api\/v1\/repos\/owner\/repo\/issues$/ : /repos\/owner\/repo\/issues$/);
	}
});
test("marker reconciliation reads bounded pages and ignores pull requests", async () => {
	const { api, target } = adapter("github", [Array.from({ length: 100 }, () => ({ number: 1, body: "other" })), [{ number: 8, body: `<!-- ${marker} -->`, pull_request: {} }, { number: 9, body: `<!-- ${marker} -->` }]]);
	assert.deepEqual(await api.findIssue({ target, marker }), { id: 9 });
});
test("insecure endpoints, unsupported Azure targets, hostile ids and HTTP failures refuse safely", async () => {
	const { api, target } = adapter("github", []); await assert.rejects(api.updateIssue({ target, id: "../1" })); await assert.rejects(api.createIssue({ target: { ...target, kind: "azure" } }), /unsupported/);
	const insecure = makeWatchIssueAdapter({ getContext: async () => ({ apiUrl: "http://forge.example", token: "secret" }) }); await assert.rejects(insecure.createIssue({ target }), /context/);
	const failure = makeWatchIssueAdapter({ getContext: async () => ({ apiUrl: "https://forge.example", token: "secret" }), fetchFn: async () => new Response("sensitive remote error", { status: 403 }) }); await assert.rejects(failure.createIssue({ target }), error => !error.message.includes("sensitive"));
});
test("reconciliation refuses an incomplete bounded scan instead of creating a duplicate", async () => {
	const api = makeWatchIssueAdapter({ maxPages: 1, getContext: async () => ({ apiUrl: "https://forge.example", token: "secret" }), fetchFn: async () => new Response(JSON.stringify(Array.from({ length: 100 }, () => ({ number: 1, body: "other" })))) });
	await assert.rejects(api.findIssue({ target: { kind: "github", repo: "owner/repo" }, marker }), /page limit/);
});

test("quiet closure and recurrence reopen use each forge's native state mutation", async () => {
	for (const kind of ["github", "gitlab", "forgejo"]) {
		const { api, calls, target } = adapter(kind, [{}, {}]);
		await api.closeIssue({ target, id: 7 }); await api.updateIssue({ target, id: 7, state: "open" });
		assert.deepEqual(JSON.parse(calls[0].options.body), kind === "gitlab" ? { state_event: "close" } : { state: "closed" });
		assert.deepEqual(JSON.parse(calls[1].options.body), kind === "gitlab" ? { state_event: "reopen" } : { state: "open" });
		assert.equal(calls[0].options.method, kind === "gitlab" ? "PUT" : "PATCH");
	}
});
