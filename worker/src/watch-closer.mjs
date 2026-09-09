/**
 * The stop handle every live-edit directory watch hands back. Its own IMPORT-FREE module (issue #301),
 * because BOTH composition roots register one: `startWorker` in the `extraClosers` list that already
 * closes the queues and the host registry (`index.mjs` -> shutdown), and the receiver in the `closers`
 * array its own shutdown drains. `transient.mjs` is the precedent: one rule, exported to the receiver
 * through the package's exports map, never copied into it. The two roots' `log` shapes differ -- the
 * worker's takes `(event, fields)`, the receiver's one object -- so the receiver hands this factory an
 * adapter at its call site rather than this module growing a second signature.
 *
 * A WATCH NOTHING CAN CLOSE IS NOT A DETAIL (issue #295). `watch(dir, cb).unref?.()` retained nothing, so
 * the watch outlived the worker that armed it, and the reload it later fired ran through THAT boot's
 * `log` closure: that boot's injected `write`, stamped with that boot's `workerName`. One process running
 * one worker, that is a rounding error at exit. One process running forty boots, which is what a test file
 * is, and a worker that shut down two tests ago writes into a live worker's capture under a host that is
 * not running -- `every log line carries the host` went red in CI reading `runnervmejwal` where it
 * asserted `mac-mini-1`.
 *
 * UNREF'D IS NOT CLEANED UP, and that difference is what hid this across three features. `unref` says only
 * that a handle will not hold the event loop open; the watch stays armed either way.
 * `INT-HOST-REGISTRY-CONTRACT` states the same distinction from the opposite side, where a bound's timer
 * is deliberately NOT unref'd because an unref'd timer does not fire when the hung command is the last
 * thing holding the loop.
 *
 * Three properties, each one a way the shutdown breaks without it:
 *
 * - It CLOSES the FSWatcher, which is the leak itself.
 * - It CANCELS the debounce the watcher already armed. Closing a watcher does not cancel a `setTimeout`
 *   the callback already set, and only the watcher was ever unref'd -- the 150ms timer never was. In a
 *   real worker that costs nothing, because the shutdown ends in `process.exit(0)` either way; it is the
 *   harness, where the loop is left to drain on its own, that the stray timer reaches.
 * - Its `close()` NEVER THROWS for the handles its three callers build, and is idempotent -- by NULLING
 *   what it closed rather than by an early return, which would be a guard with nothing behind it. Node's
 *   own `FSWatcher.close()` is already both (measured: a second close returns early and neither throws),
 *   but this closer must not
 *   INHERIT that guarantee, it must MAKE it: the shutdown loop in `index.mjs` cannot catch a SYNCHRONOUS
 *   throw from a closer, and the comment there carries the argument. The swallow is
 *   `makeHostRegistry.close`'s posture rather than a new one.
 *
 * A watch that was never created -- the `catch` arm of each function below, a platform without `fs.watch`
 * -- still gets a closer, so registration is unconditional and the list's shape never depends on the
 * platform. That is why all three return from OUTSIDE their try/catch.
 *
 * WHAT IT CANNOT DO, because the list above would otherwise read as complete: cancel a reload that has
 * ALREADY started. `reloadSchedules` is async and awaits a Valkey round trip, so a debounce that fired
 * just before the close is still running after it -- and the watchers stay armed for the whole drain
 * ahead of the closer loop, not merely 150ms. That reload cannot be recalled, so what is gated instead is
 * its VOICE: `reloadLog` below goes quiet once `closed` is set, and every reload is handed that instead
 * of the boot's own `log`, which is what the
 * issue actually asks for -- a stopped worker writes no line. The reload's own Valkey work may still be
 * cut off mid-flight by the queue closing beside it, leaving a scheduler set the next boot's reconcile
 * repairs; that race predates this change and is not narrowed by it.
 *
 * EXPORTED for the reason `reloadScopedLimits` is: none of the three properties is observable through a
 * real `fs.watch` without racing the filesystem, and a guarantee the shutdown rests on deserves a
 * deterministic pin rather than a sleep.
 */
export function makeWatchCloser(handles, log) {
	return {
		// The reload's voice, and the reason this factory is handed the boot's `log` rather than only its
		// handles. A reload already in flight cannot be recalled, so what the close gates is what it can
		// still SAY: after `closed`, a line from this watch would carry the host of a worker that has
		// stopped, which is the bleed the issue is about. The arming lines keep the real `log` -- they run
		// before any close.
		reloadLog: (event, fields) => {
			if (!handles.closed) log(event, fields);
		},
		close() {
			// `closed` FIRST, before anything is torn down: it is what gates `reloadLog` above and the watch
			// callback below, so a callback or a reload landing mid-close is already silenced.
			handles.closed = true;
			clearTimeout(handles.timer);
			handles.timer = null;
			try {
				handles.watcher?.close();
			} catch {
				// A close that failed has already stopped mattering, and a THROW here rejects the shutdown.
			}
			handles.watcher = null;
		},
	};
}
