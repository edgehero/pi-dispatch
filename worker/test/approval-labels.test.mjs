import assert from "node:assert/strict";
import { test } from "node:test";
import { makeGitHubHost } from "../src/github-host.mjs";
import { makeGitLabHost } from "../src/gitlab-host.mjs";
import { makeForgejoHost } from "../src/forgejo-host.mjs";
import { makeAzureHost } from "../src/azure-host.mjs";

const APPROVAL = "pi-awaiting-approval";
const INPUT = "pi-awaiting-input";
const TARGET = { type: "issue", number: 7 };
const response = (body) => ({ ok: true, status: 200, json: async () => body });

test("GitHub adds and clears the approval marker by its own name", async () => {
	const calls = [];
	const host = makeGitHubHost({ octokitFor: () => ({ request: async (route, params) => (calls.push({ route, params }), { data: {} }) }) });
	await host.setParkedLabel({ repo: "acme/widgets" }, TARGET, true, "token", APPROVAL);
	await host.setParkedLabel({ repo: "acme/widgets" }, TARGET, false, "token", APPROVAL);
	assert.deepEqual(calls.map(({ params }) => params), [
		{ owner: "acme", repo: "widgets", issue_number: 7, labels: [APPROVAL] },
		{ owner: "acme", repo: "widgets", issue_number: 7, name: APPROVAL },
	]);
});

test("GitLab adds and clears the approval marker without replacing other labels", async () => {
	const calls = [];
	const host = makeGitLabHost({ apiUrl: "https://gitlab.example.test", fetchFn: async (url, init) => {
		assert.equal(url, "https://gitlab.example.test/api/v4/projects/42/issues/7");
		assert.equal(init.method, "PUT");
		calls.push(JSON.parse(init.body));
		return response({});
	} });
	await host.setParkedLabel({ repo: "acme/widgets", projectId: 42 }, TARGET, true, "token", APPROVAL);
	await host.setParkedLabel({ repo: "acme/widgets", projectId: 42 }, TARGET, false, "token", APPROVAL);
	assert.deepEqual(calls, [{ add_labels: APPROVAL }, { remove_labels: APPROVAL }]);
});

test("Forgejo resolves the approval marker's id and removes only that marker from the issue", async () => {
	const calls = [];
	const labels = [{ id: 2, name: INPUT }, { id: 3, name: APPROVAL }];
	const host = makeForgejoHost({ apiUrl: "https://forgejo.example.test", fetchFn: async (url, init = {}) => {
		const path = new URL(url).pathname + new URL(url).search;
		const method = init.method ?? "GET";
		calls.push([method, path, init.body ? JSON.parse(init.body) : null]);
		if (method === "GET" && path === "/api/v1/repos/acme/widgets/labels?page=1&limit=50") return response(labels);
		if (method === "GET" && path === "/api/v1/repos/acme/widgets/labels?page=2&limit=50") return response([]);
		if (method === "GET" && path === "/api/v1/repos/acme/widgets/issues/7/labels") return response(labels);
		if (method === "POST" && path === "/api/v1/repos/acme/widgets/issues/7/labels") return response({});
		if (method === "DELETE" && path === "/api/v1/repos/acme/widgets/issues/7/labels/3") return response({});
		throw new Error(`unrouted ${method} ${path}`);
	} });
	await host.setParkedLabel({ repo: "acme/widgets" }, TARGET, true, "token", APPROVAL);
	await host.setParkedLabel({ repo: "acme/widgets" }, TARGET, false, "token", APPROVAL);
	assert.deepEqual(calls.filter(([method]) => method !== "GET"), [["POST", "/api/v1/repos/acme/widgets/issues/7/labels", { labels: [3] }], ["DELETE", "/api/v1/repos/acme/widgets/issues/7/labels/3", null]]);
});

test("Azure adds and removes only the approval tag, preserving the input marker and unrelated tags", async () => {
	let tags = `triaged; ${INPUT}`;
	const writes = [];
	const host = makeAzureHost({ orgUrl: "https://dev.azure.com/example", fetchFn: async (url, init = {}) => {
		assert.equal(new URL(url).pathname, "/example/Example/_apis/wit/workitems/7");
		if ((init.method ?? "GET") === "GET") return response({ fields: { "System.Tags": tags } });
		assert.equal(init.method, "PATCH");
		const body = JSON.parse(init.body);
		assert.equal(body[0].path, "/fields/System.Tags");
		tags = body[0].value;
		writes.push(tags);
		return response({});
	} });
	const job = { repo: "Example/widgets", azure: { project: "Example", repository: "widgets" } };
	await host.setParkedLabel(job, TARGET, true, "token", APPROVAL);
	await host.setParkedLabel(job, TARGET, false, "token", APPROVAL);
	assert.deepEqual(writes, [`triaged; ${INPUT}; ${APPROVAL}`, `triaged; ${INPUT}`]);
});
