/** The terminal controller. Dependencies are injected so counterexamples exercise the real lifecycle without a DOM renderer. */
import { gatewayDimensions, GATEWAY_LIMITS } from "./terminal-protocol.mjs";
import { createTerminalElements } from "./pane-elements.mjs";
import { validSharing, validGeometry, validGeometryFrame } from "./frontend-contract.mjs";
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
	"window-lost": ["This browser window lost its attachment", "This exact attachment is no longer owned by this browser. Return to the console and authorize a fresh launch."],
	phone: ["Use your own terminal", "The browser disconnected because this window entered the phone layout. Return to Sandboxes and copy the command."],
	"protocol-error": ["Terminal connection refused", "An invalid terminal message ended this attachment. Nothing is replayed. Inspect the gateway before a fresh launch."],
	backpressure: ["Terminal connection could not keep up", "The bounded input or output buffer filled, so the browser disconnected. No input is replayed. Inspect the host before a fresh launch."],
	"gateway-stopped": ["Gateway stopped", "The gateway ended this attachment. Nothing is replayed. Inspect the host, then authorize a new launch."],
	"connection-lost": ["Terminal connection lost", "The browser could not keep the connection. Nothing is replayed. Return to Sandboxes and authorize a new launch."],
	"watch-disabled": ["Watching was turned off", "The driver stopped sharing this terminal. Return to the console for a fresh watch when it is available."],
	"watch-removed": ["Watching ended", "The driver removed this watch. The driver and original shell remain open."],
	"driver-ended": ["The driver disconnected", "Watching ends with its driver. The original shell may still be running; return to the console to inspect it."],
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
	const { window, document, connection, Terminal, FitAddon } = options;
	if (!terminalConnection(connection)) throw new Error("Invalid terminal admission");
	const legacy = !options.elements, watch = connection.kind === "watch";
	let elements = options.elements;
	if (!elements) {
		const made = createTerminalElements(document, { prefix: "gateway", kind: connection.kind });
		document.body.appendChild(made.root); elements = made.elements;
		// The standalone controller remains usable without a workbench. Its generic state owns refusal focus.
		for (const key of ["state", "state-title", "state-text", "theme"]) elements[key] = document.getElementById(`gateway-${key}`) ?? elements[key];
	}
	const phone = window.matchMedia(`(max-width: ${GATEWAY_LIMITS.minimumWidth - 1}px)`);
	if (phone.matches) throw new Error("A desktop window is required");
	const listeners = [], disposables = [];
	const on = (element, name, listener, capture = false) => { element.addEventListener(name, listener, capture); listeners.push(() => element.removeEventListener(name, listener, capture)); };
	let theme = ["light", "dark"].includes(connection.theme) ? connection.theme : null;
	let terminal, socket, observer, ended = false, ready = false, active = options.active ?? true, visible = options.visible ?? true, tooSmall = false, wantsFocus = false;
	let pendingBytes = 0, resizeTimer = null, readyTimer = null, lastActivityAt = -Infinity, lastFitAt = -Infinity, lastGeometry = null, geometryRevision = -1, sharingRevision = -1, sharing = null, pendingAck = null;
	let resolveReady; const whenReady = new Promise(resolve => { resolveReady = resolve; });
	const root = elements["terminal-card"];
	const state = () => { root.setAttribute("data-active", String(active)); root.setAttribute("data-visible", String(visible)); root.setAttribute("data-state", ended ? "ended" : tooSmall ? "too-small" : ready ? "ready" : "connecting"); };
	const paintTheme = () => {
		if (theme) document.documentElement.setAttribute("data-theme", theme); else document.documentElement.removeAttribute("data-theme");
		document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme ?? "light dark");
		elements.theme.textContent = theme ? `Theme: ${theme}` : "Theme: follows the system";
		if (terminal) terminal.options.theme = terminalTheme(window.getComputedStyle(document.documentElement));
	};
	paintTheme(); await document.fonts?.ready;
	if (phone.matches || options.signal?.aborted) throw new Error("Terminal admission ended");
	terminal = new Terminal({ fontFamily: window.getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace", fontSize: 14, lineHeight: 1.3, theme: terminalTheme(window.getComputedStyle(document.documentElement)), minimumContrastRatio: 4.5, screenReaderMode: true, scrollback: 1000, disableStdin: true, allowProposedApi: false, windowOptions: {}, logLevel: "off", linkHandler: { activate() {}, allowNonHttpProtocols: false } });
	const fit = watch ? null : new FitAddon(); if (fit) terminal.loadAddon(fit);
	root.hidden = false; terminal.open(elements.terminal);
	for (const number of [0, 1, 2, 8, 52]) disposables.push(terminal.parser.registerOscHandler(number, () => true));
	terminal.textarea?.setAttribute("aria-label", watch ? `Read-only output of ${connection.id} on ${connection.host}. You cannot type.` : `Terminal input for ${connection.id} on ${connection.host}. Tab moves focus; Ctrl+Shift+M restores it.`);
	elements["terminal-title"].textContent = connection.id;
	elements.identity.textContent = watch ? `${connection.host} · ${connection.driver.name} is typing · read only` : `${connection.host} · ${connection.by} · existing shell`;
	elements.idle.textContent = watch ? "Watching ends with the driver" : connection.idleMinutes ? `Idle logout after ${connection.idleMinutes} minutes without input here` : "Idle logout is disabled";
	elements.disconnect.disabled = false; elements.state.hidden = true;
	const gateFocus = () => {
		const allowed = ready && active && visible && !tooSmall && !ended && !watch;
		// disableStdin would also suppress automatic DSR replies in xterm 6. Keep parser replies alive;
		// readOnly/inert and the trusted event gates below isolate human input from inactive drivers.
		if (terminal.textarea) { terminal.textarea.readOnly = !allowed; terminal.textarea.tabIndex = allowed ? 0 : -1; }
		elements.terminal.inert = !visible || tooSmall; elements.terminal.setAttribute("aria-hidden", String(!visible || tooSmall)); state();
	};
	const finish = (reason = "connection-lost") => {
		if (ended) return; ended = true; ready = false; resolveReady(false);
		if (resizeTimer !== null) window.clearTimeout(resizeTimer); if (readyTimer !== null) window.clearTimeout(readyTimer);
		observer?.disconnect(); for (const remove of listeners.splice(0)) remove(); for (const disposable of disposables.splice(0)) disposable.dispose();
		terminal.options.disableStdin = true; terminal.reset(); terminal.dispose(); elements.terminal.replaceChildren();
		if (socket && socket.readyState < 2) socket.close(1000, "disconnected");
		elements.disconnect.disabled = true; elements.terminal.hidden = true; if (elements.small) elements.small.hidden = true; if (elements.waiting) elements.waiting.hidden = true;
		// The pill is the first thing read: it must stop saying Connected the moment this is no longer true.
		elements.connection.textContent = "Disconnected"; elements.connection.className = "badge tone-idle";
		if (elements["terminal-return"] && options.returnHref) { elements["terminal-return"].setAttribute("href", options.returnHref); elements["terminal-return"].hidden = false; }
		if (legacy) root.hidden = true;
		const words = GATEWAY_END_WORDS[reason] ?? GATEWAY_END_WORDS["connection-lost"];
		elements["state-title"].textContent = words[0]; elements["state-text"].textContent = words[1]; elements.state.hidden = false; state();
		if (active && visible) elements.state.focus(); options.onState?.(reason);
	};
	// A pane's visibility event fires before Dockview unhides the overlay that holds it, and a hidden
	// element refuses focus without an error. So "visible" cannot mean "focus landed": keep the request
	// until it has, for a bounded few frames, and never take focus back from wherever the person went.
	const landFocus = (from = document.activeElement, frames = 8) => {
		if (ended || !wantsFocus || !active || !visible || tooSmall) return;
		const target = watch ? elements.terminal : terminal.textarea;
		if (watch) { elements.terminal.tabIndex = 0; elements.terminal.focus(); } else terminal.focus();
		if (!target || document.activeElement === target) { wantsFocus = false; return; }
		if (frames <= 0 || typeof window.requestAnimationFrame !== "function") return;
		window.requestAnimationFrame(() => { if (document.activeElement === from) landFocus(from, frames - 1); else wantsFocus = false; });
	};
	const send = (message) => {
		if (ended || !ready || watch || socket?.readyState !== 1) return false;
		if (socket.bufferedAmount > WIRE_MAX) { finish("backpressure"); return false; }
		try { socket.send(JSON.stringify(message)); return true; } catch { finish("connection-lost"); return false; }
	};
	const userActivity = () => {
		if (ended || !ready || !active || !visible || tooSmall || watch) return;
		const at = window.performance.now(); if (at - lastActivityAt < 1000 / GATEWAY_LIMITS.activityPerSecond) return;
		if (send({ type: "activity" })) lastActivityAt = at;
	};
	if (!watch) {
		disposables.push(terminal.onKey(event => { if (event.domEvent.isTrusted) userActivity(); }));
		for (const type of ["paste", "compositionend"]) on(terminal.element ?? elements.terminal, type, event => {
			if (!active || !visible || tooSmall || !ready) { event.preventDefault?.(); event.stopImmediatePropagation?.(); return; }
			if (event.isTrusted) userActivity();
		}, true);
		disposables.push(terminal.onData(data => { if (!ready || ended) return; if (new TextEncoder().encode(data).byteLength > INPUT_MAX) { finish("backpressure"); return; } send({ type: "input", data }); }));
	}
	const resize = () => {
		if (resizeTimer !== null) window.clearTimeout(resizeTimer); resizeTimer = null;
		if (ended || watch || !visible) return;
		if (phone.matches || window.innerWidth < GATEWAY_LIMITS.minimumWidth) { finish("phone"); return; }
		const dimensions = fit.proposeDimensions?.() ?? { cols: terminal.cols, rows: terminal.rows };
		tooSmall = !dimensions || dimensions.cols < 40 || dimensions.rows < 10;
		if (elements.small) elements.small.hidden = !tooSmall;
		gateFocus(); if (tooSmall) { options.onNeedsSpace?.(); return; }
		lastFitAt = window.performance.now(); fit.fit(); const cols = Math.min(terminal.cols, GATEWAY_LIMITS.maxCols), rows = Math.min(terminal.rows, GATEWAY_LIMITS.maxRows);
		if (gatewayDimensions(cols, rows)) { if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows); send({ type: "resize", cols, rows, width: window.innerWidth }); }
		if (wantsFocus && active && visible && ready) landFocus();
	};
	const queueFit = () => { if (!ended && !watch && visible && resizeTimer === null) resizeTimer = window.setTimeout(resize, Math.max(0, RESIZE_DELAY_MS - (window.performance.now() - lastFitAt))); };
	const geometry = (message, frame = false) => {
		if (!watch || !(frame ? validGeometryFrame(message) : validGeometry(message)) || message.revision < geometryRevision) return false;
		lastGeometry = { cols: message.cols, rows: message.rows, revision: message.revision };
		geometryRevision = message.revision; terminal.resize(message.cols, message.rows);
		elements.identity.textContent = `${connection.host} · ${connection.driver.name} is typing · read only · ${message.cols} × ${message.rows}`;
		// The observer keeps driver cell coordinates. Only its outer viewport scrolls.
		const screen = terminal.element?.querySelector?.(".xterm-screen");
		if (screen && visible) { const rect = screen.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return true; terminal.element.style.width = `${Math.ceil(rect.width + 40)}px`; terminal.element.style.height = `${Math.ceil(rect.height + 20)}px`; }
		return true;
	};
	if (watch && !geometry(connection.geometry)) { terminal.dispose(); throw new Error("Invalid watch geometry"); }
	terminal.attachCustomKeyEventHandler(event => {
		if (watch || !active || !visible || tooSmall) return false;
		if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "m") { if (event.type === "keydown") { elements["tab-focus"].checked = !elements["tab-focus"].checked; options.onFocusMode?.(elements["tab-focus"].checked); } event.preventDefault(); return false; }
		return !(event.key === "Tab" && elements["tab-focus"].checked);
	});
	on(elements.terminal, "focusin", () => { options.onFocus?.(); });
	on(elements.disconnect, "click", () => finish("disconnected"));
	on(elements["after-terminal"], "click", () => elements["after-terminal"].focus());
	on(elements.theme, "click", () => { theme = theme === null ? "light" : theme === "light" ? "dark" : null; paintTheme(); });
	on(window.matchMedia("(prefers-color-scheme: dark)"), "change", paintTheme);
	on(phone, "change", () => { if (phone.matches) finish("phone"); });
	on(window, "pagehide", () => finish("disconnected"));
	on(window, "resize", () => { if (window.innerWidth < GATEWAY_LIMITS.minimumWidth) finish("phone"); else queueFit(); });
	if (window.ResizeObserver && !watch) { observer = new window.ResizeObserver(queueFit); observer.observe(elements.terminal); }
	const acknowledgeSharing = () => {
		if (!sharing || typeof options.onSharing !== "function" || ended) return;
		const snapshot = sharing;
		Promise.resolve(options.onSharing(snapshot)).then(rendered => {
			if (rendered !== true || ended || sharingRevision !== snapshot.revision) return;
			if (!send({ type: "sharing-seen", revision: snapshot.revision })) pendingAck = snapshot.revision;
		}).catch(() => finish("authorization-unavailable"));
	};
	const api = { connection, whenReady, refreshSharing: acknowledgeSharing, disconnect: finish, focus() { if (ended) return; wantsFocus = true; options.onFocus?.();
			if (watch) landFocus();
			else if (ready && visible && !tooSmall) { const dims = fit.proposeDimensions?.(); if (!dims || dims.cols === terminal.cols && dims.rows === terminal.rows) landFocus(); else queueFit(); }
 }, fit: queueFit, setActive(value) { active = value; if (!value) wantsFocus = false; gateFocus(); }, setVisible(value) { visible = value; gateFocus(); if (value) {
			if (watch && lastGeometry) { geometry(lastGeometry); if (wantsFocus) landFocus(); window.requestAnimationFrame?.(() => { if (!ended && visible) { terminal.refresh?.(0, terminal.rows - 1); geometry(lastGeometry); } }); }
			else queueFit();
		} }, setTheme(value) { theme = value; paintTheme(); }, setTabMovesFocus(value) { elements["tab-focus"].checked = value; }, get tabMovesFocus() { return elements["tab-focus"].checked; }, get ended() { return ended; }, get ready() { return ready; }, get sharing() { return sharing; }, get tooSmall() { return tooSmall; }, requestSharing(enabled) { return send({ type: "watch-policy", enabled }); }, removeWatcher(watcherKey) { return send({ type: "watch-remove", watcherKey }); } };
	const endpoint = new URL(`/socket/${connection.connectionId}`, window.location.origin); endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
	try { socket = new window.WebSocket(endpoint.href); } catch { finish("connection-lost"); return api; }
	readyTimer = window.setTimeout(() => finish("connection-lost"), GATEWAY_LIMITS.upgradeMs * 2); socket.binaryType = "arraybuffer";
	on(socket, "open", () => { if (phone.matches || window.innerWidth < GATEWAY_LIMITS.minimumWidth) finish("phone"); });
	on(socket, "message", ({ data }) => {
		if (ended) return;
		if (typeof data === "string") {
			if (data.length > 4096) { finish("protocol-error"); return; }
			let message; try { message = JSON.parse(data); } catch { finish("protocol-error"); return; }
			if (message?.type === "sharing") {
				if (watch || !validSharing(message) || message.revision < sharingRevision) { finish("protocol-error"); return; }
				sharingRevision = message.revision; sharing = message;
				acknowledgeSharing(); return;
			}
			if (message?.type === "geometry") { if (!geometry(message, true)) finish("protocol-error"); return; }
			if (message?.type === "ready" && Object.keys(message).join() === "type" && !ready) {
				if (phone.matches || window.innerWidth < GATEWAY_LIMITS.minimumWidth) { finish("phone"); return; }
				if (options.requireSharing && !watch && sharingRevision < 0) { finish("protocol-error"); return; }
				window.clearTimeout(readyTimer); readyTimer = null; ready = true; terminal.options.disableStdin = watch;
				elements.connection.textContent = watch ? "Watching" : "Connected"; resize(); gateFocus();
				if (pendingAck !== null) { send({ type: "sharing-seen", revision: pendingAck }); pendingAck = null; }
				if ((options.autoFocus ?? legacy) && active && visible && !watch) terminal.focus(); resolveReady(true); options.onReady?.(); return;
			}
			if (message?.type !== "ended") { finish("protocol-error"); return; } finish(message.reason); return;
		}
		if (!ready || !(data instanceof ArrayBuffer) || data.byteLength > WIRE_MAX) { finish("protocol-error"); return; }
		if (elements.waiting) elements.waiting.hidden = true;
		pendingBytes += data.byteLength; if (pendingBytes > OUTPUT_MAX) { finish("backpressure"); return; }
		terminal.write(new Uint8Array(data), () => { pendingBytes -= data.byteLength; });
	});
	on(socket, "close", () => finish("connection-lost")); on(socket, "error", () => finish("connection-lost"));
	if (options.signal) on(options.signal, "abort", () => finish("disconnected")); gateFocus(); return api;
}
