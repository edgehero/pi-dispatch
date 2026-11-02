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
async function fixture(t, { inspect = async () => ({ ok: true }), redeem = null, audit = async () => {}, attach = async () => ({ stream: new PassThrough(), resize: async () => {}, detach() { this.stream.destroy(); } }) } = {}) {
	const intentId = gatewayRandom(), cookie = gatewayRandom(), audits = [], calls = [];
	const intent = { intentId, target: { host: "host-a", id: "run-a", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" }, gatewayOrigin: "http://gateway.localhost", consoleOrigin: "http://console.localhost", browserHash: gatewayHash(cookie), actor: { name: "ops", role: "operator", session: "a".repeat(12) }, connectedAt: 123, theme: "dark" };
	const store = { readIntent: async () => intent, bindIntent: async args => { calls.push(["bind", args]); return { ok: true, intent }; }, redeem: async args => { calls.push(["redeem", args]); return redeem ? redeem(args) : { ok: true, intent }; }, renewAttachment: async () => ({ ok: true, intent, authRemainingMs: 5000 }), release: async args => { calls.push(["release", args]); return { ok: true }; } };
	const runtime = { inspect: async target => { calls.push(["inspect", target]); return inspect(target); }, attach: async (...args) => { calls.push(["attach", ...args]); return attach(...args); } };
	const app = createGatewayServer({ config: { origin: intent.gatewayOrigin, consoleOrigin: intent.consoleOrigin, host: "host-a", sockets: { local: "/fixed.sock" }, idleMinutes: 30 }, store, runtime, assets: { script: "", terminalScript: "", css: "" }, audit: async (...args) => { audits.push(args); await audit(...args); }, now: () => 0 });
	await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve)); const port = app.server.address().port;
	t.after(() => app.close());
	async function api(path, data, headers = {}) {
		return new Promise((resolve, reject) => {
			const body = data === undefined ? null : JSON.stringify(data);
			const req = request({ hostname: "127.0.0.1", port, path, method: body ? "POST" : "GET", headers: { host: "gateway.localhost", origin: intent.gatewayOrigin, ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}), cookie: `pdg_browser=${cookie}`, ...headers } }, res => { const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => { const text = Buffer.concat(chunks).toString(); let value; try { value = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: value, text }); }); }); req.on("error", reject); req.end(body);
		});
	}
	const connect = () => api("/api/connect", { intentId, width: 1200, cols: 80, rows: 24 });
	const socket = connectionId => new WebSocket(`ws://127.0.0.1:${port}/socket/${connectionId}`, { origin: intent.gatewayOrigin, headers: { host: "gateway.localhost", cookie: `pdg_browser=${cookie}` } });
	return { app, api, connect, socket, calls, audits, intentId, intent, cookie, port };
}

test("generic landing never rotates Strict cookies or discloses authority; direct phone/cross-origin/duplicate-cookie cannot redeem", async t => {
	const f = await fixture(t);
	const page = await f.api(`/s/${f.intentId}`, undefined, { cookie: "" });
	assert.equal(page.status, 200); assert.equal(page.headers["set-cookie"], undefined); assert.doesNotMatch(page.text, new RegExp(f.cookie)); assert.match(page.headers["content-security-policy"], /script-src 'self'/);
	const phone = await f.api("/api/connect", { intentId: f.intentId, width: 760, cols: 80, rows: 24 }); assert.equal(phone.status, 400);
	assert.equal((await f.api("/api/connect", { intentId: f.intentId, width: 1200, cols: 80, rows: 24 }, { origin: "https://hostile.example" })).status, 403);
	assert.equal((await f.api("/api/connect", { intentId: f.intentId, width: 1200, cols: 80, rows: 24 }, { cookie: `pdg_browser=${f.cookie}; pdg_browser=${gatewayRandom()}` })).status, 403);
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
	for (const kind of ["bound", "expired", "replayed"]) {
		const f = await fixture(t, { redeem: async () => ({ refused: "grant-unavailable" }) }); f.intent.state = kind;
		assert.equal((await f.connect()).status, 409); assert.equal(f.calls.some(c => c[0] === "inspect" || c[0] === "attach"), false);
	}
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
