import { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { sanitizeJobId } from "./run-history.mjs";
import { scrubCredentials } from "./redact.mjs";
import { TRANSIENT_READ_ERRORS } from "./runtime-observations.mjs";
import { neededVersion } from "./store-version.mjs";

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

/**
 * The highest manifest version this build reads (issue #761, `DES-STORE-VERSION-WHEN-NEEDED`): a top-level `version`,
 * absent meaning 1, written only when the manifest uses a field that needs more, so every manifest of today's fields is
 * the shape it always was. Defined here, beside the writers (`retainJobDir`, `pinSandbox`, the preparer), and read by
 * `sandbox-policy.mjs`'s refusal, which already imports this module (the reverse would be a cycle).
 *
 * THE DEADLINE FIELDS NEVER CHANGE MEANING: `createdAt`, `retainUntil` and `keepUntil` keep theirs in every version, so
 * an older worker's retention sweep (after a rollback, or on a host a newer CLI pinned) still deletes a newer run on
 * time. That is why the sweep never consults the version, while opening and pinning refuse a newer manifest.
 */
export const SANDBOX_MANIFEST_VERSION = 1;

/** Each manifest field whose absence an older build would misread, with the version that introduced it. Empty until one does. */
export const SANDBOX_MANIFEST_FIELD_VERSIONS = Object.freeze({});

/** The lowest version `manifest` needs from its fields (`version` and the reader-added `dir` aside): 1 while none needs more. */
export function sandboxManifestVersionFor(manifest, { table = SANDBOX_MANIFEST_FIELD_VERSIONS } = {}) {
	if (manifest === null || typeof manifest !== "object") return 1;
	return neededVersion(Object.keys(manifest).filter((key) => key !== "version" && key !== "dir"), table);
}

/**
 * `manifest` with `version` set to what it needs: the higher of the version it carries (a manifest a newer build
 * wrote, rewritten here by a pin) and the one its fields need, in its place when it had one and first when added, and
 * no key at all while that is 1. So a manifest of today's fields is returned unchanged, byte for byte once serialized.
 */
export function withManifestVersion(manifest, { table = SANDBOX_MANIFEST_FIELD_VERSIONS } = {}) {
	const declared = Number.isSafeInteger(manifest?.version) && manifest.version >= 1 ? manifest.version : 1;
	const needed = Math.max(declared, sandboxManifestVersionFor(manifest, { table }));
	const had = Object.hasOwn(manifest ?? {}, "version");
	if (needed <= 1 && !had) return manifest;
	const { version: _owned, ...rest } = manifest;
	if (needed <= 1) return rest;
	return had ? { ...manifest, version: needed } : { version: needed, ...rest };
}

/**
 * Whether this build cannot read `manifest`'s version: `{ version }` when `version` is present and is not an integer
 * from 1 to `supported` (a newer build's manifest, version N; or a value nothing here wrote, version null), else null.
 */
export function sandboxManifestNewer(manifest, { supported = SANDBOX_MANIFEST_VERSION } = {}) {
	if (manifest === null || typeof manifest !== "object" || !Object.hasOwn(manifest, "version")) return null;
	const declared = manifest.version;
	if (Number.isSafeInteger(declared) && declared >= 1 && declared <= supported) return null;
	return { version: Number.isSafeInteger(declared) && declared >= 1 ? declared : null };
}

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
 * normally lives for exactly one recursive removal: seconds for a large clone (200k files took about 10 s, measured under
 * #446). One still there ten minutes later is a tree the worker cannot delete, which is not going to resolve itself.
 */
export const SANDBOX_TOMBSTONE_STUCK_MS = 10 * 60 * 1000;

/**
 * How often the sweep repeats its line for the SAME stuck tombstone (issue #446). Each pass retries the delete, and a
 * root-owned file under a non-root worker fails it on every pass, so the line is said when first seen and then once a
 * day per tombstone rather than on every tick; doctor names it in between.
 */
export const SANDBOX_TOMBSTONE_RELOG_MS = DAY_MS;

/**
 * The bound on ONE pass of the retention sweep (issue #978): wall time from the pass's start, its rests included and
 * its waits for starting job containers left out (issue #1023). A pass that waits can so last
 * `SANDBOX_START_WAIT_MAX_MS` longer, and longer again by the asks of a runtime that follow such waits inside one
 * entry, where this budget is not read (`makeSandboxReaper` says the bound). A
 * boot after a long gap used to sweep its whole backlog in one go before the worker took a job (959 `reaped_sandbox`
 * lines back to back on one host), one runtime ask and one recursive delete per run with nothing between them, all of
 * it before pickup. How long that took there was never measured; a thousand such removals took 10 to 18 s on a healthy
 * runner (measured), and on a slow daemon each ask can take seconds (issue #1021). A pass now stops at its first loop
 * boundary past this, and what it left is the next pass's (`makeSweepFollowUps`). So this bounds the boot delay before
 * pickup and each burst after it.
 */
export const SANDBOX_PASS_BUDGET_MS = 20_000;

/**
 * The other bound on one pass (issue #978): the removals it made. The time budget cannot see what a removal costs
 * after it returns (APFS, and a VM's disk, finish the work later), so a pass of fast removals stops here as well. A
 * removal that FAILED does not count (its walk's time still counts toward the time budget): counted, fifty tombstones
 * the worker cannot delete (the #363 shape, root-owned files) ended every pass before it reached a single run.
 */
export const SANDBOX_PASS_MAX_REAPS = 50;

/**
 * How long a pass rests after each entry that asked a runtime or deleted something (issue #978): as long as that entry
 * took, clamped to these two. PROPORTIONAL, not fixed: the entry's time includes the runtime's own `ps` round trip, the
 * one measure here that also sees a loaded VM, so a daemon that answers slowly is given proportionally more room and
 * one that answers at once costs the pass 100 ms an entry. A fixed rest is either too long for a healthy daemon or too
 * short for a slow one, and cannot tell which it is talking to.
 */
export const SANDBOX_REST_MIN_MS = 100;
export const SANDBOX_REST_MAX_MS = 10_000;

/** How often a rest looks at whether its pass was told to stop, so a shutdown never waits out a whole rest. */
export const SANDBOX_REST_POLL_MS = 250;

/**
 * How long ONE pass waits, in all, for job containers that are starting (issue #1023), in slices of
 * `SANDBOX_REST_POLL_MS`. A container start is the daemon's most loaded moment (a network, a create, a start), and
 * a burst of removals beside it is what the issue's host had while its VM-backed daemon stalled. So a pass asks the
 * worker's count (`activity.starting()`, container-activity.mjs) before its first runtime call, once that call has
 * answered, after each rest, and once more before each removal (after a run's runtime has answered, and before a
 * leftover tombstone is read), and waits while it is above zero. Bounded per pass, so a host that starts a job every
 * few seconds still sweeps: once this is used up the pass goes on, in the small steps below. The wait is not charged
 * to `SANDBOX_PASS_BUDGET_MS`: charged, a pass that waited 20 s would stop at its first boundary with one run
 * removed, every time.
 * Not measured on a slow daemon; a start that takes longer than this is met by the small passes instead.
 */
export const SANDBOX_START_WAIT_MAX_MS = 20_000;

/**
 * The bounds on a pass while a job container is starting or running (issue #1023), in place of
 * `SANDBOX_PASS_MAX_REAPS` and `SANDBOX_REST_MIN_MS`: at most this many removals, and at least this long a rest after
 * each entry. Beside a job a session network the sweep asked the daemon about counts as a removal too, removed or not
 * (the sweeper does not say which, and each was a daemon call); beside none the networks are not counted, as before.
 * Read at every loop boundary and every rest, so a job that starts in the middle of a pass tightens what is left of
 * it and one that ends loosens it. The time budget is the same. A pass still visits one entry before any bound can
 * stop it, and a follow-up pass starts a minute after the last one ENDED (`makeSweepFollowUps`).
 *
 * WHAT THAT LEAVES. Five a pass is a ceiling of about five runs a minute, which no host reaches, and a slow daemon
 * stays well under it. Measured on this reaper with the real follow-ups over a simulated hour, in runs removed a
 * minute: 44.2 beside no job; 4.67 beside a job that always runs and 4.33 beside a job every 6 s (3 s to start, 20 s
 * to run) on a daemon that answers in tens of milliseconds, 3.5 while a container is always starting; with 2 s asks
 * and 1.5 s deletes 2.15, 1.33 and 1.75; and 0.53 while a container is always starting and the listing of the open
 * sandboxes takes 25 s. That last is 768 runs a day, where the host of issue #1023 retained about 640 a day: a host
 * that is always starting containers on a daemon that slow removes little more than such a host creates. What takes
 * that load away at its source is not keeping a sandbox for runs nobody opens (`run.retainSandbox: false` on the
 * trigger, the same issue).
 * Not measured on a slow daemon either: small enough that the removals beside a running job are a few a minute.
 */
export const SANDBOX_PASS_MAX_REAPS_BUSY = 5;
export const SANDBOX_REST_MIN_BUSY_MS = 1_000;

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
 * `prepared.sandbox` is `{ jobId, kind, image, backend, jobUser?, podmanStore?, size? }`, stamped by `makePrepareWorkspace` (`jobUser`
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
		// Issue #796: a canary's candidate is third-party code that was on trial for that one job. Reopening the retained directory loads neither it nor the overlay, so it would only
		// sit there looking as if it were part of the run's inputs.
		fs.rmSync(join(jobDir, "canary"), { recursive: true, force: true });
		// Issue #920: the run's artifacts were kept already, in their own store under their own retention (artifacts.mjs);
		// a second copy here would outlive or undercut that, and is the agent's output beside a workspace a person reopens.
		fs.rmSync(join(jobDir, "artifacts"), { recursive: true, force: true });

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

		// Issue #761: `withManifestVersion` stamps a version only when a field needs one, so today's manifest is unchanged.
		const manifest = withManifestVersion({
			jobId: meta.jobId,
			...(typeof prepared.sha === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(prepared.sha) ? { baseSha: prepared.sha } : {}),
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
			// Issue #596: the run's size (`{ memMiB, cpuCenti, source }`), so a sandbox reopens the run at it. Written only when
			// known, so every other manifest is the shape it always was; a manifest without it reopens at the built-in 4g
			// and 2, the size every run had before sizes existed.
			...(meta.size && typeof meta.size === "object" ? { size: meta.size } : {}),
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
		});
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
export function listSandboxes({ sandboxDir, fs = defaultFs, throwOnReadFailure = false }) {
	if (!sandboxDir) return [];
	let names;
	try {
		names = fs.readdirSync(sandboxDir);
	} catch (error) {
		if (throwOnReadFailure) throw error;
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
export function pinSandbox({ sandboxDir, jobId, pinDays, fs = defaultFs, now = () => Date.now(), euid = process.geteuid?.(), supported = SANDBOX_MANIFEST_VERSION }) {
	const manifest = readManifest({ sandboxDir, jobId, fs });
	if (!manifest) return { pinned: false, reason: "absent" };
	// Issue #761: refused BEFORE the rewrite. This build would write back a manifest it cannot read, under a stamp it
	// cannot vouch for; the release that kept the run pins it. (The sweep still honours the deadline either way.)
	if (sandboxManifestNewer(manifest, { supported })) return { pinned: false, reason: "manifest-newer" };
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
		fs.writeFileSync(tmp, `${JSON.stringify(withManifestVersion({ ...body, keepUntil }), null, 2)}\n`, { mode, flag: "wx" });
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
 *
 * BOUNDED PASSES, IN LAPS (issue #978). A pass stops at `SANDBOX_PASS_BUDGET_MS` of wall time or
 * `SANDBOX_PASS_MAX_REAPS` removals, and rests after each entry that asked a runtime or deleted something for as long
 * as that entry took (`SANDBOX_REST_MIN_MS` to `SANDBOX_REST_MAX_MS`). The budget is looked at ONLY at a loop boundary:
 * before each leftover tombstone, before a stray non-directory's unlink, and after an expired run's verdict and before
 * its runtime is asked. Never between that ask, the fresh read, the rename, the read through the tombstone and the
 * delete, so every guard in that stretch is exactly what it was, and a budget spent during a delete lets it finish.
 *
 * A LAP walks the leftover tombstones, then the runs, then each runtime's networks, each in name order, and a pass
 * the budget stops leaves its place (`lap`) for the next pass to resume from, so entries the pass HELD (a run its
 * runtime reports open, one whose runtime timed out, a tombstone that will not delete) are passed, never visited again
 * in the same lap, and cannot starve the entries after them. Every pass visits at least one entry before the budget
 * can stop it, so a lap always ends, and the pass that ends it says `more: false`, removed anything or not. That is
 * the whole bound on the follow-up passes: a chain of them is at most ONE lap of the listing, and the next lap is the
 * next boot or periodic sweep. `reapSandboxes` resolves `{ more, reaped, held, ms, restedMs, slowestCheckMs }` (and
 * `stopped: true` for a pass told to stop), says the same in one `sandbox_reaper_pass` line when the pass did anything,
 * and `more` means only that the lap is not over. A pass that resumes past the tombstones or the runs still lists the
 * root and asks which sandboxes run, since the network sweep keys on both.
 *
 * BESIDE JOBS (issue #1023). `activity` is the worker's count of the job containers it is starting and running
 * (container-activity.mjs); start.mjs hands the one every venue's run function reports through. With it a pass:
 *   - WAITS while a container is starting, before its first runtime call (the listing of the open sandboxes), once
 *     that listing has answered and after each rest, in slices of `SANDBOX_REST_POLL_MS` and for at most
 *     `SANDBOX_START_WAIT_MAX_MS` in all, outside the time budget;
 *   - LOOKS AGAIN BEFORE EACH REMOVAL: once a run's runtime has answered, and before a leftover tombstone is read. A
 *     container that began starting while the runtime answered (seconds, on a slow daemon) is waited for there, out
 *     of the same allowance, and the run's runtime is then ASKED AGAIN, so nothing ever waits between a guard (the
 *     runtime's answer, the fresh read, the read through the tombstone) and the removal it guards: a removal never
 *     acts on a look that is as old as a wait. With the allowance used up the removal goes ahead. The session
 *     networks have no such look: their guards and their `rm` are the sweeper's own (`sandbox.mjs`), and a start that
 *     begins while one is asked about is met after that network, by its rest and the wait behind it;
 *   - is SMALLER while one is starting or running: `SANDBOX_PASS_MAX_REAPS_BUSY` removals, the networks it asked
 *     the daemon about among them, and a rest of at least `SANDBOX_REST_MIN_BUSY_MS`, each read at the boundary or
 *     the rest it applies to. A pass that has made its removals among the runs leaves the networks to the next.
 * HOW LONG SUCH A PASS CAN LAST. Its time budget, the entry it was on and that entry's rest, as before; and on top,
 * what the budget leaves out: up to `SANDBOX_START_WAIT_MAX_MS` of waiting, and one more ask of a runtime after each
 * wait before a removal, at most 80 a pass, each as long as the runtime takes to answer (an ask that gets no answer
 * holds the run and asks no more). So a pass is bounded, and in the worst case long: 192 s measured for one removal
 * at 2 s asks, 759 s at 9 s asks.
 * It still visits one entry before anything can stop it, so the lap moves on every pass however busy the host is. The
 * pass says how long it waited (`waitedForStartsMs`, in the result and the line), how many times it asked a runtime
 * again after a wait (`askedAgain`, in both, when it did) and that it ran beside a job
 * (`busy: true`, in the line only: on a result that word already means a call that met a pass in flight). Without an
 * `activity` (every caller but the worker), and with one that counts nothing (the boot pass, before any job), a pass is
 * exactly the pass it was. A count that throws or is no number reads as zero: the sweep's contract is that it never
 * throws, and a sweep that stopped for a broken counter would be the worse fault.
 */
export function makeSandboxReaper({
	sandboxDir,
	retentionHours,
	fs = defaultFs,
	remove = rm,
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
	// Issue #978: the pass's own clock, for its budget, its rests and its timings. MONOTONIC and apart from `now`, which
	// dates the runs and names the tombstones: a wall clock stepped back an hour must neither end a pass early nor stretch
	// it. Seamed with `sleep` so a test drives both, and so does a script measuring a real daemon.
	clock = () => performance.now(),
	// Issue #978: the one wait a rest is made of, asked in slices of at most `SANDBOX_REST_POLL_MS`. NOT unref'd: the
	// boot pass rests before anything else holds the event loop, and an unref'd timer there lets the process exit.
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	// Issue #1023: `{ starting(), running() }`, the worker's count of its job containers (see BESIDE JOBS above). Null
	// counts none, and every pass is then what it was.
	activity = null,
}) {
	// Across passes, never reset: two tombstones of one pass share `pid` and `at`, and a pass on the same millisecond as
	// the last must not reuse a name either.
	let seq = 0;
	// The stuck tombstones already said, and when (`SANDBOX_TOMBSTONE_RELOG_MS`). Only rate-limits a log line; losing it
	// on a restart costs one repeated line.
	const stuckSaid = new Map();
	// The pass in progress (issue #978): its start, its stop and its counts, null between passes. ONE PASS AT A TIME, and
	// that is a correctness rule here, not tidiness: the leftover sweep below clears every tombstone this pid named on
	// the promise that passes never overlap. Boot, the daily tick and the follow-up passes all call this one closure, so
	// a call while a pass runs answers `{ busy: true }` and touches nothing; the pass in flight covers what it would have.
	let tally = null;
	// WHERE THE LAP STANDS (issue #978), carried from pass to pass: the loop the next pass starts in, and the first name
	// in it this lap has not visited (null: its start). A pass the budget stops records the entry it stopped at; a loop
	// that reaches its end hands the lap to the next loop, and the network sweep's end closes the lap. In memory only: a
	// restart starts a new lap, which is a boot sweep's job anyway.
	// `id` numbers the laps, so the network sweepers can tell a new lap from the one their own place belongs to.
	const lap = { phase: "tombstones", at: null, id: 1 };
	return async function reapSandboxes({ stopped = () => false } = {}) {
		if (tally) return { busy: true };
		tally = { started: clock(), reaped: 0, held: new Set(), removals: 0, visited: 0, rests: 0, restedMs: 0 };
		tally.slowestCheckMs = 0;
		// Issue #1023: what is left of this pass's wait for starting containers, how many slices it waited and how long
		// that took on the pass's clock, and whether a boundary or a rest found a job starting or running.
		Object.assign(tally, { waitLeft: SANDBOX_START_WAIT_MAX_MS, waits: 0, waitedMs: 0, busy: false });
		// And: how many times a run's runtime was asked again after a wait that fell between its answer and the removal,
		// and how many session networks the network sweep asked the daemon about (they count toward the cap beside a job).
		Object.assign(tally, { askedAgain: 0, networks: 0 });
		try {
			return await sweep(stopped);
		} finally {
			tally = null;
		}
	};

	/** One pass, under `reapSandboxes`'s single flight. Never throws, and resolves the pass's result (`finish`). */
	async function sweep(stopped) {
		if (!sandboxDir) return finish(false);
		// Issue #1023: before this pass asks a runtime anything (the listing of open sandboxes is its first call).
		if (activity !== null) await holdForStarts(stopped);
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
				return finish(false);
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
		// tombstone this process named is always from an earlier pass (passes never overlap: `reapSandboxes` answers a call
		// made during one `{ busy: true }`, issue #978), and one another process left
		// behind is cleared once it is old enough that no pass could still hold it.
		// SORTED (issue #978), so the lap's place is a name that means the same on the next pass whatever order the
		// filesystem lists in.
		names.sort();
		const runs = names.filter((name) => !isSandboxTombstone(name));
		const pass = now();
		// The pinned tombstones this pass could not put back, for ONE retry after the main loop (PR #457's final check).
		const heldPinned = [];
		for (const name of lap.phase === "tombstones" ? names : []) {
			if (stopped()) return finish(false, true);
			if (!isSandboxTombstone(name) || passed(name)) continue;
			const owner = sandboxTombstonePid(name);
			const age = sandboxTombstoneAge(name, pass);
			// Only while that process is ALIVE (gate round 1): a worker that crashed between its rename and its delete
			// and was restarted has a new pid, and its tombstone is a plain leftover to clear now, not in ten minutes. A
			// NEGATIVE age (a name stamped by a clock that ran ahead) is not young, it is unknowable, and is treated as
			// old (gate round 2): otherwise a reused pid would hold it forever. The skip is said once a period.
			if (owner !== null && owner !== pid && age !== null && age >= 0 && age < SANDBOX_TOMBSTONE_STUCK_MS && pidAlive(owner)) {
				tally.held.add(name);
				sayOnce(name, pass, { reason: "tombstone-foreign" });
				continue;
			}
			// THE BUDGET, at this loop's one boundary (issue #978). Spent here, the pass returns AT ONCE rather than read and
			// place runs it could not finish, and the next pass resumes at this tombstone: one left for later has nothing to
			// undo, and `clearTombstone` never deletes a live pin, so stopping loses none.
			if (budgetSpent()) return stopAt(name);
			tally.visited += 1;
			if ((await clearTombstone(name, pass, stopped)) === "pinned-held") heldPinned.push(name);
		}
		if (lap.phase === "tombstones") enter("runs");
		names = runs;

		// ONE READ DECIDES (issue #429, review round 3). Every retained directory's manifest is read ONCE per pass, here,
		// and that one result is what the runtime watch places the run by AND what expiry decides on. Two reads let a
		// pass decide on one and delete on another: a read that failed for the watch (skipping a hold) and succeeded
		// for expiry, or the reverse, deleted a directory under an open sandbox (reproduced twice). So the listing
		// comes first now, then the reads, then the question to the runtimes, handed the reads.

		const reads = new Map();
		for (const name of names) {
			if (stopped()) return finish(false, true);
			reads.set(name, readRetained(fs, join(sandboxDir, name)));
			await new Promise((resolve) => setImmediate(resolve));
		}

		let running = new Set();
		try {
			running = new Set(await listRunning({ names, reads }));
		} catch (err) {
			// Could not ask docker. Sweeping blind risks pulling a mount out from under a live shell, so
			// skip this sweep entirely: a directory kept one boot too long is the cheaper mistake.
			log("sandbox_reaper_skipped", { reason: scrubCredentials(err?.message ?? "running-lookup-failed") });
			return finish(false);
		}
		// Issue #1023: and again once the listing has answered. Reading every manifest and asking each runtime can take
		// seconds on a slow daemon, long enough for a job to begin starting, and the first run below would be asked about
		// and removed beside it. What the listing said is no staler for this than for the rests that follow: each run's
		// own runtime is asked again right before its rename, whenever the pass gets to it.
		if (activity !== null) await holdForStarts(stopped);

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
		// Whether the budget stopped this loop with an expired run (or a stray entry) still to visit (issue #978).
		let more = false;
		for (const name of lap.phase === "runs" ? names : []) {
			if (stopped()) return finish(false, true);
			if (passed(name)) continue;
			const dir = join(sandboxDir, name);
			// Set ONLY around a removal, so `blocked` means what its name says. The first version added every
			// throw in this loop, which is a different set: a directory that VANISHED between the listing and
			// the lstat is not a directory that could not be removed, and the note it produced asserted the
			// opposite of what had happened -- that the directory stays on disk, so its id stays in `keep` and
			// its network is never a candidate again. It does not stay, and it is.
			let removing = false;
			// When this entry began asking a runtime or deleting, for the rest after it (issue #978); null for an entry
			// that did neither, which costs the daemon nothing and so rests for nothing.
			let began = null;
			// What this pass had waited for starting containers by then (issue #1023): a wait inside the entry is not time
			// the entry took, and the rest after it is as long as the entry took.
			const waitedBefore = tally.waitedMs;
			try {
				// lstat: a symlink here resolves on the host, and this tree is agent-written.
				if (!fs.lstatSync(dir).isDirectory()) {
					// The budget before this removal as before every other (issue #978). Synchronous, so nothing runs
					// between the lstat above and the unlink below.
					if (budgetSpent()) {
						more = true;
						lap.at = name;
						break;
					}
					tally.visited += 1;
					removing = true;
					began = clock();
					// A non-directory unlink is bounded and must not yield before acting on the lstat above.
					fs.rmSync(dir, { force: true });
					tally.removals += 1;
					tally.reaped += 1;
					log("reaped_sandbox", { entry: name, reason: "not-a-directory" });
					continue;
				}
				// An operator is inside it. Counted among the held (issue #978), so the pass line says how many are open.
				if (running.has(name)) {
					tally.held.add(name);
					continue;
				}
				// A manifest that could not be read FOR A MOMENT (`TRANSIENT_READ_ERRORS`: EMFILE, EIO and the rest) is
				// HELD this pass, full stop: no runtime answer can release it, because nothing about the run is known,
				// not even which runtime to ask. The next pass reads it again. Said once per directory per pass.
				const read = reads.get(name);
				if (read?.transient) {
					tally.held.add(name);
					log("sandbox_reaper_skipped", { entry: name, reason: "manifest-unread" });
					continue;
				}
				const verdict = expiry(read, at, retentionHours);
				if (!verdict.expired) continue;
				// THE BUDGET (issue #978), HERE AND NOWHERE FURTHER DOWN: after the verdict, so a run inside its window
				// never ends a pass, and before the runtime is asked, so the stretch from that ask through the fresh read,
				// the rename, the read through the tombstone and the delete runs whole once begun. A check inside it would
				// put a gap between a guard and the act it guards; a budget spent in it lets this run finish instead.
				if (budgetSpent()) {
					more = true;
					lap.at = name;
					break;
				}
				tally.visited += 1;
				began = clock();
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
				//
				// AND THE COUNT IS LOOKED AT AGAIN, ONCE THE RUNTIME HAS ANSWERED (issue #1023). The ask is a call to the
				// daemon, seconds long on the slow daemon this is for, and a job container that began starting meanwhile had
				// this run's delete beside it: measured with 2 s asks and a start every 6 s, 80 of 120 removals. So with a
				// container starting and wait left the pass waits here, and then ASKS THE RUNTIME AGAIN: the answer it had
				// is as old as the wait, and nothing may wait between a guard and the act it guards. The new answer decides,
				// and the fresh read below comes after the last wait, so it is asked once. Each wait uses at least one slice
				// of the pass's `SANDBOX_START_WAIT_MAX_MS`; once that is used up nothing waits and the removal goes ahead,
				// so one run cannot hold a pass: at most 80 asks again a pass, and a start that lasts seconds leaves a few.
				// WHAT THAT COSTS THE PASS. The budget is not read inside an entry, so these asks come on top of it: each as
				// long as the runtime takes to answer (one that does not answer holds the run, and that ends the asking).
				// Measured: 46 s for a pass with 2 s asks and a
				// 3 s start during each (7 asks again); in the worst case, 80 asks again for one removal, 192 s at 2 s asks
				// and 759 s at 9 s asks.
				let hold = null;
				let asked = began;
				for (let again = false; ; again = true) {
					if (again) {
						tally.askedAgain += 1;
						asked = clock();
					}
					hold = null;
					try {
						if ((await isOpen({ name, read })) === true) hold = "opened-during-pass";
					} catch {
						hold = "runtime-unanswered";
					}
					// How long the runtime took to answer, the one measure here that sees a loaded VM (issue #978): the
					// slowest of the pass goes in its summary line. A reading, not a decision.
					tally.slowestCheckMs = Math.max(tally.slowestCheckMs, clock() - asked);
					if (hold !== null || activity === null || !(await holdForStarts(stopped))) break;
					if (stopped()) return finish(false, true);
				}
				if (hold) {
					tally.held.add(name);
					log("sandbox_reaper_skipped", { entry: name, reason: hold });
					continue;
				}
				const fresh = readRetained(fs, dir);
				if (stopped()) return finish(false, true);
				if (fresh.transient || !sameRead(read, fresh)) {
					tally.held.add(name);
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
					tally.held.add(name);
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
					tally.held.add(name);
					log("sandbox_reaper_skipped", { entry: name, reason: "manifest-changed", ...(restored ? {} : { restored: false }) });
					continue;
				}
				try {
					await remove(tomb, { recursive: true, force: true });
				} catch (err) {
					// A tombstone that would not go STAYS one: the run is already unopenable, and the next pass retries.
					stuckSaid.set(tombName, at);
					tally.held.add(name);
					log("sandbox_reaper_skipped", { entry: name, reason: "tombstone-stuck", tombstone: tombName, code: err?.code ?? null });
					continue;
				}
				// Counted toward the cap only once it is done: a removal that failed costs the walk's time, never the cap.
				tally.removals += 1;
				tally.reaped += 1;
				log("reaped_sandbox", { entry: name, reason: verdict.reason });
			} catch (err) {
				if (removing) blocked.add(name);
				tally.held.add(name);
				log("sandbox_reaper_skipped", { entry: name, reason: scrubCredentials(err?.message) });
			} finally {
				// THE REST (issue #978), after an entry that asked a runtime or deleted, however it ended: held, kept or
				// reaped. It replaces the bare turn this loop yielded per tree (#924), which a removal that finishes at
				// once still needs and a slow daemon needed far more of. Never between the ask and the delete, since it
				// runs only once the entry is done.
				if (began !== null) await rest(clock() - began - (tally.waitedMs - waitedBefore), stopped);
			}
		}

		// THE HELD PINNED TOMBSTONES, ONCE MORE (PR #457's final check). One held because a directory with no manifest held
		// its run's name waited a whole pass for the next leftover sweep, though the loop above deletes such a directory
		// (`no-manifest`) in this same pass. Retried here, after the loop and before the network sweep (whose fresh
		// listing then sees the run back), through the same `clearTombstone`: its reads, its restore that displaces only an
		// empty directory, its rule that never deletes a live pin, and its once-per-period line when the name is still taken.
		for (const name of heldPinned) {
			if (stopped()) return finish(false, true);
			await clearTombstone(name, pass, stopped);
		}
		if (stopped()) return finish(false, true);
		// A PASS THE BUDGET STOPPED ENDS HERE (issue #978), after the retry above, which only ever puts a pinned run back,
		// and the next pass resumes at the run it stopped at. The networks wait for the pass that finishes the runs: keyed
		// on THAT pass's listing, as they always were, so nothing about which network is kept changes.
		if (more) return finish(true);
		if (lap.phase === "runs") enter("networks");
		// Issue #1023: beside a job the cap covers the networks too, so a pass that has made its removals among the runs
		// leaves the networks to the next one, which starts here. Without a job the pass goes on as it always did.
		// The lap's order decides when that is (issue #978, unchanged): a pass that ends on the cap with an expired run
		// still ahead in its own listing resumes at the runs, so the networks wait for the pass that finishes the runs
		// with removals to spare. Where runs expire ahead of the lap's place as fast as a pass removes them, the lap
		// never leaves the runs: measured, 5 newly expired runs a pass beside a job and no network was asked about in 60
		// passes, where 4 a pass ended the lap. Beside jobs that is 3,100 to 6,700 runs a day (the issue's host: 640);
		// the same held before at 50 a pass.
		if (busy() && budgetSpent()) return finish(true);

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
			// PACED like the directories (issue #978): the sweeper calls this after each network it asked the daemon about,
			// never between its last look and the `rm` (`sandbox.mjs`), and it rests as long as that network took and then
			// answers whether the pass may go on. False once the budget is spent: the sweeper stops there and says `more`.
			// Issue #1023: each call is one network the sweeper asked the daemon about, and it counts toward the cap a pass
			// has beside a job (`spent`). The sweeper does not say which of them it removed, so each one counts: every one
			// was at least one daemon call. Beside no job nothing reads the count, and the pass is the pass it was.
			let mark = clock();
			const pace = async () => {
				tally.networks += 1;
				await rest(clock() - mark, stopped);
				mark = clock();
				return !spent() && !stopped();
			};
			// Each runtime's sweeper keeps ITS place in the lap (`sandbox.mjs`), so a pass that resumes here goes on where
			// the last network pass stopped, runtime and network. `lapId` is how they know a place belongs to THIS lap: one
			// an earlier lap left (a lap a failed pass cut short) is dropped, and that runtime starts from its top.
			const outcome = await sweepNetworks({ running, keep, retained, blocked, pace, lapId: lap.id });
			const { swept, notes, failed, failures, more: left } = outcome;
			for (const s of swept) log("reaped_sandbox_network", s);
			for (const n of notes) log("sandbox_network_not_reaped", n);
			// One line per runtime whose listing failed, naming it (issue #429), where a sweeper that knows its runtime
			// says so; a bare `failed` from a single sweeper keeps the line it always had.
			if (Array.isArray(failures) && failures.length > 0) for (const f of failures) log("sandbox_reaper_skipped", { reason: f.reason, runtime: f.runtime });
			else if (failed) log("sandbox_reaper_skipped", { reason: failed });
			if (left === true) more = true;
		} catch (err) {
			log("sandbox_reaper_skipped", { reason: scrubCredentials(err?.message ?? "network-sweep-failed") });
		}
		if (stopped()) return finish(false, true);
		// The lap is over when the networks are (or their sweep failed, which is said above): `finish` starts a new one.
		return finish(more);
	}

	/** Whether `name` comes before the lap's place in its loop, so this lap already visited it (issue #978). */
	function passed(name) {
		return lap.at !== null && name < lap.at;
	}

	/** Hand the lap to the next loop, from its start (issue #978). */
	function enter(phase) {
		lap.phase = phase;
		lap.at = null;
	}

	/** End this pass at `name`, its loop's first entry not visited, where the next pass resumes (issue #978). */
	function stopAt(name) {
		lap.at = name;
		return finish(true);
	}

	/**
	 * `spent()` once this pass has visited an entry, and never before (issue #978): every pass visits at least one, so
	 * the lap moves on every pass, even one whose runtime listing alone took the whole budget, and always ends.
	 */
	function budgetSpent() {
		return tally.visited > 0 && spent();
	}

	/**
	 * Whether this pass has spent its budget (issue #978): `SANDBOX_PASS_BUDGET_MS` of its own clock since it started,
	 * rests included (its waits for starting containers not, issue #1023), or `SANDBOX_PASS_MAX_REAPS` removals made
	 * (`SANDBOX_PASS_MAX_REAPS_BUSY` beside a job, the networks asked about among them). Asked only at the loop
	 * boundaries named in the header, never inside one entry's stretch, and through `budgetSpent` there.
	 */
	function spent() {
		// Issue #1023: the time waited for starting containers is not the pass's own, and the removals allowed are fewer
		// beside a job, read here, at the boundary that asks. Beside a job the networks the sweep asked the daemon about
		// count with the runs and tombstones removed; beside none only those two, as before.
		if (clock() - tally.started - tally.waitedMs >= SANDBOX_PASS_BUDGET_MS) return true;
		return busy() ? tally.removals + tally.networks >= SANDBOX_PASS_MAX_REAPS_BUSY : tally.removals >= SANDBOX_PASS_MAX_REAPS;
	}

	/** `read()` as a count (issue #1023): zero for a throw and for anything that is no positive number. */
	function countOf(read) {
		try {
			const n = read();
			return Number.isFinite(n) && n > 0 ? n : 0;
		} catch {
			return 0;
		}
	}

	/** Whether a job container is starting or running right now (issue #1023), noted for the pass's line. */
	function busy() {
		if (activity === null) return false;
		const is = countOf(() => activity.starting()) > 0 || countOf(() => activity.running()) > 0;
		if (is) tally.busy = true;
		return is;
	}

	/**
	 * Wait while a job container is starting (issue #1023): slices of `SANDBOX_REST_POLL_MS`, `stopped` asked before
	 * each, until none is starting or this pass's `SANDBOX_START_WAIT_MAX_MS` is used up. Like a rest it ends by the
	 * slices it asked for, and what it took on the pass's clock is what the budget leaves out and the summary says.
	 * Called at the top of a pass, after its listing of the open sandboxes and at the end of a rest, each between
	 * entries with no guard pending; and for one entry before its removal, where the caller asks that entry's guards
	 * again after a wait: once a run's runtime has answered, and before a leftover tombstone is read. Resolves whether
	 * it waited at all, which is what tells such a caller that a guard it holds is no longer fresh.
	 */
	async function holdForStarts(stopped) {
		const from = clock();
		const before = tally.waits;
		while (tally.waitLeft > 0 && !stopped() && countOf(() => activity.starting()) > 0) {
			tally.busy = true;
			const slice = Math.min(tally.waitLeft, SANDBOX_REST_POLL_MS);
			await sleep(slice);
			tally.waitLeft -= slice;
			tally.waits += 1;
		}
		tally.waitedMs += clock() - from;
		return tally.waits > before;
	}

	/**
	 * Rest after an entry that took `took` ms (issue #978): that long, clamped to `SANDBOX_REST_MIN_MS`
	 * (`SANDBOX_REST_MIN_BUSY_MS` beside a job, issue #1023) and
	 * `SANDBOX_REST_MAX_MS`, in slices of `SANDBOX_REST_POLL_MS` with `stopped` asked before each, so a pass told to stop
	 * wakes within one slice. It ends by the slices it asked for, never by the clock, so a sleep that returns early ends
	 * too; the time it actually took is what the summary counts.
	 */
	async function rest(took, stopped) {
		// Issue #1023: a longer floor beside a job, read as this rest begins.
		let left = Math.min(SANDBOX_REST_MAX_MS, Math.max(busy() ? SANDBOX_REST_MIN_BUSY_MS : SANDBOX_REST_MIN_MS, Number.isFinite(took) ? took : 0));
		const from = clock();
		tally.rests += 1;
		while (left > 0 && !stopped()) {
			const slice = Math.min(left, SANDBOX_REST_POLL_MS);
			await sleep(slice);
			left -= slice;
		}
		tally.restedMs += clock() - from;
		// Issue #1023: and before the next entry, the wait for a container that is starting. The entry this rest follows
		// is done, so nothing here sits between a guard and its act.
		if (activity !== null) await holdForStarts(stopped);
	}

	/**
	 * The pass's result (issue #978), `{ more, reaped, held, ms, restedMs, slowestCheckMs }` plus `stopped: true` for a
	 * pass told to stop, which never asks for more (it is the worker shutting down). `held` counts the runs and tombstones
	 * it kept for a reason, a run with a sandbox open among them. Said once as `sandbox_reaper_pass` when the pass did
	 * anything (removed or held an entry, rested after one, waited for a starting container, or left the lap
	 * unfinished), so a quiet pass on a tidy host says nothing and the line a slow daemon produces carries the reading
	 * that would tell the cause: how long the pass took, how much of that was rest, and the slowest runtime answer.
	 * Issue #1023 adds `waitedForStartsMs` to both for a pass that waited for a starting job container (`ms` is the whole
	 * pass, that wait and the rests included), `askedAgain` to both for a pass that asked a run's runtime again after
	 * such a wait (how many times), and `busy: true` to the line for a pass that met a job starting or running.
	 */
	function finish(more, wasStopped = false) {
		const summary = {
			more: more === true && !wasStopped,
			reaped: tally.reaped,
			held: tally.held.size,
			ms: Math.round(clock() - tally.started),
			restedMs: Math.round(tally.restedMs),
			slowestCheckMs: Math.round(tally.slowestCheckMs),
			// Issue #1023: only for a pass that waited, so every other pass's result and line are what they were.
			...(tally.waits > 0 ? { waitedForStartsMs: Math.round(tally.waitedMs) } : {}),
			...(tally.askedAgain > 0 ? { askedAgain: tally.askedAgain } : {}),
			...(wasStopped ? { stopped: true } : {}),
		};
		// `busy` in the line and not in the result: `{ busy: true }` is already what a call that met a pass in flight gets.
		if (summary.more || summary.reaped > 0 || summary.held > 0 || tally.rests > 0 || tally.waits > 0) log("sandbox_reaper_pass", tally.busy ? { ...summary, busy: true } : summary);
		// A pass that ends without `more` for any reason but a stop ends the LAP (issue #978): at its end, or cut short by a
		// listing or runtime fault. Resuming one a fault cut short would leave a tombstone or a run that appeared meanwhile
		// before its place for yet another sweep, where the next lap clears tombstones first, as its contract says.
		if (!summary.more && !wasStopped) {
			lap.id += 1;
			enter("tombstones");
		}
		return summary;
	}

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
	async function clearTombstone(name, at, stopped) {
		const path = join(sandboxDir, name);
		// Issue #1023: the count once more, BEFORE the read this tombstone's removal acts on. The pass last looked at the
		// end of a rest or at its top, and a tombstone it then held yielded a turn, in which a job can begin to start.
		// Nothing below waits between the read and the delete. A pass told to stop during that wait removes nothing.
		if (activity !== null && (await holdForStarts(stopped)) && stopped()) return null;
		const read = readRetained(fs, path);
		const keepUntil = Date.parse(read.manifest?.keepUntil ?? "");
		let held = false;
		// When its removal began, for the pass's rest after it (issue #978); null when nothing was deleted.
		let began = null;
		if (read.transient) {
			tally.held.add(name);
			sayOnce(name, at, { reason: "manifest-unread" });
		} else if (Number.isFinite(keepUntil) && keepUntil > at) {
			const target = restoreName(read.manifest);
			const restored = target !== null && restoreTombstone(path, join(sandboxDir, target));
			if (restored) {
				stuckSaid.delete(name);
				tally.held.delete(name);
				log("sandbox_reaper_skipped", { entry: name, reason: "tombstone-pinned", restored: true });
			} else {
				held = target !== null;
				tally.held.add(name);
				sayOnce(name, at, { reason: "tombstone-pinned", restored: false });
			}
		} else {
			began = clock();
			try {
				await remove(path, { recursive: true, force: true });
				stuckSaid.delete(name);
				tally.held.delete(name);
				// Toward the cap only once done, as in the main loop: a failed removal costs time, never the cap.
				tally.removals += 1;
				tally.reaped += 1;
				log("reaped_sandbox", { entry: name, reason: "tombstone" });
			} catch (err) {
				tally.held.add(name);
				sayOnce(name, at, { reason: "tombstone-stuck", code: err?.code ?? null });
			}
		}
		// After a removal, the pass's rest, for the main loop's reason (issue #978); otherwise the per-tree yield this has
		// always had, since this runs on the timer beside draining jobs and a pass of held tombstones must still yield.
		if (began !== null) await rest(clock() - began, stopped);
		else await new Promise((resolve) => setImmediate(resolve));
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
