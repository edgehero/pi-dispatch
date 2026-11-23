import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultWorkerName, loadConfig, sanitizeWorkerName, WORKER_NAME_RE } from "../src/config.mjs";
import { HOST_BEAT_MS, HOST_SET, HOST_SKEW_CLAIM_MS, HOST_TTL_MS, hostKey, liveHostNamesOf, makeHostRegistry, readLiveHosts } from "../src/host-registry.mjs";
import { replyErrorCode } from "../src/connection.mjs";

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

/**
 * A fake whose per-command latency the TEST sets, so the window issue #302 lives in is reached on purpose
 * rather than by racing a real Valkey: `close` drains with ONE `bounded(inFlight, timeoutMs)` while
 * `write` spends one bound PER COMMAND, so a write can still be running after `close` has returned.
 *
 * Separate from `fakeRedis` rather than a mode on it, because that fake's `guard()` applies one behaviour
 * to every method at once -- which is exactly what cannot express "the hset answers and the pexpire does
 * not". `delays` and `fail` are exposed so a test can change the profile between two beats of ONE
 * registry, which is how the `restored` arm gets armed at all.
 */
function pacedRedis(delays = {}, fail = new Set()) {
	const calls = [];
	const hashes = new Map();
	const sets = new Map();
	const wait = async (method) => {
		const d = delays[method] ?? 0;
		// "never" is the real client's own failure mode, not an exotic one: `maxRetriesPerRequest: null`
		// QUEUES a command against a dead server rather than rejecting it.
		if (d === "never") await new Promise(() => {});
		// A ZERO delay resolves on the MICROTASK queue, never through `setTimeout(0)`, and that is what makes
		// this fake usable on a busy runner rather than only on an idle laptop. `close`'s own DEL and SREM
		// take this path: give them a timer and a BLOCKED event loop pushes close's RETURN past the write it
		// is racing, which turns the window inside out and trips the vacuity guard below. Measured under an
		// 80ms-every-25ms blocker: red with a timer here, green without one.
		else if (d > 0) await new Promise((resolve) => setTimeout(resolve, d));
		if (fail.has(method)) throw new Error("ECONNREFUSED");
	};
	return {
		calls,
		hashes,
		sets,
		delays,
		fail,
		async hset(key, ...pairs) {
			calls.push("hset");
			await wait("hset");
			const h = hashes.get(key) ?? {};
			for (let i = 0; i < pairs.length; i += 2) h[pairs[i]] = pairs[i + 1];
			hashes.set(key, h);
		},
		async pexpire(key, ms) {
			calls.push("pexpire");
			await wait("pexpire");
		},
		async sadd(key, member) {
			calls.push("sadd");
			await wait("sadd");
			const s = sets.get(key) ?? new Set();
			s.add(member);
			sets.set(key, s);
		},
		async srem(key, member) {
			calls.push("srem");
			await wait("srem");
			sets.get(key)?.delete(member);
		},
		async del(key) {
			calls.push("del");
			await wait("del");
			hashes.delete(key);
		},
	};
}

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

test("issue #599, phase 2: a row's running jobs are read back through the allowlist, a hostile entry counted in jobsMore", async () => {
	const redis = fakeRedis();
	const reg = makeHostRegistry({ redis, name: "mini1", now: () => NOW });
	const jobs = JSON.stringify([{ id: "gh-1", p: "web", m: 2048, c: 100, at: NOW - 1000 }, { id: "gh-2 two", p: "web", at: NOW }, { id: "gh-3", p: "x/y", at: NOW }]);
	await reg.start({ jobs: () => jobs, jobsMore: () => "4", waiters: () => "1" });
	assert.equal(redis.hashes.get(hostKey("mini1")).jobs, jobs, "the writer publishes the JSON as it is: no path shape");
	// Why the writer holds every id to a charset: JSON escapes a control character with a backslash, which the content
	// rule's path check refuses, so one raw id would cost the whole field.
	const raw = fakeRedis();
	await makeHostRegistry({ redis: raw, name: "raw", now: () => NOW }).start({ jobs: JSON.stringify([{ id: "gh-\u001b", at: 1 }]) });
	assert.equal(raw.hashes.get(hostKey("raw")).jobs, undefined);
	const { hosts } = await readLiveHosts(redis, { now: () => NOW });
	assert.deepEqual(hosts[0].jobs, [{ id: "gh-1", p: "web", m: 2048, c: 100, at: NOW - 1000, o: false }]);
	assert.equal(hosts[0].jobsMore, 6, "four not listed and two not readable");
	assert.equal(hosts[0].waiters, "1");
	// A row from before the field: no list, nothing more known.
	const old = fakeRedis();
	await makeHostRegistry({ redis: old, name: "old", now: () => NOW }).start({ version: "4.0.0" });
	const before = (await readLiveHosts(old, { now: () => NOW })).hosts[0];
	assert.deepEqual([before.jobs, before.jobsMore, before.jobsUnreadable], [null, null, false]);
	// A value that is not a list: no list, and the published count kept.
	const junk = fakeRedis();
	await makeHostRegistry({ redis: junk, name: "junk", now: () => NOW }).start({ jobs: "not json", jobsMore: "2" });
	const read = (await readLiveHosts(junk, { now: () => NOW })).hosts[0];
	assert.deepEqual([read.jobs, read.jobsMore, read.jobsUnreadable], [null, 2, true], "there, and not a list: said");
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

test("a write that outlives the drain is SILENT, and cannot re-index the row it lost", async () => {
	// ISSUE #302. `close` drains with ONE `bounded(inFlight, timeoutMs)` while `write` spends one bound per
	// command, so the drain can give up while the write is still going. What landed afterwards was a log
	// line through the closure of a boot that had already stopped -- reproduced at +76ms (`unreachable`)
	// and +108ms (`restored`) past a RESOLVED close -- and a SADD that put this host's name back into
	// `host:live` after close's own SREM had taken it out.
	//
	// The sibling test above, "a beat in flight cannot resurrect the row after close()", drives the
	// non-delaying fake, so its write and the drain settle in the same tick and this window is never
	// entered at all. That is why it stayed green while the defect was live.
	const T = 150;

	// (i) A write that FAILS late. The hset answers inside its own bound, the pexpire never answers, so the
	// write rejects at roughly 2 x T while the drain gave up at T.
	{
		const redis = pacedRedis({ hset: 100, pexpire: "never" });
		const logs = [];
		const reg = makeHostRegistry({ redis, name: "mini1", now: () => NOW, timeoutMs: T, log: (e, f) => logs.push({ e, f }) });
		let settled = false;
		// NOT awaited: the whole point is that `close` lands while this write is still in flight.
		const beating = reg.start({ version: "1.7.0" }).then(() => (settled = true));
		await reg.close();
		assert.equal(settled, false, "the test is VACUOUS unless the drain gave up first -- check T against the delays before believing a pass");
		const after = logs.length;
		await beating;
		assert.deepEqual(logs.slice(after), [], "a registry that has CLOSED writes nothing: this line used to carry a host that had stopped");
	}

	// (ii) A write that SUCCEEDS late, against a registry whose last beat had already failed -- so the arm
	// under test is `restored`, the one the issue does not name.
	{
		const redis = pacedRedis({}, new Set(["hset"]));
		const logs = [];
		const reg = makeHostRegistry({ redis, name: "mini1", now: () => NOW, timeoutMs: T, log: (e, f) => logs.push({ e, f }) });
		await reg.start({ version: "1.7.0" });
		assert.deepEqual(logs.map((l) => l.e), ["host_registry_unreachable"], "reachable is now false, which is what arms the restored arm");

		redis.fail.delete("hset");
		redis.delays.hset = 100;
		redis.delays.pexpire = 100; // each inside its own bound; the SUM is what the single-bounded drain misses
		let settled = false;
		const late = reg.publish().then(() => (settled = true));
		await reg.close();
		assert.equal(settled, false, "vacuous otherwise, as above");
		const after = logs.length;
		await late;

		assert.deepEqual(logs.slice(after), [], "the RESTORED arm is gated too: a drain that gave up can see the write SUCCEED late just as easily as fail");
		assert.equal(redis.calls.filter((c) => c === "sadd").length, 0, "the late write must NOT re-index: a SADD after close's SREM is the ghost the drain exists to prevent");
		assert.deepEqual([...(redis.sets.get(HOST_SET) ?? [])], [], "so host:live stays empty");
		assert.equal(
			redis.calls.filter((c) => c === "pexpire").length,
			1,
			"and the PEXPIRE still ran, though `closed` was already true when it was issued: guarding it too would leave the row with NO expiry at all, where today it dies in ninety seconds",
		);
	}
});

test("a reader that writes nothing (prune: false) skips a dead member and leaves it for the next pruning reader", async () => {
	const redis = fakeRedis();
	redis.sets.set(HOST_SET, new Set(["ghost"]));
	const kept = await readLiveHosts(redis, { now: () => NOW, prune: false });
	assert.deepEqual(kept.hosts, []);
	assert.ok(!redis.calls.some((c) => c[0] === "srem"), "no SREM");
	assert.ok(redis.sets.get(HOST_SET).has("ghost"));
	await readLiveHosts(redis, { now: () => NOW });
	assert.ok(!redis.sets.get(HOST_SET).has("ghost"), "the default still prunes");
});

test("a member or a row name no worker can have is no host: skipped, its row never read for a bad member, never pruned (#737)", async () => {
	const redis = fakeRedis();
	const long = `a${"b".repeat(3000)}`;
	const members = ["mini1", long, "bad name", "-flag", "mini2", "mini3"];
	redis.sets.set(HOST_SET, new Set(members));
	for (const m of members) redis.hashes.set(hostKey(m), { name: m, beatAt: String(NOW) });
	// A member that holds to the rule, whose row names itself something that does not: the row is no host's either.
	redis.hashes.set(hostKey("mini2"), { name: "<b>mini2</b>", beatAt: String(NOW) });
	// A row with no name of its own is named by its member, as before.
	redis.hashes.set(hostKey("mini3"), { beatAt: String(NOW) });
	assert.ok(!WORKER_NAME_RE.test(long) && !WORKER_NAME_RE.test("bad name") && !WORKER_NAME_RE.test("-flag"));
	const { hosts } = await readLiveHosts(redis, { now: () => NOW });
	assert.deepEqual(hosts.map((h) => h.name), ["mini1", "mini3"]);
	assert.ok(!JSON.stringify(hosts).includes("bbbb") && !JSON.stringify(hosts).includes("<b>"), "nothing of a skipped row is handed on");
	const read = redis.calls.filter((c) => c[0] === "hgetall").map((c) => c[1]);
	assert.deepEqual(read, ["mini1", "mini2", "mini3"].map(hostKey), "a member that fails the rule is not even read");
	assert.ok(!redis.calls.some((c) => c[0] === "srem"), "and nothing is removed: what someone else wrote is not the reader's to delete");
	assert.deepEqual([...redis.sets.get(HOST_SET)], members);
});

// ---- issue #737: the row's age on Valkey's clock, the clock skew, and a row with no expiry ------------------------------

/**
 * `fakeRedis` plus a `pttl` the test answers per key: a number (the reply), or "throw" (a synchronous throw), "reject"
 * or "hang" (the real client's failure mode, see `fakeRedis`). Recorded in `calls` like every other command.
 */
function withPttl(redis, answerOf) {
	redis.pttl = (key) => {
		redis.calls.push(["pttl", key]);
		const answer = typeof answerOf === "function" ? answerOf(key) : answerOf;
		if (answer === "throw") throw new Error("pttl threw");
		if (answer === "reject") return Promise.reject(new Error("pttl refused"));
		if (answer === "hang") return new Promise(() => {});
		return Promise.resolve(answer);
	};
	return redis;
}

/** Index and write rows as a beat leaves them, `{ name: fields }`, without going through a registry. */
function seedRows(redis, rows) {
	redis.sets.set(HOST_SET, new Set(Object.keys(rows)));
	for (const [name, fields] of Object.entries(rows)) redis.hashes.set(hostKey(name), { name, ...fields });
}

test("each row's PTTL gives its age on Valkey's clock, the clock skew in both directions, and a row with no expiry (#737)", async () => {
	const age = 5000;
	const redis = fakeRedis();
	seedRows(redis, {
		even: { beatAt: String(NOW - age) },
		// The host's clock runs 120 s BEHIND the reader's: its beat reads 120 s older than it is.
		behind: { beatAt: String(NOW - age - 120_000) },
		ahead: { beatAt: String(NOW - age + 120_000) },
		forever: { beatAt: String(NOW - age) },
		raced: { beatAt: String(NOW - age) },
		nobeat: { version: "4.3.1" },
		fresh: { beatAt: String(NOW) },
	});
	const replies = { forever: -1, raced: -2, nobeat: HOST_TTL_MS - 1000, fresh: HOST_TTL_MS + 50 };
	withPttl(redis, (key) => replies[key.slice(hostKey("").length)] ?? HOST_TTL_MS - age);
	const { hosts } = await readLiveHosts(redis, { now: () => NOW });
	const by = Object.fromEntries(hosts.map((h) => [h.name, [h.ttlAgeMs, h.skewMs, h.noExpiry]]));
	assert.deepEqual(by, {
		even: [age, 0, false],
		behind: [age, 120_000, false],
		ahead: [age, -120_000, false],
		forever: [null, null, true],
		raced: [null, null, null],
		nobeat: [1000, null, false],
		fresh: [0, 0, false],
	});
	// The staleMs rule is unchanged: clamped at 0 for a host whose clock is ahead.
	assert.deepEqual(Object.fromEntries(hosts.map((h) => [h.name, h.staleMs])), { even: age, behind: age + 120_000, ahead: 0, forever: age, raced: age, nobeat: null, fresh: 0 });
	assert.equal(redis.calls.filter((c) => c[0] === "pttl").length, 7, "one PTTL per member");
	// A key that went between the HGETALL and the PTTL (-2) is still the row the HGETALL read: only the HGETALL prunes.
	assert.ok(redis.sets.get(HOST_SET).has("raced"));
});

test("a client without pttl gives the three fields as null, and a row's own fields of those names never stand in (#737)", async () => {
	const redis = fakeRedis();
	seedRows(redis, { mini1: { beatAt: String(NOW), ttlAgeMs: "1", skewMs: "999999", noExpiry: "true" } });
	const [row] = (await readLiveHosts(redis, { now: () => NOW })).hosts;
	assert.deepEqual([row.ttlAgeMs, row.skewMs, row.noExpiry], [null, null, null]);
	assert.ok(!redis.calls.some((c) => c[0] === "pttl"));
	withPttl(redis, -1);
	const [again] = (await readLiveHosts(redis, { now: () => NOW })).hosts;
	assert.deepEqual([again.ttlAgeMs, again.skewMs, again.noExpiry], [null, null, true], "the reader's value, not the row's text");
});

test("a PTTL that throws, rejects, hangs or answers no whole number costs the three fields, never the row (#737)", async () => {
	for (const answer of ["throw", "reject", "hang", "5000", 1.5, Number.NaN, null, undefined, -3]) {
		const redis = withPttl(fakeRedis(), answer);
		seedRows(redis, { mini1: { beatAt: String(NOW - 2000) } });
		const t0 = Date.now();
		const { hosts } = await readLiveHosts(redis, { now: () => NOW, timeoutMs: 30 });
		assert.ok(Date.now() - t0 < 1000, `${String(answer)}: bounded`);
		assert.equal(hosts.length, 1, String(answer));
		assert.equal(hosts[0].staleMs, 2000, String(answer));
		assert.deepEqual([hosts[0].ttlAgeMs, hosts[0].skewMs, hosts[0].noExpiry], [null, null, null], String(answer));
	}
});

test("the PTTL goes out beside the HGETALL, before either is answered, not as a second round trip after it (#737)", async () => {
	// An HGETALL that answers only once the PTTL has been asked: a reader awaiting the HGETALL first would wait past its
	// bound and lose the row.
	const redis = fakeRedis();
	seedRows(redis, { mini1: { beatAt: String(NOW - 2000) } });
	let asked;
	const pttlAsked = new Promise((resolve) => (asked = resolve));
	const hgetall = redis.hgetall.bind(redis);
	redis.hgetall = async (key) => {
		await pttlAsked;
		return hgetall(key);
	};
	redis.pttl = async () => {
		asked();
		return HOST_TTL_MS - 2000;
	};
	const { hosts } = await readLiveHosts(redis, { now: () => NOW, timeoutMs: 200 });
	assert.deepEqual(hosts.map((h) => [h.name, h.ttlAgeMs, h.skewMs]), [["mini1", 2000, 0]]);
});

test("ttlMs is the TTL the writer set: a reader told another one counts the age from it (#737)", async () => {
	const redis = withPttl(fakeRedis(), 7000);
	seedRows(redis, { mini1: { beatAt: String(NOW - 3000) } });
	const [row] = (await readLiveHosts(redis, { now: () => NOW, ttlMs: 10_000 })).hosts;
	assert.deepEqual([row.ttlAgeMs, row.skewMs], [3000, 0]);
	// A ttlMs that is no positive whole number is the registry's own.
	for (const ttlMs of [0, -1, 1.5, "10000", Number.NaN]) {
		const [odd] = (await readLiveHosts(redis, { now: () => NOW, ttlMs })).hosts;
		assert.equal(odd.ttlAgeMs, HOST_TTL_MS - 7000, String(ttlMs));
	}
});

test("a skew is claimed only past two beats: a read between a beat's HSET and its PEXPIRE is off by one beat period (#737)", async () => {
	assert.equal(HOST_SKEW_CLAIM_MS, 30_000);
	assert.equal(HOST_SKEW_CLAIM_MS, 2 * HOST_BEAT_MS);
	// The HSET has just written a new beatAt; the PTTL is still the one the PREVIOUS beat's PEXPIRE set.
	const redis = withPttl(fakeRedis(), HOST_TTL_MS - HOST_BEAT_MS);
	seedRows(redis, { mini1: { beatAt: String(NOW) } });
	const [row] = (await readLiveHosts(redis, { now: () => NOW })).hosts;
	assert.equal(row.skewMs, -HOST_BEAT_MS, "in sync clocks, read mid-beat");
	assert.ok(Math.abs(row.skewMs) < HOST_SKEW_CLAIM_MS, "below the claim, so no reader calls it a skew");
});

// ---- issue #712: the `backends` field ----------------------------------------------------------------------------------

test("the backends field (#712): names and fixed words that pass the content rule, read back through an allowlist", async () => {
	const { BACKEND_NAMES, HOST_GATEWAY_WORDS, OPENSHELL_ENGINES, hostBackendsField, parseHostBackends } = await import("../src/backends.mjs");
	const field = hostBackendsField({ backends: ["podman", "local", "openshell", "openshell-bind"], backendFloor: { egress: "enforced", nonRoot: "asserted" }, openshellEngine: "docker", gatewayWord: "local" });
	assert.equal(field, "blessed=podman,local,openshell,openshell-bind;floor=egress:enforced,nonRoot:asserted;os=docker:local");
	assert.deepEqual(parseHostBackends(field), { blessed: ["podman", "local", "openshell", "openshell-bind"], default: "podman", floor: { egress: "enforced", nonRoot: "asserted" }, openshell: { engine: "docker", gateway: "local", modes: ["copy", "bind"] } });
	// Through the registry's own write: not path-shaped, so it is published as it is.
	const redis = fakeRedis();
	const logs = [];
	const reg = makeHostRegistry({ redis, name: "mini1", log: (event, f) => logs.push({ event, ...f }) });
	await reg.start({ backends: field });
	await reg.close();
	assert.equal(logs.some((l) => l.event === "host_registry_field_refused"), false);
	// Every venue the table holds has the row's venue shape (the runs filter takes that shape), and round-trips.
	const { HOST_VENUE_NAME_RE } = await import("../src/backends.mjs");
	for (const name of BACKEND_NAMES) assert.match(name, HOST_VENUE_NAME_RE, name);
	for (const name of BACKEND_NAMES) assert.deepEqual(parseHostBackends(hostBackendsField({ backends: [name] })).blessed, [name], name);
	for (const engine of OPENSHELL_ENGINES) {
		for (const word of HOST_GATEWAY_WORDS) assert.deepEqual(parseHostBackends(hostBackendsField({ backends: ["openshell"], openshellEngine: engine, gatewayWord: word })).openshell, { engine, gateway: word, modes: ["copy"] });
	}
	// A word outside its list is never written: an engine is docker (the default the config reads), a gateway unknown.
	assert.equal(hostBackendsField({ backends: ["openshell"], openshellEngine: "/usr/bin/podman", gatewayWord: "https://gw:1" }), "blessed=openshell;os=docker:unknown");
	assert.equal(hostBackendsField({ backends: ["local"], openshellEngine: "podman" }), "blessed=local", "no os part without an openshell venue");
});

test("parseHostBackends (#712) re-checks a peer's row: shapes kept, anything else dropped, an older row is null", async () => {
	const { parseHostBackends } = await import("../src/backends.mjs");
	assert.equal(parseHostBackends(undefined), null, "a worker from before the field");
	assert.equal(parseHostBackends(""), null);
	assert.equal(parseHostBackends("floor=egress:enforced"), null, "no blessed list is not a row this reader can show");
	assert.equal(parseHostBackends("x".repeat(2000)), null, "bounded");
	// A venue this build does not know is kept by name (a newer worker's); a name of another shape is not.
	const got = parseHostBackends("blessed=far-venue,local,Bad Name,/tmp,local;floor=egress:enforced,egress:absent,nonRoot:maybe,a:b:c,x;os=lxc:somewhere;later=1");
	assert.deepEqual(got.blessed, ["far-venue", "local"]);
	assert.equal(got.default, "far-venue");
	assert.deepEqual(got.floor, { egress: "enforced" }, "the first of a twice-named property, words from the three only");
	assert.deepEqual(got.openshell, { engine: "unknown", gateway: "unknown", modes: [] });
	assert.deepEqual(parseHostBackends("blessed="), { blessed: [], default: null, floor: {}, openshell: null });
});

// Issue #1062: the rows were read one after another, each under a full bound, so three hosts behind a stalled scan cost
// three bounds, and a row that did not answer was dropped with nothing saying the listing was short.
/** Rows for `names` in a `fakeRedis`, each indexed, each a live routing host's. */
function rowsFor(redis, names) {
	for (const name of names) {
		redis.sets.set(HOST_SET, new Set([...(redis.sets.get(HOST_SET) ?? []), name]));
		redis.hashes.set(hostKey(name), { name, routes: "true", beatAt: String(NOW) });
	}
}

test("the registry read ends within its one bound however many rows do not answer, and says the listing is not whole (#1062)", async () => {
	const redis = fakeRedis();
	rowsFor(redis, ["hosta", "hostb", "hostc"]);
	const hgetall = redis.hgetall;
	// The index answers; every row is held, as behind a scan that stalled on the same connection.
	redis.hgetall = () => new Promise(() => {});
	const started = performance.now();
	const read = await readLiveHosts(redis, { now: () => NOW, timeoutMs: 300 });
	const ms = performance.now() - started;
	assert.ok(ms < 600, `one bound, not one per row (took ${Math.round(ms)} ms)`);
	assert.deepEqual(read, { hosts: [], incomplete: "3 of 3 host rows not read", unreadHosts: ["hosta", "hostb", "hostc"] }, "each row that did not answer is named");
	assert.deepEqual([...redis.sets.get(HOST_SET)].sort(), ["hosta", "hostb", "hostc"], "a row that was not read is never pruned");
	// One row held, two answered: those two are listed, and the listing still says it is not whole.
	redis.hgetall = (key) => (key === hostKey("hostb") ? new Promise(() => {}) : hgetall.call(redis, key));
	const part = await readLiveHosts(redis, { now: () => NOW, timeoutMs: 300 });
	assert.deepEqual([part.hosts.map((h) => h.name), part.incomplete, part.unreadHosts], [["hosta", "hostc"], "1 of 3 host rows not read", ["hostb"]]);
	// A row whose connection failed is no answer either.
	redis.hgetall = (key) => (key === hostKey("hosta") ? Promise.reject(new Error("Connection is closed.")) : hgetall.call(redis, key));
	assert.equal((await readLiveHosts(redis, { now: () => NOW, timeoutMs: 300 })).incomplete, "1 of 3 host rows not read");
	// Every row read: no such field, as before.
	redis.hgetall = hgetall;
	assert.equal(Object.hasOwn(await readLiveHosts(redis, { now: () => NOW, timeoutMs: 300 }), "incomplete"), false);
});

/** Valkey's error reply as ioredis rejects with it. */
const replyError = (message) => Object.assign(new Error(message), { name: "ReplyError" });
const WRONGTYPE = "WRONGTYPE Operation against a key holding the wrong kind of value";

test("a row Valkey answers with an error is a row not read, named with the reply's code, and never pruned (#1036)", async () => {
	const redis = fakeRedis();
	rowsFor(redis, ["hosta", "hostb", "hostc"]);
	const hgetall = redis.hgetall;
	redis.hgetall = (key) => (key === hostKey("hostb") ? Promise.reject(replyError(WRONGTYPE)) : hgetall.call(redis, key));
	const read = await readLiveHosts(redis, { now: () => NOW, timeoutMs: 300 });
	assert.deepEqual(read.hosts.map((h) => h.name), ["hosta", "hostc"], "the other rows are read as usual");
	assert.deepEqual([read.incomplete, read.unreadHosts, read.hostErrors], ["1 of 3 host rows not read, of which Valkey answered with an error: hostb (WRONGTYPE)", ["hostb"], { hostb: "WRONGTYPE" }]);
	assert.ok(!JSON.stringify(read).includes("Operation against"), "the reply's code alone, never its words");
	assert.deepEqual([...redis.sets.get(HOST_SET)].sort(), ["hosta", "hostb", "hostc"], "never pruned: only a row Valkey answered as empty is stale");
	// Beside a row that got no answer: both are not read, and only the one Valkey answered has a code.
	redis.hgetall = (key) => (key === hostKey("hostb") ? Promise.reject(replyError(WRONGTYPE)) : key === hostKey("hostc") ? new Promise(() => {}) : hgetall.call(redis, key));
	const both = await readLiveHosts(redis, { now: () => NOW, timeoutMs: 300 });
	assert.deepEqual([both.hosts.map((h) => h.name), both.incomplete, both.unreadHosts, both.hostErrors], [["hosta"], "2 of 3 host rows not read, of which Valkey answered with an error: hostb (WRONGTYPE)", ["hostb", "hostc"], { hostb: "WRONGTYPE" }]);
	// A row that got no answer alone: no `hostErrors` at all, and the words are as they were.
	redis.hgetall = (key) => (key === hostKey("hostc") ? new Promise(() => {}) : hgetall.call(redis, key));
	const late = await readLiveHosts(redis, { now: () => NOW, timeoutMs: 300 });
	assert.deepEqual([late.incomplete, late.unreadHosts, Object.hasOwn(late, "hostErrors")], ["1 of 3 host rows not read", ["hostc"], false]);
});

test("the words name at most five rows answered with an error and count the rest, while hostErrors holds every one (#1036)", async () => {
	const redis = fakeRedis();
	const names = ["h1", "h2", "h3", "h4", "h5", "h6", "h7"];
	rowsFor(redis, names);
	redis.hgetall = () => Promise.reject(replyError("ERR broken"));
	const read = await readLiveHosts(redis, { now: () => NOW, timeoutMs: 300 });
	assert.equal(read.incomplete, "7 of 7 host rows not read, of which Valkey answered with an error: h1 (ERR), h2 (ERR), h3 (ERR), h4 (ERR), h5 (ERR) and 2 more");
	assert.deepEqual([Object.keys(read.hostErrors), read.unreadHosts], [names, names]);
});

test("the index itself answered with an error is unreachable with the reply's code beside the words; any other failure has none (#1036)", async () => {
	const redis = fakeRedis();
	redis.smembers = () => Promise.reject(replyError(WRONGTYPE));
	assert.deepEqual(await readLiveHosts(redis, { timeoutMs: 300 }), { unreachable: WRONGTYPE, error: "WRONGTYPE" });
	redis.smembers = () => Promise.reject(new Error("Connection is closed."));
	assert.deepEqual(await readLiveHosts(redis, { timeoutMs: 300 }), { unreachable: "Connection is closed." });
	redis.smembers = () => new Promise(() => {});
	assert.deepEqual(await readLiveHosts(redis, { timeoutMs: 60 }), { unreachable: "registry timeout" });
});

test("a row's error code is replyErrorCode's, for every shape of reply and for an error that is no reply (#1036)", async () => {
	// The registry module keeps a copy of the rule (it imports two leaves and nothing else): held equal here, through
	// what the read answers for a row and for the index.
	for (const error of [replyError(WRONGTYPE), replyError("ERR Error running script (call to f_0123): @user_script:12: WRONGTYPE Operation against a key"), replyError("NOPERM this user has no permissions to run the 'hgetall' command"), replyError("NOSCRIPT"), replyError("something a proxy said"), replyError(""), new Error("Connection is closed."), Object.assign(new Error("WRONGTYPE x"), { name: "Error" })]) {
		const redis = fakeRedis();
		rowsFor(redis, ["hosta"]);
		redis.hgetall = () => Promise.reject(error);
		const row = await readLiveHosts(redis, { now: () => NOW, timeoutMs: 300 });
		const code = replyErrorCode(error);
		assert.deepEqual(row.hostErrors ?? null, code === null ? null : { hosta: code }, `a row: ${error.name} ${error.message}`);
		redis.smembers = () => Promise.reject(error);
		assert.equal((await readLiveHosts(redis, { timeoutMs: 300 })).error ?? null, code, `the index: ${error.name} ${error.message}`);
	}
});

test("a stale member found late in the bound is pruned within what is left of it, and the read still ends by the bound (#1062)", async () => {
	const redis = fakeRedis();
	rowsFor(redis, ["hosta"]);
	redis.sets.set(HOST_SET, new Set(["hosta", "ghost"]));
	const srem = redis.srem;
	let pruned = null;
	// The ghost's empty row answers after 200 ms of a 300 ms bound, and its SREM never answers: the read waits only what
	// is left, not a fresh bound for the write.
	const hgetall = redis.hgetall;
	redis.hgetall = async (key) => (key === hostKey("ghost") ? new Promise((resolve) => setTimeout(resolve, 200, {})) : hgetall.call(redis, key));
	redis.srem = (key, member) => ((pruned = member), new Promise(() => {}));
	const started = performance.now();
	const read = await readLiveHosts(redis, { now: () => NOW, timeoutMs: 300 });
	const ms = performance.now() - started;
	redis.srem = srem;
	assert.equal(pruned, "ghost", "the empty row's member is pruned");
	assert.ok(ms < 420, `within the one bound (took ${Math.round(ms)} ms)`);
	assert.deepEqual([read.hosts.map((h) => h.name), Object.hasOwn(read, "incomplete")], [["hosta"], false]);
});

test("liveHostNamesOf: a host whose row Valkey answered with an error is live, and a row that got no answer still makes the listing not known (#1036)", async () => {
	const redis = fakeRedis();
	rowsFor(redis, ["Mini1", "mini2", "mini3"]);
	const hgetall = redis.hgetall;
	// mini2's key is not a hash. The read finished and will answer the same next time: mini2 is named as live, and the
	// listing still vouches for who is gone (a host that is in neither list).
	redis.hgetall = (key) => (key === hostKey("mini2") ? Promise.reject(replyError(WRONGTYPE)) : hgetall.call(redis, key));
	const errored = await readLiveHosts(redis, { now: () => NOW, timeoutMs: 300 });
	assert.deepEqual([...liveHostNamesOf(errored, (n) => n.toLowerCase())].sort(), ["mini1", "mini2", "mini3"]);
	// Beside a row that got no answer, the listing is not known, as before.
	redis.hgetall = (key) => (key === hostKey("mini2") ? Promise.reject(replyError(WRONGTYPE)) : key === hostKey("mini3") ? new Promise(() => {}) : hgetall.call(redis, key));
	assert.equal(liveHostNamesOf(await readLiveHosts(redis, { now: () => NOW, timeoutMs: 300 })), null);
	// A listing that says it is not whole and does not say which rows: not known.
	assert.equal(liveHostNamesOf({ hosts: [{ name: "mini1" }], incomplete: "1 of 2 host rows not read", hostErrors: { mini2: "WRONGTYPE" } }), null);
});

test("liveHostNamesOf: a listing that is not whole is not known, never a fleet without the hosts it could not read (#1062)", () => {
	assert.deepEqual([...liveHostNamesOf({ hosts: [{ name: "Mini1" }, { name: "mini2" }] }, (n) => n.toLowerCase())], ["mini1", "mini2"]);
	assert.equal(liveHostNamesOf({ hosts: [{ name: "mini1" }], incomplete: "1 of 2 host rows not read" }), null);
	assert.equal(liveHostNamesOf({ unreachable: "ECONNREFUSED" }), null);
	assert.equal(liveHostNamesOf({}), null);
	assert.equal(liveHostNamesOf(null), null);
});

test("livePeers keeps the listing's incompleteness: a peer it could not read may disagree (#1062)", async () => {
	const redis = fakeRedis();
	rowsFor(redis, ["mini1", "mini2", "mini3"]);
	const hgetall = redis.hgetall;
	redis.hgetall = (key) => (key === hostKey("mini3") ? new Promise(() => {}) : hgetall.call(redis, key));
	const peers = await makeHostRegistry({ redis, name: "mini1", now: () => NOW, timeoutMs: 200 }).livePeers();
	assert.deepEqual([peers.hosts.map((h) => h.name), peers.incomplete], [["mini2"], "1 of 3 host rows not read"]);
});

test("the rows get what is left of the bound after the index: an index that answers late still ends the read by the bound (#1062)", async () => {
	const redis = fakeRedis();
	rowsFor(redis, ["hosta", "hostb"]);
	const smembers = redis.smembers;
	// The index answers 200 ms into a 300 ms bound, then every row hangs.
	redis.smembers = (key) => new Promise((resolve) => setTimeout(() => resolve(smembers.call(redis, key)), 200));
	redis.hgetall = () => new Promise(() => {});
	const started = performance.now();
	const read = await readLiveHosts(redis, { now: () => NOW, timeoutMs: 300 });
	const ms = performance.now() - started;
	assert.ok(ms < 420, `the rows had the 100 ms left, not a fresh 300 (took ${Math.round(ms)} ms)`);
	assert.equal(read.incomplete, "2 of 2 host rows not read");
});

test("a row whose HGETALL fails at once leaves no PTTL bound running once the read has ended (#1062)", async () => {
	const redis = fakeRedis();
	rowsFor(redis, ["hosta"]);
	redis.hgetall = () => Promise.reject(new Error("Connection is closed."));
	redis.pttl = () => new Promise(() => {});
	const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
	const before = timers();
	const read = await readLiveHosts(redis, { now: () => NOW, timeoutMs: 5_000 });
	assert.equal(read.incomplete, "1 of 1 host rows not read");
	assert.equal(timers(), before, "the PTTL's five-second bound was cleared, so it holds nothing open");
});
