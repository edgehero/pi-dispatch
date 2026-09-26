/**
 * INT-RUNNER-EXIT-CODE-PROTOCOL.
 *
 * The exit code IS the mechanism CONST-RETRY-INFRA-ONLY is implemented by: it is the
 * worker's only channel to tell "the agent ran and said no" from "the container died".
 */
export const EXIT_COMPLETED = 0; // agent ran -- INCLUDING concluding "I cannot fix this"
export const EXIT_INFRA = 1; // retryable: provider 5xx/429, network, our own bug
export const EXIT_POLICY = 2; // not retried: turn budget, cap, config error, provider refused the credential

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
// `isRetryable` is pi-ai's own transient-error predicate (loadRetryPredicate), threaded to the one branch
// that reads it; null keeps every provider error retryable, which is what it was before issue #437.
export function decideExit({ budgetAborted, budgetTurns, tokenAborted, terminal, command = null, isRetryable = null }) {
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
		if (terminal) return classifyStopReason(terminal, isRetryable);
		return { code: EXIT_COMPLETED, reason: "command-completed" };
	}
	return classifyStopReason(terminal, isRetryable);
}

/**
 * The CLOSED list of errorMessage shapes that mean "the provider refused this credential" (issue #437).
 *
 * pi-ai hands the runner a display string, not the HTTP status, so a match on the string is the only
 * tool available, exactly as for classifyThrow's preflight vocabulary. Every entry is ANCHORED at the
 * start and names the status in a fixed position, because the alternative (a bare /401|403/ anywhere)
 * would read "500 upstream said 401" or a proxy's "Proxy response (403) !== 200 when HTTP Tunneling" as a
 * refusal and stop retrying a transient failure, which is the costlier mistake of the two: a missed
 * refusal only pays for its retries, a false one drops real work. Each shape is PROVED against the pinned
 * pi-ai by the loopback table in test/pinned-api.test.mjs, which is what lets a pin bump that changes a
 * provider's format fail a test instead of silently moving a refusal back to retryable.
 *
 * - `401 {...}` / `403: {...}` / `401 Unauthorized: ...`: the Anthropic SDK and the openai SDK format
 *   `${status} ${message}`, pi-ai's formatProviderError without a prefix gives `<status>: <body>`
 *   (openai-completions), and pi-messages builds `<status> <statusText>: <message>`. The lookahead is
 *   what keeps "4010 x" and "403x" out.
 * - `OpenAI API error (401): ...`, `Azure OpenAI API error (401): ...`, `Mistral API error (401): ...`:
 *   the fixed prefixes pi-ai's openai-responses, azure-openai-responses and mistral-conversations
 *   compose. Literals, not a generic `^.* API error \(`, so a new provider joins by proof, not by shape.
 *
 * NOT here, each by observation at the pin (the table records every one as a residual that still
 * retries): google-generative-ai and google-vertex put the raw JSON body in the message with the status
 * inside it; bedrock-converse-stream prefixes the SDK exception name (`AccessDeniedException: 403: ...`);
 * openai-codex-responses throws the body's own message with no status at all.
 */
const PROVIDER_AUTH_REFUSED = [
	/^(?:401|403)(?=[ :])/,
	/^OpenAI API error \((?:401|403)\): /,
	/^Azure OpenAI API error \((?:401|403)\): /,
	/^Mistral API error \((?:401|403)\): /,
];

/**
 * True when a terminal assistant message is a provider's refusal of the credential. Never throws.
 *
 * A status shape is necessary and not sufficient. A 403 is also what a gateway or an upstream proxy
 * answers while it is down: OpenRouter's `403: {"message":"Provider returned error",...}` and an HTML
 * 403 page saying "Service temporarily unavailable, please retry your request" both match the shape
 * above and both are transient. pi-ai already owns that judgement, as `isRetryableAssistantError`, and
 * pi's own session calls it to decide whether to restart the turn, so the runner asks the same predicate
 * rather than growing a second list that could drift from it: a message pi calls retryable is never a
 * refusal here.
 *
 * `isRetryable` is INJECTED (loadRetryPredicate below finds it in the pinned copy) because this module
 * must stay free of pi imports. Absent, broken or throwing, the answer is false, so the job retries: the
 * runner cannot tell transient from determinate without it, and the false determinate is the costlier
 * error. The residual this buys is named in INT-RUNNER-EXIT-CODE-PROTOCOL: a genuine refusal whose body
 * happens to carry one of pi's retry words (a "500" inside a request id, say) still retries.
 */
export function providerAuthRefused(terminal, isRetryable) {
	const errorMessage = terminal?.errorMessage;
	if (typeof errorMessage !== "string") return false;
	if (!PROVIDER_AUTH_REFUSED.some((pattern) => pattern.test(errorMessage))) return false;
	if (typeof isRetryable !== "function") return false;
	try {
		return isRetryable(terminal) === false;
	} catch {
		return false;
	}
}

/**
 * Find pi-ai's `isRetryableAssistantError` in the SAME copy the runner already dispatches through.
 *
 * The usage meter has already probed and accepted that copy (the nested one pi mutates; see
 * resolvePiAiCompat for why a bare specifier would name the wrong one), so its module is tried first;
 * the compat candidates follow, in the resolver's own order, for a runner whose meter did not install.
 * `load` is injected so this module keeps no pi import. Null when no candidate exports the predicate,
 * which providerAuthRefused reads as "retry everything", the safe direction.
 */
export async function loadRetryPredicate({ module = null, candidates = [], load = (url) => import(url) } = {}) {
	if (typeof module?.isRetryableAssistantError === "function") return module.isRetryableAssistantError;
	for (const candidate of candidates) {
		try {
			const mod = await load(candidate.url);
			if (typeof mod?.isRetryableAssistantError === "function") return mod.isRetryableAssistantError;
		} catch {
			// next candidate
		}
	}
	return null;
}

/**
 * The most a `message` may add to an exit line, counted AS SERIALIZED (issue #437 review). The worker
 * recovers the exit line from the last 8 KiB of container stdout (worker/src/run-history.mjs,
 * TAIL_CAP_BYTES, which counts string characters), and a provider's error body is unbounded: a 15 KB
 * HTML 403 put in whole pushes the line's head, where `code` and `reason` sit, out of that tail, and the
 * record loses the label. The budget is spent on the JSON-escaped form, not on the raw string, because
 * escaping is what the tail sees: a quote or a newline costs two characters and a control byte six, so a
 * raw-length cap of 2000 let a body of control bytes serialize to 12000 and lose the label anyway.
 * 2000 escaped characters plus the worst-case ledger, context and session keeps the whole line under
 * 6 KiB, a 2 KiB margin inside the tail; worker/test/run-history.test.mjs measures exactly that line.
 */
export const EXIT_MESSAGE_MAX_CHARS = 2000;

/**
 * The outcome with its `message` capped for the exit line. Every exit-line path goes through this.
 * Cuts on whole code points, so an astral character is never split into a lone surrogate.
 */
export function capExitMessage(outcome) {
	const message = outcome?.message;
	if (typeof message !== "string") return outcome;
	// Walk code points and stop at the budget, never stringifying the whole message: a body large enough
	// would make that one call throw (V8's maximum string length), and a throw here, on the exit path,
	// would lose the exit line itself. JSON.stringify adds the two enclosing quotes; they are not the
	// message's to spend.
	let kept = "";
	let spent = 0;
	for (const char of message) {
		const cost = JSON.stringify(char).length - 2;
		if (spent + cost > EXIT_MESSAGE_MAX_CHARS) {
			return { ...outcome, message: `${kept}... [truncated ${message.length - kept.length} chars]` };
		}
		kept += char;
		spent += cost;
	}
	return outcome;
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
export function classifyStopReason(terminal, isRetryable = null) {
	if (!terminal) {
		return { code: EXIT_INFRA, reason: "no-terminal-message" };
	}

	switch (terminal.stopReason) {
		case "aborted":
			// Our turn budget or the timeout fired. Determinate: do not retry.
			return { code: EXIT_POLICY, reason: "aborted" };

		case "error":
			// A provider that refused the credential (HTTP 401/403) refuses it again on every retry: the
			// worker hands the container the same key each attempt, so retrying pays for a container to
			// rediscover a determinate refusal (issue #437, CONST-RETRY-INFRA-ONLY). It rides the EXISTING
			// policy code with its own reason, never a new exit code (INT-RUNNER-EXIT-CODE-PROTOCOL).
			if (providerAuthRefused(terminal, isRetryable)) {
				return { code: EXIT_POLICY, reason: "provider-auth-refused", message: terminal.errorMessage };
			}
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
