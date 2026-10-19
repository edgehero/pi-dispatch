import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeJobId } from "./run-history.mjs";
import { STEER_STDIN_BUDGET_BYTES, steerFileJson, steerFrame } from "./steer-framing.mjs";
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
 * THE SECOND TRANSPORT, STDIN FRAMES (issue #686, INT-STEER-INBOX-CONTRACT). Given `frames` (`{ exitKey, macRunId }`,
 * a stdin-steered attempt on a venue that copies its files), the relay writes each waiting message as a frame on the
 * exec's stdin instead of a file (steer-framing.mjs `steerFrame`), once `attach(stdin, { written })` hands it the pipe
 * the key frame went down. Everything else is the same pass: the same baseline wait, the same order, the same marks
 * (`queued` to `written` BEFORE the write, so a message withdrawn while queued is never written), the same
 * `steer_frame_refused` for an entry it cannot frame. What differs:
 *   - THE BUDGET. The relay counts every byte it wrote, the key frame's included, and a frame that would take the total
 *     past STEER_STDIN_BUDGET_BYTES is NOT written: the message moves to `late`, logged `steer_frame_refused {jobId,
 *     id}`, and is never cut. The venue's exec refuses a stdin past its limit by failing the whole run (measured).
 *   - NO FILE TO UNLINK. A message withdrawn after its frame was written is still handed over by the runner; its
 *     verified ack then moves it to `delivered`, as for the mount's best-effort `written` withdrawal.
 *   - BACKPRESSURE. A write the pipe did not take at once is waited out (`drain`), so the relay never buffers more than
 *     one frame ahead of the pipe; the wait ends early at the stop, a close or an error.
 *   - THE PIPE'S END. The stop closes stdin (`end`), which the runner reads as EOF, no more messages; an attempt that
 *     ended first has closed it already. A write error (EPIPE: the exec gone) is caught on the stream and logged once
 *     as the step `stdin`, never thrown: nothing a dead pipe does may take the worker down.
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
 * `makeInboxRelay({ redis, runId, jobId, inboxDir, targetKey, host, ref, forge, now, log, pollMs, fs, frames })` ->
 * `{ start(), afterBaseline(prior), delivered(id), tick(), stop(), counts(), attach(stdin, { written }) }`.
 * `frames` (issue #686): `{ exitKey, macRunId, budget? }` selects the stdin frame transport (the header); absent, the
 * file transport, byte-identical to before. `macRunId` is the container's PI_JOB_ID, which the runner MACs a frame by.
 */
export function makeInboxRelay({ redis, runId, jobId = runId, inboxDir, targetKey = null, host, ref = null, forge = null, now = Date.now, log = () => {}, pollMs = RELAY_POLL_MS, fs = defaultFs, inbox = inboxModule, frames = null } = {}) {
	const framed = frames !== null && typeof frames === "object" && typeof frames.exitKey === "string" && frames.exitKey !== "" && typeof frames.macRunId === "string" && frames.macRunId !== "";
	const budget = framed && Number.isSafeInteger(frames.budget) && frames.budget > 0 ? frames.budget : STEER_STDIN_BUDGET_BYTES;
	// The frame transport's own state: the pipe, whether it can still take a write, the bytes written (the key frame's
	// included, from `attach`), the next frame's position (the key frame is 1), and the writes waiting on `drain`.
	let sink = null;
	let sinkDead = false;
	let sinkEnded = false;
	let streamBytes = 0;
	let nextSeq = 2;
	const drainWaiters = new Set();
	const logId = jobId === null || jobId === undefined ? null : sanitizeJobId(jobId);
	let timer = null;
	let started = false;
	let stopped = false;
	let baselined = false;
	let rebaseline = null; // the prior ids, until the first tick after the baseline has applied them
	let priorAcked = new Set(); // ids whose prior transcript line carries an ack verified under this attempt's key (F5)
	let closedSaid = false;
	let ready = false; // `start` has reset and registered (L6)
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
		// A frame has no file: what was written is in the pipe, and only the runner's ack says what became of it.
		if (framed) return;
		if (unlinkQuiet(path)) counts.unlinked += 1;
	};

	/** Write one frame's bytes, waiting out backpressure. True when the pipe took them (buffered counts); never rejects. */
	const writeBytes = (bytes) =>
		new Promise((resolve) => {
			if (sink === null || sinkDead || sinkEnded) {
				resolve(false);
				return;
			}
			let more;
			try {
				more = sink.write(bytes);
			} catch (e) {
				sinkDead = true;
				fault("stdin", codeOf(e));
				resolve(false);
				return;
			}
			if (more !== false) {
				resolve(true);
				return;
			}
			// Accepted into the stream's buffer, so `true` whatever ends the wait: the drain, the stop, a close or an error.
			let done = false;
			const settle = () => {
				if (done) return;
				done = true;
				drainWaiters.delete(settle);
				try {
					sink?.off?.("drain", settle);
					sink?.off?.("close", settle);
				} catch {}
				resolve(true);
			};
			drainWaiters.add(settle);
			try {
				sink.once("drain", settle);
				sink.once("close", settle);
			} catch {
				settle();
			}
		});

	/** The frame transport's `place`: one waiting message as a frame on the pipe, under the budget, marked first. */
	const writeFrame = async (entry, state) => {
		if (sink === null || sinkDead || sinkEnded) return; // not attached yet, or the pipe is gone: it stays waiting
		const body = steerFileJson({ entry, ref, forge });
		const frame = body === null ? null : steerFrame({ exitKey: frames.exitKey, runId: frames.macRunId, seq: nextSeq, body });
		if (frame === null || streamBytes + frame.length > budget) {
			// Unframable (a defect or a hand-written entry), or past what the venue's stdin holds: answered as late, never
			// cut and never written as something the person did not send.
			counts.refused += 1;
			log("steer_frame_refused", { jobId: logId, id: entry.id });
			const m = await inbox.markState({ redis, runId, id: entry.id, from: [state], to: "late" });
			if (m?.error) fault("mark-late", codeOf(m));
			return;
		}
		if (state === "queued") {
			const m = await inbox.markState({ redis, runId, id: entry.id, from: ["queued"], to: "written" });
			if (m?.error || m?.ok !== true) {
				// Withdrawn (or otherwise moved) in the meantime: the frame is never written.
				if (m?.error) fault("mark-written", codeOf(m));
				return;
			}
		}
		nextSeq += 1;
		streamBytes += frame.length;
		onDisk.set(entry.id, nextSeq - 1);
		if (!(await writeBytes(frame))) return;
		if (state === "queued") counts.written += 1;
		else counts.rewritten += 1;
	};

	/** Close the pipe once (the runner reads EOF: no more messages), releasing any write waiting on `drain` first. */
	const endSink = () => {
		for (const settle of [...drainWaiters]) settle();
		if (sink === null || sinkEnded) return;
		sinkEnded = true;
		try {
			sink.end();
		} catch (e) {
			fault("stdin", codeOf(e));
		}
	};

	/** Place one waiting message's file. `state` is what the inbox said: `queued` is marked first, `written` re-placed. */
	const place = async (entry, index, state) => {
		if (framed) return writeFrame(entry, state);
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
		// Review round 1, L6: nothing before `start` has reset a closed inbox and registered the run. The stdin transport
		// releases the baseline at the spawn, which can come before `start`'s reset resolves: a pass then would read, and
		// write into, the previous run's closed inbox. `start` runs the pass this skipped once it is ready.
		if (!ready) return;
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
			ready = true;
			timer = setInterval(() => void tick(), pollMs);
			timer.unref?.();
			// A baseline that came first (the stdin transport's, at the spawn) is acted on now rather than a poll later.
			if (baselined) void tick();
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
			// A write waiting on `drain` would hold the pass in flight forever on a pipe nobody reads: released first.
			for (const settle of [...drainWaiters]) settle();
			try {
				await running;
			} catch {}
			endSink();
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
		/**
		 * End the frame transport's pipe now, the relay otherwise running on (its marks and acks still land): the runner's
		 * exit line is out, so nothing more is read from the pipe, and a CLI that waited for EOF before it exits must not
		 * wait on this relay (review round 1, M1). Idempotent; a no-op on the file transport.
		 */
		closeStdin() {
			if (framed) endSink();
		},
		/**
		 * The frame transport's pipe (issue #686): the exec's stdin, after the key frame (`written`, its bytes, counted
		 * against the budget) went down it. Errors on it are caught here for good, so an EPIPE never reaches the process.
		 * A no-op on the file transport or once stopped (then the pipe is closed at once).
		 */
		attach(stdin, { written = 0 } = {}) {
			if (!framed || sink !== null || stdin === null || typeof stdin !== "object" || typeof stdin.write !== "function") return;
			sink = stdin;
			streamBytes = Number.isSafeInteger(written) && written > 0 ? written : 0;
			try {
				stdin.on?.("error", (e) => {
					sinkDead = true;
					fault("stdin", codeOf(e));
					for (const settle of [...drainWaiters]) settle();
				});
				stdin.on?.("close", () => {
					sinkDead = true;
					for (const settle of [...drainWaiters]) settle();
				});
			} catch {}
			if (stopped) {
				endSink();
				return;
			}
			if (baselined) void tick();
		},
	};
}
