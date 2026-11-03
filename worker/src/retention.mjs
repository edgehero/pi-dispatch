/**
 * How long the queue keeps a finished job, and how many runs the shared run index holds (issue #761). A LEAF with no
 * imports: the worker, the receiver and the admin read the same values from here, so a value changed in one place
 * cannot leave another reading the old one.
 *
 * `FORGE_JOB_RETENTION_*` is the dedup window of `REQ-DEDUP-BY-DELIVERY-GUID`: a forge job's id is the delivery's own
 * id, and BullMQ's dedup is only "does the job key still exist", so the time a finished job is kept IS how long a
 * redelivery is refused. 31 days is comfortably longer than any forge's redelivery window: GitHub documents "You can
 * redeliver webhook deliveries that occurred in the past 3 days" and "GitHub does not automatically redeliver failed
 * deliveries". Every marker that stands in for a job key once it is gone (a steered delivery's marker, the poller's
 * cursor, the approval's finished mark, the console trail's claim) is derived from it, so shortening it shortens all of
 * them together, and lengthening it cannot leave one of them shorter than the job it guards.
 *
 * BullMQ's `removeOnComplete.age` / `removeOnFail.age` are in SECONDS and a Valkey `PX` is in milliseconds, so both are
 * exported and each site takes the one its call wants, never a conversion of its own.
 */

/** The forge job retention in days: the delivery dedup window (`REQ-DEDUP-BY-DELIVERY-GUID`). */
export const FORGE_JOB_RETENTION_DAYS = 31;
/** The same, in seconds: BullMQ's `removeOnComplete.age` / `removeOnFail.age`, a Valkey `EX`. */
export const FORGE_JOB_RETENTION_S = FORGE_JOB_RETENTION_DAYS * 86_400;
/** The same, in milliseconds: a Valkey `PX`, an age compared with `Date.now()`. */
export const FORGE_JOB_RETENTION_MS = FORGE_JOB_RETENTION_S * 1000;

/**
 * A local or cron job's retention, in seconds. Local jobs are not redelivered, so their window only has to cover a
 * repeated `pi-dispatch run` and the console's re-run, not a forge's redelivery. Named here so the console can say how
 * long a re-run's data is kept by the same values the queue uses.
 */
export const LOCAL_JOB_KEPT_COMPLETED_S = 24 * 3600;
export const LOCAL_JOB_KEPT_FAILED_S = 7 * 24 * 3600;

/**
 * The shared run index's member cap (`PI_RUN_MIRROR_MAX_RUNS`). Every writer trims the index to its OWN cap, so in a
 * fleet the lowest setting wins, and each trim raises the horizon, so a reader sees a cut rather than idle time.
 * The floor is the console's widest read (1,000 runs): a smaller index would cut that read short. The ceiling bounds the
 * portfolio snapshot's single read of the whole index.
 */
export const RUN_MIRROR_MAX_RUNS_DEFAULT = 5_000;
export const RUN_MIRROR_MAX_RUNS_MIN = 1_000;
export const RUN_MIRROR_MAX_RUNS_MAX = 20_000;

/**
 * `PI_RUN_MIRROR_MAX_RUNS` read leniently, for a reader that must not throw (the admin's paths): unset or empty is the
 * default; a value outside the bounds, or not a plain integer, is the default with `problem` naming why. The worker
 * reads the same key strictly (`config.mjs`) and refuses to start on a bad value, so a lenient reader only ever meets
 * one the worker already refused.
 */
export function runMirrorMaxRunsOf(raw) {
	if (raw === undefined || raw === null || raw === "") return { value: RUN_MIRROR_MAX_RUNS_DEFAULT };
	// The worker's own rule (`boundedInt`): a plain integer as written, so "05000" or "1e4" is refused there and the
	// default here, never two answers to one value.
	const text = String(raw).trim();
	const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
	if (!Number.isSafeInteger(n) || String(n) !== text || n < RUN_MIRROR_MAX_RUNS_MIN || n > RUN_MIRROR_MAX_RUNS_MAX) {
		return { value: RUN_MIRROR_MAX_RUNS_DEFAULT, problem: `not an integer ${RUN_MIRROR_MAX_RUNS_MIN}-${RUN_MIRROR_MAX_RUNS_MAX}` };
	}
	return { value: n };
}
