/** The terminal controller. Dependencies are injected so counterexamples exercise the real lifecycle without a DOM renderer. */
import { gatewayDimensions, GATEWAY_LIMITS } from "./terminal-protocol.mjs";
const ID = /^[A-Za-z0-9_-]{43}$/;
const INPUT_MAX = GATEWAY_LIMITS.inputBytes;
const OUTPUT_MAX = GATEWAY_LIMITS.bufferedBytes;
const WIRE_MAX = GATEWAY_LIMITS.frameBytes;
// Leave capacity for the initial geometry and browser observer events during a continuous window drag.
const RESIZE_DELAY_MS = Math.ceil(1000 / (GATEWAY_LIMITS.resizesPerSecond - 2));

export const GATEWAY_END_WORDS = Object.freeze({
	disconnected: ["Terminal disconnected", "The browser attachment ended. The original shell remains on its host. Return to Sandboxes to authorize a new browser launch."],
	idle: ["Idle logout", "The browser disconnected after its configured interval without input. Return to Sandboxes to authorize a new launch."],
	"session-ended": ["Operator session ended", "The operator session ended or its authority changed. The browser disconnected and its terminal buffer was cleared. Sign in again from the console."],
	"authorization-unavailable": ["Authorization could not be checked", "The browser disconnected because the console could not confirm its authority. Nothing is replayed. Return to Sandboxes and try a fresh launch."],
	"sandbox-ended": ["Sandbox ended", "The existing shell stopped. The gateway starts no replacement container. Inspect its workspace from Sandboxes."],
	"runtime-unavailable": ["Sandbox runtime unavailable", "The gateway could not keep the existing sandbox attachment. Nothing is replayed. Inspect the host before a fresh launch."],
	"audit-unavailable": ["Gateway audit unavailable", "The gateway could not write this attachment's audit. Nothing is replayed. Check the gateway host's audit directory before a fresh launch."],
	"window-lost": ["This browser window lost its attachment", "Only one browser terminal may attach to a sandbox at a time. Return to Sandboxes and authorize a new launch."],
	phone: ["Use your own terminal", "The browser disconnected because this window entered the phone layout. Return to Sandboxes and copy the command."],
	"protocol-error": ["Terminal connection refused", "An invalid terminal message ended this attachment. Nothing is replayed. Inspect the gateway before a fresh launch."],
	backpressure: ["Terminal connection could not keep up", "The bounded input or output buffer filled, so the browser disconnected. No input is replayed. Inspect the host before a fresh launch."],
	"gateway-stopped": ["Gateway stopped", "The gateway ended this attachment. Nothing is replayed. Inspect the host, then authorize a new launch."],
	"connection-lost": ["Terminal connection lost", "The browser could not keep the connection. Nothing is replayed. Return to Sandboxes and authorize a new launch."],
});

export function terminalTheme(style) {
	const read = (name, fallback) => style.getPropertyValue(`--${name}`).trim() || fallback;
	const foreground = read("ink", "#f3f4f2"), background = read("surface-2", "#202121");
	return {
		foreground, background, cursor: foreground, cursorAccent: background,
		selectionBackground: read("surface-3", "#2b2c2c"), selectionForeground: foreground,
		black: read("ink-muted", "#a6aca8"), red: read("failed-ink", "#ff9b9b"), green: read("ok-ink", "#86d9a4"), yellow: read("attention-ink", "#edcc8b"),
		blue: read("running-ink", "#9bbcff"), magenta: read("parked-ink", "#cfb3ff"), cyan: read("running-ink", "#9bbcff"), white: foreground,
		brightBlack: read("ink-faint", "#8e9490"), brightRed: read("failed-ink", "#ff9b9b"), brightGreen: read("ok-ink", "#86d9a4"), brightYellow: read("attention-ink", "#edcc8b"),
		brightBlue: read("running-ink", "#9bbcff"), brightMagenta: read("parked-ink", "#cfb3ff"), brightCyan: read("running-ink", "#9bbcff"), brightWhite: foreground,
	};
}

export function terminalConnection(connection) {
	return connection && ID.test(connection.connectionId ?? "") && typeof connection.host === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(connection.host) && typeof connection.id === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(connection.id) && typeof connection.by === "string" && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(connection.by) && Number.isSafeInteger(connection.idleMinutes) && connection.idleMinutes >= 0;
}

export async function mountGateway(options = {}) {
	const window = options.window, document = options.document, connection = options.connection, Terminal = options.Terminal, FitAddon = options.FitAddon;
	if (!terminalConnection(connection)) throw new Error("Invalid terminal admission");
	const phone = window.matchMedia(`(max-width: ${GATEWAY_LIMITS.minimumWidth - 1}px)`);
	if (phone.matches) throw new Error("A desktop window is required");
	const elements = Object.fromEntries(["state", "state-title", "state-text", "terminal-card", "terminal-title", "identity", "connection", "terminal", "tab-focus", "disconnect", "after-terminal", "idle", "theme"].map((name) => [name, document.getElementById(`gateway-${name}`)]));
	if (Object.values(elements).some((element) => !element)) throw new Error("Incomplete terminal shell");
	const listeners = [], disposables = [];
	const on = (element, name, listener, capture = false) => { element.addEventListener(name, listener, capture); listeners.push(() => element.removeEventListener(name, listener, capture)); };
	let theme = ["light", "dark"].includes(connection.theme) ? connection.theme : null;
	let terminal, socket, observer, ended = false, ready = false, pendingBytes = 0, resizeTimer = null, readyTimer = null, lastActivityAt = -Infinity;
	const paintTheme = () => {
		if (theme) document.documentElement.setAttribute("data-theme", theme); else document.documentElement.removeAttribute("data-theme");
		const meta = document.querySelector('meta[name="color-scheme"]');
		meta?.setAttribute("content", theme ?? "light dark");
		elements.theme.textContent = theme ? `Theme: ${theme}` : "Theme: follows the system";
		if (terminal) terminal.options.theme = terminalTheme(window.getComputedStyle(document.documentElement));
	};
	paintTheme();
	await document.fonts?.ready;
	if (phone.matches) throw new Error("A desktop window is required");
	const style = window.getComputedStyle(document.documentElement);
	terminal = new Terminal({
		fontFamily: style.getPropertyValue("--font-mono").trim() || "monospace", fontSize: 14, lineHeight: 1.3,
		theme: terminalTheme(style), minimumContrastRatio: 4.5, screenReaderMode: true, scrollback: 1000,
		disableStdin: true, allowProposedApi: false, windowOptions: {}, logLevel: "off",
		linkHandler: { activate() {}, allowNonHttpProtocols: false },
	});
	const fit = new FitAddon(); terminal.loadAddon(fit);
	elements["terminal-card"].hidden = false;
	terminal.open(elements.terminal);
	// These are public, stable parser hooks at xterm 6.0.0. Terminal bytes never gain browser capabilities.
	for (const number of [0, 1, 2, 8, 52]) disposables.push(terminal.parser.registerOscHandler(number, () => true));
	terminal.textarea?.setAttribute("aria-label", "Sandbox terminal input. Tab moves focus unless its checkbox is turned off; Ctrl+Shift+M restores it.");
	elements["terminal-title"].textContent = connection.id;
	elements.identity.textContent = `${connection.host} · ${connection.by} · existing sandbox shell`;
	elements.idle.textContent = connection.idleMinutes ? `Idle logout after ${connection.idleMinutes} ${connection.idleMinutes === 1 ? "minute" : "minutes"} without input here` : "Idle logout is disabled on this host";
	elements.theme.hidden = false;
	elements.disconnect.disabled = false;
	elements.state.hidden = true;
	const finish = (reason = "connection-lost") => {
		if (ended) return;
		ended = true;
		ready = false;
		if (resizeTimer !== null) window.clearTimeout(resizeTimer);
		if (readyTimer !== null) window.clearTimeout(readyTimer);
		observer?.disconnect();
		for (const remove of listeners.splice(0)) remove();
		for (const disposable of disposables.splice(0)) disposable.dispose();
		terminal.options.disableStdin = true;
		terminal.reset(); terminal.dispose(); elements.terminal.replaceChildren();
		if (socket && socket.readyState < 2) socket.close(1000, "disconnected");
		elements["terminal-card"].hidden = true;
		elements.disconnect.disabled = true;
		const words = GATEWAY_END_WORDS[reason] ?? GATEWAY_END_WORDS["connection-lost"];
		elements["state-title"].textContent = words[0]; elements["state-text"].textContent = words[1];
		elements.state.hidden = false;
		elements.state.focus();
	};
	const send = (message) => {
		if (ended || !ready || socket?.readyState !== 1) return false;
		if (socket.bufferedAmount > WIRE_MAX) { finish("backpressure"); return false; }
		try { socket.send(JSON.stringify(message)); return true; }
		catch { finish("connection-lost"); return false; }
	};
	const userActivity = () => {
		if (ended || !ready) return;
		const at = window.performance.now();
		if (at - lastActivityAt < 1000 / GATEWAY_LIMITS.activityPerSecond) return;
		if (send({ type: "activity" })) lastActivityAt = at;
	};
	// xterm.onData includes automatic device-query replies. Only trusted human events grant idle
	// activity; terminal output cannot synthesize these events or keep an unattended shell attached.
	disposables.push(terminal.onKey((event) => { if (event.domEvent.isTrusted) userActivity(); }));
	for (const type of ["paste", "compositionend"]) on(terminal.element ?? elements.terminal, type, (event) => { if (event.isTrusted) userActivity(); }, true);
	const resize = () => {
		// Admission can force a fit before an observer's queued fit fires. Cancel that timer
		// before forgetting its handle, or subsequent drag events create parallel resize loops.
		if (resizeTimer !== null) window.clearTimeout(resizeTimer);
		resizeTimer = null;
		if (ended) return;
		if (phone.matches || window.innerWidth < GATEWAY_LIMITS.minimumWidth) { finish("phone"); return; }
		fit.fit();
		const cols = Math.min(terminal.cols, GATEWAY_LIMITS.maxCols), rows = Math.min(terminal.rows, GATEWAY_LIMITS.maxRows);
		if (gatewayDimensions(cols, rows)) {
			if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
			send({ type: "resize", cols, rows, width: window.innerWidth });
		}
	};
	terminal.attachCustomKeyEventHandler((event) => {
		if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "m") {
			if (event.type === "keydown") elements["tab-focus"].checked = !elements["tab-focus"].checked;
			event.preventDefault(); return false;
		}
		return !(event.key === "Tab" && elements["tab-focus"].checked);
	});
	on(elements.disconnect, "click", () => finish("disconnected"));
	on(elements["after-terminal"], "click", () => elements["after-terminal"].focus());
	on(elements.theme, "click", () => { theme = theme === null ? "light" : theme === "light" ? "dark" : null; paintTheme(); });
	const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
	on(systemTheme, "change", paintTheme);
	on(phone, "change", () => { if (phone.matches) finish("phone"); });
	on(window, "pagehide", () => finish("disconnected"));
	on(window, "resize", () => { if (window.innerWidth < GATEWAY_LIMITS.minimumWidth) finish("phone"); else if (resizeTimer === null) resizeTimer = window.setTimeout(resize, RESIZE_DELAY_MS); });
	if (window.ResizeObserver) {
		observer = new window.ResizeObserver(() => { if (!ended && resizeTimer === null) resizeTimer = window.setTimeout(resize, RESIZE_DELAY_MS); });
		observer.observe(elements.terminal);
	}
	const endpoint = new URL(`/socket/${connection.connectionId}`, window.location.origin);
	endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
	try { socket = new window.WebSocket(endpoint.href); }
	catch { finish("connection-lost"); return { disconnect: finish, get ended() { return ended; } }; }
	readyTimer = window.setTimeout(() => finish("connection-lost"), GATEWAY_LIMITS.upgradeMs * 2);
	socket.binaryType = "arraybuffer";
	on(socket, "open", () => {
		if (ended) return;
		if (phone.matches || window.innerWidth < GATEWAY_LIMITS.minimumWidth) { finish("phone"); return; }
		// An upgraded socket is not yet an audited, authorized runtime attachment. No input waits here.
	});
	disposables.push(terminal.onData((data) => {
		if (ended || !ready) return;
		if (new TextEncoder().encode(data).byteLength > INPUT_MAX) { finish("backpressure"); return; }
		send({ type: "input", data });
	}));
	on(socket, "message", ({ data }) => {
		if (ended) return;
		if (typeof data === "string") {
			if (data.length > 4096) { finish("protocol-error"); return; }
			let message; try { message = JSON.parse(data); } catch { finish("protocol-error"); return; }
			if (message?.type === "ready" && Object.keys(message).join() === "type" && !ready) {
				if (phone.matches || window.innerWidth < GATEWAY_LIMITS.minimumWidth) { finish("phone"); return; }
				window.clearTimeout(readyTimer); readyTimer = null;
				ready = true; elements.connection.textContent = "Connected"; terminal.options.disableStdin = false;
				resize(); terminal.focus(); return;
			}
			if (message?.type !== "ended") { finish("protocol-error"); return; }
			finish(message.reason); return;
		}
		if (!ready || !(data instanceof ArrayBuffer) || data.byteLength > WIRE_MAX) { finish("protocol-error"); return; }
		pendingBytes += data.byteLength;
		if (pendingBytes > OUTPUT_MAX) { finish("backpressure"); return; }
		terminal.write(new Uint8Array(data), () => { pendingBytes -= data.byteLength; });
	});
	on(socket, "close", () => finish("connection-lost"));
	on(socket, "error", () => finish("connection-lost"));
	return { disconnect: finish, get ended() { return ended; } };
}
