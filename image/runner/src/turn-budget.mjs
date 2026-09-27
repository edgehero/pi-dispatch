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
 * turn that ran NO tool. pi emits turn_start BEFORE the model call (pi-agent-core agent-loop.js:49/67/89,
 * the stream at :105), so the failed first turn of an error streak was already counted when the error
 * arrived; its retry (`auto_retry_start`, then `agent.continue()` re-emitting agent_start and
 * turn_start) re-sends that same turn's request. Counting it too turned a one-turn job's 429 into a
 * turn_budget policy stop, where it should have been a retried infra failure.
 *
 * The exemption is armed only when no tool executed since the last turn_start. pi turns ANY exception
 * thrown inside its loop into an assistant `stopReason: "error"` message, and when that text matches its
 * retry pattern ("fetch failed", a timeout, a 5xx) the error is retried like a provider's. An exception
 * AFTER the turn's tools ran (a listener throwing on the tool result's message_end, say) fails the turn
 * with the tool results already in context, so pi's "retry" calls the model with fresh tool results: a
 * genuinely new turn. A successful reply then resets pi's retry counter, so exempting it would launder
 * turns without bound (gate round 1 of #455 measured 9 paid calls at --max-turns 1). `tool_execution_start`
 * precedes every tool path at the pin (agent-loop.js:267/300/336, the truncated, sequential and parallel
 * runners), so it is the signal: set on it, cleared on every turn_start, read by `auto_retry_start`.
 *
 * So `auto_retry_start` arms a flag unless a tool ran, the next turn_start consumes it and lands in
 * `retryTurns` instead of `turns`, and `auto_retry_end` of EITHER kind clears it: a retry cancelled
 * mid-sleep by abort() emits `auto_retry_end{success:false}` and returns without continuing
 * (agent-session.js:2090-2101), and a compaction or queued-message continuation after it
 * (agent-session.js:760-765) must not ride the flag uncounted. When retries are exhausted pi emits no
 * `auto_retry_start` at all (agent-session.js:2068-2071). `agent_settled`, emitted when the prompt's
 * whole run chain is over (agent-session.js:739, `_emitAgentSettled` at :288-296), clears it too: a
 * retry-shaped throw AFTER a clean reply (a listener throwing on its turn_end, say) gets an
 * `auto_retry_start` whose `agent.continue()` then throws "Cannot continue from message role:
 * assistant", so no turn_start and no `auto_retry_end` follow, and the flag would otherwise exempt the
 * first turn of the NEXT prompt.
 *
 * The bound this keeps: retries per error streak are capped at PI_RETRY_MAX (pi's maxRetries, pinned by
 * the runner), and a streak can only be reset by a reply whose tools then run, which makes the next retry
 * a counted turn. So at most maxTurns * PI_RETRY_MAX retry calls go uncounted BY THIS EXEMPTION, every one
 * of them metered by the token budget. (Calls this module never counted, before or after #449, stay
 * uncounted: compaction and branch summarisation calls, and a subagent session's turns, see SCOPE above.)
 *
 * Auto-COMPACTION continuations still count, deliberately, including the one that is a re-run: an overflow
 * error with `willRetry` compacts and then re-sends the SAME turn (agent-session.js:1507-1530, :1674-1681),
 * once per streak. It counts even so, because it is paid work on a rewritten context and the issue is
 * about pi's retries only. Under --max-turns 1 that means a first turn that overflows the context ends as
 * turn_budget (exit 2, not retried), which is also the honest answer: the same prompt on the same context
 * overflows again.
 *
 * EVERY turn_start past the cap aborts, not only the first (a pre-existing defect fixed with #449). One
 * abort ends the CURRENT run only: a message queued for a follow-up makes pi's _handlePostAgentRun start a
 * new run with a fresh AbortController (agent-session.js:763-765), and a budget that aborted once let that
 * run go unbounded (gate round 1 measured 7 paid calls at --max-turns 1, on main too). The log line
 * (`onAbort`) still fires once. An exempt retry turn past the cap is aborted too: the budget is spent.
 */
export function attachTurnBudget(session, maxTurns, { onAbort } = {}) {
	if (!Number.isInteger(maxTurns) || maxTurns < 1) {
		throw new Error(`invalid PI_MAX_TURNS: ${maxTurns}`);
	}

	const state = { turns: 0, retryTurns: 0, aborted: false };
	let retryPending = false;
	let toolRanThisTurn = false;

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			toolRanThisTurn = true;
			return;
		}
		if (event.type === "auto_retry_start") {
			retryPending = !toolRanThisTurn;
			return;
		}
		if (event.type === "auto_retry_end" || event.type === "agent_settled") {
			retryPending = false;
			return;
		}
		if (event.type === "turn_start") {
			toolRanThisTurn = false;
			if (retryPending) {
				retryPending = false;
				state.retryTurns += 1;
			} else {
				state.turns += 1;
			}
			if (state.turns > maxTurns) {
				if (!state.aborted) {
					state.aborted = true;
					onAbort?.(state.turns);
				}
				void session.abort();
			}
		}
	});

	return { state, unsubscribe };
}
