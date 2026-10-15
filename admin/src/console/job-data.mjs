/**
 * The queue data of failed jobs, read for one purpose: the reserve a retry will hold (issue #642). Retrying a failed job
 * puts it back in the queue, and the worker reserves for it again at pickup (CONST-BUDGET-BEFORE-TOKENS), so a retry is
 * a paid action and its preview shows `estimateReserve(job.data)`, the worker's own rule.
 *
 * `planFailedBulk` (job-actions.mjs) lists ids, queues and fingerprints and deliberately carries no job data, so this
 * READ-ONLY helper takes the queue each listed job is on and asks it for the job (`queue.getJob`, the read side of
 * `retryFailedJob`). It never changes a job. The one write it cannot avoid is BullMQ's own: constructing a `Queue`
 * writes its meta hash once, which `makeQueue` gives no way to turn off (the fleet reader's header says the same).
 *
 * The data stays in the console process: only the reserve computed from it reaches a preview, never a field of it (a
 * forge job's data holds the issue's title and body).
 */
import { parseConnection } from "@edgehero/pi-dispatch/connection";
import { makeQueue } from "@edgehero/pi-dispatch/queue";

/**
 * `jobs` is `[{ jobId, queue }]`; resolves a `Map` of job id to its `data`, or null when the job or its data cannot be
 * read (gone, Valkey down, a queue that does not answer). Never throws; every queue opened is closed.
 */
export async function readJobsData({ url, jobs, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500 }) {
  const out = new Map();
  const opened = new Map();
  const queueOf = (name) => {
    if (!opened.has(name)) opened.set(name, queueFn(parseConnectionFn(url, { failFast: true }), { name }));
    return opened.get(name);
  };
  try {
    for (const { jobId, queue } of Array.isArray(jobs) ? jobs : []) {
      if (typeof jobId !== "string" || typeof queue !== "string") continue;
      try {
        const read = queueOf(queue).getJob(jobId);
        const job = await Promise.race([read, new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.())]);
        out.set(jobId, job?.data && typeof job.data === "object" ? job.data : null);
      } catch {
        out.set(jobId, null);
      }
    }
  } finally {
    for (const q of opened.values()) await q.close().catch(() => {});
  }
  return out;
}
