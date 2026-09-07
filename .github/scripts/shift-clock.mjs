/**
 * Move `Date`'s idea of NOW forward by a fixed offset, for the CI run that proves no test depends on the
 * distance between the wall clock and a date literal (issues #284, #293).
 *
 * THE FAILURE THIS EXISTS FOR ARRIVES ON A TREE NOBODY TOUCHED. A test that names an instant and then
 * builds its subject on the real `Date.now` passes until the wall clock drifts past that subject's own
 * retention window, and then fails in CI against a commit that changed nothing near it. Issue #284 was
 * that: every fixture in `run-mirror.test.mjs` was dated `2026-08-30` while four call sites took the
 * default clock, so the writer's own age trim deleted the members the tests had just written, on the day
 * the wall clock passed the fixture date plus retention. With `contract-tests` required and
 * `enforce_admins` on, `main` froze until it was fixed. The file carried that fuse from the day it was
 * written.
 *
 * AN OFFSET, NEVER A PINNED INSTANT. The property under test is "no test depends on the distance between
 * now and a literal", and a fixed offset from the real clock is exactly that property's negation. A
 * pinned absolute instant would be more deterministic and would rot: it eventually becomes the past, the
 * guard silently stops looking forward, and somebody has to remember to bump it. A chore that must be
 * remembered is a guard that erodes.
 *
 * 399 DAYS, and each of the three properties is load-bearing:
 *   - MORE THAN A YEAR, so it clears every window in the system at once: PI_LOG_RETENTION_DAYS 30,
 *     PI_SESSIONS_TTL_DAYS 14, the 92-day cost cap, PI_SANDBOX_RETENTION_HOURS 24, and the 7-day mirror
 *     trim that caused #284.
 *   - A WHOLE NUMBER OF DAYS, so UTC time-of-day is preserved for the pause-window tests, which reason
 *     about `from`/`to` clock times.
 *   - A WHOLE NUMBER OF WEEKS (57 x 7), so the WEEKDAY is preserved. `worker/test/budget.test.mjs` is
 *     built on Monday-anchored ISO week keys and cron reasons about day-of-week fields; +400 would shift
 *     the weekday by one and produce failures that say nothing about the class this is hunting.
 *
 * WHAT IS DELIBERATELY NOT SHIFTED, because shifting any of it would make this shim the bug:
 *   - `Date.parse` and `new Date(<arg>)`. Both must keep returning the instant they were given, or every
 *     dated fixture in the suite moves with the clock and the whole exercise cancels out.
 *   - Timers. `setTimeout`/`setInterval` and `node --test`'s own timeout run on libuv's monotonic clock,
 *     so nothing here changes a timeout. This is the first question everyone asks.
 *   - The FILESYSTEM's clock, and any SERVER's. An `fs` mtime still comes from the kernel, so a test that
 *     compares a real mtime against `Date.now()` will see a 399-day gap. That is not a false positive:
 *     it is the same class, reached through a timestamp instead of a literal, and it is how the
 *     `takeLock` two-clocks defect in `worker/src/triggers-file.mjs` was found.
 *
 * Delivered through `NODE_OPTIONS` so it reaches the child processes `node --test` forks per file, and it
 * survives a grandchild too (measured: applied exactly once, not twice). The one hole is a test that
 * spawns with an env ALLOWLIST rather than inheriting: `receiver/test/start.test.mjs` passes only PATH and
 * two config vars, so that subprocess runs on the real clock inside the shifted step. Harmless today, and
 * the kind of thing that grows quietly, so it is named here rather than discovered later.
 */
/**
 * The offset, in days. Overridable so that whoever debugs a red here can bisect it in one command
 * (`SHIFT_DAYS=490 npm test`) instead of editing this file: the guard is green at +399 today, and the
 * TARGET date moves with the wall clock, so a future red may be about a specific calendar shape rather
 * than about the class. Keep any override a whole number of WEEKS, or the weekday changes and the
 * failures stop meaning what this file says they mean.
 */
const SHIFT_DAYS = Number(process.env.SHIFT_DAYS ?? 399);
const SHIFT_MS = SHIFT_DAYS * 24 * 60 * 60 * 1000;
const RealDate = Date;
const realNow = RealDate.now;

/**
 * A FUNCTION sharing `Date.prototype`, not `class ShiftedDate extends Date`.
 *
 * A subclass gets its own `prototype`, and `globalThis.Date = Subclass` then makes `Date.prototype` a
 * different object from the intrinsic every other Date in the process was built against. Measured
 * consequences inside a shifted test child: `statSync(f).mtime instanceof Date` was FALSE, so was
 * `structuredClone(d) instanceof Date`, `deepStrictEqual` on two equal dates threw on the prototype
 * mismatch, and `Date()` without `new` threw outright. Nothing in this tree trips those today, but zod,
 * typebox, cron-parser and the AWS/OpenAI SDKs all validate with `instanceof Date` -- and the red would
 * arrive wearing this job's canned "the wall clock moved 399 days" message, which would be a lie.
 *
 * Sharing the intrinsic prototype keeps every one of those true. The only visible difference left is
 * `Date.name`, which is restored below.
 */
function ShiftedDate(...args) {
	// `Date()` without `new` returns a STRING and ignores its arguments, per spec.
	if (new.target === undefined) return RealDate();
	return args.length === 0 ? new RealDate(realNow() + SHIFT_MS) : new RealDate(...args);
}
ShiftedDate.prototype = RealDate.prototype;
// Carry the statics (`parse`, `UTC`) through unchanged: they answer about a GIVEN instant, not about now.
Object.setPrototypeOf(ShiftedDate, RealDate);
ShiftedDate.now = () => realNow() + SHIFT_MS;
Object.defineProperty(ShiftedDate, "name", { value: "Date", configurable: true });
globalThis.Date = ShiftedDate;

// Self-checks, because a silently broken shim turns this whole job green for the wrong reason. Each one
// is a property something in the dependency tree actually relies on.
const FIXED = "2026-08-30T12:00:00.000Z";
const drift = ShiftedDate.now() - realNow();
if (new Date(FIXED).toISOString() !== FIXED) throw new Error("shift-clock: new Date(<arg>) must not shift");
if (Date.parse(FIXED) !== RealDate.parse(FIXED)) throw new Error("shift-clock: Date.parse must not shift");
if (Math.abs(drift - SHIFT_MS) > 5000) throw new Error(`shift-clock: expected a ${SHIFT_DAYS}d shift, got ${drift}ms`);
if (!(new Date() instanceof Date)) throw new Error("shift-clock: instanceof Date must still hold");
if (Date.prototype !== RealDate.prototype) throw new Error("shift-clock: Date.prototype must stay the intrinsic");
if (typeof Date() !== "string") throw new Error("shift-clock: Date() without new must still return a string");
