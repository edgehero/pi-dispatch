import { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { sanitizeJobId } from "./run-history.mjs";
import { scrubCredentials } from "./redact.mjs";
import { TRANSIENT_READ_ERRORS } from "./runtime-observations.mjs";

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

const defaultFs = { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync };

/**
 * Retain one finished job's directory, or delete it.
 *
 * Called by `makeCleanup` in place of the bare `rm -rf`. Returns the written manifest, or `null` when
 * nothing was retained -- and on `null` the caller has nothing left to do, because every failure path
 * here removes `jobDir` itself. Retention must never leave debris behind.
 *
 * `prepared.sandbox` is `{ jobId, kind, image, backend, jobUser? }`, stamped by `makePrepareWorkspace` (`jobUser`
 * only when the processor decided one, issue #341). Absent (a bare construction, a test, an unwired dispatcher)
 * means no retention, which keeps such a caller on exactly
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
			// The venue the job resolved to (#277), which `resolveSandbox` refuses by when it is not this
			// host's. `?? null`, never a guessed `local`: a stamp with no venue is refused, and only a manifest
			// that predates the key entirely reads as local.
			backend: meta.backend ?? null,
			// Issue #341: the job user the run had (`{ user, home }`, `user` null = the image's own USER), or null when
			// nothing decided one. The sandbox reuses it for IDENTITY only and still checks the daemon itself.
			jobUser: meta.jobUser ?? null,
			// Issue #429: a podman run's container store (`podman info` graphRoot). Written only when known, so every
			// other manifest is the shape it always was. A sandbox refuses to open under another store, and the sweep
			// holds the run while the podman it asks uses another, because that podman's `ps` answers empty (measured).
			...(typeof meta.podmanStore === "string" ? { podmanStore: meta.podmanStore } : {}),
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
export function pinSandbox({ sandboxDir, jobId, pinDays, fs = defaultFs, now = () => Date.now(), euid = process.geteuid?.() }) {
	const manifest = readManifest({ sandboxDir, jobId, fs });
	if (!manifest) return { pinned: false, reason: "absent" };
	const keepUntil = new Date(now() + pinDays * DAY_MS).toISOString();
	const { dir, ...body } = manifest;
	// ATOMIC (issue #429 review): a temp file beside it, then a rename over it. `writeFileSync` on the manifest itself
	// truncates first, and for that window every reader (the retention sweep, `--list`, the panel, an open) sees a
	// manifest that does not parse. A rename is all or nothing.
	//
	// AND THE FILE KEEPS ITS IDENTITY (review round 3, reproduced): a rename puts the TEMP file's owner and mode in
	// place, so `sudo -E pi-dispatch sandbox --pin` left a root-owned 0600 manifest the worker could not read, and the
	// worker's sweep deleted the run as manifest-less after the shell exited. So the manifest is stat'ed first and the
	// temp file given its uid, gid and mode before the rename. `chown` only succeeds as root; as anyone else it is
	// EPERM, which is harmless exactly when this process already owns the file (the temp file is then the same owner),
	// and otherwise the pin is refused rather than handing the manifest to another account. The temp file is created
	// with `wx`, so an existing path (a planted symlink, a leftover) is never written through.
	const target = join(dir, SANDBOX_MANIFEST);
	const tmp = join(dir, `.${SANDBOX_MANIFEST}.${process.pid}.${now()}.tmp`);
	let created = false;
	try {
		const original = fs.lstatSync(target);
		const mode = Number.isInteger(original?.mode) ? original.mode & 0o777 : 0o600;
		fs.writeFileSync(tmp, `${JSON.stringify({ ...body, keepUntil }, null, 2)}\n`, { mode, flag: "wx" });
		created = true;
		if (Number.isInteger(original?.uid) && Number.isInteger(original?.gid)) {
			try {
				fs.chownSync(tmp, original.uid, original.gid);
			} catch (err) {
				if (!(err?.code === "EPERM" && euid === original.uid)) throw err;
			}
		}
		// Explicit, since `writeFileSync`'s mode is filtered through the umask.
		fs.chmodSync(tmp, mode);
		fs.renameSync(tmp, target);
		return { pinned: true, keepUntil };
	} catch (err) {
		if (created) {
			try {
				fs.rmSync(tmp, { force: true });
			} catch {
				// nothing left to try
			}
		}
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
 * unwired reaper still sweeps; start.mjs injects `makeSandboxRuntimeWatch`'s, which answers the ids to HOLD this
 * pass: those each retained run's own runtime reports open, and those whose runtime could not answer (issue #429).
 */
export function makeSandboxReaper({
	sandboxDir,
	retentionHours,
	fs = defaultFs,
	log = () => {},
	now = () => Date.now(),
	listRunning = async () => [],
	// Issue #337: the session NETWORKS, swept after the directories and keyed on them. INJECTED rather than
	// imported, and that is not style: `sandbox.mjs` imports `readManifest` from this module, so importing the
	// sweeper here would make a cycle. It also keeps this file docker-free in its own tests, which its header
	// gives as the reason the two modules are acyclic in the first place. Defaults to a real no-op so every
	// existing construction is byte-unchanged.
	sweepNetworks = async () => ({ swept: [], notes: [] }),
}) {
	return async function reapSandboxes() {
		if (!sandboxDir) return;
		let names;
		try {
			names = fs.readdirSync(sandboxDir);
		} catch (err) {
			// A root that does not EXIST is not a failed read, it is an empty one, and the difference matters
			// to the network sweep below (issue #337): a host whose sandbox root was never created or was
			// removed by hand is exactly the host most likely to be holding orphaned `pi-sandbox-` networks,
			// and skipping there would mean the sweep never fires on it at all. It is also safe rather than
			// merely convenient: with no root, `resolveSandbox` refuses every run that resolves the SAME
			// root, so no open can be in flight for the sweep to race. An opener computing a DIFFERENT
			// root (its own environment, which `docs/sandbox.md` says routinely differs) is the residual,
			// and it is bounded: the next open just creates the network again, and one in flight is still
			// held by the sweeper's own container look. Any other error (a permission wall, an I/O fault) is a read that
			// failed and still skips the pass.
			if (err?.code !== "ENOENT") {
				log("sandbox_reaper_skipped", { reason: scrubCredentials(err?.message) });
				return;
			}
			names = [];
		}

		// ONE READ DECIDES (issue #429, review round 3). Every retained directory's manifest is read ONCE per pass, here,
		// and that one result is what the runtime watch places the run by AND what expiry decides on. Two reads let a
		// pass decide on one and delete on another: a read that failed for the watch (skipping a hold) and succeeded
		// for expiry, or the reverse, deleted a directory under an open sandbox (reproduced twice). So the listing
		// comes first now, then the reads, then the question to the runtimes, handed the reads.
		const reads = new Map();
		for (const name of names) reads.set(name, readRetained(fs, join(sandboxDir, name)));

		let running = new Set();
		try {
			running = new Set(await listRunning({ names, reads }));
		} catch (err) {
			// Could not ask docker. Sweeping blind risks pulling a mount out from under a live shell, so
			// skip this sweep entirely: a directory kept one boot too long is the cheaper mistake.
			log("sandbox_reaper_skipped", { reason: scrubCredentials(err?.message ?? "running-lookup-failed") });
			return;
		}

		const at = now();
		const cutoff = at - retentionHours * HOUR_MS;
		// The listing this pass STARTED with, captured before anything is removed. Keying the network sweep on
		// the survivors instead would reopen the race issue #277 withdrew a fix for: an open that passed
		// `resolveSandbox` while its directory existed, whose directory this same pass then expires, would lose
		// its network between `createJobNetwork` and `launch`. No open in progress can be absent from this list,
		// because `resolveSandbox` refuses a job whose directory is gone.
		const keep = new Set(names);
		// The ids whose directory this pass could NOT remove (issue #363). Such a directory stays on disk, so its
		// id stays in `keep` on every later pass and its network is never a candidate again. That is CORRECT (a
		// directory that exists is a run that can be re-opened, so its network is wanted) and it was invisible:
		// `sandbox_reaper_skipped` names a directory and nothing on the host named the network it holds. The
		// ordinary shape on Linux is a retained forge workspace holding root-owned files under a non-root worker.
		const blocked = new Set();
		for (const name of names) {
			const dir = join(sandboxDir, name);
			// Set ONLY around a removal, so `blocked` means what its name says. The first version added every
			// throw in this loop, which is a different set: a directory that VANISHED between the listing and
			// the lstat is not a directory that could not be removed, and the note it produced asserted the
			// opposite of what had happened -- that the directory stays on disk, so its id stays in `keep` and
			// its network is never a candidate again. It does not stay, and it is.
			let removing = false;
			try {
				// lstat: a symlink here resolves on the host, and this tree is agent-written.
				if (!fs.lstatSync(dir).isDirectory()) {
					removing = true;
					fs.rmSync(dir, { recursive: true, force: true });
					log("reaped_sandbox", { entry: name, reason: "not-a-directory" });
					continue;
				}
				if (running.has(name)) continue; // an operator is inside it
				// A manifest that could not be read FOR A MOMENT (`TRANSIENT_READ_ERRORS`: EMFILE, EIO and the rest) is
				// HELD this pass, full stop: no runtime answer can release it, because nothing about the run is known,
				// not even which runtime to ask. The next pass reads it again. Said once per directory per pass.
				const read = reads.get(name);
				if (read?.transient) {
					log("sandbox_reaper_skipped", { entry: name, reason: "manifest-unread" });
					continue;
				}
				const verdict = expiry(read, at, cutoff);
				if (!verdict.expired) continue;
				// AND AGAIN AT THE POINT OF DELETION (final review of round 3, reproduced): the pass's read is taken BEFORE
				// the runtimes are asked, which can take seconds per runtime, so a pin landing meanwhile, or a BullMQ retry
				// replacing the directory with a fresh run, was deleted on the stale read. The one read still PLACES the
				// run; the delete additionally needs a fresh read (lstat first) that is byte-for-byte the same manifest,
				// so it is the same run under the same expiry inputs. A retained manifest carries its `createdAt` to the
				// millisecond, so a retry's fresh run never matches. Anything else holds the directory this pass: a
				// transient fresh read (`manifest-unread`), or a changed, pinned, replaced or newly unreadable one
				// (`manifest-changed`); the next pass reads it again.
				const fresh = readRetained(fs, dir);
				if (fresh.transient || !sameRead(read, fresh)) {
					log("sandbox_reaper_skipped", { entry: name, reason: fresh.transient ? "manifest-unread" : "manifest-changed" });
					continue;
				}
				removing = true;
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
				if (removing) blocked.add(name);
				log("sandbox_reaper_skipped", { entry: name, reason: scrubCredentials(err?.message) });
			}
		}

		// The session networks, after the directories. Reached only when `listRunning` ANSWERED and the
		// directory listing was read, which is the same precondition the directory pass has: without either,
		// nothing here can be called unclaimed.
		//
		// The keep set is the UNION of two listings, and each half covers what the other cannot. The one this
		// pass STARTED with covers a run whose directory this pass then expired: an open that passed
		// `resolveSandbox` a moment before is mid-launch and must not lose its network. A FRESH one covers the
		// opposite end: `retainJobDir` creates a directory at job end, in this same process, and this pass
		// awaits docker and yields per tree, so a job can finish and its run be opened while the pass is still
		// running. That id is in neither the old listing nor `running` -- the container is not up yet -- so
		// without the second read the sweep would take a network `createJobNetwork` had just made.
		//
		// The fresh read is handed over as a CLOSURE rather than as a set, so the sweeper can take it after
		// its own candidate listing: evidence that protects a network must never be older than the listing
		// that nominated it. A read that throws leaves the sweeper and lands in the catch below, which is
		// deliberate -- half a keep set is worse than no sweep. ENOENT is an empty root, not a failure, for
		// the reason given above.
		//
		// Its own fault keeps the `sandbox_reaper_skipped` name on `OQ-007`'s stated property, that one grep
		// covers boot and every tick; only the per-network VERDICTS get new names.
		try {
			const retained = () => {
				try {
					return fs.readdirSync(sandboxDir);
				} catch (err) {
					if (err?.code === "ENOENT") return [];
					throw err;
				}
			};
			const { swept, notes, failed, failures } = await sweepNetworks({ running, keep, retained, blocked });
			for (const s of swept) log("reaped_sandbox_network", s);
			for (const n of notes) log("sandbox_network_not_reaped", n);
			// One line per runtime whose listing failed, naming it (issue #429), where a sweeper that knows its runtime
			// says so; a bare `failed` from a single sweeper keeps the line it always had.
			if (Array.isArray(failures) && failures.length > 0) for (const f of failures) log("sandbox_reaper_skipped", { reason: f.reason, runtime: f.runtime });
			else if (failed) log("sandbox_reaper_skipped", { reason: failed });
		} catch (err) {
			log("sandbox_reaper_skipped", { reason: scrubCredentials(err?.message ?? "network-sweep-failed") });
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
function expiry(read, at, cutoff) {
	// The pass's one read (`readRetained`). ENOENT, a manifest that does not parse, and one that cannot be read for
	// good are all "no manifest", as they always were: nothing can open such a run (`resolveSandbox` refuses it). The
	// runtime watch has already asked every runtime present about the last two, so a shell open on one is held above.
	if (!Object.hasOwn(read ?? {}, "manifest")) return { expired: true, reason: "no-manifest" };
	const manifest = read.manifest;
	const keepUntil = Date.parse(manifest?.keepUntil ?? "");
	if (Number.isFinite(keepUntil)) return keepUntil <= at ? { expired: true, reason: "pin-expired" } : { expired: false };
	const createdAt = Date.parse(manifest?.createdAt ?? "");
	if (!Number.isFinite(createdAt)) return { expired: true, reason: "no-created-at" };
	return createdAt < cutoff ? { expired: true, reason: "window" } : { expired: false };
}

/**
 * One retained entry's manifest, read once for the whole pass: `{ manifest }`, `{ absent: true }` (no manifest file, or
 * not a directory at all), `{ transient: true, code }` (a read that failed for a moment, `TRANSIENT_READ_ERRORS`),
 * `{ unparsed: true }` (the file does not parse) or `{ unreadable: true, code }` (any other failure, EACCES say).
 * `lstat` FIRST, as the pass itself does: a symlink planted here must not be followed to read a host file.
 */
export function readRetained(fs, dir) {
	try {
		if (!fs.lstatSync(dir).isDirectory()) return { absent: true };
	} catch (err) {
		return TRANSIENT_READ_ERRORS.has(err?.code) ? { transient: true, code: err.code } : { absent: true };
	}
	let text;
	try {
		text = String(fs.readFileSync(join(dir, SANDBOX_MANIFEST), "utf8"));
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { absent: true };
		if (TRANSIENT_READ_ERRORS.has(err?.code)) return { transient: true, code: err.code };
		return { unreadable: true, code: err?.code ?? null };
	}
	// `text` rides along so the delete can compare the pass's read with a fresh one byte for byte (`sameRead`).
	try {
		return { manifest: JSON.parse(text), text };
	} catch {
		return { unparsed: true, text };
	}
}

/**
 * Whether two `readRetained` results are the same read: the same kind, and for a manifest (parsed or not) the same
 * bytes. Two absences are the same, and so are two failures with the same errno; a transient failure never reaches here.
 */
function sameRead(a, b) {
	if (a?.absent || b?.absent) return a?.absent === true && b?.absent === true;
	// An unreadable file matches only the same failure (EACCES then EACCES): nothing changed between the reads, and a
	// file that stays unreadable must still be swept once every runtime has said no sandbox is open on it.
	if (a?.unreadable || b?.unreadable) return a?.unreadable === true && b?.unreadable === true && a.code === b.code;
	if (typeof a?.text !== "string" || typeof b?.text !== "string") return false;
	return a.text === b.text && Object.hasOwn(a, "manifest") === Object.hasOwn(b, "manifest");
}
