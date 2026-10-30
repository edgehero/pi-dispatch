import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { QueueEvents } from "bullmq";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeRedisClient, parseConnection } from "../src/connection.mjs";
import { makeQueue, hostQueueName } from "../src/queue.mjs";
import { createSandboxPreparer, planSandboxPreparation, sandboxTriggerDigest } from "../src/sandbox-prepare.mjs";
import { enqueueSandboxPreparation, makeSandboxPrepareQueue, readSandboxPreparation, sandboxPrepareQueueName, sandboxPrepareSlotKey, startSandboxPrepareWorker, SANDBOX_PREPARE_PENDING_MAX } from "../src/sandbox-prepare-requests.mjs";
import { makeSandboxInventory, readSandboxInventories, SANDBOX_INVENTORY_HOSTS, sandboxInventoryKey } from "../src/sandbox-inventory.mjs";
import { makeSandboxTelemetry } from "../src/host-telemetry.mjs";
import { listSandboxes, sandboxDeadline } from "../src/sandbox-store.mjs";

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("sandbox preparation integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
const skip = url ? false : "VALKEY_TEST_URL not set; sandbox preparation integration skipped locally";
const text = JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:human"] }, run: { kind: "github", flow: "fix", image: "job:human" } }] });

async function world(t) {
	const host = `sandbox-test-${randomBytes(8).toString("hex")}`;
	const root = tempDir("sandbox-prepare-integration-");
	const config = { workerName: host, backends: ["local"], defaultBackend: "local", jobImage: "job:default", sandboxRetentionHours: 24, sandboxPinDays: 7, sandboxDir: join(root, "sandboxes"), jobsDir: join(root, "jobs"), egress: true, egressProxy: "pi-dispatch-egress", github: { source: "app" } };
	const connection = parseConnection(url);
	const queue = makeSandboxPrepareQueue(connection, { host });
	const paid = makeQueue(connection, { name: hostQueueName(host) });
	const events = new QueueEvents(sandboxPrepareQueueName(host), { connection });
	const redis = makeRedisClient(url);
	const workers = [];
	const clock = () => Date.now();
	let clones = 0;
	const prepare = createSandboxPreparer({ config, env: {}, readTriggers: () => text, projects: () => [], limits: () => [], now: clock, observe: async () => ({ jobUser: null }), forgeFor: () => ({ auth: { mintToken: async () => "private-clone-credential" } }), clone: async ({ workspace }) => { clones++; fs.mkdirSync(workspace, { recursive: true }); fs.writeFileSync(join(workspace, "human"), "kept code"); return { sha: "a".repeat(40) }; } });
	const request = (n) => {
		const raw = { id: `sb-${n.toString(16).padStart(32, "0")}`, host, by: "operator", repo: "owner/repo", ref: "HEAD", triggerIndex: 0, triggerDigest: sandboxTriggerDigest(text, 0), pin: false };
		return { ...raw, planDigest: planSandboxPreparation({ request: raw, config, env: {}, triggersText: text }).plan.planDigest };
	};
	const start = (prep = prepare, workerOptions = {}) => { const worker = startSandboxPrepareWorker({ connection, host, prepare: prep, config, now: clock, workerOptions }); workers.push(worker); return worker; };
	t.after(async () => {
		for (const worker of workers) await worker.close(true).catch(() => {});
		await events.close().catch(() => {});
		await queue.obliterate({ force: true }).catch(() => {});
		await paid.obliterate({ force: true }).catch(() => {});
		for (let i = 0; i < SANDBOX_PREPARE_PENDING_MAX; i++) await redis.del(sandboxPrepareSlotKey(host, i));
		await redis.del(sandboxInventoryKey(host));
		await redis.srem(SANDBOX_INVENTORY_HOSTS, host);
		await queue.close().catch(() => {});
		await paid.close().catch(() => {});
		redis.disconnect();
	});
	await events.waitUntilReady();
	return { config, host, connection, queue, paid, events, redis, request, prepare, start, clones: () => clones, now: clock };
}

test("a confirmed request persists until its host starts, prepares outside paid queues and publishes a durable kept inventory", { skip }, async (t) => {
	const w = await world(t);
	const req = w.request(1);
	assert.equal((await enqueueSandboxPreparation(w.queue, req, { now: w.now })).state, "pending");
	assert.equal((await readSandboxPreparation(w.queue, req.id)).state, "pending");
	assert.equal(w.clones(), 0, "enqueue does no clone, credential resolution or container work");
	w.start();
	const job = await w.queue.getJob(req.id);
	const result = await job.waitUntilFinished(w.events, 10_000);
	assert.equal(result.id, req.id);
	assert.equal(w.clones(), 1);
	assert.equal((await readSandboxPreparation(w.queue, req.id)).state, "ready");
	assert.equal((await enqueueSandboxPreparation(w.queue, req, { now: w.now })).existing, true);
	assert.equal(w.clones(), 1);
	const counts = await w.paid.getJobCounts("waiting", "active", "completed", "failed", "delayed");
	assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 0, "the control request took no ordinary run slot or history entry");
	assert.equal(await w.redis.get(sandboxPrepareSlotKey(w.host, job.data.slot)), null, "successful request released its claim");
	const read = makeSandboxTelemetry({ list: () => listSandboxes({ sandboxDir: w.config.sandboxDir }), deadline: sandboxDeadline, retentionHours: 24, now: w.now });
	const inventory = makeSandboxInventory({ redis: w.redis, host: w.host, read, now: w.now });
	await inventory.publish();
	await inventory.close();
	const host = (await readSandboxInventories(w.redis, { now: w.now })).hosts.find((h) => h.name === w.host);
	assert.equal(host.rows[0].id, req.id);
	assert.equal(host.rows[0].prepared, true);
	assert.ok(await w.redis.pttl(sandboxInventoryKey(w.host)) > 0);
});

test("lost completion after publishing recovers on a new control worker without cloning or minting twice", { skip }, async (t) => {
	const w = await world(t);
	let published;
	const completedDisk = new Promise((resolve) => { published = resolve; });
	const first = w.start(async (request) => { await w.prepare(request); published(); return new Promise(() => {}); }, { lockDuration: 150, stalledInterval: 150, skipLockRenewal: true });
	await first.waitUntilReady();
	const req = w.request(2);
	await enqueueSandboxPreparation(w.queue, req, { now: w.now });
	await Promise.race([completedDisk, new Promise((_, reject) => setTimeout(() => reject(new Error("first preparation did not publish")), 5_000).unref())]);
	await first.close(true);
	w.start(w.prepare, { lockDuration: 500, stalledInterval: 150 });
	const job = await w.queue.getJob(req.id);
	const result = await job.waitUntilFinished(w.events, 10_000);
	assert.equal(result.id, req.id);
	assert.equal(w.clones(), 1, "the final manifest is the retry's idempotency evidence");
	assert.equal(listSandboxes({ sandboxDir: w.config.sandboxDir }).length, 1);
});

test("concurrent requests cannot exceed the pending bound, and a wrong-host request is never served", { skip }, async (t) => {
	const w = await world(t);
	const results = await Promise.all(Array.from({ length: 40 }, (_, i) => enqueueSandboxPreparation(w.queue, w.request(i + 10), { now: w.now })));
	assert.equal(results.filter((r) => r.state === "pending").length, SANDBOX_PREPARE_PENDING_MAX);
	assert.equal(results.filter((r) => r.refused === "sandbox-preparation-full").length, 8);
	assert.equal((await enqueueSandboxPreparation(w.queue, { ...w.request(100), host: "somewhere-else" }, { now: w.now })).refused, "sandbox-host-mismatch");
	assert.equal(w.clones(), 0);
});
