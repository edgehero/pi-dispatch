import assert from "node:assert/strict";
import { request } from "node:http";
import { connect as connectSocket } from "node:net";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket from "ws";
import { gatewayHash, gatewayRandom, GATEWAY_PENDING_MS, GATEWAY_GRANT_MS } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";
import { GATEWAY_LIMITS } from "../src/terminal-protocol.mjs";
import { createGatewayServer } from "../src/server.mjs";

const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, { kind = "drive", secure = false, now = () => 0, inspect = async () => ({ ok: true }), redeem = null, renewAttachment = null, audit = async () => {}, attach = async () => ({ stream: new PassThrough(), resize: async () => {}, detach() { this.stream.destroy(); } }) } = {}) {
	const intentId = gatewayRandom(), cookie = gatewayRandom(), audits = [], calls = [];
	const intent = { intentId, kind: "drive", sessionKey: gatewayHash("session"), runFacts: null, target: { host: "host-a", id: "run-a", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" }, gatewayOrigin: "http://gateway.localhost", consoleOrigin: "http://console.localhost", browserHash: gatewayHash(cookie), actor: { name: "ops", role: "operator", session: "a".repeat(12) }, connectedAt: 123, theme: "dark" };
	intent.kind = kind;
	if (secure) { intent.gatewayOrigin = "https://gateway.example"; intent.consoleOrigin = "https://console.example"; }
	const cookieKey = secure ? "__Host-pdg_browser" : "pdg_browser", hostname = new URL(intent.gatewayOrigin).host;
	const room = { driverConnectionId: gatewayRandom(), driverActor: { name: "driver", role: "operator", session: "b".repeat(12) }, enabled: false, epoch: gatewayRandom(), rosterRevision: 0, watchers: {}, geometry: { cols: 80, rows: 24, revision: 1 } };
	if (kind === "watch") intent.driver = { intentId: gatewayRandom(), connectionId: room.driverConnectionId, epoch: room.epoch };
	const store = { startDriver: async args => { room.driverConnectionId = args.connectionId; return { ok: true, intent, room, authRemainingMs: 5000 }; }, readyWatch: async () => ({ ok: true, intent, room, authRemainingMs: 5000 }), readRoom: async () => room, readIntent: async () => intent, bindIntent: async args => { calls.push(["bind", args]); return { ok: true, intent }; }, redeem: async args => { calls.push(["redeem", args]); return redeem ? redeem(args) : { ok: true, intent }; }, renewAttachment: async (...args) => renewAttachment ? renewAttachment(...args) : ({ ok: true, intent, room, authRemainingMs: 5000, ...(kind === "watch" ? { rosterSeen: true } : {}) }), release: async args => { calls.push(["release", args]); return { ok: true }; } };
	const runtime = { inspect: async target => { calls.push(["inspect", target]); return inspect(target); }, attach: async (...args) => { calls.push(["attach", ...args]); return attach(...args); }, attachWatch: async (...args) => { calls.push(["attachWatch", ...args]); return attach(...args); } };
	const app = createGatewayServer({ config: { origin: intent.gatewayOrigin, consoleOrigin: intent.consoleOrigin, host: "host-a", sockets: { local: "/fixed.sock" }, idleMinutes: 30 }, store, runtime, assets: { script: "", terminalScript: "", css: "" }, audit: async (...args) => { audits.push(args); await audit(...args); }, now });
	await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve)); const port = app.server.address().port;
	t.after(() => app.close());
	async function api(path, data, headers = {}) {
		return new Promise((resolve, reject) => {
			const body = data === undefined ? null : JSON.stringify(data);
			const req = request({ hostname: "127.0.0.1", port, path, method: body ? "POST" : "GET", headers: { host: hostname, origin: intent.gatewayOrigin, ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}), cookie: `${cookieKey}=${cookie}`, ...headers } }, res => { const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => { const text = Buffer.concat(chunks).toString(); let value; try { value = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: value, text }); }); }); req.on("error", reject); req.end(body);
		});
	}
	const connect = () => api("/api/connect", { intentId, sessionKey: null, width: 1200, cols: 80, rows: 24 });
	const socket = (connectionId, headers = {}) => new WebSocket(`ws://127.0.0.1:${port}/socket/${connectionId}`, { origin: intent.gatewayOrigin, headers: { host: hostname, cookie: `${cookieKey}=${cookie}`, ...headers } });
	return { app, api, connect, socket, calls, audits, intentId, intent, cookie, port, room, store, runtime };
}

test("generic landing never rotates Strict cookies or discloses authority; direct phone/cross-origin/duplicate-cookie cannot redeem", async t => {
	const f = await fixture(t);
	const page = await f.api(`/s/${f.intentId}`, undefined, { cookie: "" });
	assert.equal(page.status, 200); assert.equal(page.headers["set-cookie"], undefined); assert.doesNotMatch(page.text, new RegExp(f.cookie)); assert.match(page.headers["content-security-policy"], /script-src 'self'/);
	const phone = await f.api("/api/connect", { intentId: f.intentId, sessionKey: null, width: 760, cols: 80, rows: 24 }); assert.equal(phone.status, 400);
	assert.equal((await f.api("/api/connect", { intentId: f.intentId, sessionKey: null, width: 1200, cols: 80, rows: 24 }, { origin: "https://hostile.example" })).status, 403);
	assert.equal((await f.api("/api/connect", { intentId: f.intentId, sessionKey: null, width: 1200, cols: 80, rows: 24 }, { cookie: `pdg_browser=${f.cookie}; pdg_browser=${gatewayRandom()}` })).status, 403);
	assert.equal(f.calls.length, 0, "all free refusals precede runtime/control work");
});
test("a successful bootstrap refreshes a nearly expired browser nonce without rotating its binding", async t => {
	const f = await fixture(t), response = await f.api("/api/bootstrap", { intentId: f.intentId, handoff: gatewayRandom() });
	assert.equal(response.status, 200); assert.match(response.headers["set-cookie"][0], new RegExp(`pdg_browser=${f.cookie};`));
	const maxAge = Number(/Max-Age=([0-9]+)/.exec(response.headers["set-cookie"][0])?.[1]);
	assert.equal(maxAge, Math.ceil((GATEWAY_PENDING_MS + GATEWAY_GRANT_MS + GATEWAY_LIMITS.upgradeMs) / 1000));
	assert.equal(f.calls.find(c => c[0] === "bind")[1].browserHash, gatewayHash(f.cookie));
});
test("unapproved, expired and replayed grants refuse before any runtime observation; a failed observation consumes and releases", async t => {
	// The fake store refuses as the real one does; which state makes it refuse is held against live Valkey in the worker's integration tests.
	const unavailable = await fixture(t, { redeem: async () => ({ refused: "grant-unavailable" }) });
	assert.equal((await unavailable.connect()).status, 409); assert.equal(unavailable.calls.some(c => c[0] === "inspect" || c[0] === "attach"), false);
	const bad = await fixture(t, { inspect: async () => ({ refused: "runtime-unavailable" }) });
	assert.equal((await bad.connect()).status, 409);
	assert.deepEqual(bad.calls.map(c => c[0]), ["redeem", "inspect", "release"]);
});

test("connection reservations bound concurrent deferred reads, including the upgrade-to-attachment gap", async t => {
	const gate = defer(), entered = defer(); let inspections = 0;
	const f = await fixture(t, { inspect: async () => { if (++inspections === 32) entered.resolve(); await gate.promise; return { ok: true }; } });
	const requests = Array.from({ length: 32 }, () => f.connect());
	await entered.promise;
	assert.equal((await f.connect()).status, 429); assert.equal(inspections, 32);
	gate.resolve(); const results = await Promise.all(requests); assert.ok(results.every(r => r.status === 200));
});

test("a deferred runtime attach keeps its reserved slot and successful open follows actual runtime success", async t => {
	const attachGate = defer(), entered = defer();
	const f = await fixture(t, { attach: async () => { entered.resolve(); await attachGate.promise; return { stream: new PassThrough(), resize: async () => {}, detach() { this.stream.destroy(); } }; } });
	const first = await f.connect(); const ws = f.socket(first.body.connectionId); ws.on("error", () => {});
	const ready = new Promise(resolve => ws.on("message", data => { if (String(data) === '{"type":"ready"}') resolve(); }));
	await entered.promise;
	assert.deepEqual(f.audits.map(a => a[0]), ["opening"], "a pending attach is not audited as opened");
	const extra = await Promise.all(Array.from({ length: 32 }, () => f.connect()));
	assert.equal(extra.filter(r => r.status === 200).length, 31); assert.equal(extra.filter(r => r.status === 429).length, 1);
	attachGate.resolve(); await ready;
	assert.deepEqual(f.audits.slice(0, 2).map(a => a[0]), ["opening", "open"]);
	ws.close(); await once(ws, "close");
});

test("a terminal whose attach used up most of its lease stays open: the first renewal comes before that lease lapses", async t => {
	let renews = 0, f;
	// A slow runtime: the upgrade's authority has 900 ms left by the time the terminal is ready, and the console is healthy.
	f = await fixture(t, { now: () => performance.now(), renewAttachment: async () => { renews++; return { ok: true, intent: f.intent, room: f.room, authRemainingMs: renews === 1 ? 900 : 5000, rosterSeen: true }; } });
	const ws = f.socket((await f.connect()).body.connectionId), frames = [];
	const ready = new Promise(resolve => ws.on("message", data => { const text = String(data); if (text.startsWith("{")) frames.push(JSON.parse(text)); if (text === '{"type":"ready"}') resolve(); }));
	await ready;
	await new Promise(resolve => setTimeout(resolve, 1300));
	assert.deepEqual(frames.filter(m => m.type === "ended"), [], "no 'could not confirm its authority' on a healthy terminal");
	assert.equal(ws.readyState, WebSocket.OPEN);
	assert.ok(renews >= 2, "and the lease was carried by asking the store, not by assuming");
	ws.close(); await once(ws, "close");
});
test("a failed runtime attach writes compensation but never a successful opening or terminal stream", async t => {
	const f = await fixture(t, { attach: async () => { throw new Error("PRIVATE_RUNTIME_ERROR"); } });
	const first = await f.connect(), ws = f.socket(first.body.connectionId); ws.on("error", () => {}); await new Promise(resolve => ws.once("close", resolve));
	assert.deepEqual(f.audits.map(a => a[0]), ["opening", "end"]); assert.doesNotMatch(JSON.stringify(f.audits), /PRIVATE_RUNTIME_ERROR/);
});
test("audit failure refuses before runtime attachment or before enabling input, with an actionable diagnosis", async t => {
	for (const failure of ["opening", "open"]) {
		const f = await fixture(t, { audit: async kind => { if (kind === failure) throw new Error("private audit path"); } });
		const connected = await f.connect(), ws = f.socket(connected.body.connectionId), controls = [];
		ws.on("error", () => {}); ws.on("message", b => { controls.push(JSON.parse(String(b))); });
		await new Promise(resolve => ws.once("close", resolve));
		assert.deepEqual(controls, [{ type: "ended", reason: "audit-unavailable" }]);
		assert.equal(f.calls.filter(c => c[0] === "attach").length, failure === "opening" ? 0 : 1);
		assert.equal(f.audits.at(-1)[3], "audit-unavailable");
		assert.equal(f.calls.some(c => c[0] === "release"), true);
	}
});

test("malformed maintained-library handshakes never attach and cannot exhaust reservations", async t => {
	const f = await fixture(t);
	for (let n = 0; n < 40; n++) {
		const response = await f.connect(); assert.equal(response.status, 200);
		await new Promise((resolve, reject) => {
			const socket = connectSocket(f.port, "127.0.0.1", () => socket.write(`GET /socket/${response.body.connectionId} HTTP/1.1\r\nHost: gateway.localhost\r\nOrigin: http://gateway.localhost\r\nCookie: pdg_browser=${f.cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${n % 2 ? "dGhlIHNhbXBsZSBub25jZQ==" : "invalid"}\r\nSec-WebSocket-Version: ${n % 2 ? "999" : "13"}\r\n\r\n`));
			socket.on("data", () => {}); socket.once("close", resolve); socket.once("error", reject); socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("malformed handshake did not end")); });
		});
	}
	assert.equal(f.calls.filter(c => c[0] === "attach").length, 0); assert.deepEqual(f.audits, []);
	assert.equal((await f.connect()).status, 200);
});

test("browser loss during deferred attach releases its slot and detaches a late completion", async t => {
	const gate = defer(), entered = defer(); let detached = 0;
	const f = await fixture(t, { attach: async () => { entered.resolve(); await gate.promise; return { stream: new PassThrough(), resize: async () => {}, detach: () => { detached++; } }; } });
	const first = await f.connect(), ws = f.socket(first.body.connectionId); ws.on("error", () => {});
	await entered.promise; if (ws.readyState !== WebSocket.OPEN) await once(ws, "open"); ws.close(); await once(ws, "close"); gate.resolve();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(detached, 1); assert.equal(f.audits.some(a => a[0] === "open"), false);
});

test("a workbench session mismatch refuses before redemption and runtime, while authenticated duplicate projections identify only the exact winner", async t => {
	const f = await fixture(t);
	const mismatch = await f.api("/api/connect", { intentId: f.intentId, sessionKey: gatewayHash("other-session"), width: 1200, cols: 80, rows: 24 });
	assert.deepEqual(mismatch.body, { error: "workbench-session-changed" }); assert.deepEqual(f.calls, []);
	const winnerConnectionId = gatewayRandom();
	const busy = await fixture(t, { kind: "watch", redeem: async () => ({ refused: "window-busy", winnerConnectionId }) });
	const response = await busy.connect();
	assert.equal(response.status, 409);
	assert.deepEqual(response.body, { error: "window-busy", kind: "watch", targetKey: gatewayHash(JSON.stringify(["host-a", "local", "b".repeat(64), "a".repeat(32)])), ownerKey: gatewayHash(winnerConnectionId), host: "host-a", id: "run-a" });
	assert.equal(busy.calls.some(c => c[0] === "inspect"), false);
	assert.doesNotMatch(JSON.stringify(response.body), new RegExp(`${winnerConnectionId}|${busy.intent.sessionKey}|${busy.intent.driver.epoch}|${"a".repeat(32)}`));
	const unauth = await fixture(t, { redeem: async () => ({ refused: "grant-unavailable", winnerConnectionId }) });
	assert.deepEqual((await unauth.connect()).body, { error: "grant-unavailable" });
});

test("watch admission cannot attach before the driver roster acknowledgement, uses only the readonly runtime, and sends driver geometry before ready", async t => {
	const gate = defer(), pollEntered = defer(); let renews = 0, f;
	f = await fixture(t, { kind: "watch", renewAttachment: async () => {
		if (++renews > 1) { pollEntered.resolve(); await gate.promise; }
		return { ok: true, intent: f.intent, room: f.room, authRemainingMs: 5000, rosterSeen: renews > 1 };
	} });
	const connected = await f.connect();
	assert.equal(connected.body.kind, "watch"); assert.deepEqual(connected.body.driver, { name: "driver", ownerKey: gatewayHash(f.room.driverConnectionId) });
	assert.equal(connected.body.ownerKey, gatewayHash(connected.body.connectionId)); assert.equal(connected.body.sessionKey, f.intent.sessionKey);
	assert.equal(connected.body.runFacts, null);
	const ws = f.socket(connected.body.connectionId), frames = []; ws.on("error", () => {});
	const ready = new Promise(resolve => ws.on("message", b => { const m = JSON.parse(String(b)); frames.push(m); if (m.type === "ready") resolve(); }));
	await pollEntered.promise;
	assert.equal(f.calls.some(c => c[0] === "attachWatch" || c[0] === "attach"), false);
	assert.deepEqual(f.audits, [], "no applied or opening attach is claimed before the roster acknowledgement");
	gate.resolve(); await ready;
	assert.deepEqual(f.calls.filter(c => c[0].startsWith("attach")).map(c => c[0]), ["attachWatch"]);
	assert.deepEqual(frames.slice(0, 2), [{ type: "geometry", cols: 80, rows: 24, revision: 1 }, { type: "ready" }]);
	assert.deepEqual(f.audits.slice(0, 2).map(a => [a[0], a[1].driverActor]), [["opening", f.room.driverActor], ["open", f.room.driverActor]]);
	ws.close(); await once(ws, "close");
});

test("consent or a driver that changed before redemption refuses the watch before any runtime call", async t => {
	for (const change of [room => { room.epoch = gatewayRandom(); }, room => { room.driverConnectionId = gatewayRandom(); }]) {
		const f = await fixture(t, { kind: "watch" });
		change(f.room);
		const refused = await f.connect();
		assert.equal(refused.status, 409); assert.equal(JSON.parse(refused.text).error, "driver-ended");
		assert.equal(f.calls.some(([name]) => ["inspect", "attach", "attachWatch"].includes(name)), false);
	}
});

test("a watch waiting for its roster polls the store at most once per second", async t => {
	let renews = 0, f;
	f = await fixture(t, { kind: "watch", renewAttachment: async () => { renews++; return { ok: true, intent: f.intent, room: f.room, authRemainingMs: 5000, rosterSeen: false }; } });
	const connected = await f.connect();
	const socket = f.socket(JSON.parse(connected.text).connectionId); await once(socket, "open");
	const opened = renews;
	await new Promise(resolve => setTimeout(resolve, 2 * GATEWAY_LIMITS.pollMs + 300));
	assert.ok(renews - opened <= 3, `${renews - opened} polls in about ${2 * GATEWAY_LIMITS.pollMs + 300} ms: the contract allows one per second`);
	assert.equal(f.calls.filter(([name]) => name === "attachWatch").length, 0);
	socket.terminate();
});

test("an unseen watch canceled while a control response is delayed never attaches or records a late opening", async t => {
	const gate = defer(), pollEntered = defer(), released = defer(); let renews = 0, f;
	f = await fixture(t, { kind: "watch", renewAttachment: async () => {
		if (++renews > 1) { pollEntered.resolve(); await gate.promise; }
		return { ok: true, intent: f.intent, room: f.room, authRemainingMs: 5000, rosterSeen: renews > 1 };
	} });
	const release = f.store.release; f.store.release = async args => { const result = await release(args); released.resolve(); return result; };
	const response = await f.connect(), ws = f.socket(response.body.connectionId); ws.on("error", () => {});
	await pollEntered.promise; ws.close(); await once(ws, "close"); await released.promise; gate.resolve();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(f.calls.some(c => c[0].startsWith("attach")), false); assert.deepEqual(f.audits, []);
	assert.equal(f.calls.filter(c => c[0] === "release").length, 1);
});

test("HTTPS ignores a preseeded legacy browser cookie and exclusively binds a fresh __Host nonce", async t => {
	const f = await fixture(t, { secure: true }), fixed = gatewayRandom();
	const boot = await f.api("/api/bootstrap", { intentId: f.intentId, handoff: gatewayRandom() }, { cookie: `pdg_browser=${fixed}` });
	assert.equal(boot.status, 200);
	const header = boot.headers["set-cookie"][0], fresh = /^__Host-pdg_browser=([A-Za-z0-9_-]{43});/.exec(header)?.[1];
	assert.ok(fresh); assert.notEqual(fresh, fixed); assert.match(header, /; Secure/); assert.match(header, /; HttpOnly/); assert.match(header, /; SameSite=Strict/); assert.match(header, /; Path=\//); assert.doesNotMatch(header, /Domain=/i);
	assert.equal(f.calls.find(c => c[0] === "bind")[1].browserHash, gatewayHash(fresh));
	const reuse = await f.api("/api/bootstrap", { intentId: f.intentId, handoff: gatewayRandom() });
	assert.match(reuse.headers["set-cookie"][0], new RegExp(`^__Host-pdg_browser=${f.cookie};`));
	const requestBody = { intentId: f.intentId, sessionKey: null, width: 1200, cols: 80, rows: 24 };
	assert.equal((await f.api("/api/connect", requestBody, { cookie: `pdg_browser=${f.cookie}` })).status, 403, "HTTPS never dual-reads or migrates the development name");
	assert.equal((await f.api("/api/connect", requestBody, { cookie: `__Host-pdg_browser=${f.cookie}; __Host-pdg_browser=${fixed}` })).status, 403);
	assert.equal((await f.api("/api/bootstrap", { intentId: f.intentId, handoff: gatewayRandom() }, { cookie: `__Host-pdg_browser=${f.cookie}; __Host-pdg_browser=${fixed}` })).status, 400);
	const connection = await f.connect(), wrong = f.socket(connection.body.connectionId, { cookie: `pdg_browser=${f.cookie}` }); wrong.on("error", () => {});
	await new Promise(resolve => wrong.once("unexpected-response", (_req, res) => { assert.equal(res.statusCode, 403); res.resume(); wrong.terminate(); resolve(); }));
	assert.equal(f.calls.some(c => c[0] === "attach"), false);
	const correct = f.socket(connection.body.connectionId); correct.on("error", () => {});
	await new Promise(resolve => correct.on("message", data => { if (String(data) === '{"type":"ready"}') resolve(); }));
	assert.equal(f.calls.filter(c => c[0] === "attach").length, 1, "the wrong cookie cannot steal or consume the legitimate socket admission");
	correct.close(); await once(correct, "close");
});

test("successful roster and audit awaits cannot begin attachment beyond the injected admission deadline even before its timer fires", async t => {
	for (const phase of ["roster", "audit", "shorter-roster"]) {
		let at = 0, reads = 0, f;
		f = await fixture(t, { kind: "watch", now: () => at,
			renewAttachment: async () => {
				reads++;
				if (phase === "roster" && reads > 1) at = 5000;
				return { ok: true, room: f.room, authRemainingMs: phase === "shorter-roster" && reads > 1 ? 100 : 5000, rosterSeen: reads > 1 };
			},
			audit: async kind => { if (kind === "opening" && phase !== "roster") at = phase === "audit" ? 5000 : 101; },
		});
		const response = await f.connect(), ws = f.socket(response.body.connectionId), frames = []; ws.on("error", () => {}); ws.on("message", b => frames.push(JSON.parse(String(b))));
		await once(ws, "close");
		assert.equal(f.calls.some(c => c[0].startsWith("attach")), false, phase);
		assert.deepEqual(frames, [{ type: "ended", reason: "authorization-unavailable" }], phase);
		assert.deepEqual(f.audits.map(a => a[0]), phase === "roster" ? [] : ["opening", "end"]);
	}
});

test("a late runtime or applied audit receipt never publishes a driver room or ready state, and malformed authority cannot create an unbounded session", async t => {
	for (const phase of ["attach", "open"]) {
		let at = 0, starts = 0, detached = 0;
		const f = await fixture(t, { now: () => at,
			attach: async () => { if (phase === "attach") at = 5000; return { stream: new PassThrough(), resize: async () => {}, detach() { detached++; this.stream.destroy(); } }; },
			audit: async kind => { if (phase === "open" && kind === "open") at = 5000; },
		});
		f.store.startDriver = async () => { starts++; throw new Error("must never run"); };
		const response = await f.connect(), ws = f.socket(response.body.connectionId), frames = []; ws.on("error", () => {}); ws.on("message", b => frames.push(JSON.parse(String(b))));
		await once(ws, "close");
		assert.equal(starts, 0); assert.equal(detached, 1); assert.deepEqual(frames, [{ type: "ended", reason: "authorization-unavailable" }]);
		assert.deepEqual(f.audits.map(a => a[0]), phase === "attach" ? ["opening", "end"] : ["opening", "open", "end"]);
	}
	for (const authRemainingMs of [undefined, 0, -1, 5001, Infinity]) {
		const f = await fixture(t); f.store.startDriver = async () => ({ ok: true, intent: f.intent, room: f.room, authRemainingMs });
		const response = await f.connect(), ws = f.socket(response.body.connectionId), frames = []; ws.on("error", () => {}); ws.on("message", b => frames.push(JSON.parse(String(b))));
		await once(ws, "close"); assert.deepEqual(frames, [{ type: "ended", reason: "authorization-unavailable" }]);
	}
});

test("a client that resets after a refused upgrade cannot take the gateway down", async t => {
	// Measured: this reset was an unhandled "error" on the upgraded socket, and it ended the process and every attachment.
	const f = await fixture(t);
	const client = connectSocket(f.port, "127.0.0.1");
	client.on("error", () => {});
	client.write(`GET /socket/${gatewayRandom()} HTTP/1.1\r\nHost: gateway.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${"a".repeat(22)}==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
	await once(client, "data");
	client.resetAndDestroy();
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.equal((await f.api(`/s/${f.intentId}`, undefined, { cookie: "" })).status, 200, "still serving");
});

test("a refused upgrade gives its connection slot back even if the client ignores the close", async t => {
	const f = await fixture(t);
	const client = connectSocket({ port: f.port, host: "127.0.0.1", allowHalfOpen: true });
	client.on("error", () => {}); client.resume();
	t.after(() => client.destroy());
	await once(client, "connect");
	client.write(`GET /socket/${gatewayRandom()} HTTP/1.1\r\nHost: gateway.localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
	const open = () => new Promise((resolve, reject) => f.app.server.getConnections((error, count) => error ? reject(error) : resolve(count)));
	const end = Date.now() + 2000;
	let count = await open();
	while (count > 0 && Date.now() < end) { await new Promise(resolve => setTimeout(resolve, 20)); count = await open(); }
	assert.equal(count, 0);
});
