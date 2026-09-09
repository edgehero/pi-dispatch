/**
 * Bounded in-process retry for the boot's HARD-FAIL identity resolutions (issue #318).
 *
 * Issue #316 made a transient identity failure at boot exit 1 so the supervisor restarts through a
 * forge outage -- and then the shipped unit bounded that recovery at about 25 seconds
 * (`RestartSec=5` against `StartLimitBurst=5`), while launchd and nssm bound it not at all. A forge
 * restart takes minutes, so the receiver still ended up stopped, with the bound a property of
 * whichever supervisor the operator happened to install. This module moves the bound INTO the
 * process: one window, read from `RECEIVER_IDENTITY_RETRY_SECONDS` (config.mjs), identical under
 * systemd, launchd, nssm and compose.
 *
 * What it retries is decided by the tag, nothing else. A `piDispatchConfig` throw is a determinate
 * refusal and rethrows SAME-TICK -- no log line, no sleep, so `entryExitCode` still maps it to
 * EXIT_POLICY (2) as fast as before. Everything untagged is transient by `transientError`'s own
 * contract (worker/src/transient.mjs: the absence of the tag is the whole payload). That module is
 * deliberately not imported -- it is not in the worker's export map, and the tag test is the
 * sanctioned discriminator the receiver's `entryExitCode` already uses.
 *
 * Import-free, like the module whose rule it extends: nothing here can drag `node:fs` or a queue
 * into a caller that has neither.
 *
 * The shape, and why each piece is what it is:
 *
 *  - The per-attempt fuse is REF'D, never unref'd. The github arm runs before the queue, the server
 *    or any watcher exists, so this await can be the only thing on the event loop -- exactly
 *    `settleWithin`'s documented bare-context boundary (worker/src/start.mjs): an unref'd fuse that
 *    is the only pending handle never fires and node abandons the await silently, exit 13. Ref'd
 *    costs at most `attemptTimeoutMs` of held loop on a path that is about to exit anyway, and the
 *    inner `finally` clears it the moment the race settles, so even that is normally unreachable.
 *  - A fused-out attempt throws a plain UNTAGGED Error, by decision: a resolver that does not answer
 *    within the fuse is indistinguishable from a forge that is down, which is the transient case.
 *    None of the resolvers takes an AbortSignal, so the losing attempt itself has no cancel; its
 *    late settlement is absorbed by the pre-attached catch below, and the residual (a pending socket
 *    that can outlive a FINAL refusal by up to undici's header timeout) is recorded in
 *    `DES-BOOT-IDENTITY-RETRY-IN-PROCESS` -- strictly better than the unbounded hang a mute forge
 *    produced before this module existed.
 *  - The deadline is checked BEFORE sleeping, so no sleep timer can outlive the final attempt (the
 *    issue #300/#325 discipline: a component that stops must have released what it armed). That is
 *    also what makes the injected `sleep` seam safe without a cancel: every sleep awaited here runs
 *    to completion.
 *  - Log lines carry `err?.message` only, never a value -- the `receiver_start_failed` posture.
 *
 * Total wall clock: the helper settles within `windowMs + attemptTimeoutMs`.
 */

// The first gap is what `RestartSec=5` gave, now in-process: a blip recovers exactly as fast as the
// supervisor loop it replaces. It doubles to a cap borrowed from the worker's AUTH_RETRY_COOLDOWN_MS
// rationale (worker/src/start.mjs): short enough to pick the forge up within one gap of it coming
// back, long enough that a ten-minute window opens a couple dozen identity calls, not 120.
export const IDENTITY_RETRY_DELAY_MS = 5_000;
export const IDENTITY_RETRY_DELAY_CAP_MS = 30_000;
// The per-attempt fuse, AUTH_RESOLVE_TIMEOUT_MS's rationale: the resolvers pass no AbortSignal and
// undici's default header timeout is five minutes, so without a fuse a forge that accepts and never
// answers would spend the whole window on one attempt.
export const IDENTITY_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * Retry `resolve` (a nullary async identity resolution) until it answers, throws a tagged
 * (determinate) error, or the window closes. Returns the resolution; rethrows the tagged error
 * same-tick; on exhaustion rethrows the LAST untagged error, so the entry still exits 1 and the
 * supervisor restarts into a fresh window.
 *
 * `now` and `sleep` are seams (CLAUDE.md: a window takes an injected clock, always; issue #284);
 * `setTimeoutFn`/`clearTimeoutFn` are the FUSE's own pair, separately injectable so a test can prove
 * the clearing rather than trust it.
 */
export async function retryIdentity(
	resolve,
	{
		forge,
		windowMs,
		log,
		now = Date.now,
		sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
		setTimeoutFn = setTimeout,
		clearTimeoutFn = clearTimeout,
		attemptTimeoutMs = IDENTITY_ATTEMPT_TIMEOUT_MS,
		delayMs = IDENTITY_RETRY_DELAY_MS,
		delayCapMs = IDENTITY_RETRY_DELAY_CAP_MS,
	} = {},
) {
	const deadline = now() + windowMs;
	let delay = delayMs;
	let attempt = 0;
	for (;;) {
		attempt += 1;
		try {
			let fuse = null;
			try {
				// A SYNCHRONOUS throw from the resolver lands in the outer catch with no fuse armed
				// (`fuse` is still null, and clearTimeout(null) is a no-op), which is why the fuse is
				// armed only after `resolve()` has returned.
				const inflight = resolve();
				// Attached BEFORE the race (the worker's ensureAuth rule): when the fuse wins, the
				// abandoned attempt's late rejection must land in a handler, never as an
				// unhandledRejection. `Promise.resolve` tolerates a resolver that returned a bare value.
				Promise.resolve(inflight).catch(() => {});
				return await Promise.race([
					inflight,
					new Promise((_, reject) => {
						fuse = setTimeoutFn(() => reject(new Error(`${forge} identity did not answer within ${attemptTimeoutMs}ms`)), attemptTimeoutMs);
					}),
				]);
			} finally {
				// The moment the race settles -- win, loss or throw -- the fuse dies. Ref'd and
				// uncleared, it would otherwise hold the loop for the full term (issue #295's lesson,
				// the ref'd twin).
				clearTimeoutFn(fuse);
			}
		} catch (err) {
			// Determinate refusals pass through untouched and unslowed: the tag is the decision, and
			// re-wrapping would cost the entry the piDispatchConfig mapping to EXIT_POLICY.
			if (err?.piDispatchConfig === true) throw err;
			if (now() + delay > deadline) {
				log({ event: "identity_retry_exhausted", forge, attempts: attempt, windowMs, reason: err?.message });
				throw err;
			}
			log({ event: "identity_retry", forge, attempt, reason: err?.message, delayMs: delay });
			await sleep(delay);
			delay = Math.min(delay * 2, delayCapMs);
		}
	}
}
