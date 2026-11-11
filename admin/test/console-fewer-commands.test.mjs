import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW } from "../../launch/fixture-deployment.mjs";
import { REASONS } from "@edgehero/pi-dispatch/reason-catalog";
import { PAGES, loadPageData, panelIds, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { SETUP_DOES_STEPS, SETUP_DOES_TEXT } from "../src/console/panels/overview.mjs";
import { DOCTOR_FROM_SETUP, doctorFromSetup } from "../src/console/panels/common.mjs";
import { hostDoctor } from "../src/console/panels/host.mjs";
import { fleetDoctor } from "../src/console/panels/fleet.mjs";
import { REASON_FIXES, runOutcome } from "../src/console/panels/run.mjs";
import { firstRunState } from "../src/doctor-view.mjs";
import { firstRun } from "./helpers/panel-goldens.mjs";

// Issue #849, part 6: where the console can do a step itself, a person is shown where, and the terminal command stays for whoever prefers it.

async function overview({ role = "operator", granted = true, readOnly = false } = {}) {
  const snapshot = firstRun();
  const parsed = parsePageQuery("overview", "");
  const data = await loadPageData("overview", parsed.query, { fleet: { snapshot: async () => snapshot }, now: () => NOW, deployment: { folder: "pi-dispatch" }, ...(granted === null ? {} : { setupGranted: () => granted }) }, { role, readOnly });
  const page = await renderPage("overview", { query: parsed.query, session: { name: role === "operator" ? "ops" : "watcher", role }, data, readOnly, theme: null, flash: null, maxStreams: 4 });
  return { html: String(page.html), data, snapshot };
}

/** Each checklist step's markup, by its title. */
function steps(html) {
  return html.split('<li class="su-step').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf("</li>")));
}

test("with the host-setup grant, an operator's checklist sends the steps /setup does there, and keeps their commands folded", async () => {
  const { html, data, snapshot } = await overview();
  assert.equal(data.setupGranted, true, "the overview reads the grant, one boolean");
  const state = firstRunState(snapshot, { session: { role: "operator" }, deployment: { folder: "pi-dispatch" } });
  const viaSetup = state.steps.filter((st) => SETUP_DOES_STEPS.includes(st.id) && st.state !== "ready" && st.commands.length > 0);
  assert.ok(viaSetup.length >= 2, "the fixture has steps /setup can do");
  const drawn = steps(html);
  for (const st of state.steps) {
    if (st.state === "ready" || st.commands.length === 0) continue;
    const mine = drawn.find((d) => d.includes(st.title));
    assert.ok(mine, st.id);
    if (viaSetup.includes(st)) {
      assert.match(mine, new RegExp(`<a class="link" href="/setup">${SETUP_DOES_TEXT}</a>`), `${st.id}: sent to /setup`);
      assert.match(mine, /<details class="su-term"><summary>In a terminal instead<\/summary>/, `${st.id}: the command kept`);
      for (const argv of st.commands) assert.ok(mine.includes(argv[0]), `${st.id}: ${argv.join(" ")} still there`);
    } else {
      assert.doesNotMatch(mine, /In a terminal instead/, `${st.id}: /setup cannot do it, so its command stays in view`);
    }
  }
});

test("without the grant, read-only or as a viewer, the checklist is what it was", async () => {
  for (const options of [{ granted: false }, { granted: null }, { readOnly: true }, { role: "viewer" }]) {
    const { html } = await overview(options);
    assert.ok(!html.includes(SETUP_DOES_TEXT), JSON.stringify(options));
  }
});

test("the doctor on /setup is offered for this console's own host only, to an operator, where the grant is on", () => {
  const view = (fields = {}) => ({ role: "operator", readOnly: false, data: { setupGranted: true, snapshot: { doctorSelf: "mini1" } }, ...fields });
  assert.match(String(doctorFromSetup(view(), "mini1")), new RegExp(`href="/setup">Run doctor from Set up</a>, ${DOCTOR_FROM_SETUP}`));
  assert.equal(doctorFromSetup(view(), "mini2"), null, "another host's doctor runs on that host");
  assert.equal(doctorFromSetup(view({ role: "viewer" }), "mini1"), null);
  assert.equal(doctorFromSetup(view({ readOnly: true }), "mini1"), null);
  assert.equal(doctorFromSetup(view({ data: { setupGranted: false, snapshot: { doctorSelf: "mini1" } } }), "mini1"), null);
  assert.equal(doctorFromSetup(view({ data: { setupGranted: true, snapshot: {} } }), "mini1"), null, "a host with no name of its own is none");
  const host = String(hostDoctor({ ...view(), query: { name: "mini1" } }));
  assert.match(host, /Run doctor from Set up/);
  assert.match(host, /<span>pi-dispatch<\/span> <span>doctor<\/span>/, "the command stays beside it: the browser's doctor runs no container probes");
});

test("every reason the run page links is a catalog token, and every link is a page's own panel", () => {
  for (const [token, fix] of Object.entries(REASON_FIXES)) {
    assert.ok(Object.hasOwn(REASONS, token), `${token}: a catalog token`);
    const [path, fragment] = fix.href.split("#");
    const page = Object.keys(PAGES).find((name) => PAGES[name].path === path);
    assert.ok(page, `${token}: ${path} is a page`);
    if (fragment) assert.ok(panelIds(page).includes(fragment), `${token}: #${fragment} is a panel of ${page}`);
  }
  // Only pages with a form that fixes it: never one that only shows the problem.
  assert.deepEqual(Object.keys(REASON_FIXES).sort(), ["secret-bundle-profile-ambiguous", "secret-bundle-profile-unknown", "secret-profile-unknown"]);
});

test("a refusal this console can fix, on its own host, shows an operator where, beside the catalog's own words, which stay", () => {
  const view = ({ role = "operator", host = "mini1", self = "mini1", readOnly = false } = {}) => ({ role, readOnly, env: {}, query: { id: "gh-1" }, data: { selfHost: self, run: { record: { v: 1, jobId: "gh-1", outcome: "refused", reason: "secret-profile-unknown", host, startedAt: "2026-10-24T11:00:00.000Z", endedAt: "2026-10-24T11:00:01.000Z" } } } });
  const operator = String(runOutcome(view()));
  assert.match(operator, /href="\/config\/secrets#p-secret-add"[^>]*>[^]*Declare it on Secrets/);
  assert.ok(operator.includes("to see which profiles it has"), "the catalog's next step is still there, word for word");
  for (const [what, v] of [["a viewer", view({ role: "viewer" })], ["another host's run", view({ host: "build3" })], ["no host of its own", view({ self: null })], ["a read-only console", view({ readOnly: true })]]) {
    assert.doesNotMatch(String(runOutcome(v)), /Declare it on Secrets/, what);
  }
});

test("a step another host's doctor judged keeps its command in view, since /setup works on this console's host", async () => {
  const { firstRun: build } = await import("./helpers/panel-goldens.mjs");
  const base = build();
  const snapshot = { ...base, doctorSelf: "mini1", doctor: { ...(base.doctor ?? {}), hosts: [{ name: "build3", ageMs: 1000, counts: { fail: 1, warn: 0, ok: 0 }, checks: [{ id: "egress-proxy", level: "fail", label: "the egress proxy is not running" }] }] } };
  const state = firstRunState(snapshot, { session: { role: "operator" }, deployment: { folder: "pi-dispatch" } });
  const egress = state.steps.find((st) => st.id === "egress");
  assert.equal(egress.host, "build3", "the step carries the host whose doctor judged it");
  const parsed = parsePageQuery("overview", "");
  const data = await loadPageData("overview", parsed.query, { fleet: { snapshot: async () => snapshot }, now: () => NOW, deployment: { folder: "pi-dispatch" }, setupGranted: () => true }, { role: "operator" });
  const html = String((await renderPage("overview", { query: parsed.query, session: { name: "ops", role: "operator" }, data, readOnly: false, theme: null, flash: null, maxStreams: 4 })).html);
  const mine = steps(html).find((d) => d.includes(egress.title));
  assert.doesNotMatch(mine, /Do this on Set up/);
  assert.match(mine, /<span>pi-dispatch<\/span> <span>doctor<\/span>/, "its command in view");
});

// The spec audit's round 1 (issue #849, part 6).

test("SETUP_DOES_STEPS is exactly the steps /setup does: never the GitHub App, pi's own setup, or the viewer token", () => {
  assert.deepEqual([...SETUP_DOES_STEPS], ["worker", "egress", "provider"]);
});

test("each first-run step another host's doctor judged carries that host, on every branch that can", () => {
  const row = (name, checks) => ({ name, ageMs: 1000, counts: {}, checks });
  const base = firstRun();
  const judged = (rows, extra = {}) => firstRunState({ ...base, doctorSelf: "mini1", doctor: { hosts: rows, more: 0 }, ...extra }, { session: { role: "operator" }, deployment: { folder: "x" } });
  const st = judged([row("build3", [{ id: "egress.proxy", level: "fail", label: "the egress proxy is not running" }, { id: "provider.key", level: "fail", label: "no provider key" }])]);
  assert.equal(st.steps.find((x) => x.id === "egress").host, "build3", "a failing egress check");
  assert.equal(st.steps.find((x) => x.id === "provider").host, "build3", "a failing provider check");
  const stale = firstRunState({ ...base, doctorSelf: "mini1", hostBudgets: [{ name: "build3", staleMs: 3600000 }] }, { session: { role: "operator" }, deployment: { folder: "x" } });
  const worker = stale.steps.find((x) => x.id === "worker");
  assert.deepEqual([worker.state, worker.host], ["check", "build3"], "a stale worker");
});

test("the Fleet card offers doctor from Set up on this console's own host's row only, and keeps every row's command", () => {
  const row = (name) => ({ name, ageMs: 1000, counts: { fail: 1, warn: 0, ok: 0 }, checks: [{ id: "node.1", level: "fail", label: "x" }] });
  const html = String(fleetDoctor({ role: "operator", readOnly: false, data: { setupGranted: true, snapshot: { doctorSelf: "mini1", doctor: { hosts: [row("mini1"), row("mini2")], more: 0 }, hostBudgets: [] } } }));
  const blocks = html.split('<div class="fl-doc">').slice(1);
  const mine = blocks.find((b) => b.includes(">mini1<"));
  const other = blocks.find((b) => b.includes(">mini2<"));
  assert.match(mine, /Run doctor from Set up/);
  assert.match(mine, /<span>pi-dispatch<\/span> <span>doctor<\/span>/, "the command stays beside the link");
  assert.doesNotMatch(other, /Run doctor from Set up/);
  assert.match(other, /<span>pi-dispatch<\/span> <span>doctor<\/span>/);
});

test("the host page offers doctor from Set up only when it is this console's own host", () => {
  const view = (name) => ({ role: "operator", readOnly: false, query: { name }, data: { setupGranted: true, snapshot: { doctorSelf: "mini1" } } });
  assert.match(String(hostDoctor(view("mini1"))), /Run doctor from Set up/);
  assert.doesNotMatch(String(hostDoctor(view("mini2"))), /Run doctor from Set up/);
});

test("the overview, Fleet and host pages read the grant, and the run page its host, from the deps serve gives them", async () => {
  for (const name of ["overview", "fleet", "host"]) {
    const parsed = parsePageQuery(name, name === "host" ? "name=mini1" : "");
    const data = await loadPageData(name, parsed.query, { fleet: { snapshot: async () => firstRun() }, now: () => NOW, setupGranted: () => true }, { role: "operator" });
    assert.equal(data.setupGranted, true, name);
  }
  const parsed = parsePageQuery("run", "id=gh-1");
  const run = await loadPageData("run", parsed.query, { fleet: { snapshot: async () => ({}), runById: async () => null, runsPage: async () => ({ rows: [] }), parkedCount: async () => 0 }, now: () => NOW, selfHost: () => "mini1" }, { role: "operator" });
  assert.equal(run.selfHost, "mini1");
});
