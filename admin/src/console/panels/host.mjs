/** Host pages report published facts; runtime cleanup remains an explicit command on that host. */
import {
  jobContainerName,
  sandboxNameOf,
} from "@edgehero/pi-dispatch/container-names";
import { projectBudgetRow } from "@edgehero/pi-dispatch/host-budget";
import { hostQueueName } from "@edgehero/pi-dispatch/queue";
import { DOCTOR_SECTIONS } from "@edgehero/pi-dispatch/doctor-results";
import {
  doctorHostsOf,
  doctorStale,
  doctorProblems,
  doctorCountsText,
  doctorByText,
  DOCTOR_CHECKS_SHOWN,
} from "../../doctor-view.mjs";
import { VENUE_LABEL } from "../../words.mjs";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { ageText, beatAgeOf, canAct, runLink as recordLink, timeHtml } from "./common.mjs";

const runLink = (id) => recordLink(id, { pulse: true });

import { hostSkewText, HOST_NO_EXPIRY_TEXT, REGISTRY_UNREAD_TEXT, JOBS_UNREAD_TEXT } from "./overview.mjs";

const hostOf = (v) =>
  v.data?.host ??
  v.data?.snapshot?.hostBudgets?.find((h) => h.name === v.query?.name) ??
  null;
const jobsOf = (h) => (Array.isArray(h?.jobs) ? h.jobs : []);
const num = (n) =>
  n !== null && n !== undefined && n !== "" && Number.isFinite(Number(n))
    ? Number(n)
    : null;
const label = (v) => v.query?.name ?? "this host";
const command = (v, argv) =>
  v.role === "operator"
    ? ui.cmd(argv, { host: label(v) })
    : html`<p class="note"> Run the cleanup on ${label(v)} using its runtime, then the host budget gives the room back within 5 seconds once that runtime says the container is gone. </p>`;
const card = (title, fn) => (v) => ui.card({ title, body: fn(hostOf(v), v) });
const gone = html`<p class="note"> This host has no live registry row. Its last run records, queued jobs and retained doctor result can still be shown. </p>`;

/** A published id can be a digest; that never becomes a guessed container name. */
export function orphanCommand(job) {
  const venue = job.v ?? job.venue;
  const id = job.id;
  const named =
    typeof id === "string" &&
    !id.startsWith("sha256:") &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(id);
  if (venue === "openshell" || venue === "openshell-bind") {
    if (!named)
      return [
        "openshell",
        "sandbox",
        "list",
        "--selector",
        "pi.dispatch.owner=pi-dispatch",
      ];
    const containerName = id.startsWith("container:")
      ? id.slice(10)
      : jobContainerName(id);
    const sandboxName = sandboxNameOf(containerName);
    return ["openshell", "sandbox", "delete", sandboxName];
  }
  if (venue === "local" || venue === "podman") {
    const runtime = venue === "local" ? "docker" : "podman";
    return named
      ? [
          runtime,
          "rm",
          "-f",
          id.startsWith("container:") ? id.slice(10) : jobContainerName(id),
        ]
      : [runtime, "ps", "-a", "--filter", "name=pi-job-"];
  }
  return null;
}

export const hostState = (v) => {
  const h = hostOf(v);
  const unread = Boolean(v.data?.snapshot?.queue?.fleetDegraded);
  const skew = h ? hostSkewText(h) : null;
  const age = h ? beatAgeOf(h) : null;
  const late = age === null || age > 60000;
  if (h && !late && !h.noExpiry && !h.jobsUnreadable && !unread && skew === null) return html``;
  return ui.card({ title: "Host state", tint: "attention", body: html`${unread ? html`<p>${REGISTRY_UNREAD_TEXT}</p>` : null}${h ? html`${late ? html`<p>Heartbeat late: ${age === null ? "age not known" : ageText(age)} (expected within 1m). The worker beats every 15s; routing stops after three missed beats. Jobs already in its own queue wait for it.</p>` : null}${h.noExpiry ? html`<p>${HOST_NO_EXPIRY_TEXT}</p>` : null}${skew === null ? null : html`<p>${skew}</p>`}${h.jobsUnreadable ? html`<p>${JOBS_UNREAD_TEXT}</p>` : null}<p>${h.routes === false || h.routes === "false" ? "This host has no routing queue; it still takes shared jobs." : "This host takes its own routed jobs and shared jobs."}</p>${late && canAct(v) && h.routes !== false && h.routes !== "false" ? ui.actForm({ action: "queue-pause", hidden: [["queue", hostQueueName(h.name)]], label: `Pause ${hostQueueName(h.name)}`, kind: ["danger", "sm"] }) : null}` : gone}` });
};

const sizeText = (size) =>
  size && Number.isFinite(size.memMiB) && Number.isFinite(size.cpuCenti)
    ? `${size.memMiB / 1024} GiB and ${size.cpuCenti / 100} cores`
    : "size not published";
export const hostJobs = card("Jobs on the host", (h, v) => {
  const s = v.data?.snapshot ?? {};
  const active = (s.active ?? []).filter((j) => j.host === label(v));
  const waiting = (s.waiting?.rows ?? []).filter(
    (j) => j.host === label(v) || j.queue === hostQueueName(label(v)),
  );
  const rows = active.map((j) => [
    html`${j.project ? ui.ptag(j.project) : "No project recorded"} ${runLink(j.jobId)}`,
    sizeText(j.size),
    j.startedAt ? ageText(v.now - j.startedAt) : "unknown",
    "Running",
    canAct(v)
      ? ui.actForm({
          action: "cancel-active",
          hidden: [["jobId", j.jobId]],
          label: "Cancel",
          kind: ["danger", "sm"],
        })
      : null,
  ]);
  for (const j of jobsOf(h).filter((j) => j.o))
    rows.push({
      mark: "attention",
      cells: [
        runLink(j.id),
        sizeText({ memMiB: j.m, cpuCenti: j.c }),
        j.s ? timeHtml(j.s) : "stop time not published",
        html`Cancelled${j.s ? html` at ${timeHtml(j.s)}` : ""}; its container's stop did not take, so it still holds ${sizeText({ memMiB: j.m, cpuCenti: j.c })}.`,
        v.role === "operator"
          ? ui.btn({
              label: "Free the slot",
              href: `${`/fleet/host?${new URLSearchParams({ name: label(v) })}`}#p-hostsandboxes`,
              kind: ["ghost", "sm"],
            })
          : null,
      ],
    });
  for (const j of waiting)
    rows.push([
      html`${j.project ? ui.ptag(j.project) : "No project recorded"} ${runLink(j.jobId)}`,
      sizeText(j.size ?? s.defaultSize),
      j.at ? ageText(v.now - j.at) : "not recorded",
      j.why === "host-budget"
        ? `Host budget (${j.budgetWhy ?? "dimension not recorded"}); asks again about every 9 seconds and keeps its place.`
        : (j.why ?? "No reason was recorded"),
      canAct(v) &&
      j.attemptsMade === 0 &&
      j.stalled === 0 &&
      !j.recovery &&
      !j.schedulerNext
        ? ui.actForm({
            action: "cancel-queued",
            hidden: [
              ["jobId", j.jobId],
              ["queue", j.queue],
            ],
            label: "Cancel",
            kind: ["danger", "sm"],
          })
        : null,
    ]);
  return html`${ui.tbl({
    label: "Jobs on the host",
    stack: true,
    heads: ["Project and job", "Size", "How long", "State", "Action"],
    rows,
    empty: "No running, orphaned or waiting job was read for this host.",
  })}${
    h?.jobsUnreadable
      ? html`<p>The host's running-job list is unreadable.</p>`
      : null
  }${
    h?.jobsMore
      ? html`<p>${h.jobsMore} more running jobs were not listed.</p>`
      : null
  }${
    !s.waiting || s.waiting.unreachable
      ? html`<p>Waiting jobs could not be read.</p>`
      : s.waiting.truncated
        ? html`<p>Not every waiting job was read.</p>`
        : null
  }`;
});

export const hostSandboxes = card("Sandboxes left on the host", (h, v) => {
  if (!h) return gone;
  const orphans = jobsOf(h).filter((j) => j.o);
  const sandboxes = Array.isArray(h.sandboxes) ? h.sandboxes : [];
  const sandboxesKnown = Array.isArray(h.sandboxes);
  return html`${orphans.map((j) => {
    const argv = orphanCommand(j);
    return html`<div class="card card--tint tone-attention"> <h3>Orphaned hold ${j.id}</h3> <p> Its stop did not take ${j.s ? timeHtml(j.s) : "at an unpublished time"}; it still holds ${j.m ?? "unknown"} MiB and ${j.c === undefined || j.c === null ? "unknown" : Number(j.c) / 100} cores. </p> ${
      argv
        ? command(v, argv)
        : html`<p> The venue was not published, so the console cannot name its container or runtime. Inspect the host's runtime and identify the orphan there. </p>`
    }${
      String(j.id).startsWith("sha256:")
        ? html`<p> The published id is a digest; the listing command helps identify the container. </p>`
        : null
    }${
      j.v === "podman" ? html`<p>Run Podman as the worker's account.</p>` : null
    } </div>`;
  })}${
    orphans.length
      ? html`<p> The host budget gives the room back within 5 seconds once its runtime says the container is gone. </p>`
      : html`<p>No orphan container was published.</p>`
  }${ui.tbl({
    label: "Retained workspaces",
    stack: true,
    heads: ["Run", VENUE_LABEL, "Kept until", "Pin", "Open on the host"],
    rows: sandboxes.map((x) => {
      const id = x.id ?? x.jobId;
      const venue = x.v ?? x.venue;
      const until = x.until;
      const shell = venue === "local" || venue === "podman";
      return [
        runLink(id),
        venue,
        until ? timeHtml(until) : "not published",
        (x.pin ?? x.pinned) ? "Pinned" : "Not pinned",
        !shell
          ? "This venue has no sandbox shell: pi-dispatch sandbox cannot reopen its runs."
          : typeof id === "string" && !id.startsWith("sha256:")
            ? command(v, [
                "pi-dispatch",
                "sandbox",
                id,
                ...(until && until <= v.now ? ["--pin"] : []),
              ])
            : "The published id is a digest; identify the run on this host.",
      ];
    }),
    empty: sandboxesKnown
      ? "No retained workspace was published."
      : "The retained workspace list is unreadable or was not published by this worker.",
  })}${
    h.sandboxesMore > 0
      ? html`<p>${h.sandboxesMore} more retained workspaces.</p>`
      : null
  } <p> ${
    h.sandboxRetentionHours === 0
      ? "Workspace retention is off on this host."
      : `Retention window: ${h.sandboxRetentionHours ?? "not published"} hours (24 by default).`
  } Each workspace holds the run's clone, prompt.md and event.json (issue text). Whether a shell is open needs this host's runtime. </p> ${
    v.role === "operator"
      ? ui.cmd(["pi-dispatch", "sandbox", "--list"], { host: h.name })
      : null
  }`;
});

/** Hatched room belongs to an orphan, so it is neither free nor another running job's promise. */
const budgetMeter = (h, key, usedKey, title, divisor) => {
  const total = num(h[key]);
  const used = num(h[usedKey]);
  const held = jobsOf(h)
    .filter((j) => j.o)
    .reduce(
      (n, j) => n + Number(j[key === "budgetMemMiB" ? "m" : "c"] ?? 0),
      0,
    );
  if (total === null || total <= 0 || used === null)
    return html`<p> ${title}: ${
      h[key] === "off"
        ? "off (no budget)"
        : "budget not known yet or unreadable"
    }. </p>`;
  const solid = Math.max(0, Math.min(100, ((used - held) / total) * 100));
  const hatch = Math.max(0, Math.min(100 - solid, (held / total) * 100));
  return html`<p> ${title}: ${used / divisor} of ${total / divisor}, ${held / divisor} held by orphans, ${Math.max(0, total - used) / divisor} free. </p> <svg class="pbar tone-running" height="10" role="meter" aria-label="${title}: running, orphaned and free" aria-valuenow="${ui.svgNum(Math.min(100, (used / total) * 100), 0, 100)}" aria-valuemin="0" aria-valuemax="100" > <rect class="pbar__bed" width="100%" height="10" rx="5" /> <rect class="pbar__fill" width="${ui.svgNum(solid, 0, 100)}%" height="10" /> <rect x="${ui.svgNum(solid, 0, 100)}%" width="${ui.svgNum(hatch, 0, 100)}%" height="10" fill="url(#hatch)" /> </svg>`;
};

export function budgetOriginText(origin) {
  if (!origin) return "Not published by this worker";
  const figure = (n, scale) =>
    n === null || n === undefined ? "unknown" : Number(n) / scale;
  const dimension = (mode, total, reserve, scale, unit) =>
    mode === "off"
      ? `${unit} budget off`
      : mode === "auto"
        ? `${unit} auto: the machine's ${figure(total, scale)} less a ${figure(reserve, scale)} reserve`
        : mode === "value"
          ? `${unit} explicitly set`
          : `${unit} origin not published`;
  return `${dimension(origin.memMode, origin.memTotalMiB, origin.memReserveMiB, 1024, "GiB")}; ${dimension(origin.cpuMode, origin.cpuTotalCenti, origin.cpuReserveCenti, 100, "cores")}`;
}

export const hostBudget = card("Slots and budget", (h, v) => {
  if (!h) return gone;
  const orphans = jobsOf(h).filter((j) => j.o).length;
  const running = jobsOf(h).length - orphans;
  const slots = num(h.concurrency);
  const projects = [
    ...new Set(
      [
        ...jobsOf(h).map((j) => j.p),
        ...(v.data?.snapshot?.waiting?.rows ?? [])
          .filter((j) => j.host === h.name)
          .map((j) => j.project),
      ].filter(Boolean),
    ),
  ];
  const rules = projects.map((id) => ({
    id,
    ...projectBudgetRow(v.data?.snapshot?.scopedLimits?.limits ?? [], id),
  }));
  const jobsKnown =
    !h.jobsUnreadable &&
    Array.isArray(h.jobs) &&
    h.jobsMore === 0 &&
    slots !== null && slots > 0 &&
    beatAgeOf(h) !== null &&
    beatAgeOf(h) <= 60000;
  const readable = !h.jobsUnreadable && Array.isArray(h.jobs);
  const complete = readable && h.jobsMore === 0;
  const occupied = complete
    ? `${jobsKnown ? "" : "Last published: "}${running + orphans} of ${slots ?? "unknown"} slots taken: ${running} running, ${orphans} held by orphaned containers.`
    : readable && running + orphans > 0
      ? `At least ${running + orphans} occupied ${running + orphans === 1 ? "slot is" : "slots are"} listed: ${running} running, ${orphans} held by orphaned containers. The whole occupied count is not known.`
      : "The occupied slot count is not known: the job inventory was not read whole.";
  return html`${
    jobsKnown
      ? ui.slots({
          run: running,
          hold: orphans,
          free: Math.max(0, slots - running - orphans),
        })
      : html`<p> Free slots are not known: this host is late or its running-job list was not read whole. </p>`
  } <p> ${occupied} PI_CONCURRENCY ${slots ?? "unknown"}. </p> ${budgetMeter(
    h,
    "budgetMemMiB",
    "usedMemMiB",
    "Memory (GiB)",
    1024,
  )}${budgetMeter(
    h,
    "budgetCpuCenti",
    "usedCpuCenti",
    "CPU (cores)",
    100,
  )}${ui.facts([
    ["Budget origin", budgetOriginText(h.budgetFrom)],
    ["Waiters", h.waiters ?? "not published"],
    [
      "Room for oldest waiter",
      `${h.heldMemMiB ?? "unknown"} MiB and ${h.heldCpuCenti === undefined || h.heldCpuCenti === null ? "unknown" : Number(h.heldCpuCenti) / 100} cores`,
    ],
    [
      "CPU reserve",
      Array.isArray(h.cpuReserve)
        ? h.cpuReserve
            .map(
              (r) =>
                `${r.venue}: ${r.status}${r.status === "held" ? ", every job runs under pidispatch.slice, whose quota is the CPU budget" : ""}`,
            )
            .join("; ")
        : "Not published",
    ],
    [
      "Old containers",
      h.budgetSeed ? JSON.stringify(h.budgetSeed) : "Not published",
    ],
  ])} <p class="note"> A host admits no job on a venue whose old containers it could not list. Project hostShare and minJobs rules still apply. ${rules.map((r) => `${r.id}: hostShare ${r.hostShare === null ? "unlimited" : `${r.hostShare}%`}, minJobs ${r.minJobs}`).join("; ") || "No project rules apply to the jobs read on this host."} </p>`;
});

/** Capacity uses the same seven-day fold as Spend; only geometry is drawn here. */
export const hostCapacity = card("Last 7 days", (_h, v) => {
  const cap = v.data?.hostCapacity;
  const host = cap?.hosts?.[0];
  const facts = host?.facts;
  let graph = null;
  if (host && cap.window && Array.isArray(host.buckets)) {
    const buckets = host.buckets;
    const max = Math.max(
      1,
      Number(host.slots ?? 0),
      ...buckets.map((b) => Number(b.peak ?? 0)),
    );
    const span = Math.max(1, cap.window.toMs - cap.window.fromMs);
    const position = (at) =>
      Math.max(0, Math.min(600, ((at - cap.window.fromMs) / span) * 600));
    const n = (value) => ui.svgNum(value, 0, 600);
    graph = html`<svg viewBox="0 0 600 120" width="100%" role="img" aria-label="Jobs at once, average bars, peak ticks and dashed slot count" > <rect width="600" height="100" fill="url(#hatch)" /> ${buckets.map(
      (b) => {
        const x = position(b.fromMs);
        const width = Math.max(0, position(b.fromMs + cap.window.bucketMs) - x);
        const coverage = Math.max(
          0,
          Math.min(1, Number(b.coveredMs ?? 0) / cap.window.bucketMs),
        );
        const height = Math.min(
          100,
          (Number(b.avgMilli ?? 0) / 1000 / max) * 100,
        );
        const peak = 100 - (Number(b.peak ?? 0) / max) * 100;
        return html`<g ><title> ${timeText(b.fromMs)}: average ${Number(b.avgMilli ?? 0) / 1000}, peak ${b.peak ?? "unknown"}; uncovered time is no history</title ><rect x="${n(x)}" y="0" width="${n(width * coverage)}" height="100" fill="var(--canvas)" /><rect x="${n(x)}" y="${n(100 - height)}" width="${n(Math.max(0, width * coverage - 0.5))}" height="${n(height)}" fill="var(--running)" /><line x1="${n(x)}" x2="${n(x + width * coverage)}" y1="${n(peak)}" y2="${n(peak)}" stroke="currentColor" /></g>`;
      },
    )}${
      host.slots !== null && host.slots !== undefined
        ? html`<line x1="0" x2="600" y1="${n(100 - (Number(host.slots) / max) * 100)}" y2="${n(100 - (Number(host.slots) / max) * 100)}" stroke="currentColor" stroke-dasharray="4 3" />`
        : null
    } </svg>`;
  }
  return html`${
    facts
      ? ui.facts([
          [
            "Busy / idle / no history",
            `${facts.busy}, ${facts.idle}, ${facts.missing ?? "0%"}`,
          ],
          [
            "Slots, average / peak",
            `${facts.avg} / ${facts.peak} of ${facts.slots ?? "unknown"}`,
          ],
          ["Time full", facts.full ?? "not known"],
          ["Wait for a slot", facts.wait ?? "no run recorded a wait"],
          [
            "Promised memory / CPU",
            `${facts.memory ?? "memory not recorded"}; ${facts.cpu ?? "CPU not recorded"}`,
          ],
          ["CPU used", facts.cpuUsed ?? "not recorded"],
          [
            "Projects by run time",
            facts.projects?.join(", ") || "none recorded",
          ],
        ])
      : html`<p> ${
          host?.notShared ??
          (host?.empty
            ? "No capacity history here for this host."
            : "The host's capacity history could not be read.")
        } </p>`
  }${graph} <p class="note"> Jobs only: no-history time is neither busy nor idle. Each bar is one hour, with a tick at the most at once, a dashed slot line and hatched no-history time. This seven-day report is read on page load, never on a live tick. </p> ${
    cap?.truncated || host?.truncated
      ? html`<p>Capacity history was truncated; earlier time is no history.</p>`
      : null
  }${(cap?.coverage ?? []).map((line) => html`<p class="note">${line}</p>`)}${(
    host?.caveats ?? []
  ).map((line) => html`<p class="note">${line}</p>`)}${
    host?.notes ? html`<p class="note">${host.notes}</p>` : null
  }${
    v.role === "operator"
      ? ui.cmd(["pi-dispatch", "capacity", "--host", label(v), "--since", "7d"])
      : null
  }`;
});
const timeText = (ms) =>
  Number.isFinite(ms) && ms >= 0 && ms <= 253402300799999
    ? new Date(ms).toISOString().slice(0, 16)
    : "unknown";

export const hostRow = card("Registry row", (h, v) =>
  h
    ? html`${ui.facts(
        [
          ["Worker version", h.version],
          ["Started", h.startedAt ? timeHtml(Number(h.startedAt)) : h.started],
          ["PID", h.pid],
          ["Image", h.image],
          [
            "Image digest",
            html`${h.imageDigest ?? "not published"}. ${!h.imageDigest || (v.data?.snapshot?.hostBudgets ?? []).some((peer) => !peer.imageDigest) ? "Image digest comparison is not known until every live host publishes one." : (v.data?.snapshot?.hostBudgets ?? []).every((peer) => peer.imageDigest === h.imageDigest) ? "Every live host has the same image digest." : "Live hosts have different image digests."}`,
          ],
          ["pi version", h.piVersion],
          [
            "Time zone",
            html`${h.tz ?? h.timezone ?? "not published"}${
              h.tz || h.timezone
                ? (v.data?.snapshot?.hostBudgets ?? []).every(
                    (peer) =>
                      (peer.tz ?? peer.timezone) === (h.tz ?? h.timezone),
                  )
                  ? ". Every live host has the same time zone."
                  : ". Live hosts have different time zones."
                : ""
            }`,
          ],
          [
            "Queues",
            h.routes === false || h.routes === "false"
              ? "pi-jobs (shared queue only)"
              : `pi-jobs, ${hostQueueName(h.name)}`,
          ],
          [
            "Venues and floor",
            h.backends
              ? `${h.backends.blessed.join(", ")} (default ${h.backends.default}); floor: ${
                  Object.entries(h.backends.floor ?? {})
                    .map(([key, word]) => `${key}=${word}`)
                    .join(", ") || "none"
                }`
              : "not published",
          ],
          ["Profiles", Array.isArray(h.caps) ? h.caps.join(", ") : h.caps],
          [
            "Fingerprints",
            [
              ["triggers", "fpCron"],
              ["dollar caps", "fpUsd"],
              ["projects", "fpProjects"],
              ["envelope", "fpEnvelope"],
            ]
              .map(
                ([title, key]) =>
                  `${title}: ${h[key] ?? "not published"}${h[key] ? ((v.data?.snapshot?.hostBudgets ?? []).every((peer) => peer[key] === h[key]) ? " (matches every live host)" : " (differs across live hosts)") : ""}`,
              )
              .join("; "),
          ],
        ],
        { cols: 1 },
      )} <p> Last beat ${ageText(beatAgeOf(h))} ago. Every 15s. The row expires after 90s without one. </p> ${
        h.noExpiry
          ? html`<p class="warn"> This row has no expiry and may outlive its host. </p>`
          : null
      }`
    : html`${gone}${
        v.data?.hostHistory?.records?.length
          ? html`<p> Last seen ${(() => {
              const record = v.data.hostHistory.records[0];
              const at = Date.parse(record.endedAt ?? record.startedAt ?? "");
              return Number.isFinite(at)
                ? timeHtml(at)
                : "at an unrecorded time";
            })()} in ${v.data.hostHistory.records.length} retained run records. </p>`
          : html`<p>No retained run record names this host.</p>`
      }`,
);

export const hostDoctor = (v) => {
  const s = v.data?.snapshot ?? {};
  const d = doctorHostsOf(s).find((row) => row.name === label(v));
  const checks = Array.isArray(d?.checks) ? d.checks : [];
  const sections =
    d && !d.unreadable
      ? html`<div class="chips">${DOCTOR_SECTIONS.map((section) => {
          const found = checks.filter((c) => c.id?.startsWith(`${section}.`));
          const level = found.some((c) => c.level === "fail")
            ? "failed"
            : found.some((c) => c.level === "warn")
              ? "attention"
              : found.length
                ? "ok"
                : "idle";
          return ui.chip(
            `${section}: ${found.length ? (level === "ok" ? "passing" : level === "failed" ? "failing" : "warning") : "not run on this host"}`,
            { status: level },
          );
        })}</div>`
      : null;
  const problems = d ? doctorProblems(d) : [];
  const hidden =
    Math.max(0, problems.length - DOCTOR_CHECKS_SHOWN) + Number(d?.more ?? 0);
  const state = !d
    ? html`<p>No doctor result published by this host. Run doctor on this host to publish its result.</p>`
    : d.unreadable
      ? html`<p>Its published result cannot be read (a worker of another version may have written it).</p>`
      : html`<p class="${d.counts?.fail ? "tone-failed" : d.counts?.warn ? "tone-attention" : "tone-ok"}">Doctor ran ${ageText(d.ageMs)} ago${d.version ? ` (version ${d.version})` : ""}, ${doctorByText(d)}: ${doctorCountsText(d)}.${d.openshell ? " The openshell venue was judged." : ""}</p>${doctorStale(d) ? html`<p class="tone-attention">Stale: older than two of this host's doctor runs (every ${d.every}h).</p>` : null}${d.workerRun && !d.by?.worker ? html`<p>It replaced the worker's own run${d.workerRun.uid !== undefined ? ` (uid ${d.workerRun.uid})` : ""}, so it shows another account's view of the host.</p>` : null}`;
  const problemsHtml =
    d && !d.unreadable
      ? html`${problems.length ? problems.slice(0, DOCTOR_CHECKS_SHOWN).map((c) => html`<div class="card card--tint ${c.level === "fail" ? "tone-failed" : "tone-attention"}"><p><b>${c.level === "fail" ? "Failing" : "Warning"}</b>: <span class="code">${c.id}</span></p><p>${c.label}</p><p><b>Fix:</b> ${c.fix}</p></div>`) : html`<p>Every check passed.</p>`}${hidden ? html`<p>${hidden} more not shown here; doctor on this host prints them all.</p>` : null}`
      : null;
  return ui.card({
    title: "Doctor",
    body: html`${state}${sections}${problemsHtml}${v.role === "operator" ? ui.cmd(["pi-dispatch", "doctor"], { host: label(v) }) : html`<p>Run doctor on this host to inspect its checks.</p>`}`,
  });
};
