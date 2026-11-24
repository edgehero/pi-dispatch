import { readSubscriptionAuthView, subscriptionAuthForAgent } from "./subscription-auth-view.mjs";
/** Models is a read-only observation of reviewed policy and bounded retained evidence, never an admission decision. */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, allowedModelsFrom } from "@edgehero/pi-dispatch/config";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { parseProjects } from "@edgehero/pi-dispatch/projects";
import { parseScopedLimits } from "@edgehero/pi-dispatch/scoped-limits";
import { splitModelEntry, modelIdProblem, providerIdProblem, modelSelectionProblem } from "@edgehero/pi-dispatch/model-ref";
import { SKILL_NAME_RE } from "@edgehero/pi-dispatch/flow-gate";
import { MODEL_ROLE_RE } from "@edgehero/pi-dispatch/model-roles";
import { failoverModelStatus } from "@edgehero/pi-dispatch/model-status";
import { readOverlayModels } from "@edgehero/pi-dispatch/model-endpoints";
import { resolveConfiguredModelRuns, cooldownModelRefs, RADIUS_COST_CAP_LABEL, RADIUS_COST_CAP_FIX } from "@edgehero/pi-dispatch/model-observation";
import { readModelCooldowns } from "@edgehero/pi-dispatch/model-cooldowns";
import { modelProposalOf } from "@edgehero/pi-dispatch/model-proposal-protocol";
import { MODEL_WHY, providerFailureOf } from "@edgehero/pi-dispatch/model-failover-protocol";
import { effectiveCostCapMicros, formatMicros } from "@edgehero/pi-dispatch/money";
import { makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { readSettingsView } from "./read-model.mjs";
import { dollarWindowSpecs } from "./dollar-windows.mjs";
import { doctorStale } from "./doctor-view.mjs";
import { meteredRunMicros } from "./costs.mjs";
import { newerSkippedSentence, readableRecords } from "./newer-release.mjs";
import { FILE_WORDS, fileCaseOfError, fileCaseOfView } from "./file-case.mjs";
import { mirrorStateOf } from "./mirror-words.mjs";

/** The waits the Models page lists beside cooldowns, issue #1008's quota reserve among them. */
const MODEL_WAIT_REASONS = Object.freeze(["model-cooldown", "model-window", "subscription-quota", "subscription-reserve"]);
export const MODELS_LIMITS = Object.freeze({ fileBytes: 1024 * 1024, records: 1000, days: 30, hosts: 64, proposals: 256, waits: 200, canarySources: 64, timeoutMs: 2500 });
const DAY = 86400_000;
const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const runId = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : null;
const safeId = value => typeof value === "string" && /^[A-Za-z0-9._:@/-]{1,200}$/.test(value) ? value : null;
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const atOf = record => Date.parse(record?.endedAt ?? record?.startedAt ?? "");
const roleValid = role => typeof role === "string" && MODEL_ROLE_RE.test(role) && !["inherit", "constructor", "prototype"].includes(role);
const fields = (source, keys) => Object.fromEntries(keys.filter(key => source?.[key] !== undefined).map(key => [key, source[key]]));

/** The same authored inputs as doctor's model runs: prompt text and secret references never leave this projection. */
export function collectModelPolicies({ entries = [], modelRoles = {}, projects = [], deployment = {}, envList = null, resolveFolder } = {}) {
  const runs = entries.flatMap((entry, index) => {
    const run = entry?.run;
    if (!run || typeof run !== "object") return [];
    return [{ sourceIndex: index, index, label: `trigger ${index + 1}`, authoredProvider: run.provider,
      ...fields(run, ["kind", "folder", "repository", "provider", "model", "models", "fallbackModels", "auxiliaryModels", "modelSelection", "maxCostUsd", "flow"]),
    }];
  });
  const out = resolveConfiguredModelRuns({ runs, modelRoles, projects, deployment, envList, conservativeLocal: true, ...(resolveFolder ? { resolveFolder } : {}) });
  return { ...out, runs: out.runs.map(run => ({ ...run, ...(run.modelSelection ? {} : { provider: run.provider ?? deployment.provider, model: run.model ?? deployment.model }), project: run.project ?? null })) };
}

function metricRows(records) {
  const costs = records.map(record => finite(record?.cost)).filter(value => value !== null);
  const turns = records.map(record => integer(record?.turns)).filter(value => value !== null);
  const tokens = records.map(record => integer(record?.tokens)).filter(value => value !== null);
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return { runs: records.length, completed: records.filter(record => record?.outcome === "completed").length,
    costPerRun: mean(costs), averageTurns: mean(turns), averageTokens: mean(tokens), knownCosts: costs.length, knownTurns: turns.length, knownTokens: tokens.length };
}
function comparisonRecord(record) {
  if (!record) return null;
  const ref = typeof record.provider === "string" && typeof record.model === "string" ? `${record.provider}/${record.model}` : null;
  // A recorded numeric lower bound is not an exact comparison price. Share every floor and meter rule with Spend.
  const costMicros = finite(record.tokens?.cost) === null ? null : meteredRunMicros(record);
  return { model: splitModelEntry(ref) ? ref : null, outcome: ["completed", "policy", "failed", "error"].includes(record.outcome) ? record.outcome : "unknown",
    cost: costMicros === null ? null : costMicros / 1_000_000, turns: integer(record.turns), tokens: integer(record.tokens?.total) };
}

/** Missing meters keep their own denominators. A completed replay describes execution, never quality. */
export function canaryComparisonLines(sample) {
  const line = (name, metrics) => `${name}: ${metrics?.completed ?? 0}/${metrics?.runs ?? 0} completed; cost per metered run ${finite(metrics?.costPerRun) === null ? "unknown" : `$${metrics.costPerRun.toFixed(6)}`} (${metrics?.knownCosts ?? 0} metered); average turns ${finite(metrics?.averageTurns) === null ? "unknown" : metrics.averageTurns.toFixed(1)} (${metrics?.knownTurns ?? 0} known); average tokens ${finite(metrics?.averageTokens) === null ? "unknown" : Math.round(metrics.averageTokens)} (${metrics?.knownTokens ?? 0} known).`;
  return [line("Candidate", sample?.candidateStats ?? sample?.candidate), line("Sources", sample?.sourceStats), "These are retained comparisons grouped by role, candidate and flow, not a reconstructed experiment or a quality score."];
}

function canariesOf(records, roles, deployment, now, sourceRecords = []) {
  // A newer release's source record is no comparison (issue #761): its cost and turns are past the stable core.
  sourceRecords = readableRecords(sourceRecords).records;
  const index = new Map([...records, ...sourceRecords].map(record => [record.jobId, record]));
  const groups = new Map();
  for (const record of records) {
    const canary = record.canary;
    if (!canary || !runId(record.jobId) || !runId(canary.sourceJobId) || !roleValid(canary.role) || !splitModelEntry(canary.candidate) || typeof record.flow !== "string" || !SKILL_NAME_RE.test(record.flow) || atOf(record) < now - MODELS_LIMITS.days * DAY || atOf(record) > now) continue;
    const tuple = [canary.role, canary.candidate, record.flow];
    const key = JSON.stringify(tuple);
    if (!groups.has(key)) groups.set(key, { id: sha(tuple).slice(0, 16), role: canary.role, candidate: canary.candidate, flow: record.flow, rows: [] });
    const original = index.get(canary.sourceJobId);
    const source = original && !original.canary && original.flow === record.flow && original.modelRole === canary.role && atOf(original) <= atOf(record) ? comparisonRecord(original) : null;
    groups.get(key).rows.push({ jobId: record.jobId, sourceJobId: canary.sourceJobId, candidate: comparisonRecord(record), source });
  }
  return [...groups.values()].map(group => {
    group.rows.sort((a, b) => a.jobId.localeCompare(b.jobId));
    const candidateStats = metricRows(group.rows.map(row => row.candidate));
    const sources = group.rows.flatMap(row => row.source ? [row.source] : []);
    const sourceStats = metricRows(sources);
    const partial = sources.length !== group.rows.length || [candidateStats, sourceStats].some(metrics => [metrics.knownCosts, metrics.knownTurns, metrics.knownTokens].some(count => count < metrics.runs));
    let suggestedCapUsd = null;
    try { const cap = effectiveCostCapMicros(undefined, deployment.maxCostUsd); if (Number.isSafeInteger(cap) && cap > 0 && Number.isSafeInteger(cap * Math.min(10, group.rows.length))) suggestedCapUsd = formatMicros(cap * Math.min(10, group.rows.length)); } catch { /* A copyable command needs the operator to choose a valid cap. */ }
    const sample = { ...group, count: group.rows.length, candidateStats, sourceStats, partial,
      scopes: roles.filter(row => row.role === group.role).map(row => row.scope), suggestedCapUsd,
      whatIf: `/insights?whatif=${encodeURIComponent(group.candidate)}&flow=${encodeURIComponent(group.flow)}` };
    return { ...sample, digest: sha({ role: sample.role, candidate: sample.candidate, flow: sample.flow, rows: sample.rows, candidateStats, sourceStats, partial }) };
  });
}

function modelWindows(ref, windows) {
  return windows.filter(window => window.ledger === "model" && typeof window.name === "string" && window.name.toLowerCase() === ref.toLowerCase()).map(window => ({ scope: `model:${window.name}`, window: window.window, capMicros: integer(window.capMicros), spentMicros: integer(window.counterMicros ?? window.spentMicros), unavailable: integer(window.counterMicros ?? window.spentMicros) === null }));
}
function nextOf(model, fallbacks, cooldowns, status, cooldownsUnknown, policyUnknown = false) {
  if (policyUnknown) return { kind: "unknown", model: null, reason: "model-policy-unavailable" };
  if (fallbacks.length === 0) return { kind: "direct", model, reason: null };
  if (cooldownsUnknown) return { kind: "unknown", model: null, reason: "cooldowns-unavailable" };
  const candidates = [model, ...fallbacks].filter(ref => status(ref).priced);
  const next = candidates.find(ref => !cooldowns.some(row => row.ref === ref));
  return next ? { kind: "candidate", model: next, reason: "pickup-checks-remain" } : { kind: candidates.length ? "waiting" : "unknown", model: null, reason: candidates.length ? "model-cooldown" : "model-failover-no-candidate" };
}

/** A pickup refusal does not erase the physical models named by the reviewed trigger. */
function authoredRefs(entry, deployment, envList) {
  const run = entry?.run;
  if (!run || typeof run !== "object") return [];
  const chosen = run.model ?? deployment.model;
  const primary = !run.modelSelection && typeof chosen === "string" && !chosen.startsWith("role:") ? `${run.provider ?? deployment.provider}/${chosen}` : null;
  const allowed = run.models ?? envList;
  return [primary, ...(run.modelSelection?.candidates ?? []), ...(Array.isArray(allowed) ? allowed : []), ...(Array.isArray(run.fallbackModels) ? run.fallbackModels : [])].filter(ref => splitModelEntry(ref));
}

/** Caller-supplied clock and I/O facts. No policy oracle here can authorize a run. */
export function modelsViewOf({ entries = [], modelRoles = {}, projects = [], deployment = {}, envList = null, overlay = null, overlayUnknown = false, configUnknown = false, configProblem = null, cooldowns = [], records = [], sourceRecords = [], snapshot, windows = [], coverage = {}, now, status: statusFn = failoverModelStatus, resolveFolder } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("modelsViewOf requires the caller's clock");
  const statuses = new Map();
  const status = ref => {
    if (!statuses.has(ref)) statuses.set(ref, overlayUnknown ? { known: null, priced: null, reason: "catalog-unavailable", api: null } : statusFn(ref, { models: overlay }));
    return statuses.get(ref);
  };
  const facts = collectModelPolicies({ entries, modelRoles, projects, deployment, envList, conservativeLocal: true, ...(resolveFolder ? { resolveFolder } : {}) });
  const banners = facts.checks.map(check => ({ kind: "role-conflict", reason: check.reason, index: check.sourceIndex, project: check.project, ...(check.projectUnknown === true ? { projectUnknown: true } : {}), label: check.label, fix: check.fix }));
  if (configUnknown) banners.unshift({ kind: "configuration-unavailable", reason: "model-roles-invalid", label: configProblem ? `The ${configProblem.file} ${configProblem.word}, so the model policy is not known. Roles and routing are unknown.` : "The model policy could not be read and validated. Roles and routing are unknown.", fix: "Check the triggers, projects and settings files before editing a role." });
  if (overlayUnknown) banners.push({ kind: "catalog-unavailable", reason: "model-unknown", label: "The model catalog overlay could not be read. Price status is unknown.", fix: "Check models.json in the global pi overlay; no default routing is assumed." });
  const observedCooldowns = Array.isArray(cooldowns) ? cooldowns.filter(row => splitModelEntry(row?.ref) && ["rate-limited", "quota-exhausted", "overloaded"].includes(row.kind) && integer(row.until) !== null && row.until > now && row.until <= 253402300799999).map(row => ({ ref: row.ref, kind: row.kind, until: row.until })) : [];
  if (cooldowns === null) banners.push({ kind: "cooldowns-unavailable", reason: "model-cooldown", label: "Model cooldowns could not be read. Current failover routing is unknown.", fix: "Check Valkey and reload; no model was selected." });
  const scopes = Object.keys(modelRoles).sort((a, b) => a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b));
  const roles = scopes.flatMap(scope => Object.entries(modelRoles[scope]).map(([role, entry]) => {
    const model = typeof entry === "string" ? entry : entry.model;
    const refs = typeof entry === "string" ? [] : entry.fallbackModels ?? [];
    const triggers = facts.runs.filter(run => run.modelRole === role && run.roleScope === scope).map(run => ({ index: run.sourceIndex, number: run.sourceIndex + 1, flow: typeof run.flow === "string" ? run.flow : null, project: run.project, projectUnknown: run.projectUnknown === true, scope,
      fallbackModels: [...(run.fallbackModels ?? [])], model: `${run.provider}/${run.model}` }));
    const fallbackGroups = [...new Set(triggers.map(trigger => JSON.stringify(trigger.fallbackModels)))].map(key => {
      const group = triggers.filter(trigger => JSON.stringify(trigger.fallbackModels) === key);
      return { triggers: group, fallbackModels: JSON.parse(key), next: nextOf(model, JSON.parse(key), observedCooldowns, status, cooldowns === null, overlayUnknown || configUnknown) };
    });
    return { scope, role, model, fallbackGroups, fallbackModels: refs.map(ref => ({ ref, known: status(ref).known, priced: status(ref).priced, skipped: status(ref).priced === false })),
      triggers, next: nextOf(model, refs, observedCooldowns, status, cooldowns === null, overlayUnknown || configUnknown) };
  }));
  const resolvedRefs = new Set(roles.flatMap(row => [row.model, ...row.fallbackModels.map(item => item.ref)]));
  for (const run of facts.runs) for (const ref of [`${run.provider}/${run.model}`, ...(run.models ?? []), ...(run.fallbackModels ?? []), ...(run.modelSelection?.candidates ?? [])]) if (splitModelEntry(ref)) resolvedRefs.add(ref);
  const namedRefs = new Set(resolvedRefs);
  for (const entry of entries) for (const ref of authoredRefs(entry, deployment, envList)) namedRefs.add(ref);
  const refusedRows = new Set(facts.checks.map(check => check.sourceIndex));
  const refusedRefs = new Set(entries.flatMap((entry, index) => refusedRows.has(index) ? authoredRefs(entry, deployment, envList) : []));
  const radius = new Set();
  for (const run of facts.runs) {
    let cap = null; try { cap = effectiveCostCapMicros(run.maxCostUsd, deployment.maxCostUsd); } catch { /* Config warning already names invalid settings. */ }
    if (cap === null) continue;
    for (const ref of [`${run.provider}/${run.model}`, ...(run.models ?? [])]) if (status(ref).api === "pi-messages") radius.add(ref);
  }
  for (const entry of entries) {
    let cap = null; try { cap = effectiveCostCapMicros(entry?.run?.maxCostUsd, deployment.maxCostUsd); } catch {}
    if (cap !== null) for (const ref of authoredRefs(entry, deployment, envList)) if (status(ref).api === "pi-messages") radius.add(ref);
  }
  let roleCap = null; try { roleCap = effectiveCostCapMicros(undefined, deployment.maxCostUsd); } catch {}
  if (roleCap !== null) for (const role of roles) for (const ref of [role.model, ...role.fallbackModels.map(item => item.ref)]) if (status(ref).api === "pi-messages") radius.add(ref);
  if (radius.size) banners.unshift({ kind: "radius-cost-cap", reason: "cost-cap", label: `${RADIUS_COST_CAP_LABEL}: ${[...radius].join(", ")}`, fix: RADIUS_COST_CAP_FIX });
  const models = [...namedRefs].map(ref => {
    const parsed = splitModelEntry(ref), price = status(ref), modelWindowsRows = modelWindows(ref, windows);
    return { ref, provider: parsed.provider, model: parsed.model, known: price.known, priced: price.priced, reason: price.reason,
      windows: modelWindowsRows, state: configUnknown || overlayUnknown || cooldowns === null || modelWindowsRows.some(window => window.unavailable) ? "unknown" : refusedRefs.has(ref) && !resolvedRefs.has(ref) ? "policy-refused" : observedCooldowns.some(row => row.ref === ref) ? "cooling-down" : price.priced === null ? "unknown" : !price.known ? "unknown-model" : !price.priced ? "unpriced" : modelWindowsRows.some(window => window.spentMicros >= window.capMicros) ? "window-full" : "available" };
  });
  const randomPools = entries.flatMap((entry, index) => entry?.run?.modelSelection != null && modelSelectionProblem(entry.run.modelSelection) === null ? [{ index, number: index + 1,
    candidates: entry.run.modelSelection.candidates.filter(ref => splitModelEntry(ref)).slice(0, 16).map(ref => ({ ref, state: models.find(model => model.ref === ref)?.state ?? "unknown" })),
  }] : []);
  const hostRows = (snapshot?.doctor?.hosts ?? []).slice(0, MODELS_LIMITS.hosts);
  const proposals = hostRows.flatMap(host => (host.checks ?? []).flatMap(check => {
    const proposal = modelProposalOf(check.proposal);
    if (!proposal) return [];
    return [{ ...proposal, id: check.id, host: host.name, at: integer(host.at), ageMs: integer(host.ageMs), stale: doctorStale(host), level: check.level,
      label: typeof check.label === "string" ? check.label : "Proposal details were omitted by the host's publication limit.", fix: typeof check.fix === "string" ? check.fix : null }];
  })).slice(0, MODELS_LIMITS.proposals);
  // A newer release's record is not read (issue #761): its model, fallback and canary fields are past the stable core.
  const { records: historyRecords, newerSkipped } = readableRecords(Array.isArray(records) ? records : []);
  const ordered = historyRecords.filter(record => runId(record?.jobId) && Number.isFinite(atOf(record)) && atOf(record) <= now).sort((a, b) => atOf(b) - atOf(a));
  const dedup = new Map(); for (const record of ordered) if (!dedup.has(record.jobId)) dedup.set(record.jobId, record);
  const retained = [...dedup.values()].slice(0, MODELS_LIMITS.records);
  const recentFallbacks = retained.filter(record => MODEL_WHY.includes(record.modelWhy) && record.modelWhy.startsWith("fallback-") && atOf(record) >= now - MODELS_LIMITS.days * DAY).map(record => ({ jobId: record.jobId, ...fields(record, ["provider", "model", "modelRole", "modelWhy"]), providerFailure: providerFailureOf(record.providerFailure) })).slice(0, 20);
  const recentRandom = retained.filter(record => ["random", "random-subscription-limit"].includes(record.modelWhy) && atOf(record) >= now - MODELS_LIMITS.days * DAY).map(record => ({ jobId: record.jobId, ...fields(record, ["provider", "model", "modelWhy"]) })).slice(0, 20);
  const waiting = (snapshot?.waiting?.rows ?? []).filter(row => MODEL_WAIT_REASONS.includes(row.why ?? row.reason)).slice(0, MODELS_LIMITS.waits).map(row => ({ jobId: safeId(row.jobId), queue: safeId(row.queue), reason: row.why ?? row.reason, resetAt: integer(row.resetAt) })).filter(row => row.jobId);
  const notes = ["Comparisons and fallback history use at most 1,000 retained local and mirrored run records over 30 days. Missing remote or expired records are unknown.", "A candidate shown next has not reserved a dollar window or endpoint. Credentials, egress, windows and slots are checked again at pickup.", "Repository agents' role declarations are not readable from this page."];
  if (facts.runs.some(run => run.projectUnknown) || facts.checks.some(check => check.projectUnknown)) notes.push("A local folder could not be resolved on this console host. The possible project scopes are shown; the owning worker resolves its actual folder at pickup.");
  if (records === null) notes.push("Run records could not be read; comparison and fallback history are unknown.");
  if (newerSkipped > 0) notes.push(`${newerSkippedSentence(newerSkipped)}: comparisons and fallback history leave them out.`);
  if (!snapshot?.waiting || snapshot.waiting.unreachable) notes.push("Waiting jobs could not be read; an empty list is not proof that none wait.");
  if (!snapshot?.doctor || snapshot.doctor.unreachable || !hostRows.length) notes.push("No published doctor proposal evidence is available. Reload after doctor publishes on a host.");
  // Issue #962: which of the three lists a failed read left empty, so the page never draws "none" for it. Set only for a
  // snapshot the caller says could not be read (null) or whose own read of that list failed; a caller that gives no
  // snapshot at all (undefined: a comparison over records alone) asked for neither list.
  const waitingUnread = snapshot !== undefined && (snapshot === null || !snapshot.waiting || Boolean(snapshot.waiting.unreachable));
  const proposalsUnread = snapshot !== undefined && (snapshot === null || !snapshot.doctor || Boolean(snapshot.doctor.unreachable));
  return { now, scopes: [...new Set(["default", ...projects.map(project => project.id), ...scopes])], state: configUnknown ? "unreadable" : "ready", ...(configUnknown && configProblem ? { configProblem: { file: configProblem.file, word: configProblem.word } } : {}), partial: true, banners, roles, randomPools, recentRandom, cooldowns: observedCooldowns, cooldownsUnread: cooldowns === null, waitingUnread, proposalsUnread, models, proposals,
    canaries: canariesOf(retained, roles, deployment, now, sourceRecords), waiting, recentFallbacks,
    coverage: { complete: false, partial: true, records: retained.length, days: MODELS_LIMITS.days, truncated: dedup.size > MODELS_LIMITS.records || coverage.truncated === true, notes } };
}

/**
 * One word per case for a configuration file the policy could not take (issue #988): it "could not be read" where the
 * read failed (an errno, or the settings reader's own word for it), and it "does not load" where it was read and is
 * refused. A file that does not exist never comes here: it is an empty document.
 */
const fileProblemWord = (error) => FILE_WORDS[error?.settingsUnreadable === true ? "unreadable" : fileCaseOfError(error)];
const settingsRefusal = (invalid) => Object.assign(new Error("invalid settings"), { settingsUnreadable: fileCaseOfView({ invalid }) === "unreadable" });

function readText(path, fs, { missing = null } = {}) {
  if (!path) return missing;
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.size > MODELS_LIMITS.fileBytes) throw new Error("unsupported configuration file");
    return fs.readFileSync(path, "utf8");
  } catch (error) { if (error?.code === "ENOENT") return missing; throw error; }
}
function bounded(promise, ms = MODELS_LIMITS.timeoutMs) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("model observation timed out")), ms); })]).finally(() => clearTimeout(timer));
}
/** A read's bound under `within` (a page's deadline, issue #988), or its own where the caller has none. */
const boundOf = (within) => (typeof within === "function" ? within(MODELS_LIMITS.timeoutMs) : MODELS_LIMITS.timeoutMs);
/**
 * A history read through the fleet reader, bounded here as before and, where the caller has a deadline, handed that
 * same bound as the reader's own (`read` is called with `{ timeoutMs }`): the reader then ends first, with the answer
 * it gives itself for a mirror that did not answer (this host's records, the mirror said as not reached), where a
 * wait cut from outside would leave nothing. A caller with no deadline calls the reader as before (`read(null)`).
 */
function fleetRead(within, read) {
  if (typeof within !== "function") return bounded(read(null));
  const ms = boundOf(within);
  return bounded(read({ timeoutMs: ms }), ms);
}

/**
 * Fetch an explicit bounded history only for Models, then hydrate named originals through the authoritative by-id reader.
 * `within` is `readModelsView`'s: each read's bound, or what is left of a page's deadline when that is sooner, handed to
 * the fleet reader as well (`fleetRead`), so a page cut at its deadline still counts this host's own records.
 */
export async function readModelsHistory({ fleet, now, seed = null, within = null } = {}) {
  if (typeof fleet?.runsPage !== "function") return { records: Array.isArray(seed) ? seed : null, sourceRecords: [], partial: true, truncated: false, sourcesUnknown: true };
  const records = [], sourceRecords = [];
  let before = null, partial = false, truncated = false;
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    let page;
    try { page = await fleetRead(within, (bound) => fleet.runsPage({ before, limit: 100, ...bound })); } catch { partial = true; break; }
    if (!Array.isArray(page?.runs) || page.unreachable || page.refusal) { partial = true; break; }
    if (mirrorStateOf(page.mirror) !== "read" || page.truncated) partial = true;
    for (const record of page.runs.slice(0, MODELS_LIMITS.records - records.length)) if (runId(record?.jobId) && Number.isFinite(atOf(record)) && atOf(record) <= now && atOf(record) >= now - MODELS_LIMITS.days * DAY && records.length < MODELS_LIMITS.records) records.push(record);
    if (page.runs.length > 100 || records.length >= MODELS_LIMITS.records) { truncated = page.next !== null || page.runs.length > 100; break; }
    if (page.next === null || page.next === undefined || page.next <= now - MODELS_LIMITS.days * DAY) break;
    if (!Number.isSafeInteger(page.next) || page.next < 0 || before !== null && page.next >= before) { partial = true; break; }
    before = page.next;
    if (pageIndex === 9) truncated = true;
  }
  const present = new Set(records.map(record => record.jobId));
  const originals = [...new Set(records.flatMap(record => runId(record.canary?.sourceJobId) && !present.has(record.canary.sourceJobId) ? [record.canary.sourceJobId] : []))];
  let sourcesUnknown = originals.length > MODELS_LIMITS.canarySources;
  const wanted = originals.slice(0, MODELS_LIMITS.canarySources);
  if (wanted.length && typeof fleet.runById !== "function") sourcesUnknown = true;
  else for (let offset = 0; offset < wanted.length; offset += 4) {
    const batch = await Promise.allSettled(wanted.slice(offset, offset + 4).map(id => fleetRead(within, (bound) => (bound ? fleet.runById(id, bound) : fleet.runById(id)))));
    batch.forEach((result, index) => {
      const id = wanted[offset + index], record = result.status === "fulfilled" ? result.value?.record : null;
      if (record?.jobId === id) sourceRecords.push(record);
      else sourcesUnknown = true;
    });
  }
  return { records, sourceRecords, partial, truncated, sourcesUnknown };
}

/**
 * Dedicated page/tool reads. Reuses the caller's snapshot; no read is added to unrelated pages. `snapshot` is the
 * caller's: an object, null for one the caller tried and could not read (issue #962: it is NOT read again here, since a
 * second read of a Valkey that does not answer only stacks a second timeout on the page; the view then says the waiting
 * jobs and the doctor proposals are not known), or undefined for a caller that has none, which is read here.
 *
 * `within` (issue #988) is a page's deadline: `(ownMs) => ms`, a read's own bound or what is left of the deadline when
 * that is sooner. Every bounded read here takes its bound through it, so on a Valkey that does not answer the reads end
 * together at the deadline, each as the unread one it is, and the view is still drawn from the files. A caller with no
 * deadline (a tool) passes none, and each read keeps its own bound.
 */
export async function readModelsView({ paths = {}, env = {}, deploymentDir = null, now = Date.now(), snapshot, fleet = null, fs = nodeFs, redis = null, reads = {}, within = null } = {}) {
  now = typeof now === "function" ? now() : now;
  let configUnknown = false, overlayUnknown = false, entries = [], modelRoles = {}, projects = [], limits = [], overlay = null, envList = null;
  let settings = snapshot?.settings?.overlay ?? {};
  // Which file stopped the policy, for the page's word (issue #988): `at` names the one being taken when the read threw.
  let at = "triggers file", configProblem = null;
  try {
    const text = reads.triggers ? await reads.triggers() : readText(paths.triggersPath, fs, { missing: '{"triggers":[]}' });
    const parsed = parseTriggersDocument(text, paths.triggersPath);
    entries = JSON.parse(text).triggers;
    modelRoles = parsed.modelRoles ?? {};
    at = "projects file";
    const projectText = reads.projects ? await reads.projects() : readText(paths.projectsFile, fs);
    projects = projectText === null ? [] : parseProjects(projectText, paths.projectsFile);
    at = "scoped-limits file";
    const limitsText = reads.limits ? await reads.limits() : readText(paths.scopedLimitsPath, fs);
    limits = limitsText === null ? [] : parseScopedLimits(limitsText, paths.scopedLimitsPath);
    at = "settings overlay";
    if (snapshot?.settings?.invalid) throw settingsRefusal(snapshot.settings.invalid);
    if (!snapshot?.settings) { const view = readSettingsView({ settingsFile: paths.settingsFile, fs }); if (view.invalid) throw settingsRefusal(view.invalid); settings = view.overlay ?? {}; }
    at = null;
    envList = allowedModelsFrom(env);
  } catch (error) {
    configUnknown = true;
    if (at !== null) configProblem = { file: at, word: fileProblemWord(error) };
  }
  try { overlay = reads.overlay ? await reads.overlay() : readOverlayModels(paths.globalPiDir, { readFileSync: (path, encoding) => readText(path, fs), lstatSync: path => fs.lstatSync(path) }); }
  catch { overlayUnknown = true; }
  const deployment = { provider: settings.provider ?? env.PI_PROVIDER ?? DEFAULT_PROVIDER, model: settings.model ?? env.PI_MODEL ?? DEFAULT_MODEL, maxCostUsd: settings.maxCostUsd ?? env.PI_MAX_COST_USD ?? null };
  if (providerIdProblem(deployment.provider) !== null || modelIdProblem(deployment.model) !== null) configUnknown = true;
  if (snapshot === undefined && fleet) { try { snapshot = await fleet.snapshot({ waiting: true }); } catch { snapshot = null; } }
  const source = snapshot?.recordDetails instanceof Map ? [...snapshot.recordDetails.values()] : Array.isArray(snapshot?.runs) ? snapshot.runs : null;
  let records, sourceRecords = [], historyCoverage = { partial: true };
  try {
    if (reads.records) records = await reads.records();
    else { historyCoverage = await readModelsHistory({ fleet, now, seed: source, within }); records = historyCoverage.records; sourceRecords = historyCoverage.sourceRecords; }
  } catch { records = null; }
  const policies = collectModelPolicies({ entries, modelRoles, projects, deployment, envList });
  const configuredRefs = cooldownModelRefs(policies.runs, deployment);
  let client = redis, owned = false, cooldowns = configuredRefs.length ? null : [], counters = null;
  const specs = dollarWindowSpecs({ caps: {}, limits, now: new Date(now) }).filter(row => row.ledger === "model");
  try {
    if (!client && (configuredRefs.length || specs.length) && (!reads.cooldowns && configuredRefs.length || !reads.counters && specs.length)) { client = (reads.redis ?? makeRedisClient)(paths.valkeyUrl); client.on?.("error", () => {}); owned = true; }
    if (configuredRefs.length) cooldowns = await bounded(reads.cooldowns ? reads.cooldowns(configuredRefs, { now: () => now }) : readModelCooldowns(client, configuredRefs, { now: () => now }), boundOf(within));
    if (specs.length) {
      const values = await bounded(reads.counters ? reads.counters(specs.map(row => row.key)) : client.mget(...specs.map(row => row.key)), boundOf(within));
      if (!Array.isArray(values) || values.length !== specs.length) throw new Error("incomplete model counters");
      counters = new Map(specs.map((row, index) => [row.key, values?.[index] == null ? 0 : /^\d+$/.test(String(values[index])) && Number.isSafeInteger(Number(values[index])) ? Number(values[index]) : null]));
    }
  } catch { /* Unknown observations remain visible; a read never changes worker policy. */ }
  finally { if (owned) client?.disconnect?.(); }
  const windows = specs.map(spec => ({ ...spec, counterMicros: counters?.get(spec.key) ?? null }));
  const subscriptionAuth = await readSubscriptionAuthView({ snapshot, read: reads.subscriptionAuth, now });
  return { subscriptionAuth, ...modelsViewOf({ entries, modelRoles, projects, deployment, envList, overlay, overlayUnknown, configUnknown, configProblem, cooldowns, records, sourceRecords, snapshot, windows, coverage: historyCoverage, now, ...(reads.status ? { status: reads.status } : {}) }) };
}

/** Explicit machine projection: no doctor prose, command, path, prompt, URL, arbitrary field or secret reaches a model. */
export function modelsForAgent(view) {
  const model = value => splitModelEntry(value) ? value : null;
  const metrics = value => Object.fromEntries(["runs", "completed", "costPerRun", "averageTurns", "averageTokens", "knownCosts", "knownTurns", "knownTokens"].map(key => [key, finite(value?.[key])]));
  const next = value => ({ kind: ["direct", "candidate", "waiting", "unknown"].includes(value?.kind) ? value.kind : "unknown", model: model(value?.model), reason: ["pickup-checks-remain", "cooldowns-unavailable", "model-policy-unavailable", "model-cooldown", "model-failover-no-candidate"].includes(value?.reason) ? value.reason : null });
  const trigger = row => ({ index: integer(row?.index), number: integer(row?.number), project: safeId(row?.project), scope: safeId(row?.scope), flow: safeId(row?.flow), projectUnknown: row?.projectUnknown === true, model: model(row?.model), fallbackModels: (row?.fallbackModels ?? []).map(model).filter(Boolean) });
  const modelReason = reason => ["model-unknown", "model-not-allowed", "model-unpriced", "catalog-unavailable"].includes(reason) ? reason : null;
  const bannerReasons = { "role-conflict": ["model-role-unknown", "model-role-provider-conflict", "model-roles-invalid"], "radius-cost-cap": ["cost-cap"], "configuration-unavailable": ["model-roles-invalid"], "catalog-unavailable": ["model-unknown"], "cooldowns-unavailable": ["model-cooldown"] };

  return { subscriptionAuth: subscriptionAuthForAgent(view?.subscriptionAuth), scopes: (view?.scopes ?? []).filter(scope => safeId(scope)), state: view?.state === "ready" ? "ready" : "unreadable", partial: view?.partial !== false, now: integer(view?.now),
    randomPools: (view?.randomPools ?? []).slice(0, MODELS_LIMITS.waits).map(pool => ({ index: integer(pool.index), candidates: (pool.candidates ?? []).slice(0, 16).map(candidate => ({ ref: model(candidate.ref), state: ["cooling-down", "window-full", "unknown", "unknown-model", "unpriced", "policy-refused", "available"].includes(candidate.state) ? candidate.state : "unknown" })) })),
    recentRandom: (view?.recentRandom ?? []).slice(0, 20).map(row => ({ jobId: runId(row.jobId), provider: providerIdProblem(row.provider) === null ? row.provider : null, model: modelIdProblem(row.model) === null ? row.model : null, modelWhy: ["random", "random-subscription-limit"].includes(row.modelWhy) ? row.modelWhy : null })),
    roles: (view?.roles ?? []).map(row => ({ scope: safeId(row.scope), role: roleValid(row.role) ? row.role : null, model: model(row.model),
      fallbackModels: (row.fallbackModels ?? []).map(item => ({ ref: model(item.ref), priced: typeof item.priced === "boolean" ? item.priced : null, skipped: item.skipped === true })),
      triggers: (row.triggers ?? []).map(trigger),
      fallbackGroups: (row.fallbackGroups ?? []).map(group => ({ triggers: (group.triggers ?? []).map(trigger), fallbackModels: (group.fallbackModels ?? []).map(model).filter(Boolean), next: next(group.next) })),
      next: next(row.next) })),
    models: (view?.models ?? []).map(row => ({ ref: model(row.ref), provider: providerIdProblem(row.provider) === null ? row.provider : null, known: typeof row.known === "boolean" ? row.known : null, priced: typeof row.priced === "boolean" ? row.priced : null,
      reason: modelReason(row.reason),
      state: ["cooling-down", "window-full", "unknown", "unknown-model", "unpriced", "policy-refused", "available"].includes(row.state) ? row.state : "unknown",
      windows: (row.windows ?? []).map(window => ({ window: ["day", "week", "month"].includes(window.window) ? window.window : null, scope: splitModelEntry(window.scope?.slice(6)) ? window.scope : null, capMicros: integer(window.capMicros), spentMicros: integer(window.spentMicros), unavailable: window.unavailable === true })) })),
    cooldowns: (view?.cooldowns ?? []).map(row => ({ ref: model(row.ref), kind: ["rate-limited", "quota-exhausted", "overloaded"].includes(row.kind) ? row.kind : null, until: integer(row.until) })),
    proposals: (view?.proposals ?? []).flatMap(row => modelProposalOf(row) ? [{ ...modelProposalOf(row), id: safeId(row.id), host: safeId(row.host), at: integer(row.at), ageMs: integer(row.ageMs), stale: row.stale === true, level: ["ok", "warn", "fail"].includes(row.level) ? row.level : null }] : []),
    canaries: (view?.canaries ?? []).map(row => ({ id: safeId(row.id), digest: /^[a-f0-9]{64}$/.test(row.digest ?? "") ? row.digest : null, role: roleValid(row.role) ? row.role : null, candidate: model(row.candidate), flow: safeId(row.flow),
      candidateStats: metrics(row.candidateStats), sourceStats: metrics(row.sourceStats), partial: row.partial === true,
      rows: (row.rows ?? []).map(pair => ({ jobId: safeId(pair.jobId), sourceJobId: safeId(pair.sourceJobId), candidate: { model: model(pair.candidate?.model), outcome: safeId(pair.candidate?.outcome), cost: finite(pair.candidate?.cost), turns: integer(pair.candidate?.turns), tokens: integer(pair.candidate?.tokens) }, source: pair.source ? { model: model(pair.source.model), outcome: safeId(pair.source.outcome), cost: finite(pair.source.cost), turns: integer(pair.source.turns), tokens: integer(pair.source.tokens) } : null })) })),
    waiting: (view?.waiting ?? []).map(row => ({ jobId: safeId(row.jobId), reason: MODEL_WAIT_REASONS.includes(row.reason) ? row.reason : null, resetAt: integer(row.resetAt) })),
    recentFallbacks: (view?.recentFallbacks ?? []).map(row => ({ jobId: runId(row.jobId), provider: providerIdProblem(row.provider) === null ? row.provider : null, model: modelIdProblem(row.model) === null ? row.model : null, modelRole: roleValid(row.modelRole) ? row.modelRole : null, modelWhy: MODEL_WHY.includes(row.modelWhy) ? row.modelWhy : null, providerFailure: providerFailureOf(row.providerFailure) })),
    banners: (view?.banners ?? []).map(row => ({ kind: Object.hasOwn(bannerReasons, row.kind) ? row.kind : "unknown", reason: Object.hasOwn(bannerReasons, row.kind) && bannerReasons[row.kind].includes(row.reason) ? row.reason : null, index: integer(row.index), project: safeId(row.project), projectUnknown: row.projectUnknown === true })),
    coverage: { complete: false, partial: true, records: integer(view?.coverage?.records), days: MODELS_LIMITS.days, truncated: view?.coverage?.truncated === true } };
}
