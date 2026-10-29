/** Fleet panels use only the reader's bounded projections, never running Job.data or a remote runtime. */
import {
  DEFER_BUCKETS,
  DEFER_BUCKET_WORDS,
  DEFER_WHYS,
} from "@edgehero/pi-dispatch/defer-reasons";
import { GATEWAY_TEXT, venuesView } from "../../read-model.mjs";
import { VENUE_LABEL, reasonWords } from "../../words.mjs";
import {
  DOCTOR_CHECKS_SHOWN,
  doctorByText,
  doctorCountsText,
  doctorHostsOf,
  doctorProblems,
  doctorStale,
} from "../../doctor-view.mjs";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import {
  ageText,
  timeHtml,
  runLink as recordLink,
  canAct,
  RUN_ID_RE,
  beatAgeOf,
  progressText,
  workersOnline,
} from "./common.mjs";
import {
  waitingSentence,
  WAITING_CUT_TEXT,
  NO_WORKER_TEXT,
  STALE_BEATS_TEXT,
  REGISTRY_UNREAD_TEXT,
} from "./overview.mjs";

const runLink = (id) => recordLink(id, { pulse: true });

const list = (x) => (Array.isArray(x) ? x : []);
const hostHref = (name) => `/fleet/host?${new URLSearchParams({ name })}`;
const venueHref = (name) => `/fleet/venue?${new URLSearchParams({ name })}`;
const linkHost = (name) =>
  name ? html`<a href="${hostHref(name)}">${name}</a>` : "host not published";
const project = (p) => (p ? ui.ptag(p) : "No project recorded");
const wrap = (title, fn) => (view) =>
  ui.card({
    title,
    ring:
      title === "Fleet" &&
      view.data?.snapshot?.queueCounts?.some((q) => q.paused) &&
      view.data.snapshot.queueCounts.some((q) => !q.paused)
        ? "attention"
        : null,
    body: view.data?.snapshot
      ? fn(view.data.snapshot, view)
      : html`<p class="note"> The deployment's Valkey could not be read. The next refresh tries again. </p>`,
  });
const act = (view, action, label, hidden = []) =>
  canAct(view)
    ? ui.actForm({
        action,
        label,
        hidden,
        kind: [
          action.startsWith("retry") || action.endsWith("resume")
            ? "paid"
            : "danger",
          "sm",
        ],
      })
    : null;
const jobAct = (view, action, label, r) =>
  RUN_ID_RE.test(String(r.jobId))
    ? act(view, action, label, [
        ["jobId", r.jobId],
        ...(r.queue && !["cancel-active", "cancel-held"].includes(action)
          ? [["queue", r.queue]]
          : []),
      ])
    : null;
const orphanRows = (s) =>
  list(s.hostBudgets).flatMap((host) =>
    list(host.jobs)
      .filter((j) => j.o)
      .map((job) => ({ ...job, host })),
  );

export const fleetBar = wrap("Fleet", (s, v) => {
  const queues = list(s.queueCounts);
  const paused = queues.filter((q) => q.paused);
  const running = queues.filter((q) => !q.paused);
  const state =
    queues.length === 0
      ? "Queue state not read"
      : paused.length === queues.length
        ? "Paused"
        : paused.length
          ? "Part paused"
          : "Running";
  const mismatch = v.data?.killSwitch;
  const online = workersOnline(s);
  const count = (key) =>
    Number.isFinite(s.queue?.counts?.[key])
      ? s.queue.counts[key]
      : queues.length
        ? queues.reduce((n, q) => n + Number(q.counts?.[key] ?? 0), 0)
        : "not read";
  return html`${s.queue?.fleetDegraded ? html`<p class="note">${REGISTRY_UNREAD_TEXT} Registry rows last read ${s.hostsReadAt ? timeHtml(s.hostsReadAt) : "at an unknown time"}.</p>` : null}${ui.badge(paused.length ? "attention" : "ok", state)}${
    !paused.length && online.none
      ? html`<p class="tone-attention">${NO_WORKER_TEXT}</p>`
      : online.staleBeats
        ? html`<p class="note">${STALE_BEATS_TEXT}</p>`
        : null
  } <p> ${online.online ?? "unknown"} hosts beating (${list(s.hostBudgets).length} registered); ${running.length} queues accept jobs. </p> ${
    paused.length && running.length
      ? html`<p class="tone-attention"> Starts nothing new: ${paused.map((q) => q.queue).join(", ")}. Keeps starting jobs: ${running.map((q) => q.queue).join(", ")}. ${paused.reduce(
          (n, q) =>
            n + Number(q.counts?.waiting ?? 0) + Number(q.counts?.paused ?? 0),
          0,
        )} jobs wait in paused queues. </p>`
      : null
  }${ui.facts([
    ["Waiting", count("waiting")],
    ["Active", count("active")],
    ["Delayed", count("delayed")],
    [
      "Held",
      s.held?.unreachable
        ? "unreadable"
        : list(s.held?.rows).length + Number(s.held?.more ?? 0),
    ],
    ["Awaiting retry", count("failed")],
  ])} <div> ${
    running.length || !queues.length
      ? act(v, "fleet-pause", "Pause the fleet")
      : null
  }${
    paused.length ? act(v, "fleet-resume", "Resume the fleet") : null
  } </div> <p class="note"> Read ${ageText(Math.max(0, v.now - Number(s.at ?? s.readAt ?? v.now)))} ago from ${s.valkey ?? s.valkeyUrl ?? "the deployment's Valkey"} and ${list(s.hostBudgets).length} hosts' registry rows. </p> ${
    mismatch?.disagreement
      ? ui.banner({
          status: "attention",
          title: "Two Valkeys",
          body: html`<p>${mismatch.disagreement}</p> <p> A pause reaches both; a resume neither until they agree. Nothing was changed. One queue can still be resumed on the Valkey this console read it from. </p> ${
            v.role === "operator" && Array.isArray(mismatch.resumeArgv)
              ? ui.cmd(mismatch.resumeArgv)
              : null
          }`,
        })
      : null
  }`;
});

export const fleetQueues = wrap("Queues", (s, v) =>
  ui.tbl({
    label: "Queues",
    stack: true,
    heads: [
      "Queue",
      "State",
      "Waiting",
      "Active",
      "Delayed",
      "Paused",
      "Failed",
      ...(canAct(v) ? ["Action"] : []),
    ],
    rows: list(s.queueCounts).map((q) => ({
      mark: q.paused ? "attention" : null,
      cells: [
        html`<span class="code">${q.queue}</span>${
          q.queue === "pi-jobs"
            ? html`<p>${list(s.hostBudgets).length} hosts share it.</p>`
            : q.paused
              ? html`<p>Its host still takes shared jobs.</p>`
              : null
        }`,
        ui.badge(
          q.paused ? "attention" : "ok",
          q.paused ? "Paused" : "Running",
        ),
        ...["waiting", "active", "delayed", "paused", "failed"].map(
          (k) => q.counts?.[k] ?? "not read",
        ),
        ...(canAct(v)
          ? [
              act(
                v,
                q.paused ? "queue-resume" : "queue-pause",
                q.paused ? "Resume" : "Pause",
                [["queue", q.queue]],
              ),
            ]
          : []),
      ],
    })),
    empty: "No queue was read.",
  }),
);

export const fleetActive = wrap("Active jobs", (s, v) => {
  const rows = list(s.active).map((j) => {
    const p = j.progress;
    const has = p && !p.ended && !p.absent;
    return [
      html`${project(j.project)} ${runLink(j.jobId)}`,
      "shown when the run ends",
      linkHost(j.host),
      j.startedAt ? timeHtml(j.startedAt) : "not published",
      j.startedAt ? ageText(v.now - j.startedAt) : "unknown",
      has
        ? html`${
            p.phase?.count
              ? ui.phases({
                  names: Array.from(
                    { length: Math.min(64, p.phase.count) },
                    (_, i) => `Phase ${i + 1}`,
                  ),
                  index: p.phase.index,
                })
              : null
          } <p>${progressText(p, v.now)}</p>`
        : ui.noProgress("This worker reports no progress"),
      ...(canAct(v) ? [jobAct(v, "cancel-active", "Cancel", j)] : []),
    ];
  });
  const orphan = orphanRows(s).map((j) => ({
    mark: "attention",
    cells: [
      html`${project(j.p)} ${runLink(j.id)}`,
      "Orphaned hold",
      linkHost(j.host.name),
      j.s ? timeHtml(j.s) : "stop time not published",
      "Still holds a slot",
      html`<p> Orphaned hold: its stop did not take${j.s ? html` at ${timeHtml(j.s)}` : ""}, but it still holds a ${j.host.name} slot. ${j.host.name} runs ${list(j.host.jobs).filter((x) => !x.o).length} jobs where it could run ${j.host.concurrency}. </p>`,
      ...(canAct(v)
        ? [
            ui.btn({
              kind: ["ghost", "sm"],
              label: "Free the slot",
              href: `${hostHref(j.host.name)}#p-hostsandboxes`,
            }),
          ]
        : []),
    ],
  }));
  return ui.tbl({
    label: "Active jobs",
    stack: true,
    heads: [
      "Project and job",
      "Target",
      "Host",
      "Started",
      "Run time",
      "Progress",
      ...(canAct(v) ? ["Action"] : []),
    ],
    rows: [...rows, ...orphan],
    empty: "Nothing is running.",
  });
});

export const fleetHeld = wrap("Held", (s, v) => {
  if (!s.held || s.held.unreachable)
    return html`<p>The held jobs could not be read.</p>`;
  const rows = [...list(s.held.rows)].sort(
    (a, b) => (b.waitedMs ?? 0) - (a.waitedMs ?? 0),
  );
  const conditions = (r) =>
    html`<ul> ${
      r.after
        ? html`<li> ${timeHtml(r.after)}: ${r.after <= v.now ? "met" : `in ${ageText(r.after - v.now)}`} </li>`
        : null
    }${list(r.answers).map(
      (a) =>
        html`<li> ${a.profile}: ${
          a.answer === "go"
            ? "met"
            : a.answer === "hold"
              ? "not yet"
              : a.answer === "refuse"
                ? "refused"
                : a.answer
        }${a.at ? html` (${timeHtml(a.at)})` : null} </li>`,
    )} </ul>`;
  return html`${
    rows.length ? act(v, "cancel-all-held", "Cancel every held job") : null
  }${ui.tbl({
    label: "Held jobs",
    stack: true,
    heads: [
      "Project and job",
      "Target",
      "Condition",
      "Held for",
      "Checks",
      ...(canAct(v) ? ["Action"] : []),
    ],
    rows: rows.map((r) => [
      html`${project(r.project)} ${runLink(r.jobId)}`,
      r.target ?? "no target recorded",
      html`<p> ${r.label ?? "Conditions not published"} </p> ${conditions(r)}<p class="note">${r.after ? "After a time" : "Without a time condition"}${
        list(r.answers).length
          ? `, then ${list(r.answers).length} ${list(r.answers).length === 1 ? "check" : "checks"}${` named ${list(
              r.answers,
            )
              .map((a) => a.profile)
              .join(", ")}`}`
          : ", with no profile answer published yet"
      }.</p>${list(r.answers).some((a) => a.answer === "unclear") ? html`<p>${list(r.answers).filter((a) => a.answer === "unclear").length} checks could not tell (${s.waitMaxFaults ?? 5} in a row ends the wait).</p>` : null}`,
      ageText(r.waitedMs),
      `${r.checks ?? 0} of ${s.waitMaxChecks ?? 96}`,
      ...(canAct(v) ? [jobAct(v, "cancel-held", "Cancel", r)] : []),
    ]),
    empty: "No job is held.",
  })} <p class="note"> A job starts when every condition is met. Checks spend nothing. A check profile gives up after ${Number(s.waitMaxMs ?? 86400000) / 3600000} hours or ${s.waitMaxChecks ?? 96} checks (wait-expired). A cancelled held job spent nothing while it waited. A check that cannot tell ${s.waitMaxFaults ?? 5} times in a row ends the wait. </p> ${s.held.more ? html`<p>${s.held.more} more held.</p>` : null}${
    s.held.truncated ? html`<p>Not every held job was read.</p>` : null
  }`;
});

export const fleetDelayed = wrap("Delayed", (s, v) => {
  const w = s.waiting;
  if (!w || w.unreachable || !Array.isArray(w.rows))
    return html`<p>The waiting jobs could not be read.</p>`;
  const cancellable = (r) =>
    r.attemptsMade === 0 && r.stalled === 0 && !r.recovery && !r.schedulerNext;
  return html`<p> ${list(s.schedulers).length} cron schedules; ${
    s.held?.unreachable
      ? "unreadable"
      : list(s.held?.rows).length + Number(s.held?.more ?? 0)
  } held jobs. Other jobs are grouped by the reason their worker recorded. </p> ${DEFER_BUCKETS.map(
    (bucket) => {
      const rows = w.rows.filter((r) => (r.bucket ?? "none") === bucket);
      return rows.length
        ? html`<h3>${DEFER_BUCKET_WORDS[bucket].title}</h3> ${ui.tbl({
            label: DEFER_BUCKET_WORDS[bucket].title,
            stack: true,
            heads: [
              "Project",
              "Job",
              "Why it waits",
              ...(canAct(v) ? ["Action"] : []),
            ],
            rows: rows.map((r) => [
              project(r.project),
              runLink(r.jobId),
              html`${waitingSentence(r)}${
                r.why === "host-budget" && r.host
                  ? html`<p> ${linkHost(r.host)}: host budget (${r.budgetWhy ?? "dimension not recorded"}). Asks again about every 9 seconds and keeps its place. </p>`
                  : null
              }`,
              ...(canAct(v)
                ? [
                    cancellable(r)
                      ? jobAct(v, "cancel-queued", "Cancel", r)
                      : "Already started or scheduled",
                  ]
                : []),
            ]),
          })}`
        : null;
    },
  )}${w.truncated ? html`<p class="note">${WAITING_CUT_TEXT}</p>` : null} <details> <summary>What can delay a job, and when it asks again</summary> <ul> ${Object.entries(
    DEFER_WHYS,
  ).map(
    ([why, d]) =>
      html`<li><span class="code">${why}</span>: ${d.sentence.replace(/\{([a-z]+)\}/g, (_match, name) => ({ host: "the host", until: "its next scheduled check", holder: "the preceding run", endpoint: "the model endpoint", attempt: "the current attempt", attempts: "the allowed attempts", due: "its due time" })[name] ?? `its ${name}`)}</li>`,
  )} </ul> <p> Pause windows move to their end and reserve nothing. Retry backoff starts at 60 seconds and grows; scope and host slots ask after 5 seconds, endpoints after 7 seconds, host budget about every 9 seconds (keeping its place), and never-fits after 60 seconds for another host. </p> </details>`;
});

export const fleetHosts = wrap("Hosts", (s, v) => {
  const hosts = list(s.hostBudgets);
  const busy = hosts.reduce((n, h) => n + list(h.jobs).length, 0);
  const complete = !s.queue?.fleetDegraded && hosts.every((h) => Array.isArray(h.jobs) && h.jobsMore === 0 && !h.jobsUnreadable && Number.isSafeInteger(Number(h.concurrency)) && h.concurrency !== null && h.concurrency !== "");
  return html`${s.queue?.fleetDegraded ? html`<p>${REGISTRY_UNREAD_TEXT}</p>` : null}<p> ${hosts.filter((h) => beatAgeOf(h) !== null && beatAgeOf(h) <= 60000).length} beating, ${complete ? `${busy} of ${hosts.reduce((n, h) => n + Number(h.concurrency), 0)} slots busy` : `${busy} listed jobs hold slots; total occupancy is not known`}. </p> ${ui.tbl(
    {
      label: "Hosts",
      stack: true,
      heads: [
        "Host",
        "Venues",
        "Slots",
        "Budget",
        "Running jobs",
        "Routes",
        "Heartbeat",
      ],
      rows: hosts.map((h) => {
        const jobs = list(h.jobs);
        const held = jobs.filter((j) => j.o).length;
        const memory = Number(h.budgetMemMiB);
        const cpu = Number(h.budgetCpuCenti);
        return [
          linkHost(h.name),
          list(h.backends?.blessed)
            .map((n) => `${n}${h.backends?.default === n ? " (default)" : ""}`)
            .join(", ") || "not published",
          s.queue?.fleetDegraded ||
          h.jobsUnreadable ||
          !Array.isArray(h.jobs) ||
          h.jobsMore ||
          beatAgeOf(h) === null ||
          beatAgeOf(h) > 60000
            ? "Free slots not known"
            : ui.slots({
                run: jobs.length - held,
                hold: held,
                free: Math.max(0, Number(h.concurrency ?? 0) - jobs.length),
              }),
          html`${
            memory > 0
              ? html`<p> ${
                  h.usedMemMiB !== "" && h.usedMemMiB !== undefined
                    ? Number(h.usedMemMiB) / 1024
                    : "unknown"
                } of ${memory / 1024} GiB </p> ${
                  h.usedMemMiB !== "" && h.usedMemMiB !== undefined
                    ? ui.meter({
                        value: Number(h.usedMemMiB),
                        max: memory,
                        label: "Memory",
                      })
                    : null
                }`
              : null
          }${
            cpu > 0
              ? html`<p> ${
                  h.usedCpuCenti !== "" && h.usedCpuCenti !== undefined
                    ? Number(h.usedCpuCenti) / 100
                    : "unknown"
                } of ${cpu / 100} cores </p> ${
                  h.usedCpuCenti !== "" && h.usedCpuCenti !== undefined
                    ? ui.meter({
                        value: Number(h.usedCpuCenti),
                        max: cpu,
                        label: "CPU",
                      })
                    : null
                }`
              : null
          }${
            h.budgetCpuCenti === "off"
              ? html`<p>CPU budget off.</p>`
              : h.budgetCpuCenti && !Number.isFinite(cpu)
                ? html`<p>CPU budget unreadable.</p>`
                : null
          }${
            !(memory > 0) && !(cpu > 0)
              ? "This host reports no memory or CPU figures"
              : null
          }`,
          html`${jobs.map(
            (j) =>
              html`<p> ${runLink(j.id)}${j.o ? " (orphaned hold)" : ""}${
                j.at ? ` ${ageText(v.now - j.at)}` : ""
              } </p>`,
          )}`,
          h.routes === false || h.routes === "false"
            ? "Shared jobs only"
            : "Routed and shared jobs",
          beatAgeOf(h) > 60000
            ? `Heartbeat late: ${ageText(beatAgeOf(h))} (expected within 1m)`
            : ageText(beatAgeOf(h)),
        ];
      }),
      empty: "No host is registered.",
    },
  )}`;
});

export const fleetDoctor = wrap("Doctor", (s, v) => {
  if (!s.doctor || s.doctor.unreachable)
    return html`<p>The published doctor results could not be read.</p>`;
  const rows = doctorHostsOf(s);
  const silent = list(s.hostBudgets).filter(
    (h) => !rows.some((r) => r.name === h.name),
  );
  return html`${rows.map((r) => {
    const problems = doctorProblems(r);
    const hidden =
      Math.max(0, problems.length - DOCTOR_CHECKS_SHOWN) + Number(r.more ?? 0);
    return html`<h3>${linkHost(r.name)}</h3> ${
      r.unreadable
        ? html`<p> Its published result cannot be read (a worker of another version may have written it). </p>`
        : html`<p class="${
            r.counts?.fail
              ? "tone-failed"
              : r.counts?.warn
                ? "tone-attention"
                : "tone-ok"
          }" > Doctor ran ${ageText(r.ageMs)} ago, ${doctorByText(r)}: ${doctorCountsText(r)}. Worker ${r.version ?? "version not published"}. ${r.openshell ? "The openshell venue was judged." : null}</p> ${
            doctorStale(r)
              ? html`<p> Stale: older than two of this host's doctor runs (every ${r.every}h). </p>`
              : null
          }${
            r.workerRun && !r.by?.worker
              ? html`<p> It replaced the worker's own run${
                  r.workerRun.uid !== undefined
                    ? ` (uid ${r.workerRun.uid})`
                    : ""
                }, so it shows another account's view of the host. </p>`
              : null
          }${problems.length ? problems.slice(0, DOCTOR_CHECKS_SHOWN).map((c) => html`<div class="card card--tint ${c.level === "fail" ? "tone-failed" : "tone-attention"}"><h4><span class="code">${c.id}</span>: ${c.level === "fail" ? "failing" : "warning"}</h4><p>${c.label}</p>${c.fix ? html`<p>Fix: ${c.fix}</p>` : null}</div>`) : html`<p>Every check passed.</p>`}${
            hidden
              ? html`<p> ${hidden} more not shown here; doctor on that host prints them all. </p>`
              : null
          }`
    }${v.role === "operator" ? ui.cmd(["pi-dispatch", "doctor"], { host: r.name }) : html`<p>Run doctor on this host to inspect these checks.</p>`}`;
  })}${silent.map((h) => (v.role === "operator" ? ui.cmd(["pi-dispatch", "doctor"], { host: h.name }) : html`<p>Run doctor on ${h.name} to publish its result.</p>`))}${
    silent.length
      ? html`<p> No doctor result published by: ${silent.map((h) => h.name).join(", ")}. </p>`
      : null
  }${
    !rows.length
      ? html`<p> No host has published doctor results yet. Each worker runs doctor a minute after it starts and then every PI_DOCTOR_INTERVAL_HOURS (24 by default). </p>`
      : null
  }${
    s.doctor.more
      ? html`<p> ${s.doctor.more} more hosts published results; not every one is read. </p>`
      : null
  }`;
});

export const fleetVenues = wrap("Venues", (s) => {
  const m = venuesView(list(s.hostBudgets));
  return html`${ui.tbl({
    label: "Venue summary",
    stack: true,
    heads: [VENUE_LABEL, "Blessed on", "Default on", "Floor", "Gateway"],
    rows: m.venues.map((x) => [
      html`<a href="${venueHref(x.name)}">${ui.vtag(x.name)}</a>`,
      x.blessedOn.join(", ") || "no live host",
      x.defaultOn.join(", ") || "no live host",
      m.floors
        .filter((f) => x.blessedOn.includes(f.host))
        .map((f) => f.host)
        .join(", ") || "none",
      list(x.openshell)
        .map(
          (o) =>
            `${o.host}: ${o.unpublished ? "not published" : (GATEWAY_TEXT[o.gateway] ?? GATEWAY_TEXT.unknown)}`,
        )
        .join("; ") || "no gateway",
    ]),
    empty: "No venue in this build.",
  })}${ui.tbl({
    label: "Venue declaration matrix",
    heads: [
      "Property",
      ...m.venues.map(
        (x) => html`<a href="${venueHref(x.name)}">${x.name}</a>`,
      ),
    ],
    rows: [
      ...(m.venues[0]?.properties ?? [])
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => ["egress", "localFolders"].includes(p.property))
        .map(({ p, i }) => [
          p.label,
          ...m.venues.map((x) =>
            html`<span class="vw vw--${x.properties[i].word}">${ui.chip(x.properties[i].word, {
              status: x.properties[i].word === "enforced" ? "ok" : null,
              icon: x.properties[i].word === "enforced" ? "shield" : x.properties[i].word === "asserted" ? "done" : "minus",
            })}</span>`,
          ),
        ]),
      ...(m.venues[0]?.serves ?? []).map((sv, i) => [
        sv.key,
        ...m.venues.map((x) => x.serves[i].word),
      ]),
      ["Credentials", ...m.venues.map((x) => x.custodyText)],
    ],
  })} <p class="note"> Enforced is enforced by the boundary, asserted relies on a named assertion, absent promises nothing. Open a venue for all properties, asserters and floors. </p> ${
    m.unpublished.length
      ? html`<p>Not published by ${m.unpublished.join(", ")}.</p>`
      : null
  }`;
});

export const fleetSchedulers = wrap("Schedules", (s, v) =>
  ui.tbl({
    label: "Schedules",
    stack: true,
    heads: [
      "Schedule",
      "Project",
      "Pattern",
      "Next",
      "How far off",
      "Overdue",
      "Stalls",
    ],
    rows: list(s.schedulers).map((x) => {
      const n =
        typeof x.key === "string" ? (s.schedulerStalls?.[x.key] ?? 0) : null;
      return [
        x.key ?? "not recorded",
        project(x.project),
        x.pattern ?? (x.every ? `every ${x.every} ms` : "not recorded"),
        x.next ? timeHtml(x.next) : "not recorded",
        x.next ? ageText(Math.abs(x.next - v.now)) : "unknown",
        x.overdueMs ? ageText(x.overdueMs) : "no",
        n === null ? "unknown" : `${n} of ${s.schedulerStallMax ?? "unknown"}`,
      ];
    }),
    empty: "No schedule is registered.",
  }),
);

export function failedWhy(r) {
  if (!r?.hasRecord && !r?.reason)
    return html`<span class="note">no record</span>`;
  if (!r.reason)
    return html`<span class="note">Its run record names no reason.</span>`;
  const words = reasonWords(r.reason);
  return words.known
    ? html`Its run record says: ${words.sentence}${words.next ? html` Next: ${words.next}` : null}`
    : html`Its run record says: <span class="code">${r.reason}</span>, this console has no explanation for this reason.`;
}

export const fleetFailed = wrap("Failed jobs", (s, v) => {
  const f = s.failed;
  if (!f || f.unreachable)
    return html`<p>The failed jobs could not be read.</p>`;
  const rows = list(f.rows);
  const filters = (action) => html`${[
    ["queue", "Only queue", null],
    ["repo", "Only repository", "owner/name"],
  ].map(([name, label, placeholder]) => {
    const id = `failed-${action}-${name}`;
    return ui.field({ label, id, control: ui.input({ id, name, placeholder }) });
  })}`;
  const bulk = canAct(v) && rows.length
    ? html`<details><summary>Retry or remove failed jobs in bulk</summary><form class="act" data-action="retry-all-failed">${filters("retry")}${ui.btn({ type: "submit", kind: ["paid", "sm"], label: "Retry all" })}</form><form class="act" data-action="remove-all-failed">${filters("remove")}${ui.btn({ type: "submit", kind: ["danger", "sm"], label: "Remove all" })}</form></details>`
    : null;
  return html`${ui.tbl({
    label: "Failed jobs",
    stack: true,
    heads: [
      "Job",
      "Queue",
      "Target",
      "Attempts",
      "Failed",
      "Why (its record)",
      ...(canAct(v) ? ["Action"] : []),
    ],
    rows: rows.map((r) => [
      runLink(r.jobId),
      r.queue,
      r.target ?? "no target recorded",
      `${r.attemptsMade ?? "unknown"} of ${r.attempts ?? "unknown"}`,
      r.endedAt ? timeHtml(r.endedAt) : "unknown",
      failedWhy(r),
      ...(canAct(v)
        ? [
            html`${jobAct(v, "retry-failed", "Retry", r)}${jobAct(
              v,
              "remove-failed",
              "Remove",
              r,
            )}`,
          ]
        : []),
    ]),
    empty: "No failed job is kept by the queue.",
  })}${bulk}${f.more ? html`<p>${f.more} more failed.</p>` : null}${
    v.role === "operator"
      ? html`<h3>Why each failed</h3> ${rows.map(
          (r) =>
            html`<details> <summary class="code">${r.jobId}</summary> <p class="code">${r.failedReason}</p> </details>`,
        )}`
      : html`<p class="note">Failure reasons are shown to operators only.</p>`
  }`;
});
