import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPageData, pagePanels, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { readStagedPackages } from "../src/read-model.mjs";
import { secretsView, modelSecrets } from "../src/secrets-view.mjs";
import { hostStandings, packageRow } from "../src/updates-view.mjs";
import { privateEndpointsView } from "../src/connections-view.mjs";
import { TRIGGER_GETS_WORDS } from "../src/trigger-gets-view.mjs";
import { SECRETS_CELL_UNREAD, SECRETS_FILES_ONLY_TEXT, SECRETS_FILES_ONLY_TITLE, SECRETS_RUN_UNREAD, secretsProfilesUnreadText } from "../src/console/panels/secrets.mjs";
import { BUNDLE_UNREAD, FORGE_NONE_HINT, FORGE_UNREAD_HINT, SCHEDULE_UNREAD, STALL_CAP_UNREAD } from "../src/console/panels/trigger.mjs";
import { HOST_UNREAD_WORDS, RECENT_UNREAD_TEXT } from "../src/console/panels/updates.mjs";
import { GRANTS_UNREAD } from "../src/console/panels/connections.mjs";
import { PACKAGES_MALFORMED_TEXT, PACKAGES_UNREAD_TEXT } from "../src/console/panels/config.mjs";
import { readConsoleAudit, CONSOLE_AUDIT_DIR } from "@edgehero/pi-dispatch/console-audit";
import { readDeploymentUpdates, readTriggersFile, HOST_ADOPT_STATES } from "../src/updates-view.mjs";
import { CANARY_TRIGGERS_UNREAD, RECENT_GAPS_TEXT } from "../src/console/panels/updates.mjs";
import { HOST_LOADS } from "./helpers/loaded-samples.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { noSnapshotFleet } from "./helpers/no-snapshot.mjs";
import { SECRET_FILES_ENV, consoleConnectionsFixture, secretFilesFixture } from "./helpers/configuration-goldens.mjs";
import { updatesFacts, updatesPage } from "./helpers/updates-goldens.mjs";

/**
 * An unread value is not an empty one on the configuration pages (issue #962), in both directions: with no snapshot the
 * declarations still come from the deployment's files, a read that failed says "not known" or "could not be read", and
 * a read that showed emptiness keeps its true empty sentence. Canned readers at a fixed instant; nothing here reads a
 * Valkey.
 */

const NOW = Date.UTC(2026, 9, 8, 15, 39, 0);
const HOUR = 3_600_000;
const OP = { name: "ops", role: "operator" };
/** The words of some markup, tags and the scripts' own text dropped. */
const wordsOf = (markup) => String(markup).replace(/<(script|style|template)\b[^]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");

const ENV = SECRET_FILES_ENV;
/** What the deployment's files declare of secrets: an overlay profile, an overlay bundle resolver, two triggers and one bound bundle. */
const secretFiles = (over = {}) => ({ ...secretFilesFixture(), ...over });
const fs = { realpathSync: (path) => path };

/** The Secrets page, loaded and drawn as the console does it. */
async function secretsPage(fleet, { role = "operator" } = {}) {
  const parsed = parsePageQuery("secrets", "");
  const data = await loadPageData("secrets", parsed.query, { now: () => NOW, env: {}, fleet, secretsView: (snapshot, files) => secretsView({ snapshot, files, env: ENV, fs }) }, { role });
  const page = await renderPage("secrets", { session: { name: "ops", role }, query: parsed.query, data, readOnly: false, theme: null });
  return { data, html: String(page.html), words: wordsOf(page.html) };
}

test("/config/secrets with no snapshot draws the declarations from the files and the .env, read-only, and says run and host facts are not known", async () => {
  const { data, html, words } = await secretsPage(noSnapshotFleet({ fileViews: () => secretFiles() }));
  assert.equal(data.snapshot, null);
  assert.deepEqual({ filesKnown: data.secrets.filesKnown, fleetKnown: data.secrets.fleetKnown }, { filesKnown: true, fleetKnown: false });
  assert.deepEqual(data.secrets.profiles.map((p) => `${p.name}:${p.source}`), ["default:env", "prod:overlay"]);
  assert.deepEqual(data.secrets.bundles.map((b) => `${b.id}:${b.declared}`), ["shop:overlay"]);
  assert.deepEqual(data.secrets.bundleResolvers.map((r) => r.name), ["env-bundle", "shop"]);
  for (const never of ["The deployment could not be read", "Secret declarations are unknown", "Declarations and their state could not be read", "no run in view", "no live host", "No live host advertises", "No secret profiles are declared"]) assert.ok(!words.includes(never), never);
  assert.ok(words.includes(SECRETS_FILES_ONLY_TITLE) && words.includes(SECRETS_FILES_ONLY_TEXT), "the page says what it is drawn from");
  assert.ok(words.includes("Run and host facts could not be read."), "under the title");
  assert.ok(words.includes(SECRETS_RUN_UNREAD), "a last resolve and a last received are not known, never none");
  assert.ok(words.includes("the host registry could not be read"), "who serves a profile is not known");
  assert.ok(words.includes("2 in view") && words.includes("1 bound in the triggers file"), "the files were read: whole counts");
  // No change is offered over the files alone: no Remove and no Declare card.
  assert.ok(!html.includes("secret-profile-remove") && !html.includes("secret-bundle-remove") && !html.includes("secret-profile-add"), "no form");
  assert.equal(data.secrets.problems.some((p) => p.key.startsWith("unserved-")), false, "an unread registry names no unserved profile");
});

test("/config/secrets over a read snapshot keeps its sentences: no run in view, forms, and no word of a failed read", async () => {
  const snapshot = { ...secretFiles(), runs: [], hosts: [{ name: "mini1", caps: ["s:prod", "s:default"], capsSeen: true }], schedulers: [] };
  const { data, html, words } = await secretsPage({ snapshot: async () => snapshot, parkedCount: async () => 0 });
  assert.deepEqual({ filesKnown: data.secrets.filesKnown, fleetKnown: data.secrets.fleetKnown }, { filesKnown: true, fleetKnown: true });
  assert.ok(words.includes("no run in view") && !words.includes(SECRETS_RUN_UNREAD));
  assert.ok(!words.includes(SECRETS_FILES_ONLY_TITLE) && !words.includes("Run and host facts could not be read"));
  assert.ok(words.includes("mini1") && !words.includes("the host registry could not be read"));
  assert.ok(html.includes("secret-profile-remove") && html.includes("secret-profile-add"), "an operator's forms");
});

test("/config/secrets with neither a snapshot nor file views still says the declarations are unknown; the model's read stays unavailable without a snapshot", async () => {
  const { data, words } = await secretsPage(noSnapshotFleet({ fileViews: () => { throw new Error("no files"); } }));
  assert.deepEqual({ filesKnown: data.secrets.filesKnown, fleetKnown: data.secrets.fleetKnown }, { filesKnown: false, fleetKnown: false });
  assert.ok(words.includes("Secret declarations are unknown") && words.includes("Declarations and their state could not be read."));
  assert.ok(!words.includes(SECRETS_FILES_ONLY_TITLE));
  assert.equal(modelSecrets(secretsView({ snapshot: null, files: secretFiles(), env: ENV, fs })).available, false, "a files-only view holds no run or host fact for a model to reason from");
  assert.equal(modelSecrets(secretsView({ snapshot: secretFiles(), env: ENV, fs })).available, true);
});

test("/config/secrets counts: a triggers file that could not be read is not known, never 0; one that is not there, or read and empty, keeps its zero", async () => {
  const draw = async (triggers, env = { PI_SECRET_PROFILES: "", PI_SECRET_BUNDLES: "" }) => {
    const parsed = parsePageQuery("secrets", "");
    const snapshot = { settings: { overlay: {} }, triggers, projects: { projects: [] }, runs: [], hosts: [], schedulers: [] };
    const data = await loadPageData("secrets", parsed.query, { now: () => NOW, env: {}, fleet: { snapshot: async () => snapshot, parkedCount: async () => 0 }, secretsView: (s, files) => secretsView({ snapshot: s, files, env, fs }) }, OP);
    return wordsOf((await renderPage("secrets", { session: OP, query: parsed.query, data, readOnly: false, theme: null })).html);
  };
  for (const [unread, word] of [[{ unreadable: "EACCES" }, "could not be read"], [{ invalid: "triggers file is not valid JSON" }, "does not load"]]) {
    const words = await draw(unread);
    for (const never of ["0 bound in the triggers file", "0 in view", "No secret profiles are declared", "The triggers file binds no project secret bundle"]) assert.ok(!words.includes(never), `${never}: ${JSON.stringify(unread)}`);
    // The same two words as the Triggers card: "could not be read" of a file nobody read, "does not load" of one that was read and is refused.
    assert.ok(words.includes(`not known: the triggers file ${word} Variable names only`), "the bundles' count");
    assert.ok(words.includes(`not known: the triggers file ${word} · names only`) && words.includes(secretsProfilesUnreadText(`the triggers file ${word}`)), "the profiles' count and empty list");
    // A profile the .env declares is still drawn, as a floor, and its row says not known where the file would have said which triggers and projects use it.
    const floor = await draw(unread, { PI_SECRET_PROFILES: "default:/opt/default", PI_SECRET_BUNDLES: "" });
    assert.ok(floor.includes("at least 1 in view"));
    assert.match(floor, new RegExp(`default declared in PI_SECRET_PROFILES not bounded \\(an env resolver\\) ${SECRETS_CELL_UNREAD} ${SECRETS_CELL_UNREAD} `), "Triggers and Projects, never none");
    assert.ok(!/an env resolver\) none /.test(floor) && !floor.includes("none in view"));
  }
  for (const read of [{ missing: true }, { triggers: [], secretBundles: [] }]) {
    const words = await draw(read);
    assert.ok(words.includes("0 bound in the triggers file") && words.includes("The triggers file binds no project secret bundle."), JSON.stringify(read));
    assert.ok(words.includes("0 in view · names only") && words.includes("No secret profiles are declared or named by the triggers in view."), JSON.stringify(read));
    assert.ok(!words.includes("could not be read") && !words.includes("does not load"), `nothing here failed to read: ${JSON.stringify(read)}`);
    const row = await draw(read, { PI_SECRET_PROFILES: "default:/opt/default", PI_SECRET_BUNDLES: "" });
    assert.ok(/an env resolver\) none none in view /.test(row) && row.includes("1 in view"), "a read file that names no use: none");
  }
  // The settings overlay is a source of the profiles too: unread, the count is a floor or not known, by the one rule /config follows.
  const withSettings = async (settings, env) => {
    const parsed = parsePageQuery("secrets", "");
    const snapshot = { settings, triggers: { triggers: [], secretBundles: [] }, projects: { projects: [] }, runs: [], hosts: [], schedulers: [] };
    const data = await loadPageData("secrets", parsed.query, { now: () => NOW, env: {}, fleet: { snapshot: async () => snapshot, parkedCount: async () => 0 }, secretsView: (s, files) => secretsView({ snapshot: s, files, env, fs }) }, OP);
    return wordsOf((await renderPage("secrets", { session: OP, query: parsed.query, data, readOnly: false, theme: null })).html);
  };
  const none = { PI_SECRET_PROFILES: "", PI_SECRET_BUNDLES: "" };
  const refused = await withSettings({ invalid: "settings file is not valid JSON" }, none);
  assert.ok(refused.includes("not known: the settings overlay does not load · names only") && !refused.includes("0 in view"), "no other source: not known");
  assert.ok(refused.includes("0 bound in the triggers file"), "the bundles are the triggers file's, which was read");
  const unreadable = await withSettings({ invalid: "settings file unreadable (EACCES)" }, { ...none, PI_SECRET_PROFILES: "default:/opt/default" });
  assert.ok(unreadable.includes("at least 1 in view · names only") && unreadable.includes("The settings overlay could not be read; its profile declarations are unknown."));
  assert.ok((await withSettings({ overlay: {} }, none)).includes("0 in view · names only"));
});

test("/config: the secret cards and the staged-packages card say not known of a file that could not be read, and keep a read zero", async () => {
  const cards = async (over) => {
    const snapshot = { settings: { overlay: {} }, triggers: { triggers: [] }, projects: { projects: [] }, stagedPackages: { stagedAt: null, packages: [] }, secretProfiles: null, secretBundles: null, ...over };
    const panels = await pagePanels("config", { query: {}, session: OP, data: { page: "config", now: NOW, env: {}, snapshot }, readOnly: false });
    return wordsOf(panels.map((p) => p.html).join(" "));
  };
  const read = await cards({});
  assert.ok(read.includes("0 profiles in view.") && read.includes("0 project bundles in view.") && read.includes("0 packages staged."), read);
  assert.ok((await cards({ triggers: { missing: true } })).includes("0 project bundles in view."), "a file that is not there binds none");
  const unread = await cards({ triggers: { unreadable: "EACCES" }, stagedPackages: { stagedAt: null, packages: [], unreadable: true } });
  for (const never of ["0 profiles in view", "0 project bundles in view", "0 packages staged"]) assert.ok(!unread.includes(never), never);
  assert.ok(unread.includes("Profiles not known: the triggers file could not be read.") && unread.includes("Project bundles not known: the triggers file could not be read."), unread);
  assert.ok(unread.includes(PACKAGES_UNREAD_TEXT) && !unread.includes(PACKAGES_MALFORMED_TEXT));
  // A file that was read and is refused "does not load", the Triggers card's own word; what the other sources still name is a floor.
  const refused = await cards({ triggers: { invalid: "x" }, secretProfiles: { profiles: [{ name: "default" }] }, stagedPackages: { stagedAt: null, packages: [], unreadable: true, malformed: true } });
  assert.ok(refused.includes("At least 1 profiles in view; the rest is not known: the triggers file does not load.") && refused.includes("Project bundles not known: the triggers file does not load."), refused);
  assert.ok(refused.includes(PACKAGES_MALFORMED_TEXT) && !refused.includes(PACKAGES_UNREAD_TEXT));
  // The settings overlay names profiles too, and binds no bundle: the same rule as the Secrets page.
  const settings = await cards({ settings: { invalid: "settings file is not valid JSON" }, secretProfiles: { profiles: [{ name: "default" }, { name: "prod" }] } });
  assert.ok(settings.includes("At least 2 profiles in view; the rest is not known: the settings overlay does not load.") && !settings.includes("2 profiles in view."), settings);
  assert.ok(settings.includes("0 project bundles in view."), "the triggers file was read");
  const both = await cards({ settings: { invalid: "settings file unreadable (EACCES)" }, triggers: { invalid: "x" } });
  assert.ok(both.includes("Profiles not known: the settings overlay could not be read and the triggers file does not load.") && !both.includes("0 profiles in view"), both);
});

test("the staged packages read tells a manifest that is not there from one that is there and gave no list", () => {
  const manifest = "/pi/packages/packages.json";
  const fsOf = (files) => ({ existsSync: (path) => Object.hasOwn(files, path), readFileSync: (path) => { if (typeof files[path] !== "string") throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return files[path]; } });
  assert.deepEqual(readStagedPackages({ globalPiDir: "/pi", fs: fsOf({}) }), { stagedAt: null, packages: [] }, "absent: nothing staged, and no unread mark");
  assert.deepEqual(readStagedPackages({ globalPiDir: "", fs: fsOf({}) }), { stagedAt: null, packages: [] }, "no overlay configured");
  assert.deepEqual(readStagedPackages({ globalPiDir: "/pi", fs: fsOf({ [manifest]: "{ not json" }) }), { stagedAt: null, packages: [], unreadable: true, malformed: true }, "read, and no list: it does not load");
  assert.deepEqual(readStagedPackages({ globalPiDir: "/pi", fs: fsOf({ [manifest]: null }) }), { stagedAt: null, packages: [], unreadable: true }, "there, and the read threw: it could not be read");
  // A reader that throws is judged the same way, by whether the file is there.
  const throws = () => { throw new Error("reader fault"); };
  assert.equal(readStagedPackages({ globalPiDir: "/pi", fs: fsOf({ [manifest]: "{}" }), readManifest: throws }).unreadable, true);
  assert.deepEqual(readStagedPackages({ globalPiDir: "/pi", fs: fsOf({}), readManifest: throws }), { stagedAt: null, packages: [] });
  const read = readStagedPackages({ globalPiDir: "/pi", fs: fsOf({ [manifest]: JSON.stringify({ stagedAt: "2026-10-01T00:00:00.000Z", packages: [{ name: "pi-lint", version: "1.4.2", dir: "pi-lint--1.4.2--aaaaaaaa" }] }) }) });
  assert.deepEqual(read, { stagedAt: "2026-10-01T00:00:00.000Z", packages: ["pi-lint@1.4.2"] });
  assert.deepEqual(readStagedPackages({ globalPiDir: "/pi", fs: fsOf({ [manifest]: JSON.stringify({ packages: [] }) }) }), { stagedAt: null, packages: [] }, "read, and empty");
});

/** A deployment folder holding one cron trigger in a bundled project, for the trigger page's own file read. */
function triggerFolder() {
  const dir = tempDir("pd-962-trigger-");
  assert.ok(dir.startsWith(tmpdir()), "a temp folder, checked before anything is written");
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/shop", flow: "tidy", task: "tidy up" } }], secretBundles: { shop: { profile: "shop", ref: "shop/env", project: "shop" } } }));
  return triggersPath;
}
const EDITOR = { backends: [{ name: "local", serves: { liveTranscript: "yes", steering: "yes", recovery: "yes", sandboxShell: "yes" } }], forges: ["github"], flows: [], defaults: { backend: "local" } };
const BOUND = { schedulerStallMax: 4, triggers: { triggers: [{ index: 0, id: "nightly", type: "cron", pattern: "0 3 * * *", folder: "/srv/shop", runKind: "local", flow: "tidy" }], secretBundles: [{ id: "shop", profile: "shop", project: "shop", forkReviews: false, endpoints: [] }] }, projects: { projects: [{ id: "shop", members: ["/srv/shop"] }] }, settings: { overlay: {} } };

async function triggerPage(deps) {
  const query = { index: 0 };
  const data = await loadPageData("trigger", query, { now: () => NOW, env: {}, triggerEditor: () => EDITOR, paths: { triggersPath: triggerFolder() }, ...deps }, { role: "operator" });
  return { data, words: wordsOf((await renderPage("trigger", { query, session: OP, data })).html) };
}

test("/config/trigger with no snapshot names the trigger's bundle from the files; with no files either it is not known; read and none declared stays none", async () => {
  const fromFiles = await triggerPage({ fleet: noSnapshotFleet({ fileViews: () => BOUND }) });
  assert.equal(fromFiles.data.snapshot, null);
  assert.ok(fromFiles.words.includes("Bundle: shop."), fromFiles.words.match(/Bundle:[^.]*\./)?.[0]);
  assert.ok(!fromFiles.words.includes("no declared project bundle") && !fromFiles.words.includes(BUNDLE_UNREAD));
  // Its schedule too: what the queue publishes was not read, which is not "not published".
  // The stall cap is a deployment setting the file views hold, as the Triggers page counts it.
  assert.ok(fromFiles.words.includes(`Health: ${SCHEDULE_UNREAD}; stalls not known of 5.`) && !fromFiles.words.includes("not published") && !fromFiles.words.includes(STALL_CAP_UNREAD), fromFiles.words.match(/Health:[^.]*\./)?.[0]);
  const none = await triggerPage({ fleet: noSnapshotFleet({ fileViews: () => ({ ...BOUND, triggers: { triggers: BOUND.triggers.triggers, secretBundles: [] } }) }) });
  assert.ok(none.words.includes("Bundle: no declared project bundle."), "the file was read and binds none");
  const neither = await triggerPage({ fleet: noSnapshotFleet({ fileViews: () => { throw new Error("no files"); } }) });
  assert.ok(neither.words.includes(`Bundle: ${BUNDLE_UNREAD}.`) && !neither.words.includes("no declared project bundle"), neither.words.match(/Bundle:[^.]*\./)?.[0]);
  assert.ok(neither.words.includes(`stalls not known of ${STALL_CAP_UNREAD}.`), "neither a snapshot nor the files hold the cap");
  const unreadFile = await triggerPage({ fleet: noSnapshotFleet({ fileViews: () => ({ ...BOUND, triggers: { unreadable: "EACCES" } }) }) });
  assert.ok(unreadFile.words.includes(`Bundle: ${BUNDLE_UNREAD}.`), "file views whose triggers file could not be read say nothing of its bundles");
  // A snapshot that was read answers for itself, whatever the files would say.
  const snapshot = { readAt: NOW, triggers: { triggers: BOUND.triggers.triggers }, runs: [], waiting: { rows: [] }, schedulers: [], settings: { overlay: {} }, secretBundles: null };
  const read = await triggerPage({ fleet: { snapshot: async () => snapshot } });
  assert.ok(read.words.includes("Bundle: no declared project bundle.") && !read.words.includes(BUNDLE_UNREAD));
  assert.ok(read.words.includes("Health: not known (schedule not published);") && !read.words.includes(SCHEDULE_UNREAD) && !read.words.includes(STALL_CAP_UNREAD), "a snapshot with no scheduler row for it");
});

test("/config/trigger: a host read that threw says the hosts could not be read; one that answered with no host, or a console with no such read, keeps 'No live host says'", async () => {
  const snapshot = { readAt: NOW, triggers: { triggers: BOUND.triggers.triggers }, runs: [], waiting: { rows: [] }, schedulers: [], settings: { overlay: {} } };
  const fleet = { snapshot: async () => snapshot };
  const threw = await triggerPage({ fleet, hostLoads: async () => { throw new Error("Valkey does not answer"); } });
  assert.equal(threw.data.hostLoadsUnread, true);
  assert.ok(threw.words.includes(TRIGGER_GETS_WORDS.hostsUnread) && !threw.words.includes(TRIGGER_GETS_WORDS.noHost), "unread, not none");
  for (const hostLoads of [async () => ({ hosts: [], more: 0 }), async () => null, undefined]) {
    const read = await triggerPage({ fleet, ...(hostLoads ? { hostLoads } : {}) });
    assert.notEqual(read.data.hostLoadsUnread, true);
    assert.ok(read.words.includes(TRIGGER_GETS_WORDS.noHost) && !read.words.includes(TRIGGER_GETS_WORDS.hostsUnread), "a read that showed no host");
  }
});

test("/config/trigger-add: no forge in the .env is 'no forge is configured here', never a statement about deliveries; an editor read that threw is not known", async () => {
  const add = async (triggerEditor) => {
    const data = await loadPageData("trigger-add", {}, { now: () => NOW, fleet: { snapshot: async () => ({ triggers: { triggers: [] }, settings: { overlay: {} } }) }, triggerEditor }, { role: "operator" });
    return wordsOf((await renderPage("trigger-add", { query: {}, session: OP, data })).html);
  };
  const none = await add(() => ({ ...EDITOR, forges: [] }));
  assert.ok(none.includes(FORGE_NONE_HINT) && !none.includes(FORGE_UNREAD_HINT));
  assert.ok(!none.includes("events reach this deployment yet"), "its fact is the .env's keys, not what a receiver observed");
  const threw = await add(() => { throw new Error("the .env could not be read"); });
  assert.ok(threw.includes(FORGE_UNREAD_HINT) && !threw.includes(FORGE_NONE_HINT), "unread is not none configured");
  const some = await add(() => EDITOR);
  assert.ok(!some.includes(FORGE_NONE_HINT) && !some.includes(FORGE_UNREAD_HINT));
});

const desiredRow = JSON.stringify({ v: 1, generation: 5, name: "pi-lint", version: "1.4.3", op: "adopt", from: "1.4.2", by: "ops", at: NOW - HOUR });
const appliedRow = JSON.stringify({ v: 1, generation: 5, state: "adopted", version: "1.4.3", digest: "a".repeat(64), at: NOW - HOUR });

test("hostStandings: a host whose applied rows could not be read is unread, never pending or overdue, and the row is not adopted everywhere", () => {
  const desired = { name: "pi-lint", generation: 5, at: NOW - 30 * HOUR, op: "adopt", version: "1.4.3" };
  const standings = hostStandings({ desired, applied: { mini1: { "pi-lint": { generation: 5, state: "adopted", version: "1.4.3" } }, mini2: null, build3: {} }, hosts: ["mini1", "mini2", "build3"], now: NOW });
  assert.deepEqual(standings.map((s) => `${s.host}:${s.state}`), ["mini1:adopted", "mini2:unread", "build3:overdue"]);
  assert.equal(hostStandings({ desired: { ...desired, at: NOW - HOUR }, applied: { build3: {} }, hosts: ["build3"], now: NOW })[0].state, "pending", "a host that answered with no row is pending");
  const row = (list) => packageRow({ pkg: { name: "pi-lint", version: "1.4.2" }, look: { state: "ok", newest: "1.4.3" }, desired, standings: list, canary: null, facts: null }).state;
  assert.equal(row([{ state: "adopted" }, { state: "unread" }]), "adopting", "it may still be moving");
  assert.equal(row([{ state: "adopted" }, { state: "adopted" }]), "adopted");
});

test("/config/updates: a host Valkey did not answer for is not known, with factsUnread beside it; a host that answered with no row is pending, or late after a day", async () => {
  const redis = (at) => ({ desiredRows: { "pi-lint": JSON.stringify({ ...JSON.parse(desiredRow), at }) }, appliedRows: { mini1: { "pi-lint": appliedRow } } });
  const unreadFor = (host, base) => ({ ...base, appliedUnread: [host] });
  for (const at of [NOW - HOUR, NOW - 30 * HOUR]) {
    const unread = { redis: unreadFor("mini2", redis(at)) };
    const facts = await updatesFacts(unread);
    const standings = facts.packages.find((p) => p.name === "pi-lint").standings;
    assert.equal(standings.find((s) => s.host === "mini2").state, "unread");
    assert.equal(facts.factsUnread, true, "the same null says both: the page's standing and the gate's refusal");
    assert.equal(facts.packages.find((p) => p.name === "pi-lint").state, "adopting");
    const words = wordsOf(await updatesPage({ facts: unread }));
    assert.ok(words.includes(`mini2 is ${HOST_UNREAD_WORDS}.`), words.match(/mini2 is[^.]*\./)?.[0]);
    assert.ok(!words.includes("mini2 is pending") && !words.includes("mini2 has not answered in a day"), "never a statement about a host nobody read");
    assert.ok(words.includes("Adopting 1.4.3: 1 of 3 hosts so far."), "counted as not done");
  }
  // The read that answered keeps its own sentences.
  const pending = await updatesFacts({ redis: redis(NOW - HOUR) });
  assert.equal(pending.factsUnread, false);
  assert.deepEqual(pending.packages.find((p) => p.name === "pi-lint").standings.map((s) => s.state), ["pending", "adopted", "pending"]);
  const said = wordsOf(await updatesPage({ facts: { redis: redis(NOW - HOUR) } }));
  assert.ok(said.includes("mini2 is pending.") && !said.includes(HOST_UNREAD_WORDS));
  const late = wordsOf(await updatesPage({ facts: { redis: redis(NOW - 30 * HOUR) } }));
  assert.ok(late.includes("mini2 has not answered in a day.") && !late.includes(HOST_UNREAD_WORDS));
});

test("/config/updates: an audit log that could not be read says so; one that was read and holds nothing keeps 'Nothing in the audit log's window.'", async () => {
  const unread = await updatesFacts({ audit: null });
  assert.equal(unread.recentUnread, true);
  assert.deepEqual(unread.recent, []);
  const words = wordsOf(await updatesPage({ facts: { audit: null } }));
  assert.ok(words.includes(RECENT_UNREAD_TEXT) && !words.includes("Nothing in the audit log's window."));
  const read = await updatesFacts({ audit: [] });
  assert.equal(read.recentUnread, false);
  const empty = wordsOf(await updatesPage({ facts: { audit: [] } }));
  assert.ok(empty.includes("Nothing in the audit log's window.") && !empty.includes(RECENT_UNREAD_TEXT));
});

test("/config/connections: a private endpoint's grants are not known where the triggers were not read, and 'no trigger' where they were", async () => {
  const declared = [{ id: "printer", host: "10.0.0.9", port: 9100 }];
  assert.equal(privateEndpointsView(declared, undefined, { triggersUnread: true }).triggersUnread, true);
  assert.equal(Object.hasOwn(privateEndpointsView(declared, []), "triggersUnread"), false, "a key only where the triggers were not read");
  const page = async (change) => {
    const parsed = parsePageQuery("connections", "");
    const connections = await consoleConnectionsFixture(NOW, { change });
    const data = await loadPageData("connections", parsed.query, { now: () => NOW, env: {}, fleet: { snapshot: async () => ({ parked: [] }), parkedCount: async () => 0 }, connections: async () => connections }, { role: "operator" });
    const panels = await pagePanels("connections", { query: parsed.query, session: OP, data, readOnly: false });
    return wordsOf(panels.map((p) => p.html).join(" "));
  };
  const endpoints = (reads) => { reads.privateEndpoints = () => declared; };
  const unread = await page((snapshot, reads) => { endpoints(reads); snapshot.triggers = { unreadable: "EACCES" }; });
  assert.ok(unread.includes(GRANTS_UNREAD), unread.match(/printer.{0,200}/)?.[0]);
  assert.ok(!/printer .*?no trigger/.test(unread.match(/printer.{0,200}/)?.[0] ?? ""), "never no trigger of a file nobody read");
  for (const triggers of [{ missing: true }, { triggers: [] }]) {
    const read = await page((snapshot, reads) => { endpoints(reads); snapshot.triggers = triggers; });
    assert.ok(/printer .*?no trigger/.test(read) && !read.includes(GRANTS_UNREAD), JSON.stringify(triggers));
  }
});

test("/config/trigger: with no snapshot, or a registry never read, the card says the live hosts could not be read; a read registry with no host keeps 'No live host is listed just now'", async () => {
  const published = async () => HOST_LOADS;
  const unread = await triggerPage({ fleet: noSnapshotFleet({ fileViews: () => BOUND }), hostLoads: published });
  assert.ok(unread.words.includes(TRIGGER_GETS_WORDS.liveListUnread) && !unread.words.includes(TRIGGER_GETS_WORDS.noLiveList), "the warm host-loads cache beside a snapshot that failed");
  const base = { readAt: NOW, triggers: { triggers: BOUND.triggers.triggers }, runs: [], waiting: { rows: [] }, schedulers: [], settings: { overlay: {} } };
  const never = await triggerPage({ fleet: { snapshot: async () => ({ ...base, hostBudgets: [], queue: { fleetDegraded: "registry" }, hostsReadAt: null }) }, hostLoads: published });
  assert.ok(never.words.includes(TRIGGER_GETS_WORDS.liveListUnread) && !never.words.includes(TRIGGER_GETS_WORDS.noLiveList), "a registry never read");
  const read = await triggerPage({ fleet: { snapshot: async () => ({ ...base, hostBudgets: [], queue: {}, hostsReadAt: NOW }) }, hostLoads: published });
  assert.ok(read.words.includes(TRIGGER_GETS_WORDS.noLiveList) && !read.words.includes(TRIGGER_GETS_WORDS.liveListUnread), "the registry answered and lists none");
  // No host published either: with the live hosts unread that is not "no live host says it can".
  const nothing = await triggerPage({ fleet: noSnapshotFleet({ fileViews: () => BOUND }), hostLoads: async () => ({ hosts: [], more: 0 }) });
  assert.ok(nothing.words.includes(TRIGGER_GETS_WORDS.noHostLiveUnread) && !nothing.words.includes(TRIGGER_GETS_WORDS.noHost), nothing.words.match(/What its jobs get.{0,300}/)?.[0]);
});

test("/config/updates: an audit file that could not be read, or a line that is no row, is said under what was read, and never 'Nothing in the audit log's window.'", async () => {
  // The real reader over a month it cannot read: a directory where the month's file should be.
  const logsDir = tempDir("pd-962-audit-");
  assert.ok(logsDir.startsWith(tmpdir()), "a temp folder, checked before anything is written");
  mkdirSync(join(logsDir, CONSOLE_AUDIT_DIR, "2026-10.jsonl"), { recursive: true });
  const read = readConsoleAudit({ logsDir, limit: 200 });
  assert.ok(!read.unreadable && read.rows.length === 1 && read.rows[0].broken === true && read.rows[0].line === 0, "the reader's answer for a file it cannot read: a row, not a throw");
  const unread = await updatesFacts({ audit: read.rows });
  assert.deepEqual([unread.recentGaps, unread.recentUnread, unread.recent], ["unread", false, []]);
  const words = wordsOf(await updatesPage({ facts: { audit: read.rows } }));
  assert.ok(words.includes(RECENT_GAPS_TEXT.unread) && !words.includes("Nothing in the audit log's window."), words.match(/Recently adopted.{0,200}/)?.[0]);
  // A line that is no row, among rows that were read: the rows are listed, and the note says one may be missing.
  const adopted = { action: "write-applied", kind: "package-adopt", outcome: "ok", target: "pi-lint@1.4.2", actor: { name: "ops", role: "operator", session: null }, at: "2026-10-01T10:00:00.000Z" };
  const damaged = [adopted, { broken: true, file: "2026-10.jsonl", line: 7 }];
  assert.equal((await updatesFacts({ audit: damaged })).recentGaps, "damaged");
  const listed = wordsOf(await updatesPage({ facts: { audit: damaged } }));
  assert.ok(listed.includes("pi-lint adopted 1.4.2") && listed.includes(RECENT_GAPS_TEXT.damaged) && !listed.includes(RECENT_GAPS_TEXT.unread), listed.match(/Recently adopted.{0,300}/)?.[0]);
  // A window read whole says neither.
  const whole = await updatesFacts({ audit: [adopted] });
  assert.equal(whole.recentGaps, null);
  const clean = wordsOf(await updatesPage({ facts: { audit: [adopted] } }));
  assert.ok(!clean.includes(RECENT_GAPS_TEXT.unread) && !clean.includes(RECENT_GAPS_TEXT.damaged));
});

test("/config/updates: a triggers file that could not be read or does not load leaves the canary's trigger not known; one that is not there, or holds no cron trigger, keeps 'no cron trigger can'", async () => {
  const fsOf = (answer) => ({ readFileSync: () => { if (answer instanceof Error) throw answer; return answer; } });
  const failing = (code) => Object.assign(new Error(code), { code });
  assert.deepEqual(readTriggersFile({ triggersPath: "/d/triggers.json", fs: fsOf(failing("ENOENT")) }), { document: null, trouble: null }, "not there: it holds none");
  assert.deepEqual(readTriggersFile({ triggersPath: "/d/triggers.json", fs: fsOf(failing("EACCES")) }), { document: null, trouble: "unreadable" });
  assert.deepEqual(readTriggersFile({ triggersPath: "/d/triggers.json", fs: fsOf("{ not json") }), { document: null, trouble: "invalid" });
  assert.equal(readTriggersFile({ triggersPath: "/d/triggers.json", fs: fsOf("{}") }).trouble, "invalid", "no triggers list");
  assert.deepEqual(readTriggersFile({ triggersPath: "/d/triggers.json", fs: fsOf('{"triggers":[]}') }), { document: { triggers: [] }, trouble: null });
  // The deployment's own read hands the reason on, with no Valkey at all.
  const deployed = async (answer) => (await readDeploymentUpdates({ redis: null, paths: { triggersPath: "/d/triggers.json" }, now: NOW, fs: fsOf(answer) })).triggersTrouble;
  assert.deepEqual([await deployed(failing("EACCES")), await deployed("{ not json"), await deployed(failing("ENOENT")), await deployed('{"triggers":[]}')], ["unreadable", "invalid", null, null]);
  for (const trouble of ["unreadable", "invalid"]) {
    assert.equal((await updatesFacts({ triggersDocument: null, triggersTrouble: trouble })).triggersTrouble, trouble);
    const words = wordsOf(await updatesPage({ facts: { triggersDocument: null, triggersTrouble: trouble } }));
    assert.ok(words.includes(`A canary runs as ${CANARY_TRIGGERS_UNREAD[trouble]}`), words.match(/A canary runs as.{0,80}/)?.[0]);
    assert.ok(words.includes(`Which trigger can run a canary is ${CANARY_TRIGGERS_UNREAD[trouble]}.`), "in the row that would offer one");
    assert.ok(!words.includes("no cron trigger can") && !words.includes("No cron trigger that loads this package can run a canary here."), trouble);
  }
  for (const triggersDocument of [null, { triggers: [] }]) {
    const words = wordsOf(await updatesPage({ facts: { triggersDocument } }));
    assert.ok(words.includes("A canary runs as no cron trigger can") && words.includes("No cron trigger that loads this package can run a canary here."));
    assert.ok(!words.includes(CANARY_TRIGGERS_UNREAD.unreadable) && !words.includes(CANARY_TRIGGERS_UNREAD.invalid));
  }
  assert.ok(HOST_ADOPT_STATES.includes("unread"), "the standing is one of the listed states");
});

test("/config/secrets over the files alone offers no write, the first problem's Remove included; over a snapshot the same problem has it", async () => {
  // A profile declared in both sources: a problem whose banner carries Remove from the overlay.
  const twice = () => secretFiles({ settings: { overlay: { secretProfiles: { default: "/srv/resolvers/read-default" } } } });
  const files = await secretsPage(noSnapshotFleet({ fileViews: twice }));
  assert.equal(files.data.secrets.problems[0].action?.action, "secret-profile-remove", "the problem that would offer the write");
  assert.ok(files.words.includes("Refused: default is declared twice"), "the problem is a file fact, and is said");
  assert.equal((files.html.match(/<form\b/g) ?? []).length, 0, "no form at all on the page");
  assert.ok(!files.html.includes("secret-profile-remove") && !files.html.includes("Remove from the overlay"));
  const snapshot = { ...twice(), runs: [], hosts: [], schedulers: [] };
  const read = await secretsPage({ snapshot: async () => snapshot, parkedCount: async () => 0 });
  assert.ok(read.html.includes("secret-profile-remove") && read.words.includes("Remove from the overlay"));
});

test("/config/secrets: a projects file that could not be read or does not load leaves a profile's projects not known; one not there or not configured is none in view", async () => {
  const page = async (projects) => {
    const snapshot = { ...secretFiles({ projects }), runs: [], hosts: [], schedulers: [] };
    return await secretsPage({ snapshot: async () => snapshot, parkedCount: async () => 0 });
  };
  for (const [projects, word] of [[{ unreadable: "EACCES" }, "could not be read"], [{ invalid: "bad" }, "does not load"]]) {
    const { data, words } = await page(projects);
    assert.equal(data.secrets.projectsKnown, false);
    assert.ok(words.includes(`not known: projects.json ${word}`) && !words.includes("none in view"), JSON.stringify(projects));
  }
  for (const projects of [{ missing: true }, { unset: true }, { projects: [] }]) {
    const { data, words } = await page(projects);
    assert.equal(data.secrets.projectsKnown, true, JSON.stringify(projects));
    assert.ok(words.includes("none in view") && !words.includes("not known: projects.json"), JSON.stringify(projects));
  }
});

test("the Secrets page's own read takes the file views and the console's env where no reader is wired", async () => {
  const parsed = parsePageQuery("secrets", "");
  const data = await loadPageData("secrets", parsed.query, { now: () => NOW, env: ENV, fleet: noSnapshotFleet({ fileViews: () => secretFiles() }) }, OP);
  assert.deepEqual({ filesKnown: data.secrets.filesKnown, fleetKnown: data.secrets.fleetKnown }, { filesKnown: true, fleetKnown: false });
  assert.deepEqual(data.secrets.profiles.map((p) => `${p.name}:${p.source}`), ["default:env", "prod:overlay"], "the overlay's from the files, the .env's from the env");
});

test("/config/connections: Notifications says which triggers keep a status comment is not known where the triggers were not read, and nothing of it where they were", async () => {
  const page = async (triggers) => {
    const parsed = parsePageQuery("connections", "");
    const connections = await consoleConnectionsFixture(NOW, { change: (snapshot) => { snapshot.triggers = triggers; } });
    const data = await loadPageData("connections", parsed.query, { now: () => NOW, env: {}, fleet: { snapshot: async () => ({ parked: [] }), parkedCount: async () => 0 }, connections: async () => connections }, { role: "operator" });
    return wordsOf((await pagePanels("connections", { query: parsed.query, session: OP, data, readOnly: false })).map((p) => p.html).join(" "));
  };
  const note = `Which triggers also keep a status comment is ${GRANTS_UNREAD}.`;
  assert.ok((await page({ unreadable: "EACCES" })).includes(note));
  for (const triggers of [{ missing: true }, { triggers: [] }]) {
    const read = await page(triggers);
    assert.ok(read.includes("Forge comments: on; paid failures and requests for input.") && !read.includes(note), JSON.stringify(triggers));
  }
});
