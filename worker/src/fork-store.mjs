/**
 * Immutable, run-addressed fork sources (issue #648). The canonical session moves on every promotion,
 * so looking up an old run through its session key would silently fork a newer conversation instead.
 * These private artifacts have their own bounded retention; no index maps jobs to arbitrary paths.
 * Workspace points are captured ONLY while the caller has quiesced the container. A transcript alone
 * never establishes that the files at an earlier entry are available.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CHECKPOINT_LIMITS, makeWorkspaceCheckpointer, retryableStoreError } from "./workspace-checkpoint.mjs";

export const FORK_SOURCE_LIMITS = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxStoreBytes: 256 * 1024 * 1024, maxSources: 1024, maxPoints: 64, ttlMs: 7 * 86400_000 });
const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const ENTRY = /^[A-Za-z0-9_-]{1,128}$/;
const HEX = /^[0-9a-f]{64}$/;
const KEY = /^[0-9a-f]{32}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,127}$/;
const HOST = /^[A-Za-z0-9._-]{1,64}$/;
const POSITIONS = new Set(["before", "at"]);
const ENTRY_TYPES = new Set(["message", "thinking_level_change", "model_change", "usage", "compaction", "branch_summary", "custom", "label", "session_info", "custom_message", "context_edit"]);
const ROLES = new Set(["user", "assistant", "toolResult"]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const forkSourceKey = (runId) => digest(`fork-source\0${runId}`).slice(0, 32);
const pointKey = (entryId, position) => digest(`${entryId}\0${position}`);
const refused = (suffix) => ({ refused: `fork-source-${suffix}` });

function regular(path, max) {
	const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile() || st.size > max) throw new Error("not-bounded-file");
		const out = Buffer.alloc(st.size);
		let offset = 0;
		while (offset < out.length) {
			const n = fs.readSync(fd, out, offset, out.length - offset, offset);
			if (!n) throw new Error("short-file");
			offset += n;
		}
		const after = fs.fstatSync(fd);
		if (st.size !== after.size || st.mtimeMs !== after.mtimeMs) throw new Error("changed-file");
		return out;
	} finally { fs.closeSync(fd); }
}
function directory(path, create = false) {
	if (create) {
		try { if (!fs.lstatSync(path).isDirectory()) throw new Error("not-directory"); }
		catch (e) { if (e?.code !== "ENOENT") throw e; }
		fs.mkdirSync(path, { recursive: true, mode: 0o700 });
	}
	if (!fs.lstatSync(path).isDirectory()) throw new Error("not-directory");
}
function durable(path, bytes) {
	const fd = fs.openSync(path, "wx", 0o600);
	try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncDir(path) {
	const fd = fs.openSync(path, "r");
	try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function parseEntries(bytes) {
	const lines = bytes.toString("utf8").split("\n").filter(Boolean);
	const header = JSON.parse(lines.shift() ?? "null");
	if (header?.type !== "session") throw new Error("header");
	const entries = [];
	const seen = new Set();
	for (const line of lines) {
		const e = JSON.parse(line);
		if (!ENTRY.test(e.id ?? "") || seen.has(e.id) || (e.parentId !== null && !seen.has(e.parentId))) throw new Error("tree");
		seen.add(e.id);
		entries.push({ id: e.id, parentId: e.parentId, type: ENTRY_TYPES.has(e.type) ? e.type : "unknown", ...(e.type === "message" ? { role: ROLES.has(e.message?.role) ? e.message.role : "unknown" } : {}) });
	}
	return entries;
}
/** Last complete tree path, with every tool call answered, is a usable workspace boundary. */
export function forkPointEntry(bytes) {
	try {
		const raw = bytes.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
		const entries = raw.slice(1);
		parseEntries(bytes);
		const byId = new Map(entries.map((e) => [e.id, e]));
		const path = [];
		for (let e = entries.at(-1); e; e = byId.get(e.parentId)) path.unshift(e);
		const pending = new Set();
		for (const e of path) {
			if (e.type !== "message") continue;
			if (e.message?.role === "assistant") for (const c of e.message.content ?? []) if (c.type === "toolCall") pending.add(c.id);
			if (e.message?.role === "toolResult") pending.delete(e.message.toolCallId);
		}
		return pending.size === 0 ? path.at(-1)?.id ?? null : null;
	} catch { return null; }
}
function validManifest(m) {
	const fields = ["v", "runId", "sessionKey", "baseSha", "venue", "piVersion", "attempt", "host", "hostQueue", "at", "bytes", "transcriptSha256", "sourceDigest"];
	return m && Object.keys(m).length === fields.length && fields.every((k) => Object.hasOwn(m, k)) && m.v === 1 && ID.test(m.runId) && KEY.test(m.sessionKey) && SHA.test(m.baseSha) && TOKEN.test(m.venue) && /^\d+\.\d+\.\d+$/.test(m.piVersion) && Number.isSafeInteger(m.attempt) && m.attempt >= 0 && HOST.test(m.host) && (m.hostQueue === null || /^pi-jobs@[A-Za-z0-9._-]{1,64}$/.test(m.hostQueue)) && Number.isSafeInteger(m.at) && m.at >= 0 && Number.isSafeInteger(m.bytes) && m.bytes >= 0 && HEX.test(m.transcriptSha256) && HEX.test(m.sourceDigest);
}

export function createForkStore({ dir, now = Date.now, limits = {}, hostName = hostname(), hostQueue = null, checkpointer = null, checkpointLimits = {}, readRegular = regular } = {}) {
	const L = { ...FORK_SOURCE_LIMITS, ...limits };
	const root = typeof dir === "string" && dir ? resolve(dir) : null;
	const host = HOST.test(hostName) ? hostName : "unknown";
	const archive = root ? checkpointer ?? makeWorkspaceCheckpointer({ storeDir: join(root, ".workspaces"), now, hostName: host, keepHistory: true, limits: { ttlMs: L.ttlMs, snapshotTimeoutMs: 5_000, ...checkpointLimits } }) : null;
	const pathOf = (runId) => join(root, forkSourceKey(runId));
	const pointsOf = (runId) => join(pathOf(runId), "points");
	let archiveBusy = false;
	function dirs(runId, create = false) {
		if (!root || !ID.test(runId ?? "")) throw new Error("bad-args");
		directory(root, create);
		directory(pathOf(runId), create);
	}
	function usage() {
		let bytes = 0, sources = 0;
		for (const name of fs.readdirSync(root)) {
			if (!KEY.test(name) || !fs.lstatSync(join(root, name)).isDirectory()) continue;
			sources++;
			try { bytes += fs.lstatSync(join(root, name, "transcript.jsonl")).size; } catch {}
		}
		return { bytes, sources };
	}
	function publish({ runId, sessionKey, transcriptPath, baseSha, venue, piVersion, attempt = 0 } = {}) {
		if (!root) return refused("unconfigured");
		let lock;
		try {
			directory(root, true);
			const before = usage();
			if (!ID.test(runId ?? "") || !KEY.test(sessionKey ?? "") || !SHA.test(baseSha ?? "") || !TOKEN.test(venue ?? "") || !/^\d+\.\d+\.\d+$/.test(piVersion ?? "") || !Number.isSafeInteger(attempt) || attempt < 0) return refused("invalid");
			const existed = fs.existsSync(pathOf(runId));
			if (!existed && before.sources >= L.maxSources) return refused("capacity");
			dirs(runId, true);
			if (fs.existsSync(join(pathOf(runId), "unsafe-base"))) return { refused: "fork-unsafe-extensions" };
			lock = fs.openSync(join(pathOf(runId), "publish.lock"), "wx", 0o600);
			const bytes = readRegular(transcriptPath, L.maxBytes);
			parseEntries(bytes);
			const old = read({ runId });
			if (old.ok) return old.manifest.transcriptSha256 === digest(bytes) ? { ok: true, sourceDigest: old.manifest.sourceDigest, manifest: old.manifest } : refused("immutable");
			if (fs.existsSync(join(pathOf(runId), "manifest.json"))) return refused("corrupt");
			if (before.bytes + bytes.length > L.maxStoreBytes) return refused("capacity");
			const body = { v: 1, runId, sessionKey, baseSha, venue, piVersion, attempt, host, hostQueue, at: now(), bytes: bytes.length, transcriptSha256: digest(bytes) };
			const manifest = { ...body, sourceDigest: digest(JSON.stringify(body)) };
			if (!validManifest(manifest)) return refused("invalid");
			// The manifest rename is the commit point. A crash before it leaves no readable source.
			fs.rmSync(join(pathOf(runId), "transcript.jsonl"), { force: true });
			durable(join(pathOf(runId), "transcript.jsonl"), bytes);
			const incoming = join(pathOf(runId), `manifest.${randomBytes(8).toString("hex")}.incoming`);
			durable(incoming, JSON.stringify(manifest));
			fs.renameSync(incoming, join(pathOf(runId), "manifest.json"));
			syncDir(pathOf(runId));
			return { ok: true, sourceDigest: manifest.sourceDigest, manifest };
		} catch (e) { return refused(e?.code === "EEXIST" ? "busy" : "unreadable"); }
		finally { if (lock !== undefined) { fs.closeSync(lock); fs.rmSync(join(pathOf(runId), "publish.lock"), { force: true }); } }
	}
	function read({ runId, sourceDigest, entryId, position = "before" } = {}) {
		if (!root) return refused("unconfigured");
		if (!ID.test(runId ?? "") || (sourceDigest !== undefined && !HEX.test(sourceDigest))) return refused("invalid");
		try {
			dirs(runId);
			if (fs.existsSync(join(pathOf(runId), "unsafe-base"))) return { refused: "fork-unsafe-extensions" };
			const manifest = JSON.parse(readRegular(join(pathOf(runId), "manifest.json"), 8192));
			if (!validManifest(manifest) || manifest.runId !== runId) return refused("corrupt");
			const { sourceDigest: expected, ...body } = manifest;
			if (digest(JSON.stringify(body)) !== expected) return refused("corrupt");
			if (sourceDigest !== undefined && sourceDigest !== expected) return refused("changed");
			if (now() - manifest.at > L.ttlMs || manifest.at > now()) return refused("expired");
			const transcriptPath = join(pathOf(runId), "transcript.jsonl");
			const bytes = readRegular(transcriptPath, L.maxBytes);
			if (bytes.length !== manifest.bytes || digest(bytes) !== manifest.transcriptSha256) return refused("corrupt");
			const entries = parseEntries(bytes);
			const firstUser = entries.find((e) => e.type === "message" && e.role === "user");
			// Load at most the point cap once. A long transcript must not turn preview into two
			// filesystem opens per entry (an 8 MiB transcript can hold thousands of metadata entries).
			const points = new Map();
			try {
				directory(pointsOf(runId));
				const names = fs.readdirSync(pointsOf(runId)).filter((n) => /^[0-9a-f]{64}\.json$/.test(n));
				if (names.length > L.maxPoints) return refused("corrupt");
				for (const name of names) {
					const p = JSON.parse(readRegular(join(pointsOf(runId), name), 8192));
					if (ENTRY.test(p.entryId ?? "") && p.position === "at" && name === `${pointKey(p.entryId, p.position)}.json`) {
						const valid = pointRecord(runId, p.entryId, p.position);
						if (valid) points.set(p.entryId, valid);
					}
				}
			} catch (e) {
				if (retryableStoreError(e)) return { unavailable: e.code };
				if (e?.code !== "ENOENT") return refused("checkpoint-unreadable");
			}
			const pointFor = (e, p) => e.id === firstUser?.id && p === "before" ? { base: true } : p === "before" && e.parentId ? points.get(e.parentId) : p === "at" ? points.get(e.id) : null;
			for (const e of entries) e.positions = [...POSITIONS].filter((p) => pointFor(e, p));
			const out = { ok: true, manifest, sourceDigest: expected, transcriptPath, entries };
			if (entryId === undefined) return out;
			if (!ENTRY.test(entryId) || !POSITIONS.has(position)) return refused("invalid-entry");
			if (!entries.some((e) => e.id === entryId)) return refused("entry-missing");
			const point = pointFor(entries.find((e) => e.id === entryId), position);
			return point ? { ...out, point } : refused("checkpoint-missing");
		} catch (e) { return retryableStoreError(e) ? { unavailable: e.code } : refused(e?.code === "ENOENT" ? "missing" : "unreadable"); }
	}
	function pointRecord(runId, entryId, position) {
		try {
			directory(pointsOf(runId));
			const p = JSON.parse(readRegular(join(pointsOf(runId), `${pointKey(entryId, position)}.json`), 8192));
			if (Object.keys(p).length !== 6 || p.entryId !== entryId || p.position !== position || !Number.isSafeInteger(p.seq) || p.seq < 1 || !HEX.test(p.transcriptSha256) || !Number.isSafeInteger(p.bytes) || p.bytes < 0 || !SHA.test(p.baseSha)) return null;
			return p;
		} catch (error) { if (retryableStoreError(error)) throw error; return null; }
	}
	async function primeBase(args = {}) {
		if (!root || !ID.test(args.runId ?? "")) return refused("invalid");
		try {
			directory(root, true);
			if (!fs.existsSync(pathOf(args.runId)) && usage().sources >= L.maxSources) return refused("capacity");
			dirs(args.runId, true);
			const originPath = join(pathOf(args.runId), "origin.json");
			try { durable(originPath, JSON.stringify({ runId: args.runId, at: now() })); }
			catch (e) { if (e?.code !== "EEXIST") throw e; }
		} catch { return refused("unreadable"); }
		if (archiveBusy) return refused("busy");
		archiveBusy = true;
		try {
			const maxStore = checkpointLimits.maxStoreBytes ?? DEFAULT_CHECKPOINT_LIMITS.maxStoreBytes;
			const maxBase = checkpointLimits.maxBaseBytes ?? DEFAULT_CHECKPOINT_LIMITS.maxBaseBytes;
			const before = await archive.usage?.();
			if (before?.bytes !== undefined && before.bytes + maxBase > maxStore) return refused("capacity");
			const primed = await archive.primeBase({ ...args, objectFormat: args.objectFormat ?? (args.baseSha?.length === 64 ? "sha256" : "sha1") });
			const after = primed?.ok ? await archive.usage?.() : null;
			if (after?.bytes > maxStore) {
				await archive.remove?.(args.runId);
				return refused("capacity");
			}
			if (primed?.baseHasExtensions) {
				try { durable(join(pathOf(args.runId), "unsafe-base"), "1\n"); } catch {}
				return { refused: "fork-unsafe-extensions" };
			}
			return primed;
		} catch { return refused("unreadable"); }
		finally { archiveBusy = false; }
	}
	async function capturePoint({ runId, entryId, position = "at", transcriptPath, offset, ...args } = {}) {
		if (!root || !ID.test(runId ?? "") || (entryId !== undefined && !ENTRY.test(entryId)) || !POSITIONS.has(position) || !Number.isSafeInteger(offset) || offset <= 0 || offset > L.maxBytes || !["frozen", "dead"].includes(args.quiesced)) return refused("invalid");
		if (archiveBusy) return refused("busy");
		archiveBusy = true;
		try {
			dirs(runId);
			directory(pointsOf(runId), true);
			const bytes = readRegular(transcriptPath, L.maxBytes).subarray(0, offset);
			if (bytes.length !== offset) return refused("checkpoint-mismatch");
			entryId ??= forkPointEntry(bytes);
			if (!ENTRY.test(entryId ?? "")) return refused("checkpoint-unsafe");
			if (pointRecord(runId, entryId, position)) return { ok: true, unchanged: true };
			const names = fs.readdirSync(pointsOf(runId)).filter((n) => /^[0-9a-f]{64}\.json$/.test(n));
			if (names.length >= L.maxPoints) return refused("point-capacity");
			const entries = parseEntries(bytes);
			if (entries.at(-1)?.id !== entryId || forkPointEntry(bytes) !== entryId || position !== "at") return refused("checkpoint-mismatch");
			const current = await archive.readManifest(runId);
			const seq = current.ok ? current.manifest.seq + 1 : 1;
			if (seq > L.maxPoints) return refused("point-capacity");
			const saved = await archive.snapshot({ ...args, runId, seq, transcript: { srcFile: transcriptPath, offset } });
			if (!saved.ok) return saved;
			if (saved.manifest.workspace.partial || saved.manifest.workspace.ignoredDropped) return refused("checkpoint-partial");
			const point = { entryId, position, seq, transcriptSha256: saved.manifest.transcript.sha256, bytes: offset, baseSha: args.baseSha };
			if (point.transcriptSha256 !== digest(bytes)) return refused("checkpoint-mismatch");
			durable(join(pointsOf(runId), `${pointKey(entryId, position)}.json`), JSON.stringify(point));
			syncDir(pointsOf(runId));
			return { ok: true, point };
		} catch { return refused("checkpoint-unreadable"); }
		finally { archiveBusy = false; }
	}
	async function readPoint(options) {
		try {
			const source = read(options);
			if (!source.ok) return source;
			if (archive.readBase) {
				const base = await archive.readBase(options.runId);
				if (base?.unavailable) return base;
				if (!base?.ok || base.baseSha !== source.manifest.baseSha) return refused("base-missing");
			}
			if (source.point?.base) return source;
			if (!source.point) return refused("checkpoint-missing");
			const saved = await archive.readManifest(options.runId, { seq: source.point.seq });
			if (saved?.unavailable) return saved;
			if (saved?.reason === "internal-error") return { unavailable: "checkpoint-unreadable" };
			if (!saved.ok || saved.manifest.workspace.partial || saved.manifest.workspace.ignoredDropped || saved.manifest.transcript.sha256 !== source.point.transcriptSha256 || saved.manifest.transcript.bytes !== source.point.bytes || saved.manifest.workspace.baseSha !== source.manifest.baseSha) return refused("checkpoint-mismatch");
			// Bind the archived prefix to THIS immutable source, not merely to an entry id repeated elsewhere.
			const prefix = readRegular(source.transcriptPath, L.maxBytes).subarray(0, source.point.bytes);
			if (digest(prefix) !== source.point.transcriptSha256 || forkPointEntry(prefix) !== source.point.entryId) return refused("checkpoint-mismatch");
			return { ...source, checkpoint: saved.manifest };
		} catch (error) {
			return retryableStoreError(error) ? { unavailable: error.code } : { unavailable: "checkpoint-unreadable" };
		}
	}
	async function restorePoint({ intoWorkspace, ...options }) {
		const source = await readPoint(options);
		if (!source.ok || source.point.base) return source;
		const restored = await archive.restore({ runId: options.runId, manifest: source.checkpoint, intoWorkspace });
		return restored.refused || restored.skipped || restored.unavailable ? restored : { ok: true, ...restored };
	}
	async function sweep() {
		if (!root) return { removed: 0 };
		let removed = 0;
		try {
			directory(root);
			for (const key of fs.readdirSync(root)) {
				if (!KEY.test(key) || !fs.lstatSync(join(root, key)).isDirectory()) continue;
				let runId, at;
				try { const m = JSON.parse(readRegular(join(root, key, "manifest.json"), 8192)); if (validManifest(m) && forkSourceKey(m.runId) === key) { runId = m.runId; at = m.at; } } catch {}
				if (at === undefined) {
					try {
						const origin = JSON.parse(readRegular(join(root, key, "origin.json"), 4096));
						if (Object.keys(origin).length === 2 && ID.test(origin.runId ?? "") && forkSourceKey(origin.runId) === key && Number.isSafeInteger(origin.at) && origin.at >= 0) { runId = origin.runId; at = origin.at; }
					} catch {}
				}
				if (at === undefined) at = fs.lstatSync(join(root, key)).mtimeMs;
				if (now() - at <= L.ttlMs) continue;
				if (runId) await archive.remove(runId);
				fs.rmSync(join(root, key), { recursive: true, force: true });
				removed++;
			}
			return { removed };
		} catch { return refused("sweep-failed"); }
	}
	return { publish, read, primeBase, capturePoint, readPoint, restorePoint, sweep, baseSourceUrl: (runId) => archive?.baseSourceUrl(runId) };
}
