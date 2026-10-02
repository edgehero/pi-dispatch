import assert from "node:assert/strict";
import { test } from "node:test";
import { RELEASE_IF_MINE, checkSlotKey, endpointSlotKey, hash16, makeClaimSweeper, makeFleetLease, makeScopeClaimSweeper, scopeSlotKey } from "../src/fleet-lease.mjs";
import { scopeKeyPrefix } from "../src/scoped-limits.mjs";

// A Valkey with real SET NX PX semantics, since that atomicity IS the mechanism under test.
function fakeRedis({ fail = false, hang = false } = {}) {
	const store = new Map();
	const evals = [];
	const guard = () => {
		if (fail) throw new Error("ECONNREFUSED");
		if (hang) return new Promise(() => {});
		return null;
	};
	return {
		store,
		evals,
		async set(key, value, _px, _ms, nx) {
			await guard();
			if (nx === "NX" && store.has(key)) return null;
			store.set(key, value);
			return "OK";
		},
		async get(key) {
			await guard();
			return store.get(key) ?? null;
		},
		// The two scripts' semantics, which is what the fake stands in for: compare-and-delete, exact value or prefix.
		async eval(script, _n, key, arg) {
			await guard();
			evals.push(key);
			const v = store.get(key);
			const mine = script === RELEASE_IF_MINE ? v === arg : typeof v === "string" && v.startsWith(arg);
			if (!mine) return 0;
			store.delete(key);
			return 1;
		},
		async del(key) {
			await guard();
			store.delete(key);
		},
		async pexpire() {
			await guard();
		},
	};
}

const lease = (redis, over = { holderPrefix: "mini1" }) =>
	makeFleetLease({ redis, keyFor: checkSlotKey, ttlMs: 10_000, timeoutMs: 50, ...over });

test("N slots means N holders across HOSTS, which is the whole point", async () => {
	// The bound used to be an in-process Map, so `PI_WAIT_CHECK_SLOTS=1` permitted one check PER HOST and
	// silently multiplied by the deployment's shape. Two independent leases stand in for two machines.
	const redis = fakeRedis();
	const mini1 = lease(redis, { holderPrefix: "mini1" });
	const mini2 = lease(redis, { holderPrefix: "mini2" });

	const a = await mini1.acquire("job-a", { slots: 1 });
	assert.ok(a);
	const b = await mini2.acquire("job-b", { slots: 1 });
	assert.equal(b, null, "a second HOST is refused by a bound that used to be per-process");

	await a.release();
	const c = await mini2.acquire("job-b", { slots: 1 });
	assert.ok(c, "and the slot is reusable once the holder gives it back");
});

test("release is RELEASE-IF-MINE, which the in-process map is not", async () => {
	// `makeInFlight().release` clamps at zero, but a double release on a `concurrent: 2` scope frees the
	// OTHER holder's slot. Here a second release finds a value that is no longer ours and does nothing.
	const redis = fakeRedis();
	const mini1 = lease(redis, { holderPrefix: "mini1" });
	const mini2 = lease(redis, { holderPrefix: "mini2" });

	const a = await mini1.acquire("job-a", { slots: 1 });
	await a.release();
	const b = await mini2.acquire("job-b", { slots: 1 });
	assert.ok(b);
	await a.release(); // the double release
	assert.equal(await redis.get(b.key), "mini2#job-b", "the other host still holds its slot");
});

test("probing ROTATES, so a host does not starve behind slot zero while another is free", async () => {
	const redis = fakeRedis();
	const l = lease(redis);
	const held = [];
	for (const id of ["a", "b", "c", "d"]) {
		const h = await l.acquire(id, { slots: 4 });
		assert.ok(h, id);
		held.push(h.key);
	}
	assert.equal(new Set(held).size, 4, "four ids fill four distinct slots");
	assert.equal(await l.acquire("e", { slots: 4 }), null, "and the fifth is refused");

	// The rotation itself, pinned against an EMPTY store each time: without it every host tries slot 0
	// first, so one can sit behind a busy slot while another is free two along -- a starvation that looks
	// exactly like the capacity shortage this bound exists to report.
	const first = [];
	for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
		first.push((await lease(fakeRedis()).acquire(id, { slots: 4 })).key);
	}
	assert.ok(new Set(first).size > 1, "different ids start at different slots, rather than all probing zero");
});

test("refresh extends only a slot we still hold", async () => {
	const redis = fakeRedis();
	const mini1 = lease(redis, { holderPrefix: "mini1" });
	const h = await mini1.acquire("job-a", { slots: 1 });
	assert.equal(await h.refresh(), true);
	// Simulate the claim having been taken over after an expiry: refresh must report the loss rather than
	// extending a window that now belongs to someone else.
	redis.store.set(h.key, "mini2#job-z");
	assert.equal(await h.refresh(), false);
});

test("a fault GRANTS, because failing closed would wedge every wait in the deployment", async () => {
	// The in-process bound is still underneath, so failing open degrades the fleet ceiling to the per-host
	// one -- which is precisely the behaviour before this lease existed.
	const logs = [];
	for (const redis of [fakeRedis({ fail: true }), fakeRedis({ hang: true })]) {
		const l = makeFleetLease({ redis, holderPrefix: "mini1", keyFor: checkSlotKey, ttlMs: 10_000, timeoutMs: 30, log: (e) => logs.push(e) });
		const h = await l.acquire("job-a", { slots: 1 });
		assert.ok(h?.ok, "granted");
		assert.equal(h.degraded, true);
		await h.release(); // must not throw
	}
	assert.deepEqual(logs, ["fleet_lease_unavailable", "fleet_lease_unavailable"]);
});

test("slots below one is not a lease at all, so nothing is issued", async () => {
	const redis = fakeRedis();
	const l = lease(redis);
	// `concurrencyFor` returns Infinity for an unlimited forge scope, so a deployment with no
	// scoped-limits file must issue no command whatsoever.
	const h = await l.acquire("job-a", { slots: Number.POSITIVE_INFINITY });
	assert.ok(h.ok);
	assert.equal(redis.store.size, 0, "an unlimited scope touches Valkey not at all");
});

// --- the boot sweep, and the precondition it rests on ---------------------------------------------------

test("the sweep deletes only THIS host's claims", async () => {
	const redis = fakeRedis();
	await redis.set(scopeSlotKey("abc", 0), "mini1#old-job", "PX", 1, "NX");
	await redis.set(scopeSlotKey("abc", 1), "mini2#live-job", "PX", 1, "NX");
	const sweep = makeScopeClaimSweeper({ redis, workerName: "mini1", limits: [{ concurrent: 2, hash: "abc" }] });

	const res = await sweep({ reaped: true });
	assert.equal(res.swept, 1);
	assert.equal(await redis.get(scopeSlotKey("abc", 0)), null, "ours is gone");
	assert.equal(await redis.get(scopeSlotKey("abc", 1)), "mini2#live-job", "another host's is untouched");
});

test("a reaper that did NOT enumerate must not sweep -- the money finding", async () => {
	// `makeReaper` catches its own `docker ps` failure, and on that path nothing was listed and nothing
	// reaped. This host has therefore NOT established that it holds no containers, so its claims may be
	// for containers that are still running -- and freeing those slots lets ANOTHER host start more
	// alongside them. `makeInFlight`'s own escape ("no NEW container can start either") does not transfer,
	// because the sweep frees slots for a different machine.
	const redis = fakeRedis();
	await redis.set(scopeSlotKey("abc", 0), "mini1#maybe-still-running", "PX", 1, "NX");
	const logs = [];
	const sweep = makeScopeClaimSweeper({ redis, workerName: "mini1", limits: [{ concurrent: 1, hash: "abc" }], log: (e, f) => logs.push({ e, f }) });

	const res = await sweep({ reaped: false });
	assert.deepEqual(res, { swept: 0, skipped: true });
	assert.equal(await redis.get(scopeSlotKey("abc", 0)), "mini1#maybe-still-running", "the claim stands, and the TTL is the backstop");
	assert.equal(logs[0].e, "scope_claims_sweep_skipped");
	assert.equal(logs[0].f.reason, "reaper-skipped");
});

test("the sweep is driven by CONFIG, not by a scan, and never throws", async () => {
	// `scoped-limits.json` enumerates every scope that can carry a claim and `concurrent` bounds the
	// index, so this is sum(concurrent) GETs -- no KEYS, no SCAN, and no index set to leak.
	const gets = [];
	const redis = { async eval(_s, _n, k) { gets.push(k); return 0; }, async get() {}, async del() {}, async set() {} };
	await makeScopeClaimSweeper({ redis, workerName: "m", limits: [{ concurrent: 2, hash: "aa" }, { concurrent: 3, hash: "bb" }, { concurrent: 0, hash: "cc" }, { hash: "dd" }] })({ reaped: true });
	assert.equal(gets.length, 5, "two plus three; a zero or absent ceiling can hold no claim");

	// A fault never throws, and (since PR #518's gate) ends the sweep there and says so, rather than paying one
	// timeout per remaining key before boot goes on.
	const dead = { async eval() { throw new Error("ECONNREFUSED"); }, async get() {}, async del() {}, async set() {} };
	const logs = [];
	const res = await makeScopeClaimSweeper({ redis: dead, workerName: "m", limits: [{ concurrent: 1, hash: "aa" }], log: (e, f) => logs.push({ e, f }) })({ reaped: true });
	assert.deepEqual(res, { swept: 0, skipped: true }, "best-effort: an optimisation over the TTL, never the mechanism");
	assert.equal(logs[0].e, "scope_claims_sweep_skipped");
	assert.equal(logs[0].f.reason, "valkey-fault");
});

test("a per-key reply error (WRONGTYPE) is logged by key and the sweep goes on; only a server fault stops it", async () => {
	const redis = fakeRedis();
	const wrong = endpointSlotKey("hh", 0);
	await redis.set(endpointSlotKey("hh", 1), "mini1#old", "PX", 1, "NX");
	const evalOk = redis.eval;
	redis.eval = async (script, n, key, arg) => {
		if (key === wrong) throw Object.assign(new Error("WRONGTYPE Operation against a key holding the wrong kind of value"), { name: "ReplyError" });
		return evalOk(script, n, key, arg);
	};
	const logs = [];
	const res = await makeClaimSweeper({ redis, workerName: "mini1", keyFor: endpointSlotKey, rows: [{ hash: "hh", count: 2 }], event: "endpoint_claims", log: (e, f) => logs.push({ e, f }) })({ reaped: true });
	assert.deepEqual(res, { swept: 1, skipped: false }, "the key after the bad one was still swept");
	assert.deepEqual(logs.map((l) => l.e), ["endpoint_claims_sweep_key_error", "endpoint_claims_swept"]);
	assert.equal(logs[0].f.key, wrong);
});

test("the sweep's prefix is ANCHORED: a value holding `mini1#` anywhere but at its start is not this host's", async () => {
	const redis = fakeRedis();
	await redis.set(endpointSlotKey("hh", 0), "xmini1#j", "PX", 1, "NX");
	await redis.set(endpointSlotKey("hh", 1), "mini2#mini1#x", "PX", 1, "NX");
	await redis.set(endpointSlotKey("hh", 2), "mini1#mine", "PX", 1, "NX");
	const res = await makeClaimSweeper({ redis, workerName: "mini1", keyFor: endpointSlotKey, rows: [{ hash: "hh", count: 3 }], event: "endpoint_claims" })({ reaped: true });
	assert.deepEqual(res, { swept: 1, skipped: false });
	assert.equal(redis.store.get(endpointSlotKey("hh", 0)), "xmini1#j");
	assert.equal(redis.store.get(endpointSlotKey("hh", 1)), "mini2#mini1#x");
});

test("a Valkey that never answers costs the boot sweep ONE timeout, not one per key", async () => {
	// 64 indexes per endpoint at a 2 s bound each was ~128 s per endpoint before the worker started (PR #518's gate).
	let calls = 0;
	const hung = { async eval() { calls++; return new Promise(() => {}); } };
	const logs = [];
	const started = Date.now();
	const res = await makeClaimSweeper({ redis: hung, workerName: "m", keyFor: endpointSlotKey, rows: [{ hash: "aa", count: 64 }, { hash: "bb", count: 64 }], event: "endpoint_claims", log: (e, f) => logs.push({ e, f }), timeoutMs: 30 })({ reaped: true });
	assert.deepEqual(res, { swept: 0, skipped: true });
	assert.equal(calls, 1, "the sweep stopped at its first fault");
	assert.ok(Date.now() - started < 1_000, "and took one timeout");
	assert.deepEqual(logs.map((l) => [l.e, l.f.reason]), [["endpoint_claims_sweep_skipped", "valkey-fault"]]);
});

test("release is ATOMIC compare-and-delete: a release after the TTL cannot free the claim another host took since", async () => {
	// GET then DEL let a late release delete the next holder's claim (measured on PR #518's gate). The release is now
	// one script; the fake runs it as Valkey does, and the integration test below runs the real one.
	const redis = fakeRedis();
	const mini1 = lease(redis, { holderPrefix: "mini1" });
	const a = await mini1.acquire("job-a", { slots: 1 });
	// The race itself: right after the release's FIRST command, the TTL runs out and mini2 takes the slot. A GET then
	// DEL deletes mini2's claim in its second step; one compare-and-delete has no second step to land it in.
	let retaken = false;
	const retakeAfter = (fn) => async (...args) => {
		const v = await fn(...args);
		if (!retaken) (retaken = true), redis.store.set(a.key, "mini2#job-b");
		return v;
	};
	redis.get = retakeAfter(redis.get);
	redis.eval = retakeAfter(redis.eval);
	await a.release();
	assert.equal(redis.store.get(a.key), "mini2#job-b", "the other host's claim survives the late release");
	assert.deepEqual(redis.evals, [a.key], "one command, not a GET then a DEL");
});

test("a DEGRADED grant still releases, compare-and-delete, every key it tried: a timed-out SET can land late", async () => {
	// The shared client queues rather than rejects, so a SET the lease gave up on lands later and held the slot for a
	// whole TTL with a no-op release (measured on PR #518's gate with a slow Valkey).
	const store = new Map();
	const evals = [];
	let landLate;
	const redis = {
		set(key, value) {
			// Answers after the bound: the lease times out, then the write lands.
			return new Promise((resolve) => {
				landLate = () => (store.set(key, value), resolve("OK"));
			});
		},
		async eval(script, _n, key, arg) {
			evals.push(key);
			if (store.get(key) !== arg) return 0;
			store.delete(key);
			return 1;
		},
	};
	const h = await makeFleetLease({ redis, holderPrefix: "mini1", keyFor: endpointSlotKey, ttlMs: 60_000, timeoutMs: 20 }).acquire("job-a", { slots: 2, keyArgs: ["hh"] });
	assert.equal(h.degraded, true);
	landLate();
	const [key] = [...store.keys()];
	assert.equal(store.get(key), "mini1#job-a", "the abandoned SET landed");
	await h.release();
	assert.equal(store.size, 0, "and the degraded release removed it");
	store.set(key, "mini2#other");
	await h.release();
	assert.equal(store.get(key), "mini2#other", "never another holder's");
});

// --- the model endpoint slots (issue #503) -------------------------------------------------------------

test("endpoint slot keys are slot:m:<hash16(id)>:<i>, and hash16 is the one spelling scopeKeyPrefix uses too", () => {
	assert.equal(hash16("mac-ollama"), "4819885c480a71a3", "sha256, first sixteen hex: a golden, so the key a fleet shares cannot drift between builds");
	assert.match(hash16("mac-ollama"), /^[0-9a-f]{16}$/);
	assert.equal(endpointSlotKey(hash16("mac-ollama"), 3), `slot:m:${hash16("mac-ollama")}:3`);
	assert.notEqual(endpointSlotKey("h", 0), scopeSlotKey("h", 0), "a scope and an endpoint with one hash never share a key");
	assert.equal(scopeKeyPrefix("acme/web"), `budget:s:${hash16("acme/web")}`, "the budget prefix kept its value through the refactor");
	assert.equal(hash16("acme/web"), "86f279ce9c29f106");
});

test("the endpoint sweep deletes only THIS host's slot:m: claims, and only after a reaper that enumerated", async () => {
	const redis = fakeRedis();
	const h = hash16("mac-ollama");
	await redis.set(endpointSlotKey(h, 0), "mini1#old-job", "PX", 1, "NX");
	await redis.set(endpointSlotKey(h, 1), "mini2#live-job", "PX", 1, "NX");
	await redis.set(endpointSlotKey(h, 63), "mini1#above-a-lowered-slots", "PX", 1, "NX");
	await redis.set(scopeSlotKey(h, 2), "mini1#a-scope-claim", "PX", 1, "NX");
	const logs = [];
	const sweeper = (reaped) => makeClaimSweeper({ redis, workerName: "mini1", keyFor: endpointSlotKey, rows: [{ hash: h, count: 64 }], event: "endpoint_claims", log: (e, f) => logs.push({ e, f }) })({ reaped });

	assert.deepEqual(await sweeper(false), { swept: 0, skipped: true });
	assert.equal(logs.at(-1).e, "endpoint_claims_sweep_skipped");
	assert.equal(redis.store.size, 4, "nothing touched while the reaper had not enumerated");

	assert.deepEqual(await sweeper(true), { swept: 2, skipped: false });
	assert.deepEqual(logs.at(-1), { e: "endpoint_claims_swept", f: { count: 2 } });
	assert.equal(await redis.get(endpointSlotKey(h, 0)), null);
	assert.equal(await redis.get(endpointSlotKey(h, 63)), null, "an index above today's slots is still swept");
	assert.equal(await redis.get(endpointSlotKey(h, 1)), "mini2#live-job", "another host's claim stands");
	assert.equal(await redis.get(scopeSlotKey(h, 2)), "mini1#a-scope-claim", "and a scope claim is not this sweep's");
});

test("makeScopeClaimSweeper is the generic sweep over slot:s:, with its own log names", async () => {
	const redis = fakeRedis();
	await redis.set(scopeSlotKey("abc", 0), "mini1#old", "PX", 1, "NX");
	const logs = [];
	await makeScopeClaimSweeper({ redis, workerName: "mini1", limits: [{ concurrent: 1, hash: "abc" }], log: (e) => logs.push(e) })({ reaped: true });
	assert.deepEqual(logs, ["scope_claims_swept"]);
});

// --- against a real Valkey: the scripts themselves -----------------------------------------------------

const valkeyUrl = process.env.VALKEY_TEST_URL;
const live = valkeyUrl ? false : "VALKEY_TEST_URL not set; the compare-and-delete scripts need a real Valkey";

test("on a real Valkey, a late release and the sweep each delete only what is still this host's", { skip: live }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(valkeyUrl);
	redis.on("error", () => {});
	// A throwaway hash, so a deployment pointed at this Valkey never sees these keys.
	const h = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		const mini1 = makeFleetLease({ redis, holderPrefix: "mini1", keyFor: endpointSlotKey, ttlMs: 60_000 });
		const a = await mini1.acquire("job-a", { slots: 1, keyArgs: [h] });
		assert.equal(await redis.get(a.key), "mini1#job-a");
		await redis.set(a.key, "mini2#job-b", "PX", 60_000); // expired and re-taken by another host
		await a.release();
		assert.equal(await redis.get(a.key), "mini2#job-b", "the late release left the other host's claim");
		await redis.set(a.key, "mini1#job-a", "PX", 60_000);
		await a.release();
		assert.equal(await redis.get(a.key), null, "and released its own");

		await redis.set(endpointSlotKey(h, 0), "mini1#old", "PX", 60_000);
		await redis.set(endpointSlotKey(h, 1), "mini2#live", "PX", 60_000);
		await redis.set(endpointSlotKey(h, 2), "mini10#prefix-twin", "PX", 60_000);
		await redis.set(endpointSlotKey(h, 3), "xmini1#j", "PX", 60_000);
		await redis.set(endpointSlotKey(h, 4), "mini2#mini1#x", "PX", 60_000);
		await redis.rpush(endpointSlotKey(h, 5), "not-a-claim"); // WRONGTYPE for the script's GET
		await redis.pexpire(endpointSlotKey(h, 5), 60_000);
		await redis.set(endpointSlotKey(h, 6), "mini1#after-the-list", "PX", 60_000);
		const logs = [];
		const res = await makeClaimSweeper({ redis, workerName: "mini1", keyFor: endpointSlotKey, rows: [{ hash: h, count: 7 }], event: "endpoint_claims", log: (e, f) => logs.push({ e, f }) })({ reaped: true });
		assert.deepEqual(res, { swept: 2, skipped: false }, "index 0 and index 6, past the WRONGTYPE key");
		assert.equal(await redis.get(endpointSlotKey(h, 1)), "mini2#live");
		assert.equal(await redis.get(endpointSlotKey(h, 2)), "mini10#prefix-twin", "the `#` keeps mini1 from matching mini10");
		assert.equal(await redis.get(endpointSlotKey(h, 3)), "xmini1#j", "the prefix is anchored at the start");
		assert.equal(await redis.get(endpointSlotKey(h, 4)), "mini2#mini1#x", "and only at the start");
		assert.equal(await redis.get(endpointSlotKey(h, 6)), null);
		assert.deepEqual(logs.map((l) => [l.e, l.f.key ?? null]), [["endpoint_claims_sweep_key_error", endpointSlotKey(h, 5)], ["endpoint_claims_swept", null]]);
		assert.match(logs[0].f.reason, /WRONGTYPE/);
	} finally {
		await redis.del(...[0, 1, 2, 3, 4, 5, 6].map((i) => endpointSlotKey(h, i))).catch(() => {});
		redis.disconnect();
	}
});
