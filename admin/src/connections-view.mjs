import { readProviderInventory, providerInventoryView } from "./provider-inventory.mjs";
import { readSubscriptionAuthView, subscriptionAuthForAgent } from "./subscription-auth-view.mjs";
/** Display-only deployment facts (#751). Raw environment values never leave this reader. */
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { deploymentServiceEnv } from "@edgehero/pi-dispatch/service-env";
import { parseAllowlist } from "@edgehero/pi-dispatch/egress-allowlist";
import { egressArmed } from "@edgehero/pi-dispatch/egress";
import { isPerMachineHost } from "@edgehero/pi-dispatch/backends";
import { loadModelEndpoints, MAX_SLOTS, MODEL_ENDPOINT_ID_RE } from "@edgehero/pi-dispatch/model-endpoints";
import { EXACT_VERSION_RE, NPM_NAME_RE } from "@edgehero/pi-dispatch/packages";
import { MCP_SERVER_NAME_RE } from "@edgehero/pi-dispatch/mcp-config";
import { modelEndpointsFilePath, positiveInt, providerFrom, workerName } from "@edgehero/pi-dispatch/config";
import { providerKeyNames as providerKeyCandidates } from "./provider-key-names.mjs";
import { endpointSlotKey, hash16 } from "@edgehero/pi-dispatch/fleet-lease";
import { makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { FORGES } from "@edgehero/pi-dispatch/forges";
import { doctorHostsOf, doctorStale } from "./doctor-view.mjs";
import { PANEL_SERVICE_KEYS } from "./read-model.mjs";
import { DOLLAR_ENV_NAMES } from "@edgehero/pi-dispatch/money";

/** A closed display vocabulary: arbitrary strings, even numeric-looking secrets, are never printed. */
export const CONNECTION_ENV_TYPES = Object.freeze({
  ...Object.fromEntries(PANEL_SERVICE_KEYS.map((key) => [key, /(?:_FILE|_DIR)$|^(?:TMPDIR|TEMP)$/.test(key) ? "path" : Object.values(DOLLAR_ENV_NAMES).includes(key) ? "decimal" : "present"])),
  RECEIVER_PORT: "port", RECEIVER_BIND: "present", GITHUB_AUTH_SOURCE: ["app", "pat", "gh"],
  WEBHOOK_SECRET: "present", GITHUB_PAT: "present", GITHUB_APP_ID: "present", GITHUB_APP_PRIVATE_KEY_PATH: "path", GITHUB_APP_INSTALLATION_ID: "present",
  GITLAB_WEBHOOK_MODE: ["signature", "token"], GITLAB_WEBHOOK_SECRET: "present", GITLAB_TOKEN: "present", GITLAB_URL: "present",
  FORGEJO_WEBHOOK_SECRET: "present", FORGEJO_TOKEN: "present", FORGEJO_URL: "present", FORGEJO_BOT_ID: "present", FORGEJO_PERMISSION_TOKEN: "present",
  AZURE_WEBHOOK_MODE: ["basic", "header"], AZURE_WEBHOOK_SECRET: "present", AZURE_WEBHOOK_HEADER: "present", AZURE_TOKEN: "present", AZURE_ORG_URL: "present",
  POLL_REPOS: "present", POLL_INTERVAL_SECONDS: "integer", PI_EGRESS: ["0", "1"], PI_BACKENDS: "venues",
  PI_MODEL_ENDPOINTS_FILE: "path", PI_PROVIDER: "present", PI_MODEL: "present", PI_ALLOWED_MODELS: "present", PI_AUTH_FROM_PI: ["0", "1"],
  // Credential-store and auth-policy locations remain presence-only, including their basenames.
  PI_AUTH_CONNECTIONS_FILE: "present", PI_AUTH_STORE_DIR: "present",
  PI_ON_FAILURE: "path", PI_ON_FAILURE_TIMEOUT_MS: "integer", PI_FORWARD_ENV: "present", PI_SECRET_PROFILES: "present", PI_SECRET_BUNDLES: "present", PI_SECRET_RESOLVER_ROOTS: "present",
  PI_CONCURRENCY: "integer", PI_JOB_MEMORY: "memory", PI_JOB_CPUS: "decimal", PI_MAX_TURNS: "integer", PI_MAX_TOKENS: "integer", PI_MAX_COST_USD: "decimal",
  PI_MAX_JOBS_PER_DAY: "integer", PI_MAX_JOBS_PER_WEEK: "integer", PI_MAX_JOBS_PER_MONTH: "integer", PI_MAX_TOKENS_PER_DAY: "integer",
  PI_MAX_USD_PER_DAY: "decimal", PI_MAX_USD_PER_WEEK: "decimal", PI_MAX_USD_PER_MONTH: "decimal", VALKEY_URL: "present",
});
export const FORGE_ACTIVATION_KEYS = Object.freeze({
  github: ["GITHUB_AUTH_SOURCE"], gitlab: ["GITLAB_WEBHOOK_MODE", "GITLAB_WEBHOOK_SECRET", "GITLAB_TOKEN"],
  forgejo: ["FORGEJO_WEBHOOK_SECRET", "FORGEJO_TOKEN", "FORGEJO_URL"], azure: ["AZURE_WEBHOOK_MODE", "AZURE_WEBHOOK_SECRET", "AZURE_TOKEN", "AZURE_ORG_URL"],
});
const ROUTES = Object.freeze({ github: "/", gitlab: "/gitlab", forgejo: "/forgejo", azure: "/azure" });
const ACCESS = Object.freeze({ github: "write access", gitlab: "Developer or above", forgejo: "write access", azure: "project group membership" });
const has = (env, key) => typeof env?.[key] === "string" && env[key] !== "";
const nonblank = (env, key) => has(env, key) && env[key].trim() !== "";
const basename = (p) => `.../${String(p).split(/[\\/]/).filter(Boolean).at(-1) ?? "resolver"}`;
const safeName = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(v) ? v : null;
const positive = (v, dflt) => typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) > 0 ? Number(v) : dflt;
const CAP_KEY = /^(?:PI_MAX_|PI_CONCURRENCY|PI_JOB_)/;
// The file parser stores DNS names lowercase. Normalize again at the model boundary before the worker's helper,
// so a hostile DTO cannot disguise a per-machine alias with uppercase and claim a fleet zero.
const endpointCounting = (host, fleetDeclared) => isPerMachineHost(typeof host === "string" ? host.toLowerCase() : host) ? "per-machine" : fleetDeclared === true ? "fleet" : fleetDeclared === false ? "worker-name-absent" : "unknown";

function endpointFleetDeclaration(env, unknown) {
  if (unknown) return null;
  if (!has(env, "PI_WORKER_NAME")) return false;
  try { workerName(env); return true; } catch { return null; }
}

export function connectionEnvValue(key, raw, type = CONNECTION_ENV_TYPES[key]) {
  if (typeof raw !== "string") return (CAP_KEY.test(key) || Object.values(DOLLAR_ENV_NAMES).includes(key)) ? "unknown (worker env or default)" : "not set";
  if (type === "path") return raw === "" ? "not set" : basename(raw);
  if (key === "PI_EGRESS" && raw === "") return "empty (on by default)";
  if (Array.isArray(type)) return type.includes(raw) ? raw : "set (invalid option)";
  if (type === "integer" || type === "port") return /^\d{1,9}$/.test(raw) && (type !== "port" || Number(raw) >= 1 && Number(raw) <= 65535) ? raw : "set (invalid number)";
  if (type === "decimal") return /^\d{1,9}(?:\.\d{1,6})?$/.test(raw) ? raw : "set (invalid number)";
  if (type === "memory") return /^\d{1,9}(?:[bkmg])?$/i.test(raw) ? raw : "set (invalid size)";
  if (type === "venues") return /^(?:local|podman|openshell|openshell-bind)(?:,(?:local|podman|openshell|openshell-bind))*$/.test(raw) ? raw : "set (invalid venues)";
  return raw === "" ? "not set" : "set";
}

/** Only PTTL, never lease holders or writes. Checking all legal indexes also counts a slot held before a cap shrank. */
export async function readEndpointSlots(redis, endpoints, { timeoutMs = 2500 } = {}) {
  if (!endpoints.length) return [];
  let timer;
  try {
    const pipe = redis.pipeline();
    for (const ep of endpoints) for (let i = 0; i < MAX_SLOTS; i++) pipe.pttl(endpointSlotKey(hash16(ep.id), i));
    const result = await Promise.race([pipe.exec(), new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
    if (!Array.isArray(result) || result.length !== endpoints.length * MAX_SLOTS) return endpoints.map(() => null);
    return endpoints.map((_, n) => {
      const slots = result.slice(n * MAX_SLOTS, (n + 1) * MAX_SLOTS);
      if (slots.some((r) => !Array.isArray(r) || r[0] || !Number.isInteger(r[1]) || r[1] < -2 || r[1] === -1)) return null;
      return slots.filter((r) => r[1] >= 0).length;
    });
  } catch { return endpoints.map(() => null); }
  finally { clearTimeout(timer); }
}

/** Mirrors receiver activation, pinned against its real loader in connections-view.test.mjs. */
export function forgeConnections(env, triggers, { unknown = false } = {}) {
  const list = Array.isArray(triggers) ? triggers : [];
  return Object.keys(FORGES).map((name) => {
    const rows = list.filter((t) => t.forge === name && t.type !== "cron" && t.type !== "watch" && !t.disarmed).map((t) => t.index).filter(Number.isInteger);
    const keys = FORGE_ACTIVATION_KEYS[name].filter((key) => has(env, key));
    const enabled = unknown ? null : keys.length > 0 || name === "github" && rows.length > 0 ? true : !Array.isArray(triggers) && name === "github" ? null : false;
    const source = name === "github" ? (["app", "gh", "pat"].includes(env.GITHUB_AUTH_SOURCE) ? env.GITHUB_AUTH_SOURCE : has(env, "GITHUB_AUTH_SOURCE") ? "invalid" : "gh (default)") : "shared token";
    const auth = name === "github" ? source === "app" ? "GitHub App; a short-lived token for the one repository" : source === "pat" ? "GITHUB_PAT; the host's own token" : source === "invalid" ? "GITHUB_AUTH_SOURCE is invalid; the receiver cannot start" : "gh; the host's own token" : `${name === "azure" ? "AZURE" : name.toUpperCase()}_TOKEN; one shared token`;
    const mode = name === "gitlab" ? env.GITLAB_WEBHOOK_MODE : name === "azure" ? env.AZURE_WEBHOOK_MODE : "hmac";
    const verification = name === "github" || name === "forgejo" ? "HMAC-SHA256" : name === "gitlab" ? mode === "signature" ? "HMAC signature (GitLab 19.0+)" : mode === "token" ? "X-Gitlab-Token; shared secret, no body integrity" : "GITLAB_WEBHOOK_MODE must be signature or token" : mode === "basic" ? "HTTP Basic; shared secret, no body integrity" : mode === "header" ? "Configured header; shared secret, no body integrity" : "AZURE_WEBHOOK_MODE must be basic or header";
    const secretKey = name === "github" ? "WEBHOOK_SECRET" : `${name.toUpperCase()}_WEBHOOK_SECRET`;
    return { name, path: ROUTES[name], enabled, triggers: rows, activationKeys: keys, source, auth, verification, secret: { key: secretKey, set: unknown ? null : nonblank(env, secretKey) }, deliveryId: FORGES[name].deliveryIdName, access: ACCESS[name], polling: name === "github" ? githubPolling(env, source, unknown) : null };
  });
}

/** The poller's own repository/default/floor rules; configured polling does not prove a process is running. */
function githubPolling(env, auth, unknown) {
  const unread = { state: "unknown", repos: [], source: null, seconds: null };
  if (unknown || auth === "invalid") return unread;
  const raw = env.POLL_REPOS;
  const declared = typeof raw === "string" && raw.trim() !== "";
  const repos = declared ? [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))] : [];
  // Do not turn a rejected repository declaration into an apparently empty, healthy poller.
  if (declared && (repos.length === 0 || repos.some((repo) => !/^[^\s/]+\/[^\s/]+$/.test(repo)))) return unread;
  if (!declared && auth !== "app") return { state: "off", repos: [], source: null, seconds: null };
  let seconds;
  try { seconds = Math.max(30, positiveInt(env, "POLL_INTERVAL_SECONDS", 60)); } catch { return unread; }
  return { state: "on", repos: repos.slice(0, 32), source: declared ? "POLL_REPOS" : "app-installation", seconds };
}

function doctorFacts(snapshot) {
  const rows = doctorHostsOf(snapshot);
  const names = [...new Set([...(snapshot?.hostBudgets ?? []).map((h) => h.name), ...rows.map((h) => h.name)])].filter((n) => typeof n === "string");
  return names.map((name) => {
    const row = rows.find((r) => r.name === name);
    const checks = row?.unreadable ? [] : row?.checks ?? [];
    return { name, at: Number.isFinite(row?.at) ? row.at : null, ageMs: Number.isFinite(row?.ageMs) ? row.ageMs : null, stale: doctorStale(row), unreadable: !row || Boolean(row.unreadable), proxy: checks.find((c) => /^egress\.proxy(?:-\d+)?$/.test(c.id)) ?? null, forge: checks.filter((c) => /^(?:github|forges)\./.test(c.id) && c.level === "fail"), endpoints: checks.find((c) => c.id === "model-endpoints.file" && c.level !== "ok") ?? null };
  });
}

export function connectionsProblems(hosts, runs = [], forges = []) {
  const problems = [];
  for (const host of hosts) {
    if (host.proxy?.level === "fail") {
      const run = runs.filter((r) => r.host === host.name && ["egress-proxy-missing", "egress-proxy-stopped"].includes(r.reason)).sort((a, b) => Date.parse(b.endedAt ?? b.startedAt) - Date.parse(a.endedAt ?? a.startedAt))[0];
      problems.push({ kind: "proxy", host: host.name, title: `Refused on ${host.name}: its egress proxy is not running`, text: host.proxy.label ?? "The host's doctor says its egress proxy is unavailable.", fix: "Run pi-dispatch up on that host.", run: typeof run?.jobId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(run.jobId) ? run.jobId : null });
    }
    for (const check of host.forge) problems.push({ kind: "forge", host: host.name, title: `Forge connection failing on ${host.name}`, text: check.label ?? "The host's forge check failed.", fix: check.fix ?? "Check the forge credentials with doctor on that host.", run: null });
    if (host.endpoints) problems.push({ kind: "endpoints", host: host.name, title: `${host.name} reads its own model-endpoints file, and it does not load`, text: host.endpoints.label ?? "The host's endpoints file does not load.", fix: host.endpoints.fix ?? "Correct model-endpoints.json on that host, then render its egress rules.", run: null });
  }
  if (forges.some((forge) => forge.name === "github" && forge.enabled === true && forge.secret?.set === false)) problems.push({ kind: "receiver", host: null, title: "GitHub receiver needs WEBHOOK_SECRET", text: "WEBHOOK_SECRET is not set in the deployment's .env. The receiver refuses to start unless its service environment sets it.", fix: "Set WEBHOOK_SECRET for the receiver, then restart it.", run: null });
  return problems.sort((a, b) => ["proxy", "receiver", "forge", "endpoints"].indexOf(a.kind) - ["proxy", "receiver", "forge", "endpoints"].indexOf(b.kind));
}

/** Injected sources make every exceptional state independent; no metadata read changes a capability or worker env. */
export async function readConnections({ deploymentDir, env = {}, paths = {}, snapshot = null, fs = nodeFs, now = Date.now(), redis = null, redisFn = makeRedisClient, reads = {}, platform = process.platform, uid = process.geteuid?.() } = {}) {
  let file = {};
  let metadata = null;
  try {
    metadata = (reads.environment ?? deploymentServiceEnv)({ env: {}, dir: deploymentDir, keys: Object.keys(CONNECTION_ENV_TYPES), fs, platform, uid });
    file = metadata?.env ?? {};
  } catch { metadata = { unreadable: true }; }
  const environmentUnknown = !metadata || Boolean(metadata.unreadable || metadata.untrusted || metadata.hazard || metadata.unread?.length || metadata.hazardSkipped?.length);
  const incompleteKeys = new Set([...(metadata?.unread ?? []).map((r) => r.key), ...(metadata?.hazardSkipped ?? [])]);
  const triggers = snapshot?.triggers?.triggers;
  let defaultProvider = null;
  try { defaultProvider = snapshot?.settings?.overlay?.provider ?? providerFrom(file); } catch { /* The declaration remains shown as set; no malformed provider enters a source lookup. */ }
  const providerNames = [...new Set([defaultProvider, ...(triggers ?? []).map((t) => t.provider)].filter((p) => safeName(p)))];
  // Discover key names through pi's pinned table, then read presence only from the same trusted file.
  const providerVars = [...new Set(providerNames.flatMap(providerKeyCandidates))];
  let providerEnv = file;
  let providerUnknown = environmentUnknown;
  if (providerVars.length) {
    try {
      const providerMeta = (reads.environment ?? deploymentServiceEnv)({ env: {}, dir: deploymentDir, keys: providerVars, fs, platform, uid });
      providerUnknown = !providerMeta || Boolean(providerMeta.unreadable || providerMeta.untrusted || providerMeta.hazard || providerMeta.unread?.length || providerMeta.hazardSkipped?.length);
      providerEnv = providerUnknown ? {} : providerMeta.env ?? {};
    } catch { providerEnv = {}; providerUnknown = true; }
  }
  const environment = [...Object.keys(CONNECTION_ENV_TYPES), ...providerVars].map((key) => ({ key, value: (providerVars.includes(key) ? providerUnknown : environmentUnknown && !Object.hasOwn(file, key) || incompleteKeys.has(key)) ? "unknown (deployment metadata unreadable)" : connectionEnvValue(key, providerVars.includes(key) ? providerEnv[key] : file[key], providerVars.includes(key) ? "present" : CONNECTION_ENV_TYPES[key]), disagrees: typeof env[key] === "string" && typeof (providerVars.includes(key) ? providerEnv[key] : file[key]) === "string" && env[key] !== (providerVars.includes(key) ? providerEnv[key] : file[key]) }));
  let allowlist = null;
  try { allowlist = (reads.allowlist ?? (() => parseAllowlist(fs.readFileSync(join(deploymentDir, "egress-allowlist.conf"), "utf8"))))(); } catch { /* Unknown, not an empty policy. */ }
  let endpoints = null;
  try { endpoints = (reads.endpoints ?? (() => loadModelEndpoints({ modelEndpointsFile: modelEndpointsFilePath(file), valkeyUrl: file.VALKEY_URL ?? paths.valkeyUrl }, { cwd: deploymentDir, readFileSync: fs.readFileSync, existsSync: fs.existsSync })))(); } catch { /* One refused source must not erase the forges or MCP. */ }
  let owned = null;
  const endpointFleetDeclared = endpointFleetDeclaration(file, environmentUnknown);
  // The worker takes fleet leases only with a declared host queue, and never for a per-machine alias. Reading
  // absent fleet keys in those cases would invent zero usage while the in-process slots may all be held.
  const fleetEndpoints = Array.isArray(endpoints) ? endpoints.filter((ep) => endpointCounting(ep.host, endpointFleetDeclared) === "fleet") : [];
  const slots = new Map();
  if (fleetEndpoints.length) {
    try {
      const client = redis ?? (owned = redisFn(paths.valkeyUrl));
      const counted = await (reads.slots ?? readEndpointSlots)(client, fleetEndpoints);
      for (const [index, endpoint] of fleetEndpoints.entries()) slots.set(endpoint.id, Number.isInteger(counted?.[index]) ? counted[index] : null);
    } catch { /* Fleet occupancy is unknown; the declared slots and counting scope remain readable. */ }
    finally { try { owned?.disconnect(); } catch {} }
  }
  const hosts = doctorFacts(snapshot);
  let egressOn = null;
  let egressProblem = null;
  if (!environmentUnknown) {
    try { egressOn = egressArmed(file); }
    catch { egressProblem = "PI_EGRESS must be unset, empty, 0 or 1; the worker refuses to start until it is corrected."; }
  }
  const mcp = snapshot?.overlayMcp ?? null;
  const packages = snapshot?.stagedPackages ?? null;
  const forges = forgeConnections(file, triggers, { unknown: environmentUnknown });
  const loginFallback = environmentUnknown ? null : file.PI_AUTH_FROM_PI !== "0";
  const subscriptionAuth = await readSubscriptionAuthView({ snapshot, read: reads.subscriptionAuth, now });
  return {
    now, environmentUnknown, environment, subscriptionAuth,
    providerKeys: readProviderInventory({ deploymentDir, env, paths, snapshot, fs, platform, uid, reads: reads.providerInventory ?? { environment: reads.environment } }),
    receiver: { port: positive(file.RECEIVER_PORT, 3000), unknown: environmentUnknown },
    forges,
    egress: { on: egressOn, problem: egressProblem, allowlist: Array.isArray(allowlist) ? allowlist.slice(0, 8) : null, more: Array.isArray(allowlist) ? Math.max(0, allowlist.length - 8) : 0, hosts },
    endpointFleetDeclared,
    endpoints: Array.isArray(endpoints) ? endpoints.map((ep) => ({ id: ep.id, host: ep.host, port: ep.port, keyless: ep.keyless, slots: ep.slots, counting: endpointCounting(ep.host, endpointFleetDeclared), used: slots.get(ep.id) ?? null })) : null,
    providers: providerNames.map((name) => {
      const variables = providerKeyCandidates(name);
      // The worker forwards every truthy candidate in pi's pinned precedence order; no value leaves this reader.
      const fromEnv = variables.filter((key) => has(providerEnv, key));
      const selectedVariable = providerUnknown ? null : fromEnv[0] ?? null;
      return { name, unknown: providerUnknown, variables, fromEnv, selectedVariable, credentialSource: selectedVariable ? "deployment-env" : providerUnknown || loginFallback === null ? "unknown" : loginFallback ? "pi-login" : "worker-env", loginFallback, fallback: environmentUnknown ? "the deployment’s provider credential fallback is unknown" : loginFallback ? "pi login on each host is the configured fallback; actual credentials are not published here" : "pi login disabled by PI_AUTH_FROM_PI=0; each worker needs its environment key" };
    }),
    notify: { hook: nonblank(file, "PI_ON_FAILURE") ? basename(file.PI_ON_FAILURE) : null, timeoutMs: positive(file.PI_ON_FAILURE_TIMEOUT_MS, 10_000), triggers: (triggers ?? []).filter((t) => t.statusComment === true).map((t) => t.index).filter(Number.isInteger), unknown: environmentUnknown },
    mcp, packages, packageOptOuts: Array.isArray(triggers) ? triggers.filter((t) => t.packages === false).length : null,
    problems: connectionsProblems(hosts, snapshot?.runs ?? [], forges), snapshotUnreadable: snapshot === null,
  };
}

/** Model context gets source key NAMES and counts, never manager variable names, paths, free doctor text or refs. */
export function modelConnections(view) {
  const name = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v) ? v : null;
  const mcpName = (v) => typeof v === "string" && MCP_SERVER_NAME_RE.test(v);
  const refusedMcpNames = Array.isArray(view?.mcp?.refused) ? view.mcp.refused : [];
  const invalidMcpNameCount = Number.isSafeInteger(view?.mcp?.invalidNameCount) && view.mcp.invalidNameCount >= 0 ? view.mcp.invalidNameCount : refusedMcpNames.filter((n) => !mcpName(n)).length;
  const key = (v) => typeof v === "string" && /^[A-Z_][A-Z0-9_]*$/.test(v);
  const providers = (view?.providers ?? []).filter((p) => name(p.name)).map((p) => {
    const variables = providerKeyCandidates(p.name).filter(key);
    const fromEnv = variables.filter((candidate) => (p.fromEnv ?? []).includes(candidate));
    const loginFallback = typeof p.loginFallback === "boolean" ? p.loginFallback : null;
    const selectedVariable = p.unknown === true ? null : fromEnv[0] ?? null;
    return { name: p.name, variables, fromEnv, selectedVariable, credentialSource: selectedVariable ? "deployment-env" : p.unknown === true || loginFallback === null ? "unknown" : loginFallback ? "pi-login" : "worker-env", loginFallback, unknown: p.unknown === true, piLoginFallback: loginFallback ?? (typeof p.fallback === "string" && p.fallback.startsWith("pi login on")) };
  });
  const providerKeys = new Set(providers.flatMap((p) => p.variables));
  const packages = (view?.packages?.packages ?? []).filter((p) => {
    if (typeof p !== "string") return false;
    const at = p.lastIndexOf("@");
    return NPM_NAME_RE.test(at > 0 ? p.slice(0, at) : p) && (at <= 0 || EXACT_VERSION_RE.test(p.slice(at + 1)));
  });
  return {
    subscriptionAuth: subscriptionAuthForAgent(view?.subscriptionAuth),
    forges: (view?.forges ?? []).filter((f) => Object.hasOwn(FORGES, f.name)).map((f) => ({ name: f.name, configured: typeof f.enabled === "boolean" ? f.enabled : null, path: ROUTES[f.name], authSource: ["app", "gh", "pat", "gh (default)", "invalid", "shared token"].includes(f.source) ? f.source : "unknown", activationKeys: (f.activationKeys ?? []).filter((k) => FORGE_ACTIVATION_KEYS[f.name].includes(k)), secret: { key: f.name === "github" ? "WEBHOOK_SECRET" : `${f.name.toUpperCase()}_WEBHOOK_SECRET`, set: typeof f.secret?.set === "boolean" ? f.secret.set : null }, triggerCount: (f.triggers ?? []).filter((i) => Number.isSafeInteger(i) && i >= 0).length })),
    egress: { on: typeof view?.egress?.on === "boolean" ? view.egress.on : null, hosts: (view?.egress?.hosts ?? []).filter((h) => name(h.name)).map((h) => ({ name: h.name, state: h.unreadable ? "unknown" : ["ok", "warn", "fail"].includes(h.proxy?.level) ? h.proxy.level : "not-published", stale: h.stale === true })) },
    endpoints: Array.isArray(view?.endpoints) ? view.endpoints.filter((ep) => typeof ep.id === "string" && MODEL_ENDPOINT_ID_RE.test(ep.id)).map((ep) => {
      const host = typeof ep.host === "string" && /^[A-Za-z0-9.:[\]-]+$/.test(ep.host) ? ep.host : null;
      const counting = host === null ? "unknown" : endpointCounting(host, view.endpointFleetDeclared);
      return { id: ep.id, host, port: Number.isInteger(ep.port) && ep.port >= 1 && ep.port <= 65535 ? ep.port : null, keyless: ep.keyless === true, slots: Number.isInteger(ep.slots) && ep.slots >= 1 && ep.slots <= MAX_SLOTS ? ep.slots : null, counting, used: counting === "fleet" && Number.isInteger(ep.used) && ep.used >= 0 && ep.used <= MAX_SLOTS ? ep.used : null };
    }) : null,
    providers,
    providerKeys: providerInventoryView(view?.providerKeys),
    mcp: { servers: (view?.mcp?.servers ?? []).filter((s) => mcpName(s.name)).map((s) => ({ name: s.name, transport: ["http", "stdio"].includes(s.transport) ? s.transport : null, enabled: s.enabled === true, referenceCount: Array.isArray(s.refs) ? s.refs.length : 0 })), refused: refusedMcpNames.filter(mcpName), invalidNameCount: invalidMcpNameCount, unreadable: !view?.mcp || Boolean(view.mcp.unreadable) },
    packages: { names: packages, stagedAt: typeof view?.packages?.stagedAt === "string" && Number.isFinite(Date.parse(view.packages.stagedAt)) ? new Date(view.packages.stagedAt).toISOString() : null, unreadable: !view?.packages || Boolean(view.packages.unreadable) },
    deployment: (view?.environment ?? []).filter((e) => Object.hasOwn(CONNECTION_ENV_TYPES, e.key) || providerKeys.has(e.key)).map((e) => ({ key: e.key, set: typeof e.value === "string" && !e.value.startsWith("not set") && !e.value.startsWith("unknown"), unknown: typeof e.value !== "string" || e.value.startsWith("unknown"), disagrees: e.disagrees === true })),
  };
}
