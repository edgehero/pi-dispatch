/**
 * The waiting read's marks of a floor (issue #1037), as a view carries them beside a list or a count it cut from the
 * waiting jobs: a view hands its page no snapshot, so without them the page drew that list as whole over a read that
 * was not. Whether the read was cut (`truncated`), how many queues it left past its bound (`queuesCut`), whether its
 * set of queues may be short (`queuesShort`, issue #963), the queues one of whose lists it did not read with the code
 * Valkey answered (`listsUnread`, issue #1036), and per queue whether it was cut and whether that was a list not read
 * (`byQueue`). A queue's name and a one-word code only, at most `max` queues: nothing of a job, and no client's words.
 * Null for a read that was not made or did not answer, which a view says in its own mark.
 *
 * The page turns them into words with the one helper every reader of the waiting set shares (`waitingFloor` in
 * `console/panels/common.mjs`), so a project, the Models page and the overview say one floor in the same sentence.
 */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._:@/+#!~-]{0,299}$/;
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export function waitingMarksOf(waiting, { max = 200 } = {}) {
  if (waiting === null || typeof waiting !== "object" || waiting.unreachable) return null;
  const named = (list) => (Array.isArray(list) ? list : []).filter((entry) => typeof entry?.queue === "string" && NAME.test(entry.queue)).slice(0, max);
  return {
    truncated: waiting.truncated === true,
    queuesCut: Number.isSafeInteger(waiting.queuesCut) && waiting.queuesCut > 0 ? waiting.queuesCut : 0,
    queuesShort: waiting.queuesShort === true,
    listsUnread: named(waiting.listsUnread).map((entry) => ({ queue: entry.queue, error: typeof entry.error === "string" && CODE.test(entry.error) ? entry.error : null })),
    byQueue: named(waiting.byQueue).map((entry) => ({ queue: entry.queue, truncated: entry.truncated === true, listsUnread: entry.listsUnread === true })),
  };
}

/** Whether those marks say the rows are a floor: the read was cut (a list not read is that too) or its queues may be short. */
export const waitingMarksFloor = (marks) => marks !== null && typeof marks === "object" && (marks.truncated === true || marks.queuesShort === true);
