/**
 * Running an operator's wait check (issue #230, `run.waitFor`'s `profile` conditions).
 *
 * `secrets.mjs`'s resolver, reduced. The two seams spawn an operator-written script on the HOST, before
 * anything spends, with the worker's own environment, and read its EXIT CODE. The differences are all
 * subtractions, and each one is a thing the resolver needs that a check does not:
 *
 *   - **stdout is a byte counter too, not a value.** A resolver's stdout IS the secret; a check's is
 *     incidental output nobody asked for. Reading it would create a channel for a third party's text to
 *     reach a panel row or a public comment through an operator's script, which `INT-WAIT-PROFILES-CONTRACT`
 *     refuses. Whether a check may return a reason string worth showing is deferred, and deferring it is
 *     cheaper than un-shipping it later.
 *   - **no size cap, no NUL check, no newline stripping.** Those exist because a resolved value becomes an
 *     `-e NAME=VALUE` argv element. Nothing here becomes anything.
 *   - **no dedup by reference.** A resolver dedups because two variables may name one item and rotation
 *     could straddle the pair. Two conditions naming one profile are refused at load instead.
 *   - **four codes rather than three** (`INT-RUNNER-EXIT-CODE-PROTOCOL`'s wait-profile table), because a
 *     check has an answer the other participants do not: not yet.
 *
 * What transfers unchanged, because the reasons transfer unchanged: the `name:/abs/path` grammar and its
 * fail-loud parser, the realpath-and-executable probe, `spawn` with an argv ARRAY and `shell: false`,
 * stdin ignored so a script that prompts dies at once instead of blocking to its timeout, stderr counted
 * and never read, SIGTERM then SIGKILL after a grace, a per-invocation timeout, the abort signal, and
 * sequential evaluation in the operator's writing order.
 */

import { realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { EXIT_HOLD, decideWait } from "./exit-code.mjs";

/** SIGTERM, then SIGKILL after this. `secrets.mjs`'s grace, for its reason. */
const KILL_GRACE_MS = 2000;

/**
 * Build the checker. Returns `async (profile, target, { signal }) => verdict`, where verdict is
 * `{ verdict: "go" | "hold" | "refuse", fault }` or `{ profileUnknown: name }`.
 *
 * NEVER THROWS and never rejects, which is `resolveSecrets`' contract and matters more here: this runs at
 * the pickup gate, ABOVE the processor's `try`, where a rejection would escape into BullMQ's failed-attempt
 * handling and turn a check that could not run into a retried job. The `log` sink is called inside guards
 * for that reason -- an injected sink that throws is the one way this promise could otherwise be broken.
 */
export function makeWaitChecker({ profiles = {}, timeoutMs = 10_000, spawnFn = spawn, realExecutablePath = defaultRealExecutablePath, hostEnv = process.env, log = () => {} }) {
	return async function checkWait(profile, target, { signal } = {}) {
		const declared = profiles[profile];
		if (typeof declared !== "string") return { profileUnknown: profile };

		// Resolved and probed at CHECK time, not at boot: an operator who fixes a path mid-day must not stay
		// refused, and one who deletes a script must not stay admitted. `statSync` rather than `lstat`,
		// deliberately unlike `processor.mjs`'s directory probe, because this must answer the same question
		// `spawn` will: spawn follows symlinks. Mode bits beyond the executable bit are doctor's business, not
		// a job-time refusal -- refusing a group-writable script here would refuse a very ordinary install.
		let path;
		try {
			path = realExecutablePath(declared);
		} catch {
			path = null;
		}
		if (!path) return { profileUnknown: profile };

		// argv[1] must be a string a script can act on. `targetFor` answers null for any kind that is neither
		// local nor a forge, and `spawn(path, [null])` throws -- which `runCheck` would turn into a silent
		// fault hold, killing the job as `wait-unanswerable` and blaming the operator's check for a shape it
		// never saw. The leading-dash refusal is `run.secrets`' own, for its reason: this is argv[1], where a
		// dash parses as a flag, and we do not pass `--` instead because the option parser is the operator's.
		if (typeof target !== "string" || target === "" || target.startsWith("-")) {
			try {
				log("wait_check_target_unusable", { profile });
			} catch {}
			return { verdict: "hold", fault: true, unusableTarget: true };
		}

		const outcome = await runCheck(spawnFn, path, target, { timeoutMs, hostEnv, signal });
		try {
			log("wait_check", { profile, code: outcome.code, detail: outcome.detail, stdoutBytes: outcome.stdoutBytes, stderrBytes: outcome.stderrBytes });
		} catch {}
		return outcome.verdict;
	};
}

/** The realpath-and-executable probe, `secrets.mjs`'s exactly. */
function defaultRealExecutablePath(p) {
	const real = realpathSync(p);
	const st = statSync(real);
	return st.isFile() && (st.mode & 0o111) !== 0 ? real : null;
}

/**
 * Run one check and classify it. Resolves `{ verdict, code, detail, stdoutBytes, stderrBytes }`.
 *
 * A check that could not run AT ALL -- spawn threw, the process died on a signal, the timeout fired, the
 * job was aborted -- is a FAULT hold rather than a refusal, which is `decideWait`'s treatment of exit 1 and
 * for its reason: a check that has not answered has not answered *no*, and dropping a paid delivery over an
 * unreachable dependency is `CONST-RETRY-INFRA-ONLY` in the expensive direction. The fault count is what
 * keeps that from being unbounded.
 */
function runCheck(spawnFn, path, target, { timeoutMs, hostEnv, signal }) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnFn(path, [target], {
				stdio: ["ignore", "pipe", "pipe"],
				env: hostEnv,
				shell: false,
			});
		} catch {
			resolve({ verdict: { verdict: "hold", fault: true }, code: null, detail: "spawn", stdoutBytes: 0, stderrBytes: 0 });
			return;
		}

		let stdoutBytes = 0;
		let stderrBytes = 0;
		let done = false;
		let killTimer = null;

		const finish = (result) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener?.("abort", onAbort);
			resolve(result);
		};
		// The kill timer is deliberately NOT cleared by `finish`: the promise settles now, and the escalation
		// still has to land on a child that ignored SIGTERM.
		const stop = (why) => {
			try {
				child.kill();
			} catch {}
			killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
			}, KILL_GRACE_MS);
			killTimer.unref?.();
			// An ABORT is not a fault. The worker is shutting down or this job was cancelled -- the operator's
			// script did nothing wrong, and counting it would let five restarts that happen to land mid-check
			// terminate a job with a PUBLIC comment blaming their check for the worker's own shutdown. That is
			// the inverse of what the fault count is for, so the caller is told which of the two happened.
			finish({ verdict: { verdict: "hold", fault: why !== "aborted", ...(why === "aborted" && { aborted: true }) }, code: null, detail: why, stdoutBytes, stderrBytes });
		};

		const timer = setTimeout(() => stop("timeout"), timeoutMs);
		const onAbort = () => stop("aborted");
		signal?.addEventListener?.("abort", onAbort, { once: true });

		// BOTH streams are counters. stderr for the resolver's stated reason (a script's error text can echo
		// the ticket, the query, or a vendor's own message), and stdout for the same reason one step further:
		// a check's stdout is a third party's words arriving through an operator's script, and the only thing
		// this seam is entitled to read from it is how much there was.
		child.stdout?.on("data", (d) => (stdoutBytes += d.length));
		child.stderr?.on("data", (d) => (stderrBytes += d.length));
		child.on("error", () => finish({ verdict: { verdict: "hold", fault: true }, code: null, detail: "spawn", stdoutBytes, stderrBytes }));
		// `exit`, NOT `close`. `close` waits for the child's stdio pipes to reach EOF, and any process the
		// script leaves in the background inherits those pipes and holds them open -- so a check that answers
		// `exit 0` in a millisecond is reported as a TIMEOUT, charged a fault, and after
		// PI_WAIT_MAX_FAULTS the job dies with a public comment blaming the operator's script for something it
		// did correctly. The resolver next door can afford `close` because it needs the bytes; this seam reads
		// only a COUNT, so waiting for EOF buys nothing and costs the feature its credibility.
		//
		// The counts are then a floor rather than a total, which is what a byte counter is for, and the
		// grandchild that kept the pipe open outlives the kill ladder -- `child.kill` reaches the direct child
		// only. That residual is named in DES-WAIT-FOR-HOLDS-AND-WAIT-PROFILES rather than fixed here, because
		// killing a process GROUP means spawning detached, which changes what the check inherits.
		child.on("exit", (code, sig) => {
			if (done) return;
			// A signalled death reports code null; treat it as unanswered rather than letting `decideWait`
			// read a null as an unrecognised code that means the same thing by accident.
			if (code === null) return finish({ verdict: { verdict: "hold", fault: true }, code: null, detail: sig ? `signal-${sig}` : "no-code", stdoutBytes, stderrBytes });
			finish({ verdict: decideWait(code), code, detail: code === EXIT_HOLD ? "not-yet" : "exit", stdoutBytes, stderrBytes });
		});
	});
}
