/**
 * INT-RUNNER-EXIT-CODE-PROTOCOL, worker side.
 *
 * The container's exit code is the ONLY channel telling "the agent ran and concluded something"
 * from "the container died". The worker turns that into BullMQ's throw-vs-return, which IS
 * CONST-RETRY-INFRA-ONLY: a thrown processor is retried, a returned one is not.
 */
export const EXIT_COMPLETED = 0; // agent ran, INCLUDING "I cannot fix this" -- a determinate success
export const EXIT_INFRA = 1; // container died, network, provider 5xx/429 -- the only retryable class
export const EXIT_POLICY = 2; // budget/turn cap/config -- a determinate refusal, never retried

/**
 * "Not yet, ask again later" (issue #230). Emitted by the WAIT PARTICIPANT ONLY.
 *
 * The protocol's third queue behaviour, and the only code in it that no container and no secret resolver
 * may emit: a container exiting 3 is still an unrecognised code and still infra-retries through
 * `processor.mjs`'s own switch, a resolver exiting 3 is still `unreachable`, and both are pinned. This is
 * therefore a per-participant widening rather than a new meaning for a code anyone else already speaks.
 *
 * Minting a code rather than riding `reason` on an exit log line -- which is what
 * `INT-RUNNER-EXIT-CODE-PROTOCOL` asks of the CONTAINER's new vocabulary -- is possible here for the
 * reason that rule does not reach: a wait participant has no exit log line to ride. It produces no run
 * record and no log line of its own while a job is held, so `reason` is not a channel it has.
 */
export const EXIT_HOLD = 3;

/**
 * Decide whether the processor should RETURN (BullMQ records success, no retry) or THROW (BullMQ
 * retries per `attempts`). Returns `{ retry }`; the caller returns on false and throws on true.
 *
 * Only exit 1 is retryable. 0 and 2 are both determinate outcomes -- the agent's verdict (or our
 * own budget refusal) is the product, not a failure to paper over by paying for it again. An
 * unknown code is treated as infra: a runner that exits with something we do not recognise is a
 * runner we cannot reason about, and retrying-then-alerting beats silently accepting it as done.
 */
export function decideRetry(exitCode) {
	switch (exitCode) {
		case EXIT_COMPLETED:
			return { retry: false, outcome: "completed" };
		case EXIT_POLICY:
			return { retry: false, outcome: "policy" };
		case EXIT_INFRA:
			return { retry: true, outcome: "infra" };
		default:
			return { retry: true, outcome: `unknown-exit-${exitCode}` };
	}
}

/**
 * Classify a WAIT PROFILE's exit code (issue #230). Returns `{ verdict, fault }`, where `verdict` is
 * `"go"` (run the job), `"hold"` (defer and ask again) or `"refuse"` (terminal, never retried).
 *
 * The four codes and why each lands where it does:
 *
 *   0  the condition has cleared            -> go
 *   3  not yet                              -> hold, NOT a fault: this is the normal answer
 *   1  I could not tell                     -> hold, AND a fault
 *   2  this will never clear                -> refuse, terminal
 *   *  anything else                        -> hold, AND a fault
 *
 * `1` HOLDS RATHER THAN REFUSING because a check that cannot answer has not answered "no": treating an
 * unreachable Jira as "this will never clear" would drop a paid delivery over a transient outage, which is
 * `CONST-RETRY-INFRA-ONLY` in the expensive direction and the same call `secrets.mjs` makes for a resolver
 * that cannot reach its manager.
 *
 * `fault` is what keeps `1` and `3` from being the same code wearing two hats, and it exists because of
 * `OQ-027`: most CLIs exit 1 for everything, so without it a permanently broken check -- a typo'd `curl`
 * exits 6, a false `jq -e` exits 1 -- would hold for the entire maximum wait, spawn a process every
 * interval, and finally terminate with a reason that blames the CONDITION rather than the script. Counting
 * consecutive faults lets that terminate loudly in minutes, naming the check. A `3` resets the count: a
 * check that answered is a check that works.
 *
 * The unrecognised arm folds into `1` deliberately, which is this protocol's own rule for an unrecognised
 * code, and it is why the naive one-liner an operator writes first (`grep -q ... ` , exit 1 when the
 * pattern is absent) behaves correctly by accident: it holds, and the fault counter bounds it.
 */
export function decideWait(exitCode) {
	switch (exitCode) {
		case EXIT_COMPLETED:
			return { verdict: "go", fault: false };
		case EXIT_HOLD:
			return { verdict: "hold", fault: false };
		case EXIT_POLICY:
			return { verdict: "refuse", fault: false };
		default:
			return { verdict: "hold", fault: true }; // EXIT_INFRA and every unrecognised code
	}
}

/**
 * A listener for an error on the CLI's stdout (issue #503, gate round 1): a write to a pipe whose reader has exited
 * fails with EPIPE, which Node emits as an `error` event, and with no listener that is an uncaught exception printed
 * with its whole stack after the verb had already done its work. Installed by the worker's CLI for every verb. It only
 * quiets the trace: the exit code stays what that uncaught exception gave (1), or the verb's own when it set one.
 */
export function installStdoutPipeGuard({ stream = process.stdout, proc = process, write = (line) => process.stderr.write(line) } = {}) {
	stream.on("error", (error) => {
		// The reader went away (`pi-dispatch egress render | head -1`). The guard removes the stack trace and NOTHING
		// else (gate round 2): the exit code is the one an unhandled EPIPE gave, 1, unless the verb had already set its
		// own. Exiting 0 here told systemd's Restart=on-failure and launchd's SuccessfulExit=false that a long-running
		// worker whose log reader died had finished cleanly, so neither restarted it (measured).
		if (error?.code === "EPIPE") {
			proc.exit(typeof proc.exitCode === "number" ? proc.exitCode : EXIT_INFRA);
			return;
		}
		// Anything else on stdout is a fault worth one line on stderr, and infra's exit code, as Node's own default would be.
		write(`error: writing to stdout failed: ${error?.code ?? error?.message ?? "unknown"}\n`);
		proc.exit(EXIT_INFRA);
	});
}

/**
 * A process-level printer for a promise nobody handled (PR #475's review, round 2): Node prints such a rejection's
 * reason WHOLE, and a Valkey client's error may carry what it sent (connection.mjs scrubs that at the source; this is
 * the second line of defence for anything else). It prints the message alone and exits 1, which is what Node's own
 * default does with an unhandled rejection: infra, restarted by the service manager, never a silent carry-on. Installed
 * by the worker's CLI (every `pi-dispatch` verb, the worker among them) and the receiver's two entry points.
 */
export function installRejectionPrinter({ proc = process, write = (line) => process.stderr.write(line) } = {}) {
	proc.on("unhandledRejection", (reason) => {
		const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "a non-Error value";
		write(`error: an unhandled rejection: ${message}\n`);
		proc.exit(EXIT_INFRA);
	});
}
