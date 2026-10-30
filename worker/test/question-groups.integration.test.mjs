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
