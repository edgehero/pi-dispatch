import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { main } from "../src/cli.mjs";
import { parseSemanticItem, semanticItemOf, semanticItemOfId } from "../src/forges.mjs";

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("target-status integration REQUIRES VALKEY_TEST_URL");
const skip = url ? false : "VALKEY_TEST_URL not set; CI requires these tests";

test("an item as typed is the item the queue's dedup id begins with, and nothing that could widen a SCAN", () => {
	assert.equal(parseSemanticItem("owner/repo#12"), "owner/repo#12");
	assert.equal(parseSemanticItem("group/sub/project!007"), "group/sub/project!7", "a number's leading zeros are dropped, as the worker writes it");
	assert.equal(parseSemanticItem("org/project/repo#0"), "org/project/repo#0");
	for (const bad of ["owner/repo", "owner/repo#", "owner/repo#12a", "own er/repo#1", "owner/repo:x#1", "owner/*#1", "owner/r?#1", "owner/[r]#1", "owner\\r#1", "o#r#1", "o/r#1\n", "", "#1", null, 12]) {
		assert.equal(parseSemanticItem(bad), null, JSON.stringify(bad));
	}
	// The builder, the parser of a stored id and the typed item agree.
	const item = semanticItemOf("gitlab", "g/p", { type: "pull_request", number: 7 });
	assert.equal(item, "g/p!7");
	assert.equal(semanticItemOf("github", "o/r", { type: "pull_request", number: 7 }), "o/r#7", "GitHub numbers issues and pull requests from one sequence");
	assert.equal(semanticItemOfId(`${item}:closed:cmd:lint:r2`), item);
	assert.equal(semanticItemOfId("no-item"), null);
	assert.equal(parseSemanticItem("g/p!7"), item);
	assert.throws(() => semanticItemOf("github", "o/r", undefined), TypeError, "a forge job with no target is a caller's bug");
});

test("the dedup id's item has one spelling: the queue, the console and the CLI ask forges.mjs", () => {
	const queue = readFileSync(new URL("../src/queue.mjs", import.meta.url), "utf8");
	assert.match(queue, /const dedupId = `\$\{semanticItemOf\(kind, repo, target\)\}:/);
	const console = readFileSync(new URL("../../admin/src/read-model.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(console, /\[#!\]\\d\{1,30\}\):/, "no second copy of the item's grammar in the console");
	assert.match(console, /semanticItemOfId\(/);
});

test("status --target refuses an item it cannot read, and the flag belongs to status alone", async () => {
	for (const bad of ["owner/repo", "https://github.com/owner/repo/issues/1", "owner/*#1"]) {
		let err = "";
		const original = process.stderr.write;
		process.stderr.write = (chunk) => ((err += chunk), true);
		try {
			assert.equal(await main(["status", "--target", bad, "--valkey-url", "redis://127.0.0.1:1"], {}, { write: () => {}, valkeyRefusal: async () => assert.fail("refused before Valkey") }), 1);
		} finally {
			process.stderr.write = original;
		}
		assert.match(err, /--target takes an issue or pull request as the queue names it: owner\/repo#12/);
	}
	for (const cmd of ["pause", "resume"]) assert.equal(await main([cmd, "--target", "o/r#1", "--valkey-url", "redis://127.0.0.1:1"], {}, { write: () => {}, valkeyRefusal: async () => assert.fail("never reached") }), 1, cmd);
});

async function world(t) {
	const { Worker } = await import("bullmq");
	const { parseConnection } = await import("../src/connection.mjs");
	const { enqueueForgeJob, makeQueue } = await import("../src/queue.mjs");
	const connection = parseConnection(url);
	const q = makeQueue(connection, { name: `pi-jobs-target-${randomUUID()}` });
	const w = new Worker(q.name, async () => {}, { connection, autorun: false });
	t.after(async () => { await w.close(); await q.obliterate({ force: true }); await q.close(); });
	const add = (id, number, flow) => enqueueForgeJob(q, "github", { repo: "owner/repo", target: { type: "issue", number, title: "private title", body: "private body" }, flow, trigger: { event: "issues", action: "labeled", deliveryId: id, sender: { id: 1 } } });
	const finish = async (result) => {
		const token = randomUUID();
		const job = await w.getNextJob(token, { block: false });
		await job.moveToCompleted(result, token, false);
		return job;
	};
	return { q, w, add, finish, connection };
}

test("the reader lists the item's jobs and windows, and what a new request for each flow would do", { skip }, async (t) => {
	const { readTargetStatus } = await import("../src/target-status.mjs");
	const { q, add, finish } = await world(t);
	const review = await add("review", 7, "review");
	await finish({ outcome: "policy", reason: "secret-bundle-trigger-changed", budgetReserved: false, extra: "never printed" });
	await add("fix", 7, "fix");
	await add("other", 70, "fix"); // `owner/repo#70` begins with `owner/repo#7`: the `:` after the item keeps it out
	const at = Date.now();
	const read = await readTargetStatus([q], "owner/repo#7", { now: () => at });
	assert.equal(read.complete, true);
	assert.deepEqual(read.unavailableQueues, []);
	assert.deepEqual(read.jobs, [{ id: "gh-fix", queue: q.name, state: "waiting", kind: "github", slot: "fix" }]);
	const bySlot = Object.fromEntries(read.windows.map((w) => [w.slot, w]));
	assert.deepEqual(Object.keys(bySlot).sort(), ["fix", "review"]);
	assert.equal(bySlot.fix.owner, "gh-fix");
	assert.equal(bySlot.fix.ownerState, "waiting");
	assert.equal(bySlot.fix.newRequest, "joined");
	assert.equal(bySlot.review.owner, review.jobId);
	assert.equal(bySlot.review.ownerState, "completed");
	assert.equal(bySlot.review.outcome, "policy");
	assert.equal(bySlot.review.reason, "secret-bundle-trigger-changed");
	assert.equal(bySlot.review.newRequest, "dropped");
	for (const w of read.windows) {
		const closes = Date.parse(w.closesAt);
		assert.ok(closes > at && closes <= at + 10 * 60 * 1000, w.slot);
	}
	assert.equal(JSON.stringify(read).includes("private"), false, "never a payload");
	assert.equal(JSON.stringify(read).includes("never printed"), false, "only an outcome's tokens");
	assert.deepEqual((await readTargetStatus([q], "owner/repo#8", { now: () => at })), { item: "owner/repo#8", jobs: [], windows: [], complete: true, unavailableQueues: [] });
});

test("a queue that does not answer makes the read incomplete, never an empty all-clear", { skip }, async (t) => {
	const { readTargetStatus } = await import("../src/target-status.mjs");
	const { q } = await world(t);
	const dead = { name: "pi-jobs@dead", client: Promise.reject(new Error("private connection detail")) };
	dead.client.catch(() => {});
	const read = await readTargetStatus([q, dead], "owner/repo#7");
	assert.equal(read.complete, false);
	assert.deepEqual(read.unavailableQueues, ["pi-jobs@dead"]);
	assert.equal(JSON.stringify(read).includes("private"), false);
});

test("pi-dispatch status --target prints one JSON line over the deployment's queues", { skip }, async (t) => {
	const { q, add } = await world(t);
	await add("fix", 7, "fix");
	let output = "";
	const code = await main(["status", "--target", "owner/repo#007", "--valkey-url", url], {}, {
		now: () => new Date(),
		write: (text) => { output += text; }, valkeyRefusal: async () => null,
		controlClients: {
			// Discovery finds the shared queue alone; it is this test's own, so CI's shared Valkey is never read as `pi-jobs`.
			makeRedisClient: () => ({ on() {}, disconnect() {}, async smembers() { return []; }, async scan() { return ["0", []]; } }),
			makeQueue: (connection, { name }) => {
				assert.equal(name, "pi-jobs");
				return new (q.constructor)(q.name, { connection: q.opts.connection });
			},
		},
	});
	assert.equal(code, 0);
	const lines = output.trim().split("\n");
	assert.equal(lines.length, 1);
	const result = JSON.parse(lines[0]);
	assert.equal(result.item, "owner/repo#7");
	assert.equal(result.complete, true);
	assert.deepEqual(result.jobs.map((j) => j.id), ["gh-fix"]);
	assert.deepEqual(result.windows.map((w) => [w.slot, w.newRequest]), [["fix", "joined"]]);
});
