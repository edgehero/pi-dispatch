import { parseDocument } from "../../../admin/test/helpers/script-dom.mjs";
import { gatewayPage } from "../../src/page.mjs";
import { mountGateway } from "../../src/browser.mjs";
const I = "i".repeat(43), CONSOLE = "http://127.0.0.1:4790";
export class Target {
	listeners = new Map();
	addEventListener(type, fn) { const list = this.listeners.get(type) ?? []; list.push(fn); this.listeners.set(type, list); }
	removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((value) => value !== fn)); }
	emit(type, data = {}) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...data }); }
}

export function world({ fragment = "", width = 1440 } = {}) {
	const sequence = [], requests = [], imports = [], destinations = [], tasks = new Map();
	let clock = 0, timerId = 0;
	const document = parseDocument(gatewayPage({ consoleOrigin: CONSOLE }));
	document.fonts = { ready: Promise.resolve() };
	const phone = new Target(); phone.matches = width <= 760;
	const colors = new Target(); colors.matches = true;
	const window = Object.assign(new Target(), {
		innerWidth: width, location: { href: `http://localhost:4791/s/${I}${fragment}`, origin: "http://localhost:4791", replace(url) { destinations.push(url); sequence.push("navigate"); } },
		AbortController,
		performance: { now: () => clock },
		history: { replaceState(_state, _title, path) { sequence.push("scrub"); this.path = path; } },
		matchMedia(query) { return query.includes("max-width") ? phone : colors; },
		navigator: { locks: { request: async (_name, _options, fn) => fn() } },
		getComputedStyle() { return { getPropertyValue(name) { return ({ "--ink": "#f3f4f2", "--surface-2": "#202121", "--font-mono": 'ui-monospace, "SF Mono", monospace' })[name] ?? ""; } }; },
		setTimeout(fn, delay = 0) { const id = ++timerId; tasks.set(id, { fn, at: clock + delay }); return id; }, clearTimeout(id) { tasks.delete(id); },
	});
	const sockets = [], terminals = [];
	class Socket extends Target {
		readyState = 0; bufferedAmount = 0; sent = []; sentAt = []; closed = [];
		constructor(url) { super(); this.url = url; sockets.push(this); }
		send(text) { const message = JSON.parse(text); this.sent.push(message); this.sentAt.push({ at: clock, message }); }
		close(code, reason) { this.closed.push({ code, reason }); this.readyState = 3; }
		open() { this.readyState = 1; this.emit("open"); }
		ready() { this.open(); this.emit("message", { data: JSON.stringify({ type: "ready" }) }); }
	}
	class Terminal {
		cols = 90; rows = 22; writes = []; osc = new Map();
		constructor(options) { this.options = options; terminals.push(this); this.parser = { registerOscHandler: (id, handler) => { this.osc.set(id, handler); return { dispose: () => this.osc.delete(id) }; } }; }
		loadAddon(addon) { this.addon = addon; }
		open(parent) { this.parent = parent; this.element = parent; this.textarea = document.createElement("textarea"); parent.appendChild(this.textarea); }
		attachCustomKeyEventHandler(handler) { this.key = handler; }
		onData(handler) { this.input = handler; return { dispose: () => { this.inputDisposed = true; } }; }
		onKey(handler) { this.userKey = handler; return { dispose: () => { this.userKeyDisposed = true; } }; }
		write(data, done) { this.writes.push({ data, done }); if (!this.holdWrites) done(); }
		focus() { this.textarea.focus(); }
		resize(cols, rows) { this.cols = cols; this.rows = rows; }
		reset() { this.resetCalled = true; }
		dispose() { this.disposed = true; }
	}
	class FitAddon { fit() { this.fits = (this.fits ?? 0) + 1; } }
	window.WebSocket = Socket;
	let response = { ok: true, status: 200, async json() { return { authorizeUrl: `${CONSOLE}/sandbox/gateway/authorize?intent=${I}`, receipt: "r".repeat(43) }; } };
	const fetch = async (url, init) => { sequence.push("fetch"); requests.push({ url, ...init, body: JSON.parse(init.body) }); return response; };
	const importTerminal = async () => { sequence.push("import"); imports.push(true); return { mountGateway: async (opts) => mountGateway({ ...opts, Terminal, FitAddon }) }; };
	const advance = (ms) => {
		const target = clock + ms;
		for (;;) {
			const next = [...tasks].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			tasks.delete(next[0]); clock = next[1].at; next[1].fn();
		}
		clock = target;
	};
	return { window, document, phone, sequence, requests, imports, destinations, sockets, terminals, Terminal, FitAddon, fetch, importTerminal, tasks, advance, response(value) { response = value; }, flushTimers() { const latest = Math.max(clock, ...[...tasks.values()].map((timer) => timer.at)); advance(latest - clock); }, text(id) { return document.getElementById(`gateway-${id}`).textContent; } };
}

