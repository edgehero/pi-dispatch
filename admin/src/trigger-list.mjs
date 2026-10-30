/**
 * Read-only Triggers list facts. Calendar projection uses BullMQ's pinned parser in a VERIFIED owning-host zone;
 * quiet bands use the worker's actual wall-clock predicate. Neither a projected tick nor an elapsed tick proves a run.
 * All clocks and source coverage arrive as arguments. No queue, filesystem, provider or forge client is opened here.
 */
import cronParser from "cron-parser";
const { parseExpression } = cronParser;
import { windowEndAt } from "@edgehero/pi-dispatch/pause-windows";
import { foldTriggerCosts, meteredRunMicros, refusedBeforeSpend } from "./costs.mjs";
import { recordReason } from "./words.mjs";

const DAY = 86400_000;
const MINUTE = 60_000;
export const TRIGGER_LIST_LIMITS = Object.freeze({ records: 1000, lanes: 64, occurrences: 512, quietWindows: 16 });
export const TRIGGER_LIST_KINDS = Object.freeze(["all", "schedule", "label", "comment", "pull_request", "issue"]);
const TYPES = new Set(["cron", "label", "comment", "pull_request", "issue"]);
const PRICING = Object.freeze({ getPricedModel: () => null, isZeroRated: () => false });
const atOf = (r) => Date.parse(r?.endedAt ?? r?.startedAt ?? "");
const safeTime = (n) => Number.isSafeInteger(n) && n >= 0 ? n : null;
const copyStrings = (value) => Array.isArray(value) ? value.filter((v) => typeof v === "string").slice(0, 64) : [];
const recordOf = (r) => Object.fromEntries(["jobId", "target", "project", "kind", "triggerIndex", "triggerType", "flow", "startedAt", "endedAt", "outcome"].filter((k) => typeof r?.[k] === "string" || Number.isSafeInteger(r?.[k])).map((k) => [k, r[k]]).concat([["reason", recordReason(r)]]));

function ruleOf(t) {
  const scalar = ["index", "type", "forge", "id", "pattern", "phrase", "folder", "flow", "command", "provider", "model", "maxTurns", "backend", "image", "repository", "number", "once", "packages", "resume", "portfolio", "replicas", "maxCostUsd", "secretsProfile", "secretBundle", "awaitInput", "github", "progress", "statusComment", "recover", "steer", "skillsDir", "gateTimeout", "gateBudgetRaiseUsd"];
  const out = Object.fromEntries(scalar.filter((k) => typeof t[k] === "string" || typeof t[k] === "boolean" || Number.isSafeInteger(t[k])).map((k) => [k, t[k]]));
  for (const key of ["maxCostUsd", "gateBudgetRaiseUsd"]) {
    if (typeof t[key] === "number" && Number.isFinite(t[key]) && t[key] >= 0) out[key] = t[key];
    else delete out[key];
  }
  // Prompt text and resolver references cannot pass this projection even if a caller accidentally supplies raw data.
  if (typeof t.command === "string") {
    const words = t.command.trim().split(/\s+/);
    out.command = words[0];
    out.commandArgs = words.length > 1;
  }
  out.displayCut = ["any", "all", "none", "action", "reviewState", "models", "fallbackModels", "mcp", "excludeTools", "gates", "waitFor"].some((k) => Array.isArray(t[k]) && t[k].length > 64);
  out.task = t.task === true;
  out.instructions = t.instructions === true;
  out.secrets = Number.isSafeInteger(t.secrets) && t.secrets >= 0 ? t.secrets : 0;
  for (const key of ["any", "all", "none", "action", "reviewState", "models", "fallbackModels", "mcp", "excludeTools", "gates"]) if (Array.isArray(t[key])) out[key] = copyStrings(t[key]);
  if (t.disarmed && typeof t.disarmed === "object") out.disarmed = Object.fromEntries(["at", "jobId"].filter((k) => typeof t.disarmed[k] === "string").map((k) => [k, t.disarmed[k]]));
  if (Array.isArray(t.waitFor)) out.waitFor = t.waitFor.slice(0, 64).flatMap((w) => typeof w?.profile === "string" ? [{ profile: w.profile }] : typeof w?.after === "string" ? [{ after: w.after }] : []);
  return out;
}

/** A record needs the persisted raw index AND kind/type, or the cron id. A shared flow alone is never attribution. */
export function recordMatchesTrigger(record, trigger) {
  if (trigger.type === "cron") {
    const match = /^(?:repeat|manual):([A-Za-z0-9._-]+):\d+$/.exec(record?.jobId ?? "");
    return record?.kind === "local" && match !== null && match[1] === trigger.id;
  }
  return Number.isSafeInteger(record?.triggerIndex) && record.triggerIndex === trigger.index && record.triggerType === trigger.type && record.kind === trigger.forge;
}

function chipsOf(t, packagesAvailable) {
  const chips = [];
  const add = (kind, text) => chips.push({ kind, text });
  if (t.replicas > 1) add("costs-more", `${t.replicas} independent sandboxes`);
  if (t.backend) add("reaches", `venue ${t.backend}`);
  if (t.image) add("reaches", "custom job image");
  if (packagesAvailable && t.packages !== false) add("reaches", "staged packages");
  if (t.skillsDir) add("reaches", "injected skills");
  if (t.mcp?.length) add("reaches", `MCP: ${t.mcp.join(", ")}`);
  if (t.secrets > 0) add("reaches", `${t.secrets} secret variables${t.secretsProfile ? ` via ${t.secretsProfile}` : ""}`);
  if (t.github === true) add("reaches", "GitHub access");
  if (t.resume === true) add("writes", "keeps a session");
  if (t.type === "cron") add("writes", "edits its local folder");
  if (t.portfolio === true) add("writes", "budget split");
  if (t.instructions) add("writes", "standing instructions");
  if (t.awaitInput === true || t.gates?.length) add("asks", "may wait for a person");
  if (t.steer === true) add("asks", "takes messages");
  if (t.recover === true) add("writes", "recovers a lost run");
  if (t.models?.length || t.maxCostUsd !== undefined || t.waitFor?.length || t.reviewState?.length || t.all?.length || t.none?.length || t.number) add("narrows", "reviewed constraints");
  if (t.secretBundle === false) add("narrows", "no project secret bundle");
  if (t.disarmed) add("spent", "spent one-shot");
  return chips;
}

/** At most 512 future ticks; no process-local timezone fallback is permitted. */
export function scheduledOccurrences({ pattern, zone, start, end, now, limit = TRIGGER_LIST_LIMITS.occurrences } = {}) {
  if (typeof zone !== "string" || zone === "") return { occurrences: [], incomplete: true, problem: "The owning host's timezone is not published; further schedule times are unknown." };
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { return { occurrences: [], incomplete: true, problem: "The owning host's timezone is not usable." }; }
  limit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, TRIGGER_LIST_LIMITS.occurrences)) : TRIGGER_LIST_LIMITS.occurrences;
  const occurrences = [];
  try {
    // Exactly BullMQ 5's defaultRepeatStrategy: cron-parser.parseExpression with currentDate and tz. The caller
    // supplies the published host's zone because the real worker otherwise uses that host's local clock.
    const iterator = parseExpression(pattern, { currentDate: Math.max(start, now), endDate: end - 1, tz: zone });
    while (occurrences.length <= limit) {
      let at;
      try { at = iterator.next().getTime(); } catch { break; }
      if (at >= end) break;
      occurrences.push({ at, kind: "scheduled" });
    }
    const incomplete = occurrences.length > limit;
    return { occurrences: occurrences.slice(0, limit), incomplete, problem: incomplete ? "Dense schedule: only the first projected ticks are shown." : null };
  } catch { return { occurrences: [], incomplete: true, problem: "This schedule's pattern cannot be projected." }; }
}

/**
 * Minute-exact bands from the SAME predicate the pickup gate uses. Windows have minute precision; evaluating each
 * UTC minute also preserves DST folds/gaps and previous-day overnight qualification without inventing another clock.
 * The caller owns one bounded formatter cache, never a process-wide cache of attacker-chosen zone strings.
 */
export function quietIntervals(window, { start, end, formatters = new Map() } = {}) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end - start > 7 * DAY) return { intervals: [], incomplete: true, problem: "Quiet projection requires a bounded seven-day interval." };
  const intervals = [];
  let open = null;
  try {
    for (let at = start; at < end; at += MINUTE) {
      const until = windowEndAt(window, at, formatters);
      const active = until !== null && until > at;
      if (active && open === null) open = at;
      if (!active && open !== null) { intervals.push({ start: open, end: at }); open = null; }
    }
    if (open !== null) intervals.push({ start: open, end });
    return { intervals, incomplete: false, problem: null };
  } catch { return { intervals: [], incomplete: true, problem: "This quiet window cannot be projected." }; }
}

function statsOf(records, weekStart, now, incomplete, subscriptions, pricing) {
  if (records === null) return { runs30d: null, weekRuns: null, weekCostMicros: null, weekCost: null, incomplete: true, costIncomplete: true };
  const week = records.filter((r) => atOf(r) >= weekStart && atOf(r) <= now);
  const costs = week.map((r) => refusedBeforeSpend(r) ? 0 : meteredRunMicros(r, { subscriptions, pricing }));
  const joined = { byJobId: Object.fromEntries(week.map((r) => [r.jobId, { key: "trigger:sum" }])) };
  const cost = foldTriggerCosts({ records: week, subscriptions, pricing, triggerJoin: joined })["trigger:sum"]?.cost ?? { usd: 0, class: "metered", floor: false };
  return { runs30d: records.length, weekRuns: week.length, weekCostMicros: costs.reduce((sum, n) => sum + (n ?? 0), 0), weekCost: cost, incomplete, costIncomplete: costs.some((n) => n === null) };
}

/**
 * Explicit schema shared with the page: rows/groups, unfiltered counts, next fire, typed weekly spend, rolling
 * seven-day lanes and quiet intervals. Records are a bounded retained view; only coverage.complete:true asserts
 * a full requested history. A missing read is null, never a fabricated empty history.
 */
export function triggerListOf({ snapshot = null, records = null, coverage = {}, now, subscriptions = [], pricing = PRICING, scheduleZones = {} } = {}) {
  if (!Number.isSafeInteger(now)) throw new TypeError("triggerListOf requires the caller's clock");
  const dayStart = Math.floor(now / DAY) * DAY;
  const weekStart = dayStart - ((new Date(dayStart).getUTCDay() + 6) % 7) * DAY;
  const end = dayStart + 7 * DAY;
  const view = snapshot?.triggers;
  const problems = ["History uses saved row, type and forge, or a cron id. Editing or renumbering rules can associate runs from an older configuration; these are not stable rule identities."];
  if (!Array.isArray(view?.triggers)) problems.push("The triggers file is not available; rule facts are unknown.");
  const raw = (view?.triggers ?? []).filter((t) => TYPES.has(t?.type) && Number.isSafeInteger(t?.index) && t.index >= 0);
  const rules = raw.map(ruleOf);
  if (Number.isSafeInteger(view?.count) && view.count > (view?.triggers?.length ?? 0)) problems.push("Some file rows cannot be displayed; rule counts are incomplete.");
  const source = Array.isArray(records) ? records : null;
  const valid = source?.filter((r) => Number.isFinite(atOf(r)) && atOf(r) >= now - 30 * DAY && atOf(r) <= now).sort((a, b) => atOf(b) - atOf(a));
  const unique = new Map();
  for (const r of valid ?? []) if (typeof r.jobId === "string" && r.jobId !== "" && !unique.has(r.jobId)) unique.set(r.jobId, r);
  const dedup = valid === undefined ? null : [...unique.values()];
  const kept = dedup?.slice(0, TRIGGER_LIST_LIMITS.records) ?? null;
  const incomplete = source === null || coverage.complete !== true || coverage.partial === true || coverage.truncated === true || (dedup?.length ?? 0) > TRIGGER_LIST_LIMITS.records;
  if (kept === null) problems.push("Run history could not be read; counts and spend are unknown.");
  else if (incomplete) problems.push("Counts and spend cover retained history only and may be lower bounds.");
  const rows = rules.map((trigger) => {
    const own = kept?.filter((r) => recordMatchesTrigger(r, trigger)) ?? null;
    const schedulers = (snapshot?.schedulers ?? []).filter((s) => trigger.type === "cron" && s.key === trigger.id);
    const patternChanged = schedulers.some((s) => s.pattern !== trigger.pattern);
    const published = [...new Set(schedulers.map((s) => safeTime(s.next)))];
    const scheduleConflict = patternChanged || published.length > 1;
    const schedulerProblem = patternChanged ? "The published schedule pattern differs from this file." : published.length > 1 ? "Multiple queues publish conflicting next fires for this scheduler id." : null;
    const at = scheduleConflict ? null : published[0] ?? null;
    const stalls = Number.isSafeInteger(snapshot?.schedulerStalls?.[trigger.id]) ? snapshot.schedulerStalls[trigger.id] : null;
    const stallLimit = (snapshot?.schedulerStallMax ?? 2) + 1;
    const spec = scheduleZones instanceof Map ? scheduleZones.get(trigger.id) : scheduleZones[trigger.id];
    const zone = typeof spec === "string" ? spec : typeof spec?.zone === "string" ? spec.zone : null;
    const hosts = Array.isArray(spec?.hosts) ? spec.hosts.filter(h => typeof h === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(h)).slice(0, 64) : [];
    return { trigger, index: trigger.index, group: trigger.type === "cron" ? "schedule" : trigger.forge ?? "unknown", stats: statsOf(own, weekStart, now, incomplete, subscriptions, pricing), lastRun: own?.[0] ? recordOf(own[0]) : null,
      nextFire: trigger.type === "cron" ? { at, health: stalls !== null && stalls >= stallLimit ? "stalled" : at === null ? "unknown" : at < now ? "overdue" : "on-time", stalls, stallLimit, hosts: scheduleConflict || schedulers.length === 0 ? [] : hosts, zone: scheduleConflict || schedulers.length === 0 ? null : zone, problem: schedulerProblem } : null,
      chips: chipsOf(trigger, (snapshot?.stagedPackages?.packages?.length ?? 0) > 0), unknown: [...(trigger.displayCut ? ["Some selector or option names are omitted from this bounded display."] : []), ...(own === null ? ["History unavailable"] : []), ...(trigger.type === "cron" && at === null ? [schedulerProblem ?? "Scheduler next fire unavailable"] : [])] };
  });
  const counts = { all: rows.length, schedule: rows.filter((r) => r.trigger.type === "cron").length, label: 0, comment: 0, pull_request: 0, issue: 0, watch: (view?.triggers ?? []).filter((t) => t.type === "watch").length, spent: rows.filter((r) => r.trigger.disarmed).length };
  for (const type of ["label", "comment", "pull_request", "issue"]) counts[type] = rows.filter((r) => r.trigger.type === type).length;
  if (!Array.isArray(view?.triggers)) for (const key of Object.keys(counts)) counts[key] = null;
  const groups = [...new Set(rows.map((r) => r.group))].sort((a, b) => a === "schedule" ? -1 : b === "schedule" ? 1 : a.localeCompare(b)).map((key) => ({ key, rows: rows.filter((r) => r.group === key) }));
  const future = rows.filter((r) => r.nextFire?.at !== null && r.nextFire?.at >= now).sort((a, b) => a.nextFire.at - b.nextFire.at);
  const next = future[0] ? { index: future[0].index, id: future[0].trigger.id, at: future[0].nextFire.at } : null;
  const scheduled = rows.filter((r) => r.trigger.type === "cron");
  const lanes = scheduled.slice(0, TRIGGER_LIST_LIMITS.lanes).map((r) => {
    const projected = scheduledOccurrences({ pattern: r.trigger.pattern, zone: r.nextFire.zone, start: dayStart, end, now });
    const observed = (kept ?? []).filter((record) => recordMatchesTrigger(record, r.trigger) && atOf(record) >= dayStart && atOf(record) <= now).map((record) => ({ at: atOf(record), kind: "ran", jobId: record.jobId, outcome: record.outcome }));
    // A published next is real scheduler evidence even when its owning host's timezone is unknown.
    if (r.nextFire.at !== null && r.nextFire.at >= now && r.nextFire.at < end && !projected.occurrences.some((p) => p.at === r.nextFire.at)) projected.occurrences.unshift({ at: r.nextFire.at, kind: "scheduled", published: true });
    const shownObserved = observed.slice(0, Math.floor(TRIGGER_LIST_LIMITS.occurrences / 2));
    const shownProjected = projected.occurrences.slice(0, TRIGGER_LIST_LIMITS.occurrences - shownObserved.length);
    const cut = observed.length > shownObserved.length || projected.occurrences.length > shownProjected.length;
    return { index: r.index, id: r.trigger.id, zone: r.nextFire.zone, occurrences: [...shownObserved, ...shownProjected], incomplete: projected.incomplete || incomplete || cut, problem: projected.problem ?? (cut ? "Only a bounded selection of recorded runs and projected ticks is shown." : null) };
  });
  const windows = Array.isArray(snapshot?.pauseWindows?.windows) ? snapshot.pauseWindows.windows : null;
  const formatters = new Map();
  const quiet = (windows ?? []).slice(0, TRIGGER_LIST_LIMITS.quietWindows).map((window) => ({ scope: window.scope, affects: window.scope === "*" ? "all" : window.scope.startsWith("/") || /^[A-Za-z]:[\\/]/.test(window.scope) ? "local" : "forge", ...quietIntervals(window, { start: dayStart, end, formatters }) }));
  if (windows === null) problems.push("Quiet windows could not be read; bands are unknown.");
  if ((windows?.length ?? 0) > TRIGGER_LIST_LIMITS.quietWindows) problems.push("Only the first quiet windows are projected.");
  if (scheduled.length > TRIGGER_LIST_LIMITS.lanes) problems.push("Only the first schedule lanes are projected.");
  const attributed = Array.isArray(view?.triggers) ? kept?.filter((r) => rules.some((t) => recordMatchesTrigger(r, t))) ?? null : null;
  return { now, rows, groups, counts, next, weekStart, stats: statsOf(attributed, weekStart, now, incomplete, subscriptions, pricing), week: { start: dayStart, end, zone: "UTC", label: "Next 7 days, UTC", lanes, quiet, quietUnknown: windows === null, quietCut: Math.max(0, (windows?.length ?? 0) - TRIGGER_LIST_LIMITS.quietWindows), lanesCut: Math.max(0, scheduled.length - TRIGGER_LIST_LIMITS.lanes) }, coverage: { complete: !incomplete, records: kept?.length ?? null }, problems };
}
