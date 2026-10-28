import { test } from "node:test";
import assert from "node:assert/strict";
import { REASONS, explainReason } from "@edgehero/pi-dispatch/reason-catalog";
import { RUN_KINDS } from "@edgehero/pi-dispatch/forges";
import { isSafeHtml } from "../src/console/html.mjs";
import * as ui from "../src/console/kit.mjs";
import { NO_REASON_SHORT, outcomeCell } from "../src/console/panels/common.mjs";
import {
  RUNS_DAY_UNKNOWN,
  RUNS_EMPTY,
  RUNS_HOST_UNREADABLE,
  RUNS_MIRROR_DEGRADED,
  RUNS_MIRROR_OFF,
  RUNS_UNREADABLE,
  RUNS_WINDOW_EVERY_PROJECT,
  RUNS_WINDOW_PARTIAL,
  RUNS_WINDOW_TEXT,
  RUNS_WINDOW_UNREAD,
  runsFiltersModel,
  runsSourceText,
  runsSummary,
  runsSummaryModel,
  runsTableModel,
  runsTruncatedText,
} from "../src/console/panels/runs.mjs";
import { RUN_FILTER_FIELDS, parseRunFilter } from "../src/run-filter.mjs";
import { NO_EXPLANATION, NO_REASON_FAILED, OUTCOME_KEYS, OUTCOME_KEY_WORDS, shortSentence } from "../src/words.mjs";

// Issue #737: the runs screen's three panels (the RunsScreen, RunsPhone and DataTable cards) and the outcome cell the
// runs table and the run page's chain share. Each panel is a pure model (the arguments it hands the kit) and its
// drawing, so these tests read the models; the pages' goldens hold the markup they draw.

const NOW = Date.UTC(2026, 9, 8, 15, 39, 8);

/** A page query as `parsePageQuery` gives the runs page one: the filter, and `before` in millis. */
function queryOf(qs) {
  const p = new URLSearchParams(qs);
  const before = p.get("before");
  p.delete("before");
  const { filter, refusal } = parseRunFilter(p);
  assert.equal(refusal, undefined, `the fixture's query parses: ${qs}`);
  return { filter, before: before === null ? null : Number(before) };
}

/** A runs page's view, as `pages.mjs` hands a panel one. */
const viewOf = ({ role = "operator", qs = "", data = {}, now = NOW, env = {} } = {}) => ({ page: "runs", role, readOnly: false, query: queryOf(qs), env, now, pages: null, data: { subscriptions: [], ...data } });

/**
 * Whether `href` is a runs page the console takes: the runs path, only the filter's fields and `before`, each once, a
 * filter `parseRunFilter` accepts. Returns the parsed filter.
 */
function runsLink(href) {
  const u = new URL(href, "http://console.test");
  assert.equal(u.pathname, "/runs", href);
  for (const k of new Set(u.searchParams.keys())) {
    assert.ok([...RUN_FILTER_FIELDS, "before"].includes(k), `${href}: ${k} is a runs parameter`);
    assert.equal(u.searchParams.getAll(k).length, 1, `${href}: ${k} once`);
  }
  u.searchParams.delete("before");
  const got = parseRunFilter(u.searchParams);
  assert.equal(got.refusal, undefined, `${href} parses`);
  return got.filter;
}

/** A model as plain data: each fragment as its markup, so a model can be compared and searched as text. */
const plain = (m) => JSON.stringify(m, (_k, v) => (isSafeHtml(v) ? String(v) : v));

/** The last 24 hours, as the fleet reader's `runsWindow` folds them. */
const WINDOW = Object.freeze({
  at: NOW,
  floor: false,
  partial: false,
  byOutcome: { completed: 23, refused: 1, failed: 2, "awaiting-input": 1, cancelled: 1, other: 0 },
  byProject: [
    { project: "web", count: 11, byOutcome: { completed: 9, refused: 0, failed: 1, "awaiting-input": 0, cancelled: 1, other: 0 }, spentMicros: 2_000_000, unpriced: 1 },
    { project: "billing", count: 11, byOutcome: { completed: 10, refused: 1, failed: 0, "awaiting-input": 0, cancelled: 0, other: 0 }, spentMicros: 4_000_000, unpriced: 1 },
    { project: null, count: 6, byOutcome: { completed: 4, refused: 0, failed: 1, "awaiting-input": 1, cancelled: 0, other: 0 }, spentMicros: 130_000, unpriced: 0 },
  ],
  projectsMore: 0,
  byReason: { "scope-cap": 1, "container-never-started": 1, "recovery-cap": 1, "operator-cancel": 1, "awaiting-input": 1 },
  values: { kind: ["github", "gitlab"], flow: ["fix", "triage"], trigger: ["0", "2", "nightly"], host: ["build3", "mini1"], backend: ["local", "podman"], model: ["claude-sonnet-5-5"], reason: ["awaiting-input", "container-never-started", "operator-cancel", "recovery-cap", "scope-cap"] },
  spentMicros: 6_130_000,
  unpriced: 2,
});

const base = { kind: "github", target: "acme/web#1", host: "mini1", endedAt: "2026-10-08T15:00:00Z", tokens: { total: 5, cost: 0.1 } };

// ---- the sentences ---------------------------------------------------------------------------------------------------

test("the runs page's sentences are pinned, word for word", () => {
  assert.equal(RUNS_UNREADABLE, "The run history could not be read.");
  assert.equal(RUNS_HOST_UNREADABLE, "This host's run history could not be read.");
  assert.equal(RUNS_MIRROR_OFF, "Showing this host's runs: the fleet's run mirror is off.");
  assert.equal(RUNS_MIRROR_DEGRADED, "Other hosts' runs could not be read; showing this host's.");
  assert.equal(runsTruncatedText(2000), "Stopped after examining 2,000 runs; the next page continues from there.");
  assert.equal(RUNS_EMPTY, "No run matches.");
  assert.equal(RUNS_WINDOW_TEXT, "Counts are of the runs that ended in the last 24 hours.");
  assert.equal(runsSourceText({ mirror: "ok", runs: [{ host: "mini1" }, { host: "mini2" }, { host: "build3" }, { host: "mini1" }] }), "read from 3 hosts through the fleet's run mirror");
  assert.equal(runsSourceText({ mirror: "ok", runs: [{ host: "mini1" }] }), "read from 1 host through the fleet's run mirror");
  for (const page of [{ mirror: "off", runs: [{ host: "a" }] }, { mirror: "unreachable: x", runs: [{ host: "a" }] }, { mirror: "ok", runs: [{}] }, { mirror: "ok", runs: [] }, null]) assert.equal(runsSourceText(page), null, JSON.stringify(page));
  assert.equal(NO_REASON_SHORT, shortSentence(NO_REASON_FAILED), "derived, never written twice");
  assert.equal(NO_REASON_SHORT, "No reason was recorded");
});

// ---- the outcome cell ------------------------------------------------------------------------------------------------

test("outcomeCell: a completed run is quiet, a word that says why stands alone, any other outcome carries its reason's short sentence, linked to its runs", () => {
  const cell = (r, opts) => String(outcomeCell({ ...base, ...r }, opts));
  assert.equal(cell({ outcome: "completed" }), String(ui.badge("idle", "Completed", { icon: ui.STATUS.ok.icon })), "a grey badge with its check, nothing more");
  assert.equal(cell({ outcome: "completed", reason: "brand-new" }), cell({ outcome: "completed" }), "a completed run's token says nothing more either");
  assert.equal(cell({ outcome: "completed", reason: "awaiting-input" }), String(ui.outcomeBadge("completed", "awaiting-input")), "awaiting input says it all");
  assert.equal(cell({ outcome: "policy", reason: "operator-cancel" }), String(ui.outcomeBadge("policy", "operator-cancel")), "cancelled says it all");
  const scope = shortSentence(REASONS["scope-cap"].sentence);
  assert.equal(cell({ outcome: "policy", reason: "scope-cap" }), `${ui.outcomeBadge("policy", "scope-cap")}<span class="reason"><a href="/runs?outcome=refused&amp;reason=scope-cap" title="scope-cap">${String(ui.withCode(scope.replace(/`/g, "")))}</a></span>`);
  // A recovery end reads failed, and its link finds it by the word: outcome=failed.
  const cap = cell({ outcome: "policy", reason: "recovery-cap" });
  assert.match(cap, /^<span class="badge tone-failed">.*Failed<\/span><span class="reason"><a href="\/runs\?outcome=failed&amp;reason=recovery-cap" title="recovery-cap">/);
  assert.ok(cap.includes(shortSentence(REASONS["recovery-cap"].sentence)), "the catalog's own sentence, cut");
  // A why variant changes the sentence, as the catalog's variant does.
  const variant = cell({ outcome: "policy", reason: "model-unknown", why: "overlay-link" });
  const shortOf = (why) => shortSentence(explainReason("model-unknown", { why }).sentence).replace(/'/g, "&#39;");
  assert.notEqual(shortOf("overlay-link"), shortOf(null));
  assert.ok(variant.includes(`>${shortOf("overlay-link")}</a>`), variant);
  // A token the catalog does not know: itself, in the code face, with no explanation yet, still linked.
  assert.equal(cell({ outcome: "failed", reason: "brand-new-reason" }), `${ui.outcomeBadge("failed")}<span class="reason"><a href="/runs?outcome=failed&amp;reason=brand-new-reason" title="brand-new-reason"><span class="code">brand-new-reason</span>, ${NO_EXPLANATION}</a></span>`);
  // An outcome this release does not know: itself as a failure, and a link by the reason alone.
  assert.match(cell({ outcome: "vapour", reason: "scope-cap" }), /tone-failed.*vapour<\/span><span class="reason"><a href="\/runs\?reason=scope-cap" title="scope-cap">/);
  // `link: false` draws the sentence as text.
  assert.equal(cell({ outcome: "policy", reason: "scope-cap" }, { link: false }), `${ui.outcomeBadge("policy", "scope-cap")}<span class="reason">${String(ui.withCode(scope.replace(/`/g, "")))}</span>`);
  // Every link it draws is one the runs page takes.
  for (const r of [{ outcome: "policy", reason: "scope-cap" }, { outcome: "policy", reason: "recovery-checkpoint-absent" }, { outcome: "failed", reason: "x".repeat(64) }, { outcome: "vapour", reason: "a" }]) {
    for (const m of cell(r).matchAll(/<a href="([^"]*)"/g)) runsLink(m[1].replace(/&amp;/g, "&"));
  }
});

test("outcomeCell prints a reason only when it is a token: free text, markup and an over-long reason read as no reason, in either outcome (REQ-CONSOLE-SECURITY (l))", () => {
  const hostile = ["infra failure, container exit 1", "GET /repos/acme/secret/issues failed: Bad credentials", "<img src=x onerror=alert(1)>", `LONG${"z".repeat(500)}`, "x".repeat(65), "Scope-cap", "", 7, null];
  for (const reason of hostile) {
    for (const outcome of ["failed", "policy", "vapour"]) {
      const got = String(outcomeCell({ ...base, outcome, reason, failedReason: "FREE-TEXT <b>secret</b>" }));
      assert.ok(got.endsWith(`<span class="reason">${NO_REASON_SHORT}</span>`), `${outcome}/${JSON.stringify(reason)}: ${got}`);
      for (const bad of ["Bad credentials", "infra failure", "img", "zzzz", "FREE-TEXT", "secret", "Scope-cap", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]) assert.ok(!got.includes(bad), `${outcome}/${JSON.stringify(reason)} prints no ${bad}`);
    }
  }
  // A completed run is quiet whatever its reason holds.
  assert.ok(!String(outcomeCell({ ...base, outcome: "completed", reason: "<img src=x>" })).includes("img"));
});

// ---- p-filters -------------------------------------------------------------------------------------------------------

test("the filters: the search pill, the project chips with their counts, a closed list per field and the repository, in the card's order", () => {
  const m = runsFiltersModel(viewOf({ data: { runsWindow: WINDOW } }));
  assert.deepEqual(m.search, { id: "q", name: "q", value: null });
  assert.equal(m.folded, 0);
  assert.deepEqual(m.projects.map((p) => [String(p.label), p.count, p.href, p.on]), [
    ["All", 28, "/runs", true],
    [String(ui.ptag("web")), 11, "/runs?project=web", false],
    [String(ui.ptag("billing")), 11, "/runs?project=billing", false],
  ], "All counts every run of the window; the runs with no project have no chip of their own");
  assert.deepEqual(m.selects.map((s) => [s.label, s.select.name]), [["Outcome", "outcome"], ["Forge", "kind"], ["Reason", "reason"], ["Flow", "flow"], ["Trigger", "trigger"], ["Host", "host"], ["Venue", "backend"], ["Model", "model"]]);
  const opts = Object.fromEntries(m.selects.map((s) => [s.select.name, s.select.options.map((o) => [o.value, o.label])]));
  assert.deepEqual(opts.outcome, [["", "Any"], ...OUTCOME_KEYS.map((k) => [k, OUTCOME_KEY_WORDS[k].word])]);
  assert.deepEqual(opts.kind, [["", "Any"], ...RUN_KINDS.map((k) => [k, k])]);
  assert.deepEqual(opts.reason, [["", "Any"], ...WINDOW.values.reason.map((k) => [k, k])], "the reasons the window offers, bounded as every list is");
  assert.deepEqual(opts.trigger, [["", "Any"], ["0", "row 1"], ["2", "row 3"], ["nightly", "nightly"]], "a position by its row number, its value the index");
  for (const f of ["flow", "host", "backend", "model"]) assert.deepEqual(opts[f], [["", "Any"], ...WINDOW.values[f].map((v) => [v, v])], f);
  for (const s of m.selects) assert.equal(s.select.value, "", `${s.select.name}: Any is chosen`);
  assert.deepEqual(m.repo.input, { id: "rf-repo", name: "repo", value: null, placeholder: "owner/name", autocomplete: "off", spellcheck: false });
  assert.deepEqual([m.hidden, m.applied], [[], []], "no filter: nothing carried, no chip");
  // Every control draws with the kit (their ids are no frame's), and each select shows Any chosen.
  for (const s of m.selects) assert.match(String(ui.field({ label: s.label, id: s.id, control: ui.select(s.select) })), /<option value="" selected>Any<\/option>/);
  assert.match(String(ui.field({ label: m.repo.label, id: m.repo.id, control: ui.input(m.repo.input) })), /<label for="rf-repo">Repository<\/label><input id="rf-repo" class="input" name="repo"/);
  for (const p of m.projects) runsLink(p.href);
});

test("the filters keep the query's values: each select shows its value chosen, one the window does not offer added, and the search keeps its text", () => {
  const qs = "q=gh-2f6a&outcome=policy&host=far-host&trigger=7&model=m9&repo=acme/web&project=ops&problems=1";
  const m = runsFiltersModel(viewOf({ qs, data: { runsWindow: WINDOW } }));
  assert.deepEqual(m.search, { id: "q", name: "q", value: "gh-2f6a" });
  const by = Object.fromEntries(m.selects.map((s) => [s.select.name, s.select]));
  assert.equal(by.outcome.value, "policy");
  assert.deepEqual(by.outcome.options.at(-1), { value: "policy", label: "policy (the record's value)" }, "an old link's record value, named as one");
  assert.deepEqual([by.host.value, by.host.options.at(-1)], ["far-host", { value: "far-host", label: "far-host" }]);
  assert.deepEqual([by.trigger.value, by.trigger.options.at(-1)], ["7", { value: "7", label: "row 8" }]);
  assert.deepEqual([by.model.value, by.model.options.at(-1)], ["m9", { value: "m9", label: "m9" }]);
  assert.equal(by.kind.value, "", "an unset field stays Any");
  assert.equal(m.repo.input.value, "acme/web");
  // The drawn select marks the query's value chosen, and only it.
  const drawn = String(ui.select(by.host));
  assert.equal(drawn.match(/ selected/g).length, 1);
  assert.match(drawn, /<option value="far-host" selected>far-host<\/option>/);
  // A project the window does not count still has its chip, chosen; Apply keeps it and Only problems as hidden fields.
  assert.deepEqual(m.projects.map((p) => [String(p.label), p.on]), [["All", false], [String(ui.ptag("web")), false], [String(ui.ptag("billing")), false], [String(ui.ptag("ops")), true]]);
  assert.deepEqual(m.hidden, [["project", "ops"], ["problems", "1"]]);
  assert.equal(m.folded, 7, "every applied filter but the search folds behind the toggle");
  // A chip keeps the rest of the filter: All drops the project alone.
  assert.deepEqual(runsLink(m.projects[0].href), { repo: "acme/web", trigger: "7", host: "far-host", outcome: "policy", model: "m9", q: "gh-2f6a", problems: "1" });
  assert.deepEqual(runsLink(m.projects[1].href), { ...queryOf(qs).filter, project: "web" });
});

test("the applied filters are chips, each linking to the query without that field (and no page cursor); with none set there is no chip to clear", () => {
  const qs = "project=web&outcome=failed&reason=recovery-cap&trigger=2&kind=github&q=acme&problems=1&before=1760000000000";
  const v = viewOf({ qs, data: { runsWindow: WINDOW } });
  const m = runsFiltersModel(v);
  const f = v.query.filter;
  const set = RUN_FILTER_FIELDS.filter((k) => f[k] !== undefined);
  assert.deepEqual(m.applied.map((c) => c.label), set.map((k) => ({ kind: "Forge", trigger: "Trigger", project: "Project", outcome: "Outcome", reason: "Reason", q: "Search", problems: "Show" })[k]));
  assert.deepEqual(m.applied.map((c) => c.value), ["github", "row 3", "web", "failed", "recovery-cap", "acme", "only problems"], "said as a row says them");
  for (const [i, k] of set.entries()) {
    const { [k]: _dropped, ...rest } = f;
    assert.deepEqual(runsLink(m.applied[i].href), rest, `removing ${k}`);
    assert.ok(!m.applied[i].href.includes("before="), "a changed filter starts at the newest runs");
  }
  assert.deepEqual(runsFiltersModel(viewOf({ data: { runsWindow: WINDOW } })).applied, []);
  // With no window the lists still offer the closed ones and the query's own values.
  const lost = runsFiltersModel(viewOf({ qs: "flow=fix", data: { runsWindow: null } }));
  assert.deepEqual(lost.projects.map((p) => [String(p.label), p.count, p.on]), [["All", null, true]]);
  assert.deepEqual(lost.selects.find((s) => s.select.name === "flow").select.options, [{ value: "", label: "Any" }, { value: "fix", label: "fix" }]);
  assert.equal(lost.selects.find((s) => s.select.name === "kind").select.options.length, RUN_KINDS.length + 1);
});

// ---- p-summary -------------------------------------------------------------------------------------------------------

test("the summary: the five outcome counts of the window, each a link to those runs, the settled spend, Only problems, and what it counts", () => {
  const m = runsSummaryModel(viewOf({ data: { runsWindow: WINDOW } }));
  assert.deepEqual(m.strip.items, [
    { n: 23, label: "completed", status: "ok", href: "/runs?outcome=completed", floor: false, hidePhone: true },
    { n: 1, label: "refused", status: "refused", href: "/runs?outcome=refused", floor: false, hidePhone: false },
    { n: 2, label: "failed", status: "failed", href: "/runs?outcome=failed", floor: false, hidePhone: false },
    { n: 1, label: "awaiting input", status: "parked", href: "/runs?outcome=awaiting-input", floor: false, hidePhone: false },
    { n: 0, label: "awaiting approval", status: "parked", href: "/runs?outcome=awaiting-approval", floor: false, hidePhone: false },
    { n: 1, label: "cancelled", status: "cancelled", href: "/runs?outcome=cancelled", floor: false, hidePhone: false },
  ]);
  for (const it of m.strip.items) runsLink(it.href);
  assert.ok(m.strip.label);
  assert.deepEqual([m.spentMicros, m.unpriced], [6_130_000, 2]);
  assert.deepEqual(m.show, [{ label: "All outcomes", href: "/runs", on: true }, { label: "Only problems", href: "/runs?problems=1", on: false }]);
  assert.equal(m.notes, RUNS_WINDOW_TEXT);
  for (const s of m.show) runsLink(s.href);
  // The drawn switch is the kit's segmented control of two links.
  assert.match(String(ui.seg(m.show, { label: "Show" })), /<a href="\/runs" aria-current="page">All outcomes<\/a><a href="\/runs\?problems=1">Only problems<\/a>/);
});

test("the summary keeps the chosen project in its links and counts that project's runs; a floor and a partial window say at least", () => {
  const web = runsSummaryModel(viewOf({ qs: "project=web&outcome=failed&problems=1", data: { runsWindow: WINDOW } }));
  assert.deepEqual(web.strip.items.map((i) => [i.n, i.href]), [[9, "/runs?project=web&outcome=completed"], [0, "/runs?project=web&outcome=refused"], [1, "/runs?project=web&outcome=failed"], [0, "/runs?project=web&outcome=awaiting-input"], [0, "/runs?project=web&outcome=awaiting-approval"], [1, "/runs?project=web&outcome=cancelled"]], "the project's own counts, so a count is what its link finds");
  assert.deepEqual([web.spentMicros, web.unpriced], [2_000_000, 1], "and that project's spend");
  assert.deepEqual(web.show.map((s) => [s.href, s.on]), [["/runs?project=web&outcome=failed", false], ["/runs?project=web&outcome=failed&problems=1", true]]);
  // A project the window names every project of, and not this one, ran nothing in it.
  const none = runsSummaryModel(viewOf({ qs: "project=ops", data: { runsWindow: WINDOW } }));
  assert.ok(none.strip.items.every((i) => i.n === 0));
  assert.deepEqual([none.spentMicros, none.unpriced, none.notes], [0, 0, RUNS_WINDOW_TEXT]);
  // More projects ran than the window counts one by one: the whole counts, said so.
  const many = runsSummaryModel(viewOf({ qs: "project=ops", data: { runsWindow: { ...WINDOW, projectsMore: 3 } } }));
  assert.deepEqual(many.strip.items.map((i) => i.n), [23, 1, 2, 1, 0, 1]);
  assert.equal(many.spentMicros, WINDOW.spentMicros);
  assert.equal(many.notes, `${RUNS_WINDOW_TEXT} ${RUNS_WINDOW_EVERY_PROJECT}`);
  // A floor: every count says at least; a partial window too, and why.
  assert.ok(runsSummaryModel(viewOf({ data: { runsWindow: { ...WINDOW, floor: true } } })).strip.items.every((i) => i.floor === true));
  const partial = runsSummaryModel(viewOf({ data: { runsWindow: { ...WINDOW, partial: true } } }));
  assert.ok(partial.strip.items.every((i) => i.floor === true));
  assert.equal(partial.notes, `${RUNS_WINDOW_TEXT} ${RUNS_WINDOW_PARTIAL}`);
  // An outcome this release does not know is counted, as a failure, with no link (no filter names it).
  const odd = runsSummaryModel(viewOf({ data: { runsWindow: { ...WINDOW, byOutcome: { ...WINDOW.byOutcome, other: 4 } } } }));
  assert.deepEqual(odd.strip.items.at(-1), { n: 4, label: "outcome not known", status: "failed", href: null, floor: false });
  // An unread window is said, not drawn as zeros; a spend that is no amount is none.
  assert.equal(runsSummaryModel(viewOf({ data: { runsWindow: null } })), null);
  assert.ok(String(runsSummary(viewOf({ data: { runsWindow: null } }))).includes(RUNS_WINDOW_UNREAD));
  assert.equal(runsSummaryModel(viewOf({ data: { runsWindow: { ...WINDOW, spentMicros: null, unpriced: -1 } } })).spentMicros, null);
});

// ---- p-runs ----------------------------------------------------------------------------------------------------------

/** A page of runs as `readRunsPage` answers. */
const pageOf = (runs, extra = {}) => ({ runs, next: null, mirror: "ok", truncated: false, examined: runs.length, ...extra });

test("the runs table: its columns, flow, venue, model, tokens and job cap off a phone, stacked rows naming only the host and the cost", () => {
  const runs = [
    { ...base, jobId: "gh-1", project: "web", flow: "fix", backend: "podman", model: "claude-sonnet-5-5", outcome: "completed", dollars: { reservedMicros: 2_000_000 } },
    { ...base, jobId: "gh-2", project: "Not A Project", outcome: "policy", reason: "scope-cap" },
  ];
  const m = runsTableModel(viewOf({ data: { runsPage: pageOf(runs) } }));
  assert.deepEqual(m.card, { title: "Runs", sub: "newest first", flush: true });
  assert.equal(m.table.stack, true);
  assert.equal(m.table.caption, "Runs");
  const heads = m.table.heads.map((h) => (typeof h === "string" ? [h, false, false] : [h.label, h.num === true, h.hidePhone === true]));
  assert.deepEqual(heads, [["Ended", false, false], ["Job", false, false], ["Target", false, false], ["Flow", false, true], ["Host", false, false], ["Venue", false, true], ["Outcome", false, false], ["Model", false, true], ["Tokens", true, true], ["Cost", true, false], ["Job cap", true, true]]);
  const rows = m.table.rows.filter((r) => r.cells);
  assert.ok(rows.every((r) => r.cells.length === heads.length));
  // Drawn by the kit (its group rows aside): the five columns the phone leaves to the run page are hidden there, head
  // and cells, so a narrower desktop can leave them out too.
  const drawn = String(ui.tbl({ ...m.table, rows }));
  const tds = [...drawn.matchAll(/<td([^>]*)>/g)].map((x) => x[1]);
  assert.equal(tds.length, rows.length * heads.length);
  const hidden = tds.slice(0, heads.length).map((a) => /hide-phone/.test(a));
  assert.deepEqual(hidden, heads.map((h) => h[2]));
  assert.deepEqual([...drawn.matchAll(/<th scope="col"([^>]*)>/g)].map((x) => /hide-phone/.test(x[1])), heads.map((h) => h[2]), "each head marked as its cells are");
  // On a phone the RunsPhone card names only the host and the cost: of the cells it shows, those two alone carry a
  // label; the end time, the job, the target and the outcome stand with none (no data-l at all, so nothing is drawn).
  const shown = tds.slice(0, heads.length).filter((a) => !/hide-phone/.test(a));
  assert.deepEqual(shown.map((a) => / data-l="([^"]*)"/.exec(a)?.[1] ?? null), [null, null, null, "Host", null, "Cost"]);
  assert.ok(!drawn.includes('data-l=""'), "an empty label is never written");
  // When it ended is the UTC time alone, as the card writes it under its day's row (the next test: every run stands under
  // the row naming the UTC day it ended); the whole instant is the element's datetime, which the script shows locally,
  // and data-day tells the script the row names its day, so it stays alone on the reader's day.
  assert.match(drawn, /<td class="when"><time datetime="2026-10-08T15:00:00.000Z" data-day>15:00 UTC<\/time><\/td>/);
  assert.match(drawn, /<td class="id"><span class="code"><a href="\/run\?id=gh-1">gh-1<\/a><\/span><\/td>/);
  // A host, a flow and a model are each a box of their own (`.val`, bounded on a desktop by RUNS_TABLE.valueMaxCh), so
  // a long one breaks inside it; a record naming none reads "-", with no box.
  assert.match(drawn, /<td class="hide-phone" data-l="Flow"><span class="val">fix<\/span><\/td>/);
  assert.match(drawn, /<td data-l="Host"><span class="val">mini1<\/span><\/td>/);
  assert.match(drawn, /<td class="hide-phone" data-l="Model"><span class="val">claude-sonnet-5-5<\/span><\/td>/);
  assert.match(drawn, /<td class="hide-phone" data-l="Flow">-<\/td>.*<td class="hide-phone" data-l="Model">-<\/td>/, "the second run names no flow and no model");
  // A host, flow or model that is the empty string names none either: "-", never an empty box.
  const blank = runsTableModel(viewOf({ data: { runsPage: pageOf([{ ...base, jobId: "gh-3", outcome: "completed", flow: "", host: "", model: "" }]) } })).table.rows.find((r) => r.cells);
  assert.deepEqual(["Flow", "Host", "Model"].map((h) => String(blank.cells[heads.findIndex(([label]) => label === h)])), ["-", "-", "-"]);
  assert.match(drawn, /<td class="wide"><span class="badge tone-idle">/, "the outcome cell spans the row on a phone");
  assert.match(drawn, /<span class="vtag">podman<\/span>/);
  assert.match(drawn, /<span class="vtag">local<\/span>/, "a record naming no venue is a local run");
  assert.match(drawn, /data-l="Job cap"><span title="\$2.00">\$2.00<\/span><\/td>/);
  // The target with its project's tag, a project id only.
  assert.match(drawn, /acme\/web#1<\/a> <span class="ptag">web<\/span><\/td>/);
  assert.ok(!drawn.includes("Not A Project"), "a project that is no id is not tagged");
});

test("the runs are grouped by the UTC day they ended, a group row before each day's first run, whatever the clock", () => {
  const runs = [
    { ...base, jobId: "gh-a", endedAt: "2026-10-08T00:00:00.000Z", outcome: "completed" },
    { ...base, jobId: "gh-b", endedAt: "2026-10-07T23:59:59.999Z", outcome: "completed" },
    { ...base, jobId: "gh-c", endedAt: "2026-10-07T00:00:00.000Z", outcome: "completed" },
    { ...base, jobId: "gh-d", endedAt: null, startedAt: "2026-10-06T12:00:00Z", outcome: "completed" },
    { ...base, jobId: "gh-e", endedAt: null, startedAt: null, outcome: "completed" },
  ];
  const shape = (now) => runsTableModel(viewOf({ now, data: { runsPage: pageOf(runs) } })).table.rows.map((r) => r.group ?? String(r.cells[1].html).replace(/<[^>]+>/g, ""));
  assert.deepEqual(shape(NOW), ["2026-10-08 UTC", "gh-a", "2026-10-07 UTC", "gh-b", "gh-c", "2026-10-06 UTC", "gh-d", RUNS_DAY_UNKNOWN, "gh-e"]);
  assert.deepEqual(shape(Date.UTC(2027, 0, 1)), shape(NOW), "a day is said by its date, never relative to now");
  assert.ok(runsTableModel(viewOf({ data: { runsPage: pageOf(runs) } })).table.rows.filter((r) => r.group).every((r) => Object.keys(r).length === 1), "a group row is { group } alone");
  // Each run's Ended cell is its UTC time alone, the day being its group row's: the row above it names the date its
  // datetime holds. A run with no instant to draw says "unknown", under the undated group.
  const rows = runsTableModel(viewOf({ data: { runsPage: pageOf(runs) } })).table.rows;
  let day = null;
  const ended = [];
  for (const r of rows) {
    if (r.group) { day = r.group; continue; }
    const t = String(r.cells[0].html);
    const at = /^<time datetime="([^"]+)" data-day>(\d{2}:\d{2} UTC)<\/time>$/.exec(t);
    if (at) assert.equal(`${at[1].slice(0, 10)} UTC`, day, `${t} stands under its own day`);
    ended.push(at ? at[2] : t);
  }
  assert.deepEqual(ended, ["00:00 UTC", "23:59 UTC", "00:00 UTC", "12:00 UTC", "unknown"]);
});

test("a run dated past the year 9999 or before 1970 is grouped under the undated words, never a garbled or negative day", () => {
  const groups = (endedAt) => runsTableModel(viewOf({ data: { runsPage: pageOf([{ ...base, jobId: "gh-far", endedAt, outcome: "completed" }]) } })).table.rows.filter((r) => r.group).map((r) => r.group);
  assert.deepEqual(groups("+275760-09-13T00:00:00.000Z"), [RUNS_DAY_UNKNOWN], "the last instant a Date holds, a six-digit year");
  assert.deepEqual(groups("1969-12-31T12:00:00.000Z"), [RUNS_DAY_UNKNOWN], "before the epoch");
  assert.deepEqual(groups("1970-01-01T00:00:00.000Z"), ["1970-01-01 UTC"], "the epoch itself is a day");
});

test("the table's foot says each sentence when its condition holds, and only then; the pager goes newest and older", () => {
  const two = [{ ...base, jobId: "gh-1", host: "mini1", outcome: "completed" }, { ...base, jobId: "gh-2", host: "build3", outcome: "completed" }];
  const foot = (data, qs = "") => runsTableModel(viewOf({ qs, data })).foot;
  assert.deepEqual(foot({ runsPage: null }), [RUNS_UNREADABLE]);
  assert.deepEqual(foot({ runsPage: { refusal: "limit must be a whole number from 1 to 100" } }), ["limit must be a whole number from 1 to 100"]);
  assert.deepEqual(foot({ runsPage: pageOf([]) }), [RUNS_EMPTY]);
  assert.deepEqual(foot({ runsPage: pageOf(two) }), ["2 runs, read from 2 hosts through the fleet's run mirror."]);
  assert.deepEqual(foot({ runsPage: pageOf(two, { mirror: "off" }) }), ["2 runs.", RUNS_MIRROR_OFF]);
  assert.deepEqual(foot({ runsPage: pageOf(two, { mirror: "unreachable: ECONNREFUSED" }) }), ["2 runs.", RUNS_MIRROR_DEGRADED]);
  assert.deepEqual(foot({ runsPage: pageOf([], { mirror: "off", unreachable: "logs dir unreadable (EACCES)" }) }), [RUNS_EMPTY, RUNS_HOST_UNREADABLE, RUNS_MIRROR_OFF]);
  assert.deepEqual(foot({ runsPage: pageOf(two, { truncated: true, examined: 2000, next: 5 }) }), ["2 runs, read from 2 hosts through the fleet's run mirror.", runsTruncatedText(2000)]);
  assert.ok(!foot({ runsPage: pageOf(two) }).some((s) => s.includes("could not") || s.includes("Stopped")), "no warning a page did not earn");
  // The pager: Newest only below the top, Older where the page has a cursor, both keeping the filter.
  const pager = (page, qs = "") => runsTableModel(viewOf({ qs, data: { runsPage: page } })).pager;
  assert.deepEqual(pager(pageOf(two)), { newer: null, older: null, newerLabel: "Newest" });
  assert.deepEqual(pager(pageOf(two, { next: 1760000000000 }), "outcome=failed&before=1760000099999"), { newer: "/runs?outcome=failed", older: "/runs?outcome=failed&before=1760000000000", newerLabel: "Newest" });
  assert.deepEqual(pager(null, "before=5"), { newer: "/runs", older: null, newerLabel: "Newest" }, "an unread page below the top still leads back to it");
  assert.equal(runsTableModel(viewOf({ data: { runsPage: pageOf([]) } })).table, null, "no table with no run");
});

test("the runs list is the same for both roles, and neither is shown a job's failure text or a reason that is no token", () => {
  const runs = [
    { ...base, jobId: "gh-f", outcome: "failed", reason: "GET /repos/acme/secret failed: Bad credentials", failedReason: "FREE-TEXT trace <b>" },
    { ...base, jobId: "gh-p", outcome: "policy", reason: "<img src=x onerror=alert(1)>" },
    { ...base, jobId: "gh-l", outcome: "policy", reason: `LONG${"z".repeat(500)}` },
    { ...base, jobId: "gh-ok", outcome: "failed", reason: "container-never-started" },
    { ...base, jobId: "gh 1<b>&x", outcome: "completed", target: "acme/web#9<script>" },
  ];
  const model = (role) => runsTableModel(viewOf({ role, data: { runsPage: pageOf(runs) } }));
  assert.equal(plain(model("viewer")), plain(model("operator")));
  // As the kit draws it (its group rows aside), where every value is escaped.
  const m = model("viewer");
  const out = `${ui.tbl({ ...m.table, rows: m.table.rows.filter((r) => r.cells) })}${m.foot.join(" ")}`;
  for (const bad of ["Bad credentials", "secret", "FREE-TEXT", "trace", "<img", "onerror", "LONGzz", "<script>", "<b>"]) assert.ok(!out.includes(bad), `no ${bad}`);
  assert.ok(out.includes(shortSentence(REASONS["container-never-started"].sentence).replace(/'/g, "&#39;")), "a token's catalog sentence is shown");
  assert.equal(out.split(NO_REASON_SHORT).length - 1, 3, "each reason that is no token says none was recorded");
  // An id the run page would refuse is text, escaped, never a link.
  assert.ok(out.includes("gh 1&lt;b&gt;&amp;x") && !out.includes("/run?id=gh%201"));
  assert.ok(out.includes("acme/web#9&lt;script&gt;"));
});

test("a run's target links out to its forge when the deployment can build the link, and is text otherwise", () => {
  const run = { ...base, jobId: "gh-1", outcome: "completed" };
  const target = (r, env) => String(runsTableModel(viewOf({ env, data: { runsPage: pageOf([r]) } })).table.rows[1].cells[2].html);
  assert.equal(target(run), String(ui.outLink({ href: "https://github.com/acme/web/issues/1", label: "acme/web#1" })));
  assert.equal(target({ ...run, kind: "gitlab" }, {}), "acme/web#1", "a GitLab run on a deployment with no GITLAB_URL");
  assert.equal(target({ ...run, kind: "gitlab" }, { GITLAB_URL: "https://gitlab.example.com" }), String(ui.outLink({ href: "https://gitlab.example.com/acme/web/-/issues/1", label: "acme/web#1" })));
  assert.equal(target({ ...run, target: null }), "-");
});
