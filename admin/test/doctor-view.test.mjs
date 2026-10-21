import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { NAMED_CHECK_IDS } from "@edgehero/pi-dispatch/doctor-results";
import { DOCTOR_FILE_CHECKS, doctorQuote, doctorStale } from "../src/doctor-view.mjs";
import { configPauseWindows, configSettings, configTriggers, fleetDoctor } from "../src/console/panels.mjs";
import { stripAnsi, visibleLen } from "../src/style.mjs";

/**
 * The published doctor results on both surfaces (issue #712, `INT-DOCTOR-RESULTS-KEY`): the console's Doctor panel and
 * its "does not load" sentences, and the `/dispatch` panel's HOSTS view. Canned snapshots at a fixed instant; nothing
 * here reads a Valkey or the wall clock.
 */

const AT = Date.UTC(2026, 9, 21, 9, 0, 0);
const H = 3_600_000;
const HOSTILE = "<script>alert(1)</script>\u001b[2J‮";

const ROWS = [
  {
    name: "mini1",
    ageMs: 3 * H,
    at: AT - 3 * H,
    version: "4.3.1",
    openshell: true,
    every: 24,
    by: { uid: 1001, worker: true },
    counts: { ok: 40, warn: 1, fail: 1 },
    checks: [
      { id: "node.1", level: "ok" },
      { id: "valkey.2", level: "warn", label: "another account also listens on <path>", fix: "stop it" },
      { id: "triggers.file", level: "fail", label: `triggers file is refused at load: <path>: ${HOSTILE}`, fix: "fix <path> so it loads" },
    ],
    more: 0,
  },
  { name: "build3", ageMs: 72 * H, at: AT - 72 * H, version: "4.3.0", openshell: false, every: 24, by: { uid: 0, worker: false }, workerRun: { uid: 1001, at: AT - 96 * H }, counts: { ok: 30, warn: 0, fail: 0 }, checks: [{ id: "node.1", level: "ok" }], more: 0 },
  { name: "odd", unreadable: true },
];

const snapshot = (doctor = { hosts: ROWS, more: 0 }, extra = {}) => ({ queue: { counts: {} }, budget: {}, runs: [], hostBudgets: [{ name: "mini1", staleMs: 2000 }, { name: "quiet", staleMs: 2000 }], doctor, ...extra });
const render = (panel, snap, role = "viewer") => String(panel({ data: { snapshot: snap }, role, now: AT, query: {}, env: {} }));

test("the sentences' check ids are the worker's named ids, so a renamed check cannot silently stop being quoted", () => {
  for (const [what, id] of Object.entries(DOCTOR_FILE_CHECKS)) assert.ok(NAMED_CHECK_IDS.includes(id), `${what} quotes ${id}, which doctor does not name`);
});

test("stale is two of the host's own intervals; an interval of 0 or unknown is never stale", () => {
  assert.equal(doctorStale({ every: 24, ageMs: 48 * H }), false);
  assert.equal(doctorStale({ every: 24, ageMs: 48 * H + 1 }), true);
  assert.equal(doctorStale({ every: 0, ageMs: 900 * H }), false);
  assert.equal(doctorStale({ every: null, ageMs: 900 * H }), false);
});

test("the console's Doctor panel: per host its age, counts and problems with fixes, failing first, stale and silent hosts said", () => {
  const out = render(fleetDoctor, snapshot());
  assert.match(out, /<h2>Doctor<\/h2>/);
  assert.match(out, /<h3>mini1<\/h3><p class="bad">Doctor ran 3h 0m ago \(version 4\.3\.1\), run by the worker: 1 failing, 1 warning, 40 passing\. The openshell venue was judged\.<\/p>/);
  assert.ok(out.indexOf("triggers.file") < out.indexOf("valkey.2"), "failing before warning");
  assert.match(out, /<td>fix &lt;path&gt; so it loads<\/td>/);
  assert.doesNotMatch(out, /node\.1/, "an ok check is never listed");
  assert.match(out, /<h3>build3<\/h3><p>Doctor ran 3d 0h ago \(version 4\.3\.0\), run by hand \(uid 0\): 0 failing, 0 warnings, 30 passing\.<\/p><p class="warn">It replaced the worker's own run of 4d 0h ago \(uid 1001\), so it shows another account's view of the host\.<\/p><p class="warn">Stale: older than two of this host's doctor runs \(every 24h\)/);
  assert.match(out, /Every check passed\./);
  assert.match(out, /<h3>odd<\/h3><p class="warn">Its published result cannot be read/);
  assert.match(out, /No doctor result published by: quiet\./, "a live host that never published is named, never read as healthy");
  assert.equal(render(fleetDoctor, snapshot(), "operator"), out, "the same panel for both roles: the labels are doctor's redacted sentences, not run text");
});

test("the console's Doctor panel escapes a hostile label and scrubs its control bytes", () => {
  const out = render(fleetDoctor, snapshot());
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(out, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/);
});

test("the console's Doctor panel: nothing published, an unreadable read, and a capped index each say what they are", () => {
  assert.match(render(fleetDoctor, snapshot({ hosts: [], more: 0 })), /No host has published doctor results yet\. Each worker runs doctor a minute after it starts/);
  assert.match(render(fleetDoctor, snapshot({ unreachable: "timeout" })), /The published doctor results could not be read\./);
  assert.match(render(fleetDoctor, snapshot(null)), /could not be read/, "a snapshot from a reader without the field");
  assert.match(render(fleetDoctor, snapshot({ hosts: [], more: 3 })), /3 more hosts published results/);
  const many = { ...ROWS[0], checks: Array.from({ length: 12 }, (_, i) => ({ id: `env.${i + 1}`, level: "warn", label: `w${i}` })), more: 5 };
  assert.match(render(fleetDoctor, snapshot({ hosts: [many], more: 0 })), /9 more not shown here/, "4 past the eight shown, plus the 5 the record did not list");
});

test("a file that does not load quotes the newest published check about it, naming the host; without one, the old pointer", () => {
  const triggersBroken = snapshot(null, { triggers: { invalid: true } });
  const quoted = render(configTriggers, { ...triggersBroken, doctor: { hosts: ROWS, more: 0 } });
  assert.match(quoted, /The triggers file does not load\. pi-dispatch doctor on mini1 \(its own copy of the file, 3h 0m ago\) says: triggers file is refused at load: &lt;path&gt;: &lt;script&gt;/);
  assert.match(quoted, /\. Fix: fix &lt;path&gt; so it loads/);
  const newer = { ...ROWS[0], name: "mini2", ageMs: H, checks: [{ id: "triggers.file", level: "fail", label: "newer words" }] };
  assert.match(render(configTriggers, { ...triggersBroken, doctor: { hosts: [ROWS[0], newer], more: 0 } }), /doctor on mini2 \(its own copy of the file, 1h 0m ago\) says: newer words<\/p>/, "with no record of this host's, the newest other host's result wins");
  const own = { ...triggersBroken, doctorSelf: "mini1", doctor: { hosts: [ROWS[0], newer], more: 0 } };
  assert.match(render(configTriggers, own), /doctor on this host \(mini1, 3h 0m ago\) says: triggers file is refused/, "this host's own record first, though another's is newer");
  const okHere = { ...own, doctor: { hosts: [{ ...ROWS[0], checks: [{ id: "triggers.file", level: "ok" }] }, newer], more: 0 } };
  assert.match(render(configTriggers, okHere), /The triggers file does not load; run pi-dispatch doctor for the reason\./, "this host's run saw it load: no other host's failure is quoted");
  assert.match(render(configTriggers, { ...own, doctorSelf: "elsewhere" }), /doctor on mini2 \(its own copy/, "a host with no record of its own falls back");
  assert.match(render(configTriggers, triggersBroken), /The triggers file does not load; run pi-dispatch doctor for the reason\./);
  assert.match(render(configPauseWindows, snapshot(null, { pauseWindows: { invalid: true } })), /The pause-windows file does not load; run pi-dispatch doctor for the reason\./);
  const settingsBroken = snapshot({ hosts: [{ ...ROWS[0], checks: [{ id: "settings.overlay", level: "fail", label: "settings overlay <path> is invalid (duplicate key maxTurns)" }] }], more: 0 }, { settings: { invalid: true } });
  assert.match(render(configSettings, settingsBroken), /The settings overlay does not load\. pi-dispatch doctor on mini1 \(its own copy of the file, 3h 0m ago\) says: settings overlay &lt;path&gt; is invalid \(duplicate key maxTurns\)/);
  assert.equal(doctorQuote(snapshot(), "settings.overlay"), null, "an id nobody published quotes nothing");
  assert.equal(doctorQuote(snapshot({ hosts: [{ ...ROWS[0], checks: [{ id: "settings.overlay", level: "ok" }] }] }), "settings.overlay"), null, "an ok result is not a reason");
});

// ---- the /dispatch panel's HOSTS view ----------------------------------------------------------------------------------

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { makeDashboard } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const SGR_THEME = { fg: (_c, t) => `\x1b[38;5;42m${t}\x1b[39m`, bold: (t) => `\x1b[1m${t}\x1b[22m`, bg: (_c, t) => t };

async function openHosts(snap, theme = undefined) {
  const deps = { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT, capacityInfo: async () => ({ unreachable: "not in this test" }) };
  const comp = makeDashboard({ paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000, theme, deps });
  await flush();
  comp.handleInput("u");
  await flush();
  return comp;
}
const body = (comp, w) => comp.render(w).map((l) => stripAnsi(l).trim().replace(/^│ ?/, "").replace(/ *│$/, "").trim()).filter(Boolean).join(" ");

test("the HOSTS view: each host's doctor age and counts, its problems with fixes, stale, silent and doctor-only hosts", async () => {
  const comp = await openHosts({ ...snapshot(), hostBudgets: [{ name: "mini1", staleMs: 2000, concurrency: "2" }, { name: "quiet", staleMs: 2000, concurrency: "1" }] });
  const text = body(comp, 140);
  assert.match(text, /doctor 3h ago, run by the worker: 1 failing, 1 warning, 40 passing/);
  assert.match(text, /✗ triggers file is refused at load: <path>: <script>alert\(1\)<\/script>/);
  assert.match(text, /→ fix <path> so it loads/);
  assert.match(text, /⚠ another account also listens on <path> → stop it/);
  assert.ok(text.indexOf("✗ triggers file") < text.indexOf("⚠ another account"), "failing first");
  assert.match(text, /quiet .*doctor: nothing published by this host yet/);
  assert.match(text, /build3 {2}no live row doctor 3d ago, run by hand \(uid 0\): 0 failing, 0 warnings, 30 passing · stale \(runs every 24h\) · replaced the worker's run/, "a host with a result and no live row is still drawn");
  assert.match(text, /odd {2}no live row doctor: its published result cannot be read/);
  await comp.dispose();
});

test("the HOSTS view: an unreadable doctor read is one line, and a host never reads as unchecked because of it", async () => {
  const comp = await openHosts({ ...snapshot({ unreachable: "timeout" }) });
  const text = body(comp, 140);
  assert.match(text, /doctor results unreadable \(timeout\)/);
  assert.doesNotMatch(text, /nothing published by this host yet/);
  await comp.dispose();
});

test("the HOSTS view's doctor lines fit at 140, 80, 60 and 47, coloured; a hostile label reaches the terminal as text", async () => {
  const long = { ...ROWS[0], name: `a${"b".repeat(70)}`, checks: [{ id: "env.1", level: "fail", label: `${"word ".repeat(60)}${"x".repeat(200)}`, fix: "y".repeat(150) }, { id: "env.2", level: "warn", label: "w2" }, { id: "env.3", level: "warn", label: "w3" }, ...ROWS[0].checks] };
  const comp = await openHosts({ ...snapshot({ hosts: [long, ...ROWS], more: 0 }) }, SGR_THEME);
  for (const w of [140, 80, 60, 47]) {
    const lines = comp.render(w);
    for (const l of lines) assert.ok(visibleLen(l) <= w, `width ${w}: ${JSON.stringify(stripAnsi(l))} is ${visibleLen(l)} columns`);
    const plain = lines.map(stripAnsi).join("\n");
    assert.doesNotMatch(plain, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/, `width ${w}: no control byte survives`);
    assert.doesNotMatch(plain, /‮/, `width ${w}: the override does not reach the terminal`);
  }
  assert.match(body(comp, 140), /\+1 more: the console's Fleet page lists them/, "past four, the rest are counted");
  await comp.dispose();
});

// ---- the read ----------------------------------------------------------------------------------------------------------

test("the fleet reader carries the results on the snapshot, read for the live hosts, at most every 15 s, pruning only when it may write", async () => {
  const { createFleetReader } = await import("../src/read-model.mjs");
  const queue = {
    async isPaused() { return false; }, async getJobCounts() { return { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }; },
    async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { return []; },
    async getFailed() { return []; }, async pause() {}, async resume() {}, async close() {},
  };
  const redis = { async get() { return "0"; }, async mget(...k) { return k.map(() => null); }, async hgetall() { return {}; }, async smembers() { return []; }, on() {}, disconnect() {} };
  let clock = AT;
  const reads = [];
  const make = (readOnly) =>
    createFleetReader({ valkeyUrl: "redis://x", logsDir: "/nonexistent/pd-712-logs" }, {
      makeQueueFn: () => queue, parseConnectionFn: () => ({}), redisFn: () => redis, readOnly, nowFn: () => clock,
      readLiveHostsFn: async () => ({ hosts: [{ name: "mini1", staleMs: 0 }] }), discoverHostQueuesFn: async () => [],
      readDoctorResultsFn: async (_redis, opts) => (reads.push({ names: opts.names, prune: opts.prune, at: opts.now() }), { hosts: [ROWS[0]], more: 0 }),
    });
  const console = make(true);
  const first = await console.snapshot();
  assert.deepEqual(first.doctor, { hosts: [ROWS[0]], more: 0 });
  assert.deepEqual(reads, [{ names: ["mini1"], prune: false, at: AT }], "the console's reader never prunes");
  clock += 14_999;
  await console.snapshot();
  assert.equal(reads.length, 1, "within 15 s the last read is reused");
  clock += 1;
  await console.snapshot();
  assert.equal(reads.length, 2, "and read again after");
  await console.dispose();
  const panel = make(false);
  await panel.snapshot();
  assert.equal(reads[2].prune, true, "the panel's reader prunes the index, as it prunes the registry's");
  await panel.dispose();
});
