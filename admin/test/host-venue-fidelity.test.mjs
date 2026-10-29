import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  hostBudget,
  hostJobs,
  hostSandboxes,
  hostCapacity,
  hostDoctor,
  hostRow,
  hostState,
} from "../src/console/panels/host.mjs";
import {
  venueProperties,
  venueServes,
  venueCompare,
  venueSummary,
} from "../src/console/panels/venue.mjs";
import {
  hostBackendsField,
  parseHostBackends,
} from "@edgehero/pi-dispatch/backends";
import {
  HOST_DETAIL_CSS,
  VENUE_DETAIL_CSS,
} from "../src/console/host-venue-css.mjs";

const AT = Date.UTC(2026, 9, 29, 12);
const HOUR = 3600000;
const host = (extra = {}) => ({
  name: "build3",
  concurrency: "3",
  staleMs: 1000,
  jobsMore: 0,
  jobs: [
    { id: "gh-run", p: "web", m: 4096, c: 200, at: AT - HOUR },
    { id: "gh-orphan", p: "web", m: 4096, c: 200, at: AT - HOUR, o: true },
  ],
  budgetMemMiB: "16384",
  usedMemMiB: "8192",
  budgetCpuCenti: "800",
  usedCpuCenti: "400",
  budgetSeed: "listed",
  waiters: "1",
  ...extra,
});
const view = (extra = {}) => ({
  now: AT,
  role: "operator",
  readOnly: false,
  query: { name: "build3" },
  data: { snapshot: { hostBudgets: [host()], waiting: { rows: [] } } },
  ...extra,
});
const draw = (fn, v) => String(fn(v)).replace(/\s+/g, " ");
const capacity = () => ({
  window: { fromMs: AT - 2 * HOUR, toMs: AT, bucketMs: HOUR },
  coverage: [],
  hosts: [
    {
      name: "build3",
      slots: 3,
      fromMs: AT - 1.5 * HOUR,
      facts: {
        busy: "50%",
        idle: "50%",
        missing: "50%",
        avg: "1.5",
        peak: 3,
        slots: 3,
        full: "20%",
        wait: "p50 10s, p95 2m (4 runs)",
        memory: "memory 50%",
        cpu: "CPU 50%",
        cpuUsed: "25%",
        projects: ["web 1h"],
      },
      buckets: [0, 1].map((n) => ({
        fromMs: AT - (2 - n) * HOUR,
        coveredMs: HOUR / 2,
        busyMs: HOUR / 4,
        avgMilli: 1500,
        peak: 3,
      })),
    },
  ],
});

test("Host capacity uses six design KPI tiles and a single full-window denominator for busy, idle and missing history", () => {
  const v = view();
  v.data.hostCapacity = capacity();
  const out = draw(hostCapacity, v);
  const tiles = /<div class="hd-kpis">(.*?)<\/div><\/div>/.exec(out)?.[1];
  assert.ok(tiles, "the design's KPI strip is rendered");
  const values = [...tiles.matchAll(/<b>(.*?)<\/b>/g)].map((m) => m[1]);
  assert.deepEqual(values, ["25%", "25%", "50%", "1.5", "20%", "2m"]);
  assert.match(out, /busy in the full window/);
  assert.match(out, /where history is known/);
  assert.match(out, /p50 10s/);
});

test("Host chart labels its dated axes, peak ticks, slot ceiling and no-history legend, with coverage on the correct side of a partial bucket", () => {
  const v = view();
  v.data.hostCapacity = capacity();
  const out = draw(hostCapacity, v);
  assert.match(out, /class="hd-chart"/);
  assert.match(out, /class="hd-axis"/);
  assert.equal(
    (out.match(/text class="hd-tick"[^>]*y="143"/g) ?? []).length,
    7,
  );
  assert.match(out, />10-29<\/text>/);
  assert.match(out, /class="hd-peak"/);
  assert.match(out, /class="hd-slotline"/);
  assert.match(out, />3 slots<\/text>/);
  assert.match(out, /rect x="182\.0" y="24" width="150\.0"/);
  assert.match(out, /coverage begins 2026-10-29T10:30/);
  for (const word of [
    "jobs at once, on average",
    "the most at once",
    "no history: neither busy nor idle",
  ])
    assert.ok(out.includes(word), word);
  assert.doesNotMatch(out, /(?:NaN|Infinity)/);
});

test("No-history buckets have no invented zero-load bar or peak, and an unread report remains an explicit absence", () => {
  const v = view();
  v.data.hostCapacity = capacity();
  v.data.hostCapacity.hosts[0].buckets.forEach((b) =>
    Object.assign(b, { coveredMs: 0, busyMs: 0 }),
  );
  const out = draw(hostCapacity, v);
  assert.doesNotMatch(out, /class="hd-bar"/);
  assert.doesNotMatch(out, /class="hd-peak"/);
  assert.match(out, /no history, neither busy nor idle/);
  v.data.hostCapacity = { unreachable: "no report" };
  assert.match(draw(hostCapacity, v), /capacity history could not be read/);
});

test("Host budget uses large slot markers, split design meters, a visible legend and real waiter and runtime facts", () => {
  const v = view();
  v.data.snapshot.hostBudgets = [
    host({
      cpuReserve: [
        { venue: "podman", status: "differs", wantCenti: 800, quotaCenti: 400 },
      ],
    }),
  ];
  v.data.snapshot.waiting.rows = [
    {
      jobId: "gh-budget",
      host: "build3",
      why: "host-budget",
      project: "web",
      budgetWhy: "memory",
      size: { memMiB: 4096, cpuCenti: 200 },
    },
  ];
  const out = draw(hostBudget, v);
  assert.match(out, /class="hd-slots hd-sls"/);
  assert.equal((out.match(/class="hd-bud"/g) ?? []).length, 2);
  assert.match(out, /class="hd-held"/);
  assert.match(out, /fill="url\(#hatch\)"/);
  for (const text of [
    "promised to running jobs",
    "held by an orphaned container",
    "gh-budget",
    "4 GiB and 2 cores",
    "Wanted 8 cores",
    "Observed quota 4 cores",
    "Listed: the worker counted",
  ])
    assert.ok(out.includes(text), text);
  assert.doesNotMatch(out, /&quot;listed&quot;/);
  v.data.snapshot.hostBudgets[0].jobsMore = null;
  const unknown = draw(hostBudget, v);
  assert.match(unknown, /orphan split not known/);
  assert.doesNotMatch(unknown, /class="hd-held"/);
});

const venueView = () =>
  view({
    query: { name: "openshell" },
    data: {
      snapshot: {
        hostBudgets: [
          {
            name: "build3",
            backends: parseHostBackends(
              hostBackendsField({
                backends: ["local", "openshell"],
                backendFloor: { credentialTransit: "enforced" },
                openshellEngine: "docker",
                gatewayWord: "remote",
              }),
            ),
          },
        ],
      },
    },
  });

test("Venue declaration rows keep all 14 properties, asserters and effective host-floor words in the design callout", () => {
  const out = draw(venueProperties, venueView());
  assert.equal((out.match(/<span class="vd-p">/g) ?? []).length, 14);
  assert.match(out, /class="vd-decl"/);
  assert.match(out, /class="vd-floorl"/);
  assert.match(
    out,
    /build3 asks for enforced; on this host the venue has asserted/,
  );
  assert.match(out, /Asserted by OpenShell/);
  assert.match(out, /this venue falls below it/);
  assert.doesNotMatch(out, /No published floor asks for this property/);
});

test("Venue feature cards and full comparison use descriptive labels, feature chips, selected cells and a shared legend", () => {
  const v = venueView();
  const serves = draw(venueServes, v);
  assert.match(serves, /class="vd-serves"/);
  for (const text of [
    "Live transcript",
    "Steering",
    "Recovery",
    "Sandbox shell",
    "with the image",
  ])
    assert.ok(serves.includes(text), text);
  const comparison = draw(venueCompare, v);
  assert.match(comparison, /class="vd-c vd-cur"/);
  assert.match(comparison, /class="vd-split"/);
  assert.match(comparison, /class="vd-p"/);
  assert.match(comparison, /class="vd-legend"/);
  assert.match(comparison, /Credentials held by/);
  assert.match(comparison, /the venue(?:'|&#39;)s egress layer/);
  assert.match(comparison, /the container/);
  const summary = draw(venueSummary, v);
  assert.match(summary, /Published by/);
  assert.match(summary, /Held by the venue(?:'|&#39;)s egress layer/);
  assert.match(summary, /build3/);
  assert.doesNotMatch(
    summary,
    /class="seg"/,
    "the switch belongs to the title bar, not duplicated in the summary",
  );
});

test("Host stale warning and Doctor sections use the design hierarchy without inserting alternate-state examples as current facts", () => {
  const v = view();
  v.data.snapshot.hostBudgets[0].staleMs = 180000;
  v.data.snapshot.doctor = {
    hosts: [
      {
        name: "build3",
        ageMs: 3 * HOUR,
        every: 1,
        counts: { fail: 1, warn: 0, ok: 1 },
        checks: [
          {
            id: "docker.1",
            level: "fail",
            label: "Daemon unreachable",
            fix: "Start the runtime",
          },
          { id: "node.1", level: "ok" },
        ],
      },
    ],
  };
  assert.match(draw(hostState, v), /class="hd-state"/);
  const doctor = draw(hostDoctor, v);
  assert.match(doctor, /class="hd-secs"/);
  assert.match(doctor, /class="hd-seckey"/);
  assert.match(doctor, /class="fl-chks"/);
  assert.match(doctor, /aria-label="docker: failing"/);
  assert.match(doctor, /Stale: older than two/);
  assert.match(doctor, /Fix:<\/b> Start the runtime/);
  assert.equal((doctor.match(/data-copy/g) ?? []).length, 1);
});

test("The detail CSS retains design slot, KPI, sticky comparison and phone treatments from the existing card source", () => {
  const source = readFileSync(
    new URL("../../design/tools/gen_fleet2.py", import.meta.url),
    "utf8",
  );
  for (const rule of [
    ".hd-sls .sl { width: 22px; height: 22px; }",
    ".hd-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr));",
    ".hd-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }",
  ]) {
    assert.ok(source.includes(rule));
    assert.ok(HOST_DETAIL_CSS.includes(rule));
  }
  assert.match(VENUE_DETAIL_CSS, /position: sticky; left: 0/);
  assert.match(VENUE_DETAIL_CSS, /\.titlebar__end \.seg\{flex-wrap:wrap/);
});

test("an orphan found during boot names its observation time, never a cancellation or a failed stop", () => {
  const v = view();
  const observedAt = AT - HOUR;
  v.data.snapshot.hostBudgets = [
    host({
      jobs: [
        {
          id: "container:pi-job-left",
          v: "local",
          p: "web",
          m: 4096,
          c: 200,
          o: true,
          at: observedAt,
          s: observedAt,
        },
      ],
    }),
  ];
  for (const render of [hostJobs, hostSandboxes]) {
    const out = draw(render, v);
    assert.match(out, /Found left from before the worker started at <time/);
    assert.match(out, /2026-10-29T11:00:00\.000Z/);
    assert.doesNotMatch(out, /Cancelled|stop did not take/);
    assert.match(out, /still holds/);
  }
  v.data.snapshot.hostBudgets[0].jobs[0].id = "gh-ended";
  assert.match(draw(hostJobs, v), /Cancelled at <time/);
  assert.match(draw(hostSandboxes, v), /Its stop did not take at <time/);
});

test("mobile venue declarations pair the question with its word and give the asserter a full row without duplicate data labels", () => {
  const out = draw(venueProperties, venueView());
  const rows = [...out.matchAll(/<tr>(.*?)<\/tr>/g)]
    .map((m) => m[1])
    .filter((row) => row.includes('data-l="Property"'));
  assert.equal(rows.length, 14);
  for (const row of rows) {
    assert.match(row, /data-l="Property"[^]*class="vd-p"/);
    assert.match(row, /data-l="Word"[^]*class="chip vw/);
    assert.match(row, /data-l="Who provides it"[^]*class="vd-mean"/);
  }
  // Keep semantic headers for the desktop table and assistive technology. Only generated phone labels disappear.
  assert.match(out, /<th scope="col">Property<\/th>/);
  const phone = VENUE_DETAIL_CSS.slice(
    VENUE_DETAIL_CSS.lastIndexOf("@media (max-width: 760px)"),
  );
  assert.match(
    phone,
    /\.vd-tbl \.tbl--stack td\[data-l\]::before \{ content: none; \}/,
  );
  assert.match(phone, /td:nth-child\(1\) \{ grid-column: 1; grid-row: 1;/);
  assert.match(phone, /td:nth-child\(2\) \{ grid-column: 2; grid-row: 1;/);
  assert.match(
    phone,
    /td:nth-child\(3\) \{ grid-column: 1 \/ -1; grid-row: 2;/,
  );
  assert.ok(
    !phone.includes(".vd-cmp"),
    "the horizontally scrolling comparison keeps its separate design",
  );
});
