import assert from "node:assert/strict";
import { test } from "node:test";
import { InfraRetry, NewerReleaseHold, PrivateEndpointHold, runJob } from "../src/processor.mjs";
import { PRIVATE_ENDPOINT_COMMENTS } from "../src/comment-tables.mjs";

// Issue #918 (REQ-PRIVATE-ENDPOINTS): the processor's private endpoint gates. Every one is free and determinate, so it
// runs before the mint, the clone and every reservation (CONST-BUDGET-BEFORE-TOKENS), and an unreadable triggers file is
// infrastructure, retried (CONST-RETRY-INFRA-ONLY).

const BENCH = { id: "bench-device", host: "10.0.5.20", port: 22, slots: 1 };
const LAB = { id: "lab", host: "lab.internal", port: 8022, slots: null };

function deps(overrides = {}) {
	const calls = [];
	const comments = [];
	const logs = [];
	let ranWith = null;
	const base = {
		redis: { incr: async () => 1, decr: async () => 0, expire: async () => {}, get: async () => null, incrCalls: 0 },
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		mintToken: async (job) => (calls.push(`mint:${job?.repo}`), "tok"),
		isDefaultBranchProtected: async () => (calls.push("branch-check"), true),
		prepareWorkspace: async () => (calls.push("prepare"), { workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async (args) => {
			calls.push("run-container");
			ranWith = args;
			return { code: 0, aborted: false };
		},
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => undefined,
		comment: async (_j, t) => comments.push(t),
		log: (e, f) => logs.push([e, f]),
		now: new Date("2026-07-16T10:00:00Z"),
		checkPrivateEndpoints: async (job) => ({ ok: true, ids: job.privateEndpoints ?? [] }),
		privateEndpointsDeclared: [BENCH, LAB],
		egressPreflight: async () => ({ ok: true, proxy: "pi-dispatch-egress-proxy" }),
	};
	return { deps: { ...base, ...overrides }, calls, comments, logs, ran: () => ranWith };
}

const job = (over = {}) => ({ kind: "github", repo: "org/repo", provider: "anthropic", model: "m", maxTurns: 20, privateEndpoints: ["bench-device"], trigger: { matched: { index: 2 } }, ...over });

test("a granted job runs with its endpoints' declarations, and its record says which, enforced by the proxy", async () => {
	const h = deps();
	const result = await runJob(job({ privateEndpoints: ["lab", "bench-device"] }), h.deps);
	assert.equal(result.outcome, "completed");
	assert.deepEqual(h.ran().privateEndpoints, [LAB, BENCH], "the declarations, in the trigger's order");
	assert.deepEqual(result.privateEndpoints, { ids: ["lab", "bench-device"], basis: "proxy" });
});

test("with the egress policy off, the grant still reaches the env, and the record says nothing enforced it", async () => {
	const h = deps({ egressPreflight: async () => ({ ok: true }) });
	const result = await runJob(job(), h.deps);
	assert.equal(result.outcome, "completed");
	assert.deepEqual(result.privateEndpoints, { ids: ["bench-device"], basis: "unenforced" });
});

test("a job that names no private endpoint is never asked about one, and records none", async () => {
	let asked = 0;
	const h = deps({ checkPrivateEndpoints: async () => (asked++, { ok: true, ids: [] }) });
	const result = await runJob(job({ privateEndpoints: undefined }), h.deps);
	assert.equal(result.outcome, "completed");
	assert.equal(asked, 0);
	assert.equal("privateEndpoints" in result, false, "every other record unchanged");
	assert.equal(h.ran().privateEndpoints, undefined);
});

test("a withdrawn grant is refused before the mint and the clone, with its comment, and spends nothing", async () => {
	const h = deps({ checkPrivateEndpoints: async () => ({ refused: "private-endpoint-withdrawn" }) });
	const result = await runJob(job(), h.deps);
	assert.equal(result.outcome, "policy");
	assert.equal(result.reason, "private-endpoint-withdrawn");
	assert.equal(result.budgetReserved, false);
	assert.deepEqual(h.calls, [], "no mint, no branch check, no clone, no container");
	assert.deepEqual(h.comments, [PRIVATE_ENDPOINT_COMMENTS["private-endpoint-withdrawn"]]);
	assert.deepEqual(h.logs.find(([e]) => e === "refused_private_endpoint_withdrawn")?.[1], { triggerIndex: 2 });
	assert.equal("privateEndpoints" in result, false, "a refused job was granted nothing");
});

test("an unwired worker grants nothing from queue data alone", async () => {
	const h = deps();
	delete h.deps.checkPrivateEndpoints;
	assert.equal((await runJob(job(), h.deps)).reason, "private-endpoint-withdrawn");
	assert.equal((await runJob(job({ privateEndpoints: undefined }), h.deps)).outcome, "completed");
});

test("a newer triggers file waits for a newer worker, and an unreadable one is retried, both before any spend", async () => {
	const newer = deps({ checkPrivateEndpoints: async () => ({ newer: true }) });
	await assert.rejects(runJob(job(), newer.deps), (e) => e instanceof NewerReleaseHold);
	const unreadable = deps({ checkPrivateEndpoints: async () => ({ unreadable: true }) });
	await assert.rejects(runJob(job(), unreadable.deps), (e) => e instanceof InfraRetry && e.reason === "container-never-started" && e.budgetReserved === false);
	assert.deepEqual([...newer.calls, ...unreadable.calls], []);
});

test("an id this host does not declare is refused on a single host, and handed on from a shared queue", async () => {
	const single = deps({ privateEndpointsDeclared: [LAB] });
	const result = await runJob(job(), single.deps);
	assert.equal(result.reason, "private-endpoint-unknown");
	assert.deepEqual(single.calls, []);
	assert.deepEqual(single.logs.find(([e]) => e === "refused_private_endpoint_unknown")?.[1], { count: 1 });
	const shared = deps({ privateEndpointsDeclared: [], privateEndpointsDeferrable: true });
	await assert.rejects(runJob(job(), shared.deps), (e) => e instanceof PrivateEndpointHold && e.endpoint === "bench-device" && e.budgetReserved === false);
	assert.deepEqual(shared.calls, []);
});

test("a proxy started before it could carry a grant refuses a granted job, and never one with none", async () => {
	const outdated = async () => ({ ok: true, proxy: "pi-dispatch-egress-proxy", privateMissing: ["/etc/pi-dispatch/private"] });
	const h = deps({ egressPreflight: outdated });
	const result = await runJob(job(), h.deps);
	assert.equal(result.reason, "private-endpoint-proxy-outdated");
	assert.equal(result.budgetReserved, false);
	assert.ok(!h.calls.includes("run-container"));
	assert.deepEqual(h.comments.at(-1), PRIVATE_ENDPOINT_COMMENTS["private-endpoint-proxy-outdated"]);
	const none = deps({ egressPreflight: outdated });
	assert.equal((await runJob(job({ privateEndpoints: undefined }), none.deps)).outcome, "completed");
});

test("every refusal reason has its comment, and no comment names a host, a port or an id", () => {
	assert.deepEqual(Object.keys(PRIVATE_ENDPOINT_COMMENTS).sort(), ["private-endpoint-proxy-outdated", "private-endpoint-unknown", "private-endpoint-venue-unsupported", "private-endpoint-withdrawn"]);
	for (const text of Object.values(PRIVATE_ENDPOINT_COMMENTS)) {
		assert.match(text, /^Refused: .*Not run\.$/s);
		assert.doesNotMatch(text, /10\.0\.5\.20|bench-device|:22\b/);
	}
});

test("a venue with its own egress layer refuses a granted job until its policy can carry a grant (#918 part 3)", async () => {
	for (const backend of ["openshell", "openshell-bind"]) {
		const h = deps({ blessedBackends: ["local", backend] });
		const result = await runJob(job({ backend }), h.deps);
		assert.equal(result.reason, "private-endpoint-venue-unsupported", backend);
		assert.deepEqual(h.calls, [], backend);
		assert.deepEqual(h.logs.find(([e]) => e === "refused_private_endpoint_venue_unsupported")?.[1], { venue: backend });
	}
	const local = deps({ blessedBackends: ["local", "openshell"] });
	assert.equal((await runJob(job({ backend: "local" }), local.deps)).outcome, "completed");
});

test("a grant this attempt confirms but the pickup did not, so it took no slot, is handed back to take one, never run (#918 review)", async () => {
	const h = deps({ privateEndpointsHeld: false });
	await assert.rejects(runJob(job(), h.deps), (e) => e instanceof PrivateEndpointHold && e.slot === true && e.endpoint === "bench-device" && e.budgetReserved === false);
	assert.deepEqual(h.calls, [], "nothing minted, cloned or run");
	assert.equal((await runJob(job(), deps({ privateEndpointsHeld: true }).deps)).outcome, "completed");
	// A refusal still comes first: a withdrawn grant is refused, not held.
	assert.equal((await runJob(job(), deps({ privateEndpointsHeld: false, checkPrivateEndpoints: async () => ({ refused: "private-endpoint-withdrawn" }) }).deps)).reason, "private-endpoint-withdrawn");
});
