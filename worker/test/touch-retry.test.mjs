import assert from "node:assert/strict";
import { test } from "node:test";
import { makeProcessor } from "../src/index.mjs";
import { buildRecord } from "../src/run-history.mjs";
import { computeZeroTouch } from "../src/zero-touch.mjs";
import { makeHeldSettle } from "../src/held-settle.mjs";
import { awaitTargetKeyOf } from "../src/held-replies.mjs";
import { enqueueForgeJob } from "../src/queue.mjs";

const DAY = 86400_000;
const NOW = Date.UTC(2026, 9, 30, 12);
const settings = () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null });

test("same-ID retries retain the prior attempt's answer evidence and gap through every terminal replacement", async () => {
	for (const bound of [false, true]) for (const terminal of ["completed", "settings", "wait", "failed"]) {
		let attempt = 0;
		let record = null;
		let reads = 0;
		const job = { id: "reply", attemptsMade: 0, opts: { attempts: 2 }, data: { kind: "github", repo: "acme/api", flow: "fix", target: { type: "issue", number: 1 }, resume: true, parkedReply: true, trigger: { deliveryId: "reply", matched: { index: 0, type: "comment", phrase: "@pi" }, comment: { body: "private answer" } } } };
		const processor = makeProcessor({
			redis: { incr: async () => 1, decr: async () => 0, expire: async () => {}, get: async () => null },
			now: () => NOW, timeoutMs: 100000,
			getSettings: () => attempt > 0 && terminal === "settings" ? { invalid: "bad overlay" } : settings(),
			previousRecord: async () => { reads++; return record; },
			recordRun: (args) => { record = buildRecord({ ...args, endedAt: new Date(NOW).toISOString(), touchTracking: true }); },
			waitState: { release: async () => {}, satisfiedBy: async () => null },
			deps: {
				sessionsDir: "/sessions", isParked: () => true,
				imagePreflight: async () => ({ ok: true, piVersion: "1.4.0" }),
				mintToken: async () => "token", isDefaultBranchProtected: async () => true,
				prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j", ...(attempt === 0 && bound ? { session: { parkedSource: { runId: "source-park", at: NOW - DAY } } } : {}) }),
				runContainer: async () => ({ code: attempt === 0 || terminal === "failed" ? 1 : 0, session: { resumed: attempt === 0 }, tokens: { cost: attempt === 0 ? 0.01 : 0.02 } }),
				cleanup: async () => {}, comment: async () => {}, log: () => {},
			},
		});
		await assert.rejects(() => processor(job, "lock", new AbortController().signal), { name: "InfraRetry" });
		assert.equal(record.touchLineageSkipped, bound ? undefined : "source-unavailable");
		assert.equal(record.touches?.[0]?.runId, bound ? "source-park" : undefined);
		attempt++;
		job.attemptsMade++;
		if (terminal === "wait") job.data.waitFor = [{ blocked: "x" }];
		if (terminal === "failed") await assert.rejects(() => processor(job, "lock", new AbortController().signal));
		else await processor(job, "lock", new AbortController().signal);
		assert.equal(reads, 1, `${bound}/${terminal}: uses the existing prior-record read only`);
		assert.equal(record.touchLineageSkipped, bound ? undefined : "source-unavailable", `${terminal}: unknown parent is not erased`);
		assert.equal(record.touches?.[0]?.runId, bound ? "source-park" : undefined, `${terminal}: known fallback is not erased`);
		assert.equal(record.outcome, terminal === "failed" ? "failed" : ["settings", "wait"].includes(terminal) ? "policy" : "completed");
		assert.equal(record.tokens?.cost ?? null, ["completed", "failed"].includes(terminal) ? 0.02 : null, "fresh attempt usage keeps its own value");
		if (!bound) {
			const report = computeZeroTouch({ records: [record], nowMs: NOW + DAY, windowDays: 7, coverage: { fromMs: NOW - 10 * DAY } });
			assert.equal(report.totals.rate, null, "a same-ID retry cannot turn an unknown intervention into zero");
		}
	}
});

// Issue #811: an id comes back after a lost queue and a hand redelivery, while the older job's record stays for the
// retention window and its touch events stay in the index. The retry's record carries none of that job's interventions,
// and the Zero touch view counts none of its events against the new run.
test("a retry under a reused id carries no touches from the older job's record, and its index events do not touch the new run (#811)", async () => {
	const olderAt = NOW - 10 * DAY;
	const data = { kind: "github", repo: "acme/api", flow: "fix", target: { type: "issue", number: 1 }, trigger: { deliveryId: "again", sender: { id: 1 } } };
	const olderTouch = { runId: "gh-again", cause: "steer", at: olderAt + 60_000 };
	// The older job's last record, at a HIGHER attempt than the retry's previous one, so it wins on attempt alone.
	const older = buildRecord({ job: { id: "gh-again", timestamp: olderAt, attemptsMade: 2, data }, result: { outcome: "failed", reason: "infra", touches: [olderTouch], touchLineageSkipped: "source-unavailable" }, startedAt: new Date(olderAt + 1000).toISOString(), endedAt: new Date(olderAt + 120_000).toISOString(), touchTracking: true });
	assert.equal(older.attempt, 3);
	let record = null;
	const processor = makeProcessor({
		redis: { incr: async () => 1, decr: async () => 0, expire: async () => {}, get: async () => null },
		now: () => NOW, timeoutMs: 100000, getSettings: settings,
		previousRecord: async (_id, { keep = null } = {}) => (typeof keep === "function" && !keep(older) ? null : older),
		recordRun: (args) => { record = buildRecord({ ...args, endedAt: new Date(NOW).toISOString(), touchTracking: true }); },
		deps: {
			mintToken: async () => "token", isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => ({ code: 0 }), cleanup: async () => {}, comment: async () => {}, log: () => {},
		},
	});
	const job = { id: "gh-again", timestamp: NOW - 3600_000, attemptsMade: 1, opts: { attempts: 2 }, data };
	assert.equal((await processor(job, "lock", new AbortController().signal)).outcome, "completed");
	assert.equal(record.touches, undefined, "the older job's interventions are not this run's");
	assert.equal(record.touchLineageSkipped, undefined, "nor its unprovable answer source");
	assert.equal(record.jobCreatedAt, new Date(NOW - 3600_000).toISOString());
	const report = computeZeroTouch({ records: [record], events: [olderTouch], nowMs: NOW + 1, windowDays: 7, coverage: { fromMs: NOW - 30 * DAY } });
	assert.deepEqual([report.totals.runs, report.totals.touched, report.totals.rate], [1, 0, 0], "the older job's steer under the same id does not touch the new run");
});

test("a held phrase reply keeps the receiver receipt through real enqueue and pickup, rather than counting queue delay as waiting", async () => {
	const parkedAt = NOW - 2 * 3600_000;
	const receipt = parkedAt - 1000;
	const fields = { kind: "github", repo: "acme/api", target: { type: "issue", number: 1 }, flow: "fix", resume: true, awaitInput: true, trigger: { deliveryId: "held-reply", matched: { index: 0, type: "comment", phrase: "@pi" }, comment: { body: "@pi receivedAt=9999999999999, private answer" } } };
	let queued;
	const queue = { name: "pi-jobs", add: async (_kind, data, options) => { queued = { id: options.jobId, data, timestamp: parkedAt + 5000, attemptsMade: 0, opts: { attempts: 1 } }; return { id: options.jobId }; } };
	const settle = makeHeldSettle({ redis: {}, queues: { shared: () => queue }, now: () => parkedAt,
		held: { awaitTargetKeyOf, closeHeld: async () => ({ first: true, entries: [{ id: "a".repeat(32), at: receipt, route: "dedup", fallback: { ...fields, replyReceivedAt: NOW } }] }) },
	});
	assert.equal((await settle.take({ job: { id: "source-park", data: fields } })).resumed, 1);
	assert.equal(queued.data.replyReceivedAt, receipt, "the trusted held entry overrides any fallback receipt field");
	assert.equal(queued.data.parkedReply, undefined, "a phrase-prefixed reply retains its ordinary routing contract");
	assert.deepEqual(queued.data.trigger, fields.trigger, "the private receipt never joins event payload data");
	let finalRecord;
	const processor = makeProcessor({
		redis: { incr: async () => 1, decr: async () => 0, expire: async () => {}, get: async () => null }, getSettings: settings, now: () => NOW, timeoutMs: 100000,
		recordRun: (args) => { finalRecord = buildRecord({ ...args, endedAt: new Date(NOW - 1).toISOString(), touchTracking: true }); },
		deps: { sessionsDir: "/sessions", mintToken: async () => "token", isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j", session: { parkedSource: { runId: "source-park", at: parkedAt } } }),
			runContainer: async () => ({ code: 0, session: { resumed: true } }), cleanup: async () => {}, comment: async () => {}, log: () => {},
		},
	});
	const result = await processor(queued, "lock", new AbortController().signal);
	assert.equal(result.outcome, "completed");
	assert.equal(finalRecord.touches.length, 1, "a phrase-prefixed exact parked-session resume is an answer too");
	assert.equal(finalRecord.touches[0].runId, "source-park");
	assert.equal(finalRecord.touches[0].receivedAt, parkedAt, "a reply received before parking ends its wait immediately");
	const source = buildRecord({ job: { id: "source-park", data: fields }, result: { outcome: "completed", reason: "awaiting-input" }, endedAt: new Date(parkedAt).toISOString(), touchTracking: true });
	const report = computeZeroTouch({ records: [source, finalRecord], nowMs: NOW, windowDays: 7, coverage: { fromMs: NOW - 8 * DAY } });
	assert.equal(report.totals.waitingHours, 0, "neither the held re-enqueue nor the later pickup extends human waiting");
	assert.equal(report.totals.touched, 1);
	for (const bad of [-1, "1000", Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(() => enqueueForgeJob(queue, "github", { ...fields, replyReceivedAt: bad }), /reply-receipt-invalid/);
});
