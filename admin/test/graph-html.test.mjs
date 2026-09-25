import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildGraphScene, clip, clipColumns, GRAPH_HTML_KINDS, GLYPH, labelColumns, PAGE_JS } from "../src/graph-html.mjs";
import { columnsOf } from "../src/panel.mjs";
import { buildInsightsHtml } from "../src/insights-html.mjs";
import { buildGraphModel, findLoopHints, GRAPH_EDGE_KINDS, GRAPH_NODE_KINDS, parseSkillMeta } from "../src/graph-model.mjs";

const NOW = 1770000000000;

// Since issue #279 this suite pins graph-html.mjs's SHIPPING surface: the scene builder, the shared
// escaping/theme/script pieces, and the layout invariants. `buildGraphHtml` (the standalone topology
// page, command-less since #181) is deleted, so every page-level pin here drives the page that can
// still emit these bytes -- `buildInsightsHtml`, whose lower half IS this scene. A fold-less payload
// renders the topology whole (the degrade contract insights-html.test.mjs pins), which keeps these
// tests about the topology and nothing else. Pins that duplicate an insights-html.test.mjs twin
// byte-for-byte (permutation determinism, well-formedness, the redaction canary, the file:// needle
// list, the reload contract) were dropped here rather than retargeted -- one pin per property, on
// the surface that ships.

// The same canned deployment graph-model.test.mjs uses, built THROUGH buildGraphModel: the scene
// generator's contract is the assembler's output shape, so hand-rolled model literals would pin
// this suite to a shape the assembler might stop producing.
const CANNED = () => ({
  triggers: {
    triggers: [
      { type: "cron", index: 0, id: "nightly", pattern: "0 3 * * *", folder: "/srv/site", flow: "build-report", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false },
      { type: "label", index: 1, any: ["ai"], all: [], none: [], flow: "triage", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" },
      { type: "cron", index: 2, id: "gone", pattern: "0 4 * * *", folder: "/srv/site", flow: "deleted-flow", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false },
    ],
  },
  schedulers: [{ key: "nightly", name: "nightly", pattern: "0 3 * * *", every: null, next: "2026-08-12T03:00:00.000Z", overdueMs: null }],
  folderSkills: {
    "/srv/site": {
      head: "abc123",
      truncated: false,
      unreachable: null,
      skills: [
        { name: "build-report", isSub: false, group: null, aiTrigger: true, meta: { name: "build-report", description: "d" }, mentions: [{ name: "notify", strong: true }], loops: [{ hint: "until the report renders right" }], unread: false },
        { name: "notify", isSub: false, group: null, aiTrigger: true, meta: null, mentions: [], unread: false },
        { name: "old-import", isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], unread: false },
        { name: "group/sub", isSub: true, group: "group", aiTrigger: false, meta: null, mentions: [], unread: false },
        { name: "group", isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], unread: false },
      ],
    },
  },
  injectedSkills: { "/inj": { skills: [{ name: "tidy", aiTrigger: true }], truncated: false, unreachable: null } },
  // Known-empty tier reads (issue #188), mirroring graph-model.test.mjs: a session that can see the
  // global pi dir and finds both tiers empty keeps `deleted-flow` a KNOWN miss, so the red dangling
  // pins below stay meaningful. Absent keys would soften it to the amber not-at-head state.
  overlaySkills: { skills: [], truncated: false, unreachable: null },
  stagedSkills: { skills: [], unenumerable: [], truncated: false },
  forgeRepos: { github: ["acme/website", "acme/api"] },
  cronStats: { byId: { nightly: { runs: 41, lastOutcome: "completed", lastEndedAt: "2026-08-11T00:00:00.000Z" }, gone: { runs: 0, lastOutcome: null, lastEndedAt: null } } },
  runJoin: { byIndex: { 1: { runs: 12, lastOutcome: "completed", lastEndedAt: "2026-08-11T01:00:00.000Z" } }, unattributed: 2 },
  chainEdges: { edges: [{ parentFlow: "build-report", childFlow: "notify", target: "local:site", count: 3, lastEndedAt: "2026-08-10T00:00:00.000Z" }], refusals: { "build-report": 1 }, truncated: false },
  caps: { chainDepthMax: 1, chainMaxPerJob: 2, windowDays: 30 },
  nowMs: NOW,
});

// The scene's layout half, reached the way production reaches it. `layoutGraph` (a wrapper only
// tests ever called) is deleted; the scene result's `layout` is the same layoutNormalized output.
const layoutOf = (model) => buildGraphScene(model, { now: NOW }).layout;

// The LIVE page around a topology model: a fold-less insights payload renders the whole scene, the
// legend and the banners -- the exact composition the panel writes to disk minus the cost half.
const pageOf = (model, opts = {}) => buildInsightsHtml({ graph: model, fold: null, costsUnreachable: null, window: "30d", costByTrigger: null }, { now: NOW, ...opts });
const cannedPage = () => pageOf(buildGraphModel(CANNED()));

// ---- 1. purity ----

test("graph-html.mjs is fully pure: no module loads, no clock, no randomness, no environment", () => {
  // FIRST, per the render.mjs/costs.mjs/graph-model.mjs doctrine. The bans are substring-level on
  // purpose: the page script embedded in this module is still module source, so even IT may not
  // spell the static clock accessor (it reads the clock via new Date().getTime() instead).
  const src = readFileSync(fileURLToPath(new URL("../src/graph-html.mjs", import.meta.url)), "utf8");
  assert.ok(!src.includes("import"), "no module loads of any kind, not even node: builtins");
  assert.ok(!src.includes("require("), "no CJS loads either");
  assert.ok(!src.includes("Date.now"), "the generation instant is injected as `now`, never read");
  assert.ok(!src.includes("Math.random"), "determinism is insights-html.test.mjs's byte-identity pin");
  assert.ok(!/process\./.test(src), "no environment access");
  // The #279 deletion pins: an export nothing outside this module's own test calls must not creep
  // back, and neither may a page assembly the insights page composes for itself.
  assert.ok(!src.includes("buildGraphHtml"), "the caller-less page builder stays deleted");
  assert.ok(!src.includes("layoutGraph"), "and so does the test-only layout wrapper");
  assert.ok(!src.includes("<!doctype"), "graph-html emits scene pieces, never a whole document");
});

// ---- 2. kind parity ----

test("GRAPH_HTML_KINDS is the assembler's GRAPH_EDGE_KINDS, byte for byte, frozen", () => {
  // The HTML module may not use the `from` clause, so this test IS the anti-drift wire: a kind
  // minted in graph-model without a drawing arm here must go red, not render as nothing.
  assert.deepEqual([...GRAPH_HTML_KINDS], [...GRAPH_EDGE_KINDS]);
  assert.ok(Object.isFrozen(GRAPH_HTML_KINDS));
});

// ---- 3. escaping / breakout (the trigger-side vectors; the cost-side twins live in the insights suite) ----

test("hostile trigger and flow strings cannot break out of markup or the embedded json", () => {
  const inputs = CANNED();
  // The comment phrase lands verbatim in the trigger's display label; the flow name fails
  // SKILL_NAME_RE so it travels the charset-invalid path into a node name and a flag detail.
  inputs.triggers.triggers.push({ type: "comment", index: 3, phrase: '"><script>alert(1)</script>', any: [], all: [], none: [], flow: "x", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" });
  inputs.triggers.triggers.push({ type: "cron", index: 4, id: "evil", pattern: "0 5 * * *", folder: "/srv/site", flow: "</script><script>evil()", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false });
  const out = pageOf(buildGraphModel(inputs));

  assert.equal(out.split("<script").length - 1, 1, "exactly ONE script open tag: the page's own");
  assert.equal(out.split("</script").length - 1, 1, "and exactly one close: nothing embedded can spell it");
  assert.ok(!out.includes("<script>alert"), "the attack string never appears unescaped");
  assert.ok(out.includes("&lt;script&gt;") || out.includes("&lt;/script&gt;"), "it appears as entities instead");
  assert.ok(out.includes("\\u003c"), "the embedded json carries < as an escape, never a literal");
});

// ---- 4. layout invariants ----

test("the scene layout: finite coords, left-to-right wires, group containment, no overlaps", () => {
  const layout = layoutOf(buildGraphModel(CANNED()));
  assert.ok(layout.nodes.length > 0 && layout.wires.length > 0 && layout.groups.length > 0);

  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const groups = new Map(layout.groups.map((g) => [g.id, g]));
  for (const n of layout.nodes) {
    for (const v of [n.x, n.y, n.w, n.h]) assert.ok(Number.isFinite(v), `non-finite coord on ${n.id}`);
    const g = groups.get(n.groupId);
    assert.ok(g, `node ${n.id} has no group`);
    assert.ok(n.x >= g.x && n.y >= g.y && n.x + n.w <= g.x + g.w && n.y + n.h <= g.y + g.h, `node ${n.id} escapes its group rect`);
  }
  for (const w of layout.wires) {
    if (!["config", "observed", "potential"].includes(w.kind)) continue;
    if (w.self) continue; // the explicit self-loop is the one sanctioned non-forward route
    const f = byId.get(w.from);
    const t = byId.get(w.to);
    assert.ok(f && t, `wire ${w.id} references a missing node`);
    assert.ok(f.x + f.w <= t.x, `wire ${w.id} (${w.kind}) does not travel left to right`);
  }
  for (let i = 0; i < layout.nodes.length; i++) {
    for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i];
      const b = layout.nodes[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `nodes ${a.id} and ${b.id} overlap`);
    }
  }
  for (const v of [layout.viewBox.x, layout.viewBox.y, layout.viewBox.w, layout.viewBox.h]) assert.ok(Number.isFinite(v));
  assertUnderRoutesClearChips(layout);
});

// The regression the first shipped layout had: ROW_GAP alone under a row with a self-loop put the
// cron-rearm label INSIDE the next row's chip (CANNED's two same-folder cron triggers reproduce it
// exactly). No wire label point may sit inside any chip, and the horizontal run of an under-row
// route (self or back; it sits 12px above the label) may not cross any chip either.
function assertUnderRoutesClearChips(layout) {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const inside = (x, y, n) => x > n.x && x < n.x + n.w && y > n.y && y < n.y + n.h;
  for (const w of layout.wires) {
    for (const n of layout.nodes) {
      assert.ok(!inside(w.labelX, w.labelY, n), `label of wire ${w.id} (${w.kind}) sits inside node ${n.id}`);
    }
    if (!w.self && !w.back) continue;
    const f = byId.get(w.from);
    const t = byId.get(w.to);
    const runY = w.labelY - 12;
    const lo = Math.min(t.x, f.x + f.w);
    const hi = Math.max(t.x, f.x + f.w);
    for (const n of layout.nodes) {
      const crosses = runY > n.y && runY < n.y + n.h && hi > n.x && lo < n.x + n.w;
      assert.ok(!crosses, `under-row run of wire ${w.id} crosses node ${n.id}`);
    }
  }
}

test("parallel wires between one pair separate their curves and labels, and no label sits on a port", () => {
  // The regression: an observed edge and a potential mention both join build-report -> notify, and
  // both labels rendered at the same midpoint -- "(3×)" and "mention" garbled into one smear.
  const layout = layoutOf(buildGraphModel(CANNED()));
  const byPair = new Map();
  for (const w of layout.wires) {
    const key = `${w.from} ${w.to}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(w);
  }
  const multi = [...byPair.values()].filter((list) => list.length > 1);
  assert.ok(multi.length >= 1, "CANNED must exercise the shared-pair case (observed + potential)");
  for (const list of multi) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const gap = Math.hypot(list[i].labelX - list[j].labelX, list[i].labelY - list[j].labelY);
        assert.ok(gap >= 10, `label anchors of ${list[i].id} and ${list[j].id} are only ${gap}px apart`);
        assert.notEqual(list[i].d, list[j].d, `wires ${list[i].id} and ${list[j].id} overlay exactly`);
      }
    }
  }
  // No label anchor inside any port square -- conservatively both squares of every node, drawn or
  // not: input at (x-5, y+10), output at (x+w-5, y+10), 10x10 each.
  for (const w of layout.wires) {
    for (const n of layout.nodes) {
      for (const px of [n.x - 5, n.x + n.w - 5]) {
        const inPort = w.labelX > px && w.labelX < px + 10 && w.labelY > n.y + 10 && w.labelY < n.y + 20;
        assert.ok(!inPort, `label of wire ${w.id} sits on a port square of node ${n.id}`);
      }
    }
  }
});

test("a mention cycle marks one back edge and routes it under the rows without crossing chips", () => {
  const inputs = CANNED();
  // notify already receives a mention from build-report; mentioning back closes the cycle.
  inputs.folderSkills["/srv/site"].skills[1].mentions = [{ name: "build-report", strong: false }];
  const layout = layoutOf(buildGraphModel(inputs));
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const potentials = layout.wires.filter((w) => w.kind === "potential" && !w.self);
  assert.equal(potentials.length, 2, "both sides of the cycle draw");
  assert.equal(potentials.filter((w) => w.back).length, 1, "exactly one side is the back edge -- a rank function cannot satisfy both");
  for (const w of potentials.filter((w) => !w.back)) {
    const f = byId.get(w.from);
    const t = byId.get(w.to);
    assert.ok(f.x + f.w <= t.x, "the forward side still travels left to right");
  }
  assertUnderRoutesClearChips(layout);
});

// ---- 4c. loop-in-skill groups ----

test("a skill with loops becomes a group: chip inside the box, marker with hint, ring inside, ports untouched", () => {
  const layout = layoutOf(buildGraphModel(CANNED()));
  const sg = layout.skillGroups.find((s) => s.label === "build-report");
  assert.ok(sg, "a prose-loop hint promotes the skill to a group box");
  const chip = layout.nodes.find((n) => n.id === sg.nodeId);
  assert.ok(
    chip.x >= sg.x && chip.y >= sg.y && chip.x + chip.w <= sg.x + sg.w && chip.y + chip.h <= sg.y + sg.h,
    "the skill's own chip sits INSIDE its group box",
  );
  assert.equal(sg.markers.length, 1, "one marker per loop hint");
  assert.equal(sg.markers[0].hint, "until the report renders…", "the hint rides the marker, clipped");
  for (const [x, y] of sg.points) {
    assert.ok(x >= sg.x && x <= sg.x + sg.w && y >= sg.y && y <= sg.y + sg.h, "every loop-wire point stays inside the box");
  }
  // Containment is visual only: external wires keep leaving the CHIP's output port, not the box.
  const outgoing = layout.wires.filter((w) => w.from === chip.id && !w.self);
  assert.ok(outgoing.length >= 2, "the observed edge and the potential mention still leave build-report");
  for (const w of outgoing) {
    assert.ok(w.d.startsWith(`M ${chip.x + chip.w} ${chip.y + 15} `), `wire ${w.id} must leave the chip's output port`);
  }
  const folder = layout.groups.find((f) => f.id === sg.groupId);
  assert.ok(
    sg.x >= folder.x && sg.y >= folder.y && sg.x + sg.w <= folder.x + folder.w && sg.y + sg.h <= folder.y + folder.h,
    "the group box itself stays inside its folder rect",
  );
});

test("sub-skills nest inside the parent's group box as small unwired chips", () => {
  const layout = layoutOf(buildGraphModel(CANNED()));
  const sg = layout.skillGroups.find((s) => s.label === "group");
  assert.ok(sg, "owning a sub-skill promotes the parent to a group box even without loops");
  const sub = layout.nodes.find((n) => n.node.name === "group/sub");
  assert.ok(sg.subIds.includes(sub.id), "the sub chip belongs to its parent's group");
  assert.equal(sub.nested, true);
  assert.ok(
    sub.x >= sg.x && sub.y >= sg.y && sub.x + sub.w <= sg.x + sg.w && sub.y + sub.h <= sg.y + sg.h,
    "the sub chip sits inside the parent's box",
  );
  assert.equal(layout.wires.filter((w) => w.from === sub.id || w.to === sub.id).length, 0, "sub chips are unwired");
});

test("the page carries the group visuals and the forge scope line", () => {
  const out = cannedPage();
  assert.ok(out.includes('class="sgroup"'), "skill group boxes render");
  assert.ok(out.includes(">⟳</text>"), "the loop marker glyph renders");
  assert.ok(out.includes("until the report renders…"), "the clipped hint text renders beside the marker");
  assert.ok(
    out.includes("github · ran against acme/website, acme/api · forge · unverifiable from this host"),
    "forge groups state their record-derived repo scope and keep the unverifiable note",
  );

  // Empty repos leave the label exactly as before -- absence of history must not invent scope.
  const inputs = CANNED();
  delete inputs.forgeRepos;
  const bare = pageOf(buildGraphModel(inputs));
  assert.ok(bare.includes("github · forge · unverifiable from this host"));
  assert.ok(!bare.includes("ran against"));
});

// ---- 5. state twins ----

test("orphan dash, potential-vs-observed labels, the caps digits, and honesty counters", () => {
  const out = cannedPage();
  // CANNED holds exactly two orphans (old-import, and group: no trigger, no ai-trigger, no
  // mention): those two chips plus the one legend swatch carry the disabled treatment, and the
  // exact count is the negative claim -- no non-orphan chip may wear it.
  assert.equal((out.match(/stroke-dasharray="8,3"/g) ?? []).length, 3, "two orphan chips and the one legend swatch, nothing else");
  // The observed label carries the count and, when the fold recorded one, the recency (issue #175):
  // "chained 2 times, 2d ago" and "chained 2 times, months back" are different topologies to a reader.
  assert.equal((out.match(/\(\d+×( · \d+[smhd] ago)?\)/g) ?? []).length, 1, "one observed edge, one count label; a potential wire NEVER carries a count");
  assert.match(out, /\(\d+× · \d+[smhd] ago\)/, "the canned observed edge has a lastEndedAt, so its label says how fresh it is");
  assert.ok(out.includes(">mention</text>"), "a potential wire is labelled mention instead");
  assert.ok(out.includes("chains: depth ≤ 1 · ≤ 2 per job · same folder only · window 30d"), "the caps line renders the model's exact digits");
  assert.ok(out.includes("2 runs unattributed"), "honesty counters render when set");

  const dropped = buildGraphModel(CANNED());
  dropped.meta.droppedObservedEdges = 4;
  assert.ok(pageOf(dropped).includes("4 observed edges dropped"), "dropped-edge counter renders when set");

  // Schedule facts in the tips (issue #181): with the terminal views gone this page is the last
  // surface REQ-TOPOLOGY-GRAPH (h) has. The canned scheduler's next fire sits 191 days past NOW.
  assert.ok(out.includes("next 191d"), "a cron tip counts down to the resident scheduler's next fire");
  const overdue = buildGraphModel(CANNED());
  const cron = overdue.nodes.find((n) => n.id === "trigger:0");
  cron.overdueMs = 2 * 3600_000;
  assert.ok(pageOf(overdue).includes("overdue 2h"), "overdue outranks the countdown");

  // The two counters the text and TUI surfaces always stated and this page dropped (issue #175):
  // three surfaces of one model must not disagree about what was refused or unreadable.
  assert.ok(out.includes("1 chain requests refused (caps or gate)"), "the canned refusals reach the legend");
  const unreadable = buildGraphModel(CANNED());
  unreadable.meta.injectedUnreachable = ["/inj"];
  assert.ok(pageOf(unreadable).includes("injected skills dir unreadable: /inj"), "the unreadable-dir counter renders when set");
});

test("graphData neighbour and wire lists are canonically sorted -- the embedded json is byte contract, not just behaviour", () => {
  // The gate's executing review measured this one: dropping the nb sort changes the shipped page's
  // bytes on the canned fixture (n1 emits ["n8","n5"]) while every behavioural test stays green,
  // because PAGE_JS consumes the lists by membership alone. "Same model, same now, byte-identical
  // forever" is the module's own promise, so canonical order is pinned directly rather than left to
  // luck. The fan-out hub exists for the `w` half of the pin: wire ids are minted w0, w1, ... and
  // sorted LEXICOGRAPHICALLY, so insertion order and sorted order only diverge once ids cross the
  // two-digit boundary -- on the bare canned model they never do, and the w pin would be vacuous.
  const inputs = CANNED();
  inputs.folderSkills["/srv/site"].skills.push(
    { name: "hub", isSub: false, group: null, aiTrigger: false, meta: null, mentions: Array.from({ length: 11 }, (_, i) => ({ name: `spoke-${i}`, strong: false })), unread: false },
    ...Array.from({ length: 11 }, (_, i) => ({ name: `spoke-${i}`, isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], unread: false })),
  );
  const { graphData } = buildGraphScene(buildGraphModel(inputs), { now: NOW });
  let multi = 0;
  for (const [id, n] of Object.entries(graphData.nodes)) {
    if (n.nb.length > 1) multi += 1;
    assert.deepEqual(n.nb, [...n.nb].sort(), `nb of ${id} must be in sorted order`);
    assert.deepEqual(n.w, [...n.w].sort(), `w of ${id} must be in sorted order`);
  }
  assert.ok(multi >= 2, "the fixture must exercise multi-neighbour nodes, or the nb pin is vacuous");
  assert.ok(
    Object.values(graphData.nodes).some((n) => n.w.some((w) => w.length >= 3) && n.w.some((w) => w.length === 2)),
    "the fixture must cross the two-digit wire-id boundary, or the w pin is vacuous",
  );
});

test("normalization sorts the honesty-counter arrays even when the model's own order does not", () => {
  // The same review's second find: every fixture carried ONE refusal and ONE unreadable dir, so the
  // canonicalization sorts were pinned by nothing -- an object-key-order change upstream would move
  // page bytes with the whole suite green. Two entries, inserted in reverse, pin the sort itself.
  const model = buildGraphModel(CANNED());
  model.meta.chainRefusals = { "zzz-flow": 1, "aaa-flow": 2 };
  model.meta.injectedUnreachable = ["/z-dir", "/a-dir"];
  const { norm } = buildGraphScene(model, { now: NOW });
  assert.deepEqual(norm.meta.chainRefusals.map((r) => r.scope), ["aaa-flow", "zzz-flow"], "chainRefusals sort by scope, never by the model's key order");
  assert.deepEqual(norm.meta.injectedUnreachable, ["/a-dir", "/z-dir"], "unreadable dirs sort, never arrival order");
});

test("an unknown field on a graph NODE never reaches the live page", () => {
  // The deleted suite planted this canary on a node; the insights twin plants its own on fold rows
  // only, so the node-level half of the redaction claim needs its pin back on the page that ships.
  const model = buildGraphModel(CANNED());
  model.nodes[0].secret = "CANARY-9f3";
  const out = pageOf(model);
  assert.ok(!out.includes("CANARY-9f3"), "node fields must be structurally unreachable, not merely unused");
  assert.ok(!pageOf(model, { fullPaths: true }).includes("CANARY-9f3"), "the fullPaths opt-in widens labels, not the allowlist");
});

// ---- 6. page-script hardening, on the exported string itself (the insights suite pins the same
// script IN SITU -- the parse check, the single guarded GRAPH read; these are the expressions whose
// loss would not break a parse, asserted at the source the shipping page embeds verbatim) ----

test("PAGE_JS letterbox-maps the cursor, survives a pan without wiping selection, and guards GRAPH.nodes", () => {
  // meet letterboxing: a uniform scale (min of the two ratios) plus centring offsets; the
  // per-axis ratios this replaced panned at the wrong speed whenever the aspects differed.
  assert.ok(PAGE_JS.includes("Math.min(r.width / vb.width, r.height / vb.height)"), "uniform meet scale");
  assert.ok(PAGE_JS.includes("(r.width - vb.width * s) / 2"), "letterbox x offset");
  assert.ok(PAGE_JS.includes("(r.height - vb.height * s) / 2"), "letterbox y offset");

  // pan-then-click: pointer capture retargets the post-pan click at the svg, which reads as a
  // background click; a drag beyond the threshold must swallow it or every pan clears the selection.
  assert.ok(PAGE_JS.includes("panning.moved > 3"), "drag threshold present");
  assert.ok(PAGE_JS.includes("suppressClick"), "the following click is suppressed");

  // prototype-chain ids: #sel=constructor must die at the guard, not at a .nb dereference.
  assert.ok(PAGE_JS.includes("Object.prototype.hasOwnProperty.call(GRAPH.nodes, id)"), "own-property guard present");
  assert.equal((PAGE_JS.match(/GRAPH\.nodes\[/g) ?? []).length, 1, "exactly one raw indexed read of GRAPH.nodes: the one inside the guard");

  new Function(PAGE_JS); // parse check on the exported string the shipping page embeds verbatim
});

// ---- 7. tier rendering (issue #188) ----

// A tier-bearing deployment: the CANNED base plus one trigger resolving in each non-repo tier, and
// the tier reads that let them resolve.
const TIERED = () => {
  const inputs = CANNED();
  inputs.overlaySkills = { skills: [{ name: "global-flow" }], truncated: false, unreachable: null };
  inputs.stagedSkills = { skills: [{ name: "pkg-flow", package: "@acme/wf", dir: "wf" }], unenumerable: [], truncated: false };
  inputs.triggers.triggers.push(
    { type: "cron", index: 3, id: "inj", pattern: "0 7 * * *", folder: "/srv/site", flow: "tidy", model: null, packages: true, image: null, skillsDir: "/inj", instructions: false, resume: false },
    { type: "cron", index: 4, id: "glob", pattern: "0 8 * * *", folder: "/srv/site", flow: "global-flow", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false },
    { type: "cron", index: 5, id: "pkg", pattern: "0 9 * * *", folder: "/srv/site", flow: "pkg-flow", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false },
  );
  return inputs;
};

test("every GRAPH_NODE_KINDS entry except trigger has its own glyph -- the kind-parity anti-drift wire", () => {
  // graph-html cannot use the `from` clause on graph-model, so this test is where a new node kind
  // without a drawing arm goes red (the GRAPH_HTML_KINDS pattern, applied to kinds).
  for (const kind of GRAPH_NODE_KINDS) {
    if (kind === "trigger") continue; // triggers glyph by onType, pinned by the GLYPH keys below
    assert.ok(typeof GLYPH[kind] === "string" && GLYPH[kind] !== "", `no glyph for node kind ${kind}`);
  }
  for (const onType of ["cron", "label", "comment", "pull_request"]) {
    assert.ok(typeof GLYPH[onType] === "string", `no glyph for trigger onType ${onType}`);
  }
});

test("tier nodes render in their own groups, tips name the tier and stay never-AI-reachable", () => {
  const out = pageOf(buildGraphModel(TIERED()));
  assert.ok(out.includes("overlay skills (global pi dir)"), "the overlay group renders");
  assert.ok(out.includes("staged package skills"), "the staged group renders");
  assert.ok(out.includes("deployment overlay skills/, trigger-reachable, never AI-reachable"), "the overlay tip keeps the reachability half");
  assert.ok(out.includes("staged pi package, trigger-reachable, never AI-reachable"), "the staged tip too");
  assert.ok(out.includes("package @acme/wf"), "the staged tip names the owning package");
  assert.ok(out.includes(">◎</text>") && out.includes(">▣</text>"), "the tier glyphs render in the icon column");
  // The resolved triggers are NOT dangling: the only red chip is CANNED's own deleted-flow.
  assert.equal((out.match(/stroke="#f85149" stroke-width="1" stroke-dasharray="10,4"/g) ?? []).length, 2, "deleted-flow's node and its trigger chip stay the only red pair");
});

test("acceptance (i) end to end: an injected-resolved flow wires trigger to the injected node, unflagged", () => {
  const layout = layoutOf(buildGraphModel(TIERED()));
  const trigger = layout.nodes.find((n) => n.node.id === "trigger:3");
  const injectedChip = layout.nodes.find((n) => n.node.id === "injected:/inj:tidy");
  assert.ok(trigger && injectedChip, "both endpoints place");
  const wire = layout.wires.find((w) => w.kind === "config" && w.from === trigger.id);
  assert.equal(wire.to, injectedChip.id, "the config edge lands on the injected node that already existed");
  assert.ok(!layout.nodes.some((n) => n.node.id === "skill:folder:/srv/site:tidy"), "and no red twin is minted");
});

test("the softened not-at-head state renders amber-dashed with its tiers in the tip; red needs every tier checked", () => {
  const blind = CANNED();
  // A session without PI_GLOBAL_PI_DIR (the deployment pointer cannot carry it): both
  // deployment-wide tiers read as unknown, so deleted-flow softens instead of flagging.
  delete blind.overlaySkills;
  delete blind.stagedSkills;
  const out = pageOf(buildGraphModel(blind));
  assert.ok(out.includes('stroke="#d29922" stroke-width="1" stroke-dasharray="10,4"'), "the amber chip treatment renders");
  assert.equal((out.match(/stroke="#f85149" stroke-width="1" stroke-dasharray="10,4"/g) ?? []).length, 0, "no chip wears the red missing claim");
  assert.ok(out.includes("not committed at HEAD"), "the tip states the one thing the session KNOWS");
  assert.ok(out.includes("not checkable from this session: overlay skills/, staged packages"), "and names what it could not check");
  assert.ok(out.includes(">⋯</text>"), "the softened glyph renders");

  // The twin: with the tier reads wired and empty (CANNED), the same flow is a checked miss -- red.
  const checked = cannedPage();
  assert.equal((checked.match(/stroke="#f85149" stroke-width="1" stroke-dasharray="10,4"/g) ?? []).length, 2, "deleted-flow's node and its trigger chip carry the red");
  assert.ok(!checked.includes("not committed at HEAD"), "no softened tip when every tier was checkable");
});

test("the legend states the tier-aware vocabulary and the tier honesty banners", () => {
  const out = cannedPage();
  assert.ok(out.includes("dangling: absent in every checkable tier or name invalid"), "the dangling row now claims the whole ladder");
  assert.ok(out.includes("not at HEAD: some skill tiers not checkable from this session"), "the softened state has its legend row");

  const troubled = buildGraphModel(TIERED());
  troubled.meta.overlayUnreachable = true;
  troubled.meta.stagedUnenumerable = ["@glob/pkg"];
  const page = pageOf(troubled);
  assert.ok(page.includes("overlay skills dir unreadable (global pi dir)"), "an unreadable overlay banners");
  assert.ok(page.includes("staged packages not enumerable (manifest patterns): @glob/pkg"), "pattern manifests banner instead of being guessed at");
});

test("a command trigger's tip shows the slash command; junk tiersUnknown is filtered at the allowlist", () => {
  const inputs = CANNED();
  inputs.triggers.triggers.push({ type: "comment", index: 3, phrase: "@pi deploy", flow: null, command: "deploy prod", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" });
  const out = pageOf(buildGraphModel(inputs));
  assert.ok(out.includes("command: /deploy prod"), "the tip is the detail surface, so the whole staged line shows");

  const soft = buildGraphModel((() => { const b = CANNED(); delete b.overlaySkills; delete b.stagedSkills; return b; })());
  const target = soft.nodes.find((n) => n.kind === "skill-not-at-head");
  target.tiersUnknown = [42, null, "CANARY-TIER-x9"];
  const page = pageOf(soft);
  assert.ok(page.includes("not checkable from this session: CANARY-TIER-x9"), "string entries survive the allowlist; the junk beside them does not");
});

test("a permuted tier-bearing model does not move a byte of the live page", () => {
  const model = buildGraphModel(TIERED());
  const permuted = buildGraphModel(TIERED());
  permuted.nodes.reverse();
  permuted.edges.reverse();
  permuted.flags.reverse();
  permuted.folders.reverse();
  assert.equal(pageOf(permuted), pageOf(model));
});

// ---- 8. one-shot rendering (#231) ----

// The CANNED base plus the two states of a one-shot close rule: armed (once, no mark) and spent
// (the worker's disarmed mark, whose jobId must never reach the page).
const SHOT = () => {
  const inputs = CANNED();
  inputs.triggers.triggers.push(
    { type: "issue", index: 3, action: ["closed"], number: 40, once: true, flow: "triage", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" },
    { type: "issue", index: 4, action: ["closed"], number: 41, once: true, disarmed: { at: "2026-08-20T09:00:00Z", jobId: "CANARY-JOB-77" }, flow: "triage", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" },
  );
  return inputs;
};

test("a spent one-shot fades like a disabled chip, both tips state the state, and the disarm jobId stays server-side", () => {
  const out = pageOf(buildGraphModel(SHOT()));
  assert.ok(out.includes("one-shot (armed)"), "the armed tip says so in words");
  assert.ok(out.includes("one-shot, spent 2026-08-20T09:00:00Z"), "the spent tip carries the disarm instant");
  assert.ok(!out.includes("CANARY-JOB-77"), "the mark's jobId is not page material -- the allowlist carries `at` alone");
  // The disabled treatment: CANNED's two orphan chips + the legend swatch + exactly ONE spent chip.
  assert.equal((out.match(/stroke-dasharray="8,3"/g) ?? []).length, 4, "the spent trigger chip joins the faded-dash treatment; the armed one does not");
  assert.ok(out.includes(">◉</text>"), "the issue trigger glyph renders in the icon column");
  assert.ok(out.includes("action[closed] #41 (spent)"), "the shared label's spent marker reaches the tip");
  assert.ok(out.includes("action[closed] #40"), "the armed label stays the plain match vocabulary");
});

test("junk one-shot shapes die at the allowlist: an unusable disarm instant still reads spent, without leaking", () => {
  const model = buildGraphModel(SHOT());
  const node = model.nodes.find((n) => n.id === "trigger:4");
  node.disarmed = { at: { deep: "junk" }, jobId: "CANARY-J2" };
  const page = pageOf(model);
  assert.ok(page.includes("one-shot, spent"), "the state survives even when the instant does not parse");
  assert.ok(!page.includes("CANARY-J2"), "no field beyond `at` gets through");
  assert.ok(!page.includes("[object Object]"), "a non-string instant degrades to absence, never to Object.prototype.toString");

  const armedJunk = buildGraphModel(SHOT());
  armedJunk.nodes.find((n) => n.id === "trigger:3").once = "yes";
  assert.ok(!pageOf(armedJunk).includes("one-shot (armed)"), "once is a strict boolean at the allowlist");
});

test("a permuted one-shot model does not move a byte of the live page", () => {
  const model = buildGraphModel(SHOT());
  const permuted = buildGraphModel(SHOT());
  permuted.nodes.reverse();
  permuted.edges.reverse();
  permuted.flags.reverse();
  permuted.folders.reverse();
  assert.equal(pageOf(permuted), pageOf(model));
});

// ---- 9. degraded-model banners (the shared bannersHtml, on the page that ships; the null/junk
// payload degrades are insights-html.test.mjs's own section) ----

test("a missing or invalid triggers file banners on the live page", () => {
  const missing = pageOf(buildGraphModel({ triggers: { missing: true } }));
  assert.ok(missing.includes("no triggers file found"));

  const invalid = pageOf(buildGraphModel({ triggers: { invalid: "bad json" } }));
  assert.ok(invalid.includes("triggers file invalid: bad json"));
});

// ---- issue #418: chips are sized and cut in columns, and never through a character ----

test("the chip width estimate is never narrower than the panel's table, on every code point and pair (#418)", () => {
  // THE PARITY WIRE a `from` clause would otherwise be: this module loads nothing, so it carries its own
  // estimate, and the panel's table (itself swept against the renderer) holds it. One-sided on purpose:
  // an over-count makes a chip too wide, an under-count lets its text run out of it. String-level parity
  // is deliberately NOT claimed -- `\u0e48\u0e33` is 2 columns to the panel only because the terminal
  // renderer counts a cluster's base twice, which is not a glyph width.
  let swept = 0;
  let equal = 0;
  let pairs = 0;
  let pairsEqual = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    swept += 1;
    assert.ok(labelColumns(ch) >= columnsOf(ch), `U+${cp.toString(16)}: ${labelColumns(ch)} against ${columnsOf(ch)}`);
    if (labelColumns(ch) === columnsOf(ch)) equal += 1;
    for (const s of [ch + "\ufe0f", ch + "\ufe0f\u20e3"]) {
      pairs += 1;
      assert.ok(labelColumns(s) >= columnsOf(s), `${JSON.stringify(s)}: ${labelColumns(s)} against ${columnsOf(s)}`);
      if (labelColumns(s) === columnsOf(s)) pairsEqual += 1;
    }
  }
  assert.equal(swept, 1112064, "every code point outside the surrogates");
  assert.equal(pairs, 2224128, "and each with U+FE0F and as a keycap");
  // EXACT where the two agree, pinned, because "answer 2 for everything" also satisfies the sweep.
  assert.equal(equal, 185319, "code points estimated at exactly the panel's width");
  // None: U+FE0F counts the code unit it takes here and nothing in the panel's table, on purpose (a mark
  // is never free in this estimate), so every pair is estimated wider than the terminal draws it.
  assert.equal(pairsEqual, 0, "pairs estimated at exactly the panel's width");
});

/** A one-folder topology holding these skill names, laid out the way production lays it out. */
function chipsOf(names, loops = {}) {
  const model = buildGraphModel({
    ...CANNED(),
    triggers: { triggers: [] },
    folderSkills: {
      "/srv/x": {
        head: "abc",
        truncated: false,
        unreachable: null,
        skills: names.map((name) => ({ name, isSub: name.includes("/"), group: name.includes("/") ? name.split("/")[0] : null, aiTrigger: false, meta: null, mentions: [], unread: false, loops: loops[name] ?? [] })),
      },
    },
  });
  return layoutOf(model);
}

test("a chip is sized by columns and cut between clusters, and an ASCII chip is unchanged (#418)", () => {
  const byLabel = new Map(chipsOf([
    "\u4f1a\u793e\u306e\u30b9\u30ad\u30eb",
    "\u4f1a\u793e\u306e\u30b9\u30ad\u30eb\u540d\u524d\u30c6\u30b9\u30c8\u3067\u3059",
    "\u{1f600}".repeat(9),
    "\u{1f1ef}\u{1f1f5}".repeat(9),
    "1\ufe0f\u20e3".repeat(9),
    "\u{1f469}\u200d\u{1f469}\u200d\u{1f467}".repeat(9),
    "build-report-and-more",
    "\u4f1a\u793e\u306e\u30b9\u30ad",
  ]).nodes.map((n) => [n.label, n.w]));
  // Sized for what it draws: six CJK characters were a 100px chip, the minimum, and drew about 84px of
  // text past a 38px label start.
  assert.equal(byLabel.get("\u4f1a\u793e\u306e\u30b9\u30ad\u30eb"), 160, "a CJK name gets the chip its glyphs need");
  // A cut that keeps a wide character spends two columns on the ellipsis: a browser draws it at about
  // 14px, and seven emoji and an ellipsis ended three pixels past a full chip.
  assert.equal(byLabel.get("\u4f1a\u793e\u306e\u30b9\u30ad\u30eb\u2026"), 160, "a long CJK name is cut to six characters and the ellipsis");
  // An emoji is three columns: a browser draws one at 17 to 19px at this size, past two columns' 16,
  // and the selector or joiner in a sequence counts the code unit it takes.
  assert.equal(byLabel.get("\u{1f600}".repeat(4) + "\u2026"), 160, "a run of emoji is cut to four");
  // Between clusters: a flag, a keycap and a family are each one glyph and are kept or dropped whole.
  assert.equal(byLabel.get("\u{1f1ef}\u{1f1f5}".repeat(2) + "\u2026"), 160, "no half flag");
  assert.equal(byLabel.get("1\ufe0f\u20e3".repeat(3) + "\u2026"), 160, "no keycap without its key");
  assert.equal(byLabel.get("\u{1f469}\u200d\u{1f469}\u200d\u{1f467}\u2026"), 160, "no family without its child");
  // And a chip NARROWER than the cap is sized for what it holds: ten columns, 38 + 10 * 8 + 12 on the
  // 20px grid.
  assert.equal(byLabel.get("\u4f1a\u793e\u306e\u30b9\u30ad"), 140, "five CJK characters take a 140px chip");
  // An ASCII cut is what it always was: fourteen characters and the ellipsis.
  assert.equal(byLabel.get("build-report-a\u2026"), 160, "an ASCII name is cut exactly where it was");
});

test("a sub chip and a loop hint are cut in columns too, and ASCII ones are unchanged (#418)", () => {
  const layout = chipsOf(["grp", "grp/a-long-ascii-sub-skill-name", "loopy"], {
    loopy: [{ hint: "until \u4f1a\u793e\u306e\u30b9\u30ad\u30eb\u540d\u524d\u30c6\u30b9\u30c8\u3067\u3059" }],
  });
  const sub = layout.nodes.find((n) => n.label.startsWith("grp/"));
  // 131 is what the sub chip measured before issue #418: `U+2026` counts one column, like the character
  // it replaced in the old code-unit count, so an ASCII page does not move a pixel.
  assert.equal(sub.label, "grp/a-long-ascii\u2026");
  assert.equal(sub.w, 131, "the ASCII sub chip is the width it always was");
  // A CJK sub chip is cut to what its 11px text can hold and sized for it: sixteen code units were
  // twelve CJK characters in a chip sized for seventeen narrow ones.
  const cjk = chipsOf(["grp", "grp/\u4f1a\u793e\u306e\u30b9\u30ad\u30eb\u540d\u524d\u30c6\u30b9\u30c8\u3067\u3059"]).nodes.find((n) => n.label.startsWith("grp/"));
  assert.equal(cjk.label, "grp/\u4f1a\u793e\u306e\u30b9\u30ad\u2026");
  assert.equal(cjk.w, 124, "twelve pixels of padding and sixteen columns at seven, the ellipsis costing two");
  const hint = layout.skillGroups.find((s) => s.label === "loopy").markers[0].hint;
  assert.equal(hint, "until \u4f1a\u793e\u306e\u30b9\u30ad\u30eb\u540d\u524d\u2026", "the hint is cut at 24 columns, the ellipsis costing two after a wide character");
});

test("the column cut at its edges: odd budgets, a zero-width character at the cut, mixed widths (#418)", () => {
  // An ODD budget, where one column is left over for a narrow ellipsis and not for a wide one.
  assert.equal(clipColumns("a\u4f1a\u793e\u306e\u30b9\u30ad\u30eb\u540d\u524d", 14), "a\u4f1a\u793e\u306e\u30b9\u30ad\u30eb\u2026");
  // A zero-width space at the cut is a column of its own here (a format character is never free in this
  // estimate), so the cut after the sixth CJK character is where the ellipsis's two columns start.
  assert.equal(clipColumns("\u4f1a\u793e\u306e\u30b9\u30ad\u30eb\u540d\u200bxyz", 14), "\u4f1a\u793e\u306e\u30b9\u30ad\u30eb\u2026");
  // The first cluster that does not fit ENDS the cut: a narrower one after it is not taken instead.
  assert.equal(clipColumns("aaaaaaaaaaaaa\u4f1abb", 14), "aaaaaaaaaaaaa\u2026");
  // A trigger chip is cut the same way as a skill chip.
  const model = buildGraphModel({
    ...CANNED(),
    triggers: { triggers: [{ type: "cron", index: 0, id: "\u4f1a\u793e\u306e\u591c\u9593\u30d3\u30eb\u30c9\u51e6\u7406", pattern: "0 3 * * *", folder: "/srv/site", flow: "build-report", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false }] },
  });
  const trigger = layoutOf(model).nodes.find((n) => n.kind === "trigger");
  assert.equal(trigger.label, "\u4f1a\u793e\u306e\u591c\u9593\u30d3\u2026", "a trigger's chip label is cut in columns too");
});

test("a data cap never leaves half a character, and neither does the folder's HEAD (#418)", () => {
  // `clip` is a CHARACTER cap, by code unit as it always was, but a cap that lands between the two
  // halves of an astral character now gives up the half.
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  // Both ends of the surrogate range, not only the middle of it.
  for (const astral of ["\u{1f600}", "\u{10000}", "\u{10ffff}"]) {
    for (let n = 1; n <= 12; n++) assert.doesNotMatch(clip("x" + astral.repeat(10), n), lone, `a cap at ${n} of ${JSON.stringify(astral)}`);
  }
  assert.equal(clip("abcdef", 3), "abc\u2026", "an ASCII cap is unchanged");
  assert.equal(clipColumns("abc", 3), "abc", "a label that fits is returned as it is");
  const page = pageOf(buildGraphModel({ ...CANNED(), folderSkills: { "/srv/site": { ...CANNED().folderSkills["/srv/site"], head: "abcdef\u{1f600}" } } }));
  assert.doesNotMatch(page, lone, "a HEAD cut to seven units keeps no half character");
  // AND AT THE SOURCE: a loop hint is cut by the phrase scan's own `{0,60}`, which counts code units, so
  // a hint of emoji ended on half of one before the page ever saw it.
  for (let k = 40; k <= 60; k++) {
    for (const { hint } of findLoopHints("until " + "\u{1f600}".repeat(k))) assert.doesNotMatch(hint, lone, `a hint of ${k} emoji`);
  }
  // The half goes before the trim, or a hint cut just after a space keeps the space.
  assert.deepEqual(findLoopHints("until " + "\u{1f600}".repeat(28) + "x \u{1f600}\u{1f600}"), [{ hint: "until " + "\u{1f600}".repeat(28) + "x" }]);
});

test("a cut keeps whole clusters, not only whole surrogate pairs, in every cutter on the page (#418)", () => {
  // A regional indicator alone, a joiner at the end, or a tag sequence without its cancel tag: half a
  // character that is not half a surrogate pair, which repairing the surrogate alone left in a tooltip.
  const broken = (s) => /(^|[^\u{1f1e6}-\u{1f1ff}])(?:[\u{1f1e6}-\u{1f1ff}]{2})*[\u{1f1e6}-\u{1f1ff}](?![\u{1f1e6}-\u{1f1ff}])|\u200d$|\u200d\u2026$/u.test(s);
  const flags = "x" + "\u{1f1f3}\u{1f1f1}".repeat(20);
  const family = "x" + "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}".repeat(10);
  for (let n = 1; n <= 40; n++) {
    assert.ok(!broken(clip(flags, n)), `clip of flags at ${n}: ${JSON.stringify(clip(flags, n))}`);
    assert.ok(!broken(clip(family, n)), `clip of a family at ${n}: ${JSON.stringify(clip(family, n))}`);
  }
  // At the model's own caps: a flow name, and a loop hint the phrase scan cut inside a family.
  const hints = findLoopHints("until " + "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}".repeat(10) + " done");
  assert.ok(hints.length === 1 && !/\u200d$/u.test(hints[0].hint), JSON.stringify(hints));
  // And no chip label drops its old reach for a script whose marks draw: a Devanagari name is cut at the
  // same seven syllables a code-unit cap cut it at, not later.
  assert.equal(clipColumns("\u0915\u093e".repeat(10), 14), "\u0915\u093e".repeat(7) + "\u2026");
  // A CRLF is one cluster of two narrow characters, not a wide one: the ASCII cut is where it was.
  assert.equal(clipColumns("a\r\n" + "b".repeat(29), 20), "a\r\n" + "b".repeat(17) + "\u2026");
});

test("half a pair that ARRIVED in the data never reaches the page either (#418)", () => {
  // Not a cut at all: a record or a trigger field that already holds a lone surrogate. Both sinks, the
  // markup and the embedded JSON, make every string well-formed on the way out.
  const model = buildGraphModel({ ...CANNED(), triggers: { triggers: [{ ...CANNED().triggers.triggers[1], any: ["ai\ud83d"] }] } });
  const page = pageOf(model);
  assert.doesNotMatch(page, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, "no raw half pair");
  assert.doesNotMatch(page, /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i, "and no escaped one");
});

test("the width a chip is sized by, the HEAD it names and the frontmatter it quotes, at their edges (#418)", () => {
  // A chip is sized for what the cut DRAWS: two columns for its ellipsis after a wide character, which a
  // width built from the label's own count left one column short. 38 + 9 * 8 + 12 on the 20px grid.
  const chip = chipsOf(["a\u4f1a\u793e\u{1f468}\u200d\u{1f469}\u200d\u{1f467}"]).nodes.find((n) => n.label.startsWith("a\u4f1a"));
  assert.equal(chip.label, "a\u4f1a\u793e\u2026");
  assert.equal(chip.w, 120, "the ellipsis's second column is in the width");
  // A joiner and a combining mark each count the code unit they take: never free on this page.
  assert.equal(labelColumns("\u200d"), 1);
  assert.equal(labelColumns("\u0301"), 1);
  // The HEAD keeps whole characters: the half an emoji would leave is dropped at the cut, not turned
  // into a replacement character by the sink that makes strings well-formed.
  const page = pageOf(buildGraphModel({ ...CANNED(), folderSkills: { "/srv/site": { ...CANNED().folderSkills["/srv/site"], head: "abcdef\u{1f600}" } } }));
  assert.ok(page.includes("HEAD abcdef<") || page.includes("HEAD abcdef\""), "the HEAD is cut before the emoji");
  assert.ok(!page.includes("\ufffd"), "and nothing on the page is a replacement character");
  // A frontmatter value is cut between clusters at its 120-unit cap: fourteen whole families, not a
  // fifteenth that ends in a joiner and half a pair.
  const meta = parseSkillMeta(`---\nname: x\ndescription: d${"\u{1f468}\u200d\u{1f469}\u200d\u{1f467}".repeat(20)}\n---\nbody`);
  assert.equal(meta.description, "d" + "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}".repeat(14) + "\u2026");
});

test("narrow punctuation costs what it did, and a flow name's half pair is not quoted into a tooltip (#418)", () => {
  // A curly quote or a thin space is one column, as its code unit was: counting it as two cut labels a
  // code-unit count had left whole, and a few that fitted on the old page overflowed.
  assert.equal(clipColumns("MMMMMMMMM\u2019\u2019\u2019", 14), "MMMMMMMMM\u2019\u2019\u2019");
  assert.equal(clipColumns("AAAAAAAAAAAAAAAAAAA\u2019", 20), "AAAAAAAAAAAAAAAAAAA\u2019");
  assert.equal(labelColumns("\u2018\u201c\u2013\u2022\u2009\u202f\u2026"), 7);
  // The wide ones keep two: the em dash and the per-mille sign.
  assert.equal(labelColumns("\u2014\u2030"), 4);
  // A charset-invalid flow is QUOTED into its flag's detail, and `JSON.stringify` writes half a pair as
  // the six characters of its escape, which no sink after it can recognise.
  const model = buildGraphModel({ ...CANNED(), triggers: { triggers: [{ ...CANNED().triggers.triggers[0], flow: "build-report\ud800" }] } });
  const page = pageOf(model);
  assert.doesNotMatch(page, /\\\\ud[89ab][0-9a-f]{2}/i, "no escaped half pair in the tooltip text");
  assert.doesNotMatch(page, /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i, "nor in the embedded JSON");
});
