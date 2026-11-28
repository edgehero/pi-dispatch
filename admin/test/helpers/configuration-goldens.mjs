import { makeReceiverObservations } from "@edgehero/pi-dispatch/receiver-status";
import { consoleSubscriptionFixture } from "./subscription-auth-fixture.mjs";
/** #751 exceptional states, over production read projections and the production page renderer. */
import assert from "node:assert/strict";
import { NOW } from "../../../launch/fixture-deployment.mjs";
import { secretsView } from "../../src/secrets-view.mjs";
import { readConnections } from "../../src/connections-view.mjs";
import { loadPageData, parsePageQuery, renderPage } from "../../src/console/pages.mjs";
import { noSnapshotFleet, outagePaths } from "./no-snapshot.mjs";
import { consoleProjectFixture } from "./console-project-fixture.mjs";
import { projectSizeAction, readProjectView } from "../../src/project-view.mjs";
import { projectLoadsOf } from "../../src/loaded-words.mjs";
import { buildHookRun } from "@edgehero/pi-dispatch/hook-runs";

export function consoleSecretsFixture(now, { env: extra = {}, change = () => {} } = {}) {
  if (!Number.isFinite(now)) throw new TypeError("consoleSecretsFixture needs the injected page clock");
  const env = { PI_SECRET_PROFILES: "default:/opt/default", PI_SECRET_BUNDLES: "env-bundle:/opt/env-bundle:dotenv", PI_SECRET_RESOLVER_ROOTS: "/srv/resolvers", ...extra };
  const snapshot = {
    settings: { overlay: { secretProfiles: { prod: "/srv/resolvers/read-prod" }, secretBundles: { shop: { path: "/srv/resolvers/read-shop", format: "json" } } } },
    triggers: { triggers: [{ index: 0, id: "nightly", type: "cron", pattern: "0 3 * * *", folder: "/srv/shop", secrets: 1, secretsProfile: "prod" }, { index: 1, type: "comment", secrets: 1, secretsProfile: "default", secretBundle: false }], secretBundles: [{ id: "shop", profile: "shop", project: "shop", forkReviews: false, endpoints: [{ name: "API_TOKEN", host: "api.example.com" }] }] },
    projects: { projects: [{ id: "shop", members: ["/srv/shop"] }] },
    runs: [{ jobId: "gh-new", endedAt: new Date(now - 60_000).toISOString(), secretsProfile: "prod", outcome: "completed", bundle: { id: "shop", variables: ["DB_URL", "API_TOKEN"], shadowed: [] } }],
    hosts: [{ name: "mini1", caps: ["s:prod", "s:default"], capsSeen: true }],
    schedulers: [{ key: "nightly", pattern: "0 3 * * *", next: now + 60_000 }],
  };
  change(snapshot, env);
  return secretsView({ snapshot, env, fs: { realpathSync: (path) => path } });
}

export function receiverFixture(now, { onlyUnauthorized = false, answered503 = false, forges = ["github", "gitlab"] } = {}) {
  const observations = makeReceiverObservations({ now: () => now - 8000 });
  if (!onlyUnauthorized) observations.observe("github", 202, "queued");
  observations.observe("github", 401);
  if (answered503) for (const [forge, word] of [["github", "enqueue-failed"], ["github", "enqueue-failed"], ["github", "lookup-failed"], ["gitlab", "lookup-failed"]]) observations.observe(forge, 503, word);
  return { v: 1, name: "mini1", version: "4.3.1", startedAt: now - 60_000, at: now - 8000, port: 3000, bind: "all", forges, deliveries: observations.snapshot(), ageMs: 8000 };
}

/**
 * `outage` (issue #1073): Connections over a Valkey that does not answer, as the console reads it: no snapshot, the file
 * views the page's load read (`files`), and every publication read failing. The `.env`, the allowlist and the endpoint
 * files are the fixture's, so what the page says of the files and of Valkey is the reader's own.
 */
export async function consoleConnectionsFixture(now, { problem = null, unread = false, change = () => {}, outage = false, files = null } = {}) {
  if (!Number.isFinite(now)) throw new TypeError("consoleConnectionsFixture needs the injected page clock");
  const env = { GITHUB_AUTH_SOURCE: "app", WEBHOOK_SECRET: "fixture-only", GITLAB_WEBHOOK_MODE: "signature", GITLAB_WEBHOOK_SECRET: "fixture-only", GITLAB_TOKEN: "fixture-only", RECEIVER_PORT: "3000", PI_WORKER_NAME: "build3", PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "fixture-only", PI_ON_FAILURE: "/srv/hooks/notify", PI_BACKENDS: "local,podman" };
  const checks = [{ id: "egress.proxy", level: "ok", label: "The egress proxy is running" }];
  if (problem === "proxy") checks[0] = { id: "egress.proxy", level: "fail", label: "The egress proxy is missing", fix: "Run pi-dispatch up on that host." };
  if (problem === "forge") checks.push({ id: "github.auth", level: "fail", label: "GitHub credentials cannot be used", fix: "Check the GitHub App declaration." });
  if (problem === "endpoints") checks.push({ id: "model-endpoints.file", level: "fail", label: "Endpoint 2: port must be 1 to 65535", fix: "Correct model-endpoints.json and render egress rules." });
  const snapshot = {
    settings: { overlay: {} }, triggers: { triggers: [{ index: 2, forge: "github", type: "comment", statusComment: true, packages: false, privateEndpoints: ["bench-device"] }, { index: 3, forge: "gitlab", type: "pull_request", privateEndpoints: ["lab-ssh"] }] },
    hostBudgets: [{ name: "build3" }], doctor: { hosts: [{ name: "build3", at: now - 2 * 3_600_000, ageMs: 2 * 3_600_000, every: 24, checks }] },
    runs: [{ jobId: "gh-e9a0", host: "build3", reason: "egress-proxy-missing", endedAt: new Date(now - 9 * 60_000).toISOString() }],
    overlayMcp: { servers: [{ name: "linear", transport: "http", where: "mcp.example.com", exposure: "codemode", enabled: true, refs: ["LINEAR_API_KEY"] }], refused: ["dispatch-notes"], problems: [{ name: "dispatch-notes", problem: "a name holding dispatch is reserved for the dispatch admin" }] },
    stagedPackages: { stagedAt: new Date(now - 7 * 86_400_000).toISOString(), packages: ["pi-lint@1.4.2", "pi-test-runner@0.9.0"] },
  };
  const reads = {
    environment: () => unread ? { unreadable: true } : { env },
    allowlist: () => ["api.github.com", ".githubusercontent.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "mcp.example.com", "api.example.com", "gitlab.example.com", "more.example.com"],
    endpoints: () => [{ id: "ollama-mini2", host: "mini2.lan", port: 11434, keyless: true, slots: 2 }, { id: "vllm-build3", host: "10.0.0.5", port: 8000, keyless: true, slots: 4 }],
    // Issue #918: one device this folder declares, granted to trigger 2; trigger 3 names one it does not declare.
    privateEndpoints: () => [{ id: "bench-device", host: "10.0.5.20", port: 22, slots: 1 }],
    slots: async () => [1, 0],
    endpointStatus: async () => ({ state: "reported", partial: false, more: 0, hosts: [
      { name: "mini2", at: now - 1000, ageMs: 1000, state: "reported", endpointsMore: 0, endpoints: [{ id: "ollama-mini2", slots: 2, used: 1, fleet: 1 }] },
      { name: "build3", at: now - 2000, ageMs: 2000, state: "reported", endpointsMore: 0, endpoints: [{ id: "vllm-build3", slots: 4, used: 0, fleet: 1 }] },
    ] }),
    receivers: async () => ({ hosts: [receiverFixture(now)], complete: true, more: 0 }),
    // No poller heartbeat read (issue #970): a source that answers nothing leaves the view without one, so the goldens draw
    // GitHub's polling cell as before. admin/test/connections-poller.test.mjs holds the poller's words in each state.
    pollers: async () => undefined,
    hookRuns: async () => ({ partial: false, more: 0, hosts: [] }),
  };
  reads.providerInventory = {
    environment: options => reads.environment(options),
    settings: () => ({ overlay: snapshot.settings.overlay }),
    document: () => ({ triggers: [] }),
  };
  change(snapshot, reads);
  if (outage) {
    const fail = async () => { throw new Error("Valkey does not answer"); };
    Object.assign(reads, { slots: fail, endpointStatus: fail, receivers: fail, pollers: fail, hookRuns: fail });
    reads.providerInventory = { ...reads.providerInventory, settings: () => ({ overlay: files?.settings?.overlay ?? {} }) };
    return readConnections({ deploymentDir: "/srv/deployment", paths: {}, env: { RECEIVER_PORT: "4000" }, snapshot: null, files, now, redis: {}, reads });
  }
  return readConnections({ deploymentDir: "/srv/deployment", paths: {}, env: { RECEIVER_PORT: "4000" }, snapshot, now, redis: {}, reads });
}

/** What the deployment's files and its .env declare of secrets, as the reader's `fileViews` holds them (issue #962): no run and no host among them. */
export function secretFilesFixture() {
  return {
    settings: { overlay: { secretProfiles: { prod: "/srv/resolvers/read-prod" }, secretBundles: { shop: { path: "/srv/resolvers/read-shop", format: "json" } } } },
    triggers: { triggers: [{ index: 0, id: "nightly", type: "cron", pattern: "0 3 * * *", folder: "/srv/shop", secrets: 1, secretsProfile: "prod" }, { index: 1, type: "comment", secrets: 1, secretsProfile: "default", secretBundle: false }], secretBundles: [{ id: "shop", profile: "shop", project: "shop", forkReviews: false, endpoints: [{ name: "API_TOKEN", host: "api.example.com" }] }] },
    projects: { projects: [{ id: "shop", members: ["/srv/shop"] }] },
  };
}
export const SECRET_FILES_ENV = Object.freeze({ PI_SECRET_PROFILES: "default:/opt/default", PI_SECRET_BUNDLES: "env-bundle:/opt/env-bundle:dotenv", PI_SECRET_RESOLVER_ROOTS: "/srv/resolvers" });

async function draw(page, { role = "operator", readOnly = false, secrets = null, connections = undefined, connectionsRead = null, project = null, projectRead = null, id = "billing", status = 200, fleet = null, secretsFromFiles = false } = {}) {
  const parsed = parsePageQuery(page, page === "project" ? `id=${id}` : "");
  assert.ok(!parsed.refusal, `${page}: fixture query is valid`);
  const data = await loadPageData(page, parsed.query, {
    now: () => NOW, env: {}, fleet: fleet ?? { snapshot: async () => ({ parked: [] }), parkedCount: async () => 0 },
    secretsView: async (snapshot, files) => secretsFromFiles ? secretsView({ snapshot, files, env: SECRET_FILES_ENV, fs: { realpathSync: (path) => path } }) : secrets ?? consoleSecretsFixture(NOW),
    connections: connectionsRead ?? (async () => connections === undefined ? await consoleConnectionsFixture(NOW) : connections),
    setup: () => ({ enabled: true, actions: ["setup-provider-key", "setup-provider-key-replace"] }),
    projectView: projectRead ?? (async () => project ?? consoleProjectFixture(NOW)),
  }, { role, readOnly });
  const result = await renderPage(page, { session: { name: role === "viewer" ? "watcher" : "ops", role }, query: parsed.query, data, readOnly, theme: null });
  assert.equal(result.status, status, `${page}: the fixture's actual HTTP state`);
  return String(result.html);
}
const secret = (options, role = "operator", readOnly = false) => draw("secrets", { secrets: consoleSecretsFixture(NOW, options), role, readOnly });
const connection = async (options, role = "operator", readOnly = false) => draw("connections", { connections: await consoleConnectionsFixture(NOW, options), role, readOnly });
const project = (change = () => {}, role = "operator", readOnly = false) => { const value = consoleProjectFixture(NOW); change(value); return draw("project", { project: value, role, readOnly }); };

export const CONFIGURATION_DRAW = Object.freeze({
  // Issue #844: /config over a Valkey that does not answer. The file-backed cards and their tab counts come from the
  // files; the secret cards, whose facts are Valkey's too, say they could not be read.
  "config-no-snapshot.operator": () => draw("config", { fleet: noSnapshotFleet() }),
  "config-no-snapshot.viewer": () => draw("config", { role: "viewer", fleet: noSnapshotFleet() }),
  // Issue #1073: /config where the console's own code failed reading the deployment (an engine error, not Valkey): the
  // cards say so, and that the console's log names the error, where they said Valkey could not be read.
  "config-console-fault.operator": () => draw("config", { fleet: noSnapshotFleet({ snapshot: async () => { const row = null; return row.name; } }) }),
  // Issue #962: /config/secrets over a Valkey that does not answer. The declarations come from the files and the .env,
  // read-only; what a run last received and which hosts serve a profile are not known.
  "secrets-no-snapshot.operator": () => draw("secrets", { fleet: noSnapshotFleet({ fileViews: secretFilesFixture }), secretsFromFiles: true }),
  // Issue #1073: the Secrets page over a settings overlay nobody could read: a profile and a bundle resolver the .env
  // declares may be declared there too, and a bundle whose resolver the .env does not declare is not "missing".
  "secrets-overlay-unread.operator": () => secret({ change: (s, e) => { s.settings = { path: "/srv/deployment/settings.json", invalid: "settings file unreadable (EACCES)" }; e.PI_SECRET_BUNDLES = ""; } }),
  // Issue #1073: Connections over a Valkey that does not answer: the triggers, the overlay's MCP servers and the staged
  // packages from the files, and what only Valkey holds (hosts, doctor, receivers, subscriptions) not known.
  "connections-no-snapshot.operator": () => draw("connections", { fleet: noSnapshotFleet(), connectionsRead: (snapshot, { files } = {}) => consoleConnectionsFixture(NOW, { outage: true, files }) }),
  // Issue #1073: a project's page over a Valkey that does not answer, read by the real project view over the outage's files.
  "project-no-snapshot.operator": () => { const fleet = noSnapshotFleet(); return draw("project", { fleet, id: "web", projectRead: (id, snapshot, { within } = {}) => readProjectView({ id, snapshot, paths: outagePaths(), env: {}, deploymentDir: null, fleet, now: NOW, within }) }); },
  "secrets-populated.operator": () => secret({}),
  "secrets-populated.viewer": () => secret({}, "viewer"),
  "secrets-readonly.operator": () => secret({}, "operator", true),
  "secrets-malformed-profile.operator": () => secret({ env: { PI_SECRET_PROFILES: "bad" } }),
  "secrets-malformed-bundle.operator": () => secret({ env: { PI_SECRET_BUNDLES: "bad" } }),
  "secrets-ambiguous-profile.operator": () => secret({ env: { PI_SECRET_PROFILES: "prod:/opt/env-prod" } }),
  "secrets-ambiguous-bundle.operator": () => secret({ env: { PI_SECRET_BUNDLES: "shop:/opt/env-shop:json" } }),
  "secrets-empty-roots.operator": () => secret({ env: { PI_SECRET_RESOLVER_ROOTS: "" } }),
  "secrets-outside-profile.operator": () => secret({ change: (s) => { s.settings.overlay.secretProfiles.prod = "/opt/outside/read-prod"; } }),
  "secrets-outside-bundle.operator": () => secret({ change: (s) => { s.settings.overlay.secretBundles.shop.path = "/opt/outside/read-shop"; } }),
  "secrets-missing-profile.operator": () => secret({ change: (s) => { delete s.settings.overlay.secretProfiles.prod; } }),
  "secrets-missing-bundle.operator": () => secret({ change: (s, e) => { delete s.settings.overlay.secretBundles.shop; e.PI_SECRET_BUNDLES = ""; } }),
  "secrets-unserved.operator": () => secret({ change: (s) => { s.hosts = []; } }),
  "secrets-empty.viewer": () => secret({ change: (s, e) => { s.settings.overlay = {}; s.triggers = { triggers: [], secretBundles: [] }; s.runs = []; e.PI_SECRET_PROFILES = ""; e.PI_SECRET_BUNDLES = ""; } }, "viewer"),
  "connections-subscription.operator": () => connection({ change: s => { s.subscriptionAuth = consoleSubscriptionFixture(NOW); } }),
  "connections-subscription.viewer": () => connection({ change: s => { s.subscriptionAuth = consoleSubscriptionFixture(NOW); } }, "viewer"),
  "connections-subscription-reauth.operator": () => connection({ change: s => { s.subscriptionAuth = consoleSubscriptionFixture(NOW, v => { v.connections[0].state = "reauth-required"; v.connections[0].expiresAt = NOW - 1; }); } }),
  "connections-subscription-conflict.operator": () => connection({ change: s => { s.subscriptionAuth = consoleSubscriptionFixture(NOW, v => { v.connections[0].state = "adapter-unavailable"; v.connections[0].compatibility = "conflicting"; }); } }),
  "connections-subscription-long.operator": () => connection({ change: s => { s.subscriptionAuth = consoleSubscriptionFixture(NOW, v => { v.connections[0].id = "a".repeat(64); v.connections[0].ownerHost = "h".repeat(64); v.connections[0].adapter = "@gotgenes/pi-anthropic-auth@3.4.3"; }); } }),
  "connections-receiver-none.operator": () => connection({ change: (_, r) => { r.receivers = async () => ({ hosts: [], complete: true, more: 0 }); } }),
  "connections-receiver-unauthorized.viewer": () => connection({ change: (_, r) => { r.receivers = async () => ({ hosts: [receiverFixture(NOW, { onlyUnauthorized: true })], complete: true, more: 0 }); } }, "viewer"),
  "connections-receiver-unknown.viewer": () => connection({ change: (_, r) => { r.receivers = async () => ({ hosts: [], complete: false, more: 0 }); } }, "viewer"),
  "connections-receiver-503.operator": () => connection({ change: (_, r) => { r.receivers = async () => ({ hosts: [receiverFixture(NOW, { answered503: true })], complete: true, more: 0 }); } }),
  "connections-proxy.operator": () => connection({ problem: "proxy" }),
  "connections-forge.operator": () => connection({ problem: "forge" }),
  "connections-hook-timeout.operator": () => connection({ change: (_, reads) => { reads.hookRuns = () => ({ partial: false, more: 0, hosts: [{ name: "mini1", runs: [buildHookRun({ jobId: "gh-f0c2", outcome: "failed", reason: "infra", detail: "timeout", code: null }, NOW - 60_000)] }] }); } }),
  "connections-hook-timeout.viewer": () => connection({ change: (_, reads) => { reads.hookRuns = () => ({ partial: false, more: 0, hosts: [{ name: "mini1", runs: [buildHookRun({ jobId: "gh-f0c2", outcome: "failed", reason: "infra", detail: "timeout", code: null }, NOW - 60_000)] }] }); } }, "viewer"),
  "connections-hook-unreadable.viewer": () => connection({ change: (_, reads) => { reads.hookRuns = () => ({ partial: true, more: 3, hosts: [{ name: "build3", runs: [], unreadable: true }] }); } }, "viewer"),
  "connections-receiver-missing-secret.operator": () => connection({ change: (_, r) => { r.environment = () => ({ env: { GITHUB_AUTH_SOURCE: "gh" } }); } }),
  // Issue #879: GitHub polled on purpose (`setup github --no-webhook`'s .env, with no webhook secret), beside GitLab by
  // webhook, and a GITHUB_INGEST every receiver command refuses.
  // A live receiver that started before GitHub was armed: it reports, serves GitLab, and not GitHub.
  "connections-receiver-restart.operator": () => connection({ change: (_, r) => { r.receivers = async () => ({ hosts: [receiverFixture(NOW, { forges: ["gitlab"] })], complete: true, more: 0 }); } }),
  "connections-github-polled.operator": () => connection({ change: (_, r) => { const original = r.environment; r.environment = (o) => { const { WEBHOOK_SECRET: _w, ...env } = original(o).env; return { env: { ...env, GITHUB_INGEST: "poll" } }; }; } }),
  "connections-github-ingest-refused.operator": () => connection({ change: (_, r) => { const original = r.environment; r.environment = (o) => ({ env: { ...original(o).env, GITHUB_INGEST: "pull" } }); } }),
  "connections-endpoint-bounds.operator": () => connection({ change: (_, r) => { r.endpointStatus = async () => ({ state: "reported", partial: false, more: 0, hosts: [
    { name: "mini1", at: NOW - 1000, ageMs: 1000, state: "reported", endpointsMore: 0, endpoints: [{ id: "ollama-mini2", slots: 2, used: 1, fleet: 1 }] },
    { name: "mini2", at: NOW - 2000, ageMs: 2000, state: "reported", endpointsMore: 0, endpoints: [{ id: "ollama-mini2", slots: 3, used: 2, fleet: 1 }] },
  ] }); } }),
  "connections-endpoint-occupancy-unknown.viewer": () => connection({ change: (_, r) => { r.endpointStatus = async () => ({ state: "reported", partial: true, more: 1, hosts: [
    { name: "mini1", at: null, ageMs: null, state: "unsupported", endpointsMore: null, endpoints: null },
    { name: "mini2", at: null, ageMs: null, state: "unreadable", endpointsMore: null, endpoints: null },
    { name: "build3", at: null, ageMs: null, state: "not-reported", endpointsMore: null, endpoints: null },
  ] }); } }, "viewer"),
  "connections-endpoints.operator": () => connection({ problem: "endpoints" }),
  "connections-mcp-compact.viewer": () => connection({ change: (s) => { s.overlayMcp.servers.push({ name: "docs", transport: "stdio", where: "npx docs-mcp", exposure: "deferred", enabled: false, refs: ["DOCS_KEY"] }, { name: "search", transport: "http", where: "search.example.com", exposure: "direct", enabled: true, refs: ["SEARCH_KEY"] }); } }, "viewer"),
  "connections-many-triggers.operator": () => connection({ change: (s) => { s.triggers.triggers.push(...Array.from({ length: 12 }, (_, n) => ({ index: n + 4, forge: "github", type: "comment" }))); } }),
  "connections-populated.viewer": () => connection({}, "viewer"),
  "connections-provider-multiple.operator": () => connection({ change: (_, reads) => { const original = reads.environment; reads.environment = options => { const got = original(options); return { ...got, env: { ...got.env, OPENAI_API_KEY: "fixture-only", GEMINI_API_KEY: "fixture-only" } }; }; } }),
  "connections-provider-shared.operator": () => connection({ change: (_, reads) => { const original = reads.environment; reads.environment = options => { const got = original(options); return { ...got, env: { ...got.env, MOONSHOT_API_KEY: "fixture-only" } }; }; } }),
  "connections-provider-shadowed.operator": () => connection({ change: (_, reads) => { const original = reads.environment; reads.environment = options => { const got = original(options); return { ...got, env: { ...got.env, ANTHROPIC_AUTH_TOKEN: "fixture-only" } }; }; } }),
  // Issue #1068: the region variable both Qwen Token Plan plans shared, alone: each plan reads as set by it, Add offered.
  "connections-provider-fallback.operator": () => connection({ change: (_, reads) => { const original = reads.environment; reads.environment = options => { const got = original(options); return { ...got, env: { ...got.env, QWEN_TOKEN_PLAN_API_KEY: "fixture-only" } }; }; } }),
  "connections-readonly.operator": () => connection({}, "operator", true),
  "connections-metadata-unreadable.viewer": () => connection({ unread: true }, "viewer"),
  "connections-unavailable.viewer": () => draw("connections", { connections: null, role: "viewer" }),
  "connections-files-unreadable.viewer": () => connection({ change: (s, r) => { r.allowlist = () => { throw Error("unread"); }; r.endpoints = () => { throw Error("unread"); }; s.overlayMcp = null; s.stagedPackages = null; } }, "viewer"),
  "connections-leases-unknown.operator": () => connection({ change: (s, r) => { r.slots = async () => [null, null]; s.doctor.hosts[0].checks = []; } }),
  "connections-per-machine.operator": () => connection({ change: (_, r) => {
    r.endpoints = () => [
      { id: "docker-local", host: "host.docker.internal", port: 11434, keyless: true, slots: 2 },
      { id: "podman-local", host: "host.containers.internal.", port: 11434, keyless: true, slots: 4 },
      { id: "shared-model", host: "models.example.com", port: 443, keyless: false, slots: 3 },
    ];
    r.slots = async (_client, endpoints) => endpoints.map((endpoint) => endpoint.id === "shared-model" ? 1 : 0);
  } }),
  "connections-worker-scope-absent.viewer": () => connection({ change: (_, r) => {
    const original = r.environment;
    r.environment = (...args) => { const metadata = original(...args); const env = { ...metadata.env }; delete env.PI_WORKER_NAME; return { ...metadata, env }; };
  } }, "viewer"),
  "connections-worker-scope-unknown.viewer": () => connection({ change: (_, r) => {
    const original = r.environment;
    r.environment = (...args) => { const metadata = original(...args); return { ...metadata, env: { ...metadata.env, PI_WORKER_NAME: "invalid/name" } }; };
  } }, "viewer"),
  "project-members-editable.operator": () => project((p) => { p.bundle = null; p.editRefusal = null; }),
  "project-populated.operator": () => project(),
  "project-populated.viewer": () => project(() => {}, "viewer"),
  // Issue #962: the project page over a history that was not read whole and hosts that were not read. Nothing was found
  // in what was read, which is not "no retained run": the counts and the spend are floors, and the held money is unknown.
  "project-history-unread.operator": () => project((p) => {
    p.historyIncomplete = true;
    p.runs24h = { total: 0, counts: { completed: 0, failed: 0, refused: 0, cancelled: 0, "awaiting-input": 0, "awaiting-approval": 0 }, inLine: null, inLineIncomplete: false, worst: null };
    p.recent = []; p.totalRuns = 0; p.triggers = []; p.triggersKnown = true;
    p.members = p.members.map((m) => ({ ...m, count: 0, last: null }));
    p.spend = { window: "week", settledMicros: 0, heldMicros: null, heldKnownMicros: 0, heldIncomplete: true, heldUnread: true, usedMicros: null, shareMicros: null, envelope: false, floor: true };
    p.allocation = { ...p.allocation, unset: true, shareMicros: null };
    p.sizing = null; p.sizingUnreadable = true;
    p.loads = projectLoadsOf([], { historyIncomplete: true });
  }),
  "project-spend-unsplit.operator": () => project((p) => { p.spend.settledMicros = null; p.spend.heldMicros = null; p.spend.heldIncomplete = true; }),
  "project-readonly.operator": () => project(() => {}, "operator", true),
  "project-bundle-bound.operator": () => project((p) => { p.editRefusal = "Members cannot be edited while secret bundle billing names billing. Change the bundle in triggers.json first."; }),
  "project-no-envelope.operator": () => project((p) => { p.spend.envelope = false; p.spend.shareMicros = null; p.allocation.unset = true; p.allocation.shareMicros = null; }),
  "project-no-suggestion.viewer": () => project((p) => { p.sizing = { memory: { reason: "not-enough-runs" }, cpu: { reason: "not-enough-runs" }, words: { memory: "not enough measured runs", cpu: "not enough measured runs" }, call: null, series: [] }; }, "viewer"),
  "project-oom.operator": () => project((p) => { p.sizing.series[9].oom = true; p.sizing.series[9].peakMiB = 8192; }),
  // Fractional GiB tick labels are wider than whole GiB labels. The real width/CSP sweep
  // checks their font and bounds at every phone width, including the 320px shell floor.
  "project-fractional-memory.operator": () => project((p) => {
    p.size.memMiB = 512;
    p.limits[0].memory = "512m";
    p.sizing.memory = { current: 512, suggested: 256, reason: "oversized" };
    p.sizing.words.memory = "p95 peak 112m, largest 120m, over 23 runs";
    p.sizing.call = 'dispatch_limit_edit {"index":2,"memory":"256m","cpus":2}';
    p.sizing.action = projectSizeAction(p.sizing.call, p.id);
    p.sizing.series = p.sizing.series.map((point, index) => ({ ...point, peakMiB: 80 + (index * 7) % 41, sizeMiB: 512 }));
  }),
  "project-delete-allowed.operator": () => project((p) => { p.deleteRefusal = null; p.limits = []; p.bundle = null; p.allocation.floorMicros = 0; }),
  "project-delete-bundle.operator": () => project((p) => { p.deleteRefusal = "Delete project billing: refused while secret bundle billing names it. Change that bundle in triggers.json first."; }),
  "project-delete-floor.operator": () => project((p) => { p.deleteRefusal = "Delete project billing: refused while an envelope floor names it. Remove that floor first."; }),
  "project-not-found.operator": () => draw("project", { project: { id: "billing", state: "missing" }, status: 404 }),
  "project-not-found.viewer": () => draw("project", { project: { id: "billing", state: "missing" }, role: "viewer", status: 404 }),
  "project-unreadable.viewer": () => draw("project", { project: { id: "billing", state: "unreadable", problem: "The projects file could not be read. Reload to try again." }, role: "viewer", status: 503 }),
});
export const CONFIGURATION_PANEL_STATES = Object.freeze(Object.keys(CONFIGURATION_DRAW));
