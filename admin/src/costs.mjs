/**
 * The pure cost fold (issue #53): where FACTS meet OPINIONS.
 *
 * The run records are immutable facts -- what ran, what the meter counted, what the stream-time rate
 * tables priced it at. The subscriptions file and the pricing facade are opinions -- what the operator
 * says a plan costs, what a rate table says a token is worth, which counterfactual model a covered run
 * should be compared against. This module folds the two AT READ TIME and stores nothing: classification
 * is never persisted, so editing subscriptions.json retroactively reclassifies history -- correctly. An
 * operator fixing a wrong declaration should fix every view of the past, not just the future.
 *
 * Pure by contract: no filesystem, no redis, no clock of its own (`nowMs` is an argument), and the
 * pricing facade (worker/src/pricing.mjs) arrives as an injected `pricing` argument, never a
 * module-scope worker import -- the view layer wires the real one, the tests inject a canned fake. The
 * single permitted worker coupling is budget's `dayKey`: the fold's daily buckets and the worker's
 * spend windows must agree on where a UTC day boundary falls, and sharing the one function is how the
 * two sides cannot drift.
 *
 * Every dollar this module emits is a TYPED value `{ usd, class, floor, coverage?, planId? }` -- never
 * a bare number. The class system makes a mislabeled estimate structurally impossible: a renderer
 * cannot print a dollar without also holding what KIND of dollar it is, and the panel's fmtCost is the
 * only renderer.
 */

import { dayKey } from "@edgehero/pi-dispatch/budget";

/** Every class a typed dollar can carry. Note what is NOT here: "free". A $0 is always "zero-rated"
 * (a rate table said zero) or "plan" (prepaid) -- the fold has no way to assert that anything is free. */
export const COST_CLASSES = ["metered", "plan", "zero-rated", "estimated", "seeded", "unknown"];

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The spend windows every costs surface offers, in `t`-cycle order. */
export const COSTS_WINDOWS = ["7d", "30d", "mtd"];

/**
 * A window's inclusive start: 7d/30d count back from now; mtd is the start of the current UTC month.
 * This lives HERE, beside the fold, because proration denominates on the requested window: the scan
 * cutoff and the fold's `sinceMs` must be the same instant, and two implementations of "where does
 * mtd start" (the drift this module's dayKey import already guards against at day grain) once let the
 * command and the view disagree by a whole month edge.
 */
export function costsSinceMs(windowKey, nowMs) {
  if (windowKey === "7d") return nowMs - 7 * DAY_MS;
  if (windowKey === "30d") return nowMs - 30 * DAY_MS;
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/** The ledger row fields that form a reprice quad -- the full cache split, exactly as recorded. */
const QUAD_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"];

/** The worker's own UTC day bucket (budget.mjs `dayKey`) with the redis namespace stripped to a bare
 * `YYYY-MM-DD`. Deriving the date here instead would be the drift this import exists to prevent. */
function utcDay(ms) {
  return dayKey(new Date(ms), "day").slice("day:".length);
}

/** Construct a typed dollar -- the only shape a number leaves this module in. */
function typed(usd, cls, { floor = false, coverage, planId } = {}) {
  const value = { usd, class: cls, floor };
  if (coverage !== undefined) value.coverage = coverage;
  if (planId !== undefined) value.planId = planId;
  return value;
}

/**
 * Match a model id against an operator glob: `*` is the only metacharacter (prefix, suffix, or middle),
 * everything else matches literally, case-insensitively -- ledger ids are lowercased by the host, but
 * the glob is operator-typed and should not fail on casing.
 */
export function matchesGlob(id, glob) {
  if (typeof id !== "string" || typeof glob !== "string") return false;
  const pattern = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`, "i").test(id);
}

/** The first subscription covering (provider, model): exact provider equality plus any models-glob hit.
 * `includeHypothetical: false` is classification's view -- a what-if plan never covers anything real. */
function coveringSubscription(provider, model, subscriptions, { includeHypothetical = false } = {}) {
  for (const sub of subscriptions) {
    if (!includeHypothetical && sub.hypothetical) continue;
    if (sub.provider !== provider) continue;
    if (Array.isArray(sub.models) && sub.models.some((glob) => matchesGlob(model, glob))) return sub;
  }
  return null;
}

/**
 * Classify one attribution row. Order matters:
 *   1. a matched OWNED (non-hypothetical) subscription wins outright -> "plan": the row's recorded $0
 *      is an artifact of the provider's all-zero rate table, not a price;
 *   2. a positive stream-time cost is metered truth -> "metered" -- the fold never re-prices it;
 *   3. zero cost -> "zero-rated", whether the rate table says so (isZeroRated) or the model is unknown
 *      to the tables entirely. NEVER "free": "zero-rated" says a table rated it zero, which is a fact;
 *      "free" would claim nobody paid, which this fold cannot know.
 */
export function classifyRow(row, subscriptions, pricing) {
  const sub = coveringSubscription(row.provider, row.model, Array.isArray(subscriptions) ? subscriptions : []);
  if (sub) return { class: "plan", planId: sub.id };
  const cost = typeof row.cost === "number" ? row.cost : 0;
  if (cost > 0) return { class: "metered", planId: null };
  const priced = pricing?.getPricedModel?.(row.provider, row.model) ?? null;
  if ((priced !== null && pricing.isZeroRated(priced)) || cost === 0) return { class: "zero-rated", planId: null };
  // Unreachable for well-formed records (the host validates costs finite and non-negative), kept so a
  // malformed number can never masquerade as any priced class.
  return { class: "unknown", planId: null };
}

/**
 * One record's attribution rows -- the degradation ladder, newest shape first:
 *   1. ledgered (a `usage` block with rows): per-(provider,model) rows with the full cache split and a
 *      real reprice quad;
 *   2. pre-ledger (`tokens` but `usage` null -- also the fallback meter and mid-run deaths): ONE
 *      whole-run row from the HOST-effective record.provider/model. No cache split, so `quad` is null:
 *      a quad back-derived from flat totals would be a guess, and this fold does not guess;
 *   3. legacy (not even provider/model): one ("unknown","unknown") row -- attributed honestly to
 *      ignorance rather than to a plausible model;
 *   4. pre-#25 (`tokens` null): NO rows at all -- the run spent something and measured nothing.
 * The 1h cache-write tier is folded into `cacheWrite` for display fields (one column per concept), but
 * the quad keeps the full split -- reprice rates may distinguish the tiers.
 */
function attributionRows(record) {
  const usage = record.usage;
  if (usage && Array.isArray(usage.models) && usage.models.length > 0) {
    return usage.models.map((m) => {
      const quad = {};
      for (const key of QUAD_KEYS) quad[key] = m[key] ?? 0;
      return {
        provider: m.provider,
        model: m.model,
        calls: m.calls ?? 0,
        input: m.input ?? 0,
        output: m.output ?? 0,
        cacheRead: m.cacheRead ?? 0,
        cacheWrite: (m.cacheWrite ?? 0) + (m.cacheWrite1h ?? 0),
        total: m.total ?? 0,
        cost: m.cost ?? 0,
        quad,
      };
    });
  }
  const tokens = record.tokens;
  if (!tokens) return [];
  return [
    {
      provider: record.provider ?? "unknown",
      model: record.model ?? "unknown",
      calls: tokens.calls ?? 0,
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: tokens.total ?? 0,
      cost: tokens.cost ?? 0,
      quad: null,
    },
  ];
}

/**
 * One run's contribution to every aggregate: its classified rows, its metered dollars, the set of
 * classes it carries, and whether its number is a floor.
 */
function runContribution(record, subscriptions, pricing) {
  const tokens = record.tokens ?? null;
  // Pre-#25: the run spent real money and recorded nothing. $0 of class "unknown", and a FLOOR -- any
  // total containing it understates by construction.
  if (!tokens) return { rows: [], usd: 0, classes: ["unknown"], floor: true };
  // Floor rule: unpriced or unresolved calls are dollars the meter could not price, and the fallback
  // meter (metered:false) missed subagent/compaction spend entirely. Either way this run's number is a
  // floor, and floors are sticky -- any aggregate containing one is a floor.
  const floor = (tokens.unpriced ?? 0) > 0 || (tokens.unresolved ?? 0) > 0 || tokens.metered === false;
  const rows = attributionRows(record).map((row) => ({ ...row, ...classifyRow(row, subscriptions, pricing), floor }));
  // Metered truth: the run's stream-time cost IS the number -- never re-priced here -- except that
  // plan-covered rows contribute $0 metered to totals: the plan already paid, and their recorded cost
  // is an all-zero rate table artifact anyway. Their api-equivalent surfaces separately.
  const usd = rows.reduce((sum, row) => sum + (row.class === "plan" ? 0 : row.cost), 0);
  const classes = [...new Set(rows.map((row) => row.class))];
  return { rows, usd, classes, floor };
}

/**
 * Fold run contributions into one typed dollar. Aggregation demotion: a sum stays "metered" only when
 * EVERY addend is purely metered; one plan/zero-rated/estimated/unknown addend demotes the sum to
 * "estimated", because the number no longer says what was spent -- only what was spent on the metered
 * part -- and `coverage` then reports what fraction of the bucket's runs contributed metered dollars.
 * An empty bucket is vacuously metered: $0, fully measured.
 */
function combineContributions(contribs) {
  const usd = contribs.reduce((sum, c) => sum + c.usd, 0);
  const floor = contribs.some((c) => c.floor);
  const allMetered = contribs.every((c) => c.classes.length === 1 && c.classes[0] === "metered");
  if (allMetered) return typed(usd, "metered", { floor });
  const meteredRuns = contribs.filter((c) => c.classes.includes("metered")).length;
  return typed(usd, "estimated", { floor, coverage: meteredRuns / contribs.length });
}

/** A record's bucketing instant: `endedAt`, or `startedAt` for a record that never ended; null when
 * neither parses -- such a record cannot be placed in any bucket and is dropped by the fold. */
function recordMs(record) {
  const at = Date.parse(record?.endedAt ?? record?.startedAt ?? "");
  return Number.isFinite(at) ? at : null;
}

/**
 * Re-price ledgered rows at a counterfactual model. Only rows carrying a real ledger quad participate:
 * a pre-ledger run has no cache split, and an api-equivalent back-derived from its flat totals would be
 * a guess wearing a number's clothing -- such rows are EXCLUDED here and surface through
 * coverage/provenance instead, and the exclusion makes the result a floor. Returns null when the
 * counterfactual is undeclared or nothing could be re-priced: no baseline, no number.
 */
function repriceRows(rows, counterfactual, pricing, { extraExcluded = 0 } = {}) {
  if (counterfactual === null || counterfactual === undefined) return null;
  let usd = 0;
  let repriced = 0;
  let excluded = extraExcluded;
  for (const row of rows) {
    const result = row.quad === null ? null : pricing.reprice(row.quad, counterfactual);
    if (result === null || result === undefined) {
      excluded += 1;
      continue;
    }
    usd += result.usd;
    repriced += 1;
  }
  return repriced === 0 ? null : typed(usd, "estimated", { floor: excluded > 0 });
}

/**
 * Fold scanned run records against declared subscriptions and the injected pricing facade into the one
 * read-model the costs view renders. Everything below is derived per call and thrown away -- nothing
 * classified here is ever written anywhere.
 */
export function foldCosts({ records, subscriptions, pricing, nowMs, piAiPin = null, sinceMs = null, triggerJoin = null }) {
  const subs = Array.isArray(subscriptions) ? subscriptions : [];
  const runs = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== "object") continue;
    const at = recordMs(record);
    if (at === null) continue;
    runs.push({ record, at, contribution: runContribution(record, subs, pricing) });
  }
  runs.sort((a, b) => a.at - b.at);

  // The window the caller ASKED about versus the window the records happen to span. Proration must
  // denominate on the requested window (`sinceMs`, the same instant the caller cut the scan at):
  // deriving days from the first observed run understates plan cost on any sparse window -- two runs
  // yesterday against a month-to-date question made every verdict read SAVING -- so that derivation
  // survives only for callers that fold an arbitrary record set with no window to ask about.
  const firstRunMs = runs.length > 0 ? runs[0].at : null;
  const requested = Number.isFinite(sinceMs);
  const fromMs = requested ? Math.min(sinceMs, nowMs) : (firstRunMs ?? nowMs);
  const toMs = nowMs;
  const days = requested || runs.length > 0 ? Math.max(1, Math.ceil((toMs - fromMs) / DAY_MS)) : 0;

  return {
    // `firstRunMs` rides along (null when nothing ran) so a renderer can pad or trim the daily series
    // against the requested edge without re-deriving what the fold already knows.
    window: { fromMs, toMs, days, firstRunMs },
    // Daily buckets still start at the first observed run, NOT the requested edge: the sparkline's
    // gap-day discipline covers interior quiet days, but a month of leading zeros on a young
    // deployment would compress the visible history into the last few cells.
    daily: buildDaily(runs, firstRunMs ?? fromMs, toMs),
    byFlow: buildByFlow(runs, subs, pricing),
    byModel: buildByModel(runs),
    // null, not [], without a join: "not computed" and "nothing attributed" are different sentences,
    // and a caller that wired no triggers must not render an empty table that looks exhaustive.
    byTrigger: triggerJoin ? buildByTrigger(runs, triggerJoin) : null,
    byRepo: buildByRepo(runs),
    plans: buildPlans(runs, subs, pricing, days),
    provenance: buildProvenance(runs, piAiPin),
  };
}

/** UTC daily buckets over each run's `endedAt`, ascending. Gap days are PRESENT as zero-run entries:
 * a sparkline over this array renders quiet days as quiet rather than silently compressing history. */
function buildDaily(runs, fromMs, toMs) {
  if (runs.length === 0) return [];
  const buckets = new Map();
  for (const r of runs) {
    const day = utcDay(r.at);
    if (!buckets.has(day)) buckets.set(day, []);
    buckets.get(day).push(r.contribution);
  }
  const daily = [];
  // The epoch is UTC-midnight-aligned, so flooring to DAY_MS lands the cursor on each day's boundary.
  for (let cursor = Math.floor(fromMs / DAY_MS) * DAY_MS; cursor <= toMs; cursor += DAY_MS) {
    const day = utcDay(cursor);
    const contribs = buckets.get(day) ?? [];
    daily.push({ day, cost: combineContributions(contribs), runs: contribs.length });
  }
  return daily;
}

/** Per-flow rollup, sorted by metered cost descending. A null flow reads "(no flow)" -- a display
 * label, not an id, so it can never collide with a real skill-charset flow name. */
function buildByFlow(runs, subs, pricing) {
  const groups = new Map();
  for (const r of runs) {
    const flow = typeof r.record.flow === "string" && r.record.flow !== "" ? r.record.flow : "(no flow)";
    if (!groups.has(flow)) groups.set(flow, []);
    groups.get(flow).push(r);
  }
  const byFlow = [];
  for (const [flow, members] of groups) {
    // The flow's api-equivalent re-prices its plan-covered rows at each row's OWN plan's declared
    // counterfactual (rows of different plans re-price differently); metered rows already carry their
    // real dollars in `cost` and take no part here.
    const planRows = members.flatMap((m) => m.contribution.rows.filter((row) => row.class === "plan"));
    let apiEquiv = null;
    for (const sub of subs) {
      const rows = planRows.filter((row) => row.planId === sub.id);
      if (rows.length === 0) continue;
      const part = repriceRows(rows, sub.counterfactualModel, pricing);
      if (part === null) continue;
      apiEquiv = apiEquiv === null ? part : typed(apiEquiv.usd + part.usd, "estimated", { floor: apiEquiv.floor || part.floor });
    }
    byFlow.push({
      flow,
      // The machine key beside the display label: null for the no-flow bucket, the raw flow name
      // otherwise. The display label once leaked into the what-if filter, where `"(no flow)"` matches
      // no record and a fully ledgered bucket rendered the seeded band -- key and label never share a
      // field again (issue #175).
      flowKey: flow === "(no flow)" ? null : flow,
      runs: members.length,
      tokens: members.reduce((sum, m) => sum + (m.record.tokens?.total ?? 0), 0),
      cost: combineContributions(members.map((m) => m.contribution)),
      apiEquiv,
    });
  }
  return byFlow.sort((a, b) => b.cost.usd - a.cost.usd || a.flow.localeCompare(b.flow));
}

// The honesty buckets a run lands in when no trigger claims it, pinned to the table's tail in this
// order however the dollars compare: a bucket named "(unattributed)" sorting above real triggers on
// cost would read as the biggest spender when it is really the biggest unknown.
const TRIGGER_TAIL = ["chained", "manual", "unattributed"];
const TRIGGER_TAIL_LABELS = { chained: "(chained runs)", manual: "(manual/local)", unattributed: "(unattributed)" };

/**
 * Per-trigger rollup over the attribution the read-model passed IN (`attributeRunsToTriggers` --
 * the index+type agreement doctrine and the raw cron jobId grammar live there and are not re-derived
 * by this fold). Every run lands somewhere: a joined run under its trigger's graph node id
 * (`trigger:<index>`), a forge run the join refused under "unattributed", a run with a parentJobId
 * under "chained" (not rolled up to the ancestor trigger: walking parent chains across the retention
 * boundary would attribute partially, and a partial rollup wearing a trigger's name is a lie), and
 * everything else under "manual". `key` is the machine key, `label` display-only -- the byFlow
 * lesson. The outcome split rides along because "what did failed runs cost" is a per-trigger
 * question: a trigger whose spend is mostly failures is a different problem than an expensive one.
 */
function buildByTrigger(runs, triggerJoin) {
  const byJobId = triggerJoin?.byJobId && typeof triggerJoin.byJobId === "object" ? triggerJoin.byJobId : {};
  const groups = new Map();
  for (const r of runs) {
    const record = r.record;
    const entry = typeof record.jobId === "string" ? byJobId[record.jobId] : undefined;
    let bucket;
    if (entry && entry.key !== "unattributed") {
      bucket = { key: entry.key, index: entry.index ?? null, type: entry.type ?? null, label: entry.label ?? entry.key };
    } else if (entry) {
      bucket = { key: "unattributed", index: null, type: null, label: TRIGGER_TAIL_LABELS.unattributed };
    } else if (typeof record.parentJobId === "string" && record.parentJobId !== "") {
      bucket = { key: "chained", index: null, type: null, label: TRIGGER_TAIL_LABELS.chained };
    } else {
      bucket = { key: "manual", index: null, type: null, label: TRIGGER_TAIL_LABELS.manual };
    }
    if (!groups.has(bucket.key)) groups.set(bucket.key, { ...bucket, members: [] });
    groups.get(bucket.key).members.push(r);
  }
  const rows = [];
  for (const g of groups.values()) {
    const outcomes = { completed: 0, policy: 0, failed: 0 };
    for (const m of g.members) {
      const o = m.record.outcome;
      if (o === "completed" || o === "policy" || o === "failed") outcomes[o] += 1;
    }
    const failedMembers = g.members.filter((m) => m.record.outcome === "failed");
    rows.push({
      key: g.key,
      index: g.index,
      type: g.type,
      label: g.label,
      runs: g.members.length,
      tokens: g.members.reduce((sum, m) => sum + (m.record.tokens?.total ?? 0), 0),
      cost: combineContributions(g.members.map((m) => m.contribution)),
      outcomes,
      failedCost: failedMembers.length > 0 ? combineContributions(failedMembers.map((m) => m.contribution)) : null,
    });
  }
  return rows.sort((a, b) => {
    const tailA = TRIGGER_TAIL.indexOf(a.key);
    const tailB = TRIGGER_TAIL.indexOf(b.key);
    if (tailA !== -1 || tailB !== -1) return tailA === -1 ? -1 : tailB === -1 ? 1 : tailA - tailB;
    return b.cost.usd - a.cost.usd || a.label.localeCompare(b.label);
  });
}

/** A target's repo shape: the forge issue/MR tail stripped (`repo#12` -> `repo`, `proj!3` -> `proj`);
 * targets without a numeric tail (local:<basename>) ride through whole; null stays null. The one
 * grammar forgeRepoTargets (read-model) also strips by -- shared so the two can never disagree. */
export function repoOfTarget(target) {
  if (typeof target !== "string" || target === "") return null;
  const repo = target.replace(/[#!]\d+$/, "");
  return repo === "" ? null : repo;
}

/** Per-repo/target rollup. `key` null (with the "(no target)" display label) for records carrying no
 * target at all; `kind` is the records' uniform kind or null when a repo saw mixed kinds. */
function buildByRepo(runs) {
  const groups = new Map();
  for (const r of runs) {
    const repo = repoOfTarget(r.record.target);
    const mapKey = repo ?? "\u0000none";
    if (!groups.has(mapKey)) groups.set(mapKey, { key: repo, label: repo ?? "(no target)", kinds: new Set(), members: [] });
    const g = groups.get(mapKey);
    if (typeof r.record.kind === "string") g.kinds.add(r.record.kind);
    g.members.push(r);
  }
  const rows = [];
  for (const g of groups.values()) {
    rows.push({
      key: g.key,
      label: g.label,
      kind: g.kinds.size === 1 ? [...g.kinds][0] : null,
      runs: g.members.length,
      tokens: g.members.reduce((sum, m) => sum + (m.record.tokens?.total ?? 0), 0),
      cost: combineContributions(g.members.map((m) => m.contribution)),
    });
  }
  return rows.sort((a, b) => b.cost.usd - a.cost.usd || a.label.localeCompare(b.label));
}

/**
 * The per-trigger spend map for the topology surfaces, keyed by GRAPH NODE ID (`trigger:<index>` --
 * graph-model mints exactly this, so a badge lands on its node with no second join vocabulary).
 * Only real triggers appear: the chained/manual/unattributed honesty buckets have no node to badge
 * and live in byTrigger instead.
 */
export function foldTriggerCosts({ records, subscriptions, pricing, triggerJoin }) {
  const subs = Array.isArray(subscriptions) ? subscriptions : [];
  const byJobId = triggerJoin?.byJobId && typeof triggerJoin.byJobId === "object" ? triggerJoin.byJobId : {};
  const groups = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== "object") continue;
    if (recordMs(record) === null) continue; // the fold's own bucketing rule: unplaceable records are dropped
    const entry = typeof record.jobId === "string" ? byJobId[record.jobId] : undefined;
    if (!entry || entry.key === "unattributed" || !entry.key.startsWith("trigger:")) continue;
    if (!groups.has(entry.key)) groups.set(entry.key, []);
    groups.get(entry.key).push(runContribution(record, subs, pricing));
  }
  const out = {};
  for (const [key, contribs] of groups) {
    out[key] = { cost: combineContributions(contribs), runs: contribs.length };
  }
  return out;
}

/** Per-(provider,model) rollup from the attribution rows, sorted by cost descending. A run appears in
 * a model's `runs` count once, however many of its calls landed there. */
function buildByModel(runs) {
  const groups = new Map();
  for (const r of runs) {
    for (const row of r.contribution.rows) {
      const key = `${row.provider}\u0000${row.model}`;
      if (!groups.has(key)) {
        groups.set(key, { provider: row.provider, model: row.model, runs: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, rows: [] });
      }
      const g = groups.get(key);
      g.runs += 1; // one ledger row per (provider,model) per record, so rows count runs
      g.calls += row.calls;
      g.input += row.input;
      g.output += row.output;
      g.cacheRead += row.cacheRead;
      g.cacheWrite += row.cacheWrite;
      g.tokens += row.total;
      g.rows.push(row);
    }
  }
  const byModel = [];
  for (const g of groups.values()) {
    byModel.push({
      provider: g.provider,
      model: g.model,
      runs: g.runs,
      calls: g.calls,
      input: g.input,
      output: g.output,
      cacheRead: g.cacheRead,
      cacheWrite: g.cacheWrite,
      tokens: g.tokens,
      cost: combineRowCosts(g.rows),
    });
  }
  return byModel.sort((a, b) => b.cost.usd - a.cost.usd || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

/**
 * A model bucket's typed cost. Rows of one (provider,model) usually share a class, and a uniform class
 * is KEPT -- "plan" and "zero-rated" at the model grain are the whole point of the classification, not
 * impurities to demote away. Only a genuinely mixed bucket (the same model both billed and $0 across
 * runs) demotes to "estimated" with run-grain coverage.
 */
function combineRowCosts(rows) {
  const usd = rows.reduce((sum, row) => sum + (row.class === "plan" ? 0 : row.cost), 0);
  const floor = rows.some((row) => row.floor);
  const classes = [...new Set(rows.map((row) => row.class))];
  if (classes.length === 1) {
    return typed(usd, classes[0], classes[0] === "plan" ? { floor, planId: rows[0].planId } : { floor });
  }
  const meteredRows = rows.filter((row) => row.class === "metered").length;
  return typed(usd, "estimated", { floor, coverage: meteredRows / rows.length });
}

/** Score every declared plan -- owned and hypothetical -- against the window's attributed runs. */
function buildPlans(runs, subs, pricing, windowDays) {
  return subs.map((sub) => {
    // Attribution ignores `hypothetical`: a what-if plan attributes the SAME rows an owned one would
    // (provider equality + models glob); the flag changes how the rows are SCORED below, never which
    // rows are in scope.
    const attributed = [];
    for (const r of runs) {
      const covered = r.contribution.rows.filter((row) => row.provider === sub.provider && sub.models.some((glob) => matchesGlob(row.model, glob)));
      if (covered.length > 0) {
        attributed.push({ at: r.at, rows: covered, floor: r.contribution.floor });
        continue;
      }
      // A pre-#25 record carries no rows at all, but the host-effective provider/model can still name
      // this plan: the run happened ON the plan even though it measured nothing. It counts against the
      // plan's windows and amortization, and it floors every derived number.
      if (r.contribution.rows.length === 0 && r.record.provider === sub.provider && typeof r.record.model === "string" && sub.models.some((glob) => matchesGlob(r.record.model, glob))) {
        attributed.push({ at: r.at, rows: [], floor: true });
      }
    }
    const attributedRuns = attributed.length;
    const attributedTokens = attributed.reduce((sum, a) => sum + a.rows.reduce((s, row) => s + row.total, 0), 0);
    const anyFloor = attributed.some((a) => a.floor);

    // Proration: the declared monthly price scaled by window-days over a 30-day-month proxy. Coarse on
    // purpose -- billing anniversaries, leap months and partial cycles are vendor bookkeeping this fold
    // has no facts about, so 30 is the honest round number, not an attempt at calendar precision.
    const prorated = sub.price.amount * (windowDays / 30);

    const amortizedPerRun = attributedRuns > 0 ? typed(prorated / attributedRuns, "estimated", { floor: anyFloor }) : null;
    const apiEquiv = repriceRows(attributed.flatMap((a) => a.rows), sub.counterfactualModel, pricing, {
      extraExcluded: attributed.filter((a) => a.rows.length === 0).length,
    });

    let verdict;
    if (attributedRuns === 0) {
      // Nothing attributed: any verdict would score the plan against runs it never touched.
      verdict = { kind: "NO_BASELINE", usd: null };
    } else if (sub.hypothetical) {
      // A hypothetical plan is scored against what the covered rows ACTUALLY cost today (their metered
      // stream-time dollars) versus the prorated plan price: would buying it have saved money?
      const actual = attributed.reduce((sum, a) => sum + a.rows.reduce((s, row) => s + row.cost, 0), 0);
      verdict =
        actual > prorated
          ? { kind: "WOULD_SAVE", usd: typed(actual - prorated, "estimated", { floor: anyFloor }) }
          : { kind: "WOULD_LOSE", usd: typed(prorated - actual, "estimated", { floor: anyFloor }) };
    } else if (apiEquiv === null) {
      // Owned plan, no counterfactual declared (or nothing re-priceable): the covered spend has no
      // API-rate baseline, and inventing one is exactly what this fold refuses to do.
      verdict = { kind: "NO_BASELINE", usd: null };
    } else {
      // Owned plan: what the covered runs would have cost at API rates versus the prorated plan price.
      verdict =
        apiEquiv.usd > prorated
          ? { kind: "SAVING", usd: typed(apiEquiv.usd - prorated, "estimated", { floor: apiEquiv.floor }) }
          : { kind: "LOSING", usd: typed(prorated - apiEquiv.usd, "estimated", { floor: apiEquiv.floor }) };
    }

    return {
      id: sub.id,
      vendor: sub.vendor,
      hypothetical: sub.hypothetical,
      price: sub.price,
      attributedRuns,
      attributedTokens,
      amortizedPerRun,
      apiEquiv,
      verdict,
      windows: (sub.windows ?? []).map((w) => peakWindow(w, attributed)),
    };
  });
}

/**
 * The observed peak inside one declared plan window -- FACTS ONLY. `limit` rides through verbatim
 * (null = vendor undisclosed, first-class per the subscriptions schema) and nothing here computes
 * remaining/burn-down: the fold reports what happened, never how much room is "left" against a number
 * the vendor may not even have published.
 */
function peakWindow(w, attributed) {
  // A window may be scoped to a subset of the plan's models; a run whose covered rows all fall outside
  // the scope does not count. A row-less attributed run (pre-#25) cannot be scope-checked and counts
  // regardless -- the floor mentality: over-count the peak rather than hide a run.
  const events = [];
  for (const a of [...attributed].sort((x, y) => x.at - y.at)) {
    const scopedRows = w.scope === null || w.scope === undefined ? a.rows : a.rows.filter((row) => w.scope.some((glob) => matchesGlob(row.model, glob)));
    if (w.scope !== null && w.scope !== undefined && a.rows.length > 0 && scopedRows.length === 0) continue;
    events.push({ at: a.at, tokens: scopedRows.reduce((sum, row) => sum + row.total, 0) });
  }

  let peakRuns = 0;
  let peakTokens = 0;
  if (w.rolling) {
    // True sliding max: each event in turn is the window's right edge; shrink the left edge to the
    // span and take the running maximum. A rolling "month" uses the same 30-day proxy as proration.
    const span = w.per === "5h" ? 5 * HOUR_MS : w.per === "7d" ? 7 * DAY_MS : 30 * DAY_MS;
    let left = 0;
    let runsInWindow = 0;
    let tokensInWindow = 0;
    for (let right = 0; right < events.length; right++) {
      runsInWindow += 1;
      tokensInWindow += events[right].tokens;
      while (events[left].at <= events[right].at - span) {
        runsInWindow -= 1;
        tokensInWindow -= events[left].tokens;
        left += 1;
      }
      peakRuns = Math.max(peakRuns, runsInWindow);
      peakTokens = Math.max(peakTokens, tokensInWindow);
    }
  } else {
    // Calendar buckets: "month" folds on the UTC calendar month; every other size folds on the UTC
    // day -- a day-grain approximation (a non-rolling 5h vendor window publishes no anchor to do
    // better against, and a coarser bucket can only OVER-count a peak, never hide a breach).
    const buckets = new Map();
    for (const e of events) {
      const key = w.per === "month" ? utcDay(e.at).slice(0, 7) : utcDay(e.at);
      const b = buckets.get(key) ?? { runs: 0, tokens: 0 };
      b.runs += 1;
      b.tokens += e.tokens;
      buckets.set(key, b);
    }
    for (const b of buckets.values()) {
      peakRuns = Math.max(peakRuns, b.runs);
      peakTokens = Math.max(peakTokens, b.tokens);
    }
  }
  return { per: w.per, rolling: w.rolling, unit: w.unit, limit: w.limit, peakRuns, peakTokens };
}

/** The honesty ledger beside the numbers: how much of the window was actually measured, and whether
 * any of it was priced by a different pi-ai than the one this build pins. */
function buildProvenance(runs, piAiPin) {
  let runsUnmetered = 0;
  let runsUnledgered = 0;
  let runsLedgerTruncated = 0;
  let ratesDrifted = 0;
  for (const { record } of runs) {
    if (!record.tokens) runsUnmetered += 1;
    // An empty ledger degrades exactly like an absent one -- the flat totals are all the reader has.
    else if (!(record.usage && Array.isArray(record.usage.models) && record.usage.models.length > 0)) runsUnledgered += 1;
    // The meter caps the ledger at 8 named rows and folds the rest into `other` (usage.truncated,
    // INT-RUN-HISTORY-FILE-CONTRACT). Such a run's per-model attribution is partly anonymous, and a
    // fold that states unmetered and unledgered runs but not this one would be selectively honest.
    if ((record.usage?.truncated ?? 0) > 0) runsLedgerTruncated += 1;
    const piAi = record.usage?.piAi ?? null;
    // Drift needs BOTH versions: an unknown pin cannot accuse a record of having been priced elsewhere.
    if (piAi !== null && piAiPin !== null && piAi !== piAiPin) ratesDrifted += 1;
  }
  return {
    total: combineContributions(runs.map((r) => r.contribution)),
    runsTotal: runs.length,
    runsUnmetered,
    runsUnledgered,
    runsLedgerTruncated,
    ratesDrifted,
    piAiPin,
  };
}

/**
 * "What would this flow cost per run on model X?" -- the median per-run quad over the flow's ledgered
 * runs, re-priced at the target. MEDIAN, not mean: one 10x outlier run must not move the estimate.
 * With no ledgered run to measure from (or a target the tables cannot price), degrade to the seeded
 * band rather than emit a $0 that looks like an answer.
 */
export function whatIfFlow({ records, flow, target, pricing }) {
  const members = (Array.isArray(records) ? records : []).filter((r) => r && typeof r === "object" && (r.flow ?? null) === flow);
  const ledgered = members.filter((r) => r.usage && Array.isArray(r.usage.models) && r.usage.models.length > 0);
  if (ledgered.length === 0) return seededBand(members.length);
  const quads = ledgered.map((r) => sumQuads(r.usage.models));
  const priced = pricing.reprice(medianQuad(quads), target);
  if (priced === null || priced === undefined) return seededBand(members.length);
  return {
    class: "estimated",
    // The per-run estimate times ALL observed runs of the flow -- the un-ledgered ones presumably cost
    // something too; `coverage`/`excluded` say how much of that extrapolation is measured.
    usd: priced.usd * members.length,
    perRun: priced.usd,
    coverage: ledgered.length / members.length,
    excluded: members.length - ledgered.length,
    ratesVersion: priced.ratesVersion,
  };
}

/**
 * The zero-knowledge estimate: no ledgered run has ever measured this flow, so the only available
 * number is requirements.md's unmeasured $0.5-$5/job band (tracked at OQ-002), times the flow's
 * observed run count -- or the bare per-run band when the flow has never run at all. `class: "seeded"`
 * is the label that keeps this band from ever being mistaken for a measurement.
 */
function seededBand(runCount) {
  const n = Math.max(1, runCount);
  return { class: "seeded", low: 0.5 * n, high: 5 * n, note: "unmeasured (OQ-002)" };
}

/** Componentwise sum of a run's ledger rows into one per-run quad (full cache split). */
function sumQuads(rows) {
  const quad = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  for (const row of rows) {
    for (const key of QUAD_KEYS) quad[key] += row[key] ?? 0;
  }
  return quad;
}

/** Componentwise median across per-run quads (even counts average the two middle values). */
function medianQuad(quads) {
  const quad = {};
  for (const key of QUAD_KEYS) {
    const sorted = quads.map((q) => q[key]).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    quad[key] = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return quad;
}
