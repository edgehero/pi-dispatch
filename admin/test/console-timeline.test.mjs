import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFER_BUCKETS } from "@edgehero/pi-dispatch/defer-reasons";
import { isSafeHtml } from "../src/console/html.mjs";
import { PAGE_CSS } from "../src/console/page-css.mjs";
import { ICON_NAMES } from "../src/console/pulse-icons.mjs";
import { PULSE_CSS } from "../src/console/pulse-css.mjs";
import { OUTCOME_WORDS, REASON_WORDS } from "../src/words.mjs";
import {
  ANY_HOST_TEXT,
  HOST_NOT_KNOWN_TEXT,
  NO_PROJECT_TEXT,
  PARKED_TAIL_TEXT,
  TIMELINE_BAND,
  TIMELINE_CHIPS_MAX,
  TIMELINE_DEFAULTS,
  TIMELINE_KINDS,
  TIMELINE_LANES_MAX,
  TIMELINE_LEGEND,
  TIMELINE_ROWS,
  TIMELINE_ROWS_MAX,
  TIMELINE_WAIT_WORDS,
  TIMELINE_WORDS,
  TIMELINE_ZOOMS,
  timelineHtml,
  timelineLegend,
  timelineModel,
} from "../src/console/timeline.mjs";

// Issue #737: the overview's timeline, a pure module. The model is pinned by its numbers and words, the markup by the
// TimelineAndWaitlists card's own sample (copied here as the card's bytes from design/system, which this test does not read),
// with only what a drawing of other data must change taken out (positions, titles) and the kit's one spelling applied
// (the card closes `<use>` with `/>`, the console with `</use>`).

/** The instant every test draws at: 15:39 UTC, the card's now. */
const NOW = Date.parse("2026-10-25T15:39:00Z");
const MIN = 60_000;
/** An instant `m` minutes from NOW (negative is the past). */
const t = (m) => NOW + m * MIN;

/** A day record as `runsDay` rebuilds one. */
const rec = (jobId, { project = "web", host = "build3", target = "acme/web#1", outcome = "completed", reason = null, from = -60, to = -30, kind = "github" } = {}) => ({
  jobId,
  kind,
  target,
  project,
  host,
  outcome,
  reason,
  startedAt: from === null ? null : t(from),
  endedAt: to === null ? null : t(to),
  parentJobId: null,
});
/** A `readWaiting` row. */
const wait = (jobId, { bucket = "slot", why = "host-slot", known = true, due = null, project = "web", host = "build3", queue = "pi-jobs", holder = null, attempt = null, attempts = null, until = null, schedulerNext = false } = {}) => ({
  jobId,
  queue,
  state: due === null ? "waiting" : "delayed",
  bucket,
  why,
  known,
  dueAt: due === null ? null : t(due),
  queuedAt: t(-10),
  recordedAt: t(-5),
  untilAt: until === null ? null : t(until),
  project,
  projectFrom: project === null ? null : "record",
  host,
  holder,
  endpoint: null,
  budgetWhy: null,
  trigger: null,
  attempt,
  attempts,
  attemptsMade: 0,
  stalled: 0,
  kind: "github",
  recovery: false,
  schedulerNext,
  held: null,
});

/** The card's sample as snapshot parts: its rows (api, billing, ops), its now and its zoom. */
function cardSample() {
  return {
    now: NOW,
    runs: [
      rec("gh-2f6a", { project: "api", target: "acme/api#88", reason: "awaiting-input", from: -52, to: -26 }),
      rec("gl-9a2c", { project: "billing", target: "acme/billing-ui#405", host: "mini1", from: -170, to: -154, kind: "gitlab" }),
      rec("gh-ebd7", { project: "billing", target: "acme/billing#259", from: -93, to: -60 }),
      rec("gh-e9a0", { project: "billing", target: "acme/billing#261", outcome: "policy", reason: "budget-day", from: -8, to: -8 }),
      rec("gh-4a7e", { project: "billing", target: "acme/billing#250", outcome: "policy", reason: "operator-cancel", from: -298, to: -280 }),
    ],
    active: [
      { jobId: "gh-e802", queue: "pi-jobs", startedAt: t(-104), host: "build3" },
      { jobId: "local-9e20", queue: "pi-jobs@mini2", startedAt: t(-6), host: "mini2" },
    ],
    hostJobs: [
      { name: "build3", jobs: [{ id: "gh-4a7e", p: "billing", at: t(-298), o: true }, { id: "gh-e802", p: "billing", at: t(-104) }] },
      { name: "mini2", jobs: [{ id: "local-9e20", p: "ops", at: t(-6) }] },
    ],
    waiting: { rows: [wait("gh-71b2", { bucket: "retry", why: "retry", due: 4, project: "api", attempt: 2, attempts: 3 }), wait("gh-c9e1", { due: 1, project: "billing" })] },
    parked: [{ jobId: "gh-2f6a", target: "acme/api#88", kind: "github", parkedAt: t(-26), answered: false }],
  };
}

/** Every item of a model, flat. */
const itemsOf = (m) => m.rows.flatMap((r) => r.lanes.flat());
/** The one item with this id. */
const itemOf = (m, id) => {
  const got = itemsOf(m).filter((i) => i.jobId === id);
  assert.equal(got.length, 1, `one ${id}`);
  return got[0];
};
/** A row by its label. */
const rowOf = (m, label) => {
  const got = m.rows.find((r) => r.label === label);
  assert.ok(got, `a row ${label}`);
  return got;
};
/** The lane an item is in, within its row. */
const laneOf = (row, id) => row.lanes.findIndex((l) => l.some((i) => i.jobId === id));

/**
 * The card's markup with what changes with the data taken out: every percentage (`x="12.34%"`, and the card's bare
 * `x="0"`) is `x="P"`, every `<title>`'s text is empty, `<use .../>` is the console's `<use ...></use>`, and the
 * whitespace between tags is gone.
 */
function shapeOf(s) {
  return String(s)
    .replace(/>\s+</g, "><")
    .replace(/(<use [^>]*?)\/>/g, "$1></use>")
    .replace(/<title>[^<]*<\/title>/g, "<title></title>")
    .replace(/="-?\d+(?:\.\d+)?%"/g, '="P"')
    .replace(/ (x|x1|x2|cx)="0"/g, ' $1="P"');
}

/** The markup of a model, as a string. */
const draw = (m, label = "Runs by project") => {
  const out = timelineHtml(m, { label });
  assert.ok(isSafeHtml(out), "a fragment built by html");
  return String(out);
};

// ---- the constants -----------------------------------------------------------------------------------------------------

test("the zooms, groupings, defaults and lane cap are the contract's, frozen", () => {
  assert.deepEqual(TIMELINE_ZOOMS, {
    "1h": { pastMs: 3_600_000, futureMs: 1_800_000, tickMs: 600_000 },
    "3h": { pastMs: 10_800_000, futureMs: 5_400_000, tickMs: 1_800_000 },
    "24h": { pastMs: 86_400_000, futureMs: 43_200_000, tickMs: 14_400_000 },
  });
  for (const z of Object.values(TIMELINE_ZOOMS)) assert.ok(Object.isFrozen(z));
  assert.ok(Object.isFrozen(TIMELINE_ZOOMS) && Object.isFrozen(TIMELINE_ROWS) && Object.isFrozen(TIMELINE_DEFAULTS));
  assert.deepEqual(TIMELINE_ROWS, ["project", "host"]);
  assert.deepEqual(TIMELINE_DEFAULTS, { rows: "project", zoom: "3h" });
  assert.equal(TIMELINE_LANES_MAX, 4);
  assert.equal(TIMELINE_ROWS_MAX, 12);
  assert.equal(TIMELINE_CHIPS_MAX, 24);
  assert.ok(TIMELINE_ROWS.includes(TIMELINE_DEFAULTS.rows) && Object.hasOwn(TIMELINE_ZOOMS, TIMELINE_DEFAULTS.zoom));
  // Now at two thirds at every zoom (the 24 hours look 12 ahead), and every tick a whole number of ticks per side.
  const nowAt = Object.fromEntries(Object.keys(TIMELINE_ZOOMS).map((z) => [z, timelineModel({ now: NOW, zoom: z }).nowX]));
  assert.deepEqual(nowAt, { "1h": "66.67", "3h": "66.67", "24h": "66.67" });
});

test("the words are words.mjs's and the waiting buckets the worker leaf's, each with a sprite glyph", () => {
  assert.equal(TIMELINE_WORDS.completed, OUTCOME_WORDS.completed.word);
  assert.equal(TIMELINE_WORDS.refused, OUTCOME_WORDS.policy.word);
  assert.equal(TIMELINE_WORDS.failed, OUTCOME_WORDS.failed.word);
  assert.equal(TIMELINE_WORDS.parked, REASON_WORDS["awaiting-input"].word);
  assert.equal(TIMELINE_WORDS.cancelled, REASON_WORDS["operator-cancel"].word);
  assert.deepEqual(Object.keys(TIMELINE_WAIT_WORDS), [...DEFER_BUCKETS], "one entry per bucket, in the leaf's order");
  for (const [b, w] of Object.entries(TIMELINE_WAIT_WORDS)) {
    assert.ok(ICON_NAMES.includes(w.glyph), `${b}'s glyph is in the sprite`);
    assert.ok(w.short !== "" && w.word !== "" && w.long !== "", b);
    assert.ok(w.word.length < w.short.length, `${b}: its word is shorter than its short line`);
  }
  // A pill too narrow for its line says its word after its id, where a bare noun reads as a label: "host" beside an id
  // read as the job's host, so the host that is not ready yet says so.
  assert.equal(TIMELINE_WAIT_WORDS.ready.word, "not ready");
  // The waitlist bar draws each bucket as its glyph and a count, nothing else: two buckets with one glyph read as one.
  const glyphs = Object.values(TIMELINE_WAIT_WORDS).map((w) => w.glyph);
  assert.equal(new Set(glyphs).size, glyphs.length, "each bucket its own glyph");
  for (const e of TIMELINE_LEGEND) if (e.icon) assert.ok(ICON_NAMES.includes(e.icon));
  assert.deepEqual(TIMELINE_KINDS, ["run", "held", "parked", "failed", "refused", "wait", "ok"]);
});

test("the module is pure: it imports html.mjs, kit.mjs and words.mjs only, and reads no clock", () => {
  const src = readFileSync(new URL("../src/console/timeline.mjs", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./html.mjs", "./kit.mjs", "../words.mjs"]);
  assert.doesNotMatch(src, /Date\.now\(|new Date\(\)|performance\.now|Math\.random/);
});

test("every class the markup writes is one the bundle, or the overview's own rules where the timeline is drawn, styles", () => {
  const m = timelineModel(cardSample());
  // With more rows than are drawn, the sentence that counts the rest too (a card's, `card__sub`).
  const many = timelineModel({ now: NOW, waiting: Array.from({ length: TIMELINE_ROWS_MAX + 1 }, (_, i) => wait(`gh-${i}`, { project: `p${i}` })) });
  const all = draw(m) + draw(timelineModel({ ...cardSample(), rows: "host", zoom: "24h" })) + draw(many) + String(timelineLegend());
  assert.ok(all.includes(`<p class="card__sub">1 more row is not drawn`));
  const used = new Set([...all.matchAll(/class="([^"]+)"/g)].flatMap((x) => x[1].split(" ")));
  const styled = (css, c) => new RegExp(`\\.${c.replace(/[-]/g, "\\-")}(?![a-z0-9_-])`).test(css);
  for (const c of used) assert.ok(styled(PULSE_CSS, c) || styled(PAGE_CSS.overview, c), `.${c} is styled by the bundle or the overview's rules`);
  // A park's label outside its pill is the one the bundle has no rule for: the overview's rules give it the parked ink.
  assert.ok(used.has("tp-l--out-parked") && !styled(PULSE_CSS, "tp-l--out-parked"));
  assert.match(PAGE_CSS.overview, /\n\.tp-l--out-parked\{fill:var\(--parked-ink\)\}\n/);
});

// ---- the model -------------------------------------------------------------------------------------------------------------

test("the card's sample: its rows, its kinds and its numbers", () => {
  const m = timelineModel(cardSample());
  assert.equal(m.zoom, "3h");
  assert.equal(m.by, "project");
  assert.equal(m.start, NOW - 10_800_000);
  assert.equal(m.end, NOW + 5_400_000);
  assert.equal(m.nowLabel, "15:39");
  assert.deepEqual(m.rows.map((r) => [r.key, r.label, r.tag, r.sub]), [
    ["api", "api", "project", "acme/api"],
    ["billing", "billing", "project", "acme/billing, billing-ui"],
    ["ops", "ops", "project", null],
  ]);
  assert.deepEqual(m.chips, [{ project: "api", count: 2, on: false }, { project: "billing", count: 6, on: false }, { project: "ops", count: 1, on: false }]);
  assert.equal(m.empty, false);
  assert.deepEqual(rowOf(m, "billing").counts, { completed: 2, cancelled: 0, failed: 0, refused: 1, parked: 0, running: 1, held: 1, waiting: 1 });
  assert.deepEqual(Object.fromEntries(itemsOf(m).map((i) => [i.jobId, i.kind])), {
    "gh-2f6a": "parked",
    "gh-71b2": "wait",
    "gl-9a2c": "ok",
    "gh-ebd7": "ok",
    "gh-e9a0": "refused",
    "gh-e802": "run",
    "gh-4a7e": "held",
    "gh-c9e1": "wait",
    "local-9e20": "run",
  });
  // Positions: percent strings, two decimals, now at 66.67 for the 3h zoom.
  const run = itemOf(m, "gh-e802");
  assert.equal(run.x, "28.15");
  assert.equal((Number(run.x) + Number(run.w)).toFixed(2), "66.67", "a running job ends at now");
  assert.equal(itemOf(m, "gh-71b2").x, "68.17", "a waiting job due within the lead starts just right of now, where its gap shows");
  assert.equal(itemOf(m, "gh-c9e1").x, "68.17", "and so does one due now, where the arrow before it shows");
  const later = timelineModel({ now: NOW, waiting: [wait("w-later", { due: 8 })] });
  assert.equal(itemOf(later, "w-later").x, "69.63", "one due later starts at its due time");
  const past = itemOf(timelineModel({ now: NOW, waiting: [wait("w-past", { due: 30 })] }), "w-past");
  assert.deepEqual([past.x, past.label.sub], ["70.18", "slot 16:09"], "one due past its bucket's start stands there, saying when");
  assert.equal(Number(itemOf(m, "gh-c9e1").x) + Number(itemOf(m, "gh-c9e1").w), 100, "a waiting job runs to the window's end");
});

test("the model is deterministic: the same parts in any order draw the same bytes", () => {
  const a = cardSample();
  const b = cardSample();
  for (const k of ["runs", "active", "hostJobs", "parked"]) b[k].reverse();
  b.waiting.rows.reverse();
  b.hostJobs[0].jobs.reverse();
  assert.equal(draw(timelineModel(a)), draw(timelineModel(a)));
  assert.equal(draw(timelineModel(a)), draw(timelineModel(b)));
  assert.deepEqual(timelineModel(a), timelineModel(b));
});

test("the zoom and grouping are closed values; none is the default; a bad instant throws", () => {
  assert.equal(timelineModel({ now: NOW }).zoom, "3h");
  assert.equal(timelineModel({ now: NOW, zoom: null, rows: undefined }).by, "project");
  assert.throws(() => timelineModel({ now: NOW, zoom: "2h" }), RangeError);
  assert.throws(() => timelineModel({ now: NOW, zoom: "toString" }), RangeError);
  assert.throws(() => timelineModel({ now: NOW, rows: "repo" }), RangeError);
  assert.throws(() => timelineModel({ now: Number.NaN }), TypeError);
  assert.throws(() => timelineModel({ now: "2026-10-25" }), TypeError);
  assert.throws(() => timelineModel(), TypeError);
});

test("ended runs are clipped at the window's start; one that ended before it is not drawn", () => {
  const m = timelineModel({
    now: NOW,
    zoom: "1h",
    runs: [rec("a-old", { from: -200, to: -61 }), rec("b-straddle", { from: -90, to: -30 }), rec("c-inside", { from: -40, to: -20 }), rec("d-no-end", { from: -10, to: null }), rec("e-no-start", { from: null, to: -5 })],
  });
  assert.deepEqual(itemsOf(m).map((i) => i.jobId).sort(), ["b-straddle", "c-inside", "d-no-end", "e-no-start"]);
  const s = itemOf(m, "b-straddle");
  assert.equal(s.x, "0.00");
  assert.equal(s.w, "33.33", "from the window's start to its end, 30 of 90 minutes");
  assert.equal(itemOf(m, "d-no-end").w, "2.00", "an instant is a pill of the narrowest width");
  // A record dated after now (another host's clock) ends at now, never right of it.
  const ahead = timelineModel({ now: NOW, runs: [rec("f-ahead", { from: -10, to: 20 })] });
  assert.ok(Math.abs(Number(itemOf(ahead, "f-ahead").x) + Number(itemOf(ahead, "f-ahead").w) - 66.67) < 0.02);
});

test("each kind: completed, cancelled and answered are quiet; failed, refused, running, parked and held say what they are", () => {
  const m = timelineModel({
    now: NOW,
    runs: [
      rec("ok-1", { from: -170, to: -160 }),
      rec("cx-1", { outcome: "policy", reason: "operator-cancel", from: -150, to: -100 }),
      rec("ans-1", { reason: "awaiting-input", from: -170, to: -100 }),
      rec("fail-1", { outcome: "failed", reason: "agent-exit", from: -95, to: -90 }),
      rec("ref-1", { outcome: "policy", reason: "budget-day", from: -20, to: -20 }),
      rec("odd-1", { outcome: null, from: -150, to: -140 }),
      rec("park-1", { reason: "awaiting-input", from: -90, to: -60 }),
    ],
    active: [{ jobId: "run-1", queue: "pi-jobs", startedAt: t(-30), host: "build3" }],
    hostJobs: [{ name: "build3", jobs: [{ id: "run-1", p: "web", at: t(-30) }, { id: "orph-1", p: "web", at: t(-120), o: 1 }] }],
    parked: [{ jobId: "park-1", parkedAt: t(-60), answered: false }, { jobId: "ans-1", parkedAt: t(-100), answered: true }],
  });
  const kinds = Object.fromEntries(itemsOf(m).map((i) => [i.jobId, [i.kind, i.word]]));
  assert.deepEqual(kinds, {
    "ok-1": ["ok", "completed"],
    "cx-1": ["ok", "cancelled"],
    "ans-1": ["ok", "completed"],
    "fail-1": ["failed", "failed"],
    "ref-1": ["refused", "refused"],
    "odd-1": ["failed", "outcome not known"],
    "park-1": ["parked", "awaiting input"],
    "run-1": ["run", "running"],
    "orph-1": ["held", null],
  });
  assert.equal(itemOf(m, "cx-1").title, "cx-1 acme/web#1: cancelled, 13:09 to 13:59 UTC");
  assert.equal(itemOf(m, "ans-1").title, "ans-1 acme/web#1: asked a question at 13:59 UTC, answered since");
  assert.equal(itemOf(m, "ref-1").title, "ref-1 acme/web#1: refused at 15:19 UTC");
  assert.equal(itemOf(m, "ref-1").glyph, "refused");
  assert.equal(itemOf(m, "run-1").title, "run-1: running on build3 since 15:09 UTC");
  assert.equal(itemOf(m, "run-1").project, "web", "a running job's project is the registry's");
  assert.equal(itemOf(m, "park-1").title, "park-1 acme/web#1: awaiting input since 14:39 UTC");
  assert.equal(itemOf(m, "park-1").tailX, (Number(itemOf(m, "park-1").x) + Number(itemOf(m, "park-1").w)).toFixed(2), "the tail starts where the pill ends");
  assert.equal(itemOf(m, "orph-1").title, "orph-1: still holds a build3 slot, since 13:39 UTC");
  assert.deepEqual(rowOf(m, "web").counts, { completed: 2, cancelled: 1, failed: 2, refused: 1, parked: 1, running: 1, held: 1, waiting: 0 });
});

test("a recovery end the worker records as policy is a failure's pill, said failed, as every surface says it (issue #737)", () => {
  const ends = ["recovery-cap", "recovery-checkpoint-absent", "recovery-unsafe-extensions"];
  const m = timelineModel({ now: NOW, runs: [...ends.map((reason, i) => rec(`rc-${i}`, { outcome: "policy", reason, from: -150 + 30 * i, to: -140 + 30 * i })), rec("ref-2", { outcome: "policy", reason: "scope-cap", from: -20, to: -20 })] });
  const kinds = Object.fromEntries(itemsOf(m).map((i) => [i.jobId, [i.kind, i.word]]));
  assert.deepEqual(kinds, { "rc-0": ["failed", "failed"], "rc-1": ["failed", "failed"], "rc-2": ["failed", "failed"], "ref-2": ["refused", "refused"] });
  for (const id of ["rc-0", "rc-1", "rc-2"]) assert.match(itemOf(m, id).title, /: failed, /, id);
  assert.deepEqual(rowOf(m, "web").counts, { completed: 0, cancelled: 0, failed: 3, refused: 1, parked: 0, running: 0, held: 0, waiting: 0 });
});

test("a held slot folds in its own record, and a running job is never also held", () => {
  const m = timelineModel({
    now: NOW,
    runs: [rec("gh-4a7e", { outcome: "policy", reason: "operator-cancel", from: -298, to: -280 })],
    active: [{ jobId: "both", queue: "pi-jobs", startedAt: t(-20), host: "build3" }],
    hostJobs: [{ name: "build3", jobs: [{ id: "gh-4a7e", p: null, at: t(-298), o: true }, { id: "both", p: "web", at: t(-20), o: true }, { id: "container:pi-x", p: null, at: t(-50), o: true }] }],
  });
  const held = itemOf(m, "gh-4a7e");
  assert.equal(held.kind, "held");
  assert.equal(held.project, "web", "the record's project when the registry names none");
  assert.equal(held.title, "gh-4a7e acme/web#1: cancelled at 10:59 UTC; still holds a build3 slot");
  assert.deepEqual(held.label, { text: "gh-4a7e", sub: "cancelled 10:59, still holds a build3 slot", side: "in" });
  assert.equal(itemOf(m, "both").kind, "run");
  // A record whose outcome is not known ended all the same: the pill says when it ended, the title that its outcome is
  // not known ("outcome not known 10:59" read as the outcome turning unknown then).
  const odd = timelineModel({ now: NOW, runs: [rec("gh-4a7e", { outcome: null, from: -298, to: -280 })], hostJobs: [{ name: "build3", jobs: [{ id: "gh-4a7e", p: "web", at: t(-298), o: true }] }] });
  assert.deepEqual(itemOf(odd, "gh-4a7e").label, { text: "gh-4a7e", sub: "ended 10:59, still holds a build3 slot", side: "in" });
  assert.equal(itemOf(odd, "gh-4a7e").title, "gh-4a7e acme/web#1: ended at 10:59 UTC, outcome not known; still holds a build3 slot");
  const container = itemOf(m, "container:pi-x");
  assert.equal(container.kind, "held");
  assert.equal(rowOf(m, NO_PROJECT_TEXT), m.rows.at(-1), "no project, last");
});

test("a park older than the day is still drawn: no pill, its tail from the window's start", () => {
  const m = timelineModel({ now: NOW, parked: [{ jobId: "gh-old", target: "acme/web#9", parkedAt: t(-2000), answered: false, project: "web" }] });
  const p = itemOf(m, "gh-old");
  assert.equal(p.kind, "parked");
  assert.equal(p.pill, false);
  assert.equal(p.tailX, "0.00");
  assert.equal(p.title, "gh-old acme/web#9: awaiting input since 2026-10-24 06:19 UTC", "an instant on another day carries its date");
  const out = draw(m);
  assert.ok(out.includes(`<line class="tail" x1="0.00%" x2="66.67%" y1="28" y2="28"><title>gh-old acme/web#9: awaiting input since 2026-10-24 06:19 UTC</title></line>`), "the tail carries the title");
  assert.ok(!out.includes(`class="tp--parked"`));
  assert.ok(out.includes(`<text class="tail-t" x="0.00%" dx="6" y="20">${PARKED_TAIL_TEXT}</text>`));
});

test("a park too short for its id keeps its id and its words before its pill, never its words alone over the tail", () => {
  // Parked an hour ago after a minute's run: the pill (the narrowest, 12 px) holds no id, and the tail has room for
  // the words. The words alone would leave the pill unnamed; before the pill there is room for both.
  const m = timelineModel({ now: NOW, runs: [rec("gh-p1", { reason: "awaiting-input", from: -61, to: -60 })], parked: [{ jobId: "gh-p1", parkedAt: t(-60), answered: false }] });
  const p = itemOf(m, "gh-p1");
  assert.equal(p.w, "2.00");
  assert.deepEqual(p.label, { text: "gh-p1", sub: PARKED_TAIL_TEXT, side: "before" });
  assert.equal(p.tailText, null, "its words once");
});

test("a refusal is a circle at the instant it was refused, its record's end", () => {
  const m = timelineModel({ now: NOW, runs: [rec("gh-r", { outcome: "policy", reason: "scope-cap", from: -120, to: -60 })] });
  const r = itemOf(m, "gh-r");
  assert.equal(r.x, "44.44", "an hour ago, not two");
  assert.equal(r.startAt, t(-60));
  assert.equal(r.title, "gh-r acme/web#1: refused at 14:39 UTC");
});

/**
 * Where a park's words end, in percent of the lane: its label's right edge (the pill's end for one inside it, 8 px
 * before the pill for one before it) and its tail words' (6 px into the tail, 11 px letters), by the module's own
 * estimates on the narrowest lane, 596 px.
 */
function parkEnds(it) {
  const pc = (px) => (px / 596) * 100;
  const ends = [];
  if (it.label !== null) ends.push(it.label.side === "in" ? Number(it.x) + Number(it.w) : it.label.side === "before" ? Number(it.x) - pc(8) : Number.POSITIVE_INFINITY);
  if (it.tailText !== null) ends.push(Number(it.tailX) + pc(6 + it.tailText.length * 5.8));
  return ends;
}

for (const zoom of Object.keys(TIMELINE_ZOOMS)) {
  test(`at ${zoom} no park's label or words reach past now, and a park says it waits for you where there is room`, () => {
    // One park a project, so each has its row to itself: parked just now, minutes ago, hours ago, before the window.
    const ages = [0, 1, 5, 12, 26, 40, 75, 150, 400, 900, 3000];
    const runs = ages.map((a, i) => rec(`park-${i}`, { project: `p${i}`, reason: "awaiting-input", from: -a - 10, to: -a }));
    const m = timelineModel({ now: NOW, zoom, runs, parked: ages.map((a, i) => ({ jobId: `park-${i}`, parkedAt: t(-a), answered: false })) });
    const nowX = Number(m.nowX);
    // As drawn: every tail's words end before now.
    const out = draw(m);
    for (const [, x, words] of out.matchAll(/<text class="tail-t" x="([\d.]+)%" dx="6" y="20">([^<]*)<\/text>/g)) {
      const end = Number(x) + ((6 + words.length * 5.8) / 596) * 100;
      assert.ok(end <= nowX, `at ${zoom} a tail's words drawn from ${x}% end at ${end.toFixed(2)}%, now is at ${nowX}%`);
    }
    ages.forEach((age, i) => {
      const it = itemOf(m, `park-${i}`);
      assert.notEqual(it.label?.side, "after", `park-${i}: nothing right of its pill`);
      for (const end of parkEnds(it)) assert.ok(end <= nowX, `${age} minutes old at ${zoom}: its words end at ${end.toFixed(2)}%, now is at ${nowX}%`);
      assert.ok(it.tailText === null || it.label?.sub !== PARKED_TAIL_TEXT, "its words once");
    });
    // The newest park's pill is at now, with no tail to write on: its id and its words go before it.
    assert.deepEqual(itemOf(m, "park-0").label, { text: "park-0", sub: PARKED_TAIL_TEXT, side: "before" });
    assert.equal(itemOf(m, "park-0").tailText, null);
    // One older than the window has no pill: its tail runs from the window's start, and its words sit on it.
    assert.equal(itemOf(m, "park-10").tailText, PARKED_TAIL_TEXT);
    // The markup draws the same: words over a tail only where the model put them, and the before label in the parked ink.
    assert.equal((out.match(/class="tail-t"/g) ?? []).length, itemsOf(m).filter((it) => it.tailText !== null).length);
    assert.equal((out.match(/class="tp-l tp-l--out-parked"/g) ?? []).length, itemsOf(m).filter((it) => it.label?.side === "before").length);
  });
}

test("an item of any kind left without a label is drawn as its shape alone, never a throw: refusals seconds apart in one crowded row", () => {
  const now = Date.UTC(2026, 9, 8, 16, 0);
  const r = (jobId, outcome, reason, endAgoS) => ({ jobId, kind: "github", target: "acme/web#1", project: "web", host: "mini1", outcome, reason, startedAt: now - endAgoS * 1000 - 30_000, endedAt: now - endAgoS * 1000, parentJobId: null });
  for (const runs of [
    [r("gh-a001", "policy", "dollar-cap", 137), r("gh-a002", "policy", "dollar-cap", 159)],
    [r("gh-a001", "policy", "dollar-cap", 137), r("gh-a002", "policy", "dollar-cap", 159), r("gh-a003", "policy", "soft-hold", 879)],
    [r("gh-a001", "policy", "dollar-cap", 137), r("gh-a002", "policy", "dollar-cap", 159), r("gh-a003", "policy", "soft-hold", 878), r("gh-a004", "policy", "soft-hold", 880), r("gh-a005", "failed", "worker-error", 883)],
    [r("gh-a003", "policy", "soft-hold", 878), r("gh-a004", "policy", "soft-hold", 880), r("gh-a006", "policy", "soft-hold", 881), r("gh-a005", "failed", "worker-error", 883)],
  ]) {
    const m = timelineModel({ now, runs: { runs, floor: null, partial: false } });
    const out = draw(m, "t");
    for (const it of itemsOf(m).filter((i) => i.kind === "refused")) assert.ok(out.includes(`<title>${it.title}</title></circle>`), `${it.jobId}: its circle`);
  }
  // Every kind, each item's label taken away: each draws its shape and no label text.
  const parts = cardSample();
  const m = timelineModel({ ...parts, runs: [...parts.runs, rec("gh-f1", { outcome: "failed", reason: "worker-error", from: -40, to: -35 })] });
  assert.deepEqual([...new Set(itemsOf(m).map((i) => i.kind))].sort(), [...TIMELINE_KINDS].sort(), "the sample holds every kind");
  const bare = { ...m, rows: m.rows.map((row) => ({ ...row, lanes: row.lanes.map((lane) => lane.map((i) => ({ ...i, label: null }))) })) };
  const out = draw(bare);
  assert.doesNotMatch(out, /<text class="tp-l/, "no label is drawn");
  for (const cls of ["tp--ok", "tp--failed", "tp--run", "tp--parked", "tp--held", "tp--wait"]) assert.ok(out.includes(`<rect class="${cls}"`), cls);
  assert.ok(out.includes(`<circle class="tp-ref"`), "the refusal's circle");
});

test("an item of a kind the timeline does not draw is a programming error, with a label and without one, never drawn as another kind", () => {
  for (const label of [null, { text: "x", sub: null, side: "in" }]) {
    const m = timelineModel({ now: NOW, runs: [rec("gh-a1", { from: -40, to: -35 })] });
    const item = itemsOf(m)[0];
    item.kind = "zz";
    item.label = label;
    assert.throws(() => timelineHtml(m, { label: "t" }), RangeError, JSON.stringify(label));
  }
});

test("waiting jobs: from now or their due time to the end, a glyph and words per bucket", () => {
  // Each waiting job runs to the window's end, so each takes a lane of its own: one project each keeps them all drawn.
  const rows = [
    wait("w-slot", { due: null, host: null, project: "p1" }),
    wait("w-run", { bucket: "run", why: "chained", due: 2, holder: "elsewhere-1", project: "p2" }),
    wait("w-check", { bucket: "check", why: "wait-hold", due: 30, project: "p3" }),
    wait("w-retry", { bucket: "retry", why: "retry", due: 4, attempt: 2, attempts: 3, project: "p4" }),
    wait("w-pause", { bucket: "pause", why: "pause-window", due: 50, until: 50, project: "p5" }),
    wait("w-ready", { bucket: "ready", why: "podman-restart", due: 1, project: "p6" }),
    wait("w-paused", { bucket: "paused", why: null, due: null, queue: "pi-jobs@build3", host: null, project: "p7" }),
    wait("w-none", { bucket: "none", why: null, known: false, due: 3, project: "p8" }),
    wait("w-new", { bucket: "unknown", why: "newer-reason", known: false, due: 3, project: "p9" }),
    wait("w-sched", { bucket: "due", why: null, known: false, due: -4, schedulerNext: true, project: "p10" }),
    wait("w-due", { bucket: "retry", why: "retry", due: -2, project: "p11" }),
    wait("w-late", { bucket: "due", why: "host-slot", due: -3, project: "p12" }),
  ];
  const m = timelineModel({ now: NOW, waiting: { rows } });
  const by = Object.fromEntries(itemsOf(m).map((i) => [i.jobId, i]));
  // A scheduler's next run is in the rows once it is overdue (the reader keeps the others in `scheduled`): in line.
  assert.ok("w-sched" in by, "a row is in line, a scheduler's next run among them");
  for (const [id, glyph] of Object.entries({ "w-slot": "slot", "w-run": "chain", "w-check": "clock", "w-retry": "rerun", "w-pause": "pause", "w-ready": "hourglass", "w-paused": "queue", "w-late": "bell", "w-new": "tag", "w-none": "info" })) {
    assert.equal(by[id].glyph, glyph, id);
    assert.equal(by[id].kind, "wait");
    assert.equal(Number(by[id].x) + Number(by[id].w), 100, `${id} runs to the end`);
  }
  assert.equal(by["w-slot"].title, "w-slot: waits for a free slot");
  assert.equal(by["w-run"].title, "w-run: starts after elsewhere-1, due at 15:41 UTC");
  assert.equal(by["w-retry"].title, "w-retry: attempt 2 of 3, due at 15:43 UTC");
  assert.equal(by["w-pause"].title, "w-pause: in a pause window until 16:29 UTC");
  assert.equal(by["w-ready"].title, "w-ready: waits for build3 to get ready, due at 15:40 UTC");
  assert.equal(by["w-paused"].title, "w-paused: its queue pi-jobs@build3 is paused");
  assert.equal(by["w-none"].title, "w-none: no reason was recorded, due at 15:42 UTC");
  assert.equal(by["w-new"].title, "w-new: newer-reason, no explanation yet, due at 15:42 UTC");
  // Past its due with no worker taking it: due since then, whatever it recorded, and no "due now" after it.
  assert.equal(by["w-late"].title, "w-late: due since 15:36 UTC; no worker has taken it");
  assert.equal(by["w-sched"].title, "w-sched: due since 15:35 UTC; no worker has taken it");
  assert.equal(by["w-late"].label.sub, "due since 15:36");
  assert.equal(by["w-late"].x, "68.17", "a job past its due starts just right of now");
  assert.equal(by["w-due"].title, "w-due: waits to retry, due now");
  assert.equal(by["w-due"].x, "68.17", "a job already due starts just right of now");
  assert.equal(by["w-new"].label.sub, "newer-reason", "an unknown reason shows its raw token");
  assert.equal(by["w-retry"].label.sub, "retry in 4m");
  assert.equal(by["w-due"].label.sub, "retry due now");
  // The waiting jobs' own reader shapes: a list, `{ rows }`, `{ unreachable: true }` and null.
  assert.equal(itemsOf(timelineModel({ now: NOW, waiting: rows })).length, rows.length);
  assert.equal(itemsOf(timelineModel({ now: NOW, waiting: { unreachable: true } })).length, 0);
  assert.equal(itemsOf(timelineModel({ now: NOW, waiting: null })).length, 0);
  // A job whose project is not known yet says so, and sits in the "no project" row.
  const unknown = timelineModel({ now: NOW, waiting: [wait("w-p", { project: null })] });
  assert.match(itemOf(unknown, "w-p").title, /; its project is not known until it starts$/);
  assert.equal(unknown.rows[0].label, NO_PROJECT_TEXT);
  // Its head is a tag as the projects' heads are, in the muted ink: a row of no project, not a project named so.
  assert.ok(draw(unknown).includes(`<span class="tl__h tl__h--first"><span class="ptag"><span class="muted">${NO_PROJECT_TEXT}</span></span></span>`));
});

test("a waiting pill too narrow for what it waits for in full still says it in a word", () => {
  // Due now, a pill starts at the lead and is 31.83% of the narrowest lane (190 px): beside its glyph and a
  // 10-character id it holds about ten characters more, so no bucket's specific or short line, and every bucket's word.
  // The same holds at a bucket's start, which holds the word and a time's room beside such a name and no more.
  const why = { slot: "host-slot", run: "chained", check: "wait-hold", retry: "retry", pause: "pause-window", ready: "podman-restart", paused: null, due: null, unknown: "brand-new-why-word", none: null };
  const buckets = Object.keys(TIMELINE_WAIT_WORDS);
  const rows = buckets.map((b, i) => wait(`local-w${i}aa`, { bucket: b, why: why[b], known: b !== "unknown", due: null, holder: b === "run" ? "gh-b3d7" : null, attempt: b === "retry" ? 2 : null, attempts: b === "retry" ? 3 : null, queue: b === "paused" ? "pi-jobs@build3" : "pi-jobs", project: `p${i}` }));
  const m = timelineModel({ now: NOW, waiting: rows });
  buckets.forEach((b, i) => {
    const it = itemOf(m, `local-w${i}aa`);
    assert.equal(it.w, "31.83", b);
    assert.deepEqual(it.label, { text: `local-w${i}aa`, sub: TIMELINE_WAIT_WORDS[b].word, side: "in" }, b);
  });
  // A reason this console has no words for is its token where the token fits, else its bucket's words, which are true of
  // it (above); never "no reason", which would say none was recorded.
  const token = timelineModel({ now: NOW, waiting: [wait("gh-w9aa", { bucket: "unknown", why: "new-why", known: false, due: null })] });
  assert.deepEqual(itemOf(token, "gh-w9aa").label, { text: "gh-w9aa", sub: "new-why", side: "in" });
  // Where the whole line fits, it is the line: the card's retry, due in 4 minutes.
  assert.equal(itemOf(timelineModel(cardSample()), "gh-71b2").label.sub, "retry in 4m");
});

/** The narrowest lane, px (`.tl` at its 720 px minimum less the 124 px heads), and a width in percent of it as px. */
const TRACK = 596;
const px = (pct) => (Number(pct) / 100) * TRACK;
/** What Chrome draws a character of the mono id face as (12 px, 600, the system stack), px. */
const MONO_DRAWN = 7.23;
/**
 * What Chrome draws each bucket's line and word as (12 px, 500, the system stack on macOS), px, and its word with a due
 * time as a pill moved left of its due writes it (the digits are tabular, so every time is drawn as wide as `00:00`).
 */
const DRAWN = {
  "needs a free slot": 96.2, "after another run": 98, "held on a check": 90.5, "retry backoff": 74.9, "pause window": 82.1,
  "host getting ready": 105.9, "queue paused": 81.4, "due, not taken": 82.9, "unknown reason": 94.5, "no reason recorded": 112.4,
  slot: 21.4, "after run": 50, check: 34.6, retry: 27.8, window: 44, "not ready": 54.8, paused: 42.4, due: 21.7, unknown: 52, "no reason": 56.9,
  "slot 00:00": 59.4, "after run 00:00": 87.9, "check 00:00": 72.6, "retry 00:00": 65.7, "window 00:00": 81.9, "not ready 00:00": 92.8,
  "paused 00:00": 80.3, "due 00:00": 59.6, "unknown 00:00": 90, "no reason 00:00": 94.8,
  "slot in 0d 0h": 71.8, "after run in 0d 0h": 100.3, "check in 0d 0h": 85, "retry in 0d 0h": 78.1, "window in 0d 0h": 94.3,
  "not ready in 0d 0h": 105.2, "paused in 0d 0h": 92.7, "due in 0d 0h": 72, "unknown in 0d 0h": 102.4, "no reason in 0d 0h": 107.2,
};
/** A line as `DRAWN` keys it: its digits as zeros. */
const drawnOf = (line) => DRAWN[line.replace(/[0-9]/g, "0")];
/** Rows with nothing for a bucket's specific line, so a pill says its bucket's short line or its word. */
const NO_LINE = { slot: { host: null }, run: {}, check: {}, retry: {}, pause: {}, ready: {}, paused: { host: null }, due: {}, unknown: { why: null }, none: { why: null } };
/** What a pill moved left of its due says its due time is: `HH:MM` within a day of now, else how far off it is. */
const dueSaid = (due) => (due < 24 * 60 ? new Date(t(due)).toISOString().slice(11, 16) : `in ${Math.floor(due / 1440)}d ${Math.floor((due % 1440) / 60)}h`);

for (const zoom of Object.keys(TIMELINE_ZOOMS)) {
  test(`at ${zoom} a waiting pill holds its glyph, its word and a name cut to fit, and one moved left of its due says its due time`, () => {
    const ahead = TIMELINE_ZOOMS[zoom].futureMs / MIN;
    // Due now, soon, across the window's future, in its last minutes, at its end, just past it, tomorrow morning and in
    // three days: a pill placed at its due time near the end was a sliver with no word on it, one drawn from now read
    // as one about to start, and one moved left with a word and no time read as one due where it was drawn.
    const dues = [null, 1, ahead * 0.25, ahead * 0.5, ahead * 0.67, ahead * 0.78, ahead * 0.83, ahead * 0.97, ahead - 1, ahead, ahead + 1, 15 * 60, 3 * 24 * 60 + 5];
    // Names of 7, 12, 13, 14 and 34 characters: from 12 a long name took its pill's word where the window's future was
    // narrow, at every zoom.
    const names = ["gh-71b2", "local-9e20ab", "local-9e20abc", "local-9e20abcd", "local-nightly-dependency-refresh-7"];
    let moved = 0;
    let atDue = 0;
    for (const [b, over] of Object.entries(NO_LINE)) {
      // A `due` row's due is past, always: it is drawn from now (the waiting jobs' test).
      if (b === "due") continue;
      const w = TIMELINE_WAIT_WORDS[b];
      for (const due of dues) {
        const m = timelineModel({ now: NOW, zoom, waiting: names.map((name, k) => wait(name, { bucket: b, why: null, known: true, due, project: `p${k}`, ...over })) });
        const nowX = Number(m.nowX);
        const lead = nowX + 1.5;
        const dueX = due === null ? nowX : Math.min(100, nowX + (due / ahead) * (100 - nowX));
        for (const name of names) {
          const it = itemOf(m, name);
          const at = `${b} ${name} due in ${due} minutes at ${zoom}`;
          assert.equal(it.glyph, w.glyph, at);
          assert.equal(Number(it.x) + Number(it.w), 100, `${at}: it runs to the window's end`);
          // Never right of its due time, but for the lead right of now that shows the gap before a job due now.
          assert.ok(Number(it.x) > nowX && Number(it.x) <= Math.max(dueX, lead) + 0.01, `${at}: it starts between now and its due time (${it.x})`);
          if (Number(it.x) < dueX - 0.01) {
            // Moved left of its due: its start is not when it starts, so it says when, beside its word.
            moved += 1;
            assert.equal(it.label.sub, `${w.word} ${dueSaid(due)}`, `${at}: it says its word and its due time`);
          } else {
            atDue += 1;
            // Its short line or its word; a retry, a check and a pause window with a due time to come have a line of
            // their own that says when.
            const own = { retry: /^retry in \d/, check: /^checks again in \d/, pause: /^paused until \d\d:\d\d$/ }[b] ?? null;
            assert.ok([w.short, w.word].includes(it.label.sub) || own?.test(it.label.sub), `${at}: it says what it waits for (${it.label.sub})`);
          }
          // The name gives way, never the word: whole, or its start with an ellipsis, at least a job id's ten
          // characters (a forge id's seven, whole) but where the pill starts at now, short of a future too narrow for
          // more, or is due more than a day off, whose time ("in 3d 0h") is wider than the HH:MM its bucket's start holds.
          const text = it.label.text;
          assert.ok(text === name || (text.endsWith("…") && name.startsWith(text.slice(0, -1))) || text === "", `${at}: ${text}`);
          assert.ok(Array.from(text).length <= 14, `${at}: ${text}`);
          if (Math.abs(Number(it.x) - lead) >= 0.01 && (due === null || due < 24 * 60)) assert.ok(Array.from(text).length >= Math.min(name.length, 10), `${at}: ${text}`);
          if (drawnOf(it.label.sub) !== undefined) {
            const end = 28 + Array.from(text).length * MONO_DRAWN + 6 + drawnOf(it.label.sub);
            assert.ok(end + 4 <= px(it.w), `${at}: its label ends at ${end.toFixed(1)} px of a ${px(it.w).toFixed(1)} px pill`);
          }
          assert.ok(it.title.startsWith(`${name}: `), `${at}: its title names it whole`);
          assert.equal(it.dep, due === null ? null : "gap", `${at}: the gap from now says it waits`);
        }
      }
    }
    assert.ok(moved > 0 && atDue > 0, `${zoom}: some drawn at their due (${atDue}), some moved (${moved})`);
  });
}

test("a waiting pill is drawn at its due up to its bucket's start; one due later stands there and says when", () => {
  // The card's gh-77c1, a check due tomorrow at 07:00: drawn in the window's last minutes, it says "check 07:00",
  // where with its word alone it read as a check at the time it was drawn at.
  const tomorrow = Date.parse("2026-10-26T07:00:00Z");
  const due = (tomorrow - NOW) / MIN;
  for (const zoom of Object.keys(TIMELINE_ZOOMS)) {
    const it = itemOf(timelineModel({ now: NOW, zoom, waiting: [wait("gh-77c1", { bucket: "check", why: "wait-hold", due })] }), "gh-77c1");
    assert.deepEqual(it.label, { text: "gh-77c1", sub: "check 07:00", side: "in" }, zoom);
    assert.equal(it.title, "gh-77c1: waits on a time or a check, due at 2026-10-26 07:00 UTC");
  }
  // At 3h a check due in 20 minutes is past check's start, so it stands there and says when, whatever its name's
  // length: the start is held for a job id's ten characters, so a longer name is cut there and a shorter one never
  // moves it. A local job keeps its whole id where it is moved, not "local-…" for every one.
  for (const name of ["gh-71b2", "local-9e20", "local-9e20abcd", "local-nightly-dependency-refresh-7"]) {
    const it = itemOf(timelineModel({ now: NOW, waiting: [wait(name, { bucket: "check", why: null, due: 20 })] }), name);
    assert.equal(it.x, "68.27", `${name}: at check's start`);
    assert.deepEqual(it.label, { text: name.length <= 10 ? name : `${name.slice(0, 9)}…`, sub: "check 15:59", side: "in" }, name);
  }
  // Before its bucket's start it stands at its due, the axis saying when, and says what it waits for: a slot due in 8
  // minutes at 3h, whatever its name; due in 10, past the slot's start, it stands there and says its time.
  for (const name of ["gh-71b2", "local-9e20", "local-9e20abcd"]) {
    const at = itemOf(timelineModel({ now: NOW, waiting: [wait(name, { why: "host-slot", host: null, due: 8 })] }), name);
    assert.deepEqual([at.x, at.label.sub], ["69.63", "slot"], `${name}: at its due`);
    const moved = itemOf(timelineModel({ now: NOW, waiting: [wait(name, { why: "host-slot", host: null, due: 10 })] }), name);
    assert.deepEqual([moved.x, moved.label.sub], ["70.18", "slot 15:49"], `${name}: at the slot's start`);
  }
  assert.deepEqual(itemOf(timelineModel({ now: NOW, waiting: [wait("local-aa01", { bucket: "check", why: "wait-hold", due })] }), "local-aa01").label, { text: "local-aa01", sub: "check 07:00", side: "in" });
  // One more than a day off says how far, which a time alone would put on the wrong day.
  const far = itemOf(timelineModel({ now: NOW, zoom: "24h", waiting: [wait("gh-a1", { bucket: "pause", why: "pause-window", due: 2 * 1440 + 4 * 60 + 30 })] }), "gh-a1");
  assert.equal(far.label.sub, "window in 2d 4h");
  // Where the word and the time leave room for less of the name, the name gives way; where they leave none, to none,
  // the word and the time still said: the title has the name.
  const narrow = itemOf(timelineModel({ now: NOW, zoom: "1h", waiting: [wait("gh-71b2", { bucket: "none", why: null, known: false, due: 400 * 1440 })] }), "gh-71b2");
  assert.deepEqual(narrow.label, { text: "g…", sub: "no reason in 400d 0h", side: "in" });
  const none = itemOf(timelineModel({ now: NOW, zoom: "1h", waiting: [wait("gh-71b2c3d4e5f6", { bucket: "ready", why: null, due: 40000 * 1440 })] }), "gh-71b2c3d4e5f6");
  assert.deepEqual(none.label, { text: "", sub: "not ready in 40000d 0h", side: "in" });
  assert.ok(none.title.startsWith("gh-71b2c3d4e5f6: "));
});

for (const zoom of Object.keys(TIMELINE_ZOOMS)) {
  test(`at ${zoom} the order of waiting pills by their due is their order by x: within a bucket whatever their names, across buckets only near now`, () => {
    const ahead = TIMELINE_ZOOMS[zoom].futureMs / MIN;
    // Due now, across the window's future minute by minute near now and in steps after, at and past its end, later
    // today, tomorrow, in days and in a year: a start that hung on the pill's own name or time put a job due later left
    // of one due before it (a seven-character id against a ten-character one; "in 2d 4h" against "07:00").
    const near = Array.from({ length: 21 }, (_, k) => (ahead * 0.1 * k) / 20);
    const dues = [null, ...near, ...Array.from({ length: 19 }, (_, k) => ahead * (0.1 + (0.9 * (k + 1)) / 19)), ahead + 1, 15 * 60, 24 * 60 - 1, 24 * 60 + 1, 3 * 1440 + 5, 12 * 1440 + 23 * 60, 400 * 1440];
    const names = ["g1", "gh-71b2", "local-9e20", "local-9e20abcd", "local-nightly-dependency-refresh-7"];
    const all = [];
    let nowX = null;
    for (const [b, over] of Object.entries(NO_LINE)) {
      // A `due` row's due is past, always: it is drawn from now (the waiting jobs' test).
      if (b === "due") continue;
      const series = [];
      for (const name of names) {
        for (const due of dues) {
          const m = timelineModel({ now: NOW, zoom, waiting: [wait(name, { bucket: b, why: null, known: true, due, ...over })] });
          nowX = Number(m.nowX);
          const it = itemOf(m, name);
          const dueX = due === null ? nowX : Math.min(100, nowX + (due / ahead) * (100 - nowX));
          series.push({ b, name, due: due ?? 0, x: Number(it.x), moved: Number(it.x) < dueX - 0.01 });
        }
      }
      series.sort((p, q) => p.due - q.due);
      for (let k = 1; k < series.length; k += 1) {
        const [p, q] = [series[k - 1], series[k]];
        assert.ok(q.x >= p.x, `${b}: ${q.name} due in ${q.due} minutes at ${q.x}, left of ${p.name} due in ${p.due} at ${p.x}`);
      }
      all.push(...series);
    }
    // Across buckets the starts differ by the words' widths, so a pill due later can stand left of one of another bucket
    // due before it: only moved (it says its time), and only between the lead and the latest bucket start, the slot's.
    const lead = nowX + 1.5;
    const latest = Math.max(...all.filter((p) => p.moved).map((p) => p.x));
    assert.equal(latest, Math.max(...all.filter((p) => p.b === "slot" && p.moved).map((p) => p.x)), "the slot's start is the latest");
    assert.ok(latest - lead < 2.1, `the starts span ${(latest - lead).toFixed(2)} points right of the lead`);
    for (const b of ["run", "pause", "ready", "paused", "unknown", "none"]) {
      assert.deepEqual([...new Set(all.filter((p) => p.b === b && p.moved).map((p) => p.x.toFixed(2)))], [lead.toFixed(2)], `${b}: its word is wide enough that its start is the lead`);
    }
    all.sort((p, q) => p.due - q.due);
    let before = -Infinity;
    for (let k = 0; k < all.length; ) {
      let j = k;
      while (j < all.length && all[j].due === all[k].due) j += 1;
      for (let n = k; n < j; n += 1) {
        const q = all[n];
        if (q.x < before) assert.ok(q.moved && q.x >= lead - 0.01 && before <= latest + 0.01, `${q.b} ${q.name} due in ${q.due} at ${q.x}, left of one due before it at ${before}`);
      }
      for (let n = k; n < j; n += 1) before = Math.max(before, all[n].x);
      k = j;
    }
  });
}

test("a waiting label ends at least 4 px before its pill's end, by the widths Chrome draws its lines", () => {
  // The estimate the module fits a label by is never under what Chrome draws, on the narrowest lane, at any width a
  // pill takes.
  for (const [b, w] of Object.entries(TIMELINE_WAIT_WORDS)) assert.ok(w.short in DRAWN && w.word in DRAWN, `${b}'s words are measured here`);
  // Rows with nothing for the specific line, so a pill says its bucket's line, its word, or its word and its due time;
  // ids of every length a pill writes and due times across the window make every width between a full line and none.
  let seen = 0;
  for (const [b, over] of Object.entries(NO_LINE)) {
    for (const due of [null, 2, 6, 10, 15, 20, 25, 30, 45, 89, 600]) {
      // A due time to come gives the check, retry, pause and due buckets a line of their own (with a time) where they
      // are drawn at their due: those are the specific lines, not this table's.
      const rows = Array.from({ length: 14 }, (_, n) => wait(`g${"0123456789abcd".slice(0, n)}`, { bucket: b, why: null, known: true, due, project: `p${n}`, ...over }));
      for (let from = 0; from < rows.length; from += TIMELINE_ROWS_MAX) {
        const m = timelineModel({ now: NOW, waiting: rows.slice(from, from + TIMELINE_ROWS_MAX) });
        for (const it of itemsOf(m)) {
          const sub = it.label.sub;
          if (drawnOf(sub) === undefined) {
            assert.ok(due !== null && ["check", "retry", "pause", "due"].includes(b), `${b}: ${sub} is one of the measured lines`);
            continue;
          }
          const end = 28 + Array.from(it.label.text).length * MONO_DRAWN + 6 + drawnOf(sub);
          assert.ok(end + 4 <= px(it.w), `${b} ${it.jobId}: its label ends at ${end.toFixed(1)} px of a ${px(it.w).toFixed(1)} px pill`);
          seen += 1;
        }
      }
    }
  }
  assert.ok(seen > 100, "lines and words were drawn");
});

test("a cron trigger's run is named by its trigger and its time on its pill, its id whole in its title", () => {
  const slot = Date.parse("2026-10-25T15:00:00Z");
  const id = `repeat:hourly-sync:${slot}`;
  const m = timelineModel({ now: NOW, waiting: [wait(id, { bucket: "due", why: null, known: false, due: -39, schedulerNext: true })] });
  const it = itemOf(m, id);
  assert.deepEqual(it.label, { text: "hourly-sync", sub: "15:00 run", side: "in" });
  assert.equal(it.title, `${id} (hourly-sync, 15:00 UTC run): due since 15:00 UTC; no worker has taken it`);
  assert.doesNotMatch(draw(m), /<text[^>]*>repeat:/, "the id is not written on the pill");
  // A run whose slot no date can show is named by its trigger alone, and says what it waits for.
  const far = `repeat:hourly-sync:9999999999999999`;
  const odd = itemOf(timelineModel({ now: NOW, waiting: [wait(far, { bucket: "due", why: null, known: false, due: -39 })] }), far);
  assert.equal(odd.label.text, "hourly-sync");
  assert.notEqual(odd.label.sub, null);
  assert.ok(odd.title.startsWith(`${far} (hourly-sync, a run): `));
  // Any other id is its own name.
  assert.equal(itemOf(timelineModel({ now: NOW, waiting: [wait("gh-71b2")] }), "gh-71b2").label.text, "gh-71b2");
});

test("an arrow leads from a blocker in the same lane; a dotted gap to a due time to come; nothing else", () => {
  const base = {
    now: NOW,
    active: [{ jobId: "parent", queue: "pi-jobs", startedAt: t(-60), host: "build3" }],
    hostJobs: [{ name: "build3", jobs: [{ id: "parent", p: "web", at: t(-60) }, { id: "orphan", p: "web", at: t(-100), o: true }] }],
  };
  const m = timelineModel({
    ...base,
    waiting: [
      wait("chained", { bucket: "run", why: "chained", due: 2, holder: "parent" }),
      wait("full-a", { why: "host-slot", due: 1 }),
      wait("full-b", { why: "host-budget", due: null }),
      wait("folder", { why: "scope-folder", due: 3 }),
    ],
  });
  const row = rowOf(m, "web");
  const chained = itemOf(m, "chained");
  assert.equal(chained.dep, "arrow");
  assert.equal(laneOf(row, "chained"), laneOf(row, "parent"), "packed beside its blocker");
  assert.equal(chained.depX, "66.67", "from the blocker's end, which is now");
  assert.equal(chained.label.sub, "after this run");
  // Due later than its bucket's start (for `run`, the lead itself), it stands there beside its blocker, and says when.
  const later = itemOf(timelineModel({ ...base, waiting: [wait("chained", { bucket: "run", why: "chained", due: 5, holder: "parent" })] }), "chained");
  assert.deepEqual([later.dep, later.x, later.label.sub], ["arrow", "68.17", "after run 15:44"]);
  const full = itemOf(m, "full-a");
  assert.equal(full.dep, "arrow", "a full host's job waits on the orphan holding a slot there");
  assert.equal(laneOf(row, "full-a"), laneOf(row, "orphan"));
  assert.equal(full.label.sub, "needs this slot");
  // The orphan's lane already holds one waiting job, so the second full-host job cannot sit beside it: no arrow, and
  // it is due at no time, so no gap either.
  assert.notEqual(laneOf(row, "full-b"), laneOf(row, "orphan"));
  assert.equal(itemOf(m, "full-b").dep, null);
  assert.equal(itemOf(m, "folder").dep, "gap", "a folder's limit is not freed by an orphan's slot");
  assert.equal(itemOf(m, "folder").depX, "66.67");
  // A blocker on another row draws no arrow.
  const apart = timelineModel({ ...base, waiting: [wait("other", { bucket: "run", why: "chained", due: 5, holder: "parent", project: "api" })] });
  assert.equal(itemOf(apart, "other").dep, "gap");
  // A job past its due waits on nothing its record named any more: no arrow from the run the record named, nor from
  // an orphan's slot, and it says it is due.
  const late = timelineModel({ ...base, waiting: [wait("late-run", { bucket: "due", why: "chained", due: -1, holder: "parent" }), wait("late-slot", { bucket: "due", why: "host-slot", due: -2 })] });
  for (const id of ["late-run", "late-slot"]) {
    assert.equal(itemOf(late, id).dep, null, id);
    assert.match(itemOf(late, id).label.sub, /^due/, id);
  }
  const out = draw(m);
  // The two leads are drawn by `timelineHtml` itself, whose text the TimelineAndWaitlists element list cites for both.
  assert.ok(String(timelineHtml).includes(`marker-end="url(#arrow)"`) && String(timelineHtml).includes(`class="gapline"`));
  assert.ok(out.includes(`<line class="dep" x1="66.67%" x2="68.17%" y1="22" y2="22" marker-end="url(#arrow)"/>`));
  assert.ok(out.includes(`<line class="gapline" x1="66.67%" x2="68.17%" y1="22" y2="22"/>`));
});

test("a job past its due waits from now, and one due exactly now has no gap to a due time to come", () => {
  const m = timelineModel({ now: NOW, waiting: [wait("w-late", { bucket: "due", why: null, known: false, due: -3, project: "p1" }), wait("w-now", { due: 0, project: "p2" })] });
  assert.equal(itemOf(m, "w-late").startAt, NOW, "from now, not from its due three minutes ago");
  assert.equal(itemOf(m, "w-now").startAt, NOW);
  assert.equal(itemOf(m, "w-now").dep, null, "due now: nothing to wait for before it");
  assert.equal(itemOf(timelineModel({ now: NOW, waiting: [wait("w-soon", { due: 1 })] }), "w-soon").dep, "gap");
});

test("lanes: what overlaps stacks; past four lanes the rest is counted, and what a person acts on is kept", () => {
  // Five completed runs at once, one running and one waiting: seven items, at most four lanes.
  const runs = Array.from({ length: 5 }, (_, i) => rec(`done-${i}`, { from: -150, to: -100 }));
  const m = timelineModel({
    now: NOW,
    runs,
    active: [{ jobId: "live", queue: "pi-jobs", startedAt: t(-160), host: "build3" }],
    hostJobs: [{ name: "build3", jobs: [{ id: "live", p: "web", at: t(-160) }] }],
    waiting: [wait("next", { due: null })],
  });
  const row = rowOf(m, "web");
  assert.equal(row.lanes.length, TIMELINE_LANES_MAX);
  assert.equal(row.more, 2, "seven items: the running job and the waiting one share a lane, three completed runs fill the rest");
  assert.ok(itemsOf(m).some((i) => i.jobId === "live") && itemsOf(m).some((i) => i.jobId === "next"));
  assert.equal(row.counts.completed, 5, "the counts are every item, drawn or not");
  const out = draw(m);
  assert.ok(out.includes(`<span class="tl__repo">+2 more</span>`));
  assert.ok(out.includes(`aria-label="web: 5 completed, 0 failed, 1 running, 1 in line"`));
  // Below the cap the packing is by start: the fewest lanes, nothing dropped.
  const two = timelineModel({ now: NOW, runs: [rec("x1", { from: -150, to: -100 }), rec("x2", { from: -120, to: -90 }), rec("x3", { from: -95, to: -60 })] });
  assert.deepEqual(rowOf(two, "web").lanes.map((l) => l.map((i) => i.jobId)), [["x1", "x3"], ["x2"]]);
  assert.equal(rowOf(two, "web").more, 0);
});

test("a queue of tens of thousands draws in a bounded time: no pass opens a lane past the cap", () => {
  // 50,000 jobs in line on one row, beside a busy day's records, and 50,000 in line each in a project of its own. A
  // packing pass that opened a lane per waiting job tried every lane for every job after it: 3,200 jobs took 162 ms and
  // 12,800 took 2.4 s and 50,000 over two minutes, on the hub's one thread on every tick. Bounded, this is about 30 ms
  // on a laptop alone and up to half a second beside the rest of the suite's files; 2 s leaves room for a slow machine
  // and none for a pass that grows with the square of the queue.
  const runs = Array.from({ length: 2000 }, (_, i) => rec(`r-${i}`, { outcome: i % 3 === 0 ? "failed" : "completed", from: -178 + i * 0.08, to: -177 + i * 0.08 }));
  const one = Array.from({ length: 50_000 }, (_, i) => wait(`gh-${i}`, { due: 60, host: "build3" }));
  const many = Array.from({ length: 50_000 }, (_, i) => wait(`gh-${i}`, { bucket: "pause", why: "pause-window", due: 60, until: 60, project: `p${i}` }));
  const hostJobs = [{ name: "build3", jobs: [{ id: "orphan", p: "web", at: t(-60), o: true }] }];
  for (const [name, parts] of [["one row", { runs, waiting: one, hostJobs }], ["a project each", { waiting: many }]]) {
    const t0 = process.hrtime.bigint();
    const m = timelineModel({ now: NOW, ...parts });
    const out = draw(m);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 2000, `${name}: ${ms.toFixed(0)} ms`);
    assert.ok(out.length < 100_000, `${name}: ${out.length} bytes`);
    for (const row of m.rows) assert.ok(row.lanes.length <= TIMELINE_LANES_MAX);
  }
  // Every waiting job past the lanes is counted. The four drawn are the next to start among the jobs that wait on
  // something on the row (build3's full host, whose slot the orphan holds): due now, in 2, 5 and 10 minutes, and the
  // one due in 40 minutes is counted, though its id would have come first. mini1's jobs, due now with the lowest ids,
  // wait on nothing drawn here and are counted too.
  const m = timelineModel({ now: NOW, waiting: [wait("gh-9", { due: 5 }), wait("gh-3", { due: 40 }), wait("gh-7", { due: 10 }), wait("gh-1", { host: "mini1" }), wait("gh-5"), wait("gh-0", { host: "mini1" }), wait("gh-11", { due: 2 })], hostJobs });
  const row = rowOf(m, "web");
  assert.equal(row.counts.waiting, 7);
  assert.equal(row.more, 3);
  assert.deepEqual(row.lanes.flatMap((l) => l.filter((i) => i.kind === "wait").map((i) => i.jobId)).sort(), ["gh-11", "gh-5", "gh-7", "gh-9"]);
  assert.equal(itemOf(m, "gh-11").dep, "arrow", "the first beside the slot it waits for");
});

test("rows and project chips are bounded: thousands of names draw a dozen rows, two dozen chips and a count", () => {
  // 3,200 projects, each with one job in line, beside one project with a running job and one with a failure: the rows
  // kept are the ones a person acts on first, the rest one line under them, and the chips the same, the filtered
  // project always among them.
  const waiting = Array.from({ length: 3200 }, (_, i) => wait(`gh-${i}`, { due: 30, project: `p${String(i).padStart(4, "0")}` }));
  const parts = {
    now: NOW,
    waiting,
    runs: [rec("gh-f", { project: "zz-failing", outcome: "failed" })],
    active: [{ jobId: "gh-r", queue: "pi-jobs", startedAt: t(-20), host: "build3" }],
    hostJobs: [{ name: "build3", jobs: [{ id: "gh-r", p: "zz-running", at: t(-20) }] }],
  };
  const m = timelineModel(parts);
  assert.equal(m.rows.length, TIMELINE_ROWS_MAX);
  assert.deepEqual(m.rows.slice(-2).map((r) => r.key), ["zz-failing", "zz-running"], "the running and the failed rows are kept, in name order");
  assert.deepEqual(m.rows.slice(0, 2).map((r) => r.key), ["p0000", "p0001"], "then the most items, then by name");
  assert.deepEqual(m.rowsMore, { rows: 3202 - TIMELINE_ROWS_MAX, items: 3202 - TIMELINE_ROWS_MAX });
  assert.equal(m.chips.length, TIMELINE_CHIPS_MAX);
  assert.deepEqual(m.chipsMore, { projects: 3202 - TIMELINE_CHIPS_MAX, count: 3202 - TIMELINE_CHIPS_MAX });
  assert.deepEqual(m.chips.map((c) => c.project), [...m.chips.map((c) => c.project)].sort(), "chips by name");
  const out = draw(m);
  assert.ok(out.length < 40_000, `${out.length} bytes`);
  // A card's sentence after the timeline's scroll box, not a line inside it: inside, a phone, whose timeline opens
  // scrolled to its end, showed its last words or none of it.
  assert.ok(out.endsWith(`</div></div><p class="card__sub">3,190 more rows are not drawn (3,190 runs and jobs in them).</p>`));
  assert.ok(out.indexOf(`class="card__sub"`) > out.lastIndexOf(`class="tnowcap"`), "under the axis, outside the scroll box");
  // A filtered project keeps its chip whatever it holds; one row, nothing left out.
  const one = timelineModel({ ...parts, project: "p3199" });
  assert.ok(one.chips.some((c) => c.project === "p3199" && c.on === true));
  assert.equal(one.chips.length, TIMELINE_CHIPS_MAX);
  assert.deepEqual(one.rowsMore, { rows: 0, items: 0 });
  assert.ok(!draw(one).includes("card__sub"));
  const none = timelineModel({ ...parts, project: "nothing-here" });
  assert.deepEqual(none.chips.find((c) => c.project === "nothing-here"), { project: "nothing-here", count: 0, on: true });
  // The words for one.
  const lone = timelineModel({ now: NOW, waiting: Array.from({ length: TIMELINE_ROWS_MAX + 1 }, (_, i) => wait(`gh-${i}`, { due: 30, project: `p${String(i).padStart(2, "0")}` })) });
  assert.ok(draw(lone).endsWith(`<p class="card__sub">1 more row is not drawn (1 run or job in it).</p>`));
});

test("past the row bound the most pressing row is kept, whatever the item counts of the quiet rows", () => {
  // Twelve projects of three completed runs each and one with a single failure: thirteen rows, twelve drawn. The
  // failure's row is kept and a quiet one is counted, though each quiet row holds more items than it.
  const runs = [];
  for (const p of "abcdefghijkl") for (let k = 0; k < 3; k += 1) runs.push(rec(`gh-${p}${k}`, { project: p, from: -100 + k, to: -90 + k }));
  runs.push(rec("gh-zf", { project: "zz", outcome: "failed", from: -50, to: -40 }));
  const m = timelineModel({ now: NOW, runs });
  assert.equal(m.rows.length, TIMELINE_ROWS_MAX);
  assert.ok(m.rows.some((r) => r.key === "zz"), "the row with a failure is drawn");
  assert.deepEqual(m.rowsMore, { rows: 1, items: 3 });
  assert.deepEqual(m.rows.map((r) => r.key), [..."abcdefghijk", "zz"], "the quiet rows by name, the last one counted");
});

test("a row too full for its lanes is packed by kind: a failure keeps its lane and its label, quiet runs give way", () => {
  // Four completed runs at once fill the four lanes, and a failure after them fits beside one only without its label:
  // the row is packed again by kind, the failure first with its id and its word, and a completed run is counted.
  const full = timelineModel({ now: NOW, runs: [0, 1, 2, 3].map((k) => rec(`gh-p${k}`, { from: -115, to: -48 })).concat([rec("gh-f1", { outcome: "failed", from: -30, to: -15 })]) });
  const row = rowOf(full, "web");
  assert.equal(itemOf(full, "gh-f1").label?.side, "before", "the failure says its id and its word");
  assert.equal(row.more, 1, "a quiet run is counted instead");
  // A row with more jobs in line than lanes is packed by kind too, as every row past the cap: its failure in the first
  // lane, the jobs in line after it, two of them counted.
  const cut = timelineModel({ now: NOW, runs: [rec("gh-ok", { from: -110, to: -30 }), rec("gh-fl", { outcome: "failed", from: -100, to: -60 })], waiting: Array.from({ length: 6 }, (_, k) => wait(`gh-w${k}`, { due: -1 })) });
  const r = rowOf(cut, "web");
  assert.equal(laneOf(r, "gh-fl"), 0, "the failure leads, as by kind");
  assert.equal(r.more, 2);
});

test("a job waiting for its full host leads from the oldest slot a gone job holds there, in that slot's lane", () => {
  const hostJobs = [{ name: "build3", jobs: [{ id: "gh-old", p: null, at: t(-100), o: true }, { id: "gh-new", p: null, at: t(-50), o: true }] }];
  const m = timelineModel({ now: NOW, rows: "host", hostJobs, waiting: [wait("gh-w", { why: "host-slot", host: "build3", queue: "pi-jobs@build3", due: -1 })] });
  const row = rowOf(m, "build3");
  assert.equal(itemOf(m, "gh-w").dep, "arrow");
  assert.equal(laneOf(row, "gh-w"), laneOf(row, "gh-old"), "beside the slot held longest");
  assert.notEqual(laneOf(row, "gh-w"), laneOf(row, "gh-new"));
});

test("a long row name is whole in its head's title, which the page's rules cut to the column", () => {
  const name = "frontend-platform-team-eu";
  const host = "a-very-long-host-name.example.internal";
  const byProject = draw(timelineModel({ now: NOW, waiting: [wait("gh-1", { project: name })] }));
  assert.ok(byProject.includes(`<span class="ptag" title="${name}">${name}</span>`));
  const byHost = draw(timelineModel({ now: NOW, rows: "host", waiting: [wait("gh-1", { host })] }), "Runs by host");
  assert.ok(byHost.includes(`<span class="code" title="${host}">${host}</span>`));
  // The cut: an ellipsis where the browser measures the name, in the heads' column with a gap before the lane.
  assert.match(PAGE_CSS.overview, /\n\.tl__h>\.ptag,\.tl__h>\.code\{display:block;max-width:calc\(100% - 8px\);overflow:hidden;text-overflow:ellipsis\}\n/);
});

test("labels sit inside a wide pill, outside a narrow one, and never on another item", () => {
  const m = timelineModel({
    now: NOW,
    runs: [rec("fail-wide", { outcome: "failed", from: -170, to: -150 }), rec("fail-late", { outcome: "failed", from: -3, to: -2 })],
    active: [
      { jobId: "run-wide", queue: "pi-jobs", startedAt: t(-150), host: "build3" },
      { jobId: "run-short", queue: "pi-jobs@mini2", startedAt: t(-2), host: "mini2" },
    ],
    hostJobs: [{ name: "build3", jobs: [{ id: "run-wide", p: "web", at: t(-150) }] }, { name: "mini2", jobs: [{ id: "run-short", p: "web", at: t(-2) }] }],
  });
  assert.deepEqual(itemOf(m, "run-wide").label, { text: "run-wide", sub: "build3", side: "in" });
  assert.equal(itemOf(m, "run-short").label.side, "before", "a pill too narrow for its id writes it before the pill");
  assert.equal(itemOf(m, "fail-wide").label.side, "after");
  assert.equal(itemOf(m, "fail-late").label.side, "before", "a label of an ended run never passes now");
  // No two items of one lane take the same space, labels included.
  const out = draw(m);
  assert.ok(out.includes(`<text class="tp-l tp-l--out-run" x="`), out);
  assert.ok(out.includes(`<text class="tp-l tp-l--out-failed" x="`));
});

test("by host: the record's, the registry's, the waiting row's or its queue's host; the shared queue is any host", () => {
  const sample = cardSample();
  sample.waiting.rows.push(wait("shared", { host: null, queue: "pi-jobs", project: "web" }), wait("routed", { host: null, queue: "pi-jobs@mini1", project: "web" }));
  const m = timelineModel({ ...sample, rows: "host", zoom: "24h" });
  assert.deepEqual(m.rows.map((r) => [r.key, r.label, r.tag, r.sub]), [
    ["build3", "build3", "host", null],
    ["mini1", "mini1", "host", null],
    ["mini2", "mini2", "host", null],
    [null, ANY_HOST_TEXT, null, null],
  ]);
  assert.equal(laneOf(rowOf(m, "mini1"), "routed") >= 0, true, "a host queue's job is that host's");
  assert.equal(itemOf(m, "gh-e802").label?.sub ?? "billing", "billing", "a running job's line names its project when the rows are hosts");
  // A job the registry did not place, beside shared-queue work, is "host not known".
  const mixed = timelineModel({ now: NOW, rows: "host", active: [{ jobId: "lost", queue: "pi-jobs", startedAt: t(-5), host: null }], waiting: [wait("shared2", { host: null })] });
  assert.equal(mixed.rows.at(-1).label, HOST_NOT_KNOWN_TEXT);
  assert.equal(itemOf(mixed, "lost").title, "lost: running since 15:34 UTC, host not known");
  const markup = draw(m, "Runs by host");
  assert.ok(markup.includes(`<span class="tl__h tl__h--first"><span class="code" title="build3">build3</span></span>`));
  assert.ok(markup.includes(`<span class="tl__h tl__h--first"><span class="muted">${ANY_HOST_TEXT}</span></span>`));
});

test("the project filter keeps one project's rows; the chips are counted before it and keep the way back", () => {
  const sample = cardSample();
  sample.runs.push(rec("gh-none", { project: null, from: -60, to: -50 }));
  const m = timelineModel({ ...sample, project: "billing" });
  assert.deepEqual(m.rows.map((r) => r.key), ["billing"], "that project's row alone, not the no-project row");
  assert.equal(timelineModel(sample).rows.at(-1).label, NO_PROJECT_TEXT, "which every project draws");
  assert.deepEqual(m.chips.map((c) => [c.project, c.count, c.on]), [["api", 2, false], ["billing", 6, true], ["ops", 1, false]]);
  const none = timelineModel({ ...cardSample(), project: "nothing-here" });
  assert.equal(none.empty, true);
  assert.deepEqual(none.rows, []);
  assert.deepEqual(none.chips.find((c) => c.project === "nothing-here"), { project: "nothing-here", count: 0, on: true });
  // An empty model draws the band and the axis alone.
  const out = draw(none);
  assert.ok(out.includes(TIMELINE_BAND.past) && out.includes(`class="tnowcap"`));
  assert.ok(!out.includes(`role="img"`));
});

test("garbage in the parts is skipped, never drawn as NaN, and never throws", () => {
  const m = timelineModel({
    now: NOW,
    runs: [null, 7, { jobId: "" }, { jobId: "r-nan", startedAt: Number.NaN, endedAt: "soon", outcome: "completed" }, rec("r-ok")],
    active: [null, { jobId: 4 }, { jobId: "a-1", startedAt: "x", host: 3 }],
    hostJobs: [null, { name: 3, jobs: [] }, { name: "h", jobs: "nope" }, { name: "h2", jobs: [null, { id: "j", at: "x", o: true }] }],
    waiting: { rows: [null, { jobId: "w-x", bucket: "__proto__", dueAt: "later" }] },
    parked: "nope",
  });
  const out = draw(m);
  assert.doesNotMatch(out, /NaN|undefined|Infinity|\[object/);
  assert.equal(itemOf(m, "w-x").glyph, "info", "an unknown bucket is no reason recorded");
  assert.ok(itemsOf(m).some((i) => i.jobId === "a-1"));
  assert.ok(!itemsOf(m).some((i) => i.jobId === "r-nan"), "a record with no instant has no place");
  // `runsDay` itself is taken too.
  assert.equal(itemsOf(timelineModel({ now: NOW, runs: { runs: [rec("r-1")], floor: false, partial: false } })).length, 1);
});

test("long ids are cut in a pill and whole in its title", () => {
  const id = "gh-2f6a8c1d-91b0-4d55-a1e3-7c2b9f00aa11";
  const m = timelineModel({ now: NOW, runs: [rec(id, { from: -170, to: -60 })] });
  const it = itemOf(m, id);
  assert.equal(it.label.text, "gh-2f6a8c1d-9…");
  assert.ok(it.title.startsWith(`${id} `));
});

// ---- the markup -------------------------------------------------------------------------------------------------------------

test("a hostile target, project, host or id is escaped wherever it is drawn", () => {
  const evil = `<script>alert("x")</script>`;
  const m = timelineModel({
    now: NOW,
    runs: [rec(`gh-"><svg onload=1>`, { target: `acme/${evil}#1`, project: `p"><b>`, host: `h<i>`, from: -170, to: -60 })],
    waiting: [wait("w-1", { bucket: "none", why: `<img src=x onerror=1>`, known: false, project: `p"><b>` })],
  });
  const out = draw(m, `Runs <by> "project"`);
  assert.doesNotMatch(out, /<script|<svg onload|<img|<b>|<i>/);
  assert.ok(out.includes("acme/&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;#1"), "the target in its title, escaped");
  assert.ok(out.includes(`aria-label="Runs &lt;by&gt; &quot;project&quot;"`));
  // Inside a tag no handler, style or script URL (the text " onload=1" in an escaped title is text).
  assert.doesNotMatch(out, /<[^>]*\s(?:on[a-z]+|style)\s*=|<[^>]*=\s*["']?javascript:/i);
});

test("one accessible name per row: its first lane names every count, its other lanes are hidden", () => {
  const m = timelineModel(cardSample());
  const out = draw(m);
  const named = [...out.matchAll(/<svg class="tl__r tl__r--first" height="44" role="img" aria-label="([^"]*)">/g)].map((x) => x[1]);
  assert.deepEqual(named, [
    "api: 0 completed, 0 failed, 1 awaiting input, 0 running, 1 in line",
    "billing: 2 completed, 0 failed, 1 refused, 1 running, 1 holding a slot, 1 in line",
    "ops: 0 completed, 0 failed, 1 running, 0 in line",
  ]);
  const lanes = m.rows.reduce((n, r) => n + r.lanes.length, 0);
  assert.equal([...out.matchAll(/<svg class="tl__r" height="44" aria-hidden="true">/g)].length, lanes - m.rows.length);
  assert.equal([...out.matchAll(/role="img"/g)].length, m.rows.length);
  assert.throws(() => timelineHtml(m, {}), TypeError, "the timeline is named");
});

test("the frame is the card's: the wrapper, the band, a head per row, the lanes' grid and the axis with the now cap", () => {
  const m = timelineModel(cardSample());
  const out = draw(m);
  assert.ok(out.startsWith(`<div class="tl-wrap"><div class="tl" role="group" aria-label="Runs by project"><span></span>`));
  assert.ok(out.endsWith("</svg></div></div>"));
  // The band, as the card draws it.
  const band = `<span></span><svg class="tl__r" height="24" aria-hidden="true"><rect class="tl-future" x="68.57%" y="0" width="31.43%" height="24"/><text class="tband" x="68.57%" dx="-10" y="16" text-anchor="end">Ran and running</text><text class="tband tband--in" x="68.57%" dx="10" y="16">In line</text></svg>`;
  assert.ok(shapeOf(out).includes(shapeOf(band)));
  // A row's head, as the card draws it, with the name whole in its title (the page's rules cut it to the column).
  assert.ok(out.includes(`<span class="tl__h tl__h--first"><span class="ptag" title="api">api</span><span class="tl__repo">acme/api</span></span>`));
  assert.ok(out.includes(`<span class="tl__h tl__h--first"><span class="ptag" title="billing">billing</span><span class="tl__repo">acme/billing, billing-ui</span></span>`));
  // Every lane: the future's shading, a grid line per tick, the now line, then its items.
  const lane = /<svg class="tl__r[^"]*" height="44"[^>]*><rect class="tl-future" x="66\.67%" y="0" width="33\.33%" height="44"\/>((?:<line class="tg" x1="[\d.]+%" x2="[\d.]+%" y1="0" y2="44"\/>)+)<line class="tnow" x1="66\.67%" x2="66\.67%" y1="0" y2="44"\/>/g;
  const lanes = [...out.matchAll(lane)];
  assert.equal(lanes.length, m.rows.reduce((n, r) => n + r.lanes.length, 0));
  for (const l of lanes) assert.equal([...l[1].matchAll(/class="tg"/g)].length, m.axis.length);
  // The axis: UTC beside the times, the times as HH:MM, none under the now cap, and the cap as the card draws it.
  assert.deepEqual(m.axis.map((a) => a.label), ["13:00", "13:30", "14:00", "14:30", "15:00", null, "16:00", "16:30", "17:00"]);
  assert.ok(out.includes(`<span></span><svg class="tl__r" height="24" aria-hidden="true"><text class="tax" x="0" dx="-8" y="14" text-anchor="end">UTC</text><text class="tax" x="7.78%" y="14" text-anchor="middle">13:00</text>`));
  const cap = `<rect class="tnowcap" x="68.57%" y="2" width="46" height="18" rx="9" transform="translate(-23 0)"/><text class="tnowcap-t" x="68.57%" y="15" text-anchor="middle">15:39</text></svg>`;
  assert.ok(shapeOf(out).endsWith(`${shapeOf(cap)}</div></div>`));
});

test("each item is drawn as the card draws it", () => {
  const m = timelineModel(cardSample());
  const out = shapeOf(draw(m));
  // The card's fragments, byte for byte but for positions and titles.
  const card = {
    held: `<rect class="tp--held" x="0" y="9" width="68.57%" height="26" rx="13"><title>gh-4a7e cancelled at 10:59; still holds a build3 slot</title></rect><text class="tp-l tp-l--hold" x="0" dx="14" y="27">gh-4a7e<tspan class="tp-sub3" dx="8">cancelled 10:59, still holds a build3 slot</tspan></text>`,
    arrowWait: `<line class="dep" x1="68.57%" x2="70.00%" y1="22" y2="22" marker-end="url(#arrow)"/><rect class="tp--wait" x="70.00%" y="9" width="30.00%" height="26" rx="13"><title>gh-c9e1: needs this slot</title></rect><g transform="translate(9 15)"><use class="tp-wait-g" href="#i-slot" x="70.00%" width="14" height="14"/></g><text class="tp-l" x="70.00%" dx="28" y="27">gh-c9e1<tspan class="tp-sub2" dx="6">needs this slot</tspan></text>`,
    gapWait: `<line class="gapline" x1="68.57%" x2="70.95%" y1="22" y2="22"/><rect class="tp--wait" x="70.95%" y="9" width="29.05%" height="26" rx="13"><title>gh-71b2: retry in 4m</title></rect><g transform="translate(9 15)"><use class="tp-wait-g" href="#i-rerun" x="70.95%" width="14" height="14"/></g><text class="tp-l" x="70.95%" dx="28" y="27">gh-71b2<tspan class="tp-sub2" dx="6">retry in 4m</tspan></text>`,
    okLabelled: `<rect class="tp--ok" x="31.90%" y="9" width="12.38%" height="26" rx="13"><title>gh-ebd7 acme/billing#259 completed</title></rect><text class="tp-l" x="31.90%" dx="12" y="27">gh-ebd7</text>`,
    okQuiet: `<rect class="tp--ok" x="10.00%" y="9" width="6.19%" height="26" rx="13"><title>gl-9a2c acme/billing-ui#405 completed</title></rect>`,
    refused: `<circle class="tp-ref" cx="64.29%" cy="22" r="12"><title></title></circle><g transform="translate(-7 15)"><use class="tp-ref-g" href="#i-refused" x="64.29%" width="14" height="14"/></g><text class="tp-l tp-l--ref" x="64.29%" dx="-18" y="27" text-anchor="end">gh-e9a0 refused</text>`,
    runIn: `<rect class="tp--run" x="30.48%" y="9" width="38.10%" height="26" rx="13"><title>gh-e802  running on build3</title></rect><text class="tp-l tp-l--run" x="30.48%" dx="12" y="27">gh-e802<tspan class="tp-sub" dx="8">build3</tspan></text>`,
  };
  for (const [name, frag] of Object.entries(card)) assert.ok(out.includes(shapeOf(frag)), `${name}: ${shapeOf(frag)}`);
  // The card's park, 26 minutes old, is drawn on a lane wider than the narrowest: there its id fits in its pill and its
  // words over its tail. On the narrowest neither does (its words would cross now), so both go before the pill, in the
  // parked ink, as a failure's label goes outside its pill, and the tail is drawn bare (its words are the next test's).
  const parked = `<rect class="tp--parked" x="P" y="9" width="P" height="26" rx="13"><title></title></rect><text class="tp-l tp-l--out-parked" x="P" dx="-8" y="27" text-anchor="end">gh-2f6a<tspan class="tp-sub3" dx="6">waiting for you</tspan></text><line class="tail" x1="P" x2="P" y1="28" y2="28"/>`;
  assert.ok(out.includes(`${parked}<`), out);
  assert.ok(!out.includes(`class="tail-t"`));
  // The card's refusal circle has no title; the console's carries one, so a pointer can read it.
  assert.ok(out.includes(`<circle class="tp-ref" cx="P" cy="22" r="12"><title></title></circle>`));
});

test("the card's labelled park and its run labelled outside, from parts that fit them", () => {
  // A parked pill wide enough for its id and a tail long enough for its words, and a short run whose id and host fit
  // before it.
  const m = timelineModel({
    now: NOW,
    runs: [rec("gh-2f6a", { project: "api", target: "acme/api#88", reason: "awaiting-input", from: -150, to: -60 })],
    active: [{ jobId: "local-9e20", queue: "pi-jobs@mini2", startedAt: t(-6), host: "mini2" }],
    hostJobs: [{ name: "mini2", jobs: [{ id: "local-9e20", p: "ops", at: t(-6) }] }],
    parked: [{ jobId: "gh-2f6a", parkedAt: t(-60), answered: false }],
  });
  const out = shapeOf(draw(m));
  const parked = `<rect class="tp--parked" x="46.19%" y="9" width="10.00%" height="26" rx="13"><title>gh-2f6a parked at 15:13</title></rect><text class="tp-l tp-l--parked" x="46.19%" dx="12" y="27">gh-2f6a</text><line class="tail" x1="56.19%" x2="68.57%" y1="28" y2="28"/><text class="tail-t" x="56.19%" dx="6" y="20">waiting for you</text>`;
  const runOut = `<rect class="tp--run" x="65.71%" y="9" width="2.86%" height="26" rx="13"><title>local-9e20  running on mini2</title></rect><text class="tp-l tp-l--out-run" x="65.71%" dx="-8" y="27" text-anchor="end">local-9e20<tspan class="tp-sub2" dx="6">mini2</tspan></text>`;
  assert.ok(out.includes(shapeOf(parked)), "parked");
  assert.ok(out.includes(shapeOf(runOut)), "run labelled before its pill");
});

test("the legend is the card's key", () => {
  const card = `<p class="keyrow">
  <span><i class="lg lg--ok"></i>Completed</span><span><i class="lg lg--run"></i>Running</span><span><i class="lg lg--parked"></i>Awaiting input</span>
  <span><i class="lg lg--failed"></i>Failed</span><span><i class="lg lg--ref"></i>Refused</span><span><i class="lg lg--hold"></i>Slot held</span>
  <span><i class="lg lg--wait"></i>In line</span><span><svg class="ic ic--sm" aria-hidden="true"><use href="#i-chain"/></svg>waits for a run</span></p>`;
  const out = timelineLegend();
  assert.ok(isSafeHtml(out));
  assert.equal(String(out), shapeOf(card));
});

test("the markup keeps the console's rules: no inline style or script, no control byte, no symbol but the cut's ellipsis", () => {
  const all = [timelineModel(cardSample()), timelineModel({ ...cardSample(), rows: "host", zoom: "24h" }), timelineModel({ ...cardSample(), zoom: "1h" })].map((m) => draw(m)).join("") + String(timelineLegend());
  assert.doesNotMatch(all, /<script|<style|<[^>]*\s(?:on[a-z]+|style)\s*=/i);
  assert.doesNotMatch(all, /[\u0000-\u0008\u000b-\u001f\u007f]/);
  assert.doesNotMatch(all, /[\u2014\u2013]/, "no dash as punctuation");
  assert.doesNotMatch(all.replace(/\u2026/g, ""), /[^\x09\x0a\x20-\x7e]/, "ASCII but the ellipsis");
  // Every number in a geometry attribute is a plain decimal (svgNum), never NaN or an exponent.
  for (const [, v] of all.matchAll(/ (?:x|x1|x2|cx|width)="([^"]*)"/g)) assert.match(v, /^-?\d+(?:\.\d+)?%?$/, v);
});
