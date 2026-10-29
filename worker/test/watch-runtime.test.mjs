import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeWatchRuntime, readWatchOutput } from "../src/watch-runtime.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeRedactor } from "../src/redact-secrets.mjs";
const findingId = "a".repeat(64);
function fixture({ decision = false, shadow = false, storeOverrides = {}, pauseUntil = () => null, mode = "investigate", onEnqueue = async () => {}, publishIssue = async () => ({ status: "created" }) } = {}) {
	const root = tempDir("pi-watch-runtime-"); const outboxDir = join(root, "outbox"); mkdirSync(outboxDir);
	const triggersPath = join(root, "triggers.json");
	const finding = { id: findingId, ruleId: "shop", source: "prod", fingerprint: "b".repeat(64), severity: "error", count: 37, firstSeen: "2026-10-29T00:00:00Z", lastSeen: "2026-10-29T00:10:00Z", fields: { service: "checkout" }, samples: ["private-hostile-sample"] };
	const trigger = { on: { type: "watch", id: "shop", source: "prod", fingerprint: ["service"], minCount: 5, window: "10m", cooldown: "6h", maxPerDay: 4 }, run: mode === "issue" ? { kind: "local", mode, issue: { kind: "github", repo: "acme/shop" } } : { kind: "local", mode, folder: root, flow: "triage", task: "Investigate", maxCostUsd: "0.40", issue: { kind: "github", repo: "acme/shop" } }, ...(decision && { decide: { model: "openrouter/typesafe/jev-1.13", maxCostUsd: "0.001", fields: ["service"], shadow, questions: { act: { type: "choice", criteria: { investigate: "failure", ignore: "noise", file_issue: "ask person" } } }, act: { investigate: 0.7, ignore: 0.9, otherwise: "file_issue" } } }) };
	writeFileSync(triggersPath, JSON.stringify({ watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_PROD_SECRET" } }, triggers: [trigger] }));
	const changes = []; const traces = []; const queued = []; const handoffs = []; const acknowledged = [];
	let latest = { ...finding };
	const store = { async scheduleAction(id, ruleId, dueAt) { handoffs.push({ id, ruleId, dueAt }); }, async pendingActions() { return handoffs; }, async acknowledgeAction(id) { acknowledged.push(id); }, async takeFinding() { return { status: "ready", finding }; }, async readFinding() { return latest; }, async readBoard() { return { version: 4, frozen: true, blocks: [] }; }, async updateFinding(_id, patch) { changes.push(patch); latest = { ...latest, ...patch }; }, async appendTrace(_id, entry) { traces.push(entry); }, async proposeBoard() { assert.fail("no proposal expected"); }, ...storeOverrides };
	const runtime = makeWatchRuntime({ store, triggersPath, pauseUntil, enqueue: async (...args) => { queued.push(args); return onEnqueue(...args); }, publishIssue, getSettings: () => ({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" }), now: () => 1793232000000 });
	return { runtime, changes, traces, queued, handoffs, acknowledged, finding, outboxDir, triggersPath, trigger, store, ref: { kind: "watch", watch: { findingId, ruleId: "shop", phase: "dispatch" } } };
}
test("watch pickup ignores forged execution selectors and private evidence never serializes into persisted queue bytes", async () => {
	const f = fixture();
	const resolved = await f.runtime.resolve({ ...f.ref, folder: "/attacker", task: "override", model: "attacker", secrets: ["SECRET"] }, "run1");
	assert.equal(resolved.data.kind, "local"); assert.equal(resolved.data.github, false); assert.equal(resolved.data.packages, false);
	assert.equal(resolved.data.task, "Investigate"); assert.equal(resolved.data.watch.finding.samples[0], "private-hostile-sample");
	const serialized = JSON.stringify(resolved.data);
	assert.equal(serialized.includes("private-hostile-sample"), false); assert.equal(serialized.includes("checkout"), false); assert.equal(serialized.includes("/attacker"), false);
	assert.deepEqual(resolved.data.watch.board, { version: 1, blocks: [] });
});
test("decision pickup projects only bounded structured fields and uses a separate classifier cap", async () => {
	const f = fixture({ decision: true }); const resolved = await f.runtime.resolve(f.ref, "gate1");
	assert.equal(resolved.data.watch.stage, "decision"); assert.equal(resolved.data.maxCostUsd, "0.001");
	assert.equal(resolved.data.watch.gate.state.service, "checkout"); assert.equal(resolved.data.watch.gate.state.samples, undefined);
	assert.ok(resolved.data.models.includes("openrouter/typesafe/jev-1.13"));
	assert.equal(JSON.stringify(resolved.data).includes("private-hostile-sample"), false);
});
test("expired evidence, threshold, removed rules and forged references refuse before paid work", async () => {
	for (const status of ["missing", "held", "below-threshold"]) {
		const f = fixture({ storeOverrides: { async takeFinding() { return { status }; } } });
		assert.equal((await f.runtime.resolve(f.ref, "run1")).result.outcome, "policy"); assert.equal(f.changes.length, 0);
	}
	const f = fixture(); assert.equal((await f.runtime.resolve({ kind: "watch", watch: { ...f.ref.watch, findingId: "bad" } }, "run1")).result.reason, "watch-reference-invalid");
	writeFileSync(f.triggersPath, JSON.stringify({ triggers: [] })); assert.equal((await f.runtime.resolve(f.ref, "run1")).result.reason, "watch-config-changed");
});
test("failed decision is collected as a single human fallback; collector faults never throw paid work into retry", async () => {
	const f = fixture({ decision: true }); const resolved = await f.runtime.resolve(f.ref, "gate1");
	await f.runtime.collect({ job: resolved.data, prepared: { outboxDir: f.outboxDir }, completed: false });
	assert.equal(f.queued.length, 1); assert.equal(f.changes.at(-1).decision.action, "file_issue");
	const broken = fixture({ decision: true, storeOverrides: { async appendTrace() { throw new Error("private"); } } });
	// Admission infrastructure errors throw; collecting an already-paid attempt is deliberately different.
	await assert.rejects(broken.runtime.resolve(broken.ref, "gate1"));
	await assert.doesNotReject(broken.runtime.collect({ job: resolved.data, prepared: { outboxDir: broken.outboxDir }, completed: false }));
});
test("issue mode publishes only to the reviewed target and never creates a paid action job", async () => {
	let seen; const f = fixture({ mode: "issue", publishIssue: async (args) => { seen = args; return { status: "created" }; } });
	const resolved = await f.runtime.resolve(f.ref, "issue1");
	assert.equal(resolved.result.outcome, "completed"); assert.deepEqual(seen.target, { kind: "github", repo: "acme/shop" }); assert.equal(f.queued.length, 0);
});
test("outbox reader refuses links, oversized files and invalid paths with a bounded read", () => {
	const root = tempDir("pi-watch-output-"); const file = join(root, "data"); writeFileSync(file, "1234");
	assert.equal(readWatchOutput(file, 4), "1234"); assert.equal(readWatchOutput(file, 3), null);
	const link = join(root, "link"); symlinkSync(file, link); assert.equal(readWatchOutput(link, 10), null); assert.equal(readWatchOutput(join(root, "absent"), 10), null);
});

test("a paused issue target defers before publication or private evidence reads", async () => {
	let target;
	const f = fixture({ mode: "issue", pauseUntil: (job, at) => { target = job; return at + 60000; }, publishIssue: async () => assert.fail("paused publication"), storeOverrides: { async takeFinding() { assert.fail("paused evidence read"); } } });
	assert.deepEqual(await f.runtime.resolve(f.ref, "issue1"), { deferUntil: 1793232060000 });
	assert.deepEqual(target, { kind: "github", repo: "acme/shop" });
});

test("unsafe board output is a visible refusal while the completed paid job stays completed", async () => {
	for (const kind of ["oversize", "symlink", "invalid"]) {
		const f = fixture(); const resolved = await f.runtime.resolve(f.ref, "run1");
		const path = join(f.outboxDir, "board.json");
		if (kind === "oversize") writeFileSync(path, "x".repeat(16385));
		else if (kind === "symlink") { const target = join(f.outboxDir, "elsewhere"); writeFileSync(target, "{}"); symlinkSync(target, path); }
		else writeFileSync(path, "{not json}");
		await f.runtime.collect({ job: resolved.data, prepared: { outboxDir: f.outboxDir }, completed: true });
		assert.ok(f.traces.some(e => e.kind === "board" && e.status === (kind === "oversize" ? "watch-board-oversize" : "watch-board-invalid")));
		assert.equal(f.changes.at(-1).status, "completed");
	}
});

test("malformed trace output is reported as unavailable and cannot supply board provenance", async () => {
	const f = fixture(); const resolved = await f.runtime.resolve(f.ref, "run1");
	writeFileSync(join(f.outboxDir, "watch-trace.jsonl"), "not json\n");
	await f.runtime.collect({ job: resolved.data, prepared: { outboxDir: f.outboxDir }, completed: true });
	assert.equal(f.changes.at(-1).reason, "watch-trace-unavailable");
});

test("private trace state is scrubbed with the actual container credentials before persistence", async () => {
	const f = fixture(); const resolved = await f.runtime.resolve(f.ref, "run1");
	writeFileSync(join(f.outboxDir, "watch-trace.jsonl"), JSON.stringify({ id: "watch-1", kind: "decide", status: "started", state: { credential: "private-provider-credential" }, questions: { x: "private-provider-credential" } }) + "\n");
	await f.runtime.collect({ job: resolved.data, prepared: { outboxDir: f.outboxDir, watchRedact: makeRedactor({ values: ["private-provider-credential"] }) }, completed: true });
	assert.equal(JSON.stringify(f.traces).includes("private-provider-credential"), false);
	assert.ok(JSON.stringify(f.traces).includes("redacted"));
});

test("a classifier policy refusal is distinguished from a failed answer and retains its known zero cost", async () => {
	const f = fixture({ decision: true }); const resolved = await f.runtime.resolve(f.ref, "gate1");
	await f.runtime.collect({ job: resolved.data, prepared: { outboxDir: f.outboxDir }, completed: false, policyRefused: true, usage: { costUsd: 0 } });
	assert.ok(f.changes.some(change => change.reason === "decide-refused"));
	assert.equal(f.changes.find(change => change.decision)?.decision.costUsd, 0);
});

test("a gate deferred before container start remains a decision on its next pickup", async () => {
	const f = fixture({ decision: true });
	const first = await f.runtime.resolve(f.ref, "gate1");
	assert.equal(f.changes.at(-1).status, "decision-pending");
	const persisted = JSON.parse(JSON.stringify(first.data));
	const deferred = await f.runtime.resolve(persisted, "gate1");
	assert.equal(deferred.data.watch.stage, "decision");
	assert.equal(f.handoffs.length, 0);
	await f.runtime.started(deferred.data);
	assert.equal(f.changes.at(-1).status, "deciding");
	assert.equal(f.handoffs.length, 1);
	assert.ok(f.handoffs[0].dueAt > 1793232000000);
	assert.ok(deferred.data.models.includes("anthropic/claude-sonnet-4-5-20250929"));
});
test("decision summary and durable action handoff survive a transient enqueue failure without paid retry", async () => {
	const f = fixture({ decision: true, onEnqueue: async () => { throw new Error("queue unavailable"); } });
	const resolved = await f.runtime.resolve(f.ref, "gate1");
	writeFileSync(join(f.outboxDir, "decision.json"), JSON.stringify({ version: 1, stopReason: "stop", answers: { act: { type: "choice", choice: "ignore", probabilities: { investigate: 0.02, ignore: 0.95, file_issue: 0.03 }, confidence: 0.9 } } }));
	await assert.doesNotReject(f.runtime.collect({ job: resolved.data, prepared: { outboxDir: f.outboxDir }, completed: true }));
	assert.equal(f.handoffs.length, 1);
	assert.equal(f.changes.find((change) => change.status === "decided").decision.action, "ignore");
});
test("trace append failure preserves a valid decision and action handoff and names lost evidence", async () => {
	let broken = false;
	const f = fixture({ decision: true, storeOverrides: { async appendTrace() { if (broken) throw new Error("trace unavailable"); } } });
	const resolved = await f.runtime.resolve(f.ref, "gate1");
	writeFileSync(join(f.outboxDir, "watch-trace.jsonl"), JSON.stringify({ id: "watch-1", kind: "decide", status: "started" }) + "\n");
	writeFileSync(join(f.outboxDir, "decision.json"), JSON.stringify({ stopReason: "stop", answers: { act: { type: "choice", choice: "investigate", probabilities: { investigate: 0.8, ignore: 0.1, file_issue: 0.1 }, confidence: 0.9 } } }));
	broken = true;
	await f.runtime.collect({ job: resolved.data, prepared: { outboxDir: f.outboxDir }, completed: true });
	assert.equal(f.queued.length, 1); assert.equal(f.handoffs.length, 1);
	assert.equal(f.changes.find((change) => change.status === "decided").decision.action, "investigate");
	assert.equal(f.changes.at(-1).reason, "watch-trace-unavailable");
});
test("durable handoff drain retries queue delivery, never the paid decision", async () => {
	const f = fixture();
	await f.store.scheduleAction(findingId, "shop", 123);
	await f.runtime.drain();
	assert.equal(f.queued.length, 1); assert.deepEqual(f.queued[0][1], { phase: "action" });
	assert.equal(f.changes.length, 0);
});
