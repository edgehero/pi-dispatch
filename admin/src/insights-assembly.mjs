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
  readDollarWindows,
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
import { readGraphTriggers } from "./graph-triggers.mjs";
import { INSIGHTS_SPLIT_REFUSALS } from "./insights-html.mjs";
import { costsSinceMs, foldCosts, foldTriggerCosts, recordInProject, recordInRepo, matchesGlob, meteredRunMicros, repoKeyOf, projectKeyOf, refusedBeforeSpend } from "./costs.mjs";
import { sizeBits, outsideEdit, splitTotalMicros } from "./render.mjs";
import { escapeInterpreted } from "./panel.mjs";
import { meteredMicros } from "@edgehero/pi-dispatch/dollar-budget";
import { parseUsdMicros } from "@edgehero/pi-dispatch/money";
import { SUGGEST_WINDOW_DAYS } from "@edgehero/pi-dispatch/size-suggest";
import { coverageNotes, historyNotes, hostCaveats, hostFacts, noRunText, notSharedWhy } from "@edgehero/pi-dispatch/capacity-cli";
// The worker's OWN window classifier (the same one reserveBudget enforces), so the budget states the
// insights payload carries are words the page never derives and the panel and enforcement cannot drift.
import { parseHostBackends } from "@edgehero/pi-dispatch/backends";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "@edgehero/pi-dispatch/config";
import { parseLiveJobs, parseJobsMore } from "@edgehero/pi-dispatch/live-jobs";
import { deploymentDollarCaps } from "./dollar-windows.mjs";
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
export function assembleCosts(paths, window, { flow, repo, project, pricing, nowMs = Date.now() } = {}) {
  needPricing(pricing);
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
  const projectScoped = typeof project === "string" && project !== "" ? repoScoped.filter((r) => recordInProject(r, project)) : repoScoped;
  const scoped = projectScoped.filter((r) => Date.parse(r?.endedAt ?? r?.startedAt ?? "") <= nowMs);
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
export async function assembleGraph(paths, { pricing, project, fullPaths = false, nowMs = Date.now(), readSchedulersFn = readSchedulers } = {}) {
  needPricing(pricing);
  const triggers = readGraphTriggers({ triggersPath: paths.triggersPath, fullPaths });
  if (triggers.missing || triggers.invalid) return buildGraphModel({ triggers, nowMs });
  const triggerList = Array.isArray(triggers?.triggers) ? triggers.triggers : [];
  const schedulers = await readSchedulersFn({ url: paths.valkeyUrl });
  const records = scanRunRecords({ logsDir: paths.logsDir, sinceMs: nowMs - GRAPH_LIMITS.windowDays * 24 * 60 * 60 * 1000, nowMs });
  const recs = Array.isArray(records) ? records.filter((r) => !project || recordInProject(r, project)) : [];
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
 * `windowState` (tokens have no soft hold: equality with their cap is already over). States ride
 * the payload as WORDS the page never derives: the artifact builder cannot load the worker
 * (its import allowlist is the two pure siblings), and duplicating threshold arithmetic behind a
 * parity test would put policy in two places. Caps come from the settings overlay ALONE -- a cap the
 * overlay does not set is null unless the console passes its deployment environment; then the worker
 * precedence applies. The static export keeps its former overlay-only contract.
 * `readBudget` is GET-only (CONST-BUDGET-BEFORE-TOKENS: observing the budget spends nothing). Exported with a Valkey
 * client seam (`redisFn`) for its tests, as `assembleAllocationView` is.
 */
export async function assembleBudgetView(paths, { redisFn, env, nowMs = Date.now() } = {}) {
  const raw = await readBudget({ url: paths.valkeyUrl, redisFn, now: new Date(nowMs) });
  const view = readSettingsView({ settingsFile: paths.settingsFile });
  const overlay = view && !view.invalid && view.overlay ? { ...view.overlay } : {};
  if (env) {
    const keys = { dailyCap: "PI_DAILY_CAP", weeklyCap: "PI_WEEKLY_CAP", monthlyCap: "PI_MONTHLY_CAP", dailyTokenCap: "PI_DAILY_TOKEN_CAP", maxTokens: "PI_MAX_TOKENS", softHoldPct: "PI_SOFT_HOLD_PCT" };
    for (const [key, variable] of Object.entries(keys)) if (overlay[key] === undefined && /^\d+$/.test(env[variable] ?? "")) overlay[key] = Number(env[variable]);
  }
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
        : "ok"
      : "ok";
  // The scoped rows (issue #242): the configured limits joined to their live counters, states computed
  // ASSEMBLER-side with the worker's own windowState so they ride the payload as words (the insights
  // page's import allowlist forbids the worker import). Concurrency is CONFIG-only here -- per-scope
  // in-flight is worker-process state no redis read can see, and the panel never invents a number.
  const limitsView = readScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath });
  const limits = Array.isArray(limitsView?.limits) ? limitsView.limits : [];
  const scopedCounters = limits.length > 0 ? await readScopedBudget({ url: paths.valkeyUrl, limits, redisFn, now: new Date(nowMs) }) : { rows: [] };
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
    ...(env ? { dollars: await readDollarWindows({ paths, env, now: new Date(nowMs), redisFn }), settingsInvalid: Boolean(view?.invalid), settings: overlay } : {}),
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
export async function assembleAllocationView(paths, counts, { fullPaths = false, envFn = processEnv, consoleView = false, role = "viewer", nowMs } = {}) {
  if (!paths.envelopeFile) return { unset: true };
  const read = readEnvelope({ envelopeFile: paths.envelopeFile, projectsPath: paths.projectsFile, scopedLimitsPath: paths.scopedLimitsPath, maxCostMicros: envelopeJobCap({ settingsFile: paths.settingsFile, env: envFn() }) });
  if (!read.envelope) {
    const file = String(paths.envelopeFile);
    const invalid = read.invalid !== undefined && !fullPaths ? String(read.invalid).split(file).join(basename(file)) : read.invalid;
    return { problem: envelopeProblem({ ...read, invalid }) };
  }
  const e = read.envelope;
  const head = { window: e.window, totalMicros: e.totalMicros, floors: { ...e.floors }, delegation: e.delegation?.enabled === true, ...(consoleView ? { envelope: e, digest: read.digest, file: fullPaths && role === "operator" ? paths.envelopeFile : basename(paths.envelopeFile) } : {}) };
  const alloc = await readAllocations({ url: paths.valkeyUrl, envelope: e, projects: read.projects, now: nowMs === undefined ? allocNow() : new Date(nowMs), withReasons: consoleView && role === "operator", ...allocRedis() });
  if (alloc?.unreachable) return { ...head, unreachable: String(alloc.unreachable) };
  const st = alloc.state ?? null;
  return {
    ...head,
    // The split's own total beside the split (issue #507, `splitTotalMicros`); the file's rides beside it for the
    // mismatch line, which says this host's file holds another total.
    totalMicros: splitTotalMicros(st, e.totalMicros),
    fileTotalMicros: e.totalMicros,
    stateProblem: alloc.stateProblem ?? null,
    state: st && { ...(consoleView ? { weights: { ...(st.weights ?? {}) }, jobId: st.jobId ?? null, triggerId: st.triggerId ?? null, ...(role === "operator" ? { reasons: { ...(st.reasons ?? {}) } } : {}) } : {}), planId: st.planId ?? null, writer: st.writer ?? null, appliedAt: st.appliedAt ?? null, validUntil: st.validUntil ?? null, clamped: st.clamped === true, allocations: { ...(st.allocations ?? {}) }, unallocated: st.unallocated ?? null },
    mismatch: st !== null && st.envelopeDigest !== read.digest,
    outsideEdit: outsideEdit(alloc.log, st?.envelopeDigest),
    spend: {
      deployment: alloc.spend?.deployment?.micros ?? null,
      projects: Object.fromEntries(Object.entries(alloc.spend?.projects ?? {}).map(([id, v]) => [id, v?.micros ?? null])),
    },
    log: (Array.isArray(alloc.log) ? alloc.log : []).slice(0, 20).map((h) => ({ at: h.at, writer: h.writer, outcome: h.outcome, reason: h.reason ?? null, planId: h.planId ?? null, ...(consoleView ? { host: h.host ?? null, weights: h.weights ?? null, jobId: h.jobId ?? null, triggerId: h.triggerId ?? null } : {}) })),
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
export const INSIGHTS_CAPACITY_BUCKET_MS = Object.freeze({ "24h": 60 * 60 * 1000, "7d": 60 * 60 * 1000, "30d": 6 * 60 * 60 * 1000, mtd: 6 * 60 * 60 * 1000 });

/**
 * One capacity report as the insights page draws it (issue #599, phase 4, REQ-CAPACITY-INSIGHTS): every sentence and
 * headline number in the CLI's own words (capacity-cli `hostFacts`, `hostCaveats`, `historyNotes`, `notSharedWhy`,
 * `coverageLines`), so the page cannot say a number or a caveat differently from `pi-dispatch capacity`; the buckets
 * as the report has them, for the chart. The page only lays this out. Exported for its tests.
 */
export function capacityViewOf(report, { consoleDetails = false } = {}) {
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
  // The static export keeps the historical words-only coverage shape. The console needs explicit zero counts too:
  // coverageNotes intentionally omits most zero clauses, which cannot tell a card "0 retried" from "not read".
  const coverageCounts = consoleDetails ? Object.fromEntries(["used", "refusedBeforeSlot", "retried", "withoutSize", "withoutResources", "live", "liveNotCounted", "liveUnreadable", "running", "unreadable", "withoutHost", "earlier", "earlierDropped", "orphans", "legacyOccupied", "legacyRefused", "stalledRepick", "capacityOutOfRange", "cpuClamped"].map((key) => [key, Number.isSafeInteger(cov[key]) && cov[key] >= 0 ? cov[key] : null])) : null;
  return { ...(report.fleet ? { fleet: report.fleet } : {}), ...(consoleDetails ? { coverageCounts: { source: ["mirror", "mirror+local", "local", "records"].includes(cov.source) ? cov.source : null, ...coverageCounts }, hostCount: hosts.length } : {}), window: { ...report.window }, truncated: cov.truncated === true, coverage, hosts, noRun: noRunText(cov, "in this window") };
}

/** How many names the page's coverage lists of the hosts whose history is not here, before "and N more". */
export const INSIGHTS_CAPACITY_NAMES_SHOWN = 5;

/**
 * The insights page's capacity slice (issue #599, phase 4): the report `pi-dispatch capacity` and `dispatch_capacity`
 * compute (`readCapacity`, read-only), over the page's own window (`mtd` from the start of the month, as the spend
 * is) and the page's instant, cut to `capacityViewOf`. `{ unreachable }` when it could not be read; nothing here is
 * ever drawn as idle for that. `env` is the deployment's environment, `envFn()` when not given (`processEnv`).
 */
export async function assembleCapacityView(paths, window, nowMs, { readCapacityFn = readCapacity, envFn = processEnv, env = envFn(), consoleDetails = false } = {}) {
  const bucketMs = INSIGHTS_CAPACITY_BUCKET_MS[window] ?? INSIGHTS_CAPACITY_BUCKET_MS["30d"];
  // The month's very first millisecond: a window of no time, which has nothing to read and is not a failure to read.
  const sinceMs = costsSinceMs(window, nowMs);
  if (sinceMs >= nowMs) return { noTime: true, fromMs: sinceMs };
  try {
    const res = await readCapacityFn({ url: paths.valkeyUrl, env, window, now: () => nowMs, span: { sinceMs: (n) => costsSinceMs(window, n), bucketMs } });
    if (!res?.report) return { unreachable: String(res?.error ?? "no report") };
    // Inside the try: a report this cannot word (a host without its capacity, a coverage that is not an object) is this
    // section's own degraded state, never a failure of the whole page.
    return capacityViewOf(res.report, { consoleDetails });
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

const INSIGHTS_DAY_MS = 24 * 60 * 60 * 1000;
const safeAmount = (n) => Number.isSafeInteger(n) && n >= 0;
const recordInstant = (r) => Date.parse(r?.endedAt ?? r?.startedAt ?? "");
const inProject = (records, project) => records.filter((r) => !project || recordInProject(r, project));

/** A live row can omit money because it predates the field, not because every job reserved zero. */
export function heldMoneyOf(hosts, { nowMs, project = null } = {}) {
  const day = Math.floor(nowMs / INSIGHTS_DAY_MS);
  let heldMicros = 0;
  let heldJobs = 0;
  const unknownHosts = [];
  for (const host of Array.isArray(hosts) ? hosts : []) {
    const parsed = parseLiveJobs(host.jobs);
    const more = parseJobsMore(host.jobsMore);
    let unknown = parsed.jobs === null || parsed.dropped > 0 || more === null || more > 0;
    const seen = new Set();
    for (const job of parsed.jobs ?? []) {
      if (project && job.p !== project) continue;
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      if (!safeAmount(job.h) || !safeAmount(job.ha)) {
        unknown = true;
        continue;
      }
      if (Math.floor(job.ha / INSIGHTS_DAY_MS) !== day) continue;
      heldMicros += job.h;
      if (job.h > 0) heldJobs++;
    }
    if (unknown) unknownHosts.push(host.name);
  }
  return { heldMicros: safeAmount(heldMicros) ? heldMicros : null, heldJobs, unknownHosts };
}

/**
 * Enforcement settlement is not a history price: without a dollar reservation the worker writes unreserved/0 even
 * when a paid run reports money. Keep genuine settlements (including refunds and floors), otherwise use recorded
 * prices. Plans retain their recorded API equivalent; old zero-price plan rows need a declared counterfactual.
 */
export function recordSpendOf(record, { subscriptions = [], pricing } = {}) {
  const dollars = record?.dollars;
  if (safeAmount(dollars?.settledMicros) && dollars.basis !== "unreserved") return { micros: dollars.settledMicros, ledgerMicros: dollars.settledMicros, floor: dollars.basis === "floor", estimated: false, unknown: false };
  const ledgerMicros = dollars?.basis === "unreserved" ? 0 : null;
  if (refusedBeforeSpend(record)) return { micros: 0, ledgerMicros: ledgerMicros ?? 0, floor: false, estimated: false, unknown: false };
  const toMicros = meteredMicros;
  const usage = record?.usage;
  const rows = Array.isArray(usage?.models) && usage.models.length > 0 ? usage.models : null;
  let estimated = record?.tokens?.metered !== true;
  let missing = false;
  let planUnknown = false;
  let repricedPlan = false;
  let knownRows = 0;
  let rowMicros = 0;
  for (const row of rows ?? []) {
    let cost = toMicros(row?.cost);
    const plan = subscriptions.find((sub) => !sub.hypothetical && sub.provider === row?.provider && sub.models?.some((glob) => matchesGlob(row?.model, glob)));
    if (plan && cost === 0) {
      const priced = plan.counterfactualModel && pricing?.reprice?.({ input: row.input ?? 0, output: row.output ?? 0, cacheRead: row.cacheRead ?? 0, cacheWrite: row.cacheWrite ?? 0, cacheWrite1h: row.cacheWrite1h ?? 0 }, plan.counterfactualModel);
      cost = toMicros(priced?.usd);
      if (cost !== null) { estimated = true; repricedPlan = true; }
      else planUnknown = true;
    }
    if (cost === null) missing = true;
    else { knownRows++; rowMicros += cost; }
  }
  const recordedMicros = toMicros(record?.tokens?.cost);
  let micros = repricedPlan || planUnknown ? knownRows > 0 ? rowMicros : null : recordedMicros ?? (knownRows > 0 ? rowMicros : null);
  // Before ledgers, a plan's flat zero is no API baseline either. Its cache split cannot be reconstructed to reprice it.
  if (!rows && recordedMicros === 0 && subscriptions.some((sub) => !sub.hypothetical && sub.provider === record?.provider && sub.models?.some((glob) => matchesGlob(record?.model, glob)))) { micros = null; missing = true; }
  if (micros === null || !safeAmount(micros)) return { micros: null, ledgerMicros, floor: true, estimated, unknown: true };
  const facade = pricing ?? { getPricedModel: () => null, isZeroRated: () => false, piAiVersion: () => null };
  const at = recordInstant(record);
  const cost = foldCosts({ records: [record], subscriptions: [], pricing: facade, nowMs: Number.isFinite(at) ? at : 0 }).provenance.total;
  return { micros, ledgerMicros, floor: cost.floor === true || missing || usage?.truncated > 0, estimated, unknown: missing };
}

function spendAccumulator(readable) {
  return { settledMicros: readable ? 0 : null, ledgerMicros: readable ? 0 : null, settledFloor: !readable, settledEstimated: false, unpriced: 0, known: 0, records: 0 };
}
function addRecordSpend(sum, record, opts) {
  const amount = recordSpendOf(record, opts);
  sum.records++;
  if (amount.micros === null) sum.unpriced++;
  else { sum.settledMicros += amount.micros; sum.known++; if (amount.unknown) sum.unpriced++; }
  sum.settledFloor ||= amount.floor;
  sum.settledEstimated ||= amount.estimated;
  if (amount.ledgerMicros === null) sum.ledgerMicros = null;
  else if (sum.ledgerMicros !== null) sum.ledgerMicros += amount.ledgerMicros;
}
function finishSpend(sum) {
  if (sum.records > 0 && sum.known === 0 || !safeAmount(sum.settledMicros)) sum.settledMicros = null;
  if (!safeAmount(sum.ledgerMicros)) sum.ledgerMicros = null;
  delete sum.known;
  delete sum.records;
  return sum;
}

/** The named windows stay independent of the chart filter: today's counter is always today's counter. */
export function spendSummaryOf({ records, hosts, budget, project = null, nowMs, jobCapMicros = null, subscriptions = [], pricing }) {
  const rows = budget?.dollars?.windows ?? [];
  const scoped = project ? rows.filter((r) => r.ledger === "scope" && r.name === `project:${project}`) : [];
  const deployment = rows.filter((r) => r.ledger === "deployment");
  const window = (kind) => {
    const own = scoped.find((r) => r.window === kind);
    const row = own ?? deployment.find((r) => r.window === kind);
    return { usedMicros: row?.counterMicros ?? null, capMicros: row?.capMicros ?? null, basis: own ? `project:${project}` : "deployment", projectFallback: Boolean(project && !own) };
  };
  const all = Array.isArray(records) ? records : [];
  const dayStart = Math.floor(nowMs / INSIGHTS_DAY_MS) * INSIGHTS_DAY_MS;
  const settled = spendAccumulator(Array.isArray(records));
  for (const r of all) if (recordInstant(r) >= dayStart && recordInstant(r) <= nowMs) addRecordSpend(settled, r, { subscriptions, pricing });
  finishSpend(settled);
  const held = heldMoneyOf(hosts, { nowMs, project: scoped.some((r) => r.window === "day") ? project : null });
  const today = window("day");
  const counterConfigured = rows.some((r) => r.window === "day" && (r.ledger === "deployment" || r.ledger === "scope" && r.name === `project:${project}`));
  const remainder = today.usedMicros !== null && held.heldMicros !== null && settled.ledgerMicros !== null ? today.usedMicros - settled.ledgerMicros - held.heldMicros : null;
  if (!counterConfigured) today.usedMicros = settled.settledMicros !== null && held.heldMicros !== null && safeAmount(settled.settledMicros + held.heldMicros) ? settled.settledMicros + held.heldMicros : null;
  const micros = all.filter((r) => recordInstant(r) >= nowMs - INSIGHTS_DAY_MS && recordInstant(r) <= nowMs).map((r) => meteredRunMicros(r, { subscriptions, ...(pricing ? { pricing } : {}) })).filter((n) => n !== null);
  return {
    basis: scoped.length > 0 ? `project:${project}` : "deployment",
    projectFallback: Boolean(project && scoped.length === 0),
    week: window("week"),
    today: { ...today, ...settled, counterConfigured, counterAvailable: counterConfigured && today.usedMicros !== null, usedSource: counterConfigured ? today.usedMicros !== null ? "counter" : "unknown-counter" : "records", usedFloor: !counterConfigured && (settled.settledFloor || held.unknownHosts.length > 0), usedEstimated: !counterConfigured && settled.settledEstimated, ...held, unattributedMicros: remainder, reconciliationMismatch: remainder !== null && remainder < 0 },
    tokens: { used: budget?.tokens?.spent ?? null, cap: budget?.tokens?.cap ?? null },
    average: { costMicros: micros.length > 0 ? Number((micros.reduce((sum, n) => sum + BigInt(n), 0n) + BigInt(Math.floor(micros.length / 2))) / BigInt(micros.length)) : null, runs: micros.length, largestMicros: micros.length > 0 ? Math.max(...micros) : null },
    jobCapMicros,
  };
}

/**
 * Console-only assemblies (#749). Each route reads its own slices, so an unavailable capacity report cannot spoil
 * Breakdown and an operator's plan text is never even read for a viewer. The old static export stays unchanged.
 * `reads` injects the I/O boundaries for tests; every fallback names its failed slice instead of inventing zero.
 */
export async function assembleInsightsView(paths, window, { view = "spend", project = null, role = "viewer", fullPaths = false, pricing, nowMs = Date.now(), envFn = processEnv, reads = {} } = {}) {
  needPricing(pricing);
  const io = { costs: assembleCosts, graph: assembleGraph, budget: assembleBudgetView, allocation: assembleAllocationView, capacity: assembleCapacityView, sizing: assembleSizingView, hosts: readHosts, projects: readProjects, scan: scanRunRecords, subscriptions: readSubscriptions, settings: readSettingsView, ...reads };
  const opts = { pricing, project, nowMs, envFn, fullPaths: role === "operator" && fullPaths };
  const out = { window, view, project, nowMs };
  if (view === "capacity") {
    out.capacity = await io.capacity(paths, window, nowMs, { envFn, consoleDetails: true });
    const registry = await io.hosts({ url: paths.valkeyUrl, now: () => nowMs });
    const live = Array.isArray(registry?.hosts) ? registry.hosts : null;
    const byName = new Map((live ?? []).map((row) => [row.name, row]));
    const reportHosts = Array.isArray(out.capacity?.hosts) ? out.capacity.hosts : [];
    for (const host of reportHosts) {
      const row = byName.get(host.name);
      const backends = registry?.unreachable ? null : parseHostBackends(row?.backends);
      host.venues = backends ? [...backends.blessed] : null;
      host.defaultVenue = backends?.default ?? null;
    }
    out.capacity.venuesUnreadable = Boolean(registry?.unreachable) || live === null;
    // Slot context is a current registry fact, not a sum of separately timed recorded capacities.
    const slots = reportHosts.map((host) => Number(byName.get(host.name)?.concurrency));
    out.capacity.totalSlots = !out.capacity.venuesUnreadable && slots.length > 0 && slots.every((n) => Number.isSafeInteger(n) && n > 0) && Number.isSafeInteger(slots.reduce((sum, n) => sum + n, 0)) ? slots.reduce((sum, n) => sum + n, 0) : null;
    return out;
  }
  const pv = io.projects({ projectsPath: paths.projectsFile });
  out.projects = Array.isArray(pv?.projects) ? pv.projects.map(({ id, name }) => ({ id, name })) : [];
  const projectsError = pv?.invalid ?? pv?.unreachable;
  if (projectsError) out.projectsUnreadable = true;
  const loadCosts = () => {
    const costs = io.costs(paths, window, opts);
    out.fold = costs?.fold ?? null;
    out.costsUnreachable = costs?.unreachable ? String(costs.unreachable) : null;
    return costs;
  };
  if (view === "budget-split") {
    out.allocation = await io.allocation(paths, null, { consoleView: true, role, fullPaths: role === "operator" && fullPaths, envFn, nowMs });
    const hosts = await io.hosts({ url: paths.valkeyUrl, now: () => nowMs });
    out.hosts = Array.isArray(hosts?.hosts) ? hosts.hosts : [];
    if (hosts?.unreachable) out.hostsUnreadable = true;
    const sinceMs = costsSinceMs(out.allocation.window === "day" ? "24h" : out.allocation.window === "week" ? "week" : "mtd", nowMs);
    const start = out.allocation.window === "day" ? Math.floor(nowMs / INSIGHTS_DAY_MS) * INSIGHTS_DAY_MS : sinceMs;
    const records = io.scan({ logsDir: paths.logsDir, sinceMs: start, nowMs });
    out.allocation.counts = splitCounts(records);
    const writer = Array.isArray(records) && records.find((r) => r.jobId === out.allocation.state?.jobId);
    if (writer && out.allocation.state) Object.assign(out.allocation.state, { provider: writer.provider ?? null, model: writer.model ?? null });
    out.allocation.hosts = out.hosts.map((h) => ({ name: h.name, fpEnvelope: h.fpEnvelope ?? null }));
    return out;
  }
  const costs = loadCosts();
  if (view === "flows") {
    out.graph = await io.graph(paths, opts);
    const records = costs?.records;
    if (Array.isArray(records)) {
      const triggers = readTriggers({ triggersPath: paths.triggersPath });
      const subs = io.subscriptions({ subscriptionsPath: paths.subscriptionsPath });
      const join = attributeRunsToTriggers({ records, triggers: triggers?.triggers ?? [] });
      out.costByTrigger = foldTriggerCosts({ records, subscriptions: subs?.subscriptions ?? [], pricing, triggerJoin: join });
    } else out.costByTrigger = null;
    return out;
  }
  if (view === "breakdown") {
    const groups = new Map();
    for (const record of costs?.records ?? []) {
      const key = repoKeyOf(record) ?? "(no target)";
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(projectKeyOf(record));
    }
    out.repoProjects = Object.fromEntries([...groups].map(([key, ids]) => [key, [...ids].sort((a, b) => String(a).localeCompare(String(b)))]));
    return out;
  }
  const env = envFn();
  const subs = io.subscriptions({ subscriptionsPath: paths.subscriptionsPath });
  const subscriptions = subs?.subscriptions ?? [];
  out.budget = await io.budget(paths, { env, nowMs });
  const hosts = await io.hosts({ url: paths.valkeyUrl, now: () => nowMs });
  out.hosts = Array.isArray(hosts?.hosts) ? hosts.hosts : [];
  if (hosts?.unreachable) out.hostsUnreadable = true;
  const settings = io.settings({ settingsFile: paths.settingsFile });
  const overlay = settings?.overlay ?? {};
  const { jobCapMicros } = deploymentDollarCaps(overlay, env);
  out.settings = { ...overlay, provider: overlay.provider ?? env.PI_PROVIDER ?? DEFAULT_PROVIDER, model: overlay.model ?? env.PI_MODEL ?? DEFAULT_MODEL, maxCostMicros: jobCapMicros };
  const scanned = io.scan({ logsDir: paths.logsDir, sinceMs: Math.min(costsSinceMs("week", nowMs), nowMs - INSIGHTS_DAY_MS), nowMs });
  // A selected project's charts can coexist with deployment caps. For that fallback the KPI records must also be
  // deployment-wide; otherwise settled and held would describe different populations beside the same counter.
  const hasProjectWindow = project && (out.budget?.dollars?.windows ?? []).some((r) => r.ledger === "scope" && r.name === `project:${project}` && r.window === "day");
  const all = Array.isArray(scanned) ? inProject(scanned, hasProjectWindow ? project : null) : null;
  out.spend = spendSummaryOf({ records: all, hosts: out.hosts, budget: out.budget, project, nowMs, jobCapMicros, subscriptions, pricing });
  if (hosts?.unreachable) {
    out.spend.today.heldMicros = null;
    out.spend.today.unattributedMicros = null;
    out.spend.today.reconciliationMismatch = false;
    out.spend.today.hostsUnreadable = true;
  }
  const recent = Array.isArray(scanned) ? inProject(scanned.filter((r) => recordInstant(r) >= nowMs - INSIGHTS_DAY_MS && recordInstant(r) <= nowMs), project) : [];
  out.recent24h = Array.isArray(scanned) ? foldCosts({ records: recent, subscriptions: subs?.subscriptions ?? [], pricing, nowMs, piAiPin: pricing.piAiVersion(), sinceMs: nowMs - INSIGHTS_DAY_MS }) : null;
  // The chart follows the project filter even when the headline falls back to deployment windows.
  const chartHeld = hosts?.unreachable ? null : heldMoneyOf(out.hosts, { nowMs, project }).heldMicros;
  Object.assign(out.spend, spendChartsOf({ records: costs?.records, sinceMs: costsSinceMs(window, nowMs), nowMs, jobCapMicros, subscriptions, pricing, heldMicros: chartHeld }));
  const choices = new Map();
  const choice = (provider, model) => {
    if (typeof provider !== "string" || typeof model !== "string") return;
    const id = `${provider}/${model}`;
    const plan = subscriptions.find((sub) => !sub.hypothetical && sub.provider === provider && sub.models?.some((m) => matchesGlob(model, m)));
    choices.set(id, { id, label: `${id}${provider === out.settings.provider && model === out.settings.model ? " (current)" : ""}${plan ? " (plan)" : ""}` });
  };
  choice(out.settings.provider, out.settings.model);
  const triggerView = readTriggers({ triggersPath: paths.triggersPath });
  for (const t of triggerView?.triggers ?? []) choice(t.provider ?? out.settings.provider, t.model ?? out.settings.model);
  for (const r of Array.isArray(scanned) ? scanned : []) {
    choice(r.provider, r.model);
    for (const row of r.usage?.models ?? []) choice(row.provider, row.model);
  }
  for (const sub of subscriptions) {
    for (const model of sub.models ?? []) if (!model.includes("*")) choice(sub.provider, model);
    if (sub.hypothetical) continue;
    const candidate = (pricing.listPricedModels?.() ?? []).find((m) => m.provider === sub.provider && sub.models?.some((glob) => matchesGlob(m.id, glob)));
    if (candidate) choice(candidate.provider, candidate.id);
  }
  out.modelChoices = [...choices.values()].slice(0, 4000);
  out.triggersByModel = {};
  for (const r of recent) {
    const key = `${r.provider}/${r.model}`;
    const trigger = Number.isInteger(r.triggerIndex) ? `row ${r.triggerIndex + 1}` : r.triggerId ?? null;
    if (trigger && !(out.triggersByModel[key] ?? []).includes(trigger)) (out.triggersByModel[key] ??= []).push(trigger);
  }
  out.allocation = await io.allocation(paths, null, { consoleView: true, role: "viewer", fullPaths: role === "operator" && fullPaths, envFn, nowMs });
  const writer = Array.isArray(scanned) && scanned.find((r) => r.jobId === out.allocation.state?.jobId);
  if (writer && out.allocation.state) Object.assign(out.allocation.state, { provider: writer.provider ?? null, model: writer.model ?? null });
  return out;
}

/** Daily settled charges and equal cost bins retain their own source, rather than borrowing fold-time plan prices. */
export function spendChartsOf({ records, sinceMs, nowMs, jobCapMicros, subscriptions = [], pricing, heldMicros = null }) {
  const days = new Map();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  for (let at = Math.floor(sinceMs / INSIGHTS_DAY_MS) * INSIGHTS_DAY_MS; at <= nowMs; at += INSIGHTS_DAY_MS) {
    const date = new Date(at).toISOString().slice(0, 10);
    days.set(date, { date, ...spendAccumulator(Array.isArray(records)), heldMicros: date === today ? heldMicros : 0, today: date === today });
  }
  const costs = [];
  for (const r of Array.isArray(records) ? records : []) {
    const at = recordInstant(r);
    if (!(at >= sinceMs && at <= nowMs)) continue;
    const day = days.get(new Date(at).toISOString().slice(0, 10));
    if (day) addRecordSpend(day, r, { subscriptions, pricing });
    const cost = meteredRunMicros(r, { subscriptions, ...(pricing ? { pricing } : {}) });
    if (cost !== null) costs.push(cost);
  }
  const histogram = safeAmount(jobCapMicros) && jobCapMicros > 0 ? Array.from({ length: 10 }, (_, i) => ({ fromMicros: i * jobCapMicros / 10, toMicros: (i + 1) * jobCapMicros / 10, runs: 0 })) : [];
  for (const cost of costs) if (histogram.length) histogram[Math.min(histogram.length - 1, Math.floor(cost * histogram.length / jobCapMicros))].runs++;
  for (const day of days.values()) finishSpend(day);
  return { daily: [...days.values()], histogram, largestRangeMicros: costs.length ? Math.max(...costs) : null, meteredRangeRuns: costs.length, overJobCapRuns: safeAmount(jobCapMicros) ? costs.filter((n) => n > jobCapMicros).length : null };
}
