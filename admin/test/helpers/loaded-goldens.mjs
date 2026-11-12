/**
 * The goldens for what a run loaded (issue #800): one per row of the LoadedStates card, one per `LOADED_STATES` member the card has
 * no row for, and each state of ProjectLoads, drawn with the cards' own sample runs by the real page, over records built the way
 * the worker builds them. The long names' are for the width check, which can only see a name a golden holds.
 *
 * The shared fixture deployment (`launch/fixture-deployment.mjs`) sets `"packages": false` on every trigger and has no
 * `run.progress` on trigger 3, so it cannot produce gh-9575's record. Each record is handed to its page here, rather than
 * teaching that fixture a story the other goldens would then have to tell.
 */
import { NOW } from "../../../launch/fixture-deployment.mjs";
import { projectLoadsOf } from "../../src/loaded-words.mjs";
import { loadPageData, parsePageQuery, renderPage } from "../../src/console/pages.mjs";
import { consoleProjectFixture } from "./console-project-fixture.mjs";
import { HOST_LOADS, LOADED_SAMPLES, LONG_LOADED, billingRecords, incompleteRecords, longNamesProjectRecords, longNamesRecord, webRecords } from "./loaded-samples.mjs";
import { sandboxFixture, SANDBOX_HOSTS_FIXTURE } from "./sandbox-goldens.mjs";

const MIN = 60_000;
const OPERATOR = Object.freeze({ id: "s-loaded-goldens-operator", name: "ops", role: "operator" });
const VIEWER = Object.freeze({ id: "s-loaded-goldens-viewer", name: "watcher", role: "viewer" });

async function runPage(record, { role = "operator", chat = { state: "finished", mode: "fork", jobState: "completed" }, id = null, ...extra } = {}) {
  const data = { now: NOW, env: {}, run: record ? { record, source: "local" } : { missing: true }, chat, transcript: { exists: false }, children: [], childrenSearched: 50, hostLoads: HOST_LOADS, ...extra };
  const result = await renderPage("run", { query: { id: id ?? record?.jobId ?? "gh-b3d7" }, session: role === "operator" ? OPERATOR : VIEWER, data });
  return String(result.html);
}

async function runsPage(runs) {
  const parsed = parsePageQuery("runs", "");
  const fleet = { runsPage: async () => ({ runs, mirror: "ok", next: null }), runsWindow: async () => null, parkedCount: async () => 0 };
  const data = await loadPageData("runs", parsed.query, { now: () => NOW, env: {}, fleet }, { role: "operator" });
  return String((await renderPage("runs", { session: OPERATOR, query: parsed.query, data })).html);
}

async function sandboxPage({ query, record = null, change = () => {}, hostLoads = HOST_LOADS }) {
  const parsed = parsePageQuery("sandboxes", query);
  if (parsed.refusal) throw new Error(parsed.refusal);
  const report = sandboxFixture();
  change(report);
  const deps = { now: () => NOW, fleet: { parkedCount: async () => 1, runById: async () => (record ? { record } : { missing: true }) }, sandboxes: { hosts: () => ({ config: SANDBOX_HOSTS_FIXTURE }), read: async () => report }, hostLoads: async () => hostLoads };
  const data = await loadPageData("sandboxes", parsed.query, deps, { role: "operator", readOnly: false });
  return String((await renderPage("sandboxes", { data, query: parsed.query, session: { role: "operator", name: "ops" }, readOnly: false })).html);
}

async function projectPage(records, role = "operator") {
  const value = consoleProjectFixture(NOW);
  value.loads = projectLoadsOf(records);
  const parsed = parsePageQuery("project", "id=billing");
  const data = await loadPageData("project", parsed.query, { now: () => NOW, env: {}, fleet: { snapshot: async () => ({ parked: [] }), parkedCount: async () => 0 }, projectView: async () => value }, { role });
  return String((await renderPage("project", { session: { name: role === "viewer" ? "watcher" : "ops", role }, query: parsed.query, data, readOnly: false, theme: null })).html);
}

/** What the hosts published for the long names: a host of its own, still listing what the record names, and one that does not. */
function longNamesHostLoads() {
  const { host, overlay, package: pkg } = LONG_LOADED;
  const row = { state: "current", at: NOW, ageMs: 0, every: 24, by: { uid: 1000, worker: true }, overlayExtensionsAllowed: true, skills: [], mcp: [], flows: [], unread: [], more: {}, image: LONG_LOADED.image, piVersion: "1.5.0" };
  return { more: 0, hosts: [{ ...row, name: host, extensions: [{ name: overlay, kind: "file" }], packages: [{ name: pkg, version: "1.4.2" }] }, { ...row, name: "mini1", extensions: [], packages: [] }] };
}

/** A fresh sandbox's page: the form's own query, with no kept workspace named, so no run is quoted. */
const FRESH_QUERY = "repo=acme%2Fweb&index=2&ref=HEAD&host=mini1";

/** Issue #847: what mini1 published, with an answer for trigger 3's flow and the overlay's MCP servers. */
function freshHostLoads({ tier = "repository", repo = "present", mcp = [] } = {}) {
  return { ...HOST_LOADS, hosts: HOST_LOADS.hosts.map((row) => (row.name === "mini1" ? { ...row, flows: [{ trigger: 2, flow: "fix", tier, package: null, repo }], mcp } : row)) };
}
const server = (name, enabled) => ({ name, transport: "stdio", where: "overlay", exposure: "local", enabled, keys: [] });

const SAMPLES = LOADED_SAMPLES;
const LIVE = Object.freeze({
  id: "gh-b3d7",
  chat: { state: "active", mode: "live", jobState: "active" },
  transcript: { exists: true },
  activeRun: { target: "acme/billing#259", kind: "github", host: "mini1", project: "billing", backend: "podman", flow: "migrate", provider: "anthropic", model: "claude-sonnet-5-5", maxTurns: 40, queue: "pi-jobs@mini1", startedAt: new Date(NOW - 12 * MIN).toISOString(), triggerIndex: 2 },
});

export const LOADED_DRAW = Object.freeze({
  "run-loaded.operator": () => runPage(SAMPLES.everything()),
  "run-loaded.viewer": () => runPage(SAMPLES.everything(), { role: "viewer" }),
  "run-loaded-left-out.operator": () => runPage(SAMPLES.leftOut()),
  "run-loaded-left-out-overlay.operator": () => runPage(SAMPLES.leftOutOverlay()),
  "run-loaded-mcp-connected.operator": () => runPage(SAMPLES.mcpConnected(), { chat: { state: "parked", mode: "reply", jobState: "completed" } }),
  "run-loaded-dropped.operator": () => runPage(SAMPLES.dropped()),
  "run-loaded-cut.operator": () => runPage(SAMPLES.cut()),
  "run-loaded-no-flow.operator": () => runPage(SAMPLES.noFlow()),
  "run-loaded-no-flow.viewer": () => runPage(SAMPLES.noFlow(), { role: "viewer" }),
  "run-loaded-extension-failed.operator": () => runPage(SAMPLES.extensionFailed()),
  "run-loaded-extension-thrown.operator": () => runPage(SAMPLES.extensionThrown()),
  "run-loaded-two-tiers.operator": () => runPage(SAMPLES.twoTiers()),
  "run-loaded-mcp-failed.operator": () => runPage(SAMPLES.mcpFailed()),
  "run-loaded-mcp-stopped.operator": () => runPage(SAMPLES.mcpTimeout(), { chat: { state: "finished", mode: "none", jobState: "failed" } }),
  "run-loaded-host-differs.operator": () => runPage(SAMPLES.hostDiffers()),
  "run-loaded-running.operator": () => runPage(null, LIVE),
  "run-loaded-not-recorded.operator": () => runPage(SAMPLES.notRecorded()),
  "run-loaded-refused.operator": () => runPage(SAMPLES.refused()),
  "run-loaded-stopped.operator": () => runPage(SAMPLES.stopped(), { chat: { state: "finished", mode: "none", jobState: "failed" } }),
  "run-loaded-stopped-after-loading.operator": () => runPage(SAMPLES.stoppedAfterLoading(), { chat: { state: "finished", mode: "none", jobState: "completed" } }),
  "run-loaded-no-agent.operator": () => runPage(SAMPLES.noAgent()),
  "run-loaded-absent.operator": () => runPage(SAMPLES.absent()),
  "run-loaded-invalid.operator": () => runPage(SAMPLES.invalid()),
  "run-loaded-no-room.operator": () => runPage(SAMPLES.noRoom()),
  "run-loaded-long-names.operator": () => runPage(longNamesRecord(), { hostLoads: longNamesHostLoads() }),
  "runs-loaded-problems.operator": () => runsPage([SAMPLES.noFlow(), SAMPLES.extensionFailed()]),
  "runs-loaded-both.operator": () => runsPage([SAMPLES.bothLacked()]),
  "run-loaded-both.operator": () => runPage(SAMPLES.bothLacked()),
  "sandbox-loaded-run.operator": () => sandboxPage({ query: "id=gh-9575&host=mini1", record: SAMPLES.everything() }),
  "sandbox-loaded-fresh.operator": () => sandboxPage({ query: FRESH_QUERY }),
  // A sandbox's trigger is a forge's, whose repository is on no host: doctor answers its flow from another tier or not at all.
  "sandbox-loaded-flow-found.operator": () => sandboxPage({ query: FRESH_QUERY, hostLoads: freshHostLoads({ tier: "overlay", repo: "unknown", mcp: [server("linear", true)] }), change: (report) => { report.mcp = ["linear"]; } }),
  "sandbox-loaded-flow-unknown.operator": () => sandboxPage({ query: FRESH_QUERY, hostLoads: freshHostLoads({ tier: "unknown", repo: "unknown" }) }),
  "sandbox-loaded-mcp-lacks.operator": () => sandboxPage({ query: FRESH_QUERY, hostLoads: freshHostLoads({ tier: "overlay", repo: "unknown", mcp: [server("linear", false)] }), change: (report) => { report.mcp = ["linear", "docs"]; } }),
  "sandbox-loaded-unknown.operator": () => sandboxPage({ query: FRESH_QUERY, change: (report) => { report.hosts.push({ ...report.hosts[0], name: "mini2", rows: [] }); report.plan.host = "mini2"; report.selected.host = "mini2"; } }),
  "sandbox-loaded-long-names.operator": () => sandboxPage({ query: "id=gh-9575&host=mini1", record: longNamesRecord(), hostLoads: longNamesHostLoads(), change: (report) => { report.hosts.push({ ...report.hosts[0], name: LONG_LOADED.host, rows: [] }); report.plan.host = LONG_LOADED.host; report.plan.image = LONG_LOADED.image; report.selected.host = LONG_LOADED.host; } }),
  "project-loads.operator": () => projectPage(billingRecords()),
  "project-loads.viewer": () => projectPage(billingRecords(), "viewer"),
  "project-loads-same.operator": () => projectPage(webRecords()),
  "project-loads-none.operator": () => projectPage([]),
  "project-loads-incomplete.operator": () => projectPage(incompleteRecords()),
  "project-loads-long-names.operator": () => projectPage(longNamesProjectRecords()),
});
export const LOADED_PANEL_STATES = Object.freeze(Object.keys(LOADED_DRAW));

/** Which golden draws each of `LOADED_STATES`, and the sample it draws. `running` has no record: a running job has none yet. */
export const LOADED_STATE_GOLDENS = Object.freeze({
  everything: Object.freeze({ golden: "run-loaded.operator", sample: "everything" }),
  "left-out": Object.freeze({ golden: "run-loaded-left-out.operator", sample: "leftOut" }),
  "host-differs": Object.freeze({ golden: "run-loaded-host-differs.operator", sample: "hostDiffers" }),
  "no-flow": Object.freeze({ golden: "run-loaded-no-flow.operator", sample: "noFlow" }),
  "extension-failed": Object.freeze({ golden: "run-loaded-extension-failed.operator", sample: "extensionFailed" }),
  "mcp-stopped": Object.freeze({ golden: "run-loaded-mcp-stopped.operator", sample: "mcpTimeout" }),
  "mcp-failed": Object.freeze({ golden: "run-loaded-mcp-failed.operator", sample: "mcpFailed" }),
  stopped: Object.freeze({ golden: "run-loaded-stopped.operator", sample: "stopped" }),
  "no-agent": Object.freeze({ golden: "run-loaded-no-agent.operator", sample: "noAgent" }),
  running: Object.freeze({ golden: "run-loaded-running.operator", sample: null }),
  "not-recorded": Object.freeze({ golden: "run-loaded-not-recorded.operator", sample: "notRecorded" }),
  refused: Object.freeze({ golden: "run-loaded-refused.operator", sample: "refused" }),
  absent: Object.freeze({ golden: "run-loaded-absent.operator", sample: "absent" }),
  invalid: Object.freeze({ golden: "run-loaded-invalid.operator", sample: "invalid" }),
  cut: Object.freeze({ golden: "run-loaded-no-room.operator", sample: "noRoom" }),
});
