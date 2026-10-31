/** Models is a read-only observation of reviewed policy and bounded retained evidence, never an admission decision. */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, allowedModelsFrom } from "@edgehero/pi-dispatch/config";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { parseProjects } from "@edgehero/pi-dispatch/projects";
import { parseScopedLimits } from "@edgehero/pi-dispatch/scoped-limits";
import { splitModelEntry, modelIdProblem, providerIdProblem } from "@edgehero/pi-dispatch/model-ref";
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
      ...fields(run, ["kind", "folder", "repository", "provider", "model", "models", "fallbackModels", "maxCostUsd", "flow"]),
    }];
  });
  const out = resolveConfiguredModelRuns({ runs, modelRoles, projects, deployment, envList, conservativeLocal: true, ...(resolveFolder ? { resolveFolder } : {}) });
  return { ...out, runs: out.runs.map(run => ({ ...run, provider: run.provider ?? deployment.provider, model: run.model ?? deployment.model, project: run.project ?? null })) };
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
  const primary = typeof chosen === "string" && !chosen.startsWith("role:") ? `${run.provider ?? deployment.provider}/${chosen}` : null;
  const allowed = run.models ?? envList;
  return [primary, ...(Array.isArray(allowed) ? allowed : []), ...(Array.isArray(run.fallbackModels) ? run.fallbackModels : [])].filter(ref => splitModelEntry(ref));
}

/** Caller-supplied clock and I/O facts. No policy oracle here can authorize a run. */
export function modelsViewOf({ entries = [], modelRoles = {}, projects = [], deployment = {}, envList = null, overlay = null, overlayUnknown = false, configUnknown = false, cooldowns = [], records = [], sourceRecords = [], snapshot = null, windows = [], coverage = {}, now, status: statusFn = failoverModelStatus, resolveFolder } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("modelsViewOf requires the caller's clock");
  const statuses = new Map();
  const status = ref => {
    if (!statuses.has(ref)) statuses.set(ref, overlayUnknown ? { known: null, priced: null, reason: "catalog-unavailable", api: null } : statusFn(ref, { models: overlay }));
    return statuses.get(ref);
  };
  const facts = collectModelPolicies({ entries, modelRoles, projects, deployment, envList, conservativeLocal: true, ...(resolveFolder ? { resolveFolder } : {}) });
  const banners = facts.checks.map(check => ({ kind: "role-conflict", reason: check.reason, index: check.sourceIndex, project: check.project, ...(check.projectUnknown === true ? { projectUnknown: true } : {}), label: check.label, fix: check.fix }));
  if (configUnknown) banners.unshift({ kind: "configuration-unavailable", reason: "model-roles-invalid", label: "The model policy could not be read and validated. Roles and routing are unknown.", fix: "Check the triggers, projects and settings files before editing a role." });
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
  for (const run of facts.runs) for (const ref of [`${run.provider}/${run.model}`, ...(run.models ?? []), ...(run.fallbackModels ?? [])]) if (splitModelEntry(ref)) resolvedRefs.add(ref);
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
  const hostRows = (snapshot?.doctor?.hosts ?? []).slice(0, MODELS_LIMITS.hosts);
  const proposals = hostRows.flatMap(host => (host.checks ?? []).flatMap(check => {
    const proposal = modelProposalOf(check.proposal);
    if (!proposal) return [];
    return [{ ...proposal, id: check.id, host: host.name, at: integer(host.at), ageMs: integer(host.ageMs), stale: doctorStale(host), level: check.level,
      label: typeof check.label === "string" ? check.label : "Proposal details were omitted by the host's publication limit.", fix: typeof check.fix === "string" ? check.fix : null }];
  })).slice(0, MODELS_LIMITS.proposals);
  const historyRecords = Array.isArray(records) ? records : [];
  const ordered = historyRecords.filter(record => runId(record?.jobId) && Number.isFinite(atOf(record)) && atOf(record) <= now).sort((a, b) => atOf(b) - atOf(a));
  const dedup = new Map(); for (const record of ordered) if (!dedup.has(record.jobId)) dedup.set(record.jobId, record);
  const retained = [...dedup.values()].slice(0, MODELS_LIMITS.records);
  const recentFallbacks = retained.filter(record => MODEL_WHY.includes(record.modelWhy) && record.modelWhy.startsWith("fallback-") && atOf(record) >= now - MODELS_LIMITS.days * DAY).map(record => ({ jobId: record.jobId, ...fields(record, ["provider", "model", "modelRole", "modelWhy"]), providerFailure: providerFailureOf(record.providerFailure) })).slice(0, 20);
  const waiting = (snapshot?.waiting?.rows ?? []).filter(row => ["model-cooldown", "model-window"].includes(row.why ?? row.reason)).slice(0, MODELS_LIMITS.waits).map(row => ({ jobId: safeId(row.jobId), queue: safeId(row.queue), reason: row.why ?? row.reason })).filter(row => row.jobId);
  const notes = ["Comparisons and fallback history use at most 1,000 retained local and mirrored run records over 30 days. Missing remote or expired records are unknown.", "A candidate shown next has not reserved a dollar window or endpoint. Credentials, egress, windows and slots are checked again at pickup.", "Repository agents' role declarations are not readable from this page."];
  if (facts.runs.some(run => run.projectUnknown) || facts.checks.some(check => check.projectUnknown)) notes.push("A local folder could not be resolved on this console host. The possible project scopes are shown; the owning worker resolves its actual folder at pickup.");
  if (records === null) notes.push("Run records could not be read; comparison and fallback history are unknown.");
  if (!snapshot?.waiting || snapshot.waiting.unreachable) notes.push("Waiting jobs could not be read; an empty list is not proof that none wait.");
  if (!snapshot?.doctor || snapshot.doctor.unreachable || !hostRows.length) notes.push("No published doctor proposal evidence is available. Reload after doctor publishes on a host.");
  return { now, scopes: [...new Set(["default", ...projects.map(project => project.id), ...scopes])], state: configUnknown ? "unreadable" : "ready", partial: true, banners, roles, cooldowns: observedCooldowns, models, proposals,
    canaries: canariesOf(retained, roles, deployment, now, sourceRecords), waiting, recentFallbacks,
    coverage: { complete: false, partial: true, records: retained.length, days: MODELS_LIMITS.days, truncated: dedup.size > MODELS_LIMITS.records || coverage.truncated === true, notes } };
}

function readText(path, fs, { missing = null } = {}) {
  if (!path) return missing;
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.size > MODELS_LIMITS.fileBytes) throw new Error("unsupported configuration file");
    return fs.readFileSync(path, "utf8");
  } catch (error) { if (error?.code === "ENOENT") return missing; throw error; }
}
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("model observation timed out")), MODELS_LIMITS.timeoutMs); })]).finally(() => clearTimeout(timer));
}

/** Fetch an explicit bounded history only for Models, then hydrate named originals through the authoritative by-id reader. */
export async function readModelsHistory({ fleet, now, seed = null } = {}) {
  if (typeof fleet?.runsPage !== "function") return { records: Array.isArray(seed) ? seed : null, sourceRecords: [], partial: true, truncated: false, sourcesUnknown: true };
  const records = [], sourceRecords = [];
  let before = null, partial = false, truncated = false;
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    let page;
    try { page = await bounded(fleet.runsPage({ before, limit: 100 })); } catch { partial = true; break; }
    if (!Array.isArray(page?.runs) || page.unreachable || page.refusal) { partial = true; break; }
    if (page.mirror !== "ok" || page.truncated) partial = true;
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
    const batch = await Promise.allSettled(wanted.slice(offset, offset + 4).map(id => bounded(fleet.runById(id))));
    batch.forEach((result, index) => {
      const id = wanted[offset + index], record = result.status === "fulfilled" ? result.value?.record : null;
      if (record?.jobId === id) sourceRecords.push(record);
      else sourcesUnknown = true;
    });
  }
  return { records, sourceRecords, partial, truncated, sourcesUnknown };
}

/** Dedicated page/tool reads. Reuses the caller's snapshot; no read is added to unrelated pages. */
export async function readModelsView({ paths = {}, env = {}, deploymentDir = null, now = Date.now(), snapshot = null, fleet = null, fs = nodeFs, redis = null, reads = {} } = {}) {
  now = typeof now === "function" ? now() : now;
  let configUnknown = false, overlayUnknown = false, entries = [], modelRoles = {}, projects = [], limits = [], overlay = null, envList = null;
  let settings = snapshot?.settings?.overlay ?? {};
  try {
    const text = reads.triggers ? await reads.triggers() : readText(paths.triggersPath, fs, { missing: '{"triggers":[]}' });
    const parsed = parseTriggersDocument(text, paths.triggersPath);
    entries = JSON.parse(text).triggers;
    modelRoles = parsed.modelRoles ?? {};
    const projectText = reads.projects ? await reads.projects() : readText(paths.projectsFile, fs);
    projects = projectText === null ? [] : parseProjects(projectText, paths.projectsFile);
    const limitsText = reads.limits ? await reads.limits() : readText(paths.scopedLimitsPath, fs);
    limits = limitsText === null ? [] : parseScopedLimits(limitsText, paths.scopedLimitsPath);
    if (snapshot?.settings?.invalid) throw new Error("invalid settings observation");
    if (!snapshot?.settings) { const view = readSettingsView({ settingsFile: paths.settingsFile, fs }); if (view.invalid) throw new Error("invalid settings"); settings = view.overlay ?? {}; }
    envList = allowedModelsFrom(env);
  } catch { configUnknown = true; }
  try { overlay = reads.overlay ? await reads.overlay() : readOverlayModels(paths.globalPiDir, { readFileSync: (path, encoding) => readText(path, fs), lstatSync: path => fs.lstatSync(path) }); }
  catch { overlayUnknown = true; }
  const deployment = { provider: settings.provider ?? env.PI_PROVIDER ?? DEFAULT_PROVIDER, model: settings.model ?? env.PI_MODEL ?? DEFAULT_MODEL, maxCostUsd: settings.maxCostUsd ?? env.PI_MAX_COST_USD ?? null };
  if (providerIdProblem(deployment.provider) !== null || modelIdProblem(deployment.model) !== null) configUnknown = true;
  if (!snapshot && fleet) { try { snapshot = await fleet.snapshot({ waiting: true }); } catch { snapshot = null; } }
  const source = snapshot?.recordDetails instanceof Map ? [...snapshot.recordDetails.values()] : Array.isArray(snapshot?.runs) ? snapshot.runs : null;
  let records, sourceRecords = [], historyCoverage = { partial: true };
  try {
    if (reads.records) records = await reads.records();
    else { historyCoverage = await readModelsHistory({ fleet, now, seed: source }); records = historyCoverage.records; sourceRecords = historyCoverage.sourceRecords; }
  } catch { records = null; }
  const policies = collectModelPolicies({ entries, modelRoles, projects, deployment, envList });
  const configuredRefs = cooldownModelRefs(policies.runs, deployment);
  let client = redis, owned = false, cooldowns = configuredRefs.length ? null : [], counters = null;
  const specs = dollarWindowSpecs({ caps: {}, limits, now: new Date(now) }).filter(row => row.ledger === "model");
  try {
    if (!client && (configuredRefs.length || specs.length) && (!reads.cooldowns && configuredRefs.length || !reads.counters && specs.length)) { client = (reads.redis ?? makeRedisClient)(paths.valkeyUrl); client.on?.("error", () => {}); owned = true; }
    if (configuredRefs.length) cooldowns = await bounded(reads.cooldowns ? reads.cooldowns(configuredRefs, { now: () => now }) : readModelCooldowns(client, configuredRefs, { now: () => now }));
    if (specs.length) {
      const values = reads.counters ? await bounded(reads.counters(specs.map(row => row.key))) : await bounded(client.mget(...specs.map(row => row.key)));
      if (!Array.isArray(values) || values.length !== specs.length) throw new Error("incomplete model counters");
      counters = new Map(specs.map((row, index) => [row.key, values?.[index] == null ? 0 : /^\d+$/.test(String(values[index])) && Number.isSafeInteger(Number(values[index])) ? Number(values[index]) : null]));
    }
  } catch { /* Unknown observations remain visible; a read never changes worker policy. */ }
  finally { if (owned) client?.disconnect?.(); }
  const windows = specs.map(spec => ({ ...spec, counterMicros: counters?.get(spec.key) ?? null }));
  return modelsViewOf({ entries, modelRoles, projects, deployment, envList, overlay, overlayUnknown, configUnknown, cooldowns, records, sourceRecords, snapshot, windows, coverage: historyCoverage, now, ...(reads.status ? { status: reads.status } : {}) });
}

/** Explicit machine projection: no doctor prose, command, path, prompt, URL, arbitrary field or secret reaches a model. */
export function modelsForAgent(view) {
  const model = value => splitModelEntry(value) ? value : null;
  const metrics = value => Object.fromEntries(["runs", "completed", "costPerRun", "averageTurns", "averageTokens", "knownCosts", "knownTurns", "knownTokens"].map(key => [key, finite(value?.[key])]));
  const next = value => ({ kind: ["direct", "candidate", "waiting", "unknown"].includes(value?.kind) ? value.kind : "unknown", model: model(value?.model), reason: ["pickup-checks-remain", "cooldowns-unavailable", "model-policy-unavailable", "model-cooldown", "model-failover-no-candidate"].includes(value?.reason) ? value.reason : null });
  const trigger = row => ({ index: integer(row?.index), number: integer(row?.number), project: safeId(row?.project), scope: safeId(row?.scope), flow: safeId(row?.flow), projectUnknown: row?.projectUnknown === true, model: model(row?.model), fallbackModels: (row?.fallbackModels ?? []).map(model).filter(Boolean) });
  const modelReason = reason => ["model-unknown", "model-not-allowed", "model-unpriced", "catalog-unavailable"].includes(reason) ? reason : null;
  const bannerReasons = { "role-conflict": ["model-role-unknown", "model-role-provider-conflict", "model-roles-invalid"], "radius-cost-cap": ["cost-cap"], "configuration-unavailable": ["model-roles-invalid"], "catalog-unavailable": ["model-unknown"], "cooldowns-unavailable": ["model-cooldown"] };

  return { scopes: (view?.scopes ?? []).filter(scope => safeId(scope)), state: view?.state === "ready" ? "ready" : "unreadable", partial: view?.partial !== false, now: integer(view?.now),
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
    waiting: (view?.waiting ?? []).map(row => ({ jobId: safeId(row.jobId), reason: ["model-cooldown", "model-window"].includes(row.reason) ? row.reason : null })),
    recentFallbacks: (view?.recentFallbacks ?? []).map(row => ({ jobId: runId(row.jobId), provider: providerIdProblem(row.provider) === null ? row.provider : null, model: modelIdProblem(row.model) === null ? row.model : null, modelRole: roleValid(row.modelRole) ? row.modelRole : null, modelWhy: MODEL_WHY.includes(row.modelWhy) ? row.modelWhy : null, providerFailure: providerFailureOf(row.providerFailure) })),
    banners: (view?.banners ?? []).map(row => ({ kind: Object.hasOwn(bannerReasons, row.kind) ? row.kind : "unknown", reason: Object.hasOwn(bannerReasons, row.kind) && bannerReasons[row.kind].includes(row.reason) ? row.reason : null, index: integer(row.index), project: safeId(row.project), projectUnknown: row.projectUnknown === true })),
    coverage: { complete: false, partial: true, records: integer(view?.coverage?.records), days: MODELS_LIMITS.days, truncated: view?.coverage?.truncated === true } };
}
