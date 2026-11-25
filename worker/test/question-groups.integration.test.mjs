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
		// Issue #1076: what a settle would commit, proved by reads alone; the Zero touch page asks this and writes nothing.
		assert.deepEqual(await store.settleable({ readTrigger: async () => ({ ...entry, on: { type: "label", any: ["different"] } }) }), { ready: [], refused: [], closed: [] });
		assert.deepEqual(await store.settleable({ readTrigger: async () => entry }), { ready: [staged.fix.id], refused: [], closed: [] });
		assert.deepEqual(await store.settleable({}), { ready: [], refused: [], closed: [] }, "with no proof to read, nothing is proved");
		assert.equal((await store.publicSnapshot()).pendingCount, 1, "proving commits nothing");
		assert.deepEqual(await store.repair({ readTrigger: async () => entry }), { settled: 1, refused: 0 });
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

test("a fix's record keeps the expiry its stage gave it, and the history reads an expired record as gone, never as a missing row (#1072)", { skip }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const { FIX_CLOCK_SKEW_MS } = await import("../src/zero-touch-fixes.mjs");
	const redis = makeRedisClient(url), prefix = `test-fixes-${randomBytes(8).toString("hex")}:`;
	let t = nowMs;
	const store = makeZeroTouchFixStore({ redis, prefix, now: () => t, retentionDays: 30 });
	const ttl = 30 * 86400000, DAY_MS = 86400000;
	const meta = id => `${prefix}meta:${id}`;
	const value = (runId, extra = {}) => ({ kind: "config", runId, scopeId, reason: "secret-unresolved", ...extra });
	try {
		// A mark keeps the record's expiry: commit, reject and Undo each rewrite the record and leave its TTL as it was,
		// where each gave it a whole new retention that its index entry did not get.
		const committed = await store.stage(value("kept-c"), { identity: "kept-c" });
		const rejected = await store.stage(value("kept-r"), { identity: "kept-r" });
		const undone = await store.add(value("kept-u"), { identity: "kept-u" });
		for (const row of [committed, rejected, undone]) {
			assert.ok(row.ok);
			const left = await redis.pttl(meta(row.fix.id));
			assert.ok(left > ttl - 60_000 && left <= ttl, "a stage gives its record the retention");
			await redis.pexpire(meta(row.fix.id), 120_000);
		}
		assert.equal(await store.commit(committed.fix.id), true);
		assert.equal(await store.reject(rejected.fix.id), true);
		assert.equal(await store.markUndone(undone.fix.id, t + 1), true);
		for (const row of [committed, rejected, undone]) {
			const left = await redis.pttl(meta(row.fix.id));
			assert.ok(left > 0 && left <= 120_000, `a mark keeps the record's expiry (${left} ms left)`);
		}
		assert.deepEqual([(await store.read(committed.fix.id)).state, (await store.read(rejected.fix.id)).state, (await store.read(undone.fix.id)).undoneAt], ["applied", "refused", t + 1]);

		// A record that expired between a mark's read and its write is not made again: the write lands only on a record
		// that still exists, and the mark answers that it wrote nothing.
		const late = await store.stage(value("late"), { identity: "late" });
		const expiring = new Proxy(redis, { get(target, name) {
			if (name !== "get") return typeof target[name] === "function" ? target[name].bind(target) : target[name];
			return async (key) => { const raw = await target.get(key); if (key === meta(late.fix.id)) await target.del(key); return raw; };
		} });
		const racing = makeZeroTouchFixStore({ redis: expiring, prefix, now: () => t, retentionDays: 30 });
		assert.equal(await racing.commit(late.fix.id), false, "a mark on a record that expired under it writes nothing");
		assert.equal(await redis.exists(meta(late.fix.id)), 0, "and does not make the record again");
		await redis.zrem(`${prefix}index`, late.fix.id);

		// Within the retention, a record that is gone or does not read is a missing row, as before: the history says so.
		const lost = await store.add(value("lost"), { identity: "lost" });
		await redis.set(meta(lost.fix.id), "not a fix record");
		let snapshot = await store.publicSnapshot();
		assert.equal(snapshot.partial, true, "an unreadable record within the retention is a missing row");
		await redis.del(meta(lost.fix.id));
		assert.equal((await store.publicSnapshot()).partial, true, "so is one that is gone within the retention");
		await redis.zrem(`${prefix}index`, lost.fix.id);
		assert.equal((await store.publicSnapshot()).partial, false);

		// Past the retention, an entry whose record expired is not read at all: no missing row, no pending count, no
		// proof to settle. Valkey's own clock ends the record; the test removes it, as that expiry would.
		const old = await store.stage(value("old"), { identity: "old", privateUndo: { file: "/approved/settings.json", afterDigest: hash("bytes") } });
		t += ttl - FIX_CLOCK_SKEW_MS + 1;
		await redis.del(meta(old.fix.id), `${prefix}private:${old.fix.id}`);
		snapshot = await store.publicSnapshot();
		assert.equal(snapshot.partial, false, "an entry whose record expired with the retention is not a missing row");
		assert.equal(snapshot.pendingCount, 0);
		assert.deepEqual(await store.settleable({ readFile: async () => "bytes" }), { ready: [], refused: [], closed: [] });
		assert.ok((await redis.zscore(`${prefix}index`, old.fix.id)) !== null, "the entry stays in the index until an add trims it");

		// An add trims, in its own transaction, every entry older than the retention, whatever its record still holds.
		t += FIX_CLOCK_SKEW_MS;
		const fresh = await store.add(value("fresh"), { identity: "fresh" });
		assert.deepEqual(await redis.zrange(`${prefix}index`, 0, -1), [fresh.fix.id], "the add trimmed every entry past the retention");
		snapshot = await store.publicSnapshot();
		assert.deepEqual([snapshot.fixes.map(fix => fix.id), snapshot.partial], [[fresh.fix.id], false]);

		// The same id staged twice: the second stage finds the record and keeps it, with the expiry counted from the first,
		// and the entry keeps the first stage's time with it. Moved forward, the entry outlived the record by a day inside
		// the read window, and the history read as incomplete again.
		const first = t;
		const once = await store.stage(value("twice"), { identity: "twice" });
		t += DAY_MS;
		const again = await store.stage(value("twice", { at: t }), { identity: "twice" });
		assert.equal(again.fix.id, once.fix.id);
		assert.equal(Number(await redis.zscore(`${prefix}index`, once.fix.id)), first, "the entry keeps the first stage's time");
		assert.equal(JSON.parse(await redis.get(meta(once.fix.id))).at, first, "and the record is the first stage's");
		t = first + ttl + 1;
		await redis.del(meta(once.fix.id));
		snapshot = await store.publicSnapshot();
		assert.deepEqual([snapshot.partial, snapshot.pendingCount], [false, 0], "the record expired with its retention: no missing row");
		// An id whose record expired and whose entry is still there is staged again: the old entry goes first, and the new
		// record gets an entry of its own time, never one at the old score that the same trim would then remove.
		await redis.zadd(`${prefix}index`, first, once.fix.id);
		const renewed = await store.stage(value("twice"), { identity: "twice" });
		assert.equal(Number(await redis.zscore(`${prefix}index`, renewed.fix.id)), t, "a new record has its own entry");
		assert.equal((await store.publicSnapshot()).pendingCount, 1);
	} finally { const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys); await redis.quit(); }
});

test("a recorded outcome settles a pending row before its bytes do: applied commits, refused refuses even when the bytes are written later, and none keeps the byte rule (#1072)", { skip }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url), prefix = `test-fixes-${randomBytes(8).toString("hex")}:`;
	let t = nowMs;
	const store = makeZeroTouchFixStore({ redis, prefix, now: () => t });
	const file = "/approved/settings.json", made = "settings that read 35", other = "settings that read 40";
	const stage = async (runId, bytes) => (await store.stage({ kind: "config", runId, scopeId, reason: "secret-unresolved" }, { privateUndo: { file, afterDigest: hash(bytes) }, identity: runId })).fix.id;
	try {
		// A change that landed and whose commit was lost, and whose file was changed again since: the bytes no longer
		// prove it, the outcome does. A change refused whose refusal was lost, whose bytes are in the file now (the same
		// change made again by hand): the bytes would commit it, the outcome refuses it. A row with no outcome and one
		// whose outcome is not one of the two words: the byte rule, as before.
		const landed = await stage("landed", made); t += 1;
		const refused = await stage("refused", made); t += 1;
		const plain = await stage("plain", made); t += 1;
		const odd = await stage("odd", other); t += 1;
		// A row whose commit landed after all, with its file still there: `closed`, for a settle to remove the file.
		const done = await stage("done", other); t += 1;
		assert.equal(await store.commit(done), true);
		const recorded = new Map([[landed, "applied"], [refused, "refused"], [odd, "maybe"], [done, "applied"]]);
		const readers = { readFile: async path => path === file ? made : null, outcomeOf: id => recorded.get(id) ?? null };
		const found = await store.settleable(readers);
		assert.deepEqual({ ready: found.ready.sort(), refused: found.refused, closed: found.closed }, { ready: [landed, plain].sort(), refused: [refused], closed: [done] });
		assert.deepEqual(await store.settleable({ outcomeOf: readers.outcomeOf }), { ready: [landed], refused: [refused], closed: [done] }, "the outcome needs no proof to read");
		assert.deepEqual(await store.settleable({ readFile: readers.readFile, outcomeOf: () => { throw new Error("unreadable folder"); } }), { ready: [plain, refused, landed], refused: [], closed: [] }, "an outcome that cannot be asked is none: the byte rule");
		// The settle: commits `ready`, refuses `refused`, and forgets each row whose mark was answered and each closed row.
		const forgotten = [];
		assert.deepEqual(await store.repair({ ...readers, forget: id => forgotten.push(id) }), { settled: 2, refused: 1 });
		assert.deepEqual(forgotten.sort(), [landed, refused, plain, done].sort());
		assert.deepEqual(await Promise.all([landed, refused, plain, odd, done].map(async id => (await store.read(id)).state)), ["applied", "refused", "applied", "pending", "applied"]);
		const snapshot = await store.publicSnapshot();
		assert.deepEqual([snapshot.fixes.length, snapshot.pendingCount], [3, 1], "the refused change is never a fix");
		// A mark the store does not answer throws after the rows before it, and forgets nothing it did not mark.
		const late = await stage("late", made);
		const silent = new Proxy(redis, { get(target, name) {
			if (name === "set") return async () => { throw new Error("fix-store-timeout"); };
			return typeof target[name] === "function" ? target[name].bind(target) : target[name];
		} });
		const cut = makeZeroTouchFixStore({ redis: silent, prefix, now: () => t });
		forgotten.length = 0;
		await assert.rejects(cut.repair({ readFile: readers.readFile, outcomeOf: id => (id === late ? "refused" : null), forget: id => forgotten.push(id) }), /fix-store-timeout/);
		assert.deepEqual(forgotten, [], "the outcome of a refusal that was not answered stays for the next settle");
		assert.equal((await store.read(late)).state, "pending");
	} finally { const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys); await redis.quit(); }
});
