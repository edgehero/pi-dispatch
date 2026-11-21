// The one import this module takes, and it is otherwise an import-free leaf (issue #339).
import { scrubCredentials } from "./redact.mjs";

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
 * Recursive deletes run asynchronously after a store has detached the expired name (#924). Flat-file reapers
 * yield between expiry-and-unlink decisions. The short metadata decisions stay synchronous so an await cannot
 * delete a replacement written under the same name. One slow metadata syscall remains a host-filesystem risk.
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
export function makeRetentionSweep({ reapers, intervalMs, log = () => {}, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
	let timer = null;
	let closed = false;
	let inFlight = null;

	async function sweepOnce() {
		if (closed) return;
		// DIVERGENCE from host-registry, which has no overlap guard: a beat is three bounded Redis writes
		// against a 15s interval and two overlapping beats write the same values, while a sweep is
		// unbounded filesystem I/O with deletes in it. At the 24h default this is close to unreachable --
		// `listRunningSandboxes` alone is capped at 5s by its own exec timeout -- but it is what keeps a
		// short PI_SWEEP_INTERVAL_HOURS against a slow network filesystem from stacking sweeps that race
		// each other's deletes.
		if (inFlight) {
			log("retention_sweep_overlapped", {});
			return;
		}
		const startedAt = now();
		inFlight = (async () => {
			for (const entry of reapers) {
				if (closed) break;
				try {
					// Destructured INSIDE the try: a malformed entry must be one log line like any other
					// reaper fault, not a rejection out of a function the interval calls with `void`.
					const { name, reap } = entry;
					await reap({ stopped: () => closed });
					// Between stores, so stores with no eligible entries still yield.
					await new Promise((resolve) => setImmediate(resolve));
				} catch (err) {
					// The existing per-store event names, reused rather than invented: an operator greps one
					// name and gets both the boot sweep and every tick. Fault isolation per store, so one
					// broken reaper cannot stop the other two.
					// SCRUBBED here as well as at each store's own catch, and that is not belt-and-braces: this line
					// re-emits every one of those families on the TIMER, so a fix confined to the boot paths would
					// leave every tick uncovered (issue #339).
					log(`${entry?.name}_reaper_skipped`, { reason: scrubCredentials(err?.message) });
				}
			}
		})();
		try {
			await inFlight;
			log("retention_sweep", { ms: now() - startedAt, ...(closed ? { stopped: true } : {}) });
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
		 * check must not start another store after close. Reapers also check it between entries. The in-flight
		 * delete drains up to the bound; timing out cannot cancel fs.rm. A restart reaps any detached remainder.
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

/**
 * How long after a sandbox pass that left its lap unfinished the next follow-up starts (issue #978): the timer is armed
 * when that pass ends and fires a minute later. A daily tick can land inside that minute and run a pass of the same lap
 * (one at a time, by the reaper's single flight), so the minute spaces the follow-ups, not every two passes. A pass
 * stops at its first loop boundary past 20 s (`SANDBOX_PASS_BUDGET_MS` in `sandbox-store.mjs`), so it lasts 20 s plus
 * the entry it was on and that entry's rest (at most 10 s more); an entry's rest is as long as the entry took up to
 * that cap, and the runtime listing at the start of a pass has no rest after it. Each pass removes at most fifty runs:
 * a thousand runs take at least twenty passes, about twenty minutes at this delay on a runtime that answers at once
 * (computed from 20 measured passes of about 6 s), and longer on one that does not, which is the point.
 */
export const SANDBOX_FOLLOWUP_DELAY_MS = 60_000;

/**
 * The sandbox sweep's FOLLOW-UP passes (issue #978). The sandbox reaper's pass stops at its budget and says `more`
 * while its LAP (the leftover tombstones, the runs, then the networks, in name order) is unfinished; `after(result)`
 * arms ONE `.unref()`'d timer for that, and each follow-up pass hands its own result back, so passes repeat a delay
 * apart while one says `more` and stop at the first that does not. Each pass resumes where the last stopped and
 * cannot stop before it has visited one entry, so the lap always ends and a chain of follow-ups is at most one lap,
 * whatever it removed (a pass that ends the lap, a daily tick's too, clears a follow-up already armed): what is still
 * held at the end waits for the next boot or periodic sweep. Anything else is ignored: no
 * result, and `{ busy: true }` from a call that met a pass in flight, whose own result arrives through its caller.
 *
 * APART FROM `makeRetentionSweep`, on purpose: a follow-up runs OUTSIDE that sweep's `inFlight`, so a daily tick never
 * skips the log and session reapers because a follow-up pass was running. The reaper's own single flight is what keeps
 * two sandbox passes from overlapping. And it runs at every `PI_SWEEP_INTERVAL_HOURS`, `0` included, where the periodic
 * sweep is still never constructed: these passes are the boot sweep finishing in bounded steps, not a second sweep.
 *
 * `close()` stops the timer and waits for a pass in flight up to `SWEEP_DRAIN_TIMEOUT_MS`, the periodic sweep's posture
 * and for its reason; the pass is asked to stop (`stopped`), and its rests wake within a quarter second. A reap that
 * throws is one `sandbox_reaper_skipped` line, scrubbed, never a rejection out of a timer callback.
 */
export function makeSweepFollowUps({ reap, delayMs = SANDBOX_FOLLOWUP_DELAY_MS, log = () => {}, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
	let timer = null;
	let closed = false;
	let inFlight = null;

	async function runOnce() {
		if (closed) return;
		inFlight = (async () => {
			try {
				return await reap({ stopped: () => closed });
			} catch (err) {
				log("sandbox_reaper_skipped", { reason: scrubCredentials(err?.message) });
				return null;
			}
		})();
		let result = null;
		try {
			result = await inFlight;
		} finally {
			inFlight = null;
		}
		after(result);
	}

	/**
	 * Arm the next pass when `result` says the lap is unfinished; a no-op otherwise, after `close()`, and while armed.
	 * A pass that says `more: false` ended the lap, so a follow-up already armed is cleared: a daily tick that lands
	 * between two follow-ups and finishes the lap must not leave one behind to start the next lap from the top.
	 */
	function after(result) {
		if (closed) return;
		if (result?.more === false && timer) {
			clearTimeoutFn(timer);
			timer = null;
			return;
		}
		if (timer || inFlight || result?.more !== true) return;
		timer = setTimeoutFn(() => {
			timer = null;
			void runOnce();
		}, delayMs);
		timer?.unref?.();
	}

	return {
		after,

		/**
		 * `closed` FIRST, as in `makeRetentionSweep.close`: a pass already started is told to stop, and no timer re-arms
		 * from its result. The drain bound's own timer is NOT unref'd, for the reason `SWEEP_DRAIN_TIMEOUT_MS` gives.
		 */
		async close() {
			closed = true;
			if (timer) clearTimeoutFn(timer);
			timer = null;
			if (!inFlight) return;
			await new Promise((resolve) => {
				const t = setTimeoutFn(() => {
					log("sandbox_followup_drain_timeout", { ms: SWEEP_DRAIN_TIMEOUT_MS });
					resolve();
				}, SWEEP_DRAIN_TIMEOUT_MS);
				inFlight.catch(() => {}).then(() => {
					clearTimeoutFn(t);
					resolve();
				});
			});
		},
	};
}
