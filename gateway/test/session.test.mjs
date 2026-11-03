import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { runGatewaySession, GATEWAY_LIMITS } from "../src/session.mjs";

function fixture({ kind = "drive", room = null, controls = {}, idleMinutes = 30, authRemainingMs = 5000, renew = async () => ({ ok: true, authRemainingMs: 5000 }), inspect = async () => ({ ok: true }), resize = async () => {} } = {}) {
	let at = 0, timer; const sends = [], input = [], audits = [], ends = [], resized = []; let detaches = 0;
	const ws = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: (data, _opts, callback) => { sends.push(data); callback?.(); }, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } });
	const stream = Object.assign(new EventEmitter(), { writableLength: 0, write: s => { input.push(s); return true; } });
	const session = runGatewaySession({ ws, channel: { stream, detach: () => { detaches++; }, resize: async geometry => { resized.push(geometry); await resize(geometry); } }, store: { renewAttachment: renew, release: async () => ({ ok: true }), ...controls }, intent: { intentId: "intent", kind, ...(kind === "watch" ? { driver: { connectionId: "driver" } } : {}), target: {} }, room, connectionId: "connection", browserHash: "browser", authRemainingMs, idleMinutes, runtime: { inspect }, audit: async (...a) => { audits.push(a); }, now: () => at, setTimer: fn => (timer = fn, {}), clearTimer: () => {}, onEnd: result => { ends.push(result); } });
	return { ws, stream, session, sends, input, audits, ends, resized, setAt: value => { at = value; }, timer: () => timer(), get detaches() { return detaches; } };
}
test("input, control characters and binary output cross the live lease without being logged or interpreted", async () => {
	const f = fixture(); f.ws.emit("message", Buffer.from(JSON.stringify({ type: "input", data: "echo PRIVATE\r\u0003" })), false); f.stream.emit("data", Buffer.from("\x1b[31mPRIVATE\x1b[0m"));
	assert.deepEqual(f.input, ["echo PRIVATE\r\u0003"]); assert.equal(f.sends[0].toString(), "\x1b[31mPRIVATE\x1b[0m");
	await f.session.finish(); assert.doesNotMatch(JSON.stringify(f.audits), /PRIVATE/); assert.equal(f.detaches, 1);
});
test("a watch cannot write, resize, claim activity or reset an input idle timer, and observes geometry before subsequent bytes", async () => {
	const room = { driverConnectionId: "driver", geometry: { cols: 120, rows: 36, revision: 1 } };
	const f = fixture({ kind: "watch", room, idleMinutes: 1, renew: async () => ({ ok: true, room, authRemainingMs: 5000 }) });
	assert.deepEqual(JSON.parse(f.sends[0]), { type: "geometry", cols: 120, rows: 36, revision: 1 });
	for (const message of [{ type: "input", data: "echo HOSTILE\r\u001b[1;1R" }, { type: "resize", cols: 500, rows: 200, width: 1 }, { type: "activity" }]) f.ws.emit("message", Buffer.from(JSON.stringify(message)), false);
	for (let at = 1000; at <= 60000; at += 1000) { f.setAt(at); await f.session.tick(); }
	assert.deepEqual(f.input, []); assert.deepEqual(f.resized, []); assert.equal(f.detaches, 0, "a watcher has no input timer it could possibly satisfy");
	room.geometry = { cols: 91, rows: 23, revision: 2 }; await f.session.tick();
	f.stream.emit("data", Buffer.from("WATCH_ONCE_✓_界"));
	assert.deepEqual(JSON.parse(f.sends.at(-2)), { type: "geometry", cols: 91, rows: 23, revision: 2 });
	assert.equal(f.sends.at(-1).toString(), "WATCH_ONCE_✓_界"); assert.equal(f.sends.filter(Buffer.isBuffer).length, 1);
	await f.session.finish();
});

test("a watch uses the shorter driver authority receipt and cannot forward bytes after it expires", async () => {
	const room = { driverConnectionId: "driver", geometry: { cols: 80, rows: 24, revision: 1 } };
	const f = fixture({ kind: "watch", room, renew: async () => ({ ok: true, room, authRemainingMs: 700 }) });
	f.setAt(1000); await f.session.tick(); f.setAt(1700); f.timer();
	f.stream.emit("data", Buffer.from("PRIVATE_AFTER_EXPIRY"));
	assert.equal(f.sends.filter(Buffer.isBuffer).length, 0); assert.equal(f.detaches, 1);
});
test("a slow attach leaves a lease shorter than a poll: it is renewed before it lapses, so a healthy terminal is not ended", async () => {
	const settle = () => new Promise(resolve => setImmediate(resolve));
	let renews = 0;
	const f = fixture({ authRemainingMs: 800, renew: async () => { renews++; return { ok: true, authRemainingMs: 5000 }; } });
	assert.equal(renews, 1, "asked at once, rather than one poll later, when the deadline would already have passed");
	await settle();
	f.setAt(900); f.timer();
	f.stream.emit("data", Buffer.from("still here"));
	assert.equal(f.sends.filter(Buffer.isBuffer).length, 1, "the store's answer carried the lease past where the attach left it");
	assert.deepEqual(f.ends, []);
	await f.session.finish();

	// The lease grows only by what the store says. A store that does not answer ends it at the same deadline as before.
	const hung = fixture({ authRemainingMs: 800, renew: () => new Promise(() => {}) });
	hung.setAt(799); hung.timer(); hung.stream.emit("data", Buffer.from("before"));
	assert.equal(hung.sends.filter(Buffer.isBuffer).length, 1);
	hung.setAt(800); hung.timer(); hung.stream.emit("data", Buffer.from("PRIVATE_AFTER_EXPIRY"));
	assert.equal(hung.sends.filter(Buffer.isBuffer).length, 1, "nothing crosses after the last real authority");
	assert.equal(hung.detaches, 1);
	assert.equal(JSON.parse(hung.sends.find(s => !Buffer.isBuffer(s))).reason, "authorization-unavailable", "and that is what it says: nothing confirmed it");

	// Asking sooner finds a revocation sooner, and names it for what it is.
	const revoked = fixture({ authRemainingMs: 800, renew: async () => ({ ok: false, refused: "authorization-expired" }) });
	await settle();
	assert.equal(revoked.detaches, 1);
	assert.equal(JSON.parse(revoked.sends.find(s => !Buffer.isBuffer(s))).reason, "session-ended");

	// A lease with room left keeps the fixed poll: this asks sooner only when it must.
	let steady = 0;
	const normal = fixture({ renew: async () => { steady++; return { ok: true, authRemainingMs: 5000 }; } });
	assert.equal(steady, 0);
	for (const at of [100, 500, 900]) { normal.setAt(at); normal.timer(); await settle(); }
	assert.equal(steady, 0, "no extra questions while the lease is long");
	normal.setAt(1000); normal.timer(); await settle();
	assert.equal(steady, 1);
	await normal.session.finish();

	// A lease that stays short is asked about one question at a time, however often the timer fires.
	let inFlight = 0, most = 0; const answers = [];
	const short = fixture({ authRemainingMs: 800, renew: () => new Promise(resolve => { inFlight++; most = Math.max(most, inFlight); answers.push(() => { inFlight--; resolve({ ok: true, authRemainingMs: 800 }); }); }) });
	for (const at of [100, 200, 300]) { short.setAt(at); short.timer(); }
	assert.equal(most, 1);
	answers.shift()(); await settle(); await short.session.finish();
});
test("large daemon output is losslessly partitioned into the browser's bounded binary frames", async () => {
	const f = fixture(), bytes = Buffer.alloc(65536 * 2 + 17, 0x42);
	f.stream.emit("data", bytes);
	assert.deepEqual(f.sends.map(b => b.length), [65536, 65536, 17]);
	assert.deepEqual(Buffer.concat(f.sends), bytes); await f.session.finish();
});
test("an unavailable or hanging broker cannot forward either direction after its last real authority", async () => {
	const f = fixture({ renew: () => new Promise(() => {}) });
	f.setAt(1000); void f.session.tick(); f.setAt(5000); f.timer();
	f.ws.emit("message", Buffer.from('{"type":"input","data":"after expiry"}'), false); f.stream.emit("data", Buffer.from("after expiry"));
	await f.session.finish(); assert.deepEqual(f.input, []); assert.equal(f.sends.filter(Buffer.isBuffer).length, 0); assert.equal(f.detaches, 1);
});
test("daemon transport loss stops I/O immediately and never claims a surviving or unobserved shell exited", async () => {
	for (const state of [{ ok: true }, { refused: "runtime-unavailable" }, { refused: "sandbox-ended" }]) {
		let resolve; const result = new Promise(r => { resolve = r; }), f = fixture({ inspect: () => result });
		f.stream.emit("end"); f.stream.emit("data", Buffer.from("after loss")); f.ws.emit("message", Buffer.from('{"type":"input","data":"after loss"}'), false);
		assert.deepEqual(f.input, []); assert.equal(f.sends.filter(Buffer.isBuffer).length, 0);
		resolve(state); await new Promise(r => setImmediate(r));
		assert.equal(f.sends.some(s => String(s).includes(`"reason":"${state.refused === "sandbox-ended" ? "sandbox-ended" : "runtime-unavailable"}"`)), true);
		assert.equal(f.detaches, 1);
	}
});
test("output and resize do not reset host idle; protocol violations, phone shrink and pressure detach only", async () => {
	const idle = fixture({ idleMinutes: 1 });
	for (let n = 1000; n < 60000; n += 1000) { idle.setAt(n); await idle.session.tick(); idle.stream.emit("data", Buffer.from("busy output")); }
	idle.setAt(60000); idle.timer(); await idle.session.finish(); assert.equal(idle.sends.map(s => String(s)).some(s => s.includes('"reason":"idle"')), true);
	for (const frame of [{ type: "resize", cols: 80, rows: 24, width: 760 }, { type: "start", image: "host-image" }, { type: "input", data: "x", command: "extra" }]) {
		const f = fixture(); f.ws.emit("message", Buffer.from(JSON.stringify(frame)), false); await f.session.finish(); assert.equal(f.detaches, 1); assert.deepEqual(f.input, []);
	}
	const pressure = fixture(); pressure.ws.bufferedAmount = 1048576; pressure.stream.emit("data", Buffer.from("one more")); await pressure.session.finish(); assert.equal(pressure.detaches, 1);
});
test("terminal-generated query replies cannot extend idle while an explicit trusted-UI activity receipt does", async () => {
	const f = fixture({ idleMinutes: 1 });
	for (let n = 1000; n < 60000; n += 1000) { f.setAt(n); await f.session.tick(); f.ws.emit("message", Buffer.from(JSON.stringify({ type: "input", data: "\x1b[1;1R" })), false); }
	f.setAt(60000); f.timer(); await f.session.finish();
	assert.equal(f.sends.some(s => String(s).includes('"reason":"idle"')), true);
	const active = fixture({ idleMinutes: 1 });
	for (let n = 1000; n <= 60000; n += 1000) { active.setAt(n); await active.session.tick(); active.ws.emit("message", Buffer.from('{"type":"activity"}'), false); }
	assert.equal(active.detaches, 0); await active.session.finish();
});
test("valid resize events coalesce behind a slow daemon and never replay after authority ends", async () => {
	const frame = cols => Buffer.from(JSON.stringify({ type: "resize", cols, rows: 24, width: 1200 }));
	let done, calls = 0;
	const live = fixture({ resize: () => ++calls === 1 ? new Promise(resolve => { done = resolve; }) : Promise.resolve() });
	live.ws.emit("message", frame(80), false); live.ws.emit("message", frame(81), false); live.ws.emit("message", frame(82), false);
	assert.deepEqual(live.resized.map(g => g.cols), [80]); assert.equal(live.detaches, 0);
	done(); await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(live.resized.map(g => g.cols), [80, 82]); assert.equal(live.detaches, 0); await live.session.finish();
	const expired = fixture({ resize: () => new Promise(resolve => { done = resolve; }) });
	expired.ws.emit("message", frame(80), false); expired.ws.emit("message", frame(82), false);
	expired.setAt(5000); expired.timer(); done(); await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(expired.resized.map(g => g.cols), [80]); assert.equal(expired.detaches, 1);
});

test("revocation or control-store failure during a successful pending resize cannot masquerade as runtime failure", async () => {
	for (const result of [{ refused: "authorization-expired" }, { refused: "control-unavailable" }]) {
		let finishResize, entered; const resizing = new Promise(resolve => { entered = resolve; });
		const room = { driverConnectionId: "connection", enabled: false, rosterRevision: 0, watchers: {}, geometry: { cols: 80, rows: 24, revision: 1 } };
		const f = fixture({ room, controls: { updateGeometry: async () => result }, resize: () => { entered(); return new Promise(resolve => { finishResize = resolve; }); } });
		f.ws.emit("message", Buffer.from('{"type":"resize","cols":90,"rows":30,"width":1200}'), false); await resizing;
		finishResize(); await new Promise(resolve => setImmediate(resolve));
		const reason = result.refused === "authorization-expired" ? "session-ended" : "authorization-unavailable";
		assert.equal(f.detaches, 1); assert.deepEqual(f.resized.map(g => [g.cols, g.rows]), [[90, 30]]);
		assert.deepEqual(JSON.parse(f.sends.at(-1)), { type: "ended", reason }); assert.equal(f.audits.at(-1)[3], reason);
	}
	const room = { driverConnectionId: "connection", enabled: false, rosterRevision: 0, watchers: {}, geometry: { cols: 80, rows: 24, revision: 1 } };
	let published = false;
	const badRuntime = fixture({ room, resize: async () => { throw new Error("daemon unavailable"); }, controls: { updateGeometry: async () => { published = true; return { ok: true, room }; } } });
	badRuntime.ws.emit("message", Buffer.from('{"type":"resize","cols":90,"rows":30,"width":1200}'), false); await new Promise(resolve => setImmediate(resolve));
	assert.equal(published, false); assert.deepEqual(JSON.parse(badRuntime.sends.at(-1)), { type: "ended", reason: "runtime-unavailable" });
});

test("a watcher too slow for its output is dropped by itself, with no other session touched", async () => {
	const room = { driverConnectionId: "driver", geometry: { cols: 120, rows: 36, revision: 1 } };
	const f = fixture({ kind: "watch", room, renew: async () => ({ ok: true, room, authRemainingMs: 5000 }) });
	f.ws.bufferedAmount = GATEWAY_LIMITS.bufferedBytes;
	const sent = f.sends.length;
	f.stream.emit("data", Buffer.from("MORE_OUTPUT"));
	for (let turn = 0; turn < 50 && !f.ends.length; turn++) await Promise.resolve();
	assert.equal(f.ends[0].reason, "backpressure");
	assert.equal(f.sends.slice(sent).some(s => String(s).includes("MORE_OUTPUT")), false, "nothing more is queued for a reader that cannot keep up");
	assert.equal(f.detaches, 1, "only this watch's own read-only transport closes");
});

test("a stalled watcher told to stop is cut, not left draining its queue; a driver is still told why", async () => {
	const room = { driverConnectionId: "driver", geometry: { cols: 120, rows: 36, revision: 1 } };
	const stalled = fixture({ kind: "watch", room, renew: async () => ({ ok: true, room, authRemainingMs: 5000 }) });
	let terminated = 0; stalled.ws.terminate = () => { terminated++; stalled.ws.readyState = 3; };
	stalled.ws.bufferedAmount = 1024; const before = stalled.sends.length;
	await stalled.session.finish("watch-removed");
	assert.equal(terminated, 1); assert.equal(stalled.sends.length, before, "close() would have kept sending that queue for up to 30 seconds");
	const driver = fixture(); driver.ws.bufferedAmount = 1024;
	await driver.session.finish("disconnected");
	assert.equal(JSON.parse(driver.sends.at(-1)).reason, "disconnected");
});

test("a peer that stops answering pings is let go; one that answers stays, and its pings spend the frame budget", async () => {
	const walk = async (f, from, to) => { for (let at = from; at <= to; at += 1000) { f.setAt(at); await f.session.tick(); } };
	const silent = fixture(); let pings = 0; silent.ws.ping = () => { pings++; };
	await walk(silent, 1000, GATEWAY_LIMITS.pingMs); silent.timer();
	assert.equal(pings, 1); assert.equal(silent.ends.length, 0);
	await walk(silent, GATEWAY_LIMITS.pingMs + 1000, 2 * GATEWAY_LIMITS.pingMs); silent.timer();
	for (let turn = 0; turn < 50 && !silent.ends.length; turn++) await Promise.resolve();
	assert.equal(silent.ends[0]?.reason, "disconnected");

	const answering = fixture(); answering.ws.ping = () => { answering.ws.emit("pong"); };
	await walk(answering, 1000, GATEWAY_LIMITS.pingMs); answering.timer();
	await walk(answering, GATEWAY_LIMITS.pingMs + 1000, 2 * GATEWAY_LIMITS.pingMs); answering.timer();
	await Promise.resolve();
	assert.equal(answering.ends.length, 0);

	const flooding = fixture();
	for (let n = 0; n <= GATEWAY_LIMITS.framesPerSecond; n++) flooding.ws.emit("ping");
	for (let turn = 0; turn < 50 && !flooding.ends.length; turn++) await Promise.resolve();
	assert.equal(flooding.ends[0]?.reason, "protocol-error");
});
