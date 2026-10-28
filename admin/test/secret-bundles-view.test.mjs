import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { stripAnsi, visibleLen } from "../src/style.mjs";
import {
  BUNDLE_FORMATS,
  BUNDLE_SKIPPED_TEXT,
  bundleDeclaredText,
  bundleReceivedText,
  envBundleProfiles,
  normalizeSecretBundlesForDisplay,
  readTriggers,
  recordBundle,
  renderSecretBundles,
  secretBundlesView,
  triggerBundleOf,
} from "../src/read-model.mjs";
import { pagePanels } from "../src/console/pages.mjs";
import { BUNDLE_FORMATS as WORKER_BUNDLE_FORMATS, parseSecretBundleProfiles } from "../../worker/src/secret-profiles.mjs";
import { BUNDLE_SKIPPED_REASONS } from "../../worker/src/run-history.mjs";

// Issue #704, part 4: the project secret bundles on the operator's surfaces. The bundles view (the triggers file's
// `secretBundles`, read leniently and never with its `ref`), a run's `bundle` and `bundleSkipped`, and the two copies
// the admin keeps of worker vocabulary, each bolted to its source here.

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { makeDashboard } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));

const flush = () => new Promise((resolve) => setImmediate(resolve));
const AT = Date.UTC(2026, 9, 20, 12, 0, 0);
const REF = "op-environment-ref-canary";

// ---- the bolts -------------------------------------------------------------------------------------------------------

test("the admin's copies of worker vocabulary are the worker's: the bundle formats, and a sentence for every skip reason", () => {
  assert.deepEqual([...BUNDLE_FORMATS], [...WORKER_BUNDLE_FORMATS]);
  assert.deepEqual(Object.keys(BUNDLE_SKIPPED_TEXT).sort(), [...BUNDLE_SKIPPED_REASONS].sort(), "a new reason must not render as nothing");
  for (const reason of BUNDLE_SKIPPED_REASONS) assert.ok(BUNDLE_SKIPPED_TEXT[reason].length > 10, reason);
});

test("envBundleProfiles reads PI_SECRET_BUNDLES as the worker's parser does, and calls a value the worker refuses malformed", () => {
  for (const raw of ["", "shop:/opt/r/shop.mjs:json", "a:/x:dotenv, b.c:/y z/q:json", "win:C:\\pi\\shop.cmd:json"]) {
    assert.deepEqual(envBundleProfiles(raw), { profiles: { ...parseSecretBundleProfiles(raw) }, malformed: false }, raw);
  }
  for (const raw of ["shop:/x", "shop:/x:yaml", "bad name:/x:json", "a:/x:json,a:/y:json", ":/x:json", "shop:relative/r.sh:json", "shop:./r.sh:dotenv", "shop:C:relative:json"]) {
    assert.throws(() => parseSecretBundleProfiles(raw), undefined, raw);
    assert.deepEqual(envBundleProfiles(raw), { profiles: {}, malformed: true }, raw);
  }
});

// ---- the display reader ----------------------------------------------------------------------------------------------

test("the display reader keeps a file without secretBundles key-identical, and never copies a bundle's ref", () => {
  const dir = tempDir("pd-704d-view-");
  const path = join(dir, "triggers.json");
  writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix" } }] }));
  const plain = readTriggers({ triggersPath: path });
  assert.deepEqual(Object.keys(plain).sort(), ["count", "triggers"]);
  assert.equal("secretBundle" in plain.triggers[0], false, "no opt-out, no key");
  writeFileSync(path, JSON.stringify({
    triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix", secretBundle: false } }],
    secretBundles: {
      zeta: { profile: "op-z", ref: REF, project: "zeta", endpoints: { Z_KEY: { host: "api.z.example", auth: "bearer" }, A_KEY: { host: 7 } } },
      alpha: { profile: 5, ref: REF, project: "alpha", forkReviews: "yes" },
      broken: "not an object",
    },
  }));
  const view = readTriggers({ triggersPath: path });
  assert.equal(view.triggers[0].secretBundle, false);
  assert.deepEqual(view.secretBundles, [
    { id: "alpha", project: "alpha", profile: null, forkReviews: false, endpoints: [] },
    { id: "zeta", project: "zeta", profile: "op-z", forkReviews: false, endpoints: [{ name: "A_KEY", host: null }, { name: "Z_KEY", host: "api.z.example" }] },
  ], "lenient: a wrong type reads as null or false, a non-object entry is skipped, sorted by id");
  assert.ok(!JSON.stringify(view).includes(REF), "the ref never reaches a display record");
  assert.equal(normalizeSecretBundlesForDisplay(["a"]), null);
  assert.equal(normalizeSecretBundlesForDisplay(undefined), null);
});

/** A triggers view, projects and settings with one bundle of each declared state. */
function fixture({ env = {}, overlay = {} } = {}) {
  const triggers = {
    triggers: [
      { type: "cron", id: "nightly", folder: "/srv/shop", flow: "tidy", index: 0 },
      { type: "cron", id: "off", folder: "/srv/shop", flow: "tidy", index: 1, secretBundle: false },
      { type: "label", any: ["pi"], flow: "fix", index: 2 },
      { type: "comment", phrase: "@pi", flow: "fix", index: 3, secretBundle: false },
      { type: "cron", id: "lone", folder: "/srv/elsewhere", flow: "tidy", index: 4 },
    ],
    secretBundles: [
      { id: "shop", project: "shop", profile: "op-shop", forkReviews: true, endpoints: [{ name: "STRIPE_KEY", host: "api.stripe.com" }] },
      { id: "web", project: "web", profile: "op-web", forkReviews: false, endpoints: [] },
      { id: "ghost", project: "ghost", profile: "nowhere", forkReviews: false, endpoints: [] },
    ],
  };
  const projects = { projects: [{ id: "shop", members: ["/srv/shop"] }, { id: "web", members: ["github:acme/web"] }] };
  const settings = { overlay: { secretBundles: overlay } };
  const runs = [
    { jobId: "gh-old", endedAt: "2026-10-19T10:00:00Z", bundle: { id: "shop", variables: ["OLD"], shadowed: [] } },
    { jobId: "gh-new", endedAt: "2026-10-20T10:00:00Z", bundle: { id: "shop", variables: ["B_TOKEN", "A_URL"], shadowed: ["A_URL"] } },
    { jobId: "gh-bad", endedAt: "2026-10-21T10:00:00Z", bundle: { id: "shop", variables: ["not a name"], shadowed: [] } },
  ];
  return secretBundlesView({ triggers, settings, env, projects, runs });
}

test("secretBundlesView: where each profile is declared, the project, the opted-out triggers and the newest run's names", () => {
  assert.equal(secretBundlesView({ triggers: { triggers: [] } }), null, "no bundle, no view: every surface renders as before");
  const v = fixture({ env: { PI_SECRET_BUNDLES: "op-shop:/opt/r/shop.mjs:json", PI_SECRET_RESOLVER_ROOTS: "/opt/r" }, overlay: { "op-web": { path: "/opt/r/web.sh", format: "dotenv" } } });
  const by = Object.fromEntries(v.bundles.map((b) => [b.id, b]));
  assert.deepEqual([by.shop.declared, by.shop.format], ["env", "json"]);
  assert.deepEqual([by.web.declared, by.web.format], ["overlay", "dotenv"]);
  assert.deepEqual([by.ghost.declared, by.ghost.format, by.ghost.projectKnown], ["missing", null, false]);
  assert.equal(by.shop.projectKnown, true);
  // The cron trigger in the shop folder that opts out, and every webhook trigger that does (it may fire on any repo).
  assert.deepEqual(by.shop.optedOut, [1, 3]);
  assert.deepEqual(by.web.optedOut, [3]);
  // The newest VALID record: a record whose names break the charset is the worker's rebuild's null, never shown.
  assert.deepEqual(by.shop.last, { jobId: "gh-new", variables: ["A_URL", "B_TOKEN"] });
  assert.equal(by.web.last, null);
  assert.deepEqual(triggerBundleOf({ index: 0 }, v), { id: "shop", optedOut: false });
  assert.deepEqual(triggerBundleOf({ index: 1 }, v), { id: "shop", optedOut: true });
  assert.equal(triggerBundleOf({ index: 2 }, v), null, "a webhook trigger belongs to no project");
  assert.deepEqual(triggerBundleOf({ index: 3 }, v), { id: null, optedOut: true });
  assert.equal(triggerBundleOf({ index: 4 }, v), null, "a folder in no bundled project");
  // An opt-out on a cron trigger outside every bundled project opts out of nothing, so nothing is said (review L5).
  const lone = secretBundlesView({ triggers: { triggers: [{ type: "cron", id: "lone", folder: "/srv/elsewhere", index: 0, secretBundle: false }], secretBundles: [{ id: "shop", project: "shop", profile: "p", forkReviews: false, endpoints: [] }] }, projects: { projects: [{ id: "shop", members: ["/srv/shop"] }] } });
  assert.equal(triggerBundleOf({ index: 0 }, lone), null);
  assert.deepEqual(lone.bundles[0].optedOut, []);
  // An overlay resolver outside PI_SECRET_RESOLVER_ROOTS (unset is empty: fail closed) is one the worker will not run.
  for (const env of [{ PI_SECRET_BUNDLES: "", PI_SECRET_RESOLVER_ROOTS: "" }, { PI_SECRET_BUNDLES: "", PI_SECRET_RESOLVER_ROOTS: "/opt/other" }, { PI_SECRET_BUNDLES: "", PI_SECRET_RESOLVER_ROOTS: "/opt/r/web" }]) {
    const web = fixture({ env, overlay: { "op-web": { path: "/opt/r/web.sh", format: "dotenv" } } }).bundles.find((b) => b.id === "web");
    assert.deepEqual([web.declared, web.format], ["overlay-outside-roots", "dotenv"], JSON.stringify(env));
  }
  // Roots the panel cannot see are not "no roots": the overlay resolver is said as declared, roots not visible.
  const blind = fixture({ env: { PI_SECRET_BUNDLES: "" }, overlay: { "op-web": { path: "/opt/r/web.sh", format: "dotenv" } } }).bundles.find((b) => b.id === "web");
  assert.deepEqual([blind.declared, blind.rootsSeen], ["overlay", false]);
  assert.match(bundleDeclaredText(blind), /PI_SECRET_RESOLVER_ROOTS is not visible to the panel; doctor --secrets checks it runs/);
  // A PI_SECRET_BUNDLES the panel cannot see is not proof the worker's host declares none.
  assert.deepEqual(fixture({}).bundles.map((b) => b.declared), ["unseen", "unseen", "unseen"]);
  assert.deepEqual(fixture({ env: { PI_SECRET_BUNDLES: "" } }).bundles.map((b) => b.declared), ["missing", "missing", "missing"]);
  // A name in both sources is ambiguous for EVERY bundle (the worker's mergeSecretProfiles); a malformed env is said.
  const both = fixture({ env: { PI_SECRET_BUNDLES: "op-web:/opt/x:json" }, overlay: { "op-web": { path: "/opt/r/web.sh", format: "dotenv" } } });
  assert.deepEqual(both.bundles.map((b) => b.declared), ["ambiguous", "ambiguous", "ambiguous"]);
  assert.deepEqual(fixture({ env: { PI_SECRET_BUNDLES: "op-shop:/x" } }).bundles.map((b) => b.declared), ["env-malformed", "env-malformed", "env-malformed"]);
});

test("renderSecretBundles: the facts in words, control bytes scrubbed, and no variable names on the model-visible channel", () => {
  const v = fixture({ env: { PI_SECRET_BUNDLES: "op-shop:/opt/r/shop.mjs:json" } });
  const text = renderSecretBundles(v);
  assert.match(text, /^Secret bundles \(triggers\.json; names only, never a reference or a value\):/);
  assert.match(text, /  shop: project shop; profile op-shop \(declared in PI_SECRET_BUNDLES, json; doctor --secrets checks it runs\); fork reviews get it; 1 endpoint: STRIPE_KEY at api\.stripe\.com; 2 triggers opt out: #2, #4/);
  assert.match(text, /    last run gh-new received: A_URL, B_TOKEN/);
  assert.match(text, /  ghost: project ghost \(not in projects\.json\); profile nowhere \(not declared in the overlay or PI_SECRET_BUNDLES: this project's jobs are refused before they spend\)/);
  const quiet = renderSecretBundles(v, { names: false });
  assert.ok(!quiet.includes("B_TOKEN") && !quiet.includes("received"), quiet);
  assert.equal(renderSecretBundles(null), "");
  const hostile = renderSecretBundles({ bundles: [{ id: "x\u001b[31m\u202Ey", project: "p\u0007", profile: "q", forkReviews: false, endpoints: [], optedOut: [], declared: "missing", last: null }] });
  assert.ok(!/[\u0000-\u001f\u007f\u202e]/.test(hostile.replace(/\n/g, "")), JSON.stringify(hostile));
});

// ---- a run's bundle facts ----------------------------------------------------------------------------------------------

test("recordBundle is the worker's rebuild: names in the env charset, the closed skip enum, and nothing for a record without either", () => {
  assert.equal(recordBundle({ jobId: "x" }), null);
  assert.deepEqual(recordBundle({ bundle: { id: "shop", variables: ["B", "A", "A"], shadowed: ["A"], placeholders: 1, plain: 1 } }), { bundle: { id: "shop", variables: ["A", "B"], shadowed: ["A"], placeholders: 1, plain: 1 }, bundleSkipped: null });
  assert.deepEqual(recordBundle({ bundleSkipped: "fork" }), { bundle: null, bundleSkipped: "fork" });
  for (const hostile of [{ bundle: { id: "s\u001b", variables: [], shadowed: [] } }, { bundle: { id: "s", variables: ["A=1"], shadowed: [] } }, { bundleSkipped: "because \u001b[31m" }, { bundle: "shop" }]) {
    assert.equal(recordBundle(hostile), null, JSON.stringify(hostile));
  }
  assert.equal(bundleReceivedText({ id: "shop", variables: ["A", "B", "C"], shadowed: [] }), "Variables received: A, B, C (from bundle shop)");
  assert.equal(bundleReceivedText({ id: "shop", variables: [], shadowed: [] }), "No variables received from bundle shop");
});

// ---- the console ---------------------------------------------------------------------------------------------------------

const ctxOf = (role, data) => ({ query: { id: "gh-1" }, session: { name: role, role }, data: { now: AT, env: {}, ...data }, readOnly: false });

test("the console's run page shows the variables received, the shadowed names, the openshell counts and a skip's sentence, escaped", async () => {
  const page = async (extra, role = "operator") => (await pagePanels("run", ctxOf(role, { run: { record: { jobId: "gh-1", kind: "github", target: "acme/web#1", ...extra }, source: "local" } }))).map((p) => p.html).join("");
  const got = await page({ bundle: { id: "shop", variables: ["B_TOKEN", "A_URL"], shadowed: ["A_URL"], placeholders: 1, plain: 1 } });
  assert.match(got, /<dt>Secret bundle<\/dt><dd>Variables received: B_TOKEN \(from bundle shop\); shadowed by the trigger&#39;s own run\.secrets: A_URL; 1 as a placeholder, 1 as a value<\/dd>/);
  assert.match(got, /The trigger's value won; the bundle's was not passed: A_URL/);
  const viewer = await page({ bundle: { id: "shop", variables: ["B_TOKEN", "A_URL"], shadowed: ["A_URL"], placeholders: 1, plain: 1 } }, "viewer");
  assert.doesNotMatch(viewer, /B_TOKEN|A_URL|Secret bundle|Variables received/, "viewer streams omit the secrets panel on the server");
  assert.match(await page({ bundleSkipped: "head-unverified" }), /<dt>Bundle skipped<\/dt><dd>head-unverified: the forge would not say whose pull request this is/);
  const none = await page({});
  assert.ok(!none.includes("Secret bundle") && !none.includes("Bundle skipped"), "a run outside a bundled project draws neither row");
  for (const hostile of [{ bundle: { id: "<script>", variables: [], shadowed: [] } }, { bundleSkipped: "<b>x</b>" }]) assert.equal(await page(hostile), none, JSON.stringify(hostile));
});

test("the console's configuration lists each bundle with its facts, the resolvers by name and format, never a ref or a resolver path", async () => {
  const bundles = fixture({ env: { PI_SECRET_BUNDLES: "op-shop:/opt/r/shop.mjs:json" } });
  bundles.bundles.push({ id: "<img src=x>", project: "p", profile: "q", forkReviews: false, endpoints: [], optedOut: [], declared: "missing", format: null, projectKnown: null, last: null });
  const snapshot = {
    settings: { overlay: { secretBundles: { "op-web": { path: "/opt/r/web.sh", format: "dotenv" } } } },
    triggers: { triggers: [{ type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv/shop", flow: "tidy", index: 0 }, { type: "cron", id: "off", pattern: "0 4 * * *", folder: "/srv/shop", flow: "tidy", index: 1, secretBundle: false }] },
    secretBundles: bundles,
    projects: { unset: true },
    pauseWindows: { missing: true },
    scopedLimits: { missing: true },
    overlayMcp: { servers: [], refused: [], unreadable: null },
    stagedPackages: { stagedAt: null, packages: [] },
  };
  const panels = await pagePanels("config", ctxOf("operator", { snapshot }));
  const html = panels.map((p) => p.html).join("");
  const one = panels.find((p) => p.id === "p-secret-bundles")?.html ?? "";
  assert.match(one, /<li class="mono">op-web \(dotenv\)<\/li>/);
  assert.match(one, /<td class="mono">shop<\/td><td>shop<\/td><td>op-shop \(declared in PI_SECRET_BUNDLES, json; doctor --secrets checks it runs\)<\/td><td>yes<\/td><td class="mono">STRIPE_KEY at api\.stripe\.com<\/td><td>index 1, index 3<\/td>/, "the opt-outs by the index the Triggers table shows; the pi panel counts from 1");
  assert.match(one, /A_URL, B_TOKEN \(<a class="mono" href="\/run\?id=gh-new">gh-new<\/a>\)/);
  assert.match(one, /class="warn">nowhere \(not declared in the overlay or PI_SECRET_BUNDLES/, "an undeclared profile is marked");
  assert.match(one, /data-action="secret-bundle-add"/);
  assert.match(one, /&lt;img src=x&gt;/);
  assert.ok(!one.includes("<img"), "escaped");
  assert.ok(!html.includes("/opt/r/") && !html.includes(REF), "no resolver path, no reference");
  // The trigger table names the bundle a cron trigger's jobs hold, or its opt-out.
  assert.match(html, /<td>bundle shop; staged packages<\/td>/);
  assert.match(html, /<td>opted out of bundle shop; staged packages<\/td>/);
});

// ---- the panel -------------------------------------------------------------------------------------------------------------

const BASE = {
  queue: { pausedState: false, counts: { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }, workers: 1 },
  budget: { day: 0, week: 0, month: 0 },
  settings: { path: "/s", overlay: {} },
  runs: [],
  stagedPackages: { stagedAt: null, packages: [] },
};

async function render(snap, width, keys = []) {
  const comp = makeDashboard({ paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000, deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT } });
  await flush();
  for (const k of keys) {
    comp.handleInput(k);
    await flush();
  }
  const lines = comp.render(width);
  await comp.dispose();
  return lines;
}

test("the panel's list: [bundle <id>] beside [secrets], [no bundle] on an opt-out, a secret bundles section, every row in the frame", async () => {
  const view = fixture({ env: { PI_SECRET_BUNDLES: "op-shop:/opt/r/shop.mjs:json" } });
  const triggers = { triggers: [
    { type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv/shop", flow: "tidy", packages: false, secrets: 1, secretsProfile: "prod", index: 0 },
    { type: "cron", id: "off", pattern: "0 4 * * *", folder: "/srv/shop", flow: "tidy", packages: false, index: 1, secretBundle: false },
  ] };
  const lines = (await render({ ...BASE, triggers, secretBundles: view }, 120)).map(stripAnsi);
  const all = lines.join("\n");
  assert.match(all, /nightly .*\[secrets 1 via prod\] \[bundle shop\]/);
  assert.match(all, /off .*\[no bundle\]/);
  assert.match(all, /SECRET BUNDLES .* 3 · names only · doctor --secrets resolves/);
  assert.match(all, /│ shop  project shop · profile op-shop \(env, json\) · forks yes · 1 endpoint · opt-out #2 #4 +│/);
  assert.match(all, /│ ghost  project ghost \(not in projects\.json\) · profile nowhere \(NOT DECLARED\) · forks no · 0 endpoints · opt-out #4 +│/);
  assert.match(all, /last received: A_URL, B_TOKEN/);
  // Without a bundle the list is what it was: no section, no badge.
  const before = (await render({ ...BASE, triggers }, 120)).map(stripAnsi).join("\n");
  assert.ok(!before.includes("bundle"), before);
  for (const width of [40, 60, 80, 120]) for (const l of await render({ ...BASE, triggers, secretBundles: view }, width)) assert.ok(visibleLen(l) <= width, `width ${width}: ${JSON.stringify(stripAnsi(l))}`);
});

test("the panel's RUN_DETAIL wraps the received names under the label, says why a run went without, and drops a hostile record", async () => {
  const run = { jobId: "gh-1", kind: "github", target: "acme/web#1", outcome: "completed", startedAt: "2026-10-20T10:00:00Z", endedAt: "2026-10-20T10:05:00Z", flow: "fix" };
  const open = async (extra, width = 80) => (await render({ ...BASE, triggers: { triggers: [] }, runs: [{ ...run, ...extra }] }, width, ["\r"])).map(stripAnsi);
  const names = Array.from({ length: 30 }, (_, i) => `VARIABLE_${String(i).padStart(2, "0")}`);
  const got = (await open({ bundle: { id: "shop", variables: names, shadowed: ["VARIABLE_00"], placeholders: 2, plain: 28 } })).join("\n");
  assert.match(got, /bundle\s+Variables received: VARIABLE_00, VARIABLE_01/);
  assert.match(got, /more line\(s\) in the run record/, "a long list is counted, never cut silently");
  assert.match(got, /shadowed by run\.secrets: VARIABLE_00/);
  assert.match(got, /2 as placeholders, 28 as values/);
  assert.match((await open({ bundleSkipped: "chained" })).join("\n"), /bundle\s+skipped \(chained\): a chained \/outbox child/);
  const older = await open({});
  for (const hostile of [{ bundle: { id: "s\u001b[31m", variables: [], shadowed: [] } }, { bundleSkipped: "because \u001b[31m" }]) assert.deepEqual(await open(hostile), older, JSON.stringify(hostile));
  for (const width of [30, 40, 60, 80, 120]) {
    for (const l of await render({ ...BASE, triggers: { triggers: [] }, runs: [{ ...run, bundle: { id: "b".repeat(128), variables: names, shadowed: names, placeholders: 30, plain: 0 } }] }, width, ["\r"])) assert.ok(visibleLen(l) <= width, `width ${width}: ${JSON.stringify(stripAnsi(l))}`);
  }
});

test("the panel's TRIGGER_DETAIL names the bundle a trigger's jobs hold, its opt-out, or the bundles a webhook trigger's jobs may hold", async () => {
  const view = fixture({ env: { PI_SECRET_BUNDLES: "op-shop:/opt/r/shop.mjs:json" } });
  const open = async (trigger, bundles = view) => {
    const lines = await render({ ...BASE, triggers: { triggers: [trigger] }, ...(bundles ? { secretBundles: bundles } : {}) }, 80, ["\r"]);
    for (const l of lines) assert.ok(visibleLen(l) <= 80, JSON.stringify(stripAnsi(l)));
    // The rows' text with the frame and the wrap folded away, so a value wrapped under its label reads whole.
    return lines.map((l) => stripAnsi(l).replace(/[│┌┐└┘─]/g, " ")).join(" ").replace(/\s+/g, " ");
  };
  const cron = { type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv/shop", flow: "tidy", packages: false, index: 0 };
  const held = await open(cron);
  assert.match(held, /bundle\s+shop: its project's whole environment/);
  assert.match(held, /bundle shop: every variable its resolver prints/);
  assert.match(await open({ ...cron, index: 1, secretBundle: false }), /bundle\s+opted out of shop \(run\.secretBundle: false\)/);
  assert.match(await open({ ...cron, index: 4, folder: "/srv/elsewhere" }), /bundle\s+none: the folder is in no bundled project/);
  assert.match(await open({ type: "label", any: ["pi"], all: [], none: [], flow: "fix", packages: false, index: 2 }), /bundle\s+a job on a bundled project's repository holds it \(shop, web, ghost\)/);
  assert.ok(!/\bbundle\b/.test(await open(cron, null)), "no bundle bound, no row");
});
