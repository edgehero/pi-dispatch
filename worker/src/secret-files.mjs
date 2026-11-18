import * as nodeFs from "node:fs";
import * as nodeFsp from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { secretFileNameAllowed, secretFileNamesDistinct } from "./secret-file-names.mjs";
import { JOB_DIR_RE } from "./run-checkpoint.mjs";
import { checkSecretFileSources } from "./secret-files-placement.mjs";

/** The owner record is outside the only subtree mounted into the job. */
export const SECRET_FILES_DIR_SUFFIX = ".secret-files";
export const SECRET_FILES_SUBDIR = "secrets";
export const SECRET_FILES_OWNER = "owner.json";
const BACKENDS = new Set(["local", "podman", "openshell", "openshell-bind"]);
const MAX_VALUE_BYTES = 64 * 1024;
const OWNER_MAX_BYTES = 4096;
const codeOf = (error) => typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "internal";
const say = (log, event, fields) => { try { log(event, fields); } catch {} };

/**
 * A live PID alone is not an identity: an old owner's PID can be reused before the next boot. Linux provides the
 * process's start ticks; macOS provides its start instant through ps. A platform or permission failure falls back to
 * liveness alone, conservatively retaining a directory until the PID is dead. No argv, environment or process text
 * is returned or logged. The seams let the sweep's tests model both PID reuse and a lookup nobody could finish.
 */
export function secretFileProcessIdentity(pid, { kill = process.kill, read = nodeFs.readFileSync, exec = execFileSync, platform = process.platform } = {}) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return { alive: null, start: null };
	try { kill(pid, 0); }
	catch (error) { return { alive: error?.code === "ESRCH" ? false : null, start: null }; }
	try {
		if (platform === "linux") {
			const raw = String(read(`/proc/${pid}/stat`, "utf8"));
			const close = raw.lastIndexOf(")");
			const ticks = close < 0 ? null : raw.slice(close + 2).split(/\s+/)[19];
			const boot = String(read("/proc/sys/kernel/random/boot_id", "utf8")).trim();
			if (/^\d{1,24}$/.test(ticks ?? "") && /^[0-9a-f-]{36}$/.test(boot)) return { alive: true, start: `linux:${boot}:${ticks}` };
		} else if (platform === "darwin") {
			const start = String(exec("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2000, maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, TZ: "UTC", LC_ALL: "C" } })).trim();
			if (/^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(start)) return { alive: true, start: `darwin:${start}` };
		}
	} catch {}
	return { alive: true, start: null };
}

let ownIdentity;
function ownerOfThisProcess() {
	if (!ownIdentity) ownIdentity = { pid: process.pid, start: secretFileProcessIdentity(process.pid).start };
	return ownIdentity;
}
const shapedOwner = (owner) => owner?.v === 1 && Number.isSafeInteger(owner.pid) && owner.pid > 0
	&& (owner.start === null || typeof owner.start === "string" && /^(?:linux:[0-9a-f-]{36}:\d{1,24}|darwin:[A-Za-z0-9 :]{24,40})$/.test(owner.start))
	&& BACKENDS.has(owner.backend);

function writePrivateFile(fs, path, value, { durable = false } = {}) {
	const fd = fs.openSync(path, "wx", 0o600);
	try {
		fs.fchmodSync(fd, 0o600);
		fs.writeFileSync(fd, value);
		if (durable) fs.fsyncSync(fd);
	} finally { fs.closeSync(fd); }
}

/**
 * Stage exact UTF-8 values, never underneath /job, /workspace or a retained sandbox. The owner is durably published
 * BEFORE any secret is written, so a crash before ownership exists cannot leave an unowned secret behind. A retry
 * never reuses a directory: an existing name is refused, not removed underneath another live attempt.
 */
export function stageSecretFiles(jobDir, contents, { fs = nodeFs, backend = "local", owner = ownerOfThisProcess(), workspace = null, globalPiDir = null, log = () => {} } = {}) {
	let made = false;
	const dir = typeof jobDir === "string" ? `${jobDir}${SECRET_FILES_DIR_SUFFIX}` : null;
	try {
		if (!dir || !JOB_DIR_RE.test(basename(jobDir)) || !BACKENDS.has(backend)) throw new Error();
		// Recheck the actual mounts immediately before writing: a source changed since pickup/prepare must
		// never turn this sibling into part of /workspace or the overlay. The next pickup gives the policy refusal.
		const placement = checkSecretFileSources([workspace, globalPiDir], dir, { fs });
		if (placement) throw Object.assign(new Error(), { code: placement.unavailable ? "EIO" : "EINVAL" });
		if (!contents || typeof contents !== "object" || Array.isArray(contents)) throw new Error();
		const entries = Object.entries(contents);
		if (entries.length === 0 || entries.length > 80 || !secretFileNamesDistinct(entries.map(([name]) => name))) throw new Error();
		for (const [name, value] of entries) {
			if (!secretFileNameAllowed(name)) throw new Error();
			if (typeof value !== "string" || value === "" || value.includes("\0")) throw new Error();
			const bytes = Buffer.from(value, "utf8");
			if (bytes.length > MAX_VALUE_BYTES || bytes.toString("utf8") !== value) throw new Error();
		}
		const record = { v: 1, pid: owner?.pid, start: owner?.start ?? null, backend };
		if (!shapedOwner(record)) throw new Error();
		fs.mkdirSync(dir, { mode: 0o700 });
		made = true;
		fs.chmodSync(dir, 0o700);
		writePrivateFile(fs, join(dir, SECRET_FILES_OWNER), `${JSON.stringify(record)}\n`, { durable: true });
		// Windows does not support opening a directory to fsync it. The file itself is fsynced there; on POSIX the
		// directory entry must also be durable before a later file containing a secret may be published beneath it.
		if (process.platform !== "win32") {
			const fd = fs.openSync(dir, "r");
			try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		}
		const files = join(dir, SECRET_FILES_SUBDIR);
		fs.mkdirSync(files, { mode: 0o700 });
		fs.chmodSync(files, 0o700);
		for (const [name, value] of entries) writePrivateFile(fs, join(files, name), Buffer.from(value, "utf8"));
		return dir;
	} catch (error) {
		if (made) removeSecretFiles(dir, { fs, log });
		const failure = new Error("secret files could not be staged");
		failure.code = codeOf(error);
		throw failure;
	}
}

/** A removal failure is observable and remains eligible for the next boot's independent sweep. */
export function removeSecretFiles(dir, { fs = nodeFs, log = () => {} } = {}) {
	if (dir === null || dir === undefined) return true;
	try { fs.rmSync(dir, { recursive: true, force: true }); return true; }
	catch (error) { say(log, "secret_files_remove_failed", { code: codeOf(error) }); return false; }
}

async function readOwner(dir, fs, uid) {
	let file;
	try {
		const path = join(dir, SECRET_FILES_OWNER);
		const entry = await fs.lstat(path);
		if (!entry.isFile() || entry.isSymbolicLink()) return null;
		file = await fs.open(path, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0));
		const st = await file.stat();
		if (st.dev !== entry.dev || st.ino !== entry.ino || !st.isFile() || st.size > OWNER_MAX_BYTES || (Number.isInteger(uid) && st.uid !== uid) || (st.mode & 0o077) !== 0) return null;
		const parsed = JSON.parse(await file.readFile("utf8"));
		return shapedOwner(parsed) ? parsed : null;
	} catch { return null; }
	finally { if (file) await file.close().catch(() => {}); }
}

/**
 * Sweep credentials independently of job-directory age and checkpoint keep lists. Only a successfully reaped venue
 * and a proven dead owner (or reused PID) permit removal. Another worker may already have staged its next job, even
 * while this process reaps old containers, so runtime reaping alone never proves its private directory abandoned.
 */
export async function sweepSecretFiles({ jobsDir, reapedBackends = [], fs = nodeFsp, identity = secretFileProcessIdentity, uid = process.geteuid?.(), log = () => {} } = {}) {
	const result = { removed: 0, kept: 0, failed: 0 };
	let names;
	try { names = await fs.readdir(jobsDir); }
	catch (error) {
		if (error?.code !== "ENOENT") { result.failed++; say(log, "secret_files_sweep_failed", { code: codeOf(error) }); }
		return result;
	}
	const reaped = new Set(reapedBackends);
	const identities = new Map();
	for (const name of names) {
		if (!name.endsWith(SECRET_FILES_DIR_SUFFIX) || !JOB_DIR_RE.test(name.slice(0, -SECRET_FILES_DIR_SUFFIX.length))) continue;
		const dir = join(jobsDir, name);
		try {
			const st = await fs.lstat(dir);
			if (!st.isDirectory() || (st.mode & 0o777) !== 0o700 || (Number.isInteger(uid) && st.uid !== uid)) {
				result.kept++; say(log, "secret_files_sweep_skipped", { reason: "directory-untrusted" }); continue;
			}
			const owner = await readOwner(dir, fs, uid);
			if (!owner) { result.kept++; say(log, "secret_files_sweep_skipped", { reason: "owner-unreadable" }); continue; }
			if (!reaped.has(owner.backend)) { result.kept++; say(log, "secret_files_sweep_skipped", { reason: "venue-not-reaped" }); continue; }
			if (!identities.has(owner.pid)) identities.set(owner.pid, await identity(owner.pid));
			const live = identities.get(owner.pid);
			const stopped = live?.alive === false || live?.alive === true && owner.start !== null && typeof live.start === "string" && live.start !== owner.start;
			if (!stopped) { result.kept++; say(log, "secret_files_sweep_skipped", { reason: live?.alive === true ? "owner-alive" : "owner-unknown" }); continue; }
			await fs.rm(dir, { recursive: true, force: true });
			result.removed++;
		} catch (error) { result.failed++; say(log, "secret_files_sweep_failed", { code: codeOf(error) }); }
	}
	if (result.removed || result.failed) say(log, "secret_files_swept", result);
	return result;
}
