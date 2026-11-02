/** No imports: the handoff fragment must disappear before loading terminal code or making a request. */
const PUBLIC_ID = /^[A-Za-z0-9_-]{43}$/;
// Kept import-free for fragment removal; a behavior test pins this to the shared transport bounds.
export const GATEWAY_BROWSER_MIN_WIDTH = 761;
export const GATEWAY_BOOT_TIMEOUT_MS = 10000;

export const GATEWAY_BOOT_WORDS = Object.freeze({
	phone: ["Use your own terminal", "Browser terminals require a window wider than 760 pixels. Return to Sandboxes and copy the command."],
	invalid: ["This launch is not usable", "Return to Sandboxes and start a new browser launch. A public request id alone cannot open a terminal."],
	unavailable: ["The gateway could not authorize this launch", "No terminal opened. Return to Sandboxes, check the gateway and sign in again for a new launch."],
	expired: ["This launch has ended", "The one-use authorization expired or was already used. Return to Sandboxes and start a new browser launch."],
	loading: ["Opening the terminal", "Authorization was accepted. The terminal connects only to this gateway."],
	coordination: ["Use your own terminal", "This browser cannot coordinate secure gateway launches. Return to Sandboxes and use Open in Terminal or copy the command."],
	busy: ["Already open", "One browser terminal already owns this sandbox attachment. Use its existing tab, or disconnect it before authorizing a fresh launch."],
	runtime: ["Sandbox runtime unavailable", "The gateway could not verify this existing shell. Inspect its host before authorizing a fresh launch. No container was started."],
	limited: ["The gateway is at its connection limit", "No terminal opened. Disconnect an existing browser attachment or wait, then start a fresh launch from Sandboxes."],
});

/** Scrub even a malformed fragment, before any DOM read, fetch or dynamic import. */
export function readGatewayLaunch(location, history) {
	const url = new URL(location.href);
	const fragment = url.hash;
	if (fragment) history.replaceState(null, "", `${url.pathname}${url.search}`);
	const match = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
	if (!match || url.search) return null;
	const values = new URLSearchParams(fragment.slice(1));
	if ([...values.keys()].some((key) => key !== "handoff") || values.getAll("handoff").length > 1) return null;
	const handoff = values.get("handoff");
	if (fragment && (!handoff || !PUBLIC_ID.test(handoff))) return null;
	return { intentId: match[1], handoff };
}

export function gatewayAuthorizeUrl(raw, consoleOrigin, intentId) {
	try {
		const url = new URL(raw);
		return url.origin === consoleOrigin && !url.username && !url.password && url.pathname === "/sandbox/gateway/authorize" && !url.hash && url.search === `?intent=${intentId}` ? url.href : null;
	} catch { return null; }
}

/** Only known closed reasons select copy; never display a runtime or response error string. */
export function gatewayBootRefusal(status, reason) {
	if (reason === "window-busy") return "busy";
	if (reason === "runtime-unavailable" || reason === "runtime-environment") return "runtime";
	if (status === 429) return "limited";
	return status === 409 || status === 410 ? "expired" : "unavailable";
}

async function boundedGatewayCall(window, action) {
	const controller = new window.AbortController();
	let timer;
	try {
		return await Promise.race([action(controller.signal), new Promise((_, reject) => {
			timer = window.setTimeout(() => { controller.abort(); reject(new Error("gateway-request-timeout")); }, GATEWAY_BOOT_TIMEOUT_MS);
		})]);
	} finally { window.clearTimeout(timer); }
}

async function requestGateway(fetch, path, body, signal) {
	const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
	let data; try { data = await response.json(); } catch { data = null; }
	return { ok: response.ok, status: response.status, data };
}

export async function startGatewayPage(options = {}) {
	const window = options.window, document = options.document, fetch = options.fetch;
	const importTerminal = options.importTerminal ?? (() => import("/static/terminal.js"));
	const launch = readGatewayLaunch(window.location, window.history);
	const say = (key) => {
		const words = GATEWAY_BOOT_WORDS[key] ?? GATEWAY_BOOT_WORDS.unavailable;
		document.getElementById("gateway-state-title").textContent = words[0];
		document.getElementById("gateway-state-text").textContent = words[1];
	};
	if (!launch) { say("invalid"); return { state: "invalid" }; }
	if (window.matchMedia(`(max-width: ${GATEWAY_BROWSER_MIN_WIDTH - 1}px)`).matches) { say("phone"); return { state: "phone" }; }
	const consoleOrigin = document.querySelector('meta[name="gateway-console-origin"]')?.getAttribute("content");
	try {
		if (launch.handoff) {
			if (typeof window.navigator?.locks?.request !== "function") { say("coordination"); return { state: "coordination" }; }
			// First launches in separate tabs may both arrive without a browser cookie. The browser's
			// origin-owned lock keeps a later response from overwriting an earlier intent's cookie.
			const exchange = await boundedGatewayCall(window, (signal) => window.navigator.locks.request("pi-dispatch-sandbox-bootstrap", { mode: "exclusive", signal }, () => requestGateway(fetch, "/api/bootstrap", launch, signal)));
			if (!exchange.ok) { say(gatewayBootRefusal(exchange.status, exchange.data?.error)); return { state: "refused" }; }
			const result = exchange.data;
			const destination = gatewayAuthorizeUrl(result.authorizeUrl, consoleOrigin, launch.intentId);
			if (!destination) { say("invalid"); return { state: "invalid" }; }
			window.location.replace(destination);
			return { state: "authorize" };
		}
		const response = await boundedGatewayCall(window, (signal) => requestGateway(fetch, "/api/connect", { intentId: launch.intentId, width: window.innerWidth, cols: 80, rows: 24 }, signal));
		if (!response.ok) { say(gatewayBootRefusal(response.status, response.data?.error)); return { state: "refused" }; }
		const connection = response.data;
		if (!PUBLIC_ID.test(connection.connectionId ?? "")) { say("invalid"); return { state: "invalid" }; }
		if (window.matchMedia(`(max-width: ${GATEWAY_BROWSER_MIN_WIDTH - 1}px)`).matches) { say("phone"); return { state: "phone" }; }
		say("loading");
		const terminal = await boundedGatewayCall(window, () => importTerminal());
		return { state: "terminal", controller: await terminal.mountGateway({ window, document, connection }) };
	} catch {
		say("unavailable");
		return { state: "unavailable" };
	}
}

if (typeof window !== "undefined" && typeof document !== "undefined") void startGatewayPage({ window, document, fetch: window.fetch.bind(window) });
