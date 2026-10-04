import assert from "node:assert/strict";
import { test } from "node:test";
import { makeAllocationState } from "../src/allocation.mjs";
import { envelopeDigest, parseEnvelope } from "../src/envelope.mjs";
import { parseProjects } from "../src/projects.mjs";

// Issue #504 part B, the pickup half (index.mjs): the reconcile that narrows a job's ledgers runs before any spend, so
// a fault there is INFRASTRUCTURE and retried (CONST-RETRY-INFRA-ONLY), never a dropped job; and a host with no
// envelope in a governed fleet refuses its jobs as envelope-mismatch instead of running ungoverned.

let mod;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	if (process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw error;
}
const skip = mod ? false : "index.mjs could not import here (bullmq)";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const PROJECTS = [{ id: "shop", members: ["github:acme/web"] }];
const envelope = parseEnvelope(JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10" }, defaultWeights: { _other: 1, shop: 1 } }), "/e/envelope.json", { projects: PROJECTS, maxCostMicros: 1_000_000 });
const digest = envelopeDigest(envelope);

async function pickup(allocation, comments = []) {
	const records = [];
	const seen = { containers: 0, mints: 0, logs: [] };
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: { incr: async () => 1, decr: async () => 0, incrby: async () => 1, decrby: async () => 0, eval: async () => [0, 0], expire: async () => {}, get: async () => null },
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null, maxCostUsd: 1 }),
		applyConcurrency: () => {},
		scopedLimits: () => [],
		projects: () => parseProjects(JSON.stringify({ version: 1, projects: PROJECTS }), "p.json"),
		allocation,
		now: () => NOW,
		recordRun: (r) => records.push(r),
		timeoutMs: 100000,
		deps: {
			mintToken: async () => (seen.mints++, "tok"),
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => (seen.containers++, { code: 0, aborted: false, turns: 3 }),
			cleanup: async () => {},
			comment: async (_j, t) => comments.push(t),
			log: (e, f) => seen.logs.push({ e, f }),
		},
	});
	const job = { id: "j1", attemptsMade: 0, name: "github", data: { kind: "github", repo: "acme/web", target: { number: 1 }, flow: "fix", trigger: { deliveryId: "d", sender: { id: 1 } } }, moveToDelayed: async () => {} };
	try {
		return { result: await processor(job, "tok", new AbortController().signal), records, seen };
	} catch (error) {
		return { error, records, seen };
	}
}

test("a Valkey reply error in the pickup reconcile is retried as infrastructure, before anything is minted or started (#504)", { skip }, async () => {
	const replyError = Object.assign(new Error("WRONGTYPE Operation against a key holding the wrong kind of value"), { code: "WRONGTYPE" });
	const { error, records, seen } = await pickup({ current: () => ({ envelope, digest }), reconcile: async () => { throw replyError; } });
	assert.equal(error?.name, "InfraRetry", "never the UnrecoverableError that drops the job");
	assert.equal(error.reason, "container-never-started");
	assert.equal(error.budgetReserved, false);
	assert.deepEqual([seen.mints, seen.containers], [0, 0]);
	assert.equal(records[0].error.reason, "container-never-started", "the record says so");
	assert.ok(seen.logs.some((l) => l.e === "allocation_read_failed" && l.f.code === "WRONGTYPE"));
});

test("a seed whose row the audit file refuses still stands and logs the lost row; a changed-externally row is tried again (#504)", { skip }, async () => {
	const store = new Map();
	const redis = {
		get: async (k) => store.get(k) ?? null,
		set: async (k, v, ...a) => (a.includes("NX") && store.has(k) ? null : (store.set(k, v), "OK")),
		// The seed script by its semantics: SET NX the plan, and when it lands, the expected digest beside it.
		eval: async (_script, _n, plan, expected, body, seedDigest, mode) => (mode === "nx" && !store.has(plan) ? (store.set(plan, body), store.set(expected, seedDigest), 1) : 0),
		lpush: async () => {},
		ltrim: async () => {},
	};
	// A SYSTEM change whose row the file refuses (the seed here) has happened anyway: the loss is logged, never thrown,
	// so the job runs on the split that is now there.
	const lost = [];
	const full = { append() { throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); } };
	const state = makeAllocationState({ redis, host: "h", audit: full, log: (e, f) => lost.push({ e, f }) });
	const { result, error, seen } = await pickup({ current: () => ({ envelope, digest }), reconcile: state.reconcile });
	assert.equal(result?.outcome, "completed", String(error?.stack ?? error));
	assert.equal(seen.containers, 1);
	assert.deepEqual(lost.find((l) => l.e === "allocation_audit_row_lost")?.f, { outcome: "neutral", planId: null, from: null, to: digest, code: "ENOSPC" });
	// A hand-edited host whose changed-externally row fails to write tries it again next time, never forgets it.
	const rows = [];
	let fail = true;
	const flaky = { append(row) { if (fail) throw Object.assign(new Error("EIO"), { code: "EIO" }); rows.push(row); } };
	store.clear();
	store.set("alloc:plan", JSON.stringify({ version: 1, planId: null, envelopeDigest: "0000000000000000", allocations: { shop: 1, _other: 0 }, unallocated: 99_999_999, repos: {} }));
	store.set("alloc:envelope:expected", "0000000000000000");
	const host = makeAllocationState({ redis, host: "h", audit: flaky });
	await assert.rejects(() => host.reconcile({ envelope, digest, now: NOW }), /EIO/);
	fail = false;
	assert.equal((await host.reconcile({ envelope, digest, now: NOW })).mismatch, true);
	assert.equal(rows.filter((r) => r.outcome === "envelope-changed-externally").length, 1);
});

test("a host with NO envelope in a governed fleet refuses its jobs as envelope-mismatch; an ungoverned fleet runs; a fault is retried (#504)", { skip }, async () => {
	const comments = [];
	const governed = await pickup({ current: () => null, fleetGoverned: async () => true }, comments);
	assert.deepEqual([governed.result?.outcome, governed.result?.reason, governed.seen.containers], ["policy", "envelope-mismatch", 0]);
	assert.match(comments[0], /^Refused: this worker has no budget envelope while the other workers share an applied budget split/, "its own text: the fix is not to make two envelopes agree");
	const free = await pickup({ current: () => null, fleetGoverned: async () => false });
	assert.equal(free.result?.outcome, "completed");
	const down = await pickup({ current: () => null, fleetGoverned: async () => { throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }); } });
	assert.equal(down.error?.name, "InfraRetry");
	// fleetGoverned itself: one EXISTS, and a loud line once per process.
	const logs = [];
	const st = makeAllocationState({ redis: { exists: async () => 1 }, host: "h", audit: { append() {} }, log: (e) => logs.push(e) });
	assert.equal(await st.fleetGoverned(), true);
	assert.equal(await st.fleetGoverned(), true);
	assert.deepEqual(logs, ["envelope_absent_fleet_governed"]);
});
