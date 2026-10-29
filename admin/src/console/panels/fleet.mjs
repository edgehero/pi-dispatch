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
/** The card frame is the design's: tables flush to the edge, inset cards keep their padding. */
const wrap =
  (title, fn, { flush = false, sub = null, end = null } = {}) =>
  (view) => {
    const snapshot = view.data?.snapshot;
    return ui.card({
      title,
      flush,
      sub: typeof sub === "function" ? sub(snapshot, view) : sub,
      end: snapshot && typeof end === "function" ? end(snapshot, view) : end,
      body: snapshot
        ? fn(snapshot, view)
        : html`<p class="note">The deployment's Valkey could not be read. The next refresh tries again.</p>`,
    });
  };
const act = (view, action, label, hidden = [], { small = true } = {}) =>
  canAct(view)
    ? ui.actForm({
        action,
        label,
        hidden,
        kind: [
          action.startsWith("retry") || action.endsWith("resume")
            ? "paid"
            : "danger",
          ...(small ? ["sm"] : []),
        ],
        icon: action.endsWith("pause")
          ? "pause"
          : action.endsWith("resume")
            ? "play"
            : action.startsWith("retry")
              ? "rerun"
              : action.startsWith("cancel")
                ? "cancel"
                : null,
      })
    : null;
const rowNumber = (n, status = null) =>
  Number.isFinite(n)
    ? n > 0
      ? html`<b class="${status ? `tinted tone-${status}` : ""}">${n}</b>`
      : html`<span class="faint">0</span>`
    : "not read";
const headerSub = (rows, singular, plural = `${singular}s`) =>
  `${list(rows).length} ${list(rows).length === 1 ? singular : plural}`;
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

export const fleetBar = (v) => {
  const s = v.data?.snapshot;
  if (!s)
    return ui.card({
      title: "Fleet",
      body: html`<p>The deployment's Valkey could not be read. The next refresh tries again.</p>`,
    });
  const queues = list(s.queueCounts);
  const paused = queues.filter((q) => q.paused);
  const running = queues.filter((q) => !q.paused);
  const partial = paused.length > 0 && running.length > 0;
  const allPaused = queues.length > 0 && paused.length === queues.length;
  const online = workersOnline(s);
  const mismatch = v.data?.killSwitch;
  const count = (key) =>
    Number.isFinite(s.queue?.counts?.[key])
      ? s.queue.counts[key]
      : queues.length && queues.every((q) => Number.isFinite(q.counts?.[key]))
        ? queues.reduce((n, q) => n + q.counts[key], 0)
        : "not read";
  const title = !queues.length
    ? "Queue state not read"
    : partial
      ? `Part paused: ${paused.length} of ${queues.length} queues are paused`
      : allPaused
        ? "The fleet is paused"
        : "The fleet is running";
  const statistic = (value, label, tone = null) =>
    html`<span${tone ? html` class="tinted tone-${tone}"` : null}><b>${value}</b> ${label}</span>`;
  const held =
    !s.held || s.held.unreachable
      ? "unreadable"
      : list(s.held.rows).length + Number(s.held.more ?? 0);
  return ui.card({
    ring: partial ? "attention" : null,
    body: html`<div class="fl-bar"><div class="fl-bar__row">${ui.tile(partial || allPaused ? "attention" : "ok", { icon: partial || allPaused ? "pause" : "fleet" })}<div class="fl-bar__t"><h2>${title}</h2><p class="muted">${online.online ?? "unknown"} hosts beat, ${running.length} queues accept jobs. Valkey <span class="code">${s.valkey ?? "the deployment's Valkey"}</span></p>${partial ? html`<p class="muted">Starts nothing new: ${paused.map((q) => q.queue).join(", ")}. Keeps starting jobs: ${running.map((q) => q.queue).join(", ")}.</p>` : null}</div><div class="fl-bar__stats">${statistic(count("waiting"), "waiting")}${
      partial
        ? statistic(
            paused.reduce(
              (n, q) =>
                n +
                Number(q.counts?.waiting ?? 0) +
                Number(q.counts?.paused ?? 0),
              0,
            ),
            "in paused queues",
            "attention",
          )
        : null
    }${statistic(count("active"), "active")}${statistic(count("delayed"), "delayed")}${statistic(held, "held")}${statistic(count("failed"), "awaiting retry", "failed")}</div><div class="fl-bar__btns">${partial ? act(v, "fleet-resume", "Resume the fleet", [], { small: false }) : null}${running.length || !queues.length ? act(v, "fleet-pause", "Pause the fleet", [], { small: false }) : null}${allPaused ? act(v, "fleet-resume", "Resume the fleet", [], { small: false }) : null}</div></div>${s.queue?.fleetDegraded ? ui.banner({ status: "attention", title: "Registry not read", body: html`${REGISTRY_UNREAD_TEXT} Registry rows last read ${s.hostsReadAt ? timeHtml(s.hostsReadAt) : "at an unknown time"}.`, sm: true }) : null}${!paused.length && online.none ? ui.banner({ status: "attention", title: NO_WORKER_TEXT, sm: true }) : online.staleBeats ? html`<p class="muted">${STALE_BEATS_TEXT}</p>` : null}${mismatch?.disagreement ? ui.banner({ status: "attention", title: "Two Valkeys: this console and the service disagree",
          block: true, body: html`<p>${mismatch.disagreement}</p><p>A pause reaches both; a resume neither until they agree.</p>`, sm: true }) : null}${mismatch?.refused ? html`<div class="pp-refusal tone-refused" role="region" aria-label="Resume refused"><p class="pp-refusal__h">${ui.icon("refused")}Refused: Resume the fleet</p><p>${mismatch.refused}</p>${v.role === "operator" && Array.isArray(mismatch.resumeArgv) ? ui.cmd(mismatch.resumeArgv) : null}<p><b>Nothing was changed.</b> One queue can still be resumed on the Valkey this console read it from.</p></div>` : mismatch?.disagreement && v.role === "operator" && Array.isArray(mismatch.resumeArgv) ? ui.cmd(mismatch.resumeArgv) : null}<p class="pp-src">${ui.icon("beat", { size: "sm" })}<span>Read ${ageText(Math.max(0, v.now - Number(s.at ?? s.readAt ?? v.now)))} ago from <span class="code">${s.valkey ?? "the deployment's Valkey"}</span> and ${list(s.hostBudgets).length} hosts' registry rows. Live: this panel redraws when the fleet changes.</span></p></div>`,
  });
};

export const fleetQueues = wrap(
  "Queues",
  (s, v) =>
    ui.tbl({
      label: "Queues",
      stack: true,
      heads: [
        "Queue",
        "State",
        ...["Waiting", "Active", "Delayed", "Paused", "Failed"].map(
          (label) => ({ label, num: true }),
        ),
        ...(canAct(v) ? [{ label: "Action", l: "" }] : []),
      ],
      rows: list(s.queueCounts).map((q) => ({
        mark: q.paused ? "attention" : null,
        cells: [
          html`<span class="code"><b>${q.queue}</b></span><span class="reason">${q.queue === "pi-jobs" ? `shared by ${list(s.hostBudgets).length} hosts` : q.paused ? "Its host still takes shared jobs." : "its host's own queue"}</span>`,
          ui.chip(q.paused ? "Paused" : "Running", {
            status: q.paused ? "attention" : "ok",
            icon: q.paused ? "pause" : "play",
          }),
          ...["waiting", "active", "delayed", "paused", "failed"].map((key) =>
            rowNumber(q.counts?.[key], key === "failed" ? "failed" : null),
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
  { flush: true, sub: "Pause stops new starts; running jobs finish" },
);

export const fleetActive = wrap(
  "Active jobs",
  (s, v) => {
    const rows = list(s.active).map((j) => {
      const p = j.progress;
      const has = p && !p.ended && !p.absent;
      const progress = has
        ? html`<div class="fl-prog">${p.phase?.count ? ui.phases({ names: Array.from({ length: Math.min(64, p.phase.count) }, (_, i) => `Phase ${i + 1}`), index: p.phase.index }) : null}<span class="reason">${progressText(p, v.now)}</span></div>`
        : html`<div class="fl-prog">${ui.noProgress("This worker reports no progress")}</div>`;
      return [
        runLink(j.jobId),
        project(j.project),
        html`<span class="faint">shown when the run ends</span>`,
        linkHost(j.host),
        j.startedAt ? timeHtml(j.startedAt) : "not published",
        j.startedAt ? ageText(v.now - j.startedAt) : "unknown",
        progress,
        ...(canAct(v) ? [jobAct(v, "cancel-active", "Cancel", j)] : []),
      ];
    });
    const orphan = orphanRows(s).map((j) => ({
      mark: "attention",
      cells: [
        runLink(j.id),
        project(j.p),
        html`<span class="faint">shown when the run ends</span>`,
        linkHost(j.host.name),
        j.s ? timeHtml(j.s) : "stop time not published",
        "Still holds a slot",
        html`<div class="fl-prog"><b class="tinted tone-attention">${ui.icon("attention", { size: "sm" })} Orphaned hold</b><span class="reason">Its stop did not take${j.s ? html` at ${timeHtml(j.s)}` : ""}, but it still holds a ${j.host.name} slot. ${j.host.name} runs ${list(j.host.jobs).filter((x) => !x.o).length} jobs where it could run ${j.host.concurrency}.</span></div>`,
        ...(canAct(v)
          ? [
              ui.btn({
                kind: ["danger", "sm"],
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
        "Job",
        "Project",
        "Target",
        "Host",
        "Started",
        { label: "Running for", num: true },
        "Progress",
        ...(canAct(v) ? [{ label: "Action", l: "" }] : []),
      ],
      rows: [...rows, ...orphan],
      empty: "Nothing is running.",
    });
  },
  {
    flush: true,
    sub: (s) =>
      s
        ? `${list(s.active).length} running, ${orphanRows(s).length} slots held by orphans`
        : null,
  },
);

const answerView = (answer) =>
  answer === "go"
    ? { text: "Met", status: "ok", icon: "done" }
    : answer === "hold"
      ? { text: "Not yet", status: "idle", icon: "hourglass" }
      : answer === "refuse"
        ? { text: "Refused", status: "refused", icon: "refused" }
        : answer === "fault"
          ? { text: "Fault", status: "attention", icon: "attention" }
          : { text: "Unclear", status: "attention", icon: "attention" };
export const fleetHeld = wrap(
  "Held",
  (s, v) => {
    if (!s.held || s.held.unreachable)
      return html`<p>The held jobs could not be read.</p>`;
    const rows = [...list(s.held.rows)].sort(
      (a, b) => (b.waitedMs ?? 0) - (a.waitedMs ?? 0),
    );
    return html`${rows.map(
      (r) =>
        html`<div class="fl-held"><div class="fl-held__h">${runLink(r.jobId)}${project(r.project)}<span>${r.target ?? "no target recorded"}</span><span class="muted">held ${ageText(r.waitedMs)}</span><span class="muted">${r.checks ?? 0} of ${s.waitMaxChecks ?? 96} checks</span><span class="end">${jobAct(v, "cancel-held", "Cancel", r)}</span></div><p class="card__sub">${r.label ?? "Conditions not published"}</p><p class="card__sub">It starts when every condition is met. ${r.after ? "After a time" : "Without a time condition"}${
          list(r.answers).length
            ? `, then ${list(r.answers).length} ${list(r.answers).length === 1 ? "check" : "checks"} named ${list(
                r.answers,
              )
                .map((a) => a.profile)
                .join(", ")}`
            : ", with no profile answer published yet"
        }.</p><ul class="fl-cond">${r.after ? html`<li>${ui.icon("clock", { size: "sm" })}<span><b>After ${timeHtml(r.after)}</b><span class="muted">${r.after <= v.now ? "met" : `in ${ageText(r.after - v.now)}`}</span></span>${ui.chip(r.after <= v.now ? "Met" : "Pending", { status: r.after <= v.now ? "ok" : "idle", icon: r.after <= v.now ? "done" : "hourglass" })}</li>` : null}${list(
          r.answers,
        ).map((a) => {
          const state = answerView(a.answer);
          return html`<li>${ui.icon(state.icon, { size: "sm" })}<span><b>${a.profile}</b><span class="muted">${state.text.toLowerCase()}${a.at ? html`, last checked ${timeHtml(a.at)}` : ", no check time published"}</span></span>${ui.chip(state.text, { status: state.status, icon: state.icon })}</li>`;
        })}</ul>${list(r.answers).some((a) => a.answer === "unclear") ? html`<p class="card__sub">${list(r.answers).filter((a) => a.answer === "unclear").length} checks could not tell (${s.waitMaxFaults ?? 5} in a row ends the wait).</p>` : null}</div>`,
    )}${!rows.length ? html`<p>No job is held.</p>` : null}<p class="note">A job starts when every condition is met. Checks spend nothing. A check profile gives up after ${Number(s.waitMaxMs ?? 86400000) / 3600000} hours or ${s.waitMaxChecks ?? 96} checks (wait-expired). A cancelled held job spent nothing while it waited. A check that cannot tell ${s.waitMaxFaults ?? 5} times in a row ends the wait.</p>${s.held.more ? html`<p>${s.held.more} more held.</p>` : null}${s.held.truncated ? html`<p>Not every held job was read.</p>` : null}`;
  },
  {
    sub: (s) =>
      s?.held && !s.held.unreachable ? headerSub(s.held.rows, "job") : null,
    end: (s, v) =>
      list(s.held?.rows).length
        ? act(v, "cancel-all-held", "Cancel every held job")
        : null,
  },
);

export const fleetDelayed = wrap("Delayed", (s, v) => {
  const w = s.waiting;
  if (!w || w.unreachable || !Array.isArray(w.rows))
    return html`<p>The waiting jobs could not be read.</p>`;
  const cancellable = (r) =>
    r.attemptsMade === 0 && r.stalled === 0 && !r.recovery && !r.schedulerNext;
  return html`${ui.kpi(s.queue?.counts?.delayed ?? "not read", "delayed jobs")}<p> ${list(s.schedulers).length} cron schedules; ${
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

const completeHostJobs = (h, snapshot) =>
  !snapshot.queue?.fleetDegraded && Array.isArray(h.jobs) && h.jobsMore === 0 && !h.jobsUnreadable &&
  h.concurrency !== null && h.concurrency !== undefined && h.concurrency !== "" &&
  Number.isSafeInteger(Number(h.concurrency)) && Number(h.concurrency) >= 0 &&
  beatAgeOf(h) !== null && beatAgeOf(h) <= 60000;
const resourceLine = (h, budgetKey, usedKey, label, divisor, units) => {
  const budget = Number(h[budgetKey]);
  const raw = h[usedKey];
  const used =
    raw !== null &&
    raw !== undefined &&
    raw !== "" &&
    Number.isFinite(Number(raw))
      ? Number(raw)
      : null;
  if (!(budget > 0))
    return h[budgetKey] === "off"
      ? html`<span class="fl-res"><span class="fl-res__l">${label}</span><span class="faint">budget off</span></span>`
      : null;
  return html`<span class="fl-res"><span class="fl-res__l">${label}</span>${used !== null ? ui.meter({ value: used, max: budget, label: `${label}: ${used / divisor} of ${budget / divisor} ${units}`, status: "running", height: 8 }) : html`<span class="faint">use not read</span>`}<span class="fl-res__v">${used === null ? "unknown" : used / divisor} of ${budget / divisor} ${units}</span></span>`;
};

export const fleetHosts = wrap(
  "Hosts",
  (s, v) => {
    const hosts = list(s.hostBudgets);
    return html`${s.queue?.fleetDegraded ? html`<p class="note">${REGISTRY_UNREAD_TEXT}</p>` : null}<ul class="hosts">${hosts.map(
      (h) => {
        const jobs = list(h.jobs);
        const orphans = jobs.filter((j) => j.o).length;
        const known = completeHostJobs(h, s);
        const age = beatAgeOf(h);
        const queue = list(s.queueCounts).find(
          (q) => q.queue === `pi-jobs@${h.name}`,
        );
        return html`<li class="hostrow">${ui.dot(age !== null && age <= 60000 ? "ok" : "attention", { label: age === null ? "Heartbeat not known" : age <= 60000 ? "Beating" : "Heartbeat late" })}<span class="hostrow__n"><b>${linkHost(h.name)}</b><span>${
          list(h.backends?.blessed)
            .map(
              (name) =>
                `${name}${h.backends?.default === name ? " (default)" : ""}`,
            )
            .join(", ") || "venues not published"
        }</span></span>${known ? ui.slots({ run: jobs.length - orphans, hold: orphans, free: Math.max(0, Number(h.concurrency ?? 0) - jobs.length) }) : html`<span class="faint">Free slots not known</span>`}<span class="hostrow__beat${age === null || age > 60000 ? " tone-attention" : ""}">${ui.icon("beat", { size: "sm" })}${ageText(age)}</span><span class="hostrow__p">${queue ? act(v, queue.paused ? "queue-resume" : "queue-pause", queue.paused ? "Resume" : "Pause", [["queue", queue.queue]]) : null}</span><span class="hostrow__x">${resourceLine(h, "budgetMemMiB", "usedMemMiB", "Memory", 1024, "GiB")}${resourceLine(h, "budgetCpuCenti", "usedCpuCenti", "CPU", 100, "cores")}${!(Number(h.budgetMemMiB) > 0) && !(Number(h.budgetCpuCenti) > 0) ? html`<span class="faint">This host reports no memory or CPU figures</span>` : null}${h.budgetCpuCenti && h.budgetCpuCenti !== "off" && !Number.isFinite(Number(h.budgetCpuCenti)) ? html`<span class="faint">CPU budget unreadable.</span>` : null}<span>Running ${jobs.length ? jobs.map((j, i) => html`${i ? ", " : null}${runLink(j.id)}${j.o ? " (orphaned hold)" : ""}${j.at ? ` ${ageText(v.now - j.at)}` : ""}`) : h.jobsUnreadable || !Array.isArray(h.jobs) ? "job list unreadable" : "none listed"}${h.jobsMore ? `; ${h.jobsMore} more not listed` : ""}</span><span>Routes: ${h.routes === false || h.routes === "false" ? "Shared jobs only" : "Routed and shared jobs"}</span>${age !== null && age > 60000 ? html`<span class="tinted tone-attention">${ui.icon("attention", { size: "sm" })}Heartbeat late: ${ageText(age)} (expected within 1m)</span>` : null}</span></li>`;
      },
    )}</ul>${!hosts.length ? html`<p>No host is registered.</p>` : null}`;
  },
  {
    sub: (s) => {
      if (!s) return null;
      const hosts = list(s.hostBudgets);
      const busy = hosts.reduce((n, h) => n + list(h.jobs).length, 0);
      const complete =
        !s.queue?.fleetDegraded &&
        hosts.every(
          (h) =>
            Array.isArray(h.jobs) &&
            h.jobsMore === 0 &&
            !h.jobsUnreadable &&
            h.concurrency !== null &&
            h.concurrency !== "" &&
            Number.isSafeInteger(Number(h.concurrency)),
        );
      return `${hosts.filter((h) => beatAgeOf(h) !== null && beatAgeOf(h) <= 60000).length} beating, ${complete ? `${busy} of ${hosts.reduce((n, h) => n + Number(h.concurrency), 0)} slots busy` : `${busy} listed jobs hold slots; total occupancy is not known`}`;
    },
  },
);

const doctorCounts = (r) =>
  html`<span class="fl-cnt"><span class="tinted tone-failed">${ui.icon("failed", { size: "sm" })}<b>${r.counts?.fail ?? 0}</b> failing</span><span class="tinted tone-attention">${ui.icon("attention", { size: "sm" })}<b>${r.counts?.warn ?? 0}</b> warning</span><span class="tinted tone-ok">${ui.icon("done", { size: "sm" })}<b>${r.counts?.ok ?? 0}</b> passing</span></span>`;
export const fleetDoctor = wrap(
  "Doctor",
  (s, v) => {
    if (!s.doctor || s.doctor.unreachable)
      return html`<p>The published doctor results could not be read.</p>`;
    const rows = doctorHostsOf(s);
    const silent = list(s.hostBudgets).filter(
      (h) => !rows.some((r) => r.name === h.name),
    );
    return html`${rows.map((r) => {
      const problems = doctorProblems(r);
      const hidden =
        Math.max(0, problems.length - DOCTOR_CHECKS_SHOWN) +
        Number(r.more ?? 0);
      return html`<div class="fl-doc"><div class="fl-doc__h"><b>${linkHost(r.name)}</b>${r.unreadable ? html`<span class="faint">Result unreadable</span>` : doctorCounts(r)}</div>${r.unreadable ? html`<p class="muted fl-doc__p">Its published result cannot be read (a worker of another version may have written it).</p>` : html`<p class="muted fl-doc__p">Doctor ran ${ageText(r.ageMs)} ago, ${doctorByText(r)}: ${doctorCountsText(r)}. Worker ${r.version ?? "version not published"}. ${r.openshell ? "The openshell venue was judged." : null}</p>${doctorStale(r) ? ui.banner({ status: "attention", title: `Stale: this result is ${ageText(r.ageMs)} old`, body: html`Older than two of this host's doctor runs (every ${r.every}h), so it may no longer describe the host. Version ${r.version ?? "not published"}, ${doctorByText(r)}.`, sm: true, icon: "clock" }) : null}${r.workerRun && !r.by?.worker ? html`<p class="muted fl-doc__p">It replaced the worker's own run${r.workerRun.uid !== undefined ? ` (uid ${r.workerRun.uid})` : ""}, so it shows another account's view of the host.</p>` : null}${problems.length ? html`<ul class="fl-chks">${problems.slice(0, DOCTOR_CHECKS_SHOWN).map((c) => html`<li class="fl-chk">${ui.chip(c.level === "fail" ? "Failing" : "Warning", { status: c.level === "fail" ? "failed" : "attention", icon: c.level === "fail" ? "failed" : "attention" })}<span class="code">${c.id}</span><span class="fl-chk__said">${c.label}</span>${c.fix ? html`<span class="fl-chk__fix"><b>Fix:</b> ${c.fix}</span>` : null}</li>`)}</ul>` : html`<p class="muted fl-doc__p">Every check passed.</p>`}${hidden ? html`<p class="muted fl-doc__p">${hidden} more not shown here; doctor on that host prints them all.</p>` : null}`}${v.role === "operator" ? ui.cmd(["pi-dispatch", "doctor"], { host: r.name }) : html`<p class="muted fl-doc__p">Run doctor on this host to inspect these checks.</p>`}</div>`;
    })}${silent.map((h) => html`<div class="fl-doc"><div class="fl-doc__h"><b>${linkHost(h.name)}</b><span class="faint">No doctor result published</span></div><p class="muted fl-doc__p">Run doctor on ${h.name} so this page can describe it.</p>${v.role === "operator" ? ui.cmd(["pi-dispatch", "doctor"], { host: h.name }) : null}</div>`)}${silent.length ? html`<p class="note">No doctor result published by: ${silent.map((h) => h.name).join(", ")}.</p>` : null}${!rows.length ? html`<p class="note">No host has published doctor results yet. Each worker runs doctor a minute after it starts and then every PI_DOCTOR_INTERVAL_HOURS (24 by default).</p>` : null}${s.doctor.more ? html`<p>${s.doctor.more} more hosts published results; not every one is read.</p>` : null}`;
  },
  { sub: "each host's latest health check" },
);

const declarationChip = (p) =>
  html`<span class="vw vw--${p.word}">${ui.chip(p.word, { status: p.word === "enforced" ? "ok" : null, icon: p.word === "enforced" ? "shield" : p.word === "asserted" ? "done" : "minus" })}</span>`;
const servesChip = (feature) =>
  html`<span class="chip ${feature.word === "image" ? "fl-asserted" : feature.word === "no" ? "fl-absent" : "tone-ok"}">${ui.icon(feature.word === "yes" ? "done" : feature.word === "no" ? "minus" : "info")}${feature.word === "image" ? "with the image" : feature.word}</span>`;
export const fleetVenues = wrap(
  "Venues",
  (s) => {
    const m = venuesView(list(s.hostBudgets));
    const property = (venue, key) =>
      venue.properties.find((p) => p.property === key);
    const feature = (venue, key) => venue.serves.find((s) => s.key === key);
    return html`${ui.tbl({ label: "Venue properties and what each venue serves", heads: [VENUE_LABEL, "Blessed on", "Default on", "Egress", "Local folders", "Steering", "Live transcript", "Recovery", "Sandbox shell", "Credentials held by"], rows: m.venues.map((x) => [html`<b>${runVenueLink(x.name)}</b><span class="reason">${x.describe}</span>`, x.blessedOn.join(", ") || "no live host", x.defaultOn.join(", ") || "no live host", declarationChip(property(x, "egress")), declarationChip(property(x, "localFolders")), servesChip(feature(x, "steering")), servesChip(feature(x, "liveTranscript")), servesChip(feature(x, "recovery")), servesChip(feature(x, "sandboxShell")), x.custody === "layer" ? "the venue's egress layer" : "the container"]), empty: "No venue in this build." })}<div class="fl-vfoot"><span>${ui.icon("shield", { size: "sm" })}Enforced: the worker builds and verifies the boundary.</span><span>Asserted: relies on a named assertion.</span><span>Absent: promises nothing.</span>${m.floors.map(
      (f) =>
        html`<span class="fl-floor">Floor on ${f.host}: <span class="code">${Object.entries(
          f.floor,
        )
          .map(([key, word]) => `${key}=${word}`)
          .join(", ")}</span></span>`,
    )}<a class="link" href="${venueHref("local")}#p-venue-compare">All 14 properties</a></div>${m.unpublished.length ? html`<p class="note">Not published by ${m.unpublished.join(", ")}.</p>` : null}<details class="pp-pad"><summary>OpenShell setup published by the hosts</summary>${m.venues.flatMap((x) => list(x.openshell).map((o) => html`<p class="note">${x.name} on ${o.host}: ${o.unpublished ? "not published" : (GATEWAY_TEXT[o.gateway] ?? GATEWAY_TEXT.unknown)}.</p>`))}</details>`;
  },
  {
    flush: true,
    sub: "published by each host's worker when it started; nothing here is read live",
  },
);
const runVenueLink = (name) =>
  html`<a class="code" href="${venueHref(name)}">${name}</a>`;

export const fleetSchedulers = wrap(
  "Schedules",
  (s, v) =>
    ui.tbl({
      label: "Schedules",
      stack: true,
      heads: [
        "Schedule",
        "Project",
        "Pattern",
        "Next",
        "Overdue",
        { label: "Stalls", num: true },
      ],
      rows: list(s.schedulers).map((x) => {
        const n =
          typeof x.key === "string" ? (s.schedulerStalls?.[x.key] ?? 0) : null;
        return [
          html`<span class="code"><b>${x.key ?? "not recorded"}</b></span>`,
          project(x.project),
          html`<span class="code">${x.pattern ?? (x.every ? `every ${x.every} ms` : "not recorded")}</span>`,
          x.next
            ? html`${timeHtml(x.next)}<span class="reason">${x.next > v.now ? "in " : "overdue by "}${ageText(Math.abs(x.next - v.now))}</span>`
            : "not recorded",
          x.overdueMs ? ageText(x.overdueMs) : "no",
          n === null
            ? "unknown"
            : `${n} of ${s.schedulerStallMax ?? "unknown"}`,
        ];
      }),
      empty: "No schedule is registered.",
    }),
  { flush: true, sub: (s) => (s ? headerSub(s.schedulers, "schedule") : null) },
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

export const fleetFailed = wrap(
  "Failed jobs",
  (s, v) => {
    const f = s.failed;
    if (!f || f.unreachable)
      return html`<p>The failed jobs could not be read.</p>`;
    const rows = list(f.rows);
    const filters = (action) =>
      html`${[
        ["queue", "Only queue", null],
        ["repo", "Only repository", "owner/name"],
      ].map(([name, label, placeholder]) => {
        const id = `failed-${action}-${name}`;
        return ui.field({
          label,
          id,
          control: ui.input({ id, name, placeholder }),
        });
      })}`;
    const bulk =
      canAct(v) && rows.length
        ? html`<details><summary>Retry or remove failed jobs in bulk</summary><form class="act" data-action="retry-all-failed">${filters("retry")}${ui.btn({ type: "submit", kind: ["paid", "sm"], label: "Retry all" })}</form><form class="act" data-action="remove-all-failed">${filters("remove")}${ui.btn({ type: "submit", kind: ["danger", "sm"], label: "Remove all" })}</form></details>`
        : null;
    return html`${ui.tbl({
      label: "Failed jobs",
      stack: true,
      heads: [
        "Job",
        "Queue",
        "Target",
        { label: "Attempts", num: true },
        "Failed",
        ...(canAct(v) ? ["Action"] : []),
      ],
      rows: rows.map((r) => [
        {
          html: html`${runLink(r.jobId)}<span class="reason fl-why">${failedWhy(r)}</span>`,
          wide: true,
        },
        r.queue,
        r.target ?? "no target recorded",
        `${r.attemptsMade ?? "unknown"} of ${r.attempts ?? "unknown"}`,
        r.endedAt ? timeHtml(r.endedAt) : "unknown",
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
    })}<div class="pp-pad">${bulk}${f.more ? html`<p>${f.more} more failed.</p>` : null}${
      v.role === "operator"
        ? html`<h3>Why each failed</h3> ${rows.map(
            (r) =>
              html`<details> <summary class="code">${r.jobId}</summary> <p class="code">${r.failedReason}</p> </details>`,
          )}`
        : html`<p class="note">Failure reasons are shown to operators only.</p>`
    }</div>`;
  },
  {
    flush: true,
    sub: "kept by the queue until you retry or remove",
    end: (s, v) =>
      list(s.failed?.rows).length
        ? html`${act(v, "retry-all-failed", `Retry all ${list(s.failed.rows).length}`)}${act(v, "remove-all-failed", `Remove all ${list(s.failed.rows).length}`)}`
        : null,
  },
);
