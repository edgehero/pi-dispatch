/**
 * The shared triggers-file WRITER (issue #231, DES-ONE-SHOT-DISARM-IN-THE-FILE, OQ-008).
 *
 * Moved here from the admin's read-model so BOTH authors of `triggers.json` serialize through one
 * funnel: the operator's console (dialogs and confirm-gated tools, via the admin's re-export) and the
 * worker's one-shot disarm. "REUSE, NEVER RE-DERIVE" -- the same rule that single-sources the parser
 * and `loadGitHubAuth`. The file format is the admin's own: 2-space JSON plus a trailing newline,
 * byte-for-byte what `writeTriggers` always wrote, and a test pins it.
 *
 * THE LOCK. Until #231 there was exactly one writer (one single-threaded pi process, tools declared
 * sequential), so read-modify-write had nothing to race and `renameSync`'s last-writer-wins was moot.
 * The worker's disarm is a second author -- and at PI_CONCURRENCY up to 3, a third and fourth -- so
 * every write now takes `<path>.lock` via exclusive create (`wx`), the session-store's idiom with its
 * two doctrines kept verbatim: EEXIST is the ONLY failure that means locked (anything else failed to
 * create the lock for its own reason and is reported as that reason), and a leaked lock is logged,
 * never thrown. What is NEW here, with no in-repo precedent, is the STALE TAKEOVER: a lock whose
 * mtime is older than LOCK_STALE_MS is unlinked and retaken once. The session store can afford to
 * discard on contention and let its reaper sweep a leak; this file cannot -- a crashed writer's lock
 * would otherwise wedge every trigger add, edit, delete and disarm on the deployment forever, and
 * there is no reaper whose beat covers it. The residual is the classic one: unlink-then-create is not
 * atomic, so two writers racing a stale takeover can interleave in a window of milliseconds. That
 * window replaces today's always-open one, and the loser's write still validated through the shared
 * parser, so the file stays loadable; the lost update is one disarm or one edit, and the disarm
 * caller retries.
 *
 * Callers split by posture, deliberately:
 *   - `writeTriggers` is SYNC and gives up IMMEDIATELY on contention (`{ invalid }` naming the lock).
 *     Its callers sit on the pi TUI's event loop, where a bounded-retry sleep is a frozen panel; an
 *     operator whose keypress lost the race gets a message and presses the key again.
 *   - `disarmTrigger` is ASYNC and retries with jitter, because ITS caller is the worker's post-run
 *     hook with nobody at the keyboard, and the thing it races (an operator edit, a sibling job's
 *     disarm) clears in milliseconds.
 *
 * `disarmTrigger` is also deliberately NARROWER than `writeTriggers`: it refuses an unreadable file
 * outright rather than repairing from empty. The repair posture is right for the operator CRUD path
 * (a missing file plus "add trigger" should scaffold) and catastrophic here -- overwriting a file the
 * worker could not read, to record one disarm, would destroy the operator's trigger set.
 *
 * Custom: exclusive-create lockfile per session-store.mjs precedent; no proper-lockfile dependency
 * (repo keeps runtime deps minimal, and the two-writer case needs no lease/renewal machinery)
 */

import nodeFs from "node:fs";
import { parseTriggers } from "./triggers.mjs";

/**
 * A lock older than this is a crashed writer's, not a live one's: every write under it is a read,
 * one mutate, one serialize and two syscalls, three orders of magnitude faster. Ten seconds rather
 * than one so a laptop suspending mid-write on battery does not get its live lock stolen on resume.
 */
const LOCK_STALE_MS = 10_000;

/** Bounded contention retry for the disarm path: ~5 attempts x 100-300ms jitter, well under a second of
 * real contention, and the whole wait is smaller than the dedup window that bounds what a lost disarm
 * costs. */
const DISARM_LOCK_ATTEMPTS = 5;

function lockPathFor(triggersPath) {
	return `${triggersPath}.lock`;
}

/**
 * Take the lock, with one stale takeover. Returns an fd, or null when a LIVE writer holds it.
 * Throws only for non-EEXIST failures -- the session-store doctrine: reporting a read-only dir or a
 * full disk as "locked" sends an operator hunting for a stuck lock file that does not exist.
 */
function takeLock(triggersPath, fs, log) {
	const lock = lockPathFor(triggersPath);
	let sweptAgeMs = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = fs.openSync(lock, "wx"); // exclusive create IS the lock; no daemon, no lease
			// Logged only AFTER the retake create succeeded: the unlink alone proves nothing (a rival
			// sweeper may win the recreate race), and a takeover log for a lock we did not get would
			// send an operator reading a history that never happened.
			if (sweptAgeMs !== null) log("triggers_lock_stale_taken", { ageMs: sweptAgeMs });
			return fd;
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;
			let mtimeMs;
			try {
				mtimeMs = fs.statSync(lock).mtimeMs;
			} catch {
				// The holder released between our open and our stat: the next loop iteration takes it.
				continue;
			}
			if (Date.now() - mtimeMs <= LOCK_STALE_MS) return null; // live writer; caller decides
			try {
				fs.unlinkSync(lock);
			} catch {
				// Someone else swept it first; the retry create answers who won.
			}
			sweptAgeMs = Math.round(Date.now() - mtimeMs);
		}
	}
	return null;
}

function releaseLock(fd, triggersPath, fs, log) {
	fs.closeSync(fd);
	try {
		fs.unlinkSync(lockPathFor(triggersPath));
	} catch {
		// A leaked lock delays writers by LOCK_STALE_MS, then the takeover clears it. Logged, never
		// thrown -- the session-store rule.
		log("triggers_lock_stuck", {});
	}
}

/** The one serializer: 2-space plus trailing newline, byte-identical to what the admin always wrote --
 * both live-reload watchers and the operator's own diff read this file, so its shape is a contract. */
function serialize(triggersArray) {
	return `${JSON.stringify({ triggers: triggersArray }, null, 2)}\n`;
}

/** tmp + rename with writeOverlay's single EPERM retry (a Windows AV/indexer briefly holding the
 * destination); a second EPERM, and every other fs failure, propagates to the caller's contract. */
function renameIntoPlace(fs, tmp, dest) {
	try {
		fs.renameSync(tmp, dest);
	} catch (err) {
		if (err?.code !== "EPERM") throw err;
		fs.renameSync(tmp, dest); // single retry: the AV/indexer lock is transient
	}
}

let tmpSeq = 0;

/**
 * A PER-WRITER tmp name, not the fixed `.tmp` the admin writer used to share. With one writer the
 * fixed name was self-cleaning and harmless; with two authors it quietly voided the atomicity claim
 * in the one window the lock concedes (the stale-takeover double-take): two writers sharing one tmp
 * path means B can rename A's half-flushed tmp over the destination, and "a watcher never observes a
 * half-written file" stops being true precisely when it matters. A pid+sequence name gives each
 * write its own inode, so the rename is atomic no matter who else is mid-write. The cost is that a
 * crash between write and rename leaves a uniquely-named straggler instead of one that the next
 * write overwrites -- so both writers unlink their tmp on the failure path.
 */
function tmpPathFor(triggersPath) {
	return `${triggersPath}.${process.pid}.${tmpSeq++}.tmp`;
}

/** Best-effort cleanup of this writer's own tmp after a failed write; the file either renamed away
 * (unlink finds nothing, fine) or must not be left as litter. Never throws over the real failure. */
function discardTmp(fs, tmp) {
	try {
		fs.unlinkSync(tmp);
	} catch {
		// Already renamed, or never written: either way there is nothing to clean.
	}
}

/**
 * Read-modify-write the triggers file under the lock. `mutate` receives the RAW entries (shallow
 * copies) and returns the next raw array; the result is validated through the loaders' own
 * `parseTriggers` -- never write a file they would reject -- and written atomically (tmp + rename) so
 * a live-reload watcher never observes a half-written file.
 *
 * Human-approved writes only on the console path: reached from the operator-typed `/dispatch trigger
 * ...` handlers and from the `dispatch_trigger_*` tools behind `confirmedWrite`'s dialog, so the
 * human keypress is the approval and CONST-TRIGGER-AUTHOR-GATE's principle holds. The worker's disarm
 * does NOT come through here -- `disarmTrigger` below is its own, narrower entry.
 *
 * A missing or unparseable existing file starts from an empty set; the validated write repairs it.
 * Returns `{ ok: true }`, or `{ invalid }` for a validation failure OR a held lock; fs failures throw,
 * the contract this function has always had.
 */
export function writeTriggers({ triggersPath, mutate, fs = nodeFs, log = () => {} }) {
	const fd = takeLock(triggersPath, fs, log);
	if (fd === null) {
		// Immediate, not retried: the callers sit on the pi TUI event loop, and the holder is a write
		// that finishes in milliseconds. The operator re-presses; the file was never touched.
		return { invalid: `triggers file locked (another write in progress): ${lockPathFor(triggersPath)}` };
	}
	try {
		let current = [];
		try {
			const raw = JSON.parse(fs.readFileSync(triggersPath, "utf8"));
			if (Array.isArray(raw?.triggers)) current = raw.triggers;
		} catch {
			// Missing/invalid file: start from empty; the validated atomic write below repairs it.
		}
		const next = mutate(current.map((t) => ({ ...t })));
		const text = serialize(next);
		try {
			parseTriggers(text, triggersPath); // the loaders' own validator -- never write a file they would reject
		} catch (e) {
			return { invalid: e?.message ?? String(e) };
		}
		const tmp = tmpPathFor(triggersPath);
		try {
			fs.writeFileSync(tmp, text, { mode: 0o644 });
			renameIntoPlace(fs, tmp, triggersPath);
		} catch (err) {
			discardTmp(fs, tmp);
			throw err; // the writer's contract: fs failures throw
		}
		return { ok: true };
	} finally {
		releaseLock(fd, triggersPath, fs, log);
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Disarm ONE spent one-shot: add `on.disarmed = { at, jobId }` to the entry at `index`, and nothing
 * else -- the worker's whole write authority over this file is this one added key, which is what lets
 * OQ-008's "the file is the single write target" survive a second author (the worker can disarm what
 * an operator armed; no machine path can ARM anything).
 *
 * The identity check compares EVERY field the job knows about the trigger it matched: `index` is
 * positional and the file can change between enqueue and disarm, so the entry must still be an armed
 * one-shot naming the exact item (`number`) and dispatching the exact `flow` or `command` the job
 * carried. What the check confirms is therefore the matched ITEM and TARGET, not the trigger
 * INSTANCE: an operator who deletes a spent-in-flight one-shot and re-arms an IDENTICAL one (same
 * index, same number, same flow) inside the job's own run window has re-armed something this writer
 * cannot tell from the original, and the earlier job's disarm will spend it. That residual is
 * named rather than closed because a per-trigger id is the thing the design rejects -- the raw index
 * IS the identity (`INT-TRIGGERS-FILE-CONTRACT`) -- and every DIFFERING re-arm (other flow, other
 * number, other shape) refuses loudly here.
 *
 * Returns `{ ok }`, `{ already }` (a sibling replica/redelivery won the race -- idempotent success,
 * not failure), or `{ invalid }` with an operator-actionable reason. NEVER throws, and NEVER repairs:
 * an unreadable file is `{ invalid }` with the bytes untouched.
 */
export async function disarmTrigger({ triggersPath, index, number, flow, command, jobId, at, fs = nodeFs, log = () => {} }) {
	for (let attempt = 0; attempt < DISARM_LOCK_ATTEMPTS; attempt++) {
		let fd;
		try {
			fd = takeLock(triggersPath, fs, log);
		} catch (err) {
			return { invalid: `triggers file lock failed (${err?.code ?? "lock-error"}): ${triggersPath}` };
		}
		if (fd === null) {
			await sleep(100 + Math.floor(Math.random() * 200));
			continue;
		}
		try {
			let raw;
			try {
				raw = JSON.parse(fs.readFileSync(triggersPath, "utf8"));
			} catch (err) {
				// NEVER repair-from-empty here: overwriting a file we could not read, to record one
				// disarm, would destroy the operator's trigger set. writeTriggers' repair posture is for
				// the operator CRUD path, where "missing" means "first trigger".
				return { invalid: `triggers file unreadable (${err?.code ?? "parse-error"}), disarm not written: ${triggersPath}` };
			}
			const entries = Array.isArray(raw?.triggers) ? raw.triggers : null;
			const entry = entries?.[index];
			if (!entry || typeof entry !== "object") {
				return { invalid: `no trigger at index ${index} -- the file changed since this job matched; not disarming a stranger` };
			}
			if (entry.on?.once !== true) {
				return { invalid: `trigger at index ${index} is not an armed one-shot -- the file changed since this job matched; not disarming a stranger` };
			}
			if (entry.on?.number !== number) {
				return { invalid: `trigger at index ${index} names item #${entry.on?.number}, this job matched #${number} -- a re-attributed index refuses rather than disarming a stranger` };
			}
			// Compared only when the caller supplied one, and BOTH lanes checked when it did: a job
			// carries exactly one of flow/command, and the entry must agree on which lane as well as
			// the name -- a flow job must not spend a command one-shot that took the same slot.
			if (flow !== undefined && (entry.run?.flow !== flow || entry.run?.command !== undefined)) {
				return { invalid: `trigger at index ${index} does not dispatch flow ${JSON.stringify(flow)} -- the entry changed since this job matched; not disarming a stranger` };
			}
			if (command !== undefined && (entry.run?.command !== command || entry.run?.flow !== undefined)) {
				return { invalid: `trigger at index ${index} does not dispatch command ${JSON.stringify(command)} -- the entry changed since this job matched; not disarming a stranger` };
			}
			if (entry.on.disarmed !== undefined) {
				return { already: true };
			}
			entry.on.disarmed = { at, ...(jobId !== undefined && { jobId }) };
			const text = serialize(entries);
			try {
				parseTriggers(text, triggersPath); // the shared validator, same rule as every write
			} catch (e) {
				return { invalid: e?.message ?? String(e) };
			}
			const tmp = tmpPathFor(triggersPath);
			try {
				fs.writeFileSync(tmp, text, { mode: 0o644 });
				renameIntoPlace(fs, tmp, triggersPath);
			} catch (err) {
				discardTmp(fs, tmp);
				return { invalid: `triggers file write failed (${err?.code ?? "write-error"}): ${triggersPath}` };
			}
			return { ok: true };
		} finally {
			releaseLock(fd, triggersPath, fs, log);
		}
	}
	return { invalid: `triggers file locked after ${DISARM_LOCK_ATTEMPTS} attempts: ${lockPathFor(triggersPath)}` };
}

/**
 * The pre-spend read (worker slice of #231): what does the FILE currently say about the one-shot at
 * `index`? Fail-open by design -- the caller refuses a job only on POSITIVE disarmed evidence, so
 * "unknown" (unreadable file, index gone, entry no longer a one-shot) means "run": a broken read must
 * never wedge every once job, and the identity mismatch cases are the disarm writer's to refuse.
 */
/**
 * The post-record disarm hook (issue #231): wired around the worker's one recordRun funnel, called
 * strictly AFTER writeRecord returns, for EVERY record -- completed, policy, and per-attempt failed
 * alike, because "fired" means "produced a run record" (the issue's own definition) and the
 * pre-spend check's own-jobId exception is what keeps BullMQ's second attempt of the same delivery
 * runnable. NEVER throws and never rejects: a disarm failure is a loud log line, not a crashed
 * record path.
 *
 * `triggersPath` may be null only when even the cwd fallback could not be formed; the caller
 * resolves `PI_TRIGGERS_FILE ?? join(cwd, "triggers.json")` -- doctor's own precedent, NOT the
 * worker config's `triggersFile` (whose null means "cron disabled" and must keep meaning that;
 * under that knob the DEFAULT single-host deployment would have a firing receiver and a worker
 * that can neither disarm nor pre-spend-check).
 */
export function makeDisarmOnce({ triggersPath, fs = nodeFs, log = () => {}, disarm = disarmTrigger }) {
	return async function disarmOnce({ job, endedAt }) {
		try {
			const matched = job?.data?.trigger?.matched;
			if (matched?.once !== true) return; // every unflagged job takes zero new code paths
			const triggerIndex = matched.index ?? null;
			if (typeof triggersPath !== "string" || triggersPath === "") {
				log("trigger_disarm_unavailable", { jobId: job?.id ?? null, triggerIndex, reason: "triggers file unresolvable" });
				return;
			}
			// The identity the writer re-checks: the item number (the issue shape carries it on matched,
			// the PR shape on the target) and the dispatch lane the job actually carried.
			const number = matched.number ?? job?.data?.target?.number;
			const res = await disarm({
				triggersPath,
				index: matched.index,
				number,
				flow: job?.data?.flow,
				command: job?.data?.command,
				jobId: job?.id,
				at: endedAt,
				fs,
				log,
			});
			if (res.ok) log("trigger_disarmed", { jobId: job?.id ?? null, triggerIndex });
			else if (res.already) log("trigger_already_disarmed", { jobId: job?.id ?? null, triggerIndex });
			else log("trigger_disarm_failed", { jobId: job?.id ?? null, triggerIndex, reason: res.invalid });
		} catch (err) {
			// Unreachable by construction (disarmTrigger never throws), kept because this hook sits on
			// the record path and a record must never be lost to bookkeeping.
			log("trigger_disarm_failed", { jobId: job?.id ?? null, triggerIndex: job?.data?.trigger?.matched?.index ?? null, reason: err?.code ?? "disarm-error" });
		}
	};
}

/**
 * The pre-spend check's factory (issue #231): `(job, { queueJobId }) => { ok } | { refused, at, jobId }`.
 * Refuses ONLY on positive FOREIGN disarmed evidence -- a mark whose jobId is this very queue job
 * means BullMQ's second attempt of the delivery that spent the trigger, which must still run
 * (without the exception, a disarm on attempt one's failure record silently turns attempts:2 into
 * attempts:1 for every once job). A hand-written mark carries no jobId and reads as foreign, which
 * is exactly what an operator disarming by hand intends. Everything else -- unreadable file, index
 * gone, entry changed -- is "run": fail-open, the disarm writer owns the loud refusals, and in the
 * compose topology (single-file :ro bind mount pinned to a dead inode, so the receiver never sees
 * the disarm until restart) this check IS the once-enforcement layer, which is why it exists at all.
 */
export function makeCheckOnceSpent({ triggersPath, fs = nodeFs }) {
	return async function checkOnceSpent(job, { queueJobId } = {}) {
		if (typeof triggersPath !== "string" || triggersPath === "") return { ok: true };
		const matched = job?.trigger?.matched;
		const state = readDisarmState({
			triggersPath,
			index: matched?.index,
			number: matched?.number ?? job?.target?.number,
			flow: job?.flow,
			command: job?.command,
			fs,
		});
		if (state.state !== "disarmed") return { ok: true };
		if (state.jobId !== null && state.jobId === queueJobId) return { ok: true }; // our own earlier attempt
		return { refused: true, at: state.at, jobId: state.jobId };
	};
}

export function readDisarmState({ triggersPath, index, number, flow, command, fs = nodeFs }) {
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(triggersPath, "utf8"));
	} catch (err) {
		return { state: "unknown", reason: err?.code ?? "parse-error" };
	}
	const entry = Array.isArray(raw?.triggers) ? raw.triggers[index] : undefined;
	if (!entry || typeof entry !== "object" || entry.on?.once !== true || entry.on?.number !== number) {
		return { state: "unknown", reason: "entry-changed" };
	}
	// The disarm writer's identity fields, folded to "unknown" rather than refused: a re-armed
	// DIFFERENT one-shot at this index is not spent, so the fail-open answer -- run -- is the true one.
	if (flow !== undefined && (entry.run?.flow !== flow || entry.run?.command !== undefined)) {
		return { state: "unknown", reason: "entry-changed" };
	}
	if (command !== undefined && (entry.run?.command !== command || entry.run?.flow !== undefined)) {
		return { state: "unknown", reason: "entry-changed" };
	}
	if (entry.on.disarmed !== undefined) {
		const d = entry.on.disarmed;
		return { state: "disarmed", at: typeof d?.at === "string" ? d.at : null, jobId: typeof d?.jobId === "string" ? d.jobId : null };
	}
	return { state: "armed" };
}
