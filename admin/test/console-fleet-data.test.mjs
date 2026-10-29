import { test } from "node:test";
import assert from "node:assert/strict";
import { killSwitchPlan } from "../src/read-model.mjs";
import { actionNamed, previewAction } from "../src/console/actions.mjs";
import { PAGES, parsePageQuery, pageQueryString, loadPageData, pagePanels, renderPage } from "../src/console/pages.mjs";

const AT = Date.UTC(2026, 9, 28, 12);

test("host and venue queries are strict closed routes and round trip without echoing rejected values", () => {
  assert.equal(PAGES.host.path, "/fleet/host");
  assert.equal(PAGES.host.live, true);
  assert.equal(PAGES.venue.path, "/fleet/venue");
  assert.equal(PAGES.venue.live, false);
  for (const [page, name] of [["host", "build3"], ["venue", "openshell-bind"]]) {
    const result = parsePageQuery(page, new URLSearchParams({ name }));
    assert.deepEqual(result.query, { name });
    assert.equal(pageQueryString(page, result.query), `name=${name}`);
    for (const query of ["", "name=", `name=${name}&name=${name}`, `name=${name}&extra=1`, "name=%3Ccanary-secret%3E"]) {
      const refusal = parsePageQuery(page, new URLSearchParams(query)).refusal;
      assert.ok(refusal, `${page}: ${query}`);
      assert.ok(!refusal.includes("canary-secret"));
    }
  }
  assert.ok(parsePageQuery("venue", new URLSearchParams("name=new-venue")).refusal);
});

test("Fleet asks for waiting jobs and rechecks the kill-switch plan on every load without carrying connection credentials", async () => {
  let plans = 0;
  const reads = [];
  const deps = { now: () => AT, fleet: { snapshot: async (opts) => { reads.push(opts); return {}; } }, killSwitchPlan: () => { plans++; return { urls: ["redis://user:secret@host/0"], context: { password: "secret" }, disagreement: "Two Valkeys", refused: "Resume neither", resumeCommand: "pi-dispatch resume --valkey-url 'redis://host/0'" }; } };
  const a = await loadPageData("fleet", {}, deps);
  await loadPageData("fleet", {}, deps);
  assert.deepEqual(reads, [{ waiting: true }, { waiting: true }]);
  assert.equal(plans, 2);
  assert.deepEqual(a.killSwitch, { disagreement: "Two Valkeys", refused: "Resume neither", resumeCommand: "pi-dispatch resume --valkey-url 'redis://host/0'", resumeArgv: null });
  assert.ok(!JSON.stringify(a).includes("secret"));
});

test("host history is filtered, host capacity is requested once initially and omitted from live replacements", async () => {
  let capacityReads = 0;
  const historyReads = [];
  const host = { name: "build3", jobs: [], staleMs: 0 };
  const deps = { now: () => AT, fleet: { snapshot: async () => ({ hostBudgets: [host] }), runsPage: async (opts) => { historyReads.push(opts); return { runs: [{ jobId: "gh-a", host: "build3" }] }; } }, hostCapacity: async (name) => { assert.equal(name, "build3"); capacityReads++; return { hosts: [{ name }] }; } };
  const initial = await loadPageData("host", { name: "build3" }, deps);
  const live = await loadPageData("host", { name: "build3" }, deps, { live: true });
  assert.equal(initial.host, host);
  assert.equal(initial.hostHistory.records[0].host, "build3");
  assert.equal(capacityReads, 1);
  assert.deepEqual(historyReads[0].filter, { host: "build3" });
  assert.ok(initial.hostCapacity);
  assert.equal(live.hostCapacity, undefined);
  const panels = await pagePanels("host", { query: { name: "build3" }, data: live, session: { role: "viewer" } });
  assert.ok(!panels.some((panel) => panel.id === "p-hostcap"));
});

test("the two-Valkey resume command strips userinfo, query and fragment and shell-quotes its argument", () => {
  const result = killSwitchPlan({ paused: false, stateFn: () => ({ deploymentDir: null, owned: [] }), env: {}, resolveFn: () => ({ urls: ["redis://a/0", "redis://user:secret@b/1?password=hidden#token"], disagreement: "VALKEY_URL differs" }) });
  assert.equal(result.resumeCommand, "pi-dispatch resume --valkey-url 'redis://b/1'");
  assert.match(result.refused, /resumes neither/);
  assert.ok(!JSON.stringify(result).match(/secret|hidden|token|user:/));
});

test("the pause preview names queues and says which work keeps running and which waits", async () => {
  const preview = await actionNamed("fleet-pause").preview({}, { a: { fleet: { snapshot: async () => ({ queueCounts: [{ queue: "pi-jobs", counts: { active: 2, delayed: 3 } }, { queue: "pi-jobs:build3", counts: { active: 1, delayed: 4 } }], held: { rows: [{ jobId: "a" }] } }) }, paths: { valkeyUrl: "redis://h/0" }, urlShown: () => "redis://h/0" } });
  const lines = preview.summary.join("\n");
  assert.match(lines, /Queues: pi-jobs, pi-jobs:build3/);
  assert.match(lines, /3 running jobs keep running/);
  assert.match(lines, /7 delayed jobs and 1 held jobs wait until a resume/);
  assert.match(lines, /Audited as fleet-pause/);
  assert.match(lines, /Undo: Resume the fleet/);
});


test("host title names the selected host and its live headline updates published facts", async () => {
  const query = { name: "build3" };
  const ctx = { query, session: { role: "viewer" }, data: { now: AT, host: { name: "build3", version: "4.3.1", concurrency: "3", jobsMore: 0, jobs: [{ id: "gh-a" }], staleMs: 2000, backends: { blessed: ["local", "podman"], default: "local" } }, snapshot: {} } };
  const page = await renderPage("host", ctx);
  assert.match(String(page.html), /<h1>build3<\/h1>/);
  assert.match(String(page.html), /class="back" href="\/fleet"/);
  let panels = await pagePanels("host", ctx);
  assert.match(panels.find((p) => p.id === "p-headline").html, /local \(default\), podman · worker 4.3.1 · 1 of 3 slots taken/);
  ctx.data.host.jobs.push({ id: "gh-b" });
  ctx.data.live = true;
  panels = await pagePanels("host", ctx);
  assert.match(panels.find((p) => p.id === "p-headline").html, /2 of 3 slots taken/);
  assert.ok(!panels.some((p) => p.id === "p-hostcap"));
});

test("pause preview reports a truncated held count as a floor and an unread held count as unknown", async () => {
  for (const [held, sentence] of [[{ rows: [{ jobId: "a" }], more: 4, truncated: true }, "at least 5 held jobs"], [{ unreachable: true }, "an unknown number of held jobs"]]) {
    const preview = await actionNamed("fleet-pause").preview({}, { a: { fleet: { snapshot: async () => ({ queueCounts: [], held }) }, paths: {} } });
    assert.ok(preview.summary.join("\n").includes(sentence));
  }
});


test("a two-Valkey resume refusal renders a copy control in its preview without issuing a ticket", async () => {
  const resumeArgv = ["pi-dispatch", "resume", "--valkey-url", "redis://b/1"];
  const response = await previewAction({ body: {}, session: { id: "s", role: "operator" }, deps: { now: () => AT, log() {}, actionDeps: { fleet: {}, paths: {}, killSwitchPlanFn: () => ({ refused: "Resume neither until the Valkeys agree", resumeArgv }) }, tickets: { issue() { assert.fail("a refusal issues no paid ticket"); } } }, json: (status, body) => ({ status, body }) }, actionNamed("fleet-resume"));
  assert.equal(response.status, 400);
  assert.match(response.body.html, /data-copy/);
  assert.match(response.body.html, /redis:\/\/b\/1/);
  assert.match(response.body.html, /Nothing was changed/);
  for (const role of ["viewer", "operator"]) {
    const panels = await pagePanels("fleet", { session: { role }, data: { now: AT, snapshot: { queueCounts: [] }, killSwitch: { disagreement: "Two Valkeys", resumeArgv } } });
    assert.equal(panels.find((p) => p.id === "p-fleetbar").html.includes("data-copy"), role === "operator");
  }
});


test("a host headline never turns a missing overflow count or unreadable inventory into an exact occupied count", async () => {
  for (const [inventory, expected] of [
    [{ jobs: [{ id: "gh-a" }], jobsMore: null }, /at least 1 occupied slot listed; total not known/],
    [{ jobs: [{ id: "gh-a" }], jobsMore: undefined }, /at least 1 occupied slot listed; total not known/],
    [{ jobs: null, jobsMore: 0, jobsUnreadable: true }, /occupied slots not known/],
    [{ jobs: [{ id: "gh-a" }], jobsMore: 2 }, /3 of 4 slots taken/],
  ]) {
    const panels = await pagePanels("host", { query: { name: "build3" }, session: { role: "viewer" }, data: { now: AT, host: { name: "build3", concurrency: "4", staleMs: 1000, ...inventory }, snapshot: {} } });
    assert.match(panels.find((p) => p.id === "p-headline").html, expected);
  }
});
