/** The three Zero touch design cards, drawn from text-free facts (#770). */
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { zeroTouchView } from "../../zero-touch-view.mjs";

export const ZERO_TOUCH_WORDS = Object.freeze({ unavailable: "Zero touch could not be read. Reload to try again; missing history is never counted as zero touches.", empty: "No workload runs ended in the covered interval.", drafts: "Answer-rule drafts arrive with #772. A draft sent by a person will still count as a touch.", viewer: "Questions it keeps asking are for operators. Rates, causes, streaks and fixes are shown here.", noGroups: "No question groups yet. Group retained questions with a capped decision job; name each group yourself.", noFixes: "No cause-linked fixes recorded yet. Start a change from a refusal or a question group to measure it here." });
export const ZERO_TOUCH_CAUSES = Object.freeze([
  { cause: "question-answer", label: "Questions", short: "Questions", icon: "parked", tone: "parked", detail: "A person answered a parked question and the source session resumed." },
  { cause: "approval-decision", label: "Approvals", short: "Approvals", icon: "shield", tone: "attention", detail: "A person approved or declined a request. System expiry is excluded." },
  { cause: "rerun", label: "Failed or refused, then re-run", short: "Re-run", icon: "failed", tone: "failed", detail: "A person started a failed or refused run again." },
  { cause: "config-fix", label: "Refused until config was fixed", short: "Config fixed", icon: "refused", tone: "refused", detail: "A confirmed configuration change explicitly targeted the refusal." },
  { cause: "steer", label: "Steered", short: "Steered", icon: "steer", tone: "running", detail: "A person's steering message was delivered to the run." },
  { cause: "cancel", label: "Cancelled", short: "Cancelled", icon: "cancel", tone: "idle", detail: "A person cancelled the run while it was active." },
]);
export const ZERO_TOUCH_SOURCE_WORDS = Object.freeze({
  unassigned: "Not grouped yet.", pending: "A grouping job is pending.", assigned: "Assigned to a question group.",
  "source-expired": "The retained question context expired. Open the run to read what remains; a new grouping job cannot restore it.",
  "source-unavailable": "The worker could not retain safe question context. Check transcript capture on the source host.",
  "source-oversize": "The private question context exceeds its byte limit. It remains ungrouped rather than being cut.",
  "candidates-expired": "A group's representative context expired. Review the groups before trying again.",
  "group-limit": "The repository reached the bounded group limit. Review existing groups before trying again.",
  stale: "The group revision changed during classification. Preview a fresh grouping job.",
  refused: "The grouping job was refused. Open its run to see the policy reason.",
  failed: "The grouping job failed. Open its run and review the failure before trying again.",
});
const causesByKey = new Map(ZERO_TOUCH_CAUSES.map((c) => [c.cause, c]));
const model = (v) => zeroTouchView(v?.data?.zeroTouch, { role: v?.role, windowDays: v?.query?.days ?? 30, nowMs: v?.now ?? 0 });
const acts = (v) => v?.role === "operator" && !v?.readOnly;
const pct = (n) => Number.isFinite(n) ? `${Math.round(n)}%` : "Not known";
const amount = (n) => Number.isFinite(n) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(n) : "Not known";
const date = (n) => Number.isFinite(n) && n >= 0 && n <= 8640000000000000 ? new Date(n).toISOString().slice(0, 10) : "not known";
const span = (ms) => ms === null ? "not known" : ms >= 3600000 ? `${amount(ms / 3600000)}h` : `${amount(ms / 60000)}m`;
const link = (id) => html`<a class="link code" href="${`/run?id=${encodeURIComponent(id)}`}">${id}</a>`;
const fail = (m) => m.state === "unavailable" ? html`<p class="zt-note" role="status">${ZERO_TOUCH_WORDS.unavailable}</p>` : null;
export function zeroTouchTabs(view) {
  const here = view?.page === "zero-touch";
  return ui.tabs([{ label: "All runs", href: "/runs", icon: "runs", current: !here }, { label: "Zero touch", href: "/runs/zero-touch", icon: "flag", current: here }], { label: "Runs views" });
}
export function zeroTouchControls(view) {
  const m = model(view);
  return ui.seg([7, 30, 90].map((days) => ({ label: `${days} days`, href: `/runs/zero-touch?${new URLSearchParams({ days: String(days), ...(view?.query?.project ? { project: view.query.project } : {}), ...(view?.query?.scope ? { scope: view.query.scope } : {}) })}`, on: days === m.windowDays })), { label: "Window" });
}
function delta(n, previousRate = null) {
  if (!Number.isFinite(n)) return html`<span class="zt-tr">Previous interval not covered</span>`;
  return html`<span class="${`zt-tr${n < 0 ? " tone-ok" : n > 0 ? " tone-attention" : ""}`}">${ui.icon(n < 0 ? "chev" : n > 0 ? "chev-r" : "info", { size: "sm" })}<b>${n === 0 ? "no change" : `${n < 0 ? "down" : "up"} ${amount(Math.abs(n))} points`}</b>${previousRate === null ? null : html`<small>from ${pct(previousRate)}</small>`}</span>`;
}
function coverage(m) {
  return html`<p class="zt-coverage" role="status">${m.coverage.partial ? html`<b>Partial ${m.windowDays}-day window.</b> Covered from ${date(m.coverage.fromMs)} UTC. Older unknown runs are not counted as untouched.` : html`Whole ${m.windowDays}-day window.`}${m.coverage.reasons.length ? html` ${m.coverage.reasons.join("; ")}.` : null}</p>`;
}
function spark(m) {
  const rows = m.trend;
  if (!rows.some((r) => Number.isFinite(r.rate) && !r.partial)) return html`<p class="zt-kps">Weekly trend is not covered yet.</p>`;
  const top = Math.max(32, ...rows.map((r) => r.rate ?? 0));
  const x = (i) => rows.length === 1 ? 200 : i * 200 / (rows.length - 1);
  const y = (n) => 56 - n / top * 56;
  const segments = [];
  let points = [];
  for (const [i, row] of rows.entries()) {
    if (row.rate === null || row.partial) { if (points.length) segments.push(points); points = []; }
    else points.push(`${ui.svgNum(x(i), 0, 200)},${ui.svgNum(y(row.rate), 0, 56)}`);
  }
  if (points.length) segments.push(points);
  const last = rows[rows.length - 1];
  const label = `Rolling ${m.windowDays}-day touch rate at weekly intervals: ${rows.map((r) => r.partial || r.rate === null ? "not covered" : pct(r.rate)).join(", ")}. Goal under 5 percent.`;
  return html`<svg class="zt-spark" viewBox="-4 -4 208 64" preserveAspectRatio="none" role="img" aria-label="${label}"><line class="zt-spark__goal" x1="0" x2="200" y1="${ui.svgNum(y(5), 0, 56)}" y2="${ui.svgNum(y(5), 0, 56)}"/>${segments.map((p) => html`<polyline class="zt-spark__l" points="${p.join(" ")}"/>`)}${last?.rate !== null && !last?.partial ? html`<circle class="zt-spark__d" cx="200" cy="${ui.svgNum(y(last.rate), 0, 56)}" r="3.5"/>` : null}</svg><p class="zt-spark__ax"><span>${date(rows[0]?.atMs)}</span><span>goal, dashed</span><span>now</span></p><p class="sr">${label}</p>`;
}
function longest(m) { return [...m.projects].filter((p) => p.streakDays !== null && !p.waitingNow).sort((a, b) => b.streakDays - a.streakDays)[0] ?? null; }
function waitingHistory(m) { return m.totals.waitingPartial ? html`<p class="zt-note" role="status">Waiting history is incomplete. An older park predates retained answer history; its current state and wait time are not known.</p>` : null; }
function compact(m) {
  const best = longest(m);
  return html`<ul class="ztp-now"><li><span>${ui.icon("flag", { size: "sm" })}Longest streak</span><b>${best ? `${best.name}, ${amount(best.streakDays)} ${best.streakDays === 1 ? "day" : "days"}` : "Not enough history"}</b></li><li><span>${ui.icon("clock", { size: "sm" })}Waited on a person</span><b>${m.totals.waitingPartial ? "Not known" : `${amount(m.totals.waitingHours)}h, median ${span(m.totals.medianWaitMs)}`}</b></li><li><span>${ui.icon("edit", { size: "sm" })}Answered from a draft</span><b>Available with #772</b></li><li><span>${ui.icon("parked", { size: "sm" })}Waiting now</span><b>${m.totals.waitingPartial ? "Not known" : `${m.totals.pending} ${m.totals.pending === 1 ? "run" : "runs"}`}</b>${m.waitingRuns.slice(0, 3).map((r) => html`<span>${link(r.runId)}, ${span(m.nowMs - r.parkedAt)}</span>`)}</li></ul>${waitingHistory(m)}`;
}
export function zeroTouchRate(view) {
  const m = model(view);
  return ui.card({ title: `Touch rate, ${m.windowDays} days`, body: html`${fail(m)}${m.state === "ready" ? html`${ui.kpi(m.totals.runs ? pct(m.totals.rate) : "No runs", `${m.totals.touched} of ${m.totals.runs} runs needed a person`)}${spark(m)}<p class="zt-kp"><span class="zt-kt">${ui.icon("flag", { size: "sm" })}goal under 5%</span>${delta(m.totals.deltaPoints, m.totals.previousRate)}</p>${coverage(m)}<p class="zt-kps">${m.totals.stopped} stopped before they ran, outside the rate.${m.totals.stoppedUnattributed > 0 ? html` ${m.totals.stoppedUnattributed} stops have no recorded project or scope, so this selection may have more.` : null}</p><div class="zt-phone-summary">${compact(m)}</div>` : null}` });
}
export function zeroTouchStreak(view) {
  const m = model(view), best = longest(m);
  return ui.card({ title: "Zero-touch streak", body: html`${fail(m)}${ui.kpi(best ? `${amount(best.streakDays)} ${best.streakDays === 1 ? "day" : "days"}` : "Not enough history", best ? `${best.name}, the longest now` : "30 days of observed activity establish a zero-touch project")}<p class="zt-kp">${m.projects.filter((p) => p !== best).sort((a, b) => (b.streakDays ?? -1) - (a.streakDays ?? -1)).map((p) => p.waitingNow ? ui.chip(`${p.name} waiting now`, { status: "parked", icon: "parked" }) : html`<span class="zt-kt">${p.name} ${p.streakDays === null ? "not known" : `${amount(p.streakDays)} ${p.streakDays === 1 ? "day" : "days"}`}</span>`)}</p>` });
}
export function zeroTouchWait(view) {
  const m = model(view);
  if (m.state !== "ready") return ui.card({ title: "Waiting for a person", body: fail(m) });
  return ui.card({ title: "Waiting for a person", body: html`${fail(m)}${ui.kpi(m.totals.waitingPartial ? "Not known" : `${amount(m.totals.waitingHours)}h`, `runs waited on a person in ${m.windowDays} days`)}<p class="zt-kps">Median wait for an answer <b>${span(m.totals.medianWaitMs)}</b></p>${waitingHistory(m)}<p class="zt-kp">${ui.chip(m.totals.waitingPartial ? "Pending count not known" : `${m.totals.pending} waiting now`, { status: "parked", icon: "parked" })}${m.waitingRuns.slice(0, 3).map((r) => html`<span>${link(r.runId)}, ${span(m.nowMs - r.parkedAt)}</span>`)}</p>` });
}
export function zeroTouchHandled(view) { return ui.card({ title: "Answered from a draft", body: html`${ui.kpi("Coming next", "Answer rules, #772")}<p class="zt-kps">${ZERO_TOUCH_WORDS.drafts}</p>` }); }
function meter(row) {
  if (row.rate === null) return html`<span class="zt-m">Not enough history</span>`;
  const tone = row.rate < 5 ? "ok" : row.rate < 30 ? "attention" : "failed";
  const word = row.rate < 5 ? "Under goal" : row.rate < 30 ? "Above goal" : "High";
  return html`<span class="zt-m"><svg class="${`pbar tone-${tone}`}" height="10" role="meter" aria-valuenow="${ui.svgNum(row.rate, 0, 100)}" aria-valuemin="0" aria-valuemax="100" aria-label="${`${row.name}: ${pct(row.rate)} of runs needed a person, goal under 5 percent; meter scale 40 percent`}"><rect class="pbar__bed" width="100%" height="10" rx="5"/><rect class="pbar__fill" width="${`${ui.svgNum(row.rate / 40 * 100, 0, 100)}%`}" height="10" rx="5"/><line class="zt-goal" x1="12.5%" x2="12.5%" y1="-4" y2="14"/></svg><span class="zt-mv"><b>${pct(row.rate)}</b><span class="${`zt-lv tone-${tone}`}">${ui.icon(tone === "ok" ? "done" : "attention", { size: "sm" })}${word}</span></span></span>`;
}
function rowContent(row, sub = false) {
  const c = causesByKey.get(row.topCause);
  return html`<span class="zt-chev">${sub ? null : ui.icon("chev-r", { size: "sm" })}</span><span class="zt-name"><b>${row.name}</b><small>${sub ? `${row.runs} runs` : row.repositories.map((r) => r.name).join(" and ")}</small></span>${meter(row)}${delta(row.deltaPoints, row.previousRate)}<span class="zt-n"><b>${row.touched}</b> of ${row.runs} runs</span><span class="${`zt-st${row.waitingNow ? " tone-parked" : ""}`}">${ui.icon(row.waitingNow ? "parked" : "flag", { size: "sm" })}${row.waitingPartial ? "waiting history incomplete" : row.waitingNow ? "waiting now" : row.zeroTouch ? "zero touch, 30+ days" : row.streakDays === null ? "not enough history" : `${amount(row.streakDays)} ${row.streakDays === 1 ? "day" : "days"}`}</span><span class="zt-c">${c ? html`<span class="${`zt-cause tone-${c.tone}`}">${ui.icon(c.icon, { size: "sm" })}${c.short}</span>` : "No touches"}</span>`;
}
function phoneProjects(m, view) {
  const item = (row, repository = false) => {
    const c = causesByKey.get(row.topCause), tone = row.rate === null ? "idle" : row.rate < 5 ? "ok" : row.rate < 30 ? "attention" : "failed";
    const word = row.rate === null ? "Not known" : row.rate < 5 ? "Under goal" : row.rate < 30 ? "Above goal" : "High";
    const query = new URLSearchParams({ days: String(m.windowDays), ...(row.project ? { project: row.project } : {}), ...(repository && row.scopeId ? { scope: row.scopeId } : {}) });
    return html`<li><a class="ztp-p" href="${`/runs/zero-touch?${query}`}" aria-label="${`${row.name}: ${pct(row.rate)}, open ${repository ? "repository" : "project"}`}"${repository ? html` data-repository` : null}><span class="ztp-p__n"><b>${row.name}</b><small>${row.touched} of ${row.runs} runs</small></span><span class="ztp-p__r"><b>${pct(row.rate)}</b><span class="${`zt-lv tone-${tone}`}">${ui.icon(tone === "ok" ? "done" : "attention", { size: "sm" })}${word}</span></span><span class="ztp-p__c">${c ? html`<span class="${`zt-cause tone-${c.tone}`}">${ui.icon(c.icon, { size: "sm" })}${c.short}</span>` : html`<span>No touches</span>`}${delta(row.deltaPoints, row.previousRate)}</span><span class="ztp-p__go">${ui.icon("chev-r", { size: "sm" })}</span></a></li>`;
  };
  return html`<ul class="ztp-ps zt-phone-projects">${m.projects.map((p) => html`${item(p)}${view?.query?.project === p.project ? p.repositories.map((r) => item(r, true)) : null}`)}</ul>`;
}
export function zeroTouchProjects(view) {
  const m = model(view);
  if (m.state !== "ready") return ui.card({ title: "By project", body: fail(m) });
  const head = html`<div class="zt-row zt-row--head" aria-hidden="true"><span></span><span>Project</span><span>Touch rate, goal tick at 5%</span><span>Against the previous interval</span><span>Needed a person</span><span>Since the last touch</span><span>Most often</span></div>`;
  const rows = m.projects.map((p) => html`<li><details class="zt-p"${view?.query?.project === p.project ? html` open` : null}><summary class="zt-row" aria-label="${`${p.name}: ${pct(p.rate)}, show its repositories or folders`}">${rowContent(p)}</summary><ul class="zt-subs">${p.repositories.map((r) => html`<li class="zt-row zt-row--sub">${rowContent(r, true)}</li>`)}</ul>${acts(view) && p.touchedRunIds.length ? html`<p class="zt-foot"><a class="link" href="${`/runs?${new URLSearchParams({ project: p.project ?? "", touched: "1", days: String(m.windowDays) })}`}">Open touched runs</a></p>` : null}</details></li>`);
  return ui.card({ title: "By project", sub: `${m.totals.touched} of ${m.totals.runs} runs needed a person`, flush: true, body: html`${fail(m)}${m.projects.length ? html`<div class="zt-tbl zt-desktop-projects">${head}<ul class="zt-list">${rows}</ul></div>${phoneProjects(m, view)}<p class="zt-foot">${ui.icon("info", { size: "sm" })}<span>A row opens to its repositories or folders. A run counts once, however many interventions it received.</span></p>` : html`<p class="zt-note">${ZERO_TOUCH_WORDS.empty}</p>`}` });
}
function causeCounts(values) { return ZERO_TOUCH_CAUSES.map((c) => ({ ...c, count: values.find((v) => v.cause === c.cause)?.count ?? 0 })); }
// Percent geometry without a viewBox keeps labels at 12 CSS pixels on phones as well as desktops.
function causeBar(values, max, name) {
  const rows = causeCounts(values); let at = 0;
  // A partial or inconsistent summary must not put the stack outside its SVG viewport.
  max = Math.max(1, max, rows.reduce((sum, row) => sum + row.count, 0));
  const all = rows.filter((r) => r.count > 0);
  const label = `${name}: ${all.map((r) => `${r.label} ${r.count}`).join(", ") || "no touches"}; full scale ${max} touched runs`;
  return html`<svg class="zt-cause-svg" width="100%" height="28" role="img" aria-label="${label}">${all.map((r) => { const x = at / Math.max(1, max) * 500, w = r.count / Math.max(1, max) * 500; at += r.count; return html`<g class="${`tone-${r.tone}`}"><rect class="zt-cause-rect" x="${`${ui.svgNum(x / 5, 0, 100)}%`}" y="0" width="${`${ui.svgNum(w / 5, 0, 100)}%`}" height="28" rx="5"/>${w >= 22 ? html`<text class="zt-cause-label" x="${`${ui.svgNum((x + w / 2) / 5, 0, 100)}%`}" y="18" text-anchor="middle">${r.count}</text>` : null}</g>`; })}</svg>`;
}
export function zeroTouchCauses(view) {
  const m = model(view), max = Math.max(1, ...m.projects.map((p) => Math.max(p.touched, causeCounts(p.causes).reduce((sum, row) => sum + row.count, 0))));
  if (m.state !== "ready") return ui.card({ title: "What needed a person", body: fail(m) });
  const bars = m.projects.map((p) => html`<li class="zt-cb"><span class="zt-cb__n"><b>${p.name}</b><small>${p.touched} of ${p.runs}</small></span>${causeBar(p.causes, max, p.name)}<p class="zt-cb__t">${causeCounts(p.causes).filter((c) => c.count).map((c) => `${c.short} ${c.count}`).join(" · ") || "No touches"}</p></li>`);
  const scopeLabel = view?.query?.scope ? "selected repository" : view?.query?.project ? "selected project" : "all projects";
  return ui.card({ title: "What needed a person", sub: html`<span class="zt-desktop-label">last ${m.windowDays} days, by project</span><span class="zt-phone-label">${m.windowDays} days, ${scopeLabel}</span>`, body: html`${fail(m)}<ul class="zt-bars zt-desktop-causes">${bars}</ul><div class="zt-phone-causes">${causeBar(m.causes, Math.max(1, m.totals.touched), scopeLabel === "all projects" ? "All projects" : scopeLabel)}</div><ul class="zt-whys">${causeCounts(m.causes).map((c) => html`<li class="zt-why">${ui.tile(c.tone === "running" ? "running" : c.tone === "idle" ? "idle" : c.tone, { icon: c.icon, sm: true })}<span><b>${c.label}</b><small>${c.detail}</small></span><span class="zt-why__n">${c.count}</span></li>`)}<li class="zt-why zt-why--sum"><span></span><span><b>Runs that needed a person</b></span><span class="zt-why__n">${m.totals.touched}</span></li></ul><p class="zt-merge">${ui.icon("pr", { size: "sm" })}<span>Merging is never a touch. <a class="link" href="#zt-counting">How touches are counted</a></span></p><details class="zt-counting" id="zt-counting"><summary>How touches are counted</summary><p class="zt-kps">The rate counts workload runs with a retained record that ended in the covered interval. Each run counts once. Bars assign it to its first successful human intervention; later interventions remain in history. Jobs stopped before starting are separate. Reads, sandbox opens, automatic starts and internal grouping jobs do not enter the touch count.</p></details>` });
}
export const ZERO_TOUCH_NO_SCRIPT = "Enable JavaScript to preview and confirm a change. Reading and navigation work without it.";
function guardedForm(action, { hidden = [], fields = null, label, kind = ["sm"] } = {}) {
  return html`<form class="act zt-action" data-action="${action}" autocomplete="off"><fieldset data-config-controls disabled>${hidden.map(([name, value, type]) => html`<input type="hidden" name="${name}" value="${value}"${type ? html` data-type="${type}"` : null}>`)}${fields}${ui.btn({ type: "submit", kind, label })}</fieldset><noscript><p class="zt-kps">${ZERO_TOUCH_NO_SCRIPT}</p></noscript><p class="field__err" data-form-error hidden role="alert"></p></form>`;
}
function nameForm(g, index) {
  const key = `zt-name-${index}`;
  return html`<details class="zt-editor"><summary class="link">${g.name ? "Rename this group" : "Name this group"}</summary>${guardedForm("zero-touch-name", { hidden: [["groupId", g.id]], fields: ui.field({ label: "Group name", id: key, control: ui.input({ id: key, name: "name", value: g.name, required: true }), hint: "Write your own name, up to 120 characters. Question text is read only on its run page." }), label: "Preview name" })}</details>`;
}
function instructionForm(g, index) {
  if (!g.runIds[0] || g.triggerIndex === null) return html`<p class="zt-kps">Add to instructions is unavailable: a retained run and a current non-cron trigger are required.</p>`;
  const key = `zt-sentence-${index}`;
  return html`<details class="zt-editor"><summary class="link">Add to instructions</summary>${guardedForm("zero-touch-instruction", { hidden: [["runId", g.runIds[0]], ["groupId", g.id], ["index", g.triggerIndex, "int"]], fields: ui.field({ label: "Sentence to add", id: key, control: ui.textarea({ id: key, name: "sentence", required: true, rows: 3, maxlength: 2000 }), hint: "Preview the exact diff, then Confirm. The trigger's existing instructions count toward the 2,000-character limit." }), label: `Preview trigger ${g.triggerIndex + 1}`, kind: ["sm", "primary"] })}</details>`;
}
export function zeroTouchQuestions(view) {
  if (view?.role !== "operator") return ui.collapsed({ icon: "parked", title: "Questions it keeps asking", body: "are for operators. Rates, causes, streaks and fixes are shown here." });
  const m = model(view);
  if (m.state !== "ready") return ui.card({ title: "Questions it keeps asking", body: fail(m) });
  const rows = m.groups.map((g, index) => html`<li class="zt-q"><div class="zt-q__h"><span class="zt-q__n" aria-label="${`asked ${g.count} times`}">${g.count}×</span><div><p class="${`zt-q__t${g.name ? "" : " zt-q__t--un"}`}">${g.name ?? `${g.count} similar questions, not named yet`}</p><p class="zt-q__s"><span class="code">${g.repo ?? g.project ?? "Repository not known"}</span>${g.status === "fixed" && g.fixedAt !== null ? html` · fixed ${date(g.fixedAt)} UTC` : null}${g.status === "fixed" && m.fixes.some((f) => f.groupId === g.id && f.afterCount === 0 && f.subsequentRuns > 0 && !f.partial && f.undoneAt === null) ? html` · none since` : null}</p></div><span class="zt-q__st">${ui.chip(g.status === "fixed" ? "Fixed" : g.status === "unassigned" ? "Unassigned" : "Open", { status: g.status === "fixed" ? "ok" : "parked", icon: g.status === "fixed" ? "done" : "parked" })}</span></div><p class="zt-said">${ui.icon("runs", { size: "sm" })}<span>Asked in ${g.runIds.slice(0, 8).map(link)}${g.runIds.length > 8 ? ` and ${g.runIds.length - 8} more` : null}.</span></p>${acts(view) ? html`<div class="zt-q__act">${nameForm(g, index)}${g.status !== "fixed" ? instructionForm(g, index) : html`<a class="link" href="#p-zt-fixes">See the fix</a>`}</div>` : null}</li>`);
  const phoneRows = m.groups.map((g, index) => html`<li class="ztp-q"><span class="zt-q__n" aria-label="${`asked ${g.count} times`}">${g.count}×</span><span class="ztp-q__t"><b>${g.runIds[0] ? html`<a class="zt-group-link" href="${`/run?id=${encodeURIComponent(g.runIds[0])}`}">${g.name ?? `${g.count} similar, not named yet`}</a>` : g.name ?? `${g.count} similar, not named yet`}</b><small>${g.repo ?? g.project ?? "Repository not known"}</small></span><span class="ztp-q__st">${ui.chip(g.status === "fixed" ? "Fixed" : g.status === "unassigned" ? "Unassigned" : "Open", { status: g.status === "fixed" ? "ok" : "parked", icon: g.status === "fixed" ? "done" : "parked" })}</span><span class="ztp-q__a">${acts(view) ? g.status === "fixed" ? html`<a class="link" href="#p-zt-fixes">See the fix</a>` : g.name ? instructionForm(g, `phone-${index}`) : nameForm(g, `phone-${index}`) : null}</span></li>`);
  const sources = m.grouping.sources.length ? m.grouping.sources : m.ungroupedRunIds.map((runId) => ({ runId, status: "unassigned" }));
  return ui.card({ title: "Questions it keeps asking", sub: "operator only", body: html`<p class="zt-intro">Grouped by meaning. You name each group; read the questions on their run pages.</p>${fail(m)}${m.grouping.partial ? html`<p class="zt-note" role="status">Question grouping is partial. Missing or unclassified sources are not evidence that a question stopped recurring.</p>` : null}${["unavailable", "configuration-unavailable"].includes(m.grouping.state) ? html`<p class="zt-note" role="status">${m.grouping.state === "configuration-unavailable" ? "Grouping configuration could not be read. Check the reviewed triggers file before starting a grouping job." : "Question groups could not be read. Reload to retry; missing assignments are not an empty group list."}</p>` : null}${rows.length ? html`<ol class="zt-qs zt-desktop-questions">${rows}</ol><ol class="ztp-qs zt-phone-questions">${phoneRows}</ol>` : html`<p class="zt-kps">${["unavailable", "configuration-unavailable"].includes(m.grouping?.state) ? "Grouping coverage is not known. Reload after the source is available." : ZERO_TOUCH_WORDS.noGroups}</p>`}${sources.length ? html`<ul class="zt-ungrouped">${sources.slice(0, 20).map((source) => html`<li data-group-status="${source.status}">${link(source.runId)}<span>${ZERO_TOUCH_SOURCE_WORDS[source.status]}</span>${acts(view) && ["unassigned", "stale", "refused", "failed"].includes(source.status) ? guardedForm("zero-touch-group", { hidden: [["runId", source.runId]], label: "Group question", kind: ["sm", "paid"] }) : null}</li>`)}</ul>` : null}<p class="zt-foot zt-foot--in">${ui.icon("info", { size: "sm" })}<span>${m.grouping.enabled ? `${m.grouping.pending} grouping jobs pending; ${m.grouping.unassigned} questions unassigned. Expired or unavailable context stays ungrouped.` : "Private capture and a capped classifier must be enabled in the reviewed zeroTouch configuration before questions can be grouped."}</span></p>` });
}
function fixTone(f) {
  if (f.partial || f.subsequentRuns === 0 || f.undoneAt !== null || f.status === "observing") return "idle";
  return f.status === "improved" ? "ok" : f.status === "worse" ? "failed" : "idle";
}
function fixObservation(f) {
  if (f.undoneAt !== null) return "Reverted: this observation does not establish current effectiveness.";
  if (f.partial) return "Partial observation: effectiveness is not established.";
  if (f.subsequentRuns === 0) return "No subsequent runs yet: effectiveness is not established.";
  return f.status === "improved" ? "Fewer occurrences over equal observed spans." : f.status === "worse" ? "More occurrences over equal observed spans." : f.status === "unchanged" ? "The same number of occurrences over equal observed spans." : "Still observing the targeted cause.";
}
function beforeAfter(label, value, max, tone = "attention") { return html`<p class="zt-ba"><span>${label}</span><svg class="${`pbar tone-${tone}`}" height="8" role="img" aria-label="${`${label}: ${value === null ? "not known" : value}`}"><rect class="pbar__bed" width="100%" height="8" rx="4"/>${value ? html`<rect class="pbar__fill" width="${`${ui.svgNum(value / max * 100, 0, 100)}%`}" height="8" rx="4"/>` : null}</svg><b>${value ?? "?"}</b></p>`; }
export function zeroTouchFixes(view) {
  const m = model(view);
  const evidence = html`${m.fixesPartial ? html`<p class="zt-note" role="status">Fix history is incomplete. Reload to retry; missing changes are not evidence that no fix was made.</p>` : null}${m.fixes.length ? html`<ol class="zt-fxs">${m.fixes.map((f) => html`<li class="zt-fx"><p class="zt-fx__d">${date(f.at)} UTC${f.undoneAt === null ? null : html` · Reverted ${date(f.undoneAt)} UTC`}</p><p class="zt-fx__w">${f.kind === "instructions" ? `Trigger ${f.triggerIndex === null ? "not known" : f.triggerIndex + 1}'s instructions gained a sentence` : "Configuration changed to address a refusal"}</p><p class="zt-fx__m">${f.reason ? `${f.reason} refusals` : "Questions in the targeted group"}, equal ${span(f.spanMs)} spans before and after; ${f.subsequentRuns} workload runs after the fix.</p>${beforeAfter("Before", f.beforeCount, Math.max(f.beforeCount ?? 0, f.afterCount ?? 0, 1))}${beforeAfter("After", f.afterCount, Math.max(f.beforeCount ?? 0, f.afterCount ?? 0, 1), fixTone(f))}<p class="zt-kps">${fixObservation(f)}</p>${acts(view) && f.kind === "instructions" && f.undoneAt === null ? guardedForm("zero-touch-undo", { hidden: [["fixId", f.id]], label: "Preview removing the sentence", kind: ["sm", "ghost"] }) : null}</li>`)}</ol>` : html`<p class="zt-kps">${m.fixesPartial ? "Fix history is not known. Reload after the source is available." : ZERO_TOUCH_WORDS.noFixes}</p>`}`;
  const brief = m.fixes.map((f) => `${f.reason ?? "grouped questions"}: ${f.beforeCount ?? "?"} to ${f.afterCount ?? "?"}`).join("; ");
  return ui.card({ title: "Fixes that worked", sub: "what changed, and what it did", body: html`<div class="zt-desktop-fixes">${evidence}</div><details class="zt-phone-fixes"><summary>${ui.icon("done", { size: "sm" })}<span><b>${m.fixesPartial ? "Fix history incomplete" : `${m.fixes.length} fixes recorded`}</b>${brief ? `: ${brief}. ` : ". "}<span class="link">Open observations</span></span></summary><div class="zt-fix-observations">${evidence}</div></details>` });
}
export const ZERO_TOUCH_PANELS = Object.freeze([["p-zt-rate", zeroTouchRate], ["p-zt-streak", zeroTouchStreak], ["p-zt-wait", zeroTouchWait], ["p-zt-handled", zeroTouchHandled], ["p-zt-projects", zeroTouchProjects], ["p-zt-causes", zeroTouchCauses], ["p-zt-questions", zeroTouchQuestions], ["p-zt-fixes", zeroTouchFixes]]);
