import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseProjects } from "../src/projects.mjs";

// Issue #499 (INT-PROJECTS-FILE-CONTRACT): the pickup gate resolves a job's project ONCE, from one read of the projects
// ref beside the limits snapshot, and every record written after the gate carries that id. index.mjs imports bullmq, so
// this skips below the node floor and hard-fails in CI, like scope-mutex.
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`project pickup tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

const NOW = Date.UTC(2026, 9, 3, 12, 0);
const SETTINGS = () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null });
const projectsOf = (projects) => parseProjects(JSON.stringify({ version: 1, projects }), "projects.json");
const SHOP = projectsOf([{ id: "shop", name: "Webshop", members: ["github:acme/web", "/srv/shop-tools"] }]);
const OPS = projectsOf([{ id: "ops", members: ["github:acme/web"] }]);

function fakeRedis() {
	return { incr: async () => 1, decr: async () => 0, expire: async () => {} };
}

function spyJob(id, data) {
	return { id, attemptsMade: 0, name: data.kind, data, moveToDelayed: async () => {} };
}

/** A processor whose projects ref is `ref.current`, counting every read of it, with each record kept. */
function harness({ ref, getSettings = SETTINGS, runContainer, extra = {} } = {}) {
	const seen = { records: [], reads: 0 };
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: fakeRedis(),
		getSettings,
		applyConcurrency: () => {},
		scopedLimits: () => [],
		projects: () => (seen.reads++, ref.current),
		now: () => NOW,
		recordRun: (r) => seen.records.push(r),
		timeoutMs: 100000,
		waitState: { release: async () => {}, satisfiedBy: async () => null },
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: runContainer ?? (async () => ({ code: 0, aborted: false, turns: 3 })),
			cleanup: async () => {},
			comment: async () => {},
			log: () => {},
		},
		...extra,
	});
	return { processor, seen };
}

const gh = (id, repo, more = {}) => spyJob(id, { kind: "github", repo, target: { number: 1 }, flow: "fix", trigger: { deliveryId: id, sender: { id: 1 } }, ...more });
const local = (id, folder) => spyJob(id, { kind: "local", folder, flow: "tidy", task: "t" });

test("a member job's record carries the project id resolved at pickup, read ONCE per pickup", { skip }, async () => {
	const ref = { current: SHOP };
	const { processor, seen } = harness({ ref });
	await processor(gh("j-1", "acme/web"), "tok", new AbortController().signal);
	assert.equal(seen.records.length, 1);
	assert.equal(seen.records[0].project, "shop");
	assert.equal(seen.reads, 1, "one read of the ref per pickup, beside the limits snapshot");
	await processor(local("j-2", "/srv/shop-tools/"), "tok", new AbortController().signal);
	assert.equal(seen.records[1].project, "shop", "a local job by its resolved folder");
	await processor(gh("j-3", "acme/api"), "tok", new AbortController().signal);
	assert.equal(seen.records[2].project, null, "a non-member carries an explicit null, so the record path does not re-resolve it");
	assert.ok(!JSON.stringify(seen.records).includes("Webshop"), "the name never rides with the job");
});

test("a mid-run edit of projects.json does not change the job's project: resolved at pickup, not at record time", { skip }, async () => {
	const ref = { current: SHOP };
	const { processor, seen } = harness({
		ref,
		runContainer: async () => {
			// The operator moves acme/web to another project while the container runs.
			ref.current = OPS;
			return { code: 0, aborted: false, turns: 3 };
		},
	});
	await processor(gh("j-1", "acme/web"), "tok", new AbortController().signal);
	assert.equal(seen.records[0].project, "shop", "the record agrees with what the job was gated against");
	assert.equal(seen.reads, 1, "and the ref was not read again on the way to the record");
});

test("a job that fails after the gate still records its pickup-time project", { skip }, async () => {
	const ref = { current: SHOP };
	const { processor, seen } = harness({
		ref,
		runContainer: async () => {
			ref.current = [];
			throw new Error("infra boom");
		},
	});
	await assert.rejects(() => processor(gh("j-1", "acme/web"), "tok", new AbortController().signal));
	assert.equal(seen.records.length, 1);
	assert.equal(seen.records[0].project, "shop");
});

test("a settings-overlay refusal after the gate records the project too", { skip }, async () => {
	const ref = { current: SHOP };
	const { processor, seen } = harness({ ref, getSettings: () => ({ invalid: "bad overlay" }) });
	const result = await processor(gh("j-1", "acme/web"), "tok", new AbortController().signal);
	assert.equal(result.reason, "settings-overlay-invalid");
	assert.equal(seen.records[0].project, "shop");
});

test("a record written BEFORE the pickup gate carries no project, so the record path resolves it from the live ref", { skip }, async () => {
	const ref = { current: SHOP };
	const { processor, seen } = harness({ ref });
	const result = await processor(gh("j-1", "acme/web", { waitFor: [{ blocked: "x" }] }), "tok", new AbortController().signal);
	assert.equal(result.reason, "wait-unreadable");
	// One read: the projects are resolved ABOVE the wait gate since issue #596's gate round 1, so the never-fits
	// check can refuse a size before a job waits; the wait gate's own refusal still records none.
	assert.equal(seen.reads, 1, "one pickup read, above the wait gate");
	assert.equal("project" in seen.records[0], false, "no project key: start.mjs resolves it from the live ref");
});

test("with no projects every post-gate record carries project null", { skip }, async () => {
	const { processor, seen } = harness({ ref: { current: [] } });
	await processor(gh("j-1", "acme/web"), "tok", new AbortController().signal);
	assert.equal(seen.records[0].project, null);
});

test("an operator cancel acknowledged mid-run records the PICKUP project after a live edit (the catch-side recorder)", { skip }, async () => {
	const ref = { current: SHOP };
	const ac = new AbortController();
	const { processor, seen } = harness({
		ref,
		runContainer: async () => {
			ref.current = OPS;
			ac.abort("operator-cancel");
			throw new Error("container stopped");
		},
	});
	const result = await processor(gh("j-1", "acme/web"), "tok", ac.signal);
	assert.equal(result.reason, "operator-cancel");
	assert.equal(seen.records.length, 1);
	assert.equal(seen.records[0].project, "shop", "the catch path carries the pickup id, never a live re-resolution");
});

test("BY SHAPE: below the pickup gate every record goes through the one bound recorder, so no site can drop the project", () => {
	// The rule is one closure (`recordAfterGate`), not a field each call site has to remember. A bare `recordRun({`
	// below its definition would record without the pickup project, and start.mjs would then resolve the LIVE ref.
	const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
	const at = src.indexOf("const recordAfterGate = (args) => recordRun({ ...args, project, size, capacity, earlier });");
	assert.notEqual(at, -1, "the recorder is bound once, carrying the pickup project, the size resolved beside it (#596), the capacity set at admission and the earlier attempts read at pickup (#599)");
	assert.ok(at > src.indexOf("const size = resolveJobSize({ project, limits, env: jobSizeEnv });"), "the size is resolved from the same limits snapshot and pickup project, before the recorder");
	// One read of the projects ref per pickup (issue #504 part B reuses the same snapshot for the resolved folder).
	assert.ok(at > src.indexOf("const project = projectOf(job.data, pickupProjects);"), "and after the pickup resolution");
	assert.ok(src.indexOf("const pickupProjects = projects();") < src.indexOf("const project = projectOf(job.data, pickupProjects);"));
	// Comments stripped first (they name `recordRun` in prose), then NO `recordRun` identifier at all: that refuses a
	// bare call, an optional call (`recordRun?.(`) and an alias (`const rec = recordRun`) alike.
	const code = src
		.slice(src.indexOf("\n", at), src.indexOf("export function createWorker("))
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/[^\n]*/g, "");
	assert.deepEqual(code.match(/\brecordRun\b/g) ?? [], [], "no recordRun reference below the gate");
	// Eight: the never-fits refusal moved ABOVE the wait gate (issue #596) and records the same pickup project
	// and size by hand there (pinned below).
	assert.equal((code.match(/\brecordAfterGate\(\{/g) ?? []).length, 8, "exactly the 8 post-gate record paths use it; a new one must be counted here");
	const above = src.slice(src.indexOf("const size = resolveJobSize({ project, limits, env: jobSizeEnv });"), at);
	assert.deepEqual(above.match(/recordRun\(\{ job, result, startedAt: at, endedAt: new Date\(\)\.toISOString\(\), project, size, earlier \}\)/g)?.length, 1, "the never-fits refusal carries the pickup project and size, and the earlier attempts (#599)");
});

// Issue #596: the job's size is resolved at the same pickup, from the same limits snapshot and project, and reaches the
// container and the record as an ARGUMENT: a size a queued job carries in its data is never read.
test("the size is resolved at pickup from the project row, then the deployment's settings, and reaches runContainer and the record", { skip }, async () => {
	const { parseScopedLimits } = await import("../src/scoped-limits.mjs");
	const limits = parseScopedLimits(JSON.stringify({ version: 3, limits: [{ scope: "project:shop", memory: "1536m", cpus: 0.5 }] }), "sl.json");
	const ran = [];
	let limitReads = 0;
	const { processor, seen } = harness({
		ref: { current: SHOP },
		runContainer: async (ctx) => (ran.push(ctx.size), { code: 0, aborted: false, turns: 1 }),
		extra: { scopedLimits: () => (limitReads++, limits), jobSizeEnv: { PI_JOB_MEMORY: "2g" } },
	});
	await processor(gh("j-1", "acme/web", { size: { memMiB: 65536, cpuCenti: 3200, source: "project" }, memory: "64g" }), "tok", new AbortController().signal);
	assert.deepEqual(ran[0], { memMiB: 1536, cpuCenti: 50, source: "project" }, "the project row, never the job's data");
	assert.deepEqual(seen.records[0].size, { memMiB: 1536, cpuCenti: 50, source: "project" });
	assert.equal(limitReads, 1, "one limits read per pickup: the size comes from the gates' own snapshot");
	await processor(gh("j-2", "acme/api"), "tok", new AbortController().signal);
	assert.deepEqual(ran[1], { memMiB: 2048, cpuCenti: 200, source: "env" }, "no project: the deployment's settings");
	assert.deepEqual(seen.records[1].size, { memMiB: 2048, cpuCenti: 200, source: "env" });
});
