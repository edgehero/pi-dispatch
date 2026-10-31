import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { readConfigTool } from "../src/config-tools.mjs";
import { readConnections, modelConnections } from "../src/connections-view.mjs";
import { secretsView } from "../src/secrets-view.mjs";
import { consoleProjectFixture } from "./helpers/console-project-fixture.mjs";

const NOW = Date.UTC(2026, 9, 31, 12);
const VARIABLE = "MANAGER_VARIABLE_TOOL_CANARY";
const PRIVATE = "/Users/private-tool-person/root";
const REF = "PRIVATE_REFERENCE_TOOL_CANARY";
const VALUE = "PRIVATE_VALUE_TOOL_CANARY";
const paths = { projectsFile: "/deployment/projects.json", scopedLimitsPath: "/deployment/scoped-limits.json", settingsFile: "/deployment/settings.json", logsDir: "/deployment/logs", triggersPath: "/deployment/triggers.json" };
function fleetOf(snapshot, calls, { failSnapshot = false, pages = [] } = {}) {
  return (_paths, opts) => {
    calls.push(["fleet", opts]);
    let at = 0;
    return { async snapshot(opts) { calls.push(["snapshot", opts]); if (failSnapshot) throw Error(PRIVATE); return snapshot; }, async runsPage(opts) { calls.push(["runsPage", opts]); return pages[at++] ?? { runs: [], next: null }; }, async dispose() { calls.push(["dispose"]); } };
  };
}
function snapshotOf() {
  return { settings: { overlay: { provider: "anthropic", secretProfiles: { prod: `${PRIVATE}/resolver` }, secretBundles: { billing: { path: `${PRIVATE}/bundle`, format: "json" } } } }, triggers: { triggers: [{ index: 0, type: "comment", kind: "github", secrets: 1, secretsProfile: "prod", packages: false, statusComment: true }], secretBundles: [{ id: "billing", project: "billing", profile: "billing", endpoints: [{ name: VARIABLE, host: "api.example.com" }] }] }, projects: { projects: [{ id: "billing", name: "Billing", members: ["github:acme/billing"] }] }, runs: [{ jobId: "gh-one", endedAt: new Date(NOW - 1000).toISOString(), secretsProfile: "prod", outcome: "completed", bundle: { id: "billing", variables: [VARIABLE], shadowed: [] }, ref: REF, secret: VALUE }], hosts: [{ name: "mini1", caps: ["s:prod"], capsSeen: true }], doctor: { hosts: [{ name: "mini1", checks: [{ id: "egress.proxy", level: "fail", label: `private doctor ${VALUE}`, fix: PRIVATE }] }] }, overlayMcp: { servers: [{ name: "tracker", transport: "http", enabled: true, refs: [VARIABLE], where: PRIVATE, headers: { Authorization: VALUE } }], refused: ["dispatch-admin"], problems: [{ name: "dispatch-admin", problem: VALUE }] }, stagedPackages: { packages: ["@acme/tool@1.2.3"], stagedAt: new Date(NOW).toISOString() } };
}
const noSecrets = (out) => { for (const value of [VARIABLE, PRIVATE, REF, VALUE]) assert.ok(!JSON.stringify(out).includes(value), value); };

test("configuration read tools ask for only their page facts and dispose the one read-only fleet reader", async () => {
  for (const kind of ["secrets", "connections"]) {
    const calls = [];
    const snapshot = snapshotOf();
    const reads = { fleet: fleetOf(snapshot, calls), secrets: (args) => { calls.push(["secrets"]); return secretsView({ ...args, fs: { realpathSync: (p) => p } }); }, connections: (args) => { calls.push(["connections"]); return readConnections({ ...args, reads: { environment: () => ({ env: { WEBHOOK_SECRET: VALUE, PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: VALUE, PI_ON_FAILURE: `${PRIVATE}/hook` } }), allowlist: () => ["api.example.com"], endpoints: () => [] } }); } };
    const out = await readConfigTool(kind, { paths, env: { PI_SECRET_RESOLVER_ROOTS: PRIVATE }, now: NOW, deploymentDir: "/deployment", reads });
    noSecrets(out);
    assert.deepEqual(calls.map(([name]) => name), ["fleet", "snapshot", kind, "dispose"]);
    assert.equal(calls[0][1].readOnly, true);
    assert.equal(calls[0][1].nowFn(), NOW);
    assert.deepEqual(calls[1][1], {}, "these tools do not hydrate waiting jobs");
    if (kind === "secrets") assert.equal(out.projects[0].variables, 1);
    else { assert.equal(out.mcp.servers[0].referenceCount, 1); assert.equal(out.providers[0].fromEnv[0], "ANTHROPIC_API_KEY"); }
  }
});

test("connection projection rebuilds every nested record, preserves unknown sources, and rejects metadata smuggled into arrays", () => {
  const view = { forges: [{ name: "github", enabled: true, path: PRIVATE, source: "app", activationKeys: ["GITHUB_AUTH_SOURCE", VARIABLE], secret: { key: VARIABLE, set: true, value: VALUE }, triggers: [0] }], egress: { on: true, hosts: [{ name: "mini1", proxy: { level: "fail", label: VALUE }, stale: true }] }, endpointFleetDeclared: true, endpoints: [{ id: "local-model", host: "127.0.0.1", port: 11434, keyless: true, slots: 3, used: 2, path: PRIVATE, secret: VALUE, variable: VARIABLE }, { id: PRIVATE, host: PRIVATE }], providers: [{ name: "anthropic", variables: [VARIABLE], fromEnv: [VARIABLE, "ANTHROPIC_API_KEY"], unknown: true, fallback: "pi login on each host is configured", key: VALUE }], mcp: { servers: [{ name: "tracker", transport: "http", enabled: true, refs: [VARIABLE], where: PRIVATE }], refused: ["dispatch-admin", { name: "x", value: VALUE }, PRIVATE] }, packages: { packages: ["@acme/tool@1.2.3", { name: "tool", secret: VALUE }, PRIVATE], stagedAt: PRIVATE }, environment: [{ key: "PI_SECRET_PROFILES", value: "set", raw: VALUE }, { key: VARIABLE, value: "set" }] };
  const result = modelConnections(view);
  noSecrets(result);
  assert.deepEqual(result.endpoints, [{ id: "local-model", host: "127.0.0.1", port: 11434, keyless: true, slots: 3, counting: "fleet", used: 2 }]);
  assert.equal(result.forges[0].path, "/");
  assert.deepEqual(result.forges[0].secret, { key: "WEBHOOK_SECRET", set: true });
  assert.deepEqual(result.mcp.refused, ["dispatch-admin"]);
  assert.deepEqual(result.packages, { names: ["@acme/tool@1.2.3"], stagedAt: null, unreadable: false });
  assert.equal(result.providers[0].unknown, true);
  assert.deepEqual(result.providers[0].fromEnv, ["ANTHROPIC_API_KEY"]);
  assert.equal(result.providers[0].selectedVariable, null);
  assert.equal(result.providers[0].credentialSource, "unknown");
  const forgedSelection = modelConnections({ ...view, providers: [{ ...view.providers[0], unknown: false, fromEnv: ["ANTHROPIC_API_KEY", VARIABLE, "ANTHROPIC_OAUTH_TOKEN"], selectedVariable: VALUE, credentialSource: VALUE, loginFallback: false }] });
  noSecrets(forgedSelection);
  assert.equal(forgedSelection.providers[0].selectedVariable, "ANTHROPIC_OAUTH_TOKEN", "the projection rebuilds selection in the pinned candidate order rather than trusting supplied metadata");
  assert.equal(forgedSelection.providers[0].credentialSource, "deployment-env");
  assert.equal(forgedSelection.providers[0].loginFallback, false);
});

test("endpoint model projection rebuilds counting coverage and rejects invented zero for uncounted aliases or deployment state", () => {
  const endpoints = [
    { id: "host-model", host: "HOST.DOCKER.INTERNAL", port: 11434, slots: 2, counting: "fleet", used: 0, holder: VALUE },
    { id: "shared-model", host: "models.example.com", port: 443, slots: 2, counting: "fleet", used: 0, holder: VALUE },
    { id: "unsafe-host", host: PRIVATE, port: 443, slots: 2, counting: "fleet", used: 0 },
  ];
  for (const declared of [true, false, null, VALUE]) {
    const out = modelConnections({ endpointFleetDeclared: declared, endpoints });
    noSecrets(out);
    assert.deepEqual(out.endpoints.map((ep) => [ep.counting, ep.used]), [["per-machine", null], [declared === true ? "fleet" : declared === false ? "worker-name-absent" : "unknown", declared === true ? 0 : null], ["unknown", null]]);
    assert.equal(out.endpoints[2].host, null);
  }
});

test("the connection read tool keeps not-counted and unavailable endpoint scopes distinct from a measured fleet zero", async () => {
  for (const mode of ["named", "unnamed", "unreadable"]) {
    const calls = [];
    let slotReads = 0;
    const out = await readConfigTool("connections", { paths, now: NOW, deploymentDir: "/deployment", env: { PI_WORKER_NAME: "SHELL_WORKER_CANARY" }, reads: {
      fleet: fleetOf(snapshotOf(), calls),
      connections: (args) => readConnections({ ...args, redis: {}, reads: {
        environment: () => ({ env: mode === "unnamed" ? {} : { PI_WORKER_NAME: "FILE_WORKER_CANARY" }, ...(mode === "unreadable" ? { unreadable: true } : {}) }),
        allowlist: () => [],
        endpoints: () => [{ id: "host-model", host: "host.containers.internal", port: 11434, slots: 1 }, { id: "shared-model", host: "models.example.com", port: 443, slots: 3 }],
        slots: (_client, endpoints) => { slotReads++; assert.deepEqual(endpoints.map((ep) => ep.id), ["shared-model"]); return [0]; },
      } }),
    } });
    noSecrets(out);
    assert.doesNotMatch(JSON.stringify(out), /SHELL_WORKER_CANARY|FILE_WORKER_CANARY/);
    assert.equal(slotReads, mode === "named" ? 1 : 0);
    assert.deepEqual(out.endpoints.map((ep) => [ep.counting, ep.used]), [["per-machine", null], [mode === "named" ? "fleet" : mode === "unnamed" ? "worker-name-absent" : "unknown", mode === "named" ? 0 : null]]);
    assert.equal(calls.at(-1)[0], "dispose");
  }
});

test("all project rows share one history, source and sizing read while exact current tool fields and safe new facts survive", async () => {
  const calls = [];
  const count = {};
  const declarations = { projects: [{ id: "billing", name: "Billing", members: ["github:acme/billing"] }, { id: "web", name: "Web", members: ["github:acme/web"] }] };
  const track = (key, value) => (...args) => { count[key] = (count[key] ?? 0) + 1; return typeof value === "function" ? value(...args) : value; };
  const limits = { limits: [{ scope: "project:billing" }, { scope: "project:web" }] };
  const projectSources = { triggers: track("triggers", { triggers: [] }), settings: track("settings", { overlay: {} }), subscriptions: track("subscriptions", { subscriptions: [] }), environment: track("environment", { env: {} }), scan: track("scan", []), allocation: track("allocation", { unset: true }), sizing: track("sizing", (opts) => { assert.deepEqual(opts.projectIds, ["billing", "web"]); return { projects: {} }; }) };
  const out = await readConfigTool("projects", { paths, now: NOW, deploymentDir: "/deployment", reads: { fleet: fleetOf({}, calls), projects: track("projects", declarations), limits: track("limits", limits), projectSources, project: async (opts) => {
    const r = opts.reads;
    assert.strictEqual(r.projects(), declarations);
    assert.strictEqual(r.limits(), limits);
    r.triggers({}); r.settings({}); r.subscriptions({}); r.environment({}); r.scan({}); await r.allocation({}); r.sizing({ projectIds: [opts.id] });
    const view = consoleProjectFixture(NOW); view.id = opts.id; view.bundle.last.variables = [VARIABLE]; view.sizing.secret = VALUE; view.sizing.path = PRIVATE;
    return view;
  } } });
  noSecrets(out);
  assert.deepEqual(count, { projects: 1, limits: 1, triggers: 1, settings: 1, subscriptions: 1, environment: 1, scan: 1, allocation: 1, sizing: 1 });
  assert.deepEqual(out.projects.map((p) => [p.id, p.members, p.limitRows]), [["billing", ["github:acme/billing"], [0]], ["web", ["github:acme/web"], [1]]]);
  assert.equal(out.projects[0].spend.usedMicros, 8_100_000);
  assert.equal(out.projects[0].spend.heldMicros, 2_000_000);
  assert.equal(out.projects[0].bundle.variables, 1);
  assert.equal(out.projects[0].suggestion.call, 'dispatch_limit_edit {"index":2,"memory":"4g","cpus":2}');
  assert.equal(out.projects[0].editRefusal, "Members cannot be edited while secret bundle billing names billing. Change the bundle in triggers.json first.");
  assert.equal(calls.filter(([name]) => name === "runsPage").length, 1);
  assert.deepEqual(calls.find(([name]) => name === "snapshot")[1], { waiting: true });
  assert.equal(calls.at(-1)[0], "dispose");
});

test("tool read failures preserve unavailable states and always release resources; invalid kinds and unset projects read no fleet", async () => {
  const calls = [];
  assert.deepEqual(await readConfigTool("projects", { paths, now: NOW, reads: { projects: () => ({ unset: true }), fleet: () => { throw Error("must not create"); } } }), { unset: true });
  await assert.rejects(readConfigTool("unknown", { paths, now: NOW, reads: { fleet: () => { throw Error("must not create"); } } }), /unknown configuration tool/);
  const out = await readConfigTool("secrets", { paths, now: NOW, reads: { fleet: fleetOf(null, calls, { failSnapshot: true }) } });
  assert.equal(out.available, false);
  noSecrets(out);
  assert.equal(calls.at(-1)[0], "dispose");
  const failure = [];
  await assert.rejects(readConfigTool("connections", { paths, now: NOW, reads: { fleet: fleetOf({}, failure), connections: () => { throw Error("synthetic source failure"); } } }), /synthetic source failure/);
  assert.equal(failure.at(-1)[0], "dispose");
});

test("registered dispatch_secrets, dispatch_connections and dispatch_projects execute the safe read path without confirmations", async () => {
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldLogs = process.env.PI_LOGS_DIR;
  process.env.PI_CODING_AGENT_DIR = tempDir("pi-751-tools-agent-");
  process.env.PI_LOGS_DIR = tempDir("pi-751-tools-logs-");
  const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = piRequire("jiti");
  const jiti = createJiti(import.meta.url);
  const module = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
  const registered = [];
  module.default(new Proxy({}, { get: (_target, key) => key === "registerTool" ? (tool) => registered.push(tool) : () => {} }));
  const events = [];
  module.setConfigToolReadsForTest({ projects: () => ({ projects: [{ id: "billing", name: "Billing", members: ["github:acme/billing"] }] }), limits: () => ({ limits: [] }), fleet: fleetOf(snapshotOf(), events), secrets: (args) => secretsView({ ...args, fs: { realpathSync: (p) => p } }), connections: (args) => readConnections({ ...args, reads: { environment: () => ({ env: { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: VALUE } }), endpoints: () => [], allowlist: () => [] } }), project: () => { const out = consoleProjectFixture(NOW); out.bundle.last.variables = [VARIABLE]; return out; } });
  try {
    for (const name of ["dispatch_secrets", "dispatch_connections", "dispatch_projects"]) {
      const tools = registered.filter((tool) => tool.name === name);
      assert.equal(tools.length, 1, name);
      const response = await tools[0].execute("call", {}, null, null, { hasUI: false, ui: { confirm() { throw Error("read tools must not ask for a confirmation"); } } });
      const parsed = JSON.parse(response.content.find((c) => c.type === "text").text);
      noSecrets(parsed);
      assert.ok(name === "dispatch_secrets" ? parsed.profiles.some((p) => p.name === "prod") : name === "dispatch_connections" ? parsed.mcp.servers.some((s) => s.name === "tracker" && s.referenceCount === 1) : parsed.projects[0].suggestion.action.action === "limit-edit" && parsed.projects[0].suggestion.action.index === 2);
    }
    assert.equal(events.filter(([key]) => key === "dispose").length, 3);
  } finally {
    module.setConfigToolReadsForTest({});
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldLogs === undefined) delete process.env.PI_LOGS_DIR; else process.env.PI_LOGS_DIR = oldLogs;
  }
});
