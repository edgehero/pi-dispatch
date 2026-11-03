import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { test } from "node:test";
import WebSocket from "ws";
import { gatewayHash, gatewayRandom, makeGatewayStore, GATEWAY_AUTH_MS } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";
import { makeRedisClient } from "../../worker/src/connection.mjs";
import { GATEWAY_LIMITS } from "../src/terminal-protocol.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Two real processes behind one origin, as a load balancer would give them, on real sockets and a live store. In one
// process a watch can be ended by `stopWatches` through shared memory, which would hide a broken store path. Here the
// only thing the driver's process and the watcher's process share is Valkey, so each ending below has to cross it.
const url = process.env.VALKEY_TEST_URL;
const origin = "http://gateway.localhost", consoleOrigin = "http://console.localhost", host = "host-a", WATCH_END_MS = GATEWAY_AUTH_MS + 1500; // The lease, plus room for a busy CI runner.
const ops = { name: "ops", role: "operator", session: "a".repeat(12) }, lee = { name: "lee", role: "operator", session: "b".repeat(12) };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what, ms = 8000) {
	const end = Date.now() + ms;
	for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(20); }
}

async function world(t) {
	const prefix = `gateway-two-process:${gatewayRandom().replaceAll("-", "_")}:`;
	const redis = makeRedisClient(url, { disconnectTimeoutMs: 0 }); redis.on("error", () => {});
	const store = makeGatewayStore({ redis, prefix }), renewals = new Map(), children = [], sockets = [];
	const target = { host, id: `run-${gatewayRandom().slice(0, 8)}`, nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" };
	const observedAt = async () => (await store.observeTime()).nowMs;
	// The console's broker renews every authorization once a second. Stopping one models that operator losing authority.
	const renewer = setInterval(() => { for (const m of renewals.values()) void observedAt().then(at => store.renewAuthorization({ intentId: m.intentId, owner: m.owner, observedAt: at })).catch(() => {}); }, 500);
	t.after(async () => {
		clearInterval(renewer);
		for (const socket of sockets) socket.terminate();
		for (const child of children) child.kill("SIGKILL");
		const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys);
		redis.disconnect();
	});
	async function gatewayProcess() {
		const logsDir = tempDir("pd-gateway-two-process-");
		const child = fork(new URL("./helpers/two-process-gateway.mjs", import.meta.url), { env: { ...process.env, TWO_PROCESS_GATEWAY: JSON.stringify({ url, prefix, origin, consoleOrigin, host, logsDir }) } });
		children.push(child);
		const events = []; child.on("message", message => events.push(message));
		const { port } = await until(() => events.find(e => e.type === "listening"), "the gateway process listens");
		const auditText = () => { const dir = join(logsDir, "console-audit"); return existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(".jsonl")).map(n => readFileSync(join(dir, n), "utf8")).join("") : ""; };
		return { port, events, seen: type => events.filter(e => e.type === type), output: data => child.send({ cmd: "output", data }), auditText, audit: () => auditText().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
	}
	const api = (gateway, path, body, cookie) => new Promise((resolve, reject) => {
		const raw = JSON.stringify(body);
		const req = request({ hostname: "127.0.0.1", port: gateway.port, path, method: "POST", headers: { host: new URL(origin).host, origin, "content-type": "application/json", "content-length": Buffer.byteLength(raw), ...(cookie ? { cookie } : {}) } }, res => {
			const chunks = []; res.on("data", c => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()), setCookie: res.headers["set-cookie"]?.[0]?.split(";")[0] }));
		});
		req.on("error", reject); req.end(raw);
	});
	/** Everything a browser and the console would do to attach, against this one process. */
	async function attach(gateway, { kind = "drive", driver, actor = ops, runFacts = null, cols = 100, rows = 30, acknowledge = true } = {}) {
		const handoff = gatewayRandom();
		const m = { intentId: gatewayRandom(), owner: gatewayRandom(), kind, sessionKey: gatewayHash(gatewayRandom()), runFacts, handoffHash: gatewayHash(handoff), target, gatewayOrigin: origin, consoleOrigin, ...(driver ? { driver } : {}) };
		assert.equal((await store.createIntent(m)).ok, true);
		const bootstrap = await api(gateway, "/api/bootstrap", { intentId: m.intentId, handoff });
		assert.equal(bootstrap.status, 200);
		const authorized = await store.authorizeIntent({ intentId: m.intentId, owner: m.owner, actor, observedAt: await observedAt() });
		assert.equal(authorized.ok, true, `authorization: ${authorized.refused}`);
		renewals.set(m.intentId, m);
		const connected = await api(gateway, "/api/connect", { intentId: m.intentId, sessionKey: null, width: 1200, cols, rows }, bootstrap.setCookie);
		assert.equal(connected.status, 200, `connect: ${JSON.stringify(connected.json)}`);
		const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/socket/${connected.json.connectionId}`, { origin, headers: { host: new URL(origin).host, cookie: bootstrap.setCookie } });
		sockets.push(socket);
		const attachment = { m, socket, connected: connected.json, frames: [], bytes: "", acknowledge, closed: false };
		socket.on("error", () => {}); socket.on("close", () => { attachment.closed = true; });
		socket.on("message", (data, binary) => {
			if (binary) { attachment.bytes += data.toString(); return; }
			const frame = JSON.parse(data.toString()); attachment.frames.push(frame);
			// A live frontend renders the roster, then says so. Withholding this is what a frozen driver looks like.
			if (frame.type === "sharing" && attachment.acknowledge) socket.send(JSON.stringify({ type: "sharing-seen", revision: frame.revision }));
		});
		attachment.frame = (match, what = "a frame", ms) => until(() => attachment.frames.find(match), what, ms);
		attachment.send = message => socket.send(JSON.stringify(message));
		attachment.ended = (ms = WATCH_END_MS) => attachment.frame(f => f.type === "ended", "the attachment to end", ms);
		// Two different losses. A console that stops renewing proves nothing about the operator, so the honest
		// word is "could not be checked". An operator the console actually revoked ends as a session end.
		attachment.stopRenewing = () => { renewals.delete(m.intentId); };
		attachment.revoke = () => { renewals.delete(m.intentId); return store.revoke({ intentId: m.intentId, owner: m.owner }); };
		return attachment;
	}
	async function driverWithSharing(gateway) {
		const driver = await attach(gateway);
		await driver.frame(f => f.type === "ready", "the driver is ready");
		driver.send({ type: "watch-policy", enabled: true });
		await driver.frame(f => f.type === "sharing" && f.enabled, "consent is published");
		const room = await until(async () => { const r = await store.readRoom(target); return r?.enabled && r; }, "the room is shared");
		driver.reference = { intentId: driver.m.intentId, connectionId: driver.connected.connectionId, epoch: room.epoch };
		return driver;
	}
	return { store, target, gatewayProcess, attach, driverWithSharing };
}

const skip = !url && "needs VALKEY_TEST_URL";

test("a watch on another process gets the driver's size and new output, and nothing it sends reaches the driver", { skip }, async t => {
	const w = await world(t), a = await w.gatewayProcess(), b = await w.gatewayProcess();
	const runFacts = { id: w.target.id, outcome: "completed", project: "web", target: "acme/web#490", flow: "fix", endedAt: "2026-11-02T15:12:00.000Z" };
	const driver = await w.attach(a, { runFacts });
	assert.deepEqual(driver.connected.runFacts, runFacts, "only the projected record facts cross /api/connect, unchanged");
	await driver.frame(f => f.type === "ready", "the driver is ready");
	driver.send({ type: "watch-policy", enabled: true });
	await driver.frame(f => f.type === "sharing" && f.enabled, "consent is published");
	const room = await w.store.readRoom(w.target);
	const watch = await w.attach(b, { kind: "watch", actor: lee, driver: { intentId: driver.m.intentId, connectionId: driver.connected.connectionId, epoch: room.epoch } });
	assert.deepEqual(watch.connected.geometry, { cols: 100, rows: 30, revision: room.geometry.revision }, "the watch learns the driver's size from the store, not from its own process");
	await watch.frame(f => f.type === "ready", "the watch is ready");
	assert.equal(b.seen("attachWatch").length, 1); assert.equal(b.seen("attach").length, 0, "a watch never takes the writable attach");

	b.output("WATCH_OUTPUT");
	await until(() => watch.bytes.includes("WATCH_OUTPUT"), "new output reaches the watch");

	driver.send({ type: "resize", cols: 120, rows: 40, width: 1200 });
	await until(() => a.seen("resize").some(e => e.cols === 120), "the driver's own process resizes the PTY");
	await watch.frame(f => f.type === "geometry" && f.cols === 120 && f.rows === 40, "a resize crosses to the other process", GATEWAY_LIMITS.pollMs * 3);

	// Hostile, on a real socket. These frames must be dropped without ending the watch, in either process.
	watch.send({ type: "input", data: "printf HOSTILE\r" }); watch.send({ type: "resize", cols: 33, rows: 11, width: 1200 }); watch.send({ type: "activity" });
	await sleep(GATEWAY_LIMITS.pollMs + 500);
	assert.equal(watch.closed, false, "a dropped frame does not end the watch");
	assert.deepEqual([...a.seen("input"), ...b.seen("input")], [], "no watcher input reaches any runtime");
	assert.equal(a.seen("resize").some(e => e.cols === 33) || b.seen("resize").length > 0, false, "no watcher resize reaches any runtime");
	assert.equal((await w.store.readRoom(w.target)).geometry.cols, 120);

	// A control frame is a capability a watch does not have, so it is refused, and the driver's consent stands.
	watch.send({ type: "watch-policy", enabled: false });
	assert.equal((await watch.ended()).reason, "protocol-error");
	assert.equal((await w.store.readRoom(w.target)).enabled, true);
	// The real journal of the process the watch ran on: who watched whom, why it ended, and never a byte.
	const ended = await until(() => b.audit().find(row => row.kind === "sandbox-watch-end"), "the watch's end is audited");
	assert.equal(ended.actor.name, "lee"); assert.equal(ended.driver.name, "ops"); assert.equal(ended.reason, "protocol-error");
	assert.ok(b.audit().some(row => row.kind === "sandbox-watch-start" && row.actor.name === "lee" && row.driver.name === "ops"), "and so is its start");
	for (const secret of ["WATCH_OUTPUT", "HOSTILE"]) assert.equal(`${a.auditText()}${b.auditText()}`.includes(secret), false, "the audit holds no terminal bytes");
	assert.equal(driver.closed, false);
	driver.send({ type: "input", data: "still-driving" });
	await until(() => a.seen("input").some(e => e.data === "still-driving"), "the driver is unaffected");
});

for (const [name, end, reason] of [
	["turning watching off", driver => driver.send({ type: "watch-policy", enabled: false }), ["watch-disabled"]],
	["Remove", driver => driver.send({ type: "watch-remove", watcherKey: driver.frames.findLast(f => f.type === "sharing" && f.watchers.length).watchers[0].watcherKey }), ["watch-removed"]],
	["the driver disconnecting", driver => driver.socket.close(), ["driver-ended"]],
	["the console revoking the driver", driver => driver.revoke(), ["driver-ended"]],
	// Silence ends as whichever comes first: this process's own deadline, or a poll that lands just after the store's expiry.
	["the console no longer renewing the driver, while its longer window lease is still alive", driver => driver.stopRenewing(), ["authorization-unavailable", "driver-ended"]],
]) test(`${name} ends a watch on another process within the bound`, { skip }, async t => {
	const w = await world(t), a = await w.gatewayProcess(), b = await w.gatewayProcess();
	const driver = await w.driverWithSharing(a);
	const watch = await w.attach(b, { kind: "watch", actor: lee, driver: driver.reference });
	await watch.frame(f => f.type === "ready", "the watch is ready");
	await driver.frame(f => f.type === "sharing" && f.watchers.length === 1, "the driver's roster names the watcher");
	const started = Date.now();
	end(driver);
	const finished = (await watch.ended()).reason; assert.ok(reason.includes(finished), `ended as ${finished}`);
	assert.ok(Date.now() - started <= WATCH_END_MS);
});

for (const [name, lose, reason] of [
	["being revoked", watch => watch.revoke(), ["session-ended"]],
	["no longer being renewed", watch => watch.stopRenewing(), ["authorization-unavailable", "session-ended"]],
]) test(`a watcher ${name} ends only that watch, and the driver's roster drops it`, { skip }, async t => {
	const w = await world(t), a = await w.gatewayProcess(), b = await w.gatewayProcess();
	const driver = await w.driverWithSharing(a);
	const watch = await w.attach(b, { kind: "watch", actor: lee, driver: driver.reference });
	await watch.frame(f => f.type === "ready", "the watch is ready");
	await driver.frame(f => f.type === "sharing" && f.watchers.length === 1, "the roster names the watcher");
	const started = Date.now();
	lose(watch);
	const finished = (await watch.ended()).reason; assert.ok(reason.includes(finished), `ended as ${finished}`);
	assert.ok(Date.now() - started <= WATCH_END_MS);
	await until(async () => Object.keys((await w.store.readRoom(w.target)).watchers).length === 0, "the slot is released");
	await driver.frame(f => f.type === "sharing" && f.watchers.length === 0, "the driver's roster drops the watcher");
	assert.equal(driver.closed, false, "the driver is untouched");
});

test("a frozen driver that never acknowledges its roster admits no watcher, and thawing admits a fresh one", { skip }, async t => {
	const w = await world(t), a = await w.gatewayProcess(), b = await w.gatewayProcess();
	const driver = await w.driverWithSharing(a);
	driver.acknowledge = false;
	const blocked = await w.attach(b, { kind: "watch", actor: lee, driver: driver.reference });
	assert.equal((await blocked.ended(GATEWAY_LIMITS.upgradeMs + 1000)).reason, "authorization-unavailable");
	assert.equal(blocked.frames.some(f => f.type === "ready"), false);
	assert.equal(b.seen("attachWatch").length, 0, "with no rendered roster a watcher never reaches the runtime");
	assert.equal(driver.closed, false, "the slow driver itself is not punished");
	driver.acknowledge = true;
	await until(async () => Object.keys((await w.store.readRoom(w.target)).watchers).length === 0, "the refused watcher's slot is released");
	const later = await w.attach(b, { kind: "watch", actor: lee, driver: driver.reference });
	await later.frame(f => f.type === "ready", "a fresh watch is admitted once the driver renders again");
	assert.equal(b.seen("attachWatch").length, 1);
});
