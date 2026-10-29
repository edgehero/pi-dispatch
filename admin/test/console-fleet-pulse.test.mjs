import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as fleet from "../src/console/panels/fleet.mjs";
import * as host from "../src/console/panels/host.mjs";
import * as venue from "../src/console/panels/venue.mjs";
import { venuesView } from "../src/read-model.mjs";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const base = () => ({
  queue: {
    workers: 1,
    counts: { waiting: 3, active: 1, delayed: 2, failed: 1 },
  },
  queueCounts: [
    { queue: "pi-jobs", paused: false, counts: { waiting: 1 } },
    { queue: "pi-jobs@build3", paused: true, counts: { waiting: 2 } },
  ],
  active: [],
  held: { rows: [] },
  failed: { rows: [] },
  waiting: { rows: [] },
  hostBudgets: [],
  schedulers: [],
  doctor: { hosts: [] },
});
const view = (snapshot = base(), role = "operator", extra = {}) => ({
  now: NOW,
  role,
  readOnly: false,
  query: { name: "build3" },
  data: { snapshot },
  ...extra,
});
const draw = (fn, v) =>
  String(fn(v)).replace(/\s+/g, " ").replace(/> </g, "><");
const row = () => ({
  name: "build3",
  concurrency: "3",
  staleMs: 1000,
  jobs: [],
  budgetMemMiB: "24576",
  usedMemMiB: "8192",
  budgetCpuCenti: "1200",
  usedCpuCenti: "400",
  sandboxRetentionHours: 24,
  backends: {
    blessed: ["local", "podman", "openshell", "openshell-bind"],
    default: "podman",
    floor: {},
  },
});

test("Fleet's part-paused bar names both sets of queues and puts its switches only there", () => {
  const v = view();
  const bar = draw(fleet.fleetBar, v);
  assert.match(bar, /Part paused/);
  assert.match(bar, /Starts nothing new: pi-jobs@build3/);
  assert.match(bar, /Keeps starting jobs: pi-jobs/);
  assert.match(bar, /data-action="fleet-pause"/);
  assert.match(bar, /data-action="fleet-resume"/);
  assert.doesNotMatch(draw(fleet.fleetQueues, v), /data-action="fleet-/);
  assert.match(bar, /btn--danger/);
  assert.match(bar, /btn--paid/);
});

test("Fleet bar does not expose switches to viewers or on a read-only console", () => {
  for (const v of [
    view(base(), "viewer"),
    view(base(), "operator", { readOnly: true }),
  ]) {
    assert.doesNotMatch(draw(fleet.fleetBar, v), /data-action=/);
  }
});

test("Two-Valkey notice is visible without a preview, and its command remains operator-only", () => {
  for (const role of ["viewer", "operator"]) {
    const v = view(base(), role);
    v.data.killSwitch = {
      disagreement: "The deployment and console read different Valkeys.",
      resumeCommand: "pi-dispatch resume --valkey-url redis://deployment:6379",
      resumeArgv: [
        "pi-dispatch",
        "resume",
        "--valkey-url",
        "redis://deployment:6379",
      ],
    };
    const out = draw(fleet.fleetBar, v);
    assert.match(out, /Two Valkeys/);
    assert.match(out, /Nothing was changed/);
    assert.match(out, /One queue can still be resumed/);
    assert.equal(out.includes("--valkey-url"), role === "operator");
  }
});

test("active jobs show registry projects and progress while targets await the run record", () => {
  const s = base();
  s.active = [
    {
      jobId: "gh-1",
      project: "web",
      host: "build3",
      startedAt: NOW - 1000,
      progress: null,
    },
    {
      jobId: "gh-2",
      startedAt: NOW - 2000,
      progress: { turn: 3, phase: { count: 2, index: 1 } },
    },
  ];
  const out = draw(fleet.fleetActive, view(s));
  assert.match(out, /ptag/);
  assert.match(out, /shown when the run ends/);
  assert.match(out, /This worker reports no progress/);
  assert.match(out, /aria-label="Run phases"/);
  assert.match(out, /turn 3/);
});

test("orphans render separately from active jobs and Free the slot is a host link", () => {
  const s = base();
  s.hostBudgets = [
    {
      ...row(),
      jobs: [
        {
          id: "gh-orphan",
          o: true,
          p: "web",
          s: NOW - 2000,
          m: 8192,
          c: 400,
          v: "podman",
        },
      ],
    },
  ];
  const out = draw(fleet.fleetActive, view(s));
  assert.match(out, /row--attention/);
  assert.match(out, /still holds a build3 slot/);
  assert.match(out, /href="\/fleet\/host\?name=build3#p-hostsandboxes"/);
  assert.doesNotMatch(out, /data-action="free/);
});

test("held jobs sort longest first and report every condition with a bounded check count", () => {
  const s = base();
  s.held.rows = [
    {
      jobId: "gh-short",
      waitedMs: 1000,
      checks: 2,
      after: NOW + 10000,
      answers: [{ profile: "ci-green", answer: "fault", at: NOW - 1000 }],
    },
    {
      jobId: "gh-long",
      waitedMs: 20000,
      checks: 14,
      after: NOW - 1000,
      answers: [{ profile: "ci-green", answer: "go", at: NOW - 1000 }],
    },
  ];
  const out = draw(fleet.fleetHeld, view(s));
  assert.ok(out.indexOf("gh-long") < out.indexOf("gh-short"));
  assert.match(out, /14 of 96/);
  assert.match(out, /in 10s/);
  assert.match(out, /fault/);
  assert.match(out, /: met/);
  const viewer = draw(fleet.fleetHeld, view(s, "viewer"));
  assert.match(viewer, /ci-green/);
  assert.doesNotMatch(viewer, /data-action=/);
});

test("delayed jobs are all listed past five and cancellation excludes started/recovery/scheduler rows", () => {
  const s = base();
  s.waiting = {
    rows: Array.from({ length: 8 }, (_, i) => ({
      jobId: `gh-${i}`,
      queue: "pi-jobs",
      bucket: "none",
      attemptsMade: i === 7 ? 1 : 0,
      stalled: 0,
    })),
    truncated: true,
  };
  const out = draw(fleet.fleetDelayed, view(s));
  assert.match(out, /gh-7/);
  assert.equal((out.match(/data-action="cancel-queued"/g) ?? []).length, 7);
  assert.match(out, /No reason was recorded/);
  assert.match(out, /Not every waiting job was read/);
  assert.match(out, /60 seconds and grows/);
});

test("failure cells distinguish a missing record from a record without reason and show known next steps", () => {
  assert.match(draw(fleet.failedWhy, { hasRecord: false }), /no record/);
  assert.match(
    draw(fleet.failedWhy, { hasRecord: true }),
    /record names no reason/,
  );
  const out = draw(fleet.failedWhy, {
    hasRecord: true,
    reason: "container-never-started",
  });
  assert.match(out, /Its run record says/);
  assert.match(out, /Next:/);
});

test("failed queue text is escaped, collapsed and exclusive to operators", () => {
  const s = base();
  s.failed.rows = [
    {
      jobId: "gh-fail",
      queue: "pi-jobs",
      hasRecord: true,
      target: "acme/web#1",
      reason: null,
      attemptsMade: 3,
      attempts: 3,
      failedReason: "PRIVATE <script>",
    },
  ];
  const out = draw(fleet.fleetFailed, view(s));
  assert.match(out, /3 of 3/);
  assert.match(out, /acme\/web#1/);
  assert.match(out, /<details>.*PRIVATE &lt;script&gt;/);
  assert.doesNotMatch(
    draw(fleet.fleetFailed, view(s, "viewer")),
    /PRIVATE|data-action=/,
  );
});

test("orphan cleanup chooses the correct runtime and hashes the actual OpenShell container name", () => {
  assert.deepEqual(host.orphanCommand({ id: "gh-1", v: "local" }), [
    "docker",
    "rm",
    "-f",
    "pi-job-gh-1",
  ]);
  assert.deepEqual(host.orphanCommand({ id: "gh-1", v: "podman" }), [
    "podman",
    "rm",
    "-f",
    "pi-job-gh-1",
  ]);
  const expected = `pi-job-s${createHash("sha256").update("pi-job-gh-1").digest("hex").slice(0, 11)}`;
  for (const v of ["openshell", "openshell-bind"])
    assert.deepEqual(host.orphanCommand({ id: "gh-1", v }), [
      "openshell",
      "sandbox",
      "delete",
      expected,
    ]);
  assert.deepEqual(
    host.orphanCommand({ id: "container:pi-job-old", v: "local" }),
    ["docker", "rm", "-f", "pi-job-old"],
  );
  assert.equal(host.orphanCommand({ id: "gh-1" }), null);
});

test("digested orphan ids get listing commands, never invented removable container names", () => {
  for (const v of ["local", "podman"])
    assert.ok(
      host.orphanCommand({ id: "sha256:0123456789abcdef", v }).includes("ps"),
    );
  assert.deepEqual(
    host.orphanCommand({ id: "sha256:0123456789abcdef", v: "openshell" }),
    [
      "openshell",
      "sandbox",
      "list",
      "--selector",
      "pi.dispatch.owner=pi-dispatch",
    ],
  );
});

test("host retention shows pin, deadline, expired pin form and venue shell refusal", () => {
  const s = base();
  const h = {
    ...row(),
    sandboxes: [
      { id: "gh-old", v: "podman", until: NOW - 1000, pin: false },
      { id: "gh-new", v: "openshell", until: NOW + 1000, pin: true },
    ],
    sandboxesMore: 2,
  };
  s.hostBudgets = [h];
  const out = draw(host.hostSandboxes, view(s));
  assert.match(out, /--pin/);
  assert.match(out, /Pinned/);
  assert.match(out, /no sandbox shell/);
  assert.match(out, /2 more retained/);
  assert.match(out, /prompt.md and event.json/);
  const viewer = draw(host.hostSandboxes, view(s, "viewer"));
  assert.doesNotMatch(viewer, /class="cmd/);
  h.sandboxRetentionHours = 0;
  assert.match(draw(host.hostSandboxes, view(s)), /Workspace retention is off/);
});

test("host orphan commands are operator-only, and Podman commands name the worker account", () => {
  const s = base();
  s.hostBudgets = [
    {
      ...row(),
      jobs: [
        {
          id: "gh-orphan",
          v: "podman",
          o: true,
          m: 8192,
          c: 400,
          s: NOW - 1000,
        },
      ],
    },
  ];
  const out = draw(host.hostSandboxes, view(s));
  assert.match(out, /8192 MiB and 4 cores/);
  assert.match(out, /worker's account/);
  assert.match(
    out,
    /podman<\/span><span>rm<\/span><span>-f<\/span><span>pi-job-gh-orphan/,
  );
  assert.doesNotMatch(draw(host.hostSandboxes, view(s, "viewer")), /podman rm/);
});

test("host budget splits running/orphan/free promises and words the published origin and CPU reserve", () => {
  const s = base();
  s.hostBudgets = [
    {
      ...row(),
      jobs: [{ id: "gh-orphan", o: true, m: 4096, c: 200 }],
      budgetFrom: {
        memMode: "auto",
        cpuMode: "value",
        memTotalMiB: 28672,
        memReserveMiB: 4096,
      },
      cpuReserve: [{ venue: "podman", status: "held" }],
    },
  ];
  const out = draw(host.hostBudget, view(s));
  assert.match(out, /fill="url\(#hatch\)"/);
  assert.match(out, /4 held by orphans, 16 free/);
  assert.match(out, /machine&#39;s 28 less a 4 reserve/);
  assert.match(out, /cores explicitly set/);
  assert.match(out, /pidispatch.slice/);
});

test("gone and unknown hosts state missing registry and history without inventing health", () => {
  const v = view();
  assert.match(draw(host.hostState, v), /no live registry row/);
  assert.match(draw(host.hostRow, v), /No retained run record/);
  assert.doesNotMatch(draw(host.hostState, v), /data-action=/);
});

test("host fingerprints compare actual registry fields and queue names use the worker's routing contract", () => {
  const s = base();
  s.hostBudgets = [
    {
      ...row(),
      fpCron: "abc",
      fpUsd: "def",
      fpProjects: "ghi",
      fpEnvelope: "jkl",
    },
    { name: "peer", fpCron: "other" },
  ];
  const out = draw(host.hostRow, view(s));
  assert.match(out, /pi-jobs@build3/);
  assert.match(out, /triggers: abc \(differs across live hosts\)/);
});

test("host capacity draws seven-day hourly bars with peak ticks and explicit missing-history semantics", () => {
  const v = view();
  v.data.hostCapacity = {
    window: { fromMs: NOW - 3600000, toMs: NOW, bucketMs: 3600000 },
    coverage: ["Only this host's history"],
    hosts: [
      {
        name: "build3",
        slots: 3,
        facts: {
          busy: "50%",
          idle: "50%",
          missing: "10%",
          avg: "1.5",
          peak: 2,
          slots: 3,
          projects: ["web 2h"],
        },
        buckets: [
          {
            fromMs: NOW - 3600000,
            coveredMs: 1800000,
            avgMilli: 1500,
            peak: 2,
          },
        ],
      },
    ],
  };
  const out = draw(host.hostCapacity, v);
  assert.match(out, /50%, 50%, 10%/);
  assert.match(out, /stroke-dasharray="4 3"/);
  assert.match(out, /hatched no-history/);
  assert.match(out, /web 2h/);
  assert.match(
    out,
    /capacity<\/span><span>--host<\/span><span>build3<\/span><span>--since<\/span><span>7d/,
  );
});

test("each venue shows all properties, a highlighted comparison, serving and gateway explanations", () => {
  const s = base();
  s.hostBudgets = [row()];
  const m = venuesView(s.hostBudgets);
  for (const x of m.venues) {
    const v = view(s, "viewer", { query: { name: x.name } });
    const properties = draw(venue.venueProperties, v);
    for (const p of x.properties)
      assert.ok(properties.includes(p.property), `${x.name}: ${p.property}`);
    assert.match(
      draw(venue.venueCompare, v),
      new RegExp(`${x.name} \\(this venue\\)`),
    );
    assert.match(draw(venue.venueServes, v), /what the venue can do/);
    assert.doesNotMatch(draw(venue.venueSummary, v), /data-action=/);
    assert.match(
      draw(venue.venueHosts, v),
      x.name.startsWith("openshell") ? /not published/ : /runs no gateway/,
    );
  }
});

test("renderers escape peer-published text and never emit inline style/script or event handlers", () => {
  const s = base();
  s.hostBudgets = [
    { ...row(), version: '<img onerror="x">', sandboxes: [], cpuReserve: [] },
  ];
  for (const fn of [
    ...Object.values(fleet).filter(
      (fn) => typeof fn === "function" && fn !== fleet.failedWhy,
    ),
    ...[
      host.hostState,
      host.hostBudget,
      host.hostRow,
      host.hostSandboxes,
      host.hostDoctor,
    ],
    ...Object.values(venue),
  ]) {
    const out = draw(fn, view(s));
    assert.doesNotMatch(
      out,
      /<script|<[^>]+\sstyle=|<[^>]+\son[a-z]+=/i,
      fn.name,
    );
  }
  assert.match(draw(host.hostRow, view(s)), /&lt;img onerror=/);
});

test("orphan commands preserve seeded sandbox names and sanitize scheduled container ids", () => {
  assert.deepEqual(
    host.orphanCommand({ id: "container:pi-job-s123456789ab", v: "openshell" }),
    ["openshell", "sandbox", "delete", "pi-job-s123456789ab"],
  );
  assert.deepEqual(
    host.orphanCommand({ id: "repeat:nightly:123", v: "podman" }),
    ["podman", "rm", "-f", "pi-job-repeat_nightly_123"],
  );
  const expected = `pi-job-s${createHash("sha256").update("pi-job-repeat_nightly_123").digest("hex").slice(0, 11)}`;
  assert.deepEqual(
    host.orphanCommand({ id: "repeat:nightly:123", v: "openshell-bind" }),
    ["openshell", "sandbox", "delete", expected],
  );
});

test("unpublished budgets, sandbox lists and truncated slots never become zero or free", () => {
  assert.match(
    host.budgetOriginText({
      memMode: "auto",
      cpuMode: "value",
      memTotalMiB: null,
      memReserveMiB: null,
    }),
    /unknown less a unknown reserve/,
  );
  const s = base();
  s.hostBudgets = [{ ...row(), sandboxes: null, jobsMore: 2 }];
  assert.match(
    draw(host.hostSandboxes, view(s)),
    /unreadable or was not published/,
  );
  assert.match(draw(host.hostBudget, view(s)), /Free slots are not known/);
  assert.match(draw(fleet.fleetHosts, view(s)), /Free slots not known/);
});

test("a healthy host has no state warning and a host without routing has no invented pause queue", () => {
  const s = base();
  s.hostBudgets = [row()];
  assert.equal(draw(host.hostState, view(s)), "");
  s.hostBudgets[0].staleMs = 180000;
  s.hostBudgets[0].routes = false;
  const out = draw(host.hostState, view(s));
  assert.match(out, /still takes shared jobs/);
  assert.doesNotMatch(out, /data-action=/);
  assert.doesNotMatch(draw(host.hostRow, view(s)), /pi-jobs@build3/);
});

test("host jobs show actual sizes, project rules and queue action schemas", () => {
  const s = base();
  s.hostBudgets = [
    { ...row(), jobs: [{ id: "gh-active", p: "web", m: 8192, c: 400 }] },
  ];
  s.active = [
    {
      jobId: "gh-active",
      host: "build3",
      project: "web",
      size: { memMiB: 8192, cpuCenti: 400 },
    },
  ];
  s.waiting.rows = [
    {
      jobId: "gh-wait",
      queuedAt: NOW - 3 * 60000,
      host: "build3",
      queue: "pi-jobs@build3",
      project: "web",
      attemptsMade: 0,
      stalled: 0,
      why: "host-budget",
      budgetWhy: "memory",
      size: { memMiB: 4096, cpuCenti: 200 },
    },
  ];
  s.scopedLimits = {
    limits: [{ scope: "project:web", hostShare: 50, minJobs: 2 }],
  };
  const out = draw(host.hostJobs, view(s));
  assert.match(out, /8 GiB and 4 cores/);
  assert.match(out, /4 GiB and 2 cores/);
  assert.match(out, /data-l="How long">3m<\/td>/, "waiting age comes from the queuedAt field published by readWaiting");
  assert.match(out, /Host budget \(memory\)/);
  assert.match(out, /keeps its place/);
  assert.match(draw(host.hostBudget, view(s)), /hostShare 50%, minJobs 2/);
  const activeForm =
    /<form[^>]*data-action="cancel-active"[^>]*>(.*?)<\/form>/.exec(out)[1];
  assert.doesNotMatch(activeForm, /name="queue"/);
});

test("an absent progress projection draws stripes and held answer words follow the worker vocabulary", () => {
  const s = base();
  s.active = [{ jobId: "gh-no-stream", progress: { absent: true } }];
  assert.match(
    draw(fleet.fleetActive, view(s)),
    /This worker reports no progress/,
  );
  s.waitMaxChecks = 12;
  s.waitMaxMs = 3600000;
  s.waitMaxFaults = 3;
  s.held.rows = [
    {
      jobId: "gh-held",
      checks: 4,
      label: "after time + ci-green",
      answers: [
        { profile: "ci-green", answer: "hold" },
        { profile: "review", answer: "unclear" },
        { profile: "policy", answer: "refuse" },
      ],
    },
  ];
  const out = draw(fleet.fleetHeld, view(s, "viewer"));
  assert.match(out, /not yet/);
  assert.match(out, /refused/);
  assert.match(out, /4 of 12/);
  assert.match(out, /3 in a row ends the wait/);
  assert.match(out, /1 hours or 12 checks/);
  assert.match(out, /after time \+ ci-green/);
});

test("Fleet's comparison stays short while the venue page carries the complete declaration table", () => {
  const out = draw(fleet.fleetVenues, view());
  assert.match(out, /egress allowlist/);
  assert.match(out, /local folders in place/);
  assert.match(out, /Credentials/);
  assert.doesNotMatch(out, /agent not root|stoppable on timeout/);
  const detail = draw(
    venue.venueProperties,
    view(base(), "viewer", { query: { name: "local" } }),
  );
  assert.match(detail, /agent not root/);
});

test("host Doctor keeps every published state in a readable card with a single command", () => {
  const s = base();
  s.doctor = { hosts: [{ name: "build3", version: "4.3.1", ageMs: 72 * 3600000, every: 24, openshell: true, by: { worker: false, uid: 1002 }, workerRun: { at: NOW - 1000, uid: 1001 }, counts: { fail: 1, warn: 1, ok: 1 }, checks: [{ id: "docker.39", level: "fail", label: "Image missing", fix: "Pull the image" }, { id: "provider.key", level: "warn", label: "Provider warning", fix: "Check the key" }, { id: "env.1", level: "ok" }], more: 12 }] };
  const out = draw(host.hostDoctor, view(s));
  assert.equal((out.match(/<h2>Doctor<\/h2>/g) ?? []).length, 1);
  assert.equal((out.match(/data-copy/g) ?? []).length, 1);
  assert.match(out, /version 4.3.1/);
  assert.match(out, /openshell venue was judged/);
  assert.match(out, /Stale:/);
  assert.match(out, /uid 1001/);
  assert.match(out, /docker: failing/);
  assert.match(out, /env: passing/);
  assert.match(out, /12 more not shown/);
  assert.ok(out.indexOf("Image missing") < out.indexOf("Provider warning"));
  assert.doesNotMatch(out, /<table/);
  assert.doesNotMatch(draw(host.hostDoctor, view(s, "viewer")), /data-copy/);
  s.doctor.hosts[0] = { name: "build3", unreadable: true };
  assert.match(draw(host.hostDoctor, view(s)), /cannot be read/);
  s.doctor.hosts = [];
  assert.match(draw(host.hostDoctor, view(s)), /No doctor result published/);
});


test("occupied host slots stay a floor or unknown when the inventory is incomplete, and stale totals are named as last published", () => {
  for (const [inventory, expected] of [
    [{ jobs: [{ id: "gh-a", at: NOW - 1000, o: false }], jobsMore: 2 }, /At least 1 occupied slot is listed/],
    [{ jobs: [{ id: "gh-a", at: NOW - 1000, o: false }], jobsMore: null }, /At least 1 occupied slot is listed/],
    [{ jobs: null, jobsUnreadable: true, jobsMore: 0 }, /occupied slot count is not known/],
    [{ jobs: [{ id: "gh-a", at: NOW - 1000, o: false }], jobsMore: 0, staleMs: 180000 }, /Last published: 1 of 3 slots taken/],
  ]) {
    const s = base();
    s.hostBudgets = [{ ...row(), ...inventory }];
    const out = draw(host.hostBudget, view(s));
    assert.match(out, expected);
    assert.match(out, /Free slots are not known/);
    assert.doesNotMatch(out, /class="sls"/);
  }
  const s = base();
  s.hostBudgets = [{ ...row(), jobsMore: 0 }];
  assert.match(draw(host.hostBudget, view(s)), /0 of 3 slots taken: 0 running, 0 held by orphaned containers/);
});


test("host state shares the overview clock-skew threshold and names unread registry/jobs without inventing Valkey clock comparisons", () => {
  const s = base();
  s.hostBudgets = [{ ...row(), jobsMore: 0, ttlAgeMs: 1000, skewMs: 40000, name: "build3" }];
  let out = draw(host.hostState, view(s));
  assert.match(out, /behind this console/);
  assert.doesNotMatch(out, /differs from Valkey/);
  s.hostBudgets[0].skewMs = 1000;
  assert.equal(draw(host.hostState, view(s)), "");
  s.hostBudgets[0].jobsUnreadable = true;
  assert.match(draw(host.hostState, view(s)), /list of running jobs could not be read/);
  s.queue.fleetDegraded = "unreadable";
  out = draw(host.hostState, view(s));
  assert.match(out, /fleet as it was last seen/);
  assert.match(draw(fleet.fleetBar, view(s)), /host registry could not be read/);
  assert.match(draw(fleet.fleetHosts, view(s)), /total occupancy is not known/);
  assert.doesNotMatch(draw(fleet.fleetHosts, view(s)), /class="slot slot--free"/);
});
