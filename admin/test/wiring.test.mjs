import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Wiring discipline for the admin extension: it registers exactly the dispatch command, reaches ONLY the
 * USED_API members of `pi` (a recording Proxy throws on any other), routes structured views through the
 * `pi-dispatch-admin` channel with `triggerTurn` never set, and -- the load-bearing invariant -- routes
 * raw `.log` output ONLY through the overlay viewer, never through `sendMessage`.
 *
 * Loaded through pi's own jiti, the production extension loader. PI_LOGS_DIR points at an empty temp dir
 * so the fs-backed paths (`runs`, `logs`) resolve offline; the network-backed paths (status/budget/
 * triggers) are covered in read-model.test.mjs, not here.
 */
process.env.PI_LOGS_DIR = mkdtempSync(join(tmpdir(), "admin-wiring-"));
// Hermeticity for the setup detection/nudge paths: pointerPath() and the nudge marker derive from
// PI_CODING_AGENT_DIR, and no test run may ever read (or write!) the real ~/.pi/agent.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "admin-wiring-agent-"));

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
// The wizard module through the SAME loader, for its exported pins (the skew notice compares against
// RUNTIME_VERSION, and a test restating the literal would drift from it).
const wizard = await jiti.import(fileURLToPath(new URL("../src/setup-wizard.ts", import.meta.url)));

/**
 * A recording `pi` whose get-trap throws on any function member NOT in USED_API, so a handler that reached
 * for `appendEntry`, `sendUserMessage`, etc. fails the test loudly. registerCommand/registerTool/sendMessage
 * record.
 */
function recordingPi(used) {
  const usedSet = new Set(used);
  const calls = { registerCommand: [], registerTool: [], sendMessage: [] };
  const pi = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        if (key === "registerCommand") return (name, def) => calls.registerCommand.push([name, def]);
        if (key === "registerTool") return (tool) => calls.registerTool.push(tool);
        if (key === "sendMessage") return (message, options) => calls.sendMessage.push([message, options]);
        if (usedSet.has(key)) return () => {};
        throw new Error(`admin extension reached a non-USED_API pi member: ${key}`);
      },
    },
  );
  return { pi, calls };
}

/** The registered tool whose `name` matches, or undefined. */
function toolByName(calls, name) {
  return calls.registerTool.find((t) => t.name === name);
}

function fakeCtx({ withCustom = true } = {}) {
  const notes = [];
  const customCalls = [];
  const ui = { notify: (message, type) => notes.push([message, type]) };
  if (withCustom) {
    ui.custom = async (factory, options) => {
      customCalls.push([factory, options]);
      return undefined;
    };
  }
  return { ctx: { ui }, notes, customCalls };
}

async function loadRegistered() {
  const mod = await jiti.import(indexPath);
  const { pi, calls } = recordingPi(mod.USED_API);
  mod.default(pi);
  return { mod, calls, def: calls.registerCommand[0][1] };
}

test("registers exactly the dispatch command with a handler and completions", async () => {
  const { calls, def } = await loadRegistered();
  assert.equal(calls.registerCommand.length, 1, "exactly one registration");
  assert.equal(calls.registerCommand[0][0], "dispatch");
  assert.equal(typeof def.handler, "function");
  assert.equal(typeof def.getArgumentCompletions, "function");
});

test("USED_API is exactly the members the extension reaches", async () => {
  const { mod } = await loadRegistered();
  // `on` joins the set: the extension advertises its bundled skill via the `resources_discover` event.
  assert.deepEqual([...mod.USED_API].sort(), ["on", "registerCommand", "registerTool", "sendMessage"]);
});

test("the bare command opens the dashboard overlay and never touches the model channel", async () => {
  const { calls, def } = await loadRegistered();
  const view = fakeCtx({ withCustom: true });
  await def.handler("", view.ctx);
  assert.equal(view.customCalls.length, 1, "bare /dispatch opens the dashboard overlay");
  assert.equal(view.customCalls[0][1]?.overlay, true, "as an overlay");
  assert.equal(calls.sendMessage.length, 0, "the dashboard never sends into model context");
});

test("the bare command without overlay support degrades to a usage note, never the model channel", async () => {
  const { calls, def } = await loadRegistered();
  const noCustom = fakeCtx({ withCustom: false });
  await def.handler("", noCustom.ctx);
  assert.equal(noCustom.customCalls.length, 0);
  assert.equal(noCustom.notes.length, 1, "fails to a note, not a silent no-op");
  assert.match(noCustom.notes[0][0], /usage|dashboard/);
  assert.equal(calls.sendMessage.length, 0);
});

test("an unknown subcommand notifies and never touches the model channel", async () => {
  const { calls, def } = await loadRegistered();
  const unknown = fakeCtx();
  await def.handler("bogus", unknown.ctx);
  assert.match(unknown.notes[0][0], /unknown subcommand/);
  assert.equal(calls.sendMessage.length, 0, "usage paths must not send into model context");
});

test("setup with a ctx lacking dialogs degrades to a notice, never the model channel", async () => {
  const { calls, def } = await loadRegistered();
  const ctx = fakeCtx({ withCustom: true }); // notify + custom, but no input/select/confirm
  await def.handler("setup", ctx.ctx);
  assert.ok(ctx.notes.some(([m]) => /dialogs|newer pi/.test(m)), "the missing-dialog notice is shown");
  assert.equal(ctx.customCalls.length, 0, "no overlay opens for a wizard that cannot ask anything");
  assert.equal(calls.sendMessage.length, 0);
});

/**
 * The bare command on a host with NOTHING configured (issue #92): no pointer (agent dir is a pinned
 * empty tmpdir), none of the path env vars, no cwd scaffold (the test runs from admin/), and a queue
 * probe pinned to a dead port -- port 1 refuses immediately on every host, so the probe can never find
 * a REAL dev Valkey on 6379 and go green under the test's feet.
 *
 * That state now lands the operator IN the wizard, not in front of a confirm asking whether they want
 * one: the wizard's own first select IS the consent, and it offers the panel as a real third answer.
 * The load-bearing part is what a "Cancel" costs -- nothing: no spawn, no write, no overlay. recordingPi
 * still enforces USED_API throughout, so the direct-entry path cannot quietly grow a new pi member.
 */
test("bare /dispatch with nothing configured lands in the wizard select; Cancel spawns nothing", async () => {
  const keys = ["PI_LOGS_DIR", "PI_SETTINGS_FILE", "PI_TRIGGERS_FILE", "PI_PAUSE_WINDOWS_FILE", "PI_SUBSCRIPTIONS_FILE", "VALKEY_URL"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.VALKEY_URL = "redis://127.0.0.1:1";
  const agentDirBefore = readdirSync(process.env.PI_CODING_AGENT_DIR);
  try {
    const { calls, def } = await loadRegistered();
    const view = fakeCtx({ withCustom: true });
    const selects = [];
    const confirms = [];
    const inputs = [];
    view.ctx.ui.select = async (title, options) => {
      selects.push([title, options]);
      return "Cancel";
    };
    view.ctx.ui.confirm = async (title, message) => {
      confirms.push([title, message]);
      return false;
    };
    view.ctx.ui.input = async (title, placeholder) => {
      inputs.push([title, placeholder]);
      return undefined;
    };
    await def.handler("", view.ctx);
    assert.equal(selects.length, 1, "exactly one dialog: the wizard's own intent select");
    assert.match(selects[0][0], /pi-dispatch setup/, "and it is the wizard's, not an offer confirm");
    assert.deepEqual(selects[0][1], ["Guided setup", "Open the panel anyway", "Cancel"], "three answers, the panel among them");
    assert.equal(confirms.length, 0, "no confirm asks permission to ask");
    assert.equal(inputs.length, 0, "Cancel stops before the deployment-dir input");
    assert.equal(view.customCalls.length, 0, "Cancel: no dashboard overlay, no attached spawn");
    assert.equal(calls.sendMessage.length, 0, "the direct-entry path never touches the model channel");
    assert.deepEqual(readdirSync(process.env.PI_CODING_AGENT_DIR), agentDirBefore, "and wrote nothing (no pointer, no marker)");

    // Same state, a pi build with no dialog primitives: the degrade is the WIZARD's own capability gate,
    // said exactly once. The bare branch deliberately adds no second notice -- two notices for one
    // degrade reads like two separate failures.
    const noDialogs = fakeCtx({ withCustom: true }); // notify + custom only
    await def.handler("", noDialogs.ctx);
    assert.equal(noDialogs.notes.length, 1, "exactly one notice, not two");
    assert.match(noDialogs.notes[0][0], /dialogs|newer pi/);
    assert.equal(noDialogs.customCalls.length, 0, "and no overlay for a wizard that cannot ask anything");
    assert.equal(calls.sendMessage.length, 0);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

/**
 * A bare `/dispatch` against a POINTED-AT deployment whose installed runtime is not the version this
 * console pins: worth exactly one line, once per process, naming setup as the fix (its install step is a
 * no-op when the pin already matches, so the advice converges). The pointer file is written into a temp
 * PI_DISPATCH_DEPLOYMENT_FILE rather than the shared agent dir so no later test inherits a pointer.
 *
 * The two silences are the interesting half: a MATCHING version says nothing, and an ABSENT/unreadable
 * one says nothing either -- an operator running the worker from a clone has no installed package to
 * read and must not be nagged for it every session.
 */
test("bare /dispatch on a pointed-at deployment: version skew notifies once, silence otherwise", async () => {
  const { def } = await loadRegistered();
  const pinned = wizard.RUNTIME_VERSION;
  const prev = process.env.PI_DISPATCH_DEPLOYMENT_FILE;
  const home = mkdtempSync(join(tmpdir(), "admin-skew-"));
  const pointerFile = join(home, "pointer.json");
  const deploymentDir = join(home, "deploy");
  const runtimeDir = join(deploymentDir, "node_modules", "@edgehero", "pi-dispatch");
  // An empty pointer `env` on purpose: this test is about the version read, and layering paths into
  // process.env would change what the OTHER tests in this file resolve.
  writeFileSync(pointerFile, JSON.stringify({ version: 1, deploymentDir, env: {} }));
  process.env.PI_DISPATCH_DEPLOYMENT_FILE = pointerFile;
  const skews = (notes) => notes.filter(([m]) => /run \/dispatch setup to upgrade/.test(m));
  try {
    // 1. No installed runtime at all: silence (a clone-run worker is a deliberate choice, not a defect).
    mkdirSync(deploymentDir, { recursive: true });
    const absent = fakeCtx({ withCustom: true });
    await def.handler("", absent.ctx);
    assert.equal(skews(absent.notes).length, 0, "an absent version is silent");

    // 2. The pinned version: nothing to say.
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "package.json"), JSON.stringify({ version: pinned }));
    const same = fakeCtx({ withCustom: true });
    await def.handler("", same.ctx);
    assert.equal(skews(same.notes).length, 0, "a matching version is silent");

    // 3. An older deployment: one warning naming both versions and the fix.
    writeFileSync(join(runtimeDir, "package.json"), JSON.stringify({ version: "0.0.1" }));
    const older = fakeCtx({ withCustom: true });
    await def.handler("", older.ctx);
    const [[message, type]] = skews(older.notes);
    assert.equal(skews(older.notes).length, 1, "exactly one line");
    assert.match(message, /deployment runtime 0\.0\.1/, "names the deployment's version");
    assert.match(message, new RegExp(`this console pins ${pinned.replace(/\./g, "\\.")}`), "and the pinned one");
    assert.equal(type, "warning");

    // 4. Once per PROCESS: the latch keeps the second /dispatch quiet (the advisory latch's twin).
    const second = fakeCtx({ withCustom: true });
    await def.handler("", second.ctx);
    assert.equal(skews(second.notes).length, 0, "the latch holds for the rest of the process");
  } finally {
    if (prev === undefined) delete process.env.PI_DISPATCH_DEPLOYMENT_FILE;
    else process.env.PI_DISPATCH_DEPLOYMENT_FILE = prev;
  }
});

/**
 * The model-facing control surface (DES-ADMIN-VIA-PI-EXTENSION, amended): reads
 * (`dispatch_status`/`_runs`/`_costs`/`_triggers`), the on/off controls (`_pause`/`_resume`), the gated PAID enqueue
 * (`_run`), and the confirm-gated writes (`_set`, `_trigger_add`/`_edit`/`_delete`). Two invariants are locked
 * here: there is still NO raw-log tool (no name contains "log"), and every WRITE tool is `sequential` so two
 * writes cannot interleave. This test is the deliberate record that model-callable writes were added on
 * purpose -- gated by an operator confirm (behaviour proven in crud.test.mjs), not tool absence.
 */
const WRITE_TOOLS = ["dispatch_set", "dispatch_trigger_add", "dispatch_trigger_edit", "dispatch_trigger_delete", "dispatch_pause_add", "dispatch_pause_edit", "dispatch_pause_delete"];
test("registers exactly the read/control/enqueue/write tools, and never a raw-log tool", async () => {
  const { calls } = await loadRegistered();
  const names = calls.registerTool.map((t) => t.name).sort();
  assert.equal(calls.registerTool.length, 15, "exactly fifteen tools");
  assert.deepEqual(names, [
    "dispatch_costs",
    "dispatch_pause",
    "dispatch_pause_add",
    "dispatch_pause_delete",
    "dispatch_pause_edit",
    "dispatch_pauses",
    "dispatch_resume",
    "dispatch_run",
    "dispatch_runs",
    "dispatch_set",
    "dispatch_status",
    "dispatch_trigger_add",
    "dispatch_trigger_delete",
    "dispatch_trigger_edit",
    "dispatch_triggers",
  ]);
  for (const name of names) {
    assert.ok(!/log/.test(name), `no raw-log tool: ${name}`);
  }
  for (const name of WRITE_TOOLS) {
    assert.equal(toolByName(calls, name).executionMode, "sequential", `${name} is sequential`);
  }
  for (const tool of calls.registerTool) {
    assert.equal(typeof tool.execute, "function", `${tool.name}.execute is a function`);
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.parameters && tool.parameters.type === "object", `${tool.name} has an object param schema`);
  }
});

/**
 * `dispatch_run` is the one PAID, model-callable enqueue. Its description must flag the paid, gated,
 * no-undo nature (an operator or a model reading it should see the risk), and it is sequential so two
 * enqueues cannot interleave. Its params are the three job inputs ONLY -- no spend knob.
 */
test("dispatch_run advertises PAID/ai-trigger/no-force, is sequential, and takes no spend knob", async () => {
  const { calls } = await loadRegistered();
  const run = toolByName(calls, "dispatch_run");
  assert.match(run.description, /PAID/, "flags that the run is paid");
  assert.match(run.description, /ai-trigger/, "names the committed opt-in gate");
  assert.match(run.description, /no force/, "states there is no force option for a dirty tree");
  assert.match(run.description, /run\.command/, "says commands (issue #189) are never AI-triggerable via this tool");
  assert.equal(run.executionMode, "sequential");
  const props = run.parameters.properties ?? {};
  // Exactly {folder, flow, task}: the command exclusion (issue #189) is STRUCTURAL here -- there is no
  // `command` param to misuse, and the slash-leading-flow refusal in enqueueDispatchRun is only the
  // backstop for a command smuggled into the flow field.
  assert.deepEqual(Object.keys(props).sort(), ["flow", "folder", "task"], "exactly the three job inputs");
  assert.ok(!("command" in props), "no command param: commands stay structurally out of dispatch_run's reach");
  for (const knob of ["model", "maxTurns", "dailyCap", "weeklyCap", "monthlyCap", "concurrency", "softHoldPct"]) {
    assert.ok(!(knob in props), `no spend-knob param: ${knob}`);
  }
});

test("pause/resume are sequential; the reads leave executionMode default", async () => {
  const { calls } = await loadRegistered();
  assert.equal(toolByName(calls, "dispatch_pause").executionMode, "sequential");
  assert.equal(toolByName(calls, "dispatch_resume").executionMode, "sequential");
  assert.equal(toolByName(calls, "dispatch_status").executionMode, undefined);
  assert.equal(toolByName(calls, "dispatch_runs").executionMode, undefined);
});

test("dispatch_runs advertises that raw logs are off-limits, and its params are optional", async () => {
  const { calls } = await loadRegistered();
  const runs = toolByName(calls, "dispatch_runs");
  assert.match(runs.description, /not available to tools/);
  const props = runs.parameters.properties ?? {};
  assert.ok(props.limit && props.jobId, "limit and jobId are declared");
  const required = runs.parameters.required ?? [];
  assert.ok(!required.includes("limit") && !required.includes("jobId"), "both are optional");
});

/**
 * dispatch_runs.execute reads the durable history off disk (self-closing one-shot, offline-testable via a
 * temp logsDir). The load-bearing assertion: even with a `.log` sitting beside the `.json`, the returned
 * text carries only the PII-free record and never a byte of the raw log.
 */
test("dispatch_runs.execute returns run records as JSON and never any .log content", async () => {
  const prevLogsDir = process.env.PI_LOGS_DIR;
  const dir = mkdtempSync(join(tmpdir(), "admin-runtool-"));
  const record = {
    jobId: "j-log",
    target: "o/r#1",
    flow: "fix",
    outcome: "completed",
    reason: null,
    turns: 3,
    endedAt: "2026-07-21T00:00:00.000Z",
  };
  writeFileSync(join(dir, "j-log.json"), JSON.stringify(record));
  writeFileSync(join(dir, "j-log.log"), "SECRET_LOG_MARKER raw container bytes");
  process.env.PI_LOGS_DIR = dir;

  try {
    const { calls } = await loadRegistered();
    const runs = toolByName(calls, "dispatch_runs");

    const list = await runs.execute("call-1", {});
    const listText = list.content[0].text;
    const parsed = JSON.parse(listText);
    assert.ok(Array.isArray(parsed) && parsed.some((r) => r.jobId === "j-log"), "returns the record");
    assert.ok(!listText.includes("SECRET_LOG_MARKER"), "list path never carries raw .log bytes");

    const one = await runs.execute("call-2", { jobId: "j-log" });
    const oneText = one.content[0].text;
    assert.equal(JSON.parse(oneText).jobId, "j-log", "jobId path returns the single record");
    assert.ok(!oneText.includes("SECRET_LOG_MARKER"), "jobId path never carries raw .log bytes");
  } finally {
    process.env.PI_LOGS_DIR = prevLogsDir;
  }
});

/**
 * pause/resume.execute route into setQueuePaused, whose pause/resume/unreachable outcomes are covered live
 * in read-model.test.mjs against a fake queue. They are not injectable at the tool boundary (execute reads
 * process.env and constructs its own connection), so here we assert only the registration shape and defer
 * the live behaviour to the read-model tests -- exercising them here would depend on a running Valkey.
 */
test("pause/resume tools expose an execute function (behaviour lives in read-model tests)", async () => {
  const { calls } = await loadRegistered();
  assert.equal(typeof toolByName(calls, "dispatch_pause").execute, "function");
  assert.equal(typeof toolByName(calls, "dispatch_resume").execute, "function");
});

test("runs renders into the pi-dispatch-admin channel with triggerTurn unset", async () => {
  const { calls, def } = await loadRegistered();
  await def.handler("runs", fakeCtx().ctx);
  assert.equal(calls.sendMessage.length, 1);
  const [message, options] = calls.sendMessage[0];
  assert.equal(message.customType, "pi-dispatch-admin");
  assert.equal(message.display, true);
  assert.equal(typeof message.content, "string");
  assert.ok(!options || !options.triggerTurn, "must never trigger a paid turn to observe state");
});

test("insights whatif routes its reply into the pi-dispatch-admin channel with triggerTurn unset", async () => {
  // The unknown-model path is offline-deterministic: the REAL pricing façade answers null for a
  // model no catalog carries, and the reply (the long-tail picker) goes through send() like every
  // other read. Only the first line is pinned -- the closest-ids shortlist depends on the live
  // catalog and pinning it would couple this suite to pi-ai's model list.
  const { calls, def } = await loadRegistered();
  await def.handler("insights whatif nosuch/model-x --flow tidy", fakeCtx().ctx);
  assert.equal(calls.sendMessage.length, 1);
  const [message, options] = calls.sendMessage[0];
  assert.equal(message.customType, "pi-dispatch-admin");
  assert.equal(message.display, true);
  assert.match(message.content, /^unknown model: nosuch\/model-x/, "the estimator's reply is the message");
  assert.ok(!options || !options.triggerTurn, "must never trigger a paid turn to observe state");
});

test("bare insights writes the artifact through the real deps, and the headless skip is said", async () => {
  // The end-to-end coverage the removed graph-channel test carried, retargeted at the umbrella:
  // real fs into a temp PI_GRAPH_DIR, an UNPARSEABLE VALKEY_URL (degrades the scheduler read
  // synchronously; a dead PORT would leak a stray async error event into the runner, which is why
  // this suite never opens real connections), a triggers file whose folder does not exist (the
  // enumeration degrades, the page still renders), and SSH_CONNECTION set so the browser spawn is
  // skipped AND SAID on any box this suite runs on.
  const dir = mkdtempSync(join(tmpdir(), "admin-insights-wiring-"));
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: join(dir, "absent"), flow: "tidy", task: "t" } }] }));
  const graphDir = join(dir, "artifacts");
  const prev = { triggers: process.env.PI_TRIGGERS_FILE, valkey: process.env.VALKEY_URL, graph: process.env.PI_GRAPH_DIR, ssh: process.env.SSH_CONNECTION };
  process.env.PI_TRIGGERS_FILE = triggersPath;
  process.env.VALKEY_URL = "not-a-url";
  process.env.PI_GRAPH_DIR = graphDir;
  process.env.SSH_CONNECTION = "10.0.0.1 22";
  try {
    const { calls, def } = await loadRegistered();
    const view = fakeCtx({ withCustom: true });
    await def.handler("insights", view.ctx);
    assert.equal(calls.sendMessage.length, 0, "the artifact path sends nothing into model context");
    assert.ok(existsSync(join(graphDir, "insights.html")), "the artifact landed at the stable path");
    const writtenAt = view.notes.findIndex((n) => /insights written: file:\/\//.test(n[0]));
    const skippedAt = view.notes.findIndex((n) => /SSH session/.test(n[0]));
    assert.ok(writtenAt >= 0, "the file:// URL is notified");
    assert.ok(skippedAt > writtenAt, "the spawn skip is said, after the URL -- never silently");
  } finally {
    if (prev.triggers === undefined) delete process.env.PI_TRIGGERS_FILE;
    else process.env.PI_TRIGGERS_FILE = prev.triggers;
    if (prev.valkey === undefined) delete process.env.VALKEY_URL;
    else process.env.VALKEY_URL = prev.valkey;
    if (prev.graph === undefined) delete process.env.PI_GRAPH_DIR;
    else process.env.PI_GRAPH_DIR = prev.graph;
    if (prev.ssh === undefined) delete process.env.SSH_CONNECTION;
    else process.env.SSH_CONNECTION = prev.ssh;
  }
});

test("USAGE and KNOWN_SUBCOMMANDS agree, member for member, in order", () => {
  // Two copies of one list (the string is what an operator reads, the array is what completion
  // offers), and until now nothing pinned them together -- the exact drift class this suite exists
  // for. Source-read because neither is exported, deliberately.
  const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
  const usage = /usage: \/dispatch <([^>]+)>/.exec(src);
  assert.ok(usage, "the USAGE string must keep its <a|b|c> shape");
  const fromUsage = usage[1].split("|");
  const arr = /const KNOWN_SUBCOMMANDS = \[([^\]]+)\]/s.exec(src);
  assert.ok(arr, "KNOWN_SUBCOMMANDS must stay a literal array");
  const fromArray = [...arr[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fromUsage, fromArray, "a subcommand added to one list must be added to the other, in the same position");
});

/**
 * dispatch_costs.execute folds the on-disk history against the declared subscriptions with the REAL
 * pricing façade and returns TYPED dollars: every money value carries its `class`, so a model reading the
 * JSON cannot launder an estimate into a fact by dropping the label. Driven fully offline: a temp logs dir
 * holding one canned ledgered record, and a canned subscriptions file via PI_SUBSCRIPTIONS_FILE.
 */
test("dispatch_costs.execute returns the typed fold as JSON, class on every dollar, flow-filterable", async () => {
  const prevLogsDir = process.env.PI_LOGS_DIR;
  const prevSubs = process.env.PI_SUBSCRIPTIONS_FILE;
  const dir = mkdtempSync(join(tmpdir(), "admin-coststool-"));
  // One metered, ledgered run an hour ago -- inside any window, and no UTC-month-boundary hazard because
  // the test asks for the 7d window.
  const endedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeFileSync(
    join(dir, "cost-1.json"),
    JSON.stringify({
      jobId: "cost-1",
      target: "local:repo",
      flow: "fix",
      outcome: "completed",
      endedAt,
      provider: "anthropic",
      model: "claude-sonnet-4",
      tokens: { input: 1000, output: 500, total: 1500, cost: 0.5, metered: true, calls: 2, unpriced: 0, unresolved: 0 },
      usage: {
        v: 1,
        piAi: "1.2.3",
        truncated: 0,
        models: [{ provider: "anthropic", model: "claude-sonnet-4", calls: 2, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, total: 1500, cost: 0.5 }],
      },
    }),
  );
  const subsFile = join(dir, "subscriptions.json");
  writeFileSync(
    subsFile,
    JSON.stringify({
      version: 1,
      subscriptions: [{ id: "kimi", vendor: "Moonshot AI", provider: "kimi-coding", models: ["*"], price: { amount: 90, currency: "USD", per: "month" } }],
    }),
  );
  process.env.PI_LOGS_DIR = dir;
  process.env.PI_SUBSCRIPTIONS_FILE = subsFile;

  try {
    const { calls } = await loadRegistered();
    const costs = toolByName(calls, "dispatch_costs");
    assert.equal(costs.executionMode, undefined, "a read tool, never sequential");

    const res = await costs.execute("call-1", { window: "7d" });
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.window, "7d");
    assert.equal(parsed.fold.provenance.runsTotal, 1);
    assert.equal(parsed.fold.provenance.total.class, "metered", "the window total carries its class");
    assert.equal(parsed.fold.provenance.total.usd, 0.5);
    assert.equal(parsed.fold.byFlow[0].cost.class, "metered", "per-flow money is typed too");
    assert.equal(parsed.fold.byModel[0].cost.class, "metered", "per-model money is typed too");
    assert.equal(parsed.fold.plans[0].id, "kimi", "the declared subscription was read and scored");

    const filtered = await costs.execute("call-2", { window: "7d", flow: "other" });
    assert.equal(JSON.parse(filtered.content[0].text).fold.provenance.runsTotal, 0, "flow filters the fold's input records");
  } finally {
    process.env.PI_LOGS_DIR = prevLogsDir;
    if (prevSubs === undefined) delete process.env.PI_SUBSCRIPTIONS_FILE;
    else process.env.PI_SUBSCRIPTIONS_FILE = prevSubs;
  }
});

test("logs renders in the overlay viewer and NEVER via sendMessage", async () => {
  const { calls, def } = await loadRegistered();
  const view = fakeCtx({ withCustom: true });
  await def.handler("logs some-job", view.ctx);
  assert.equal(view.customCalls.length, 1, "opened the overlay viewer");
  assert.equal(view.customCalls[0][1]?.overlay, true, "as an overlay");
  assert.equal(calls.sendMessage.length, 0, "raw logs must never enter model context");
});

test("logs with no overlay support fails loud and still never calls sendMessage", async () => {
  const { calls, def } = await loadRegistered();
  const noCustom = fakeCtx({ withCustom: false });
  await def.handler("logs some-job", noCustom.ctx);
  assert.equal(noCustom.customCalls.length, 0);
  assert.equal(calls.sendMessage.length, 0, "must not fall back to the model channel");
  assert.equal(noCustom.notes.length, 1, "must fail loud, not silently no-op");
  assert.equal(noCustom.notes[0][1], "error");
  assert.match(noCustom.notes[0][0], /never sent to the model|unavailable/);
});

test("logs without a jobId notifies usage without opening a viewer", async () => {
  const { calls, def } = await loadRegistered();
  const view = fakeCtx({ withCustom: true });
  await def.handler("logs", view.ctx);
  assert.equal(view.customCalls.length, 0);
  assert.equal(calls.sendMessage.length, 0);
  assert.match(view.notes[0][0], /usage/);
});

test("argument completion offers subcommands then run ids", async () => {
  const { def } = await loadRegistered();
  const subs = await def.getArgumentCompletions("s");
  assert.ok(Array.isArray(subs) && subs.some((i) => i.value === "status" || i.value === "settings"));
  assert.ok(subs.some((i) => i.value === "setup"), "setup completes as a first token");
  assert.deepEqual(await def.getArgumentCompletions("setu"), [{ value: "setup", label: "setup" }]);
  assert.deepEqual(await def.getArgumentCompletions("insi"), [{ value: "insights", label: "insights" }], "insights completes as a first token (issue #181)");
  // Empty logs dir -> no ids to complete -> null (not []).
  assert.equal(await def.getArgumentCompletions("logs "), null);
  // No subcommand matches -> null.
  assert.equal(await def.getArgumentCompletions("zzz"), null);
});

test("argument completion offers the insights windows, whatif, then the priced catalog", async () => {
  const { def } = await loadRegistered();
  const all = await def.getArgumentCompletions("insights ");
  assert.deepEqual(all.map((i) => i.value), ["insights 7d", "insights 30d", "insights mtd", "insights whatif"]);
  const m = await def.getArgumentCompletions("insights m");
  assert.deepEqual(m, [{ value: "insights mtd", label: "mtd" }]);
  assert.equal(await def.getArgumentCompletions("insights zzz"), null);
  // The third level is the priced catalog -- the long-tail model picker now that no interactive
  // filter exists. The catalog is pi-ai's, so pin only the shape of one known-stable prefix hit.
  const targets = await def.getArgumentCompletions("insights whatif anthropic/");
  assert.ok(Array.isArray(targets) && targets.length > 0, "the catalog completes provider/id targets");
  assert.ok(targets.every((i) => /^insights whatif anthropic\//.test(i.value)), "prefix-filtered on the typed provider");
});

test("junk insights arguments answer usage with zero side effects; the removed verbs stay removed", async () => {
  // The new-grammar teaching path: a bad window, a bare whatif, a whatif with no --flow, and the
  // removed `html` verb all answer INSIGHTS_USAGE and neither write nor send. And the removed
  // subcommands are unknown at the router, not silent aliases.
  const { calls, def } = await loadRegistered();
  for (const line of ["insights 12d", "insights whatif", "insights whatif foo/bar", "insights html"]) {
    const view = fakeCtx({ withCustom: true });
    await def.handler(line, view.ctx);
    assert.match(view.notes[0][0], /usage: \/dispatch insights/, `${line} answers the insights usage`);
    assert.equal(calls.sendMessage.length, 0, `${line} sends nothing`);
  }
  for (const line of ["costs", "graph"]) {
    const view = fakeCtx({ withCustom: true });
    await def.handler(line, view.ctx);
    assert.match(view.notes[0][0], /unknown subcommand/, `${line} is gone from the router`);
  }
});

test("argument completion offers the known settings keys for `set`/`unset`", async () => {
  const { def } = await loadRegistered();
  // "da" prefixes both dailyCap and dailyTokenCap, in KNOWN_KEYS order.
  const set = await def.getArgumentCompletions("set da");
  assert.deepEqual(set, [
    { value: "set dailyCap", label: "dailyCap" },
    { value: "set dailyTokenCap", label: "dailyTokenCap" },
  ]);
  const unset = await def.getArgumentCompletions("unset con");
  assert.deepEqual(unset, [{ value: "unset concurrency", label: "concurrency" }]);
  // No key matches -> null.
  assert.equal(await def.getArgumentCompletions("set zzz"), null);
});

/**
 * `set`/`unset` write the overlay through the read-model against a real temp file (writeOverlay is battle-
 * tested; a real fs keeps these honest). pause/resume at the handler level are NOT retested here: they route
 * straight into `setQueuePaused`, whose pause/resume/unreachable outcomes are covered in read-model.test.mjs,
 * and exercising them here would depend on a live Valkey.
 */
function withSettingsFile() {
  const file = join(mkdtempSync(join(tmpdir(), "admin-settings-")), "settings.json");
  process.env.PI_SETTINGS_FILE = file;
  return file;
}

test("set with an unknown key (wrong case) errors and never writes the file", async () => {
  const { calls, def } = await loadRegistered();
  const file = withSettingsFile();
  const ctx = fakeCtx();
  await def.handler("set dailycap 5", ctx.ctx);
  assert.equal(ctx.notes[0][1], "error");
  assert.match(ctx.notes[0][0], /unknown key/);
  assert.equal(existsSync(file), false, "an unknown-key set touches no file");
  assert.equal(calls.sendMessage.length, 0, "write acks go to notify, never the model channel");
});

test("set concurrency 11 is rejected by the validator and writes nothing", async () => {
  const { def } = await loadRegistered();
  const file = withSettingsFile();
  const ctx = fakeCtx();
  await def.handler("set concurrency 11", ctx.ctx);
  assert.equal(ctx.notes[0][1], "error");
  assert.match(ctx.notes[0][0], /concurrency/);
  assert.equal(existsSync(file), false);
});

test("set dailyCap abc is rejected (NaN coercion) and writes nothing", async () => {
  const { def } = await loadRegistered();
  const file = withSettingsFile();
  const ctx = fakeCtx();
  await def.handler("set dailyCap abc", ctx.ctx);
  assert.equal(ctx.notes[0][1], "error");
  assert.match(ctx.notes[0][0], /dailyCap/);
  assert.equal(existsSync(file), false);
});

test("set dailyCap 5 coerces the numeric string, persists it, and acks via notify", async () => {
  const { calls, def } = await loadRegistered();
  const file = withSettingsFile();
  const ctx = fakeCtx();
  await def.handler("set dailyCap 5", ctx.ctx);
  assert.equal(ctx.notes[0][1], "info");
  assert.match(ctx.notes[0][0], /set dailyCap = 5/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { dailyCap: 5 }, "coerced to a JSON number");
  assert.equal(calls.sendMessage.length, 0);
});

test("unset removes a key, leaving a valid empty overlay", async () => {
  const { def } = await loadRegistered();
  const file = withSettingsFile();
  await def.handler("set model claude-x", fakeCtx().ctx);
  const ctx = fakeCtx();
  await def.handler("unset model", ctx.ctx);
  assert.equal(ctx.notes[0][1], "info");
  assert.match(ctx.notes[0][0], /unset model/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {}, "empty overlay is a valid written state");
});

/**
 * The runtime version advisory (issue #96): a pi that differs from the tested pin loads normally
 * and says so ONCE, at "info" -- a heads-up, not a warning, and never a refusal. The comparison is
 * the exported pure computePiVersionAdvisory (unit-testable without faking a pi install); the drain
 * lives in dispatch() before the sub switch, so any subcommand passes it. Under the pinned devDep
 * pi VERSION === SUPPORTED_PI_VERSION and the natural advisory is unset, so the drain is armed via
 * the obviously-test-only setter (deployment-pointer's resetForTests precedent).
 */
test("the version advisory: pure comparison, and the drain fires once per process at info", async () => {
  const { mod, def } = await loadRegistered();

  assert.equal(mod.computePiVersionAdvisory("0.80.7", "0.80.7"), undefined, "equal versions: nothing to say");
  assert.equal(
    mod.computePiVersionAdvisory("0.0.0", "0.80.7"),
    undefined,
    "pi's own unreadable-package fallback means UNKNOWN, not different -- no bogus mismatch",
  );
  const msg = mod.computePiVersionAdvisory("0.99.0", "0.80.7");
  assert.match(msg, /running on pi 0\.99\.0/, "names the runtime version");
  assert.match(msg, /tested with pi 0\.80\.7/, "names the tested version");
  assert.match(msg, /things should work/, "reassures rather than scares");
  assert.match(msg, /@edgehero\/pi-dispatch-admin/, "points at the upgrade that resolves it");

  mod._setPiVersionAdvisoryForTests("canned version advisory");
  const first = fakeCtx();
  await def.handler("runs", first.ctx);
  const drained = first.notes.filter(([m]) => m === "canned version advisory");
  assert.equal(drained.length, 1, "surfaced exactly once");
  assert.equal(drained[0][1], "info", "an advisory, not a warning");
  const second = fakeCtx();
  await def.handler("runs", second.ctx);
  assert.equal(
    second.notes.filter(([m]) => m === "canned version advisory").length,
    0,
    "once per process: the second /dispatch stays quiet",
  );
});

/**
 * The CI canary (.github/scripts/admin-pi-canary.mjs) keeps its OWN copies of the pinned-api needle
 * list and the USED_API member list -- pinned-extension-api.test.mjs asserts the PIN and cannot be
 * imported by a CI script without becoming one. This test is the anti-drift bolt both directions:
 * the canary's members must deepEqual the real USED_API export, and its needles must deepEqual the
 * literals in pinned-extension-api.test.mjs (parsed from the test's own source -- reading it is
 * fine, editing it is not) AND still appear in the pinned types.d.ts. A stale canary list fails the
 * suite here instead of silently probing the wrong surface in CI.
 */
test("the canary's needle/member lists cannot drift from the pinned test or USED_API", async () => {
  const { mod } = await loadRegistered();
  const canary = await import(new URL("../../.github/scripts/admin-pi-canary.mjs", import.meta.url));

  assert.deepEqual(
    [...canary.USED_API_MEMBERS].sort(),
    [...mod.USED_API].sort(),
    "the canary's USED_API_MEMBERS drifted from the real USED_API export",
  );

  const pinnedTestSrc = readFileSync(fileURLToPath(new URL("./pinned-extension-api.test.mjs", import.meta.url)), "utf8");
  const needleBlock = pinnedTestSrc.match(/const needles = \[([\s\S]*?)\];/);
  assert.ok(needleBlock, "could not find the needles literal in pinned-extension-api.test.mjs");
  const pinnedNeedles = [...needleBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(pinnedNeedles.length > 0, "expected at least one pinned needle");
  assert.deepEqual(
    [...canary.NEEDLES].sort(),
    [...pinnedNeedles].sort(),
    "the canary's NEEDLES drifted from pinned-extension-api.test.mjs's list",
  );

  const typesSrc = readFileSync(
    fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts", import.meta.url)),
    "utf8",
  );
  for (const needle of canary.NEEDLES) {
    assert.ok(typesSrc.includes(needle), `canary needle "${needle}" is not in the PINNED types.d.ts`);
  }
});

test("no write tool exposes a `replicas` parameter -- a spend multiplier stays a reviewed file edit", async () => {
  // docs/replicas.md and INT-TRIGGERS-FILE-CONTRACT both assert this and nothing tested it. It mattered
  // less while replicas were github-only and the loader refused three of the four forges outright; since
  // #187 the field is legal on every webhook trigger the model can author, so the ONLY thing keeping a
  // spend multiplier off the model-callable surface is the absence of the parameter. Structural, like
  // dispatch_run's missing `command` param above.
  const { calls } = await loadRegistered();
  for (const name of ["dispatch_trigger_add", "dispatch_trigger_edit"]) {
    const tool = toolByName(calls, name);
    const keys = Object.keys(tool.parameters.properties ?? {});
    assert.equal(keys.includes("replicas"), false, `${name} must expose no replicas parameter (got ${keys.join(", ")})`);
    assert.equal(keys.includes("replica"), false, `${name} must expose no replica parameter either`);
  }
});

test("dispatch_trigger_add can actually SEND every field buildTriggerEntry reads", async () => {
  // `repository` was read by buildTriggerEntry and stripped by the schema, so an azure label/comment
  // trigger was unauthorable by the model: refused at the write for want of a field it had no way to send.
  // Found while widening the tool's forge description for #187.
  const { calls } = await loadRegistered();
  const keys = Object.keys(toolByName(calls, "dispatch_trigger_add").parameters.properties ?? {});
  assert.ok(keys.includes("repository"), "an azure label/comment trigger needs run.repository");
  assert.ok(keys.includes("forge"), "and the forge that makes it required");
});
