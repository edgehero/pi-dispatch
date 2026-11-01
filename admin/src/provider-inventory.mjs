/** Read-only, value-free provider credential inventory. No provider SDK or host login is loaded. */
import * as nodeFs from "node:fs";
import { resolve, dirname } from "node:path";
import { deploymentServiceEnv } from "@edgehero/pi-dispatch/service-env";
import { providerFrom, settingsFilePath, allowedModelsFrom } from "@edgehero/pi-dispatch/config";
import { readOverlay } from "@edgehero/pi-dispatch/runtime-settings";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { splitModelEntry, providerIdProblem } from "@edgehero/pi-dispatch/model-ref";
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
  let configured = {}, file = {}, environmentUnknown = false, referencesUnknown = false, policyUnknown = false, configurationUnknown = false, defaultProvider = null;
  try {
    const got = (reads.environment ?? deploymentServiceEnv)({ env: {}, dir: root, keys: [...keys, ...allVariables], fs, platform, uid });
    if (unknownRead(got)) throw Error("unknown environment");
    file = got.env ?? {};
    configured = { ...Object.fromEntries(keys.filter(key => typeof env[key] === "string").map(key => [key, env[key]])), ...Object.fromEntries(keys.filter(key => typeof file[key] === "string").map(key => [key, file[key]])) };
  } catch { environmentUnknown = true; }
  try {
    if (environmentUnknown) throw Error();
    const path = resolve(root, settingsFilePath(configured));
    const overlay = reads.settings ? reads.settings(path) : readOverlay(path, { fs: { readFileSync: () => { const text = metadataBytes(path, fs, uid); if (text === null) throw Object.assign(Error(), { code: "ENOENT" }); return text; } } });
    if (overlay?.invalid) throw Error();
    defaultProvider = overlay?.overlay?.provider ?? providerFrom(configured);
    if (!id(defaultProvider)) throw Error();
    use(defaultProvider, "default");
  } catch { configurationUnknown = true; defaultProvider = null; }
  try { for (const entry of allowedModelsFrom(configured) ?? []) model(entry, "allowed-model"); } catch { referencesUnknown = true; }
  try {
    // Paths captured at console startup can name an obsolete file after a host edit.
    // Match the worker/receiver rule: unset defaults here, explicit empty remains invalid.
    const path = configured.PI_TRIGGERS_FILE === "" ? "" : resolve(root, configured.PI_TRIGGERS_FILE ?? "triggers.json");
    const raw = reads.document ? reads.document(path) : metadataBytes(path, fs, uid);
    if (raw === null) throw Error();
    const doc = parseTriggersDocument(typeof raw === "string" ? raw : JSON.stringify(raw), path);
    for (const row of doc.triggers) {
      if (row.run.provider) use(row.run.provider, "trigger");
      for (const entry of row.run.models ?? []) model(entry, "allowed-model");
      for (const entry of row.run.fallbackModels ?? []) model(entry, "fallback");
    }
    for (const scope of Object.values(doc.modelRoles)) for (const role of Object.values(scope)) {
      model(typeof role === "string" ? role : role.model, "role");
      if (typeof role !== "string") for (const entry of role.fallbackModels ?? []) model(entry, "fallback");
    }
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
  return providerInventoryView({ state: environmentUnknown || policyUnknown || configurationUnknown ? "unknown" : referencesUnknown ? "partial" : "ready", defaultProvider, rows, choices });
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
