/**
 * The console's remembered devices (issue #849): what lets a browser stay signed in across idle periods and console restarts.
 *
 * ONE FILE PER DEVICE, in `console-devices/` beside the tokens file (0700), named by the sha256 of the device's secret and holding that
 * device's record (0600). Not one file with a list: the console writes during requests while the CLI writes too, and a list's
 * compare-then-rename can lose a revocation between the two, which is the one write this store may never lose. It also means one bad record
 * stops one device, not all of them.
 *
 * ONLY THE HASH IS ON DISK, so a copy of this directory signs nobody in. The secret exists in the browser's cookie and, once, in the
 * process that made it.
 *
 * A RECORD IS NOT DELETED WHEN A DEVICE ENDS. It keeps `ended: {reason, at}` for `ENDED_RETENTION_MS`, because a browser presenting the
 * cookie later has to be told the true reason (issue acceptance 6), including after a restart. A name keeps only its newest dead records (see
 * `MAX_DEVICES_PER_NAME`), so a very busy name can lose an older reason sooner than that. A dead secret's hash is not sensitive, and the
 * reason is shown only to whoever presents that cookie. A tombstone stops nothing for whoever can write this folder: they could remove `ended`,
 * or plant a record outright. That boundary is the folder being owner-only and guarded, not the record's shape. REJECTED: a keyed MAC over each
 * record, which would need a key kept beside what it protects.
 *
 * LAST USE IS THE FILE'S MTIME, set at most daily. A touch changes no content, so it can never overwrite the `ended` a revocation just wrote.
 * REJECTED: a `lastUsedAt` field, which needs a read-modify-write on the hottest path, exactly the race the per-device file exists to remove.
 *
 * THREE ANSWERS, NOT TWO. `readDevice` says a record is here, is absent, or could not be judged. The third matters: a bad store must never
 * end a session the way a revocation does, and must never pass one as live.
 *
 * WHAT MAY BE COPIED FROM `login-codes.mjs` AND WHAT MUST NOT. Its `dirProblem` idea is here, with an owner check it lacks. Its `take` unlinks
 * on read and its `reap` deletes anything without a future `expiresAt`, which is every record in this directory. The fix sentence for an
 * unsafe store is "remove", not `chmod`: tightening a directory another account could write would make whatever it planted good.
 */
import * as nodeFs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { TOKEN_NAME_RE } from "./console-tokens.mjs";

/** The directory's name, beside the tokens file. */
export const CONSOLE_DEVICES_DIRNAME = "console-devices";

/** The roles a device may be remembered for. An allowlist, so a role added later is not remembered until someone decides it should be. */
export const REMEMBER_ROLES = Object.freeze(["operator", "viewer"]);

/** How long a dead record is kept to say why. */
export const ENDED_RETENTION_MS = 90 * 24 * 3600 * 1000;

/**
 * The most devices one token may have remembered, and the most dead records kept for it: a remember-then-end loop would otherwise grow this folder
 * without bound, and every remember scans it. Losing an old dead record costs only the sentence saying why.
 */
export const MAX_DEVICES_PER_NAME = 32;

/** How often last-use is written. A day is enough for "last used" to mean something, and keeps a request's work to a read. */
export const TOUCH_INTERVAL_MS = 24 * 3600 * 1000;

/** The most a record can be. Far above a real one, and it stops a planted file being read whole on every listing. */
const RECORD_MAX_BYTES = 64 * 1024;

/** How old a leftover temporary file must be before it is removed: older than any write in progress. */
const STALE_TEMP_MS = 3600 * 1000;

/** Why a device stopped being trusted. Each one is a reason the console can word for the person holding the cookie. */
export const DEVICE_END_REASONS = Object.freeze(["signed-out", "removed", "revoked", "role", "all", "replaced"]);

/** The closed word list a label is built from: never User-Agent bytes, which are attacker-chosen and would end up on a page. */
export const DEVICE_BROWSERS = Object.freeze(["Chrome", "Edge", "Firefox", "Safari", "Browser"]);
export const DEVICE_SYSTEMS = Object.freeze(["macOS", "Windows", "Linux", "iPhone", "iPad", "Android", "this system"]);

const HASH_RE = /^[0-9a-f]{64}$/;
// Either case: on a case-insensitive volume an uppercase name is the same file a lowercase hash opens, so a listing must see it (and report it).
const RECORD_FILE_RE = /^[0-9a-fA-F]{64}\.json$/;
const TEMP_FILE_RE = /^\.[0-9a-f]{64}\.[0-9a-f]{16}\.tmp$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const DEVICE_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

const errCode = (e) => (typeof e?.code === "string" ? e.code : "error");

/** A shape alone admits `2026-99-99T99:99:99.999Z`, which reads as NaN and would look very old to a sweep. */
const isoIsReal = (text) => typeof text === "string" && ISO_RE.test(text) && Number.isFinite(Date.parse(text)) && new Date(text).toISOString() === text;

export function consoleDevicesDir(tokensPath) {
	return join(dirname(tokensPath), CONSOLE_DEVICES_DIRNAME);
}

/**
 * The cookie's name for this deployment. Cookies ignore ports, so two deployments on one loopback address would otherwise overwrite each
 * other's remembered device, and the person would simply find they had to sign in again with nothing to say why.
 */
export function deviceCookieName(tokensPath) {
	return `pdc_device_${createHash("sha256").update(String(tokensPath)).digest("hex").slice(0, 10)}`;
}

export function newDeviceSecret(random = randomBytes) {
	return random(32).toString("base64url");
}

export function hashDeviceSecret(secret) {
	return createHash("sha256").update(String(secret)).digest("hex");
}

/** What a list shows and a command takes: enough to tell devices apart, and useless for finding a record's secret. */
export function deviceIdOf(hash) {
	return String(hash).slice(0, 12);
}

/** A label from closed word lists, for telling devices apart on a page. Anything unrecognised is the plain fallback, never the header's bytes. */
export function deviceLabelOf(userAgent) {
	const ua = typeof userAgent === "string" ? userAgent : "";
	const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
	const system = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "this system";
	return `${browser} on ${system}`;
}

const labelIsClosed = (label) => typeof label === "string" && DEVICE_BROWSERS.some((b) => DEVICE_SYSTEMS.some((s) => label === `${b} on ${s}`));

function validRecord(r) {
	if (r === null || typeof r !== "object" || Array.isArray(r)) return false;
	if (r.version !== 1 || typeof r.name !== "string" || !TOKEN_NAME_RE.test(r.name) || !REMEMBER_ROLES.includes(r.role)) return false;
	if (typeof r.tokenHash !== "string" || !HASH_RE.test(r.tokenHash) || !Number.isSafeInteger(r.generation) || r.generation < 0) return false;
	if (!isoIsReal(r.createdAt) || !labelIsClosed(r.label)) return false;
	if (r.ended !== undefined) {
		if (r.ended === null || typeof r.ended !== "object" || !DEVICE_END_REASONS.includes(r.ended.reason) || !isoIsReal(r.ended.at)) return false;
	}
	return true;
}

/**
 * What is wrong with the directory, or null: a symlink, anything but a directory, any group or world bit, or another account's. With `create`,
 * a missing one is made 0700, chmod'd exactly since mkdir's mode is masked by the umask. `{absent: true}` for a missing one without `create`.
 */
export function devicesDirProblem(dir, { fs = nodeFs, uid = process.geteuid?.(), create = false, platform = process.platform } = {}) {
	// Node reports group and other bits on every Windows folder, so the mode check below could only ever refuse, and a folder made first would
	// then be one doctor fails on from that day on. Said once, here, and nothing is made.
	if (platform === "win32" && create) return { problem: "remembering a device does not work on a Windows host, because Windows reports every folder as open to other accounts; paste a token instead" };
	let st;
	try {
		st = fs.lstatSync(dir);
	} catch (e) {
		if (e?.code !== "ENOENT") return { problem: `the remembered-device folder ${dir} could not be inspected (${errCode(e)}); check its parent's permissions` };
		if (!create) return { absent: true };
		try {
			// Tolerated: two first remembers racing is no fault, and the checks below judge whichever folder won.
			try { fs.mkdirSync(dir, { mode: 0o700 }); fs.chmodSync(dir, 0o700); }
			catch (e2) { if (e2?.code !== "EEXIST") throw e2; }
			st = fs.lstatSync(dir);
		} catch (e2) {
			return { problem: `the remembered-device folder ${dir} could not be created (${errCode(e2)}); check that the tokens file's folder exists and belongs to this account` };
		}
	}
	const remove = `remove the folder (\`rm -r ${JSON.stringify(dir)}\`); every browser then signs in again`;
	if (st.isSymbolicLink()) return { problem: `the remembered-device folder ${dir} is a symbolic link, and the console uses only a real folder; ${remove}` };
	if (!st.isDirectory()) return { problem: `${dir} is not a folder; ${remove}` };
	if (uid !== undefined && st.uid !== uid) return { problem: `the remembered-device folder ${dir} belongs to another account, so what it holds cannot be trusted; ${remove}` };
	if ((st.mode & 0o077) !== 0) return { problem: `the remembered-device folder ${dir} can be reached by other accounts (mode ${(st.mode & 0o777).toString(8).padStart(3, "0")}), so what it holds cannot be trusted; ${remove}` };
	// Readable but not writable would pass every read and then fail the one write that must work, a revocation.
	if ((st.mode & 0o700) !== 0o700) return { problem: `the remembered-device folder ${dir} cannot be written by its owner (mode ${(st.mode & 0o777).toString(8).padStart(3, "0")}), so a device could not be removed; restore it with \`chmod u+rwx ${JSON.stringify(dir)}\`, which is safe here because it gives nobody else anything` };
	return null;
}

/** The record at `path`, read through one no-follow descriptor: `{record, mtimeMs}`, `{absent}` or `{unjudged}`. */
function readRecordFile(path, { fs, uid }) {
	let fd;
	try {
		fd = fs.openSync(path, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK);
	} catch (e) {
		if (e?.code === "ENOENT") return { absent: true };
		return { unjudged: `the record could not be opened (${errCode(e)})` };
	}
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile()) return { unjudged: "the record is not a regular file" };
		if (uid !== undefined && st.uid !== uid) return { unjudged: "the record belongs to another account" };
		if ((st.mode & 0o077) !== 0) return { unjudged: "the record can be reached by other accounts" };
		// A second name could sit anywhere and be edited there. Backups that hard-link fail closed, which is the right way to fail.
		// `> 1`, not `!== 1`: a file just renamed over reads 0 to whoever still holds it, and those bytes are whole.
		if (st.nlink > 1) return { unjudged: "the record has more than one name" };
		if (st.size > RECORD_MAX_BYTES) return { unjudged: "the record is too large to be one of this console's" };
		let record;
		try { record = JSON.parse(fs.readFileSync(fd, "utf8")); } catch { return { unjudged: "the record is not valid JSON" }; }
		if (!validRecord(record)) return { unjudged: "the record is not one this console can read" };
		return { record, mtimeMs: st.mtimeMs };
	} catch (e) {
		return { unjudged: `the record could not be read (${errCode(e)})` };
	} finally {
		try { fs.closeSync(fd); } catch { /* the answer above stands */ }
	}
}

/**
 * One device, by the hash of its secret: `{record, mtimeMs}`, `{absent: true}` when the store holds no such device, or `{unjudged}` when
 * nothing can be said (the folder gone or unsafe, the record corrupt or unsafe). A missing folder is unjudged rather than absent on purpose:
 * a repointed `PI_CONSOLE_TOKENS_FILE` must not read as every device having been revoked.
 */
export function readDevice({ dir, hash, fs = nodeFs, uid = process.geteuid?.() }) {
	if (typeof hash !== "string" || !HASH_RE.test(hash)) return { absent: true };
	const problem = devicesDirProblem(dir, { fs, uid });
	if (problem?.absent) return { unjudged: "the remembered-device folder does not exist" };
	if (problem) return { unjudged: problem.problem };
	const path = join(dir, `${hash}.json`);
	/** On a case-insensitive volume an uppercase name opens as this one, so the name on disk has to be looked at too, whichever read found it. */
	const named = (found) => {
		if (found.record === undefined) return found;
		try {
			const onDisk = (fs.realpathSync?.native ?? fs.realpathSync)?.(path);
			return typeof onDisk !== "string" || basename(onDisk) === `${hash}.json` ? found : { unjudged: "the record's name is not one this console writes" };
		} catch (e) {
			return { unjudged: `the record could not be looked at (${errCode(e)})` };
		}
	};
	const read = readRecordFile(path, { fs, uid });
	if (!read.absent) return named(read);
	// A folder that went away between the check and the open says nothing about this device, and must not read as a revocation.
	const after = devicesDirProblem(dir, { fs, uid });
	if (after !== null) return { unjudged: after.problem ?? "the remembered-device folder does not exist" };
	// Looked at once more: a folder that left and came back around the open would otherwise read as this device being gone.
	return named(readRecordFile(path, { fs, uid }));
}

/** Write `record` for `hash` so a crash leaves the old bytes or the new ones, never half of either: a private temporary, fsync, rename, fsync of the folder. */
function writeRecord({ dir, hash, record, fs, random }) {
	const temp = join(dir, `.${hash}.${random(8).toString("hex")}.tmp`);
	const fd = fs.openSync(temp, "wx", 0o600);
	try {
		try {
			fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	} catch (e) {
		try { fs.unlinkSync(temp); } catch { /* it may be gone already */ }
		throw e;
	}
	try {
		// The create's mode is masked by the umask; set it exactly.
		fs.chmodSync(temp, 0o600);
		fs.renameSync(temp, join(dir, `${hash}.json`));
	} catch (e) {
		try { fs.unlinkSync(temp); } catch { /* it may be gone already */ }
		throw e;
	}
	const dirFd = fs.openSync(dir, "r");
	try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

/** Every record file here: `{records: [{hash, record?, mtimeMs?, unjudged?}]}`, read without stopping at a bad one. */
function allRecords(dir, { fs, uid }) {
	return fs.readdirSync(dir).filter((name) => RECORD_FILE_RE.test(name)).map((name) => {
		const hash = name.slice(0, -".json".length);
		if (hash !== hash.toLowerCase()) return { hash, unjudged: "the record's name is not one this console writes" };
		return { hash, ...readRecordFile(join(dir, name), { fs, uid }) };
	});
}

/**
 * Remember a device: `{secret, hash, record}`, or `{refusal}` saying what stands in the way. The binding (`name`, `role`, `tokenHash`, `generation`) is
 * what lets every existing way of ending a sign-in also end this: revoke and rotate change the hash, a role change the role, `sessions end-all` the
 * generation. The caller judges a record against the tokens file at each use. `tokenCreatedAt` is the entry's own `createdAt`: a device older than the
 * entry cannot belong to it, which is the only way to order a hash, so a caller holding a stale entry cannot end a newer device.
 */
export function rememberDevice({ dir, name, role, tokenHash, generation, tokenCreatedAt = null, label = "Browser on this system", fs = nodeFs, uid = process.geteuid?.(), now = Date.now, random = randomBytes }) {
	if (!REMEMBER_ROLES.includes(role)) return { refusal: `a ${String(role).slice(0, 32)} token cannot be remembered on a device` };
	if (typeof name !== "string" || !TOKEN_NAME_RE.test(name) || typeof tokenHash !== "string" || !HASH_RE.test(tokenHash) || !Number.isSafeInteger(generation) || generation < 0) return { refusal: "this sign-in cannot be remembered: its token entry is not one the store accepts" };
	const problem = devicesDirProblem(dir, { fs, uid, create: true });
	if (problem) return { refusal: problem.problem };
	try {
		const mine = allRecords(dir, { fs, uid }).filter((row) => row.record?.name === name);
		// A device bound to a token entry that has since been rotated or ended can never sign in again, so it holds no place under the cap and ages out.
		for (const row of mine) {
			if (row.record.ended !== undefined) continue;
			// The true reason, since this is what the browser holding that cookie will be told. Only ever downward: an entry that may be stale must not end a newer device.
			const reason = row.record.generation < generation ? "all" : row.record.role !== role && row.record.generation === generation && row.record.tokenHash === tokenHash ? "role" : row.record.tokenHash !== tokenHash && typeof tokenCreatedAt === "string" && row.record.createdAt < tokenCreatedAt ? "revoked" : null;
			if (reason === null) continue;
			if (endDevice({ dir, hash: row.hash, reason, fs, uid, now, random }).ok) row.record.ended = { reason, at: new Date(now()).toISOString() };
		}
		const live = mine.filter((row) => row.record.ended === undefined).length;
		if (live >= MAX_DEVICES_PER_NAME) return { refusal: `"${name}" already has ${live} remembered devices, the most one sign-in may have; remove one first` };
		const dead = mine.filter((row) => row.record.ended !== undefined).sort((a, b) => Date.parse(b.record.ended.at) - Date.parse(a.record.ended.at));
		for (const row of dead.slice(MAX_DEVICES_PER_NAME - 1)) {
			try { fs.unlinkSync(join(dir, `${row.hash}.json`)); } catch { /* the next remember */ }
		}
		const secret = newDeviceSecret(random);
		const hash = hashDeviceSecret(secret);
		const record = { version: 1, name, role, tokenHash, generation, createdAt: new Date(now()).toISOString(), label: labelIsClosed(label) ? label : "Browser on this system" };
		writeRecord({ dir, hash, record, fs, random });
		return { secret, hash, record };
	} catch (e) {
		return { refusal: `this device could not be remembered (${errCode(e)}); check the folder ${dir}` };
	}
}

/**
 * End a device, durably: `{ok: true}`, `{ok: true, already: true}` for one already ended, `{absent: true}` for none, or `{problem}`. Rewrites the
 * record rather than removing it (see the header). Sequential ends keep the first reason. Ends that truly race both answer `ok` and one reason stays:
 * the device is ended either way, and only the sentence shown can differ. REJECTED: an exclusive claim to close that, since it would add a way for a
 * revocation to fail in order to protect a sentence.
 */
export function endDevice({ dir, hash, reason, fs = nodeFs, uid = process.geteuid?.(), now = Date.now, random = randomBytes }) {
	if (!DEVICE_END_REASONS.includes(reason)) throw new RangeError(`endDevice: a reason is one of ${DEVICE_END_REASONS.join(", ")}, not ${JSON.stringify(reason)}`);
	const read = readDevice({ dir, hash, fs, uid });
	if (read.absent) return { absent: true };
	if (read.unjudged) return { problem: read.unjudged };
	if (read.record.ended !== undefined) return { ok: true, already: true };
	try {
		const { mtimeMs } = read;
		writeRecord({ dir, hash, record: { ...read.record, ended: { reason, at: new Date(now()).toISOString() } }, fs, random });
		// Last use is the file's mtime, and the rename above has just reset it to the moment of the end.
		try { fs.utimesSync(join(dir, `${hash}.json`), mtimeMs / 1000, mtimeMs / 1000); } catch { /* the end is durable, and that was only its last-used time */ }
		return { ok: true };
	} catch (e) {
		return { problem: `the device could not be ended (${errCode(e)})` };
	}
}

/** Move a device's last-use forward, at most daily. Best effort and changes no content, so it can be lost freely and can never lose an end. */
export function touchDevice({ dir, hash, mtimeMs, fs = nodeFs, now = Date.now }) {
	if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
	if (typeof mtimeMs === "number" && now() - mtimeMs < TOUCH_INTERVAL_MS) return false;
	try {
		const seconds = now() / 1000;
		// `lutimes`: a link planted at the name must not have some other file's time moved.
		fs.lutimesSync(join(dir, `${hash}.json`), seconds, seconds);
		return true;
	} catch {
		return false;
	}
}

/** Every device: `{devices, unreadable}` (newest first), or `{problem}`. A missing folder is simply no devices here: this is a listing, not a judgement. */
export function listDevices({ dir, fs = nodeFs, uid = process.geteuid?.() }) {
	const problem = devicesDirProblem(dir, { fs, uid });
	if (problem?.absent) return { devices: [], unreadable: 0, unreadableIds: [] };
	if (problem) return { problem: problem.problem };
	try {
		const rows = allRecords(dir, { fs, uid });
		const devices = rows.filter((row) => row.record).map((row) => ({ id: deviceIdOf(row.hash), hash: row.hash, name: row.record.name, role: row.record.role, label: row.record.label, createdAt: row.record.createdAt, lastUsedAt: new Date(row.mtimeMs).toISOString(), ...(row.record.ended ? { ended: { reason: row.record.ended.reason, at: row.record.ended.at } } : {}) }));
		devices.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
		const bad = rows.filter((row) => row.unjudged);
		return { devices, unreadable: bad.length, unreadableIds: bad.map((row) => deviceIdOf(row.hash)) };
	} catch (e) {
		return { problem: `the remembered-device folder ${dir} could not be read (${errCode(e)})` };
	}
}

/** Remove dead records past retention and temporaries a crash left. Nothing it cannot read and nothing live: only the operator decides those. Returns how many went. */
export function reapDevices({ dir, fs = nodeFs, uid = process.geteuid?.(), now = Date.now }) {
	const problem = devicesDirProblem(dir, { fs, uid });
	if (problem) return 0;
	let removed = 0;
	const t = now();
	try {
		for (const row of allRecords(dir, { fs, uid })) {
			if (row.record?.ended === undefined || !(t - Date.parse(row.record.ended.at) > ENDED_RETENTION_MS)) continue;
			try { fs.unlinkSync(join(dir, `${row.hash}.json`)); removed += 1; } catch { /* the next sweep */ }
		}
		for (const name of fs.readdirSync(dir)) {
			if (!TEMP_FILE_RE.test(name)) continue;
			try {
				const path = join(dir, name);
				if (t - fs.lstatSync(path).mtimeMs > STALE_TEMP_MS) { fs.unlinkSync(path); removed += 1; }
			} catch { /* the next sweep */ }
		}
	} catch { /* a folder that went away has nothing left to sweep */ }
	return removed;
}

/** What doctor says of the store: `{absent}`, `{problem}`, or `{live, unreadable}`. */
export function devicesState({ dir, fs = nodeFs, uid = process.geteuid?.(), platform = process.platform }) {
	const problem = devicesDirProblem(dir, { fs, uid, platform });
	if (problem?.absent) return { absent: true };
	if (problem) return { problem: problem.problem };
	const listed = listDevices({ dir, fs, uid });
	if (listed.problem) return { problem: listed.problem };
	return { live: listed.devices.filter((d) => d.ended === undefined).length, unreadable: listed.unreadable, unreadableIds: listed.unreadableIds };
}
