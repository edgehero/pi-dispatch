import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { startReceiver } from "../src/start.mjs";

const AT = Date.UTC(2026, 10, 1);
function fixture(overrides = {}) {
	const dir = tempDir("receiver-status-start-");
	const path = join(dir, "triggers.json"); writeFileSync(path, '{"triggers":[]}');
	const env = { PI_TRIGGERS_FILE: path, GITHUB_AUTH_SOURCE: "gh", WEBHOOK_SECRET: "secret", PI_WORKER_NAME: "mini1", ...overrides };
	const closers = []; const log = []; const events = []; let published;
	const server = { address: () => ({ address: "::ffff:127.0.0.1", port: 49155 }), listen(_port, _bind, cb) { events.push("listen"); cb(); }, close(cb) { cb?.(); } };
	const queue = { client: Promise.resolve({}), close: async () => events.push("queue-close") };
	const deps = { now: () => AT, closers, write: (line) => log.push(JSON.parse(line)), judgeValkey: async () => {}, makeAuth: async () => ({ selfId: 999, source: "gh" }), makeQueueFn: () => queue, makeForgeRouterFn: () => ({ close: async () => {} }), createServer: () => server,
		makeReceiverPublisherFn: (options) => { published = options; events.push("publisher"); return { start: () => events.push("start"), close: () => events.push("stop") }; } };
	return { env, deps, closers, server, queue, log, events, published: () => published };
}

test("publication starts only after successful listen, using the socket rather than the configured bind/port (#775)", async () => {
	const f = fixture();
	try {
		await startReceiver(f.env, f.deps);
		assert.deepEqual(f.events.slice(0, 3), ["listen", "publisher", "start"]);
		const p = f.published(); assert.equal(p.name, "mini1"); assert.equal(p.port, 49155); assert.equal(p.bind, "loopback"); assert.deepEqual(p.forges, ["github"]);
		assert.equal(await p.client(), await f.queue.client); assert.equal(typeof p.observations.observe, "function"); assert.equal(p.now(), AT);
	} finally { for (const c of f.closers) c.close(); }
});

test("a refused listen creates no publisher or timer; invalid telemetry names preserve receiver startup (#775)", async () => {
	const refused = fixture(); refused.server.listen = () => { throw new Error("listen refused"); };
	await assert.rejects(startReceiver(refused.env, refused.deps), /listen refused/);
	assert.equal(refused.published(), undefined); assert.equal(refused.closers.length, 0);
	const invalid = fixture({ PI_WORKER_NAME: "invalid/name" });
	try {
		assert.equal(await startReceiver(invalid.env, invalid.deps), invalid.server);
		assert.equal(invalid.published(), undefined);
		assert.deepEqual(invalid.log.filter((r) => r.event === "receiver_status_unavailable"), [{ event: "receiver_status_unavailable", reason: "identity-or-socket" }]);
	} finally { for (const c of invalid.closers) c.close(); }
});

test("shutdown stops the receiver's shared-client publisher before disconnecting that client (#775)", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
	const shutdown = source.slice(source.indexOf("const shutdown ="), source.indexOf('process.once("SIGTERM"'));
	assert.ok(shutdown.indexOf("receiverPublisher?.close()") < shutdown.indexOf("await queue.close()"));
	assert.ok(shutdown.indexOf("receiverPublisher?.close()") > shutdown.indexOf("server.close(resolve)"));
});
