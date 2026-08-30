import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { filterGitLab } from "../src/filter-gitlab.mjs";
import { filter } from "../src/filter.mjs";
import { parseGitLabSubset } from "../src/gitlab-subset.mjs";

/**
 * Issue #230. `run.waitFor` is carried BY HAND through four filter modules, and a missed site is this
 * feature's worst failure: a paid job that runs UNHELD on one forge and one trigger type only, with a run
 * record, a panel row and a log line byte-identical to one that correctly waited. Nothing downstream can
 * detect it, because "started immediately" is exactly what success looks like.
 *
 * Pinned from two directions, deliberately. The SOURCE PARITY test is the one that scales: it catches a
 * deleted carrier on any route in any of the four modules, including routes no behavioural test covers and
 * routes added later. The behavioural tests then prove the wiring is real rather than merely symmetric, on
 * the two forges whose harness shapes this file can build without duplicating a third and fourth fixture
 * set -- the parity test is what covers forgejo and azure, and it covers them by construction.
 */

const FILTERS = ["filter.mjs", "filter-gitlab.mjs", "filter-forgejo.mjs", "filter-azure.mjs"];

test("every filter carries waitFor exactly as often as it carries secretsProfile", () => {
	// `run.secretsProfile` is the template this field was wired against, site for site: the same routes and
	// the same conditional-vs-plain shapes. Counting them against each other makes "did you miss a route?"
	// answerable without enumerating the routes here, and it keeps answering as routes are added.
	for (const name of FILTERS) {
		const src = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
		const secrets = src.match(/secretsProfile/g)?.length ?? 0;
		const waits = src.match(/waitFor/g)?.length ?? 0;
		assert.ok(secrets > 0, `${name} should carry secretsProfile`);
		assert.equal(waits, secrets, `${name}: waitFor appears ${waits}x but secretsProfile ${secrets}x -- a route gained a carrier without the other, or one was deleted`);
	}
});

test("the receiver's grouper carries waitFor onto every rule kind it builds", () => {
	const src = readFileSync(new URL("../src/config.mjs", import.meta.url), "utf8");
	const secrets = src.match(/secretsProfile: run\.secretsProfile/g)?.length ?? 0;
	const waits = src.match(/waitFor: run\.waitFor/g)?.length ?? 0;
	assert.equal(waits, secrets, `config.mjs groups ${secrets} rule kinds with secretsProfile but ${waits} with waitFor`);
});

const WAIT = [{ profile: "jira" }, { after: "2026-09-01T09:00:00Z" }];

test("github: a label rule's waitFor reaches the JOB, and never `trigger`", () => {
	const subset = { action: "labeled", sender: { id: 7 }, repository: { full_name: "octo/repo" }, issue: { number: 42, title: "T", body: "B", labels: [{ name: "pi:deploy" }] } };
	const group = { label: [{ index: 0, predicate: { any: ["pi:deploy"] }, flow: "deploy", waitFor: WAIT }], comment: null, pullRequest: [], issue: [], prClose: [] };
	const cfg = { triggers: { github: group, knownFlows: new Set(["deploy"]) } };

	const r = filter("issues", subset, cfg, 999, "d-wait");
	assert.equal(r.enqueue, true, JSON.stringify(r).slice(0, 200));
	assert.deepEqual(r.job.waitFor, WAIT, "the conditions reach the job the worker will pick up");
	// The placement is a correctness requirement rather than a convention: `trigger` is copied VERBATIM into
	// the container's /job/event.json, so a wait riding there would hand the agent the operator's own gate.
	// Serialized whole rather than probed by key, so a nested spelling cannot hide.
	assert.equal(JSON.stringify(r.job.trigger).includes("waitFor"), false, "no wait condition anywhere inside `trigger`");

	// And the unflagged twin is byte-identical: the key is ABSENT, not present-and-undefined.
	const plainGroup = { ...group, label: [{ index: 0, predicate: { any: ["pi:deploy"] }, flow: "deploy" }] };
	const plain = filter("issues", subset, { triggers: { github: plainGroup, knownFlows: new Set(["deploy"]) } }, 999, "d-plain");
	assert.equal(plain.enqueue, true);
	assert.equal("waitFor" in plain.job, false);
});

test("gitlab: a label rule's waitFor reaches the JOB, and never `trigger`", () => {
	const payload = {
		object_kind: "issue",
		user: { id: 7, username: "dev" },
		project: { id: 42, path_with_namespace: "group/sub/proj", default_branch: "main" },
		object_attributes: { iid: 5, title: "T", description: "B", action: "update", labels: [{ title: "pi:deploy" }] },
		changes: { labels: { previous: [], current: [{ title: "pi:deploy" }] } },
	};
	const triggers = { label: [{ index: 0, predicate: { any: ["pi:deploy"] }, flow: "deploy", waitFor: WAIT }], comment: null, pullRequest: [] };
	const knownFlows = new Set(["deploy"]);

	const r = filterGitLab(parseGitLabSubset(payload), triggers, knownFlows, 999, true, "d-wait");
	assert.equal(r.enqueue, true, JSON.stringify(r).slice(0, 200));
	assert.deepEqual(r.job.waitFor, WAIT);
	assert.equal(JSON.stringify(r.job.trigger).includes("waitFor"), false);

	const plainTriggers = { ...triggers, label: [{ index: 0, predicate: { any: ["pi:deploy"] }, flow: "deploy" }] };
	const plain = filterGitLab(parseGitLabSubset(payload), plainTriggers, knownFlows, 999, true, "d-plain");
	assert.equal(plain.enqueue, true);
	assert.equal("waitFor" in plain.job, false);
});
