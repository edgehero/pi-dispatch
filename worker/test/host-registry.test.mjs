import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultWorkerName, loadConfig, sanitizeWorkerName, WORKER_NAME_RE } from "../src/config.mjs";
import { HOST_BEAT_MS, HOST_SET, HOST_TTL_MS, hostKey, makeHostRegistry, readLiveHosts } from "../src/host-registry.mjs";

// A fake Valkey: a Map of hashes plus one set, recording every call so the ORDER and the SHAPE of what
// the registry writes can be asserted, not just its end state. Same hand-rolled style as the wait-state
// and held-jobs fakes -- no framework, no server.
function fakeRedis({ fail = false } = {}) {
	const hashes = new Map();
	const sets = new Map();
	const calls = [];
	const guard = () => {
		if (fail) throw new Error("ECONNREFUSED");
	};
	return {
		calls,
		hashes,
		sets,
		async hset(key, ...pairs) {
			calls.push(["hset", key]);
			guard();
			const h = hashes.get(key) ?? {};
			for (let i = 0; i < pairs.length; i += 2) h[pairs[i]] = pairs[i + 1];
			hashes.set(key, h);
		},
		async hgetall(key) {
			calls.push(["hgetall", key]);
			guard();
			return hashes.get(key) ?? {};
		},
		async pexpire(key, ms) {
			calls.push(["pexpire", key, ms]);
			guard();
		},
		async sadd(key, member) {
			calls.push(["sadd", key, member]);
			guard();
			const s = sets.get(key) ?? new Set();
			s.add(member);
			sets.set(key, s);
		},
		async srem(key, member) {
			calls.push(["srem", key, member]);
			guard();
			sets.get(key)?.delete(member);
		},
		async smembers(key) {
			calls.push(["smembers", key]);
			guard();
			return [...(sets.get(key) ?? [])];
		},
		async del(key) {
			calls.push(["del", key]);
			guard();
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
	await reg.publish({ version: "1.7.0", concurrency: 3 });

	assert.deepEqual(redis.hashes.get(hostKey("mini1")), {
		version: "1.7.0",
		concurrency: "3",
		name: "mini1",
		beatAt: String(NOW),
	});
	assert.deepEqual([...redis.sets.get(HOST_SET)], ["mini1"]);

	// The TTL is refreshed on EVERY beat, which reverses the budget keys' set-once rule. That is the
	// point: a lease's expiry IS its liveness claim, so refreshing it is the mechanism rather than a leak.
	redis.calls.length = 0;
	await reg.publish({});
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
	await reg.publish({ version: "1.7.0", imageDigest: "sha256:abc" });
	await reg.publish({ concurrency: 3 }); // a later, partial publish
	const row = redis.hashes.get(hostKey("mini1"));
	assert.equal(row.version, "1.7.0", "an earlier fact survives a later partial publish");
	assert.equal(row.imageDigest, "sha256:abc");
	assert.equal(row.concurrency, "3");
});

test("a dead redis costs a row and never a throw, and says so exactly ONCE", async () => {
	const logs = [];
	const redis = fakeRedis({ fail: true });
	const reg = makeHostRegistry({ redis, name: "mini1", now: () => NOW, log: (e, f) => logs.push({ e, f }) });
	await reg.publish({ version: "1.7.0" }); // must not reject
	await reg.publish({ version: "1.7.0" });
	await reg.publish({ version: "1.7.0" });
	// Once per TRANSITION, not once per beat: at four beats a minute an outage would drown the log.
	assert.equal(logs.filter((l) => l.e === "host_registry_unreachable").length, 1);
	assert.equal(logs[0].f.host, "mini1");

	redis.hashes.clear();
	const back = makeHostRegistry({ redis: fakeRedis(), name: "mini1", now: () => NOW, log: (e, f) => logs.push({ e, f }) });
	await back.publish({});
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
	await live.publish({ version: "1.7.0" });
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
	await reg.publish({});
	const { hosts } = await readLiveHosts(redis, { now: () => NOW });
	assert.equal(hosts[0].staleMs, 0, "clock skew between two machines is its own signal, not this field's to report");
});

test("THE CONTENT RULE: no registry value is path-shaped", async () => {
	// The tripwire that catches the day someone publishes `logsDir`. Names, integers and digests only:
	// the panel is where an operator screenshots, and doctor prints these rows.
	const redis = fakeRedis();
	const reg = makeHostRegistry({ redis, name: "mini1", now: () => NOW });
	await reg.publish({ version: "1.7.0", image: "pi-job:latest", imageDigest: "sha256:abc", concurrency: 3, pid: 42, tz: "Europe/Amsterdam" });
	for (const [key, value] of Object.entries(redis.hashes.get(hostKey("mini1")))) {
		assert.ok(!String(value).includes("/") || key === "tz", `${key} must not be path-shaped: ${value}`);
		assert.ok(!String(value).includes("\\"), `${key} must not be path-shaped: ${value}`);
	}
});
