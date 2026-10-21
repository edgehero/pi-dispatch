import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * The console's screens rendered over the canned deployment (issue #641), in `render-images.test.mjs`'s style: the
 * fixture (`launch/fixture-deployment.mjs`) is written and seeded through the project's own writers, the page data is
 * read through the REAL `createFleetReader`, `readConsoleAudit` and `assembleInsights`, and every screen is rendered for
 * both roles at the fixture's frozen instant. Each page must be byte-identical to its committed fixture in
 * `admin/test/fixtures/console/<page>.<role>.html` and to a second render, carry no control byte, no path of this
 * machine and no email address, and keep the role rule. A second variant seeds hostile values (a job id and targets
 * holding `<script>`, quotes and control bytes, a `javascript:` repository, a failure reason) and checks each is
 * escaped or refused, and that a viewer's page carries no failure reason.
 *
 *   UPDATE_CONSOLE_FIXTURES=1 node --test test/console-pages.test.mjs    rewrite the fixtures from this render
 *
 * (then read the diff: the fixtures ARE the pages, so a change there is a change an operator will see).
 *
 * HOW IT RUNS. The render happens in a CHILD process (this file, run with `CONSOLE_PAGES_CHILD` set), for
 * render-images' reasons: the readers take the clock from `Date` (the day's budget keys, a held job's age, a scheduler's
 * next fire), so `Date` is frozen at the fixture's `NOW` before any project module loads, and the environment is
 * emptied so no deployment pointer or key of this machine is read. The child writes its pages to a JSON file the parent
 * reads.
 *
 * Only the queue's live state is canned (`cannedQueues`, render-images' own): counts, workers, the active jobs and the
 * failed one, which only a running fleet produces. The pricing façade is the real one with its `piAiVersion` pinned to
 * the version the fixture's records carry, so a pi bump does not rewrite the spend footer.
 *
 * VALKEY: `VALKEY_TEST_URL`, database 8. Not render-images' 7: without a server binary on PATH that test seeds
 * database 7 of the same server, and the two files run concurrently. The database must be empty and is emptied again
 * when done. Without `VALKEY_TEST_URL` the render tests are skipped.
 */

const SELF = fileURLToPath(import.meta.url);
const FIXTURES = fileURLToPath(new URL("./fixtures/console/", import.meta.url));
const BASE = process.env.VALKEY_TEST_URL;
const URL_8 = BASE ? `${BASE.replace(/\/\d*$/, "")}/8` : null;
const skip = URL_8 === null ? "needs VALKEY_TEST_URL" : false;
const run = promisify(execFile);

/** The screens and the query each is rendered with. */
const SHOTS = Object.freeze([
  ["overview", "overview", ""],
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
const ROLES = Object.freeze(["viewer", "operator"]);

// Control bytes are built, never typed.
const ESC = String.fromCharCode(27);
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
  const { NOW, QUEUE_STATE, WORKERS, FAILED, RUNNING, LOCAL_HOST, PARKED, seedDeployment, writeDeployment } = await import("../../launch/fixture-deployment.mjs");

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
    connection: await import("../../worker/src/connection.mjs"),
    queue: await import("../../worker/src/queue.mjs"),
    runHistory: await import("../../worker/src/run-history.mjs"),
    runMirror: await import("../../worker/src/run-mirror.mjs"),
    hostRegistry: await import("../../worker/src/host-registry.mjs"),
    liveJobs: await import("../../worker/src/live-jobs.mjs"),
    budget: await import("../../worker/src/budget.mjs"),
    scopedLimits: await import("../../worker/src/scoped-limits.mjs"),
    allocation: await import("../../worker/src/allocation.mjs"),
    waitState: await import("../../worker/src/wait-state.mjs"),
    dollarBudget: await import("../../worker/src/dollar-budget.mjs"),
  };
  const RM = await import("../src/read-model.mjs");
  const DW = await import("../src/dollar-windows.mjs");
  const { assembleInsights } = await import("../src/insights-assembly.mjs");
  const { makeWhatIfReader } = await import("../src/console/whatif.mjs");
  const pricing = await import("../../worker/src/pricing.mjs");
  const { makeConsoleAudit, readConsoleAudit } = await import("../../worker/src/console-audit.mjs");
  const { sessionKeyFor } = await import("../../worker/src/session-key.mjs");
  const P = await import("../src/console/pages.mjs");
  const version = JSON.parse(readFileSync(fileURLToPath(new URL("../../worker/package.json", import.meta.url)), "utf8")).version;

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
    const RP = await import("../../worker/src/run-progress.mjs");
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
      return {
        name,
        isPaused: async () => false,
        getJobCounts: async () => ({ ...(QUEUE_STATE[name]?.counts ?? { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }) }),
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
    reader = RM.createFleetReader(fleetPaths, { makeQueueFn: queueFn, dollarEnvFn: () => ({}), nowFn: () => NOW });
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
      audit: ({ limit, before }) => readConsoleAudit({ logsDir: paths.logs, limit, before }),
      subscriptions: () => RM.readSubscriptions({ subscriptionsPath: paths.subs }),
      env: { ...env, GITLAB_URL: "https://gitlab.example.com" },
      now: () => NOW,
    };
    const pages = {};
    for (const [shot, name, qs] of SHOTS) {
      const parsed = P.parsePageQuery(name, new URLSearchParams(qs));
      if (parsed.refusal) throw new Error(`${shot}: ${parsed.refusal}`);
      const data = await P.loadPageData(name, parsed.query, deps);
      for (const role of ROLES) {
        const ctx = { query: parsed.query, session: { name: role === "operator" ? "ops" : "watcher", role }, data, readOnly: false };
        const rendered = await P.renderPage(name, ctx);
        const panels = await P.pagePanels(name, ctx);
        pages[`${shot}.${role}`] = { status: rendered.status, html: String(rendered.html), panels };
      }
    }
    if (hostile) {
      // The hostile run's own detail page: its id is outside the run-id charset, so the query is refused before any read.
      pages.hostileRunQuery = P.parsePageQuery("run", new URLSearchParams({ id: HOSTILE.jobId }));
    }
    writeFileSync(out, JSON.stringify(pages));
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
// The parent: the tests.
// ---------------------------------------------------------------------------------------------------------------------

/** Render every screen in a child process for `variant` ("plain" or "hostile"). */
async function renderAll(variant) {
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

/** The properties every rendered page holds, whatever it shows. */
function assertClean(key, html) {
  assert.ok(!CONTROL_RE.test(html), `${key} carries no control byte`);
  assert.doesNotMatch(html, HOST_PATH_RE, `${key} names no path of this machine`);
  assert.doesNotMatch(html, EMAIL_RE, `${key} holds no email address`);
  assert.doesNotMatch(html, ACTIVE_MARKUP_RE, `${key} carries no inline script, style, handler or javascript: link`);
  const host = hostname().split(".")[0];
  if (host.length >= 3) assert.ok(!html.toLowerCase().includes(host.toLowerCase()), `${key} does not name this machine`);
}

/** Each panel `pagePanels` returns is exactly the inner HTML of its section in the page. */
function assertPanelsMatch(key, page) {
  assert.ok(page.panels.length > 0, `${key} has panels`);
  for (const { id, html } of page.panels) {
    assert.match(id, /^p-[a-z-]+$/, `${key}: panel id ${id}`);
    assert.ok(page.html.includes(`<section id="${id}" data-panel>${html}</section>`), `${key}: panel ${id} is the page's section, byte for byte`);
  }
}

test("console pages: every screen, both roles, byte-identical to the fixtures and to a second render", { skip, timeout: 400_000 }, async () => {
  const first = await renderAll("plain");
  const update = process.env.UPDATE_CONSOLE_FIXTURES === "1";
  if (update) mkdirSync(FIXTURES, { recursive: true });
  for (const [shot] of SHOTS) {
    for (const role of ROLES) {
      const key = `${shot}.${role}`;
      const file = join(FIXTURES, `${key}.html`);
      if (update) writeFileSync(file, first[key].html);
      assert.ok(existsSync(file), `${file} exists (UPDATE_CONSOLE_FIXTURES=1 writes it)`);
      assert.ok(first[key].html === readFileSync(file, "utf8"), `fixtures/console/${key}.html is not what the console renders now: run with UPDATE_CONSOLE_FIXTURES=1, read the diff, and commit it`);
    }
  }
  const second = await renderAll("plain");
  for (const [key, page] of Object.entries(first)) {
    assert.equal(second[key].html, page.html, `${key} is the same bytes on a second render`);
    assertClean(key, page.html);
  }
  // Status: the audit log is the operator's (the viewer gets the refusal page), and the parked run's detail exists.
  for (const [shot, name] of SHOTS) {
    assert.equal(first[`${shot}.operator`].status, 200, `${shot} for the operator`);
    assert.equal(first[`${shot}.viewer`].status, name === "audit" ? 403 : 200, `${shot} for a viewer`);
    if (!(name === "audit")) assertPanelsMatch(`${shot}.viewer`, first[`${shot}.viewer`]);
    assertPanelsMatch(`${shot}.operator`, first[`${shot}.operator`]);
  }
  // The role rule: the failure reason is the operator's, in a details element, and in no viewer page.
  const failed = "clone failed: remote rejected the token (403)";
  for (const [key, page] of Object.entries(first)) if (key.endsWith(".viewer")) assert.ok(!page.html.includes(failed), `${key} carries no failure reason`);
  assert.match(first["fleet.operator"].html, new RegExp(`<details><summary class="mono">gh-5d10</summary><p class="mono">${failed.replace(/[()]/g, "\\$&")}</p></details>`), "the operator's fleet page has the reason in a details element");
  assert.ok(!/<tr>[^]*?clone failed[^]*?<\/tr>/.test(first["fleet.operator"].html), "and never in a table row");
  assert.doesNotMatch(first["audit.viewer"].html, /serve-started|login-failed/, "a viewer's audit page shows no row");
  // What the screens show, spot-checked against the fixture.
  const overview = first["overview.operator"].html;
  assert.match(overview, /<h1>Overview<\/h1>/);
  assert.match(overview, /<body data-page="overview" data-live="overview" data-query="">/);
  assert.match(overview, /<a href="\/" aria-current="page">Overview<\/a>/);
  assert.match(first["overview.viewer"].html, /<nav aria-label="Console screens">/);
  assert.ok(!first["overview.viewer"].html.includes('href="/audit"'), "a viewer's nav has no audit link");
  assert.ok(overview.includes('href="/audit"'), "an operator's has");
  assert.match(first["parked.viewer"].html, /href="https:\/\/github\.com\/acme\/api\/issues\/131" rel="noreferrer noopener" target="_blank">acme\/api#131<\/a>/, "the parked run links to its issue");
  assert.match(first["parked.viewer"].html, /<td class="num">2<\/td>/, "with the session store's chain count");
  assert.match(first["run.viewer"].html, /awaiting-input/);
  // Issue #643: the live transcript section, outside every panel. The fixture's run has ended and Valkey holds no
  // stream for it, so the operator reads why and nothing is opened; a viewer reads that transcripts are operators'.
  assert.match(first["run.operator"].html, /<section id="transcript" class="transcript-section"><h2>Live transcript<\/h2><p class="note">No live transcript: not published \(PI_LIVE_TRANSCRIPTS=0\), expired, or not started yet\. Reload to check again\.<\/p><\/section><\/main>/);
  // Issue #712: a local run's page shows the command that reopens its sandbox.
  assert.match(first["run.operator"].html, /<code class="mono">pi-dispatch sandbox gh-2f6a<\/code>/);
  assert.match(first["run.viewer"].html, /<section id="transcript" class="transcript-section"><h2>Live transcript<\/h2><p class="note">Transcripts are shown to operators only\.<\/p><\/section><\/main>/);
  for (const key of ["run.operator", "run.viewer"]) assert.doesNotMatch(first[key].html, /data-transcript/, `${key}: no stream for an ended run without one`);
  // Issue #644: the active tables carry each job's progress as integers and a tool name, the remote host's job too; the
  // running job's detail shows its counters to everyone and its phase names, bar and note to the operator alone.
  for (const key of ["overview.viewer", "fleet.operator"]) {
    assert.match(first[key].html, /<th scope="col">Progress<\/th>/, key);
    assert.match(first[key].html, /<td>turn 7, 12 steps \(1 failed\), bash running 40s, phase 2\/4<\/td>/, `${key}: the phased run`);
    assert.match(first[key].html, /<td>turn 31, 58 steps<\/td>/, `${key}: the remote host's job`);
  }
  const liveRun = first["run-live.operator"].html;
  assert.equal(first["run-live.operator"].status, 200, "a running job without a record is a page, not a 404");
  assert.match(liveRun, /This run has no record yet/);
  assert.match(liveRun, /Current phase: <strong>migrate the schema<\/strong> <progress value="3" max="10">3 of 10<\/progress>/);
  assert.match(liveRun, /three of ten tables migrated/);
  const liveViewer = first["run-live.viewer"].html;
  assert.match(liveViewer, /<dt>Turn<\/dt><dd>7<\/dd>/, "a viewer gets the counters");
  assert.match(liveViewer, /Phase 2 of 4: 3 of 10 done/, "and the phase's integers");
  assert.match(liveViewer, /Phase names and the run's note are shown to operators only\./);
  for (const text of ["migrate the schema", "three of ten tables migrated", "<progress"]) {
    for (const [key, page] of Object.entries(first)) if (key !== "run-live.operator") assert.ok(!page.html.includes(text), `${key} carries no ${text}`);
  }
  assert.match(first["runs.viewer"].html, /<th scope="col">Job<\/th>/);
  assert.match(first["runs.viewer"].html, /href="\/runs\?before=\d+">Older runs<\/a>/, "the runs page pages by a cursor");
  assert.match(first["runs-filtered.viewer"].html, /value="web"/, "the filter form shows the query's values");
  assert.match(first["runs-filtered.viewer"].html, /href="\/runs\?project=web&amp;outcome=completed&amp;before=\d+">Older runs<\/a>/, "and paging keeps the filter");
  assert.match(first["insights.viewer"].html, /<ol id="insights-tips" class="hidden-tips" hidden><li>/, "the chart tooltips are listed");
  // The insights move to the console: the two-window line, the chips' data list, the what-if form, and its answer.
  assert.match(first["insights.viewer"].html, /<p id="windows" class="note">spend window: last 7d · topology: fixed 30d record window · series bounded by retention \(PI_LOG_RETENTION_DAYS\) and the 92-day scan cap<\/p>/);
  assert.match(first["insights.viewer"].html, /<ol id="graph-nodes" class="hidden-tips" hidden><li data-id="n0"/);
  assert.match(first["insights.viewer"].html, /<section id="p-whatif" data-panel><h2>What if<\/h2>/);
  assert.match(first["insights-whatif.viewer"].html, /<pre class="answer">What-if fix @ acme\/model-1:\n  estimate ~\$[\d.]+ est\. total · ~\$[\d.]+ est\. per run\n  coverage \d+% of observed runs ledgered/, "the estimate over the fixture's ledgered runs");
  assert.match(first["insights-whatif.operator"].html, /<h2>Spend and insights, last 30d<\/h2>/, "a what-if keeps the page's default window");
  assert.doesNotMatch(first["insights.viewer"].html, /Show full local paths/, "a viewer is offered no paths toggle");
  assert.match(first["insights.operator"].html, /Show full local paths/, "an operator is");
  assert.match(first["config.viewer"].html, /\.\.\.\/site/, "a local folder is shown by its basename");
  assert.match(first["config.viewer"].html, /<li class="mono">kimi-coding|linear/, "the configuration lists what the overlay holds");
  assert.match(first["audit.operator"].html, /Not an audit row: line 5 of 2026-10\.jsonl/, "a damaged audit line is a warning row");
});

test("console pages: hostile values are escaped or refused, and a viewer never sees a failure reason", { skip, timeout: 400_000 }, async () => {
  const pages = await renderAll("hostile");
  for (const [key, page] of Object.entries(pages)) {
    if (key === "hostileRunQuery") continue;
    assertClean(key, page.html);
    assert.ok(!page.html.includes("<script>alert"), `${key} has no live script from a value`);
    assert.ok(!page.html.includes("<b onmouseover"), `${key} has no live element from an active job id`);
    if (key.endsWith(".viewer")) assert.ok(!page.html.includes("SECRET-FAILURE-TEXT"), `${key} carries no failure reason`);
  }
  // Issue #644: the hostile phase name and note are escaped and scrubbed on the operator's run page, and absent from
  // every other page (a viewer's run page, every list, every hub panel).
  const liveRun = pages["run-live.operator"].html;
  assert.match(liveRun, /Current phase: <strong>&lt;script&gt;alert\(6\)&lt;\/script&gt; ?\[2J<\/strong>/, "the hostile phase name is text");
  assert.match(liveRun, /PHASE-NOTE-TEXT &lt;img src=x onerror=alert\(7\)&gt;/, "the hostile note is text");
  for (const [key, page] of Object.entries(pages)) {
    if (key === "hostileRunQuery" || key === "run-live.operator") continue;
    assert.ok(!page.html.includes("PHASE-NOTE-TEXT") && !page.html.includes("alert(6)"), `${key} carries no phase name or note`);
  }
  // The hostile run is listed, escaped, and NOT linked: its id is outside the run-id charset, so /run would answer 400.
  const runs = pages["runs.viewer"].html;
  assert.match(runs, /<span class="mono">gh-&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&#39; ?\[31m<\/span>/, "the hostile job id is plain text");
  assert.doesNotMatch(runs, /href="\/run\?id=gh-%3Cscript/, "with no dead link");
  const runLinks = [...runs.matchAll(/href="\/run\?id=([^"]*)"/g)].map((m) => decodeURIComponent(m[1]));
  assert.ok(runLinks.length > 5);
  const { parsePageQuery: parseQuery } = await import("../src/console/pages.mjs");
  for (const id of runLinks) assert.equal(parseQuery("run", new URLSearchParams({ id })).refusal, undefined, `every run link is one /run accepts: ${id}`);
  assert.match(runs, /<span class="mono">javascript:alert\(3\)\/x#5<\/span>/, "a javascript: repository is shown as text, never linked");
  assert.match(pages["parked.viewer"].html, /acme\/web&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt; ?#7/, "a hostile parked target is text");
  assert.match(pages["fleet.viewer"].html, /gh-&lt;b onmouseover=alert\(5\)&gt;/, "a hostile active job id is text");
  // The operator sees the reason, escaped and scrubbed, in its details element only.
  const fleet = pages["fleet.operator"].html;
  assert.match(fleet, /<details><summary class="mono">gh-&lt;script&gt;[^<]*<\/summary><p class="mono">SECRET-FAILURE-TEXT &lt;img src=x onerror=alert\(4\)&gt; ?\[0m<\/p><\/details>/);
  assert.ok(!/<td[^>]*>[^<]*SECRET-FAILURE-TEXT/.test(fleet), "never in a list cell");
  assert.ok(pages.hostileRunQuery.refusal, "the hostile run id is refused as a query before any read");
});

// ---------------------------------------------------------------------------------------------------------------------
// The query's bounds and the read discipline, on no deployment at all.
// ---------------------------------------------------------------------------------------------------------------------

test("parsePageQuery: each screen takes only its own parameters, bounded and charset-checked, and refuses without echoing", async () => {
  const { PAGES, QUERY_LIMITS, pageQueryString, parsePageQuery } = await import("../src/console/pages.mjs");
  const q = (name, qs) => parsePageQuery(name, new URLSearchParams(qs));
  assert.deepEqual(Object.keys(PAGES), ["overview", "runs", "run", "parked", "insights", "fleet", "config", "audit"]);
  assert.ok(Object.isFrozen(PAGES) && Object.values(PAGES).every(Object.isFrozen));
  assert.equal(PAGES.audit.auth, "operator");
  assert.ok(Object.values(PAGES).filter((p) => p.auth !== "operator").every((p) => p.auth === "viewer"));
  assert.match(q("nope", "").refusal, /no such page/);
  assert.match(q("__proto__", "").refusal, /no such page/);
  for (const name of ["overview", "parked", "fleet", "config"]) {
    assert.deepEqual(q(name, "").query, {});
    assert.match(q(name, "x=1").refusal, /takes no query parameters/);
  }
  // runs: the filter and a cursor.
  const runs = q("runs", "repo=acme/web&outcome=failed&before=1760000000000");
  assert.deepEqual(runs.query, { filter: { repo: "acme/web", outcome: "failed" }, before: 1760000000000 });
  assert.ok(Object.isFrozen(runs.query));
  assert.equal(pageQueryString("runs", runs.query), "repo=acme%2Fweb&outcome=failed&before=1760000000000");
  assert.deepEqual(q("runs", "").query, { filter: {}, before: null });
  // Issue #668: a priced model id with a leading @ or ~ is a runs filter, and paging keeps it.
  for (const model of ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "~anthropic/claude-opus-latest"]) {
    const byModel = q("runs", `model=${encodeURIComponent(model)}`);
    assert.deepEqual(byModel.query, { filter: { model }, before: null }, model);
    assert.deepEqual(q("runs", pageQueryString("runs", byModel.query)).query, byModel.query, `${model} round-trips`);
  }
  const hostile = `<script>"${ESC}`;
  for (const [qs, re] of [
    [`repo=${encodeURIComponent(hostile)}`, /repo must be/],
    [`q=${"a".repeat(QUERY_LIMITS.valueLength + 1)}`, /longer than 256/],
    ["before=12a", /before must be a whole number/],
    ["before=-5", /before must be a whole number/],
    [`before=${"9".repeat(17)}`, /before must be a whole number/],
    ["before=99999999999999999", /before must be a whole number/],
    ["repo=a&repo=b", /repo is given more than once/],
    ["before=1&before=2", /before is given more than once/],
    [`${encodeURIComponent(hostile)}=1`, /takes only repo, kind/],
    [Array.from({ length: QUERY_LIMITS.params + 1 }, (_, i) => `repo=${i}`).join("&"), /at most 16 parameters/],
  ]) {
    const r = q("runs", qs);
    assert.match(r.refusal ?? "", re, qs.slice(0, 60));
    assert.ok(!r.refusal.includes("<script") && !r.refusal.includes(ESC), "a refusal never echoes the value");
  }
  // run: an id in the read model's charset, required.
  assert.deepEqual(q("run", "id=repeat:nightly-tidy:1760000000000").query, { id: "repeat:nightly-tidy:1760000000000" });
  assert.match(q("run", "").refusal, /needs \?id=/);
  assert.match(q("run", "id=").refusal, /needs \?id=/);
  assert.match(q("run", `id=${encodeURIComponent(hostile)}`).refusal, /id must be a run id/);
  assert.match(q("run", "id=a%20b").refusal, /id must be a run id/);
  assert.match(q("run", `id=${"a".repeat(201)}`).refusal, /id must be a run id/);
  assert.match(q("run", "id=gh-1&x=2").refusal, /takes only id/);
  // insights: a closed range vocabulary, 30d by default (the static export's default, kept when the insights moved to
  // the console); the what-if pair, together or not at all; and paths=full.
  const none = { whatif: null, flow: null, paths: null };
  assert.deepEqual(q("insights", "").query, { range: "30d", ...none });
  for (const r of ["7d", "30d", "mtd"]) assert.deepEqual(q("insights", `range=${r}`).query, { range: r, ...none });
  for (const r of ["90d", "7D", "mtd ", "<x>"]) assert.match(q("insights", `range=${encodeURIComponent(r)}`).refusal, /range must be one of 7d, 30d, mtd/);
  const asked = q("insights", "range=7d&whatif=openrouter%2Fanthropic%2Fclaude-x&flow=fix-it&paths=full");
  assert.deepEqual(asked.query, { range: "7d", whatif: "openrouter/anthropic/claude-x", flow: "fix-it", paths: "full" });
  assert.equal(pageQueryString("insights", asked.query), "range=7d&whatif=openrouter%2Fanthropic%2Fclaude-x&flow=fix-it&paths=full");
  assert.deepEqual(q("insights", pageQueryString("insights", asked.query)).query, asked.query, "the string round-trips");
  for (const [qs, re] of [
    ["whatif=anthropic%2Fx", /whatif and flow go together/],
    ["flow=tidy", /whatif and flow go together/],
    ["whatif=noslash&flow=tidy", /whatif must be <provider>\/<model>/],
    ["whatif=%2Fx&flow=tidy", /whatif must be <provider>\/<model>/],
    ["whatif=a%2F&flow=tidy", /whatif must be <provider>\/<model>/],
    [`whatif=a%2F${encodeURIComponent(hostile)}&flow=tidy`, /whatif must be <provider>\/<model>/],
    [`whatif=a%2F${"m".repeat(129)}&flow=tidy`, /whatif must be <provider>\/<model>/],
    ["whatif=a%2Fb&flow=Tidy", /flow must be a flow name/],
    [`whatif=a%2Fb&flow=${encodeURIComponent(hostile)}`, /flow must be a flow name/],
    ["paths=absolute", /paths must be full/],
    ["paths=full&paths=full", /paths is given more than once/],
    ["fullPaths=1", /takes only range, whatif, flow, paths/],
  ]) {
    const r = q("insights", qs);
    assert.match(r.refusal ?? "", re, qs);
    assert.ok(!r.refusal.includes("<script") && !r.refusal.includes(ESC), "a refusal never echoes the value");
  }
  // audit: readConsoleAudit's cursor exactly, `YYYY-MM:<line>`, kept as the string the reader takes.
  assert.deepEqual(q("audit", "before=2026-10:12").query, { before: "2026-10:12" });
  assert.deepEqual(q("audit", "before=2026-10%3A1").query, { before: "2026-10:1" }, "the link's encoded colon");
  assert.deepEqual(q("audit", `before=2026-10:${"9".repeat(15)}`).query, { before: `2026-10:${"9".repeat(15)}` });
  assert.equal(pageQueryString("audit", { before: "2026-10:12" }), "before=2026-10%3A12");
  assert.deepEqual(q("audit", pageQueryString("audit", { before: "2026-10:12" })).query, { before: "2026-10:12" }, "the string round-trips");
  for (const b of ["12", "12.5", "2026-10:0", "2026-10:012", "2026-1:5", "2026-10:-1", "2026-10:1e3", "2026-10:12 ", " 2026-10:12", "2026-10:1:2", "2026-10", `2026-10:${"9".repeat(16)}`, "abc"]) {
    assert.match(q("audit", `before=${encodeURIComponent(b)}`).refusal, /before must be an audit position \(YYYY-MM:line/, b);
  }
  // A plain object and a string are read like URLSearchParams; a non-string value refuses.
  assert.deepEqual(parsePageQuery("run", { id: "gh-1" }).query, { id: "gh-1" });
  assert.deepEqual(parsePageQuery("run", "id=gh-1").query, { id: "gh-1" });
  assert.match(parsePageQuery("run", { id: ["gh-1"] }).refusal, /not readable/);
});

test("loadPageData reads only what a screen shows, the snapshot at most once, and keeps no env but the forge hosts", async () => {
  const { loadPageData, parsePageQuery, PAGES } = await import("../src/console/pages.mjs");
  for (const name of Object.keys(PAGES)) {
    const calls = { snapshot: 0, runsPage: 0, runById: 0, transcriptMeta: 0, insights: 0, audit: 0, subscriptions: 0 };
    const deps = {
      fleet: {
        snapshot: async () => (calls.snapshot++, { parked: [] }),
        runsPage: async () => (calls.runsPage++, { runs: [], next: null, mirror: "off" }),
        runById: async () => (calls.runById++, { record: { jobId: "gh-1", startedAt: "2026-10-08T00:00:00Z" }, source: "local" }),
        transcriptMeta: async () => (calls.transcriptMeta++, { exists: true, ended: false, outcome: null, length: 3, firstId: "1-0", lastId: "3-0" }),
      },
      insights: async () => (calls.insights++, {}),
      audit: async () => (calls.audit++, { rows: [], next: null }),
      subscriptions: () => (calls.subscriptions++, { subscriptions: [] }),
      env: { GITLAB_URL: "https://gl.example", GITHUB_TOKEN: "ghp_secret", VALKEY_URL: "redis://x" },
      now: () => 1234,
    };
    const query = parsePageQuery(name, name === "run" ? "id=gh-1" : "").query;
    const data = await loadPageData(name, query, deps);
    assert.equal(data.now, 1234, `${name}: the clock is read once, into the data`);
    assert.deepEqual(data.env, { GITLAB_URL: "https://gl.example" }, `${name}: only forge host variables are kept`);
    assert.ok(calls.snapshot <= 1, `${name}: snapshot at most once`);
    const expected = { overview: ["snapshot"], runs: ["runsPage", "subscriptions"], run: ["runById", "runsPage", "subscriptions", "transcriptMeta"], parked: ["snapshot"], insights: ["insights"], fleet: ["snapshot"], config: ["snapshot"], audit: ["audit"] }[name];
    assert.deepEqual(Object.keys(calls).filter((k) => calls[k] > 0).sort(), [...expected].sort(), `${name} reads ${expected.join(", ")}`);
    if (name === "run") assert.deepEqual(data.transcript, { exists: true, ended: false, outcome: null, length: 3 }, "the stream's facts only, never an id or a byte of text");
  }
  // A read that throws is a stated absence, never a thrown page.
  const broken = { fleet: { snapshot: async () => { throw new Error("down"); }, runsPage: async () => { throw new Error("down"); }, runById: async () => { throw new Error("down"); }, transcriptMeta: async () => { throw new Error("down"); } }, insights: async () => { throw new Error("down"); }, audit: async () => { throw new Error("down"); }, now: 1 };
  assert.equal((await loadPageData("overview", {}, broken)).snapshot, null);
  assert.equal((await loadPageData("runs", { filter: {}, before: null }, broken)).runsPage, null);
  assert.deepEqual((await loadPageData("run", { id: "x" }, broken)).run, { missing: true });
  assert.deepEqual((await loadPageData("run", { id: "x" }, broken)).transcript, { unreachable: true, exists: false }, "a transcript read that throws is a stated absence");
  assert.match((await loadPageData("insights", { range: "7d" }, broken)).insightsError, /could not be assembled/);
  assert.equal((await loadPageData("audit", { before: null }, broken)).audit, null);
});

test("the run page says the transcript could not be read when transcriptMeta is unreachable, never that it has not started", async () => {
  const { loadPageData, renderPage } = await import("../src/console/pages.mjs");
  const session = { name: "ops", role: "operator" };
  const fleetWith = (meta) => ({ runById: async () => ({ missing: true }), runsPage: async () => ({ runs: [], next: null, mirror: "off" }), transcriptMeta: async () => meta });
  for (const meta of [{ unreachable: "timed out reaching the transcript" }, { unreachable: "the transcript could not be read (ECONNREFUSED)" }]) {
    const data = await loadPageData("run", { id: "gh-1" }, { fleet: fleetWith(meta), subscriptions: () => ({ subscriptions: [] }), now: () => 1 });
    assert.deepEqual(data.transcript, { unreachable: true, exists: false }, `${meta.unreachable}: a stated failure`);
    const html = String((await renderPage("run", { query: { id: "gh-1" }, session, data, readOnly: false })).html);
    assert.match(html, /The live transcript could not be read \(is Valkey reachable\?\)/, meta.unreachable);
    assert.doesNotMatch(html, /not started yet/, "an unreachable Valkey is not an absent stream");
    assert.doesNotMatch(html, /data-transcript/, "and no stream is opened on it");
    assert.ok(!html.includes(meta.unreachable), "the reader's reason itself is not shown");
  }
  // The same page with the stream merely absent says why, and watches.
  const absent = await loadPageData("run", { id: "gh-1" }, { fleet: fleetWith({ exists: false, ended: false, outcome: null, length: 0, firstId: null, lastId: null }), subscriptions: () => ({ subscriptions: [] }), now: () => 1 });
  assert.match(String((await renderPage("run", { query: { id: "gh-1" }, session, data: absent, readOnly: false })).html), /not started yet/);
});

test("the run page reads progress by the run (progressOfRun), handing it the record, and pairs a continued attempt with its own record (issue #662)", async () => {
  const { loadPageData, renderPage } = await import("../src/console/pages.mjs");
  const session = { name: "ops", role: "operator" };
  const record = { jobId: "gh-1", outcome: "failed", reason: "recovery-enqueued", startedAt: "2026-10-17T10:00:00.000Z", endedAt: "2026-10-17T10:03:00.000Z", progress: { turns: 4, steps: 6 } };
  const key = { v: 1, turn: 1, steps: 0, failed: 0, interrupted: 0, running: [], recent: [], phase: null, phases: [], note: null, prior: null, startedAt: 2, updatedAt: 3, ended: false, outcome: null };
  const calls = [];
  const fleet = {
    runById: async () => ({ record }),
    runsPage: async () => ({ runs: [], next: null, mirror: "off" }),
    progress: async (id) => (calls.push(["progress", id]), key),
    progressOfRun: async (id, rec) => (calls.push(["progressOfRun", id, rec?.reason ?? null]), { progress: key, continues: true, continuesAs: "gh-1.r1" }),
  };
  const data = await loadPageData("run", { id: "gh-1" }, { fleet, subscriptions: () => ({ subscriptions: [] }), now: () => 1 });
  assert.deepEqual(calls, [["progressOfRun", "gh-1", "recovery-enqueued"]], "one read, by the run, after the record");
  assert.deepEqual(data.progressContinues, { as: "gh-1.r1" });
  const html = String((await renderPage("run", { query: { id: "gh-1" }, session, data, readOnly: false })).html);
  assert.match(html, /This run continues as <a class="mono" href="\/run\?id=gh-1\.r1">gh-1\.r1<\/a>/);
  assert.match(html, /<dt>Turns<\/dt><dd>4<\/dd>/);
  // A run that does not continue: no marker, the key as read, the pairing as before.
  calls.length = 0;
  const plain = await loadPageData("run", { id: "gh-1" }, { fleet: { ...fleet, progressOfRun: async () => ({ progress: key, continues: false, continuesAs: null }) }, subscriptions: () => ({ subscriptions: [] }), now: () => 1 });
  assert.equal(Object.hasOwn(plain, "progressContinues"), false);
  assert.equal(plain.progress, key);
  // A fleet without progressOfRun reads by the page's id, as before; one that throws is unreachable.
  const { progressOfRun: _drop, ...older } = fleet;
  assert.equal((await loadPageData("run", { id: "gh-1" }, { fleet: older, subscriptions: () => ({ subscriptions: [] }), now: () => 1 })).progress, key);
  const down = await loadPageData("run", { id: "gh-1" }, { fleet: { ...fleet, progressOfRun: async () => { throw new Error("down"); } }, subscriptions: () => ({ subscriptions: [] }), now: () => 1 });
  assert.deepEqual(down.progress, { unreachable: true });
  // Review: a continued attempt whose read threw still shows its own record and says it continues, not the failure.
  assert.deepEqual(down.progressContinues, { as: null });
  const downHtml = String((await renderPage("run", { query: { id: "gh-1" }, session, data: down, readOnly: false })).html);
  assert.match(downHtml, /This run continues as a recovery job\./);
  assert.match(downHtml, /<dt>Turns<\/dt><dd>4<\/dd>/);
  assert.doesNotMatch(downHtml, /progress could not be read/);
  // An answer with no progress at all reads as unreachable, never as a snapshot or an absence.
  for (const answer of [null, {}, { continues: false }]) {
    const odd = await loadPageData("run", { id: "gh-1" }, { fleet: { ...fleet, progressOfRun: async () => answer }, subscriptions: () => ({ subscriptions: [] }), now: () => 1 });
    assert.deepEqual(odd.progress, { unreachable: true }, JSON.stringify(answer));
  }
  // A hostile recovery job id from the reader is dropped here, before any panel sees it.
  for (const as of ['gh-1.r1"><script>', "", 7]) {
    const hostile = await loadPageData("run", { id: "gh-1" }, { fleet: { ...fleet, progressOfRun: async () => ({ progress: key, continues: true, continuesAs: as }) }, subscriptions: () => ({ subscriptions: [] }), now: () => 1 });
    assert.deepEqual(hostile.progressContinues, { as: null }, JSON.stringify(as));
  }
});

test("the audit page's Older rows link carries readConsoleAudit's own cursor, which parsePageQuery takes back to the next page", async () => {
  const { AUDIT_PER_PAGE, loadPageData, parsePageQuery, renderPage } = await import("../src/console/pages.mjs");
  const { makeConsoleAudit, readConsoleAudit } = await import("../../worker/src/console-audit.mjs");
  const logsDir = tempDir("console-audit-pager-");
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
  const total = AUDIT_PER_PAGE + 2;
  for (let i = 0; i < total; i++) makeConsoleAudit({ logsDir, now: () => NOW + i, alive: () => true }).append({ actor: { name: "ops", role: "operator", session: null }, action: "login", target: `row-${i}`, outcome: "ok" });
  const deps = { audit: ({ limit, before }) => readConsoleAudit({ logsDir, limit, before }), now: () => NOW };
  const session = { name: "ops", role: "operator" };
  const first = parsePageQuery("audit", "").query;
  const page1 = await renderPage("audit", { query: first, session, data: await loadPageData("audit", first, deps), readOnly: false });
  const href = /href="\/audit\?([^"]+)">Older rows<\/a>/.exec(String(page1.html))?.[1];
  assert.ok(href, "the first page links to older rows");
  const parsed = parsePageQuery("audit", href.replaceAll("&amp;", "&"));
  assert.equal(parsed.refusal, undefined, String(parsed.refusal));
  const data2 = await loadPageData("audit", parsed.query, deps);
  assert.equal(data2.audit.unreadable, undefined, String(data2.audit.unreadable));
  assert.deepEqual(data2.audit.rows.map((r) => r.target), ["row-1", "row-0"], "the next page is the two oldest rows");
});

test("renderPage answers 404 for a run that does not exist, and the stream's panels are the page's sections", async () => {
  const { pagePanels, renderPage } = await import("../src/console/pages.mjs");
  const ctx = { query: { id: "gh-404" }, session: { name: "a", role: "viewer" }, data: { now: 0, env: {}, run: { missing: true } }, readOnly: true };
  const page = await renderPage("run", ctx);
  assert.equal(page.status, 404);
  const html = String(page.html);
  assert.match(html, /No run with that id/);
  assert.match(html, /read-only console/);
  assert.match(html, /<body data-page="run" data-live="run" data-query="id=gh-404">/, "the run detail is live (issue #644: its progress panel moves)");
  for (const { id, html: inner } of await pagePanels("run", ctx)) assert.ok(html.includes(`<section id="${id}" data-panel>${inner}</section>`), id);
});
