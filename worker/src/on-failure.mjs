/**
 * Running the operator's failure hook (issue #288, `PI_ON_FAILURE`).
 *
 * `wait-check.mjs`, reduced further -- that file is itself the resolver reduced, and every difference
 * here is another subtraction with the reason stated:
 *
 *   - **ALL THREE stdio streams are ignored, not counted.** A check's byte counts feed a log line an
 *     operator debugs a verdict with; a notification hook has no verdict, and nothing anywhere is
 *     entitled to read its output. With no pipes at all, the backgrounded-grandchild EOF hazard that
 *     forced `exit`-not-`close` next door cannot even arise (the listener is still `exit`, because it
 *     is the right event regardless).
 *   - **No verdict, no fault count, no profile table.** The hook changes NOTHING about the job: it runs
 *     after the outcome is decided, fire and forget, and a hook fault must never flip a result
 *     (CONST-RETRY-INFRA-ONLY). Its exit code is logged and unread -- OQ-027's residual, inherited.
 *   - **The reason is shape-guarded HERE, the single normalizing door.** `InfraRetry.reason` defaults to
 *     the whole message when no token was given, and messages carry things like a library's own words --
 *     so anything that does not look like a fixed token (`/^[a-z0-9-]{1,40}$/`) flattens to "infra"
 *     before it can become an argv element. Id-only argv is the contract
 *     (`INT-ON-FAILURE-HOOK-CONTRACT`), and one guard at the spawn is worth ten at the call sites.
 *
 * What transfers unchanged: the executable resolved at CALL time (an operator who fixes the path
 * mid-day must not stay broken), `spawn` with an argv ARRAY and `shell: false`, the leading-dash argv
 * refusal, SIGTERM then SIGKILL after a grace, a per-invocation timeout with every timer unref'd, and
 * NEVER throwing -- even the log sink is called inside guards.
 */

import { realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";

/** SIGTERM, then SIGKILL after this. secrets.mjs's grace, for its reason. */
const KILL_GRACE_MS = 2000;

/** A reason that may ride argv: a fixed lowercase token, never a message. */
const REASON_SHAPE = /^[a-z0-9-]{1,40}$/;

/**
 * Build the hook runner. Returns `fire({ jobId, outcome, reason })` -> void: spawns the operator's
 * command as `cmd <jobId> <outcome> <reason> <host>`, logs one `on_failure` line with the pinned key
 * set { jobId, code, detail }, and never throws, rejects, or delays anything.
 */
export function makeOnFailure({ command, timeoutMs = 10_000, spawnFn = spawn, realExecutablePath = defaultRealExecutablePath, hostEnv = process.env, host = "", log = () => {} }) {
	const note = (jobId, code, detail) => {
		try {
			log("on_failure", { jobId, code, detail });
		} catch {
			// an injected sink that throws must not break the fire-and-forget contract
		}
	};

	return function fire({ jobId, outcome, reason }) {
		// Resolved at CALL time, not construction (wait-check's rule): realpath + the executable bit,
		// answering the same question spawn will.
		let path;
		try {
			path = realExecutablePath(command);
		} catch {
			path = null;
		}
		if (!path) return note(jobId, null, "unresolvable");

		const safeReason = typeof reason === "string" && REASON_SHAPE.test(reason) ? reason : "infra";
		// Argv must be non-empty id-only strings, and none may start with a dash -- this is argv where a
		// dash parses as a flag, and the option parser is the operator's. `host` may honestly be "".
		const argv = [jobId, outcome, safeReason, host];
		if (argv.slice(0, 3).some((a) => typeof a !== "string" || a === "") || argv.some((a) => typeof a === "string" && a.startsWith("-"))) {
			return note(typeof jobId === "string" ? jobId : null, null, "argv-unusable");
		}

		let child;
		try {
			child = spawnFn(path, argv, {
				stdio: ["ignore", "ignore", "ignore"],
				env: hostEnv,
				shell: false,
			});
		} catch {
			return note(jobId, null, "spawn");
		}

		let done = false;
		let killTimer = null;
		let timedOut = false;
		const finish = (code, detail) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			note(jobId, code, detail);
		};
		// The kill ladder: SIGTERM, and SIGKILL for a child that ignored it. The escalation timer is
		// deliberately not cleared by finish -- it still has to land on a stubborn child -- and both
		// timers are unref'd so a draining worker is never held open by a notification.
		const stop = () => {
			timedOut = true;
			try {
				child.kill();
			} catch {}
			killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
			}, KILL_GRACE_MS);
			killTimer.unref?.();
		};
		const timer = setTimeout(() => stop(), timeoutMs);
		timer.unref?.();

		child.on("error", () => finish(null, "spawn"));
		// `exit`, not `close`: no pipes exist to wait on, and the event is right regardless. A death that
		// followed our own SIGTERM is named a timeout, not blamed on the signal it arrived by.
		child.on("exit", (code, sig) => finish(code, timedOut ? "timeout" : sig ? `signal-${sig}` : "exit"));
	};
}

/** The realpath-and-executable probe, secrets.mjs's exactly. */
function defaultRealExecutablePath(p) {
	const real = realpathSync(p);
	const st = statSync(real);
	return st.isFile() && (st.mode & 0o111) !== 0 ? real : null;
}
