import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runWorkspace, runWorkspaceState, runOutcome, runActionsPanel } from "../src/console/panels/run.mjs";
import { gatewayRunFacts } from "../src/console/gateway-run-facts.mjs";
import { WORKSPACE_CSS, WORKSPACE_CSS_SHA256 } from "../src/console/workspace-css.mjs";
import { WORKSPACE_DRAW, workspaceFixture } from "./helpers/workspace-goldens.mjs";
import { assertClean } from "./helpers/console-pages-harness.mjs";
import { parsePageQuery, pageQueryString, dataQueryOf, loadPageData, pagePanels } from "../src/console/pages.mjs";
import { makeLiveHub } from "../src/console/live.mjs";
import { sandboxFixture } from "./helpers/sandbox-goldens.mjs";
import { validGatewayRunFacts } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";
import { parseDocument } from "./helpers/script-dom.mjs";

const text = (state, extra = {}) => String(runWorkspace({ ...workspaceFixture({ state }), ...extra }));

test("workspace decisions honor live/recovery/parked authority before a historical completed outcome", () => {
  const cases = { open: "open", shared: "open", kept: "kept", failed: "kept", awaiting: "kept", unsupported: "prepare", running: "running", recovery: "running", "never-started": "nothing", refused: "nothing", expired: "prepare", swept: "prepare", "retention-off": "prepare", unknown: "unknown", stale: "unknown", deleted: "unknown" };
  for (const [state, kind] of Object.entries(cases)) assert.equal(runWorkspaceState(workspaceFixture({ state })).kind, kind, state);
  assert.match(text("awaiting"), /Look before you answer/); assert.match(text("awaiting"), /shell edits do not reach it/);
  assert.doesNotMatch(text("awaiting"), /Try it before you merge/);
  assert.match(text("failed"), /Reproduce it/);
  for (const state of ["never-started", "refused", "running", "recovery"]) assert.doesNotMatch(text(state), /pi-dispatch-open:|sandbox\/gateway\/launch|sandbox-end/);
  assert.match(text("unknown"), /could not be verified/); assert.match(text("stale"), /missing tracking does not prove it was swept/); assert.doesNotMatch(text("stale"), /Its workspace is gone|Prepare from this run/);
});

test("native opener, authenticated driver and watcher are distinct, with exact links and End incarnation", () => {
  const markup = text("shared");
  assert.match(markup, /<b>ops<\/b> opened the shell/);
  assert.match(markup, /lee is driving<\/b>, and lets operators watch\. You see new output and cannot type/);
  assert.match(markup, /Watching now: sam/);
  const watch = markup.match(/<a[^>]+href="([^"]+)"[^>]*>[^]*?Watch<\/a>/)?.[1];
  assert.equal(watch, "/sandbox/gateway/launch?host=mini1&amp;id=gh-9575&amp;kind=watch");
  assert.match(markup, /pi-dispatch-open:\/\/attach\/gh-9575\?host=mini1/);
  assert.match(markup, /name="nonce" value="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/);
  assert.match(markup, /name="containerId" value="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"/);
  assert.match(markup, /<details class="ws-more">/);
  assert.match(markup, /<aside data-sandbox-command>[\s\S]*?data-copy[ >]/, "the folded command retains the native opener's shared browser contract");
  const completed = workspaceFixture({ state: "open" });
  assert.match(String(runOutcome(completed)), /href="#p-workspace"/);
  assert.doesNotMatch(String(runActionsPanel(completed)), /sandbox\/gateway\/launch|pi-dispatch-open:/, "the workspace action is not duplicated in Actions");
});

test("a browser chooser for a host with no enabled gateway says so, rather than drawing an empty list", async () => {
  const { sandboxOpen } = await import("../src/console/panels/sandboxes.mjs");
  const query = parsePageQuery("sandboxes", "gatewaySelect=1&host=mini1").query;
  const shell = { host: "mini1", id: "gh-9575", containerId: "c".repeat(64), nonce: "n".repeat(32), by: "ops", since: 1 };
  const view = browserGateways => ({ role: "operator", name: "ops", query, data: { browserGateways, sandboxes: { sessions: [shell] } } });
  const refused = String(sandboxOpen(view({ enabledHosts: ["build3"], sessions: [] })));
  assert.match(refused, /role="status"[^>]*>The browser gateway is not enabled for mini1/);
  assert.doesNotMatch(refused, /Choose an already-open shell/);
  assert.doesNotMatch(refused, /sandbox-browser/);
  assert.match(String(sandboxOpen(view({ enabledHosts: ["mini1"], sessions: [shell] }))), /Choose an already-open shell on mini1/);
});

test("viewer has no workspace facts; read-only workspace offers selectable commands only", () => {
  assert.equal(text("shared", { role: "viewer" }), "");
  const readonly = text("shared", { readOnly: true });
  assert.match(readonly, /data-copy/); assert.match(readonly, /pi-dispatch/);
  assert.doesNotMatch(readonly, /pi-dispatch-open:|sandbox\/gateway\/launch|data-action=|href="\/triggers|Fork it with a message|Prepare from this run<\/a>/);
});

test("a read-only console offers neither Steer nor Prepare; a writable one offers exactly that", () => {
  // The links, not the words: "Prepare from this run" is also the row's sentence, which a read-only console keeps.
  for (const [state, control] of [["running", /href="#p-chat"/], ["swept", /href="\/runs\/sandboxes\?fromRun=/]]) {
    assert.match(text(state), control, `${state} offers it when writable`);
    assert.doesNotMatch(text(state, { readOnly: true }), control, `${state} never offers it read-only`);
  }
});

test("complete run layout keeps Workspace, run facts and Actions in the main column with cost and resources beside them", async () => {
  const document = parseDocument(await WORKSPACE_DRAW["run-workspace-open.operator"]());
  const main = document.querySelector(".run-main"), side = document.querySelector(".run-side");
  assert.ok(main.querySelector("#p-workspace")); assert.ok(main.querySelector("#p-run")); assert.ok(main.querySelector("#p-actions"));
  assert.equal(side.querySelector("#p-run"), null); assert.ok(side.querySelector("#p-cost")); assert.ok(side.querySelector("#p-resources"));
  const panels = main.querySelectorAll("[data-panel]").map((panel) => panel.id);
  assert.ok(panels.indexOf("p-workspace") < panels.indexOf("p-run")); assert.ok(panels.indexOf("p-run") < panels.indexOf("p-actions"));
  const parked = parseDocument(await WORKSPACE_DRAW["run-workspace-awaiting.operator"]());
  assert.equal(parked.querySelector(".run-main").querySelectorAll("[data-panel]")[0].id, "p-chat", "the parked answer still leads its main column");
});

test("the finding links use the current trigger chooser and the actual retained fork message form", () => {
  const f = workspaceFixture({ state: "kept" });
  f.data.run.record.triggerIndex = 42;
  f.data.forkPoints = { ok: true, entries: [{ id: "safe-point", positions: ["at"] }] };
  const markup = String(runWorkspace(f)), actions = String(runActionsPanel(f));
  assert.match(markup, /href="\/triggers"/); assert.doesNotMatch(markup, /trigger\?index=42/);
  assert.match(markup, /href="#run-fork"/); assert.match(actions, /id="run-fork"/); assert.match(actions, /name="message"/);
  assert.match(text("kept"), /Fork unavailable: no saved session is available for this run/);
});

test("selector and preparation query state roundtrip canonically without sharing their SSE data keys", () => {
  for (const raw of ["gatewaySelect=1&host=mini1", "fromRun=gh-9575", "fromRun=gh-9575&index=2&host=build3&repo=acme/web&ref=HEAD"]) {
    const parsed = parsePageQuery("sandboxes", raw); assert.ok(parsed.query, raw);
    const again = parsePageQuery("sandboxes", pageQueryString("sandboxes", parsed.query));
    assert.deepEqual(again, parsed); assert.deepEqual(dataQueryOf("sandboxes", parsed.query), parsed.query);
  }
  for (const raw of ["gatewaySelect=1", "gatewaySelect=0&host=mini1", "gatewaySelect=1&host=mini1&id=gh-9575", "gatewaySelect=1&host=mini1&fromRun=gh-9575", "gatewaySelect=1&host=mini1&host=mini1", "fromRun=../bad", "fromRun="]) assert.equal(typeof parsePageQuery("sandboxes", raw).refusal, "string", raw);
  assert.notEqual(pageQueryString("sandboxes", parsePageQuery("sandboxes", "gatewaySelect=1&host=mini1").query), pageQueryString("sandboxes", parsePageQuery("sandboxes", "host=mini1").query));
});

test("real live-panel rendering keeps selector links scoped through cache sharing, updates and reconnect", async () => {
  const fixture = workspaceFixture(), report = sandboxFixture(fixture.now), loaded = [];
  let at = fixture.now;
  const shell = report.sessions[0];
  report.sessions.push({ ...shell, id: "other-host-shell", host: "build3", nonce: "d".repeat(32), containerId: "e".repeat(64) });
  const deps = { now: () => at, fleet: { parkedCount: async () => 0 }, sandboxes: { hosts: () => ({}), read: async () => structuredClone(report) }, gatewayView: async () => ({ enabledHosts: ["mini1", "build3"], sessions: structuredClone(report.sessions) }) };
  const hub = makeLiveHub({ now: () => at, timers: { setInterval: () => 1, clearInterval() {} }, queryKeyOf: pageQueryString, dataQueryOf, readTokens: () => ({ file: { tokens: [] } }), peekSession: () => ({ name: "ops", role: "operator" }), loadPageData: async (page, query, who) => { loaded.push(pageQueryString(page, query)); return loadPageData(page, query, deps, who); }, pagePanels });
  const response = () => ({ chunks: [], writableLength: 0, write(value) { this.chunks.push(value); return true; }, end() {}, destroy() {}, text() { return this.chunks.join(""); } });
  const normal = response(), selected = response(), same = response();
  const query = parsePageQuery("sandboxes", "gatewaySelect=1&host=mini1").query;
  const subscribe = (res, q) => hub.subscribe({ res, sessionId: "session", session: { name: "ops", role: "operator" }, page: "sandboxes", query: q });
  subscribe(normal, parsePageQuery("sandboxes", "host=mini1").query); subscribe(selected, query); const close = subscribe(same, parsePageQuery("sandboxes", "host=mini1&gatewaySelect=1").query);
  await hub.tick(); await new Promise((resolve) => setImmediate(resolve));
  const open = (res) => [...res.text().matchAll(/event: panel\ndata: (.+)\n/g)].map((m) => JSON.parse(m[1])).filter((p) => p.id === "p-sb-open").at(-1)?.html;
  assert.ok(open(normal), normal.text());
  assert.match(open(normal), /other-host-shell/); assert.match(open(normal), /target="_blank"/);
  assert.doesNotMatch(open(selected), /other-host-shell/); assert.match(open(selected), /target="_self"/);
  assert.equal(open(selected), open(same)); assert.equal(loaded.length, 2, "same canonical selector shares one load; normal page does not share its rendering");
  report.sessions.push({ ...shell, id: "new-same-host-shell", nonce: "f".repeat(32), containerId: "9".repeat(64) }); at += 5001;
  await hub.tick(); assert.match(open(selected), /new-same-host-shell/); assert.match(open(selected), /target="_self"/); assert.doesNotMatch(open(selected), /other-host-shell/);
  close(); const reconnected = response(); subscribe(reconnected, parsePageQuery("sandboxes", pageQueryString("sandboxes", query)).query);
  await hub.tick(); await new Promise((resolve) => setImmediate(resolve)); assert.match(open(reconnected), /target="_self"/); assert.doesNotMatch(open(reconnected), /other-host-shell/);
  hub.close();
});

test("only exact normalized historical record facts cross to a gateway", () => {
  const { data } = workspaceFixture();
  const target = { host: "mini1", id: "gh-9575" }, record = { ...data.run.record, reason: "awaiting-input", question: "PRIVATE_QUESTION", transcript: "PRIVATE_TRANSCRIPT", instructions: "PRIVATE_INSTRUCTIONS", token: "PRIVATE_TOKEN" };
  const facts = gatewayRunFacts(target, record);
  assert.deepEqual(Object.keys(facts), ["id", "outcome", "project", "target", "flow", "endedAt"]);
  assert.equal(facts.outcome, "awaiting-input");
  assert.equal(validGatewayRunFacts(facts), true);
  assert.doesNotMatch(JSON.stringify(facts), /PRIVATE|instructions|token|question|transcript/);
  for (const changed of [{ jobId: "other" }, { host: "other" }, { outcome: "future-state" }]) assert.equal(gatewayRunFacts(target, { ...record, ...changed }), null);
  assert.equal(gatewayRunFacts({ host: "mini1", id: "sb-123" }, { ...record, jobId: "sb-123" }), null);
  assert.equal(gatewayRunFacts({ ...target, venue: "podman" }, record), null);
  const hostile = gatewayRunFacts(target, { ...record, project: "<img>", flow: "javascript:evil", target: "<script>", endedAt: "PRIVATE" });
  assert.equal(hostile.project, null); assert.equal(hostile.flow, null); assert.equal(hostile.target, null); assert.equal(hostile.endedAt, null);
  const canonical = "2026-02-28T15:12:00.000Z";
  assert.equal(gatewayRunFacts(target, { ...record, endedAt: canonical }).endedAt, canonical);
  for (const endedAt of ["2026-02-30T15:12:00.000Z", "2026-02-28T15:12:00Z", "2026-02-28", "2026-02-28T16:12:00.000+01:00", "2026-13-01T15:12:00.000Z", undefined, null]) {
    const got = gatewayRunFacts(target, { ...record, endedAt });
    assert.equal(got.endedAt, null, String(endedAt));
    assert.equal(validGatewayRunFacts(got), true);
    assert.equal(got.id, target.id, "a missing optional timestamp does not discard the proven run identity");
  }
});

test("viewer-only live page loads never read private workspace inventory", async () => {
  let reads = 0;
  const fixture = workspaceFixture(), record = fixture.data.run.record;
  const deps = { now: () => fixture.now, fleet: { parkedCount: async () => 0, runById: async () => ({ record }) }, sandboxes: { hosts: () => ({}), workspace: async () => { reads++; return { retained: true, shell: fixture.data.workspace.shell }; } } };
  await loadPageData("run", { id: record.jobId }, deps, { role: "viewer", live: true });
  assert.equal(reads, 0);
  await loadPageData("run", { id: record.jobId }, deps, { role: "operator" });
  assert.equal(reads, 1);
  // What the live hub asks for when operators watch the page. Without this a refresh would turn the row "unknown".
  const refreshed = await loadPageData("run", { id: record.jobId }, deps, { live: true });
  assert.equal(reads, 2); assert.equal(refreshed.workspace?.retained, true);
});

test("workspace scoped CSS is the exact published generator source and all state pages obey console structure", async () => {
  const generator = readFileSync(new URL("../../design/tools/gen_workspace.py", import.meta.url), "utf8");
  const css = /\nCSS = """([\s\S]*?)"""/.exec(generator)?.[1];
  assert.equal(WORKSPACE_CSS, css);
  assert.equal(WORKSPACE_CSS_SHA256, createHash("sha256").update(css).digest("hex"));
  for (const [name, draw] of Object.entries(WORKSPACE_DRAW)) assertClean(name, await draw());
});
