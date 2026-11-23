/**
 * One deadline over everything a page load asks of Valkey (issues #987 and #988).
 *
 * A page's reads each have a bound of their own, and `loadPageData` makes them one after another. On a Valkey that is
 * connected and does not answer, a page therefore took the SUM of those bounds (7.6 to 40 s measured), and the live
 * pill said Live until the page's own load ended. With one deadline counted from the start of the load, a read is
 * given its own bound or what is left when that is sooner (`within`), a read that takes no bound is waited for until
 * the deadline and no longer (`settle`), and past it the load draws each such read as the unread one it is.
 *
 * The shape is the CLI's `statusDeadline` (worker/src/cli.mjs): on the monotonic clock, never the wall clock, so a
 * clock step neither spends a deadline nor extends one. The clock and the timers are injected, so a test moves time
 * by hand. A leaf: it imports nothing of the console.
 */

/**
 * How long one page load may ask Valkey in all. Longer than the bound the console's clients give one command (5 s), so
 * a command that answers inside its own bound is never cut by the deadline alone; only what follows a slow one is.
 */
export const PAGE_DEADLINE_MS = 6_000;

/**
 * How much longer a read that was handed its bound is waited for (`settle`'s `grace`). Its Valkey reads end at the
 * deadline, each by the bound it was handed; what is left is the reader saying so in its own answer, reading files
 * and putting the view together, and without this a read cut at the deadline would be dropped whole, with the file
 * facts it had just read and an answer of the page's in place of the reader's own.
 */
export const PAGE_VIEW_GRACE_MS = 1_000;

/**
 * What a caller has `settle` throw for a read the deadline cut, where the read's own catch already words a read that
 * failed. `code` is a log's word for it; nothing here is drawn on a page.
 */
export class PageDeadlinePassed extends Error {
  constructor() {
    super("the page's deadline passed before this read answered");
    this.name = "PageDeadlinePassed";
    this.code = "PAGE_DEADLINE";
  }
}

/**
 * A deadline `ms` from now, on `clock` (milliseconds, monotonic), with `timers` (`setTimeout`, `clearTimeout`):
 *
 *   - `within(ownMs)`: the bound for a read that takes one, its own or what is left of the deadline when that is
 *     sooner, a whole number never below 1: several readers take 0, or a number that is not whole, as "use the
 *     default", which would give a read its whole time again after the deadline passed. `within(Infinity)` is what
 *     is left.
 *   - `settle(read, late, { grace })`: `read`'s answer, or `late()` once the deadline has passed without it (`grace`:
 *     the deadline and `graceMs`). `read` is a promise, or a function that makes the read: a function is not called
 *     once its time has passed, while a promise is a read already made, and its answer is taken if it has one. A read
 *     that settles in the same turn as the deadline wins: `late` is asked one turn of the loop after it. A `late`
 *     that throws makes this reject, so a caller's own catch takes it. The read left behind goes on to its own bound;
 *     its answer is dropped and a later rejection is caught here.
 *   - `spent()`: whether the deadline has passed.
 */
export function pageDeadline(ms = PAGE_DEADLINE_MS, { clock = () => performance.now(), timers = globalThis, graceMs = PAGE_VIEW_GRACE_MS } = {}) {
  const at = clock() + ms;
  const left = () => at - clock();
  return {
    within: (ownMs) => Math.max(1, Math.round(Math.min(ownMs, left()))),
    spent: () => left() <= 0,
    settle(read, late, { grace = false } = {}) {
      const waitLeft = () => left() + (grace ? graceMs : 0);
      return new Promise((resolve, reject) => {
        // `late` is asked at most once, and never for a read that answered: a caller may count the reads it cut.
        const lateNow = () => {
          try {
            resolve(late());
          } catch (err) {
            reject(err);
          }
        };
        let reading = read;
        if (typeof read === "function") {
          if (waitLeft() <= 0) return lateNow();
          // A read that throws as it is made is a read that failed, as one that rejects is.
          try {
            reading = read();
          } catch (err) {
            return reject(err);
          }
        }
        let timer = null;
        let over = false;
        const answered = (settleWith) => (value) => {
          if (over) return;
          over = true;
          if (timer !== null) timers.clearTimeout(timer);
          settleWith(value);
        };
        // Both handlers stay on the read after the timer has answered for it: they then do nothing, and the rejection
        // of a read left behind is handled here rather than raised as unhandled.
        Promise.resolve(reading).then(answered(resolve), answered(reject));
        const wait = (tie = false) => {
          timer = timers.setTimeout(() => {
            if (over) return;
            // A timer can fire a little before its time (the loop keeps a coarser clock than this one): the rest is
            // waited out, so no read is cut before the deadline, and `spent()` holds whenever one is.
            if (waitLeft() > 0) return wait();
            // A read that ends at this same instant, by the bound it was handed or by its own, has its answer on the
            // way: one more turn of the loop lets it land, so the read's own answer wins over `late`.
            if (!tie) return wait(true);
            over = true;
            lateNow();
          }, tie ? 0 : Math.max(0, Math.ceil(waitLeft())));
          // A page's wait holds no process open: a console that is stopping does not wait out a deadline.
          timer?.unref?.();
        };
        wait();
      });
    },
  };
}
