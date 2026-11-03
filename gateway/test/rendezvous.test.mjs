import assert from "node:assert/strict";
import { test } from "node:test";
import { world, Target } from "./helpers/frontend-world.mjs";
import { startWorkbenchLaunch, publicWorkbenchMessage, WORKBENCH_OWNER_LOCK } from "../src/workbench-rendezvous.mjs";
import { GATEWAY_BOOT_WORDS, gatewayBootRefusal } from "../src/bootstrap.mjs";
const I = "i".repeat(43), J = "j".repeat(43), S = "a".repeat(64);
const ticks = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
function network() {
	const channels = new Set(), messages = []; let held = false;
	class Channel extends Target {
		constructor(name) { super(); this.name = name; channels.add(this); }
		postMessage(data) { messages.push(data); for (const channel of channels) if (channel !== this) Promise.resolve().then(() => channel.emit("message", { data: JSON.parse(JSON.stringify(data)) })); }
		close() { channels.delete(this); }
	}
	const locks = { async request(name, options, callback) { assert.equal(name, WORKBENCH_OWNER_LOCK); assert.equal(options.ifAvailable, true); if (held) return callback(null); held = true; try { return await callback({ name }); } finally { held = false; } } };
	const make = () => {
		const w = world(); let interval = 0; const intervals = new Map();
		w.window.BroadcastChannel = Channel; w.window.navigator.locks = locks; w.window.close = () => { w.closed = true; };
		w.window.setInterval = fn => { intervals.set(++interval, fn); return interval; }; w.window.clearInterval = id => intervals.delete(id);
		w.intervalCount = () => intervals.size;
		return w;
	};
	return { make, messages, get held() { return held; }, get channelCount() { return channels.size; } };
}
function workspace() {
	const reserved = new Set(), admitted = [], controllers = [];
	const wb = { sessionKey: null, disposed: false, reserve(id) { if (reserved.has(id) || reserved.size >= 2) return false; reserved.add(id); return true; }, release(id) { reserved.delete(id); }, async admit(data, { signal }) { if (signal.aborted || this.sessionKey && this.sessionKey !== data.sessionKey) throw Error("wrong session"); admitted.push(data); this.sessionKey ??= data.sessionKey; controllers.push(data); }, duplicate(value) { return controllers.some(c => c.kind === value.kind && c.targetKey === value.targetKey && c.ownerKey === value.ownerKey); }, dispose() { this.disposed = true; reserved.clear(); }, admitted, reserved };
	return wb;
}
const accepted = (id = "one") => ({ connectionId: "c".repeat(43), sessionKey: S, kind: "drive", targetKey: "b".repeat(64), ownerKey: "c".repeat(64), id });
const ok = data => ({ ok: true, status: 200, json: async () => data });
function launch(w, wb, intentId = I) { return startWorkbenchLaunch({ ...w, intentId, mountWorkbench: async () => wb }); }

test("helper messages admit only public id/control words; all private context stays in own-origin cookie POST", async () => {
	for (const value of [{ type: "offer", intentId: I, sessionKey: S }, { type: "offer", intentId: "private" }, { type: "cookie", intentId: I }, null, []]) assert.equal(publicWorkbenchMessage(value), false);
	assert.equal(publicWorkbenchMessage({ type: "offer", intentId: I }), true);
	const n = network(), owner = n.make(), wb = workspace(); const bodies = [];
	owner.fetch = async (path, init) => { assert.equal(path, "/api/connect"); assert.equal(init.credentials, "same-origin"); assert.equal(init.cache, "no-store"); bodies.push(JSON.parse(init.body)); return ok(accepted()); };
	assert.equal((await launch(owner, wb)).state, "workbench"); assert.equal(bodies[0].sessionKey, null);
	const helper = n.make(); helper.fetch = () => { throw Error("helper must never redeem"); };
	assert.equal((await launch(helper, workspace(), J)).state, "transferred");
	assert.equal(helper.closed, true); assert.equal(bodies[1].sessionKey, S); assert.equal(bodies[1].intentId, J);
	for (const message of n.messages) assert.deepEqual(Object.keys(message).sort(), ["intentId", "type"]);
	assert.equal(JSON.stringify(n.messages).includes(S), false); assert.equal(helper.intervalCount(), 0); assert.equal(wb.admitted.length, 2);
	owner.window.emit("pagehide"); await ticks(); assert.equal(n.held, false); assert.equal(n.channelCount, 0);
});

test("a lost connect response aborts one finite provisional budget, releases owner, and a late response cannot adopt or attach", async () => {
	const n = network(), w = n.make(), wb = workspace(); let deliver, signal, calls = 0;
	w.fetch = (_path, init) => { signal = init.signal; calls++; return new Promise(resolve => { deliver = resolve; }); };
	const pending = launch(w, wb); await ticks(); w.advance(15000); await ticks();
	assert.equal((await pending).state, "refused"); assert.equal(signal.aborted, true); assert.equal(calls, 1); assert.equal(wb.admitted.length, 0); assert.equal(wb.sessionKey, null);
	deliver(ok(accepted())); await ticks(); assert.equal(wb.admitted.length, 0); assert.equal(n.held, false); assert.equal(n.channelCount, 0);
});

test("delayed JSON is fenced by the same budget and never creates a late renderer", async () => {
	const n = network(), w = n.make(), wb = workspace(); let json;
	w.fetch = async () => ({ ok: true, status: 200, json: () => new Promise(resolve => { json = resolve; }) });
	const pending = launch(w, wb); await ticks(); w.advance(15000); await ticks(); assert.equal((await pending).state, "refused");
	json(accepted()); await ticks(); assert.equal(wb.admitted.length, 0); assert.equal(wb.sessionKey, null); assert.equal(n.held, false);
});

test("a refused launch is asked once, reads as its fixed words, and never echoes the response", async () => {
	for (const [status, error, title] of [[409, "window-busy", "Already open"], [409, "runtime-unavailable", "Sandbox runtime unavailable"], [429, "connection-limit", GATEWAY_BOOT_WORDS.limited[0]], [503, "<img src=x onerror=alert(1)>", GATEWAY_BOOT_WORDS.unavailable[0]]]) {
		const n = network(), w = n.make(), wb = workspace(); let connects = 0;
		w.fetch = async () => { connects++; return { ok: false, status, json: async () => ({ error }) }; };
		wb.duplicate = () => false;
		const out = await startWorkbenchLaunch({ ...w, intentId: I, mountWorkbench: async () => wb, onRefusal(code, reason) { w.document.getElementById("gateway-state-title").textContent = GATEWAY_BOOT_WORDS[gatewayBootRefusal(code, reason)][0]; } });
		assert.equal(out.state, "refused"); assert.equal(connects, 1, `${status} is not retried`);
		assert.equal(w.text("state-title"), title); assert.doesNotMatch(w.text("state-title"), /onerror/); assert.equal(wb.admitted.length, 0);
	}
});

test("known consumed/expired diagnosis survives cleanup instead of generic failure replacement", async () => {
	const n = network(), w = n.make(), wb = workspace(); w.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: "expired" }) });
	const out = await startWorkbenchLaunch({ ...w, intentId: I, mountWorkbench: async () => wb, onRefusal() { w.document.getElementById("gateway-state-title").textContent = "This launch has ended"; } });
	assert.equal(out.state, "refused"); assert.equal(w.text("state-title"), "This launch has ended"); assert.equal(wb.disposed, true); assert.equal(wb.admitted.length, 0);
});

test("ACK loss reports ambiguity and does not create a second redemption", async () => {
	const n = network(), owner = n.make(), wb = workspace(); owner.fetch = async () => ok(accepted()); await launch(owner, wb);
	const helper = n.make();
	// Drop every reply to this helper while its public offers still reach the existing owner.
	class SilentReceiver extends helper.window.BroadcastChannel { emit() {} }
	helper.window.BroadcastChannel = SilentReceiver;
	const pending = launch(helper, workspace(), J); await ticks(); assert.equal(wb.admitted.length, 2);
	helper.advance(15000); await ticks(); assert.equal((await pending).state, "unconfirmed"); assert.match(helper.text("state-text"), /may already have attached/);
	assert.equal(wb.admitted.length, 2); assert.equal(helper.intervalCount(), 0); owner.window.emit("pagehide"); await ticks();
});

test("cancelled queued admission releases its slot without redeeming after the first ready", async () => {
	const n = network(), owner = n.make(), wb = workspace(); let ready, count = 0;
	wb.admit = async data => { if (!wb.sessionKey) await new Promise(resolve => { ready = resolve; }); wb.sessionKey = data.sessionKey; wb.admitted.push(data); };
	owner.fetch = async () => { count++; return ok(accepted()); };
	const first = launch(owner, wb); await ticks(); const helper = n.make(), second = launch(helper, workspace(), J); await ticks();
	helper.advance(15000); await ticks(); assert.equal((await second).state, "unconfirmed");
	ready(); await ticks(); assert.equal((await first).state, "workbench"); assert.equal(count, 1); assert.equal(wb.reserved.size, 0);
	owner.window.emit("pagehide"); await ticks();
});

test("a delayed provisional workbench factory shares the original deadline and cannot adopt late", async () => {
	const n = network(), w = n.make(), wb = workspace(); let finish;
	w.fetch = () => { throw Error("No redemption before workspace creation"); };
	const pending = startWorkbenchLaunch({ ...w, intentId: I, mountWorkbench: () => new Promise(resolve => { finish = resolve; }) });
	await ticks(); w.advance(15000); await ticks(); assert.equal((await pending).state, "expired"); assert.equal(n.held, false);
	finish(wb); await ticks(); assert.equal(wb.disposed, true); assert.equal(wb.sessionKey, null); assert.equal(wb.admitted.length, 0);
});

test("a different-session helper explains immutable workspace association without sending any session key over rendezvous", async () => {
	const n = network(), owner = n.make(), wb = workspace(); let calls = 0;
	owner.fetch = async () => ++calls === 1 ? ok(accepted()) : { ok: false, status: 409, json: async () => ({ error: "workbench-session-changed" }) };
	await launch(owner, wb);
	const helper = n.make(); const outcome = await launch(helper, workspace(), J);
	assert.equal(outcome.state, "session-changed"); assert.match(helper.text("state-text"), /even when all its tabs are closed/); assert.match(helper.text("state-text"), /Close that workspace/);
	assert.equal(wb.sessionKey, S); assert.equal(wb.admitted.length, 1); assert.equal(JSON.stringify(n.messages).includes(S), false);
	owner.window.emit("pagehide"); await ticks();
});
