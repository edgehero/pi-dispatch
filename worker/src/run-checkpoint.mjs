import { constants as FS } from "node:fs";
import * as nodeFsp from "node:fs/promises";
import { basename } from "node:path";
import { sanitizeJobId } from "./run-history.mjs";

/**
 * Durable runs, the live half (issue #645): WHEN to take a workspace checkpoint of a running job, and the
 * Valkey pointer that tells a recovery where the latest one is. `workspace-checkpoint.mjs` knows HOW to
 * snapshot a paused workspace into the per-run store; this module decides when, freezes the container around
 * it, and publishes the result.
 *
 * WHY QUIET POINTS. A checkpoint is a workspace plus the transcript prefix that produced it. Taken mid tool
 * call, the transcript ends on a call whose effects are half in the tree, and the recovery has to guess
 * (`piDispatchRecovery: "interrupted"`). Taken where every tool call of the last assistant message has its
 * result (or the assistant asked for none), the tree and the transcript agree, and a recovery replays
 * nothing. So only those points TRIGGER a live checkpoint; the offset itself is still read while the
 * container is frozen (below), because the tailer may lag the file by a poll.
 *
 * WHY THE OFFSET IS READ WHILE PAUSED, FROM THE FILE. The tailer's last line end is up to a poll behind: pi
 * may have appended a tool result whose effect is already in the tree. The freezer stops every writer, so the
 * end of the last complete line read during the pause is exactly the transcript that matches the frozen tree;
 * a partial last line (pi mid write when frozen) is left out, never cut into.
 *
 * NEVER THROWS, NEVER HOLDS THE JOB. `consume` is called from the live tailer's per-line callback and
 * returns at once; the checkpoint runs beside it. Every failure is counted, backed off and, after
 * `maxFailures` in a row, the attempt stops taking live checkpoints (`checkpoint_degraded`): a checkpoint is
 * optional, a paid container frozen again and again for one that keeps failing is not.
 *
 * THE PAUSE IS ALWAYS BALANCED. `unpause` runs in a `finally` after every pause that took (and, without
 * escalation, after one whose answer was a timeout, since that freeze may still land). An unpause that fails
 * `UNPAUSE_TRIES` times leaves a container that will never run again while the worker waits on it for the
 * whole job timeout, so the handle says `{ stop: true }` and calls `onStop`: runContainer stops the container
 * and the run ends as an infrastructure exit, which the processor recovers from the checkpoint just taken.
 *
 * THE POINTER FOLLOWS THE COMMIT, NEVER LEADS IT. It is written only after `snapshot` answered `ok` (its
 * CURRENT renamed into place), so a reader that finds a pointer finds a checkpoint behind it. A pointer write
 * that fails leaves the previous pointer (or none): stale, never ahead.
 */

/** The pointer key's prefix; the key is this plus the sanitized RUN id (`recoveryOf ?? job.id`), never a job id. */
export const CHECKPOINT_POINTER_PREFIX = "run:checkpoint:";
/** The pointer's lifetime, rewritten on every committed checkpoint: the store's own TTL (DEFAULT_CHECKPOINT_LIMITS.ttlMs). */
export const CHECKPOINT_POINTER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Snapshots this host runs at once, live and exit together. Each walks a tree and streams a fast-import. */
export const HOST_SNAPSHOT_CONCURRENCY = 2;
/** How often an unpause is asked before the container is given up on. */
export const UNPAUSE_TRIES = 3;
export const DEFAULT_RUN_CHECKPOINT_LIMITS = Object.freeze({ minIntervalMs: 60_000, pauseMaxMs: 15_000, maxFailures: 3 });

/** How far back from the end the paused offset read looks for a newline before it falls back to the tailer's. */
const OFFSET_SCAN_MAX_BYTES = 8 * 1024 * 1024;
const OFFSET_SCAN_CHUNK = 64 * 1024;
/** Each pointer call's bound: the BullMQ connection queues a command against an unreachable server forever. */
const POINTER_TIMEOUT_MS = 1_000;
/** The longest backoff, as a multiple of `minIntervalMs`. */
const BACKOFF_MAX_FACTOR = 16;
/** A `stale-seq` answer is retried with a growing jump, at most this often within one checkpoint. */
const SEQ_TRIES = 8;

const HOST_RE = /^[A-Za-z0-9._-]{1,64}$/;
const QUEUE_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,199}$/;
/** A job directory's basename as `mkdtemp(join(jobsDir, "job-"))` mints it. Never a path. */
const JOB_DIR_RE = /^job-[A-Za-z0-9_-]{1,64}$/;
const POINTER_KEYS = ["v", "host", "hostQueue", "seq", "attempt", "at", "jobDir"];

/**
 * A pause answer that will never change for this container: live checkpoints are turned off at once rather
 * than three times backed off. `cgroup-v1-rootless` is podman's gate (backend-podman.mjs); `not-pausable` is
 * the registry's answer for a venue that carries no verbs.
 */
const PERMANENT_PAUSE = new Set(["cgroup-v1-rootless", "not-pausable", "invalid-name"]);
/** A snapshot answer that no later try in this attempt can change: the store was never primed, or never can be. */
const PERMANENT_SNAPSHOT = new Set(["not-primed", "base-too-large", "bad-args", "store-unreadable"]);

const isInt = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;

/** One run's pointer key. */
export const checkpointPointerKey = (runId) => `${CHECKPOINT_POINTER_PREFIX}${sanitizeJobId(runId)}`;

/** The host token as workspace-checkpoint.mjs normalises it, so a pointer and a manifest name a host the same way. */
export function normalizeHost(hostName) {
	const s = String(hostName ?? "");
	return HOST_RE.test(s) ? s : s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "unknown";
}

/**
 * The pointer, validated: a plain object with EXACTLY the pointer's keys, every value typed and every string a
 * host token, a queue name or a job directory basename. Null otherwise. It is read by another host's worker
 * and decides where a recovery is queued and which directory a salvage looks at, so nothing loose rides along.
 */
export function validPointer(p) {
	if (!p || typeof p !== "object" || Array.isArray(p)) return null;
	const keys = Object.keys(p).sort();
	if (keys.length !== POINTER_KEYS.length || ![...POINTER_KEYS].sort().every((k, i) => k === keys[i])) return null;
	if (p.v !== 1) return null;
	if (typeof p.host !== "string" || !HOST_RE.test(p.host)) return null;
	if (p.hostQueue !== null && (typeof p.hostQueue !== "string" || !QUEUE_RE.test(p.hostQueue))) return null;
	if (!isInt(p.seq, 1, 999_999_999) || !isInt(p.attempt, 0, 10_000) || !isInt(p.at)) return null;
	if (typeof p.jobDir !== "string" || !JOB_DIR_RE.test(p.jobDir)) return null;
	return { v: 1, host: p.host, hostQueue: p.hostQueue, seq: p.seq, attempt: p.attempt, at: p.at, jobDir: p.jobDir };
}

function bounded(promise, ms) {
	let timer;
	return Promise.race([
		Promise.resolve(promise),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error("checkpoint pointer timeout")), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/** The run's pointer, shape-validated, or null (none, unreadable, malformed, or Valkey did not answer). Never throws. */
export async function readCheckpointPointer({ redis, runId, timeoutMs = POINTER_TIMEOUT_MS } = {}) {
	if (!redis || runId === null || runId === undefined || runId === "") return null;
	try {
		const raw = await bounded(redis.get(checkpointPointerKey(runId)), timeoutMs);
		if (typeof raw !== "string" || raw.length > 4096) return null;
		return validPointer(JSON.parse(raw));
	} catch {
		return null;
	}
}

/** Remove the run's pointer at its final outcome. True when the delete was answered. Never throws. */
export async function removeCheckpointPointer({ redis, runId, timeoutMs = POINTER_TIMEOUT_MS } = {}) {
	if (!redis || runId === null || runId === undefined || runId === "") return false;
	try {
		await bounded(redis.del(checkpointPointerKey(runId)), timeoutMs);
		return true;
	} catch {
		return false;
	}
}

/** Write a validated pointer with its TTL. True when Valkey answered OK. Never throws; refuses an invalid pointer. */
export async function writeCheckpointPointer({ redis, runId, pointer, timeoutMs = POINTER_TIMEOUT_MS, ttlMs = CHECKPOINT_POINTER_TTL_MS } = {}) {
	const valid = validPointer(pointer);
	if (!redis || !valid || runId === null || runId === undefined || runId === "") return false;
	try {
		const reply = await bounded(redis.set(checkpointPointerKey(runId), JSON.stringify(valid), "PX", ttlMs), timeoutMs);
		return reply === "OK";
	} catch {
		return false;
	}
}

/**
 * A counting semaphore. `tryAcquire()` returns a release function or null; `acquire()` waits for one. A
 * release is idempotent, so a `finally` that runs twice cannot free a slot it does not hold.
 *
 * A LIVE checkpoint only ever TRIES: waiting for a slot would pause the container later, at a moment that is
 * no longer the quiet point that asked for it. The exit checkpoint waits, since its container is already dead.
 */
export function makeSemaphore(limit = HOST_SNAPSHOT_CONCURRENCY) {
	let active = 0;
	const waiters = [];
	const grant = () => {
		active += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			active -= 1;
			const next = waiters.shift();
			if (next) next(grant());
		};
	};
	return {
		get active() {
			return active;
		},
		tryAcquire: () => (active < limit ? grant() : null),
		acquire: () => (active < limit ? Promise.resolve(grant()) : new Promise((resolve) => waiters.push(resolve))),
	};
}

/**
 * Quiet-point detection over pi session entries (the pinned pi's `message` lines: an assistant message
 * carries its `toolCall` parts with ids, each `toolResult` names the `toolCallId` it answers). `take(parsed)`
 * is true when THIS line completes a quiet point: an assistant message with no tool calls, or the tool
 * result that answers the last outstanding call of the latest assistant message. Every other entry type
 * (compaction, model change, custom) leaves the state as it was.
 */
export function makeQuietTracker() {
	let pending = new Set();
	let synthetic = 0;
	return {
		take(parsed) {
			if (parsed?.type !== "message") return false;
			const message = parsed.message ?? {};
			if (message.role === "assistant") {
				const content = Array.isArray(message.content) ? message.content : [];
				pending = new Set();
				for (const part of content) {
					if (part?.type !== "toolCall") continue;
					// A call without an id can never be answered by id, so it holds the point closed until the next
					// assistant message: a missed checkpoint, never a checkpoint taken mid call.
					pending.add(typeof part.id === "string" && part.id !== "" ? part.id : `\0${(synthetic += 1)}`);
				}
				return pending.size === 0;
			}
			if (message.role === "toolResult") {
				if (pending.size === 0 || !pending.delete(message.toolCallId)) return false;
				return pending.size === 0;
			}
			return false;
		},
		reset() {
			pending = new Set();
		},
		get pending() {
			return pending.size;
		},
	};
}

/**
 * The end of the last COMPLETE line of `file` (the byte just past its last newline), read now. Null when it
 * cannot be read or no newline is within `maxScanBytes` of the end. The file is the agent's (`/session` is
 * mounted read-write), so it is opened `O_NOFOLLOW | O_NONBLOCK` and must be a regular file, as the tailer's.
 */
export async function lastCompleteLineEnd(file, { fs = nodeFsp, maxScanBytes = OFFSET_SCAN_MAX_BYTES } = {}) {
	if (typeof file !== "string" || file === "") return null;
	let fh = null;
	try {
		fh = await fs.open(file, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
		const st = await fh.stat();
		if (!st.isFile()) return null;
		let pos = st.size;
		let scanned = 0;
		while (pos > 0 && scanned < maxScanBytes) {
			const len = Math.min(OFFSET_SCAN_CHUNK, pos, maxScanBytes - scanned);
			const buf = Buffer.alloc(len);
			const { bytesRead } = await fh.read(buf, 0, len, pos - len);
			if (bytesRead !== len) return null;
			const nl = buf.lastIndexOf(0x0a);
			if (nl !== -1) return pos - len + nl + 1;
			pos -= len;
			scanned += len;
		}
		return pos === 0 ? 0 : null;
	} catch {
		return null;
	} finally {
		await fh?.close().catch(() => {});
	}
}

/** One pause verb call, bounded whatever the verb does, as `{ ok, reason? }`. Never rejects. */
async function verbCall(fn, name, ms) {
	let timer;
	try {
		return await Promise.race([
			Promise.resolve().then(() => fn(name)),
			new Promise((resolve) => {
				timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), ms);
			}),
		]).then((r) => (r?.ok === true ? { ok: true } : { ok: false, reason: typeof r?.reason === "string" ? r.reason : "failed" }));
	} catch {
		return { ok: false, reason: "threw" };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * `makeRunCheckpointer({ checkpointer, redis, hostName, hostQueue, now, log, limits, semaphore, fs, sleep })`
 * returns `{ open(args) }`. One per worker process: its semaphore is the host-wide bound.
 *
 * `open({ runId, attempt, jobDir, workspace, sessionFile, containerName, pause, unpause, baseSha, branch,
 * secretValues, meta, onStop })` returns a handle:
 *   - `consume(parsed, ts, endOffset, { prior, replay })`: one transcript line, fed by the live tailer. Tracks
 *     quiet points and, at one that is due, starts a live checkpoint beside the job. Returns at once, never
 *     throws. A `prior` or `replay` line (an earlier attempt's, re-read) updates the state and triggers nothing.
 *   - `reset()`: the transcript was rewritten; the quiet state starts over.
 *   - `exit({ kind })`: a checkpoint of the dead container (kind `exit`, or `salvage` for a stale job dir),
 *     no pause. `{ seq }` or `{ skipped: reason }`. Idempotent. Waits for a live one in flight first.
 *   - `close()`: no further live checkpoint; awaits the one in flight. `{ written, failed, skipped, lastSeq }`.
 *   - `stats()`: the same counts, now.
 *   - `pending()`: the live checkpoint in flight (a promise of its outcome) or null. For tests.
 *
 * A venue that cannot pause (`pause`/`unpause` not functions) gets no live checkpoints; `exit` still works.
 */
export function makeRunCheckpointer({
	checkpointer,
	forkStore = null,
	redis = null,
	hostName = "unknown",
	hostQueue = null,
	now = () => Date.now(),
	log = () => {},
	limits = {},
	semaphore = makeSemaphore(HOST_SNAPSHOT_CONCURRENCY),
	fs = nodeFsp,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	unpauseRetryMs = 1_000,
	pointerTimeoutMs = POINTER_TIMEOUT_MS,
} = {}) {
	const L = { ...DEFAULT_RUN_CHECKPOINT_LIMITS, ...limits };
	const host = normalizeHost(hostName);
	const queue = typeof hostQueue === "string" && QUEUE_RE.test(hostQueue) ? hostQueue : null;

	function open({ runId, attempt = 0, jobDir = null, workspace = null, sessionFile = null, containerName = null, pause = null, unpause = null, baseSha = null, branch = null, secretValues = [], meta = {}, onStop = null } = {}) {
		const id = sanitizeJobId(runId);
		const tracker = makeQuietTracker();
		const counts = { written: 0, failed: 0, skipped: 0 };
		let lastSeq = null;
		let lastEnd = null; // the tailer's last complete line end: the fallback offset when the paused read fails
		let closed = false;
		let stopped = false;
		let degraded = false;
		let consecutive = 0;
		let inflight = null;
		let exiting = null;
		let closing = null;
		// The first live checkpoint is due one interval after open: a run that ends inside a minute needs none, and
		// its exit checkpoint (if it crashes) covers it.
		let nextAt = now() + L.minIntervalMs;
		const jobDirName = typeof jobDir === "string" && jobDir !== "" ? basename(jobDir) : null;

		let liveOff = null;
		if (typeof pause !== "function" || typeof unpause !== "function") liveOff = "not-pausable";
		else if (typeof containerName !== "string" || containerName === "") liveOff = "no-container";
		else if (typeof sessionFile !== "string" || sessionFile === "") liveOff = "no-transcript";
		else if (typeof workspace !== "string" || workspace === "" || typeof baseSha !== "string") liveOff = "no-workspace";
		else if (!checkpointer || typeof checkpointer.snapshot !== "function") liveOff = "no-store";
		if (liveOff) log("checkpoint_live_off", { runId: id, reason: liveOff });
		const turnLiveOff = (reason) => {
			if (liveOff) return;
			liveOff = reason;
			log("checkpoint_live_off", { runId: id, reason });
		};

		// The next seq, once per attempt and BEFORE any pause: the store refuses a seq at or below its CURRENT, and a
		// recovery attempt continues the run's numbering, so it starts past both the manifest and the pointer.
		let seqReady = null;
		let nextSeq = 1;
		const initSeq = () =>
			(seqReady ??= (async () => {
				let base = 0;
				try {
					const m = await checkpointer?.readManifest?.(runId);
					if (m?.ok && isInt(m.manifest?.seq, 1)) base = m.manifest.seq;
				} catch {}
				const p = await readCheckpointPointer({ redis, runId, timeoutMs: pointerTimeoutMs });
				if (p && p.seq > base) base = p.seq;
				nextSeq = base + 1;
			})());

		/** `checkpointer.snapshot` with the seq, past a `stale-seq` answer by a growing jump. Never throws. */
		const snapshotAt = async ({ kind, quiesced, offset }) => {
			let result = { skipped: "stale-seq" };
			for (let i = 0; i < SEQ_TRIES; i++) {
				const seq = nextSeq;
				try {
					result = await checkpointer.snapshot({ runId, workspace, baseSha, seq, branch, secretValues, attempt, kind, quiesced, transcript: { srcFile: sessionFile, offset }, meta });
				} catch {
					result = { skipped: "internal-error" };
				}
				if (result?.skipped !== "stale-seq") break;
				nextSeq = seq + 2 ** i;
			}
			if (result?.ok && isInt(result.seq, 1)) {
				nextSeq = result.seq + 1;
				// Still frozen (or dead): taking this copy after thaw would bind old text to newer files.
				// The archive has its own short deadline and point cap; a miss never invalidates recovery.
				if (forkStore?.capturePoint) {
					try {
						const saved = await forkStore.capturePoint({ runId, workspace, baseSha, branch, secretValues, attempt, kind, quiesced, transcriptPath: sessionFile, offset, meta });
						if (!saved?.ok) log("fork_checkpoint_skipped", { runId: id, reason: saved?.refused ?? saved?.skipped ?? "unavailable" });
					} catch { log("fork_checkpoint_skipped", { runId: id, reason: "unavailable" }); }
				}
			}
			return result ?? { skipped: "internal-error" };
		};

		/** The pointer for a committed checkpoint, AFTER the commit. A failure is logged and leaves the old one. */
		const publish = async (result) => {
			const pointer = { v: 1, host: typeof result.manifest?.host === "string" ? result.manifest.host : host, hostQueue: queue, seq: result.seq, attempt, at: Math.floor(now()), jobDir: jobDirName };
			if (!redis) return false;
			const ok = await writeCheckpointPointer({ redis, runId, pointer, timeoutMs: pointerTimeoutMs });
			if (!ok) log("checkpoint_pointer_failed", { runId: id, seq: result.seq, reason: validPointer(pointer) ? "write" : "invalid" });
			return ok;
		};

		const offsetNow = async () => {
			const read = await lastCompleteLineEnd(sessionFile, { fs });
			return read ?? (isInt(lastEnd) ? lastEnd : 0);
		};

		const noteFailure = () => {
			consecutive += 1;
			nextAt = now() + L.minIntervalMs * Math.min(2 ** consecutive, BACKOFF_MAX_FACTOR);
			if (consecutive >= L.maxFailures && !degraded) {
				degraded = true;
				log("checkpoint_degraded", { runId: id, failures: consecutive });
			}
		};

		/** Unpause, asked up to UNPAUSE_TRIES times. True when one took. */
		const thaw = async () => {
			for (let i = 0; i < UNPAUSE_TRIES; i++) {
				const r = await verbCall(unpause, containerName, L.pauseMaxMs);
				if (r.ok) return true;
				log("checkpoint_unpause_retry", { runId: id, try: i + 1, reason: r.reason });
				if (i + 1 < UNPAUSE_TRIES) await sleep(unpauseRetryMs).catch(() => {});
			}
			return false;
		};

		const runLive = async (release) => {
			let paused = false;
			let ambiguous = false;
			let thawed = true;
			let result = null;
			let frozenMs = 0;
			try {
				await initSeq();
				if (closed) return { skipped: "closed" };
				const p = await verbCall(pause, containerName, L.pauseMaxMs);
				if (!p.ok) {
					ambiguous = p.reason === "timeout";
					if (PERMANENT_PAUSE.has(p.reason)) {
						counts.skipped += 1;
						turnLiveOff(p.reason);
						return { skipped: p.reason };
					}
					counts.failed += 1;
					log("checkpoint_pause_failed", { runId: id, reason: p.reason });
					noteFailure();
					return { failed: "pause" };
				}
				paused = true;
				const frozenAt = now();
				// Read while frozen: no writer can extend the file between this read and the snapshot's copy of it.
				const offset = await offsetNow();
				result = await snapshotAt({ kind: "live", quiesced: "frozen", offset });
				frozenMs = now() - frozenAt;
			} catch {
				result = { skipped: "internal-error" };
			} finally {
				if (paused) thawed = await thaw();
				else if (ambiguous) {
					// The freeze may land after its verb timed out. Thawed without escalation: an unpause of a container
					// that never froze fails too, and that must not stop a healthy job.
					await verbCall(unpause, containerName, L.pauseMaxMs);
				}
				release();
			}
			const out = {};
			if (!thawed) {
				stopped = true;
				log("checkpoint_unpause_failed", { runId: id, tries: UNPAUSE_TRIES });
				out.stop = true;
			}
			if (result?.ok) {
				counts.written += 1;
				lastSeq = result.seq;
				consecutive = 0;
				out.seq = result.seq;
				await publish(result);
				if (frozenMs > L.pauseMaxMs) {
					// Committed, but the job stood frozen past its bound: backed off like a failure, so a tree that is
					// slow to walk is not frozen this long every minute.
					log("checkpoint_pause_long", { runId: id, frozenMs });
					noteFailure();
				}
			} else if (result) {
				const reason = result.refused ?? result.skipped ?? "internal-error";
				if (reason === "internal-error") counts.failed += 1;
				else counts.skipped += 1;
				out.skipped = reason;
				if (PERMANENT_SNAPSHOT.has(reason)) turnLiveOff(reason);
				else noteFailure();
			} else {
				counts.failed += 1;
				out.failed = "internal";
				noteFailure();
			}
			if (out.stop && typeof onStop === "function") {
				try {
					await onStop();
				} catch {}
			}
			return out;
		};

		const maybeStart = () => {
			if (liveOff || degraded || stopped || closed || inflight || exiting) return;
			if (now() < nextAt) return;
			const release = semaphore.tryAcquire();
			if (!release) {
				// The host is already snapshotting twice. Not a failure and not backed off: the next quiet point asks again.
				counts.skipped += 1;
				return;
			}
			nextAt = now() + L.minIntervalMs;
			inflight = runLive(release)
				.catch(() => {
					counts.failed += 1;
					return { failed: "internal" };
				})
				.finally(() => {
					inflight = null;
				});
		};

		const stats = () => ({ ...counts, lastSeq });

		return {
			consume(parsed, _ts, endOffset, flags = {}) {
				try {
					if (isInt(endOffset)) lastEnd = endOffset;
					const quiet = tracker.take(parsed);
					if (!quiet || flags?.prior === true || flags?.replay === true) return;
					maybeStart();
				} catch {}
			},
			reset() {
				try {
					tracker.reset();
					lastEnd = null;
				} catch {}
			},
			pending: () => inflight,
			stats,
			close() {
				closing ??= (async () => {
					closed = true;
					try {
						await inflight;
					} catch {}
				})();
				return closing.then(stats);
			},
			exit({ kind = "exit" } = {}) {
				exiting ??= (async () => {
					try {
						try {
							await inflight;
						} catch {}
						if (!checkpointer || typeof checkpointer.snapshot !== "function") {
							counts.skipped += 1;
							return { skipped: "no-store" };
						}
						const release = await semaphore.acquire();
						let result;
						try {
							await initSeq();
							const offset = await offsetNow();
							result = await snapshotAt({ kind: kind === "salvage" ? "salvage" : "exit", quiesced: "dead", offset });
						} finally {
							release();
						}
						if (result?.ok) {
							counts.written += 1;
							lastSeq = result.seq;
							await publish(result);
							return { seq: result.seq };
						}
						const reason = result?.refused ?? result?.skipped ?? "internal-error";
						if (reason === "internal-error") counts.failed += 1;
						else counts.skipped += 1;
						return { skipped: reason };
					} catch {
						counts.failed += 1;
						return { skipped: "internal-error" };
					}
				})();
				return exiting;
			},
		};
	}

	return { open };
}
