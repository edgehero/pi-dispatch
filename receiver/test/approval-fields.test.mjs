import assert from "node:assert/strict";
import { test } from "node:test";
import { reloadTriggers } from "../src/config.mjs";
import { filter } from "../src/filter.mjs";
import { filterGitLab } from "../src/filter-gitlab.mjs";
import { filterForgejo } from "../src/filter-forgejo.mjs";
import { filterAzure } from "../src/filter-azure.mjs";
import { parseGitLabSubset } from "../src/gitlab-subset.mjs";
import { parseForgejoSubset } from "../src/forgejo-subset.mjs";
import { parseAzureSubset } from "../src/azure-subset.mjs";

const GATES = { gates: ["budget-raise", "deploy:staging"], gateTimeout: 3, maxCostUsd: "2", gateBudgetRaiseUsd: "3.50", resume: true };

function configured(kind) {
	const json = JSON.stringify({ triggers: [
		{ on: { type: "label", any: ["pi:go"] }, run: { kind, flow: "work", ...GATES, ...(kind === "azure" ? { repository: "widgets" } : {}) } },
		{ on: { type: "comment", phrase: "@pi" }, run: { kind, flow: "work", ...GATES, ...(kind === "azure" ? { repository: "widgets" } : {}) } },
	] });
	const cfg = {};
	assert.deepEqual(reloadTriggers({ PI_TRIGGERS_FILE: "/approval-triggers.json" }, cfg, { fileExists: () => true, readFile: () => json }), { ok: true });
	return cfg;
}

/** Real webhook subset parsers, over the minimal deliveries the existing per-forge filter tests use. */
function delivery(kind, route, cfg, { authorized = true, text = "@pi", marker = null } = {}) {
	const issue = { number: 7, title: "T", body: "B", labels: route === "label" ? [{ name: "pi:go" }] : marker ? [{ name: marker }] : [] };
	if (kind === "github") return filter(route === "label" ? "issues" : "issue_comment", { action: route === "label" ? "labeled" : "created", sender: { id: 7 }, repository: { full_name: "acme/widgets" }, issue, comment: { body: text, author_association: authorized ? "OWNER" : "NONE" } }, cfg, 999, "gh-approval", authorized);
	if (kind === "forgejo") return filterForgejo(route === "label" ? "issues" : "issue_comment", parseForgejoSubset({ action: route === "label" ? "label_updated" : "created", sender: { id: 7, login: "actor" }, repository: { full_name: "acme/widgets" }, issue, comment: { body: text } }), cfg.triggers.forgejo, cfg.triggers.knownFlows, 999, authorized, "fj-approval");
	if (kind === "gitlab") {
		const project = { id: 42, path_with_namespace: "acme/widgets", default_branch: "main" };
		const labels = issue.labels.map(({ name }) => ({ title: name }));
		const payload = route === "label" ? { object_kind: "issue", project, user: { id: 7, username: "actor" }, object_attributes: { iid: 7, title: "T", description: "B", action: "update", labels }, changes: { labels: { previous: [], current: labels } } } : { object_kind: "note", project, user: { id: 7, username: "actor" }, object_attributes: { action: "create", note: text, noteable_type: "Issue" }, issue: { iid: 7, title: "T", description: "B", labels } };
		return filterGitLab(parseGitLabSubset(payload), cfg.triggers.gitlab, cfg.triggers.knownFlows, 999, authorized, "gl-approval");
	}
	const tags = route === "label" ? "pi:go" : marker ?? "";
	const fields = route === "label" ? { "System.ChangedBy": { oldValue: "Prior", newValue: "Actor <actor@example.test>" }, "System.Tags": { oldValue: "", newValue: tags } } : { "System.ChangedBy": "Actor <actor@example.test>", "System.History": text };
	return filterAzure(parseAzureSubset({ id: "az-approval", eventType: route === "label" ? "workitem.updated" : "workitem.commented", resourceContainers: { project: { id: "project-guid", baseUrl: "https://dev.azure.com/example/" } }, resource: { id: 7, fields, revision: { fields: { "System.Title": "T", "System.Description": "B", "System.Tags": tags, "System.TeamProject": "Example" } } } }), cfg.triggers.azure, cfg.triggers.knownFlows, { id: "self-guid", email: "bot@example.test" }, authorized, "az-approval");
}

for (const kind of ["github", "gitlab", "forgejo", "azure"]) {
	for (const route of ["label", "comment"]) test(`${kind} ${route}: configured approval policy reaches the job, never the event trigger`, () => {
		const got = delivery(kind, route, configured(kind));
		assert.equal(got.enqueue, true, JSON.stringify(got));
		for (const [key, value] of Object.entries(GATES)) {
			assert.deepEqual(got.job[key], value, key);
			assert.equal(Object.hasOwn(got.job.trigger, key), false, `${key} must stay outside event.json`);
		}
		assert.equal(got.job.awaitInput, true, "a declared gate arms durable parking");
	});

	test(`${kind}: the approval marker routes plain decisions while the author gate still refuses unauthorized replies`, () => {
		const cfg = configured(kind);
		for (const text of ["/approve", "/decline keep staging", "Which deployment?"]) {
			const got = delivery(kind, "comment", cfg, { marker: "pi-awaiting-approval", text });
			assert.equal(got.enqueue, true, JSON.stringify(got));
			assert.equal(got.job.parkedReply, true);
			assert.equal(got.job.trigger.comment.body, text);
			assert.deepEqual(got.job.gates, GATES.gates);
			const refused = delivery(kind, "comment", cfg, { marker: "pi-awaiting-approval", text, authorized: false });
			assert.equal(refused.enqueue, false);
			assert.equal(refused.reason, "author-not-allowed");
		}
		assert.equal(delivery(kind, "comment", cfg, { text: "/approve" }).enqueue, false, "no phrase and no park marker grants no reply route");
	});
}
