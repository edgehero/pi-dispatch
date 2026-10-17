import { constants as fsConstants, lstatSync as fsLstatSync, mkdirSync, writeFileSync } from "node:fs";
import { lstat as fsLstat, open as fsOpen } from "node:fs/promises";
import { join } from "node:path";
import { escapeControls } from "./projects.mjs";
import { makeProgressSink } from "./run-progress.mjs";
import { sanitizeJobId } from "./run-history.mjs";

/**
 * The live transcript (issue #643, `DES-LIVE-TRANSCRIPT-STREAM`, `INT-LIVE-TRANSCRIPT-STREAM`): the worker tails the
 * pi session file of a running job and publishes a redacted, compact copy of it to one Valkey stream per job, so an
 * operator can watch the run from the console on any host and from the `/dispatch` panel.
 *
 * WHY THE WORKER AND NOT THE RUNNER. The runner is inside the container, and a container that could write to Valkey
 * would be a new network path out of the box (`CONST-ISOLATION-CONTAINER-PER-JOB`). The worker already mounts the
 * file; reading it from this side adds no mount and no route, and the job image is untouched.
 *
 * WHY A POLL AND NOT `fs.watch`. The file is a bind mount, and on Docker Desktop and Podman machine it crosses a VM:
 * change events are dropped or delayed there, measured often enough that a watch would be a stream that sometimes
 * stops. A `stat` every half second costs nothing next to a model call, and reads only what was appended.
 *
 * BEST EFFORT, BOUNDED, NEVER THROWING. Every Valkey call is bounded by `OP_TIMEOUT_MS` (the BullMQ connection queues
 * a command against an unreachable server forever), every failure is counted and the batch dropped rather than
 * buffered, and nothing here can fail or slow the job: a lost entry costs a line in a viewer, a stuck job costs money.
 *
 * Every published entry is redacted (redact-secrets.mjs), then has its control and bidi characters written out
 * (`escapeText`: `escapeControls`, keeping real newlines and tabs), then is truncated by code points. Log lines carry the job id and counts only, never an entry's
 * content (no-pii-in-logs).
 */

/** The stream key's prefix; the key is this plus the sanitized job id, as `runs:rec:` is (run-mirror.mjs). */
export const LIVE_KEY_PREFIX = "run:live:";
/** The stream's cap, `XADD ... MAXLEN ~`: approximate, so Valkey trims whole nodes and the bound is a floor. */
export const LIVE_MAX_ENTRIES = 2000;
/** The key's lifetime while the run is live, set at the first write: a crashed worker cannot leave it forever. */
export const LIVE_TTL_LIVE_MS = 7 * 24 * 60 * 60 * 1000;
/** The key's lifetime after the `end` entry. */
export const LIVE_TTL_ENDED_MS = 24 * 60 * 60 * 1000;
/** Every `kind` an entry can carry; readers refuse anything else. */
export const LIVE_KINDS = Object.freeze(["user", "assistant", "tool-call", "tool-result", "compaction", "note", "reset", "skipped", "end"]);
/** The `outcome` an `end` entry carries: the run's outcome, or `unknown`. Never free text. */
export const LIVE_OUTCOMES = Object.freeze(["completed", "policy", "failed", "unknown"]);
/** The most code points a `text` carries; an `assistant` entry gets the larger one. */
export const LIVE_TEXT_MAX = 4096;
export const LIVE_ASSISTANT_TEXT_MAX = 8192;
/** A transcript line longer than this is skipped, never parsed: one tool result must not pin a megabyte per poll. */
export const LIVE_LINE_MAX_BYTES = 1024 * 1024;
/** The `tool` charset; anything else is published as `?`. */
export const LIVE_TOOL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The fixed text an unparseable line becomes. Never the raw bytes: the line is agent-written. */
export const UNPARSEABLE_NOTE = "a transcript line that is not JSON was left out";
/** Published once when the transcript file is no longer a regular file (a link or a FIFO swapped in): never read again. */
export const REFUSED_NOTE = "the transcript file was replaced by something other than a regular file, so it is no longer read";

/** One run's stream key. */
export const liveKeyFor = (jobId) => `${LIVE_KEY_PREFIX}${sanitizeJobId(jobId)}`;

/** Each Valkey call's bound. Short: a viewer can wait half a second longer, the job must not. */
const OP_TIMEOUT_MS = 1_000;
/** The whole of `finish`'s bound, final read and flush included, so a dead Valkey adds at most this to a run's end. */
const FINISH_TIMEOUT_MS = 3_000;
/**
 * How many entries, and how many bytes of their field values (UTF-16, two per code unit: what they occupy in memory),
 * may wait for a write. Past either bound the OLDEST are dropped and counted, never buffered: a viewer watching live
 * needs the newest lines, and the `end` entry is never queued, so it is never the one dropped.
 */
const PENDING_MAX = LIVE_MAX_ENTRIES;
const PENDING_MAX_BYTES = 8 * 1024 * 1024;
/** The most bytes `finish`'s final read takes, so a huge or sparse file cannot hold the run's end. */
export const LIVE_FINAL_READ_MAX_BYTES = 64 * 1024 * 1024;
/** How far past the publish time a pi timestamp may lie before the publish time is used instead. */
const TS_FUTURE_MS = 24 * 60 * 60 * 1000;
/** The most bytes one poll reads, so a burst is taken over several polls rather than in one allocation. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** How much of the first line is kept to notice a rewrite. The header is one short line. */
const FIRST_LINE_PROBE_BYTES = 4096;

/** The file the container sees, inside the job's own session directory. */
export const LIVE_FILE_NAME = "current.jsonl";

/**
 * Stage the live transcript file for a job that has no resume transcript: `<jobDir>/session/current.jsonl`, the
 * directory 0700 and the file empty, the SAME layout `resolveSession` stages for a resume job (session-store.mjs).
 * The same directory on purpose: it is mounted at the runner's existing `/session` path, the sandbox retention
 * already removes it before it keeps a run (sandbox-store.mjs), and it is deleted with the job directory. There is
 * no store key, nothing is promoted and the run record gains nothing: whether a job RESUMES is still keyed on
 * `prepared.session` alone.
 *
 * Empty, not absent: pi then takes its empty-file branch and writes its own header at this path (the reason
 * session-store.mjs gives). Returns `{ hostDir }`, or null when it could not be staged (the job then runs as every
 * job did before this feature, with no file and no stream). Never throws.
 */
export function stageLiveFile(jobDir, { fs = { mkdirSync, writeFileSync } } = {}) {
	if (typeof jobDir !== "string" || jobDir === "") return null;
	try {
		const hostDir = join(jobDir, "session");
		fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(join(hostDir, LIVE_FILE_NAME), "", { mode: 0o600 });
		return { hostDir };
	} catch {
		return null;
	}
}

function bounded(promise, ms) {
	let timer;
	return Promise.race([
		Promise.resolve(promise),
		new Promise((_, reject) => {
			// Ref'd on purpose: whoever awaits this bound must be woken by it, even when nothing else holds the loop.
			timer = setTimeout(() => reject(new Error("live transcript timeout")), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/**
 * `escapeControls` with two exceptions, so a multi-line message or tool output stays multi-line for a reader: a line
 * break (`\r\n` and a lone `\r` normalised to `\n`) and a tab stay real characters. Every other control and every
 * bidi or invisible character is written out as `\u{XXXX}` as before. Readers split on the real newlines.
 */
export function escapeText(text) {
	return String(text ?? "")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.split("\t").map(escapeControls).join("\t"))
		.join("\n");
}

/**
 * The first `points` code points of `text`, cheaply: a string of at most `points` UTF-16 units has at most that many
 * code points, and only a longer one is walked. Used to cut a redacted text down before it is escaped, so a megabyte
 * line costs one redaction pass and never a megabyte of escaping or of queue.
 */
export function headOf(text, points) {
	if (text.length <= points) return text;
	let i = 0;
	let n = 0;
	while (i < text.length && n < points) {
		const c = text.charCodeAt(i);
		i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
		n += 1;
	}
	return text.slice(0, i);
}

/** Text truncated to `max` code points, without leaving half of an `escapeControls` escape at the cut. */
export function clip(text, max) {
	const points = [...text];
	if (points.length <= max) return { text, truncated: false };
	return { text: points.slice(0, max).join("").replace(/\\u\{[0-9A-F]{0,6}$|\\u$|\\$/, ""), truncated: true };
}

/** The text parts of a pi content value (a string, or text and image parts), images as `[image]`. */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
		else if (part?.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

const toolName = (name) => (typeof name === "string" && LIVE_TOOL_RE.test(name) ? name : "?");

/**
 * One pi session entry as the display entries it becomes: `[{ kind, ts, text?, tool?, error? }]`, before redaction.
 * Shapes are the pinned pi's (`@earendil-works/pi-coding-agent` dist/core/session-manager.js, and pi-ai's message
 * types): the `session` header, `message` entries with role `user`, `assistant` or `toolResult` (and pi's own
 * `bashExecution`), `custom_message`, `compaction`, `branch_summary`, `model_change`, `thinking_level_change`,
 * `context_edit`. `usage`, `custom`, `session_info` and `label` carry nothing a reader needs and are left out.
 * Thinking is dropped: a model's private reasoning is not shown.
 */
export function entriesOf(line, ts) {
	switch (line?.type) {
		case "session":
			return [{ kind: "note", ts, text: "session started" }];
		case "message": {
			const message = line.message ?? {};
			switch (message.role) {
				case "user":
					return [{ kind: "user", ts, text: contentText(message.content) }];
				case "assistant": {
					const out = [];
					const content = Array.isArray(message.content) ? message.content : [];
					const text = content
						.filter((p) => p?.type === "text" && typeof p.text === "string")
						.map((p) => p.text)
						.join("\n");
					if (text.trim() !== "") out.push({ kind: "assistant", ts, text });
					for (const part of content) {
						if (part?.type !== "toolCall") continue;
						let args;
						try {
							args = JSON.stringify(part.arguments ?? {}) ?? "";
						} catch {
							args = "";
						}
						out.push({ kind: "tool-call", ts, tool: toolName(part.name), text: args });
					}
					// The stop reason only when the turn did not end normally, as a token, never the provider's message.
					if (message.stopReason === "error" || message.stopReason === "aborted") out.push({ kind: "note", ts, text: `the model's turn ended: ${message.stopReason}` });
					return out;
				}
				case "toolResult":
					return [{ kind: "tool-result", ts, tool: toolName(message.toolName), text: contentText(message.content), ...(message.isError === true ? { error: true } : {}) }];
				case "bashExecution":
					return [{ kind: "tool-result", ts, tool: "bash", text: `$ ${typeof message.command === "string" ? message.command : ""}\n${typeof message.output === "string" ? message.output : ""}` }];
				default:
					return [{ kind: "note", ts, text: `a ${toolName(message.role)} message` }];
			}
		}
		case "custom_message":
			return [{ kind: "note", ts, text: `${toolName(line.customType)}: ${contentText(line.content)}` }];
		case "compaction":
			return [{ kind: "compaction", ts, text: typeof line.summary === "string" ? line.summary : "" }];
		case "branch_summary":
			return [{ kind: "compaction", ts, text: typeof line.summary === "string" ? line.summary : "" }];
		case "model_change":
			return [{ kind: "note", ts, text: `model: ${toolName(line.provider)}/${typeof line.modelId === "string" ? line.modelId : "?"}` }];
		case "thinking_level_change":
			return [{ kind: "note", ts, text: `thinking level: ${toolName(line.thinkingLevel)}` }];
		case "context_edit":
			return [{ kind: "note", ts, text: "an earlier message was edited out of the context" }];
		default:
			return [];
	}
}

/** The run's outcome as the enum an `end` entry carries. */
export const outcomeOf = (outcome) => (LIVE_OUTCOMES.includes(outcome) ? outcome : "unknown");

/**
 * `makeLiveTranscript({ file, jobId, redis, redact, now, pollMs, log, fs })` returns `{ start(), finish(outcome), poll() }`.
 *
 *   - `start()` begins polling `file` every `pollMs`. Idempotent, and refused once `finish` was called.
 *   - `finish(outcome)` stops the timer, waits for a poll in flight, reads the file one last time, flushes what is
 *     pending, publishes `end` with `outcome` (the `LIVE_OUTCOMES` enum, anything else is `unknown`) and sets the
 *     ended TTL. Bounded by `FINISH_TIMEOUT_MS` whatever Valkey does; idempotent (a second call returns the first's
 *     promise). It must run BEFORE the job directory is removed, or the run's last lines are lost: `runContainer`
 *     calls it in the container's `close` handler, before it resolves, so before the processor's cleanup can run.
 *
 * READING. The file is opened per poll and read from the offset, which handles a file that does not exist yet (the
 * first polls before pi writes its header), a file replaced under the same name (the runner's quarantine renames
 * it), and a file rewritten in place (pi's `_rewriteFile`). A complete line is everything up to a newline; a partial
 * last line is held until it completes. A size below the offset, a new inode, or a first line that changed means the
 * file was rewritten: `reset` is published and the file is read again from 0. Residual: a rewrite to the same first
 * line and a size above the offset is not seen; pi rewrites only on a format migration or a branch, neither of which
 * a job does after its header.
 *
 * MEMORY. Each entry is redacted, escaped and cut to its final size when it is QUEUED, so the queue holds only what
 * will be written (at most 8192 code points of text per entry) and is bounded in entries and in bytes. The whole
 * text is redacted BEFORE any cut, so no cut can split a secret and leave its head standing. The final read is
 * bounded too (`LIVE_FINAL_READ_MAX_BYTES`) and flushes after every chunk.
 *
 * ONE ATTEMPT, ONE WRITER. Once `finish` has settled (done, or its bound ran out), this publisher is CLOSED: no read is
 * started, nothing is queued and nothing is written, ever, even when a read or a write it started before then
 * completes later. That is what keeps a stale attempt out of the next attempt's stream, which the next attempt's first
 * write emptied. Residual: a transaction already handed to the client before `finish` settled can still land after
 * it (the client resends one in flight across a reconnect). A write is never handed to a client that is not `ready`.
 *
 * ON A RETRY the job id, and so the key, is the same. The first write of an attempt deletes what an earlier attempt
 * left, in the same transaction, so a stream holds one attempt and its `end` is that attempt's.
 *
 * RUN PROGRESS (issue #644). `onParsed(parsed, ts, { prior, replay, end })` is handed every parsed line, before and apart
 * from the stream mapping, and never once the publisher is closed; a throw from it is swallowed. `prior` marks a line
 * that ended at or before the BASELINE, the file's size when the first read began (`lstat`; a missing file or anything
 * but a regular file is 0): on a resume those are the earlier runs' lines. After a reset there is no prior any more, and
 * `replay` marks a line that ended at or before the rewritten file's size at the reset (run-progress.mjs states what
 * the reducer does with it). `onReset()` is called at each reset. `stream: false` is the mode for progress with
 * transcripts off: the file is tailed and every line handed to `onParsed`, and nothing is queued or written to the
 * stream, so no `run:live:` key is ever touched.
 */
export function makeLiveTranscript({ file, jobId, redis, redact = (t) => String(t ?? ""), now = () => Date.now(), pollMs = 500, log = () => {}, fs = { open: fsOpen, lstat: fsLstat, lstatSync: fsLstatSync }, timeoutMs = OP_TIMEOUT_MS, finishTimeoutMs = FINISH_TIMEOUT_MS, lineMaxBytes = LIVE_LINE_MAX_BYTES, pendingMax = PENDING_MAX, pendingMaxBytes = PENDING_MAX_BYTES, finalReadMaxBytes = LIVE_FINAL_READ_MAX_BYTES, readChunkBytes = READ_CHUNK_BYTES, stream = true, onParsed = null, onReset = null, onBaseline = null } = {}) {
	const key = liveKeyFor(jobId);
	const id = sanitizeJobId(jobId);
	let offset = 0;
	let ino = null;
	let refused = false;
	let firstLine = null; // the first line's bytes (up to the probe), once a full one was read
	let held = Buffer.alloc(0);
	let skipping = false; // inside an oversize line: drop bytes until its newline
	let timer = null;
	let inFlight = null;
	let finishing = null;
	let closed = false; // finish has settled: nothing is read, queued or written from here on
	let started = false;
	let firstWriteDone = false; // the attempt's DEL and the live TTL have landed
	const pending = []; // [{ fields, size }], each entry already in its final form
	let pendingBytes = 0;
	const counts = { published: 0, dropped: 0, skipped: 0, notes: 0, resets: 0, errors: 0, refused: 0 };
	let warned = false;
	let baseline = 0; // the file's size when the first read began: lines ending at or before it are `prior`
	let baselineTaken = null;
	let replayUntil = null; // set at a reset: the rewritten file's size then, lines ending at or before it are `replay`
	let baselineReported = false;

	/**
	 * Issue #646: `onBaseline()` is called ONCE, when this attempt has read the file up to its baseline (every `prior`
	 * line handed over), so a consumer can act on the whole of the staged transcript before anything new: the steer ack
	 * learns which messages a restored transcript already holds before the relay writes a file. Also called, FAILING
	 * OPEN, when the file was refused or a read failed: a consumer that waits for it must never wait forever, and the
	 * cost of an early call is a message delivered twice, where a call that never came would deliver none.
	 */
	const reportBaseline = () => {
		if (baselineReported || typeof onBaseline !== "function" || closed) return;
		baselineReported = true;
		try {
			onBaseline();
		} catch {}
	};

	/**
	 * The baseline, once: the file's size before anything of this attempt was read. Never rejects. Only `onParsed` reads
	 * it, so without one no `lstat` is added and the stream reads the file exactly as it did before issue #644.
	 *
	 * SYNCHRONOUS when it can be. `start` runs at spawn, before pi can write a line; an awaited `lstat` resolves a tick
	 * later, and a line pi (or a fast test writer) appended in between would be taken as an earlier run's and counted
	 * as `prior` instead of this attempt's. The async path is kept for an injected `fs` without `lstatSync`.
	 */
	const takeBaseline = () => {
		if (typeof onParsed !== "function" && typeof onBaseline !== "function") return undefined;
		if (baselineTaken === null && typeof fs.lstatSync === "function") {
			try {
				const info = fs.lstatSync(file);
				baseline = info.isFile() ? info.size : 0;
			} catch {
				baseline = 0;
			}
			baselineTaken = Promise.resolve();
		}
		baselineTaken ??= (async () => {
			try {
				const info = await fs.lstat(file);
				baseline = info.isFile() ? info.size : 0;
			} catch {
				baseline = 0;
			}
		})();
		return baselineTaken;
	};

	/**
	 * The flat field list of one entry, every value a string: the text redacted (the WHOLE text, before any cut), then
	 * cut to a head that cannot shrink below the limit when escaped (`\r\n` becoming `\n` is the only shrink, by half),
	 * then escaped, then cut by code points. The tool name redacted too, `?` when that changed it. The timestamp the pi
	 * entry's own when it is a sane integer (not negative, not more than a day ahead), else the publish time. Null when
	 * the redactor threw: that entry is not published at all, never its raw text.
	 */
	const fieldsOf = (entry) => {
		const at = now();
		const ts = Number.isFinite(entry.ts) && entry.ts >= 0 && entry.ts <= at + TS_FUTURE_MS ? Math.trunc(entry.ts) : at;
		const fields = ["kind", entry.kind, "ts", String(ts)];
		try {
			let tool;
			if (entry.tool !== undefined) {
				tool = toolName(entry.tool);
				if (tool !== "?" && redact(tool) !== tool) tool = "?";
			}
			if (typeof entry.text === "string") {
				const max = entry.kind === "assistant" ? LIVE_ASSISTANT_TEXT_MAX : LIVE_TEXT_MAX;
				const { text, truncated } = clip(escapeText(headOf(String(redact(entry.text)), 2 * max + 2)), max);
				fields.push("text", text);
				if (tool !== undefined) fields.push("tool", tool);
				if (entry.error === true) fields.push("error", "1");
				if (truncated) fields.push("truncated", "1");
			} else if (tool !== undefined) {
				fields.push("tool", tool);
			}
		} catch {
			return null;
		}
		if (entry.kind === "end") fields.push("outcome", entry.outcome);
		return fields;
	};

	const enqueue = (entry) => {
		if (closed || !stream) return;
		const fields = fieldsOf(entry);
		if (fields === null) {
			counts.errors += 1;
			return;
		}
		const size = fields.reduce((n, f) => n + f.length * 2, 0);
		pending.push({ fields, size });
		pendingBytes += size;
		// The oldest go first; the newest entry always stays, whatever its size.
		while (pending.length > 1 && (pending.length > pendingMax || pendingBytes > pendingMaxBytes)) {
			pendingBytes -= pending.shift().size;
			counts.dropped += 1;
		}
	};

	/** One complete line, `end` the file position just past it (where its newline was); `complete` false for the final unterminated tail. */
	const publishLine = (bytes, end, complete = true) => {
		if (closed) return;
		const ts = now();
		let parsed;
		try {
			parsed = JSON.parse(bytes.toString("utf8"));
		} catch {
			counts.notes += 1;
			enqueue({ kind: "note", ts, text: UNPARSEABLE_NOTE });
			return;
		}
		const at = typeof parsed?.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.isFinite(parsed?.timestamp) ? parsed.timestamp : NaN;
		const entryTs = Number.isFinite(at) ? at : ts;
		if (typeof onParsed === "function") {
			// The same bound `fieldsOf` puts on the stream's `ts`: the line is the agent's to write, and the progress
			// reducer keeps this as a step's `since` (the key's `running`, and `longestInterruptedMs` in the record).
			const parsedTs = entryTs >= 0 && entryTs <= ts + TS_FUTURE_MS ? Math.trunc(entryTs) : ts;
			try {
				// `end` (issue #645): the file position just past this line's newline, so a checkpoint consumer knows a
				// complete-line boundary. Absent for the final read's unterminated tail, which ends at no newline.
				const endOf = complete ? { end } : {};
				onParsed(parsed, parsedTs, replayUntil === null ? { prior: end <= baseline, ...endOf } : { prior: false, replay: end <= replayUntil, ...endOf });
			} catch {}
		}
		if (!stream) return;
		for (const entry of entriesOf(parsed, entryTs)) enqueue(entry);
	};

	/** Split `chunk` (appended bytes, the first at file position `base`) into lines, holding a partial tail and skipping oversize lines. */
	const takeBytes = (chunk, base) => {
		let start = 0;
		for (;;) {
			const nl = chunk.indexOf(0x0a, start);
			if (nl === -1) break;
			const piece = chunk.subarray(start, nl);
			start = nl + 1;
			if (skipping) {
				skipping = false;
				held = Buffer.alloc(0);
				continue;
			}
			const line = held.length > 0 ? Buffer.concat([held, piece]) : piece;
			held = Buffer.alloc(0);
			if (firstLine === null) firstLine = Buffer.from(line.subarray(0, FIRST_LINE_PROBE_BYTES));
			if (line.length > lineMaxBytes) {
				counts.skipped += 1;
				enqueue({ kind: "skipped", ts: now() });
				continue;
			}
			if (line.length === 0) continue;
			publishLine(line, base + start);
		}
		const tail = chunk.subarray(start);
		if (skipping || tail.length === 0) return;
		if (held.length + tail.length > lineMaxBytes) {
			// An oversize line still being written: said once, now, and the rest of it is dropped as it arrives.
			if (firstLine === null) firstLine = Buffer.from(Buffer.concat([held, tail]).subarray(0, FIRST_LINE_PROBE_BYTES));
			held = Buffer.alloc(0);
			skipping = true;
			counts.skipped += 1;
			enqueue({ kind: "skipped", ts: now() });
			return;
		}
		held = Buffer.concat([held, tail]);
	};

	/** The file was rewritten (`size` is its size as seen now): read it again from 0. */
	const restart = (size) => {
		offset = 0;
		firstLine = null;
		held = Buffer.alloc(0);
		skipping = false;
		counts.resets += 1;
		replayUntil = Number.isSafeInteger(size) && size >= 0 ? size : 0;
		enqueue({ kind: "reset", ts: now() });
		if (typeof onReset === "function") {
			try {
				onReset();
			} catch {}
		}
	};

	/**
	 * The file is the AGENT's: `/session` is mounted read-write into the job, so the agent can replace `current.jsonl`
	 * with a symlink to any host path, or with a FIFO. The worker reads as its own account, so following that link would
	 * publish whatever host file it named (another job's stored transcript is exactly pi-shaped). So: `lstat` first and
	 * refuse anything but a regular file, then open and judge the OPEN DESCRIPTOR: it must be a regular file with the
	 * inode `lstat` saw. That inode check is the rule that closes a swap between the two calls, a link included (a link
	 * opened through resolves to its target's inode, which is not the one `lstat` saw). O_NOFOLLOW (`ELOOP` on a link)
	 * and the descriptor's `isFile` are defence in depth behind it: no swap is known that only they stop, since a link
	 * whose target has the inode `lstat` saw (a hard link to this very file) reads this very file. O_NONBLOCK is not
	 * optional: a FIFO swapped in would otherwise hang the open itself, before any check could run. A refused file is
	 * said once, as a fixed note, and never read again for this job.
	 */
	const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
	const refuse = () => {
		refused = true;
		counts.refused += 1;
		enqueue({ kind: "note", text: REFUSED_NOTE, ts: now() });
	};

	/**
	 * One read of whatever was appended since the last. `final` reads to the end (at most `finalReadMaxBytes`, flushing
	 * after every chunk) and takes a partial tail as a line once the end was reached. No read starts after `finish`
	 * settled (`readAt`), and what a read still in flight then returns is never queued (`enqueue`).
	 */
	const readOnce = async (final = false) => {
		if (refused) return reportBaseline();
		await takeBaseline();
		let handle = null;
		let failed = false;
		try {
			let info;
			try {
				info = await fs.lstat(file);
			} catch {
				return; // not there yet (or gone with the job directory): nothing to read
			}
			if (!info.isFile()) return refuse();
			if ((ino !== null && info.ino !== ino && offset > 0) || info.size < offset) restart(info.size);
			ino = info.ino;
			try {
				handle = await fs.open(file, OPEN_FLAGS);
			} catch (err) {
				if (err?.code === "ELOOP") return refuse();
				throw err;
			}
			const opened = await handle.stat();
			// Every read goes through here: none starts once `finish` settled, whatever this read was doing then.
			const readAt = async (buf, length, position) => {
				if (closed) throw new Error("live transcript closed");
				return handle.read(buf, 0, length, position);
			};
			if (!opened.isFile() || opened.ino !== info.ino) return refuse();
			if (firstLine !== null && offset > 0) {
				const probe = Buffer.alloc(firstLine.length);
				const { bytesRead } = await readAt(probe, probe.length, 0);
				if (bytesRead < firstLine.length || !probe.equals(firstLine)) restart(info.size);
			}
			let budget = final ? finalReadMaxBytes : readChunkBytes;
			let atEnd = false;
			for (;;) {
				const size = (await handle.stat()).size;
				if (size <= offset) {
					atEnd = true;
					break;
				}
				if (budget <= 0) {
					// The final read's budget is spent and the file goes on: said once, and the rest is not read.
					counts.skipped += 1;
					enqueue({ kind: "skipped", ts: now() });
					break;
				}
				const want = Math.min(size - offset, readChunkBytes, budget);
				const buf = Buffer.alloc(want);
				const { bytesRead } = await readAt(buf, want, offset);
				if (bytesRead <= 0) break;
				const base = offset;
				offset += bytesRead;
				budget -= bytesRead;
				takeBytes(buf.subarray(0, bytesRead), base);
				if (!final) break;
				await flush();
			}
			if (final && atEnd && held.length > 0 && !skipping) {
				const line = held;
				held = Buffer.alloc(0);
				publishLine(line, offset, false);
			}
		} catch {
			counts.errors += 1;
			failed = true;
		} finally {
			await handle?.close().catch(() => {});
			if (refused || failed || offset >= baseline) reportBaseline();
		}
	};

	const fail = () => {
		counts.errors += 1;
		if (!warned) {
			warned = true;
			log("live_transcript_write_failed", { jobId: id });
		}
	};

	/**
	 * Write every pending entry, then `extra` (raw entries, the `end`), in one bounded transaction; on any failure,
	 * including a reply that carries an error for any command in it, the batch is dropped and counted. Nothing once
	 * closed, and nothing handed to a client that says it is not `ready` (it would queue or resend it later).
	 */
	const flush = async (extra = []) => {
		// No client: nothing to write to, so the queue keeps its bound and nothing else happens (a test seam; the opener
		// builds no publisher without a client). With the stream off nothing is ever written to it, the `end` included.
		if (closed || !redis || !stream) return;
		// A client still connecting (or reconnecting) is not a failure: the queue keeps its entries, within its bound, for
		// the next flush. Only a flush that carries the end (`extra`) proceeds, since nothing comes after it to retry.
		if (typeof redis.status === "string" && redis.status !== "ready" && extra.length === 0) return;
		const batch = pending.splice(0, pending.length).map((p) => p.fields);
		pendingBytes = 0;
		for (const entry of extra) {
			const fields = fieldsOf(entry);
			if (fields !== null) batch.push(fields);
		}
		if (batch.length === 0) return;
		const ended = extra.some((e) => e.kind === "end");
		try {
			if (typeof redis.status === "string" && redis.status !== "ready") throw new Error("live transcript client not ready");
			const tx = redis.multi();
			if (!firstWriteDone) tx.del(key);
			for (const fields of batch) tx.xadd(key, "MAXLEN", "~", String(LIVE_MAX_ENTRIES), "*", ...fields);
			if (!firstWriteDone || ended) tx.pexpire(key, ended ? LIVE_TTL_ENDED_MS : LIVE_TTL_LIVE_MS);
			const result = await bounded(tx.exec(), timeoutMs);
			if (!Array.isArray(result) || result.some((r) => Array.isArray(r) && r[0])) throw new Error("live transcript write refused");
			firstWriteDone = true;
			counts.published += batch.length;
		} catch {
			counts.dropped += batch.length;
			fail();
		}
	};

	const tick = () => {
		if (inFlight || finishing) return inFlight;
		inFlight = (async () => {
			try {
				await readOnce(false);
				await flush();
			} catch {
				counts.errors += 1;
			}
		})().finally(() => {
			inFlight = null;
		});
		return inFlight;
	};

	return {
		/** One poll now (read what was appended, then flush), the same the timer runs. For tests; never throws. */
		poll: () => tick() ?? Promise.resolve(),
		/** What is held in memory right now, and the counts. For tests. */
		stats: () => ({ pending: pending.length, pendingBytes, held: held.length, closed, ...counts }),
		start() {
			if (started || finishing) return;
			started = true;
			void takeBaseline();
			timer = setInterval(tick, pollMs);
			timer.unref?.();
			void tick();
		},
		finish(outcome) {
			if (finishing) return finishing;
			if (timer) clearInterval(timer);
			timer = null;
			const work = (async () => {
				try {
					await inFlight;
				} catch {}
				await readOnce(true);
				await flush([{ kind: "end", ts: now(), outcome: outcomeOf(outcome) }]);
			})();
			finishing = bounded(work, finishTimeoutMs)
				.catch(() => fail())
				.then(() => {
					// Closed whichever way the bound settled: a read or a write still running in the background is
					// never followed by another, and what it read is never queued.
					closed = true;
					pending.length = 0;
					pendingBytes = 0;
					log("live_transcript_ended", { jobId: id, ...counts });
				});
			return finishing;
		},
	};
}

/**
 * The opener `runContainer` is handed (start.mjs builds it when `PI_LIVE_TRANSCRIPTS` or `PI_RUN_PROGRESS` is on and a
 * Valkey client exists, and since issue #645 whenever a run checkpointer exists): `({ file, jobId, redact, job,
 * checkpoint }) => { start, finish, progressSummary, checkpoint } | null`. A seam, so a test wires a fake publisher or none.
 *
 *   - `transcripts` writes the stream (#643); `progress` builds the run progress sink (#644, run-progress.mjs) and hands
 *     it every parsed line. With transcripts off and progress on, the file is tailed and nothing reaches the stream.
 *   - `makeCommenter({ job, jobId, commentId, onId, finalTimeoutMs })` builds the forge status commenter
 *     (status-comment.mjs), asked only for a job whose trigger set `run.statusComment` and only with progress on; it
 *     may return null (start.mjs does for a job with no forge to post to). `job.progress === true` makes the sink read
 *     `report_progress` phases.
 *   - `checkpoint` (issue #645) is the run checkpointer's `open` (run-checkpoint.mjs). Called per attempt, only when
 *     runContainer hands open args (`checkpoint`: a `run.recover` job the processor armed), with `sessionFile` set to
 *     the tailed file. Its handle is the THIRD consumer of every parsed line, beside the progress sink, and is returned
 *     as `checkpoint` for runContainer to close and hand back. It turns the tailing on by itself: a recover job with
 *     both switches off still has its file tailed (`stream: false`, no progress sink), because the live checkpoints
 *     are driven by its lines. A factory that throws costs the checkpoints, never the stream or the run.
 *   - `finish(outcome)` finishes the stream first (its own bound, `FINISH_TIMEOUT_MS`, which also closes the publisher,
 *     so no line is handed to the sink after it), then the sink (a wait for a comment post in flight and the final
 *     write, its own bound of 5 s). Worst case at a run's end: 3 s plus 5 s, and the 5 s only when Valkey or the forge
 *     hangs. The comment's final edit is not in it: start.mjs makes that one from the run record. The checkpoint handle
 *     is NOT closed here: runContainer closes it, so it can stop new live checkpoints before this final read.
 *   - `progressSummary()` is the record's `progress` (run-history.mjs `recordedProgress`), or null with progress off.
 *   - `steer` (issue #646): the factory flag says this deployment can arm steering, so the opener is built even with
 *     every other reader off; per job, `steer` is the ack consumer (steer-ack.mjs `makeSteerAck`) runContainer hands for
 *     an ARMED attempt. It is the third consumer of every parsed line and hears `onBaseline`, and like the checkpoint
 *     it turns the tailing on by itself (`stream: false`): the acks are what count a delivery, so a steer job with
 *     transcripts, progress and checkpoints all off still has its file read. An unarmed job hands none, and its opener
 *     is exactly what it was.
 */
export function makeLiveTranscriptOpener({ redis, log = () => {}, now = () => Date.now(), pollMs = 500, transcripts = true, progress = false, makeCommenter = null, progressWriter = {}, checkpoint = null, steer = false } = {}) {
	const streamOn = Boolean(redis) && transcripts;
	const progressOn = Boolean(redis) && progress;
	if (!streamOn && !progressOn && typeof checkpoint !== "function" && steer !== true) return null;
	return ({ file, jobId, redact, job = null, checkpoint: checkpointArgs = null, steer: steerAck = null }) => {
		let handle = null;
		if (typeof checkpoint === "function" && checkpointArgs && typeof checkpointArgs === "object") {
			try {
				handle = checkpoint({ ...checkpointArgs, sessionFile: file }) ?? null;
			} catch {
				handle = null;
			}
		}
		// Nothing would read the file: no stream, no progress, no checkpoints, no steer acks. runContainer runs the job as before.
		if (!streamOn && !progressOn && handle === null && !steerAck) return null;
		// A trigger that asked for a status comment on a deployment with progress off gets none: said once per job, never
		// a silent no-op (the comment is driven by progress, so there is nothing to post).
		if (!progressOn && job?.statusComment === true) log("status_comment_skipped", { jobId: sanitizeJobId(jobId), reason: "progress-off" });
		const sink = progressOn
			? makeProgressSink({
					redis,
					jobId,
					phasesEnabled: job?.progress === true,
					redact,
					now,
					log,
					writer: progressWriter,
					makeCommenter: typeof makeCommenter === "function" && job?.statusComment === true ? (opts) => makeCommenter({ job, ...opts }) : null,
				})
			: null;
		// Each consumer guarded on its own, so a throw in one never starves another of the line. The steer ack (issue #646)
		// is the third, beside the progress sink and the checkpoint handle.
		const parsedConsumers = [];
		if (sink) parsedConsumers.push({ consume: (parsed, ts, flags) => sink.consume(parsed, ts, flags), reset: () => sink.reset() });
		if (handle) parsedConsumers.push({ consume: (parsed, ts, flags) => handle.consume(parsed, ts, flags?.end, flags), reset: () => handle.reset() });
		if (steerAck) parsedConsumers.push({ consume: (parsed, ts, flags) => steerAck.consume(parsed, ts, flags), reset: () => steerAck.reset?.() });
		const consumers =
			parsedConsumers.length > 0
				? {
						onParsed: (parsed, ts, flags) => {
							for (const c of parsedConsumers) {
								try {
									c.consume(parsed, ts, flags);
								} catch {}
							}
						},
						onReset: () => {
							for (const c of parsedConsumers) {
								try {
									c.reset();
								} catch {}
							}
						},
					}
				: {};
		if (steerAck && typeof steerAck.onBaseline === "function") consumers.onBaseline = () => steerAck.onBaseline();
		const live = makeLiveTranscript({ file, jobId, redis, redact, now, pollMs, log, stream: streamOn, ...consumers });
		let finishing = null;
		return {
			poll: live.poll,
			stats: () => ({ ...live.stats(), ...(sink ? { progress: sink.stats() } : {}), ...(handle ? { checkpoint: handle.stats() } : {}), ...(typeof steerAck?.stats === "function" ? { steer: steerAck.stats() } : {}) }),
			start() {
				live.start();
				try {
					sink?.start();
				} catch {}
			},
			finish(outcome) {
				finishing ??= (async () => {
					try {
						await live.finish(outcome);
					} catch {}
					try {
						await sink?.finish(outcome);
					} catch {}
				})();
				return finishing;
			},
			progressSummary: () => (sink ? sink.summary() : null),
			checkpoint: handle,
		};
	};
}
