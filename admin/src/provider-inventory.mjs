/** Read-only, value-free provider credential inventory. No provider SDK or host login is loaded. */
import * as nodeFs from "node:fs";
import { resolve, dirname } from "node:path";
import { deploymentServiceEnv } from "@edgehero/pi-dispatch/service-env";
import { DEFAULT_MODEL, providerFrom, settingsFilePath, allowedModelsFrom } from "@edgehero/pi-dispatch/config";
import { readOverlay } from "@edgehero/pi-dispatch/runtime-settings";
import { CRON_ID_MAX, parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { failoverListUsable, splitModelEntry, providerIdProblem } from "@edgehero/pi-dispatch/model-ref";
import { resolveModelRoles } from "@edgehero/pi-dispatch/model-roles";
import { resolveConfiguredModelRuns } from "@edgehero/pi-dispatch/model-observation";
import { parseProjects } from "@edgehero/pi-dispatch/projects";
import { parseAuthConnections } from "@edgehero/pi-dispatch/auth-policy";
import { apiKeyVariable, nonApiKeyKind, needsHostAuthentication } from "@edgehero/pi-dispatch/provider-key";
import { PROVIDER_KEY_NAMES } from "./provider-key-names.mjs";

export const PROVIDER_KEY_REASONS = Object.freeze({
  "env-unreadable": "Credential metadata could not be read safely. Inspect the deployment on its host.",
  "references-unreadable": "Some provider references could not be read. This list may be incomplete.",
  "settings-unreadable": "Provider settings could not be verified. Inspect the deployment settings on the host.",
  "policy-unreadable": "The managed connection policy could not be verified. Use its host instructions.",
  "source-shadowed": "Another host credential source takes precedence. Review it on the host before saving.",
  "managed-binding": "A managed subscription owns this provider. Use its connection controls on the owning host.",
  "pi-fallback-possible": "No deployment key is set. A host pi API-key login may be used; preview explains any source switch.",
  "special-auth": "This provider needs its supported host authentication flow, not a generic token field.",
  "custom-provider": "This custom provider has no reviewed environment-key mapping. Follow its host configuration.",
});
const SOURCES = ["deployment-env", "managed", "shadowed", "pi-fallback", "missing", "unknown", "special"];
const STATUSES = ["configured", "missing", "managed", "shadowed", "unknown", "unsupported"];
const USAGE = ["default", "trigger", "allowed-model", "fallback", "role", "binding", "configured"];
const id = value => typeof value === "string" && providerIdProblem(value) === null ? value : null;
const known = provider => typeof provider === "string" && Object.hasOwn(PROVIDER_KEY_NAMES, provider);
export function providerCanonicalKey(provider) {
  const key = apiKeyVariable(known(provider) ? PROVIDER_KEY_NAMES[provider] : []);
  return key && nonApiKeyKind(key) === null ? key : null;
}
export const PROVIDER_SLOT_ALIASES = Object.freeze(Object.fromEntries([...new Set(Object.keys(PROVIDER_KEY_NAMES).map(providerCanonicalKey).filter(Boolean))].sort().map(key => [key, Object.freeze(Object.keys(PROVIDER_KEY_NAMES).filter(provider => providerCanonicalKey(provider) === key).sort())])));
/** Issue #1000: the trigger positions one slot's own-key line names; the rest are counted, never dropped silently. */
export const DECLARED_KEY_TRIGGERS_MAX = 16;
/** Issue #1029: the role models a trigger may reach a slot by alone, a watch rule's classifier or an auxiliary model. */
export const DECLARED_KEY_VIA = Object.freeze(["decide", "auxiliary"]);
/** Issue #1000: where the own-key lines are incomplete or wider than the workers' answer, each said once on the card. */
export const DECLARED_KEY_NOTES = Object.freeze({
  "projects-unread": "The projects file could not be read, so a model role is resolved in every project the triggers file names, and a trigger may be listed under a provider its jobs never run on.",
  "default-model-unread": "PI_MODEL could not be read from the deployment's .env, so a trigger that names no model of its own is not listed while the triggers file declares model roles.",
  "forward-unread": "PI_FORWARD_ENV could not be read from the deployment's .env, so whether this host names a trigger's own key there, and refuses those jobs, is not known.",
});
const present = (env, key) => typeof env?.[key] === "string" && env[key] !== "";
const definedCredential = (env, key) => typeof env?.[key] === "string" && env[key] !== "";
const unknownRead = value => !value || Boolean(value.unreadable || value.untrusted || value.hazard || value.unread?.length || value.hazardSkipped?.length);

/** Bounded descriptor read for metadata, not credentials. Missing settings is the worker's empty overlay. */
function metadataBytes(path, fs, uid, max = 1_048_576) {
  let fd;
  try {
    // An absent file in a writable or redirected parent is not verified absence: the host
    // writer refuses it too. Judge the supplied spelling before any missing-file return.
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      let st;
      try { st = fs.lstatSync(parent); } catch (e) { if (e?.code !== "ENOENT") throw e; }
      if (st && (!st.isDirectory() || (st.uid !== uid && st.uid !== 0) || ((st.mode & 0o022) && !(st.mode & 0o1000)))) throw Error("unsafe metadata parent");
      if (parent === dirname(parent)) break;
    }
    const original = fs.lstatSync(path);
    if (!original.isFile() || original.isSymbolicLink() || (original.uid !== uid && original.uid !== 0) || (original.mode & 0o022) || original.size > max) throw Error("unsafe metadata");
    fd = fs.openSync(path, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== original.dev || opened.ino !== original.ino || (opened.uid !== uid && opened.uid !== 0) || (opened.mode & 0o022) || opened.size > max) throw Error("changed metadata");
    const bytes = fs.readFileSync(fd);
    if (bytes.length > max) throw Error("oversized metadata");
    return String(bytes);
  } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * Issue #1000: the triggers that bring their own key, from the triggers file: `{ slots, notes }`, `slots` a
 * `Map<slot, [{ index, cron, via? }]>` (a cron trigger's id, the name doctor gives it, else null) and `notes` the
 * `DECLARED_KEY_NOTES` that say where the answer is incomplete or wider than the workers'. Since issue #967 a trigger
 * whose `run.secrets` binds the API-key variable of the provider a job runs on makes that value the job's credential,
 * and the host's key for that provider is not read, so a slot read from this host's sources alone could say "Not set"
 * while such triggers spend on it, or name the deployment key while some of them use another.
 *
 * This is the half of the worker's rule (`declaredProviderKey`, env-allowlist.mjs) the file decides, asked of the
 * attempts doctor's line asks it of (`modelSubjects` with fallbacks), through the same resolver
 * (`resolveConfiguredModelRuns` over the runs doctor builds, with the projects file): the provider a trigger's jobs run
 * on (its own, the deployment default it inherits, or its model role's in the project the job lands in), each random
 * candidate's, and each fallback the walk would try (`failoverListUsable`). Issue #1029: and the providers the worker
 * judges by the same rule beside them, each marked by `via` where it is the only way the trigger reaches the slot: a
 * watch rule's `decide` model (`via: "decide"`, issue #997) and each model in `run.auxiliaryModels`
 * (`via: "auxiliary"`, issue #999, the rule `reservedAuxiliaryNames` asks). A watch rule counts since issue #997, its
 * main model as any trigger's, but outside the model roles: the worker reads none for a watch job (index.mjs), so its
 * main model is its own or the deployment default, and a default that is a role refuses it (`model-role-unknown`)
 * before any attempt. The name must be the provider's slot (`providerCanonicalKey`, never an OAuth or bearer variable),
 * a key of `run.secrets` and not of `run.secretFiles`; a provider that needs host authentication never counts. The rest
 * is each host's own, its PI_FORWARD_ENV and its subscription bindings, which the caller and the card say, but for the
 * one fence doctor applies too: `managed(provider)` is this host's subscription binding, and behind a primary bound to
 * a subscription the walk skips every fallback that is not (`auth-mixed-billing`, model-failover.mjs
 * `selectFailoverJob`), so such a fallback runs no attempt here and brings no key. A decide or auxiliary provider bound
 * here is listed, as a main one is: the worker refuses those jobs, which the card's managed row says.
 *
 * Two inputs may be unknown. `projects` null is a projects file that could not be read: a role then resolves in every
 * scope the triggers file names, which can list a trigger under a provider its jobs never run on, and says so, rather
 * than hiding a key the file binds. `defaultModel` null is a PI_MODEL line that could not be read with no model in the
 * overlay: with model roles declared, the default may itself be a role, so a trigger naming no model is not judged.
 */
export function declaredKeyTriggers(triggers, { defaultProvider = null, defaultModel = null, envList = null, modelRoles = {}, projects = [], resolveFolder, managed = () => false } = {}) {
  const roles = modelRoles !== null && typeof modelRoles === "object" ? modelRoles : {};
  const withRoles = Object.keys(roles).length > 0;
  const list = Array.isArray(triggers) ? triggers : [];
  const notes = new Set();
  const runs = [];
  // Watch rules beside the resolver, never through it: the worker applies no model role to a watch job.
  const watched = [];
  list.forEach((row, index) => {
    const run = row?.run;
    if (run?.secrets === null || typeof run?.secrets !== "object") return;
    if (withRoles && defaultModel === null && run.modelSelection === undefined && run.model === undefined) { notes.add("default-model-unread"); return; }
    if (row?.on?.type === "watch") {
      if (run.model === undefined && typeof defaultModel === "string" && defaultModel.startsWith("role:")) return;
      watched.push({ sourceIndex: index, provider: typeof run.provider === "string" ? run.provider : defaultProvider });
      return;
    }
    // doctor's `modelRuns` fields (readTriggerFacts), so the resolver reaches each trigger's project as doctor's does.
    runs.push({ sourceIndex: index, label: `trigger ${index + 1}`, kind: run.kind, folder: run.folder, repository: run.repository, provider: typeof run.provider === "string" ? run.provider : undefined, model: typeof run.model === "string" ? run.model : undefined, models: Array.isArray(run.models) ? run.models : undefined, fallbackModels: Array.isArray(run.fallbackModels) ? run.fallbackModels : undefined, ...(run.modelSelection ? { modelSelection: run.modelSelection } : {}) });
  });
  const deployment = { provider: defaultProvider, model: defaultModel };
  let resolved;
  if (projects !== null || !withRoles) {
    // Doctor's call, without Models' `conservativeLocal`: a folder this host cannot resolve keeps its spelling and lands
    // in the project that names it, as doctor and the worker's rule place it. Judging it in every project with a folder
    // member, as Models does, named such a trigger under a provider its jobs never run on.
    resolved = resolveConfiguredModelRuns({ runs, deployment, envList, modelRoles: roles, projects: projects ?? [], ...(resolveFolder ? { resolveFolder } : {}) }).runs;
  } else {
    notes.add("projects-unread");
    const scopes = [null, ...Object.keys(roles).filter(scope => scope !== "default")];
    resolved = runs.flatMap(run => {
      if (run.modelSelection) return [run];
      const models = run.models ?? envList;
      const job = { ...run, provider: run.provider ?? deployment.provider, model: run.model ?? deployment.model, ...(models ? { models } : {}) };
      // A scope whose roles refuse this job is one where it never runs: the worker refuses it there before any attempt.
      return scopes.flatMap(scope => { try { return [resolveModelRoles(job, roles, scope, { authoredProvider: run.provider })]; } catch { return []; } });
    });
  }
  const slots = new Map();
  for (const run of [...resolved, ...watched]) {
    const trigger = list[run.sourceIndex];
    // provider -> `via`: null where an attempt runs on it as its main model, else the one role model that reaches it.
    const providers = new Map();
    const reach = (provider, via = null) => { if (via === null || !providers.has(provider)) providers.set(provider, via); };
    const add = entry => { const ref = splitModelEntry(entry); if (ref) reach(ref.provider); };
    // A pool is physical and reviewed: each candidate is the main model of the draws that land on it, and the default it
    // would otherwise inherit is never one of them (model-observation.mjs).
    if (run.modelSelection) for (const entry of run.modelSelection.candidates ?? []) add(entry);
    else {
      const primary = run.provider ?? deployment.provider;
      reach(primary);
      if (run.fallbackModels !== undefined && failoverListUsable({ fallbackModels: run.fallbackModels, models: run.models ?? envList })) {
        for (const entry of run.fallbackModels) {
          const ref = splitModelEntry(entry);
          // Doctor's fence, by its primary: the walk never leaves a subscription for an API-key fallback.
          if (ref && !(managed(primary) && !managed(ref.provider))) reach(ref.provider);
        }
      }
    }
    // The role models every attempt of the trigger carries, each judged for its own provider (the worker's
    // `credentialJobs` and auxiliary gate): a watch rule's classifier and the auxiliary models. One on a provider an
    // attempt runs on shares that attempt's key, which the main entry already names.
    const decide = trigger.on?.type === "watch" ? splitModelEntry(trigger.decide?.model) : null;
    if (decide) reach(decide.provider, "decide");
    for (const entry of Array.isArray(trigger.run.auxiliaryModels) ? trigger.run.auxiliaryModels : []) { const ref = splitModelEntry(entry); if (ref) reach(ref.provider, "auxiliary"); }
    const secrets = trigger.run.secrets;
    const files = trigger.run.secretFiles;
    for (const [provider, via] of providers) {
      if (typeof provider !== "string" || needsHostAuthentication(provider)) continue;
      const key = providerCanonicalKey(provider);
      if (!key || !Object.hasOwn(secrets, key)) continue;
      if (files !== null && typeof files === "object" && Object.hasOwn(files, key)) continue;
      if (!slots.has(key)) slots.set(key, []);
      // Providers sharing a slot (OPENCODE_API_KEY serves two) name a trigger once, as its main model's where either is.
      const held = slots.get(key).find(t => t.index === run.sourceIndex);
      if (held) { if (via === null) delete held.via; continue; }
      slots.get(key).push({ index: run.sourceIndex, cron: trigger.on?.type === "cron" && cronId(trigger.on.id) ? trigger.on.id : null, ...(via ? { via } : {}) });
    }
  }
  for (const rows of slots.values()) rows.sort((a, b) => a.index - b.index);
  return { slots, notes: [...notes] };
}

/** A cron trigger's `on.id` as the loader admits it, the name doctor gives the trigger, or null. */
const cronId = value => typeof value === "string" && value.length <= CRON_ID_MAX && /^[A-Za-z0-9._-]+$/.test(value) ? value : null;

/**
 * The own-key facts the Connections card draws (issue #1000), rebuilt from any DTO: `{ slots, notes }`, each slot a
 * provider slot with trigger positions and cron ids only, at most `DECLARED_KEY_TRIGGERS_MAX` of them (the rest counted),
 * each with the role model it reaches the slot by alone (`via`, issue #1029, one of `DECLARED_KEY_VIA`, absent for an
 * attempt's main model), and whether this host's PI_FORWARD_ENV names the variable (`forwarded`, null when it could not
 * be read).
 */
export function declaredKeysView(raw) {
  const slots = new Map();
  for (const row of (Array.isArray(raw?.declaredKeys) ? raw.declaredKeys : []).slice(0, Object.keys(PROVIDER_SLOT_ALIASES).length)) {
    if (typeof row?.key !== "string" || !Object.hasOwn(PROVIDER_SLOT_ALIASES, row.key) || slots.has(row.key)) continue;
    const seen = new Set();
    const triggers = (Array.isArray(row.triggers) ? row.triggers : []).filter(t => Number.isSafeInteger(t?.index) && t.index >= 0 && !seen.has(t.index) && seen.add(t.index)).map(t => ({ index: t.index, cron: cronId(t.cron), ...(DECLARED_KEY_VIA.includes(t.via) ? { via: t.via } : {}) })).sort((a, b) => a.index - b.index);
    if (triggers.length === 0) continue;
    const more = Number.isSafeInteger(row.more) && row.more >= 0 ? row.more : 0;
    slots.set(row.key, { triggers: triggers.slice(0, DECLARED_KEY_TRIGGERS_MAX), more: more + Math.max(0, triggers.length - DECLARED_KEY_TRIGGERS_MAX), forwarded: typeof row.forwarded === "boolean" ? row.forwarded : null });
  }
  const notes = [...new Set((Array.isArray(raw?.declaredNotes) ? raw.declaredNotes : []).filter(note => typeof note === "string" && Object.hasOwn(DECLARED_KEY_NOTES, note)))];
  return { slots, notes };
}

const OWN_KEY_KEYS = Object.freeze(["PI_MODEL", "PI_PROJECTS_FILE", "PI_FORWARD_ENV"]);

/** `{ unread, value }` over OWN_KEY_KEYS, the file's value over the console's own as the inventory's other keys are. */
function ownKeyEnvironment({ root, env, fs, platform, uid, reads }) {
  try {
    const got = (reads.environment ?? deploymentServiceEnv)({ env: {}, dir: root, keys: [...OWN_KEY_KEYS], fs, platform, uid });
    const whole = !got || got.unreadable || got.untrusted || got.hazard;
    const unread = new Set(whole ? OWN_KEY_KEYS : [...(got.unread ?? []).map(row => row.key), ...(got.hazardSkipped ?? [])]);
    return { unread, value: key => typeof got.env?.[key] === "string" ? got.env[key] : typeof env[key] === "string" ? env[key] : undefined };
  } catch { return { unread: new Set(OWN_KEY_KEYS), value: () => undefined }; }
}

/** The projects the workers load (`loadProjects`): [] when PI_PROJECTS_FILE is unset, null when it cannot be read. */
function ownKeyProjects(ownKeyEnv, { root, fs, uid, reads }) {
  if (!ownKeyEnv || ownKeyEnv.unread.has("PI_PROJECTS_FILE")) return null;
  const named = ownKeyEnv.value("PI_PROJECTS_FILE");
  if (named === undefined) return [];
  // An empty value is a file the worker refuses to start on, as is a missing one: neither is "no projects".
  if (named === "") return null;
  try {
    const path = resolve(root, named);
    const raw = reads.projects ? reads.projects(path) : metadataBytes(path, fs, uid);
    return raw === null ? null : parseProjects(raw, path);
  } catch { return null; }
}

export function readProviderInventory({ deploymentDir, env = {}, fs = nodeFs, platform = process.platform, uid = process.geteuid?.(), reads = {} } = {}) {
  // The host planner starts from the canonical deployment too. Platform aliases such
  // as macOS /var must not be mistaken for a source-file parent redirection.
  let root = resolve(deploymentDir ?? ".");
  try { root = fs.realpathSync(root); } catch { /* Metadata checks retain the unreadable result. */ }
  const references = new Map();
  const use = (provider, why) => { if (id(provider)) { if (!references.has(provider)) references.set(provider, new Set()); references.get(provider).add(why); } };
  const model = (entry, why) => { const ref = splitModelEntry(entry); if (!ref) throw Error("invalid model reference"); use(ref.provider, why); };
  const keys = ["PI_PROVIDER", "PI_SETTINGS_FILE", "PI_ALLOWED_MODELS", "PI_TRIGGERS_FILE", "PI_AUTH_CONNECTIONS_FILE", "PI_AUTH_FROM_PI"];
  const allVariables = [...new Set(Object.values(PROVIDER_KEY_NAMES).flat())];
  let configured = {}, file = {}, environmentUnknown = false, referencesUnknown = false, policyUnknown = false, configurationUnknown = false, defaultProvider = null, defaultModel = null, envList = null, declared = { slots: new Map(), notes: [] }, declaredInput = null;
  try {
    const got = (reads.environment ?? deploymentServiceEnv)({ env: {}, dir: root, keys: [...keys, ...allVariables], fs, platform, uid });
    if (unknownRead(got)) throw Error("unknown environment");
    file = got.env ?? {};
    configured = { ...Object.fromEntries(keys.filter(key => typeof env[key] === "string").map(key => [key, env[key]])), ...Object.fromEntries(keys.filter(key => typeof file[key] === "string").map(key => [key, file[key]])) };
  } catch { environmentUnknown = true; }
  // Issue #1000: the keys only the own-key lines need, read on their own: a line of one the loaders may read apart from
  // this reader makes that key unknown, never the whole environment the inventory's sources come from.
  const ownKeyEnv = environmentUnknown ? null : ownKeyEnvironment({ root, env, fs, platform, uid, reads });
  try {
    if (environmentUnknown) throw Error();
    const path = resolve(root, settingsFilePath(configured));
    const overlay = reads.settings ? reads.settings(path) : readOverlay(path, { fs: { readFileSync: () => { const text = metadataBytes(path, fs, uid); if (text === null) throw Object.assign(Error(), { code: "ENOENT" }); return text; } } });
    if (overlay?.invalid) throw Error();
    defaultProvider = overlay?.overlay?.provider ?? providerFrom(configured);
    if (!id(defaultProvider)) throw Error();
    // The worker's own default (overlay over .env), which a job of a trigger naming no model runs on; null when the overlay
    // names none and the .env's line cannot be read.
    defaultModel = overlay?.overlay?.model ?? (ownKeyEnv?.unread.has("PI_MODEL") === false ? ownKeyEnv.value("PI_MODEL") ?? DEFAULT_MODEL : null);
    use(defaultProvider, "default");
  } catch { configurationUnknown = true; defaultProvider = null; }
  try {
    const list = allowedModelsFrom(configured) ?? null;
    for (const entry of list ?? []) model(entry, "allowed-model");
    envList = list;
  } catch { referencesUnknown = true; }
  try {
    // Paths captured at console startup can name an obsolete file after a host edit.
    // Match the worker/receiver rule: unset defaults here, explicit empty remains invalid.
    const path = configured.PI_TRIGGERS_FILE === "" ? "" : resolve(root, configured.PI_TRIGGERS_FILE ?? "triggers.json");
    const raw = reads.document ? reads.document(path) : metadataBytes(path, fs, uid);
    // A triggers file that does not exist is an empty document (issue #988): no trigger names a provider, which is a
    // read's answer and leaves the list whole. It was "Some provider references could not be read." A setting that
    // names no file at all (explicit empty) is not that: which file the workers run is then not known.
    if (raw === null && path === "") throw Error();
    const doc = raw === null ? { triggers: [], modelRoles: {} } : parseTriggersDocument(typeof raw === "string" ? raw : JSON.stringify(raw), path);
    for (const row of doc.triggers) {
      if (row.run.provider) use(row.run.provider, "trigger");
      // Issue #1029: a watch rule's classifier needs its provider's credential like the rule's own model, and may bring
      // its own key, which the card can name only under a row.
      if (row.decide?.model) model(row.decide.model, "trigger");
      for (const entry of row.run.models ?? []) model(entry, "allowed-model");
      for (const entry of row.run.modelSelection?.candidates ?? []) model(entry, "trigger");
      for (const entry of row.run.fallbackModels ?? []) model(entry, "fallback");
    }
    for (const scope of Object.values(doc.modelRoles)) for (const role of Object.values(scope)) {
      model(typeof role === "string" ? role : role.model, "role");
      if (typeof role !== "string") for (const entry of role.fallbackModels ?? []) model(entry, "fallback");
    }
    // Issue #1000: only from the file the deployment names. With its .env unread, PI_TRIGGERS_FILE is not known, and the
    // default file read above may not be the one the workers run, so no trigger is said to bring a key from it.
    if (!environmentUnknown) declaredInput = doc;
  } catch { referencesUnknown = true; }
  let bindings = {};
  if (configured.PI_AUTH_CONNECTIONS_FILE) {
    try {
      const path = resolve(root, configured.PI_AUTH_CONNECTIONS_FILE);
      const raw = reads.policy ? reads.policy(path) : metadataBytes(path, fs, uid, 65_536);
      if (raw === null) throw Error();
      bindings = parseAuthConnections(raw).bindings;
      for (const provider of Object.keys(bindings)) use(provider, "binding");
    } catch { policyUnknown = true; }
  }
  // After the bindings, for doctor's fallback fence; an unread policy fences nothing, and every row reads unknown then.
  try {
    if (declaredInput) declared = declaredKeyTriggers(declaredInput.triggers, { defaultProvider, defaultModel, envList, modelRoles: declaredInput.modelRoles, projects: Object.keys(declaredInput.modelRoles).length > 0 ? ownKeyProjects(ownKeyEnv, { root, fs, uid, reads }) : [], managed: provider => Object.hasOwn(bindings, provider) });
  } catch { referencesUnknown = true; }
  for (const [provider, candidates] of Object.entries(PROVIDER_KEY_NAMES)) if (candidates.some(key => present(file, key) || definedCredential(env, key))) use(provider, "configured");
  const grouped = new Map();
  for (const [provider, usage] of references) {
    const key = providerCanonicalKey(provider);
    const group = key ?? `provider:${provider}`;
    if (!grouped.has(group)) grouped.set(group, { provider, key, providers: key ? [...PROVIDER_SLOT_ALIASES[key]] : [provider], usage: new Set() });
    const row = grouped.get(group);
    if (provider === defaultProvider) row.provider = provider;
    for (const why of usage) row.usage.add(why);
  }
  const rows = [...grouped.values()].map(row => {
    const candidates = known(row.provider) ? PROVIDER_KEY_NAMES[row.provider] : [];
    const hasKey = environmentUnknown ? null : row.key ? present(file, row.key) : false;
    const managed = row.providers.some(provider => Object.hasOwn(bindings, provider));
    const shadowed = candidates.some(key => definedCredential(env, key) || key !== row.key && definedCredential(file, key));
    const special = !row.key || needsHostAuthentication(row.provider);
    const status = environmentUnknown || policyUnknown || configurationUnknown ? "unknown" : managed ? "managed" : shadowed ? "shadowed" : special ? "unsupported" : hasKey ? "configured" : "missing";
    const source = status === "unknown" ? "unknown" : managed ? "managed" : shadowed ? "shadowed" : special ? "special" : hasKey ? "deployment-env" : "missing";
    const reason = environmentUnknown ? "env-unreadable" : configurationUnknown ? "settings-unreadable" : policyUnknown ? "policy-unreadable" : managed ? "managed-binding" : shadowed ? "source-shadowed" : special ? known(row.provider) ? "special-auth" : "custom-provider" : !hasKey && configured.PI_AUTH_FROM_PI !== "0" ? "pi-fallback-possible" : referencesUnknown ? "references-unreadable" : null;
    return { ...row, usage: USAGE.filter(why => row.usage.has(why)), present: hasKey, source, status, mode: ["configured", "missing"].includes(status) ? hasKey ? "replace" : "add" : null, reason };
  }).sort((a, b) => (b.usage.includes("default") - a.usage.includes("default")) || a.provider.localeCompare(b.provider));
  const choices = Object.keys(PROVIDER_KEY_NAMES).map(provider => ({ provider, key: providerCanonicalKey(provider), providers: providerCanonicalKey(provider) ? [...PROVIDER_SLOT_ALIASES[providerCanonicalKey(provider)]] : [provider], mode: "add", supported: Boolean(providerCanonicalKey(provider)) && !needsHostAuthentication(provider) }));
  const inventory = providerInventoryView({ state: environmentUnknown || policyUnknown || configurationUnknown ? "unknown" : referencesUnknown ? "partial" : "ready", defaultProvider, rows, choices });
  // Beside the projected inventory, never inside it: `providerInventoryView` also feeds Setup and the agent's
  // `dispatch_connections`, which keep what they carried, and the trigger positions are Connections' alone (issue #1000).
  // `forwarded` is this host's PI_FORWARD_ENV naming the slot's variable, which makes this host refuse those jobs; null
  // when its line cannot be read.
  const forward = ownKeyEnv && !ownKeyEnv.unread.has("PI_FORWARD_ENV") ? (ownKeyEnv.value("PI_FORWARD_ENV") ?? "").split(",").map(name => name.trim()).filter(Boolean) : null;
  const declaredKeys = [...declared.slots].sort(([a], [b]) => a.localeCompare(b)).map(([key, triggers]) => ({ key, triggers, forwarded: forward === null ? null : forward.includes(key) }));
  // An unread forward list is said once, so no line reads as spent where this host may refuse it.
  const view = declaredKeysView({ declaredKeys, declaredNotes: [...declared.notes, ...(forward === null && declaredKeys.length > 0 ? ["forward-unread"] : [])] });
  return { ...inventory, declaredKeys: [...view.slots].map(([key, row]) => ({ key, ...row })), declaredNotes: view.notes };
}

/** Rebuild every field before page/role caches; injected DTOs cannot smuggle a key or help URL. */
export function providerInventoryView(raw) {
  const rows = (Array.isArray(raw?.rows) ? raw.rows : []).slice(0, 128).flatMap(row => {
    const provider = id(row?.provider);
    if (!provider) return [];
    const key = providerCanonicalKey(provider);
    return [{ provider, key, providers: key ? [...PROVIDER_SLOT_ALIASES[key]] : [provider], usage: USAGE.filter(why => Array.isArray(row.usage) && row.usage.includes(why)), present: typeof row.present === "boolean" ? row.present : null, source: SOURCES.includes(row.source) ? row.source : "unknown", status: STATUSES.includes(row.status) ? row.status : "unknown", mode: key && !needsHostAuthentication(provider) && row.status === "configured" && row.present === true && row.mode === "replace" ? "replace" : key && !needsHostAuthentication(provider) && row.status === "missing" && row.present === false && row.mode === "add" ? "add" : null, reason: Object.hasOwn(PROVIDER_KEY_REASONS, row.reason) ? row.reason : null }];
  });
  const choices = (Array.isArray(raw?.choices) ? raw.choices : []).slice(0, Object.keys(PROVIDER_KEY_NAMES).length).flatMap(row => known(row?.provider) ? [{ provider: row.provider, key: providerCanonicalKey(row.provider), providers: providerCanonicalKey(row.provider) ? [...PROVIDER_SLOT_ALIASES[providerCanonicalKey(row.provider)]] : [row.provider], mode: "add", supported: Boolean(providerCanonicalKey(row.provider)) && !needsHostAuthentication(row.provider) }] : []);
  return { state: ["ready", "partial", "unknown"].includes(raw?.state) ? raw.state : "unknown", defaultProvider: id(raw?.defaultProvider), rows, choices };
}
