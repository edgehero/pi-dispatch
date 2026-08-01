import assert from "node:assert/strict";
import { test } from "node:test";
import { loadReceiverConfig, reloadTriggers } from "../src/config.mjs";
import { FORGE_KINDS } from "@pi-dispatch/worker/triggers";

// A valid unified triggers file, injected: exists and parses to one of each webhook type. The exhaustive
// schema validation lives in the shared validator's own suite (worker/test/triggers.test.mjs); here we
// assert the receiver surfaces those errors fail-loud and groups the webhook triggers for the filter.
const TRIGGERS_JSON = JSON.stringify({
	triggers: [
		{ on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix" } },
		{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "triage" } },
		{ on: { type: "pull_request", action: ["labeled"], any: ["pi:review"] }, run: { kind: "github", flow: "review" } },
	],
});
const validTriggers = { fileExists: () => true, readFile: () => TRIGGERS_JSON };

/** Inject a triggers file whose raw JSON is `json`, with WEBHOOK_SECRET present. */
function withTriggers(json) {
	return () => loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
}

test("missing WEBHOOK_SECRET is a config error -- never boot unable to verify signatures", () => {
	assert.throws(() => loadReceiverConfig({}, validTriggers), (e) => e.piDispatchConfig === true);
});

test("empty/whitespace WEBHOOK_SECRET is a config error", () => {
	assert.throws(() => loadReceiverConfig({ WEBHOOK_SECRET: "" }, validTriggers), (e) => e.piDispatchConfig === true);
	assert.throws(() => loadReceiverConfig({ WEBHOOK_SECRET: "   " }, validTriggers), (e) => e.piDispatchConfig === true);
});

test("a valid secret + triggers file yields conservative defaults and grouped webhook triggers", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validTriggers);
	assert.equal(c.webhookSecret, "shh");
	assert.equal(c.bind, "0.0.0.0");
	assert.equal(c.port, 3000);

	// label rules, in file order; each carries its raw-file index (the rule's identity for matched.index).
	assert.equal(c.triggers.github.label.length, 1);
	assert.equal(c.triggers.github.label[0].index, 0);
	assert.equal(c.triggers.github.label[0].flow, "frontend-fix");
	assert.deepEqual(c.triggers.github.label[0].predicate.any, ["pi:frontend"]);

	// the single comment trigger. `packages` is asserted present-and-undefined: the grouper builds the key
	// by construction and this whole-object deepEqual (assert/strict) counts an own undefined-valued key.
	assert.deepEqual(c.triggers.github.comment, { index: 1, phrase: "@pi", defaultFlow: "triage", packages: undefined, image: undefined, resume: undefined, replicas: undefined, repository: undefined });

	// pull_request rules: actions is a Set, predicate carries the label selectors.
	assert.equal(c.triggers.github.pullRequest.length, 1);
	assert.equal(c.triggers.github.pullRequest[0].index, 2);
	assert.equal(c.triggers.github.pullRequest[0].flow, "review");
	assert.ok(c.triggers.github.pullRequest[0].actions.has("labeled"));
	assert.deepEqual(c.triggers.github.pullRequest[0].predicate.any, ["pi:review"]);

	// knownFlows spans every webhook flow (the comment `<phrase> <flow>` override allowlist).
	assert.deepEqual([...c.triggers.knownFlows].sort(), ["frontend-fix", "review", "triage"]);
});

test("the trigger groups cover exactly FORGE_KINDS -- a forge with no group is a silently stale receiver", () => {
	// The failure this guards is not a crash. `groups[run.kind]` on a missing forge is undefined,
	// `group.label.push` throws, and `reloadTriggers` catches everything and KEEPS the previous triggers --
	// so the operator edits their file, sees one "invalid" message, and yesterday's rules go on firing.
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validTriggers);
	const grouped = Object.keys(c.triggers).filter((k) => k !== "knownFlows");
	assert.deepEqual(grouped.sort(), [...FORGE_KINDS].sort(), "every forge the schema accepts must have a group here");
});

test("a trigger on EVERY forge the schema accepts groups without throwing", () => {
	// Written as a loop over the table rather than one case per forge, so adding a forge to FORGE_KINDS and
	// forgetting the group fails HERE, at load, instead of inside a live reload that swallows it.
	const json = JSON.stringify({
		// `run.repository` is required on an azure label trigger and refused on every other forge's: an Azure
		// work item belongs to a project, not a repository, so nothing in the delivery says where to clone.
		triggers: FORGE_KINDS.map((kind) => ({
			on: { type: "label", any: ["pi:go"] },
			run: { kind, flow: "fix", ...(kind === "azure" ? { repository: "widgets" } : {}) },
		})),
	});
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	for (const kind of FORGE_KINDS) {
		assert.equal(c.triggers[kind].label.length, 1, `${kind}: its label rule must reach the filter, not vanish`);
	}
});

test("no comment trigger in the file -> c.triggers.github.comment is null (comment path disabled)", () => {
	const json = JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:x"] }, run: { kind: "github", flow: "fix" } }] });
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.equal(c.triggers.github.comment, null);
});

test("cron triggers in the shared file are validated but ignored by the receiver's groups", () => {
	const json = JSON.stringify({
		triggers: [
			{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/p", flow: "tidy", task: "t" } },
			{ on: { type: "label", any: ["pi:x"] }, run: { kind: "github", flow: "fix" } },
		],
	});
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.equal(c.triggers.github.label.length, 1);
	assert.equal(c.triggers.github.pullRequest.length, 0);
	assert.equal(c.triggers.github.comment, null);
});

test("rule indices are RAW file positions -- a leading cron entry still occupies index 0", () => {
	// The index is the entry's identity IN THE FILE, so a skipped cron rule must shift the webhook
	// rules' indices, never compact them: matched.index must point back at the exact triggers.json entry.
	const json = JSON.stringify({
		triggers: [
			{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/p", flow: "tidy", task: "t" } },
			{ on: { type: "label", any: ["pi:x"] }, run: { kind: "github", flow: "fix" } },
			{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "triage" } },
			{ on: { type: "pull_request", action: ["labeled"], any: ["pi:review"] }, run: { kind: "github", flow: "review" } },
		],
	});
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.equal(c.triggers.github.label[0].index, 1);
	assert.equal(c.triggers.github.comment.index, 2);
	assert.equal(c.triggers.github.pullRequest[0].index, 3);
});

// -- the per-trigger pi-packages opt-in (INT-TRIGGERS-FILE-CONTRACT, REQ-GLOBAL-PI-OVERLAY) -------

test("each grouped webhook rule carries its own run.packages flag through to the filter", () => {
	// Deliberately MIXED: the flag rides on the RULE, so a file where rules disagree must group them
	// disagreeing -- the filter resolves it from whichever rule matched, never from a file-wide default.
	const json = JSON.stringify({
		triggers: [
			{ on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix", packages: true } },
			{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "triage", packages: true } },
			{ on: { type: "pull_request", action: ["labeled"], any: ["pi:review"] }, run: { kind: "github", flow: "review", packages: false } },
			{ on: { type: "label", any: ["pi:docs"] }, run: { kind: "github", flow: "docs" } },
		],
	});
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.equal(c.triggers.github.label[0].packages, true);
	assert.equal(c.triggers.github.comment.packages, true);
	assert.equal(c.triggers.github.pullRequest[0].packages, false, "an explicit opt-out is grouped as false, never dropped");
	assert.equal(c.triggers.github.label[1].packages, undefined, "an unflagged rule in the same file stays unflagged");
});

test("each grouped webhook rule carries its own run.image through to the filter", () => {
	// Deliberately MIXED. `image` rides on the RULE for a sharper reason than packages: two rules in one file
	// may name DIFFERENT images, and grouping a file-wide value would run the wrong toolchain for whichever
	// rule lost.
	const json = JSON.stringify({
		triggers: [
			{ on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix", image: "node-playwright:1.4.0" } },
			{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "triage", image: "my-python:1.2.0" } },
			{ on: { type: "pull_request", action: ["labeled"], any: ["pi:review"] }, run: { kind: "github", flow: "review", image: "reviewer:2.0" } },
			{ on: { type: "label", any: ["pi:docs"] }, run: { kind: "github", flow: "docs" } },
		],
	});
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.equal(c.triggers.github.label[0].image, "node-playwright:1.4.0");
	assert.equal(c.triggers.github.comment.image, "my-python:1.2.0");
	assert.equal(c.triggers.github.pullRequest[0].image, "reviewer:2.0");
	assert.equal(c.triggers.github.label[1].image, undefined, "an unflagged rule in the same file runs the deployment default");
});

test("an unflagged triggers file groups packages as undefined on every rule -- the no-third-party-code default", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validTriggers);
	assert.equal(c.triggers.github.label[0].packages, undefined);
	assert.equal(c.triggers.github.comment.packages, undefined);
	assert.equal(c.triggers.github.pullRequest[0].packages, undefined);
});

test("RECEIVER_PORT and RECEIVER_BIND overrides are honored", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh", RECEIVER_PORT: "8080", RECEIVER_BIND: "127.0.0.1" }, validTriggers);
	assert.equal(c.port, 8080);
	assert.equal(c.bind, "127.0.0.1");
});

test("valkeyUrl defaults to the local Valkey, mirroring the worker default", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validTriggers);
	assert.equal(c.valkeyUrl, "redis://127.0.0.1:6379");
});

test("VALKEY_URL override is honored", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh", VALKEY_URL: "redis://valkey:6380/2" }, validTriggers);
	assert.equal(c.valkeyUrl, "redis://valkey:6380/2");
});

test("a malformed RECEIVER_PORT is a config error, not a silent NaN", () => {
	assert.throws(() => loadReceiverConfig({ WEBHOOK_SECRET: "shh", RECEIVER_PORT: "nope" }, validTriggers), (e) => e.piDispatchConfig === true);
});

// -- the receiver surfaces the shared validator's errors fail-loud -------------------------------

test("a missing triggers file is a config error -- no silent empty allowlist", () => {
	assert.throws(
		() => loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => false, readFile: () => "" }),
		(e) => e.piDispatchConfig === true,
	);
});

test("malformed triggers JSON is a config error", () => {
	assert.throws(withTriggers("{not json"), (e) => e.piDispatchConfig === true);
});

test("a none-only label rule is a config error -- no positive selector would widen the trigger surface", () => {
	assert.throws(withTriggers(JSON.stringify({ triggers: [{ on: { type: "label", none: ["blocked"] }, run: { kind: "github", flow: "fix" } }] })), (e) => e.piDispatchConfig === true);
});

test("the on x run diagonal is enforced at load: a cron -> github trigger is a config error", () => {
	assert.throws(withTriggers(JSON.stringify({ triggers: [{ on: { type: "cron", id: "x", pattern: "0 3 * * *" }, run: { kind: "github", flow: "fix" } }] })), (e) => e.piDispatchConfig === true);
});

test("a triggers file that is not a {triggers:[...]} object is a config error", () => {
	assert.throws(withTriggers(JSON.stringify(["frontend-fix"])), (e) => e.piDispatchConfig === true);
	assert.throws(withTriggers(JSON.stringify({ nope: [] })), (e) => e.piDispatchConfig === true);
});

// -- github auth block (unchanged, single-sourced from the worker loader) ------------------------

test("github block is produced by the shared worker loader -- default gh source, exact block shape", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validTriggers);
	assert.deepEqual(c.github, {
		source: "gh",
		patVar: "GITHUB_PAT",
		appId: undefined,
		installationId: undefined,
		privateKeyPath: undefined,
	});
});

test("github block reflects env just as the worker loader does (source=pat echoes patVar)", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh", GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_x" }, validTriggers);
	assert.equal(c.github.source, "pat");
	assert.equal(c.github.patVar, "GITHUB_PAT");
});

// -- live reload (the testable core of the receiver's trigger watcher) ---------------------------

test("reloadTriggers swaps cfg.triggers in place from the new file (live, no restart)", () => {
	const cfg = { triggers: { label: [{ predicate: { any: ["old"] }, flow: "old-flow" }], comment: null, pullRequest: [], knownFlows: new Set(["old-flow"]) } };
	const json = JSON.stringify({ triggers: [{ on: { type: "label", any: ["new"] }, run: { kind: "github", flow: "new-flow" } }] });
	const res = reloadTriggers({}, cfg, { fileExists: () => true, readFile: () => json });
	assert.deepEqual(res, { ok: true });
	assert.equal(cfg.triggers.github.label[0].flow, "new-flow");
	assert.deepEqual(cfg.triggers.github.label[0].predicate.any, ["new"]);
});

test("reloadTriggers keeps the running triggers when the new file is invalid (never crash a live receiver)", () => {
	const original = { label: [{ predicate: { any: ["old"] }, flow: "keep" }], comment: null, pullRequest: [], knownFlows: new Set() };
	const cfg = { triggers: original };
	const res = reloadTriggers({}, cfg, { fileExists: () => true, readFile: () => "{ not json" });
	assert.ok(res.invalid, "an invalid reload reports the reason");
	assert.equal(cfg.triggers, original, "cfg.triggers is left untouched on an invalid reload");
});

test("reloadTriggers keeps the running triggers when the file goes missing", () => {
	const original = { label: [], comment: null, pullRequest: [], knownFlows: new Set() };
	const cfg = { triggers: original };
	const res = reloadTriggers({}, cfg, { fileExists: () => false, readFile: () => "" });
	assert.ok(res.invalid);
	assert.equal(cfg.triggers, original);
});

// --- per-forge rule grouping (issue #42) ---

const MIXED_JSON = JSON.stringify({
	triggers: [
		{ on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix" } },
		{ on: { type: "label", any: ["pi:frontend"] }, run: { kind: "gitlab", flow: "gl-fix" } },
		{ on: { type: "comment", phrase: "@pi" }, run: { kind: "gitlab", flow: "gl-triage" } },
		{ on: { type: "pull_request", action: ["open"] }, run: { kind: "gitlab", flow: "gl-review" } },
	],
});

test("rules are grouped per forge -- an identically-labelled rule lands on ONE forge, not both", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => MIXED_JSON });

	// Both rules select `pi:frontend`. Grouping is what stops a github delivery from matching the gitlab
	// rule (and running the wrong flow against the wrong forge) purely because the labels coincide.
	assert.equal(c.triggers.github.label.length, 1);
	assert.equal(c.triggers.github.label[0].flow, "frontend-fix");
	assert.equal(c.triggers.gitlab.label.length, 1);
	assert.equal(c.triggers.gitlab.label[0].flow, "gl-fix");

	assert.equal(c.triggers.github.comment, null, "the file's only comment trigger is gitlab's");
	assert.equal(c.triggers.gitlab.comment.phrase, "@pi");
	assert.equal(c.triggers.github.pullRequest.length, 0);
	assert.equal(c.triggers.gitlab.pullRequest[0].flow, "gl-review");

	// The raw file index stays the rule's identity across forges -- it is what makes a run explainable
	// back to the exact entry that fired it, so the two groups must not restart their own numbering.
	assert.deepEqual(
		[c.triggers.github.label[0].index, c.triggers.gitlab.label[0].index, c.triggers.gitlab.comment.index, c.triggers.gitlab.pullRequest[0].index],
		[0, 1, 2, 3],
	);

	// knownFlows is the whole file's vocabulary, not one forge's: it bounds which names a comment may
	// summon, and that bound is the same question regardless of which forge asked.
	assert.deepEqual([...c.triggers.knownFlows].sort(), ["frontend-fix", "gl-fix", "gl-review", "gl-triage"]);
});

test("a forge the file never mentions still gets an empty group -- the gate needs no presence check", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validTriggers);
	assert.deepEqual(c.triggers.gitlab, { label: [], comment: null, pullRequest: [] });
});

// --- the gitlab endpoint's configuration (issue #42) ---

const glEnv = { WEBHOOK_SECRET: "shh", GITLAB_WEBHOOK_MODE: "token", GITLAB_WEBHOOK_SECRET: "gl-secret", GITLAB_TOKEN: "glpat-x" };

test("no gitlab variables at all -> cfg.gitlab is null, and no /gitlab route exists", () => {
  const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validTriggers);
  assert.equal(c.gitlab, null, "an endpoint that answers is an endpoint an operator can believe is armed");
});

test("a complete gitlab config loads, defaulting only the instance URL", () => {
  const c = loadReceiverConfig(glEnv, validTriggers);
  assert.deepEqual(c.gitlab, { mode: "token", secret: "gl-secret", token: "glpat-x", apiUrl: "https://gitlab.com" });
  assert.equal(loadReceiverConfig({ ...glEnv, GITLAB_URL: "https://gl.internal" }, validTriggers).gitlab.apiUrl, "https://gl.internal");
});

test("GITLAB_WEBHOOK_MODE is required and never defaulted -- the two modes are not equally strong", () => {
  // Defaulting to `token` would silently downgrade an operator who did not know the field existed;
  // defaulting to `signature` would break every instance below GitLab 19.0. So it must be chosen.
  for (const mode of [undefined, "", "hmac", "signature-v1"]) {
    assert.throws(
      () => loadReceiverConfig({ ...glEnv, GITLAB_WEBHOOK_MODE: mode }, validTriggers),
      (e) => e.piDispatchConfig === true,
      `mode ${JSON.stringify(mode)} must refuse at boot`,
    );
  }
  assert.doesNotThrow(() => loadReceiverConfig({ ...glEnv, GITLAB_WEBHOOK_MODE: "signature" }, validTriggers));
});

test("a partially-configured gitlab endpoint refuses at boot rather than half-arming", () => {
  // Each of these would produce an endpoint that accepts nothing, or one that 503s every delivery
  // because it can never resolve an access level. One clear message beats a redelivery loop.
  assert.throws(() => loadReceiverConfig({ ...glEnv, GITLAB_WEBHOOK_SECRET: undefined }, validTriggers), (e) => e.piDispatchConfig === true);
  assert.throws(() => loadReceiverConfig({ ...glEnv, GITLAB_TOKEN: undefined }, validTriggers), (e) => e.piDispatchConfig === true);
  assert.throws(() => loadReceiverConfig({ ...glEnv, GITLAB_TOKEN: "   " }, validTriggers), (e) => e.piDispatchConfig === true);
});
