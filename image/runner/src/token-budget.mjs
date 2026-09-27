/**
 * Token accounting + optional per-job token budget (issue #25, unblocked by OQ-010).
 *
 * pi 0.80.7 emits per-turn token usage on subscribe() as `event.message.usage` -- a required
 * `Usage` on the assistant AgentMessage. This attaches a synchronous listener that ACCUMULATES
 * that usage across turns. The meter is always on, so a job's token and cost totals land in run
 * history whether or not a cap is set; when a cap is set, it aborts the session once the running
 * total exceeds it.
 *
 * A token cap is structurally LAGGING (OQ-010): usage is known only AFTER a turn runs, so the
 * abort fires only once the breaching turn's tokens are already spent. It is a single-job runaway
 * backstop -- finer-grained than maxTurns because turns vary wildly in token cost -- NOT a
 * before-the-spend cap. maxTurns (REQ-RUNNER-TURN-BUDGET) stays the one proactive per-job lever.
 *
 * Two properties are inherited from attachTurnBudget and are not stylistic:
 *
 * 1. The listener is SYNCHRONOUS. `_emit` is an unawaited `for (const l of listeners) l(event)`,
 *    so an async listener is fire-and-forget and the next turn can start before the cap check
 *    runs -- overshooting further than the lag already forces.
 *
 * 2. `void session.abort()`. abort() returns a promise but flips the AbortController
 *    synchronously first, so the signal is set the instant we call it. Do not await inside the
 *    listener.
 *
 * The breach aborts ONCE per breach but re-aborts on every later turn_start (see the listener): pi can
 * start a new run after an abort, with a fresh signal, and one abort does not reach it. onAbort fires once.
 *
 * Usage is accumulated on turn_end ONLY. Each turn is a distinct billed API call, so summing the
 * per-turn usage yields the job's total billed tokens and cost. `agent_end` carries `messages[]`,
 * a terminal snapshot of those same messages -- accumulating it too would double-count.
 *
 * SCOPE as of issue #58: this is now the FALLBACK meter and cap. It subscribes to ONE session's bus,
 * which is per AgentSession instance, so it cannot see a subagent session an extension spawns -- the
 * process-wide meter in src/usage-meter.mjs is the primary. run-job.mjs attaches this ONLY when that
 * meter could not install (`usageMeter.ok === false`), so exactly one accumulator is ever live and
 * the two can never both count the same tokens. Do not attach it alongside the meter "for safety":
 * the totals would double and the cap would fire at half the configured budget.
 */
export function attachTokenBudget(session, maxTokens, { onAbort } = {}) {
	if (maxTokens !== null && maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
		throw new Error(`invalid PI_MAX_TOKENS: ${maxTokens}`);
	}
	const cap = maxTokens ?? null;

	const state = { input: 0, output: 0, total: 0, cost: 0, aborted: false };

	const unsubscribe = session.subscribe((event) => {
		// Once breached, EVERY later turn_start aborts again (issue #455 gate, A11/A13). The breach abort lands
		// on a turn_end, and one abort ends only the run in flight: when that turn failed with a retryable
		// error pi retries it with a FRESH AbortController (_prepareRetry, then agent.continue()), and a
		// queued follow-up starts a new run the same way (agent-session.js:732-733, :763-765). Each such
		// run opens with a turn_start before its model call, so re-aborting there keeps the cap a cap.
		if (event.type === "turn_start") {
			if (state.aborted) void session.abort();
			return;
		}
		if (event.type !== "turn_end") return;
		const message = event.message;
		if (message?.role !== "assistant" || !message.usage) return;
		const usage = message.usage;

		state.input += usage.input ?? 0;
		state.output += usage.output ?? 0;
		// totalTokens is the BILLED total (input + output + cache read/write), so state.total >= input +
		// output -- deliberately, not a bug. The cap and the daily counter must key on billed tokens, so do
		// not "fix" this to input+output. cost is a per-turn object; sum its `.total` (USD).
		state.total += usage.totalTokens ?? 0;
		state.cost += usage.cost?.total ?? 0;

		if (cap !== null && state.total > cap && !state.aborted) {
			state.aborted = true;
			onAbort?.(state.total);
			void session.abort();
		}
	});

	return { state, unsubscribe };
}
