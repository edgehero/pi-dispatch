/**
 * The Node-RED-style HTML page for the trigger/flow graph (issue #54): one fully self-contained
 * document (inline CSS, inline SVG, ONE inline script, zero external references) that works over
 * file:// with nothing listening anywhere. Pure in the render.mjs/costs.mjs sense and then some:
 * this module pulls in nothing at all, not even node: builtins, and the source-regex guard that
 * keeps render.mjs honest also keeps this one byte-deterministic -- no clock reads, no randomness, no
 * environment. The clock the page needs at view time is read by the PAGE script in the browser
 * (via new Date().getTime(); the static clock accessor is banned from this source by the purity
 * test), and the generation instant is injected by the caller as `now`.
 *
 * Layout is a hand-rolled Sugiyama-lite rather than a graph library: the dependency posture of the
 * repo is hand-roll-or-argue, and the graphs here are folder-local and tiny (a handful of triggers
 * and skills), so longest-path ranking plus two median sweeps buys everything dagre would and stays
 * auditable. The visual language is authentic Node-RED chips (pale category fills, dark labels,
 * 20px grid, 10x10 ports) on the repo's dark chrome: Node-RED authenticity is shape language, the
 * page around it stays consistent with docs/images/banner.svg.
 */

// Must equal graph-model.mjs's GRAPH_EDGE_KINDS; a parity test in graph-html.test.mjs compares the
// two literals. Duplicated rather than re-exported because this module is allowed no dependencies
// at all: the parity test is the anti-drift wire the missing `from` clause would otherwise be.
export const GRAPH_HTML_KINDS = Object.freeze(["config", "observed", "potential", "cron-rearm"]);

// ---- geometry (Node-RED editor constants where they exist, repo choices where they do not) ----
const NODE_H = 30; // Node-RED node height
const NODE_MIN_W = 100; // Node-RED minimum node width
const GRID = 20; // widths snap to the 20px grid, like the editor
// Width cap: every chip must fit inside one RANK_PITCH column with room for a wire, otherwise the
// left-to-right layout invariant (source right edge before target left edge) could not be promised.
// Node-RED instead measures the label on a canvas; there is no DOM here, so labels are clipped.
const NODE_MAX_W = 160;
const CHAR_W = 8; // 14px label estimate; over-estimating keeps text inside the chip
const LABEL_X = 38; // label x, past the 30px icon column and its divider
const CHIP_MAX_CHARS = 14; // what fits at NODE_MAX_W: (160 - 38 - 10) / CHAR_W
const RANK_PITCH = 180; // fixed column pitch
const ROW_GAP = 26; // vertical gap between rows (leaves room for the status line under a chip)
const GROUP_PAD_L = 20;
const GROUP_PAD_R = 20;
const GROUP_PAD_T = 40; // room for the group label above the first row
const GROUP_PAD_B = 44; // breathing room below the last row band (under-route depth is paid per band)
const GROUP_GAP = 40; // folder groups stack vertically with this gap
const SELF_LOOP_DROP = 25; // Node-RED self-wires drop this far below the node
// Extra pitch below any row band hosting an under-row route (self-loop or back edge): the route
// needs SELF_LOOP_DROP plus a label (~37px past the chip bottom), which ROW_GAP alone cannot
// absorb -- without this, a folder with two cron triggers drew the first re-arm label inside the
// second trigger's chip.
const UNDER_ROUTE_EXTRA = 40;
// Parallel-wire fan-out: an observed edge and a potential mention often join the SAME pair of
// skills, and without an offset the two beziers overlay and their mid-path labels garble into one
// smear. Sibling 0 stays straight; each later sibling bows alternately up/down by 14px at the
// control points, and its label steps 10.5px (0.75 of the bow: a cubic's midpoint moves 3/4 of a
// shared control offset) so every label rides its own curve and anchors stay 10px apart.
const PARALLEL_BOW = 14;
const PARALLEL_LABEL_STEP = 10.5;
// A wire spanning under 40px has its midpoint hugging the ports, so its label lifts above the
// wire (siblings stacking further up) instead of sitting on the port squares and the wire itself.
const LABEL_MIN_SPAN = 40;
// Skill-group (loop-in-skill) geometry: the Node-RED group treatment around a skill whose SKILL.md
// iterates (prose-loop hints) or which owns sub-skills. The chip keeps its ports and every external
// wire -- the box, the ⟳ markers and the ring wire only VISUALISE that the looping lives inside
// this one node's job (one trigger = one job = one budget slot; the loop never leaves the node),
// which is why the group is not itself a node and draws no edge anywhere.
const SG_CHIP_X = 22; // chip inset: the ring at inset 10, the 5px input-port overhang, some air
const SG_CHIP_Y = 26; // chip sits below the group's own label line
const SG_RING = 10; // the loop wire's inset from the box edge
const SG_MARKER = 40; // the ⟳ marker square
const SG_HINT_CHARS = 24; // loop-hint clip; small text at ~6px/char sizes the box
const SG_SMALL_CHAR_W = 6;
const SUB_CHIP_H = 24; // nested sub-skill chips are deliberately smaller than real nodes
const VIEW_MARGIN = 80; // viewBox margin around the content bbox

// ---- palette: repo-dark chrome, authentic pale Node-RED chips with DARK labels inside ----
const PAGE_CANVAS = "#0d1117";
const PAGE_PANEL = "#161b22";
const PAGE_BORDER = "#30363d";
const PAGE_FG = "#c9d1d9";
const PAGE_DIM = "#8b949e";
const PAGE_ACCENT = "#58a6ff";
const PAGE_AMBER = "#d29922";
const CHIP_STROKE = "#999";
const CHIP_LABEL = "#333";
const PORT_FILL = "#d9d9d9";
const CHIP_FILL = Object.freeze({
  cron: "#a6bbcf",
  label: "#d8bfd8",
  comment: "#e7e7ae",
  pull_request: "#c0deed",
  skill: "#fdd0a2",
});
const STATUS_COMPLETED = "#3fb950";
const STATUS_FAILED = "#ff5f57";
const STATUS_OTHER = "#6e7681";
const BADGE_ORANGE = "#db6d28";
const BADGE_GREEN = "#3fb950";
const DANGER = "#f85149";
const GROUP_FILL = "#E6E0F8";
const WIRE_OBSERVED = "#999";
const WIRE_CONFIG = "#6e7681";
const WIRE_POTENTIAL = "#8b949e";

// One glyph per node kind for the 30px icon column; characters, not images, because images would
// need data: URIs and a font would need @font-face, both of which the file:// posture forbids.
const GLYPH = Object.freeze({
  cron: "◷",
  label: "◈",
  comment: "❝",
  pull_request: "⇄",
  skill: "ƒ",
  "skill-missing": "!",
  "skill-unverified": "?",
  injected: "+",
});

// The 5-entity escape, byte-for-byte the worker's buildFormPage helper: every string interpolated
// into markup goes through this, operator-authored or not, because "charset-bound upstream" is an
// assumption and an entity is a guarantee.
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// JSON destined for the inline script: `<` becomes < so no value can spell `</script>` and
// break out of the script element, and U+2028/2029 become escapes because they are line
// terminators to a JS parser while being invisible to JSON.
function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Every number that reaches markup goes through this: a non-finite value becomes 0 rather than
// serialising as one of the three words the well-formedness test bans outright.
function fmt(v) {
  const n = Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
  return String(n);
}

function finOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function intOr(v, fallback) {
  return Number.isInteger(v) ? v : fallback;
}

function strOr(v, fallback) {
  return typeof v === "string" && v !== "" ? v : fallback;
}

function clip(s, max) {
  const t = String(s);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Defensive normalisation, applied before anything else: explicit field allowlists (never a spread,
 * so an unexpected field on a model object -- or a folder's absolute host `path` -- structurally
 * cannot reach the page) and a total sort of every array, so a permuted input yields byte-identical
 * output. Node/folder identities are NOT carried through: original ids embed folder paths
 * (`skill:folder:/abs/path:name`), so the layout mints ordinal ids (`n0`, `g0`, `w0`) and the
 * originals stay server-side.
 */
function normalizeModel(model) {
  const ok = model !== null && typeof model === "object";
  const m = ok ? model : {};

  const caps = {
    chainDepthMax: intOr(m.caps?.chainDepthMax, null),
    chainMaxPerJob: intOr(m.caps?.chainMaxPerJob, null),
    sameFolderOnly: m.caps?.sameFolderOnly !== false,
    windowDays: intOr(m.caps?.windowDays, null),
  };
  const meta = {
    generatedAt: finOr(m.meta?.generatedAt, null),
    triggersMissing: m.meta?.triggersMissing === true,
    triggersInvalid: typeof m.meta?.triggersInvalid === "string" ? m.meta.triggersInvalid : null,
    unattributedRuns: intOr(m.meta?.unattributedRuns, 0),
    droppedObservedEdges: intOr(m.meta?.droppedObservedEdges, 0),
    truncated: {
      folders: m.meta?.truncated?.folders === true,
      skills: m.meta?.truncated?.skills === true,
      edges: m.meta?.truncated?.edges === true,
    },
  };

  const folders = [];
  for (const f of Array.isArray(m.folders) ? m.folders : []) {
    if (!f || typeof f !== "object" || typeof f.key !== "string") continue;
    folders.push({
      key: f.key,
      label: strOr(f.label, "(folder)"),
      // The absolute host path rides the model but is RENDERED only under { fullPaths: true } (an
      // operator opt-in); the default page stays basename-only, so a shared screenshot or artifact
      // cannot leak home-directory names -- the canary test pins the default.
      path: typeof f.path === "string" ? f.path : null,
      kind: f.kind === "forge" ? "forge" : "local",
      head: typeof f.head === "string" ? f.head : null,
      unreachable: typeof f.unreachable === "string" ? f.unreachable : null,
      // Record-derived scope for forge groups ("which repos is this group even about"); already
      // id-only repo#n-style strings upstream, clipped and capped again here anyway.
      repos: Array.isArray(f.repos) ? f.repos.slice(0, 5).filter((r) => typeof r === "string").map((r) => clip(r, 60)) : [],
    });
  }
  folders.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const nodes = [];
  const seen = new Set();
  for (const n of Array.isArray(m.nodes) ? m.nodes : []) {
    if (!n || typeof n !== "object" || typeof n.id !== "string" || seen.has(n.id)) continue;
    seen.add(n.id);
    nodes.push({
      id: n.id,
      kind: typeof n.kind === "string" ? n.kind : "skill",
      name: typeof n.name === "string" ? n.name : null,
      label: typeof n.label === "string" ? n.label : null,
      onType: typeof n.onType === "string" ? n.onType : null,
      pattern: typeof n.pattern === "string" ? n.pattern : null,
      flow: typeof n.flow === "string" ? n.flow : null,
      replicas: intOr(n.replicas, null),
      folderKey: typeof n.folderKey === "string" ? n.folderKey : null,
      runs: intOr(n.runs, 0),
      lastOutcome: typeof n.lastOutcome === "string" ? n.lastOutcome : null,
      lastEndedAt: typeof n.lastEndedAt === "string" || Number.isFinite(n.lastEndedAt) ? n.lastEndedAt : null,
      isSub: n.isSub === true,
      group: typeof n.group === "string" ? n.group : null,
      // Prose-loop hints from the SKILL.md body; capped and clipped so a hostile skill cannot
      // inflate its own group box into a page-filling banner.
      loops: Array.isArray(n.loops)
        ? n.loops.slice(0, 3).flatMap((l) => (typeof l?.hint === "string" && l.hint !== "" ? [{ hint: clip(l.hint, 80) }] : []))
        : [],
      aiTrigger: n.aiTrigger === true,
      unread: n.unread === true,
      description: typeof n.meta?.description === "string" ? clip(n.meta.description, 120) : null,
    });
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const edges = [];
  for (const e of Array.isArray(m.edges) ? m.edges : []) {
    if (!e || typeof e !== "object") continue;
    if (typeof e.from !== "string" || typeof e.to !== "string") continue;
    if (!GRAPH_HTML_KINDS.includes(e.kind)) continue; // an unknown kind is never drawn, per contract
    edges.push({
      from: e.from,
      to: e.to,
      kind: e.kind,
      count: intOr(e.count, null),
      strong: e.strong === true,
      eligible: e.eligible === true,
      label: typeof e.label === "string" ? e.label : null,
    });
  }
  edges.sort((a, b) => cmpStr(a.kind, b.kind) || cmpStr(a.from, b.from) || cmpStr(a.to, b.to) || cmpStr(a.label ?? "", b.label ?? "") || (a.count ?? -1) - (b.count ?? -1) || (a.strong ? 1 : 0) - (b.strong ? 1 : 0));

  const flags = [];
  for (const f of Array.isArray(m.flags) ? m.flags : []) {
    if (!f || typeof f !== "object" || typeof f.nodeId !== "string" || typeof f.flag !== "string") continue;
    flags.push({ nodeId: f.nodeId, flag: f.flag, detail: typeof f.detail === "string" ? clip(f.detail, 160) : null });
  }
  flags.sort((a, b) => cmpStr(a.nodeId, b.nodeId) || cmpStr(a.flag, b.flag) || cmpStr(a.detail ?? "", b.detail ?? ""));

  return { ok, folders, nodes, edges, flags, caps, meta };
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- layout ----

function chipLabel(n) {
  if (n.kind === "trigger") return clip(n.label ?? n.onType ?? "trigger", CHIP_MAX_CHARS);
  return clip(n.name ?? "(unnamed)", CHIP_MAX_CHARS);
}

function chipWidth(label) {
  const raw = LABEL_X + label.length * CHAR_W + 12;
  const snapped = Math.ceil(raw / GRID) * GRID;
  return Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, snapped));
}

/**
 * Place the normalised model: one Node-RED group rect per folder, triggers at rank 0 inside it,
 * skills ranked by longest path over config/observed/potential edges, rows ordered by two median
 * sweeps with an alphabetical tiebreak (no randomness anywhere -- determinism is a test). Exported
 * so the layout invariants (left-to-right wires, group containment, no overlaps) are testable
 * without parsing SVG back out of the page.
 */
export function layoutGraph(model) {
  return layoutNormalized(normalizeModel(model));
}

function layoutNormalized(norm) {
  const empty = { nodes: [], wires: [], groups: [], skillGroups: [], viewBox: { x: 0, y: 0, w: 800, h: 600 } };
  if (!norm.ok && norm.nodes.length === 0) return empty;

  // Groups: every folder from the model, in sorted-key order, then synthetic homes for nodes the
  // folders do not claim (injected skills carry no folder; a defensive bucket catches the rest so a
  // malformed node still draws somewhere instead of vanishing).
  const groups = [];
  const groupIndexByKey = new Map();
  const addGroup = (key, label, kind, head, unreachable, path, repos) => {
    const g = { id: `g${groups.length}`, label, kind, head, unreachable, path: path ?? null, repos: repos ?? [], members: [], x: 0, y: 0, w: 0, h: 0 };
    groups.push(g);
    groupIndexByKey.set(key, g);
    return g;
  };
  for (const f of norm.folders) addGroup(f.key, f.label, f.kind, f.head, f.unreachable, f.path, f.repos);

  const placed = [];
  const placedByOrig = new Map();
  for (const n of norm.nodes) {
    const label = chipLabel(n);
    const p = { id: `n${placed.length}`, kind: n.kind, label, x: 0, y: 0, w: chipWidth(label), h: NODE_H, groupId: null, node: n };
    placed.push(p);
    placedByOrig.set(n.id, p);
    let g = n.folderKey === null ? null : (groupIndexByKey.get(n.folderKey) ?? null);
    if (!g && n.kind === "injected") g = groupIndexByKey.get("~injected") ?? addGroup("~injected", "injected skills (run.skillsDir)", "local", null, null);
    if (!g) g = groupIndexByKey.get(n.folderKey ?? "~ungrouped") ?? addGroup(n.folderKey ?? "~ungrouped", "ungrouped", "local", null, null);
    g.members.push(p);
    p.groupId = g.id;
  }

  // Wires: normalised edges whose endpoints exist. Self edges route as loops; cyclic back edges
  // (found by a deterministic DFS) are excluded from ranking and routed under the rows, because a
  // rank function cannot satisfy a cycle and refusing to draw the edge would hide a real fact.
  const wires = [];
  for (const e of norm.edges) {
    const f = placedByOrig.get(e.from);
    const t = placedByOrig.get(e.to);
    if (!f || !t) continue;
    wires.push({ id: `w${wires.length}`, kind: e.kind, from: f.id, to: t.id, self: f === t, back: false, edge: e, f, t, d: "", labelX: 0, labelY: 0 });
  }
  markBackEdges(placed, wires);

  // Rank + order + coordinates, one group at a time; groups then stack vertically. Skill groups
  // (loop-in-skill boxes) are collected with folder-local coords and translated alongside the
  // members they contain.
  const skillGroups = [];
  let groupY = 0;
  let maxGroupW = 0;
  for (const g of groups) {
    const sgStart = skillGroups.length;
    const size = layoutGroup(g, wires, skillGroups);
    g.x = 0;
    g.y = groupY;
    g.w = size.w;
    g.h = size.h;
    for (const p of g.members) {
      p.x += g.x;
      p.y += g.y;
    }
    for (let i = sgStart; i < skillGroups.length; i++) {
      const sg = skillGroups[i];
      sg.x += g.x;
      sg.y += g.y;
      for (const m of sg.markers) {
        m.x += g.x;
        m.y += g.y;
        m.hintX += g.x;
        m.hintY += g.y;
      }
      sg.points = sg.points.map(([px, py]) => [px + g.x, py + g.y]);
      sg.d = sg.points.map(([px, py], j) => `${j === 0 ? "M" : "L"} ${fmt(px)} ${fmt(py)}`).join(" ");
    }
    groupY += g.h + GROUP_GAP;
    if (g.w > maxGroupW) maxGroupW = g.w;
  }

  // Sibling index among wires sharing one (from, to) pair, assigned in the already-sorted wire
  // order (kind first), so the observed edge keeps the straight path and the potential mention
  // bows around it -- deterministically, whatever order the model arrived in.
  const parallelCount = new Map();
  for (const w of wires) {
    const key = `${w.from} ${w.to}`;
    w.parallel = parallelCount.get(key) ?? 0;
    parallelCount.set(key, w.parallel + 1);
  }

  for (const w of wires) routeWire(w);
  for (const w of wires) {
    delete w.f;
    delete w.t;
  }

  const totalH = groups.length > 0 ? groupY - GROUP_GAP : 0;
  const viewBox = groups.length > 0
    ? { x: -VIEW_MARGIN, y: -VIEW_MARGIN, w: maxGroupW + VIEW_MARGIN * 2, h: totalH + VIEW_MARGIN * 2 }
    : { x: 0, y: 0, w: 800, h: 600 };
  return { nodes: placed, wires, groups, skillGroups, viewBox };
}

// Iterative DFS in sorted order; an edge landing on a node still on the stack is a back edge.
// Iterative rather than recursive so a hostile model cannot overflow the stack.
function markBackEdges(placed, wires) {
  const out = new Map();
  for (const w of wires) {
    if (w.self) continue;
    if (!out.has(w.from)) out.set(w.from, []);
    out.get(w.from).push(w);
  }
  for (const list of out.values()) list.sort((a, b) => cmpStr(a.to, b.to) || cmpStr(a.id, b.id));
  const state = new Map(); // 1 = on stack, 2 = done
  for (const p of placed) {
    if (state.has(p.id)) continue;
    const stack = [{ id: p.id, i: 0 }];
    state.set(p.id, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const edges = out.get(top.id) ?? [];
      if (top.i >= edges.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const w = edges[top.i++];
      const s = state.get(w.to);
      if (s === 1) w.back = true;
      else if (s !== 2) {
        state.set(w.to, 1);
        stack.push({ id: w.to, i: 0 });
      }
    }
  }
}

function layoutGroup(g, allWires, sgOut) {
  const members = g.members;
  if (members.length === 0) return { w: GROUP_PAD_L + NODE_MAX_W + GROUP_PAD_R, h: GROUP_PAD_T + GROUP_PAD_B };

  // Sub-skills nest inside their parent skill's group box instead of taking a grid cell; a sub
  // whose parent is not in this folder falls back to the grid so it still draws somewhere.
  const subsByParent = new Map();
  const grid = [];
  for (const p of members) {
    if (p.node.isSub && typeof p.node.group === "string") {
      if (!subsByParent.has(p.node.group)) subsByParent.set(p.node.group, []);
      subsByParent.get(p.node.group).push(p);
    } else {
      grid.push(p);
    }
  }
  const parentByName = new Map();
  for (const p of grid) {
    if (p.kind === "skill" && p.node.name !== null && !parentByName.has(p.node.name)) parentByName.set(p.node.name, p);
  }
  for (const [name, subs] of subsByParent) {
    if (!parentByName.has(name)) for (const s of subs) grid.push(s);
  }

  // A skill with prose-loop hints or nested sub-skills becomes a Node-RED GROUP: its own chip, one
  // ⟳ marker per hint, the sub chips, and a ring wire, all inside one tinted box that joins the
  // rank grid as a super-node. Containment is visual only -- the chip keeps its ports and every
  // external wire, because the group is not a node and the loop never leaves the job.
  const supers = new Map();
  for (const p of grid) {
    if (p.kind !== "skill") continue;
    const subs = parentByName.get(p.node.name) === p ? (subsByParent.get(p.node.name) ?? []) : [];
    if (p.node.loops.length === 0 && subs.length === 0) continue;
    supers.set(p.id, computeSkillGroup(p, p.node.loops, subs));
  }
  const effW = (p) => (supers.has(p.id) ? supers.get(p.id).w : p.w);
  const effH = (p) => (supers.has(p.id) ? supers.get(p.id).h : p.h);

  const gridSet = new Set(grid.map((p) => p.id));
  const rankEdges = allWires.filter((w) => !w.self && !w.back && gridSet.has(w.from) && gridSet.has(w.to));

  // Longest-path ranks: triggers pinned at column 0, everything else starts one column in and is
  // pushed right by each edge. Relaxation is bounded by the member count, which suffices once back
  // edges are gone; a topological sort would be no cheaper for graphs this small.
  const rank = new Map();
  for (const p of grid) rank.set(p.id, p.kind === "trigger" ? 0 : 1);
  for (let i = 0; i < grid.length; i++) {
    let changed = false;
    for (const w of rankEdges) {
      if (w.t.kind === "trigger") continue; // triggers stay in column 0, whatever points at them
      const want = rank.get(w.from) + 1;
      if (rank.get(w.to) < want) {
        rank.set(w.to, want);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const maxRank = Math.max(...[...rank.values()]);
  const rows = [];
  for (let r = 0; r <= maxRank; r++) rows.push([]);
  for (const p of grid) rows[rank.get(p.id)].push(p);
  for (const row of rows) row.sort((a, b) => cmpStr(a.label, b.label) || cmpStr(a.id, b.id));
  orderRows(rows, rankEdges);

  // Columns stretch for super-boxes: RANK_PITCH is the minimum, and a rank's widest box plus a
  // wire gap wins when larger, so the forward left-to-right invariant survives boxes wider than
  // one chip (the fixed-pitch shortcut only held while every node was chip-sized).
  const rankMaxW = [];
  for (let r = 0; r <= maxRank; r++) rankMaxW.push(Math.max(NODE_MAX_W, ...rows[r].map(effW)));
  const colX = [GROUP_PAD_L];
  for (let r = 1; r <= maxRank; r++) colX.push(colX[r - 1] + Math.max(RANK_PITCH, rankMaxW[r - 1] + 20));

  // Row bands hosting an under-row route (a self-loop, or either end of a back edge) get extra
  // pitch below them. Band-wide rather than per rank, so rows stay grid-aligned and the back
  // edge's horizontal run -- which crosses ranks -- clears every chip in the bands below it, not
  // just the chips in its own column. Band height itself is the tallest box in the band, so a
  // skill group pushes the next band down instead of bleeding into it.
  const underIds = new Set();
  for (const w of allWires) {
    if (w.self && gridSet.has(w.from)) underIds.add(w.from);
    if (w.back) {
      if (gridSet.has(w.from)) underIds.add(w.from);
      if (gridSet.has(w.to)) underIds.add(w.to);
    }
  }
  const maxRows = Math.max(...rows.map((row) => row.length));
  const rowY = [];
  let y = GROUP_PAD_T;
  for (let i = 0; i < maxRows; i++) {
    rowY.push(y);
    const band = rows.flatMap((row) => (row.length > i ? [row[i]] : []));
    const bandH = Math.max(NODE_H, ...band.map(effH));
    const under = band.some((p) => underIds.has(p.id));
    y += bandH + (under ? UNDER_ROUTE_EXTRA : 0) + ROW_GAP;
  }

  for (let r = 0; r <= maxRank; r++) {
    for (let i = 0; i < rows[r].length; i++) {
      const p = rows[r][i];
      if (supers.has(p.id)) {
        placeSkillGroup(g, p, supers.get(p.id), colX[r], rowY[i], sgOut);
      } else {
        p.x = colX[r];
        p.y = rowY[i];
      }
    }
  }
  return {
    w: colX[maxRank] + rankMaxW[maxRank] + GROUP_PAD_R,
    h: y - ROW_GAP + GROUP_PAD_B,
  };
}

// Size a skill group's box in box-local coords: chip up top, one ⟳ marker (hint beside it) per
// loop, sub chips below, and the ring wire's anchor points threading output -> around the markers
// -> input. Sub chips are resized here (small, portless) -- their placed node object IS the chip.
function computeSkillGroup(p, loops, subs) {
  let cy = SG_CHIP_Y + NODE_H + 14;
  const markers = [];
  for (const l of loops.slice(0, 3)) {
    markers.push({ x: SG_CHIP_X, y: cy, w: SG_MARKER, h: SG_MARKER, hint: clip(l.hint, SG_HINT_CHARS), hintX: SG_CHIP_X + SG_MARKER + 6, hintY: cy + 24 });
    cy += SG_MARKER + 8;
  }
  const subPlaced = [];
  for (const s of subs) {
    const label = clip(s.node.name ?? "(sub)", 16);
    s.label = label;
    s.w = Math.min(140, Math.max(80, 12 + label.length * 7));
    s.h = SUB_CHIP_H;
    s.nested = true;
    subPlaced.push({ p: s, x: SG_CHIP_X, y: cy });
    cy += SUB_CHIP_H + 6;
  }
  const wCandidates = [SG_CHIP_X + p.w + 18];
  if (markers.length > 0) wCandidates.push(SG_CHIP_X + SG_MARKER + 6 + SG_HINT_CHARS * SG_SMALL_CHAR_W + 14);
  for (const s of subPlaced) wCandidates.push(SG_CHIP_X + s.p.w + 18);
  const w = Math.max(...wCandidates);
  const h = cy + 8;
  const py = SG_CHIP_Y + NODE_H / 2;
  const points = [
    [SG_CHIP_X + p.w, py],
    [w - SG_RING, py],
    [w - SG_RING, h - SG_RING],
    [SG_RING, h - SG_RING],
    [SG_RING, py],
    [SG_CHIP_X, py],
  ];
  return { w, h, markers, subPlaced, points };
}

// Place a sized skill group at its grid cell (folder-local coords); the translation to page
// coords happens with the rest of the folder in layoutNormalized.
function placeSkillGroup(g, p, box, x, y, sgOut) {
  p.x = x + SG_CHIP_X;
  p.y = y + SG_CHIP_Y;
  const markers = box.markers.map((m) => ({ ...m, x: m.x + x, y: m.y + y, hintX: m.hintX + x, hintY: m.hintY + y }));
  for (const s of box.subPlaced) {
    s.p.x = x + s.x;
    s.p.y = y + s.y;
  }
  sgOut.push({
    id: `sg${sgOut.length}`,
    groupId: g.id,
    nodeId: p.id,
    label: p.node.name ?? p.label,
    x,
    y,
    w: box.w,
    h: box.h,
    markers,
    subIds: box.subPlaced.map((s) => s.p.id),
    points: box.points.map(([px, py]) => [px + x, py + y]),
    d: "",
  });
}

// Two median sweeps (down over predecessors, up over successors), the deterministic core of the
// Sugiyama ordering step. Two, not the classic four-to-eight with transpose, because these graphs
// are a handful of rows deep and the extra sweeps buy nothing a test could observe.
function orderRows(rows, rankEdges) {
  const pos = new Map();
  const setPos = (row) => row.forEach((p, i) => pos.set(p.id, i));
  for (const row of rows) setPos(row);
  const preds = new Map();
  const succs = new Map();
  for (const w of rankEdges) {
    if (!preds.has(w.to)) preds.set(w.to, []);
    preds.get(w.to).push(w.from);
    if (!succs.has(w.from)) succs.set(w.from, []);
    succs.get(w.from).push(w.to);
  }
  const median = (ids) => {
    const xs = (ids ?? []).map((id) => pos.get(id)).filter((v) => Number.isInteger(v)).sort((a, b) => a - b);
    return xs.length === 0 ? null : xs[(xs.length - 1) >> 1];
  };
  const sweep = (nbrs, indices) => {
    for (const r of indices) {
      const keyed = rows[r].map((p, i) => ({ p, key: median(nbrs.get(p.id)) ?? i }));
      keyed.sort((a, b) => a.key - b.key || cmpStr(a.p.label, b.p.label) || cmpStr(a.p.id, b.p.id));
      rows[r] = keyed.map((k) => k.p);
      setPos(rows[r]);
    }
  };
  const down = [];
  const up = [];
  for (let r = 1; r < rows.length; r++) down.push(r);
  for (let r = rows.length - 2; r >= 0; r--) up.push(r);
  sweep(preds, down);
  sweep(succs, up);
}

function routeWire(w) {
  const f = w.f;
  const t = w.t;
  const y1 = f.y + NODE_H / 2;
  const y2 = t.y + NODE_H / 2;
  // Under-route control offset: 18, not the visually roomier 25-30, so a drop beside a full-width
  // chip (w = 160) stays strictly inside the 180px column pitch and can never graze the next
  // column's chips on its way down.
  const LOOP_OFF = 18;
  if (w.self) {
    // The Node-RED self-wire: out the output port, drop below the node, run under it, back up into
    // the input port. The label (a cron pattern, usually) sits under the loop where nothing else is
    // -- layoutGroup pays UNDER_ROUTE_EXTRA below this row band so that claim stays true.
    const x1 = f.x + f.w;
    const x2 = f.x;
    const yb = f.y + NODE_H + SELF_LOOP_DROP + w.parallel * 12;
    w.d = `M ${fmt(x1)} ${fmt(y1)} C ${fmt(x1 + LOOP_OFF)} ${fmt(y1)}, ${fmt(x1 + LOOP_OFF)} ${fmt(yb)}, ${fmt(x1)} ${fmt(yb)} L ${fmt(x2)} ${fmt(yb)} C ${fmt(x2 - LOOP_OFF)} ${fmt(yb)}, ${fmt(x2 - LOOP_OFF)} ${fmt(y2)}, ${fmt(x2)} ${fmt(y2)}`;
    w.labelX = f.x + f.w / 2;
    w.labelY = yb + 12;
    return;
  }
  if (w.back) {
    // A cycle survivor: routed under both rows rather than reversed, so the arrowless path still
    // reads left-of-target and the forward layout invariant stays honest for every other wire.
    const x1 = f.x + f.w;
    const x2 = t.x;
    const yb = Math.max(f.y, t.y) + NODE_H + SELF_LOOP_DROP + 10 + w.parallel * 12;
    w.d = `M ${fmt(x1)} ${fmt(y1)} C ${fmt(x1 + LOOP_OFF)} ${fmt(y1)}, ${fmt(x1 + LOOP_OFF)} ${fmt(yb)}, ${fmt(x1)} ${fmt(yb)} L ${fmt(x2)} ${fmt(yb)} C ${fmt(x2 - LOOP_OFF)} ${fmt(yb)}, ${fmt(x2 - LOOP_OFF)} ${fmt(y2)}, ${fmt(x2)} ${fmt(y2)}`;
    w.labelX = (x1 + x2) / 2;
    w.labelY = yb + 12;
    return;
  }
  // The Node-RED wire bezier: horizontal control offsets at 0.75 of the span, tightened when the
  // nodes are closer than 100px so short wires do not balloon. Parallel siblings (index > 0) bow
  // their control points alternately up/down so two wires between one pair never overlay.
  const x1 = f.x + f.w;
  const x2 = t.x;
  const dx = Math.max(x2 - x1, 4);
  const sc = dx < 100 ? 0.75 * (dx / 100) : 0.75;
  const off = Math.max(dx * sc, 10);
  const sign = w.parallel % 2 === 1 ? -1 : 1;
  const steps = Math.ceil(w.parallel / 2);
  const bow = sign * steps * PARALLEL_BOW;
  w.d = `M ${fmt(x1)} ${fmt(y1)} C ${fmt(x1 + off)} ${fmt(y1 + bow)}, ${fmt(x2 - off)} ${fmt(y2 + bow)}, ${fmt(x2)} ${fmt(y2)}`;
  w.labelX = (x1 + x2) / 2;
  if (x2 - x1 < LABEL_MIN_SPAN) {
    // Adjacent full-width chips leave a ~20px span: the midpoint hugs the port squares, so the
    // label lifts above the wire and siblings stack upward by a fixed pitch instead of bow-tracking.
    w.labelY = Math.min(y1, y2) - 12 - w.parallel * 12;
  } else {
    w.labelY = (y1 + y2) / 2 - 5 + sign * steps * PARALLEL_LABEL_STEP;
  }
}

// ---- server-side strings the page shows (tips, legend, banners) ----

function relTime(nowMs, v) {
  const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : null;
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return null;
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const mn = Math.floor(s / 60);
  if (mn < 60) return `${mn}m ago`;
  const h = Math.floor(mn / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// The hover tooltip content, prebuilt here so the page script never assembles markup: the client
// assigns these strings via textContent only, which is what makes "no innerHTML anywhere" testable
// as a plain substring ban.
function buildTip(n, flags, groupLabel, nowMs) {
  const lines = [];
  if (n.kind === "trigger") {
    lines.push(`trigger · ${n.onType ?? "?"} · ${n.label ?? ""}`.trim());
    if (n.flow !== null) lines.push(`flow: ${n.flow}${n.replicas !== null ? ` ×${n.replicas}` : ""}`);
  } else if (n.kind === "injected") {
    lines.push(`injected skill · ${n.name ?? "?"}`);
    lines.push("trigger-reachable via run.skillsDir, never AI-reachable");
  } else if (n.kind === "skill-missing") {
    lines.push(`skill · ${n.name ?? "?"} · missing at HEAD`);
  } else if (n.kind === "skill-unverified") {
    lines.push(`skill · ${n.name ?? "?"} · unverified (repo not readable from this host)`);
  } else {
    lines.push(`skill · ${n.name ?? "?"}${n.isSub ? " · sub-skill (never a flow)" : ""}`);
  }
  if (groupLabel !== null) lines.push(`folder: ${groupLabel}`);
  if (n.description !== null) lines.push(n.description);
  if (n.kind === "trigger") {
    if (n.runs > 0) {
      const rel = relTime(nowMs, n.lastEndedAt);
      lines.push(`runs: ${n.runs}${n.lastOutcome !== null ? ` · last ${n.lastOutcome}${rel !== null ? ` ${rel}` : ""}` : ""}`);
    } else {
      lines.push("no runs in window");
    }
  }
  if (n.aiTrigger) lines.push("chainable: ai-trigger allow");
  if (n.kind === "skill" && n.loops.length > 0) {
    lines.push(`loops in skill: ${n.loops.map((l) => l.hint).join(" · ")}`);
  }
  for (const f of flags) lines.push(f.detail !== null ? `${f.flag}: ${f.detail}` : f.flag);
  return lines.join("\n");
}

function groupTitle(g, fullPaths) {
  if (g.kind === "forge") {
    // Record-derived scope first, the unverifiable note kept: history says which repos this group
    // ran against, and nothing on this host can say more.
    const scope = Array.isArray(g.repos) && g.repos.length > 0 ? ` · ran against ${g.repos.join(", ")}` : "";
    return `${g.label}${scope} · forge · unverifiable from this host`;
  }
  const name = fullPaths === true && typeof g.path === "string" && g.path !== "" ? g.path : g.label;
  if (g.unreachable !== null && g.unreachable !== undefined && g.unreachable !== "") return `${name} · ${g.unreachable}`;
  if (g.head !== null && g.head !== undefined && g.head !== "") return `${name} · HEAD ${String(g.head).slice(0, 7)}`;
  return name;
}

function capsLineText(caps) {
  const d = caps.chainDepthMax ?? "?";
  const m = caps.chainMaxPerJob ?? "?";
  const k = caps.windowDays ?? "?";
  return `chains: depth ≤ ${d} · ≤ ${m} per job · same folder only · window ${k}d`;
}

// ---- SVG emission ----

const ORANGE_FLAGS = new Set(["unread", "injected-ai-trigger", "pr-spend-loop-risk"]);
const DANGLING_FLAGS = new Set(["no-skill", "charset-invalid"]);

function nodeState(n, flagNames) {
  if (n.kind === "skill-missing" || [...flagNames].some((f) => DANGLING_FLAGS.has(f))) {
    return { stroke: DANGER, dash: "10,4", faded: false };
  }
  if (n.kind === "skill-unverified") return { stroke: PAGE_DIM, dash: "10,4", faded: false };
  if (flagNames.has("orphan")) return { stroke: CHIP_STROKE, dash: "8,3", faded: true };
  return { stroke: CHIP_STROKE, dash: null, faded: false };
}

function chipFill(n) {
  if (n.kind === "trigger") return CHIP_FILL[n.onType] ?? PORT_FILL;
  return CHIP_FILL.skill;
}

function chipGlyph(n) {
  if (n.kind === "trigger") return GLYPH[n.onType] ?? "•";
  return GLYPH[n.kind] ?? GLYPH.skill;
}

function statusColor(outcome) {
  if (outcome === "completed") return STATUS_COMPLETED;
  if (outcome === "failed") return STATUS_FAILED;
  return STATUS_OTHER;
}

function nodeSvg(p, flags, hasIn, hasOut) {
  const n = p.node;
  if (p.nested === true) {
    // A nested sub-skill: a small quiet chip inside its parent's group box. No ports, no icon
    // column, no status row -- a sub-skill is loadable context, never a flow, and drawing it with
    // full node furniture would claim wireability it does not have.
    return [
      `<g class="gnode" id="${p.id}" transform="translate(${fmt(p.x)},${fmt(p.y)})">`,
      `<rect width="${fmt(p.w)}" height="${fmt(p.h)}" rx="4" fill="${CHIP_FILL.skill}" stroke="${CHIP_STROKE}" stroke-width="1"/>`,
      `<text x="8" y="16" font-size="11" fill="${CHIP_LABEL}">${escapeHtml(p.label)}</text>`,
      "</g>",
    ].join("");
  }
  const flagNames = new Set(flags.map((f) => f.flag));
  const state = nodeState(n, flagNames);
  const parts = [`<g class="gnode" id="${p.id}" transform="translate(${fmt(p.x)},${fmt(p.y)})">`];
  parts.push(
    `<rect width="${fmt(p.w)}" height="${fmt(NODE_H)}" rx="5" fill="${chipFill(n)}"${state.faded ? ' fill-opacity=".5"' : ""} stroke="${state.stroke}" stroke-width="1"${state.dash !== null ? ` stroke-dasharray="${state.dash}"` : ""}/>`,
  );
  parts.push(`<path d="M 30 1 L 30 29" stroke="${CHIP_STROKE}" stroke-width="1" opacity=".5"/>`);
  parts.push(`<text x="15" y="20" text-anchor="middle" font-size="13" fill="${CHIP_LABEL}">${escapeHtml(chipGlyph(n))}</text>`);
  parts.push(`<text x="${LABEL_X}" y="20" font-size="14" fill="${CHIP_LABEL}">${escapeHtml(p.label)}</text>`);
  if (hasIn) parts.push(`<rect x="-5" y="${fmt(NODE_H / 2 - 5)}" width="10" height="10" rx="3" fill="${PORT_FILL}" stroke="${CHIP_STROKE}" stroke-width="1"/>`);
  if (hasOut) parts.push(`<rect x="${fmt(p.w - 5)}" y="${fmt(NODE_H / 2 - 5)}" width="10" height="10" rx="3" fill="${PORT_FILL}" stroke="${CHIP_STROKE}" stroke-width="1"/>`);
  if (n.kind === "trigger") {
    parts.push(`<rect x="3" y="${fmt(NODE_H + 3)}" width="9" height="9" rx="2" fill="${statusColor(n.runs > 0 ? n.lastOutcome : null)}"/>`);
    parts.push(`<text x="16" y="${fmt(NODE_H + 11)}" font-size="10" fill="${PAGE_DIM}">${n.runs > 0 ? `${fmt(n.runs)} runs` : "no runs"}</text>`);
  }
  const orange = [...flagNames].some((f) => ORANGE_FLAGS.has(f));
  if (orange) parts.push(`<circle cx="${fmt(p.w - 4)}" cy="-2" r="5" fill="${BADGE_ORANGE}"/>`);
  if (n.aiTrigger) parts.push(`<circle cx="${fmt(p.w - 4 - (orange ? 14 : 0))}" cy="-2" r="4" fill="none" stroke="${BADGE_GREEN}" stroke-width="2"/>`);
  parts.push("</g>");
  return parts.join("");
}

function wireStyle(w) {
  if (w.kind === "observed") return { stroke: WIRE_OBSERVED, width: 3, dash: null };
  if (w.kind === "config") return { stroke: WIRE_CONFIG, width: 2, dash: null };
  if (w.kind === "potential") return { stroke: w.edge.strong ? PAGE_ACCENT : WIRE_POTENTIAL, width: 2, dash: "6,4" };
  return { stroke: CHIP_FILL.cron, width: 2, dash: "4,3" }; // cron-rearm: dashed in the trigger's own hue
}

function wireSvg(w) {
  const s = wireStyle(w);
  const parts = [`<g class="gwire" id="${w.id}">`];
  parts.push(`<path d="${w.d}" fill="none" stroke="${s.stroke}" stroke-width="${fmt(s.width)}"${s.dash !== null ? ` stroke-dasharray="${s.dash}"` : ""}/>`);
  let label = null;
  let fill = PAGE_DIM;
  if (w.kind === "observed" && w.edge.count !== null) {
    label = `(${w.edge.count}×)`;
    fill = WIRE_OBSERVED;
  } else if (w.kind === "potential") {
    label = "mention";
    fill = w.edge.strong ? PAGE_ACCENT : WIRE_POTENTIAL;
  } else if (w.kind === "cron-rearm" && w.edge.label !== null) {
    label = w.edge.label;
    fill = CHIP_FILL.cron;
  }
  if (label !== null) parts.push(`<text x="${fmt(w.labelX)}" y="${fmt(w.labelY)}" text-anchor="middle" font-size="10" fill="${fill}">${escapeHtml(label)}</text>`);
  parts.push("</g>");
  return parts.join("");
}

function groupSvg(g, fullPaths) {
  const opacity = g.kind === "forge" ? "0.03" : "0.06";
  return [
    `<g class="ggroup">`,
    `<rect x="${fmt(g.x)}" y="${fmt(g.y)}" width="${fmt(g.w)}" height="${fmt(g.h)}" rx="2" fill="${GROUP_FILL}" fill-opacity="${opacity}" stroke="${PAGE_BORDER}" stroke-width="2"/>`,
    `<text x="${fmt(g.x + 8)}" y="${fmt(g.y + 18)}" font-size="11" fill="${PAGE_DIM}">${escapeHtml(groupTitle(g, fullPaths))}</text>`,
    `</g>`,
  ].join("");
}

// The loop-in-skill group: a stronger tint than the folder box behind it (nesting reads as
// stacked tints), the skill's name top-left, one ⟳ marker per prose-loop hint, and the ring wire
// threading output -> around the markers -> input so the loop reads as living inside the skill.
function skillGroupSvg(sg) {
  const parts = [`<g class="sgroup" id="${sg.id}">`];
  parts.push(`<rect x="${fmt(sg.x)}" y="${fmt(sg.y)}" width="${fmt(sg.w)}" height="${fmt(sg.h)}" rx="2" fill="${GROUP_FILL}" fill-opacity="0.08" stroke="${PAGE_BORDER}" stroke-width="2"/>`);
  parts.push(`<text x="${fmt(sg.x + 8)}" y="${fmt(sg.y + 16)}" font-size="11" fill="${PAGE_DIM}">${escapeHtml(sg.label)}</text>`);
  parts.push(`<path d="${sg.d}" fill="none" stroke="${WIRE_POTENTIAL}" stroke-width="1.5" stroke-dasharray="4,3"/>`);
  for (const m of sg.markers) {
    parts.push(`<rect x="${fmt(m.x)}" y="${fmt(m.y)}" width="${fmt(m.w)}" height="${fmt(m.h)}" rx="6" fill="${CHIP_FILL.skill}" stroke="${CHIP_STROKE}" stroke-width="1"/>`);
    parts.push(`<text x="${fmt(m.x + m.w / 2)}" y="${fmt(m.y + m.h / 2 + 6)}" text-anchor="middle" font-size="16" fill="${CHIP_LABEL}">⟳</text>`);
    parts.push(`<text x="${fmt(m.hintX)}" y="${fmt(m.hintY)}" font-size="10" fill="${PAGE_DIM}">${escapeHtml(m.hint)}</text>`);
  }
  parts.push("</g>");
  return parts.join("");
}

// ---- legend ----

function legendSample(stroke, width, dash) {
  return `<svg width="46" height="10" aria-hidden="true"><path d="M 2 5 C 16 5, 30 5, 44 5" fill="none" stroke="${stroke}" stroke-width="${fmt(width)}"${dash !== null ? ` stroke-dasharray="${dash}"` : ""}/></svg>`;
}

function legendSwatch(inner) {
  return `<svg width="16" height="12" aria-hidden="true">${inner}</svg>`;
}

function legendHtml(norm) {
  const rows = [];
  const row = (sample, text) => rows.push(`<div class="row">${sample}<span>${escapeHtml(text)}</span></div>`);
  rows.push("<h2>edges</h2>");
  row(legendSample(WIRE_CONFIG, 2, null), "config: the trigger names this flow");
  row(legendSample(WIRE_OBSERVED, 3, null), "observed ×n: chained in run records");
  row(legendSample(WIRE_POTENTIAL, 2, "6,4"), "potential: a text mention, not a promise");
  row(legendSample(PAGE_ACCENT, 2, "6,4"), "potential (strong): near chain vocabulary");
  row(legendSample(CHIP_FILL.cron, 2, "4,3"), "cron re-arm: the schedule itself");
  rows.push("<h2>badges</h2>");
  row(legendSwatch(`<circle cx="8" cy="6" r="5" fill="${BADGE_ORANGE}"/>`), "unread / injected ai-trigger / PR spend-loop risk");
  row(legendSwatch(`<circle cx="8" cy="6" r="4" fill="none" stroke="${BADGE_GREEN}" stroke-width="2"/>`), "chainable: ai-trigger allow");
  row(legendSwatch(`<rect x="1" y="1" width="14" height="10" rx="2" fill="none" stroke="${CHIP_STROKE}" stroke-dasharray="8,3"/>`), "orphan: no trigger, no ai-trigger, no mention");
  row(legendSwatch(`<rect x="1" y="1" width="14" height="10" rx="2" fill="none" stroke="${DANGER}" stroke-dasharray="10,4"/>`), "dangling: flow absent or name invalid");
  row(legendSwatch(`<rect x="1" y="1" width="14" height="10" rx="2" fill="none" stroke="${PAGE_DIM}" stroke-dasharray="10,4"/>`), "unverified: repo not readable from this host");
  rows.push(`<div class="caps">${escapeHtml(capsLineText(norm.caps))}</div>`);
  const honesty = [];
  if (norm.meta.unattributedRuns > 0) honesty.push(`${norm.meta.unattributedRuns} runs unattributed`);
  if (norm.meta.truncated.folders) honesty.push("folder scan truncated (cap reached)");
  if (norm.meta.truncated.skills) honesty.push("skill enumeration truncated or partly unread");
  if (norm.meta.truncated.edges) honesty.push("observed edges truncated (cap reached)");
  if (norm.meta.droppedObservedEdges > 0) honesty.push(`${norm.meta.droppedObservedEdges} observed edges dropped (no unique folder)`);
  for (const line of honesty) rows.push(`<div class="honesty">${escapeHtml(line)}</div>`);
  return `<div id="legend">${rows.join("")}</div>`;
}

function bannersHtml(norm) {
  const banners = [];
  if (!norm.ok) banners.push("no graph model supplied; the page has nothing to draw");
  if (norm.meta.triggersMissing) banners.push("no triggers file found");
  if (norm.meta.triggersInvalid !== null) banners.push(`triggers file invalid: ${norm.meta.triggersInvalid}`);
  if (banners.length === 0) return "";
  return `<div id="banners">${banners.map((b) => `<div class="banner">${escapeHtml(b)}</div>`).join("")}</div>`;
}

// ---- page assembly ----

const PAGE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:${PAGE_CANVAS};color:${PAGE_FG};font:14px/1.4 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
#hdr{position:fixed;top:0;left:0;right:0;height:46px;display:flex;align-items:center;gap:12px;padding:0 14px;background:${PAGE_PANEL};border-bottom:1px solid ${PAGE_BORDER};z-index:3}
#hdr h1{font-size:14px;font-weight:600}
#stamp{color:${PAGE_DIM};font-size:12px}
#stamp.stale{color:${PAGE_AMBER}}
#hdr button,#hdr select{background:#21262d;color:${PAGE_FG};border:1px solid ${PAGE_BORDER};border-radius:6px;padding:3px 10px;font-size:12px}
#banners{position:fixed;top:52px;left:10px;z-index:3;max-width:46%}
.banner{background:#2d1517;border:1px solid ${DANGER};color:${DANGER};border-radius:6px;padding:6px 10px;margin-bottom:6px;font-size:12px}
#wrap{position:relative;height:100vh;padding-top:46px}
svg.canvas{display:block;width:100%;height:100%;cursor:grab;touch-action:none}
#tip{position:absolute;display:none;max-width:340px;background:${PAGE_PANEL};border:1px solid ${PAGE_BORDER};border-radius:6px;padding:8px 10px;font-size:12px;color:${PAGE_FG};white-space:pre-line;pointer-events:none;z-index:4}
#legend{position:fixed;top:56px;right:10px;width:256px;background:${PAGE_PANEL};border:1px solid ${PAGE_BORDER};border-radius:6px;padding:10px 12px;font-size:11px;color:${PAGE_DIM};z-index:2}
#legend h2{font-size:11px;color:${PAGE_FG};margin:6px 0 4px}
#legend .row{display:flex;align-items:center;gap:6px;margin:2px 0}
#legend .caps{margin-top:8px;color:${PAGE_FG}}
#legend .honesty{margin-top:4px;color:${PAGE_AMBER}}
.gnode{cursor:pointer}
.dim .gnode,.dim .gwire{opacity:.15}
.dim .hi{opacity:1}
`;

// The page's whole behaviour, ES5-flavoured on purpose (no template strings, so this literal can
// sit inside one), and with three hard rules the tests pin: no fetching of any kind, no markup
// assembly on the client (textContent only), and the clock read spelled without the static
// accessor this module's purity regex bans.
const PAGE_JS = `
(function () {
  "use strict";
  var svg = document.getElementById("graph");
  var root = document.getElementById("root");
  var tip = document.getElementById("tip");
  var wrap = document.getElementById("wrap");
  var stamp = document.getElementById("stamp");
  var auto = document.getElementById("auto");
  var reloadBtn = document.getElementById("reload");
  var selected = null;
  var autoTimer = null;
  var hashTimer = null;

  function nowClock() { return new Date().getTime(); }

  function fmtAge(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h";
  }
  function tickStamp() {
    var age = nowClock() - GENERATED_AT;
    stamp.textContent = "generated " + fmtAge(age) + " ago";
    stamp.className = age > 600000 ? "stale" : "";
  }
  tickStamp();
  setInterval(tickStamp, 1000);

  if (reloadBtn) reloadBtn.addEventListener("click", function () { location.reload(); });
  function applyAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    var s = auto ? parseInt(auto.value, 10) : 0;
    if (s > 0) autoTimer = setInterval(function () { location.reload(); }, s * 1000);
  }
  if (auto) auto.addEventListener("change", function () { applyAuto(); writeHash(); });

  if (!svg || !root) return;
  var vb = svg.viewBox.baseVal;
  var baseW = vb.width;

  function writeHash() {
    hashTimer = null;
    var parts = ["vb=" + [vb.x, vb.y, vb.width, vb.height].map(function (v) { return Math.round(v * 10) / 10; }).join("_")];
    if (selected) parts.push("sel=" + selected);
    if (auto && auto.value !== "0") parts.push("ar=" + auto.value);
    history.replaceState(null, "", "#" + parts.join("&"));
  }
  function scheduleHash() {
    if (hashTimer) return;
    hashTimer = setTimeout(writeHash, 300);
  }
  function readHash() {
    var h = location.hash.replace(/^#/, "");
    if (!h) return;
    var kvs = h.split("&");
    for (var i = 0; i < kvs.length; i++) {
      var at = kvs[i].indexOf("=");
      if (at < 0) continue;
      var k = kvs[i].slice(0, at);
      var v = kvs[i].slice(at + 1);
      if (k === "vb") {
        var n = v.split("_").map(parseFloat);
        if (n.length === 4 && n.every(isFinite) && n[2] > 0 && n[3] > 0) {
          vb.x = n[0]; vb.y = n[1]; vb.width = n[2]; vb.height = n[3];
        }
      } else if (k === "sel" && ownNode(v)) {
        select(v);
      } else if (k === "ar" && auto) {
        auto.value = v === "5" || v === "30" ? v : "0";
        applyAuto();
      }
    }
  }

  // With preserveAspectRatio meet, the browser scales UNIFORMLY (the smaller of the two ratios)
  // and centres the letterboxed remainder; mapping each axis by its own ratio pans at the wrong
  // speed and zooms beside the cursor whenever the element and viewBox aspects differ.
  function view() {
    var r = svg.getBoundingClientRect();
    var s = Math.min(r.width / vb.width, r.height / vb.height);
    return { r: r, s: s, ox: (r.width - vb.width * s) / 2, oy: (r.height - vb.height * s) / 2 };
  }

  var panning = null;
  var suppressClick = false;
  svg.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    panning = { x: e.clientX, y: e.clientY, moved: 0 };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", function (e) {
    if (panning) {
      var v = view();
      var dx = e.clientX - panning.x;
      var dy = e.clientY - panning.y;
      panning.moved += Math.abs(dx) + Math.abs(dy);
      vb.x -= dx / v.s;
      vb.y -= dy / v.s;
      panning.x = e.clientX;
      panning.y = e.clientY;
      scheduleHash();
    }
    moveTip(e);
  });
  svg.addEventListener("pointerup", function (e) {
    if (panning && svg.hasPointerCapture && svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    // Pointer capture makes the click after a pan land on the svg, which would read as a
    // background click and wipe the selection; a real drag therefore swallows that click.
    suppressClick = panning !== null && panning.moved > 3;
    panning = null;
  });
  svg.addEventListener("wheel", function (e) {
    e.preventDefault();
    var k = Math.exp(-e.deltaY * 0.0015);
    var scale = baseW / (vb.width / k);
    if (scale < 0.15 || scale > 4) return;
    var v = view();
    var px = vb.x + (e.clientX - v.r.left - v.ox) / v.s;
    var py = vb.y + (e.clientY - v.r.top - v.oy) / v.s;
    vb.x = px - (px - vb.x) / k;
    vb.y = py - (py - vb.y) / k;
    vb.width = vb.width / k;
    vb.height = vb.height / k;
    scheduleHash();
  }, { passive: false });

  // The ONLY indexed read of GRAPH.nodes: an id arriving from the hash (or a DOM id) could be a
  // prototype-chain key like "constructor", which a bare truthy lookup would happily return and a
  // later .nb dereference would throw on. A test pins this as the single raw read.
  function ownNode(id) {
    return Object.prototype.hasOwnProperty.call(GRAPH.nodes, id) ? GRAPH.nodes[id] : null;
  }
  function nodeAt(e) {
    var el = e.target && e.target.closest ? e.target.closest(".gnode") : null;
    return el && ownNode(el.id) ? el : null;
  }
  function moveTip(e) {
    var el = nodeAt(e);
    if (!el) { tip.style.display = "none"; return; }
    tip.textContent = ownNode(el.id).tip;
    tip.style.display = "block";
    var wr = wrap.getBoundingClientRect();
    tip.style.left = e.clientX - wr.left + 14 + "px";
    tip.style.top = e.clientY - wr.top + 14 + "px";
  }

  function mark(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add("hi");
  }
  function clearSel() {
    selected = null;
    root.classList.remove("dim");
    var hi = root.querySelectorAll(".hi");
    for (var i = 0; i < hi.length; i++) hi[i].classList.remove("hi");
    scheduleHash();
  }
  function select(id) {
    clearSel();
    var g = ownNode(id);
    if (!g) return;
    selected = id;
    root.classList.add("dim");
    mark(id);
    for (var i = 0; i < g.nb.length; i++) mark(g.nb[i]);
    for (var j = 0; j < g.w.length; j++) mark(g.w[j]);
    scheduleHash();
  }
  svg.addEventListener("click", function (e) {
    if (suppressClick) { suppressClick = false; return; }
    var el = nodeAt(e);
    if (el) { if (selected === el.id) clearSel(); else select(el.id); }
    else clearSel();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") clearSel(); });

  readHash();
})();
`;

/**
 * Build the complete page. Total function: no arguments, a malformed model, an empty model -- all
 * yield a valid page (with an in-page banner saying what is wrong), never a throw, because this
 * runs at the end of an operator command and a stack trace where a file should be is the worst of
 * the available outcomes. `now` is the injected generation instant (ms epoch); the module never
 * reads a clock of its own, so the same model and the same now are byte-identical forever.
 */
export function buildGraphHtml(model, { now, fullPaths } = {}) {
  let norm;
  try {
    norm = normalizeModel(model);
  } catch {
    norm = normalizeModel(null);
  }
  const layout = layoutNormalized(norm);
  const nowMs = Number.isFinite(now) ? now : (norm.meta.generatedAt ?? 0);

  // Per-node flag lists and adjacency, keyed by ordinal ids only: the originals embed host paths.
  const flagsByOrig = new Map();
  for (const f of norm.flags) {
    if (!flagsByOrig.has(f.nodeId)) flagsByOrig.set(f.nodeId, []);
    flagsByOrig.get(f.nodeId).push(f);
  }
  const groupById = new Map(layout.groups.map((g) => [g.id, g]));
  const hasIn = new Set();
  const hasOut = new Set();
  const adj = new Map(); // placed id -> { nb:Set, w:Set }
  const touch = (id) => {
    if (!adj.has(id)) adj.set(id, { nb: new Set(), w: new Set() });
    return adj.get(id);
  };
  for (const w of layout.wires) {
    hasOut.add(w.from);
    hasIn.add(w.to);
    touch(w.from).nb.add(w.to);
    touch(w.from).w.add(w.id);
    touch(w.to).nb.add(w.from);
    touch(w.to).w.add(w.id);
  }

  const graphData = { nodes: {} };
  const nodeParts = [];
  for (const p of layout.nodes) {
    const n = p.node;
    const flags = norm.nodes.length > 0 ? findFlags(flagsByOrig, norm.nodes, p) : [];
    const group = groupById.get(p.groupId);
    const drawIn = hasIn.has(p.id) || (n.kind !== "trigger" && n.kind !== "injected");
    const drawOut = hasOut.has(p.id) || n.kind === "trigger";
    nodeParts.push(nodeSvg(p, flags, drawIn, drawOut));
    const a = adj.get(p.id);
    graphData.nodes[p.id] = {
      tip: buildTip(n, flags, group ? group.label : null, nowMs),
      nb: a ? [...a.nb].sort() : [],
      w: a ? [...a.w].sort() : [],
    };
  }

  const svgBody = [
    layout.groups.map((g) => groupSvg(g, fullPaths)).join(""),
    layout.skillGroups.map(skillGroupSvg).join(""),
    layout.wires.map(wireSvg).join(""),
    nodeParts.join(""),
  ].join("");
  const vb = layout.viewBox;
  const svgEl = [
    `<svg id="graph" class="canvas" viewBox="${fmt(vb.x)} ${fmt(vb.y)} ${fmt(vb.w)} ${fmt(vb.h)}" role="img" aria-label="pi-dispatch trigger and flow graph" preserveAspectRatio="xMidYMid meet">`,
    `<g id="root">${svgBody}</g>`,
    `</svg>`,
  ].join("");

  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    "<title>pi-dispatch graph</title>",
    `<style>${PAGE_CSS}</style>`,
    "<body>",
    '<div id="hdr">',
    "<h1>pi-dispatch graph</h1>",
    '<span id="stamp"></span>',
    '<button id="reload" type="button">Reload</button>',
    '<select id="auto" aria-label="auto reload"><option value="0">off</option><option value="5">5s</option><option value="30">30s</option></select>',
    "</div>",
    bannersHtml(norm),
    `<div id="wrap">${svgEl}<div id="tip"></div></div>`,
    legendHtml(norm),
    `<script>\n"use strict";\nvar GENERATED_AT = ${fmt(nowMs)};\nvar GRAPH = ${embedJson(graphData)};\n${PAGE_JS}</script>`,
    "</body>",
  ].join("\n");
}

// Flags were recorded against original node ids; the placed node still holds its normalised node,
// whose id is the original, so the join is direct -- the original id just never reaches the page.
function findFlags(flagsByOrig, _nodes, placed) {
  return flagsByOrig.get(placed.node.id) ?? [];
}
