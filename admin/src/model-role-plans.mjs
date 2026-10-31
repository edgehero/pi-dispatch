/** A person's role-map edit, using pickup's policy and the triggers file's locked writer (#773). */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, allowedModelsFrom } from "@edgehero/pi-dispatch/config";
import { checkModelsKnown as catalogCheck } from "@edgehero/pi-dispatch/model-catalog";
import { SKILL_NAME_RE } from "@edgehero/pi-dispatch/flow-gate";
import { readOverlayModels } from "@edgehero/pi-dispatch/model-endpoints";
import { modelIdProblem, modelListProblem, providerIdProblem, splitModelEntry } from "@edgehero/pi-dispatch/model-ref";
import { MODEL_ROLE_RE, resolveModelRoles } from "@edgehero/pi-dispatch/model-roles";
import { isProjectId, parseProjects } from "@edgehero/pi-dispatch/projects";
import { readOverlay } from "@edgehero/pi-dispatch/runtime-settings";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { writeTriggers } from "@edgehero/pi-dispatch/triggers-file";
import { canaryComparisonLines, collectModelPolicies } from "./models-view.mjs";

export const MODEL_ROLE_EDIT_FIELDS = Object.freeze(["scope", "role", "model", "fallbackModels", "remove", "canary", "entry", "pruneScope", "pruneMap", "expectedEntry"]);
const POLICY_BYTES_MAX = 8 * 1024 * 1024;
const ENV_KEYS = Object.freeze(["PI_PROVIDER", "PI_MODEL", "PI_ALLOWED_MODELS", "PI_MAX_COST_USD", "PI_GLOBAL_PI_DIR", "PI_PROJECTS_FILE", "PI_TRIGGERS_FILE"]);
const sha = text => createHash("sha256").update(text).digest("hex");
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const denied = { refusal: "Only a person in the operator console can edit model roles.", status: 403 };
const authority = ctx => ctx?.surface === "console" && ctx?.role === "operator";
const refuse = (refusal, status = 400) => ({ refusal, status });
const envDigest = env => sha(JSON.stringify(ENV_KEYS.map(key => [key, env[key] ?? null])));
const roleText = raw => `${JSON.stringify(Object.hasOwn(raw, "modelRoles") ? { modelRoles: raw.modelRoles } : {}, null, 2)}\n`;

function inputProblem(body) {
  if (!plain(body) || Object.keys(body).some(key => !MODEL_ROLE_EDIT_FIELDS.includes(key))) return "The model role form contains an unknown field.";
  if (!isProjectId(body.scope)) return "Choose default or a project scope identifier.";
  if (typeof body.role !== "string" || !MODEL_ROLE_RE.test(body.role) || ["inherit", "constructor", "prototype"].includes(body.role)) return "A role must be a lowercase identifier of at most 32 characters; inherit is reserved.";
  for (const key of ["remove", "pruneScope", "pruneMap"]) if (body[key] !== undefined && typeof body[key] !== "boolean") return `${key} must be true or false.`;
  if (body.remove === true) {
    if (["model", "fallbackModels", "entry", "canary"].some(key => body[key] !== undefined)) return "A removal cannot also choose a model, fallbacks or a canary.";
  } else {
    if (body.pruneScope !== undefined || body.pruneMap !== undefined) return "Empty policy containers can be removed only while removing a role.";
    if (body.entry !== undefined && (body.model !== undefined || body.fallbackModels !== undefined || body.canary !== undefined)) return "An Undo entry cannot also choose another model, fallbacks or a canary.";
    const model = body.entry === undefined ? body.model : typeof body.entry === "string" ? body.entry : body.entry?.model;
    if (!splitModelEntry(model)) return "Choose a model written as provider/model.";
    if (body.entry === undefined && body.fallbackModels !== undefined && (!Array.isArray(body.fallbackModels) || body.fallbackModels.length && modelListProblem(body.fallbackModels) !== null)) return "Fallbacks must be an ordered list of at most 16 unique provider/model references.";
  }
  if (body.canary !== undefined) {
    const c = body.canary;
    if (!plain(c) || Object.keys(c).some(key => !["role", "candidate", "flow", "digest"].includes(key)) || c.role !== body.role || c.candidate !== body.model || typeof c.flow !== "string" || !SKILL_NAME_RE.test(c.flow) || typeof c.digest !== "string" || !/^[a-f0-9]{64}$/.test(c.digest)) return "The canary comparison does not match this role and candidate; reload Models and adopt again.";
  }
  return null;
}

function proposedDocument(raw, body) {
  const next = structuredClone(raw);
  const map = { ...(next.modelRoles ?? {}) };
  const scope = { ...(map[body.scope] ?? {}) };
  if (body.remove === true) {
    delete scope[body.role];
    if (body.pruneScope !== false && Object.keys(scope).length === 0) delete map[body.scope];
    else map[body.scope] = scope;
    if (body.pruneMap === true && Object.keys(map).length === 0) delete next.modelRoles;
    else next.modelRoles = map;
  } else {
    scope[body.role] = body.entry !== undefined ? structuredClone(body.entry) : body.fallbackModels?.length ? { model: body.model, fallbackModels: [...body.fallbackModels] } : body.model;
    next.modelRoles = { ...map, [body.scope]: scope };
  }
  return next;
}

/** Never repair a malformed policy file while the operator is reviewing one small role change. */
function capture(paths, fs) {
  const inputs = [...new Set([paths.triggersPath, paths.projectsFile, paths.settingsFile, paths.globalPiDir ? join(paths.globalPiDir, "models.json") : null].filter(path => typeof path === "string" && path !== ""))];
  const expect = [];
  for (const path of inputs) {
    let text;
    try {
      const stat = fs.lstatSync(path);
      if (!stat.isFile() || stat.size > POLICY_BYTES_MAX) return refuse("A model policy input is not a bounded regular file; correct it before editing roles.", 409);
      text = fs.readFileSync(path, "utf8");
      if (Buffer.byteLength(text) > POLICY_BYTES_MAX) return refuse("A model policy input is too large to review safely.", 409);
    } catch (error) {
      if (error?.code !== "ENOENT") return refuse("A model policy input could not be read; check the triggers, projects, settings and model overlay files.", 503);
      text = null;
    }
    expect.push({ path, text });
  }
  const captured = new Map(expect.map(input => [input.path, input.text]));
  const snapshotFs = { ...fs, readFileSync(path, encoding) {
    if (!captured.has(path)) return fs.readFileSync(path, encoding);
    const text = captured.get(path);
    if (text === null) throw Object.assign(new Error("missing policy input"), { code: "ENOENT" });
    return encoding ? text : Buffer.from(text);
  } };
  return { expect, fs: snapshotFs };
}

function knownProblem(refs, checkKnown, models) {
  const checked = checkKnown(refs, { readOverlay: () => models });
  if (checked?.unavailable) return "The model catalog or overlay is unavailable; check it before editing the role.";
  if (checked?.unknown) return "A role or effective trigger model is unknown to the pinned catalog and operator overlay; correct its provider/model reference.";
  if (checked?.fallbackUnlisted) return "An effective allowed-model list omits a model's declared server-side fallback; correct the reviewed list.";
  return checked?.ok === true ? null : "The model catalog did not validate this role policy.";
}

function checkPolicy({ loaded, raw, projects, deployment, envList, models, fs, checkKnown }) {
  const roles = loaded.modelRoles;
  // A scope with no current trigger consumers is still policy: the next trigger must not discover an overflow.
  for (const scope of ["default", ...Object.keys(roles).filter(scope => scope !== "default")]) {
    const merged = { ...(roles.default ?? {}), ...(scope === "default" ? {} : roles[scope] ?? {}) };
    const first = Object.keys(merged)[0];
    if (first) try {
      resolveModelRoles({ provider: deployment.provider, model: `role:${first}` }, roles, scope === "default" ? null : scope);
    } catch { return "The merged role policy exceeds 16 distinct models or cannot resolve; reduce the role models or fallbacks."; }
    for (const entry of Object.values(merged)) {
      const main = typeof entry === "string" ? entry : entry.model;
      for (const ref of [main, ...(typeof entry === "string" ? [] : entry.fallbackModels ?? [])]) {
        const split = splitModelEntry(ref);
        const problem = knownProblem([{ provider: split.provider, id: split.model, main: true }], checkKnown, models);
        if (problem) return problem;
      }
    }
  }
  const collected = collectModelPolicies({ entries: raw.triggers, modelRoles: roles, projects, deployment, envList, resolveFolder: path => fs.realpathSync(path) });
  if (collected.checks.length) {
    const check = collected.checks[0];
    const row = Number.isSafeInteger(check.sourceIndex) ? `Trigger row ${check.sourceIndex + 1}` : "A configured trigger";
    const descriptions = { "model-role-unknown": "names a role that would no longer be declared", "model-role-provider-conflict": "has a provider that clashes with its role", "model-roles-invalid": "has conflicting role and trigger fallbacks or an expanded list above 16 models" };
    return `${row} ${descriptions[check.reason] ?? "cannot resolve under the proposed role policy"}; correct it before confirming.`;
  }
  for (const run of collected.runs) {
    if (!splitModelEntry(`${run.provider}/${run.model}`)) return "An effective trigger model cannot be resolved; correct the deployment's provider and model.";
    const refs = [{ provider: run.provider, id: run.model, main: true }, ...(run.models ?? []).map(ref => { const split = splitModelEntry(ref); return { provider: split.provider, id: split.model }; })];
    const problem = knownProblem(refs, checkKnown, models);
    if (problem) return problem;
  }
  return { collected };
}

function policyImpact(before, after) {
  const beforeRows = new Map(before.runs.map(run => [`${run.sourceIndex}:${run.project ?? ""}`, run]));
  const selected = new Set(), permissions = new Set();
  for (const run of after.runs) {
    const prior = beforeRows.get(`${run.sourceIndex}:${run.project ?? ""}`);
    if (!prior || !same([prior.provider, prior.model, prior.fallbackModels], [run.provider, run.model, run.fallbackModels])) selected.add(run.sourceIndex);
    // All effective aliases join every job's policy, including literal and other-role jobs. A primary-only
    // comparison hides a changed executable ceiling or child role mapping from the person confirming it.
    if (!prior || !same([prior.models, prior.modelRoles], [run.models, run.modelRoles])) permissions.add(run.sourceIndex);
  }
  const indices = values => [...values].filter(Number.isSafeInteger).sort((a, b) => a - b);
  return { affected: indices(new Set([...selected, ...permissions])), selected: indices(selected), permissions: indices(new Set([...permissions].filter(index => !selected.has(index)))) };
}

function policyEffectDigest(before, after) {
  // File bytes do not bind filesystem-derived project attribution. In particular a trigger folder may be
  // a symlink whose target moves between preview and confirm without changing any reviewed policy file.
  const evidence = policy => ({
    runs: policy.runs.map(run => ({ sourceIndex: run.sourceIndex, project: run.project ?? null, projectUnknown: run.projectUnknown === true,
      folder: run.folder ?? null, provider: run.provider, model: run.model, modelRole: run.modelRole ?? null,
      models: run.models ?? null, modelRoles: run.modelRoles ?? null, fallbackModels: run.fallbackModels ?? null })),
    checks: policy.checks.map(check => ({ sourceIndex: check.sourceIndex, project: check.project ?? null, projectUnknown: check.projectUnknown === true, reason: check.reason })),
  });
  return sha(JSON.stringify({ before: evidence(before), after: evidence(after) }));
}

export function createModelRoleActions({ paths, env = {}, fs = nodeFs, now = Date.now, checkModelsKnown = catalogCheck, canarySample = null } = {}) {
  async function preview(body, ctx) {
    if (!authority(ctx)) return denied;
    const problem = inputProblem(body);
    if (problem) return refuse(problem);
    if (!paths?.triggersPath) return refuse("This console does not name its triggers file.", 409);
    const captured = capture(paths, fs);
    if (captured.refusal) return captured;
    const readFs = captured.fs;
    let raw, loaded, next, nextLoaded, projects, deployment, envList, models;
    try {
      const text = readFs.readFileSync(paths.triggersPath, "utf8");
      loaded = parseTriggersDocument(text, paths.triggersPath);
      raw = JSON.parse(text);
      if (Object.hasOwn(body, "expectedEntry") && !same(raw.modelRoles?.[body.scope]?.[body.role] ?? null, body.expectedEntry)) return refuse("The role changed after the edit being undone; reload Models before choosing a new mapping.", 409);
      if (body.remove === true && !Object.hasOwn(raw.modelRoles?.[body.scope] ?? {}, body.role)) return { unchanged: "This scope no longer declares the role." };
      next = proposedDocument(raw, body);
      nextLoaded = parseTriggersDocument(JSON.stringify(next), paths.triggersPath);
      projects = paths.projectsFile ? parseProjects(readFs.readFileSync(paths.projectsFile, "utf8"), paths.projectsFile) : [];
      const settings = paths.settingsFile ? readOverlay(paths.settingsFile, { fs: readFs }) : { overlay: {} };
      if (settings.invalid) return refuse("The settings file is invalid; correct it before editing model roles.", 409);
      deployment = { provider: settings.overlay.provider ?? env.PI_PROVIDER ?? DEFAULT_PROVIDER, model: settings.overlay.model ?? env.PI_MODEL ?? DEFAULT_MODEL };
      if (providerIdProblem(deployment.provider) !== null || modelIdProblem(deployment.model) !== null) return refuse("The deployment's provider or model setting is invalid.", 409);
      try { envList = allowedModelsFrom(env); }
      catch { return refuse("PI_ALLOWED_MODELS is invalid; correct it before editing model roles.", 409); }
      models = readOverlayModels(paths.globalPiDir, { readFileSync: (...args) => readFs.readFileSync(...args), lstatSync: (...args) => readFs.lstatSync(...args) });
    } catch { return refuse("The triggers, project policy or model overlay could not be validated; correct those files before editing the role.", 409); }
    if (same(raw, next)) return { unchanged: "This role already has the requested model and fallbacks." };
    const checked = checkPolicy({ loaded: nextLoaded, raw: next, projects, deployment, envList, models, fs: readFs, checkKnown: checkModelsKnown });
    if (typeof checked === "string") return refuse(checked, 409);
    let sample = null;
    if (body.canary) {
      try { sample = await canarySample?.({ role: body.canary.role, candidate: body.canary.candidate, flow: body.canary.flow }); } catch { /* The fixed refusal below names missing evidence, never the reader's text. */ }
      if (!sample || sample.digest !== body.canary.digest) return refuse("The retained canary comparison changed or is unavailable; reload Models and review it again.", 409);
    }
    const before = collectModelPolicies({ entries: raw.triggers, modelRoles: loaded.modelRoles, projects, deployment, envList, resolveFolder: path => readFs.realpathSync(path) });
    const impact = policyImpact(before, checked.collected);
    const affected = impact.affected;
    const previous = raw.modelRoles?.[body.scope]?.[body.role];
    const inverseBody = { ...(previous === undefined ? { scope: body.scope, role: body.role, remove: true, pruneScope: !Object.hasOwn(raw.modelRoles ?? {}, body.scope), pruneMap: !Object.hasOwn(raw, "modelRoles") } : { scope: body.scope, role: body.role, entry: structuredClone(previous) }), expectedEntry: structuredClone(next.modelRoles?.[body.scope]?.[body.role] ?? null) };
    const beforeText = roleText(raw), afterText = roleText(next);
    const summary = [`${body.remove ? "Remove" : "Set"} model role ${body.scope}/${body.role}`, impact.selected.length ? `Trigger ${impact.selected.length === 1 ? "row" : "rows"} ${impact.selected.map(index => index + 1).join(", ")} ${impact.selected.length === 1 ? "uses" : "use"} the reviewed mapping on ${impact.selected.length === 1 ? "its" : "their"} next delivery.` : "No current trigger changes its selected model or fallback order.", ...(impact.permissions.length ? [`Trigger ${impact.permissions.length === 1 ? "row" : "rows"} ${impact.permissions.map(index => index + 1).join(", ")} ${impact.permissions.length === 1 ? "keeps its" : "keep their"} selected model and fallback order, but the allowed-model list or role aliases change on ${impact.permissions.length === 1 ? "its" : "their"} next delivery.`] : []), "Nothing runs now. Recovery keeps its checkpoint's physical model and still validates the reviewed policy.", ...(sample ? canaryComparisonLines(sample) : [])];
    return { target: paths.triggersPath, expect: captured.expect, beforeText, afterText, beforeDigest: sha(captured.expect.find(input => input.path === paths.triggersPath).text), afterDigest: sha(`${JSON.stringify(next, null, 2)}\n`), summary, inverseBody,
      plan: { scope: body.scope, role: body.role, remove: body.remove === true, affected, inverseBody },
      payload: { body: structuredClone(body), envDigest: envDigest(env), effectDigest: policyEffectDigest(before, checked.collected), ...(sample ? { canary: { ...body.canary } } : {}) } };
  }
  async function apply(entry, ctx) {
    if (!authority(ctx)) return { invalid: denied.refusal };
    if (!entry?.payload?.body || envDigest(env) !== entry.payload.envDigest) return { invalid: "The model policy environment changed; preview the role edit again." };
    // Rebuild with current inputs, then compare the original snapshots again under the writer lock.
    const current = await preview(entry.payload.body, ctx);
    if (current.refusal || current.unchanged) return { invalid: current.refusal ?? "The model role changed; preview it again." };
    const expected = Array.isArray(entry.expect) ? entry.expect : [];
    if (expected.length !== current.expect.length || expected.some((input, index) => input.path !== current.expect[index].path || input.text !== current.expect[index].text)) return { invalid: "A model policy input changed after preview; reload Models and preview the role edit again." };
    if (entry.payload.effectDigest !== current.payload.effectDigest) return { invalid: "The effective trigger scopes or model policy changed after preview; reload Models and review the role edit again." };
    return writeTriggers({ triggersPath: paths.triggersPath, mutate: entries => entries, mutateDocument: doc => proposedDocument(doc, entry.payload.body), expect: expected, fs, now });
  }
  return { preview, apply };
}
