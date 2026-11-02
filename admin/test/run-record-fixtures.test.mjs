// Every admin reader of run records against the record each release's `buildRecord` made (issue #761): the fixtures in
// `worker/test/fixtures/run-records/` (one shape per release that changed the builder, listed in `manifest.json`, and a
// record of a version no release has written yet, `synthetic-v2.json`). Each shape is copied into a logs directory of
// its own, every file dated by its record's `endedAt`, and every instant below is read from the fixtures, never the wall
// clock. Lists, pages and tools read every record back with its id, outcome, kind and times; folds read every released
// shape and leave the newer record out, saying how many; the run page and the API show the newer one's core alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { RECORD_CORE_FIELDS, sanitizeJobId } from "@edgehero/pi-dispatch/run-history";
import { readZeroTouch } from "@edgehero/pi-dispatch/zero-touch";
import { NEWER_RECORD_MODEL_NOTE, NEWER_RECORD_SENTENCE, listRuns, makeLocalRunIndex, readRun, readRunById, readRunsPage, scanRunRecords, modelRunRecord } from "../src/read-model.mjs";
import { fromNewerRelease, readableRecords, shownRecord } from "../src/newer-release.mjs";
import { foldCosts, whatIfFlow } from "../src/costs.mjs";
import { DOLLAR_KEY_PREFIX } from "@edgehero/pi-dispatch/dollar-budget";
import { dayKey } from "@edgehero/pi-dispatch/budget";
import { foldWindowRecords, runDollars } from "../src/dollar-windows.mjs";
import { safeRunOf } from "../src/console/run-api.mjs";
import { renderPage } from "../src/console/pages.mjs";
import { rerunRefusalOf } from "../src/job-actions.mjs";
import { whatIfAnswer } from "../src/console/whatif.mjs";
import { spendWhatif } from "../src/console/panels/spend.mjs";
import { triggerListOf } from "../src/trigger-list.mjs";
import { spendChartsOf, spendSummaryOf, splitCounts } from "../src/insights-assembly.mjs";
import { readProjectView } from "../src/project-view.mjs";
import { modelsViewOf } from "../src/models-view.mjs";

const FIXTURES = fileURLToPath(new URL("../../worker/test/fixtures/run-records/", import.meta.url));
const { RUN_RECORD_CASES } = await import(new URL("../../worker/test/fixtures/run-records/cases.mjs", import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const manifest = readJson("manifest.json");
const SYNTHETIC = readJson("synthetic-v2.json");
const HOUR = 60 * 60 * 1000;
const NEWER_SAID = "1 record from a newer pi-dispatch not read";
const OPERATOR = Object.freeze({ id: "s-run-record-fixtures", name: "ops", role: "operator" });

/** The newer record as every admin read hands it out: its stable core and `v`, nothing else. */
const CORE = Object.fromEntries([...RECORD_CORE_FIELDS, "v"].filter((k) => Object.hasOwn(SYNTHETIC, k)).map((k) => [k, SYNTHETIC[k]]));

/**
 * A logs directory holding one shape's five records and the synthetic newer one, each under its sanitized id and dated
 * by its own `endedAt`, with the window around them (an hour before the first start to an hour after the last end).
 */
function deployment(shape) {
  const logsDir = tempDir("admin-run-record-fixtures-");
  const records = RUN_RECORD_CASES.map((name) => readJson(`${shape.id}.${name}.json`));
  for (const [file, record] of [...RUN_RECORD_CASES.map((name, i) => [`${shape.id}.${name}.json`, records[i]]), ["synthetic-v2.json", SYNTHETIC]]) {
    const path = join(logsDir, `${sanitizeJobId(record.jobId)}.json`);
    copyFileSync(join(FIXTURES, file), path);
    const at = Date.parse(record.endedAt) / 1000;
    utimesSync(path, at, at);
  }
  const all = [...records, SYNTHETIC];
  const sinceMs = Math.min(...all.map((r) => Date.parse(r.startedAt))) - HOUR;
  const nowMs = Math.max(...all.map((r) => Date.parse(r.endedAt))) + HOUR;
  return { logsDir, records, sinceMs, nowMs };
}

/** A pricing facade that prices every model at $1 per million input tokens, so a what-if has an answer to give. */
const PRICING = Object.freeze({
  getPricedModel: () => ({}),
  isZeroRated: () => false,
  reprice: (quad) => ({ usd: (quad.input ?? 0) / 1e6, ratesVersion: "fixture" }),
  piAiVersion: () => null,
  listPricedModels: () => [],
});

const byId = (records) => Object.fromEntries(records.map((r) => [r.jobId, r]));
const settledOf = (records) => records.reduce((sum, r) => sum + (Number.isSafeInteger(r.dollars?.settledMicros) ? r.dollars.settledMicros : 0), 0);

test("every list, page and by-id read hands back every released record whole, and the newer one as its core alone (#761)", async () => {
  for (const shape of manifest.shapes) {
    const { logsDir, records, sinceMs, nowMs } = deployment(shape);
    const want = { ...byId(records), [SYNTHETIC.jobId]: CORE };
    for (const [name, got] of [
      ["listRuns", listRuns({ logsDir, limit: 50 })],
      ["scanRunRecords", scanRunRecords({ logsDir, sinceMs, nowMs })],
      ["makeLocalRunIndex", makeLocalRunIndex({ logsDir, now: () => nowMs }).records().records],
      ["readRunsPage", (await readRunsPage(null, { logsDir, now: () => nowMs, limit: 50 })).runs],
    ]) {
      assert.equal(got.length, 6, `${shape.id} ${name}`);
      assert.deepEqual(byId(got), want, `${shape.id} ${name}: every record read back, the newer one cut to its core`);
    }
    for (const record of [...records, SYNTHETIC]) {
      const at = `${shape.id} ${record.jobId}`;
      assert.deepEqual(readRun({ logsDir, jobId: record.jobId }), want[record.jobId], at);
      assert.deepEqual(await readRunById(null, { logsDir, jobId: record.jobId }), { record: want[record.jobId], source: "local" }, at);
    }
    // The page's own facts for the newer one: its id, outcome, kind and times, from the fixture.
    assert.deepEqual([CORE.jobId, CORE.outcome, CORE.kind, CORE.startedAt, CORE.endedAt, CORE.v], [SYNTHETIC.jobId, "completed", "github", "2026-09-14T15:00:00.000Z", "2026-09-14T15:20:00.000Z", 2]);
  }
});

test("the cost and dollar-window folds read every released shape, count the newer record out and say so (#761)", () => {
  for (const shape of manifest.shapes) {
    const { logsDir, records, sinceMs, nowMs } = deployment(shape);
    const scanned = scanRunRecords({ logsDir, sinceMs, nowMs });
    const fold = foldCosts({ records: scanned, subscriptions: [], pricing: PRICING, nowMs, sinceMs });
    assert.equal(fold.provenance.runsTotal, records.length, `${shape.id}: every released record is folded`);
    assert.equal(fold.newerSkipped, 1, `${shape.id}: the newer one is counted out`);
    assert.deepEqual(fold.byFlow.map((r) => r.flow).sort(), [...new Set(records.map((r) => r.flow ?? "(no flow)"))].sort(), shape.id);
    // The day window of the runs' start: every released record that carries dollars settles into it, to the micro-dollar.
    const spec = { ledger: "deployment", name: null, window: "day", capMicros: 10_000_000, keyPrefix: DOLLAR_KEY_PREFIX, key: dayKey(new Date(Date.parse(records[0].startedAt)), DOLLAR_KEY_PREFIX) };
    const window = foldWindowRecords(scanned, spec);
    const withDollars = records.filter((r) => r.dollars && typeof r.dollars === "object");
    assert.equal(window.records.runs, withDollars.length, shape.id);
    assert.equal(window.records.settledMicros, settledOf(withDollars), shape.id);
    assert.equal(window.records.newerSkipped, 1, `${shape.id}: the newer record's 7.5 dollars are not in the window's sum`);
    const runs = runDollars(scanned);
    assert.deepEqual(runs.runs.map((r) => [r.jobId, r.dollars.settledMicros]).sort(), withDollars.map((r) => [r.jobId, r.dollars.settledMicros ?? null]).sort(), shape.id);
    assert.equal(runs.newerSkipped, 1, shape.id);
  }
});

test("the next shape's dollars are the cases' own: 0.4125, 0.061, 0.15 and 1.86 dollars settled, 2.4835 in the day (#761)", () => {
  const next = manifest.shapes.at(-1);
  const { logsDir, sinceMs, nowMs } = deployment(next);
  const scanned = scanRunRecords({ logsDir, sinceMs, nowMs });
  const spec = { ledger: "deployment", name: null, window: "day", capMicros: 10_000_000, keyPrefix: DOLLAR_KEY_PREFIX, key: dayKey(new Date(Date.parse("2026-09-14T10:00:00.000Z")), DOLLAR_KEY_PREFIX) };
  // The failed run settled at its floor; the refusal before any spend carries `dollars: null` and is no window run.
  assert.deepEqual(foldWindowRecords(scanned, spec).records, { runs: 4, settledMicros: 2_483_500, basis: { metered: 3, floor: 1, refunded: 0, unreserved: 0 }, boundExceeded: 0, malformed: 0, newerSkipped: 1 });
  // A project row counts the newer record only when its core says the project: `api` does, `web` does not.
  const api = foldWindowRecords(scanned, { ...spec, ledger: "scope", name: "project:api" });
  const web = foldWindowRecords(scanned, { ...spec, ledger: "scope", name: "project:web" });
  assert.deepEqual([api.records.runs, api.records.settledMicros, api.records.newerSkipped], [2, 2_010_000, 1]);
  assert.deepEqual([web.records.runs, web.records.settledMicros, web.records.newerSkipped], [1, 412_500, undefined]);
});

test("the run API, the model's run read and the re-run check read the newer record's core alone and say so once (#761)", () => {
  for (const shape of manifest.shapes) {
    const { records, nowMs } = deployment(shape);
    for (const record of records) {
      const api = safeRunOf(record.jobId, record);
      const at = `${shape.id} ${record.jobId}`;
      assert.deepEqual([api.jobId, api.outcome, api.kind, api.startedAt, api.finishedAt, api.newer], [record.jobId, record.outcome, record.kind, record.startedAt, record.endedAt, undefined], at);
      assert.notEqual(rerunRefusalOf(record, nowMs), rerunRefusalOf(SYNTHETIC, nowMs), at);
    }
  }
  for (const given of [SYNTHETIC, CORE]) {
    const api = safeRunOf(SYNTHETIC.jobId, given);
    assert.deepEqual([api.jobId, api.outcome, api.kind, api.host, api.project, api.attempt, api.startedAt, api.finishedAt], [SYNTHETIC.jobId, "completed", "github", "mini-3", "api", 2, SYNTHETIC.startedAt, SYNTHETIC.endedAt]);
    assert.deepEqual([api.target, api.flow, api.repo, api.newer, api.note], [null, null, null, true, NEWER_RECORD_SENTENCE], "nothing past the core, and the sentence");
    assert.deepEqual(modelRunRecord(given), { ...CORE, newer: true, note: NEWER_RECORD_MODEL_NOTE });
    assert.equal(rerunRefusalOf(given, Date.parse(SYNTHETIC.endedAt)), `${SYNTHETIC.jobId} was recorded by a newer pi-dispatch, whose run this console cannot rebuild, so it cannot be re-run from here; re-run it from a console of that release`);
  }
});

test("the run page of a newer record shows its outcome, times and core with the one sentence, and no panel past the core (#761)", async () => {
  const nowMs = Date.parse(SYNTHETIC.endedAt) + HOUR;
  const data = (record) => ({ now: nowMs, env: {}, run: { record, source: "local" }, chat: { state: "finished", mode: "none", jobState: "completed" }, transcript: { exists: false }, children: [], childrenSearched: 50 });
  const page = String((await renderPage("run", { query: { id: SYNTHETIC.jobId }, session: OPERATOR, data: data(CORE) })).html);
  assert.equal(page.split(NEWER_RECORD_SENTENCE).length - 1, 1, "the sentence, once");
  for (const fact of [SYNTHETIC.jobId, "mini-3", "Completed: finished in 20m on mini-3"]) assert.ok(page.includes(fact), fact);
  for (const absent of ["Tokens and dollars", "Resources", "Session and plan", "Sandbox:", "Preview a re-run", "acme/api#120", "Live transcript"]) assert.ok(!page.includes(absent), `no ${absent}`);
  // A released record keeps its whole page.
  const next = readJson(`${manifest.shapes.at(-1).id}.forge-completed.json`);
  const full = String((await renderPage("run", { query: { id: next.jobId }, session: OPERATOR, data: { ...data(next), now: Date.parse(next.endedAt) + HOUR } })).html);
  assert.ok(full.includes("Tokens and dollars") && !full.includes(NEWER_RECORD_SENTENCE));
});

test("the what-if, insights, project, models and zero-touch folds leave the newer record out and say so (#761)", async () => {
  const shape = manifest.shapes.at(-1);
  const { logsDir, records, sinceMs, nowMs } = deployment(shape);
  const scanned = scanRunRecords({ logsDir, sinceMs, nowMs });
  // What-if: the fix flow's ledgered runs are the released ones only.
  const fixRuns = records.filter((r) => r.flow === "fix");
  const whatif = whatIfAnswer({ model: "anthropic/claude-sonnet-4-5", flow: "fix", pricing: PRICING, records: scanned, nowMs, range: "7d" });
  assert.equal(whatif.result.newerSkipped, 1);
  assert.equal(whatif.result.windowRuns, fixRuns.length);
  const runSet = whatIfAnswer({ model: "anthropic/claude-sonnet-4-5", pricing: PRICING, records: scanned, nowMs, runs: "week" }).runSet;
  assert.equal(runSet.newerSkipped, 1);
  // Insights: the split's counts, the spend summary and the daily charts.
  assert.equal(splitCounts(scanned).newerSkipped, 1);
  const summary = spendSummaryOf({ records: scanned, hosts: [], budget: null, nowMs, pricing: PRICING });
  assert.equal(summary.newerSkipped, 1);
  const charts = spendChartsOf({ records: scanned, sinceMs, nowMs, jobCapMicros: 10_000_000, pricing: PRICING });
  assert.equal(charts.daily.reduce((n, d) => n + (d.settledMicros ?? 0), 0) > 0, true);
  // The project page: the api project's newer run is counted out and makes the history read as incomplete.
  const dir = tempDir("admin-run-record-project-");
  const projectsFile = join(dir, "projects.json");
  writeFileSync(projectsFile, JSON.stringify({ version: 1, projects: [{ id: "api", members: ["github:acme/api"] }, { id: "web", members: ["github:acme/web"] }] }));
  const view = await readProjectView({ id: "api", paths: { projectsFile, logsDir }, now: nowMs, pricing: PRICING, reads: { fleetRuns: async () => ({ runs: [], incomplete: false }) } });
  assert.equal(view.state, "ready", JSON.stringify(view));
  assert.equal(view.newerSkipped, 1);
  assert.equal(view.historyIncomplete, true);
  assert.deepEqual(view.recent.map((r) => r.jobId).sort(), records.filter((r) => r.project === "api").map((r) => r.jobId).sort());
  // Models: comparisons and fallback history over the released records, and a note for the newer one.
  const models = modelsViewOf({ records: scanned, now: nowMs });
  assert.equal(models.coverage.records, records.length);
  assert.ok(models.coverage.notes.includes(`${NEWER_SAID}: comparisons and fallback history leave them out.`), models.coverage.notes.join("\n"));
  // Zero touch reads through the worker's capacity reader, which leaves the newer record out and names it.
  const zero = await readZeroTouch({ redis: null, logsDir, now: () => nowMs, windowDays: 7, includeRecords: true });
  assert.deepEqual(zero.records.map((r) => r.jobId).sort(), records.map((r) => r.jobId).sort());
  assert.ok(zero.coverage.reasons.some((r) => String(r).includes(NEWER_SAID)), JSON.stringify(zero.coverage.reasons));
});

test("the newer record's sentence names every core field the run card shows, by kind, and the model is told the field names (#761)", async () => {
  // Each core field in the sentence's words; both times are "times". A field added to the core fails here first.
  const WORDS = { jobId: "id", attempt: "attempt", outcome: "outcome", startedAt: "times", endedAt: "times", host: "host", kind: "kind", project: "project" };
  assert.deepEqual(Object.keys(WORDS).sort(), [...RECORD_CORE_FIELDS].sort());
  for (const word of new Set(Object.values(WORDS))) assert.match(NEWER_RECORD_SENTENCE, new RegExp(`\\b${word}\\b`), word);
  // The run card draws a row for each, and labels the kind by what it is: a forge's name, or a kind that is no forge.
  const nowMs = Date.parse(SYNTHETIC.endedAt) + HOUR;
  const data = (record) => ({ now: nowMs, env: {}, run: { record, source: "local" }, chat: { state: "finished", mode: "none", jobState: "completed" }, transcript: { exists: false }, children: [], childrenSearched: 50 });
  const page = async (record) => String((await renderPage("run", { query: { id: record.jobId }, session: OPERATOR, data: data(record) })).html);
  const forge = await page(CORE);
  for (const row of ["Job", "Attempt", "Outcome", "Started", "Ended", "Host", "Project"]) assert.ok(forge.includes(`<dt>${row}</dt>`), row);
  assert.ok(forge.includes("<dt>Forge</dt><dd>github</dd>"), "a forge's kind under Forge");
  const local = await page({ ...CORE, jobId: "local-0d1e2f", kind: "local" });
  assert.ok(local.includes("<dt>Kind</dt><dd>local</dd>") && !local.includes("<dt>Forge</dt>"), "a local run is never labelled a forge");
  // A model reads no page: its note names the fields it is given, from the core itself, and speaks of no console.
  for (const field of RECORD_CORE_FIELDS) assert.ok(NEWER_RECORD_MODEL_NOTE.includes(field), field);
  assert.doesNotMatch(NEWER_RECORD_MODEL_NOTE, /console|shown/);
});

test("a v no release writes reads as a newer record: cut to its core and left out of every fold, never read whole (#761)", () => {
  const record = (over) => ({ jobId: "gh-1", kind: "github", outcome: "completed", startedAt: SYNTHETIC.startedAt, endedAt: SYNTHETIC.endedAt, flow: "fix", dollars: { settledMicros: 7 }, ...over });
  for (const v of [0, -1, 1.5, "1", "2", "x", null, true, {}, 2]) {
    const r = record({ v });
    assert.equal(fromNewerRelease(r), true, JSON.stringify(v));
    assert.deepEqual(shownRecord(r), { jobId: "gh-1", kind: "github", outcome: "completed", startedAt: SYNTHETIC.startedAt, endedAt: SYNTHETIC.endedAt, v }, `${JSON.stringify(v)}: the core and v alone`);
    assert.deepEqual(readableRecords([r]), { records: [], newerSkipped: 1 }, JSON.stringify(v));
  }
  // A missing `v` (every record before it existed), an undefined one and this build's own version are read whole.
  for (const r of [record({}), record({ v: undefined }), record({ v: 1 })]) {
    assert.equal(fromNewerRelease(r), false);
    assert.equal(shownRecord(r), r);
    assert.deepEqual(readableRecords([r]), { records: [r], newerSkipped: 0 });
  }
  // Not a record at all is no newer record: each fold keeps its own rule for it.
  for (const value of [null, undefined, 7, "x", []]) assert.equal(fromNewerRelease(value), false, JSON.stringify(value));
});

test("each fold left whole a newer record reaches leaves it out and says so: what-if, trigger list, repo row and split (#761)", () => {
  // The record as a fold would meet it if a read forgot to cut it: whole, past its core, matching every filter below.
  const NEWER = { ...SYNTHETIC, flow: "fix", reason: "allocation-cap", plan: { outcome: "refused", reason: "over-cap" }, triggerIndex: 0, triggerType: "label", usage: { models: [{ provider: "anthropic", model: "x", input: 9_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 9 }] } };
  const released = readJson(`${manifest.shapes.at(-1).id}.forge-completed.json`);
  const nowMs = Date.parse(NEWER.endedAt) + HOUR;
  const target = { provider: "anthropic", id: "claude-sonnet-4-5" };
  // What-if: the newer run is no member of its flow (its usage would price at 9 dollars), and the answer counts it.
  const alone = whatIfFlow({ records: [NEWER], flow: "fix", target, pricing: PRICING });
  assert.deepEqual([alone.class, alone.newerSkipped], ["seeded", 1], JSON.stringify(alone));
  const both = whatIfFlow({ records: [NEWER, released], flow: released.flow, target, pricing: PRICING });
  assert.equal(both.newerSkipped, 1);
  assert.equal(both.usd, whatIfFlow({ records: [released], flow: released.flow, target, pricing: PRICING }).usd, "the same estimate as without it");
  // ... and the console's what-if says so beside the answer, for a flow and for a run set alike.
  const said = "1 record from a newer pi-dispatch not read: the totals leave them out.";
  for (const flow of ["fix", undefined]) {
    const whatIf = whatIfAnswer({ model: "anthropic/claude-sonnet-4-5", flow, pricing: PRICING, records: [NEWER, released], nowMs, range: "7d", runs: "week" });
    const markup = String(spendWhatif({ page: "insights", role: "operator", now: nowMs, query: { range: "7d", whatif: "anthropic/claude-sonnet-4-5", ...(flow ? { flow } : { runs: "week" }) }, data: { whatIf, insights: {} } }));
    assert.equal(markup.split(said).length - 1, 1, `${flow ?? "run set"}: ${markup}`);
  }
  // The trigger list: the newer run is not the label trigger's although its fields say so, and the problems say why.
  const snapshot = { triggers: { triggers: [{ index: 0, type: "label", forge: "github", flow: "fix" }], count: 1 }, pauseWindows: { windows: [] } };
  const list = triggerListOf({ snapshot, records: [NEWER], coverage: { complete: true }, now: nowMs, pricing: PRICING });
  assert.ok(list.problems.includes(`${NEWER_SAID}: counts and spend leave them out.`), list.problems.join("\n"));
  assert.deepEqual([list.rows[0].stats.runs30d, list.rows[0].lastRun], [0, null]);
  // A repo row: a newer FORGE run of the window may be the repo's and is counted out; a newer LOCAL run never is.
  const spec = { ledger: "scope", name: "acme/api", window: "day", capMicros: 10_000_000, keyPrefix: DOLLAR_KEY_PREFIX, key: dayKey(new Date(Date.parse(NEWER.startedAt)), DOLLAR_KEY_PREFIX) };
  assert.equal(foldWindowRecords([NEWER], spec).records.newerSkipped, 1);
  assert.deepEqual(foldWindowRecords([{ ...NEWER, kind: "local" }], spec).records, { runs: 0, settledMicros: 0, basis: { metered: 0, floor: 0, refunded: 0, unreserved: 0 }, boundExceeded: 0, malformed: 0 });
  // The split's counts: its reason and plan are not counted, only how many were left out.
  assert.deepEqual(splitCounts([NEWER]), { refusals: { "allocation-cap": 0, "envelope-mismatch": 0, "portfolio-no-envelope": 0, "portfolio-snapshot-oversize": 0 }, plans: {}, newerSkipped: 1 });
});
