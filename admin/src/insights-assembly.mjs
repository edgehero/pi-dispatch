/**
 * The insights payload's assembly (issues #53/#54/#175/#181, moved out of `index.ts` for the operator console, #641):
 * the reads and folds behind the console's spend screen (`console/panels.mjs` `insightsBody`), in the console, a
 * separate process that never loads pi.
 *
 * Pi-free by contract: nothing this module reaches imports `@earendil-works/pi-coding-agent` or `typebox`
 * (`insights-assembly.test.mjs` walks the import graph). That is why the pricing façade is a parameter and not an
 * import here: `@edgehero/pi-dispatch/pricing` loads `pi-ai`, which loads `typebox`. A caller hands in
 * `{ listPricedModels, getPricedModel, isZeroRated, reprice, piAiVersion }` (`index.ts` builds it from that worker
 * export), the same injectable shape `costs.mjs`'s pure folds take. The deployment's environment is a parameter too
 * (`envFn`): the extension reads it through the deployment pointer, which is its own process state.
 */
import { basename } from "node:path";
import {
  readSchedulers,
  readBudget,
  readSettingsView,
  readTriggers,
  readScopedLimits,
  readScopedBudget,
  readSizeSuggestions,
  hostBudgetsOf,
  readHosts,
  readCapacity,
  readProjects,
  scanRunRecords,
  readSubscriptions,
  GRAPH_LIMITS,
  cronRunStats,
  joinRunsToTriggers,
  attributeRunsToTriggers,
  observedChainEdges,
  collectGraphInputs,
  forgeRepoTargets,
  readEnvelope,
  readAllocations,
  envelopeJobCap,
} from "./read-model.mjs";
import { buildGraphModel } from "./graph-model.mjs";
import { INSIGHTS_SPLIT_REFUSALS } from "./insights-html.mjs";
import { costsSinceMs, foldCosts, foldTriggerCosts, recordInProject, recordInRepo } from "./costs.mjs";
import { sizeBits, outsideEdit, splitTotalMicros } from "./render.mjs";
import { escapeInterpreted } from "./panel.mjs";
import { parseUsdMicros } from "@edgehero/pi-dispatch/money";
import { SUGGEST_WINDOW_DAYS } from "@edgehero/pi-dispatch/size-suggest";
import { coverageNotes, historyNotes, hostCaveats, hostFacts, noRunText, notSharedWhy } from "@edgehero/pi-dispatch/capacity-cli";
// The worker's OWN window classifier (the same one reserveBudget enforces), so the budget states the
// insights payload carries are words the page never derives and the panel and enforcement cannot drift.
import { windowState } from "@edgehero/pi-dispatch/budget";

/** The environment a caller that names none reads: this process's own. */
export function processEnv() {
  return process.env;
}

/** Refuse an assembly without the pricing façade: a fold priced by nothing would draw every cost as unknown. */
function needPricing(pricing) {
  if (pricing === null || typeof pricing !== "object" || typeof pricing.piAiVersion !== "function") {
    throw new TypeError("the insights assembly needs the pricing façade ({ listPricedModels, getPricedModel, isZeroRated, reprice, piAiVersion })");
  }
}

// TEST-ONLY seams for the allocation reads (the insights split here, and the extension's allocation tools and commands,
// which import these two): the Valkey client factory and the clock. Production leaves both unset, so the read-model's
// real defaults (makeRedisClient, the wall clock) apply.
let allocSeams = {};
/** TEST-ONLY: inject the allocation reads' Valkey client factory, clock and key prefix; `{}` restores the defaults. */
export function _setAllocationSeamsForTests(seams) {
  allocSeams = seams ?? {};
}
export function allocRedis() {
  return { ...(allocSeams.redisFn ? { redisFn: allocSeams.redisFn } : {}), ...(allocSeams.prefix ? { prefix: allocSeams.prefix } : {}) };
}
export function allocNow() {
  return allocSeams.now ? allocSeams.now() : new Date();
}

/** Why there is no envelope to work with, in one sentence (the read's own words, escaped). */
export function envelopeProblem(r) {
  if (r.unset) return "PI_ENVELOPE_FILE is unset: there is no envelope, so delegation is off (docs/allocation.md)";
  if (r.missing) return "the envelope file (PI_ENVELOPE_FILE) does not exist";
  if (r.unreadable) return `the envelope file (PI_ENVELOPE_FILE) could not be read (${r.unreadable})`;
  return `the envelope file does not load: ${escapeInterpreted(String(r.invalid ?? "unknown"))}`;
}

/**
 * Assemble the costs fold exactly as the dashboard view does: scan the run records for the window, read
 * the declared subscriptions (a missing/invalid file degrades to none -- the fold then simply has no plans
 * to score), and fold both with the real pricing façade. An optional `flow` filters the fold's INPUT
 * records, so every aggregate -- daily, plans, provenance -- is scoped, not just one table. Returns
 * `{ fold }`, or scanRunRecords' `{ unreachable }` passed through for the caller to surface. `pricing` is the
 * façade (`needPricing`).
 */
export function assembleCosts(paths, window, { flow, repo, project, pricing } = {}) {
  needPricing(pricing);
  const nowMs = Date.now();
  const sinceMs = costsSinceMs(window, nowMs);
  const records = scanRunRecords({ logsDir: paths.logsDir, sinceMs, nowMs });
  if (!Array.isArray(records)) return records; // { unreachable }
  const subs = readSubscriptions({ subscriptionsPath: paths.subscriptionsPath });
  const flowScoped = typeof flow === "string" && flow !== "" ? records.filter((r) => (r?.flow ?? null) === flow) : records;
  // The repo filter applies at the same records level as the flow one, so EVERY fold arm scopes --
  // one table filtered against unscoped siblings would misread as attribution. `recordInRepo` (issue #498): a bare
  // "acme/web" selects that repo on every forge, a qualified "github:acme/web" (the byRepo rollup's key) one forge.
  const repoScoped = typeof repo === "string" && repo !== "" ? flowScoped.filter((r) => recordInRepo(r, repo)) : flowScoped;
  // Issue #499 part C: the project filter at the same records level, by the id each record carries (never re-derived).
  const scoped = typeof project === "string" && project !== "" ? repoScoped.filter((r) => recordInProject(r, project)) : repoScoped;
  // The trigger join over the SCOPED records (a flow-filtered fold attributes only what it folds),
  // the same file-read-plus-pure-fold path the dashboard seam takes.
  const triggersView = readTriggers({ triggersPath: paths.triggersPath });
  const triggerJoin = attributeRunsToTriggers({ records: scoped, triggers: Array.isArray(triggersView?.triggers) ? triggersView.triggers : [] });
  const fold = foldCosts({
    records: scoped,
    subscriptions: Array.isArray(subs?.subscriptions) ? subs.subscriptions : [],
    pricing,
    nowMs,
    piAiPin: pricing.piAiVersion(),
    sinceMs, // the same instant the scan cut at -- proration denominates on the requested window
    triggerJoin,
  });
  return { fold, records: scoped };
}

/**
 * Assemble the trigger/flow graph model for the insights payload: a FRESH triggers read
 * every call (the file live-reloads, OQ-008 -- a cached topology is a stale topology), the resident
 * schedulers, one bounded record scan for the window, the folder/injected enumerations through
 * `collectGraphInputs`, and the pure fold. All I/O lives in the read-model; this function only
 * aggregates its outputs into buildGraphModel's input shape. `pricing` is the façade (`needPricing`).
 */
export async function assembleGraph(paths, { pricing } = {}) {
  needPricing(pricing);
  const nowMs = Date.now();
  const triggers = readTriggers({ triggersPath: paths.triggersPath });
  const triggerList = Array.isArray(triggers?.triggers) ? triggers.triggers : [];
  const schedulers = await readSchedulers({ url: paths.valkeyUrl });
  const records = scanRunRecords({ logsDir: paths.logsDir, sinceMs: nowMs - GRAPH_LIMITS.windowDays * 24 * 60 * 60 * 1000, nowMs });
  const recs = Array.isArray(records) ? records : [];
  // Spend badges (issue #175): the dashboard seam's twin -- one subscriptions read, two pure folds.
  const subsView = readSubscriptions({ subscriptionsPath: paths.subscriptionsPath });
  const triggerJoin = attributeRunsToTriggers({ records: recs, triggers: triggerList });
  return buildGraphModel({
    triggers,
    schedulers: Array.isArray(schedulers) ? schedulers : [],
    ...collectGraphInputs({ triggers: triggerList, globalPiDir: paths.globalPiDir }),
    cronStats: cronRunStats({ records: recs, schedulerIds: triggerList.filter((t) => t.type === "cron" && typeof t.id === "string").map((t) => t.id) }),
    runJoin: joinRunsToTriggers({ records: recs, triggerCount: triggers?.count, triggerTypes: Object.fromEntries(triggerList.map((t) => [t.index, t.type])) }),
    chainEdges: observedChainEdges({ records: recs }),
    forgeRepos: forgeRepoTargets({ records: recs }),
    caps: { chainDepthMax: paths.chainDepthMax, chainMaxPerJob: paths.chainMaxPerJob, windowDays: GRAPH_LIMITS.windowDays },
    nowMs,
    triggerCosts: foldTriggerCosts({ records: recs, subscriptions: Array.isArray(subsView?.subscriptions) ? subsView.subscriptions : [], pricing, triggerJoin }),
  });
}

/** A positive integer or null -- the shape every overlay cap takes on its way into the payload. */
function posIntOrNull(v) {
  return Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * The budget slice of the insights payload (issue #181): reserved-vs-cap FACTS for the three job-slot
 * windows and the daily token counter, with the per-window state computed HERE by the worker's own
 * `windowState` (and the token rule the old dashboard token line used: `>=` cap, `>` the soft-hold
 * floor -- tokens are a running count, not a reservation, so equality is already over). States ride
 * the payload as WORDS the page never derives: the artifact builder cannot load the worker
 * (its import allowlist is the two pure siblings), and duplicating threshold arithmetic behind a
 * parity test would put policy in two places. Caps come from the settings overlay ALONE -- a cap the
 * overlay does not set is null, "unknown", because the worker resolves it from env/defaults this
 * process cannot read authoritatively, and the page must render that as absence, never a guess.
 * `readBudget` is GET-only (CONST-BUDGET-BEFORE-TOKENS: observing the budget spends nothing). Exported with a Valkey
 * client seam (`redisFn`) for its tests, as `assembleAllocationView` is.
 */
export async function assembleBudgetView(paths, { redisFn } = {}) {
  const raw = await readBudget({ url: paths.valkeyUrl, redisFn });
  const view = readSettingsView({ settingsFile: paths.settingsFile });
  const overlay = view && !view.invalid && view.overlay ? view.overlay : {};
  const pct = Number.isInteger(overlay.softHoldPct) ? overlay.softHoldPct : null;
  const unreachable = raw?.unreachable ? String(raw.unreachable) : null;
  const slotWindow = (key, capKey) => {
    const cap = posIntOrNull(overlay[capKey]);
    const reserved = unreachable === null ? Number(raw[key] ?? 0) : null;
    const state = cap !== null && reserved !== null ? windowState(reserved, cap, pct) : "ok";
    return { reserved, cap, state };
  };
  const tokensSpent = unreachable === null ? Number(raw.tokensToday ?? 0) : null;
  const tokenCap = posIntOrNull(overlay.dailyTokenCap);
  const tokenState =
    tokenCap !== null && tokensSpent !== null
      ? tokensSpent >= tokenCap
        ? "over"
        : pct !== null && tokensSpent > Math.floor((tokenCap * pct) / 100)
          ? "soft-hold"
          : "ok"
      : "ok";
  // The scoped rows (issue #242): the configured limits joined to their live counters, states computed
  // ASSEMBLER-side with the worker's own windowState so they ride the payload as words (the insights
  // page's import allowlist forbids the worker import). Concurrency is CONFIG-only here -- per-scope
  // in-flight is worker-process state no redis read can see, and the panel never invents a number.
  const limitsView = readScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath });
  const limits = Array.isArray(limitsView?.limits) ? limitsView.limits : [];
  const scopedCounters = limits.length > 0 ? await readScopedBudget({ url: paths.valkeyUrl, limits, redisFn }) : { rows: [] };
  const scoped = limits.map((l, i) => {
    const used = scopedCounters?.rows?.[i] ?? null;
    const win = (cap, key) => {
      if (cap === null) return null;
      const u = used && Number.isFinite(used[key]) ? used[key] : null;
      return { used: u, cap, state: u !== null ? windowState(u, cap, null) : "ok" };
    };
    // The row's dollar windows (issue #507), from the `usdMicros` the same read already returned: a `model:` row, or a
    // `project:` row with only `weekUsd`, has no job-count window, and the page drew its scope with no number beside
    // it. Integer micro-dollars both ways (the cap through the worker's own parser), so the page formats them exactly.
    const usdWin = (field, key) => {
      let cap = null;
      try {
        cap = typeof l[field] === "string" ? parseUsdMicros(l[field], field) : null;
      } catch {
        cap = null; // the shared parser already refused such a file; a hand-built row is skipped, never guessed
      }
      if (cap === null) return null;
      const u = used?.usdMicros?.[key];
      return { usedMicros: Number.isSafeInteger(u) && u >= 0 ? u : null, capMicros: cap };
    };
    return {
      scope: l.scope,
      day: win(l.day, "day"),
      week: win(l.week, "week"),
      month: win(l.month, "month"),
      concurrent: l.concurrent,
      usd: { day: usdWin("dayUsd", "day"), week: usdWin("weekUsd", "week"), month: usdWin("monthUsd", "month") },
      // A project row's size (issue #596) in the words the panel and `/dispatch budget` use (`sizeBits`): a size-only
      // row has no window, and the page drew its scope with nothing beside it.
      size: sizeBits(l),
    };
  });
  return {
    unreachable,
    softHoldPct: pct,
    day: slotWindow("day", "dailyCap"),
    week: slotWindow("week", "weeklyCap"),
    month: slotWindow("month", "monthlyCap"),
    tokens: { spent: tokensSpent, cap: tokenCap, state: tokenState, maxTokens: posIntOrNull(overlay.maxTokens) },
    scoped,
    scopedInvalid: limitsView?.invalid ? String(limitsView.invalid) : null,
  };
}

/**
 * The run-record refusals that belong to the split (issue #507): the page's own list, so the assembler counts exactly
 * the reasons the page draws. `insights-html.test.mjs` holds it to the worker's constants.
 */
const SPLIT_REFUSALS = INSIGHTS_SPLIT_REFUSALS;

/**
 * The split's counts over the SPEND window (issue #507), from the records the assembler already scanned: governed
 * jobs refused for a reason of the split, by `record.reason`, and what each portfolio run's plan came to, by
 * `record.plan.reason` (an applied plan has none, so it counts as `applied`). Null when the scan could not be read:
 * the page then says "not counted", because a 0 would claim a count nobody made.
 */
export function splitCounts(records) {
  if (!Array.isArray(records)) return null;
  const refusals = Object.fromEntries(SPLIT_REFUSALS.map((r) => [r, 0]));
  const plans = {};
  for (const r of records) {
    if (typeof r?.reason === "string" && SPLIT_REFUSALS.includes(r.reason)) refusals[r.reason] += 1;
    const p = r?.plan;
    if (p !== null && typeof p === "object" && typeof p.outcome === "string") {
      const key = typeof p.reason === "string" && p.reason !== "" ? p.reason : p.outcome;
      plans[key] = (plans[key] ?? 0) + 1;
    }
  }
  return { refusals, plans };
}

/**
 * The budget split slice of the insights payload (issue #507): the envelope, the applied split and its spend, and the
 * newest `alloc:log` outcomes, through the same `readAllocations` the panel's `b` view and `/dispatch priorities` use,
 * read WITHOUT reasons (a plan's reasons are agent text, and the panel's view is the one place they are drawn). Valkey
 * is read only when an envelope is set. Each row is cut to its enum fields here, so no host name and no reason text
 * reaches a file meant to be shared. A problem text has the envelope path cut to its basename for the same reason,
 * unless an operator asked for `?paths=full`, the page's one opt-in for host paths. The cut is made on the parser's RAW
 * text, before `envelopeProblem` escapes it: a path holding a character the escape rewrites would no longer match.
 * `outsideEdit` is the panel's notice, by its rule, over the same 20 rows. Exported for its tests, as `splitCounts` is: the
 * rest of the insights assembly dials the real queue. `envFn` is the deployment's environment (`processEnv`).
 */
export async function assembleAllocationView(paths, counts, { fullPaths = false, envFn = processEnv } = {}) {
  if (!paths.envelopeFile) return { unset: true };
  const read = readEnvelope({ envelopeFile: paths.envelopeFile, projectsPath: paths.projectsFile, scopedLimitsPath: paths.scopedLimitsPath, maxCostMicros: envelopeJobCap({ settingsFile: paths.settingsFile, env: envFn() }) });
  if (!read.envelope) {
    const file = String(paths.envelopeFile);
    const invalid = read.invalid !== undefined && !fullPaths ? String(read.invalid).split(file).join(basename(file)) : read.invalid;
    return { problem: envelopeProblem({ ...read, invalid }) };
  }
  const e = read.envelope;
  const head = { window: e.window, totalMicros: e.totalMicros, floors: { ...e.floors }, delegation: e.delegation?.enabled === true };
  const alloc = await readAllocations({ url: paths.valkeyUrl, envelope: e, projects: read.projects, now: allocNow(), withReasons: false, ...allocRedis() });
  if (alloc?.unreachable) return { ...head, unreachable: String(alloc.unreachable) };
  const st = alloc.state ?? null;
  return {
    ...head,
    // The split's own total beside the split (issue #507, `splitTotalMicros`); the file's rides beside it for the
    // mismatch line, which says this host's file holds another total.
    totalMicros: splitTotalMicros(st, e.totalMicros),
    fileTotalMicros: e.totalMicros,
    stateProblem: alloc.stateProblem ?? null,
    state: st && { planId: st.planId ?? null, writer: st.writer ?? null, appliedAt: st.appliedAt ?? null, validUntil: st.validUntil ?? null, clamped: st.clamped === true, allocations: { ...(st.allocations ?? {}) }, unallocated: st.unallocated ?? null },
    mismatch: st !== null && st.envelopeDigest !== read.digest,
    outsideEdit: outsideEdit(alloc.log, st?.envelopeDigest),
    spend: {
      deployment: alloc.spend?.deployment?.micros ?? null,
      projects: Object.fromEntries(Object.entries(alloc.spend?.projects ?? {}).map(([id, v]) => [id, v?.micros ?? null])),
    },
    log: (Array.isArray(alloc.log) ? alloc.log : []).slice(0, 20).map((h) => ({ at: h.at, writer: h.writer, outcome: h.outcome, reason: h.reason ?? null, planId: h.planId ?? null })),
    counts,
  };
}

/**
 * The insights page's job sizes (issue #596, phase 3): each live host's budget and what its jobs hold now (the registry
 * rows), and per project its size, the peaks its suggestion reads (oldest first) and the suggestion, each raise capped
 * by the hosts' budgets judged per host. The page draws peak against size over the window; ids, integers and fixed
 * words only. `hosts` is `{ unreachable }` when the registry could not be read, and a raise then offers no call.
 * `envFn` is the deployment's environment (`processEnv`).
 */
export async function assembleSizingView(paths, nowMs, { readHostsFn = readHosts, envFn = processEnv } = {}) {
  const read = await readHostsFn({ url: paths.valkeyUrl });
  const rows = Array.isArray(read?.hosts) ? read.hosts : [];
  const hosts = read?.unreachable ? { unreachable: String(read.unreachable) } : { rows: rows.map((h) => ({ name: h?.name, budgetMemMiB: h?.budgetMemMiB, budgetCpuCenti: h?.budgetCpuCenti, usedMemMiB: h?.usedMemMiB, usedCpuCenti: h?.usedCpuCenti })) };
  const sizing = projectSizing(paths, { hostBudgets: read?.unreachable ? null : hostBudgetsOf(rows), nowMs, withSeries: true, envFn });
  return { hosts, ...sizing, windowDays: SUGGEST_WINDOW_DAYS };
}

/**
 * The bucket each insights window splits its capacity chart into (issue #599, phase 4): an hour over 7 days (168 bars),
 * six hours over 30 days or the month so far (at most 124). Finer than `CAPACITY_WINDOWS`' own (the CLI prints no
 * chart), coarse enough that a bar stays wider than a few pixels on the page. The headline numbers do not depend on it.
 */
export const INSIGHTS_CAPACITY_BUCKET_MS = Object.freeze({ "7d": 60 * 60 * 1000, "30d": 6 * 60 * 60 * 1000, mtd: 6 * 60 * 60 * 1000 });

/**
 * One capacity report as the insights page draws it (issue #599, phase 4, REQ-CAPACITY-INSIGHTS): every sentence and
 * headline number in the CLI's own words (capacity-cli `hostFacts`, `hostCaveats`, `historyNotes`, `notSharedWhy`,
 * `coverageLines`), so the page cannot say a number or a caveat differently from `pi-dispatch capacity`; the buckets
 * as the report has them, for the chart. The page only lays this out. Exported for its tests.
 */
export function capacityViewOf(report) {
  const cov = report.coverage ?? {};
  const hosts = (Array.isArray(report.hosts) ? report.hosts : []).map((h) => {
    const base = {
      name: h.name,
      fromMs: h.coverage?.fromMs ?? null,
      truncated: h.coverage?.truncated === true,
      slots: h.capacity?.slots ?? null,
      buckets: (Array.isArray(h.buckets) ? h.buckets : []).map((b) => ({ fromMs: b.fromMs, coveredMs: b.coveredMs, busyMs: b.busyMs, fullMs: b.fullMs, peak: b.peak, avgMilli: b.avgMilli })),
    };
    if (!h.shared) return { ...base, notShared: notSharedWhy(h, cov) };
    if (!(h.coveredMs > 0)) return { ...base, empty: true };
    const f = hostFacts(h);
    const caveats = [...(f.basis ? [`slots: ${f.basis}`] : []), ...hostCaveats(h.coverage)];
    return { ...base, facts: { ...f, projects: [...f.projects] }, caveats, notes: historyNotes(h).join("; ") };
  });
  // The coverage clauses one by one (the CLI joins them into one line), so a long list of hosts whose history is not here
  // can never push out what follows it: the records no host holds, the jobs running now, why a source was not read.
  const coverage = coverageNotes({ ...cov, historyNotShared: Array.isArray(cov.historyNotShared) ? cov.historyNotShared : [] }, { namesShown: INSIGHTS_CAPACITY_NAMES_SHOWN });
  return { window: { ...report.window }, truncated: cov.truncated === true, coverage, hosts, noRun: noRunText(cov, "in this window") };
}

/** How many names the page's coverage lists of the hosts whose history is not here, before "and N more". */
export const INSIGHTS_CAPACITY_NAMES_SHOWN = 5;

/**
 * The insights page's capacity slice (issue #599, phase 4): the report `pi-dispatch capacity` and `dispatch_capacity`
 * compute (`readCapacity`, read-only), over the page's own window (`mtd` from the start of the month, as the spend
 * is) and the page's instant, cut to `capacityViewOf`. `{ unreachable }` when it could not be read; nothing here is
 * ever drawn as idle for that. `env` is the deployment's environment, `envFn()` when not given (`processEnv`).
 */
export async function assembleCapacityView(paths, window, nowMs, { readCapacityFn = readCapacity, envFn = processEnv, env = envFn() } = {}) {
  const bucketMs = INSIGHTS_CAPACITY_BUCKET_MS[window] ?? INSIGHTS_CAPACITY_BUCKET_MS["30d"];
  // The month's very first millisecond: a window of no time, which has nothing to read and is not a failure to read.
  const sinceMs = costsSinceMs(window, nowMs);
  if (sinceMs >= nowMs) return { noTime: true, fromMs: sinceMs };
  try {
    const res = await readCapacityFn({ url: paths.valkeyUrl, env, window, now: () => nowMs, span: { sinceMs: (n) => costsSinceMs(window, n), bucketMs } });
    if (!res?.report) return { unreachable: String(res?.error ?? "no report") };
    // Inside the try: a report this cannot word (a host without its capacity, a coverage that is not an object) is this
    // section's own degraded state, never a failure of the whole page.
    return capacityViewOf(res.report);
  } catch (err) {
    return { unreachable: `the capacity report could not be read (${err?.message ?? err})` };
  }
}

/**
 * Assemble the unified insights payload: the graph model and the cost fold the two existing
 * assemblers already build, plus the per-trigger spend map keyed by graph node id. The spend map is
 * derived from the SPEND window's records (the operator's question), not the graph's fixed record
 * window -- the artifact states both windows, and a badge whose window differed from the table
 * beside it would be the quiet inconsistency this surface exists to kill.
 * The whole payload the console's spend screen draws, for `window` (a `COSTS_WINDOWS` word) at the instant `nowMs`.
 * `pricing` is the façade (`needPricing`), `fullPaths` the page's opt-in for host paths (the split's problem text),
 * `envFn` the deployment's environment (`processEnv`).
 */
export async function assembleInsights(paths, window, { pricing, fullPaths = false, nowMs = Date.now(), envFn = processEnv } = {}) {
  needPricing(pricing);
  const graph = await assembleGraph(paths, { pricing });
  const costs = assembleCosts(paths, window, { pricing });
  // The budget slice rides BOTH return shapes: the caps are the operator's one real lever on cost,
  // and the lever does not depend on the spend scan being readable.
  const budget = await assembleBudgetView(paths);
  if (costs?.unreachable) {
    // The split too, for the budget's reason; its counts are the records', so here they were not made.
    const allocation = await assembleAllocationView(paths, null, { fullPaths, envFn });
    const sizing = await assembleSizingView(paths, nowMs, { envFn });
    const capacity = await assembleCapacityView(paths, window, nowMs, { envFn });
    return { graph, fold: null, costsUnreachable: String(costs.unreachable), window, costByTrigger: null, budget, allocation, sizing, capacity };
  }
  const fold = costs?.fold ?? null;
  // Re-fold the spend map at the requested window so badge and table agree. assembleCosts already
  // scanned; scanning again here costs one directory pass and keeps the two assemblers untouched.
  const sinceMs = costsSinceMs(window, nowMs);
  const records = scanRunRecords({ logsDir: paths.logsDir, sinceMs, nowMs });
  let costByTrigger = null;
  if (Array.isArray(records)) {
    const triggersView = readTriggers({ triggersPath: paths.triggersPath });
    const subsView = readSubscriptions({ subscriptionsPath: paths.subscriptionsPath });
    const triggerJoin = attributeRunsToTriggers({ records, triggers: Array.isArray(triggersView?.triggers) ? triggersView.triggers : [] });
    costByTrigger = foldTriggerCosts({ records, subscriptions: Array.isArray(subsView?.subscriptions) ? subsView.subscriptions : [], pricing, triggerJoin });
  }
  // Issue #499 part C: the projects' ids and display names for the by-project list. The page escapes and isolates a
  // name; members are not carried, the page shows spend by id.
  const pv = readProjects({ projectsPath: paths.projectsFile });
  const projects = Array.isArray(pv?.projects) ? pv.projects.map((x) => ({ id: x.id, name: x.name })) : [];
  const allocation = await assembleAllocationView(paths, splitCounts(records), { fullPaths, envFn });
  const sizing = await assembleSizingView(paths, nowMs, { envFn });
  const capacity = await assembleCapacityView(paths, window, nowMs, { envFn });
  return { graph, fold, costsUnreachable: null, window, costByTrigger, budget, projects, allocation, sizing, capacity };
}

/**
 * The projects' size suggestions (issue #596, phase 3, DES-SIZE-SUGGESTIONS) for the PROJECTS view, the edit preview and
 * the insights page: the worker's own `suggestSize` over this host's run records, read once for every project, each
 * raise capped by the live hosts' budgets judged per host (`hostBudgets`, `hostBudgetsOf`; null where no budget was read,
 * and a raise then offers no call). `projectIds` defaults to every project in the projects file. `{ projects, hosts,
 * skipped }` (`hosts` how many budgets were judged against, null for none read), or `{ unreachable }` when the records
 * or the scoped-limits file cannot be read: a size resolved without the file would be the default, which is not the
 * project's. `envFn` is the deployment's environment (`processEnv`).
 */
export function projectSizing(paths, { hostBudgets = null, projectIds = null, nowMs, withSeries = false, envFn = processEnv }) {
  const sl = readScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath });
  if (sl?.invalid) return { unreachable: "the scoped-limits file does not load" };
  const limits = Array.isArray(sl?.limits) ? sl.limits : [];
  const pv = readProjects({ projectsPath: paths.projectsFile });
  const ids = projectIds ?? (Array.isArray(pv?.projects) ? pv.projects.map((p) => p.id) : []);
  const res = readSizeSuggestions({ logsDir: paths.logsDir, projectIds: ids, limits, env: envFn(), hostBudgets, nowMs, withSeries });
  return res.unreachable ? { unreachable: String(res.unreachable) } : { projects: res.projects, hostBudgetCount: Array.isArray(hostBudgets) ? hostBudgets.length : null, skipped: res.skipped };
}
