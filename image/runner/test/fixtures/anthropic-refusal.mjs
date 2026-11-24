/**
 * Anthropic's explicit refusal as it arrives on the wire (issue #950): HTTP 200, `text/event-stream`, and the refusal as
 * the reply's stop reason, `message_delta` with `stop_reason: "refusal"` and `stop_details` of the Anthropic SDK's
 * `RefusalStopDetails` shape (`type`, `category`, `explanation`, each of the last two nullable). SYNTHETIC events, not
 * captured bytes: their fields are the ones the pinned readers take, pi-ai 1.6.0's anthropic-messages.js
 * (`event.delta.stop_reason`, `event.delta.stop_details`) and pi-anthropic-oauth's src/stream.ts (the same two). The
 * tests drive both readers with these events and read nothing else, so bytes captured from the real endpoint replace
 * these in this one file.
 *
 * Both explanations are made up. The second deliberately starts with "403 " (a credential refusal's shape) and holds
 * "rate limit", one of pi-ai's retry words (utils/retry.js): a refusal must be named by its stop reason whatever its
 * explanation says, and pi's own in-session retry of such a refusal is a named residual the loopback pins.
 */
export const EXPLANATION = "This request could enable harm, so it was not completed.";
export const HOSTILE_EXPLANATION = "403 rate limit: this request could enable harm, so it was not completed.";

/** pi-ai 1.6.0's own sentence for a refusal with no explanation (anthropic-messages.js mapStopReason). */
export const PI_AI_FALLBACK = "The model refused to complete the request";

/** The subscription adapter's message for each case (pi-anthropic-oauth 0.3.6 and 0.3.11, applyMessageDelta). */
export const ADAPTER_MESSAGE = Object.freeze({
	plain: "Provider stop reason: refusal",
	explained: `Provider stop reason: refusal \u2014 ${EXPLANATION}`,
	hostile: `Provider stop reason: refusal \u2014 ${HOSTILE_EXPLANATION}`,
});

const stopDetails = (explanation) => ({ type: "refusal", category: explanation === null ? null : "general_harms", explanation });

/**
 * The events of one refused reply, in order. `explanation` null gives the bare refusal; `cut` leaves out `message_stop`,
 * for a caller that then breaks the connection after the refusal's `message_delta`.
 */
export function refusalEvents({ model = "stub", explanation = null, cut = false } = {}) {
	const events = [
		{ type: "message_start", message: { id: "msg_refusal", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I can" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null, stop_details: stopDetails(explanation) }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	return cut ? events.slice(0, -1) : events;
}

/** The same events as an SSE body. */
export function refusalBody(options) {
	return refusalEvents(options).map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

export const HEADERS = Object.freeze({ "content-type": "text/event-stream" });
