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
 *
 * WHAT THIS COSTS THAT THE BOOT SWEEP DID NOT, and it is the one genuinely new failure mode here. All
 * three reapers delete SYNCHRONOUSLY (`rmSync`, `unlinkSync`), which was free at boot because nothing was
 * in flight, and is not free on a timer beside draining jobs: a long delete blocks the event loop, and
 * `index.mjs` sets `maxStalledCount: 0` against BullMQ's 30s lock, so a loop blocked past the renewal
 * window FAILS a paid job rather than silently re-running it. The direction is safe and the outcome is
 * still new. Two things bound it: this loop yields between stores, and the sandbox reaper -- the only one
 * that deletes whole trees, each a repository clone -- yields between entries. What remains is one
 * directory's own `rmSync`, which is why that residual is stated here rather than implied.
 */

/** The default cadence. A named constant on HOST_BEAT_MS's precedent, not a literal at the call site. */
export const SWEEP_INTERVAL_HOURS = 24;

/**
 * How long `close()` will wait for an in-flight sweep before giving up on it.
 *
 * `index.mjs`'s shutdown says a closer that never settles blocks `process.exit(0)`, "which no closer
 * here does" -- and an unbounded drain would have made that sentence false. The obvious defence, that
 * the sweep's own docker call is capped at 5s, is NOT true: `listRunningSandboxes` uses
 * `execFile`'s `timeout`, which only sends SIGTERM and then still waits for the child's `close`, so a
 * `docker ps` wedged on a dead daemon socket never settles at all.
 *
 * NOT unref'd, on `host-registry`'s own reasoning: an unref'd timer does not fire when nothing else
 * holds the loop, which is exactly the shutdown this bound exists for. The cost is that a hung sweep
 * delays exit by at most this long, which is the point.
 */
const SWEEP_DRAIN_TIMEOUT_MS = 10_000;

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
			for (const entry of reapers) {
				try {
					// Destructured INSIDE the try: a malformed entry must be one log line like any other
					// reaper fault, not a rejection out of a function the interval calls with `void`.
					const { name, reap } = entry;
					await reap();
					// Between stores, so one tick is never a single uninterruptible block. See the note on
					// synchronous deletes in the module docblock.
					await new Promise((resolve) => setImmediate(resolve));
				} catch (err) {
					// The existing per-store event names, reused rather than invented: an operator greps one
					// name and gets both the boot sweep and every tick. Fault isolation per store, so one
					// broken reaper cannot stop the other two.
					log(`${entry?.name}_reaper_skipped`, { reason: err?.message });
				}
			}
		})();
		try {
			await inFlight;
			log("retention_sweep", { ms: Date.now() - startedAt });
		} catch {
			// Unreachable today: every reaper is wrapped above. Here because the interval calls this with
			// `void`, so ANY rejection is an unhandled rejection, and Node kills the process for one by
			// default. A sweep must never be able to take the worker down.
		} finally {
			inFlight = null;
		}
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
			if (!inFlight) return;
			await new Promise((resolve) => {
				const t = setTimeout(() => {
					log("retention_sweep_drain_timeout", { ms: SWEEP_DRAIN_TIMEOUT_MS });
					resolve();
				}, SWEEP_DRAIN_TIMEOUT_MS);
				inFlight.catch(() => {}).then(() => {
					clearTimeout(t);
					resolve();
				});
			});
		},
	};
}
