import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeProcessor, SCOPE_BUSY_RECHECK_MS } from "../src/index.mjs";
import { cancelAckKey, cancelReqKey, requestCancel } from "../src/cancel-state.mjs";
import { hostBudgetSettings, makeHostBudget } from "../src/host-budget.mjs";
import { buildLocalEventJob, localEventJobId } from "../src/local-event.mjs";
import { LocalEventWait, makeLocalEventRuntime } from "../src/local-event-runtime.mjs";
import { readLocalWorkspaceIdentity } from "../src/local-workspace.mjs";
import { InfraRetry } from "../src/processor.mjs";
import { makeInFlight } from "../src/scoped-limits.mjs";
import { disarmTrigger, makeDisarmOnce } from "../src/triggers-file.mjs";
import { parseTriggers, TRIGGERS_FILE_VERSION } from "../src/triggers.mjs";
import { deferRecordOf, withDeferRecords } from "./helpers/defer-redis.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const NOW = 2_000_000;
const refusal = (reason) => ({ outcome: "policy", reason, budgetReserved: false });
const definition = (extra = {}) => ({
	on: { type: "issue", forge: "github", id: "maintenance", action: ["closed"], debounceSeconds: 0 },
	run: { kind: "local", folder: "/srv/maintenance", command: "maintain-prs", worker: "owner", github: true },
	...extra,
});
const normalize = (raw) => parseTriggers(JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [raw] }), "triggers.json")[0];
function eventJob(raw = definition()) {
	const generation = "a".repeat(32);
	return queueJob(localEventJobId(generation), buildLocalEventJob(normalize(raw), generation));
}
function queueJob(id, data) {
	const moves = [];
	return { id, name: "local", data, attemptsMade: 0, moves, async moveToDelayed(at, token) { moves.push({ at, token }); } };
}
function harness({ check = async () => ({ ok: true }), claim = async () => ({ ok: true }), finish = async () => {}, extraDeps = {}, extra = {} } = {}) {
	const calls = [];
	const records = [];
	const logs = [];
	const settlements = [];
	const inFlight = makeInFlight();
	const redis = withDeferRecords({
		async incr() { calls.push("reserve"); return 1; },
		async decr() { calls.push("refund"); return 0; },
		async expire() {},
	});
	const runtime = {
		async check(job) { calls.push("check"); return check(job); },
		async claim(job, owner) { calls.push("claim"); return claim(job, owner); },
		store: { async finish(meta, options) { calls.push("finish"); settlements.push({ meta, options }); return finish(meta, options); } },
	};
	const processor = makeProcessor({
		cancelJob() {}, stopContainer() {}, redis, inFlight, hostName: "owner", now: () => NOW,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		recordRun: (record) => records.push(record), timeoutMs: 100_000,
		deps: {
			localEventRuntime: runtime,
			async mintToken() { calls.push("mint"); return "token"; },
			async isDefaultBranchProtected() { return true; },
			async prepareWorkspace() { calls.push("prepare"); return { workspaceDir: "/w", jobDir: "/j" }; },
			async runContainer() { calls.push("container"); return { code: 0, aborted: false }; },
			async cleanup() { calls.push("cleanup"); },
			async comment() {},
			log: (event, fields) => logs.push({ event, fields }),
			...extraDeps,
		},
		...extra,
	});
	return { processor, calls, records, logs, settlements, redis, runtime, inFlight, run: (job, token = "attempt") => processor(job, token, new AbortController().signal) };
}

test("local event authority refuses at pickup before identity reads, credentials, preparation or reservation", async () => {
	const h = harness({ check: async () => refusal("local-event-trigger-changed"), extraDeps: { localWorkspaceIdentity: () => assert.fail("refused before workspace identity") } });
	const job = eventJob();
	assert.deepEqual(await h.run(job), refusal("local-event-trigger-changed"));
	assert.deepEqual(h.calls, ["check", "finish"]);
	assert.equal(h.records.length, 1);
	assert.equal(h.settlements[0].options.owner, "attempt");
});

test("explicit owner applies to cron jobs too, before any local-event or workspace work", async () => {
	const h = harness({ extraDeps: { localWorkspaceIdentity: () => assert.fail("wrong owner never resolves a folder") } });
	const job = queueJob("cron-fallback", { kind: "local", folder: "/srv/maintenance", command: "maintain-prs", worker: "other-owner", trigger: { id: "fallback", pattern: "0 * * * *" } });
	assert.equal((await h.run(job)).reason, "local-event-wrong-worker");
	assert.deepEqual(h.calls, []);
	assert.equal(h.records.length, 1);
});

test("pickup debounce and the final claim race defer without consuming intent or a budget attempt", async () => {
	for (const stage of ["pickup", "claim"]) {
		const h = harness({
			check: async () => stage === "pickup" ? { untilMs: NOW + 5_000 } : { ok: true },
			claim: async () => { throw new LocalEventWait(NOW + 5_000); },
		});
		const job = eventJob();
		await assert.rejects(h.run(job), (error) => error.name === "DelayedError");
		assert.deepEqual(job.moves, [{ at: NOW + 5_000, token: "attempt" }]);
		assert.equal(deferRecordOf(h.redis, job.id).why, "local-event-debounce");
		assert.deepEqual(h.calls, stage === "pickup" ? ["check"] : ["check", "claim"]);
		assert.equal(h.records.length, 0);
	}
});

test("a pre-credential authority refusal is recorded and settled without minting or reserving", async () => {
	const h = harness({ claim: async () => refusal("operator-cancel") });
	assert.equal((await h.run(eventJob())).reason, "operator-cancel");
	assert.deepEqual(h.calls, ["check", "claim", "finish"]);
	assert.equal(h.records.length, 1);
});

test("successful local event claim precedes credentials and the final preparation wrapper keeps workspace identity", async () => {
	const workspace = { key: "local-workspace:1:2", folder: "/resolved/maintenance" };
	let prepared;
	const h = harness({ extraDeps: {
		localWorkspaceIdentity: () => workspace,
		async prepareWorkspace(job, token, options) { h.calls.push("prepare"); prepared = { job, token, options }; return { workspaceDir: "/w", jobDir: "/j" }; },
	} });
	const job = eventJob();
	assert.equal((await h.run(job)).outcome, "completed");
	for (const operation of ["mint", "prepare", "reserve", "container"]) {
		assert.ok(h.calls.indexOf("claim") >= 0 && h.calls.indexOf("claim") < h.calls.indexOf(operation), operation);
	}
	assert.equal(prepared.token, "token");
	assert.equal(prepared.options.queueJobId, job.id);
	assert.deepEqual(prepared.options.localWorkspace, workspace);
	assert.equal(h.inFlight.count(workspace.key), 0, "the identity hold is released after the attempt");
	assert.equal(h.settlements.length, 1);
	assert.equal(h.calls.at(-1), "finish", "settlement follows resource cleanup");
});

test("a failed attempt leaves intent active for retry, while settlement failure cannot rerun a completed command", async () => {
	const h = harness({ extraDeps: { runContainer: async () => { throw new InfraRetry("temporary infrastructure failure", { reason: "container-infra-exit" }); } } });
	await assert.rejects(h.run(eventJob()), (error) => error instanceof InfraRetry);
	assert.equal(h.settlements.length, 0);
	const completed = harness({ finish: async () => { throw new Error("lost settlement connection"); } });
	assert.equal((await completed.run(eventJob())).outcome, "completed");
	assert.equal(completed.settlements.length, 1);
	assert.ok(completed.logs.some(({ event }) => event === "local_event_settle_failed"));
});

test("a settled attempt recovered after a lost queue lock replays its result before checking obsolete event state", async () => {
	const record = { outcome: "completed", reason: null, exitCode: 0, turns: 3, tokens: null, budgetReserved: true };
	const h = harness({ check: async () => assert.fail("the settled generation may already have advanced"), extra: { settledRecord: async () => record } });
	const job = eventJob(); job.stalledCounter = 1;
	assert.deepEqual(await h.run(job), record);
	assert.deepEqual(h.calls, ["finish"]);
	assert.equal(h.records.length, 0, "the terminal record is never overwritten with superseded");
});

test("a slow intent cancellation cannot acknowledge or abort after the container outcome was settled", { timeout: 10_000 }, async () => {
	const containerEntered = Promise.withResolvers();
	const containerReleased = Promise.withResolvers();
	const cancelSent = Promise.withResolvers();
	const cancelReleased = Promise.withResolvers();
	const writes = [];
	let aborted = 0;
	const h = harness({ extra: { cancelPollMs: 1, cancelStopBoundMs: 1, cancelJob: () => { aborted++; return true; } }, extraDeps: {
		async runContainer() { containerEntered.resolve(); await containerReleased.promise; return { code: 0, aborted: false }; },
	} });
	const job = eventJob();
	h.redis.get = async (key) => key === cancelReqKey(job.id) ? "operator-cancel" : null;
	h.redis.set = async (...args) => { writes.push(args); };
	h.redis.del = async () => 1;
	h.runtime.store.cancel = async () => { cancelSent.resolve(); await cancelReleased.promise; };
	const running = h.run(job);
	try {
		await Promise.race([containerEntered.promise, running.then(() => assert.fail("container never started"))]);
		await cancelSent.promise;
		containerReleased.resolve();
		assert.equal((await running).outcome, "completed");
	} finally { containerReleased.resolve(); cancelReleased.resolve(); }
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(aborted, 0, "a late cancellation response must recheck whether polling stopped");
	assert.equal(writes.some(([key]) => key === cancelAckKey(job.id)), false);
});

test("an unacknowledged local event cancel reports possible durable mutation, with ordinary cancellation unchanged", async () => {
	for (const jobId of [localEventJobId("a".repeat(32)), "ordinary-job"]) {
		const removed = [];
		const result = await requestCancel({ jobId, redis: { async set() {}, async get() { return null; }, async del(key) { removed.push(key); } }, ackTimeoutMs: 0, pollMs: 1, now: () => NOW, sleep: async () => assert.fail("zero wait is immediate") });
		assert.deepEqual(removed, [cancelReqKey(jobId)]);
		if (jobId === "ordinary-job") assert.deepEqual(result, { timeout: true });
		else {
			assert.equal(result.timeout, true);
			assert.match(result.note, /may have been stored and pending signals cleared/);
			assert.doesNotMatch(result.note, /nothing was changed/i);
		}
	}
});

test("cron and event jobs through actual symlink aliases share a mutex and never overlap containers", { timeout: 10_000 }, async () => {
	const directory = tempDir("local-event-alias-");
	const folder = join(directory, "workspace");
	const alias = join(directory, "alias");
	mkdirSync(folder); symlinkSync(folder, alias, "dir");
	const entered = Promise.withResolvers();
	const released = Promise.withResolvers();
	let containers = 0;
	const h = harness({ extraDeps: {
		localWorkspaceIdentity: readLocalWorkspaceIdentity,
		async runContainer() { containers++; if (containers === 1) { entered.resolve(); await released.promise; } return { code: 0, aborted: false }; },
	} });
	const firstJob = eventJob({ ...definition(), run: { ...definition().run, folder } });
	const cronJob = queueJob("cron-alias", { kind: "local", folder: alias, command: "maintain-prs", worker: "owner", trigger: { id: "fallback", pattern: "0 * * * *" } });
	const first = h.run(firstJob);
	try {
		await Promise.race([entered.promise, first.then(() => assert.fail("first job ended before its container"))]);
		await assert.rejects(h.run(cronJob, "cron-attempt"), (error) => error.name === "DelayedError");
		assert.equal(containers, 1);
		assert.deepEqual(cronJob.moves, [{ at: NOW + SCOPE_BUSY_RECHECK_MS, token: "cron-attempt" }]);
		assert.equal(deferRecordOf(h.redis, cronJob.id).why, "scope-folder");
		assert.equal(h.calls.filter((operation) => operation === "reserve").length, 1);
	} finally { released.resolve(); await first; }
	assert.equal((await h.run(cronJob, "cron-attempt-two")).outcome, "completed");
	assert.equal(containers, 2);
});

test("a lingering sandbox keeps its workspace quarantined with resource budgets off until positive gone evidence", async () => {
	let gone = null;
	let containers = 0;
	const workspace = { key: "local-workspace:1:99", folder: "/srv/maintenance" };
	const budget = makeHostBudget({ settings: hostBudgetSettings({ PI_HOST_MEMORY_BUDGET: "off", PI_HOST_CPU_BUDGET: "off" }), countLimit: () => 3, now: () => NOW, containerGone: async () => gone });
	await budget.ready;
	const h = harness({ extra: { hostBudget: budget }, extraDeps: {
		localWorkspaceIdentity: () => workspace,
		async localContainerGone() { if (containers === 1) assert.fail("known lingering work already keeps its guard"); return true; },
		async runContainer() { containers++; return { code: 0, aborted: false, ...(containers === 1 && { lingering: true }) }; },
	} });
	assert.equal((await h.run(eventJob())).reason, "openshell-bind-sandbox-lingering");
	const cron = queueJob("cron-after-linger", { kind: "local", folder: "/alias/maintenance", command: "maintain-prs", worker: "owner", trigger: { id: "fallback", pattern: "0 * * * *" } });
	for (const evidence of [null, false]) {
		gone = evidence; await budget.sweep();
		await assert.rejects(h.run(cron), (error) => error.name === "DelayedError");
		assert.equal(deferRecordOf(h.redis, cron.id).why, "workspace-orphan");
		assert.equal(containers, 1);
	}
	gone = true; await budget.sweep();
	assert.equal((await h.run(cron)).outcome, "completed");
	assert.equal(containers, 2);
});

test("a native runtime failure cannot free a workspace until the daemon confirms its container is gone", async () => {
	for (const evidence of [false, null, "throws"]) {
		let gone = evidence;
		let containers = 0;
		const inspected = [];
		const workspace = { key: "local-workspace:1:100", folder: "/srv/maintenance" };
		const budget = makeHostBudget({ settings: hostBudgetSettings({ PI_HOST_MEMORY_BUDGET: "off", PI_HOST_CPU_BUDGET: "off" }), countLimit: () => 3, now: () => NOW, containerGone: async () => gone === true });
		await budget.ready;
		const failure = new InfraRetry("the runtime connection closed", { reason: "container-infra-exit" });
		const h = harness({ extra: { hostBudget: budget }, extraDeps: {
			localWorkspaceIdentity: () => workspace,
			async localContainerGone(name, venue) { inspected.push({ name, venue }); if (gone === "throws") throw new Error("daemon is unavailable"); return gone; },
			async runContainer() { containers++; if (containers === 1) throw failure; return { code: 0, aborted: false }; },
		} });
		const first = eventJob();
		await assert.rejects(h.run(first), (error) => error === failure, "inspection preserves the retryable run error");
		assert.equal(inspected.length, 1);
		assert.equal(inspected[0].venue.id, first.id);
		assert.equal(budget.entries().length, 1);
		assert.ok(budget.entries()[0].orphan);
		assert.ok(h.logs.some(({ event }) => event === "local_workspace_exit_unconfirmed"));
		assert.equal(h.settlements.length, 0, "an infrastructure attempt does not settle event intent");
		const cron = queueJob("cron-after-native-error", { kind: "local", folder: "/alias/maintenance", command: "maintain-prs", worker: "owner", trigger: { id: "fallback", pattern: "0 * * * *" } });
		await budget.sweep();
		await assert.rejects(h.run(cron), (error) => error.name === "DelayedError");
		assert.equal(deferRecordOf(h.redis, cron.id).why, "workspace-orphan");
		assert.equal(containers, 1);
		gone = true; await budget.sweep();
		assert.equal((await h.run(cron)).outcome, "completed");
		assert.equal(containers, 2);
		assert.equal(budget.entries().length, 0, "positive exit evidence frees the later normal attempt");
	}
});

test("positive native exit evidence releases the workspace after either success or a retryable exit", async () => {
	for (const throws of [false, true]) {
		const workspace = { key: "local-workspace:1:101", folder: "/srv/maintenance" };
		const budget = makeHostBudget({ settings: hostBudgetSettings({ PI_HOST_MEMORY_BUDGET: "off", PI_HOST_CPU_BUDGET: "off" }), countLimit: () => 3, now: () => NOW });
		await budget.ready;
		let probes = 0;
		const h = harness({ extra: { hostBudget: budget }, extraDeps: {
			localWorkspaceIdentity: () => workspace,
			async localContainerGone() { probes++; return true; },
			async runContainer() { if (throws) throw new InfraRetry("container exited", { reason: "container-infra-exit" }); return { code: 0, aborted: false }; },
		} });
		if (throws) await assert.rejects(h.run(eventJob()), (error) => error instanceof InfraRetry);
		else assert.equal((await h.run(eventJob())).outcome, "completed");
		assert.equal(probes, 1);
		assert.equal(budget.entries().length, 0);
		assert.equal(h.inFlight.count(workspace.key), 0);
		assert.equal(h.logs.some(({ event }) => event === "local_workspace_exit_unconfirmed"), false);
	}
});

test("a local one-shot disarms its stable identity after row reorder and preserves the other rule", async () => {
	const directory = tempDir("local-event-once-");
	const triggersPath = join(directory, "triggers.json");
	const target = definition(); target.on.once = true; target.on.number = 7;
	const other = definition(); other.on.id = "other"; other.on.once = true; other.on.number = 8;
	const job = eventJob(target);
	writeFileSync(triggersPath, JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [other, target] }));
	const logs = [];
	const disarmOnce = makeDisarmOnce({ triggersPath, log: (event, fields) => logs.push({ event, fields }), disarm: (args) => disarmTrigger({ ...args, now: () => NOW }) });
	await disarmOnce({ job, endedAt: new Date(NOW).toISOString() });
	const after = JSON.parse(readFileSync(triggersPath, "utf8"));
	assert.equal(after.triggers[0].on.disarmed, undefined);
	assert.deepEqual(after.triggers[1].on.disarmed, { at: new Date(NOW).toISOString(), jobId: job.id });
	assert.ok(logs.some(({ event }) => event === "trigger_disarmed"));
	const runtime = makeLocalEventRuntime({ triggersPath, worker: "owner", now: () => NOW, store: { read: async () => ({ current: { generation: job.data.localEvent.generation, phase: "active" } }) } });
	assert.deepEqual(await runtime.check(job), { ok: true, index: 1 }, "the same attempt may retry after recording its own disarm");
});

test("one-shot disarm refuses changed authority and never writes a replacement rule", async () => {
	const directory = tempDir("local-event-once-change-");
	const triggersPath = join(directory, "triggers.json");
	const target = definition(); target.on.once = true; target.on.number = 7;
	const job = eventJob(target);
	target.run.worker = "replacement-owner";
	const text = JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [target] });
	writeFileSync(triggersPath, text);
	const result = await disarmTrigger({ triggersPath, number: 7, command: job.data.command, jobId: job.id, localEvent: job.data.localEvent, at: new Date(NOW).toISOString(), now: () => NOW });
	assert.match(result.invalid, /definition changed/);
	assert.equal(readFileSync(triggersPath, "utf8"), text);
});

test("superseded or invalid local event records cannot spend a fresh one-shot, while a current cancellation does", async () => {
	const directory = tempDir("local-event-once-authority-");
	const triggersPath = join(directory, "triggers.json");
	const target = definition(); target.on.once = true; target.on.number = 7;
	const job = eventJob(target);
	const text = JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [target] });
	writeFileSync(triggersPath, text);
	const disarmOnce = makeDisarmOnce({ triggersPath, disarm: (args) => disarmTrigger({ ...args, now: () => NOW }) });
	for (const reason of ["local-event-superseded", "local-event-invalid", "local-event-wrong-worker", "local-event-unavailable", "local-event-trigger-changed", "local-event-config-invalid"]) {
		await disarmOnce({ job, result: refusal(reason), endedAt: new Date(NOW).toISOString() });
		assert.equal(readFileSync(triggersPath, "utf8"), text, reason);
	}
	await disarmOnce({ job, result: refusal("operator-cancel"), endedAt: new Date(NOW).toISOString() });
	assert.equal(JSON.parse(readFileSync(triggersPath, "utf8")).triggers[0].on.disarmed.jobId, job.id);
});
