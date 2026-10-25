import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { makeConsoleAudit, verifyConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import { AUDIT_REFUSAL, auditedWrite, defaultFailure, panelActor, panelWrite, writeTicket } from "../src/audited-write.mjs";
import { stripAnsi } from "../src/style.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// One audit chain for the panel's writes (issue #642): `auditedWrite` appends `ok` BEFORE the write, a compensating
// `failed` after one that did not land, and refuses the write when the first append fails. The TUI, the tools and the
// commands wire it; the second half of this file drives those wirings through the real extension.
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexMod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const { makeDashboard, withAuditedWrites } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));

const ACTOR = { name: "rob", role: "panel", session: null };
/** Every row in `logsDir`'s audit chain, oldest first (the month follows the wall clock here, so every file is read). */
const rowsOf = (logsDir) => {
  const dir = join(logsDir, "console-audit");
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort();
  return names.flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)));
};
/** An audit writer whose append always throws, and counts the attempts. */
const brokenAudit = () => {
  const audit = { tries: 0, append() { audit.tries += 1; throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } };
  return audit;
};
/** A logs directory whose console-audit path is a FILE, so the real writer's append throws. */
function unwritableLogsDir() {
  const logsDir = tempDir("pd-642-noaudit-");
  writeFileSync(join(logsDir, "console-audit"), "not a directory");
  return logsDir;
}

test("a panel write appends ok BEFORE the write runs, with kind, target and a 12-hex ticket", () => {
  const logsDir = tempDir("pd-642-audit-");
  const audit = makeConsoleAudit({ logsDir });
  let seenAtWrite = null;
  const res = auditedWrite({ audit, actor: ACTOR, kind: "trigger-add", target: "/d/triggers.json" }, () => {
    seenAtWrite = rowsOf(logsDir);
    return { ok: true };
  });
  assert.deepEqual(res, { ok: true }, "the write's own result comes back unchanged");
  assert.equal(seenAtWrite.length, 1, "the ok row is on disk before the write runs");
  const [row] = rowsOf(logsDir);
  assert.equal(row.outcome, "ok");
  assert.equal(row.action, "write");
  assert.equal(row.kind, "trigger-add");
  assert.equal(row.target, "/d/triggers.json");
  assert.deepEqual(row.actor, ACTOR);
  assert.match(row.ticket, /^[0-9a-f]{12}$/);
});

test("a refused write appends ok then failed under the same ticket; a throwing one too, and the throw is rethrown", async () => {
  const logsDir = tempDir("pd-642-audit-");
  const audit = makeConsoleAudit({ logsDir });
  const refused = auditedWrite({ audit, actor: ACTOR, kind: "setting-set", target: "/d/settings.json" }, () => ({ invalid: "maxCostUsd must be a decimal" }));
  assert.deepEqual(refused, { invalid: "maxCostUsd must be a decimal" });
  assert.throws(() => auditedWrite({ audit, actor: ACTOR, kind: "limit-add", target: "/d/sl.json" }, () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); }), /EIO/);
  // Async funnels: a promise in, a promise out; a rejection compensates and rejects.
  const later = await auditedWrite({ audit, actor: ACTOR, kind: "cancel-held", target: "j1" }, async () => ({ refused: "no such job" }));
  assert.deepEqual(later, { refused: "no such job" });
  await assert.rejects(auditedWrite({ audit, actor: ACTOR, kind: "envelope-set", target: "/d/env.json" }, async () => { throw new Error("boom"); }), /boom/);
  // A custom judge: an allocation outcome.
  auditedWrite({ audit, actor: ACTOR, kind: "priorities-set", target: "allocation", failure: (r) => (r.outcome === "applied" ? null : `${r.outcome}: ${r.reason}`) }, () => ({ outcome: "refused", reason: "plan-stale" }));
  const rows = rowsOf(logsDir);
  assert.deepEqual(rows.map((r) => [r.kind, r.outcome]), [
    ["setting-set", "ok"], ["setting-set", "failed"],
    ["limit-add", "ok"], ["limit-add", "failed"],
    ["cancel-held", "ok"], ["cancel-held", "failed"],
    ["envelope-set", "ok"], ["envelope-set", "failed"],
    ["priorities-set", "ok"], ["priorities-set", "failed"],
  ]);
  for (let i = 0; i < rows.length; i += 2) assert.equal(rows[i].ticket, rows[i + 1].ticket, `${rows[i].kind}: one ticket ties the pair`);
  assert.notEqual(rows[0].ticket, rows[2].ticket, "and each write has its own");
  assert.equal(rows[1].reason, "maxCostUsd must be a decimal");
  assert.equal(rows[3].reason, "the write threw (EIO)");
  assert.equal(rows[5].reason, "no such job");
  assert.equal(rows[9].reason, "refused: plan-stale");
  assert.equal(verifyConsoleAudit({ logsDir }).ok, true);
});

test("an append failure refuses the write: fn never runs, nothing is written, and the refusal is the caller's shape", () => {
  const audit = brokenAudit();
  let ran = false;
  const res = auditedWrite({ audit, actor: ACTOR, kind: "trigger-add", target: "/d/t.json" }, () => (ran = true));
  assert.equal(ran, false, "the write was never attempted");
  assert.equal(audit.tries, 1, "and no compensating row was tried for a write that never ran");
  assert.deepEqual(res, { ok: false, invalid: AUDIT_REFUSAL, refused: AUDIT_REFUSAL });
  assert.equal(AUDIT_REFUSAL, "the audit log could not be written, so nothing was changed; check PI_LOGS_DIR");
  const shaped = auditedWrite({ audit, actor: ACTOR, kind: "allocation-revert", target: "allocation", refusal: (s) => ({ outcome: "refused", reason: s }) }, () => assert.fail("must not run"));
  assert.deepEqual(shaped, { outcome: "refused", reason: AUDIT_REFUSAL });
  // A failing compensating append is logged and swallowed: the write's own outcome is what the caller sees.
  let n = 0;
  const flaky = { append() { n += 1; if (n === 2) throw new Error("second append"); } };
  const said = [];
  assert.deepEqual(auditedWrite({ audit: flaky, actor: ACTOR, kind: "trigger-edit", target: "x", log: (m) => said.push(m), ticket: "abcdefabcdef" }, () => ({ invalid: "bad" })), { invalid: "bad" });
  assert.match(said[0], /last row for ticket abcdefabcdef says ok and is wrong/);
});

// Issue #737: the console links a write's banner to its rows by wrapping the writer OUTSIDE auditedWrite, which stays as
// it is (audited-write.mjs UNCHANGED, checked). This holds the composition: the first row is the ok row, before the write.
test("a capturing writer around auditedWrite sees the ok row first, before the write, and a compensating row after it", async () => {
  const { capturingAudit } = await import("../src/console/actions.mjs");
  const logsDir = tempDir("pd-737-capture-");
  const real = makeConsoleAudit({ logsDir });
  real.append({ actor: ACTOR, action: "write", kind: "setting-set", target: "/s", outcome: "ok", ticket: "aaaaaaaaaaaa" });
  const audit = capturingAudit(real);
  let firstWhenWritten;
  const res = auditedWrite({ audit, actor: ACTOR, kind: "setting-set", target: "/s" }, () => {
    firstWhenWritten = audit.first();
    return { invalid: "the file changed" };
  });
  assert.equal(res.invalid, "the file changed");
  const rows = rowsOf(logsDir);
  assert.deepEqual(rows.map((r) => [r.seq, r.outcome]), [[1, "ok"], [2, "ok"], [3, "failed"]]);
  assert.equal(firstWhenWritten, 2, "the ok row is appended, and its seq known, before the write runs");
  assert.deepEqual([audit.first(), audit.last()], [2, 3], "the compensating row moves the latest, never the first");
  // A refused first append: no row, so no seq, and the write never runs.
  const none = capturingAudit(brokenAudit());
  let ran = false;
  auditedWrite({ audit: none, actor: ACTOR, kind: "setting-set", target: "/s" }, () => (ran = true));
  assert.deepEqual([ran, none.first(), none.last()], [false, null, null]);
});

test("the chain verifies after a mix of panel rows and CLI rows appended to one directory", () => {
  const logsDir = tempDir("pd-642-mixed-");
  const cli = makeConsoleAudit({ logsDir });
  cli.append({ actor: { name: "shell", role: "shell", session: null }, action: "token-added", target: "alice", outcome: "ok" });
  panelWrite(logsDir, { kind: "pause-window-add", target: "/d/pw.json" }, () => ({ ok: true }));
  cli.append({ actor: { name: "alice", role: "operator", session: "abc" }, action: "login", outcome: "ok" });
  panelWrite(logsDir, { kind: "setting-set", target: "/d/s.json" }, () => ({ invalid: "no" }));
  const rows = rowsOf(logsDir);
  assert.deepEqual(rows.map((r) => r.actor.role), ["shell", "panel", "operator", "panel", "panel"]);
  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4, 5], "one chain, no seq written twice");
  assert.deepEqual(verifyConsoleAudit({ logsDir }), { ok: true, rows: 5, startsAt: null });
});

test("panelActor: the login name in a plain charset, role panel, no session; unknown when there is none", () => {
  assert.deepEqual(panelActor(() => ({ username: "rob" })), { name: "rob", role: "panel", session: null });
  assert.equal(panelActor(() => ({ username: "evil\u001b[2J\u202ename" })).name, "evil__2J_name");
  assert.equal(panelActor(() => ({ username: "x".repeat(100) })).name.length, 64);
  assert.equal(panelActor(() => { throw new Error("no passwd entry"); }).name, "unknown");
  assert.equal(panelActor(() => ({ username: "" })).name, "unknown");
  assert.match(writeTicket(), /^[0-9a-f]{12}$/);
});

// ---- the wirings, through the real extension ----

function registeredTools() {
  const tools = [];
  const pi = new Proxy({}, { get: (_t, k) => (k === "registerTool" ? (t) => tools.push(t) : () => {}) });
  indexMod.default(pi);
  return tools;
}
const toolByName = (name) => registeredTools().find((t) => t.name === name);
const confirming = () => ({ hasUI: true, ui: { confirm: async () => true } });

/** Run `fn` with the deployment's env pointed at a fresh triggers file and `logsDir`, restoring both after. */
async function withDeployment(logsDir, fn) {
  const keys = ["PI_LOGS_DIR", "PI_TRIGGERS_FILE", "PI_SETTINGS_FILE"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const dir = tempDir("pd-642-dep-");
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [] }));
  process.env.PI_LOGS_DIR = logsDir;
  process.env.PI_TRIGGERS_FILE = triggersPath;
  process.env.PI_SETTINGS_FILE = join(dir, "settings.json");
  try {
    return await fn({ triggersPath, settingsFile: process.env.PI_SETTINGS_FILE });
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
}

test("a tool write is audited as the panel in the deployment's PI_LOGS_DIR, and the file changes after the ok row", async () => {
  const logsDir = tempDir("pd-642-tool-");
  await withDeployment(logsDir, async ({ triggersPath }) => {
    await toolByName("dispatch_trigger_add").execute("id", { kind: "label", flow: "fix", labels: ["bug"] }, undefined, undefined, confirming());
    assert.equal(JSON.parse(readFileSync(triggersPath, "utf8")).triggers.length, 1, "the write landed");
    const rows = rowsOf(logsDir);
    assert.deepEqual(rows.map((r) => [r.kind, r.outcome, r.target, r.actor.role]), [["trigger-add", "ok", triggersPath, "panel"]]);
    // A refused one: the loader rejects a gitlab action word on github, after the ok row.
    await assert.rejects(toolByName("dispatch_trigger_add").execute("id", { kind: "pull_request", flow: "fix", action: ["update"] }, undefined, undefined, confirming()), /rejected:/);
    assert.deepEqual(rowsOf(logsDir).slice(1).map((r) => r.outcome), ["ok", "failed"]);
  });
});

test("an append failure refuses a tool write, a command write, the kill switch and an enqueue, and changes nothing", async () => {
  const logsDir = unwritableLogsDir();
  await withDeployment(logsDir, async ({ triggersPath, settingsFile }) => {
    await assert.rejects(
      toolByName("dispatch_trigger_add").execute("id", { kind: "label", flow: "fix", labels: ["bug"] }, undefined, undefined, confirming()),
      { message: `rejected: ${AUDIT_REFUSAL}` },
    );
    assert.deepEqual(JSON.parse(readFileSync(triggersPath, "utf8")).triggers, [], "the triggers file is untouched");
    // The kill switch and the paid enqueue refuse BEFORE reaching Valkey: no queue is needed to prove it.
    await assert.rejects(toolByName("dispatch_pause").execute("id", {}), { message: AUDIT_REFUSAL });
    await assert.rejects(toolByName("dispatch_resume").execute("id", {}), { message: AUDIT_REFUSAL });
    await assert.rejects(toolByName("dispatch_run").execute("id", { folder: "/nowhere", flow: "fix", task: "t" }), { message: AUDIT_REFUSAL });
    // The operator-typed command: /dispatch set says the refusal on its own line, and the settings file is not made.
    let handler = null;
    const pi = new Proxy({}, { get: (_t, k) => (k === "registerCommand" ? (_n, def) => (handler = def.handler) : () => {}) });
    indexMod.default(pi);
    const notes = [];
    await handler("set dailyCap 3", { ui: { notify: (m, t) => notes.push({ m, t }) } });
    assert.ok(notes.some((n) => n.m === `set: ${AUDIT_REFUSAL}` && n.t === "error"), JSON.stringify(notes));
    assert.equal(existsSync(settingsFile), false, "nothing was written");
  });
});

test("the dialog writes and /dispatch secrets are audited too", async () => {
  const logsDir = tempDir("pd-642-dialogs-");
  await withDeployment(logsDir, async ({ triggersPath }) => {
    const ui = { select: async () => "label", input: (() => { const a = ["github", "bug", "fix"]; return async () => a.shift(); })(), confirm: async () => true, notify() {} };
    await indexMod.handleDashboardAction({ action: "addTrigger" }, { triggersPath }, { ui });
    assert.deepEqual(rowsOf(logsDir).map((r) => [r.kind, r.outcome]), [["trigger-add", "ok"]]);
  });
  const { runSecretsCommand } = await jiti.import("../src/secrets-command.ts");
  const files = {};
  const fs = {
    readFileSync: (p) => { if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files[p]; },
    writeFileSync: (p, d) => (files[p] = d),
    renameSync: (a, b) => { files[b] = files[a]; delete files[a]; },
    mkdirSync: () => {},
  };
  const seen = [];
  const audit = { append: (row) => { seen.push({ ...row, wroteYet: "/s/settings.json" in files }); return row; } };
  const ctx = { ui: { input: async (t) => (/profile name/.test(t) ? "prod" : "/opt/pi/resolve.sh"), confirm: async () => true, notify() {} } };
  await runSecretsCommand({ settingsFile: "/s/settings.json" }, ctx, () => {}, ["add"], { fs, audit });
  assert.deepEqual(seen.map((r) => [r.kind, r.outcome, r.target, r.wroteYet]), [["secret-profile-add", "ok", "/s/settings.json", false]]);
  // An audit that cannot append refuses the declaration with nothing written.
  const notes = [];
  const fs2 = { ...fs, writeFileSync: () => assert.fail("must not write"), renameSync: () => assert.fail("must not write") };
  await runSecretsCommand({ settingsFile: "/t/settings.json" }, ctx, (m) => notes.push(m), ["add"], { fs: fs2, audit: brokenAudit() });
  assert.deepEqual(notes, [`rejected: ${AUDIT_REFUSAL}`]);
});

test("the TUI's writes: pause, resume and both cancels go through the injected writer; a refusal is the footer note", async () => {
  const calls = [];
  const write = (opts, fn) => {
    calls.push(opts.kind);
    return opts.kind === "fleet-resume" ? { ok: false, invalid: AUDIT_REFUSAL, refused: AUDIT_REFUSAL } : fn();
  };
  const ran = [];
  const base = {
    fetchSnapshot: async () => ({ queue: { pausedState: false, counts: {}, workers: 0 }, runs: [] }),
    pause: async () => { ran.push("pause"); },
    resume: async () => { ran.push("resume"); },
    cancelActive: async ({ jobId }) => { ran.push(`active:${jobId}`); return { timeout: true }; },
    cancelHeld: async ({ jobId }) => { ran.push(`held:${jobId}`); return { ok: true, jobId }; },
    dispose: async () => {},
    now: () => Date.UTC(2026, 9, 15),
  };
  const deps = withAuditedWrites(base, write);
  await deps.cancelActive({ jobId: "a1" });
  await deps.cancelHeld({ jobId: "h1" });
  assert.deepEqual(calls, ["cancel-active", "cancel-held"]);
  const comp = makeDashboard({ paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000, deps });
  await new Promise((r) => setImmediate(r));
  comp.handleInput("p");
  await new Promise((r) => setTimeout(r, 20));
  comp.handleInput("r");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ran, ["active:a1", "held:h1", "pause"], "the refused resume never reached the reader");
  const out = comp.render(100).map(stripAnsi).join("\n");
  await comp.dispose();
  assert.match(out, /resume refused: the audit log could not be written, so nothing was changed; check PI_LOGS_DIR/);
});

test("the TUI's pause note renders a kill-switch refusal the reader returns, and stays silent on a plain resolve", async () => {
  const base = {
    fetchSnapshot: async () => ({ queue: { pausedState: false, counts: {}, workers: 0 }, runs: [] }),
    pause: async () => ({ refused: "VALKEY_URL and the deployment .env name different Valkeys; resume both from a shell" }),
    resume: async () => undefined,
    dispose: async () => {},
    now: () => Date.UTC(2026, 9, 15),
  };
  const comp = makeDashboard({ paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000, deps: base });
  await new Promise((r) => setImmediate(r));
  comp.handleInput("p");
  await new Promise((r) => setTimeout(r, 20));
  assert.match(comp.render(120).map(stripAnsi).join("\n"), /pause refused: VALKEY_URL and the deployment \.env name different Valkeys/);
  comp.handleInput("r");
  await new Promise((r) => setTimeout(r, 20));
  assert.doesNotMatch(comp.render(120).map(stripAnsi).join("\n"), /refused/);
  await comp.dispose();
});

test("every confirm-gated tool and operator-typed write refuses, unchanged files and all, when the audit cannot be appended", async () => {
  const logsDir = unwritableLogsDir();
  const keys = ["PI_LOGS_DIR", "PI_TRIGGERS_FILE", "PI_SETTINGS_FILE", "PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_PROJECTS_FILE"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const dir = tempDir("pd-642-all-");
  const files = {
    PI_TRIGGERS_FILE: [join(dir, "triggers.json"), { triggers: [{ on: { type: "label", any: ["bug"] }, run: { kind: "github", flow: "fix" } }] }],
    PI_PAUSE_WINDOWS_FILE: [join(dir, "pause-windows.json"), { windows: [{ scope: "acme/web", from: "22:00", to: "06:00" }] }],
    PI_SCOPED_LIMITS_FILE: [join(dir, "scoped-limits.json"), { version: 1, limits: [{ scope: "acme/web", day: 5 }] }],
    PI_PROJECTS_FILE: [join(dir, "projects.json"), { version: 1, projects: [{ id: "web", members: ["github:acme/web"] }] }],
    PI_SETTINGS_FILE: [join(dir, "settings.json"), { model: "m" }],
  };
  process.env.PI_LOGS_DIR = logsDir;
  for (const [k, [p, body]] of Object.entries(files)) {
    writeFileSync(p, JSON.stringify(body));
    process.env[k] = p;
  }
  const snapshot = () => Object.values(files).map(([p]) => readFileSync(p, "utf8"));
  const before = snapshot();
  try {
    const t = Object.fromEntries(registeredTools().map((x) => [x.name, x]));
    const calls = [
      ["dispatch_set", { key: "dailyCap", value: "4" }],
      ["dispatch_set", { key: "model" }],
      ["dispatch_trigger_edit", { index: 0, flow: "review" }],
      ["dispatch_trigger_delete", { index: 0 }],
      ["dispatch_pause_add", { scope: "*", from: "01:00", to: "02:00" }],
      ["dispatch_pause_edit", { index: 0, to: "07:00" }],
      ["dispatch_pause_delete", { index: 0 }],
      ["dispatch_limit_add", { scope: "acme/api", day: 2 }],
      ["dispatch_limit_edit", { index: 0, day: 9 }],
      ["dispatch_limit_delete", { index: 0 }],
      ["dispatch_project_add", { id: "api", members: ["github:acme/api"] }],
      ["dispatch_project_edit", { id: "web", name: "Web" }],
      ["dispatch_project_delete", { id: "web" }],
    ];
    for (const [name, params] of calls) {
      await assert.rejects(t[name].execute("id", params, undefined, undefined, confirming()), (e) => e.message.endsWith(AUDIT_REFUSAL), name);
    }
    let handler = null;
    const pi = new Proxy({}, { get: (_t, k) => (k === "registerCommand" ? (_n, def) => (handler = def.handler) : () => {}) });
    indexMod.default(pi);
    for (const line of ["unset model", "pause", "resume", "run /nowhere fix go"]) {
      const notes = [];
      await handler(line, { ui: { notify: (m) => notes.push(m) } });
      assert.ok(notes.some((m) => String(m).endsWith(AUDIT_REFUSAL)), `${line}: ${JSON.stringify(notes)}`);
    }
    // The panel's dialogs: a pause-window add, a scoped-limit add and a trigger delete.
    const paths = { triggersPath: files.PI_TRIGGERS_FILE[0], pauseWindowsPath: files.PI_PAUSE_WINDOWS_FILE[0], scopedLimitsPath: files.PI_SCOPED_LIMITS_FILE[0], projectsFile: files.PI_PROJECTS_FILE[0], settingsFile: files.PI_SETTINGS_FILE[0] };
    const answers = (sel, inp) => ({ select: async () => sel.shift(), input: async () => inp.shift(), confirm: async () => true, notify: (m) => notes.push(m) });
    const notes = [];
    await indexMod.handleDashboardAction({ action: "managePauses" }, paths, { ui: answers(["Add a pause window"], ["*", "01:00", "02:00", "", "", "", ""]) });
    await indexMod.handleDashboardAction({ action: "manageLimits" }, paths, { ui: answers(["Add a scoped limit"], ["acme/api", "3", "", "", ""]) });
    await indexMod.handleDashboardAction({ action: "deleteTrigger", index: 0, confirmed: true }, paths, { ui: answers([], []) });
    await indexMod.handleDashboardAction({ action: "editSettings" }, paths, { ui: answers(["dailyCap"], ["5"]) });
    assert.equal(notes.filter((m) => String(m).endsWith(AUDIT_REFUSAL)).length, 4, JSON.stringify(notes));
    assert.deepEqual(snapshot(), before, "no file changed");
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

test("the TUI's switch note reads killSwitchSet's results shape: a half switch and an unreachable Valkey fail loudly, a disagreement is said", async () => {
  const shapes = {
    p: { results: [{ shown: "redis://a:6379", res: { unreachable: "x", partial: { done: ["q1"], failed: "q2", error: "e" } } }] },
    r: { results: [{ shown: "redis://b:6379", res: { unreachable: "ECONNREFUSED" } }] },
  };
  let next = "p";
  const base = {
    fetchSnapshot: async () => ({ queue: { pausedState: false, counts: {}, workers: 0 }, runs: [] }),
    pause: async () => (next === "both" ? { disagreement: "VALKEY_URL differs from the deployment .env", results: [{ shown: "a", res: { queues: ["q"] } }, { shown: "b", res: { queues: ["q"] } }] } : shapes.p),
    resume: async () => shapes.r,
    dispose: async () => {},
    now: () => Date.UTC(2026, 9, 15),
  };
  const comp = makeDashboard({ paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000, deps: base });
  await new Promise((r) => setImmediate(r));
  const said = async (key) => {
    comp.handleInput(key);
    await new Promise((r) => setTimeout(r, 20));
    return comp.render(140).map(stripAnsi).join("\n");
  };
  assert.match(await said("p"), /pause failed: FAILED at q2 on redis:\/\/a:6379, so the deployment is half switched/);
  assert.match(await said("r"), /resume failed: could not reach the queue at redis:\/\/b:6379/);
  next = "both";
  assert.match(await said("p"), /VALKEY_URL differs from the deployment \.env: paused both/);
  await comp.dispose();
});

// The scrub's charset, pinned character by character: the plain login-name set (letters, digits, dot, underscore, at,
// dash) is kept as it is, and everything else, a space first, becomes one underscore each.
test("panelActor's scrub keeps exactly [A-Za-z0-9._@-] and turns a space, a slash, a colon and the rest into underscores", () => {
  const nameOf = (username) => panelActor(() => ({ username })).name;
  assert.equal(nameOf("Rob.Boer_man@host-01"), "Rob.Boer_man@host-01", "every character of the charset is kept");
  assert.equal(nameOf("rob boerman"), "rob_boerman", "a space is outside the charset");
  for (const c of [" ", "\t", "/", "\\", ":", ";", ",", "+", "=", "~", "!", "#", "$", "%", "&", "*", "(", ")", "[", "]", "{", "}", "<", ">", "?", "'", "\"", "`", "|", "^", "\u00e9", "\u0000", "\u007f"]) {
    assert.equal(nameOf(`a${c}b`), "a_b", `U+${c.codePointAt(0).toString(16).padStart(4, "0")} is scrubbed`);
  }
  assert.equal(nameOf("   "), "___", "a name of spaces only is scrubbed, not dropped to unknown");
  assert.equal(nameOf("x".repeat(64) + " "), "x".repeat(64), "the cap cuts after the scrub");
});

test("defaultFailure: a bare ok:false is a failure, a carried reason wins over it, and anything else landed", () => {
  assert.equal(defaultFailure({ ok: false }), "the write was refused");
  assert.equal(defaultFailure({ ok: false, invalid: "bad flow" }), "bad flow");
  assert.equal(defaultFailure({ ok: false, refused: "paused" }), "paused");
  assert.equal(defaultFailure({ ok: false, invalid: "" }), "the write was refused", "an empty reason is no reason");
  assert.equal(defaultFailure({ ok: true }), null);
  assert.equal(defaultFailure({}), null);
  assert.equal(defaultFailure(undefined), null);
  assert.equal(defaultFailure(null), null);
  assert.equal(defaultFailure("done"), null);
  // Through auditedWrite with the default judge: an ok:false result earns its compensating row with that reason.
  const logsDir = tempDir("pd-642-okfalse-");
  const res = auditedWrite({ audit: makeConsoleAudit({ logsDir }), actor: ACTOR, kind: "setting-set", target: "/d/s.json" }, () => ({ ok: false }));
  assert.deepEqual(res, { ok: false });
  assert.deepEqual(rowsOf(logsDir).map((r) => [r.outcome, r.reason ?? null]), [["ok", null], ["failed", "the write was refused"]]);
});
