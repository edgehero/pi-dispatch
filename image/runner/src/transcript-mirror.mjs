import { createHmac } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { writeAllSync } from "./exit-line.mjs";

/**
 * The transcript mirror (issue #686, `DES-OPENSHELL-VENUE`, `INT-RUNNER-EXIT-CODE-PROTOCOL`'s transcript records): on a
 * venue that COPIES the job's files (`openshell`), the session file lives in the sandbox until the download after the
 * run, so the worker's live tail (worker/src/live-transcript.mjs) has nothing on the host to read. The runner mirrors
 * the file's lines over its own STDERR instead, one signed record per complete line, and the worker verifies each and
 * feeds it into the same live-transcript path a bind-mounted file takes (worker/src/stderr-transcript.mjs).
 *
 * WHY STDERR AND NOT STDOUT. stdout already carries the runner's log and the signed exit line, which the worker reads
 * from a bounded 64 KiB TAIL (run-history.mjs): a transcript burst on stdout would push the exit line's neighbours out
 * of that tail, and a record stream on the same pipe as the exit line is one more thing a reader of either must get
 * right. stderr carries nothing the worker parses, so the records are the only structure on it. OpenShell's
 * `sandbox exec --no-tty` keeps the two streams apart (measured, 0.1.4), forwarding each in reads of up to 4 KiB that are
 * not line-aligned, which is why a record is self-delimiting (a marker at a line start, a newline at its end).
 *
 * WHAT THE MAC PROVES, AND WHAT IT DOES NOT. The agent shares this process's uid and can write to the container's stderr
 * (a tool opening the runner's `/proc/<pid>/fd/2`, as the exit line's comment measured for fd 1). The MAC, under the
 * per-attempt exit key the agent never sees (exit-line.mjs), authenticates the CHANNEL: a record that verifies was
 * written by this mirror, in this order (`seq` only grows, so a record taken and written again is refused), saying
 * where in the file its line ended. It does NOT authenticate the CONTENT: the session file is the agent's to write
 * (its directory is writable to the job), so the agent can append pi-shaped lines that this mirror then sends, signed.
 * A line here has exactly the trust of a line the worker's file tail reads on a binding venue, no more.
 *
 * THE FORMAT, one record per line, `\x1epidt <seq> <type> <end> <mac> <base64 payload>\n`, base64 so a record holds no
 * newline whatever the line holds; `end` is a byte offset in the session file, decimal:
 *   - `b`, the BASELINE, always `seq` 1: `end` is the file's size when the mirror started, before pi loads, payload
 *     empty. A resumed session's earlier conversation lies at or before it, so the worker counts those lines as `prior`
 *     (an earlier run's), as its file tail does with the size it reads at spawn.
 *   - `l`, a LINE: the payload is the line's bytes without the newline, `end` the offset just past that newline.
 *   - `r`, a RESET: the file was rewritten (it shrank, its inode changed, or its first line changed, as pi's in-place
 *     rewrite does), `end` its size then, payload empty; the mirror reads it again from 0, and the worker treats what
 *     follows as its tail treats a rewritten file (lines ending at or before `end` are a `replay`).
 * A line longer than `TRANSCRIPT_LINE_MAX_BYTES` is not sent but still takes its `seq`, so the worker sees the gap and
 * shows a `skipped` entry, as its file tail does for a line past the same bound; the next line's own `end` keeps every
 * position exact across the gap.
 *
 * WRITTEN SYNCHRONOUSLY, every byte (`writeAllSync`): this process's other stderr writes are synchronous too (Node
 * writes stderr synchronously to a pipe on Linux), so no write from this process lands inside a record. A write that
 * fails takes no `seq` and rewinds the read to the start of its line, so the next drain sends it again: nothing is lost
 * without a gap. RESIDUAL: a record larger than PIPE_BUF (4 KiB) is not atomic against a write from ANOTHER process
 * sharing the pipe (a child that inherited fd 2); such a record arrives broken, fails its MAC and is counted by the
 * worker, never published.
 *
 * Off unless the worker asked (PI_TRANSCRIPT=stderr, written only for an armed attempt) AND a key was delivered: with
 * PI_TRANSCRIPT unset nothing here runs, so every other venue's stderr is byte-identical to before.
 */

/** The variable that asks for the mirror, and its one value. Never a secret: it names the channel. */
export const TRANSCRIPT_ENV = "PI_TRANSCRIPT";
export const TRANSCRIPT_STDERR = "stderr";
/** A record's marker: RS (0x1e), never the first byte of a line pi, node or a shell writes, then a fixed tag. */
export const TRANSCRIPT_RECORD_MARKER = "\x1epidt ";
/** The MAC's domain string, so a record's MAC can never be another protocol's (the exit line's, the inbox ack's). */
export const TRANSCRIPT_DOMAIN = "pi-dispatch-transcript";
/**
 * The longest line mirrored: the worker's own `LIVE_LINE_MAX_BYTES` (live-transcript.mjs), held equal by a test, since a
 * line past it would be skipped there anyway and sending it would only cost the pipe 1.3 times its size.
 */
export const TRANSCRIPT_LINE_MAX_BYTES = 1024 * 1024;
/** How often the file is read. A quarter second: the worker publishes on its own half-second cadence. */
export const TRANSCRIPT_POLL_MS = 250;
/** The most bytes one read takes, so a burst is mirrored over several reads rather than in one allocation. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** The three record types: the baseline, a line, a reset. */
export const RECORD_BASELINE = "b";
export const RECORD_LINE = "l";
export const RECORD_RESET = "r";

/** The record's MAC: its seq, type and end, then the payload's raw bytes. */
export function transcriptRecordMac(key, runId, seq, type, end, payload) {
	return createHmac("sha256", key).update(`${TRANSCRIPT_DOMAIN}\0${runId}\0${seq}\0${type}\0${end}\0`, "utf8").update(payload).digest("hex");
}

/** One record, newline included. */
export function transcriptRecord(key, runId, seq, type, end, payload = Buffer.alloc(0)) {
	const bytes = Buffer.from(payload);
	return `${TRANSCRIPT_RECORD_MARKER}${seq} ${type} ${end} ${transcriptRecordMac(key, runId, seq, type, end, bytes)} ${bytes.toString("base64")}\n`;
}

/**
 * Whether the worker asked for the mirror, and whether it can run: `{ on, problem }`. `problem` is a fixed token for
 * the runner's log (`transcript_mirror_off`), never a value: `unknown-channel` (a value this runner does not know),
 * `no-exit-key` (asked, and no key to sign with), `no-session-file` (asked, and no file to mirror).
 */
export function transcriptMirrorWanted(env, { key = null } = {}) {
	// env-internal PI_TRANSCRIPT: written by the worker into the job's closed env map for an armed attempt only.
	const channel = env?.PI_TRANSCRIPT;
	if (channel === undefined || channel === "") return { on: false, problem: null };
	if (channel !== TRANSCRIPT_STDERR) return { on: false, problem: "unknown-channel" };
	if (typeof key !== "string" || key === "") return { on: false, problem: "no-exit-key" };
	// env-internal PI_SESSION_FILE: the worker's own per-job input; parseRunnerEnv validates it for pi.
	if (typeof env.PI_SESSION_FILE !== "string" || env.PI_SESSION_FILE === "") return { on: false, problem: "no-session-file" };
	return { on: true, problem: null };
}

/** How much of the first line is kept to notice an in-place rewrite: the worker's tail keeps the same. */
const FIRST_LINE_PROBE_BYTES = 4096;

/**
 * `createTranscriptMirror({ file, key, runId, write, fs, lineMaxBytes, pollMs, timers, log })` ->
 * `{ start(), drain(), stop(), stats() }`.
 *
 *   - `start()` writes the baseline record (the file's size now), then drains every `pollMs` on an unref'd timer.
 *   - `drain()` reads everything appended since the last read and writes one record per complete line. Synchronous,
 *     never throws. The runner calls it from the exit line's writer, so the last lines are out before the exit line is.
 *   - `stop()` ends the timer (a final `drain` is the caller's).
 *
 * The file is the agent's (the session directory is writable to the job), so it is read as the worker's tail reads it:
 * `lstat` first, anything but a regular file is refused for good (a FIFO would hang a read, a link would name another
 * file), then opened `O_NOFOLLOW | O_NONBLOCK` and the descriptor held to the inode `lstat` saw. Not to keep a secret
 * from the agent (it shares this uid), but so a swapped file cannot stall the runner or loop it. A rewrite is noticed
 * as the worker's tail notices one: a size below the offset, a new inode, or a first line whose bytes changed (pi
 * rewrites the file in place, on the same inode). The inode is recorded with the baseline, so a file swapped before
 * the first drain (session.mjs's quarantine of an unparseable resume file) is a reset to 0: its lines are this run's.
 * One drain reads at most what the file held when it began, so an agent appending without pause cannot keep the
 * event loop inside it, away from the SIGTERM handler and the exit line.
 */
export function createTranscriptMirror({
	file,
	key,
	runId,
	write = (text) => writeAllSync(2, text),
	fs = { closeSync, fstatSync, lstatSync, openSync, readSync },
	lineMaxBytes = TRANSCRIPT_LINE_MAX_BYTES,
	pollMs = TRANSCRIPT_POLL_MS,
	timers = { setInterval, clearInterval },
	log = () => {},
}) {
	let offset = 0; // the file position read up to
	let lineStart = 0; // where the line being assembled (`held`) starts
	let ino = null;
	let held = Buffer.alloc(0);
	let skipping = false; // inside an oversize line: its seq is taken, its bytes dropped until its newline
	let firstLine = null; // the first line's bytes (up to the probe), once a full one was read
	let seq = 0;
	let baseline = null; // the size at start, until its record is written
	let refused = false;
	let timer = null;
	let started = false;
	const counts = { records: 0, skipped: 0, resets: 0, errors: 0 };
	const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

	/** Write one record under the next seq; the seq is taken only once every byte is out. Throws on a failed write. */
	const emit = (type, end, payload) => {
		write(transcriptRecord(key, runId, seq + 1, type, end, payload));
		seq += 1;
		counts.records += 1;
	};
	const refuse = () => {
		refused = true;
		log("transcript_mirror_off", { problem: "not-a-regular-file" });
	};
	/** The file's size now, and its inode recorded: a file swapped before the first drain is then seen as one. */
	const sizeNow = () => {
		try {
			const info = fs.lstatSync(file);
			if (!info.isFile()) return 0;
			ino = info.ino;
			return info.size;
		} catch {
			return 0;
		}
	};
	/** The baseline record, once, before any line; a failed write is tried again at the next drain. */
	const announce = () => {
		if (baseline === null) return true;
		try {
			emit(RECORD_BASELINE, baseline, Buffer.alloc(0));
			baseline = null;
			return true;
		} catch {
			counts.errors += 1;
			return false;
		}
	};
	const restart = (size) => {
		emit(RECORD_RESET, size, Buffer.alloc(0));
		offset = 0;
		lineStart = 0;
		held = Buffer.alloc(0);
		skipping = false;
		firstLine = null;
		counts.resets += 1;
	};

	/** The bytes read at file position `base`, split into lines. A failed write rewinds to the start of its line. */
	const take = (chunk, base) => {
		let start = 0;
		for (;;) {
			const nl = chunk.indexOf(0x0a, start);
			if (nl === -1) break;
			const piece = chunk.subarray(start, nl);
			const end = base + nl + 1;
			start = nl + 1;
			if (skipping) {
				skipping = false;
				held = Buffer.alloc(0);
				lineStart = end;
				continue;
			}
			const line = held.length > 0 ? Buffer.concat([held, piece]) : piece;
			if (firstLine === null) firstLine = Buffer.from(line.subarray(0, FIRST_LINE_PROBE_BYTES));
			// An empty line is never sent, and takes no seq: the worker skips an empty line anyway.
			if (line.length > lineMaxBytes) {
				seq += 1;
				counts.skipped += 1;
			} else if (line.length > 0) {
				try {
					emit(RECORD_LINE, end, line);
				} catch (error) {
					offset = lineStart;
					held = Buffer.alloc(0);
					throw error;
				}
			}
			held = Buffer.alloc(0);
			lineStart = end;
		}
		const tail = chunk.subarray(start);
		if (skipping || tail.length === 0) return;
		if (held.length + tail.length > lineMaxBytes) {
			if (firstLine === null) firstLine = Buffer.from(Buffer.concat([held, tail]).subarray(0, FIRST_LINE_PROBE_BYTES));
			held = Buffer.alloc(0);
			skipping = true;
			seq += 1;
			counts.skipped += 1;
			return;
		}
		held = Buffer.concat([held, tail]);
	};

	const drain = () => {
		if (refused) return;
		if (!announce()) return;
		let fd = null;
		try {
			let info;
			try {
				info = fs.lstatSync(file);
			} catch {
				return; // not written yet: pi writes the file once the conversation has its first message
			}
			if (!info.isFile()) return refuse();
			// A new inode before anything was read is the file the baseline measured swapped for another (the runner's
			// quarantine of an unparseable resume file renames it and stages an empty one): reset to 0, so none of the new
			// file's lines, this run's own, is `prior` or a `replay`. After a read, the tail's rule: the size now.
			if (ino !== null && info.ino !== ino) restart(offset > 0 ? info.size : 0);
			else if (info.size < offset) restart(info.size);
			ino = info.ino;
			try {
				fd = fs.openSync(file, OPEN_FLAGS);
			} catch (err) {
				if (err?.code === "ELOOP") return refuse();
				throw err;
			}
			const opened = fs.fstatSync(fd);
			if (!opened.isFile() || opened.ino !== info.ino) return refuse();
			if (firstLine !== null && offset > 0) {
				const probe = Buffer.alloc(firstLine.length);
				const n = fs.readSync(fd, probe, 0, probe.length, 0);
				if (n < firstLine.length || !probe.equals(firstLine)) restart(fs.fstatSync(fd).size);
			}
			// Bounded by the size at this drain's start: an agent appending without pause must not keep the event loop
			// inside one drain, where neither SIGTERM's handler nor the exit line could ever run. The rest is the next drain's.
			const limit = fs.fstatSync(fd).size;
			for (;;) {
				const size = Math.min(fs.fstatSync(fd).size, limit);
				if (size <= offset) break;
				const want = Math.min(size - offset, READ_CHUNK_BYTES);
				const buf = Buffer.alloc(want);
				const n = fs.readSync(fd, buf, 0, want, offset);
				if (n <= 0) break;
				const base = offset;
				offset += n;
				take(buf.subarray(0, n), base);
			}
		} catch {
			counts.errors += 1;
		} finally {
			if (fd !== null) {
				try {
					fs.closeSync(fd);
				} catch {}
			}
		}
	};

	return {
		start() {
			if (started) return;
			started = true;
			baseline = sizeNow();
			announce();
			timer = timers.setInterval(drain, pollMs);
			timer?.unref?.();
		},
		drain,
		stop() {
			if (timer !== null) timers.clearInterval(timer);
			timer = null;
		},
		stats: () => ({ ...counts, seq, held: held.length, refused }),
	};
}
