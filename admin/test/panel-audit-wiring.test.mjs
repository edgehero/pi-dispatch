import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { panelWrite } from "../src/audited-write.mjs";
import { stripAnsi } from "../src/style.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { fakeAllocRedis } from "./helpers/fake-alloc-redis.mjs";

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

const ENV_KEYS = ["PI_LOGS_DIR", "PI_TRIGGERS_FILE", "PI_SETTINGS_FILE", "PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_PROJECTS_FILE", "PI_ENVELOPE_FILE", "VALKEY_URL", "PI_WORKER_NAME"];
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
  return Object.fromEntries(list.map((t) => [t.name, t]));
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
 * `reason` what the failed row says; `state` what the write changes (compared before and after, and unchanged when the
 * audit cannot be appended); `prepare` runs before the rows are counted.
 */
const CASES = [
  // ---- the extension's tools ----
  { site: "index.ts:fleet-pause", name: "dispatch_pause", kind: "fleet-pause", outcomes: ["ok", "failed"], reason: NOT_REACHED, run: () => tool("dispatch_pause", {}) },
  { site: "index.ts:fleet-resume", name: "dispatch_resume", kind: "fleet-resume", outcomes: ["ok", "failed"], reason: NOT_REACHED, run: () => tool("dispatch_resume", {}) },
  { site: "index.ts:run-enqueue", name: "dispatch_run", kind: "run-enqueue", outcomes: ["ok", "failed"], reason: /./, run: () => tool("dispatch_run", { folder: "/nowhere", flow: "fix", task: "t" }) },
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
    reason: /^job wiring-held-\d+ is no longer in the queue$/,
    live: true,
    prepare: async (fx) => {
      fx.jobId = `wiring-held-${process.pid}`;
      await seedHeld(fx.jobId);
    },
    run: async (fx) => {
      try {
        const res = await tool("dispatch_wait_cancel", { jobId: fx.jobId });
        assert.equal(res.threw, `rejected: job ${fx.jobId} is no longer in the queue`, "the tool found the held row and reached the cancel");
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
  // ---- the operator-typed /dispatch subcommands ----
  { site: "index.ts:run-enqueue", name: "/dispatch run", kind: "run-enqueue", outcomes: ["ok", "failed"], reason: /./, run: () => command("run /nowhere fix go") },
  { site: "index.ts:fleet-pause|fleet-resume", name: "/dispatch pause", kind: "fleet-pause", outcomes: ["ok", "failed"], reason: NOT_REACHED, run: () => command("pause") },
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
  const opts = { timeout: 30_000, ...(c.live && !LIVE ? { skip: "needs VALKEY_TEST_URL" } : {}) };
  test(`${c.name}: appends ${c.kind} (${c.outcomes.join(" then ")}) as the panel${c.state ? ", and writes nothing when the row cannot be appended" : ""}`, opts, async () => {
    const fx = deployment({ alloc: c.alloc, valkey: c.live ? LIVE : NO_VALKEY });
    try {
      await c.prepare?.(fx);
      const before = rowsOf(fx.files.logs).length;
      const state0 = c.state?.(fx);
      await c.run(fx);
      const rows = rowsOf(fx.files.logs).slice(before);
      assert.deepEqual(rows.map((r) => [r.kind, r.outcome, r.action, r.actor.role, r.actor.session]), c.outcomes.map((o) => [c.kind, o, "write", "panel", null]), JSON.stringify(rows));
      assert.equal(new Set(rows.map((r) => r.ticket)).size, 1, "one ticket ties the write's rows");
      if (c.reason) assert.match(rows.at(-1).reason, c.reason);
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

test("the table has exactly one row per audited call site in index.ts, secrets-command.ts and dashboard.ts", () => {
  const sites = ["index.ts", "secrets-command.ts", "dashboard.ts"].flatMap(sitesIn).sort();
  const table = CASES.map((c) => c.site).sort();
  assert.ok(sites.length >= 40, `the scan found the call sites (${sites.length})`);
  assert.deepEqual(table, sites, "a write path with no row here (or a row whose call site is gone)");
  // Every site's row exercises a kind its literals name, so a row cannot stand in for a different call.
  for (const c of CASES) {
    const named = c.site.split(":")[1];
    if (named !== "<opts>") assert.ok(named.split("|").includes(c.kind), `${c.name}: ${c.kind} is not one of ${named}`);
  }
  // The dashboard.ts sites are the five writes withAuditedWrites wraps, and nothing else there calls `write({`.
  assert.deepEqual(sitesIn("dashboard.ts").sort(), ["dashboard.ts:cancel-active", "dashboard.ts:cancel-held", "dashboard.ts:fleet-pause", "dashboard.ts:fleet-resume", "dashboard.ts:steer"]);
});
