import { LIVE_OUTCOMES } from "./live-transcript.mjs";
import { sanitizeJobId } from "./run-history.mjs";

/**
 * The forge status comment (issue #644, opt-in `run.statusComment`): one comment on the triggering issue or pull
 * request, posted when the container starts, edited as the run's progress snapshot moves, and edited a last time with
 * the outcome.
 *
 * FIXED WORDS AND INTEGERS ONLY. The progress snapshot carries model text (phase names, the note) and tool names, all
 * forgeable by the agent. A public comment must not carry any of it: a phase name could mention a user or hold a
 * link. So `renderStatusText` reads the snapshot's counters and the LENGTH of `phases`, never a string out of it, and
 * the job id goes through `sanitizeJobId` before it is put between backticks.
 *
 * BEST EFFORT, BOUNDED, NEVER THROWING. `post` and `edit` are the caller's never-throwing wrappers around a forge host
 * (start.mjs). Nothing here throws, nothing blocks the caller (start and update only schedule), and `finish` is bounded
 * by `finalTimeoutMs`: a stuck forge costs a stale comment, never a slower job.
 *
 * EDITS ARE RATIONED. At most one edit per `intervalMs`, only when the rendered text changed, a trailing edit so the
 * latest snapshot lands, and at most `maxEdits` edits a job, the last of which is kept for `finish` so the outcome is
 * always written when the run got that far. A `{ stop }` answer (the wrapper's 403, 404 or 429) ends editing for the
 * rest of the run and leaves the last text in place, with one exception: the FINAL edit. A 429 is the forge asking for
 * a pause, not refusing the edit, and a comment left saying "running" after the run ended is a lie told for good, so
 * the final edit is made after a rate-limit stop, and tried once more after `finalRetryMs` when the forge answers a 429
 * or any other failure (`{ ok: false }`), all inside `finalTimeoutMs`. A 403 or 404 stop still ends it: the comment is
 * gone or the token may not edit it, and asking again changes neither. Logs carry the job id and a reason, never the
 * text.
 *
 * THE OUTCOME COMES FROM THE RECORD. The container's exit code is a weaker reading than the run record's
 * classification (an OOM kill exits 137 and is recorded `policy`; an infrastructure exit is retried under the same job
 * id). `makeStatusCommentRegistry` lets start.mjs make the final edit from the record (`settle`), with the exit's
 * reading only as a bounded fallback for an attempt that leaves no record.
 */

/** A forge comment id this module will hand to a host, and the form `postStatusComment` answers. */
export const STATUS_COMMENT_ID_RE = /^[A-Za-z0-9:_-]{1,200}$/;

/** Whether `id` is a status comment id a host may build a URL from. */
export const isStatusCommentId = (id) => typeof id === "string" && STATUS_COMMENT_ID_RE.test(id);

/** A forge's created-comment id as the string form, or null: a non-negative safe integer, or an already valid string. */
export function commentIdOf(value) {
	if (Number.isSafeInteger(value) && value >= 0) return String(value);
	return isStatusCommentId(value) ? value : null;
}

/** The most characters of the sanitized job id the text carries. */
const JOB_ID_MAX = 128;
/** The final state of an attempt that ended and will run again under the same job id (an infrastructure retry). */
export const STATUS_RETRYING = "retrying";
/** Every final state the text can name: the live outcomes (the record's three among them) and the retry. */
export const STATUS_OUTCOMES = Object.freeze([...LIVE_OUTCOMES, STATUS_RETRYING]);
/**
 * How long after the container ended the registry makes the final edit itself when no record settled it. Five minutes,
 * not seconds: the record is written after the processor's own teardown (the job directory, the egress network, the
 * budget refund), and a slow one used to lose the race to a 30 s fallback, which then wrote the exit's weaker reading
 * as if it were final. The timer is unref'd, so a long one costs nothing.
 */
export const STATUS_FALLBACK_MS = 5 * 60_000;
/**
 * How long a commenter the fallback finished stays reachable for a record that settles after it, and how many such
 * commenters are kept at once (oldest dropped first). A late settle makes one corrective edit when its text differs.
 */
export const STATUS_LATE_SETTLE_MS = 10 * 60_000;
export const STATUS_LATE_SETTLE_MAX = 256;
/** The pause before the final edit's one retry. */
const FINAL_RETRY_MS = 1_000;
/** A stop that asks for a pause rather than refusing the edit: the final edit is still made. */
const isRateLimitStop = (reason) => /^(http-)?429$/.test(String(reason));

/** A non-negative safe integer, or 0. Every number in the text goes through this. */
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The comment body for `snapshot`. Running when `outcome` is undefined or null, "attempt ended, retrying" for
 * `STATUS_RETRYING`, finished otherwise; an outcome outside `LIVE_OUTCOMES` is written as `unknown`. Example:
 * "pi-dispatch job `abc`: running. Turn 7, 12 steps (1 failed). Phase 2 of 4 (3/10)."
 */
export function renderStatusText({ jobId, snapshot, outcome } = {}) {
	const id = sanitizeJobId(jobId).slice(0, JOB_ID_MAX);
	const s = snapshot !== null && typeof snapshot === "object" ? snapshot : {};
	const finished = outcome !== undefined && outcome !== null;
	const state = !finished ? "running" : outcome === STATUS_RETRYING ? "attempt ended, retrying" : `finished: ${LIVE_OUTCOMES.includes(outcome) ? outcome : "unknown"}`;
	const turn = count(s.turn);
	const steps = count(s.steps);
	const failed = count(s.failed);
	const interrupted = count(s.interrupted);
	const extra = [failed > 0 ? `${failed} failed` : null, interrupted > 0 ? `${interrupted} interrupted` : null].filter(Boolean);
	let text = `pi-dispatch job \`${id}\`: ${state}. Turn ${turn}, ${plural(steps, "step")}${extra.length ? ` (${extra.join(", ")})` : ""}.`;
	const phase = s.phase !== null && typeof s.phase === "object" ? s.phase : null;
	if (phase && Number.isSafeInteger(phase.index) && phase.index >= 0) {
		// Only the array's length is read: a phase NAME is model text and never reaches the comment.
		const total = Array.isArray(s.phases) ? s.phases.length : 0;
		text += ` Phase ${phase.index + 1}${total > phase.index ? ` of ${total}` : ""}`;
		const done = Number.isSafeInteger(phase.done) && phase.done >= 0 ? phase.done : null;
		const of = Number.isSafeInteger(phase.total) && phase.total >= 1 ? phase.total : null;
		if (done !== null && of !== null) text += ` (${done}/${of})`;
		else if (done !== null) text += ` (${done} done)`;
		text += ".";
	}
	return text;
}

/**
 * The commenter for one run. `post(text) -> Promise<{id}|null>` and `edit(id, text) -> Promise<{ok:true}|{stop}>` never
 * throw (the caller's wrappers); a given `commentId` (a retry or a recovered run, from the progress key) is edited
 * instead of posting a second comment. `onId(id)` hears a newly posted comment's id so the caller can store it.
 */
export function makeStatusCommenter({
	jobId,
	post,
	edit,
	commentId = null,
	onId = () => {},
	now = Date.now,
	log = () => {},
	intervalMs = 30_000,
	maxEdits = 120,
	finalTimeoutMs = 5_000,
	finalRetryMs = FINAL_RETRY_MS,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
} = {}) {
	let id = isStatusCommentId(commentId) ? commentId : null;
	let started = false;
	let finished = false;
	let stopped = false;
	let stopReason = null;
	let capped = false;
	let edits = 0;
	let lastText = null;
	let lastAt = -Infinity;
	let latest = null;
	let timer = null;
	// Every forge call runs on this chain, one at a time, so edits never overlap and `finish` can wait for the one in
	// flight. Each link swallows its own failure, so the chain never rejects.
	let chain = Promise.resolve();

	const say = (event, fields) => {
		try {
			log(event, { jobId, ...fields });
		} catch {
			// A logger that throws must not reach the job.
		}
	};
	const enqueue = (op) => {
		chain = chain.then(op).catch((err) => say("status_comment_error", { reason: err?.name ?? "error" }));
		return chain;
	};
	const render = (snapshot, outcome) => renderStatusText({ jobId, snapshot, outcome });

	/**
	 * One edit, counted, unless stopped. `final` may spend the edit `update` keeps in reserve, and `extra` (the late
	 * correction) one past `maxEdits`, since the final edit it corrects may have spent the last one. Answers the result.
	 */
	async function doEdit(text, { final = false, extra = 0 } = {}) {
		if ((stopped && !(final && isRateLimitStop(stopReason))) || id === null || text === lastText) return { ok: true };
		const limit = (final ? maxEdits : maxEdits - 1) + extra;
		if (edits >= limit) {
			if (!capped) say("status_comment_capped", { edits });
			capped = true;
			return { ok: true };
		}
		edits += 1;
		lastAt = now();
		const result = await edit(id, text);
		if (result?.stop) {
			if (!stopped || String(result.stop) !== stopReason) say("status_comment_stopped", { reason: String(result.stop) });
			stopped = true;
			stopReason = String(result.stop);
			return result;
		}
		if (result?.ok === true) lastText = text;
		return result ?? { ok: false };
	}

	/** The final edit: once, and once more after a pause when the forge failed it or asked for one (a 429). */
	async function doFinalEdit(text, extra = 0) {
		const first = await doEdit(text, { final: true, extra });
		const again = first?.ok === false || (first?.stop && isRateLimitStop(first.stop));
		if (!again) return;
		await new Promise((resolve) => {
			const t = setTimer(resolve, finalRetryMs);
			t?.unref?.();
		});
		// The retry is not counted against `maxEdits`: the edit it repeats never landed.
		edits = Math.max(0, edits - 1);
		await doEdit(text, { final: true, extra });
	}

	async function doPost(text) {
		lastAt = now();
		const result = await post(text);
		const posted = commentIdOf(result?.id);
		if (posted === null) return;
		id = posted;
		lastText = text;
		try {
			onId(posted);
		} catch {
			// The id is still used for this run's edits; only the caller's record of it is lost.
		}
	}

	function schedule() {
		if (timer !== null || stopped || finished) return;
		const delay = Math.max(0, lastAt + intervalMs - now());
		timer = setTimer(() => {
			timer = null;
			if (finished || latest === null) return;
			const snapshot = latest;
			enqueue(() => doEdit(render(snapshot)));
		}, delay);
	}

	function start(snapshot) {
		try {
			if (started || finished) return;
			started = true;
			latest = snapshot ?? null;
			const text = render(snapshot);
			if (id !== null) enqueue(() => doEdit(text));
			else enqueue(() => doPost(text));
		} catch (err) {
			say("status_comment_error", { reason: err?.name ?? "error" });
		}
	}

	function update(snapshot) {
		try {
			if (!started || finished || stopped || capped) return;
			latest = snapshot ?? null;
			if (render(latest) === lastText) return;
			schedule();
		} catch (err) {
			say("status_comment_error", { reason: err?.name ?? "error" });
		}
	}

	/** Waits for `work`, at most `finalTimeoutMs`. Never throws. */
	async function within(work) {
		let bound = null;
		try {
			await Promise.race([
				work,
				new Promise((resolve) => {
					bound = setTimer(() => {
						say("status_comment_final_timeout", {});
						resolve();
					}, finalTimeoutMs);
				}),
			]);
		} finally {
			if (bound !== null) {
				try {
					clearTimer(bound);
				} catch {
					// Nothing to undo.
				}
			}
		}
	}

	async function finish(snapshot, outcome) {
		try {
			if (finished) return;
			finished = true;
			if (timer !== null) {
				clearTimer(timer);
				timer = null;
			}
			const text = render(snapshot ?? latest, outcome ?? "unknown");
			// A run that never started its comment posts one, with the outcome; one whose post found no id posts
			// nothing more, since the first post may have landed and a second would be a duplicate.
			const fresh = !started && id === null;
			started = true;
			await within(enqueue(() => (fresh ? doPost(text) : doFinalEdit(text))));
		} catch (err) {
			say("status_comment_error", { reason: err?.name ?? "error" });
		}
	}

	/**
	 * One corrective final edit after `finish`, for a record that settled after the fallback wrote the exit's outcome.
	 * Made only when its text differs from what landed (`doEdit` skips an equal text), bounded as `finish`, never throws.
	 */
	async function correct(snapshot, outcome) {
		try {
			if (!finished) return;
			await within(enqueue(() => doFinalEdit(render(snapshot ?? latest, outcome ?? "unknown"), 1)));
		} catch (err) {
			say("status_comment_error", { reason: err?.name ?? "error" });
		}
	}

	// `idle()` settles once every forge call queued so far has (it never rejects): the sink waits on it, bounded, so a post
	// still in flight when the run ends lands its id in the progress key's final write.
	return { start, update, finish, correct, commentId: () => id, idle: () => chain };
}

/**
 * The status commenters of the running jobs, by job id, so the final edit is made from the run record rather than from
 * the exit code (start.mjs). `register(jobId, commenter)` returns the commenter the progress sink drives, with an
 * `ended(snapshot, outcome)` that keeps the final snapshot and arms a fallback; `settle(jobId, outcome)` makes the final
 * edit with the record's outcome (or `STATUS_RETRYING`) and the kept snapshot.
 *
 *   - The fallback: `fallbackMs` (5 minutes) after `ended`, a commenter no record settled (an attempt that ended in a
 *     hold, or a record path that threw) is finished with the exit's outcome, so the comment never says "running" after
 *     the run.
 *   - THE LATE SETTLE. A commenter the fallback finished is kept for `lateMs` (10 minutes, at most `lateMax` of them,
 *     the oldest dropped first), and a `settle` that arrives in that time makes one corrective edit through the
 *     commenter's `correct`, which writes only when the record's text differs from the fallback's. Without it a record
 *     slower than the fallback left the exit's weaker reading (an OOM kill's `unknown` for the record's `policy`) as the
 *     comment's last word.
 *   - Every entry is removed when it is finished, either way, and a new attempt's `register` under the same job id
 *     drops the previous entry (and any late one) WITHOUT a final edit: the new attempt's commenter edits the same
 *     comment from here on.
 *   - `has(jobId)` says whether a `settle` would reach a commenter, so start.mjs can tell a record with nothing
 *     registered (an attempt refused before its container) from one the registry will edit.
 *   - Never throws; `settle` answers the commenter's bounded `finish` (or undefined when there is nothing to settle).
 */
export function makeStatusCommentRegistry({ fallbackMs = STATUS_FALLBACK_MS, lateMs = STATUS_LATE_SETTLE_MS, lateMax = STATUS_LATE_SETTLE_MAX, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
	const entries = new Map();
	// key -> { commenter, snapshot, until }, insertion ordered, so the oldest is the first. Pruned on every use rather than
	// by timers: what it holds is bounded by `lateMax` either way.
	const late = new Map();
	const prune = () => {
		const t = now();
		for (const [key, held] of late) if (!(held.until > t)) late.delete(key);
	};
	const drop = (key, entry) => {
		entry.done = true;
		if (entries.get(key) === entry) entries.delete(key);
		if (entry.timer !== null) {
			try {
				clearTimer(entry.timer);
			} catch {}
			entry.timer = null;
		}
	};
	const close = (key, entry, outcome) => {
		if (entry.done) return undefined;
		drop(key, entry);
		try {
			return Promise.resolve(entry.commenter.finish(entry.snapshot, outcome)).catch(() => {});
		} catch {
			return undefined;
		}
	};
	const keepLate = (key, entry) => {
		if (typeof entry.commenter.correct !== "function") return;
		prune();
		late.delete(key);
		late.set(key, { commenter: entry.commenter, snapshot: entry.snapshot, until: now() + lateMs });
		while (late.size > lateMax) late.delete(late.keys().next().value);
	};
	return {
		register(jobId, commenter) {
			const key = String(jobId);
			const previous = entries.get(key);
			if (previous) drop(key, previous);
			late.delete(key);
			const entry = { commenter, snapshot: null, timer: null, done: false };
			entries.set(key, entry);
			return {
				start: (snapshot) => commenter.start(snapshot),
				update: (snapshot) => commenter.update(snapshot),
				commentId: () => commenter.commentId(),
				idle: () => commenter.idle?.(),
				ended(snapshot, outcome) {
					if (entry.done) return;
					entry.snapshot = snapshot ?? null;
					if (entry.timer !== null) return;
					entry.timer = setTimer(() => {
						entry.timer = null;
						if (entry.done) return;
						void close(key, entry, outcome);
						keepLate(key, entry);
					}, fallbackMs);
					entry.timer?.unref?.();
				},
				// The sink calls `ended`, never this; it is here so the wrapper is still a whole commenter.
				finish: (snapshot, outcome) => {
					if (snapshot) entry.snapshot = snapshot;
					return close(key, entry, outcome);
				},
			};
		},
		settle(jobId, outcome) {
			const key = String(jobId);
			const entry = entries.get(key);
			if (entry) return close(key, entry, outcome);
			prune();
			const held = late.get(key);
			if (!held) return undefined;
			late.delete(key);
			try {
				return Promise.resolve(held.commenter.correct(held.snapshot, outcome)).catch(() => {});
			} catch {
				return undefined;
			}
		},
		has(jobId) {
			const key = String(jobId);
			if (entries.has(key)) return true;
			prune();
			return late.has(key);
		},
		size: () => entries.size,
		lateSize: () => {
			prune();
			return late.size;
		},
	};
}
