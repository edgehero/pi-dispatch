import { createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { Socket } from "node:net";

/**
 * Issue #686: the stdin frame channel of a steered job on a venue that COPIES its files (INT-STEER-INBOX-CONTRACT's
 * second transport, INT-RUNNER-EXIT-CODE-PROTOCOL's `stdin-frames`, DES-STEER-VIA-READONLY-INBOX-MOUNT).
 *
 * A venue that uploads `/job` once (`openshell`) cannot show the runner an `/inbox` file written later, so the worker
 * keeps the main exec's stdin OPEN after the exit key and writes each message as a frame on it: a 4-byte big-endian
 * unsigned length, then exactly that many bytes of UTF-8 JSON, one object.
 *   - Frame 1 is the key, `{"t":"key","key":"<64 hex>"}`. The in-image supervisor and then the runner read EXACTLY its
 *     bytes, synchronously, before pi loads, so no tool exists while the key is in the pipe (#545's property).
 *   - Every later frame is one message, `{"t":"steer","seq","v","id","mode","source","content","mac"}`, where
 *     `mac = hex(HMAC-SHA256(key, "pi-dispatch-inbox-frame\0" + runId + "\0" + seq + "\0" + body))` and `body` is the
 *     exact JSON of the inbox file (`{"v","id","mode","source","content"}`, the worker's `steerFileJson`). The domain
 *     differs from the ack's and the input from the exit line's, so neither is ever a valid frame MAC.
 *
 * WHY A MAC: the agent runs as the runner's uid and the design assumes it can open the pipe for read and write through
 * another holder's `/proc/<pid>/fd/0`. A frame it plants has no valid MAC and is dropped. It CAN consume a frame, which
 * withdraws that message (no ack arrives, the worker reports it undelivered), and it can break the stream with a bogus
 * length, which ends steering for the attempt. That is weaker than the read-only mount, said so in the spec, and why a
 * venue that binds keeps the mount.
 *
 * The worker's encoder (worker/src/steer-framing.mjs) is restated there, not imported: the image cannot import the
 * worker. Both sides are held byte for byte by worker/test/steer-frames.test.mjs, the budget included.
 */

export const FRAME_DOMAIN = "pi-dispatch-inbox-frame";
/** The length prefix, in bytes. */
export const FRAME_PREFIX_BYTES = 4;
/**
 * The most bytes the worker ever writes over one attempt's stdin, every frame counted with its prefix, the key frame
 * included: the worker's STEER_STDIN_BUDGET_BYTES, pinned to this copy by a test. A declared length past what is left
 * of it is a length the worker could never have written, so it breaks the stream.
 */
export const STEER_STDIN_BUDGET_BYTES = 4 * 1024 * 1024 - 1024;
/** The largest message frame: the 16 KiB inbox file body plus the frame's own keys (`t`, `seq`, `mac`) with room. */
export const STEER_FRAME_MAX_BYTES = 16 * 1024 + 256;
/** The key frame is 84 bytes; anything longer is not one. */
export const KEY_FRAME_MAX_BYTES = 256;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const MAC_PATTERN = /^[0-9a-f]{64}$/;
const STEER_FRAME_KEYS = Object.freeze(["t", "seq", "v", "id", "mode", "source", "content", "mac"]);
/** The fixed tokens a broken stream is logged by (`steer_stream_broken {reason}`). */
export const BREAK_REASONS = Object.freeze(["length", "json", "shape"]);

/** The MAC one message frame carries. `seq` is written in decimal. */
export function frameMac(key, runId, seq, body) {
	return createHmac("sha256", key).update(`${FRAME_DOMAIN}\0${runId}\0${seq}\0${body}`, "utf8").digest("hex");
}

/** The inbox file body a frame's five message fields make, the exact bytes the worker's `steerFileJson` wrote. */
export function frameBody(frame) {
	return JSON.stringify({ v: frame.v, id: frame.id, mode: frame.mode, source: frame.source, content: frame.content });
}

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

/** `{ value }` for one frame's payload bytes, or `{ error: "json" }` for bytes that are not UTF-8 JSON. */
function parsePayload(bytes) {
	try {
		return { value: JSON.parse(fatalUtf8.decode(bytes)) };
	} catch {
		return { error: "json" };
	}
}

/** The key frame 1 carries, or null when the payload is anything but exactly `{"t":"key","key":"<64 hex>"}`. */
export function keyOfFrame(payload) {
	const parsed = parsePayload(payload);
	if (parsed.error) return null;
	const v = parsed.value;
	if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
	const keys = Object.keys(v);
	if (keys.length !== 2 || v.t !== "key" || typeof v.key !== "string" || !KEY_PATTERN.test(v.key)) return null;
	return v.key;
}

/**
 * Read EXACTLY frame 1 off `fd`, synchronously, and never a byte past it: `{ key, problem, bytes }`, where `bytes` is
 * every byte consumed (so the supervisor can hand the runner the same frame). `problem` is null, `malformed` (an early
 * EOF, a length that is not a key frame's, a payload that is not one) or `unreadable` (the read itself failed). A length
 * past KEY_FRAME_MAX_BYTES is not read further: what follows it is unknown, and the run goes on unsigned.
 */
export function readKeyFrame({ fd = 0, read = readSync, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
	const consumed = [];
	const exact = (n) => {
		const buf = Buffer.alloc(n);
		let off = 0;
		while (off < n) {
			let got;
			try {
				got = read(fd, buf, off, n - off, null);
			} catch (error) {
				if (error?.code === "EAGAIN") {
					sleep(10);
					continue;
				}
				if (error?.code === "EOF") break;
				throw error;
			}
			if (got === 0) break;
			off += got;
		}
		consumed.push(buf.subarray(0, off));
		return off === n ? buf : null;
	};
	const done = (key, problem) => ({ key, problem, bytes: Buffer.concat(consumed) });
	try {
		const prefix = exact(FRAME_PREFIX_BYTES);
		if (prefix === null) return done(null, "malformed");
		const length = prefix.readUInt32BE(0);
		if (length === 0 || length > KEY_FRAME_MAX_BYTES) return done(null, "malformed");
		const payload = exact(length);
		if (payload === null) return done(null, "malformed");
		const key = keyOfFrame(payload);
		return key === null ? done(null, "malformed") : done(key, null);
	} catch {
		return done(null, "unreadable");
	}
}

/**
 * The frame decoder for every frame after frame 1. `push(chunk)` takes bytes as they arrive (cut anywhere) and calls
 * `onFrame(frame)` for each frame that is well formed, VERIFIES under `key` and is above the last accepted `seq` with
 * an id `isSeen` does not know: `{ seq, id, body, frame }`, the body to be judged by the inbox's own refusals. `end()`
 * is EOF. Never throws.
 *
 *   - A BREAK ends reading for the attempt, once, by a fixed token (`onBreak(reason)`): `length` (zero, past the frame
 *     cap, past what is left of the budget, or a frame cut by EOF), `json` (not UTF-8 JSON), `shape` (an object that
 *     is neither shape, or a key frame after frame 1, which is never a re-key). Bytes after a break are dropped.
 *   - An UNVERIFIED frame is dropped and counted; reading goes on.
 *   - A verified frame at or below the last accepted `seq`, or with an id already seen, is a REPLAY: dropped, counted.
 */
export function createFrameDecoder({ key, runId, consumed = 0, budget = STEER_STDIN_BUDGET_BYTES, frameMax = STEER_FRAME_MAX_BYTES, isSeen = () => false, onFrame = () => {}, onBreak = () => {} } = {}) {
	let buffered = Buffer.alloc(0);
	let total = consumed;
	let lastSeq = 1;
	let broken = null;
	let ended = false;
	const counts = { accepted: 0, unverified: 0, replayed: 0 };

	const brk = (reason) => {
		if (broken !== null) return;
		broken = reason;
		buffered = Buffer.alloc(0);
		try {
			onBreak(reason);
		} catch {}
	};

	const judge = (payload) => {
		const parsed = parsePayload(payload);
		if (parsed.error) return brk("json");
		const f = parsed.value;
		if (f === null || typeof f !== "object" || Array.isArray(f)) return brk("shape");
		const keys = Object.keys(f);
		if (f.t !== "steer" || keys.length !== STEER_FRAME_KEYS.length || !STEER_FRAME_KEYS.every((k) => Object.hasOwn(f, k))) return brk("shape");
		if (!Number.isSafeInteger(f.seq) || f.seq < 2 || typeof f.mac !== "string" || !MAC_PATTERN.test(f.mac)) return brk("shape");
		const body = frameBody(f);
		const want = Buffer.from(frameMac(key, runId, f.seq, body), "hex");
		if (!timingSafeEqual(want, Buffer.from(f.mac, "hex"))) {
			counts.unverified += 1;
			return;
		}
		if (f.seq <= lastSeq || (typeof f.id === "string" && isSeen(f.id))) {
			counts.replayed += 1;
			return;
		}
		lastSeq = f.seq;
		counts.accepted += 1;
		try {
			onFrame({ seq: f.seq, id: f.id, body, frame: f });
		} catch {}
	};

	const drain = () => {
		while (broken === null && buffered.length >= FRAME_PREFIX_BYTES) {
			const length = buffered.readUInt32BE(0);
			if (length === 0 || length > frameMax || total + FRAME_PREFIX_BYTES + length > budget) return brk("length");
			if (buffered.length < FRAME_PREFIX_BYTES + length) return;
			const payload = buffered.subarray(FRAME_PREFIX_BYTES, FRAME_PREFIX_BYTES + length);
			buffered = buffered.subarray(FRAME_PREFIX_BYTES + length);
			total += FRAME_PREFIX_BYTES + length;
			judge(payload);
		}
	};

	return {
		push(chunk) {
			if (broken !== null || ended) return;
			try {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? "");
				buffered = buffered.length === 0 ? bytes : Buffer.concat([buffered, bytes]);
				drain();
			} catch {
				brk("length");
			}
		},
		/** EOF: no more messages. A frame the EOF cut is a `length` break: the worker never ends a pipe mid-frame. */
		end() {
			if (ended) return;
			ended = true;
			if (broken === null && buffered.length > 0) brk("length");
		},
		stats: () => ({ ...counts, broken, bytes: total }),
	};
}

/**
 * The descriptor the runner reads message frames on: 3, not its stdin. The in-image supervisor reads frame 1 off its own
 * stdin, hands those bytes to the runner on the runner's fd 0 and CLOSES it there (the key handoff of #545, unchanged in
 * shape), and forwards every later byte of its stdin, unchanged and in order, to the runner's fd 3.
 *
 * WHY NOT fd 0, as the contract first read. Every child the runner starts that inherits stdin (a spawn with
 * `stdio: "inherit"`, an extension's, a staged package's) would hold the frame stream on ITS fd 0 and could read, so
 * consume, a message before the runner does. pi's own bash tool spawns with `stdio: ["ignore", ...]` (/dev/null, at the
 * pin), but that is pi's choice, not this runner's guarantee, and Node has no dup2 to move a descriptor. The obvious
 * move, reopening `/proc/self/fd/0` on a new descriptor, fails: Node's "pipe" stdio is a socketpair, and opening a
 * socket's /proc link is ENXIO (measured in the image). MEASURED in the image's node instead (issue #686 lab): a
 * descriptor a Node parent hands its child as fd 3 is NOT inherited by that child's own children, with "inherit" or
 * "ignore" stdin alike, while an inherited fd 0 is. So the frames ride fd 3, and fd 0, at EOF once frame 1 is read, is
 * replaced by /dev/null (`isolateStdin`), so a child that inherits stdin inherits /dev/null.
 */
export const FRAME_FD = 3;

/**
 * Put /dev/null on fd 0 once frame 1 has been read from it, before any extension or tool exists: close it, then open
 * /dev/null, which the kernel gives the lowest free number, 0 (libuv clears CLOEXEC on an inherited stdio descriptor in
 * the child). `{ isolated, refuse, code? }`, `code` the failing step's.
 *
 * Review round 1, L5: only ONE failure fails open. A `close` that failed leaves fd 0 as it was, the supervisor's socket
 * at EOF after frame 1, never the frames: logged `steer_stdin_shared` and the run goes on. The other two leave fd 0 in a
 * state nothing vouches for, so a steered run REFUSES before pi loads (`refuse: true`; run-job then has no frame
 * channel, which assertSteerReady answers `steer-inbox-missing`): `/dev/null` would not open after fd 0 was closed (a
 * child that inherits stdin would get no descriptor, or whatever is opened next), or it opened elsewhere because
 * something took 0 first (`fd0-taken`: that something is what a child would inherit).
 */
export function isolateStdin({ open = openSync, close = closeSync } = {}) {
	try {
		close(0);
	} catch (error) {
		return { isolated: false, refuse: false, code: typeof error?.code === "string" ? error.code : "close" };
	}
	let nul;
	try {
		nul = open("/dev/null", "r");
	} catch (error) {
		return { isolated: false, refuse: true, code: typeof error?.code === "string" ? error.code : "devnull" };
	}
	if (nul !== 0) {
		try {
			close(nul);
		} catch {}
		return { isolated: false, refuse: true, code: "fd0-taken" };
	}
	return { isolated: true, refuse: false };
}

/**
 * Whether the frame descriptor is the supervisor's socket. Open is not enough (review round 1, L4): a node started
 * without the supervisor holds its own descriptors from 3 up (libuv's epoll fd, measured on a bare node), so a bare
 * runner would read its event loop's descriptor as the frame channel. The supervisor's fd 3 is a socketpair end.
 * Never throws.
 */
export function frameFdOpen({ fd = FRAME_FD, fstat = fstatSync } = {}) {
	try {
		return fstat(fd).isSocket() === true;
	} catch {
		return false;
	}
}

/**
 * The reader of the frame descriptor: `{ read(buf) -> bytes | null | 0, close() }`, `null` when nothing is waiting
 * (EAGAIN), `0` at EOF. SYNCHRONOUS and non-blocking, read by the inbox at its own moments (src/inbox.mjs `scan`: the
 * listen, every agent_start, turn_end and poll, the close), never by an event-loop callback.
 *
 * WHY NOT A STREAM. A `data` event needs an I/O turn of the event loop, and between the inbox's creation and pi's one
 * steering poll before the first model call there is none: under a cost cap of 0 the inbox closed 10 ms after it began
 * listening with the frame still unread in the socket (measured on Docker), so a message waiting since the spawn never
 * reached the run. A synchronous read at agent_start cannot miss it. The descriptor must not block, or a read with
 * nothing waiting would hang the runner: Node cannot fcntl, so a libuv pipe handle is opened on it with `manualStart`
 * (which sets O_NONBLOCK on the descriptor and never starts reading itself) and held, unref'd, until the close.
 */
export function openFrameReader(fd = FRAME_FD, { read = readSync, makeHandle = (n) => new Socket({ fd: n, readable: true, writable: false, manualStart: true }) } = {}) {
	const handle = makeHandle(fd);
	handle?.unref?.();
	let closed = false;
	return {
		read(buf) {
			if (closed) return 0;
			try {
				return read(fd, buf, 0, buf.length, null);
			} catch (error) {
				if (error?.code === "EAGAIN" || error?.code === "EWOULDBLOCK") return null;
				throw error;
			}
		},
		close() {
			if (closed) return;
			closed = true;
			try {
				handle?.destroy?.();
			} catch {}
		},
	};
}
