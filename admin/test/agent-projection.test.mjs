import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPageData, pagePanels, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { fileTrouble } from "../src/console/panels/config.mjs";
import { createFleetReader, readProjects, readTriggers, readTriggersWithStalls } from "../src/read-model.mjs";
import { answeredWith, discoveryRedis, quietQueue } from "./helpers/fleet-reader-fakes.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeLiveHub, stateOf } from "../src/console/live.mjs";
import { AGENT_UNREAD_WORD, agentReadProjection, agentReasonToken } from "../src/agent-read.mjs";
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

/**
 * Every mark of `value` that says something was not read, by path: a key whose name says so (unread, unreachable,
 * degraded, in part, incomplete, truncated) with a value that asserts it (true, words, a list that is not empty).
 */
function unreadMarks(value, path = "", out = new Map()) {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((item, i) => unreadMarks(item, `${path}[${i}]`, out));
    return out;
  }
  for (const [key, v] of Object.entries(value)) {
    const at = path === "" ? key : `${path}.${key}`;
    const says = v === true || (typeof v === "string" && v !== "") || (Array.isArray(v) && v.length > 0);
    if (/unread|unreach|degraded|inpart|incomplete|truncated/i.test(key) && says) out.set(at, v);
    unreadMarks(v, at, out);
  }
  return out;
}
const markAt = (value, path) => path.split(/\.|\[|\]/).filter((part) => part !== "").reduce((at, key) => (at === null || at === undefined ? at : at[key]), value);

// Issue #1036: the projection dropped the WORDS of two unread marks, and the fact went with them: an agent's copy had
// no `queue.fleetDegraded` and no `parkedUnreachable`, so its pages drew the hosts and the parked runs as read.
test("an agent's copy keeps every mark that says something was not read: the registry's and the parked runs' as one closed word, a waiting queue's with its code, and never a reader's words (#1036)", async () => {
  assert.equal(AGENT_UNREAD_WORD, "unread");
  const out = agentReadProjection({
    queue: { fleetDegraded: "connect ECONNREFUSED 10.0.0.7:6379", registryReadInPart: true },
    parkedUnreachable: "the run mirror at valkey.internal could not be read",
    waiting: { pausedUnread: [{ queue: "pi-jobs@hostb", error: "WRONGTYPE" }, { queue: "pi-jobs", error: null }], listsUnread: [{ queue: "pi-jobs@hostb", error: "NOPERM this user has no permissions" }] },
    insights: { costsUnreachable: "ECONNREFUSED 10.0.0.7", hosts: { readInPart: "1 of 2 host rows not read, of which Valkey answered with an error: hostw (NOPERM)" } },
  });
  assert.deepEqual(out, {
    queue: { fleetDegraded: "unread", registryReadInPart: true },
    parkedUnreachable: "unread",
    waiting: { pausedUnread: [{ queue: "pi-jobs@hostb", error: "WRONGTYPE" }, { queue: "pi-jobs", error: null }], listsUnread: [{ queue: "pi-jobs@hostb", error: null }] },
    insights: { costsUnreachable: true, hosts: { readInPart: true } },
  });
  assert.ok(!/10\.0\.0\.7|valkey\.internal|permissions|host rows/.test(JSON.stringify(out)), "no reader's words");
  // A mark that asserts nothing stays one that asserts nothing.
  assert.deepEqual(agentReadProjection({ queue: { fleetDegraded: null }, parkedUnreachable: null }), { queue: { fleetDegraded: null }, parkedUnreachable: null });
  assert.deepEqual(agentReadProjection({ queue: { fleetDegraded: "" }, parkedUnreachable: "" }), { queue: {} });
  // The word is the same whatever was said, and only under these two names.
  assert.deepEqual(agentReadProjection({ fleetDegraded: "a", parkedUnreachable: "b", switchIncomplete: "the look for queues did not finish" }), { fleetDegraded: "unread", parkedUnreachable: "unread" });
});

test("the overview, Fleet, Parked and a host's page drawn for an agent over a registry and a parked scan that failed each say unread, as a viewer's do, and none is drawn Live (#1036)", async () => {
  const dir = tempDir("pd-1036-agent-unread-");
  mkdirSync(join(dir, "logs"));
  writeFileSync(join(dir, "triggers.json"), JSON.stringify({ triggers: [] }));
  const paths = { valkeyUrl: "redis://unused", logsDir: join(dir, "logs"), triggersPath: join(dir, "triggers.json") };
  // The real reader over a client that answers the registry's index and the run mirror's read with an error.
  const client = () => ({ ...discoveryRedis(() => ({ index: answeredWith("NOPERM") })), eval: answeredWith("NOPERM"), zrevrangebyscore: answeredWith("NOPERM"), pipeline: undefined });
  const reader = createFleetReader(paths, { readOnly: true, parseConnectionFn: () => ({}), redisFn: client, makeQueueFn: quietQueue() });
  const drawn = async (name, query, role) => {
    const parsed = parsePageQuery(name, query);
    const data = await loadPageData(name, parsed.query, { now: () => NOW, env: {}, paths, fleet: reader }, { role });
    const page = String((await renderPage(name, { query: parsed.query, session: { name: role, role }, data, theme: null })).html);
    return { data, pill: /<span id="live-status"[^>]*>/.exec(page)?.[0] ?? "", text: page.replace(/<script[^]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") };
  };
  const SAYS = {
    overview: ["The parked runs and the host registry could not be read, so what needs you is not known.", "The parked runs could not be read, so the questions are not counted.", "The hosts could not be read, so what they hold is not known."],
    fleet: ["Registry not read", "The hosts could not be read, so what they hold is not known.", "not known: the hosts could not be read"],
    parked: ["The parked runs could not be read (unread); this is not an empty inbox."],
    host: ["Not known: the hosts could not be read, so nothing here says whether hosta is live."],
  };
  try {
    const raw = await reader.snapshot({ waiting: true });
    assert.deepEqual([typeof raw.queue.fleetDegraded, typeof raw.parkedUnreachable, raw.queue.fleetError], ["string", "string", "NOPERM"], "the reader's own marks: its words, and the reply's code");
    // Every mark the snapshot carries that says unread is still one in an agent's copy, whatever it holds there.
    const copy = agentReadProjection(raw);
    const lost = [...unreadMarks(raw).keys()].filter((path) => { const v = markAt(copy, path); return !(v === true || (typeof v === "string" && v !== "") || (Array.isArray(v) && v.length > 0)); });
    assert.deepEqual(lost, [], "no unread mark of the snapshot is lost to an agent");
    assert.ok(unreadMarks(raw).size >= 4, "the snapshot carries marks to hold");
    for (const [name, query] of [["overview", ""], ["fleet", ""], ["parked", ""], ["host", "name=hosta"]]) {
      const agent = await drawn(name, query, "agent");
      const viewer = await drawn(name, query, "viewer");
      for (const sentence of SAYS[name]) assert.ok(agent.text.includes(sentence), `${name}, an agent's page says: ${sentence}`);
      for (const sentence of SAYS[name].filter((x) => !x.includes("(unread)"))) assert.ok(viewer.text.includes(sentence), `${name}, a viewer's page says the same: ${sentence}`);
      for (const never of ["No host is registered", "No live registry row for hosta", "No run is waiting on a person", "connect ECONNREFUSED", "said by Valkey"]) assert.ok(!agent.text.includes(never), `${name}: ${never}`);
      // The pill: drawn over data that could not be read whole, so the page's script holds it at Not live.
      for (const page of [agent, viewer]) assert.match(page.pill, /class="live live--off"[^>]* data-unread/, `${name}: ${page.pill}`);
      assert.deepEqual([agent.data.snapshot.queue.fleetDegraded, agent.data.snapshot.parkedUnreachable, agent.data.snapshot.queue.fleetError], ["unread", "unread", "NOPERM"], name);
      const gone = [...unreadMarks(viewer.data).keys()].filter((path) => { const v = markAt(agent.data, path); return !(v === true || (typeof v === "string" && v !== "") || (Array.isArray(v) && v.length > 0)); });
      assert.deepEqual(gone, [], `${name}: no unread mark of the page's data is lost to an agent`);
    }
  } finally {
    await reader.dispose();
  }
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

test("a cost-cap record's why reaches an agent by name for every rule of the cost guard, issue #985's final-payload and turn included", () => {
  for (const why of ["unboundable", "external", "over-cap", "final-payload", "turn"]) assert.deepEqual(agentReadProjection({ run: { reason: "cost-cap", why } }), { run: { reason: "cost-cap", why } }, why);
  assert.deepEqual(agentReadProjection({ run: { reason: "cost-cap", why: "qwen2.5:3b" } }), { run: { reason: "cost-cap", why: null } }, "anything else is no why");
});

// Issue #1064: a map of names to an error reply's code arrived as `{}`, since its fields are names the table does not know.
test("an agent's copy keeps the queues and hosts Valkey answered with an error, each by name and the reply's code, and the queues a read left out (#1064, #1036)", async () => {
  const { readQueueState } = await import("../src/read-model.mjs");
  const reply = () => Promise.reject(Object.assign(new Error("WRONGTYPE Operation against a key holding the wrong kind of value"), { name: "ReplyError" }));
  // The real status read over a queue whose paused read Valkey answers with an error, as `dispatch_status` projects it.
  const queue = await readQueueState({
    url: "redis://unused", parseConnectionFn: () => ({}),
    redisFn: () => ({ on() {}, disconnect() {}, async smembers() { return []; }, async scan() { return ["0", ["bull:pi-jobs@hostb:meta"]]; } }),
    makeQueueFn: (_c, opts) => ({ isPaused: () => (opts?.name === "pi-jobs@hostb" ? reply() : Promise.resolve(false)), async getJobCounts() { return { waiting: 1 }; }, async getWorkers() { return []; }, async close() {} }),
  });
  const out = agentReadProjection({ queue });
  assert.deepEqual([out.queue.partial, out.queue.unavailableQueues, out.queue.queueErrors, out.queue.queues], [true, ["pi-jobs@hostb"], { "pi-jobs@hostb": "WRONGTYPE" }, 2]);
  // A host's row likewise; a reply's sentence, a name that is no id and a value that is no string are left out.
  assert.deepEqual(agentReadProjection({ queue: { hostErrors: { hostw: "WRONGTYPE" } } }).queue.hostErrors, { hostw: "WRONGTYPE" });
  assert.deepEqual(agentReadProjection({ queueErrors: { a: "WRONGTYPE Operation against a key", "two words": "ERR", b: 7, c: { d: "ERR" }, e: "NOPERM" } }).queueErrors, { e: "NOPERM" });
  assert.deepEqual(agentReadProjection({ queueErrors: {} }), { queueErrors: {} });
  // Issue #1035: beside `queuesMayBeShort`, the class of a cause waiting does not end passes as one of its two closed
  // words, and nothing else does: a string under a key the projection does not know was dropped, the class with it.
  assert.deepEqual(agentReadProjection({ queuesMayBeShort: true, queuesShortLasting: "key" }), { queuesMayBeShort: true, queuesShortLasting: "key" });
  assert.equal(agentReadProjection({ queuesShortLasting: "permission" }).queuesShortLasting, "permission");
  assert.deepEqual(agentReadProjection({ queuesMayBeShort: true, queuesShortLasting: "passing" }), { queuesMayBeShort: true });
  assert.deepEqual(agentReadProjection({ queuesShortLasting: "Valkey answers host:live with WRONGTYPE" }), {});
  // Only under those two keys: any other map of names stays withheld.
  assert.deepEqual(agentReadProjection({ otherErrors: { hostw: "WRONGTYPE" } }), { otherErrors: {} });
  // The state API's copy for an agent session carries the same map.
  const state = agentReadProjection(stateOf({ queueErrors: { "pi-jobs@hostb": "WRONGTYPE" } }, "viewer", { now: NOW }));
  assert.deepEqual(state.queueErrors, { "pi-jobs@hostb": "WRONGTYPE" });
});

// Issue #1036: an agent's copy of the state document had no `fleetError`, and its `unreadHosts` had names without codes.
test("an agent's copy of the state keeps the registry's error code and each unread host's, one word each, off a real reader over a row and an index Valkey answers with an error (#1036)", async () => {
  const { createFleetReader } = await import("../src/read-model.mjs");
  const { keyedRedis, quietQueue, registryKeys } = await import("./helpers/fleet-reader-fakes.mjs");
  const { readLiveHosts } = await import("@edgehero/pi-dispatch/host-registry");
  const logsDir = tempDir("pd-1036-agent-state-");
  const reply = (message) => Promise.reject(Object.assign(new Error(message), { name: "ReplyError" }));
  // The real registry read, over a client that answers one row's read, or the index's, with an error reply.
  const stateOver = async (wrap) => {
    const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json") }, {
      makeQueueFn: quietQueue(), parseConnectionFn: () => ({}), redisFn: () => wrap(keyedRedis(registryKeys({ hosta: { beatAt: String(NOW) }, hostw: {}, late: {} }))),
      readLiveHostsFn: (r, o) => readLiveHosts(r, { ...o, now: () => NOW, timeoutMs: 200 }), discoverHostQueuesFn: async () => ({ names: [], incomplete: null }), nowFn: () => NOW, readOnly: true,
    });
    try {
      const snapshot = await reader.snapshot();
      return { viewer: stateOf(snapshot, "viewer", { now: NOW }), agent: agentReadProjection(stateOf(snapshot, "viewer", { now: NOW })) };
    } finally { await reader.dispose(); }
  };
  // One row answered with WRONGTYPE, one that got no answer: both named, the first with its code, the second with null.
  const rows = await stateOver((r) => ({ ...r, hgetall: (key) => (key === "host:h:hostw" ? reply("WRONGTYPE Operation against a key holding the wrong kind of value") : key === "host:h:late" ? new Promise(() => {}) : r.hgetall(key)) }));
  assert.deepEqual(rows.viewer.unreadHosts, [{ name: "hostw", error: "WRONGTYPE" }, { name: "late", error: null }]);
  assert.deepEqual([rows.agent.unreadHosts, rows.agent.fleetError, rows.agent.registryReadInPart], [rows.viewer.unreadHosts, null, true], "an agent reads what a viewer does");
  // The index itself answered with an error.
  const index = await stateOver((r) => ({ ...r, smembers: () => reply("NOPERM this user has no permissions to run the 'smembers' command") }));
  assert.deepEqual([index.viewer.fleetError, index.agent.fleetError, index.agent.fleetDegraded], ["NOPERM", "NOPERM", true]);
  assert.ok(!JSON.stringify([rows.agent, index.agent]).includes("Operation against") && !JSON.stringify(index.agent).includes("no permissions"), "the code alone");
  // Only a code passes in either place, and only there: a sentence is null, and another key named `error` stays withheld.
  assert.deepEqual(agentReadProjection({ fleetError: "WRONGTYPE Operation against a key", unreadHosts: [{ name: "hostw", error: "a sentence" }, { name: "hostx", error: 7 }] }), { fleetError: null, unreadHosts: [{ name: "hostw", error: null }, { name: "hostx", error: null }] });
  assert.deepEqual(agentReadProjection({ other: [{ name: "hostw", error: "WRONGTYPE" }], error: "WRONGTYPE" }), { other: [{ name: "hostw" }] });
});
