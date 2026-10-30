import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { tempDir } from "./helpers/temp-dir.mjs";
import { CHECK_EVENTS, CHECK_LIMITS, CHECK_NOTICE, CHECK_REASON_SENTENCES, checkTriggerEvent, parseTriggerCheckInput } from "../src/trigger-check.mjs";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { groupTriggers } from "../../receiver/src/trigger-groups.mjs";
import { reloadTriggers } from "../../receiver/src/config.mjs";
import { filter } from "../../receiver/src/filter.mjs";
import { filterGitLab } from "../../receiver/src/filter-gitlab.mjs";
import { filterForgejo } from "../../receiver/src/filter-forgejo.mjs";
import { filterAzure } from "../../receiver/src/filter-azure.mjs";

const label = (forge = "github", flow = "fix", selector = { any: ["go"] }) => ({ on: { type: "label", ...selector }, run: { kind: forge, flow, ...(forge === "azure" ? { repository: "web" } : {}) } });
const comment = (forge = "github", flags = {}) => ({ on: { type: "comment", phrase: "@pi" }, run: { kind: forge, flow: "fix", ...(forge === "azure" ? { repository: "web" } : {}), ...flags } });
const pr = (forge, action, extra = {}) => ({ on: { type: "pull_request", action, ...extra }, run: { kind: forge, flow: "review" } });
const close = (forge = "github", extra = {}) => ({ on: { type: "issue", action: [forge === "gitlab" ? "close" : "closed"], ...extra }, run: { kind: forge, flow: "closed" } });
const base = { forge: "github", event: "issue-labeled", repository: "acme/web", actor: "write", labels: ["go"] };

function setup(entries) {
  const triggersPath = join(tempDir("pd-750-check-"), "triggers.json");
  const source = JSON.stringify({ triggers: entries });
  fs.writeFileSync(triggersPath, source);
  return { triggersPath, source, check: (input = base) => checkTriggerEvent({ input, triggersPath }) };
}

test("the receiver and checker share the exact full-list grouping, including raw index gaps and armed flow vocabulary", () => {
  const entries = [
    { on: { type: "cron", id: "daily", pattern: "0 6 * * *" }, run: { kind: "local", folder: "/srv/repo", flow: "tidy", task: "private task" } },
    label("github"), comment("gitlab"), pr("forgejo", ["opened"]), close("github", { number: 7, once: true, disarmed: { at: "2026-10-01T00:00:00.000Z" } }),
  ];
  const f = setup(entries);
  const document = parseTriggersDocument(f.source, "file");
  const expected = groupTriggers(document.triggers);
  const cfg = {};
  assert.deepEqual(reloadTriggers({ PI_TRIGGERS_FILE: f.triggersPath }, cfg), { ok: true });
  assert.deepEqual(cfg.triggers, expected);
  assert.deepEqual([...expected.knownFlows], ["fix", "review"]);
  assert.equal(expected.github.label[0].index, 1);
  const checked = f.check();
  assert.equal(checked.matched.index, 1);
  assert.equal(checked.rules[0].status, "not-applicable");
  assert.equal(checked.rules[4].status, "spent");
});

test("all four forge label decisions equal their actual receiver filters, with label-set versus added-label semantics", () => {
  for (const forge of Object.keys(CHECK_EVENTS)) {
    const f = setup([label(forge)]);
    const groups = groupTriggers(parseTriggersDocument(f.source, "file").triggers);
    const labels = [{ name: "go" }];
    let real;
    if (forge === "github") real = filter("issues", { action: "labeled", sender: { id: 2 }, repository: { full_name: "acme/web" }, issue: { number: 1, labels } }, { triggers: groups }, 1, "x");
    if (forge === "forgejo") real = filterForgejo("issues", { action: "label_updated", sender: { id: 2 }, repository: { full_name: "acme/web" }, issue: { number: 1, labels } }, groups.forgejo, groups.knownFlows, 1, true, "x");
    if (forge === "gitlab") real = filterGitLab({ objectKind: "issue", action: "update", user: { id: 2 }, project: { id: 1, path: "acme/web" }, target: { iid: 1, labels }, labelChanges: { previous: [], current: labels } }, groups.gitlab, groups.knownFlows, 1, true, "x");
    if (forge === "azure") real = filterAzure({ eventType: "workitem.updated", actor: { id: "user" }, project: { name: "acme" }, target: { number: 1 }, tags: labels, tagChanges: { previous: [], current: labels } }, groups.azure, groups.knownFlows, { id: "self" }, true, "x");
    assert.equal(real.enqueue, true, forge);
    const got = f.check({ ...base, forge });
    assert.deepEqual([got.matched.index, got.matched.flow], [real.job.trigger.matched.index, real.job.flow], forge);
    if (forge === "gitlab" || forge === "azure") {
      const retained = f.check({ ...base, forge, previousLabels: ["go"] });
      assert.equal(retained.matched, null);
      assert.equal(retained.rules[0].reason, "no-label-change", `${forge}: keeping the tag is no new delivery match`);
      assert.equal(f.check({ ...base, forge, labels: [], previousLabels: ["go"] }).matched, null, "removal never starts work");
    }
  }
});

test("first match wins even with equal flows; isolated matches explain shadowing, not two paid starts", () => {
  const f = setup([label("github", "same", { any: ["go"], none: ["blocked"] }), label("github", "same", { all: ["go"] })]);
  const first = f.check();
  assert.equal(first.matched.index, 0);
  assert.deepEqual(first.rules.map((r) => r.status), ["matched", "shadowed"]);
  assert.match(first.rules[1].sentence, /row 1/);
  const second = f.check({ ...base, labels: ["go", "blocked"] });
  assert.equal(second.matched.index, 1);
  assert.equal(second.rules[0].reason, "no-allowlisted-label");
});

test("comment overrides use all armed webhook flows across forges, not cron or spent names", () => {
  const f = setup([comment(), label("gitlab", "other"), close("github", { number: 7, once: true, disarmed: { at: "2026-10-01T00:00:00.000Z" } })]);
  const event = { forge: "github", event: "issue-comment", repository: "acme/web", actor: "write", comment: "@pi other investigate" };
  assert.equal(f.check(event).matched.flow, "other");
  assert.equal(f.check({ ...event, comment: "@pi closed" }).matched.flow, "fix", "a spent flow is no longer a selectable override; default flow remains");
  assert.equal(f.check({ ...event, comment: "@PI other" }).matched, null, "phrase matching is case-sensitive");
  assert.equal(f.check({ ...event, actor: "read" }).matched, null);
  assert.equal(f.check({ ...event, actor: "self" }).rules[0].reason, "self");
});

test("GitHub review authority is the reviewer's, automatic PR authority the author's, and empty commented reviews do not start", () => {
  const f = setup([pr("github", ["review_submitted"], { reviewState: ["changes_requested"] }), pr("github", ["opened"])]);
  const review = { forge: "github", event: "pull-request", repository: "acme/web", actor: "write", action: "review_submitted", prAuthor: "read", reviewState: "changes_requested" };
  assert.equal(f.check(review).matched.index, 0, "a member may review a stranger's PR");
  assert.equal(f.check({ ...review, actor: "read", prAuthor: "write" }).matched, null, "a member PR author cannot authorize a stranger's review");
  assert.equal(f.check({ ...review, reviewState: "approved" }).rules[0].reason, "review-state-not-matched");
  const empty = setup([pr("github", ["review_submitted"])]).check({ ...review, reviewState: "commented", reviewBody: "empty" });
  assert.equal(empty.rules[0].reason, "no-review-body");
  const opened = { forge: "github", event: "pull-request", repository: "acme/web", actor: "write", action: "opened", prAuthor: "read" };
  assert.equal(f.check(opened).matched, null);
  assert.equal(f.check({ ...opened, actor: "read", prAuthor: "write" }).matched.index, 1, "the PR author's membership gates this action, not its actor's");
});

test("forge PR action vocabularies reach the exact routes, with GitLab label delta narrowing and Azure work-item scope", () => {
  for (const [forge, action] of [["forgejo", "synchronized"], ["gitlab", "approved"], ["azure", "updated"]]) {
    const got = setup([pr(forge, [action])]).check({ forge, event: "pull-request", action, actor: "write", repository: "acme/web" });
    assert.equal(got.matched?.flow, "review", forge);
  }
  const gl = setup([pr("gitlab", ["update"], { any: ["go"] })]);
  assert.equal(gl.check({ forge: "gitlab", event: "pull-request", action: "update", repository: "acme/web", actor: "write", labels: ["go"], previousLabels: ["go"] }).matched, null);
  assert.equal(gl.check({ forge: "gitlab", event: "pull-request", action: "update", repository: "acme/web", actor: "write", labels: ["go"] }).matched.index, 0);
  const azure = setup([{ ...comment("azure"), run: { kind: "azure", flow: "fix", repository: "configured-repo" } }]);
  const checked = azure.check({ forge: "azure", event: "issue-comment", repository: "Project/described-repo", actor: "write", comment: "@pi fix" });
  assert.equal(checked.matched.flow, "fix", "a work item names no repository; the matched trigger supplies it");
  assert.match(checked.gates.find((g) => g.id === "repository").sentence, /work items select their repository from the matched rule/);
});

test("close precedence and one-shots preserve number, spent and actor semantics", () => {
  for (const forge of ["github", "gitlab", "forgejo"]) {
    const f = setup([close(forge, { number: 7, once: true }), label(forge)]);
    const input = { ...base, forge, event: "issue-closed", number: 7, ...(forge === "gitlab" ? { previousLabels: [] } : {}) };
    assert.equal(f.check(input).matched.index, 0);
    assert.equal(f.check({ ...input, actor: "read" }).matched, null);
    const other = f.check({ ...input, number: 8 });
    if (forge === "gitlab") assert.equal(other.matched.index, 1, "GitLab close falls back to the added-label route");
    else assert.equal(other.matched, null);
  }
  const priority = setup([label("gitlab"), close("gitlab", { number: 7 })]).check({ ...base, forge: "gitlab", event: "issue-closed", number: 7, previousLabels: [] });
  assert.equal(priority.matched.index, 1, "close routing precedes a label rule even when the label appears first in the file");
  assert.equal(priority.rules[0].status, "shadowed");
  assert.match(priority.rules[0].sentence, /receiver route selected row 2/);
});

test("steering and phrase-free parked paths remain conditional continuations, including the PR exclusion", () => {
  for (const forge of Object.keys(CHECK_EVENTS)) {
    const f = setup([comment(forge, { resume: true, steer: true })]);
    const input = { forge, event: "issue-comment", repository: "acme/web", actor: "write", comment: "@pi change this" };
    assert.equal(f.check(input).matched.route, "steer-or-start", forge);
    assert.equal(f.check({ ...input, comment: "@pi later change this" }).matched.route, "follow-up-or-start", forge);
    assert.equal(f.check({ ...input, comment: "my answer" }).matched.route, "pending-parked", forge);
    assert.equal(f.check({ ...input, comment: "my answer", labels: ["pi-awaiting-input"] }).matched.route, "parked-answer", forge);
    const pull = { ...input, event: "pull-request-comment", comment: "my answer" };
    assert.equal(f.check(pull).matched, null, `${forge}: phrase-free PR replies never resume an issue's session`);
  }
});

test("command disclosure is only its name; neither prompt text nor secret references nor described comments reach results", () => {
  const entries = [
    { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", command: "review private-arg-canary", secrets: { TOKEN: "vault/private-ref-canary" } } },
    { on: { type: "label", any: ["private-label"] }, run: { kind: "github", flow: "private-flow", instructions: "private-instructions-canary" } },
    { on: { type: "cron", id: "cron", pattern: "0 0 * * *" }, run: { kind: "local", folder: "/Users/private-home", flow: "fix", task: "private-task-canary" } },
  ];
  const got = setup(entries).check({ forge: "github", event: "issue-comment", repository: "private-org/project", actor: "write", comment: "@pi secret-comment-canary" });
  assert.equal(got.matched.command, "review");
  assert.equal(got.matched.flow, undefined);
  assert.equal(got.notice, CHECK_NOTICE);
  assert.ok(got.gates.every((g) => g.state === "not-checked"));
  assert.doesNotMatch(JSON.stringify(got), /private-arg-canary|private-instructions|private-ref|private-task|private-home|private-org|secret-comment|enqueue|jobId|TOKEN/);
});

test("bounded closed inputs refuse before reading; malformed or oversized whole files refuse without leaking their contents", () => {
  for (const input of [
    { ...base, actor: undefined }, { ...base, other: "private-input-canary" }, { ...base, repository: "/private/path" }, { ...base, labels: Array(33).fill("go") }, { ...base, labels: ["x".repeat(129)] },
    { ...base, event: "issue-comment", comment: "x".repeat(4097) }, { ...base, action: "opened" }, { ...base, reviewState: "approved" },
    { ...base, event: "pull-request", action: "opened" }, { ...base, event: "pull-request", action: "unknown", prAuthor: "write" }, { ...base, number: 0 },
  ]) {
    const got = checkTriggerEvent({ input, triggersPath: "unread", fs: { openSync() { assert.fail("bad input opened the file"); } } });
    assert.ok(got.refusal);
    assert.doesNotMatch(JSON.stringify(got), /private-input-canary|private\/path/);
  }
  const f = setup([label()]);
  for (const source of ['{"triggers":[{"run":{"instructions":"broken-private-canary"}}]}', '{"triggers":[],"triggers":[]}', "x".repeat(CHECK_LIMITS.fileBytes + 1), JSON.stringify({ triggers: Array(257).fill(label()) })]) {
    fs.writeFileSync(f.triggersPath, source);
    const got = f.check();
    assert.ok(got.refusal);
    assert.doesNotMatch(JSON.stringify(got), /broken-private-canary|pd-750-check|SyntaxError/);
  }
});

test("the checker reaches the receiver filters and pure grouping, not live receiver routes, queue producers or identity clients", async () => {
  const built = await build({ entryPoints: [fileURLToPath(new URL("../src/trigger-check.mjs", import.meta.url))], bundle: true, write: false, platform: "node", format: "esm", metafile: true, external: ["bullmq", "ioredis"], logLevel: "silent" });
  const inputs = Object.keys(built.metafile.inputs);
  for (const name of ["filter.mjs", "filter-gitlab.mjs", "filter-forgejo.mjs", "filter-azure.mjs", "trigger-groups.mjs"]) assert.ok(inputs.some((p) => p.endsWith(`receiver/src/${name}`)), name);
  assert.deepEqual(inputs.filter((p) => /receiver\/src\/(?:receiver|start|.+-members)\.mjs$|worker\/src\/queue\.mjs$/.test(p)), []);
  const f = setup([label()]);
  const readonlyFs = new Proxy(fs, { get(target, key) { if (/write|rename|mkdir|unlink|truncate|append/i.test(String(key))) return () => assert.fail("checker attempted a filesystem mutation"); return target[key]; } });
  assert.equal(checkTriggerEvent({ input: base, triggersPath: f.triggersPath, fs: readonlyFs }).matched.index, 0);
});


test("every receiver reason literal has a fixed checker explanation, so new refusal behavior cannot silently become generic", () => {
  const names = ["filter.mjs", "filter-gitlab.mjs", "filter-forgejo.mjs", "filter-azure.mjs", "close.mjs"];
  const reasons = new Set(names.flatMap((name) => [...fs.readFileSync(new URL(`../../receiver/src/${name}`, import.meta.url), "utf8").matchAll(/reason: "([a-z-]+)"/g)].map((m) => m[1])));
  assert.ok(reasons.size > 15);
  for (const reason of reasons) assert.equal(typeof CHECK_REASON_SENTENCES[reason], "string", reason);
});


test("the checker rejects non-regular sources without a blocking open and bounds a file that grew after fstat", () => {
  let closed = 0;
  const notFile = checkTriggerEvent({ input: base, triggersPath: "private-source", fs: {
    openSync(_path, flags) { assert.equal(flags & fs.constants.O_NONBLOCK, fs.constants.O_NONBLOCK); return 7; },
    fstatSync: () => ({ isFile: () => false, size: 0 }),
    readSync() { assert.fail("non-regular file was read"); }, closeSync(fd) { assert.equal(fd, 7); closed++; },
  } });
  assert.equal(notFile.refusal.code, "triggers-too-large");
  assert.equal(closed, 1);
  const f = setup([label()]);
  fs.writeFileSync(f.triggersPath, "x".repeat(CHECK_LIMITS.fileBytes + 128));
  let readBytes = 0;
  const grownFs = { ...fs, fstatSync: () => ({ isFile: () => true, size: 0 }), readSync(...args) { const n = fs.readSync(...args); readBytes += n; return n; } };
  const grown = checkTriggerEvent({ input: base, triggersPath: f.triggersPath, fs: grownFs });
  assert.equal(grown.refusal.code, "triggers-too-large");
  assert.equal(readBytes, CHECK_LIMITS.fileBytes + 1, "a stat/read race never reads the rest of an oversized file");
});
