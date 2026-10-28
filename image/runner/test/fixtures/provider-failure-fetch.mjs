// Offline image-conformance transport. Loaded only by verify-image.sh's explicit NODE_OPTIONS.
// Return a real HTTP-shaped error without touching a socket; the normal SDK and runner still classify it.
globalThis.fetch = async () => new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "rate limit" } }), {
	status: 429,
	headers: { "content-type": "application/json", "retry-after": "120" },
});
