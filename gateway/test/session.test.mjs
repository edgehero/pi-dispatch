import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { runGatewaySession } from "../src/session.mjs";

function fixture({ idleMinutes = 30, renew = async () => ({ ok: true, authRemainingMs: 5000 }), inspect = async () => ({ ok: true }), resize = async () => {} } = {}) {
	let at = 0, timer; const sends = [], input = [], audits = [], ends = [], resized = []; let detaches = 0;
	const ws = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: (data, _opts, callback) => { sends.push(data); callback?.(); }, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } });
	const stream = Object.assign(new EventEmitter(), { writableLength: 0, write: s => { input.push(s); return true; } });
	const session = runGatewaySession({ ws, channel: { stream, detach: () => { detaches++; }, resize: async geometry => { resized.push(geometry); await resize(geometry); } }, store: { renewAttachment: renew, release: async () => ({ ok: true }) }, intent: { intentId: "intent", target: {} }, connectionId: "connection", browserHash: "browser", authRemainingMs: 5000, idleMinutes, runtime: { inspect }, audit: async (...a) => { audits.push(a); }, now: () => at, setTimer: fn => (timer = fn, {}), clearTimer: () => {}, onEnd: result => { ends.push(result); } });
	return { ws, stream, session, sends, input, audits, ends, resized, setAt: value => { at = value; }, timer: () => timer(), get detaches() { return detaches; } };
}
test("input, control characters and binary output cross the live lease without being logged or interpreted", async () => {
	const f = fixture(); f.ws.emit("message", Buffer.from(JSON.stringify({ type: "input", data: "echo PRIVATE\r\u0003" })), false); f.stream.emit("data", Buffer.from("\x1b[31mPRIVATE\x1b[0m"));
	assert.deepEqual(f.input, ["echo PRIVATE\r\u0003"]); assert.equal(f.sends[0].toString(), "\x1b[31mPRIVATE\x1b[0m");
	await f.session.finish(); assert.doesNotMatch(JSON.stringify(f.audits), /PRIVATE/); assert.equal(f.detaches, 1);
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
