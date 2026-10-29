import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { makeImagePreflight } from "../src/image-preflight.mjs";
import { makeProcessor } from "../src/index.mjs";

const NOW = Date.parse("2026-10-29T12:00:00Z");
function fixture({ roles = { default: { editor: "openai/first", explorer: "openai/small" } }, data = {}, capabilities = ["exitAuth", "modelPolicy", "modelRoles"], stage = async () => {}, imagePreflight = async () => ({ ok: true, capabilities }), result = { code: 0, aborted: false }, readRoles = null, canaryBusy = undefined } = {}) {
	const events = [];
	const records = [];
	const store = new Map();
	const redis = {
		get: async (key) => store.get(key) ?? null,
		set: async (key, value) => { store.set(key, value); return "OK"; },
		incr: async (key) => { events.push("reserve"); const n = Number(store.get(key) ?? 0) + 1; store.set(key, String(n)); return n; },
		decr: async (key) => { const n = Number(store.get(key) ?? 0) - 1; store.set(key, String(n)); return n; },
		expire: async () => 1,
	};
	let map = roles;
	const processor = makeProcessor({ redis, cancelJob: () => {}, stopContainer: () => {}, now: () => NOW,
		getSettings: () => ({ provider: "openai", model: "default", maxTurns: 5, dailyCap: 10, concurrency: 3, softHoldPct: null }),
		readModelRoles: readRoles ?? (() => map), recordRun: (row) => records.push(row),
		deps: { canaryBusy, now: new Date(NOW), imagePreflight, mintToken: async () => { events.push("mint"); return "token"; }, isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => { events.push("clone"); return { workspace: "/w", jobDir: "/j" }; }, stageModelRoleInputs: async (job, prepared) => { events.push({ stage: job }); return stage(job, prepared); },
			cleanup: async () => {}, comment: async () => {}, log: () => {}, runContainer: async ({ job }) => { events.push({ run: job }); return result; } },
	});
	let seq = 0;
	return { events, records, setMap: (value) => { map = value; }, run: () => processor({ id: `roles-${++seq}`, moveToDelayed: async () => events.push("defer"), attemptsMade: 0, name: "github", data: { kind: "github", repo: "org/repo", model: "role:editor", ...data } }, "lock", new AbortController().signal) };
}

test("unknown role and provider conflict refuse before token, clone, snapshot or budget reservation", async () => {
	for (const [options, reason] of [[{ data: { model: "role:missing" } }, "model-role-unknown"], [{ data: { provider: "anthropic" } }, "model-role-provider-conflict"]]) {
		const f = fixture(options);
		assert.equal((await f.run()).reason, reason);
		assert.deepEqual(f.events, []);
	}
});

test("next pickup rereads the map, snapshots the resolved list and records role with physical model", async () => {
	const f = fixture();
	assert.equal((await f.run()).outcome, "completed");
	f.setMap({ default: { editor: "openai/second", explorer: "openai/small" } });
	assert.equal((await f.run()).outcome, "completed");
	const runs = f.events.filter((event) => event.run).map((event) => event.run);
	assert.deepEqual(runs.map((job) => [job.modelRole, job.provider, job.model]), [["editor", "openai", "first"], ["editor", "openai", "second"]]);
	assert.deepEqual(runs[1].models, ["openai/second", "openai/small"]);
	assert.equal(f.records[0].result.modelRole, "editor");
	assert.equal(f.records[1].result.model, "second");
	assert.ok(f.events.findIndex((event) => event.stage) < f.events.indexOf("reserve"));
});

test("unsupported role image refuses before token mint and clone", async () => {
	const imagePreflight = makeImagePreflight({ image: "pi-job:test", spawnFn: () => {
		const child = new EventEmitter(); child.stdout = new EventEmitter();
		queueMicrotask(() => { child.stdout.emit("data", "sha256:abc|1.4.0|github|exitAuth,modelPolicy"); child.emit("close", 0); });
		return child;
	} });
	const f = fixture({ imagePreflight });
	assert.equal((await f.run()).reason, "job-image-model-roles-unsupported");
	assert.deepEqual(f.events, []);
});

test("invalid base agent snapshot refuses before the count reservation and container", async () => {
	const f = fixture({ stage: async () => { throw Object.assign(new Error("invalid agent"), { piDispatchConfig: true }); } });
	assert.equal((await f.run()).reason, "model-agents-invalid");
	assert.equal(f.events.includes("reserve"), false);
	assert.equal(f.events.some((event) => event.run), false);
});


test("transient snapshot failure retries without count reservation or container", async () => {
	const f = fixture({ stage: async () => { throw Object.assign(new Error("read failed"), { code: "EIO" }); } });
	await assert.rejects(f.run, { name: "InfraRetry", reason: "container-never-started" });
	assert.equal(f.events.includes("reserve"), false);
	assert.equal(f.events.some((event) => event.run), false);
});


test("completed parent retains verified local agent refusal telemetry without becoming failed", async () => {
	const modelRoles = { refusals: [{ agentHash: "a".repeat(64), reason: "unknown-role" }] };
	const f = fixture({ result: { code: 0, exitLineCode: 0, exitAuth: "verified", aborted: false, modelRoles } });
	assert.equal((await f.run()).outcome, "completed");
	assert.deepEqual(f.records[0].result.modelRoles, modelRoles);
	const unsigned = fixture({ result: { code: 0, exitLineCode: 0, aborted: false, modelRoles } });
	await unsigned.run();
	assert.equal(unsigned.records[0].result.modelRoles, undefined);
});


test("a malformed first role file refuses without spending while an I/O failure retries", async () => {
	const malformed = fixture({ readRoles: () => { throw Object.assign(new Error("invalid role file"), { piDispatchConfig: true, modelSelectionReason: "model-roles-invalid" }); } });
	assert.equal((await malformed.run()).reason, "model-roles-invalid");
	assert.deepEqual(malformed.events, []);
	const unreadable = fixture({ readRoles: () => { throw new Error("temporarily unreadable"); } });
	await assert.rejects(unreadable.run, { name: "InfraRetry" });
	assert.deepEqual(unreadable.events, []);
});


test("canary exclusion defers ordinary jobs before model reads, mint, clone or reserves", async () => {
	const f = fixture({ canaryBusy: async () => true, readRoles: () => assert.fail("exclusive lease must precede role admission") });
	await assert.rejects(f.run, { name: "DelayedError" });
	assert.deepEqual(f.events, ["defer"]);
});
