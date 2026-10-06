import { createHmac } from "node:crypto";
import { readSync, writeSync } from "node:fs";

/**
 * The runner's exit line, and the key that authenticates it (issue #545, INT-RUNNER-EXIT-CODE-PROTOCOL).
 *
 * The worker reads the job's outcome telemetry (tokens, usage, turns, session, context, and through them the dollar
 * settlement) off the LAST `{"event":"exit",...}` line on the container's stdout. That stream is not the runner's
 * alone: a job's own tool can write to it (a child opens `/proc/<pid>/fd/1` of the runner or of the init process,
 * measured on Docker Desktop, rootful Docker 29 and rootless Podman 4.9 and 5.8). No reader policy can tell the
 * runner's bytes from an imitation of them, so the line now carries a MAC the job's tools cannot compute.
 *
 * The key is per job, random, minted by the worker and handed over on the container's STDIN, which the runner reads
 * to EOF before anything else runs. Why stdin and not the other channels, each measured from a tool child in the
 * job's own container (the runner's uid, `--cap-drop=ALL`, `no-new-privileges`, `--init`):
 *   - an environment variable is readable from `/proc/1/environ` (the init process, which exec'd the runner with the
 *     same environment) on every venue, and from the runner's own `/proc/<pid>/environ`, which is fixed at exec, so
 *     deleting it from `process.env` hides nothing;
 *   - a file on a mount is readable by the same uid until it is gone, and `/job` is read-only, so the runner could
 *     not delete it;
 *   - stdin, once drained, reads as EOF from `/proc/1/fd/0` and from the runner's fd 0 alike: the bytes are consumed.
 * What remains is the runner's MEMORY (`/proc/<pid>/mem`), which held the key on Docker Desktop (no Yama) and on
 * Fedora (Yama `ptrace_scope` 0). The image closes that by running the runner under an EXEC-ONLY copy of node
 * (`/opt/pi-dispatch/runner-node`, mode 0711, root-owned): the kernel marks a process that exec'd a binary its user
 * cannot read as not dumpable, and a non-dumpable process's `/proc/<pid>/mem`, `environ` and `fd` are refused to the
 * same uid without CAP_SYS_PTRACE, which `--cap-drop=ALL` removes. Measured EACCES on all four venues.
 *
 * A MAC of the line rather than the bare key printed on it: the job's tools can open the container's stdout pipe for
 * READING (`/proc/1/fd/1`, measured on every venue), so a line carrying the key itself could be read off the pipe and
 * the key reused on a forged line. A stolen MAC'd line is only the genuine line again, and a line taken off the pipe
 * and never put back reads as missing, which settles at the floor.
 */

/** The variable that tells the runner a key is waiting on stdin. Its value is the channel's name, never a secret. */
export const EXIT_AUTH_ENV = "PI_EXIT_AUTH";
/** The one channel there is. Any other value is a worker the runner does not understand, said on the log. */
export const EXIT_AUTH_STDIN = "stdin";
/** The key's shape: 32 random bytes as lowercase hex, exactly what the worker writes. */
export const EXIT_KEY_PATTERN = /^[0-9a-f]{64}$/;
/** The exit code of a runner stopped by SIGTERM, the code a signal-killed node would have had (128 + 15). */
export const EXIT_TERMINATED = 143;
/** The suffix a signed exit line ends with, before the closing brace. */
const AUTH_KEY = '"auth":"';

/** HMAC-SHA256 of the line's unsigned bytes, keyed by the key's own 64 characters. */
export function exitLineMac(key, body) {
	return createHmac("sha256", key).update(body, "utf8").digest("hex");
}

/**
 * The signed form of one exit line: the unsigned JSON with `"auth":"<mac>"` as its LAST key. Last, so the worker
 * recovers the signed bytes by cutting a fixed-length suffix, with no second serialisation to agree on.
 */
export function signExitLine(body, key) {
	return `${body.slice(0, -1)},${AUTH_KEY}${exitLineMac(key, body)}"}`;
}

/**
 * Drain fd 0 to EOF and return what it held (at most `max` bytes kept; the rest is read and dropped, so nothing
 * stays in the pipe for a later reader). Synchronous, because it runs before anything else and a tool must not exist
 * while the key is still in the pipe. A non-blocking descriptor's EAGAIN is waited out in short sleeps.
 */
export function drainStdin({ fd = 0, max = 4096, read = readSync, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
	const kept = [];
	let size = 0;
	const buf = Buffer.alloc(1024);
	for (;;) {
		let n;
		try {
			n = read(fd, buf, 0, buf.length, null);
		} catch (error) {
			if (error?.code === "EAGAIN") {
				sleep(10);
				continue;
			}
			if (error?.code === "EOF") break;
			throw error;
		}
		if (n === 0) break;
		if (size < max) kept.push(Buffer.from(buf.subarray(0, Math.min(n, max - size))));
		size += n;
	}
	return Buffer.concat(kept).toString("utf8");
}

/**
 * The key this job's exit line is signed with: `{ key, problem }`. No `PI_EXIT_AUTH` means a worker that predates
 * the channel, or an image run by hand: no key, no problem, and the exit line is unsigned exactly as before. A worker
 * that asked for a key and did not deliver a usable one is a `problem` the runner logs, and the run goes on unsigned,
 * which the worker then settles at the floor: failing open on the telemetry, closed on the money, and said.
 */
export function readExitKey(env, { drain = drainStdin } = {}) {
	// env-internal PI_EXIT_AUTH: written by the worker into the job's closed env map (buildContainerEnv), never an operator key.
	const channel = env.PI_EXIT_AUTH;
	if (channel === undefined) return { key: null, problem: null };
	if (channel !== EXIT_AUTH_STDIN) return { key: null, problem: "unknown-channel" };
	let raw;
	try {
		raw = drain();
	} catch {
		return { key: null, problem: "unreadable" };
	}
	const key = raw.trim();
	return EXIT_KEY_PATTERN.test(key) ? { key, problem: null } : { key: null, problem: "malformed" };
}

/**
 * Write all of `text` to `fd` before returning (PR #555's review). The exit line is written right before the process
 * exits, and `process.stdout.write` followed at once by `process.exit` can lose the tail of a large write on a pipe:
 * stdout is asynchronous where libuv made the pipe non-blocking, and exit does not wait for it. A synchronous loop
 * owns every byte instead, waiting out a full pipe's EAGAIN in short sleeps.
 */
export function writeAllSync(fd, text, { write = writeSync, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
	const buf = Buffer.from(text, "utf8");
	let off = 0;
	while (off < buf.length) {
		try {
			off += write(fd, buf, off, buf.length - off);
		} catch (error) {
			if (error?.code !== "EAGAIN") throw error;
			sleep(1);
		}
	}
}

/**
 * The one writer of the exit line, and the SIGTERM path that uses it (issue #545).
 *
 * `writeExit(fields)` writes the line once and only once, signed when there is a key: a second call (a SIGTERM that
 * lands after the decided line, or the reverse) writes nothing, so the worker never sees two genuine lines with two
 * different codes. `terminate(fields)` is the SIGTERM handler's body: with no line written yet it writes one with
 * `code: 143`, `reason: "terminated"` and whatever the caller's fields say was spent, then exits 143, inside the
 * container's stop grace period; with a line already written it exits with THAT line's code, so the container's
 * exit code and the last line still agree. Before this the runner had no handler, so a `docker stop` killed it
 * mid-run and no genuine line followed whatever a tool had written.
 */
export function createExitWriter({ key = null, jobId, write, exit, resources = () => null }) {
	let written = false;
	// The code the process exits with once the line is out: the line's own, or 1 (the runner's catch-path default,
	// `outcome.code ?? EXIT_INFRA`) for a line that named none.
	let writtenCode = 1;
	function writeExit(fields) {
		if (written) return false;
		written = true;
		if (Number.isSafeInteger(fields?.code)) writtenCode = fields.code;
		// Issue #596: what the container used, read HERE, by the one writer every path goes through (the decided line, the
		// catch path and SIGTERM), and at the last moment before the line exists, so the peak and the CPU time cover
		// everything the job did before it. Last of the fields (before the signature), and omitted when nothing could be
		// read, so a line with nothing to say stays byte-identical to what every older worker already parses.
		let used = null;
		try {
			used = resources();
		} catch {
			used = null;
		}
		const body = JSON.stringify({ event: "exit", jobId, ...fields, ...(used !== null && typeof used === "object" ? { resources: used } : {}) });
		write(`\n${key ? signExitLine(body, key) : body}\n`);
		return true;
	}
	function terminate(fields = {}) {
		if (!written) writeExit({ code: EXIT_TERMINATED, reason: "terminated", ...fields });
		exit(writtenCode);
	}
	return { writeExit, terminate, written: () => written };
}
