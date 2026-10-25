import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeConsoleAudit, readConsoleAudit, verifyConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import { NOW } from "../../../launch/fixture-deployment.mjs";
import { actionNamed, confirmAction, previewAction } from "../../src/console/actions.mjs";
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
 * card that asked (out of its `.legacy` wrapper, `script.mjs` `slotAnchor`), opened and filled with the answer's `html`
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
  schedulers: [{ key: "nightly-tidy", name: "nightly-tidy", pattern: "0 3 * * *", next: NOW + 11 * HOUR, overdueMs: 0 }],
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
 * `<main>`, where the shell draws it closed, and put after the panel, or after the `.legacy` wrapper the panel sits in
 * (`slotAnchor`), holding `inner` (an answer's `html`, a string), or the previewing skeleton titled for the button
 * that asked.
 */
function openSlotAfter(page, id, { inner = null, label = null }) {
  const closed = String(confirmSlotHtml());
  let out = once(page, closed, "", "the shell's closed slot");
  const head = `<section id="${id}" data-panel>`;
  const at = out.indexOf(head);
  assert.ok(at >= 0 && out.indexOf(head, at + 1) < 0, `the page holds panel ${id} once`);
  let end = sectionEnd(out, at);
  const wrapper = '<div class="legacy">';
  if (out.slice(at - wrapper.length, at) === wrapper) {
    assert.equal(out.slice(end, end + 6), "</div>", `${id}'s legacy wrapper closes after it`);
    end += 6;
  }
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

// ---- the states ----------------------------------------------------------------------------------------------------------

/**
 * Every panel golden, `<state>.<role>`, in the order the cards name them, each a function drawing its whole page. A
 * closed list: a file under `panels/` that is not one of these fails `console-panel-goldens.test.mjs`.
 */
const DRAW = {
  // ConfirmStates: the slot in every state, after the card that asked.
  "confirm-previewing.operator": async () => openSlotAfter(await fleetLive(), "p-queues", { label: "Pause the fleet" }),
  "confirm-preview.operator": async () => {
    const answer = await actionWorld().preview("setting-set", { key: "maxTurns", value: "40" });
    return openSlotAfter(await screen("config"), "p-settings", { inner: answerHtml(answer, 200, "setting-set") });
  },
  "confirm-preview-paid.operator": async () => {
    const answer = await actionWorld().preview("retry-failed", { jobId: "gh-5d10", queue: "pi-jobs" });
    return openSlotAfter(await fleetLive(), "p-failed", { inner: answerHtml(answer, 200, "retry-failed") });
  },
  "confirm-preview-danger.operator": async () => {
    const answer = await actionWorld().preview("fleet-pause");
    return openSlotAfter(await fleetLive(), "p-queues", { inner: answerHtml(answer, 200, "fleet-pause") });
  },
  "confirm-unchanged.operator": async () => {
    const answer = await actionWorld().preview("setting-set", { key: "maxTurns", value: "30" });
    assert.equal(answer.body.unchanged, true, "the file already says so");
    return openSlotAfter(await screen("config"), "p-settings", { inner: answerHtml(answer, 200, "setting-set, unchanged") });
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
    return openSlotAfter(await screen("config"), "p-settings", { inner: answerHtml(answer, 400, "setting-set, refused") });
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
    return openSlotAfter(await screen("config"), "p-pause-windows", { inner: answerHtml(answer, 200, "pause-window-add") });
  },
  // The kill switch reached one Valkey and not the other: the one refusal that never says nothing was changed.
  "confirm-refused-partial.operator": async () => {
    const world = actionWorld({ fleet: { pause: async () => ({ results: [{ shown: "redis://valkey:6379", res: { ok: true, queues: ["pi-jobs"] } }, { shown: "redis://valkey-b:6379", res: null }] }) } });
    const answer = await world.both("fleet-pause");
    return openSlotAfter(await fleetLive(), "p-queues", { inner: answerHtml(answer, 409, "fleet-pause, partial") });
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
