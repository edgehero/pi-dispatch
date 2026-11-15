import { test } from "node:test";
import assert from "node:assert/strict";
import { supersededFailures } from "../src/read-model.mjs";

// Issue #897: a failed job the queue still keeps, whose work a later run of the same work has since completed, asks
// nothing of anyone. These pin which later run counts, and that anything the records cannot settle is not judged.

const T = Date.parse("2026-11-14T21:48:30Z");
const iso = (ms) => new Date(ms).toISOString();
/** A run record as the wide window holds one. */
const rec = (jobId, { kind = "local", target = "local:portfolio-manager", flow = null, outcome = "completed", from = 60, to = 120 } = {}) => ({
  jobId, kind, target, flow, outcome, startedAt: from === null ? null : iso(T + from * 1000), endedAt: to === null ? null : iso(T + to * 1000),
});
const failedRow = (jobId, endedAt = T) => ({ jobId, endedAt });

test("a cron trigger's failed run is superseded by a later completed run of the same trigger, hand-fired or scheduled", () => {
  const runs = [
    rec("repeat:pm-dispatch:1794693600000", { from: 30 * 60, to: 30 * 60 + 2 }),
    rec("manual:pm-dispatch:1794692940000", { from: 52, to: 54 }),
    rec("repeat:pm-dispatch:1794691800000", { outcome: "failed", from: -2, to: 0 }),
    rec("manual:pm-dispatch:1794691140000", { outcome: "failed", from: -7, to: -3 }),
  ];
  const got = supersededFailures([failedRow("repeat:pm-dispatch:1794691800000"), failedRow("manual:pm-dispatch:1794691140000", T - 3000)], runs);
  // The newest completed run stands in for both: it is the one a person would open.
  assert.deepEqual(Object.fromEntries(got), {
    "repeat:pm-dispatch:1794691800000": "repeat:pm-dispatch:1794693600000",
    "manual:pm-dispatch:1794691140000": "repeat:pm-dispatch:1794693600000",
  });
  assert.equal(supersededFailures([failedRow("repeat:other:1")], runs).size, 0, "another trigger's runs are not this one's work");
});

test("a forge run's work is its target and its flow: the same issue in any case, and a different flow is not it", () => {
  const failed = rec("gh-poll-e1", { kind: "github", target: "Acme/Web#0012", flow: "deliver", outcome: "failed", from: -60, to: 0 });
  const later = rec("gh-poll-e2", { kind: "github", target: "acme/web#12", flow: "deliver", from: 600, to: 900 });
  assert.equal(supersededFailures([failedRow("gh-poll-e1")], [later, failed]).get("gh-poll-e1"), "gh-poll-e2");
  const review = { ...later, flow: "review" };
  assert.equal(supersededFailures([failedRow("gh-poll-e1")], [review, failed]).size, 0, "a later review does not deliver the issue");
  const otherIssue = { ...later, target: "acme/web#13" };
  assert.equal(supersededFailures([failedRow("gh-poll-e1")], [otherIssue, failed]).size, 0);
  const otherForge = { ...later, kind: "gitlab" };
  assert.equal(supersededFailures([failedRow("gh-poll-e1")], [otherForge, failed]).size, 0);
  const noFlow = { ...failed, flow: null };
  assert.equal(supersededFailures([failedRow("gh-poll-e1")], [{ ...later, flow: null }, noFlow]).get("gh-poll-e1"), "gh-poll-e2", "no flow on both is the same work");
});

test("only a later run that COMPLETED and STARTED after the failure ended stands in for it", () => {
  const job = "repeat:nightly:1";
  for (const outcome of ["failed", "policy", "aborted", "awaiting-input", null]) {
    assert.equal(supersededFailures([failedRow(job)], [rec("repeat:nightly:2", { outcome, from: 60 })]).size, 0, String(outcome));
  }
  // A run that started before the failure ended can be its sibling or an attempt of its own, never the work done since.
  assert.equal(supersededFailures([failedRow(job)], [rec("repeat:nightly:2", { from: -10, to: 300 })]).size, 0);
  assert.equal(supersededFailures([failedRow(job)], [rec("repeat:nightly:2", { from: 0, to: 300 })]).size, 0, "the same instant is not after");
  assert.equal(supersededFailures([failedRow(job)], [rec("repeat:nightly:2", { from: null, to: 300 })]).size, 0, "no start, no judgement");
  assert.equal(supersededFailures([failedRow(job)], [rec(job, { from: 60 })]).size, 0, "the job itself never supersedes itself");
});

test("what the records cannot settle is not judged, and keeps asking", () => {
  const later = rec("gh-poll-e2", { kind: "github", target: "acme/web#12", flow: "deliver", from: 600 });
  // A forge job's target and flow are its own record's: without it in the window there is nothing to compare.
  assert.equal(supersededFailures([failedRow("gh-poll-e1")], [later]).size, 0);
  // A local `run --task` is its own prompt's work, never another run's.
  assert.equal(supersededFailures([failedRow("local-ab12")], [rec("local-ab12", { outcome: "failed", from: -5, to: 0 }), rec("local-cd34", { from: 60 })]).size, 0);
  // Its end: the queue's finishedOn, else its record's; with neither, not judged.
  const own = rec("gh-poll-e1", { kind: "github", target: "acme/web#12", flow: "deliver", outcome: "failed", from: -60, to: 0 });
  assert.equal(supersededFailures([{ jobId: "gh-poll-e1", endedAt: 0 }], [later, own]).get("gh-poll-e1"), "gh-poll-e2", "a missing finishedOn falls back to the record");
  assert.equal(supersededFailures([{ jobId: "gh-poll-e1" }], [later, { ...own, endedAt: null }]).size, 0);
  // A record a newer release wrote is cut to its core, which has no target or flow: it supersedes no forge job.
  const core = { jobId: "gh-poll-e3", kind: "github", outcome: "completed", startedAt: iso(T + 600_000), endedAt: iso(T + 900_000), v: 99 };
  assert.equal(supersededFailures([failedRow("gh-poll-e1")], [core, own]).size, 0);
  // Not a run id, not an array: nothing, never a throw.
  assert.equal(supersededFailures([failedRow("<script>"), { jobId: 7 }, null], [rec("repeat:a:1", { from: 60 })]).size, 0);
  assert.equal(supersededFailures(null, null).size, 0);
  assert.equal(supersededFailures([failedRow("repeat:a:1")], [{ ...rec("<x>", { from: 60 }) }]).size, 0, "a later record without a run id is no run");
});

test("the snapshot's failed rows carry it end to end: read off the run records beside the queue, null where the records cannot settle it", async () => {
  const { createFleetReader } = await import("../src/read-model.mjs");
  const { tempDir } = await import("./helpers/temp-dir.mjs");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const logsDir = tempDir("superseded-");
  const write = (r) => writeFileSync(join(logsDir, `${r.jobId.replace(/:/g, "_")}.json`), JSON.stringify({ v: 1, ...r }));
  write(rec("gh-poll-e1", { kind: "github", target: "acme/web#12", flow: "deliver", outcome: "failed", from: -60, to: 0 }));
  write(rec("gh-poll-e2", { kind: "github", target: "acme/web#12", flow: "deliver", from: 600, to: 900 }));
  write(rec("gh-poll-e3", { kind: "github", target: "acme/web#13", flow: "deliver", outcome: "failed", from: -60, to: 0 }));
  const failed = [{ id: "gh-poll-e1", attemptsMade: 2, failedReason: "x", finishedOn: T }, { id: "gh-poll-e3", attemptsMade: 2, failedReason: "y", finishedOn: T }];
  const queue = { name: "pi-jobs", async isPaused() { return false; }, async getJobCounts() { return { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 2 }; }, async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { return []; }, async getFailed() { return failed; }, async close() {} };
  const redis = { async get() { return "0"; }, async hgetall() { return {}; }, async smembers() { return []; }, on() {}, disconnect() {} };
  const fleet = createFleetReader({ valkeyUrl: "redis://x", logsDir }, { makeQueueFn: () => queue, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [], nowFn: () => T + 3_600_000, readOnly: true });
  try {
    const snap = await fleet.snapshot();
    const by = Object.fromEntries(snap.failed.rows.map((r) => [r.jobId, r.supersededBy]));
    assert.deepEqual(by, { "gh-poll-e1": "gh-poll-e2", "gh-poll-e3": null });
    // The reader's own method, for a bulk Retry's preview, answers from the same window.
    assert.deepEqual(Object.fromEntries(await fleet.supersededOf([{ jobId: "gh-poll-e1", endedAt: T }, { jobId: "gh-poll-e3", endedAt: T }])), { "gh-poll-e1": "gh-poll-e2" });
  } finally {
    await fleet.dispose();
  }
});
