import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { POLLER_GRACE_MS, POLLER_LIVE, POLLER_MAX_BYTES, POLLER_TTL_MAX_MS, makePollerBeat, parsePollerStatus, pollerKey, readPollerStatus, triggersDigest } from "../src/poller-status.mjs";

// Issue #970: the poller's heartbeat. Every TTL and age here is on an injected clock or Valkey's own count.
const AT = Date.UTC(2026, 10, 21, 12);
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("poller-status integration requires VALKEY_TEST_URL");

const record = (fields = {}) => ({ v: 1, name: "mini1", version: "5.4.2", startedAt: AT - 600_000, at: AT, ttlMs: 60_000 + POLLER_GRACE_MS, nextAt: AT + 60_000, intervalSeconds: 60, repos: 2, triggers: "current", refusal: null, running: triggersDigest("{}"), rejected: null, rejectedAt: null, ...fields });
const kept = (fields = {}) => record({ triggers: "kept", refusal: "refused", rejected: triggersDigest("{ bad"), rejectedAt: AT - 1000, ...fields });
const beatFields = (r) => ({ ttlMs: r.ttlMs, nextAt: r.nextAt, intervalSeconds: r.intervalSeconds, repos: r.repos, triggers: r.triggers, refusal: r.refusal, running: r.running, rejected: r.rejected, rejectedAt: r.rejectedAt });

/** A Map-backed client with the commands the writer and the reader use, recording each; `fail` names one to break. */
function redisFake({ fail = null } = {}) {
	const values = new Map(); const ttls = new Map(); const members = new Set(); const calls = [];
	const broken = (cmd) => { if (fail === cmd) throw new Error(`${cmd} PRIVATE_DETAIL`); };
	return { values, ttls, members, calls,
		async set(k, value, px, ttl) { calls.push(["set", k, px, ttl]); broken("set"); values.set(k, value); ttls.set(k, ttl); return "OK"; },
		async sadd(_, name) { calls.push(["sadd", name]); broken("sadd"); const added = members.has(name) ? 0 : 1; members.add(name); return added; },
		async srem(_, name) { calls.push(["srem", name]); members.delete(name); return 1; },
		async del(k) { calls.push(["del", k]); values.delete(k); ttls.delete(k); return 1; },
		async sscan(_, cursor) { calls.push(["sscan", cursor]); return ["0", [...members]]; },
		async eval(_script, n, _index, ...args) { calls.push(["eval"]); let removed = 0; for (let i = 0; i < n - 1; i++) if (!values.has(args[i])) removed += members.delete(args[n - 1 + i]) ? 1 : 0; return removed; },
		async mget(...keys) { calls.push(["mget", ...keys]); return keys.map((k) => values.get(k) ?? null); },
		async pttl(k) { return ttls.has(k) ? ttls.get(k) : -2; },
	};
}

test("a version 1 record is rebuilt by field name: a planted field is dropped and its values come back as written", () => {
	const parsed = parsePollerStatus(JSON.stringify({ ...kept(), path: "/srv/deploy/triggers.json", reason: "cron trigger \"probe\": run.flow must be a non-empty string" }));
	assert.deepEqual(parsed, kept(), "only the version 1 fields, in the record's shape");
	assert.equal(Object.hasOwn(parsed, "reason"), false);
	assert.deepEqual(parsePollerStatus(JSON.stringify(record())), record());
	for (const refusal of ["missing", "unreadable"]) assert.deepEqual(parsePollerStatus(JSON.stringify(kept({ refusal, rejected: null }))), kept({ refusal, rejected: null }));
	assert.deepEqual(parsePollerStatus(JSON.stringify(record({ nextAt: null, ttlMs: POLLER_GRACE_MS }))), record({ nextAt: null, ttlMs: POLLER_GRACE_MS }), "a beat inside a cycle names no next start");
});

test("a record of another shape, a hostile value or fields that disagree is unreadable, never partly read", () => {
	const refused = [
		["another version", record({ v: 2 })],
		["a name with a path in it", record({ name: "../mini1" })],
		["a version with a space", record({ version: "5.4.2 beta" })],
		["a path where a digest goes", record({ running: "/srv/deploy/triggers.json" })],
		["an upper-case digest", record({ running: triggersDigest("{}").toUpperCase() })],
		["a free-text refusal", kept({ refusal: "cron trigger \"probe\": run.flow must be a non-empty string" })],
		["a word outside the triggers states", record({ triggers: "stale" })],
		["a current file with a refusal", record({ refusal: "refused" })],
		["a current file with a refused digest", record({ rejected: triggersDigest("x") })],
		["a current file with a refusal time", record({ rejectedAt: AT })],
		["a kept file without its refusal time", kept({ rejectedAt: null })],
		["a refused text without its digest", kept({ rejected: null })],
		["a missing file with a digest", kept({ refusal: "missing" })],
		["no TTL", record({ ttlMs: 0 })],
		["a TTL past the bound", record({ ttlMs: POLLER_TTL_MAX_MS + 1 })],
		["a fractional TTL", record({ ttlMs: 1.5 })],
		["a next start that is no instant", record({ nextAt: "soon" })],
		["a negative repo count", record({ repos: -1 })],
		["a zero interval", record({ intervalSeconds: 0 })],
		["a start past the renderable range", record({ startedAt: 8.65e15 })],
	];
	for (const [why, value] of refused) assert.equal(parsePollerStatus(JSON.stringify(value)), null, why);
	assert.equal(parsePollerStatus(JSON.stringify({ ...record(), pad: "x".repeat(POLLER_MAX_BYTES) })), null, "over 4 KiB, whatever it holds");
	for (const raw of ["not json", "[]", "null", JSON.stringify(record()).slice(0, -1), 42]) assert.equal(parsePollerStatus(raw), null, String(raw));
});

test("a beat writes one record with its own TTL, indexes it and prunes a dead peer, keeping a live one", async () => {
	const redis = redisFake();
	redis.members.add("gone"); redis.members.add("alive"); redis.values.set(pollerKey("alive"), JSON.stringify(record({ name: "alive" })));
	const log = [];
	const beat = makePollerBeat({ client: () => redis, name: "mini1", version: "5.4.2", now: () => AT, log: (event, fields) => log.push({ event, ...fields }) });
	await beat.beat(beatFields(kept()));
	assert.deepEqual(log, []);
	assert.deepEqual(redis.calls.slice(0, 2), [["set", pollerKey("mini1"), "PX", 60_000 + POLLER_GRACE_MS], ["sadd", "mini1"]]);
	assert.deepEqual(parsePollerStatus(redis.values.get(pollerKey("mini1"))), kept({ startedAt: AT }));
	assert.deepEqual([...redis.members].sort(), ["alive", "mini1"], "the peer whose record expired leaves the index; the live one and the writer stay");
	assert.ok(redis.calls.some((c) => c[0] === "eval"), "through the shared check-and-prune script");
});

test("a failed write is said once per failure streak with a fixed reason, never throws, and a record it would not read back is never written", async () => {
	for (const [fail, reason] of [["set", "write"], ["sadd", "index"]]) {
		const redis = redisFake({ fail });
		const log = [];
		const beat = makePollerBeat({ client: () => redis, name: "mini1", version: "5.4.2", now: () => AT, log: (event, fields) => log.push({ event, ...fields }) });
		for (let i = 0; i < 3; i++) await beat.beat(beatFields(record()));
		assert.deepEqual(log, [{ event: "poller_status_unavailable", reason }], `${fail}: once over three failing beats`);
		assert.doesNotMatch(JSON.stringify(log), /PRIVATE_DETAIL/);
	}
	// A success ends the streak: the next failure is said again.
	const redis = redisFake();
	const log = [];
	const beat = makePollerBeat({ client: () => redis, name: "mini1", version: "5.4.2", now: () => AT, log: (event, fields) => log.push({ event, ...fields }) });
	const set = redis.set;
	redis.set = async () => { throw new Error("down"); };
	await beat.beat(beatFields(record()));
	redis.set = set;
	await beat.beat(beatFields(record()));
	redis.set = async () => { throw new Error("down again"); };
	await beat.beat(beatFields(record()));
	assert.deepEqual(log.map((l) => l.reason), ["write", "write"]);
	// A client that throws, and a record the reader would refuse, are the same: nothing written, one line, no throw.
	const quiet = [];
	await makePollerBeat({ client: () => { throw new Error("no client"); }, name: "mini1", version: "5.4.2", now: () => AT, log: (event, fields) => quiet.push(fields.reason) }).beat(beatFields(record()));
	const untouched = redisFake();
	await makePollerBeat({ client: () => untouched, name: "mini1", version: "5.4.2", now: () => AT, log: (event, fields) => quiet.push(fields.reason) }).beat({ ...beatFields(record()), ttlMs: 0 });
	await makePollerBeat({ client: () => untouched, name: "mini1", version: "", now: () => AT, log: (event, fields) => quiet.push(fields.reason) }).beat(beatFields(record()));
	assert.deepEqual(quiet, ["write", "record", "record"]);
	assert.deepEqual(untouched.calls, [], "no command for a record no reader takes");
});

test("remove deletes the record and its index entry, and no beat writes after it; a name a worker would refuse writes nothing", async () => {
	const redis = redisFake();
	const beat = makePollerBeat({ client: redis, name: "mini1", version: "5.4.2", now: () => AT });
	await beat.beat(beatFields(record()));
	await beat.remove();
	assert.equal(redis.values.has(pollerKey("mini1")), false);
	assert.equal(redis.members.has("mini1"), false);
	const after = redis.calls.length;
	await beat.beat(beatFields(record()));
	await beat.remove();
	assert.equal(redis.calls.length, after, "a stopped writer sends nothing more");
	for (const name of [null, "no spaces", "../up", "a".repeat(65)]) {
		const idle = redisFake();
		const log = [];
		const writer = makePollerBeat({ client: idle, name, version: "5.4.2", now: () => AT, log: (event, fields) => log.push(fields.reason) });
		await writer.beat(beatFields(record()));
		await writer.beat(beatFields(record()));
		await writer.remove();
		assert.deepEqual(idle.calls, [], String(name));
		assert.deepEqual(log, ["identity"], `${name}: said once`);
	}
});

test("the reader dates each record by Valkey's count, and a nonexpiring key, a PTTL above the record's own TTL or another host's record is unknown", async () => {
	const redis = redisFake();
	const put = (name, value, ttl) => { redis.members.add(name); redis.values.set(pollerKey(name), JSON.stringify(value)); redis.ttls.set(pollerKey(name), ttl); };
	put("mini1", record(), 340_000);
	let read = await readPollerStatus(redis, { now: () => AT });
	assert.equal(read.complete, true);
	assert.deepEqual(read.hosts, [{ ...record(), ageMs: 20_000 }], "the record's TTL minus what is left of it, so no two clocks are compared");
	for (const [why, ttl, value] of [["no expiry", -1, record()], ["a PTTL above its own TTL", 360_001, record()], ["another host's record", 340_000, record({ name: "mini2" })], ["a record of another shape", 340_000, { ...record(), v: 2 }]]) {
		put("mini1", value, ttl);
		read = await readPollerStatus(redis, { now: () => AT });
		assert.deepEqual(read.hosts, [{ name: "mini1", unreadable: true }], why);
		assert.equal(read.complete, false, why);
	}
	// A key that expired between the reads is absent, and a complete read of nothing is nothing.
	redis.values.delete(pollerKey("mini1")); redis.ttls.delete(pollerKey("mini1"));
	assert.deepEqual(await readPollerStatus(redis, { now: () => AT }), { hosts: [], complete: true, more: 0, moreUnknown: false });
	// Expired between the GET, which still answered its value, and the PTTL, which answers -2: absent too, and the read
	// stays complete beside a live record.
	put("mini1", record(), 340_000);
	redis.members.add("gone"); redis.values.set(pollerKey("gone"), JSON.stringify(record({ name: "gone" })));
	assert.deepEqual(await readPollerStatus(redis, { now: () => AT }), { hosts: [{ ...record(), ageMs: 20_000 }], complete: true, more: 0, moreUnknown: false });
});

test("a read that runs out of time or cannot scan the index is incomplete, never an absence (injected clock)", async () => {
	// The clock never moves, as when a timer fires a fraction of a millisecond before the deadline it was set from.
	let gets = 0;
	const hung = { sscan: () => new Promise(() => {}), mget() { gets++; return []; }, pttl() { return -2; } };
	const read = await readPollerStatus(hung, { names: ["mini1"], now: () => AT, timeoutMs: 1, clock: () => 0 });
	assert.equal(gets, 0, "no record command starts once the bound has fired");
	assert.deepEqual(read.hosts, [{ name: "mini1", unreadable: true }]);
	assert.equal(read.complete, false);
	assert.equal(read.moreUnknown, true);
	// A client without the index commands (an older fake, or a client of another kind) degrades the same way.
	assert.deepEqual(await readPollerStatus({}, { now: () => AT }), { hosts: [], complete: false, more: 0, moreUnknown: true });
	const failing = redisFake(); failing.members.add("mini1"); failing.mget = async () => { throw new Error("PRIVATE_DETAIL"); };
	const records = await readPollerStatus(failing, { now: () => AT });
	assert.deepEqual(records, { hosts: [{ name: "mini1", unreadable: true }], complete: false, more: 0, moreUnknown: false });
});

test("the writer arms no timer and shares the receiver's prune and bounded read rather than copying them (source pin)", () => {
	const src = readFileSync(new URL("../src/poller-status.mjs", import.meta.url), "utf8");
	assert.ok(!/setTimeout|setInterval|\.unref\(/.test(src), "the poller's loop owns every timer it runs on");
	assert.match(src, /import \{ pruneLiveIndex, readIndexedRecords \} from "\.\/receiver-status\.mjs";/);
	assert.ok(!src.includes("redis.call("), "no second copy of the prune script");
	assert.equal(POLLER_LIVE, "poller:live");
	assert.equal(pollerKey("mini1"), "poller:h:mini1");
	assert.equal(triggersDigest("{}"), "44136fa355b3678a", "sha256 of the text, its first 16 hex");
});

test("real Valkey: a beat's record expires by its own TTL, reads back with its age, and goes with remove (issue #970)", { skip: url ? false : "VALKEY_TEST_URL not set" }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url, {});
	const name = `poller-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
	const dead = `${name}-dead`;
	t.after(async () => { await redis.del(pollerKey(name), pollerKey(dead)); await redis.srem(POLLER_LIVE, name, dead); redis.disconnect(); });
	const now = () => Date.now();
	await redis.sadd(POLLER_LIVE, dead);
	const beat = makePollerBeat({ client: redis, name, version: "5.4.2", now });
	await beat.beat({ ...beatFields(record({ name })), nextAt: now() + 60_000 });
	const ttl = await redis.pttl(pollerKey(name));
	assert.ok(ttl > 60_000 + POLLER_GRACE_MS - 5000 && ttl <= 60_000 + POLLER_GRACE_MS, String(ttl));
	assert.equal(await redis.sismember(POLLER_LIVE, dead), 0, "a member whose record is absent is pruned by the beat");
	const row = (await readPollerStatus(redis, { names: [name], now })).hosts.find((h) => h.name === name);
	assert.ok(row && row.ageMs >= 0 && row.ageMs < 5000, JSON.stringify(row));
	assert.equal(row.triggers, "current");
	await beat.remove();
	assert.equal(await redis.exists(pollerKey(name)), 0);
	assert.equal(await redis.sismember(POLLER_LIVE, name), 0);
});
