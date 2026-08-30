import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileGated, reloadSchedules } from "../src/cron.mjs";
import { cronFingerprint, fingerprint } from "../src/fingerprint.mjs";

const sched = (id, pattern = "0 3 * * *") => ({
	schedulerId: id,
	name: "local",
	pattern,
	data: { kind: "local", folder: "/srv/site", flow: "nightly", provider: "anthropic", model: "m", maxTurns: 30 },
	opts: { removeOnComplete: { age: 86400 } },
});

function fakeQueue() {
	const calls = [];
	return {
		calls,
		async upsertJobScheduler(id, repeat, opts) {
			calls.push(["upsert", id]);
			return {};
		},
		async getJobSchedulers() {
			calls.push(["list"]);
			return [];
		},
		async removeJobScheduler(id) {
			calls.push(["remove", id]);
		},
	};
}

function fakeRegistry(peers, { unreachable = false } = {}) {
	const published = [];
	return {
		published,
		async publish() {
			published.push(true);
		},
		async livePeers() {
			return unreachable ? { unreachable: "ECONNREFUSED" } : { hosts: peers };
		},
	};
}

// --- the fingerprint ------------------------------------------------------------------------------------

test("keys are sorted RECURSIVELY, so two worker versions cannot disagree about one file", () => {
	// `normalizeCronSchedule` builds `data` as a literal, so its key ORDER is a property of the worker's
	// source. Without a recursive sort, a rolling upgrade would freeze cron for its whole duration.
	assert.equal(fingerprint({ a: 1, b: { x: 1, y: 2 } }), fingerprint({ b: { y: 2, x: 1 }, a: 1 }));
	assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 1, c: null }), "a genuinely new field still moves it");
	assert.equal(fingerprint([1, 2]), fingerprint([1, 2]));
	assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]), "array ORDER is meaning, unlike key order");
	assert.match(fingerprint({}), /^[0-9a-f]{16}$/);
});

test("ABSTAIN and OPINE are different, and conflating them would leave the bug in place", () => {
	// `PI_TRIGGERS_FILE` unset means cron is DISABLED here: no view of what should be scheduled, so this
	// host must never be able to disagree with one that has a view.
	assert.equal(cronFingerprint(null), null, "abstain");
	assert.equal(cronFingerprint(undefined), null);
	// A file that declares zero cron entries is an OPINION -- "there should be no schedulers" -- and it is
	// this bug's purest form, since that is exactly what prunes the fleet through the watch path today.
	assert.match(cronFingerprint([]), /^[0-9a-f]{16}$/, "opine");
	assert.notEqual(cronFingerprint([]), cronFingerprint([sched("a")]));
});

test("the host TIMEZONE rides the hash, because a cron pattern carries none", () => {
	// `triggers.json` has no `tz` on a cron entry and BullMQ hands the pattern to cron-parser with no zone,
	// so it resolves in each worker's LOCAL time: one pattern is two instants on two hosts in two zones.
	const set = [sched("nightly")];
	assert.notEqual(cronFingerprint(set, { tz: "Europe/Amsterdam" }), cronFingerprint(set, { tz: "America/New_York" }));
	assert.equal(cronFingerprint(set, { tz: "UTC" }), cronFingerprint(set, { tz: "UTC" }));
});

// --- the gate -------------------------------------------------------------------------------------------

test("no peers: reconcile runs, and NOT ONE new byte is logged", async () => {
	const logs = [];
	const queue = fakeQueue();
	const res = await reconcileGated(queue, [sched("a")], { registry: fakeRegistry([]), log: (e, f) => logs.push({ e, f }) });
	assert.deepEqual(res, { installed: 1, removed: 0 });
	assert.deepEqual(queue.calls, [["upsert", "a"], ["list"]]);
	// The single-host byte-identity pin: `cron_agreement` is gated on peers > 0.
	assert.deepEqual(logs.map((l) => l.e), [], "a single-host deployment's log is unchanged");
});

test("an AGREEING peer proceeds and says so once", async () => {
	const logs = [];
	const set = [sched("a")];
	const mine = cronFingerprint(set, { tz: "UTC" });
	const res = await reconcileGated(fakeQueue(), set, {
		registry: fakeRegistry([{ name: "mini2", fpCron: mine, cronCount: "1" }]),
		log: (e, f) => logs.push({ e, f }),
		tz: "UTC",
	});
	assert.equal(res.installed, 1);
	assert.deepEqual(logs.map((l) => l.e), ["cron_agreement"]);
	assert.equal(logs[0].f.peers, 1);
});

test("a DISAGREEING peer refuses BOTH halves, returns rather than throws, and names the hosts", async () => {
	const logs = [];
	const queue = fakeQueue();
	const res = await reconcileGated(queue, [sched("a")], {
		registry: fakeRegistry([{ name: "mini2", fpCron: "deadbeefdeadbeef", cronCount: "4" }]),
		log: (e, f) => logs.push({ e, f }),
		tz: "UTC",
	});
	assert.deepEqual(res, { refused: "cron-divergence", peers: ["mini2"] });
	// Neither upserted NOR pruned. Upsert on an existing id is a REDEFINITION, so permitting it would let
	// two hosts flip one schedule between two definitions on every file change with nothing logged.
	assert.deepEqual(queue.calls, [], "the resident set is left exactly as it was");
	const line = logs.find((l) => l.e === "cron_divergence_refused");
	assert.equal(line.f.peers[0].host, "mini2");
	assert.equal(line.f.peers[0].cronCount, 4, "the count is in the MESSAGE, never in the rule");
	assert.equal(line.f.cronCount, 1);
});

test("an ABSTAINING peer never refuses, however different its set", async () => {
	const queue = fakeQueue();
	const res = await reconcileGated(queue, [sched("a")], {
		// cron disabled on mini2: it publishes no fingerprint and holds no view.
		registry: fakeRegistry([{ name: "mini2", fpCron: "", cronCount: "0" }]),
		tz: "UTC",
	});
	assert.equal(res.installed, 1);
});

test("a peer that declares ZERO cron entries IS a disagreeing party -- the bug's purest form", async () => {
	const queue = fakeQueue();
	const res = await reconcileGated(queue, [sched("a")], {
		registry: fakeRegistry([{ name: "mini2", fpCron: cronFingerprint([], { tz: "UTC" }), cronCount: "0" }]),
		tz: "UTC",
	});
	assert.equal(res.refused, "cron-divergence", "deleting the last cron trigger on one host must not prune the fleet's");
	assert.deepEqual(queue.calls, []);
});

test("ABSENCE never refuses: an unreadable registry, or none at all, proceeds", async () => {
	// The rule only ever WITHHOLDS a permission relative to today, which is why it cannot be a regression --
	// and why a Valkey blip cannot wedge a single-host deployment.
	const a = await reconcileGated(fakeQueue(), [sched("a")], { registry: fakeRegistry([], { unreachable: true }) });
	assert.equal(a.installed, 1);
	const b = await reconcileGated(fakeQueue(), [sched("a")], {});
	assert.equal(b.installed, 1, "no registry wired is the same answer as one that cannot be read");
});

test("PUBLISH happens before READ, which is what makes the legitimate-edit sequence race-free", async () => {
	const order = [];
	const registry = {
		// `publish` takes no fields since the thunk fix: passing a computed fingerprint in would REPLACE the
		// closure the heartbeat installed, so every later beat would republish a frozen value.
		async publish(...args) {
			order.push(["publish", args.length]);
		},
		async livePeers() {
			order.push(["read"]);
			return { hosts: [] };
		},
	};
	await reconcileGated(fakeQueue(), [sched("a")], { registry, tz: "UTC" });
	assert.equal(order[0][0], "publish");
	assert.equal(order[1][0], "read");
	assert.equal(order[0][1], 0, "and it passes NO fields, so the heartbeat's thunks survive it");
});

test("the WATCH path is gated too, and it updates the live ref it fingerprints from", async () => {
	// This is the path that carries the bug: `start.mjs` skips the boot reconcile for an empty set, but the
	// reload has no such guard, so deleting the last cron trigger prunes every host's schedulers.
	const ref = { current: [sched("a")] };
	const queue = fakeQueue();
	const logs = [];
	const res = await reloadSchedules({ triggersFile: "/t.json" }, queue, {
		loadFn: () => [],
		ref,
		registry: fakeRegistry([{ name: "mini2", fpCron: "deadbeefdeadbeef", cronCount: "1" }]),
		log: (e, f) => logs.push({ e, f }),
		tz: "UTC",
	});
	assert.equal(res.ok, undefined, "a refusal is not an ok reload");
	assert.deepEqual(queue.calls, [], "and the fleet's resident schedulers are untouched");
	assert.ok(logs.some((l) => l.e === "cron_divergence_refused"));
	assert.deepEqual(ref.current, [], "the ref tracks what this host now believes, so the next beat fingerprints THAT");
});

test("an INVALID edit keeps the last-good ref as well as the running schedulers", async () => {
	const ref = { current: [sched("a")] };
	const logs = [];
	const res = await reloadSchedules({ triggersFile: "/t.json" }, fakeQueue(), {
		loadFn: () => {
			throw Object.assign(new Error("bad json"), { piDispatchConfig: true });
		},
		ref,
		log: (e, f) => logs.push({ e, f }),
	});
	assert.ok(res.invalid);
	assert.deepEqual(ref.current, [sched("a")], "a typo must not make this host publish an empty opinion");
	assert.ok(logs.some((l) => l.e === "schedules_reload_invalid"));
});
