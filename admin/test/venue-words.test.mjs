import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { stripAnsi, visibleLen } from "../src/style.mjs";
import {
  CUSTODY_TEXT,
  LIVE_SKIPPED_TEXT,
  SERVES_TEXT,
  STEER_SKIPPED_TEXT,
  liveAbsentCause,
  progressAbsentText,
  recordSkips,
  sandboxShellRefusal,
  transcriptAbsentText,
  triggerVenue,
  venueCustody,
} from "../src/read-model.mjs";
import { pagePanels } from "../src/console/pages.mjs";
import { runTranscriptSection } from "../src/console/transcript.mjs";
import { BACKEND_NAMES, BACKENDS, CREDENTIAL_CUSTODY, SERVES, SERVES_WORDS } from "../../worker/src/backends.mjs";
import { LIVE_SKIPPED_REASONS, STEER_SKIPPED_REASONS } from "../../worker/src/run-history.mjs";

// Issue #712: the console and the panel say what a venue serves, and why a run went without a feature, in sentences
// keyed by the worker's own tables. Each table is bolted to its source here (AGENTS.md, "derived or pinned"), and an
// openshell run, refused and completed, is rendered on both surfaces with no sentence that is wrong for its venue.

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { makeDashboard } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));

const flush = () => new Promise((resolve) => setImmediate(resolve));
const AT = Date.UTC(2026, 9, 21, 12, 0, 0);

// ---- the bolts -------------------------------------------------------------------------------------------------------

test("every worker reason, serves word and custody has its sentence, and no sentence names a reason that does not exist", () => {
  assert.deepEqual(Object.keys(STEER_SKIPPED_TEXT).sort(), [...STEER_SKIPPED_REASONS].sort(), "a new steer skip must not render as nothing");
  assert.deepEqual(Object.keys(LIVE_SKIPPED_TEXT).sort(), [...LIVE_SKIPPED_REASONS].sort(), "a new live skip must not render as nothing");
  assert.deepEqual(Object.keys(SERVES_TEXT).sort(), [...SERVES].sort(), "a new serves entry must not render as nothing");
  for (const key of SERVES) assert.deepEqual(Object.keys(SERVES_TEXT[key]).sort(), [...SERVES_WORDS].sort(), key);
  assert.deepEqual(Object.keys(CUSTODY_TEXT).sort(), [...CREDENTIAL_CUSTODY].sort(), "a new custody must not render as nothing");
  for (const name of BACKEND_NAMES) {
    for (const key of SERVES) assert.ok(SERVES_TEXT[key][BACKENDS[name].serves[key]].length > 10, `${name}.${key}`);
    assert.equal(venueCustody(name), BACKENDS[name].credentialCustody ?? "container", name);
  }
  assert.equal(venueCustody("far"), null);
});

test("the sandbox refusal follows serves.sandboxShell for every venue, fits the pane, and keeps an unknown venue's own words", () => {
  for (const name of BACKEND_NAMES) {
    const said = sandboxShellRefusal(name);
    assert.equal(said === null, BACKENDS[name].serves.sandboxShell === "yes", name);
    if (said !== null) assert.ok(said.length <= 53, `${name}: ${said}`);
  }
  assert.equal(sandboxShellRefusal("far"), "not reopenable here (ran on far)");
});

test("the absent sentences: a named skip is the cause, a venue that does not stream adds its clause, a streaming venue reads as before", () => {
  assert.deepEqual(recordSkips({ liveSkipped: "no-capability", steerSkipped: "venue-copies" }), { liveSkipped: "no-capability", steerSkipped: "venue-copies" });
  assert.deepEqual(recordSkips({ liveSkipped: "<b>", steerSkipped: 1 }), { liveSkipped: null, steerSkipped: null }, "the closed enums only");
  assert.equal(transcriptAbsentText({ backend: "local" }), "No live transcript: not published (PI_LIVE_TRANSCRIPTS=0), expired, or not started yet.");
  assert.equal(transcriptAbsentText({}), transcriptAbsentText({ backend: "local" }), "a record naming no venue is a local run from before attribution");
  assert.equal(transcriptAbsentText({ backend: "openshell", liveSkipped: "no-capability" }), `No live transcript: ${LIVE_SKIPPED_TEXT["no-capability"]}.`);
  assert.match(transcriptAbsentText({ backend: "openshell" }), /or its venue or job image does not stream it\.$/, "an older openshell record");
  assert.match(transcriptAbsentText(null), /or its venue or job image does not stream it\.$/, "a running job: the venue cannot be named yet");
  assert.match(progressAbsentText({ backend: "openshell", liveSkipped: "venue-copies" }), /^No live progress: it is read from the live transcript, and its venue copies/);
  for (const name of BACKEND_NAMES) assert.equal(liveAbsentCause({ backend: name }) === null, BACKENDS[name].serves.liveTranscript === "yes", name);
});

test("a trigger's venue is its run.backend, else PI_BACKENDS[0], else null", () => {
  assert.equal(triggerVenue("openshell", { PI_BACKENDS: "local" }), "openshell");
  assert.equal(triggerVenue(undefined, { PI_BACKENDS: "openshell,local" }), "openshell");
  assert.equal(triggerVenue(undefined, {}), "local", "unset is the worker's default");
  assert.equal(triggerVenue(undefined, { PI_BACKENDS: "vapour" }), null);
});

// ---- an openshell run on the console -------------------------------------------------------------------------------------

const COMPLETED = { jobId: "gh-os1", kind: "github", target: "acme/web#1", flow: "fix", outcome: "completed", exitCode: 0, backend: "openshell", startedAt: "2026-10-21T10:00:00.000Z", endedAt: "2026-10-21T10:05:00.000Z", steerSkipped: "venue-copies", liveSkipped: "no-capability" };
const REFUSED = { jobId: "gh-os2", kind: "github", target: "acme/web#2", flow: "fix", outcome: "policy", reason: "openshell-recover-unsupported", exitCode: null, backend: "openshell", startedAt: "2026-10-21T10:00:00.000Z", endedAt: "2026-10-21T10:00:01.000Z" };

const ctxOf = (record) => ({ role: "operator", query: { id: record.jobId }, session: { name: "ops", role: "operator" }, data: { now: AT, env: {}, run: { record, source: "local" }, transcript: { exists: false } }, readOnly: false });

test("the console's run page for an openshell run, completed and refused: no sandbox command, and the absences blamed on the venue", async () => {
  for (const record of [COMPLETED, REFUSED]) {
    const ctx = ctxOf(record);
    const page = (await pagePanels("run", ctx)).map((p) => p.html).join("") + String(runTranscriptSection(ctx));
    assert.ok(!page.includes("pi-dispatch sandbox"), `${record.jobId}: no command for a venue with no sandbox shell`);
    assert.ok(page.includes("Its workspace is not reopenable (openshell has no sandbox shell)."), record.jobId);
    assert.ok(!page.includes("expired, or not started yet"), `${record.jobId}: never the switch, the expiry and the start alone`);
  }
  const done = (await pagePanels("run", ctxOf(COMPLETED))).map((p) => p.html).join("");
  assert.match(done, /<dt>Steering<\/dt><dd>skipped \(venue-copies\): its venue copies the job&#39;s files \(no \/inbox mount\) and its job image does not declare steerStdin/);
  assert.match(done, /<dt>Live transcript<\/dt><dd>none \(no-capability\): its venue streams the transcript only from a job image that declares transcriptStderr/);
  assert.match(done, /This run's record holds no progress \(it had no live transcript to read it from: its venue streams/);
  assert.match(String(runTranscriptSection(ctxOf(COMPLETED))), /No live transcript: its venue streams the transcript only from a job image that declares transcriptStderr, and this one does not\. Reload/);
  // The refused run never reached a container, so it names no skip: the venue's clause is one of the causes.
  const refused = (await pagePanels("run", ctxOf(REFUSED))).map((p) => p.html).join("");
  assert.match(refused, /This run's record holds no progress \(an older worker, PI_RUN_PROGRESS=0, or its venue or job image does not stream it\)/);
  assert.ok(!refused.includes("<dt>Steering</dt>") && !refused.includes("<dt>Live transcript</dt>"), "no skip rows for a record that names none");
  // A local run keeps the command and the sentences it always had.
  const local = { ...COMPLETED, jobId: "gh-l1", backend: "local", steerSkipped: undefined, liveSkipped: undefined };
  const localPage = (await pagePanels("run", ctxOf(local))).map((p) => p.html).join("") + String(runTranscriptSection(ctxOf(local)));
  assert.ok(localPage.includes("<code class=\"mono\">pi-dispatch sandbox gh-l1</code>"));
  assert.ok(localPage.includes("expired, or not started yet. Reload"));
});

// ---- an openshell run and trigger on the panel ---------------------------------------------------------------------------

const BASE = {
  queue: { pausedState: false, counts: { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }, workers: 1 },
  budget: { day: 0, week: 0, month: 0 },
  settings: { path: "/s", overlay: {} },
  runs: [],
  stagedPackages: { stagedAt: null, packages: [] },
};

async function render(snap, width, keys = []) {
  const comp = makeDashboard({ paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000, deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT } });
  await flush();
  for (const k of keys) {
    comp.handleInput(k);
    await flush();
  }
  const lines = comp.render(width);
  await comp.dispose();
  return lines;
}

test("the panel's RUN_DETAIL for an openshell run says why it went without steering and a live transcript, inside the frame", async () => {
  const got = (await render({ ...BASE, triggers: { triggers: [] }, runs: [COMPLETED] }, 80, ["\r"])).map(stripAnsi).join("\n").replace(/[│ ]+\n[│ ]*/g, " ");
  assert.match(got, /steering\s+skipped \(venue-copies\): its venue copies/);
  assert.match(got, /live\s+no transcript \(no-capability\): its venue streams the/);
  const refused = (await render({ ...BASE, triggers: { triggers: [] }, runs: [REFUSED] }, 80, ["\r"])).map(stripAnsi).join("\n");
  assert.ok(!/steering\s+skipped|no transcript \(/.test(refused), "no skip lines for a record that names none");
  for (const width of [30, 40, 60, 80, 120]) for (const l of await render({ ...BASE, triggers: { triggers: [] }, runs: [COMPLETED] }, width, ["\r"])) assert.ok(visibleLen(l) <= width, `width ${width}: ${JSON.stringify(stripAnsi(l))}`);
});

const SECRETS_TRIGGER = { type: "label", any: ["bug"], all: [], none: [], flow: "fix", forge: "github", packages: false, secrets: 2, secretsProfile: "prod", index: 0 };
const trustText = (lines) => lines.map((l) => stripAnsi(l).trim().replace(/^│|│$/g, "").trim()).join(" ");

test("the panel's secrets disclosure follows the custody of the trigger's venue: its run.backend, else PI_BACKENDS[0]", async () => {
  const open = async (trigger, defaultBackend) => trustText(await render({ ...BASE, triggers: { triggers: [trigger] }, ...(defaultBackend !== undefined ? { defaultBackend } : {}) }, 80, ["\r"]));
  const layer = CUSTODY_TEXT.layer.replace(/\s+/g, " ");
  const container = CUSTODY_TEXT.container;
  const named = await open({ ...SECRETS_TRIGGER, backend: "openshell" }, "local");
  assert.ok(named.includes(layer) && !named.includes("the agent can read them"), named);
  const byDefault = await open(SECRETS_TRIGGER, "openshell");
  assert.ok(byDefault.includes(layer) && !byDefault.includes("the agent can read them"), "a trigger naming no venue runs on PI_BACKENDS[0]");
  assert.ok((await open(SECRETS_TRIGGER, "local")).includes(container));
  assert.ok((await open({ ...SECRETS_TRIGGER, backend: "local" }, "openshell")).includes(container), "the trigger's own venue wins");
  assert.ok((await open(SECRETS_TRIGGER, null)).includes(container), "a venue the panel cannot name keeps the wider claim");
});

test("the panel offers t and T only while the run's inbox is open, and says why when an armed run takes no message", async () => {
  const armed = (open) => ({ ...BASE, triggers: { triggers: [] }, activeJobId: "gh-A", active: [{ jobId: "gh-A", steer: true, ...(open === undefined ? {} : { steerOpen: open }) }] });
  for (const open of [false, null, undefined]) {
    const shown = (await render(armed(open), 120)).map(stripAnsi).join("\n");
    assert.match(shown, /ACTIVE gh-A running .*· x cancel/, String(open));
    assert.doesNotMatch(shown, /t steer/, `${open}: no steer keys for an inbox that is not open`);
  }
  assert.match((await render(armed(true), 120)).map(stripAnsi).join("\n"), /· x cancel · t steer · T follow-up/);
  const comp = makeDashboard({ paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000, deps: { fetchSnapshot: async () => armed(false), pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT, planSteer: async () => ({ refusal: "x" }), steer: async () => ({}) } });
  await flush();
  comp.handleInput("t");
  await flush();
  const after = comp.render(160).map(stripAnsi).join("\n");
  assert.match(after, /inbox closed: not started, ended, or venue can't deliver/);
  assert.doesNotMatch(after, /steer gh-A:/, "no input opened");
  for (const width of [60, 80]) assert.match(comp.render(width).map(stripAnsi).join("\n"), /inbox closed: not started, ended, or venue can't deliver/, `the whole cause at ${width} columns`);
  await comp.dispose();
});
