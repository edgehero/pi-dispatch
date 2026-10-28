/** Measured, closed failover evidence (issue #716). No provider text or headers leave this module. */
export const FAILURE_KINDS = Object.freeze(["rate-limited", "quota-exhausted", "overloaded", "context-overflow"]);
export const MAX_RESET_MS = 6 * 60 * 60 * 1000;
// These pinned HTTP adapters accept a per-call fetch. Google and Bedrock explicitly do not.
const FETCH_APIS = new Set(["anthropic-messages", "openai-completions", "openai-responses", "azure-openai-responses"]);

export function resetFromHeaders(headers, now) {
	const read = (name) => typeof headers?.get === "function" ? headers.get(name) : headers?.[name];
	const candidates = [];
	const retry = read("retry-after");
	if (typeof retry === "string" && retry.trim()) {
		const seconds = /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) : null;
		const value = seconds === null ? Date.parse(retry) : now + seconds * 1000;
		if (Number.isFinite(value) && value > now) candidates.push(value);
	}
	for (const name of ["anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-reset"]) {
		const raw = read(name);
		const value = typeof raw === "string" ? Date.parse(raw) : NaN;
		if (Number.isFinite(value) && value > now) candidates.push(value);
	}
	return candidates.length ? Math.min(Math.ceil(Math.max(...candidates)), now + MAX_RESET_MS) : null;
}

export function classifyProviderFailure(terminal, measured = null) {
	if (terminal?.stopReason !== "error" || (terminal.role !== undefined && terminal.role !== "assistant")) return null;
	const text = typeof terminal.errorMessage === "string" ? terminal.errorMessage : "";
	// Bedrock cannot take our fetch seam. Its pinned adapter supplies HTTP status in this diagnostic;
	// use only that number, never the request id or other provider text it carries.
	const diagnostic = Array.isArray(terminal.diagnostics) ? terminal.diagnostics.findLast((d) => d?.type === "bedrock_response_failure" && Number.isInteger(d.details?.status) && d.details.status >= 100 && d.details.status <= 599) : null;
	const status = measured?.status ?? diagnostic?.details.status;
	// Explicit parameter/auth errors win over any incidental quota wording in a request's diagnostics.
	if (/invalid_api_key|authentication_error|unauthorized|invalid[_ ]parameter|unsupported[_ ]parameter/.test(text.toLowerCase())) return null;
	if (status === 401 || status === 403) return null;
	let kind;
	if (/context_length_exceeded|maximum context length|prompt is too long|input is too long|context (?:window|length).{0,48}(?:exceed|overflow)|exceed(?:s|ed)?.{0,48}context (?:window|length)|input token count.{0,64}exceeds/i.test(text)) kind = "context-overflow";
	else if (/insufficient_quota|enforced_spend_limit_reached|quota.?exceeded|quota.?exhausted|ServiceQuotaExceededException|RESOURCE_EXHAUSTED|specified API usage limits|out of budget|billing|spend limit/i.test(text)) kind = "quota-exhausted";
	else if (status === 400 || /\b400\b/.test(text)) return null;
	// Bedrock's pinned adapter preserves these exception prefixes instead of necessarily including HTTP status.
	else if (status === 429 || /rate.?limit|too many requests|TooManyRequestsException|ThrottlingException|throttling error|\b429\b/i.test(text)) kind = measured?.resetAt ? "rate-limited" : "quota-exhausted";
	else if ((status >= 500 && status <= 599) || /overloaded|server_busy|server.?error|service.?(?:is.?)?(?:temporarily.?)?unavailable|model is at capacity|\b529\b|\b50[0234]\b/i.test(text)) kind = "overloaded";
	else return null;
	return { kind, ...(Number.isSafeInteger(measured?.resetAt) ? { resetAt: measured.resetAt } : {}) };
}

/** Observe the same memoised result as pi without consuming its event iterator or changing stream identity. */
export function installProviderFailureObserver({ ModelRuntime, now = Date.now, fetch = globalThis.fetch, rootSessionId = null }) {
	const messages = new WeakMap();
	let nonRootCalls = false;
	const rootStreams = new WeakSet();
	let rootCalls = 0;
	const originals = new Map();
	const wrappers = new Map();
	for (const method of ["stream", "streamSimple", "streamDeferred"]) {
		const original = ModelRuntime?.prototype?.[method];
		if (typeof original !== "function") continue;
		const wrapper = function (model, context, options) {
			if (options?.sessionId !== rootSessionId || rootSessionId === null) nonRootCalls = true;
			let measured = null;
			let passed = options;
			if (FETCH_APIS.has(model?.api)) {
				const theirs = options?.fetch ?? fetch;
				passed = { ...options, fetch: async (...args) => {
					measured = null;
					const response = await theirs(...args);
					const resetAt = resetFromHeaders(response.headers, now());
					measured = { status: response.status, ...(resetAt === null ? {} : { resetAt }) };
					return response;
				} };
			}
			const stream = original.call(this, model, context, passed);
			if (model?.api !== "pi-virtual" && stream && typeof stream === "object" && options?.sessionId === rootSessionId && rootSessionId !== null && !rootStreams.has(stream)) {
				rootStreams.add(stream);
				rootCalls += 1;
			}
			if (typeof stream?.result === "function") stream.result().then((message) => {
				if (message && typeof message === "object") {
					// Nested streamSimple -> stream wrappers must not replace the inner transport's evidence.
					if (measured !== null || !messages.has(message)) messages.set(message, measured);
				}
			}, () => {});
			return stream;
		};
		originals.set(method, original);
		wrappers.set(method, wrapper);
		ModelRuntime.prototype[method] = wrapper;
	}
	return {
		get rootCalls() { return rootCalls; },
		get nonRootCalls() { return nonRootCalls; },
		failure: (terminal) => classifyProviderFailure(terminal, messages.get(terminal)),
		uninstall() {
			for (const [method, original] of originals) if (ModelRuntime.prototype[method] === wrappers.get(method)) ModelRuntime.prototype[method] = original;
		},
	};
}

/** A run-wide latch: a later turn must never make an earlier tool side effect replayable. */
export function createToolStartLatch() {
	let toolsStarted = false;
	return {
		observe(event) { if (event.type === "tool_execution_start") toolsStarted = true; },
		get toolsStarted() { return toolsStarted; },
	};
}

/** Meter coverage must agree with the observed root calls, including calls that reported zero usage. */
export function providerReplaySafe({ toolsStarted, observer, tokens }) {
	return toolsStarted === false && observer.nonRootCalls === false && tokens?.metered === true && tokens.calls === observer.rootCalls && tokens.sessions <= 1 && !(tokens.childProcesses > 0) && !(tokens.unmeteredChildren > 0) && tokens.unresolved === 0;
}
