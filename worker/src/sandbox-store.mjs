import { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * The reserved name prefix of a TOMBSTONE in the retention root (issue #446): a retained directory the sweep has
 * decided to delete is first renamed to `.reap-<pid>-<now>-<n>` beside it, and only then deleted. Every reader of the
 * root skips these names (`isSandboxTombstone`): the sweep's own listing, `listSandboxes`, the runtime watch, the
 * network sweep's keep set, doctor's count, and `retainJobDir`, which can never produce one (`sandboxEntryName`).
 *
 * The name carries NO job id, on purpose: `sanitizeJobId` output is unbounded, and a prefix plus a 250-byte id is
 * past NAME_MAX on every common filesystem, so a rename to it would fail with ENAMETOOLONG and hold that run forever.
 */
export const SANDBOX_TOMBSTONE_PREFIX = ".reap-";

/** Whether a name in the retention root is a tombstone rather than a retained run. */
export function isSandboxTombstone(name) {
	return typeof name === "string" && name.startsWith(SANDBOX_TOMBSTONE_PREFIX);
}

/**
 * How old a tombstone must be before doctor calls it STUCK rather than a delete in progress (issue #446). A tombstone
 * normally lives for exactly one `rmSync`: seconds for a large clone (200k files took about 10 s, measured under
 * #446). One still there ten minutes later is a tree the worker cannot delete, which is not going to resolve itself.
 */
export const SANDBOX_TOMBSTONE_STUCK_MS = 10 * 60 * 1000;

/**
 * How often the sweep repeats its line for the SAME stuck tombstone (issue #446). Each pass retries the delete, and a
 * root-owned file under a non-root worker fails it on every pass, so the line is said when first seen and then once a
 * day per tombstone rather than on every tick; doctor names it in between.
 */
export const SANDBOX_TOMBSTONE_RELOG_MS = DAY_MS;

/** `kill(pid, 0)`: true unless the process is gone (ESRCH). EPERM means alive under another account. */
export function defaultPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code !== "ESRCH";
	}
}

/** The pid a tombstone's name records, or null when the name is not one this module writes. */
export function sandboxTombstonePid(name) {
	const m = /^\.reap-(\d+)-\d+-\d+$/.exec(String(name ?? ""));
	return m ? Number(m[1]) : null;
}

/** A tombstone's age at `at` from its name, or null when the name is not one this module writes. */
export function sandboxTombstoneAge(name, at) {
	const m = /^\.reap-\d+-(\d+)-\d+$/.exec(String(name ?? ""));
	if (!m) return null;
	const made = Number(m[1]);
	return Number.isSafeInteger(made) ? at - made : null;
}

/**
 * The directory name one job id is retained under (issue #446): `sanitizeJobId`, then an ESCAPE for a leading `.` or
 * `_`: one `_` is prepended to either, and nothing else changes. So `.x` is `_.x`, `_x` is `__x`, and `x` is `x`.
 *
 * THE RULE IS PINNED, and it is wider than the tombstone prefix on purpose. `sanitizeJobId` keeps `.`, so an id whose
 * sanitized form is `.reap-...` would name (or be read as) a tombstone, and `.` or `..` would name the retention root
 * itself or its parent, which `retainJobDir` then `rm -rf`s as "the previous attempt" and `pi-dispatch sandbox ..`
 * would read a manifest from. No mapped name starts with `.`, so the whole dot namespace of the root is this module's.
 *
 * AN ESCAPE, NOT A SUBSTITUTION (gate round 1): the first version mapped a leading `.` to `_`, and `sanitizeJobId`
 * emits `_` too, so `.x` and `_x` shared one directory and retaining one deleted the other. Every character outside
 * `sanitizeJobId`'s own set (`[A-Za-z0-9._-]`) is also illegal in a container name, which this name becomes, so the
 * escape stays inside the set and is made unambiguous instead: a mapped name starting with `_` always had one prepended,
 * and one that does not was never changed, so two ids with different sanitized forms never share a name. (Two ids with
 * the SAME sanitized form, `a:b` and `a_b`, still do; that is `sanitizeJobId`'s, and `resolveSandbox` refuses a
 * manifest whose `jobId` is not the one asked for.) No job id this project mints starts with either character.
 *
 * Used by every place that turns an id into this root's name: the retention, the read, the container name
 * (`sandboxContainerName`) and the running checks, so the id the runtime reports and the name the sweep holds stay the
 * same string.
 */
export function sandboxEntryName(jobId) {
	const name = sanitizeJobId(jobId);
	return name.startsWith(".") || name.startsWith("_") ? `_${name}` : name;
}

const defaultFs = { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync };

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
export function retainJobDir(prepared, { sandboxDir, retentionHours = null, fs = defaultFs, log = () => {}, now = () => Date.now(), euid = process.geteuid?.() } = {}) {
	const jobDir = prepared?.jobDir;
	const meta = prepared?.sandbox;
	if (!jobDir) return null;
	if (!sandboxDir || !meta?.jobId) {
		discard(jobDir, fs);
		return null;
	}

	const dest = join(sandboxDir, sandboxEntryName(meta.jobId));
	const created = now();
	try {
		// FIRST, and load-bearing rather than hygiene. The per-job transcript copy is the most PII-bearing
		// artifact this system holds -- tool output, file contents, the agent's own reasoning -- and it
		// belongs to PI_SESSIONS_DIR's own TTL (INT-SESSION-STORE-CONTRACT). Carrying it into a directory
		// with a different, operator-extendable lifetime would silently extend that TTL, which is not a
		// weakening of the session policy so much as an end-run around it.
		fs.rmSync(join(jobDir, "session"), { recursive: true, force: true });

		fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
		// Issue #464 (gate round 1): this account's, asked again here and not only at boot. A sandbox dir absent at boot is
		// a name another account can create first (a recursive mkdir takes an existing directory silently), and a workspace
		// renamed into a directory that account owns is one it can swap for its own. Refused like any failed retention:
		// the run is deleted, not kept where someone else controls it. A fake fs with no statSync asks nothing.
		if (Number.isInteger(euid) && typeof fs.statSync === "function") {
			const owner = fs.statSync(sandboxDir).uid;
			if (owner !== euid) throw new Error(`${sandboxDir} is owned by uid ${owner}, not by this account (uid ${euid})`);
		}
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
			createdAt: new Date(created).toISOString(),
			// Issue #446: the deadline THIS worker's window gives the run, written down, so an opener whose own
			// PI_SANDBOX_RETENTION_HOURS is LARGER than the worker's (docs/sandbox.md says they routinely differ; the panel
			// is the usual case) does not call open a run the worker is about to delete. Every reader takes the EARLIER of
			// this and `createdAt` plus its own window (`sandboxDeadline`), so a window lowered later still applies. `null`
			// only for a caller that does not say (a bare construction, a test), which reads as `createdAt` plus the
			// reader's window alone, as every manifest from before the key does.
			retainUntil: Number.isFinite(retentionHours) && retentionHours > 0 ? new Date(created + retentionHours * HOUR_MS).toISOString() : null,
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
	const read = (name) => {
		const dir = join(sandboxDir, name);
		try {
			const manifest = JSON.parse(fs.readFileSync(join(dir, SANDBOX_MANIFEST), "utf8"));
			return { ...manifest, dir };
		} catch {
			return null;
		}
	};
	const escaped = sandboxEntryName(jobId);
	const found = read(escaped);
	if (found && (typeof found.jobId !== "string" || found.jobId === String(jobId))) return found;
	// A run retained BEFORE the escape (#446 gate round 2): an id whose safe form starts with `_` was retained under that
	// form, where it is still listed and still swept. Read there when the escaped name holds nothing OR holds another
	// id's run (gate round 3), never under a dot name, and only when the manifest there IS this id's, so the fallback can
	// never hand over another run. Otherwise the escaped read stands, and `resolveSandbox` refuses a mismatch by name.
	const legacy = sanitizeJobId(jobId);
	if (legacy === escaped || legacy.startsWith(".")) return found;
	const old = read(legacy);
	return old && old.jobId === String(jobId) ? old : found;
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
		// A tombstone is a run already decided for deletion (issue #446): not re-openable, so not listed.
		if (isSandboxTombstone(name)) continue;
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
 * `retentionHours === 0` is the feature being OFF, and it needs no special case: an unpinned run's deadline is the
 * EARLIER of the one its manifest records (`retainUntil`, issue #446) and `createdAt` plus this window
 * (`sandboxDeadline`), so at 0 every unpinned directory is already expired and gets swept. Turning retention off, or
 * down, therefore also cleans up what an earlier setting retained, while an explicit `--pin` still runs to its own
 * deadline -- an operator's deliberate act outliving a config change is the behaviour worth having.
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
	// Issue #446: the pid in a tombstone's name, seamed so a test can name one.
	pid = process.pid,
	// Whether a pid is a live process (gate round 1): `kill(pid, 0)`, where ESRCH is gone and EPERM is alive under
	// another account. Seamed so a test can name a dead one.
	pidAlive = defaultPidAlive,
	// Issue #446, gate round 1: whether ONE run's sandbox is open RIGHT NOW, asked of its runtime immediately before
	// the run is renamed aside. `true` holds it, and so does a throw. Defaults to "no", so an unwired reaper sweeps as
	// it did; start.mjs injects the runtime watch's `isOpen`.
	isOpen = async () => false,
}) {
	// Across passes, never reset: two tombstones of one pass share `pid` and `at`, and a pass on the same millisecond as
	// the last must not reuse a name either.
	let seq = 0;
	// The stuck tombstones already said, and when (`SANDBOX_TOMBSTONE_RELOG_MS`). Only rate-limits a log line; losing it
	// on a restart costs one repeated line.
	const stuckSaid = new Map();
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

		// LEFTOVER TOMBSTONES FIRST (issue #446): one a crash left between the rename and the delete, or one whose delete
		// failed on an earlier pass. Removed here on every pass, boot and timer alike, and never read as a run: a
		// tombstone's id has already left `keep`, and nothing can open it. Its line is rate-limited, because a tree the
		// worker cannot delete fails the same way on every pass.
		//
		// ONE WORKER PER RETENTION ROOT is the supported configuration (`INT-SANDBOX-CONTRACT`, on `DES-CONCURRENCY-3`'s
		// one worker per daemon). Still, a tombstone ANOTHER process named is left alone while it is younger than
		// `SANDBOX_TOMBSTONE_STUCK_MS`: that process may be between its rename and its read-back, about to put a pinned run
		// back, and deleting it there would lose the run. The name carries the pid, so this costs one comparison. A
		// tombstone this process named is always from an earlier pass (passes never overlap), and one another process left
		// behind is cleared once it is old enough that no pass could still hold it.
		const runs = [];
		const pass = now();
		// The pinned tombstones this pass could not put back, for ONE retry after the main loop (PR #457's final check).
		const heldPinned = [];
		for (const name of names) {
			if (!isSandboxTombstone(name)) {
				runs.push(name);
				continue;
			}
			const owner = sandboxTombstonePid(name);
			const age = sandboxTombstoneAge(name, pass);
			// Only while that process is ALIVE (gate round 1): a worker that crashed between its rename and its delete
			// and was restarted has a new pid, and its tombstone is a plain leftover to clear now, not in ten minutes. A
			// NEGATIVE age (a name stamped by a clock that ran ahead) is not young, it is unknowable, and is treated as
			// old (gate round 2): otherwise a reused pid would hold it forever. The skip is said once a period.
			if (owner !== null && owner !== pid && age !== null && age >= 0 && age < SANDBOX_TOMBSTONE_STUCK_MS && pidAlive(owner)) {
				sayOnce(name, pass, { reason: "tombstone-foreign" });
				continue;
			}
			if ((await clearTombstone(name, pass)) === "pinned-held") heldPinned.push(name);
		}
		names = runs;

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
		// The listing this pass STARTED with, captured before anything is removed. Keying the network sweep on
		// the survivors instead would reopen the race issue #277 withdrew a fix for: an open that passed
		// `resolveSandbox` while its directory existed, whose directory this same pass then expires, would lose
		// its network between `createJobNetwork` and `launch`. No open in progress can be absent from this list,
		// because `resolveSandbox` refuses a job whose directory is gone.
		const keep = new Set(names);
		// The ids whose directory this pass could NOT move out of the way (issue #363, redefined by #446). Such a
		// directory stays on disk under its own name, so its id stays in `keep` on every later pass and its network is
		// never a candidate again. That is CORRECT (a directory that exists is a run that can be re-opened, so its
		// network is wanted) and it was invisible: `sandbox_reaper_skipped` names a directory and nothing on the host
		// named the network it holds. Since #446 that is a failed RENAME (or a non-directory entry that would not go),
		// which a directory's own contents cannot cause. The ordinary #363 shape, root-owned files in a retained forge
		// workspace under a non-root worker, now renames fine and fails the DELETE: it stays a tombstone, its id leaves
		// `keep` from the next pass (so its network is swept), the run can no longer be opened, which is intended, and
		// each pass retries the delete (`clearTombstone`) while doctor names it.
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
				const verdict = expiry(read, at, retentionHours);
				if (!verdict.expired) continue;
				// AND AGAIN AT THE POINT OF DELETION (final review of round 3, reproduced): the pass's read is taken BEFORE
				// the runtimes are asked, which can take seconds per runtime, so a pin landing meanwhile, or a BullMQ retry
				// replacing the directory with a fresh run, was deleted on the stale read. The one read still PLACES the
				// run; the delete additionally needs a fresh read (lstat first) that is byte-for-byte the same manifest,
				// so it is the same run under the same expiry inputs. A retained manifest carries its `createdAt` to the
				// millisecond, so a retry's fresh run never matches. Anything else holds the directory this pass: a
				// transient fresh read (`manifest-unread`), or a changed, pinned, replaced or newly unreadable one
				// (`manifest-changed`); the next pass reads it again.
				// ASKED AGAIN, FOR THIS RUN, NOW (gate round 1, reproduced). `running` came from a `ps` taken before the
				// pass read anything, and the pass can reach this directory much later (other runtimes' asks, other
				// deletions), after an open's container started. So the run's own runtime is asked once more, here, and a
				// run it reports open, or cannot answer for, is held. What is left is the microseconds from this answer
				// to the rename, which the opener's post-launch look covers.
				let hold = null;
				try {
					if ((await isOpen({ name, read })) === true) hold = "opened-during-pass";
				} catch {
					hold = "runtime-unanswered";
				}
				if (hold) {
					log("sandbox_reaper_skipped", { entry: name, reason: hold });
					continue;
				}
				const fresh = readRetained(fs, dir);
				if (fresh.transient || !sameRead(read, fresh)) {
					log("sandbox_reaper_skipped", { entry: name, reason: fresh.transient ? "manifest-unread" : "manifest-changed" });
					continue;
				}
				// THE TOMBSTONE (issue #446). The fresh read above is microseconds before the decision, but a recursive
				// delete of a large clone takes SECONDS (200k files, about 10 s), and until it reaches `manifest.json` a pin
				// from another process still succeeds and reports `pinned: true` over a directory that is then gone. So
				// the directory is first renamed out of its name, in the same root (one rename, never a copy), and only
				// the tombstone is deleted: from the rename on, every open, pin and read of this run finds nothing, which
				// is the truth. A rename that fails HOLDS the directory under its own name (`rename-failed`), in the
				// family's one line (`OQ-007`).
				const tombName = `${SANDBOX_TOMBSTONE_PREFIX}${pid}-${at}-${seq++}`;
				const tomb = join(sandboxDir, tombName);
				try {
					fs.renameSync(dir, tomb);
				} catch (err) {
					blocked.add(name);
					log("sandbox_reaper_skipped", { entry: name, reason: "rename-failed", code: err?.code ?? null });
					continue;
				}
				// AND READ IT ONCE MORE, THROUGH THE TOMBSTONE. A pin that landed between the fresh read and the rename is
				// the one write the rename cannot see, and it is in this file now: anything but the pass's own read (a
				// changed manifest, or one that cannot be read just now) puts the directory back, when nothing has taken
				// its name meanwhile, and holds it as `manifest-changed`. After this read a pin cannot land: it reads the
				// run's own name, which is gone. The worker's own `retainJobDir` cannot interleave here, since it runs in
				// this same process and this stretch is synchronous.
				const moved = readRetained(fs, tomb);
				if (moved.transient || !sameRead(read, moved)) {
					const restored = restoreTombstone(tomb, dir);
					log("sandbox_reaper_skipped", { entry: name, reason: "manifest-changed", ...(restored ? {} : { restored: false }) });
					continue;
				}
				try {
					fs.rmSync(tomb, { recursive: true, force: true });
				} catch (err) {
					// A tombstone that would not go STAYS one: the run is already unopenable, and the next pass retries.
					stuckSaid.set(tombName, at);
					log("sandbox_reaper_skipped", { entry: name, reason: "tombstone-stuck", tombstone: tombName, code: err?.code ?? null });
					await new Promise((resolve) => setImmediate(resolve));
					continue;
				}
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

		// THE HELD PINNED TOMBSTONES, ONCE MORE (PR #457's final check). One held because a directory with no manifest held
		// its run's name waited a whole pass for the next leftover sweep, though the loop above deletes such a directory
		// (`no-manifest`) in this same pass. Retried here, after the loop and before the network sweep (whose fresh
		// listing then sees the run back), through the same `clearTombstone`: its reads, its restore that displaces only an
		// empty directory, its rule that never deletes a live pin, and its once-per-period line when the name is still taken.
		for (const name of heldPinned) await clearTombstone(name, pass);

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
					// A tombstone is not a retained run (issue #446), and its name is not an id either.
					return fs.readdirSync(sandboxDir).filter((name) => !isSandboxTombstone(name));
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

	/**
	 * The name a pinned tombstone goes back under, or null to HOLD it: only ever one of the two names its own `jobId`
	 * maps to, `sandboxEntryName(jobId)` or the pre-escape `sanitizeJobId(jobId)` (gate round 3: the first version took
	 * the first path component of `workspace`, so a crafted manifest could restore a tombstone under ANOTHER run's
	 * name). The workspace path only CHOOSES between those two, so a run retained before the escape keeps the name its
	 * recorded paths use. No usable `jobId`, no restore.
	 */
	function restoreName(manifest) {
		const jobId = manifest?.jobId;
		if (typeof jobId !== "string" || jobId === "") return null;
		const escaped = sandboxEntryName(jobId);
		const legacy = sanitizeJobId(jobId);
		if (legacy === escaped || legacy.startsWith(".")) return escaped;
		const rel = typeof manifest.workspace === "string" ? relative(sandboxDir, manifest.workspace) : "";
		return rel.split(/[\\/]/)[0] === legacy && !rel.startsWith("..") && !isAbsolute(rel) ? legacy : escaped;
	}

	/** Say `fields` about tombstone `name` when first seen and then once per `SANDBOX_TOMBSTONE_RELOG_MS`. */
	function sayOnce(name, at, fields) {
		const said = stuckSaid.get(name);
		if (said !== undefined && at - said < SANDBOX_TOMBSTONE_RELOG_MS) return;
		stuckSaid.set(name, at);
		log("sandbox_reaper_skipped", { entry: name, ...fields });
	}

	/**
	 * Delete one leftover tombstone; a failure is said when first seen and then once per `SANDBOX_TOMBSTONE_RELOG_MS`.
	 *
	 * NEVER ONE HOLDING A LIVE PIN (gate round 1, belt and braces). A tombstone is only ever made of an expired run, so a
	 * manifest in it with an unexpired `keepUntil` is a pin that landed during the sweep and whose restore did not
	 * happen (a crash between the rename and the read-back, or a name that could not be freed). Its pinner was told
	 * `pinned: true`. It is restored under its run's name when that is free (or an empty directory), and otherwise held
	 * and said (`tombstone-pinned`); once its pin lapses it is an ordinary leftover. A manifest that cannot be read for
	 * a moment holds it too: deleting on an unknown is the one mistake here that cannot be undone.
	 *
	 * Resolves `"pinned-held"` for a pinned one whose run's name was taken, which the pass retries once after its main
	 * loop; null otherwise.
	 */
	async function clearTombstone(name, at) {
		const path = join(sandboxDir, name);
		const read = readRetained(fs, path);
		const keepUntil = Date.parse(read.manifest?.keepUntil ?? "");
		let held = false;
		if (read.transient) {
			sayOnce(name, at, { reason: "manifest-unread" });
		} else if (Number.isFinite(keepUntil) && keepUntil > at) {
			const target = restoreName(read.manifest);
			const restored = target !== null && restoreTombstone(path, join(sandboxDir, target));
			if (restored) {
				stuckSaid.delete(name);
				log("sandbox_reaper_skipped", { entry: name, reason: "tombstone-pinned", restored: true });
			} else {
				held = target !== null;
				sayOnce(name, at, { reason: "tombstone-pinned", restored: false });
			}
		} else {
			try {
				fs.rmSync(path, { recursive: true, force: true });
				stuckSaid.delete(name);
				log("reaped_sandbox", { entry: name, reason: "tombstone" });
			} catch (err) {
				sayOnce(name, at, { reason: "tombstone-stuck", code: err?.code ?? null });
			}
		}
		// The per-tree yield of the main loop, for its reason: this runs on the timer beside draining jobs.
		await new Promise((resolve) => setImmediate(resolve));
		return held ? "pinned-held" : null;
	}

	/**
	 * Put a tombstone back under a run's name. When the name is free, one rename. When it is TAKEN, only an EMPTY
	 * directory may be displaced (`rmdirSync` removes nothing else), and that is the one thing that can appear there in
	 * these microseconds: Docker's auto-created bind source, created by an open that lost this race (Podman refuses to bind a
	 * missing path instead, exit 125, which the opener reports as swept). Gate round 1
	 * reproduced the alternative with a real filesystem: leaving the run as a tombstone because the name was taken
	 * handed a PINNED run to the next pass's leftover sweep. The open sitting on the displaced empty directory is on an
	 * inode that is no longer the run's, which its post-launch look can see only while the path is not the run's again;
	 * that residual is stated in `INT-SANDBOX-CONTRACT`. Anything else at the name (a file, a non-empty directory, a
	 * link) is never removed, and the tombstone is then held (`clearTombstone` never deletes a pinned one).
	 */
	function restoreTombstone(tomb, dir) {
		try {
			fs.lstatSync(dir);
			try {
				fs.rmdirSync(dir);
			} catch {
				return false;
			}
		} catch (err) {
			if (err?.code !== "ENOENT") return false;
		}
		try {
			fs.renameSync(tomb, dir);
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Whether one retained directory is past its window.
 *
 * An unreadable, absent or unparseable manifest is EXPIRED, not skipped: without it the directory names no
 * image, no workspace and no job, so nothing can resurrect it and keeping it is just disk. A pin wins over
 * the base window while it lasts, and an unparseable `keepUntil` is treated as no pin rather than as
 * forever -- the direction that stays bounded.
 */
function expiry(read, at, retentionHours) {
	// The pass's one read (`readRetained`). ENOENT, a manifest that does not parse, and one that cannot be read for
	// good are all "no manifest", as they always were: nothing can open such a run (`resolveSandbox` refuses it). The
	// runtime watch has already asked every runtime present about the last two, so a shell open on one is held above.
	if (!Object.hasOwn(read ?? {}, "manifest")) return { expired: true, reason: "no-manifest" };
	const deadline = sandboxDeadline(read.manifest, retentionHours);
	if (deadline.until === null) return { expired: true, reason: "no-created-at" };
	// `keepUntil` and `retainUntil` are instants the run ends AT; the window is the one it always was, a run created
	// exactly `retentionHours` ago is still inside it.
	if (deadline.source === "window") return deadline.until < at ? { expired: true, reason: "window" } : { expired: false };
	return deadline.until <= at ? { expired: true, reason: deadline.source === "pin" ? "pin-expired" : "window" } : { expired: false };
}

/**
 * When one retained run's window closes: `{ until, source }`, `until` in epoch ms or null (issue #446).
 *
 * ONE RULE, for the sweep and for every opener: the pin (`keepUntil`) while one is set, whatever else the manifest
 * says; otherwise the EARLIER of the deadline the worker wrote when it retained the run (`retainUntil`) and
 * `createdAt` plus `retentionHours`, the READER's current window. An unparseable `keepUntil` is no pin rather than
 * forever, the direction that stays bounded, and a manifest with no usable `createdAt` has no deadline at all
 * (`until: null`), which the sweep expires and an opener refuses.
 *
 * WHY THE EARLIER OF THE TWO, both halves (issue #446, decided). The window's half: SHORTENING APPLIES. An operator who
 * lowers PI_SANDBOX_RETENTION_HOURS, or sets it to 0, is cleaning up, and that has always swept what an earlier
 * setting kept. `retainUntil`'s half: a reader whose window is LONGER than the worker's (the panel, or a shell with its
 * own setting) must not call open a run the worker is about to delete, which is window 1 of #446 across two
 * environments. The one case neither half covers is a worker whose CURRENT window is shorter than both the opener's
 * and the run's `retainUntil` (the worker's window lowered after retention, the opener's not): the opener then admits
 * a run the next pass deletes. That residual is accepted and caught after the fact, by the opener's post-launch look
 * (`openSandbox`), which removes the container and reports `swept-at-launch` (`INT-SANDBOX-CONTRACT`).
 */
export function sandboxDeadline(manifest, retentionHours) {
	const keepUntil = Date.parse(manifest?.keepUntil ?? "");
	if (Number.isFinite(keepUntil)) return { until: keepUntil, source: "pin" };
	// A string or nothing: `Date.parse(5)` reads a number as a YEAR (gate round 1), and this key is host-written.
	const retainUntil = typeof manifest?.retainUntil === "string" ? Date.parse(manifest.retainUntil) : NaN;
	const createdAt = Date.parse(manifest?.createdAt ?? "");
	if (!Number.isFinite(createdAt)) return { until: null, source: "no-created-at" };
	const windowUntil = createdAt + (Number(retentionHours) || 0) * HOUR_MS;
	// Strictly earlier, so the ordinary case (the same window both times, the two equal) keeps the window's own edge.
	if (Number.isFinite(retainUntil) && retainUntil < windowUntil) return { until: retainUntil, source: "retain" };
	return { until: windowUntil, source: "window" };
}

/**
 * The sweep's own verdict for a manifest in `readManifest`'s shape (issue #446): `{ expired, reason? }` at `at`. The
 * adapter over the pass's `readRetained` shape, so an opener or the panel asks the question the sweep asks and never a
 * copy of it. A null manifest is `no-manifest`, as the sweep reads one.
 */
export function sandboxExpiry(manifest, { at, retentionHours }) {
	return expiry(manifest ? { manifest } : {}, at, retentionHours);
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
