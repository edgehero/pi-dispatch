import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPageData, pagePanels, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { readConnections } from "../src/connections-view.mjs";
import { readModelsView } from "../src/models-view.mjs";
import { readConfigTool } from "../src/config-tools.mjs";
import { modelSecrets, secretsView } from "../src/secrets-view.mjs";
import { subscriptionAuthView, readSubscriptionAuthView, subscriptionAuthForAgent } from "../src/subscription-auth-view.mjs";
import { readProviderInventory, PROVIDER_KEY_REASONS } from "../src/provider-inventory.mjs";
import { SUBSCRIPTION_UNREAD_TITLE } from "../src/console/panels/subscription-auth.mjs";
import { CONNECTIONS_FROM_FILES_TEXT, EGRESS_HOSTS_UNREAD, GRANTS_UNREAD } from "../src/console/panels/connections.mjs";
import { SECRETS_AGENT_TEXT, SECRETS_OVERLAY_UNKNOWN, SECRETS_OVERLAY_UNKNOWN_TOO } from "../src/console/panels/secrets.mjs";
import { HOSTS_AS_LAST_READ, NO_HOST_AS_LAST_READ, hostsAsLastRead, hostsUnread } from "../src/console/panels/common.mjs";
import { REGISTRY_UNREAD_TEXT } from "../src/console/panels/overview.mjs";
import { SPLIT_UNSET_TEXT, splitAllocatedKpi, splitEnvelopeKpi, splitPlanKpi, splitRows, splitSpentKpi } from "../src/console/panels/spend.mjs";
import { noSnapshotFleet, fileViewsFixture } from "./helpers/no-snapshot.mjs";
import { CONFIGURATION_DRAW, SECRET_FILES_ENV, consoleConnectionsFixture, consoleSecretsFixture, secretFilesFixture } from "./helpers/configuration-goldens.mjs";
import { FLEET_DRAW, FLEET_CARD_SNAPSHOT } from "./helpers/fleet-goldens.mjs";

/**
 * What #988 left of the configuration pages and the history (issue #1073): with no snapshot a page draws what the
 * deployment's files hold, from the file views its load read; a read that failed this time is said as one, even after
 * an earlier read answered; and a page draws no amount over an envelope nobody read. Canned readers at a fixed instant,
 * the real reader over files where a test says so; nothing here dials a Valkey.
 */

const NOW = Date.UTC(2026, 9, 8, 15, 39, 0);
const OP = { name: "ops", role: "operator" };
const wordsOf = (markup) => String(markup).replace(/<(script|style|template)\b[^]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const fs = { realpathSync: (path) => path };

test("Connections with no snapshot reads the triggers, the overlay, its MCP servers and the staged packages from the file views", async () => {
  const files = { ...fileViewsFixture({ pinned: false }), overlayMcp: { servers: [{ name: "linear", transport: "http", where: "mcp.example.com", exposure: "codemode", enabled: true, refs: [] }] }, stagedPackages: { packages: ["pi-lint@1.4.2"] } };
  const view = await consoleConnectionsFixture(NOW, { outage: true, files });
  assert.equal(view.snapshotUnreadable, true);
  assert.equal(view.filesRead, true);
  assert.deepEqual(view.mcp.servers.map((s) => s.name), ["linear"], "the overlay's MCP servers, from the files");
  assert.deepEqual(view.packages.packages, ["pi-lint@1.4.2"]);
  assert.equal(view.privateEndpoints.triggersUnread, undefined, "the triggers were read: a grant to none is none");
  assert.equal(view.notify.triggersUnread, undefined);
  assert.equal(view.packageOptOuts, 0);
  assert.ok(view.forges.find((f) => f.name === "github").triggers.length > 0, "the label trigger arms GitHub, from the file");
  // With neither a snapshot nor file views the file sections are not known, as before.
  const neither = await consoleConnectionsFixture(NOW, { outage: true, files: null });
  assert.equal(neither.filesRead, undefined);
  assert.equal(neither.mcp, null);
  assert.equal(neither.privateEndpoints.triggersUnread, true);
  // The page: its banner says what was read from the files, the egress card's hosts are not known, the subscription
  // status is not known, and a grant is "no trigger", never "not known".
  const words = wordsOf(await CONFIGURATION_DRAW["connections-no-snapshot.operator"]());
  for (const said of [CONNECTIONS_FROM_FILES_TEXT, EGRESS_HOSTS_UNREAD, SUBSCRIPTION_UNREAD_TITLE]) assert.ok(words.includes(said), said);
  for (const never of [GRANTS_UNREAD, "No host doctor results are available.", "Subscription status not published", "overlay MCP file unavailable", "staged-package manifest unavailable"]) assert.ok(!words.includes(never), never);
});

test("the page hands Connections and Models the file views its load read, and only where the snapshot failed", async () => {
  const handed = [];
  const deps = (fleet) => ({ now: () => NOW, env: {}, fleet, connections: async (snapshot, opts) => { handed.push(["connections", snapshot, opts.files]); return null; }, modelsView: async (snapshot, opts) => { handed.push(["models", snapshot, opts.files]); return null; } });
  await loadPageData("connections", {}, deps(noSnapshotFleet()), OP);
  await loadPageData("models", {}, deps(noSnapshotFleet()), OP);
  assert.deepEqual(handed.map(([page, snapshot, files]) => [page, snapshot, Array.isArray(files?.triggers?.triggers)]), [["connections", null, true], ["models", null, true]]);
  handed.length = 0;
  const read = { snapshot: async () => ({ parked: [] }), parkedCount: async () => 0, fileViews: () => { throw new Error("not asked over a snapshot"); } };
  await loadPageData("connections", {}, deps(read), OP);
  assert.deepEqual(handed.map(([page, snapshot, files]) => [page, snapshot === null, files]), [["connections", false, null]]);
});

test("Models with no snapshot takes the settings overlay from the file views, not a second reading of the file", async () => {
  const opened = [];
  const fsSpy = { readFileSync: (path) => { opened.push(String(path)); throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }, existsSync: () => false, lstatSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } };
  const files = { settings: { path: "/srv/deployment/settings.json", invalid: "settings file unreadable (EACCES)" } };
  const view = await readModelsView({ paths: { triggersPath: "/srv/deployment/triggers.json", settingsFile: "/srv/deployment/settings.json" }, snapshot: null, files, fs: fsSpy, reads: { records: async () => [], subscriptionAuth: async () => null }, now: NOW });
  assert.deepEqual(view.configProblem, { file: "settings overlay", word: "could not be read" }, "the file views' overlay, which nobody could read");
  assert.ok(!opened.includes("/srv/deployment/settings.json"), "the overlay was not read again");
});

test("the subscription status is not known where it was not read, and not published only where a read held none", async () => {
  assert.equal(subscriptionAuthView(null, { now: NOW }).unread, true, "no value: no snapshot, or a read seam that threw");
  assert.equal(subscriptionAuthView({ state: "unavailable", partial: true, connections: [] }, { now: NOW }).unread, true, "the snapshot's own failed read");
  assert.equal(Object.hasOwn(subscriptionAuthView(undefined, { now: NOW }), "unread"), false, "a caller with no field keeps its words");
  assert.equal(Object.hasOwn(subscriptionAuthView({ state: "ready", partial: false, connections: [] }, { now: NOW }), "unread"), false);
  assert.equal((await readSubscriptionAuthView({ snapshot: null, now: NOW })).unread, true);
  assert.equal(Object.hasOwn(await readSubscriptionAuthView({ snapshot: { subscriptionAuth: { state: "partial", partial: true, connections: [] } }, now: NOW }), "unread"), false);
  assert.equal(subscriptionAuthForAgent(subscriptionAuthView(null, { now: NOW })).unread, true, "an agent's copy keeps the mark");
});

test("Secrets over a settings overlay nobody read: a name the .env declares may be declared there too, and none is said to be declared nowhere", async () => {
  const view = consoleSecretsFixture(NOW, { change: (s, e) => { s.settings = { path: "/srv/deployment/settings.json", invalid: "settings file unreadable (EACCES)" }; e.PI_SECRET_BUNDLES = ""; } });
  assert.equal(view.settingsKnown, false);
  assert.deepEqual(view.profiles.map((p) => [p.name, p.source, p.refused]), [["default", "env", false], ["prod", "undeclared", false]], "named and undeclared, and not refused for it");
  assert.equal(view.problems.some((p) => p.key.startsWith("missing-")), false, "no profile and no bundle is called undeclared");
  assert.deepEqual(view.bundles.map((b) => [b.id, b.declared, b.refused]), [["shop", "overlay-unread", false]]);
  const model = modelSecrets(view);
  assert.deepEqual([model.filesKnown, model.settingsKnown, model.triggersKnown], [true, false, true]);
  assert.deepEqual(model.profiles.map((p) => [p.name, p.source]), [["default", "env"], ["prod", "unknown"]], "a model is never told undeclared over an unread overlay");
  const words = wordsOf(await CONFIGURATION_DRAW["secrets-overlay-unread.operator"]());
  assert.ok(words.includes(`declared in PI_SECRET_PROFILES; ${SECRETS_OVERLAY_UNKNOWN_TOO}`));
  assert.ok(words.includes(`not declared in PI_SECRET_PROFILES, and ${SECRETS_OVERLAY_UNKNOWN}`));
  assert.ok(words.includes(`not declared in PI_SECRET_BUNDLES; ${SECRETS_OVERLAY_UNKNOWN}: the settings overlay could not be read`));
  for (const never of ["declared in no source this view can see", "not declared in the overlay or PI_SECRET_BUNDLES", "Refused: profile prod is not declared"]) assert.ok(!words.includes(never), never);
  // The control: an overlay that was read and declares neither keeps the refusal it is.
  const read = consoleSecretsFixture(NOW, { change: (s, e) => { delete s.settings.overlay.secretProfiles.prod; delete s.settings.overlay.secretBundles.shop; e.PI_SECRET_BUNDLES = ""; } });
  assert.equal(read.settingsKnown, true);
  assert.ok(read.problems.some((p) => p.key === "missing-profile-prod") && read.bundles[0].declared === "missing");
});

test("an agent's /config/secrets draws the projection dispatch_secrets returns, on a healthy deployment and over the files", async () => {
  const page = async (fleet, secretsFor) => {
    const parsed = parsePageQuery("secrets", "");
    const data = await loadPageData("secrets", parsed.query, { now: () => NOW, env: {}, fleet, secretsView: secretsFor }, { role: "agent" });
    return { data, words: wordsOf((await renderPage("secrets", { session: { name: "bot", role: "agent" }, query: parsed.query, data, readOnly: false, theme: null })).html) };
  };
  const healthy = await page({ snapshot: async () => ({ parked: [] }), parkedCount: async () => 0 }, async () => consoleSecretsFixture(NOW));
  assert.equal(healthy.data.secrets.agent, true);
  assert.deepEqual({ ...healthy.data.secrets, agent: undefined }, { ...modelSecrets(consoleSecretsFixture(NOW)), agent: undefined }, "the tool's own projection");
  for (const never of ["Declarations and their state could not be read", "Secret declarations are unknown", "DB_URL", "API_TOKEN", "/srv/resolvers"]) assert.ok(!healthy.words.includes(never), never);
  for (const said of ["default", "prod", "shop", SECRETS_AGENT_TEXT, "2 in the newest run"]) assert.ok(healthy.words.includes(said), said);
  // Over the files alone it says what it lacks, and still names what the files declare.
  const files = await page(noSnapshotFleet({ fileViews: () => secretFilesFixture() }), async (snapshot, f) => secretsView({ snapshot, files: f, env: SECRET_FILES_ENV, fs }));
  assert.ok(files.words.includes("Run and host facts could not be read.") && files.words.includes("prod") && files.words.includes("not known: the runs could not be read"));
  // A view that was not read at all is null in the agent's copy, and the page says so.
  const none = await page(noSnapshotFleet({ fileViews: () => { throw new Error("no files"); } }), async () => { throw new Error("no view"); });
  assert.equal(none.data.secrets, null);
  assert.ok(none.words.includes("Declarations and their state could not be read."));
});

test("dispatch_secrets and dispatch_connections read the file views where the snapshot failed", async () => {
  const views = secretFilesFixture();
  let disposed = 0;
  const fleet = () => ({ snapshot: async () => { throw new Error("Valkey does not answer"); }, fileViews: () => views, dispose: async () => { disposed += 1; } });
  const secrets = await readConfigTool("secrets", { paths: {}, env: SECRET_FILES_ENV, now: NOW, reads: { fleet, secrets: (input) => secretsView({ ...input, fs }) } });
  assert.deepEqual([secrets.available, secrets.filesKnown], [false, true]);
  assert.deepEqual(secrets.profiles.map((p) => `${p.name}:${p.source}`), ["default:env", "prod:overlay"]);
  let handed = null;
  await readConfigTool("connections", { paths: {}, env: {}, now: NOW, reads: { fleet, connections: async (input) => { handed = input; return {}; } } });
  assert.deepEqual([handed.snapshot, handed.files], [null, views]);
  // A reader whose file views throw leaves the declarations unread, as before.
  const bare = await readConfigTool("secrets", { paths: {}, env: SECRET_FILES_ENV, now: NOW, reads: { fleet: () => ({ ...fleet(), fileViews: () => { throw new Error("no files"); } }), secrets: (input) => secretsView({ ...input, fs }) } });
  assert.deepEqual([bare.available, bare.filesKnown, bare.profiles.map((p) => p.name)], [false, false, ["default"]]);
  assert.equal(disposed, 3);
});

test("Fleet and a venue say the hosts are as the registry was last read where this read of it failed after one that answered", async () => {
  const lastRead = { queue: { fleetDegraded: "registry" }, hostsReadAt: NOW - 60_000 };
  assert.deepEqual([hostsAsLastRead(lastRead), hostsUnread(lastRead)], [true, false], "the reason hostsUnread cannot be the test");
  for (const s of [null, { queue: {}, hostsReadAt: NOW }, { queue: { fleetDegraded: "registry" }, hostsReadAt: null }, { queue: { fleetDegraded: "registry", registryReadInPart: true }, hostsReadAt: NOW }]) assert.equal(hostsAsLastRead(s), false, JSON.stringify(s));
  const fleet = wordsOf(await FLEET_DRAW["fleet-registry-unreadable.operator"]());
  assert.ok(fleet.includes(`3 hosts' registry rows ${HOSTS_AS_LAST_READ}`) && fleet.includes(`shared by 3 hosts ${HOSTS_AS_LAST_READ}`));
  assert.ok(fleet.includes(NO_HOST_AS_LAST_READ) && !fleet.includes("no live host"), "a venue no host blessed when last read is not one no live host blesses");
  const venue = wordsOf(await FLEET_DRAW["venue-registry-unreadable.operator"]());
  assert.ok(venue.includes(REGISTRY_UNREAD_TEXT) && !venue.includes("no live host") && !venue.includes("No live host"));
  // The control: a registry that answered keeps "no live host" and says nothing of a last read.
  const read = wordsOf(await FLEET_DRAW["venue-openshell.operator"]());
  assert.ok(!read.includes(REGISTRY_UNREAD_TEXT));
  assert.equal(FLEET_CARD_SNAPSHOT().queue.fleetDegraded, undefined);
});

test("the budget split draws no amount over an envelope nobody read, and says why on each card", () => {
  const view = (allocation) => ({ now: NOW, role: "operator", query: {}, data: { insights: { allocation } } });
  const cards = (allocation) => [splitEnvelopeKpi, splitAllocatedKpi, splitSpentKpi, splitPlanKpi, splitRows].map((card) => wordsOf(card(view(allocation))));
  for (const [envelopeCase, title] of [["absent", "The envelope file does not exist."], ["unreadable", "The envelope file could not be read."], ["refused", "The envelope does not load."]]) {
    const drawn = cards({ problem: "the reader's words", envelopeCase });
    for (const card of drawn) {
      assert.ok(!/\$\d/.test(card), `${envelopeCase}: no amount: ${card}`);
      for (const never of ["Delegation off", "0 projects", "No split yet", "Floors total"]) assert.ok(!card.includes(never), `${envelopeCase}: ${never}`);
    }
    for (const card of drawn.slice(0, 4)) assert.ok(card.includes("not known") && card.includes(title), `${envelopeCase}: ${card}`);
    assert.ok(drawn[4].includes(title.replace(/\.$/, "")), envelopeCase);
  }
  const unset = cards({ unset: true });
  for (const card of unset.slice(0, 4)) assert.ok(card.includes("No envelope is configured.") && !/\$\d/.test(card), card);
  assert.ok(unset[4].includes(SPLIT_UNSET_TEXT));
});

test("the provider inventory says a source of references that does not load apart from one nobody could read", () => {
  const read = (document) => readProviderInventory({ deploymentDir: "/srv/deployment", env: {}, paths: {}, reads: { environment: () => ({ env: { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "fixture-only", PI_AUTH_FROM_PI: "0" } }), settings: () => ({ overlay: {} }), document } });
  const reasonOf = (inventory) => inventory.rows.find((r) => r.provider === "anthropic")?.reason;
  const refused = read(() => "{ not json");
  assert.equal(refused.state, "partial");
  assert.equal(reasonOf(refused), "references-refused");
  const unreadable = read(() => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); });
  assert.equal(reasonOf(unreadable), "references-unreadable");
  assert.notEqual(PROVIDER_KEY_REASONS["references-refused"], PROVIDER_KEY_REASONS["references-unreadable"]);
  assert.equal(reasonOf(read(() => JSON.stringify({ triggers: [] }))), null, "a file that was read and names nothing is whole");
});
