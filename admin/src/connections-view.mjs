import { readEndpointStatus, ENDPOINT_STATUS_HOSTS_MAX } from "@edgehero/pi-dispatch/endpoint-status";
import { WORKER_NAME_RE } from "@edgehero/pi-dispatch/config";
import { readProviderInventory, providerInventoryView } from "./provider-inventory.mjs";
import { readReceiverStatus, parseReceiverStatus, receiverForgeFacts, RECEIVER_FORGES, RECEIVER_OUTCOMES } from "@edgehero/pi-dispatch/receiver-status";
import { pollerExpected, readPollerStatus } from "@edgehero/pi-dispatch/poller-status";
import { readSubscriptionAuthView, subscriptionAuthForAgent } from "./subscription-auth-view.mjs";
/** Display-only deployment facts (#751). Raw environment values never leave this reader. */
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { deploymentServiceEnv } from "@edgehero/pi-dispatch/service-env";
import { parseAllowlist } from "@edgehero/pi-dispatch/egress-allowlist";
import { egressArmed } from "@edgehero/pi-dispatch/egress";
import { isPerMachineHost } from "@edgehero/pi-dispatch/backends";
import { loadModelEndpoints, MAX_SLOTS, MODEL_ENDPOINT_ID_RE } from "@edgehero/pi-dispatch/model-endpoints";
import { loadPrivateEndpoints, privateEndpointsPath } from "@edgehero/pi-dispatch/private-endpoints";
import { EXACT_VERSION_RE, NPM_NAME_RE } from "@edgehero/pi-dispatch/packages";
import { MCP_SERVER_NAME_RE } from "@edgehero/pi-dispatch/mcp-config";
import { GITHUB_INGEST_VALUES, githubIngestFrom, modelEndpointsFilePath, positiveInt, providerFrom, workerName } from "@edgehero/pi-dispatch/config";
import { providerKeyNames as providerKeyCandidates } from "./provider-key-names.mjs";
import { endpointSlotKey, hash16 } from "@edgehero/pi-dispatch/fleet-lease";
import { makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { FORGES } from "@edgehero/pi-dispatch/forges";
import { doctorHostsOf, doctorStale } from "./doctor-view.mjs";
import { PANEL_SERVICE_KEYS } from "./read-model.mjs";
import { DOLLAR_ENV_NAMES } from "@edgehero/pi-dispatch/money";
import { readHookRuns, hookRunsView } from "@edgehero/pi-dispatch/hook-runs";
import { fileCaseOfView } from "./file-case.mjs";

/** A closed display vocabulary: arbitrary strings, even numeric-looking secrets, are never printed. */
export const CONNECTION_ENV_TYPES = Object.freeze({
  ...Object.fromEntries(PANEL_SERVICE_KEYS.map((key) => [key, /(?:_FILE|_DIR)$|^(?:TMPDIR|TEMP)$/.test(key) ? "path" : Object.values(DOLLAR_ENV_NAMES).includes(key) ? "decimal" : "present"])),
  RECEIVER_PORT: "port", RECEIVER_BIND: "present", GITHUB_AUTH_SOURCE: ["app", "pat", "gh"], GITHUB_INGEST: GITHUB_INGEST_VALUES,
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
  github: ["GITHUB_AUTH_SOURCE", "GITHUB_INGEST"], gitlab: ["GITLAB_WEBHOOK_MODE", "GITLAB_WEBHOOK_SECRET", "GITLAB_TOKEN"],
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
  // The receiver reads an empty GITHUB_INGEST as unset (`githubIngestFrom`), so it is not an invalid option here.
  if (key === "GITHUB_INGEST" && raw === "") return "not set";
  if (Array.isArray(type)) return type.includes(raw) ? raw : "set (invalid option)";
  if (type === "integer" || type === "port") return /^\d{1,9}$/.test(raw) && (type !== "port" || Number(raw) >= 1 && Number(raw) <= 65535) ? raw : "set (invalid number)";
  if (type === "decimal") return /^\d{1,9}(?:\.\d{1,6})?$/.test(raw) ? raw : "set (invalid number)";
  if (type === "memory") return /^\d{1,9}(?:[bkmg])?$/i.test(raw) ? raw : "set (invalid size)";
  if (type === "venues") return /^(?:local|podman|openshell|openshell-bind)(?:,(?:local|podman|openshell|openshell-bind))*$/.test(raw) ? raw : "set (invalid venues)";
  return raw === "" ? "not set" : "set";
}

/**
 * How long each publication read of this view may take: the readers' own bounds, named here because a page hands a
 * reader its bound or what is left of the page's deadline, whichever is sooner (`readConnections`' `within`).
 */
export const PUBLICATION_READ_MS = Object.freeze({ endpointStatus: 2_500, slots: 2_500, receivers: 2_000, pollers: 2_000, hookRuns: 2_000 });

/** Only PTTL, never lease holders or writes. Checking all legal indexes also counts a slot held before a cap shrank. */
export async function readEndpointSlots(redis, endpoints, { timeoutMs = PUBLICATION_READ_MS.slots } = {}) {
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

/**
 * Which transport carries GitHub here, as the receiver reads GITHUB_INGEST (issue #879): one of its three words,
 * `inferred` when it is unset (the receiver then decides from the triggers and GITHUB_AUTH_SOURCE), or `invalid` for a
 * value every receiver command refuses to start on. The parse is the receiver's own, so the two cannot read a word apart.
 */
function githubIngestState(env) {
  try { return githubIngestFrom(env ?? {}) ?? "inferred"; } catch { return "invalid"; }
}

/** Mirrors receiver activation, pinned against its real loader in connections-view.test.mjs. */
export function forgeConnections(env, triggers, { unknown = false } = {}) {
  const list = Array.isArray(triggers) ? triggers : [];
  return Object.keys(FORGES).map((name) => {
    const rows = list.filter((t) => t.forge === name && t.type !== "cron" && t.type !== "watch" && !t.disarmed).map((t) => t.index).filter(Number.isInteger);
    const ingest = name !== "github" || unknown ? null : githubIngestState(env);
    // A set GITHUB_INGEST is the receiver's whole answer for GitHub, so it is the one activation key then: `poll` arms no
    // route whatever the rules and auth source say, and `webhook` or `both` arms it with none (issue #879).
    const keys = ingest !== null && ingest !== "inferred" ? ["GITHUB_INGEST"] : FORGE_ACTIVATION_KEYS[name].filter((key) => has(env, key));
    const enabled = unknown ? null : ingest === "poll" ? false : keys.length > 0 || name === "github" && rows.length > 0 ? true : !Array.isArray(triggers) && name === "github" ? null : false;
    const source = name === "github" ? (["app", "gh", "pat"].includes(env.GITHUB_AUTH_SOURCE) ? env.GITHUB_AUTH_SOURCE : has(env, "GITHUB_AUTH_SOURCE") ? "invalid" : "gh (default)") : "shared token";
    const auth = name === "github" ? source === "app" ? "GitHub App; a short-lived token for the one repository" : source === "pat" ? "GITHUB_PAT; the host's own token" : source === "invalid" ? "GITHUB_AUTH_SOURCE is invalid; the receiver cannot start" : "gh; the host's own token" : `${name === "azure" ? "AZURE" : name.toUpperCase()}_TOKEN; one shared token`;
    const mode = name === "gitlab" ? env.GITLAB_WEBHOOK_MODE : name === "azure" ? env.AZURE_WEBHOOK_MODE : "hmac";
    const verification = name === "github" || name === "forgejo" ? "HMAC-SHA256" : name === "gitlab" ? mode === "signature" ? "HMAC signature (GitLab 19.0+)" : mode === "token" ? "X-Gitlab-Token; shared secret, no body integrity" : "GITLAB_WEBHOOK_MODE must be signature or token" : mode === "basic" ? "HTTP Basic; shared secret, no body integrity" : mode === "header" ? "Configured header; shared secret, no body integrity" : "AZURE_WEBHOOK_MODE must be basic or header";
    const secretKey = name === "github" ? "WEBHOOK_SECRET" : `${name.toUpperCase()}_WEBHOOK_SECRET`;
    return { name, path: ROUTES[name], enabled, triggers: rows, activationKeys: keys, source, auth, verification, secret: { key: secretKey, set: unknown ? null : nonblank(env, secretKey) }, deliveryId: FORGES[name].deliveryIdName, access: ACCESS[name], polling: name === "github" ? githubPolling(env, source, unknown, ingest) : null, ingest };
  });
}

/** The poller's own repository/default/floor rules; configured polling does not prove a process is running. */
function githubPolling(env, auth, unknown, ingest = "inferred") {
  const unread = { state: "unknown", repos: [], source: null, seconds: null };
  if (unknown || auth === "invalid" || ingest === "invalid") return unread;
  // `poll` refuses to start under GITHUB_INGEST=webhook (issue #879), so it is off however the repositories are named.
  if (ingest === "webhook") return { state: "off", repos: [], source: null, seconds: null };
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
    return { name, at: Number.isFinite(row?.at) ? row.at : null, ageMs: Number.isFinite(row?.ageMs) ? row.ageMs : null, stale: doctorStale(row), unreadable: !row || Boolean(row.unreadable), proxy: checks.find((c) => /^egress\.proxy(?:-\d+)?$/.test(c.id)) ?? null, forge: checks.filter((c) => /^(?:github|forges)\./.test(c.id) && c.level === "fail"), endpoints: checks.find((c) => c.id === "model-endpoints.file" && c.level !== "ok") ?? null, privateFile: checks.find((c) => c.id === "private-endpoints.file" && c.level !== "ok") ?? null };
  });
}

export function connectionsProblems(hosts, runs = [], forges = [], pollers = null) {
  const problems = [];
  for (const host of hosts) {
    if (host.proxy?.level === "fail") {
      const run = runs.filter((r) => r.host === host.name && ["egress-proxy-missing", "egress-proxy-stopped"].includes(r.reason)).sort((a, b) => Date.parse(b.endedAt ?? b.startedAt) - Date.parse(a.endedAt ?? a.startedAt))[0];
      problems.push({ kind: "proxy", host: host.name, title: `Refused on ${host.name}: its egress proxy is not running`, text: host.proxy.label ?? "The host's doctor says its egress proxy is unavailable.", fix: "Run pi-dispatch up on that host.", run: typeof run?.jobId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(run.jobId) ? run.jobId : null });
    }
    for (const check of host.forge) problems.push({ kind: "forge", host: host.name, title: `Forge connection failing on ${host.name}`, text: check.label ?? "The host's forge check failed.", fix: check.fix ?? "Check the forge credentials with doctor on that host.", run: null });
    if (host.endpoints) problems.push({ kind: "endpoints", host: host.name, title: `${host.name} reads its own model-endpoints file, and it does not load`, text: host.endpoints.label ?? "The host's endpoints file does not load.", fix: host.endpoints.fix ?? "Correct model-endpoints.json on that host, then render its egress rules.", run: null });
    // Issue #918: the same, for the host's own private-endpoints file, which its worker refuses to start on.
    if (host.privateFile) problems.push({ kind: "endpoints", host: host.name, title: `${host.name} reads its own private-endpoints file, and it does not load`, text: host.privateFile.label ?? "The host's private endpoints file does not load.", fix: host.privateFile.fix ?? "Correct private-endpoints.json on that host, then render its egress rules.", run: null });
  }
  // Issue #879: a GITHUB_INGEST every receiver command refuses leads alone, since `serve` refuses on it before it asks for
  // WEBHOOK_SECRET; a secret problem beside it would send the operator to the wrong line.
  if (forges.some((forge) => forge.name === "github" && forge.ingest === "invalid")) problems.push({ kind: "receiver", host: null, title: "GITHUB_INGEST is not webhook, poll or both", text: "The deployment's .env sets GITHUB_INGEST to a value every pi-dispatch-receiver command refuses to start on.", fix: "Set GITHUB_INGEST to webhook, poll or both, or delete the line to let the receiver infer it, then restart the receiver's services.", run: null });
  else if (forges.some((forge) => forge.name === "github" && forge.enabled === true && forge.secret?.set === false)) problems.push({ kind: "receiver", host: null, title: "GitHub receiver needs WEBHOOK_SECRET", text: "WEBHOOK_SECRET is not set in the deployment's .env. The receiver refuses to start unless its service environment sets it.", fix: "Set WEBHOOK_SECRET for the receiver, then restart it.", run: null });
  problems.sort((a, b) => ["proxy", "receiver", "forge", "endpoints"].indexOf(a.kind) - ["proxy", "receiver", "forge", "endpoints"].indexOf(b.kind));
  // Issue #970: a poller that refused the current triggers file and polls on the last copy that loaded, by its heartbeat.
  // After every other problem, so each keeps its place; the heartbeat carries no reason, which the host's check gives.
  for (const host of Array.isArray(pollers?.hosts) ? pollers.hosts : []) {
    if (host?.unreadable || host?.triggers !== "kept" || typeof host.name !== "string" || !WORKER_NAME_RE.test(host.name)) continue;
    const what = host.refusal === "missing" ? "found no triggers.json" : host.refusal === "unreadable" ? "could not read triggers.json" : "refused the current triggers.json";
    problems.push({ kind: "poller", host: host.name, title: "The poller runs on an older triggers file", text: `The poller on ${host.name} ${what} and polls with the last copy that loaded, so a trigger added or changed since does not apply to the events it polls.`, fix: "Run pi-dispatch triggers check on that host and correct the file; the poller takes it at its next cycle.", run: null });
  }
  return problems;
}

/** `pollerExpected` over the deployment file's settings, null where it refuses them. */
function pollerExpectedOf(env) {
  try { return pollerExpected(env); } catch { return null; }
}

/**
 * Injected sources make every exceptional state independent; no metadata read changes a capability or worker env.
 *
 * `within` (issue #988) is a page's deadline: `(ownMs) => ms`, a read's own bound or what is left of the deadline when
 * that is sooner. Each publication read takes its bound through it, so on a Valkey that does not answer they end
 * together at the deadline, each as the unknown it already is, and the view is still drawn from the deployment's files.
 * A caller with no deadline passes none, and each reader is then called as before, with no bound named.
 *
 * `files` (issue #1073) is the reader's `fileViews`, which a caller hands where its snapshot failed: the triggers, the
 * settings overlay, the overlay's MCP servers and the staged packages are the deployment's files, so with no snapshot
 * they are drawn from there. What only Valkey holds (the hosts, doctor's records, the runs, the subscriptions) stays
 * unread. With neither, the file sections say the files were not read, as before.
 */
export async function readConnections({ deploymentDir, env = {}, paths = {}, snapshot = null, files = null, fs = nodeFs, now = Date.now(), redis = null, redisFn = makeRedisClient, reads = {}, publications = true, platform = process.platform, uid = process.geteuid?.(), within = null } = {}) {
  const bound = (ownMs) => (typeof within === "function" ? { timeoutMs: within(ownMs) } : {});
  let file = {};
  let metadata = null;
  try {
    metadata = (reads.environment ?? deploymentServiceEnv)({ env: {}, dir: deploymentDir, keys: Object.keys(CONNECTION_ENV_TYPES), fs, platform, uid });
    file = metadata?.env ?? {};
  } catch { metadata = { unreadable: true }; }
  const environmentUnknown = !metadata || Boolean(metadata.unreadable || metadata.untrusted || metadata.hazard || metadata.unread?.length || metadata.hazardSkipped?.length);
  const incompleteKeys = new Set([...(metadata?.unread ?? []).map((r) => r.key), ...(metadata?.hazardSkipped ?? [])]);
  // What the files hold: the snapshot's views, or with no snapshot the file views themselves (issue #1073).
  const held = snapshot ?? (files !== null && typeof files === "object" ? files : null);
  const triggers = held?.triggers?.triggers;
  // The triggers file was read and is refused (issue #988): "does not load", where a file nobody could read "could not be read".
  const triggersRefused = !Array.isArray(triggers) && fileCaseOfView(held?.triggers, "triggers") === "refused";
  let defaultProvider = null;
  try { defaultProvider = held?.settings?.overlay?.provider ?? providerFrom(file); } catch { /* The declaration remains shown as set; no malformed provider enters a source lookup. */ }
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
  // Issue #918: this deployment folder's private endpoints, as its worker loads them. Each host reads its own copy, which
  // no host publishes, so this is the console host's declaration; an id a trigger names that is not declared here is
  // said as such. One that does not load is unknown, never none.
  // The file the worker reads: PI_PRIVATE_ENDPOINTS_FILE from the same trusted .env, read on its own so the environment
  // table keeps its rows; unread or untrusted metadata is unknown, never the default file.
  let privateDeclared = null;
  try {
    privateDeclared = (reads.privateEndpoints ?? (() => {
      const meta = (reads.environment ?? deploymentServiceEnv)({ env: {}, dir: deploymentDir, keys: ["PI_PRIVATE_ENDPOINTS_FILE"], fs, platform, uid });
      if (!meta || meta.unreadable || meta.untrusted || meta.hazard || meta.unread?.length || meta.hazardSkipped?.length) throw new Error("deployment metadata unreadable");
      // Set at all, even empty, is the worker's `?? null`: an empty value is a file the worker refuses to start on, so the
      // loader throws here too and the panel reads unavailable, never the default file. The queue's port is refused as the
      // worker refuses it, from the address the model endpoints' read beside this one takes (a VALKEY_URL with a password
      // is not a key this strict read may hold).
      const named = typeof meta.env?.PI_PRIVATE_ENDPOINTS_FILE === "string" ? meta.env.PI_PRIVATE_ENDPOINTS_FILE : null;
      const at = privateEndpointsPath({ privateEndpointsFile: named }, deploymentDir);
      return loadPrivateEndpoints({ privateEndpointsFile: at.explicit ? at.path : null, valkeyUrl: file.VALKEY_URL ?? paths.valkeyUrl }, { cwd: deploymentDir, readFileSync: fs.readFileSync, existsSync: fs.existsSync });
    }))();
  } catch { /* Unknown, said by the panel. */ }
  let owned = null;
  const publicationClient = (injectedRead) => {
    if (redis) return redis;
    if (owned) return owned;
    // An injected reader needs no connection when its fixture supplies no URL. Real readers share one owner.
    if (injectedRead && typeof paths.valkeyUrl !== "string") return null;
    owned = redisFn(paths.valkeyUrl);
    owned.on?.("error", () => {}); // Issue #846: a down Valkey is this call's answer; without a listener ioredis also prints a stack trace per reconnect attempt.
    return owned;
  };
  const endpointFleetDeclared = endpointFleetDeclaration(file, environmentUnknown);
  let endpointStatus = { state: "unknown", hosts: [], more: 0, partial: true };
  let shownEndpoints = Array.isArray(endpoints) ? endpoints.map((ep) => ({ ...ep })) : [];
  let endpointsMore = 0;
  const slots = new Map();
  let receivers = { hosts: [], complete: false, more: 0 };
  // Issue #970: the pollers' heartbeats. Left out of the view when not read (Setup, no Valkey, or a source that answers
  // nothing), so a page drawn from such a view says nothing of a poller rather than "not known".
  let pollers;
  let hookHistory = hookRunsView(null);
  try {
    if (publications && (redis || typeof paths.valkeyUrl === "string" || reads.endpointStatus)) {
      try {
        endpointStatus = await (reads.endpointStatus ?? readEndpointStatus)(publicationClient(reads.endpointStatus), { hosts: [...(snapshot?.hostBudgets ?? []), ...(snapshot?.hosts ?? [])], now: () => now, ...bound(PUBLICATION_READ_MS.endpointStatus) });
      } catch { /* Publication failure is unknown, never zero occupancy. */ }
    }
    const endpointHosts = (id) => (endpointStatus.hosts ?? []).flatMap((host) => (host.endpoints ?? []).filter((ep) => ep.id === id).map((ep) => ({ name: host.name, at: host.at, ageMs: host.ageMs, slots: ep.slots, used: ep.used, fleet: ep.fleet })));
    const ids = new Set(shownEndpoints.map((ep) => ep.id));
    for (const host of endpointStatus.hosts ?? []) for (const ep of host.endpoints ?? []) if (!ids.has(ep.id)) {
      ids.add(ep.id);
      shownEndpoints.push({ id: ep.id, host: null, port: null, keyless: null, slots: null });
    }
    endpointsMore = Math.max(0, shownEndpoints.length - 64);
    shownEndpoints = shownEndpoints.slice(0, 64).map((ep) => {
      const hostCounts = endpointHosts(ep.id);
      const fleetRows = hostCounts.filter((h) => h.fleet === 1);
      const counting = fleetRows.length ? "fleet" : ep.host === null ? hostCounts.length ? "host-only" : "unknown" : endpointCounting(ep.host, endpointFleetDeclared);
      const caps = [...new Set(fleetRows.map((h) => h.slots))];
      return { ...ep, declaredSlots: ep.slots, slots: caps.length === 1 ? caps[0] : caps.length > 1 ? null : ep.slots, counting, hostCounts, conflict: caps.length > 1, mixedScope: fleetRows.length > 0 && hostCounts.some((h) => h.fleet === 0) };
    });
    // Per-machine counts come from each worker's admission map; only shared endpoints have fleet lease keys.
    const fleetEndpoints = shownEndpoints.filter((ep) => ep.counting === "fleet");
    if (publications && fleetEndpoints.length) {
      try {
        const counted = await (reads.slots ?? readEndpointSlots)(publicationClient(reads.slots), fleetEndpoints, bound(PUBLICATION_READ_MS.slots));
        for (const [index, endpoint] of fleetEndpoints.entries()) slots.set(endpoint.id, Number.isInteger(counted?.[index]) ? counted[index] : null);
      } catch { /* Fleet occupancy is unknown; declarations and host occupancy remain readable. */ }
    }
    if (publications && (redis || owned || typeof paths.valkeyUrl === "string" || reads.receivers)) {
      try {
        receivers = await (reads.receivers ?? readReceiverStatus)(publicationClient(reads.receivers), { names: (snapshot?.hostBudgets ?? []).map((h) => h.name), now: () => now, ...bound(PUBLICATION_READ_MS.receivers) });
      } catch { /* Unknown is not an empty, healthy receiver population. */ }
    }
    if (publications && (redis || owned || typeof paths.valkeyUrl === "string" || reads.pollers)) {
      try {
        const read = await (reads.pollers ?? readPollerStatus)(publicationClient(reads.pollers), { now: () => now, ...bound(PUBLICATION_READ_MS.pollers) });
        if (read && typeof read === "object") pollers = read;
      } catch { pollers = { hosts: [], complete: false, more: 0 }; }
    }
    if (publications && (redis || owned || typeof paths.valkeyUrl === "string" || reads.hookRuns)) {
      try {
        const names = (snapshot?.hostBudgets ?? []).map((host) => host.name);
        hookHistory = hookRunsView(await (reads.hookRuns ?? readHookRuns)(publicationClient(reads.hookRuns), { names, ...bound(PUBLICATION_READ_MS.hookRuns) }));
      } catch { /* Missing evidence stays unknown; a hook's configuration is independent of its past runs. */ }
    }
  } finally {
    // A borrowed client belongs to the caller; our one client stays open until every publication read finishes.
    try { owned?.disconnect(); } catch {}
  }
  const hosts = doctorFacts(snapshot);
  let egressOn = null;
  let egressProblem = null;
  if (!environmentUnknown) {
    try { egressOn = egressArmed(file); }
    catch { egressProblem = "PI_EGRESS must be unset, empty, 0 or 1; the worker refuses to start until it is corrected."; }
  }
  const mcp = held?.overlayMcp ?? null;
  const packages = held?.stagedPackages ?? null;
  const forges = forgeConnections(file, triggers, { unknown: environmentUnknown });
  const loginFallback = environmentUnknown ? null : file.PI_AUTH_FROM_PI !== "0";
  const subscriptionAuth = await readSubscriptionAuthView({ snapshot, read: reads.subscriptionAuth, now });
  return {
    now, environmentUnknown, environment, subscriptionAuth,
    providerKeys: readProviderInventory({ deploymentDir, env, paths, snapshot, fs, platform, uid, reads: reads.providerInventory ?? { environment: reads.environment } }),
    receiver: { port: positive(file.RECEIVER_PORT, 3000), unknown: environmentUnknown, ...receivers },
    // `expected` is the rule `pi-dispatch status` asks (issue #970), so the two say a poller is missing in the same
    // deployments; unknown settings, or a GITHUB_INGEST every receiver command refuses, leave it null.
    ...(pollers ? { pollers: { ...pollers, expected: environmentUnknown ? null : pollerExpectedOf(file) } } : {}),
    forges,
    egress: { on: egressOn, problem: egressProblem, allowlist: Array.isArray(allowlist) ? allowlist.slice(0, 8) : null, more: Array.isArray(allowlist) ? Math.max(0, allowlist.length - 8) : 0, hosts },
    endpointFleetDeclared, endpointStatus, endpointsMore,
    endpoints: Array.isArray(endpoints) || shownEndpoints.length ? shownEndpoints.map((ep) => ({ ...ep, used: slots.get(ep.id) ?? null })) : null,
    // A triggers file that is not there grants nothing; one that was not read (or no snapshot at all) leaves the grants unknown.
    privateEndpoints: privateEndpointsView(privateDeclared, triggers, { triggersUnread: !Array.isArray(triggers) && held?.triggers?.missing !== true, triggersRefused }),
    providers: providerNames.map((name) => {
      const variables = providerKeyCandidates(name);
      // The worker forwards every truthy candidate in pi's pinned precedence order; no value leaves this reader.
      const fromEnv = variables.filter((key) => has(providerEnv, key));
      const selectedVariable = providerUnknown ? null : fromEnv[0] ?? null;
      return { name, unknown: providerUnknown, variables, fromEnv, selectedVariable, credentialSource: selectedVariable ? "deployment-env" : providerUnknown || loginFallback === null ? "unknown" : loginFallback ? "pi-login" : "worker-env", loginFallback, fallback: environmentUnknown ? "the deployment’s provider credential fallback is unknown" : loginFallback ? "pi login on each host is the configured fallback; actual credentials are not published here" : "pi login disabled by PI_AUTH_FROM_PI=0; each worker needs its environment key" };
    }),
    notify: { hook: nonblank(file, "PI_ON_FAILURE") ? basename(file.PI_ON_FAILURE) : null, timeoutMs: positive(file.PI_ON_FAILURE_TIMEOUT_MS, 10_000), triggers: (triggers ?? []).filter((t) => t.statusComment === true).map((t) => t.index).filter(Number.isInteger), unknown: environmentUnknown, history: hookHistory, ...(!Array.isArray(triggers) && held?.triggers?.missing !== true ? { triggersUnread: true, ...(triggersRefused ? { triggersRefused: true } : {}) } : {}) },
    mcp, packages, packageOptOuts: Array.isArray(triggers) ? triggers.filter((t) => t.packages === false).length : null,
    // `filesRead` (issue #1073): with no snapshot, the file sections were drawn from the file views.
    problems: connectionsProblems(hosts, snapshot?.runs ?? [], forges, pollers), snapshotUnreadable: snapshot === null, ...(snapshot === null && held !== null ? { filesRead: true } : {}),
  };
}

/**
 * Issue #918: the private endpoints Connections shows, `{ unread, rows }`: each declared one (id, host, port, slots) and
 * the trigger positions that name it, then each id a trigger names that this folder does not declare (`host: null`).
 * `declared` null is a file that did not load. Ids and positions only: no trigger text. `triggersUnread` (issue #962)
 * says the triggers were not read, so a row's empty `triggers` is not "granted to no trigger"; a key only then.
 * `triggersRefused` (issue #988) beside it says the file was read and is refused: it does not load.
 */
export function privateEndpointsView(declared, triggers, { triggersUnread = false, triggersRefused = false } = {}) {
  const named = (id) => (Array.isArray(triggers) ? triggers : []).filter((t) => Array.isArray(t?.privateEndpoints) && t.privateEndpoints.includes(id) && Number.isInteger(t.index)).map((t) => t.index);
  const rows = (Array.isArray(declared) ? declared : []).filter((e) => typeof e?.id === "string" && MODEL_ENDPOINT_ID_RE.test(e.id)).sort((a, b) => (a.id < b.id ? -1 : 1)).map((e) => ({ id: e.id, host: e.host, port: e.port, slots: Number.isInteger(e.slots) ? e.slots : null, triggers: named(e.id) }));
  const ids = new Set(rows.map((r) => r.id));
  for (const t of Array.isArray(triggers) ? triggers : []) {
    for (const id of Array.isArray(t?.privateEndpoints) ? t.privateEndpoints : []) {
      if (typeof id !== "string" || !MODEL_ENDPOINT_ID_RE.test(id) || ids.has(id)) continue;
      ids.add(id);
      rows.push({ id, host: null, port: null, slots: null, triggers: named(id) });
    }
  }
  return { unread: declared === null, ...(triggersUnread === true ? { triggersUnread: true, ...(triggersRefused === true ? { triggersRefused: true } : {}) } : {}), rows: rows.slice(0, 64), more: Math.max(0, rows.length - 64) };
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
    hookRuns: hookRunsView(view?.notify?.history),
    subscriptionAuth: subscriptionAuthForAgent(view?.subscriptionAuth),
    receivers: modelReceivers(view?.receiver, view?.now),
    forges: (view?.forges ?? []).filter((f) => Object.hasOwn(FORGES, f.name)).map((f) => ({ name: f.name, configured: typeof f.enabled === "boolean" ? f.enabled : null, path: ROUTES[f.name], authSource: ["app", "gh", "pat", "gh (default)", "invalid", "shared token"].includes(f.source) ? f.source : "unknown", ingest: f.name === "github" && ["webhook", "poll", "both", "inferred", "invalid"].includes(f.ingest) ? f.ingest : null, activationKeys: (f.activationKeys ?? []).filter((k) => FORGE_ACTIVATION_KEYS[f.name].includes(k)), secret: { key: f.name === "github" ? "WEBHOOK_SECRET" : `${f.name.toUpperCase()}_WEBHOOK_SECRET`, set: typeof f.secret?.set === "boolean" ? f.secret.set : null }, triggerCount: (f.triggers ?? []).filter((i) => Number.isSafeInteger(i) && i >= 0).length })),
    egress: { on: typeof view?.egress?.on === "boolean" ? view.egress.on : null, hosts: (view?.egress?.hosts ?? []).filter((h) => name(h.name)).map((h) => ({ name: h.name, state: h.unreadable ? "unknown" : ["ok", "warn", "fail"].includes(h.proxy?.level) ? h.proxy.level : "not-published", stale: h.stale === true })) },
    endpoints: Array.isArray(view?.endpoints) ? view.endpoints.slice(0, 64).filter((ep) => typeof ep.id === "string" && MODEL_ENDPOINT_ID_RE.test(ep.id)).map((ep) => {
      const host = typeof ep.host === "string" && /^[A-Za-z0-9.:[\]-]+$/.test(ep.host) ? ep.host : null;
      const hostCounts = (Array.isArray(ep.hostCounts) ? ep.hostCounts : []).filter((h) => typeof h.name === "string" && WORKER_NAME_RE.test(h.name) && Number.isInteger(h.slots) && h.slots >= 1 && h.slots <= MAX_SLOTS && Number.isInteger(h.used) && h.used >= 0 && h.used <= MAX_SLOTS && [0, 1].includes(h.fleet)).slice(0, ENDPOINT_STATUS_HOSTS_MAX).map((h) => ({ name: h.name, slots: h.slots, used: h.used, fleet: h.fleet, at: Number.isSafeInteger(h.at) && h.at >= 0 ? h.at : null, ageMs: Number.isSafeInteger(h.ageMs) && h.ageMs >= 0 ? h.ageMs : null }));
      const counting = hostCounts.some((h) => h.fleet === 1) ? "fleet" : host === null ? hostCounts.length ? "host-only" : "unknown" : endpointCounting(host, view.endpointFleetDeclared);
      return { id: ep.id, host, hostCounts, conflict: new Set(hostCounts.filter((h) => h.fleet === 1).map((h) => h.slots)).size > 1, mixedScope: hostCounts.some((h) => h.fleet === 1) && hostCounts.some((h) => h.fleet === 0), port: Number.isInteger(ep.port) && ep.port >= 1 && ep.port <= 65535 ? ep.port : null, keyless: typeof ep.keyless === "boolean" ? ep.keyless : null, slots: Number.isInteger(ep.slots) && ep.slots >= 1 && ep.slots <= MAX_SLOTS ? ep.slots : null, declaredSlots: Number.isInteger(ep.declaredSlots) && ep.declaredSlots >= 1 && ep.declaredSlots <= MAX_SLOTS ? ep.declaredSlots : null, counting, used: counting === "fleet" && Number.isInteger(ep.used) && ep.used >= 0 && ep.used <= MAX_SLOTS ? ep.used : null };
    }) : null,
    endpointsMore: Math.max(Array.isArray(view?.endpoints) ? Math.max(0, view.endpoints.length - 64) : 0, Number.isSafeInteger(view?.endpointsMore) && view.endpointsMore >= 0 ? view.endpointsMore : 0),
    endpointStatus: { state: view?.endpointStatus?.state === "reported" ? "reported" : "unknown", partial: view?.endpointStatus?.partial !== false, more: Number.isSafeInteger(view?.endpointStatus?.more) && view.endpointStatus.more >= 0 ? view.endpointStatus.more : null, hosts: (Array.isArray(view?.endpointStatus?.hosts) ? view.endpointStatus.hosts : []).filter((h) => typeof h.name === "string" && WORKER_NAME_RE.test(h.name)).slice(0, ENDPOINT_STATUS_HOSTS_MAX).map((h) => ({ name: h.name, state: ["reported", "not-reported", "unsupported", "unreadable"].includes(h.state) ? h.state : "unreadable", at: Number.isSafeInteger(h.at) && h.at >= 0 ? h.at : null, ageMs: Number.isSafeInteger(h.ageMs) && h.ageMs >= 0 ? h.ageMs : null, endpointsMore: Number.isSafeInteger(h.endpointsMore) && h.endpointsMore >= 0 ? h.endpointsMore : null })) },
    providers,
    providerKeys: providerInventoryView(view?.providerKeys),
    mcp: { servers: (view?.mcp?.servers ?? []).filter((s) => mcpName(s.name)).map((s) => ({ name: s.name, transport: ["http", "stdio"].includes(s.transport) ? s.transport : null, enabled: s.enabled === true, referenceCount: Array.isArray(s.refs) ? s.refs.length : 0 })), refused: refusedMcpNames.filter(mcpName), invalidNameCount: invalidMcpNameCount, unreadable: !view?.mcp || Boolean(view.mcp.unreadable) },
    packages: { names: packages, stagedAt: typeof view?.packages?.stagedAt === "string" && Number.isFinite(Date.parse(view.packages.stagedAt)) ? new Date(view.packages.stagedAt).toISOString() : null, unreadable: !view?.packages || Boolean(view.packages.unreadable) },
    deployment: (view?.environment ?? []).filter((e) => Object.hasOwn(CONNECTION_ENV_TYPES, e.key) || providerKeys.has(e.key)).map((e) => ({ key: e.key, set: typeof e.value === "string" && !e.value.startsWith("not set") && !e.value.startsWith("unknown"), unknown: typeof e.value !== "string" || e.value.startsWith("unknown"), disagrees: e.disagrees === true })),
  };
}

/** Rebuild again at the model boundary: callers may hand us an untrusted view DTO rather than our own reader. */
export function modelReceivers(value, now) {
  const hosts = [];
  for (const row of Array.isArray(value?.hosts) ? value.hosts.slice(0, 64) : []) {
    const parsed = parseReceiverStatus(JSON.stringify(row));
    if (!parsed || !Number.isSafeInteger(now) || now < 0) continue;
    hosts.push({ name: parsed.name, version: parsed.version, startedAt: parsed.startedAt, at: parsed.at, port: parsed.port, bind: parsed.bind, forges: [...parsed.forges], deliveries: Object.fromEntries(RECEIVER_FORGES.map((forge) => [forge, receiverForgeFacts(parsed, forge, now)])) });
  }
  return { complete: value?.complete === true && value?.more === 0 && value?.moreUnknown !== true && hosts.length === (Array.isArray(value?.hosts) ? value.hosts.length : 0), moreUnknown: value?.moreUnknown === true, more: Number.isSafeInteger(value?.more) && value.more >= 0 ? value.more : null, hosts };
}
