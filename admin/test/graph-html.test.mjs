import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildGraphScene, clip, clipColumns, drawnColumns, FIT_JS, GRAPH_HTML_KINDS, GLYPH, labelColumns, PAGE_JS, SPEND_BADGE_DY } from "../src/graph-html.mjs";
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
    const runY = Math.max(...pathPoints(w.d).map(([, y]) => y)); // the run is the route's lowest line
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
    out.includes(">github · forge · unverifiable from this host · ran against acme/website, acme/api</text>"),
    "forge groups keep the unverifiable note and state their record-derived repo scope AFTER it: the page cuts a title from its end, and the repo list is what may go (issue #422)",
  );

  // Empty repos leave the label exactly as before -- absence of history must not invent scope.
  const inputs = CANNED();
  delete inputs.forgeRepos;
  const bare = pageOf(buildGraphModel(inputs));
  assert.ok(bare.includes("github · forge · unverifiable from this host"));
  assert.ok(!bare.includes("ran against"));
});

test("an unreachable folder's title names why before where, so a cut takes the path (issue #422)", () => {
  const inputs = CANNED();
  inputs.folderSkills["/srv/site"] = { ...inputs.folderSkills["/srv/site"], unreachable: "folder unreadable", skills: [] };
  const out = pageOf(buildGraphModel(inputs));
  assert.match(out, />folder unreadable · [^<]*site<\/text>/, "the reason first, then the folder");
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
  // code-unit count had left whole, and a few that fitted on the old page overflowed. The nine M's still
  // draw wider than nine columns; the static estimate lets them through and the page's own fit, which
  // measures, is what shortens them (issue #422, pinned below).
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

// ---- the view-time label fit (issue #422) ----

// A DOM just large enough for FIT_JS: element children apart from text nodes, attributes read as strings, a
// textContent that includes a title child the way the browser's does, and getElementsByTagName in document order.
// The code points are spelled as numbers so the file stays ASCII where the width table needs them.
const cps = (...points) => String.fromCodePoint(...points);
const ELLIPSIS = cps(0x2026);
const RLM = cps(0x200f);

function textNode(value) {
  return { nodeType: 3, nodeValue: value };
}

function el(localName, attrs = {}, ...kids) {
  const node = {
    nodeType: 1,
    localName,
    attrs: { ...attrs },
    childNodes: [],
    parentNode: null,
    get children() { return this.childNodes.filter((c) => c.nodeType === 1); },
    get firstChild() { return this.childNodes[0] ?? null; },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null; },
    appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; },
    removeChild(child) { this.childNodes = this.childNodes.filter((c) => c !== child); child.parentNode = null; return child; },
    get textContent() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join(""); },
    set textContent(value) { this.childNodes = [textNode(value)]; },
  };
  for (const kid of kids) node.appendChild(typeof kid === "string" ? textNode(kid) : kid);
  return node;
}

function docOf(...roots) {
  const top = el("svg", {}, ...roots);
  const walk = (node, tag, out) => {
    for (const c of node.children) {
      if (c.localName === tag) out.push(c);
      walk(c, tag, out);
    }
    return out;
  };
  return {
    getElementsByTagName: (tag) => walk(top, tag, []),
    createElementNS: (ns, name) => Object.assign(el(name), { ns }),
  };
}

// Widths per code point: ASCII 6, M 12, the ellipsis 14 (what Chrome draws at 14px), a Malayalam letter 18,
// a cuneiform sign 65, the right-to-left mark 0, anything else 14. Half a surrogate pair measures nothing, so a
// cut through a pair would always fit and could not hide behind the width of the half it left.
const WIDTHS = new Map([[0x4d, 12], [0x2026, 14], [0x0d15, 18], [0x1242b, 65], [0x200f, 0]]);
const widthOf = (s, scale = 1) => [...s].reduce((sum, ch) => {
  const cp = ch.codePointAt(0);
  if (cp >= 0xd800 && cp <= 0xdfff) return sum;
  return sum + scale * (WIDTHS.get(cp) ?? (cp < 0x80 ? 6 : 14));
}, 0);
const measureBy = (scale = 1) => (t) => widthOf(t.firstChild.nodeValue, scale);

const fitLabels = new Function(`${FIT_JS}\nreturn fitLabels;`)();
const noSegmenterFit = new Function("Intl", `${FIT_JS}\nreturn fitLabels;`)({});

// A trigger chip as nodeSvg draws it: the chip rect (no x), the glyph (centred, never fitted), the label at 38,
// the output port straddling the right edge, and the runs line under the chip.
function chip(label, w = 160) {
  return el("g", { class: "gnode" },
    el("rect", { width: w, height: 30 }),
    el("text", { x: 15, y: 20, "text-anchor": "middle" }, "G"),
    el("text", { x: 38, y: 20 }, label),
    el("rect", { x: w - 5, y: 10, width: 10, height: 10 }),
    el("text", { x: 16, y: 41 }, "41 runs"));
}
const label = (c) => c.children[2];

test("the page fits a label to its box by measuring it, and leaves one that fits alone (#422)", () => {
  // The chip's text box is the chip (the port straddling its edge is not the label's box): 160 - 38 - 2 = 120px.
  const wide = chip("MMMMMMMMMMMMMM");
  const fits = chip("build-report-a" + ELLIPSIS);
  const spaced = chip("abcdefghijklmnop qrstuvwxyz");
  fitLabels(docOf(wide, fits, spaced), measureBy());
  assert.equal(label(wide).firstChild.nodeValue, "MMMMMMMM" + ELLIPSIS, "eight M's and a measured ellipsis, 110px of 120");
  assert.equal(label(fits).firstChild.nodeValue, "build-report-a" + ELLIPSIS, "98px fits: the builder's cut is kept");
  assert.equal(label(fits).children.length, 0, "and nothing is added to it");
  assert.equal(label(wide).children.length, 0, "a chip shows its own tooltip, so no title is added");
  assert.equal(label(spaced).firstChild.nodeValue, "abcdefghijklmnop" + ELLIPSIS, "a cut just after a space does not end on it");
});

test("the fit's edges: exactly full, a box it cannot use, a centred glyph, a line below its rect (#422)", () => {
  // 120px exactly is a fit, 121 is not.
  const exact = chip("x");
  const over = chip("x");
  // A label that starts at the chip's right edge has no room at all: it is left as drawn, never cut to an ellipsis.
  const cramped = el("g", {}, el("rect", { width: 40, height: 30 }), el("text", { x: 38, y: 20 }, "abc"));
  const glyph = chip("x");
  const doc = docOf(exact, over, cramped, glyph);
  const widths = new Map([[label(exact), 120], [label(over), 121], [cramped.children[1], 500], [glyph.children[1], 500], [glyph.children[4], 500]]);
  fitLabels(doc, (t) => widths.get(t) ?? widthOf(t.firstChild.nodeValue));
  assert.equal(label(exact).firstChild.nodeValue, "x", "a label exactly as wide as its box stays");
  assert.equal(label(over).firstChild.nodeValue, ELLIPSIS, "one pixel more is cut");
  assert.equal(cramped.children[1].firstChild.nodeValue, "abc", "no room at all: left alone");
  assert.equal(glyph.children[1].firstChild.nodeValue, "G", "a centred glyph is never fitted, however wide");
  assert.equal(glyph.children[4].firstChild.nodeValue, "41 runs", "the runs line sits below the chip's band: no box, never cut");
});

test("the ellipsis is measured, not budgeted: a Malayalam label and a cuneiform one (#422)", () => {
  const malayalam = chip(cps(0x0d15).repeat(10));
  const cuneiform = chip(cps(0x1242b).repeat(3));
  const lone = chip(cps(0x1242b).repeat(3), 100);
  fitLabels(docOf(malayalam, cuneiform, lone), measureBy());
  // 120px: five letters at 18 and the 14px ellipsis is 104; six would be 122.
  assert.equal(label(malayalam).firstChild.nodeValue, cps(0x0d15).repeat(5) + ELLIPSIS);
  assert.equal(label(cuneiform).firstChild.nodeValue, cps(0x1242b) + ELLIPSIS, "65 + 14 fits, 130 + 14 does not");
  // A box too small for a single sign keeps the ellipsis alone rather than running out of the chip.
  assert.equal(label(lone).firstChild.nodeValue, ELLIPSIS);
});

test("a cut keeps whole clusters, with the segmenter and without it (#422)", () => {
  const flags = cps(0x1f1ef, 0x1f1f5).repeat(8);
  const family = cps(0x1f469, 0x200d, 0x1f469, 0x200d, 0x1f467).repeat(4);
  const rockets = cps(0x1f680).repeat(10);
  const cases = [chip(flags), chip(family)];
  fitLabels(docOf(...cases), measureBy());
  const [f, fam] = cases.map((c) => label(c).firstChild.nodeValue);
  assert.match(f, new RegExp(`^(?:${cps(0x1f1ef, 0x1f1f5)})+${ELLIPSIS}$`, "u"), "flags are dropped whole, never half a pair of indicators");
  assert.match(fam, new RegExp(`^(?:${cps(0x1f469, 0x200d, 0x1f469, 0x200d, 0x1f467)})+${ELLIPSIS}$`, "u"), "a family is dropped whole");
  // Without Intl.Segmenter the cut falls back to code points, which still never splits a surrogate pair.
  const bare = chip(rockets);
  noSegmenterFit(docOf(bare), measureBy());
  assert.equal(label(bare).firstChild.nodeValue, cps(0x1f680).repeat(7) + ELLIPSIS, "seven rockets at 14 and the ellipsis: 112px");
});

test("a title that is never cut in the builder is cut here and gains a title of the text drawn (#422)", () => {
  const full = "/srv/a-very-long-deployment-folder-name-that-runs-on";
  const group = el("g", { class: "ggroup" }, el("rect", { x: 0, y: 0, width: 200, height: 100 }), el("text", { x: 8, y: 18 }, full));
  const doc = docOf(group);
  fitLabels(doc, measureBy());
  const text = group.children[1];
  // 200 - 8 - 2 = 190px: 29 ASCII characters and the ellipsis.
  assert.equal(text.firstChild.nodeValue, full.slice(0, 29) + ELLIPSIS);
  assert.equal(text.children.length, 1, "one title");
  assert.equal(text.children[0].localName, "title");
  assert.equal(text.children[0].ns, "http://www.w3.org/2000/svg");
  assert.equal(text.children[0].textContent, full);
  // A second pass (the fonts arriving) starts again from the text drawn: nothing doubled, one title kept.
  fitLabels(doc, measureBy(1.25));
  assert.equal(text.firstChild.nodeValue, full.slice(0, 23) + ELLIPSIS, "recut from the full text at the new measure");
  assert.equal(text.children.length, 1, "still exactly one title");
  assert.equal(text.textContent, full.slice(0, 23) + ELLIPSIS + full, "the drawn text and the title, nothing else");
  // And back: a measure under which the full text fits restores it and drops the title the fit added.
  fitLabels(doc, measureBy(0.5));
  assert.equal(text.firstChild.nodeValue, full);
  assert.equal(text.children.length, 0, "the title goes with the cut");
});

test("a breakdown row: the label stops at the bar, a value after it is never cut, a row without a bar stops at its value (#422)", () => {
  const long = "a-long-flow-name-that-runs-into-the-bar-column";
  const row = el("g", { "data-tip": "0" },
    el("text", { x: 0, y: 14 }, long),
    el("rect", { x: 150, y: 5, width: 50, height: 11 }),
    el("text", { x: 206, y: 14 }, "$1.25"));
  const bare = el("g", { "data-tip": "1" },
    el("text", { x: 0, y: 36 }, long),
    el("text", { x: 150, y: 36 }, "$0 (unrated)"));
  // Neither a label on another line nor a centred one on the same line bounds a label.
  const loose = el("g", { "data-tip": "2" },
    el("text", { x: 0, y: 58 }, long),
    el("text", { x: 100, y: 70 }, "below"),
    el("text", { x: 100, y: 58, "text-anchor": "middle" }, "centred"));
  const hidden = el("g", { class: "ggroup" }, el("rect", { width: 100, height: 40 }), el("text", { x: 8, y: 18 }, long));
  const nested = el("g", { class: "ggroup" }, el("rect", { width: 100, height: 40 }), el("text", { x: 8, y: 18 }, el("tspan", {}, long)));
  const nan = el("g", { class: "ggroup" }, el("rect", { width: 100, height: 40 }), el("text", { x: 8, y: 18 }, long));
  const endless = el("g", { class: "ggroup" }, el("rect", { width: 100, height: 40 }), el("text", { x: 8, y: 18 }, long));
  fitLabels(docOf(row, bare, loose, hidden, nested, nan, endless), (t) => {
    if (t === hidden.children[1]) return 0;
    if (t === nan.children[1]) return Number.NaN;
    if (t === endless.children[1]) return Number.POSITIVE_INFINITY;
    return widthOf(t.firstChild.nodeValue);
  });
  // 150 - 0 - 2 = 148px: 22 characters and the ellipsis (146px; 23 would be 152).
  assert.equal(row.children[0].firstChild.nodeValue, long.slice(0, 22) + ELLIPSIS);
  assert.equal(row.children[2].firstChild.nodeValue, "$1.25", "a value drawn after its bar has no box to be cut to");
  assert.equal(bare.children[0].firstChild.nodeValue, long.slice(0, 22) + ELLIPSIS, "the next label on the line bounds it");
  assert.equal(row.children[0].children.length, 0, "a row that shows its own tooltip gets no title");
  assert.equal(loose.children[0].firstChild.nodeValue, long, "no rect and no left-anchored label on its line: no box");
  assert.equal(hidden.children[1].firstChild.nodeValue, long, "a text measured at 0 is hidden, and is left alone");
  assert.equal(nested.children[1].children[0].firstChild.nodeValue, long, "a text whose first child is an element is left alone");
  assert.equal(nan.children[1].firstChild.nodeValue, long, "a measure that is not a number cuts nothing");
  assert.equal(endless.children[1].firstChild.nodeValue, long, "nor does one that is not finite: it would cut to the ellipsis alone");
});

test("a right-to-left cut keeps its ellipsis in its own run, and a failure fits nothing but breaks nothing (#422)", () => {
  const hebrew = el("g", { class: "ggroup" }, el("rect", { width: 100, height: 40 }), el("text", { x: 8, y: 18 }, cps(0x05d0).repeat(20)));
  const mixed = el("g", { class: "ggroup" }, el("rect", { width: 100, height: 40 }), el("text", { x: 8, y: 18 }, cps(0x05d0).repeat(3) + "abcdefghijklmnopqrst"));
  const after = el("g", { class: "ggroup" }, el("rect", { width: 100, height: 40 }), el("text", { x: 8, y: 18 }, "M".repeat(20)));
  const broken = el("g", { class: "ggroup" }, el("rect", { width: 100, height: 40 }), el("text", { x: 8, y: 18 }, "M".repeat(20)));
  fitLabels(docOf(broken, hebrew, mixed, after), (t) => {
    if (t === broken.children[1]) throw new Error("measure failed");
    return widthOf(t.firstChild.nodeValue);
  });
  // 100 - 8 - 2 = 90px: five letters at 14 and the ellipsis, then the mark that keeps the ellipsis in the run.
  assert.equal(hebrew.children[1].firstChild.nodeValue, cps(0x05d0).repeat(5) + ELLIPSIS + RLM);
  assert.ok(!mixed.children[1].firstChild.nodeValue.endsWith(RLM), "a cut that ends on a Latin letter needs no mark");
  assert.equal(broken.children[1].firstChild.nodeValue, "M".repeat(20), "the label whose measure threw is left as drawn");
  assert.equal(after.children[1].firstChild.nodeValue, "M".repeat(6) + ELLIPSIS, "and the labels after it are still fitted");
});

test("a very long label is cut in a handful of measures, not one per character (#422)", () => {
  const group = el("g", { class: "ggroup" }, el("rect", { width: 400, height: 40 }), el("text", { x: 8, y: 18 }, "x".repeat(20000)));
  let calls = 0;
  fitLabels(docOf(group), (t) => { calls++; return widthOf(t.firstChild.nodeValue); });
  // 400 - 8 - 2 = 390px: 62 characters and the ellipsis.
  assert.equal(group.children[1].firstChild.nodeValue, "x".repeat(62) + ELLIPSIS);
  assert.ok(calls <= 20, `halving the cut: ${calls} measures for 20,000 characters`);
});

test("FIT_JS runs before the page script and holds none of the words the page pins ban (#422)", () => {
  for (const word of ["import", "NaN", "undefined", "Infinity", "innerHTML", "fetch", "src=", "url(", "<script", "<svg", "<g", "`", "${"]) {
    assert.ok(!FIT_JS.includes(word), `FIT_JS does not contain ${JSON.stringify(word)}`);
  }
  const page = pageOf(buildGraphModel(CANNED()));
  const at = page.indexOf(FIT_JS);
  assert.ok(at > 0, "the page carries the fit verbatim");
  assert.ok(at < page.indexOf(PAGE_JS), "ahead of the page script, in the one script element");
});

test("a cron pattern is drawn whole by the builder and fitted to its loop by the page (#422)", () => {
  const withPattern = (pattern) => {
    const base = CANNED();
    const triggers = base.triggers.triggers.map((t, i) => (i === 0 ? { ...t, pattern } : t));
    const schedulers = base.schedulers.map((s) => ({ ...s, pattern }));
    return pageOf(buildGraphModel({ ...base, triggers: { triggers }, schedulers }));
  };
  // The builder cuts no pattern: a 6px column over-counts a 10px font that draws about 5px a character, so a
  // budget in columns cut patterns that fitted their loop. It marks the wire so the page can measure instead.
  const long = "0 0,6,12,18 * * MON,TUE,WED,THU,FRI,SAT,SUN";
  const page = withPattern(long);
  assert.ok(page.includes(`>${long}</text>`), "drawn whole");
  assert.match(page, /<g class="gwire gcron" id="w\d+">/, "the cron re-arm wire is marked for the fit");
  assert.equal((page.match(/class="gwire gcron"/g) ?? []).length, 2, "one per cron trigger in the canned deployment, and no other wire");
  // In the page: the box is the loop path's drawn width, 2px kept each side.
  const loop = (width) => {
    const path = Object.assign(el("path", {}), { getBBox: () => ({ width }) });
    return el("g", { class: "gwire gcron" }, path, el("text", { x: 80, y: 70, "text-anchor": "middle" }, long));
  };
  const narrow = loop(124);
  const wide = loop(400);
  const plain = el("g", { class: "gwire" }, Object.assign(el("path", {}), { getBBox: () => ({ width: 10 }) }), el("text", { x: 80, y: 70, "text-anchor": "middle" }, "(3x)"));
  fitLabels(docOf(narrow, wide, plain), measureBy());
  // 124 - 4 = 120px: sixteen characters and the ellipsis would be 110, but the sixteenth is a space, which a cut never
  // ends on, and the M after it is 12 wide (122).
  assert.equal(narrow.children[1].firstChild.nodeValue, long.slice(0, 15) + ELLIPSIS);
  assert.equal(narrow.children[1].children[0].textContent, long, "the whole pattern rides a title, since nothing else shows it");
  assert.equal(wide.children[1].firstChild.nodeValue, long, "a loop wide enough draws it whole");
  assert.equal(plain.children[1].firstChild.nodeValue, "(3x)", "any other centred wire label is never fitted, however short its wire");
});

test("a loop hint stops at the ring wire, the skill group's title at its edge (#422)", () => {
  // A skill group box at x 0, 226 wide: the ring runs 10px inside its right edge from the chip's midline (y 41) down.
  const hint = "until every open pull request is merged";
  const title = "a-skill-group-title-that-runs-longer";
  const sg = el("g", { class: "sgroup" },
    el("rect", { x: 0, y: 0, width: 226, height: 160 }),
    el("text", { x: 8, y: 16 }, title),
    el("rect", { x: 22, y: 70, width: 40, height: 40 }),
    el("text", { x: 68, y: 94 }, hint));
  fitLabels(docOf(sg), measureBy());
  // The title has the whole width, 226 - 8 - 2 = 216px, and it is exactly 216: the ring does not bound it.
  assert.equal(sg.children[1].firstChild.nodeValue, title, "216px fits the title row");
  // The hint stops at the ring: 216 - 68 - 2 = 146px, 22 characters and the ellipsis; the 22nd is a space, which a
  // cut never ends on.
  assert.equal(sg.children[3].firstChild.nodeValue, hint.slice(0, 21) + ELLIPSIS);
});

test("a forge group is wide enough for its caveat, even with no flow column (#422)", () => {
  // A forge trigger that runs a command has no flow chip, so its group sat at the minimum width, where the page cut
  // the caveat that nothing on this host can verify it.
  const inputs = CANNED();
  inputs.triggers = { triggers: [{ type: "label", index: 0, any: ["ai"], all: [], none: [], command: "deploy", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "forgejo" }] };
  inputs.schedulers = [];
  inputs.forgeRepos = {};
  const scene = buildGraphScene(buildGraphModel(inputs), { now: NOW });
  const forge = scene.layout.groups.find((g) => g.kind === "forge");
  assert.ok(forge, "a forge group");
  const title = "forgejo · forge · unverifiable from this host";
  assert.ok(scene.svgBody.includes(`>${title}</text>`));
  // 8 + 45 columns at 7px + 8, on the 20px grid: 340.
  assert.equal(forge.w, 340);
  assert.ok(forge.w >= 8 + labelColumns(title) * 7 + 8, "the box holds the caveat at 7px a column");
});

test("the right-to-left mark: after Hebrew or Arabic letters, never after Arabic-Indic digits, and in the builder's cut too (#422)", () => {
  const box = (text) => el("g", { class: "ggroup" }, el("rect", { width: 100, height: 40 }), el("text", { x: 8, y: 18 }, text));
  // U+0661-0666: the bidi algorithm reads them as a number, not as right-to-left letters, so a Latin label ending in
  // them is cut left to right; a mark after them put the ellipsis in the middle of the number.
  const digits = box("report " + cps(0x0661, 0x0662, 0x0663, 0x0664, 0x0665, 0x0666).repeat(3));
  const arabic = box(cps(0x0645, 0x0631, 0x062d, 0x0628, 0x0627).repeat(4));
  fitLabels(docOf(digits, arabic), measureBy());
  assert.ok(!digits.children[1].firstChild.nodeValue.endsWith(RLM), "no mark after digits that follow a Latin word");
  assert.ok(digits.children[1].firstChild.nodeValue.endsWith(ELLIPSIS));
  assert.ok(arabic.children[1].firstChild.nodeValue.endsWith(ELLIPSIS + RLM), "a mark after Arabic letters");
  // U+08E2, the Arabic disputed end of ayah, is a number format to the bidi algorithm: a Latin label ending in it is cut
  // left to right, and the mark moved the ellipsis 20px (measured). It is a Prepend, so a grapheme cut never ends on
  // one; the code-point fallback can, which is where this is pinned.
  const sign = box("report ab" + cps(0x08e2).repeat(30));
  noSegmenterFit(docOf(sign), measureBy());
  assert.ok(sign.children[1].firstChild.nodeValue.includes(cps(0x08e2) + ELLIPSIS), "the cut does end on U+08E2");
  assert.ok(!sign.children[1].firstChild.nodeValue.endsWith(RLM), "no mark after U+08E2");
  // The builder's own cut carries the same mark, and it costs no column.
  const hebrew = cps(0x05d0).repeat(30);
  assert.equal(clipColumns(hebrew, 10), cps(0x05d0).repeat(10) + ELLIPSIS + RLM);
  assert.equal(drawnColumns(clipColumns(hebrew, 10)), 11, "the mark draws nothing, so it costs no column and leaves the ellipsis seen");
  assert.equal(clipColumns("abcdefghijklmnop", 10), "abcdefghij" + ELLIPSIS, "and none on a Latin cut");
});

test("the halving finds the longest start that fits, even where a longer start draws narrower (#422)", () => {
  // Arabic joining can make a longer start narrower. Widths of "abcdef" cut after 0..5 clusters, with the ellipsis.
  const widths = [14, 30, 40, 70, 35, 90];
  const t = el("text", { x: 8, y: 18 }, "abcdef");
  const g = el("g", { class: "ggroup" }, el("rect", { width: 60, height: 40 }), t);
  fitLabels(docOf(g), (x) => {
    const v = x.firstChild.nodeValue;
    return v === "abcdef" ? 200 : widths[v.length - 1];
  });
  // 60 - 8 - 2 = 50px: the halving alone lands on two clusters (40); four (35) fit too.
  assert.equal(t.firstChild.nodeValue, "abcd" + ELLIPSIS);
  // Dropping the last cluster alone is enough here: the whole start but one is kept.
  const last = chip("aaaaaaaaaa" + cps(0x1242b));
  fitLabels(docOf(last), measureBy());
  assert.equal(label(last).firstChild.nodeValue, "aaaaaaaaaa" + ELLIPSIS, "ten letters kept, only the sign dropped");
});

test("a measure that fails part way through a cut leaves the label as the builder drew it (#422)", () => {
  const g = el("g", { class: "ggroup" }, el("rect", { width: 100, height: 40 }), el("text", { x: 8, y: 18 }, "M".repeat(20)));
  let calls = 0;
  fitLabels(docOf(g), (t) => {
    calls++;
    if (calls === 3) throw new Error("measure failed");
    return widthOf(t.firstChild.nodeValue);
  });
  assert.equal(g.children[1].firstChild.nodeValue, "M".repeat(20));
});

// ---- 9. nothing drawn sits on a wire, a loop or another label (issue #483) ----

// The drawn path of a wire as points: every M/L/C segment sampled, so the pins below read the `d` the page
// draws rather than any layout field that could disagree with it.
function pathPoints(d) {
  const tok = d.match(/[MLC]|-?\d+(?:\.\d+)?/g);
  const pts = [];
  let cur = null;
  for (let i = 0; i < tok.length; ) {
    const c = tok[i++];
    const nums = [];
    while (i < tok.length && !/[MLC]/.test(tok[i])) nums.push(Number(tok[i++]));
    if (c === "M") {
      cur = [nums[0], nums[1]];
      pts.push(cur);
    } else if (c === "L") {
      const [x, y] = nums;
      for (let k = 1; k <= 32; k++) pts.push([cur[0] + ((x - cur[0]) * k) / 32, cur[1] + ((y - cur[1]) * k) / 32]);
      cur = [x, y];
    } else {
      const [ax, ay, bx, by, x, y] = nums;
      for (let k = 1; k <= 32; k++) {
        const t = k / 32;
        const u = 1 - t;
        pts.push([u * u * u * cur[0] + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * x, u * u * u * cur[1] + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * y]);
      }
      cur = [x, y];
    }
  }
  return pts;
}

// A wire label's drawn box at the 10px font: 5.5px a column (the measured average of the digits and
// lowercase the labels are made of), 8px of ascent and 3 of descent around the baseline, centred.
function wireLabelBox(w) {
  const hw = (labelColumns(w.label) * 5.5) / 2;
  return { x0: w.labelX - hw, x1: w.labelX + hw, y0: w.labelY - 8, y1: w.labelY + 3 };
}
const inBox = ([x, y], b) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;
const boxesMeet = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

// TIERED (above) is the #483 page's shape: three site cron triggers whose flows resolve in the three tiers,
// with the forge group between the site folder and the tier groups those wires land in.

test("a cron trigger's re-arm loop runs below its status line and spend badge, its pattern below the loop (issue #483)", () => {
  // The badge the insights page lays over a trigger sat at the chip's top + 53 and the loop ran at + 55,
  // so the dollar figure was drawn on the dashed loop. The loop now clears the whole under-chip stack.
  for (const layout of [layoutOf(buildGraphModel(CANNED())), layoutOf(buildGraphModel(TIERED()))]) {
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const loops = layout.wires.filter((w) => w.kind === "cron-rearm");
    assert.ok(loops.length >= 2, "the scene has re-arm loops to check");
    for (const w of loops) {
      const chip = byId.get(w.from);
      const run = Math.max(...pathPoints(w.d).map(([, y]) => y));
      const badgeBottom = chip.y + SPEND_BADGE_DY + 3;
      assert.ok(run - 1 > badgeBottom, `loop ${w.id} runs at ${run}, on the badge line ending at ${badgeBottom}`);
      assert.ok(w.labelY - 8 > run + 1, `the pattern of ${w.id} sits on its own loop`);
    }
    assertUnderRoutesClearChips(layout);
  }
});

// A skill leaving for two skills of the next column, each with a count and a mention: a label stack per
// (from, to) pair centred on the gap put both counts on the same pixels.
const FAN = () => {
  const sk = (name, extra = {}) => ({ name, isSub: false, group: null, aiTrigger: true, meta: null, mentions: [], loops: [], unread: false, ...extra });
  return {
    ...CANNED(),
    triggers: { triggers: [{ type: "cron", index: 0, id: "a", pattern: "0 3 * * *", folder: "/srv/site", flow: "alpha", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false }] },
    schedulers: [],
    folderSkills: { "/srv/site": { head: "a", truncated: false, unreachable: null, skills: [sk("alpha", { mentions: [{ name: "beta", strong: false }, { name: "gamma", strong: false }] }), sk("beta"), sk("gamma")] } },
    injectedSkills: {},
    cronStats: { byId: {} },
    runJoin: { byIndex: {}, unattributed: 0 },
    chainEdges: { edges: [["beta", 3], ["gamma", 5]].map(([childFlow, count]) => ({ parentFlow: "alpha", childFlow, target: "local:site", count, lastEndedAt: "2026-08-10T00:00:00.000Z" })), refusals: {}, truncated: false },
  };
};
// Adjacent full-width chips (a 20px gap) on two rows, each pair with a count and a mention: stacking both
// labels over the lower pair reached the chips of the row above.
const TIGHT = () => {
  const m = FAN();
  const name = (c) => `${c}`.repeat(16);
  const sk = (n, extra = {}) => ({ name: n, isSub: false, group: null, aiTrigger: true, meta: null, mentions: [], loops: [], unread: false, ...extra });
  m.triggers.triggers = ["a", "b"].map((c, i) => ({ type: "cron", index: i, id: c, pattern: "0 3 * * *", folder: "/srv/site", flow: name(c), model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false }));
  m.folderSkills["/srv/site"].skills = [sk(name("a"), { mentions: [{ name: name("c"), strong: false }] }), sk(name("b"), { mentions: [{ name: name("d"), strong: true }] }), sk(name("c")), sk(name("d"))];
  m.chainEdges.edges = [["a", "c", 3], ["b", "d", 7]].map(([p, c, count]) => ({ parentFlow: name(p), childFlow: name(c), target: "local:site", count, lastEndedAt: "2026-08-10T00:00:00.000Z" }));
  return m;
};

// A mention cycle on the first row (a back edge under it, whose label sat fixed under its run) and a wire
// climbing to that row from the next one through the band under it.
const CYCLE = () => {
  const m = FAN();
  const sk = (name, mentions) => ({ name, isSub: false, group: null, aiTrigger: false, meta: null, mentions: mentions.map((n) => ({ name: n, strong: false })), loops: [], unread: false });
  m.triggers.triggers = ["a1", "c1"].map((flow, i) => ({ type: "cron", index: i, id: `t${flow}`, pattern: "0 3 * * *", folder: "/srv/site", flow, model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false }));
  m.folderSkills["/srv/site"].skills = [sk("a1", ["b2"]), sk("b2", ["a1"]), sk("c1", ["b2"])];
  m.chainEdges.edges = [{ parentFlow: "b2", childFlow: "a1", target: "local:site", count: 4, lastEndedAt: "2026-08-10T00:00:00.000Z" }];
  return m;
};

test("no wire label sits on any wire, any chip or another label, fan-outs and tight rows included (issue #483)", () => {
  // Each label is placed on its own wire's path at the first spot clear of everything drawn and of every label
  // placed before it. Two earlier rules were each refuted: a label at its curve's midpoint with a sibling
  // 10.5px up drew mention across the count; a stack per (from, to) pair centred on the gap drew the two
  // counts of a fan-out on the same pixels and, between adjacent chips, reached the row above.
  for (const layout of [CANNED(), TIERED(), FAN(), TIGHT(), CYCLE()].map((m) => layoutOf(buildGraphModel(m)))) {
    const labelled = layout.wires.filter((w) => w.label !== null && w.labelHidden !== true);
    const pair = labelled.filter((w) => w.kind === "observed" || w.kind === "potential");
    assert.ok(pair.length >= 2, "the scene has wire labels to place");
    assert.ok(layout.wires.every((w) => w.labelHidden !== true), "and every one of them found a clear spot");
    const drawn = layout.wires.map((w) => ({ w, pts: pathPoints(w.d), half: w.kind === "observed" ? 1.5 : 1 }));
    for (const w of labelled) {
      const box = wireLabelBox(w);
      for (const { w: o, pts, half } of drawn) {
        // Against the stroke plus a pixel of air, not the centre line: a label may not sink into the wire it rides.
        const wide = { x0: box.x0 - half - 1, x1: box.x1 + half + 1, y0: box.y0 - half - 1, y1: box.y1 + half + 1 };
        const hit = pts.find((p) => inBox(p, wide));
        assert.ok(!hit, `label ${JSON.stringify(w.label)} of ${w.id} sits on wire ${o.id} at ${hit}`);
      }
      for (const n of layout.nodes) {
        assert.ok(!boxesMeet(box, { x0: n.x - 5, x1: n.x + n.w + 5, y0: n.y - 7, y1: n.y + n.h }), `label ${JSON.stringify(w.label)} of ${w.id} sits on chip ${n.id}`);
      }
    }
    for (let i = 0; i < labelled.length; i++) {
      for (let j = i + 1; j < labelled.length; j++) {
        assert.ok(!boxesMeet(wireLabelBox(labelled[i]), wireLabelBox(labelled[j])), `labels of ${labelled[i].id} and ${labelled[j].id} overlap`);
      }
    }
    // And each reads as its own wire's: from the middle of its box's top and bottom edges, its own wire lies
    // within 16 and no wire outside its (from, to) pair lies nearer. Placed six lines out, a fan-out's mention
    // sat beside the other target's port and read as that edge's.
    const dense = new Map(layout.wires.map((w) => [w.id, densePath(w.d)]));
    for (const w of labelled.filter((x) => !x.self)) {
      const anchors = [[w.labelX, w.labelY - 9], [w.labelX, w.labelY + 3]];
      const dist = (pts) => Math.min(...anchors.flatMap(([ax, ay]) => pts.map((q) => Math.hypot(q[0] - ax, q[1] - ay))));
      const own = dist(dense.get(w.id));
      assert.ok(own <= 16.5, `label of ${w.id} sits ${own.toFixed(1)} from its own wire`);
      for (const o of layout.wires) {
        if (o.id === w.id || (o.from === w.from && o.to === w.to)) continue;
        const d = dist(dense.get(o.id));
        assert.ok(d >= own - 0.5, `label of ${w.id} (${JSON.stringify(w.label)}) is nearer wire ${o.id} (${d.toFixed(1)}) than its own (${own.toFixed(1)})`);
      }
    }
  }
});

test("a wire that leaves its group runs between groups: through no other group, no title band and no chip (issue #483)", () => {
  // The straight bezier from a site trigger to its tier flow ran down the page through the forge group's
  // title and past the ports of every chip on its way.
  const layout = layoutOf(buildGraphModel(TIERED()));
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const groupOf = new Map(layout.nodes.map((n) => [n.id, n.groupId]));
  const cross = layout.wires.filter((w) => !w.self && groupOf.get(w.from) !== groupOf.get(w.to));
  assert.equal(cross.length, 3, "one wire into each tier group");
  const forge = layout.groups.find((g) => g.kind === "forge");
  const tiers = layout.groups.filter((g) => cross.some((w) => groupOf.get(w.to) === g.id));
  assert.ok(forge && tiers.every((g) => g.y > forge.y), "the forge group sits between the source folder and every tier group");
  for (const w of cross) {
    const f = byId.get(w.from);
    const t = byId.get(w.to);
    assert.ok(f.x + f.w <= t.x, "it still leaves a right port for a left one");
    const pts = pathPoints(w.d);
    for (const g of layout.groups) {
      const title = { x0: g.x, x1: g.x + g.w, y0: g.y, y1: g.y + 24 };
      const hit = pts.find((p) => inBox(p, title));
      assert.ok(!hit, `wire ${w.id} crosses the title band of ${g.label} at ${hit}`);
      if (g.id === f.groupId || g.id === t.groupId) continue;
      const inside = pts.find((p) => inBox(p, { x0: g.x, x1: g.x + g.w, y0: g.y, y1: g.y + g.h }));
      assert.ok(!inside, `wire ${w.id} runs through ${g.label} at ${inside}`);
    }
    for (const n of layout.nodes) {
      // The 5px port overhang is where a wire starts and ends; anything else inside a chip is a crossing.
      const chip = { x0: n.x - 5, x1: n.x + n.w + 5, y0: n.y, y1: n.y + n.h };
      const hit = pts.find((p) => inBox(p, chip) && !(n === f && p[0] >= f.x + f.w - 5) && !(n === t && p[0] <= t.x + 5));
      assert.ok(!hit, `wire ${w.id} crosses chip ${n.id} at ${hit}`);
      // And the text under a trigger chip (status line, spend badge) is not crossed either.
      if (n.node.kind === "trigger") {
        const under = { x0: n.x, x1: n.x + n.w, y0: n.y + n.h, y1: n.y + SPEND_BADGE_DY + 3 };
        assert.ok(!pts.find((p) => inBox(p, under)), `wire ${w.id} crosses the text under ${n.id}`);
      }
    }
  }
});

test("the viewBox is what is drawn plus a stroke margin: no empty band above the first group (issue #483)", () => {
  // A fixed 80 around the groups drew a band above the first group as tall as a row.
  for (const layout of [layoutOf(buildGraphModel(CANNED())), layoutOf(buildGraphModel(TIERED()))]) {
    const vb = layout.viewBox;
    const top = Math.min(...layout.groups.map((g) => g.y));
    assert.ok(vb.y <= top && top - vb.y <= 16, `the pane starts ${top - vb.y} above the first group`);
    for (const w of layout.wires) {
      for (const [x, y] of pathPoints(w.d)) {
        assert.ok(x >= vb.x && x <= vb.x + vb.w && y >= vb.y && y <= vb.y + vb.h, `wire ${w.id} is drawn outside the viewBox at ${x},${y}`);
      }
      if (w.label !== null) {
        const b = wireLabelBox(w);
        assert.ok(b.x0 >= vb.x && b.x1 <= vb.x + vb.w && b.y0 >= vb.y && b.y1 <= vb.y + vb.h, `label of ${w.id} is drawn outside the viewBox`);
      }
    }
    for (const g of layout.groups) assert.ok(g.x >= vb.x && g.x + g.w <= vb.x + vb.w && g.y + g.h <= vb.y + vb.h, `group ${g.label} is cut by the viewBox`);
    // Inside every folder, a line of wire label fits between the title band and the first row's badges, so a
    // label of a wire on the first row has a place in its own folder (at a 40px pad it had 10px).
    for (const g of layout.groups) {
      const tops = layout.nodes.filter((n) => n.groupId === g.id).map((n) => n.y);
      if (tops.length > 0) assert.ok(Math.min(...tops) - 8 - (g.y + 22) >= 14, `${g.label}: ${Math.min(...tops) - 8 - (g.y + 22)}px above the first row`);
    }
  }
});

test("no wire runs through a skill group's title, whichever row its trigger sits on (issue #483)", () => {
  // The title started at the box's left edge, left of the chip's input port, where every wire into the
  // chip arrives: a wire from a trigger on the chip's own row or a row above ran through the title. Three
  // triggers feeding three skills, the looped one sorted last; with an untriggered skill sorted first the
  // looped skill drops a row below its trigger (the corpus page of label-fit-check found it that way), and
  // without it the two share a row.
  const names = ["alpha", "beta", "zeta"];
  const flat = {
    triggers: { triggers: names.map((k, i) => ({ type: "cron", index: i, id: k, pattern: "0 3 * * *", folder: "/srv/site", flow: `${k}-x`, model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false })) },
    schedulers: [],
    folderSkills: { "/srv/site": { head: "abc123", truncated: false, unreachable: null, skills: names.map((k, i) => ({ name: `${k}-x`, isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], loops: i === 2 ? [{ hint: "until it is right" }] : [], unread: false })) } },
    injectedSkills: {},
    overlaySkills: { skills: [], truncated: false, unreachable: null },
    stagedSkills: { skills: [], unenumerable: [], truncated: false },
    forgeRepos: {},
    cronStats: { byId: {} },
    runJoin: { byIndex: {}, unattributed: 0 },
    chainEdges: { edges: [], refusals: {}, truncated: false },
    caps: { chainDepthMax: 1, chainMaxPerJob: 2, windowDays: 30 },
    nowMs: NOW,
  };
  const above = structuredClone(flat);
  above.folderSkills["/srv/site"].skills.push({ name: "aaa-orphan", isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], loops: [], unread: false });
  const rowOf = (model, pick) => {
    const layout = layoutOf(buildGraphModel(model));
    return layout.nodes.find((n) => pick(n.node)).y;
  };
  assert.ok(rowOf(above, (n) => n.kind === "trigger" && n.label?.startsWith("zeta")) < rowOf(above, (n) => n.name === "zeta-x") - 30, "the looped skill sits a row below its trigger");
  // A long looped name whose chip's wires climb to the row above (the observed count and the mention to
  // notify, like the #483 page's build-report): the title's right end is where the climbing wire runs.
  const long = CANNED();
  const LONG = "build-report-for-the-whole-customer-website";
  const site = long.folderSkills["/srv/site"].skills;
  site[0].name = LONG;
  long.triggers.triggers[0].flow = LONG;
  long.chainEdges.edges[0].parentFlow = LONG;
  long.chainEdges.refusals = {};
  let checked = 0;
  for (const model of [flat, above, CANNED(), TIERED(), long]) {
    const scene = buildGraphScene(buildGraphModel(model), { now: NOW });
    const titles = [...scene.svgBody.matchAll(/<g class="sgroup" id="[^"]+">(?:<rect[^>]*\/>)+<text x="([\d.-]+)" y="([\d.-]+)" font-size="11"[^>]*>([^<]*)/g)];
    assert.ok(titles.length >= 1, "the scene has a skill group");
    for (const [, x, y, label] of titles) {
      // 11px text: 6.5px a column, 9px of ascent and 3 of descent.
      const box = { x0: Number(x), x1: Number(x) + labelColumns(label) * 6.5, y0: Number(y) - 9, y1: Number(y) + 3 };
      for (const w of scene.layout.wires) {
        const hit = pathPoints(w.d).find((p) => inBox(p, box));
        assert.ok(!hit, `wire ${w.id} runs through the title ${JSON.stringify(label)} at ${hit}`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 5);
  // By construction, not by luck of the scene: the title (at its estimate and its fit rect alike) ends
  // short of the output port's square, and a cut title keeps the whole name in a tooltip.
  const scene = buildGraphScene(buildGraphModel(long), { now: NOW });
  const sg = scene.layout.skillGroups.find((g) => g.label === LONG);
  const chip = scene.layout.nodes.find((n) => n.id === sg.nodeId);
  const m = new RegExp(`<g class="sgroup" id="${sg.id}"><rect[^>]*/><rect x="([\\d.-]+)" y="[\\d.-]+" width="([\\d.-]+)"[^>]*/><text x="([\\d.-]+)"[^>]*>([^<]*)<title>([^<]*)</title>`).exec(scene.svgBody);
  assert.ok(m, "the cut title draws its fit rect and carries its tooltip");
  // The fit rect spans the gap between the ports when a drawn path enters the title band, the box otherwise;
  // either way the cut title ends inside it, and no wire runs through it (checked above).
  const rectEnd = Number(m[1]) + Number(m[2]);
  const band = scene.layout.wires.some((w) => pathPoints(w.d).some(([x, y]) => x > sg.x + 27 && x < sg.x + sg.w - 3 && y > sg.y + 2 && y < sg.y + 22));
  if (band) assert.ok(Number(m[1]) > chip.x + 5 && rectEnd <= chip.x + chip.w - 5, "a crossed band: the fit rect lies between the ports");
  else assert.ok(rectEnd <= sg.x + sg.w - 4, "a clear band: the fit rect ends inside the box");
  assert.ok(Number(m[3]) + drawnColumns(m[4]) * 7 <= rectEnd + 2, "the cut title ends inside its fit rect");
  assert.equal(m[5], LONG, "the whole name rides the tooltip");
  assert.notEqual(m[4], LONG);
});

// Two paths coincide where one runs within 1.5px of the other for more than 8px of its length. The first and
// last 10px of a wire are left out: every wire leaves its port along the port's own loop, and wires into one
// port meet there.
function longestShared(a, b) {
  const near = (p) => b.some((q) => Math.abs(p[0] - q[0]) < 1.5 && Math.abs(p[1] - q[1]) < 1.5 && Math.hypot(p[0] - q[0], p[1] - q[1]) < 1.5);
  let run = 0;
  let best = 0;
  let len = 0;
  const total = a.reduce((s2, p, i) => s2 + (i > 0 ? Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) : 0), 0);
  for (let i = 1; i < a.length; i++) {
    const step = Math.hypot(a[i][0] - a[i - 1][0], a[i][1] - a[i - 1][1]);
    len += step;
    if (len < 10 || len > total - 10) {
      run = 0;
      continue;
    }
    run = near(a[i]) ? run + step : 0;
    if (run > best) best = run;
  }
  return best;
}
const densePath = (d) => {
  const pts = pathPoints(d);
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
};

test("every wire that leaves its group has a lane, a gap line and a gutter of its own, and shares no run with any wire (issue #483)", () => {
  // Three site triggers' wires into three tiers shared one lane and one gap line, one trunk the eye could not
  // take apart; and a steep intra-group wire from the same column ran along the lane. Here four wires leave
  // (two for one target, which meet only at its port), and an untriggered skill adds an intra-group wire
  // from a lane column to a row far below.
  const m = TIERED();
  m.triggers.triggers.push({ type: "cron", index: 6, id: "inj2", pattern: "0 6 * * *", folder: "/srv/site", flow: "tidy", model: null, packages: true, image: null, skillsDir: "/inj", instructions: false, resume: false });
  const site = m.folderSkills["/srv/site"].skills;
  site.push({ name: "zz-orphan", isSub: false, group: null, aiTrigger: false, meta: null, mentions: [{ name: site[0].name, strong: false }], loops: [], unread: false });
  const layout = layoutOf(buildGraphModel(m));
  const groupOf = new Map(layout.nodes.map((n) => [n.id, n.groupId]));
  const cross = layout.wires.filter((w) => !w.self && groupOf.get(w.from) !== groupOf.get(w.to));
  assert.equal(cross.length, 4);
  const lanes = cross.map((w) => pathPoints(w.d).find((p, i, a) => i > 0 && Math.abs(p[0] - a[i - 1][0]) < 0.01 && p[1] > a[i - 1][1])[0]);
  assert.equal(new Set(lanes).size, 4, `four lanes: ${lanes}`);
  assert.equal(new Set(cross.map((w) => w.gutterX)).size, 4, "four gutters");
  // Each lane runs clear of every re-arm loop in its column (a loop reaches 13.5px past its chip).
  const loopRight = Math.max(...layout.wires.filter((w) => w.kind === "cron-rearm").map((w) => Math.max(...pathPoints(w.d).map(([x]) => x))));
  for (const x of lanes) assert.ok(x > loopRight + 2, `a lane at ${x} runs on the re-arm loops, which reach ${loopRight}`);
  // And no wire of them runs along another wire, or along a group's border (the gap line sits inside the gap).
  const borders = layout.groups.map((g) => ({ w: { id: `border of ${g.label}`, kind: "border" }, pts: densePath(`M ${g.x} ${g.y} L ${g.x + g.w} ${g.y} L ${g.x + g.w} ${g.y + g.h} L ${g.x} ${g.y + g.h} L ${g.x} ${g.y}`) }));
  const paths = layout.wires.map((w) => ({ w, pts: densePath(w.d) }));
  for (const a of paths.filter((p) => cross.includes(p.w))) {
    for (const b of [...paths, ...borders]) {
      if (a === b) continue;
      const shared = longestShared(a.pts, b.pts);
      assert.ok(shared <= 8, `wire ${a.w.id} runs along ${b.w.id} (${b.w.kind}) for ${shared.toFixed(1)}px`);
    }
  }
});

test("a forward wire crosses no chip and no skill-group box but those it starts or ends in, skipped columns included (issue #483)", () => {
  // A config wire to a skill two columns on ran through the skill group standing in the column between, its
  // title and all (on main too). A wire that skips a column now passes it through a gap between its boxes.
  const sk = (name, extra = {}) => ({ name, isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], loops: [], unread: false, ...extra });
  const skip = {
    ...FAN(),
    triggers: { triggers: ["alpha", "beta"].map((flow, i) => ({ type: "cron", index: i, id: flow[0], pattern: "0 3 * * *", folder: "/srv/site", flow, model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false })) },
    folderSkills: { "/srv/site": { head: "a", truncated: false, unreachable: null, skills: [sk("alpha"), sk("beta", { loops: [{ hint: "until done" }], mentions: [{ name: "alpha", strong: false }] })] } },
    chainEdges: { edges: [], refusals: {}, truncated: false },
  };
  let skipped = 0;
  for (const model of [skip, CANNED(), TIERED(), FAN(), TIGHT()]) {
    const layout = layoutOf(buildGraphModel(model));
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const w of layout.wires.filter((x) => !x.self && !x.back)) {
      const f = byId.get(w.from);
      const t = byId.get(w.to);
      const pts = pathPoints(w.d);
      const own = new Set([f.id, t.id]);
      for (const n of layout.nodes) {
        if (own.has(n.id)) continue;
        const hit = pts.find((p) => inBox(p, { x0: n.x - 5, x1: n.x + n.w + 5, y0: n.y, y1: n.y + n.h }));
        assert.ok(!hit, `wire ${w.id} crosses chip ${n.id} at ${hit}`);
      }
      for (const sg of layout.skillGroups) {
        if (own.has(sg.nodeId)) continue;
        const hit = pts.find((p) => inBox(p, { x0: sg.x, x1: sg.x + sg.w, y0: sg.y, y1: sg.y + sg.h }));
        assert.ok(!hit, `wire ${w.id} runs through the skill group of ${sg.label} at ${hit}`);
      }
      if (f.x + f.w < t.x - 200) skipped++;
    }
  }
  assert.ok(skipped >= 1, "a scene has a wire that skips a column");
});

test("a skill group's title takes the box's whole width unless a wire enters its band (issue #483)", () => {
  // Cut to the gap between the chip's ports always, near-identical long names read the same.
  const LONG = "deploy-staging-website-for-the-customer";
  const lone = CANNED();
  lone.folderSkills["/srv/site"].skills[0].name = LONG;
  lone.folderSkills["/srv/site"].skills[0].mentions = [];
  lone.triggers.triggers[0].flow = LONG;
  lone.chainEdges.edges = [];
  const sgOf = (model) => {
    const scene = buildGraphScene(buildGraphModel(model), { now: NOW });
    const sg = scene.layout.skillGroups.find((g) => g.label === LONG);
    return { sg, chip: scene.layout.nodes.find((n) => n.id === sg.nodeId) };
  };
  const { sg, chip } = sgOf(lone);
  assert.ok(sg.titleW > chip.w, `a title no wire reaches gets the box: ${sg.titleW} for a ${sg.w}px box`);
  assert.ok(labelColumns(sg.title) * 7 <= sg.titleW, "and is cut to it");
  const climbing = structuredClone(lone);
  climbing.folderSkills["/srv/site"].skills[0].mentions = [{ name: "notify", strong: true }];
  const crossed = sgOf(climbing);
  assert.ok(crossed.sg.titleW < crossed.chip.w, "a wire climbing through the band cuts it back between the ports");
  assert.ok(labelColumns(crossed.sg.title) < labelColumns(sg.title));
});

test("a wire label with no clear spot moves to its wire's tooltip and the legend counts it; none is drawn over anything (issue #483)", () => {
  // One skill mentioning and chaining to seven skills of the next column: fourteen labels in one gap, more
  // than it holds. Placing the least-bad spot drew them on each other; the ones with no clear spot are not
  // drawn at all now, but carried by their wire's title element, and the legend says how many.
  const m = FAN();
  const names = ["beta", "gamma", "delta", "eps", "zeta", "eta", "theta"];
  const sk = (name, extra = {}) => ({ name, isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], loops: [], unread: false, ...extra });
  m.folderSkills["/srv/site"].skills = [sk("alpha", { mentions: names.map((n) => ({ name: n, strong: false })) }), ...names.map((n) => sk(n))];
  m.chainEdges.edges = names.map((childFlow, i) => ({ parentFlow: "alpha", childFlow, target: "local:site", count: i + 2, lastEndedAt: "2026-08-10T00:00:00.000Z" }));
  const scene = buildGraphScene(buildGraphModel(m), { now: NOW });
  const hidden = scene.layout.wires.filter((w) => w.labelHidden === true);
  assert.ok(hidden.length >= 1, "the scene is denser than its gaps");
  assert.equal(scene.hiddenLabels, hidden.length);
  for (const w of hidden) {
    const g = new RegExp(`<g class="gwire" id="${w.id}"><path[^>]*/><title>${w.label.replace(/[()×·]/g, (c) => `\\${c}`)}</title></g>`);
    assert.match(scene.svgBody, g, `wire ${w.id} carries its label as a tooltip and draws no text`);
  }
  const drawn = scene.layout.wires.filter((w) => w.label !== null && w.labelHidden !== true && !w.self);
  assert.ok(drawn.length >= 1);
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) assert.ok(!boxesMeet(wireLabelBox(drawn[i]), wireLabelBox(drawn[j])), `labels of ${drawn[i].id} and ${drawn[j].id} overlap`);
    for (const o of scene.layout.wires) {
      const hit = pathPoints(o.d).find((p) => inBox(p, wireLabelBox(drawn[i])));
      assert.ok(!hit, `label of ${drawn[i].id} sits on wire ${o.id}`);
    }
  }
  const page = pageOf(buildGraphModel(m));
  assert.ok(page.includes(`${hidden.length} wire label${hidden.length === 1 ? "" : "s"} in tooltips only (no clear spot on the page)`), "the legend states the count");
  assert.ok(!cannedPage().includes("in tooltips only"), "and says nothing when every label is drawn");
});

test("two back edges out of one node take runs of their own (issue #483)", () => {
  // z closes two cycles, to x and to y, all on the first row: both back edges left z's port and ran under the
  // row at one height, pixel for pixel, so neither the eye nor a label could tell them apart.
  const m = FAN();
  const sk = (name, mentions) => ({ name, isSub: false, group: null, aiTrigger: false, meta: null, mentions: mentions.map((n) => ({ name: n, strong: false })), loops: [], unread: false });
  m.triggers.triggers[0].flow = "x";
  m.folderSkills["/srv/site"].skills = [sk("x", ["y"]), sk("y", ["z"]), sk("z", ["x", "y"])];
  m.chainEdges.edges = [];
  const layout = layoutOf(buildGraphModel(m));
  const back = layout.wires.filter((w) => w.back);
  assert.equal(back.length, 2, "both cycles close with a back edge out of z");
  assert.equal(back[0].from, back[1].from);
  // Past the shared port (every wire leaving one port shares its first curve, a fan-out's too), nothing is shared.
  const [a0, a1] = back.map((w) => densePath(w.d));
  const past = (pts) => pts.filter((p) => Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) > 30);
  const shared = longestShared(past(a0), past(a1));
  assert.ok(shared <= 8, `the two back edges share ${shared.toFixed(1)}px of run`);
  assertUnderRoutesClearChips(layout);
});

test("in seeded dense scenes, every drawn label is nearer its own wire than any other pair's (issue #483)", () => {
  // The review's generator (PR #487): three to eight skills, each mentioning each other one in four, most
  // mentions also chained, half the skills with a trigger. Its first 40 scenes hold labels that, placed only
  // by the distance cap, sat nearer another pair's wire than their own.
  let seed = 1;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let checked = 0;
  for (let it = 0; it < 40; it++) {
    const n = 3 + Math.floor(rnd() * 6);
    const names = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i) + "-" + "x".repeat(Math.floor(rnd() * (rnd() < 0.3 ? 30 : 10))));
    const skills = names.map((name) => ({ name, isSub: false, group: null, aiTrigger: rnd() < 0.5, meta: null, mentions: [], loops: rnd() < 0.3 ? [{ hint: "until done" }] : [], unread: false }));
    const edges = [];
    for (const s of skills) {
      for (const t of skills) {
        if (s !== t && rnd() < 0.25) {
          s.mentions.push({ name: t.name, strong: rnd() < 0.5 });
          if (rnd() < 0.6) edges.push({ parentFlow: s.name, childFlow: t.name, target: "local:site", count: 1 + Math.floor(rnd() * 9), lastEndedAt: "2026-08-10T00:00:00.000Z" });
        }
      }
    }
    const triggers = [];
    names.forEach((nm, i) => {
      if (rnd() < 0.5) triggers.push({ type: "cron", index: triggers.length, id: "t" + i, pattern: "0 3 * * *", folder: "/srv/site", flow: nm, model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false });
    });
    const model = { ...FAN(), triggers: { triggers }, folderSkills: { "/srv/site": { head: "a", truncated: false, unreachable: null, skills } }, chainEdges: { edges, refusals: {}, truncated: false } };
    const layout = layoutOf(buildGraphModel(model));
    const dense = new Map(layout.wires.map((w) => [w.id, densePath(w.d)]));
    for (const w of layout.wires.filter((x) => x.label !== null && x.labelHidden !== true && !x.self)) {
      const anchors = [[w.labelX, w.labelY - 9], [w.labelX, w.labelY + 3]];
      const dist = (pts) => Math.min(...anchors.flatMap(([ax, ay]) => pts.map((q) => Math.hypot(q[0] - ax, q[1] - ay))));
      const own = dist(dense.get(w.id));
      assert.ok(own <= 16.5, `scene ${it}: label of ${w.id} sits ${own.toFixed(1)} from its own wire`);
      for (const o of layout.wires) {
        if (o.id === w.id || (o.from === w.from && o.to === w.to)) continue;
        const d = dist(dense.get(o.id));
        assert.ok(d >= own, `scene ${it}: label of ${w.id} is nearer wire ${o.id} (${d.toFixed(1)}) than its own (${own.toFixed(1)})`);
      }
      checked++;
    }
  }
  assert.ok(checked > 100, `${checked} labels checked`);
});
