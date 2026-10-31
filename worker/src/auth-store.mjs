/** Host-only credential transactions. A refresh marker survives an ambiguous remote rotation. */
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function authError(code, { transient = false, uncertain = false } = {}) {
	const error = new Error(code);
	error.code = code;
	error.transient = transient;
	error.uncertain = uncertain;
	return error;
}

export const AUTH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// RFC 6750 bearer grammar permits opaque tokens; an API key must never enter pi's ChatGPT branch.
export const validOpenAIAccessToken = (value) => typeof value === "string" && value.length > 0 && value.length <= 65_536 && !/^sk-/i.test(value) && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
export function validateAuthCredential(value, { provider } = {}) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw authError("auth-credential-invalid");
	for (const name of ["access", "refresh"]) if (typeof value[name] !== "string" || !value[name] || value[name].length > 65_536 || /[\r\n\0]/.test(value[name])) throw authError("auth-credential-invalid");
	if (provider === "openai" && !validOpenAIAccessToken(value.access)) throw authError("auth-credential-invalid");
	if (provider === "anthropic" && (!value.access.startsWith("sk-ant-oat") || !/^[A-Za-z0-9._~+/-]+=*$/.test(value.access))) throw authError("auth-credential-invalid");
	if (!Number.isSafeInteger(value.expires) || value.expires <= 0 || value.expires > 253_402_300_799_999) throw authError("auth-credential-invalid");
	return { ...value, type: "oauth" };
}

export function createAuthStore({ dir, fs = nodeFs, lock = null, uid = process.getuid?.() } = {}) {
	if (typeof dir !== "string" || !dir.startsWith("/")) throw authError("auth-store-invalid");
	function secure(path, directory = false) {
		const stat = fs.lstatSync(path);
		if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) throw authError("auth-store-permissions");
	}
	function initialize() {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		secure(dir, true);
	}
	function pathFor(id) {
		if (typeof id !== "string" || !AUTH_ID_RE.test(id)) throw authError("auth-connection-invalid");
		return join(dir, `${id}.json`);
	}
	function read(id) {
		try { secure(dir, true); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
		const path = pathFor(id);
		try { secure(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
		try {
			const fd = fs.openSync(path, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
			let text;
			try { if (fs.fstatSync(fd).size > 512 * 1024) throw authError("auth-store-invalid"); text = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
			const row = JSON.parse(text);
			if (row?.version !== 1 || row.id !== id || !Number.isSafeInteger(row.generation) || row.generation < 0 || !["connected", "disconnected", "reauth-required", "refresh-uncertain"].includes(row.state) || typeof row.accountGroup !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.accountGroup) || (row.lastRefreshAt !== null && !Number.isSafeInteger(row.lastRefreshAt)) || (row.extraUsage !== undefined && !["unknown", "enabled", "disabled"].includes(row.extraUsage))) throw authError("auth-store-invalid");
			if (row.credential !== null) validateAuthCredential(row.credential, { provider: row.provider });
			return row;
		} catch (error) { if (error.code?.startsWith("auth-")) throw error; throw authError("auth-store-invalid"); }
	}
	function write(id, row) {
		const path = pathFor(id);
		const temporary = join(dir, `.${id}.${randomUUID()}.tmp`);
		let fd;
		try {
			fd = fs.openSync(temporary, "wx", 0o600);
			fs.writeFileSync(fd, JSON.stringify({ ...row, version: 1, id }));
			fs.fsyncSync(fd);
			fs.closeSync(fd); fd = undefined;
			fs.renameSync(temporary, path);
			const directory = fs.openSync(dir, "r");
			try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
			try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
		}
	}
	async function transaction(id, fn, { signal } = {}) {
		initialize();
		const path = pathFor(id);
		// proper-lockfile locks a name, not the inode replaced by atomic rename. Never steal a live holder.
		let compromised = false;
		let release;
		try { const acquire = lock ?? (await import("proper-lockfile")).default.lock; release = await acquire(path, { realpath: false, stale: 30_000, update: 5_000, retries: { retries: 80, minTimeout: 25, maxTimeout: 250 }, onCompromised: () => { compromised = true; } }); }
		catch { throw authError("auth-store-unavailable", { transient: true }); }
		try {
			signal?.throwIfAborted();
			return await fn(read(id), async (row) => { if (compromised) throw authError("auth-store-lock-lost"); write(id, row); });
		} finally { await release(); }
	}
	return { read, transaction };
}
