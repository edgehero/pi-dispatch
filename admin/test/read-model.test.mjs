import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayKey, weekKey, monthKey } from "@edgehero/pi-dispatch/budget";
import {
  resolvePaths,
  readQueueState,
  readSchedulers,
  readBudget,
  listRuns,
  scanRunRecords,
  readRun,
  readLogTail,
  readSettingsView,
  readTriggers,
  normalizeTriggerForDisplay,
  readStagedPackages,
  listRunIds,
  setQueuePaused,
  writeSettings,
  writeTriggers,
  readPauseWindows,
  writePauseWindows,
  readSubscriptions,
  writeSubscriptions,
  enqueueDispatchRun,
  revParseHead,
} from "../src/read-model.mjs";

// In-memory fs for the triggers write tests: readFileSync/writeFileSync/renameSync over a plain object.
function triggerFs(initial = {}) {
  const files = { ...initial };
  return {
    files,
    readFileSync(p) {
      if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[p];
    },
    writeFileSync(p, data) {
      files[p] = String(data);
    },
    renameSync(a, b) {
      files[b] = files[a];
      delete files[a];
    },
  };
}

const T_PATH = "/triggers.json";
const labelTrigger = { on: { type: "label", any: ["x"] }, run: { kind: "github", flow: "fix" } };

test("writeTriggers adds a validated entry and writes atomically (tmp renamed away)", () => {
  const fs = triggerFs({ [T_PATH]: JSON.stringify({ triggers: [labelTrigger] }) });
  const res = writeTriggers({
    triggersPath: T_PATH,
    fs,
    mutate: (list) => [...list, { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "review" } }],
  });
  assert.deepEqual(res, { ok: true });
  const written = JSON.parse(fs.files[T_PATH]);
  assert.equal(written.triggers.length, 2);
  assert.equal(written.triggers[1].on.type, "comment");
  assert.equal(`${T_PATH}.tmp` in fs.files, false, "the tmp file is renamed away — the write is atomic");
});

test("writeTriggers rejects an off-diagonal result (cron -> github) and leaves the file unchanged", () => {
  const orig = JSON.stringify({ triggers: [labelTrigger] });
  const fs = triggerFs({ [T_PATH]: orig });
  const res = writeTriggers({
    triggersPath: T_PATH,
    fs,
    mutate: (list) => [...list, { on: { type: "cron", id: "c", pattern: "0 3 * * *" }, run: { kind: "github", flow: "x" } }],
  });
  assert.ok(res.invalid, "the shared parseTriggers rejects the diagonal violation");
  assert.equal(fs.files[T_PATH], orig, "an invalid write never touches the file (fail-closed)");
});

test("writeTriggers edits a flow and deletes an entry", () => {
  const fs = triggerFs({ [T_PATH]: JSON.stringify({ triggers: [labelTrigger, { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "review" } }] }) });
  writeTriggers({ triggersPath: T_PATH, fs, mutate: (l) => l.map((t, i) => (i === 0 ? { ...t, run: { ...t.run, flow: "frontend-fix" } } : t)) });
  assert.equal(JSON.parse(fs.files[T_PATH]).triggers[0].run.flow, "frontend-fix");
  writeTriggers({ triggersPath: T_PATH, fs, mutate: (l) => l.filter((_, i) => i !== 1) });
  assert.equal(JSON.parse(fs.files[T_PATH]).triggers.length, 1);
});

test("writeTriggers on a missing file starts from empty and writes a valid file", () => {
  const fs = triggerFs({});
  const res = writeTriggers({ triggersPath: T_PATH, fs, mutate: (l) => [...l, labelTrigger] });
  assert.deepEqual(res, { ok: true });
  assert.equal(JSON.parse(fs.files[T_PATH]).triggers.length, 1);
});

/**
 * An in-memory fs keyed by basename. A file value that is `{ __throw, code }` throws on read (to model a
 * mid-read ENOENT); `readdirError` makes the directory scan itself throw.
 */
function fakeFs(files, { readdirError } = {}) {
  return {
    readdirSync() {
      if (readdirError) {
        const e = new Error(readdirError.message ?? "readdir failed");
        e.code = readdirError.code;
        throw e;
      }
      return Object.keys(files);
    },
    readFileSync(path) {
      const name = String(path).split(/[\\/]/).pop();
      if (!(name in files)) {
        const e = new Error(`ENOENT: ${name}`);
        e.code = "ENOENT";
        throw e;
      }
      const value = files[name];
      if (value && value.__throw) {
        const e = new Error(value.message ?? "read failed");
        e.code = value.code;
        throw e;
      }
      return value;
    },
  };
}

test("resolvePaths reads env with safe defaults and never calls loadConfig", () => {
  const p = resolvePaths({
    VALKEY_URL: "redis://h:1",
    PI_LOGS_DIR: "/l",
    PI_SETTINGS_FILE: "/s.json",
    PI_TRIGGERS_FILE: "/f.json",
    PI_GLOBAL_PI_DIR: "/srv/pi-global",
    PI_CAPTURE_JOB_LOGS: "1",
    PI_DISPATCH_RUN_ROOTS: "/root-a",
    PI_DISPATCH_RUN_PER_HOUR: "5",
    PI_SUBSCRIPTIONS_FILE: "/subs.json",
    // Pinned so the sandbox default does not drag the OS temp dir into this equality
    // (REQ-RESURRECTABLE-SANDBOX); the defaulting itself is asserted in its own test below.
    PI_SANDBOX_DIR: "/sbx",
  });
  assert.deepEqual(p, {
    valkeyUrl: "redis://h:1",
    logsDir: "/l",
    settingsFile: "/s.json",
    triggersPath: "/f.json",
    sandboxDir: "/sbx",
    sandboxRetentionHours: 24,
    sandboxIdleMinutes: 30,
    globalPiDir: "/srv/pi-global",
    captureJobLogs: true,
    asciiGlyphs: false,
    dispatchRunRoots: ["/root-a"],
    dispatchRunPerHour: 5,
    schedulerStallMax: 2,
    pauseWindowsPath: "./pause-windows.json",
    subscriptionsPath: "/subs.json",
  });
});

test("resolvePaths falls back to defaults on empty env (no worker config required)", () => {
  const p = resolvePaths({});
  assert.equal(p.valkeyUrl, "redis://127.0.0.1:6379");
  assert.equal(p.triggersPath, "./triggers.json", "cwd default matching what `pi-dispatch init` scaffolds (issue #80)");
  assert.equal(p.captureJobLogs, false);
  assert.equal(p.globalPiDir, null, "no overlay dir configured -> no staged packages to arm");
  assert.equal(resolvePaths({ PI_GLOBAL_PI_DIR: "" }).globalPiDir, null, "an empty overlay dir reads as unset");
  assert.ok(typeof p.logsDir === "string" && p.logsDir.length > 0);
  assert.ok(typeof p.settingsFile === "string" && p.settingsFile.length > 0);
  assert.deepEqual(p.dispatchRunRoots, [], "default roots [] fails closed");
  assert.equal(p.dispatchRunPerHour, 3, "default per-hour cap");
  assert.equal(p.subscriptionsPath, "./subscriptions.json", "the cwd default, like triggers/pause-windows");
});

test("resolvePaths reads PI_DISPATCH_ASCII as the glyph opt-in, defaulting to box-drawing", () => {
  assert.equal(resolvePaths({ PI_DISPATCH_ASCII: "1" }).asciiGlyphs, true, "1 opts the panel into ASCII glyphs");
  assert.equal(resolvePaths({}).asciiGlyphs, false, "unset keeps the box-drawing default");
  assert.equal(resolvePaths({ PI_DISPATCH_ASCII: "0" }).asciiGlyphs, false, "only exactly '1' opts in");
});

test("resolvePaths reimplements the non-negative-int parse: invalid PI_DISPATCH_RUN_PER_HOUR falls back", () => {
  assert.equal(resolvePaths({ PI_DISPATCH_RUN_PER_HOUR: "0" }).dispatchRunPerHour, 0, "0 is valid (disables the tool)");
  assert.equal(resolvePaths({ PI_DISPATCH_RUN_PER_HOUR: "abc" }).dispatchRunPerHour, 3, "non-numeric -> default");
  assert.equal(resolvePaths({ PI_DISPATCH_RUN_PER_HOUR: "-1" }).dispatchRunPerHour, 3, "negative -> default");
});

test("listRuns parses records, sorts by endedAt desc with nulls last, skips non-json/unparseable", () => {
  const files = {
    "a.json": JSON.stringify({ jobId: "a", endedAt: "2026-07-20T10:00:00.000Z" }),
    "b.json": JSON.stringify({ jobId: "b", endedAt: "2026-07-21T10:00:00.000Z" }),
    "c.json": JSON.stringify({ jobId: "c", endedAt: null }),
    "d.json": "{ not valid json",
    "notes.txt": "ignored",
  };
  const runs = listRuns({ logsDir: "/logs", fs: fakeFs(files) });
  assert.deepEqual(
    runs.map((r) => r.jobId),
    ["b", "a", "c"],
  );
});

test("listRuns clamps the limit to 1..50", () => {
  const files = {};
  for (let i = 0; i < 60; i++) {
    files[`j${i}.json`] = JSON.stringify({ jobId: `j${i}`, endedAt: `2026-07-01T00:00:${String(i).padStart(2, "0")}.000Z` });
  }
  assert.equal(listRuns({ logsDir: "/logs", limit: 5, fs: fakeFs(files) }).length, 5);
  assert.equal(listRuns({ logsDir: "/logs", limit: 999, fs: fakeFs(files) }).length, 50);
  assert.equal(listRuns({ logsDir: "/logs", limit: 0, fs: fakeFs(files) }).length, 1);
});

test("listRuns returns [] when the logs dir does not exist", () => {
  assert.deepEqual(listRuns({ logsDir: "/nope", fs: fakeFs({}, { readdirError: { code: "ENOENT" } }) }), []);
});

test("listRuns skips a record deleted between scan and read (reaper race)", () => {
  const files = {
    "a.json": JSON.stringify({ jobId: "a", endedAt: "2026-07-20T00:00:00.000Z" }),
    "b.json": { __throw: true, code: "ENOENT", message: "gone" },
  };
  assert.deepEqual(
    listRuns({ logsDir: "/logs", fs: fakeFs(files) }).map((r) => r.jobId),
    ["a"],
  );
});

test("readRun resolves the sanitized filename for a colon-bearing id", () => {
  const files = { "repeat_x_123.json": JSON.stringify({ jobId: "repeat:x:123", outcome: "completed" }) };
  const rec = readRun({ logsDir: "/logs", jobId: "repeat:x:123", fs: fakeFs(files) });
  assert.equal(rec.outcome, "completed");
  assert.equal(rec.jobId, "repeat:x:123", "the body keeps the raw id");
});

test("readRun returns null when the record is absent", () => {
  assert.equal(readRun({ logsDir: "/logs", jobId: "nope", fs: triggerFs({}) }), null);
});

test("readLogTail returns { missing:true } when the .log is absent (capture off)", () => {
  assert.deepEqual(readLogTail({ logsDir: "/logs", jobId: "x", fs: triggerFs({}) }), { missing: true });
});

test("readLogTail returns the last N lines, dropping the trailing-newline segment", () => {
  const content = "l1\nl2\nl3\nl4\nl5\n";
  const rec = readLogTail({ logsDir: "/logs", jobId: "x", lines: 2, fs: fakeFs({ "x.log": content }) });
  assert.deepEqual(rec.lines, ["l4", "l5"]);
});

test("readBudget GETs the day/week/month keys and never mutates", async () => {
  const commands = [];
  const values = { [dayKey()]: "7", [weekKey()]: "20", [monthKey()]: "55" };
  const redis = {
    async get(key) {
      commands.push(["get", key]);
      return values[key] ?? null;
    },
    disconnect() {
      commands.push(["disconnect"]);
    },
  };
  const res = await readBudget({ url: "redis://x", redisFn: () => redis });
  assert.deepEqual(res, { day: 7, week: 20, month: 55 });
  const ops = commands.filter((c) => c[0] !== "disconnect");
  assert.deepEqual(new Set(ops.map((c) => c[0])), new Set(["get"]), "only GET -- never INCR/EXPIRE");
  assert.deepEqual(
    new Set(ops.map((c) => c[1])),
    new Set([dayKey(), weekKey(), monthKey()]),
    "GETs the worker's own day/week/month keys",
  );
});

test("readBudget returns { unreachable } when the client errors", async () => {
  const redis = {
    async get() {
      throw new Error("ECONNREFUSED");
    },
    disconnect() {},
  };
  const res = await readBudget({ url: "redis://x", redisFn: () => redis });
  assert.match(res.unreachable, /ECONNREFUSED/);
});

test("readQueueState reports paused state, counts, and worker count", async () => {
  const makeQueueFn = () => ({
    async isPaused() {
      return true;
    },
    async getJobCounts() {
      return { waiting: 2, active: 1, paused: 0, delayed: 0, failed: 3 };
    },
    async getWorkers() {
      return [{}, {}];
    },
    async close() {},
  });
  const res = await readQueueState({ url: "redis://x", makeQueueFn, parseConnectionFn: () => ({}) });
  assert.equal(res.pausedState, true);
  assert.equal(res.counts.failed, 3);
  assert.equal(res.workers, 2);
});

test("readQueueState degrades workers to 'unknown' when getWorkers is empty (no SETNAME)", async () => {
  const makeQueueFn = () => ({
    async isPaused() {
      return false;
    },
    async getJobCounts() {
      return {};
    },
    async getWorkers() {
      return [];
    },
    async close() {},
  });
  const res = await readQueueState({ url: "redis://x", makeQueueFn, parseConnectionFn: () => ({}) });
  assert.equal(res.workers, "unknown");
});

test("readQueueState returns { unreachable } and still closes when the queue is down", async () => {
  let closed = false;
  const makeQueueFn = () => ({
    async isPaused() {
      throw new Error("connection down");
    },
    async close() {
      closed = true;
    },
  });
  const res = await readQueueState({ url: "redis://x", makeQueueFn, parseConnectionFn: () => ({}) });
  assert.match(res.unreachable, /connection down/);
  assert.equal(closed, true);
});

test("readSchedulers computes overdueMs for a next in the past", async () => {
  const now = 1_000_000;
  const makeQueueFn = () => ({
    async getJobSchedulers() {
      return [
        { key: "s1", name: "local", pattern: "* * * * *", next: now - 5000 },
        { key: "s2", name: "local", every: 60000, next: now + 5000 },
        { key: "s3", name: "local" },
      ];
    },
    async close() {},
  });
  const res = await readSchedulers({ url: "redis://x", makeQueueFn, parseConnectionFn: () => ({}), now: () => now });
  assert.equal(res[0].overdueMs, 5000);
  assert.equal(res[1].overdueMs, null, "a future next is not overdue");
  assert.equal(res[2].next, null);
  assert.equal(res[2].overdueMs, null);
});

test("readSchedulers returns { unreachable } on a connection error", async () => {
  const makeQueueFn = () => ({
    async getJobSchedulers() {
      throw new Error("down");
    },
    async close() {},
  });
  const res = await readSchedulers({ url: "redis://x", makeQueueFn, parseConnectionFn: () => ({}) });
  assert.match(res.unreachable, /down/);
});

test("readPauseWindows returns normalized windows, and degrades on missing/invalid", () => {
  const fs = triggerFs({ "pw.json": JSON.stringify({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00", tz: "Europe/Amsterdam" }] }) });
  const ok = readPauseWindows({ pauseWindowsPath: "pw.json", fs });
  assert.equal(ok.windows.length, 1);
  assert.equal(ok.windows[0].tz, "Europe/Amsterdam");
  assert.equal(ok.windows[0].fromMin, 22 * 60);
  assert.deepEqual(readPauseWindows({ pauseWindowsPath: "absent.json", fs }), { missing: true });
  const bad = readPauseWindows({ pauseWindowsPath: "b.json", fs: triggerFs({ "b.json": JSON.stringify({ windows: [{ scope: "x", from: "9", to: "10:00" }] }) }) });
  assert.match(bad.invalid, /must be "HH:MM"/);
});

test("writePauseWindows validates through the shared parser and writes atomically; rejects a bad edit", () => {
  const fs = triggerFs({ "pw.json": JSON.stringify({ windows: [] }) });
  const add = writePauseWindows({ pauseWindowsPath: "pw.json", fs, mutate: (list) => [...list, { scope: "acme/web", from: "22:00", to: "06:00" }] });
  assert.deepEqual(add, { ok: true });
  assert.equal(JSON.parse(fs.files["pw.json"]).windows[0].scope, "acme/web");
  assert.ok(!("pw.json.tmp" in fs.files), "the tmp file was renamed away (atomic)");
  const bad = writePauseWindows({ pauseWindowsPath: "pw.json", fs, mutate: (list) => [...list, { scope: "x", from: "09:00", to: "09:00" }] });
  assert.match(bad.invalid, /from and to must differ/);
  assert.equal(JSON.parse(fs.files["pw.json"]).windows.length, 1, "a rejected edit leaves the file unchanged");
});

// A valid declared plan, reused across the subscriptions read/write tests below.
const kimiPlan = {
  id: "kimi-for-coding",
  vendor: "Moonshot AI",
  provider: "kimi-coding",
  price: { amount: 99, currency: "USD", per: "month" },
  windows: [{ per: "5h", rolling: true, unit: null, limit: null }],
};

test("readSubscriptions returns normalized entries via the shared parser, and degrades on missing/invalid", () => {
  const fs = triggerFs({ "subs.json": JSON.stringify({ version: 1, subscriptions: [kimiPlan] }) });
  const ok = readSubscriptions({ subscriptionsPath: "subs.json", fs });
  assert.equal(ok.version, 1);
  assert.equal(ok.subscriptions.length, 1);
  assert.equal(ok.subscriptions[0].sharedWithOtherProducts, false, "defaults applied by the worker's own normalizer");
  assert.deepEqual(ok.subscriptions[0].models, ["*"]);
  assert.deepEqual(readSubscriptions({ subscriptionsPath: "absent.json", fs }), { missing: true });
  assert.deepEqual(readSubscriptions({ subscriptionsPath: null, fs }), { missing: true }, "an unconfigured path is a normal deployment");
  const bad = readSubscriptions({ subscriptionsPath: "b.json", fs: triggerFs({ "b.json": JSON.stringify({ version: 1, subscriptions: [{ id: "x" }] }) }) });
  assert.match(bad.invalid, /vendor/);
});

test("readSubscriptions surfaces the fail-loud newer-version refusal as { invalid }, naming both versions", () => {
  const fs = triggerFs({ "subs.json": JSON.stringify({ version: 2, subscriptions: [] }) });
  const res = readSubscriptions({ subscriptionsPath: "subs.json", fs });
  assert.match(res.invalid, /newer pi-dispatch/);
  assert.match(res.invalid, /version 2/);
  assert.match(res.invalid, /understands 1/);
});

test("writeSubscriptions validates through the shared parser and writes atomically; rejects a bad edit", () => {
  const fs = triggerFs({ "subs.json": JSON.stringify({ version: 1, subscriptions: [] }) });
  const add = writeSubscriptions({ subscriptionsPath: "subs.json", fs, mutate: (list) => [...list, kimiPlan] });
  assert.deepEqual(add, { ok: true });
  const written = JSON.parse(fs.files["subs.json"]);
  assert.equal(written.version, 1, "the write re-stamps the version this build understands");
  assert.equal(written.subscriptions[0].id, "kimi-for-coding");
  assert.ok(!("subs.json.tmp" in fs.files), "the tmp file was renamed away (atomic)");
  const bad = writeSubscriptions({ subscriptionsPath: "subs.json", fs, mutate: (list) => [...list, { ...kimiPlan, vendor: "Twice" }] });
  assert.match(bad.invalid, /already used/);
  assert.equal(JSON.parse(fs.files["subs.json"]).subscriptions.length, 1, "a rejected edit leaves the file unchanged");
});

test("writeSubscriptions on a missing or unparseable file starts from the empty v1 shape and repairs it", () => {
  const missing = triggerFs({});
  assert.deepEqual(writeSubscriptions({ subscriptionsPath: "subs.json", fs: missing, mutate: (l) => [...l, kimiPlan] }), { ok: true });
  assert.equal(JSON.parse(missing.files["subs.json"]).subscriptions.length, 1);
  const garbled = triggerFs({ "subs.json": "{ not json" });
  assert.deepEqual(writeSubscriptions({ subscriptionsPath: "subs.json", fs: garbled, mutate: (l) => l }), { ok: true });
  assert.deepEqual(JSON.parse(garbled.files["subs.json"]), { version: 1, subscriptions: [] }, "the validated write repaired the file");
});

test("readTriggers normalizes each on.type into its discriminated display record", () => {
  const files = {
    "triggers.json": JSON.stringify({
      triggers: [
        { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/p", flow: "tidy", task: "t" } },
        { on: { type: "label", any: ["pi:frontend"], none: ["wontfix"] }, run: { kind: "github", flow: "frontend-fix" } },
        { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } },
        { on: { type: "pull_request", action: ["labeled"], any: ["pi:review"] }, run: { kind: "github", flow: "review" } },
      ],
    }),
  };
  const res = readTriggers({ triggersPath: "/x/triggers.json", fs: fakeFs(files) });
  // Every entry omits `run.packages`, and packages is an OPT-OUT -- so all four normalize to `true`.
  assert.deepEqual(res.triggers, [
    { type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv/p", flow: "tidy", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false },
    { type: "label", any: ["pi:frontend"], all: [], none: ["wontfix"], flow: "frontend-fix", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" },
    { type: "comment", phrase: "@pi", flow: "fix", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" },
    { type: "pull_request", action: ["labeled"], any: ["pi:review"], all: [], none: [], flow: "review", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" },
  ]);
});

test("normalizeTriggerForDisplay carries run.packages on all four kinds, with the opt-out polarity", () => {
  const entries = [
    { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/p", flow: "tidy" } },
    { on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix" } },
    { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } },
    { on: { type: "pull_request", action: ["labeled"] }, run: { kind: "github", flow: "review" } },
  ];
  assert.deepEqual(
    entries.map((e) => normalizeTriggerForDisplay(e).packages),
    [true, true, true, true],
    "every kind loads the staged packages by default, so every kind must display it -- the OMITTED flag is the case the display used to miss",
  );
  assert.deepEqual(
    entries.map((e) => normalizeTriggerForDisplay({ ...e, run: { ...e.run, packages: false } }).packages),
    [false, false, false, false],
    "and every kind can decline",
  );

  // Only an explicit `false` withholds. A malformed value cannot reach the display at all -- parseTriggers
  // refuses a non-boolean fail-loud at load -- so the display MIRRORS the worker rather than inventing a
  // fails-closed state the running job would not agree with.
  for (const packages of [undefined, true, "false", 0, null]) {
    const rec = normalizeTriggerForDisplay({ on: { type: "label", any: ["x"] }, run: { kind: "github", flow: "fix", packages } });
    assert.equal(rec.packages, true, `run.packages ${JSON.stringify(packages)} is not a declination`);
  }
});

test("normalizeTriggerForDisplay carries run.image on all four kinds, with null as the default-image sentinel", () => {
  const entries = [
    { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/p", flow: "tidy" } },
    { on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix" } },
    { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } },
    { on: { type: "pull_request", action: ["labeled"] }, run: { kind: "github", flow: "review" } },
  ];
  assert.deepEqual(
    entries.map((e) => normalizeTriggerForDisplay({ ...e, run: { ...e.run, image: "my-python:1.2.0" } }).image),
    ["my-python:1.2.0", "my-python:1.2.0", "my-python:1.2.0", "my-python:1.2.0"],
    "every kind can name its own image, so every kind must display it",
  );

  // Fail-soft, mirroring the worker (`job.image ?? config.jobImage`) rather than re-validating: parseTriggers
  // already refused anything that is not a non-empty string, so the display's job is to say "the deployment
  // default", never to invent a third state.
  for (const image of [undefined, "", "   ", 42, null, {}]) {
    const rec = normalizeTriggerForDisplay({ on: { type: "label", any: ["x"] }, run: { kind: "github", flow: "fix", image } });
    assert.equal(rec.image, null, `run.image ${JSON.stringify(image)} reads as the deployment default`);
  }
});

test("readTriggers skips an entry that is not a usable { on, run } object (viewer degrades)", () => {
  const files = {
    "triggers.json": JSON.stringify({
      triggers: [
        { on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix" } },
        "not-an-object",
        { on: { type: "unknown" }, run: { kind: "github", flow: "x" } },
        { run: { kind: "github", flow: "no-on" } },
      ],
    }),
  };
  const res = readTriggers({ triggersPath: "/x/triggers.json", fs: fakeFs(files) });
  assert.deepEqual(res.triggers, [{ type: "label", any: ["pi:frontend"], all: [], none: [], flow: "frontend-fix", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" }]);
});

test("readTriggers returns { invalid } when there is no triggers array", () => {
  const files = { "triggers.json": JSON.stringify({ schedules: [] }) };
  const res = readTriggers({ triggersPath: "/x/triggers.json", fs: fakeFs(files) });
  assert.ok(res.invalid, 'a file without a "triggers" array is invalid');
});

test("readTriggers returns { invalid } when the file is not valid JSON", () => {
  const files = { "triggers.json": "{ not valid json" };
  const res = readTriggers({ triggersPath: "/x/triggers.json", fs: fakeFs(files) });
  assert.ok(res.invalid);
});

test("readTriggers returns { missing:true } when the file is absent (viewer degrades)", () => {
  assert.deepEqual(readTriggers({ triggersPath: "/x/none.json", fs: triggerFs({}) }), { missing: true });
});

// ---- readStagedPackages (REQ-GLOBAL-PI-OVERLAY: what an armed trigger actually loads) ----

// The worker's frozen `readStageManifest({ globalPiDir, readFile, fileExists })` contract, faked: it never
// throws, and returns `{ stagedAt, packages: [{ name, version, dir }] }` or null.
const fakeManifest = (manifest) => (args) => {
  assert.equal(typeof args.globalPiDir, "string", "the reader is called with the overlay dir");
  assert.equal(typeof args.readFile, "function", "all filesystem access is injected by the admin");
  assert.equal(typeof args.fileExists, "function", "all filesystem access is injected by the admin");
  return manifest;
};

test("readStagedPackages lists the staged manifest as name@version", () => {
  const res = readStagedPackages({
    globalPiDir: "/srv/pi-global",
    readManifest: fakeManifest({
      stagedAt: "2026-07-27T10:00:00.000Z",
      packages: [
        { name: "pi-web-search", version: "1.4.2", dir: "pi-web-search" },
        { name: "pi-jira", version: "0.9.0", dir: "pi-jira" },
      ],
    }),
  });
  assert.deepEqual(res, { stagedAt: "2026-07-27T10:00:00.000Z", packages: ["pi-web-search@1.4.2", "pi-jira@0.9.0"] });
});

test("readStagedPackages reads a real manifest through the worker's own reader", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dispatch-overlay-"));
  mkdirSync(join(dir, "packages"), { recursive: true });
  writeFileSync(
    join(dir, "packages", "packages.json"),
    JSON.stringify({ stagedAt: "2026-07-27T10:00:00.000Z", packages: [{ name: "pi-web-search", version: "1.4.2", dir: "pi-web-search" }] }),
  );
  // No injected reader: the production default is the worker's `readStageManifest`, so the admin and the
  // job path cannot drift on where the manifest lives or what it may contain.
  assert.deepEqual(readStagedPackages({ globalPiDir: dir }), { stagedAt: "2026-07-27T10:00:00.000Z", packages: ["pi-web-search@1.4.2"] });
});

test("readStagedPackages drops unusable entries and falls back to a bare name with no version", () => {
  const res = readStagedPackages({
    globalPiDir: "/srv/pi-global",
    readManifest: fakeManifest({ stagedAt: 42, packages: [{ name: "pi-unpinned" }, { version: "1.0.0" }, null, "nope"] }),
  });
  assert.deepEqual(res, { stagedAt: null, packages: ["pi-unpinned"] }, "a nameless/malformed entry is skipped, not fatal");
});

test("readStagedPackages returns the safe empty shape whenever the overlay or manifest is absent", () => {
  const empty = { stagedAt: null, packages: [] };
  assert.deepEqual(readStagedPackages({ globalPiDir: null }), empty, "no overlay configured");
  assert.deepEqual(readStagedPackages({ globalPiDir: "" }), empty, "an empty overlay path is no overlay");
  assert.deepEqual(readStagedPackages(), empty, "no arguments at all");
  assert.deepEqual(readStagedPackages({ globalPiDir: "/g", readManifest: fakeManifest(null) }), empty, "no manifest on disk");
  assert.deepEqual(readStagedPackages({ globalPiDir: "/g", readManifest: fakeManifest({ packages: "not-an-array" }) }), empty, "a malformed manifest");
  // The production default against an overlay dir that does not exist degrades the same way, never throws.
  assert.deepEqual(readStagedPackages({ globalPiDir: join(tmpdir(), "pi-global-absent-xyz") }), empty, "the production default degrades too");
});

test("readStagedPackages never throws when the manifest reader does", () => {
  const boom = () => {
    throw new Error("unreadable overlay");
  };
  assert.deepEqual(readStagedPackages({ globalPiDir: "/g", readManifest: boom }), { stagedAt: null, packages: [] });
});

test("readSettingsView returns the validated overlay via the worker's own reader", () => {
  const files = { "settings.json": JSON.stringify({ model: "m", dailyCap: 5 }) };
  const res = readSettingsView({ settingsFile: "/x/settings.json", fs: fakeFs(files) });
  assert.equal(res.path, "/x/settings.json");
  assert.deepEqual(res.overlay, { model: "m", dailyCap: 5 });
});

test("readSettingsView surfaces an invalid overlay without throwing (fail closed)", () => {
  const files = { "settings.json": JSON.stringify({ dailyCap: 0 }) };
  const res = readSettingsView({ settingsFile: "/x/settings.json", fs: fakeFs(files) });
  assert.ok(res.invalid, "an out-of-bounds key makes the whole overlay invalid");
});

test("listRunIds returns the sanitized ids from json filenames only", () => {
  const files = { "repeat_x_123.json": "{}", "local-abc.json": "{}", "x.log": "raw", "n.txt": "" };
  assert.deepEqual(listRunIds({ logsDir: "/logs", fs: fakeFs(files) }).sort(), ["local-abc", "repeat_x_123"]);
});

// ---- setQueuePaused ----

test("setQueuePaused pauses through one queue and closes it in finally", async () => {
  const calls = [];
  let closed = false;
  const makeQueueFn = () => ({
    async pause() {
      calls.push("pause");
    },
    async resume() {
      calls.push("resume");
    },
    async close() {
      closed = true;
    },
  });
  const res = await setQueuePaused({ url: "redis://x", paused: true, makeQueueFn, parseConnectionFn: () => ({}) });
  assert.deepEqual(res, { ok: true, paused: true });
  assert.deepEqual(calls, ["pause"], "pause, never resume");
  assert.equal(closed, true, "closed in finally");
});

test("setQueuePaused resumes when paused is false", async () => {
  const calls = [];
  const makeQueueFn = () => ({
    async pause() {
      calls.push("pause");
    },
    async resume() {
      calls.push("resume");
    },
    async close() {},
  });
  const res = await setQueuePaused({ url: "redis://x", paused: false, makeQueueFn, parseConnectionFn: () => ({}) });
  assert.deepEqual(res, { ok: true, paused: false });
  assert.deepEqual(calls, ["resume"]);
});

test("setQueuePaused returns { unreachable } and still closes when the queue is down", async () => {
  let closed = false;
  const makeQueueFn = () => ({
    async pause() {
      throw new Error("connection down");
    },
    async close() {
      closed = true;
    },
  });
  const res = await setQueuePaused({ url: "redis://x", paused: true, makeQueueFn, parseConnectionFn: () => ({}) });
  assert.match(res.unreachable, /connection down/);
  assert.equal(closed, true, "closed in finally even on error");
});

// ---- writeSettings ----

/** An in-memory fs keyed by full path, supporting the read-modify-write path (read, mkdir, write tmp, rename). */
function memFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFileSync(path) {
      const p = String(path);
      if (!files.has(p)) {
        const e = new Error(`ENOENT: ${p}`);
        e.code = "ENOENT";
        throw e;
      }
      return files.get(p);
    },
    mkdirSync() {},
    writeFileSync(path, data) {
      files.set(String(path), data);
    },
    renameSync(from, to) {
      const f = String(from);
      if (!files.has(f)) {
        const e = new Error(`ENOENT: ${f}`);
        e.code = "ENOENT";
        throw e;
      }
      files.set(String(to), files.get(f));
      files.delete(f);
    },
  };
}

test("writeSettings merges into the existing overlay, preserving prior keys", () => {
  const path = "/s/settings.json";
  const fs = memFs({ [path]: JSON.stringify({ model: "m1", dailyCap: 5 }) });
  const res = writeSettings({ settingsFile: path, mutate: (o) => ({ ...o, maxTurns: 12 }), fs });
  assert.deepEqual(res, { ok: true, overlay: { model: "m1", dailyCap: 5, maxTurns: 12 } });
  assert.deepEqual(JSON.parse(fs.files.get(path)), { model: "m1", dailyCap: 5, maxTurns: 12 });
});

test("writeSettings rebuilds from scratch over an invalid file, keeping only the new key and reporting rebuiltFrom", () => {
  const path = "/s/settings.json";
  const fs = memFs({ [path]: "{ not valid json" });
  const res = writeSettings({ settingsFile: path, mutate: (o) => ({ ...o, dailyCap: 7 }), fs });
  assert.equal(res.ok, true);
  assert.ok(res.rebuiltFrom, "carries the read reason so the caller can warn loudly");
  assert.deepEqual(res.overlay, { dailyCap: 7 }, "base was empty; only the new key persists");
  assert.deepEqual(JSON.parse(fs.files.get(path)), { dailyCap: 7 });
});

test("writeSettings passes through writeOverlay's { invalid } and leaves the file untouched", () => {
  const path = "/s/settings.json";
  const fs = memFs({ [path]: JSON.stringify({ model: "m1" }) });
  const res = writeSettings({ settingsFile: path, mutate: (o) => ({ ...o, dailyCap: 0 }), fs });
  assert.ok(res.invalid);
  assert.ok(res.invalid.includes("dailyCap"));
  assert.deepEqual(JSON.parse(fs.files.get(path)), { model: "m1" }, "original overlay untouched (validate-before-write)");
});

// ---- revParseHead ----

test("revParseHead trims the HEAD sha and returns null on empty or error", () => {
  assert.equal(revParseHead("/x", { exec: () => "deadbeefcafe\n" }), "deadbeefcafe");
  assert.equal(revParseHead("/x", { exec: () => "   \n" }), null, "whitespace-only -> null");
  assert.equal(
    revParseHead("/x", {
      exec: () => {
        throw new Error("not a git repository");
      },
    }),
    null,
    "git error -> null (never throws)",
  );
});

// ---- enqueueDispatchRun ----

/**
 * A default set of injected fakes for the happy AI-invoked path, each overridable per test. `makeQueueFn`
 * returns a fake whose `add` records the enqueue (enqueueLocalJob is the real function calling `queue.add`);
 * the redis fake models an INCR-then-EXPIRE rolling-hour bucket; the clock is fixed. `env` carries no roots
 * by default (so the AI allowlist fails closed unless a test supplies one).
 */
function dispatchFakes(overrides = {}) {
  const added = [];
  const redisCmds = [];
  const gateCalls = [];
  const revCalls = [];
  const fakes = {
    env: { VALKEY_URL: "redis://x", PI_DISPATCH_RUN_PER_HOUR: "3" },
    makeQueueFn: () => ({
      async add(name, data, opts) {
        added.push({ name, data, opts });
        return {};
      },
      async close() {},
    }),
    parseConnectionFn: () => ({}),
    gitDirtyFn: () => false,
    revParseHeadFn: (folder) => {
      revCalls.push(folder);
      return "deadbeef";
    },
    readFlowGateFn: async ({ folder, flow, sha }) => {
      gateCalls.push({ folder, flow, sha });
      return { gate: "allow" };
    },
    redisFn: () => ({
      async incr(k) {
        redisCmds.push(["incr", k]);
        return 1;
      },
      async expire(k, s) {
        redisCmds.push(["expire", k, s]);
      },
      disconnect() {
        redisCmds.push(["disconnect"]);
      },
    }),
    now: () => Date.UTC(2026, 6, 22, 10, 30, 0),
    ...overrides,
  };
  return { fakes, added, redisCmds, gateCalls, revCalls };
}

/** A real temp folder nested under a (realpath'd) root, so the allowlist's realpath+containment resolves. */
function tempRootAndFolder(tag) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), tag)));
  const folder = join(root, "repo");
  mkdirSync(folder);
  return { root, folder };
}

test("enqueueDispatchRun refuses a flowless trigger (flow required, both paths)", async () => {
  const { fakes } = dispatchFakes();
  const res = await enqueueDispatchRun({ folder: "/any", flow: "", task: "t", aiInvoked: true, ...fakes });
  assert.match(res.refused, /no flow/);
});

test("enqueueDispatchRun (aiInvoked) refuses a folder outside PI_DISPATCH_RUN_ROOTS (default [] fails closed)", async () => {
  const { fakes, added } = dispatchFakes({ env: { VALKEY_URL: "redis://x" } }); // no roots -> []
  const res = await enqueueDispatchRun({ folder: "/etc", flow: "fix", task: "t", aiInvoked: true, ...fakes });
  assert.match(res.refused, /PI_DISPATCH_RUN_ROOTS/);
  assert.equal(added.length, 0);
});

test("enqueueDispatchRun (aiInvoked) enqueues on the happy path: in-roots, clean, gate allow, under the limit", async () => {
  const { root, folder } = tempRootAndFolder("dr-happy-");
  const env = { VALKEY_URL: "redis://x", PI_DISPATCH_RUN_ROOTS: root, PI_DISPATCH_RUN_PER_HOUR: "3" };
  const { fakes, added, gateCalls, redisCmds } = dispatchFakes({ env });
  const res = await enqueueDispatchRun({ folder, flow: "fix", task: "do the thing", aiInvoked: true, ...fakes });
  assert.equal(res.ok, true);
  assert.ok(typeof res.jobId === "string" && res.jobId.startsWith("local-"), "returns the local job id");
  assert.equal(added.length, 1, "enqueued exactly one job");
  assert.equal(added[0].data.folder, folder);
  assert.equal(added[0].data.flow, "fix");
  assert.equal(added[0].data.task, "do the thing");
  assert.equal(added[0].data.chainDepth, undefined, "root run: no chainDepth pinned");
  assert.equal(added[0].data.parentJobId, undefined, "root run: no parentJobId");
  assert.equal(gateCalls.length, 1, "flow gate consulted at the resolved sha");
  assert.equal(gateCalls[0].sha, "deadbeef", "gate uses the pre-agent HEAD sha, not a pinned one");
  assert.ok(
    redisCmds.some((c) => c[0] === "incr"),
    "rate limit ran its INCR",
  );
});

test("enqueueDispatchRun refuses a dirty tree and a non-repo (both paths, no force)", async () => {
  const { root, folder } = tempRootAndFolder("dr-dirty-");
  const env = { VALKEY_URL: "redis://x", PI_DISPATCH_RUN_ROOTS: root, PI_DISPATCH_RUN_PER_HOUR: "3" };
  const dirty = await enqueueDispatchRun({
    folder,
    flow: "fix",
    task: "t",
    aiInvoked: true,
    ...dispatchFakes({ env, gitDirtyFn: () => true }).fakes,
  });
  assert.match(dirty.refused, /uncommitted changes/);
  const nonRepo = await enqueueDispatchRun({
    folder,
    flow: "fix",
    task: "t",
    aiInvoked: true,
    ...dispatchFakes({ env, gitDirtyFn: () => null }).fakes,
  });
  assert.match(nonRepo.refused, /not a usable git repository/);
});

test("enqueueDispatchRun (aiInvoked) refuses when the flow gate denies or has no skill", async () => {
  const { root, folder } = tempRootAndFolder("dr-gate-");
  const env = { VALKEY_URL: "redis://x", PI_DISPATCH_RUN_ROOTS: root, PI_DISPATCH_RUN_PER_HOUR: "3" };
  for (const gate of ["deny", "no-skill"]) {
    const { fakes } = dispatchFakes({ env, readFlowGateFn: async () => ({ gate }) });
    const res = await enqueueDispatchRun({ folder, flow: "fix", task: "t", aiInvoked: true, ...fakes });
    assert.match(res.refused, /not AI-triggerable/);
    assert.match(res.refused, /ai-trigger: allow/, `${gate} refusal names the required opt-in`);
  }
});

test("enqueueDispatchRun (aiInvoked) refuses (gate never consulted) when HEAD cannot be resolved", async () => {
  const { root, folder } = tempRootAndFolder("dr-nohead-");
  const env = { VALKEY_URL: "redis://x", PI_DISPATCH_RUN_ROOTS: root, PI_DISPATCH_RUN_PER_HOUR: "3" };
  let gateCalled = false;
  const { fakes } = dispatchFakes({
    env,
    revParseHeadFn: () => null,
    readFlowGateFn: async () => {
      gateCalled = true;
      return { gate: "allow" };
    },
  });
  const res = await enqueueDispatchRun({ folder, flow: "fix", task: "t", aiInvoked: true, ...fakes });
  assert.match(res.refused, /not AI-triggerable/);
  assert.equal(gateCalled, false, "no sha -> the object-store gate is never read");
});

test("enqueueDispatchRun (aiInvoked) refuses over the per-hour rate limit; INCR-then-compare, EXPIRE on first", async () => {
  const { root, folder } = tempRootAndFolder("dr-rate-");
  const env = { VALKEY_URL: "redis://x", PI_DISPATCH_RUN_ROOTS: root, PI_DISPATCH_RUN_PER_HOUR: "2" };
  const cmds = [];
  const redisFn = () => ({
    async incr(k) {
      cmds.push(["incr", k]);
      return 3; // already over the cap of 2
    },
    async expire(k, s) {
      cmds.push(["expire", k, s]);
    },
    disconnect() {
      cmds.push(["disconnect"]);
    },
  });
  const { fakes, added } = dispatchFakes({ env, redisFn });
  const res = await enqueueDispatchRun({ folder, flow: "fix", task: "t", aiInvoked: true, ...fakes });
  assert.match(res.refused, /hourly limit \(2\) reached/);
  assert.equal(added.length, 0, "over the limit: nothing enqueued");
  const key = cmds.find((c) => c[0] === "incr")[1];
  assert.match(key, /^dispatch-run:\d{4}-\d{2}-\d{2}-\d{2}$/, "rolling-hour bucket key shape");
  assert.ok(cmds.some((c) => c[0] === "disconnect"), "redis client closed in finally");
});

test("enqueueDispatchRun rate limit sets EXPIRE only when the hour bucket is first created (count===1)", async () => {
  const { root, folder } = tempRootAndFolder("dr-expire-");
  const env = { VALKEY_URL: "redis://x", PI_DISPATCH_RUN_ROOTS: root, PI_DISPATCH_RUN_PER_HOUR: "5" };
  const cmds = [];
  const redisFn = () => ({
    async incr(k) {
      cmds.push(["incr", k]);
      return 1;
    },
    async expire(k, s) {
      cmds.push(["expire", k, s]);
    },
    disconnect() {
      cmds.push(["disconnect"]);
    },
  });
  const { fakes } = dispatchFakes({ env, redisFn });
  await enqueueDispatchRun({ folder, flow: "fix", task: "t", aiInvoked: true, ...fakes });
  const key = cmds.find((c) => c[0] === "incr")[1];
  assert.ok(
    cmds.some((c) => c[0] === "expire" && c[1] === key),
    "EXPIRE set on the first INCR",
  );
});

test("enqueueDispatchRun (aiInvoked) refuses entirely when the per-hour cap is 0, without touching redis", async () => {
  const { root, folder } = tempRootAndFolder("dr-zero-");
  const env = { VALKEY_URL: "redis://x", PI_DISPATCH_RUN_ROOTS: root, PI_DISPATCH_RUN_PER_HOUR: "0" };
  let redisTouched = false;
  const { fakes } = dispatchFakes({
    env,
    redisFn: () => {
      redisTouched = true;
      return { async incr() { return 1; }, async expire() {}, disconnect() {} };
    },
  });
  const res = await enqueueDispatchRun({ folder, flow: "fix", task: "t", aiInvoked: true, ...fakes });
  assert.match(res.refused, /hourly limit \(0\) reached/);
  assert.equal(redisTouched, false, "a disabled tool refuses without opening a redis connection");
});

test("enqueueDispatchRun returns { unreachable } and closes the queue when the enqueue fails", async () => {
  const { root, folder } = tempRootAndFolder("dr-unreach-");
  const env = { VALKEY_URL: "redis://x", PI_DISPATCH_RUN_ROOTS: root, PI_DISPATCH_RUN_PER_HOUR: "3" };
  let closed = false;
  const { fakes } = dispatchFakes({
    env,
    makeQueueFn: () => ({
      async add() {
        throw new Error("connection down");
      },
      async close() {
        closed = true;
      },
    }),
  });
  const res = await enqueueDispatchRun({ folder, flow: "fix", task: "t", aiInvoked: true, ...fakes });
  assert.match(res.unreachable, /connection down/);
  assert.equal(closed, true, "queue closed in finally even on error");
});

test("enqueueDispatchRun (operator, aiInvoked:false) skips allowlist/gate/rate-limit but STILL refuses a dirty tree", async () => {
  let gateCalled = false;
  let redisCalled = false;
  let revCalled = false;
  const { fakes } = dispatchFakes({
    env: { VALKEY_URL: "redis://x" }, // no roots: an AI trigger would refuse, but the operator path skips the allowlist
    gitDirtyFn: () => true,
    revParseHeadFn: () => {
      revCalled = true;
      return "abc";
    },
    readFlowGateFn: async () => {
      gateCalled = true;
      return { gate: "allow" };
    },
    redisFn: () => {
      redisCalled = true;
      return { async incr() { return 1; }, async expire() {}, disconnect() {} };
    },
  });
  const res = await enqueueDispatchRun({ folder: "/anywhere", flow: "fix", task: "t", aiInvoked: false, ...fakes });
  assert.match(res.refused, /uncommitted changes/, "the dirty guard fires on the operator path too");
  assert.equal(revCalled, false, "operator path never resolves HEAD for the gate");
  assert.equal(gateCalled, false, "operator path never reads the flow gate");
  assert.equal(redisCalled, false, "operator path never touches the rate limiter");
});

test("enqueueDispatchRun (operator, aiInvoked:false) enqueues a clean tree with no allowlist/gate/rate-limit", async () => {
  let gateCalled = false;
  let redisCalled = false;
  const { fakes, added } = dispatchFakes({
    env: { VALKEY_URL: "redis://x" }, // no roots at all
    gitDirtyFn: () => false,
    readFlowGateFn: async () => {
      gateCalled = true;
      return { gate: "allow" };
    },
    redisFn: () => {
      redisCalled = true;
      return { async incr() { return 1; }, async expire() {}, disconnect() {} };
    },
  });
  const res = await enqueueDispatchRun({ folder: "/anywhere", flow: "fix", task: "t", aiInvoked: false, ...fakes });
  assert.equal(res.ok, true);
  assert.equal(added.length, 1, "enqueued one job");
  assert.equal(added[0].data.task, "t");
  assert.equal(gateCalled, false);
  assert.equal(redisCalled, false);
});

test("enqueueDispatchRun never writes task text to any log line (PII discipline)", async () => {
  const { root, folder } = tempRootAndFolder("dr-pii-");
  const env = { VALKEY_URL: "redis://x", PI_DISPATCH_RUN_ROOTS: root, PI_DISPATCH_RUN_PER_HOUR: "3" };
  const marker = "SUPER_SECRET_TASK_MARKER";
  const captured = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  console.log = console.error = console.warn = console.info = (...a) => captured.push(a.map(String).join(" "));
  try {
    const { fakes } = dispatchFakes({ env });
    const res = await enqueueDispatchRun({ folder, flow: "fix", task: marker, aiInvoked: true, ...fakes });
    assert.equal(res.ok, true);
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!captured.some((line) => line.includes(marker)), "task text must never reach a log line");
});

test("normalizeTriggerForDisplay carries the forge a webhook trigger names, and null on cron", () => {
  const gl = normalizeTriggerForDisplay({ on: { type: "label", any: ["x"] }, run: { kind: "gitlab", flow: "fix" } });
  assert.equal(gl.forge, "gitlab");
  const gh = normalizeTriggerForDisplay({ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } });
  assert.equal(gh.forge, "github");
  // A cron trigger carries no `forge` key at all -- not "local", and not null-as-a-value. The field
  // answers "which forge does this listen to", and cron listens to none; inventing an answer would make
  // the cron record claim a fact it does not have.
  const cron = normalizeTriggerForDisplay({ on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/p", flow: "tidy" } });
  assert.equal("forge" in cron, false, "a cron trigger has no forge to report");

  // Fail-soft, not re-validating: an unknown kind is shown as written. The worker refuses to boot on it,
  // and the panel echoing the operator's own value is how they see WHY.
  const odd = normalizeTriggerForDisplay({ on: { type: "label", any: ["x"] }, run: { kind: "bitbucket", flow: "fix" } });
  assert.equal(odd.forge, "bitbucket");
});

test("normalizeTriggerForDisplay carries run.resume, and only an explicit true arms it", () => {
  // The read model is where the polarity actually lives; the renderer only reads the boolean it is given.
  // Without an ARMED fixture here, forcing this field to false would leave every test green while the
  // panel silently stopped badging the disclosure -- which is exactly the shape of the [packages] defect.
  const armed = normalizeTriggerForDisplay({ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", resume: true } });
  assert.equal(armed.resume, true);

  // Opt-IN, so anything short of an explicit true is a cold start -- the OPPOSITE of `packages`, which is
  // an opt-out and therefore true unless explicitly declined. Both are asserted on one record so the two
  // polarities cannot be "harmonised" by someone reading only one of them.
  for (const value of [undefined, false, "true", 1, null]) {
    const t = normalizeTriggerForDisplay({ on: { type: "label", any: ["x"] }, run: { kind: "github", flow: "f", resume: value } });
    assert.equal(t.resume, false, `resume ${JSON.stringify(value)} must not arm the badge`);
    assert.equal(t.packages, true, "packages is an opt-OUT and stays true here -- the polarities are deliberately opposite");
  }
});

// ---- scanRunRecords (the cost fold's bounded scan) ----

test("scanRunRecords returns every in-window record -- the scan is bounded by time, not the 50-record display clamp", () => {
  const nowMs = Date.parse("2026-07-10T00:00:00.000Z");
  const files = {};
  for (let i = 0; i < 60; i++) {
    files[`j${i}.json`] = JSON.stringify({ jobId: `j${i}`, endedAt: "2026-07-09T00:00:00.000Z" });
  }
  const res = scanRunRecords({ logsDir: "/logs", sinceMs: nowMs - 5 * 86400000, nowMs, fs: fakeFs(files) });
  assert.equal(res.length, 60, "all 60 records return -- listRuns' 1..50 clamp is a display concern, not a scan bound");
});

test("scanRunRecords filters on endedAt with startedAt fallback, and drops a record with no usable timestamp", () => {
  const nowMs = Date.parse("2026-07-10T00:00:00.000Z");
  const sinceMs = Date.parse("2026-07-05T00:00:00.000Z");
  const files = {
    "in.json": JSON.stringify({ jobId: "in", endedAt: "2026-07-07T00:00:00.000Z" }),
    "out.json": JSON.stringify({ jobId: "out", endedAt: "2026-07-01T00:00:00.000Z" }),
    "started.json": JSON.stringify({ jobId: "started", endedAt: null, startedAt: "2026-07-08T00:00:00.000Z" }),
    "started-out.json": JSON.stringify({ jobId: "started-out", endedAt: null, startedAt: "2026-07-02T00:00:00.000Z" }),
    "no-ts.json": JSON.stringify({ jobId: "no-ts", endedAt: null, startedAt: null }),
  };
  const ids = scanRunRecords({ logsDir: "/logs", sinceMs, nowMs, fs: fakeFs(files) })
    .map((r) => r.jobId)
    .sort();
  assert.deepEqual(ids, ["in", "started"], "endedAt governs; startedAt only stands in when endedAt is null; timestampless records cannot be windowed");
});

test("scanRunRecords hard-caps the window at 92 days even when sinceMs asks for more", () => {
  const nowMs = Date.parse("2026-07-10T00:00:00.000Z");
  const files = {
    "recent.json": JSON.stringify({ jobId: "recent", endedAt: "2026-07-01T00:00:00.000Z" }),
    "ancient.json": JSON.stringify({ jobId: "ancient", endedAt: "2026-04-01T00:00:00.000Z" }), // 100 days back
  };
  const res = scanRunRecords({ logsDir: "/logs", sinceMs: nowMs - 120 * 86400000, nowMs, fs: fakeFs(files) });
  assert.deepEqual(
    res.map((r) => r.jobId),
    ["recent"],
    "a keep-forever deployment (PI_LOG_RETENTION_DAYS=0) still folds at most a quarter",
  );
});

test("scanRunRecords: a missing dir is a normal empty history; any other readdir error is { unreachable }", () => {
  assert.deepEqual(scanRunRecords({ logsDir: "/nope", sinceMs: 0, fs: fakeFs({}, { readdirError: { code: "ENOENT" } }) }), []);
  const res = scanRunRecords({ logsDir: "/logs", sinceMs: 0, fs: fakeFs({}, { readdirError: { code: "EACCES" } }) });
  assert.match(res.unreachable, /EACCES/);
});

test("scanRunRecords skips a record deleted between scan and read (reaper race), non-JSON text, and non-json files", () => {
  const nowMs = Date.parse("2026-07-10T00:00:00.000Z");
  const files = {
    "a.json": JSON.stringify({ jobId: "a", endedAt: "2026-07-09T00:00:00.000Z" }),
    "b.json": { __throw: true, code: "ENOENT", message: "gone" },
    "c.json": "{ not valid json",
    "d.log": "raw container output",
  };
  assert.deepEqual(
    scanRunRecords({ logsDir: "/logs", sinceMs: nowMs - 86400000, nowMs, fs: fakeFs(files) }).map((r) => r.jobId),
    ["a"],
  );
});

test("normalizeTriggerForDisplay surfaces replicas on the webhook kinds, and null is the one-run default", () => {
  // `> 1` rather than `!== undefined`: the only thing worth rendering is a trigger that MULTIPLIES SPEND.
  // `null` is the same "resolves the deployment behaviour" sentinel flow/model/image use.
  const label = normalizeTriggerForDisplay({ on: { type: "label", any: ["bug"] }, run: { kind: "github", flow: "fix", replicas: 2 } });
  assert.equal(label.replicas, 2);
  const comment = normalizeTriggerForDisplay({ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", replicas: 3 } });
  assert.equal(comment.replicas, 3);
  const pr = normalizeTriggerForDisplay({ on: { type: "pull_request", action: ["opened"] }, run: { kind: "github", flow: "review", replicas: 2 } });
  assert.equal(pr.replicas, 2);

  const plain = normalizeTriggerForDisplay({ on: { type: "label", any: ["bug"] }, run: { kind: "github", flow: "fix" } });
  assert.equal(plain.replicas, null, "an unflagged trigger renders as one run per delivery");

  // Fail-soft, like the rest of this normalizer: a value the loader would have refused renders as the
  // default rather than throwing inside a viewer.
  for (const bad of [1, 0, "2", 2.5, null, {}]) {
    assert.equal(normalizeTriggerForDisplay({ on: { type: "label", any: ["b"] }, run: { kind: "github", flow: "f", replicas: bad } }).replicas, null, `replicas=${JSON.stringify(bad)}`);
  }

  // A cron entry can never carry one, so it has no key -- the same absence `forge` has there.
  const cron = normalizeTriggerForDisplay({ on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/p", flow: "f", task: "t" } });
  assert.equal("replicas" in cron, false);
});
