import { withOperatorDiagnosis } from "./helpers/tool-diagnosis.mjs";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { executeToolAction, TOOL_ACTIONS } from "../src/tool-actions.mjs";
import * as readModel from "../src/read-model.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { request } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { panelWrite } from "../src/audited-write.mjs";
import { stripAnsi } from "../src/style.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { fakeAllocRedis } from "./helpers/fake-alloc-redis.mjs";
import { CONSOLE_AUDIT_FIELD_MAX } from "@edgehero/pi-dispatch/console-audit";
import { escapeControls } from "@edgehero/pi-dispatch/projects";
import { HOST_SET, hostKey } from "@edgehero/pi-dispatch/host-registry";
import { REPLY_ERROR_CLASSES } from "@edgehero/pi-dispatch/reply-error-class";
import { queueErrorsLine, switchShortCause, switchShortNote } from "../src/words.mjs";
import { PRUNE_SCRIPT, READ_SCRIPT, TRIM_SCRIPT } from "@edgehero/pi-dispatch/run-mirror";
import { HELD_SET, jobKey as heldKey } from "@edgehero/pi-dispatch/wait-state";
import { sanitizeJobId } from "@edgehero/pi-dispatch/run-history";
import { makeQueue } from "@edgehero/pi-dispatch/queue";
import { parseConnection } from "@edgehero/pi-dispatch/connection";
import { ACTIONS } from "../src/console/actions.mjs";
import { runCli } from "../src/console/cli.mjs";
import { PAGES } from "../src/console/pages.mjs";
import { recordingProxy, scriptCommands } from "./helpers/recording-proxy.mjs";

// Issue #642's review: EVERY panel write surface, driven through the real extension the way pi drives it, appends its
// audit row (actor role `panel`) before its write lands, and a `failed` row after one that did not land. One table row
// per audited call site in index.ts, secrets-command.ts and dashboard.ts (`withAuditedWrites`), and a source scan holds
// the table to the sites: a new write path with no row, or a row whose site is gone, fails here.
//
// Each row runs twice: against a working audit directory (the rows, and the write landed), and, where the write leaves
// something to look at, against a logs directory whose `console-audit` is a FILE, so the real writer's append throws
// (nothing may change then: that is what "audit, then write" means). The writes that need a queue run against a
// Valkey that is not there (127.0.0.1:1), so they fail after their ok row and never touch a real queue; the held-job
// cancel needs a held row to find first, so it runs on database 9 of VALKEY_TEST_URL and skips without one.

// The deployment pointer, set before the extension's factory first runs (it layers the pointer once per process): its
// folder's `.env` is what the kill switch compares this process's VALKEY_URL with, so a row can make the two disagree.
const DEPLOYMENT = tempDir("pd-642-wiring-dep-");
const ENV_FILE = join(DEPLOYMENT, ".env");
const QUIET_ENV = "# the wiring test's deployment\n";
writeFileSync(ENV_FILE, QUIET_ENV);
const POINTER = join(tempDir("pd-642-wiring-ptr-"), "deployment.json");
writeFileSync(POINTER, JSON.stringify({ version: 1, deploymentDir: DEPLOYMENT }));
process.env.PI_DISPATCH_DEPLOYMENT_FILE = POINTER;
const NO_VALKEY = "redis://127.0.0.1:1";
process.env.VALKEY_URL = NO_VALKEY;
delete process.env.PI_MAX_COST_USD;
delete process.env.PI_BACKENDS;

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexMod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const { withAuditedWrites } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));

const LIVE = process.env.VALKEY_TEST_URL
  ? (() => {
      const u = new URL(process.env.VALKEY_TEST_URL);
      u.pathname = "/9";
      return u.toString();
    })()
  : null;

/**
 * Database 9 as this file found it, and put back so at its end (`after`): every key the file's tests made is deleted,
 * and a key that was there and holds something else now is restored. The tests that take the database for themselves
 * (the census, the wire) do the same around their own bodies; this is for what the others leave, the meta hash and the
 * events stream of each queue a `/dispatch` command built. A key with an expiry is left to go by itself.
 */
const asFound = { keys: null };
async function everyKey(r) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await r.scan(cursor, "COUNT", 1000);
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}
before(async () => {
  if (!LIVE) return;
  const { default: IORedis } = await import("ioredis");
  const r = new IORedis(LIVE, { maxRetriesPerRequest: 1 });
  try {
    asFound.keys = new Map();
    for (const key of await everyKey(r)) asFound.keys.set(key, (await r.pttl(key)) < 0 ? await r.dumpBuffer(key) : null);
  } finally {
    r.disconnect();
  }
});
after(async () => {
  if (!LIVE || asFound.keys === null) return;
  const { default: IORedis } = await import("ioredis");
  const r = new IORedis(LIVE, { maxRetriesPerRequest: 1 });
  try {
    const made = (await everyKey(r)).filter((key) => !asFound.keys.has(key));
    if (made.length > 0) await r.del(...made);
    for (const [key, dump] of asFound.keys) if (dump !== null && !(await r.dumpBuffer(key))?.equals(dump)) await r.restore(key, 0, dump, "REPLACE");
  } finally {
    r.disconnect();
  }
});

const ENV_KEYS = ["PI_DISPATCH_AGENT_WRITES", "PI_DISPATCH_RUN_ROOTS", "PI_DISPATCH_RUN_PER_HOUR", "PI_LOGS_DIR", "PI_TRIGGERS_FILE", "PI_SETTINGS_FILE", "PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_PROJECTS_FILE", "PI_ENVELOPE_FILE", "VALKEY_URL", "PI_WORKER_NAME"];
const ALLOC_NOW = Date.parse("2026-10-05T12:00:00Z");

/** Every audit row in `logsDir`, oldest first. */
function rowsOf(logsDir) {
  const dir = join(logsDir, "console-audit");
  let names;
  try {
    names = readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort();
  } catch {
    return [];
  }
  return names.flatMap((n) => readFileSync(join(dir, n), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)));
}

/**
 * A deployment in a temp folder with the env pointed at it: one trigger, one pause window, one scoped limit, one
 * project and a settings file, or (`alloc`) the allocation deployment of crud.test.mjs with the fake Valkey and an
 * injected clock. `breakAudit()` turns the audit directory into a file. `restore()` puts the env back.
 */
function deployment({ alloc = false, valkey = NO_VALKEY } = {}) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.PI_DISPATCH_AGENT_WRITES = "1";
  process.env.PI_DISPATCH_RUN_ROOTS = "/test-root";
  process.env.PI_DISPATCH_RUN_PER_HOUR = "3";
  const dir = tempDir("pd-642-wiring-");
  const files = {
    triggers: join(dir, "triggers.json"),
    settings: join(dir, "settings.json"),
    pauses: join(dir, "pause-windows.json"),
    limits: join(dir, "scoped-limits.json"),
    projects: join(dir, "projects.json"),
    envelope: join(dir, "envelope.json"),
    logs: join(dir, "logs"),
  };
  writeFileSync(files.triggers, JSON.stringify({ triggers: [{ on: { type: "label", any: ["bug"] }, run: { kind: "github", flow: "fix" } }] }));
  writeFileSync(files.pauses, JSON.stringify({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00" }] }));
  let redis = null;
  if (alloc) {
    writeFileSync(files.projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }, { id: "platform", members: ["github:acme/infra"] }] }));
    writeFileSync(files.envelope, JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", platform: "10", _other: "0" }, defaultWeights: { shop: 1, platform: 1, _other: 0 }, delegation: { enabled: true, writers: ["operator-session", "portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }, null, 2));
    writeFileSync(files.settings, JSON.stringify({ maxCostUsd: "2" }));
    redis = fakeAllocRedis();
    let clock = ALLOC_NOW;
    indexMod._setAllocationSeamsForTests({ redisFn: () => redis, now: () => new Date((clock += 1000)) });
  } else {
    writeFileSync(files.limits, JSON.stringify({ version: 1, limits: [{ scope: "acme/web", day: 5 }] }));
    writeFileSync(files.projects, JSON.stringify({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }] }));
    writeFileSync(files.settings, JSON.stringify({ model: "m", secretProfiles: { prod: "/opt/pi/resolve.sh" } }));
  }
  Object.assign(process.env, {
    PI_LOGS_DIR: files.logs,
    PI_TRIGGERS_FILE: files.triggers,
    PI_SETTINGS_FILE: files.settings,
    PI_PAUSE_WINDOWS_FILE: files.pauses,
    PI_SCOPED_LIMITS_FILE: files.limits,
    PI_PROJECTS_FILE: files.projects,
    PI_ENVELOPE_FILE: files.envelope,
    VALKEY_URL: valkey,
    PI_WORKER_NAME: "mini1",
  });
  return {
    dir,
    files,
    redis,
    breakAudit() {
      rmSync(join(files.logs, "console-audit"), { recursive: true, force: true });
      mkdirSync(files.logs, { recursive: true });
      writeFileSync(join(files.logs, "console-audit"), "not a directory");
    },
    restore() {
      if (alloc) indexMod._setAllocationSeamsForTests({});
      writeFileSync(ENV_FILE, QUIET_ENV);
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    },
  };
}

/** The registered tools by name. */
function tools() {
  const list = [];
  const pi = new Proxy({}, { get: (_t, k) => (k === "registerTool" ? (t) => list.push(t) : () => {}) });
  indexMod.default(pi);
  return Object.fromEntries(list.map((t) => [t.name, withOperatorDiagnosis(t)]));
}
/** The `/dispatch` handler. */
function dispatchHandler() {
  let handler = null;
  const pi = new Proxy({}, { get: (_t, k) => (k === "registerCommand" ? (_n, def) => (handler = def.handler) : () => {}) });
  indexMod.default(pi);
  return handler;
}
/**
 * A ctx.ui whose `select` answers are strings or pickers over the options shown, `input` answers in order, `confirm`
 * always yes. Its notes are recorded.
 */
function scriptedUi({ select = [], input = [] } = {}) {
  const sel = [...select];
  const inp = [...input];
  const notes = [];
  return {
    notes,
    ui: {
      select: async (_title, options) => {
        const a = sel.shift();
        return typeof a === "function" ? a(options) : a;
      },
      input: async () => inp.shift(),
      confirm: async () => true,
      notify: (m) => notes.push(String(m)),
    },
  };
}
const confirming = () => ({ hasUI: true, ui: { confirm: async () => true } });
/** Run a tool, swallowing the refusal it throws (the rows say what happened). */
async function tool(name, params, ctx = confirming()) {
  try {
    return await tools()[name].execute("id", params, undefined, undefined, ctx);
  } catch (e) {
    return { threw: e.message };
  }
}
/** Run `/dispatch <line>` with a scripted ui. */
async function command(line, script = {}) {
  const { ui, notes } = scriptedUi(script);
  await dispatchHandler()(line, { hasUI: true, ui });
  return notes;
}
const dialog = (action, script = {}) => indexMod.handleDashboardAction(action, resolvedPaths(), { ui: scriptedUi(script).ui });
/** The deployment's paths as the panel resolves them for a dialog. */
function resolvedPaths() {
  return {
    triggersPath: process.env.PI_TRIGGERS_FILE,
    settingsFile: process.env.PI_SETTINGS_FILE,
    pauseWindowsPath: process.env.PI_PAUSE_WINDOWS_FILE,
    scopedLimitsPath: process.env.PI_SCOPED_LIMITS_FILE,
    projectsFile: process.env.PI_PROJECTS_FILE,
    envelopeFile: process.env.PI_ENVELOPE_FILE,
    logsDir: process.env.PI_LOGS_DIR,
  };
}
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await settle(25);
  }
}

/**
 * Open the bare `/dispatch` panel as pi would (the deployment pointer makes it the dashboard), hand its component to
 * `fn`, then close it. The deps are index.ts's own: `withAuditedWrites(createDashboardDeps(...), panelWrite...)`.
 */
async function withPanel(fn) {
  let comp = null;
  let close = null;
  const notes = [];
  const ctx = {
    hasUI: true,
    cwd: DEPLOYMENT,
    ui: {
      notify: (m) => notes.push(String(m)),
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => false,
      custom: (factory) => new Promise((resolve) => {
        close = resolve;
        comp = factory({ requestRender() {} }, null, null, resolve);
      }),
    },
  };
  const running = dispatchHandler()("", ctx);
  await until(() => comp, `the panel to open (${JSON.stringify(notes)})`);
  try {
    await settle(50);
    return await fn(comp);
  } finally {
    await comp.dispose?.();
    close(undefined);
    await running;
  }
}
const screen = (comp) => comp.render(160).map(stripAnsi).join("\n");

/** A held row on the live Valkey for `dispatch_wait_cancel` to find (the job itself is not in any queue). */
async function seedHeld(jobId) {
  const { default: IORedis } = await import("ioredis");
  const r = new IORedis(LIVE, { maxRetriesPerRequest: 1 });
  try {
    await r.hset(`wait:job:${jobId}`, { since: String(Date.now()), target: "acme/web#7", label: "jira" });
    await r.sadd("wait:held", jobId);
  } finally {
    r.disconnect();
  }
}
async function dropHeld(jobId) {
  const { default: IORedis } = await import("ioredis");
  const r = new IORedis(LIVE, { maxRetriesPerRequest: 1 });
  try {
    await r.del(`wait:job:${jobId}`);
    await r.srem("wait:held", jobId);
  } finally {
    r.disconnect();
  }
}

const bytes = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "<absent>");
const NOT_REACHED = /could not reach the queue|FAILED at/;

/**
 * THE TABLE. `site` is `<file>:<the kind literals of that call site, joined by |>` (`<opts>` for index.ts's dashboard
 * wiring, whose kinds come from dashboard.ts); `kind` the row this surface appends; `outcomes` the rows' outcomes;
 * `reason` what the failed row says; optional `checkReason` verifies a bounded audit field against the full source
 * refusal and that same semantic pattern; `state` what the write changes (compared before and after, and unchanged when the
 * audit cannot be appended); `prepare` runs before the rows are counted.
 */
const CASES = [
  // ---- the extension's tools ----
  { site: "index.ts:fleet-pause", name: "dispatch_pause", kind: "fleet-pause", outcomes: ["ok"], live: true, run: () => tool("dispatch_pause", {}) },
  { site: "index.ts:fleet-resume", name: "dispatch_resume", kind: "fleet-resume", outcomes: ["ok"], live: true, run: () => tool("dispatch_resume", {}) },
  { site: "index.ts:run-enqueue", name: "dispatch_run", kind: "run-enqueue", outcomes: [], run: () => tool("dispatch_run", { folder: "/nowhere", flow: "fix", task: "t" }) },
  { site: "index.ts:setting-unset|setting-set", name: "dispatch_set", kind: "setting-set", outcomes: ["ok"], state: (fx) => bytes(fx.files.settings), run: () => tool("dispatch_set", { key: "dailyCap", value: "4" }) },
  { site: "index.ts:trigger-add", name: "dispatch_trigger_add", kind: "trigger-add", outcomes: ["ok"], state: (fx) => bytes(fx.files.triggers), run: () => tool("dispatch_trigger_add", { kind: "label", flow: "fix", labels: ["bug"] }) },
  { site: "index.ts:trigger-edit", name: "dispatch_trigger_edit", kind: "trigger-edit", outcomes: ["ok"], state: (fx) => bytes(fx.files.triggers), run: () => tool("dispatch_trigger_edit", { index: 0, flow: "review" }) },
  { site: "index.ts:pause-window-add", name: "dispatch_pause_add", kind: "pause-window-add", outcomes: ["ok"], state: (fx) => bytes(fx.files.pauses), run: () => tool("dispatch_pause_add", { scope: "*", from: "01:00", to: "02:00" }) },
  { site: "index.ts:pause-window-delete", name: "dispatch_pause_delete", kind: "pause-window-delete", outcomes: ["ok"], state: (fx) => bytes(fx.files.pauses), run: () => tool("dispatch_pause_delete", { index: 0 }) },
  { site: "index.ts:pause-window-edit", name: "dispatch_pause_edit", kind: "pause-window-edit", outcomes: ["ok"], state: (fx) => bytes(fx.files.pauses), run: () => tool("dispatch_pause_edit", { index: 0, to: "07:00" }) },
  {
    site: "index.ts:cancel-held",
    name: "dispatch_wait_cancel",
    kind: "cancel-held",
    outcomes: ["ok", "failed"],
    reason: /^the job is no longer in the queue \(job wiring-held-\d+\)$/,
    live: true,
    prepare: async (fx) => {
      fx.jobId = `wiring-held-${process.pid}`;
      await seedHeld(fx.jobId);
    },
    run: async (fx) => {
      try {
        const res = await tool("dispatch_wait_cancel", { jobId: fx.jobId });
        assert.equal(res.threw, `the job is no longer in the queue (job ${fx.jobId})`, "the tool found the held row and reached the cancel");
      } finally {
        await dropHeld(fx.jobId);
      }
    },
  },
  { site: "index.ts:limit-add", name: "dispatch_limit_add", kind: "limit-add", outcomes: ["ok"], state: (fx) => bytes(fx.files.limits), run: () => tool("dispatch_limit_add", { scope: "acme/api", day: 2 }) },
  { site: "index.ts:limit-delete", name: "dispatch_limit_delete", kind: "limit-delete", outcomes: ["ok"], state: (fx) => bytes(fx.files.limits), run: () => tool("dispatch_limit_delete", { index: 0 }) },
  { site: "index.ts:limit-edit", name: "dispatch_limit_edit", kind: "limit-edit", outcomes: ["ok"], state: (fx) => bytes(fx.files.limits), run: () => tool("dispatch_limit_edit", { index: 0, day: 9 }) },
  { site: "index.ts:project-add", name: "dispatch_project_add", kind: "project-add", outcomes: ["ok"], state: (fx) => bytes(fx.files.projects), run: () => tool("dispatch_project_add", { id: "api", members: ["github:acme/api"] }) },
  { site: "index.ts:project-edit", name: "dispatch_project_edit", kind: "project-edit", outcomes: ["ok"], state: (fx) => bytes(fx.files.projects), run: () => tool("dispatch_project_edit", { id: "web", name: "Web" }) },
  { site: "index.ts:project-delete", name: "dispatch_project_delete", kind: "project-delete", outcomes: ["ok"], state: (fx) => bytes(fx.files.projects), run: () => tool("dispatch_project_delete", { id: "web" }) },
  { site: "index.ts:trigger-delete", name: "dispatch_trigger_delete", kind: "trigger-delete", outcomes: ["ok"], state: (fx) => bytes(fx.files.triggers), run: () => tool("dispatch_trigger_delete", { index: 0 }) },
  { site: "index.ts:envelope-set", name: "dispatch_envelope_set", kind: "envelope-set", alloc: true, outcomes: ["ok"], state: (fx) => bytes(fx.files.envelope), run: () => tool("dispatch_envelope_set", { totalUsd: "120" }) },
  { site: "index.ts:priorities-set", name: "dispatch_priorities_set", kind: "priorities-set", alloc: true, outcomes: ["ok"], state: (fx) => fx.redis.store.get("alloc:plan") ?? "<none>", run: () => tool("dispatch_priorities_set", { projects: [{ id: "shop", weight: 3 }, { id: "platform", weight: 1 }] }, { hasUI: false, ui: {} }) },
  {
    // The ALLOCATION view's `r` then `y` (index.ts `revertTo`), on the row the history shows for the plan just applied.
    site: "index.ts:allocation-revert",
    name: "the panel's allocation revert (b, r, y)",
    kind: "allocation-revert",
    alloc: true,
    // The panel's own reader holds clients on VALKEY_URL from its first frame; an absent one there emits errors past the
    // test's end, so the panel rows run on the live Valkey (the allocation itself stays on the fake).
    live: true,
    outcomes: ["ok"],
    state: (fx) => fx.redis.store.get("alloc:plan") ?? "<none>",
    prepare: async () => {
      await tool("dispatch_priorities_set", { projects: [{ id: "shop", weight: 3 }, { id: "platform", weight: 1 }] }, { hasUI: false, ui: {} });
    },
    run: async (fx) => {
      await withPanel(async (comp) => {
        comp.handleInput("b");
        await until(() => /operator-session/.test(screen(comp)), "the allocation history");
        // The newest row is the plan just applied; the one under it is the neutral split it moved from.
        comp.handleInput("\x1b[B");
        comp.handleInput("r");
        await settle();
        comp.handleInput("y");
        await until(() => /revert(ed| refused| lost)/.test(screen(comp)), "the revert's note");
      });
    },
  },
  {
    site: "index.ts:trigger-fire",
    name: "dispatch_trigger_fire",
    kind: "trigger-fire",
    outcomes: ["ok"],
    state: (fx) => fx.fired ?? 0,
    run: async (fx) => {
      await executeToolAction("dispatch_trigger_fire", { index: 0 }, { hasUI: true, ui: { confirm: async () => true } }, { paths: resolvedPaths(), env: {}, grantsEnv: { PI_DISPATCH_RUN_ROOTS: "/test-root", PI_DISPATCH_RUN_PER_HOUR: "3" }, readModel: { ...readModel,
        planTriggerFire: async () => ({ plan: { title: "Fire cron trigger now", message: "Fire daily now", schedulerId: "daily", fileDigest: "a".repeat(64), reserve: { dollarsMicros: 2_000_000 } } }),
        enqueueTriggerFire: async () => { fx.fired = (fx.fired ?? 0) + 1; return { ok: true, jobId: "manual:daily:1", queue: "pi-jobs" }; },
      } }).catch((e) => { assert.match(e.message, /audit log/); });
    },
  },
  // ---- the operator-typed /dispatch subcommands ----
  { site: "index.ts:priorities-set", name: "/dispatch priorities set", kind: "priorities-set", alloc: true, outcomes: ["ok"], state: (fx) => fx.redis.store.get("alloc:plan") ?? "<none>", run: () => command("priorities set shop=3 platform=1") },
  { site: "index.ts:run-enqueue", name: "/dispatch run", kind: "run-enqueue", outcomes: ["ok", "failed"], reason: /./, run: () => command("run /nowhere fix go") },
  { site: "index.ts:fleet-pause|fleet-resume", name: "/dispatch pause", kind: "fleet-pause", outcomes: ["ok", "failed"], reason: NOT_REACHED, run: () => command("pause") },
  {
    // `/dispatch chat`'s reply (issue #647, part 2) through the io index.ts builds (`chatIo`): the parked answer's enqueue
    // inside its audited write, against a Valkey that is not there, so the ok row is followed by the failed one. The row
    // carries the answer's digest and never its text. (`dispatch-chat.test.mjs` drives the mode itself with fakes.)
    site: "index.ts:parked-answer",
    name: "/dispatch chat's parked answer",
    kind: "parked-answer",
    outcomes: ["ok", "failed"],
    reason: /^the queue could not be reached$/,
    run: async () => {
      const { answerFailure } = await import("../src/dispatch-chat.mjs");
      const paths = { ...resolvedPaths(), valkeyUrl: process.env.VALKEY_URL };
      const io = indexMod.chatIo(paths, { ui: {} }, () => {});
      const text = "answer-canary-7d2e use main";
      const plan = { kind: "parked-answer", jobId: "j1", forge: "github", queue: "pi-jobs", job: { parkedReply: true, repo: "acme/web", target: { type: "issue", number: 7 }, trigger: { comment: { body: text } } } };
      const digest = createHash("sha256").update(text).digest("hex");
      const res = await io.write({ kind: "parked-answer", target: "j1", afterDigest: digest, failure: answerFailure }, () => io.enqueueAnswer(plan));
      assert.ok(res.unreachable !== undefined, JSON.stringify(res));
      const rows = rowsOf(process.env.PI_LOGS_DIR);
      assert.deepEqual([rows.at(-1).target, rows.at(-1).afterDigest], ["j1", digest]);
      assert.ok(!JSON.stringify(rows).includes("answer-canary"), "no row carries the text");
    },
  },
  {
    // The TUI's `r` through the deps index.ts builds (`withAuditedWrites(createDashboardDeps(paths, { killSwitchPlanFn
    // }), panelWrite)`), with this process's VALKEY_URL (database 9) and the deployment .env's (database 8) disagreeing:
    // the kill switch's plan refuses the resume, and the refusal is the audit row's reason and the footer note. Neither
    // queue is switched. A live Valkey because the panel's own reader holds clients on VALKEY_URL from the first frame.
    site: "index.ts:<opts>",
    name: "the panel's r on a two-Valkey disagreement",
    kind: "fleet-resume",
    outcomes: ["ok", "failed"],
    reason: /^VALKEY_URL is redis:\/\/[^ ]+\/9 in this shell and redis:\/\/[^ ]+\/8 in .*\.env \(what the service uses\): resume/,
    checkReason: (reason, pattern) => {
      const { refused } = readModel.killSwitchPlan({ paused: false });
      assert.match(refused, pattern, "the full refusal retains its resume semantics even beyond the audit field's cap");
      assert.ok(refused.includes(ENV_FILE), "the refusal names this fixture's complete deployment path");
      assert.equal(reason, [...escapeControls(refused)].slice(0, CONSOLE_AUDIT_FIELD_MAX).join(""), "the audit stores the exact escaped, code-point-bounded refusal, without losing or inventing bytes within its field");
    },
    live: true,
    prepare: () => writeFileSync(ENV_FILE, `VALKEY_URL=${LIVE.replace(/\/9$/, "/8")}\n`),
    run: async () => {
      await withPanel(async (comp) => {
        comp.handleInput("r");
        await until(() => /resume refused/.test(screen(comp)), "the resume's note");
        // The note carries the plan's whole sentence (the audit row's reason is cut at the writer's cap).
        assert.match(screen(comp).replace(/\s*\n\s*/g, " "), /resume refused: VALKEY_URL is redis:\/\/\S+\/9 in this shell and redis:\/\/\S+\/8 in/);
      });
    },
  },
  // ---- the panel's dialogs (handleDashboardAction) ----
  { site: "index.ts:limit-add", name: "the scoped-limit add dialog", kind: "limit-add", outcomes: ["ok"], state: (fx) => bytes(fx.files.limits), run: () => dialog({ action: "manageLimits" }, { select: ["Add a scoped limit"], input: ["acme/api", "3", "", "", ""] }) },
  { site: "index.ts:limit-edit", name: "the scoped-limit edit dialog", kind: "limit-edit", outcomes: ["ok"], state: (fx) => bytes(fx.files.limits), run: () => dialog({ action: "manageLimits" }, { select: ["Edit a scoped limit", (o) => o[0]], input: ["", "9", "", "", ""] }) },
  { site: "index.ts:limit-delete", name: "the scoped-limit delete dialog", kind: "limit-delete", outcomes: ["ok"], state: (fx) => bytes(fx.files.limits), run: () => dialog({ action: "manageLimits" }, { select: ["Delete a scoped limit", (o) => o[0]] }) },
  { site: "index.ts:pause-window-add", name: "the pause-window add dialog", kind: "pause-window-add", outcomes: ["ok"], state: (fx) => bytes(fx.files.pauses), run: () => dialog({ action: "managePauses" }, { select: ["Add a pause window"], input: ["*", "01:00", "02:00", "", "", "", ""] }) },
  { site: "index.ts:pause-window-edit", name: "the pause-window edit dialog", kind: "pause-window-edit", outcomes: ["ok"], state: (fx) => bytes(fx.files.pauses), run: () => dialog({ action: "managePauses" }, { select: ["Edit a pause window", (o) => o[0]], input: ["", "", "07:00", "", "", "", ""] }) },
  { site: "index.ts:pause-window-delete", name: "the pause-window delete dialog", kind: "pause-window-delete", outcomes: ["ok"], state: (fx) => bytes(fx.files.pauses), run: () => dialog({ action: "managePauses" }, { select: ["Delete a pause window", (o) => o[0]] }) },
  { site: "index.ts:trigger-add", name: "the add-trigger dialog", kind: "trigger-add", outcomes: ["ok"], state: (fx) => bytes(fx.files.triggers), run: () => dialog({ action: "addTrigger" }, { select: ["label"], input: ["github", "bug", "fix"] }) },
  { site: "index.ts:trigger-edit", name: "the trigger flow edit dialog", kind: "trigger-edit", outcomes: ["ok"], state: (fx) => bytes(fx.files.triggers), run: () => dialog({ action: "editTrigger", index: 0 }, { input: ["review"] }) },
  { site: "index.ts:trigger-delete", name: "the trigger delete (y in the frame)", kind: "trigger-delete", outcomes: ["ok"], state: (fx) => bytes(fx.files.triggers), run: () => dialog({ action: "deleteTrigger", index: 0, confirmed: true }) },
  { site: "index.ts:setting-set", name: "the settings dialog's set", kind: "setting-set", outcomes: ["ok"], state: (fx) => bytes(fx.files.settings), run: () => dialog({ action: "editSettings" }, { select: ["dailyCap"], input: ["5"] }) },
  { site: "index.ts:setting-unset", name: "/dispatch unset", kind: "setting-unset", outcomes: ["ok"], state: (fx) => bytes(fx.files.settings), run: () => command("unset model") },
  // ---- /dispatch secrets ----
  { site: "secrets-command.ts:secret-profile-add", name: "/dispatch secrets add", kind: "secret-profile-add", outcomes: ["ok"], state: (fx) => bytes(fx.files.settings), run: () => command("secrets add", { input: ["staging", "/opt/pi/staging.sh"] }) },
  { site: "secrets-command.ts:secret-profile-remove", name: "/dispatch secrets remove", kind: "secret-profile-remove", outcomes: ["ok"], state: (fx) => bytes(fx.files.settings), run: () => command("secrets remove prod") },
  // Issue #704: the bundle resolvers, the same door with --bundle.
  { site: "secrets-command.ts:secret-bundle-add", name: "/dispatch secrets add --bundle", kind: "secret-bundle-add", outcomes: ["ok"], state: (fx) => bytes(fx.files.settings), run: () => command("secrets add --bundle", { input: ["op-shop", "/opt/pi/bundle.sh", "json"] }) },
  { site: "secrets-command.ts:secret-bundle-remove", name: "/dispatch secrets remove --bundle", kind: "secret-bundle-remove", outcomes: ["ok"], state: (fx) => bytes(fx.files.settings), prepare: (fx) => writeFileSync(fx.files.settings, JSON.stringify({ model: "m", secretBundles: { "op-shop": { path: "/opt/pi/bundle.sh", format: "json" } } })), run: () => command("secrets remove --bundle op-shop") },
  // ---- dashboard.ts's withAuditedWrites, with the writer index.ts hands it (panelWrite on PI_LOGS_DIR) ----
  ...["pause", "resume", "cancelActive", "cancelHeld"].map((method) => {
    const kind = { pause: "fleet-pause", resume: "fleet-resume", cancelActive: "cancel-active", cancelHeld: "cancel-held" }[method];
    return {
      site: `dashboard.ts:${kind}`,
      name: `the TUI deps' ${method}`,
      kind,
      outcomes: ["ok"],
      state: (fx) => (fx.ran ?? []).join(","),
      run: async (fx) => {
        const base = {
          pause: async () => (fx.ran = [...(fx.ran ?? []), "pause"], { results: [{ shown: "v", res: { ok: true, queues: ["q"] } }] }),
          resume: async () => (fx.ran = [...(fx.ran ?? []), "resume"], { results: [{ shown: "v", res: { ok: true, queues: ["q"] } }] }),
          cancelActive: async ({ jobId }) => (fx.ran = [...(fx.ran ?? []), `active:${jobId}`], { ok: true }),
          cancelHeld: async ({ jobId }) => (fx.ran = [...(fx.ran ?? []), `held:${jobId}`], { ok: true, jobId }),
        };
        const deps = withAuditedWrites(base, (opts, fn) => panelWrite(process.env.PI_LOGS_DIR, opts, fn));
        await deps[method]({ jobId: "j1" });
      },
    };
  }),
  // Issue #646: the ACTIVE row's `t`/`T` push. The row names the job and the message id, and carries the message's
  // sha256, never its text.
  {
    site: "dashboard.ts:steer",
    name: "the TUI deps' steer",
    kind: "steer",
    outcomes: ["ok"],
    state: (fx) => (fx.ran ?? []).join(","),
    run: async (fx) => {
      const base = { steer: async (plan) => (fx.ran = [...(fx.ran ?? []), `steer:${plan.jobId}`], { ok: true, jobId: plan.jobId, id: plan.id, mode: plan.mode, state: "queued" }) };
      const deps = withAuditedWrites(base, (opts, fn) => panelWrite(process.env.PI_LOGS_DIR, opts, fn));
      const text = "steer-canary-5b1c use the fixture db";
      await deps.steer({ kind: "steer", jobId: "j1", id: "a".repeat(32), mode: "steer", text, digest: createHash("sha256").update(text).digest("hex") });
      // The broken-audit pass writes no row at all (and pushes nothing): the shared loop asserts that; this one the row.
      const rows = rowsOf(fx.files.logs);
      if (rows.length === 0) return;
      assert.deepEqual([rows.at(-1).target, rows.at(-1).afterDigest], [`j1#${"a".repeat(32)}`, createHash("sha256").update(text).digest("hex")]);
      assert.ok(!JSON.stringify(rows).includes("steer-canary"), "no row carries the text");
    },
  },
];

for (const c of CASES) {
  const isTool = c.name.startsWith("dispatch_");
  const expected = c.outcomes.flatMap((outcome) => isTool && outcome === "ok" && c.outcomes.length === 1 ? [[c.kind, outcome, "write", "agent", null], [c.kind, outcome, "write-applied", "agent", null]] : [[c.kind, outcome, "write", isTool ? "agent" : "panel", null]]);
  const opts = { timeout: 30_000, ...(c.live && !LIVE ? { skip: "needs VALKEY_TEST_URL" } : {}) };
  test(`${c.name}: appends ${c.kind} (${c.outcomes.join(" then ")}) as the panel${c.state ? ", and writes nothing when the row cannot be appended" : ""}`, opts, async () => {
    const fx = deployment({ alloc: c.alloc, valkey: c.live ? LIVE : NO_VALKEY });
    try {
      await c.prepare?.(fx);
      const before = rowsOf(fx.files.logs).length;
      const state0 = c.state?.(fx);
      await c.run(fx);
      const rows = rowsOf(fx.files.logs).slice(before);
      assert.deepEqual(rows.map((r) => [r.kind, r.outcome, r.action, r.actor.role, r.actor.session]), expected, JSON.stringify(rows));
      assert.equal(new Set(rows.map((r) => r.ticket)).size, rows.length ? 1 : 0, "one ticket ties an attempted write's rows");
      if (c.reason) {
        if (c.checkReason) c.checkReason(rows.at(-1).reason, c.reason);
        else assert.match(rows.at(-1).reason, isTool ? /^action-refused$/ : c.reason);
      }
      if (c.state) assert.notEqual(c.state(fx), state0, "the write landed");
    } finally {
      fx.restore();
    }
    if (!c.state) return;
    const broken = deployment({ alloc: c.alloc, valkey: c.live ? LIVE : NO_VALKEY });
    try {
      await c.prepare?.(broken);
      broken.breakAudit();
      const state0 = c.state(broken);
      await c.run(broken);
      assert.equal(c.state(broken), state0, "nothing was written without its audit row");
    } finally {
      broken.restore();
    }
  });
}

// ---- the table is the call sites ----

/** The kind literals of the audited call sites in `file`: every `panelWrite(` call, or in dashboard.ts every `write({`. */
function sitesIn(file) {
  const src = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), "utf8");
  const calls = file === "dashboard.ts" ? [...src.matchAll(/\bwrite\(\{/g)] : [...src.matchAll(/\bpanelWrite\(/g)];
  return calls.map((m) => {
    const tail = src.slice(m.index, src.indexOf("\n", m.index));
    const kind = /kind: ([^,]+(?:\?[^,]+)?),/.exec(tail);
    // index.ts's dashboard wiring passes `opts` through: its kinds are dashboard.ts's own sites.
    if (!kind || !kind[1].includes('"')) return `${file}:<opts>`;
    return `${file}:${[...kind[1].matchAll(/"([a-z0-9-]+)"/g)].map((k) => k[1]).join("|")}`;
  });
}

// Issue #842: `/dispatch pause` on a Valkey that takes the connection and answers nothing. The command's line and its
// audit row say the queue's pause is not confirmed, never that Valkey could not be reached (which reads as nothing sent).
test("/dispatch pause on a Valkey that answers nothing says the pause is not confirmed, in its line and its audit row (#842)", { timeout: 40_000 }, async () => {
  const { createServer } = await import("node:net");
  const sockets = new Set();
  const silent = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const fx = deployment({ valkey: `redis://127.0.0.1:${silent.address().port}` });
  try {
    // This host's own queue is the deployment .env's PI_WORKER_NAME (issue #964); the shell says the same (mini1).
    writeFileSync(ENV_FILE, "PI_WORKER_NAME=mini1\n");
    const notes = await command("pause");
    // Issue #964: the list that may be short is said first, and this host's own queue (the .env's PI_WORKER_NAME, mini1)
    // was sent its pause beside the shared one, though no discovery answered.
    const said = "pause: the list of queues may be short, so other queues may exist and were not switched; NOT CONFIRMED for pi-jobs, pi-jobs@mini1: the switch may or may not have been made there; known switched: none";
    assert.ok(notes.includes(said), JSON.stringify(notes));
    const rows = rowsOf(fx.files.logs).filter((r) => r.kind === "fleet-pause");
    assert.deepEqual(rows.map((r) => r.outcome), ["ok", "failed"]);
    // The row keeps the sentence's first 200 code points: the Valkey's address at its end is what the cut takes.
    assert.equal(rows[1].reason, [...`${said.slice("pause: ".length)} on redis://127.0.0.1:${silent.address().port}`].slice(0, 200).join(""));
  } finally {
    fx.restore();
    for (const socket of sockets) socket.destroy();
    silent.close();
  }
});

// Issue #964: `/dispatch pause` and `resume` on a Valkey that answers, with a host registry it cannot read (the registry
// key holds a string, so Valkey answers SMEMBERS with WRONGTYPE): every queue it found is switched, this host's own
// among them, and the line and a second audit row say the list may be short. The line said "only pi-jobs" here, which
// the scan had made untrue.
// Issue #1035: and they say WHY, since this is a cause that waiting does not end. Both said "once Valkey answers" of a
// Valkey that had answered, and answers the same on every try until the key is repaired.
test("/dispatch pause and resume over a registry key that holds a string switch this host's queue too, and say the list of queues may be short for a cause waiting does not end: the key, the code and to repair it (#964, #1035)", { timeout: 30_000, skip: LIVE ? false : "needs VALKEY_TEST_URL" }, async () => {
  const fx = deployment({ valkey: LIVE });
  const { default: IORedis } = await import("ioredis");
  const r = new IORedis(LIVE, { maxRetriesPerRequest: 1 });
  const pausedNote = "the list of queues may be short: Valkey answers host:live with WRONGTYPE. Waiting does not change that: remove or repair that key, then pause again; other queues may exist and were not paused";
  const resumedNote = "the list of queues may be short: Valkey answers host:live with WRONGTYPE. Waiting does not change that: remove or repair that key, then resume again; other queues may exist and were not resumed";
  try {
    writeFileSync(ENV_FILE, "PI_WORKER_NAME=mini1\n");
    await r.set(HOST_SET, "not a set");
    const paused = await command("pause");
    assert.ok(paused.includes(`paused: worker will stop taking new jobs (jobs still enqueue; durable, survives restart) (2 queues), but ${pausedNote}`), JSON.stringify(paused));
    assert.equal(await r.hget("bull:pi-jobs@mini1:meta", "paused"), "1", "this host's own queue (the .env's PI_WORKER_NAME, mini1) was paused");
    const resumed = await command("resume");
    assert.ok(resumed.includes(`resumed (2 queues), but ${resumedNote}`), JSON.stringify(resumed));
    const rows = rowsOf(fx.files.logs).filter((row) => row.kind?.startsWith("fleet-")).map((row) => [row.kind, row.outcome, row.reason ?? null]);
    assert.deepEqual(rows, [["fleet-pause", "ok", null], ["fleet-pause", "ok", pausedNote], ["fleet-resume", "ok", null], ["fleet-resume", "ok", resumedNote]]);
    assert.ok([...resumedNote].length <= CONSOLE_AUDIT_FIELD_MAX, "the row holds the whole sentence");
    assert.equal(pausedNote, switchShortNote(true, switchShortCause({ blind: "x", shortCause: { waits: false, errors: [{ key: HOST_SET, code: "WRONGTYPE" }] } })));
    for (const said of [...paused, ...resumed]) assert.doesNotMatch(said, /once Valkey answers|refus/i);
  } finally {
    await r.del(HOST_SET, "bull:pi-jobs@mini1:meta", "bull:pi-jobs@mini1:events").catch(() => {});
    r.disconnect();
    fx.restore();
  }
});

// Issue #1035: one host's row that holds a string, beside a registry index that answers. The registry is read in part,
// the list may be short by that host's queue, and no wait reads the row.
test("/dispatch pause over one host row that holds a string names that row's key and says to repair it, never to wait for Valkey (#1035)", { timeout: 30_000, skip: LIVE ? false : "needs VALKEY_TEST_URL" }, async () => {
  const fx = deployment({ valkey: LIVE });
  const { default: IORedis } = await import("ioredis");
  const r = new IORedis(LIVE, { maxRetriesPerRequest: 1 });
  // A host name of this test's own, so no other test's registry row is read or written.
  const host = `pd1035w${process.pid}`;
  const note = `the list of queues may be short: Valkey answers host:h:${host} with WRONGTYPE. Waiting does not change that: remove or repair that key, then pause again; other queues may exist and were not paused`;
  try {
    writeFileSync(ENV_FILE, "PI_WORKER_NAME=mini1\n");
    await r.sadd(HOST_SET, host);
    await r.set(hostKey(host), "not a hash");
    const paused = await command("pause");
    assert.ok(paused.some((line) => line.endsWith(`, but ${note}`)), JSON.stringify(paused));
    const rows = rowsOf(fx.files.logs).filter((row) => row.kind === "fleet-pause").map((row) => [row.outcome, row.reason ?? null]);
    assert.deepEqual(rows, [["ok", null], ["ok", [...note].slice(0, CONSOLE_AUDIT_FIELD_MAX).join("")]]);
    assert.ok(rows[1][1].includes("Waiting does not change that: remove or repair that key"), "what to put right is in what the row keeps");
    // Repaired: the same command reads the registry whole and says nothing of a short list.
    await r.del(hostKey(host));
    await r.srem(HOST_SET, host);
    const whole = await command("pause");
    assert.ok(!whole.some((line) => line.includes("may be short")), JSON.stringify(whole));
  } finally {
    await r.del(hostKey(host), "bull:pi-jobs@mini1:meta", "bull:pi-jobs@mini1:events").catch(() => {});
    await r.srem(HOST_SET, host).catch(() => {});
    await r.hdel("bull:pi-jobs:meta", "paused").catch(() => {});
    r.disconnect();
    fx.restore();
  }
});

// Issue #964: this host's own queue is the deployment .env's PI_WORKER_NAME, which the worker service runs. Pi's own
// environment (the "shell" here) naming another, or a .env naming none, adds no own queue on the /dispatch command, the
// tools or the panel's p, where a pause of pi-jobs@hostz wrote a meta key for a queue nobody drains.
test("the /dispatch command, the tools and the panel take this host's queue from the .env alone, and none when pi's environment names another (#964)", { timeout: 60_000, skip: LIVE ? false : "needs VALKEY_TEST_URL" }, async () => {
  const fx = deployment({ valkey: LIVE });
  const { default: IORedis } = await import("ioredis");
  const r = new IORedis(LIVE, { maxRetriesPerRequest: 1 });
  const metas = ["bull:pi-jobs@mini1:meta", "bull:pi-jobs@hostz:meta", "bull:pi-jobs@mini1:events", "bull:pi-jobs@hostz:events"];
  const created = async () => (await Promise.all(["mini1", "hostz"].map(async (n) => ((await r.exists(`bull:pi-jobs@${n}:meta`)) ? n : null)))).filter(Boolean);
  const surfaces = {
    command: () => command("pause"),
    tool: () => tool("dispatch_pause", {}),
    panel: () => withPanel(async (comp) => {
      comp.handleInput("p");
      await until(() => rowsOf(fx.files.logs).filter((row) => row.kind === "fleet-pause").length > 0, "the panel's pause row");
      await settle(100);
    }),
  };
  try {
    // A resume first, with the queue absent: one that does not exist has nothing to resume, and none is built for it.
    writeFileSync(ENV_FILE, "PI_WORKER_NAME=mini1\n");
    for (const resume of [() => command("resume"), () => tool("dispatch_resume", {})]) {
      await r.del(...metas);
      await resume();
      assert.deepEqual(await created(), [], "a resume wrote nothing for this host's absent queue");
    }
    for (const [surface, run] of Object.entries(surfaces)) {
      for (const [envFile, shell, want] of [["PI_WORKER_NAME=mini1\n", "hostz", []], [QUIET_ENV, "mini1", []], ["PI_WORKER_NAME=mini1\n", "mini1", ["mini1"]]]) {
        await r.del(...metas);
        rmSync(join(fx.files.logs, "console-audit"), { recursive: true, force: true });
        writeFileSync(ENV_FILE, envFile);
        process.env.PI_WORKER_NAME = shell;
        await run();
        assert.deepEqual(await created(), want, `${surface}: .env ${JSON.stringify(envFile)}, pi's environment ${shell}`);
      }
    }
  } finally {
    // The shared queue these pauses left paused, back as the other cases on this database expect it (it holds no job).
    await r.hdel("bull:pi-jobs:meta", "paused").catch(() => {});
    await r.del(...metas).catch(() => {});
    r.disconnect();
    fx.restore();
  }
});

// Issue #964: on a VALKEY_URL disagreement (pi's environment names database 9, the deployment .env database 8) a pause
// reaches both Valkeys, and this host's own queue only the .env's, the one its worker drains: from the /dispatch command,
// the tools and the panel's p alike. The reader's own Valkey here is pi's.
test("on a VALKEY_URL disagreement the /dispatch command, the tools and the panel pause this host's queue on the .env's Valkey only (#964)", { timeout: 60_000, skip: LIVE ? false : "needs VALKEY_TEST_URL" }, async () => {
  const fx = deployment({ valkey: LIVE });
  const { default: IORedis } = await import("ioredis");
  const envUrl = LIVE.replace(/\/9$/, "/8");
  const shellSide = new IORedis(LIVE, { maxRetriesPerRequest: 1 });
  const envSide = new IORedis(envUrl, { maxRetriesPerRequest: 1 });
  // Only the keys these pauses make on database 8, never the database whole.
  const drop = async () => {
    for (const r of [shellSide, envSide]) {
      const keys = [];
      let cursor = "0";
      do {
        const [next, found] = await r.scan(cursor, "MATCH", r === envSide ? "bull:pi-jobs*" : "bull:pi-jobs@mini1:*", "COUNT", 100);
        cursor = next;
        keys.push(...found);
      } while (cursor !== "0");
      if (keys.length > 0) await r.del(...keys);
    }
    await shellSide.hdel("bull:pi-jobs:meta", "paused");
  };
  const surfaces = {
    command: () => command("pause"),
    tool: () => tool("dispatch_pause", {}),
    panel: () => withPanel(async (comp) => {
      comp.handleInput("p");
      await until(() => rowsOf(fx.files.logs).filter((row) => row.kind === "fleet-pause").length > 0, "the panel's pause row");
      await settle(100);
    }),
  };
  try {
    writeFileSync(ENV_FILE, `VALKEY_URL=${envUrl}\nPI_WORKER_NAME=mini1\n`);
    for (const [surface, run] of Object.entries(surfaces)) {
      await drop();
      rmSync(join(fx.files.logs, "console-audit"), { recursive: true, force: true });
      await run();
      assert.deepEqual([await envSide.hget("bull:pi-jobs:meta", "paused"), await shellSide.hget("bull:pi-jobs:meta", "paused")], ["1", "1"], `${surface}: both Valkeys paused`);
      assert.deepEqual([await envSide.hget("bull:pi-jobs@mini1:meta", "paused"), await shellSide.exists("bull:pi-jobs@mini1:meta")], ["1", 0], `${surface}: this host's queue on the .env's Valkey only`);
    }
  } finally {
    await drop().catch(() => {});
    shellSide.disconnect();
    envSide.disconnect();
    fx.restore();
  }
});

// Issue #964: a part-way switch over a set that may be short, through the command: its line leads with that. The registry
// key and this host's queue's events key hold strings, so Valkey answers the registry read with WRONGTYPE, and the queue's
// pause too, after its script paused the queue: read back (issue #1014), it is said as what it reads, never as refused.
test("/dispatch pause answered part-way with an error over an unreadable registry says first that the list of queues may be short (#964, #1014)", { timeout: 30_000, skip: LIVE ? false : "needs VALKEY_TEST_URL" }, async () => {
  const fx = deployment({ valkey: LIVE });
  const { default: IORedis } = await import("ioredis");
  const r = new IORedis(LIVE, { maxRetriesPerRequest: 1 });
  try {
    writeFileSync(ENV_FILE, "PI_WORKER_NAME=mini1\n");
    await r.set(HOST_SET, "not a set");
    await r.set("bull:pi-jobs@mini1:events", "not a stream");
    const notes = await command("pause");
    // Issue #1035: the lead says why the list is short, the registry key answered with WRONGTYPE, and what to put right.
    assert.ok(notes.includes("pause: the list of queues may be short (Valkey answers host:live with WRONGTYPE: remove or repair that key first), so other queues may exist and were not switched; ANSWERED WITH AN ERROR for pi-jobs@mini1 (reads paused now); known switched: pi-jobs"), JSON.stringify(notes));
    assert.equal(await r.hexists("bull:pi-jobs@mini1:meta", "paused"), 1, "paused, as said");
  } finally {
    await r.del(HOST_SET, "bull:pi-jobs@mini1:meta", "bull:pi-jobs@mini1:events").catch(() => {});
    await r.hdel("bull:pi-jobs:meta", "paused").catch(() => {});
    r.disconnect();
    fx.restore();
  }
});

test("the pause and resume tools tell a model what queuesMayBeShort means in the words the surfaces say, and what queuesShortLasting beside it means (#964, #1035)", () => {
  const t = tools();
  assert.match(t.dispatch_pause.description, /queuesMayBeShort true in the answer means the host registry or the look for queues could not be read whole, so other queues may exist and were not paused\./);
  assert.match(t.dispatch_resume.description, /queuesMayBeShort true in the answer means the host registry or the look for queues could not be read whole, so other queues may exist and were not resumed\./);
  // Issue #1035: "pause again once Valkey answers" was said of every short list, also of one that is short because
  // Valkey answers a read with an error which no wait ends.
  assert.ok(t.dispatch_pause.description.includes('With no queuesShortLasting beside it, pause again: a later try may read the list whole. queuesShortLasting beside it means Valkey answered a read with an error that waiting does not change, so pausing again alone gives the same answer: "key" is a key that holds another kind of value and has to be removed or repaired first, "permission" is a permission this deployment\'s Valkey user lacks (its ACL).'), t.dispatch_pause.description);
  assert.ok(t.dispatch_resume.description.includes('With no queuesShortLasting beside it, a later resume may read the list whole. queuesShortLasting beside it means Valkey answered a read with an error that waiting does not change, so resuming again alone gives the same answer: "key" is a key that holds another kind of value and has to be removed or repaired first, "permission" is a permission this deployment\'s Valkey user lacks (its ACL).'), t.dispatch_resume.description);
  for (const d of [t.dispatch_pause.description, t.dispatch_resume.description]) assert.doesNotMatch(d, /once Valkey answers|refus/i);
  // The two words are the classifier's two classes that last, and the ones an answer and an audit row carry.
  assert.deepEqual(Object.entries(REPLY_ERROR_CLASSES).filter(([, c]) => c.lasting === true).map(([name]) => name), ["key", "permission"]);
});

test("the table has exactly one row per audited call site in index.ts, secrets-command.ts and dashboard.ts", () => {
  const sites = ["index.ts", "secrets-command.ts", "dashboard.ts"].flatMap(sitesIn).sort();
  const table = CASES.filter((c) => !c.name.startsWith("dispatch_")).map((c) => c.site).sort();
  assert.ok(sites.length >= 20, `the scan found the operator call sites (${sites.length}); model writes share one adapter`);
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.equal([...source.matchAll(/executeToolAction\(definition.name/g)].length, 1, "registered write tools have one audited adapter");
  for (const c of CASES.filter((c) => c.name.startsWith("dispatch_"))) assert.ok(Object.hasOwn(TOOL_ACTIONS, c.name), `${c.name} is delegated through the shared adapter`);
  assert.deepEqual(table, sites, "a write path with no row here (or a row whose call site is gone)");
  // Every site's row exercises a kind its literals name, so a row cannot stand in for a different call.
  for (const c of CASES) {
    const named = c.site.split(":")[1];
    if (named !== "<opts>") assert.ok(named.split("|").includes(c.kind), `${c.name}: ${c.kind} is not one of ${named}`);
  }
  // The dashboard.ts sites are the five writes withAuditedWrites wraps, and nothing else there calls `write({`.
  assert.deepEqual(sitesIn("dashboard.ts").sort(), ["dashboard.ts:cancel-active", "dashboard.ts:cancel-held", "dashboard.ts:fleet-pause", "dashboard.ts:fleet-resume", "dashboard.ts:steer"]);
});

test("a tool's paid start that was sent and not confirmed is audited as action-unconfirmed and thrown to the model in the funnel's own sentence (#961)", async () => {
  const fx = deployment();
  try {
    const sentence = "Fire now did not receive a queue acknowledgement. A run may have been queued; check In line and Running on the overview before trying again next minute.";
    const before = rowsOf(fx.files.logs).length;
    await assert.rejects(
      executeToolAction("dispatch_trigger_fire", { index: 0 }, { hasUI: true, ui: { confirm: async () => true } }, { paths: resolvedPaths(), env: {}, grantsEnv: { PI_DISPATCH_RUN_ROOTS: "/test-root", PI_DISPATCH_RUN_PER_HOUR: "3" }, readModel: { ...readModel,
        planTriggerFire: async () => ({ plan: { title: "Fire cron trigger now", message: "Fire daily now", schedulerId: "daily", fileDigest: "a".repeat(64), reserve: { dollarsMicros: 2_000_000 } } }),
        enqueueTriggerFire: async () => ({ invalid: sentence, partial: true }),
      } }),
      (error) => error.message === sentence,
    );
    const rows = rowsOf(fx.files.logs).slice(before);
    assert.deepEqual(rows.map((r) => [r.kind, r.outcome, r.reason ?? null]), [["trigger-fire", "ok", null], ["trigger-fire", "failed", "action-unconfirmed"]]);
  } finally {
    fx.restore();
  }
});

// Issue #1036: a read tool writes nothing to Valkey. Every tool the extension registers as "Read-only", through the
// real extension, against a real Valkey: database 9, which is this file's alone in all five trees of tests (CI runs
// every workspace in one `node --test` on one Valkey, and no other test file of the worker, the receiver, the admin,
// the runner or the launcher names it; this file's tests run one after another), because the tools read the
// deployment's own key names and no prefix can stand in for them. The file leaves the database as it found it
// (`leaveAsFound`, at its end). The census is every key of the database with its value, taken before and after each
// tool. Three things a pruning reader removes are planted first and must still be there after every tool: a
// `host:live` member with no row, a `wait:held` member with no hash, and a run mirror id with no record. The person's
// surfaces then prune them, as they always have.
//
// Each tool's third entry (issue #1064) says whether its answer rests on the queues' own reads, a queue's paused state
// or counts: a function that takes its answer over a queue Valkey answered with an error and gives the map that names
// the queue and whether the tool's own key says the answer is not whole; or null for a tool whose answer none of those
// enters (the files, the run records, the host registry's rows, Valkey's counters), which answers as over any fleet.
/** The read tools whose answer is a file's alone, so they send Valkey nothing: the pause windows. */
const FILE_ONLY_READ_TOOLS = Object.freeze(["dispatch_pauses"]);

const READ_TOOLS = Object.freeze([
  ["dispatch_status", {}, (out) => [out.queue?.queueErrors, out.queue?.partial === true && Array.isArray(out.queue?.unavailableQueues)]],
  ["dispatch_runs", {}, null], ["dispatch_costs", {}, null], ["dispatch_capacity", {}, null], ["dispatch_triggers", {}, null],
  ["dispatch_pauses", {}, null], ["dispatch_limits", {}, null], ["dispatch_waits", {}, null], ["dispatch_projects", {}, null], ["dispatch_allocations", {}, null],
  ["dispatch_failed", {}, (out) => [out.queueErrors, out.complete === false && out.more === null]],
  ["dispatch_waiting", {}, (out) => [out.queueErrors, out.complete === false]],
  ["dispatch_setup", {}, null], ["dispatch_hosts", {}, null], ["dispatch_models", {}, null],
  ["dispatch_secrets", {}, null], ["dispatch_connections", {}, null],
]);

test("every tool registered as read-only is in the census of tools that write nothing (#1036)", () => {
  const registered = Object.values(tools()).filter((t) => /^Read-only\b/.test(t.description)).map((t) => t.name).sort();
  assert.deepEqual(READ_TOOLS.map(([name]) => name).sort(), registered, "a tool that says Read-only joins READ_TOOLS, and the census below");
});

test("the read tools write nothing to Valkey: no key appears, goes or changes, every command each sends is a read, and what a pruning reader removes stays until a person's surface reads (#1036)", { timeout: 180_000, skip: LIVE ? false : "needs VALKEY_TEST_URL" }, async () => {
  // Through the recording proxy (the wire test's, below), so each tool is also held to the commands it sends, and a
  // tool that sends none is seen: the census alone passed for two tools that never asked Valkey anything.
  const named = await namedReadScripts();
  const proxy = await recordingProxy(LIVE);
  const fx = deployment({ valkey: proxy.url });
  const { default: IORedis } = await import("ioredis");
  const r = new IORedis(LIVE, { maxRetriesPerRequest: 1 });
  const tag = `${process.pid}-${Date.now().toString(36)}`;
  const liveHost = `h1036-${tag}`;
  const staleHost = `gone1036-${tag}`;
  const staleHeld = `held1036-${tag}`;
  const staleRun = `run1036-${tag}`;
  const scanAll = async () => {
    const keys = [];
    let cursor = "0";
    do {
      const [next, batch] = await r.scan(cursor, "COUNT", 1000);
      cursor = String(next);
      keys.push(...batch);
    } while (cursor !== "0");
    return keys.sort();
  };
  // A key with an expiry is not this test's and may go by itself between two looks: left out by name, from the start.
  const expiring = new Set();
  for (const key of await scanAll()) if ((await r.pttl(key)) >= 0) expiring.add(key);
  const census = async () => {
    const rows = {};
    for (const key of await scanAll()) if (!expiring.has(key)) rows[key] = (await r.dumpBuffer(key))?.toString("base64") ?? null;
    return rows;
  };
  const changesOf = (before, after) => [
    ...Object.keys(after).filter((k) => !Object.hasOwn(before, k)).map((k) => `+${k}`),
    ...Object.keys(before).filter((k) => !Object.hasOwn(after, k)).map((k) => `-${k}`),
    ...Object.keys(before).filter((k) => Object.hasOwn(after, k) && after[k] !== before[k]).map((k) => `~${k}`),
  ];
  const planted = async () => ({ host: await r.sismember(HOST_SET, staleHost), held: await r.sismember("wait:held", staleHeld), run: (await r.zscore("runs:index", staleRun)) !== null ? 1 : 0 });
  // The queues a reader builds for this deployment: the shared one and the live host's own.
  const queueKeys = async () => (await scanAll()).filter((k) => k.startsWith("bull:pi-jobs:") || k.startsWith(`bull:pi-jobs@${liveHost}:`) || k.startsWith("bull:pi-jobs@mini1:"));
  // The database as this test found it: every key's name, and the queue keys it takes away, to put back at the end.
  const found = new Set(await scanAll());
  const taken = [];
  for (const key of await queueKeys()) taken.push([key, await r.dumpBuffer(key), await r.pttl(key)]);
  try {
    // An envelope and its projects, so dispatch_allocations reads Valkey too, on the real client: with the per-job cap
    // an envelope needs to be valid (`maxCostUsd`), which the fixture lacked, so the tool answered from the file alone.
    writeFileSync(fx.files.projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
    writeFileSync(fx.files.envelope, JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", _other: "0" }, defaultWeights: { shop: 1, _other: 0 }, delegation: { enabled: false } }));
    writeFileSync(fx.files.settings, JSON.stringify({ model: "m", maxCostUsd: "2", secretProfiles: { prod: "/opt/pi/resolve.sh" } }));
    // A cron trigger beside the label one, so dispatch_triggers reads its stall counter: over a file with no cron
    // trigger it has nothing to ask Valkey.
    mkdirSync(join(fx.files.logs, "..", "repo"), { recursive: true });
    writeFileSync(fx.files.triggers, JSON.stringify({ triggers: [{ on: { type: "label", any: ["bug"] }, run: { kind: "github", flow: "fix" } }, { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: join(fx.files.logs, "..", "repo"), flow: "fix", task: "look" } }] }));
    indexMod._setAllocationSeamsForTests({});
    await r.sadd(HOST_SET, liveHost, staleHost);
    await r.hset(`host:h:${liveHost}`, { name: liveHost, routes: "true", beatAt: String(Date.now()), jobs: "[]" });
    await r.sadd("wait:held", staleHeld);
    await r.zadd("runs:index", Date.now(), staleRun);

    const wrote = {};
    const sentNotReads = {};
    const asked = {};
    // What a connection sends for itself, which is no question a tool asks.
    const CONNECTION = new Set(["SELECT", "CLIENT SETINFO", "CLIENT SETNAME", "INFO", "PING", "QUIT"]);
    for (const [name, params] of READ_TOOLS) {
      // No queue of this deployment exists when a tool starts, so a read that builds one shows as its meta key: writing
      // a meta hash that is already there with the same fields changes nothing a census can see.
      const left = await queueKeys();
      if (left.length > 0) await r.del(...left);
      const before = await census();
      await settle(60);
      proxy.take();
      const out = await tool(name, params);
      await settle(60);
      const sent = proxy.take();
      const bad = notReads(sent, named);
      if (bad.length > 0) sentNotReads[name] = bad;
      asked[name] = sent.filter((c) => !CONNECTION.has(c.name)).length;
      const changes = changesOf(before, await census());
      const still = await planted();
      const pruned = Object.entries(still).filter(([, there]) => there !== 1).map(([what]) => `pruned ${what}`);
      if (changes.length > 0 || pruned.length > 0) wrote[name] = [...changes, ...pruned];
      assert.equal(out?.threw, undefined, `${name} answered (${out?.threw})`);
      // Put back what a tool pruned, so each tool is measured against the same state.
      await r.sadd(HOST_SET, staleHost);
      await r.sadd("wait:held", staleHeld);
      await r.zadd("runs:index", Date.now(), staleRun);
    }
    assert.deepEqual(wrote, {}, "each read tool against the keys it added (+), removed (-) or changed (~), and what it pruned");
    assert.deepEqual(sentNotReads, {}, "each read tool against the commands it sent that are not reads");
    // Every tool but the one that answers from a file alone asked Valkey something, so none passed by asking nothing.
    assert.deepEqual(Object.entries(asked).filter(([, n]) => n === 0).map(([name]) => name).sort(), FILE_ONLY_READ_TOOLS, JSON.stringify(asked));
    assert.deepEqual(await planted(), { host: 1, held: 1, run: 1 });
    assert.deepEqual(await queueKeys(), [], "and no queue's key was made by reading");

    // The held index behind a crowd of stale members (issue #1036): 1,996 members with no hash (the one planted above
    // among them) and four real holds, 2,000 in all, as many as one read looks at.
    // Nothing a deployment run from the tools and the web console does prunes this index, and the read cut it at 200
    // members before it skipped the stale ones, so `dispatch_waits` answered no hold at all, on every call.
    const crowd = Array.from({ length: 1995 }, (_, i) => `gone1036-${tag}-${i}`);
    const holds = ["a", "b", "c", "d"].map((h) => `hold1036-${tag}-${h}`);
    await r.sadd("wait:held", ...crowd, ...holds);
    for (const id of holds) await r.hset(`wait:job:${id}`, { since: String(Date.now() - 60_000), target: "acme/web#7", label: "ci" });
    try {
      const waits = JSON.parse((await tool("dispatch_waits", {})).content[0].text);
      assert.deepEqual([waits.complete, waits.jobs.map((j) => j.jobId).sort()], [true, [...holds].sort()], "the four holds, and the list is whole");
      assert.equal(await r.scard("wait:held"), 2000, "and nothing was removed");
      // One member more is past what a read looks at: the list then says it is not whole, and still removes nothing.
      await r.sadd("wait:held", `gone1036-${tag}-past`);
      const past = JSON.parse((await tool("dispatch_waits", {})).content[0].text);
      assert.deepEqual([past.complete, await r.scard("wait:held")], [false, 2001]);
      await r.srem("wait:held", `gone1036-${tag}-past`);
    } finally {
      await r.srem("wait:held", ...crowd, ...holds);
      await r.del(...holds.map((id) => `wait:job:${id}`));
    }

    // A person's surface still prunes: /dispatch status the registry's and the held index's stale members, and the
    // panel's reader the run mirror's.
    await command("status");
    assert.deepEqual(await planted(), { host: 0, held: 0, run: 1 }, "/dispatch status prunes the registry and the held index, as before");
    await withPanel(async () => {
      const end = Date.now() + 8000;
      while ((await planted()).run === 1 && Date.now() < end) await settle(50);
    });
    assert.equal((await planted()).run, 0, "the panel's reader prunes the run mirror, as before");
  } finally {
    await r.srem(HOST_SET, liveHost, staleHost).catch(() => {});
    await r.del(`host:h:${liveHost}`).catch(() => {});
    await r.srem("wait:held", staleHeld).catch(() => {});
    await r.zrem("runs:index", staleRun).catch(() => {});
    // Every key that was not here at the start is this test's doing (what the person's surfaces built for the queues,
    // which are not read-only, and the mirror's horizon their prune records), and the queue keys it took away go back.
    const made = (await scanAll().catch(() => [])).filter((k) => !found.has(k));
    if (made.length > 0) await r.del(...made).catch(() => {});
    for (const [key, dump, ttl] of taken) if (dump) await r.restore(key, ttl > 0 ? ttl : 0, dump, "REPLACE").catch(() => {});
    r.disconnect();
    proxy.close();
    indexMod._setAllocationSeamsForTests({});
    fx.restore();
  }
});

// Issue #1036: the person's surfaces keep the default, and two of them were held to it by no test: with `readOnly`
// passed at either, everything stayed green. Seen on the wire, since a meta hash written again and a member pruned
// and planted back leave no key changed.
test("/dispatch triggers and the setup wizard's probe keep the default: each builds its queues with the meta write and prunes a stale registry member, as before (#1036)", { timeout: 60_000, skip: LIVE ? false : "needs VALKEY_TEST_URL" }, async () => {
  const proxy = await recordingProxy(LIVE);
  const fx = deployment({ valkey: proxy.url });
  const { default: IORedis } = await import("ioredis");
  const r = new IORedis(LIVE, { maxRetriesPerRequest: 1 });
  const stale = `gone1036-${process.pid}-${Date.now().toString(36)}`;
  const { detectDeployment } = await jiti.import(fileURLToPath(new URL("../src/setup-wizard.ts", import.meta.url)));
  /** What `surface` sent that writes: the meta hash of a queue it built, and the stale member it removed. */
  const writesOf = async (surface) => {
    await r.sadd(HOST_SET, stale);
    await settle(60);
    proxy.take();
    await surface();
    await settle(120);
    const sent = proxy.take();
    return { meta: sent.some((c) => c.name === "HSET" && c.args[0] === "bull:pi-jobs:meta"), pruned: sent.some((c) => c.name === "SREM" && c.args[0] === HOST_SET && c.args.includes(stale)), member: await r.sismember(HOST_SET, stale) };
  };
  try {
    assert.deepEqual(await writesOf(() => command("triggers")), { meta: true, pruned: true, member: 0 }, "/dispatch triggers");
    const empty = tempDir("pd-1036-probe-");
    let state = null;
    assert.deepEqual(await writesOf(async () => { state = (await detectDeployment({ env: { PI_DISPATCH_DEPLOYMENT_FILE: join(empty, "absent.json"), VALKEY_URL: proxy.url }, cwd: empty })).state; }), { meta: true, pruned: true, member: 0 }, "the wizard's probe");
    assert.equal(state, "reachable", "and the probe found the queue");
  } finally {
    await r.srem(HOST_SET, stale).catch(() => {});
    r.disconnect();
    proxy.close();
    fx.restore();
  }
});

// ---- the rule on the wire: a read writes nothing, and a page view and a preview are reads (issue #1036) ----
//
// A real console (`serve`, as a person starts it) behind a proxy that records every command it sends to a real Valkey,
// database 9 as above. EVERY page of the console's own page table is opened, the state document and each live page's
// event stream are read, and EVERY action of its own action table is previewed, first on a Valkey that holds nothing
// and then on a seeded fleet that holds what a pruning reader removes (a `host:live` member with no row, a `wait:held`
// member with no hash, a run mirror id with no record). Every command sent must be a read. A page or an action added
// later joins by itself: the walk is over `PAGES` and `ACTIONS`, and a page that needs a query, or an action whose
// preview needs a body to reach its reads, is given one in the two tables below.
//
// The wire, not a census of keys: an HSET of the fields a hash already holds and an SREM of a member that comes back
// leave no key changed, and both were what the pages and previews sent.

/** The commands a read sends, by name. Anything else on the wire is a write, or a command this list has to be told of. */
const WIRE_READS = new Set([
  // a connection's own: its database, its name for CLIENT LIST, the server's facts, and its end
  "SELECT", "CLIENT SETINFO", "CLIENT SETNAME", "INFO", "PING", "QUIT",
  // reads
  "CLIENT LIST", "TIME", "EXISTS", "TYPE", "PTTL", "SCAN", "GET", "MGET", "HEXISTS", "HGET", "HGETALL", "HMGET", "LLEN", "LRANGE", "SCARD", "SISMEMBER", "SMEMBERS", "SSCAN",
  "ZCARD", "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZREVRANGEBYSCORE", "ZSCORE", "XLEN", "XRANGE", "XREVRANGE",
]);
/** The commands a script may call and still be a read. */
const SCRIPT_READS = new Set(["EXISTS", "TYPE", "GET", "HEXISTS", "HGET", "HGETALL", "HLEN", "HMGET", "LINDEX", "LLEN", "LPOS", "LRANGE", "SCARD", "SISMEMBER", "SMEMBERS", "ZCARD", "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZREVRANGEBYSCORE", "ZSCORE"]);

/** One of BullMQ's own scripts, by the name of its file, as the installed BullMQ sends it. */
async function bullmqScript(name) {
  const dir = join(dirname(createRequire(import.meta.url).resolve("bullmq/package.json")), "dist", "esm", "scripts");
  const file = readdirSync(dir).find((f) => new RegExp(`^${name}-\\d+\\.js$`).test(f));
  assert.ok(file, `BullMQ ships a ${name} script`);
  return (await import(pathToFileURL(join(dir, file)).href))[name].content;
}

/**
 * THE THREE NAMED READ SCRIPTS: scripts a read runs whose BODY holds a write that the read never reaches. Each is
 * matched by its whole body, and held here to holding no other write than the one named, so a new one is seen.
 *   - BullMQ's `getCounts` and `getRanges` (a queue's counts and its job lists): an RPOP of the marker BullMQ 4 kept at
 *     the tail of the wait and paused lists. This repository has pinned BullMQ 5 since its first commit, so no
 *     deployment's list holds one and the RPOP never runs (`DES-QUEUE-BULLMQ-OVER-CUSTOM`).
 *   - the run mirror's `READ_SCRIPT`: it starts with the helper functions it shares with the trim and prune scripts,
 *     which hold their DEL and HSET; the read calls `sinceIsHash` alone, and what follows the shared part is reads.
 */
async function namedReadScripts() {
  const writesOf = (body) => [...new Set(scriptCommands(body).filter((c) => !SCRIPT_READS.has(c)))].sort();
  const counts = await bullmqScript("getCounts");
  const ranges = await bullmqScript("getRanges");
  assert.deepEqual([writesOf(counts), writesOf(ranges)], [["RPOP"], ["RPOP"]], "BullMQ's two list scripts hold the marker's RPOP and no other write");
  let shared = 0;
  while (shared < READ_SCRIPT.length && READ_SCRIPT[shared] === PRUNE_SCRIPT[shared] && READ_SCRIPT[shared] === TRIM_SCRIPT[shared]) shared += 1;
  assert.deepEqual([writesOf(READ_SCRIPT.slice(0, shared)), writesOf(READ_SCRIPT.slice(shared))], [["DEL", "HSET"], []], "the run mirror's read holds a write only in the helpers it shares, and calls none");
  return new Set([counts, ranges, READ_SCRIPT]);
}

/** What of `commands` is not a read: each such command as "NAME key", a script as the commands it calls that are none. */
function notReads(commands, named) {
  const out = [];
  for (const c of commands) {
    if (c.name === "EVAL") {
      if (named.has(c.script)) continue;
      const writes = [...new Set(scriptCommands(c.script).filter((x) => !SCRIPT_READS.has(x)))];
      if (writes.length > 0) out.push(`EVAL calling ${writes.join(", ")}: ${c.script.replace(/\s+/g, " ").trim().slice(0, 70)}`);
    } else if (!WIRE_READS.has(c.name)) out.push(`${c.name} ${c.args.slice(0, 2).join(" ")}`.trim());
  }
  return [...new Set(out)];
}

/** The query a page needs to draw its subject; a page not listed is opened at its path alone. */
const WIRE_PAGE_QUERY = Object.freeze({ run: "?id=local-wire-done", host: "?name=wirehost", venue: "?name=local", trigger: "?index=1", project: "?id=shop" });

/**
 * The body an action's preview needs to get past its input checks and reach its reads, over the seeded fleet; an
 * action not listed is previewed with an empty body. `digest` is the trigger page's own, read off the page.
 */
const wirePreviewBodies = ({ repo, digest }) => ({
  "run-enqueue": { folder: repo, flow: "fix", task: "look" },
  "cancel-active": { jobId: "local-wire-none" },
  "cancel-held": { jobId: "gh-wire-held" },
  "cancel-queued": { jobId: "local-wire-w1", queue: "pi-jobs" },
  "retry-failed": { jobId: "local-wire-f1", queue: "pi-jobs@wirehost" },
  "remove-failed": { jobId: "local-wire-f1", queue: "pi-jobs@wirehost" },
  "retry-all-failed": { queue: "pi-jobs@wirehost" },
  "remove-all-failed": { queue: "pi-jobs@wirehost" },
  "trigger-fire": { index: 1 },
  rerun: { jobId: "local-wire-done" },
  "parked-answer": { jobId: "gh-wire-parked", text: "yes" },
  steer: { jobId: "local-wire-w1", mode: "steer", text: "go on" },
  "steer-withdraw": { jobId: "local-wire-w1", id: "a".repeat(32) },
  "queue-pause": { queue: "pi-jobs@wirehost" },
  "queue-resume": { queue: "pi-jobs@wirehost" },
  "trigger-edit": { index: 1, flow: "check" },
  // A field that needs a later version of the job data, so the edit's version gate reads the live hosts.
  "trigger-environment-edit": { index: 1, pageDigest: digest, excludeExtensions: ["some-extension"] },
  "package-canary": { index: 1, name: "pi-lint", version: "1.0.0" },
});

/**
 * THE KNOWN EXCEPTIONS, by name, each with why it is one. Neither is judged as a page read below.
 *   - Signing in appends its row to the audit log. It is the one request here that is not a read, so what it sends is
 *     not judged; the walk starts after it.
 *   - The zero touch page (`/runs/zero-touch`) repairs a pending entry of its accounting outbox, and a pending fix,
 *     before it reads: a write, when one is pending. Not changed here. This deployment has none pending, so on this
 *     walk the page sends reads only, and it is held to that like every other page.
 */
const WIRE_EXCEPTIONS = Object.freeze(["POST /login", "GET /runs/zero-touch with an accounting entry or a fix pending repair"]);

test("on the wire, every page of the console, its state document and streams, and every action's preview send reads only, on an empty Valkey and on a seeded fleet (#1036)", { timeout: 300_000, skip: LIVE ? false : "needs VALKEY_TEST_URL" }, async () => {
  const named = await namedReadScripts();
  const { default: IORedis } = await import("ioredis");
  const { Worker } = await import("bullmq");
  const r = new IORedis(LIVE, { maxRetriesPerRequest: 1 });
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const scanAll = async () => {
    const keys = [];
    let cursor = "0";
    do {
      const [next, batch] = await r.scan(cursor, "COUNT", 1000);
      cursor = String(next);
      keys.push(...batch);
    } while (cursor !== "0");
    return keys.sort();
  };
  // The database as found, taken away for the walk and put back after it: the first walk is over a Valkey that holds nothing.
  const taken = [];
  for (const key of await scanAll()) taken.push([key, await r.dumpBuffer(key), await r.pttl(key)]);
  if (taken.length > 0) await r.del(...taken.map(([key]) => key));
  const dir = tempDir("pd-1036-wire-");
  const repo = join(dir, "repo");
  const logs = join(dir, "logs");
  mkdirSync(repo);
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(dir, "triggers.json"), JSON.stringify({ triggers: [
    { on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "triage" } },
    { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: repo, flow: "fix", task: "look", maxCostUsd: "1" } },
  ] }));
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
  let proxy = null;
  const opened = [];
  /** One console over the proxy: started, signed in, walked by `fn(call)`, stopped. Returns what the walk found. */
  const withConsole = async (fn) => {
    const env = { PATH: process.env.PATH, HOME: dir, VALKEY_URL: proxy.url, PI_LOGS_DIR: logs, PI_TRIGGERS_FILE: join(dir, "triggers.json"), PI_PROJECTS_FILE: join(dir, "projects.json"), PI_CONSOLE_LISTEN: "127.0.0.1:0", PI_WORKER_NAME: "wirehost", PI_MAX_COST_USD: "2", PI_DISPATCH_RUN_ROOTS: dir, PI_DISPATCH_DEPLOYMENT_FILE: join(dir, "no-pointer.json") };
    const err = [];
    const io = { env, now: () => Date.now(), uid: process.geteuid?.(), err: (line) => err.push(line) };
    const printed = [];
    if (!existsSync(join(dir, "console-tokens.json"))) assert.equal(await runCli(["token", "add", "--name", "ops", "--role", "operator", "--deployment", dir], { ...io, out: (line) => printed.push(line) }), 0, err.join("\n"));
    else assert.equal(await runCli(["token", "rotate", "--name", "ops", "--deployment", dir], { ...io, out: (line) => printed.push(line) }), 0, err.join("\n"));
    const token = printed.join("\n").match(/pdc_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(token, "the token is printed once");
    let stop = () => {};
    const until = new Promise((resolve) => (stop = resolve));
    let listening;
    const up = new Promise((resolve) => (listening = resolve));
    const running = runCli(["serve", "--deployment", dir], { ...io, out: () => {}, until, onListening: listening });
    try {
      const port = (await up).address().port;
      const call = (method, path, { body, cookie, stream = false } = {}) => new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}), ...(data !== null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...(stream ? { accept: "text/event-stream" } : {}), origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" };
        const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
          // An event stream never ends by itself: it is read for a moment and dropped.
          if (stream) setTimeout(() => { req.destroy(); resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }); }, 400);
        });
        req.on("error", (e) => (stream ? resolve({ status: 0, text: String(e) }) : reject(e)));
        req.end(data ?? undefined);
      });
      // The console's start is held to the rule too: it read the fleet before anyone asked.
      await settle(1200);
      const started = notReads(proxy.take(), named);
      const login = await call("POST", "/login", { body: { token } });
      assert.equal(login.status, 200, login.text.slice(0, 200));
      const cookie = [].concat(login.headers["set-cookie"]).map((c) => c.split(";")[0]).join("; ");
      await settle(300);
      proxy.take(); // WIRE_EXCEPTIONS: signing in is not a read
      const found = await fn((method, path, options = {}) => call(method, path, { ...options, cookie }));
      return { started, ...found };
    } finally {
      stop();
      await running.catch(() => {});
    }
  };
  /** Every page, the state document, each live page's stream, then every action's preview: what was not a read, by request. */
  const walk = async (call, bodies) => {
    const wrote = {};
    const answered = {};
    // A short wait after each answer, for what the request still sends once it has answered (a queue's close). A
    // command that comes later still is judged with the next request: the rule is the same for all of them.
    const judge = async (where, res, wait = 120) => {
      await settle(wait);
      const sent = proxy.take();
      const bad = notReads(sent, named);
      answered[where] = res.status;
      if (bad.length > 0) wrote[where] = bad;
    };
    for (const [id, page] of Object.entries(PAGES)) await judge(`GET ${page.path}${WIRE_PAGE_QUERY[id] ?? ""}`, await call("GET", `${page.path}${WIRE_PAGE_QUERY[id] ?? ""}`));
    await judge("GET /api/state", await call("GET", "/api/state"));
    for (const [id, page] of Object.entries(PAGES)) if (page.live) await judge(`GET /api/events?page=${id}`, await call("GET", `/api/events?page=${id}${id === "run" ? "&id=local-wire-done" : id === "host" ? "&name=wirehost" : ""}`, { stream: true }), 60);
    for (const action of ACTIONS) await judge(`preview ${action.name}`, await call("POST", `/api/act/${action.name}/preview`, { body: bodies[action.name] ?? {} }));
    return { wrote, answered };
  };
  try {
    proxy = await recordingProxy(LIVE);
    // 1. A Valkey that holds nothing: the console starts, every page is opened and every action previewed, and it still holds nothing.
    const empty = await withConsole((call) => walk(call, wirePreviewBodies({ repo, digest: "0".repeat(64) })));
    assert.deepEqual(empty.started, [], "the console's start sends reads only");
    assert.deepEqual(empty.wrote, {}, "on an empty Valkey: each request against what it sent that is not a read");
    assert.deepEqual(await scanAll(), ["console:audit"], "and a console pointed at a Valkey that holds nothing leaves it holding nothing but the row of the sign-in");
    assert.ok(Object.keys(empty.answered).length >= Object.keys(PAGES).length + ACTIONS.length, "every page and every action was walked");

    // 2. A seeded fleet: a live host and what a pruning reader removes, a job that waits, one that failed, one held, and
    // two run records (one to re-run, one parked).
    const direct = (name) => { const q = makeQueue(parseConnection(LIVE), { name }); opened.push(q); return q; };
    await r.sadd(HOST_SET, "wirehost", "gone-wire");
    await r.hset(hostKey("wirehost"), { name: "wirehost", routes: "true", beatAt: String(Date.now()), jobs: "[]" });
    await r.sadd(HELD_SET, "gone-held", "gh-wire-held");
    await r.hset(heldKey("gh-wire-held"), { since: String(Date.now() - 60_000), target: "acme/web#7", label: "ci", checks: "1" });
    await r.zadd("runs:index", Date.now(), "gone-run");
    await direct("pi-jobs").add("local", { kind: "local", folder: repo, flow: "fix", task: "look" }, { jobId: "local-wire-w1" });
    const failing = direct("pi-jobs@wirehost");
    await failing.add("local", { kind: "local", folder: repo, flow: "fix", task: "look" }, { jobId: "local-wire-f1", attempts: 1 });
    const worker = new Worker("pi-jobs@wirehost", async () => { throw new Error("boom"); }, { connection: parseConnection(LIVE) });
    const end = Date.now() + 10_000;
    while ((await failing.getJobCounts("failed")).failed !== 1 && Date.now() < end) await settle(50);
    await worker.close();
    const iso = (ms) => new Date(ms).toISOString();
    const record = (rec) => writeFileSync(join(logs, `${sanitizeJobId(rec.jobId)}.json`), JSON.stringify(rec));
    record({ jobId: "local-wire-done", kind: "local", target: "repo", flow: "fix", startedAt: iso(Date.now() - 120_000), endedAt: iso(Date.now() - 60_000), outcome: "completed", reason: null, host: "wirehost" });
    record({ jobId: "gh-wire-parked", kind: "github", target: "acme/web#1", flow: "triage", startedAt: iso(Date.now() - 120_000), endedAt: iso(Date.now() - 60_000), outcome: "completed", reason: "awaiting-input", host: "wirehost" });
    const planted = async () => ({ host: await r.sismember(HOST_SET, "gone-wire"), held: await r.sismember(HELD_SET, "gone-held"), run: (await r.zscore("runs:index", "gone-run")) !== null ? 1 : 0 });
    // Every key but the audit log's, which the second sign-in adds its row to, and one with an expiry, which goes by
    // itself (the lock the worker above took for its stalled check).
    const census = async () => {
      const kinds = {};
      for (const key of await scanAll()) if (key !== "console:audit" && (await r.pttl(key)) < 0) kinds[key] = await r.type(key);
      return kinds;
    };
    const before = await census();
    const seeded = await withConsole(async (call) => {
      // The trigger page's own digest, which its edit form sends back, so the edit's preview reaches its version gate.
      const page = await call("GET", "/config/trigger?index=1");
      const digest = /name="pageDigest" value="([a-f0-9]{64})"/.exec(page.text)?.[1] ?? "0".repeat(64);
      await settle(250);
      proxy.take();
      return { digest, ...(await walk(call, wirePreviewBodies({ repo, digest }))) };
    });
    assert.deepEqual(seeded.started, [], "the console's start over a seeded fleet sends reads only");
    assert.deepEqual(seeded.wrote, {}, "on a seeded fleet: each request against what it sent that is not a read");
    assert.deepEqual(await planted(), { host: 1, held: 1, run: 1 }, "what a pruning reader removes is still there");
    assert.deepEqual(await census(), before, "and no key was made or removed");
    // The previews that have to reach the fleet did: each answered past its input checks.
    for (const name of ["cancel-queued", "retry-failed", "remove-failed", "retry-all-failed", "remove-all-failed", "fleet-pause", "queue-pause", "cancel-all-held", "cancel-held"]) assert.equal(seeded.answered[`preview ${name}`], 200, `preview ${name} answered with a ticket (${seeded.answered[`preview ${name}`]})`);
    assert.match(seeded.digest, /^[a-f0-9]{64}$/, "the trigger page's digest was read off the page, so its edit's preview reached its gate");
    assert.equal(seeded.answered["preview trigger-environment-edit"], 409, "its gate read the live hosts and refused: the seeded host publishes no version");
    assert.equal(WIRE_EXCEPTIONS.length, 2);
  } finally {
    for (const q of opened) await q.close().catch(() => {});
    proxy?.close();
    // Leave the database as found: everything the seeding made goes, and what was taken away comes back.
    const left = await scanAll().catch(() => []);
    if (left.length > 0) await r.del(...left).catch(() => {});
    for (const [key, dump, ttl] of taken) if (dump) await r.restore(key, ttl > 0 ? ttl : 0, dump, "REPLACE").catch(() => {});
    r.disconnect();
  }
});

// Issue #1064: one queue whose meta key holds a string made every read of the deployment fail whole, as a Valkey that
// could not be reached: `/dispatch status`, `dispatch_status`, the panel, and the setup wizard's probe, which then took
// a deployed Valkey for none.
test("dispatch_status names the keys a queue left out of its read comes under (#1064)", () => {
  assert.match(tools().dispatch_status.description, /In queue: partial true means a queue's read failed: unavailableQueues names each queue left out of the counts, and queueErrors gives the code of Valkey's error reply for each one answered with an error/);
  assert.match(tools().dispatch_status.description, /pausedState is false while a queue is left out, since whether that queue is paused is not known/);
});

test("every read tool that rests on the queues' reads tells a model what queueErrors means for its answer (#1064)", () => {
  const t = tools();
  for (const [name, , unread] of READ_TOOLS) assert.equal(/queueErrors/.test(t[name].description), unread !== null, name);
  assert.match(t.dispatch_failed.description, /`queueErrors` gives the code of Valkey's error reply for each queue whose paused state or counts was answered with one: its failed jobs are in no total, so `more` is null and `complete` false/);
  assert.match(t.dispatch_waiting.description, /whether that queue is paused is not known, so a job in its wait list or its prioritized set is listed in the bucket `unknown`, neither a free slot nor a pause, and `complete` is false/);
  // Issue #1036: a queue one of whose lists was answered with an error is named too, and its jobs are a floor.
  assert.match(t.dispatch_waiting.description, /A queue one of whose lists of waiting jobs was answered with an error is named there too: the jobs in that list are in no row, so `jobs` is a floor for it\./);
});

// Issue #1036: every description that hands a model an error reply's code says what a code means by its class, in the
// one sentence built from the worker's table, and none tells it to repair a key whatever the code is.
test("the tools that hand on an error reply's code say what a code means by its class, and none says a row did not answer or that a key has to be repaired whatever the code (#1036)", async () => {
  const { REPLY_CODE_MEANING } = readModel;
  const { REPLY_CODES_BY_CLASS, replyErrorClass } = await import("@edgehero/pi-dispatch/connection");
  const t = tools();
  for (const name of ["dispatch_status", "dispatch_hosts", "dispatch_failed", "dispatch_waiting"]) assert.ok(t[name].description.includes(REPLY_CODE_MEANING), name);
  // The sentence names every code the table names, each under its own class, and claims a remedy for the lasting two alone.
  for (const [cls, codes] of Object.entries(REPLY_CODES_BY_CLASS)) for (const code of codes) assert.ok(REPLY_CODE_MEANING.includes(code) && replyErrorClass(code) === cls, code);
  assert.match(REPLY_CODE_MEANING, /WRONGTYPE, the key holds another kind of value and has to be removed or repaired; NOPERM, NOAUTH, WRONGPASS, this deployment's Valkey user lacks a permission \(its ACL\) and no key is at fault; BUSY, LOADING, TRYAGAIN, CLUSTERDOWN, MASTERDOWN, Valkey could not serve the read then and a later call may read it; any other code says no more than itself/);
  for (const [name, tool] of Object.entries(t)) assert.doesNotMatch(tool.description, /row did not answer|its key has to be repaired|waiting does not read it/, name);
  // A registry read in part: the row was not read, whatever the reason, and the workers counted are the rows that were.
  assert.match(t.dispatch_status.description, /the schedulers of a host whose row was not read may be missing from the list/);
  assert.match(t.dispatch_status.description, /registryReadInPart true means the registry answered and some hosts' rows were not read, and workers is then a floor: it counts the rows that were read/);
  assert.match(t.dispatch_status.description, /at most 20 of them \(hostErrorsMore counts the rest\)/);
  assert.match(t.dispatch_capacity.description, /the jobs running now on a host whose row was not read are not counted/);
});

/**
 * Run `fn(queue)` on the live Valkey with one live host whose queue's meta key is a string, so that queue's paused read
 * is answered with WRONGTYPE, then take away every key that was not there before: the host's row, the string, and what
 * the readers built.
 */
async function withErroredQueue(fn) {
  const fx = deployment({ valkey: LIVE });
  const { default: IORedis } = await import("ioredis");
  const r = new IORedis(LIVE, { maxRetriesPerRequest: 1 });
  const host = `h1064-${process.pid}-${Date.now().toString(36)}`;
  const queue = `pi-jobs@${host}`;
  const scanAll = async () => {
    const keys = [];
    let cursor = "0";
    do {
      const [next, batch] = await r.scan(cursor, "COUNT", 1000);
      cursor = String(next);
      keys.push(...batch);
    } while (cursor !== "0");
    return keys;
  };
  const found = new Set(await scanAll());
  try {
    await r.sadd(HOST_SET, host);
    await r.hset(`host:h:${host}`, { name: host, routes: "true", beatAt: String(Date.now()), jobs: "[]" });
    await r.set(`bull:${queue}:meta`, "not a hash");
    return await fn(queue);
  } finally {
    await r.srem(HOST_SET, host).catch(() => {});
    const made = (await scanAll().catch(() => [])).filter((k) => !found.has(k));
    if (made.length > 0) await r.del(...made).catch(() => {});
    r.disconnect();
    fx.restore();
  }
}

// One table, one loop: READ_TOOLS says which read tools rest on the queues' own reads. Each of those names the queue
// and says its answer is not whole; each of the others answers, where the ones that build a reader had thrown or
// answered "unknown", and says nothing of a queue its answer does not hold.
test("every read tool answers over a queue whose meta key holds a string, and the ones that rest on the queues' reads name it and say they are not whole (#1064)", { timeout: 180_000, skip: LIVE ? false : "needs VALKEY_TEST_URL" }, async () => {
  const answerOf = async (name, params) => {
    const out = await tool(name, params);
    assert.equal(out?.threw, undefined, `${name} answered (${out?.threw})`);
    return JSON.parse(out.content[0].text);
  };
  await withErroredQueue(async (queue) => {
    for (const [name, params, unread] of READ_TOOLS) {
      const answer = await answerOf(name, params);
      assert.ok(!JSON.stringify(answer).includes("Operation against"), `${name}: the reply's code alone`);
      if (unread === null) assert.ok(!JSON.stringify(answer).includes("queueErrors"), `${name} holds no queue's paused state or counts, so it names none`);
      else assert.deepEqual(unread(answer), [{ [queue]: "WRONGTYPE" }, true], `${name} names the queue and says it is not whole`);
    }
    // The held money is the hosts' rows, read: over such a queue it was "unknown" while the snapshot failed whole.
    assert.equal((await answerOf("dispatch_costs", {})).held.unknown, undefined);
  });
  // The control, the same deployment read whole: no tool names a queue.
  const fx = deployment({ valkey: LIVE });
  try {
    for (const [name, params, unread] of READ_TOOLS) if (unread !== null) assert.equal(unread(await answerOf(name, params))[0], undefined, `${name} read whole`);
  } finally {
    fx.restore();
  }
});

test("over a queue whose meta key holds a string, dispatch_status, /dispatch status and the panel name it and read the rest (#1064)", { timeout: 90_000, skip: LIVE ? false : "needs VALKEY_TEST_URL" }, async () => {
  await withErroredQueue(async (queue) => {
    const sentence = queueErrorsLine([{ queue, error: "WRONGTYPE" }]);
    const status = JSON.parse((await tool("dispatch_status", {})).content[0].text);
    assert.deepEqual([status.queue.unreachable, status.queue.partial, status.queue.unavailableQueues, status.queue.queueErrors, status.queue.pausedState], [undefined, true, [queue], { [queue]: "WRONGTYPE" }, false], JSON.stringify(status.queue));
    assert.ok(status.queue.queues >= 2 && typeof status.queue.counts.waiting === "number", "the shared queue is read and counted");
    assert.ok(!JSON.stringify(status).includes("Operation against"), "the reply's code alone");

    // `/dispatch status` answers in a message, not a note: the handler on a pi that keeps what it is sent.
    const sent = [];
    let handler = null;
    indexMod.default(new Proxy({}, { get: (_t, k) => (k === "registerCommand" ? (_n, def) => (handler = def.handler) : k === "sendMessage" ? (m) => sent.push(String(m?.content)) : () => {}) }));
    await handler("status", { hasUI: true, ui: scriptedUi().ui });
    const said = sent.join("\n");
    assert.ok(said.includes(`\n  ${sentence}\n`), said);
    assert.doesNotMatch(said, /Queue: unreachable|Operation against/);

    await withPanel(async (comp) => {
      await until(() => screen(comp).includes("Not read, so not in these counts"), `the panel to name the queue (${screen(comp).split("\n").slice(0, 4).join(" / ")})`);
      const drawn = screen(comp);
      assert.ok(drawn.includes(`└ ${sentence}`), drawn.split("\n").slice(0, 4).join("\n"));
      assert.doesNotMatch(drawn.split("\n").slice(0, 3).join("\n"), /unreachable/);
    });
  });
});

// The wizard asks "is a queue reachable here?" before it offers to set one up. One queue's error reply answered no.
test("the setup wizard's own probe finds the queue reachable on a Valkey that answers one queue's read with an error (#1064)", { timeout: 60_000, skip: LIVE ? false : "needs VALKEY_TEST_URL" }, async () => {
  const { detectDeployment } = await jiti.import(fileURLToPath(new URL("../src/setup-wizard.ts", import.meta.url)));
  await withErroredQueue(async () => {
    // No pointer, no path in the environment and no deployment files: the probe alone decides.
    const empty = tempDir("pd-1064-wizard-");
    const det = await detectDeployment({ env: { PI_DISPATCH_DEPLOYMENT_FILE: join(empty, "absent.json"), VALKEY_URL: LIVE }, cwd: empty });
    assert.deepEqual([det.state, det.detail], ["reachable", `queue reachable at ${LIVE}`]);
  });
});

// With a queue left out the deployment reads "partly paused" at most. A deployment whose every queue that was read IS
// paused must stay resumable from the tool and the command: the resume is sent, the queues that answer are resumed, and
// the queue Valkey answers with an error is said as that, in the kill switch's own words (issues #1014, #1041).
test("a fleet whose every read queue is paused beside one whose meta key holds a string is still resumed by dispatch_resume and /dispatch resume (#1064)", { timeout: 90_000, skip: LIVE ? false : "needs VALKEY_TEST_URL" }, async () => {
  const { makeQueue } = await import("@edgehero/pi-dispatch/queue");
  const { parseConnection } = await import("@edgehero/pi-dispatch/connection");
  const { default: IORedis } = await import("ioredis");
  const r = new IORedis(LIVE, { maxRetriesPerRequest: 1 });
  const pauseShared = async () => {
    const q = makeQueue(parseConnection(LIVE), { name: "pi-jobs" });
    await q.pause();
    await q.close();
    assert.equal(await r.hexists("bull:pi-jobs:meta", "paused"), 1);
  };
  try {
    await withErroredQueue(async (queue) => {
      await pauseShared();
      const status = JSON.parse((await tool("dispatch_status", {})).content[0].text).queue;
      assert.deepEqual([status.pausedState, status.pausedPartial, status.queueErrors], [false, true, { [queue]: "WRONGTYPE" }], "every queue that was read is paused: partly, never wholly");
      // The tool: the resume reaches the shared queue, and its answer says Valkey answered one with an error.
      const out = await tool("dispatch_resume", {});
      assert.equal(await r.hexists("bull:pi-jobs:meta", "paused"), 0, `resumed (${JSON.stringify(out).slice(0, 300)})`);
      assert.match(String(out?.threw), /Valkey answered a resume with an error, which can come after the queue was resumed/);
      // The command: the same, naming both queues.
      await pauseShared();
      const said = (await command("resume")).join("\n");
      assert.equal(await r.hexists("bull:pi-jobs:meta", "paused"), 0, said);
      assert.ok(said.includes(`ANSWERED WITH AN ERROR for ${queue} (its state could not be read, so it may have partly applied); known switched: pi-jobs`), said);
    });
  } finally {
    await r.hdel("bull:pi-jobs:meta", "paused").catch(() => {});
    r.disconnect();
  }
});
