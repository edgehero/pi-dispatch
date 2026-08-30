import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSlotKey, makeFleetLease, makeScopeClaimSweeper, scopeSlotKey } from "../src/fleet-lease.mjs";

// A Valkey with real SET NX PX semantics, since that atomicity IS the mechanism under test.
function fakeRedis({ fail = false, hang = false } = {}) {
	const store = new Map();
	const guard = () => {
		if (fail) throw new Error("ECONNREFUSED");
		if (hang) return new Promise(() => {});
		return null;
	};
	return {
		store,
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
	const redis = { async get(k) { gets.push(k); return null; }, async del() {}, async set() {} };
	await makeScopeClaimSweeper({ redis, workerName: "m", limits: [{ concurrent: 2, hash: "aa" }, { concurrent: 3, hash: "bb" }, { concurrent: 0, hash: "cc" }, { hash: "dd" }] })({ reaped: true });
	assert.equal(gets.length, 5, "two plus three; a zero or absent ceiling can hold no claim");

	const dead = { async get() { throw new Error("ECONNREFUSED"); }, async del() {}, async set() {} };
	const res = await makeScopeClaimSweeper({ redis: dead, workerName: "m", limits: [{ concurrent: 1, hash: "aa" }] })({ reaped: true });
	assert.deepEqual(res, { swept: 0, skipped: false }, "best-effort: an optimisation over the TTL, never the mechanism");
});
