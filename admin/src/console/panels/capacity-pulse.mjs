/** Pulse capacity cards use the report's checked geometry and facts, never a second capacity calculation. */
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { normCapacity, layoutCapacityChart, INSIGHTS_CAPACITY_JOBS_ONLY } from "../../insights-html.mjs";
import { timeHtml } from "./common.mjs";

const payload = (v) => v.data?.insights?.capacity;
const note = (body) => html`<p class="sp-note note">${body}</p>`;
const card = (title, body, sub = null) => ui.card({ title, sub, body: html`<div class="card__body">${body}</div>` });
const valid = (n) => Number.isFinite(n) && n >= 0;
const percent = (n) => valid(n) ? `${Math.round(n) / 10}%` : "unknown";
const duration = (ms) => !valid(ms) ? "No run recorded one" : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${Math.round(ms / 100) / 10}s` : ms < 3_600_000 ? `${Math.round(ms / 6000) / 10}m` : `${Math.round(ms / 360_000) / 10}h`;
const number = (n) => Math.round(n * 100) / 100;
const headline = (amount, suffix = null) => ui.kpi(amount, suffix);

export function capacityBusy(v) {
  const c = payload(v), f = c?.fleet;
  return card("Fleet busy", html`${headline(percent(f?.busyPerMille), "of slot time")}${note(`Weighted by slots${c?.hostCount == null ? "" : `, ${c.hostCount} hosts`}${c?.totalSlots == null ? "." : `, ${c.totalSlots} current slots in all.`}`)}${f?.incomplete ? note("Partial history: this is not a complete fleet total.") : null}`);
}
export function capacityPeak(v) {
  const c = payload(v), f = c?.fleet;
  return card("Fleet peak", html`${headline(f?.peak ?? "unknown", "jobs at once")}${note("Most jobs at once in one hour, all hosts added.")}${valid(c?.totalSlots) ? note(`${c.totalSlots} slots in the current fleet; past capacity may differ.`) : null}${timeHtml(f?.peakAtMs)}`);
}
export function capacityWait(v) {
  const w = payload(v)?.fleet?.waits;
  return card("Wait for a slot", html`${headline(duration(w?.p95Ms), valid(w?.p95Ms) ? "p95" : null)}${note(`Median ${valid(w?.p50Ms) ? duration(w.p50Ms) : "unknown"}, from eligible to holding a slot.`)}`);
}
export function capacityMemory(v) {
  const f = payload(v)?.fleet;
  return card("Promised memory", html`${headline(percent(f?.promisedMemPerMille), "at the busiest hour")}${note("Of every host's memory budget.")}${timeHtml(f?.busiestHourMs)}`);
}
export function capacityWindow(v) {
  const c = normCapacity(payload(v));
  return html`${c?.window ? note(html`From ${timeHtml(c.window.fromMs)} to ${timeHtml(c.window.toMs)}. Each bar is ${c.window.bucketMs / 3_600_000} hour${c.window.bucketMs === 3_600_000 ? "" : "s"}.`) : null}${ui.banner({ status: "attention", title: "Jobs only", body: "A machine busy with other work reads as idle. These numbers count pi-dispatch jobs, not the machine." })}`;
}

function chart(host, c, tips, now) {
  const lay = layoutCapacityChart(host, { ...c.window, nowMs: now, width: 1000, height: 144 });
  const x = (value) => `${number(value / lay.width * 100)}%`;
  const bottom = lay.plot.y + lay.plot.h;
  const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const tip = (text) => tips.push(text) - 1;
  const labels = [];
  const span = c.window.toMs - c.window.fromMs;
  const step = span <= 86_400_000 ? 4 * 3_600_000 : Math.ceil(span / 86_400_000 / 7) * 86_400_000;
  for (let at = Math.ceil(c.window.fromMs / step) * step; at < c.window.toMs; at += step) {
    const date = new Date(at);
    labels.push({ x: lay.plot.x + (at - c.window.fromMs) / (c.window.toMs - c.window.fromMs) * lay.plot.w, text: span <= 86_400_000 ? `${String(date.getUTCHours()).padStart(2, "0")}:00` : date.toISOString().slice(5, 10) });
  }
  return html`<svg class="cp-chart" width="100%" height="144" role="img" aria-label="jobs at once on ${host.name}">
    ${labels.map((l) => html`<line class="cp-grid" x1="${x(l.x)}" x2="${x(l.x)}" y1="${lay.plot.y}" y2="${bottom}"></line>`)}
    ${lay.gaps.map((gap) => {
      const lines = [];
      for (let start = gap.x - lay.plot.h; start < gap.x + gap.w; start += 8) {
        const lo = Math.max(0, gap.x - start), hi = Math.min(lay.plot.h, gap.x + gap.w - start);
        if (hi > lo) lines.push(html`<line class="cp-hatch" x1="${x(start + lo)}" x2="${x(start + hi)}" y1="${bottom - lo}" y2="${bottom - hi}"></line>`);
      }
      return html`<g class="cp-gap" data-tip="${tip(`${when(gap.fromMs)} to ${when(gap.toMs)}: no data, neither busy nor idle${host.truncated ? "; history truncated" : ""}`)}"><rect class="cp-nd-bg" x="${x(gap.x)}" y="${lay.plot.y}" width="${x(gap.w)}" height="${lay.plot.h}"></rect>${lines}</g>`;
    })}
    ${lay.bars.map((bar) => html`<g data-tip="${tip(`${when(bar.bucket.fromMs)}: average ${(bar.bucket.avgMilli ?? 0) / 1000} jobs, peak ${bar.bucket.peak}${bar.partial ? "; part has no data" : ""}`)}"><rect x="${x(bar.x)}" y="${lay.plot.y}" width="${x(bar.w)}" height="${lay.plot.h}" fill="transparent"></rect>${bar.h > 0 ? html`<rect class="cp-bar" x="${x(bar.x)}" y="${number(bar.y)}" width="${x(Math.max(0.5, bar.w - 0.5))}" height="${number(bar.h)}"></rect>` : null}${bar.peakY !== null ? html`<line class="cp-peak-line" x1="${x(bar.x)}" x2="${x(bar.x + bar.w)}" y1="${number(bar.peakY)}" y2="${number(bar.peakY)}"></line>` : null}</g>`)}
    ${lay.limit ? html`<line class="cp-slots" x1="${x(lay.plot.x)}" x2="${x(lay.plot.x + lay.plot.w)}" y1="${number(lay.limit.y)}" y2="${number(lay.limit.y)}"></line><text class="cp-ll" x="${x(lay.plot.x)}" y="${Math.max(9, lay.limit.y - 4)}">${lay.limit.label}</text>` : null}
    <line class="cp-base" x1="${x(lay.plot.x)}" x2="${x(lay.plot.x + lay.plot.w)}" y1="${bottom}" y2="${bottom}"></line>
    <line class="cp-now" x1="${x(lay.plot.x + lay.plot.w)}" x2="${x(lay.plot.x + lay.plot.w)}" y1="${lay.plot.y}" y2="${bottom}"></line>
    <text class="cp-ll cp-ll--now" x="${x(lay.plot.x + lay.plot.w)}" y="9" text-anchor="end">now</text>
    ${labels.map((l) => html`<text class="cp-d" x="${x(l.x)}" y="${lay.height - 2}" text-anchor="middle">${l.text}</text>`)}
  </svg>`;
}

export function capacityHosts(v, tips = []) {
  const raw = payload(v), c = normCapacity(raw);
  if (!c || c.unreachable) return card("Capacity not read", ui.banner({ status: "failed", title: "Capacity not read", body: c?.unreachable ?? "The report could not be read; the other Spend views still work." }));
  if (c.noTime) return card("Capacity", ui.banner({ status: "idle", title: "No time in this window yet", body: html`This window starts at ${timeHtml(c.fromMs)}.` }));
  return html`<div class="stack">${c.hosts.length ? c.hosts.map((host) => {
    const original = raw.hosts?.find((h) => h.name === host.name);
    const venues = Array.isArray(original?.venues) ? original.venues.filter((s) => typeof s === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(s)).slice(0, 16) : [];
    const f = host.facts;
    const detail = html`<span class="cp-host-meta">${venues.length ? ui.chip(venues.join(", ")) : "Venues unknown"} · ${host.slots === null ? "slot count unknown" : `${host.slots} slots`}</span>`;
    return html`<article class="card" id="p-cap-${host.name}"><div class="card__head"><h2 class="card__title">${host.name}</h2>${detail}</div><div class="card__body">
      ${f ? html`<div class="cp-trio"><span><b>${f.busy}</b> busy</span><span><b>${f.idle}</b> idle</span><span class="cp-trio__0"><b>${f.missing ?? "0%"}</b> no data</span></div>` : note(host.notShared ?? "No history here.")}
      ${f?.missing ? note("Busy and idle are shares of covered time; no data is a share of the whole window.") : null}
      ${chart(host, c, tips, v.now)}
      ${f ? html`<div class="cp-facts">${ui.facts([["Jobs at once", `average ${f.avg}, peak ${f.peak}${f.slots === null ? "" : ` of ${f.slots}`}`], ["Promised", [f.memory, f.cpu].filter(Boolean).join(", ") || "unknown"], ["Wait for a slot", f.wait ?? "No run recorded one"]], { cols: 1 })}${ui.facts([["Full", f.full === null ? "unknown" : `${f.full} of the time`], ["CPU used", f.cpuUsed ?? "unknown"], ["Projects by run time", f.projects.length ? f.projects.join(", ") : "No project recorded"]], { cols: 1 })}</div>` : null}
      ${host.truncated ? ui.banner({ status: "attention", title: "History truncated", body: html`History starts at ${timeHtml(host.fromMs)}. Earlier time is drawn as no data, never as idle.`, sm: true }) : null}
      ${(host.caveats ?? []).map((text) => html`<p class="sp-note cp-caveat">${text}</p>`)}${host.notes ? note(host.notes) : null}
    </div></article>`;
  }) : note(c.noRun)}${c.notDrawn && (c.notDrawn.numbers + c.notDrawn.empty + c.notDrawn["not-shared"] > 0) ? note(`Hosts not drawn past 20: ${(raw.hosts ?? []).filter((h) => !c.hosts.some((x) => x.name === h.name) && /^[A-Za-z0-9._-]{1,64}$/.test(h.name)).map((h) => h.name).join(", ")}.`) : null}${c.notDrawn?.unnamed ? note(`${c.notDrawn.unnamed} hosts not drawn: not a worker name.`) : null}${c.notDrawn?.repeated ? note(`${c.notDrawn.repeated} repeated host names not drawn.`) : null}</div>`;
}

export function capacityKey() {
  return card("How to read the chart", html`<ul class="cp-key"><li><svg width="22" height="16" aria-hidden="true"><rect class="cp-bar" x="4" y="1" width="12" height="14" rx="2"></rect></svg><span><b>Bar</b> average jobs at once in the bucket</span></li><li><svg width="22" height="16" aria-hidden="true"><line class="cp-peak-line" x1="2" x2="20" y1="8" y2="8"></line></svg><span><b>Tick</b> most jobs at once in the bucket</span></li><li><svg width="22" height="16" aria-hidden="true"><line class="cp-slots" x1="2" x2="20" y1="8" y2="8"></line></svg><span><b>Dashed line</b> the host's slots</span></li><li><svg width="22" height="16" aria-hidden="true"><rect class="cp-nd-bg" width="22" height="16"></rect><path class="cp-hatch" d="M0 8L8 0M0 16L16 0M8 16L22 2M16 16L22 10"></path></svg><span><b>Hatched</b> no data: neither busy nor idle</span></li><li><svg width="22" height="16" aria-hidden="true"><line class="cp-base" x1="2" x2="20" y1="8" y2="8"></line></svg><span><b>Empty</b> idle: no job held a slot</span></li></ul>`);
}
export function capacityCoverage(v) {
  const c = payload(v), counts = c?.coverageCounts;
  const fields = [["Runs counted", "used"], ["Refused before a slot", "refusedBeforeSlot"], ["Retried", "retried"], ["Without a size", "withoutSize"], ["Running now", "running"], ["Live runs not counted", "liveNotCounted"]];
  return card("Coverage", html`${counts ? ui.facts(fields.map(([label, key]) => [label, counts[key] ?? "unknown"]), { cols: 1 }) : note("Coverage counts were not published by this report.")}${(Array.isArray(c?.coverage) ? c.coverage : []).map(note)}${note(INSIGHTS_CAPACITY_JOBS_ONLY)}`);
}
export function capacityStates(v) {
  const raw = payload(v), c = normCapacity(raw);
  const state = !c || c.unreachable ? { status: "failed", title: "Capacity not read", body: "The report did not answer, so nothing is drawn. The other Spend views still work." } : c.noTime ? { status: "idle", title: "No time in this window yet", body: html`This window starts at ${timeHtml(c.fromMs)}.` } : raw?.fleet?.incomplete ? { status: "attention", title: "Incomplete history", body: "Missing time is drawn as no data and is never counted as idle." } : { status: "ok", title: "History read", body: "History coverage is shown with each host. At most 20 hosts are drawn." };
  return card("Other states", html`${ui.banner({ ...state, sm: true })}${raw?.venuesUnreadable ? ui.banner({ status: "attention", title: "Host venues not read", body: "The registry did not answer; host venues and current fleet slots remain unknown.", sm: true }) : null}`);
}
