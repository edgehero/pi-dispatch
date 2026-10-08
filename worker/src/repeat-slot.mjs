/**
 * The scheduled-for instant of a BullMQ job scheduler's job, read from the deterministic `repeat:<id>:<millis>` id it
 * mints (DES-CRON-VIA-BULLMQ-SCHEDULER). A leaf module, so the run record and the prepare step read one parser.
 */

/** Parse the millis out of a `repeat:<id>:<millis>` BullMQ scheduled jobId, or null. */
export function scheduledForMillis(queueJobId) {
	if (typeof queueJobId !== "string" || !queueJobId.startsWith("repeat:")) return null;
	const tail = queueJobId.slice(queueJobId.lastIndexOf(":") + 1);
	if (tail === "") return null;
	const millis = Number(tail);
	return Number.isFinite(millis) ? millis : null;
}
