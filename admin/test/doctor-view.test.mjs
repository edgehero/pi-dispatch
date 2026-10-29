import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { NAMED_CHECK_IDS } from "@edgehero/pi-dispatch/doctor-results";
import { DOCTOR_FILE_CHECKS, FIRST_RUN_COMMANDS, FIRST_RUN_COMMAND_HINTS, FIRST_RUN_STATES, FIRST_RUN_STEPS, doctorQuote, doctorStale, firstRunCommandHint, firstRunState, stepSentenceText } from "../src/doctor-view.mjs";
import { BEAT_FRESH_MS, configPauseWindows, configSettings, configTriggers, fleetDoctor } from "../src/console/panels.mjs";
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
  const out = render(fleetDoctor, snapshot()).replace(/\s+/g, " ");
  assert.match(out, /<h2>Doctor<\/h2>/);
  assert.match(out, /href="\/fleet\/host\?name=mini1">mini1<\/a>/);
  assert.match(out, /class="tone-failed"/);
  assert.match(out, /Doctor ran 3h 0m ago/);
  assert.match(out, /Worker 4\.3\.1/);
  assert.match(out, /run by the worker: 1 failing, 1 warning, 40 passing/);
  assert.match(out, /The openshell venue was judged/);
  assert.ok(out.indexOf("triggers.file") < out.indexOf("valkey.2"), "failing before warning");
  assert.match(out, /Fix: fix &lt;path&gt; so it loads/);
  assert.doesNotMatch(out, /node\.1/, "an ok check is never listed");
  assert.match(out, /href="\/fleet\/host\?name=build3">build3<\/a>/);
  assert.match(out, /Doctor ran 3d 0h ago/);
  assert.match(out, /Worker 4\.3\.0/);
  assert.match(out, /run by hand \(uid 0\): 0 failing, 0 warnings, 30 passing/);
  assert.match(out, /It replaced the worker's own run/);
  assert.match(out, /uid 1001/);
  assert.match(out, /Stale: older than two of this host's doctor runs \(every 24h\)/);
  assert.match(out, /Every check passed\./);
  assert.match(out, /href="\/fleet\/host\?name=odd">odd<\/a>/);
  assert.match(out, /Its published result cannot be read/);
  assert.match(out, /No doctor result published by: quiet\./, "a live host that never published is named, never read as healthy");
  assert.ok(!out.includes("data-copy"), "a viewer reads fixes as sentences");
  const operator = render(fleetDoctor, snapshot(), "operator");
  assert.ok(operator.includes("data-copy"), "an operator can copy the doctor command");
  for (const fact of ["1 failing, 1 warning, 40 passing", "triggers.file", "Every check passed", "No doctor result published by: quiet"]) assert.ok(operator.includes(fact), `${fact}: published facts are shared by both roles`);
});

test("the console's Doctor panel escapes a hostile label and scrubs its control bytes", () => {
  const out = render(fleetDoctor, snapshot());
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(out, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/);
});

test("the console shows the published cooldown's model, cause, reset and observation age", () => {
  const label = "Model anthropic/primary is cooling down until 2026-10-21T10:00:00.000Z (quota-exhausted)";
  const row = { ...ROWS[0], checks: [{ id: "models.1", level: "warn", label, fix: "new jobs use only the reviewed fallback list" }], counts: { ok: 1, warn: 1, fail: 0 } };
  const out = render(fleetDoctor, snapshot({ hosts: [row], more: 0 }));
  assert.match(out, /Doctor ran 3h 0m ago/);
  assert.ok(out.includes(label));
  assert.match(out, /reviewed fallback list/);
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

// ---- the first run (issue #737) ----------------------------------------------------------------------------------------

const M = 60_000;
/** A deployment that has run nothing: no host row, no trigger, no record, and one host's doctor published. */
const firstRun = (over = {}) => ({
  queue: { counts: {}, workers: 0, fleetDegraded: null },
  hostBudgets: [],
  runs: [],
  runsDay: { runs: [], floor: false, partial: false },
  triggers: { triggers: [] },
  doctor: { hosts: [{ name: "build3", ageMs: 2 * M, counts: { ok: 1, warn: 1, fail: 1 }, checks: [{ id: "egress.proxy", level: "fail", label: "Egress proxy is not on this host (pi-egress-proxy)." }, { id: "provider.key", level: "warn", label: "Provider key not set" }], more: 0 }], more: 0 },
  ...over,
});
const stepOf = (state, id) => state.steps.find((s) => s.id === id);

test("first run: eight steps in doctor's order, each state a status the kit draws", async () => {
  const { STATUS } = await import("../src/console/kit.mjs");
  assert.deepEqual(FIRST_RUN_STEPS, ["deployment", "queue", "token", "worker", "egress", "provider", "trigger", "forge"]);
  for (const [state, { word, status }] of Object.entries(FIRST_RUN_STATES)) assert.ok(Object.hasOwn(STATUS, status) && /^[A-Z][a-z ]+$/.test(word), state);
  const st = firstRunState(firstRun(), { session: { role: "operator" }, deployment: { folder: "pi-dispatch" } });
  assert.deepEqual(st.steps.map((s) => s.id), FIRST_RUN_STEPS);
  assert.equal(st.total, 8);
  assert.deepEqual(st.steps.map((s) => s.state), ["ready", "ready", "ready", "not-yet", "not-yet", "check", "to-do", "optional"]);
  assert.equal(st.ready, 3);
  assert.equal(st.lead, "The console is up. Two steps stand between this deployment and its first job.");
  assert.equal(st.sub, "Jobs start once a worker runs and its egress proxy is up. This page updates as each step is done.");
  assert.deepEqual(st.doctor, { host: "build3", ageMs: 2 * M });
});

test("first run applies only on a read snapshot with no run on record and no host row or no trigger", () => {
  const applies = (snap) => firstRunState(snap).applies;
  assert.equal(applies(firstRun()), true);
  assert.equal(applies(null), false, "a Valkey blink is not a first run");
  assert.equal(applies(firstRun({ runs: [{ jobId: "gh-1" }] })), false, "a run on record");
  assert.equal(applies(firstRun({ runsDay: { runs: [{ jobId: "gh-1" }], floor: false, partial: false } })), false);
  assert.equal(applies(firstRun({ runsDay: null })), false, "an unread day is not an empty one");
  assert.equal(applies(firstRun({ runs: null })), false, "nor an unread list of the newest runs");
  assert.equal(applies(firstRun({ runsDay: { runs: [], floor: false, partial: true } })), false, "nor a partial one");
  assert.equal(applies(firstRun({ hostBudgets: [{ name: "build3", staleMs: 1000 }] })), true, "a host but no trigger");
  assert.equal(applies(firstRun({ triggers: { triggers: [{ type: "cron" }] } })), true, "a trigger but no host");
  assert.equal(applies(firstRun({ hostBudgets: [{ name: "build3", staleMs: 1000 }], triggers: { triggers: [{ type: "cron" }] } })), false, "a host and a trigger: the overview");
  // Every worker gone on a deployment that has run jobs is the overview's "no worker online", never this checklist.
  assert.equal(applies(firstRun({ triggers: { triggers: [{ type: "cron" }] }, runs: [{ jobId: "gh-old" }] })), false);
});

test("first run: the token step reads the session's role only, so a live panel drawn per role never names one session", () => {
  const op = firstRunState(firstRun(), { session: { name: "alice-secret-name", role: "operator" } });
  assert.ok(!JSON.stringify(op).includes("alice-secret-name"));
  assert.equal(stepOf(op, "token").state, "ready");
  assert.deepEqual(stepOf(op, "token").commands, [FIRST_RUN_COMMANDS.token]);
  const viewer = firstRunState(firstRun(), { session: { role: "viewer" } });
  assert.deepEqual(stepOf(viewer, "token").commands, []);
  assert.equal(stepOf(firstRunState(firstRun()), "token").state, "check");
  assert.equal(stepOf(firstRunState(firstRun()), "deployment").state, "check", "no deployment folder said");
  assert.deepEqual(stepOf(firstRunState(firstRun(), { deployment: { folder: "pi-dispatch" } }), "deployment").sentence[1], { code: "pi-dispatch" });
});

test("first run: a worker beats within the console's fresh bound; a registered host that does not is a check", () => {
  const worker = (hosts, workers = 0, fleetDegraded = null) => stepOf(firstRunState(firstRun({ hostBudgets: hosts, queue: { counts: {}, workers, fleetDegraded } })), "worker");
  assert.equal(worker([]).state, "not-yet");
  assert.deepEqual(worker([]).commands, [FIRST_RUN_COMMANDS.service, FIRST_RUN_COMMANDS.worker]);
  assert.equal(worker([{ name: "build3", staleMs: BEAT_FRESH_MS }]).state, "ready");
  // A beat's age is Valkey's where the reader had it: a host whose clock runs behind beats, one Valkey has not refreshed
  // for over a minute does not, whatever their stamps say.
  assert.equal(worker([{ name: "build3", staleMs: 2 * M, ttlAgeMs: 5_000 }]).state, "ready");
  assert.equal(worker([{ name: "build3", staleMs: 5_000, ttlAgeMs: 75_000 }]).state, "check");
  const late = worker([{ name: "build3", staleMs: BEAT_FRESH_MS + 1 }]);
  assert.equal(late.state, "check");
  assert.deepEqual(late.sentence, [{ b: "build3" }, " is registered, but its last beat is ", { age: BEAT_FRESH_MS + 1 }, " old."]);
  assert.equal(worker([], 1).state, "ready", "a worker the queue sees, from before the registry");
  assert.equal(worker([], 0, "registry unreadable").state, "check");
});

test("first run: with no host beating, the worker step names the host that beat last, its age as Valkey measured it", () => {
  const worker = (hosts) => stepOf(firstRunState(firstRun({ hostBudgets: hosts })), "worker");
  // The newest beat among them, not the oldest and not the first row.
  const three = worker([{ name: "old", staleMs: 9 * M, ttlAgeMs: 9 * M }, { name: "new", staleMs: 2 * M, ttlAgeMs: 2 * M }, { name: "mid", staleMs: 5 * M, ttlAgeMs: 5 * M }]);
  assert.equal(three.state, "check");
  assert.deepEqual(three.sentence, [{ b: "new" }, " is registered, but its last beat is ", { age: 2 * M }, " old."]);
  // Where the host's clock and Valkey's disagree, the age is Valkey's measure of the row's last refresh (`beatAgeOf`),
  // and the newest is judged by it too: by its own stamp "skewed" would be the older of the two.
  const skewed = worker([{ name: "skewed", staleMs: 8 * M, ttlAgeMs: 2 * M }, { name: "plain", staleMs: 3 * M, ttlAgeMs: 3 * M }]);
  assert.deepEqual(skewed.sentence, [{ b: "skewed" }, " is registered, but its last beat is ", { age: 2 * M }, " old."]);
  assert.deepEqual(worker([{ name: "build3", staleMs: 5 * M, ttlAgeMs: 2 * M }]).sentence[2], { age: 2 * M });
  // Without Valkey's measure, the host's own stamp.
  assert.deepEqual(worker([{ name: "build3", staleMs: 5 * M, ttlAgeMs: null }]).sentence[2], { age: 5 * M });
});

test("first run: egress and provider take the worst any host published, repeats included; an older doctor is said", () => {
  const rows = (...hosts) => ({ hosts: hosts.map(([name, ageMs, checks]) => ({ name, ageMs, counts: {}, checks, more: 0 })), more: 0 });
  const egressOf = (doctor) => stepOf(firstRunState(firstRun({ doctor })), "egress");
  assert.equal(egressOf(rows(["a", M, [{ id: "egress.proxy", level: "ok" }]])).state, "ready");
  const worst = egressOf(rows(["a", M, [{ id: "egress.proxy", level: "ok" }, { id: "egress.proxy-2", level: "warn", label: "podman: egress proxy is stopping" }]], ["b", 5 * M, [{ id: "egress.proxy", level: "ok" }]]));
  assert.equal(worst.state, "check", "the podman proxy's repeat decides");
  assert.ok(stepSentenceText(worst.sentence).includes("Doctor on a reports a warning: podman: egress proxy is stopping."), "the host whose result judged it");
  assert.deepEqual(worst.commands, [FIRST_RUN_COMMANDS.up]);
  const fail = egressOf(rows(["a", M, [{ id: "egress.proxy", level: "warn", label: "w" }]], ["b", 9 * M, [{ id: "egress.proxy", level: "fail", label: "Egress proxy is not on this host (x)." }]]));
  assert.equal(fail.state, "not-yet");
  assert.ok(stepSentenceText(fail.sentence).startsWith("Doctor on b reports a failing check: Egress proxy is not on this host (x). "), "one period, the label's own dropped");
  const absent = egressOf(rows(["a", M, [{ id: "node.1", level: "ok" }]]));
  assert.equal(absent.state, "check");
  assert.match(stepSentenceText(absent.sentence), /egress may be off there, or its doctor predates the check/);
  assert.equal(egressOf({ hosts: [], more: 0 }).state, "to-do");
  assert.equal(egressOf({ unreachable: "build3.lan" }).state, "to-do", "an unread doctor is no verdict");
  assert.ok(!JSON.stringify(firstRunState(firstRun({ doctor: { unreachable: "build3.lan" } }))).includes("build3.lan"));
  const providerOf = (doctor) => stepOf(firstRunState(firstRun({ doctor })), "provider");
  assert.equal(providerOf(rows(["a", M, [{ id: "provider.key", level: "ok" }]])).state, "ready");
  assert.equal(providerOf(rows(["a", M, [{ id: "provider.key", level: "fail", label: "no key" }]])).state, "not-yet");
  const old = providerOf(rows(["a", M, [{ id: "provider.1", level: "ok" }, { id: "provider.2", level: "ok" }]]));
  assert.equal(old.state, "check");
  assert.equal(stepSentenceText(old.sentence), "Doctor on a checked the provider but not the key by name: its doctor predates the check.");
  assert.equal(stepSentenceText(providerOf(rows(["a", M, [{ id: "node.1", level: "ok" }]])).sentence), "Doctor on a did not judge the provider key.");
});

test("first run: among results of one level the newest host's judges, and a step that is ready offers no command", () => {
  const rows = (...hosts) => ({ hosts: hosts.map(([name, ageMs, checks]) => ({ name, ageMs, counts: {}, checks, more: 0 })), more: 0 });
  const st = firstRunState(firstRun({ doctor: rows(["old", 9 * M, [{ id: "egress.proxy", level: "ok" }, { id: "provider.key", level: "warn", label: "old words" }]], ["new", M, [{ id: "egress.proxy", level: "ok" }, { id: "provider.key", level: "warn", label: "new words" }]]) }));
  assert.equal(stepSentenceText(stepOf(st, "egress").sentence), "Doctor on new found the egress proxy running.");
  assert.ok(stepSentenceText(stepOf(st, "provider").sentence).startsWith("Doctor on new reports a warning: new words. "));
  const ready = firstRunState(firstRun({ doctor: rows(["a", M, [{ id: "egress.proxy", level: "ok" }, { id: "provider.key", level: "ok" }, { id: "github.1", level: "ok" }]]), triggers: { triggers: [{ type: "label", forge: "github" }] } }));
  for (const id of ["egress", "provider", "forge"]) {
    assert.equal(stepOf(ready, id).state, "ready", id);
    assert.deepEqual(stepOf(ready, id).commands, [], `${id}: nothing to run once it is ready`);
  }
});

test("first run: an empty deployment folder is not a found one; an unreadable registry with a trigger is the overview, not the checklist", () => {
  assert.equal(stepOf(firstRunState(firstRun(), { deployment: { folder: "" } }), "deployment").state, "check");
  const blind = firstRun({ triggers: { triggers: [{ type: "cron" }] }, queue: { counts: {}, workers: 0, fleetDegraded: "registry unreadable" } });
  assert.equal(firstRunState(blind).applies, false, "no row read is not no host");
  assert.equal(firstRunState({ ...blind, queue: { counts: {}, workers: 0, fleetDegraded: null } }).applies, true, "a read registry with no row is");
});

test("first run: a check that did not pass is quoted as the check it failed or warned on, never as what doctor says is so", () => {
  const rows = (checks) => ({ hosts: [{ name: "mini1", ageMs: M, counts: {}, checks, more: 0 }], more: 0 });
  const provider = stepOf(firstRunState(firstRun({ doctor: rows([{ id: "provider.key", level: "fail", label: "Provider key set (ANTHROPIC_API_KEY)" }]) })), "provider");
  assert.ok(stepSentenceText(provider.sentence).startsWith("Doctor on mini1 reports a failing check: Provider key set (ANTHROPIC_API_KEY). "));
  const unlabelled = stepOf(firstRunState(firstRun({ doctor: rows([{ id: "egress.proxy", level: "warn" }]) })), "egress");
  assert.ok(stepSentenceText(unlabelled.sentence).startsWith("Doctor on mini1 reports a warning. "));
  for (const st of [provider, unlabelled]) assert.ok(!stepSentenceText(st.sentence).includes(" says"));
});

test("first run: every command with a placeholder has the sentence that fills it", () => {
  for (const [name, argv] of Object.entries(FIRST_RUN_COMMANDS)) {
    const holes = argv.filter((a) => /^<[^>]+>$/.test(a));
    const hint = firstRunCommandHint(argv);
    assert.equal(hint !== null, holes.length > 0, name);
    for (const hole of holes) assert.ok(hint.some((p) => p?.code === hole), `${name}: the hint names ${hole}`);
  }
  assert.ok(FIRST_RUN_COMMAND_HINTS.github.some((p) => p?.code === "--no-webhook"), "and the flag for a deployment with no receiver");
  assert.equal(firstRunCommandHint(["pi-dispatch", "setup", "github", "--webhook-url", "<receiver URL>"]), null, "a copy is no command of the list");
});

test("first run: a step is its id, state, title, sentence and commands; who reads a command is each surface's rule", () => {
  const st = firstRunState(firstRun({ doctor: { hosts: [{ name: "a", ageMs: M, counts: {}, checks: [{ id: "provider.1", level: "ok" }], more: 0 }], more: 0 } }), { session: { role: "operator" } });
  for (const step of st.steps) assert.deepEqual(Object.keys(step), ["id", "state", "title", "sentence", "commands"], step.id);
});

test("first run: the forge step is optional without a forge trigger, else the worst of the github and forges sections", () => {
  const forgeOf = (triggers, checks) => stepOf(firstRunState(firstRun({ triggers: { triggers }, doctor: { hosts: [{ name: "a", ageMs: M, counts: {}, checks, more: 0 }], more: 0 } })), "forge");
  assert.equal(forgeOf([{ type: "cron" }], [{ id: "github.3", level: "fail", label: "x" }]).state, "optional");
  assert.deepEqual(forgeOf([], []).commands, [FIRST_RUN_COMMANDS.github]);
  const label = [{ type: "label", forge: "github" }];
  assert.equal(forgeOf(label, [{ id: "github.1", level: "ok" }, { id: "forges.2", level: "ok" }]).state, "ready");
  assert.equal(forgeOf(label, [{ id: "github.1", level: "ok" }, { id: "forges.2", level: "warn", label: "gitlab token expires soon" }]).state, "check");
  assert.equal(forgeOf(label, [{ id: "github.12-2", level: "fail", label: "no app id" }]).state, "not-yet");
  assert.equal(forgeOf(label, [{ id: "node.1", level: "ok" }]).state, "to-do");
});

test("first run: a trigger file that does not load is not yet; one trigger is ready", () => {
  assert.equal(stepOf(firstRunState(firstRun({ triggers: { invalid: "triggers file is not valid JSON" } })), "trigger").state, "not-yet");
  assert.equal(stepOf(firstRunState(firstRun({ triggers: { missing: true } })), "trigger").state, "to-do");
  assert.deepEqual(stepOf(firstRunState(firstRun({ triggers: { triggers: [{ type: "cron" }] } })), "trigger").sentence, ["The triggers file holds 1 trigger."]);
});

test("first run's commands are the CLIs' own: each is in its usage, and setup github carries what the CLI requires", async () => {
  const { readFileSync } = await import("node:fs");
  const { USAGE } = await import("../src/console/cli.mjs");
  const workerCli = readFileSync(new URL("../../worker/src/cli.mjs", import.meta.url), "utf8");
  const usage = workerCli.slice(workerCli.indexOf("const USAGE = `"), workerCli.indexOf("`;", workerCli.indexOf("const USAGE = `")));
  assert.ok(USAGE.includes("token add --name <name> --role <role>"));
  assert.deepEqual(FIRST_RUN_COMMANDS.token, ["pi-dispatch-console", "token", "add", "--name", "<name>", "--role", "viewer"]);
  assert.match(usage, /pi-dispatch service <render\|install\|/);
  assert.match(usage, /\n {2}pi-dispatch worker {2,}drain the queue/);
  assert.match(usage, /\n {2}pi-dispatch up \[--yes\]/);
  assert.match(usage, /\n {2}pi-dispatch doctor \[--fix\]/);
  assert.match(usage, /pi-dispatch setup github[^]*\(--webhook-url <URL> \| --no-webhook\)/);
  assert.deepEqual(FIRST_RUN_COMMANDS.github.slice(0, 4), ["pi-dispatch", "setup", "github", "--webhook-url"]);
  assert.match(usage, /\/dispatch setup does every step/);
  const panel = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.ok(panel.includes("`/dispatch setup`"), "the pi panel's guided setup");
  assert.deepEqual(FIRST_RUN_COMMANDS.pi, ["/dispatch", "setup"]);
  for (const argv of Object.values(FIRST_RUN_COMMANDS)) assert.ok(Object.isFrozen(argv) && argv.every((a) => typeof a === "string"));
});
