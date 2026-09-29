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
const CHAR_W = 8; // 8px per COLUMN at the 14px label font (see labelColumns); over-estimating keeps text inside the chip
const LABEL_X = 38; // label x, past the 30px icon column and its divider
const CHIP_MAX_COLS = 14; // what fits at NODE_MAX_W: (160 - 38 - 10) / CHAR_W
const RANK_PITCH = 180; // fixed column pitch
const ROW_GAP = 26; // vertical gap between rows (leaves room for the status line under a chip)
const GROUP_PAD_L = 20;
const GROUP_PAD_R = 20;
// Room for the group's title and then one line of wire label above the first row: at 40, the 10px left between
// the title band and the first row's badges held no label, so every label of a wire on that row was pushed
// onto a chip or out of its folder (issue #483).
const GROUP_PAD_T = 54;
const GROUP_PAD_B = 44; // breathing room below the last row band (under-route depth is paid per band)
const GROUP_GAP = 40; // folder groups stack vertically with this gap
// What a trigger draws under its chip, as baselines below the chip's top: the status line (square
// and run count) here, and the spend badge the insights page lays over the scene on the next line.
// Exported for that page, which draws the badge at SPEND_BADGE_DY, so the one number the loop below
// must clear is also the one the badge is drawn at (issue #483: they were two literals, and the
// re-arm loop ran through the badge).
const STATUS_DY = NODE_H + 11;
export const SPEND_BADGE_DY = NODE_H + 23;
// Where that text stack ends: the badge baseline plus the 10px font's descent.
const UNDER_TEXT_BOTTOM = SPEND_BADGE_DY + 3;
// An under-row route (a self-loop, a back edge) runs this far below the chip's top: past the whole
// under-chip text stack plus room for the 2px stroke, never through it. It was NODE_H + 25, a
// Node-RED self-wire's drop, which put a cron trigger's re-arm loop across its own spend badge.
const UNDER_ROUTE_Y = UNDER_TEXT_BOTTOM + 6;
// Extra pitch below any row band hosting an under-row route: the route plus its label end about
// 47px past the chip bottom, which ROW_GAP alone cannot absorb -- without this, a folder with two
// cron triggers drew the first re-arm label inside the second trigger's chip.
const UNDER_ROUTE_EXTRA = 44;
// Parallel-wire fan-out: an observed edge and a potential mention often join the SAME pair of
// skills, and without an offset the two beziers overlay. Sibling 0 stays straight; each later
// sibling bows alternately up/down by 14px at the control points.
const PARALLEL_BOW = 14;
// Wire labels (the observed count, the word mention) are 10px text, and each is placed beside its own wire at
// the first candidate spot whose box is clear of every wire, loop, ring, chip, badge, title, box border and
// label already placed, and whose nearest wire is its own (issue #483). Two earlier rules were each refuted by a scene: a label at
// its curve's midpoint with a sibling stepped 10.5px drew mention across the count; a stack per (from, to)
// pair centred on the gap drew two pairs leaving one skill for one column on the same pixels.
const WIRE_LABEL_COL_W = 6; // px per column at 10px, over-counted like CHAR_W so the width is a bound
const WIRE_LABEL_DESCENT = 4; // baseline to the lowest ink, plus air
const WIRE_LABEL_ASCENT = 9; // baseline to the highest ink (brackets), plus air
const WIRE_LABEL_ASSOC = 16; // a label's anchor points lie at most this far from its own wire
const WIRE_LABEL_ASSOC_MARGIN = 1.5; // and every wire outside its pair lies at least this much farther
// A wire that leaves its group (a cron trigger's flow found in the injected, overlay or staged tier)
// travels between groups, never across one: down a lane right of its trigger column, left along the
// gap under its group, down a gutter left of every group, and in to its target from the left. The
// straight bezier it used to be crossed every group stacked between (the forge group's title among
// them) and grazed the ports of the chips it passed. The lane clears the widest trigger's re-arm loop
// (a cubic with an 18px control offset reaches 13.5px past the chip) and its 2px stroke; the column
// after it moves right by what the lane needs, only in a group that has such a wire.
// Every such wire has a lane, a gap line and a gutter of its own, stepped apart, so the drawing still says
// which trigger feeds which tier (sharing them drew one trunk for three wires). A wire that stays in the
// group crosses the lanes square, along its trigger's row, and turns down only in the drop strip after them:
// a curve through the lanes ran along a lane for as long as it was steep.
const LANE_CLEAR = 22;
const LANE_STEP = 6; // between two lanes after one column
const LANE_DROP = 38; // the drop strip after the last lane, to the next column's chips (port included)
const GUTTER_IN = 14; // the innermost gutter, left of every group's left edge
const GUTTER_STEP = 8; // each further gutter wire, one step further out
const GAP_PAD = 10; // the first gap line under a group
const GAP_STEP = 6; // each further gap line
const APPROACH_STEP = 4; // wires into one port run in on lines this far apart and meet only at the port
const CORNER_R = 8;
// Skill-group (loop-in-skill) geometry: the Node-RED group treatment around a skill whose SKILL.md
// iterates (prose-loop hints) or which owns sub-skills. The chip keeps its ports and every external
// wire -- the box, the ⟳ markers and the ring wire only VISUALISE that the looping lives inside
// this one node's job (one trigger = one job = one budget slot; the loop never leaves the node),
// which is why the group is not itself a node and draws no edge anywhere.
const SG_CHIP_X = 22; // chip inset: the ring at inset 10, the 5px input-port overhang, some air
const SG_CHIP_Y = 26; // chip sits below the group's own label line
const SG_RING = 10; // the loop wire's inset from the box edge
const SG_TITLE_X = SG_CHIP_X + 8; // the group's title, clear of the chip's input port
const SG_MARKER = 40; // the ⟳ marker square
const SG_HINT_CHARS = 24; // loop-hint clip; small text at ~6px/char sizes the box
const SG_SMALL_CHAR_W = 6;
const SUB_CHIP_H = 24; // nested sub-skill chips are deliberately smaller than real nodes
// The viewBox is the drawn content's bounds plus this much on every side. It was a fixed 80 around the
// groups alone, which drew an empty band above the first group as tall as a row (issue #483); the
// bounds now take the gutter wires in too, so the one margin needed is for the strokes.
const VIEW_MARGIN = 12;

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
  issue: "#c7e9c0",
  skill: "#fdd0a2",
});
const STATUS_COMPLETED = "#3fb950";
const STATUS_FAILED = "#ff5f57";
const STATUS_OTHER = "#6e7681";
const BADGE_ORANGE = "#db6d28";
const BADGE_GREEN = "#3fb950";
const DANGER = "#f85149";

// The page palette as one frozen bag, for the sibling artifact builder (insights-html.mjs): this
// module may be a source of truth for other pure emitters, it may just never load one itself --
// the purity test's ban is directional on purpose.
export const PAGE_THEME = Object.freeze({
  canvas: PAGE_CANVAS,
  panel: PAGE_PANEL,
  border: PAGE_BORDER,
  fg: PAGE_FG,
  dim: PAGE_DIM,
  accent: PAGE_ACCENT,
  amber: PAGE_AMBER,
  danger: DANGER,
  green: STATUS_COMPLETED,
  chipStroke: CHIP_STROKE,
});
const GROUP_FILL = "#E6E0F8";
const WIRE_OBSERVED = "#999";
const WIRE_CONFIG = "#6e7681";
const WIRE_POTENTIAL = "#8b949e";

// One glyph per node kind for the 30px icon column; characters, not images, because images would
// need data: URIs and a font would need @font-face, both of which the file:// posture forbids.
// Exported for the kind-parity test: this module cannot use the `from` clause, so a test is the
// anti-drift wire that keeps every GRAPH_NODE_KINDS entry drawable (the GRAPH_HTML_KINDS pattern).
export const GLYPH = Object.freeze({
  cron: "◷",
  label: "◈",
  comment: "❝",
  pull_request: "⇄",
  issue: "◉",
  skill: "ƒ",
  "skill-missing": "!",
  "skill-unverified": "?",
  "skill-not-at-head": "⋯",
  injected: "+",
  overlay: "◎",
  staged: "▣",
});

// The 5-entity escape, byte-for-byte the worker's buildFormPage helper: every string interpolated
// into markup goes through this, operator-authored or not, because "charset-bound upstream" is an
// assumption and an entity is a guarantee.
export function escapeHtml(s) {
  // WELL-FORMED FIRST (issue #418): half a surrogate pair that arrived in the data would otherwise reach
  // the page as it came, and a cut is not the only way to get one.
  return String(s).toWellFormed().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// JSON destined for the inline script: `<` becomes < so no value can spell `</script>` and
// break out of the script element, and U+2028/2029 become escapes because they are line
// terminators to a JS parser while being invisible to JSON.
export function embedJson(value) {
  // And the same for every string VALUE in the embedded JSON, which would otherwise carry the escaped
  // text of a half pair (issue #418). Keys are not rewritten: every key this page embeds is minted here
  // (`n0`, a tip index), never data.
  return JSON.stringify(value, (_k, v) => (typeof v === "string" ? v.toWellFormed() : v))
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Every number that reaches markup goes through this: a non-finite value becomes 0 rather than
// serialising as one of the three words the well-formedness test bans outright.
export function fmt(v) {
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

/**
 * A CHARACTER cap for a data field (a tooltip line, a description), never a width: the cut is by code
 * unit, as it always was, but half a surrogate pair is not a character (issue #418). A cap that landed
 * between the halves of an emoji left a bare high surrogate in the page, and in the embedded JSON as the
 * escaped text of one. Exported for the insights page, which caps its own fields with the same rule.
 */
export function clip(s, max) {
  const t = String(s);
  return t.length > max ? `${wholeUnits(t, max)}\u2026` : t;
}

/**
 * The longest start of `s` of at most `n` code units that ends BETWEEN clusters: never half a surrogate
 * pair, and never half a flag, a keycap without its key, or a family without its last member, which a
 * repair of the surrogate alone still left in a tooltip.
 */
function wholeUnits(s, n) {
  let out = "";
  for (const { segment } of GRAPHEMES.segment(s)) {
    if (out.length + segment.length > n) break;
    out += segment;
  }
  return out;
}

/**
 * THE WIDTH OF A LABEL, in columns of CHAR_W pixels (issue #418). Chips were sized by `.length`, a code
 * unit count used as a glyph count: a CJK skill name draws about twice the width its chip was sized
 * for, and ran out of it.
 *
 * AN ESTIMATE THAT NEVER UNDER-COUNTS, not a measurement. There is no DOM here, and this module loads
 * nothing, so the panel's width table cannot be reached; it is not the right measure anyway, because an
 * SVG draws glyphs, not terminal cells. Three for an emoji (a pictographic or emoji-presentation code
 * point past ASCII, which a browser draws wider than two columns), two for U+20E3, the code units it
 * takes for a mark, a format character, anything else before U+1100 and the narrow General Punctuation
 * (the ellipsis every cut appends among it), and two for everything else: never less than the code-unit
 * count chips were sized by.
 * Held to the panel's table by a sweep in `graph-html.test.mjs`, the parity wire that a `from` clause
 * would otherwise be: on every code point and every pair with U+FE0F, never narrower than the terminal
 * width the panel measures. Measured in a browser at 14px: a CJK glyph is 13.9px, inside two columns,
 * and an emoji 17.4 to 19.4px depending on the page's scale, inside three. What it does NOT cover is
 * stated where the chips are cut.
 */
export function labelColumns(s) {
  let n = 0;
  for (const ch of String(s)) n += charColumns(ch);
  return n;
}

function charColumns(ch) {
  const cp = ch.codePointAt(0);
  // A keycap's enclosing mark: the key is drawn at least as wide as an emoji.
  if (cp === 0x20e3) return 2;
  // AN EMOJI IS WIDER THAN TWO COLUMNS in a browser: measured at 17.4 to 19.4px at 14px depending on
  // the page's scale, past the 16px two columns allow, so seven of them ran out of a full chip.
  if (cp > 0x7f && /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(ch)) return 3;
  // A MARK OR A FORMAT CHARACTER IS NOT FREE HERE, though a terminal draws most as nothing: a browser
  // draws a spacing vowel sign, an enclosing mark and several format characters with an advance of their
  // own, and counting them as nothing made Devanagari, Bengali and Myanmar labels that fitted when chips
  // were sized by code units overflow once sized by this. So no code point ever counts below the code
  // units it takes, which is the old sizing, and a label can only get a WIDER chip than it had.
  if (/\p{M}|\p{Cf}/u.test(ch)) return ch.length;
  if (cp < 0x1100 || NARROW_PUNCTUATION.test(ch)) return ch.length;
  return 2;
}

// The General Punctuation a browser draws narrow: the spaces, the hyphens and short dashes, the quotation
// marks, the bullet and the ellipsis. Counting them as two made a label with a curly quote or a thin space
// cut where a code-unit count had left it whole (issue #418's review). The em and horizontal-bar dashes
// and the per-mille and per-ten-thousand signs draw wide and keep two.
const NARROW_PUNCTUATION = /[\u2000-\u2013\u2016-\u202f\u2032-\u206f]/u;

/**
 * The columns a label DRAWS once it has been through `clipColumns`: that cut spends two columns on its
 * ellipsis after a wide character and `labelColumns` counts the ellipsis as one, so a width built from
 * `labelColumns` alone was one column short of the budget the cut had allowed for. ASCII is unchanged.
 */
export function drawnColumns(label) {
  // The right-to-left mark a cut may carry after its ellipsis draws nothing, so it neither counts nor hides the ellipsis.
  const bare = label.endsWith(RLM) ? label.slice(0, -1) : label;
  const n = labelColumns(bare);
  return bare.endsWith("\u2026") && [...bare].some((ch) => charColumns(ch) >= 2) ? n + 1 : n;
}

// The browser draws whole clusters, so a label is cut on cluster boundaries. A global, not a module.
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The first `max` COLUMNS of a label, cut between clusters, with an ellipsis when anything was cut.
 *
 * BY CLUSTER, not by code point: a code-point walk cut a flag into half a flag, a keycap into its base,
 * and a family emoji into one of its members. AND THE ELLIPSIS COSTS TWO COLUMNS once the cut keeps a
 * wide character: a browser draws it at about 14px, not 8, so seven emoji and an ellipsis ended three
 * pixels past a full-width chip. An ASCII cut keeps its fourteen characters, so ASCII pages are
 * byte-identical to what they were.
 *
 * WHAT IT STILL DOES NOT COVER, stated rather than hidden: scripts before U+1100 whose glyphs draw much
 * wider than 8px (Malayalam, Myanmar, Tamil, Thai, and runs of wide Latin letters in a proportional font
 * too), which this estimate counts at one column each.
 */
// Where a cut ends right to left (issue #422). A neutral ellipsis after a right-to-left run joins the left-to-right
// paragraph and is drawn beside the run's FIRST word, where a reader of that script starts, so a cut that ends right to
// left carries a right-to-left mark after its ellipsis. The ranges are the strong right-to-left characters of the Hebrew
// and Arabic blocks and their presentation forms, with the Arabic-script characters the bidi algorithm reads as numbers
// or number formats left out (U+0600-0605, the Arabic-Indic digits and separators U+0660-066C, U+08E2): a mark after
// those moved the ellipsis between the word and the number (measured in Chrome). The extended digits U+06F0-06F9 are
// European numbers to the bidi algorithm, where the mark changes nothing, and are left out too. A Latin, Greek or Cyrillic
// letter ends the scan left to right; digits and punctuation decide nothing. ONE table, read here by the builder's cut and
// written into FIT_JS for the page's, so the two cannot disagree.
const RTL_STRONG = [[0x0590, 0x05ff], [0x0606, 0x065f], [0x066d, 0x06ef], [0x06fa, 0x08e1], [0x08e3, 0x08ff], [0xfb1d, 0xfdff], [0xfe70, 0xfefe]];
const LTR_STRONG = [[0x41, 0x5a], [0x61, 0x7a], [0xc0, 0x24f], [0x370, 0x52f]];
const RLM = String.fromCharCode(0x200f);

function endsRightToLeft(s) {
  const within = (c, table) => table.some(([lo, hi]) => c >= lo && c <= hi);
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s.charCodeAt(i);
    if (within(c, RTL_STRONG)) return true;
    if (within(c, LTR_STRONG)) return false;
  }
  return false;
}

export function clipColumns(s, max) {
  const t = String(s);
  if (labelColumns(t) <= max) return t;
  const kept = [];
  let used = 0;
  let wide = false;
  for (const { segment } of GRAPHEMES.segment(t)) {
    const cols = labelColumns(segment);
    if (used + cols > max) break;
    kept.push(cols);
    used += cols;
    // WIDE means a character that draws wide, not a cluster of two narrow ones: a CRLF is one cluster
    // of two columns, and counting it as wide cut an ASCII label one character shorter than it was.
    if ([...segment].some((c) => charColumns(c) >= 2)) wide = true;
  }
  let keep = kept.length;
  if (wide) {
    while (keep > 0 && used > max - 1) {
      keep -= 1;
      used -= kept[keep];
    }
  }
  let out = "";
  let taken = 0;
  for (const { segment } of GRAPHEMES.segment(t)) {
    if (taken === keep) break;
    out += segment;
    taken += 1;
  }
  return `${out}\u2026${endsRightToLeft(out) ? RLM : ""}`;
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
    // The two honesty counters the text and TUI renderers always carried and this allowlist
    // dropped (issue #175): three surfaces of one model must not disagree about what was refused
    // or unreadable. Sorted and clipped like every other array on this page.
    chainRefusals: (m.meta?.chainRefusals && typeof m.meta.chainRefusals === "object" ? Object.entries(m.meta.chainRefusals) : [])
      .flatMap(([scope, count]) => (typeof scope === "string" && intOr(count, 0) > 0 ? [{ scope: clip(scope, 80), count: intOr(count, 0) }] : []))
      .sort((a, b) => cmpStr(a.scope, b.scope)),
    injectedUnreachable: (Array.isArray(m.meta?.injectedUnreachable) ? m.meta.injectedUnreachable : [])
      .filter((d) => typeof d === "string")
      .map((d) => clip(d, 120))
      .sort()
      .slice(0, 8),
    // The two tier-honesty counters (issue #188), the injectedUnreachable rule applied to the
    // deployment-wide tiers: a tier the ladder silently skipped would read as "checked".
    overlayUnreachable: m.meta?.overlayUnreachable === true,
    stagedUnenumerable: (Array.isArray(m.meta?.stagedUnenumerable) ? m.meta.stagedUnenumerable : [])
      .filter((d) => typeof d === "string")
      .map((d) => clip(d, 80))
      .sort()
      .slice(0, 8),
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
      // A command trigger's slash command (issue #189's node fact, #188's rendering): the tip is the
      // detail surface, so the full command rides, clipped like every other string on this page.
      command: typeof n.command === "string" ? clip(n.command, 80) : null,
      // The staged tier node's owning package, and the softened state's evidence: which tiers this
      // session could not check. Both clipped/sorted/capped so a hostile model cannot inflate a tip.
      package: typeof n.package === "string" ? clip(n.package, 80) : null,
      tiersUnknown: Array.isArray(n.tiersUnknown)
        ? [...new Set(n.tiersUnknown.filter((t) => typeof t === "string").map((t) => clip(t, 40)))].sort().slice(0, 4)
        : [],
      replicas: intOr(n.replicas, null),
      // One-shot facts (#231): `once` is the armed state, and the disarm mark is narrowed to its
      // instant alone. The mark's jobId stays server-side on purpose: the page answers "spent, and
      // when", and provenance beyond that belongs to the operator's own console -- a shareable
      // file:// page should carry no more of a deployment's run history than the question needs.
      once: n.once === true,
      disarmed: n.disarmed !== null && n.disarmed !== undefined && typeof n.disarmed === "object" && !Array.isArray(n.disarmed)
        ? { at: typeof n.disarmed.at === "string" ? clip(n.disarmed.at, 40) : Number.isFinite(n.disarmed.at) ? n.disarmed.at : null }
        : null,
      folderKey: typeof n.folderKey === "string" ? n.folderKey : null,
      runs: intOr(n.runs, 0),
      lastOutcome: typeof n.lastOutcome === "string" ? n.lastOutcome : null,
      lastEndedAt: typeof n.lastEndedAt === "string" || Number.isFinite(n.lastEndedAt) ? n.lastEndedAt : null,
      // Schedule facts (issue #181): with the terminal views gone this page is the last surface
      // REQ-TOPOLOGY-GRAPH (h) has, so the facts the model always computed ride the tip here.
      next: typeof n.next === "string" || Number.isFinite(n.next) ? n.next : null,
      overdueMs: Number.isFinite(n.overdueMs) && n.overdueMs > 0 ? n.overdueMs : null,
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
      // Observed-edge recency (issue #175), the node-side lastEndedAt sanitizer: "chained 3 times,
      // last 2d ago" and "chained 3 times, months back" are different topologies to a reader.
      lastEndedAt: typeof e.lastEndedAt === "string" || Number.isFinite(e.lastEndedAt) ? e.lastEndedAt : null,
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
  if (n.kind === "trigger") return clipColumns(n.label ?? n.onType ?? "trigger", CHIP_MAX_COLS);
  return clipColumns(n.name ?? "(unnamed)", CHIP_MAX_COLS);
}

function chipWidth(label) {
  const raw = LABEL_X + drawnColumns(label) * CHAR_W + 12;
  const snapped = Math.ceil(raw / GRID) * GRID;
  return Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, snapped));
}

/**
 * Place the normalised model: one Node-RED group rect per folder, triggers at rank 0 inside it,
 * skills ranked by longest path over config/observed/potential edges, rows ordered by two median
 * sweeps with an alphabetical tiebreak (no randomness anywhere -- determinism is a test). Reached
 * through `buildGraphScene`, whose `layout` result is this function's, so the layout invariants
 * (left-to-right wires, group containment, no overlaps) stay testable without parsing SVG back out
 * of a page. The old model-taking wrapper around this function is gone with the standalone page
 * builder (issue #279): neither had a production caller left, and an exported helper nothing calls
 * does not stay uncalled -- the purity test bans both names from ever reappearing here.
 */
function layoutNormalized(norm, nowMs) {
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
    if (!g && n.kind === "overlay") g = groupIndexByKey.get("~overlay") ?? addGroup("~overlay", "overlay skills (global pi dir)", "local", null, null);
    if (!g && n.kind === "staged") g = groupIndexByKey.get("~staged") ?? addGroup("~staged", "staged package skills", "local", null, null);
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
  // Labels are known before the layout, so a column gap can be made wide enough for the ones crossing it.
  for (const w of wires) w.label = wireLabel(w, nowMs);

  // Rank + order + coordinates, one group at a time; groups then stack vertically. Skill groups
  // (loop-in-skill boxes) are collected with folder-local coords and translated alongside the
  // members they contain.
  const skillGroups = [];
  let groupY = 0;
  let maxGroupW = 0;
  const crossFrom = new Map();
  for (const w of wires) {
    if (!w.self && w.f.groupId !== w.t.groupId) crossFrom.set(w.f.groupId, (crossFrom.get(w.f.groupId) ?? 0) + 1);
  }
  for (const g of groups) {
    const sgStart = skillGroups.length;
    const size = layoutGroup(g, wires, skillGroups);
    g.x = 0;
    g.y = groupY;
    // A forge group's title leads with the caveat that nothing on this host can verify it (issue #422), and the page
    // cuts a title that runs past its box. A group with no flow column (a command-only forge trigger) sits at its
    // minimum width, too narrow for that caveat, so the box is widened to hold it: the label and the caveat at 7px a
    // column of the 11px title font, which over-counts it. The repo list after the caveat may still be cut.
    g.w = g.kind === "forge" ? Math.max(size.w, forgeTitleMinWidth(g)) : size.w;
    g.h = size.h;
    for (const p of g.members) {
      p.x += g.x;
      p.y += g.y;
      if (typeof p.laneX === "number") p.laneX += g.x;
      if (typeof p.dropX === "number") p.dropX += g.x;
    }
    for (const c of g.cols ?? []) {
      c.x0 += g.x;
      c.x1 += g.x;
      c.occ = c.occ.map(([a, b]) => [a + g.y, b + g.y]);
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
    // The gap under a group holds one gap line per wire leaving it, and grows when there are more of them.
    const n = crossFrom.get(g.id) ?? 0;
    g.gapBelow = Math.max(GROUP_GAP, 2 * GAP_PAD + Math.max(0, n - 1) * GAP_STEP);
    groupY += g.h + g.gapBelow;
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
  // Back edges leaving one node share its port and would share their run under the rows too, pixel for pixel,
  // wherever their targets differ: each takes its own run, one step apart, by its order among them.
  const backCount = new Map();
  for (const w of wires) {
    if (!w.back) continue;
    w.backStep = backCount.get(w.from) ?? 0;
    backCount.set(w.from, w.backStep + 1);
  }

  const groupById = new Map(groups.map((g) => [g.id, g]));
  routeCrossWires(wires.filter((w) => !w.self && w.f.groupId !== w.t.groupId && typeof w.f.laneX === "number"), groupById);
  for (const w of wires) {
    if (!w.cross) routeWire(w, groupById.get(w.f.groupId));
  }
  const drawn = wires.map((w) => samplePath(w.d)).concat(skillGroups.map((sg) => samplePath(sg.d)));
  for (const sg of skillGroups) Object.assign(sg, sgTitle(sg, placedById(placed, sg.nodeId), drawn));
  placeWireLabels(wires, placed, groups, skillGroups, drawn);
  for (const w of wires) {
    delete w.f;
    delete w.t;
  }

  const totalH = groups.length > 0 ? groupY - groups[groups.length - 1].gapBelow : 0;
  // Bounds of what is drawn: the groups (which hold every chip, box and label), the gutter wires left
  // of them, and any wire label, whatever it sits beside.
  let minX = 0;
  let minY = 0;
  let maxX = maxGroupW;
  let maxY = totalH;
  for (const w of wires) {
    if (w.cross) minX = Math.min(minX, w.gutterX - 1);
    if (w.label !== null && w.labelHidden !== true) {
      const hw = labelHalfWidth(w.label);
      minX = Math.min(minX, w.labelX - hw);
      maxX = Math.max(maxX, w.labelX + hw);
      minY = Math.min(minY, w.labelY - 10);
      maxY = Math.max(maxY, w.labelY + WIRE_LABEL_DESCENT);
    }
  }
  const viewBox = groups.length > 0
    ? { x: minX - VIEW_MARGIN, y: minY - VIEW_MARGIN, w: maxX - minX + VIEW_MARGIN * 2, h: maxY - minY + VIEW_MARGIN * 2 }
    : { x: 0, y: 0, w: 800, h: 600 };
  return { nodes: placed, wires, groups, skillGroups, viewBox };
}

// A wire's label text, or null for a kind that carries none (config). Decided here rather than at
// emission so the layout can size the label it places.
function wireLabel(w, nowMs) {
  if (w.kind === "observed" && w.edge.count !== null) {
    // Recency beside the count when the fold recorded it: relTime against the injected instant,
    // so the byte-determinism guarantee holds -- same model + same now, same label.
    const ago = relTime(nowMs, w.edge.lastEndedAt);
    return ago !== null ? `(${w.edge.count}× · ${ago})` : `(${w.edge.count}×)`;
  }
  if (w.kind === "potential") return "mention";
  if (w.kind === "cron-rearm" && w.edge.label !== null) return w.edge.label;
  return null;
}

function labelHalfWidth(label) {
  return (drawnColumns(label) * WIRE_LABEL_COL_W) / 2;
}

// Give every wire that leaves its group its own gutter, gap line and lane. The gutter goes by target: the
// wire whose target sits lowest takes the outermost, so a wire running on down never crosses one that
// already turned in. Within one source group the inner gutter takes the lowest gap line, and within one
// source column the rightmost lane, which is the nesting under which the gap runs and lanes do not cross.
function routeCrossWires(cross, groupById) {
  cross.sort((a, b) => a.t.y - b.t.y || a.f.y - b.f.y || cmpStr(a.id, b.id));
  cross.forEach((w, k) => {
    w.k = k;
  });
  const bySrc = new Map();
  const byLane = new Map();
  const byTarget = new Map();
  const push = (m, key, w) => {
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(w);
  };
  for (const w of cross) {
    push(bySrc, w.f.groupId, w);
    push(byLane, `${w.f.groupId} ${w.f.rank}`, w);
    push(byTarget, w.t.id, w);
  }
  for (const list of bySrc.values()) list.forEach((w, i) => (w.gapI = list.length - 1 - i));
  for (const list of byLane.values()) list.forEach((w, i) => (w.laneI = list.length - 1 - i));
  for (const list of byTarget.values()) list.forEach((w, i) => (w.approach = (i - (list.length - 1) / 2) * APPROACH_STEP));
  for (const w of cross) routeCrossWire(w, groupById.get(w.f.groupId), -GUTTER_IN - w.k * GUTTER_STEP);
}

// Route a wire that leaves its group: out of the port, down its lane to its gap line under its group, along
// that line to its gutter, along the gutter to the target's row, and in to the port from the left. The
// target's column 0 is empty on that row by construction (such a target is a tier node, and a tier group
// holds no trigger), and the run in is below the target group's title band.
function routeCrossWire(w, srcGroup, gutterX) {
  const f = w.f;
  const t = w.t;
  const y1 = f.y + NODE_H / 2;
  const y2 = t.y + NODE_H / 2;
  const laneX = f.laneX + w.laneI * LANE_STEP;
  const yGap = srcGroup.y + srcGroup.h + GAP_PAD + w.gapI * GAP_STEP;
  const yIn = y2 + w.approach;
  const pts = [[f.x + f.w, y1], [laneX, y1], [laneX, yGap], [gutterX, yGap], [gutterX, yIn], [t.x - 16, yIn]];
  w.cross = true;
  w.gutterX = gutterX;
  w.d = `${roundedPath(pts, CORNER_R)} C ${fmt(t.x - 8)} ${fmt(yIn)}, ${fmt(t.x - 8)} ${fmt(y2)}, ${fmt(t.x)} ${fmt(y2)}`;
  w.labelX = gutterX;
  w.labelY = (yGap + y2) / 2;
}

// An orthogonal polyline with each corner rounded by a cubic whose control points sit on the corner;
// the radius shrinks to half the shorter leg, so a short leg never turns the path back on itself.
function roundedPath(pts, r) {
  const parts = [`M ${fmt(pts[0][0])} ${fmt(pts[0][1])}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const lin = Math.hypot(cx - px, cy - py);
    const lout = Math.hypot(nx - cx, ny - cy);
    const rr = Math.min(r, lin / 2, lout / 2);
    if (!(rr > 0)) {
      parts.push(`L ${fmt(cx)} ${fmt(cy)}`);
      continue;
    }
    const ax = cx - ((cx - px) / lin) * rr;
    const ay = cy - ((cy - py) / lin) * rr;
    const bx = cx + ((nx - cx) / lout) * rr;
    const by = cy + ((ny - cy) / lout) * rr;
    parts.push(`L ${fmt(ax)} ${fmt(ay)} C ${fmt(cx)} ${fmt(cy)}, ${fmt(cx)} ${fmt(cy)}, ${fmt(bx)} ${fmt(by)}`);
  }
  const last = pts[pts.length - 1];
  parts.push(`L ${fmt(last[0])} ${fmt(last[1])}`);
  return parts.join(" ");
}

// The Node-RED wire bezier between two points: horizontal control offsets at 0.75 of the span, tightened
// when the points are closer than 100px so short wires do not balloon, bowed by `bow` at both controls.
function nodeRedCurve([x1, y1], [x2, y2], bow) {
  const dx = Math.max(x2 - x1, 4);
  const sc = dx < 100 ? 0.75 * (dx / 100) : 0.75;
  const off = Math.max(dx * sc, 10);
  return `C ${fmt(x1 + off)} ${fmt(y1 + bow)}, ${fmt(x2 - off)} ${fmt(y2 + bow)}, ${fmt(x2)} ${fmt(y2)}`;
}

// Where a wire that skips column `col` passes it: a height in a gap between the column's boxes (below the
// group's title band, above its bottom), the one nearest `want`; parallel siblings step off it.
function passY(col, g, want) {
  const spans = [[g.y + 24, g.y + 24], ...col.occ, [g.y + g.h - 4, g.y + g.h - 4]];
  let best = null;
  for (let i = 0; i + 1 < spans.length; i++) {
    const lo = spans[i][1] + 4;
    const hi = spans[i + 1][0] - 4;
    if (hi <= lo) continue;
    const y = Math.min(hi, Math.max(lo, want));
    if (best === null || Math.abs(y - want) < Math.abs(best - want)) best = y;
  }
  return best ?? want;
}

// The points a drawn `d` passes through, about every 1.5px: M, L and C, the only commands this module emits.
function samplePath(d) {
  const tok = d.match(/[MLC]|-?\d+(?:\.\d+)?/g) ?? [];
  const pts = [];
  let cur = [0, 0];
  for (let i = 0; i < tok.length; ) {
    const c = tok[i++];
    const nums = [];
    while (i < tok.length && !/[MLC]/.test(tok[i])) nums.push(Number(tok[i++]));
    if (c === "M") {
      cur = [nums[0], nums[1]];
      pts.push(cur);
    } else if (c === "L") {
      const [x, y] = nums;
      const n = Math.max(1, Math.ceil(Math.hypot(x - cur[0], y - cur[1]) / 1.5));
      for (let k = 1; k <= n; k++) pts.push([cur[0] + ((x - cur[0]) * k) / n, cur[1] + ((y - cur[1]) * k) / n]);
      cur = [x, y];
    } else if (c === "C") {
      const [ax, ay, bx, by, x, y] = nums;
      const n = Math.max(2, Math.ceil((Math.hypot(ax - cur[0], ay - cur[1]) + Math.hypot(bx - ax, by - ay) + Math.hypot(x - bx, y - by)) / 1.5));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const u = 1 - t;
        pts.push([u * u * u * cur[0] + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * x, u * u * u * cur[1] + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * y]);
      }
      cur = [x, y];
    }
  }
  return pts;
}

function placedById(placed, id) {
  return placed.find((p) => p.id === id);
}

// The obstacles a wire label must stay clear of, as boxes, and every drawn path's points, both bucketed on a
// grid so a candidate box asks only the cells it covers.
function obstacleIndex(placed, groups, skillGroups, wires, drawn) {
  const CELL = 24;
  const cells = new Map();
  const key = (cx, cy) => `${cx} ${cy}`;
  const add = (kind, item, x0, y0, x1, y1) => {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const k = key(cx, cy);
        if (!cells.has(k)) cells.set(k, { boxes: [], pts: [] });
        cells.get(k)[kind].push(item);
      }
    }
  };
  const box = (x0, y0, x1, y1) => add("boxes", { x0, y0, x1, y1 }, x0, y0, x1, y1);
  for (const pts of drawn) for (const q of pts) add("pts", q, q[0], q[1], q[0], q[1]);
  for (const n of placed) {
    if (n.nested === true) {
      box(n.x, n.y, n.x + n.w, n.y + n.h);
      continue;
    }
    box(n.x - 6, n.y - 8, n.x + n.w + 6, n.y + NODE_H);
    if (n.kind === "trigger") box(n.x, n.y + NODE_H, n.x + n.w, n.y + UNDER_TEXT_BOTTOM);
  }
  const edges = (x, y, w, h) => {
    box(x - 1.5, y - 1.5, x + w + 1.5, y + 1.5);
    box(x - 1.5, y + h - 1.5, x + w + 1.5, y + h + 1.5);
    box(x - 1.5, y - 1.5, x + 1.5, y + h + 1.5);
    box(x + w - 1.5, y - 1.5, x + w + 1.5, y + h + 1.5);
  };
  for (const g of groups) {
    edges(g.x, g.y, g.w, g.h);
    box(g.x + 8, g.y + 6, g.x + g.w, g.y + 22); // the title band, whole: its text's width depends on the page's options
  }
  for (const sg of skillGroups) {
    edges(sg.x, sg.y, sg.w, sg.h);
    box(sg.x + SG_TITLE_X, sg.y + 5, sg.x + SG_TITLE_X + sg.titleW, sg.y + 20);
    for (const m of sg.markers) {
      box(m.x, m.y, m.x + m.w, m.y + m.h);
      box(m.hintX, m.hintY - 9, m.hintX + drawnColumns(m.hint) * SG_SMALL_CHAR_W, m.hintY + 3);
    }
  }
  for (const w of wires) {
    if (w.label !== null && w.self) box(w.labelX - labelHalfWidth(w.label), w.labelY - WIRE_LABEL_ASCENT, w.labelX + labelHalfWidth(w.label), w.labelY + 3);
  }
  const hits = (b, pad) => {
    let n = 0;
    for (let cx = Math.floor(b.x0 / CELL); cx <= Math.floor(b.x1 / CELL); cx++) {
      for (let cy = Math.floor(b.y0 / CELL); cy <= Math.floor(b.y1 / CELL); cy++) {
        const c = cells.get(key(cx, cy));
        if (!c) continue;
        for (const o of c.boxes) if (o.x0 < b.x1 && b.x0 < o.x1 && o.y0 < b.y1 && b.y0 < o.y1) n++;
        for (const q of c.pts) if (q[0] > b.x0 - pad && q[0] < b.x1 + pad && q[1] > b.y0 - pad && q[1] < b.y1 + pad) n++;
      }
    }
    return n;
  };
  return { box, hits };
}

// Place each forward wire's label (in wire order, so the result is deterministic) at the first spot on its own
// path whose box meets nothing and which reads as that wire's (readsAsOwn): anchors walk out from the path's
// middle, and at each the label sits just above or just below the path where it spans, then further out on
// either side up to WIRE_LABEL_ASSOC. When no candidate qualifies (a scene too dense for the search), the
// label is not drawn over anything or beside another edge: it moves to its wire's tooltip, and the legend
// counts it. Taking the least-bad spot instead (the first cut of this rule) still
// drew labels on labels and chips in dense scenes, which is the very defect the rule exists to end. A back edge's label is placed the same way (fixed under its run, another wire could pass through
// it); a cron pattern keeps its place under its own loop, in the band the layout pays for it, and a gutter wire
// carries none.
// A label reads as its own wire's only when that wire is the nearest one: measured from the label's two anchor
// points (the middle of its top edge and of its bottom edge), its own wire must lie within WIRE_LABEL_ASSOC, and
// every wire outside its (from, to) pair must lie at least WIRE_LABEL_ASSOC_MARGIN farther. A clear spot six lines out, the first cut of the search,
// sat beside another pair's wire and read as that edge's label (issue #483, PR #487's final review).
function readsAsOwn(w, wi, cx, b, wires, drawn) {
  const anchors = [[cx, b.y0], [cx, b.y1]];
  const dist = (pts) => {
    let d = Infinity;
    for (const [ax, ay] of anchors) for (const q of pts) d = Math.min(d, Math.hypot(q[0] - ax, q[1] - ay));
    return d;
  };
  const own = dist(drawn[wi]);
  if (own > WIRE_LABEL_ASSOC) return false;
  for (let j = 0; j < drawn.length; j++) {
    if (j === wi) continue;
    const o = wires[j];
    if (o && o.from === w.from && o.to === w.to) continue;
    // Only points that could come within `own` plus the margin matter: a cheap box test first, then the distance.
    // The margin keeps the answer from turning on a pixel of the label box's estimated ink.
    const reach = own + WIRE_LABEL_ASSOC_MARGIN;
    const near = drawn[j].filter((q) => q[0] > cx - reach - 1 && q[0] < cx + reach + 1 && q[1] > b.y0 - reach - 1 && q[1] < b.y1 + reach + 1);
    if (near.length > 0 && dist(near) < reach) return false;
  }
  return true;
}

function placeWireLabels(wires, placed, groups, skillGroups, drawn) {
  const index = obstacleIndex(placed, groups, skillGroups, wires, drawn);
  const groupOf = new Map(groups.map((g) => [g.id, g]));
  wires.forEach((w, wi) => {
    if (w.label === null || w.self || w.cross) return;
    // A label stays inside its own folder's box: a spot outside it reads as belonging to no folder.
    const home = groupOf.get(w.f.groupId);
    const outside = (b) => b.x0 < home.x + 3 || b.x1 > home.x + home.w - 3 || b.y0 < home.y + 3 || b.y1 > home.y + home.h - 3;
    const pts = drawn[wi];
    const hw = labelHalfWidth(w.label);
    const half = wireStyle(w).width / 2 + 1.5; // clear of its own stroke, not just its centre line
    const mid = pts.length >> 1;
    const order = [];
    for (let k = 0; k <= mid; k += 3) {
      order.push(mid - k);
      if (k > 0 && mid + k < pts.length) order.push(mid + k);
    }
    let best = null;
    for (const i of order) {
      const cx = pts[i][0];
      let top = Infinity;
      let bottom = -Infinity;
      for (const q of pts) {
        if (q[0] < cx - hw || q[0] > cx + hw) continue;
        if (q[1] < top) top = q[1];
        if (q[1] > bottom) bottom = q[1];
      }
      // Nearest first, alternating sides, in 2px steps out to the association distance: fixed one-line lifts
      // (and 3px steps) missed the few pixels where a label fits the slot between two rows of chips.
      const bases = [];
      for (let off = 0; off <= WIRE_LABEL_ASSOC; off += 2) {
        bases.push(top - half - WIRE_LABEL_DESCENT - off);
        bases.push(bottom + half + WIRE_LABEL_ASCENT + off);
      }
      for (const base of bases) {
        const b = { x0: cx - hw, x1: cx + hw, y0: base - WIRE_LABEL_ASCENT, y1: base + 3 };
        if (outside(b) || index.hits(b, 3) > 0) continue; // 3: the widest stroke's half (observed, 3px) and air
        if (!readsAsOwn(w, wi, cx, b, wires, drawn)) continue;
        best = { cx, base, b };
        break;
      }
      if (best !== null) break;
    }
    if (best === null) {
      w.labelHidden = true;
      return;
    }
    w.labelX = best.cx;
    w.labelY = best.base;
    index.box(best.b.x0, best.b.y0, best.b.x1, best.b.y1);
  });
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
  // A rank holding the source of a wire that leaves this group gets a lane after it (see LANE_CLEAR), and
  // the next column moves right far enough to leave the lane clear.
  const laneCount = new Map();
  for (const w of allWires) {
    if (!w.self && gridSet.has(w.from) && w.t.groupId !== g.id) laneCount.set(rank.get(w.from), (laneCount.get(rank.get(w.from)) ?? 0) + 1);
  }
  const lanesW = (r) => (laneCount.has(r) ? LANE_CLEAR + (laneCount.get(r) - 1) * LANE_STEP : 0);
  // A gap crossed by a labelled wire (an observed count, a mention) is wide enough for the widest such label and
  // its margins, so the label has a place beside its own wire within one line of it: a gap the width of a
  // chip's port and some air held no label, and the placer, bound to stay near its wire, had to hide it.
  const labelW = new Map();
  for (const w of allWires) {
    if (w.self || w.back || w.label === null || !gridSet.has(w.from) || !gridSet.has(w.to)) continue;
    const r = rank.get(w.from);
    labelW.set(r, Math.max(labelW.get(r) ?? 0, 2 * labelHalfWidth(w.label) + 24));
  }
  const colX = [GROUP_PAD_L];
  for (let r = 1; r <= maxRank; r++) {
    const lane = laneCount.has(r - 1) ? rankMaxW[r - 1] + lanesW(r - 1) + LANE_DROP : 0;
    colX.push(colX[r - 1] + Math.max(RANK_PITCH, rankMaxW[r - 1] + 20, lane, rankMaxW[r - 1] + (labelW.get(r - 1) ?? 0)));
  }
  for (const p of grid) {
    const r = rank.get(p.id);
    p.rank = r;
    p.laneX = laneCount.has(r) ? colX[r] + rankMaxW[r] + LANE_CLEAR : null;
    p.dropX = laneCount.has(r) ? colX[r] + rankMaxW[r] + lanesW(r) + 8 : null;
  }

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
  // What each column holds, top to bottom (a chip with the badges over its corner, or a skill group's whole
  // box): a wire that skips a column passes it through a gap between these, never across one.
  g.cols = rows.map((row, r) => ({
    x0: colX[r] - 8,
    x1: colX[r] + rankMaxW[r] + 8,
    occ: row.map((p) => (supers.has(p.id) ? [p.y - SG_CHIP_Y, p.y - SG_CHIP_Y + supers.get(p.id).h] : [p.y - 8, p.y + NODE_H])).sort((a, b) => a[0] - b[0]),
  }));
  // A lane after the last column stays inside the box, like everything else the group draws.
  const lastLane = laneCount.has(maxRank) ? lanesW(maxRank) + 10 : GROUP_PAD_R;
  return {
    w: colX[maxRank] + rankMaxW[maxRank] + Math.max(GROUP_PAD_R, lastLane),
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
    markers.push({ x: SG_CHIP_X, y: cy, w: SG_MARKER, h: SG_MARKER, hint: clipColumns(l.hint, SG_HINT_CHARS), hintX: SG_CHIP_X + SG_MARKER + 6, hintY: cy + 24 });
    cy += SG_MARKER + 8;
  }
  const subPlaced = [];
  for (const s of subs) {
    const label = clipColumns(s.node.name ?? "(sub)", 16);
    s.label = label;
    s.w = Math.min(140, Math.max(80, 12 + drawnColumns(label) * 7));
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

// A skill group's title uses the box's whole width when no drawn path enters that band, and otherwise only the
// span between its chip's two ports: every wire into the chip ends at the input port and every wire out of it
// starts at the output port, and a wire that skips the column passes it between its boxes, so text drawn
// strictly between the ports meets no wire whatever row the wire comes from or climbs to. The title is cut
// to the span it gets (issue #483: from the box's edge a wire into the chip ran through it, and a long name
// ran on past the output port into a wire climbing to the row above), the whole name riding a tooltip, and
// an unpainted rect over the span is the box the page's view-time fit measures it against, so the real font
// is held to the same bound the column estimate is. The whole width is the default because a cut to the
// ports alone made near-identical long names read the same.
function sgTitle(sg, chip, drawn) {
  const x0 = sg.x + SG_TITLE_X;
  const wide = sg.w - SG_TITLE_X - 6;
  const crossed = drawn.some((pts) => pts.some(([x, y]) => x > x0 - 3 && x < x0 + wide + 3 && y > sg.y + 2 && y < sg.y + 22));
  const w = crossed ? chip.w - 16 : wide; // between the ports: 8px past the input port to 8px short of the output port's square
  const cols = Math.max(1, Math.floor(w / TITLE_COL_W));
  const full = String(sg.label);
  return { title: labelColumns(full) > cols ? clipColumns(full, cols - 1) : full, titleW: w };
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
    title: p.node.name ?? p.label,
    titleW: box.w - SG_TITLE_X - 6,
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

function routeWire(w, g) {
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
    const yb = f.y + UNDER_ROUTE_Y + w.parallel * 12;
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
    const yb = Math.max(f.y, t.y) + UNDER_ROUTE_Y + 10 + w.backStep * 12;
    w.d = `M ${fmt(x1)} ${fmt(y1)} C ${fmt(x1 + LOOP_OFF)} ${fmt(y1)}, ${fmt(x1 + LOOP_OFF)} ${fmt(yb)}, ${fmt(x1)} ${fmt(yb)} L ${fmt(x2)} ${fmt(yb)} C ${fmt(x2 - LOOP_OFF)} ${fmt(yb)}, ${fmt(x2 - LOOP_OFF)} ${fmt(y2)}, ${fmt(x2)} ${fmt(y2)}`;
    w.labelX = (x1 + x2) / 2;
    w.labelY = yb + 12;
    return;
  }
  // The Node-RED wire bezier. Parallel siblings (index > 0) bow their control points alternately up/down so
  // two wires between one pair never overlay. From a column with lanes after it, the wire first runs square
  // across them along its own row; and it passes every column it skips through a gap between that column's
  // boxes, square across it, so it crosses no chip and no skill group's title (issue #483).
  const sign = w.parallel % 2 === 1 ? -1 : 1;
  const steps = Math.ceil(w.parallel / 2);
  const bow = sign * steps * PARALLEL_BOW;
  const end = [t.x, y2];
  let cur = [f.x + f.w, y1];
  const parts = [`M ${fmt(cur[0])} ${fmt(cur[1])}`];
  if (typeof f.dropX === "number" && f.dropX < end[0]) {
    cur = [f.dropX, y1];
    parts.push(`L ${fmt(cur[0])} ${fmt(cur[1])}`);
  }
  const cols = g && Array.isArray(g.cols) && Number.isInteger(f.rank) && Number.isInteger(t.rank) ? g.cols.slice(f.rank + 1, t.rank) : [];
  for (const col of cols) {
    const want = cur[1] + ((end[1] - cur[1]) * (col.x0 - cur[0])) / Math.max(1, end[0] - cur[0]);
    const y = passY(col, g, want + bow);
    parts.push(nodeRedCurve(cur, [col.x0, y], bow));
    parts.push(`L ${fmt(col.x1)} ${fmt(y)}`);
    cur = [col.x1, y];
  }
  parts.push(nodeRedCurve(cur, end, bow));
  w.d = parts.join(" ");
  // The midpoint, until placeWireLabels finds the label its clear spot on this path.
  w.labelX = (f.x + f.w + t.x) / 2;
  w.labelY = (y1 + y2) / 2;
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
/** A coarse duration for the schedule facts: minutes under an hour, hours under two days, else days. */
function relSpan(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "<1m";
  const mn = Math.floor(ms / 60000);
  if (mn < 1) return "<1m";
  if (mn < 60) return `${mn}m`;
  const h = Math.floor(mn / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function buildTip(n, flags, groupLabel, nowMs) {
  const lines = [];
  if (n.kind === "trigger") {
    lines.push(`trigger · ${n.onType ?? "?"} · ${n.label ?? ""}`.trim());
    if (n.flow !== null) lines.push(`flow: ${n.flow}${n.replicas !== null ? ` ×${n.replicas}` : ""}`);
    // flow's mutually-exclusive sibling (issue #189): a command trigger dispatches a registered
    // extension command, so the tip shows the whole /name-and-args line the reviewed file staged.
    else if (n.command !== null) lines.push(`command: /${n.command}${n.replicas !== null ? ` ×${n.replicas}` : ""}`);
  } else if (n.kind === "injected") {
    lines.push(`injected skill · ${n.name ?? "?"}`);
    lines.push("trigger-reachable via run.skillsDir, never AI-reachable");
  } else if (n.kind === "overlay") {
    lines.push(`overlay skill · ${n.name ?? "?"}`);
    lines.push("deployment overlay skills/, trigger-reachable, never AI-reachable");
  } else if (n.kind === "staged") {
    lines.push(`staged skill · ${n.name ?? "?"}${n.package !== null ? ` · package ${n.package}` : ""}`);
    lines.push("staged pi package, trigger-reachable, never AI-reachable");
  } else if (n.kind === "skill-missing") {
    lines.push(`skill · ${n.name ?? "?"} · missing at HEAD`);
  } else if (n.kind === "skill-unverified") {
    lines.push(`skill · ${n.name ?? "?"} · unverified (repo not readable from this host)`);
  } else if (n.kind === "skill-not-at-head") {
    // The softened state (issue #188): absent at HEAD is known TRUE, but a tier this session cannot
    // check may still hold the name, so neither missing styling nor a dangling flag would be honest.
    lines.push(`skill · ${n.name ?? "?"} · not committed at HEAD`);
    if (n.tiersUnknown.length > 0) lines.push(`not checkable from this session: ${n.tiersUnknown.join(", ")}`);
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
    // Overdue outranks a stale countdown; next counts against the injected instant, never a clock,
    // so a stale page shows its stale countdown honestly (and byte-determinism holds).
    if (n.overdueMs !== null) lines.push(`overdue ${relSpan(n.overdueMs)}`);
    else {
      const nextMs = typeof n.next === "number" ? n.next : typeof n.next === "string" ? Date.parse(n.next) : NaN;
      if (Number.isFinite(nextMs) && Number.isFinite(nowMs) && nextMs > nowMs) lines.push(`next ${relSpan(nextMs - nowMs)}`);
    }
    // The one-shot state in words (#231): the faded chip only says "spent" to eyes that know the
    // palette, the tip says it to everyone. The disarm instant renders verbatim, not through
    // relTime -- it is provenance the worker wrote down, not a freshness for the page to re-derive.
    if (n.disarmed !== null) lines.push(`one-shot, spent${n.disarmed.at !== null ? ` ${n.disarmed.at}` : ""}`);
    else if (n.once) lines.push("one-shot (armed)");
  }
  if (n.aiTrigger) lines.push("chainable: ai-trigger allow");
  if (n.kind === "skill" && n.loops.length > 0) {
    lines.push(`loops in skill: ${n.loops.map((l) => l.hint).join(" · ")}`);
  }
  for (const f of flags) lines.push(f.detail !== null ? `${f.flag}: ${f.detail}` : f.flag);
  return lines.join("\n");
}

// The forge caveat's own words, one literal for the title and the width that must hold it.
const FORGE_CAVEAT = "forge · unverifiable from this host";
const TITLE_COL_W = 7;

function forgeTitleMinWidth(g) {
  return Math.ceil((8 + labelColumns(`${g.label} · ${FORGE_CAVEAT}`) * TITLE_COL_W + 8) / GRID) * GRID;
}

function groupTitle(g, fullPaths) {
  if (g.kind === "forge") {
    // The unverifiable note before the record-derived scope (issue #422): the page cuts a title that runs
    // past its group from the END, and the list of repos history names is the part that may go, never
    // the caveat that nothing on this host can say more.
    const scope = Array.isArray(g.repos) && g.repos.length > 0 ? ` · ran against ${g.repos.join(", ")}` : "";
    return `${g.label} · ${FORGE_CAVEAT}${scope}`;
  }
  const name = fullPaths === true && typeof g.path === "string" && g.path !== "" ? g.path : g.label;
  // Unreachable, the reason first for the same reason: a long path may be cut, why the folder shows no
  // skills may not.
  if (g.unreachable !== null && g.unreachable !== undefined && g.unreachable !== "") return `${g.unreachable} · ${name}`;
  if (g.head !== null && g.head !== undefined && g.head !== "") return `${name} \u00b7 HEAD ${wholeUnits(String(g.head), 7)}`;
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
  // Amber, deliberately between red and dim (issue #188): the repo read HAPPENED and came back
  // absent, but an unchecked tier may hold the name -- a third epistemic state, styled as one.
  // Safe below the red arm: the dangling flags ride TRIGGER nodes, never this kind.
  if (n.kind === "skill-not-at-head") return { stroke: PAGE_AMBER, dash: "10,4", faded: false };
  // A spent one-shot (#231) wears the orphan's disabled treatment: still on the canvas -- the raw
  // file keeps the entry, and "why did nothing fire" needs the chip visible -- but faded and dashed,
  // because a full-strength chip claims the trigger can still fire and this one never will. Below
  // the red arm on purpose: a dangling flow is a defect worth seeing even on a rule that is done.
  if (n.kind === "trigger" && n.disarmed !== null) return { stroke: CHIP_STROKE, dash: "8,3", faded: true };
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
    parts.push(`<text x="16" y="${fmt(STATUS_DY)}" font-size="10" fill="${PAGE_DIM}">${n.runs > 0 ? `${fmt(n.runs)} runs` : "no runs"}</text>`);
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
  // A cron re-arm wire says so in its class (issue #422): its pattern is centred under the loop with no box of its own,
  // and the page's fit measures it against the loop it labels, which only the page can do exactly.
  const parts = [`<g class="${w.kind === "cron-rearm" ? "gwire gcron" : "gwire"}" id="${w.id}">`];
  parts.push(`<path d="${w.d}" fill="none" stroke="${s.stroke}" stroke-width="${fmt(s.width)}"${s.dash !== null ? ` stroke-dasharray="${s.dash}"` : ""}/>`);
  // A label with no clear spot rides the wire's tooltip instead of being drawn over something (issue #483).
  if (w.labelHidden === true && w.label !== null) parts.push(`<title>${escapeHtml(w.label)}</title>`);
  const label = w.labelHidden === true ? null : w.label;
  const fill = w.kind === "observed" ? WIRE_OBSERVED : w.kind === "potential" ? (w.edge.strong ? PAGE_ACCENT : WIRE_POTENTIAL) : w.kind === "cron-rearm" ? CHIP_FILL.cron : PAGE_DIM;
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
  // The title spans only the chip's ports' gap (see sgTitle); at the box's edge a wire into the chip from
  // its own row or a row above ran through it, past the output port one climbing to the row above did.
  const tip = sg.title !== sg.label ? `<title>${escapeHtml(sg.label)}</title>` : "";
  parts.push(`<rect x="${fmt(sg.x + SG_TITLE_X - 2)}" y="${fmt(sg.y + 4)}" width="${fmt(sg.titleW + 2)}" height="16" fill="none" stroke="none"/>`);
  parts.push(`<text x="${fmt(sg.x + SG_TITLE_X)}" y="${fmt(sg.y + 16)}" font-size="11" fill="${PAGE_DIM}">${escapeHtml(sg.title)}${tip}</text>`);
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

export function legendHtml(norm, hiddenLabels = 0) {
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
  row(legendSwatch(`<rect x="1" y="1" width="14" height="10" rx="2" fill="none" stroke="${DANGER}" stroke-dasharray="10,4"/>`), "dangling: absent in every checkable tier or name invalid");
  row(legendSwatch(`<rect x="1" y="1" width="14" height="10" rx="2" fill="none" stroke="${PAGE_AMBER}" stroke-dasharray="10,4"/>`), "not at HEAD: some skill tiers not checkable from this session");
  row(legendSwatch(`<rect x="1" y="1" width="14" height="10" rx="2" fill="none" stroke="${PAGE_DIM}" stroke-dasharray="10,4"/>`), "unverified: repo not readable from this host");
  rows.push(`<div class="caps">${escapeHtml(capsLineText(norm.caps))}</div>`);
  const honesty = [];
  if (norm.meta.unattributedRuns > 0) honesty.push(`${norm.meta.unattributedRuns} runs unattributed`);
  if (norm.meta.truncated.folders) honesty.push("folder scan truncated (cap reached)");
  if (norm.meta.truncated.skills) honesty.push("skill enumeration truncated or partly unread");
  if (norm.meta.truncated.edges) honesty.push("observed edges truncated (cap reached)");
  if (norm.meta.droppedObservedEdges > 0) honesty.push(`${norm.meta.droppedObservedEdges} observed edges dropped (no unique folder)`);
  // The counters the text and TUI surfaces already state (issue #175): the page joins them.
  const refused = norm.meta.chainRefusals.reduce((a, r) => a + r.count, 0);
  if (refused > 0) honesty.push(`${refused} chain requests refused (caps or gate)`);
  if (norm.meta.injectedUnreachable.length > 0) honesty.push(`injected skills dir unreadable: ${norm.meta.injectedUnreachable.join(", ")}`);
  if (norm.meta.overlayUnreachable) honesty.push("overlay skills dir unreadable (global pi dir)");
  if (norm.meta.stagedUnenumerable.length > 0) honesty.push(`staged packages not enumerable (manifest patterns): ${norm.meta.stagedUnenumerable.join(", ")}`);
  // Stated, never silent: a wire label the layout found no clear spot for is in that wire's tooltip only.
  if (Number.isInteger(hiddenLabels) && hiddenLabels > 0) honesty.push(`${hiddenLabels} wire label${hiddenLabels === 1 ? "" : "s"} in tooltips only (no clear spot on the page)`);
  for (const line of honesty) rows.push(`<div class="honesty">${escapeHtml(line)}</div>`);
  return `<div id="legend">${rows.join("")}</div>`;
}

export function bannersHtml(norm) {
  const banners = [];
  if (!norm.ok) banners.push("no graph model supplied; the page has nothing to draw");
  if (norm.meta.triggersMissing) banners.push("no triggers file found");
  if (norm.meta.triggersInvalid !== null) banners.push(`triggers file invalid: ${norm.meta.triggersInvalid}`);
  if (banners.length === 0) return "";
  return `<div id="banners">${banners.map((b) => `<div class="banner">${escapeHtml(b)}</div>`).join("")}</div>`;
}

// ---- page assembly ----

/**
 * The view-time label fit (issue #422). The static estimate above sizes every chip in COLUMNS, and a
 * column cannot see a Tamil letter drawn at 18px, a cuneiform sign at 65px, a run of wide Latin
 * letters, the 14px ellipsis after a narrow cut, or the titles that are never cut at all. The page
 * can: this script measures each drawn label with the browser's own font and, where one runs past
 * its box, shortens it on grapheme boundaries with a MEASURED ellipsis. Geometry never moves (the
 * layout, the wires and the SVG bytes are the static builder's), a label only ever gets shorter, and
 * a page with its script off is exactly the static page.
 *
 * The box is read from the markup, never from an attribute emitted for it (ASCII scenes stay byte-for-
 * byte what they were): the sibling rect whose vertical band holds the baseline and whose span holds
 * the text's x bounds it at its right edge; only when no rect holds the text does a rect that starts
 * after it (a bar-list label's bar or chip) bound it at its left edge. A chip's output port is such a
 * rect and must NOT bound its label: a name the builder cut at fourteen columns ends a few pixels under
 * the port, as it always has, and bounding it there cut ordinary names a second time. The next left-
 * anchored text on the same baseline bounds it too. A loop hint's box ends at the ring wire, inside its skill
 * group's edge. The nearest bound wins, 2px are kept, and a text no bound reaches (a value drawn after its bar)
 * is left alone. Centred texts are glyphs, counts and wire labels and are skipped, except the one that can run
 * long: a cron re-arm pattern, centred under the loop it labels, is fitted to that loop's drawn width.
 *
 * A text that is cut gains a title holding the text the builder drew, unless it already has one or its
 * group shows a tooltip of its own; that text is kept on the element, so a second pass (fonts arriving
 * late) starts again from it, and a pass under which it fits again restores it and drops the title the
 * fit added. A cut whose last strong character is right-to-left gets a right-to-left mark after its
 * ellipsis, or the ellipsis joins the left-to-right paragraph and is drawn beside the FIRST word, where a
 * reader of that script starts. Without Intl.Segmenter the cut falls back to code points, which keeps
 * surrogate pairs whole but can split a combining sequence. The whole fit sits in a try: it shares the
 * page's one script element, and a failure here must cost the labels, never pan, zoom or selection.
 * Written for any engine the page targets: no template strings, no block-scoped declarations, and none of
 * the words the page-level pins ban.
 */
export const FIT_JS = `
function fitLabels(doc, measure) {
  var SVG_NS = "http://www.w3.org/2000/svg";
  var ELLIPSIS = String.fromCharCode(0x2026);
  var RLM = String.fromCharCode(0x200f);
  var PAD = 2;
  var RING_TOP = ${SG_CHIP_Y + NODE_H / 2};
  var RING_INSET = ${SG_RING};
  var graphemes = typeof Intl === "object" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(void 0, { granularity: "grapheme" }) : null;
  function num(el, name) {
    var v = parseFloat(el.getAttribute(name));
    return v === v ? v : 0;
  }
  function kids(el) {
    return el && el.children ? el.children : [];
  }
  function leftAnchored(el) {
    var a = el.getAttribute("text-anchor");
    return a === null || a === "" || a === "start";
  }
  function hasClass(el, name) {
    var c = el && el.getAttribute ? el.getAttribute("class") : null;
    return typeof c === "string" && (" " + c + " ").indexOf(" " + name + " ") >= 0;
  }
  function boxRight(t) {
    var siblings = kids(t.parentNode);
    var tx = num(t, "x");
    var ty = num(t, "y");
    var holds = null;
    var holdsTop = 0;
    var after = null;
    var next = null;
    for (var i = 0; i < siblings.length; i++) {
      var k = siblings[i];
      if (k.localName === "rect") {
        var ry = num(k, "y");
        if (ty < ry || ty > ry + num(k, "height")) continue;
        var rx = num(k, "x");
        var rw = num(k, "width");
        if (rx <= tx && tx < rx + rw) { if (holds === null || rx + rw < holds) { holds = rx + rw; holdsTop = ry; } }
        else if (tx < rx) { if (after === null || rx < after) after = rx; }
      } else if (k !== t && k.localName === "text" && leftAnchored(k) && num(k, "y") === ty && num(k, "x") > tx) {
        if (next === null || num(k, "x") < next) next = num(k, "x");
      }
    }
    // A loop hint's box ends at the ring wire, drawn RING_INSET inside the skill group's right edge from the chip's
    // midline down; the group's title sits above that line, held by its own rect between the chip's ports.
    if (holds !== null && hasClass(t.parentNode, "sgroup") && ty > holdsTop + RING_TOP) holds -= RING_INSET;
    var bound = holds !== null ? holds : after;
    if (next !== null && (bound === null || next < bound)) bound = next;
    return bound;
  }
  function clusters(s) {
    var out = [];
    if (graphemes !== null) {
      var it = graphemes.segment(s)[Symbol.iterator]();
      for (var r = it.next(); !r.done; r = it.next()) out.push(r.value.segment);
      return out;
    }
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      var n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (c >= 0xd800 && c <= 0xdbff && n >= 0xdc00 && n <= 0xdfff) { out.push(s.slice(i, i + 2)); i++; }
      else out.push(s.charAt(i));
    }
    return out;
  }
  // The direction a cut ends in: the builder's own table (RTL_STRONG, LTR_STRONG above this string), written in.
  var RTL_STRONG = ${JSON.stringify(RTL_STRONG)};
  var LTR_STRONG = ${JSON.stringify(LTR_STRONG)};
  function within(c, table) {
    for (var j = 0; j < table.length; j++) if (c >= table[j][0] && c <= table[j][1]) return true;
    return false;
  }
  function endsRightToLeft(s) {
    for (var i = s.length - 1; i >= 0; i--) {
      var c = s.charCodeAt(i);
      if (within(c, RTL_STRONG)) return true;
      if (within(c, LTR_STRONG)) return false;
    }
    return false;
  }
  function titleOf(t) {
    var list = kids(t);
    for (var i = 0; i < list.length; i++) if (list[i].localName === "title") return list[i];
    return null;
  }
  // A cron re-arm pattern is centred under the loop it labels, so its box is the loop's own drawn width.
  function loopWidth(t) {
    if (!hasClass(t.parentNode, "gcron") || t.getAttribute("text-anchor") !== "middle") return null;
    var list = kids(t.parentNode);
    for (var i = 0; i < list.length; i++) {
      if (list[i].localName === "path" && typeof list[i].getBBox === "function") {
        var b = list[i].getBBox();
        return b && b.width > 0 ? b.width : null;
      }
    }
    return null;
  }
  function fit(t) {
    var node = t.firstChild;
    if (!node || node.nodeType !== 3) return;
    var avail;
    if (leftAnchored(t)) {
      var right = boxRight(t);
      if (right === null) return;
      avail = right - num(t, "x") - PAD;
    } else {
      var loop = loopWidth(t);
      if (loop === null) return;
      avail = loop - 2 * PAD;
    }
    if (!(avail > 0)) return;
    var drawn = typeof t.fitFull === "string" ? t.fitFull : node.nodeValue;
    node.nodeValue = drawn;
    var whole = measure(t);
    // A measure that is not a finite number says nothing, and cutting on it would cut to nothing.
    if (typeof whole !== "number" || !isFinite(whole)) return;
    if (!(whole > avail)) {
      if (t.fitTitle && t.fitTitle.parentNode === t) t.removeChild(t.fitTitle);
      t.fitTitle = null;
      return;
    }
    t.fitFull = drawn;
    // The builder's own ellipsis (and the mark after it on a right-to-left cut) goes first, or a cut would keep it and
    // add a second one.
    var base = drawn.charAt(drawn.length - 1) === RLM ? drawn.slice(0, -1) : drawn;
    if (base.charAt(base.length - 1) === ELLIPSIS) base = base.slice(0, -1);
    var parts = clusters(base);
    function show(n) {
      while (n > 0 && /^\\s+$/.test(parts[n - 1])) n--;
      var kept = parts.slice(0, n).join("");
      node.nodeValue = kept + ELLIPSIS + (endsRightToLeft(kept) ? RLM : "");
      var w = measure(t);
      return typeof w === "number" && isFinite(w) && w <= avail;
    }
    // The longest start that fits, found by halving: a label's width only grows as clusters are added,
    // and a title of ten thousand characters measured one cluster at a time held the page for seconds.
    var lo = 0;
    var hi = parts.length - 1;
    while (lo < hi) {
      var mid = lo + Math.ceil((hi - lo) / 2);
      if (show(mid)) lo = mid;
      else hi = mid - 1;
    }
    // Width is not quite monotone in Arabic: a letter added can turn the one before it into a narrower joining form, so
    // a longer start may fit where a shorter one did not. A few steps past the halving's answer find those.
    for (var up = lo + 1; up <= lo + 3 && up <= parts.length - 1; up++) if (show(up)) lo = up;
    show(lo);
    var p = t.parentNode;
    if (titleOf(t) === null && !hasClass(p, "gnode") && !(p.getAttribute && p.getAttribute("data-tip") !== null)) {
      var title = doc.createElementNS(SVG_NS, "title");
      title.textContent = drawn;
      t.appendChild(title);
      t.fitTitle = title;
    }
  }
  var texts = doc.getElementsByTagName("text");
  for (var i = 0; i < texts.length; i++) {
    try { fit(texts[i]); } catch (e) {
      // This label goes back to the text the builder drew; the next one is still fitted.
      if (typeof texts[i].fitFull === "string" && texts[i].firstChild) texts[i].firstChild.nodeValue = texts[i].fitFull;
    }
  }
}
if (typeof document === "object" && document !== null && document.getElementsByTagName) {
  (function () {
    function run() {
      try { fitLabels(document, function (t) { return t.getComputedTextLength(); }); } catch (e) { /* the labels stay as drawn */ }
    }
    run();
    // Again once web fonts arrive, only when some were still loading: on a page of thousands of labels a pass is
    // hundreds of milliseconds, and a second one for fonts already in place bought nothing.
    if (document.fonts && document.fonts.status !== "loaded" && document.fonts.ready && typeof document.fonts.ready.then === "function") document.fonts.ready.then(run);
  })();
}
`;

// The page's whole behaviour, ES5-flavoured on purpose (no template strings, so this literal can
// sit inside one), and with three hard rules the tests pin: no fetching of any kind, no markup
// assembly on the client (textContent only; FIT_JS above adds its one title through the DOM, never
// markup), and the clock read spelled without the static accessor this module's purity regex bans.
export const PAGE_JS = `
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
 * The scene: normalize, lay out, and emit the SVG body plus the per-node data the page script
 * needs. Extracted (issue #175) so insights-html.mjs could place the same topology inside a larger
 * document without a second layout engine or a second escaping discipline -- and since issue #279
 * that page is the ONLY consumer: the standalone topology page this was split from lost its
 * command in #181 and sat caller-less until it was deleted, total-function guarantees and all
 * (they live on in `buildInsightsHtml`, which the same suites pin). The
 * layout's placed nodes still hold their normalised node objects (original ids and all) -- that is
 * server-side composition state for the caller; only `svgBody`/`graphData` strings belong in a
 * page, and they carry minted ordinals alone.
 */
export function buildGraphScene(model, { now, fullPaths } = {}) {
  let norm;
  try {
    norm = normalizeModel(model);
  } catch {
    norm = normalizeModel(null);
  }
  const nowMs = Number.isFinite(now) ? now : (norm.meta.generatedAt ?? 0);
  const layout = layoutNormalized(norm, nowMs);

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
  const hiddenLabels = layout.wires.filter((w) => w.labelHidden === true).length;
  return { norm, layout, svgBody, viewBox: layout.viewBox, graphData, nowMs, hiddenLabels };
}

// Flags were recorded against original node ids; the placed node still holds its normalised node,
// whose id is the original, so the join is direct -- the original id just never reaches the page.
function findFlags(flagsByOrig, _nodes, placed) {
  return flagsByOrig.get(placed.node.id) ?? [];
}
