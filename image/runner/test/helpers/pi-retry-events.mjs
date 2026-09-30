/**
 * pi's event order around a provider error and its own auto-retry (issue #449), re-read at the 0.99.1 pin
 * (issue #509); the order is unchanged from 0.80.7, and the loopback tests in pinned-api.test.mjs drive the
 * real session to prove it (recovered 429, exhausted 429, retry after a completed reply).
 *
 * Read off the pinned dist, not guessed:
 * - pi-agent-core dist/agent-loop.js:50-51 (a prompt) and :68-69 (a continue) emit agent_start then
 *   turn_start BEFORE the model call at :141; :113 emits the turn_start of every later turn in the same run;
 *   an error or aborted stop emits turn_end then agent_end and returns (:143-152).
 * - pi-coding-agent dist/core/agent-session.js:727 decorates agent_end with `willRetry` (false once an abort
 *   was requested, :775); :1324-1334 loops `agent.continue()` while _handlePostAgentRun says so;
 *   _prepareRetry (:2949-2985) emits auto_retry_start (:2961-2967), sleeps, and returns true; an assistant
 *   message_end whose stopReason is anything but "error" (so an ABORTED one too) emits
 *   auto_retry_end{success:true} (:754-760), which is AFTER the retry's turn_start; an exhausted streak
 *   emits no auto_retry_start (:2955-2958) and then auto_retry_end{success:false} (:1368-1374); a retry
 *   aborted mid-sleep emits auto_retry_end{success:false, finalError:"Retry cancelled"} and does not
 *   continue (:2933-2944, :2977).
 * - New at 0.99.1 and NOT modelled here: a retry whose transcript ends on the assistant after the failed
 *   attempt is omitted makes continue() throw and prompt() reject (pi-agent-core agent.js:270); that is
 *   driven for real in pinned-api.test.mjs and classified by classifyPromptRejection.
 *
 * Each function drives one run segment through `emit`, a synchronous fan-out like pi's own `_emit`.
 */

export const user = { role: "user", content: [{ type: "text", text: "do the thing" }] };

export function assistantError(errorMessage = "429 rate limited") {
	return { role: "assistant", content: [], stopReason: "error", errorMessage };
}

export function assistantText(text = "done") {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

export function assistantToolUse() {
	return { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], stopReason: "toolUse" };
}

function turn(emit, message, { retrySucceeded = false } = {}) {
	emit({ type: "message_start", message });
	emit({ type: "message_end", message });
	// agent-session.js:754-760: emitted from the message_end handler, before the loop's turn_end, for any
	// stopReason but "error" (an aborted retry message included).
	if (retrySucceeded) emit({ type: "auto_retry_end", success: true, attempt: 1 });
	emit({ type: "turn_end", message, toolResults: [] });
}

/** The prompt's first turn: agent_start, turn_start, the user message, then one assistant reply. */
export function promptTurn(emit, message) {
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	emit({ type: "message_start", message: user });
	emit({ type: "message_end", message: user });
	turn(emit, message);
}

/** A later turn inside the same run (after a tool call): agent-loop.js:113. */
export function nextTurn(emit, message) {
	emit({ type: "turn_start" });
	turn(emit, message);
}

/** The run's end: agent_end, decorated with willRetry as agent-session.js:727 does. */
export function agentEnd(emit, messages, willRetry) {
	emit({ type: "agent_end", messages, willRetry });
}

/** pi's retry of a failed turn: auto_retry_start, then agent.continue()'s agent_start and turn_start. */
export function retryTurn(emit, attempt, message, { maxAttempts = 2 } = {}) {
	emit({ type: "auto_retry_start", attempt, maxAttempts, delayMs: 2000, errorMessage: "429 rate limited" });
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	turn(emit, message, { retrySucceeded: message.stopReason !== "error" });
}

/** A continuation that is NOT a retry (threshold compaction or a queued message): agent-loop.js:68-69. */
export function continuationTurn(emit, message) {
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	turn(emit, message);
}

/**
 * A turn whose tools RAN and which then failed with a retry-shaped error (issue #455 gate, A8): pi turns
 * an exception thrown after the tools (here, a listener throwing on the tool result's message_end) into an
 * assistant error message, and retries it. Measured order (0.80.7, and the same events at 0.99.1 in the
 * loopback test): the assistant's tool call, then tool_execution_start/end (agent-loop.js:346-415/642 at
 * 0.99.1), the tool result's message_start/end, the synthetic error message, turn_end. At 0.99.1 the
 * retry that follows cannot resume (see the header); this helper models only the events up to it. The caller has already emitted this turn's turn_start.
 */
export function toolsThenError(emit, errorMessage = "fetch failed") {
	const call = assistantToolUse();
	emit({ type: "message_start", message: call });
	emit({ type: "message_end", message: call });
	emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
	emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: {}, isError: false });
	const result = { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "ran" }], isError: false };
	emit({ type: "message_start", message: result });
	emit({ type: "message_end", message: result });
	const failed = assistantError(errorMessage);
	emit({ type: "message_start", message: failed });
	emit({ type: "message_end", message: failed });
	emit({ type: "turn_end", message: failed, toolResults: [] });
	return failed;
}
