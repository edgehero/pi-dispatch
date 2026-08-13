/**
 * INT-RUNNER-EXIT-CODE-PROTOCOL.
 *
 * The exit code IS the mechanism CONST-RETRY-INFRA-ONLY is implemented by: it is the
 * worker's only channel to tell "the agent ran and said no" from "the container died".
 */
export const EXIT_COMPLETED = 0; // agent ran -- INCLUDING concluding "I cannot fix this"
export const EXIT_INFRA = 1; // retryable: provider 5xx/429, network, our own bug
export const EXIT_POLICY = 2; // not retried: turn budget, cap, config error

/** pi-ai@0.80.7 dist/types.d.ts:273 -- all five. Enumerated so "length" cannot hide in a default branch. */
export const STOP_REASONS = ["stop", "length", "toolUse", "error", "aborted"];

/**
 * An error WE raised for a deterministic misconfiguration -- a bad/absent env var, a missing
 * input file. The worker passes the same bad value on every retry, so these must not be
 * retryable. Tagging the error with its exit code is more robust than pattern-matching the
 * message: classifyThrow honours the tag before it ever consults pi's error vocabulary.
 */
export function configError(message, reason = "config") {
	const error = new Error(message);
	error.piDispatchExit = EXIT_POLICY;
	// The optional reason (issue #189) rides the exit log line through classifyThrow, so a distinct
	// deterministic refusal -- an unregistered run.command -- stays greppable without a new exit code.
	// The default keeps every pre-existing caller byte-identical.
	error.piDispatchReason = reason;
	return error;
}

/**
 * Classify a preflight throw.
 *
 * pi DOES throw -- its own JSDoc says so -- but only before the agent loop starts:
 * no model selected, no API key, missing streamingBehavior, an extension error, or
 * "Agent is already processing." Inside the loop it never throws; failures arrive as
 * a stopReason instead. Both mechanisms are needed and they cover disjoint sets.
 *
 * The distinction that matters here is retryable-vs-not. A missing API key is a
 * deployment error: retrying spends nothing but proves nothing, and BullMQ would keep
 * paying to rediscover it. That is EXIT_POLICY, not EXIT_INFRA.
 */
export function classifyThrow(error) {
	// Errors we raised ourselves carry their own verdict -- honour it, do not re-derive it from
	// the message. This is how a bad PI_MAX_TURNS or a missing /job/prompt.md reaches exit 2:
	// tagging beats matching a regex tuned for pi's vocabulary against strings we control.
	if (error && typeof error.piDispatchExit === "number") {
		return { code: error.piDispatchExit, reason: error.piDispatchReason ?? "config", message: error.message };
	}

	const message = error instanceof Error ? error.message : String(error);

	// pi's own preflight vocabulary (no model / no API key / not authenticated). Retrying cannot
	// fix these either, so exit 2 (not retried), not 1 (retryable). These strings are pi's, so a
	// regex is the only tool available -- unlike our own errors, which we tag.
	if (/no model|model not|no api key|no.*credential|not authenticated/i.test(message)) {
		return { code: EXIT_POLICY, reason: "config", message };
	}

	// Everything else -- including "Agent is already processing." -- is our bug or infra.
	return { code: EXIT_INFRA, reason: "infra", message };
}

/**
 * Capture the terminal assistant message from the event stream.
 *
 * `agent_end` carries `messages: AgentMessage[]` and **no `message` field** (verified against
 * agent-session.d.ts at 0.80.7); `turn_end` carries `message`. Take whichever is present.
 * The runner asserts the result is an assistant message before classifying -- see REQ tests --
 * because a future pi that ended a turn on a ToolResultMessage would give it no stopReason.
 */
export function captureTerminal(previous, event) {
	if (event.type === "turn_end") return event.message ?? previous;
	if (event.type === "agent_end") return event.messages?.at(-1) ?? previous;
	return previous;
}

/**
 * The final exit decision. A budget-abort is checked FIRST and wins over stopReason, so a future
 * upstream change to how an abort surfaces as a stopReason cannot silently turn a blown budget
 * into exit 0. This is the composition the runner's own comment calls load-bearing; it lives
 * here so it can be tested without a container.
 *
 * Both budgets abort via session.abort(), which surfaces as `stopReason: "aborted"`. Intercepting
 * them here is what distinguishes an intentional cap (policy, not retried) from the generic abort,
 * and names WHICH cap fired. The turn budget is checked before the token budget only for a stable
 * order; in practice one abort ends the run, so at most one flag is set.
 */
export function decideExit({ budgetAborted, budgetTurns, tokenAborted, terminal, command = null }) {
	if (budgetAborted) {
		return { code: EXIT_POLICY, reason: "turn_budget", turns: budgetTurns };
	}
	if (tokenAborted) {
		return { code: EXIT_POLICY, reason: "token_budget" };
	}
	// A command job (issue #189, run.command): session.prompt("/name args") dispatches a registered
	// extension command and returns with NO assistant message, so the no-terminal branch below would
	// classify a clean headless run as infra and pay to retry a success. Three rules, in order:
	//   - a handler that THREW wins over everything it produced: pi swallows the throw (the runner
	//     observes it via extensionRunner.onError, the only channel pi offers at the pin) and a
	//     stop-reason that claimed success would be the swallow reaching the exit code. `command-error`
	//     is EXIT_INFRA -- retryable, by explicit choice: pi hands us only a message string, so
	//     transient-vs-deterministic is undecidable, and the accepted cost is that a deterministic
	//     extension bug retries until the queue's attempts run out (DES-COMMAND-ENTRY-POINT).
	//   - a handler that drove the model (sendUserMessage/waitForIdle) produced a terminal message,
	//     and its verdict is real -- a provider 429 inside a handler-driven turn must stay retryable.
	//   - otherwise the command ran headlessly to completion: exit 0, named `command-completed`.
	// Budget aborts stay FIRST, above: a handler-driven fanout is bounded by both budgets.
	if (command) {
		if (command.failed) return { code: EXIT_INFRA, reason: "command-error" };
		if (terminal) return classifyStopReason(terminal);
		return { code: EXIT_COMPLETED, reason: "command-completed" };
	}
	return classifyStopReason(terminal);
}

/**
 * Map the terminal assistant message's stopReason to an exit code.
 *
 * `session.prompt()` returns Promise<void>, so there is nothing to inspect; the message
 * arrives via subscribe(). A try/catch-only runner sees a clean resolve on a provider
 * 429 and exits 0 -- the queue records success, never retries, and the job did nothing.
 *
 * `terminal` is undefined when no assistant message was ever seen (e.g. the agent loop
 * never produced one). That is not success -- we have no evidence the agent ran.
 */
export function classifyStopReason(terminal) {
	if (!terminal) {
		return { code: EXIT_INFRA, reason: "no-terminal-message" };
	}

	switch (terminal.stopReason) {
		case "aborted":
			// Our turn budget or the timeout fired. Determinate: do not retry.
			return { code: EXIT_POLICY, reason: "aborted" };

		case "error":
			// Provider 5xx/429/network. Retryable -- this is what attempts: 2 is for.
			return { code: EXIT_INFRA, reason: "error", message: terminal.errorMessage };

		case "length":
			// Truncated at the token limit. The agent ran and produced work, so this is
			// NOT a failure -- but it is not a clean finish either, and a default-to-0
			// branch would hide it entirely. Succeed loudly.
			return { code: EXIT_COMPLETED, reason: "length", truncated: true };

		case "stop":
		case "toolUse":
			return { code: EXIT_COMPLETED, reason: terminal.stopReason };

		default:
			// An unknown stopReason means pi's union grew under our pin. Do not guess it
			// is benign: CONST-PI-VERSION-PINNED exists because upstream moves silently.
			return { code: EXIT_INFRA, reason: `unknown-stop-reason:${terminal.stopReason}` };
	}
}
