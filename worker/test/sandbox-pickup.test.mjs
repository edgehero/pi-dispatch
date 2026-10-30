import assert from "node:assert/strict";
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { checkSandboxWorkspace } from "../src/sandbox-workspace-guard.mjs";
import { InfraRetry } from "../src/processor.mjs";
import { inboxKeys, registerLive, pushSteer, readInbox, steerOpenKey } from "../src/steer-inbox.mjs";
import { awaitOpenKey, awaitTargetKeyOf, heldKeys, holdReply, registerAwaitLive } from "../src/held-replies.mjs";
import { makeHeldSettle } from "../src/held-settle.mjs";

let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error(`sandbox pickup tests are REQUIRED here but worker dependencies could not import.\n${importError}`);
const skip = mod ? false : `worker dependencies unavailable (node ${process.version}); CI requires these`;
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("sandbox pickup settlement REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
const integrationSkip = skip || (url ? false : "VALKEY_TEST_URL not set; live settlement skipped locally");
const NOW = Date.UTC(2026, 9, 30, 12);
const forbidden = (name) => () => { throw new Error(`${name} must not run before the sandbox boundary`); };
const signal = () => new AbortController().signal;
const jobOf = (data) => ({ id: "sandbox-boundary-job", data, name: data.kind, attemptsMade: 0 });

function harness({ check, hostBudget = null, deps = {}, projects = () => [], redis = {}, onRecord } = {}) {
	const records = [];
	const reads = { projects: 0 };
	const processor = mod.makeProcessor({
		redis,
		hostBudget,
		projects: () => { reads.projects++; return projects(); },
		getSettings: forbidden("settings read"),
		readModelRoles: forbidden("model roles"),
		recordRun: async (record) => { if (onRecord) await onRecord(record); records.push(record); },
		now: () => NOW,
		deps: {
			checkSandboxWorkspace: check,
			mintToken: forbidden("token mint"),
			prepareWorkspace: forbidden("workspace preparation"),
			runContainer: forbidden("container start"),
			...deps,
		},
	});
	return { processor, records, reads };
}

test("kept workspaces refuse at processor entry before any host slot, settings, model or credential work (#771)", { skip }, async () => {
	const root = tempDir("sandbox-pickup-");
	const sandboxDir = join(root, "sandboxes");
	const workspace = join(sandboxDir, "sb-retained", "workspace");
	fs.mkdirSync(workspace, { recursive: true });
	const hostBudget = { enter: forbidden("host budget ticket") };
	for (const budget of [null, hostBudget]) {
		for (const folder of [sandboxDir, workspace]) {
			const { processor, records, reads } = harness({ hostBudget: budget, check: (data) => checkSandboxWorkspace(data, { sandboxDir }) });
			const job = jobOf({ kind: "local", folder, flow: "review", task: "private operator text" });
			const result = await processor(job, "queue-token", signal());
			assert.deepEqual(result, { outcome: "policy", reason: "local-folder-is-sandbox", budgetReserved: false });
			assert.equal(records.length, 1);
			assert.equal(records[0].job, job);
			assert.deepEqual(records[0].result, result);
			assert.equal(records[0].startedAt, new Date(NOW).toISOString());
			assert.equal(records[0].endedAt, new Date(NOW).toISOString());
			assert.equal(records[0].project, null, "an unassigned workspace records explicit project absence");
			assert.equal(reads.projects, 1, "the free refusal has one metadata snapshot and never enters normal pickup");
		}
	}
});

test("an unreadable kept-workspace boundary throws infrastructure before a slot and succeeds on an ordinary retry (#771)", { skip }, async () => {
	const effects = [];
	const normalPickup = new Error("ordinary pickup reached");
	let unavailable = true;
	const hostBudget = { enter: () => (effects.push("enter"), "ticket"), forget: () => effects.push("forget"), leave: () => effects.push("leave") };
	const { processor, records } = harness({
		hostBudget,
		check: () => unavailable ? { unavailable: true } : null,
		projects: () => { throw normalPickup; },
	});
	const job = jobOf({ kind: "local", folder: "/ordinary/source", flow: "review" });
	await assert.rejects(() => processor(job, "queue-token", signal()), (error) => error instanceof InfraRetry && /boundary could not be read/.test(error.message));
	assert.deepEqual(effects, [], "infrastructure ambiguity cannot take a slot");
	assert.deepEqual(records, [], "a retry is never recorded as a policy terminal");
	unavailable = false;
	await assert.rejects(() => processor(job, "queue-token", signal()), (error) => error === normalPickup);
	assert.deepEqual(effects, ["enter", "forget", "leave"], "the same queued job can reach normal admission when the filesystem recovers");
});

test("a similarly named ordinary source remains eligible for the normal processor gates (#771)", { skip }, async () => {
	const root = tempDir("sandbox-pickup-neighbour-");
	const sandboxDir = join(root, "sandboxes");
	const folder = join(root, "sandboxes-source");
	fs.mkdirSync(sandboxDir);
	fs.mkdirSync(folder);
	const normalPickup = new Error("ordinary source reached project admission");
	const { processor, records } = harness({ check: (data) => checkSandboxWorkspace(data, { sandboxDir }), projects: () => { throw normalPickup; } });
	await assert.rejects(() => processor(jobOf({ kind: "local", folder, flow: "review" }), "queue-token", signal()), (error) => error === normalPickup);
	assert.deepEqual(records, []);
});

test("watch and question-group resolution cannot turn a permitted envelope into a kept-workspace job (#771)", { skip }, async () => {
	const root = tempDir("sandbox-pickup-resolved-");
	const sandboxDir = join(root, "sandboxes");
	const folder = join(sandboxDir, "sb-resolved", "workspace");
	fs.mkdirSync(folder, { recursive: true });
	for (const [kind, runtimeKey] of [["watch", "watchRuntime"], ["zero-touch-grouping", "questionGroupRuntime"]]) {
		const effective = { kind: "local", folder, flow: "review" };
		let checked;
		const { processor, records } = harness({
			hostBudget: { enter: forbidden("host budget ticket") },
			check: (data) => { checked = data; return checkSandboxWorkspace(data, { sandboxDir }); },
			deps: { [runtimeKey]: { resolve: async () => ({ data: effective }) } },
		});
		const result = await processor(jobOf({ kind }), "queue-token", signal());
		assert.equal(checked, effective, "the checked folder is the resolved one the job would use");
		assert.equal(result.reason, "local-folder-is-sandbox");
		assert.equal(records.length, 1);
	}
});

test("a free sandbox refusal captures its project before real held/inbox settlement and keeps it across a live edit (#771)", { skip: integrationSkip }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url);
	const runId = `sandbox-pickup-${randomBytes(12).toString("hex")}`;
	const messageId = randomBytes(16).toString("hex");
	const heldId = randomBytes(16).toString("hex");
	const root = tempDir("sandbox-pickup-settle-");
	const sandboxDir = join(root, "sandboxes");
	const folder = join(sandboxDir, "sb-retained", "workspace");
	fs.mkdirSync(folder, { recursive: true });
	const fallback = { kind: "github", repo: `sandbox-${runId}/repo`, target: { type: "issue", number: 1 }, flow: "answer" };
	const targetKey = awaitTargetKeyOf(fallback);
	t.after(async () => {
		await redis.del(...Object.values(inboxKeys(runId)), steerOpenKey(runId), ...Object.values(heldKeys(runId)), awaitOpenKey(runId), targetKey);
		await redis.quit();
	});
	assert.deepEqual(await registerLive({ redis, runId, host: "pickup-test", now: () => NOW }), { ok: true });
	const message = { id: messageId, mode: "steer", source: "cli", author: { kind: "operator", by: "operator" }, text: "private steering text", at: NOW };
	assert.equal(await pushSteer({ redis, runId, entry: message, now: () => NOW }), "ok");
	// Local jobs have no await target. Seed a surviving held list defensively, as an earlier payload under this run id.
	assert.deepEqual(await registerAwaitLive({ redis, runId, targetKey, host: "pickup-test", now: () => NOW }), { ok: true });
	assert.equal(await holdReply({ redis, runId, entry: { id: heldId, route: "dedup", at: NOW, fallback }, now: () => NOW }), "ok");
	const order = [];
	let projects = [{ id: "original", name: "Private project display name", members: [folder] }];
	const { processor, records, reads } = harness({
		redis,
		hostBudget: { enter: forbidden("host budget ticket") },
		check: (data) => { order.push("boundary"); return checkSandboxWorkspace(data, { sandboxDir }); },
		projects: () => { order.push("projects"); return projects; },
		deps: {
			settleHeld: makeHeldSettle({ redis, now: () => NOW, enqueue: forbidden("held reply resume"), log: (event) => {
				order.push(event);
				projects = [{ id: "edited", name: "Changed display name", members: [folder] }];
			} }),
			onLateForge: async () => {
				assert.equal(await redis.exists(heldKeys(runId).closed), 1, "held replies close before inbox handling");
				order.push("inbox");
			},
		},
		onRecord: async (record) => {
			const inbox = await readInbox({ redis, runId });
			assert.equal(inbox.closed, true);
			assert.equal(inbox.state[messageId], "late", "a queued message becomes late at this final refusal");
			assert.equal(await redis.exists(heldKeys(runId).closed), 1);
			assert.equal(await redis.exists(awaitOpenKey(runId)), 0);
			assert.equal(await redis.exists(steerOpenKey(runId)), 0);
			assert.deepEqual(record.result.steered, { delivered: 0, late: 1, withdrawn: 0 });
			assert.equal(projects[0].id, "edited", "the watched project metadata changed while held settlement awaited Valkey");
			assert.equal(record.project, "original", "the record keeps the one pre-settlement snapshot, rather than re-reading the edited ref");
			order.push("record");
		},
	});
	const job = { ...jobOf({ kind: "local", folder, flow: "review", steer: true, awaitInput: true }), id: runId };
	const result = await processor(job, "queue-token", signal());
	assert.equal(result.reason, "local-folder-is-sandbox");
	assert.deepEqual(order, ["boundary", "projects", "held_replies_dropped", "inbox", "record"]);
	assert.equal(reads.projects, 1);
	assert.equal(records.length, 1);
	assert.equal(await pushSteer({ redis, runId, entry: { ...message, id: randomBytes(16).toString("hex") }, now: () => NOW }), "closed", "a late terminal write cannot revive the inbox");
	assert.equal(await holdReply({ redis, runId, entry: { id: randomBytes(16).toString("hex"), route: "dedup", at: NOW, fallback }, now: () => NOW }), "closed", "the final refusal cannot accept another held reply");
});
