import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { makeQuestionGroupStore } from "../src/question-groups.mjs";
import { makeZeroTouchFixStore } from "../src/zero-touch-fixes.mjs";
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("question-groups integration requires VALKEY_TEST_URL");
const skip = url ? false : "VALKEY_TEST_URL not set";
const nowMs = 1900000000000;
const scopeId = "a".repeat(64);
const hash = text => createHash("sha256").update(text).digest("hex");

test("two hosts share private exemplars and safe assignments; duplicate imports and stale concurrent groups are idempotent", { skip }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url), prefix = `test-question-${randomBytes(8).toString("hex")}:`;
	const hostA = makeQuestionGroupStore({ redis, prefix, now: () => nowMs }), hostB = makeQuestionGroupStore({ redis, prefix, now: () => nowMs });
	try {
		assert.equal((await hostA.capture({ runId: "host-a-1", scopeId, project: "api", repo: "acme/api", at: nowMs, text: "PRIVATE package manager question", redact: text => text })).ok, true);
		let input = await hostB.privateInput("host-a-1");
		assert.equal(input.excerpt, "PRIVATE package manager question");
		const first = await hostB.assign({ runId: "host-a-1", digest: input.meta.digest, revision: input.revision });
		assert.equal(first.status, "assigned");
		assert.equal((await hostA.assign({ runId: "host-a-1", digest: input.meta.digest, revision: 0 })).status, "existing");
		await hostB.capture({ runId: "host-b-1", scopeId, project: "api", repo: "acme/api", at: nowMs + 1, text: "PRIVATE same package question", redact: text => text });
		input = await hostA.privateInput("host-b-1");
		assert.equal(input.candidates[0].id, first.groupId);
		assert.equal(input.candidates[0].excerpt, "PRIVATE package manager question");
		assert.equal((await hostA.assign({ runId: "host-b-1", digest: input.meta.digest, revision: input.revision, groupId: "0".repeat(32) })).status, "stale", "a valid-shaped but nonexistent group is not accepted by Lua");
		assert.equal((await hostA.assign({ runId: "host-b-1", digest: input.meta.digest, revision: input.revision, groupId: first.groupId })).status, "assigned");
		assert.equal(await hostB.setStatus("host-b-1", "failed"), false, "late status cannot overwrite an assigned group");
		await hostA.capture({ runId: "race-a", scopeId, at: nowMs + 2, text: "PRIVATE race a", redact: text => text });
		await hostB.capture({ runId: "race-b", scopeId, at: nowMs + 3, text: "PRIVATE race b", redact: text => text });
		const [a, b] = await Promise.all([hostA.privateInput("race-a"), hostB.privateInput("race-b")]);
		const races = await Promise.all([hostA.assign({ runId: "race-a", digest: a.meta.digest, revision: a.revision }), hostB.assign({ runId: "race-b", digest: b.meta.digest, revision: b.revision })]);
		assert.deepEqual(races.map(row => row.status).sort(), ["assigned", "stale"]);
		const snapshot = await hostB.publicSnapshot({ names: { [first.groupId]: "Package manager" } });
		assert.ok(!JSON.stringify(snapshot).includes("PRIVATE"));
		assert.equal(snapshot.groups.find(group => group.id === first.groupId).count, 2);
		assert.equal(snapshot.groups.find(group => group.id === first.groupId).name, "Package manager");
		await redis.del(`${prefix}private:${hash("host-a-1")}`);
		await hostB.capture({ runId: "later", scopeId, at: nowMs + 4, text: "PRIVATE later", redact: text => text });
		assert.equal((await hostA.privateInput("later")).status, "candidates-expired", "expired exemplar cannot silently create a duplicate cluster");
		await redis.del(`${prefix}private:${hash("later")}`);
		assert.equal((await hostA.publicSnapshot()).rows.find(row => row.runId === "later").status, "source-expired");
	} finally { const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys); await redis.quit(); }
});
test("pending fix survives a lost completion write, stays partial and repairs only against exact confirmed trigger", { skip }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url), prefix = `test-fixes-${randomBytes(8).toString("hex")}:`;
	const store = makeZeroTouchFixStore({ redis, prefix, now: () => nowMs });
	const entry = { on: { type: "label", any: ["fix"] }, run: { kind: "github", flow: "fix", instructions: "Use pnpm." } };
	const undo = { index: 0, before: null, after: "Use pnpm.", triggerDigest: hash(JSON.stringify(entry)) };
	try {
		const staged = await store.stage({ kind: "instructions", runId: "source", scopeId, reason: "secret-unresolved", at: nowMs }, { privateUndo: undo, identity: "ticket-1" });
		assert.ok(staged.ok);
		assert.equal((await store.publicSnapshot()).pendingCount, 1);
		assert.equal((await store.publicSnapshot()).partial, true);
		assert.equal((await store.publicSnapshot()).fixes.length, 0);
		assert.equal((await store.read(staged.fix.id, { includeUndo: true })).undo.before, null);
		await store.repair({ readTrigger: async () => ({ ...entry, on: { type: "label", any: ["different"] } }) });
		assert.equal((await store.publicSnapshot()).pendingCount, 1);
		await store.repair({ readTrigger: async () => entry });
		assert.equal((await store.publicSnapshot()).pendingCount, 0);
		assert.equal((await store.publicSnapshot()).fixes.length, 1);
		assert.ok(!JSON.stringify(await store.publicSnapshot()).includes("Use pnpm"));
		const second = await store.stage({ kind: "config", runId: "refused", scopeId, reason: "secret-unresolved", at: nowMs }, { identity: "ticket-2" });
		await store.reject(second.fix.id);
		assert.equal((await store.publicSnapshot()).fixes.length, 1, "a refused write never becomes a fix");
		const afterFile = "reviewed setting bytes";
		const generic = await store.stage({ kind: "config", runId: "config-source", scopeId, reason: "secret-unresolved", at: nowMs }, { privateUndo: { file: "/approved/settings.json", afterDigest: hash(afterFile) }, identity: "ticket-3" });
		await store.repair({ readFile: async file => file === "/approved/settings.json" ? "changed" : null });
		assert.equal((await store.read(generic.fix.id)).state, "pending");
		await store.repair({ readFile: async file => file === "/approved/settings.json" ? afterFile : null });
		assert.equal((await store.read(generic.fix.id)).state, "applied");
	} finally { const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys); await redis.quit(); }
});

test("the repair never loses a change that was made: a pending row its file or trigger shows is committed, whatever other row carries the same bytes (#987)", { skip }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url);
	const file = "/approved/settings.json", x35 = "settings that read 35", x40 = "settings that read 40";
	const entry = { on: { type: "label", any: ["fix"] }, run: { kind: "github", flow: "fix", instructions: "Use pnpm." } };
	const undo = { index: 0, before: null, after: "Use pnpm.", triggerDigest: hash(JSON.stringify(entry)) };
	// Each history: its rows in time order (`made` is a change whose completion was written, `cut` one that was made and
	// whose completion was lost, so its row is pending), what the file or the trigger reads now, and what every row must
	// read after a repair. In each a change that was MADE shares its bytes with another row, and none may be lost.
	const config = (runId, bytes) => ({ value: { kind: "config", runId, scopeId, reason: "secret-unresolved" }, proof: { file, afterDigest: hash(bytes) } });
	const instruction = (runId) => ({ value: { kind: "instructions", runId, scopeId, reason: "secret-unresolved" }, proof: undo });
	const histories = [
		["35, 40, then 35 again with the third's completion lost", [["made", config("r1", x35)], ["made", config("r1", x40)], ["cut", config("r1", x35)]], { file: x35 }, ["applied", "applied", "applied"]],
		["the same, and then 40 and 35 once more", [["made", config("r1", x35)], ["made", config("r1", x40)], ["cut", config("r1", x35)], ["made", config("r1", x40)], ["made", config("r1", x35)]], { file: x35 }, ["applied", "applied", "applied", "applied", "applied"]],
		["made with its completion lost, put back by hand, made again", [["cut", config("r1", x35)], ["made", config("r1", x35)]], { file: x35 }, ["applied", "applied"]],
		["another refusal's fix writing the same value, its completion lost", [["made", config("r1", x35)], ["cut", config("r2", x35)]], { file: x35 }, ["applied", "applied"]],
		["an instruction saved again after an Undo whose mark was lost, its completion lost", [["made", instruction("q1")], ["cut", instruction("q1")]], { trigger: entry }, ["applied", "applied"]],
		["two changes of one millisecond with the same bytes, one completion lost", [["made", config("r1", x35)], ["cut-same-time", config("r1", x35)]], { file: x35 }, ["applied", "applied"]],
		// What the file does not show stays pending, as before: nothing is replayed and nothing is refused by guess.
		["a change whose completion was lost and whose file reads otherwise now", [["cut", config("r1", x35)]], { file: x40 }, ["pending"]],
	];
	try {
		for (const [what, rows, reads, expected] of histories) {
			const prefix = `test-fixes-${randomBytes(8).toString("hex")}:`;
			let t = nowMs;
			const store = makeZeroTouchFixStore({ redis, prefix, now: () => t });
			const staged = [];
			try {
				for (const [how, { value, proof }] of rows) {
					if (how !== "cut-same-time") t += 60_000;
					const row = await store.stage(value, { privateUndo: proof, identity: `ticket-${staged.length}` });
					assert.ok(row.ok, what);
					if (how === "made") assert.equal(await store.commit(row.fix.id), true, what);
					staged.push(row.fix.id);
				}
				t += 60_000;
				await store.repair({ readFile: async path => path === file && reads.file !== undefined ? reads.file : null, readTrigger: async () => reads.trigger });
				assert.deepEqual(await Promise.all(staged.map(async id => (await store.read(id)).state)), expected, what);
				const snapshot = await store.publicSnapshot();
				const open = expected.filter(state => state === "pending").length;
				assert.deepEqual([snapshot.fixes.length, snapshot.pendingCount, snapshot.partial], [expected.length - open, open, open > 0], what);
			} finally { const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys); }
		}
	} finally { await redis.quit(); }
});
