/**
 * Which job containers this worker is starting and running right now (issue #1023), for the one reader that needs to
 * know: the sandbox retention sweep (`sandbox-store.mjs`), which waits while a container is starting and takes small
 * passes while one runs. A burst of removals on a VM-backed daemon stalled the daemon for the jobs beside it; nothing
 * told the sweep that a job was there.
 *
 * ONE object per worker process, handed to every venue's run function and to the sweep (`start.mjs`). `enter()` is
 * called when a run begins and answers that run's own handle:
 *   - `started()`: the container is up (its first output, or its CLI child ending, whichever comes first), so the run
 *     moves from starting to running;
 *   - `ended()`: the run is over, however it ended, and is counted no more.
 * Both are idempotent and safe in any order: `ended()` before `started()` ends a run that never started, and a
 * `started()` after `ended()` does nothing.
 *
 * A START THAT NEVER REPORTS CANNOT HOLD THE SWEEP. The sweep waits while `starting()` is above zero, and the sweep is
 * what keeps the retained runs bounded: held for good, the disk fills and every job on the host fails for a reason
 * nothing names. So a run still starting `CONTAINER_START_MAX_MS` after it entered stops counting as a start, whatever
 * the cause (a container minutes in coming up on a stalled daemon, a run whose promise never settles, a report lost
 * to a defect). It is counted as RUNNING from then until it ends, never dropped: the common cause is a container that
 * is still coming up or runs without writing, and the sweep's small passes are for exactly that. A run counted as
 * running forever (one whose CLI child never closes) costs the sweep its full pass size and nothing else; a small pass
 * still removes, and the passes still come.
 *
 * Process memory, read when asked and never on a timer, so it holds nothing open and a test drives it with a clock.
 * Counts only: no job id, no name, nothing of a job reaches the sweep through here.
 */

/** How long a run may stay "starting" before it counts as running instead (see the header). */
export const CONTAINER_START_MAX_MS = 120_000;

/**
 * `now` is a duration clock in ms (monotonic by default): a wall clock stepped back must not keep a start alive, nor
 * one stepped forward end it early.
 */
export function makeContainerActivity({ now = () => performance.now() } = {}) {
	// Every run between its `enter()` and its `ended()`: when it entered, and whether it said it started.
	const runs = new Set();
	const startingNow = (run, at) => !run.started && at - run.since < CONTAINER_START_MAX_MS;
	return {
		enter() {
			const run = { since: now(), started: false };
			runs.add(run);
			return {
				started() {
					run.started = true;
				},
				ended() {
					runs.delete(run);
				},
			};
		},
		/** How many runs are starting a container: entered, not yet started or ended, and not past the bound. */
		starting() {
			const at = now();
			let n = 0;
			for (const run of runs) if (startingNow(run, at)) n += 1;
			return n;
		},
		/** How many runs have a container up, or have been starting for longer than the bound. */
		running() {
			const at = now();
			let n = 0;
			for (const run of runs) if (!startingNow(run, at)) n += 1;
			return n;
		},
	};
}
