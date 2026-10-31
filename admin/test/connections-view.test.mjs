import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { CONNECTION_ENV_TYPES, FORGE_ACTIVATION_KEYS, connectionEnvValue, connectionsProblems, forgeConnections, modelConnections, readConnections, readEndpointSlots } from "../src/connections-view.mjs";
import { normalizeTriggerForDisplay, PANEL_SERVICE_KEYS } from "../src/read-model.mjs";
import { DOLLAR_ENV_NAMES } from "@edgehero/pi-dispatch/money";
import { FORGES } from "@edgehero/pi-dispatch/forges";
import { MAX_SLOTS, parseModelEndpoints } from "@edgehero/pi-dispatch/model-endpoints";
import { isPerMachineHost } from "@edgehero/pi-dispatch/backends";
import { workerName } from "@edgehero/pi-dispatch/config";
import { endpointSlotKey, hash16 } from "@edgehero/pi-dispatch/fleet-lease";
import { loadReceiverConfig } from "../../receiver/src/config.mjs";
import { loadPollerConfig } from "../../receiver/src/poller-config.mjs";
import { connectionsPackages } from "../src/console/panels/connections.mjs";
import { page } from "../src/console/html.mjs";
import { parseDocument } from "./helpers/script-dom.mjs";

const AT = Date.UTC(2026, 9, 30, 12);
const snapshot = (extra = {}) => ({ triggers: { triggers: [] }, settings: { overlay: {} }, hostBudgets: [], doctor: { hosts: [] }, runs: [], overlayMcp: { servers: [], refused: [] }, stagedPackages: { packages: [] }, ...extra });
const reads = (env = {}, extra = {}) => ({ environment: () => ({ env }), allowlist: () => ["api.github.com", ".example.org"], endpoints: () => [], ...extra });

test("Connections names every existing panel environment key, with presence as the safe fallback", () => {
  for (const key of PANEL_SERVICE_KEYS) assert.ok(Object.hasOwn(CONNECTION_ENV_TYPES, key), key);
  assert.deepEqual(Object.keys(FORGE_ACTIVATION_KEYS), Object.keys(FORGES));
});

test("environment values use the key's closed type, never the shape of a secret value", () => {
  for (const key of ["WEBHOOK_SECRET", "GITHUB_PAT", "VALKEY_URL", "PI_SECRET_BUNDLES", "PI_SECRET_PROFILES", "PI_FORWARD_ENV"]) {
    for (const value of ["42", "1", "app", "https://secret.example/token", "/Users/person/private"]) assert.equal(connectionEnvValue(key, value), "set", `${key}:${value}`);
  }
  assert.equal(connectionEnvValue("PI_JOB_CPUS", "2.5"), "2.5");
  assert.equal(connectionEnvValue("PI_JOB_CPUS", "2;secret"), "set (invalid number)");
  assert.equal(connectionEnvValue("GITHUB_AUTH_SOURCE", "secret"), "set (invalid option)");
  assert.equal(connectionEnvValue("PI_ON_FAILURE", "/Users/private-person/bin/notify"), ".../notify");
  assert.equal(connectionEnvValue("PI_SETTINGS_FILE", "C:\\Users\\private-person\\settings.json"), ".../settings.json");
  assert.equal(connectionEnvValue("RECEIVER_PORT", "65536"), "set (invalid number)");
  assert.equal(connectionEnvValue("PI_CONCURRENCY", undefined), "unknown (worker env or default)");
  for (const key of Object.values(DOLLAR_ENV_NAMES)) assert.equal(connectionEnvValue(key, undefined), "unknown (worker env or default)", key);
});

test("forge activation agrees with the actual receiver loader, including non-activation counterexamples", () => {
  const deps = { fileExists: () => true, readFile: () => '{"triggers":[]}' };
  const cases = [
    {}, { GITHUB_PAT: "unused" }, { GITHUB_AUTH_SOURCE: "gh", WEBHOOK_SECRET: "unused" },
    { GITLAB_URL: "https://gitlab.example" }, { GITLAB_WEBHOOK_MODE: "signature" }, { GITLAB_TOKEN: "unused" }, { GITLAB_WEBHOOK_SECRET: "unused" },
    { FORGEJO_BOT_ID: "2" }, { FORGEJO_PERMISSION_TOKEN: "unused" }, { FORGEJO_URL: "https://forge.example" }, { FORGEJO_TOKEN: "unused" }, { FORGEJO_WEBHOOK_SECRET: "unused" },
    { AZURE_WEBHOOK_HEADER: "X-Auth" }, { AZURE_ORG_URL: "https://dev.azure.com/org" }, { AZURE_TOKEN: "unused" }, { AZURE_WEBHOOK_SECRET: "unused" }, { AZURE_WEBHOOK_MODE: "basic" },
  ];
  for (const env of cases) {
    let cfg; let error;
    try { cfg = loadReceiverConfig(env, deps); } catch (e) { error = e; }
    const view = forgeConnections(env, []);
    for (const f of view) {
      const active = f.name === "github" ? cfg?.servesGithub === true : Boolean(cfg?.[f.name]);
      // A missing required field proves that the loader activated that forge, then refused it at boot.
      const refused = error && new RegExp(`${f.name.toUpperCase()}_|${f.name} `).test(error.message);
      assert.equal(f.enabled, active || Boolean(refused), `${JSON.stringify(Object.keys(env))}: ${f.name}`);
    }
  }
});

test("GitHub active rules and explicit intent count; spent, cron and watch rules do not arm its webhook", () => {
  const rows = [ { forge: "github", type: "issue", index: 5 }, { forge: "github", type: "issue", index: 6, disarmed: true }, { forge: "github", type: "cron", index: 7 }, { forge: null, type: "watch", index: 8 } ];
  assert.deepEqual(forgeConnections({}, rows)[0].triggers, [5]);
  assert.equal(forgeConnections({}, rows)[0].enabled, true);
  assert.equal(forgeConnections({}, rows.slice(1))[0].enabled, false);
  assert.equal(forgeConnections({}, null)[0].enabled, null);
  assert.equal(forgeConnections({ GITHUB_AUTH_SOURCE: "gh" }, null)[0].enabled, true, "explicit service intent remains known even when triggers could not be read");
  const actual = normalizeTriggerForDisplay({ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix" } });
  assert.deepEqual(forgeConnections({}, [{ ...actual, index: 2 }])[0].triggers, [2], "the real display record uses forge, not the queue job kind field");
});

test("An armed GitHub receiver with an absent or blank deployment secret warns with the actual loader's startup refusal", async () => {
  const trigger = { on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix" } };
  const deps = { fileExists: () => true, readFile: () => JSON.stringify({ triggers: [trigger] }) };
  const active = snapshot({ triggers: { triggers: [{ ...normalizeTriggerForDisplay(trigger), index: 2 }] } });
  for (const secret of [undefined, "", " \t "]) {
    const file = secret === undefined ? {} : { WEBHOOK_SECRET: secret };
    assert.throws(() => loadReceiverConfig(file, deps), /WEBHOOK_SECRET is required; refusing to start/);
    const v = await readConnections({ now: AT, env: { WEBHOOK_SECRET: "SHELL_SECRET_SENTINEL" }, snapshot: active, reads: reads(file) });
    const problem = v.problems.find((p) => p.kind === "receiver");
    assert.ok(problem);
    assert.equal(problem.host, null);
    assert.match(problem.text, /not set in the deployment's \.env/);
    assert.match(problem.text, /refuses to start unless its service environment sets it/);
    assert.doesNotMatch(JSON.stringify(v), /SHELL_SECRET_SENTINEL/);
    assert.equal(v.forges[0].secret.set, false);
  }
  const secretSet = { WEBHOOK_SECRET: "DEPLOYMENT_SECRET_SENTINEL" };
  assert.equal(loadReceiverConfig(secretSet, deps).servesGithub, true);
  assert.ok(!(await readConnections({ now: AT, snapshot: active, reads: reads(secretSet) })).problems.some((p) => p.kind === "receiver"));
  assert.ok(!(await readConnections({ now: AT, snapshot: snapshot(), reads: reads() })).problems.some((p) => p.kind === "receiver"), "an unarmed receiver does not require a GitHub secret");
  const unknown = await readConnections({ now: AT, snapshot: active, reads: reads({}, { environment: () => ({ unreadable: true, env: {} }) }) });
  assert.equal(unknown.forges[0].secret.set, null);
  assert.ok(!unknown.problems.some((p) => p.kind === "receiver"), "unread metadata cannot prove a missing declaration");
  const explicit = await readConnections({ now: AT, snapshot: snapshot({ triggers: null }), reads: reads({ GITHUB_AUTH_SOURCE: "gh" }) });
  assert.ok(explicit.problems.some((p) => p.kind === "receiver"), "an explicit auth source arms GitHub even when the trigger source is unknown");
});

test("forge delivery ids derive from the worker and polling uses the real poller defaults and floor", () => {
  const deps = { fileExists: () => true, readFile: () => '{"triggers":[]}' };
  for (const interval of [undefined, "1", "45", "120"]) {
    const env = { GITHUB_AUTH_SOURCE: "gh", POLL_REPOS: "acme/web", ...(interval ? { POLL_INTERVAL_SECONDS: interval } : {}) };
    const actual = loadPollerConfig(env, deps);
    const [github] = forgeConnections(env, []);
    assert.equal(github.polling.state, "on");
    assert.equal(github.polling.seconds, actual.intervalSeconds);
    assert.deepEqual(github.polling.repos, actual.repos);
  }
  for (const f of forgeConnections({}, [])) assert.equal(f.deliveryId, FORGES[f.name].deliveryIdName);
});

test("Polling is configured on, off or unknown, with App discovery and intervals held to the real poller loader", async () => {
  const deps = { fileExists: () => true, readFile: () => '{"triggers":[]}' };
  const app = { GITHUB_AUTH_SOURCE: "app", GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2", GITHUB_APP_PRIVATE_KEY_PATH: "/private/app-key" };
  for (const raw of [undefined, "", " \t "]) {
    const file = raw === undefined ? {} : { POLL_REPOS: raw };
    const off = (await readConnections({ now: AT, snapshot: snapshot(), reads: reads(file) })).forges[0].polling;
    assert.deepEqual(off, { state: "off", repos: [], source: null, seconds: null });
    assert.throws(() => loadPollerConfig(file, deps), /nothing to poll/);
    const on = (await readConnections({ now: AT, snapshot: snapshot(), reads: reads({ ...app, ...file }) })).forges[0].polling;
    const actual = loadPollerConfig({ ...app, ...file }, deps);
    assert.equal(actual.repos, null);
    assert.deepEqual(on, { state: "on", repos: [], source: "app-installation", seconds: actual.intervalSeconds });
  }
  const declared = { POLL_REPOS: " acme/web, acme/api,acme/web ", POLL_INTERVAL_SECONDS: " 45 " };
  const actual = loadPollerConfig(declared, deps);
  const on = (await readConnections({ now: AT, snapshot: snapshot(), reads: reads(declared) })).forges[0].polling;
  assert.deepEqual(on, { state: "on", repos: actual.repos, source: "POLL_REPOS", seconds: actual.intervalSeconds });
  for (const invalid of [{ POLL_REPOS: ",," }, { POLL_REPOS: "PRIVATE_POLL_SENTINEL" }, { POLL_REPOS: "acme/web", POLL_INTERVAL_SECONDS: "0" }, { POLL_REPOS: "acme/web", POLL_INTERVAL_SECONDS: "PRIVATE_INTERVAL_SENTINEL" }]) {
    assert.throws(() => loadPollerConfig(invalid, deps));
    const v = await readConnections({ now: AT, snapshot: snapshot(), reads: reads(invalid) });
    assert.deepEqual(v.forges[0].polling, { state: "unknown", repos: [], source: null, seconds: null });
    assert.doesNotMatch(JSON.stringify(v), /PRIVATE_POLL_SENTINEL|PRIVATE_INTERVAL_SENTINEL/);
  }
  const unknown = await readConnections({ now: AT, snapshot: snapshot(), reads: reads({}, { environment: () => ({ env: {}, unreadable: true }) }) });
  assert.equal(unknown.forges[0].polling.state, "unknown");
  assert.equal(unknown.forges[0].polling.seconds, null);
});

test("slot occupancy reads expiring lease presence only, including indexes above a reduced declaration", async () => {
  let now = AT;
  const ep = { id: "local-model", slots: 2 };
  const claims = new Map([[0, AT + 100], [1, AT + 200], [5, AT + 300]]);
  const seen = [];
  const redis = { pipeline() { const keys = []; return { pttl(key) { keys.push(key); return this; }, async exec() { seen.push(...keys); return keys.map((_, i) => [null, claims.has(i) && claims.get(i) > now ? claims.get(i) - now : -2]); } }; } };
  assert.deepEqual(await readEndpointSlots(redis, [ep]), [3]);
  assert.equal(seen.length, MAX_SLOTS);
  assert.equal(seen[5], endpointSlotKey(hash16(ep.id), 5));
  now += 150;
  assert.deepEqual(await readEndpointSlots(redis, [ep]), [2]);
  now += 200;
  assert.deepEqual(await readEndpointSlots(redis, [ep]), [0]);
});

test("unreadable, malformed and permanent lease states are unknown, never zero", async () => {
  const eps = [{ id: "a", slots: 1 }];
  assert.deepEqual(await readEndpointSlots({ pipeline() { throw Error("offline"); } }, eps), [null]);
  for (const value of [-1, "4", -3]) {
    const redis = { pipeline: () => ({ pttl() {}, exec: async () => Array.from({ length: MAX_SLOTS }, () => [null, value]) }) };
    assert.deepEqual(await readEndpointSlots(redis, eps), [null]);
  }
});

test("per-machine endpoint aliases use the worker's canonical host rule and never read fleet leases", async () => {
  const aliases = ["host.docker.internal", "host.docker.internal.", "host.containers.internal", "host.containers.internal."];
  for (const host of ["HOST.DOCKER.INTERNAL", "HOST.CONTAINERS.INTERNAL"]) {
    const parsed = parseModelEndpoints(JSON.stringify({ version: 1, endpoints: [{ id: "host-model", host, port: 11434, keyless: true, slots: 2 }] }));
    assert.equal(parsed[0].host, host.toLowerCase());
    assert.equal(isPerMachineHost(parsed[0].host), true, "the worker receives the parser's canonical host");
  }
  for (const host of aliases) {
    assert.equal(isPerMachineHost(host), true);
    const endpoint = { id: "host-model", host, port: 11434, keyless: true, slots: 2 };
    let redisCalls = 0;
    let slotReads = 0;
    const value = await readConnections({ now: AT, snapshot: snapshot(), redisFn: () => { redisCalls++; throw Error("must not connect"); }, reads: reads({ PI_WORKER_NAME: "mini1" }, { endpoints: () => [endpoint], slots: () => { slotReads++; throw Error("must not read"); } }) });
    assert.equal(redisCalls, 0);
    assert.equal(slotReads, 0);
    assert.equal(value.endpointFleetDeclared, true);
    assert.deepEqual(value.endpoints[0], { ...endpoint, counting: "per-machine", used: null });
    assert.equal(modelConnections(value).endpoints[0].counting, "per-machine");
    assert.equal(modelConnections(value).endpoints[0].used, null);
  }
});

test("an absent deployment worker name cannot be supplied by the shell and does not read endpoint leases", async () => {
  const endpoint = { id: "shared-model", host: "models.example.com", port: 443, slots: 3, keyless: false };
  for (const file of [{}, { PI_WORKER_NAME: "" }]) {
    let readsTaken = 0;
    const value = await readConnections({ now: AT, snapshot: snapshot(), env: { PI_WORKER_NAME: "SHELL_WORKER_CANARY" }, redisFn: () => { readsTaken++; throw Error("must not connect"); }, reads: reads(file, { endpoints: () => [endpoint], slots: () => { readsTaken++; return [0]; } }) });
    assert.equal(readsTaken, 0);
    assert.equal(value.endpointFleetDeclared, false);
    assert.equal(value.endpoints[0].counting, "worker-name-absent");
    assert.equal(value.endpoints[0].used, null);
    assert.doesNotMatch(JSON.stringify(value.endpoints), /SHELL_WORKER_CANARY/);
  }
});

test("unknown or invalid deployment worker metadata cannot turn absent lease keys into a counted zero", async () => {
  const endpoints = [{ id: "shared-model", host: "models.example.com", port: 443, slots: 2 }, { id: "host-model", host: "host.docker.internal", port: 11434, slots: 2 }];
  for (const metadata of [{ env: { PI_WORKER_NAME: "mini1" }, unreadable: true }, { env: { PI_WORKER_NAME: "mini1" }, untrusted: true }, { env: { PI_WORKER_NAME: "mini1" }, hazardSkipped: ["PI_WORKER_NAME"] }, { env: { PI_WORKER_NAME: "mini1.json" } }, { env: { PI_WORKER_NAME: "PRIVATE_INVALID_WORKER/name" } }]) {
    let slotReads = 0;
    const value = await readConnections({ now: AT, snapshot: snapshot(), redisFn: () => { slotReads++; throw Error("must not connect"); }, reads: reads({}, { environment: () => metadata, endpoints: () => endpoints, slots: () => { slotReads++; return [0, 0]; } }) });
    assert.equal(slotReads, 0);
    assert.equal(value.endpointFleetDeclared, null);
    assert.deepEqual(value.endpoints.map((ep) => [ep.counting, ep.used]), [["unknown", null], ["per-machine", null]]);
    assert.deepEqual(modelConnections(value).endpoints.map((ep) => [ep.counting, ep.used]), [["unknown", null], ["per-machine", null]]);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_INVALID_WORKER/);
  }
});

test("a named deployment counts only genuinely shared endpoints, preserving real zero and live literal-address leases", async () => {
  assert.equal(workerName({ PI_WORKER_NAME: "mini1" }), "mini1");
  const endpoints = [
    { id: "host-model", host: "host.docker.internal", port: 11434, slots: 2 },
    { id: "remote-model", host: "mini1.lan", port: 11434, slots: 2 },
    { id: "literal-model", host: "169.254.1.1", port: 11434, slots: 2 },
  ];
  for (const host of ["mini1.lan", "127.0.0.1", "169.254.1.1", "[::1]"]) assert.equal(isPerMachineHost(host), false, `${host}: addresses are not per-machine aliases`);
  const keys = [];
  const redis = { pipeline() { return { pttl(key) { keys.push(key); return this; }, async exec() { return keys.map((_, i) => [null, i === MAX_SLOTS ? 1000 : -2]); } }; } };
  const value = await readConnections({ now: AT, snapshot: snapshot(), redis, reads: reads({ PI_WORKER_NAME: "mini1" }, { endpoints: () => endpoints }) });
  assert.equal(keys.length, 2 * MAX_SLOTS);
  assert.ok(keys.every((key) => !key.includes(hash16("host-model"))));
  assert.equal(keys[0], endpointSlotKey(hash16("remote-model"), 0));
  assert.equal(keys[MAX_SLOTS], endpointSlotKey(hash16("literal-model"), 0));
  assert.deepEqual(value.endpoints.map((ep) => [ep.counting, ep.used]), [["per-machine", null], ["fleet", 0], ["fleet", 1]]);
  assert.deepEqual(modelConnections(value).endpoints.map((ep) => [ep.counting, ep.used]), [["per-machine", null], ["fleet", 0], ["fleet", 1]]);
  const down = await readConnections({ now: AT, snapshot: snapshot(), redis: { pipeline() { throw Error("offline"); } }, reads: reads({ PI_WORKER_NAME: "mini1" }, { endpoints: () => endpoints }) });
  assert.deepEqual(down.endpoints.map((ep) => [ep.counting, ep.used]), [["per-machine", null], ["fleet", null], ["fleet", null]], "an unread fleet stays counted in scope but its current occupancy is unknown");
});

test("each Connections source fails independently and an invalid provider cannot erase other sections", async () => {
  const v = await readConnections({ now: AT, snapshot: snapshot(), reads: reads({ PI_PROVIDER: "bad secret provider" }, { allowlist: () => { throw Error("private path"); }, endpoints: () => { throw Error("private path"); } }) });
  assert.equal(v.egress.allowlist, null);
  assert.equal(v.endpoints, null);
  assert.equal(v.forges.length, 4);
  assert.ok(v.environment.length);
  assert.doesNotMatch(JSON.stringify(v), /private path|bad secret provider/);
});

test("Connections reads the deployment file separately from the shell and returns presence, not credentials", async () => {
  const file = { WEBHOOK_SECRET: "SECRET_SENTINEL", VALKEY_URL: "redis://user:PASS_SENTINEL@secret-host", PI_ON_FAILURE: "/Users/PRIVATE_SENTINEL/bin/notify", ANTHROPIC_API_KEY: "KEY_SENTINEL", PI_AUTH_FROM_PI: "0", POLL_REPOS: "acme/web" };
  const v = await readConnections({ now: AT, env: { VALKEY_URL: "redis://different" }, snapshot: snapshot(), reads: reads(file) });
  assert.equal(v.environment.find((r) => r.key === "VALKEY_URL").disagrees, true);
  assert.equal(v.environment.find((r) => r.key === "VALKEY_URL").value, "set");
  assert.equal(v.notify.hook, ".../notify");
  assert.ok(v.providers.some((p) => p.fromEnv.includes("ANTHROPIC_API_KEY")));
  assert.doesNotMatch(JSON.stringify(v), /SECRET_SENTINEL|PASS_SENTINEL|PRIVATE_SENTINEL|KEY_SENTINEL|secret-host/);
});

test("missing metadata is unknown and does not claim egress on or an endpoint unconfigured", async () => {
  const v = await readConnections({ now: AT, snapshot: snapshot(), reads: reads({}, { environment: () => ({ env: {}, unreadable: true }) }) });
  assert.equal(v.egress.on, null);
  assert.ok(v.forges.every((f) => f.enabled === null && f.secret.set === null));
  assert.ok(v.environment.every((r) => r.value.startsWith("unknown")));
});

test("a provider metadata read failure is unknown even when the general deployment read succeeded", async () => {
  const v = await readConnections({ now: AT, snapshot: snapshot(), reads: reads({}, { environment: ({ keys }) => keys.includes("RECEIVER_PORT") ? { env: {} } : { env: {}, unreadable: "EACCES" } }) });
  assert.equal(v.environmentUnknown, false);
  assert.equal(v.providers[0].unknown, true);
  assert.equal(v.providers[0].credentialSource, "unknown");
  assert.equal(v.providers[0].selectedVariable, null);
  assert.match(v.environment.find((e) => e.key === "ANTHROPIC_API_KEY").value, /^unknown/);
  assert.equal(v.forges[0].enabled, false);
});

test("Provider rows select the first deployment candidate in pinned order and distinguish absence from unknown sources", async () => {
  const selected = async (file, extra = {}) => (await readConnections({ now: AT, snapshot: snapshot(), reads: reads(file, extra) })).providers[0];
  const both = await selected({ ANTHROPIC_API_KEY: "API_VALUE_SENTINEL", ANTHROPIC_OAUTH_TOKEN: "OAUTH_VALUE_SENTINEL", ANTHROPIC_AUTH_TOKEN: "AUTH_VALUE_SENTINEL" });
  assert.equal(both.selectedVariable, "ANTHROPIC_AUTH_TOKEN");
  assert.deepEqual(both.fromEnv, ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  assert.equal(both.credentialSource, "deployment-env");
  const lower = await selected({ ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: "API_VALUE_SENTINEL" });
  assert.equal(lower.selectedVariable, "ANTHROPIC_API_KEY");
  const whitespace = await selected({ ANTHROPIC_AUTH_TOKEN: " ", ANTHROPIC_API_KEY: "API_VALUE_SENTINEL" });
  assert.equal(whitespace.selectedVariable, "ANTHROPIC_AUTH_TOKEN", "the worker forwards truthy candidates, including whitespace; set does not mean valid");
  const absent = await selected({});
  assert.equal(absent.selectedVariable, null);
  assert.equal(absent.credentialSource, "pi-login");
  assert.equal(absent.loginFallback, true);
  const envOnly = await selected({ PI_AUTH_FROM_PI: "0" });
  assert.equal(envOnly.credentialSource, "worker-env");
  assert.equal(envOnly.loginFallback, false);
  const unknown = await selected({}, { environment: () => ({ env: {}, unreadable: true }) });
  assert.equal(unknown.credentialSource, "unknown");
  assert.equal(unknown.selectedVariable, null);
  assert.equal(unknown.loginFallback, null);
  assert.doesNotMatch(JSON.stringify([both, lower, whitespace, absent, envOnly, unknown]), /API_VALUE_SENTINEL|OAUTH_VALUE_SENTINEL|AUTH_VALUE_SENTINEL/);
});

test("egress posture uses the worker's exact unset, empty, on, off and invalid rules", async () => {
  for (const raw of [undefined, "", "1", "0", "2", "secret-sentinel"]) {
    const v = await readConnections({ now: AT, snapshot: snapshot(), reads: reads(raw === undefined ? {} : { PI_EGRESS: raw }) });
    assert.equal(v.egress.on, raw === "0" ? false : [undefined, "", "1"].includes(raw) ? true : null);
    if (["2", "secret-sentinel"].includes(raw)) assert.match(v.egress.problem, /worker refuses to start/);
    assert.doesNotMatch(JSON.stringify(v), /secret-sentinel/);
  }
});

test("problem priority and latest refused run are independent of doctor row order", () => {
  const host = (name, other) => ({ name, proxy: null, forge: [], endpoints: null, ...other });
  const all = connectionsProblems([host("a", { endpoints: { label: "file broken" } }), host("b", { forge: [{ label: "forge broken" }] }), host("c", { proxy: { level: "fail", label: "proxy absent" } })], [
    { host: "c", jobId: "old", reason: "egress-proxy-missing", startedAt: new Date(AT - 2000).toISOString(), endedAt: new Date(AT - 1000).toISOString() },
    { host: "c", jobId: "new", reason: "egress-proxy-stopped", startedAt: new Date(AT - 3000).toISOString(), endedAt: new Date(AT).toISOString() },
    { host: "b", jobId: "other", reason: "egress-proxy-stopped", endedAt: new Date(AT + 1000).toISOString() },
  ]);
  assert.deepEqual(all.map((p) => p.kind), ["proxy", "forge", "endpoints"]);
  assert.equal(all[0].run, "new");
});

test("model connections omit manager names, paths, refs and doctor text across complete serialized output", async () => {
  const v = await readConnections({ now: AT, snapshot: snapshot({ overlayMcp: { servers: [{ name: "linear", transport: "http", enabled: true, refs: ["MANAGER_VAR_SENTINEL"], where: "HOST_SENTINEL" }], refused: [] }, doctor: { hosts: [{ name: "mini1", checks: [{ id: "egress.proxy", level: "fail", label: "DOCTOR_SECRET_SENTINEL" }] }] } }), reads: reads({ PI_ON_FAILURE: "/private/ROOT_SENTINEL/notify" }) });
  const out = modelConnections(v);
  assert.equal(out.mcp.servers[0].referenceCount, 1);
  assert.equal(out.mcp.servers[0].name, "linear");
  assert.doesNotMatch(JSON.stringify(out), /MANAGER_VAR_SENTINEL|HOST_SENTINEL|DOCTOR_SECRET_SENTINEL|ROOT_SENTINEL|notify/);
});

test("Model reads distinguish unknown MCP and package sources from successfully read empty sources", async () => {
  for (const sources of [null, snapshot({ overlayMcp: { unreadable: true }, stagedPackages: { unreadable: true } })]) {
    const unknown = modelConnections(await readConnections({ now: AT, snapshot: sources, reads: reads() }));
    assert.equal(unknown.mcp.unreadable, true);
    assert.equal(unknown.packages.unreadable, true);
    assert.deepEqual(unknown.mcp.servers, []);
    assert.deepEqual(unknown.packages.names, []);
  }
  const empty = modelConnections(await readConnections({ now: AT, snapshot: snapshot(), reads: reads() }));
  assert.equal(empty.mcp.unreadable, false);
  assert.equal(empty.packages.unreadable, false);
});

test("Only a writable operator can copy the package staging command; other roles keep its facts and a sentence", async () => {
  const connections = await readConnections({ now: AT, snapshot: snapshot({ stagedPackages: { packages: ["@acme/review@1.2.3"], stagedAt: "2026-10-29T12:00:00Z" } }), reads: reads() });
  const rendered = (role, readOnly) => parseDocument(String(page({ title: "Connections", name: "connections", body: connectionsPackages({ data: { connections }, role, readOnly }) })));
  const operator = rendered("operator", false);
  assert.ok(operator.querySelector("[data-copy]"));
  assert.match(operator.textContent, /pi-dispatch import-pi --with-packages/);
  for (const [role, readOnly] of [["viewer", false], ["operator", true]]) {
    const page = rendered(role, readOnly);
    assert.equal(page.querySelector("[data-copy]"), null);
    assert.match(page.textContent, /@acme\/review@1\.2\.3/);
    assert.match(page.textContent, /An operator can import and stage the pi packages on the host/);
    assert.doesNotMatch(page.textContent, /pi-dispatch import-pi --with-packages/);
  }
});

test("private subscription locations expose presence only, including in the complete reader and model output", async () => {
  const keys = ["PI_AUTH_CONNECTIONS_FILE", "PI_AUTH_STORE_DIR"];
  for (const key of keys) {
    assert.ok(PANEL_SERVICE_KEYS.includes(key));
    assert.equal(CONNECTION_ENV_TYPES[key], "present");
    assert.equal(connectionEnvValue(key, "/private/private-location-sentinel"), "set");
    assert.equal(connectionEnvValue(key, ""), "not set");
  }
  const value = await readConnections({ now: AT, snapshot: snapshot(), reads: reads({ PI_AUTH_CONNECTIONS_FILE: "/private/private-location-sentinel", PI_AUTH_STORE_DIR: "C:\\Users\\private-store-sentinel" }) });
  assert.doesNotMatch(JSON.stringify(value), /private-location-sentinel|private-store-sentinel/);
  assert.doesNotMatch(JSON.stringify(modelConnections(value)), /private-location-sentinel|private-store-sentinel/);
  for (const key of keys) assert.equal(value.environment.find(row => row.key === key).value, "set");
});
