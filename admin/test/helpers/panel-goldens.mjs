import { SANDBOX_DRAW } from "./sandbox-goldens.mjs";
import { ZERO_TOUCH_DRAW } from "./zero-touch-goldens.mjs";
import { CONFIGURATION_DRAW } from "./configuration-goldens.mjs";
import { TRIGGER_LIST_DRAW } from "./trigger-list-goldens.mjs";
import assert from "node:assert/strict";
import { TRIGGER_DRAW } from "./trigger-goldens.mjs";
import { SPEND_DRAW } from "./spend-goldens.mjs";
import { FLEET_DRAW } from "./fleet-goldens.mjs";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeConsoleAudit, readConsoleAudit, verifyConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import { DEFER_BUCKETS } from "@edgehero/pi-dispatch/defer-reasons";
import { CRON_ID_MAX } from "@edgehero/pi-dispatch/triggers";
import { NOW } from "../../../launch/fixture-deployment.mjs";
import { SNAPSHOT_TIMEOUT_SENTENCE, actionNamed, confirmAction, previewAction } from "../../src/console/actions.mjs";
import { makeConfirmTickets } from "../../src/console/confirm.mjs";
import { confirmSlotHtml, heldNoteHtml, refusalHtml } from "../../src/console/confirm-view.mjs";
import { originRefusal } from "../../src/console/guards.mjs";
import { html } from "../../src/console/html.mjs";
import { loadPageData, pagePanels, parsePageQuery, renderPage } from "../../src/console/pages.mjs";
import { PERSON_CHANGED } from "../../src/console/server.mjs";
import { ENDED_REASONS } from "../../src/console/session-ends.mjs";
import { LIVE_STATES, loginCodePage, loginPage } from "../../src/console/shell.mjs";
import * as RM from "../../src/read-model.mjs";
import * as WP from "../../src/write-plans.mjs";
import { tempDir } from "./temp-dir.mjs";

/**
 * The panel goldens (issue #737): the states of a page that the fixture deployment cannot reach, each drawn as a
 * whole page and pinned byte for byte as `admin/test/fixtures/console/panels/<state>.<role>.html`. The confirm slot's
 * bars, the banner after a write, the live notes, the read-only banner, a damaged audit chain, every sign-in notice and
 * the one-time link's states and notices: what a person sees in each, held to the page rules (`assertClean`), to the
 * pull request's diff, and to the width check, which loads every file here as it loads the screens' goldens.
 *
 * DRAWN BY THE REAL CODE, FROM CANNED INPUTS. A page is `pages.mjs` `renderPage` over `loadPageData`'s own result for a
 * canned fleet snapshot (`SNAPSHOT`, one deployment's worth of queues, held and failed jobs, settings and the rest), or
 * `shell.mjs` `loginPage` / `loginCodePage`, or the audit page over a real audit log written by the worker's own writer
 * in a temp directory and read and verified by its own reader and verifier. A bar in the confirm slot is the `html` the
 * real `previewAction` or `confirmAction` answers (the action table, its planners, the ticket store and the audit
 * capture), over fakes for what needs Valkey: the fleet reader's snapshot and switches, the failed jobs' list, a job's
 * data. The banner after a write is the `change` such a confirm answers, drawn by the shell as the session's flash.
 *
 * THE SCRIPT'S PART IS APPLIED AS THE SCRIPT APPLIES IT. The server draws every state the script can switch to, hidden;
 * the script reveals one, sets text and moves the slot. A golden of such a state is the server's page with exactly
 * that done, here, each step asserted to apply exactly once, so a markup change the step no longer matches fails
 * instead of drawing a page the script would never make: the slot taken from the end of `<main>` and put after the
 * card that asked (`script.mjs` `slotAnchor`), opened and filled with the answer's `html`
 * (`fillSlot`) or titled "Previewing: <the button's words>" (`openSlot`); the live pill's class, word and title from
 * `LIVE_STATES` (`mark`); one live note unhidden (`note`); `main.stale` and the time last seen (`since`); the kept-still
 * note as a held panel's first child (`hold`). That the script really does each is `console-client-states.test.mjs`'s
 * job, over the same server markup. A live page's pill is drawn Live (the stream is open while a person previews),
 * except where the pill IS the state; the configuration page is drawn once and has no pill.
 *
 * Pure: no Valkey, no network; the clock is the fixture's instant, injected everywhere, and the audit log's directory
 * comes from the workspace helper.
 */

export const PANELS = fileURLToPath(new URL("../fixtures/console/panels/", import.meta.url));

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Who the pages are drawn for: the screens' goldens' own names. `id` is the session the tickets are bound to. */
const OPERATOR = Object.freeze({ id: "s-panel-goldens-operator", name: "ops", role: "operator" });
const VIEWER = Object.freeze({ id: "s-panel-goldens-viewer", name: "watcher", role: "viewer" });

/** The token's live-stream limit as a console started with no settings has it (`config.mjs`, PI_CONSOLE_MAX_STREAMS). */
const MAX_STREAMS = 4;

/** The sign-in page's limits as a console started with no settings has them (60 idle minutes, 12 hours). */
const LIMITS = Object.freeze({ idleMinutes: 60, maxHours: 12 });

/**
 * One deployment's fleet snapshot, as the fleet reader's `snapshot()` answers it, read by the fleet and configuration
 * pages: two queues, two running jobs, two held, two failed, two hosts, a schedule, and a configuration of one of
 * everything the forms change. The ids and names are the fixture deployment's style (`launch/fixture-deployment.mjs`).
 */
const SNAPSHOT = Object.freeze({
  queue: { pausedState: false, pausedPartial: false, counts: { waiting: 2, active: 2, delayed: 1, failed: 2 }, workers: 3, queues: 2 },
  queueCounts: [
    { queue: "pi-jobs", paused: false, counts: { waiting: 2, active: 1, delayed: 1, paused: 0, failed: 2 } },
    { queue: "pi-jobs@build3", paused: false, counts: { waiting: 0, active: 1, delayed: 0, paused: 0, failed: 0 } },
  ],
  hostBudgets: [
    { name: "mini1", concurrency: "2", jobs: [{ id: "gh-b3d7", at: NOW - 12 * MIN, o: false }], staleMs: 2000, budgetMemMiB: "off", budgetCpuCenti: "off", waiters: "0", routes: "true" },
    { name: "build3", concurrency: "1", jobs: [{ id: "gh-e802", at: NOW - 5 * MIN, o: false }], staleMs: 4000, budgetMemMiB: "off", budgetCpuCenti: "off", waiters: "0", routes: "true" },
  ],
  active: [{ jobId: "gh-b3d7", queue: "pi-jobs", startedAt: NOW - 12 * MIN, host: "mini1" }, { jobId: "gh-e802", queue: "pi-jobs@build3", startedAt: NOW - 5 * MIN, host: "build3" }],
  held: { rows: [{ jobId: "gh-h41c", target: "acme/web#88", label: "jira", waitedMs: 25 * MIN }, { jobId: "gh-h52d", target: "acme/api#12", label: "jira", waitedMs: 9 * MIN }], more: 0 },
  failed: {
    rows: [
      { jobId: "gh-5d10", attemptsMade: 3, failedReason: "clone failed: remote rejected the token (403)", queue: "pi-jobs", endedAt: NOW - 3 * HOUR },
      { jobId: "gh-7c21", attemptsMade: 2, failedReason: "the container exited 137", queue: "pi-jobs", endedAt: NOW - 50 * MIN },
    ],
    more: 0,
  },
  schedulers: [{ key: "nightly-tidy", name: "local", pattern: "0 3 * * *", next: NOW + 11 * HOUR, overdueMs: 0 }],
  schedulerStalls: {},
  schedulerStallMax: 3,
  doctor: { hosts: [], more: 0 },
  parked: [],
  settings: { overlay: { maxTurns: 30, maxCostUsd: "2" } },
  triggers: { triggers: [{ type: "label", any: ["pi"], forge: "github", repository: "acme/web", flow: "triage" }] },
  pauseWindows: { windows: [{ scope: "*", from: "01:00", to: "02:00" }] },
  scopedLimits: { limits: [{ scope: "acme/web", day: 10 }] },
  projects: { projects: [{ id: "web", members: ["github:acme/web"] }] },
  envelopeSet: false,
  overlayMcp: { servers: [], refused: [], unreadable: null },
  stagedPackages: { stagedAt: null, packages: [] },
  secretProfilesEnv: { names: [], malformed: false, seen: true },
});

/** The settings file the snapshot's overlay was read from, which the setting actions plan against. */
const SETTINGS = Object.freeze({ maxTurns: 30, maxCostUsd: "2" });

/**
 * The failed jobs as the bulk planner lists them (`planFailedBulk`), and each one's queued data as `readJobsData` reads
 * it: the first two with a known model, the third's data unreadable (its reserve unknown), and two more matching past
 * the list (the bulk bar says so).
 */
const FAILED_JOBS = Object.freeze([
  { jobId: "gh-5d10", queue: "pi-jobs", attemptsMade: 3, finishedOn: NOW - 3 * HOUR, target: "acme/api#131" },
  { jobId: "gh-7c21", queue: "pi-jobs", attemptsMade: 2, finishedOn: NOW - 50 * MIN, target: "acme/web#90" },
  { jobId: "gh-8e33", queue: "pi-jobs", attemptsMade: 1, finishedOn: NOW - 20 * MIN, target: "acme/web#91" },
]);
const JOB_DATA = new Map([
  ["gh-5d10", { provider: "anthropic", model: "claude-sonnet-5-5" }],
  ["gh-7c21", { provider: "anthropic", model: "claude-sonnet-5-5" }],
]);

/** `planCancelQueued`'s plan for a job that never started, waiting behind build3's busy slot. */
const QUEUED_PLAN = (jobId) => ({
  jobId,
  queue: "pi-jobs@build3",
  state: "delayed",
  held: false,
  attemptsMade: 0,
  stalledCounter: 0,
  kind: "github",
  target: "acme/web#4",
  waiting: { jobId, queue: "pi-jobs@build3", state: "delayed", bucket: "slot", why: "host-slot", known: true, dueAt: NOW + 4 * MIN, untilAt: NOW + 4 * MIN, project: "web", host: "build3", holder: null, endpoint: null, budgetWhy: null, trigger: 0, attempt: null, attempts: null, attemptsMade: 0, stalled: 0, kind: "github", held: null },
});

/** A deterministic ticket source: the ticket never reaches a bar, but a golden must not depend on chance. */
function counter() {
  let n = 0;
  return (size) => {
    n += 1;
    return Buffer.alloc(size, n);
  };
}

/**
 * The action pipeline over the canned deployment: `preview(name, body)` and `confirm(name, ticket)` answer what the
 * console's routes answer (`{ status, body }`, the body the JSON the browser gets), with the real ticket store, the
 * real action table and, for the settings, the real planners over a settings file in a temp directory. `advance(ms)`
 * moves the clock. Audit rows are numbered from 44, so a banner links rows the way a used console's would. `fleet` is
 * laid over the fleet reader's fakes (a kill switch that reaches one Valkey and not the other, say). `rm` is laid the
 * same way over the read model the actions call (the real module, with the failed-job bulk planner, its retry and the
 * held job's cancel canned here): each key it names replaces that function, the real one or the canned one (a queued
 * job's plan and its removal's answer, a re-run's plan and its enqueue).
 */
function actionWorld({ fleet: fleetOver = {}, rm: rmOver = {} } = {}) {
  let t = NOW;
  const now = () => t;
  const dir = tempDir("panel-goldens-");
  const paths = { settingsFile: join(dir, "settings.json"), pauseWindowsPath: join(dir, "pause-windows.json"), logsDir: join(dir, "logs"), valkeyUrl: "redis://valkey:6379" };
  nodeFs.writeFileSync(paths.settingsFile, `${JSON.stringify(SETTINGS, null, 2)}\n`);
  nodeFs.writeFileSync(paths.pauseWindowsPath, `${JSON.stringify(SNAPSHOT.pauseWindows, null, 2)}\n`);
  let seq = 43;
  const rm = {
    ...RM,
    planFailedBulk: async () => ({ jobs: FAILED_JOBS.map((j) => ({ ...j })), more: 2, examinedAll: true }),
    retryFailedJobs: async ({ jobs }) => ({ results: jobs.map((j) => (j.jobId === "gh-7c21" ? { jobId: j.jobId, invalid: "it is no longer failed (it was retried elsewhere)" } : { ok: true, jobId: j.jobId, queue: "pi-jobs" })) }),
    cancelHeldJob: async () => ({ ok: true }),
    ...rmOver,
  };
  const fleet = {
    snapshot: async () => SNAPSHOT,
    pause: async () => ({ results: [{ shown: "redis://valkey:6379", res: { ok: true, queues: ["pi-jobs", "pi-jobs@build3"] } }] }),
    ...fleetOver,
  };
  const deps = {
    now,
    log: () => {},
    fs: nodeFs,
    config: { dir },
    tickets: makeConfirmTickets({ now, random: counter() }),
    audit: { append: (row) => ({ ...row, seq: (seq += 1) }) },
    sessions: { setFlash: () => true },
    writePauseWindows: RM.writePauseWindows,
    hub: null,
    actionDeps: { rm, plans: WP, paths, fleet, env: { PI_MAX_COST_USD: "2" }, readJobsData: async ({ jobs }) => new Map(jobs.filter((j) => JOB_DATA.has(j.jobId)).map((j) => [j.jobId, JOB_DATA.get(j.jobId)])), urlShown: (u) => u, host: "mini1" },
  };
  const ctxOf = (name, step, body) => ({
    deps,
    session: OPERATOR,
    body,
    route: { path: `/api/act/${name}/${step}` },
    record: () => {},
    json: (status, b) => ({ status, body: b }),
    actor: () => ({ name: OPERATOR.name, role: OPERATOR.role, session: "a1b2c3d4e5f6" }),
  });
  const named = (name) => {
    const a = actionNamed(name);
    assert.ok(a, `the action table has ${name}`);
    return a;
  };
  return {
    preview: (name, body = {}) => previewAction(ctxOf(name, "preview", body), named(name)),
    confirm: (name, ticket) => confirmAction(ctxOf(name, "confirm", { ticket }), named(name)),
    /** Preview then confirm; the confirm's answer. */
    async both(name, body = {}) {
      const p = await this.preview(name, body);
      assert.equal(p.status, 200, `${name} previews: ${JSON.stringify(p.body)}`);
      return this.confirm(name, p.body.ticket);
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

// ---- the script's steps, each asserted to apply once -----------------------------------------------------------------

/** `page` with the one `from` replaced by `to`; a `from` found any other number of times fails the golden. */
function once(page, from, to, what) {
  const n = page.split(from).length - 1;
  assert.equal(n, 1, `${what}: the page holds ${JSON.stringify(from.slice(0, 80))} exactly once (it holds it ${n} times)`);
  return page.replace(from, () => to);
}

/** Where the element opening at `at` (a `<section>`) ends, counting sections nested in it. */
function sectionEnd(page, at) {
  const re = /<section[\s>]|<\/section>/g;
  re.lastIndex = at;
  let depth = 0;
  for (let m = re.exec(page); m; m = re.exec(page)) {
    depth += m[0] === "</section>" ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  throw new Error("an unclosed section");
}

/**
 * The slot opened after panel `id`'s card, as `script.mjs` `openSlot` and `fillSlot` leave it: taken from the end of
 * `<main>`, where the shell draws it closed, and put after the panel (`slotAnchor`), holding `inner` (an answer's `html`, a string), or the previewing skeleton titled for the button
 * that asked.
 */
function openSlotAfter(page, id, { inner = null, label = null }) {
  const closed = String(confirmSlotHtml());
  let out = once(page, closed, "", "the shell's closed slot");
  const head = `<section id="${id}" data-panel>`;
  const at = out.indexOf(head);
  assert.ok(at >= 0 && out.indexOf(head, at + 1) < 0, `the page holds panel ${id} once`);
  let end = sectionEnd(out, at);
  let slot;
  if (inner === null) {
    slot = once(String(confirmSlotHtml({ open: true })), "<span data-slot-title>Previewing</span>", String(html`<span data-slot-title>Previewing: ${label}</span>`), "the skeleton's title");
  } else {
    // The answer's html is a string, as the browser gets it in the JSON, and the script sets it as the slot's inner
    // HTML: so it goes in as those bytes, inside the slot the server drew (opened), never through `html` again.
    const empty = String(confirmSlotHtml({ open: true, inner: html`` }));
    assert.ok(empty.endsWith("></div>"), "the slot closes right after its opening tag when it holds nothing");
    slot = `${empty.slice(0, -"</div>".length)}${inner}</div>`;
  }
  return `${out.slice(0, end)}${slot}${out.slice(end)}`;
}

/** The live pill in `state` (`LIVE_STATES`), as `script.mjs` `mark` sets it: its classes, its word and its title. */
function markLive(page, state) {
  const st = LIVE_STATES[state];
  assert.ok(st && state !== "start", `a live state the script sets: ${state}`);
  const tag = /<span id="live-status" class="[^"]*" role="status" aria-live="polite"(?: title="[^"]*")?>/.exec(page)?.[0];
  assert.ok(tag, "the page draws the live pill");
  let out = once(page, tag, String(html`<span id="live-status" class="${st.cls}" role="status" aria-live="polite"${st.title ? html` title="${st.title}"` : null}>`), "the live pill");
  out = once(out, `<span data-live-word>${LIVE_STATES.start.word}</span>`, String(html`<span data-live-word>${st.word}</span>`), "the live word");
  return out;
}

/** One live note shown (`script.mjs` `note`): its box's `hidden` taken off. */
function showNote(page, state) {
  return once(page, `<div data-live-note="${state}" hidden>`, `<div data-live-note="${state}">`, `the ${state} note`);
}

/** The page shown as last seen (`script.mjs`'s stale handler and `since`): `main.stale`, the note, the time it was seen. */
function showStale(page, since) {
  const iso = new Date(since).toISOString();
  let out = once(page, '<main id="main" tabindex="-1">', '<main id="main" tabindex="-1" class="stale">', "main");
  out = once(out, "<time data-since></time>", String(html`<time data-since datetime="${iso}">${iso.slice(0, 16).replace("T", " ")} UTC</time>`), "the stale note's time");
  return showNote(out, "stale");
}

/**
 * The `other` sign-in notice's sentence, as `script.mjs` `showOnly` sets it: the server's own `error`, through
 * `textContent` (here escaped, as text is), in the notice's one `[data-notice-text]`.
 */
function noticeText(page, sentence) {
  return once(page, "<span data-notice-text></span>", String(html`<span data-notice-text>${sentence}</span>`), "the other notice's text");
}

/**
 * A refusal no notice names, with the server's own sentence: the 403 a sign-in gets when its Origin is not the
 * console's (a proxy that rewrites the Host, say), drawn by the real guard.
 */
const OTHER_REFUSAL = originRefusal({ host: "127.0.0.1:4790", origin: "http://localhost:4790" });

/** The kept-still note as panel `id`'s first child (`script.mjs` `hold`, a copy of the shell's template). */
function holdPanel(page, id) {
  const head = `<section id="${id}" data-panel>`;
  return once(page, head, `${head}${heldNoteHtml()}`, `panel ${id}`);
}

// ---- the pages ---------------------------------------------------------------------------------------------------------

/** Page `name` (fleet or config) over the canned snapshot, as serve draws it for `session`, as a string. */
async function screen(name, { session = OPERATOR, readOnly = false, flash = null } = {}) {
  const parsed = parsePageQuery(name, "");
  const data = await loadPageData(name, parsed.query, { fleet: { snapshot: async () => SNAPSHOT }, now: () => NOW });
  const ctx = { query: parsed.query, session: { name: session.name, role: session.role }, data, readOnly, theme: null, flash, maxStreams: MAX_STREAMS };
  const page = await renderPage(name, ctx);
  assert.equal(page.status, 200, name);
  // The panels the page holds are what the stream would send: a state golden starts from a page the hub agrees with.
  for (const { id, html: inner } of await pagePanels(name, ctx)) assert.ok(String(page.html).includes(`id="${id}" data-panel>${inner}</`), `${name}: panel ${id}`);
  return String(page.html);
}

/** The fleet page as an operator sees it with the stream open. */
const fleetLive = async (opts) => markLive(await screen("fleet", opts), "on");

/** A slot answer's `html`, from a `{ status, body }` the pipeline answered with the status expected. */
function answerHtml(answer, status, what) {
  assert.equal(answer.status, status, `${what}: ${JSON.stringify(answer.body).slice(0, 300)}`);
  assert.equal(typeof answer.body.html, "string", `${what} answers html`);
  return answer.body.html;
}

/**
 * An audit log in a temp directory, written by the worker's own writer: `rows` rows a minute apart, the last at the
 * fixture's instant, then `tamper(lines)` over the file's lines. Returns the page's deps, as serve wires them (`cli.mjs`
 * `pageDeps`): the reader asked for places, the verifier for its last good row, stamped with the fixture's instant.
 */
function auditDeps({ rows, tamper }) {
  const logsDir = tempDir("panel-goldens-audit-");
  const actions = [
    { actor: { name: "console", role: "operator", session: null }, action: "serve-started", outcome: "ok" },
    { actor: { name: "ops", role: "operator", session: "a1b2c3d4" }, action: "login", outcome: "ok" },
    { actor: { name: "ops", role: "operator", session: "a1b2c3d4" }, action: "write", kind: "setting-set", target: "settings.json", outcome: "ok", beforeDigest: "0".repeat(64), afterDigest: "1".repeat(64), ticket: "abcdef012345" },
    { actor: { name: "anonymous", role: "none", session: null }, action: "login-failed", target: "/login", outcome: "refused", reason: "no token matched" },
    { actor: { name: "ops", role: "operator", session: "a1b2c3d4" }, action: "write", kind: "fleet-pause", target: "fleet", outcome: "ok", ticket: "bcdef0123456" },
    { actor: { name: "ops", role: "operator", session: "a1b2c3d4" }, action: "write", kind: "fleet-resume", target: "fleet", outcome: "ok", count: 2, ticket: "cdef01234567" },
  ];
  assert.ok(rows <= actions.length);
  for (let i = 0; i < rows; i++) makeConsoleAudit({ logsDir, now: () => NOW - (rows - 1 - i) * MIN, alive: () => true }).append(actions[i]);
  const file = join(logsDir, "console-audit", `${new Date(NOW).toISOString().slice(0, 7)}.jsonl`);
  const lines = nodeFs.readFileSync(file, "utf8").replace(/\n$/, "").split("\n");
  nodeFs.writeFileSync(file, `${tamper(lines).join("\n")}\n`);
  return {
    audit: ({ limit, before, positions }) => readConsoleAudit({ logsDir, limit, before, positions }),
    auditVerify: () => ({ ...verifyConsoleAudit({ logsDir, withLast: true }), checkedAt: NOW }),
    fleet: { parkedCount: async () => 0 },
    now: () => NOW,
  };
}

/**
 * The row at `index` with its link to the row before it rewritten, its JSON still a row: the verifier names that row
 * (its `prev` no longer matches), so the row the page marks damaged is the one that was changed. (A changed field
 * would break the NEXT row's link instead, and the page would then mark that one: the log's named residual.)
 */
function relink(lines, index) {
  const row = JSON.parse(lines[index]);
  return lines.map((l, i) => (i === index ? JSON.stringify({ ...row, prev: "f".repeat(64) }) : l));
}

/** The audit page an operator opens over `deps`. */
async function auditPage(deps) {
  const parsed = parsePageQuery("audit", "");
  const data = await loadPageData("audit", parsed.query, deps);
  const page = await renderPage("audit", { query: parsed.query, session: { name: OPERATOR.name, role: OPERATOR.role }, data, readOnly: false, theme: null, maxStreams: MAX_STREAMS });
  assert.equal(page.status, 200);
  return String(page.html);
}

// ---- the runs, parked and run-not-found states ----------------------------------------------------------------------

/** A run record as the history holds one, ISO times, a priced model and a reserve, `over` setting what it is about. */
const record = (over) => ({
  jobId: "gh-0000", kind: "github", target: "acme/web#1", project: "web", host: "mini1", backend: "podman", flow: "fix", provider: "anthropic", model: "claude-sonnet-5-5",
  outcome: "completed", reason: null, startedAt: new Date(NOW - 40 * MIN).toISOString(), endedAt: new Date(NOW - 20 * MIN).toISOString(),
  tokens: { input: 900, output: 300, total: 1200, cost: 0.11 }, dollars: { reservedMicros: 2_000_000 }, parentJobId: null, ...over,
});

/** The runs a runs state shows: a completed one, a refusal with its reason, a failure with none, one cancelled. */
const RUNS_PAGE_RUNS = Object.freeze([
  record({ jobId: "gh-9575", target: "acme/web#490" }),
  record({ jobId: "gh-e9a0", target: "acme/billing#295", project: "billing", host: null, outcome: "policy", reason: "scope-cap", tokens: null, dollars: null }),
  record({ jobId: "gh-f0c2", target: "acme/web#433", outcome: "failed", reason: null, endedAt: new Date(NOW - 26 * HOUR).toISOString(), startedAt: new Date(NOW - 26 * HOUR - 4 * MIN).toISOString() }),
  record({ jobId: "gh-4a7e", target: "acme/billing#290", project: "billing", host: "build3", outcome: "policy", reason: "operator-cancel", endedAt: new Date(NOW - 27 * HOUR).toISOString(), startedAt: new Date(NOW - 27 * HOUR - 20 * MIN).toISOString() }),
]);

/** The last 24 hours as the fleet reader's `runsWindow` answers them for `RUNS_PAGE_RUNS`. */
const RUNS_WINDOW = Object.freeze({
  at: NOW, floor: false, partial: false,
  byOutcome: { completed: 1, refused: 1, failed: 0, "awaiting-input": 0, cancelled: 0, other: 0 },
  byProject: [
    { project: "billing", count: 1, byOutcome: { completed: 0, refused: 1, failed: 0, "awaiting-input": 0, cancelled: 0, other: 0 }, spentMicros: 0, unpriced: 0 },
    { project: "web", count: 1, byOutcome: { completed: 1, refused: 0, failed: 0, "awaiting-input": 0, cancelled: 0, other: 0 }, spentMicros: 110_000, unpriced: 0 },
  ],
  projectsMore: false, byReason: { "scope-cap": 1 },
  values: { kind: ["github"], flow: ["fix"], trigger: [], host: ["mini1"], backend: ["podman"], model: ["claude-sonnet-5-5"] },
  spentMicros: 110_000, unpriced: 0,
});

/** The runs page with the stream open, over a fleet whose runs reads answer `page` and `window`. */
async function runsLive({ page = { runs: RUNS_PAGE_RUNS, mirror: "ok", next: null }, window = RUNS_WINDOW, session = OPERATOR, query = "" } = {}) {
  const parsed = parsePageQuery("runs", query);
  assert.ok(parsed.query, parsed.refusal);
  const fleet = {
    runsPage: async () => {
      if (page instanceof Error) throw page;
      return page;
    },
    runsWindow: async () => window,
    parkedCount: async () => 1,
  };
  const data = await loadPageData("runs", parsed.query, { fleet, now: () => NOW });
  const ctx = { query: parsed.query, session: { name: session.name, role: session.role }, data, readOnly: false, theme: null, flash: null, maxStreams: MAX_STREAMS };
  const out = await renderPage("runs", ctx);
  assert.equal(out.status, 200);
  for (const { id, html: inner } of await pagePanels("runs", ctx)) assert.ok(String(out.html).includes(`id="${id}" data-panel>${inner}</`), `runs: panel ${id}`);
  return markLive(String(out.html), "on");
}

/** A parked row as the snapshot's `parked` list holds one, `over` setting what it is about. */
const parkedRow = (over) => ({ jobId: "gh-2f6a", kind: "github", target: "acme/api#131", project: "api", parkedAt: NOW - 26 * MIN, ageMs: 26 * MIN, answered: false, chainCount: 1, pendingScan: { jobId: null }, ...over });

/** The parked page with the stream open, over a snapshot whose `parked` list is `rows` and a planner check answering `check`. */
async function parkedLive(rows, { check = { ok: true }, session = OPERATOR } = {}) {
  const snapshot = { ...SNAPSHOT, parked: rows };
  const fleet = { snapshot: async () => snapshot, parkedAnswerCheck: async () => check };
  const data = await loadPageData("parked", {}, { fleet, now: () => NOW });
  const ctx = { query: {}, session: { name: session.name, role: session.role }, data, readOnly: false, theme: null, flash: null, maxStreams: MAX_STREAMS };
  const out = await renderPage("parked", ctx);
  assert.equal(out.status, 200);
  for (const { id, html: inner } of await pagePanels("parked", ctx)) assert.ok(String(out.html).includes(`id="${id}" data-panel>${inner}</`), `parked: panel ${id}`);
  return markLive(String(out.html), "on");
}

/** A run id in no history, no queue, no transcript and no progress: the run-not-found page. */
async function runNotFoundPage(session) {
  const parsed = parsePageQuery("run", "id=gh-7777");
  // Each place a run is kept answers its own none (pages.mjs `runNotFound`): the record, the whole queue lookup, the
  // stream and the progress key.
  const fleet = { runById: async () => ({ missing: true }), jobStatus: async () => ({ found: false }), transcriptMeta: async () => ({ exists: false }), progress: async () => ({ absent: true }), progressOfRun: async () => ({ progress: { absent: true }, continues: false, continuesAs: null }), parkedCount: async () => 0 };
  const data = await loadPageData("run", parsed.query, { fleet, now: () => NOW });
  const out = await renderPage("run", { query: parsed.query, session: { name: session.name, role: session.role }, data, readOnly: false, theme: null, flash: null, maxStreams: MAX_STREAMS });
  assert.equal(out.status, 404);
  return String(out.html);
}

/** The fleet with `n` host queues, every one paused: more than a switch's sentence names. */
function manyPausedSnapshot(n) {
  const queues = Array.from({ length: n }, (_, i) => `pi-jobs@host${String(i + 1).padStart(2, "0")}`);
  return { ...SNAPSHOT, queueCounts: [{ queue: "pi-jobs", paused: true, counts: { paused: 1, waiting: 0 } }, ...queues.map((queue) => ({ queue, paused: true, counts: { paused: 1, waiting: 0 } }))], switchTotal: n + 1, switchTruncated: false, switchIncomplete: null };
}

// ---- the overview's states ---------------------------------------------------------------------------------------------

/** An instant of the fixture's day, `hh:mm` UTC. */
const at = (hh, mm) => Date.UTC(2026, 9, 8, hh, mm, 0);

/**
 * The day's runs the overview's states draw (issue #737), as the fleet reader's `runsDay` rebuilds them: the
 * OverviewScreen card's own, around the fixture's instant. `CALM_RUNS` are the completed ones; the problem state adds a
 * failure, a refusal, a parked question and the cancelled run whose container still holds a build3 slot.
 */
const CALM_RUNS = Object.freeze([
  { jobId: "gh-9575", kind: "github", target: "acme/web#490", project: "web", host: "mini1", outcome: "completed", reason: null, startedAt: at(14, 35), endedAt: at(14, 57) },
  { jobId: "gh-0b11", kind: "github", target: "acme/web#486", project: "web", host: "mini1", outcome: "completed", reason: null, startedAt: at(13, 22), endedAt: at(13, 40) },
  { jobId: "gh-0b12", kind: "github", target: "acme/web#487", project: "web", host: "mini2", outcome: "completed", reason: null, startedAt: at(13, 51), endedAt: at(14, 8) },
  { jobId: "gh-03a9", kind: "github", target: "acme/api#118", project: "api", host: "mini2", outcome: "completed", reason: null, startedAt: at(14, 20), endedAt: at(14, 41) },
  { jobId: "gh-ebd7", kind: "github", target: "acme/billing#288", project: "billing", host: "build3", outcome: "completed", reason: null, startedAt: at(14, 18), endedAt: at(14, 44) },
  { jobId: "gh-0b13", kind: "github", target: "acme/billing#286", project: "billing", host: "build3", outcome: "completed", reason: null, startedAt: at(13, 25), endedAt: at(13, 38) },
].map((r) => Object.freeze({ ...r, parentJobId: null })));
const PROBLEM_RUNS = Object.freeze([
  ...CALM_RUNS,
  { jobId: "gh-f0c2", kind: "github", target: "acme/web#433", project: "web", host: "mini1", outcome: "failed", reason: null, startedAt: at(15, 6), endedAt: at(15, 10), parentJobId: null },
  { jobId: "gh-2f6a", kind: "github", target: "acme/api#131", project: "api", host: "mini1", outcome: "completed", reason: "awaiting-input", startedAt: at(14, 52), endedAt: at(15, 13), parentJobId: null },
  { jobId: "gh-e9a0", kind: "github", target: "acme/billing#295", project: "billing", host: null, outcome: "policy", reason: "scope-cap", startedAt: at(15, 2), endedAt: at(15, 2), parentJobId: null },
  { jobId: "gh-4a7e", kind: "github", target: "acme/billing#290", project: "billing", host: "build3", outcome: "cancelled", reason: "cancelled", startedAt: at(10, 39), endedAt: at(10, 59), parentJobId: null },
]);

/** A waiting row as `readWaiting` answers it, every field present; `over` sets what the row is about. */
const waitRow = (over) => ({ queue: "pi-jobs", state: "delayed", bucket: "none", why: null, known: false, dueAt: NOW + 5_000, queuedAt: NOW - 10 * MIN, recordedAt: NOW, untilAt: null, project: null, projectFrom: null, host: null, holder: null, endpoint: null, budgetWhy: null, trigger: null, attempt: null, attempts: null, attemptsMade: 0, stalled: 0, kind: "github", recovery: false, schedulerNext: false, held: null, ...over });

/**
 * The jobs in line of each kind of wait, each a list of rows; the waitlist states draw one each. The kinds are the
 * worker leaf's `DEFER_BUCKETS`, never a list of this file's: a bucket the leaf gains with no rows here fails as this
 * module loads, naming it, so its waitlist state is drawn the day it exists rather than silently missing.
 */
const WAITING_BY_BUCKET = Object.freeze({
  slot: [
    waitRow({ jobId: "gh-c9e1", bucket: "slot", why: "host-slot", known: true, project: "billing", projectFrom: "record", host: "build3", queuedAt: NOW - 3 * MIN }),
    waitRow({ jobId: "gh-c9e2", bucket: "slot", why: "scope-repo", known: true, project: "web", projectFrom: "record", host: "mini1", queuedAt: NOW - 2 * MIN }),
  ],
  run: [
    waitRow({ jobId: "gh-d4f0", bucket: "run", why: "chained", known: true, project: "web", projectFrom: "record", host: "mini1", holder: "gh-b3d7", queuedAt: NOW - 6 * MIN }),
    waitRow({ jobId: "gh-e802.r1", bucket: "run", why: "recovery-wait", known: true, project: "billing", projectFrom: "record", host: "build3", holder: "gh-e802", recovery: true, dueAt: NOW + 30_000, untilAt: NOW + 30_000, queuedAt: NOW - MIN }),
  ],
  check: [
    waitRow({ jobId: "gh-77c1", bucket: "check", why: "wait-after", known: true, project: "web", projectFrom: "record", host: "mini1", trigger: 2, dueAt: Date.UTC(2026, 9, 9, 7), untilAt: Date.UTC(2026, 9, 9, 7), queuedAt: NOW - (2 * HOUR + 14 * MIN), held: { since: NOW - (2 * HOUR + 14 * MIN), label: "after 2026-10-09T07:00Z + ci-green", checks: 3, after: Date.UTC(2026, 9, 9, 7), answers: [{ profile: "ci-green", answer: "hold", at: NOW - 4 * MIN }] } }),
  ],
  retry: [
    waitRow({ jobId: "gh-71b2", bucket: "retry", why: "retry", known: true, project: "api", projectFrom: "record", host: "mini1", attempt: 2, attempts: 3, attemptsMade: 1, dueAt: NOW + 4 * MIN, untilAt: NOW + 4 * MIN, queuedAt: NOW - 21 * MIN }),
    waitRow({ jobId: "gh-38aa", bucket: "retry", why: "retry", known: true, project: "web", projectFrom: "record", host: "mini2", attempt: 2, attempts: 3, attemptsMade: 1, dueAt: NOW + 9 * MIN, untilAt: NOW + 9 * MIN, queuedAt: NOW - 16 * MIN }),
  ],
  pause: [
    waitRow({ jobId: "local-aa01", bucket: "pause", why: "pause-window", known: true, project: "web", projectFrom: "record", host: "mini1", kind: "local", dueAt: at(20, 0), untilAt: at(20, 0), queuedAt: NOW - 30 * MIN }),
  ],
  ready: [
    waitRow({ jobId: "gh-bb02", bucket: "ready", why: "podman-restart", known: true, project: "billing", projectFrom: "record", host: "build3", dueAt: NOW + 20_000, untilAt: NOW + 20_000, queuedAt: NOW - 4 * MIN }),
  ],
  paused: [
    waitRow({ jobId: "gh-cc03", bucket: "paused", state: "paused", queue: "pi-jobs@mini2", project: "api", projectFrom: "deid", dueAt: null, recordedAt: null, queuedAt: NOW - 12 * MIN }),
  ],
  // Past its due by more than the reader's grace with no worker taking it, whatever it recorded (its record expired a
  // minute after the due); and a cron trigger's next run, overdue, so in line, which the queue refuses to remove.
  due: [
    waitRow({ jobId: "gh-f1a0", bucket: "due", project: "api", projectFrom: "deid", dueAt: NOW - 3 * MIN, recordedAt: null, queuedAt: NOW - 11 * MIN }),
    waitRow({ jobId: `repeat:hourly-sync:${at(15, 0)}`, bucket: "due", kind: "local", project: "web", projectFrom: "trigger", schedulerNext: true, dueAt: at(15, 0), recordedAt: null, queuedAt: at(15, 0) }),
  ],
  unknown: [
    waitRow({ jobId: "gh-ee05", bucket: "unknown", why: "brand-new-why", known: false, project: "web", projectFrom: "deid", queuedAt: NOW - 7 * MIN }),
  ],
  none: [
    waitRow({ jobId: "gh-dd04", bucket: "none", project: null, recordedAt: null, queuedAt: NOW - 8 * MIN }),
  ],
});

for (const b of DEFER_BUCKETS) assert.ok(Array.isArray(WAITING_BY_BUCKET[b]) && WAITING_BY_BUCKET[b].length > 0, `panel goldens: the bucket ${b} (DEFER_BUCKETS) needs its sample rows in WAITING_BY_BUCKET`);
for (const b of Object.keys(WAITING_BY_BUCKET)) assert.ok(DEFER_BUCKETS.includes(b), `panel goldens: ${b} is no bucket of DEFER_BUCKETS`);

/**
 * `rows` as `readWaiting`'s answer (`{ at, rows, scheduled, byBucket, byQueue, truncated }`): a count for every bucket of
 * `DEFER_BUCKETS`, and a `byQueue` entry for the shared queue and each queue a row is in.
 */
function waitingOf(rows) {
  const byBucket = Object.fromEntries(DEFER_BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b).length]));
  const queues = [...new Set(["pi-jobs", ...rows.map((r) => r.queue)])];
  return { at: NOW, rows, scheduled: [], byBucket, byQueue: queues.map((queue) => ({ queue, inLine: rows.filter((r) => r.queue === queue).length, scheduled: 0, truncated: false })), truncated: false };
}

/** A host's registry row as the fleet reader answers it. */
const hostRow = (name, over) => ({ name, jobsMore: 0, staleMs: 4_000, ttlAgeMs: 4_000, skewMs: 0, noExpiry: false, budgetMemMiB: "off", budgetCpuCenti: "off", waiters: "0", routes: "true", ...over });

/** A doctor run as the fleet reader answers it, `ageMs` old, with `checks` its problems and `ok` passes. */
const doctorRow = (name, ageMs, { ok = 40, checks = [] } = {}) => ({ name, ageMs, at: NOW - ageMs, version: "4.3.1", openshell: false, every: 24, by: { uid: 1001, worker: true }, counts: { ok, warn: checks.filter((c) => c.level === "warn").length, fail: checks.filter((c) => c.level === "fail").length }, checks, more: 0 });

/**
 * The overview's canned snapshot (issue #737), the OverviewScreen card's deployment in the fixture's names: three hosts
 * (build3 with the slot the cancelled gh-4a7e still holds), four running jobs, caps with the soft hold at 80%, the day's
 * spend by hour, a parked question, a failed job and build3's failing doctor. `over` replaces whole fields.
 */
function overviewSnapshot(over = {}) {
  const s = {
    queue: { pausedState: false, pausedPartial: false, counts: { waiting: 0, active: 4, delayed: 3, failed: 1 }, workers: 3, queues: 4, fleetDegraded: null },
    queueCounts: [
      { queue: "pi-jobs", paused: false, counts: { waiting: 0, active: 0, delayed: 3, paused: 0, failed: 1 } },
      { queue: "pi-jobs@build3", paused: false, counts: { waiting: 0, active: 1, delayed: 0, paused: 0, failed: 0 } },
      { queue: "pi-jobs@mini1", paused: false, counts: { waiting: 0, active: 2, delayed: 0, paused: 0, failed: 0 } },
      { queue: "pi-jobs@mini2", paused: false, counts: { waiting: 0, active: 1, delayed: 0, paused: 0, failed: 0 } },
    ],
    hostBudgets: [
      hostRow("build3", { concurrency: "3", jobs: [{ id: "gh-4a7e", p: "billing", at: at(10, 39), o: true }, { id: "gh-e802", p: "billing", at: at(14, 19), o: false }], staleMs: 12_000, backends: { blessed: ["podman"] } }),
      hostRow("mini1", { concurrency: "4", jobs: [{ id: "gh-c41f", p: "api", at: at(14, 58), o: false }, { id: "gh-b3d7", p: "web", at: at(15, 27), o: false }], staleMs: 22_000, backends: { blessed: ["local"] } }),
      hostRow("mini2", { concurrency: "2", jobs: [{ id: "local-9e20", p: "ops", at: at(15, 33), o: false }], staleMs: 22_000, backends: { blessed: ["local", "openshell"] } }),
    ],
    active: [
      { jobId: "gh-e802", queue: "pi-jobs@build3", startedAt: at(14, 19), host: "build3" },
      { jobId: "gh-c41f", queue: "pi-jobs@mini1", startedAt: at(14, 58), host: "mini1" },
      { jobId: "gh-b3d7", queue: "pi-jobs@mini1", startedAt: at(15, 27), host: "mini1" },
      { jobId: "local-9e20", queue: "pi-jobs@mini2", startedAt: at(15, 33), host: "mini2" },
    ],
    budget: { day: 25, week: 100, month: 168, tokensToday: 3_120_000 },
    settings: { overlay: { dailyCap: 40, weeklyCap: 200, monthlyCap: 600, dailyTokenCap: 8_000_000, softHoldPct: 80 } },
    dollars: { rows: [
      { ledger: "deployment", name: null, window: "day", capMicros: 25_000_000, counterMicros: 15_040_000, full: false },
      { ledger: "deployment", name: null, window: "week", capMicros: 100_000_000, counterMicros: 28_400_000, full: false },
      { ledger: "scope", name: "project:web", window: "week", capMicros: 40_000_000, counterMicros: 10_400_000, full: false },
      { ledger: "model", name: "anthropic/claude-sonnet-5-5", window: "week", capMicros: 60_000_000, counterMicros: 24_600_000, full: false },
    ] },
    spendByHour: { hours: Array.from({ length: 24 }, (_, i) => (i > 15 ? null : i >= 9 ? 380_000 * (i - 8) : 0)), unpriced: 0, floor: false, partial: false },
    softHoldToday: { count: 0, floor: false, partial: false },
    parked: [{ target: "acme/api#131", kind: "github", jobId: "gh-2f6a", parkedAt: at(15, 13), ageMs: NOW - at(15, 13), answered: false, chainCount: null, answering: false }],
    parkedUnreachable: null,
    failures24h: 1,
    refusals24h: { count: 1, top: [{ reason: "scope-cap", count: 1 }] },
    failures24hFloor: false,
    failed: { rows: [{ jobId: "gh-5d10", attemptsMade: 3, failedReason: "clone failed: remote rejected the token (403)", queue: "pi-jobs", endedAt: NOW - 3 * HOUR, reason: null }], more: 0 },
    doctor: { hosts: [
      doctorRow("build3", 72 * HOUR, { ok: 38, checks: [{ id: "docker.39", level: "fail", label: "Docker daemon unreachable" }] }),
      doctorRow("mini1", HOUR, { ok: 41, checks: [{ id: "fleet.42", level: "warn", label: "this host's worker admits no job on the podman venue" }] }),
    ], more: 0 },
    runsDay: { runs: PROBLEM_RUNS, floor: false, partial: false },
    runs: PROBLEM_RUNS.map((r) => ({ ...r, startedAt: new Date(r.startedAt).toISOString(), endedAt: new Date(r.endedAt).toISOString() })),
    waiting: waitingOf([...WAITING_BY_BUCKET.slot.slice(0, 1), ...WAITING_BY_BUCKET.run.slice(0, 1), ...WAITING_BY_BUCKET.check, ...WAITING_BY_BUCKET.retry]),
    schedulers: [
      { key: "nightly-tidy", name: "local", pattern: "0 3 * * *", next: Date.UTC(2026, 9, 9, 3, 0), overdueMs: 0 },
      { key: "pm-weekly", name: "pm-weekly", pattern: "0 6 * * 1", next: Date.UTC(2026, 9, 12, 6, 0), overdueMs: 0 },
    ],
    // Each with its file position, as `readTriggers` gives it.
    triggers: { triggers: [{ type: "cron", id: "nightly-tidy", folder: "/srv/site", index: 0 }, { type: "label", any: ["pi:frontend"], forge: "github", index: 1 }, { type: "comment", phrase: "@pi", forge: "github", index: 2 }] },
    ...over,
  };
  // Each queue's counts agree with what waits in it: its delayed jobs in line, plus the shared queue's two cron triggers'
  // next runs, and its paused list.
  const rows = Array.isArray(s.waiting?.rows) ? s.waiting.rows : [];
  const inQueue = (q, state) => rows.filter((r) => r.queue === q && r.state === state).length;
  const delayed = (q) => inQueue(q, "delayed") + (q === "pi-jobs" ? s.schedulers.length : 0);
  s.queueCounts = s.queueCounts.map((q) => ({ ...q, counts: { ...q.counts, delayed: delayed(q.queue), paused: inQueue(q.queue, "paused") } }));
  s.queue = { ...s.queue, counts: { ...s.queue.counts, delayed: s.queueCounts.reduce((a, q) => a + q.counts.delayed, 0) } };
  return s;
}

/** Nothing needs a person (the OverviewAllClear card): no question, no failure or refusal, every doctor passing. */
const CALM = Object.freeze({
  parked: [],
  failed: { rows: [], more: 0 },
  failures24h: 0,
  refusals24h: { count: 0, top: [] },
  runsDay: { runs: CALM_RUNS, floor: false, partial: false },
  runs: CALM_RUNS.map((r) => ({ ...r, startedAt: new Date(r.startedAt).toISOString(), endedAt: new Date(r.endedAt).toISOString() })),
  hostBudgets: [
    hostRow("build3", { concurrency: "3", jobs: [{ id: "gh-e802", p: "billing", at: at(14, 19), o: false }], staleMs: 12_000, backends: { blessed: ["podman"] } }),
    hostRow("mini1", { concurrency: "4", jobs: [{ id: "gh-c41f", p: "api", at: at(14, 58), o: false }, { id: "gh-b3d7", p: "web", at: at(15, 27), o: false }], staleMs: 22_000, backends: { blessed: ["local"] } }),
    hostRow("mini2", { concurrency: "2", jobs: [{ id: "local-9e20", p: "ops", at: at(15, 33), o: false }], staleMs: 22_000, backends: { blessed: ["local", "openshell"] } }),
  ],
  doctor: { hosts: [doctorRow("build3", 2 * HOUR), doctorRow("mini1", HOUR, { ok: 41, checks: [{ id: "fleet.42", level: "warn", label: "this host's worker admits no job on the podman venue" }] })], more: 0 },
  waiting: waitingOf(WAITING_BY_BUCKET.retry.slice(0, 1)),
});

/**
 * A deployment before its first job (the SetupScreen card): read, with no run on record and no trigger. `doctor` is the
 * hosts' published doctor runs (none: nothing has run doctor yet).
 */
const firstRun = (doctor = []) => overviewSnapshot({
  queue: { pausedState: false, pausedPartial: false, counts: {}, workers: 0, queues: 1, fleetDegraded: null },
  queueCounts: [{ queue: "pi-jobs", paused: false, counts: { waiting: 0, active: 0, delayed: 0, paused: 0, failed: 0 } }],
  hostBudgets: [],
  active: [],
  budget: { day: 0, week: 0, month: 0, tokensToday: 0 },
  dollars: { rows: [] },
  spendByHour: { hours: Array.from({ length: 24 }, (_, i) => (i > 15 ? null : 0)), unpriced: 0, floor: false, partial: false },
  parked: [],
  failed: { rows: [], more: 0 },
  failures24h: 0,
  refusals24h: { count: 0, top: [] },
  doctor: { hosts: doctor, more: 0 },
  runsDay: { runs: [], floor: false, partial: false },
  runs: [],
  waiting: waitingOf([]),
  schedulers: [],
  triggers: { triggers: [] },
});

/**
 * The SetupScreen card's own moment: no worker registered yet, and build3's doctor two minutes ago found no egress
 * proxy (a failure) and no provider key in the deployment's env (a warning).
 */
const SETUP_PARTIAL_DOCTOR = Object.freeze([
  doctorRow("build3", 2 * MIN, { ok: 30, checks: [{ id: "egress.proxy", level: "fail", label: "the egress proxy is not running" }, { id: "provider.key", level: "warn", label: "no provider key in the deployment's .env" }] }),
]);

/**
 * The overview over `snapshot`, as serve draws it for `session` with the stream open (the pill Live): the deployment
 * its folder's last part, as `cli.mjs` passes it.
 */
async function overviewLive(snapshot, { session = OPERATOR, query = "" } = {}) {
  const parsed = parsePageQuery("overview", query);
  assert.ok(parsed.query, parsed.refusal);
  const data = await loadPageData("overview", parsed.query, { fleet: { snapshot: async () => snapshot }, now: () => NOW, deployment: { folder: "pi-dispatch" } });
  const ctx = { query: parsed.query, session: { name: session.name, role: session.role }, data, readOnly: false, theme: null, flash: null, maxStreams: MAX_STREAMS };
  const page = await renderPage("overview", ctx);
  assert.equal(page.status, 200);
  for (const { id, html: inner } of await pagePanels("overview", ctx)) assert.ok(String(page.html).includes(`id="${id}" data-panel>${inner}</`), `overview: panel ${id}`);
  return markLive(String(page.html), "on");
}

/** The overview's problem state with only bucket `bucket`'s jobs in line. */
const waitlist = (bucket) => overviewLive(overviewSnapshot({
  waiting: waitingOf(WAITING_BY_BUCKET[bucket]),
  // The due bucket's scheduler run is the hourly-sync cron trigger's (its scheduler's next run is that row).
  ...(bucket === "due" ? { triggers: { triggers: [...overviewSnapshot().triggers.triggers, { type: "cron", id: "hourly-sync", folder: "/srv/web", index: 3 }] } } : {}),
  // The paused bucket's queue is paused, as BullMQ keeps a paused queue's jobs in its paused list.
  ...(bucket === "paused" ? { queue: { pausedState: false, pausedPartial: true, counts: { waiting: 0, active: 4, delayed: 3, failed: 1 }, workers: 3, queues: 4, fleetDegraded: null }, queueCounts: overviewSnapshot().queueCounts.map((q) => (q.queue === "pi-jobs@mini2" ? { ...q, paused: true, counts: { ...q.counts, paused: 1 } } : q)) } : {}),
}));

/** The hosts as the registry sees them, one host's row changed by `over`. */
const hostsWith = (name, over) => overviewSnapshot().hostBudgets.map((h) => (h.name === name ? { ...h, ...over } : h));

/**
 * The longest names the overview draws in running text, each one a worker or the triggers file could hold: `host`, a
 * registered host with the longest name a worker can declare (`WORKER_NAME_RE`, 64 characters), standing in for build3;
 * `gone`, another such name, a host gone from the registry whose queue still holds a job; `peer`, a second registered
 * host of that length, standing in for mini2, so a confirm bar names two such queues; `cron`, a cron trigger's id
 * (`[A-Za-z0-9._-]`), the longest the triggers file takes (`CRON_ID_MAX`), with no place to break.
 */
export const LONG_NAMES = Object.freeze({
  host: `build-${"x".repeat(51)}-gpu-03`,
  gone: `gone-${"y".repeat(51)}-node-07`,
  peer: `peer-${"w".repeat(51)}-node-11`,
  cron: `report-${"z".repeat(CRON_ID_MAX - "report--weekly".length)}-weekly`,
});

/**
 * The long names' overview: build3 renamed `LONG_NAMES.host` in the registry and in `queueCounts` (where a host's own
 * queue is read), that queue paused (so the Hosts head's chip, the host's row and the Queues line draw it), a job in it
 * waiting for its slot (gh-4a7e still holds one there, so the row names the host twice), a job in `LONG_NAMES.gone`'s
 * queue (the stray-queue sentence and its Queues entry), a long doctor label, and `LONG_NAMES.cron` next in Scheduled.
 */
function longNamesSnapshot() {
  const { host, gone, cron } = LONG_NAMES;
  const base = overviewSnapshot();
  const label = `Job image ghcr.io/edgehero/pi-dispatch-job@sha256:${"a".repeat(64)} is not pulled on this host`;
  return overviewSnapshot({
    queue: { ...base.queue, pausedPartial: true },
    queueCounts: base.queueCounts.map((q) => (q.queue === "pi-jobs@build3" ? { ...q, queue: `pi-jobs@${host}`, paused: true } : q)),
    hostBudgets: base.hostBudgets.map((h) => (h.name === "build3" ? { ...h, name: host } : h)),
    doctor: { hosts: [doctorRow(host, HOUR, { ok: 39, checks: [{ id: "image.1", level: "fail", label }] })], more: 0 },
    waiting: waitingOf([
      waitRow({ jobId: "gh-c9e1", queue: `pi-jobs@${host}`, bucket: "slot", why: "host-slot", known: true, project: "billing", projectFrom: "record", host, queuedAt: NOW - 3 * MIN }),
      waitRow({ jobId: "gh-z7a0", queue: `pi-jobs@${gone}`, bucket: "slot", why: "host-slot", known: true, project: "web", projectFrom: "record", host: gone, queuedAt: NOW - 9 * MIN }),
    ]),
    schedulers: [{ key: cron, name: cron, pattern: "0 6 * * 1", next: NOW + 2 * HOUR, overdueMs: 0 }, ...base.schedulers],
  });
}

/**
 * The overview with two hosts of the longest names (`LONG_NAMES.host` for build3, `LONG_NAMES.peer` for mini2), in the
 * registry and in `queueCounts`, the queues of those named in `paused` paused (the fleet partly paused, so the Hosts
 * card offers Resume fleet beside each host's own pause), the shared queue and mini1's running. The confirm bars over
 * it name those queues: a fleet resume's Undo both paused ones, a host queue's pause its one.
 */
function longQueuesSnapshot(paused) {
  const { host, peer } = LONG_NAMES;
  const base = overviewSnapshot();
  const renamed = { build3: host, mini2: peer };
  const name = (n) => renamed[n] ?? n;
  return overviewSnapshot({
    queue: { ...base.queue, pausedPartial: paused.length > 0 },
    queueCounts: base.queueCounts.map((q) => {
      const at = q.queue.indexOf("@");
      if (at < 0) return q;
      const of = name(q.queue.slice(at + 1));
      return { ...q, queue: `pi-jobs@${of}`, paused: paused.includes(of) };
    }),
    hostBudgets: base.hostBudgets.map((h) => ({ ...h, name: name(h.name) })),
  });
}

// ---- the states ----------------------------------------------------------------------------------------------------------

/**
 * Every panel golden, `<state>.<role>`, in the order the cards name them, each a function drawing its whole page. A
 * closed list: a file under `panels/` that is not one of these fails `console-panel-goldens.test.mjs`.
 */
/** The run cards' states, rendered through the production panel table without transcript text. */
async function runCard({ role = "operator", rec = record({ jobId: "gh-pulse", maxTurns: 40, turns: 14, triggerIndex: 0, triggerType: "comment" }), chat = { state: "finished", mode: "fork", jobState: "completed" }, transcript = { exists: false }, ...extra } = {}) {
  const data = { now: NOW, env: {}, run: rec ? { record: rec, source: "local" } : { missing: true }, chat, transcript, children: [], childrenSearched: 50, ...extra };
  const result = await renderPage("run", { query: { id: rec?.jobId ?? "gh-pulse" }, session: role === "operator" ? OPERATOR : VIEWER, data });
  return String(result.html);
}
const RUN_CARD_STATES = {
  "run-chat-live.operator": () => runCard({ rec: null, chat: { state: "active", mode: "live", jobState: "active" }, transcript: { exists: false }, activeRun: { target: "acme/web#42", kind: "github", host: "mini1", project: "web", backend: "podman", flow: "fix", provider: "anthropic", model: "claude-sonnet-5-5", maxTurns: 40, queue: "pi-jobs@mini1", startedAt: new Date(NOW - 2 * MIN).toISOString() }, inbox: { found: true, steer: true, state: "active", open: true, entries: [] } }),
  "run-chat-reply.operator": () => runCard({ rec: record({ jobId: "gh-pulse", reason: "awaiting-input", session: { resumed: false, reason: "absent", bytes: 4096 } }), chat: { state: "parked", mode: "reply", jobState: "completed" }, transcript: { exists: true, ended: true, outcome: "completed" } }),
  "run-chat-approval.operator": () => runCard({ rec: record({ jobId: "gh-pulse", reason: "awaiting-approval", approval: { requestId: "a".repeat(64), action: "budget-raise" }, session: { resumed: false, reason: "absent", bytes: 4096 } }), chat: { state: "awaiting-approval", mode: "reply", jobState: "completed" }, chatAnswer: { ok: true }, transcript: { exists: true, ended: true, outcome: "completed" } }),
  "run-chat-expired.operator": () => runCard({ rec: record({ jobId: "gh-pulse", reason: "awaiting-input" }), chat: { state: "parked", mode: "reply", jobState: "completed" } }),
  "run-chat-fork.operator": () => runCard({ rec: record({ jobId: "gh-pulse", session: { resumed: false, reason: "absent", bytes: 4096 } }), forkPoints: { ok: true, entries: [{ id: "1a2b3c4d", parentId: null, type: "message", role: "user", positions: ["before"] }, { id: "2b3c4d5e", parentId: "1a2b3c4d", type: "message", role: "assistant", positions: ["at"] }] } }),
  "run-chat-none.operator": () => runCard({ chat: { state: "finished", mode: "none", says: "This run's trigger keeps no session (no run.resume), so there is no transcript to fork." } }),
  "run-refused.operator": () => runCard({ rec: record({ jobId: "gh-pulse", outcome: "policy", reason: "job-image-missing", tokens: null, dollars: null, budgetReserved: false, exitCode: null }) }),
  "run-cancelled-before-start.operator": () => runCard({ rec: record({ jobId: "gh-pulse", outcome: "policy", reason: "operator-cancel", tokens: null, dollars: null, budgetReserved: false, exitCode: null }) }),
  "run-recovering.operator": () => runCard({ rec: record({ jobId: "gh-pulse", outcome: "failed", reason: "recovery-enqueued", checkpoints: { written: 4, failed: 1, skipped: 2 }, recovered: { from: "gh-before", n: 1, fromAttempt: 1, checkpointSeq: 4, replayed: 2, interrupted: 1, notStarted: 1 } }), chat: { state: "active", mode: "live", activeJobId: "gh-pulse.r1", jobState: "failed" } }),
  "run-sandbox-openshell.operator": () => runCard({ rec: record({ jobId: "gh-pulse", backend: "openshell", openshell: { mode: "copy", providers: 2, placeholders: 2, ruleHosts: ["api.example.com"], ruleHostCount: 1 }, secretsProfile: "forge", bundle: { id: "web-ci", variables: ["API_TOKEN", "CONFIG"], shadowed: [], placeholders: 1, plain: 1, placeholderNames: ["API_TOKEN"] } }) }),
  "run-sandbox-openshell-bind.operator": () => runCard({ rec: record({ jobId: "gh-pulse", backend: "openshell-bind" }) }),
  "run-sandbox-kept.operator": () => runCard({ rec: record({ jobId: "gh-pulse", backend: "local" }), sandboxCheck: { retained: true, until: NOW + 23 * HOUR } }),
  "run-sandbox-past-window.operator": () => runCard({ rec: record({ jobId: "gh-pulse", backend: "local" }), sandboxCheck: { retained: false, why: "past-window" } }),
  "run-sandbox-swept.operator": () => runCard({ rec: record({ jobId: "gh-pulse", backend: "local" }), sandboxCheck: { retained: false, why: "swept" } }),
  "run-sandbox-replica.operator": () => runCard({ rec: record({ jobId: "gh-pulse-r2", replica: 2, replicas: 3 }), siblings: [record({ jobId: "gh-pulse-r1", outcome: "failed" }), record({ jobId: "gh-pulse-r3" })] }),
  "run-failed-no-reason.operator": () => runCard({ rec: record({ jobId: "gh-pulse", outcome: "failed", reason: null }) }),
  "run-failed-no-reason.viewer": () => runCard({ role: "viewer", rec: record({ jobId: "gh-pulse", outcome: "failed", reason: null }) }),
  "run-unknown-reason.viewer": () => runCard({ role: "viewer", rec: record({ jobId: "gh-pulse", outcome: "failed", reason: "future-refusal" }) }),
  "run-long-cron.operator": () => runCard({ rec: record({ jobId: `repeat:${"long-trigger".repeat(10)}:1791450000000`, kind: "local", target: "/workspace/repo", session: null }) }),
};
export const RUN_PANEL_STATES = Object.freeze(Object.keys(RUN_CARD_STATES));

const DRAW = {
  ...SANDBOX_DRAW,
  ...ZERO_TOUCH_DRAW,
  ...CONFIGURATION_DRAW,
  ...TRIGGER_LIST_DRAW,
  ...TRIGGER_DRAW,
  ...SPEND_DRAW,
  ...FLEET_DRAW,
  ...RUN_CARD_STATES,
  // ConfirmStates: the slot in every state, after the card that asked.
  "confirm-previewing.operator": async () => openSlotAfter(await fleetLive(), "p-fleetbar", { label: "Pause the fleet" }),
  "confirm-preview.operator": async () => {
    const answer = await actionWorld().preview("setting-set", { key: "maxTurns", value: "40" });
    return openSlotAfter(await screen("config"), "cf-settings", { inner: answerHtml(answer, 200, "setting-set") });
  },
  "confirm-preview-paid.operator": async () => {
    const answer = await actionWorld().preview("retry-failed", { jobId: "gh-5d10", queue: "pi-jobs" });
    return openSlotAfter(await fleetLive(), "p-failed", { inner: answerHtml(answer, 200, "retry-failed") });
  },
  "confirm-preview-danger.operator": async () => {
    const answer = await actionWorld().preview("fleet-pause");
    return openSlotAfter(await fleetLive(), "p-fleetbar", { inner: answerHtml(answer, 200, "fleet-pause") });
  },
  "confirm-unchanged.operator": async () => {
    const answer = await actionWorld().preview("setting-set", { key: "maxTurns", value: "30" });
    assert.equal(answer.body.unchanged, true, "the file already says so");
    return openSlotAfter(await screen("config"), "cf-settings", { inner: answerHtml(answer, 200, "setting-set, unchanged") });
  },
  "confirm-bulk-preview.operator": async () => {
    const answer = await actionWorld().preview("retry-all-failed", { queue: "pi-jobs" });
    return openSlotAfter(await fleetLive(), "p-failed", { inner: answerHtml(answer, 200, "retry-all-failed") });
  },
  "confirm-bulk-results.operator": async () => {
    const answer = await actionWorld().both("retry-all-failed", { queue: "pi-jobs" });
    assert.ok(answer.body.results.some((r) => !r.ok), "one job refused: the results stay in the slot");
    return openSlotAfter(await fleetLive(), "p-failed", { inner: answerHtml(answer, 200, "retry-all-failed confirm") });
  },
  "confirm-refused-preview.operator": async () => {
    const answer = await actionWorld().preview("setting-set", { key: "maxTurns", value: "lots" });
    return openSlotAfter(await screen("config"), "cf-settings", { inner: answerHtml(answer, 400, "setting-set, refused") });
  },
  "confirm-refused-confirm.operator": async () => {
    const world = actionWorld();
    const preview = await world.preview("retry-failed", { jobId: "gh-5d10", queue: "pi-jobs" });
    // The ticket's five minutes, and a second, pass before Confirm is pressed.
    world.advance(5 * MIN + 1000);
    const answer = await world.confirm("retry-failed", preview.body.ticket);
    return openSlotAfter(await fleetLive(), "p-failed", { inner: answerHtml(answer, 409, "retry-failed, expired") });
  },
  // A line with no space in it (the new window as JSON), which the bar must wrap at 375 px.
  "confirm-preview-long-line.operator": async () => {
    const answer = await actionWorld().preview("pause-window-add", { scope: "github:acme/api", from: "01:00", to: "02:00", tz: "UTC", days: "mon" });
    assert.match(answer.body.html ?? "", /<li>\{&quot;scope&quot;:&quot;github:acme\/api&quot;/, "the window's JSON is one of the bar's lines");
    return openSlotAfter(await screen("config"), "cf-pause-windows", { inner: answerHtml(answer, 200, "pause-window-add") });
  },
  // The longest names a bar draws (`LONG_NAMES`), on the overview, after the Hosts card that asked (in its column, so
  // under the card): Resume fleet over a fleet with two such host queues paused and the rest running, whose Undo and
  // waiting line name both; then one such host queue's Pause, its name in the summary, the Undo and the Confirm label.
  // The width check measures each bar at 375 px and in the side column.
  "confirm-preview-long-names.operator": async () => {
    const snap = longQueuesSnapshot([LONG_NAMES.host, LONG_NAMES.peer]);
    const answer = await actionWorld({ fleet: { snapshot: async () => snap } }).preview("fleet-resume");
    return openSlotAfter(await overviewLive(snap), "p-hosts", { inner: answerHtml(answer, 200, "fleet-resume, long names") });
  },
  "confirm-preview-long-queue.operator": async () => {
    const snap = longQueuesSnapshot([LONG_NAMES.host]);
    const answer = await actionWorld({ fleet: { snapshot: async () => snap } }).preview("queue-pause", { queue: `pi-jobs@${LONG_NAMES.peer}` });
    return openSlotAfter(await overviewLive(snap), "p-hosts", { inner: answerHtml(answer, 200, "queue-pause, long name") });
  },
  // The kill switch reached one Valkey and not the other: the one refusal that never says nothing was changed.
  "confirm-refused-partial.operator": async () => {
    const world = actionWorld({ fleet: { pause: async () => ({ results: [{ shown: "redis://valkey:6379", res: { ok: true, queues: ["pi-jobs"] } }, { shown: "redis://valkey-b:6379", res: null }] }) } });
    const answer = await world.both("fleet-pause");
    return openSlotAfter(await fleetLive(), "p-fleetbar", { inner: answerHtml(answer, 409, "fleet-pause, partial") });
  },
  // A page drawn for one person after another signed this browser in: the bar the server answers such a preview with
  // (`server.mjs`, the person check, which answers before any action runs).
  "confirm-refused-person.operator": async () => {
    const bar = String(refusalHtml({ where: "preview", sentence: PERSON_CHANGED, status: 409, state: "changed" }));
    return openSlotAfter(await fleetLive(), "p-queues", { inner: bar });
  },
  // A job that never started, held behind a busy host slot: its cancel, with the worker's own reason for the wait.
  "confirm-preview-cancel-queued.operator": async () => {
    const answer = await actionWorld({ rm: { planCancelQueued: async ({ jobId }) => ({ plan: QUEUED_PLAN(jobId) }) } }).preview("cancel-queued", { jobId: "gh-q9a1", queue: "pi-jobs@build3" });
    return openSlotAfter(await fleetLive(), "p-queues", { inner: answerHtml(answer, 200, "cancel-queued") });
  },
  // The same cancel, confirmed after the job started: refused, nothing changed, and a way to look again.
  "confirm-refused-started.operator": async () => {
    const world = actionWorld({
      rm: {
        planCancelQueued: async ({ jobId }) => ({ plan: QUEUED_PLAN(jobId) }),
        cancelQueuedJob: async ({ jobId }) => ({ invalid: `job ${jobId} started since the preview; nothing was changed` }),
      },
    });
    const answer = await world.both("cancel-queued", { jobId: "gh-q9a1", queue: "pi-jobs@build3" });
    return openSlotAfter(await fleetLive(), "p-queues", { inner: answerHtml(answer, 409, "cancel-queued, started") });
  },
  // The page after a write: the session's flash, drawn once as the done banner, with its Undo where the write has one.
  "confirm-done.operator": async () => {
    const answer = await actionWorld().both("fleet-pause");
    assert.equal(answer.status, 200);
    assert.equal(answer.body.change.inverse?.action, "fleet-resume", "a pause's way back is a resume");
    return fleetLive({ flash: answer.body.change });
  },
  // A re-run's Undo is decided at the confirm: the banner offers the cancel of the job it queued.
  "confirm-done-rerun.operator": async () => {
    const world = actionWorld({
      rm: {
        planRerun: async () => ({ plan: { kind: "cron", jobId: "cron:nightly:1760000000000", queue: "pi-jobs", schedule: {}, job: { flow: "nightly" }, runFields: null, reserve: { slots: 1, dollarsMicros: 2_000_000, capMicros: 2_000_000, zeroRated: false } } }),
        enqueueRerun: async () => ({ ok: true, jobId: "cron:nightly:1760010000000", queue: "pi-jobs" }),
      },
    });
    const answer = await world.both("rerun", { jobId: "cron:nightly:1760000000000" });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.change.inverse, { action: "cancel-queued", body: { jobId: "cron:nightly:1760010000000", queue: "pi-jobs" } }, "the way back is the cancel of the queued run");
    return fleetLive({ flash: answer.body.change });
  },
  "confirm-done-no-undo.operator": async () => {
    const answer = await actionWorld().both("cancel-held", { jobId: "gh-h41c" });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.change.inverse, null, "a cancelled hold has no way back");
    return fleetLive({ flash: answer.body.change });
  },
  // LiveStates: the pill and the one note each state shows.
  "live-reconnecting.operator": async () => showNote(markLive(await screen("fleet"), "retry"), "retry"),
  "live-not-live.operator": async () => showNote(markLive(await screen("fleet"), "off"), "limit"),
  "live-signed-out.operator": async () => showNote(markLive(await screen("fleet"), "out"), "out"),
  "live-stale.operator": async () => showStale(await fleetLive(), NOW - 2 * MIN),
  "live-kept-still.operator": async () => holdPanel(await fleetLive(), "p-failed"),
  // AccessStates: a console started read-only, for each role.
  "read-only.operator": async () => fleetLive({ readOnly: true }),
  "read-only.viewer": async () => fleetLive({ session: VIEWER, readOnly: true }),
  // AuditScreen: the newest row's link to the one before does not hold; then a damaged row with two written after it.
  "audit-damaged.operator": async () => auditPage(auditDeps({ rows: 5, tamper: (lines) => relink(lines, 4) })),
  "audit-not-verified.operator": async () => auditPage(auditDeps({ rows: 6, tamper: (lines) => relink(lines, 3) })),
  // OverviewAllClear: nothing needs a person, the same panels as the problem state; SetupScreen: the first run's
  // checklist with nothing ready but the console itself, then the card's own moment, for both roles; the waitlists
  // with each kind of wait alone (TimelineAndWaitlists, the OverviewScreen card's Waitlists); a host whose clock is out
  // of step, and one whose registry row has no expiry (the OverviewScreen card's Hosts).
  "overview-all-clear.operator": async () => overviewLive(overviewSnapshot(CALM)),
  "overview-all-clear.viewer": async () => overviewLive(overviewSnapshot(CALM), { session: VIEWER }),
  "setup-nothing-ready.operator": async () => overviewLive(firstRun()),
  "setup-partial.operator": async () => overviewLive(firstRun(SETUP_PARTIAL_DOCTOR)),
  "setup-partial.viewer": async () => overviewLive(firstRun(SETUP_PARTIAL_DOCTOR), { session: VIEWER }),
  ...Object.fromEntries(DEFER_BUCKETS.map((b) => [`waitlist-${b}.operator`, () => waitlist(b)])),
  "overview-host-skew.operator": async () => overviewLive(overviewSnapshot({ hostBudgets: hostsWith("build3", { staleMs: 120_000, ttlAgeMs: 12_000, skewMs: 108_000 }) })),
  "overview-host-no-expiry.operator": async () => overviewLive(overviewSnapshot({ hostBudgets: hostsWith("mini2", { noExpiry: true, ttlAgeMs: null }) })),
  // The longest names in running text (`LONG_NAMES`): a host's, its paused queue's, a gone host's queue's and a cron
  // trigger's, in the Hosts card, the Waitlists' sentences, the Queues line and Scheduled, with a long doctor label: the
  // page holds them at 375 px and in the side column, so the width check covers them.
  "overview-host-long-names.operator": async () => overviewLive(longNamesSnapshot()),
  // RunsScreen's footer, one state each: the fleet's run mirror off or partly read, the history read cut, the history
  // not read at all, nothing matching, and a reason token this console has no words for.
  "runs-mirror-off.operator": async () => runsLive({ page: { runs: RUNS_PAGE_RUNS, mirror: "off", next: null } }),
  "runs-mirror-degraded.operator": async () => runsLive({ page: { runs: RUNS_PAGE_RUNS, mirror: "degraded", next: null } }),
  "runs-truncated.operator": async () => runsLive({ page: { runs: RUNS_PAGE_RUNS, mirror: "ok", truncated: true, examined: 2000, next: Date.parse(RUNS_PAGE_RUNS[3].endedAt) } }),
  "runs-unreadable.viewer": async () => runsLive({ page: new Error("ECONNREFUSED"), window: null, session: VIEWER }),
  "runs-empty.viewer": async () => runsLive({ page: { runs: [], mirror: "ok", next: null }, session: VIEWER, query: "outcome=cancelled" }),
  "runs-unknown-reason.viewer": async () => runsLive({ page: { runs: [record({ jobId: "gh-77aa", outcome: "failed", reason: "hold-tight" })], mirror: "ok", next: null }, session: VIEWER }),
  // ParkedPhone: a question answerable here, one the planner refuses here, one a run is answering, one whose answer
  // scan could not tell, and nothing parked.
  "parked-approval.operator": async () => parkedLive([parkedRow({ reason: "awaiting-approval", approval: { requestId: "a".repeat(64), action: "budget-raise" } })]),
  "parked-approval.viewer": async () => parkedLive([parkedRow({ reason: "awaiting-approval", approval: { requestId: "b".repeat(64), action: "deploy:staging" } })], { session: VIEWER }),
  "parked-answerable.operator": async () => parkedLive([parkedRow({})]),
  "parked-unanswerable.operator": async () => parkedLive([parkedRow({})], { check: { refusal: "gh-2f6a parked on a pull request, whose reply must carry the trigger phrase (the receiver's rule: its key needs the head branch); answer on the forge" } }),
  "parked-being-answered.operator": async () => parkedLive([parkedRow({ pendingScan: { jobId: "gh-3c88" } })]),
  "parked-unknown.operator": async () => parkedLive([parkedRow({ pendingScan: { unknown: true } })]),
  "parked-empty.viewer": async () => parkedLive([], { session: VIEWER }),
  // ErrorPage: a run id the console looked for everywhere and did not find, the search holding it.
  "run-not-found.operator": async () => runNotFoundPage(OPERATOR),
  "run-not-found.viewer": async () => runNotFoundPage(VIEWER),
  // ConfirmStates: a preview the fleet did not answer in time; Resume fleet over a scan for the queues that did not
  // finish; and over more paused queues than a sentence names.
  "confirm-refused-timeout.operator": async () => {
    const bar = String(refusalHtml({ where: "preview", status: 503, sentence: SNAPSHOT_TIMEOUT_SENTENCE, state: "timeout" }));
    return openSlotAfter(await fleetLive(), "p-queues", { inner: bar });
  },
  "confirm-preview-resume-incomplete.operator": async () => {
    const snap = { ...longQueuesSnapshot([LONG_NAMES.host]), switchIncomplete: RM.SWITCH_SCAN_INCOMPLETE, switchTotal: 3, switchTruncated: false };
    const answer = await actionWorld({ fleet: { snapshot: async () => snap } }).preview("fleet-resume");
    return openSlotAfter(await overviewLive(snap), "p-hosts", { inner: answerHtml(answer, 200, "fleet-resume, scan incomplete") });
  },
  "confirm-preview-many-queues.operator": async () => {
    const snap = manyPausedSnapshot(24);
    const answer = await actionWorld({ fleet: { snapshot: async () => snap } }).preview("fleet-resume");
    return openSlotAfter(await overviewLive(snap), "p-hosts", { inner: answerHtml(answer, 200, "fleet-resume, many queues") });
  },
  // SignIn: why the last session ended, each reason; each refusal, and one no notice names (the server's sentence, as
  // the script sets it); the console out of reach.
  ...Object.fromEntries(ENDED_REASONS.map((r) => [`login-ended-${r}.anonymous`, () => loginPage({ theme: null, notice: r, limits: LIMITS, listen: "tcp" })])),
  ...Object.fromEntries(["wrong", "rate", "tokens", "audit"].map((k) => [`login-refused-${k}.anonymous`, () => loginPage({ theme: null, notice: k, limits: LIMITS, listen: "tcp" })])),
  "login-refused-other.anonymous": () => noticeText(String(loginPage({ theme: null, notice: "other", limits: LIMITS, listen: "tcp" })), OTHER_REFUSAL),
  "login-unreachable.anonymous": () => loginPage({ theme: null, notice: "unreachable", limits: LIMITS, listen: "tcp" }),
  // AccessStates: the one-time link's other two states; then each notice the link page can show (`LINK_NOTICES`): a
  // refusal is the used state with the notice that says why, except too many attempts, which the console answers
  // before it reads the code, so the link is not spent and the page keeps waiting; the console out of reach keeps
  // signing in.
  "login-code-used.anonymous": () => loginCodePage({ theme: null, state: "used" }),
  "login-code-nocode.anonymous": () => loginCodePage({ theme: null, state: "nocode" }),
  ...Object.fromEntries(["rate", "tokens", "audit"].map((k) => [`login-code-refused-${k}.anonymous`, () => loginCodePage({ theme: null, state: k === "rate" ? "wait" : "used", notice: k })])),
  "login-code-refused-other.anonymous": () => noticeText(String(loginCodePage({ theme: null, state: "used", notice: "other" })), OTHER_REFUSAL),
  "login-code-unreachable.anonymous": () => loginCodePage({ theme: null, state: "wait", notice: "unreachable" }),
};

/** The panel goldens' names, `<state>.<role>`, in order: the files `panels/` holds, and no other. */
export const PANEL_STATES = Object.freeze(Object.keys(DRAW));

/** Every panel golden's page, `{ [state]: html }`. */
export async function renderPanelStates() {
  const out = {};
  for (const state of PANEL_STATES) out[state] = String(await DRAW[state]());
  return out;
}
