import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { sanitizeJobId } from "./run-history.mjs";

/**
 * sandbox-store.mjs -- the host side of a resurrectable sandbox (REQ-RESURRECTABLE-SANDBOX,
 * INT-SANDBOX-CONTRACT).
 *
 * A job container is still single-use and still `--rm`s. What survives it, for a bounded window, is the
 * per-job DIRECTORY: `cleanup` renames it here instead of deleting it, and `pi-dispatch sandbox` later
 * mounts it into a fresh container. Nothing about the job path changes -- with the window at 0 this
 * module is never reached and `cleanup` is byte-for-byte the `rm -rf` it always was.
 *
 * A SIBLING of makeLogReaper and of session-store's reapSessions rather than a widening of either: that
 * one's `.log`/`.json` filter and logsDir scope are a documented contract, and these directories have a
 * different retention policy and a different PII class again. Same never-throws shape, and three
 * DELIBERATE divergences from makeLogReaper, each of which would be a silent bug if copied from it:
 *
 *   - `lstatSync`, never `statSync`. The retained tree is agent-written; a symlink planted in it resolves
 *     on the HOST when the reaper stats it. session-store.mjs:192-201 records this lesson and
 *     makeLogReaper is the habit that predates it.
 *   - Age comes from the manifest's `createdAt`, never from mtime. makeLogReaper calls mtime "the
 *     authority" and is right about an append-once log file. Here an operator working inside a resurrected
 *     sandbox writes into the directory, so mtime would keep moving and the window would never close --
 *     for exactly the directories most likely to be large.
 *   - A directory whose sandbox container is RUNNING is skipped. The sweep runs at worker boot and on the retention timer, an
 *     operator's shell can outlive a worker restart by design (the container is named outside the
 *     `pi-job-` reaper's filter), and deleting a live bind mount underneath it is a confusing failure
 *     with a boring cause.
 *
 * NEVER THROWS, on any path. Retention is a convenience layered onto a job that has already finished and
 * already been paid for; a disk fault here must degrade to "not resurrectable" and never to a failed run.
 */

/** The manifest filename inside a retained directory. */
export const SANDBOX_MANIFEST = "manifest.json";

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

const defaultFs = { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync };

/**
 * Retain one finished job's directory, or delete it.
 *
 * Called by `makeCleanup` in place of the bare `rm -rf`. Returns the written manifest, or `null` when
 * nothing was retained -- and on `null` the caller has nothing left to do, because every failure path
 * here removes `jobDir` itself. Retention must never leave debris behind.
 *
 * `prepared.sandbox` is `{ jobId, kind, image }`, stamped by `makePrepareWorkspace`. Absent (a bare
 * construction, a test, an unwired dispatcher) means no retention, which keeps such a caller on exactly
 * the pre-feature path.
 */
export function retainJobDir(prepared, { sandboxDir, fs = defaultFs, log = () => {}, now = () => Date.now() } = {}) {
	const jobDir = prepared?.jobDir;
	const meta = prepared?.sandbox;
	if (!jobDir) return null;
	if (!sandboxDir || !meta?.jobId) {
		discard(jobDir, fs);
		return null;
	}

	const dest = join(sandboxDir, sanitizeJobId(meta.jobId));
	try {
		// FIRST, and load-bearing rather than hygiene. The per-job transcript copy is the most PII-bearing
		// artifact this system holds -- tool output, file contents, the agent's own reasoning -- and it
		// belongs to PI_SESSIONS_DIR's own TTL (INT-SESSION-STORE-CONTRACT). Carrying it into a directory
		// with a different, operator-extendable lifetime would silently extend that TTL, which is not a
		// weakening of the session policy so much as an end-run around it.
		fs.rmSync(join(jobDir, "session"), { recursive: true, force: true });

		fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
		// A BullMQ retry reuses the job id, so the previous attempt may already be sitting at `dest`. Last
		// attempt wins: it is the one whose workspace matches the run the operator just watched.
		fs.rmSync(dest, { recursive: true, force: true });
		fs.renameSync(jobDir, dest);

		const manifest = {
			jobId: meta.jobId,
			kind: meta.kind ?? null,
			image: meta.image ?? null,
			workspace: rebaseWorkspace(prepared.workspace, jobDir, dest),
			createdAt: new Date(now()).toISOString(),
			keepUntil: null,
		};
		fs.writeFileSync(join(dest, SANDBOX_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
		log("sandbox_retained", { jobId: meta.jobId, kind: manifest.kind });
		return manifest;
	} catch (err) {
		// Fall back to the behaviour retention replaced. Both paths are attempted because the rename may
		// have already moved the tree, in which case `jobDir` no longer exists and `dest` is the debris.
		log("sandbox_retain_failed", { jobId: meta.jobId, reason: err?.message });
		discard(jobDir, fs);
		discard(dest, fs);
		return null;
	}
}

/**
 * Where the sandbox's `/workspace` lives once the directory has moved.
 *
 * A forge job's workspace is a subdirectory of jobDir (prepare-github.mjs), so it travels with the rename
 * and its recorded path must be rebased. A local job's workspace IS the operator's own folder, outside
 * jobDir entirely, and must be recorded verbatim -- it was never ours to move.
 *
 * Decided by path containment rather than by `kind`, so a preparer that changes where it puts a clone
 * cannot silently record a path that does not exist.
 */
function rebaseWorkspace(workspace, jobDir, dest) {
	if (!workspace) return null;
	const rel = relative(jobDir, workspace);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return workspace;
	return join(dest, rel);
}

/** Best-effort removal. Swallows everything: this is already the failure path. */
function discard(dir, fs) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// nothing left to try
	}
}

/** One retained run by (raw) job id, or null when absent, unreadable or not JSON. */
export function readManifest({ sandboxDir, jobId, fs = defaultFs }) {
	if (!sandboxDir || jobId === undefined || jobId === null) return null;
	const dir = join(sandboxDir, sanitizeJobId(jobId));
	try {
		const manifest = JSON.parse(fs.readFileSync(join(dir, SANDBOX_MANIFEST), "utf8"));
		return { ...manifest, dir };
	} catch {
		return null;
	}
}

/**
 * Every retained run, newest first. A filename-keyed scan of one directory, exactly like
 * makeFindPreviousRun's -- no index, no database, no new query surface (DES-RUN-HISTORY-FLAT-FILES-NO-DB).
 * An entry with no readable manifest is skipped rather than surfaced: it cannot be resurrected, and the
 * reaper removes it on the next sweep.
 */
export function listSandboxes({ sandboxDir, fs = defaultFs }) {
	if (!sandboxDir) return [];
	let names;
	try {
		names = fs.readdirSync(sandboxDir);
	} catch {
		return [];
	}
	const out = [];
	for (const name of names) {
		const dir = join(sandboxDir, name);
		try {
			const manifest = JSON.parse(fs.readFileSync(join(dir, SANDBOX_MANIFEST), "utf8"));
			out.push({ ...manifest, dir });
		} catch {
			// unreadable or not a retained directory
		}
	}
	return out.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

/**
 * Extend one run's retention to `now + pinDays`, and say so on disk.
 *
 * Bounded on purpose: `keepUntil` is a timestamp, never a boolean. "Keep this one" that means "forever"
 * is how a directory holding a full repository clone per run becomes unbounded, and the acceptance this
 * feature was written against says retention stays swept.
 */
export function pinSandbox({ sandboxDir, jobId, pinDays, fs = defaultFs, now = () => Date.now() }) {
	const manifest = readManifest({ sandboxDir, jobId, fs });
	if (!manifest) return { pinned: false, reason: "absent" };
	const keepUntil = new Date(now() + pinDays * DAY_MS).toISOString();
	const { dir, ...body } = manifest;
	try {
		fs.writeFileSync(join(dir, SANDBOX_MANIFEST), `${JSON.stringify({ ...body, keepUntil }, null, 2)}\n`, { mode: 0o600 });
		return { pinned: true, keepUntil };
	} catch (err) {
		return { pinned: false, reason: err?.message ?? "write-failed" };
	}
}

/**
 * The retention sweep: at boot, and on the timer since issue #292 (`PI_SWEEP_INTERVAL_HOURS`). Fault isolation is the contract, mirroring makeLogReaper and makeReaper: `reapSandboxes`
 * NEVER throws under any input, and one bad entry cannot abort the rest of the sweep.
 *
 * There is NO keep-forever sentinel here, unlike PI_LOG_RETENTION_DAYS and PI_SESSIONS_TTL_DAYS.
 * `retentionHours === 0` is the feature being OFF, and it needs no special case: the cutoff becomes `now`,
 * so every unpinned directory is already expired and gets swept. Turning retention off therefore also
 * cleans up what an earlier setting retained, while an explicit `--pin` still runs to its own deadline --
 * an operator's deliberate act outliving a config change is the behaviour worth having.
 *
 * `listRunning` yields the JOB IDS of live sandboxes -- ids, not container names, so this module needs to
 * know nothing about how a container is named and the two files stay acyclic. It defaults to none, so an
 * unwired reaper still sweeps; start.mjs injects the docker-backed one.
 */
export function makeSandboxReaper({
	sandboxDir,
	retentionHours,
	fs = defaultFs,
	log = () => {},
	now = () => Date.now(),
	listRunning = async () => [],
}) {
	return async function reapSandboxes() {
		if (!sandboxDir) return;
		let running = new Set();
		try {
			running = new Set(await listRunning());
		} catch (err) {
			// Could not ask docker. Sweeping blind risks pulling a mount out from under a live shell, so
			// skip this sweep entirely: a directory kept one boot too long is the cheaper mistake.
			log("sandbox_reaper_skipped", { reason: err?.message ?? "running-lookup-failed" });
			return;
		}

		let names;
		try {
			names = fs.readdirSync(sandboxDir);
		} catch (err) {
			log("sandbox_reaper_skipped", { reason: err?.message });
			return;
		}

		const at = now();
		const cutoff = at - retentionHours * HOUR_MS;
		for (const name of names) {
			const dir = join(sandboxDir, name);
			try {
				// lstat: a symlink here resolves on the host, and this tree is agent-written.
				if (!fs.lstatSync(dir).isDirectory()) {
					fs.rmSync(dir, { recursive: true, force: true });
					log("reaped_sandbox", { entry: name, reason: "not-a-directory" });
					continue;
				}
				if (running.has(name)) continue; // an operator is inside it
				const verdict = expiry(dir, fs, at, cutoff);
				if (!verdict.expired) continue;
				fs.rmSync(dir, { recursive: true, force: true });
				log("reaped_sandbox", { entry: name, reason: verdict.reason });
				// Yield after each tree. Free at boot, where nothing is in flight; NOT free since issue
				// #292 put this on a timer beside draining jobs, because a retained directory is a
				// repository clone and `rmSync` is synchronous, so deleting a set of them back to back
				// wedges the event loop for the whole set. `index.mjs` runs with `maxStalledCount: 0`
				// against BullMQ's 30s lock, so a block past the renewal window FAILS a paid job. This
				// bounds the contiguous block to ONE directory, which is the part that cannot be yielded.
				await new Promise((resolve) => setImmediate(resolve));
			} catch (err) {
				log("sandbox_reaper_skipped", { entry: name, reason: err?.message });
			}
		}
	};
}

/**
 * Whether one retained directory is past its window.
 *
 * An unreadable, absent or unparseable manifest is EXPIRED, not skipped: without it the directory names no
 * image, no workspace and no job, so nothing can resurrect it and keeping it is just disk. A pin wins over
 * the base window while it lasts, and an unparseable `keepUntil` is treated as no pin rather than as
 * forever -- the direction that stays bounded.
 */
function expiry(dir, fs, at, cutoff) {
	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(join(dir, SANDBOX_MANIFEST), "utf8"));
	} catch {
		return { expired: true, reason: "no-manifest" };
	}
	const keepUntil = Date.parse(manifest?.keepUntil ?? "");
	if (Number.isFinite(keepUntil)) return keepUntil <= at ? { expired: true, reason: "pin-expired" } : { expired: false };
	const createdAt = Date.parse(manifest?.createdAt ?? "");
	if (!Number.isFinite(createdAt)) return { expired: true, reason: "no-created-at" };
	return createdAt < cutoff ? { expired: true, reason: "window" } : { expired: false };
}
