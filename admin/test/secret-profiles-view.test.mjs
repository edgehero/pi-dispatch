import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { stripAnsi, visibleLen } from "../src/style.mjs";
import {
  PROFILE_ROOTS_TEXT,
  PROFILE_SOURCE_TEXT,
  SECRET_RESOLVE_REASONS,
  modelRunRecord,
  openshellCountsText,
  openshellHostsText,
  profileHostsText,
  profileLastText,
  recordOpenshell,
  recordSecretsProfile,
  renderSecretProfilesView,
  resolverRootsStatus,
  secretProfileFacts,
  secretProfilesView,
} from "../src/read-model.mjs";
import { resolverRootsJudgement } from "../src/write-plans.mjs";
import { pagePanels } from "../src/console/pages.mjs";
import { parseDocument } from "./helpers/script-dom.mjs";
import { secretsView } from "../src/secrets-view.mjs";
import { secretsProfiles } from "../src/console/panels/secrets.mjs";

// Issue #712, PR D: a run's OpenShell policy facts and secrets profile on the run views, and the secret profiles view
// (source, roots, triggers, projects, last resolve, the hosts that advertise each) on the console, the panel and
// `/dispatch secrets list`.

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { makeDashboard } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));

const flush = () => new Promise((resolve) => setImmediate(resolve));
const AT = Date.UTC(2026, 9, 21, 12, 0, 0);
const PATH = "/opt/secret-resolvers/prod.sh";

/** A realpath that resolves what `real` maps and says ENOENT for the rest. */
const fsWith = (real) => ({
  realpathSync: (p) => {
    if (Object.hasOwn(real, p)) return real[p];
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  },
});

const TRIGGERS = {
  triggers: [
    { type: "cron", id: "nightly", folder: "/srv/shop", secrets: 2, secretsProfile: "prod", index: 0 },
    { type: "label", secrets: 1, secretsProfile: null, index: 1 },
    { type: "cron", id: "plain", folder: "/srv/shop", secrets: 0, secretsProfile: null, index: 2 },
    { type: "comment", secrets: 1, secretsProfile: "ghost", index: 3 },
  ],
};
const PROJECTS = { projects: [{ id: "shop", members: ["/srv/shop"] }] };

// ---- the view ----------------------------------------------------------------------------------------------------------

test("secretProfilesView: each source, the roots by realpath, the implicit default, projects, the newest run's resolve, and the advertising hosts", () => {
  const view = secretProfilesView({
    triggers: TRIGGERS,
    settings: { overlay: { secretProfiles: { prod: PATH, both: "/opt/secret-resolvers/b.sh" } } },
    env: { PI_SECRET_PROFILES: "default:/etc/pi/default.sh,both:/etc/pi/b.sh", PI_SECRET_RESOLVER_ROOTS: "/opt/secret-resolvers" },
    projects: PROJECTS,
    runs: [
      { jobId: "gh-old", endedAt: "2026-10-20T10:00:00Z", secretsProfile: "prod", outcome: "completed", exitCode: 0 },
      { jobId: "gh-new", endedAt: "2026-10-21T10:00:00Z", secretsProfile: "prod", outcome: "policy", reason: "secret-unresolved" },
      { jobId: "gh-d", endedAt: "2026-10-21T09:00:00Z", secretsProfile: "default", outcome: "completed", exitCode: 0, tokens: { total: 1 } },
      { jobId: "gh-x", endedAt: "2026-10-21T11:00:00Z", secretsProfile: "bad name", outcome: "policy", reason: "secret-unresolved" },
    ],
    hosts: [{ name: "mini1", caps: ["s:prod", "w:ci"] }, { name: "mini2", caps: ["s:default"] }, { name: "old" }],
    fs: fsWith({ [PATH]: PATH, "/opt/secret-resolvers/b.sh": "/elsewhere/b.sh" }),
  });
  const by = Object.fromEntries(view.profiles.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(by), ["both", "default", "ghost", "prod"], "sorted; declared, implicit and named-only profiles all listed");
  assert.equal(by.prod.source, "overlay");
  assert.equal(by.prod.roots, "inside");
  assert.equal(by.both.source, "ambiguous");
  assert.equal(by.both.roots, "outside", "its real path left the roots, the worker's own comparison");
  assert.equal(by.default.source, "env");
  assert.equal(by.default.roots, null, "an env resolver is not bounded by the roots");
  assert.equal(by.ghost.source, "undeclared");
  assert.deepEqual(by.prod.triggers, [0]);
  assert.deepEqual(by.default.triggers, [1], "run.secrets without a profile resolves through default; a trigger without secrets uses none");
  assert.deepEqual(by.prod.projects, ["shop"]);
  assert.equal(by.prod.anyRepo, false);
  assert.equal(by.default.anyRepo, true, "a webhook trigger's jobs may land in any project");
  assert.deepEqual(by.prod.last, { jobId: "gh-new", at: "2026-10-21T10:00:00.000Z", outcome: "refused", reason: "secret-unresolved", bundled: false }, "the newest run naming it");
  assert.equal(by.default.last.outcome, "resolved");
  assert.equal(by.ghost.last, null);
  assert.deepEqual(by.prod.hosts, ["mini1"]);
  assert.deepEqual(by.default.hosts, ["mini2"]);
  assert.equal(by.prod.hostsUnknown, 1, "a row with no caps list is counted, never read as advertising nothing");
  assert.ok(!JSON.stringify(view).includes("/opt/") && !JSON.stringify(view).includes("/etc/"), "no resolver path on any row");
  // A run that ended before any container cannot say whether its resolve ran.
  const early = secretProfilesView({ triggers: TRIGGERS, runs: [{ jobId: "gh-e", endedAt: "2026-10-21T10:00:00Z", secretsProfile: "prod", outcome: "policy", reason: "model-unknown", exitCode: null }] });
  assert.equal(early.profiles.find((p) => p.name === "prod").last.outcome, "not-reached");
  assert.equal(secretProfilesView({ triggers: { triggers: [] } }), null, "nothing declared or named: no view");
});

test("resolverRootsStatus is the add's own rule: the judgement and the view agree on every case", () => {
  const env = { PI_SECRET_RESOLVER_ROOTS: "/opt/r" };
  const cases = [
    [{}, "/opt/r/a.sh", fsWith({}), "unseen"],
    [{ PI_SECRET_RESOLVER_ROOTS: "" }, "/opt/r/a.sh", fsWith({}), "empty"],
    [env, "/opt/r/a.sh", fsWith({}), "unresolved"],
    [env, "/opt/r/a.sh", fsWith({ "/opt/r/a.sh": "/opt/r/a.sh" }), "inside"],
    [env, "/opt/r/a.sh", fsWith({ "/opt/r/a.sh": "/tmp/a.sh" }), "outside"],
    [env, "/tmp/a.sh", fsWith({ "/tmp/a.sh": "/opt/r/a.sh" }), "inside"],
  ];
  const judged = { unseen: [], inside: [], empty: ["refusal"], outside: ["refusal"], unresolved: ["warning"] };
  for (const [e, path, fs, want] of cases) {
    assert.equal(resolverRootsStatus(path, e, fs).status, want, `${path} ${JSON.stringify(e)}`);
    assert.deepEqual(Object.keys(resolverRootsJudgement(path, e, fs)), judged[want], `the add's judgement for ${want}`);
  }
  assert.throws(() => resolverRootsStatus("/x", env, { realpathSync: () => { throw new Error("fault"); } }), /fault/, "a fault is not an answer");
  // Round 1: the add's judgement is strict on its seam. An fs without realpath is a wiring fault, never "unresolved",
  // which would admit the write with a note (the fail-open class).
  assert.throws(() => resolverRootsJudgement("/x", env, {}), TypeError);
  assert.throws(() => resolverRootsJudgement("/x", env, null), TypeError);
  // The view alone tolerates it, per row: that profile reads unresolved, the others are still judged.
  const v = secretProfilesView({ settings: { overlay: { secretProfiles: { a: "/opt/r/a.sh", b: "/opt/r/b.sh" } } }, env, fs: { realpathSync: (p) => { if (p === "/opt/r/a.sh") throw new Error("fault"); return p; } } });
  assert.deepEqual(v.profiles.map((p) => [p.name, p.roots]), [["a", "unresolved"], ["b", "inside"]]);
  assert.equal(secretProfilesView({ settings: { overlay: { secretProfiles: { a: "/opt/r/a.sh" } } }, env, fs: {} }).profiles[0].roots, "unresolved");
  for (const k of ["inside", "outside", "unresolved", "unseen", "empty"]) assert.ok(PROFILE_ROOTS_TEXT[k] && !PROFILE_ROOTS_TEXT[k].includes("/"), k);
  for (const k of ["env", "overlay", "ambiguous", "undeclared"]) assert.ok(PROFILE_SOURCE_TEXT[k], k);
});

test("SECRET_RESOLVE_REASONS are the processor's own secret refusals", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../worker/src/processor.mjs", import.meta.url), "utf8");
  const found = [...new Set([...src.matchAll(/reason: "(secret-[a-z-]+)"/g)].map((m) => m[1]).filter((r) => !r.startsWith("secret-bundle-")))].sort();
  assert.deepEqual([...SECRET_RESOLVE_REASONS].sort(), found, "a new secret refusal must be named here or the view calls it not-reached");
});

test("renderSecretProfilesView: one scrubbed line per profile, the registry said as unread where none was read", () => {
  const view = secretProfilesView({ triggers: TRIGGERS, settings: { overlay: { secretProfiles: { "pr\u001bod": "/x" } } }, env: {}, hosts: null });
  const text = renderSecretProfilesView(view);
  assert.match(text, /^Secret profiles in use \(names only; the resolver paths are listed above\):/);
  assert.match(text, /\n  prod: named by a trigger, declared in no source this view can see \(PI_SECRET_PROFILES is not visible here\); used by trigger #1; last resolve: no run in view recorded it; served by: the registry is not read here/);
  assert.ok(!text.includes("pr\u001bod") && !text.includes("pr od"), "a name outside the charset is no profile");
  assert.ok(!text.includes("\u001b"));
  assert.equal(renderSecretProfilesView(null), "");
  const facts = secretProfileFacts(view.profiles.find((p) => p.name === "default"), view);
  assert.ok(facts.includes("projects: any (a webhook trigger)"), facts.join("|"));
});

// ---- a run's facts ----------------------------------------------------------------------------------------------------

const OPENSHELL = { mode: "copy", ruleHosts: ["api.anthropic.com", "github.com"], ruleHostCount: 2, providers: 1, placeholders: 3 };

test("recordOpenshell and recordSecretsProfile rebuild, and the model projection keeps names and counts, never a path", () => {
  const r = { jobId: "gh-1", backend: "openshell", openshell: { ...OPENSHELL, ruleHosts: ["github.com", "evil.com/x", "api.anthropic.com"] }, secretsProfile: "prod" };
  assert.deepEqual(recordOpenshell(r), { ...OPENSHELL });
  assert.equal(recordOpenshell({ ...r, backend: "local" }), null, "the facts are held to the venue the record names");
  assert.equal(recordSecretsProfile(r), "prod");
  assert.equal(recordSecretsProfile({ secretsProfile: "<b>" }), null);
  assert.equal(openshellCountsText(OPENSHELL), "copy mode, 1 credential provider, 3 placeholders");
  assert.equal(openshellHostsText(OPENSHELL), "2 rule hosts: api.anthropic.com, github.com");
  assert.equal(openshellHostsText({ ...OPENSHELL, ruleHostCount: 40 }), "40 rule hosts: api.anthropic.com, github.com and 38 more");
  assert.equal(openshellHostsText({ ...OPENSHELL, ruleHosts: [], ruleHostCount: 0 }), "no rule host: the sandbox reaches nothing");
  const model = modelRunRecord(r);
  assert.deepEqual(model.openshell, OPENSHELL);
  assert.equal(model.secretsProfile, "prod");
  assert.deepEqual(Object.keys(modelRunRecord({ ...r, openshell: { mode: "x" }, secretsProfile: "a b" })).sort(), ["backend", "jobId"], "an invalid key is dropped whole");
  const plain = { jobId: "gh-2", outcome: "completed" };
  assert.equal(modelRunRecord(plain), plain, "a record without the keys is the same object");
});

const ctxOf = (role, data) => ({ query: { id: "gh-1" }, session: { name: role, role }, data: { now: AT, env: {}, ...data }, readOnly: false });

test("the console's run page: the sandbox policy, the rule hosts and the secrets profile, escaped; nothing for a run without them", async () => {
  const page = async (extra) => (await pagePanels("run", ctxOf("operator", { run: { record: { jobId: "gh-1", kind: "github", target: "acme/web#1", backend: "openshell", ...extra }, source: "local" } }))).map((p) => p.html).join("");
  const got = await page({ openshell: OPENSHELL, secretsProfile: "prod" });
  assert.match(got, /<dt>Sandbox policy<\/dt><dd>copy mode, 1 credential provider, 3 placeholders<\/dd>/);
  const hostFacts = parseDocument(`<html><body>${got}</body></html>`).querySelectorAll(".fact");
  const ruleHosts = [...hostFacts].find((f) => f.querySelector("dt")?.textContent === "Rule hosts");
  assert.ok(ruleHosts.querySelector("dd").textContent.startsWith("2 rule hosts:"));
  assert.deepEqual([...ruleHosts.querySelectorAll(".chip")].map((e) => e.textContent), OPENSHELL.ruleHosts, "each validated host is a chip, in record order");
  assert.match(got, /<dt>Secrets profile<\/dt><dd>prod<\/dd>/);
  const none = await page({});
  assert.ok(!none.includes("Sandbox policy") && !none.includes("Secrets profile"));
  for (const hostile of [{ openshell: { ...OPENSHELL, mode: "<b>HOSTILE-MODE</b>" } }, { secretsProfile: "<script>" }, { openshell: { ...OPENSHELL, ruleHosts: ["<img src=x>"], ruleHostCount: 0 } }]) {
    const html = await page(hostile);
    assert.ok(!html.includes("<img") && !html.includes("<script>") && !html.includes("HOSTILE-MODE"), JSON.stringify(hostile));
  }
});

test("the console's Secrets page: each profile's use in a table, words and names only, never a resolver path", async () => {
  const profiles = secretProfilesView({
    triggers: TRIGGERS,
    settings: { overlay: { secretProfiles: { prod: PATH } } },
    env: { PI_SECRET_RESOLVER_ROOTS: "/opt/secret-resolvers" },
    projects: PROJECTS,
    runs: [{ jobId: "gh-new", endedAt: "2026-10-21T10:00:00Z", secretsProfile: "prod", outcome: "policy", reason: "secret-unresolved" }],
    hosts: [{ name: "mini1", caps: ["s:prod"] }, { name: "mini<hostile>", caps: ["s:prod"] }],
    fs: fsWith({ [PATH]: "/tmp/elsewhere.sh" }),
  });
  const snapshot = {
    settings: { overlay: { secretProfiles: { prod: PATH } } },
    secretProfiles: profiles,
    secretProfilesEnv: { names: [], malformed: false, seen: false },
    triggers: TRIGGERS,
    projects: { unset: true },
    pauseWindows: { missing: true },
    scopedLimits: { missing: true },
    overlayMcp: { servers: [], refused: [], unreadable: null },
    stagedPackages: { stagedAt: null, packages: [] },
  };
  const data = secretsView({ snapshot, env: { PI_SECRET_RESOLVER_ROOTS: "/opt/secret-resolvers" }, fs: fsWith({ [PATH]: "/tmp/elsewhere.sh" }) });
  const one = String(secretsProfiles({ data: { secrets: data }, role: "operator" }));
  const doc = parseDocument(`<html><body>${one}</body></html>`);
  const row = doc.querySelector('a[href="/config/trigger?index=0"]').closest("tr");
  assert.match(row.textContent, /prod.*declared in the settings overlay.*outside PI_SECRET_RESOLVER_ROOTS/);
  assert.equal(row.className, "row--failed");
  assert.equal(row.querySelector('a[href="/config/trigger?index=0"]').textContent, "1");
  assert.ok(row.querySelector('a[href="/config/project?id=shop"]'));
  assert.ok(row.querySelector('a[href="/run?id=gh-new"]'));
  assert.match(row.textContent, /refused \(secret-unresolved\).*mini1/);
  assert.doesNotMatch(one, /mini&lt;hostile&gt;|mini<hostile>/, "invalid host names are not published as host identities");
  assert.ok(!one.includes("/opt/secret-resolvers") && !one.includes("/tmp/elsewhere"), "no resolver path, not even its real one");
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

test("the panel's RUN_DETAIL: the policy, the rule hosts wrapped and counted, the profile; a record without them renders as before", async () => {
  const run = { jobId: "gh-1", kind: "github", target: "acme/web#1", outcome: "completed", startedAt: "2026-10-21T10:00:00Z", endedAt: "2026-10-21T10:05:00Z", flow: "fix", backend: "openshell" };
  const open = async (extra, width = 80) => (await render({ ...BASE, triggers: { triggers: [] }, runs: [{ ...run, ...extra }] }, width, ["\r"])).map(stripAnsi);
  const hosts = Array.from({ length: 32 }, (_, i) => `host-${String(i).padStart(2, "0")}.example.com`);
  const got = (await open({ openshell: { mode: "copy", ruleHosts: hosts, ruleHostCount: 50, providers: 2, placeholders: 5 }, secretsProfile: "prod" })).join("\n");
  assert.match(got, /policy\s+copy mode, 2 credential providers, 5 placeholders/);
  assert.match(got, /rule hosts\s+50 rule hosts: host-00\.example\.com,\s+│\n.*│\s+host-01\.example\.com/, "wrapped under the label");
  assert.match(got, /more line\(s\) in the run record/, "a long list is counted, never cut silently");
  assert.match(got, /secrets via\s+prod/);
  const older = await open({});
  for (const hostile of [{ openshell: { mode: "copy\u001b[31m", ruleHosts: [], providers: 0, placeholders: 0 } }, { secretsProfile: "p\u001b[31m" }]) assert.deepEqual(await open(hostile), older, JSON.stringify(hostile));
  for (const width of [30, 40, 60, 80, 120]) {
    for (const l of await render({ ...BASE, triggers: { triggers: [] }, runs: [{ ...run, openshell: { mode: "copy", ruleHosts: hosts, providers: 32, placeholders: 1024 }, secretsProfile: "p".repeat(128) }] }, width, ["\r"])) assert.ok(visibleLen(l) <= width, `width ${width}: ${JSON.stringify(stripAnsi(l))}`);
  }
});

test("the panel's list: a secret profiles section under the triggers, every row in the frame; none without a profile", async () => {
  const profiles = secretProfilesView({ triggers: TRIGGERS, settings: { overlay: { secretProfiles: { prod: PATH } } }, env: {}, projects: PROJECTS, hosts: [{ name: "mini1", caps: ["s:prod"] }] });
  const lines = (await render({ ...BASE, triggers: TRIGGERS, secretProfiles: profiles }, 120)).map(stripAnsi);
  const all = lines.join("\n");
  // The facts wrap inside the frame: read them with the frame and the wrap taken out.
  const flat = lines.map((l) => l.replace(/^│\s?|\s*│$/g, "").trim()).join(" ");
  assert.match(all, /SECRET PROFILES .* 3 · names only · doctor --secrets resolves/);
  assert.match(all, /│ prod +│/);
  assert.match(flat, /declared in the settings overlay · PI_SECRET_RESOLVER_ROOTS is not visible here/);
  assert.match(flat, /served by: mini1/);
  assert.ok(!all.includes(PATH), "no resolver path");
  const before = (await render({ ...BASE, triggers: { triggers: [] } }, 120)).map(stripAnsi).join("\n");
  assert.ok(!before.includes("SECRET PROFILES"));
  for (const width of [40, 60, 80, 120]) for (const l of await render({ ...BASE, triggers: TRIGGERS, secretProfiles: profiles }, width)) assert.ok(visibleLen(l) <= width, `width ${width}: ${JSON.stringify(stripAnsi(l))}`);
});

test("round 1: hosts that publish no capability list are counted by capsSeen; a refusal on a bundled run is said as either read's", () => {
  const hosts = [{ name: "new", caps: ["s:prod"], capsSeen: true }, { name: "quiet", caps: [], capsSeen: true }, { name: "old", caps: [], capsSeen: false }];
  const view = secretProfilesView({ settings: { overlay: { secretProfiles: { prod: "/p" } } }, env: {}, hosts, fs: {} });
  assert.equal(view.profiles[0].hostsUnknown, 1, "only the row that publishes nothing");
  assert.match(profileHostsText(view.profiles[0], view), /^served by: new \(1 host\(s\) publish no capabilities\)$/);
  const at = { jobId: "j9", endedAt: "2026-10-21T10:00:01Z", outcome: "policy", exitCode: null, secretsProfile: "prod" };
  const last = (run, bundles = []) => secretProfilesView({ triggers: { triggers: [], secretBundles: bundles }, settings: { overlay: { secretProfiles: { prod: "/p" } } }, env: {}, runs: [run], fs: {} }).profiles[0].last;
  assert.equal(profileLastText(last({ ...at, reason: "secret-unresolved", project: "shop" }, [{ id: "shop", project: "shop" }])), "last resolve: refused (secret-unresolved: the profile's or the project bundle's read) at 2026-10-21T10:00:01.000Z");
  assert.match(profileLastText(last({ ...at, reason: "secret-resolver-unreachable", bundle: { id: "b", variables: [], shadowed: [] } })), /the profile's or the project bundle's read/, "a record carrying a bundle");
  assert.equal(profileLastText(last({ ...at, reason: "secret-unresolved", project: "web" }, [{ id: "shop", project: "shop" }])), "last resolve: refused (secret-unresolved) at 2026-10-21T10:00:01.000Z", "an unbundled project: the profile's");
  assert.equal(profileLastText(last({ ...at, reason: "secret-profile-unknown", project: "shop" }, [{ id: "shop", project: "shop" }])), "last resolve: refused (secret-profile-unknown) at 2026-10-21T10:00:01.000Z", "a reason only the profile's read gives");
});

test("round 1: dispatch_runs' list carries an openshell run's host count only; a run read by id carries the names", () => {
  const r = { jobId: "gh-1", backend: "openshell", openshell: OPENSHELL };
  assert.deepEqual(modelRunRecord(r, { list: true }).openshell, { mode: "copy", ruleHostCount: 2, providers: 1, placeholders: 3 });
  assert.deepEqual(modelRunRecord(r).openshell, OPENSHELL);
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /merged\.runs\.map\(\(r: any\) => modelRunRecord\(r, \{ list: true \}\)\)/);
});

test("final review: a registry read that failed says so, never 'no live host'; the snapshot passes no rows then", async () => {
  const { readFileSync } = await import("node:fs");
  const view = secretProfilesView({ settings: { overlay: { secretProfiles: { prod: "/p" } } }, env: {}, hosts: null, hostsUnreadable: true, fs: {} });
  assert.equal(profileHostsText(view.profiles[0], view), "served by: the host registry could not be read");
  const read = secretProfilesView({ settings: { overlay: { secretProfiles: { prod: "/p" } } }, env: {}, hosts: [], hostsUnreadable: true, fs: {} });
  assert.equal(profileHostsText(read.profiles[0], read), "served by: no live host in the registry", "rows in hand win over the flag");
  const src = readFileSync(new URL("../src/read-model.mjs", import.meta.url), "utf8");
  assert.match(src, /hosts: fleetDegraded \? null : lastHosts\.map\(hostRowOf\), hostsUnreadable: Boolean\(fleetDegraded\)/);
});
