import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseDocument, Event } from "../../admin/test/helpers/script-dom.mjs";
import { gatewayAuthorizeUrl, readGatewayLaunch, startGatewayPage, GATEWAY_BROWSER_MIN_WIDTH, GATEWAY_BOOT_TIMEOUT_MS } from "../src/bootstrap.mjs";
import { GATEWAY_END_WORDS, mountGateway, terminalConnection } from "../src/browser.mjs";
import { gatewayConsoleOrigin, gatewayPage } from "../src/page.mjs";
import { gatewayDimensions, GATEWAY_LIMITS } from "../src/terminal-protocol.mjs";
import { GATEWAY_END_REASONS } from "../../worker/src/sandbox-gateway-protocol.mjs";

const I = "i".repeat(43), H = "h".repeat(43), C = "c".repeat(43);
const CONSOLE = "http://127.0.0.1:4790";
const admitted = () => ({ connectionId: C, host: "mini1", id: "gh-9575", idleMinutes: 30, by: "ops", startedAt: 1000, theme: "dark" });

test("every server end reason has fixed browser copy; connection loss is deliberately browser-local", () => {
	assert.deepEqual(Object.keys(GATEWAY_END_WORDS).filter((reason) => reason !== "connection-lost").sort(), [...GATEWAY_END_REASONS].sort());
	assert.ok(GATEWAY_END_WORDS["connection-lost"]);
});

class Target {
	listeners = new Map();
	addEventListener(type, fn) { const list = this.listeners.get(type) ?? []; list.push(fn); this.listeners.set(type, list); }
	removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((value) => value !== fn)); }
	emit(type, data = {}) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...data }); }
}

function world({ fragment = "", width = 1440 } = {}) {
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
	let response = { ok: true, status: 200, async json() { return { authorizeUrl: `${CONSOLE}/sandbox/gateway/authorize?intent=${I}` }; } };
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

test("public shell contains no session, intent, sandbox fact or inline executable resource; return origin is enrolled", () => {
	const text = gatewayPage({ consoleOrigin: CONSOLE, theme: "dark", host: "PRIVATE_HOST", intentId: I, token: "PRIVATE_TOKEN" });
	for (const secret of ["PRIVATE_HOST", "PRIVATE_TOKEN", I]) assert.equal(text.includes(secret), false);
	assert.match(text, /data-theme="dark"/); assert.match(text, /http:\/\/127\.0\.0\.1:4790\/sandbox\/gateway\/return/);
	assert.doesNotMatch(text, /<style|\sstyle=|\son[a-z]+=|<script(?! src="\/static\/gateway\.js" defer><\/script>)/);
	assert.match(text, /<noscript>.*JavaScript is required/s);
	for (const origin of ["https://a.test/", "javascript:alert(1)", "https://user:pass@a.test", "https://a.test/?x", "//a.test"]) assert.equal(gatewayConsoleOrigin(origin), null);
	assert.equal(gatewayConsoleOrigin("https://a.test"), "https://a.test");
	assert.doesNotMatch(gatewayPage({ consoleOrigin: 'https://a.test/\"><script>alert(1)</script>' }), /id="gateway-return"/);
});

test("bootstrap scrubs handoff synchronously before requests/imports; sends only its own-origin handoff exchange", async () => {
	const w = world({ fragment: `#handoff=${H}` });
	const out = await startGatewayPage(w);
	assert.equal(out.state, "authorize");
	assert.deepEqual(w.sequence, ["scrub", "fetch", "navigate"]);
	assert.equal(w.window.history.path, `/s/${I}`);
	assert.deepEqual(w.requests[0].body, { intentId: I, handoff: H });
	assert.equal(w.requests[0].url, "/api/bootstrap"); assert.equal(w.requests[0].credentials, "same-origin");
	assert.deepEqual(w.destinations, [`${CONSOLE}/sandbox/gateway/authorize?intent=${I}`]);
	assert.equal(w.document.body.textContent.includes(H), false); assert.equal(w.imports.length, 0);
	const source = readFileSync(new URL("../src/bootstrap.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(source, /^\s*import\s/m, "the fragment entry has no static imports");
});

test("malformed and duplicate fragments are scrubbed but cannot bootstrap or import terminal code", async () => {
	for (const fragment of [`#handoff=${H}&handoff=${H}`, "#handoff=bad", `#handoff=${H}&command=sh`, "#other=private"]) {
		const w = world({ fragment });
		assert.equal((await startGatewayPage(w)).state, "invalid");
		assert.deepEqual(w.sequence, ["scrub"]); assert.equal(w.requests.length, 0); assert.equal(w.imports.length, 0);
	}
	const url = { href: `http://localhost:4791/s/${I}?target=evil#handoff=${H}` };
	const history = { replaceState() { this.scrubbed = true; } };
	assert.equal(readGatewayLaunch(url, history), null); assert.equal(history.scrubbed, true);
});

test("first cookie binding is serialized across launch tabs until the previous exchange has settled", async () => {
	let tail = Promise.resolve(), firstDone;
	const locks = { request(name, options, action) {
		assert.equal(name, "pi-dispatch-sandbox-bootstrap"); assert.equal(options.mode, "exclusive");
		const next = tail.then(action); tail = next.catch(() => {}); return next;
	} };
	const first = world({ fragment: `#handoff=${H}` }), second = world({ fragment: `#handoff=${H}` });
	first.window.navigator.locks = locks; second.window.navigator.locks = locks;
	let cookie = null; const observed = [];
	first.fetch = async () => { observed.push(cookie); await new Promise((resolve) => { firstDone = resolve; }); cookie = "first-browser-cookie"; return { ok: true, json: async () => ({ authorizeUrl: `${CONSOLE}/sandbox/gateway/authorize?intent=${I}` }) }; };
	second.fetch = async () => { observed.push(cookie); return { ok: true, json: async () => ({ authorizeUrl: `${CONSOLE}/sandbox/gateway/authorize?intent=${I}` }) }; };
	const a = startGatewayPage(first), b = startGatewayPage(second);
	await Promise.resolve(); await Promise.resolve();
	assert.deepEqual(observed, [null], "the second first-visit POST cannot race the first Set-Cookie response");
	firstDone(); await Promise.all([a, b]);
	assert.deepEqual(observed, [null, "first-browser-cookie"]);
	const unsupported = world({ fragment: `#handoff=${H}` }); unsupported.window.navigator = {};
	assert.equal((await startGatewayPage(unsupported)).state, "coordination"); assert.deepEqual(unsupported.sequence, ["scrub"]); assert.equal(unsupported.imports.length, 0);
});

test("phone arrivals refuse before cookie exchange or grant redemption, including the exact breakpoint", async () => {
	assert.equal(GATEWAY_BROWSER_MIN_WIDTH, GATEWAY_LIMITS.minimumWidth);
	for (const width of [320, 375, 760]) for (const fragment of ["", `#handoff=${H}`]) {
		const w = world({ width, fragment }); assert.equal((await startGatewayPage(w)).state, "phone");
		assert.equal(w.requests.length, 0); assert.equal(w.imports.length, 0); assert.match(w.text("state-text"), /copy the command/);
	}
});

test("a lost bootstrap/connect response has a finite deadline, aborts and never imports or retries", async () => {
	for (const fragment of ["", `#handoff=${H}`]) {
		const w = world({ fragment }); let signal, count = 0;
		w.fetch = (_url, init) => { signal = init.signal; count++; return new Promise(() => {}); };
		const pending = startGatewayPage(w);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		w.advance(GATEWAY_BOOT_TIMEOUT_MS);
		assert.equal((await pending).state, "unavailable"); assert.equal(signal.aborted, true); assert.equal(count, 1); assert.equal(w.imports.length, 0);
		assert.match(w.text("state-text"), /No terminal opened/);
	}
});

test("a terminal asset that loads after its deadline cannot create a late attachment", async () => {
	const w = world(); w.response({ ok: true, json: async () => admitted() });
	let deliver, mounted = 0;
	w.importTerminal = () => new Promise((resolve) => { deliver = resolve; });
	const pending = startGatewayPage(w);
	for (let i = 0; i < 12; i++) await Promise.resolve();
	assert.equal(typeof deliver, "function"); w.advance(GATEWAY_BOOT_TIMEOUT_MS);
	assert.equal((await pending).state, "unavailable");
	deliver({ mountGateway() { mounted++; } });
	await Promise.resolve(); await Promise.resolve();
	assert.equal(mounted, 0); assert.equal(w.sockets.length, 0);
});

test("gateway callback URL is exact enrollment and public intent, never a server-provided open redirect", async () => {
	const correct = `${CONSOLE}/sandbox/gateway/authorize?intent=${I}`;
	assert.equal(gatewayAuthorizeUrl(correct, CONSOLE, I), correct);
	for (const wrong of [correct.replace("127.0.0.1", "attacker.test"), `${correct}&next=/x`, `${correct}#handoff=${H}`, correct.replace("authorize", "return"), correct.replace(I, H), "javascript:alert(1)"]) {
		assert.equal(gatewayAuthorizeUrl(wrong, CONSOLE, I), null);
		const w = world({ fragment: `#handoff=${H}` }); w.response({ ok: true, json: async () => ({ authorizeUrl: wrong }) });
		assert.equal((await startGatewayPage(w)).state, "invalid"); assert.equal(w.destinations.length, 0);
	}
});

test("connect uses cookie-bound POST and loads xterm only after successful admission; failure never retries", async () => {
	const w = world(); w.response({ ok: true, json: async () => admitted() });
	const out = await startGatewayPage(w);
	assert.equal(out.state, "terminal"); assert.deepEqual(w.sequence, ["fetch", "import"]);
	assert.deepEqual(w.requests[0].body, { intentId: I, width: 1440, cols: 80, rows: 24 });
	assert.equal(w.requests[0].url, "/api/connect"); assert.equal(w.sockets[0].url, `ws://localhost:4791/socket/${C}`);
	for (const status of [401, 403, 409, 410, 503]) {
		const fail = world(); fail.response({ ok: false, status, json: async () => ({ error: "PRIVATE_RUNTIME_ERROR" }) });
		assert.equal((await startGatewayPage(fail)).state, "refused"); assert.equal(fail.requests.length, 1); assert.equal(fail.imports.length, 0);
		assert.equal(fail.document.body.textContent.includes("PRIVATE_RUNTIME_ERROR"), false);
	}
	out.controller.disconnect();
});

test("a second attachment reports the occupied window rather than an expired grant, with no error-string reflection", async () => {
	for (const [status, error, title] of [[409, "window-busy", "Already open"], [409, "runtime-unavailable", "Sandbox runtime unavailable"], [429, "connection-limit", "The gateway is at its connection limit"]]) {
		const w = world(); w.response({ ok: false, status, json: async () => ({ error }) });
		assert.equal((await startGatewayPage(w)).state, "refused"); assert.equal(w.text("state-title"), title); assert.equal(w.imports.length, 0); assert.equal(w.requests.length, 1);
	}
});

test("terminal accepts admitted text only, disables browser escape capabilities and preserves literal shell keys", async () => {
	const w = world(); const ctl = await mountGateway({ ...w, connection: admitted() }); const term = w.terminals[0], socket = w.sockets[0];
	assert.equal(term.options.disableStdin, true); assert.equal(term.options.screenReaderMode, true); assert.equal(term.options.minimumContrastRatio, 4.5); assert.equal(term.options.logLevel, "off");
	assert.equal(term.options.linkHandler.allowNonHttpProtocols, false); assert.equal(term.options.linkHandler.activate("javascript:evil"), undefined);
	assert.deepEqual([...term.osc.keys()], [0, 1, 2, 8, 52]); for (const hook of term.osc.values()) assert.equal(hook("PRIVATE_HOSTILE_BYTES"), true);
	assert.equal(term.key({ key: "Escape" }), true); assert.equal(term.key({ key: "c", ctrlKey: true }), true);
	assert.equal(term.key({ key: "Tab" }), false); w.document.getElementById("gateway-tab-focus").checked = false; assert.equal(term.key({ key: "Tab" }), true);
	let prevented = false; assert.equal(term.key({ key: "M", ctrlKey: true, shiftKey: true, type: "keydown", preventDefault() { prevented = true; } }), false); assert.equal(prevented, true); assert.equal(w.document.getElementById("gateway-tab-focus").checked, true);
	socket.open(); term.input("PRE_READY_NEVER_SENT"); assert.equal(term.options.disableStdin, true); assert.equal(socket.sent.length, 0);
	socket.emit("message", { data: JSON.stringify({ type: "ready" }) }); assert.equal(term.options.disableStdin, false); assert.equal(w.text("connection"), "Connected");
	term.input("echo 界\u001b[D\u0003\r"); assert.deepEqual(socket.sent.at(-1), { type: "input", data: "echo 界\u001b[D\u0003\r" });
	const output = new TextEncoder().encode("\u001b[31mred\u001b[0m 界 <script>evil</script>").buffer; socket.emit("message", { data: output });
	assert.equal(term.writes[0].data.buffer, output); assert.equal(w.document.body.textContent.includes("<script>evil</script>"), false);
	assert.equal(w.document.documentElement.getAttribute("data-theme"), "dark");
	ctl.disconnect(); assert.equal(term.resetCalled, true); assert.equal(term.disposed, true); assert.equal(w.document.getElementById("gateway-terminal").children.length, 0);
});

test("resize is coalesced, sends bounded geometry and immediately disconnects a shrunk phone layout", async () => {
	const w = world(); const ctl = await mountGateway({ ...w, connection: admitted() }); const socket = w.sockets[0]; socket.ready();
	assert.deepEqual(socket.sent[0], { type: "resize", cols: 90, rows: 22, width: 1440 });
	w.window.innerWidth = 1024; for (let i = 0; i < 20; i++) w.window.emit("resize"); assert.equal(w.tasks.size, 1);
	w.flushTimers(); assert.deepEqual(socket.sent.at(-1), { type: "resize", cols: 90, rows: 22, width: 1024 });
	w.terminals[0].cols = 700; w.terminals[0].rows = 250; w.window.emit("resize"); w.flushTimers();
	assert.deepEqual(socket.sent.at(-1), { type: "resize", cols: 500, rows: 200, width: 1024 });
	assert.equal(gatewayDimensions(socket.sent.at(-1).cols, socket.sent.at(-1).rows), true, "large windows clamp the renderer and wire to the runtime's bounds");
	w.window.innerWidth = 760; w.window.emit("resize"); assert.equal(ctl.ended, true); assert.equal(socket.closed.length, 1); assert.match(w.text("state-text"), /phone layout/);
	const sent = socket.sent.length; w.terminals[0].input("NEVER_SENT"); assert.equal(socket.sent.length, sent);
});

test("late close and hostile control text cannot overwrite a fixed session-end diagnosis or retain terminal bytes", async () => {
	const w = world(); const ctl = await mountGateway({ ...w, connection: admitted() }); const socket = w.sockets[0]; socket.ready();
	socket.emit("message", { data: JSON.stringify({ type: "ended", reason: "session-ended", message: "PRIVATE_RUNTIME_TEXT" }) });
	assert.equal(ctl.ended, true); assert.equal(w.text("state-title"), GATEWAY_END_WORDS["session-ended"][0]);
	socket.emit("close"); assert.equal(w.text("state-title"), GATEWAY_END_WORDS["session-ended"][0]);
	assert.equal(w.document.body.textContent.includes("PRIVATE_RUNTIME_TEXT"), false); assert.equal(w.terminals[0].inputDisposed, true);
	assert.equal(w.document.activeElement.id, "gateway-state");
});

test("continuous desktop resizing stays inside the server's rate limit while preserving a live terminal", async () => {
	const w = world(); const ctl = await mountGateway({ ...w, connection: admitted() }); const socket = w.sockets[0]; socket.ready();
	for (let i = 0; i < 220; i++) { w.window.innerWidth = 1000 + i; w.window.emit("resize"); w.advance(10); }
	w.flushTimers();
	for (const lower of [0, 1000]) {
		const frames = socket.sentAt.filter((row) => row.message.type === "resize" && row.at >= lower && row.at < lower + 1000);
		assert.ok(frames.length <= GATEWAY_LIMITS.resizesPerSecond, `continuous drag produced ${frames.length} resize frames in a server window`);
		assert.ok(frames.length > 1, "the test actually changed the live terminal geometry");
	}
	assert.equal(ctl.ended, false); ctl.disconnect();
});

test("ready cancels an earlier observer fit instead of orphaning a second resize timer during a drag", async () => {
	const w = world(); let observed;
	w.window.ResizeObserver = class { constructor(callback) { observed = callback; } observe() {} disconnect() {} };
	const ctl = await mountGateway({ ...w, connection: admitted() }); const socket = w.sockets[0];
	observed(); w.advance(20); socket.ready();
	assert.equal(w.tasks.size, 0, "the forced admission fit cancels the pending observer fit, as well as the ready deadline");
	for (let i = 0; i < 220; i++) { w.window.innerWidth = 1000 + i; w.window.emit("resize"); w.advance(10); }
	w.flushTimers();
	for (const lower of [0, 1000]) {
		const frames = socket.sentAt.filter((row) => row.message.type === "resize" && row.at >= lower && row.at < lower + 1000);
		assert.ok(frames.length <= GATEWAY_LIMITS.resizesPerSecond, `an observer-before-ready drag produced ${frames.length} frames`);
		assert.ok(frames.length > 1);
	}
	ctl.disconnect(); assert.equal(w.tasks.size, 0);
});

test("device-query replies and synthetic DOM events cannot report human activity; real key and paste activity is bounded", async () => {
	const w = world(); const ctl = await mountGateway({ ...w, connection: admitted() }); const socket = w.sockets[0], term = w.terminals[0]; socket.ready();
	term.input("\u001b[12;40R");
	assert.deepEqual(socket.sent.at(-1), { type: "input", data: "\u001b[12;40R" }); assert.equal(socket.sent.filter((m) => m.type === "activity").length, 0);
	term.userKey({ domEvent: { isTrusted: false } });
	term.element.dispatchEvent(new Event("paste", { isTrusted: false }));
	assert.equal(socket.sent.filter((m) => m.type === "activity").length, 0);
	term.userKey({ domEvent: { isTrusted: true } }); term.input("x");
	assert.deepEqual(socket.sent.slice(-2), [{ type: "activity" }, { type: "input", data: "x" }]);
	for (let i = 0; i < 50; i++) term.userKey({ domEvent: { isTrusted: true } });
	assert.equal(socket.sent.filter((m) => m.type === "activity").length, 1);
	w.advance(500); term.element.dispatchEvent(new Event("paste", { isTrusted: true }));
	w.advance(500); term.element.dispatchEvent(new Event("compositionend", { isTrusted: true }));
	assert.equal(socket.sent.filter((m) => m.type === "activity").length, 3);
	for (const lower of [0, 500]) assert.ok(socket.sentAt.filter((row) => row.message.type === "activity" && row.at >= lower && row.at < lower + 1000).length <= GATEWAY_LIMITS.activityPerSecond);
	ctl.disconnect(); assert.equal(term.userKeyDisposed, true);
});

test("input, socket and renderer queue bounds disconnect rather than truncate/replay terminal data", async () => {
	for (const kind of ["input", "socket", "output", "invalid", "send-throws"]) {
		const w = world(); const ctl = await mountGateway({ ...w, connection: admitted() }); const socket = w.sockets[0], term = w.terminals[0]; socket.ready();
		const sent = socket.sent.length;
		if (kind === "input") term.input("界".repeat(6000));
		if (kind === "socket") { socket.bufferedAmount = 65537; term.input("never sent"); }
		if (kind === "output") { term.holdWrites = true; for (let i = 0; i < 17; i++) socket.emit("message", { data: new ArrayBuffer(65536) }); }
		if (kind === "invalid") socket.emit("message", { data: JSON.stringify({ type: "input", data: "PRIVATE" }) });
		if (kind === "send-throws") { socket.send = () => { throw new Error("PRIVATE"); }; term.input("never sent"); }
		assert.equal(ctl.ended, true, kind); assert.equal(socket.closed.length, 1, kind); assert.equal(socket.sent.length, sent, kind);
		assert.equal(w.sockets.length, 1, "a failed connection is never reconnected automatically");
	}
});

test("a premature output or duplicate ready control never enables an unaudited terminal or queues input", async () => {
	for (const duplicate of [false, true]) {
		const w = world(); const ctl = await mountGateway({ ...w, connection: admitted() }); const socket = w.sockets[0], term = w.terminals[0];
		socket.open(); term.input("NOT_QUEUED"); assert.equal(socket.sent.length, 0);
		if (duplicate) { socket.emit("message", { data: '{"type":"ready"}' }); socket.emit("message", { data: '{"type":"ready"}' }); }
		else socket.emit("message", { data: new ArrayBuffer(4) });
		assert.equal(ctl.ended, true); assert.equal(term.writes.length, 0); assert.equal(w.text("state-title"), GATEWAY_END_WORDS["protocol-error"][0]);
	}
});

test("a socket that never becomes ready times out, clears the renderer and never queues input", async () => {
	const w = world(); const ctl = await mountGateway({ ...w, connection: admitted() }); const socket = w.sockets[0], term = w.terminals[0];
	socket.open(); term.input("NOT_QUEUED"); w.advance(GATEWAY_LIMITS.upgradeMs * 2);
	assert.equal(ctl.ended, true); assert.equal(socket.sent.length, 0); assert.equal(term.resetCalled, true); assert.equal(term.disposed, true);
	assert.equal(w.text("state-title"), GATEWAY_END_WORDS["connection-lost"][0]);
});

test("invalid admission cannot instantiate a socket or renderer", async () => {
	for (const idleMinutes of [0, 1440, 1441, 999999, Number.MAX_SAFE_INTEGER]) assert.equal(terminalConnection({ ...admitted(), idleMinutes }), true);
	for (const change of [{ host: "x;sh" }, { id: "../escape" }, { by: "<script>" }, { connectionId: "bad" }, { idleMinutes: -1 }]) {
		const w = world(), connection = { ...admitted(), ...change }; assert.equal(terminalConnection(connection), false);
		await assert.rejects(mountGateway({ ...w, connection }), /Invalid terminal admission/); assert.equal(w.sockets.length, 0); assert.equal(w.terminals.length, 0);
	}
});
