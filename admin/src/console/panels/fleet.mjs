/**
 * The fleet screen's panels, split out of `../panels.mjs` (issue #737), which re-exports what this module exports. The
 * rules every panel keeps (one pure, deterministic renderer per region, every value through `html`, the role and
 * run-text rule, the action controls and the PATHS rule) are stated once, in `../panels.mjs`'s header.
 */
import { GATEWAY_TEXT, OPENSHELL_UNPUBLISHED_TEXT, venuesView } from "../../read-model.mjs";
import { coresText } from "@edgehero/pi-dispatch/size-suggest";
import { formatCpus } from "@edgehero/pi-dispatch/job-size";
import { HELD_LABEL, NO_EXPLANATION, reasonWords } from "../../words.mjs";
import { html } from "../html.mjs";
import { DOCTOR_CHECKS_SHOWN, doctorByText, doctorCountsText, doctorHostsOf, doctorProblems, doctorStale } from "../../doctor-view.mjs";
import { cell, ageText, timeHtml, count, RUN_ID_RE, runLink, canAct, actForm, field, editor, table, facts, fromSnapshot, pausedState, workersOnline, beatAgeOf, beatCell, blessedText, activeTable, bannerCut } from "./common.mjs";

// ---- fleet -----------------------------------------------------------------------------------------------------------

const COUNT_KEYS = Object.freeze(["waiting", "active", "delayed", "paused", "failed"]);

export const fleetQueues = fromSnapshot("Queues", (s, view) => {
  const rows = Array.isArray(s.queueCounts) ? s.queueCounts : [];
  const act = canAct(view);
  // The kill switch for the whole fleet: pause unless it is paused, resume unless it is running (both when partial).
  const q = s.queue ?? {};
  const fleet = act ? html`<div class="bar">${q.pausedState ? null : actForm("fleet-pause", { label: "Pause the fleet" })}${q.pausedState || q.pausedPartial ? actForm("fleet-resume", { label: "Resume the fleet" }) : null}</div>` : null;
  const one = (row) => (act && typeof row.queue === "string" ? html`<td>${actForm(row.paused ? "queue-resume" : "queue-pause", { hidden: [["queue", row.queue]], label: row.paused ? "Resume" : "Pause" })}</td>` : act ? html`<td>-</td>` : null);
  // Issue #710: the overview's rule, so the two pages never disagree on whether the queue is being drained.
  return html`${facts([["Fleet", pausedState(s.queue, !workersOnline(s).none)]])}${fleet}${table(
    "Queues",
    ["Queue", "State", ...COUNT_KEYS.map((k) => ({ num: k[0].toUpperCase() + k.slice(1) })), ...(act ? ["Action"] : [])],
    rows.map((row) => html`<tr><td class="mono">${cell(row.queue)}</td><td>${row.paused ? "paused" : "running"}</td>${COUNT_KEYS.map((k) => html`<td class="num">${count(row.counts?.[k] ?? 0)}</td>`)}${one(row)}</tr>`),
    "No queue was read.",
  )}`;
});

export const fleetActive = fromSnapshot("Active jobs", (s, view) => activeTable(s, view.now, canAct(view)));

export const fleetHeld = fromSnapshot(HELD_LABEL, (s, view) => {
  const h = s.held;
  if (!h || h.unreachable) return html`<p class="warn">The held jobs could not be read.</p>`;
  const rows = Array.isArray(h.rows) ? h.rows : [];
  const act = canAct(view);
  const cancel = (r) => (act && typeof r.jobId === "string" && RUN_ID_RE.test(r.jobId) ? html`<td>${actForm("cancel-held", { hidden: [["jobId", r.jobId]], label: "Cancel" })}</td>` : act ? html`<td>-</td>` : null);
  return html`${act && rows.length > 0 ? html`<div class="bar">${actForm("cancel-all-held", { label: "Cancel every held job" })}</div>` : null}${table(
    "Held jobs",
    ["Job", "Target", "Waiting for", "Held for", ...(act ? ["Action"] : [])],
    rows.map((r) => html`<tr><td class="mono">${cell(r.jobId)}</td><td class="mono">${cell(r.target)}</td><td>${cell(r.label)}</td><td>${ageText(r.waitedMs)}</td>${cancel(r)}</tr>`),
    "No job is held.",
  )}${h.more > 0 ? html`<p class="note">${count(h.more)} more held.</p>` : null}${h.truncated ? html`<p class="note">The held set is larger than one read takes; not every member was read.</p>` : null}`;
});

/** A host budget dimension as `used / budget`, `off`, or `-`. */
function budgetText(used, budget, unit) {
  if (budget === "off") return "off";
  if (budget === "" || budget === undefined || budget === null) return "-";
  return unit ? `${cell(used)} / ${budget} ${unit}` : `${cell(used)} / ${budget}`;
}

/** A registry CPU field (hundredths of a core, as text or a number) as a whole number, or null for anything else. */
function centiOf(v) {
  const n = typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * A host's CPU budget in cores (issue #710): `1.5 / 8 cores`, the worker's own formatter (`formatCpus`, `coresText`),
 * where the page once printed the registry's hundredths (`150 / 800`). `off`, `-`, or the raw text for a value that
 * is not hundredths (escaped like every value), so an odd row is shown, never hidden.
 */
function cpuBudgetText(used, budget) {
  if (budget === "off") return "off";
  if (budget === "" || budget === undefined || budget === null) return "-";
  const b = centiOf(budget);
  if (b === null) return budgetText(used, budget, null);
  const u = centiOf(used);
  return `${u === null ? cell(used) : formatCpus(u)} / ${coresText(b)}`;
}

export const fleetHosts = fromSnapshot("Hosts", (s, view) => {
  const hosts = Array.isArray(s.hostBudgets) ? s.hostBudgets : [];
  return table(
    "Hosts",
    ["Host", { num: "Slots" }, "Memory", "CPU", { num: "Waiting" }, "Running jobs", "Venues", "Routes", "Last beat"],
    hosts.map((h) => {
      const jobs = Array.isArray(h.jobs) ? h.jobs : null;
      const list = jobs === null ? (h.jobsUnreadable ? "unreadable" : "-") : jobs.length === 0 ? "none" : html`${jobs.map((j, i) => html`${i > 0 ? ", " : ""}${runLink(j.id)}${j.o ? " (orphaned hold)" : ""}${j.at ? html` <span class="note">${ageText(view.now - j.at)}</span>` : null}`)}${h.jobsMore > 0 ? ` and ${h.jobsMore} more` : ""}`;
      return html`<tr><td>${cell(h.name)}</td><td class="num">${cell(h.concurrency)}</td><td>${budgetText(h.usedMemMiB, h.budgetMemMiB, "MiB")}</td><td>${cpuBudgetText(h.usedCpuCenti, h.budgetCpuCenti)}</td><td class="num">${cell(h.waiters)}</td><td>${list}</td><td>${blessedText(h)}</td><td>${h.routes === false || h.routes === "false" ? "no" : "yes"}</td>${beatCell(beatAgeOf(h))}</tr>`;
    }),
    "No host is registered.",
  );
});

/**
 * The Doctor panel (issue #712, `DES-DOCTOR-RESULTS-PUBLISHED`): each host's last published `pi-dispatch doctor` run, its
 * age and counts, then its failing and warning checks with their fix, failing first. A result older than two of its
 * host's doctor intervals is flagged stale; a live host that has published nothing is named, so "no problems listed"
 * never reads as "healthy" for a host that was never checked. The labels are doctor's redacted sentences (no path, no
 * URL beyond its host, secret-named values and token shapes redacted, file content quoted by a parse error cut), shown
 * to both roles and escaped like every value here.
 */
export const fleetDoctor = fromSnapshot("Doctor", (s, view) => {
  const d = s.doctor;
  if (!d || d.unreachable) return html`<p class="warn">The published doctor results could not be read.</p>`;
  const rows = doctorHostsOf(s);
  const published = new Set(rows.map((r) => r.name));
  const silent = (Array.isArray(s.hostBudgets) ? s.hostBudgets : []).map((h) => h?.name).filter((n) => typeof n === "string" && !published.has(n));
  const block = (r) => {
    if (r.unreadable) return html`<h3>${r.name}</h3><p class="warn">Its published result cannot be read (a worker of another version may have written it).</p>`;
    const problems = doctorProblems(r);
    const shown = problems.slice(0, DOCTOR_CHECKS_SHOWN);
    const hidden = problems.length - shown.length + (Number.isSafeInteger(r.more) ? r.more : 0);
    const stale = doctorStale(r);
    const head = html`<p${r.counts?.fail > 0 ? html` class="bad"` : r.counts?.warn > 0 ? html` class="warn"` : null}>Doctor ran ${ageText(r.ageMs)} ago${r.version ? ` (version ${r.version})` : ""}, ${doctorByText(r)}: ${doctorCountsText(r)}.${r.openshell ? " The openshell venue was judged." : ""}</p>`;
    // A run by another account over the worker's (sudo, a second login) is published like any run, and said: it shows
    // that account's view of the host, not the worker's.
    const replaced = r.workerRun && r.by?.worker !== true ? html`<p class="warn">It replaced the worker's own run of ${ageText(view.now - r.workerRun.at)} ago${Number.isSafeInteger(r.workerRun.uid) ? ` (uid ${r.workerRun.uid})` : ""}, so it shows another account's view of the host.</p>` : null;
    const staleNote = stale ? html`<p class="warn">Stale: older than two of this host's doctor runs (every ${r.every}h), so it may no longer describe the host.</p>` : null;
    const list = table(
      `Doctor checks on ${r.name}`,
      ["Level", "Check", "What doctor said", "Fix"],
      shown.map((c) => html`<tr><td class="${c.level === "fail" ? "bad" : "warn"}">${c.level === "fail" ? "failing" : "warning"}</td><td class="mono">${c.id}</td><td>${cell(c.label)}</td><td>${cell(c.fix)}</td></tr>`),
      "Every check passed.",
    );
    return html`<h3>${r.name}</h3>${head}${replaced}${staleNote}${list}${hidden > 0 ? html`<p class="note">${count(hidden)} more not shown here; pi-dispatch doctor on that host prints them all.</p>` : null}`;
  };
  return html`${rows.length === 0 ? html`<p class="note">No host has published doctor results yet. Each worker runs doctor a minute after it starts and then every PI_DOCTOR_INTERVAL_HOURS (24 by default), and pi-dispatch doctor publishes too.</p>` : rows.map(block)}${silent.length > 0 ? html`<p class="note">No doctor result published by: ${silent.join(", ")}.</p>` : null}${d.more > 0 ? html`<p class="note">${count(d.more)} more hosts published results; not every one is read.</p>` : null}`;
});

/**
 * The Venues panel (issue #712, `DES-OPERATOR-CONSOLE`): every venue this build's table holds, with which live hosts
 * bless it and default to it (their registry rows' `backends` field), each declared property in words (its question,
 * the word and what the word means, the switch or the observation it holds under, and which hosts' floors ask for it),
 * what it serves and who holds its credentials, and per host the OpenShell engine, modes and gateway word. The hosts'
 * published facts plus the static table (`venuesView`); nothing is resolved live, so a word is the DECLARED one.
 */
export const fleetVenues = fromSnapshot("Venues", (s) => {
  const v = venuesView(Array.isArray(s.hostBudgets) ? s.hostBudgets : []);
  const names = (list) => (list.length === 0 ? "no live host" : list.join(", "));
  const floorText = (floor) => Object.entries(floor ?? {}).map(([p, w]) => `${p}=${w}`).join(", ");
  const means = (p) => html`${p.wordText}${p.armedBy ? html`<br><span class="note">Only while ${p.armedBy} is on.</span>` : null}${p.observedText ? html`<br><span class="note">Holds on a host where ${p.observedText}; elsewhere it counts as asserted.</span>` : null}`;
  const floored = (p) => (p.flooredOn.length === 0 ? "-" : p.flooredOn.map((f) => `${f.want} on ${f.host}`).join(", "));
  const venue = (x) => {
    const summary = `${x.name}: ${x.blessedOn.length === 0 ? "blessed on no live host" : `blessed on ${x.blessedOn.join(", ")}`}${x.defaultOn.length > 0 ? `, the default on ${x.defaultOn.join(", ")}` : ""}`;
    const openshell = x.openshell && x.openshell.length > 0
      ? table(`${x.name} OpenShell setup`, ["Host", "Engine", "Modes", "Gateway"], x.openshell.map((o) => (o.unpublished ? html`<tr><td>${cell(o.host)}</td><td colspan="3">${OPENSHELL_UNPUBLISHED_TEXT}</td></tr>` : html`<tr><td>${cell(o.host)}</td><td>${cell(o.engine)}</td><td>${o.modes.length > 0 ? o.modes.join(", ") : "-"}</td><td>${GATEWAY_TEXT[o.gateway] ?? GATEWAY_TEXT.unknown}</td></tr>`)), "")
      : null;
    return html`<details><summary>${summary}</summary><p>Runs in ${x.describe}.</p>${facts([
      ["Blessed on", names(x.blessedOn)],
      ["Default on", names(x.defaultOn)],
      ["Credentials", x.custody === "layer" ? html`held by the venue's egress layer: ${x.custodyText}` : html`in the job's container: ${x.custodyText}`],
    ])}<ul class="plain">${x.serves.map((sv) => html`<li>It ${sv.text ?? `${sv.key}: ${sv.word}`}.</li>`)}</ul>${openshell}${table(
      `${x.name} properties`,
      ["Property", "Word", "What the word means", "Asked for by a floor"],
      x.properties.map((p) => html`<tr><td>${p.question}<br><span class="note mono">${p.property}</span></td><td>${p.word}</td><td>${means(p)}</td><td>${floored(p)}</td></tr>`),
      "",
    )}</details>`;
  };
  return html`<p class="note">What each venue declares is this build's table; which hosts bless it, their floors and their OpenShell setup are what each host's worker published when it started. Nothing here is read live from a host.</p>${
    v.unpublished.length > 0 ? html`<p class="note">Not published by ${v.unpublished.join(", ")} (a worker older than this console).</p>` : null
  }${v.floors.length > 0 ? table("Floors", ["Host", "PI_BACKEND_FLOOR"], v.floors.map((f) => html`<tr><td>${cell(f.host)}</td><td class="mono">${floorText(f.floor)}</td></tr>`), "") : html`<p class="note">No live host published a floor (PI_BACKEND_FLOOR).</p>`}${v.venues.map(venue)}${
    v.others.length > 0 ? html`<p class="warn">Blessed by a host and not in this console's table: ${v.others.map((o) => `${o.name} (${o.blessedOn.join(", ")})`).join("; ")}.</p>` : null
  }`;
});

export const fleetSchedulers = fromSnapshot("Schedules", (s, view) => {
  const list = Array.isArray(s.schedulers) ? s.schedulers : [];
  const stalls = s.schedulerStalls ?? {};
  const max = s.schedulerStallMax;
  return table(
    "Schedules",
    ["Schedule", "Pattern", "Next", "Overdue", { num: "Stalls" }],
    list.map((x) => {
      // The trigger's id is the scheduler's `key`, which the stall counts are kept under; BullMQ's `name` is the job's,
      // so it never stands in for a key the reader refused. A scheduler with no key has no stall count to read (issue
      // #737): its cell is "-", never a whole 0 read under no key.
      const id = typeof x.key === "string" ? x.key : null;
      const n = id === null ? null : Number(stalls[id] ?? 0);
      const stallCell = n === null ? html`<td class="num">-</td>` : html`<td class="num${n > 0 ? " warn" : ""}">${n}${Number.isInteger(max) ? ` / ${max}` : ""}</td>`;
      return html`<tr><td class="mono">${cell(id)}</td><td class="mono">${cell(x.pattern ?? (x.every ? `every ${x.every} ms` : null))}</td><td>${x.next !== null && x.next !== undefined ? timeHtml(x.next) : "-"}</td><td${x.overdueMs ? html` class="warn"` : null}>${x.overdueMs ? ageText(x.overdueMs) : "no"}</td>${stallCell}</tr>`;
    }),
    "No schedule is registered.",
  );
});

/**
 * A failed job's "why" cell (issue #710): its run record's reason (the snapshot's `reason`, the newest record of that job
 * in the fleet reader's wide window), as the token and its catalog sentence cut for a row, or "no record" for a job
 * that wrote none (a job that failed before the processor recorded anything, or one older than the window). ONLY THE
 * RECORD'S CLOSED ENUM comes here: BullMQ's `failedReason` is free text, the operator's, in the details below
 * (REQ-CONSOLE-SECURITY (l)).
 */
function failedWhy(r) {
  if (typeof r?.reason !== "string" || r.reason === "") return html`<span class="note">no record</span>`;
  const said = reasonWords(r.reason);
  const token = html`<span class="mono">${bannerCut(r.reason)}</span>`;
  return said.known ? html`${token} · ${said.short}` : html`${token}, ${NO_EXPLANATION}`;
}

export const fleetFailed = fromSnapshot("Failed jobs", (s, view) => {
  const f = s.failed;
  if (!f || f.unreachable) return html`<p class="warn">The failed jobs could not be read.</p>`;
  const rows = Array.isArray(f.rows) ? f.rows : [];
  const operator = view.role === "operator";
  // The list carries ids, queues, counts and instants only. The reason is free text (REQ-CONSOLE-SECURITY clause l):
  // the operator sees it in one detail element per job below the list, a viewer never.
  const details = operator && rows.length > 0 ? html`<h3>Why each failed</h3>${rows.map((r) => html`<details><summary class="mono">${cell(r.jobId)}</summary><p class="mono">${cell(r.failedReason)}</p></details>`)}` : null;
  const act = canAct(view);
  const jobForms = (r) => {
    if (!act) return null;
    if (typeof r.jobId !== "string" || !RUN_ID_RE.test(r.jobId)) return html`<td>-</td>`;
    const hidden = [["jobId", r.jobId], ...(typeof r.queue === "string" ? [["queue", r.queue]] : [])];
    return html`<td class="acts">${actForm("retry-failed", { hidden, label: "Retry" })}${actForm("remove-failed", { hidden, label: "Remove" })}</td>`;
  };
  // The bulk bar: every failed job (at most 100 per action), optionally one queue's or one repository's.
  const filters = html`${field("queue", "Only queue", { max: 200 })}${field("repo", "Only repository", { placeholder: "owner/name", max: 512 })}`;
  const bulk = act && rows.length > 0 ? editor("Retry or remove failed jobs in bulk", html`${actForm("retry-all-failed", { fields: filters, label: "Preview retry of all" })}${actForm("remove-all-failed", { fields: filters, label: "Preview removal of all" })}`) : null;
  return html`${table(
    "Failed jobs",
    ["Job", "Queue", { num: "Attempts" }, "Failed", "Why (its record)", ...(act ? ["Action"] : [])],
    // The id, queue and time cells keep to one line (`keep`): the reason cell beside them is the one that wraps.
    rows.map((r) => html`<tr><td class="keep">${runLink(r.jobId)}</td><td class="mono keep">${cell(r.queue)}</td><td class="num">${cell(r.attemptsMade)}</td><td class="keep">${r.endedAt ? timeHtml(r.endedAt) : "-"}</td><td>${failedWhy(r)}</td>${jobForms(r)}</tr>`),
    "No failed job is kept by the queue.",
  )}${bulk}${f.more > 0 ? html`<p class="note">${count(f.more)} more failed.</p>` : null}${operator ? details : html`<p class="note">Failure reasons are shown to operators only.</p>`}`;
});
