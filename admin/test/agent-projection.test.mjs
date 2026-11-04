import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadPageData, pagePanels, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { fileTrouble } from "../src/console/panels/config.mjs";
import { readProjects, readTriggers, readTriggersWithStalls } from "../src/read-model.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeLiveHub, stateOf } from "../src/console/live.mjs";
import { agentReadProjection, agentReasonToken } from "../src/agent-read.mjs";
const NOW = Date.UTC(2026, 9, 31);
const PRIVATE_NAME = "privatepersona";
function snapshot() {
  return { projects: { projects: [{ id: "web", name: PRIVATE_NAME, members: ["github:acme/web"] }] }, failed: { rows: [{ jobId: "j1", queue: "pi-jobs", reason: "private_decision" }], more: 0 }, queue: {}, hostBudgets: [{ name: "worker1" }], secretBundles: [{ id: "billing" }] };
}
test("project display labels and unrecognized reason tokens never become structural agent identities", () => {
  const out = agentReadProjection({ project: { id: "web", name: PRIVATE_NAME }, projects: [{ id: "web", name: PRIVATE_NAME }], host: { name: "worker1" }, bundle: { name: "billing" }, reason: "private_decision" });
  assert.deepEqual(out, { project: { id: "web" }, projects: [{ id: "web" }], host: { name: "worker1" }, bundle: { name: "billing" }, reason: null });
  assert.equal(agentReasonToken("scope-repo"), "scope-repo");
  assert.equal(agentReasonToken("private_decision"), null);
  assert.equal(stateOf(snapshot(), "agent", { now: NOW }).failed.rows[0].reason, null, "stateOf cannot reintroduce raw reasons after projection");
});
test("actual page data drops one-token project labels while retaining project and member IDs", async () => {
  const deps = { fleet: { snapshot: async () => snapshot() }, now: () => NOW };
  const agent = await loadPageData("config", {}, deps, { role: "agent" });
  assert.ok(!JSON.stringify(agent).includes(PRIVATE_NAME));
  assert.equal(agent.snapshot.projects.projects[0].id, "web");
  assert.deepEqual(agent.snapshot.projects.projects[0].members, ["github:acme/web"]);
  const viewer = await loadPageData("config", {}, deps, { role: "viewer" });
  assert.ok(JSON.stringify(viewer).includes(PRIVATE_NAME), "projection does not mutate the shared source");
});
test("actual live hub keeps viewer cache and rendered SSE separate from the private-free agent view", async () => {
  const output = new Map();
  const res = (id) => ({ writableLength: 0, write: (text) => { output.set(id, (output.get(id) ?? "") + text); return true; }, end() {}, destroy() {} });
  const sessions = { a: { id: "a", name: "automation", role: "agent" }, v: { id: "v", name: "viewer", role: "viewer" } };
  const loaded = [];
  const hub = makeLiveHub({ loadPageData: (name, query, who) => { loaded.push(who.role); return loadPageData(name, query, { fleet: { snapshot: async () => snapshot() }, now: () => NOW }, who); }, pagePanels,
    peekSession: (id) => sessions[id], readTokens: () => ({ file: { version: 1, generation: 0, tokens: [] } }), now: () => NOW,
    timers: { setInterval: () => ({}), clearInterval() {} }, pageMinMs: {},
  });
  try {
    hub.subscribe({ res: res("viewer"), sessionId: "v", session: sessions.v, page: "config" });
    await hub.tick();
    hub.subscribe({ res: res("agent"), sessionId: "a", session: sessions.a, page: "config" });
    await hub.tick();
    assert.ok(loaded.includes("agent"));
    assert.ok(output.get("agent").includes("event: panel"), "actual panel frames were rendered");
    assert.ok(!output.get("agent").includes(PRIVATE_NAME));
    assert.ok(!output.get("agent").includes("private_decision"));
  } finally { hub.close(); }
});

/** A real failed read: a directory where the file should be, which refuses any uid, where a file at mode 000 would not refuse root. */
function unreadableFiles() {
  const dir = tempDir("agent-unreadable-");
  const paths = { triggersPath: join(dir, "triggers.json"), projectsPath: join(dir, "projects.json") };
  for (const path of Object.values(paths)) mkdirSync(path);
  return paths;
}

test("a failed read reaches an agent as a yes or no, with no code, and what a tool answers holds no more than that", async () => {
  const { triggersPath, projectsPath } = unreadableFiles();
  const triggers = readTriggers({ triggersPath });
  assert.deepEqual(triggers, { unreadable: "EISDIR" }, "the premise: what the real reader answers");
  assert.deepEqual(agentReadProjection(triggers), { unreadable: true });
  assert.deepEqual(agentReadProjection(readProjects({ projectsPath })), { unreadable: true });
  // What `dispatch_triggers` answers on that read: it read `{}` while the projection dropped the string.
  assert.deepEqual(agentReadProjection(await readTriggersWithStalls({ triggersPath, url: "redis://unused" })), { unreadable: true });
  // It stands beside its neighbours, and the word it holds elsewhere does not move: a yes, a no and nothing stay what they are.
  assert.deepEqual(agentReadProjection({ invalid: "the reason", unreachable: "the reason", unreadable: "the reason" }), { invalid: true, unreachable: true, unreadable: true });
  assert.deepEqual(agentReadProjection({ unreadable: false, mcp: { unreadable: null } }), { unreadable: false, mcp: { unreadable: null } });
});

test("fileTrouble says the code where its reader may see one, and only then", () => {
  assert.equal(fileTrouble({ unreadable: "EACCES" }, "triggers file"), "The triggers file cannot be read (EACCES).");
  assert.equal(fileTrouble({ unreadable: true }, "triggers file"), "The triggers file cannot be read.");
});

test("an agent's and a viewer's pages over a file that cannot be read each say so, and neither calls it empty, absent or loaded", async () => {
  const { triggersPath, projectsPath } = unreadableFiles();
  const snap = () => ({ readAt: NOW, triggers: readTriggers({ triggersPath }), projects: readProjects({ projectsPath }), runs: [], waiting: { rows: [] }, hostBudgets: [] });
  const textOf = async (name, query, role) => {
    const parsed = parsePageQuery(name, query);
    const data = await loadPageData(name, parsed.query, { now: () => NOW, env: {}, paths: { triggersPath }, fleet: { snapshot: async () => snap(), parkedCount: async () => 0 }, hostLoads: async () => null, triggerEditor: () => ({}) }, { role });
    return String((await renderPage(name, { query: parsed.query, session: { name: role, role }, data, theme: null })).html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  };
  for (const [role, code] of [["agent", ""], ["viewer", " (EISDIR)"]]) {
    const trigger = await textOf("trigger", "index=2", role);
    assert.equal(trigger.split(`The triggers file cannot be read${code}.`).length - 1, 2, `${role}: What starts it, and Before you change it`);
    for (const never of ["This row does not exist", "The triggers file loads.", "(true)", "undefined"]) assert.ok(!trigger.includes(never), `${role}: ${never}`);
    const config = await textOf("config", "", role);
    assert.ok(config.includes(`The triggers file cannot be read${code}.`), role);
    assert.ok(config.includes(`The projects file cannot be read${code}.`), role);
    for (const never of ["declares no trigger", "declares no project", "(true)"]) assert.ok(!config.includes(never), `${role}: ${never}`);
    if (role === "agent") assert.ok(!trigger.includes("EISDIR") && !config.includes("EISDIR"), "the code stays out of an agent's copy");
  }
});
