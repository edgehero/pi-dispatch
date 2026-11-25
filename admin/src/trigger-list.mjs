import { copyModelSelection, modelSelectionProblem } from "@edgehero/pi-dispatch/model-ref";
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
import { newerSkippedSentence, readableRecords } from "./newer-release.mjs";
import { fileUnreadWord } from "./secrets-view.mjs";
import { recordMatchesTrigger } from "./trigger-match.mjs";
import { mirrorUnread } from "./mirror-words.mjs";

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
  const scalar = ["index", "type", "forge", "runKind", "localEventDigest", "worker", "debounceSeconds", "id", "pattern", "phrase", "folder", "flow", "command", "provider", "model", "maxTurns", "backend", "image", "repository", "number", "once", "packages", "resume", "portfolio", "replicas", "maxCostUsd", "maxSubscriptionUsd", "secretsProfile", "secretBundle", "awaitInput", "github", "progress", "statusComment", "recover", "steer", "mayMerge", "skillsDir", "gateTimeout", "gateBudgetRaiseUsd"];
  const out = Object.fromEntries(scalar.filter((k) => typeof t[k] === "string" || typeof t[k] === "boolean" || Number.isSafeInteger(t[k])).map((k) => [k, t[k]]));
  for (const key of ["maxCostUsd", "maxSubscriptionUsd", "gateBudgetRaiseUsd"]) {
    if (typeof t[key] === "number" && Number.isFinite(t[key]) && t[key] >= 0) out[key] = t[key];
    else delete out[key];
  }
  // Prompt text and resolver references cannot pass this projection even if a caller accidentally supplies raw data.
  if (typeof t.command === "string") {
    const words = t.command.trim().split(/\s+/);
    out.command = words[0];
    out.commandArgs = words.length > 1;
  }
  out.displayCut = ["any", "all", "none", "action", "reviewState", "reviewAuthors", "closeActors", "models", "fallbackModels", "auxiliaryModels", "mcp", "privateEndpoints", "excludeTools", "excludeExtensions", "excludeExtensionTools", "gates", "waitFor"].some((k) => Array.isArray(t[k]) && t[k].length > 64);
  out.task = t.task === true;
  out.instructions = t.instructions === true;
  out.secrets = Number.isSafeInteger(t.secrets) && t.secrets >= 0 ? t.secrets : 0;
  for (const key of ["any", "all", "none", "action", "reviewState", "reviewAuthors", "closeActors", "models", "fallbackModels", "auxiliaryModels", "mcp", "privateEndpoints", "excludeTools", "excludeExtensions", "excludeExtensionTools", "gates"]) if (Array.isArray(t[key])) out[key] = copyStrings(t[key]);
  if (t.modelSelection !== undefined && modelSelectionProblem(t.modelSelection) === null) out.modelSelection = copyModelSelection(t.modelSelection);
  if (t.disarmed && typeof t.disarmed === "object") out.disarmed = Object.fromEntries(["at", "jobId"].filter((k) => typeof t.disarmed[k] === "string").map((k) => [k, t.disarmed[k]]));
  if (Array.isArray(t.waitFor)) out.waitFor = t.waitFor.slice(0, 64).flatMap((w) => typeof w?.profile === "string" ? [{ profile: w.profile }] : typeof w?.after === "string" ? [{ after: w.after }] : []);
  return out;
}

export { recordMatchesTrigger };

function chipsOf(t, packagesAvailable) {
  const chips = [];
  const add = (kind, text) => chips.push({ kind, text });
  if (t.replicas > 1) add("costs-more", `${t.replicas} independent sandboxes`);
  if (t.backend) add("reaches", `venue ${t.backend}`);
  if (t.image) add("reaches", "custom job image");
  if (packagesAvailable && t.packages !== false) add("reaches", "staged packages");
  if (t.skillsDir) add("reaches", "injected skills");
  if (t.mcp?.length) add("reaches", `MCP: ${t.mcp.join(", ")}`);
  // Issue #918: the devices its jobs may reach, by id, which no other trigger's jobs reach.
  if (t.privateEndpoints?.length) add("reaches", `private: ${t.privateEndpoints.join(", ")}`);
  if (t.secrets > 0) add("reaches", `${t.secrets} secret variables${t.secretsProfile ? ` via ${t.secretsProfile}` : ""}`);
  if (t.github === true) add("reaches", "GitHub access");
  if (t.resume === true) add("writes", "keeps a session");
  if (t.type === "cron" || t.runKind === "local") add("writes", "edits its local folder");
  if (t.runKind === "local") add("narrows", `${t.debounceSeconds ?? 10}s debounce, one pending follow-up`);
  if (t.portfolio === true) add("writes", "budget split");
  if (t.instructions) add("writes", "standing instructions");
  if (t.mayMerge === true) add("writes", "may merge");
  if (t.awaitInput === true || t.gates?.length) add("asks", "may wait for a person");
  if (t.steer === true) add("asks", "takes messages");
  if (t.recover === true) add("writes", "recovers a lost run");
  if (t.models?.length || t.maxCostUsd !== undefined || t.maxSubscriptionUsd !== undefined || t.waitFor?.length || t.reviewState?.length || t.all?.length || t.none?.length || t.number) add("narrows", "reviewed constraints");
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

/**
 * A rule's counts and spend from the records read. `short` (issue #988) says how they can be short: `unread`, a side of
 * the run history was not read, so a zero is not known; `incomplete`, that or a history cut at a bound, so a count is a
 * floor. A zero from a history that was read is 0.
 */
function statsOf(records, weekStart, now, { unread, incomplete }, subscriptions, pricing) {
  if (records === null) return { runs30d: null, weekRuns: null, weekCostMicros: null, weekCost: null, incomplete: true, unread: true, costIncomplete: true };
  const week = records.filter((r) => atOf(r) >= weekStart && atOf(r) <= now);
  const costs = week.map((r) => refusedBeforeSpend(r) ? 0 : meteredRunMicros(r, { subscriptions, pricing }));
  const joined = { byJobId: Object.fromEntries(week.map((r) => [r.jobId, { key: "trigger:sum" }])) };
  const cost = foldTriggerCosts({ records: week, subscriptions, pricing, triggerJoin: joined })["trigger:sum"]?.cost ?? { usd: 0, class: "metered", floor: false };
  return { runs30d: records.length, weekRuns: week.length, weekCostMicros: costs.reduce((sum, n) => sum + (n ?? 0), 0), weekCost: cost, incomplete, unread, costIncomplete: costs.some((n) => n === null) };
}

/** Said once on the page where the fleet's Valkey was not read: the rules below are the files', the schedule facts unknown. */
export const SCHEDULERS_UNREAD_TEXT = "Valkey could not be read: next fires, owning hosts and stall counts are not known. The rules shown are the triggers file's.";
/** A triggers file that does not exist: read, and holding no rule. */
export const TRIGGERS_FILE_ABSENT_TEXT = "The triggers file does not exist, so there are no rules.";
/** The same where the file views are missing too (issue #962): there is no rule to call the file's. */
/**
 * The one sentence over a schedule list READ IN PART (issue #986, the snapshot's `schedulersReadInPart`): a host
 * queue's schedules were not read, or a host's own queue was not asked, so the list holds the schedules that were
 * read and one missing from it may be registered all the same. Said by every page that draws that list.
 */
export const SCHEDULES_PART_TEXT = "Not every queue's schedules could be read, so more may be registered.";
/** A cron rule's chip where its schedule is not in such a list: its next fire is not known, never "unavailable". */
export const SCHEDULE_PART_UNKNOWN_TEXT = "Next fire not known: not every queue's schedules could be read";

export const SCHEDULERS_UNREAD_NO_RULES_TEXT = "Valkey could not be read: next fires, owning hosts and stall counts are not known.";

/**
 * Explicit schema shared with the page: rows/groups, unfiltered counts, next fire, typed weekly spend, rolling
 * seven-day lanes and quiet intervals. Records are a bounded retained view; only `coverage.whole: true` says the list
 * was read whole for its window, and a count is bare only then (issue #988). `coverage.partial` (true, or the words
 * for which side) says a side of it was not read, and `coverage.cut` the words for a list that is not whole. A
 * missing read is null, never a fabricated empty history.
 *
 * `snapshot.schedulersUnread` (issue #844) marks a snapshot made of the files alone, the fleet's Valkey unread: the
 * rules, quiet windows and staged packages are the files', and what only Valkey says of a schedule (its next fire,
 * owning hosts, zone and stall count) is `unread`, never "not published". The result carries `schedulersUnread`.
 */
export function triggerListOf({ snapshot = null, records = null, coverage = {}, now, subscriptions = [], pricing = PRICING, scheduleZones = {} } = {}) {
  if (!Number.isSafeInteger(now)) throw new TypeError("triggerListOf requires the caller's clock");
  const dayStart = Math.floor(now / DAY) * DAY;
  const weekStart = dayStart - ((new Date(dayStart).getUTCDay() + 6) % 7) * DAY;
  const end = dayStart + 7 * DAY;
  const view = snapshot?.triggers;
  const problems = ["History uses saved row, type and forge, or a cron id. Editing or renumbering rules can associate runs from an older configuration; these are not stable rule identities."];
  const schedulersUnread = snapshot?.schedulersUnread === true;
  // Issue #962: a triggers file that does not exist holds no rule. That is a read's answer, counted as 0 and said in
  // its own sentence. Of a file that is there, one word per case (issue #988, `fileUnreadWord`): it "could not be
  // read" where nobody could read it or the page holds no view of it, and it "does not load" where it was read and is
  // refused. One sentence, "is not available", said both.
  const fileRules = Array.isArray(view?.triggers) ? view.triggers : view?.missing === true ? [] : null;
  if (fileRules === null) problems.push(`The triggers file ${fileUnreadWord("triggers", view) ?? "could not be read"}; rule facts are unknown.`);
  else if (view?.missing === true) problems.push(TRIGGERS_FILE_ABSENT_TEXT);
  if (schedulersUnread) problems.push(Array.isArray(view?.triggers) ? SCHEDULERS_UNREAD_TEXT : SCHEDULERS_UNREAD_NO_RULES_TEXT);
  // A schedule list read in part (issue #986): a cron rule whose schedule is not in it has a next fire that is NOT
  // KNOWN (`nextFire.part`), where its row said "Scheduler next fire unavailable" and the page "No next fire is
  // published", of a schedule that may be registered on a queue nobody read.
  const schedulesPart = !schedulersUnread && snapshot?.schedulersReadInPart === true;
  if (schedulesPart) problems.push(SCHEDULES_PART_TEXT);
  const raw = (fileRules ?? []).filter((t) => TYPES.has(t?.type) && Number.isSafeInteger(t?.index) && t.index >= 0);
  const rules = raw.map(ruleOf);
  if (Number.isSafeInteger(view?.count) && view.count > (view?.triggers?.length ?? 0)) problems.push("Some file rows cannot be displayed; rule counts are incomplete.");
  // A newer release's record is not counted (issue #761): which trigger it ran and what it cost are past its stable core.
  const read = Array.isArray(records) ? readableRecords(records) : null;
  const source = read ? read.records : null;
  if (read?.newerSkipped > 0) problems.push(`${newerSkippedSentence(read.newerSkipped)}: counts and spend leave them out.`);
  const valid = source?.filter((r) => Number.isFinite(atOf(r)) && atOf(r) >= now - 30 * DAY && atOf(r) <= now).sort((a, b) => atOf(b) - atOf(a));
  const unique = new Map();
  for (const r of valid ?? []) if (typeof r.jobId === "string" && r.jobId !== "" && !unique.has(r.jobId)) unique.set(r.jobId, r);
  const dedup = valid === undefined ? null : [...unique.values()];
  const kept = dedup?.slice(0, TRIGGER_LIST_LIMITS.records) ?? null;
  // Two ways the counts can be short, told apart (issue #988). UNREAD: a side of the run history was not read, which
  // is no records at all, a side the caller says did not answer (`coverage.partial`), a snapshot of the files alone,
  // or a fleet mirror that did not answer; a rule's zero is then not known. CUT: nothing says the list was read
  // whole; a count is then a floor, and a zero is still zero. WHOLE is the caller's word (`coverage.whole`), from a
  // reader that knows its own bound, and a count is itself only over a list that has it. It is never inferred from no
  // mark being set: a caller whose list was the newest 50 runs of a fleet holding 70 set none, and the page said 41
  // runs of 65. More than the record limit is cut whatever the caller says. `coverage.complete` promised a whole
  // fleet's history from a local directory that could be read, and made every zero "unknown": it is not asked.
  const overLimit = (dedup?.length ?? 0) > TRIGGER_LIST_LIMITS.records;
  const unread = source === null || Boolean(coverage.partial) || snapshot?.schedulersUnread === true || mirrorUnread(snapshot?.runMirror);
  const cutShort = coverage.whole !== true || overLimit;
  const incomplete = unread || cutShort;
  const short = { unread, incomplete };
  // The one clause that says why a count is a floor, by its cause: which side was not read, or that the list was cut.
  const shortWhy = !incomplete || kept === null ? null
    : typeof coverage.partial === "string" ? coverage.partial
    : coverage.partial === true ? "a part of the run history could not be read"
    : snapshot?.schedulersUnread === true ? "Valkey could not be read, so the fleet's run records were not"
    : mirrorUnread(snapshot?.runMirror) ? "the fleet's run records could not be read"
    : overLimit ? `the run history holds more than the ${TRIGGER_LIST_LIMITS.records.toLocaleString("en-US")} runs counted here`
    : typeof coverage.cut === "string" ? coverage.cut
    : "the run history was not read whole";
  if (kept === null) problems.push("Run history could not be read; counts and spend are unknown.");
  else if (incomplete) problems.push(`Counts and spend are lower bounds: ${shortWhy}.`);
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
    return { trigger, index: trigger.index, group: trigger.type === "cron" ? "schedule" : trigger.forge ?? "unknown", stats: statsOf(own, weekStart, now, short, subscriptions, pricing), lastRun: own?.[0] ? recordOf(own[0]) : null,
      nextFire: trigger.type === "cron" && schedulersUnread ? { at: null, health: "unknown", stalls: null, stallLimit, hosts: [], zone: null, problem: null, unread: true } : trigger.type === "cron" ? { at, health: stalls !== null && stalls >= stallLimit ? "stalled" : at === null ? "unknown" : at < now ? "overdue" : "on-time", stalls, stallLimit, hosts: scheduleConflict || schedulers.length === 0 ? [] : hosts, zone: scheduleConflict || schedulers.length === 0 ? null : zone, problem: schedulerProblem, ...(schedulesPart && schedulers.length === 0 ? { part: true } : {}) } : null,
      chips: chipsOf(trigger, (snapshot?.stagedPackages?.packages?.length ?? 0) > 0), unknown: [...(trigger.displayCut ? ["Some selector or option names are omitted from this bounded display."] : []), ...(own === null ? ["History unavailable"] : []), ...(trigger.type === "cron" && at === null && !schedulersUnread ? [schedulerProblem ?? (schedulesPart && schedulers.length === 0 ? SCHEDULE_PART_UNKNOWN_TEXT : "Scheduler next fire unavailable")] : [])] };
  });
  const counts = { all: rows.length, schedule: rows.filter((r) => r.trigger.type === "cron").length, label: 0, comment: 0, pull_request: 0, issue: 0, watch: (fileRules ?? []).filter((t) => t.type === "watch").length, spent: rows.filter((r) => r.trigger.disarmed).length };
  for (const type of ["label", "comment", "pull_request", "issue"]) counts[type] = rows.filter((r) => r.trigger.type === type).length;
  if (fileRules === null) for (const key of Object.keys(counts)) counts[key] = null;
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
    // An unread zone is not an unpublished one: the lane says why it projects nothing.
    return { index: r.index, id: r.trigger.id, zone: r.nextFire.zone, occurrences: [...shownObserved, ...shownProjected], incomplete: projected.incomplete || incomplete || cut, problem: (r.nextFire.unread && r.nextFire.zone === null ? "The owning host's timezone could not be read; further schedule times are unknown." : r.nextFire.part && r.nextFire.zone === null ? "The owning host's timezone is not known, since not every queue's schedules could be read; further schedule times are unknown." : projected.problem) ?? (cut ? "Only a bounded selection of recorded runs and projected ticks is shown." : null) };
  });
  // A pause-windows file that does not exist holds no window (issue #962): that is a read's answer, and "could not be
  // read" is said only of a file that was not read, cannot be read or does not load.
  const windows = Array.isArray(snapshot?.pauseWindows?.windows) ? snapshot.pauseWindows.windows : snapshot?.pauseWindows?.missing === true ? [] : null;
  const formatters = new Map();
  const quiet = (windows ?? []).slice(0, TRIGGER_LIST_LIMITS.quietWindows).map((window) => ({ scope: window.scope, affects: window.scope === "*" ? "all" : window.scope.startsWith("/") || /^[A-Za-z]:[\\/]/.test(window.scope) ? "local" : "forge", ...quietIntervals(window, { start: dayStart, end, formatters }) }));
  if (windows === null) problems.push("Quiet windows could not be read; bands are unknown.");
  if ((windows?.length ?? 0) > TRIGGER_LIST_LIMITS.quietWindows) problems.push("Only the first quiet windows are projected.");
  if (scheduled.length > TRIGGER_LIST_LIMITS.lanes) problems.push("Only the first schedule lanes are projected.");
  const attributed = fileRules !== null ? kept?.filter((r) => rules.some((t) => recordMatchesTrigger(r, t))) ?? null : null;
  return { now, rows, groups, counts, next, weekStart, stats: statsOf(attributed, weekStart, now, short, subscriptions, pricing), week: { start: dayStart, end, zone: "UTC", label: "Next 7 days, UTC", lanes, quiet, quietUnknown: windows === null, quietCut: Math.max(0, (windows?.length ?? 0) - TRIGGER_LIST_LIMITS.quietWindows), lanesCut: Math.max(0, scheduled.length - TRIGGER_LIST_LIMITS.lanes) }, coverage: { complete: !incomplete, records: kept?.length ?? null }, problems, schedulersUnread, ...(schedulesPart ? { schedulesReadInPart: true } : {}) };
}
