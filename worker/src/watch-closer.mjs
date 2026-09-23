/**
 * The stop handle every live-edit directory watch hands back. Its own IMPORT-FREE module (issue #301),
 * because BOTH composition roots register one: `startWorker` in the `extraClosers` list that already
 * closes the queues and the host registry (`index.mjs` -> shutdown), and the receiver in the `closers`
 * array its own shutdown drains. `transient.mjs` set the shape (one import-free rule module in
 * `worker/src`, never copied into the receiver) but reaches the receiver indirectly, re-exported by the
 * identity modules; this one rides the exports map itself as `./watch-closer`, because its consumer is
 * the receiver's composition root and no re-exporting module sits between. The two roots' `log` shapes differ -- the
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

/**
 * The debounce every live-edit watch in this project uses, in one place (issue #386).
 *
 * The literal 150 was written four times -- the receiver's triggers watch and the worker's triggers,
 * pause-windows and scoped-limits watches -- and four copies of a number is the shape `CLAUDE.md` warns
 * about: they agree until one of them does not. It rides this module because this module is already what
 * both composition roots import for the same four watches.
 *
 * WHY A DEBOUNCE AT ALL, since the number alone does not say: an atomic tmp+rename delivers more than one
 * directory event for one edit, and the panel's own writer renames. The window only has to outlast that
 * burst, which is why it is small enough that an operator never notices it.
 */
export const WATCH_DEBOUNCE_MS = 150;

/**
 * Close the BOOT RACE that every one of those four watches had (issue #386).
 *
 * Each service reads its file once at boot and arms the watch afterwards. Nothing re-reads in between, so
 * an edit landing in that gap is never loaded: it waits for the NEXT edit, or for a restart. The gap is not
 * instantaneous -- in the receiver the watch is deliberately the last fallible step of the boot, behind
 * identity resolution, which retries for up to `RECEIVER_IDENTITY_RETRY_SECONDS`.
 *
 * ON MACOS THE GAP EXTENDS PAST `watch()` RETURNING, which is what makes this a lost edit rather than a
 * late one. libuv answers `fs.watch` from `uv__fsevents_init`, which queues the path and signals its
 * CoreFoundation thread; that thread destroys the process's single FSEvents stream and creates a new one
 * covering every watched path, starting from "now" (libuv 1.49.2, the version Node 23.5 bundles). An edit
 * that lands before the new stream is live is not delivered late, it is not delivered at all. Measured
 * against the real receiver boot, ISSUE #386's own measurement: 24 of 40 trials lost the edit with four
 * boots in one process, 1 of 40 with one boot beside a loaded machine, 0 of 40 idle. A re-measure on
 * another machine reproduced the SHAPE and not the rate (1 of 40, 0 of 40, 0 of 40), so read the 24 as one
 * host's worst case rather than a constant; the loss itself is real on both. Linux's inotify registers
 * before `fs.watch` returns, so there an edit can be late but not lost.
 *
 * The answer is one read AFTER arming, compared against what the boot read, and a reload only when they
 * differ -- so a quiet boot stays quiet and costs one stat-and-read per watch.
 *
 * WHAT IT DOES NOT CLOSE, because a helper that reads as complete is worse than one that states its edge.
 * The FSEvents window above extends past this read too, so an edit landing between this read and the moment
 * the stream goes live is still lost: this closes the boot-load-to-arming window and does not make the
 * other zero, and closing that one needs a watch that reports when it is live, which `fs.watch` does not
 * offer. And a file DELETED and recreated between the two reads is not seen, because an unreadable read on
 * either side is treated as no change -- right for a file that went away, since every reload path keeps
 * last-good, and wrong for one that arrived. All three loaders refuse a configured-but-missing file at
 * boot, so reaching that means deleting and recreating inside the window.
 */
export function readBeforeArming(handles, read, atBoot = undefined) {
	// `atBoot` is what the BOOT LOADER read, and it is the only baseline that measures the right window. A
	// baseline read here instead measures the microseconds around the arming: the first version of this
	// helper did exactly that and closed 0.1 to 0.4 milliseconds while the window the race lives in -- boot
	// load to arming, which in the receiver holds identity resolution and its retries -- stayed open, proven
	// end to end on both services. `undefined` means the caller has no boot read to hand over and accepts
	// the narrower window; every caller in this project hands one over.
	handles.armedWith = atBoot === undefined ? safeRead(read) : typeof atBoot === "string" ? atBoot : null;
}

/** True when the file changed between `readBeforeArming` and now, and there is a watch to have missed it. */
export function changedWhileArming(handles, read) {
	// No watcher means the arming THREW, and the service logged that it is running without a live reload.
	// Re-reading there would paper over that with one lucky read.
	if (!handles.watcher) return false;
	const now = safeRead(read);
	// An unreadable file on either side is not a change: the reload paths all keep last-good on a bad read,
	// and firing one here would only replace a good in-memory value with the same keep-last-good outcome.
	return now !== null && handles.armedWith !== null && now !== handles.armedWith;
}

function safeRead(read) {
	try {
		const v = read();
		return typeof v === "string" ? v : null;
	} catch {
		return null; // a file that is absent or unreadable at boot is the loaders' business, not this one's
	}
}
