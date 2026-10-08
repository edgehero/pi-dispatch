import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import { test } from "node:test";
import { boundedOp, withDoctorClient } from "../src/doctor.mjs";

// Doctor's own Valkey reads against a server that accepts the connection and never answers: each gives up within its
// bound and closes its socket, so doctor exits instead of waiting forever in ioredis's ready check.

async function silentServer() {
	const sockets = new Set();
	const server = net.createServer((s) => (sockets.add(s), s.on("error", () => {}), s.on("data", () => {})));
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	return {
		url: `redis://127.0.0.1:${port}/3`,
		port,
		close: () => {
			for (const s of sockets) s.destroy();
			server.close();
		},
	};
}
const openTo = (port) => process._getActiveHandles().filter((h) => h?.constructor?.name === "Socket" && !h.destroyed && h.remotePort === port).length;

test("withDoctorClient: a connection that is never ready is given up within its bound, and its socket is closed", { timeout: 15_000 }, async () => {
	const srv = await silentServer();
	try {
		let ran = false;
		const timers = () => process.getActiveResourcesInfo().filter((n) => n === "Timeout").length;
		const before = timers();
		const t0 = performance.now();
		await assert.rejects(() => withDoctorClient(srv.url, async () => (ran = true), { connectTimeoutMs: 200 }), /connect timeout/);
		assert.equal(ran, false, "nothing is asked of a connection that never became ready");
		assert.ok(performance.now() - t0 < 5000, "bounded, not waited out");
		assert.equal(openTo(srv.port), 0, "no socket left open");
		// ioredis's own disconnect timer (2 s by default) would hold the process past doctor's end: none is left once a
		// zero-length one has run.
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(timers(), before, "no timer left behind");
	} finally {
		srv.close();
	}
});

test("boundedOp: a command with no reply is a rejection after its bound", async () => {
	await assert.rejects(() => boundedOp(new Promise(() => {}), 20), /timeout/);
	assert.equal(await boundedOp(Promise.resolve(7), 20), 7);
});

test("BY SHAPE: every Valkey client doctor opens connects through a bound", () => {
	const src = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
	assert.deepEqual(src.match(/\.connect\(\)/g), [".connect()"], "the one bare connect() is inside connectWithin");
	assert.match(src, /export function connectWithin\([^)]*\) \{[\s\S]*?client\.connect\(\)/);
	for (const fn of ["defaultProbeValkey", "defaultReadAppliedSplit", "defaultReadHosts", "defaultDollarKeysExist"]) {
		const body = src.slice(src.indexOf(`function ${fn}(`), src.indexOf("\n}\n", src.indexOf(`function ${fn}(`)));
		assert.match(body, /withDoctorClient\(/, `${fn} opens its client through withDoctorClient`);
	}
	assert.match(src.slice(src.indexOf("function defaultProbeValkey(")), /boundedOp\(client\.ping\(\)/);
});
