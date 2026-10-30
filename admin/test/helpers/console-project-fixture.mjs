/** Populated ProjectDetail fixture shared by panel, ledger, width and browser checks (#751). */
import { projectSizeAction } from "../../src/project-view.mjs";

export function consoleProjectFixture(now) {
  if (!Number.isFinite(now)) throw new TypeError("consoleProjectFixture needs the injected page clock");
  const day = 86_400_000;
  const call = 'dispatch_limit_edit {"index":2,"memory":"4g","cpus":2}';
  return {
    id: "billing", state: "ready", now, file: "projects.json", project: { id: "billing", name: "billing" },
    members: [{ label: "github:acme/billing", local: false, count: 18, last: { jobId: "gh-e9a0", at: now - 540_000 } }, { label: "gitlab:acme/billing-ui", local: false, count: 6, last: { jobId: "gl-9a2c", at: now - 6_060_000 } }],
    memberInput: "github:acme/billing\ngitlab:acme/billing-ui", editRefusal: "Members cannot be edited while secret bundle billing names billing. Change the bundle in triggers.json first.", deleteRefusal: "Delete project billing: refused while scoped limits row 3 (project:billing) names it. Remove that row first.",
    size: { memMiB: 8192, cpuCenti: 400, source: "project", memorySource: "project row", cpuSource: "project row" },
    spend: { window: "week", settledMicros: 6_100_000, heldMicros: 2_000_000, heldKnownMicros: 2_000_000, heldIncomplete: false, usedMicros: 8_100_000, shareMicros: 25_000_000, envelope: true, floor: false },
    allocation: { window: "week", shareMicros: 25_000_000, totalMicros: 100_000_000, floorMicros: 10_000_000, weight: 3, totalWeight: 7, refused: 0, unset: false, split: { id: "3f9a1c", writer: "portfolio-job", appliedAt: new Date(now - 4 * day).toISOString(), validUntil: new Date(now + 3 * day).toISOString() } },
    sizing: {
      memory: { current: 8192, suggested: 4096, reason: "oversized" }, cpu: { current: 400, suggested: 200, reason: "underused" }, call, action: projectSizeAction(call, "billing"),
      words: { memory: "p95 peak 2g, largest 3g, over 23 runs", cpu: "p95 0.9 cores used, largest 1 core, over 23 runs", cpuFact: "the median run was held back 4% of its time by this host's CPU ceiling, which a job's cpus do not change" },
      series: Array.from({ length: 23 }, (_, index) => ({ at: now - (28 - index) * day, peakMiB: 1200 + (index * 127) % 1700, sizeMiB: 8192, oom: false })),
    },
    runs24h: { total: 10, counts: { completed: 8, failed: 0, refused: 1, cancelled: 1, "awaiting-input": 0, "awaiting-approval": 0 }, inLine: 1, inLineIncomplete: false, worst: { jobId: "gh-e9a0", host: "build3", outcome: "refused", reason: "egress-proxy-missing", reasonSentence: "the egress proxy is not running" } },
    recent: [
      { jobId: "gh-e9a0", target: "acme/billing#260", outcome: "refused", at: now - 540_000, micros: 0 },
      { jobId: "gh-ebd7", target: "acme/billing#259", outcome: "completed", at: now - 3_060_000, micros: 360_000 },
      { jobId: "gl-9a2c", target: "acme/billing-ui!405", outcome: "completed", at: now - 6_060_000, micros: 180_000 },
      { jobId: "gh-7cdf", target: "acme/billing#258", outcome: "completed", at: now - 10_260_000, micros: 400_000 },
      { jobId: "gh-4a7e", target: "acme/billing#290", outcome: "cancelled", at: now - 16_260_000, micros: 0 },
    ], totalRuns: 24,
    limits: [{ index: 2, scope: "project:billing", memory: "8g", cpus: 4 }], limitsUnreadable: false,
    bundle: { id: "billing", profile: "vault-bundle", format: "dotenv", declared: "env", optedOut: [3], forkReviews: false, last: { jobId: "gh-ebd7", at: new Date(now - 3_060_000).toISOString(), variables: ["DB_URL", "STRIPE_KEY", "SENTRY_DSN"] } },
    triggers: [{ index: 2, forge: "github", type: "comment", flow: "fix", count: 8 }, { index: 3, forge: "gitlab", type: "pull_request", flow: "review", count: 2 }],
  };
}
