/**
 * A forge job's artifacts (issue #920, REQ-FORGE-JOB-ARTIFACTS, INT-ARTIFACTS-STORE-CONTRACT): the files a job leaves in
 * `/artifacts` (screenshots of an application it drove, a test report, a device log) that are evidence for its reviewer
 * and must not be committed. The worker keeps them after the job, within the operator's limits, in `PI_ARTIFACTS_DIR`,
 * one folder per run, for `PI_ARTIFACTS_RETENTION_DAYS`.
 *
 * WHEN AND HOW THEY ARE READ. Once, after the container has exited (and a copying venue has brought its outputs back), so
 * nothing the agent runs can change a file between the checks and the read: the display probe's rule, writers gone before
 * the read. Top level only. Each entry is `lstat`ed and opened `O_NOFOLLOW`, and the open file is held to what was
 * checked (a regular file, the same inode and size), so a link, a folder, a device or a file swapped for one is never
 * followed. A name outside `ARTIFACT_NAME_RE` is dropped rather than renamed: the name reaches a forge comment and the
 * console as it is, and this charset leaves it no markup, mention, link or path.
 *
 * WHAT IS KEPT. The type is judged by content, never by the name: the four image types by their signatures, text when
 * the bytes are valid UTF-8 with no NUL, anything else binary. Text is scrubbed with the job's own secret values, the
 * transcript's set (`makeRedactor`). A binary file is kept as written, except that one holding a job secret literally is
 * dropped (`secret`): the workspace checkpoint's rule for a tree (`job-secret-in-tree`), since a binary cannot be scrubbed
 * without breaking it. Everything refused is COUNTED by reason and the job never fails for it.
 *
 * REJECTED: reusing `/outbox` (the runner reads its existence as the chaining protocol, and a forge job must not chain,
 * DES-JOB-OUTBOX-CHAINING); judging the type by extension (a `.png` of HTML would be served as an image); keeping the
 * files in Valkey (megabytes in the queue's memory) or in the sandbox store (its retention is a day and is about the
 * workspace, not the evidence).
 *
 * Never throws: a failure to keep is logged by the caller and the run's record says nothing was kept.
 */
import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { makeRedactor } from "./redact-secrets.mjs";
import { ARTIFACT_DROP_REASONS, ARTIFACT_NAME_RE, ARTIFACT_RUN_DIR_RE, ARTIFACT_TYPES, ARTIFACTS_FILES_DIR, ARTIFACTS_MANIFEST, ARTIFACTS_MANIFEST_VERSION, artifactRunDirOf } from "./artifacts-record.mjs";
import { isForgeKind } from "./forges.mjs";

export { ARTIFACT_DROP_REASONS, ARTIFACT_NAME_RE, ARTIFACT_RUN_DIR_RE, ARTIFACT_TYPES, ARTIFACTS_FILES_DIR, ARTIFACTS_MANIFEST, ARTIFACTS_MANIFEST_VERSION, artifactRunDirOf };


const MiB = 1024 * 1024;
const DAY_MS = 24 * 3600 * 1000;

/** The type the bytes are: an image by its signature, text when valid UTF-8 without NUL, else binary. */
export function artifactTypeOf(bytes) {
	const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
	const starts = (sig, at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
	if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
	if (starts([0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
	if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
	if (b.includes(0)) return "application/octet-stream";
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(b);
		return "text/plain";
	} catch {
		return "application/octet-stream";
	}
}


/** The limits from the settings, in bytes; `maxFiles` 0 turns the feature off. */
export function artifactLimitsOf({ maxFiles = 0, maxFileMb = 0, maxRunMb = 0 } = {}) {
	return { maxFiles, maxFileBytes: Math.min(maxFileMb, maxRunMb) * MiB, maxRunBytes: maxRunMb * MiB };
}

/**
 * Keep what `dir` holds for `jobId` under `storeDir`. Answers `{ kept, bytes, dropped }` (`dropped` a count per reason, only
 * the reasons that happened), or null when the folder is missing or held nothing, so a run that wrote none records none.
 * A retry of the same job replaces its earlier attempt's files whole.
 */
export function collectArtifacts({ dir, storeDir, jobId, limits, secretValues = [], retentionDays = 0, now = Date.now, fs = nodeFs, log = () => {} }) {
	try {
		if (typeof dir !== "string" || typeof storeDir !== "string" || !(limits?.maxFiles > 0)) return null;
		const runName = artifactRunDirOf(jobId);
		if (runName === null) return null;
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch (error) {
			if (error?.code === "ENOENT") return null;
			throw error;
		}
		if (names.length === 0) return null;
		const redact = makeRedactor({ values: secretValues });
		const secrets = secretValues.filter((v) => typeof v === "string" && v.length >= 8).map((v) => Buffer.from(v));
		const dropped = {};
		const drop = (reason) => { dropped[reason] = (dropped[reason] ?? 0) + 1; };
		const files = [];
		let total = 0;
		for (const name of [...names].sort()) {
			if (!ARTIFACT_NAME_RE.test(name)) { drop("name"); continue; }
			if (secrets.some((s) => name.includes(s.toString()))) { drop("secret"); continue; }
			const path = join(dir, name);
			let st;
			try { st = fs.lstatSync(path); } catch { drop("unreadable"); continue; }
			if (!st.isFile() || st.isSymbolicLink()) { drop("type"); continue; }
			if (files.length >= limits.maxFiles) { drop("count"); continue; }
			if (st.size > limits.maxFileBytes) { drop("size"); continue; }
			if (total + st.size > limits.maxRunBytes) { drop("total"); continue; }
			let bytes;
			let fd = null;
			try {
				fd = fs.openSync(path, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
				const held = fs.fstatSync(fd);
				if (!held.isFile() || held.ino !== st.ino || held.size !== st.size) { drop("type"); continue; }
				bytes = Buffer.alloc(held.size);
				let read = 0;
				while (read < bytes.length) {
					const n = fs.readSync(fd, bytes, read, bytes.length - read, read);
					if (n === 0) break;
					read += n;
				}
				if (read !== bytes.length) { drop("unreadable"); continue; }
			} catch {
				drop("unreadable");
				continue;
			} finally {
				if (fd !== null) try { fs.closeSync(fd); } catch {}
			}
			const type = artifactTypeOf(bytes);
			let kept = bytes;
			let scrubbed = false;
			if (type === "text/plain") {
				const text = bytes.toString("utf8");
				const clean = redact(text);
				scrubbed = clean !== text;
				kept = Buffer.from(clean, "utf8");
			} else if (secrets.some((s) => bytes.includes(s))) {
				drop("secret");
				continue;
			}
			files.push({ name, bytes: kept, type, scrubbed });
			total += kept.length;
		}
		if (files.length === 0 && Object.keys(dropped).length === 0) return null;
		const at = Number(now());
		const manifest = {
			v: ARTIFACTS_MANIFEST_VERSION,
			jobId,
			createdAt: new Date(at).toISOString(),
			keepUntil: retentionDays > 0 ? new Date(at + retentionDays * DAY_MS).toISOString() : null,
			files: files.map((f) => ({ name: f.name, size: f.bytes.length, sha256: createHash("sha256").update(f.bytes).digest("hex"), type: f.type, scrubbed: f.scrubbed })),
			dropped,
		};
		// Built beside the run's folder and renamed over it, so a reader sees one attempt's files or the next one's, whole.
		fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
		const staging = join(storeDir, `.tmp-${runName}-${randomBytes(6).toString("hex")}`);
		fs.mkdirSync(join(staging, ARTIFACTS_FILES_DIR), { recursive: true, mode: 0o700 });
		for (const f of files) fs.writeFileSync(join(staging, ARTIFACTS_FILES_DIR, f.name), f.bytes, { mode: 0o600, flag: "wx" });
		fs.writeFileSync(join(staging, ARTIFACTS_MANIFEST), `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: "wx" });
		const final = join(storeDir, runName);
		const old = join(storeDir, `.reap-${runName}-${randomBytes(6).toString("hex")}`);
		let replaced = false;
		try {
			fs.renameSync(final, old);
			replaced = true;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		fs.renameSync(staging, final);
		if (replaced) fs.rmSync(old, { recursive: true, force: true });
		return { kept: files.length, bytes: total, dropped };
	} catch (error) {
		log("artifacts_not_kept", { code: typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "error" });
		return null;
	}
}

/** The folder's name in a job's own directory, beside `workspace/` and `session/`. */
export const ARTIFACTS_JOB_SUBDIR = "artifacts";

/** Whether a job gets the folder: a forge job's flow or command, never an answer draft, a watch or a question grouping. */
export function artifactsWanted(job) {
	return isForgeKind(job?.kind) && !job.answerDraft && job.purpose !== "answer-draft" && !job.watch && !job.questionGrouping;
}

/**
 * The worker's artifacts runtime (start.mjs wires it from the settings; absent, nothing is staged or kept):
 *   - `stage(job, prepared)` makes `<jobDir>/artifacts` (0700, the worker's, like `session/`) for a job that gets one and
 *     names it `prepared.artifactsDir`, which run-container.mjs mounts at `/artifacts` on a venue that binds;
 *   - `collect(jobId, prepared, { secretValues })` keeps what it holds (`collectArtifacts`) under the id the run's record
 *     is written under, and answers the record's facts.
 * Never throws.
 */
export function makeArtifactsRuntime({ storeDir, limits, retentionDays = 0, now = Date.now, log = () => {}, fs = nodeFs } = {}) {
	const on = typeof storeDir === "string" && storeDir !== "" && limits?.maxFiles > 0;
	return {
		on,
		stage(job, prepared) {
			if (!on || !artifactsWanted(job) || typeof prepared?.jobDir !== "string") return null;
			const dir = join(prepared.jobDir, ARTIFACTS_JOB_SUBDIR);
			try {
				fs.mkdirSync(dir, { mode: 0o700 });
			} catch (error) {
				if (error?.code !== "EEXIST") {
					log("artifacts_not_staged", { code: typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "error" });
					return null;
				}
			}
			prepared.artifactsDir = dir;
			return dir;
		},
		collect(jobId, prepared, { secretValues = [] } = {}) {
			if (!on || typeof prepared?.artifactsDir !== "string") return null;
			return collectArtifacts({ dir: prepared.artifactsDir, storeDir, jobId, limits, secretValues, retentionDays, now, fs, log });
		},
	};
}

/** How long a half-written or half-removed folder (`.tmp-`, `.reap-`) may sit before the sweep removes it. */
export const ARTIFACTS_LEFTOVER_MS = 3600 * 1000;

/** When a run's files go: the earlier of its manifest's `keepUntil` and its creation plus today's setting (0 = no cut). */
export function artifactsDeadline(manifest, retentionDays) {
	const created = Date.parse(manifest?.createdAt ?? "");
	const kept = manifest?.keepUntil === null ? Infinity : Date.parse(manifest?.keepUntil ?? "");
	const now = retentionDays > 0 && Number.isFinite(created) ? created + retentionDays * DAY_MS : Infinity;
	const deadline = Math.min(Number.isFinite(kept) || kept === Infinity ? kept : Infinity, now);
	return deadline === Infinity ? null : deadline;
}

/**
 * The artifacts store's sweep (start.mjs puts it on the retention timer beside the sandbox store's): a run's folder goes
 * at `artifactsDeadline`, renamed aside first so a reader never meets half of it; a folder whose manifest cannot be read
 * goes by its age against today's setting; a leftover `.tmp-` or `.reap-` folder goes after an hour. It yields to the
 * event loop between entries and stops when the sweep closes (`stopped`, issue #924's contract for every reaper), so a
 * large store never holds up the worker's queue consumers. Never throws.
 */
export function makeArtifactsReaper({ storeDir, retentionDays = 0, now = Date.now, log = () => {}, fs = nodeFs } = {}) {
	return async function reapArtifacts({ stopped = () => false } = {}) {
		if (typeof storeDir !== "string" || storeDir === "") return { removed: 0 };
		let names;
		try {
			names = fs.readdirSync(storeDir);
		} catch (error) {
			if (error?.code !== "ENOENT") log("artifacts_reaper_skipped", { code: typeof error?.code === "string" ? error.code : "error" });
			return { removed: 0 };
		}
		const at = Number(now());
		let removed = 0;
		for (const name of names) {
			await new Promise((resolve) => setImmediate(resolve));
			if (stopped()) break;
			const path = join(storeDir, name);
			try {
				const st = fs.lstatSync(path);
				if (!st.isDirectory()) continue;
				let due;
				if (name.startsWith(".tmp-") || name.startsWith(".reap-")) due = st.mtimeMs + ARTIFACTS_LEFTOVER_MS;
				else if (!ARTIFACT_RUN_DIR_RE.test(name)) continue;
				else {
					let manifest = null;
					try { manifest = JSON.parse(fs.readFileSync(join(path, ARTIFACTS_MANIFEST), "utf8")); } catch {}
					due = manifest !== null ? artifactsDeadline(manifest, retentionDays) : (retentionDays > 0 ? st.mtimeMs + retentionDays * DAY_MS : null);
				}
				if (due === null || due > at) continue;
				const aside = name.startsWith(".reap-") ? path : join(storeDir, `.reap-${name.replace(/^\.tmp-/, "")}-${randomBytes(6).toString("hex")}`);
				if (aside !== path) fs.renameSync(path, aside);
				fs.rmSync(aside, { recursive: true, force: true });
				removed++;
			} catch (error) {
				log("artifacts_not_reaped", { code: typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "error" });
			}
		}
		if (removed > 0) log("artifacts_reaped", { removed });
		return { removed };
	};
}
