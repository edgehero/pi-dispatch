/**
 * The confirms the console is still carrying out (issue #842), so a stop waits for them rather than cutting them.
 *
 * A confirm appends its `ok` audit row, then writes, then answers. A console that exits once it was told to stop cut
 * that sequence wherever it stood: a bulk retry of a hundred jobs retried three and left a hundred `ok` rows with no
 * outcome, on a Valkey that answered every command. So `serve`'s stop first refuses new confirms (`stop`), then waits
 * here (`idle`), inside its own deadline, and a confirm still open at the deadline is given its outcome row before the process goes (`abandon`): it
 * was sent and not answered, so the row says it may or may not have been made, never nothing.
 *
 * Pure bookkeeping: no clock, no Valkey, no audit writer of its own. Each confirm brings the function that writes its
 * own row (the audit log is a file, so that needs no answer from anyone).
 */

/** What a confirm's audit row says when the console stopped before the write answered. */
export const STOPPED_UNCONFIRMED = "the console stopped before this change answered, so it may or may not have been made; look at the fleet";

/** What a confirm that arrives once the console is stopping is told: nothing was sent, nothing was audited as made. */
export const CONSOLE_STOPPING = "the console is stopping, so this change was not made; nothing was changed. Confirm it again once the console is back";

export function makeWritesInFlight() {
  const open = new Set();
  let stopping = false;
  return {
    /**
     * Run `fn`, a confirm's write and answer, as one of the writes in flight. `abandon()` is called at most once, and
     * only if the console stops while `fn` is still running: it appends the confirm's outcome row. Returns `fn`'s own
     * promise, settled or rejected as `fn` does (a `fn` that throws rejects it).
     */
    run(abandon, fn) {
      const entry = { abandon, promise: null };
      entry.promise = (async () => fn())().finally(() => open.delete(entry));
      open.add(entry);
      return entry.promise;
    },
    /** How many confirms are still running. */
    size: () => open.size,
    /**
     * The stop has begun: from here `stopping()` is true, and a confirm that arrives is refused before it sends or
     * audits anything (`confirmAction`), so the set `idle` waits for can only shrink.
     */
    stop() {
      stopping = true;
    },
    stopping: () => stopping,
    /** Resolves once every confirm that was running has answered, however each ended. Never rejects. */
    async idle() {
      await Promise.allSettled([...open].map((entry) => entry.promise));
    },
    /** Give every confirm still running its outcome row and forget it. Returns how many there were. Never throws. */
    abandon() {
      const cut = [...open];
      open.clear();
      for (const entry of cut) {
        try {
          entry.abandon();
        } catch {
          // the row is best effort: its writer says so itself
        }
      }
      return cut.length;
    },
  };
}
