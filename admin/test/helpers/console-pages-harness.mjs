import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tempDir } from "./temp-dir.mjs";

/**
 * The render behind `console-pages.test.mjs` (issue #641; moved here in issue #737 so later files can share it): the
 * canned deployment seeded through the project's own writers, every screen read and rendered for both roles at the
 * fixture's frozen instant (and once more for the operator on a read-only console), and the properties every rendered
 * page must hold (`assertClean`, `assertPanelsMatch`).
 *
 * HOW IT RUNS. The render happens in a CHILD process (this module, run with `CONSOLE_PAGES_CHILD` set), for
 * render-images' reasons: the readers take the clock from `Date` (the day's budget keys, a held job's age, a scheduler's
 * next fire), so `Date` is frozen at the fixture's `NOW` before any project module loads, and the environment is
 * emptied so no deployment pointer or key of this machine is read. The child writes its pages to a JSON file the parent
 * reads.
 *
 * Only the queue's live state is canned (`cannedQueues`, render-images' own): counts, workers, the active jobs and the
 * failed one, which only a running fleet produces. The pricing façade is the real one with its `piAiVersion` pinned to
 * the version the fixture's records carry, so a pi bump does not rewrite the spend footer.
 *
 * THE JOBS IN LINE (issue #737) are real: `WAITING_SEEDS`, added to the shared queue with BullMQ's own `add` and handed
 * to a real BullMQ Worker whose processor is the worker's own deferral (`defer-write.mjs` `makeDeferTo`): each job is
 * deferred with its reason (`deferTo`, which writes the record and moves the job to the delayed set) or fails once and
 * is retried on its backoff (`noteRetry`, then a throw), exactly as the processor does. So the overview's In line,
 * timeline and Waitlists read records and delayed jobs the shipped worker writes, through the real `readWaiting`. The
 * shared queue's waiting, delayed and paused counts are then read from it, so its counts agree with what waits. The
 * held job the fixture seeds (`gh-77c1`, held on `run.waitFor`) is one of them, deferred until its hold's instant.
 *
 * VALKEY: `VALKEY_TEST_URL`, database 8. Not render-images' 7: without a server binary on PATH that test seeds
 * database 7 of the same server, and the two files run concurrently. The database must be empty and is emptied again
 * when done. Without `VALKEY_TEST_URL` the render tests are skipped.
 *
 * THE PAGES THAT ARE NOT SCREENS (issue #737) are listed here too, in `STATIC_SHOTS`, and drawn in this process
 * with no deployment at all (`renderStatic`): the sign-in pages and the error pages, goldens beside the screens' in
 * `fixtures/console/`. The states of a page no deployment reaches (a preview open, a live note, a sign-in notice) are
 * `helpers/panel-goldens.mjs`'s, under `fixtures/console/panels/`.
 */

const SELF = fileURLToPath(import.meta.url);
// The frame's panels (`shell.mjs` `SHELL_PANEL_IDS`), for the parent's panel check. Imported in the parent alone: the
// child runs this file too, and there no project module may load before its clock is frozen.
const { SHELL_PANEL_IDS } = process.env.CONSOLE_PAGES_CHILD ? { SHELL_PANEL_IDS: [] } : await import("../../src/console/shell.mjs");
export const FIXTURES = fileURLToPath(new URL("../fixtures/console/", import.meta.url));
const BASE = process.env.VALKEY_TEST_URL;
const URL_8 = BASE ? `${BASE.replace(/\/\d*$/, "")}/8` : null;
export const skip = URL_8 === null ? "needs VALKEY_TEST_URL" : false;
const run = promisify(execFile);

/** The screens and the query each is rendered with. */
export const SHOTS = Object.freeze([
  ["overview", "overview", ""],
  // Issue #737: the timeline by host over its widest window, the overview's other grouping, through its query.
  ["overview-host", "overview", "rows=host&zoom=24h"],
  ["runs", "runs", ""],
  ["runs-filtered", "runs", "project=web&outcome=completed"],
  ["run", "run", "id=gh-2f6a"],
  // Issue #644: a running job's detail (no record yet), with a progress snapshot that declared phases and left a note.
  ["run-live", "run", "id=gh-b3d7"],
  ["parked", "parked", ""],
  ["insights", "insights", "range=7d"],
  // The what-if (the insights move to the console): a priced model over the fixture's ledgered fix runs, at the scan's
  // own ceiling, with the canned pricing below so a pi bump moves no byte of it.
  ["insights-whatif", "insights", "whatif=acme%2Fmodel-1&flow=fix"],
  ["fleet", "fleet", ""],
  ["config", "config", ""],
  ["audit", "audit", ""],
]);
export const ROLES = Object.freeze(["viewer", "operator"]);

/**
 * The pages that are not screens (issue #737), each a golden of its own beside the screens': the two sign-in pages
 * and the error pages, `<shot>.<role>`, the role `anonymous` where nobody is signed in (the sign-in pages, and the 421,
 * 503 and 500 pages, which never draw a session). A closed list, so every page the server can answer is held to the
 * page rules, a golden and the width check (which requires the two sign-in goldens by name). Drawn by the real modules
 * with no deployment at all (`renderStatic`), so `console-static-pages.test.mjs` needs no Valkey.
 */
export const STATIC_SHOTS = Object.freeze(["login.anonymous", "login-code.anonymous", "error-404.operator", "error-404.viewer", "error-400.operator", "error-403.viewer", "error-421.anonymous", "error-503.anonymous"]);

/** The people the static shots are drawn for: the screens' own (`renderInChild` signs them in by these names). */
const STATIC_SESSIONS = Object.freeze({ operator: Object.freeze({ name: "ops", role: "operator" }), viewer: Object.freeze({ name: "watcher", role: "viewer" }) });

/**
 * Every `STATIC_SHOTS` page, `{ [shot]: { status, html } }`, drawn as `server.mjs` draws it: the sign-in page with the
 * limits and the listen word a console started with no settings has (`consoleConfig`'s defaults, read the way
 * `getLogin` reads them: 60 idle minutes, 12 hours, a loopback TCP listener), the one-time link page in its first
 * state, and each error page through `errorPage` with the kind, status and session `sendFailure` gives it. A kind says
 * its own catalog sentence, so only the 400 is handed one: the page parser's refusal of a query it refuses. The 421
 * asks for the ErrorPage card's sample host and port (`myhost.lan`, 7788; the page prints the request's, whatever they
 * are). The project modules are imported here, never at the top of this file, which the child also runs: there they
 * must load after its clock is frozen.
 */
export async function renderStatic() {
  const { parsePageQuery } = await import("../../src/console/pages.mjs");
  const { loginCodePage, loginPage } = await import("../../src/console/shell.mjs");
  const { errorPage } = await import("../../src/console/error-pages.mjs");
  const { consoleConfig } = await import("../../src/console/config.mjs");
  const config = consoleConfig({ env: {}, dir: "/deployment" });
  assert.equal(config.listen.kind, "tcp", "the default console listens on loopback TCP");
  const limits = { idleMinutes: Math.floor(config.idleMs / 60000), maxHours: Math.floor(config.maxMs / 3600000) };
  const refusal = parsePageQuery("runs", "before=xyzzy").refusal;
  assert.equal(typeof refusal, "string", "the runs page refuses a cursor that is not a number");
  const err = (opts) => errorPage({ theme: null, readOnly: false, ...opts });
  const draws = {
    "login.anonymous": () => ({ status: 200, html: loginPage({ theme: null, notice: null, limits, listen: "tcp" }) }),
    "login-code.anonymous": () => ({ status: 200, html: loginCodePage({ theme: null }) }),
    "error-404.operator": () => err({ kind: "no-page", status: 404, session: STATIC_SESSIONS.operator }),
    "error-404.viewer": () => err({ kind: "no-page", status: 404, session: STATIC_SESSIONS.viewer }),
    "error-400.operator": () => err({ kind: "bad-query", status: 400, sentence: refusal, page: "runs", session: STATIC_SESSIONS.operator }),
    "error-403.viewer": () => err({ kind: "operators-only", status: 403, session: STATIC_SESSIONS.viewer }),
    "error-421.anonymous": () => err({ kind: "host", status: 421, host: "myhost.lan", port: 7788 }),
    "error-503.anonymous": () => err({ kind: "unavailable", status: 503 }),
  };
  assert.deepEqual(Object.keys(draws), [...STATIC_SHOTS], "a drawing for every static shot, in its order");
  return Object.fromEntries(STATIC_SHOTS.map((shot) => {
    const { status, html } = draws[shot]();
    return [shot, { status, html: String(html) }];
  }));
}

// Control bytes are built, never typed.
export const ESC = String.fromCharCode(27);
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const HOST_PATH_RE = /\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\//;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
// Inside a tag only: escaped text never holds a `<`, and a hostile value that reads "onload=" as text is the point.
const ACTIVE_MARKUP_RE = /<script(?! src="\/static\/console\.js" defer><\/script>)|<style|<[^>]*\s(?:on[a-z]+|style)\s*=|<[^>]*\s(?:href|src)\s*=\s*"?\s*javascript:/i;

/** The hostile values the second variant seeds. */
const HOSTILE = Object.freeze({
  jobId: `gh-<script>alert(1)</script>"'${ESC}[31m`,
  target: `acme/web"><script>alert(2)</script>${ESC}#7`,
  jsTarget: "javascript:alert(3)/x#5",
  reason: `SECRET-FAILURE-TEXT <img src=x onerror=alert(4)>${ESC}[0m`,
  activeId: `gh-<b onmouseover=alert(5)>`,
  // Issue #644: model text in the progress key. Raw control bytes on purpose, although the worker escapes them: the
  // console's own scrub is the belt this pins.
  phase: `<script>alert(6)</script>${ESC}[2J`,
  note: `PHASE-NOTE-TEXT <img src=x onerror=alert(7)>${ESC}]8;;x${String.fromCharCode(7)}`,
});

/**
 * The jobs waiting to start (issue #737), the OverviewScreen card's own: one per kind of wait the card draws. `host` is
 * the worker that deferred it (the record's host), `queuedMs` how long before `NOW` it was enqueued, and either `why`
 * with its `untilMs` after `NOW` (and the record's extras), or `retryMs`, the backoff of a job that fails its first of
 * three attempts. The fixture's own names: build3's slot is held by the cancelled gh-4a7e (an orphan of the registry),
 * gh-b3d7 runs on mini1, and gh-77c1 is the job the fixture holds on `run.waitFor` until 07:00 the next day.
 */
export const WAITING_SEEDS = Object.freeze([
  Object.freeze({ id: "gh-77c1", project: "web", repo: "acme/web", number: 415, host: "mini1", queuedMs: (2 * 3600 + 14 * 60) * 1000, why: "wait-after", untilMs: Date.UTC(2026, 9, 9, 7), trigger: 2 }),
  Object.freeze({ id: "gh-c9e1", project: "billing", repo: "acme/billing", number: 301, host: "build3", queuedMs: 3 * 60_000, why: "host-slot", untilMs: 5_000 }),
  Object.freeze({ id: "gh-d4f0", project: "web", repo: "acme/web", number: 455, host: "mini1", queuedMs: 6 * 60_000, why: "chained", untilMs: 5_000, holder: "gh-b3d7" }),
  Object.freeze({ id: "gh-71b2", project: "api", repo: "acme/api", number: 137, host: "mini1", queuedMs: 21 * 60_000, retryMs: 4 * 60_000 }),
  Object.freeze({ id: "gh-38aa", project: "web", repo: "acme/web", number: 448, host: "mini2", queuedMs: 16 * 60_000, retryMs: 9 * 60_000 }),
]);

/**
 * Put `WAITING_SEEDS` in line on the shared queue at `url`, through BullMQ and the worker's deferral (see the header):
 * add each, run a Worker whose processor defers or fails each as its seed says, and close it once all of them are in
 * the delayed set. `W` is the worker modules, `NOW` the frozen instant (an absolute `untilMs` is kept, a small one is
 * an offset from it).
 */
async function seedWaiting({ url, W, NOW }) {
  const { DelayedError, Worker } = await import("bullmq");
  const { makeDeferTo } = await import("../../../worker/src/defer-write.mjs");
  const redis = W.connection.makeRedisClient(url);
  const queue = W.queue.makeQueue(W.connection.parseConnection(url));
  const writers = new Map();
  // The writer's nonce is never shown; a counter keeps two renders' records alike.
  let n = 0;
  const nonce = () => (n += 1).toString(16).padStart(16, "0");
  // One deferral writer per host, as each host's processor builds its own, so the record names the host that deferred.
  const writerOf = (host) => {
    if (!writers.has(host)) writers.set(host, makeDeferTo({ redis, DelayedError, now: () => NOW, hostName: host, nonce }));
    return writers.get(host);
  };
  const seeds = new Map(WAITING_SEEDS.map((s) => [s.id, s]));
  let worker = null;
  try {
    for (const s of WAITING_SEEDS) {
      const data = { kind: "github", repo: s.repo, target: { type: "issue", number: s.number }, flow: "fix", ...(s.holder ? { parentJobId: s.holder } : {}), ...(s.trigger !== undefined ? { trigger: { matched: { index: s.trigger } } } : {}) };
      // No stack trace kept for the seeded failure: a trace names this machine's paths, and nothing reads it.
      const retry = s.retryMs ? { attempts: 3, backoff: { type: "fixed", delay: s.retryMs } } : {};
      await queue.add("github", data, { jobId: s.id, timestamp: NOW - s.queuedMs, stackTraceLimit: 0, ...retry });
    }
    worker = new Worker(
      W.queue.QUEUE,
      async (job, token) => {
        const s = seeds.get(job.id);
        const d = writerOf(s.host);
        if (s.retryMs) {
          await d.noteRetry(job, { project: s.project });
          throw new Error("seeded: the clone timed out");
        }
        const until = s.untilMs > NOW ? s.untilMs : NOW + s.untilMs;
        await d.deferTo(job, token, until, s.why, { project: s.project, ...(s.holder ? { holder: s.holder } : {}) });
      },
      { connection: W.connection.parseConnection(url) },
    );
    worker.on("error", () => {});
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // A real deadline (`performance`, which the frozen `Date` does not touch), generous for a loaded CI runner.
    const deadline = performance.now() + 60_000;
    for (;;) {
      const states = await Promise.all(WAITING_SEEDS.map((s) => queue.getJobState(s.id)));
      if (states.every((st) => st === "delayed")) break;
      if (performance.now() > deadline) throw new Error(`the waiting seeds did not all reach the delayed set: ${states.join(", ")}`);
      await sleep(25);
    }
  } finally {
    await worker?.close().catch(() => {});
    await queue.close().catch(() => {});
    redis.disconnect();
  }
}

/** The progress snapshots the child seeds (issue #644): a phased run on mini1, a phaseless one on the remote build3. */
function progressSeeds(NOW, hostile) {
  const base = { v: 1, interrupted: 0, prior: null, startedAt: NOW - 12 * 60_000, updatedAt: NOW - 2_000, ended: false, outcome: null, commentId: null };
  return {
    "gh-b3d7": {
      ...base,
      turn: 7,
      steps: 12,
      failed: 1,
      running: [{ tool: "bash", since: NOW - 40_000 }],
      recent: [
        { tool: "read", status: "ok", durationMs: 120, at: NOW - 90_000 },
        { tool: "bash", status: "error", durationMs: 2300, at: NOW - 60_000 },
        { tool: "edit", status: "ok", durationMs: null, at: NOW - 45_000 },
      ],
      phase: { index: 1, done: 3, total: 10 },
      phases: hostile ? ["survey", HOSTILE.phase, "verify", "report"] : ["survey", "migrate the schema", "verify", "report"],
      note: hostile ? HOSTILE.note : "three of ten tables migrated",
    },
    "gh-e802": { ...base, turn: 31, steps: 58, failed: 0, running: [], recent: [{ tool: "grep", status: "ok", durationMs: 15, at: NOW - 5_000 }], phase: null, phases: [], note: null, prior: { turns: 4, steps: 9 } },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The child: seed, read, render, write JSON. Runs only with CONSOLE_PAGES_CHILD set.
// ---------------------------------------------------------------------------------------------------------------------

async function renderInChild() {
  const variant = process.env.CONSOLE_PAGES_CHILD;
  const url = process.env.CONSOLE_PAGES_URL;
  const out = process.env.CONSOLE_PAGES_OUT;
  const { NOW, QUEUE_STATE, WORKERS, FAILED, RUNNING, LOCAL_HOST, PARKED, seedDeployment, writeDeployment } = await import("../../../launch/fixture-deployment.mjs");

  // The environment, emptied; the clock, frozen; both before any project module loads.
  for (const k of Object.keys(process.env)) delete process.env[k];
  const work = tempDir("console-pages-");
  Object.assign(process.env, { TZ: "UTC", HOME: join(work, "home"), PI_CODING_AGENT_DIR: join(work, "agent") });
  mkdirSync(process.env.HOME, { recursive: true });
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...a) {
      if (a.length === 0) super(NOW);
      else super(...a);
    }
    static now() {
      return NOW;
    }
  }
  globalThis.Date = FrozenDate;

  const W = {
    connection: await import("../../../worker/src/connection.mjs"),
    queue: await import("../../../worker/src/queue.mjs"),
    runHistory: await import("../../../worker/src/run-history.mjs"),
    runMirror: await import("../../../worker/src/run-mirror.mjs"),
    hostRegistry: await import("../../../worker/src/host-registry.mjs"),
    liveJobs: await import("../../../worker/src/live-jobs.mjs"),
    backends: await import("../../../worker/src/backends.mjs"),
    budget: await import("../../../worker/src/budget.mjs"),
    scopedLimits: await import("../../../worker/src/scoped-limits.mjs"),
    allocation: await import("../../../worker/src/allocation.mjs"),
    waitState: await import("../../../worker/src/wait-state.mjs"),
    dollarBudget: await import("../../../worker/src/dollar-budget.mjs"),
    doctorResults: await import("../../../worker/src/doctor-results.mjs"),
  };
  const RM = await import("../../src/read-model.mjs");
  const DW = await import("../../src/dollar-windows.mjs");
  const { assembleInsights } = await import("../../src/insights-assembly.mjs");
  const { makeWhatIfReader } = await import("../../src/console/whatif.mjs");
  const pricing = await import("../../../worker/src/pricing.mjs");
  const { makeConsoleAudit, readConsoleAudit, verifyConsoleAudit } = await import("../../../worker/src/console-audit.mjs");
  const { sessionKeyFor } = await import("../../../worker/src/session-key.mjs");
  const P = await import("../../src/console/pages.mjs");
  const version = JSON.parse(readFileSync(fileURLToPath(new URL("../../../worker/package.json", import.meta.url)), "utf8")).version;

  const admin = W.connection.makeRedisClient(url);
  admin.on?.("error", () => {});
  let seeded = false;
  let reader = null;
  const opened = [];
  try {
    const size = await admin.dbsize();
    if (size !== 0) throw new Error(`database 8 of VALKEY_TEST_URL holds ${size} keys: these render tests need it empty`);
    seeded = true;
    const deployment = join(work, "deployment");
    const paths = writeDeployment(deployment);
    const env = {
      VALKEY_URL: url,
      PI_WORKER_NAME: LOCAL_HOST,
      PI_LOG_RETENTION_DAYS: "30",
      PI_LOGS_DIR: paths.logs,
      PI_SETTINGS_FILE: paths.settings,
      PI_TRIGGERS_FILE: paths.triggers,
      PI_PAUSE_WINDOWS_FILE: paths.pause,
      PI_SCOPED_LIMITS_FILE: paths.limits,
      PI_PROJECTS_FILE: paths.projects,
      PI_ENVELOPE_FILE: paths.envelope,
      PI_SUBSCRIPTIONS_FILE: paths.subs,
      PI_GLOBAL_PI_DIR: paths.overlay,
    };
    Object.assign(process.env, env);
    // Issue #712: records naming a real venue, so the goldens are a normal local run's pages.
    await seedDeployment({ url, paths, mods: { W, RM, DW, version }, venue: "local" });
    // Issue #737: the jobs in line, through BullMQ and the worker's own deferral.
    await seedWaiting({ url, W, NOW });

    // The parked run's session chain counter, as the session store keeps it, so the inbox shows a known count.
    const sessionsDir = join(deployment, "sessions");
    const parkedKey = sessionKeyFor({ kind: "github", repo: PARKED.repo, target: { type: "issue", number: PARKED.number } });
    mkdirSync(join(sessionsDir, parkedKey), { recursive: true });
    writeFileSync(join(sessionsDir, parkedKey, "resume-chain"), "2\n");

    // The console's audit log: four rows through its own writer, then one damaged line.
    const audit = makeConsoleAudit({ logsDir: paths.logs, now: () => NOW - 3600_000, alive: () => true });
    audit.append({ actor: { name: "console", role: "operator", session: null }, action: "serve-started", outcome: "ok" });
    const at = (ms) => makeConsoleAudit({ logsDir: paths.logs, now: () => ms, alive: () => true });
    at(NOW - 1800_000).append({ actor: { name: "ops", role: "operator", session: "a1b2c3d4" }, action: "login", outcome: "ok" });
    at(NOW - 1700_000).append({ actor: { name: "anonymous", role: "none", session: null }, action: "login-failed", target: "/login", outcome: "refused", reason: "no token matched" });
    at(NOW - 1600_000).append({ actor: { name: "ops", role: "operator", session: "a1b2c3d4" }, action: "write", target: "pause-windows.json", outcome: "ok", beforeDigest: "0".repeat(64), afterDigest: "1".repeat(64), ticket: "abcdef012345" });
    appendFileSync(join(paths.logs, "console-audit", "2026-10.jsonl"), "this line is not an audit row\n");

    const hostile = variant === "hostile";
    // The progress keys (issue #644), written as the worker writes them (`serializeProgress` under `progressKeyFor`).
    const RP = await import("../../../worker/src/run-progress.mjs");
    for (const [id, snap] of Object.entries(progressSeeds(NOW, hostile))) await admin.set(RP.progressKeyFor(id), RP.serializeProgress(snap));
    if (hostile) {
      // Records written as a file another writer could leave: the local index reads every *.json in the logs dir.
      const base = { flow: "triage", host: "mini1", provider: "anthropic", model: "claude-sonnet-5-5", tokens: null, dollars: null };
      const iso = (ms) => new RealDate(ms).toISOString();
      writeFileSync(join(paths.logs, "hostile-1.json"), JSON.stringify({ ...base, jobId: HOSTILE.jobId, kind: "github", target: HOSTILE.target, outcome: "completed", reason: "awaiting-input", startedAt: iso(NOW - 9 * 60_000), endedAt: iso(NOW - 8 * 60_000) }));
      writeFileSync(join(paths.logs, "hostile-2.json"), JSON.stringify({ ...base, jobId: "gh-js01", kind: "github", target: HOSTILE.jsTarget, outcome: "completed", reason: "awaiting-input", startedAt: iso(NOW - 7 * 60_000), endedAt: iso(NOW - 6 * 60_000), parentJobId: HOSTILE.jobId }));
    }

    // The queue's live state, canned by queue name (render-images' own), with the real BullMQ queue for schedulers.
    const queueFn = (connection, { name = W.queue.QUEUE } = {}) => {
      const real = name === W.queue.QUEUE ? W.queue.makeQueue(connection) : null;
      if (real) opened.push(real);
      const host = name.includes("@") ? name.slice(name.indexOf("@") + 1) : null;
      const active = host ? [...(RUNNING[host] ?? [])].sort((a, b) => a.at - b.at).map((e) => ({ id: e.id, processedOn: e.at })) : [];
      if (hostile && host === "mini1") active.push({ id: HOSTILE.activeId, processedOn: NOW - 60_000 });
      const canned = { ...(QUEUE_STATE[name]?.counts ?? { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }) };
      return {
        name,
        isPaused: async () => false,
        // Issue #737: what waits in the shared queue is real (`seedWaiting`), so its counts are the queue's own.
        getJobCounts: async () => (real ? { ...canned, ...(await real.getJobCounts("waiting", "paused", "delayed")) } : canned),
        getWorkers: async () => WORKERS.map((w) => ({ name: w })),
        getJobSchedulers: (...a) => (real ? real.getJobSchedulers(...a) : Promise.resolve([])),
        getActive: async () => active,
        // Issue #647: the run page's Chat panel asks the queue for the job's state; an active job reads as active, with
        // no `.data` (so it is not steer-armed and its run id is its own), and any other id is not this queue's.
        getJob: async (id) => (active.some((e) => e.id === id) ? { id, data: {}, getState: async () => "active" } : null),
        // The pending-answer scan (issue #647) lists the running and waiting jobs: the running ones, with no `.data`.
        getJobs: async ([state]) => (state === "active" ? active.map((e) => ({ id: e.id, data: {} })) : []),
        getFailed: async () => (name === W.queue.QUEUE ? [hostile ? { ...FAILED, id: HOSTILE.jobId, failedReason: HOSTILE.reason } : { ...FAILED }] : []),
        pause: async () => {},
        resume: async () => {},
        close: async () => {},
      };
    };
    const fleetPaths = { ...RM.resolvePaths(env), sessionsDir };
    // The registry's rows as read the moment they were written (issue #737): a row's age is Valkey's own clock (its
    // PTTL against the TTL its beat set), which no frozen `Date` reaches, so a render a second slower would read its
    // rows a second older and draw another clock-skew sentence. Every live row reads its TTL whole, as at the beat; a
    // row with no expiry, or none at all, reads as it is. build3's beat, stamped 150 s before `NOW` on a row Valkey
    // keeps for 90 s, is then what the reader calls a clock out of step, which it is.
    const atBeat = (redis) => new Proxy(redis, {
      get(target, key) {
        if (key === "pttl") return async (k) => ((n) => (Number.isSafeInteger(n) && n > 0 ? W.hostRegistry.HOST_TTL_MS : n))(await target.pttl(k));
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    // As serve builds it (`cli.mjs`); the overview's load asks it for the waiting jobs (issue #737, `PAGE_READS`).
    reader = RM.createFleetReader(fleetPaths, { makeQueueFn: queueFn, dollarEnvFn: () => ({}), nowFn: () => NOW, readLiveHostsFn: (redis, opts) => W.hostRegistry.readLiveHosts(atBeat(redis), opts) });
    const deps = {
      fleet: reader,
      insights: (window) => assembleInsights(fleetPaths, window, { pricing: { ...pricing, piAiVersion: () => "0.99.1" }, nowMs: NOW, envFn: () => env }),
      // A canned catalog of two ids and a rate of $1 in and $5 out per million tokens: the what-if's own arithmetic over
      // the fixture's real records, with nothing a pi bump can move.
      whatIf: makeWhatIfReader({
        pricing: {
          getPricedModel: (p, id) => (p === "acme" && (id === "model-1" || id === "model-2") ? { provider: p, id } : null),
          listPricedModels: () => [{ provider: "acme", id: "model-1" }, { provider: "acme", id: "model-2" }],
          reprice: (q) => ({ usd: (q.input + 5 * q.output) / 1_000_000, ratesVersion: "0.99.1" }),
        },
        scan: () => RM.scanRunRecords({ logsDir: paths.logs, nowMs: NOW }),
        now: () => NOW,
      }),
      pricedModels: () => ["acme/model-1", "acme/model-2"],
      // The audit page as serve wires it (`cli.mjs` `pageDeps`, issue #737): the reader asked for each row's place, and
      // the chain's walk asked for its last good row, stamped with when it ran (serve caches it for 30 s, so the page
      // says how old it is). The fixture's four rows and the damaged line after them are what both read.
      audit: ({ limit, before, positions }) => readConsoleAudit({ logsDir: paths.logs, limit, before, positions }),
      auditVerify: () => ({ ...verifyConsoleAudit({ logsDir: paths.logs, withLast: true }), checkedAt: NOW }),
      subscriptions: () => RM.readSubscriptions({ subscriptionsPath: paths.subs }),
      env: { ...env, GITLAB_URL: "https://gitlab.example.com" },
      now: () => NOW,
    };
    const pages = {};
    const readOnly = {};
    // As serve draws a page (`server.mjs` `pageHandler`): with the token's live-stream limit a console started with no
    // settings has (PI_CONSOLE_MAX_STREAMS, 4), which a live page's limit note states, and no flash.
    const draw = async (name, ctx) => {
      const full = { ...ctx, theme: null, flash: null, maxStreams: 4 };
      const rendered = await P.renderPage(name, full);
      return { status: rendered.status, html: String(rendered.html), panels: await P.pagePanels(name, full) };
    };
    for (const [shot, name, qs] of SHOTS) {
      const parsed = P.parsePageQuery(name, new URLSearchParams(qs));
      if (parsed.refusal) throw new Error(`${shot}: ${parsed.refusal}`);
      const data = await P.loadPageData(name, parsed.query, deps);
      for (const role of ROLES) {
        pages[`${shot}.${role}`] = await draw(name, { query: parsed.query, session: { name: role === "operator" ? "ops" : "watcher", role }, data, readOnly: false });
      }
      // The operator's page on a read-only console (serve's read-only mode, issue #737 review round 2): the frame draws
      // its chip and every write form is withheld, so it is a page of its own, held to the same rules but to no golden.
      readOnly[shot] = await draw(name, { query: parsed.query, session: { name: "ops", role: "operator" }, data, readOnly: true });
    }
    if (hostile) {
      // The hostile run's own detail page: its id is outside the run-id charset, so the query is refused before any read.
      pages.hostileRunQuery = P.parsePageQuery("run", new URLSearchParams({ id: HOSTILE.jobId }));
    }
    writeFileSync(out, JSON.stringify({ pages, readOnly }));
  } finally {
    await reader?.dispose();
    await Promise.all(opened.map((q) => q.close().catch(() => {})));
    if (seeded) await admin.flushdb().catch(() => {});
    admin.disconnect();
  }
}

if (process.env.CONSOLE_PAGES_CHILD) {
  try {
    await renderInChild();
    process.exit(0);
  } catch (err) {
    console.error(err?.stack ?? err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The parent's side: the render in a child, and the checks every rendered page gets.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Render every screen in a child process for `variant` ("plain" or "hostile"): `{ pages, readOnly }`, where `pages` is
 * keyed `<shot>.<role>` (the goldens' names) and `readOnly` by shot alone, each the operator's page on a read-only
 * console. A page is `{ status, html, panels }`.
 */
export async function renderAll(variant) {
  const dir = tempDir("console-pages-out-");
  const out = join(dir, "pages.json");
  const env = { PATH: process.env.PATH ?? "", CONSOLE_PAGES_CHILD: variant, CONSOLE_PAGES_URL: URL_8, CONSOLE_PAGES_OUT: out, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };
  try {
    await run(process.execPath, [SELF], { env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`the render child failed:\n${err.stderr ?? err.message}`);
  }
  return JSON.parse(readFileSync(out, "utf8"));
}

/** A link out of the console that a person follows: http(s), and it hands the other page no opener and no Referer. */
const OUTBOUND_LINK_RE = /^<a [^>]*href="https?:\/\/[^"]+" rel="noreferrer noopener" target="_blank">$/;

/**
 * A start tag as a browser reads it: `<` and a letter, the name up to a space, `/` or `>`, then attributes up to the
 * first `>` that is not inside a quoted value (a quoted `>` does not end the tag, so `title="a>b" src=...` still has
 * its `src`).
 */
const TAG_RE = /<([A-Za-z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
/**
 * One attribute: its name after a space, a `/` (`<img/src=...>`) or straight after the closing quote of the one before
 * (`alt=""src=...`), all three of which a browser reads as a new attribute, and its value double-, single- or unquoted.
 */
const ATTR_RE = /(?:[\s/]|(?<=["']))([^\s=>"'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/**
 * Each start tag of a page, `{ tag, name, attrs }`, its name and attribute names lower-cased and its attributes as
 * `[name, value]` (null for a bare one). THE one parser every page rule reads, so an id in single quotes, an `<H1>`
 * and an unquoted `src` count the same as the forms `html` writes. Asserted to have read every tag the page opens
 * (each `<` before a letter: escaped text never holds a `<`), so a tag it cannot read fails the page instead of
 * hiding its attributes from every rule.
 */
function tagsOf(key, html) {
  const tags = [...html.matchAll(TAG_RE)].map((t) => ({
    tag: t[0],
    name: t[1].toLowerCase(),
    attrs: [...t[2].matchAll(ATTR_RE)].map((a) => [a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? null]),
  }));
  assert.equal(tags.length, (html.match(/<[A-Za-z]/g) ?? []).length, `${key}: the page rules read every tag it opens`);
  return tags;
}

/** Every `id` a page's tags carry, in order, a repeated one repeated. */
const idsOf = (tags) => tags.flatMap((t) => t.attrs.filter(([a, v]) => a === "id" && v !== null).map(([, v]) => v));

/**
 * The attributes whose value is one URL, on any element: `href`, `src`, `action`, `formaction`, `xlink:href`, `poster`,
 * `data` (an `<object>`'s), `background` (a table's, a cell's, the body's) and `codebase` (an `<object>`'s base, which
 * its `data` resolves against). On any element, never only the one that fetches it today: no element of the console
 * carries one of these names for anything but a URL, and a rule that asks which element it is on is one more place
 * for a gap.
 */
const URL_ATTRS = new Set(["src", "href", "action", "formaction", "xlink:href", "poster", "data", "background", "codebase"]);
/** The attributes whose value is a list of image candidates, "url width, url width": `srcset` and a preload's `imagesrcset`. */
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);
/** The five entities `html` writes; a browser decodes any other (`&#x2F;`, `&sol;`) into the URL it requests. */
const ENTITIES = Object.freeze({ "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" });

/**
 * An attribute's URL as the browser requests it: the five entities decoded (any other `&` fails: `/&#x2F;evil.example`
 * is `//evil.example`, a host), each tab and newline removed and the ends trimmed, as the URL parser does (`/` then a
 * newline then `/evil.example` is `//evil.example` too).
 */
function urlOf(key, value, tag) {
  const decoded = value.replace(/&(?:amp|quot|#39|lt|gt);/g, (e) => ENTITIES[e]);
  const at = value.replace(/&(?:amp|quot|#39|lt|gt);/g, "").indexOf("&");
  assert.equal(at, -1, `${key}: a URL attribute writes an & only as one of html's five entities (${tag.slice(0, 120)})`);
  return decoded.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
}

/**
 * Every reference a page makes is this console's own (issue #737 extends the spend screen's zero-external-requests rule
 * to every page): each `URL_ATTRS` value, every URL of a `srcset`, an `imagesrcset` and a `ping`, and each `url(...)`,
 * read as the browser reads it (`urlOf`), is a path on this console (`/...`, never `//host` or `/\host`) or an element
 * of this very page (`#id`, the skip link's `#main`, a sprite icon's `#i-name`, a pattern's `url(#hatch)`) whose `id`
 * the page holds; and no `<meta http-equiv>` at all, since a `refresh` is a navigation no attribute above names (the
 * headers are the server's, never the page's). The one exception is a link a person follows out of the console (a
 * run's issue on its forge, a reason's docs page): an `<a>`, never a request the page makes, and only in
 * `OUTBOUND_LINK_RE`'s shape, which is the one `kit.mjs` `outLink` writes (the kit test holds each of its link forms to
 * this rule).
 *
 * What it does NOT read: an `<iframe srcdoc>` (a whole document in one attribute), and the values SVG animation sets
 * (`<animate>`'s and `<set>`'s `values`, `from`, `to` and `by`, which can animate an `href`). No page draws either.
 * What they could FETCH the CSP holds instead: a `srcdoc` document inherits the page's policy, and an image or a
 * script an animation points elsewhere is refused by the same `img-src` and `script-src` the page's own answer to,
 * which the width check, reporting every violation, would show. A link an animation pointed elsewhere is not a
 * request, so nothing here or in the CSP stops it: a page that draws `<animate>` must first teach this rule to read it.
 */
export function assertOwnReferences(key, html) {
  const tags = tagsOf(key, html);
  const ids = new Set(idsOf(tags));
  const refs = [...html.matchAll(/url\(\s*([^)]*?)\s*\)/g)].map((m) => ({ attr: "url", ref: m[1].replace(/^["']|["']$/g, ""), tag: m[0] }));
  for (const { tag, attrs } of tags) {
    for (const [attr, value] of attrs) {
      if (attr === "http-equiv") assert.fail(`${key}: a <meta http-equiv> is a header in the page (${tag.slice(0, 120)})`);
      if (value === null) continue;
      if (URL_ATTRS.has(attr)) refs.push({ attr, ref: urlOf(key, value, tag), tag });
      // A srcset is "url width, url width"; a ping is URLs split on spaces.
      if (SRCSET_ATTRS.has(attr)) for (const part of value.split(",")) refs.push({ attr, ref: urlOf(key, part, tag).split(/\s+/)[0], tag });
      if (attr === "ping") for (const part of value.trim().split(/\s+/)) refs.push({ attr, ref: urlOf(key, part, tag), tag });
    }
  }
  assert.ok(refs.length > 5, `${key}: the check sees the page's references`);
  for (const { attr, ref, tag } of refs) {
    const own = /^#([a-z][a-z0-9-]*)$/.exec(ref);
    if (own) assert.ok(ids.has(own[1]), `${key}: ${ref} names an element this page holds`);
    else if (/^\/(?![/\\])/.test(ref)) continue;
    else assert.ok(attr === "href" && OUTBOUND_LINK_RE.test(tag), `${key}: ${attr}="${ref}" is neither this console's nor this page's (${tag.slice(0, 120)})`);
  }
}

/**
 * A page's structure (review D3, REQ-OPERATOR-CONSOLE-SCREENS), read off the parsed tags (`tagsOf`, so `id='x'` and
 * `<H1>` count): every id once, exactly one `<main>` and it is `#main` (the skip link's target), one `<h1>`, one icon
 * sprite (an element of class `sprite`), and every live panel (`data-panel`) an element that carries its `id` and
 * `data-panel` and nothing else, so the stream's swap of its inner HTML can never lose a class or a role it had.
 */
export function assertStructure(key, html) {
  const tags = tagsOf(key, html);
  const ids = idsOf(tags);
  const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  assert.deepEqual(twice, [], `${key}: every id once`);
  const mains = tags.filter((t) => t.name === "main");
  assert.equal(mains.length, 1, `${key}: one main`);
  assert.deepEqual(idsOf(mains), ["main"], `${key}: the main is #main`);
  assert.equal(tags.filter((t) => t.name === "h1").length, 1, `${key}: one h1`);
  assert.equal(tags.filter((t) => t.attrs.some(([a, v]) => a === "class" && v !== null && v.split(/\s+/).includes("sprite"))).length, 1, `${key}: one sprite`);
  for (const { tag, attrs } of tags.filter((t) => t.attrs.some(([a]) => a === "data-panel"))) {
    assert.deepEqual(attrs.map(([a]) => a).sort(), ["data-panel", "id"], `${key}: a panel carries only its id and data-panel (${tag})`);
  }
}

/** The properties every rendered page holds, whatever it shows. */
export function assertClean(key, html) {
  assert.ok(!CONTROL_RE.test(html), `${key} carries no control byte`);
  assert.doesNotMatch(html, HOST_PATH_RE, `${key} names no path of this machine`);
  assert.doesNotMatch(html, EMAIL_RE, `${key} holds no email address`);
  assert.doesNotMatch(html, ACTIVE_MARKUP_RE, `${key} carries no inline script, style, handler or javascript: link`);
  const host = hostname().split(".")[0];
  if (host.length >= 3) assert.ok(!html.toLowerCase().includes(host.toLowerCase()), `${key} does not name this machine`);
  assertOwnReferences(key, html);
  assertStructure(key, html);
}

/**
 * Each panel `pagePanels` returns is exactly the inner HTML of its element in the page: a screen's `<section>`, or one
 * of the frame's panels (`SHELL_PANEL_IDS`, issue #737), a `<span>`: the Parked count in the navigation, the headline
 * under the title.
 */
export function assertPanelsMatch(key, page) {
  assert.ok(page.panels.length > 0, `${key} has panels`);
  for (const { id, html } of page.panels) {
    assert.match(id, /^p-[a-z-]+$/, `${key}: panel id ${id}`);
    const tag = SHELL_PANEL_IDS.includes(id) ? "span" : "section";
    assert.ok(page.html.includes(`<${tag} id="${id}" data-panel>${html}</${tag}>`), `${key}: panel ${id} is the page's ${tag}, byte for byte`);
  }
}
