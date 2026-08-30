import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultWorkerName, loadConfig, sanitizeWorkerName, WORKER_NAME_RE } from "../src/config.mjs";
import { HOST_BEAT_MS, HOST_SET, HOST_TTL_MS, hostKey, makeHostRegistry, readLiveHosts } from "../src/host-registry.mjs";

// A fake Valkey: a Map of hashes plus one set, recording every call so the ORDER and the SHAPE of what
// the registry writes can be asserted, not just its end state. Same hand-rolled style as the wait-state
// and held-jobs fakes -- no framework, no server.
function fakeRedis({ fail = false, hang = false } = {}) {
	const hashes = new Map();
	const sets = new Map();
	const calls = [];
	const guard = () => {
		if (fail) throw new Error("ECONNREFUSED");
		// A HANG, not a rejection: `maxRetriesPerRequest: null` makes a real ioredis QUEUE a command against
		// an unreachable server rather than fail it, so a fake that only throws tests a case that cannot
		// happen and misses the one that does.
		if (hang) return new Promise(() => {});
		return null;
	};
	return {
		calls,
		hashes,
		sets,
		async hset(key, ...pairs) {
			calls.push(["hset", key]);
			await guard();
			const h = hashes.get(key) ?? {};
			for (let i = 0; i < pairs.length; i += 2) h[pairs[i]] = pairs[i + 1];
			hashes.set(key, h);
		},
		async hgetall(key) {
			calls.push(["hgetall", key]);
			await guard();
			return hashes.get(key) ?? {};
		},
		async pexpire(key, ms) {
			calls.push(["pexpire", key, ms]);
			await guard();
		},
		async sadd(key, member) {
			calls.push(["sadd", key, member]);
			await guard();
			const s = sets.get(key) ?? new Set();
			s.add(member);
			sets.set(key, s);
		},
		async srem(key, member) {
			calls.push(["srem", key, member]);
			await guard();
			sets.get(key)?.delete(member);
		},
		async smembers(key) {
			calls.push(["smembers", key]);
			await guard();
			return [...(sets.get(key) ?? [])];
		},
		async del(key) {
			calls.push(["del", key]);
			await guard();
			hashes.delete(key);
		},
	};
}

const NOW = Date.UTC(2026, 7, 30, 12, 0);

// --- the name ------------------------------------------------------------------------------------------

test("a hostname is reduced to something the charset accepts, and two spellings of one machine converge", () => {
	// macOS reports `Robs-Mac-Mini.local` where Linux reports `mac-mini`; lowercasing is what keeps one
	// machine from becoming two registry rows and two values in the run records.
	assert.equal(sanitizeWorkerName("Robs-Mac-Mini.local"), "robs-mac-mini.local");
	assert.equal(sanitizeWorkerName("MAC-MINI"), "mac-mini");
	assert.equal(sanitizeWorkerName("a b/c"), "a-b-c");
	assert.equal(sanitizeWorkerName("--weird--"), "weird");
	assert.equal(sanitizeWorkerName("---"), "worker", "a name that sanitizes to nothing still has to be something");
	assert.equal(sanitizeWorkerName(""), "worker");
	assert.equal(sanitizeWorkerName(undefined), "worker");
	const long = sanitizeWorkerName("a".repeat(90));
	assert.equal(long.length, 64, "truncated to the ceiling");
	assert.ok(WORKER_NAME_RE.test(long));
	// The reserved tail matters because the class contains the dot: a probe file named after this value
	// would otherwise land in the run-record namespace.
	assert.equal(sanitizeWorkerName("prod.json"), "prod-json");
	assert.equal(sanitizeWorkerName("Box.LOG"), "box-log");
	// Repaired by replacing the dot rather than appending, because a suffix on a name already at the
	// ceiling would push it past -- and a default the validator would reject is the whole failure this
	// invariant exists to prevent.
	const atCeiling = sanitizeWorkerName(`${"a".repeat(59)}.json`);
	assert.ok(WORKER_NAME_RE.test(atCeiling), atCeiling);
	assert.ok(atCeiling.length <= 64);
	// Whatever comes out, it must satisfy the validator -- a default that could not have been declared
	// would be a second, weaker alphabet by the back door.
	for (const raw of ["", "---", "..", ".", "a b/c", "Robs-Mac-Mini.local", "x".repeat(200), "9front", "_leading", "-", "\u00e9\u00e8", "\ud83d\ude00", `${"a".repeat(59)}.json`, `${"a".repeat(60)}.log`, `${"b".repeat(63)}.`, "HOST.JSON", "x.json.log", "a".repeat(64)]) {
		assert.ok(WORKER_NAME_RE.test(sanitizeWorkerName(raw)), JSON.stringify(raw));
	}
});

test("defaultWorkerName never throws and always yields a legal name", () => {
	assert.ok(WORKER_NAME_RE.test(defaultWorkerName()));
});

test("an explicit PI_WORKER_NAME is taken VERBATIM, and a bad one refuses boot", () => {
	const base = { VALKEY_URL: "redis://x", PI_WORKER_NAME: "Mac-Mini-1" };
	// Not lowercased, not repaired: a value the operator typed must never be silently altered.
	assert.equal(loadConfig(base).workerName, "Mac-Mini-1");
	assert.equal(loadConfig(base).workerNameDeclared, true);
	assert.equal(loadConfig({ VALKEY_URL: "redis://x" }).workerNameDeclared, false, "a defaulted name is not a declared one");

	for (const bad of ["has space", "colon:name", "slash/name", "-leading", ".leading", "x".repeat(65), "comma,name", "hash#name"]) {
		assert.throws(
			() => loadConfig({ ...base, PI_WORKER_NAME: bad }),
			(e) => e.piDispatchConfig === true && e.message.includes("PI_WORKER_NAME"),
			JSON.stringify(bad),
		);
	}
	// Refused rather than escaped downstream: the escape would have to be remembered at every site that
	// ever composes a filename from this value.
	for (const bad of ["prod.json", "prod.LOG"]) {
		assert.throws(() => loadConfig({ ...base, PI_WORKER_NAME: bad }), (e) => e.message.includes(".json or .log"), bad);
	}
	// An empty string is "not declared", not "declared as empty" -- `.env` files are full of blank keys.
	assert.equal(loadConfig({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "" }).workerNameDeclared, false);
	assert.ok(WORKER_NAME_RE.test(loadConfig({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "" }).workerName));
});

// --- the registry --------------------------------------------------------------------------------------

test("a beat writes the row, indexes it, and RE-EXPIRES it every time", async () => {
	const redis = fakeRedis();
	const reg = makeHostRegistry({ redis, name: "mini1", now: () => NOW });
	await reg.start({ version: "1.7.0", concurrency: 3 });

	assert.deepEqual(redis.hashes.get(hostKey("mini1")), {
		version: "1.7.0",
		concurrency: "3",
		startedAt: String(NOW),
		name: "mini1",
		beatAt: String(NOW),
	});
	assert.deepEqual([...redis.sets.get(HOST_SET)], ["mini1"]);

	// The TTL is refreshed on EVERY beat, which reverses the budget keys' set-once rule. That is the
	// point: a lease's expiry IS its liveness claim, so refreshing it is the mechanism rather than a leak.
	redis.calls.length = 0;
	await reg.publish();
	assert.deepEqual(
		redis.calls.map((c) => c[0]),
		["hset", "pexpire", "sadd"],
		"every beat re-expires, and re-indexes so a reader's prune cannot orphan a live host",
	);
	assert.equal(redis.calls.find((c) => c[0] === "pexpire")[2], HOST_TTL_MS);
	// Six missed beats, so one late beat on a busy worker never evicts a healthy host.
	assert.equal(HOST_TTL_MS / HOST_BEAT_MS, 6);
});

test("facts carry forward across beats, so an interval beat does not blank the row", async () => {
	const redis = fakeRedis();
	const reg = makeHostRegistry({ redis, name: "mini1", now: () => NOW });
	await reg.start({ version: "1.7.0", imageDigest: "sha256:abc" });
	await reg.publish(); // a later flush must not blank what start installed
	const row = redis.hashes.get(hostKey("mini1"));
	assert.equal(row.version, "1.7.0", "an earlier fact survives a later partial publish");
	assert.equal(row.imageDigest, "sha256:abc");
	assert.equal(row.version, "1.7.0");
});

test("a dead redis costs a row and never a throw, and says so exactly ONCE", async () => {
	const logs = [];
	const redis = fakeRedis({ fail: true });
	const reg = makeHostRegistry({ redis, name: "mini1", now: () => NOW, log: (e, f) => logs.push({ e, f }) });
	await reg.start({ version: "1.7.0" }); // must not reject
	await reg.publish();
	await reg.publish();
	// Once per TRANSITION, not once per beat: at four beats a minute an outage would drown the log.
	assert.equal(logs.filter((l) => l.e === "host_registry_unreachable").length, 1);
	assert.equal(logs[0].f.host, "mini1");

	redis.hashes.clear();
	const back = makeHostRegistry({ redis: fakeRedis(), name: "mini1", now: () => NOW, log: (e, f) => logs.push({ e, f }) });
	await back.publish();
	assert.equal(logs.filter((l) => l.e === "host_registry_restored").length, 0, "a registry that was never down does not announce recovery");
});

test("a clean shutdown LEAVES rather than expiring, so a rolling restart leaves no ghost", async () => {
	const redis = fakeRedis();
	const reg = makeHostRegistry({ redis, name: "mini1", now: () => NOW });
	await reg.start({ version: "1.7.0" });
	assert.equal(redis.hashes.has(hostKey("mini1")), true);
	await reg.close();
	assert.equal(redis.hashes.has(hostKey("mini1")), false, "the row is deleted, not left to the TTL");
	assert.deepEqual([...(redis.sets.get(HOST_SET) ?? [])], []);
	await reg.close(); // idempotent: a second close must not throw
});

test("the reader PRUNES a member whose row is gone, and distinguishes empty from unreadable", async () => {
	const redis = fakeRedis();
	const live = makeHostRegistry({ redis, name: "mini1", now: () => NOW });
	await live.start({ version: "1.7.0" });
	await redis.sadd(HOST_SET, "ghost"); // a host that died without a clean shutdown

	const { hosts } = await readLiveHosts(redis, { now: () => NOW + 5000 });
	assert.deepEqual(hosts.map((h) => h.name), ["mini1"], "the ghost is not returned");
	assert.deepEqual([...redis.sets.get(HOST_SET)], ["mini1"], "and is removed from the index in passing");
	assert.equal(hosts[0].staleMs, 5000, "age is derived, so a panel can say how stale a live row is");

	// "no hosts" and "cannot tell" are different answers and a caller must be able to tell them apart --
	// a panel that renders the second as the first says the fleet is gone when Valkey merely blinked.
	const empty = await readLiveHosts(fakeRedis(), { now: () => NOW });
	assert.deepEqual(empty, { hosts: [] });
	const dead = await readLiveHosts(fakeRedis({ fail: true }), { now: () => NOW });
	assert.ok(dead.unreachable, "a fault is reported as one");
	assert.equal(dead.hosts, undefined);
});

test("a row whose clock runs AHEAD of ours reads as fresh, never as negative age", async () => {
	const redis = fakeRedis();
	const reg = makeHostRegistry({ redis, name: "mini1", now: () => NOW + 60_000 });
	await reg.start({});
	const { hosts } = await readLiveHosts(redis, { now: () => NOW });
	assert.equal(hosts[0].staleMs, 0, "clock skew between two machines is its own signal, not this field's to report");
});

test("THE CONTENT RULE is enforced in the WRITER, so a path added at any call site is dropped and named", async () => {
	// Previously this asserted over a field list the test itself published, which could never have caught
	// the day someone adds `logsDir` at a real call site. Now the writer refuses, so the test can hand it
	// the exact values that would have leaked.
	const redis = fakeRedis();
	const logs = [];
	const reg = makeHostRegistry({ redis, name: "mini1", now: () => NOW, log: (e, f) => logs.push({ e, f }) });
	await reg.start({
		version: "1.7.0",
		imageDigest: "sha256:abc",
		tz: "Europe/Amsterdam", // the one admissible value containing a slash
		logsDir: "/tmp/pi-dispatch/logs",
		winPath: "C:\\Users\\rob\\deploy",
		relativeish: "some\\thing",
	});

	const row = redis.hashes.get(hostKey("mini1"));
	assert.equal(row.tz, "Europe/Amsterdam", "a zone is not a path: no leading separator, no backslash, no drive");
	assert.equal(row.imageDigest, "sha256:abc");
	assert.ok(!("logsDir" in row), "an absolute path never reaches the keyspace");
	assert.ok(!("winPath" in row));
	assert.ok(!("relativeish" in row), "nor does anything carrying a backslash");
	assert.deepEqual(
		logs.filter((l) => l.e === "host_registry_field_refused").map((l) => l.f.field).sort(),
		["logsDir", "relativeish", "winPath"],
		"and each is named, because a silently dropped field is the no-op this project refuses",
	);
});

test("a HANG is a failure, not a wait: an unreachable Valkey costs a row and never a boot", async () => {
	// The failure mode of `makeRedisClient`'s client is a HANG -- `maxRetriesPerRequest: null` makes it
	// queue a command against a dead server rather than reject it -- so every await here is bounded. A
	// try/catch alone would catch nothing, which is exactly the bug this test exists to keep fixed.
	const logs = [];
	const reg = makeHostRegistry({ redis: fakeRedis({ hang: true }), name: "mini1", now: () => NOW, timeoutMs: 30, log: (e, f) => logs.push({ e, f }) });
	const t0 = Date.now();
	await reg.start({ version: "1.7.0" });
	await reg.close();
	assert.ok(Date.now() - t0 < 2000, "start and close both return promptly rather than queueing forever");
	assert.equal(logs.filter((l) => l.e === "host_registry_unreachable").length, 1, "and the transition is reported, which a rejection-only catch never saw");
});

test("a beat in flight cannot resurrect the row after close()", async () => {
	const redis = fakeRedis();
	const reg = makeHostRegistry({ redis, name: "mini1", now: () => NOW });
	await reg.start({ version: "1.7.0" });
	const inFlight = reg.publish(); // not awaited: it is mid-beat when close lands
	await reg.close();
	await inFlight;
	assert.equal(redis.hashes.has(hostKey("mini1")), false, "the DEL is final -- a late beat must not recreate the ghost close() exists to remove");
	assert.deepEqual([...(redis.sets.get(HOST_SET) ?? [])], []);
});
