import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeJobId } from "./run-history.mjs";
import { steerFileJson } from "./steer-framing.mjs";
import * as inboxModule from "./steer-inbox.mjs";

/**
 * The worker's transport into a running job's inbox (issue #646, DES-STEER-VIA-READONLY-INBOX-MOUNT,
 * INT-STEER-INBOX-CONTRACT): opened by run-container.mjs for a steer-ARMED attempt, beside the live transcript tail.
 *
 * WHAT IT DOES, every `pollMs` (the cancel poll's shape: re-entrancy guarded, every fault swallowed and logged by code):
 *   1. refreshes the run's liveness (`refreshLive`: the open key and, for a forge job, its target pointer), which is what
 *      lets a push be accepted at all;
 *   2. writes each `queued` message, in the inbox's order, into the host directory mounted read-only at `/inbox`:
 *      framed (steer-framing.mjs), written to `.<id>.tmp` with mode 0444, marked `written`, then renamed to
 *      `<seq:06d>-<id>.json`. The runner only ever sees complete files under the final pattern;
 *   3. unlinks the file of every message that is no longer waiting (`withdrawn`, `delivered`, `late`).
 * At its stop it HOLDS the liveness keys for STEER_HOLD_TTL_MS rather than dropping them (`holdLive`), so the run still
 * takes messages until its settle closes the inbox or its next attempt registers again.
 *
 * MARK BEFORE RENAME, not after. A `queued` message's withdrawal is promised as GUARANTEED (steer-inbox.mjs), so a file
 * the runner can read must never exist for a message that could still be withdrawn as `queued`. Marking `written` first
 * and renaming only when that compare and set succeeded makes the promise true: a withdraw that wins the race leaves
 * the temporary file, which is removed, and nothing was visible. A rename that fails after the mark leaves a `written`
 * message with no file, which the next tick writes again (a `written` message not on this attempt's disk is placed
 * whatever its history: a retry's directory is new and empty).
 *
 * WRITING WAITS FOR THE BASELINE. `afterBaseline(prior)` is called once the live tail has read the staged transcript
 * to its starting size (steer-ack.mjs `onBaseline`). Until then nothing is written, so a #645-restored transcript's
 * deliveries are known before any file appears. At that moment the relay RE-BASELINES: a message the inbox calls
 * `delivered` whose id is not among the transcript's prior lines goes back to `written`, and is handed over again,
 * because the transcript this attempt starts from never saw it (a checkpoint older than the delivery, or a plain
 * retry whose session starts empty).
 *
 * Never throws; `start` and `stop` resolve whatever Valkey or the disk does. Logs carry the job id, message ids, step
 * names, codes and counts, never a message's text.
 */

export const RELAY_POLL_MS = 2_000;

// The reset of a CLOSED inbox for a new run under the same run id. KEYS: list, state, fallback, closed. One script, so
// it is all or nothing, and it acts only while `closed` exists: while it does every push is refused (`closed`), so no
// message accepted for the new run can be in what it deletes. An open inbox (a #645 recovery, an InfraRetry) is left
// exactly as it is.
const RESET_SCRIPT = `if redis.call('EXISTS', KEYS[4]) == 0 then return 0 end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
return 1`;

/**
 * Reset a closed inbox (review finding F1). A console retry of a failed job keeps its job id, so its run id, and found
 * the previous run's CLOSED inbox: every push answered `closed` for an hour, and the rebaseline moved that run's
 * `delivered` messages back to `written` and handed them to a run that was never sent them. The previous run's outcome
 * is already recorded (the close happens before the record write), so its messages are not needed any more.
 * `{ reset: boolean }` or `{ error }`; never throws.
 */
export async function resetClosedInbox({ redis, runId, inbox = inboxModule } = {}) {
	try {
		const k = inbox.inboxKeys(runId);
		const r = await redis.eval(RESET_SCRIPT, 4, k.list, k.state, k.fallback, k.closed);
		return { reset: Number(r) === 1 };
	} catch (e) {
		return { error: codeOf(e) };
	}
}

const defaultFs = { writeFileSync, renameSync, unlinkSync };
const codeOf = (e) => (typeof e?.code === "string" && e.code !== "" ? e.code : typeof e?.error === "string" ? e.error : "error");

/** The inbox file's name for the entry at list position `index` (0-based): the runner reads them in name order. */
export function inboxFileName(index, id) {
	return `${String(index + 1).padStart(6, "0")}-${id}.json`;
}

/**
 * The target pointer, the framing ref and the forge word for a job (job data as queued): a forge job's target, or none
 * for a local or cron job, which only the operator surfaces can reach. Never throws.
 */
export function steerTargetOf(job, { steerTargetKey = inboxModule.steerTargetKey } = {}) {
	const kind = typeof job?.kind === "string" ? job.kind : null;
	const target = job?.target !== null && typeof job?.target === "object" ? job.target : null;
	if (kind === null || kind === "local" || target === null) return { targetKey: null, ref: null, forge: null };
	const n = typeof target.number === "number" ? target.number : typeof target.number === "string" && /^[1-9][0-9]{0,15}$/.test(target.number) ? Number(target.number) : null;
	const isPr = target.type === "pull_request";
	const targetKey = n !== null && typeof job.repo === "string" ? steerTargetKey({ kind, repo: job.repo, targetType: isPr ? "pull_request" : "issue", number: n }) : null;
	let ref = null;
	if (Number.isSafeInteger(n) && n > 0) {
		if (kind === "gitlab") ref = isPr ? `merge request !${n}` : `issue #${n}`;
		else if (kind === "azure") ref = isPr ? `pull request !${n}` : `work item #${n}`;
		else ref = isPr ? `PR #${n}` : `issue #${n}`;
	}
	return { targetKey, ref, forge: /^[a-z]{1,16}$/.test(kind) ? kind : null };
}

/**
 * `makeInboxRelay({ redis, runId, jobId, inboxDir, targetKey, host, ref, forge, now, log, pollMs, fs })` ->
 * `{ start(), afterBaseline(prior), delivered(id), tick(), stop(), counts() }`.
 */
export function makeInboxRelay({ redis, runId, jobId = runId, inboxDir, targetKey = null, host, ref = null, forge = null, now = Date.now, log = () => {}, pollMs = RELAY_POLL_MS, fs = defaultFs, inbox = inboxModule } = {}) {
	const logId = jobId === null || jobId === undefined ? null : sanitizeJobId(jobId);
	let timer = null;
	let started = false;
	let stopped = false;
	let baselined = false;
	let rebaseline = null; // the prior ids, until the first tick after the baseline has applied them
	let priorAcked = new Set(); // ids whose prior transcript line carries an ack verified under this attempt's key (F5)
	let closedSaid = false;
	let running = null;
	const onDisk = new Map(); // id -> file path this attempt placed and has not unlinked
	const counts = { written: 0, rewritten: 0, unlinked: 0, refused: 0, rebaselined: 0, delivered: 0, faults: 0 };
	const said = new Set();

	const fault = (step, code) => {
		counts.faults += 1;
		const key = `${step}:${code}`;
		if (said.has(key)) return;
		said.add(key);
		log("steer_relay_fault", { jobId: logId, step, code });
	};

	const unlinkQuiet = (path) => {
		try {
			fs.unlinkSync(path);
			return true;
		} catch (e) {
			if (e?.code !== "ENOENT") fault("unlink", codeOf(e));
			return false;
		}
	};

	const unlinkId = (id) => {
		const path = onDisk.get(id);
		if (path === undefined) return;
		onDisk.delete(id);
		if (unlinkQuiet(path)) counts.unlinked += 1;
	};

	/** Place one waiting message's file. `state` is what the inbox said: `queued` is marked first, `written` re-placed. */
	const place = async (entry, index, state) => {
		const body = steerFileJson({ entry, ref, forge });
		if (body === null) {
			// The inbox refuses at push what could not be framed, so this is a defect or a hand-written entry: the
			// message is answered as late (the operator sees it), never written as something the person did not send.
			counts.refused += 1;
			log("steer_frame_refused", { jobId: logId, id: entry.id });
			const m = await inbox.markState({ redis, runId, id: entry.id, from: [state], to: "late" });
			if (m?.error) fault("mark-late", codeOf(m));
			return;
		}
		const tmp = join(inboxDir, `.${entry.id}.tmp`);
		const final = join(inboxDir, inboxFileName(index, entry.id));
		try {
			try {
				fs.unlinkSync(tmp);
			} catch {}
			fs.writeFileSync(tmp, body, { mode: 0o444, flag: "wx" });
		} catch (e) {
			fault("write", codeOf(e));
			return;
		}
		if (state === "queued") {
			const m = await inbox.markState({ redis, runId, id: entry.id, from: ["queued"], to: "written" });
			if (m?.error || m?.ok !== true) {
				// Withdrawn (or otherwise moved) in the meantime: the file never becomes visible.
				unlinkQuiet(tmp);
				if (m?.error) fault("mark-written", codeOf(m));
				return;
			}
		}
		try {
			fs.renameSync(tmp, final);
		} catch (e) {
			unlinkQuiet(tmp);
			fault("rename", codeOf(e));
			return;
		}
		onDisk.set(entry.id, final);
		if (state === "queued") counts.written += 1;
		else counts.rewritten += 1;
	};

	const pass = async () => {
		const r = await inbox.refreshLive({ redis, runId, targetKey, host, now });
		if (r?.error) fault("refresh", codeOf(r));
		if (!baselined || stopped) return;
		const read = await inbox.readInbox({ redis, runId });
		if (read?.error) {
			fault("read", codeOf(read));
			return;
		}
		// A CLOSED inbox is never written into and never re-baselined (F1): its run has ended, and only `start`'s reset may
		// reopen it for a new run. Reached when that reset failed, or when something closed the inbox under a live run.
		if (read.closed === true) {
			if (!closedSaid) {
				closedSaid = true;
				log("steer_inbox_closed", { jobId: logId });
			}
			return;
		}
		const state = { ...read.state };
		if (rebaseline !== null) {
			// A message still waiting whose ack is already in the staged transcript, VERIFIED (F5): it was delivered, the
			// worker just never marked it (a crash between pi writing the line and the mark). Marked, never re-written.
			for (const id of priorAcked) {
				if (state[id] !== "queued" && state[id] !== "written") continue;
				const m = await inbox.markState({ redis, runId, id, from: ["queued", "written"], to: "delivered" });
				if (m?.error) {
					fault("rebaseline", codeOf(m));
					return;
				}
				if (m?.ok === true) {
					state[id] = "delivered";
					counts.delivered += 1;
				}
			}
			const prior = rebaseline;
			for (const [id, st] of Object.entries(state)) {
				if (st !== "delivered" || prior.has(id)) continue;
				const m = await inbox.markState({ redis, runId, id, from: ["delivered"], to: "written" });
				if (m?.error) {
					fault("rebaseline", codeOf(m));
					return; // tried again on the next tick, before anything is written
				}
				if (m?.ok === true) {
					state[id] = "written";
					counts.rebaselined += 1;
				}
			}
			rebaseline = null;
		}
		for (let i = 0; i < read.entries.length; i++) {
			if (stopped) return;
			const entry = read.entries[i];
			const st = state[entry.id];
			if (st === "withdrawn" || st === "delivered" || st === "late") {
				unlinkId(entry.id);
				continue;
			}
			if ((st === "queued" || st === "written") && !onDisk.has(entry.id)) await place(entry, i, st);
		}
	};

	const tick = () => {
		if (running || stopped) return running ?? Promise.resolve();
		running = (async () => {
			try {
				await pass();
			} catch (e) {
				fault("tick", codeOf(e));
			}
		})().finally(() => {
			running = null;
		});
		return running;
	};

	return {
		/** Register the run as live and begin the poll. Idempotent; never rejects. */
		async start() {
			if (started || stopped) return;
			started = true;
			// F1: a closed inbox under this run id belongs to a run that already ended (a console retry keeps the job id).
			// Reset BEFORE registering, so no push can be accepted into the old run's keys.
			const reset = await (typeof inbox.resetClosedInbox === "function" ? inbox.resetClosedInbox : resetClosedInbox)({ redis, runId, inbox });
			if (reset?.error) fault("reset", codeOf(reset));
			else if (reset?.reset === true) log("steer_inbox_reset", { jobId: logId });
			try {
				const r = await inbox.registerLive({ redis, runId, targetKey, host, now });
				if (r?.error) fault("register", codeOf(r));
			} catch (e) {
				fault("register", codeOf(e));
			}
			if (stopped) return;
			timer = setInterval(() => void tick(), pollMs);
			timer.unref?.();
		},
		/** The tail's first pass is done: re-baseline against `prior` (ids in the staged transcript) and start writing. */
		afterBaseline(prior = new Set(), verified = new Set()) {
			if (baselined || stopped) return;
			baselined = true;
			rebaseline = prior instanceof Set ? prior : new Set(prior ?? []);
			priorAcked = verified instanceof Set ? verified : new Set(verified ?? []);
			void tick();
		},
		/** A verified ack (steer-ack.mjs): mark the message delivered and unlink its file. Never rejects. */
		async delivered(id) {
			// `withdrawn` too: a written message is withdrawn best effort, and a verified ack is proof the agent got it.
			const m = await inbox.markState({ redis, runId, id, from: ["written", "queued", "withdrawn"], to: "delivered" });
			if (m?.error) fault("mark-delivered", codeOf(m));
			else if (m?.ok === true) counts.delivered += 1;
			unlinkId(id);
		},
		tick,
		/**
		 * Stop for good: the timer, a pass in flight, then HOLD the liveness keys (review round 1, F3; steer-inbox.mjs
		 * `holdLive`). Not an unregister: until the settle closes the inbox (or the next attempt's relay re-registers the
		 * run), a comment must still land in it rather than fall through to an enqueue the run's semantic window swallows.
		 * What lands after this point is written by the next attempt or settles as `late`. Not a close either.
		 */
		async stop() {
			if (stopped) return { ...counts };
			stopped = true;
			if (timer) clearInterval(timer);
			timer = null;
			try {
				await running;
			} catch {}
			if (started) {
				try {
					const r = await inbox.holdLive({ redis, runId, targetKey, host, now });
					if (r?.error) fault("hold", codeOf(r));
				} catch (e) {
					fault("hold", codeOf(e));
				}
			}
			return { ...counts };
		},
		counts: () => ({ ...counts }),
	};
}
