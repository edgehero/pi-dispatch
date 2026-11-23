import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAGE_DEADLINE_MS, PAGE_VIEW_GRACE_MS, PageDeadlinePassed, pageDeadline } from "../src/console/page-deadline.mjs";
import { handTime } from "./helpers/hand-time.mjs";

/**
 * The page deadline (issues #987 and #988): one end over everything a page load asks of Valkey, as a read's bound
 * (`within`) or as the end of the wait for a read that takes none (`settle`). The clock and the timers are moved by
 * hand; nothing here waits.
 */

/** A read that never answers, a promise the test settles itself, and the unhandled rejections seen while `run` ran. */
const never = () => new Promise(() => {});
const held = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
async function unhandledDuring(run) {
  const seen = [];
  const note = (reason) => seen.push(reason);
  process.on("unhandledRejection", note);
  try {
    await run();
    // An unhandled rejection is raised after the microtasks that could still handle it: give that a turn.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", note);
  }
  return seen;
}

test("the deadline is 6 s and the grace 1 s, a leaf that imports nothing of the console", () => {
  assert.equal(PAGE_DEADLINE_MS, 6000);
  assert.equal(PAGE_VIEW_GRACE_MS, 1000);
  const source = readFileSync(new URL("../src/console/page-deadline.mjs", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/^\s*import\b/gm)], [], "no import at all");
});

test("the default clock is the monotonic one: a wall clock that steps neither spends a deadline nor extends one", () => {
  const RealDate = globalThis.Date;
  const deadline = pageDeadline(60_000);
  const short = pageDeadline(1);
  // The wall clock jumps ten minutes ahead, in every spelling of reading it.
  class Stepped extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + 600_000);
      else super(...args);
    }
    static now() { return RealDate.now() + 600_000; }
  }
  globalThis.Date = Stepped;
  try {
    assert.equal(new Date().getTime() - RealDate.now() >= 599_000, true, "the step is what a wall clock read sees");
    assert.equal(deadline.spent(), false, "ten minutes on the wall clock spend nothing");
    assert.equal(deadline.within(2500), 2500);
    assert.ok(deadline.within(Infinity) > 59_000);
  } finally {
    globalThis.Date = RealDate;
  }
  // And back again: a wall clock stepping backwards gives no time back.
  class Earlier extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() - 600_000);
      else super(...args);
    }
    static now() { return RealDate.now() - 600_000; }
  }
  const until = performance.now() + 5;
  while (performance.now() < until) { /* five milliseconds of the monotonic clock */ }
  globalThis.Date = Earlier;
  try {
    assert.equal(short.spent(), true, "a deadline that passed stays passed");
    assert.equal(short.within(2500), 1);
  } finally {
    globalThis.Date = RealDate;
  }
});

test("within: a read's own bound or what is left when that is sooner, a whole number never below 1", async () => {
  const time = handTime();
  const deadline = pageDeadline(6000, time);
  assert.equal(deadline.within(2500), 2500, "its own bound while more than that is left");
  assert.equal(deadline.within(Infinity), 6000, "what is left, for a read with no bound of its own");
  await time.advance(4000);
  assert.equal(deadline.within(2500), 2000, "what is left of the deadline");
  assert.equal(deadline.within(1500), 1500);
  // Always a whole number: a reader that is handed 1234.6 takes it for no bound at all and falls back to its default.
  const other = handTime();
  const fine = pageDeadline(6000, other);
  await other.advance(4765.4);
  assert.equal(fine.within(2500), 1235, "1234.6 ms left, rounded");
  assert.equal(fine.within(Infinity), 1235);
  assert.equal(fine.within(1000.4), 1000, "and a bound of its own that is no whole number is not handed on as it is");
  await time.advance(1999.6);
  assert.equal(deadline.within(2500), 1, "rounded, and never 0: several readers take 0 as their default bound");
  assert.equal(deadline.spent(), false);
  await time.advance(0.4);
  assert.equal(deadline.spent(), true, "spent at the deadline itself");
  assert.equal(deadline.within(2500), 1);
  await time.advance(60_000);
  assert.equal(deadline.within(2500), 1, "never a read's whole time again after the deadline passed");
  assert.equal(deadline.within(Infinity), 1);
});

test("settle: a read that answers in time is its answer, its timer is taken away and late is never asked", async () => {
  const time = handTime();
  const deadline = pageDeadline(6000, time);
  let lates = 0;
  const late = () => { lates += 1; return "late"; };
  const read = held();
  const settling = deadline.settle(read.promise, late);
  assert.equal(time.waiting(), 1, "one timer per read waited for");
  await time.advance(5999);
  read.resolve("answer");
  assert.equal(await settling, "answer");
  assert.equal(time.waiting(), 0, "the timer is cleared with the answer");
  await time.advance(10_000);
  assert.equal(lates, 0);
  // A read that fails in time fails as it did before: the caller's own catch words it.
  const failing = held();
  const failed = deadline.settle(failing.promise, late);
  failing.reject(new Error("ECONNREFUSED"));
  await assert.rejects(failed, /ECONNREFUSED/);
  assert.equal(lates, 0);
});

test("settle: past the deadline the answer is late(), once, and the read left behind raises nothing when it rejects", async () => {
  const time = handTime();
  const deadline = pageDeadline(6000, time);
  let lates = 0;
  const read = held();
  let answer = null;
  const unhandled = await unhandledDuring(async () => {
    const settling = deadline.settle(read.promise, () => { lates += 1; return { unreachable: true }; }).then((got) => { answer = got; });
    await time.advance(5999);
    assert.equal(answer, null, "still waited for a millisecond before the deadline");
    await time.advance(1);
    await settling;
    assert.deepEqual(answer, { unreachable: true });
    // The read goes on to its own bound and fails there, long after the page was drawn.
    read.reject(new Error("Command timed out"));
    await time.advance(5000);
  });
  assert.deepEqual(unhandled, [], "no unhandled rejection from the read that was left behind");
  assert.equal(lates, 1);
  // The same for a read that answers after all: its answer is dropped, and late is not asked again.
  const slow = held();
  const second = pageDeadline(6000, time);
  const settling = second.settle(slow.promise, () => { lates += 1; return "late"; });
  await time.advance(6000);
  slow.resolve("answer");
  assert.equal(await settling, "late");
  assert.equal(lates, 2);
});

test("settle: a late that throws rejects, so a caller's own catch takes a cut read as it takes a failed one", async () => {
  const time = handTime();
  const deadline = pageDeadline(6000, time);
  const settling = deadline.settle(never(), () => { throw new PageDeadlinePassed(); });
  const outcome = settling.then(() => "answered", (err) => err);
  await time.advance(6000);
  const err = await outcome;
  assert.ok(err instanceof PageDeadlinePassed);
  assert.equal(err.code, "PAGE_DEADLINE");
  assert.equal(err.name, "PageDeadlinePassed");
});

test("settle: a function is a read not yet made, and is not made once the deadline has passed; a promise already made is still taken", async () => {
  const time = handTime();
  const deadline = pageDeadline(6000, time);
  let made = 0;
  const read = () => { made += 1; return Promise.resolve("answer"); };
  assert.equal(await deadline.settle(read, () => "late"), "answer");
  assert.equal(made, 1, "made while the deadline has time left");
  // A read made before the deadline that has its answer is that answer, whenever it is asked for.
  const early = Promise.resolve("early");
  await time.advance(6000);
  assert.equal(deadline.spent(), true);
  assert.equal(await deadline.settle(read, () => "late"), "late");
  assert.equal(made, 1, "a spent deadline sends Valkey nothing more");
  assert.equal(time.waiting(), 0, "and arms no timer for a read it did not make");
  const taken = deadline.settle(early, () => "late");
  await time.advance(0);
  assert.equal(await taken, "early");
  // One made before the deadline that still has none is not waited for.
  const pending = deadline.settle(never(), () => "late");
  await time.advance(0);
  assert.equal(await pending, "late");
  // A function that throws as it is called is a read that failed.
  const fresh = pageDeadline(6000, time);
  await assert.rejects(fresh.settle(() => { throw new Error("no reader"); }, () => "late"), /no reader/);
});

test("settle with grace: a read that draws files is made and waited for until the deadline and the grace, and no longer", async () => {
  const time = handTime();
  const deadline = pageDeadline(6000, time);
  let made = 0;
  const view = held();
  await time.advance(6000);
  // Past the deadline and inside the grace: still made, since the files need no Valkey.
  let answer = null;
  const settling = deadline.settle(() => { made += 1; return view.promise; }, () => "late", { grace: true }).then((got) => { answer = got; });
  assert.equal(made, 1);
  await time.advance(900);
  view.resolve({ from: "files" });
  await settling;
  assert.deepEqual(answer, { from: "files" });
  // One that is still reading when the grace ends is cut.
  const cut = deadline.settle(never, () => "late", { grace: true });
  await time.advance(100);
  assert.equal(await cut, "late");
  // And past the grace none is made.
  assert.equal(await deadline.settle(() => { made += 1; return never(); }, () => "late", { grace: true }), "late");
  assert.equal(made, 1);
  // The grace is the caller's to set.
  const short = pageDeadline(100, { ...time, graceMs: 50 });
  const waited = short.settle(never, () => "late", { grace: true });
  let done = false;
  waited.then(() => { done = true; });
  await time.advance(149);
  assert.equal(done, false);
  await time.advance(1);
  assert.equal(await waited, "late");
});

test("settle: a timer that fires before its time cuts nothing: the rest is waited out, and the deadline has passed whenever a read is cut", async () => {
  // The process's timers run on a coarser clock than the deadline's and can fire up to a millisecond or so early.
  let now = 0;
  const armed = [];
  const timers = { setTimeout: (fn, ms) => (armed.push({ fn, ms }), armed.length), clearTimeout() {} };
  const deadline = pageDeadline(6000, { clock: () => now, timers });
  let answer = null;
  let spentWhenCut = null;
  deadline.settle(never(), () => { spentWhenCut = deadline.spent(); return "late"; }).then((got) => { answer = got; });
  assert.deepEqual(armed.map((t) => t.ms), [6000]);
  now = 5999.2;
  armed[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answer, null, "fired early: the read is still waited for");
  assert.deepEqual(armed.map((t) => t.ms), [6000, 1], "for what is left, rounded up so it is not early again");
  now = 6000;
  armed[1].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answer, null, "at the deadline the read has one more turn of the loop for an answer on its way");
  assert.deepEqual(armed.map((t) => t.ms), [6000, 1, 0]);
  armed[2].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answer, "late");
  assert.equal(spentWhenCut, true);
});

test("settle: a read that ends in the same turn as the deadline keeps its own answer, whichever timer was made first", async () => {
  // A reader handed what is left of the deadline as its bound ends at the deadline's own instant, and says so in an
  // answer of its own. That answer is the read's, not `late`'s.
  for (const order of ["the read's bound first", "the wait first"]) {
    const time = handTime();
    const deadline = pageDeadline(6000, time);
    let lates = 0;
    const late = () => { lates += 1; return "late"; };
    const ownAnswerAt = (ms) => new Promise((resolve) => { time.timers.setTimeout(() => resolve({ unreachable: true, from: "the reader" }), ms); });
    let settling;
    if (order === "the read's bound first") settling = deadline.settle(ownAnswerAt(deadline.within(2_000_000)), late);
    else {
      // The wait is armed before the reader arms its bound, as when the reader does file work first.
      let handed;
      const reading = new Promise((resolve) => { handed = resolve; });
      settling = deadline.settle(reading, late);
      ownAnswerAt(deadline.within(2_000_000)).then(handed);
    }
    await time.advance(5999);
    await time.advance(1);
    assert.deepEqual(await settling, { unreachable: true, from: "the reader" }, order);
    assert.equal(lates, 0, `${order}: late is not asked`);
    assert.equal(time.waiting(), 0, order);
  }
  // One that ends a millisecond after the deadline is late.
  const time = handTime();
  const deadline = pageDeadline(6000, time);
  const settling = deadline.settle(new Promise((resolve) => { time.timers.setTimeout(() => resolve("answer"), 6001); }), () => "late");
  await time.advance(6000);
  assert.equal(await settling, "late");
});

test("each deadline is its own: one made later has its whole time", async () => {
  const time = handTime();
  const first = pageDeadline(6000, time);
  await time.advance(7000);
  const second = pageDeadline(6000, time);
  assert.equal(first.spent(), true);
  assert.equal(second.spent(), false);
  assert.equal(second.within(2500), 2500);
});

test("the default clock is the monotonic one and the default timers the process's own, and a page's wait holds no process open", async () => {
  // The wait's timer is unreferenced, so here something else has to keep the loop turning while it runs.
  const keep = setTimeout(() => {}, 5_000);
  try {
    const deadline = pageDeadline(40);
    assert.equal(deadline.spent(), false);
    assert.ok(deadline.within(10_000) <= 40);
    assert.equal(await deadline.settle(never(), () => "late"), "late");
    assert.equal(deadline.spent(), true);
  } finally {
    clearTimeout(keep);
  }
  let unreferenced = 0;
  const timers = { setTimeout: () => ({ unref() { unreferenced += 1; } }), clearTimeout() {} };
  pageDeadline(6000, { clock: () => 0, timers }).settle(never(), () => "late");
  assert.equal(unreferenced, 1, "a console that is stopping does not wait out a page's deadline");
});
