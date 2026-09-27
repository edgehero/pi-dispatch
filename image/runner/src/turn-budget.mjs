/**
 * REQ-RUNNER-TURN-BUDGET.
 *
 * pi has NO max-turns, step limit, or iteration cap. A repo-wide search for
 * maxTurns|maxSteps|stepLimit|turnLimit returns zero hits; the agent loop is an outer
 * `while (true)` wrapping an inner `while (hasMoreToolCalls || pendingMessages.length)`,
 * bounded only by an AbortSignal. session.abort() is the only control surface there is.
 *
 * REQ-JOB-TIMEOUT-30M does not substitute: it bounds wall-clock. An agent can burn 200
 * turns in 29 minutes and exit "successfully" having spent the entire money budget.
 * Time and spend are different axes.
 *
 * Negative fact: this module exists because of an upstream absence. If pi ships a turn
 * limit, delete this rather than carrying it forever as unexplained ballast.
 *
 * SCOPE (issue #58): this counts `turn_start` on the ROOT session's event bus and nothing else. That
 * bus is per AgentSession INSTANCE, so a subagent session a staged package's extension spawns emits
 * nothing on it -- a 16-wide fanout registers here as roughly ONE turn, and this module is
 * structurally unable to see the difference. It bounds the root conversation's length, which is what
 * it was written for; the PROCESS-WIDE token meter (src/usage-meter.mjs) is what bounds fanout spend.
 */

/**
 * Attach a turn counter that aborts at `maxTurns`.
 *
 * Two things here are not stylistic:
 *
 * 1. The listener is SYNCHRONOUS. `_emit` is a plain `for (const l of listeners) l(event)`
 *    with no await, so an async listener is fire-and-forget: the next turn can start
 *    before an awaiting budget check has run, and the budget silently overshoots.
 *
 * 2. `void session.abort()`. abort() returns a promise (it awaits waitForIdle), but
 *    Agent.abort() flips the AbortController synchronously before that await -- so the
 *    signal is set the instant we call it. Awaiting here would mean awaiting inside an
 *    unawaited listener, which is (1) again. Fire it and return.
 *
 * The event is the bare AgentEvent `{ type: "turn_start" }` -- it carries NO turnIndex.
 * The indexed TurnStartEvent exists only on the extension bus, which subscribe() is not.
 * So we count ourselves.
 *
 * WHAT COUNTS (issue #449). Every turn_start counts EXCEPT the one that opens pi's own auto-retry of a
 * provider error. pi emits turn_start BEFORE the model call (pi-agent-core agent-loop.js:49/67/89, the
 * stream at :105), so the failed first turn of an error streak was already counted when the error
 * arrived; its retry (`auto_retry_start`, then `agent.continue()` re-emitting agent_start and
 * turn_start) re-does that same turn's work. Counting it too turned a one-turn job's 429 into a
 * turn_budget policy stop, where it should have been a retried infra failure. So `auto_retry_start`
 * arms a flag, the next turn_start consumes it and lands in `retryTurns` instead of `turns`, and
 * `auto_retry_end` of EITHER kind clears it: a retry cancelled mid-sleep by abort() emits
 * `auto_retry_end{success:false}` and returns without continuing (agent-session.js:2090-2101), and a
 * compaction or queued-message continuation after it (agent-session.js:760-765) must not ride the flag
 * uncounted. When retries are exhausted pi emits no `auto_retry_start` at all (agent-session.js:2068-2071).
 *
 * The bound this keeps: retries per error streak are capped at PI_RETRY_MAX (pi's maxRetries, pinned by
 * the runner); a successful retry turn's tool calls lead to the next turn_start, which IS counted; so the
 * counted turns still equal the real turns, and there are at most maxTurns * PI_RETRY_MAX uncounted
 * provider calls, every one of them metered by the token budget.
 *
 * Auto-COMPACTION continuations still count, deliberately: the issue is about retries only, and a
 * compaction continuation is a new paid call on a rewritten context, not a re-run of a failed turn.
 */
export function attachTurnBudget(session, maxTurns, { onAbort } = {}) {
	if (!Number.isInteger(maxTurns) || maxTurns < 1) {
		throw new Error(`invalid PI_MAX_TURNS: ${maxTurns}`);
	}

	const state = { turns: 0, retryTurns: 0, aborted: false };
	let retryPending = false;

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "auto_retry_start") {
			retryPending = true;
			return;
		}
		if (event.type === "auto_retry_end") {
			retryPending = false;
			return;
		}
		if (event.type === "turn_start") {
			if (retryPending) {
				retryPending = false;
				state.retryTurns += 1;
				return;
			}
			state.turns += 1;
			if (state.turns > maxTurns && !state.aborted) {
				state.aborted = true;
				onAbort?.(state.turns);
				void session.abort();
			}
		}
	});

	return { state, unsubscribe };
}
