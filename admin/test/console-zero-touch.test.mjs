import assert from "node:assert/strict";
import { test } from "node:test";
import { zeroTouchView, ZERO_TOUCH_NOT_STARTED, ZERO_TOUCH_UNREAD_REASONS } from "../src/zero-touch-view.mjs";
import { loadPageData, parsePageQuery, pageQueryString, renderPage, panelIds } from "../src/console/pages.mjs";
import { ZERO_TOUCH_CAUSES, ZERO_TOUCH_PANELS, ZERO_TOUCH_WORDS, zeroTouchHandled, zeroTouchStreak } from "../src/console/panels/zero-touch.mjs";
import { zeroTouchFixture, ZERO_TOUCH_DRAW } from "./helpers/zero-touch-goldens.mjs";
import { assertClean } from "./helpers/console-pages-harness.mjs";
import { makeZeroTouchService } from "../src/zero-touch-data.mjs";
import { computeZeroTouch, TOUCH_NOT_STARTED, TOUCH_UNREAD_REASONS } from "@edgehero/pi-dispatch/zero-touch";
const NOW = 1800000000000;
/** The words of a page, tags and the scripts' own text dropped. */
const wordsOf = (page) => String(page).replace(/<(script|style|template)\b[^]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");

test("desktop and phone render the same actual draft-answer recount for every reading role and selected interval", async () => {
  const day = 86400000, scope = "a".repeat(64), other = "b".repeat(64);
  const records = [["as-drafted", 1, "api", scope], ["edited", 12, "api", scope], ["other-repo", 1, "api", other], ["other-project", 1, "web", other], ["offered", 1, "api", scope], ["helper", 1, "api", scope]].map(([jobId, days, project, touchScopeId]) => ({ jobId, project, touchScopeId, kind: "github", target: `acme/${project}#1`, touchTrackingVersion: 1, endedAt: new Date(NOW - days * day).toISOString(), ...(jobId === "helper" ? { purpose: "answer-draft" } : {}) }));
  const events = ["as-drafted", "as-drafted", "edited", "other-repo", "other-project", "helper"].map(runId => ({ runId, cause: "question-answer", answerSource: "draft", draftRunId: "private-helper", at: NOW - day }));
  for (const [selection, expected] of [[{}, 4], [{ project: "api" }, 3], [{ project: "api", scopeId: scope }, 2], [{ project: "api", scopeId: scope, windowDays: 7 }, 1]]) {
    const report = computeZeroTouch({ records, events, nowMs: NOW, coverage: { fromMs: NOW - 90 * day }, ...selection });
    assert.equal(report.totals.draftAnswers, expected);
    for (const role of ["operator", "viewer", "agent"]) {
      const page = String((await renderPage("zero-touch", { session: { name: "reader", role }, data: { now: NOW, zeroTouch: report }, query: { days: selection.windowDays ?? 30, project: selection.project ?? null, scope: selection.scopeId ?? null } })).html);
      const tile = page.match(/<section id="p-zt-handled" data-panel>([^]*?)<\/section>/)?.[1];
      const phone = page.match(/<ul class="ztp-now">([^]*?)<\/ul>/)?.[1];
      assert.match(tile, new RegExp(`<b>${expected}</b><span>runs answered in the covered interval</span>`), `${role}: selected desktop count`);
      assert.match(phone, new RegExp(`Answered from a draft</span><b>${expected} ${expected === 1 ? "run" : "runs"}</b>`), `${role}: selected phone count`);
      for (const markup of [tile, phone]) {
        assert.ok(markup.includes(ZERO_TOUCH_WORDS.drafts));
        assert.doesNotMatch(markup, /Coming next|Available with|#772|private-helper|as-drafted|other-project/);
      }
    }
  }
});

test("draft counts distinguish covered zero, partial retained counts and unavailable history", async () => {
  for (const count of [0, 1, 6]) {
    const raw = zeroTouchFixture(NOW); raw.totals.draftAnswers = count;
    const view = { role: "viewer", data: { zeroTouch: raw }, query: { days: 30 }, now: NOW };
    assert.match(String(zeroTouchHandled(view)), new RegExp(`<b>${count}</b>`));
    raw.coverage.partial = true;
    assert.ok(String(zeroTouchHandled(view)).includes(ZERO_TOUCH_WORDS.draftsPartial));
    const page = String((await renderPage("zero-touch", { session: { name: "reader", role: "viewer" }, data: { now: NOW, zeroTouch: raw }, query: { days: 30 } })).html);
    assert.ok(page.match(/<ul class="ztp-now">([^]*?)<\/ul>/)?.[1].includes(ZERO_TOUCH_WORDS.draftsPartial), "the phone cannot silently present the retained suffix as a whole-window count");
  }
  for (const raw of [null, { state: "unavailable", totals: { draftAnswers: 0 } }, { ...zeroTouchFixture(NOW), coverage: { partial: true, fromMs: NOW, reasons: ["touch-index-lost"] } }]) {
    const tile = String(zeroTouchHandled({ role: "operator", data: { zeroTouch: raw }, query: { days: 30 }, now: NOW }));
    assert.ok(tile.includes(ZERO_TOUCH_WORDS.unavailable));
    assert.doesNotMatch(tile, /class="kpi"|<b>0<\/b>/, "lost evidence is not a known zero");
  }
});

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
  const phoneWait = rendered.match(/Waiting now<\/span>([^]*?)<\/li>/)?.[1];
  const waitPanel = rendered.match(/<section id="p-zt-wait" data-panel>([^]*?)<\/section>/)?.[1];
  assert.ok(phoneWait && waitPanel);
  // A covered zero draft-answer count is valid beside an unknown old wait. Judge the waiting claims themselves.
  assert.doesNotMatch(phoneWait + waitPanel, /0 waiting now|0 runs<\/b>|Not knownh/);
  assert.doesNotMatch(rendered, /zero touch, 30\+ days/);
});

test("page reads its bounded report once, without a fleet snapshot or classifier side effect", async () => {
  const calls = [];
  const query = { days: 7, project: "api", scope: null };
  const data = await loadPageData("zero-touch", query, { now: () => NOW, zeroTouch: async (q) => { calls.push(q); return zeroTouchFixture(NOW); }, fleet: { snapshot: () => assert.fail("no snapshot"), parkedCount: async () => 0 } }, { role: "viewer" });
  assert.equal(calls.length, 1);
  // The read is also handed the page's deadline (`within`, issue #988), a function and no part of what is asked for.
  const { within, ...asked } = calls[0];
  assert.equal(typeof within, "function");
  assert.deepEqual(asked, { windowDays: 7, project: "api", scopeId: null, role: "viewer" });
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
  // Tracking that has not started beside evidence that was lost or not read is still unread: the last three.
  for (const reasons of [["touch-index-unavailable"], ["touch-index-lost"], ["touch-actions-unresolved"], ["touch-events-missing"], ["touch-tracking-not-started", "touch-index-lost"], ["touch-tracking-not-started", "touch-actions-unresolved"], ["touch-tracking-not-started", "touch-index-unavailable"]]) {
    const raw = zeroTouchFixture(NOW);
    raw.coverage = { requestedFromMs: NOW - 30 * 86400_000, fromMs: reasons[0] === "touch-index-unavailable" ? NOW - 10 * 86400_000 : NOW, partial: true, reasons };
    raw.totals = { runs: 0, touched: 0, rate: null };
    const shown = zeroTouchView(raw, { role: "operator", nowMs: NOW });
    assert.equal(shown.state, "unavailable", reasons.join());
    assert.deepEqual(shown.totals, {}, reasons.join());
    assert.deepEqual(shown.projects, [], reasons.join());
    const page = String((await renderPage("zero-touch", { session: { name: "ops", role: "operator" }, data: { now: NOW, zeroTouch: raw }, query: { days: 30 } })).html);
    assert.ok(page.includes(ZERO_TOUCH_WORDS.unavailable));
    assert.ok(!page.includes(ZERO_TOUCH_WORDS.notStarted), reasons.join());
    for (const claim of ["0 of 0", "No runs", "No touches", "Runs that needed a person</b>"]) assert.ok(!page.includes(claim), `${reasons.join()}: ${claim}`);
  }
  const partial = zeroTouchFixture(NOW);
  partial.coverage = { requestedFromMs: NOW - 90 * 86400_000, fromMs: NOW - 10 * 86400_000, partial: true, reasons: ["retained-window"] };
  const shown = zeroTouchView(partial, { role: "viewer", nowMs: NOW });
  assert.equal(shown.state, "ready", "a shorter observed interval remains useful");
  assert.equal(shown.totals.touched, 38);
  assert.equal(shown.totals.runs, 214);
});

test("tracking that has not started says so once, with no totals and no zeros, and is not a failed read", async () => {
  const notStarted = (over = {}) => { const raw = zeroTouchFixture(NOW); raw.coverage = { requestedFromMs: NOW - 30 * 86400_000, fromMs: NOW, partial: true, reasons: ["touch-tracking-not-started"] }; raw.totals = { runs: 0, touched: 0, rate: null, draftAnswers: 0, pending: 0, waitingHours: 0, stopped: 0 }; return Object.assign(raw, over); };
  // By its reasons alone, and by the state the worker's report carries.
  for (const raw of [notStarted(), notStarted({ state: "not-started" })]) {
    for (const role of ["operator", "viewer"]) {
      const shown = zeroTouchView(raw, { role, nowMs: NOW });
      assert.equal(shown.state, "not-started");
      assert.deepEqual([shown.totals, shown.projects, shown.groups, shown.fixes, shown.trend], [{}, [], [], [], []]);
      assert.deepEqual(zeroTouchView(shown, { role, nowMs: NOW }), shown, "the page's projection is read again by each panel");
      const page = String((await renderPage("zero-touch", { session: { name: role, role }, data: { now: NOW, zeroTouch: raw }, query: { days: 30 } })).html);
      const words = wordsOf(page);
      assert.equal(words.split(ZERO_TOUCH_WORDS.notStarted).length - 1, 1, "said once");
      assert.ok(!words.includes("could not be read"), "nothing failed");
      for (const claim of ["0 of 0", "No runs", "No touches", "Not enough history", " 0 runs", " 0h", "0 waiting now", "0 fixes recorded", " 0% ", ZERO_TOUCH_WORDS.empty, ZERO_TOUCH_WORDS.noFixes, ZERO_TOUCH_WORDS.noGroups, "undefined", "NaN"]) assert.ok(!words.includes(claim), `${role}: ${claim}`);
      assert.ok(!page.includes("<b>0</b>") && !page.includes("<b>0%"));
      assert.deepEqual([...page.matchAll(/<section id="(p-zt-[a-z]+)"/g)].map((m) => m[1]), ["p-zt-rate"], "the rate card alone");
      assert.ok(page.includes("/runs/zero-touch?days=7"), "the window can still be chosen");
      // The card keeps the window that was asked for, the report's own or the page's.
      for (const days of [7, 90]) {
        assert.equal(zeroTouchView({ ...raw, windowDays: days }, { role, nowMs: NOW }).windowDays, days);
        assert.equal(zeroTouchView({ ...raw, windowDays: undefined }, { role, nowMs: NOW, windowDays: days }).windowDays, days);
        const asked = wordsOf((await renderPage("zero-touch", { session: { name: role, role }, data: { now: NOW, zeroTouch: { ...raw, windowDays: days } }, query: { days } })).html);
        assert.ok(asked.includes(`Touch rate, ${days} days`), `${role}: ${days} days`);
      }
    }
  }
  // Each card on its own, as a reader of one panel gets it: a title, and no count.
  const view = { role: "operator", now: NOW, query: { days: 30 }, data: { zeroTouch: zeroTouchView(notStarted(), { role: "operator", nowMs: NOW }) } };
  for (const [id, panel] of ZERO_TOUCH_PANELS) {
    const words = String(panel(view)).replace(/<[^>]+>/g, " ");
    assert.ok(!/\d/.test(words.replace("Touch rate, 30 days", "")), `${id}: ${words}`);
    assert.equal(words.includes(ZERO_TOUCH_WORDS.notStarted), id === "p-zt-rate", id);
    if (id !== "p-zt-rate") assert.ok(!String(panel(view)).includes("<p"), `${id}: a title and nothing under it`);
  }
  // The golden is that state, drawn through the page's own load.
  const golden = wordsOf(await ZERO_TOUCH_DRAW["zero-touch-not-started.operator"]());
  assert.equal(golden.split(ZERO_TOUCH_WORDS.notStarted).length - 1, 1);
  assert.ok(!golden.includes("could not be read"));
  // The control: a read that showed an interval with no runs in it keeps its own empty words and its zeros.
  const empty = await ZERO_TOUCH_DRAW["zero-touch-empty.viewer"]();
  assert.ok(empty.includes("No runs") && empty.includes("0 of 0 runs needed a person") && !empty.includes(ZERO_TOUCH_WORDS.notStarted) && !empty.includes(ZERO_TOUCH_WORDS.unavailable));
  // A report the worker called unavailable stays so, whatever its reasons hold.
  assert.equal(zeroTouchView(notStarted({ state: "unavailable" }), { role: "viewer", nowMs: NOW }).state, "unavailable");
  // A started index over a short interval is ready, as before.
  const started = notStarted({ coverage: { requestedFromMs: NOW - 30 * 86400_000, fromMs: NOW - 3600_000, partial: true, reasons: [] } });
  assert.equal(zeroTouchView(started, { role: "viewer", nowMs: NOW }).state, "ready");
});

test("the view's reason lists are the worker's own", () => {
  assert.equal(ZERO_TOUCH_NOT_STARTED, TOUCH_NOT_STARTED);
  assert.deepEqual([...ZERO_TOUCH_UNREAD_REASONS], [...TOUCH_UNREAD_REASONS]);
});

test("a read that throws is caught and says what failed; a read that answered nothing says only that it could not be read", async () => {
  const load = (zeroTouch) => loadPageData("zero-touch", { days: 30 }, { now: () => NOW, zeroTouch, fleet: { parkedCount: async () => 0 } }, { role: "operator" });
  const page = async (data) => wordsOf((await renderPage("zero-touch", { session: { name: "ops", role: "operator" }, data, query: { days: 30 } })).html);
  const thrown = await load(async () => { throw new Error("ECONNREFUSED 10.0.0.7:6379 /srv/secret/path"); });
  assert.deepEqual([thrown.zeroTouch.state, thrown.zeroTouch.failure], ["unavailable", "read-failed"]);
  const said = await page(thrown);
  assert.equal(said.split(ZERO_TOUCH_WORDS.readFailed).length - 1, 1, "the reason, once");
  assert.equal(ZERO_TOUCH_WORDS.readFailed, "The read itself failed on this console. Its log has the reason.", "only what is known: no cause is guessed");
  // The log the sentence points at: one line, the error's code or kind, never its text. A log that throws fails no page.
  const lines = [];
  const logged = (zeroTouch, log = (line) => lines.push(line)) => loadPageData("zero-touch", { days: 30 }, { now: () => NOW, zeroTouch, log, fleet: { parkedCount: async () => 0 } }, { role: "operator" });
  await logged(async () => { throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:6379"), { code: "ECONNREFUSED" }); });
  await logged(async () => { throw new TypeError("/srv/secret/path is not a record"); });
  await logged(async () => { throw Object.assign(new Error("x"), { code: "bad code\n/srv/secret", name: "also bad/name" }); });
  await logged(async () => zeroTouchFixture(NOW));
  await logged(async () => null);
  assert.deepEqual(lines, ["console: the Zero touch read failed (ECONNREFUSED)", "console: the Zero touch read failed (TypeError)", "console: the Zero touch read failed (error)"]);
  assert.equal((await logged(async () => { throw new Error("down"); }, () => { throw new Error("log is gone"); })).zeroTouch.failure, "read-failed");
  assert.ok(said.includes(ZERO_TOUCH_WORDS.unavailable));
  assert.ok(!said.includes("ECONNREFUSED") && !said.includes("/srv/secret"), "never the error's own text");
  assert.ok(!said.includes(ZERO_TOUCH_WORDS.notStarted));
  // A failure the panel has no sentence for is not carried.
  assert.ok(!Object.hasOwn(zeroTouchView({ state: "unavailable", failure: "<b>anything</b>" }, { role: "operator", nowMs: NOW }), "failure"));
  // The controls: a read that answered null, and one that answered, say no such reason.
  const none = await load(async () => null);
  assert.ok(!Object.hasOwn(none.zeroTouch, "failure"));
  const plain = await page(none);
  assert.ok(plain.includes(ZERO_TOUCH_WORDS.unavailable) && !plain.includes(ZERO_TOUCH_WORDS.readFailed));
  const read = await page(await load(async () => zeroTouchFixture(NOW)));
  assert.ok(!read.includes(ZERO_TOUCH_WORDS.readFailed) && !read.includes(ZERO_TOUCH_WORDS.unavailable));
});

test("the streak card says could not be read alone under a read that failed, and its own words only of a read that answered", async () => {
  const card = (zeroTouch) => String(zeroTouchStreak({ role: "operator", now: NOW, query: { days: 30 }, data: { zeroTouch } })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  for (const unread of [null, { state: "unavailable" }, { state: "unavailable", failure: "read-failed" }]) {
    assert.equal(card(unread), `Zero-touch streak ${ZERO_TOUCH_WORDS.unavailable}`, JSON.stringify(unread));
  }
  const page = wordsOf(await ZERO_TOUCH_DRAW["zero-touch-unavailable.operator"]());
  for (const said of ["Not enough history", "30 days of observed activity establish a zero-touch project"]) assert.ok(!page.includes(said), said);
  // The control: a read that answered with no streak yet keeps "Not enough history".
  const raw = zeroTouchFixture(NOW);
  raw.projects = [];
  const read = card(raw);
  assert.ok(read.includes("Not enough history") && read.includes("30 days of observed activity establish a zero-touch project") && !read.includes(ZERO_TOUCH_WORDS.unavailable));
});

test("the touched-runs count is known only from a ready report", async () => {
  const service = makeZeroTouchService({ paths: { valkeyUrl: "redis://unused", logsDir: "/nonexistent/zero-touch-runs", triggersPath: "/nonexistent/zero-touch-runs/triggers.json" } });
  const total = async (state) => (await service.runs.call({ read: async () => ({ state, records: [], touchedRunIds: [], coverage: { partial: state !== "ready" }, totals: { touched: 0 } }) }, {})).touchTotal;
  assert.equal(await total("ready"), 0);
  assert.equal(await total("unavailable"), null);
  assert.equal(await total("not-started"), null, "a window that covers no interval counted nothing: not a known 0");
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

test("a fix whose accounting did not finish and that no reload settles is said so, with what ends it; other gaps keep Reload to retry (#987)", async () => {
  const draw = async (change) => {
    const raw = zeroTouchFixture(NOW);
    change(raw);
    return String((await renderPage("zero-touch", { session: { name: "ops", role: "operator" }, data: { now: NOW, zeroTouch: raw }, query: { days: 30 } })).html);
  };
  // It said "Reload to retry" of a row a reload never cleared.
  const open = await draw((raw) => { raw.fixesPartial = true; raw.fixesOpen = 1; raw.fixesOpenDays = 30; });
  assert.ok(open.includes("Fix history is incomplete: the accounting of 1 change did not finish and its file does not show it, so a reload does not settle it. Left alone, its record ends by itself within 30 days of the attempt. Missing changes are not evidence that no fix was made."), open.match(/Fix history[^<]*/)?.[0]);
  // Nothing is promised of making the change again: it may not be possible (the file already reads so), and where it
  // is, the open row is committed beside the new one.
  assert.ok(!open.includes("Reload to retry") && !/made again|counted once/i.test(open));
  const two = await draw((raw) => { raw.fixesPartial = true; raw.fixesOpen = 2; raw.fixesOpenDays = 1; });
  assert.ok(two.includes("Fix history is incomplete: the accounting of 2 changes did not finish and their files do not show them, so a reload does not settle it. Left alone, their records end by themselves within 1 day of the attempt."), two.match(/Fix history[^<]*/)?.[0]);
  // A history that could not be read, or whose repair did not run to its end, is one a reload can mend.
  const unread = await draw((raw) => { raw.fixesPartial = true; raw.fixesOpen = 0; });
  assert.ok(unread.includes("Fix history is incomplete. Reload to retry; missing changes are not evidence that no fix was made."));
  // Nothing open and nothing missing: no note.
  assert.ok(!(await draw((raw) => { raw.fixesPartial = false; raw.fixesOpen = 3; })).includes("Fix history is incomplete"));
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

test("a stacked cause chart contains all causes even when the supplied summary is smaller than its stack", async () => {
  const report = zeroTouchFixture(NOW);
  report.totals.touched = 0;
  const page = String((await renderPage("zero-touch", { session: { name: "ops", role: "viewer" }, data: { now: NOW, zeroTouch: report }, query: { days: 30 } })).html);
  const chart = page.match(/<div class="zt-phone-causes">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(chart);
  assert.match(chart, /full scale 38 touched runs/);
  const segments = [...chart.matchAll(/x="([\d.]+)%" y="0" width="([\d.]+)%"/g)].map((m) => ({ start: Number(m[1]), width: Number(m[2]) }));
  assert.equal(segments.length, 6, "every nonzero cause survives; clipping or dropping the last cause is not a fix");
  for (const segment of segments) assert.ok(segment.start >= 0 && segment.width > 0 && segment.start + segment.width <= 100.1, JSON.stringify(segment));
  assert.ok(Math.abs(segments.at(-1).start + segments.at(-1).width - 100) < 0.1);
  for (const [label, value] of [["Questions", 17], ["Approvals", 5], ["Failed or refused, then re-run", 7], ["Refused until config was fixed", 5], ["Steered", 3], ["Cancelled", 1]]) assert.ok(chart.includes(`${label} ${value}`));
  report.projects = [report.projects[1], report.projects[0]];
  report.projects[0].touched = 0; // Thirteen actual cause occurrences, beside the nine-count sibling.
  const scoped = String((await renderPage("zero-touch", { session: { name: "ops", role: "viewer" }, data: { now: NOW, zeroTouch: report }, query: { days: 30 } })).html);
  const desktop = scoped.match(/<ul class="zt-bars zt-desktop-causes">([\s\S]*?)<\/ul>/)?.[1];
  assert.ok(desktop);
  assert.deepEqual([...desktop.matchAll(/full scale (\d+) touched runs/g)].map((m) => Number(m[1])), [13, 13], "unequal project stacks retain one shared scale even with an inconsistent summary");
  const ends = [...desktop.matchAll(/<svg class="zt-cause-svg"[^>]*>([\s\S]*?)<\/svg>/g)].map((svg) => {
    const last = [...svg[1].matchAll(/x="([\d.]+)%" y="0" width="([\d.]+)%"/g)].at(-1);
    return Number(last[1]) + Number(last[2]);
  });
  assert.ok(Math.abs(ends[0] - 100) < 0.1);
  assert.ok(Math.abs(ends[1] - 9 / 13 * 100) < 0.1, "the smaller stack is visibly smaller on the common scale");
  const empty = await ZERO_TOUCH_DRAW["zero-touch-empty.viewer"]();
  assert.ok(!empty.includes('<rect class="zt-cause-rect"'), "a true empty report has no invented cause segments");
  assert.ok(empty.includes("No workload runs ended in the covered interval."));
});
