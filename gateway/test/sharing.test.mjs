import assert from "node:assert/strict";
import { test } from "node:test";
import { makeSharingController } from "../src/sharing.mjs";
import { GATEWAY_LIMITS } from "../src/terminal-protocol.mjs";

const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture({ kind = "drive", audit = async () => {}, setWatching = null, acknowledgeRoster = null } = {}) {
	const sent = [], calls = [], failures = [], stopped = [];
	let live = true;
	const room = { driverConnectionId: "driver", enabled: false, rosterRevision: 0, geometry: { cols: 80, rows: 24, revision: 1 }, watchers: {} };
	const store = Object.fromEntries(["setWatching", "removeWatcher", "acknowledgeRoster", "updateGeometry"].map(method => [method, async args => {
		calls.push([method, args]);
		if (method === "setWatching" && setWatching) return setWatching(args, room);
		if (method === "acknowledgeRoster" && acknowledgeRoster) return acknowledgeRoster(args, room);
		if (method === "setWatching") { room.enabled = args.enabled; room.rosterRevision++; }
		return { ok: true, room };
	}]));
	const intent = { intentId: "intent", kind, ...(kind === "watch" ? { driver: { connectionId: "driver" } } : {}) };
	const ws = { readyState: 1, bufferedAmount: 0, send: value => sent.push(JSON.parse(value)) };
	const controller = makeSharingController({ store, intent, connectionId: kind === "watch" ? "watch" : "driver", browserHash: "browser", ws, authorized: () => live, fail: reason => { failures.push(reason); live = false; }, onLocalStop: change => stopped.push(change), audit: async (...args) => { calls.push(["audit", ...args]); await audit(...args); } });
	return { controller, sent, calls, failures, stopped, room, ws, end() { live = false; } };
}

test("sharing projections contain only safe names, monotonic revisions and geometry from the exact current driver", async () => {
	const f = fixture();
	f.room.watchers = { rawIntent: { watcherKey: "a".repeat(64), actor: { name: "alice", session: "SECRET", role: "operator" }, registeredRevision: 1, state: "pending", connectionId: "SECRET", expiresAt: 42 } };
	f.room.rosterRevision = 2;
	f.controller.observe(f.room);
	assert.deepEqual(f.sent, [{ type: "sharing", enabled: false, revision: 2, watchers: [{ watcherKey: "a".repeat(64), name: "alice", state: "pending" }] }]);
	f.controller.observe({ ...f.room, rosterRevision: 1, enabled: true }, true);
	assert.equal(f.sent.length, 1, "a delayed control response cannot regress a newer observed roster");
	assert.throws(() => f.controller.observe({ ...f.room, driverConnectionId: "replacement" }), /driver-ended/);
	assert.doesNotMatch(JSON.stringify(f.sent), /SECRET|rawIntent|expiresAt|session/);
	const w = fixture({ kind: "watch" }); w.controller.observe(w.room);
	w.controller.observe({ ...w.room, geometry: { cols: 100, rows: 30, revision: 2 } });
	w.controller.observe(w.room, true);
	assert.deepEqual(w.sent, [{ type: "geometry", cols: 80, rows: 24, revision: 1 }, { type: "geometry", cols: 100, rows: 30, revision: 2 }]);
	for (const message of [{ type: "watch-policy", enabled: true }, { type: "watch-remove", watcherKey: "a".repeat(64) }, { type: "sharing-seen", revision: 1 }]) assert.equal(w.controller.handle(message), false);
	assert.deepEqual(w.calls, [], "a watch cannot invoke any driver control, even with a well-formed frame");
});

test("driver controls serialize intent, storage and applied receipts; off and remove stop local watches before a stalled write", async () => {
	const gate = defer(), entered = defer();
	const f = fixture({ setWatching: async (args, room) => { entered.resolve(); await gate.promise; room.enabled = args.enabled; room.rosterRevision++; return { ok: true, room }; } });
	assert.equal(f.controller.handle({ type: "watch-policy", enabled: false }), true);
	assert.deepEqual(f.stopped, [{ reason: "watch-disabled" }]);
	await entered.promise;
	assert.equal(f.controller.handle({ type: "watch-remove", watcherKey: "b".repeat(64) }), true);
	assert.deepEqual(f.stopped[1], { reason: "watch-removed", watcherKey: "b".repeat(64) });
	assert.equal(f.calls.some(c => c[0] === "removeWatcher"), false);
	gate.resolve(); await f.controller.settled;
	assert.deepEqual(f.calls.map(c => c[0] === "audit" ? `${c[0]}:${c[1]}` : c[0]), ["audit:policy-intent", "setWatching", "audit:policy", "audit:remove-intent", "removeWatcher", "audit:remove"]);
	assert.equal(f.sent.at(-1).enabled, false);
	assert.deepEqual(f.failures, []);
});

test("failed accounting prevents enable while revocation still applies; unavailable control never reports success", async () => {
	for (const enabled of [true, false]) {
		const f = fixture({ audit: async () => { throw new Error("PRIVATE audit location"); } });
		f.controller.handle({ type: "watch-policy", enabled }); await f.controller.settled;
		assert.equal(f.calls.filter(c => c[0] === "setWatching").length, enabled ? 0 : 1);
		assert.deepEqual(f.failures, ["audit-unavailable"]);
		assert.deepEqual(f.sent, []);
	}
	const f = fixture({ setWatching: async () => ({ refused: "driver-ended" }) });
	f.controller.handle({ type: "watch-policy", enabled: false }); await f.controller.settled;
	assert.deepEqual(f.stopped, [{ reason: "watch-disabled" }]);
	assert.deepEqual(f.failures, ["authorization-unavailable"]); assert.deepEqual(f.sent, []);
	const g = fixture();
	for (const m of [{ type: "sharing-seen", revision: -1 }, { type: "sharing-seen", revision: Infinity }, { type: "watch-policy", enabled: true, target: "other" }, { type: "watch-remove", watcherKey: "b".repeat(63) }]) assert.equal(g.controller.handle(m), false);
	assert.equal(g.controller.handle({ type: "sharing-seen", revision: 3 }), true);
	g.end(); await g.controller.settled;
	assert.deepEqual(g.calls, [], "queued controls do not execute after local authority ends");
});

test("serialized controls stay bounded across frame-rate windows and queued effects disappear after saturation", async () => {
	const gate = defer(), entered = defer();
	const f = fixture({ acknowledgeRoster: async (_args, room) => { entered.resolve(); await gate.promise; return { ok: true, room }; } });
	f.controller.handle({ type: "sharing-seen", revision: 0 }); await entered.promise;
	// No clock window owns this bound. Even independently rate-allowed batches accumulate
	// in the same finite queue while the first write remains in flight.
	for (let n = 1; n < GATEWAY_LIMITS.framesPerSecond; n++) assert.equal(f.controller.handle({ type: "sharing-seen", revision: n }), true);
	assert.equal(f.controller.pendingControls, GATEWAY_LIMITS.framesPerSecond);
	assert.equal(f.controller.handle({ type: "watch-policy", enabled: true }), true);
	assert.deepEqual(f.failures, ["protocol-error"]);
	assert.equal(f.controller.pendingControls, GATEWAY_LIMITS.framesPerSecond, "the rejected control adds no queue node");
	gate.resolve(); await f.controller.settled;
	assert.equal(f.controller.pendingControls, 0);
	assert.deepEqual(f.calls.map(c => c[0]), ["acknowledgeRoster"], "after the fail-closed end, neither queued writes nor policy audits run");
	assert.deepEqual(f.sent, []);
	assert.equal(f.controller.handle({ type: "watch-policy", enabled: false }), true);
	assert.deepEqual(f.stopped, [], "even immediate local control callbacks stop after authority ends");
});

test("metadata alone obeys output backpressure and send errors end the attachment without replay", () => {
	for (const kind of ["drive", "watch"]) {
		const f = fixture({ kind }); f.ws.bufferedAmount = GATEWAY_LIMITS.bufferedBytes;
		f.controller.observe(f.room); assert.deepEqual(f.sent, []); assert.deepEqual(f.failures, ["backpressure"]);
	}
	for (const mode of ["throw", "callback"]) {
		const f = fixture(); f.ws.send = (_value, callback) => { if (mode === "throw") throw new Error("PRIVATE"); callback(new Error("PRIVATE")); };
		f.controller.observe(f.room); assert.deepEqual(f.failures, ["disconnected"]); assert.deepEqual(f.sent, []);
		f.controller.observe({ ...f.room, rosterRevision: 2 }); assert.deepEqual(f.failures, ["disconnected"], "no metadata retries after end");
	}
});
