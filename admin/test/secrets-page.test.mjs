import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, delimiter } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { secretsView, modelSecrets } from "../src/secrets-view.mjs";
import { planSecretProfileRemove } from "../src/write-plans.mjs";
import { secretProfilesView, secretBundlesView } from "../src/read-model.mjs";
import * as RM from "../src/read-model.mjs";
import * as WP from "../src/write-plans.mjs";
import { secretsProfiles, secretsBundles, secretsProblems, secretsAdd, secretsHelp } from "../src/console/panels/secrets.mjs";
import { ACTIONS, previewAction, confirmAction, diffHtmlOf } from "../src/console/actions.mjs";
import { makeConfirmTickets } from "../src/console/confirm.mjs";
import { confirmSlotHtml, previewBarHtml, refusalHtml } from "../src/console/confirm-view.mjs";
import { html, page } from "../src/console/html.mjs";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { Event, parseDocument, runConsoleScript } from "./helpers/script-dom.mjs";
import { resolverPathShown, resolverTextShown } from "../src/console/secrets-privacy.mjs";

const NOW = Date.UTC(2026, 9, 30, 12);
const PRIVATE = "/Users/secret-person/private roots";
const REF = "ref-private-canary";
const VALUE = "value-private-canary";
const VARIABLE = "MANAGER_VARIABLE_CANARY";
const localFs = { realpathSync: (p) => p };
function fixture(env = {}) {
  const settings = { overlay: { secretProfiles: { prod: `${PRIVATE}/read-prod` }, secretBundles: { shop: { path: `${PRIVATE}/read-shop`, format: "json" } } } };
  const triggers = { triggers: [{ index: 0, id: "nightly", type: "cron", pattern: "0 3 * * *", folder: "/srv/shop", secrets: 1, secretsProfile: "prod" }, { index: 1, type: "comment", secrets: 1, secretsProfile: "default", secretBundle: false }], secretBundles: [{ id: "shop", profile: "shop", project: "shop", forkReviews: false, endpoints: [{ name: VARIABLE, host: "api.example.com" }] }] };
  const projects = { projects: [{ id: "shop", members: ["/srv/shop"] }] };
  const runs = [{ jobId: "gh-old", endedAt: new Date(NOW - 10000).toISOString(), secretsProfile: "prod", outcome: "completed", bundle: { id: "shop", variables: ["OLD"], shadowed: [] } }, { jobId: "gh-new", endedAt: new Date(NOW - 1000).toISOString(), secretsProfile: "prod", outcome: "completed", bundle: { id: "shop", variables: [VARIABLE], shadowed: [] }, secretValues: VALUE, ref: REF }];
  const hosts = [{ name: "mini1", caps: ["s:prod", "s:default"], capsSeen: true }];
  const snapshot = { settings, triggers, projects, runs, hosts, schedulers: [{ key: "nightly", pattern: "0 3 * * *", next: NOW + 10000 }] };
  const allEnv = { PI_SECRET_PROFILES: "default:/opt/default", PI_SECRET_BUNDLES: "env-unbound:/opt/env-bundle:dotenv", PI_SECRET_RESOLVER_ROOTS: PRIVATE, ...env };
  snapshot.secretProfiles = secretProfilesView({ settings, triggers, projects, runs, hosts, env: allEnv, fs: localFs });
  snapshot.secretBundles = secretBundlesView({ settings, triggers, projects, runs, env: allEnv });
  return { snapshot, env: allEnv, fs: localFs };
}
const ctxOf = (v, role = "operator", readOnly = false) => ({ data: { secrets: v }, role, readOnly, now: NOW });

test("Secrets reads names and current states, newest received names/time, observed next fire and unbound env resolvers", () => {
  const v = secretsView(fixture());
  assert.equal(v.profiles.find((p) => p.name === "prod").last.jobId, "gh-new");
  assert.equal(v.profiles.find((p) => p.name === "prod").cron[0].at, NOW + 10000);
  assert.equal(v.bundleResolvers.find((r) => r.name === "env-unbound").source, "env");
  assert.deepEqual(v.bundles[0].last, { jobId: "gh-new", at: new Date(NOW - 1000).toISOString(), variables: [VARIABLE] });
  assert.deepEqual(v.bundles[0].optedOut, [1]);
  const all = JSON.stringify(v);
  for (const secret of [PRIVATE, REF, VALUE]) assert.ok(!all.includes(secret), secret);
  const model = JSON.stringify(modelSecrets(v));
  for (const secret of [PRIVATE, REF, VALUE, VARIABLE]) assert.ok(!model.includes(secret), secret);
  assert.equal(modelSecrets(v).projects[0].variables, 1);
  assert.equal(modelSecrets(v).projects[0].bundle, "shop");
  assert.deepEqual(modelSecrets(v).projects[0].profiles, [{ profile: "default", trigger: 1, variables: 1, anyRepo: true }, { profile: "prod", trigger: 0, variables: 1, anyRepo: false }]);
  const unbundled = fixture();
  unbundled.snapshot.projects.projects.push({ id: "other", members: ["github:acme/other"] });
  const other = modelSecrets(secretsView(unbundled)).projects.find((p) => p.project === "other");
  assert.equal(other.bundle, null);
  assert.deepEqual(other.profiles, [{ profile: "default", trigger: 1, variables: 1, anyRepo: true }], "a webhook may run in any project; a cron profile is tied to its folder's project");
});

test("Problems have deterministic precedence, including malformed declarations without a row and global ambiguity", () => {
  const malformed = secretsView({ snapshot: { settings: { overlay: {} }, triggers: { triggers: [] }, hosts: [] }, env: { PI_SECRET_PROFILES: "bad", PI_SECRET_BUNDLES: "bad" }, fs: localFs });
  assert.equal(malformed.profiles.length, 0);
  assert.equal(malformed.bundles.length, 0);
  assert.equal(malformed.problems.length, 2);
  assert.ok(malformed.problems.every((p) => p.rank === 0));
  assert.match(String(secretsProblems(ctxOf(malformed))), /does not parse/);
  const v = secretsView(fixture({ PI_SECRET_PROFILES: `prod:/opt/env-prod,default:/opt/default`, PI_SECRET_RESOLVER_ROOTS: "" }));
  assert.equal(v.problems[0].rank, 1);
  assert.ok(v.profiles.every((p) => p.refused), "a collision refuses all profiles, including an env-only one");
  assert.ok(v.problems.find((p) => p.key === "empty-roots"));
  const out = String(secretsProfiles(ctxOf(v)));
  assert.match(out, /class="row--failed"/);
  assert.match(out, /next .*its run will be refused/);
});

test("Bundle bindings and resolver inventory use the worker's same realpath rule in both symlink directions", () => {
  const view = (path, real) => {
    const f = fixture({ PI_SECRET_RESOLVER_ROOTS: "/allowed" });
    f.snapshot.settings.overlay.secretBundles.shop.path = path;
    const seam = { realpathSync(p) { if (p === path && real === null) throw Object.assign(Error("missing"), { code: "ENOENT" }); return p === path ? real : p; } };
    const shared = secretBundlesView({ triggers: f.snapshot.triggers, settings: f.snapshot.settings, env: f.env, projects: f.snapshot.projects, runs: f.snapshot.runs, fs: seam });
    f.snapshot.secretBundles = shared;
    return { shared: shared.bundles[0], page: secretsView({ ...f, fs: seam }) };
  };
  const inward = view("/outside/link", "/allowed/real-resolver");
  assert.equal(inward.shared.declared, "overlay");
  assert.equal(inward.shared.roots, "inside");
  assert.equal(inward.page.bundles[0].declared, "overlay");
  assert.equal(inward.page.bundleResolvers.find((r) => r.name === "shop").roots, "inside");
  const outward = view("/allowed/link", "/outside/real-resolver");
  assert.equal(outward.shared.declared, "overlay-outside-roots");
  assert.equal(outward.page.bundles[0].refused, true);
  const missing = view("/outside/not-on-this-host", null);
  assert.equal(missing.shared.declared, "overlay");
  assert.equal(missing.shared.roots, "unresolved");
  assert.equal(missing.page.bundles[0].refused, false);
  const rendered = String(secretsBundles(ctxOf(missing.page)));
  assert.match(rendered, /cannot be resolved on this host/);
  assert.doesNotMatch(rendered, /inside PI_SECRET_RESOLVER_ROOTS/);
});

test("Unseen env, unread registry and old capability rows remain unknown; conflicting scheduler reports give no next fire", () => {
  const f = fixture();
  delete f.env.PI_SECRET_PROFILES;
  f.snapshot.secretProfiles = secretProfilesView({ triggers: f.snapshot.triggers, settings: f.snapshot.settings, env: f.env, hosts: null, hostsUnreadable: true, fs: localFs });
  f.snapshot.schedulers.push({ key: "nightly", pattern: "0 3 * * *", next: NOW + 20000 });
  const v = secretsView(f);
  assert.ok(!v.profiles.find((p) => p.name === "default").refused);
  assert.ok(!v.problems.some((p) => p.key.startsWith("unserved-")));
  assert.equal(v.profiles.find((p) => p.name === "prod").cron[0].at, null);
  assert.match(String(secretsProfiles(ctxOf(v))), /host registry could not be read/);
  const g = fixture();
  g.snapshot.secretProfiles = secretProfilesView({ triggers: g.snapshot.triggers, settings: g.snapshot.settings, env: g.env, hosts: [{ name: "old", capsSeen: false }], fs: localFs });
  assert.ok(!secretsView(g).problems.some((p) => p.key.startsWith("unserved-")));
  const actualShape = fixture();
  delete actualShape.snapshot.secretProfiles;
  actualShape.snapshot.hostBudgets = actualShape.snapshot.hosts;
  delete actualShape.snapshot.hosts;
  assert.deepEqual(secretsView(actualShape).profiles.find((p) => p.name === "prod").hosts, ["mini1"], "the production snapshot publishes hostBudgets, not hosts");
  actualShape.snapshot.queue = { fleetDegraded: "registry unreadable" };
  const outage = secretsView(actualShape);
  assert.equal(outage.profileState.hostsUnreadable, true);
  assert.deepEqual(outage.profiles.find((p) => p.name === "prod").hosts, [], "last-known host budgets cannot prove a host still serves a profile");
  assert.ok(!outage.problems.some((p) => p.key.startsWith("unserved-")), "an unread registry cannot prove no host serves it either");
});

test("Role separation, trigger/project/run links and bundle facts are server-side and truthful", () => {
  const v = secretsView(fixture());
  const op = parseDocument(String(page({ title: "Secrets", name: "secrets", body: html`${secretsProfiles(ctxOf(v))}${secretsBundles(ctxOf(v))}${secretsAdd(ctxOf(v))}` })));
  assert.equal(op.querySelector('a[href="/config/trigger?index=0"]').textContent, "1");
  assert.ok(op.querySelector('a[href="/config/project?id=shop"]'));
  assert.ok(op.querySelector('a[href="/run?id=gh-new"]'));
  assert.match(op.textContent, /MANAGER_VARIABLE_CANARY/);
  assert.ok(op.querySelector('form[data-action="secret-profile-remove"]'));
  assert.ok(op.querySelector('form[data-action="secret-profile-remove"] button').classList.contains("btn--danger"));
  for (const [role, readOnly] of [["viewer", false], ["operator", true]]) {
    const rendered = String(html`${secretsProfiles(ctxOf(v, role, readOnly))}${secretsBundles(ctxOf(v, role, readOnly))}${secretsAdd(ctxOf(v, role, readOnly))}${secretsHelp()}`);
    assert.equal(parseDocument(String(page({ title: "Secrets", name: "secrets", body: html`${secretsProfiles(ctxOf(v, role, readOnly))}${secretsBundles(ctxOf(v, role, readOnly))}${secretsAdd(ctxOf(v, role, readOnly))}${secretsHelp()}` }))).querySelectorAll("form").length, 0);
    assert.match(rendered, /MANAGER_VARIABLE_CANARY/);
    assert.match(rendered, /What a run gets/);
  }
});

test("An undeclared profile never claims its resolver is declared in the .env", () => {
  const row = (v) => parseDocument(String(page({ title: "Secrets", name: "secrets", body: secretsProfiles(ctxOf(v)) }))).querySelectorAll("tr").find((r) => r.querySelector(".code")?.textContent === "default");
  assert.match(row(secretsView(fixture())).textContent, /in the \.env/);
  const missing = secretsView(fixture({ PI_SECRET_PROFILES: "" }));
  assert.equal(missing.profiles.find((p) => p.name === "default").source, "undeclared");
  assert.match(row(missing).textContent, /no declaration in view/);
  assert.doesNotMatch(row(missing).textContent, /in the \.env/);
});

test("Verified roots, resolved runs and valid bundle declarations use the card's positive state; unresolved roots stay neutral", () => {
  const v = secretsView(fixture());
  const rendered = parseDocument(String(page({ title: "Secrets", name: "secrets", body: html`${secretsProfiles(ctxOf(v))}${secretsBundles(ctxOf(v))}` })));
  const positive = rendered.querySelectorAll(".secret-state.tone-ok");
  assert.ok(positive.some((p) => p.textContent.includes("inside PI_SECRET_RESOLVER_ROOTS")));
  assert.ok(positive.some((p) => p.textContent === "resolved"));
  assert.ok(positive.some((p) => p.textContent.startsWith("declared in the settings overlay")));
  assert.ok(positive.every((p) => p.querySelector('use[href="#i-done"]')), "a positive word is paired with the done icon, not color alone");
  const f = fixture(); delete f.snapshot.secretProfiles;
  f.fs = { realpathSync() { throw Object.assign(Error("remote host"), { code: "ENOENT" }); } };
  const unresolved = parseDocument(String(page({ title: "Secrets", name: "secrets", body: secretsBundles(ctxOf(secretsView(f))) })));
  assert.equal(unresolved.querySelectorAll(".secret-state.tone-ok").length, 0);
  assert.match(unresolved.textContent, /cannot be resolved on this host/);
});

test("Profile removal distinguishes the repaired collision, remaining collisions and actual named users", () => {
  const args = { name: "prod", profiles: { prod: "/opt/prod" }, settingsFile: "/opt/settings.json", triggers: { triggers: [{ index: 5, id: "pm-weekly", secrets: 1, secretsProfile: "prod" }, { index: 6, secrets: 0, secretsProfile: "prod" }] } };
  const gone = planSecretProfileRemove(args).plan.message;
  assert.match(gone, /trigger 6 \(pm-weekly\)/);
  assert.doesNotMatch(gone, /trigger 7/);
  assert.match(gone, /resolver script stays on disk/);
  const repaired = planSecretProfileRemove({ ...args, envProfiles: { prod: "/env/prod" } }).plan.message;
  assert.match(repaired, /resolves the ambiguity/);
  assert.doesNotMatch(repaired, /Every trigger naming it is refused/);
  const remaining = planSecretProfileRemove({ ...args, profiles: { ...args.profiles, other: "/opt/other" }, envProfiles: { prod: "/env/prod", other: "/env/other" } }).plan.message;
  assert.match(remaining, /Still ambiguous after this: other/);
  assert.doesNotMatch(remaining, /resolves the ambiguity/);
  const empty = planSecretProfileRemove({ ...args, triggers: { triggers: [] } }).plan.message;
  assert.match(empty, /No trigger in the triggers file names this profile/);
});

function actionFixture(env = {}, fsOverrides = {}) {
  const dir = tempDir("pi-751-secrets-");
  const paths = { settingsFile: join(dir, "settings.json"), triggersPath: join(dir, "triggers.json"), logsDir: dir };
  fs.writeFileSync(paths.settingsFile, JSON.stringify({ secretProfiles: { prod: `${PRIVATE}/read-prod` }, secretBundles: { bundle: { path: `${PRIVATE}/read-bundle`, format: "json" } } }));
  fs.writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [{ on: { type: "cron", id: "weekly", cron: "0 3 * * *" }, run: { kind: "local", folder: "/srv/shop", flow: "tidy", task: "tidy", secretsProfile: "prod", secrets: { KEY: REF } } }] }));
  const audits = [];
  const deps = { fs: { ...fs, ...fsOverrides }, now: () => NOW, config: { dir }, tickets: makeConfirmTickets({ now: () => NOW }), actionDeps: { rm: RM, plans: WP, paths, env }, audit: { append(row) { audits.push(row); return { seq: audits.length }; } }, sessions: { setFlash() {} }, log() {} };
  const call = async (name, body, confirm = false, who = "s1") => {
    let answer;
    const ctx = { deps, body, session: { id: who, name: "operator", role: "operator" }, route: { path: `/api/act/${name}/${confirm ? "confirm" : "preview"}` }, actor: () => ({ name: "operator", role: "operator" }), record() {}, json(status, data) { answer = { status, data }; } };
    await (confirm ? confirmAction : previewAction)(ctx, ACTIONS.find((a) => a.name === name));
    return answer;
  };
  return { paths, deps, audits, call };
}

test("Resolver preview JSON/HTML/diff/Undo keep basenames, but confirm writes exact raw paths and audits only after approval", async () => {
  const f = actionFixture();
  const raw = `${PRIVATE}/new resolver`;
  const preview = await f.call("secret-profile-add", { name: "prod", path: raw });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.equal(f.audits.length, 0);
  const response = JSON.stringify(preview.data);
  for (const path of [PRIVATE, f.paths.settingsFile, raw]) assert.ok(!response.includes(path), path);
  assert.match(preview.data.html, /…\/read-prod/);
  assert.match(preview.data.html, /…\/new resolver/);
  assert.equal(preview.data.undo, "Declare prod again with the previous resolver; the console keeps no full path to replay it.");
  assert.equal(JSON.parse(fs.readFileSync(f.paths.settingsFile)).secretProfiles.prod, `${PRIVATE}/read-prod`);
  const written = await f.call("secret-profile-add", { ticket: preview.data.ticket }, true);
  assert.equal(written.status, 200, JSON.stringify(written));
  assert.equal(JSON.parse(fs.readFileSync(f.paths.settingsFile)).secretProfiles.prod, raw);
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].kind, "secret-profile-add");
  assert.ok(!JSON.stringify(written.data).includes(PRIVATE));
  assert.equal((await f.call("secret-profile-add", { ticket: preview.data.ticket }, true)).status, 409);
});

test("Resolver refusals, changed-file conflicts and adjacent settings diff context never reveal roots or paths", async () => {
  const outside = `${PRIVATE}/outside/read`;
  const root = `${PRIVATE}/allowed`;
  const f = actionFixture({ PI_SECRET_RESOLVER_ROOTS: root }, { realpathSync: (p) => p });
  const refused = await f.call("secret-bundle-add", { name: "new", path: outside, format: "json" });
  assert.equal(refused.status, 400);
  for (const path of [PRIVATE, root, outside]) assert.ok(!JSON.stringify(refused.data).includes(path), path);
  assert.match(refused.data.error, /…\/read.*outside.*…\/allowed/);
  for (const path of ["r", "a", "relative/resolver"]) {
    const relative = await f.call("secret-profile-add", { name: "new", path });
    assert.equal(relative.status, 400);
    assert.equal(relative.data.error, "the resolver needs an absolute path: a service manager's working directory is not your shell's", "short relative input must not rewrite fixed refusal words");
  }
  const g = actionFixture();
  const p = await g.call("secret-profile-remove", { name: "prod" });
  fs.writeFileSync(g.paths.settingsFile, JSON.stringify({ maxTurns: 12 }));
  const conflict = await g.call("secret-profile-remove", { ticket: p.data.ticket }, true);
  assert.equal(conflict.status, 409);
  assert.ok(!JSON.stringify(conflict.data).includes(g.paths.settingsFile));
  assert.deepEqual(JSON.parse(fs.readFileSync(g.paths.settingsFile)), { maxTurns: 12 });
  const before = JSON.stringify({ secretProfiles: { prod: `${PRIVATE}/read-prod` }, maxTurns: 3, secretBundles: { bundle: { path: `${PRIVATE}/read-bundle`, format: "json" } } });
  const after = before.replace('"maxTurns":3', '"maxTurns":4');
  const diff = String(diffHtmlOf(before, after));
  assert.ok(!diff.includes(PRIVATE), "redaction also covers context in an unrelated settings preview");
  assert.match(diff, /…\/read-prod/);
  const bundleDiff = String(diffHtmlOf(null, JSON.stringify({ secretBundles: [{ profile: "p", ref: REF }] })));
  assert.ok(!bundleDiff.includes(REF));
});

test("Exact path projection handles spaces, quotes and Windows separators, including JSON spelling", () => {
  for (const path of [`${PRIVATE}/quoted \"resolver\"`, "C:\\private user\\vault\\resolver.cmd", "\\\\server\\private\\resolver.cmd"]) {
    const text = `${path}\n${JSON.stringify(path)}`;
    const shown = resolverTextShown(text, [path]);
    assert.ok(!shown.includes(path));
    assert.ok(!shown.includes(JSON.stringify(path).slice(1, -1)));
    assert.ok(shown.includes(resolverPathShown(path)));
  }
});

test("Project action preview and confirm never echo malformed trigger bundle declarations or their references", async () => {
  const f = actionFixture();
  f.paths.projectsFile = join(f.paths.logsDir, "projects.json");
  f.paths.scopedLimitsPath = join(f.paths.logsDir, "scoped-limits.json");
  fs.writeFileSync(f.paths.projectsFile, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/shop"] }] }));
  fs.writeFileSync(f.paths.scopedLimitsPath, JSON.stringify({ version: 1, limits: [] }));
  const bad = JSON.stringify({ triggers: [], secretBundles: [{ id: "bad", ref: REF, value: VALUE, path: PRIVATE }] });
  fs.writeFileSync(f.paths.triggersPath, bad);
  for (const [action, body] of [["project-edit", { id: "shop", members: ["github:acme/shop", "github:acme/new"] }], ["project-delete", { id: "shop" }]]) {
    const refused = await f.call(action, body);
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /triggers file does not load.*doctor/);
    for (const secret of [REF, VALUE, PRIVATE]) assert.ok(!JSON.stringify(refused.data).includes(secret), secret);
  }
  fs.writeFileSync(f.paths.triggersPath, JSON.stringify({ triggers: [] }));
  const preview = await f.call("project-edit", { id: "shop", members: ["github:acme/shop", "github:acme/new"] });
  assert.equal(preview.status, 200);
  fs.writeFileSync(f.paths.triggersPath, bad);
  const conflict = await f.call("project-edit", { ticket: preview.data.ticket }, true);
  assert.equal(conflict.status, 409);
  for (const secret of [REF, VALUE, PRIVATE]) assert.ok(!JSON.stringify(conflict.data).includes(secret), secret);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.projectsFile)).projects[0].members, ["github:acme/shop"]);
});

test("The unified form changes existing action/body semantics, preserves refusal input, and associates the path error", async () => {
  const v = secretsView(fixture());
  const body = html`<section id="p-secret-add" data-panel>${secretsAdd(ctxOf(v))}</section>${confirmSlotHtml()}`;
  const markup = String(page({ title: "Secrets", name: "secrets", body }));
  assert.ok(parseDocument(markup).querySelector("fieldset[disabled]"), "without JavaScript the form cannot pretend to write");
  const w = runConsoleScript(CONSOLE_SCRIPT, markup, { url: "/config/secrets" });
  const form = w.document.querySelector('form[data-structured="resolver"]');
  const path = form.querySelector('[name="path"]');
  const kind = form.querySelector('[name="kind"]');
  form.querySelector('[name="name"]').value = "new";
  path.value = "relative/resolver";
  w.submit(form);
  const error = "the resolver needs an absolute path: a service manager's working directory is not your shell's";
  await w.fetch.open("/api/act/secret-profile-add/preview").answer(400, { error, html: String(refusalHtml({ where: "preview", status: 400, sentence: error })) });
  assert.equal(path.value, "relative/resolver");
  assert.equal(path.getAttribute("aria-invalid"), "true");
  assert.match(w.document.getElementById(path.getAttribute("aria-describedby")).textContent, /absolute path/);
  for (const option of kind.querySelectorAll("option")) option.liveSelected = option.value === "bundle";
  kind.dispatchEvent(new Event("change", { bubbles: true }));
  assert.equal(form.getAttribute("data-action"), "secret-bundle-add");
  assert.equal(form.querySelector('[name="format"]').disabled, false);
  path.value = "/opt/resolver";
  w.submit(form);
  const call = w.fetch.open("/api/act/secret-bundle-add/preview");
  assert.deepEqual(call.body, { name: "new", path: "/opt/resolver", format: "dotenv" });
});

test("Changing resolver kind or fields invalidates an open preview and ignores a pending response for the old declaration", async () => {
  const v = secretsView(fixture());
  const markup = String(page({ title: "Secrets", name: "secrets", body: html`<section id="p-secret-add" data-panel>${secretsAdd(ctxOf(v))}</section>${confirmSlotHtml()}` }));
  const w = runConsoleScript(CONSOLE_SCRIPT, markup, { url: "/config/secrets" });
  const form = w.document.querySelector('form[data-structured="resolver"]');
  form.querySelector('[name="name"]').value = "new";
  const path = form.querySelector('[name="path"]'); path.value = "/opt/first";
  w.submit(form);
  const old = w.fetch.open("/api/act/secret-profile-add/preview");
  const kind = form.querySelector('[name="kind"]');
  for (const option of kind.querySelectorAll("option")) option.liveSelected = option.value === "bundle";
  kind.dispatchEvent(new Event("change", { bubbles: true }));
  const slot = w.document.getElementById("confirm-slot");
  assert.equal(slot.hidden, true);
  w.submit(form);
  await old.answer(200, { ticket: "old-profile", html: String(previewBarHtml({ title: "OLD_PROFILE_RESPONSE", lines: ["Old"], expiresAt: NOW + 300000, now: NOW })) });
  assert.ok(!slot.textContent.includes("OLD_PROFILE_RESPONSE"));
  const fresh = w.fetch.open("/api/act/secret-bundle-add/preview");
  assert.deepEqual(fresh.body, { name: "new", path: "/opt/first", format: "dotenv" });
  await fresh.answer(200, { ticket: "fresh-bundle", html: String(previewBarHtml({ title: "Fresh bundle", lines: ["New"], expiresAt: NOW + 300000, now: NOW })) });
  assert.equal(slot.hidden, false);
  assert.ok(slot.textContent.includes("Fresh bundle"));
  path.value = "/opt/changed";
  path.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(slot.hidden, true);
  assert.ok(!slot.textContent.includes("Fresh bundle"));
  assert.equal(w.fetch.calls.filter((call) => call.url.endsWith("/confirm")).length, 0);
});
