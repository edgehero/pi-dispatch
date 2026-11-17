import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";
import { buildDisplay } from "../../build-display.mjs";
import { withDisplay } from "../../display/with-display.mjs";
import { WIDTH, HEIGHT, pixelsProblem } from "../../display/pixels.mjs";

test("the derived build preserves all base capabilities and builds the inspected ID, even if its tag moves", () => {
	for (const status of [0, 1]) {
		const calls = [];
		const id = `sha256:${"a".repeat(64)}`;
		const result = buildDisplay({ base: "base:1", tag: "derived:1", bin: "podman", pid: 42, run: (bin, args) => {
			assert.equal(bin, "podman");
			calls.push(args);
			if (args[0] === "image" && args[1] === "inspect") return { status: 0, stdout: JSON.stringify({ Id: id, Config: { Labels: { "dev.pi-dispatch.capabilities": "anyUid,sandboxLayout,display,futureCapability" } } }) };
			return { status: args[0] === "build" ? status : 0 };
		} });
		assert.equal(result, status);
		assert.deepEqual(calls[1].slice(0, 2), ["tag", id]);
		const pinned = calls[1][2];
		assert.ok(calls[2].includes(`BASE=${pinned}`));
		assert.ok(calls[2].includes("CAPABILITIES=anyUid,sandboxLayout,display,futureCapability"));
		assert.ok(calls[2].includes("--pull=false"));
		assert.deepEqual(calls[3], ["image", "rm", pinned]);
	}
	assert.throws(() => buildDisplay({ base: "absent:1", tag: "derived:1", run: () => ({ status: 1 }) }), /already be present/);
});

test("the pinned Playwright PNG decoder reads the actual pixels, including negative fixtures", () => {
	const { PNG } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle");
	const data = Buffer.alloc(WIDTH * HEIGHT * 4, 255);
	const picture = { width: WIDTH, height: HEIGHT, data };
	assert.equal(pixelsProblem(PNG.sync.read(PNG.sync.write(picture))), "screenshot-blank");
	for (let y = 260; y < 380; y++) for (let x = 40; x < 280; x++) data.set([22, 131, 74, 255], (y * WIDTH + x) * 4);
	assert.equal(pixelsProblem(picture), "text-not-rendered");
	for (let y = 40; y < 60; y++) for (let x = 50; x < 100; x++) data.set([17, 17, 17, 255], (y * WIDTH + x) * 4);
	assert.equal(pixelsProblem(PNG.sync.read(PNG.sync.write(picture))), null);
	assert.equal(pixelsProblem({ ...picture, width: 1 }), "screenshot-invalid");
	data.set([192, 40, 40, 255], (280 * WIDTH + 60) * 4);
	assert.equal(pixelsProblem(picture), "screenshot-blank", "an unclicked page fails");
});

function harness({ display = "ready", exit = 7, appError = false, stop = false } = {}) {
	const calls = [];
	const killed = [];
	const signals = new EventEmitter();
	const spawnFn = (bin, args, options) => {
		calls.push({ bin, args, options });
		const child = new EventEmitter();
		child.pid = calls.length + 100;
		child.exitCode = null;
		child.stdio = [null, null, null, new EventEmitter()];
		queueMicrotask(() => {
			if (bin === "Xvfb") {
				if (display === "ready") child.stdio[3].emit("data", Buffer.from("17\n"));
				else if (display === "malformed") child.stdio[3].emit("data", Buffer.from("bad\n"));
				else child.emit("error", new Error("missing"));
			} else {
				if (stop) signals.emit("SIGTERM");
				child.emit(appError ? "error" : "exit", appError ? new Error("missing") : exit);
			}
		});
		return child;
	};
	return { calls, killed, signals, options: { spawnFn, signals, env: { HOME: "/home/pi", EXAMPLE: "kept" }, killFn: (...args) => killed.push(args) } };
}

test("the display wrapper waits for readiness, inherits application env, and preserves its exit code", async () => {
	const h = harness();
	assert.equal(await withDisplay("suite", ["a b"], h.options), 7);
	assert.ok(h.calls[0].args.includes("-displayfd"));
	assert.ok(h.calls[0].args.includes("-nolisten"));
	assert.deepEqual(h.calls[1].args, ["a b"]);
	assert.deepEqual(h.calls[1].options.env, { HOME: "/home/pi", EXAMPLE: "kept", DISPLAY: ":17" });
	assert.deepEqual(h.killed.map(([pid]) => pid), [-102, -101]);
	assert.equal(h.signals.listenerCount("SIGTERM"), 0);
});

for (const display of ["missing", "malformed"]) test(`display ${display} never starts the application`, async () => {
	const h = harness({ display });
	assert.equal(await withDisplay("suite", [], h.options), 70);
	assert.equal(h.calls.length, 1);
	assert.equal(h.killed.length, 1);
});

test("missing application and interruption clean up both process groups", async () => {
	for (const [options, expected] of [[{ appError: true }, 127], [{ stop: true }, 143]]) {
		const h = harness(options);
		assert.equal(await withDisplay("suite", [], h.options), expected);
		assert.ok(h.killed.some(([pid]) => pid === -101));
		assert.ok(h.killed.some(([pid]) => pid === -102));
	}
});

test("readiness timeout and a disappearing display stop the suite", async () => {
	const h = harness();
	let expire;
	// A clock seam makes the readiness deadline independent of host scheduling.
	const stalled = new EventEmitter();
	stalled.pid = 200;
	stalled.exitCode = null;
	stalled.stdio = [null, null, null, new EventEmitter()];
	const pending = withDisplay("suite", [], { ...h.options, spawnFn: () => stalled, setTimer: (fn) => { expire = fn; return 1; }, clearTimer: () => {} });
	expire();
	assert.equal(await pending, 70);
	assert.ok(h.killed.some(([pid]) => pid === -200));
	for (const interrupted of [false, true]) {
		let display;
		const fresh = harness();
		const code = await withDisplay("suite", [], { ...fresh.options, spawnFn: (bin, args, opts) => {
			if (bin === "Xvfb") return display = fresh.options.spawnFn(bin, args, opts);
			const app = new EventEmitter();
			app.pid = 300;
			queueMicrotask(() => { if (interrupted) fresh.signals.emit("SIGTERM"); display.emit("exit", 1); });
			return app;
		} });
		assert.equal(code, interrupted ? 143 : 70);
		assert.ok(fresh.killed.some(([pid]) => pid === -300));
	}
});
