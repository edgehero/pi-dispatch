import assert from "node:assert/strict";
import { test } from "node:test";
import { runJob } from "../src/processor.mjs";
import { sessionKeyFor } from "../src/session-key.mjs";
import { buildRecord } from "../src/run-history.mjs";
import { enqueueForgeJob } from "../src/queue.mjs";
import { buildContainerEnv } from "../src/env-allowlist.mjs";

const baseSha = "a".repeat(40);
const base = { kind: "github", repo: "org/repo", target: { type: "issue", number: 7 }, flow: "fix", provider: "anthropic", model: "m", maxTurns: 10, resume: true, trigger: { deliveryId: "11111111-1111-4111-8111-111111111111" } };
const fork = { id: "b".repeat(32), rootKey: sessionKeyFor(base), fromJob: "gh-original", fromEntry: "aabbccdd", position: "at", sourceDigest: "c".repeat(64), message: "operator-private-message" };
function fixture(overrides = {}) {
	const calls = [];
	const job = { ...base, fork, forkReserveMicros: null };
	let reserved = 0;
	const source = { ok: true, point: { seq: 1 }, manifest: { sessionKey: fork.rootKey, baseSha, piVersion: "1.2.0", venue: "local", host: "worker" }, transcriptPath: "/private/transcript.jsonl" };
	const deps = {
		redis: { incr: async () => (calls.push("reserve"), ++reserved), expire: async () => {}, decr: async () => --reserved },
		caps: { day: 10, week: null, month: null }, now: new Date("2026-07-16T10:00:00Z"), sessionsDir: "/sessions", hostName: "worker",
		imagePreflight: async () => ({ ok: true, piVersion: "1.2.0" }),
		checkForkPolicy: async () => ({ ok: true }),
		forkStore: { readPoint: async () => source, restorePoint: async () => (calls.push("restore"), { ok: true, written: 1 }), baseSourceUrl: () => "/private/base.git", primeBase: async () => ({ ok: true }), publish: () => ({ ok: true }) },
		mintToken: async () => (calls.push("mint"), "scoped-token"), isDefaultBranchProtected: async () => true,
		prepareWorkspace: async (_j, _t, opts) => { calls.push("clone"); assert.deepEqual(opts.pin, { sha: baseSha, from: "/private/base.git" }); return { workspace: "/workspace", jobDir: "/job", sha: baseSha }; },
		baseHasExtensions: async () => false, resetTrustPaths: async () => { calls.push("trust-reset"); },
		stageRecovered: async ({ transcriptPath, job: staged }) => { assert.equal(transcriptPath, source.transcriptPath); assert.equal(staged.resume, true); calls.push("stage"); return { hostDir: "/job/session", key: `${fork.rootKey}.${fork.id}`, resume: true }; },
		runContainer: async ({ job: actual, prepared }) => { calls.push("container"); assert.deepEqual(actual.fork, fork); assert.equal(prepared.session.key, `${fork.rootKey}.${fork.id}`); return { code: 0, aborted: false }; },
		promoteSession: (s) => { calls.push(`promote:${s.key}`); return { promoted: true }; },
		comment: async () => {}, cleanup: async () => {}, ...overrides,
	};
	return { job, deps, calls };
}

test("fork restores its exact source and trust paths before budget and starts an isolated session", async () => {
	const { job, deps, calls } = fixture();
	const result = await runJob(job, deps);
	assert.equal(result.outcome, "completed");
	assert.deepEqual(calls, ["mint", "clone", "restore", "trust-reset", "stage", "reserve", "container", `promote:${fork.rootKey}.${fork.id}`]);
});

test("every known fork refusal stops before token mint, clone, token-cap read and reservation", async () => {
	for (const [change, expected] of [
		[{ forkStore: null }, "fork-source-store-unset"],
		[{ checkForkPolicy: async () => ({ refused: "fork-trigger-changed" }) }, "fork-trigger-changed"],
		[{ checkForkPolicy: async () => null }, "fork-policy-unavailable"],
		[{ forkStore: { readPoint: async () => ({ refused: "fork-source-expired" }) } }, "fork-source-expired"],
	]) {
		const { job, deps, calls } = fixture(change);
		const result = await runJob(job, deps);
		assert.equal(result.reason, expected);
		assert.equal(result.budgetReserved, false);
		assert.deepEqual(calls, []);
	}
});

test("foreign source identity, version, venue and host are each refused before mint", async () => {
	for (const [field, value, reason] of [["sessionKey", "f".repeat(32), "target"], ["piVersion", "0.0.1", "pi-version"], ["venue", "podman", "venue"], ["host", "another", "host"]]) {
		const f = fixture();
		const read = f.deps.forkStore.readPoint;
		f.deps.forkStore.readPoint = async () => { const s = await read(); return { ...s, manifest: { ...s.manifest, [field]: value } }; };
		const result = await runJob(f.job, f.deps);
		assert.equal(result.reason, `fork-source-${reason}-mismatch`);
		assert.deepEqual(f.calls, []);
	}
});

test("invalid and incompatible thinking choices refuse before mint", async () => {
	for (const level of ["invalid", "high"]) {
		const f = fixture();
		const result = await runJob({ ...f.job, thinkingLevel: level }, f.deps);
		assert.equal(result.reason, "thinking-level-unsupported");
		assert.deepEqual(f.calls, []);
	}
});

test("fork source archive failure cannot turn a completed paid job into an infrastructure retry", async () => {
	const f = fixture();
	f.deps.forkStore.primeBase = async () => { throw new Error("disk"); };
	const result = await runJob(f.job, f.deps);
	assert.equal(result.outcome, "completed");
	assert.deepEqual(result.forkSource, { saved: false, reason: "unavailable" });
});

test("queue forks have independent semantic windows and preserve the closed contract", async () => {
	const added = [];
	const queue = { add: async (name, data, opts) => { added.push({ name, data, opts }); return { id: opts.jobId }; } };
	await enqueueForgeJob(queue, "github", { ...base, fork, forkReserveMicros: null, thinkingLevel: "high", forkPolicy: "d".repeat(64) });
	await enqueueForgeJob(queue, "github", { ...base, fork: { ...fork, id: "e".repeat(32) } });
	assert.notEqual(added[0].opts.deduplication.id, added[1].opts.deduplication.id);
	assert.deepEqual(added[0].data.fork, fork);
	assert.equal(added[0].data.thinkingLevel, "high");
	assert.equal(added[0].data.forkPolicy, "d".repeat(64));
	await assert.rejects(enqueueForgeJob(queue, "github", { ...base, fork: { ...fork, path: "/other" } }), /fork must name/);
});

test("record lineage keeps identifiers and chosen model, never operator text or arbitrary fields", () => {
	const record = buildRecord({ job: { id: "gh-fork", data: { ...base, fork } }, result: { outcome: "completed", model: "m" }, startedAt: 0, endedAt: 1 });
	assert.deepEqual(record.fork, { id: fork.id, fromJob: fork.fromJob, fromEntry: fork.fromEntry, position: fork.position, model: "m" });
	assert.equal(JSON.stringify(record).includes(fork.message), false);
	assert.equal(buildRecord({ job: { data: base }, startedAt: 0, endedAt: 1 }).fork, undefined);
	assert.equal(buildRecord({ job: { data: { ...base, fork: { ...fork, fromEntry: "attacker-text" } } }, startedAt: 0, endedAt: 1 }).fork, undefined);
});

test("container env sends only the fork selection and thinking contract", () => {
	const env = buildContainerEnv({ provider: "anthropic", model: "m", maxTurns: 10, jobId: "j", hostEnv: { ANTHROPIC_API_KEY: "fake" }, fork, thinkingLevel: "high" });
	assert.equal(env.PI_FORK_ENTRY, fork.fromEntry);
	assert.equal(env.PI_FORK_POSITION, fork.position);
	assert.equal(env.PI_THINKING_LEVEL, "high");
	assert.equal(JSON.stringify(env).includes(fork.message), false);
});


test("a trigger that opted out of session persistence creates no unredacted fork archive", async () => {
	const f = fixture();
	let primes = 0;
	f.deps.forkStore.primeBase = async () => { primes++; return { ok: true }; };
	f.deps.prepareWorkspace = async () => ({ workspace: "/workspace", jobDir: "/job", sha: baseSha });
	f.deps.runContainer = async () => ({ code: 0, aborted: false });
	assert.equal((await runJob({ ...base, resume: false }, f.deps)).outcome, "completed");
	assert.equal(primes, 0);
});


test("queued fork reservation cannot become paid or grow after its preview", async () => {
	for (const [forkReserveMicros, maxCostMicros] of [[0, 1_000_000], [1_000_000, 2_000_000], [1_000_000, null]]) {
		const f = fixture();
		const result = await runJob({ ...f.job, forkReserveMicros, maxCostMicros }, f.deps);
		assert.equal(result.reason, "fork-reservation-changed");
		assert.deepEqual(f.calls, []);
	}
});

test("transient source or restore faults throw so the queue retries, without reserving", async () => {
	for (const where of ["readPoint", "restorePoint"]) {
		const f = fixture();
		f.deps.forkStore[where] = async () => where === "readPoint" ? { unavailable: "EIO" } : { skipped: "timeout" };
		await assert.rejects(runJob(f.job, f.deps), (error) => error.name === "InfraRetry" && error.reason === "container-never-started");
		assert.equal(f.calls.includes("reserve"), false);
		assert.equal(f.calls.includes("container"), false);
	}
});


test("archive run facts keep the named fail-open reason without accepting raw error text", () => {
	for (const [reason, expected] of [["capacity", "capacity"], ["fork-unsafe-extensions", "unsafe-extensions"], ["/private/failure", "unavailable"]]) {
		const r = buildRecord({ job: { data: base }, result: { outcome: "completed", forkSource: { saved: false, reason } }, startedAt: 0, endedAt: 1 });
		assert.deepEqual(r.forkSource, { saved: false, reason: expected });
	}
});


test("a detached or aborted container never publishes an immutable completed source", async () => {
	for (const flags of [{ detached: true }, { aborted: true }, { lingering: true }]) {
		const f = fixture();
		let published = 0;
		f.deps.forkStore.publish = () => { published++; return { ok: true }; };
		f.deps.runContainer = async () => ({ code: 0, aborted: false, ...flags });
		try { await runJob(f.job, f.deps); } catch (error) { assert.equal(error.name, "InfraRetry"); }
		assert.equal(published, 0);
	}
});
