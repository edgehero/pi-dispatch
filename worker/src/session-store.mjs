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
 * How many times in a row this key has been resumed. A counter rather than a derivation, because there
 * is nothing to derive it from: the run record deliberately carries no session key
 * (DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED), so counting past runs would need the key->record index that
 * entry refuses. One integer beside the transcript it describes is not that index; it is keyed state
 * written where the key already is, and it answers exactly one question rather than being a query
 * surface. Maintained even when no bound is set, deliberately -- see the write in promoteSession.
 */
const RESUME_CHAIN_FILE = "resume-chain";

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

			const hostDir = join(jobDir, "session");
			const staged = join(hostDir, SESSION_FILE_NAME);
			fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });

			const verdict = readCanonical(key, piVersion);
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
			return { hostDir, key, ...verdict };
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
	function promoteSession(session, { piVersion = null, resumed = null } = {}) {
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
			} catch {
				log("session_promote_skipped", { key: session.key, reason: "locked" });
				return { promoted: false, reason: "locked" };
			}
			try {
				// Atomic swap: a reader either sees the old file or the new one, never a half-written one.
				const tmp = `${canonicalFile(session.key)}.incoming`;
				fs.copyFileSync(staged, tmp);
				fs.renameSync(tmp, canonicalFile(session.key));
				fs.writeFileSync(join(dir, PI_VERSION_FILE), String(piVersion ?? ""));
				// Under the same lock and in the same swap, so the counter can never describe a transcript
				// other than the one beside it.
				//
				// WHOSE VERDICT COUNTS: the container's. `session.resume` is what the host intended; whether
				// the lineage actually got another turn is what pi observed, and a staged transcript pi
				// declined to continue did not extend anything. The host's intent is the fallback for a
				// container that gave no verdict, which is the same precedence mergeSession applies.
				//
				// WRITTEN EVEN WITH NO BOUND SET, deliberately. A counter that only starts when the knob
				// does is a bound that does nothing for its first N runs: an operator who sets 3 because a
				// lineage is already forty deep would get no refusal at all, which is the believed-on-while-
				// off failure this project keeps arriving at from new directions.
				const continued = typeof resumed === "boolean" ? resumed : session.resume === true;
				fs.writeFileSync(join(dir, RESUME_CHAIN_FILE), String(continued ? readResumeChain(session.key) + 1 : 0));
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

	function keyDir(key) {
		return join(sessionsDir, key);
	}
	function canonicalFile(key) {
		return join(keyDir(key), SESSION_FILE_NAME);
	}

	/** The read path, gate by gate. The FIRST miss wins and names itself. */
	function readCanonical(key, piVersion) {
		const file = canonicalFile(key);
		const check = inspectFile(file);
		if (!check.ok) return COLD(check.reason);

		if (ttlDays > 0 && now() - check.mtimeMs > ttlDays * 86400000) return COLD("expired");

		// A transcript outlives the pi that wrote it, and pi's own docs record what then breaks: an older
		// session's stored tool-call arguments may no longer match the current tool schema. We cannot
		// repair that mid-run, so a version change is a cold start rather than a mid-run failure. An
		// image that declares no version never resumes -- the safe direction, never "assume it matches".
		if (piVersion === null) return COLD("pi-version-changed");
		let stamped = null;
		try {
			stamped = String(fs.readFileSync(join(keyDir(key), PI_VERSION_FILE), "utf8")).trim();
		} catch {
			return COLD("pi-version-changed");
		}
		if (stamped !== piVersion) return COLD("pi-version-changed");

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
		// setting of it. The TTL reads mtime, which both the resolve copy and the promote rename refresh, so
		// it measures time since the last completed run on this key: a lineage touched daily never expires
		// however old its first turn is. pi's header carries the instant the session was created, so this
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
	 * The consecutive-resume counter for a key, or 0 when there is not a readable one. Never throws and
	 * never guesses: a missing, empty, corrupt or negative counter is 0, so the only way to be refused by
	 * the chain bound is for this store to have written a number that reaches it.
	 */
	function readResumeChain(key) {
		try {
			const raw = String(fs.readFileSync(join(keyDir(key), RESUME_CHAIN_FILE), "utf8")).trim();
			const n = Number.parseInt(raw, 10);
			// `String(n) === raw` is the same anti-truncation guard config.mjs applies to every integer knob,
			// and it is what keeps a corrupt "3.5" from being read as a chain of three.
			return Number.isInteger(n) && n > 0 && String(n) === raw ? n : 0;
		} catch {
			return 0;
		}
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
