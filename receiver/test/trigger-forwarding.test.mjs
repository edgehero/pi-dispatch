import assert from "node:assert/strict";
import { test } from "node:test";
import { enqueueForgeJob } from "@edgehero/pi-dispatch/queue";
import { parseTriggers } from "@edgehero/pi-dispatch/triggers";
import { reloadTriggers } from "../src/config.mjs";
import { filterAzure } from "../src/filter-azure.mjs";
import { filterForgejo } from "../src/filter-forgejo.mjs";
import { filterGitLab } from "../src/filter-gitlab.mjs";
import { filter } from "../src/filter.mjs";
import { parseAzureSubset } from "../src/azure-subset.mjs";
import { parseForgejoSubset } from "../src/forgejo-subset.mjs";
import { parseGitLabSubset } from "../src/gitlab-subset.mjs";

/**
 * The DERIVED forwarding bolt (issue #502). Every execution key a forge normalizer emits must reach the
 * enqueued job through every route of every filter, through the receiver's group copies on the way, and
 * through queue.mjs's enqueueForgeJob, whose field list is the last hand-written hop.
 *
 * The receiver carries run fields BY HAND: five group copies in config.mjs and about twenty route sites
 * in four filter modules. A field one site forgets does not fail anything; the job just runs without it,
 * which for `model` means the deployment default and for `excludeTools` means the tool is back. The
 * wait-carry parity test counts one field against another and so cannot see a field nobody has wired
 * yet. This one derives the key set from the LOADER's own output, so adding a key to a normalizer
 * without forwarding it fails here, on the route that dropped it.
 *
 * The fixtures are maximal: every optional run field set, run through the real parseTriggers, so a field
 * the loader starts emitting is in the set without anyone editing this file.
 */

// Normalized run keys that DECIDE routing rather than ride the job, each with the reason it is excluded.
// A key belongs here only if it is consumed before the job literal is built; anything else is execution.
const ROUTING_ONLY = new Set([
	// Which forge: it selects the filter module and the rule group, and the job's forge is the queue's
	// `kind` argument, never a field the filter copies.
	"kind",
	// Azure's repository name: the filter resolves it into `repo` and `azure.repository` (resolveScope),
	// so it reaches the job transformed rather than verbatim, and the azure filter tests pin that shape.
	"repository",
]);

// Every optional run field a forge trigger accepts, with a value the loader keeps. `resume: false` rather
// than true because a resumable run refuses `secrets`, and the point is every field at once.
const MAX_RUN = {
	packages: false,
	image: "pi-job:2",
	resume: false,
	skillsDir: "/srv/skills",
	secrets: { STRIPE_KEY: "op://ci/stripe/api-key" },
	secretsProfile: "ci",
	backend: "local",
	excludeTools: ["bash"],
	provider: "openai",
	model: "gpt-5.4",
	maxTurns: 9,
	// #502 part 3. Lists the main model, which the loader requires when one trigger names all three.
	models: ["openai/gpt-5.4", "anthropic/claude-haiku-4-5"],
};
// The loader refuses some fields together (flow with command, command with instructions, waitFor with
// replicas), so each entry is loaded twice and the two variants between them set every field.
const VARIANTS = {
	"flow+replicas": { flow: "work", instructions: "Keep it short.", replicas: 2 },
	"command+waitFor": { command: "wf run", waitFor: [{ profile: "jira" }] },
};

// One entry per route each forge has, in each forge's own action words. Azure has no close route (the
// loader refuses an azure issue trigger, and azure has no pull_request close word).
const ENTRIES = {
	github: [
		{ route: "label", on: { type: "label", any: ["pi:go"] } },
		{ route: "comment", on: { type: "comment", phrase: "@pi" } },
		{ route: "pull_request", on: { type: "pull_request", action: ["opened"] } },
		{ route: "pr close", on: { type: "pull_request", action: ["closed"] } },
		{ route: "issue close", on: { type: "issue", action: ["closed"] } },
	],
	gitlab: [
		{ route: "label", on: { type: "label", any: ["pi:go"] } },
		{ route: "comment", on: { type: "comment", phrase: "@pi" } },
		{ route: "pull_request", on: { type: "pull_request", action: ["open"] } },
		{ route: "pr close", on: { type: "pull_request", action: ["close"] } },
		{ route: "issue close", on: { type: "issue", action: ["close"] } },
	],
	forgejo: [
		{ route: "label", on: { type: "label", any: ["pi:go"] } },
		{ route: "comment", on: { type: "comment", phrase: "@pi" } },
		{ route: "pull_request", on: { type: "pull_request", action: ["opened"] } },
		{ route: "pr close", on: { type: "pull_request", action: ["closed"] } },
		{ route: "issue close", on: { type: "issue", action: ["closed"] } },
	],
	azure: [
		{ route: "label", on: { type: "label", any: ["pi:go"] }, extra: { repository: "widgets" } },
		{ route: "comment", on: { type: "comment", phrase: "@pi" }, extra: { repository: "widgets" } },
		{ route: "pull_request", on: { type: "pull_request", action: ["created"] } },
	],
};

// Deliveries that reach each route. Shapes are the per-forge filter tests' own.
const GH = {
	label: ["issues", { action: "labeled", sender: { id: 7 }, repository: { full_name: "octo/repo" }, issue: { number: 42, title: "T", body: "B", labels: [{ name: "pi:go" }] } }],
	comment: ["issue_comment", { action: "created", sender: { id: 7 }, repository: { full_name: "octo/repo" }, issue: { number: 42, title: "T", body: "B", pull_request: false }, comment: { author_association: "OWNER", body: "@pi" } }],
	pull_request: ["pull_request", { action: "opened", sender: { id: 7 }, repository: { full_name: "octo/repo" }, pull_request: { number: 12, title: "PT", body: "PB", author_association: "COLLABORATOR", labels: [], head: { ref: "feat", sha: "abc", repo: { full_name: "octo/repo" } }, base: { ref: "main" } } }],
	"pr close": ["pull_request", { action: "closed", sender: { id: 7 }, repository: { full_name: "octo/repo" }, pull_request: { number: 12, title: "PT", body: "PB", author_association: "COLLABORATOR", labels: [], head: { ref: "feat", sha: "abc", repo: { full_name: "octo/repo" } }, base: { ref: "main" } } }],
	"issue close": ["issues", { action: "closed", sender: { id: 7 }, repository: { full_name: "octo/repo" }, issue: { number: 42, title: "T", body: "B", labels: [] } }],
};
const GL_PROJECT = { id: 42, path_with_namespace: "group/proj", default_branch: "main" };
const GL = {
	label: { object_kind: "issue", user: { id: 7, username: "dev" }, project: GL_PROJECT, object_attributes: { iid: 5, title: "T", description: "B", action: "update", labels: [{ title: "pi:go" }] }, changes: { labels: { previous: [], current: [{ title: "pi:go" }] } } },
	comment: { object_kind: "note", user: { id: 7, username: "dev" }, project: GL_PROJECT, object_attributes: { action: "create", note: "@pi", noteable_type: "Issue" }, issue: { iid: 5, title: "T", description: "B", labels: [] } },
	pull_request: { object_kind: "merge_request", user: { id: 7, username: "dev" }, project: GL_PROJECT, object_attributes: { iid: 12, title: "MR", description: "D", action: "open", labels: [] } },
	"pr close": { object_kind: "merge_request", user: { id: 7, username: "dev" }, project: GL_PROJECT, object_attributes: { iid: 12, title: "MR", description: "D", action: "close", labels: [] } },
	"issue close": { object_kind: "issue", user: { id: 7, username: "dev" }, project: GL_PROJECT, object_attributes: { iid: 5, title: "T", description: "B", action: "close", labels: [] }, changes: {} },
};
const FJ_REPO = { full_name: "acme/widgets" };
const FJ_PR = { number: 12, title: "PT", body: "PB", labels: [], head: { ref: "feature", sha: "abc", repo: { full_name: "acme/widgets" } }, base: { ref: "main" } };
const FJ = {
	label: ["issues", { action: "label_updated", sender: { id: 7, login: "alice" }, issue: { number: 7, title: "T", body: "B", labels: [{ name: "pi:go" }] }, repository: FJ_REPO }],
	comment: ["issue_comment", { action: "created", sender: { id: 7, login: "alice" }, issue: { number: 7, title: "T", body: "B", labels: [] }, comment: { body: "@pi" }, repository: FJ_REPO }],
	pull_request: ["pull_request", { action: "opened", sender: { id: 7, login: "alice" }, pull_request: FJ_PR, repository: FJ_REPO }],
	"pr close": ["pull_request", { action: "closed", sender: { id: 7, login: "alice" }, pull_request: FJ_PR, repository: FJ_REPO }],
	"issue close": ["issues", { action: "closed", sender: { id: 7, login: "alice" }, issue: { number: 7, title: "T", body: "B", labels: [] }, repository: FJ_REPO }],
};
const AZ_PROJECT = { id: "proj-guid", baseUrl: "https://dev.azure.com/contoso/" };
const AZ_SELF = { id: "self-guid", email: "pi-bot@example.com" };
const AZ = {
	label: { id: "d", eventType: "workitem.updated", resourceContainers: { project: AZ_PROJECT }, resource: { id: 7, fields: { "System.ChangedBy": { oldValue: "A <a@example.com>", newValue: "Dev <dev@example.com>" }, "System.Tags": { oldValue: "", newValue: "pi:go" } }, revision: { fields: { "System.Title": "T", "System.Description": "B", "System.Tags": "pi:go", "System.TeamProject": "Fabrikam" } } } },
	comment: { id: "d", eventType: "workitem.commented", resourceContainers: { project: AZ_PROJECT }, resource: { id: 7, fields: { "System.ChangedBy": "Dev <dev@example.com>", "System.History": "@pi" }, revision: { fields: { "System.Title": "T", "System.Description": "B", "System.TeamProject": "Fabrikam" } } } },
	pull_request: { id: "d", eventType: "git.pullrequest.created", resourceContainers: { project: AZ_PROJECT }, resource: { pullRequestId: 12, title: "PT", description: "PB", sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main", createdBy: { id: "member-guid" }, repository: { id: "repo-guid", name: "widgets", project: { id: "proj-guid", name: "Fabrikam" } } } },
};

// Drive ONE route of ONE forge against the grouped triggers, exactly as the receiver does.
function drive(forge, route, triggers) {
	const group = triggers[forge];
	const knownFlows = triggers.knownFlows;
	if (forge === "github") {
		const [event, subset] = GH[route];
		return filter(event, subset, { triggers }, 999, `d-${route}`, true);
	}
	if (forge === "gitlab") return filterGitLab(parseGitLabSubset(GL[route]), group, knownFlows, 999, true, `d-${route}`);
	if (forge === "forgejo") {
		const [event, payload] = FJ[route];
		return filterForgejo(event, parseForgejoSubset(payload), group, knownFlows, 999, true, `d-${route}`);
	}
	return filterAzure(parseAzureSubset(AZ[route]), group, knownFlows, AZ_SELF, true, `d-${route}`);
}

// One triggers file holding ONE entry, so the only rule a delivery can match is the maximal one.
function load(forge, entry, variant) {
	const raw = { on: entry.on, run: { kind: forge, ...MAX_RUN, ...variant, ...(entry.extra ?? {}) } };
	const json = JSON.stringify({ triggers: [raw] });
	const [normalized] = parseTriggers(json, "/t.json");
	const cfg = {};
	const res = reloadTriggers({ PI_TRIGGERS_FILE: "/t.json" }, cfg, { fileExists: () => true, readFile: () => json });
	assert.deepEqual(res, { ok: true }, `${forge} ${entry.route}: the maximal fixture must load`);
	return { normalized, triggers: cfg.triggers };
}

// The grouped rule config.mjs built for this entry, wherever the route put it.
function ruleOf(triggers, forge, route) {
	const g = triggers[forge];
	if (route === "label") return g.label[0];
	if (route === "comment") return g.comment;
	if (route === "pull_request") return g.pullRequest[0];
	if (route === "pr close") return g.prClose[0];
	return g.issue[0];
}

// The data enqueueForgeJob would store, captured off a fake queue (the queue tests' own shape). JSON round
// trip, because that is what BullMQ persists: a present-and-undefined key would vanish there.
async function enqueuedData(forge, job) {
	let captured;
	const fakeQueue = { add: async (_name, data, opts) => ((captured = data), { id: opts.jobId }) };
	await enqueueForgeJob(fakeQueue, forge, job);
	return JSON.parse(JSON.stringify(captured));
}

const execKeys = (normalized) => Object.keys(normalized.run).filter((k) => !ROUTING_ONLY.has(k) && normalized.run[k] !== undefined);

test("the maximal fixture really is maximal: it sets every field this test exists to protect", () => {
	// A guard on the guard. If the loader stopped emitting one of these, the derived set would shrink and
	// every assertion below would pass vacuously for that field.
	const keys = new Set(Object.values(VARIANTS).flatMap((v) => execKeys(load("github", ENTRIES.github[0], v).normalized)));
	for (const k of [...Object.keys(MAX_RUN), "flow", "command", "instructions", "replicas", "waitFor"]) assert.ok(keys.has(k), `normalized run lacks ${k}`);
});

for (const [forge, entries] of Object.entries(ENTRIES)) {
	for (const entry of entries) {
		for (const [vname, variant] of Object.entries(VARIANTS)) test(`${forge} ${entry.route} (${vname}): every execution key the loader emits reaches the job, through the group copy`, async () => {
			const { normalized, triggers } = load(forge, entry, variant);
			const keys = execKeys(normalized);

			// The group copy (receiver/src/config.mjs). The comment group names the flow `defaultFlow`.
			const rule = ruleOf(triggers, forge, entry.route);
			assert.ok(rule, `${forge} ${entry.route}: no grouped rule`);
			for (const k of keys) {
				const got = entry.route === "comment" && k === "flow" ? rule.defaultFlow : rule[k];
				assert.deepEqual(got, normalized.run[k], `${forge} ${entry.route}: config.mjs group copy dropped run.${k}`);
			}

			// The route and the job literal (receiver/src/filter*.mjs).
			const r = drive(forge, entry.route, triggers);
			assert.equal(r.enqueue, true, `${forge} ${entry.route}: the delivery must enqueue (${r.reason})`);
			for (const k of keys) {
				assert.deepEqual(r.job[k], normalized.run[k], `${forge} ${entry.route}: the filter dropped run.${k} on the way to the job`);
			}
			// And execution knobs stay OUT of `trigger`, which is copied verbatim into /job/event.json.
			for (const k of ["provider", "model", "maxTurns", "models"]) {
				assert.equal(k in r.job.trigger, false, `${forge} ${entry.route}: ${k} leaked into trigger`);
			}

			// The last hand-written hop: enqueueForgeJob (worker/src/queue.mjs) destructures and re-lists
			// every field, so a name it forgets is dropped between the filter and the stored job data.
			// The receiver hands the filter's job to it whole (receiver.mjs fanout), and so does this.
			const data = await enqueuedData(forge, r.job);
			for (const k of keys) {
				assert.deepEqual(data[k], normalized.run[k], `${forge} ${entry.route}: enqueueForgeJob dropped run.${k} from the job data`);
			}
		});
	}
}

test("absent stays absent: a trigger naming no model enqueues a job with no provider, model, maxTurns or models key", async () => {
	for (const [forge, entries] of Object.entries(ENTRIES)) {
		for (const entry of entries) {
			const raw = { on: entry.on, run: { kind: forge, flow: "work", ...(entry.extra ?? {}) } };
			const json = JSON.stringify({ triggers: [raw] });
			const cfg = {};
			reloadTriggers({ PI_TRIGGERS_FILE: "/t.json" }, cfg, { fileExists: () => true, readFile: () => json });
			const r = drive(forge, entry.route, cfg.triggers);
			assert.equal(r.enqueue, true, `${forge} ${entry.route}: ${r.reason}`);
			for (const k of ["provider", "model", "maxTurns", "models"]) assert.equal(k in r.job, false, `${forge} ${entry.route}: ${k}`);
			const data = await enqueuedData(forge, r.job);
			for (const k of ["provider", "model", "maxTurns", "models"]) assert.equal(k in data, false, `${forge} ${entry.route}: ${k} in stored data`);
		}
	}
});
