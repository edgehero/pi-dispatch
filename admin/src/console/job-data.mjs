/**
 * The queue data of failed jobs, read for one purpose: the reserve a retry will hold (issue #642). Retrying a failed job
 * puts it back in the queue, and the worker reserves for it again at pickup (CONST-BUDGET-BEFORE-TOKENS), so a retry is
 * a paid action and its preview shows `estimateReserve(job.data)`, the worker's own rule.
 *
 * `planFailedBulk` (job-actions.mjs) lists ids, queues and fingerprints and deliberately carries no job data, so this
 * READ-ONLY helper takes the queue each listed job is on and asks it for the job (`queue.getJob`, the read side of
 * `retryFailedJob`). It never changes a job, and it writes nothing by building its queues (issue #1036): each is
 * built without BullMQ's meta write (`makeQueue`'s `metaWrite: false`), as the fleet reader builds its own.
 *
 * The data stays in the console process: only the reserve computed from it reaches a preview, never a field of it (a
 * forge job's data holds the issue's title and body).
 */
import { parseConnection } from "@edgehero/pi-dispatch/connection";
import { closeWithin, consoleQueueConnection, makeQueue } from "@edgehero/pi-dispatch/queue";

/** How long a queue's close may wait for its answer before its connection is dropped (`closeWithin`). */
const CLOSE_TIMEOUT_MS = 1_000;

/**
 * `jobs` is `[{ jobId, queue }]`; resolves a `Map` of job id to its `data`, or null when the job or its data cannot be
 * read (gone, Valkey down, a queue that does not answer). Never throws; every queue opened is closed.
 *
 * ONE step, `timeoutMs` for the whole list (issue #842), not for each job in turn: a retry preview names up to a hundred
 * jobs, and on a Valkey that stopped answering a bound per job held the preview for a hundred of them. What was not
 * read by then is null, as a job that is gone is. The queues' close is started and never awaited, since it waits for an answer
 * too (`closeWithin` drops the connection past its own bound).
 */
export async function readJobsData({ url, jobs, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500 }) {
  const out = new Map();
  const wanted = (Array.isArray(jobs) ? jobs : []).filter((j) => typeof j?.jobId === "string" && typeof j?.queue === "string");
  const opened = new Map();
  const queueOf = (name) => {
    if (!opened.has(name)) opened.set(name, queueFn(consoleQueueConnection(url, parseConnectionFn), { name, metaWrite: false }));
    return opened.get(name);
  };
  const release = () => {
    const queues = [...opened.values()];
    opened.clear();
    for (const q of queues) void closeWithin(q, CLOSE_TIMEOUT_MS);
  };
  // Whether the bound fired: a read that answers after it writes nothing into a map the caller already holds.
  let late = false;
  // Every job asked at once: each is one small read on its queue's connection, so a hundred of them cost about one
  // round trip, and the one bound is not spent a job at a time on a Valkey that is far away.
  const work = Promise.all(
    wanted.map(async ({ jobId, queue }) => {
      let data = null;
      try {
        const job = await queueOf(queue).getJob(jobId);
        data = job?.data && typeof job.data === "object" ? job.data : null;
      } catch {
        data = null;
      }
      if (!late) out.set(jobId, data);
    }),
  );
  let timer;
  try {
    await Promise.race([
      work,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    // every job not read is null below
  } finally {
    clearTimeout(timer);
    late = true;
    for (const { jobId } of wanted) if (!out.has(jobId)) out.set(jobId, null);
    release();
    work.then(release, release);
  }
  return out;
}
