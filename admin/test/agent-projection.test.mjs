import test from "node:test";
import assert from "node:assert/strict";
import { loadPageData, pagePanels } from "../src/console/pages.mjs";
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
