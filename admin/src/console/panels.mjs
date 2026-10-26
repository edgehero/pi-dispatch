/**
 * The console's panels (issue #641, REQ-OPERATOR-CONSOLE-SCREENS): one pure renderer per region of a screen, each
 * `(view) -> SafeHtml` where `view` is `{ data, role, query, env, now }` and `data` is what `loadPageData` read. A screen
 * is a list of these (`pages.mjs`), and the SAME renderer serves the page load and every live update, so a panel the
 * stream swaps in is byte for byte the panel a reload would draw.
 *
 * PURE AND DETERMINISTIC: no I/O, no clock (`now` comes from the data, so a page is a function of `(data, now)`), no
 * randomness. Every value goes through the `html` template, which scrubs control bytes and escapes; the one exception is
 * the insights section renderers' output, admitted through `trustedRenderer` (see html.mjs).
 *
 * THE ROLE AND RUN-TEXT RULE (REQ-CONSOLE-SECURITY clause l). The run record holds no free text by construction; the
 * strings in it that a forge payload can shape (`jobId`, `target`, `parentJobId`) are escaped like every value and are
 * only ever placed as text or inside a URL this module encodes. BullMQ's `failedReason` IS free text (an error message),
 * so it is rendered only for the operator role, and only inside a per-job `<details>` element below the failed list,
 * never in a list row. A viewer's page carries none of it.
 *
 * THE ACTION CONTROLS (issue #642). A form per action (`<form data-action="<name>">`, `actions.mjs`'s table), drawn only
 * for an operator on a console that is not read-only (`canAct`), so a viewer's page and a read-only console's are what
 * they were. A form holds hidden fields and plain inputs, never a handler; `/static/console.js` posts it as JSON to
 * `/api/act/<name>/preview` and swaps the server's escaped preview into the form's own `[data-preview]` element. The
 * server refuses every write a viewer or a read-only console sends anyway; hiding the controls only spares the click.
 *
 * PATHS. A local folder, a skills directory or a folder scope is shown by its basename (the panel's and the insights
 * page's rule): a console page may be read on another machine, and a host's directory layout is not its business. The
 * one exception is the spend screen's `?paths=full`, which an OPERATOR may ask for (`insightsFullPaths`).
 *
 * THE MODULES (issue #737). The renderers live in `panels/<screen>.mjs`, one module per screen (`overview`, `runs`,
 * `run`, `parked`, `insights`, `fleet`, `config`, `audit`), and what more than one screen uses in `panels/common.mjs`.
 * This file re-exports exactly what it exported before the split, so no importer changed, except `navHtml`: the
 * navigation is the shell's since the Pulse frame (`shell.mjs`), and the overview's old panels (`overviewState`,
 * `overviewParked`, `overviewFailures`), which its Pulse panels replaced (`panels/overview.mjs`'s header says where each
 * part went). The rules above hold for every one of them.
 */
export {
  ageText, utcText, timeHtml, usdText, moneyHtml, shownPath, RUN_ID_RE, canAct, runCost, BEAT_FRESH_MS,
  workersOnline, staleText, progressText
} from "./panels/common.mjs";
export {
  NO_WORKER_TEXT, STALE_BEATS_TEXT, REGISTRY_UNREAD_TEXT, COUNT_WINDOWS_UTC_TEXT, OVERVIEW_UNREAD_TEXT, NEEDS_DEFINITION,
  NEEDS_EMPTY, WAITING_EMPTY, RUNNING_EMPTY, SPEND_EMPTY, HOSTS_EMPTY, WAITLISTS_CALM, SOFT_HOLD_TEXT,
  SOFT_HOLD_REFUSED_TEXT, FREE_SLOT_TEXT, HOST_NO_EXPIRY_TEXT, NO_DOCTOR_TEXT, SPEND_HOURS_TEXT, OVERVIEW_LINKS,
  NEEDS_ROWS_MAX, WAITING_MAIN_BUCKETS, WAITLIST_ROWS_MAX, hostSkewText, waitingSentence, overviewHeadline,
  overviewSetup, overviewSetupPi, overviewSetupEmpty, overviewNeeds, overviewWaiting, overviewActive, overviewSpend,
  overviewTimeline, overviewCaps, overviewWaitlists, overviewHosts
} from "./panels/overview.mjs";
export { runsFilter, runsTable } from "./panels/runs.mjs";
export {
  refusedBeforeStart, runOutcome, PROGRESS_ABSENT, runProgress, INBOX_NOT_OPEN, runInbox, runChat, runSummary,
  runCostPanel, runResources, runSession, runChain
} from "./panels/run.mjs";
export { parkedInbox } from "./panels/parked.mjs";
export {
  INSIGHTS_RANGES, INSIGHTS_DEFAULT_RANGE, insightsFullPaths, insightsRange, graphNodesHtml, insightsBody,
  insightsPanel, WHATIF_FLOW_RE, insightsWhatIf
} from "./panels/insights.mjs";
export {
  fleetQueues, fleetActive, fleetHeld, fleetHosts, fleetDoctor, fleetVenues, fleetSchedulers, fleetFailed
} from "./panels/fleet.mjs";
export {
  configTriggers, configSettings, configPauseWindows, configScopedLimits, configProjects, configMcp, configPackages,
  configSecretProfiles, configSecretBundles
} from "./panels/config.mjs";
export { auditLog } from "./panels/audit.mjs";
