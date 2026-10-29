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
 *      each distinct screen and data query (`dataQueryOf`: the overview's timeline query only regroups one read), and
 *      hands the result to every stream showing that screen.
 *   3. `renderPage(name, ctx)` and `pagePanels(name, ctx)` draw from that data and nothing else: pure, with `now` taken
 *      from the data, so the same data draws the same bytes. `renderPage` places each panel in
 *      `<section id="p-…" data-panel>`; `pagePanels` returns the same panels' inner HTML for the stream to swap in.
 *
 * THE ROLE RULE lives in the panels (`panels.mjs` header): the operator alone sees a failure reason and the audit log,
 * and (issue #642) the action controls, which a read-only console draws for nobody.
 * Data is read once for both roles, and the role decides only what is drawn, so a stream must be rendered per role.
 *
 * THE FRAME (issue #737) is `shell.mjs`'s: the top bar, the navigation and the title bar, around a page's panels. A page
 * whose panels are still the old markup is in `LEGACY_PAGES`, and its panels are drawn inside `<div class="legacy">`
 * (`legacyWrap`), byte for byte as before, until that page's own pull request converts it. A converted page may lay its
 * panels out in the kit's grids (`PAGE_LAYOUT`) and have a line under its title that the stream swaps
 * (`PAGE_HEADLINES`).
 */
import { loadWatchData, parseWatchQuery, watchPanel, watchBoardPanel } from "./watch.mjs";
import { readForkPoints } from "../run-fork.mjs";
import { TRANSCRIPT_ID_RE } from "../read-model.mjs";
import { ageText, beatAgeOf } from "./panels/common.mjs";
import { WORKER_NAME_RE } from "@edgehero/pi-dispatch/config";
import { BACKEND_NAMES } from "@edgehero/pi-dispatch/backends";
import { RECOVERY_CAP } from "@edgehero/pi-dispatch/recovery-queue";
import { REPLICAS_MAX } from "@edgehero/pi-dispatch/triggers";
import { FORGES } from "@edgehero/pi-dispatch/forges";
import { PROJECT_ID_RE } from "@edgehero/pi-dispatch/projects";
import { RUN_FILTER_FIELDS, parseRunFilter } from "../run-filter.mjs";
import { html, page } from "./html.mjs";
import { HEADLINE_ID, legacyWrap, NAV_PARKED_ID, navParkedHtml, shellHtml } from "./shell.mjs";
import { TIMELINE_ROWS, TIMELINE_ZOOMS } from "./timeline.mjs";
import { auditAbout, auditChain, auditFilter } from "./panels/audit.mjs";
import { AUDIT_PARAMS, auditQueryString, parseAuditQuery, readAuditView } from "./audit-view.mjs";
import { errorPage, forbiddenContent } from "./error-pages.mjs";
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
  fleetBar, fleetDelayed,
  hostState, hostJobs, hostSandboxes, hostBudget, hostCapacity, hostRow, hostDoctor,
  venueSummary, venueServes, venueHosts, venueProperties, venueFix, venueCompare,
  fleetQueues,
  fleetSchedulers,
  fleetVenues,
  INSIGHTS_DEFAULT_RANGE,
  INSIGHTS_RANGES,
  insightsPanel,
  insightsRange,
  insightsWhatIf,
  WHATIF_FLOW_RE,
  overviewActive,
  overviewCaps,
  overviewHeadline,
  overviewHosts,
  overviewNeeds,
  overviewSetup,
  overviewSetupEmpty,
  overviewSetupPi,
  overviewSpend,
  overviewTimeline,
  overviewWaiting,
  overviewWaitlists,
  parkedCheckRows,
  parkedQuestions,
  runChain, runHeadline, runRecord, runRest, runTranscriptState, runTerminal, runActionsPanel, runSandbox, runSecrets, runModels, runTail, runRecovery, runWhy, runHost, runViewer,
  runChat,
  runCostPanel,
  runInbox,
  runOutcome,
  runProgress,
  runResources,
  runSession,
  runSummary,
  runsFilters,
  runsSummary,
  runsTable,
  RUN_ID_RE,
  refusedBeforeStart,
} from "./panels.mjs";
import { chatFactsOf, parkedAnswerCheckOf, rerunCheckOf, sandboxCheckOf } from "./run-api.mjs";
import { runTranscriptSection } from "./transcript.mjs";
import { WHATIF_MODEL_RE } from "./whatif.mjs";
import { SPEND_TITLE, VENUE_LABEL, recordReason } from "../words.mjs";
import { RUN_RECORD_UNREAD, runAbsent, runPlaces } from "../read-model.mjs";

/**
 * The screens. `path` is the route, `auth` the least role that may open it, `live` whether the page opens the event
 * stream (a screen whose data changes while it is open), `title` the heading, `nav` the navigation label (none for
 * the run detail, which is reached from a run). Insights is not live: its assembly is the expensive read (cached 30 s
 * by the caller), and the range picker is its refresh; its what-if form is a GET of the same page. Configuration and
 * the audit log change by a person's hand. `icon` is the sprite icon (`pulse-icons.mjs`) its navigation pill carries
 * (issue #737); the run detail's is Runs', the screen it counts as.
 * The run detail is live since issue #644: a running job's progress panel moves, and a run that ends gets its record's
 * panels without a reload; since issue #646 its inbox panel moves too, a message's state from queued to delivered. Its
 * data is read at most once per `LIVE_DEFAULTS.pageMinMs.run` (live.mjs), since a run's load also reads its record and
 * searches for its children.
 */
export const PAGES = Object.freeze({
  overview: Object.freeze({ path: "/", auth: "viewer", live: true, title: "Overview", nav: "Overview", icon: "home" }),
  runs: Object.freeze({ path: "/runs", auth: "viewer", live: true, title: "Runs", nav: "Runs", icon: "runs" }),
  run: Object.freeze({ path: "/run", auth: "viewer", live: true, title: "Run", nav: null, icon: "runs" }),
  parked: Object.freeze({ path: "/parked", auth: "viewer", live: true, title: "Parked inbox", nav: "Parked", icon: "parked" }),
  insights: Object.freeze({ path: "/insights", auth: "viewer", live: false, title: SPEND_TITLE, nav: SPEND_TITLE, icon: "spend" }),
  fleet: Object.freeze({ path: "/fleet", auth: "viewer", live: true, title: "Fleet", nav: "Fleet", icon: "fleet" }),
  host: Object.freeze({ path: "/fleet/host", auth: "viewer", live: true, title: "Host", nav: null, icon: "fleet" }),
  venue: Object.freeze({ path: "/fleet/venue", auth: "viewer", live: false, title: VENUE_LABEL, nav: null, icon: "fleet" }),
  config: Object.freeze({ path: "/config", auth: "viewer", live: false, title: "Configuration", nav: "Configuration", icon: "config" }),
  watch: Object.freeze({ path: "/watch", auth: "viewer", live: false, title: "Watch", nav: null, icon: "bolt" }),
  "watch-board": Object.freeze({ path: "/watch/board", auth: "viewer", live: false, title: "Watch board", nav: null, icon: "bolt" }),
  audit: Object.freeze({ path: "/audit", auth: "operator", live: false, title: "Audit log", nav: "Audit", icon: "audit" }),
});

/**
 * The pages still drawn in the old markup (issue #737): every screen, the two sign-in pages and the operators-only
 * refusal (`forbidden`, which renders with its screen's `data-page`). Each wraps its content in `<div class="legacy">`,
 * the one place the compatibility stylesheet (`compat-css.mjs`) applies. A page's own pull request converts it and
 * takes its name out; `console-compat.test.mjs` fails a converted page whose golden still holds the wrapper, and, once
 * this is empty, a compatibility layer that still exists.
 *
 * WRITTEN OUT, NOT DERIVED FROM `PAGES`, so a page a later pull request adds is drawn in the Pulse markup from its
 * first day instead of joining the old markup by default. A frozen ARRAY, not a Set: `Object.freeze` keeps a Set's
 * properties fixed but not its members (`.add()` still works on one), and nothing should add a page here at run time.
 */
export const LEGACY_PAGES = Object.freeze(["insights", "config"]);

/** Each screen's panels, in page order: `[id, renderer]`. An id is `p-<panel>`, unique within its screen. */
const PAGE_PANELS = Object.freeze({
  // Issue #737: the first run's checklist (empty once the deployment runs), then what needs a person first, what waits,
  // what runs and what it costs, the timeline and the caps, then the waitlists and the hosts. Every one of the eleven is
  // on the page in both states (`panels/overview.mjs`'s header), so the stream moves a first run to the overview by
  // swapping panels; on a phone, where the layout is one column, Needs you comes first once the checklist is gone.
  overview: [["p-setup", overviewSetup], ["p-setup-pi", overviewSetupPi], ["p-setup-empty", overviewSetupEmpty], ["p-needs", overviewNeeds], ["p-waiting", overviewWaiting], ["p-active", overviewActive], ["p-spend", overviewSpend], ["p-timeline", overviewTimeline], ["p-caps", overviewCaps], ["p-waitlists", overviewWaitlists], ["p-hosts", overviewHosts]],
  runs: [["p-filters", runsFilters], ["p-summary", runsSummary], ["p-runs", runsTable]],
  run: [["p-viewer", runViewer], ["p-outcome", runOutcome], ["p-progress", runProgress], ["p-recovery", runRecovery], ["p-transcript", runTranscriptState], ["p-record", runRecord], ["p-rest", runRest], ["p-chat", runChat], ["p-terminal", runTerminal], ["p-inbox", runInbox], ["p-run", runSummary], ["p-sandbox", runSandbox], ["p-secrets", runSecrets], ["p-actions", runActionsPanel], ["p-why", runWhy], ["p-host", runHost], ["p-cost", runCostPanel], ["p-models", runModels], ["p-resources", runResources], ["p-session", runSession], ["p-chain", runChain], ["p-tail", runTail]],
  parked: [["p-questions", parkedQuestions]],
  insights: [["p-range", insightsRange], ["p-whatif", insightsWhatIf], ["p-insights", insightsPanel]],
  fleet: [["p-fleetbar", fleetBar], ["p-queues", fleetQueues], ["p-active", fleetActive], ["p-held", fleetHeld], ["p-failed", fleetFailed], ["p-delayed", fleetDelayed], ["p-schedules", fleetSchedulers], ["p-hosts", fleetHosts], ["p-doctor", fleetDoctor], ["p-venues", fleetVenues]],
  host: [["p-hoststate", hostState], ["p-hostjobs", hostJobs], ["p-hostsandboxes", hostSandboxes], ["p-hostbudget", hostBudget], ["p-hostcap", hostCapacity], ["p-hostrow", hostRow], ["p-hostdoctor", hostDoctor]],
  venue: [["p-venue", venueSummary], ["p-venue-serves", venueServes], ["p-venue-hosts", venueHosts], ["p-venue-props", venueProperties], ["p-venue-fix", venueFix], ["p-venue-compare", venueCompare]],
  config: [["p-triggers", configTriggers], ["p-settings", configSettings], ["p-pause-windows", configPauseWindows], ["p-scoped-limits", configScopedLimits], ["p-projects", configProjects], ["p-mcp", configMcp], ["p-packages", configPackages], ["p-secret-profiles", configSecretProfiles], ["p-secret-bundles", configSecretBundles]],
  watch: [["p-watch", watchPanel]],
  "watch-board": [["p-watch-board", watchBoardPanel]],
  audit: [["p-audit-chain", auditChain], ["p-audit-filter", auditFilter], ["p-audit", auditLog], ["p-audit-about", auditAbout]],
});

/**
 * Each screen's line under its title (issue #737), a renderer like a panel's: the shell draws it as its headline panel
 * (`shell.mjs` `HEADLINE_ID`), and the stream swaps it like any panel, since what it says changes while the page is
 * open ("All clear. 4 jobs running, nothing needs you."). A screen with none draws no line.
 */
function hostHeadline(view) {
  const host = view.data?.host ?? view.data?.snapshot?.hostBudgets?.find((h) => h.name === view.query?.name);
  if (!host) return html`No live registry row for ${view.query?.name ?? "this host"}.`;
  const venues = host.backends?.blessed ?? [];
  const jobs = host.jobs;
  const readable = Array.isArray(jobs) && !host.jobsUnreadable;
  const moreKnown = Number.isSafeInteger(host.jobsMore) && host.jobsMore >= 0;
  const used = readable && moreKnown ? jobs.length + host.jobsMore : null;
  const occupied = used !== null ? `${used} of ${host.concurrency ?? "unknown"} slots taken` : readable && jobs.length > 0 ? `at least ${jobs.length} occupied ${jobs.length === 1 ? "slot" : "slots"} listed; total not known` : "occupied slots not known";
  const beat = beatAgeOf(host);
  return html`${venues.length ? venues.map((name) => `${name}${host.backends.default === name ? " (default)" : ""}`).join(", ") : "Venues not published"} · worker ${host.version ?? "not published"} · ${occupied} · last beat ${beat === null ? "not known" : `${ageText(beat)} ago`}`;
}

const PAGE_HEADLINES = Object.freeze({ overview: overviewHeadline, run: runHeadline, host: hostHeadline });

/**
 * How a screen's panels are laid out (issue #737), for a screen whose cards stand in a grid rather than one under
 * another: a list of wrappers, each `{ cls, items, slotAfter }`, an item a panel id or a wrapper inside it. `cls` is the
 * bundle's layout class (`cols`, two columns, the second the side column; `stack`, a column of cards; `cards-4`, four
 * cards in a row). `slotAfter` marks a wrapper that is a GRID of cards: the script puts the confirm slot after the
 * wrapper rather than after the card whose form opened it, since a slot inside the grid would take one of its cells
 * (`data-slot-after`, `script.mjs` `slotAnchor`). A `stack` is no such grid: there the slot stays under its card.
 *
 * A screen without a layout draws its panels one under another in `PAGE_PANELS`' order. A layout names every panel of
 * its screen exactly once (checked as this module loads), so no panel is drawn twice or lost.
 */
const PAGE_LAYOUT = Object.freeze({
  fleet: [{ cls: "stack", items: ["p-fleetbar"] }, { cls: "cols", items: [{ cls: "stack", items: ["p-queues", "p-active", "p-held", "p-failed", "p-delayed", "p-schedules"] }, { cls: "stack", items: ["p-hosts", "p-doctor", "p-venues"] }] }],
  host: [{ cls: "stack", items: ["p-hoststate"] }, { cls: "cols", items: [{ cls: "stack", items: ["p-hostjobs", "p-hostsandboxes", "p-hostbudget", "p-hostcap"] }, { cls: "stack", items: ["p-hostrow", "p-hostdoctor"] }] }],
  venue: [{ cls: "cols", items: [{ cls: "stack", items: ["p-venue-serves", "p-venue-props", "p-venue-compare"] }, { cls: "stack", items: ["p-venue", "p-venue-hosts", "p-venue-fix"] }] }],
  run: [{ cls: "stack", items: ["p-viewer"] }, { cls: "cols", items: [{ cls: "stack run-main", items: ["p-outcome", "p-progress", "p-recovery", "p-transcript", "p-record", "p-rest", "p-sandbox", "p-secrets", "p-actions", "p-why", "p-host"] }, { cls: "stack run-side", items: ["p-chat", "p-terminal", "p-inbox", "p-run", "p-cost", "p-models", "p-resources", "p-session", "p-chain", "p-tail"] }] }],
  overview: Object.freeze([
    Object.freeze({ cls: "cols", items: Object.freeze(["p-setup", Object.freeze({ cls: "stack", items: Object.freeze(["p-setup-pi", "p-setup-empty"]) })]) }),
    Object.freeze({ cls: "cards-4", slotAfter: true, items: Object.freeze(["p-needs", "p-waiting", "p-active", "p-spend"]) }),
    Object.freeze({ cls: "cols", items: Object.freeze([Object.freeze({ cls: "stack", items: Object.freeze(["p-timeline", "p-caps"]) }), Object.freeze({ cls: "stack", items: Object.freeze(["p-waitlists", "p-hosts"]) })]) }),
  ]),
});

/** The panel ids a layout places, in the order it draws them. */
const layoutIds = (items) => items.flatMap((it) => (typeof it === "string" ? [it] : layoutIds(it.items)));

for (const [name, layout] of Object.entries(PAGE_LAYOUT)) {
  const placed = layoutIds(layout);
  const own = PAGE_PANELS[name].map(([id]) => id);
  if (placed.length !== own.length || own.some((id) => !placed.includes(id))) throw new Error(`pages: the ${name} layout places ${placed.join(", ")}, not its panels ${own.join(", ")}`);
}

/**
 * The panel ids of a screen, in page order (for the stream's tests and the hub), then on a live screen the shell's
 * panels (issue #737): the Parked count, which sits in the navigation above them, and the headline, under the title,
 * listed last (`SHELL_PANEL_IDS`' order) so a screen's first panel is still its first.
 */
export function panelIds(name) {
  const ids = (PAGE_PANELS[name] ?? []).map(([id]) => id);
  if (PAGES[name]?.live !== true) return ids;
  return Object.hasOwn(PAGE_HEADLINES, name) ? [...ids, NAV_PARKED_ID, HEADLINE_ID] : [...ids, NAV_PARKED_ID];
}

// ---- the query -------------------------------------------------------------------------------------------------------

/** The parameters each screen takes; any other refuses the request. */
const PAGE_PARAMS = Object.freeze({
  overview: ["rows", "zoom", "project"],
  runs: [...RUN_FILTER_FIELDS, "before"],
  run: ["id"],
  parked: [],
  insights: ["range", "whatif", "flow", "paths"],
  fleet: [],
  host: ["name"],
  venue: ["name"],
  config: [],
  watch: ["rule"],
  "watch-board": ["rule", "finding"],
  audit: [...AUDIT_PARAMS],
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
 *   - overview (issue #737): the timeline's grouping, `rows`, one of `TIMELINE_ROWS`; its window, `zoom`, a key of
 *     `TIMELINE_ZOOMS`; and its project filter, `project`, a project id (`PROJECT_ID_RE`); `{ rows, zoom, project }`,
 *     each absent one null (the timeline's default). Closed values, so the timeline is never handed one it refuses.
 *   - audit: `before` (an audit position, `YYYY-MM:<line>`, `readConsoleAudit`'s cursor), `who`, `action`, `outcome`,
 *     `q` and `seq` (not with `before`), each judged by `audit-view.mjs` `parseAuditQuery`; `{ before, who, action,
 *     outcome, q, seq }`, each absent one null.
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
    case "host":
    case "venue": {
      const value = one("name");
      if (value === null) return { refusal: `the ${name} page needs ?name=` };
      if (name === "host" && !WORKER_NAME_RE.test(value)) return { refusal: "name must be a worker name (letters, digits, '.', '_', '-', at most 64 characters)" };
      if (name === "venue" && !BACKEND_NAMES.includes(value)) return { refusal: `name must be one of ${BACKEND_NAMES.join(", ")}` };
      return { query: Object.freeze({ name: value }) };
    }
    case "watch":
    case "watch-board": return parseWatchQuery(params, { board: name === "watch-board" });
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
    case "overview": {
      // Issue #737: the timeline's three, each a closed value. The refusal names the parameter and what it takes, never
      // what was sent.
      const rows = one("rows");
      if (rows !== null && !TIMELINE_ROWS.includes(rows)) return { refusal: `rows must be one of ${TIMELINE_ROWS.join(", ")}` };
      const zoom = one("zoom");
      if (zoom !== null && !Object.hasOwn(TIMELINE_ZOOMS, zoom)) return { refusal: `zoom must be one of ${Object.keys(TIMELINE_ZOOMS).join(", ")}` };
      const project = one("project");
      if (project !== null && !PROJECT_ID_RE.test(project)) return { refusal: "project must be a project id (lowercase letters, digits and '-', at most 32 characters)" };
      return { query: Object.freeze({ rows, zoom, project }) };
    }
    case "audit":
      // Issue #737: the audit page's own parser (audit-view.mjs) judges every parameter, the cursor exactly as
      // `readConsoleAudit` takes it, so a refused cursor or filter never reaches a read.
      return parseAuditQuery(params);
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
  if (name === "watch" || name === "watch-board") {
    for (const k of ["rule", "finding"]) if (q[k]) p.set(k, q[k]);
  } else if (name === "runs") {
    for (const k of RUN_FILTER_FIELDS) if (q.filter?.[k] !== undefined) p.set(k, q.filter[k]);
    if (q.before !== null && q.before !== undefined) p.set("before", String(q.before));
  } else if ((name === "host" || name === "venue") && q.name) p.set("name", q.name);
  else if (name === "run" && q.id) p.set("id", q.id);
  else if (name === "insights") {
    for (const k of ["range", "whatif", "flow", "paths"]) if (typeof q[k] === "string" && q[k] !== "") p.set(k, q[k]);
  }
  else if (name === "audit") return auditQueryString(q);
  else if (name === "overview") {
    for (const k of ["rows", "zoom", "project"]) if (typeof q[k] === "string" && q[k] !== "") p.set(k, q[k]);
  }
  return p.toString();
}

/**
 * The query screen `name`'s DATA is read with (issue #737), for the live hub, which reads each screen once per tick
 * for each distinct data query (`live.mjs` `dataQueryOf`) and draws each stream with its own whole query. The
 * overview's query only chooses how the same snapshot is drawn (the timeline's grouping, window and project), so its
 * data query is `{}`: one read per tick however many groupings are open, where its whole query would read the snapshot
 * once for each. Every other screen reads what its query names, so its data query is its query.
 */
export function dataQueryOf(name, query) {
  return name === "overview" ? Object.freeze({}) : query;
}

// ---- where a sign-in lands ------------------------------------------------------------------------------------------

/** The longest return path accepted: a page path and a query within `QUERY_LIMITS`, with room to spare. */
export const RETURN_PATH_MAX = 1024;

/**
 * The page a one-time sign-in link returns to (issue #708: `login/code#<code>&next=/runs`), or null for anything that
 * is not one of THIS console's own pages. The `next` value arrives from a link anyone could have written, so it is an
 * open redirect unless it is held to the console's own pages: a string of at most `RETURN_PATH_MAX` characters,
 * starting with exactly one `/` (`//evil` is a scheme-relative URL to another host), no backslash (a browser reads
 * `/\evil` as `//evil`), no control byte, no fragment, that parses to this origin, whose path is a `PAGES` path, and
 * whose query passes that page's own `parsePageQuery`. `/login` and `/login/code` are not pages, so a link cannot loop
 * back into sign-in. Returns the path and query as given (`/run?id=a.b`), since the page parser accepted them.
 */
export function returnPathOf(raw) {
  if (typeof raw !== "string" || raw === "" || raw.length > RETURN_PATH_MAX) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.includes("#") || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  let url;
  try {
    url = new URL(raw, "http://console.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://console.invalid") return null;
  const name = Object.keys(PAGES).find((k) => PAGES[k].path === url.pathname);
  if (name === undefined) return null;
  const parsed = parsePageQuery(name, url.searchParams);
  if (!parsed || parsed.refusal || !("query" in parsed)) return null;
  return `${url.pathname}${url.search}`;
}

// ---- reading ---------------------------------------------------------------------------------------------------------

/**
 * What each screen reads beside the clock. A screen that reads no snapshot reads `parkedCount` for the navigation's
 * Parked count (issue #737); one that reads the snapshot takes the count from it, so no screen reads both.
 *
 * `waiting` (issue #737) asks the same snapshot for the waiting jobs and why each waits (`snapshot({ waiting: true })`),
 * which only the overview draws. It is the page's to ask, not the reader's: one reader serves every screen and
 * `/api/state`, and a reader built to read them would make every other screen pay for a read it never draws.
 */
const PAGE_READS = Object.freeze({
  overview: ["snapshot", "waiting"],
  runs: ["runsPage", "subscriptions", "runsWindow", "parkedCount"],
  run: ["run", "subscriptions", "transcriptMeta", "progress", "inbox", "chat", "actions", "parkedCount"],
  parked: ["snapshot", "parkedChecks"],
  insights: ["insights", "parkedCount"],
  fleet: ["snapshot", "waiting"],
  host: ["snapshot", "waiting", "hostCapacity"],
  venue: ["snapshot"],
  config: ["snapshot"],
  watch: ["parkedCount"],
  "watch-board": ["parkedCount"],
  audit: ["audit", "parkedCount"],
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
 * The navigation's Parked count for a screen that reads no snapshot (issue #737): the fleet reader's `parkedCount`, a
 * whole number of unanswered parked runs, or null when the reader has none, it throws, or it answers anything else
 * (the shell then draws no count, never a 0).
 */
async function parkedCountOf(deps) {
  if (typeof deps.fleet?.parkedCount !== "function") return null;
  try {
    const n = await deps.fleet.parkedCount();
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
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
    for (const r of pageRead.runs) if (r?.parentJobId === record.jobId) children.push({ jobId: r.jobId ?? null, outcome: r.outcome ?? null, reason: recordReason(r), startedAt: r.startedAt ?? null });
    if (pageRead.next === null || pageRead.next === undefined || (Number.isFinite(startMs) && pageRead.next <= startMs)) break;
    before = pageRead.next;
  }
  children.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || String(a.jobId).localeCompare(String(b.jobId)));
  return { children, searched };
}

/**
 * Whether a load's page can draw an answer form (issue #737, the Parked page's planner checks): a console that takes
 * changes (`readOnly` not true), seen by an operator or by a session the load does not name. A `who` without a role (a
 * caller that does not say) reads as one an operator may see, so the checks are read rather than silently left out.
 */
function formsDrawn(who) {
  if (who?.readOnly === true) return false;
  return who?.role === undefined || who?.role === null || who.role === "operator";
}

/**
 * Read what screen `name` shows for `query` (a `parsePageQuery` result's `query`). `deps`:
 *
 *   - `fleet`: a `createFleetReader` instance (`snapshot`, `runsPage`, `runById`, and `parkedCount` for the screens that
 *     read no snapshot). `snapshot()` is called at most once, asked for the waiting jobs only by a screen that draws
 *     them (`PAGE_READS`' `waiting`).
 *   - `insights(window, { fullPaths })`: the assembled insights payload for a window (the caller caches it: it is the
 *     expensive read). `fullPaths` is true only for an operator's `paths=full`.
 *   - `whatIf({ model, flow })` (optional): the what-if answer (`whatif.mjs`'s reader, cached and bounded by the caller).
 *   - `pricedModels()` (optional): the priced catalog's `provider/id` strings, for the what-if form's suggestions.
 *   - `audit({ limit, before })`: `readConsoleAudit` bound to the deployment's logs directory.
 *   - `subscriptions()` (optional): the subscriptions file's entries, for the cost class of a plan-covered run.
 *   - `env`: the deployment's env, of which only the forge instance variables are kept (`forgeEnvOf`).
 *   - `now`: the clock (a function or a number), read ONCE; every panel draws from this instant.
 *   - `deployment` (optional, issue #737): `{ folder }`, the deployment directory's last folder, kept as `data.deployment`.
 *
 * `who` is who will see the page (`{ role, readOnly, live }`, `readOnly` the console's own): the spend screen's
 * `paths=full` reads full paths for an operator's request alone, so a viewer's page data never holds them, and the
 * Parked page reads its planner checks only where a form can be drawn (`formsDrawn`). The server passes the request's
 * role; the live hub (`live.mjs`) passes `{ readOnly, live: true }`, with `role: "viewer"` for a load no operator's
 * stream shows, and never an operator's role, since one load serves every role watching it (insights, which reads full
 * paths, is not live).
 *
 * A KEYSPACE SCAN FOR AN ABSENCE IS A REQUEST'S, NEVER THE LIVE HUB'S (issue #737). The by-id lookups of one load (the
 * chat facts, the re-run check, the parked answer checks: the run and Parked pages) ask one question: a request's
 * (`fleet.lookupQuestion`, read once here) costs at most one keyspace scan however many of them miss, and they run
 * together, so a load waits for that scan once; a live load's (`who.live`) costs none, and keeps what the request was
 * told of an absence (the reader's `lookUp`).
 *
 * Never throws for a read that fails: the field is null (or carries a sentence), and the panel says so.
 */
export async function loadPageData(name, query, deps = {}, who = {}) {
  if (!Object.hasOwn(PAGES, name)) throw new RangeError(`no such page: ${String(name)}`);
  const now = typeof deps.now === "function" ? deps.now() : Number.isFinite(deps.now) ? deps.now : Date.now();
  const q = query ?? {};
  // Issue #737: the deployment the console serves, by its folder's last part (`cli.mjs`'s `pageDeps.deployment`), for
  // the first run's checklist; null where the caller passes none.
  const data = { page: name, now, env: forgeEnvOf(deps.env), deployment: deps.deployment ?? null };
  if (name === "watch" || name === "watch-board") data.watch = await loadWatchData(deps.watch, q, { board: name === "watch-board", privateRead: who?.role === "operator" && who?.live !== true });
  const reads = PAGE_READS[name];
  // The by-id lookups' one question for this load (see above): the hub's, or this request's, read before any of them.
  const lookup = who?.live === true ? { live: true } : typeof deps.fleet?.lookupQuestion === "function" ? deps.fleet.lookupQuestion() : {};
  if (name === "run" && typeof deps.env?.PI_CHAIN_MAX_PER_JOB === "string" && /^\d{1,9}$/.test(deps.env.PI_CHAIN_MAX_PER_JOB)) data.chainMaxPerJob = Number(deps.env.PI_CHAIN_MAX_PER_JOB);
  if (reads.includes("snapshot")) {
    try {
      data.snapshot = await (reads.includes("waiting") ? deps.fleet.snapshot({ waiting: true }) : deps.fleet.snapshot());
    } catch {
      data.snapshot = null;
      // Issue #737: the page's primary read failed, so the hub may keep the last good panels and say `stale`.
      data.readFailed = true;
    }
  }
  if (name === "fleet") {
    try {
      const plan = typeof deps.killSwitchPlan === "function" ? deps.killSwitchPlan({ paused: false }) : null;
      data.killSwitch = plan ? { disagreement: plan.disagreement ?? null, refused: plan.refused ?? null, resumeCommand: plan.resumeCommand ?? null, resumeArgv: Array.isArray(plan.resumeArgv) ? [...plan.resumeArgv] : null } : null;
    } catch { data.killSwitch = { refused: "The deployment's kill switch could not be read." }; }
  }
  if (name === "host") {
    data.host = data.snapshot?.hostBudgets?.find((host) => host.name === q.name) ?? null;
    try { const history = await deps.fleet.runsPage({ filter: { host: q.name }, limit: RUNS_PER_PAGE }); data.hostHistory = { ...history, records: history?.runs ?? [] }; } catch { data.hostHistory = null; }
    // Capacity is an expensive historical fold. A live replacement deliberately omits its panel, keeping the initial chart.
    if (who?.live !== true) {
      try { data.hostCapacity = typeof deps.hostCapacity === "function" ? await deps.hostCapacity(q.name) : null; } catch { data.hostCapacity = null; }
    } else data.live = true;
  }
  if (reads.includes("subscriptions")) data.subscriptions = await subscriptionsOf(deps);
  if (reads.includes("runsPage")) {
    try {
      data.runsPage = await deps.fleet.runsPage({ before: q.before ?? null, limit: RUNS_PER_PAGE, filter: q.filter ?? null });
    } catch {
      data.runsPage = null;
      data.readFailed = true;
    }
  }
  if (reads.includes("runsWindow")) {
    try {
      data.runsWindow = (await deps.fleet.runsWindow?.()) ?? null;
    } catch {
      data.runsWindow = null;
    }
  }
  if (reads.includes("run")) {
    try {
      data.run = await deps.fleet.runById(q.id);
    } catch {
      data.run = { unreadable: RUN_RECORD_UNREAD };
      data.readFailed = true;
    }
    if (data.run?.record) Object.assign(data, await childrenOf(deps.fleet, data.run.record).then(({ children, searched }) => ({ children, childrenSearched: searched })));
  }
  if (reads.includes("transcriptMeta") && typeof deps.fleet?.transcriptMeta === "function") {
    // Issue #643: whether the run has a live transcript stream, without a byte of its text (the stream's text goes to an
    // operator's page entry events or `/api/transcript`, never a panel). Read for both roles, as all page data is; only an operator's page uses it.
    // Only a read's own answer (`exists` true or false) says whether a stream exists: anything else, an answer that is
    // not one included, is a stream that could not be read, never "none".
    try {
      const meta = await deps.fleet.transcriptMeta(q.id);
      const read = meta !== null && typeof meta === "object" && !meta.unreachable && !meta.invalid && typeof meta.exists === "boolean";
      data.transcript = read ? { exists: meta.exists, ended: meta.ended === true, outcome: typeof meta.outcome === "string" ? meta.outcome : null, length: Number.isSafeInteger(meta.length) ? meta.length : 0, lastId: typeof meta.lastId === "string" && TRANSCRIPT_ID_RE.test(meta.lastId) ? meta.lastId : null } : { unreachable: true, exists: false };
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
  if (name === "run" && !data.run?.record && typeof deps.fleet?.runLiveFacts === "function") {
    try { data.activeRun = await deps.fleet.runLiveFacts(q.id, lookup); } catch { data.activeRun = null; }
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
  // The chat facts with their answer check, and the actions' checks, run together (see above).
  const chatRead = async () => {
    // Issue #647: the chat this run can have (`chatFactsOf`: the job's queue state, its active recovery, and for a parked
    // record whether a later run took the answer), for the Chat panel. Null without a job-state reader. The newer-run
    // search is a runs-page read, so the live loop pays it only for a parked record, whose mode depends on it.
    try {
      data.chat = await chatFactsOf(deps.fleet, q.id, data.run?.record ?? null, { searchNewer: "saved", now: () => now, lookup });
    } catch {
      data.chat = { unreachable: true };
    }
    // A reply the Chat panel offers is one the planner would plan (issue #647): the planner's own predicate over the
    // parked run's retained job and the triggers file (`parkedAnswerCheck`, a sentence or ok, never the job's data),
    // reused for PARK_CHECK_CACHE_MS per run id (`parkedAnswerCheckOf`), so the 2 s loop does not read it every tick.
    if (data.chat?.mode === "reply" && typeof deps.fleet?.parkedAnswerCheck === "function") {
      data.chatAnswer = await parkedAnswerCheckOf(deps.fleet, q.id, data.run?.record ?? null, { now: () => now, lookup });
    }
  };
  const actionsRead = async () => {
    // Issue #710: whether the run's two actions can work, so the page offers only those (REQ-OPERATOR-CONSOLE-ACTIONS):
    // the planner's cheap re-run refusals over the retained job's data (`rerunCheck`) and the panel's sandbox manifest
    // verdict for a run of this host (`sandboxCheck`), each reused for PARK_CHECK_CACHE_MS per run id, so the live loop
    // does not read them every tick. Read for both roles, as all page data is; only an operator's page draws the actions.
    // A run refused before it started has no workspace, whatever a manifest says, so its sandbox check is not read.
    const record = data.run.record;
    const forkPoints = await readForkPoints({ jobId: q.id, env: deps.env ?? {}, now: () => now });
    data.forkPoints = forkPoints.ok ? { ok: true, entries: forkPoints.entries } : { refusal: forkPoints.refusal };
    data.rerunCheck = await rerunCheckOf(deps.fleet, q.id, record, { now: () => now, lookup });
    if (!refusedBeforeStart(record)) data.sandboxCheck = await sandboxCheckOf(deps.fleet, q.id, record, { now: () => now });
  };
  await Promise.all([reads.includes("chat") ? chatRead() : null, reads.includes("actions") && data.run?.record ? actionsRead() : null]);
  if (name === "run" && data.run?.record) {
    const record = data.run.record;
    // These lookups are bounded by the worker's own replica/recovery caps, never a history scan. A related record
    // remains PII-free; no retained queue payload is passed to a renderer.
    const siblings = [];
    if (Number.isInteger(record.replica) && Number.isInteger(record.replicas) && record.replicas <= REPLICAS_MAX && record.replicas >= 2) {
      const stem = String(record.recoveryOf ?? record.jobId ?? "").replace(/-r[1-3](?=\.r[1-2]$|$)/, "-r");
      for (let i = 1; i <= record.replicas; i += 1) {
        if (i === record.replica) continue;
        const id = stem.replace(/-r(?=\.r[1-2]$|$)/, `-r${i}`);
        if (id !== record.jobId && RUN_ID_RE.test(id)) siblings.push(id);
      }
    }
    const related = async (id) => { try { return (await deps.fleet.runById(id))?.record ?? null; } catch { return null; } };
    const base = typeof record.recoveryOf === "string" && RUN_ID_RE.test(record.recoveryOf) ? record.recoveryOf : q.id;
    const recoveryIds = record.checkpoints || record.recovered || record.recoverSkipped || String(record.reason ?? "").startsWith("recovery-")
      ? [base, ...Array.from({ length: RECOVERY_CAP }, (_, i) => `${base}.r${i + 1}`)].filter((id) => id !== q.id && RUN_ID_RE.test(id)) : [];
    const [siblingRecords, recoveryRecords, trigger, holds] = await Promise.all([
      Promise.all(siblings.map(related)), Promise.all(recoveryIds.map(related)),
      typeof deps.fleet.runTrigger === "function" ? Promise.resolve().then(() => deps.fleet.runTrigger(record.triggerIndex, record.triggerType)).catch(() => null) : null,
      recoveryIds.length && typeof deps.fleet.runHolds === "function" ? deps.fleet.runHolds(q.id, record).catch(() => null) : null,
    ]);
    data.siblings = siblingRecords.filter(Boolean);
    data.recoveryRuns = [record, ...recoveryRecords.filter(Boolean)].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    data.trigger = trigger;
    data.runHolds = holds;
    const continuation = data.chat?.activeJobId ?? data.chat?.queuedJobId;
    if (continuation && continuation !== q.id && RUN_ID_RE.test(continuation)) {
      try { data.recoveryLive = await deps.fleet.runLiveFacts?.(continuation, lookup) ?? null; } catch { data.recoveryLive = null; }
      try { data.recoveryProgress = await deps.fleet.progressOfRun?.(continuation, recoveryRecords.find((r) => r?.jobId === continuation) ?? null) ?? null; } catch { data.recoveryProgress = null; }
    }
    if (refusedBeforeStart(record)) {
      try { data.snapshot = await deps.fleet.snapshot(); } catch { data.snapshot = null; }
      try { data.runsWindow = await deps.fleet.runsWindow?.() ?? null; } catch { data.runsWindow = null; }
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
      data.audit = await readAuditView({ read: (a) => deps.audit({ ...a, positions: true }), verify: deps.auditVerify, query: q, perPage: AUDIT_PER_PAGE });
    } catch {
      data.audit = null;
    }
  }
  if (reads.includes("parkedChecks") && data.snapshot && formsDrawn(who)) {
    // Issue #737: whether each parked run that could take an answer can take one here, the planner's own check
    // (`parkedAnswerCheckOf`, reused per run for PARK_CHECK_CACHE_MS, an unreadable answer as long as a good one), for
    // the rows `parkedCheckRows` names. Not for a load no form is drawn from (a viewer's, a read-only console's): the
    // panel draws a form for an operator on a console that takes changes alone.
    const rows = parkedCheckRows(data.snapshot);
    const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
    const got = await Promise.all(rows.map((p) => parkedAnswerCheckOf(deps.fleet, p.jobId, { jobId: p.jobId, endedAt: isoOf(p.parkedAt), target: p.target }, { now: () => now, lookup })));
    data.parkedChecks = Object.fromEntries(rows.map((p, i) => [p.jobId, got[i]]));
  }
  if (reads.includes("parkedCount")) data.parkedCount = await parkedCountOf(deps);
  return data;
}

// ---- drawing ---------------------------------------------------------------------------------------------------------

/**
 * What a panel renderer is handed. `pages` is `PAGES` (issue #737), the table a panel links by name (`kit.mjs`
 * `pageHref`), handed down because a panel module cannot import this one, which imports it. The session is reduced to
 * its role: no panel is handed the token's name.
 */
function viewOf(name, ctx) {
  const data = ctx?.data ?? {};
  return { page: name, data, role: ctx?.session?.role ?? null, readOnly: Boolean(ctx?.readOnly), query: ctx?.query ?? {}, env: data.env ?? {}, now: data.now, pages: PAGES };
}

/** The viewer card's fixed visible panels. The other ids remain empty for live state swaps. */
export const RUN_VIEWER_PANELS = Object.freeze(["p-viewer", "p-outcome", "p-progress", "p-transcript", "p-chat", "p-inbox", "p-run"]);

/** Each panel of screen `name` as `{ id, fragment }`, with the role split enforced before rendering. */
function panelFragments(name, ctx) {
  const view = viewOf(name, ctx);
  return PAGE_PANELS[name].filter(([id]) => !(name === "host" && ctx?.data?.live === true && id === "p-hostcap")).map(([id, render]) => ({ id, fragment: name === "run" && view.role !== "operator" && !RUN_VIEWER_PANELS.includes(id) ? html`` : render(view) }));
}

/**
 * The panels of screen `name`, `[{ id, html }]`: the inner HTML of each `<section id="<id>" data-panel>` that
 * `renderPage` draws, from the same renderers, for the live stream to swap in, and on a live screen last the shell's
 * spans: `<span id="p-nav-parked" data-panel>`, then the screen's headline `<span id="p-headline" data-panel>` where it
 * has one (`panelIds`' order). `ctx` is `renderPage`'s.
 */
export async function pagePanels(name, ctx) {
  if (!Object.hasOwn(PAGES, name)) throw new RangeError(`no such page: ${String(name)}`);
  const panels = panelFragments(name, ctx).map(({ id, fragment }) => ({ id, html: String(fragment) }));
  if (!PAGES[name].live) return panels;
  const headline = headlineOf(name, ctx);
  return [...panels, { id: NAV_PARKED_ID, html: String(navParkedHtml(ctx?.data)) }, ...(headline === null ? [] : [{ id: HEADLINE_ID, html: String(headline) }])];
}

/** Screen `name`'s headline (`PAGE_HEADLINES`), or null for a screen with none. */
function headlineOf(name, ctx) {
  return Object.hasOwn(PAGE_HEADLINES, name) ? PAGE_HEADLINES[name](viewOf(name, ctx)) : null;
}

/** A parked question leads the main column, with the same one panel id used in every state. */
function runLayoutOf(data) {
  const layout = PAGE_LAYOUT.run;
  if (data?.chat?.mode !== "reply") return layout;
  const columns = layout[1];
  return [layout[0], { ...columns, items: columns.items.map((column, i) => ({ ...column, items: i === 0 ? ["p-chat", ...column.items] : column.items.filter((id) => id !== "p-chat") })) }];
}

/** A layout's markup (`PAGE_LAYOUT`): its wrappers in order, each panel's section where the layout names it. */
function layoutHtml(items, sections) {
  return html`${items.map((it) => (typeof it === "string" ? sections.get(it) : html`<div class="${it.cls}"${it.slotAfter ? html` data-slot-after` : null}>${layoutHtml(it.items, sections)}</div>`))}`;
}

/**
 * What each place a run is kept answered of a run page's id (issue #737), as `runPlaces` and `runAbsent` take them (the
 * rule `/api/run` keeps too): the history (this host's file and the fleet's run mirror), the queue lookup's whole answer
 * (the job, or its run's active or queued recovery, over every queue the kill switch flips), the live transcript and the
 * progress key. A load whose primary read failed (`readFailed`) and holds no record could not read one, whatever else
 * `run` says.
 */
function runPlacesOf(data) {
  const run = data?.readFailed === true && !data?.run?.record ? { unreadable: RUN_RECORD_UNREAD } : data?.run;
  return { run, lookup: data?.chat, transcript: data?.transcript, progress: data?.progress };
}

/**
 * The whole page for screen `name`: `{ status, html }`. `ctx = { query, session: { name, role }, data, readOnly,
 * theme }`, `theme` the request's theme choice (`theme.mjs` `themeOf`). Status 200, but: for a run id no place shows a
 * run for, with every place read and saying it holds none (`runAbsent`), the run-not-found page, 404; for one no place
 * shows a run for while a place could not be read, the run page, 503, its outcome banner saying which could not be read;
 * and 403 for the audit log asked by a viewer (the route table refuses that first; this is the belt, and it draws no
 * panel). A run page some place shows a run for is 200, a queued job's included.
 */
export async function renderPage(name, ctx) {
  if (!Object.hasOwn(PAGES, name)) throw new RangeError(`no such page: ${String(name)}`);
  const meta = PAGES[name];
  const role = ctx?.session?.role ?? null;
  const live = meta.live ? name : null;
  const query = pageQueryString(name, ctx?.query);
  const theme = ctx?.theme ?? null;
  if (meta.auth === "operator" && role !== "operator") {
    const body = shellHtml(name, ctx, forbiddenContent());
    return { status: 403, html: page({ title: `pi-dispatch console: ${meta.title}`, name, body, theme }) };
  }
  const places = name === "run" ? runPlacesOf(ctx?.data) : null;
  if (places !== null && runAbsent(places)) {
    return errorPage({ kind: "no-run", status: 404, session: ctx?.session ?? null, readOnly: Boolean(ctx?.readOnly), theme, runId: typeof ctx?.query?.id === "string" ? ctx.query.id : null });
  }
  const panels = panelFragments(name, ctx);
  // The run detail's live transcript (issue #643) is a section of its own, never a panel: a panel is what the hub
  // renders and swaps, and the transcript's entries are appended by the browser from the operator's own stream.
  // Issue #710: none for a run that never had one to show: refused before it started, or no record of a run that is not
  // running (not a run id, queued, or unknown), which the outcome banner says once.
  const extra = name === "run" && !ctx?.data?.run?.invalid ? html`<div id="transcript" class="run-transcript">${runTranscriptSection(viewOf(name, ctx))}</div>` : null;
  const sections = new Map(panels.map(({ id, fragment }) => [id, legacyWrap(name, html`<section id="${id}" data-panel>${fragment}</section>`)]));
  if (name === "run" && extra !== null) sections.set("p-transcript", html`${sections.get("p-transcript")}${extra}`);
  const inner = Object.hasOwn(PAGE_LAYOUT, name) ? layoutHtml(name === "run" ? runLayoutOf(ctx?.data) : PAGE_LAYOUT[name], sections) : html`${[...sections.values()]}`;
  const headline = headlineOf(name, ctx);
  const body = shellHtml(name, ctx, html`${inner}`, headline === null ? {} : { headline });
  // A run no place shows while one could not be read is a run page that cannot say whether the run exists: 503.
  const status = places !== null && !runPlaces(places).shown ? 503 : 200;
  return { status, html: page({ title: `pi-dispatch console: ${["host", "venue"].includes(name) ? ctx?.query?.name ?? meta.title : meta.title}`, name, body, live, query, theme }) };
}
