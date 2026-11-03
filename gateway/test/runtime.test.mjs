import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { makeGatewayRuntime } from "../src/runtime.mjs";

const target = { host: "host-a", id: "run:one", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "podman" };
const inspected = () => ({ Id: target.containerId, Name: "/pi-sandbox-run_one", Config: { Tty: true, OpenStdin: true, Labels: { "org.pi-dispatch.sandbox-session": target.nonce } }, State: { Running: true } });
test("the maintained adapter reaches only the reviewed Unix socket, immutable id and three allowed operations", async () => {
	const calls = [], stream = new PassThrough();
	const runtime = makeGatewayRuntime({ sockets: { podman: "/run/user/1001/podman.sock" }, clientFactory: options => { calls.push(["client", options]); return { modem: { dial: (opts, callback) => { calls.push(["attach", opts]); callback(null, stream); } }, getContainer: id => { calls.push(["id", id]); return { inspect: async () => (calls.push(["inspect"]), inspected()), attach: async opts => (calls.push(["unexpected-attach", opts]), stream), resize: async opts => { calls.push(["resize", opts]); } }; } }; } });
	const channel = await runtime.attach(target, { cols: 91, rows: 23 });
	await channel.resize({ cols: 80, rows: 24 });
	assert.deepEqual(calls[0], ["client", { socketPath: "/run/user/1001/podman.sock", version: "v1.40" }]);
	assert.ok(calls.filter(c => c[0] === "id").every(c => c[1] === target.containerId));
	assert.equal(calls.find(c => c[0] === "attach")[1].options.logs, false);
	assert.equal(calls.find(c => c[0] === "attach")[1].hijack, true);
	assert.equal(calls.filter(c => c[0] === "resize").length, 2);
	channel.detach(); assert.equal(stream.read(), null); assert.equal(stream.destroyed, true, "detachment never writes readline input");
	assert.ok(calls.every(c => ["client", "id", "inspect", "attach", "resize"].includes(c[0])));
});

test("wrong identity, job containers, non-TTY and unknown observations cannot attach or select another endpoint", async () => {
	for (const change of [c => { c.Id = "c".repeat(64); }, c => { c.Name = "/pi-job-run_one"; }, c => { c.Config.Labels = {}; }, c => { c.Config.Tty = false; }, c => { c.Config.OpenStdin = false; }, c => { c.State.Running = false; }]) {
		let attaches = 0; const c = inspected(); change(c);
		// Keep the production dial and resize path functional: a missing modem would make a
		// broken identity check reject for the wrong reason and let this counterexample pass.
		const runtime = makeGatewayRuntime({ sockets: { podman: "/fixed.sock" }, clientFactory: () => ({ modem: { dial: (_options, reply) => { attaches++; reply(null, new PassThrough()); } }, getContainer: () => ({ inspect: async () => c, resize: async () => {} }) }) });
		await assert.rejects(runtime.attach(target, { cols: 80, rows: 24 })); assert.equal(attaches, 0);
		assert.equal((await runtime.inspect({ ...target, venue: "openshell" })).refused, "runtime-unavailable");
	}
});
test("daemon loss before first resize completion becomes a named refusal instead of an unhandled stream error", async () => {
	const stream = new PassThrough(); let finishResize, entered;
	const resizing = new Promise(resolve => { entered = resolve; });
	const runtime = makeGatewayRuntime({ sockets: { podman: "/fixed.sock" }, clientFactory: () => ({ modem: { dial: (_opts, cb) => cb(null, stream) }, getContainer: () => ({ inspect: async () => inspected(), resize: () => { entered(); return new Promise(resolve => { finishResize = resolve; }); } }) }) });
	const opening = runtime.attach(target, { cols: 80, rows: 24 }); await resizing;
	stream.emit("error", new Error("daemon vanished")); finishResize();
	await assert.rejects(opening, /runtime-unavailable/); assert.equal(stream.destroyed, true);
});
test("a cancelled pending upgrade destroys a late socket rather than resurrecting an attachment", async () => {
	const stream = new PassThrough(); let reply, entered;
	const dialing = new Promise(resolve => { entered = resolve; }), controller = new AbortController();
	const runtime = makeGatewayRuntime({ sockets: { podman: "/fixed.sock" }, clientFactory: () => ({ modem: { dial: (_opts, cb) => { reply = cb; entered(); } }, getContainer: () => ({ inspect: async () => inspected(), resize: async () => {} }) }) });
	const opening = runtime.attach(target, { cols: 80, rows: 24, signal: controller.signal }); await dialing; controller.abort();
	await assert.rejects(opening, /runtime-unavailable/); reply(null, stream); assert.equal(stream.destroyed, true);
});

test("destroying a watch's read-only stream closes its transport, even while the daemon is silent", async () => {
	// An idle source parks the wrapper's iterator, so destroy() alone never reached the socket: an idle watch held a daemon
	// connection open and kept a process alive. Measured on real Docker before this was fixed.
	const stream = new PassThrough();
	const runtime = makeGatewayRuntime({ sockets: { podman: "/s.sock" }, clientFactory: () => ({ modem: { dial: (_options, callback) => callback(null, stream) }, getContainer: () => ({ inspect: async () => inspected() }) }) });
	const watch = await runtime.attachWatch(target);
	assert.equal(typeof watch.stream.write, "undefined", "a watch still exposes no way to write");
	watch.stream.on("error", () => {});
	watch.stream.destroy();
	for (let turn = 0; turn < 50 && !stream.destroyed; turn++) await new Promise(resolve => setImmediate(resolve));
	assert.equal(stream.destroyed, true);
});
