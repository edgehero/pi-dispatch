/**
 * The periodic retention sweep (issue #292, OQ-007).
 *
 * Every reaper in this project swept ONCE, at boot: the run history (`makeLogReaper`), the retained
 * sandboxes (`makeSandboxReaper`) and the session store (`sessionStore.reapSessions`). The supported
 * deployment shape is a service unit that restarts only on failure, so the healthy worker was exactly
 * the one that never re-swept. Thirty days of uptime held thirty days of GROWTH, not thirty days of
 * retention, and the three windows an operator configured described nothing.
 *
 * This is one `.unref()`'d interval that re-runs the three closures boot already built. It rebuilds
 * nothing, so one configuration read serves boot and every tick after it and the two cannot drift.
 *
 * A MODULE rather than a few lines inline in `start.mjs`, for a reason that is about testing and not
 * about tidiness: `worker/test/start-wiring.test.mjs` skips its entire file unless `VALKEY_TEST_URL` is
 * set, so anything living in the boot function is exercised only in CI. The sharp edges of an interval
 * -- re-entrancy, an idempotent close, a sweep still running when the next tick fires -- are precisely
 * what wants pinning on a laptop, and here they get a plain test file with no queue in it.
 *
 * REJECTED: a `while (!stopped) { await sweep(); await sleep(ms); }` loop on `receiver/src/poller.mjs`'s
 * pattern. It gets non-overlap for free and is already proven testable in this repo, but its `setTimeout`
 * is not unref'd and would hold the worker's event loop open for up to a day, and `close()` becomes a
 * promise handshake rather than a `clearInterval`. The poller IS its process's main loop and wants to
 * hold the loop open; a background sweep must not.
 *
 * The interval idiom is `host-registry.mjs`'s, deliberately, down to the ordering inside `close()`. Two
 * divergences from it are marked at their sites, because a reader who knows that file will otherwise
 * "fix" them back.
 */

/** The default cadence. A named constant on HOST_BEAT_MS's precedent, not a literal at the call site. */
export const SWEEP_INTERVAL_HOURS = 24;

/**
 * The ceiling, and it is not decoration. `setInterval` clamps a delay above 2^31-1 ms (about 24.85 days)
 * to 1ms, so a fat-fingered `PI_SWEEP_INTERVAL_HOURS=1000` would silently become a hot loop sweeping the
 * filesystem as fast as the event loop allows. One week is the refusal point rather than Node's own
 * ceiling, because an interval longer than a week is not a sweep, it is `0` with extra steps, and `0`
 * already says that clearly.
 */
export const SWEEP_INTERVAL_MAX_HOURS = 168;

/**
 * Build the sweep. `reapers` is an ORDERED array of `{ name, reap }` -- logs, sandboxes, sessions, the
 * same order boot runs them in, so a tick's log lines read like a boot's. An object would read as
 * unordered, and this one is not.
 *
 * `setIntervalFn`/`clearIntervalFn` are injected. No production caller passes them; they exist because
 * this repo has no fake-timer infrastructure at all and its stated doctrine is to inject a seam rather
 * than reach for a global. The alternative -- a 1ms interval and a real `sleep` in the test -- would be a
 * wall-clock-dependent test, which is the exact class issue #293 exists to eliminate, landing in the same
 * change that adds #293's guard.
 */
export function makeRetentionSweep({ reapers, intervalMs, log = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
	let timer = null;
	let closed = false;
	let inFlight = null;

	async function sweepOnce() {
		if (closed) return;
		// DIVERGENCE from host-registry, which has no overlap guard: a beat is three bounded Redis writes
		// against a 15s interval and two overlapping beats write the same values, while a sweep is
		// unbounded filesystem I/O with `rmSync` in it. At the 24h default this is close to unreachable --
		// `listRunningSandboxes` alone is capped at 5s by its own exec timeout -- but it is what keeps a
		// short PI_SWEEP_INTERVAL_HOURS against a slow network filesystem from stacking sweeps that race
		// each other's deletes.
		if (inFlight) {
			log("retention_sweep_overlapped", {});
			return;
		}
		const startedAt = Date.now();
		inFlight = (async () => {
			for (const { name, reap } of reapers) {
				try {
					await reap();
				} catch (err) {
					// The existing per-store event names, reused rather than invented: an operator greps one
					// name and gets both the boot sweep and every tick. Fault isolation per store, so one
					// broken reaper cannot stop the other two.
					log(`${name}_reaper_skipped`, { reason: err?.message });
				}
			}
		})();
		try {
			await inFlight;
		} finally {
			inFlight = null;
		}
		log("retention_sweep", { ms: Date.now() - startedAt });
	}

	return {
		sweepOnce,

		/**
		 * Arm the interval. DIVERGENCE from `host-registry.start`, which beats immediately: boot has just
		 * run all three reapers, so an immediate sweep would double the boot work and break the call-order
		 * pins in start-wiring. The first tick lands one full interval after boot.
		 */
		start() {
			if (closed || timer) return; // a second start would leak the first interval
			// A non-positive interval must arm NOTHING. setInterval(fn, 0) is a hot loop, and the caller
			// already gates on the knob being > 0; this is what turns a future mis-wire into a no-op rather
			// than a disk-melting one.
			if (!(intervalMs > 0)) return;
			timer = setIntervalFn(() => void sweepOnce(), intervalMs);
			timer?.unref?.();
		},

		/**
		 * `closed` is set FIRST, for host-registry's own reason: a sweep already past the top-of-function
		 * check must not `rmSync` after the closer has reported done. Then the in-flight sweep is drained,
		 * so a shutdown never leaves a half-deleted retained workspace behind a worker that has already
		 * said it stopped cleanly.
		 *
		 * IDEMPOTENCE COMES FROM NULLING THE TIMER, not from an `if (closed) return` at the top. There was
		 * one here, and a mutation pass proved it pinned nothing: with `timer` already null the second call
		 * clears nothing, awaits a settled promise and returns. Issue #295 reached the identical conclusion
		 * about the watcher closers and removed the guard rather than documenting it, and a guard with
		 * nothing behind it is worse than none, because it invites a reader to trust it for something.
		 */
		async close() {
			closed = true;
			if (timer) clearIntervalFn(timer);
			timer = null;
			await (inFlight ?? Promise.resolve()).catch(() => {});
		},
	};
}
