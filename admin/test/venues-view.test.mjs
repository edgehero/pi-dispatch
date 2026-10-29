import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { stripAnsi, visibleLen } from "../src/style.mjs";
import { CUSTODY_TEXT, DECLARATION_TEXT, GATEWAY_TEXT, OPENSHELL_UNPUBLISHED_TEXT, PROPERTY_LABEL, SERVES_TEXT, venuesView } from "../src/read-model.mjs";
import { pagePanels } from "../src/console/pages.mjs";
import { BACKEND_NAMES, BACKENDS, HOST_GATEWAY_WORDS, PROPERTIES, PROPERTY_NAMES, SERVES, hostBackendsField, parseHostBackends } from "../../worker/src/backends.mjs";

/**
 * The Venues view (issue #712): the console Fleet page's Venues panel and the panel's VENUES view (`v` from HOSTS), from
 * the host rows the snapshot already carries (`hostRowOf`'s parsed `backends`) and the backend table. Its sentence tables
 * are bolted to the worker's vocabularies here, and both surfaces are drawn over hosts that bless different venues.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { makeDashboard } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));

const flush = () => new Promise((resolve) => setImmediate(resolve));
const fakeTui = () => ({ requestRender() {} });
const SGR_THEME = { fg: (_c, t) => `\x1b[38;5;42m${t}\x1b[39m`, bold: (t) => `\x1b[1m${t}\x1b[22m`, bg: (_c, t) => t };
const AT = Date.UTC(2026, 9, 21, 12, 0, 0);
const HOSTILE = "evil\u001b[2J\u009b31m‮name";

/** A host row as `hostRowOf` hands it on: the `backends` field parsed by the worker's own reader. */
const row = (name, field, extra = {}) => ({ name, concurrency: "2", staleMs: 2000, jobs: [], jobsMore: 0, routes: "true", caps: [], backends: field === null ? null : parseHostBackends(field), ...extra });
const ROWS = [
  row("mini1", hostBackendsField({ backends: ["local", "openshell"], backendFloor: { egress: "enforced" }, openshellEngine: "docker", gatewayWord: "local" })),
  row("mini2", hostBackendsField({ backends: ["podman", "openshell-bind"], openshellEngine: "docker", gatewayWord: "remote" })),
  row("old3", null),
];

// ---- the bolts -------------------------------------------------------------------------------------------------------

test("every property, declaration word and gateway word has its sentence, and no sentence names one that does not exist", () => {
  assert.deepEqual(Object.keys(PROPERTY_LABEL).sort(), [...PROPERTY_NAMES].sort(), "a new property must not render as nothing");
  for (const p of PROPERTY_NAMES) {
    assert.ok(PROPERTY_LABEL[p].length > 4 && PROPERTY_LABEL[p].length <= 34, `${p}: a short label that fits the panel's column`);
    assert.ok(PROPERTIES[p].question.length > 10, `${p}: the long form is the table's own question`);
  }
  assert.deepEqual(Object.keys(DECLARATION_TEXT).sort(), ["absent", "asserted", "enforced"]);
  for (const name of BACKEND_NAMES) for (const p of PROPERTY_NAMES) assert.ok(DECLARATION_TEXT[BACKENDS[name].declares[p]], `${name}.${p} declares a word with a sentence`);
  assert.deepEqual(Object.keys(GATEWAY_TEXT).sort(), [...HOST_GATEWAY_WORDS].sort(), "a new gateway word must not render as nothing");
  for (const w of HOST_GATEWAY_WORDS) assert.match(GATEWAY_TEXT[w], /when the worker started/, `${w}: says when it was read`);
});

test("venuesView: every venue in table order, the hosts that bless it and default to it, floors, OpenShell per host, nothing invented", () => {
  const v = venuesView(ROWS);
  assert.deepEqual(v.venues.map((x) => x.name), [...BACKEND_NAMES]);
  const by = Object.fromEntries(v.venues.map((x) => [x.name, x]));
  assert.deepEqual([by.local.blessedOn, by.local.defaultOn], [["mini1"], ["mini1"]]);
  assert.deepEqual([by.podman.blessedOn, by.podman.defaultOn], [["mini2"], ["mini2"]]);
  assert.deepEqual(by.openshell.openshell, [{ host: "mini1", engine: "docker", gateway: "local", modes: ["copy"] }]);
  assert.deepEqual(by["openshell-bind"].openshell, [{ host: "mini2", engine: "docker", gateway: "remote", modes: ["bind"] }]);
  assert.equal(by.local.openshell, null, "only an OpenShell venue has an OpenShell setup");
  assert.deepEqual(v.floors, [{ host: "mini1", floor: { egress: "enforced" } }]);
  assert.deepEqual(v.unpublished, ["old3"], "a worker from before the field is named, never read as blessing local");
  for (const x of v.venues) {
    assert.deepEqual(x.properties.map((p) => p.property), [...PROPERTY_NAMES], x.name);
    for (const p of x.properties) {
      assert.equal(p.word, BACKENDS[x.name].declares[p.property], `${x.name}.${p.property}: the declared word`);
      assert.equal(p.question, PROPERTIES[p.property].question);
      assert.equal(p.wordText, DECLARATION_TEXT[p.word]);
      if (p.word === "asserted") assert.ok(p.assertedBy, `${x.name}.${p.property}: asserted words name their asserter`);
    }
    assert.deepEqual(x.serves.map((s) => [s.key, s.text]), SERVES.map((k) => [k, SERVES_TEXT[k][BACKENDS[x.name].serves[k]]]), x.name);
    assert.equal(x.custodyText, CUSTODY_TEXT[BACKENDS[x.name].credentialCustody ?? "container"]);
  }
  const egress = by.local.properties.find((p) => p.property === "egress");
  assert.deepEqual([egress.armedBy, egress.flooredOn], ["PI_EGRESS", [{ host: "mini1", want: "enforced", have: "enforced", meets: true, blessed: true }]]);
  assert.deepEqual(by.podman.properties.find((p) => p.property === "egress").flooredOn, [{ host: "mini1", want: "enforced", have: "enforced", meets: true, blessed: false }], "every published floor appears, including hosts not blessing this venue");
  assert.equal(by.local.properties.find((p) => p.property === "credentialTransit").observedBy, "dockerEndpointLocal");
  // A venue a newer worker blesses that this build does not know is named with its hosts, not hidden.
  assert.deepEqual(venuesView([row("new1", "blessed=far-venue,local")]).others, [{ name: "far-venue", blessedOn: ["new1"] }]);
  assert.deepEqual(venuesView(undefined).unpublished, []);
});

// ---- the console ----------------------------------------------------------------------------------------------------

const ctxOf = (data) => ({ query: {}, session: { name: "ops", role: "viewer" }, data: { now: AT, env: {}, ...data }, readOnly: false });
const fleetHtml = async (rows) => (await pagePanels("fleet", ctxOf({ snapshot: { queue: { counts: {} }, hostBudgets: rows } }))).map((p) => p.html).join("");

test("Fleet keeps a short venue matrix and details carry questions, asserters, serves and floors", async () => {
  const fleet = await fleetHtml(ROWS);
  assert.match(fleet, /aria-label="Venue properties and what each venue serves"/);
  for (const title of ["Egress", "Local folders", "Steering", "Live transcript", "Recovery", "Credentials held by"]) assert.ok(fleet.includes(title), `${title}: the short Fleet comparison keeps its meaningful columns`);
  assert.match(fleet, /fleet\/venue\?name=openshell-bind/);
  assert.match(fleet, /mini1/);
  for (const name of BACKEND_NAMES) {
    const panels = await pagePanels("venue", { query: { name }, session: { role: "viewer" }, data: { snapshot: { hostBudgets: ROWS }, now: AT } });
    const detail = panels.map((p) => p.html).join("");
    for (const property of PROPERTY_NAMES) assert.ok(detail.includes(PROPERTIES[property].question.replace(/'/g, "&#39;")), `${name}.${property}`);
    assert.match(detail, /What it serves/);
    assert.match(detail, /Compare venues/);
    assert.match(detail, /mini1/);
    for (const p of venuesView(ROWS).venues.find((v) => v.name === name).properties) if (p.assertedBy) assert.ok(detail.includes(p.assertedBy.replace(/'/g, "&#39;")), `${name}.${p.property} asserter`);
  }
});

test("the Venues panel escapes a host's name and never reads one as markup", async () => {
  const html = await fleetHtml([row(`<b>${HOSTILE}</b>`, "blessed=local")]);
  assert.ok(!html.includes("<b>evil"), "escaped");
  assert.doesNotMatch(html, /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/, "no control byte reaches the page");
});

test("the run lists carry the run's venue, local for a record that names none", async () => {
  const runsPage = { runs: [{ jobId: "gh-1", target: "acme/web#1", backend: "openshell", outcome: "completed", endedAt: "2026-10-21T11:00:00Z" }, { jobId: "gh-2", target: "acme/web#2", outcome: "completed", endedAt: "2026-10-21T11:01:00Z" }], next: null };
  const html = (await pagePanels("runs", { ...ctxOf({ runsPage, subscriptions: [] }), query: { filter: {} } })).map((p) => p.html).join("");
  assert.match(html, /<th scope="col" class="hide-phone">Venue<\/th>/);
  assert.match(html, /<td class="hide-phone" data-l="Venue"><span class="vtag">openshell<\/span><\/td>/);
  assert.match(html, /<td class="hide-phone" data-l="Venue"><span class="vtag">local<\/span><\/td>/);
  assert.match(html, /<div class="field"><label for="rf-backend">Venue<\/label><select id="rf-backend" class="select" name="backend">/, "and the filter's list");
});

// ---- the panel ------------------------------------------------------------------------------------------------------

async function openVenues(rows, theme = undefined) {
  const deps = { fetchSnapshot: async () => ({ queue: { counts: {} }, budget: {}, runs: [], hostBudgets: rows }), pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT, capacityInfo: async () => ({ unwired: true }) };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, theme, deps });
  await flush();
  comp.handleInput("u");
  await flush();
  comp.handleInput("v");
  await flush();
  return comp;
}
const textAt = (comp, w) => stripAnsi(comp.render(w).join("\n"));

test("v in HOSTS opens VENUES; arrows select a venue; Esc returns to HOSTS; the footer names v", async () => {
  const comp = await openVenues(ROWS);
  let out = textAt(comp, 100);
  assert.match(out, new RegExp(`venues · ${BACKEND_NAMES.length} known · 3 live hosts`));
  assert.match(out, /› local +mini1\*/, "the cursor on the first venue, the default marked");
  assert.match(out, /podman +mini2\*/);
  assert.match(out, /openshell +blessed on no live host|openshell +mini1/);
  assert.match(out, /not published by old3/);
  assert.match(out, /floor on mini1: egress=enforced/);
  assert.match(out, /egress allowlist +enforced *│\n.*│ +only with PI_EGRESS, floor enforced on mini1/, "marks too wide for the line wrap below it");
  assert.match(out, /jobs cannot reach each other +enforced +only with PI_EGRESS/, "and sit beside the word where they fit");
  assert.match(out, /credentials stay on owned networks +enforced +where observed/);
  for (const [w, t] of Object.entries(DECLARATION_TEXT)) assert.ok(out.replace(/\s*│\s*/g, " ").replace(/\s+/g, " ").includes(`${w}: ${t}`.replace(/\s+/g, " ")), w);
  // Down to openshell-bind: its OpenShell setup per host, and its own words.
  for (let i = 0; i < BACKEND_NAMES.indexOf("openshell-bind"); i++) comp.handleInput("\x1b[B");
  await flush();
  out = textAt(comp, 140);
  assert.match(out, /› openshell-bind/);
  assert.match(out.replace(/ *│\n *│ */g, " "), /mini2: docker engine, bind mode, the gateway was not on this host when the worker started/);
  assert.match(out, /local folders in place +asserted/);
  assert.match(out, /freezable +absent/);
  comp.handleInput("\x1b[B");
  await flush();
  assert.match(textAt(comp, 140), /› openshell-bind/, "the cursor stops at the last venue");
  comp.handleInput("\x1b");
  await flush();
  out = textAt(comp, 100);
  assert.match(out, /hosts · 3 live/, "Esc backs out to HOSTS");
  assert.match(out, /v venues/);
  await comp.dispose();
});

test("every VENUES line fits at 140, 80, 60 and 47 framed and coloured; a hostile host name is text; the degrade is plain", async () => {
  const rows = [...ROWS, row(HOSTILE, "blessed=local,openshell;os=podman:unknown"), row("a".repeat(70), "blessed=podman;floor=nonRoot:enforced")];
  const comp = await openVenues(rows, SGR_THEME);
  for (let sel = 0; sel < BACKEND_NAMES.length; sel++) {
    for (const w of [140, 80, 60, 47]) {
      const lines = comp.render(w);
      for (const l of lines) assert.ok(visibleLen(l) <= w, `venue ${sel}, width ${w}: ${JSON.stringify(stripAnsi(l))} is ${visibleLen(l)} columns`);
      const plain = lines.map(stripAnsi).join("\n");
      assert.doesNotMatch(plain, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/, `width ${w}: no control byte survives`);
      assert.doesNotMatch(plain, /‮/, `width ${w}: the override does not reach the terminal`);
    }
    comp.handleInput("\x1b[B");
    await flush();
  }
  for (const w of [4, 7, NaN]) {
    for (const l of comp.render(w)) {
      assert.doesNotMatch(String(l), /\x1b/, `width ${w}: the degrade emitted an escape`);
      if (Number.isFinite(w)) assert.ok(visibleLen(l) <= w, `width ${w}: ${JSON.stringify(l)}`);
    }
  }
  const nan = comp.render(NaN);
  assert.match(nan[0], /^venues · /);
  assert.equal(nan[nan.length - 1], "↑↓ select · esc back");
  await comp.dispose();
});

test("a row that blesses an OpenShell venue and carries no os part is not published, never the failed-boot sentence", async () => {
  const rows = [row("hand1", "blessed=openshell")];
  assert.deepEqual(venuesView(rows).venues.find((x) => x.name === "openshell").openshell, [{ host: "hand1", engine: null, gateway: null, modes: [], unpublished: true }]);
  const html = await fleetHtml(rows);
  assert.match(html, /hand1: not published/);
  assert.ok(!html.includes(GATEWAY_TEXT.unknown.replace(/'/g, "&#39;")) && !html.includes(GATEWAY_TEXT.unknown), "not the unknown word's sentence");
  const comp = await openVenues(rows);
  comp.handleInput("\x1b[B");
  comp.handleInput("\x1b[B");
  await flush();
  const out = textAt(comp, 100);
  assert.match(out, /hand1: OpenShell setup not published/);
  assert.doesNotMatch(out, /did not answer/);
  await comp.dispose();
});

test("v pressed while the 7-day read runs: the answer lands in VENUES and HOSTS shows it after Esc, with no second read", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let reads = 0;
  const deps = { fetchSnapshot: async () => ({ queue: { counts: {} }, budget: {}, runs: [], hostBudgets: ROWS }), pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT, capacityInfo: async () => (reads++, await gate, { unwired: true }) };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps });
  await flush();
  comp.handleInput("u");
  await flush();
  assert.match(textAt(comp, 100), /reading the last 7 days/);
  comp.handleInput("v");
  await flush();
  release();
  await flush();
  await flush();
  comp.handleInput("\x1b");
  await flush();
  const out = textAt(comp, 100);
  assert.match(out, /hosts · 3 live/);
  assert.doesNotMatch(out, /reading the last 7 days/, "the read that landed in VENUES is the one HOSTS shows");
  assert.match(out, /history not wired/);
  assert.equal(reads, 1);
  await comp.dispose();
});


test("venue floors use the published OpenShell gateway observation and distinguish a non-blessing floor", () => {
  for (const gateway of ["local", "remote", "unknown"]) {
    const hosts = [row("build3", hostBackendsField({ backends: ["local", "openshell"], backendFloor: { credentialTransit: "enforced" }, openshellEngine: "docker", gatewayWord: gateway }))];
    const property = venuesView(hosts).venues.find((v) => v.name === "openshell").properties.find((p) => p.property === "credentialTransit");
    assert.equal(property.flooredOn[0].blessed, true);
    assert.equal(property.flooredOn[0].have, gateway === "local" ? "enforced" : "asserted");
    assert.equal(property.flooredOn[0].meets, gateway === "local");
  }
});
