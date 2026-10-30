import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { readProjectView, projectHolds, projectWindowStart, projectSizeAction, projectViewForAgent, readProjectFleetRuns } from "../src/project-view.mjs";
import { planProjectEdit, planProjectDelete, planLimitEdit } from "../src/write-plans.mjs";
import { writeProjects, envelopeRefusal } from "../src/read-model.mjs";
import { projectMembers, projectDelete, projectBundle } from "../src/console/panels/project.mjs";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const DAY = 86_400_000;
const record = (id, extra = {}) => ({ jobId: id, project: "billing", kind: "github", target: "acme/billing#2", outcome: "completed", startedAt: new Date(NOW - 60_000).toISOString(), endedAt: new Date(NOW - 1_000).toISOString(), tokens: { cost: 0.25, metered: true }, ...extra });
const project = { id: "billing", name: "Billing", members: ["github:acme/billing"] };
const host = (jobs, extra = {}) => ({ name: "mini1", jobs: JSON.stringify(jobs), jobsMore: "0", budgetMemMiB: "32768", budgetCpuCenti: "800", ...extra });

function input(extra = {}) {
  const reads = {
    projects: () => ({ projects: [project] }), limits: () => ({ limits: [] }), triggers: () => ({ triggers: [] }), settings: () => ({ overlay: {} }), subscriptions: () => ({ subscriptions: [] }), scan: () => [], allocation: () => ({ unset: true }), sizing: () => ({ projects: {} }), edit: () => ({ plan: {} }), delete: () => ({ plan: {} }), fleetRuns: () => ({ runs: [], incomplete: false }),
    ...(extra.reads ?? {}),
  };
  return { id: "billing", paths: { projectsFile: "/private/operator/projects.json", scopedLimitsPath: "/private/operator/limits.json" }, now: NOW, snapshot: { hostBudgets: [host([])], waiting: { rows: [] } }, ...extra, reads };
}

test("project holds use exact UTC enforcement windows, not today's holds for a weekly or monthly envelope", () => {
  const hosts = [host([
    { id: "gh-mon", p: "billing", at: NOW - 4 * DAY, h: 2_000_000, ha: NOW - 4 * DAY },
    { id: "gh-yesterday", p: "billing", at: NOW - DAY, h: 1_000_000, ha: NOW - DAY },
    { id: "gh-now", p: "billing", at: NOW - 1_000, h: 500_000, ha: NOW - 1_000 },
    { id: "gh-old", p: "billing", at: NOW - 10 * DAY, h: 4_000_000, ha: NOW - 10 * DAY },
    { id: "gh-other", p: "other", at: NOW - 1_000, h: 9_000_000, ha: NOW - 1_000 },
    { id: "gh-future", p: "billing", at: NOW + 1_000, h: 9_000_000, ha: NOW + 1_000 },
  ])];
  assert.equal(projectHolds(hosts, { id: "billing", window: "day", now: NOW }).micros, 500_000);
  assert.equal(projectHolds(hosts, { id: "billing", window: "week", now: NOW }).micros, 3_500_000);
  assert.equal(projectHolds(hosts, { id: "billing", window: "month", now: NOW }).micros, 7_500_000);
  assert.equal(projectWindowStart("week", NOW), Date.parse("2026-10-26T00:00:00Z"));
  assert.equal(projectWindowStart("month", NOW), Date.parse("2026-10-01T00:00:00Z"));
});

test("hold incompleteness and old hosts preserve unknown rather than zero; duplicate live ids count once", () => {
  const job = { id: "gh-one", p: "billing", at: NOW - 1, h: 700, ha: NOW - 1 };
  assert.deepEqual(projectHolds([host([job]), host([job])], { id: "billing", now: NOW }), { micros: 700, knownMicros: 700, incomplete: false });
  for (const rows of [[host([job], { jobsMore: "1" })], [host([job]), { name: "old" }], [host([{ id: "gh-no-hold", p: "billing", at: NOW - 1 }])]]) {
    const got = projectHolds(rows, { id: "billing", now: NOW });
    assert.equal(got.micros, null);
    assert.equal(got.incomplete, true);
  }
  assert.equal(projectHolds(null, { id: "billing", now: NOW }).micros, null);
});

test("spend splits the allocation ledger's held-inclusive amount exactly once", async () => {
  const view = await readProjectView(input({ paths: { envelopeFile: "/op/envelope.json" }, snapshot: { hostBudgets: [host([{ id: "gh-held", p: "billing", at: NOW - DAY, h: 2_000_000, ha: NOW - DAY }])] }, reads: { allocation: () => ({ window: "week", spend: { projects: { billing: 8_100_000 } }, state: { allocations: { billing: 25_000_000 }, weights: { billing: 3, other: 4 } }, floors: { billing: 10_000_000 }, totalMicros: 100_000_000 }) } }));
  assert.equal(view.spend.usedMicros, 8_100_000);
  assert.equal(view.spend.settledMicros, 6_100_000);
  assert.equal(view.spend.heldMicros, 2_000_000);
  assert.deepEqual([view.allocation.weight, view.allocation.totalWeight], [3, 7]);
  assert.equal(view.spend.shareMicros, 25_000_000);
});

test("allocation counters remain known when host holds are partial, settled is then unknown", async () => {
  const view = await readProjectView(input({ paths: { envelopeFile: "/op/envelope.json" }, snapshot: { hostBudgets: [{ name: "old" }] }, reads: { allocation: () => ({ window: "month", spend: { projects: { billing: 9_000_000 } } }) } }));
  assert.equal(view.spend.usedMicros, 9_000_000);
  assert.equal(view.spend.settledMicros, null);
  assert.equal(view.spend.heldMicros, null);
});

test("without envelope spend uses retained prices and states that no share exists", async () => {
  const view = await readProjectView(input({ reads: { scan: () => [record("gh-one"), record("gh-other", { project: "other", tokens: { cost: 99 } })] } }));
  assert.equal(view.spend.envelope, false);
  assert.equal(view.spend.settledMicros, 250_000);
  assert.equal(view.spend.shareMicros, null);
});

test("history stays with the recorded project while a current member's own activity stays a separate count", async () => {
  const view = await readProjectView(input({ reads: { scan: () => [record("gh-old-project", { project: "old" }), record("gh-our-project", { target: "acme/former-member#9" })] } }));
  assert.equal(view.runs24h.total, 1);
  assert.equal(view.recent[0].jobId, "gh-our-project");
  assert.equal(view.members[0].count, 1, "current member activity does not reattribute its old runs to this project");
});

test("a member with no runs this week still links its newest retained run from before the week", async () => {
  const lastAt = NOW - 6 * DAY;
  const got = await readProjectView(input({ reads: { scan: () => [record("gh-last-week", { endedAt: new Date(lastAt).toISOString() }), record("gh-older", { endedAt: new Date(lastAt - DAY).toISOString() }), record("gh-other-member", { target: "acme/other#2" })] } }));
  assert.equal(got.members[0].count, 0);
  assert.equal(got.members[0].last.jobId, "gh-last-week");
  assert.equal(got.members[0].last.at, lastAt);
  const markup = String(projectMembers({ role: "viewer", data: { projectView: got } }));
  assert.match(markup, /0 runs this week/);
  assert.match(markup, /href="\/run\?id=gh-last-week"/);
  assert.match(markup, /datetime="2026-10-24T12:00:00.000Z"/);
  assert.doesNotMatch(markup, /no run in view/);
});

test("same-named local members do not each claim the same run from basename-only history", async () => {
  const got = await readProjectView(input({ reads: { projects: () => ({ projects: [{ id: "billing", members: ["/private/a/site", "/private/b/site"] }] }), scan: () => [record("local-one", { kind: "local", target: "local:site" })] } }));
  assert.deepEqual(got.members.map((m) => m.count), [null, null]);
  assert.ok(got.members.every((m) => m.last === null && m.caveat.includes("cannot be told apart")));
  assert.equal(got.runs24h.total, 1, "the project's recorded run remains counted once");
  assert.doesNotMatch(JSON.stringify(got), /\/private\/(?:a|b)\/site/);
});

test("24h counts show worst outcome by policy severity and count in-line project jobs", async () => {
  const records = [record("gh-ok"), record("gh-refused", { outcome: "policy", reason: "egress-proxy-missing" }), record("gh-failed", { outcome: "failed", reason: "container-failed", endedAt: new Date(NOW - 2_000).toISOString() }), record("gh-yesterday", { endedAt: new Date(NOW - DAY - 1).toISOString() })];
  const view = await readProjectView(input({ reads: { scan: () => records }, snapshot: { hostBudgets: [host([])], waiting: { rows: [{ project: "billing" }, { project: "other" }] } } }));
  assert.equal(view.runs24h.total, 3);
  assert.equal(view.runs24h.counts.refused, 1);
  assert.equal(view.runs24h.counts.failed, 1);
  assert.equal(view.runs24h.worst.jobId, "gh-failed");
  assert.equal(view.runs24h.inLine, 1);
});

test("fieldwise size sources keep an env CPU when a project row changes only memory", async () => {
  const view = await readProjectView(input({ env: { PI_JOB_CPUS: "3" }, reads: { limits: () => ({ limits: [{ scope: "project:billing", memory: "8g", cpus: null }] }) } }));
  assert.deepEqual(view.size, { memMiB: 8192, cpuCenti: 300, source: "project", memorySource: "project row", cpuSource: "deployment settings" });
});

test("bad limits or deployment size never turn into a default size", async () => {
  assert.equal((await readProjectView(input({ reads: { limits: () => ({ invalid: "bad" }) } }))).size, null);
  assert.equal((await readProjectView(input({ env: { PI_JOB_MEMORY: "bad" } }))).size, null);
});

test("project size lazily reads the trusted deployment .env and respects fieldwise project precedence", async () => {
  const dir = tempDir("pd-751-size-env-");
  fs.writeFileSync(join(dir, ".env"), "PI_JOB_MEMORY=6g\nPI_JOB_CPUS=3\n", { mode: 0o600 });
  const got = await readProjectView(input({ deploymentDir: dir, env: { PI_JOB_CPUS: "9" }, reads: { limits: () => ({ limits: [{ scope: "project:billing", memory: "8g" }] }) } }));
  assert.deepEqual(got.size, { memMiB: 8192, cpuCenti: 300, source: "project", memorySource: "project row", cpuSource: "deployment settings" });
  const fromFile = await readProjectView(input({ deploymentDir: dir }));
  assert.deepEqual([fromFile.size.memMiB, fromFile.size.cpuCenti], [6144, 300]);
  assert.equal(fromFile.size.memorySource, "deployment settings");
});

test("unread deployment size metadata leaves unknown dimensions and cannot propose a default-sized write", async () => {
  const got = await readProjectView(input({ deploymentDir: "/not-readable", env: { PI_JOB_CPUS: "9" }, reads: { environment: () => ({ unreadable: "EACCES" }), limits: () => ({ limits: [{ scope: "project:billing", memory: "8g" }] }), sizing: () => assert.fail("cannot suggest against an unknown current CPU size") } }));
  assert.equal(got.size.memMiB, 8192);
  assert.equal(got.size.cpuCenti, null);
  assert.equal(got.size.cpuSource, "unknown (deployment metadata unreadable)");
  assert.equal(got.sizing, null);
  assert.equal(got.sizingUnreadable, true);
});

test("not-found is distinct from an unreadable projects file and neither performs unrelated reads", async () => {
  for (const [value, state] of [[{ projects: [] }, "missing"], [{ missing: true }, "unreadable"], [{ unset: true }, "unreadable"], [{ unreadable: "EACCES" }, "unreadable"], [{ invalid: "/secret/path token" }, "unreadable"]]) {
    let historyReads = 0;
    const view = await readProjectView(input({ reads: { projects: () => value, scan: () => { historyReads++; return []; } } }));
    assert.equal(view.state, state);
    assert.equal(historyReads, 0, "unavailable or known-absent projects perform no unrelated history read");
    assert.ok(!JSON.stringify(view).includes("/secret/path"));
  }
});

test("a real absent or unconfigured projects file is unavailable; only a loaded empty file proves not-found", async () => {
  const dir = tempDir("pd-751-project-source-");
  const projectsFile = join(dir, "projects.json");
  assert.equal((await readProjectView({ id: "billing", paths: { projectsFile }, now: NOW })).state, "unreadable");
  assert.equal((await readProjectView({ id: "billing", paths: {}, now: NOW })).state, "unreadable");
  fs.writeFileSync(projectsFile, JSON.stringify({ version: 1, projects: [] }));
  assert.equal((await readProjectView({ id: "billing", paths: { projectsFile }, now: NOW })).state, "missing");
});

test("size call conversion preserves exact edit/add fields and refuses counterexamples", () => {
  assert.deepEqual(projectSizeAction('dispatch_limit_edit {"index":2,"memory":"4g","cpus":2}', "billing"), { action: "limit-edit", index: 2, row: 3, limit: { memory: "4g", cpus: 2 } });
  assert.deepEqual(projectSizeAction('dispatch_limit_add {"scope":"project:billing","memory":"4g"}', "billing"), { action: "limit-add", row: null, limit: { scope: "project:billing", memory: "4g" } });
  for (const call of ['dispatch_limit_add {"scope":"project:other","memory":"4g"}', 'dispatch_limit_edit {"index":2,"scope":"project:other","memory":"4g"}', 'dispatch_limit_edit {"index":-1,"memory":"4g"}', 'dispatch_limit_edit {"index":2}', 'dispatch_limit_edit {"index":2,"cpus":"2"}', 'dispatch_project_delete {"id":"billing"}']) assert.equal(projectSizeAction(call, "billing"), null, call);
});

test("fleet history is bounded, continues past dashboard rows and states a truncated read", async () => {
  let calls = 0;
  const fleet = { runsPage: async ({ before, limit }) => { calls++; assert.equal(limit, 100); return before === null ? { runs: [record("gh-first")], next: NOW - DAY } : { runs: [record("gh-older")], next: null }; } };
  const got = await readProjectFleetRuns(fleet, { sinceMs: NOW - 30 * DAY });
  assert.equal(calls, 2);
  assert.equal(got.incomplete, false);
  assert.deepEqual(got.runs.map((r) => r.jobId), ["gh-first", "gh-older"]);
  calls = 0;
  const capped = await readProjectFleetRuns({ runsPage: async () => ({ runs: [], next: NOW - (++calls) * DAY }) }, { sinceMs: NOW - 30 * DAY });
  assert.equal(calls, 4);
  assert.equal(capped.incomplete, true);
  assert.equal((await readProjectFleetRuns({ runsPage: async () => ({ runs: [], truncated: true }) }, { sinceMs: NOW - DAY })).incomplete, true);
});

test("explicit agent projection cannot carry bundle variable names, resolver paths or hostile added fields", async () => {
  const view = await readProjectView(input());
  view.bundle = { id: "billing", profile: "vault", declared: "env", forkReviews: false, last: { variables: ["CUSTOMER_PRIVATE_TOKEN", "DB_PRIVATE_URL"], path: "/home/private/resolver" }, hostile: "secret-value" };
  view.sizing = { memory: { reason: "oversized", suggested: 4096, path: "/home/private" }, cpu: { reason: "underused", suggested: 200 }, call: 'dispatch_limit_edit {"index":2,"memory":"4g"}', bad: "secret-value" };
  const projected = projectViewForAgent(view);
  assert.equal(projected.bundle.variables, 2);
  assert.equal(projected.suggestion.call, view.sizing.call);
  for (const forbidden of ["CUSTOMER_PRIVATE_TOKEN", "DB_PRIVATE_URL", "/home/private", "secret-value"]) assert.ok(!JSON.stringify(projected).includes(forbidden));
});

function realDeployment({ bundled = false, limited = false, floor = false } = {}) {
  const dir = tempDir("pd-751-project-");
  const paths = { projectsFile: join(dir, "projects.json"), scopedLimitsPath: join(dir, "scoped-limits.json"), triggersPath: join(dir, "triggers.json"), settingsFile: join(dir, "settings.json") };
  fs.writeFileSync(paths.projectsFile, JSON.stringify({ version: 1, projects: [project] }));
  fs.writeFileSync(paths.scopedLimitsPath, JSON.stringify({ version: limited ? 2 : 1, limits: limited ? [{ scope: "project:billing", day: 5 }] : [] }));
  fs.writeFileSync(paths.triggersPath, JSON.stringify({ version: 1, triggers: [], ...(bundled ? { secretBundles: { billing: { project: "billing", profile: "vault", ref: "TOP_SECRET_REFERENCE" } } } : {}) }));
  fs.writeFileSync(paths.settingsFile, JSON.stringify({ version: 1, overlay: {} }));
  if (floor) {
    paths.envelopeFile = join(dir, "envelope.json");
    fs.writeFileSync(paths.envelopeFile, JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { billing: "10", _other: "0" }, defaultWeights: { billing: 1, _other: 1 }, delegation: { enabled: false } }));
  }
  return paths;
}

test("real planner preflight gives typed bundle blockers and concise member/delete guidance before a form", async () => {
  const paths = realDeployment({ bundled: true });
  const before = fs.readFileSync(paths.projectsFile, "utf8");
  const actual = await readProjectView({ id: "billing", paths, now: NOW, snapshot: { hostBudgets: [host([])] }, reads: { scan: () => [], allocation: () => ({ unset: true }), sizing: () => ({ projects: {} }), fleetRuns: () => ({ runs: [], incomplete: false }) } });
  assert.equal(actual.state, "ready");
  assert.equal(actual.editRefusal, "Members cannot be edited while secret bundle billing names billing. Change the bundle in triggers.json first.");
  assert.equal(actual.deleteRefusal, "Delete project billing: refused while secret bundle billing names it. Change that bundle in triggers.json first.");
  assert.ok(!actual.editRefusal.includes(paths.triggersPath));
  assert.ok(!JSON.stringify(actual).includes("TOP_SECRET_REFERENCE"));
  assert.equal(fs.readFileSync(paths.projectsFile, "utf8"), before, "preflight writes nothing");
});

test("hostile malformed triggers never enter project facts, HTML or the agent, and bundle absence stays unknown", async () => {
  const paths = realDeployment();
  const ref = "REF_PRIVATE_SENTINEL";
  const value = "VALUE_PRIVATE_SENTINEL";
  const root = "/Users/ROOT_PRIVATE_SENTINEL/resolvers";
  const declarations = [
    JSON.stringify({ triggers: [], secretBundles: [{ id: "billing", profile: "vault", project: "billing", ref, value, root }] }),
    JSON.stringify({ triggers: [{ on: { type: `${ref}:${value}:${root}` }, run: { kind: "github", flow: "fix" } }] }),
    `{"triggers":[],"${ref}:${value}:${root}":1,"${ref}:${value}:${root}":2}`,
  ];
  for (const text of declarations) {
    fs.writeFileSync(paths.triggersPath, text);
    const actual = await readProjectView({ id: "billing", paths, now: NOW, snapshot: { hostBudgets: [host([])] }, reads: { scan: () => [], allocation: () => ({ unset: true }), sizing: () => ({ projects: {} }), fleetRuns: () => ({ runs: [], incomplete: false }) } });
    assert.equal(actual.state, "ready");
    assert.match(actual.editRefusal, /triggers file could not be loaded.*Run pi-dispatch doctor/);
    assert.match(actual.deleteRefusal, /triggers file could not be loaded/);
    assert.equal(actual.bundleKnown, false);
    assert.equal(projectViewForAgent(actual).bundleKnown, false);
    const ctx = { role: "operator", readOnly: false, data: { projectView: actual } };
    const markup = [projectMembers(ctx), projectDelete(ctx), projectBundle(ctx)].map(String).join("");
    assert.match(markup, /whether this project has a secret bundle is unknown/);
    assert.doesNotMatch(markup, /No secret bundle names/);
    for (const projected of [JSON.stringify(actual), JSON.stringify(projectViewForAgent(actual)), markup, planProjectEdit({ params: { id: "billing", members: ["github:acme/new"] }, paths, env: {} }).refusal]) {
      for (const forbidden of [ref, value, root]) assert.ok(!projected.includes(forbidden), `no ${forbidden} from ${text}`);
    }
  }
});

test("real delete planner refuses a project limit and confirms membership join/leave effects before writing", () => {
  const paths = realDeployment({ limited: true });
  assert.match(planProjectDelete({ id: "billing", paths, env: {} }).refusal, /project:billing/);
  const result = planProjectEdit({ params: { id: "billing", members: ["gitlab:acme/new"] }, paths, env: {} });
  assert.match(result.plan.message, /gitlab:acme\/new joins.*runs record billing.*next pickup/);
  assert.match(result.plan.message, /github:acme\/billing leaves.*widens/);
  assert.match(result.plan.message, /Records already written keep/);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.projectsFile)).projects[0].members, ["github:acme/billing"]);
  const write = writeProjects(result.plan.writeArgs);
  assert.equal(write.invalid, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.projectsFile)).projects[0].members, ["gitlab:acme/new"]);
});

test("an envelope floor refuses delete through the actual planner before a form is offered", async () => {
  const paths = realDeployment({ floor: true });
  const env = { PI_MAX_COST_USD: "2" };
  const refused = planProjectDelete({ id: "billing", paths, env });
  assert.match(refused.refusal, /floor|floorsUsd/);
  assert.ok(!refused.plan);
  const actual = await readProjectView({ id: "billing", paths, env, now: NOW, snapshot: { hostBudgets: [host([])] }, reads: { scan: () => [], allocation: () => ({ window: "week", floors: { billing: 10_000_000 } }), sizing: () => ({ projects: {} }), fleetRuns: () => ({ runs: [], incomplete: false }) } });
  assert.match(actual.deleteRefusal, /floor|floorsUsd/);
  assert.ok(!actual.deleteRefusal.includes(paths.envelopeFile));
});

test("typed preflights name the actual bundle, scoped row or envelope floor without copying parser diagnostics", async () => {
  for (const kind of ["bundle", "limits", "envelope-floor"]) {
    const paths = realDeployment({ bundled: kind === "bundle", limited: kind === "limits", floor: kind === "envelope-floor" });
    if (kind === "bundle") fs.writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [], secretBundles: { payments: { project: "billing", profile: "vault", ref: "PRIVATE_REFERENCE" } } }));
    if (kind === "limits") fs.writeFileSync(paths.scopedLimitsPath, JSON.stringify({ version: 2, limits: [{ scope: "github:acme/other", day: 1 }, { scope: "project:billing", day: 5 }] }));
    const env = { PI_MAX_COST_USD: "2" };
    const raw = planProjectDelete({ id: "billing", paths, env });
    assert.equal(raw.blocker.kind, kind);
    if (kind === "bundle") assert.deepEqual(raw.blocker.bindings, [{ project: "billing", bundle: "payments" }]);
    if (kind === "limits") assert.deepEqual(raw.blocker.rows, [{ project: "billing", index: 1 }]);
    if (kind === "envelope-floor") assert.deepEqual(raw.blocker.projects, ["billing"]);
    const actual = await readProjectView({ id: "billing", paths, env, now: NOW, snapshot: { hostBudgets: [host([])] }, reads: { scan: () => [], allocation: () => ({ unset: true }), sizing: () => ({ projects: {} }), fleetRuns: () => ({ runs: [], incomplete: false }) } });
    assert.match(actual.deleteRefusal, kind === "bundle" ? /secret bundle payments names it/ : kind === "limits" ? /scoped limits row 2 \(project:billing\)/ : /an envelope floor names it/);
    assert.doesNotMatch(actual.deleteRefusal, /rejected:|dispatch_|floorsUsd|Nothing was written|PRIVATE_REFERENCE|\/private\/|\/tmp\//);
    const ctx = { role: "operator", readOnly: false, data: { projectView: actual } };
    const blocked = String(projectDelete(ctx));
    assert.match(blocked, /class="proj-refusal".*href="#i-attention".*Delete project billing/s);
    assert.match(blocked, /<button[^>]*disabled aria-disabled="true">Delete billing<\/button>/);
    assert.doesNotMatch(blocked, /data-action="project-delete"/);
    assert.doesNotMatch(String(projectDelete({ ...ctx, readOnly: true })), /<button|aria-disabled/);
    assert.equal(projectDelete({ ...ctx, role: "viewer" }), null);
    if (kind === "bundle") {
      assert.equal(planProjectEdit({ params: { id: "billing", members: ["github:acme/other"] }, paths, env }).blocker.kind, "bundle");
      assert.match(actual.editRefusal, /secret bundle payments names billing/);
      assert.doesNotMatch(String(projectMembers(ctx)), /data-action="project-edit"/);
      assert.match(String(projectMembers(ctx)), /class="proj-refusal".*href="#i-attention".*Members cannot be edited/s);
    }
  }
});

test("invalid preflight sources and an untyped hostile refusal get fixed actionable copy, never raw server text", async () => {
  const paths = realDeployment();
  fs.writeFileSync(paths.scopedLimitsPath, '{"PRIVATE_DIAGNOSTIC":"/Users/private-root"}');
  const raw = planProjectDelete({ id: "billing", paths, env: {} });
  assert.deepEqual(raw.blocker, { kind: "source", source: "scoped-limits" });
  const got = await readProjectView({ id: "billing", paths, now: NOW, snapshot: { hostBudgets: [host([])] }, reads: { scan: () => [], allocation: () => ({ unset: true }), sizing: () => ({ projects: {} }), fleetRuns: () => ({ runs: [], incomplete: false }) } });
  // Use the regular project source seam while the actual preflight retains the worker parser's failure.
  assert.match(got.deleteRefusal ?? "", /scoped-limits file could not be loaded.*Run pi-dispatch doctor/);
  assert.doesNotMatch(got.deleteRefusal, /PRIVATE_DIAGNOSTIC|private-root/);
  const hostile = { refusal: "rejected: dispatch_tool PRIVATE_DIAGNOSTIC /Users/private-root (parser detail)" };
  const fallback = await readProjectView(input({ reads: { edit: () => hostile, delete: () => hostile } }));
  assert.equal(fallback.editRefusal, "The project configuration could not be checked. Run pi-dispatch doctor, then preview again.");
  assert.equal(fallback.deleteRefusal, fallback.editRefusal);
  assert.doesNotMatch(JSON.stringify(projectViewForAgent(fallback)), /PRIVATE_DIAGNOSTIC|private-root|dispatch_tool|rejected:/);
});

test("unrelated envelope callers retain their refusal string and a members-only edit keeps the project name", () => {
  const paths = realDeployment({ floor: true });
  assert.match(envelopeRefusal({ envelopeFile: paths.envelopeFile, projectsPath: paths.projectsFile, scopedLimitsPath: paths.scopedLimitsPath, maxCostMicros: 2_000_000, next: { maxCostMicros: null } }), /envelope invalid/);
  fs.writeFileSync(paths.scopedLimitsPath, JSON.stringify({ version: 3, limits: [{ scope: "project:billing", weekUsd: "20" }] }));
  const lowered = planLimitEdit({ params: { index: 0, weekUsd: "1" }, paths, env: { PI_MAX_COST_USD: "2" } });
  assert.match(lowered.refusal, /allocation envelope invalid/);
  assert.equal(lowered.blocker, undefined, "other planners' result shapes remain unchanged");
  const unbound = realDeployment();
  const result = planProjectEdit({ params: { id: "billing", members: ["github:acme/next"] }, paths: unbound, env: {} });
  assert.equal(result.plan.after.name, "Billing");
  assert.equal(writeProjects(result.plan.writeArgs).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(unbound.projectsFile)).projects[0].name, "Billing");
});

test("the real sizing reader supplies evidence, exact preview and CPU ceiling fact; no live host admission withholds it", async () => {
  const paths = realDeployment();
  paths.logsDir = join(tempDir("pd-751-sizing-"), "logs");
  fs.mkdirSync(paths.logsDir);
  fs.writeFileSync(paths.scopedLimitsPath, JSON.stringify({ version: 3, limits: [{ scope: "project:billing", memory: "8g", cpus: 4 }] }));
  for (let i = 0; i < 12; i++) {
    const ended = NOW - i * 3_600_000;
    const r = record(`gh-size-${i}`, { startedAt: new Date(ended - 60_000).toISOString(), endedAt: new Date(ended).toISOString(), size: { memMiB: 8192, cpuCenti: 400, source: "project" }, resources: { memPeak: 2048 * 1024 * 1024, cpuUsec: 30_000_000, throttledUsec: 40_000_000 } });
    const file = join(paths.logsDir, `${r.jobId}.json`);
    fs.writeFileSync(file, JSON.stringify(r));
    fs.utimesSync(file, NOW / 1000, NOW / 1000);
  }
  const args = { id: "billing", paths, now: NOW, snapshot: { hostBudgets: [host([])] }, reads: { allocation: () => ({ unset: true }), fleetRuns: () => ({ runs: [], incomplete: false }) } };
  const got = await readProjectView(args);
  assert.equal(got.sizing.series.length, 12);
  assert.equal(got.sizing.memory.reason, "oversized");
  assert.equal(got.sizing.memory.evidence.p95MiB, 2048);
  assert.equal(got.sizing.memory.suggested, 2560);
  assert.equal(got.sizing.cpu.suggested, 75);
  assert.equal(got.sizing.call, 'dispatch_limit_edit {"index":0,"memory":"2560m","cpus":0.75}');
  assert.match(got.sizing.words.cpuFact, /held back 67%.*CPU ceiling/);
  assert.deepEqual(got.sizing.action.limit, { memory: "2560m", cpus: 0.75 });
  const refused = await readProjectView({ ...args, snapshot: { hostBudgets: [host([], { budgetMemMiB: "512", budgetCpuCenti: "50" })] } });
  assert.equal(refused.sizing.call, null);
  assert.equal(refused.sizing.action, null);
  assert.match(refused.sizing.words.refusal, /above every live host/);
});

test("a production degraded registry string makes retained healthy host holds unknown and cannot authorize a memory raise", async () => {
  const paths = realDeployment();
  paths.logsDir = tempDir("pd-751-degraded-sizing-");
  fs.writeFileSync(paths.scopedLimitsPath, JSON.stringify({ version: 3, limits: [{ scope: "project:billing", memory: "8g", cpus: 4 }] }));
  const oom = record("gh-oom", { outcome: "policy", reason: "oom-killed", size: { memMiB: 8192, cpuCenti: 400, source: "project" }, resources: { memPeak: 8192 * 1024 * 1024, oomKills: 1, cpuUsec: 30_000_000 } });
  const file = join(paths.logsDir, `${oom.jobId}.json`);
  fs.writeFileSync(file, JSON.stringify(oom));
  fs.utimesSync(file, NOW / 1000, NOW / 1000);
  const retained = [host([{ id: "gh-held", p: "billing", at: NOW - 1, h: 2_000_000, ha: NOW - 1 }])];
  const args = { id: "billing", paths, now: NOW, reads: { allocation: () => ({ unset: true }), fleetRuns: () => ({ runs: [], incomplete: false }) } };
  const healthy = await readProjectView({ ...args, snapshot: { hostBudgets: retained, queue: { fleetDegraded: null } } });
  assert.equal(healthy.spend.heldMicros, 2_000_000);
  assert.equal(healthy.sizing.memory.suggested, 12288);
  assert.equal(healthy.sizing.call, 'dispatch_limit_edit {"index":0,"memory":"12g"}');
  assert.equal(healthy.sizingUnreadable, false);
  for (const state of [{ queue: { fleetDegraded: "registry unreadable" } }, { fleetDegraded: "registry unreadable" }, { fleetDegraded: true }]) {
    const degraded = await readProjectView({ ...args, snapshot: { hostBudgets: retained, ...state } });
    assert.equal(degraded.spend.heldMicros, null);
    assert.equal(degraded.spend.heldIncomplete, true);
    assert.equal(degraded.spend.heldKnownMicros, 0, "stale holds are not relabeled as currently known");
    assert.equal(degraded.sizing.memory.reason, "oom-killed");
    assert.equal(degraded.sizing.memory.held, "no-cap");
    assert.equal(degraded.sizing.memory.suggested, null);
    assert.equal(degraded.sizing.call, null);
    assert.equal(degraded.sizing.action, null);
    assert.equal(degraded.sizingUnreadable, true);
  }
});

test("month spend history includes the first day of a long month, beyond the 30-day sizing range", async () => {
  const now = Date.parse("2026-10-31T23:00:00Z");
  let readSince;
  const got = await readProjectView(input({ now, paths: { envelopeFile: "/op/envelope.json" }, reads: { allocation: () => ({ window: "month", spend: { projects: { billing: 1_000_000 } } }), scan: ({ sinceMs }) => { readSince = sinceMs; return [record("gh-month-first", { endedAt: "2026-10-01T01:00:00Z", reason: "allocation-cap", outcome: "policy" })]; } } }));
  assert.equal(readSince, Date.parse("2026-10-01T00:00:00Z"));
  assert.equal(got.allocation.refused, 1);
});
