/** #748: exceptional Fleet, host and venue states, rendered by the production page table. */
import assert from "node:assert/strict";
import { DEFER_BUCKETS, DEFER_WHYS } from "@edgehero/pi-dispatch/defer-reasons";
import { parseHostBackends } from "@edgehero/pi-dispatch/backends";
import { NOW } from "../../../launch/fixture-deployment.mjs";
import { loadPageData, parsePageQuery, renderPage } from "../../src/console/pages.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const host = (over = {}) => ({
  name: "build3", version: "4.3.1", startedAt: String(NOW - 5 * HOUR), pid: "4242", concurrency: "3",
  image: "ghcr.io/edgehero/pi-dispatch-job:4.3.1", imageDigest: `sha256:${"a".repeat(64)}`, piVersion: "1.4.0", tz: "UTC",
  fpCron: "a".repeat(16), fpUsd: "b".repeat(16), fpProjects: "c".repeat(16), fpEnvelope: "none",
  caps: ["s:github", "w:ci-green"], staleMs: 2000, ttlAgeMs: 2000, skewMs: 0, noExpiry: false, routes: "true",
  jobs: [{ id: "gh-e802", p: "web", m: 8192, c: 400, at: NOW - 12 * MIN, o: false }, { id: "gh-4a7e", p: "billing", m: 8192, c: 400, at: NOW - 18 * MIN, o: true, v: "podman", s: NOW - 7 * MIN }], jobsMore: 0,
  budgetMemMiB: "24576", budgetCpuCenti: "1200", usedMemMiB: "16384", usedCpuCenti: "800", heldMemMiB: "8192", heldCpuCenti: "400", budgetRunning: "2", budgetOrphans: "1", budgetHolds: "1", waiters: "1", budgetSeed: "listed",
  budgetFrom: { memMode: "auto", cpuMode: "auto", memTotalMiB: 28672, memReserveMiB: 4096, memFloored: false, cpuTotalCenti: 1300, cpuReserveCenti: 100, cpuFloored: false },
  cpuReserve: [{ venue: "podman", status: "held", wantCenti: 1200, quotaCenti: 1200 }],
  backends: parseHostBackends("blessed=podman,openshell,openshell-bind;floor=nonRoot:enforced;os=podman:local"),
  sandboxes: [{ id: "gh-9575", v: "podman", until: NOW + 6 * HOUR, pin: false }, { id: "gh-pinned", v: "local", until: NOW - HOUR, pin: true }, { id: "gh-no-shell", v: "openshell", until: NOW + HOUR, pin: false }], sandboxesMore: 0, sandboxRetentionHours: 24,
  ...over,
});
const wait = (over = {}) => ({ jobId: "gh-budget", queue: "pi-jobs@build3", state: "delayed", bucket: "slot", why: "host-budget", known: true, project: "web", host: "build3", size: { memMiB: 4096, cpuCenti: 200 }, budgetWhy: "memory", queuedAt: NOW - 9 * MIN, dueAt: NOW + 9000, untilAt: NOW + 9000, recordedAt: NOW, attemptsMade: 0, stalled: 0, held: null, ...over });
const waiting = (rows, over = {}) => ({ at: NOW, rows, scheduled: [], byBucket: Object.fromEntries(DEFER_BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b).length])), byQueue: [{ queue: "pi-jobs@build3", inLine: rows.length, scheduled: 0, truncated: false }], truncated: false, ...over });
const doctor = (over = {}) => ({ name: "build3", at: NOW - HOUR, ageMs: HOUR, version: "4.3.1", every: 24, by: { uid: 1001, worker: true }, counts: { ok: 40, warn: 1, fail: 1 }, checks: [{ id: "docker.39", level: "fail", label: "The job image is missing on this host", fix: "Pull the job image on this host, then run doctor again." }, { id: "docker.40", level: "warn", label: "The CPU reserve is not held", fix: "Set the host CPU quota, then run doctor again." }, { id: "provider.key", level: "ok" }], more: 0, ...over });
const snapshot = (over = {}) => ({
  now: NOW, hostsReadAt: NOW - 2000, valkey: "redis://valkey:6379",
  queue: { pausedState: false, pausedPartial: false, counts: { waiting: 2, active: 4, delayed: 3, paused: 0, failed: 3 }, workers: 3, queues: 4 },
  queueCounts: [{ queue: "pi-jobs", paused: false, counts: { waiting: 1, active: 0, delayed: 1, paused: 0, failed: 3 } }, { queue: "pi-jobs@build3", paused: false, counts: { waiting: 1, active: 1, delayed: 2, paused: 0, failed: 0 } }, { queue: "pi-jobs@mini1", paused: false, counts: { waiting: 0, active: 2, delayed: 1, paused: 0, failed: 0 } }, { queue: "pi-jobs@mini2", paused: false, counts: { waiting: 0, active: 1, delayed: 0, paused: 0, failed: 0 } }],
  hostBudgets: [host(), host({ name: "mini1", concurrency: "4", jobs: [{ id: "gh-b3d7", p: "web", m: 4096, c: 200, at: NOW - 12 * MIN, o: false }, { id: "gh-c41f", p: "web", m: 2048, c: 100, at: NOW - 41 * MIN, o: false }], budgetMemMiB: "16384", budgetCpuCenti: "800", usedMemMiB: "6144", usedCpuCenti: "300", budgetRunning: "2", budgetOrphans: "0", budgetHolds: "0", heldMemMiB: "0", heldCpuCenti: "0", waiters: "0", backends: parseHostBackends("blessed=local"), sandboxes: [], cpuReserve: [{ venue: "local", status: "held", wantCenti: 800, quotaCenti: 800 }] }), host({ name: "mini2", concurrency: "2", jobs: [{ id: "local-9e20", p: "ops", at: NOW - 6 * MIN, o: false }], budgetMemMiB: "off", budgetCpuCenti: "off", usedMemMiB: "0", usedCpuCenti: "0", budgetRunning: "1", budgetOrphans: "0", heldMemMiB: "0", heldCpuCenti: "0", waiters: "0", backends: parseHostBackends("blessed=local,openshell,openshell-bind;os=docker:local"), sandboxes: [] })], active: [{ jobId: "gh-e802", queue: "pi-jobs@build3", host: "build3", project: "web", size: { memMiB: 8192, cpuCenti: 400 }, startedAt: NOW - 12 * MIN, progress: { turn: 7, phase: { index: 1, count: 3 } } }, { jobId: "gh-b3d7", queue: "pi-jobs@mini1", host: "mini1", project: "web", startedAt: NOW - 12 * MIN, progress: { turn: 7, phase: { index: 1, count: 4 } } }, { jobId: "gh-c41f", queue: "pi-jobs@mini1", host: "mini1", project: "web", startedAt: NOW - 41 * MIN, progress: { absent: true } }, { jobId: "local-9e20", queue: "pi-jobs@mini2", host: "mini2", project: "ops", startedAt: NOW - 6 * MIN, progress: { absent: true } }],
  waiting: waiting([wait()]),
  held: { rows: [{ jobId: "gh-held", project: "web", target: "acme/web#88", label: "after 2026-10-09T03:00:00Z + ci-green", waitedMs: 25 * MIN, checks: 14, after: NOW + 3 * HOUR, answers: [{ profile: "ci-green", answer: "hold", at: NOW - MIN }] }], more: 0 },
  failed: { rows: [{ jobId: "gh-failed", queue: "pi-jobs", hasRecord: true, reason: "job-image-missing", outcome: "policy", target: "acme/web#90", attemptsMade: 3, attempts: 3, endedAt: NOW - HOUR, failedReason: "The job image is missing" }, { jobId: "gh-no-reason", queue: "pi-jobs", hasRecord: true, outcome: "failed", reason: null, target: "acme/api#12", attemptsMade: 3, attempts: 3, endedAt: NOW - 2 * HOUR }, { jobId: "gh-no-record", queue: "pi-jobs", hasRecord: false, reason: null, attemptsMade: 1, attempts: 3, endedAt: NOW - 3 * HOUR }], more: 0 },
  schedulers: [{ key: "nightly-tidy", name: "local", pattern: "0 3 * * *", next: NOW + 3 * HOUR, overdueMs: 0, project: "web" }, { key: "pm-weekly", name: "local", pattern: "0 6 * * 1", next: NOW + 3 * 24 * HOUR, overdueMs: 0, project: "ops" }], schedulerStalls: {}, schedulerStallMax: 3,
  doctor: { hosts: [doctor(), doctor({ name: "mini1", ageMs: 72 * HOUR, counts: { ok: 41, warn: 1, fail: 0 }, checks: [{ id: "env.1", level: "warn", label: "This doctor result is older than two intervals", fix: "Run doctor again on this host." }] }), doctor({ name: "mini2", counts: { ok: 43, warn: 0, fail: 0 }, checks: [{ id: "image.1", level: "ok" }] })], more: 0 }, scopedLimits: { limits: [{ scope: "project:web", hostShare: 50, minJobs: 1 }] }, projects: { projects: [{ id: "web", hostShare: 50, minJobs: 1, members: ["github:acme/web"] }] },
  triggers: { triggers: [{ type: "cron", id: "nightly-tidy", folder: "/srv/web", project: "web" }] }, parked: [], settings: { overlay: {} }, ...over,
});

export const FLEET_CARD_SNAPSHOT = snapshot;

const capacity = () => ({ window: { fromMs: NOW - 7 * 24 * HOUR, toMs: NOW, bucketMs: HOUR }, truncated: false, coverage: ["History from the fleet run mirror"], hosts: [{ name: "build3", slots: 3, fromMs: NOW - 6 * 24 * HOUR, truncated: false, facts: { busy: "64%", idle: "36%", missing: "14%", avg: "1.4", peak: 3, slots: 3, full: "21%", wait: "p50 9s, p95 1m (12 runs)", memory: "memory 60% of the 24 GiB budget", cpu: "CPU 58% of the 12 core budget", cpuUsed: "42% of the host's 13 CPUs", projects: ["web 32h", "billing 14h"] }, caveats: ["1 orphaned container counted as busy"], notes: "Jobs only, not a machine utilization measurement", buckets: Array.from({ length: 168 }, (_, i) => ({ fromMs: NOW - (168 - i) * HOUR, coveredMs: i < 24 ? 0 : HOUR, busyMs: i < 24 ? 0 : 35 * MIN, fullMs: i % 9 ? 0 : 10 * MIN, peak: i < 24 ? 0 : 1 + i % 3, avgMilli: i < 24 ? 0 : 500 + i % 4 * 500 })) }] });

async function draw(page, { role = "operator", name = "build3", snap = snapshot(), plan = null, history = [], readOnly = false, cap = capacity() } = {}) {
  const parsed = parsePageQuery(page, page === "fleet" ? "" : new URLSearchParams({ name }));
  assert.ok(parsed.query, parsed.refusal);
  const data = await loadPageData(page, parsed.query, { now: () => NOW, fleet: { snapshot: async () => snap, runsPage: async () => ({ runs: history, mirror: "ok", next: null }), parkedCount: async () => 0 }, killSwitchPlan: () => plan, hostCapacity: async () => cap });
  const result = await renderPage(page, { query: parsed.query, session: { name: role === "operator" ? "ops" : "watcher", role }, data, readOnly, theme: null, maxStreams: 4 });
  assert.equal(result.status, 200, `${page}/${name}`);
  return String(result.html);
}
const states = {
  "fleet-running.operator": () => draw("fleet"),
  "fleet-running.viewer": () => draw("fleet", { role: "viewer" }),
  "fleet-read-only.operator": () => draw("fleet", { readOnly: true }),
  "fleet-part-paused.operator": () => draw("fleet", { snap: snapshot({ queue: { ...snapshot().queue, pausedPartial: true }, queueCounts: snapshot().queueCounts.map((q, i) => i ? { ...q, paused: true, counts: { ...q.counts, waiting: 0, paused: 1 } } : q) }) }),
  "fleet-paused.operator": () => draw("fleet", { snap: snapshot({ queue: { ...snapshot().queue, pausedState: true }, queueCounts: snapshot().queueCounts.map((q) => ({ ...q, paused: true })) }) }),
  "fleet-two-valkeys.operator": () => draw("fleet", { plan: { disagreement: "Two Valkeys disagree: a pause reaches both; resume reaches neither until they agree.", refused: "Nothing was changed. One queue can still be resumed on the Valkey this console read it from.", resumeCommand: "pi-dispatch resume --valkey-url 'redis://deployment:6379'", resumeArgv: ["pi-dispatch", "resume", "--valkey-url", "redis://deployment:6379"] } }),
  "fleet-empty.viewer": () => draw("fleet", { role: "viewer", snap: snapshot({ hostBudgets: [], active: [], held: { rows: [], more: 0 }, failed: { rows: [], more: 0 }, schedulers: [], waiting: waiting([]), doctor: { hosts: [], more: 0 }, queue: { ...snapshot().queue, counts: { waiting: 0, active: 0, delayed: 0, failed: 0 } } }) }),
  "fleet-registry-unreadable.operator": () => draw("fleet", { snap: snapshot({ queue: { ...snapshot().queue, fleetDegraded: "registry" }, hostsReadAt: NOW - HOUR }) }),
  "fleet-truncated.operator": () => draw("fleet", { snap: snapshot({ waiting: waiting([wait()], { truncated: true }), held: { ...snapshot().held, more: 14 }, failed: { ...snapshot().failed, more: 8 } }) }),
  "fleet-all-reasons.operator": () => draw("fleet", { snap: snapshot({ waiting: waiting(Object.entries(DEFER_WHYS).map(([why, spec], i) => wait({ jobId: `gh-wait-${i}`, why, bucket: spec.bucket, budgetWhy: "memory" }))) }) }),
  "fleet-no-progress.operator": () => draw("fleet", { snap: snapshot({ active: snapshot().active.map((j) => ({ ...j, progress: { absent: true } })) }) }),
  "host-fresh.operator": () => draw("host"),
  "host-capacity-missing.operator": () => draw("host", { cap: { window: { fromMs: NOW - 7 * 24 * HOUR, toMs: NOW, bucketMs: HOUR }, hosts: [], coverage: [] } }),
  "host-capacity-truncated.operator": () => draw("host", { cap: { ...capacity(), truncated: true } }),
  "host-budget-off.operator": () => draw("host", { snap: snapshot({ hostBudgets: [host({ budgetMemMiB: "off", budgetCpuCenti: "off" })] }) }),
  "host-budget-unknown.operator": () => draw("host", { snap: snapshot({ hostBudgets: [host({ budgetMemMiB: "", budgetCpuCenti: "", budgetFrom: null, jobsUnreadable: true, jobs: null })] }) }),
  "host-budget-unseeded.operator": () => draw("host", { snap: snapshot({ hostBudgets: [host({ budgetSeed: "unlisted:podman" })] }) }),
  "host-fresh.viewer": () => draw("host", { role: "viewer" }),
  "host-stale.operator": () => draw("host", { snap: snapshot({ hostBudgets: [host({ staleMs: 3 * MIN, ttlAgeMs: 3 * MIN, skewMs: 40_000, noExpiry: true })] }) }),
  "host-gone.operator": () => draw("host", { snap: snapshot({ hostBudgets: [] }), history: [{ jobId: "gh-last", host: "build3", endedAt: new Date(NOW - HOUR).toISOString(), outcome: "completed" }] }),
  "host-unknown.viewer": () => draw("host", { role: "viewer", name: "unknown", snap: snapshot({ hostBudgets: [], doctor: { hosts: [], more: 0 } }) }),
  "host-retention-off.operator": () => draw("host", { snap: snapshot({ hostBudgets: [host({ sandboxes: [], sandboxRetentionHours: 0 })] }) }),
  "host-sandboxes-unreadable.operator": () => draw("host", { snap: snapshot({ hostBudgets: [host({ sandboxes: null, sandboxesMore: null })] }) }),
  "host-sandboxes-more.operator": () => draw("host", { snap: snapshot({ hostBudgets: [host({ sandboxesMore: 12 })] }) }),
  "host-orphan-digest.operator": () => draw("host", { snap: snapshot({ hostBudgets: [host({ jobs: [{ ...host().jobs[1], id: "sha256:0123456789abcdef" }] })] }) }),
  "host-orphan-legacy.operator": () => draw("host", { snap: snapshot({ hostBudgets: [host({ jobs: [{ ...host().jobs[1], id: "container:pi-job-old" }] })] }) }),
  "host-orphan-no-venue.operator": () => draw("host", { snap: snapshot({ hostBudgets: [host({ jobs: [{ ...host().jobs[1], v: undefined, s: undefined }] })] }) }),
  ...Object.fromEntries(["local", "podman", "openshell", "openshell-bind"].map((v) => [`host-orphan-${v}.operator`, () => draw("host", { snap: snapshot({ hostBudgets: [host({ jobs: [{ ...host().jobs[1], v }] })] }) })])),
  ...Object.fromEntries(["held", "no-parent", "unmanaged", "budget-unknown", "unreadable", "unset", "differs"].map((status) => [`host-reserve-${status}.operator`, () => draw("host", { snap: snapshot({ hostBudgets: [host({ cpuReserve: [{ venue: "podman", status, wantCenti: 1200, quotaCenti: status === "differs" ? 800 : null }] })] }) })])),
  ...Object.fromEntries(["local", "podman", "openshell", "openshell-bind"].flatMap((name) => ["operator", "viewer"].map((role) => [`venue-${name}.${role}`, () => draw("venue", { name, role })]))),
  ...Object.fromEntries(["local", "remote", "unknown"].map((word) => [`venue-gateway-${word}.operator`, () => draw("venue", { name: "openshell", snap: snapshot({ hostBudgets: [host({ backends: parseHostBackends(`blessed=openshell,openshell-bind;floor=nonRoot:enforced;os=podman:${word}`) })] }) })])),
  "venue-unpublished.operator": () => draw("venue", { name: "openshell", snap: snapshot({ hostBudgets: [host({ backends: null })] }) }),
  ...Object.fromEntries(Object.entries({ stale: doctor({ ageMs: 72 * HOUR }), manual: doctor({ by: { worker: false, uid: 1002 }, workerRun: { uid: 1001, at: NOW - 2 * HOUR } }), more: doctor({ more: 12 }), passing: doctor({ counts: { ok: 43, warn: 0, fail: 0 }, checks: [{ id: "docker.1", level: "ok" }] }), unreadable: { name: "build3", unreadable: true }, missing: null }).map(([key, d]) => [`host-doctor-${key}.operator`, () => draw("host", { snap: snapshot({ doctor: { hosts: d ? [d] : [], more: 0 } }) })])),
};
export const FLEET_PANEL_STATES = Object.freeze(Object.keys(states));
export const FLEET_DRAW = Object.freeze(states);
