/**
 * Issue #1096: a channel the worker serves for as long as it runs, subscribed at boot and tried again until it holds.
 *
 * A worker subscribes to its request channels once, at boot (`history:request:<host>`, `serveHistory`). That subscription
 * could fail (Valkey slow or briefly unreachable while the worker starts, and the subscribe timed out), and boot logged
 * it and never tried again: the worker ran its jobs but answered no read until it restarted, and a console read the host
 * as one that does not answer. ioredis subscribes again by itself after a reconnect, but only to a channel it once
 * subscribed to, so only the FIRST subscription needs this.
 *
 * `start` makes one attempt and resolves to `{ close() }`. Nothing awaits this from boot or from a job: a paid job never
 * waits on a read channel. A failure is said ONCE, by the event the caller names (`unavailable`, no fields, as boot said
 * it before), and the next attempt waits 5 s, then 10, 20, 40 and 60 s, and 60 s from then on, for as long as the worker
 * runs: no attempt limit, since a worker that gave up would be the defect again, and one subscribe a minute costs
 * nothing. When an attempt after a failure holds, ONE line says so (`recovered`), with how many attempts failed and how
 * many seconds passed since the first one, counts only: an attempt's error can carry the Valkey URL and its password, so
 * no error text is ever logged. Never a line per attempt.
 *
 * `close()` (the worker's shutdown, through its closer list) stops the retries, ends a pending wait at once, and closes
 * the service if one held, once. An attempt still pending when it is called closes what it gets when it settles.
 *
 * REJECTED: a fixed interval (a Valkey that is down for an hour gets a subscribe every 5 s from every worker); retrying
 * inside `serveHistory` (it would hold its reader and duplicate connection across the waits, and its caller could not
 * tell the first failure from the recovery); jitter (one subscribe per worker per minute at the cap is not a herd).
 */

export const KEEP_SERVING_FIRST_WAIT_MS = 5_000;
export const KEEP_SERVING_MAX_WAIT_MS = 60_000;

/** The wait before the attempt that follows `failures` failed ones (1 or more): 5 s, doubling, at most 60 s. */
export function keepServingWaitMs(failures) {
	const doublings = Math.min(Math.max(failures - 1, 0), 16);
	return Math.min(KEEP_SERVING_MAX_WAIT_MS, KEEP_SERVING_FIRST_WAIT_MS * 2 ** doublings);
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. Its timer never holds the process open. */
export function abortableSleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);
		const done = (value) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", aborted);
			resolve(value);
		};
		const aborted = () => done(false);
		const timer = setTimeout(() => done(true), ms);
		timer.unref?.();
		signal?.addEventListener("abort", aborted, { once: true });
	});
}

export function keepServing({ start, log, unavailable, recovered, sleep = abortableSleep, now = Date.now }) {
	const stop = new AbortController();
	let service = null;
	let closed = false;
	const shut = async (held) => {
		try { await held.close(); } catch { /* a close that fails at shutdown has nothing left to stop */ }
	};
	(async () => {
		let failures = 0;
		let firstFailedAt = null;
		while (!closed) {
			let held;
			try {
				held = await start();
			} catch {
				failures += 1;
				if (failures === 1) {
					firstFailedAt = now();
					log(unavailable, {});
				}
				if (!(await sleep(keepServingWaitMs(failures), stop.signal))) return;
				continue;
			}
			if (closed) return shut(held);
			service = held;
			if (failures > 0) log(recovered, { failedAttempts: failures, waitedSeconds: Math.max(0, Math.round((now() - firstFailedAt) / 1000)) });
			return;
		}
		// Nothing awaits this loop, so nothing it throws may become an unhandled rejection that ends the worker.
	})().catch(() => {});
	return {
		async close() {
			if (closed) return;
			closed = true;
			stop.abort();
			const held = service;
			service = null;
			if (held) await shut(held);
		},
	};
}
