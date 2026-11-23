/**
 * A monotonic clock and timers moved by hand, for a subject that takes both (`pageDeadline`'s `clock` and `timers`).
 * Nothing fires on its own: `advance(ms)` moves the clock forward and fires each timer whose time has come, oldest
 * first, letting what each one settles run before the next, so a test steps through a deadline without waiting for it.
 */
export function handTime(start = 1_000) {
  let now = start;
  let made = 0;
  const pending = new Map();
  /** Let every promise reaction that is ready run, a few turns deep, before the test looks or the next timer fires. */
  const settled = async () => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    clock: () => now,
    timers: {
      setTimeout(fn, ms = 0) {
        made += 1;
        pending.set(made, { at: now + Math.max(0, Number(ms) || 0), fn });
        return made;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    /** How many timers wait to fire. */
    waiting: () => pending.size,
    settled,
    async advance(ms) {
      const end = now + ms;
      await settled();
      for (;;) {
        const due = [...pending].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        pending.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await settled();
      }
      now = end;
      await settled();
    },
  };
}
