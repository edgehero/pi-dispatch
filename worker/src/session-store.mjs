import {
	copyFileSync,
	lstatSync,
	mkdirSync,
	openSync,
	closeSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sessionKeyFor } from "./session-key.mjs";
import { resolveBackendName } from "./backend-registry.mjs";
import { UNATTRIBUTED_BACKEND } from "./backends.mjs";

/**
 * session-store.mjs -- the host side of a resumable session (INT-SESSION-STORE-CONTRACT).
 *
 * THE CANONICAL STORE IS NEVER MOUNTED. A job gets a per-job COPY, under its own jobDir, and only a
 * `completed` run's output is promoted back. Three properties fall out of that one decision, and each
 * would need its own mechanism otherwise:
 *
 *   - CONST-RETRY-INFRA-ONLY survives. A policy or infra exit discards the container's writes entirely,
 *     so attempt 2 starts from exactly what attempt 1 did. Promote on every exit and "retry" quietly
 *     stops meaning re-run and starts meaning continue.
 *   - CONST-ISOLATION-CONTAINER-PER-JOB's "every mount operator- or worker-supplied, none host-wide"
 *     stays true verbatim: /session is per-job exactly as /job is. A container can name its own copy and
 *     nothing else, so a compromised agent that computes another repo's key still cannot reach it -- the
 *     mount is the capability, and the hash is not one.
 *   - The validation happens host-side, on both edges, where the agent cannot influence it.
 *
 * NEVER THROWS. Every path returns `{ resume, reason, ... }` or null-ish, because a disk fault must not
 * fail a prepare that only asked whether there was a transcript -- the posture makeFindPreviousRun
 * already sets. The one fail-CLOSED case lives in the processor, not here, and it is a gate this module is
 * never asked: runJob returns a `sessions-dir-unset` policy refusal for a job whose trigger armed
 * `run.resume` while `sessionsDir` is null (processor.mjs, before the mint and before reserveBudget), so a
 * job that reaches `resolveSession` at all has already been proven to have somewhere to persist to.
 * Refused rather than run, because running it silently without persistence is the failure
 * validatePackagesFlag's own comment describes.
 */

/** Container-side name, fixed. Nothing key-derived crosses the boundary -- see makeSessionStore. */
export const SESSION_FILE_NAME = "current.jsonl";
const PI_VERSION_FILE = "pi-version";
const LOCK_FILE = "lock";
/**
 * How many times in a row this key's transcript has been HANDED TO A CONTAINER. A counter rather than a
 * derivation, because there is nothing to derive it from: the run record deliberately carries no session
 * key (DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED), so counting past runs would need the key->record index
 * that entry refuses. One integer beside the transcript it describes is not that index; it is keyed state
 * written where the key already is, and it answers exactly one question rather than being a query
 * surface. Maintained even when no bound is set, deliberately -- see the write in promoteSession.
 *
 * IT COUNTS THE HOST'S DELIVERIES, NOT PI'S CONTINUATIONS, and that is the whole security of this bound.
 * It counted pi's `resumed` first, on the reasoning that a transcript pi declined to continue extended
 * nothing. That reasoning is wrong here, because the agent owns /session and therefore chooses what pi
 * makes of the file: a transcript carrying a valid header and payload on lines pi's parser DROPS is
 * delivered by the host every run while pi reports zero messages, so the counter reset every run and the
 * chain bound never fired -- measured, not theorised. The host's own decision to hand the file over is
 * the one fact in this exchange that nothing inside the container can influence.
 */
const RESUME_CHAIN_FILE = "resume-chain";
/**
 * How full the context was when the run that wrote this transcript ended, as `<tokens> <window>`. Both
 * numbers, not a precomputed percentage: the denominator is what makes the numerator readable later, and
 * an operator looking at a refusal should be able to see what it was judged against.
 *
 * Reported BY THE CONTAINER, which is the only place the number exists: pi computes it from the session
 * it is holding. That puts it at the same trust level as `turns` and `tokens`, and the residual is
 * recorded in OQ-003 rather than papered over -- there is no host-side alternative that is not equally
 * agent-influenced, since the transcript itself is agent-written.
 */
const CONTEXT_FILE = "context";
/**
 * The venue whose container produced the transcript beside it (issue #277): a backend name, one line.
 *
 * A SIDECAR, NOT KEY MATERIAL. `DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED` makes the key a pure function of
 * (kind, repo, ref), and a venue in the key would fork a trigger moved between venues into a second lineage
 * that nothing ever sweeps. As a sidecar it GATES the one lineage instead: the move costs one cold start.
 *
 * ABSENT READS AS `UNATTRIBUTED_BACKEND`, never as the deployment default. Every transcript written before this
 * stamp existed ran on `local`, and the default is a setting that can move under it.
 */
const VENUE_FILE = "venue";
/**
 * What the venue stamp reads while a promotion is swapping the transcript under it. It matches no venue:
 * parentheses are outside the charset every backend name is validated against (a test pins every name this
 * build knows to it), so a key left holding this cold-starts on every venue until a promotion completes.
 */
const VENUE_PENDING = "(pending)";

/**
 * Per-promotion suffix for the transcript's in-flight copy, paired with the pid.
 *
 * The tmp name USED to be a fixed `<canonical>.incoming`, which was self-cleaning and harmless while the
 * per-key lock guaranteed one writer. The stale-lock takeover concedes a window with two, and a SHARED tmp
 * path voids exactly the atomicity the swap exists for: B's unlink removes A's in-flight copy, B's copy
 * replaces it, and whichever renames second can put the other's half-written file at the canonical path --
 * an agent handed a truncated conversation with no gate able to see it. `triggers-file.mjs` learned this
 * on `triggers.json` and its `tmpPathFor` says the same thing.
 *
 * RANDOM BYTES, not just a pid and a counter, and the pid is why: two workers can share one. Two
 * containers where node is pid 1, or two hosts on one shared `PI_SESSIONS_DIR` -- which is the very
 * `OQ-031` shape the takeover's own skew analysis invokes -- produce byte-identical `<canonical>.1.0.incoming`
 * names, measured, and a shared destination does tear (two processes copying 4 MiB to one path mixed both
 * writers' bytes in 1 sample of 110). A pid-and-counter name separates two promotions inside ONE process,
 * which is the one case that cannot happen, and leaves the case that can. The random half is what actually
 * separates writers; the pid and counter stay because they make a straggler attributable.
 *
 * The cost is that a crash between the copy and the rename leaves a uniquely named straggler instead of one
 * the next promotion overwrites; the reaper's recursive sweep of the key takes it with everything else --
 * except under `PI_SESSIONS_TTL_DAYS=0`, where that sweep does not run at all, so stragglers accumulate
 * there where the old shared name was self-cleaning. The same TTL-0 caveat the lock's takeover carries.
 *
 * The SIDECAR temps keep the shared name deliberately, and the asymmetry is the point rather than an
 * oversight: a sidecar's worst case under a concurrent writer is a missing or half-written sidecar, and
 * every one of those reads back as `null` and produces a cold start, which this store already treats as
 * the safe outcome. The transcript's worst case is a corrupt transcript, which it does not.
 */
let tmpSeq = 0;

/**
 * A promotion lock older than this is a crashed writer's, not a live one's.
 *
 * `triggers-file.mjs` holds the same idiom at ten seconds; this is 360 times that, because the work under
 * the two locks is not comparable. A trigger write is a read, one mutate and two syscalls. A
 * promotion is a COPY of the container's transcript -- up to `PI_SESSION_MAX_BYTES`, 8 MiB by default --
 * plus a rename and four small sidecar writes.
 *
 * AN ASSERTION ABOUT STORAGE, NOT A DERIVATION, and said plainly because `PI_SESSION_MAX_BYTES=0` is a
 * supported setting and there is then no configured bound to derive from. An hour covers roughly three
 * gigabytes at a megabyte a second, which is a slower store than anything this project will meet.
 *
 * WHAT MAKES A GENEROUS NUMBER THE RIGHT TRADE IS THE ASYMMETRY. Too short steals a LIVE writer's lock,
 * and with the release-by-path residual below that degrades into the lock being functionally absent. Too
 * long only delays recovery on a key nobody is watching, at one extra cold start per job until it passes.
 *
 * A CONSTANT RATHER THAN A KNOB, on triggers-file's precedent: the one value an operator would reach for
 * is zero, and zero here means no lock at all.
 */
const LOCK_STALE_MS = 3_600_000;
/** Every sidecar format is a handful of bytes. Generous, and still nowhere near a job's wall clock. */
const SIDECAR_MAX_BYTES = 4096;
/**
 * The host-effective provider and model as one token, or null when the job names neither.
 *
 * CONSERVATIVE BY CONSTRUCTION: the sidecar is whitespace-delimited, so a value carrying a space would
 * split the record and be read back as a different field. Rather than escape, refuse: anything outside
 * the charset the run record already validates model ids against is no identity, and no identity means
 * the reading stays usable rather than being thrown away.
 */
function modelIdentity(job) {
	const provider = typeof job?.provider === "string" ? job.provider : "";
	const model = typeof job?.model === "string" ? job.model : "";
	if (provider === "" || model === "") return null;
	// Lowercased first, the same normalisation the run record's own model ids get, so a trigger written
	// `Claude-Sonnet` and one written `claude-sonnet` are one model rather than two -- and so that a
	// perfectly ordinary id does not fall out of the charset below and silently stop stamping.
	const id = `${provider}/${model}`.toLowerCase();
	return /^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(id) ? id : null;
}

/**
 * A venue name as the store handles it: a non-empty string, else `null`. A promotion stamps `String(venue)`,
 * and `String(undefined)` is the word `undefined`, which is a valid-looking name; normalising first means a
 * session with no resolvable venue is stamped with nothing rather than with that.
 */
function normaliseVenue(venue) {
	return typeof venue === "string" && venue !== "" ? venue : null;
}

/**
 * Read-path outcomes. Every one is a named cold start rather than a bare `false`: a feature that fails
 * open is otherwise indistinguishable from a feature nobody switched on, which is precisely how "we
 * never resumed once in three months" goes unnoticed.
 */
const COLD = (reason) => ({ resume: false, reason, bytes: null });

export function makeSessionStore({
	sessionsDir,
	ttlDays,
	maxBytes,
	maxAgeDays = 0,
	maxResumeChain = 0,
	maxContextPct = null,
	// The deployment's default venue, `PI_BACKENDS[0]`, for a job that names none (#277). `null` is a
	// dependency-injection seam, and a job whose venue cannot be resolved never resumes.
	defaultBackend = null,
	log = () => {},
	now = () => Date.now(),
	fs = { copyFileSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync },
}) {
	/**
	 * Stage this job's /session directory and decide whether it resumes.
	 *
	 * @param {object} job - the job data.
	 * @param {object} opts - `{ jobDir, resolved, piVersion }`. `resolved` is `{ headRef, headRepo }` from
	 *   the FORGE API for a pull/merge-request target; `piVersion` is the job image's declared version.
	 * @returns {object|null} `{ hostDir, resume, reason, bytes, key }`, or `null` when this job gets no
	 *   /session mount at all (unarmed, or no key) -- which is byte-identical to a pre-feature job.
	 */
	function resolveSession(job, { jobDir, resolved = {}, piVersion = null } = {}) {
		// Declared outside the try so a fault can take back what this call staged (below).
		let hostDir = null;
		try {
			// Unreachable in a wired worker, and deliberately kept: resolveSession is only ever called for a
			// job that armed run.resume (prepare-github.mjs), and processor.mjs refuses exactly that job
			// pre-spend when this is null -- the `sessions-dir-unset` policy return. This stays as the
			// DI-seam backstop, because both the store and the preparer are injected and neither can assume
			// the caller came through that gate; a null here is the same no-mount, nothing-written shape a
			// pre-feature job had.
			if (!sessionsDir) return null;
			const key = sessionKeyFor(job, resolved);
			// No key is not a failure and not a degradation: this job has no durable identity (a fork PR, a
			// CLI run, an unresolvable head ref), so it gets no mount and no transcript on disk.
			if (key === null) return null;

			// The model this job will actually run, for the context bound. A key is (kind, repo, ref) and
			// carries NO model, so two triggers on one issue can name different ones, and the same token
			// count is 78% of a 32k window and 2.5% of a 1M one. Carried on the session object rather than
			// read again at promote time, so the reading is stamped with the model that produced it.
			const modelId = modelIdentity(job);
			// The venue this job will run in, resolved exactly as the registry dispatches it (#277). Carried on
			// the session like `modelId`, so the promotion stamps the venue that produced the transcript rather
			// than re-deriving one later.
			const venue = normaliseVenue(resolveBackendName(job, defaultBackend));
			hostDir = join(jobDir, "session");
			const staged = join(hostDir, SESSION_FILE_NAME);
			fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });

			// The identity is split off the verdict rather than carried on it: this return is spread onto the
			// session object the processor holds for the WHOLE run, and an inode number is bookkeeping for the
			// next few lines, not state a promotion an hour later should be able to read.
			const { ident: judged = null, ...judgedVerdict } = readCanonical(key, piVersion, modelId, venue);
			let verdict = judgedVerdict;
			if (verdict.resume) {
				fs.copyFileSync(canonicalFile(key), staged);
				// The read above and this copy are not under the promotion lock, so a promotion can land between
				// them and the copy would stage a transcript no gate judged. TWO re-checks, and neither subsumes
				// the other.
				//
				// The VENUE stamp catches a promotion that wrote its sentinel and then did NOT swap: the
				// transcript is unchanged, so no identity moved. Every promotion writes the pending sentinel
				// before it swaps and its own venue after, so a stamp that no longer names this venue after the
				// copy -- pending, or another venue outright -- means the file just copied may not be the one
				// that was judged.
				//
				// The IDENTITY catches a promotion that DID swap, which the stamp cannot see when the promoting
				// job shares this venue, and which it also cannot see across the A, B, A round trip that leaves
				// the stamp matching again (a residual this contract used to state). Every swap renames a fresh
				// inode into place, so the identity moves whether or not the stamp does.
				//
				// VENUE FIRST, deliberately: a cross-venue promotion trips BOTH, and `venue-changed` is the more
				// useful of the two answers there, because it names WHY and sends an operator to the venue docs
				// where `transcript-replaced` would only say that something moved. The first miss naming itself
				// is the same rule the gate ladder above runs on.
				//
				// Either way, empty the staged copy so the container is handed nothing of it -- the 0-byte shape
				// every cold start gets. If emptying fails, the catch below removes the staged directory rather
				// than leave the copy behind.
				const raced = readVenue(key) !== venue ? "venue-changed" : readIdentity(canonicalFile(key)) !== judged ? "transcript-replaced" : null;
				if (raced !== null) {
					fs.writeFileSync(staged, "");
					verdict = COLD(raced);
				}
			} else {
				// A 0-BYTE FILE, not an absent one. pi's setSessionFile then takes its empty-file branch and
				// writes its own header at this exact path, which marks the manager flushed -- so _persist
				// never reaches its openSync(path, "wx"), and the EEXIST race stops being a race. The host
				// never has to know pi's file format to get that.
				fs.writeFileSync(staged, "");
			}
			log("session_resolved", { key, resume: verdict.resume, reason: verdict.reason });
			return { hostDir, key, modelId, venue, ...verdict };
		} catch (err) {
			// A history fault must never fail the prepare that asked.
			log("session_store_failed", { phase: "resolve", reason: err?.message });
			// `null` means NO MOUNT AND NOTHING WRITTEN, so make the second half true, best effort. A fault after
			// the copy -- a partial copy, or the venue re-check failing to empty a transcript another venue just
			// promoted (#277) -- would otherwise leave that file under the job dir, which is mounted `/job:ro`:
			// no `/session`, but the transcript readable at `/job/session/current.jsonl` all the same.
			if (hostDir !== null) {
				try {
					fs.rmSync(hostDir, { recursive: true, force: true });
				} catch {
					// If this fails too, the copy stays under the job dir, which the container mounts before
					// teardown removes it. Two consecutive disk faults on one path; nothing further to try.
				}
			}
			return null;
		}
	}

	/**
	 * Promote the container's transcript back into the store. Called ONLY for a `completed` exit.
	 *
	 * Validates the agent's output before it becomes an input to a future job, then swaps it in under an
	 * exclusive per-key lock. A job that cannot take the lock discards rather than clobbers: two jobs on
	 * one key is a real shape (REQ-QUEUE-BURST-NO-DROP), and last-write-wins there would interleave two
	 * agents' turns into one transcript.
	 */
	/**
	 * Take the per-key promotion lock, with ONE stale takeover. Returns `{ fd }`, or `{ locked: true }` when
	 * a LIVE writer holds it. Throws only for non-EEXIST failures, which is the doctrine this call site
	 * already carried: a read-only directory, a full disk or a vanished store all fail to create the lock
	 * too, and reporting those as `locked` sends an operator hunting a stuck file that does not exist.
	 *
	 * WITHOUT THIS, A PROCESS KILLED INSIDE THE LOCK WEDGED THE KEY FOREVER (issue #336). Later promotions
	 * reported `locked` until the reaper swept the key, and the reaper keys on the TRANSCRIPT's mtime: a key
	 * whose first promotion died before any transcript landed had none to key on, and with
	 * `PI_SESSIONS_TTL_DAYS=0` the reaper does not run at all. A takeover works in both of those, which is
	 * why it is the primary fix and the reaper's own repair is the secondary one.
	 *
	 * `lstatSync`, never `statSync`. The injected `fs` deliberately carries no `statSync`, this module's
	 * whole doctrine is lstat-in-a-key-directory, and a DANGLING link planted at this name throws ENOENT
	 * under `stat` on every attempt, which is the same wedge in a different coat.
	 *
	 * TWO DIFFERENT CLOCKS, and the comparison is between them: `now()` is this process's, `mtimeMs` is the
	 * FILESYSTEM's, which on a network mount is a server's. `OQ-031` already records two hosts sharing one
	 * working tree as a live hazard, and a shared `PI_SESSIONS_DIR` is exactly that shape. Both signs of the
	 * skew are bad, and differently. A server more than `LOCK_STALE_MS` BEHIND makes every live lock read as
	 * stale, so the takeover fires on every attempt and the conceded double-take window stops being rare;
	 * worse, `releaseLock` unlinks by PATH rather than by fd, so once A's lock is stolen A's release deletes
	 * B's. A server AHEAD makes the difference negative, so a genuinely crashed writer's lock is NEVER
	 * swept -- which is precisely today's behaviour, so under that skew this degrades to the status quo
	 * rather than to something worse. Nothing here closes either; `triggers-file.mjs` states the same pair.
	 */
	function takeLock(dir, key) {
		const lock = join(dir, LOCK_FILE);
		let sweptAgeMs = null;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fd = fs.openSync(lock, "wx"); // exclusive create IS the lock; no daemon, no lease
				// Logged only AFTER the retake create SUCCEEDED. The unlink alone proves nothing, since a rival
				// sweeper can win the recreate race, and a takeover line for a lock we did not get would send an
				// operator reading a history that never happened.
				if (sweptAgeMs !== null) log("session_lock_stale_taken", { key, ageMs: sweptAgeMs });
				return { fd };
			} catch (err) {
				if (err?.code !== "EEXIST") throw err;
				let mtimeMs;
				try {
					mtimeMs = fs.lstatSync(lock).mtimeMs;
				} catch {
					// Released between our open and our stat: the next create answers.
					continue;
				}
				if (now() - mtimeMs <= LOCK_STALE_MS) return { locked: true };
				try {
					fs.unlinkSync(lock);
				} catch {
					// Someone else swept it first; the retry create answers who won.
				}
				sweptAgeMs = Math.round(now() - mtimeMs);
			}
		}
		return { locked: true };
	}

	function promoteSession(session, { piVersion = null, context = null } = {}) {
		// The second DI-seam backstop, and unreachable for the same reason as the `!sessionsDir` return
		// above: sessionKeyFor is total and binary (null, or 32 hex chars), so resolveSession returns null
		// rather than a keyless session, and processor.mjs only calls this when prepare handed it one. Kept
		// because the store and the preparer are separately injected and neither can assume the other. It is
		// NOT in INT-RUN-HISTORY-FILE-CONTRACT's session.reason enum, deliberately: a token no wired worker
		// can emit does not belong in the record's vocabulary, and `promote-failed` below does.
		if (!session?.key) return { promoted: false, reason: "no-key" };
		try {
			const staged = join(session.hostDir, SESSION_FILE_NAME);
			const check = inspectFile(staged);
			if (!check.ok) {
				log("session_promote_skipped", { key: session.key, reason: check.reason });
				return { promoted: false, reason: check.reason };
			}

			const dir = keyDir(session.key);
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

			const lock = join(dir, LOCK_FILE);
			// `locked` still means a LIVE writer and nothing else. A lock older than any plausible promotion is
			// taken over rather than believed (see `takeLock`); anything that is not EEXIST still falls through
			// to the outer catch and reports `promote-failed`, which is what actually happened.
			const taken = takeLock(dir, session.key);
			if (taken.locked) {
				log("session_promote_skipped", { key: session.key, reason: "locked" });
				return { promoted: false, reason: "locked" };
			}
			const fd = taken.fd;
			try {
				// Atomic swap: a reader either sees the old file or the new one, never a half-written one.
				// PER WRITER (see `tmpSeq`), not the fixed `.incoming` this shared before the lock could be taken
				// over. The random half is what separates two writers; the pid and counter are there to make a
				// straggler attributable, and neither is a writer identity on its own. The removal below stays
				// regardless: a name that is hard to guess is not a name that cannot be guessed.
				const tmp = `${canonicalFile(session.key)}.${process.pid}.${tmpSeq++}.${randomBytes(6).toString("hex")}.incoming`;
				// `copyFileSync` follows a link at the DESTINATION, so anything left at this name would receive
				// the whole transcript. `removeTemp` takes every shape; see its own comment for why one call
				// could not.
				removeTemp(tmp);
				fs.copyFileSync(staged, tmp);
				// THE VENUE STAMP IS INVALIDATED BEFORE THE SWAP, and fatally (#277). Removing a stamp does not
				// invalidate it, because an absent stamp reads as `local`; stamping only after the rename would
				// leave a window, and a failed post-swap write a permanent state, in which one venue's transcript
				// sits under another venue's stamp and the next job there resumes it. So every promotion first
				// writes a stamp no venue matches. If that write fails, nothing has been swapped and the outer
				// catch reports `promote-failed`; if the process dies after it, the key cold-starts everywhere
				// until a promotion completes. A process KILLED inside this lock also leaks the lock itself, as it
				// always has -- but it no longer wedges the key in the shapes that used to be permanent: the next
				// promotion takes a lock older than `LOCK_STALE_MS` over, and the reaper reaches a key with no
				// transcript through the directory's own mtime (issue #336). A lock whose mtime is in the FUTURE is
				// still never stale, so under `PI_SESSIONS_TTL_DAYS=0` such a key stays wedged. Unconditional rather than only
				// on a venue change, so the decision needs no read of the stamp under the lock and there is no
				// branch to get wrong.
				replaceSidecar(dir, VENUE_FILE, VENUE_PENDING);
				fs.renameSync(tmp, canonicalFile(session.key));
				// The real stamp FIRST of the post-swap writes, and the ordering is the contract. It is the only one
				// whose absence MISATTRIBUTES rather than cold-starts: between the rename and this write the key reads
				// `(pending)` and cold-starts on every venue, so every write placed ahead of it lengthens that window,
				// and `pi-version`, the chain counter and the context reading all degrade to a cold start instead.
				// (It used to be ordered ahead of the pi-version write because THAT write could throw. It no longer
				// can, and the ordering that survives is this one.) A session with no venue (a DI seam) leaves the
				// sentinel on purpose: no stamp is better than a guessed one.
				const venue = normaliseVenue(session.venue);
				if (venue !== null) writeSidecar(dir, VENUE_FILE, session.key, venue);
				// THROUGH `writeSidecar` like every other sidecar (issue #336). It was the one plain write left, and
				// it carried both halves of that exception: `writeFileSync` FOLLOWS a link, so a symlink planted at
				// this name -- at a path anyone who knows the repository and the branch can compute -- turned a
				// promotion into a truncating write of the link's target with the pi version as its payload; and it
				// sat inside the try, so a failure AFTER the swap reported `promote-failed` for a promotion that had
				// landed.
				//
				// A FAILED STAMP IS SAFE IN BOTH DIRECTIONS, which is why this one needs no sentinel of its own and
				// the venue stamp does. With no prior stamp the next read gets `null` and cold-starts. With one, it
				// survives beside the new transcript -- and it is still TRUE, because this job resumed only if that
				// stamp already matched its own image's pi, and a job runs one image. The remaining case, a job that
				// cold-started under a new pi and then failed this write, leaves the OLD version beside the new
				// transcript, and the next job on that image reads a mismatch and cold-starts. Stale-but-true, or a
				// cold start. Never a transcript resumed under a version that did not write it.
				//
				// `String(piVersion ?? "")` is load-bearing and must not be simplified to skipping the write: an empty
				// file is refused by `readSidecar`'s own size check and reads as `null`, so a promotion that knows no
				// version INVALIDATES the stamp. Skipping instead would leave a PREVIOUS version beside a transcript
				// written by an unknown pi, and the next matching job would resume it.
				writeSidecar(dir, PI_VERSION_FILE, session.key, String(piVersion ?? ""));
				// The chain and context sidecars, immediately after the swap and under the same lock. NOT part of
				// the swap itself, which is one rename and cannot be widened: what the lock buys them is that no
				// other job can interleave, and what the ordering buys them is that they never describe a
				// transcript older than the one now in place.
				//
				// EACH IS CAUGHT SEPARATELY, and that is not defensiveness for its own sake. These writes
				// run AFTER the transcript is already promoted, so letting one throw would return
				// `promote-failed` for a promotion that demonstrably happened -- a record that says the next
				// run will cold start when it will in fact resume, which is worse than the bookkeeping loss
				// it is reporting.
				writeSidecar(dir, RESUME_CHAIN_FILE, session.key, chainValue(session));
				writeContextSidecar(dir, session, context);
			} finally {
				fs.closeSync(fd);
				try {
					fs.unlinkSync(lock);
				} catch {
					// A lock left behind here is taken over by the next promotion once it is stale (`takeLock`).
					// Logged, never thrown: the promotion itself succeeded.
					log("session_lock_stuck", { key: session.key });
				}
			}
			log("session_promoted", { key: session.key, bytes: check.bytes });
			return { promoted: true, reason: "promoted", bytes: check.bytes };
		} catch (err) {
			log("session_store_failed", { phase: "promote", reason: err?.message });
			return { promoted: false, reason: "promote-failed" };
		}
	}

	/**
	 * The counter's next value. `session.resume` is the HOST's own decision to hand this key's transcript
	 * to a container, which is the only half of the exchange the container cannot influence; `resumed` (the
	 * container's verdict) is deliberately ignored for the counter and kept in the signature only because
	 * the record's own merge still wants it. A cold start resets, so a lineage always gets a fresh start
	 * from its next COMPLETED run -- a run that never completes promotes nothing and resets nothing, which
	 * is the safe direction: the key simply keeps cold-starting.
	 */
	function chainValue(session) {
		return String(session.resume === true ? readResumeChain(session.key) + 1 : 0);
	}

	/**
	 * One sidecar write. Two properties, both deliberate.
	 *
	 * **It cannot write THROUGH a link.** `writeFileSync` follows one, which would turn a planted symlink
	 * in a key directory into a truncating write of any worker-writable file, with the container's own
	 * integers as the payload. Writing a temp and renaming over the name replaces whatever is there --
	 * link included -- with a regular file, and never opens the link's target. The temp is unlinked first
	 * for the same reason, since a planted link at THAT name would be the same hole one step along. The
	 * read side's `lstat` guard is the other half of this; neither is sufficient alone.
	 *
	 * **It is never fatal.** This runs AFTER the transcript is already promoted, so throwing would return
	 * `promote-failed` for a promotion that demonstrably happened, telling an operator the next run will
	 * cold start when it will in fact resume. The bookkeeping loss is logged and the truth is kept.
	 */
	function writeSidecar(dir, name, key, value) {
		try {
			replaceSidecar(dir, name, value);
		} catch (err) {
			log("session_sidecar_failed", { key, file: name, reason: err?.message });
		}
	}

	/**
	 * `writeSidecar`'s link-safe temp-and-rename, and it THROWS. For the one write whose failure must stop a
	 * promotion rather than be logged past it: the venue sentinel, which runs before the swap (#277).
	 */
	/**
	 * Remove whatever is at a temp path, whatever SHAPE it has, before anything writes there.
	 *
	 * ONE RULE BECAUSE CHOOSING BETWEEN THE TWO CALLS WAS GOT WRONG TWICE, in opposite directions.
	 * `unlinkSync` alone cannot remove a DIRECTORY planted at the name, and at the venue sentinel -- the one
	 * sidecar write that is fatal -- that wedged every promotion on the key forever. `rmSync` alone does not
	 * remove a DANGLING SYMLINK: it resolves the path, finds nothing, and with `force` reports success while
	 * leaving the link (measured, and it is the same measurement the reaper's own guard records three
	 * functions down). The next write then follows the surviving link and creates a file at its target, which
	 * is the write-through-a-link hole this whole series exists to close, and if that target is unreachable
	 * the write throws and the key is wedged again.
	 *
	 * So: `unlinkSync` first, which takes a file or a link INCLUDING a dangling one; then `rmSync` for the
	 * one shape it cannot take. A directory is removed with its subtree, which is bounded to a temp name
	 * inside the key directory and is the point rather than a side effect: nothing may be left at that name.
	 */
	function removeTemp(path) {
		try {
			fs.unlinkSync(path);
			return;
		} catch (err) {
			if (err?.code === "ENOENT") return; // absent is the desired state
		}
		try {
			fs.rmSync(path, { recursive: true, force: true });
		} catch {
			// Nothing further to try. The write that follows fails and is reported as itself.
		}
	}

	function replaceSidecar(dir, name, value) {
		const file = join(dir, name);
		const tmp = `${file}.incoming`;
		removeTemp(tmp);
		fs.writeFileSync(tmp, value);
		fs.renameSync(tmp, file);
	}

	/**
	 * The context sidecar, whose three cases are all different.
	 *
	 * A run that RESUMED and measured nothing keeps the previous reading: the transcript it promoted is
	 * the old one extended, so the last real measurement is the closest true statement available, and a
	 * zero would read as "the context emptied", which cannot have happened.
	 *
	 * A COLD START, though, promoted a transcript that shares nothing with the one the old reading
	 * described, so the reading must GO. Keeping it is what turned a single high measurement into a key
	 * that refused itself forever: the gate read a stale number, cold-started, and the cold start left the
	 * same number behind for the next run to read. That loop had no exit that did not involve deleting the
	 * store by hand.
	 */
	function writeContextSidecar(dir, session, context) {
		const file = join(dir, CONTEXT_FILE);
		if (session.resume !== true) {
			try {
				fs.unlinkSync(file);
			} catch {
				// Absent is the desired state, so failing to remove what is not there is success.
			}
			return;
		}
		if (!context) return;
		// The model rides along because the ratio is meaningless without it: a key is (kind, repo, ref) and
		// carries no model, so two triggers on one issue can run different ones, and 25k tokens is 78% of a
		// 32k window and 2.5% of a 1M one. A reading from another model is not a reading about this one.
		const stamp = session.modelId ? ` ${session.modelId}` : "";
		writeSidecar(dir, CONTEXT_FILE, session.key, `${context.tokens} ${context.window}${stamp}`);
	}

	function keyDir(key) {
		return join(sessionsDir, key);
	}
	function canonicalFile(key) {
		return join(keyDir(key), SESSION_FILE_NAME);
	}

	/** The read path, gate by gate. The FIRST miss wins and names itself. */
	function readCanonical(key, piVersion, modelId, venue) {
		const file = canonicalFile(key);
		const check = inspectFile(file);
		if (!check.ok) return COLD(check.reason);

		if (ttlDays > 0 && now() - check.mtimeMs > ttlDays * 86400000) return COLD("expired");

		// The VENUE the transcript was written in (#277). Placed HERE, after the arms a venue move cannot cause
		// -- a transcript that is absent, not a regular file, too large or past its TTL is all of those on every
		// venue -- and AHEAD of both pi-version arms, because a venue move CAN cause those: image preflight is
		// dispatched per venue, so another venue can report another pi or none. The first miss names itself,
		// and before this arm a venue move named itself as a version change. Without it, a trigger moved
		// between venues staged the old venue's transcript into the new venue's container with nothing refusing.
		//
		// FAILS CLOSED: a job whose venue cannot be resolved (a DI seam) never resumes, the pi-version gate's
		// polarity. The token also covers a stamp left pending by an interrupted promotion and a stamp that is
		// present but unreadable -- a misnaming stated rather than hidden, as `pi-version-changed` already does
		// for an unreadable version stamp.
		if (venue === null || readVenue(key) !== venue) return COLD("venue-changed");

		// A transcript outlives the pi that wrote it, and pi's own docs record what then breaks: an older
		// session's stored tool-call arguments may no longer match the current tool schema. We cannot
		// repair that mid-run, so a version change is a cold start rather than a mid-run failure. An
		// image that declares no version never resumes -- the safe direction, never "assume it matches".
		if (piVersion === null) return COLD("pi-version-changed");
		// Through the same guarded read as the other sidecars. This one predates them and was the
		// one unguarded read left in the key directory; a symlink here would have decided a gate on the
		// contents of some other file entirely.
		const stamped = readSidecar(key, PI_VERSION_FILE);
		if (stamped === null || stamped !== piVersion) return COLD("pi-version-changed");

		// How many times in a row this key has already been resumed. Placed HERE, ahead of the header read,
		// for two reasons. It is a small sidecar read exactly like the pi-version arm above it, so refusing
		// on it skips pulling a transcript that may be megabytes; and unlike every other arm it asks about
		// the LINEAGE rather than the file, so it needs nothing the file could tell it.
		//
		// The cost of that placement, stated rather than left to be discovered: a transcript that is both
		// chain-exhausted AND corrupt reports the chain. That is the intentional refusal of the two, and the
		// corruption is not hidden, only deferred -- this cold start's own promotion resets the counter, so
		// the very next run reads the file and reports `unparseable`.
		//
		// FAILS OPEN on absence, which is the opposite of the age gate one arm down and deliberate. Every
		// key that existed before this counter did has no file, and reading that as "already exhausted"
		// would cold-start an operator's entire store the day they set the bound.
		if (maxResumeChain > 0 && readResumeChain(key) >= maxResumeChain) return COLD("resume-chain-too-long");

		// How full the context already is, against a ceiling the HOST owns. Not a duplicate of pi's own
		// compaction threshold and deliberately not read from it: pi's is settable in a serviced repo's
		// .pi/settings.json, so it is a line the repository can move, and this one cannot be. Past that
		// threshold what a resumed job replays is not the transcript but a model-written summary of it,
		// produced while that model was reading attacker-authored text (OQ-003), so this is a safety bound
		// before it is an economic one.
		//
		// FAILS OPEN and INVENTS NO DENOMINATOR. No sidecar (every key promoted before this shipped, and
		// every key under an image whose runner predates it), a compaction that left pi's own count
		// unknown, or a window of zero all mean the gate has nothing to act on, and a gate with nothing to
		// act on passes. A bytes-against-window guess was rejected rather than used as a fallback: the
		// transcript is the whole branch INCLUDING what compaction folded away, so it over-reads exactly
		// past the threshold this exists to catch, and there is no bytes-to-tokens calibration here to
		// make it mean anything.
		if (maxContextPct !== null) {
			const seen = readContext(key);
			// A reading STAMPED WITH ANOTHER MODEL is not a reading about this one, and using it is wrong in
			// both directions: it refuses a job whose window is far larger than the one that was measured,
			// and it passes one whose window is far smaller. Unknown on either side stays usable, so a
			// deployment that names no model per trigger keeps the bound it had.
			const foreign = seen !== null && seen.modelId !== null && modelId !== null && seen.modelId !== modelId;
			if (seen !== null && !foreign && (seen.tokens * 100) / seen.window >= maxContextPct) return COLD("context-too-full");
		}

		// Cheapest real shape check, and the last one before the header's own contents are used: the first
		// line must be a pi session header. Anything else the runner would throw on, so refusing here keeps
		// the container's degrade path for genuine surprises rather than for a file we could already tell
		// was wrong.
		let header = null;
		try {
			const head = String(fs.readFileSync(file, "utf8")).split("\n", 1)[0];
			header = JSON.parse(head);
			if (header?.type !== "session") return COLD("unparseable");
		} catch {
			return COLD("unparseable");
		}

		// The CONVERSATION's age, and it is a DIFFERENT CLOCK from `expired` above rather than a finer
		// setting of it. The TTL reads the transcript's mtime, which the PROMOTE rename refreshes -- and only
		// that: `copyFileSync` stamps its destination, never its source, so the resolve half leaves the
		// canonical file's mtime alone (measured, because the obvious reading of the two call sites says
		// otherwise). So `expired` is time since the last COMPLETED run on this key, and a lineage whose runs
		// keep completing never expires however old its first turn is. pi's header carries the instant the
		// session was created, so this
		// costs no new persisted state -- the line is already read and parsed one gate up, and until now
		// only its `type` was looked at.
		//
		// The arm is LAST because the earlier gates are cheaper and because a corrupt file is corrupt rather
		// than old: `unparseable` must keep winning over this, or a damaged transcript would be reported as
		// a lineage that aged out.
		//
		// UNREADABLE FAILS CLOSED, on the pi-version gate's precedent one arm up: a header with no usable
		// timestamp cannot be shown to be young enough, and "assume it matches" is the direction that
		// silently keeps resuming. Like `pi-version-changed`, one token covers all three causes (absent,
		// wrong type, unparseable).
		//
		// A timestamp in the FUTURE passes, deliberately. It buys nothing to refuse one: the agent owns
		// /session, so anything able to write a future timestamp is equally able to write the current one,
		// and refusing would convert ordinary clock skew between a container and its host into a cold start
		// for every key on the deployment.
		if (maxAgeDays > 0) {
			const started = Date.parse(typeof header.timestamp === "string" ? header.timestamp : "");
			if (!Number.isFinite(started)) return COLD("conversation-too-old");
			if (now() - started > maxAgeDays * 86400000) return COLD("conversation-too-old");
		}
		return { resume: true, reason: "resumed", bytes: check.bytes, ident: check.ident };
	}

	/**
	 * Every sidecar read goes through here, and it is the same load-bearing check `inspectFile` makes on
	 * the transcript: **`lstat`, regular files only.** The canonical store is host-only and never mounted,
	 * so nothing in a container can plant a link here -- but the directory NAME is derived rather than
	 * random (`sha256(kind, repo, ref)`), so anyone who knows the repository and the branch can compute it
	 * and pre-create the path. `readFileSync` and `writeFileSync` both follow links, which would turn a
	 * planted symlink into a read of any worker-readable file on the gate's path, and a promotion into a
	 * truncating write of any worker-writable one. The transcript has been guarded against exactly this
	 * since the feature shipped; these files inherit it rather than being the exception.
	 *
	 * SIZE-BOUNDED for the same reason the transcript is. Both formats are a handful of bytes, `maxBytes`
	 * does not cover them, and reading a 2.5 GiB file on the job's own path costs half a minute of wall
	 * clock before any container starts.
	 */
	function readSidecar(key, name) {
		try {
			const file = join(keyDir(key), name);
			const st = fs.lstatSync(file);
			if (!st.isFile() || st.size === 0 || st.size > SIDECAR_MAX_BYTES) return null;
			return String(fs.readFileSync(file, "utf8")).trim();
		} catch {
			return null;
		}
	}

	/**
	 * The venue stamped beside a key's transcript (#277).
	 *
	 * ABSENT and UNREADABLE are different answers, and conflating them either way is a defect. An absent stamp
	 * is a transcript from before venues were recorded, which ran on `local`. A stamp that exists but cannot
	 * be read -- not a regular file, empty, oversized, unreadable -- matches nothing (`null`), so the key
	 * cold-starts. Absence is decided by `lstat` and ENOENT ALONE: `stat` or `existsSync` would follow a
	 * DANGLING symlink planted at this name, report it absent, and resume a transcript as `local` on the
	 * strength of a link that points nowhere. Any other `lstat` failure is not absence either.
	 */
	function readVenue(key) {
		try {
			fs.lstatSync(join(keyDir(key), VENUE_FILE));
		} catch (err) {
			return err?.code === "ENOENT" ? UNATTRIBUTED_BACKEND : null;
		}
		return readSidecar(key, VENUE_FILE);
	}

	/**
	 * The consecutive-delivery counter for a key, or 0 when there is not a readable one. Never throws and
	 * never guesses: a missing, empty, corrupt or negative counter is 0, so the only way to be refused by
	 * the chain bound is for this store to have written a number that reaches it.
	 */
	function readResumeChain(key) {
		const raw = readSidecar(key, RESUME_CHAIN_FILE);
		if (raw === null) return 0;
		const n = Number.parseInt(raw, 10);
		// `String(n) === raw` is the same anti-truncation guard config.mjs applies to every integer knob,
		// and it is what keeps a corrupt "3.5" from being read as a chain of three.
		return Number.isInteger(n) && n > 0 && String(n) === raw ? n : 0;
	}

	/**
	 * The stored context occupancy for a key, or `null` when there is no measurement. Never throws, never
	 * guesses, and never returns a partial: anything it cannot read as two positive integers is no
	 * measurement at all, which the caller treats as "pass" rather than as zero.
	 */
	function readContext(key) {
		const raw = readSidecar(key, CONTEXT_FILE);
		if (raw === null) return null;
		const [rawTokens, rawWindow, rawModel] = raw.split(/\s+/);
		const tokens = Number.parseInt(rawTokens, 10);
		const window = Number.parseInt(rawWindow, 10);
		if (!Number.isInteger(tokens) || !Number.isInteger(window) || tokens < 0 || window <= 0) return null;
		if (String(tokens) !== rawTokens || String(window) !== rawWindow) return null;
		return { tokens, window, modelId: rawModel ?? null };
	}

	/**
	 * lstat, REGULAR FILES ONLY -- and this is the one line in the file that is load-bearing security
	 * rather than hygiene.
	 *
	 * The agent owns /session. A symlink it plants there resolves on the HOST when we read it back, so a
	 * plain `stat` + `readFileSync` would hand the next job on this key the contents of any file the
	 * worker user can read. INT-CONTAINER-JOB-INPUTS already documents this attack in the other direction
	 * (`fs.readFile` off the clone following a symlink into a worker-host file). The repo's own habit is
	 * the wrong one here: makeLogReaper uses statSync, which follows.
	 */
	/**
	 * The canonical file's IDENTITY as one comparable token: device, inode, size, mtime.
	 *
	 * ONE STRING RATHER THAN FOUR FIELDS, so the comparison is one `!==` and there is no partial compare to
	 * get wrong. `ino` is the field that does the work: a promotion renames a freshly created `.incoming`
	 * file into place, so the inode behind the canonical path is a DIFFERENT one after every completed swap
	 * -- including the A, B, A round trip whose venue stamp matches again, which is why this catches what the
	 * venue re-check cannot. `dev` is what makes `ino` meaningful, since an inode number is unique per
	 * device. `size` and `mtimeMs` narrow the inode-REUSE residual and nothing else: the swapped-away inode
	 * is freed by its own rename and its number may be handed straight back to the next `.incoming` file.
	 */
	function identityOf(st) {
		return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
	}

	/**
	 * The identity now at a path, or `null` when there is nothing readable there -- which compares unequal to
	 * every real identity, so a transcript that VANISHED between the gate and the copy cold-starts too.
	 */
	function readIdentity(file) {
		try {
			return identityOf(fs.lstatSync(file));
		} catch {
			return null;
		}
	}

	function inspectFile(file) {
		let st;
		try {
			st = fs.lstatSync(file);
		} catch {
			return { ok: false, reason: "absent" };
		}
		if (!st.isFile()) return { ok: false, reason: "not-a-regular-file" };
		if (st.size === 0) return { ok: false, reason: "absent" }; // a staged-but-unwritten transcript
		if (maxBytes > 0 && st.size > maxBytes) return { ok: false, reason: "too-large" };
		return { ok: true, bytes: st.size, mtimeMs: st.mtimeMs, ident: identityOf(st) };
	}

	/**
	 * The DISK sweep: at boot, and on the retention timer thereafter (`PI_SWEEP_INTERVAL_HOURS`, issue
	 * #292). A SIBLING of makeLogReaper rather than a widening of it: that one's `.log`/`.json` filter and
	 * logsDir scope are a documented contract, and these files have a different retention policy and a
	 * different PII class. Same never-throws shape, same `0 = keep forever` sentinel, and safe to re-run --
	 * it carries no state between calls.
	 *
	 * Age on disk is the smaller half. The gate that matters is the one in readCanonical, which runs at
	 * OPEN, because a stale transcript is a live INPUT to a future job rather than debris. Until #292 that
	 * gate was also carrying the disk half alone, since a worker that never restarts never re-swept
	 * (OQ-007, RESOLVED).
	 */
	function reapSessions() {
		if (!sessionsDir || ttlDays === 0) return;
		const cutoff = now() - ttlDays * 86400000;
		let names;
		try {
			names = fs.readdirSync(sessionsDir);
		} catch (err) {
			log("session_reaper_skipped", { reason: err?.message });
			return;
		}
		for (const name of names) {
			try {
				const dir = join(sessionsDir, name);
				let mtimeMs;
				try {
					mtimeMs = fs.lstatSync(join(dir, SESSION_FILE_NAME)).mtimeMs;
				} catch (err) {
					// ENOENT ALONE falls back to the DIRECTORY's own mtime (issue #336). A key whose first promotion
					// died before any transcript landed has none to key on, so this loop used to log-and-skip it on
					// every pass forever, and anything leaked inside it -- a lock, an in-flight copy -- outlived the
					// store. A directory's mtime moves on every entry created or removed inside it, so a live key is
					// refreshed by its own promotions and a dead one is stamped at whatever last touched it.
					//
					// ENOENT-ONLY rather than unconditional, and that is the whole safety of it: an EIO or an EACCES
					// on the transcript is a disk fault, and a disk fault is not evidence that a key is old. Those
					// keep today's log-and-skip.
					if (err?.code !== "ENOENT") throw err;
					const dst = fs.lstatSync(dir);
					// ONLY A REAL DIRECTORY IS A KEY ON THIS PATH, and the scope of that is narrow enough to be worth
					// stating. A stray FILE in the store gives ENOTDIR on the inner lstat, so it never reaches here.
					// A symlink reaches here only when its target has no readable transcript: one pointing at a
					// directory that DOES hold one resolves through the link in the path prefix, so the transcript's
					// own mtime decides and the LINK is removed if it has aged out. That is pre-existing and
					// unchanged, and it is safe for the reason below rather than because of this guard.
					//
					// What this guard is and is not, measured rather than assumed, because the obvious reading is
					// wrong: `rmSync(p, { recursive: true, force: true })` does NOT follow a symlink. On a link to a
					// real directory it removes the LINK and leaves the target and its contents untouched, and on a
					// dangling link it silently does nothing at all. So a link's TARGET was never at risk here and
					// this guard is not what protects it. What it does is narrower and still worth having: without
					// it the reaper would unlink an operator's own symlink out of the store once the LINK's own
					// mtime aged out, and a reaper that sweeps things that are not keys is a reaper an operator
					// cannot leave anything beside.
					if (!dst.isDirectory()) continue;
					mtimeMs = dst.mtimeMs;
				}
				if (mtimeMs < cutoff) {
					// ONE recursive remove, on the transcript's age where there is one and the directory's own where
					// there is not (above). Removing the
					// transcript first (so an absent stamp, which reads as `local`, can never sit beside a readable
					// transcript mid-sweep) was tried under #277 and withdrawn: a remove that then failed transiently
					// left the directory with no transcript, which this loop never looks at again, so a leaked lock
					// in it wedged the key for good. The race it closed needs a promotion landing on an EXPIRED key
					// during its own sweep on a deployment with a second venue; INT-SESSION-STORE-CONTRACT names it.
					fs.rmSync(dir, { recursive: true, force: true });
					log("reaped_session", { key: name });
				}
			} catch (err) {
				log("session_reaper_skipped", { key: name, reason: err?.message });
			}
		}
	}

	return { resolveSession, promoteSession, reapSessions };
}
