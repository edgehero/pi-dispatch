import { clip, LIVE_OUTCOMES, LIVE_TOOL_RE, LIVE_TTL_ENDED_MS, LIVE_TTL_LIVE_MS } from "./live-transcript.mjs";
import { escapeControls } from "./projects.mjs";
import { PROGRESS_RECORD_TOOLS, sanitizeJobId } from "./run-history.mjs";

/**
 * Run progress (issue #644, `DES-RUN-PROGRESS`, `INT-RUN-PROGRESS-KEY`): where a running job is, as a small summary
 * the console, the `/dispatch` panel and an opt-in forge status comment read, beside the live transcript (#643).
 *
 * WHERE IT COMES FROM. The same pi session file the live transcript tails (live-transcript.mjs hands every parsed line
 * to `consume`). pi 1.2.0 saves each message at `message_end`: an assistant message is one turn and carries its tool
 * calls (`{type: "toolCall", id, name, arguments}`), and each tool's result is a `toolResult` message with
 * `toolCallId`, `toolName`, `isError` and, when the tool actually ran, `durationMs` (pi-agent-core dist/agent-loop.js
 * `createToolResultMessage`). A call with no result yet is running.
 *
 * WHY `durationMs` AND NEVER TIMESTAMPS. In a parallel batch pi saves every result together once the whole batch is
 * done, so the gap between a call and its result is the batch's time, not the tool's. A result that failed before it
 * ran (an unknown tool, a validation failure) has no `durationMs`, and its duration is null, not a guess.
 *
 * ADVISORY AND FORGEABLE. `/session` is mounted read-write into the job, so the agent can write any line it likes into
 * the file this reads. Progress is display only: it never feeds classification, the budget, the exit outcome, a retry
 * or any other decision, and every field is bounded so a forged file cannot grow it. Model text (a phase name, a note)
 * is redacted and escaped and goes only to the key, where readers show it to operators alone; the record and the forge
 * comment carry integers and closed words only.
 */

/** The key's prefix; the key is this plus the sanitized job id, as `run:live:` is. */
export const PROGRESS_KEY_PREFIX = "run:progress:";
/** One run's progress key. */
export const progressKeyFor = (jobId) => `${PROGRESS_KEY_PREFIX}${sanitizeJobId(jobId)}`;
/** The serialized snapshot's ceiling, in UTF-8 bytes. */
export const PROGRESS_MAX_BYTES = 16 * 1024;
/** Open steps held at once; past it the oldest open step is dropped and counted as an anomaly. */
export const PROGRESS_OPEN_MAX = 256;
/** The ring of the most recent closed steps. */
export const PROGRESS_RECENT_MAX = 20;
/** How many open steps a snapshot lists, newest last. */
export const PROGRESS_RUNNING_MAX = 8;
/** Phase names kept, first-seen order. */
export const PROGRESS_PHASES_MAX = 32;
/** A phase name's and a note's length, in code points, after redaction and escaping. */
export const PROGRESS_PHASE_MAX = 64;
export const PROGRESS_NOTE_MAX = 200;
/** The largest `done` or `total` accepted. */
export const PROGRESS_COUNT_MAX = 1_000_000;
/** A forge status comment's id as the key carries it (an Azure id is `<thread>:<comment>`). */
export const COMMENT_ID_RE = /^[A-Za-z0-9:_-]{1,200}$/;
/** The job tool's name (image/runner/src/report-progress.mjs). */
export const REPORT_PROGRESS_TOOL = "report_progress";
/**
 * The longest tool call id kept, in UTF-16 units. pi's ids are short (a provider's call id, tens of characters), and an
 * id is a Map key held for as long as its step is open: a forged line of just under a megabyte holding one id would
 * otherwise pin that megabyte, and `PROGRESS_OPEN_MAX` of them a quarter of a gigabyte per job. A longer id is an anomaly.
 */
export const PROGRESS_ID_MAX = 128;
/**
 * The longest the key goes unwritten while the attempt has not ended. Each write stamps `updatedAt` with its own time, so
 * a reader can tell a live attempt that is merely quiet (a long tool, a slow model) from a worker that died without its
 * final write, whose key would otherwise read as running for its whole 7-day TTL.
 */
export const PROGRESS_HEARTBEAT_MS = 30_000;

/**
 * The shortest TTL a write that has not ended will set. The live TTL is what is left of 7 days from the writer's start,
 * so it shrinks with every write; once less than this is left the heartbeat stops for good rather than set a key that is
 * gone before a reader can poll it (or, as `Math.max(1, ...)` once did, set it with PX 1 forever).
 */
const LIVE_TTL_FLOOR_MS = 1_000;
/** The least time between two writes of the key. */
const WRITE_INTERVAL_MS = 1_000;
/** Each Valkey call's bound, as the stream's. */
const OP_TIMEOUT_MS = 1_000;
/** The whole of the sink's `finish`: the final write (one bound) and the commenter's final edit, run side by side. */
const SINK_FINISH_TIMEOUT_MS = 5_000;
/** The commenter's own bound on its final edit. */
const COMMENT_FINAL_TIMEOUT_MS = 4_000;
/** How long the sink's `finish` waits for a status comment post still in flight, inside `SINK_FINISH_TIMEOUT_MS`. */
const COMMENT_POST_WAIT_MS = 2_000;

/** A tool call id this module keeps: a non-empty string of at most `PROGRESS_ID_MAX` units. */
const isCallId = (id) => typeof id === "string" && id !== "" && id.length <= PROGRESS_ID_MAX;
/**
 * An assistant message pi never runs the tools of: a provider error or an abort ends the turn before any tool executes
 * (pi-agent-core dist/agent-loop.js returns on `stopReason` "error" or "aborted" ahead of `executeToolCalls`), and the
 * half-streamed tool calls it may carry stay in the saved message. An auto-retry then asks again with new ids.
 */
const runsNoTools = (message) => message.stopReason === "error" || message.stopReason === "aborted";
/**
 * Whether an assistant message is a turn, as the runner counts turns (image/runner/src/turn-budget.mjs): a turn that
 * ended in a provider error is retried, and the runner counts the error and its retry once, so the error is not a turn
 * here. An aborted message is one (the runner counts it, and pi does not retry an abort).
 */
const isTurn = (message) => message.stopReason !== "error";

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

function bounded(promise, ms) {
	let timer;
	return Promise.race([
		Promise.resolve(promise),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error("run progress timeout")), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/** The record's bucket for a tool name: the literal from the closed list it equals, else `other`. Never the input. */
export function recordToolOf(name) {
	for (const tool of PROGRESS_RECORD_TOOLS) if (name === tool) return tool;
	return "other";
}

/**
 * `makeProgress({ jobId, phasesEnabled, redact, now })` returns `{ consume(parsed, ts, flags), reset(), snapshot(),
 * finalSnapshot(outcome), summary(), version(), stats() }`.
 *
 *   - `consume(parsed, ts, { prior, replay })` takes one parsed transcript line and the time the transcript mapping
 *     gave it. `prior` marks a line that ended at or before the resume baseline (the staged file's size when the
 *     tailer started): it seeds `prior: { turns, steps }` and the phase list and current phase, never this attempt's
 *     counters. `replay` marks a line re-read after a reset (below).
 *   - `snapshot()` is the key's value (`INT-RUN-PROGRESS-KEY`) without `commentId`, which the writer adds.
 *   - `finalSnapshot(outcome)` ends the attempt once: every open step becomes `interrupted`, `ended` is true and
 *     `outcome` the `LIVE_OUTCOMES` enum. Nothing is consumed after it.
 *   - `summary()` is the run record's `progress` (integers and closed keys only, zeros left out). `toolMs` is the SUM of
 *     the closed steps' durations, not wall time: a parallel batch of three 60 s tools adds 180 s. `longestStepMs` is
 *     the longest closed step, `longestInterruptedMs` the longest of the steps still open at the end (from the call's
 *     time to the end), which is where a tool hung until the job timeout shows.
 *
 * THE RESET RULE. A reset means the file was rewritten and the tailer reads it again from 0. The counts this attempt
 * already has are kept, and the rewritten file's bytes up to its size at the reset are taken as already seen: a
 * `replay` line counts nothing (no turn, no step, no prior, no anomaly, no phase), with one exception, a result that
 * closes a step still open, since that step is this attempt's and its result only arrived inside the rewrite. Lines
 * after those bytes are counted as usual. A rewrite can therefore lose a step whose call and result were both written
 * and rewritten between two polls; pi rewrites only on a format migration or a branch, neither of which a job does.
 *
 * MEMORY. At most `PROGRESS_OPEN_MAX` open steps (the oldest dropped and counted), a ring of `PROGRESS_RECENT_MAX`
 * closed ones, `PROGRESS_PHASES_MAX` phase names, and as many prior `report_progress` calls as open steps, each keyed by
 * an id of at most `PROGRESS_ID_MAX` units.
 */
export function makeProgress({ jobId: _jobId = null, phasesEnabled = false, redact = (t) => String(t ?? ""), now = () => Date.now() } = {}) {
	const startedAt = now();
	let updatedAt = startedAt;
	let version = 0;
	let turn = 0;
	let steps = 0;
	let failed = 0;
	let interrupted = 0;
	let toolMs = 0;
	let longestStepMs = 0;
	let longestInterruptedMs = 0;
	const tools = Object.create(null);
	const open = new Map(); // id -> { tool, bucket, since, phase }
	const recent = [];
	const phases = [];
	let phase = null;
	let note = null;
	const prior = { turns: 0, steps: 0, seen: false };
	const priorPhaseCalls = new Map(); // id -> validated phase arguments, prior lines only
	let ended = false;
	let outcome = null;
	const counts = { anomalies: 0, evicted: 0, phaseRefused: 0, resets: 0 };

	const touch = () => {
		version += 1;
		updatedAt = now();
	};

	/** The display name: the live stream's charset, and `?` when redaction would change it. */
	const displayTool = (name) => {
		if (typeof name !== "string" || !LIVE_TOOL_RE.test(name)) return "?";
		try {
			return redact(name) === name ? name : "?";
		} catch {
			return "?";
		}
	};

	const pushRecent = (entry) => {
		recent.push(entry);
		while (recent.length > PROGRESS_RECENT_MAX) recent.shift();
	};

	/** Redacted, then escaped, then cut by code points; null when the redactor threw (never the raw text). */
	const modelText = (text, max) => {
		try {
			return clip(escapeControls(String(redact(text))), max).text;
		} catch {
			return null;
		}
	};

	/**
	 * A `report_progress` call's arguments, validated as the runner validates them (a phase of 1 to 64 code points, an
	 * optional `done` from 0 and `total` from 1, both at most `PROGRESS_COUNT_MAX` with `done <= total`, an optional note
	 * of at most 200 code points), then the text made safe. Null for anything else: a forged call is ignored whole.
	 */
	const phaseArgsOf = (args) => {
		if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
		const { phase: name, done, total, note: text } = args;
		if (typeof name !== "string") return null;
		const points = [...name].length;
		if (points < 1 || points > PROGRESS_PHASE_MAX || name.trim() === "") return null;
		if (done !== undefined && !(isCount(done) && done <= PROGRESS_COUNT_MAX)) return null;
		if (total !== undefined && !(isCount(total) && total >= 1 && total <= PROGRESS_COUNT_MAX)) return null;
		if (done !== undefined && total !== undefined && done > total) return null;
		if (text !== undefined && !(typeof text === "string" && [...text].length <= PROGRESS_NOTE_MAX)) return null;
		const safeName = modelText(name, PROGRESS_PHASE_MAX);
		if (safeName === null || safeName === "") return null;
		const safeNote = text === undefined || text === "" ? null : modelText(text, PROGRESS_NOTE_MAX);
		if (text !== undefined && text !== "" && safeNote === null) return null;
		return { name: safeName, done: done ?? null, total: total ?? null, note: safeNote };
	};

	/** Applies one accepted phase report. A new name past the cap leaves the current phase as it was. */
	const applyPhase = (p, withNote) => {
		let index = phases.indexOf(p.name);
		if (index === -1) {
			if (phases.length >= PROGRESS_PHASES_MAX) {
				counts.phaseRefused += 1;
				return;
			}
			phases.push(p.name);
			index = phases.length - 1;
		}
		phase = { index, done: p.done, total: p.total };
		if (withNote) note = p.note;
	};

	const consumePrior = (message) => {
		if (message.role === "assistant") {
			if (isTurn(message)) prior.turns += 1;
			prior.seen = true;
			if (!phasesEnabled || !Array.isArray(message.content) || runsNoTools(message)) return;
			for (const part of message.content) {
				if (part?.type !== "toolCall" || part.name !== REPORT_PROGRESS_TOOL || !isCallId(part.id)) continue;
				const args = phaseArgsOf(part.arguments);
				if (args === null) continue;
				priorPhaseCalls.set(part.id, args);
				while (priorPhaseCalls.size > PROGRESS_OPEN_MAX) priorPhaseCalls.delete(priorPhaseCalls.keys().next().value);
			}
		} else if (message.role === "toolResult") {
			prior.steps += 1;
			prior.seen = true;
			const args = isCallId(message.toolCallId) ? priorPhaseCalls.get(message.toolCallId) : undefined;
			if (args === undefined) return;
			priorPhaseCalls.delete(message.toolCallId);
			if (message.isError === false) applyPhase(args, false);
		}
	};

	const closeStep = (id, message, ts) => {
		const step = open.get(id);
		open.delete(id);
		const isError = message.isError === true;
		const durationMs = isCount(message.durationMs) ? message.durationMs : null;
		steps += 1;
		if (isError) failed += 1;
		if (durationMs !== null) {
			toolMs = Math.min(Number.MAX_SAFE_INTEGER, toolMs + durationMs);
			if (durationMs > longestStepMs) longestStepMs = durationMs;
		}
		tools[step.bucket] = (tools[step.bucket] ?? 0) + 1;
		pushRecent({ tool: step.tool, status: isError ? "error" : "ok", durationMs, at: ts });
		// The runner validated the call: an error result means it refused it, and only `isError: false` is a report.
		if (step.phase && message.isError === false) applyPhase(step.phase, true);
	};

	const snapshot = () => {
		const running = [...open.values()].slice(-PROGRESS_RUNNING_MAX).map((s) => ({ tool: s.tool, since: s.since }));
		return {
			v: 1,
			turn,
			steps,
			failed,
			interrupted,
			running: ended ? [] : running,
			recent: recent.map((r) => ({ ...r })),
			phase: phase ? { ...phase } : null,
			phases: [...phases],
			note,
			prior: prior.seen ? { turns: prior.turns, steps: prior.steps } : null,
			startedAt,
			updatedAt,
			ended,
			outcome,
		};
	};

	return {
		consume(parsed, ts, { prior: isPrior = false, replay = false } = {}) {
			if (ended || parsed?.type !== "message") return;
			const message = parsed.message;
			if (message === null || typeof message !== "object") return;
			const at = isCount(ts) ? ts : now();
			if (isPrior) {
				consumePrior(message);
				touch();
				return;
			}
			if (message.role === "assistant") {
				if (replay) return;
				if (isTurn(message)) turn += 1;
				const content = Array.isArray(message.content) ? message.content : [];
				const dead = runsNoTools(message);
				for (const part of content) {
					if (part?.type !== "toolCall") continue;
					// A call pi will never run opens no step: it would read as running until the end, then as interrupted.
					if (dead || !isCallId(part.id) || open.has(part.id)) {
						counts.anomalies += 1;
						continue;
					}
					const report = phasesEnabled && part.name === REPORT_PROGRESS_TOOL ? phaseArgsOf(part.arguments) : null;
					if (phasesEnabled && part.name === REPORT_PROGRESS_TOOL && report === null) counts.phaseRefused += 1;
					open.set(part.id, { tool: displayTool(part.name), bucket: recordToolOf(part.name), since: at, phase: report });
					if (open.size > PROGRESS_OPEN_MAX) {
						open.delete(open.keys().next().value);
						counts.evicted += 1;
						counts.anomalies += 1;
					}
				}
				touch();
			} else if (message.role === "toolResult") {
				const id = message.toolCallId;
				if (!isCallId(id) || !open.has(id)) {
					// Unknown, or a duplicate of a result already closed (a closed id is no longer open).
					if (!replay) counts.anomalies += 1;
					return;
				}
				closeStep(id, message, at);
				touch();
			}
		},
		reset() {
			counts.resets += 1;
		},
		snapshot,
		finalSnapshot(result) {
			if (!ended) {
				// Every step still open is interrupted: the container is gone and its result will never come. #645's
				// synthetic interrupted results are not specified yet, so until then such a result counts as an ordinary one.
				const at = now();
				for (const step of open.values()) {
					interrupted += 1;
					pushRecent({ tool: step.tool, status: "interrupted", durationMs: null, at });
					// How long it had been running when the attempt ended: a hung tool killed by the job timeout is
					// often the longest step of all, and `longestStepMs` (closed steps only) cannot see it.
					const ran = Math.trunc(at - step.since);
					if (Number.isSafeInteger(ran) && ran > longestInterruptedMs) longestInterruptedMs = ran;
				}
				open.clear();
				ended = true;
				outcome = LIVE_OUTCOMES.includes(result) ? result : "unknown";
				touch();
			}
			return snapshot();
		},
		summary(_outcome) {
			const out = {};
			const put = (key, v) => {
				if (isCount(v) && v > 0) out[key] = v;
			};
			put("turns", turn);
			put("steps", steps);
			put("failed", failed);
			put("interrupted", interrupted);
			put("toolMs", toolMs);
			put("longestStepMs", longestStepMs);
			put("longestInterruptedMs", longestInterruptedMs);
			put("phasesDeclared", phases.length);
			if (phases.length > 0 && phase !== null) out.lastPhaseIndex = phase.index;
			const counted = {};
			for (const tool of [...PROGRESS_RECORD_TOOLS, "other"]) if (tools[tool] > 0) counted[tool] = tools[tool];
			if (Object.keys(counted).length > 0) out.tools = counted;
			return out;
		},
		version: () => version,
		stats: () => ({ open: open.size, recent: recent.length, phases: phases.length, ...counts }),
	};
}

/**
 * The snapshot as the key holds it: serialized, and cut until it fits `maxBytes` by dropping `recent` oldest first, then
 * `phases` from the tail, then the note. A `phase.index` past a cut list stays as it was: readers bound it themselves.
 */
export function serializeProgress(snapshot, maxBytes = PROGRESS_MAX_BYTES) {
	const s = { ...snapshot, recent: [...(snapshot.recent ?? [])], phases: [...(snapshot.phases ?? [])] };
	let json = JSON.stringify(s);
	while (Buffer.byteLength(json) > maxBytes) {
		if (s.recent.length > 0) s.recent.shift();
		else if (s.phases.length > 0) s.phases.pop();
		else if (s.note !== null && s.note !== undefined) s.note = null;
		else break;
		json = JSON.stringify(s);
	}
	return json;
}

/**
 * The progress key as it stands, for a reader with no writer of its own: `{ commentId, snapshot }` (a `commentId` that is
 * not a valid comment id reads as null), or null when the key is absent, unreadable or Valkey does not answer within
 * `timeoutMs`. Never throws. start.mjs reads it to make the final status edit for an attempt that registered no
 * commenter (one refused before its container), whose comment an earlier attempt posted.
 */
export async function readProgressKey({ redis, jobId, timeoutMs = OP_TIMEOUT_MS } = {}) {
	if (!redis || typeof redis.get !== "function" || (typeof redis.status === "string" && redis.status !== "ready")) return null;
	try {
		const raw = await bounded(redis.get(progressKeyFor(jobId)), timeoutMs);
		const old = typeof raw === "string" ? JSON.parse(raw) : null;
		if (old === null || typeof old !== "object" || Array.isArray(old)) return null;
		return { commentId: typeof old.commentId === "string" && COMMENT_ID_RE.test(old.commentId) ? old.commentId : null, snapshot: old };
	} catch {
		return null;
	}
}

/**
 * `makeProgressWriter({ redis, jobId, now, timeoutMs, intervalMs, log, setTimer, clearTimer, onWrite })` returns
 * `{ init(), update(snapshotOrFn), setCommentId(id), commentId(), final(snapshot), stats() }`. Writes the key
 * (`SET key json PX ttl`), best effort, bounded and never throwing, at most once per `intervalMs` with a trailing write
 * for the latest state, and one final write with the ended TTL. Once `final` has settled nothing is written again.
 *
 *   - `init()` reads the key an earlier attempt of this job left and keeps its `commentId` (a retry, or a run #645
 *     recovers, edits the comment the first attempt posted rather than posting a second one). Every write waits for it,
 *     so the first write of an attempt replaces the old key only after its comment id was taken. Memoized.
 *   - The TTL is 7 days from this attempt's first successful write (each write sets what is left of it, so a write never
 *     extends it), and 24 hours from the final write. Seven days from the writer's start, every write but the final one
 *     stops for good, the heartbeat with them (`run_progress_expired`), so no write ever sets a TTL under a second.
 *   - `onWrite(snapshot)` is called with what each write before the final one carried (the commenter's feed), whether
 *     or not Valkey took it.
 *   - `updatedAt` is the time of the write that carried it, not of the last change: until `final`, the snapshot is
 *     written again at least every `heartbeatMs` even when nothing moved, so a key whose `updatedAt` is old and whose
 *     `ended` is false belongs to a worker that stopped writing (a crash, a kill), not to a quiet run.
 */
export function makeProgressWriter({ redis, jobId, now = () => Date.now(), timeoutMs = OP_TIMEOUT_MS, intervalMs = WRITE_INTERVAL_MS, heartbeatMs = PROGRESS_HEARTBEAT_MS, maxBytes = PROGRESS_MAX_BYTES, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, onWrite = () => {} } = {}) {
	const key = progressKeyFor(jobId);
	const id = sanitizeJobId(jobId);
	let commentId = null;
	let initDone = null;
	let source = null;
	let dirty = false;
	let timer = null;
	let heartbeat = null;
	let inFlight = null;
	let lastWriteAt = null;
	let firstWriteAt = null;
	let closed = false;
	let finalizing = null;
	let warned = false;
	const counts = { writes: 0, failed: 0 };
	// The heartbeat's hard end: 7 days from this writer's start. The finish normally ends it long before (a job's own
	// timeout is 30 minutes), but a finish that never comes (a path that loses the publisher) must not leave a timer
	// rewriting the key for as long as the worker lives. Taken at the start, not at the first successful write, so a
	// Valkey that refuses every write bounds the beating too; it is never later than the TTL's own start.
	const deadline = now() + LIVE_TTL_LIVE_MS;

	const ready = () => !redis || typeof redis.status !== "string" || redis.status === "ready";

	const init = () => {
		if (initDone) return initDone;
		initDone = (async () => {
			if (!redis || !ready()) return null;
			// Unreadable or unreachable reads as null: this attempt posts its own comment.
			const old = await readProgressKey({ redis, jobId, timeoutMs });
			if (commentId === null && old?.commentId) commentId = old.commentId;
			return commentId;
		})();
		return initDone;
	};

	const fail = () => {
		counts.failed += 1;
		if (!warned) {
			warned = true;
			log("run_progress_write_failed", { jobId: id });
		}
	};

	/** Stops every write but the final one, for good: the heartbeat outlived the key's 7-day window. */
	const expire = () => {
		if (closed) return;
		closed = true;
		if (timer) clearTimer(timer);
		timer = null;
		if (heartbeat) clearTimer(heartbeat);
		heartbeat = null;
		log("run_progress_expired", { jobId: id });
	};

	const write = async (snapshot, ended) => {
		await init();
		if (closed && !ended) return;
		const at = now();
		if (!ended && deadline - at < LIVE_TTL_FLOOR_MS) return expire();
		const value = { ...snapshot, updatedAt: at, commentId };
		// The final write is not fed on: the commenter gets the final snapshot from its own `finish`.
		if (!ended) {
			try {
				onWrite(value);
			} catch {}
		}
		if (!redis) return;
		try {
			if (!ready()) throw new Error("run progress client not ready");
			// Never below the floor: `firstWriteAt` is no earlier than `deadline`'s start, so what is left of the TTL is
			// at least what is left before the deadline, which the check above held at the floor or more.
			const ttl = ended ? LIVE_TTL_ENDED_MS : Math.max(LIVE_TTL_FLOOR_MS, (firstWriteAt ?? at) + LIVE_TTL_LIVE_MS - at);
			const reply = await bounded(redis.set(key, serializeProgress(value, maxBytes), "PX", ttl), timeoutMs);
			if (reply !== "OK") throw new Error("run progress write refused");
			if (firstWriteAt === null) firstWriteAt = at;
			counts.writes += 1;
		} catch {
			fail();
		}
	};

	const run = () => {
		timer = null;
		if (closed || !dirty || inFlight) return;
		dirty = false;
		lastWriteAt = now();
		const snapshot = source();
		inFlight = write(snapshot, false).finally(() => {
			inFlight = null;
			if (dirty) schedule();
			else beat();
		});
	};

	/** The next heartbeat, re-armed after every write: the same snapshot again, with a fresh `updatedAt`. */
	const beat = () => {
		if (closed || source === null) return;
		if (deadline - now() < LIVE_TTL_FLOOR_MS) return expire();
		if (heartbeat) clearTimer(heartbeat);
		heartbeat = setTimer(() => {
			heartbeat = null;
			if (closed) return;
			dirty = true;
			schedule();
		}, heartbeatMs);
		heartbeat?.unref?.();
	};

	const schedule = () => {
		if (closed || timer || inFlight) return;
		const wait = lastWriteAt === null ? 0 : Math.max(0, lastWriteAt + intervalMs - now());
		if (wait === 0) return run();
		timer = setTimer(run, wait);
		timer?.unref?.();
	};

	return {
		init,
		update(snapshot) {
			if (closed) return;
			source = typeof snapshot === "function" ? snapshot : () => snapshot;
			dirty = true;
			schedule();
		},
		setCommentId(value) {
			if (closed || typeof value !== "string" || !COMMENT_ID_RE.test(value) || value === commentId) return;
			commentId = value;
			if (source) {
				dirty = true;
				schedule();
			}
		},
		commentId: () => commentId,
		/** The final write, ended TTL. Bounded, never throwing; idempotent. */
		final(snapshot) {
			if (finalizing) return finalizing;
			if (timer) clearTimer(timer);
			timer = null;
			if (heartbeat) clearTimer(heartbeat);
			heartbeat = null;
			closed = true;
			finalizing = bounded(
				(async () => {
					try {
						await inFlight;
					} catch {}
					await write(snapshot, true);
				})(),
				timeoutMs * 2,
			).catch(() => fail());
			return finalizing;
		},
		stats: () => ({ closed, dirty, ...counts }),
	};
}

/**
 * The progress side of one attempt, as the live transcript's opener wires it: the reducer, the key writer and, when
 * given, the forge status commenter. `makeProgressSink({ redis, jobId, phasesEnabled, redact, now, log, makeCommenter,
 * writer })` returns `{ consume, reset, start(), finish(outcome), summary(), snapshot(), stats() }`.
 *
 *   - `makeCommenter({ jobId, commentId, onId })` returns a status-comment.mjs commenter or null (start.mjs builds it
 *     only for a forge job whose trigger set `run.statusComment`). It is created at `start`, after the writer read the
 *     earlier attempt's comment id, and fed each snapshot the writer writes (at most once a second; it throttles its
 *     own edits). The first write, at `start`, is the empty snapshot (turn 0), so a retry's attempt replaces the key
 *     the previous attempt ended with at once rather than at its first transcript line.
 *   - `finish(outcome)` ends the reducer, hands the final snapshot and the exit's outcome to the commenter's
 *     `ended(snapshot, outcome)`, waits (at most `COMMENT_POST_WAIT_MS`) for a comment post still in flight so its id
 *     rides the final write, then makes the final write; all of it bounded by `SINK_FINISH_TIMEOUT_MS`. Never throws;
 *     idempotent.
 *
 * THE SINK DOES NOT WRITE THE COMMENT'S OUTCOME. The exit code is all it knows, and the record's classification can
 * differ from it (an OOM kill is `unknown` here and `policy` in the record, an infrastructure exit is retried). So the
 * commenter's owner (start.mjs) makes the final edit from the record and uses the outcome handed to `ended` only as a
 * fallback. A commenter with no `ended` has no such owner, and the sink finishes it with the exit's outcome itself.
 * The id wait exists because the key is closed after the final write: an id that arrived later was lost, and a retry
 * that read no id posted a second comment.
 */
export function makeProgressSink({ redis, jobId, phasesEnabled = false, redact, now = () => Date.now(), log = () => {}, makeCommenter = null, writer: writerOpts = {}, finishTimeoutMs = SINK_FINISH_TIMEOUT_MS } = {}) {
	const progress = makeProgress({ jobId, phasesEnabled, redact, now });
	let commenter = null;
	const writer = makeProgressWriter({
		redis,
		jobId,
		now,
		log,
		...writerOpts,
		onWrite: (snapshot) => {
			try {
				commenter?.update(snapshot);
			} catch {}
		},
	});
	let started = null;
	let finishing = null;
	let seen = progress.version();
	const changed = () => {
		const v = progress.version();
		if (v === seen) return;
		seen = v;
		writer.update(() => progress.snapshot());
	};
	return {
		consume(parsed, ts, flags) {
			try {
				progress.consume(parsed, ts, flags);
				changed();
			} catch {}
		},
		reset() {
			progress.reset();
		},
		start() {
			if (started || finishing) return started;
			started = (async () => {
				const commentId = await writer.init();
				if (typeof makeCommenter === "function") {
					try {
						commenter = makeCommenter({ jobId, commentId, onId: (value) => writer.setCommentId(value), finalTimeoutMs: COMMENT_FINAL_TIMEOUT_MS }) ?? null;
						commenter?.start({ ...progress.snapshot(), commentId });
					} catch {
						commenter = null;
					}
				}
				writer.update(() => progress.snapshot());
			})().catch(() => {});
			return started;
		},
		finish(outcome) {
			if (finishing) return finishing;
			finishing = bounded(
				(async () => {
					try {
						await started;
					} catch {}
					const snapshot = progress.finalSnapshot(outcome);
					const enumOutcome = snapshot.outcome;
					const owned = typeof commenter?.ended === "function";
					if (owned) {
						try {
							commenter.ended(snapshot, enumOutcome);
						} catch {}
					}
					if (commenter) {
						let wait;
						await Promise.race([
							Promise.resolve()
								.then(() => commenter.idle?.())
								.catch(() => {}),
							new Promise((resolve) => {
								wait = setTimeout(resolve, COMMENT_POST_WAIT_MS);
							}),
						]).finally(() => clearTimeout(wait));
						try {
							writer.setCommentId(commenter.commentId?.());
						} catch {}
					}
					await Promise.allSettled([writer.final(snapshot), owned ? null : Promise.resolve().then(() => commenter?.finish({ ...snapshot, commentId: writer.commentId() }, enumOutcome))]);
				})(),
				finishTimeoutMs,
			).catch(() => {});
			return finishing;
		},
		summary: () => progress.summary(),
		snapshot: () => progress.snapshot(),
		stats: () => ({ ...progress.stats(), writer: writer.stats() }),
	};
}
