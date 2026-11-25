/**
 * A forge run's kept files read from the host that kept them (issue #942, `INT-ARTIFACTS-CHANNEL`): a console on another
 * host asks for a run's manifest and then a file a chunk at a time, over the deployment's own authenticated Valkey,
 * beside the history channel (`history-reader.mjs`). The worker subscribes to `artifacts:request:<host>` and answers on
 * `artifacts:reply:<nonce>`.
 *
 * PUB/SUB AND NOTHING ELSE: no key, no retained copy, no queued job and no listener on the host's network. The bytes go
 * a chunk at a time (`ARTIFACTS_CHUNK_BYTES`, one request per chunk, the reader asking for the next only once the last
 * answered), so no message carries more than one chunk and nothing stores a file. Retention stays with the host that
 * kept the files: a run its sweep removed is `missing`, and an earlier worker that does not subscribe never answers.
 *
 * WHAT A REQUEST CAN NAME: a run's id and a file's name, never a path. The folder is `artifactRunDirOf(run)` and the
 * file is the manifest's entry of that name, so a name the manifest does not list opens nothing under `files/`. The
 * run's folder and its `files/` are `lstat`ed and refused unless plain folders; the manifest and the file are opened
 * `O_NOFOLLOW` and held to plain files by `fstat`; the manifest is read bounded and must be this run's. Every chunk
 * request carries the digest its reader holds, and a file whose digest or size no longer matches the manifest is
 * `changed`. The reader holds the bytes to the manifest it validated; this side never vouches for a whole file.
 *
 * TWO DIFFERENCES FROM THE HISTORY CHANNEL, on purpose. Up to `ARTIFACTS_HOST_CONCURRENCY` requests at once rather
 * than one, with its own count, so a download never starves history browsing and two readers can share a host. And
 * stateless: the manifest is read again for every request and nothing stays open between requests, so there is no
 * cursor to expire and no handle to leak.
 *
 * A LEAF: node builtins and `artifacts-record.mjs` only, so the console imports the readers without the worker.
 */
import { constants, promises as fsPromises } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ARTIFACT_NAME_RE, ARTIFACTS_FILES_DIR, ARTIFACTS_MANIFEST, ARTIFACTS_MANIFEST_MAX_BYTES, artifactRunDirOf, artifactsManifestOf } from "./artifacts-record.mjs";

/** The channel a host listens on (`<prefix><host>`) and the one a reader waits on (`<prefix><nonce>`). */
export const ARTIFACTS_REQUEST_PREFIX = "artifacts:request:";
export const ARTIFACTS_REPLY_PREFIX = "artifacts:reply:";
/** The largest request a host reads, in bytes of its JSON; a longer body is not parsed and gets no reply. */
export const ARTIFACTS_REQUEST_MAX = 1024;
/** Raw bytes per chunk: 256 KiB once base64, the history channel's largest message. */
export const ARTIFACTS_CHUNK_BYTES = 192 * 1024;
/** The largest reply a reader takes: a whole chunk in base64 and its few fields. */
export const ARTIFACTS_REPLY_MAX = 256 * 1024 + 1024;
/** Requests one host serves at once; the next is answered `host-busy`. */
export const ARTIFACTS_HOST_CONCURRENCY = 4;
/** How long a reader waits for one reply unless told otherwise. */
export const ARTIFACTS_READ_MS = 5000;

const NONCE = /^[a-f0-9]{32}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN = /^[A-Za-z0-9._:-]{1,200}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const HOST_ERRORS = Object.freeze(["invalid-request", "artifacts-unreadable", "host-busy"]);
// Read only, never through a link, and without blocking: a FIFO in a file's place would otherwise hold the open, and with
// it one of the host's request slots, until something wrote to it. `fstat` then refuses it as no plain file.
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);
const token = () => randomBytes(16).toString("hex");
const objectOf = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : null);
const keysAre = (m, keys) => Object.keys(m).length === keys.length && keys.every((k) => Object.hasOwn(m, k));
const isMissing = (e) => e?.code === "ENOENT";

/** The request `m` as a host takes it, or null when it breaks a rule. Its `id` is the caller's to check. */
function requestOf(m) {
	if (typeof m.run !== "string" || !RUN.test(m.run) || artifactRunDirOf(m.run) === null) return null;
	if (m.op === "manifest") return keysAre(m, ["id", "run", "op"]) ? { op: "manifest", run: m.run } : null;
	if (m.op !== "chunk" || !keysAre(m, ["id", "run", "op", "name", "sha256", "offset"])) return null;
	if (typeof m.name !== "string" || !ARTIFACT_NAME_RE.test(m.name) || typeof m.sha256 !== "string" || !SHA256.test(m.sha256)) return null;
	if (!Number.isSafeInteger(m.offset) || m.offset < 0 || m.offset % ARTIFACTS_CHUNK_BYTES !== 0) return null;
	return { op: "chunk", run: m.run, name: m.name, sha256: m.sha256, offset: m.offset };
}

/** Whether `path` is a plain folder: true, false for anything else (a link included), null when nothing is there. */
async function plainFolder(fs, path) {
	try {
		return (await fs.lstat(path)).isDirectory();
	} catch (e) {
		if (isMissing(e)) return null;
		throw e;
	}
}

/** Up to `length` bytes of `file` from `position`, fewer when it ends first. Positional, so nothing shares a cursor. */
async function readAt(file, length, position) {
	const buffer = Buffer.alloc(length);
	let got = 0;
	while (got < length) {
		const { bytesRead } = await file.read(buffer, got, length - got, position + got);
		if (bytesRead === 0) break;
		got += bytesRead;
	}
	return got === length ? buffer : buffer.subarray(0, got);
}

/** The run's manifest and folder, `{ missing }` when either is not there, or `{ error }`. */
async function manifestOf(fs, storeDir, run) {
	const runDir = join(storeDir, artifactRunDirOf(run));
	const folder = await plainFolder(fs, runDir);
	if (folder === null) return { missing: true };
	if (!folder) return { error: "artifacts-unreadable" };
	let file;
	try {
		file = await fs.open(join(runDir, ARTIFACTS_MANIFEST), OPEN_FLAGS);
		const st = await file.stat();
		if (!st.isFile() || st.size > ARTIFACTS_MANIFEST_MAX_BYTES) return { error: "artifacts-unreadable" };
		// One byte past what `fstat` said, so a manifest that grew since is caught at the bound rather than cut.
		const bytes = await readAt(file, st.size + 1, 0);
		if (bytes.length > ARTIFACTS_MANIFEST_MAX_BYTES) return { error: "artifacts-unreadable" };
		const manifest = artifactsManifestOf(bytes.toString("utf8"));
		// Two job ids can share a folder (`a:b` and `a_b`), so the manifest must name this one.
		return manifest !== null && manifest.jobId === run ? { manifest, runDir } : { error: "artifacts-unreadable" };
	} catch (e) {
		return isMissing(e) ? { missing: true } : { error: "artifacts-unreadable" };
	} finally {
		await file?.close().catch(() => {});
	}
}

/** One chunk of a listed file, by the manifest's entry and never by the request's name. */
async function chunkOf(fs, storeDir, req) {
	const found = await manifestOf(fs, storeDir, req.run);
	if (!found.manifest) return found;
	const entry = found.manifest.files.find((f) => f.name === req.name);
	if (!entry) return { missing: true };
	if (entry.sha256 !== req.sha256) return { changed: true };
	const filesDir = join(found.runDir, ARTIFACTS_FILES_DIR);
	const folder = await plainFolder(fs, filesDir);
	if (folder === null) return { missing: true };
	if (!folder) return { error: "artifacts-unreadable" };
	let file;
	try {
		file = await fs.open(join(filesDir, entry.name), OPEN_FLAGS);
		const st = await file.stat();
		if (!st.isFile() || st.size !== entry.size) return { changed: true };
		if (entry.size === 0 ? req.offset !== 0 : req.offset >= entry.size) return { error: "invalid-request" };
		const length = Math.min(ARTIFACTS_CHUNK_BYTES, entry.size - req.offset);
		const bytes = await readAt(file, length, req.offset);
		if (bytes.length !== length) return { changed: true };
		return { offset: req.offset, data: bytes.toString("base64"), last: req.offset + length === entry.size };
	} catch (e) {
		if (isMissing(e)) return { missing: true };
		// A link in the file's place: `O_NOFOLLOW` refuses it, and a link is no longer the plain file that was kept.
		return e?.code === "ELOOP" ? { changed: true } : { error: "artifacts-unreadable" };
	} finally {
		await file?.close().catch(() => {});
	}
}

/**
 * Serve this host's artifacts store on `artifacts:request:<host>`. Resolves to `{ close() }` once subscribed and rejects
 * when the subscription fails or takes longer than `timeoutMs`; the worker logs that and boots anyway. A request that
 * does not parse, or has no valid `id`, gets no reply; one that breaks another rule gets `invalid-request`.
 */
export async function serveArtifacts({ redis, host, storeDir, fs = fsPromises, timeoutMs = 5000 }) {
	if (typeof host !== "string" || !HOST.test(host)) throw new TypeError("invalid artifacts host");
	if (typeof storeDir !== "string" || storeDir === "") throw new TypeError("invalid artifacts store");
	const sub = redis.duplicate();
	sub.on("error", () => {});
	const channel = ARTIFACTS_REQUEST_PREFIX + host;
	let active = 0;
	let closed = false;
	const receive = async (from, body) => {
		if (closed || from !== channel || typeof body !== "string" || body.length > ARTIFACTS_REQUEST_MAX || Buffer.byteLength(body) > ARTIFACTS_REQUEST_MAX) return;
		let m;
		try { m = objectOf(JSON.parse(body)); } catch { return; }
		if (m === null || typeof m.id !== "string" || !NONCE.test(m.id)) return;
		const req = requestOf(m);
		let result;
		if (req === null) result = { error: "invalid-request" };
		else if (active >= ARTIFACTS_HOST_CONCURRENCY) result = { error: "host-busy" };
		else {
			active++;
			try {
				if (req.op === "chunk") result = await chunkOf(fs, storeDir, req);
				else {
					const found = await manifestOf(fs, storeDir, req.run);
					result = found.manifest ? { manifest: found.manifest } : found;
				}
			} catch {
				result = { error: "artifacts-unreadable" };
			} finally {
				active--;
			}
		}
		let reply = JSON.stringify(result);
		// A reader drops a reply over its bound and would wait out its timeout; say unreadable instead.
		if (Buffer.byteLength(reply) > ARTIFACTS_REPLY_MAX) reply = JSON.stringify({ error: "artifacts-unreadable" });
		if (!closed) await redis.publish(ARTIFACTS_REPLY_PREFIX + m.id, reply);
	};
	const onMessage = (from, body) => { receive(from, body).catch(() => {}); };
	sub.on("message", onMessage);
	let timer;
	try {
		await Promise.race([sub.subscribe(channel), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("artifacts subscription timed out")), timeoutMs); })]);
	} catch (e) {
		sub.disconnect();
		throw e;
	} finally {
		clearTimeout(timer);
	}
	return {
		async close() {
			closed = true;
			sub.off("message", onMessage);
			sub.disconnect();
		},
	};
}

/** A reply body as an object, or null when it is over `ARTIFACTS_REPLY_MAX` or is not a JSON object. */
function replyOf(body) {
	if (typeof body !== "string" || body.length > ARTIFACTS_REPLY_MAX || Buffer.byteLength(body) > ARTIFACTS_REPLY_MAX) return null;
	try { return objectOf(JSON.parse(body)); } catch { return null; }
}

/** The answers both readers take alike: `missing`, and a host's closed error words. Null for anything else. */
function commonOf(r) {
	if (keysAre(r, ["missing"]) && r.missing === true) return { missing: true };
	if (keysAre(r, ["error"]) && HOST_ERRORS.includes(r.error)) return { error: r.error };
	return null;
}

/**
 * Ask `host` for run `jobId`'s manifest. Resolves to `{ manifest }` (rebuilt by `artifactsManifestOf` and naming
 * `jobId`, else `{ error: "artifacts-unreadable" }`), `{ missing: true }`, or `{ error }`: `host-unavailable` when no
 * answer comes within `timeoutMs` or the subscription fails. A reply in no shape the contract names is ignored. Never
 * throws, and closes its own subscription.
 */
export async function readHostArtifactsManifest({ redis, host, jobId, timeoutMs = ARTIFACTS_READ_MS, random = token } = {}) {
	if (!redis || typeof host !== "string" || !HOST.test(host)) return { error: "host-unavailable" };
	let sub;
	let timer;
	try {
		const id = random();
		const request = { id, run: jobId, op: "manifest" };
		if (requestOf(request) === null) return { error: "invalid-request" };
		const channel = ARTIFACTS_REPLY_PREFIX + id;
		sub = redis.duplicate();
		sub.on("error", () => {});
		return await new Promise((resolve) => {
			timer = setTimeout(() => resolve({ error: "host-unavailable" }), timeoutMs);
			sub.on("message", (from, body) => {
				if (from !== channel) return;
				const r = replyOf(body);
				if (r === null) return;
				const common = commonOf(r);
				if (common !== null) return resolve(common);
				if (!keysAre(r, ["manifest"])) return;
				const manifest = artifactsManifestOf(JSON.stringify(r.manifest) ?? "");
				resolve(manifest !== null && manifest.jobId === jobId ? { manifest } : { error: "artifacts-unreadable" });
			});
			Promise.resolve()
				.then(() => sub.subscribe(channel))
				.then(() => redis.publish(ARTIFACTS_REQUEST_PREFIX + host, JSON.stringify(request)))
				.catch(() => resolve({ error: "host-unavailable" }));
		});
	} catch {
		return { error: "host-unavailable" };
	} finally {
		clearTimeout(timer);
		try { sub?.disconnect(); } catch {}
	}
}

/**
 * One file's transfer from `host`: ONE reply subscription for its life, and requests sent one at a time. Resolves to
 * `{ chunk, close }`, or `{ error: "host-unavailable" }` when the subscription fails or takes longer than `timeoutMs`.
 *
 * `chunk({ name, sha256, offset, timeoutMs })` resolves to `{ offset, data, last }` (`data` a Buffer) only for a reply
 * whose `offset` is the request's, whose `data` is strict base64 of at most `ARTIFACTS_CHUNK_BYTES` bytes and whose
 * `last` is a boolean; or `{ missing: true }`, `{ changed: true }` or `{ error }`. A reply over `ARTIFACTS_REPLY_MAX`, for
 * another offset or in no shape the contract names is ignored, and the wait then ends as `host-unavailable`. It never
 * throws. The caller holds each chunk's length and the whole file's digest to the manifest IT validated: this reader
 * does not know the size.
 */
export async function openHostArtifactTransfer({ redis, host, jobId, random = token, timeoutMs = ARTIFACTS_READ_MS } = {}) {
	if (!redis || typeof host !== "string" || !HOST.test(host)) return { error: "host-unavailable" };
	let sub;
	let id;
	let waiting = null;
	let closed = false;
	const settle = (value) => {
		const w = waiting;
		waiting = null;
		w?.resolve(value);
	};
	try {
		id = random();
		const channel = ARTIFACTS_REPLY_PREFIX + id;
		sub = redis.duplicate();
		sub.on("error", () => {});
		sub.on("message", (from, body) => {
			if (from !== channel || waiting === null) return;
			const r = replyOf(body);
			if (r === null) return;
			const common = commonOf(r) ?? (keysAre(r, ["changed"]) && r.changed === true ? { changed: true } : null);
			if (common !== null) return settle(common);
			if (!keysAre(r, ["offset", "data", "last"]) || r.offset !== waiting.offset || typeof r.last !== "boolean" || typeof r.data !== "string") return;
			// Strict: Buffer's decoder skips what is not base64, so only a string that encodes back to itself is taken.
			const data = Buffer.from(r.data, "base64");
			if (data.length > ARTIFACTS_CHUNK_BYTES || data.toString("base64") !== r.data) return;
			settle({ offset: r.offset, data, last: r.last });
		});
		let timer;
		try {
			await Promise.race([Promise.resolve().then(() => sub.subscribe(channel)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("artifacts reply subscription timed out")), timeoutMs); })]);
		} finally {
			clearTimeout(timer);
		}
	} catch {
		try { sub?.disconnect(); } catch {}
		return { error: "host-unavailable" };
	}
	const one = async (args) => {
		const { name, sha256, offset, timeoutMs: wait = ARTIFACTS_READ_MS } = objectOf(args) ?? {};
		if (closed) return { error: "host-unavailable" };
		const request = { id, run: jobId, op: "chunk", name, sha256, offset };
		if (requestOf(request) === null) return { error: "invalid-request" };
		let timer;
		try {
			return await new Promise((resolve) => {
				waiting = { offset, resolve };
				timer = setTimeout(() => settle({ error: "host-unavailable" }), wait);
				Promise.resolve()
					.then(() => redis.publish(ARTIFACTS_REQUEST_PREFIX + host, JSON.stringify(request)))
					.catch(() => settle({ error: "host-unavailable" }));
			});
		} finally {
			clearTimeout(timer);
		}
	};
	let queue = Promise.resolve();
	return {
		chunk(args) {
			const next = queue.then(() => one(args)).catch(() => ({ error: "host-unavailable" }));
			queue = next;
			return next;
		},
		close() {
			if (closed) return;
			closed = true;
			settle({ error: "host-unavailable" });
			try { sub.disconnect(); } catch {}
		},
	};
}
