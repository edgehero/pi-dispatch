import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The worker's half of the transcript records (issue #686, `DES-OPENSHELL-VENUE`, `INT-RUNNER-EXIT-CODE-PROTOCOL`'s
 * transcript records): splits a copying venue's CLI stderr into the runner's signed transcript records and everything
 * else, verifies each record under this attempt's exit key, and hands the verified ones, in order, to the live
 * transcript's stdio source (live-transcript.mjs `makeLiveTranscript({ source: "stdio" })`).
 *
 * The runner's half is image/runner/src/transcript-mirror.mjs, whose header states the format
 * (`\x1epidt <seq> <type> <end> <mac> <base64>\n`, types `b` baseline, `l` line, `r` reset). The MAC is restated here
 * (the worker cannot import the image at run time) and pinned to the runner's by a test, as the steer ack's is. A
 * verified record proves the CHANNEL (the runner's mirror wrote it, in this order), never the content: the session
 * file is the agent's to write, so a line has the trust of a line the file tail reads on a binding venue.
 *
 * WHY A STREAM DEMUX AND NOT A LINE SPLIT. OpenShell's `sandbox exec` forwards stderr in reads of up to 4 KiB that are
 * not line-aligned (measured, 0.1.4), so a record arrives cut anywhere, its marker included.
 *
 * THE PASS-THROUGH RULE. A record begins at the marker (RS, then `pidt `) wherever it appears, at a line start or after
 * a foreign write that left no newline (a progress bar's `\r50%`). A byte that is not part of a record is passed on as
 * soon as it is known not to be one, byte for byte. Only two things are held: the first bytes that still match the
 * marker (at most its 6), and a record while it still fits the record's grammar (digits, one type letter, digits, 64
 * hex, base64). The grammar is checked as the bytes arrive, so a record cut by another writer ends at the FIRST byte
 * that cannot belong to it: the record's bytes before that byte are dropped (counted, never written out), and that
 * byte and everything after it on the line are passed on as ordinary output. What that means, exactly:
 *   - a verified record, and a record's bytes before its break, never reach the job log;
 *   - a broken record's bytes AFTER its break byte do (a foreign `\r` mid-payload sends the rest of the base64 there);
 *   - a foreign write that lands inside a record and whose head fits the field being read (hex inside the MAC, base64
 *     inside the payload, digits inside a number) is taken into the record and lost with it, up to the first byte that
 *     does not fit; a newline where a record cannot end is taken as the broken record's own;
 *   - every other byte reaches the job log and the terminal unchanged.
 *
 * WHAT IS REFUSED, and counted, never published, never logged with its payload: a record that does not parse, one whose
 * MAC does not verify (a forgery from a tool writing to the container's stderr, or a record another process's write
 * broke), and one whose `seq` is not above the last accepted one (a replay). A gap in `seq` is allowed (the runner
 * skips a line past its bound, and a broken record leaves one) and counted; the stdio source shows it as `skipped`.
 */

export const TRANSCRIPT_RECORD_MARKER = "\x1epidt ";
const MARKER = Buffer.from(TRANSCRIPT_RECORD_MARKER, "latin1");
const TRANSCRIPT_DOMAIN = "pi-dispatch-transcript";
const TYPES = new Set(["b", "l", "r"]);

/**
 * The most payload bytes one record holds before it is given up on. A genuine record's payload is at most 4/3 of the
 * runner's longest mirrored line (`TRANSCRIPT_LINE_MAX_BYTES`, 1 MiB) as base64, about 1.4 MiB; 8 MiB is far above
 * that, so no genuine record meets it, and it bounds what a forged unterminated "record" can make this process hold.
 * Past it the record is still read to its end (its bytes dropped as they arrive, never held, never passed on) and
 * counted `oversize`.
 */
export const TRANSCRIPT_RECORD_MAX_BYTES = 8 * 1024 * 1024;

/** The runner's `transcriptRecordMac`, restated. */
export function transcriptRecordMac(key, runId, seq, type, end, payload) {
	return createHmac("sha256", key).update(`${TRANSCRIPT_DOMAIN}\0${runId}\0${seq}\0${type}\0${end}\0`, "utf8").update(payload).digest("hex");
}

const NUM_RE = /^(?:0|[1-9][0-9]{0,15})$/;
const MAC_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * One record's body (the bytes between the marker and the newline) verified: `{ seq, type, end, payload }` or null.
 * Constant-time on the MAC; numbers and base64 canonical, so one record has exactly one spelling. A baseline or a
 * reset carries no payload.
 */
export function verifyTranscriptRecord(body, { key, runId }) {
	if (typeof key !== "string" || key === "" || typeof runId !== "string" || runId === "") return null;
	const text = Buffer.isBuffer(body) ? body.toString("latin1") : String(body ?? "");
	const parts = text.split(" ");
	if (parts.length !== 5) return null;
	const [seqText, type, endText, mac, b64] = parts;
	if (!NUM_RE.test(seqText) || seqText === "0" || !TYPES.has(type) || !NUM_RE.test(endText) || !MAC_RE.test(mac) || !B64_RE.test(b64)) return null;
	const seq = Number(seqText);
	const end = Number(endText);
	if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(end)) return null;
	const payload = Buffer.from(b64, "base64");
	// Canonical only: base64 has spellings that differ in their unused trailing bits and decode to the same bytes.
	if (payload.toString("base64") !== b64) return null;
	if (type !== "l" && payload.length > 0) return null;
	if (!timingSafeEqual(Buffer.from(transcriptRecordMac(key, runId, seqText, type, endText, payload), "hex"), Buffer.from(mac, "hex"))) return null;
	return { seq, type, end, payload };
}

const isDigit = (c) => c >= 0x30 && c <= 0x39;
const isHex = (c) => isDigit(c) || (c >= 0x61 && c <= 0x66);
const isB64 = (c) => isDigit(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2b || c === 0x2f || c === 0x3d;
const isType = (c) => c === 0x62 || c === 0x6c || c === 0x72;
// Each field before the payload: the bytes it admits and its longest length. Field 4, the payload, is base64 to the newline.
const FIELDS = [
	{ ok: isDigit, max: 16 },
	{ ok: isType, max: 1 },
	{ ok: isDigit, max: 16 },
	{ ok: isHex, max: 64 },
];

/**
 * `makeStderrTranscript({ key, runId, onLine, onBaseline, onReset, onGap, maxRecordBytes })` ->
 * `{ push(chunk), end(), stats() }`.
 *
 *   - `push(chunk)` takes one stderr chunk and returns the bytes to pass on (a Buffer, possibly empty), in order. The
 *     verified records it completed are handed out before it returns: `onBaseline(size)`, `onLine(lineBytes, end)`,
 *     `onReset(size)`, and `onGap(missing)` first when `seq` jumped. A throw from `push` (none is known) leaves the
 *     state as it was before the call, so the caller can `end()` and pass the chunk on itself without a byte twice.
 *   - `end()` returns what is still held and is not a record (the head of a line that matched the marker's first
 *     bytes), so nothing the CLI wrote is lost at close. An unterminated record is dropped and counted.
 *   - `stats()`: `{ records, unverified, replayed, gaps, oversize }`.
 *
 * Every callback is guarded: a throw in one costs that record only, never the demux or the bytes passed on.
 */
export function makeStderrTranscript({ key, runId, onLine = () => {}, onBaseline = () => {}, onReset = () => {}, onGap = () => {}, maxRecordBytes = TRANSCRIPT_RECORD_MAX_BYTES } = {}) {
	// `start`: at a line start, `probe` holding the bytes so far that match the marker's head. `pass`: inside a line that
	// is not a record, passed through to its newline. `record`: inside a record, in field `field` (0 to 4).
	let mode = "start";
	let probe = Buffer.alloc(0);
	let parts = [];
	let field = 0;
	let fieldLen = 0;
	let held = 0;
	let discarding = false; // a payload past the bound: read to its end, never held
	let last = 0;
	const counts = { records: 0, unverified: 0, replayed: 0, gaps: 0, oversize: 0 };
	const call = (fn, ...args) => {
		try {
			fn(...args);
		} catch {}
	};

	const settle = (body) => {
		const verified = verifyTranscriptRecord(body, { key, runId });
		if (verified === null) {
			counts.unverified += 1;
			return;
		}
		if (verified.seq <= last) {
			counts.replayed += 1;
			return;
		}
		if (verified.seq > last + 1) {
			// `seq` 1 is always the baseline: when it is the one lost, no LINE is missing for it.
			const missing = verified.seq - last - 1 - (last === 0 ? 1 : 0);
			if (missing > 0) {
				counts.gaps += missing;
				call(onGap, missing);
			}
		}
		last = verified.seq;
		counts.records += 1;
		if (verified.type === "b") call(onBaseline, verified.end);
		else if (verified.type === "r") call(onReset, verified.end);
		else if (verified.payload.length > 0) call(onLine, verified.payload, verified.end);
	};

	const openRecord = () => {
		mode = "record";
		probe = Buffer.alloc(0);
		parts = [];
		field = 0;
		fieldLen = 0;
		held = 0;
		discarding = false;
	};
	/** The record ended before its grammar did: its bytes are dropped and counted, never passed on. */
	const breakRecord = () => {
		counts.unverified += 1;
		parts = [];
		held = 0;
	};

	const step = (buf) => {
		const out = [];
		let i = 0;
		try {
			while (i < buf.length) {
				if (mode === "pass") {
					// To the line's end, or to the next RS, whichever is first: a record can follow a foreign write that left
					// no newline (a progress bar's `\r50%`), and must still be read as one. An RS that does not begin the
					// marker (`\x1e{` of an RS-delimited JSON stream) is passed on by the probe below, unchanged.
					const nl = buf.indexOf(0x0a, i);
					const rs = buf.indexOf(0x1e, i);
					if (rs !== -1 && (nl === -1 || rs < nl)) {
						if (rs > i) out.push(buf.subarray(i, rs));
						i = rs;
						mode = "start";
						continue;
					}
					if (nl === -1) {
						out.push(buf.subarray(i));
						i = buf.length;
					} else {
						out.push(buf.subarray(i, nl + 1));
						i = nl + 1;
						mode = "start";
					}
					continue;
				}
				if (mode === "start") {
					const take = buf.subarray(i, i + (MARKER.length - probe.length));
					const candidate = probe.length > 0 ? Buffer.concat([probe, take]) : take;
					if (MARKER.subarray(0, candidate.length).equals(candidate)) {
						i += take.length;
						if (candidate.length === MARKER.length) openRecord();
						else probe = Buffer.from(candidate);
						continue;
					}
					// Not a record: what was held goes out first, then this line from `i` on, newline included. The marker
					// holds no newline, so the held head never does either, and the line's own newline is found in `pass`.
					// An RS that failed the probe is passed on here, so `pass` never stops at the same byte twice.
					if (probe.length > 0) out.push(probe);
					else if (buf[i] === 0x1e) {
						out.push(buf.subarray(i, i + 1));
						i += 1;
					}
					probe = Buffer.alloc(0);
					mode = "pass";
					continue;
				}
				// mode === "record"
				if (field < 4) {
					const c = buf[i];
					const spec = FIELDS[field];
					if (c === 0x20 && fieldLen > 0 && (field !== 3 || fieldLen === 64)) {
						parts.push(buf.subarray(i, i + 1));
						held += 1;
						field += 1;
						fieldLen = 0;
						i += 1;
						continue;
					}
					if (spec.ok(c) && fieldLen < spec.max) {
						parts.push(buf.subarray(i, i + 1));
						held += 1;
						fieldLen += 1;
						i += 1;
						continue;
					}
					breakRecord();
					if (c === 0x0a) {
						i += 1;
						mode = "start";
					} else {
						mode = "pass";
					}
					continue;
				}
				// The payload: base64 up to the newline, scanned in one run.
				let j = i;
				while (j < buf.length && isB64(buf[j])) j += 1;
				if (j > i) {
					if (!discarding && held + (j - i) > maxRecordBytes) {
						discarding = true;
						parts = [];
						held = 0;
					}
					if (!discarding) {
						parts.push(buf.subarray(i, j));
						held += j - i;
					}
					i = j;
					continue;
				}
				if (buf[i] === 0x0a) {
					i += 1;
					mode = "start";
					if (discarding) {
						counts.oversize += 1;
						discarding = false;
						parts = [];
						held = 0;
						continue;
					}
					const body = Buffer.concat(parts);
					parts = [];
					held = 0;
					settle(body);
					continue;
				}
				// A byte no record holds: the record was broken there. Dropped, and this byte on is ordinary output.
				if (discarding) {
					counts.oversize += 1;
					discarding = false;
					parts = [];
					held = 0;
				} else {
					breakRecord();
				}
				mode = "pass";
			}
		} catch (cause) {
			// None is known. What this chunk already passed on, and the part not yet read, ride the error, so the caller
			// can send exactly those (and `end()`'s held bytes between them): no byte twice, and no completed record's.
			throw Object.assign(new Error("stderr transcript demux fault", { cause }), { passed: Buffer.concat(out), rest: buf.subarray(i) });
		}
		return out.length === 0 ? Buffer.alloc(0) : out.length === 1 ? Buffer.from(out[0]) : Buffer.concat(out);
	};

	return {
		push(chunk) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""), "utf8");
			// Copies, because `parts` holds views into the chunk: the caller may reuse its buffer.
			return step(Buffer.from(buf));
		},
		end() {
			let out = Buffer.alloc(0);
			if (mode === "start" && probe.length > 0) out = probe;
			if (mode === "record") {
				if (discarding) counts.oversize += 1;
				else counts.unverified += 1;
			}
			mode = "start";
			probe = Buffer.alloc(0);
			parts = [];
			held = 0;
			discarding = false;
			return out;
		},
		stats: () => ({ ...counts }),
	};
}
