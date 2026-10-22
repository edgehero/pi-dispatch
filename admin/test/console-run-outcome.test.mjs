import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REASONS, SESSION_REASON_TEXT, PLAN_REASON_TEXT } from "@edgehero/pi-dispatch/reason-catalog";
import { CHAT_REFUSALS } from "@edgehero/pi-dispatch/chat-mode";
import { loadPageData, pagePanels, panelIds, renderPage } from "../src/console/pages.mjs";
import { refusedBeforeStart, runOutcome } from "../src/console/panels.mjs";
import { rerunCheckOf, sandboxCheckOf } from "../src/console/run-api.mjs";
import { makeLiveHub } from "../src/console/live.mjs";
import { createFleetReader, fleetQueuesOn, readFleetQueues } from "../src/read-model.mjs";
import { sandboxRetentionOf } from "../src/sandbox-verdict.mjs";
import { RERUN_DATA_KEPT_MS, RERUN_KEPT_SLACK_MS, rerunRefusalOf } from "../src/job-actions.mjs";
import { DOCS_ROOT } from "../src/words.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The run page leads with its outcome and offers only what can work (issue #710, PR 3; REQ-OPERATOR-CONSOLE-SCREENS (c),
// REQ-OPERATOR-CONSOLE-ACTIONS): the outcome banner first, the absent record said once, the panels a refused run never
// had drawn empty, the detail tokens with their catalog sentences, and the sandbox and re-run actions hidden with one
// line where they cannot work.

const NOW = Date.UTC(2026, 9, 8, 15, 39, 8);
const iso = (ms) => new Date(ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

/** A run refused before it started: no tokens, no exit code, and the worker's word that it held no budget slot. */
const REFUSED = { jobId: "gh-r1", kind: "github", target: "acme/web#1", flow: "fix", outcome: "policy", reason: "model-unknown", why: "overlay-link", exitCode: null, tokens: null, budgetReserved: false, backend: "local", startedAt: iso(NOW - 60_000), endedAt: iso(NOW - 59_000) };
/** A completed run on the local venue. */
const COMPLETED = { jobId: "gh-c1", kind: "github", target: "acme/web#2", flow: "fix", outcome: "completed", reason: null, exitCode: 0, tokens: { input: 1, output: 1, total: 2, cost: 0.01 }, budgetReserved: true, backend: "local", startedAt: iso(NOW - 600_000), endedAt: iso(NOW - 300_000), session: { resumed: false, reason: "absent", bytes: 10 }, plan: { outcome: "refused", reason: "plan-stale", planId: null, clamped: false } };

const ctxOf = (role, data, id, readOnly = false) => ({ query: { id }, session: { name: role, role }, data: { now: NOW, env: {}, ...data }, readOnly });
const panelsOf = async (role, data, id) => pagePanels("run", ctxOf(role, data, id));
const joined = (panels) => panels.map((p) => p.html).join("");
const count = (text, needle) => text.split(needle).length - 1;

test("the outcome banner is the run page's first panel", () => {
  assert.equal(panelIds("run")[0], "p-outcome");
});

test("a refused run: the banner says the outcome word, the catalog's sentence for its why, the next step and the docs link; Progress and Chat draw nothing", async () => {
  const chat = { found: false, jobState: null, state: "finished", mode: "fork", says: null };
  for (const role of ["operator", "viewer"]) {
    const panels = await panelsOf(role, { run: { record: REFUSED, source: "local" }, chat, progress: { absent: true }, transcript: { exists: false } }, REFUSED.jobId);
    assert.equal(panels[0].id, "p-outcome");
    const banner = panels[0].html;
    assert.match(banner, /<h2>Outcome<\/h2><p class="big warn">refused<\/p>/, role);
    // `why` picks the catalog's variant (the comment the worker posted), escaped by the template.
    const variant = (await import("@edgehero/pi-dispatch/reason-catalog")).explainReason("model-unknown", { why: "overlay-link" }).sentence;
    assert.notEqual(variant, REASONS["model-unknown"].sentence, "the fixture's why has a variant");
    assert.ok(banner.includes(variant.split("`")[0].replace(/'/g, "&#39;")), `${role}: the why variant`);
    assert.ok(banner.includes("<strong>What to do:</strong>"), role);
    assert.ok(banner.includes(`href="${DOCS_ROOT}docs/reasons.md#model-unknown" rel="noreferrer noopener" target="_blank"`), `${role}: the docs link`);
    const byId = Object.fromEntries(panels.map((p) => [p.id, p.html]));
    assert.equal(byId["p-progress"], "", `${role}: no progress for a run that never started`);
    assert.equal(byId["p-chat"], "", `${role}: no chat either`);
    assert.notEqual(byId["p-run"], "", "the record panels stay");
  }
  assert.equal(refusedBeforeStart(REFUSED), true);
  assert.equal(refusedBeforeStart({ ...REFUSED, budgetReserved: true }), false, "a refusal that kept its slot is not one the fold can tell from a spend");
  assert.equal(refusedBeforeStart({ ...REFUSED, outcome: "failed" }), false, "a failure may be retried under the same id");
  // The page has no transcript section for it either, and the banner comes before every other section.
  const page = (await renderPage("run", ctxOf("operator", { run: { record: REFUSED, source: "local" }, chat, transcript: { exists: false } }, REFUSED.jobId))).html;
  assert.ok(!String(page).includes('id="transcript"'), "no transcript section");
  assert.ok(String(page).indexOf('id="p-outcome"') < String(page).indexOf('id="p-progress"'));
});

test("a run with no record says why ONCE: not a run id, unknown, queued, running; the record panels are empty", async () => {
  const cases = [
    ["bad id", { run: { invalid: "x" } }, "That is not a run id."],
    ["unknown", { run: { missing: true }, chat: { found: false, jobState: null, state: "unknown", mode: null, says: CHAT_REFUSALS.unknown }, progress: { absent: true }, transcript: { exists: false } }, "No run with that id is in this host&#39;s history or the fleet&#39;s run mirror."],
    ["queued", { run: { missing: true }, chat: { found: true, jobState: "waiting", state: "queued", mode: null, says: CHAT_REFUSALS.queued }, progress: { absent: true }, transcript: { exists: false } }, "This job is queued and has not started yet: a run&#39;s record is written when it ends, and its live transcript is on this page once it runs (reload then)."],
    ["running", { run: { missing: true }, chat: { found: true, jobState: "active", state: "active", mode: "live", says: null, activeJobId: "gh-x" }, progress: { absent: true }, transcript: { exists: true } }, "This run has no record yet: a run&#39;s record is written when it ends."],
  ];
  for (const [name, data, sentence] of cases) {
    for (const role of ["operator", "viewer"]) {
      const panels = await panelsOf(role, data, "gh-x");
      const text = joined(panels);
      assert.equal(panels[0].id, "p-outcome", name);
      assert.ok(panels[0].html.includes(sentence), `${name} ${role}: the banner says it`);
      assert.equal(count(text, sentence), 1, `${name} ${role}: once`);
      for (const id of ["p-run", "p-cost", "p-resources", "p-session", "p-chain"]) assert.equal(panels.find((p) => p.id === id).html, "", `${name} ${role}: ${id} is empty`);
      assert.ok(!text.includes(CHAT_REFUSALS.unknown.replace(/'/g, "&#39;")), `${name}: the Chat panel does not say it again`);
      assert.ok(!/No live progress/.test(text) || name === "running", `${name}: the Progress panel does not say it again`);
    }
  }
  // A queued job draws no transcript section (review: its "not started yet" said the banner's sentence again), nor does
  // an unknown one; a running job does. The whole page says "not started" once.
  const pageOf = async (data) => String((await renderPage("run", ctxOf("operator", data, "gh-x"))).html);
  const queued = await pageOf(cases[2][1]);
  assert.ok(!queued.includes('id="transcript"') && !(await pageOf(cases[1][1])).includes('id="transcript"'));
  assert.ok((await pageOf(cases[3][1])).includes('id="transcript"'));
  assert.equal(count(queued, "not started yet"), 1, "the queued page says it once");
  assert.ok(queued.includes("its live transcript is on this page once it runs (reload then)"));
  // ...unless its stream exists or could not be read, which the section then says.
  assert.ok((await pageOf({ ...cases[2][1], transcript: { unreachable: true, exists: false } })).includes('id="transcript"'));
  // The tone: a job that exists and has not ended is a grey note with no outcome word; what the page cannot show is amber.
  const tone = async (data) => (await panelsOf("viewer", data, "gh-x"))[0].html;
  for (const i of [2, 3]) {
    const banner = await tone(cases[i][1]);
    assert.match(banner, /^<h2>Outcome<\/h2><p class="note">/, `${cases[i][0]}: a note`);
    assert.ok(!banner.includes('class="big'), `${cases[i][0]}: no outcome word`);
  }
  for (const i of [0, 1]) assert.match(await tone(cases[i][1]), /^<h2>Outcome<\/h2><p class="warn">/, `${cases[i][0]}: amber`);
});

test("a completed run: its word in the success tone, no reason sentence repeated, and the detail tokens with their catalog sentences", async () => {
  const panels = await panelsOf("viewer", { run: { record: COMPLETED, source: "local" } }, COMPLETED.jobId);
  assert.match(panels[0].html, /<p class="big good">completed<\/p><p>The run finished, and its record names no reason to say more\.<\/p>/);
  const session = panels.find((p) => p.id === "p-session").html;
  const plain = (t) => t.replace(/`/g, "").replace(/'/g, "&#39;");
  assert.ok(session.includes(`<dd>fresh (absent): ${plain(SESSION_REASON_TEXT.absent.sentence)}</dd>`), "fresh (absent) with its sentence");
  assert.ok(session.includes(`<dd>refused (plan-stale): ${plain(PLAN_REASON_TEXT["plan-stale"].sentence)}</dd>`), "the plan reason with its sentence");
  // A token the catalog does not know is kept raw, and says so.
  const odd = await panelsOf("viewer", { run: { record: { ...COMPLETED, session: { resumed: false, reason: "newer-token" }, outcome: "failed", reason: "brand-new-reason" }, source: "local" } }, COMPLETED.jobId);
  assert.ok(odd.find((p) => p.id === "p-session").html.includes("fresh (newer-token): no explanation yet"));
  assert.match(odd[0].html, /<p class="big bad">failed<\/p><p><span class="mono">brand-new-reason<\/span>, no explanation yet\.<\/p>/);
});

test("a parked run: the banner's next step offers the console only where the Chat panel takes the answer (review)", async () => {
  const PARKED = { ...COMPLETED, jobId: "gh-p9", reason: "awaiting-input" };
  const consolePath = "or answer from the console&#39;s run page";
  const reply = { found: true, jobState: "completed", state: "finished", mode: "reply", says: null };
  const page = async (data) => joined(await panelsOf("operator", { run: { record: PARKED, source: "local" }, ...data }, PARKED.jobId));
  const bannerOf = async (data) => (await panelsOf("operator", { run: { record: PARKED, source: "local" }, ...data }, PARKED.jobId))[0].html;
  // The answer can be taken here: the catalog's line, and the form beside it.
  for (const chatAnswer of [{ ok: true }, { unreachable: true }, undefined]) {
    assert.ok((await bannerOf({ chat: reply, chatAnswer })).includes(consolePath), JSON.stringify(chatAnswer));
  }
  // The planner refuses it here (the queue no longer holds the job's data): the Chat panel says so, and the banner agrees.
  const gone = { refusal: "the queue no longer holds gh-p9's data (a forge job's data is kept 31 days)" };
  const refused = await page({ chat: reply, chatAnswer: gone });
  assert.ok(refused.includes("It cannot be answered from here"), "the Chat panel's sentence");
  assert.ok(!refused.includes(consolePath), "the banner no longer offers the console");
  assert.ok(refused.includes("This console cannot take the answer for this run."));
  // A run no longer waiting for a reply (a later run took the answer): no form, so no console path either.
  assert.ok(!(await bannerOf({ chat: { ...reply, mode: "fork" } })).includes(consolePath));
  // Both roles still see the same banner.
  const viewer = (await panelsOf("viewer", { run: { record: PARKED, source: "local" }, chat: reply, chatAnswer: gone }, PARKED.jobId))[0].html;
  assert.equal(viewer, await bannerOf({ chat: reply, chatAnswer: gone }));
});

test("SECURITY: the banner is the same for a viewer and an operator, and never carries a job's free-text failedReason", async () => {
  const data = { run: { record: { ...REFUSED, failedReason: "FREE-TEXT <b>secret</b>" }, source: "local" } };
  const op = runOutcome({ data: { now: NOW, ...data }, role: "operator", now: NOW, query: { id: REFUSED.jobId } });
  const viewer = runOutcome({ data: { now: NOW, ...data }, role: "viewer", now: NOW, query: { id: REFUSED.jobId } });
  assert.equal(String(op), String(viewer));
  assert.ok(!String(op).includes("FREE-TEXT"));
  // An unknown token is cut, and escaped.
  const hostile = String(runOutcome({ data: { now: NOW, run: { record: { ...REFUSED, reason: `<script>${"x".repeat(200)}` } } }, role: "viewer", now: NOW }));
  assert.ok(!hostile.includes("<script>") && hostile.includes("&lt;script&gt;") && hostile.includes("…"));
  // An outcome word this console does not know is cut the same, at 64 code points (an astral one counts once), and escaped.
  const word = `\u{1F600}${"y".repeat(100)}`;
  const outcome = String(runOutcome({ data: { now: NOW, run: { record: { ...REFUSED, outcome: `<i>${word}`, reason: null } } }, role: "viewer", now: NOW }));
  const big = outcome.match(/<p class="big[^"]*">([^<]*)<\/p>/)[1];
  assert.equal(big, `&lt;i&gt;\u{1F600}${"y".repeat(60)}…`, "61 code points of the word after the 3 of <i>, then the ellipsis");
  const short = String(runOutcome({ data: { now: NOW, run: { record: { ...REFUSED, outcome: "rebooted", reason: null } } }, role: "viewer", now: NOW }));
  assert.match(short, /<p class="big[^"]*">rebooted<\/p>/, "a short unknown word whole");
  // The viewer sees no action at all.
  const panels = await panelsOf("viewer", { run: { record: COMPLETED, source: "local" } }, COMPLETED.jobId);
  assert.ok(!joined(panels).includes("Actions") && !joined(panels).includes("data-action"));
});

// ---- the actions ---------------------------------------------------------------------------------------------------------

const summaryOf = async (record, data = {}, { role = "operator", readOnly = false } = {}) => (await pagePanels("run", ctxOf(role, { run: { record, source: "local" }, ...data }, record.jobId, readOnly))).find((p) => p.id === "p-run").html;

test("the sandbox action: hidden with a reason for a venue with no shell, a run refused before it started, and a manifest this host refuses; kept otherwise", async () => {
  const cmd = (id) => `<code class="mono">pi-dispatch sandbox ${id}</code>`;
  assert.ok((await summaryOf(COMPLETED)).includes(cmd(COMPLETED.jobId)), "no check read: the command, as before");
  const os = await summaryOf({ ...COMPLETED, backend: "openshell" });
  assert.ok(!os.includes("pi-dispatch sandbox") && os.includes("Its workspace is not reopenable (openshell has no sandbox shell)."));
  const refused = await summaryOf(REFUSED, { sandboxCheck: { retained: true, why: null } });
  assert.ok(!refused.includes("pi-dispatch sandbox") && refused.includes("No workspace to reopen: the run was refused before it started, so none was made."));
  const by = async (check) => summaryOf(COMPLETED, { sandboxCheck: check });
  assert.ok((await by({ retained: false, why: "swept", reason: "swept" })).includes("Its workspace is no longer kept on this host"));
  assert.ok((await by({ retained: false, why: "retention-off", reason: "retention off" })).includes("PI_SANDBOX_RETENTION_HOURS=0"));
  assert.ok((await by({ retained: false, why: "workspace-gone", reason: "not reopenable (the workspace has moved or been deleted)" })).includes("Its workspace is not reopenable (the workspace has moved or been deleted)."));
  assert.ok((await by({ retained: false, why: "past-window", reason: "x" })).includes(`<code class="mono">pi-dispatch sandbox ${COMPLETED.jobId} --pin</code>`), "past its window: the command with --pin");
  for (const keep of [{ retained: true, why: null }, { elsewhere: true }, { unreachable: true }, { retained: false, why: "policy-unreadable", reason: "x" }]) assert.ok((await by(keep)).includes(cmd(COMPLETED.jobId)), JSON.stringify(keep));
});

test("the re-run action: the form only where rerunRefusalOf (the planner's first step) does not refuse; the reason in its place", async () => {
  const form = 'data-action="rerun"';
  assert.ok((await summaryOf(COMPLETED, { rerunCheck: { ok: true } })).includes(form));
  const cmd = "gh-c1 ran the command /triage, and a /command run is not re-run from the console; it runs from its reviewed trigger";
  const refused = await summaryOf(COMPLETED, { rerunCheck: { refusal: cmd } });
  assert.ok(!refused.includes(form) && refused.includes(`Not offered for a re-run: ${cmd}.`));
  // No check (or an unreadable one): the record alone, which can only infer the data gone past its kind's retention.
  const old = { ...COMPLETED, endedAt: iso(NOW - RERUN_DATA_KEPT_MS.forge - RERUN_KEPT_SLACK_MS - 1000) };
  for (const check of [null, { unreachable: true }]) {
    assert.ok((await summaryOf(old, { rerunCheck: check })).includes("the queue no longer holds gh-c1&#39;s data (a forge job&#39;s data is kept 31 days)"), JSON.stringify(check));
    assert.ok((await summaryOf(COMPLETED, { rerunCheck: check })).includes(form), "within the window: the form");
  }
  // A read-only console or a viewer: neither the form nor the sentence.
  for (const opts of [{ readOnly: true }, { role: "viewer" }]) assert.ok(!(await summaryOf(COMPLETED, { rerunCheck: { refusal: cmd } }, opts)).includes("re-run"), JSON.stringify(opts));
});

test("rerunRefusalOf, table-driven: each cheap refusal, the record-only inference with its slack, and what it leaves to the planner", () => {
  const rec = (over = {}) => ({ jobId: "gh-1", kind: "github", endedAt: iso(NOW - DAY), ...over });
  const forge = { kind: "github", repo: "o/r", target: { type: "issue", number: 1 }, flow: "fix" };
  const rows = [
    ["a bad id", rec({ jobId: "gh <x>" }), forge, "a run id is letters, digits and . _ : -, at most 200 characters"],
    ["data gone (forge)", rec(), null, "the queue no longer holds gh-1's data (a forge job's data is kept 31 days), and the run record cannot rebuild it, so it cannot be re-run from here"],
    ["data gone (local)", rec({ jobId: "local-ab", kind: "local" }), null, "the queue no longer holds local-ab's data (a local job's data is kept 24 hours after it completes and 7 days after it fails), and the run record cannot rebuild it, so it cannot be re-run from here"],
    ["a /command", rec(), { ...forge, flow: undefined, command: "triage" }, "gh-1 ran the command /triage, and a /command run is not re-run from the console; it runs from its reviewed trigger"],
    ["a parked answer", rec(), { ...forge, parkedReply: true }, "gh-1 answered a parked run; answer the parked run again from the parked inbox instead of re-running the answer"],
    ["an unsupported kind", rec({ kind: null }), { kind: "jira" }, "gh-1 is a jira run, which the console cannot re-run"],
    ["a forge run the planner judges", rec(), forge, null],
    ["a local run the planner judges", rec({ jobId: "local-ab", kind: "local" }), { kind: "local", folder: "/x", flow: "f" }, null],
    ["a cron run, rebuilt from its trigger", rec({ jobId: "repeat:nightly:1760500000000", kind: "local" }), null, null],
    ["unread data within the window", rec({ endedAt: iso(NOW - RERUN_DATA_KEPT_MS.forge) }), undefined, null],
    ["unread data within the slack", rec({ endedAt: iso(NOW - RERUN_DATA_KEPT_MS.forge - RERUN_KEPT_SLACK_MS) }), undefined, null],
    ["unread data past it", rec({ endedAt: iso(NOW - RERUN_DATA_KEPT_MS.forge - RERUN_KEPT_SLACK_MS - 1) }), undefined, "the queue no longer holds gh-1's data (a forge job's data is kept 31 days), and the run record cannot rebuild it, so it cannot be re-run from here"],
    ["unread local data past 7 days and the slack", rec({ jobId: "local-ab", kind: "local", endedAt: iso(NOW - RERUN_DATA_KEPT_MS.local - RERUN_KEPT_SLACK_MS - 1) }), undefined, "the queue no longer holds local-ab's data (a local job's data is kept 24 hours after it completes and 7 days after it fails), and the run record cannot rebuild it, so it cannot be re-run from here"],
    // Each window's own edge from inside (review round 1), in LITERAL days so a shortened constant cannot move the
    // fixture with it: a local record within 7 days and a day, and a forge one past that but within 31 days and a day,
    // both offered. Shortening either window refuses one of them.
    ["unread local data within 7 days and a day", rec({ jobId: "local-ab", kind: "local", endedAt: iso(NOW - 8 * DAY) }), undefined, null],
    ["unread forge data past the local window, within 31 days and a day", rec({ endedAt: iso(NOW - 32 * DAY) }), undefined, null],
    // A recovery job (`recoveryOf`) is kept 31 days whatever its kind (recovery-queue.mjs), so a local one is judged by that.
    ["unread local recovery data past 7 days, within 31", rec({ jobId: "local-ab.r1", kind: "local", recoveryOf: "local-ab", endedAt: iso(NOW - 20 * DAY) }), undefined, null],
    ["unread local recovery data within 31 days and a day", rec({ jobId: "local-ab.r1", kind: "local", recoveryOf: "local-ab", endedAt: iso(NOW - 32 * DAY) }), undefined, null],
    ["unread local recovery data past it", rec({ jobId: "local-ab.r1", kind: "local", recoveryOf: "local-ab", endedAt: iso(NOW - RERUN_DATA_KEPT_MS.recovery - RERUN_KEPT_SLACK_MS - 1) }), undefined, "the queue no longer holds local-ab.r1's data (a recovery job's data is kept 31 days), and the run record cannot rebuild it, so it cannot be re-run from here"],
    ["recovery data gone", rec({ jobId: "gh-1.r2", recoveryOf: "gh-1" }), null, "the queue no longer holds gh-1.r2's data (a recovery job's data is kept 31 days), and the run record cannot rebuild it, so it cannot be re-run from here"],
    ["unread data, an unreadable end", rec({ endedAt: "not a date" }), undefined, null],
    ["unread data, a kind with no window", rec({ kind: null, endedAt: iso(NOW - 400 * DAY) }), undefined, null],
    ["unread data never refuses a /command or a parked answer", rec(), undefined, null],
  ];
  for (const [name, record, data, want] of rows) assert.equal(rerunRefusalOf(record, NOW, data), want, name);
});

// ---- the checks through the fleet reader ---------------------------------------------------------------------------------

/** A fleet reader on fakes: one queue whose jobs are `jobs` (id -> data), no Valkey. */
function readerOn({ jobs = {}, paths = {}, env = {}, getJob } = {}) {
  const queue = { name: "pi-jobs", getJob: getJob ?? (async (id) => (Object.hasOwn(jobs, id) ? { id, data: jobs[id] } : null)), close: async () => {} };
  const redis = { on() {}, disconnect() {}, quit: async () => {} };
  return createFleetReader({ valkeyUrl: "redis://unused", logsDir: tempDir("pd-710-logs-"), ...paths }, { makeQueueFn: () => queue, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => ({ names: [], incomplete: null }), nowFn: () => NOW, dollarEnvFn: () => env, sandboxRetentionFn: sandboxRetentionOf });
}

test("the fleet reader's rerunCheck is rerunRefusalOf over the retained data; the data never leaves it", async () => {
  const reader = readerOn({ jobs: { "gh-1": { kind: "github", command: "triage", target: { body: "PII-BODY" } }, "gh-2": { kind: "github", flow: "fix" } } });
  const got = await reader.rerunCheck("gh-1", { jobId: "gh-1", kind: "github" });
  assert.deepEqual(got, { refusal: "gh-1 ran the command /triage, and a /command run is not re-run from the console; it runs from its reviewed trigger" });
  assert.deepEqual(await reader.rerunCheck("gh-2", { jobId: "gh-2", kind: "github" }), { ok: true });
  assert.match((await reader.rerunCheck("gh-3", { jobId: "gh-3", kind: "github" })).refusal, /no longer holds gh-3's data/);
  assert.deepEqual(await reader.rerunCheck("gh <x>", null), { refusal: "a run id is letters, digits and . _ : -, at most 200 characters" });
  const broken = readerOn({ getJob: async () => { throw new Error("ECONNREFUSED"); } });
  assert.deepEqual(await broken.rerunCheck("gh-1", { jobId: "gh-1" }), { unreachable: true });
});

/** A retention root holding one run, written the way `retainJobDir` writes it (sandbox-session.test.mjs's). */
function retainedRoot(jobId, extra = {}) {
  const sandboxDir = tempDir("pd-710-sbx-");
  const workspace = join(sandboxDir, jobId, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(sandboxDir, jobId, "manifest.json"), JSON.stringify({ jobId, kind: "github", image: "pi-job:latest", workspace, createdAt: iso(NOW - 3_600_000), keepUntil: null, backend: "local", ...extra }));
  return sandboxDir;
}

test("the fleet reader's sandboxCheck is the panel's manifest verdict, read only for a run of this host", async () => {
  const sandboxDir = retainedRoot("gh-1");
  const reader = readerOn({ paths: { sandboxDir, sandboxRetentionHours: 24 }, env: { PI_WORKER_NAME: "mini1" } });
  assert.deepEqual(await reader.sandboxCheck("gh-1", { jobId: "gh-1", host: "mini1" }), { retained: true, why: null });
  assert.deepEqual(await reader.sandboxCheck("gh-1", { jobId: "gh-1", host: "mini2" }), { elsewhere: true }, "another host's manifest is not here");
  assert.equal((await reader.sandboxCheck("gh-9", { jobId: "gh-9", host: "mini1" })).why, "swept");
  const off = readerOn({ paths: { sandboxDir, sandboxRetentionHours: 0 }, env: { PI_WORKER_NAME: "mini1" } });
  assert.equal((await off.sandboxCheck("gh-1", { jobId: "gh-1", host: "mini1" })).why, "retention-off");
  const unwired = createFleetReader({ valkeyUrl: "redis://unused", sandboxDir, sandboxRetentionHours: 24 }, { makeQueueFn: () => ({ name: "pi-jobs" }), parseConnectionFn: () => ({}), redisFn: () => ({ on() {} }), dollarEnvFn: () => ({ PI_WORKER_NAME: "mini1" }) });
  assert.deepEqual(await unwired.sandboxCheck("gh-1", { jobId: "gh-1", host: "mini1" }), { elsewhere: true }, "no verdict wired: cannot tell, the command stays");
  // The verdict is the panel's: the same `reason` readSandboxInfo shows (sandbox-session.test.mjs holds those words).
  const past = sandboxRetentionOf({ sandboxDir, sandboxRetentionHours: 1 }, "gh-1", { now: () => NOW + 3_600_000 });
  assert.deepEqual([past.retained, past.why, past.reason], [false, "past-window", "past its window: open it with the CLI's --pin"]);
});

/** A Valkey stand-in for the registry and the keyspace scan: `members` the registry's set, `metas` the queue meta keys. */
function fleetRedis({ members = [], metas = [], scanThrows = false, smembersThrows = false } = {}) {
  return {
    on() {},
    disconnect() {},
    quit: async () => {},
    smembers: async () => {
      if (smembersThrows) throw new Error("ECONNREFUSED");
      return members;
    },
    scan: async () => {
      if (scanThrows) throw new Error("ECONNREFUSED");
      return ["0", metas];
    },
  };
}

/** A fleet reader whose queues are named, each holding `jobs[name]` (id -> data), over `redis`, the real discovery. */
function namedQueueReader(redis, jobs) {
  const asked = [];
  const queueOf = (name) => ({ name, getJob: async (id) => (asked.push(name), Object.hasOwn(jobs[name] ?? {}, id) ? { id, data: jobs[name][id] } : null), close: async () => {} });
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir: tempDir("pd-710-logs-") }, { makeQueueFn: (_c, opts) => queueOf(opts?.name ?? "pi-jobs"), parseConnectionFn: () => ({}), redisFn: () => redis, nowFn: () => NOW, readOnly: true });
  return { reader, asked };
}

test("the retained-job read asks the planner's queues: a host out of the registry still has its queue asked (review round 1)", async () => {
  const redis = fleetRedis({ members: [], metas: ["bull:pi-jobs@mini2:meta"] });
  const { reader, asked } = namedQueueReader(redis, { "pi-jobs@mini2": { "gh-1": { kind: "github", flow: "fix" } } });
  assert.deepEqual(await reader.rerunCheck("gh-1", { jobId: "gh-1", kind: "github", endedAt: iso(NOW - DAY) }), { ok: true }, "found on a host the registry no longer lists: no false refusal");
  // The very set the planner opens (`openFleet` is `readFleetQueues`, which is `fleetQueuesOn`).
  const planner = await readFleetQueues({ url: "redis://unused", redisFn: () => redis });
  assert.deepEqual(planner.names, ["pi-jobs", "pi-jobs@mini2"]);
  assert.deepEqual([...new Set(asked)], planner.names, "the page asked exactly the planner's queues");
  assert.deepEqual((await fleetQueuesOn(redis)).names, planner.names);
  // Not held anywhere, every read whole: the data is gone, said.
  assert.match((await reader.rerunCheck("gh-9", { jobId: "gh-9", kind: "github", endedAt: iso(NOW - DAY) })).refusal, /no longer holds gh-9's data/);
});

test("a degraded queue list makes not-found unreadable, never a refusal, and it is not cached (review round 1)", async () => {
  for (const [name, redis] of [["the registry unread", fleetRedis({ smembersThrows: true })], ["the keyspace scan unread", fleetRedis({ scanThrows: true })]]) {
    const { reader } = namedQueueReader(redis, {});
    const record = { jobId: "gh-9", kind: "github", endedAt: iso(NOW - DAY) };
    assert.deepEqual(await reader.rerunCheck("gh-9", record), { unreachable: true }, name);
    assert.deepEqual(await reader.parkedAnswerCheck("gh-9"), { unreachable: true }, name);
    // Through the page's cache: read again on the next tick, and the record alone decides meanwhile (the form stays).
    let reads = 0;
    const counting = { rerunCheck: async (...a) => ((reads += 1), reader.rerunCheck(...a)) };
    await rerunCheckOf(counting, "gh-9", record, { now: () => NOW });
    await rerunCheckOf(counting, "gh-9", record, { now: () => NOW + 1 });
    assert.equal(reads, 2, `${name}: not cached`);
    assert.ok((await summaryOf({ ...COMPLETED, jobId: "gh-9" }, { rerunCheck: { unreachable: true } })).includes('data-action="rerun"'), `${name}: the form, from the record alone`);
  }
  // The planner's discovery reports the scan's state; the kill switch's list shape reads as complete.
  assert.equal((await fleetQueuesOn(fleetRedis({ scanThrows: true }))).incomplete, "ECONNREFUSED");
  assert.equal((await fleetQueuesOn(fleetRedis(), { discoverFn: async () => ["pi-jobs@a"] })).incomplete, null);
});

test("the console never hides the sandbox command on a venue policy it cannot see: a podman run with no PI_BACKENDS (review round 1)", async () => {
  const sandboxDir = retainedRoot("gh-p1", { backend: "podman" });
  // The console's env as it really is: no PI_BACKENDS (not a key it takes from the deployment's .env, OQ-038).
  const reader = readerOn({ paths: { sandboxDir, sandboxRetentionHours: 24 }, env: { PI_WORKER_NAME: "mini1" } });
  const check = await reader.sandboxCheck("gh-p1", { jobId: "gh-p1", host: "mini1", backend: "podman" });
  assert.deepEqual(check, { retained: true, why: null });
  const page = await summaryOf({ ...COMPLETED, jobId: "gh-p1", backend: "podman" }, { sandboxCheck: check });
  assert.ok(page.includes('<code class="mono">pi-dispatch sandbox gh-p1</code>'), "the command, for the opener's shell to decide");
  // The panel's own verdict, with this process's env, still refuses it there: only the console asks with the policy unknown.
  assert.equal(sandboxRetentionOf({ sandboxDir, sandboxRetentionHours: 24 }, "gh-p1", { now: () => NOW, env: {} }).why, "unblessed");
  // Even a venue-policy word that reached the page keeps the command (the backstop).
  for (const why of ["unblessed", "policy-unreadable", "a-word-added-later"]) {
    assert.ok((await summaryOf({ ...COMPLETED, jobId: "gh-p1", backend: "podman" }, { sandboxCheck: { retained: false, why, reason: "not reopenable here (PI_BACKENDS lacks podman)" } })).includes('<code class="mono">pi-dispatch sandbox gh-p1</code>'), why);
  }
  // What is certain still hides it: a venue with no sandbox shell, whatever any shell blesses.
  const shellless = retainedRoot("gh-o1", { backend: "openshell" });
  const o = await readerOn({ paths: { sandboxDir: shellless, sandboxRetentionHours: 24 }, env: { PI_WORKER_NAME: "mini1" } }).sandboxCheck("gh-o1", { jobId: "gh-o1", host: "mini1" });
  assert.equal(o.why, "venue");
});

test("the checks are reused for 15 s per run id while the record is the same, and an unreadable one is read again", async () => {
  let reads = 0;
  const fleet = { rerunCheck: async () => ((reads += 1), reads === 1 ? { unreachable: true } : { ok: true }), sandboxCheck: async () => ({ retained: true, why: null }) };
  const record = { jobId: "gh-1", endedAt: iso(NOW) };
  assert.deepEqual(await rerunCheckOf(fleet, "gh-1", record, { now: () => NOW }), { unreachable: true });
  assert.deepEqual(await rerunCheckOf(fleet, "gh-1", record, { now: () => NOW + 1 }), { ok: true }, "an unreadable check is not kept");
  assert.deepEqual(await rerunCheckOf(fleet, "gh-1", record, { now: () => NOW + 10_000 }), { ok: true });
  assert.equal(reads, 2, "the second answer is reused within the window");
  await rerunCheckOf(fleet, "gh-1", record, { now: () => NOW + 16_000 });
  assert.equal(reads, 3, "and read again after it");
  assert.equal(await rerunCheckOf({}, "gh-1", record), null, "no reader: null");
  assert.deepEqual(await sandboxCheckOf(fleet, "gh-1", record, { now: () => NOW }), { retained: true, why: null });
});

test("loadPageData reads the action checks for a run with a record, and skips the sandbox check for a run refused before it started", async () => {
  const asked = [];
  const fleet = (record) => ({
    runById: async () => ({ record, source: "local" }),
    runsPage: async () => ({ runs: [], next: null }),
    rerunCheck: async (id) => (asked.push(["rerun", id]), { ok: true }),
    sandboxCheck: async (id) => (asked.push(["sandbox", id]), { retained: true, why: null }),
  });
  const done = await loadPageData("run", { id: "gh-c7" }, { fleet: fleet({ ...COMPLETED, jobId: "gh-c7" }), now: NOW });
  assert.deepEqual([done.rerunCheck, done.sandboxCheck], [{ ok: true }, { retained: true, why: null }]);
  const refused = await loadPageData("run", { id: "gh-r7" }, { fleet: fleet({ ...REFUSED, jobId: "gh-r7" }), now: NOW });
  assert.deepEqual(refused.rerunCheck, { ok: true });
  assert.equal(refused.sandboxCheck, undefined);
  assert.deepEqual(asked, [["rerun", "gh-c7"], ["sandbox", "gh-c7"], ["rerun", "gh-r7"]]);
});

test("live: a panel that becomes empty is swapped in as empty (its section then hidden), and one that fills is swapped back", async () => {
  // The real panels through the hub: a running job with no record, then its record arrives as a refusal before start.
  let data = { page: "run", now: NOW, env: {}, run: { missing: true }, transcript: { exists: true }, progress: { absent: true }, chat: { found: true, jobState: "active", state: "active", mode: "live", says: null, activeJobId: "gh-r1" } };
  const chunks = [];
  const res = { writableLength: 0, write: (t) => (chunks.push(t), true), end() {}, destroy() {} };
  const FILE = { version: 1, generation: 0, tokens: [] };
  const hub = makeLiveHub({
    loadPageData: async () => data,
    pagePanels,
    peekSession: () => ({ id: "s1" }),
    readTokens: () => ({ file: FILE }),
    now: () => NOW,
    timers: { setInterval: () => ({}), clearInterval() {} },
    log() {},
    random: () => Buffer.from("cafebabe", "hex"),
    pageMinMs: {},
  });
  const events = () => [...chunks.splice(0).join("").matchAll(/event: panel\ndata: (.+)\n\n/g)].map(([, d]) => JSON.parse(d));
  hub.subscribe({ res, sessionId: "s1", session: { name: "rob", role: "operator" }, page: "run", query: { id: "gh-r1" } });
  await hub.tick();
  const first = Object.fromEntries(events().map((e) => [e.id, e.html]));
  assert.equal(first["p-run"], "", "no record yet: the record panel is empty");
  assert.match(first["p-progress"], /<h2>Progress<\/h2>/);
  data = { ...data, run: { record: REFUSED, source: "local" }, transcript: { exists: false }, chat: { found: false, jobState: null, state: "finished", mode: "fork", says: null } };
  await hub.tick();
  const next = Object.fromEntries(events().map((e) => [e.id, e.html]));
  assert.equal(next["p-progress"], "", "the progress panel is swapped to empty");
  assert.equal(next["p-chat"], "", "and so is the chat");
  assert.match(next["p-run"], /<h2>Run<\/h2>/, "the record panel fills");
  assert.match(next["p-outcome"], /refused/);
  hub.close?.();
});
