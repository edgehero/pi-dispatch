/**
 * A ChatGPT subscription's usage-limit refusal as it arrives on the wire (issue #960): HTTP 200, `text/event-stream`,
 * the refusal as an event after `response.created`. SYNTHETIC shapes, not captured bytes: each was replayed from a
 * loopback server through the real pinned pi 1.5.2's openai-responses path (`pi -p --provider openai`, and the runner),
 * which gave exactly the sentence the issue reports for `EVENT`, `TOP_LEVEL` and `NAMED` (one request, exit 1), and the
 * messages in PI_MESSAGE, which name the code, for `TYPE_ERROR`, `TYPE_ERROR_NAMED` and `FAILED`. Bytes captured from the real endpoint replace these in this one file; the tests read nothing else.
 */
export const SENTENCE = "The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.";
export const USAGE_LIMIT = "subscription_sharing_usage_limit_exceeded";
export const WORKPLACE_LIMIT = "subscription_sharing_workplace_individual_usage_limit_exceeded";

const created = `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", status: "in_progress" } })}\n\n`;

/** The refusal as each shape, with the code and any extra error fields (a reset, when the endpoint sends one) given. */
export const SHAPES = Object.freeze({
	// `event: error`, the error's fields at the top of the data: the openai SDK throws `data.error ?? data`.
	EVENT: (code = USAGE_LIMIT, extra = {}) => `${created}event: error\ndata: ${JSON.stringify({ type: "error", code, message: SENTENCE, param: null, sequence_number: 1, ...extra })}\n\n`,
	// No `event:` line, a top-level `error` object: the SDK throws `data.error`.
	TOP_LEVEL: (code = USAGE_LIMIT, extra = {}) => `${created}data: ${JSON.stringify({ error: { code, message: SENTENCE, ...extra } })}\n\n`,
	// Any other named event (not `thread.*`) whose data holds a top-level `error`: the SDK throws `data.error` for it too.
	NAMED: (code = USAGE_LIMIT, extra = {}) => `${created}event: response.in_progress\ndata: ${JSON.stringify({ type: "response.in_progress", error: { code, message: SENTENCE, ...extra } })}\n\n`,
	// pi-ai's own `type: "error"` with no `event: error` (no line, or another name): the SDK hands it on and pi-ai throws
	// `Error Code <code>: <message>`, which names the code, so it is not the issue's output either.
	TYPE_ERROR: (code = USAGE_LIMIT, extra = {}) => `${created}data: ${JSON.stringify({ type: "error", code, message: SENTENCE, ...extra })}\n\n`,
	TYPE_ERROR_NAMED: (code = USAGE_LIMIT, extra = {}) => `${created}event: response.in_progress\ndata: ${JSON.stringify({ type: "error", code, message: SENTENCE, ...extra })}\n\n`,
	// `response.failed`: pi-ai reads `response.error` and names the code in its message, which the issue's output does not.
	FAILED: (code = USAGE_LIMIT, extra = {}) => `${created}event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code, message: SENTENCE, ...extra } } })}\n\n`,
});

/** What pi's terminal message says for each shape, as the pinned pi printed it. */
export const PI_MESSAGE = Object.freeze({
	EVENT: SENTENCE,
	TOP_LEVEL: SENTENCE,
	NAMED: SENTENCE,
	TYPE_ERROR: `Error Code ${USAGE_LIMIT}: ${SENTENCE}\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage`,
	TYPE_ERROR_NAMED: `Error Code ${USAGE_LIMIT}: ${SENTENCE}\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage`,
	FAILED: `${USAGE_LIMIT}: ${SENTENCE}\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage`,
});

export const HEADERS = Object.freeze({ "content-type": "text/event-stream" });
