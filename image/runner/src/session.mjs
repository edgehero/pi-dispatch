import { renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Build the SessionManager the job's agent runs on (REQ-RESUMABLE-SESSION, INT-SESSION-STORE-CONTRACT).
 *
 * Absent PI_SESSION_FILE this is `SessionManager.inMemory(cwd)` -- pi's own ephemeral mode, the same
 * call the runner has always made, byte for byte. Everything below concerns the opt-in path only.
 *
 * SYNCHRONOUS AND TOTAL, and both properties are load-bearing:
 *
 * - Total, because run-job.mjs reads `getSessionId()` off the result IMMEDIATELY and hands it to
 *   createUsageMeter as the root session id. That hoist is deliberate (see the comment at the call
 *   site) and the meter cannot attribute anything without it. A path through here that returned
 *   undefined would not fail loudly; it would file every provider call as unattributed and hide the
 *   fanout the meter exists to see.
 * - Synchronous, because it sits between two synchronous preflight steps and adding an await here
 *   would reorder the meter install relative to createAgentSession.
 *
 * Resume itself is not an option we pass. `CreateAgentSessionOptions` has no `resume`, no `sessionId`
 * and no `continueSession` at the 0.99.1 pin (as at 0.80.7; pinned-api.test.mjs holds the whole option
 * set) -- the JSDoc example in sdk.d.ts showing `continueSession: true` is still wrong for this version. Handing createAgentSession a persisted manager IS
 * the documented mechanism (pi's own docs/sdk.md, "Open specific file"); it then restores
 * `agent.state.messages` itself. pi's interactive /resume is a different thing entirely --
 * AgentSessionRuntime.switchSession, which replaces the ACTIVE session mid-process. We prompt once and
 * exit, so there is no active session to replace.
 *
 * All three arguments to `open` are explicit. `sessionDir` would be derived from the file's parent
 * anyway; we pass it because this repo pins upstream defaults rather than inheriting them. The
 * `cwdOverride` is the one that changes behaviour: it forces `/workspace` regardless of what the
 * stored header claims, so a transcript carrying a foreign host's cwd cannot bring it along.
 */
export function openSessionManager({ sessionFile, cwd, log = () => {}, Manager = SessionManager, now = () => Date.now() }) {
	if (!sessionFile) return { sessionManager: Manager.inMemory(cwd), resumed: false, reason: "disabled" };

	try {
		const sessionManager = Manager.open(sessionFile, dirname(sessionFile), cwd);
		// The predicate createAgentSession will itself use (sdk.js: `buildSessionContext().messages.length
		// > 0`), so what we report is what pi will do rather than what the host hoped it would do.
		const resumed = sessionManager.buildSessionContext().messages.length > 0;
		return { sessionManager, resumed, reason: resumed ? "resumed" : "absent" };
	} catch (err) {
		// DELIBERATELY NARROW IN REACH, NOT IN CATCH -- read this before widening it.
		//
		// This is reachable ONLY after assertSessionMountReady has already proven the file exists and its
		// directory is writable. That ordering is what makes swallowing safe: the sole remaining cause is
		// the file's CONTENT, and pi throws exactly one such error -- setSessionFile rejects a non-empty
		// file that does not parse as a pi session ("Session file is not a valid pi session"). A corrupt
		// transcript is not a reason to refuse to do the work.
		//
		// Never extend this to cover an absent or read-only mount. Those are config faults that must stay
		// exit 2, and folding them in here would turn a dead mount into a fleet that is green on every job
		// and has silently stopped resuming -- the failure this file's whole design is arranged against.
		//
		// Without the catch the throw would classify as exit 1 = RETRYABLE, so four bad bytes written by
		// an agent that owns this mount would burn every retry and repeat on every later job for the same
		// key. Deterministic faults do not belong in the retry path (CONST-RETRY-INFRA-ONLY).
		const quarantined = `${sessionFile}.invalid-${now()}`;
		try {
			// Move it aside rather than delete it: the operator may want to look, and the reaper sweeps
			// `.invalid-*` on its own schedule. Re-stage an empty file so pi writes a fresh header at the
			// path the mount already points at, exactly as a cold start does.
			renameSync(sessionFile, quarantined);
			writeFileSync(sessionFile, "");
		} catch (quarantineErr) {
			// Even the quarantine failing is not worth the job: fall through to a fresh in-memory session.
			// The run still happens, and the reason says which of the two degradations occurred.
			log("session_resume_degraded", { reason: "quarantine-failed", detail: quarantineErr?.message });
			return { sessionManager: Manager.inMemory(cwd), resumed: false, reason: "unparseable" };
		}
		log("session_resume_degraded", { reason: "unparseable", detail: err?.message });
		return { sessionManager: Manager.open(sessionFile, dirname(sessionFile), cwd), resumed: false, reason: "unparseable" };
	}
}
