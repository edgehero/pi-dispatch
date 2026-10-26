import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFER_BUCKETS, DEFER_BUCKET_WORDS, DEFER_TIME_MAX_MS, DEFER_WHYS } from "@edgehero/pi-dispatch/defer-reasons";
import { HOST_SKEW_CLAIM_MS } from "@edgehero/pi-dispatch/host-registry";
import {
  COUNT_WINDOWS_UTC_TEXT, DAY_FLOOR_TEXT, FREE_SLOT_TEXT, HOSTS_EMPTY, HOST_NO_EXPIRY_TEXT, NEEDS_DEFINITION, NEEDS_EMPTY,
  NEEDS_ROWS_MAX, NEEDS_UNKNOWN_PROJECT_TEXT, NO_DOCTOR_TEXT, NO_WORKER_TEXT, OVERVIEW_LINKS, OVERVIEW_UNREAD_TEXT,
  REGISTRY_UNREAD_TEXT, RUNNING_EMPTY, SOFT_HOLD_REFUSED_TEXT, SOFT_HOLD_TEXT, SPEND_EMPTY, SPEND_HOURS_TEXT,
  STALE_BEATS_TEXT, WAITING_EMPTY, WAITING_MAIN_BUCKETS, WAITING_UNKNOWN_PROJECT_TEXT, WAITLISTS_CALM, WAITLIST_ROWS_MAX,
  hostSkewText, overviewActive, overviewCaps, overviewHeadline, overviewHosts, overviewNeeds, overviewSetup,
  overviewSetupEmpty, overviewSetupPi, overviewSpend, overviewTimeline, overviewWaiting, overviewWaitlists,
  JOBS_UNREAD_TEXT, JOBS_UNREAD_WORDS, NOT_BEATING_WORDS, SPEND_SUM_TEXT, WAITING_CUT_TEXT, waitingSentence,
  CAPS_EMPTY_TEXT, LAST_SEEN_WORDS,
} from "../src/console/panels/overview.mjs";
import { BEAT_FRESH_MS } from "../src/console/panels/common.mjs";
import { schedulerRunOf } from "../src/console/kit.mjs";
import { waitingLine } from "../src/console/actions.mjs";
import { PAGES } from "../src/console/pages.mjs";
import { FIRST_RUN_COMMANDS } from "../src/doctor-view.mjs";
import { NO_EXPLANATION } from "../src/words.mjs";

/**
 * The overview's panels (issue #737: the OverviewScreen, OverviewAllClear, OverviewPhone, SetupScreen,
 * TimelineAndWaitlists, Status and CardsAndBanners cards), each renderer called with a canned view at a fixed instant:
 * nothing here reads a Valkey or the wall clock. The kit's marks (`slots`, `capsule`, `spendDots`, `waitBar`, `rowPill`,
 * `actForm`) and the timeline's markup are pinned in their own tests; here, what each panel puts in them and around
 * them, for both roles.
 */

const NOW = Date.UTC(2026, 9, 8, 15, 39, 8);
const M = 60_000;
const H = 60 * M;
const at = (hh, mm) => Date.UTC(2026, 9, 8, hh, mm, 0);

const RUNS = [
  { jobId: "gh-f0c2", kind: "github", target: "acme/web#433", project: "web", host: "mini1", outcome: "failed", reason: null, startedAt: at(15, 6), endedAt: at(15, 10), parentJobId: null },
  { jobId: "gh-2f6a", kind: "github", target: "acme/api#12", project: "api", host: "mini1", outcome: "completed", reason: "awaiting-input", startedAt: at(14, 52), endedAt: at(15, 13), parentJobId: null },
  { jobId: "gh-5d10", kind: "github", target: "acme/api#9", project: "api", host: "mini2", outcome: "failed", reason: null, startedAt: at(14, 40), endedAt: at(14, 49), parentJobId: null },
  { jobId: "gh-9575", kind: "github", target: "acme/web#490", project: "web", host: "mini1", outcome: "completed", reason: null, startedAt: at(14, 35), endedAt: at(14, 57), parentJobId: null },
];

function row(o) {
  return { queue: "pi-jobs", state: "delayed", why: null, known: false, dueAt: NOW + M, queuedAt: NOW - 10 * M, recordedAt: null, untilAt: null, project: null, projectFrom: null, host: null, holder: null, endpoint: null, budgetWhy: null, trigger: null, attempt: null, attempts: null, attemptsMade: 0, stalled: 0, kind: "github", recovery: false, schedulerNext: false, held: null, ...o };
}

const WAITING = [
  row({ jobId: "gh-c9e1", bucket: "slot", why: "host-slot", known: true, project: "billing", host: "build3", queuedAt: NOW - 40 * M }),
  row({ jobId: "gh-d4f0", bucket: "run", why: "chained", known: true, project: "web", holder: "gh-b3d7" }),
  row({ jobId: "gh-77c1", bucket: "check", why: "wait-after", known: true, project: "web", untilAt: Date.UTC(2026, 9, 9, 7, 0), dueAt: Date.UTC(2026, 9, 9, 7, 0), queuedAt: NOW - (2 * H + 14 * M), trigger: 2, held: { since: NOW - (2 * H + 14 * M), label: "after x + ci", checks: 4, after: null, answers: [{ profile: "ci-green", answer: "hold", at: NOW - 3 * M }] } }),
  row({ jobId: "gh-71b2", bucket: "retry", why: "retry", known: true, project: "api", attempt: 2, attempts: 3, attemptsMade: 1, untilAt: NOW + 4 * M }),
  row({ jobId: "local-aa01", bucket: "pause", why: "pause-window", known: true, project: "ops", untilAt: at(20, 0) }),
  row({ jobId: "gh-bb02", bucket: "ready", why: "podman-restart", known: true, host: "build3" }),
  row({ jobId: "gh-cc03", bucket: "paused", state: "paused", queue: "pi-jobs@mini2" }),
  row({ jobId: "gh-ff06", bucket: "due", why: "host-slot", known: true, host: "build3", project: "api", dueAt: NOW - 3 * M }),
  row({ jobId: `repeat:nightly-tidy:${at(15, 30)}`, bucket: "due", kind: "local", schedulerNext: true, dueAt: at(15, 30), queuedAt: at(15, 30) }),
  row({ jobId: "gh-ee05", bucket: "unknown", why: "brand-new-why", known: false }),
  row({ jobId: "gh-dd04", bucket: "none" }),
];

function waitingOf(rows, extra = {}) {
  const byBucket = Object.fromEntries(DEFER_BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b).length]));
  return { at: NOW, rows, scheduled: [], byBucket, byQueue: [{ queue: "pi-jobs", inLine: rows.length, scheduled: 0, truncated: false }], truncated: false, ...extra };
}

function snapshot(over = {}) {
  return {
    queue: { pausedState: false, pausedPartial: false, counts: { waiting: 1, active: 4, delayed: 8, failed: 1 }, workers: 3, queues: 4, fleetDegraded: null },
    queueCounts: [
      { queue: "pi-jobs", paused: false, counts: { waiting: 1, delayed: 8 } },
      { queue: "pi-jobs@build3", paused: false, counts: { active: 1 } },
      { queue: "pi-jobs@mini1", paused: false, counts: { active: 2 } },
      { queue: "pi-jobs@mini2", paused: true, counts: { active: 1, paused: 1 } },
    ],
    hostBudgets: [
      { name: "build3", concurrency: "3", jobs: [{ id: "gh-4a7e", p: "billing", at: at(10, 30), o: true }, { id: "gh-e802", p: "billing", at: at(13, 39), o: false }], jobsMore: 0, staleMs: 10_000, ttlAgeMs: 5_000, skewMs: 5_000, noExpiry: false, backends: { blessed: ["podman"] } },
      { name: "mini1", concurrency: "4", jobs: [{ id: "gh-c41f", p: "web", at: at(14, 50), o: false }, { id: "gh-b3d7", p: "web", at: at(15, 27), o: false }], jobsMore: 0, staleMs: 22_000, ttlAgeMs: 8_000, skewMs: 14_000, noExpiry: false, backends: { blessed: ["local"] } },
      { name: "mini2", concurrency: "2", jobs: [{ id: "local-9e20", p: "ops", at: at(15, 33), o: false }], jobsMore: 0, staleMs: 22_000, ttlAgeMs: null, skewMs: null, noExpiry: false, backends: { blessed: ["local", "openshell"] } },
    ],
    active: [
      { jobId: "gh-e802", queue: "pi-jobs@build3", startedAt: at(13, 39), host: "build3" },
      { jobId: "gh-c41f", queue: "pi-jobs@mini1", startedAt: at(14, 50), host: "mini1" },
      { jobId: "gh-b3d7", queue: "pi-jobs@mini1", startedAt: at(15, 27), host: "mini1" },
      { jobId: "local-9e20", queue: "pi-jobs@mini2", startedAt: at(15, 33), host: "mini2" },
    ],
    budget: { day: 25, week: 165, month: 168, tokensToday: 3_120_000 },
    settings: { overlay: { dailyCap: 40, weeklyCap: 200, monthlyCap: 600, dailyTokenCap: 8_000_000, softHoldPct: 80 } },
    dollars: { rows: [
      { ledger: "deployment", name: null, window: "day", capMicros: 25_000_000, counterMicros: 15_040_000, full: false },
      { ledger: "scope", name: "project:web", window: "week", capMicros: 40_000_000, counterMicros: 10_400_000, full: false },
      { ledger: "model", name: "claude-sonnet-5-5", window: "week", capMicros: 60_000_000, counterMicros: 24_600_000, full: false },
    ] },
    spendByHour: { hours: Array.from({ length: 24 }, (_, i) => (i > 15 ? null : i >= 9 ? 400_000 * (i - 8) : 0)), unpriced: 1, floor: false, partial: false },
    softHoldToday: { count: 3, floor: false, partial: false },
    parked: [{ target: "acme/api#12", kind: "github", jobId: "gh-2f6a", parkedAt: at(15, 13), ageMs: NOW - at(15, 13), answered: false, chainCount: null, answering: false }],
    parkedUnreachable: null,
    failures24h: 2,
    refusals24h: { count: 1, top: [{ reason: "scope-cap", count: 1 }] },
    failures24hFloor: false,
    failed: { rows: [{ jobId: "gh-5d10", attemptsMade: 3, failedReason: "REASON-TEXT <b>", queue: "pi-jobs", endedAt: NOW - 50 * M, reason: null }], more: 0 },
    doctor: { hosts: [
      { name: "build3", ageMs: 72 * H, at: NOW - 72 * H, version: "4.3.1", openshell: false, every: 24, by: { uid: 1001, worker: true }, counts: { ok: 30, warn: 0, fail: 1 }, checks: [{ id: "docker.3", level: "fail", label: "Docker daemon unreachable" }], more: 0 },
      { name: "mini1", ageMs: 3 * H, at: NOW - 3 * H, version: "4.3.1", openshell: false, every: 24, by: { uid: 1001, worker: true }, counts: { ok: 40, warn: 1, fail: 0 }, checks: [{ id: "valkey.2", level: "warn", label: "another account also listens" }], more: 0 },
    ], more: 0 },
    runsDay: { runs: RUNS, floor: false, partial: false },
    runs: RUNS.map((r) => ({ ...r, startedAt: new Date(r.startedAt).toISOString(), endedAt: new Date(r.endedAt).toISOString() })),
    waiting: waitingOf(WAITING),
    schedulers: [{ key: "nightly-tidy", name: "local", pattern: "0 3 * * *", next: Date.UTC(2026, 9, 9, 3, 0), overdueMs: 0 }],
    triggers: { triggers: [{ type: "cron", id: "nightly-tidy", folder: "/srv/site", index: 0 }, { type: "label", forge: "github", index: 1 }] },
    ...over,
  };
}

const viewOf = (snap, { role = "operator", readOnly = false, query = {}, pages = undefined, deployment = { folder: "pi-dispatch" } } = {}) => ({ page: "overview", data: { now: NOW, snapshot: snap, deployment }, role, readOnly, query, env: {}, now: NOW, ...(pages === undefined ? {} : { pages }) });
const draw = (render, snap, opts) => String(render(viewOf(snap, opts)));

/** A sentence as a page holds it: `html` escapes its quote. */
const esc = (text) => text.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const EIGHT = [overviewNeeds, overviewWaiting, overviewActive, overviewSpend, overviewTimeline, overviewCaps, overviewWaitlists, overviewHosts];
const SETUP = [overviewSetup, overviewSetupPi, overviewSetupEmpty];

// ---- the frame of the rules -------------------------------------------------------------------------------------------

test("the overview links to its pages by PAGES' names: the copy of their paths is PAGES' own", () => {
  for (const [name, { path }] of Object.entries(OVERVIEW_LINKS)) assert.equal(PAGES[name]?.path, path, name);
});

test("every sentence is plain: no em dash, no emoji, no control byte", () => {
  const all = [COUNT_WINDOWS_UTC_TEXT, DAY_FLOOR_TEXT, FREE_SLOT_TEXT, HOST_NO_EXPIRY_TEXT, NEEDS_DEFINITION, NEEDS_UNKNOWN_PROJECT_TEXT, NO_DOCTOR_TEXT, NO_WORKER_TEXT, OVERVIEW_UNREAD_TEXT, REGISTRY_UNREAD_TEXT, SOFT_HOLD_REFUSED_TEXT, SOFT_HOLD_TEXT, SPEND_HOURS_TEXT, SPEND_SUM_TEXT, STALE_BEATS_TEXT, WAITING_CUT_TEXT, WAITING_UNKNOWN_PROJECT_TEXT, WAITLISTS_CALM, JOBS_UNREAD_TEXT, JOBS_UNREAD_WORDS, NOT_BEATING_WORDS, CAPS_EMPTY_TEXT, LAST_SEEN_WORDS, ...[NEEDS_EMPTY, WAITING_EMPTY, RUNNING_EMPTY, SPEND_EMPTY, HOSTS_EMPTY].flatMap((e) => [e.title, e.body])];
  for (const s of all) assert.match(s, /^[\x20-\x7e]+$/, s);
});

test("no snapshot: the eight say the one fixed sentence, the setup draws nothing, and the headline says Valkey was not read", () => {
  for (const render of EIGHT) assert.ok(draw(render, null).includes(esc(OVERVIEW_UNREAD_TEXT)), render.name);
  for (const render of SETUP) assert.equal(draw(render, null), "");
  assert.match(String(overviewHeadline(viewOf(null))), /^Valkey could not be read/);
});

test("no panel carries inline style, script or a handler, and every one is a card, never a section: the page draws each panel's section", () => {
  for (const role of ["operator", "viewer"]) {
    for (const render of EIGHT) {
      const out = draw(render, snapshot(), { role });
      assert.doesNotMatch(out, /<script|<style|\sstyle=|\son[a-z]+=|javascript:/i, render.name);
      assert.match(out, /^<div class="card">/, render.name);
      assert.doesNotMatch(out, /<section/, render.name);
    }
  }
});

// ---- the headline ----------------------------------------------------------------------------------------------------

/** Nothing needs the person and the day had no failure or refusal: All clear, on the card and in the headline. */
const CALM = { parked: [], failed: { rows: [], more: 0 }, doctor: { hosts: [], more: 0 }, failures24h: 0, refusals24h: { count: 0, top: [] } };

/** Each read Needs you rests on, failed, with a reader's message that names a host (never drawn). */
const LOST = Object.freeze({
  parked: { parked: [], parkedUnreachable: "connect ECONNREFUSED build3.lan:6379" },
  failed: { failed: { unreachable: "build3.lan said no" } },
  doctor: { doctor: { unreachable: "timeout at build3.lan" } },
  // The host registry, with no worker the queue sees connected: whether one is online is not known either.
  registry: { queue: { pausedState: false, pausedPartial: false, counts: {}, workers: 0, queues: 4, fleetDegraded: "registry unreadable at build3.lan" } },
});

/** Needs you's line for the host registry it could not read, with no worker the queue sees connected, and with one. */
const REGISTRY_UNREAD_NO_WORKER = "The host registry could not be read and the queue sees no worker connected, so failing doctors are not counted and whether a worker is online is not known.";
const REGISTRY_UNREAD_SEEN = "The host registry could not be read, so failing doctors are not counted.";

test("the headline counts what needs the person, or says All clear, or on a first run how many steps remain", () => {
  assert.equal(String(overviewHeadline(viewOf(snapshot()))), "Needs you: 1 question and 2 to fix. 4 jobs running.");
  const calm = snapshot(CALM);
  assert.equal(String(overviewHeadline(viewOf(calm))), "All clear. 4 jobs running, nothing needs you.");
  assert.equal(String(overviewHeadline(viewOf({ ...calm, active: [] }))), "All clear. Nothing is running, nothing needs you.");
  // Nothing to answer or fix, but the day had failures: no All clear, as Needs you draws none over them.
  assert.equal(String(overviewHeadline(viewOf({ ...calm, failures24h: 2 }))), "Nothing needs you. 4 jobs running.");
  // A job to fix and no question: the headline names what is to fix.
  assert.equal(String(overviewHeadline(viewOf({ ...calm, failed: { rows: [{ jobId: "gh-f1", queue: "pi-jobs" }], more: 0 } }))), "Needs you: 1 to fix. 4 jobs running.");
  const fresh = snapshot({ hostBudgets: [], runs: [], runsDay: { runs: [], floor: false, partial: false }, triggers: { triggers: [] }, doctor: { hosts: [], more: 0 }, queue: { counts: {}, workers: 0 } });
  assert.match(String(overviewHeadline(viewOf(fresh))), /^The console is up\. (One|Two|Three) steps? stands? between this deployment and its first job\.$/);
});

test("the headline and Needs you say All clear by one rule: never over the day's failures, refusals, a floor or an unread day", () => {
  const calm = snapshot(CALM);
  const both = (snap) => [String(overviewHeadline(viewOf(snap))), draw(overviewNeeds, snap)];
  const [head, card] = both(calm);
  assert.ok(head.startsWith("All clear.") && card.includes("<b>All clear</b>"));
  for (const day of [{ failures24h: 1 }, { refusals24h: { count: 1, top: [] } }, { failures24hFloor: true }, { failures24h: null, refusals24h: null }]) {
    const [h, c] = both({ ...calm, ...day });
    assert.ok(!h.includes("All clear") && !c.includes("All clear"), JSON.stringify(day));
  }
  // A floor that holds no failure or refusal is the one day with no count to show: the card says why it is no All clear.
  assert.ok(draw(overviewNeeds, { ...calm, failures24hFloor: true }).includes(DAY_FLOOR_TEXT));
});

test("with any read behind Needs you failed, neither the headline nor the card says All clear or 0: each says what was not read", () => {
  const calm = snapshot(CALM);
  // Which of the card's two numbers each read stands behind: the questions the parked runs, to fix the other three (the
  // registry holds the hosts whose failing doctor is one to fix).
  const behind = { parked: ["questions"], failed: ["to fix"], doctor: ["to fix"], registry: ["to fix"] };
  const cases = [...Object.entries(LOST).map(([key, over]) => [[key], over]), [Object.keys(LOST), Object.assign({}, ...Object.values(LOST))]];
  for (const [keys, over] of cases) {
    for (const role of ["operator", "viewer"]) {
      const snap = { ...calm, ...over };
      const what = `${keys.join(", ")}, ${role}`;
      const head = String(overviewHeadline(viewOf(snap, { role })));
      const card = draw(overviewNeeds, snap, { role });
      assert.ok(!/all clear|nothing needs you/i.test(head), `${what}: ${head}`);
      assert.ok(!card.includes("All clear") && !card.includes(NEEDS_EMPTY.title) && !card.includes("<b>0</b>"), `${what}: no All clear and no 0 on the card`);
      for (const label of new Set(keys.flatMap((k) => behind[k]))) assert.ok(card.includes(`<span class="big__n">-</span><span class="big__l">${label}: not known</span>`), `${what}: ${label} not known, never 0`);
      assert.ok(!head.includes("build3.lan") && !card.includes("build3.lan"), `${what}: a reader's message is never drawn`);
    }
  }
  // A number whose reads were all made is still a count, 0 included: the doctor results and the failed jobs were read.
  assert.ok(draw(overviewNeeds, { ...calm, ...LOST.parked }).includes('<span class="big__n">0</span><span class="big__l">to fix</span>'));
  assert.equal(String(overviewHeadline(viewOf({ ...calm, ...LOST.parked }))), "The parked runs could not be read, so what needs you is not known. 4 jobs running.");
  assert.equal(String(overviewHeadline(viewOf({ ...calm, ...LOST.failed, ...LOST.doctor }))), "The failed jobs and the doctor results could not be read, so what needs you is not known. 4 jobs running.");
  assert.equal(String(overviewHeadline(viewOf({ ...calm, ...LOST.parked, ...LOST.failed, ...LOST.doctor }))), "The parked runs, the failed jobs and the doctor results could not be read, so what needs you is not known. 4 jobs running.");
  // What was read is counted, and what was not may add to it: build3's failing doctor is read, the failed jobs are not.
  const part = { ...snapshot(), ...LOST.failed };
  assert.equal(String(overviewHeadline(viewOf(part))), "Needs you: 1 question and 1 to fix. The failed jobs could not be read, so more may need you. 4 jobs running.");
  const partCard = draw(overviewNeeds, part);
  assert.match(partCard, /<span class="big__n">1<\/span><span class="big__l">question<\/span>/);
  assert.match(partCard, /<span class="big__n">1<\/span><span class="big__l">or more to fix<\/span>/, "a floor in the label, the number alone");
  const none = draw(overviewNeeds, { ...calm, ...LOST.parked, ...LOST.failed, ...LOST.doctor });
  assert.match(none, /<span class="big__n">-<\/span><span class="big__l">questions: not known<\/span>/);
  assert.match(none, /<span class="big__n">-<\/span><span class="big__l">to fix: not known<\/span>/);
  // A snapshot without one of the fields was not read either, never an empty list.
  assert.ok(!draw(overviewNeeds, { ...calm, failed: undefined }).includes("All clear"));
  assert.ok(!String(overviewHeadline(viewOf({ ...calm, doctor: null }))).includes("All clear"));
});

test("no worker online is no All clear: the headline leads with it and Needs you draws no 0 and no All clear beside it", () => {
  // An established deployment (runs on record, a trigger) whose every worker is gone, with jobs in line.
  const quiet = { ...CALM, hostBudgets: snapshot().hostBudgets.map((h) => ({ ...h, staleMs: 5 * M, ttlAgeMs: 5 * M })), queue: { ...snapshot().queue, workers: 0 }, active: [] };
  for (const over of [quiet, { ...quiet, hostBudgets: [] }]) {
    const snap = snapshot(over);
    assert.equal(String(overviewHeadline(viewOf(snap))), `${NO_WORKER_TEXT} Nothing is running.`);
    const card = draw(overviewNeeds, snap);
    assert.ok(!card.includes("All clear") && !card.includes(NEEDS_EMPTY.title) && card.includes(NO_WORKER_TEXT));
    assert.match(card, /<span class="big__n">0<\/span><span class="big__l">questions<\/span>/, "what was read is still counted");
  }
  assert.equal(String(overviewHeadline(viewOf(snapshot({ ...quiet, failed: { rows: [{ jobId: "gh-f1", queue: "pi-jobs" }], more: 0 } })))), `${NO_WORKER_TEXT} Needs you: 1 to fix. Nothing is running.`);
  // The queue still sees a worker connected (a clock behind, say): the hosts card's softer note, and All clear may stand.
  assert.ok(String(overviewHeadline(viewOf(snapshot({ ...quiet, queue: { ...snapshot().queue, workers: 1 } })))).startsWith("All clear."));
});

test("a host registry that could not be read is no All clear and no whole to fix, whatever BullMQ sees: the headline names it", () => {
  const blind = { ...snapshot(CALM), ...LOST.registry };
  assert.equal(String(overviewHeadline(viewOf(blind))), "The host registry could not be read, so what needs you is not known. 4 jobs running.");
  const card = draw(overviewNeeds, blind);
  assert.ok(!card.includes("All clear") && !card.includes(NEEDS_EMPTY.title) && card.includes(REGISTRY_UNREAD_NO_WORKER));
  // The questions stand on the parked runs alone, read and empty: a count. To fix counts the registry's hosts whose
  // doctor fails, and the registry was not read: not known, never 0.
  assert.match(card, /<span class="big__n">0<\/span><span class="big__l">questions<\/span>/);
  assert.match(card, /<span class="big__n">-<\/span><span class="big__l">to fix: not known<\/span>/);
  assert.equal(String(overviewHeadline(viewOf({ ...blind, failed: { rows: [{ jobId: "gh-f1", queue: "pi-jobs" }], more: 0 } }))), "Needs you: 1 to fix. The host registry could not be read, so more may need you. 4 jobs running.");
  assert.match(draw(overviewNeeds, { ...blind, failed: { rows: [{ jobId: "gh-f1", queue: "pi-jobs" }], more: 0 } }), /<span class="big__n">1<\/span><span class="big__l">or more to fix<\/span>/, "what was read, a floor");
  // BullMQ's own list sees a worker: that one is online is known, and that is all it says. The registry is still not
  // read, so a registered host's failing doctor (mini1's here, the rows last seen) is neither counted nor All clear.
  const doctor = { hosts: [{ name: "mini1", ageMs: H, counts: { ok: 1, warn: 0, fail: 2 }, checks: [{ id: "docker.1", level: "fail", label: "Docker daemon unreachable" }], more: 0 }], more: 0 };
  for (const seen of [{ ...blind, queue: { ...blind.queue, workers: 2 } }, { ...blind, queue: { ...blind.queue, workers: 2 }, doctor }, { ...blind, queue: { ...blind.queue, workers: 3 }, doctor, hostBudgets: [] }]) {
    const head = String(overviewHeadline(viewOf(seen)));
    const seenCard = draw(overviewNeeds, seen);
    assert.equal(head, "The host registry could not be read, so what needs you is not known. 4 jobs running.");
    assert.ok(!seenCard.includes("All clear") && !seenCard.includes(NEEDS_EMPTY.title), "no All clear and no 0 over the unread registry");
    assert.match(seenCard, /<span class="big__n">-<\/span><span class="big__l">to fix: not known<\/span>/);
    assert.ok(seenCard.includes(REGISTRY_UNREAD_SEEN) && !seenCard.includes(REGISTRY_UNREAD_NO_WORKER) && !seenCard.includes(NO_WORKER_TEXT), "a worker is online, and only the doctors go uncounted");
    assert.ok(!seenCard.includes("<span>doctor fails</span>"), "no failing host's row drawn from a registry not read");
  }
  // Read again, the same failing doctor is one to fix.
  assert.equal(String(overviewHeadline(viewOf({ ...snapshot(CALM), doctor }))), "Needs you: 1 to fix. 4 jobs running.");
});

test("Needs you counts a failing doctor only of a host in the registry: a gone host's record outlives it", () => {
  const doctor = { hosts: [{ name: "gone1", ageMs: H, counts: { ok: 1, warn: 0, fail: 2 }, checks: [{ id: "docker.1", level: "fail", label: "Docker daemon unreachable" }], more: 0 }], more: 0 };
  const snap = snapshot({ ...CALM, doctor });
  assert.ok(String(overviewHeadline(viewOf(snap))).startsWith("All clear."));
  assert.ok(!draw(overviewNeeds, snap).includes("gone1"));
  const live = snapshot({ ...CALM, doctor: { ...doctor, hosts: [{ ...doctor.hosts[0], name: "mini1" }] } });
  assert.equal(String(overviewHeadline(viewOf(live))), "Needs you: 1 to fix. 4 jobs running.");
});

// ---- Needs you -------------------------------------------------------------------------------------------------------

test("Needs you: questions, failed jobs and failing doctors, each with its project and one action; the day's failures as the foot", () => {
  const op = draw(overviewNeeds, snapshot());
  assert.match(op, /<h2>Needs you<\/h2>/);
  assert.match(op, /<span class="big__n">1<\/span><span class="big__l">question<\/span>/);
  assert.match(op, /<span class="big__n">2<\/span><span class="big__l">to fix<\/span>/);
  // The question: its project from its record, its id, Answer on its run page.
  assert.match(op, /<li class="rowpill tone-parked">.*?<span class="ptag">api<\/span><span class="code">gh-2f6a<\/span><a class="rowpill__act" href="\/run\?id=gh-2f6a">Answer<\/a><\/li>/);
  // The failed job: Retry, a paid write, with the fields the action reads; never BullMQ's text.
  assert.match(op, /<form class="act" data-action="retry-failed" autocomplete="off"><input type="hidden" name="jobId" value="gh-5d10"><input type="hidden" name="queue" value="pi-jobs"><button class="btn btn--sm btn--paid" type="submit">Retry<\/button><\/form>/);
  assert.ok(!op.includes("REASON-TEXT"));
  // The failing doctor: the host, Open on Fleet (no host page yet).
  assert.match(op, /<b title="build3">build3<\/b><span>doctor fails<\/span><a class="rowpill__act" href="\/fleet">Open<\/a>/, "the host's name whole in its title, as a long one gives way to the row's words");
  assert.match(op, /Last 24 hours: <a href="\/runs\?outcome=failed">2 failed<\/a> and <a href="\/runs\?outcome=policy">1 refused<\/a>, not counting runs an operator cancelled\./);
  assert.ok(op.includes(NEEDS_DEFINITION));
  // A viewer: the same counts and ids, no write, no Answer.
  const viewer = draw(overviewNeeds, snapshot(), { role: "viewer" });
  assert.ok(!viewer.includes("data-action") && !viewer.includes(">Answer<"));
  assert.match(viewer, /<a class="rowpill__act" href="\/run\?id=gh-2f6a">Open<\/a>/);
  assert.match(viewer, /<a class="rowpill__act" href="\/run\?id=gh-5d10">Open<\/a>/);
  // A read-only console: an operator reads, and writes nothing; a question is Open there, since its run page's Chat
  // panel takes no answer on a console that takes no change.
  const ro = draw(overviewNeeds, snapshot(), { readOnly: true });
  assert.ok(!ro.includes("data-action") && !ro.includes(">Answer<"));
  assert.match(ro, /<a class="rowpill__act" href="\/run\?id=gh-2f6a">Open<\/a>/);
  // A host page, once PAGES has one, is where the doctor row goes.
  const pages = { ...OVERVIEW_LINKS, host: { path: "/fleet/host" } };
  assert.match(draw(overviewNeeds, snapshot(), { pages }), /href="\/fleet\/host\?name=build3">Open</);
});

test("Needs you: at most four rows and the rest counted; one being answered is said, not counted; a floor says at least", () => {
  const parked = ["gh-p1", "gh-p2", "gh-p3", "gh-p4", "gh-p5"].map((jobId, i) => ({ target: `acme/api#${i}`, kind: "github", jobId, parkedAt: NOW - i * M, answered: false, answering: false }));
  parked.push({ target: "acme/api#9", kind: "github", jobId: "gh-p6", parkedAt: NOW, answered: false, answering: "gh-ans" });
  const out = draw(overviewNeeds, snapshot({ parked, failures24hFloor: true }));
  assert.equal((out.match(/<li class="rowpill/g) ?? []).length, NEEDS_ROWS_MAX);
  assert.match(out, /<span class="big__n">5<\/span><span class="big__l">questions<\/span>/);
  assert.match(out, /And 3 more: see <a href="\/parked">Parked<\/a> and <a href="\/fleet">Fleet<\/a>\./);
  assert.match(out, /1 more question is being answered now\./);
  assert.match(out, />at least 2 failed</);
});

test("Needs you: the failed jobs past the list's bound count to fix and in the rest", () => {
  const snap = snapshot({ ...CALM, failed: { rows: [{ jobId: "gh-f1", queue: "pi-jobs" }], more: 5 } });
  assert.equal(String(overviewHeadline(viewOf(snap))), "Needs you: 6 to fix. 4 jobs running.");
  const out = draw(overviewNeeds, snap);
  assert.match(out, /<span class="big__n">6<\/span><span class="big__l">to fix<\/span>/);
  assert.match(out, /And 5 more: see <a href="\/parked">Parked<\/a>/, "the five the list does not hold are the rest");
});

test("Needs you: a job's row carries its project where a run record names it, and a row without one is said once", () => {
  const out = draw(overviewNeeds, snapshot());
  assert.match(out, /<span class="ptag">api<\/span><span class="code">gh-5d10<\/span>/, "a failed job's project from its record");
  assert.ok(!out.includes(NEEDS_UNKNOWN_PROJECT_TEXT), "every row has its tag");
  const failed = { rows: [{ jobId: "gh-zz99", queue: "pi-jobs" }, { jobId: "gh-5d10", queue: "pi-jobs" }], more: 0 };
  for (const role of ["operator", "viewer"]) {
    const untagged = draw(overviewNeeds, snapshot({ failed }), { role });
    assert.match(untagged, /<li class="rowpill tone-failed">.*?<span class="code">gh-zz99<\/span>/);
    assert.equal(untagged.split(NEEDS_UNKNOWN_PROJECT_TEXT).length, 2, `${role}: said once`);
  }
  // A row past the four shown is not one the line speaks of.
  const parked = ["gh-p1", "gh-p2", "gh-p3", "gh-p4"].map((jobId) => ({ target: "acme/api#1", kind: "github", jobId, answered: false, answering: false }));
  const runs = parked.map((p) => ({ ...RUNS[1], jobId: p.jobId }));
  assert.ok(!draw(overviewNeeds, snapshot({ parked, runs, failed: { rows: [{ jobId: "gh-zz99", queue: "pi-jobs" }], more: 0 } })).includes(NEEDS_UNKNOWN_PROJECT_TEXT));
});

test("Needs you: all clear only when its sentence is true; a read that failed is a fixed sentence, never its message", () => {
  const calm = snapshot({ parked: [], failed: { rows: [], more: 0 }, doctor: { hosts: [], more: 0 }, failures24h: 0, refusals24h: { count: 0, top: [] } });
  const clear = draw(overviewNeeds, calm);
  assert.match(clear, /<p class="kpi"><b>0<\/b><span>nothing needs you<\/span><\/p>/);
  assert.ok(clear.includes(`<b>All clear</b><span>${NEEDS_EMPTY.body}</span>`));
  // The definition is of the two numbers, so it is drawn with them and not under the empty state (OverviewAllClear).
  assert.ok(!clear.includes(NEEDS_DEFINITION), "no definition under 0");
  // Nothing to fix, but the day had a failure: no "All clear" over it.
  const day = draw(overviewNeeds, { ...calm, failures24h: 1 });
  assert.ok(!day.includes("All clear") && day.includes("1 failed"));
  // A park already answered is no question; a doctor result that cannot be read is no failing host, whatever it counts.
  assert.ok(draw(overviewNeeds, { ...calm, parked: [{ target: "acme/api#1", kind: "github", jobId: "gh-p1", answered: true, answering: false }] }).includes("<b>All clear</b>"));
  assert.ok(draw(overviewNeeds, { ...calm, doctor: { hosts: [{ name: "build3", unreadable: true, counts: { fail: 2 } }], more: 0 } }).includes("<b>All clear</b>"));
  // A failed job whose queue is not known gets no Retry (the action reads the queue), and still its run's page.
  const noQueue = draw(overviewNeeds, { ...calm, failed: { rows: [{ jobId: "gh-f1", queue: null }], more: 0 } });
  assert.ok(!noQueue.includes("retry-failed") && noQueue.includes('href="/run?id=gh-f1">Open<'));
  const lost = draw(overviewNeeds, { ...calm, parkedUnreachable: "connect ECONNREFUSED build3.lan:6379", failed: { unreachable: "build3.lan said no" }, doctor: { unreachable: "timeout at build3.lan" } });
  assert.ok(!lost.includes("build3.lan") && !lost.includes("All clear"));
  assert.match(lost, /The parked runs could not be read/);
  assert.match(lost, /The failed jobs could not be read/);
  assert.match(lost, /The doctor results could not be read/);
});

// ---- In line ---------------------------------------------------------------------------------------------------------

test("In line: how many wait, the oldest's age, and the count of each reason, the four main ones always", () => {
  const out = draw(overviewWaiting, snapshot());
  assert.match(out, /<span class="chip">longest 2h 14m<\/span>/);
  assert.match(out, /<p class="kpi"><b>11<\/b><span>jobs waiting to start<\/span><\/p>/);
  // Every bucket with a job, in the leaf's order: the reader's own two (due, unknown) beside the worker's.
  const shorts = [...out.matchAll(/<li class="rowpill">.*?<span>([^<]+)<\/span><span class="end">/g)].map((m) => m[1]);
  assert.deepEqual(shorts, DEFER_BUCKETS.map((b) => DEFER_BUCKET_WORDS[b].short));
  assert.match(out, /<span>Due, not taken<\/span><span class="end"><b>2<\/b><\/span>/);
  assert.match(out, /<span>Unknown reason<\/span><span class="end"><b>1<\/b><\/span>/);
  assert.match(out, /<span>No reason recorded<\/span><span class="end"><b>1<\/b><\/span>/, "a reason recorded is not counted as none");
  const one = draw(overviewWaiting, snapshot({ waiting: waitingOf([WAITING[3]]) }));
  assert.match(one, /<b>1<\/b><span>job waiting to start<\/span>/);
  for (const b of WAITING_MAIN_BUCKETS) assert.ok(one.includes(`<span>${DEFER_BUCKET_WORDS[b].short}</span>`), b);
  assert.ok(!one.includes(DEFER_BUCKET_WORDS.pause.short), "a reason with no job is not listed beyond the main four");
  assert.match(draw(overviewWaiting, snapshot({ waiting: waitingOf([]) })), /<b>0<\/b><span>nothing is waiting<\/span>/);
  // A floor is said in the label, the big number a count alone; a cut read that found no job is not "nothing is waiting".
  const floor = draw(overviewWaiting, snapshot({ waiting: waitingOf(WAITING, { truncated: true }) }));
  assert.match(floor, /<p class="kpi"><b>11<\/b><span>or more jobs waiting to start<\/span><\/p>/);
  assert.ok(!floor.includes("at least"));
  // A read cut before it found a job: a dash and "not known", as Needs you writes a number nothing was read for, and why;
  // never "0 or more", which says nothing.
  const cut = draw(overviewWaiting, snapshot({ waiting: waitingOf([], { truncated: true, queuesCut: 2 }) }));
  assert.match(cut, /<p class="kpi"><b>-<\/b><span>jobs waiting: not known<\/span><\/p>/);
  assert.ok(cut.includes(`<p class="card__sub">${WAITING_CUT_TEXT}</p>`) && !cut.includes("or more") && !cut.includes(WAITING_EMPTY.title));
  // Every cut read says why its numbers are floors, in the one cut sentence, whichever the cut was.
  assert.ok(floor.includes(`<p class="card__sub">${WAITING_CUT_TEXT}</p>`), "a cut read that found jobs says the cut too");
  assert.ok(!out.includes(WAITING_CUT_TEXT), "a whole read does not");
  const lost = draw(overviewWaiting, snapshot({ waiting: { unreachable: true } }));
  assert.ok(lost.includes("The waiting jobs could not be read."));
  // A bucket this console does not know is counted under none, so the counts add up to the total.
  assert.match(draw(overviewWaiting, snapshot({ waiting: waitingOf([row({ jobId: "gh-z", bucket: "zzz" })]) })), /<span>No reason recorded<\/span><span class="end"><b>1<\/b><\/span>/);
});

test("In line under a cut read: every number a floor, each reason's count N or more or a dash, never a whole count", () => {
  const ends = (out) => Object.fromEntries([...out.matchAll(/<li class="rowpill">.*?<span>([^<]+)<\/span><span class="end">(.*?)<\/span><\/li>/g)].map((m) => [m[1], m[2]]));
  const short = (b) => DEFER_BUCKET_WORDS[b].short;
  // Found jobs, then cut (at the queue bound, or inside a queue: one rule for both).
  for (const extra of [{ truncated: true, queuesCut: 2 }, { truncated: true, queuesCut: 0 }]) {
    const out = draw(overviewWaiting, snapshot({ waiting: waitingOf([WAITING[0], WAITING[0], WAITING[3]], extra) }));
    const got = ends(out);
    assert.equal(got[short("slot")], "<b>2</b> or more", JSON.stringify(extra));
    assert.equal(got[short("retry")], "<b>1</b> or more");
    for (const b of ["run", "check"]) assert.equal(got[short(b)], "<b>-</b>", `${b}: none found, so not a 0`);
    assert.ok(!Object.values(got).some((e) => /^<b>\d+<\/b>$/.test(e)), "no reason row draws a whole count");
    // The oldest job read has waited 40 minutes; one the read did not reach may have waited longer.
    assert.match(out, /<span class="chip">longest 40m or more<\/span>/);
  }
  // Cut before it found any: every row a dash, no chip (no job's age was read), never four whole 0s.
  const none = ends(draw(overviewWaiting, snapshot({ waiting: waitingOf([], { truncated: true, queuesCut: 3 }) })));
  assert.deepEqual(Object.values(none), WAITING_MAIN_BUCKETS.map(() => "<b>-</b>"));
  assert.ok(!draw(overviewWaiting, snapshot({ waiting: waitingOf([], { truncated: true }) })).includes("longest"));
  // A whole read keeps its whole counts, 0 included, and its chip says the age alone.
  const whole = draw(overviewWaiting, snapshot({ waiting: waitingOf([WAITING[0]]) }));
  assert.equal(ends(whole)[short("run")], "<b>0</b>");
  assert.match(whole, /<span class="chip">longest 40m<\/span>/);
});

// ---- Running ---------------------------------------------------------------------------------------------------------

test("Running: the jobs running in the slots used of all, and per host its dots with the held slot called out", () => {
  const out = draw(overviewActive, snapshot());
  assert.match(out, /<span class="chip tone-running">.*live<\/span>/);
  assert.match(out, /<p class="kpi"><b>4<\/b><span>in 5 of 9 slots<\/span><\/p>/);
  assert.match(out, /<b title="build3">build3<\/b><span class="sls" role="img" aria-label="build3: 1 running, 1 held, 1 free">/, "the host's name whole in its title");
  assert.match(out, /<span class="end tinted tone-attention"><b class="tinted">1 held<\/b><\/span>/);
  assert.match(out, /<span class="end faint">2 free<\/span>/);
  const none = draw(overviewActive, snapshot({ hostBudgets: [], active: [] }));
  assert.match(none, /<b>0<\/b><span>nothing is running<\/span>/);
  assert.ok(none.includes(HOSTS_EMPTY.body) && !none.includes("live"));
});

test("Running: the label follows the count of jobs, so jobs with no host row run and say their slots are not published", () => {
  const active = snapshot().active.slice(0, 2);
  const out = draw(overviewActive, snapshot({ hostBudgets: [], active }));
  assert.match(out, /<p class="kpi"><b>2<\/b><span>jobs running, slots not published<\/span><\/p>/);
  assert.ok(!out.includes(RUNNING_EMPTY.title));
  assert.match(draw(overviewActive, snapshot({ hostBudgets: [], active: active.slice(0, 1) })), /<b>1<\/b><span>job running, slots not published<\/span>/);
  // A registry that could not be read holds no row this tick: it says so, never that no host is registered.
  const blind = draw(overviewActive, snapshot({ hostBudgets: [], active, queue: { ...snapshot().queue, fleetDegraded: "registry unreadable" } }));
  assert.ok(blind.includes(REGISTRY_UNREAD_TEXT) && !blind.includes(HOSTS_EMPTY.body));
});

test("Running: a host's jobs past the registry's list count as running slots; one host with no slot count leaves the total unknown", () => {
  const more = draw(overviewActive, snapshot({ hostBudgets: [{ name: "build3", concurrency: "8", jobs: [{ id: "gh-1", at: NOW - M, o: false }], jobsMore: 3, staleMs: 1000 }] }));
  assert.match(more, /in 4 of 8 slots/);
  assert.match(more, /aria-label="build3: 4 running, 0 held, 4 free"/);
  const some = draw(overviewActive, snapshot({ hostBudgets: [{ name: "a", concurrency: "2", jobs: [], staleMs: 1 }, { name: "b", jobs: [{ id: "gh-1", at: NOW, o: false }], staleMs: 1 }] }));
  assert.match(some, /<span>in 1 slot<\/span>/, "no total, never the sum of the hosts that publish one");
  assert.match(some, /<span class="end faint">slots not published<\/span>/);
});

test("a host whose running jobs could not be read has no slot drawn free: no dots, its words, and Running's slots a floor", () => {
  const hosts = snapshot().hostBudgets.map((h) => (h.name === "mini1" ? { ...h, jobs: null, jobsMore: null, jobsUnreadable: true } : h));
  const running = draw(overviewActive, snapshot({ hostBudgets: hosts }));
  assert.match(running, /<b title="mini1">mini1<\/b><span class="sls" role="img" aria-label="mini1: running jobs unreadable"><\/span><span class="end tinted tone-attention"><b class="tinted">running jobs unreadable<\/b><\/span>/);
  assert.match(running, /<p class="kpi"><b>4<\/b><span>in 3 or more slots<\/span><\/p>/, "build3's 2 and mini2's 1, the rest not known, and no total");
  const card = draw(overviewHosts, snapshot({ hostBudgets: hosts }));
  assert.ok(card.includes('aria-label="mini1: running jobs unreadable"></span>') && card.includes(JOBS_UNREAD_TEXT));
  assert.ok(!card.includes("mini1: 0 running"));
});

test("Running: a host that has not beaten within the minute has no slot drawn free: no dots, not beating, its slots out of the total", () => {
  const late = snapshot().hostBudgets.map((h) => (h.name === "mini1" ? { ...h, staleMs: BEAT_FRESH_MS + 1, ttlAgeMs: BEAT_FRESH_MS + 1 } : h));
  const out = draw(overviewActive, snapshot({ hostBudgets: late }));
  assert.match(out, /<b title="mini1">mini1<\/b><span class="sls" role="img" aria-label="mini1: not beating"><\/span><span class="end tinted tone-attention"><b class="tinted">not beating<\/b><\/span>/);
  assert.match(out, /<p class="kpi"><b>4<\/b><span>in 3 or more slots<\/span><\/p>/, "build3's 2 and mini2's 1, and no total");
  // A host whose clock runs behind beats when Valkey refreshed its row, whatever its own stamp says: its slots are drawn.
  const skewed = snapshot().hostBudgets.map((h) => (h.name === "mini1" ? { ...h, staleMs: 2 * M, ttlAgeMs: 9_000, skewMs: 111_000 } : h));
  assert.ok(!draw(overviewActive, snapshot({ hostBudgets: skewed })).includes('aria-label="mini1: not beating"'), "a skewed host beats");
  assert.ok(!String(overviewHeadline(viewOf(snapshot({ ...CALM, hostBudgets: skewed.map((h) => (h.name === "mini1" ? h : { ...h, staleMs: 5 * M, ttlAgeMs: 5 * M })) })))).startsWith(NO_WORKER_TEXT), "a skewed host is a worker online");
  // A beat exactly a minute old still beats; a row with no beat readable does not.
  assert.ok(!draw(overviewActive, snapshot({ hostBudgets: snapshot().hostBudgets.map((h) => ({ ...h, staleMs: BEAT_FRESH_MS, ttlAgeMs: BEAT_FRESH_MS })) })).includes(NOT_BEATING_WORDS));
  assert.ok(draw(overviewActive, snapshot({ hostBudgets: snapshot().hostBudgets.map((h, i) => (i === 0 ? { ...h, staleMs: null, ttlAgeMs: null } : h)) })).includes('aria-label="build3: not beating"'));
  // One that does not beat and whose running jobs could not be read: Running says the first, Hosts still says the second.
  const both = snapshot({ hostBudgets: late.map((h) => (h.name === "mini1" ? { ...h, jobs: null, jobsUnreadable: true } : h)) });
  assert.ok(draw(overviewActive, both).includes('aria-label="mini1: not beating"') && draw(overviewHosts, both).includes(JOBS_UNREAD_TEXT));
  // No host beats and the queue sees no worker: the headline says no worker is online, and no card draws a slot free.
  const gone = snapshot({ ...CALM, active: [], queue: { ...snapshot().queue, workers: 0 }, hostBudgets: snapshot().hostBudgets.map((h) => ({ ...h, staleMs: 5 * M, ttlAgeMs: 5 * M })) });
  assert.ok(String(overviewHeadline(viewOf(gone))).startsWith(NO_WORKER_TEXT));
  for (const [what, render] of [["Running", overviewActive], ["Hosts", overviewHosts]]) {
    const card = draw(render, gone);
    assert.ok(!/\d+ free/.test(card) && !card.includes('<i class="sl"></i>'), `${what}: no slot free`);
  }
  // A floor of no slot says nothing: the count's own words.
  assert.match(draw(overviewActive, gone), /<b>0<\/b><span>nothing is running<\/span>/);
  assert.match(draw(overviewActive, { ...gone, active: snapshot().active.slice(0, 1) }), /<b>1<\/b><span>job running, slots not known<\/span>/);
  // A host that does not beat has its list of running jobs read all the same: its Hosts row never says that list could
  // not be read, which only a host whose list was not read says.
  const lateHosts = draw(overviewHosts, snapshot({ hostBudgets: late }));
  assert.ok(lateHosts.includes('aria-label="mini1: not beating"') && !lateHosts.includes(JOBS_UNREAD_TEXT), "not beating is not unread");
});

test("Running: the rows of a registry that could not be read are as last seen: no slot drawn free from them, and said so", () => {
  // The rows last read, fresh then (their ages are as old as that read): this tick's registry read failed.
  const blind = snapshot({ queue: { ...snapshot().queue, fleetDegraded: "registry unreadable" } });
  const out = draw(overviewActive, blind);
  for (const name of ["build3", "mini1", "mini2"]) {
    assert.ok(out.includes(`<b title="${name}">${name}</b><span class="sls" role="img" aria-label="${name}: ${LAST_SEEN_WORDS}"></span><span class="end tinted tone-attention"><b class="tinted">${LAST_SEEN_WORDS}</b></span>`), `${name}: no dots, its words`);
  }
  assert.ok(!/\d+ free/.test(out) && !out.includes('<i class="sl"></i>') && !out.includes("held"), "no slot drawn free, and none held");
  assert.match(out, /<p class="kpi"><b>4<\/b><span>jobs running, slots not known<\/span><\/p>/, "the count's own words, no total");
  assert.ok(out.includes(`<p class="card__sub">${REGISTRY_UNREAD_TEXT}</p>`), "the card says the registry was not read");
  // The Hosts card draws the same slots by the same rule, beside its own line.
  const hosts = draw(overviewHosts, blind);
  assert.ok(hosts.includes(`aria-label="build3: ${LAST_SEEN_WORDS}"></span>`) && !/\d+ free/.test(hosts) && hosts.includes(REGISTRY_UNREAD_TEXT));
  // Read again, the same rows draw their slots.
  assert.match(draw(overviewActive, snapshot()), /<span>in 5 of 9 slots<\/span>/);
  assert.ok(!draw(overviewActive, snapshot()).includes(REGISTRY_UNREAD_TEXT));
});

// ---- Spend today -----------------------------------------------------------------------------------------------------

test("Spend today: the day window's spent and held of its cap, the hours' settled spend as dots, said under them", () => {
  const out = draw(overviewSpend, snapshot());
  assert.match(out, /<span class="chip tone-ok">60% of cap<\/span>/);
  assert.match(out, /<p class="kpi"><b><data value="15040000" title="\$15\.04">\$15\.04<\/data><\/b><span>of <span title="\$25\.00">\$25\.00<\/span><\/span><\/p>/);
  assert.equal((out.match(/class="sd__c"/g) ?? []).length, 16, "one column per hour of the UTC day so far");
  assert.ok(out.includes(esc(SPEND_HOURS_TEXT)) && out.includes("1 run today carries no settled amount."));
  const full = draw(overviewSpend, snapshot({ dollars: { rows: [{ ledger: "deployment", name: null, window: "day", capMicros: 25_000_000, counterMicros: 24_000_000, full: true }] } }));
  assert.match(full, /<span class="chip tone-failed">96% of cap<\/span>/);
  const plain = draw(overviewSpend, snapshot({ dollars: null }));
  assert.match(plain, /<b><data value="\d+" title="\$[\d.]+">\$[\d.]+<\/data><\/b><span>settled today<\/span>/);
  assert.ok(!plain.includes("% of cap"));
  const quiet = draw(overviewSpend, snapshot({ dollars: null, spendByHour: { hours: Array.from({ length: 24 }, (_, i) => (i > 15 ? null : 0)), unpriced: 0 } }));
  assert.ok(quiet.includes(SPEND_EMPTY.body));
  assert.ok(draw(overviewSpend, snapshot({ spendByHour: null })).includes("The run records could not be read"));
  assert.ok(draw(overviewSpend, snapshot({ dollars: { rows: [], unreachable: "build3.lan" } })).includes("The dollar counters could not be read."));
});

test("Spend today with each read behind it failed: the note says where its number comes from, and what could not be read", () => {
  // The day window read: its spent and held, and the note says so.
  const win = draw(overviewSpend, snapshot());
  assert.ok(win.includes(esc(SPEND_HOURS_TEXT)) && !win.includes(esc(SPEND_SUM_TEXT)));
  // No day window (no day dollar cap): the dots' sum, never "the day window's".
  const sum = draw(overviewSpend, snapshot({ dollars: { rows: [] } }));
  assert.match(sum, /<span>settled today<\/span>/);
  assert.ok(sum.includes(esc(SPEND_SUM_TEXT)) && !sum.includes(esc(SPEND_HOURS_TEXT)));
  // The counters could not be read (the reader's failure, or the day window's counter null): the sum, and the line.
  for (const dollars of [{ rows: [], unreachable: "connect build3.lan" }, { rows: [{ ledger: "deployment", name: null, window: "day", capMicros: 25_000_000, counterMicros: null, full: false }] }]) {
    const out = draw(overviewSpend, snapshot({ dollars }));
    assert.match(out, /<span>settled today<\/span>/, JSON.stringify(dollars));
    assert.ok(out.includes(esc(SPEND_SUM_TEXT)) && out.includes("The dollar counters could not be read.") && !out.includes("% of cap") && !out.includes("build3.lan"), JSON.stringify(dollars));
  }
  // The run records could not be read, and no window either: a dash and "not known", never "no runs".
  const blind = draw(overviewSpend, snapshot({ dollars: { rows: [] }, spendByHour: null }));
  assert.match(blind, /<p class="kpi"><b>-<\/b><span>not known<\/span><\/p>/);
  assert.ok(!blind.includes(SPEND_EMPTY.title) && blind.includes("The run records could not be read"));
  // A day of records not read whole (only the newest, or a side of them): its hours may be short, said.
  for (const over of [{ floor: true }, { partial: true }]) assert.ok(draw(overviewSpend, snapshot({ spendByHour: { ...snapshot().spendByHour, ...over } })).includes("Not every run record of today was read, so these hours may be missing spend."), JSON.stringify(over));
  assert.ok(!win.includes("Not every run record"));
  // The empty sentence only over the hours read whole: over a day read in part, no settled spend among the records read
  // is not "no run has settled any spend", so the note names its number's source as for any sum.
  const zero = { hours: Array.from({ length: 24 }, (_, i) => (i > 15 ? null : 0)), unpriced: 0, floor: false, partial: false };
  assert.ok(draw(overviewSpend, snapshot({ dollars: { rows: [] }, spendByHour: zero })).includes(SPEND_EMPTY.body), "read whole: the empty sentence");
  for (const over of [{ floor: true }, { partial: true }]) {
    for (const dollars of [{ rows: [] }, snapshot().dollars]) {
      const out = draw(overviewSpend, snapshot({ dollars, spendByHour: { ...zero, ...over } }));
      assert.ok(!out.includes(SPEND_EMPTY.body), `${JSON.stringify(over)}: no empty sentence`);
      assert.ok(out.includes(esc(dollars.rows.length > 0 ? SPEND_HOURS_TEXT : SPEND_SUM_TEXT)) && out.includes("Not every run record of today was read"), JSON.stringify(over));
    }
  }
});

// ---- the timeline ----------------------------------------------------------------------------------------------------

test("the timeline card: rows and zoom as links that keep the rest of the query, the project chips with counts", () => {
  const out = draw(overviewTimeline, snapshot());
  assert.match(out, /<h2>Runs by project<\/h2><span class="card__sub">left of now: what ran; right of now: what is in line<\/span>/);
  assert.match(out, /<div class="seg" role="group" aria-label="Rows"><a href="\/" aria-current="page">Project<\/a><a href="\/\?rows=host">Host<\/a><\/div>/);
  assert.match(out, /<div class="seg" role="group" aria-label="Zoom"><a href="\/\?zoom=1h">1h<\/a><a href="\/" aria-current="page">3h<\/a><a href="\/\?zoom=24h">24h<\/a><\/div>/);
  assert.match(out, /<div class="projseg" role="group" aria-label="Project"><span class="projseg__l">Project<\/span><a href="\/" aria-current="page">All<b>\d+<\/b><\/a>/);
  assert.match(out, /<a href="\/\?project=web"><span class="ptag">web<\/span><b>\d+<\/b><\/a>/);
  assert.match(out, /class="tl-wrap"/);
  assert.match(out, /class="keyrow"/);
  const host = draw(overviewTimeline, snapshot(), { query: { rows: "host", zoom: "24h", project: "web" } });
  assert.match(host, /<h2>Runs by host<\/h2>/);
  assert.match(host, /<a href="\/\?zoom=24h&amp;project=web">Project<\/a><a href="\/\?rows=host&amp;zoom=24h&amp;project=web" aria-current="page">Host<\/a>/);
  assert.match(host, /<a href="\/\?rows=host&amp;zoom=24h"( aria-current="page")?>All<b>/);
  // A value the page parser would refuse never reaches the timeline (it draws the defaults).
  assert.match(draw(overviewTimeline, snapshot(), { query: { rows: "<x>", zoom: "9y", project: "NOT A PROJECT" } }), /<h2>Runs by project<\/h2>/);
});

test("the timeline card: past the chips it draws, All still counts every project, and the rest are said as more", () => {
  const runs = Array.from({ length: 30 }, (_, i) => ({ ...RUNS[0], jobId: `gh-p${i}`, project: `p${String(i).padStart(2, "0")}` }));
  const out = draw(overviewTimeline, snapshot({ runsDay: { runs, floor: false, partial: false }, runs: [], active: [], hostBudgets: [], waiting: waitingOf([]), parked: [] }));
  const chips = out.match(/<a href="\/\?project=p\d\d"><span class="ptag">/g) ?? [];
  assert.ok(chips.length > 0 && chips.length < 30, `${chips.length} chips drawn`);
  assert.match(out, /aria-current="page">All<b>30<\/b><\/a>/, "All counts the projects not drawn");
  assert.match(out, new RegExp(`<span class="muted">\\+${30 - chips.length} more</span></div>`));
});

test("the timeline card: a day read only to its newest runs says older ones may be missing; a park takes its project from its record", () => {
  assert.ok(draw(overviewTimeline, snapshot({ runsDay: { runs: RUNS, floor: true, partial: false } })).includes("Only the newest runs are read, so older runs in this window may be missing."));
  assert.ok(!draw(overviewTimeline, snapshot()).includes("Only the newest runs are read"));
  // A park older than the day: its record is among the newest runs alone, and its row is that record's project.
  const old = snapshot({ runsDay: { runs: [], floor: false, partial: false }, runs: [{ jobId: "gh-old", project: "legacy", outcome: "completed", reason: "awaiting-input", endedAt: new Date(NOW - 30 * H).toISOString() }], parked: [{ target: "acme/api#1", kind: "github", jobId: "gh-old", parkedAt: NOW - 30 * H, answered: false, answering: false }], active: [], hostBudgets: [], waiting: waitingOf([]) });
  assert.match(draw(overviewTimeline, old), /<span class="ptag">legacy<\/span>/);
});

test("the timeline with each read behind it failed or cut: says which, and its empty sentence only over both reads made whole", () => {
  const EMPTY_SENTENCE = "No run in this window, and nothing in line.";
  // Runs on record, none in the window (the first run's checklist would stand in for the overview otherwise).
  const whole = { active: [], hostBudgets: [], parked: [], runsDay: { runs: [], floor: false, partial: false }, waiting: waitingOf([]) };
  assert.ok(draw(overviewTimeline, snapshot(whole)).includes(EMPTY_SENTENCE), "both read whole, and nothing in either");
  const cases = [
    [{ runsDay: null }, "The run history could not be read, so only what runs and waits is drawn."],
    [{ runsDay: { runs: [], floor: false, partial: true } }, "Some run records could not be read, so runs in this window may be missing."],
    [{ waiting: { unreachable: true } }, "The waiting jobs could not be read."],
    [{ waiting: undefined }, "The waiting jobs could not be read."],
    [{ waiting: waitingOf([], { truncated: true, queuesCut: 3 }) }, "Not every waiting job was read, so jobs in line may be missing here."],
  ];
  for (const [over, said] of cases) {
    for (const role of ["operator", "viewer"]) {
      const out = draw(overviewTimeline, snapshot({ ...whole, ...over }), { role });
      assert.ok(!out.includes(EMPTY_SENTENCE) && out.includes(said), `${JSON.stringify(over)}, ${role}`);
    }
  }
  // A read not made whole is said beside what was drawn, too.
  assert.ok(draw(overviewTimeline, snapshot({ runsDay: { runs: RUNS, floor: false, partial: true } })).includes("Some run records could not be read"));
  // One cut sentence, `WAITING_CUT_TEXT`, for any cut read (at the queue bound, or a queue read in part), in the same
  // words in the timeline and in In line.
  assert.equal(WAITING_CUT_TEXT, "Not every waiting job was read, so jobs in line may be missing here.");
  for (const extra of [{ truncated: true, queuesCut: 3 }, { truncated: true, queuesCut: 0, byQueue: [{ queue: "pi-jobs", inLine: 1, scheduled: 0, truncated: true }] }]) {
    for (const rows of [[], [WAITING[3]]]) {
      const snap = snapshot({ ...whole, waiting: waitingOf(rows, extra) });
      for (const render of [overviewTimeline, overviewWaiting]) assert.equal(draw(render, snap).split(`<p class="card__sub">${WAITING_CUT_TEXT}</p>`).length, 2, `${render.name}: once, ${JSON.stringify(extra)}, ${rows.length} found`);
    }
  }
});

test("the timeline reads no hold's label or answers, so a viewer's carries none of a wait check's profiles", () => {
  const held = row({ jobId: "gh-h1", bucket: "check", why: "wait-after", known: true, project: "web", trigger: 2, untilAt: NOW + H, dueAt: NOW + H, held: { since: NOW - M, label: "after x + secret-profile-label", checks: 2, after: null, answers: [{ profile: "secret-profile-name", answer: "hold", at: NOW - M }] } });
  for (const role of ["viewer", "operator"]) {
    const out = draw(overviewTimeline, snapshot({ waiting: waitingOf([held]) }), { role });
    assert.ok(out.includes("gh-h1"), `${role}: the held job is drawn`);
    assert.ok(!out.includes("secret-profile"), `${role}: no profile name or hold label on the timeline`);
  }
});

test("the timeline shows every role a reason this console has no words for as recorded, never as no reason", () => {
  for (const role of ["operator", "viewer"]) {
    // The job alone in line, so the lanes draw it whatever else waits.
    const out = draw(overviewTimeline, snapshot({ waiting: waitingOf([WAITING.find((r) => r.jobId === "gh-ee05")]) }), { role });
    assert.ok(out.includes("gh-ee05: brand-new-why, no explanation yet"), `${role}: the pill's title names the reason recorded`);
    assert.ok(!/gh-ee05: no reason was recorded/.test(out), role);
  }
});

// ---- Caps ------------------------------------------------------------------------------------------------------------

test("Caps: a capsule per window with a cap, the soft hold on the job windows alone, its words the worker's", () => {
  const out = draw(overviewCaps, snapshot());
  assert.match(out, /<a class="btn btn--sm" href="\/insights">Spend<\/a>/);
  assert.equal((out.match(/<div class="cap"/g) ?? []).length, 7, "three job windows, tokens, three dollar windows");
  assert.equal((out.match(/class="cap__hold"/g) ?? []).length, 3, "the soft hold on the job windows only (budget.mjs)");
  assert.match(out, /title="Jobs week: 82%">[^]*?tone-attention[^]*?<\/div>/, "past the soft hold: attention; a share below the cap is rounded down");
  assert.match(out, /title="Jobs today: 62%">[^]*?tone-ok[^]*?<\/div>/);
  // A window's "$" is joined to its name by a no-break space, so a long name never leaves it alone on a line.
  assert.match(out, /<b>Deploy&nbsp;\$<\/b>today/);
  assert.match(out, /title="Deploy \$ today: \d+%"/, "the title and the image's name keep a plain space");
  assert.match(out, /web \$ is project web; claude-sonnet-5-5 \$ is model claude-sonnet-5-5/);
  const provider = draw(overviewCaps, snapshot({ dollars: { rows: [{ ledger: "model", name: "anthropic/claude-sonnet-5-5", window: "week", capMicros: 10, counterMicros: 1, full: false }] } }));
  assert.match(provider, /<b>claude-sonnet-5-5&nbsp;\$<\/b>week/);
  assert.match(provider, /claude-sonnet-5-5 \$ is model anthropic\/claude-sonnet-5-5/);
  assert.match(out, /Soft hold line \(80%\)/);
  assert.ok(out.includes(SOFT_HOLD_TEXT) && out.includes(COUNT_WINDOWS_UTC_TEXT));
  assert.ok(!out.includes("new jobs wait"), "the design's words, which the worker does not do, are not drawn");
  const noHold = draw(overviewCaps, snapshot({ settings: { overlay: { dailyCap: 40 } }, dollars: null }));
  assert.ok(!noHold.includes(SOFT_HOLD_TEXT) && !noHold.includes("cap__hold") && noHold.includes(COUNT_WINDOWS_UTC_TEXT));
  assert.ok(draw(overviewCaps, snapshot({ settings: { overlay: {} }, dollars: null })).includes(CAPS_EMPTY_TEXT));
});

/** A capsule's tone, by its title's name and window ("Jobs today"). */
const capTone = (out, what) => new RegExp(`title="${what}: \\d+%"><svg class="tone-([a-z]+)"`).exec(out)?.[1] ?? null;

test("Caps: a window's tone is the budget's own band (budget.mjs windowState): amber from the soft hold, full at the cap", () => {
  const caps = (budget, overlay, dollars = { rows: [] }) => draw(overviewCaps, snapshot({ budget, settings: { overlay }, dollars }));
  // The soft hold turns a job window amber where the next start would pass it, floor(cap * pct / 100), and no sooner.
  assert.equal(capTone(caps({ day: 32 }, { dailyCap: 40, softHoldPct: 80 }), "Jobs today"), "attention");
  assert.equal(capTone(caps({ day: 31 }, { dailyCap: 40, softHoldPct: 80 }), "Jobs today"), "ok");
  assert.equal(capTone(caps({ day: 40 }, { dailyCap: 40, softHoldPct: 80 }), "Jobs today"), "failed", "at the cap: full");
  assert.equal(capTone(caps({ day: 39 }, { dailyCap: 40 }), "Jobs today"), "ok", "no soft hold: ok up to the cap");
  // The token window takes no soft hold: past the hold's percent it is still open, and full at its cap.
  assert.equal(capTone(caps({ tokensToday: 90 }, { dailyTokenCap: 100, softHoldPct: 80 }), "Tokens today"), "ok");
  assert.equal(capTone(caps({ tokensToday: 100 }, { dailyTokenCap: 100, softHoldPct: 80 }), "Tokens today"), "failed");
  // A dollar window is full where its counter says so (the worker's own `full`), even short of 100%.
  const dollar = (full) => caps({}, {}, { rows: [{ ledger: "deployment", name: null, window: "day", capMicros: 100, counterMicros: 99, full }] });
  assert.equal(capTone(dollar(true), "Deploy \\$ today"), "failed");
  assert.equal(capTone(dollar(false), "Deploy \\$ today"), "ok");
});

test("Caps: a folder scope is named by its last folder for every role, and no line writes a scope's raw name", () => {
  const dollars = { rows: [
    { ledger: "scope", name: "/home/rob/clients/acme-secret", window: "day", capMicros: 5_000_000, counterMicros: 1_000_000, full: false },
    { ledger: "scope", name: "C:\\Users\\rob\\clients\\winfolder", window: "week", capMicros: 5_000_000, counterMicros: 1, full: false },
    { ledger: "scope", name: "acme/widgets", window: "week", capMicros: 5_000_000, counterMicros: 1, full: false },
    { ledger: "scope", name: "github:acme/api", window: "month", capMicros: 5_000_000, counterMicros: 1, full: false },
  ] };
  for (const role of ["operator", "viewer"]) {
    const out = draw(overviewCaps, snapshot({ dollars }), { role });
    for (const raw of ["/home/rob", "clients/acme-secret", "Users", "rob\\"]) assert.ok(!out.includes(raw), `${role}: ${raw} is nowhere`);
    assert.match(out, /<b>\.\.\.\/acme-secret&nbsp;\$<\/b>today/, `${role}: the folder by its last folder`);
    assert.match(out, /<b>\.\.\.\/winfolder&nbsp;\$<\/b>week/, `${role}: a drive path too`);
    assert.match(out, /<b>acme\/widgets&nbsp;\$<\/b>week/, `${role}: a repo as it is`);
    assert.match(out, /<b>github:acme\/api&nbsp;\$<\/b>month/, `${role}: a forge's repo as it is`);
    assert.ok(!/ \$ is (?!model|project)/.test(out), `${role}: the key names a project or a model, never a scope`);
  }
});

test("Caps with each read behind it failed: a counter not read is said, and the empty sentence only where no window has a cap", () => {
  const counts = "The job or token counters could not be read, so their windows are not drawn.";
  // The dollar counters' read failed, with no count cap: the line, never the empty sentence, never the reader's message.
  const lost = draw(overviewCaps, snapshot({ settings: { overlay: {} }, dollars: { rows: [], unreachable: "connect build3.lan" } }));
  assert.ok(lost.includes("The dollar counters could not be read.") && !lost.includes(CAPS_EMPTY_TEXT) && !lost.includes("build3.lan"));
  // Beside a count window: its capsule, and the line.
  const beside = draw(overviewCaps, snapshot({ settings: { overlay: { dailyCap: 40 } }, dollars: { rows: [], unreachable: "x" } }));
  assert.ok(beside.includes('title="Jobs today: ') && beside.includes("The dollar counters could not be read."));
  // A dollar window whose counter came back null (the counters' one read failed): not drawn, said.
  const nul = draw(overviewCaps, snapshot({ settings: { overlay: {} }, dollars: { rows: [{ ledger: "deployment", name: null, window: "day", capMicros: 25_000_000, counterMicros: null, full: false }] } }));
  assert.ok(nul.includes("The dollar counters could not be read.") && !nul.includes(CAPS_EMPTY_TEXT) && !nul.includes("Deploy"));
  // A job counter that is no number, or no budget read at all.
  for (const budget of [{ day: "junk" }, null, undefined]) {
    const out = draw(overviewCaps, snapshot({ settings: { overlay: { dailyCap: 40 } }, dollars: { rows: [] }, budget }));
    assert.ok(out.includes(counts) && !out.includes(CAPS_EMPTY_TEXT) && !out.includes("Jobs today"), JSON.stringify(budget));
  }
  // Every read made and no window with a cap: the empty sentence, naming the overlay it read, and no line of a read.
  const none = draw(overviewCaps, snapshot({ settings: { overlay: {} }, dollars: { rows: [] } }));
  assert.ok(none.includes(CAPS_EMPTY_TEXT) && !none.includes("could not be read"));
  assert.ok(!none.includes("No cap is set"), "the worker's own caps from its environment are in no read, so never that no cap is set");
  assert.ok(!draw(overviewCaps, snapshot()).includes("could not be read"), "every read made: no line");
});

test("Caps draws the overlay's caps only from a settings read made whole: an invalid or missing overlay is said, never the empty sentence", () => {
  const settingsUnread = "The settings overlay could not be read, so its caps are not drawn.";
  // The reader's answer for an overlay the worker's validator refuses, on which the worker refuses every job; a read
  // with no overlay object; and no settings read at all.
  for (const settings of [{ path: "/srv/pi/settings.json", invalid: "dailyCap: must be a positive integer" }, { path: "/srv/pi/settings.json", overlay: null }, { path: "/srv/pi/settings.json", overlay: [] }, null, undefined]) {
    const what = JSON.stringify(settings) ?? "undefined";
    const out = draw(overviewCaps, snapshot({ settings, dollars: { rows: [] } }));
    assert.ok(out.includes(settingsUnread), `${what}: said`);
    assert.ok(!out.includes(CAPS_EMPTY_TEXT) && !out.includes("No cap is set"), `${what}: never the empty sentence`);
    assert.ok(!out.includes("must be a positive") && !out.includes("/srv/pi"), `${what}: never the reader's message or path`);
    // Beside the dollar windows, read on their own: those are drawn, and the overlay's are not.
    const beside = draw(overviewCaps, snapshot({ settings }));
    assert.ok(beside.includes(settingsUnread) && beside.includes('title="Deploy $ today: ') && !beside.includes('title="Jobs ') && !beside.includes("Soft hold"), `${what}: the dollar windows alone`);
  }
  // An invalid read that still carries an overlay's keys draws none of them.
  assert.ok(!draw(overviewCaps, snapshot({ settings: { invalid: "x", overlay: { dailyCap: 40, softHoldPct: 80 } } })).includes('title="Jobs today'));
  // Read whole: its caps, and no such line.
  assert.ok(!draw(overviewCaps, snapshot()).includes(settingsUnread));
});

// ---- Waitlists -------------------------------------------------------------------------------------------------------

test("Waitlists: every reason's jobs in the worker's order, each with its project, id, why and one action", () => {
  const out = draw(overviewWaitlists, snapshot());
  assert.match(out, /<svg class="wbar" height="\d+" role="img" aria-label="In line by reason">/);
  const titles = [...out.matchAll(/<p class="wl__h">.*?<b>([^<]+)<\/b>/g)].map((m) => m[1]);
  assert.deepEqual(titles, DEFER_BUCKETS.map((b) => DEFER_BUCKET_WORDS[b].title));
  // A slot a gone job holds: nothing here frees it, so no button says so; a link to the host, on Fleet until the host
  // page exists, and the sentence that says how the slot frees.
  assert.match(out, /<span class="ptag">billing<\/span><span class="code">gh-c9e1<\/span><span class="wl__t">build3 has no free job slot\. <span class="code">gh-4a7e<\/span> still holds one of its slots<\/span><a class="btn btn--sm btn--ghost" href="\/fleet">Open Fleet<\/a>/);
  assert.ok(!out.includes("Free slot") && !out.includes("btn--danger\" href"), "no write, and no link drawn as one");
  assert.equal(out.split(esc(FREE_SLOT_TEXT)).length, 2, "said once, under the slot group");
  // Chain: the run it waits for. Edit: its trigger, on the configuration page until a trigger page exists.
  assert.match(out, /Chained after gh-b3d7; starts when its folder is free<\/span><a class="btn btn--sm btn--ghost" href="\/run\?id=gh-b3d7">Chain<\/a>/);
  assert.match(out, /<a class="btn btn--sm btn--ghost" href="\/config">Edit<\/a>/);
  const pages = { ...OVERVIEW_LINKS, trigger: { path: "/config/trigger" }, host: { path: "/fleet/host" } };
  const later = draw(overviewWaitlists, snapshot(), { pages });
  assert.match(later, /href="\/config\/trigger\?index=2">Edit</);
  assert.match(later, /<a class="btn btn--sm btn--ghost" href="\/fleet\/host\?name=build3">Open build3<\/a>/, "the host's page by its name, once it exists");
  // Held: how long, and an operator reads the profiles' last answers.
  assert.match(out, /Held until <time datetime="2026-10-09T07:00:00\.000Z">2026-10-09 07:00 UTC<\/time>\. Held 2h 14m; last answers: <span class="code">ci-green<\/span> not yet/);
  // A retry has made attempts: no Cancel. A job that never started: Cancel, a destructive write.
  assert.match(out, /Attempt 2 of 3 at <time[^>]*>2026-10-08 15:43 UTC<\/time><\/span><\/li>/);
  assert.match(out, /<span class="code">local-aa01<\/span>.*?<form class="act" data-action="cancel-queued" autocomplete="off"><input type="hidden" name="jobId" value="local-aa01"><input type="hidden" name="queue" value="pi-jobs"><button class="btn btn--sm btn--danger" type="submit">Cancel<\/button><\/form>/);
  // An operator reads an unknown reason's token, in the code face, under its own bucket's title.
  assert.ok(out.includes(`Recorded reason: <span class="code">brand-new-why</span>, ${NO_EXPLANATION}`));
  assert.match(out, /<b>A reason this console does not know<\/b><span class="count">1<\/span><\/p><ul class="wl__l"><li><span class="code">gh-ee05<\/span>/);
  // Past its due with no worker taking it: the reader's sentence, whatever the job recorded. One that never started:
  // Cancel. A scheduler's next run: no Cancel (the queue refuses to remove it), but its cron trigger's Edit, on the
  // configuration page until the trigger page exists.
  // The scheduler's run reads as its trigger and its run time, the raw id in its title.
  const sched = `repeat:nightly-tidy:${at(15, 30)}`;
  const schedId = `<span class="code" title="${sched}">nightly-tidy, <time datetime="2026-10-08T15:30:00.000Z">2026-10-08 15:30 UTC</time> run</span>`;
  assert.match(out, /<span class="code">gh-ff06<\/span><span class="wl__t">Due since <time datetime="2026-10-08T15:36:08\.000Z">2026-10-08 15:36 UTC<\/time>; no worker has taken it<\/span><form class="act" data-action="cancel-queued"/);
  assert.ok(out.includes(`${schedId}<span class="wl__t">Due since <time datetime="2026-10-08T15:30:00.000Z">2026-10-08 15:30 UTC</time>; no worker has taken it</span><a class="btn btn--sm btn--ghost" href="/config">Edit</a></li>`));
  assert.ok(!out.includes(`value="${sched}"`), "no Cancel for a scheduler's next run");
  assert.ok(later.includes(schedId) && later.includes('href="/config/trigger?index=0">Edit<'), "its trigger by index, once the page exists");
  assert.match(out, /<div class="qrow"><span class="card__sub">Queues<\/span><span class="qp"><b class="code">pi-jobs<\/b>1 waiting, 8 delayed<\/span>/);
  assert.match(out, /<span class="qp"><b class="code">@mini2<\/b>paused, 1 held by the pause<\/span>/);
  assert.match(out, /Scheduled: <span class="code">nightly-tidy<\/span> <time/);
  // A scheduler whose key the reader refused is left out, never named by BullMQ's job name ("local").
  const refused = draw(overviewWaitlists, snapshot({ schedulers: [{ key: null, name: "local", pattern: "0 3 * * *", next: Date.UTC(2026, 9, 9, 3, 0), overdueMs: 0 }] }));
  assert.ok(!refused.includes('<span class="code">local</span>'), "never local");
  assert.match(out, new RegExp(`${SOFT_HOLD_REFUSED_TEXT} <a href="/runs\\?outcome=policy&amp;reason=soft-hold">3 today</a>\\.`));
  assert.ok(out.includes(WAITING_UNKNOWN_PROJECT_TEXT));
});

test("Waitlists: a read cut at its queue bound or inside a queue says the counts are a floor, in one line, for every role", () => {
  const queues = (n, truncated = () => false) => Array.from({ length: n }, (_, i) => ({ queue: i === 0 ? "pi-jobs" : `pi-jobs@h${i}`, inLine: 0, scheduled: 0, truncated: truncated(i) }));
  const floorOf = (extra) => {
    const lines = ["operator", "viewer"].map((role) => [...draw(overviewWaitlists, snapshot({ waiting: waitingOf(WAITING, extra) }), { role }).matchAll(/<p class="card__sub">([^<]*a floor\.)<\/p>/g)].map((m) => m[1]));
    assert.deepEqual(lines[1], lines[0], "a viewer reads what an operator reads");
    return lines[0];
  };
  assert.deepEqual(floorOf({ byQueue: queues(64), queuesCut: 3, truncated: true }), ["Only the first 64 queues were read; 3 more were not, so the counts are a floor."]);
  assert.deepEqual(floorOf({ byQueue: queues(64, (i) => i === 5), queuesCut: 1, truncated: true }), ["Only the first 64 queues were read; 1 more was not, and a queue holds more waiting jobs than are read, so the counts are a floor."]);
  assert.deepEqual(floorOf({ byQueue: queues(4, (i) => i === 2), queuesCut: 0, truncated: true }), ["A queue holds more waiting jobs than are read, so the counts are a floor."]);
  assert.deepEqual(floorOf({ byQueue: queues(4), queuesCut: 0, truncated: false }), []);
});

test("Waitlists with its read failed or cut: says so, and never its calm line", () => {
  const retry = [row({ jobId: "gh-r1", bucket: "retry", why: "retry", known: true, attempt: 2, attempts: 3, attemptsMade: 1, untilAt: NOW + M })];
  assert.ok(draw(overviewWaitlists, snapshot({ waiting: waitingOf(retry) })).includes(`<b>${WAITLISTS_CALM}</b>`), "read whole: calm");
  for (const role of ["operator", "viewer"]) {
    const lost = draw(overviewWaitlists, snapshot({ waiting: { unreachable: true } }), { role });
    assert.ok(lost.includes("The waiting jobs could not be read.") && !lost.includes(WAITLISTS_CALM), role);
    for (const extra of [{ truncated: true, queuesCut: 2 }, { truncated: true, byQueue: [{ queue: "pi-jobs", inLine: 1, scheduled: 0, truncated: true }] }]) {
      const cut = draw(overviewWaitlists, snapshot({ waiting: waitingOf(retry, extra) }), { role });
      assert.ok(!cut.includes(WAITLISTS_CALM) && cut.includes("so the counts are a floor."), `${role}: ${JSON.stringify(extra)}`);
    }
  }
});

test("Waitlists for a viewer: the worker's vocabulary, no action, no profile, no slot sentence", () => {
  const out = draw(overviewWaitlists, snapshot(), { role: "viewer" });
  assert.ok(!out.includes("data-action") && !out.includes("btn--danger") && !out.includes(">Chain<") && !out.includes(">Edit<") && !out.includes(">Open Fleet<"));
  assert.ok(!out.includes("ci-green") && !out.includes(esc(FREE_SLOT_TEXT)));
  // A reason this console has no words for was recorded: a viewer reads it so, as an operator does, never "No reason
  // was recorded"; a job with no record at all does read that.
  const unknown = `<span class="code">gh-ee05</span><span class="wl__t">Recorded reason: <span class="code">brand-new-why</span>, ${NO_EXPLANATION}</span>`;
  assert.ok(out.includes(unknown) && draw(overviewWaitlists, snapshot()).includes(unknown));
  assert.match(out, /<span class="code">gh-dd04<\/span><span class="wl__t">No reason was recorded<\/span>/);
  assert.match(out, /build3 has no free job slot/, "the worker's own sentences are the vocabulary a viewer reads");
});

test("Waitlists: Cancel only for a job cancel-queued would plan, Edit only where the record names a trigger", () => {
  const job = (o) => row({ jobId: "gh-x", bucket: "slot", ...o });
  const cancels = (r) => draw(overviewWaitlists, snapshot({ waiting: waitingOf([r]) })).includes('data-action="cancel-queued"');
  assert.equal(cancels(job({})), true);
  for (const bad of [{ attemptsMade: 1 }, { attemptsMade: null }, { stalled: 1 }, { stalled: null }, { recovery: true }, { schedulerNext: true }, { jobId: "bad id" }]) assert.equal(cancels(job(bad)), false, JSON.stringify(bad));
  const held = row({ jobId: "gh-h", bucket: "check", held: { since: NOW - M, label: null, checks: 1, after: null, answers: [] } });
  const out = draw(overviewWaitlists, snapshot({ waiting: waitingOf([held]) }));
  assert.ok(!out.includes(">Edit<") && out.includes('data-action="cancel-queued"'), "no trigger: no Edit; it never started: Cancel");
  // A bucket with nothing for a slot, a run or a check says so once; more than the list shows is counted.
  const many = Array.from({ length: WAITLIST_ROWS_MAX + 2 }, (_, i) => row({ jobId: `gh-r${i}`, bucket: "retry", why: "retry", known: true, attempt: 2, attempts: 3, attemptsMade: 1, untilAt: NOW + i * M }));
  const calm = draw(overviewWaitlists, snapshot({ waiting: waitingOf(many) }));
  assert.ok(calm.includes(`<b>${WAITLISTS_CALM}</b>`));
  assert.ok(!draw(overviewWaitlists, snapshot({ waiting: waitingOf([held]) })).includes(WAITLISTS_CALM), "a job held on a check is no calm");
  assert.ok(calm.includes(`And 2 more waiting for this, not listed: the overview lists the first ${WAITLIST_ROWS_MAX} of each reason.`));
  const lost = draw(overviewWaitlists, snapshot({ waiting: { unreachable: true } }));
  assert.ok(lost.includes("The waiting jobs could not be read.") && lost.includes('class="qrow"'));
});

test("Waitlists: each action only where its rule holds: the held slot's link, Chain and Edit by bucket, Edit by a cron trigger", () => {
  const orphanHost = [{ name: "build3", concurrency: "2", jobs: [{ id: "gh-4a7e", p: null, at: NOW - H, o: true }], jobsMore: 0, staleMs: 1000 }];
  const list = (rows, over = {}, opts = {}) => draw(overviewWaitlists, snapshot({ waiting: waitingOf(rows), ...over }), opts);
  // A slot row waiting on something a gone job's slot does not free (a size no host fits) is no held slot.
  const size = list([row({ jobId: "gh-x", bucket: "slot", why: "size-never-fits", known: true, host: "build3" })], { hostBudgets: orphanHost });
  assert.ok(!size.includes("still holds one of its slots") && !size.includes(">Open Fleet<") && !size.includes(esc(FREE_SLOT_TEXT)));
  assert.ok(size.includes('data-action="cancel-queued"'));
  for (const why of ["host-slot", "host-budget"]) assert.ok(list([row({ jobId: "gh-x", bucket: "slot", why, known: true, host: "build3" })], { hostBudgets: orphanHost }).includes(">Open Fleet<"), why);
  // Past its due a job waits on nothing its record names: Cancel, never the record's Chain or Edit.
  const due = list([row({ jobId: "gh-x", bucket: "due", why: "chained", known: true, holder: "gh-b3d7", dueAt: NOW - 3 * M }), row({ jobId: "gh-y", bucket: "due", why: "wait-after", known: true, trigger: 2, dueAt: NOW - 3 * M })]);
  assert.ok(!due.includes(">Chain<") && !due.includes(">Edit<"));
  assert.equal((due.match(/data-action="cancel-queued"/g) ?? []).length, 2);
  // A scheduler's run is edited through its cron trigger alone: a label trigger of the same id is not its scheduler.
  const sched = row({ jobId: `repeat:nightly-tidy:${NOW - M}`, bucket: "due", schedulerNext: true, dueAt: NOW - M });
  assert.ok(!list([sched], { triggers: { triggers: [{ type: "label", id: "nightly-tidy", index: 5 }] } }).includes(">Edit<"));
  assert.ok(list([sched]).includes('href="/config">Edit<'));
  // And by its own id: beside another cron trigger, a scheduler no trigger is named for gets no Edit; the one named for
  // it, its own index.
  const other = row({ jobId: `repeat:hourly-sync:${NOW - M}`, bucket: "due", schedulerNext: true, dueAt: NOW - M });
  assert.ok(!list([other]).includes(">Edit<"), "nightly-tidy's trigger is not hourly-sync's");
  const pages = { ...OVERVIEW_LINKS, trigger: { path: "/config/trigger" } };
  const both = { triggers: { triggers: [...snapshot().triggers.triggers, { type: "cron", id: "hourly-sync", index: 3 }] } };
  assert.ok(list([other], both, { pages }).includes('href="/config/trigger?index=3">Edit<'));
  assert.ok(list([sched], both, { pages }).includes('href="/config/trigger?index=0">Edit<'));
});

test("Waitlists on a read-only console: an operator reads every row and its sentence, and gets no action, link or form", () => {
  const orphanHost = [{ name: "build3", concurrency: "2", jobs: [{ id: "gh-4a7e", p: null, at: NOW - H, o: true }], jobsMore: 0, staleMs: 1000 }];
  const rows = [row({ jobId: "gh-a", bucket: "slot", why: "host-slot", known: true, host: "build3" }), row({ jobId: "gh-b", bucket: "run", why: "chained", known: true, holder: "gh-b3d7" }), row({ jobId: "gh-c", bucket: "check", why: "wait-after", known: true, trigger: 2, untilAt: NOW + H }), row({ jobId: "gh-d", bucket: "pause", why: "pause-window", known: true, untilAt: NOW + H })];
  const out = draw(overviewWaitlists, snapshot({ hostBudgets: orphanHost, waiting: waitingOf(rows) }), { readOnly: true });
  assert.ok(!out.includes("data-action") && !out.includes(">Chain<") && !out.includes(">Edit<") && !out.includes(">Open Fleet<"));
  assert.ok(out.includes("still holds one of its slots") && out.includes(esc(FREE_SLOT_TEXT)), "an operator still reads the held slot's sentences");
});

test("Waitlists' foot: a hold stamped after now says no held time; a fire already past is not scheduled; a floor says at least", () => {
  const future = row({ jobId: "gh-h", bucket: "check", why: "wait-throttled", known: true, held: { since: NOW + 5 * M, label: null, checks: 1, after: null, answers: [] } });
  assert.ok(!draw(overviewWaitlists, snapshot({ waiting: waitingOf([future]) })).includes(". Held"));
  const past = draw(overviewWaitlists, snapshot({ schedulers: [{ key: "old", name: "old", next: NOW - H }, { key: "soon", name: "soon", next: NOW + H }] }));
  assert.ok(past.includes('<span class="code">soon</span>') && !past.includes('<span class="code">old</span>'));
  assert.match(draw(overviewWaitlists, snapshot({ softHoldToday: { count: 2, floor: true } })), />at least 2 today</);
  assert.match(draw(overviewWaitlists, snapshot({ softHoldToday: { count: 2, floor: false } })), />2 today</);
  // With a soft hold set, a day with none says so; with none set and none refused, no line.
  assert.ok(draw(overviewWaitlists, snapshot({ softHoldToday: { count: 0, floor: false } })).includes(`${SOFT_HOLD_REFUSED_TEXT} 0 today.`));
  assert.ok(!draw(overviewWaitlists, snapshot({ softHoldToday: { count: 0, floor: false }, settings: { overlay: { dailyCap: 40 } } })).includes(SOFT_HOLD_REFUSED_TEXT));
  // The next fires, soonest first.
  const order = draw(overviewWaitlists, snapshot({ schedulers: [{ key: "late", name: "late", next: NOW + 2 * H }, { key: "soon", name: "soon", next: NOW + H }] }));
  assert.ok(order.indexOf('<span class="code">soon</span>') < order.indexOf('<span class="code">late</span>'));
});

test("Scheduled names a scheduler by its key alone: one whose key the reader refused is left out, whatever its job name", () => {
  // BullMQ's `name` is the job's ("local" for every cron trigger), so it never stands in for a refused key.
  const schedulers = [
    { key: null, name: "local", pattern: "0 * * * *", every: null, next: NOW + 5 * M, overdueMs: 0 },
    { key: "nightly-tidy", name: "local", pattern: "0 3 * * *", every: null, next: NOW + 9 * M, overdueMs: 0 },
  ];
  const line = /Scheduled: (.*?)<\/p>/.exec(draw(overviewWaitlists, snapshot({ schedulers })))?.[1] ?? "";
  assert.ok(line.includes('<span class="code">nightly-tidy</span>'), "the keyed scheduler is drawn");
  assert.equal((line.match(/<span class="code">/g) ?? []).length, 1, "and only it");
  assert.ok(!line.includes("local") && !line.includes("more"), "the refused one is neither named nor counted");
  // With only the refused one, no Scheduled line at all.
  assert.ok(!draw(overviewWaitlists, snapshot({ schedulers: schedulers.slice(0, 1) })).includes("Scheduled:"));
});

test("a scheduler's run is named by its trigger and its run time wherever a row draws its id, the raw id in its title", () => {
  const id = `repeat:hourly-sync:${at(15, 0)}`;
  assert.deepEqual(schedulerRunOf(id), { scheduler: "hourly-sync", at: at(15, 0) });
  for (const other of ["gh-1", "repeat:x", `repeat::${at(15, 0)}`, `repeat:a b:${at(15, 0)}`, "repeat:x:01", null]) assert.equal(schedulerRunOf(other), null, String(other));
  assert.deepEqual(schedulerRunOf("repeat:x:9999999999999999"), { scheduler: "x", at: null }, "a slot no date can show");
  const shown = `<span class="code" title="${id}">hourly-sync, <time datetime="2026-10-08T15:00:00.000Z">2026-10-08 15:00 UTC</time> run</span>`;
  const triggers = { triggers: [{ type: "cron", id: "hourly-sync", index: 3 }] };
  assert.ok(draw(overviewWaitlists, snapshot({ triggers, waiting: waitingOf([row({ jobId: id, bucket: "due", schedulerNext: true, dueAt: at(15, 0) })]) })).includes(shown));
  assert.ok(draw(overviewNeeds, snapshot({ failed: { rows: [{ jobId: id, queue: "pi-jobs" }], more: 0 } })).includes(shown), "a failed scheduler run in Needs you too");
  const far = draw(overviewWaitlists, snapshot({ waiting: waitingOf([row({ jobId: "repeat:x:9999999999999999", bucket: "none" })]) }));
  assert.ok(far.includes('<span class="code">repeat:x:9999999999999999</span>'), "with no date to show, the raw id");
});

test("Waitlists: a job in the queue of a host the registry no longer names says so, and the Queues line lists that queue", () => {
  const stray = row({ jobId: "gh-z1", bucket: "slot", why: "host-slot", known: true, host: "zeta", queue: "pi-jobs@zeta" });
  const waiting = waitingOf([stray], { byQueue: [{ queue: "pi-jobs", inLine: 0, scheduled: 0, truncated: false }, { queue: "pi-jobs@zeta", inLine: 1, scheduled: 0, truncated: false }, { queue: "pi-jobs@old", inLine: 0, scheduled: 0, truncated: false }] });
  for (const role of ["operator", "viewer"]) {
    const out = draw(overviewWaitlists, snapshot({ waiting }), { role });
    assert.ok(out.includes('. It is in <span class="code">pi-jobs@zeta</span>, whose host is not in the registry'), role);
    assert.ok(out.includes('<span class="qp"><b class="code">@zeta</b>1 in line, its host not in the registry</span>'), `${role}: the queue the waiting read found it in`);
    assert.ok(!out.includes("@old"), `${role}: a queue with nothing in line is not listed`);
  }
  // A host the registry names is no stray; a registry that could not be read judges none.
  assert.ok(!draw(overviewWaitlists, snapshot({ waiting: waitingOf([{ ...stray, queue: "pi-jobs@mini2" }]) })).includes("not in the registry"));
  assert.ok(!draw(overviewWaitlists, snapshot({ waiting, queue: { ...snapshot().queue, fleetDegraded: "x" } })).includes("whose host is not in the registry"));
});

// ---- why a job waits -------------------------------------------------------------------------------------------------

test("waitingSentence fills the worker's own sentence; a hole, an instant past the clock's range or a missing row says the bucket", () => {
  const fill = { host: "build3", holder: "gh-1", endpoint: "ollama", untilAt: NOW + M, attempt: 2, attempts: 3 };
  for (const [why, { bucket }] of Object.entries(DEFER_WHYS)) {
    const out = String(waitingSentence(row({ bucket, why, known: true, ...fill })));
    assert.doesNotMatch(out, /[{}]|unknown/, why);
  }
  assert.equal(String(waitingSentence(row({ bucket: "slot", why: "host-slot", known: true }))), DEFER_BUCKET_WORDS.slot.title, "no host: the title");
  assert.equal(String(waitingSentence(row({ bucket: "check", why: "wait-after", known: true, untilAt: 9e15, dueAt: null }))), DEFER_BUCKET_WORDS.check.title);
  assert.equal(String(waitingSentence(row({ bucket: "zzz" }))), DEFER_BUCKET_WORDS.none.title);
  assert.equal(waitingSentence(null), null);
  assert.equal(String(waitingSentence(row({ bucket: "slot", why: "<b>new</b>", known: false }))), DEFER_BUCKET_WORDS.slot.title, "a token outside the charset is not one");
  assert.equal(String(waitingSentence(row({ bucket: "none", why: null, known: false }))), DEFER_BUCKET_WORDS.none.title, "no record: no reason was recorded");
  assert.equal(String(waitingSentence(row({ bucket: "unknown", why: "newer-reason", known: false }))), `Recorded reason: <span class="code">newer-reason</span>, ${NO_EXPLANATION}`, "a reason recorded is said so");
  assert.equal(String(waitingSentence(row({ bucket: "due", why: "host-slot", known: true, host: "build3", dueAt: at(15, 30) }))), 'Due since <time datetime="2026-10-08T15:30:00.000Z">2026-10-08 15:30 UTC</time>; no worker has taken it', "past its due: the reader's own sentence, whatever was recorded");
  assert.equal(String(waitingSentence(row({ bucket: "due", dueAt: null }))), DEFER_BUCKET_WORDS.due.title, "no due instant: the title");
  // The reader's `known` decides: a reason it did not mark either way is no token, and one it marked unknown is.
  assert.equal(String(waitingSentence(row({ bucket: "slot", why: "host-slot", known: null, host: "build3" }))), DEFER_BUCKET_WORDS.slot.title);
  assert.match(String(waitingSentence(row({ bucket: "unknown", why: "host-slot", known: false, host: "build3" }))), /^Recorded reason: <span class="code">host-slot<\/span>/);
});

test("waitingSentence is the cancel preview's line (`actions.mjs` waitingLine), so the two say why alike", () => {
  const rows = [
    ...WAITING,
    row({ bucket: "slot", why: "endpoint", known: true, endpoint: "ollama-1" }),
    row({ bucket: "retry", why: "retry", known: true, attempt: 3, attempts: 5, dueAt: NOW + 2 * M }),
    // Past its due: the due rule first, a reason this console does not know included; no due instant: the title.
    row({ bucket: "due", why: "brand-new-why", known: false, dueAt: NOW - 2 * M }),
    row({ bucket: "due", dueAt: null }),
    // An instant past the year 9999 has no date to show: the record's `until` gives way to the due, then to the title.
    row({ bucket: "check", why: "wait-after", known: true, untilAt: DEFER_TIME_MAX_MS + 1, dueAt: NOW + M }),
    row({ bucket: "check", why: "wait-after", known: true, untilAt: DEFER_TIME_MAX_MS, dueAt: null }),
    row({ bucket: "due", dueAt: DEFER_TIME_MAX_MS + 1 }),
  ];
  for (const r of rows) assert.equal(String(waitingSentence(r)), String(waitingLine(r).bar), r.jobId ?? r.why);
});

// ---- Hosts -----------------------------------------------------------------------------------------------------------

test("hostSkewText: a host's clock against this console's, both ways, only past the claim's bound", () => {
  assert.equal(hostSkewText({ name: "build3", skewMs: 108_000, staleMs: 120_000, ttlAgeMs: 12_000 }), "build3's clock is about 1m 48s behind this console's: its beat says 2m ago, and Valkey last refreshed its row 12s ago.");
  assert.equal(hostSkewText({ name: "mini1", skewMs: -95_000, staleMs: 0, ttlAgeMs: 4_000 }), "mini1's clock is about 1m 35s ahead of this console's: Valkey last refreshed its row 4s ago, and its beat is stamped later than that.");
  assert.equal(hostSkewText({ name: "x", skewMs: HOST_SKEW_CLAIM_MS, staleMs: 40_000, ttlAgeMs: 10_000 }), null, "at the bound: no claim");
  assert.equal(hostSkewText({ name: "x", skewMs: null, staleMs: 40_000, ttlAgeMs: 10_000 }), null);
  assert.equal(hostSkewText({ name: "x", skewMs: 90_000, staleMs: 100_000, ttlAgeMs: null }), null);
});

test("Hosts: each host's beat, venues, slots, doctor, queue and pause; the fleet's state and Pause fleet in the head", () => {
  const snap = snapshot();
  snap.hostBudgets[0] = { ...snap.hostBudgets[0], staleMs: 2 * M, skewMs: 108_000, ttlAgeMs: 12_000 };
  snap.hostBudgets[1] = { ...snap.hostBudgets[1], staleMs: 75_000, skewMs: 0, ttlAgeMs: 75_000 };
  snap.hostBudgets[2] = { ...snap.hostBudgets[2], noExpiry: true };
  const out = draw(overviewHosts, snap);
  // mini1 beats late: the head says what it counts, the hosts registered, those beating and BullMQ's connected. build3's
  // clock runs behind, but Valkey refreshed its row 12s ago: it beats, and its beat's age is Valkey's.
  assert.match(out, /<h2>Hosts<\/h2><span class="card__sub">3 registered, 2 beating, 3 connected<\/span>/);
  assert.match(out, /aria-label="beating"><\/span><span class="hostrow__n"><b>build3<\/b>[^]*?<span class="hostrow__beat"><svg[^>]*><use href="#i-beat"><\/use><\/svg>12s<\/span>/, "the skewed host beats, 12s ago");
  assert.match(out, /<form class="act" data-action="fleet-pause" autocomplete="off"><button class="btn btn--sm btn--danger" type="submit"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-pause"><\/use><\/svg>Pause fleet<\/button><\/form>/);
  assert.match(out, /<span class="hostrow__n"><b>build3<\/b><span>podman<\/span><\/span>/);
  assert.match(out, /<span class="hostrow__beat tone-attention">.*?1m 15s<\/span>|<span class="hostrow__beat tone-attention">.*?1m<\/span>/, "a late beat in the attention ink");
  assert.match(out, /Doctor: Docker daemon unreachable, 3 days old, stale/);
  assert.match(out, /1 doctor warning/);
  assert.ok(out.includes(`<span class="faint">${NO_DOCTOR_TEXT}</span>`));
  assert.match(out, /<span class="code">@build3<\/span> 0 waiting, 1 running/);
  assert.match(out, /<span class="code">@mini2<\/span> paused, 1 waiting, 1 running/);
  // The registry's notes in the attention tone, each with its glyph as the doctor's line has its own: never colour alone.
  const glyph = '<span class="tinted tone-attention"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-attention"></use></svg>';
  assert.ok(out.includes(`${glyph}${esc("build3's clock is about 1m 48s behind this console's")}`));
  assert.ok(out.includes(`${glyph}${HOST_NO_EXPIRY_TEXT}</span>`));
  // Each host's own queue: pause it, or resume it when paused (a paid write); none for a queue the snapshot lacks.
  assert.match(out, /data-action="queue-pause" autocomplete="off"><input type="hidden" name="queue" value="pi-jobs@build3"><button class="btn btn--sm btn--round btn--danger" type="submit" aria-label="Pause build3">/);
  assert.match(out, /data-action="queue-resume" autocomplete="off"><input type="hidden" name="queue" value="pi-jobs@mini2"><button class="btn btn--sm btn--round btn--paid" type="submit" aria-label="Resume mini2">/);
  const noQueue = draw(overviewHosts, snapshot({ queueCounts: [{ queue: "pi-jobs", paused: false, counts: {} }] }));
  assert.ok(!noQueue.includes("queue-pause"));
  // The fleet paused: Resume fleet, paid, and no Pause; partly paused: named, with both, as Fleet offers them.
  const paused = draw(overviewHosts, snapshot({ queue: { ...snapshot().queue, pausedState: true } }));
  assert.match(paused, /data-action="fleet-resume".*?btn--paid.*?Resume fleet/);
  assert.ok(!paused.includes('data-action="fleet-pause"'));
  const partly = draw(overviewHosts, snapshot({ queue: { ...snapshot().queue, pausedPartial: true } }));
  assert.match(partly, /Partly paused: 1 host queue</, "how many, never which: the Queues line and the host's row name it");
  assert.match(partly, /<span class="end">.*?data-action="fleet-pause".*?Pause fleet<\/button><\/form><form class="act" data-action="fleet-resume" autocomplete="off"><button class="btn btn--sm btn--paid" type="submit">.*?Resume fleet<\/button><\/form>/);
  assert.ok(!out.includes('data-action="fleet-resume"'), "nothing paused: no Resume fleet");
  // A viewer: no write at all.
  assert.ok(!draw(overviewHosts, snap, { role: "viewer" }).includes("data-action"));
});

test("Hosts: a partial pause says how many queues are paused, never their names, whatever their length", () => {
  const long = `build-${"x".repeat(51)}-gpu-03`;
  const headOf = (queueCounts) => /<div class="card__head">[^]*?<\/div>/.exec(draw(overviewHosts, snapshot({ queue: { ...snapshot().queue, pausedPartial: true }, queueCounts })))?.[0] ?? "";
  const chip = (queueCounts) => /<span class="chip tone-attention"><svg[^]*?<\/svg>([^<]*)<\/span>/.exec(headOf(queueCounts))?.[1] ?? null;
  const qc = snapshot().queueCounts;
  assert.equal(chip(qc), "Partly paused: 1 host queue");
  const many = [...qc.map((q) => (q.queue === "pi-jobs@build3" ? { ...q, paused: true } : q)), { queue: `pi-jobs@${long}`, paused: true, counts: {} }];
  assert.equal(chip(many), "Partly paused: 3 host queues");
  assert.ok(!headOf(many).includes(long) && !headOf(many).includes("@"), "no queue named in the head");
  assert.equal(chip(qc.map((q) => ({ ...q, paused: q.queue === "pi-jobs" }))), "Partly paused: the shared queue");
  assert.equal(chip(qc.map((q) => (q.queue === "pi-jobs" ? { ...q, paused: true } : q))), "Partly paused: the shared queue and 1 host queue");
  assert.equal(chip(qc.map((q) => ({ ...q, paused: false }))), "Partly paused: some queues", "a partial pause no queue count shows");
  // Each paused queue is named where there is room: the Waitlists' Queues line.
  assert.ok(draw(overviewWaitlists, snapshot({ queueCounts: many })).includes(`<span class="qp"><b class="code">@${long}</b>paused</span>`));
});

test("Hosts: the head's count says what it counts: beating hosts, all three where they differ, BullMQ's connected with no row", () => {
  const head = (snap) => /<h2>Hosts<\/h2><span class="card__sub">([^<]+)<\/span>/.exec(draw(overviewHosts, snap))?.[1] ?? null;
  assert.equal(head(snapshot()), "3 beating", "every registered host beats, and BullMQ sees no more");
  assert.equal(head(snapshot({ queue: { ...snapshot().queue, workers: 5 } })), "3 registered, 3 beating, 5 connected");
  const late = snapshot().hostBudgets.map((h, i) => (i === 0 ? { ...h, staleMs: BEAT_FRESH_MS + 1, ttlAgeMs: BEAT_FRESH_MS + 1 } : h));
  assert.equal(head(snapshot({ hostBudgets: late, queue: { ...snapshot().queue, workers: 2 } })), "3 registered, 2 beating");
  // No registry row: the workers BullMQ sees, by their own word, never as hosts that beat.
  assert.equal(head(snapshot({ hostBudgets: [], queue: { ...snapshot().queue, workers: 2 } })), "2 connected");
  assert.equal(head(snapshot({ hostBudgets: [], queue: { ...snapshot().queue, workers: "unknown" } })), "none registered");
  assert.equal(head(snapshot({ queue: { ...snapshot().queue, fleetDegraded: "x" } })), "as last seen");
});

test("Hosts: a beat exactly a minute old is fresh; a host's own queue is the one named for it, never a name that ends the same", () => {
  const fresh = draw(overviewHosts, snapshot({ hostBudgets: [{ name: "build3", concurrency: "2", jobs: [], staleMs: BEAT_FRESH_MS }] }));
  assert.ok(fresh.includes('aria-label="beating"') && !fresh.includes("hostrow__beat tone-attention"));
  const named = draw(overviewHosts, snapshot({ hostBudgets: [{ name: "ild3", concurrency: "2", jobs: [], staleMs: 1 }], queueCounts: [{ queue: "pi-jobs@build3", paused: false, counts: {} }, { queue: "pi-jobs@ild3", paused: false, counts: {} }] }));
  assert.match(named, /name="queue" value="pi-jobs@ild3"/);
  assert.ok(!named.includes('value="pi-jobs@build3"'));
});

test("Hosts: no worker online leads; stale beats are the softer note; an unread registry is said, never as empty", () => {
  const none = draw(overviewHosts, snapshot({ queue: { ...snapshot().queue, workers: "unknown" }, hostBudgets: [] }));
  assert.ok(none.includes(NO_WORKER_TEXT) && none.includes(HOSTS_EMPTY.body));
  assert.match(none, /<a class="btn btn--sm" href="\/fleet">Open Fleet<\/a>/);
  const stale = draw(overviewHosts, snapshot({ hostBudgets: snapshot().hostBudgets.map((h) => ({ ...h, staleMs: BEAT_FRESH_MS + 1, ttlAgeMs: BEAT_FRESH_MS + 1 })) }));
  assert.ok(stale.includes(STALE_BEATS_TEXT) && !stale.includes(NO_WORKER_TEXT));
  const blind = draw(overviewHosts, snapshot({ queue: { ...snapshot().queue, fleetDegraded: "registry unreadable at 10.9.9.9" } }));
  assert.ok(blind.includes(REGISTRY_UNREAD_TEXT) && !blind.includes("10.9.9.9") && !blind.includes(NO_WORKER_TEXT));
  assert.match(blind, /<span class="card__sub">as last seen<\/span>/);
  const empty = draw(overviewHosts, snapshot({ hostBudgets: [], queue: { ...snapshot().queue, fleetDegraded: "registry unreadable" } }));
  assert.ok(empty.includes(REGISTRY_UNREAD_TEXT) && !empty.includes(HOSTS_EMPTY.body), "no row read: not known, never no host registered");
});

test("a hostile value from another host is text: a doctor label, a host name and a venue are escaped", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const snap = snapshot({ doctor: { hosts: [{ name: "build3", ageMs: H, counts: { ok: 1, warn: 0, fail: 1 }, checks: [{ id: "docker.1", level: "fail", label: evil }], more: 0 }], more: 0 } });
  snap.hostBudgets[1] = { ...snap.hostBudgets[1], name: "<b>m</b>", backends: { blessed: [evil] } };
  for (const render of [overviewHosts, overviewActive, overviewNeeds]) {
    const out = draw(render, snap);
    assert.ok(!out.includes("<img") && !out.includes("<b>m</b>"), render.name);
  }
});

// ---- the first run ---------------------------------------------------------------------------------------------------

const fresh = (over = {}) => snapshot({ hostBudgets: [], active: [], runs: [], runsDay: { runs: [], floor: false, partial: false }, triggers: { triggers: [] }, queue: { pausedState: false, pausedPartial: false, counts: {}, workers: 0, queues: 1, fleetDegraded: null }, doctor: { hosts: [{ name: "build3", ageMs: 2 * M, counts: { ok: 2, warn: 1, fail: 1 }, checks: [{ id: "egress.proxy", level: "fail", label: "Egress proxy is not on this host (pi-egress-proxy)" }, { id: "provider.key", level: "warn", label: "Provider key not set" }], more: 0 }], more: 0 }, ...over });

test("first run: the checklist stands in for the overview, and gives way to it as soon as a run is on record", () => {
  for (const render of EIGHT) assert.equal(draw(render, fresh()), "", render.name);
  for (const render of SETUP) assert.notEqual(draw(render, fresh()), "", render.name);
  const ran = fresh({ runs: [{ jobId: "gh-1", outcome: "completed", endedAt: new Date(NOW - 5 * 86_400_000).toISOString() }] });
  for (const render of SETUP) assert.equal(draw(render, ran), "", render.name);
  for (const render of EIGHT) assert.notEqual(draw(render, ran), "", render.name);
});

test("first run: the progress, each step's tile, word and sentence, and an operator's commands and the one primary", () => {
  const out = draw(overviewSetup, fresh());
  assert.match(out, /<h2>Getting ready<\/h2><span class="card__sub">from doctor on build3, 2 minutes ago<\/span>/);
  assert.match(out, /<p><b class="su-big">3<\/b> of 8 ready<\/p><svg class="su-bar" height="10" role="img" aria-label="3 of 8 ready: 2 not yet, 1 to check, 2 to do">/);
  assert.equal((out.match(/<rect class="su-seg /g) ?? []).length, 8);
  assert.match(out, /<rect class="su-seg tone-ok" x="0\.00%" y="0" width="11\.80%" height="10" rx="5"\/><rect class="su-seg tone-ok" x="12\.60%"/);
  assert.match(out, /<rect class="su-seg tone-idle su-seg--todo" x="88\.20%"/);
  assert.match(out, /Jobs start once a worker runs and its egress proxy is up\. This page updates as each step is done\./);
  assert.match(out, /<li class="su-step su-step--done"><span class="tile tone-ok">.*?<span class="su-n">1<\/span>Deployment found<span class="chip tone-ok">Ready<\/span><\/p><p class="su-step__s">The console reads its files from the deployment in <span class="code">pi-dispatch<\/span>\.<\/p>/);
  assert.match(out, /<span class="su-n">4<\/span>Start a worker<span class="chip tone-failed">Not yet<\/span>/);
  assert.match(out, /<span class="su-n">6<\/span>Provider key<span class="chip tone-attention">Check<\/span>/);
  assert.match(out, /<span class="su-n">8<\/span>Forge credentials<span class="chip tone-idle">Optional<\/span>/);
  assert.match(out, /<p class="su-alt">Or run it yourself in a terminal:<\/p>/);
  for (const argv of [FIRST_RUN_COMMANDS.token, FIRST_RUN_COMMANDS.service, FIRST_RUN_COMMANDS.worker, FIRST_RUN_COMMANDS.up, FIRST_RUN_COMMANDS.doctor]) assert.ok(out.includes(`<span>${argv[1]}</span>`), argv.join(" "));
  assert.ok(out.includes("<span>&#39;&lt;receiver URL&gt;&#39;</span>") || out.includes("<span>'&lt;receiver URL&gt;'</span>"), "the webhook URL is a quoted placeholder");
  assert.match(out, /<div class="su-act"><a class="btn btn--primary" href="\/config"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-plus"><\/use><\/svg>Add a trigger<\/a><a class="btn btn--ghost" href="https:\/\/github\.com\/edgehero\/pi-dispatch\/blob\/main\/docs\/triggers\.md" rel="noreferrer noopener" target="_blank">What triggers can do<\/a><\/div>/);
  assert.equal((out.match(/btn--primary/g) ?? []).length, 1, "one primary");
  assert.ok(!out.includes("redis://") && !out.includes("6379"), "the queue step names no address");
  // The trigger editor, once PAGES has it, is where Add goes.
  assert.match(draw(overviewSetup, fresh(), { pages: { ...OVERVIEW_LINKS, "trigger-add": { path: "/config/trigger-add" } } }), /href="\/config\/trigger-add">/);
});

test("first run for a viewer: the same steps and states, without a command or the Add button; read-only keeps the commands", () => {
  const viewer = draw(overviewSetup, fresh(), { role: "viewer" });
  assert.ok(!viewer.includes('class="cmd"') && !viewer.includes("Add a trigger") && !viewer.includes("su-alt"));
  assert.match(viewer, /You are signed in as <b>a viewer<\/b>\./);
  assert.match(viewer, /aria-label="3 of 8 ready/);
  assert.ok(!draw(overviewSetupPi, fresh(), { role: "viewer" }).includes('class="cmd"'));
  const ro = draw(overviewSetup, fresh(), { readOnly: true });
  assert.ok(ro.includes('class="cmd"') && !ro.includes("Add a trigger"));
});

test("first run: Do it from pi, and the overview's panels as they will read, in the panels' own words", () => {
  const pi = draw(overviewSetupPi, fresh());
  assert.match(pi, /<h2>Do it from pi<\/h2><\/div><p class="muted su-p">The guided setup in pi walks through every step and asks before each one\. It never asks for the provider key\.<\/p><div class="cmd"><code><span>\/dispatch<\/span> <span>setup<\/span><\/code>/);
  const empty = draw(overviewSetupEmpty, fresh({ waiting: waitingOf([]) }));
  assert.match(empty, /<h2>The Overview, once it runs<\/h2><span class="card__sub">each panel says what it is waiting for<\/span>/);
  for (const [title, words] of [["Needs you", NEEDS_EMPTY.title], ["In line", WAITING_EMPTY.title], ["Running", RUNNING_EMPTY.title], ["Spend today", SPEND_EMPTY.title], ["Hosts", HOSTS_EMPTY.title]]) assert.ok(empty.includes(`<b>${title}</b> ${words}</p>`), title);
  // A host that beats, a job in line or one running before the first record: the preview says so, as step 4 does.
  const some = draw(overviewSetupEmpty, fresh({ hostBudgets: [{ name: "mini1", concurrency: "2", jobs: [], staleMs: 2000 }], waiting: waitingOf([WAITING[3]]), active: [snapshot().active[0]] }));
  for (const words of ["<b>Hosts</b> 1 host registered</p>", "<b>In line</b> 1 job waiting to start</p>", "<b>Running</b> 1 job running</p>"]) assert.ok(some.includes(words), words);
  assert.ok(!some.includes(HOSTS_EMPTY.title));
  assert.ok(draw(overviewSetupEmpty, fresh({ waiting: { unreachable: true } })).includes("<b>In line</b> could not be read</p>"));
  const cut = draw(overviewSetupEmpty, fresh({ waiting: waitingOf([], { truncated: true, queuesCut: 2 }) }));
  assert.ok(cut.includes(`<b>In line</b> ${WAITING_CUT_TEXT}</p>`) && !cut.includes("or more"), "a cut read that found none: not known, never 0 or more");
});

test("first run: a command with a placeholder carries the sentence that fills it, for an operator", () => {
  const out = draw(overviewSetup, fresh());
  assert.ok(out.includes("<p class=\"su-alt\">Put the public URL of this deployment&#39;s pi-dispatch-receiver, where GitHub delivers events, in place of <span class=\"code\">&lt;receiver URL&gt;</span>; without a receiver, pass <span class=\"code\">--no-webhook</span> instead of <span class=\"code\">--webhook-url</span> and its URL.</p>"));
  assert.ok(out.includes("<p class=\"su-alt\">Put a name for whoever will hold the token in place of <span class=\"code\">&lt;name&gt;</span>; the command prints the token once.</p>"));
  assert.ok(!draw(overviewSetup, fresh(), { role: "viewer" }).includes("in place of"), "a viewer reads no command, nor its hint");
});
