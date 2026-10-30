import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPageData, PAGES, pageQueryString, parsePageQuery, renderPage, returnPathOf } from "../src/console/pages.mjs";
import { stateOf } from "../src/console/live.mjs";
import { secretsView } from "../src/secrets-view.mjs";
import { readConnections } from "../src/connections-view.mjs";
import { consoleProjectFixture } from "./helpers/console-project-fixture.mjs";

const AT = Date.UTC(2026, 9, 30, 12);
const snap = () => ({ queue: { counts: {} }, budget: {}, parked: [], runs: [], triggers: { triggers: [] }, settings: { overlay: {} }, projects: { projects: [{ id: "billing", name: "billing", members: ["github:acme/billing"] }] }, hostBudgets: [], doctor: { hosts: [] }, overlayMcp: { servers: [], refused: [] }, stagedPackages: { packages: [] } });
const render = (name, data, { role = "operator", readOnly = false, query = {} } = {}) => renderPage(name, { query, data: { now: AT, ...data }, session: { name: "test", role }, readOnly });

test("new configuration pages are static viewer reads with strict project identity and safe return paths", () => {
  for (const name of ["secrets", "connections", "project"]) {
    assert.equal(PAGES[name].auth, "viewer"); assert.equal(PAGES[name].live, false);
  }
  for (const id of ["billing", "a", "a".repeat(32)]) {
    const query = parsePageQuery("project", `id=${id}`).query;
    assert.deepEqual(query, { id });
    assert.equal(pageQueryString("project", query), `id=${id}`);
    assert.equal(returnPathOf(`/config/project?id=${id}`), `/config/project?id=${id}`);
  }
  for (const qs of ["", "id=", "id=Billing", "id=../secret", `id=${"a".repeat(33)}`, "id=billing&id=web", "id=billing&extra=secret"]) {
    const result = parsePageQuery("project", qs);
    assert.ok(result.refusal, qs); assert.doesNotMatch(result.refusal, /\.\.\/secret|Billing|extra=secret/);
  }
});

test("page-only readers cost Overview, ordinary pages and state projection nothing", async () => {
  const calls = [];
  const deps = {
    now: () => AT, env: {}, fleet: { snapshot: async (opts) => { calls.push(["snapshot", opts]); return snap(); } },
    secretsView: async () => { calls.push(["secrets"]); return { problems: [] }; },
    connections: async () => { calls.push(["connections"]); return {}; },
    projectView: async (id) => { calls.push(["project", id]); return consoleProjectFixture(AT); },
  };
  await loadPageData("overview", {}, deps);
  stateOf(snap(), "viewer");
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "snapshot");
  for (const name of ["secrets", "connections", "project"]) {
    calls.length = 0;
    await loadPageData(name, name === "project" ? { id: "billing" } : {}, deps);
    assert.deepEqual(calls.map((c) => c[0]), ["snapshot", name]);
  }
});

test("a valid absent project is 404; unreadable projects are unavailable and keep Configuration navigation", async () => {
  const absent = await render("project", { projectView: { id: "billing", state: "missing" } }, { query: { id: "billing" } });
  assert.equal(absent.status, 404); assert.match(String(absent.html), /Project not found/);
  assert.match(String(absent.html), /href="\/config" aria-current="page"/);
  assert.doesNotMatch(String(absent.html), /data-action=/);
  const unread = await render("project", { projectView: { id: "billing", state: "unreadable" } }, { query: { id: "billing" } });
  assert.equal(unread.status, 503); assert.doesNotMatch(String(unread.html), /Project not found/);
});

test("project facts and command guidance distinguish viewer, operator and read-only operator", async () => {
  const p = consoleProjectFixture(AT);
  const operator = String((await render("project", { projectView: p }, { query: { id: "billing" } })).html);
  const viewer = String((await render("project", { projectView: p }, { role: "viewer", query: { id: "billing" } })).html);
  const readonly = String((await render("project", { projectView: p }, { readOnly: true, query: { id: "billing" } })).html);
  for (const page of [operator, viewer, readonly]) {
    assert.match(page, /href="\/config" aria-current="page"/);
    assert.match(page, /href="\/config"[^>]*>.*?Configuration/s);
    assert.match(page, /Job size/); assert.match(page, /8 GiB|8g|8gib/i);
    assert.match(page, /No.*|Recent runs/);
  }
  assert.match(operator, /data-action="limit-edit"/);
  assert.match(operator, /data-copy/);
  assert.match(operator, /dispatch_limit_edit \{&quot;index&quot;:2,&quot;memory&quot;:&quot;4g&quot;,&quot;cpus&quot;:2\}/);
  assert.doesNotMatch(viewer, /data-action=|data-copy|dispatch_limit_edit/);
  assert.doesNotMatch(readonly, /data-action=|data-copy|dispatch_limit_edit/);
});

test("Configuration links replace detail forms and all destination fragments exist", async () => {
  const snapshot = snap();
  const config = String((await render("config", { snapshot })).html);
  for (const action of ["secret-profile-add", "secret-profile-remove", "secret-bundle-add", "secret-bundle-remove"]) assert.ok(!config.includes(`data-action="${action}"`));
  assert.match(config, /href="\/config\/project\?id=billing"/);
  const secrets = String((await render("secrets", { snapshot, secrets: secretsView({ snapshot }) })).html);
  const connections = String((await render("connections", { snapshot, connections: await readConnections({ now: AT, snapshot, reads: { environment: () => ({ env: {} }), allowlist: () => [], endpoints: () => [] } }) })).html);
  for (const [href, page] of [["/config/secrets#p-secret-profiles", secrets], ["/config/secrets#p-secret-bundles", secrets], ["/config/connections#p-mcp", connections], ["/config/connections#p-packages", connections]]) {
    assert.ok(config.includes(`href="${href}"`), href);
    assert.ok(page.includes(`id="${href.split("#")[1]}"`), href);
  }
});
