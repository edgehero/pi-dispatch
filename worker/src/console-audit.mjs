/**
 * The operator console's audit log (issue #640; INT-CONSOLE-AUDIT-LOG). One JSON row per line in
 * `PI_LOGS_DIR/console-audit/YYYY-MM.jsonl` (the UTC month of the row's `at`), directory 0700, files 0600, appended with
 * O_APPEND. A worker subpath (`@edgehero/pi-dispatch/console-audit`) and not an admin module, because doctor verifies the
 * chain and the worker cannot import the admin.
 *
 * TAMPER-EVIDENT, NOT TAMPER-PROOF. Every row carries `seq` (one more than the row before it) and `prev` (sha256 hex of
 * the previous row's raw line, without its newline; `null` only for the very first row ever written). Changing,
 * removing or moving a row breaks the link of the row AFTER it, which `verifyConsoleAudit` names. Named residuals: the
 * account that runs the console can rewrite the whole chain from any row on (nothing here is signed by a key it does not
 * hold), and a change to the LAST row has no successor to break, so it shows only once the next row is written.
 *
 * The head is recovered from the newest month file on EVERY append, not cached after the first: `pi-dispatch-console
 * token add` (a separate process) appends to the same chain while `serve` runs, and a cached head in `serve` would then
 * fork the chain at its next row. The tail read is bounded (`TAIL_BYTES`), so a flood of refusals costs a constant read
 * per row, not one that grows with the file. The head read and the write happen under a short append lock
 * (`APPEND_LOCK`, created exclusively with a token of its own, removed in `finally` only while it still holds that token), so `serve` and a CLI command appending at once take turns
 * instead of both writing a row with the same `seq` and `prev`. A lock whose holder pid is dead is taken over; a lock
 * still held after `LOCK_WAIT_MS` makes the append throw, which refuses the write (see `withAppendLock`).
 *
 * A row is mirrored to Valkey (`console:audit`, LPUSH then LTRIM, the `alloc:log` precedent in `allocation.mjs`) as a
 * VIEW: the file is the record, and a mirror that fails loses nothing the file does not hold.
 */
import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { escapeControls } from "./projects.mjs";

export const CONSOLE_AUDIT_DIR = "console-audit";
export const CONSOLE_AUDIT_KEY = "console:audit";
export const CONSOLE_AUDIT_ACTIONS = Object.freeze(["login", "login-failed", "login-code", "logout", "refused", "write", "token-added", "token-revoked", "token-rotated", "sessions-ended", "serve-started"]);
export const CONSOLE_AUDIT_OUTCOMES = Object.freeze(["ok", "refused", "failed"]);
// A string field's cap, in code points, AFTER its controls are written out: a row stays small enough for the bounded tail
// read below whatever a caller hands in (a Host header, a refusal reason), and no field can bury the others.
export const CONSOLE_AUDIT_FIELD_MAX = 200;
// Only names of this shape are the log's: the reaper and the verifier never touch or read anything else an operator put
// in the directory.
const MONTH_FILE_RE = /^\d{4}-\d{2}\.jsonl$/;
// The bounded read of a file's end, for its last line. A row is at most ten capped fields of 200 code points (4 bytes
// each in UTF-8 at worst) plus its keys, far under this.
const TAIL_BYTES = 65536;
// The append lock, beside the month files (the reaper and the verifier only look at month-file names).
export const APPEND_LOCK = ".append.lock";
const LOCK_WAIT_MS = 2000;
const LOCK_PAUSE = new Int32Array(new SharedArrayBuffer(4));

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

/**
 * Hold `dir`'s append lock while `fn` runs. Sync, like the append it guards; waits in short sleeps, never spins hot.
 *
 * The lock file holds its holder's pid and a random token (`<pid> <hex>`), and a lock is STALE only when that pid is dead
 * (`alive`, the same rule as the console's single-instance lock). Never by age: an age is the filesystem's mtime against
 * this process's clock, two clocks, and a skew between them (or the clock-shifted CI run) would make every live lock look
 * stale and let two writers in at once, which is the fork this lock exists to prevent. The audit directory is local to
 * the host whose console writes it, so a pid names a process here. A lock still held, or still empty (a writer between
 * its create and its pid), after `LOCK_WAIT_MS` makes the append throw, which refuses the write it was recording.
 *
 * The token is what makes a removal safe. Two writers can both judge the same dead lock: the first removes it and
 * creates its own, and a second that removed by path would then remove that FRESH lock and both would append with the
 * same `seq` and `prev`. So a takeover re-reads the lock just before it removes it and removes it only while it still
 * holds exactly the stale text that was judged dead, and the `finally` removes the lock only while it still holds this
 * writer's own token. Named residual: the window between that re-read and the unlink (no portable compare-and-unlink
 * exists on a path), in which a writer that judged the same dead lock can create its fresh one and lose it to this
 * unlink. Two takers have to read the same dead text and interleave inside that window, after a holder crashed.
 */
function withAppendLock(dir, fs, fn, alive) {
	const lock = join(dir, APPEND_LOCK);
	const token = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
	const readLock = () => {
		try {
			return fs.readFileSync(lock, "utf8");
		} catch (err) {
			if (err?.code === "ENOENT") return null;
			throw err;
		}
	};
	const started = Date.now();
	for (;;) {
		try {
			fs.writeFileSync(lock, token, { flag: "wx", mode: 0o600 });
			break;
		} catch (err) {
			if (err?.code !== "EEXIST") throw err;
		}
		const stale = readLock();
		if (stale === null) continue;
		const holder = Number.parseInt(stale, 10);
		if (Number.isSafeInteger(holder) && holder > 0 && !alive(holder)) {
			// Only the text judged dead goes: another writer may have taken it over since, and its fresh lock is live.
			if (readLock() === stale) {
				try {
					fs.unlinkSync(lock);
				} catch (err) {
					if (err?.code !== "ENOENT") throw err;
				}
			}
			continue;
		}
		if (Date.now() - started > LOCK_WAIT_MS) {
			throw Object.assign(new Error(`the console audit log is locked by another writer (${lock}${Number.isSafeInteger(holder) ? `, pid ${holder}` : ""}); try again, or remove the file if no console command is running`), { code: "EAUDITLOCKED" });
		}
		Atomics.wait(LOCK_PAUSE, 0, 0, 10);
	}
	try {
		return fn();
	} finally {
		try {
			// A lock that no longer holds our token was taken over (we were judged dead, or removed by hand): not ours.
			if (readLock() === token) fs.unlinkSync(lock);
		} catch {
			// Already gone or unreadable: nothing of ours to remove.
		}
	}
}

function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * A string field as it is stored: controls and the other characters that change what a reader SEES written out as
 * `\u{XXXX}` (the worker's `escapeControls`, the same class the admin panel scrubs), then capped. Written out, not
 * deleted: an audit row that silently lost a character would hide exactly what a forged Host header tried to smuggle.
 */
function auditString(value, field) {
	if (typeof value !== "string") throw new Error(`console audit row: ${field} must be a string`);
	const text = escapeControls(value);
	const points = [...text];
	return points.length > CONSOLE_AUDIT_FIELD_MAX ? points.slice(0, CONSOLE_AUDIT_FIELD_MAX).join("") : text;
}

/** The row as stored, from a caller's input, or a throw naming the field that is wrong (the caller refuses its write). */
function auditRowBody(input) {
	if (input === null || typeof input !== "object") throw new Error("console audit row must be an object");
	const { actor, action, outcome } = input;
	if (!CONSOLE_AUDIT_ACTIONS.includes(action)) throw new Error(`console audit row: unknown action ${JSON.stringify(escapeControls(String(action)))} (one of ${CONSOLE_AUDIT_ACTIONS.join(", ")})`);
	if (!CONSOLE_AUDIT_OUTCOMES.includes(outcome)) throw new Error(`console audit row: unknown outcome ${JSON.stringify(escapeControls(String(outcome)))} (one of ${CONSOLE_AUDIT_OUTCOMES.join(", ")})`);
	if (actor === null || typeof actor !== "object") throw new Error("console audit row: actor must be an object with name, role and session");
	const body = {
		actor: {
			name: auditString(actor.name, "actor.name"),
			role: auditString(actor.role, "actor.role"),
			session: actor.session === null || actor.session === undefined ? null : auditString(actor.session, "actor.session"),
		},
		action,
	};
	const optional = (field) => (input[field] === undefined || input[field] === null ? {} : { [field]: auditString(input[field], field) });
	// In reading order: who, did what, to what, how it went, why, then the digests and the ticket that tie it to a change.
	return { ...body, ...optional("target"), outcome, ...optional("reason"), ...optional("beforeDigest"), ...optional("afterDigest"), ...optional("ticket") };
}

/** The `YYYY-MM.jsonl` names in `dir`, oldest first; [] when the directory does not exist. Other errors throw. */
function monthFiles(dir, fs) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (err) {
		if (err?.code === "ENOENT") return [];
		throw err;
	}
	return names.filter((n) => MONTH_FILE_RE.test(n)).sort();
}

/** The last non-empty line of a file, read from its end, or null for an empty file. */
function lastLine(path, fs) {
	const fd = fs.openSync(path, "r");
	try {
		const size = fs.fstatSync(fd).size;
		const length = Math.min(size, TAIL_BYTES);
		const buf = Buffer.alloc(length);
		let got = 0;
		while (got < length) {
			const n = fs.readSync(fd, buf, got, length - got, size - length + got);
			if (n === 0) break;
			got += n;
		}
		const lines = buf.subarray(0, got).toString("utf8").split("\n").filter((l) => l !== "");
		if (lines.length === 0) return null;
		// A tail read that started mid-file and holds one partial line cannot vouch for it: refuse rather than chain a
		// fragment.
		if (lines.length === 1 && size > length) throw new Error(`the console audit file ${path} ends in a line longer than ${TAIL_BYTES} bytes; run \`pi-dispatch-console audit verify\``);
		return lines[lines.length - 1];
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * The chain's head on disk: `{ seq, hash, month }`, seq 0 and hash null when no row exists. Read from the newest month
 * file's last line, so a row in a new month links to the old month's last. A newest file that exists but is empty is
 * skipped for the one before it (a crash between create and write leaves one).
 */
function readHead(dir, fs) {
	const files = monthFiles(dir, fs);
	for (let i = files.length - 1; i >= 0; i--) {
		const line = lastLine(join(dir, files[i]), fs);
		if (line === null) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			row = null;
		}
		if (row === null || typeof row !== "object" || !Number.isInteger(row.seq) || row.seq < 1) {
			throw new Error(`the last line of the console audit file ${join(dir, files[i])} is not an audit row, so the next row cannot link to it; run \`pi-dispatch-console audit verify\` and move the damaged file aside`);
		}
		return { seq: row.seq, hash: sha256(line), month: files[i].slice(0, 7) };
	}
	return { seq: 0, hash: null, month: null };
}

/** Refuse a directory or file that is a symlink: the console's own account writes here, and a link would aim it elsewhere. */
function refuseLink(path, fs, what) {
	let st;
	try {
		st = fs.lstatSync(path);
	} catch (err) {
		if (err?.code === "ENOENT") return;
		throw err;
	}
	if (st.isSymbolicLink()) throw new Error(`the console audit ${what} ${path} is a symlink; replace it with a real ${what} owned by this account`);
}

/**
 * The audit writer. `append(row)` is SYNC and THROWS on any failure (a bad row, a full disk, a damaged head): the caller
 * refuses the write it was about to make, because a change the record does not hold is the outcome this log exists to
 * prevent. Returns the stored row. `head()` is the chain's head on disk, `{ seq, hash }`.
 */
export function makeConsoleAudit({ logsDir, fs = nodeFs, now = () => Date.now(), alive = processAlive }) {
	const dir = join(logsDir, CONSOLE_AUDIT_DIR);
	return {
		dir,
		append(input) {
			const body = auditRowBody(input);
			refuseLink(dir, fs, "directory");
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			return withAppendLock(dir, fs, () => {
				const head = readHead(dir, fs);
				const at = new Date(now()).toISOString();
				// A clock that stepped back across a month boundary still appends to the NEWEST file: the chain is read file by
				// file in name order, and a row written into an older file would sit before rows it follows.
				const month = head.month !== null && head.month > at.slice(0, 7) ? head.month : at.slice(0, 7);
				const row = { at, seq: head.seq + 1, prev: head.hash, ...body };
				const path = join(dir, `${month}.jsonl`);
				refuseLink(path, fs, "file");
				fs.appendFileSync(path, `${JSON.stringify(row)}\n`, { flag: "a", mode: 0o600 });
				return row;
			}, alive);
		},
		head() {
			const { seq, hash } = readHead(dir, fs);
			return { seq, hash };
		},
	};
}

/**
 * Walk the chain, oldest file first: `{ ok: true, rows, startsAt }` or `{ ok: false, rows, broken: { file, line, reason } }`
 * with the FIRST broken link (`line` is 1-based within `file`; `rows` counts the rows read before it). The oldest
 * surviving row's `prev` cannot be checked once the reaper took the file before it, so it is not: a chain that starts
 * there is reported as `startsAt: { file, seq }`, not as broken. `startsAt` is null when the chain starts at its very
 * first row (seq 1, prev null). Never throws: an unreadable directory or file is the broken link.
 */
export function verifyConsoleAudit({ logsDir, fs = nodeFs }) {
	const dir = join(logsDir, CONSOLE_AUDIT_DIR);
	let files;
	try {
		files = monthFiles(dir, fs);
	} catch (err) {
		return { ok: false, rows: 0, broken: { file: null, line: 0, reason: `the audit directory ${dir} cannot be read (${err?.code ?? "error"})` } };
	}
	let rows = 0;
	let prior = null; // { seq, hash } of the last good row
	let startsAt = null;
	for (const file of files) {
		let i = -1;
		try {
			for (const line of fileLines(fs, join(dir, file))) {
				i += 1;
				const broken = (reason) => ({ ok: false, rows, broken: { file, line: i + 1, reason } });
				let row;
				try {
					row = JSON.parse(line);
				} catch {
					return broken("the line is not a JSON row (damaged, or written by something else)");
				}
				if (row === null || typeof row !== "object" || Array.isArray(row) || !Number.isInteger(row.seq) || row.seq < 1 || !(row.prev === null || (typeof row.prev === "string" && /^[0-9a-f]{64}$/.test(row.prev)))) {
					return broken("the row has no valid seq and prev");
				}
				if (!CONSOLE_AUDIT_ACTIONS.includes(row.action) || !CONSOLE_AUDIT_OUTCOMES.includes(row.outcome)) {
					return broken("the row's action or outcome is not one the console writes");
				}
				if (prior === null) {
					if (row.prev === null) {
						if (row.seq !== 1) return broken(`the first row has no prev but seq ${row.seq}; the chain's start was changed`);
					} else {
						// The rows before it were reaped (retention), or removed: the two look alike, so the start is reported.
						startsAt = { file, seq: row.seq };
					}
				} else {
					if (row.prev !== prior.hash) return broken(`prev does not match the row before it (seq ${prior.seq}): a row was changed, removed or moved`);
					if (row.seq !== prior.seq + 1) return broken(`seq ${row.seq} follows seq ${prior.seq}`);
				}
				prior = { seq: row.seq, hash: sha256(line) };
				rows += 1;
			}
		} catch (err) {
			return { ok: false, rows, broken: { file, line: i + 1, reason: `the file cannot be read (${err?.code ?? "error"})` } };
		}
	}
	return { ok: true, rows, startsAt };
}

/**
 * The lines of `path`, read a chunk at a time, never the whole file at once: a month file can grow past what one
 * string holds (V8's limit is about 512 MiB), and verify must still walk it rather than call it broken. A line is cut
 * at the newline BYTE, so a multi-byte character split across two chunks is decoded whole. The newline after the last
 * row ends nothing; a file cut mid-row yields its fragment as a last line, which the caller judges.
 */
function* fileLines(fs, path, chunkBytes = 1 << 20) {
	const fd = fs.openSync(path, "r");
	try {
		const buf = Buffer.alloc(chunkBytes);
		let carry = [];
		for (;;) {
			const n = fs.readSync(fd, buf, 0, chunkBytes, null);
			if (n === 0) break;
			let start = 0;
			for (let at = buf.indexOf(10, 0); at !== -1 && at < n; at = buf.indexOf(10, at + 1)) {
				carry.push(Buffer.from(buf.subarray(start, at)));
				yield Buffer.concat(carry).toString("utf8");
				carry = [];
				start = at + 1;
			}
			if (start < n) carry.push(Buffer.from(buf.subarray(start, n)));
		}
		if (carry.length > 0) yield Buffer.concat(carry).toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * The reaper of the audit files, on `PI_LOG_RETENTION_DAYS` like the run history (a sibling of
 * `makeAllocationLogReaper`): a `YYYY-MM.jsonl` file whose last write (mtime) is older than the retention goes, 0 keeps
 * everything, nothing of another name is touched. The NEWEST file is never reaped, however old: it holds the chain's
 * head, and without it the next row would start a new chain at seq 1 that `verifyConsoleAudit` cannot tell from a
 * forged one. Never throws.
 */
export function makeConsoleAuditReaper({ logsDir, retentionDays, fs = nodeFs, log = () => {}, now = () => Date.now() }) {
	const dir = join(logsDir, CONSOLE_AUDIT_DIR);
	return function reapConsoleAudit() {
		if (retentionDays === 0) return;
		let names;
		try {
			names = monthFiles(dir, fs);
		} catch (err) {
			log("console_audit_reaper_skipped", { reason: err?.code ?? "error" });
			return;
		}
		const cutoff = now() - retentionDays * 86400000;
		for (const name of names.slice(0, -1)) {
			try {
				const st = fs.lstatSync(join(dir, name));
				if (st.isFile() && st.mtimeMs < cutoff) {
					fs.unlinkSync(join(dir, name));
					log("reaped_console_audit", { file: name });
				}
			} catch (err) {
				log("console_audit_reaper_skipped", { file: name, reason: err?.code ?? "error" });
			}
		}
	};
}

/**
 * Best effort: the row onto `console:audit` (LPUSH, then LTRIM to `max`), for a screen that lists recent rows without
 * reading files. Resolves true when both landed, false otherwise; never throws, and logs nothing (the caller has the
 * row and knows the file holds it).
 */
export async function mirrorRow(redis, row, max = 500) {
	try {
		await redis.lpush(CONSOLE_AUDIT_KEY, JSON.stringify(row));
		await redis.ltrim(CONSOLE_AUDIT_KEY, 0, max - 1);
		return true;
	} catch {
		return false;
	}
}
