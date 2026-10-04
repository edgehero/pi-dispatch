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
	assert.equal(seen.reads, 0, "the wait gate refused before the pickup gate read anything");
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
	const at = src.indexOf("const recordAfterGate = (args) => recordRun({ ...args, project });");
	assert.notEqual(at, -1, "the recorder is bound once, carrying the pickup project");
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
	assert.equal((code.match(/\brecordAfterGate\(\{/g) ?? []).length, 8, "exactly the 8 post-gate record paths use it; a new one must be counted here");
});
