/**
 * One project's configuration, from the same readers and planners its writes use (#751).
 * Nothing here runs a resolver. Raw records, member paths and the planners' mutations stay inside this assembly;
 * the returned view carries labels, names and measurements, and the agent projection narrows it again.
 */
import * as nodeFs from "node:fs";
import { basename } from "node:path";
import { resolveJobSize } from "@edgehero/pi-dispatch/job-size";
import { parseLiveJobs, parseJobsMore } from "@edgehero/pi-dispatch/live-jobs";
import { dayKey, weekKey, monthKey } from "@edgehero/pi-dispatch/budget";
import { PROJECT_ID_RE } from "@edgehero/pi-dispatch/projects";
import { deploymentServiceEnv } from "@edgehero/pi-dispatch/service-env";
import { costsSinceMs, recordInProject, recordInRepo } from "./costs.mjs";
import { assembleAllocationView, recordSpendOf } from "./insights-assembly.mjs";
import { readProjects, readScopedLimits, readTriggers, readSettingsView, readSubscriptions, scanRunRecords, readSizeSuggestions, hostBudgetsOf, secretBundlesView, attributeRunsToTriggers } from "./read-model.mjs";
import { planProjectEdit, planProjectDelete } from "./write-plans.mjs";
import { outcomeKey, recordReason, reasonWords } from "./words.mjs";

const DAY = 86_400_000;
const instant = (r) => Date.parse(r?.endedAt ?? r?.startedAt ?? "");
const amount = (n) => Number.isSafeInteger(n) && n >= 0 ? n : null;
const folder = (s) => String(s).split(/[\\/]/).filter(Boolean).at(-1) ?? "folder";
const memberLabel = (s) => /^(?:\/|[A-Za-z]:[\\/])/.test(s) ? `.../${folder(s)}` : s;
const WINDOW_KEYS = Object.freeze({ day: dayKey, week: weekKey, month: monthKey });
const WORST = Object.freeze({ failed: 6, "awaiting-approval": 5, "awaiting-input": 4, refused: 3, cancelled: 2, completed: 1 });

/** Four bounded pages across the fleet; the page says when that cap leaves older records outside its view. */
export async function readProjectFleetRuns(fleet, { sinceMs } = {}) {
  if (typeof fleet?.runsPage !== "function") return { runs: [], incomplete: true };
  const runs = [];
  let before = null;
  for (let page = 0; page < 4; page++) {
    let got;
    try { got = await fleet.runsPage({ before, limit: 100 }); } catch { return { runs, incomplete: true }; }
    if (!Array.isArray(got?.runs)) return { runs, incomplete: true };
    runs.push(...got.runs);
    if (got.unreachable || got.truncated || typeof got.mirror === "string" && got.mirror.startsWith("unreachable")) return { runs, incomplete: true };
    if (got.next === null || got.next === undefined || got.next <= sinceMs) return { runs, incomplete: false };
    if (!Number.isFinite(got.next) || before !== null && got.next >= before) return { runs, incomplete: true };
    before = got.next;
  }
  return { runs, incomplete: true };
}

/** UTC windows are the enforcement's own buckets, including holds placed before today in a week/month window. */
export function projectWindowStart(window, now) {
  if (window === "day") return Math.floor(now / DAY) * DAY;
  return costsSinceMs(window === "week" ? "week" : "mtd", now);
}

/** Known holds and their completeness. A missing old-host field is unknown, never an invented zero. */
export function projectHolds(hosts, { id, window = "week", now, unreadable = false } = {}) {
  if (unreadable || !Array.isArray(hosts)) return { micros: null, knownMicros: 0, incomplete: true };
  const key = WINDOW_KEYS[window] ?? weekKey;
  const bucket = key(new Date(now));
  let knownMicros = 0;
  let incomplete = false;
  const seen = new Set();
  for (const h of hosts) {
    const parsed = parseLiveJobs(h?.jobs);
    const more = parseJobsMore(h?.jobsMore);
    if (parsed.jobs === null || parsed.dropped > 0 || more === null || more > 0) incomplete = true;
    for (const job of parsed.jobs ?? []) {
      if (job.p !== id || seen.has(job.id)) continue;
      seen.add(job.id);
      if (amount(job.h) === null || !Number.isSafeInteger(job.ha)) { incomplete = true; continue; }
      if (job.ha > now || key(new Date(job.ha)) !== bucket) continue;
      knownMicros += job.h;
    }
  }
  if (!Number.isSafeInteger(knownMicros)) return { micros: null, knownMicros: null, incomplete: true };
  return { micros: incomplete ? null : knownMicros, knownMicros, incomplete };
}

/** Only the two calls the worker emits can become a size preview. No arbitrary call is translated into a write. */
export function projectSizeAction(call, id) {
  if (typeof call !== "string") return null;
  const match = /^(dispatch_limit_(edit|add)) (\{[^\n]{1,180}\})$/.exec(call);
  if (!match) return null;
  let fields;
  try { fields = JSON.parse(match[3]); } catch { return null; }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const allowed = match[2] === "edit" ? ["index", "memory", "cpus"] : ["scope", "memory", "cpus"];
  if (Object.keys(fields).some((k) => !allowed.includes(k))) return null;
  if (match[2] === "edit" ? !Number.isSafeInteger(fields.index) || fields.index < 0 : fields.scope !== `project:${id}`) return null;
  if (!Object.hasOwn(fields, "memory") && !Object.hasOwn(fields, "cpus")) return null;
  if (fields.memory !== undefined && !/^[1-9][0-9]*(?:g|m)$/.test(fields.memory)) return null;
  if (fields.cpus !== undefined && (typeof fields.cpus !== "number" || !Number.isFinite(fields.cpus) || fields.cpus <= 0)) return null;
  const { index, ...limit } = fields;
  return { action: `limit-${match[2]}`, limit, ...(index === undefined ? {} : { index }), row: index === undefined ? null : index + 1 };
}

/** Only typed facts from the actual preflight may explain a blocker; raw planner text never becomes page copy. */
function projectRefusal(result, id, operation) {
  if (!result?.refusal) return null;
  const blocker = result.blocker;
  const deleting = operation === "delete";
  const prefix = `Delete project ${id}: refused while`;
  if (blocker?.kind === "bundle") {
    const bindings = (blocker.bindings ?? []).filter((b) => b.project === id && typeof b.bundle === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(b.bundle));
    if (bindings.length) {
      const names = bindings.map((b) => b.bundle).join(", ");
      return deleting ? `${prefix} secret bundle ${names} names it. Change that bundle in triggers.json first.` : `Members cannot be edited while secret bundle ${names} names ${id}. Change the bundle in triggers.json first.`;
    }
  }
  if (blocker?.kind === "limits") {
    const rows = (blocker.rows ?? []).filter((r) => r.project === id && Number.isSafeInteger(r.index) && r.index >= 0).map((r) => r.index + 1);
    if (rows.length) return `${prefix} scoped limits ${rows.length === 1 ? "row" : "rows"} ${rows.join(", ")} (project:${id}) ${rows.length === 1 ? "names" : "name"} it. Remove ${rows.length === 1 ? "that row" : "those rows"} first.`;
  }
  if (blocker?.kind === "envelope-floor" && blocker.projects?.includes(id)) return `${prefix} an envelope floor names it. Remove that floor first.`;
  if (blocker?.kind === "source" && ["triggers", "projects", "scoped-limits"].includes(blocker.source)) return `The ${blocker.source} file could not be loaded, so this project's change cannot be checked. Run pi-dispatch doctor and correct that file.`;
  return "The project configuration could not be checked. Run pi-dispatch doctor, then preview again.";
}

function runView(r, subscriptions, pricing) {
  const reason = recordReason(r);
  const cost = recordSpendOf(r, { subscriptions, pricing });
  return { jobId: r.jobId ?? null, target: r.kind === "local" ? memberLabel(r.target ?? "local folder") : r.target ?? null, kind: r.kind ?? null, at: Number.isFinite(instant(r)) ? instant(r) : null, outcome: outcomeKey(r.outcome, reason) ?? "unknown", reason, reasonSentence: reason ? reasonWords(reason).sentence ?? reason : null, host: r.host ?? null, micros: cost.micros, costFloor: cost.floor };
}

/**
 * Page-specific I/O: `reads` replaces individual readers in tests; `snapshot` is the fleet's existing safe snapshot.
 * No method is added to the global snapshot, so these joins cost the overview and state API nothing.
 */
export async function readProjectView({ id, paths = {}, env = {}, deploymentDir = null, platform = process.platform, uid = process.geteuid?.(), now = Date.now(), pricing, snapshot = null, fleet = null, reads = {}, fs = nodeFs } = {}) {
  if (typeof id !== "string" || !PROJECT_ID_RE.test(id)) return { id: null, state: "missing" };
  const io = { projects: readProjects, limits: readScopedLimits, triggers: readTriggers, settings: readSettingsView, subscriptions: readSubscriptions, scan: scanRunRecords, allocation: assembleAllocationView, sizing: readSizeSuggestions, edit: planProjectEdit, delete: planProjectDelete, fleetRuns: (opts) => readProjectFleetRuns(fleet, opts), ...reads };
  let pv;
  try { pv = await io.projects({ projectsPath: paths.projectsFile, fs }); } catch { pv = null; }
  if (!pv || pv.invalid || pv.unreadable || !Array.isArray(pv.projects)) return { id, state: "unreadable", problem: "The projects file could not be read. Run pi-dispatch doctor for the reason." };
  const current = pv.projects?.find((p) => p.id === id);
  if (!current) return { id, state: "missing" };
  let sizeMetadata = null;
  let sizeMetadataUnreadable = false;
  if (deploymentDir !== null) {
    try {
      sizeMetadata = (reads.environment ?? deploymentServiceEnv)({ env: {}, dir: deploymentDir, keys: ["PI_JOB_MEMORY", "PI_JOB_CPUS"], fs, platform, uid });
      sizeMetadataUnreadable = !sizeMetadata || Boolean(sizeMetadata.unreadable || sizeMetadata.untrusted || sizeMetadata.hazard || sizeMetadata.unread?.length || sizeMetadata.hazardSkipped?.length);
      // This page describes the deployment's file. The console shell's different setting does not change a service.
      env = { ...env };
      for (const key of ["PI_JOB_MEMORY", "PI_JOB_CPUS"]) if (typeof sizeMetadata?.env?.[key] === "string") env[key] = sizeMetadata.env[key];
    } catch { sizeMetadataUnreadable = true; }
  }
  const guarded = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
  // A 31-day month may start before the sizing window. Spend must still include its first day.
  const historySince = Math.min(now - 30 * DAY, costsSinceMs("mtd", now));
  const [sl, triggers, settings, subs, scanned, allocation, fleetHistory] = await Promise.all([
    guarded(() => io.limits({ scopedLimitsPath: paths.scopedLimitsPath, fs }), null),
    guarded(() => io.triggers({ triggersPath: paths.triggersPath, fs }), null),
    guarded(() => io.settings({ settingsFile: paths.settingsFile, fs }), null),
    guarded(() => io.subscriptions({ subscriptionsPath: paths.subscriptionsPath, fs }), null),
    guarded(() => io.scan({ logsDir: paths.logsDir, sinceMs: historySince, nowMs: now, fs }), null),
    guarded(() => io.allocation(paths, null, { consoleView: true, role: "viewer", nowMs: now, envFn: () => env }), { problem: "The allocation could not be read." }),
    guarded(() => io.fleetRuns({ sinceMs: historySince, nowMs: now }), { runs: [], incomplete: true }),
  ]);
  const limits = Array.isArray(sl?.limits) ? sl.limits : [];
  const subscriptions = Array.isArray(subs?.subscriptions) ? subs.subscriptions : [];
  const historyReadable = Array.isArray(scanned);
  // The local file is authoritative over a mirrored record with the same id, as it is in the fleet reader.
  const records = new Map([...(Array.isArray(snapshot?.runs) ? snapshot.runs : []), ...(Array.isArray(fleetHistory?.runs) ? fleetHistory.runs : [])].map((r) => [r.jobId, r]));
  for (const r of Array.isArray(scanned) ? scanned : []) records.set(r.jobId, r);
  const history = [...records.values()].filter((r) => Number.isFinite(instant(r)) && instant(r) <= now && instant(r) >= historySince).sort((a, b) => instant(b) - instant(a));
  const recorded = history.filter((r) => recordInProject(r, id));
  const day = recorded.filter((r) => instant(r) >= now - DAY);
  const window = ["day", "week", "month"].includes(allocation?.window) ? allocation.window : "week";
  const since = projectWindowStart(window, now);
  const selected = recorded.filter((r) => instant(r) >= since);
  const hostRows = snapshot?.hostBudgets;
  // A failed registry tick retains its last rows. Those rows are useful context, not evidence of current holds or room.
  const registryUnreadable = Boolean(snapshot?.queue?.fleetDegraded || snapshot?.fleetDegraded);
  const holds = projectHolds(hostRows, { id, window, now, unreadable: registryUnreadable });
  let historySpent = historyReadable ? 0 : null;
  let historyFloor = !historyReadable;
  for (const r of selected) {
    const cost = recordSpendOf(r, { subscriptions, pricing });
    if (cost.micros === null) historyFloor = true;
    else if (historySpent !== null) historySpent += cost.micros;
    historyFloor ||= cost.floor;
  }
  const envelope = allocation?.unset !== true && Boolean(paths.envelopeFile);
  const usedMicros = envelope ? amount(allocation?.spend?.projects?.[id]) : historySpent !== null && holds.micros !== null ? historySpent + holds.micros : null;
  const settledMicros = envelope ? usedMicros !== null && holds.micros !== null && usedMicros >= holds.micros ? usedMicros - holds.micros : null : historySpent;
  const limitRows = limits.flatMap((l, index) => l.scope === `project:${id}` ? [{ index, ...l }] : []);
  let size = null;
  try {
    if (sl && !sl.invalid && !sl.unreadable) {
      const resolved = resolveJobSize({ project: id, limits, env });
      const row = limitRows[0];
      const rowHas = (field) => row?.[field] !== null && row?.[field] !== undefined;
      const source = (field, key) => rowHas(field) ? "project row" : sizeMetadataUnreadable ? "unknown (deployment metadata unreadable)" : sizeMetadata?.env?.[key] ? "deployment settings" : env[key] ? deploymentDir ? "worker environment visible here" : "deployment settings" : deploymentDir ? "default (a host's worker environment may override it)" : "default";
      size = { ...resolved, memMiB: sizeMetadataUnreadable && !rowHas("memory") ? null : resolved.memMiB, cpuCenti: sizeMetadataUnreadable && !rowHas("cpus") ? null : resolved.cpuCenti, memorySource: source("memory", "PI_JOB_MEMORY"), cpuSource: source("cpus", "PI_JOB_CPUS") };
    }
  } catch { /* A malformed deployment size stays unknown, never the default. */ }
  const sizeUnknown = sizeMetadataUnreadable && (!size || size.memMiB === null || size.cpuCenti === null);
  const sizing = sizeUnknown ? null : await guarded(() => io.sizing({ logsDir: paths.logsDir, projectIds: [id], limits, env, hostBudgets: Array.isArray(hostRows) && !registryUnreadable ? hostBudgetsOf(hostRows) : null, nowMs: now, withSeries: true, fs }), null);
  const suggestion = sizing?.projects?.[id] ?? null;
  const sizingView = suggestion ? { ...suggestion, action: projectSizeAction(suggestion.call, id), series: Array.isArray(suggestion.series) ? suggestion.series.slice(-50) : [] } : null;
  const bundles = secretBundlesView({ triggers, settings, env, projects: pv, runs: history, fs });
  let bundle = bundles?.bundles?.find((b) => b.project === id) ?? null;
  // A no-op member edit bypasses the bundle guard. Judge an actual valid membership change, never write it.
  const memberSet = new Set((pv.projects ?? []).flatMap((p) => p.members ?? []));
  let probe = `github:pi-dispatch-preflight/${id}`;
  while (memberSet.has(probe)) probe += "-x";
  const probeMembers = current.members.length > 1 ? current.members.slice(0, -1) : [probe];
  const edit = await guarded(() => io.edit({ params: { id, members: probeMembers }, paths, env, fs }), { refusal: "The console could not check whether the members can change." });
  const deletion = await guarded(() => io.delete({ id, paths, env, fs }), { refusal: "The console could not check whether this project can be deleted." });
  // The display reader is deliberately lenient. A strict planner may find a broken bundle declaration it could
  // not display, so its trigger-load refusal is also evidence that "no bundle" would be an unsafe claim.
  const bundleKnown = Array.isArray(triggers?.triggers) && !triggers.invalid && !triggers.unreadable && ![edit, deletion].some((result) => result?.blocker?.kind === "source" && result.blocker.source === "triggers" || result?.refusal && !result.blocker);
  if (!bundleKnown) bundle = null;
  const counts = Object.fromEntries(["completed", "failed", "refused", "cancelled", "awaiting-input", "awaiting-approval"].map((k) => [k, 0]));
  for (const r of day) { const key = outcomeKey(r.outcome, recordReason(r)); if (key) counts[key]++; }
  const worst = [...day].sort((a, b) => (WORST[outcomeKey(b.outcome, recordReason(b))] ?? 0) - (WORST[outcomeKey(a.outcome, recordReason(a))] ?? 0) || instant(b) - instant(a))[0];
  const queued = Array.isArray(snapshot?.waiting?.rows) ? snapshot.waiting.rows.filter((r) => r.project === id) : [];
  const attributed = attributeRunsToTriggers({ records: day, triggers: triggers?.triggers ?? [] });
  const triggerCounts = new Map();
  for (const r of day) {
    const match = attributed?.byJobId?.[r.jobId];
    const index = Number.isSafeInteger(r.triggerIndex) ? r.triggerIndex : Number.isSafeInteger(match?.index) ? match.index : null;
    const t = triggers?.triggers?.find((t) => index !== null ? t.index === index : t.type === "cron" && t.id === r.triggerId);
    if (t) triggerCounts.set(t.index, { index: t.index, type: t.type, forge: t.forge ?? null, id: t.id ?? null, flow: t.flow ?? null, count: (triggerCounts.get(t.index)?.count ?? 0) + 1 });
  }
  const members = current.members.map((m) => {
    const local = /^(?:\/|[A-Za-z]:[\\/])/.test(m);
    // Local records deliberately keep a basename, not a host path. Two members with that basename cannot be split.
    const ambiguous = local && current.members.filter((other) => /^(?:\/|[A-Za-z]:[\\/])/.test(other) && folder(other) === folder(m)).length > 1;
    const memberRuns = history.filter((r) => m.startsWith("/") ? r.kind === "local" && r.project === id && r.target === `local:${folder(m)}` : recordInRepo(r, m));
    const weekly = memberRuns.filter((r) => instant(r) >= costsSinceMs("week", now));
    return { label: memberLabel(m), local, count: ambiguous ? null : weekly.length, last: !ambiguous && memberRuns[0] ? runView(memberRuns[0], subscriptions, pricing) : null, ...(ambiguous ? { caveat: "Local run records carry only the last folder name, so these members' runs cannot be told apart." } : {}) };
  });
  const weights = allocation?.state?.weights ?? {};
  const totalWeight = Object.values(weights).filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0).reduce((n, v) => n + v, 0);
  return {
    id, state: "ready", project: { id, name: current.name ?? null }, file: basename(paths.projectsFile ?? "projects.json"), now,
    members, memberInput: current.members.some((m) => /^(?:\/|[A-Za-z]:[\\/])/.test(m)) ? "" : current.members.join("\n"),
    historyIncomplete: !historyReadable || fleetHistory?.incomplete !== false || typeof snapshot?.runMirror === "string" && snapshot.runMirror.startsWith("unreachable"),
    runs24h: { total: day.length, counts, inLine: snapshot?.waiting && !snapshot.waiting.unreachable ? queued.length : null, inLineIncomplete: snapshot?.waiting?.truncated === true, worst: worst ? runView(worst, subscriptions, pricing) : null },
    recent: recorded.slice(0, 5).map((r) => runView(r, subscriptions, pricing)), totalRuns: recorded.length,
    spend: { window, since, envelope, usedMicros, settledMicros, heldMicros: holds.micros, heldKnownMicros: holds.knownMicros, heldIncomplete: holds.incomplete, floor: envelope ? false : historyFloor, shareMicros: amount(allocation?.state?.allocations?.[id]), problem: allocation?.problem ? "The allocation file could not be read. Run pi-dispatch doctor for the reason." : allocation?.unreachable ? "The allocation could not be read from Valkey." : null },
    allocation: { window, shareMicros: amount(allocation?.state?.allocations?.[id]), totalMicros: amount(allocation?.totalMicros), floorMicros: amount(allocation?.floors?.[id]), weight: amount(weights[id]), totalWeight: amount(totalWeight), split: allocation?.state ? { id: allocation.state.planId ?? null, writer: allocation.state.writer ?? null, appliedAt: allocation.state.appliedAt ?? null, validUntil: allocation.state.validUntil ?? null } : null, refused: selected.filter((r) => recordReason(r) === "allocation-cap").length, unset: !envelope, problem: allocation?.problem || allocation?.unreachable ? "The allocation could not be read." : null },
    size, sizing: sizingView, sizingUnreadable: registryUnreadable || !sizing || Boolean(sizing.unreachable) || !sl || Boolean(sl.invalid || sl.unreadable), limits: limitRows, limitsUnreadable: !sl || Boolean(sl.invalid || sl.unreadable), bundle, bundleKnown,
    triggers: [...triggerCounts.values()].sort((a, b) => a.index - b.index), editRefusal: projectRefusal(edit, id, "edit"), deleteRefusal: projectRefusal(deletion, id, "delete"),
  };
}

/** New model-visible fields are rebuilt explicitly. Bundle variable names and member paths stay with the person. */
export function projectViewForAgent(view) {
  if (view?.state !== "ready") return { id: view?.id ?? null, state: view?.state ?? "unreadable" };
  const b = view.bundle;
  return { id: view.id, state: "ready", spend: { window: view.spend.window, usedMicros: view.spend.usedMicros, settledMicros: view.spend.settledMicros, heldMicros: view.spend.heldMicros, shareMicros: view.spend.shareMicros, incomplete: view.spend.heldIncomplete || view.historyIncomplete }, size: view.size ? { memMiB: view.size.memMiB, cpuCenti: view.size.cpuCenti, source: view.size.source, memorySource: view.size.memorySource, cpuSource: view.size.cpuSource } : null, suggestion: view.sizing ? { memory: { reason: view.sizing.memory?.reason ?? null, current: view.sizing.memory?.current ?? null, suggested: view.sizing.memory?.suggested ?? null }, cpu: { reason: view.sizing.cpu?.reason ?? null, current: view.sizing.cpu?.current ?? null, suggested: view.sizing.cpu?.suggested ?? null }, call: view.sizing.call ?? null } : null, bundleKnown: view.bundleKnown !== false, bundle: b ? { id: b.id, profile: b.profile, declared: b.declared, variables: b.last?.variables?.length ?? 0, forkReviews: b.forkReviews === true } : null, editRefusal: view.editRefusal, deleteRefusal: view.deleteRefusal };
}
