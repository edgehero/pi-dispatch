/** Measured, closed failover evidence (issue #716). No provider text or headers leave this module. */
export const FAILURE_KINDS = Object.freeze(["rate-limited", "quota-exhausted", "overloaded", "context-overflow"]);
export const MAX_RESET_MS = 6 * 60 * 60 * 1000;
// These pinned HTTP adapters accept a per-call fetch. Google and Bedrock explicitly do not.
const FETCH_APIS = new Set(["anthropic-messages", "openai-completions", "openai-responses", "azure-openai-responses"]);
/**
 * The closed subscription quota codes, exported so the worker's copy (worker/src/model-failover-protocol.mjs) is pinned to
 * this list. The two `subscription_sharing_*_limit_exceeded` codes are a ChatGPT subscription's own usage limit and a
 * Business workspace's per-user limit (issue #960): pi-ai lists exactly that pair as non-retryable account limits
 * (`utils/retry.js`). The retryable `subscription_sharing_usage_unavailable` and `subscription_sharing_user_unavailable`
 * are a passing outage, not a quota, and stay out, so they can never pause a connection.
 */
export const SUBSCRIPTION_QUOTA_CODES = Object.freeze(["usage_limit_reached", "usage_not_included", "rate_limit_exceeded", "quota_exhausted", "subscription_sharing_usage_limit_exceeded", "subscription_sharing_workplace_individual_usage_limit_exceeded"]);
const SUBSCRIPTION_CODES = new Set(SUBSCRIPTION_QUOTA_CODES);
/** The most one server-sent event's data may hold before the stream reader below stops buffering it. */
export const SSE_FRAME_CAP = 65_536;
/**
 * The egress proxy's refusal of a CONNECT (undici's ProxyAgent, `lib/dispatcher/proxy-agent.js`). The status in it is the
 * proxy's, never the provider's: the request did not reach the provider. Since pi 1.5.2 (pi-ai `utils/error-body.js`
 * `withCauseDetail`) a connection failure's message carries its deepest cause, so this text now reaches the patterns
 * below, where a 502 or 429 in it read as the model being overloaded or out of quota, a cooldown and a failover that
 * pi 1.5.0's bare "Connection error." never caused. It is cut from the text first, on every api.
 */
const PROXY_TUNNEL_REFUSAL = /Proxy response \(\d{3}\) !== 200 when HTTP Tunneling/g;

/** Inspect only bounded structured error fields. Provider prose cannot create a persistent subscription pause. */
export async function subscriptionFailureFromResponse(response, { now = Date.now } = {}) {
	if (response.status !== 429 || typeof response.clone !== "function") return null;
	let reader;
	let timer;
	try {
		reader = response.clone().body?.getReader();
		if (!reader) return null;
		const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("bounded error read")), 2000); timer.unref?.(); });
		const chunks = [];
		let length = 0;
		while (true) {
			const chunk = await Promise.race([reader.read(), timeout]);
			if (chunk.done) break;
			length += chunk.value.byteLength;
			if (length > 65_536) return null;
			chunks.push(chunk.value);
		}
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return subscriptionEvidence(body?.error, now);
	} catch { return null; }
	finally { clearTimeout(timer); try { void reader?.cancel().catch(() => {}); } catch {} }
}

/** One structured error object's closed code and its reset, shared by the 429 body and the event stream. Never its message. */
function subscriptionEvidence(error, now) {
	const code = error?.code ?? error?.type;
	if (!SUBSCRIPTION_CODES.has(code)) return null;
	const rawReset = error?.resets_at ?? error?.reset_at;
	const resetAt = typeof rawReset === "number" ? (rawReset < 10_000_000_000 ? rawReset * 1000 : rawReset) : typeof rawReset === "string" ? Date.parse(rawReset) : NaN;
	return { subscriptionCode: code, ...(Number.isSafeInteger(resetAt) && resetAt > now() && resetAt <= now() + 32 * 86_400_000 ? { resetAt } : {}) };
}

/**
 * The error object a server-sent event carries, or null when the event is no failure. The pinned stack fails a call on
 * exactly these, in this order: `event: error` (the openai SDK throws `data.error ?? data`, `core/streaming.js`); ANY
 * other event whose data holds a top-level `error` (the SDK throws `data.error` for every event not named `thread.*`,
 * and for one with no `event:` line); then, on what the SDK hands on, pi-ai's `type: "error"` and `response.failed`
 * (`openai-responses-shared.js` reads `response.error`). `thread.*` events are never thrown on, so they are never read.
 */
function eventError(event, data) {
	if (event === "error") return data !== null && typeof data === "object" ? data.error ?? data : {};
	if (data === null || typeof data !== "object") return null;
	if (data.error) return data.error;
	if (data.type === "error") return data;
	if (data.type === "response.failed") return data.response?.error ?? {};
	return null;
}

/**
 * A pass-through reader of an OpenAI Responses event stream (issue #960). A ChatGPT subscription past its usage limit
 * answers HTTP 200 with the refusal as an event: the SDK throws the event's own object, and pi's message keeps only its
 * prose, so the closed code never reaches the terminal message and the only place to read it is the stream itself.
 *
 * Every chunk is passed on unchanged, AFTER it was read, so `onError` has run before pi sees the event that failed the
 * call. Every event's data is held up to SSE_FRAME_CAP (one past it is dropped as it passes, unread) and parsed as the
 * SDK parses it, so on the events it reads the reading stops where the SDK stops: at the first failing event, at
 * `[DONE]`, at data that is not JSON and at a named event with no data (the SDK parses the empty data and throws).
 * `thread.*` events are dropped as they pass. Any throw in here ends the reading, never the bytes. A pass-through and
 * not `tee()`: a tee buffers everything for the branch nobody reads and keeps the socket open after pi aborts, where
 * this cancels the source when pi cancels, because `pipeThrough` does.
 */
function sseErrorReader(onError) {
	const decoder = new TextDecoder();
	let line = "";
	let lineSkipped = false;
	let afterCR = false;
	let event = "";
	let data = "";
	let hasData = false;
	let frameSkipped = false;
	let done = false;
	const dispatch = () => {
		const frame = { event, data, hasData, frameSkipped };
		event = ""; data = ""; hasData = false; frameSkipped = false;
		if (frame.frameSkipped) return;
		// The SDK delivers an event once it has a name or data; with a name and no data it parses "" and throws.
		if (!frame.hasData) { if (frame.event !== "") done = true; return; }
		// The SDK stops at its end marker without parsing it.
		if (frame.data === "[DONE]") { done = true; return; }
		// A parse that throws ends the reading (the transform's catch), where the SDK's own parse throws too.
		const error = eventError(frame.event, JSON.parse(frame.data));
		if (error === null) return;
		done = true;
		onError(error);
	};
	const endLine = () => {
		const text = line;
		const skipped = lineSkipped;
		line = ""; lineSkipped = false;
		if (skipped) return;
		if (text === "") return dispatch();
		if (text.startsWith(":")) return;
		const colon = text.indexOf(":");
		const field = colon === -1 ? text : text.slice(0, colon);
		const value = colon === -1 ? "" : text.slice(colon + (text[colon + 1] === " " ? 2 : 1));
		if (field === "event") {
			event = value;
			if (value.startsWith("thread.")) { frameSkipped = true; data = ""; }
		} else if (field === "data" && !frameSkipped) {
			data = hasData ? `${data}\n${value}` : value;
			hasData = true;
			if (data.length > SSE_FRAME_CAP) { frameSkipped = true; data = ""; }
		}
	};
	const feed = (text) => {
		let at = 0;
		if (afterCR && text.startsWith("\n")) at = 1;
		afterCR = false;
		// The next line feed and carriage return at or after `at`, found once per chunk and again only once passed, so a
		// chunk of many lines is not scanned to its end for each (-1: none left in this chunk).
		let lf = -2;
		let cr = -2;
		while (at < text.length && !done) {
			if (lf !== -1 && lf < at) lf = text.indexOf("\n", at);
			if (cr !== -1 && cr < at) cr = text.indexOf("\r", at);
			const end = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
			const stop = end === -1 ? text.length : end;
			if (!lineSkipped && stop > at) {
				// Every line of a dropped event but its closing blank one is dropped at once, never held or re-read; a line
				// past the cap is dropped, and when it is data its event goes with it. The check reads the line once.
				if (frameSkipped) { lineSkipped = true; line = ""; }
				else if (line.length + (stop - at) > SSE_FRAME_CAP + 16) {
					if (`${line.slice(0, 5)}${text.slice(at, at + 5)}`.startsWith("data")) { frameSkipped = true; data = ""; }
					lineSkipped = true; line = "";
				} else line += text.slice(at, stop);
			}
			if (end === -1) break;
			if (text[end] === "\r") {
				if (end + 1 === text.length) afterCR = true;
				else if (text[end + 1] === "\n") { endLine(); at = end + 2; continue; }
			}
			endLine();
			at = end + 1;
		}
	};
	return new TransformStream({
		transform(chunk, controller) {
			if (!done) try { feed(decoder.decode(chunk, { stream: true })); } catch { done = true; }
			controller.enqueue(chunk);
		},
		// The SDK delivers an event whose stream ended without the closing blank line, so this does too.
		flush() {
			if (!done) try { feed(decoder.decode()); if (!done) { endLine(); if (!done) dispatch(); } } catch { done = true; }
		},
	});
}

export function resetFromHeaders(headers, now, maxResetMs = MAX_RESET_MS) {
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
	return candidates.length ? Math.min(Math.ceil(Math.max(...candidates)), now + maxResetMs) : null;
}

export function classifyProviderFailure(terminal, measured = null) {
	if (terminal?.stopReason !== "error" || (terminal.role !== undefined && terminal.role !== "assistant")) return null;
	// A request on an api whose fetch the observer wraps that got no HTTP answer at all (the connection, the egress
	// proxy's tunnel or a timeout failed) is no evidence about the model, whatever pi's message says of the cause.
	if (measured?.connection === true) return null;
	const text = typeof terminal.errorMessage === "string" ? terminal.errorMessage.replace(PROXY_TUNNEL_REFUSAL, "") : "";
	// Bedrock cannot take our fetch seam. Its pinned adapter supplies HTTP status in this diagnostic;
	// use only that number, never the request id or other provider text it carries.
	const diagnostic = Array.isArray(terminal.diagnostics) ? terminal.diagnostics.findLast((d) => d?.type === "bedrock_response_failure" && Number.isInteger(d.details?.status) && d.details.status >= 100 && d.details.status <= 599) : null;
	const status = measured?.status ?? diagnostic?.details.status;
	// Explicit parameter/auth errors win over any incidental quota wording in a request's diagnostics.
	if (/invalid_api_key|authentication_error|unauthorized|invalid[_ ]parameter|unsupported[_ ]parameter/.test(text.toLowerCase())) return null;
	if (status === 401 || status === 403) return null;
	if (measured?.subscriptionCode && SUBSCRIPTION_CODES.has(measured.subscriptionCode)) return { kind: "quota-exhausted", subscriptionCode: measured.subscriptionCode, subscriptionProvider: measured.subscriptionProvider, ...(Number.isSafeInteger(measured.resetAt) ? { resetAt: measured.resetAt } : {}) };
	let kind;
	if (/context_length_exceeded|maximum context length|prompt is too long|input is too long|context (?:window|length).{0,48}(?:exceed|overflow)|exceed(?:s|ed)?.{0,48}context (?:window|length)|input token count.{0,64}exceeds/i.test(text)) kind = "context-overflow";
	else if (/insufficient_quota|enforced_spend_limit_reached|quota.?exceeded|quota.?exhausted|ServiceQuotaExceededException|RESOURCE_EXHAUSTED|specified API usage limits|out of budget|billing|spend limit/i.test(text)) kind = "quota-exhausted";
	else if (status === 400 || /\b400\b/.test(text)) return null;
	// Bedrock's pinned adapter preserves these exception prefixes instead of necessarily including HTTP status.
	else if (status === 429 || /rate.?limit|too many requests|TooManyRequestsException|ThrottlingException|throttling error|\b429\b/i.test(text)) kind = measured?.resetAt ? "rate-limited" : "quota-exhausted";
	else if ((status >= 500 && status <= 599) || /overloaded|server_busy|server.?error|service.?(?:is.?)?(?:temporarily.?)?unavailable|model is at capacity|\b529\b|\b50[0234]\b/i.test(text)) kind = "overloaded";
	else return null;
	return { kind, ...(Number.isSafeInteger(measured?.resetAt) ? { resetAt: measured.resetAt } : {}), ...(measured?.status === 429 && measured?.subscriptionProvider === "anthropic" ? { subscriptionProvider: "anthropic" } : {}) };
}

/** Observe the same memoised result as pi without consuming its event iterator or changing stream identity. */
export function installProviderFailureObserver({ ModelRuntime, now = Date.now, fetch = globalThis.fetch, rootSessionId = null }) {
	const messages = new WeakMap();
	// A response this observer already reads, and the evidence objects its reader fills. A nested wrapper (a streamSimple
	// that reaches a wrapped stream with the outer wrapper's fetch) sees that response come back from the outer fetch; it
	// joins the reader instead of piping the bytes through a second one, so each byte is read once and both wrappers'
	// evidence holds the code.
	const reading = new WeakMap();
	/**
	 * The 200 event stream of an OpenAI Responses call, read on its way to pi for a closed subscription code (issue #960).
	 * The reader fills THIS call's evidence object in place, never the `measured` variable: a request pi gave up on and
	 * retried can go on streaming, and its late events must not land on the retry's evidence.
	 */
	const readSubscriptionEvents = (response, evidence) => {
		const joined = reading.get(response);
		if (joined) {
			joined.targets.add(evidence);
			if (joined.found) Object.assign(evidence, joined.found);
			return response;
		}
		if (response.status < 200 || response.status > 299 || !response.body || !/^text\/event-stream\b/i.test(response.headers?.get?.("content-type") ?? "")) return response;
		const state = { targets: new Set([evidence]), found: null };
		const reader = sseErrorReader((error) => {
			const subscription = subscriptionEvidence(error, now);
			if (!subscription) return;
			const fallback = subscription.resetAt ? null : resetFromHeaders(response.headers, now(), 32 * 86_400_000);
			state.found = { ...subscription, subscriptionProvider: "openai", ...(fallback === null ? {} : { resetAt: fallback }) };
			for (const target of state.targets) Object.assign(target, state.found);
		});
		const read = new Response(response.body.pipeThrough(reader), { status: response.status, statusText: response.statusText, headers: response.headers });
		// The SDK names the url in its debug log; a constructed Response has none of its own.
		try { Object.defineProperty(read, "url", { value: response.url }); } catch {}
		reading.set(read, state);
		return read;
	};
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
					let response;
					try {
						response = await theirs(...args);
					} catch (error) {
						measured = { connection: true };
						throw error;
					}
					const resetAt = resetFromHeaders(response.headers, now());
					const subscription = model.provider === "openai" || model.provider === "anthropic" ? await subscriptionFailureFromResponse(response, { now }) : null;
					const evidence = { status: response.status, ...(resetAt === null ? {} : { resetAt }), ...(model.provider === "anthropic" && response.status === 429 ? { subscriptionProvider: "anthropic" } : {}), ...(subscription ? { ...subscription, subscriptionProvider: model.provider } : {}), ...(subscription && !subscription.resetAt && resetFromHeaders(response.headers, now(), 32 * 86_400_000) ? { resetAt: resetFromHeaders(response.headers, now(), 32 * 86_400_000) } : {}) };
					measured = evidence;
					return model.provider === "openai" && model.api === "openai-responses" ? readSubscriptionEvents(response, evidence) : response;
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
