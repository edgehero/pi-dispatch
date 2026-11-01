import { consoleSubscriptionFixture } from "./subscription-auth-fixture.mjs";
/** #751 exceptional states, over production read projections and the production page renderer. */
import assert from "node:assert/strict";
import { NOW } from "../../../launch/fixture-deployment.mjs";
import { secretsView } from "../../src/secrets-view.mjs";
import { readConnections } from "../../src/connections-view.mjs";
import { loadPageData, parsePageQuery, renderPage } from "../../src/console/pages.mjs";
import { consoleProjectFixture } from "./console-project-fixture.mjs";
import { projectSizeAction } from "../../src/project-view.mjs";
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

export async function consoleConnectionsFixture(now, { problem = null, unread = false, change = () => {} } = {}) {
  if (!Number.isFinite(now)) throw new TypeError("consoleConnectionsFixture needs the injected page clock");
  const env = { GITHUB_AUTH_SOURCE: "app", WEBHOOK_SECRET: "fixture-only", GITLAB_WEBHOOK_MODE: "signature", GITLAB_WEBHOOK_SECRET: "fixture-only", GITLAB_TOKEN: "fixture-only", RECEIVER_PORT: "3000", PI_WORKER_NAME: "build3", PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "fixture-only", PI_ON_FAILURE: "/srv/hooks/notify", PI_BACKENDS: "local,podman" };
  const checks = [{ id: "egress.proxy", level: "ok", label: "The egress proxy is running" }];
  if (problem === "proxy") checks[0] = { id: "egress.proxy", level: "fail", label: "The egress proxy is missing", fix: "Run pi-dispatch up on that host." };
  if (problem === "forge") checks.push({ id: "github.auth", level: "fail", label: "GitHub credentials cannot be used", fix: "Check the GitHub App declaration." });
  if (problem === "endpoints") checks.push({ id: "model-endpoints.file", level: "fail", label: "Endpoint 2: port must be 1 to 65535", fix: "Correct model-endpoints.json and render egress rules." });
  const snapshot = {
    settings: { overlay: {} }, triggers: { triggers: [{ index: 2, forge: "github", type: "comment", statusComment: true, packages: false }, { index: 3, forge: "gitlab", type: "pull_request" }] },
    hostBudgets: [{ name: "build3" }], doctor: { hosts: [{ name: "build3", at: now - 2 * 3_600_000, ageMs: 2 * 3_600_000, every: 24, checks }] },
    runs: [{ jobId: "gh-e9a0", host: "build3", reason: "egress-proxy-missing", endedAt: new Date(now - 9 * 60_000).toISOString() }],
    overlayMcp: { servers: [{ name: "linear", transport: "http", where: "mcp.example.com", exposure: "codemode", enabled: true, refs: ["LINEAR_API_KEY"] }], refused: ["dispatch-notes"], problems: [{ name: "dispatch-notes", problem: "a name holding dispatch is reserved for the dispatch admin" }] },
    stagedPackages: { stagedAt: new Date(now - 7 * 86_400_000).toISOString(), packages: ["pi-lint@1.4.2", "pi-test-runner@0.9.0"] },
  };
  const reads = {
    environment: () => unread ? { unreadable: true } : { env },
    allowlist: () => ["api.github.com", ".githubusercontent.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "mcp.example.com", "api.example.com", "gitlab.example.com", "more.example.com"],
    endpoints: () => [{ id: "ollama-mini2", host: "mini2.lan", port: 11434, keyless: true, slots: 2 }, { id: "vllm-build3", host: "10.0.0.5", port: 8000, keyless: true, slots: 4 }],
    slots: async () => [1, 0],
    hookRuns: async () => ({ partial: false, more: 0, hosts: [] }),
  };
  reads.providerInventory = {
    environment: options => reads.environment(options),
    settings: () => ({ overlay: snapshot.settings.overlay }),
    document: () => ({ triggers: [] }),
  };
  change(snapshot, reads);
  return readConnections({ deploymentDir: "/srv/deployment", paths: {}, env: { RECEIVER_PORT: "4000" }, snapshot, now, redis: {}, reads });
}

async function draw(page, { role = "operator", readOnly = false, secrets = null, connections = undefined, project = null, status = 200 } = {}) {
  const parsed = parsePageQuery(page, page === "project" ? "id=billing" : "");
  assert.ok(!parsed.refusal, `${page}: fixture query is valid`);
  const data = await loadPageData(page, parsed.query, {
    now: () => NOW, env: {}, fleet: { snapshot: async () => ({ parked: [] }), parkedCount: async () => 0 },
    secretsView: async () => secrets ?? consoleSecretsFixture(NOW),
    connections: async () => connections === undefined ? await consoleConnectionsFixture(NOW) : connections,
    setup: () => ({ enabled: true, actions: ["setup-provider-key", "setup-provider-key-replace"] }),
    projectView: async () => project ?? consoleProjectFixture(NOW),
  }, { role, readOnly });
  const result = await renderPage(page, { session: { name: role === "viewer" ? "watcher" : "ops", role }, query: parsed.query, data, readOnly, theme: null });
  assert.equal(result.status, status, `${page}: the fixture's actual HTTP state`);
  return String(result.html);
}
const secret = (options, role = "operator", readOnly = false) => draw("secrets", { secrets: consoleSecretsFixture(NOW, options), role, readOnly });
const connection = async (options, role = "operator", readOnly = false) => draw("connections", { connections: await consoleConnectionsFixture(NOW, options), role, readOnly });
const project = (change = () => {}, role = "operator", readOnly = false) => { const value = consoleProjectFixture(NOW); change(value); return draw("project", { project: value, role, readOnly }); };

export const CONFIGURATION_DRAW = Object.freeze({
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
  "connections-proxy.operator": () => connection({ problem: "proxy" }),
  "connections-forge.operator": () => connection({ problem: "forge" }),
  "connections-hook-timeout.operator": () => connection({ change: (_, reads) => { reads.hookRuns = () => ({ partial: false, more: 0, hosts: [{ name: "mini1", runs: [buildHookRun({ jobId: "gh-f0c2", outcome: "failed", reason: "infra", detail: "timeout", code: null }, NOW - 60_000)] }] }); } }),
  "connections-hook-timeout.viewer": () => connection({ change: (_, reads) => { reads.hookRuns = () => ({ partial: false, more: 0, hosts: [{ name: "mini1", runs: [buildHookRun({ jobId: "gh-f0c2", outcome: "failed", reason: "infra", detail: "timeout", code: null }, NOW - 60_000)] }] }); } }, "viewer"),
  "connections-hook-unreadable.viewer": () => connection({ change: (_, reads) => { reads.hookRuns = () => ({ partial: true, more: 3, hosts: [{ name: "build3", runs: [], unreadable: true }] }); } }, "viewer"),
  "connections-receiver-missing-secret.operator": () => connection({ change: (_, r) => { r.environment = () => ({ env: { GITHUB_AUTH_SOURCE: "gh" } }); } }),
  "connections-endpoints.operator": () => connection({ problem: "endpoints" }),
  "connections-mcp-compact.viewer": () => connection({ change: (s) => { s.overlayMcp.servers.push({ name: "docs", transport: "stdio", where: "npx docs-mcp", exposure: "deferred", enabled: false, refs: ["DOCS_KEY"] }, { name: "search", transport: "http", where: "search.example.com", exposure: "direct", enabled: true, refs: ["SEARCH_KEY"] }); } }, "viewer"),
  "connections-many-triggers.operator": () => connection({ change: (s) => { s.triggers.triggers.push(...Array.from({ length: 12 }, (_, n) => ({ index: n + 4, forge: "github", type: "comment" }))); } }),
  "connections-populated.viewer": () => connection({}, "viewer"),
  "connections-provider-multiple.operator": () => connection({ change: (_, reads) => { const original = reads.environment; reads.environment = options => { const got = original(options); return { ...got, env: { ...got.env, OPENAI_API_KEY: "fixture-only", GEMINI_API_KEY: "fixture-only" } }; }; } }),
  "connections-provider-shared.operator": () => connection({ change: (_, reads) => { const original = reads.environment; reads.environment = options => { const got = original(options); return { ...got, env: { ...got.env, MOONSHOT_API_KEY: "fixture-only" } }; }; } }),
  "connections-provider-shadowed.operator": () => connection({ change: (_, reads) => { const original = reads.environment; reads.environment = options => { const got = original(options); return { ...got, env: { ...got.env, ANTHROPIC_AUTH_TOKEN: "fixture-only" } }; }; } }),
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
