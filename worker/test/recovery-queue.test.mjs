import assert from "node:assert/strict";
import { existsSync, lstatSync, lutimesSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	RECOVER_PENDING_KEY,
	RECOVERY_KEPT_HOLD_KEYS,
	RECOVERY_STRIPPED_KEYS,
	RECOVERY_TTL_MS,
	isRecoveryArmed,
	makeHostLostSweep,
	makeRecoveryEnqueuer,
	makeSalvager,
	pendingMember,
	pointedJobDirs,
	recoveryClaimKey,
	recoveryJobId,
	runIdOf,
	sweepOrphanJobDirs,
} from "../src/recovery-queue.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #645, durable runs: the queue half. The routing, the id scheme, the options, the cap, the claim's two branches,
// the pending set and the host-lost sweep are driven against fakes here; the claim race, the id bullmq accepts and the
// dedup window are measured against a real Valkey below (DATABASE 6: the worker and admin Valkey tests already use 0, 2,
// 5, 7, 8, 9, 10 (run-checkpoint) and 11 to 15; grep `pathname = "/N"` before taking another). Every TTL and deadline runs on an injected clock.

const NOW = Date.parse("2026-10-17T10:00:00.000Z");
const clock = (at = NOW) => {
	const c = () => c.at;
	c.at = at;
	return c;
};

/** The ioredis commands the enqueuer and the sweep use, over maps, recording every call. */
function fakeRedis() {
	const kv = new Map();
	const zset = new Map();
	const calls = [];
	return {
		kv,
		zset,
		calls,
		async set(key, value, ...args) {
			calls.push(["set", key, value, ...args]);
			if (args.includes("NX") && kv.has(key)) return null;
			kv.set(key, value);
			return "OK";
		},
		async del(key) {
			calls.push(["del", key]);
			return kv.delete(key) ? 1 : 0;
		},
		async zadd(key, score, member) {
			calls.push(["zadd", key, score, member]);
			zset.set(member, Number(score));
			return 1;
		},
		async zrem(key, member) {
			calls.push(["zrem", key, member]);
			return zset.delete(member) ? 1 : 0;
		},
		async zrangebyscore(key, min, max, ...rest) {
			const limit = rest.includes("LIMIT") ? rest[rest.indexOf("LIMIT") + 2] : Infinity;
			const due = [...zset.entries()].filter(([, s]) => s <= Number(max)).sort((a, b) => a[1] - b[1]).slice(0, limit);
			return due.flatMap(([m, s]) => [m, String(s)]);
		},
	};
}

/** A queue handle recording every add; `jobs` maps id -> { state, removed }. */
function fakeQueue(name, { failAdd = null } = {}) {
	const q = {
		name,
		adds: [],
		jobs: new Map(),
		async add(jobName, data, opts) {
			if (failAdd) throw failAdd;
			q.adds.push({ jobName, data, opts });
			if (!q.jobs.has(opts.jobId)) q.jobs.set(opts.jobId, { state: "waiting", data, name: jobName });
			return { id: opts.jobId };
		},
		async getJob(id) {
			const j = q.jobs.get(id);
			if (!j) return null;
			return {
				id,
				name: j.name,
				data: j.data,
				getState: async () => j.state,
				remove: async () => {
					if (j.state === "active") throw new Error("Job is locked");
					q.jobs.delete(id);
				},
			};
		},
	};
	return q;
}

function queuesOf() {
	const shared = fakeQueue("pi-jobs");
	const hosts = new Map();
	return {
		shared,
		hosts,
		queues: {
			shared: () => shared,
			host: (name) => {
				if (!hosts.has(name)) hosts.set(name, fakeQueue(name));
				return hosts.get(name);
			},
		},
	};
}

const ARMED = { kind: "github", repo: "o/r", target: { type: "issue", number: 7 }, flow: "fix", recover: true };
const POINTER = (over = {}) => ({ v: 1, host: "h1", hostQueue: "pi-jobs@h1", seq: 3, attempt: 1, at: NOW, jobDir: "job-ab12cd", ...over });
const bullJob = (id, data = ARMED, over = {}) => ({ id, name: data.kind, data, opts: { attempts: 2 }, attemptsMade: 1, ...over });

test("runIdOf: a recovery belongs to the run it continues, anything else to its own id", () => {
	assert.equal(runIdOf({ id: "gh-1", data: {} }), "gh-1");
	assert.equal(runIdOf({ id: "gh-1.r1", data: { recoveryOf: "gh-1" } }), "gh-1");
	assert.equal(runIdOf({ id: "gh-1", data: { recoveryOf: "" } }), "gh-1", "an empty recoveryOf is no recovery");
	assert.equal(runIdOf({ id: "gh-1", data: { recoveryOf: 5 } }), "gh-1", "only a string names a run");
	assert.equal(isRecoveryArmed(ARMED), true);
	assert.equal(isRecoveryArmed({ ...ARMED, kind: "local" }), false, "v1 recovers forge jobs only");
	assert.equal(isRecoveryArmed({ ...ARMED, recover: "yes" }), false);
});

test("the recovery id: `.rN` on the run id, refused where bullmq would refuse it", () => {
	assert.equal(recoveryJobId("gh-6f1c2a3b-0000-4000-8000-000000000001", 1), "gh-6f1c2a3b-0000-4000-8000-000000000001.r1");
	assert.equal(recoveryJobId("repeat:abc:1760000000000", 2), "repeat:abc:1760000000000.r2", "three colon parts is the shape bullmq accepts");
	assert.equal(recoveryJobId("manual:t:1", 1), "manual:t:1.r1");
	assert.equal(recoveryJobId("a:b", 1), null, "two parts is refused by bullmq ('Custom Id cannot contain :')");
	assert.equal(recoveryJobId("a:b:c:d", 1), null);
	assert.equal(recoveryJobId("gh-1", 0), null);
	assert.equal(recoveryJobId("", 1), null);
	assert.equal(recoveryClaimKey("repeat:a:b", 2), "run:recover:claim:repeat_a_b:2", "sanitized like every per-run key");
});

test("enqueue routes to the crashed host's queue when its pointer names one, to the shared queue otherwise", async () => {
	const redis = fakeRedis();
	const { shared, hosts, queues } = queuesOf();
	const enqueue = makeRecoveryEnqueuer({ redis, queues, now: clock() });
	const a = await enqueue({ job: bullJob("gh-1"), cause: "infra", pointer: POINTER() });
	assert.deepEqual(a, { enqueued: true, jobId: "gh-1.r1", n: 1, queue: "pi-jobs@h1" });
	assert.equal(hosts.get("pi-jobs@h1").adds.length, 1);
	assert.equal(shared.adds.length, 0);
	// The queue is derived from the HOST, the routing rule: `pointer.hostQueue` says only that the host has one.
	await enqueue({ job: bullJob("gh-2"), cause: "infra", pointer: POINTER({ host: "h2", hostQueue: "anything" }) });
	assert.equal(hosts.get("pi-jobs@h2").adds.length, 1);
	const b = await enqueue({ job: bullJob("gh-3"), cause: "stall", pointer: POINTER({ hostQueue: null }) });
	assert.equal(b.queue, "pi-jobs");
	assert.equal(shared.adds.length, 1, "an unnamed host drains only the shared queue");
});

test("the recovery's data, id and options: attempts 1, no deduplication, the forge retention, recoverBy on the clock", async () => {
	const redis = fakeRedis();
	const { hosts, queues } = queuesOf();
	const now = clock();
	const enqueue = makeRecoveryEnqueuer({ redis, queues, now, ttlMs: 60_000 });
	await enqueue({ job: bullJob("gh-9"), cause: "infra", pointer: POINTER() });
	const [add] = hosts.get("pi-jobs@h1").adds;
	assert.equal(add.jobName, "github");
	assert.deepEqual(add.opts, { jobId: "gh-9.r1", attempts: 1, removeOnComplete: { age: 31 * 24 * 3600 }, removeOnFail: { age: 31 * 24 * 3600 } });
	assert.equal("deduplication" in add.opts, false, "the original's semantic key would swallow the recovery");
	assert.deepEqual(add.data, { ...ARMED, recoveryOf: "gh-9", recovery: 1, recoverBy: NOW + 60_000 });
	// The pending set holds it until its deadline, scored by that deadline.
	assert.deepEqual([...redis.zset.entries()], [[pendingMember("pi-jobs@h1", "gh-9.r1", "h1", NOW), NOW + 60_000]]);
	assert.deepEqual(JSON.parse(pendingMember("pi-jobs@h1", "gh-9.r1", "h1", NOW)), { q: "pi-jobs@h1", id: "gh-9.r1", host: "h1", at: NOW }, "the checkpoint's host and the enqueue instant ride along");
	// The claim: NX, with a TTL, holding the host.
	const claim = redis.calls.find((c) => c[0] === "set");
	assert.deepEqual(claim.slice(0, 3), ["set", "run:recover:claim:gh-9:1", "h1"]);
	assert.ok(claim.includes("NX") && claim.includes("PX"));
	// The default deadline, so a change to it is a decision rather than an accident.
	assert.equal(RECOVERY_TTL_MS, 6 * 3600 * 1000);
});

test("a recovery's own recovery is n + 1 on the same run; the third is refused by the cap", async () => {
	const redis = fakeRedis();
	const { hosts, queues } = queuesOf();
	const enqueue = makeRecoveryEnqueuer({ redis, queues, now: clock() });
	const r2 = await enqueue({ job: bullJob("gh-5.r1", { ...ARMED, recoveryOf: "gh-5", recovery: 1 }), cause: "stall", pointer: POINTER() });
	assert.deepEqual(r2, { enqueued: true, jobId: "gh-5.r2", n: 2, queue: "pi-jobs@h1" });
	assert.equal(hosts.get("pi-jobs@h1").adds[0].data.recoveryOf, "gh-5", "still the original run, never the recovery's id");
	const logs = [];
	const capped = makeRecoveryEnqueuer({ redis, queues, now: clock(), log: (e, f) => logs.push([e, f]) });
	const r3 = await capped({ job: bullJob("gh-5.r2", { ...ARMED, recoveryOf: "gh-5", recovery: 2 }), cause: "infra", pointer: POINTER() });
	assert.deepEqual(r3, { enqueued: false, reason: "recovery-cap" });
	assert.equal(hosts.get("pi-jobs@h1").adds.length, 1, "nothing added past the cap");
	assert.ok(!redis.kv.has("run:recover:claim:gh-5:3"), "and nothing claimed");
	assert.deepEqual(logs.at(-1), ["job_recovery_refused", { jobId: "gh-5.r2", runId: "gh-5", n: 3, cause: "infra", reason: "recovery-cap" }]);
});

test("refusals before the claim: unarmed, local, a pointer that does not route, an id bullmq would refuse", async () => {
	const redis = fakeRedis();
	const { queues } = queuesOf();
	const enqueue = makeRecoveryEnqueuer({ redis, queues, now: clock() });
	assert.deepEqual(await enqueue({ job: bullJob("gh-1", { ...ARMED, recover: undefined }), pointer: POINTER() }), { enqueued: false, reason: "not-armed" });
	assert.deepEqual(await enqueue({ job: bullJob("local-1", { ...ARMED, kind: "local" }), pointer: POINTER() }), { enqueued: false, reason: "local" });
	assert.deepEqual(await enqueue({ job: bullJob("gh-1"), pointer: null }), { enqueued: false, reason: "pointer-invalid" });
	assert.deepEqual(await enqueue({ job: bullJob("gh-1"), pointer: POINTER({ host: "../x" }) }), { enqueued: false, reason: "pointer-invalid" });
	assert.deepEqual(await enqueue({ job: bullJob("a:b"), pointer: POINTER() }), { enqueued: false, reason: "job-id-refused" });
	assert.equal(redis.calls.length, 0, "not one Valkey command for a refusal");
});

test("a lost claim answers enqueued (the run IS continuing) and adds only when the winner's job is not there", async () => {
	const redis = fakeRedis();
	const { hosts, queues } = queuesOf();
	const enqueue = makeRecoveryEnqueuer({ redis, queues, now: clock() });
	// The winner's job exists: the loser adds nothing and records nothing pending.
	redis.kv.set("run:recover:claim:gh-7:1", "h1");
	hosts.set("pi-jobs@h1", fakeQueue("pi-jobs@h1"));
	hosts.get("pi-jobs@h1").jobs.set("gh-7.r1", { state: "waiting", data: {}, name: "github" });
	assert.deepEqual(await enqueue({ job: bullJob("gh-7"), pointer: POINTER() }), { enqueued: true, jobId: "gh-7.r1", n: 1, queue: "pi-jobs@h1" });
	assert.equal(hosts.get("pi-jobs@h1").adds.length, 0);
	assert.equal(redis.zset.size, 0);
	// A winner that died between its claim and its add: the loser adds it (the custom id keeps that idempotent), and
	// records it pending, since its add is the only one the run gets and the host-lost backstop must see it.
	redis.kv.set("run:recover:claim:gh-8:1", "h1");
	assert.equal((await enqueue({ job: bullJob("gh-8"), pointer: POINTER() })).enqueued, true);
	assert.equal(hosts.get("pi-jobs@h1").adds.length, 1, "the stranded run is queued after all");
	assert.deepEqual([...redis.zset.keys()], [pendingMember("pi-jobs@h1", "gh-8.r1", "h1", NOW)]);
});

test("an add that fails answers not enqueued, releases the claim, and says so", async () => {
	const redis = fakeRedis();
	const logs = [];
	const failing = fakeQueue("pi-jobs@h1", { failAdd: Object.assign(new Error("Connection is closed."), { code: "ECONNRESET" }) });
	const enqueue = makeRecoveryEnqueuer({ redis, queues: { shared: () => failing, host: () => failing }, now: clock(), log: (e, f) => logs.push([e, f]) });
	assert.deepEqual(await enqueue({ job: bullJob("gh-4"), cause: "infra", pointer: POINTER() }), { enqueued: false, reason: "enqueue-failed" });
	assert.ok(!redis.kv.has("run:recover:claim:gh-4:1"), "the next attempt's enqueue is not answered 'already claimed'");
	assert.deepEqual(logs.at(-1), ["job_recovery_enqueue_failed", { jobId: "gh-4", runId: "gh-4", n: 1, cause: "infra", code: "ECONNRESET" }]);
	// A redis that throws on the claim itself is the same answer, never a throw.
	const broken = { ...fakeRedis(), set: async () => { throw new Error("down"); } };
	const e2 = makeRecoveryEnqueuer({ redis: broken, queues: queuesOf().queues, now: clock() });
	assert.deepEqual(await e2({ job: bullJob("gh-4"), pointer: POINTER() }), { enqueued: false, reason: "enqueue-failed" });
});

test("the host-lost sweep on an injected clock: a waiting recovery past its deadline is removed and its run told", async () => {
	const redis = fakeRedis();
	const { hosts, queues } = queuesOf();
	const now = clock();
	const enqueue = makeRecoveryEnqueuer({ redis, queues, now, ttlMs: 1_000 });
	await enqueue({ job: bullJob("gh-w"), pointer: POINTER() });
	await enqueue({ job: bullJob("gh-a"), pointer: POINTER() });
	await enqueue({ job: bullJob("gh-late"), pointer: POINTER() });
	const q = hosts.get("pi-jobs@h1");
	q.jobs.get("gh-a.r1").state = "active";
	const late = pendingMember("pi-jobs@h1", "gh-late.r1", "h1", NOW);
	redis.zset.set(late, NOW + 5_000);
	const lost = [];
	const logs = [];
	// The registry is read and h1 is not in it: the host is gone.
	const sweep = makeHostLostSweep({ redis, queues, now, liveHosts: async () => new Set(["h2"]), log: (e, f) => logs.push([e, f]), onLost: async (job) => lost.push([job.id, job.data.recoveryOf]) });
	assert.deepEqual(await sweep(), { claimed: 0, removed: 0, settled: 0, extended: 0 }, "nothing is due before the deadline");
	now.at = NOW + 1_001;
	assert.deepEqual(await sweep(), { claimed: 2, removed: 1, settled: 1, extended: 0 });
	assert.deepEqual(lost, [["gh-w.r1", "gh-w"]], "only the one still waiting is lost; the active one is past needing the backstop");
	assert.equal(q.jobs.has("gh-w.r1"), false, "removed from the queue");
	assert.equal(q.jobs.has("gh-a.r1"), true);
	assert.deepEqual([...redis.zset.keys()], [late], "a member not yet due stays");
	assert.deepEqual(logs.find((l) => l[0] === "job_recovery_host_lost"), ["job_recovery_host_lost", { jobId: "gh-w.r1", runId: "gh-w", queue: "pi-jobs@h1", state: "waiting", reason: "host-absent" }]);
});

test("a deadline is not a verdict: an alive host, a paused queue or an unreadable registry extends it, up to the hard maximum", async () => {
	const redis = fakeRedis();
	const { hosts, queues } = queuesOf();
	const now = clock();
	const enqueue = makeRecoveryEnqueuer({ redis, queues, now, ttlMs: 1_000 });
	await enqueue({ job: bullJob("gh-d"), pointer: POINTER() });
	const q = hosts.get("pi-jobs@h1");
	q.jobs.get("gh-d.r1").state = "delayed"; // a scoped pause window deferred it
	const member = pendingMember("pi-jobs@h1", "gh-d.r1", "h1", NOW);
	const lost = [];
	const logs = [];
	let live = new Set(["h1"]);
	let paused = false;
	q.isPaused = async () => paused;
	const sweep = makeHostLostSweep({ redis, queues, now, extendMs: 60_000, maxWaitMs: 200_000, liveHosts: async () => live, log: (e, f) => logs.push([e, f]), onLost: async (j) => lost.push(j.id) });
	now.at = NOW + 2_000;
	assert.deepEqual(await sweep(), { claimed: 1, removed: 0, settled: 0, extended: 1 }, "its host still beats: delayed, not lost");
	assert.equal(redis.zset.get(member), NOW + 62_000, "moved on by one extension");
	assert.deepEqual(logs.at(-1), ["job_recovery_deadline_extended", { jobId: "gh-d.r1", queue: "pi-jobs@h1", reason: "host-alive", until: NOW + 62_000 }]);
	// The queue paused by the operator: extended, even with the host gone from the registry.
	live = new Set();
	paused = true;
	now.at = NOW + 62_000;
	await sweep();
	assert.equal(logs.at(-1)[1].reason, "queue-paused");
	// A registry that could not be read is a Valkey blip, never a lost host.
	paused = false;
	live = null;
	now.at = NOW + 122_000;
	await sweep();
	assert.equal(logs.at(-1)[1].reason, "registry-unreadable");
	assert.equal(redis.zset.get(member), NOW + 182_000);
	// The extension never passes the hard maximum (enqueue + maxWaitMs)...
	live = new Set(["h1"]);
	now.at = NOW + 182_000;
	await sweep();
	assert.equal(redis.zset.get(member), NOW + 200_000, "capped at the hard maximum");
	assert.deepEqual(lost, []);
	// ...and at it the run is lost whatever the registry says: there is nothing left to recover from.
	now.at = NOW + 200_000;
	assert.deepEqual(await sweep(), { claimed: 1, removed: 1, settled: 0, extended: 0 });
	assert.deepEqual(lost, ["gh-d.r1"]);
	assert.equal(logs.find((l) => l[0] === "job_recovery_host_lost")[1].reason, "max-wait");
	// A registry that throws reads as unreadable too (extends), never as an empty fleet.
	await enqueue({ job: bullJob("gh-e"), pointer: POINTER() });
	now.at = NOW + 210_000;
	const throwing = makeHostLostSweep({ redis, queues, now, liveHosts: async () => { throw new Error("down"); } });
	assert.equal((await throwing()).extended, 1);
});

test("the recovery's data drops every per-attempt hold key, and every key index.mjs writes through updateData is accounted for", async () => {
	const redis = fakeRedis();
	const { hosts, queues } = queuesOf();
	const enqueue = makeRecoveryEnqueuer({ redis, queues, now: clock() });
	const holds = Object.fromEntries(RECOVERY_STRIPPED_KEYS.map((k) => [k, k === "netnsKeeperLoopSeen" ? [NOW] : NOW]));
	await enqueue({ job: bullJob("gh-h", { ...ARMED, ...holds }), pointer: POINTER() });
	const data = hosts.get("pi-jobs@h1").adds[0].data;
	for (const key of RECOVERY_STRIPPED_KEYS) assert.equal(key in data, false, key);
	assert.deepEqual(data, { ...ARMED, recoveryOf: "gh-h", recovery: 1, recoverBy: NOW + RECOVERY_TTL_MS });
	// The bolt: every key any worker source writes onto a queue job through `updateData({ ...job.data, <keys> })`.
	const { readdirSync } = await import("node:fs");
	const srcDir = new URL("../src/", import.meta.url);
	const written = new Set();
	for (const name of readdirSync(srcDir).filter((n) => n.endsWith(".mjs"))) {
		const src = readFileSync(new URL(name, srcDir), "utf8");
		for (const m of src.matchAll(/updateData\(\{\s*\.\.\.job\.data,([^}]*)\}\)/g)) {
			for (const part of m[1].split(",")) {
				const key = part.split(":")[0].trim();
				if (key) written.add(key);
			}
		}
		// A spelling the matcher above cannot read would hide a key: refuse any other updateData call shape.
		const calls = [...src.matchAll(/updateData\(/g)].length;
		const read = [...src.matchAll(/updateData\(\{\s*\.\.\.job\.data,/g)].length;
		assert.equal(calls, read, `${name}: every updateData call spreads job.data first, so its keys can be read here`);
	}
	assert.ok(written.size >= 6, [...written].join(","));
	for (const key of written) assert.ok(RECOVERY_STRIPPED_KEYS.includes(key) || RECOVERY_KEPT_HOLD_KEYS.includes(key), `${key} is written per attempt and neither stripped nor deliberately kept`);
});

test("the host-lost sweep: a member another host claimed first is not acted on, and a fault puts the member back", async () => {
	const redis = fakeRedis();
	const { queues } = queuesOf();
	const now = clock(NOW + 10_000);
	const member = pendingMember("pi-jobs@h1", "gh-x.r1", "h1", NOW);
	redis.zset.set(member, NOW);
	// Another host's ZREM wins between this host's read and its claim.
	const racing = { ...redis, zrem: async (k, m) => (redis.zset.delete(m), 0) };
	const lost = [];
	assert.deepEqual(await makeHostLostSweep({ redis: racing, queues, now, onLost: async (j) => lost.push(j.id) })(), { claimed: 0, removed: 0, settled: 0, extended: 0 });
	assert.deepEqual(lost, []);
	// A queue that faults after the claim: the member goes back with its own score, for the next sweep.
	redis.zset.set(member, NOW);
	const faulty = { shared: () => ({ getJob: async () => { throw new Error("down"); } }), host: () => ({ getJob: async () => { throw new Error("down"); } }) };
	await makeHostLostSweep({ redis, queues: faulty, now })();
	assert.equal(redis.zset.get(member), NOW);
	// A malformed member is dropped, said, and never routes anywhere.
	redis.zset.clear();
	redis.zset.set("not json", NOW);
	const logs = [];
	await makeHostLostSweep({ redis, queues, now, log: (e) => logs.push(e) })();
	assert.equal(redis.zset.size, 0);
	assert.ok(logs.includes("recovery_pending_malformed"));
});

// --- salvage and the orphan sweep ---------------------------------------------------------------------------------

const MANIFEST = { v: 1, runId: "gh-s", seq: 4, attempt: 1, host: "h1", kind: "live", quiesced: "frozen", at: NOW, transcript: { bytes: 10, sha256: "0".repeat(64) }, workspace: { commit: "c".repeat(40), baseSha: "b".repeat(40), objectFormat: "sha1", partial: false, ignoredDropped: false, counts: {}, git: { state: "parsed", branch: "pi/fix-7", tip: null, detached: false } }, piVersion: "1.2.0", imageDigest: "sha256:abc", venue: "local", provider: "anthropic", model: "m" };

function staleJobDir(jobsDir, name, transcript = '{"a":1}\n{"b":2}\n{"partial') {
	const dir = join(jobsDir, name);
	mkdirSync(join(dir, "workspace"), { recursive: true });
	mkdirSync(join(dir, "session"), { recursive: true });
	writeFileSync(join(dir, "workspace", "f.txt"), "x");
	writeFileSync(join(dir, "session", "current.jsonl"), transcript);
	return dir;
}

test("salvage: a stale job dir on the crashed host becomes a salvage checkpoint, then goes", async () => {
	const jobsDir = tempDir("pi-salvage-");
	const dir = staleJobDir(jobsDir, "job-ab12cd");
	writeFileSync(`${dir}.cid`, "abc123");
	const snaps = [];
	const checkpointer = { readManifest: async () => ({ ok: true, manifest: MANIFEST }), snapshot: async (args) => (snaps.push(args), { ok: true, seq: args.seq }) };
	const salvage = makeSalvager({ jobsDir, hostName: "h1", workspaceCheckpointer: checkpointer });
	assert.deepEqual(await salvage({ runId: "gh-s", pointer: POINTER({ seq: 5 }), attempt: 2 }), { salvaged: true, seq: 6 });
	assert.equal(snaps.length, 1);
	assert.equal(existsSync(`${dir}.cid`), false, "the container id file beside the job dir goes with it (#645 lab)");
	const s = snaps[0];
	assert.equal(s.kind, "salvage");
	assert.equal(s.quiesced, "dead", "the boot reaper stopped the container before this worker took a job");
	assert.equal(s.seq, 6, "past both the manifest's seq and the pointer's");
	assert.equal(s.workspace, join(dir, "workspace"));
	assert.equal(s.baseSha, MANIFEST.workspace.baseSha);
	assert.equal(s.branch, "pi/fix-7");
	assert.deepEqual(s.transcript, { srcFile: join(dir, "session", "current.jsonl"), offset: 16 }, "the last COMPLETE line's end");
	assert.deepEqual(s.meta, { piVersion: "1.2.0", imageDigest: "sha256:abc", venue: "local", provider: "anthropic", model: "m" });
	assert.equal(s.attempt, 2);
	assert.equal(existsSync(dir), false, "removed after the snapshot");
});

test("salvage goes through the run checkpointer when there is one: a handle with no pause verbs, exit({ kind: \"salvage\" }), then close", async () => {
	const jobsDir = tempDir("pi-salvage-");
	const dir = staleJobDir(jobsDir, "job-ab12cd");
	const calls = [];
	const runCheckpointer = {
		open: (args) => (calls.push(["open", args]), { exit: async (a) => (calls.push(["exit", a]), { seq: 6 }), close: async () => void calls.push(["close"]) }),
	};
	const checkpointer = { readManifest: async () => ({ ok: true, manifest: MANIFEST }), snapshot: async () => assert.fail("the handle snapshots, not the salvager") };
	const salvage = makeSalvager({ jobsDir, hostName: "h1", workspaceCheckpointer: checkpointer, runCheckpointer });
	assert.deepEqual(await salvage({ runId: "gh-s", pointer: POINTER(), attempt: 2 }), { salvaged: true, seq: 6 });
	assert.deepEqual(calls.map((c) => c[0]), ["open", "exit", "close"]);
	const opened = calls[0][1];
	assert.equal(opened.pause, undefined, "no pause verbs: the container is dead");
	assert.equal(opened.unpause, undefined);
	assert.deepEqual({ runId: opened.runId, attempt: opened.attempt, jobDir: opened.jobDir, workspace: opened.workspace, sessionFile: opened.sessionFile, baseSha: opened.baseSha, branch: opened.branch }, { runId: "gh-s", attempt: 2, jobDir: dir, workspace: join(dir, "workspace"), sessionFile: join(dir, "session", "current.jsonl"), baseSha: MANIFEST.workspace.baseSha, branch: "pi/fix-7" });
	assert.deepEqual(opened.meta, { piVersion: "1.2.0", imageDigest: "sha256:abc", venue: "local", provider: "anthropic", model: "m" });
	assert.deepEqual(calls[1][1], { kind: "salvage" });
	assert.equal(existsSync(dir), false);
});

test("salvage refuses quietly where it must not act, and never follows a link", async () => {
	const jobsDir = tempDir("pi-salvage-");
	const outside = tempDir("pi-salvage-outside-");
	writeFileSync(join(outside, "keep.txt"), "mine");
	symlinkSync(outside, join(jobsDir, "job-link01"));
	const snaps = [];
	const checkpointer = { readManifest: async () => ({ ok: true, manifest: MANIFEST }), snapshot: async (a) => (snaps.push(a), { ok: true, seq: a.seq }) };
	const salvage = makeSalvager({ jobsDir, hostName: "h1", workspaceCheckpointer: checkpointer });
	assert.deepEqual(await salvage({ runId: "gh-s", pointer: POINTER({ jobDir: "job-link01" }) }), { skipped: "absent" }, "a link at the name is not a job dir");
	assert.equal(existsSync(join(outside, "keep.txt")), true, "and what it points at is untouched");
	assert.deepEqual(await salvage({ runId: "gh-s", pointer: POINTER({ host: "h2" }) }), { skipped: "other-host" });
	assert.deepEqual(await salvage({ runId: "gh-s", pointer: POINTER({ jobDir: "../etc" }) }), { skipped: "no-job-dir" });
	assert.deepEqual(await salvage({ runId: "gh-s", pointer: POINTER({ jobDir: "job-gone00" }) }), { skipped: "absent" });
	assert.deepEqual(await makeSalvager({ jobsDir, hostName: "h1", workspaceCheckpointer: null })({ runId: "gh-s", pointer: POINTER() }), { skipped: "no-store" });
	// A transcript shorter than the checkpoint's would move the run backwards: not salvaged, but the stale dir still goes.
	const dir = staleJobDir(jobsDir, "job-short1", "{}\n");
	assert.deepEqual(await salvage({ runId: "gh-s", pointer: POINTER({ jobDir: "job-short1" }) }), { skipped: "transcript-older" });
	assert.equal(existsSync(dir), false);
	// No checkpoint at all: nothing to take the base and the meta from.
	const dir2 = staleJobDir(jobsDir, "job-nockp1");
	const none = makeSalvager({ jobsDir, hostName: "h1", workspaceCheckpointer: { readManifest: async () => ({ absent: true }), snapshot: async () => assert.fail("never") } });
	assert.deepEqual(await none({ runId: "gh-s", pointer: POINTER({ jobDir: "job-nockp1" }) }), { skipped: "no-checkpoint" });
	assert.equal(existsSync(dir2), false);
	assert.equal(snaps.length, 0);
});

test("the boot sweep removes orphaned job dirs older than the job timeout, keeping young, pointed-at, linked and foreign entries", async () => {
	const jobsDir = tempDir("pi-orphans-");
	const outside = tempDir("pi-orphans-outside-");
	writeFileSync(join(outside, "keep.txt"), "mine");
	const old = new Date(NOW - 2 * 3600 * 1000);
	const young = new Date(NOW - 60 * 1000);
	const mk = (name, at) => {
		mkdirSync(join(jobsDir, name, "workspace"), { recursive: true });
		utimesSync(join(jobsDir, name), at, at);
	};
	mk("job-old001", old);
	mk("job-young1", young);
	mk("job-kept01", old);
	mk("not-a-job", old);
	symlinkSync(outside, join(jobsDir, "job-link01"));
	// OLD, both of them: a link or a file judged young would be kept by the age rule and prove nothing about the type rule.
	lutimesSync(join(jobsDir, "job-link01"), old, old);
	writeFileSync(join(jobsDir, "job-file01"), "x");
	utimesSync(join(jobsDir, "job-file01"), old, old);
	const logs = [];
	const out = await sweepOrphanJobDirs({ jobsDir, olderThanMs: 35 * 60 * 1000, now: () => NOW, keep: new Set(["job-kept01"]), log: (e, f) => logs.push([e, f]) });
	assert.deepEqual(out, { removed: 1, kept: 4, failed: 0 });
	assert.equal(existsSync(join(jobsDir, "job-old001")), false);
	// lstat, so a removed link is seen as removed even though what it pointed at is still there.
	for (const kept of ["job-young1", "job-kept01", "not-a-job", "job-link01", "job-file01"]) assert.ok(lstatSync(join(jobsDir, kept)), kept);
	assert.equal(lstatSync(join(jobsDir, "job-link01")).isSymbolicLink(), true, "an old link named job-* is not a job dir: kept, as a link");
	assert.equal(existsSync(join(outside, "keep.txt")), true, "a link is never followed");
	assert.deepEqual(logs, [["job_dirs_swept", { removed: 1, kept: 4, failed: 0 }]]);
	assert.deepEqual(await sweepOrphanJobDirs({ jobsDir: join(jobsDir, "absent"), olderThanMs: 1, now: () => NOW }), { removed: 0, kept: 0, failed: 0 });
});

test("pointedJobDirs: this host's valid pointers only, and a refusal over the bound rather than a partial answer", async () => {
	const pointers = {
		"run:checkpoint:a": JSON.stringify(POINTER({ jobDir: "job-aaaaaa" })),
		"run:checkpoint:b": JSON.stringify(POINTER({ host: "h2", jobDir: "job-bbbbbb" })),
		"run:checkpoint:c": "not json",
		"run:checkpoint:d": JSON.stringify({ ...POINTER({ jobDir: "job-dddddd" }), extra: 1 }),
	};
	const redis = {
		scan: async (cursor) => (cursor === "0" ? ["7", ["run:checkpoint:a", "run:checkpoint:b"]] : ["0", ["run:checkpoint:c", "run:checkpoint:d"]]),
		mget: async (...keys) => keys.map((k) => pointers[k]),
	};
	assert.deepEqual([...(await pointedJobDirs({ redis, hostName: "h1" }))], ["job-aaaaaa"]);
	await assert.rejects(() => pointedJobDirs({ redis, hostName: "h1", maxKeys: 1 }), /too many checkpoint pointers/);
});

// --- index.mjs: the keys follow the run ---------------------------------------------------------------------------

test("a `.rN` job's container is handed the RUN id, so its stream, progress key and status comment are the run's", async () => {
	const { makeProcessor } = await import("../src/index.mjs");
	const seen = [];
	const processor = makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: { async incr() { return 1; }, async expire() {} },
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, concurrency: 3 }),
		timeoutMs: 100000,
		deps: {
			log: () => {},
			mintToken: async () => "t",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async ({ jobId }) => (seen.push(jobId), { code: 0, aborted: false, turns: null, tokens: null, session: null, usage: null, context: null }),
			cleanup: async () => {},
			comment: async () => {},
		},
	});
	const data = { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } };
	await processor({ id: "gh-1", data }, "tok", new AbortController().signal);
	// Not armed (no `recover`), so the processor's own recovery gates stay out of the way: the id the container gets is the
	// wiring's decision alone.
	await processor({ id: "gh-1.r1", data: { ...data, recoveryOf: "gh-1", recovery: 1 } }, "tok", new AbortController().signal);
	assert.deepEqual(seen, ["gh-1", "gh-1"]);
});

test("the processor's enqueueRecovery is bound to the REAL queue job, and runningJobs to the processor's own ledger", () => {
	// runJob is handed the effective job (a spread of job.data, no id, no name), so a recovery can only be enqueued from the
	// queue job index.mjs holds. Pinned on the source: reaching the binding through behaviour needs the processor's infra
	// exit path (processor.mjs), which is that module's own test to drive.
	const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
	assert.match(src, /^\s*\.\.\.\(deps\.enqueueRecovery \? \{ enqueueRecovery: \(args\) => deps\.enqueueRecovery\(\{ \.\.\.args, job \}\) \} : \{\}\),$/m);
	assert.match(src, /^\s*runningJobs: deps\.runningJobs \?\? runningJobs,$/m);
	assert.match(src, /deps\.runContainer\(\{ \.\.\.ctx, name, signal, jobId: runIdOf\(job\), onLive:/);
});

// --- against a real Valkey ----------------------------------------------------------------------------------------

const valkeyUrl = process.env.VALKEY_TEST_URL;
if (!valkeyUrl && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("recovery-queue tests REQUIRE VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
const live = valkeyUrl ? false : "VALKEY_TEST_URL not set; the claim race and bullmq's id rule need a real Valkey";

const opened = [];
async function liveKit() {
	const { makeRedisClient, parseConnection } = await import("../src/connection.mjs");
	const { Queue } = await import("bullmq");
	const url = new URL(valkeyUrl);
	url.pathname = "/6";
	const redis = makeRedisClient(url.toString());
	redis.on("error", () => {});
	opened.push(redis);
	const tag = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const makeQ = (name) => {
		const q = new Queue(name, { connection: parseConnection(url.toString()) });
		q.on("error", () => {});
		opened.push(q);
		return q;
	};
	return { redis, url: url.toString(), tag, makeQ };
}
test.after(async () => {
	for (const h of opened) {
		if (typeof h.obliterate === "function") await h.obliterate({ force: true }).catch(() => {});
		await Promise.resolve(h.close?.() ?? h.quit?.()).catch(() => {});
	}
});

test("LIVE: bullmq stores `${runId}.rN` for a colon-free forge id and a three-part cron id, and refuses a two-part one", { skip: live }, async () => {
	const { redis, tag, makeQ } = await liveKit();
	const shared = makeQ(`rq-ids-${tag}`);
	const enqueue = makeRecoveryEnqueuer({ redis, queues: { shared: () => shared, host: () => shared }, now: clock() });
	for (const runId of [`gh-6f1c2a3b-${tag}`, `repeat:t-${tag}:1760000000000`]) {
		const r = await enqueue({ job: bullJob(runId), cause: "infra", pointer: POINTER({ hostQueue: null }) });
		assert.equal(r.enqueued, true, runId);
		const stored = await shared.getJob(`${runId}.r1`);
		assert.ok(stored, `${runId}.r1 is stored`);
		assert.equal(stored.data.recoveryOf, runId);
		assert.equal(stored.opts.attempts, 1);
	}
	// The measured rule the pre-check mirrors: bullmq itself refuses the two-part id.
	await assert.rejects(() => shared.add("github", {}, { jobId: "a:b.r1" }), /Custom Id cannot contain :/);
	await redis.del(RECOVER_PENDING_KEY);
});

test("LIVE: a recovery is NOT swallowed by the original's dedup window (the add carries no deduplication)", { skip: live }, async () => {
	const { redis, tag, makeQ } = await liveKit();
	const shared = makeQ(`rq-dedup-${tag}`);
	const dedup = { id: `o/r#7:fix-${tag}`, ttl: 600_000 };
	await shared.add("github", ARMED, { jobId: `gh-orig-${tag}`, deduplication: dedup });
	// The control: a second add WITH the original's key is swallowed (answered with the original's id).
	const swallowed = await shared.add("github", ARMED, { jobId: `gh-other-${tag}`, deduplication: dedup });
	assert.equal(swallowed.id, `gh-orig-${tag}`);
	const enqueue = makeRecoveryEnqueuer({ redis, queues: { shared: () => shared, host: () => shared }, now: clock() });
	const r = await enqueue({ job: bullJob(`gh-orig-${tag}`), cause: "infra", pointer: POINTER({ hostQueue: null }) });
	assert.equal(r.jobId, `gh-orig-${tag}.r1`);
	assert.ok(await shared.getJob(`gh-orig-${tag}.r1`), "stored inside the original's window");
	await redis.del(RECOVER_PENDING_KEY);
});

test("LIVE: two enqueuers racing on one run produce exactly one recovery job, one claim and one pending member", { skip: live }, async () => {
	const a = await liveKit();
	const b = await liveKit();
	const name = `rq-race-${a.tag}`;
	const qa = a.makeQ(name);
	const qb = b.makeQ(name);
	await a.redis.del(RECOVER_PENDING_KEY);
	const runId = `gh-race-${a.tag}`;
	const ea = makeRecoveryEnqueuer({ redis: a.redis, queues: { shared: () => qa, host: () => qa }, now: clock() });
	const eb = makeRecoveryEnqueuer({ redis: b.redis, queues: { shared: () => qb, host: () => qb }, now: clock() });
	const results = await Promise.all([ea, eb, ea, eb].map((e) => e({ job: bullJob(runId), cause: "stall", pointer: POINTER({ hostQueue: null }) })));
	assert.ok(results.every((r) => r.enqueued === true && r.jobId === `${runId}.r1`), "every racer is told the run continues");
	const jobs = await qa.getJobs(["waiting", "delayed", "prioritized", "active"]);
	assert.deepEqual(jobs.map((j) => j.id), [`${runId}.r1`], "exactly one job");
	assert.equal(await a.redis.get(recoveryClaimKey(runId, 1)), "h1");
	assert.ok((await a.redis.pttl(recoveryClaimKey(runId, 1))) > 0, "the claim expires");
	assert.equal(await a.redis.zcard(RECOVER_PENDING_KEY), 1, "one pending member, from the winner");
	assert.equal(Number(await a.redis.zscore(RECOVER_PENDING_KEY, pendingMember("pi-jobs", `${runId}.r1`, "h1", NOW))), NOW + RECOVERY_TTL_MS);
	await a.redis.del(RECOVER_PENDING_KEY, recoveryClaimKey(runId, 1));
});

test("LIVE: the host-lost sweep removes a waiting recovery past its deadline from a real queue, once across two sweepers", { skip: live }, async () => {
	const a = await liveKit();
	const b = await liveKit();
	const hostQ = a.makeQ(`pi-jobs@rq-${a.tag}`);
	await a.redis.del(RECOVER_PENDING_KEY);
	const now = clock();
	const queues = { shared: () => hostQ, host: () => hostQ };
	const enqueue = makeRecoveryEnqueuer({ redis: a.redis, queues, hostQueueName: () => `pi-jobs@rq-${a.tag}`, now, ttlMs: 1_000 });
	const runId = `gh-lost-${a.tag}`;
	assert.equal((await enqueue({ job: bullJob(runId), pointer: POINTER({ host: `rq-${a.tag}` }) })).queue, `pi-jobs@rq-${a.tag}`);
	now.at = NOW + 5_000;
	const lost = [];
	const onLost = async (job) => lost.push(job.id);
	const gone = async () => new Set();
	const [ra, rb] = await Promise.all([makeHostLostSweep({ redis: a.redis, queues, now, onLost, liveHosts: gone })(), makeHostLostSweep({ redis: b.redis, queues, now, onLost, liveHosts: gone })()]);
	assert.equal(ra.removed + rb.removed, 1, "exactly one sweeper acted");
	assert.deepEqual(lost, [`${runId}.r1`]);
	assert.equal(await hostQ.getJob(`${runId}.r1`), undefined, "gone from the queue");
	assert.equal(await a.redis.zcard(RECOVER_PENDING_KEY), 0);
	await a.redis.del(recoveryClaimKey(runId, 1));
});

test("the boot sweep removes a removed dir's .cid and a stale orphan .cid, keeping a young one, one beside a live dir, and a linked one (#645 lab)", async () => {
	const jobsDir = tempDir("pi-orphans-cid-");
	const old = new Date(NOW - 2 * 3600 * 1000);
	const young = new Date(NOW - 60 * 1000);
	const file = (name, at) => {
		writeFileSync(join(jobsDir, name), "cid");
		utimesSync(join(jobsDir, name), at, at);
	};
	mkdirSync(join(jobsDir, "job-old002"));
	utimesSync(join(jobsDir, "job-old002"), old, old);
	file("job-old002.cid", old);
	file("job-gone01.cid", old);
	file("job-gone02.cid", young);
	mkdirSync(join(jobsDir, "job-young2"));
	file("job-young2.cid", old);
	symlinkSync(join(jobsDir, "job-gone02.cid"), join(jobsDir, "job-gone03.cid"));
	lutimesSync(join(jobsDir, "job-gone03.cid"), old, old);
	const out = await sweepOrphanJobDirs({ jobsDir, olderThanMs: 35 * 60 * 1000, now: () => NOW });
	assert.equal(existsSync(join(jobsDir, "job-old002.cid")), false, "removed with its dir");
	assert.equal(existsSync(join(jobsDir, "job-gone01.cid")), false, "a stale orphan");
	for (const kept of ["job-gone02.cid", "job-young2.cid", "job-gone03.cid"]) assert.ok(lstatSync(join(jobsDir, kept)), kept);
	assert.deepEqual(out, { removed: 2, kept: 3, failed: 0 });
});

test("the boot sweep takes the openshell venue's beside-files with their dir, and alone once stale; never a young one or a link (#683)", async () => {
	const jobsDir = tempDir("pi-orphans-openshell-");
	const old = new Date(NOW - 2 * 3600 * 1000);
	const young = new Date(NOW - 60 * 1000);
	const at = (path, when) => utimesSync(join(jobsDir, path), when, when);
	// With its stale dir: the policy file and both staging dirs (which hold the job's prompt and outputs) go too.
	mkdirSync(join(jobsDir, "job-old003"));
	at("job-old003", old);
	writeFileSync(join(jobsDir, "job-old003.openshell-policy.json"), "{}");
	mkdirSync(join(jobsDir, "job-old003.openshell-up", "job"), { recursive: true });
	writeFileSync(join(jobsDir, "job-old003.openshell-up", "job", "prompt.md"), "issue text");
	mkdirSync(join(jobsDir, "job-old003.openshell-down"));
	// Alone, a crash after the dir went: stale ones go, a young one stays, a link is never followed or removed.
	mkdirSync(join(jobsDir, "job-gone04.openshell-up"));
	at("job-gone04.openshell-up", old);
	writeFileSync(join(jobsDir, "job-gone05.openshell-policy.json"), "{}");
	at("job-gone05.openshell-policy.json", old);
	mkdirSync(join(jobsDir, "job-gone06.openshell-down"));
	at("job-gone06.openshell-down", young);
	symlinkSync(join(jobsDir, "job-gone06.openshell-down"), join(jobsDir, "job-gone07.openshell-up"));
	lutimesSync(join(jobsDir, "job-gone07.openshell-up"), old, old);
	await sweepOrphanJobDirs({ jobsDir, olderThanMs: 35 * 60 * 1000, now: () => NOW });
	for (const gone of ["job-old003", "job-old003.openshell-policy.json", "job-old003.openshell-up", "job-old003.openshell-down", "job-gone04.openshell-up", "job-gone05.openshell-policy.json"]) assert.equal(existsSync(join(jobsDir, gone)), false, gone);
	for (const kept of ["job-gone06.openshell-down", "job-gone07.openshell-up"]) assert.ok(lstatSync(join(jobsDir, kept)), kept);
});
