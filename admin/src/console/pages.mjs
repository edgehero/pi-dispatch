/**
 * The console's screens (issue #641, REQ-OPERATOR-CONSOLE-SCREENS): which screens exist, what each one's query may say,
 * what each one reads, and how each one is drawn from its panels.
 *
 * THREE STEPS, KEPT APART so the live stream and the page load cannot disagree:
 *
 *   1. `parsePageQuery(name, searchParams)` judges the query: every parameter named, bounded and charset-checked, and a
 *      value that fails is REFUSED, never trimmed into one that passes (`run-filter.mjs`'s rule, which the runs screen
 *      uses for its filters). A refusal names the parameter and its rule, never the value.
 *   2. `loadPageData(name, query, deps)` is the ONLY function here that reads. It calls the fleet reader's `snapshot()`
 *      at most once, and nothing else on a screen that needs only the snapshot. The live hub calls it once per tick for
 *      each distinct screen and query, and hands the result to every stream showing that screen.
 *   3. `renderPage(name, ctx)` and `pagePanels(name, ctx)` draw from that data and nothing else: pure, with `now` taken
 *      from the data, so the same data draws the same bytes. `renderPage` places each panel in
 *      `<section id="p-…" data-panel>`; `pagePanels` returns the same panels' inner HTML for the stream to swap in.
 *
 * THE ROLE RULE lives in the panels (`panels.mjs` header): the operator alone sees a failure reason and the audit log,
 * and (issue #642) the action controls, which a read-only console draws for nobody.
 * Data is read once for both roles, and the role decides only what is drawn, so a stream must be rendered per role.
 */
import { CONSOLE_AUDIT_CURSOR_RE } from "@edgehero/pi-dispatch/console-audit";
import { FORGES } from "@edgehero/pi-dispatch/forges";
import { RUN_FILTER_FIELDS, parseRunFilter } from "../run-filter.mjs";
import { html, page } from "./html.mjs";
import {
  auditLog,
  configMcp,
  configPackages,
  configPauseWindows,
  configProjects,
  configScopedLimits,
  configSecretBundles,
  configSecretProfiles,
  configSettings,
  configTriggers,
  fleetActive,
  fleetFailed,
  fleetHeld,
  fleetHosts,
  fleetDoctor,
  fleetQueues,
  fleetSchedulers,
  INSIGHTS_DEFAULT_RANGE,
  INSIGHTS_RANGES,
  insightsPanel,
  insightsRange,
  insightsWhatIf,
  WHATIF_FLOW_RE,
  navHtml,
  overviewActive,
  overviewFailures,
  overviewHosts,
  overviewParked,
  overviewSpend,
  overviewState,
  parkedInbox,
  runChain,
  runChat,
  runCostPanel,
  runInbox,
  runProgress,
  runResources,
  runSession,
  runSummary,
  runsFilter,
  runsTable,
  RUN_ID_RE,
} from "./panels.mjs";
import { chatFactsOf, parkedAnswerCheckOf } from "./run-api.mjs";
import { runTranscriptSection } from "./transcript.mjs";
import { WHATIF_MODEL_RE } from "./whatif.mjs";

/**
 * The screens. `path` is the route, `auth` the least role that may open it, `live` whether the page opens the event
 * stream (a screen whose data changes while it is open), `title` the heading, `nav` the navigation label (none for
 * the run detail, which is reached from a run). Insights is not live: its assembly is the expensive read (cached 30 s
 * by the caller), and the range picker is its refresh; its what-if form is a GET of the same page. Configuration and
 * the audit log change by a person's hand.
 * The run detail is live since issue #644: a running job's progress panel moves, and a run that ends gets its record's
 * panels without a reload; since issue #646 its inbox panel moves too, a message's state from queued to delivered. Its
 * data is read at most once per `LIVE_DEFAULTS.pageMinMs.run` (live.mjs), since a run's load also reads its record and
 * searches for its children.
 */
export const PAGES = Object.freeze({
  overview: Object.freeze({ path: "/", auth: "viewer", live: true, title: "Overview", nav: "Overview" }),
  runs: Object.freeze({ path: "/runs", auth: "viewer", live: true, title: "Runs", nav: "Runs" }),
  run: Object.freeze({ path: "/run", auth: "viewer", live: true, title: "Run", nav: null }),
  parked: Object.freeze({ path: "/parked", auth: "viewer", live: true, title: "Parked inbox", nav: "Parked" }),
  insights: Object.freeze({ path: "/insights", auth: "viewer", live: false, title: "Spend and insights", nav: "Spend" }),
  fleet: Object.freeze({ path: "/fleet", auth: "viewer", live: true, title: "Fleet", nav: "Fleet" }),
  config: Object.freeze({ path: "/config", auth: "viewer", live: false, title: "Configuration", nav: "Configuration" }),
  audit: Object.freeze({ path: "/audit", auth: "operator", live: false, title: "Audit log", nav: "Audit" }),
});

/** Each screen's panels, in page order: `[id, renderer]`. An id is `p-<panel>`, unique within its screen. */
const PAGE_PANELS = Object.freeze({
  overview: [["p-state", overviewState], ["p-spend", overviewSpend], ["p-hosts", overviewHosts], ["p-parked", overviewParked], ["p-failures", overviewFailures], ["p-active", overviewActive]],
  runs: [["p-filter", runsFilter], ["p-runs", runsTable]],
  run: [["p-progress", runProgress], ["p-chat", runChat], ["p-inbox", runInbox], ["p-run", runSummary], ["p-cost", runCostPanel], ["p-resources", runResources], ["p-session", runSession], ["p-chain", runChain]],
  parked: [["p-parked", parkedInbox]],
  insights: [["p-range", insightsRange], ["p-whatif", insightsWhatIf], ["p-insights", insightsPanel]],
  fleet: [["p-queues", fleetQueues], ["p-active", fleetActive], ["p-held", fleetHeld], ["p-hosts", fleetHosts], ["p-doctor", fleetDoctor], ["p-schedulers", fleetSchedulers], ["p-failed", fleetFailed]],
  config: [["p-triggers", configTriggers], ["p-settings", configSettings], ["p-pause-windows", configPauseWindows], ["p-scoped-limits", configScopedLimits], ["p-projects", configProjects], ["p-mcp", configMcp], ["p-packages", configPackages], ["p-secret-profiles", configSecretProfiles], ["p-secret-bundles", configSecretBundles]],
  audit: [["p-audit", auditLog]],
});

/** The panel ids of a screen, in page order (for the stream's tests and the hub). */
export function panelIds(name) {
  return (PAGE_PANELS[name] ?? []).map(([id]) => id);
}

// ---- the query -------------------------------------------------------------------------------------------------------

/** The parameters each screen takes; any other refuses the request. */
const PAGE_PARAMS = Object.freeze({
  overview: [],
  runs: [...RUN_FILTER_FIELDS, "before"],
  run: ["id"],
  parked: [],
  insights: ["range", "whatif", "flow", "paths"],
  fleet: [],
  config: [],
  audit: ["before"],
});

/** The most parameters, and the longest value, a query may carry before anything looks at what they say. */
export const QUERY_LIMITS = Object.freeze({ params: 16, valueLength: 256 });

/** A runs cursor: millis, a whole number (`readRunsPage`'s `before`). */
const RUNS_BEFORE_RE = /^\d{1,16}$/;

/** `searchParams` as a URLSearchParams, or null for something that is not a query. */
function asParams(searchParams) {
  if (searchParams instanceof URLSearchParams) return searchParams;
  if (searchParams === null || searchParams === undefined) return new URLSearchParams();
  if (typeof searchParams === "string") return new URLSearchParams(searchParams);
  if (typeof searchParams === "object") {
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (typeof v !== "string") return null;
      out.append(k, v);
    }
    return out;
  }
  return null;
}

/**
 * Judge a screen's query: `{ query }` (frozen) or `{ refusal }` (a sentence naming the parameter and its rule).
 *
 *   - runs: the filter (`parseRunFilter`) and `before` (a cursor in millis); `{ filter, before }`.
 *   - run: `id`, required, in the read model's run-id charset; `{ id }`.
 *   - insights: `range`, one of 7d, 30d, mtd, default 30d; `whatif` (`<provider>/<model>`, `WHATIF_MODEL_RE`) and `flow`
 *     (the skill-name charset), together or not at all; `paths`, only `full`; `{ range, whatif, flow, paths }`, each
 *     absent one null. `paths=full` is ACCEPTED from anyone, and honoured for an operator alone (`insightsFullPaths`).
 *   - audit: `before` (an audit position, `YYYY-MM:<line>`, `readConsoleAudit`'s cursor); `{ before }`.
 *   - every other screen: no parameter at all; `{}`.
 *
 * Bounded first: at most `QUERY_LIMITS.params` parameters, each value at most `QUERY_LIMITS.valueLength` characters,
 * and a parameter the screen does not take refuses, as does one given twice.
 */
export function parsePageQuery(name, searchParams) {
  if (typeof name !== "string" || !Object.hasOwn(PAGES, name)) return { refusal: "there is no such page on this console" };
  const params = asParams(searchParams);
  if (params === null) return { refusal: "the query is not readable" };
  const allowed = PAGE_PARAMS[name];
  let n = 0;
  for (const [key, value] of params) {
    n += 1;
    if (n > QUERY_LIMITS.params) return { refusal: `a query carries at most ${QUERY_LIMITS.params} parameters` };
    // The key is checked against the screen's own list before it is named, so a refusal never echoes a stranger's key.
    if (!allowed.includes(key)) return { refusal: allowed.length === 0 ? `the ${name} page takes no query parameters` : `the ${name} page takes only ${allowed.join(", ")}` };
    if (value.length > QUERY_LIMITS.valueLength) return { refusal: `${key} is longer than ${QUERY_LIMITS.valueLength} characters` };
  }
  for (const key of allowed) if (params.getAll(key).length > 1) return { refusal: `${key} is given more than once` };
  const one = (key) => {
    const v = params.get(key);
    return v === null || v === "" ? null : v;
  };
  switch (name) {
    case "runs": {
      const f = parseRunFilter(params);
      if (f.refusal) return { refusal: f.refusal };
      const raw = one("before");
      let before = null;
      if (raw !== null) {
        if (!RUNS_BEFORE_RE.test(raw) || !Number.isSafeInteger(Number(raw))) return { refusal: "before must be a whole number of milliseconds" };
        before = Number(raw);
      }
      return { query: Object.freeze({ filter: f.filter, before }) };
    }
    case "run": {
      const id = one("id");
      if (id === null) return { refusal: "the run page needs ?id= with a run's job id" };
      if (!RUN_ID_RE.test(id)) return { refusal: "id must be a run id (letters, digits and . _ : -, at most 200 characters)" };
      return { query: Object.freeze({ id }) };
    }
    case "insights": {
      const range = one("range") ?? INSIGHTS_DEFAULT_RANGE;
      if (!INSIGHTS_RANGES.includes(range)) return { refusal: `range must be one of ${INSIGHTS_RANGES.join(", ")}` };
      const whatif = one("whatif");
      const flow = one("flow");
      // Together or not at all: the estimate scores one flow's median run, so a model without a flow has no question in
      // it, and a flow without a model has no rates to ask at.
      if ((whatif === null) !== (flow === null)) return { refusal: "whatif and flow go together: give both (whatif=<provider>/<model>&flow=<flow>) or neither" };
      if (whatif !== null && !WHATIF_MODEL_RE.test(whatif)) return { refusal: "whatif must be <provider>/<model> (letters, digits and . _ - for the provider; letters, digits and . _ : / @ + - for the model, which may also start with @ or ~, at most 128 characters)" };
      if (flow !== null && !WHATIF_FLOW_RE.test(flow)) return { refusal: "flow must be a flow name (lowercase letters, digits, '_' and '-', at most 64 characters)" };
      const paths = one("paths");
      if (paths !== null && paths !== "full") return { refusal: "paths must be full (or left out for folder names)" };
      return { query: Object.freeze({ range, whatif, flow, paths }) };
    }
    case "audit": {
      const raw = one("before");
      if (raw === null) return { query: Object.freeze({ before: null }) };
      // Exactly `readConsoleAudit`'s cursor (`YYYY-MM:<line>`, its own regex), so a refused cursor never reaches a read.
      const m = CONSOLE_AUDIT_CURSOR_RE.exec(raw);
      if (m === null || !Number.isSafeInteger(Number(m[2]))) return { refusal: "before must be an audit position (YYYY-MM:line, as the Older rows link gives it)" };
      return { query: Object.freeze({ before: raw }) };
    }
    default:
      return { query: Object.freeze({}) };
  }
}

/**
 * A parsed query as the canonical query string (no leading `?`): what a live page carries in `data-query` for the
 * script to reopen its stream with, and what the stream's `page=` request passes back through `parsePageQuery`.
 */
export function pageQueryString(name, query) {
  const p = new URLSearchParams();
  const q = query ?? {};
  if (name === "runs") {
    for (const k of RUN_FILTER_FIELDS) if (q.filter?.[k] !== undefined) p.set(k, q.filter[k]);
    if (q.before !== null && q.before !== undefined) p.set("before", String(q.before));
  } else if (name === "run" && q.id) p.set("id", q.id);
  else if (name === "insights") {
    for (const k of ["range", "whatif", "flow", "paths"]) if (typeof q[k] === "string" && q[k] !== "") p.set(k, q[k]);
  }
  else if (name === "audit" && q.before !== null && q.before !== undefined) p.set("before", String(q.before));
  return p.toString();
}

// ---- reading ---------------------------------------------------------------------------------------------------------

/** What each screen reads beside the clock. */
const PAGE_READS = Object.freeze({
  overview: ["snapshot"],
  runs: ["runsPage", "subscriptions"],
  run: ["run", "subscriptions", "transcriptMeta", "progress", "inbox", "chat"],
  parked: ["snapshot"],
  insights: ["insights"],
  fleet: ["snapshot"],
  config: ["snapshot"],
  audit: ["audit"],
});

/** The runs a screen shows per page, and how far the run detail looks for a run's children. */
export const RUNS_PER_PAGE = 50;
const CHILD_SEARCH = Object.freeze({ pageSize: 100, pages: 3 });
/** The audit rows per page. */
export const AUDIT_PER_PAGE = 50;

/**
 * The deployment env's forge instance variables alone (the ones `forgeLinkOf` reads): the page data never carries the
 * rest of the env, which holds tokens and keys, so nothing that serializes the data can leak them.
 */
function forgeEnvOf(env) {
  const names = new Set(["GITLAB_URL", "FORGEJO_URL", "AZURE_ORG_URL"]);
  for (const forge of Object.values(FORGES)) for (const n of forge?.hostVars ?? []) names.add(n);
  const out = {};
  for (const n of [...names].sort()) if (typeof env?.[n] === "string" && env[n] !== "") out[n] = env[n];
  return Object.freeze(out);
}

/** The subscriptions the cost classifier knows plans by: an array, from `deps.subscriptions()` when wired, else none. */
async function subscriptionsOf(deps) {
  if (typeof deps.subscriptions !== "function") return [];
  try {
    const got = await deps.subscriptions();
    if (Array.isArray(got)) return got;
    return Array.isArray(got?.subscriptions) ? got.subscriptions : [];
  } catch {
    return [];
  }
}

/**
 * A run's children: runs whose `parentJobId` is its id, among the newest `CHILD_SEARCH.pages` pages of runs (a child
 * starts after its parent, so the search stops at the first page older than the parent's start). `{ children,
 * searched }`, `searched` the number of runs examined, which the page states rather than claiming none exist.
 */
async function childrenOf(fleet, record) {
  const startMs = Date.parse(record.startedAt ?? record.endedAt ?? "");
  const children = [];
  let searched = 0;
  let before = null;
  for (let i = 0; i < CHILD_SEARCH.pages; i += 1) {
    let pageRead;
    try {
      pageRead = await fleet.runsPage({ before, limit: CHILD_SEARCH.pageSize });
    } catch {
      break;
    }
    if (!Array.isArray(pageRead?.runs)) break;
    searched += pageRead.runs.length;
    for (const r of pageRead.runs) if (r?.parentJobId === record.jobId) children.push({ jobId: r.jobId ?? null, outcome: r.outcome ?? null, startedAt: r.startedAt ?? null });
    if (pageRead.next === null || pageRead.next === undefined || (Number.isFinite(startMs) && pageRead.next <= startMs)) break;
    before = pageRead.next;
  }
  children.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || String(a.jobId).localeCompare(String(b.jobId)));
  return { children, searched };
}

/**
 * Read what screen `name` shows for `query` (a `parsePageQuery` result's `query`). `deps`:
 *
 *   - `fleet`: a `createFleetReader` instance (`snapshot`, `runsPage`, `runById`). `snapshot()` is called at most once.
 *   - `insights(window, { fullPaths })`: the assembled insights payload for a window (the caller caches it: it is the
 *     expensive read). `fullPaths` is true only for an operator's `paths=full`.
 *   - `whatIf({ model, flow })` (optional): the what-if answer (`whatif.mjs`'s reader, cached and bounded by the caller).
 *   - `pricedModels()` (optional): the priced catalog's `provider/id` strings, for the what-if form's suggestions.
 *   - `audit({ limit, before })`: `readConsoleAudit` bound to the deployment's logs directory.
 *   - `subscriptions()` (optional): the subscriptions file's entries, for the cost class of a plan-covered run.
 *   - `env`: the deployment's env, of which only the forge instance variables are kept (`forgeEnvOf`).
 *   - `now`: the clock (a function or a number), read ONCE; every panel draws from this instant.
 *
 * `who` is the session asking (`{ role }`): only the spend screen's `paths=full` reads by role, and only an operator's
 * request reads full paths, so a viewer's page data never holds them. The live hub passes none (insights is not live).
 *
 * Never throws for a read that fails: the field is null (or carries a sentence), and the panel says so.
 */
export async function loadPageData(name, query, deps = {}, who = {}) {
  if (!Object.hasOwn(PAGES, name)) throw new RangeError(`no such page: ${String(name)}`);
  const now = typeof deps.now === "function" ? deps.now() : Number.isFinite(deps.now) ? deps.now : Date.now();
  const q = query ?? {};
  const data = { page: name, now, env: forgeEnvOf(deps.env) };
  const reads = PAGE_READS[name];
  if (reads.includes("snapshot")) {
    try {
      data.snapshot = await deps.fleet.snapshot();
    } catch {
      data.snapshot = null;
    }
  }
  if (reads.includes("subscriptions")) data.subscriptions = await subscriptionsOf(deps);
  if (reads.includes("runsPage")) {
    try {
      data.runsPage = await deps.fleet.runsPage({ before: q.before ?? null, limit: RUNS_PER_PAGE, filter: q.filter ?? null });
    } catch {
      data.runsPage = null;
    }
  }
  if (reads.includes("run")) {
    try {
      data.run = await deps.fleet.runById(q.id);
    } catch {
      data.run = { missing: true };
    }
    if (data.run?.record) Object.assign(data, await childrenOf(deps.fleet, data.run.record).then(({ children, searched }) => ({ children, childrenSearched: searched })));
  }
  if (reads.includes("transcriptMeta") && typeof deps.fleet?.transcriptMeta === "function") {
    // Issue #643: whether the run has a live transcript stream, without a byte of its text (the stream's text goes to an
    // operator's `/api/transcript` alone). Read for both roles, as all page data is; only an operator's page uses it.
    try {
      const meta = await deps.fleet.transcriptMeta(q.id);
      data.transcript = meta?.unreachable || meta?.invalid ? { unreachable: Boolean(meta.unreachable), exists: false } : { exists: meta?.exists === true, ended: meta?.ended === true, outcome: typeof meta?.outcome === "string" ? meta.outcome : null, length: Number.isSafeInteger(meta?.length) ? meta.length : 0 };
    } catch {
      data.transcript = { unreachable: true, exists: false };
    }
  }
  if (reads.includes("progress") && typeof deps.fleet?.progress === "function") {
    // Issue #644: the run's progress snapshot, WHOLE (its phase names and note included), read once for both roles as
    // all page data is; `runProgress` draws the model's words for an operator alone. Page data is never serialized to a
    // browser: only rendered panels leave this process.
    // Issue #662: by the job's RUN id, and with whether this attempt's run went on as a recovery (`progressOfRun`), so a
    // recovery's own page shows its live progress and the attempt it continues shows its own record's, not the
    // recovery's. A fleet without it (an older reader double) reads by the page's id, as before.
    try {
      if (typeof deps.fleet.progressOfRun === "function") {
        const got = await deps.fleet.progressOfRun(q.id, data.run?.record ?? null);
        data.progress = got?.progress ?? { unreachable: true };
        if (got?.continues === true) data.progressContinues = { as: typeof got.continuesAs === "string" && RUN_ID_RE.test(got.continuesAs) ? got.continuesAs : null };
      } else data.progress = await deps.fleet.progress(q.id);
    } catch {
      data.progress = { unreachable: true };
      // A continued attempt shows its own record whatever the read did: the record alone says its run went on.
      if (typeof deps.fleet.progressOfRun === "function" && data.run?.record?.reason === "recovery-enqueued") data.progressContinues = { as: null };
    }
  }
  if (reads.includes("inbox") && typeof deps.fleet?.inbox === "function") {
    // Issue #646: a steer-armed job's inbox, WITHOUT TEXT (the reader's `readJobInbox`: ids, modes, sources, states,
    // times and byte counts), and whether its run takes messages now. Both roles get the list; `runInbox` draws the
    // message form and the withdraw buttons for an operator alone.
    try {
      data.inbox = await deps.fleet.inbox(q.id);
    } catch {
      data.inbox = { unreachable: true };
    }
  }
  if (reads.includes("chat")) {
    // Issue #647: the chat this run can have (`chatFactsOf`: the job's queue state, its active recovery, and for a parked
    // record whether a later run took the answer), for the Chat panel. Null without a job-state reader. The newer-run
    // search is a runs-page read, so the live loop pays it only for a parked record, whose mode depends on it.
    try {
      data.chat = await chatFactsOf(deps.fleet, q.id, data.run?.record ?? null, { searchNewer: "parked", now: () => now });
    } catch {
      data.chat = { unreachable: true };
    }
    // A reply the Chat panel offers is one the planner would plan (issue #647): the planner's own predicate over the
    // parked run's retained job and the triggers file (`parkedAnswerCheck`, a sentence or ok, never the job's data),
    // reused for PARK_CHECK_CACHE_MS per run id (`parkedAnswerCheckOf`), so the 2 s loop does not read it every tick.
    if (data.chat?.mode === "reply" && typeof deps.fleet?.parkedAnswerCheck === "function") {
      data.chatAnswer = await parkedAnswerCheckOf(deps.fleet, q.id, data.run?.record ?? null, { now: () => now });
    }
  }
  if (reads.includes("insights")) {
    const fullPaths = q.paths === "full" && who?.role === "operator";
    try {
      data.insights = await deps.insights(q.range ?? INSIGHTS_DEFAULT_RANGE, { fullPaths });
    } catch {
      data.insights = null;
      data.insightsError = "The spend history could not be assembled. The console's log has the reason.";
    }
    try {
      const models = typeof deps.pricedModels === "function" ? deps.pricedModels() : [];
      data.pricedModels = Array.isArray(models) ? models : [];
    } catch {
      data.pricedModels = [];
    }
    if (typeof q.whatif === "string" && typeof q.flow === "string") {
      if (typeof deps.whatIf !== "function") data.whatIf = { model: q.whatif, flow: q.flow, unreachable: "the what-if reader is not wired" };
      else {
        try {
          data.whatIf = await deps.whatIf({ model: q.whatif, flow: q.flow });
        } catch {
          data.whatIf = { model: q.whatif, flow: q.flow, unreachable: "the what-if estimate failed" };
        }
      }
    }
  }
  if (reads.includes("audit")) {
    try {
      data.audit = await deps.audit({ limit: AUDIT_PER_PAGE, before: q.before ?? null });
    } catch {
      data.audit = null;
    }
  }
  return data;
}

// ---- drawing ---------------------------------------------------------------------------------------------------------

/** What a panel renderer is handed. */
function viewOf(name, ctx) {
  const data = ctx?.data ?? {};
  return { page: name, data, role: ctx?.session?.role ?? null, readOnly: Boolean(ctx?.readOnly), query: ctx?.query ?? {}, env: data.env ?? {}, now: data.now };
}

/** Each panel of screen `name` as `{ id, fragment }`. */
function panelFragments(name, ctx) {
  const view = viewOf(name, ctx);
  return PAGE_PANELS[name].map(([id, render]) => ({ id, fragment: render(view) }));
}

/**
 * The panels of screen `name`, `[{ id, html }]`: the inner HTML of each `<section id="<id>" data-panel>` that
 * `renderPage` draws, from the same renderers, for the live stream to swap in. `ctx` is `renderPage`'s.
 */
export async function pagePanels(name, ctx) {
  if (!Object.hasOwn(PAGES, name)) throw new RangeError(`no such page: ${String(name)}`);
  return panelFragments(name, ctx).map(({ id, fragment }) => ({ id, html: String(fragment) }));
}

/** The signed-in header: the console's name, the screens, who is signed in, the live state and sign-out. */
function headerHtml(name, ctx) {
  const s = ctx?.session ?? {};
  return html`<header class="top"><a class="brand" href="/">pi-dispatch console</a>${navHtml(PAGES, name, s.role)}<span class="who">${s.name ?? "-"} (${s.role ?? "-"})${ctx?.readOnly ? ", read-only console" : ""}</span>${PAGES[name].live ? html`<span id="live-status" role="status" aria-live="polite"></span>` : null}<button id="logout" type="button">Sign out</button></header>`;
}

/**
 * The whole page for screen `name`: `{ status, html }`. `ctx = { query, session: { name, role }, data, readOnly }`.
 * Status 200; 404 for a run that does not exist (the panels say so); 403 for the audit log asked by a viewer (the route
 * table refuses that first; this is the belt, and it draws no panel).
 */
export async function renderPage(name, ctx) {
  if (!Object.hasOwn(PAGES, name)) throw new RangeError(`no such page: ${String(name)}`);
  const meta = PAGES[name];
  const role = ctx?.session?.role ?? null;
  const live = meta.live ? name : null;
  const query = pageQueryString(name, ctx?.query);
  if (meta.auth === "operator" && role !== "operator") {
    const body = html`${headerHtml(name, ctx)}<main><h1>${meta.title}</h1><p class="warn">This page is for operators only.</p></main>`;
    return { status: 403, html: page({ title: `pi-dispatch console: ${meta.title}`, name, body }) };
  }
  const panels = panelFragments(name, ctx);
  const heading = name === "run" && ctx?.query?.id ? html`${meta.title} <span class="mono">${ctx.query.id}</span>` : meta.title;
  // The run detail's live transcript (issue #643) is a section of its own, never a panel: a panel is what the hub
  // renders and swaps, and the transcript's entries are appended by the browser from the operator's own stream.
  const extra = name === "run" ? html`<section id="transcript" class="transcript-section">${runTranscriptSection(viewOf(name, ctx))}</section>` : null;
  const body = html`${headerHtml(name, ctx)}<main><h1>${heading}</h1>${panels.map(({ id, fragment }) => html`<section id="${id}" data-panel>${fragment}</section>`)}${extra}</main>`;
  // A run with no record yet but a live transcript or progress snapshot is a running job (its record is written at its
  // end): 200, not 404.
  const progressing = ctx?.data?.progress !== null && typeof ctx?.data?.progress === "object" && ctx.data.progress.v === 1;
  const status = name === "run" && !ctx?.data?.run?.record && ctx?.data?.transcript?.exists !== true && !progressing ? 404 : 200;
  return { status, html: page({ title: `pi-dispatch console: ${meta.title}`, name, body, live, query }) };
}
