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
import { join } from "node:path";
import { sessionKeyFor } from "./session-key.mjs";

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
/** Both sidecar formats are a handful of bytes. Generous, and still nowhere near a job's wall clock. */
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
			const hostDir = join(jobDir, "session");
			const staged = join(hostDir, SESSION_FILE_NAME);
			fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });

			const verdict = readCanonical(key, piVersion, modelId);
			if (verdict.resume) {
				fs.copyFileSync(canonicalFile(key), staged);
			} else {
				// A 0-BYTE FILE, not an absent one. pi's setSessionFile then takes its empty-file branch and
				// writes its own header at this exact path, which marks the manager flushed -- so _persist
				// never reaches its openSync(path, "wx"), and the EEXIST race stops being a race. The host
				// never has to know pi's file format to get that.
				fs.writeFileSync(staged, "");
			}
			log("session_resolved", { key, resume: verdict.resume, reason: verdict.reason });
			return { hostDir, key, modelId, ...verdict };
		} catch (err) {
			// A history fault must never fail the prepare that asked.
			log("session_store_failed", { phase: "resolve", reason: err?.message });
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
			let fd;
			try {
				fd = fs.openSync(lock, "wx"); // exclusive create IS the lock; no daemon, no lease
			} catch (err) {
				// EEXIST is the only failure that MEANS locked. A read-only directory, a full disk or a
				// vanished store all failed to create the lock too, and reporting those as `locked` sends an
				// operator looking for a stuck lock file that does not exist. Anything else falls through to
				// the outer catch and reports `promote-failed`, which is what actually happened.
				if (err?.code !== "EEXIST") throw err;
				log("session_promote_skipped", { key: session.key, reason: "locked" });
				return { promoted: false, reason: "locked" };
			}
			try {
				// Atomic swap: a reader either sees the old file or the new one, never a half-written one.
				const tmp = `${canonicalFile(session.key)}.incoming`;
				try {
					// `copyFileSync` follows a link at the DESTINATION, so a link planted at this name would
					// receive the whole transcript and leave the canonical path pointing at it. The key
					// directory's name is derived rather than random, so the path is precomputable by anyone
					// who knows the repository and the branch; unlinking removes the link, never its target.
					fs.unlinkSync(tmp);
				} catch {
					// Absent is the desired state.
				}
				fs.copyFileSync(staged, tmp);
				fs.renameSync(tmp, canonicalFile(session.key));
				fs.writeFileSync(join(dir, PI_VERSION_FILE), String(piVersion ?? ""));
				// The two sidecars, immediately after the swap and under the same lock. NOT part of the swap
				// itself, which is one rename and cannot be widened: what the lock buys them is that no
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
					// A leaked lock file wedges this key until the reaper sweeps it. Logged, never thrown.
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
		const file = join(dir, name);
		const tmp = `${file}.incoming`;
		try {
			try {
				fs.unlinkSync(tmp);
			} catch {
				// Absent is the desired state.
			}
			fs.writeFileSync(tmp, value);
			fs.renameSync(tmp, file);
		} catch (err) {
			log("session_sidecar_failed", { key, file: name, reason: err?.message });
		}
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
	function readCanonical(key, piVersion, modelId) {
		const file = canonicalFile(key);
		const check = inspectFile(file);
		if (!check.ok) return COLD(check.reason);

		if (ttlDays > 0 && now() - check.mtimeMs > ttlDays * 86400000) return COLD("expired");

		// A transcript outlives the pi that wrote it, and pi's own docs record what then breaks: an older
		// session's stored tool-call arguments may no longer match the current tool schema. We cannot
		// repair that mid-run, so a version change is a cold start rather than a mid-run failure. An
		// image that declares no version never resumes -- the safe direction, never "assume it matches".
		if (piVersion === null) return COLD("pi-version-changed");
		// Through the same guarded read as the two sidecars below it. This one predates them and was the
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
		return { resume: true, reason: "resumed", bytes: check.bytes };
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
		return { ok: true, bytes: st.size, mtimeMs: st.mtimeMs };
	}

	/**
	 * Boot-time sweep. A SIBLING of makeLogReaper rather than a widening of it: that one's `.log`/`.json`
	 * filter and logsDir scope are a documented contract, and these files have a different retention
	 * policy and a different PII class. Same never-throws shape, same `0 = keep forever` sentinel.
	 *
	 * Age at boot is the smaller half. The gate that matters is the one in readCanonical, which runs at
	 * OPEN -- a worker that never restarts would otherwise keep resuming a transcript indefinitely, and a
	 * stale transcript is a live input to a future job rather than debris (OQ-007).
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
				const st = fs.lstatSync(join(dir, SESSION_FILE_NAME));
				if (st.mtimeMs < cutoff) {
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
