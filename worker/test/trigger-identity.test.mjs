import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { forgeTriggerMismatch, isForgeTriggerOf, routableFlows } from "../src/trigger-identity.mjs";
import { makeCheckWaitSkew, makeFindSecretBundle } from "../src/triggers-file.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODULE_PATH = "worker/src/trigger-identity.mjs";

// Issue #933's own triggers file: a GitLab merge request rule (label-gated, so the receiver reports a label match), a
// GitHub pull request rule for flow `review`, and a GitHub comment rule on flow `fix`. Both narrowed rules cap spend.
const GITLAB_MR = { on: { type: "pull_request", action: ["update"], any: ["pi:go"] }, run: { kind: "gitlab", flow: "work", maxCostUsd: 2 } };
const GITHUB_PR = { on: { type: "pull_request", action: ["opened"] }, run: { kind: "github", flow: "review" } };
const GITHUB_COMMENT = { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", maxCostUsd: 2 } };
const FILE = [GITLAB_MR, GITHUB_PR, GITHUB_COMMENT];

const labelMr = { kind: "gitlab", flow: "work", target: { type: "pull_request" }, trigger: { matched: { index: 0, type: "label", label: "pi:go" } } };
const ownComment = { kind: "github", flow: "fix", target: { type: "issue" }, trigger: { matched: { index: 2, type: "comment", phrase: "@pi" } } };
const routedComment = { ...ownComment, flow: "review" };

test("routableFlows is the receiver's knownFlows: forge entries' flows, never a cron, watch, local, disarmed or command entry's", () => {
	const flows = routableFlows([
		GITHUB_PR,
		{ on: { type: "cron", id: "n", pattern: "0 0 * * *" }, run: { kind: "local", folder: "/f", flow: "nightly", task: "t" } },
		{ on: { type: "watch", id: "w" }, run: { kind: "github", flow: "watched" } },
		{ on: { type: "label", any: ["x"] }, run: { kind: "local", folder: "/f", flow: "listener" } },
		{ on: { type: "issue", action: ["closed"], once: true, disarmed: { at: "2026-11-18T00:00:00.000Z" } }, run: { kind: "github", flow: "spent-raw" } },
		{ on: { type: "disarmed" }, run: {} },
		{ on: { type: "label", any: ["y"] }, run: { kind: "github", command: "lint" } },
		null,
	]);
	assert.deepEqual([...flows], ["review"]);
	assert.deepEqual([...routableFlows(undefined)], []);
});

test("the identity: the two shapes #933 names are the entry's jobs, and every part that changed says which", () => {
	assert.equal(forgeTriggerMismatch(FILE, GITLAB_MR, labelMr), null, "a GitLab merge request a label matched is its pull_request rule's job");
	assert.equal(forgeTriggerMismatch(FILE, GITHUB_COMMENT, routedComment), null, "a comment routed to another trigger's flow is the comment rule's job");
	assert.equal(forgeTriggerMismatch(FILE, GITHUB_COMMENT, ownComment), null);
	assert.equal(forgeTriggerMismatch(FILE, GITLAB_MR, { ...labelMr, target: { type: "issue" } }), "type", "a label match on an issue is not a merge request rule's");
	assert.equal(forgeTriggerMismatch(FILE, GITHUB_COMMENT, { ...routedComment, flow: "unheard-of" }), "lane", "a flow no forge trigger holds was never routable");
	assert.equal(forgeTriggerMismatch(FILE, GITLAB_MR, { ...labelMr, kind: "github" }), "kind");
	assert.equal(forgeTriggerMismatch(FILE, GITLAB_MR, { ...labelMr, trigger: { matched: { index: 0, type: "label", label: "pi:other" } } }), "label");
	assert.equal(forgeTriggerMismatch(FILE, GITHUB_PR, { kind: "github", flow: "review", trigger: { matched: { index: 1, type: "pull_request", action: "closed" } } }), "action");
	assert.equal(forgeTriggerMismatch(FILE, GITHUB_COMMENT, { ...ownComment, trigger: { matched: { index: 2, type: "comment", phrase: "/pi" } } }), "phrase");
	assert.equal(forgeTriggerMismatch(FILE, undefined, ownComment), "entry");
	assert.equal(forgeTriggerMismatch(FILE, GITHUB_COMMENT, { kind: "github", flow: "fix" }), "entry", "a job with no matched record names no entry");
	// The command lane: same command, and never a flow job on a command entry or the reverse.
	const lint = { on: { type: "label", any: ["lint"] }, run: { kind: "github", command: "lint" } };
	const lintJob = { kind: "github", command: "lint", trigger: { matched: { index: 0, type: "label", label: "lint" } } };
	assert.equal(forgeTriggerMismatch([lint], lint, lintJob), null);
	assert.equal(forgeTriggerMismatch([lint], lint, { ...lintJob, command: "fmt" }), "lane");
	assert.equal(forgeTriggerMismatch([lint], lint, { kind: "github", flow: "lint", trigger: lintJob.trigger }), "lane");
	// A raw, unvalidated entry: a string `action` is not a list, so it holds no action (never a substring match).
	assert.equal(forgeTriggerMismatch([], { on: { type: "pull_request", action: "reopened" }, run: { kind: "github", flow: "f" } }, { kind: "github", flow: "f", trigger: { matched: { index: 0, type: "pull_request", action: "open" } } }), "action");
	assert.equal(isForgeTriggerOf(FILE, GITLAB_MR, labelMr), true);
	assert.equal(isForgeTriggerOf(FILE, GITLAB_MR, { ...labelMr, kind: "github" }), false);
});

// The skew check reads the file raw through `fs`; no statSync, so nothing is cached between cases.
const skew = (triggers) => makeCheckWaitSkew({ triggersPath: "/t.json", fs: { readFileSync: () => JSON.stringify({ triggers }) } });

test("issue #933's reproduction: a dropped narrowing field is refused for a label-matched merge request and a routed comment", async () => {
	const check = skew(FILE);
	// The controls, refused before the fix too.
	assert.deepEqual(await check({ ...labelMr, trigger: { matched: { index: 0, type: "pull_request", action: "update" } } }), { skewed: true, field: "maxCostUsd" });
	assert.deepEqual(await check(ownComment), { skewed: true, field: "maxCostUsd" });
	// The two shapes the old reading answered `{ ok: true }` for.
	assert.deepEqual(await check(labelMr), { skewed: true, field: "maxCostUsd" });
	assert.deepEqual(await check(routedComment), { skewed: true, field: "maxCostUsd" });
	// Still fail-open where the entry is not the job's: a flow nobody could route to, another forge, a moved label.
	assert.deepEqual(await check({ ...routedComment, flow: "unheard-of" }), { ok: true });
	assert.deepEqual(await check({ ...labelMr, target: { type: "issue" } }), { ok: true });
	assert.deepEqual(await check({ ...labelMr, trigger: { matched: { index: 0, type: "label", label: "pi:gone" } } }), { ok: true });
	// The job that arrived with the field is not skewed.
	assert.deepEqual(await check({ ...labelMr, maxCostUsd: 2 }), { ok: true });
});

test("issue #933: the same two shapes are refused for a dropped waitFor", async () => {
	const waitFor = [{ after: "2026-12-01T00:00:00Z" }];
	const check = skew([{ ...GITLAB_MR, run: { kind: "gitlab", flow: "work", waitFor } }, GITHUB_PR, { ...GITHUB_COMMENT, run: { kind: "github", flow: "fix", waitFor } }]);
	assert.deepEqual(await check(labelMr), { skewed: true, conditions: 1 });
	assert.deepEqual(await check(routedComment), { skewed: true, conditions: 1 });
});

test("issue #933: a GitLab merge request a label matched finds its project's secret bundle instead of a changed trigger", () => {
	const bundles = { shop: { profile: "shop-env", ref: "shop", project: "shop" } };
	const text = (triggers) => JSON.stringify({ triggers, secretBundles: bundles });
	let current = text([GITLAB_MR, GITHUB_PR, GITHUB_COMMENT]);
	const find = makeFindSecretBundle({ triggersPath: "/t.json", fs: { statSync: () => ({ mtimeMs: Math.random(), size: 1 }), readFileSync: () => current } });
	assert.deepEqual(find(labelMr, { project: "shop" }), { id: "shop", bundle: bundles.shop, optedOut: false, entry: "forge" });
	assert.deepEqual(find(routedComment, { project: "shop" }), { id: "shop", bundle: bundles.shop, optedOut: false, entry: "forge" });
	current = text([{ ...GITLAB_MR, on: { ...GITLAB_MR.on, any: ["pi:other"] } }, GITHUB_PR, GITHUB_COMMENT]);
	assert.equal(find(labelMr, { project: "shop" }).triggerChanged, true, "a rule that no longer selects the label is a changed trigger");
});

// ---------------------------------------------------------------------------------------------------------------------
// One reading, one place. The scan reads code with comments stripped, a line at a time, for the shapes the five readings
// this module replaced were spelled in (each planted below is a line one of them had), the same kind of scan as
// `bullmq-internals.test.mjs`. It misses a spelling built across lines or from other names; review catches those.
// ---------------------------------------------------------------------------------------------------------------------

const SCAN_TREES = ["worker/src", "receiver/src", "admin/src", "image/runner", "gateway/src"];
const SCAN_SKIP = new Set(["test", "node_modules", "dist"]);
const SCAN_EXTS = new Set([".mjs", ".js", ".cjs", ".ts", ".mts"]);

const IDENTITY_PATTERNS = Object.freeze({
	"the label-on-merge-request widening": /matched\??\.type\s*===\s*"label"\s*&&|on\??\.type\s*===\s*"pull_request"\s*&&\s*[\w.?]*target\??\.type\s*===\s*"pull_request"/,
	"a matched action or label looked up in an entry": /\.includes\(\s*[\w.?]*matched\??\.(?:action|label)\s*\)/,
	"a matched phrase compared with an entry's": /\.phrase\s*!==\s*[\w.?]*matched\??\.phrase/,
	"a comment entry's flow override": /\.type\s*===\s*"comment"\s*(?:&&[^;]*\.flow\s*===|\|\|)/,
});

function stripComments(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, "")).replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function scanSources() {
	const out = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) {
				if (!SCAN_SKIP.has(name)) walk(p);
			} else if (SCAN_EXTS.has(extname(name))) out.push(p);
		}
	};
	for (const tree of SCAN_TREES) walk(join(REPO_ROOT, tree));
	return out.map((p) => ({ path: relative(REPO_ROOT, p), code: stripComments(readFileSync(p, "utf8")) }));
}

function identityHits(files) {
	const hits = [];
	for (const file of files) {
		file.code.split("\n").forEach((text, i) => {
			for (const [what, re] of Object.entries(IDENTITY_PATTERNS)) if (re.test(text)) hits.push({ path: file.path, line: i + 1, what, text: text.trim() });
		});
	}
	return hits;
}

test("the forge trigger identity has one owner: no other source file spells a part of it", () => {
	const files = scanSources();
	for (const tree of SCAN_TREES) assert.ok(files.some((f) => f.path.startsWith(`${tree}/`)), `the scan reaches ${tree}`);
	const hits = identityHits(files);
	// This receipt checks a stored GitHub delivery against its target, not a triggers.json entry or the GitLab
	// label-on-merge-request widening. Pin the one false positive exactly; every other spelling remains refused.
	const receiptRoute = (h) => h.path === "worker/src/terminal-receipt.mjs" && h.what === "the label-on-merge-request widening" && h.text === 'const issue = trigger.event === "issues" && trigger.matched?.type === "label" && data.target?.type === "issue";';
	assert.equal(hits.filter(receiptRoute).length, 1, "the receipt exception must match exactly its one source line");
	assert.deepEqual(hits.filter((h) => h.path !== MODULE_PATH && !receiptRoute(h)).map((h) => `${h.path}:${h.line}: ${h.what}: ${h.text}`), [],
		`ask ${MODULE_PATH} (isForgeTriggerOf, forgeTriggerMismatch, routableFlows) instead of reading the entry again`);
	const own = new Set(hits.filter((h) => h.path === MODULE_PATH).map((h) => h.what));
	for (const what of Object.keys(IDENTITY_PATTERNS)) {
		if (what === "a comment entry's flow override") continue; // the module spells it across a ternary, not on one line
		assert.ok(own.has(what), `the module itself matches ${what}`);
	}
});

test("the identity scan is not vacuous: each pattern catches a line one of the replaced readings had", () => {
	const planted = {
		"the label-on-merge-request widening": [
			'const sameType = entry?.on?.type === matched.type || (matched.type === "label" && entry?.on?.type === "pull_request" && job.target?.type === "pull_request");',
			'const typeOk = on.type === matched.type || (matched.type === "label" && on.type === "pull_request" && data?.target?.type === "pull_request");',
		],
		"a matched action or label looked up in an entry": [
			'|| (typeof matched.action === "string" && !entry.on.action?.includes(matched.action))',
			'if (typeof matched.label === "string" && ![...(entry.on.any ?? []), ...(entry.on.all ?? [])].includes(matched.label)) return changed();',
		],
		"a matched phrase compared with an entry's": [
			'if (typeof matched.phrase === "string" && entry.on.phrase !== matched.phrase) return changed();',
			'if (found.trigger?.matched?.type === "comment" && entries[index]?.on.phrase !== found.trigger.matched.phrase) return x;',
		],
		"a comment entry's flow override": [
			'const sameFlow = entry?.run?.flow === job.flow || (entry?.on?.type === "comment" && entries.some((t) => forgeTrigger(t.on.type) && t.run.flow === job.flow));',
			'const sameFlow = matched.type === "comment" || candidate?.run?.flow === job.flow;',
		],
	};
	assert.deepEqual(Object.keys(planted), Object.keys(IDENTITY_PATTERNS), "every pattern has its planted spellings");
	for (const [what, lines] of Object.entries(planted)) {
		for (const text of lines) assert.ok(identityHits([{ path: "admin/src/planted.mjs", code: text }]).some((h) => h.what === what), `${what}: ${text}`);
	}
	assert.deepEqual(identityHits([{ path: "admin/src/planted.mjs", code: stripComments('// matched.type === "label" && on.type\n/* .includes(matched.action) */\nconst x = 1;') }]), [], "a comment is no spelling");
});
