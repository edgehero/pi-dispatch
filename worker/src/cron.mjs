/**
 * Reconcile the Redis-resident BullMQ job schedulers with the host-side schedule config
 * (DES-CRON-VIA-BULLMQ-SCHEDULER). Given the normalized schedules from schedules.mjs, upsert each one
 * and prune any resident scheduler the config no longer names. Idempotency is BullMQ's: upsert is keyed
 * by schedulerId, so re-running with unchanged config installs the same set and removes nothing.
 *
 * The queue is injected, so this module carries no bullmq import and runs anywhere -- the whole
 * reconcile is exercised in tier-1 tests against a fake queue, with no real Valkey.
 *
 * A `-10` (SchedulerJobIdCollision) or `-11` (SchedulerJobSlotsBusy) from upsertJobScheduler is a
 * sentinel, not a success: swallowing it makes a schedule edit a silent no-op that looks identical to a
 * clean install (design.md:231-232). Whether the SDK throws or returns the sentinel is unconfirmed until
 * it runs against live Valkey, so BOTH the thrown path and the negative-return path are loud failures.
 */

import { configError } from "./config.mjs";
import { cronFingerprint } from "./fingerprint.mjs";
import { authoredCron, loadSchedules, servedSchedules } from "./schedules.mjs";

function sentinelName(code) {
	if (code === -10) return "SchedulerJobIdCollision";
	if (code === -11) return "SchedulerJobSlotsBusy";
	return "unknown scheduler sentinel";
}

/**
 * Install `schedules` (the normalized `{ schedulerId, name, pattern, data, opts }` shape from
 * schedules.mjs) and prune orphans. `queue` supplies `upsertJobScheduler` / `getJobSchedulers` /
 * `removeJobScheduler`; `log(event, fields)` records stable scheduler ids only. Returns
 * `{ installed, removed }`.
 */
export async function reconcile(queue, schedules, { log = () => {} } = {}) {
	for (const { schedulerId, name, pattern, data, opts } of schedules) {
		let res;
		try {
			// No custom jobId: BullMQ mints the deterministic repeat:<schedulerId>:<nextMillis> id itself.
			res = await queue.upsertJobScheduler(schedulerId, { pattern }, { name, data, opts });
		} catch (error) {
			const loud = configError(`scheduler "${schedulerId}": upsertJobScheduler threw: ${error?.message ?? error}`);
			loud.cause = error;
			throw loud;
		}

		if (typeof res === "number" && res < 0) {
			throw configError(
				`scheduler "${schedulerId}": upsertJobScheduler returned ${res} (${sentinelName(res)}); a schedule edit would be a silent no-op`,
			);
		}
	}

	const resident = await queue.getJobSchedulers(0, -1, true);
	const configIds = new Set(schedules.map((s) => s.schedulerId));

	// Custom: trivial set-diff over getJobSchedulers; no package warranted
	const orphanIds = resident
		.map((d) => (typeof d === "string" ? d : (d.key ?? d.id ?? d.name)))
		.filter((rid) => !configIds.has(rid));

	for (const rid of orphanIds) {
		try {
			await queue.removeJobScheduler(rid);
		} catch {
			// A scheduler already gone (a concurrent reconcile pruned it) is the goal state, not an error.
		}
		log("scheduler_removed_orphan", { schedulerId: rid });
	}

	return { installed: schedules.length, removed: orphanIds.length };
}

/**
 * Reconcile, but only when every other LIVE worker agrees about what should be scheduled (issue #57).
 *
 * THE BUG THIS CLOSES. `reconcile` prunes every resident scheduler not named in THIS worker's config, so
 * two workers with different triggers files each delete the other's on every boot and every file-watch
 * reload. Its idempotence only ever held because one worker was the only shape, and nothing checked.
 *
 * WHY AGREEMENT RATHER THAN AN ELECTED OWNER. In the good case agreement is sufficient, and this module's
 * own header says why: upsert is keyed by schedulerId, so when every live host agrees it does not matter
 * which one reconciles or how many do. In the BAD case election is actively worse -- an elected owner
 * reconciles from ITS file, so if that file is the stale one (the operator edited on the other host, or a
 * compose `:ro` single-file mount pinned a dead inode, a topology `makeCheckWaitSkew` already documents)
 * the fleet silently converges on the wrong set and reverts the edit with a log line that reads like
 * success. That is `OQ-008`'s own verdict arriving through a new door. Agreement never picks a winner, so
 * it cannot pick the wrong one, and it needs no lease because it grants no authority: the rule only ever
 * WITHHOLDS a permission relative to today, which is why it cannot be a regression.
 *
 * The honest cost, stated rather than buried: agreement can stalemate and needs an operator, where
 * election resolves automatically and possibly wrongly. For a project whose doctrine is "fail loudly, or
 * fail open and say which", a stalemate that names both hosts is the right trade.
 *
 * PUBLISH BEFORE READ is what makes the legitimate-edit sequence race-free. An operator edits on host A;
 * A's watcher fires, A publishes its new fingerprint, reads peers, sees B still on the old one and
 * refuses. The operator syncs the file to B; B's watcher fires, B publishes, reads, sees A already on the
 * new one, and reconciles for the whole fleet. A never has to run again -- the schedule set is global. The
 * only bad interleaving would be both refusing while both are in fact current, which needs a read to see a
 * stale value, and cannot happen when each side publishes synchronously before it reads.
 *
 * ABSENCE NEVER REFUSES. No peers, or a registry that cannot be read, both PROCEED -- which is today's
 * behaviour, so a Valkey blip can never wedge a single-host deployment.
 *
 * BOTH HALVES ARE REFUSED, not just the prune, and the reason is not symmetry: `upsertJobScheduler` on an
 * existing id is a REDEFINITION, so two hosts disagreeing about one id would flip a schedule between two
 * definitions on every file change with nothing logged.
 *
 * A refusal RETURNS and never throws, so the caller logs it and carries on to `worker_started`: a
 * divergent host must still drain the queue. Taking a host's forge capacity offline over a cron
 * disagreement is the sentence this issue's own acceptance forbids.
 */
export async function reconcileGated(queue, schedules, { registry, log = () => {}, reconcileFn = reconcile, tz, authored = schedules } = {}) {
	// No registry wired is the same answer as a registry that cannot be read: proceed. This is what lets
	// the gate be the DEFAULT on every path without a caller having to remember to arm it.
	if (!registry) return await reconcileFn(queue, schedules, { log });
	// THE FINGERPRINT IS OVER THE AUTHORED SET, NOT THE SERVED SUBSET, and the distinction is the whole
	// reason placement and agreement can coexist. What two hosts must AGREE about is the FILE; what they
	// legitimately DIFFER about is which of its triggers each one can run, because a folder lives on one
	// machine. Hashing the served subset would make every correctly-configured fleet refuse itself forever:
	// mini1 serves /a, mini2 serves /b, their subsets differ, and neither would ever reconcile again.
	const mine = cronFingerprint(authored, { tz });
	// Publishes this host's CURRENT facts rather than passing the fingerprint in. Passing it in was the
	// first shape and it quietly destroyed the mechanism it depends on: the heartbeat installs `fpCron` as
	// a THUNK over the live schedule ref, and a caller merging a computed string replaced that closure, so
	// every later beat republished a frozen value and two hosts could drift apart again with nothing saying
	// so. The thunk is installed once, at boot; this only forces it to be read NOW.
	await registry.publish();
	const peers = await registry.livePeers();

	// `{ unreachable }` and "no peers" are different facts and the panel must keep them apart -- but for
	// THIS decision they resolve the same way, because not knowing whether anyone disagrees is not knowing
	// that someone does, and the rule only withholds a permission.
	const others = peers?.hosts ?? [];
	// An abstaining peer (cron disabled) publishes no fingerprint and is never a disagreeing party.
	const opinions = others.filter((h) => typeof h.fpCron === "string" && h.fpCron !== "");
	const disagreeing = opinions.filter((h) => h.fpCron !== mine);

	// I cannot establish agreement with an opinion I do not have. `mine` is null only when the file could
	// not be read or parsed at THIS instant while `loadSchedules` had just succeeded -- a rename's brief
	// unlink window, in practice. Proceeding would prune a peer's schedulers on the strength of a
	// comparison that never happened, so this refuses; refusing deletes nothing and the next watch event
	// or boot re-decides. It gets its own token because "I could not read my own file" and "we disagree"
	// send an operator to two different places.
	if (mine === null && opinions.length > 0) {
		log("cron_divergence_refused", { mine: null, reason: "own-triggers-unreadable", cronCount: schedules.length, peers: opinions.map((h) => ({ host: h.name, fpCron: h.fpCron, cronCount: Number(h.cronCount) || 0 })) });
		return { refused: "own-triggers-unreadable", peers: opinions.map((h) => h.name) };
	}

	if (disagreeing.length > 0) {
		log("cron_divergence_refused", {
			mine,
			cronCount: schedules.length,
			// The count rides the LINE and never the RULE: it is what lets the message say "host-b reports 4
			// schedules, I have 5", which is the difference between a diagnosable warning and noise.
			peers: disagreeing.map((h) => ({ host: h.name, fpCron: h.fpCron, cronCount: Number(h.cronCount) || 0 })),
		});
		return { refused: "cron-divergence", peers: disagreeing.map((h) => h.name) };
	}

	// Gated on `> 0`, so a single-host deployment emits no new line at all -- the absent-when-unarmed idiom
	// this repo uses for every optional field.
	if (opinions.length > 0) log("cron_agreement", { peers: opinions.length });
	return await reconcileFn(queue, schedules, { log });
}

/**
 * Live-reload the cron schedulers from the (changed) triggers file: re-select the cron subset and reconcile
 * it against the resident schedulers -- an add installs, a delete prunes (reconcile already removes orphans),
 * an edit re-upserts. Idempotent, so a spurious watch event costs one no-op reconcile. A bad edit
 * (`loadSchedules` throws a `configError`) is logged and the RUNNING schedulers are KEPT -- a live worker is
 * never taken down by a malformed trigger file (the OQ-008 live-edit safety). Returns `{ ok }` /
 * `{ invalid }` / `{ failed }`. `loadFn`/`reconcileFn` are injectable so the reload is unit-tested with no fs.
 */
export async function reloadSchedules(config, queue, { log = () => {}, loadFn = loadSchedules, reconcileFn = reconcileGated, ref = null, registry, tz, fleet = false, authoredFn = authoredCron } = {}) {
	let schedules;
	try {
		schedules = loadFn(config, { fleet });
	} catch (error) {
		log("schedules_reload_invalid", { reason: error?.message ?? String(error), kept: true });
		return { invalid: error?.message ?? String(error) };
	}
	// The live REF is updated before the reconcile, not after, and never on the invalid path above: the
	// heartbeat fingerprints what this host currently believes, and believing the boot-time set after an
	// edit is what would make two hosts' fingerprints oscillate on the beat period -- refusing or agreeing
	// depending on which half of a beat a reload landed in.
	if (ref) ref.current = schedules;
	// The same split the boot path makes: a trigger whose folder is another host's is not this host's to
	// install, and the fingerprint is computed over the SERVED set so two hosts owning different folders
	// do not read each other as divergent.
	const { served, unserved } = servedSchedules(schedules);
	for (const s of unserved) log("schedule_unserved", { schedulerId: s.schedulerId, reason: s.unserved });
	try {
		// The FILE, re-read, not `schedules` -- that is `loadSchedules`'s output, which has already replaced
		// every foreign trigger with a stub and therefore differs per host by construction. Passing it here
		// made every live edit on a fleet refuse, permanently, even between hosts running identical files.
		const r = await reconcileFn(queue, served, { log, registry, tz, authored: authoredFn(config) });
		// A refusal is NOT a reload. Wrapping it as `{ ok: true }` would log
		// `schedules_reloaded {installed: undefined}` and tell an operator the edit took effect on a fleet
		// where nothing was installed and nothing pruned -- the silent no-op this project refuses, arriving
		// through the success path.
		if (r?.refused) return r;
		log("schedules_reloaded", { installed: r.installed, removed: r.removed });
		return { ok: true, ...r };
	} catch (error) {
		log("schedules_reload_failed", { reason: error?.message ?? String(error) });
		return { failed: error?.message ?? String(error) };
	}
}
