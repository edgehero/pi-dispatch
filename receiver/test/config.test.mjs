import assert from "node:assert/strict";
import { test } from "node:test";
import { loadReceiverConfig, reloadTriggers, triggersFilePath } from "../src/config.mjs";
import { filter } from "../src/filter.mjs";
import { FORGE_KINDS } from "@edgehero/pi-dispatch/triggers";

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

// `validTriggers` names github rules, so every case below is a GITHUB-SERVING deployment and the secret
// requirement is exactly what it always was. The conditional half -- a deployment that serves no github --
// is pinned in its own section at the foot of this file (issue #99).
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
	assert.deepEqual(c.triggers.github.comment, { index: 1, phrase: "@pi", defaultFlow: "triage", command: undefined, packages: undefined, image: undefined, skillsDir: undefined, instructions: undefined, resume: undefined, secrets: undefined, secretsProfile: undefined, waitFor: undefined, replicas: undefined, repository: undefined });

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

// -- run.command triggers (issue #189): a rule may dispatch a registered pi extension command ------

test("each grouped webhook rule carries its own run.command through to the filter", () => {
	// Deliberately MIXED with a flow rule, per the packages/image template: `command` rides the RULE, so a
	// file where rules disagree must group them disagreeing -- the filter resolves it from whichever rule
	// matched, never from a file-wide default.
	const json = JSON.stringify({
		triggers: [
			{ on: { type: "label", any: ["pi:standup"] }, run: { kind: "github", command: "standup" } },
			{ on: { type: "comment", phrase: "@pi-run" }, run: { kind: "github", command: "wf run nightly" } },
			{ on: { type: "pull_request", action: ["labeled"], any: ["pi:check"] }, run: { kind: "github", command: "check" } },
			{ on: { type: "label", any: ["pi:docs"] }, run: { kind: "github", flow: "docs" } },
		],
	});
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.equal(c.triggers.github.label[0].command, "standup");
	assert.equal(c.triggers.github.label[0].flow, undefined, "a command rule resolves no flow -- the exclusivity is parse-enforced");
	assert.equal(c.triggers.github.comment.command, "wf run nightly");
	assert.equal(c.triggers.github.comment.defaultFlow, undefined, "a command comment rule has no default flow to fall back to");
	assert.equal(c.triggers.github.pullRequest[0].command, "check");
	assert.equal(c.triggers.github.pullRequest[0].flow, undefined);
	assert.equal(c.triggers.github.label[1].command, undefined, "a flow rule in the same file grows no command");
	assert.equal(c.triggers.github.label[1].flow, "docs");
});

test("a command trigger adds NOTHING to knownFlows -- and the flow triggers' override vocabulary survives beside it", () => {
	// The failure this guards: `knownFlows.add(run.flow)` on a command trigger is `Set.add(undefined)`,
	// quietly poisoning the comment `<phrase> <flow>` override allowlist with a non-name. The set must
	// hold exactly the flow rules' names -- nothing more, nothing missing.
	const json = JSON.stringify({
		triggers: [
			{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "triage" } },
			{ on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix" } },
			{ on: { type: "label", any: ["pi:standup"] }, run: { kind: "github", command: "standup" } },
		],
	});
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.deepEqual([...c.triggers.knownFlows].sort(), ["frontend-fix", "triage"], "exactly the flow rules' names");
	assert.equal(c.triggers.knownFlows.has(undefined), false, "Set.add(undefined) is the poisoning this pins out");

	// The consequence, driven through the real filter with the loaded config: the OTHER (flow) comment
	// trigger's `<phrase> <flow>` override still resolves a known flow, command trigger present or not.
	const subset = {
		action: "created",
		sender: { id: 7 },
		repository: { full_name: "octo/repo" },
		issue: { number: 42, title: "T", body: "B", pull_request: false },
		comment: { author_association: "OWNER", body: "@pi frontend-fix please" },
	};
	const r = filter("issue_comment", subset, c, 999, "d-cmd-vocab");
	assert.equal(r.enqueue, true);
	assert.equal(r.job.flow, "frontend-fix", "the flow comment trigger's override channel must keep working");
	assert.equal("command" in r.job, false);
});

test("a command trigger on EVERY forge the schema accepts groups without throwing", () => {
	// The same loop-over-the-table shape as the flow variant above: a forge whose command rule vanished
	// in grouping would fail HERE, at load, instead of inside a live reload that swallows it.
	const json = JSON.stringify({
		triggers: FORGE_KINDS.map((kind) => ({
			on: { type: "label", any: ["pi:go"] },
			run: { kind, command: "standup", ...(kind === "azure" ? { repository: "widgets" } : {}) },
		})),
	});
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	for (const kind of FORGE_KINDS) {
		assert.equal(c.triggers[kind].label.length, 1, `${kind}: its command rule must reach the filter, not vanish`);
		assert.equal(c.triggers[kind].label[0].command, "standup");
	}
	assert.equal(c.triggers.knownFlows.size, 0, "an all-command file has an EMPTY flow vocabulary, not a set of undefineds");
});

test("a mixed file's comment triggers keep their own channels: github resolves flows, gitlab dispatches its command", () => {
	// One comment trigger per forge (the shared parser's cap), different phrases: the flow one and the
	// command one must group onto their own forges with their own field, so neither gate can read the
	// other's dispatch mode -- a command bleeding into a flow group would skip flow resolution for a
	// trigger whose author asked for it.
	const json = JSON.stringify({
		triggers: [
			{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "triage" } },
			{ on: { type: "comment", phrase: "@pi-run" }, run: { kind: "gitlab", command: "wf run" } },
		],
	});
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.equal(c.triggers.github.comment.phrase, "@pi");
	assert.equal(c.triggers.github.comment.defaultFlow, "triage");
	assert.equal(c.triggers.github.comment.command, undefined);
	assert.equal(c.triggers.gitlab.comment.phrase, "@pi-run");
	assert.equal(c.triggers.gitlab.comment.command, "wf run");
	assert.equal(c.triggers.gitlab.comment.defaultFlow, undefined);
	assert.deepEqual([...c.triggers.knownFlows], ["triage"], "only the flow trigger names a flow");
});

test("a cron command trigger is still the worker's: skipped by the receiver, and it keeps its raw index", () => {
	// Same contract as the cron-flow variant above -- the index is the entry's identity IN THE FILE, so a
	// skipped cron command entry must shift the webhook rules' indices, never compact them.
	const json = JSON.stringify({
		triggers: [
			// No run.task beside the command: a command job's prompt IS the /name args line, and the shared
			// parser refuses the combination outright.
			{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/p", command: "standup" } },
			{ on: { type: "label", any: ["pi:x"] }, run: { kind: "github", flow: "fix" } },
			{ on: { type: "comment", phrase: "@pi-run" }, run: { kind: "github", command: "wf run" } },
		],
	});
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.equal(c.triggers.github.label.length, 1, "the cron entry grouped nowhere");
	assert.equal(c.triggers.github.label[0].index, 1);
	assert.equal(c.triggers.github.comment.index, 2);
	assert.deepEqual([...c.triggers.knownFlows], ["fix"], "neither command trigger -- cron or webhook -- joins the vocabulary");
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

// -- the triggers path default: ./triggers.json in the cwd, unified with `pi-dispatch init` (issue #80)

test("the default triggers path is ./triggers.json -- the file init scaffolds, not the committed demo", () => {
	// The old default (deploy/triggers.json) silently diverged from what `pi-dispatch init` writes, so a
	// by-the-book setup read the repo's demo triggers instead of the operator's file. The recording fake
	// pins which path the loader actually asks the filesystem about.
	const seen = [];
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: (p) => { seen.push(p); return true; }, readFile: () => TRIGGERS_JSON });
	assert.ok(seen.includes("./triggers.json"), `the loader must look for ./triggers.json; it asked for: ${seen.join(", ")}`);
	assert.ok(!seen.includes("deploy/triggers.json"), "the committed demo file must no longer be a silent default");
	assert.equal(c.triggers.github.label.length, 1, "the default path loads and groups like any other");
});

test("PI_TRIGGERS_FILE overrides the cwd default", () => {
	const seen = [];
	loadReceiverConfig({ WEBHOOK_SECRET: "shh", PI_TRIGGERS_FILE: "/etc/pi/triggers.json" }, { fileExists: (p) => { seen.push(p); return true; }, readFile: () => TRIGGERS_JSON });
	assert.ok(seen.includes("/etc/pi/triggers.json"));
	assert.ok(!seen.includes("./triggers.json"), "an explicit override must fully replace the default, not sit beside it");
});

test("triggersFilePath (what the live-reload watcher watches) reports the same default and override", () => {
	// The watcher and the loader must agree on the path, or a reload would watch one file and read another.
	assert.equal(triggersFilePath({}), "./triggers.json");
	assert.equal(triggersFilePath({ PI_TRIGGERS_FILE: "/etc/pi/triggers.json" }), "/etc/pi/triggers.json");
});

test("unknown top-level keys in a triggers file are ignored -- deploy/triggers.json carries a _note", () => {
	// deploy/triggers.json ships a top-level "_note" saying nothing reads it by default. The shared
	// parseTriggers reads only `parsed.triggers`, so an annotated file must load unchanged; this pin is
	// what keeps that note (or any future annotation) from ever becoming a boot failure.
	const json = JSON.stringify({ _note: "an example file", triggers: [{ on: { type: "label", any: ["pi:x"] }, run: { kind: "github", flow: "fix" } }] });
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => json });
	assert.equal(c.triggers.github.label.length, 1);
	assert.equal(c.triggers.github.label[0].flow, "fix");
});

// -- the receiver surfaces the shared validator's errors fail-loud -------------------------------

test("a missing triggers file is a config error -- no silent empty allowlist", () => {
	assert.throws(
		() => loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => false, readFile: () => "" }),
		(e) => e.piDispatchConfig === true,
	);
});

test("the missing-file error says what to DO: init here, or point PI_TRIGGERS_FILE at yours", () => {
	// A fresh operator hits this exact error first (empty folder, no scaffold yet), so the message is
	// the onboarding: it must name the path it tried and both ways out.
	assert.throws(
		() => loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => false, readFile: () => "" }),
		(e) => e.piDispatchConfig === true && e.message.includes("./triggers.json") && /pi-dispatch init/.test(e.message) && /PI_TRIGGERS_FILE/.test(e.message),
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
		privateKey: null,
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
	assert.deepEqual(c.triggers.gitlab, { label: [], comment: null, pullRequest: [], issue: [], prClose: [] });
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

// --- servesGithub: whether this deployment terminates GitHub webhooks at all (issue #99) -----------
//
// The property is the loader's single answer to that question, and three things read it: the
// WEBHOOK_SECRET requirement here, whether `/` is mounted (receiver.mjs), and whether boot resolves the
// harness's GitHub identity to arm the bot-loop guard (start.mjs). The regression it fixes was a
// GitLab-only deployment being unable to boot at all -- it had to supply a webhook secret for an endpoint
// it did not run, and (via the gh default auth source) install and log into the GitHub CLI. Both
// DIRECTIONS are pinned here: a github-free deployment must not need either, and a github-serving one
// must still refuse exactly as loudly as it always did.

const GITLAB_ONLY_JSON = JSON.stringify({
	triggers: [
		{ on: { type: "label", any: ["pi:frontend"] }, run: { kind: "gitlab", flow: "gl-fix" } },
		{ on: { type: "comment", phrase: "@pi" }, run: { kind: "gitlab", flow: "gl-triage" } },
	],
});
const gitlabOnlyTriggers = { fileExists: () => true, readFile: () => GITLAB_ONLY_JSON };

test("a gitlab-only triggers file leaves servesGithub false, and WEBHOOK_SECRET is then NOT required", () => {
	// The whole defect in one assertion: this deployment has no github endpoint, so there is no delivery
	// for a webhook secret to verify and demanding one blocked a supported deployment outright.
	const c = loadReceiverConfig({ GITLAB_WEBHOOK_MODE: "token", GITLAB_WEBHOOK_SECRET: "gl-secret", GITLAB_TOKEN: "glpat-x" }, gitlabOnlyTriggers);
	assert.equal(c.servesGithub, false, "an empty github group means a signed delivery could match nothing");
	assert.equal(c.webhookSecret, undefined, "absent stays absent -- nothing reads it, and servesGithub says why");
	assert.ok(c.gitlab, "the forge it DOES serve is configured, which is the point of the deployment");
});

test("servesGithub is false with no forge configured at all -- an empty github group is the signal, not the env", () => {
	// No GITLAB_* either: the decision is read off the triggers FILE, so it does not quietly depend on
	// another forge's block being present to relieve the github requirement.
	const c = loadReceiverConfig({}, gitlabOnlyTriggers);
	assert.equal(c.servesGithub, false);
	assert.doesNotThrow(() => loadReceiverConfig({}, gitlabOnlyTriggers));
});

test("a github trigger sets servesGithub true, and a missing WEBHOOK_SECRET is still the same configError", () => {
	assert.equal(loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, validTriggers).servesGithub, true);
	// Identical tagging and identical message to before the change: the endpoint exists, so the secret is
	// the trust boundary and its absence must still stop the boot dead.
	assert.throws(
		() => loadReceiverConfig({}, validTriggers),
		(e) => e.piDispatchConfig === true && /WEBHOOK_SECRET is required/.test(e.message) && /cannot verify signatures/.test(e.message),
	);
	assert.throws(() => loadReceiverConfig({ WEBHOOK_SECRET: "   " }, validTriggers), (e) => e.piDispatchConfig === true);
});

test("ANY github webhook rule type arms servesGithub -- label, comment, or pull_request alone", () => {
	// One case per group field, because the decision reads all three and a forgotten one would be a
	// deployment whose only trigger is a comment (or a PR rule) silently losing its endpoint.
	const cases = {
		label: { on: { type: "label", any: ["pi:x"] }, run: { kind: "github", flow: "fix" } },
		comment: { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } },
		pull_request: { on: { type: "pull_request", action: ["opened"] }, run: { kind: "github", flow: "fix" } },
	};
	for (const [kind, trigger] of Object.entries(cases)) {
		const fs = { fileExists: () => true, readFile: () => JSON.stringify({ triggers: [trigger] }) };
		assert.equal(loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, fs).servesGithub, true, `a lone github ${kind} rule must arm the endpoint`);
		assert.throws(() => loadReceiverConfig({}, fs), (e) => e.piDispatchConfig === true, `a lone github ${kind} rule must still require the secret`);
	}
});

test("an explicit GITHUB_AUTH_SOURCE sets servesGithub true with no github triggers -- explicit intent wins", () => {
	// An operator who names an auth source has said "GitHub" out loud, and may be arming the receiver
	// before the first rule exists. Respecting that also keeps boot byte-identical for everyone who sets it.
	for (const source of ["gh", "pat", "app"]) {
		const env = {
			WEBHOOK_SECRET: "shh",
			GITHUB_AUTH_SOURCE: source,
			...(source === "pat" ? { GITHUB_PAT: "ghp_x" } : {}),
			...(source === "app" ? { GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2", GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem" } : {}),
		};
		const c = loadReceiverConfig(env, gitlabOnlyTriggers);
		assert.equal(c.servesGithub, true, `GITHUB_AUTH_SOURCE=${source} is an explicit statement that this deployment serves github`);
		// And with the endpoint armed, the secret is required again -- the two move together, always.
		assert.throws(
			() => loadReceiverConfig({ ...env, WEBHOOK_SECRET: undefined }, gitlabOnlyTriggers),
			(e) => e.piDispatchConfig === true && /WEBHOOK_SECRET/.test(e.message),
			`GITHUB_AUTH_SOURCE=${source} must re-impose the secret requirement`,
		);
	}
});

test("the default auth source does NOT arm servesGithub -- github.source cannot distinguish default from choice", () => {
	// loadGitHubAuth defaults `source` to "gh", so reading the PARSED block would answer yes for every
	// deployment on earth and re-create the defect. The decision reads env.GITHUB_AUTH_SOURCE itself.
	const c = loadReceiverConfig({}, gitlabOnlyTriggers);
	assert.equal(c.github.source, "gh", "the block still defaults, exactly as the worker's does");
	assert.equal(c.servesGithub, false, "a defaulted source is not an operator saying github");
});

test("a github auth block error is reported as itself, never laundered into a WEBHOOK_SECRET complaint", () => {
	// Ordering: triggers and the auth block parse BEFORE the conditional secret check, so a typo'd source
	// on a secretless deployment names the typo. The reverse order would send the operator hunting for a
	// secret they do not need.
	assert.throws(
		() => loadReceiverConfig({ GITHUB_AUTH_SOURCE: "gitthub" }, gitlabOnlyTriggers),
		(e) => e.piDispatchConfig === true && /GITHUB_AUTH_SOURCE/.test(e.message),
	);
});

test("reloadTriggers does NOT recompute servesGithub -- a live edit can never mount / with an unarmed guard", () => {
	// The fail-safe direction, asserted so nobody "fixes" it into the unsafe one: `/` being mounted and the
	// harness's GitHub identity being resolved are both boot facts, so the property that gates them stays a
	// boot decision. A live edit that adds a github rule leaves the endpoint 404ing until a restart.
	const cfg = loadReceiverConfig({}, gitlabOnlyTriggers);
	assert.equal(cfg.servesGithub, false);
	const withGithub = JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:x"] }, run: { kind: "github", flow: "fix" } }] });
	const res = reloadTriggers({}, cfg, { fileExists: () => true, readFile: () => withGithub });
	assert.deepEqual(res, { ok: true }, "the reload itself succeeds -- the new rules ARE live for every configured forge");
	assert.equal(cfg.triggers.github.label.length, 1, "and the github group is loaded, so nothing is silently dropped");
	assert.equal(cfg.servesGithub, false, "but the endpoint stays absent: no route without a bot-loop guard");
});

test("a present WEBHOOK_SECRET on a github-free deployment is passed through untouched, not rejected", () => {
	// A deployment may share one env file across services. An unused secret is not an error -- it is just
	// unread, and `servesGithub: false` is what says the `/` endpoint it belongs to does not exist.
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, gitlabOnlyTriggers);
	assert.equal(c.servesGithub, false);
	assert.equal(c.webhookSecret, "shh");
});

// --- disarmed sentinel + not-yet-grouped issue entries hold their positions (issue #231) ---
//
// The shared validator normalizes a SPENT one-shot to `{ on: { type: "disarmed" }, run: {} }` at its
// ORIGINAL array position -- it is never spliced out, because the raw index is every LATER rule's
// identity (matched.index). This phase's receiver has no issue/prClose grouping yet, so two shapes must
// fall through every grouping branch contributing NO rule while their neighbours keep raw indexes: the
// sentinel, and an armed issue-type entry whose routing lands in a later change.

const DISARMED_ISSUE_ENTRY = { on: { type: "issue", action: ["closed"], number: 4, once: true, disarmed: { at: "2026-08-28T00:00:00Z" } }, run: { kind: "github", flow: "deploy" } };
const ARMED_ISSUE_ENTRY = { on: { type: "issue", action: ["closed"], number: 4, once: true }, run: { kind: "github", flow: "deploy" } };

/** [label@0, entry@1, label@2] -- the trailing neighbour is what makes a compacted index visible. */
function flankedByLabels(entry) {
	return JSON.stringify({
		triggers: [
			{ on: { type: "label", any: ["pi:a"] }, run: { kind: "github", flow: "a-fix" } },
			entry,
			{ on: { type: "label", any: ["pi:b"] }, run: { kind: "github", flow: "b-fix" } },
		],
	});
}

/** Every rule a forge's group holds, ALL FIVE shapes -- "contributes nothing ANYWHERE" must read them
 * all, and a group added later without a line here would let a phantom rule hide from these pins. */
function rulesOf(group) {
	return [...group.label, ...(group.comment ? [group.comment] : []), ...group.pullRequest, ...group.issue, ...group.prClose];
}

test("a disarmed one-shot loads clean and its neighbours keep RAW indexes 0 and 2 -- never compacted to 0 and 1", () => {
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => flankedByLabels(DISARMED_ISSUE_ENTRY) });
	// The pin that goes red if anyone ever FILTERS the parsed array instead of letting the sentinel flow
	// through positionally: index 2 collapsing to 1 would point matched.index at the wrong file entry for
	// every rule behind the spent one.
	assert.equal(c.triggers.github.label.length, 2);
	assert.deepEqual(c.triggers.github.label.map((r) => r.index), [0, 2], "raw file positions -- a spent entry between two rules occupies its slot, it does not vanish from the numbering");
	assert.deepEqual(c.triggers.github.label.map((r) => r.flow), ["a-fix", "b-fix"]);
	// And the sentinel itself grouped NOWHERE. Its normalized run is {}, so it does not even have a kind
	// to land on -- but the loop asserts every forge, every rule shape, so a future grouping change that
	// routes it anywhere at all fails here by name.
	for (const kind of FORGE_KINDS) {
		assert.equal(rulesOf(c.triggers[kind]).length, kind === "github" ? 2 : 0, `${kind}: a spent one-shot must not survive as a matchable rule`);
	}
});

test("an ARMED issue entry groups into the issue close-group with its narrowing intact", () => {
	// The close routing is live: an issue entry is a real rule now, in its own group, carrying the
	// number/once narrowing the close route reads -- and still at its RAW index, inside the if/else-if
	// chain (an unguarded push throwing inside reloadTriggers would keep yesterday's rules firing
	// behind one "invalid" line, the masked-edit failure the emptyGroup pin describes).
	const files = { fileExists: () => true, readFile: () => flankedByLabels(ARMED_ISSUE_ENTRY) };
	const c = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, files);
	assert.deepEqual(c.triggers.github.label.map((r) => r.index), [0, 2], "neighbours keep raw indexes around the issue rule");
	assert.equal(c.triggers.github.issue.length, 1, "the armed issue entry is a live close rule");
	const rule = c.triggers.github.issue[0];
	assert.equal(rule.index, 1, "at its raw file position");
	assert.equal(rule.number, 4, "the item narrowing rides the rule -- without it a one-shot fires on every close");
	assert.equal(rule.once, true);
	assert.ok(rule.actions.has("closed"));
	for (const kind of FORGE_KINDS) {
		assert.equal(rulesOf(c.triggers[kind]).length, kind === "github" ? 3 : 0, `${kind}: exactly the three armed rules, nowhere else`);
	}
	// The live-edit face: the reload path reports ok and rebuilds the same groups.
	const cfg = { triggers: null };
	assert.deepEqual(reloadTriggers({}, cfg, files), { ok: true });
	assert.equal(cfg.triggers.github.issue.length, 1);
});

test("knownFlows: an ARMED issue entry's flow joins the vocabulary; a DISARMED one's does not", () => {
	// Pinned as observed: the knownFlows add sits BEFORE the per-type grouping branches, so any non-cron
	// entry with a string run.flow joins the comment `<phrase> <flow>` override allowlist even while
	// nothing routes its type -- authored, armed intent counts from the moment the file loads.
	const armed = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => flankedByLabels(ARMED_ISSUE_ENTRY) });
	assert.deepEqual([...armed.triggers.knownFlows].sort(), ["a-fix", "b-fix", "deploy"], "an armed one-shot's flow stays summonable by a comment override");
	// The disarmed half is the one that matters: the sentinel normalizes with run: {}, so the spent
	// flow's name is gone before the add can see it. Deliberate, not an accident of the sentinel shape --
	// knownFlows is an allowlist of ARMED intent, and a spent one-shot's flow lingering there would keep
	// a comment able to summon the run the file says already happened.
	const spent = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => flankedByLabels(DISARMED_ISSUE_ENTRY) });
	assert.deepEqual([...spent.triggers.knownFlows].sort(), ["a-fix", "b-fix"], "a spent one-shot's flow has left the override allowlist");
	assert.equal(spent.triggers.knownFlows.has("deploy"), false, "the disarm removed a summonable name, which is the point of disarming");
});

test("reloadTriggers swaps an armed close one-shot for its disarmed twin: the rule disappears, later indexes hold", () => {
	// The armed entry is a pull_request CLOSE one-shot. Since the close routing landed it groups into
	// prClose, the close-gate group, never pullRequest -- the split the loader's no-mixing refusal
	// makes total, so the author-gated route can never see a close rule.
	const armedEntry = { on: { type: "pull_request", action: ["closed"], number: 7, once: true }, run: { kind: "github", flow: "cleanup" } };
	const spentEntry = { on: { ...armedEntry.on, disarmed: { at: "2026-08-28T00:00:00Z" } }, run: armedEntry.run };
	const cfg = loadReceiverConfig({ WEBHOOK_SECRET: "shh" }, { fileExists: () => true, readFile: () => flankedByLabels(armedEntry) });
	assert.equal(cfg.triggers.github.prClose.length, 1, "armed: the close rule is live, in the close group");
	assert.equal(cfg.triggers.github.pullRequest.length, 0, "and NOT in the author-gated PR group");
	assert.equal(cfg.triggers.github.prClose[0].index, 1);
	assert.equal(cfg.triggers.github.prClose[0].number, 7, "the narrowing rides the grouped rule -- without it a #7 one-shot fires on every close");
	assert.equal(cfg.triggers.github.prClose[0].once, true);
	assert.ok(cfg.triggers.knownFlows.has("cleanup"));

	// The worker fires the one-shot and writes on.disarmed back into the SAME entry; the receiver's
	// watcher reloads. In place, on the cfg the wired handler closed over -- no restart.
	const res = reloadTriggers({}, cfg, { fileExists: () => true, readFile: () => flankedByLabels(spentEntry) });
	assert.deepEqual(res, { ok: true }, "a disarm write-back is a VALID edit, never 'invalid' + stale rules kept");
	assert.equal(cfg.triggers.github.prClose.length, 0, "the spent rule is gone -- the sentinel matches nothing");
	assert.deepEqual(cfg.triggers.github.label.map((r) => r.index), [0, 2], "the disarm shifted NO later index: file entry 2 is still rule index 2");
	assert.equal(cfg.triggers.knownFlows.has("cleanup"), false, "and its flow left the armed-intent allowlist with it");
});
