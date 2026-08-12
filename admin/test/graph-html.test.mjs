import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildGraphHtml, layoutGraph, GRAPH_HTML_KINDS } from "../src/graph-html.mjs";
import { buildGraphModel, GRAPH_EDGE_KINDS } from "../src/graph-model.mjs";

const NOW = 1770000000000;

// The same canned deployment graph-model.test.mjs uses, built THROUGH buildGraphModel: the HTML
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
  forgeRepos: { github: ["acme/website", "acme/api"] },
  cronStats: { byId: { nightly: { runs: 41, lastOutcome: "completed", lastEndedAt: "2026-08-11T00:00:00.000Z" }, gone: { runs: 0, lastOutcome: null, lastEndedAt: null } } },
  runJoin: { byIndex: { 1: { runs: 12, lastOutcome: "completed", lastEndedAt: "2026-08-11T01:00:00.000Z" } }, unattributed: 2 },
  chainEdges: { edges: [{ parentFlow: "build-report", childFlow: "notify", target: "local:site", count: 3, lastEndedAt: "2026-08-10T00:00:00.000Z" }], refusals: { "build-report": 1 }, truncated: false },
  caps: { chainDepthMax: 1, chainMaxPerJob: 2, windowDays: 30 },
  nowMs: NOW,
});

const cannedHtml = () => buildGraphHtml(buildGraphModel(CANNED()), { now: NOW });

// ---- 1. purity ----

test("graph-html.mjs is fully pure: no module loads, no clock, no randomness, no environment", () => {
  // FIRST, per the render.mjs/costs.mjs/graph-model.mjs doctrine. The bans are substring-level on
  // purpose: the page script embedded in this module is still module source, so even IT may not
  // spell the static clock accessor (it reads the clock via new Date().getTime() instead).
  const src = readFileSync(fileURLToPath(new URL("../src/graph-html.mjs", import.meta.url)), "utf8");
  assert.ok(!src.includes("import"), "no module loads of any kind, not even node: builtins");
  assert.ok(!src.includes("require("), "no CJS loads either");
  assert.ok(!src.includes("Date.now"), "the generation instant is injected as `now`, never read");
  assert.ok(!src.includes("Math.random"), "determinism is the test one block down");
  assert.ok(!/process\./.test(src), "no environment access");
});

// ---- 2. kind parity ----

test("GRAPH_HTML_KINDS is the assembler's GRAPH_EDGE_KINDS, byte for byte, frozen", () => {
  // The HTML module may not use the `from` clause, so this test IS the anti-drift wire: a kind
  // minted in graph-model without a drawing arm here must go red, not render as nothing.
  assert.deepEqual([...GRAPH_HTML_KINDS], [...GRAPH_EDGE_KINDS]);
  assert.ok(Object.isFrozen(GRAPH_HTML_KINDS));
});

// ---- 3. escaping / breakout ----

test("hostile trigger and flow strings cannot break out of markup or the embedded json", () => {
  const inputs = CANNED();
  // The comment phrase lands verbatim in the trigger's display label; the flow name fails
  // SKILL_NAME_RE so it travels the charset-invalid path into a node name and a flag detail.
  inputs.triggers.triggers.push({ type: "comment", index: 3, phrase: '"><script>alert(1)</script>', any: [], all: [], none: [], flow: "x", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" });
  inputs.triggers.triggers.push({ type: "cron", index: 4, id: "evil", pattern: "0 5 * * *", folder: "/srv/site", flow: "</script><script>evil()", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false });
  const out = buildGraphHtml(buildGraphModel(inputs), { now: NOW });

  assert.equal(out.split("<script").length - 1, 1, "exactly ONE script open tag: the page's own");
  assert.equal(out.split("</script").length - 1, 1, "and exactly one close: nothing embedded can spell it");
  assert.ok(!out.includes("<script>alert"), "the attack string never appears unescaped");
  assert.ok(out.includes("&lt;script&gt;") || out.includes("&lt;/script&gt;"), "it appears as entities instead");
  assert.ok(out.includes("\\u003c"), "the embedded json carries < as an escape, never a literal");
});

// ---- 4. determinism ----

test("same model + same now is byte-identical, and input array order is irrelevant", () => {
  const model = buildGraphModel(CANNED());
  assert.equal(buildGraphHtml(model, { now: NOW }), buildGraphHtml(model, { now: NOW }));

  const permuted = buildGraphModel(CANNED());
  permuted.nodes.reverse();
  permuted.edges.reverse();
  permuted.flags.reverse();
  permuted.folders.reverse();
  assert.equal(buildGraphHtml(permuted, { now: NOW }), buildGraphHtml(model, { now: NOW }), "normalisation sorts everything; a permuted model may not move a byte");
});

// ---- 5. well-formedness smoke ----

test("the page is balanced, finite, and every path d stays inside the SVG path grammar", () => {
  const out = cannedHtml();
  assert.equal(out.split("<svg").length, out.split("</svg>").length, "balanced <svg>");
  assert.equal((out.match(/<g[ >]/g) ?? []).length, (out.match(/<\/g>/g) ?? []).length, "balanced <g>");
  for (const word of ["NaN", "undefined", "Infinity"]) {
    assert.ok(!out.includes(word), `a non-finite value leaked into the page as ${word}`);
  }
  const vb = /viewBox="([^"]+)"/.exec(out);
  assert.ok(vb, "the main svg carries a viewBox");
  const nums = vb[1].split(" ").map(Number);
  assert.equal(nums.length, 4);
  assert.ok(nums.every(Number.isFinite), "viewBox is four finite numbers");
  const ds = [...out.matchAll(/ d="([^"]*)"/g)];
  assert.ok(ds.length > 0, "there are wires and dividers to check");
  for (const [, d] of ds) assert.match(d, /^[MmCcLlHhVvZzAaQq0-9eE .,+-]+$/, `path grammar violated: ${d}`);
  assert.ok(out.includes('role="img" aria-label="pi-dispatch trigger and flow graph"'));
});

// ---- 6. layout invariants ----

test("layoutGraph: finite coords, left-to-right wires, group containment, no overlaps", () => {
  const layout = layoutGraph(buildGraphModel(CANNED()));
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
  const layout = layoutGraph(buildGraphModel(CANNED()));
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
  const layout = layoutGraph(buildGraphModel(inputs));
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

// ---- 6c. loop-in-skill groups ----

test("a skill with loops becomes a group: chip inside the box, marker with hint, ring inside, ports untouched", () => {
  const layout = layoutGraph(buildGraphModel(CANNED()));
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
  const layout = layoutGraph(buildGraphModel(CANNED()));
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
  const out = cannedHtml();
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
  const bare = buildGraphHtml(buildGraphModel(inputs), { now: NOW });
  assert.ok(bare.includes("github · forge · unverifiable from this host"));
  assert.ok(!bare.includes("ran against"));
});

// ---- 7. content canary ----

test("an unexpected model field and a folder's absolute path never reach the page", () => {
  const inputs = CANNED();
  inputs.folderSkills["/Users/someone/private"] = {
    head: "def456",
    truncated: false,
    unreachable: null,
    skills: [{ name: "solo", isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], unread: false }],
  };
  const model = buildGraphModel(inputs);
  model.nodes[0].secret = "CANARY-9f3"; // a field no allowlist names; a spread would leak it
  const out = buildGraphHtml(model, { now: NOW });
  assert.ok(!out.includes("CANARY-9f3"), "unknown fields must be structurally unreachable, not merely unused");
  assert.ok(!out.includes("/Users/someone/private"), "groups render their label (basename) by DEFAULT, never group.path");
  assert.ok(out.includes("private"), "the basename label itself still renders");

  // The twin: fullPaths is the operator's explicit opt-in, and then the path DOES render.
  const full = buildGraphHtml(model, { now: NOW, fullPaths: true });
  assert.ok(full.includes("/Users/someone/private"), "fullPaths: true labels local groups with their path");
  assert.ok(!full.includes("CANARY-9f3"), "the opt-in widens labels, not the allowlist");
});

// ---- 8. file:// posture ----

test("nothing on the page can reach outside the file", () => {
  const out = cannedHtml();
  for (const needle of ["src=", "<link", "url(", "@import", "fetch", "XMLHttpRequest", "innerHTML"]) {
    assert.ok(!out.includes(needle), `forbidden over file://: ${needle}`);
  }
});

// ---- 9. state twins ----

test("orphan dash, potential-vs-observed labels, the caps digits, and honesty counters", () => {
  const out = cannedHtml();
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
  assert.ok(buildGraphHtml(dropped, { now: NOW }).includes("4 observed edges dropped"), "dropped-edge counter renders when set");

  // Schedule facts in the tips (issue #181): with the terminal views gone this page is the last
  // surface REQ-TOPOLOGY-GRAPH (h) has. The canned scheduler's next fire sits 191 days past NOW.
  assert.ok(out.includes("next 191d"), "a cron tip counts down to the resident scheduler's next fire");
  const overdue = buildGraphModel(CANNED());
  const cron = overdue.nodes.find((n) => n.id === "trigger:0");
  cron.overdueMs = 2 * 3600_000;
  assert.ok(buildGraphHtml(overdue, { now: NOW }).includes("overdue 2h"), "overdue outranks the countdown");

  // The two counters the text and TUI surfaces always stated and this page dropped (issue #175):
  // three surfaces of one model must not disagree about what was refused or unreadable.
  assert.ok(out.includes("1 chain requests refused (caps or gate)"), "the canned refusals reach the legend");
  const unreadable = buildGraphModel(CANNED());
  unreadable.meta.injectedUnreachable = ["/inj"];
  assert.ok(buildGraphHtml(unreadable, { now: NOW }).includes("injected skills dir unreadable: /inj"), "the unreadable-dir counter renders when set");
});

// ---- 10. refresh features ----

test("reload, auto-reload, staleness stamp, and hash view-state are wired without any fetching", () => {
  const out = cannedHtml();
  assert.ok(out.includes(">Reload</button>"));
  for (const opt of [">off<", ">5s<", ">30s<"]) assert.ok(out.includes(opt), `auto-reload option ${opt}`);
  assert.ok(out.includes("location.reload"));
  assert.ok(out.includes("location.hash"), "view state survives a reload via the hash");
  assert.ok(out.includes(`GENERATED_AT = ${NOW}`), "the staleness stamp compares against the baked-in generation instant");
  assert.ok(out.includes("setInterval"));
  assert.ok(!out.includes("fetch"), "refresh means reloading regenerated bytes, never fetching");
});

// ---- 10b. page-script hardening (the page cannot run under node:test, so these are the strongest
// claims the emitted string supports: the exact guard/mapping expressions, plus a parse check) ----

test("the page script letterbox-maps the cursor, survives a pan without wiping selection, and guards GRAPH.nodes", () => {
  const out = cannedHtml();
  const script = /<script>([\s\S]*?)<\/script>/.exec(out)[1];

  // meet letterboxing: a uniform scale (min of the two ratios) plus centring offsets; the
  // per-axis ratios this replaced panned at the wrong speed whenever the aspects differed.
  assert.ok(script.includes("Math.min(r.width / vb.width, r.height / vb.height)"), "uniform meet scale");
  assert.ok(script.includes("(r.width - vb.width * s) / 2"), "letterbox x offset");
  assert.ok(script.includes("(r.height - vb.height * s) / 2"), "letterbox y offset");

  // pan-then-click: pointer capture retargets the post-pan click at the svg, which reads as a
  // background click; a drag beyond the threshold must swallow it or every pan clears the selection.
  assert.ok(script.includes("panning.moved > 3"), "drag threshold present");
  assert.ok(script.includes("suppressClick"), "the following click is suppressed");

  // prototype-chain ids: #sel=constructor must die at the guard, not at a .nb dereference.
  assert.ok(script.includes("Object.prototype.hasOwnProperty.call(GRAPH.nodes, id)"), "own-property guard present");
  assert.equal((script.match(/GRAPH\.nodes\[/g) ?? []).length, 1, "exactly one raw indexed read of GRAPH.nodes: the one inside the guard");

  new Function(script); // parse check: a syntax break in the emitted script goes red here, not in a browser
});

// ---- 11. degrades ----

test("no arguments and degraded models still produce a valid page that says what is wrong", () => {
  const bare = buildGraphHtml();
  assert.ok(bare.startsWith("<!doctype html>"));
  assert.ok(bare.includes("<title>pi-dispatch graph</title>"));
  assert.ok(bare.includes("no graph model supplied"));

  const missing = buildGraphHtml(buildGraphModel({ triggers: { missing: true } }), { now: NOW });
  assert.ok(missing.includes("no triggers file found"));

  const invalid = buildGraphHtml(buildGraphModel({ triggers: { invalid: "bad json" } }), { now: NOW });
  assert.ok(invalid.includes("triggers file invalid: bad json"));

  for (const junk of [null, 42, "x", { nodes: "no", edges: 7, folders: null, flags: false }]) {
    const page = buildGraphHtml(junk, { now: NOW });
    assert.ok(page.includes("<svg"), "malformed input still yields a page, never a throw");
  }
});
