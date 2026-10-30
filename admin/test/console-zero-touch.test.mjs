import assert from "node:assert/strict";
import { test } from "node:test";
import { zeroTouchView } from "../src/zero-touch-view.mjs";
import { loadPageData, parsePageQuery, pageQueryString, renderPage, panelIds } from "../src/console/pages.mjs";
import { ZERO_TOUCH_CAUSES, ZERO_TOUCH_WORDS } from "../src/console/panels/zero-touch.mjs";
import { zeroTouchFixture, ZERO_TOUCH_DRAW } from "./helpers/zero-touch-goldens.mjs";
import { assertClean } from "./helpers/console-pages-harness.mjs";
import { computeZeroTouch } from "@edgehero/pi-dispatch/zero-touch";
const NOW = 1800000000000;

test("Zero touch query refuses unknown, duplicate and malformed input before a reader is called", () => {
  for (const query of ["days=8", "days=7&days=30", "scope=../../secret", "project=<script>", "question=SECRET_QUESTION"]) {
    const result = parsePageQuery("zero-touch", query);
    assert.equal(typeof result.refusal, "string", query);
    assert.ok(!result.refusal.includes("SECRET_QUESTION"));
  }
  const parsed = parsePageQuery("zero-touch", "days=90&project=api").query;
  assert.deepEqual(parsed, { days: 90, project: "api", scope: null });
  assert.equal(pageQueryString("zero-touch", parsed), "days=90&project=api");
});

test("missing-project drilldowns preserve their reserved identity without changing ordinary project filters", async () => {
  const query = parsePageQuery("zero-touch", "days=7&project=%7E").query;
  assert.equal(query.project, "~");
  assert.deepEqual(parsePageQuery("zero-touch", pageQueryString("zero-touch", query)).query, query);
  const touched = parsePageQuery("runs", "touched=1&days=7&project=%7E").query;
  assert.equal(touched.filter.project, "~");
  assert.deepEqual(parsePageQuery("runs", pageQueryString("runs", touched)).query, touched);
  assert.equal(typeof parsePageQuery("runs", "project=%7E").refusal, "string", "the ordinary run project filter still takes project ids only");
  assert.equal(typeof parsePageQuery("zero-touch", "project=~&project=unassigned").refusal, "string");
  const scopeId = "a".repeat(64);
  const report = computeZeroTouch({ nowMs: NOW, windowDays: 7, coverage: { fromMs: NOW - 60 * 86400000 }, records: [{ jobId: "missing", project: null, touchScopeId: scopeId, touchTrackingVersion: 1, kind: "github", target: "acme/missing#1", endedAt: new Date(NOW - 86400000).toISOString() }], events: [{ runId: "missing", cause: "steer", at: NOW - 86400000 }] });
  const page = String((await renderPage("zero-touch", { session: { name: "ops", role: "operator" }, data: { now: NOW, zeroTouch: report }, query })).html);
  assert.match(page, /href="\/runs\/zero-touch\?days=7&amp;project=%7E"/);
  assert.match(page, new RegExp(`href="/runs/zero-touch\\?days=7&amp;project=%7E&amp;scope=${scopeId}"`), "the selected phone project reveals its repository link");
  assert.match(page, /href="\/runs\?project=%7E&amp;touched=1&amp;days=7"/);
  assert.match(page, /7 days, selected project/);
  assert.doesNotMatch(page, /7 days, all projects/);
});

test("desktop and phone show incomplete waiting history without suppressing the valid current rate", async () => {
  const scopeId = "a".repeat(64), day = 86400000;
  const report = computeZeroTouch({ nowMs: NOW, windowDays: 7, coverage: { fromMs: NOW - 50 * day }, records: [
    { jobId: "current", project: "api", touchScopeId: scopeId, touchTrackingVersion: 1, kind: "github", target: "acme/api#1", endedAt: new Date(NOW - day).toISOString() },
    { jobId: "old-approval", project: "api", touchScopeId: scopeId, touchTrackingVersion: 1, kind: "github", target: "acme/api#2", reason: "awaiting-approval", endedAt: new Date(NOW - 60 * day).toISOString() },
  ], events: [{ runId: "current", cause: "steer", at: NOW - day }] });
  const projected = zeroTouchView(report, { role: "viewer", nowMs: NOW });
  assert.deepEqual([projected.totals.rate, projected.totals.waitingHours, projected.totals.pending, projected.totals.waitingUnknown], [100, null, null, 1]);
  assert.equal(projected.projects[0].streakDays, null);
  assert.equal(projected.projects[0].zeroTouch, false);
  const rendered = String((await renderPage("zero-touch", { session: { name: "viewer", role: "viewer" }, data: { now: NOW, zeroTouch: report }, query: { days: 7 } })).html);
  assert.match(rendered, /100%/);
  assert.match(rendered, /1 of 1 runs needed a person/);
  assert.match(rendered, /class="zt-phone-summary"[^]*Waiting history is incomplete/);
  assert.match(rendered, /Waiting for a person[^]*Pending count not known/);
  assert.doesNotMatch(rendered, /0 waiting now|0 runs<\/b>|Not knownh/);
  assert.doesNotMatch(rendered, /zero touch, 30\+ days/);
});

test("page reads its bounded report once, without a fleet snapshot or classifier side effect", async () => {
  const calls = [];
  const query = { days: 7, project: "api", scope: null };
  const data = await loadPageData("zero-touch", query, { now: () => NOW, zeroTouch: async (q) => { calls.push(q); return zeroTouchFixture(NOW); }, fleet: { snapshot: () => assert.fail("no snapshot"), parkedCount: async () => 0 } }, { role: "viewer" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { windowDays: 7, project: "api", scopeId: null, role: "viewer" });
  assert.deepEqual(data.zeroTouch.groups, []);
  assert.equal(data.zeroTouch.totals.touched, 38);
});

test("role projection drops private and unknown data before rendering or result serialization", () => {
  const raw = zeroTouchFixture(NOW);
  raw.question = "SECRET_QUESTION"; raw.excerpts = ["SECRET_QUESTION"]; raw.groups[0].question = "SECRET_QUESTION";
  raw.fixes[0].sentence = "SECRET_INSTRUCTION"; raw.fixes[0].actor = "SECRET_ACTOR";
  const viewer = JSON.stringify(zeroTouchView(raw, { role: "viewer", nowMs: NOW }));
  for (const text of ["SECRET_QUESTION", "SECRET_INSTRUCTION", "SECRET_ACTOR", "Test command", "Package manager"]) assert.ok(!viewer.includes(text), text);
  const operator = JSON.stringify(zeroTouchView(raw, { role: "operator", nowMs: NOW }));
  assert.ok(operator.includes("Test command"));
  assert.ok(!operator.includes("SECRET_QUESTION"));
  assert.ok(!operator.includes("SECRET_INSTRUCTION"));
});

test("cause charts, project/repository values and metric scale retain the actual counts", async () => {
  const report = zeroTouchFixture(NOW);
  assert.equal(report.causes.reduce((sum, c) => sum + c.count, 0), report.totals.touched);
  assert.deepEqual(ZERO_TOUCH_CAUSES.map((c) => c.cause), report.causes.map((c) => c.cause));
  const result = await renderPage("zero-touch", { session: { name: "ops", role: "operator" }, data: { now: NOW, zeroTouch: report }, query: { days: 30, project: "api" } });
  const html = String(result.html);
  assert.match(html, /38 of 214 runs needed a person/);
  assert.match(html, /acme\/api-docs/);
  assert.match(html, /aria-valuenow="4\.0"/);
  assert.match(html, /width="10\.0%"/); // 4% on the published card's 40% meter scale.
  assert.match(html, /x1="12.5%"/); // The same scale places the 5% goal here.
  assert.match(html, /full scale 13 touched runs/);
  assert.match(html, /Questions 9, Approvals 2, Failed or refused, then re-run 2/);
  assert.match(html, /aria-current="page"[^>]*>.*?Zero touch/);
  assert.match(html, /<details class="zt-p" open>/);
  assert.equal(panelIds("zero-touch").length, 8);
});

test("operators can preview only guarded writes; viewer/read-only keep the read interactions", async () => {
  const operator = await ZERO_TOUCH_DRAW["zero-touch-populated.operator"]();
  for (const action of ["zero-touch-name", "zero-touch-instruction", "zero-touch-group", "zero-touch-undo"]) assert.ok(operator.includes(`data-action="${action}"`), action);
  assert.ok(!operator.includes("Draft it for me")); assert.ok(!operator.includes("Save standing answer"));
  for (const key of ["zero-touch-populated.viewer", "zero-touch-readonly.operator"]) {
    const html = await ZERO_TOUCH_DRAW[key]();
    assert.ok(!html.includes("data-action="), key);
    assert.ok(html.includes("<details class=\"zt-p\""));
    assert.ok(html.includes("/runs/zero-touch?days=7"));
  }
  const viewer = await ZERO_TOUCH_DRAW["zero-touch-populated.viewer"]();
  assert.ok(!viewer.includes("Test command")); assert.ok(!viewer.includes("gh-71c2"));
});

test("missing and partial history cannot render a reassuring zero-rate or successful fix", async () => {
  const unavailable = await ZERO_TOUCH_DRAW["zero-touch-unavailable.operator"]();
  assert.ok(unavailable.includes(ZERO_TOUCH_WORDS.unavailable));
  assert.ok(!unavailable.includes("<b>0%"));
  assert.ok(!unavailable.includes("undefined"));
  assert.ok(!unavailable.includes("No workload runs ended"));
  const partial = await ZERO_TOUCH_DRAW["zero-touch-partial.operator"]();
  assert.ok(partial.includes("Partial 90-day window"));
  assert.ok(partial.includes("Previous interval not covered"));
  const observing = await ZERO_TOUCH_DRAW["zero-touch-observing.operator"]();
  assert.ok(observing.includes("Partial observation: effectiveness is not established."));
});

test("unreadable touch coverage and a collapsed observed window never render known zero counts", async () => {
  for (const reasons of [["touch-index-unavailable"], ["touch-index-lost"], ["touch-actions-unresolved"], ["touch-tracking-not-started"]]) {
    const raw = zeroTouchFixture(NOW);
    raw.coverage = { requestedFromMs: NOW - 30 * 86400_000, fromMs: reasons[0] === "touch-index-unavailable" ? NOW - 10 * 86400_000 : NOW, partial: true, reasons };
    raw.totals = { runs: 0, touched: 0, rate: null };
    const shown = zeroTouchView(raw, { role: "operator", nowMs: NOW });
    assert.equal(shown.state, "unavailable", reasons[0]);
    assert.deepEqual(shown.totals, {}, reasons[0]);
    assert.deepEqual(shown.projects, [], reasons[0]);
    const page = String((await renderPage("zero-touch", { session: { name: "ops", role: "operator" }, data: { now: NOW, zeroTouch: raw }, query: { days: 30 } })).html);
    assert.ok(page.includes(ZERO_TOUCH_WORDS.unavailable));
    for (const claim of ["0 of 0", "No runs", "No touches", "Runs that needed a person</b>"]) assert.ok(!page.includes(claim), `${reasons[0]}: ${claim}`);
  }
  const partial = zeroTouchFixture(NOW);
  partial.coverage = { requestedFromMs: NOW - 90 * 86400_000, fromMs: NOW - 10 * 86400_000, partial: true, reasons: ["retained-window"] };
  const shown = zeroTouchView(partial, { role: "viewer", nowMs: NOW });
  assert.equal(shown.state, "ready", "a shorter observed interval remains useful");
  assert.equal(shown.totals.touched, 38);
  assert.equal(shown.totals.runs, 214);
});

test("waiting links, previous-rate words, human name bounds and private-context failures match the cards", async () => {
  const report = zeroTouchFixture(NOW);
  report.groups[0].name = "😀".repeat(120);
  const shown = zeroTouchView(report, { role: "operator", nowMs: NOW });
  assert.equal([...shown.groups[0].name].length, 120);
  const populated = await ZERO_TOUCH_DRAW["zero-touch-populated.operator"]();
  assert.ok(populated.includes("gh-2f6a</a>, 26m"));
  assert.ok(populated.includes("from 24%"));
  assert.ok(populated.includes("none since"));
  const errors = await ZERO_TOUCH_DRAW["zero-touch-grouping-errors.operator"]();
  assert.ok(errors.includes('data-group-status="source-expired"'));
  assert.ok(errors.includes("a new grouping job cannot restore it"));
  assert.ok(errors.includes("The grouping job failed"));
  assert.ok(!errors.includes('value="gh-group-0"')); // Expired source has a link, never a paid retry control.
  assert.ok(populated.includes("<fieldset data-config-controls disabled>"));
  assert.ok(populated.includes("Reading and navigation work without it."));
});

test("a scoped selection exposes stops whose project cannot be recovered", async () => {
  const report = zeroTouchFixture(NOW); report.totals.stopped = 0; report.totals.stoppedUnattributed = 3;
  const result = await renderPage("zero-touch", { session: { name: "ops", role: "viewer" }, data: { now: NOW, zeroTouch: report }, query: { days: 30, project: "api" } });
  assert.ok(String(result.html).includes("3 stops have no recorded project or scope, so this selection may have more."));
});

test("every exceptional-state fixture obeys the page reference and markup rules", async () => {
  for (const [key, draw] of Object.entries(ZERO_TOUCH_DRAW)) assertClean(key, await draw());
});

test("touched-run links keep their exact window and scope through canonical live refresh queries", async () => {
  const scope = "a".repeat(64);
  const parsed = parsePageQuery("runs", `project=api&touched=1&days=90&scope=${scope}`);
  assert.ok(!parsed.refusal);
  const canonical = pageQueryString("runs", parsed.query);
  assert.equal(canonical, `project=api&touched=1&days=90&scope=${scope}`);
  assert.deepEqual(parsePageQuery("runs", canonical), parsed);
  const calls = [];
  await loadPageData("runs", parsed.query, { now: () => NOW, zeroTouchRuns: async (query) => { calls.push(query); return { runs: [], next: null, mirror: "ok", touchTotal: 3 }; }, fleet: { snapshot: async () => ({}), runsPage: () => assert.fail("a touched stream must not use the ordinary unfiltered page"), runsWindow: async () => null, parkedCount: async () => 0 } }, { role: "operator" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].windowDays, 90);
  assert.equal(calls[0].scopeId, scope);
  for (const query of ["touched=2", "touched=1&days=8", "days=90", "touched=1&scope=../escape"]) assert.ok(parsePageQuery("runs", query).refusal, query);
});

test("unreadable grouping and fix stores never announce known empty histories", async () => {
  const raw = zeroTouchFixture(NOW);
  raw.groups = []; raw.fixes = [];
  raw.grouping = { enabled: true, state: "unavailable", partial: true };
  raw.fixesPartial = true;
  const page = String((await renderPage("zero-touch", { session: { name: "ops", role: "operator" }, data: { now: NOW, zeroTouch: raw }, query: { days: 30 } })).html);
  assert.ok(page.includes("Question groups could not be read"));
  assert.ok(page.includes("Fix history is incomplete"));
  assert.ok(!page.includes(ZERO_TOUCH_WORDS.noGroups));
  assert.ok(!page.includes(ZERO_TOUCH_WORDS.noFixes));
});

test("fix observations distinguish improvement, regression, unchanged and unproven effectiveness", async () => {
  const cases = [
    [{ beforeCount: 0, afterCount: 5, status: "worse" }, "failed", "More occurrences over equal observed spans."],
    [{ beforeCount: 5, afterCount: 0, status: "improved" }, "ok", "Fewer occurrences over equal observed spans."],
    [{ beforeCount: 5, afterCount: 5, status: "unchanged" }, "idle", "The same number of occurrences over equal observed spans."],
    [{ status: "improved", partial: true }, "idle", "Partial observation: effectiveness is not established."],
    [{ status: "improved", subsequentRuns: 0 }, "idle", "No subsequent runs yet: effectiveness is not established."],
    [{ status: "improved", undoneAt: NOW - 1000 }, "idle", "Reverted: this observation does not establish current effectiveness."],
  ];
  for (const [changes, tone, observation] of cases) {
    const report = zeroTouchFixture(NOW);
    report.fixes = [{ ...report.fixes[0], ...changes }];
    const page = String((await renderPage("zero-touch", { session: { name: "ops", role: "operator" }, data: { now: NOW, zeroTouch: report }, query: { days: 30 } })).html);
    assert.ok(page.includes(observation), JSON.stringify(changes));
    assert.ok(page.includes(`<span>After</span><svg class="pbar tone-${tone}"`), JSON.stringify(changes));
    if (tone !== "ok") assert.ok(!page.includes('<span>After</span><svg class="pbar tone-ok"'));
  }
});
