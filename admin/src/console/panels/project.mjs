/** ProjectDetail's pure Pulse panels (#751); reads and planner preflights live in project-view.mjs. */
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { formatCpus, parseMemory } from "@edgehero/pi-dispatch/job-size";
import { parseUsdMicros } from "@edgehero/pi-dispatch/money";
import { bundleDeclaredText } from "../../read-model.mjs";
import { OUTCOME_KEY_WORDS, reasonWords, shortSentence } from "../../words.mjs";
import { canAct, runLink, timeHtml, usdText, moneyHtml } from "./common.mjs";
import { actForm } from "./config-ui.mjs";

const DAY = 86_400_000;
const data = (v) => v?.data?.projectView ?? null;
const ready = (v) => data(v)?.state === "ready";
const card = (title, body, sub = null) => ui.card({ title, body, sub });
const note = (s) => html`<p class="muted proj-note">${s}</p>`;
const n = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
const sizeText = (mib) => Number.isFinite(mib) ? mib % 1024 === 0 ? `${mib / 1024} GiB` : `${mib} MiB` : "unknown";
const money = (v) => usdText(v) === "-" ? "unknown" : moneyHtml(v);
const unknown = (v) => v === null || v === undefined ? "unknown" : v;
const at = (value) => typeof value === "number" ? value : Date.parse(value ?? "");
const linkRuns = (id) => `/runs?project=${encodeURIComponent(id)}`;
const issue = (v) => !data(v) || data(v)?.state === "unreadable" ? card("Project unavailable", note(data(v)?.problem ?? "The project could not be read. Reload to try again.")) : null;
const facts = (pairs) => ui.facts(pairs, { cols: 1 });
const gibText = (mib) => Number.isFinite(mib) ? `${(mib / 1024).toFixed(1)} GiB` : "unknown";
// The worker owns the evidence sentences. Convert only their memory-unit tokens, never a command or reason.
const memoryWords = (text) => typeof text === "string" ? text.replace(/\b(\d+(?:\.\d+)?)(g|m)\b/g, (_all, value, unit) => gibText(Number(value) * (unit === "g" ? 1024 : 1))) : text;
const runBadge = (r) => {
  const word = OUTCOME_KEY_WORDS[r.outcome];
  return ui.badge(r.outcome === "completed" ? "idle" : word?.status ?? "attention", word ? word.word.charAt(0).toUpperCase() + word.word.slice(1) : "Unknown", { icon: r.outcome === "completed" ? ui.STATUS.ok.icon : null });
};
const kindText = (t) => `${String(t.type ?? "unknown").replaceAll("_", " ")}${["github", "gitlab", "forgejo", "azure"].includes(t.forge) ? ` on ${t.forge}` : ""}`;

export const projectTitle = (view) => view?.project?.name || view?.id || "Project";
export const projectDescription = (view) => view?.state === "ready" ? `${view.members.length} member${view.members.length === 1 ? "" : "s"}; id ${view.id} in ${view.file}.` : "Project configuration could not be read.";

export function projectSpend(v) {
  if (!ready(v)) return issue(v);
  const s = data(v).spend;
  const splitKnown = Number.isFinite(s.settledMicros) && Number.isFinite(s.heldMicros);
  const totalKnown = Number.isFinite(s.usedMicros);
  const headline = splitKnown ? s.settledMicros : totalKnown ? s.usedMicros : s.settledMicros;
  const pct = totalKnown && s.shareMicros > 0 ? (s.usedMicros / s.shareMicros) * 100 : null;
  return card(`Spend this ${s.window}`, html`<div class="proj-kv"><b>${s.floor ? "at least " : ""}${money(headline)}</b><span>${splitKnown ? html`+ ${money(s.heldMicros)} held` : totalKnown ? "spent and held" : "spent; held amount unknown"}${s.envelope ? html`, of a ${money(s.shareMicros)} share` : "; no envelope, so no share"}</span></div>${pct === null ? null : html`${ui.meter({ value: s.usedMicros, max: s.shareMicros, label: "Spent and held against the project's allocation share" })}<p class="proj-meter-label">${money(s.usedMicros)} / ${money(s.shareMicros)}</p>`}${!splitKnown && totalKnown ? note("The split between spent and held is unknown.") : null}${s.heldIncomplete && !totalKnown ? note(html`Held money is incomplete; ${money(s.heldKnownMicros)} is known from the hosts that reported it.`) : null}${s.problem ? note(s.problem) : null}`);
}

export function projectRuns(v) {
  if (!ready(v)) return null;
  const p = data(v); const r = p.runs24h;
  const counts = Object.entries(r.counts).filter(([, count]) => count > 0).map(([key, count]) => `${count} ${OUTCOME_KEY_WORDS[key]?.word ?? key}`);
  const worst = r.worst;
  const word = OUTCOME_KEY_WORDS[worst?.outcome];
  const reason = reasonWords(worst?.reason);
  // Some catalog entries first explain the setting, then name its failing prerequisite. Keep that cause in a KPI.
  const cause = reason.known ? reason.sentence.match(/, and (.+?), so /)?.[1] : null;
  const brief = cause ? shortSentence(cause) : reason.short;
  const short = reason.known ? brief.charAt(0).toLowerCase() + brief.slice(1) : "no reason is published";
  return card("Runs, last 24 hours", html`<div class="proj-kv"><b>${r.total}</b><span>${counts.length ? counts.join(", ") : "no retained runs"}; ${unknown(r.inLine)} in line${r.inLineIncomplete ? " (at least)" : ""}</span></div>${worst && worst.outcome !== "completed" ? html`<p class="proj-state tone-${ui.STATUS[word?.status ?? "attention"].tone}">${ui.icon(ui.STATUS[word?.status ?? "attention"].icon, { size: "sm" })}<span>${runLink(worst.jobId, { pulse: true })} ${word?.word ?? "ended"}${worst.host ? html` on ${worst.host}` : null}: ${short}${short.endsWith("…") ? "" : "."}</span></p>` : null}${p.historyIncomplete ? note("Run counts are a bounded view; the retained history or a fleet mirror could not be read completely.") : null}`);
}

export function projectSize(v) {
  if (!ready(v)) return null;
  const p = data(v); const s = p.size;
  return card("Job size", s ? html`<div class="proj-kv"><b>${sizeText(s.memMiB)}</b><span>and ${Number.isFinite(s.cpuCenti) ? formatCpus(s.cpuCenti) : "unknown"} CPUs per job</span></div>${note(s.memorySource === s.cpuSource ? `From ${s.memorySource === "project row" ? "the project row" : s.memorySource}.` : `Memory from ${s.memorySource}; CPUs from ${s.cpuSource}.`)}${p.sizing?.memory?.reason === "oversized" ? html`<p class="proj-state tone-attention">${ui.icon("attention", { size: "sm" })}<span>Larger than its runs use: ${memoryWords(p.sizing.words?.memory)}. A smaller size is suggested.</span></p>` : null}` : note("The job size is unknown because its settings could not be read."));
}

export function projectMembers(v) {
  if (!ready(v)) return null;
  const p = data(v);
  return card("Members", html`<ul class="rows proj-members">${p.members.map((m) => html`<li class="rowpill">${ui.icon(m.local ? "folder" : "git", { size: "sm" })}<b class="code">${m.label}</b><span>${m.local ? "folder" : "repository"}</span><span class="end">${unknown(m.count)} runs this week${m.last ? html` · last ${runLink(m.last.jobId, { pulse: true })} ${timeHtml(m.last.at)}` : m.caveat ? html` · ${m.caveat}` : " · no run in view"}</span></li>`)}</ul>${note(`Runs of these members record project ${p.id} when a worker picks them up; a record keeps the project it was written with.`)}${p.editRefusal ? html`<p class="proj-refusal">${ui.icon("attention", { size: "sm" })}<span>${p.editRefusal}</span></p>` : canAct(v) ? actForm("project-edit", { hidden: [["id", p.id]], fields: html`<div class="field"><label for="proj-members-input">Members</label>${ui.textarea({ id: "proj-members-input", name: "members", value: p.memberInput, rows: 3, maxlength: 16384, describedBy: "proj-members-hint" })}<p class="field__err" data-field-error="members" hidden></p></div><p class="proj-edit-hint" id="proj-members-hint">One repository with its forge, or absolute folder per line. Blank keeps the current members.</p>`, label: "Preview the edit" }) : null}`, `${p.members.length} members`);
}

/** Geometry is exported so tests can verify actual plotted values and changing run sizes, beyond a golden's bytes. */
export function layoutProjectSizingChart(series, { now, currentMiB, suggestedMiB = null } = {}) {
  const width = 560; const height = 190;
  const plot = { left: 68, right: 546, top: 15, bottom: 153 };
  const start = now - 30 * DAY;
  const valid = (Array.isArray(series) ? series : []).filter((p) => Number.isFinite(p?.at) && p.at >= start && p.at <= now && Number.isFinite(p.peakMiB) && p.peakMiB >= 0 && Number.isFinite(p.sizeMiB) && p.sizeMiB > 0).slice(-50).sort((a, b) => a.at - b.at);
  const maximum = Math.max(1024, currentMiB ?? 0, suggestedMiB ?? 0, ...valid.flatMap((p) => [p.peakMiB, p.sizeMiB]));
  const step = Math.max(256, 2 ** Math.ceil(Math.log2(maximum / 4)));
  const topMiB = Math.ceil(maximum / step) * step;
  const x = (t) => plot.left + ((t - start) / (30 * DAY)) * (plot.right - plot.left);
  const y = (m) => plot.bottom - (m / topMiB) * (plot.bottom - plot.top);
  const points = valid.map((p) => ({ ...p, x: x(p.at), y: y(p.peakMiB), sizeY: y(p.sizeMiB) }));
  const segments = [];
  let left = plot.left; let given = valid[0]?.sizeMiB ?? currentMiB;
  for (const p of points) {
    if (Number.isFinite(given)) segments.push({ x1: left, x2: p.x, y1: y(given), y2: y(given), mib: given });
    if (Number.isFinite(given) && given !== p.sizeMiB) segments.push({ x1: p.x, x2: p.x, y1: y(given), y2: p.sizeY, mib: p.sizeMiB });
    left = p.x; given = p.sizeMiB;
  }
  if (Number.isFinite(given)) segments.push({ x1: left, x2: plot.right, y1: y(given), y2: y(given), mib: given });
  if (Number.isFinite(currentMiB) && currentMiB !== given) segments.push({ x1: plot.right, x2: plot.right, y1: y(given), y2: y(currentMiB), mib: currentMiB });
  return { width, height, plot, topMiB, points, segments, suggestedY: Number.isFinite(suggestedMiB) && suggestedMiB > 0 ? y(suggestedMiB) : null, ticks: [0, 1, 2, 3, 4].map((i) => ({ value: (topMiB * i) / 4, y: y((topMiB * i) / 4) })), dates: [0, 10, 20, 30].map((days) => ({ x: x(start + days * DAY), label: new Date(start + days * DAY).toISOString().slice(5, 10), anchor: days === 0 ? "start" : days === 30 ? "end" : "middle" })) };
}

export function projectSizingChart(p) {
  const s = p.sizing;
  const geometry = layoutProjectSizingChart(s?.series, { now: p.now, currentMiB: p.size?.memMiB, suggestedMiB: s?.memory?.suggested });
  const g = geometry;
  const givenSizes = [...new Set(g.segments.map((segment) => segment.mib))];
  return html`<p class="proj-chart-unit">GiB</p><svg class="proj-chart" viewBox="0 0 ${g.width} ${g.height}" role="img" aria-label="Peak memory of each run against its given size and the suggestion, last 30 days"><title>Memory in GiB, over the 30 days ending ${new Date(p.now).toISOString().slice(0, 10)}</title>${g.ticks.map((t) => html`<line class="proj-grid" x1="${g.plot.left}" x2="${g.plot.right}" y1="${n(t.y)}" y2="${n(t.y)}"></line><text class="proj-axis" x="60" y="${n(t.y)}" text-anchor="end" dominant-baseline="middle">${n(t.value / 1024)}</text>`)}${g.segments.map((s) => html`<line class="proj-given" x1="${n(s.x1)}" x2="${n(s.x2)}" y1="${n(s.y1)}" y2="${n(s.y2)}"><title>Size given ${sizeText(s.mib)}</title></line>`)}${g.suggestedY === null ? null : html`<line class="proj-suggested" x1="${g.plot.left}" x2="${g.plot.right}" y1="${n(g.suggestedY)}" y2="${n(g.suggestedY)}"><title>Suggested memory ${sizeText(s.memory.suggested)}</title></line>`}${g.points.map((pt) => html`<circle class="${pt.oom ? "proj-peak proj-peak--oom" : "proj-peak"}" cx="${n(pt.x)}" cy="${n(pt.y)}" r="${pt.oom ? 5 : 4}"><title>${new Date(pt.at).toISOString()}: peak ${sizeText(pt.peakMiB)}, given ${sizeText(pt.sizeMiB)}${pt.oom ? ", out-of-memory kill" : ""}</title></circle>`)}${g.dates.map((d) => html`<text class="proj-axis" x="${n(d.x)}" y="175" text-anchor="${d.anchor}">${d.label}</text>`)}</svg><div class="keyrow proj-key"><span><i class="proj-key-peak"></i>peak of one run</span><span><i class="proj-key-given"></i>size given (solid): ${givenSizes.length === 1 ? sizeText(givenSizes[0]) : givenSizes.length > 1 ? "changes per run" : "unknown"}</span>${g.suggestedY === null ? null : html`<span><i class="proj-key-suggested"></i>suggestion (dashed): ${sizeText(s.memory.suggested)}</span>`}<span><i class="proj-key-oom"></i>out-of-memory kill (red)</span></div>${g.points.length ? null : note("No measured memory peaks in this window.")}`;
}

export function projectSizing(v) {
  if (!ready(v)) return null;
  const p = data(v); const s = p.sizing;
  const dim = (label, d, words) => html`<p class="proj-verdict"><b>${label}: ${d?.suggested ? `suggest ${label === "Memory" ? gibText(d.suggested) : formatCpus(d.suggested) + " CPUs"}` : d?.reason === "not-enough-runs" ? "not enough runs" : d?.reason ?? "unknown"}.</b> ${(label === "Memory" ? memoryWords(words) : words) ?? "No suggestion could be read."}</p>`;
  const action = s?.action;
  return card("Job size", html`${projectSizingChart(p)}${s ? html`${dim("Memory", s.memory, s.words?.memory)}${dim("CPUs", s.cpu, s.words?.cpu)}${[memoryWords(s.words?.memoryHeld), s.words?.memoryFact, s.words?.cpuFact, memoryWords(s.words?.refusal)].filter(Boolean).map(note)}` : note("No size suggestion could be read.")}${p.sizingUnreadable ? note("The measurements or scoped limits could not be read completely.") : null}${note("Measured inside the jobs, so advisory.")}${s?.call && canAct(v) ? html`<p class="proj-sub">The exact call</p><div class="cmd"><code>${s.call}</code><button class="btn btn--sm" type="button" data-copy hidden>Copy</button></div>${action ? note(action.row === null ? `Adds a scoped-limits row for project:${p.id}.` : `Applies to scoped-limits row ${action.row}, project:${p.id}.`) : null}${canAct(v) && action ? actForm(action.action, { hidden: [...(action.index === undefined ? [] : [["index", action.index, "int"]]), ["limit", JSON.stringify(action.limit), "json"]], label: "Preview this size" }) : null}` : null}`, "peak memory per run, last 30 days");
}

export function projectRecent(v) {
  if (!ready(v)) return null;
  const p = data(v);
  const rows = p.recent.map((r) => [
    { html: runLink(r.jobId, { pulse: true }), id: true },
    { html: r.target ?? "unknown", wide: true, tgt: true },
    runBadge(r),
    { html: timeHtml(r.at), when: true },
    { html: html`${r.costFloor && r.micros !== null ? "at least " : null}${money(r.micros)}`, num: true },
  ]);
  return card("Recent runs", html`${ui.tbl({ label: "Recent runs of this project", stack: true, heads: [{ label: "Run", l: "" }, { label: "Target", l: "" }, { label: "Outcome", l: "" }, "Ended", { label: "Cost", num: true }], rows, empty: "No retained run recorded this project." })}<p class="tbl-foot"><a class="link" href="${linkRuns(p.id)}">All ${p.totalRuns} in Runs, filtered to ${p.id}</a></p>${note("The last five runs recorded with this project, within the retained view (30 days or this month, whichever reaches further).")}`);
}

export function projectAllocation(v) {
  if (!ready(v)) return null;
  const a = data(v).allocation;
  return card("Allocation", html`${a.unset ? note("No envelope is configured, so this project has no allocation share.") : html`${facts([["Weight", `${unknown(a.weight)} of ${unknown(a.totalWeight)}`], ["Floor", html`${money(a.floorMicros)} a ${a.window}`], ["Share", html`${money(a.shareMicros)} of the ${money(a.totalMicros)} ${a.window} envelope`], ["Split", a.split ? html`<span class="code">${a.split.id ?? "neutral"}</span> by ${a.split.writer ?? "unknown"}, applied ${timeHtml(at(a.split.appliedAt))}, until ${a.split.validUntil ? timeHtml(at(a.split.validUntil)) : "no expiry"}` : "No split has been published."], ["Refused by the split", `${a.refused} in this ${a.window}, among retained runs`]])}${a.problem ? note(a.problem) : null}`}<p><a class="link" href="/insights/budget-split">Open the budget split</a></p>`);
}

export function projectLimits(v) {
  if (!ready(v)) return null;
  const p = data(v);
  const words = {
    memory: (value) => `${sizeText(parseMemory(value))} memory`,
    cpus: (value) => `${value} CPUs`,
    day: (value) => `${value} jobs a day`, week: (value) => `${value} jobs a week`, month: (value) => `${value} jobs a month`, concurrent: (value) => `${value} at once`,
    dayUsd: (value) => html`${money(parseUsdMicros(value))} a day`, weekUsd: (value) => html`${money(parseUsdMicros(value))} a week`, monthUsd: (value) => html`${money(parseUsdMicros(value))} a month`,
    hostShare: (value) => `${value}% of each host's budget`, minJobs: (value) => `space for at least ${value} jobs on an admitting host`,
  };
  const rows = p.limits.map((l) => {
    const fields = Object.entries(words).filter(([key]) => l[key] !== null && l[key] !== undefined).map(([key, render]) => render(l[key]));
    return [`Row ${l.index + 1}`, html`<span class="code">${l.scope}</span>${fields.length ? html`: ${fields.map((value, index) => html`${index ? ", " : null}${value}`)}` : ": no caps or size fields set"}`];
  });
  return card("Limits", html`${rows.length ? facts(rows) : note("No scoped-limits row names this project.")}${facts([["Jobs a day", p.limits[0]?.day ?? "not set"], ["At once", p.limits[0]?.concurrent ?? "not set; a local folder still runs one job at a time"]])}${p.limitsUnreadable ? note("The scoped-limits file could not be read.") : null}<p><a class="link" href="/config#cf-scoped-limits">Open scoped limits</a></p>`);
}

export function projectBundle(v) {
  if (!ready(v)) return null;
  const p = data(v);
  const b = p.bundle;
  if (p.bundleKnown === false) return card("Secret bundle", html`${note("The triggers file could not be loaded, so whether this project has a secret bundle is unknown. Run pi-dispatch doctor and correct the triggers file.")}<p><a class="link" href="/config/secrets">Open secrets</a></p>`, "names only");
  return card("Secret bundle", html`${b ? facts([["Bundle", html`<span class="code">${b.id}</span> via <span class="code">${b.profile}</span> (${b.format ?? "format unknown"})`], ["Declared", bundleDeclaredText(b)], ["Last received", b.last ? html`${b.last.variables.length ? b.last.variables.join(", ") : "no variables"}; ${runLink(b.last.jobId, { pulse: true })}${b.last.at ? html` at ${timeHtml(at(b.last.at))}` : null}` : "no run in view"], ["Opted out", b.optedOut.length ? b.optedOut.map((i) => `trigger ${i + 1}`).join(", ") : "no trigger"], ["Fork reviews", b.forkReviews ? "yes" : "no"]]) : note("No secret bundle names this project.")}<p><a class="link" href="/config/secrets">Open secrets</a></p>`, "names only");
}

export function projectTriggers(v) {
  if (!ready(v)) return null;
  const p = data(v);
  return card("Triggers that ran here", html`${p.triggers.length ? html`<ul class="rows proj-triggers">${p.triggers.map((t) => html`<li class="rowpill"><a class="link" href="${`/config/trigger?index=${t.index}`}">Trigger ${t.index + 1}</a><span class="proj-trigger-desc">${kindText(t)}${t.id ? html` ${t.id}` : null}${t.flow ? html` → ${t.flow}` : null}</span><span class="end">${t.count} runs</span></li>`)}</ul>` : note("No retained run here was attributed to a trigger in the last 24 hours.")}${note("Forge triggers fire on any member that sends events. A cron trigger runs here when its folder is a member.")}`, "last 24 hours");
}

export function projectDelete(v) {
  if (!ready(v) || v.role !== "operator") return null;
  const p = data(v);
  return card("Delete", p.deleteRefusal ? html`<p class="proj-refusal">${ui.icon("attention", { size: "sm" })}<span>${p.deleteRefusal}</span></p>${canAct(v) ? html`<button class="btn btn--danger btn--sm" type="button" disabled aria-disabled="true">Delete ${p.id}</button>` : null}` : canAct(v) ? html`${note("Removing the project stops future pickups recording this id. Records already written keep it. The preview checks its limits, bundles and envelope floors again.")}${actForm("project-delete", { hidden: [["id", p.id]], label: `Delete ${p.id}` })}` : note("This console is read-only. A writable operator console can preview a delete."));
}
