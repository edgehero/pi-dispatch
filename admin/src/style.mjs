/**
 * Overlay-only color + layout helpers for the /dispatch dashboard, built on pi's injected `Theme`.
 *
 * The invariant that keeps color safe (feasibility-verified against pi-tui):
 *   - COLOR IS APPLIED POST-LAYOUT. Every width/padding decision is made on PLAIN text; color is the last
 *     transform. pi's overlay host measures each returned line with the ANSI-aware `visibleWidth` and
 *     appends its own SGR reset, so post-layout color adds 0 to the measured width and cannot disturb
 *     framing or the `width:"75%"` overlay clamp.
 *   - This module is OVERLAY-ONLY. `render.mjs`/`panel.mjs` deliberately stay plain because they also feed
 *     `pi.sendMessage` (the model-visible channel) and the untrusted `.log` tail's `clipData` gate.
 *     Nothing here is imported by those paths; the dependency runs one way (this module imports panel's
 *     pure primitives to color them, never the reverse).
 *
 * `theme` is the instance pi hands the `ctx.ui.custom` factory. It is injected (pi-tui is not importable
 * from here — nested, non-hoisted), so every helper takes a styler bound to that instance. `makeStyler`
 * accepts a null theme (tests / no-TUI) and degrades to plain text with the SAME plain layout, so a test
 * can assert both the plain content and the width math without a real terminal.
 */

import { LINE_INPUT_CURSOR, columnsOf, dropLoneSurrogate, fmtCost as plainFmtCost, scrubControls, scrubKeepingStyle, sliceColumns, sparkline as plainSparkline } from "./panel.mjs";

// Strip SGR (and OSC-8 hyperlink) escapes to recover the visible text, which is then measured in COLUMNS.
// This comment used to end "so post-strip `.length` is a safe column proxy", and issue #401 is what that
// sentence cost: content is not ASCII, a repository name or a job id carries whatever the forge allows, and
// a CJK one measured 80 here while the terminal drew 90.
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;

export function stripAnsi(s) {
  return String(s ?? "").replace(ANSI, "");
}

/**
 * Visible COLUMN count of a (possibly colored) string -- not its code-unit length (issue #401).
 *
 * Through `panel.mjs`'s table, so the framed pane and the monochrome one measure the same string the same
 * way. They draw the same geometry, and a width rule that holds in one and not the other is how a frame
 * ends up ten columns wider than the line above it.
 */
export function visibleLen(s) {
  return columnsOf(stripAnsi(s));
}

/** A no-op theme: `fg`/`bg`/`bold`/… return the text unchanged. Used in tests and when no TUI theme exists. */
export const PLAIN_THEME = {
  fg: (_c, t) => t,
  bg: (_c, t) => t,
  bold: (t) => t,
  italic: (t) => t,
  underline: (t) => t,
  inverse: (t) => t,
  strikethrough: (t) => t,
};

// The styler's own glyph twins, inline rather than imported from panel's tables: panel's runtime glyph
// switch (`setGlyphs`) must not restyle overlays behind a styler's back, so the overlay opts in per
// styler instance via `makeStyler(theme, { ascii })`. (The sparkline ramp is the one exception -- its
// quantization geometry lives only in panel.mjs, so `styler.sparkline` follows panel's active table.)
// The graph rows (issue #54) add four keys; every twin pair below is width-identical on purpose, so a
// renderer's padding math never depends on which table is active.
const OVERLAY_GLYPHS = { tl: "┌", tr: "┐", bl: "└", br: "┘", ml: "├", mr: "┤", h: "─", v: "│", full: "█", empty: "░", ellipsis: "…", arrowRight: "─▶", foldOpen: "▾", foldClosed: "▸", rearm: "↻" };
const OVERLAY_ASCII = { tl: "+", tr: "+", bl: "+", br: "+", ml: "+", mr: "+", h: "-", v: "|", full: "#", empty: ".", ellipsis: "...", arrowRight: "->", foldOpen: "v", foldClosed: ">", rearm: "~" };

/** Per-class colors for `fmtCost`: an estimate must LOOK provisional, and plan coverage must not look free. */
const COST_COLORS = {
  metered: "text",
  plan: "accent",
  "zero-rated": "dim",
  estimated: "warning",
  seeded: "warning",
};

/**
 * Bind the color helpers to a `theme` instance (or PLAIN_THEME). Every helper computes layout on plain
 * text and applies color last, so the returned strings have a KNOWN visible width equal to their plain
 * width. `ascii: true` swaps the styler's frame/meter/divider glyphs (and the cell ellipsis) for their
 * ASCII twins with identical geometry.
 */
export function makeStyler(theme, { ascii = false } = {}) {
  const th = theme ?? PLAIN_THEME;
  const G = ascii ? OVERLAY_ASCII : OVERLAY_GLYPHS;

  /** Color `text` with a theme color, or return it unchanged when `color` is falsy. */
  const fg = (color, text) => (color ? th.fg(color, String(text)) : String(text));
  const bold = (text) => th.bold(String(text));

  /**
   * A cell of exactly `width` visible columns.
   *
   * IT MEASURES WHAT IT WILL PRINT, which it did not (issue #382, item 3). It sliced the RAW string, so
   * pre-coloured text spent its budget on SGR bytes: `cell(coloured, 16)` came out 6 columns wide, breaking
   * this module's own stated invariant, and at the widths inside `MIN_WIDTH` the slice landed mid-sequence
   * and emitted a bare `ESC [ 3` with no terminator -- which makes a terminal swallow the rest of the line
   * as CSI parameters. `fitLine` in the dashboard already had the fix shape: strip first, then measure.
   *
   * COLOUR ALREADY ON THE INPUT IS DROPPED, deliberately. Keeping it needs an ANSI-aware slice, and this
   * module does not import pi-tui to get one. Nothing loses a hyperlink to this, because nothing emits one
   * any more: the two OSC-8 links this used to have to work around were withdrawn with `styler.link`.
   *
   * NOT A DATA GATE, and the distinction matters to a caller. Because it strips escapes BEFORE
   * substituting, an SGR- or OSC-8-shaped run inside DATA is deleted whole (its URL payload included),
   * while a lone control byte becomes a space. Data goes through `cellOf`/`scrubControls` first; this makes
   * a cell, it does not sanitise one.
   */
  const cell = (text, width, { color = null, align = "left", strong = false } = {}) => {
    const w = Math.max(0, Math.trunc(width) || 0);
    let plain = scrubControls(stripAnsi(String(text ?? "")));
    // `dropLoneSurrogate` on every cut, like `clip`: slicing UTF-16 units can land between the halves of an
    // astral character, and half a pair is not a character. Measured at 89 lines of a framed LIST printing
    // one, from a target field of emoji -- the first repair reached `clip` alone and three other cutters
    // slice the same way.
    // BY COLUMNS, not by code units (issue #401), and through `sliceColumns` so a cut never lands inside a
    // two-column character -- which a terminal draws as one blank column plus one of overflow.
    if (columnsOf(plain) > w) {
      const ell = G.ellipsis;
      // The narrow branch slices the CONTENT, not the ellipsis, which is what this line did before #401 and
      // what `clipPlain` below still does. `panel.mjs`'s `clip` shows the ellipsis instead at such a width.
      // That disagreement is pre-existing and left alone here: the three cutters differ only where the
      // budget is narrower than the ellipsis glyph itself, and changing which one is right is a question
      // about what to show, not about how wide it is.
      plain = w <= columnsOf(ell) ? sliceColumns(plain, w) : sliceColumns(plain, w - columnsOf(ell)) + ell;
    }
    const gap = " ".repeat(Math.max(0, w - columnsOf(plain)));
    plain = align === "right" ? gap + plain : plain + gap;
    let out = color ? fg(color, plain) : plain;
    return strong ? bold(out) : out;
  };

  /** A small colored token (no padding). Visible width === label.length (+ padding if `pad`). */
  const badge = (label, color, { pad = false } = {}) => {
    const text = pad ? ` ${label} ` : String(label);
    return fg(color, text);
  };

  /**
   * A block-char spend meter fitted to `width` visible columns: `[███░░░] r/cap`. The filled cells take
   * `state`'s color (ok→success, soft-hold→warning, over→error), the empty cells `dim`, the label the
   * state color too. When `cap` is not a positive integer the true cap is unknown, so it renders
   * `r / ? (cap unknown)` with no bar. Visible width === `width`.
   */
  const meter = (reserved, cap, width, state = "ok") => {
    const w = Math.max(8, Math.trunc(width) || 8);
    const r = Number.isFinite(reserved) ? Math.max(0, Math.trunc(reserved)) : 0;
    const stateColor = state === "over" ? "error" : state === "soft-hold" ? "warning" : "success";
    if (!Number.isInteger(cap) || cap <= 0) {
      const plain = `${r} / ? (cap unknown)`;
      return cell(plain, w, { color: "dim" });
    }
    const label = ` ${r}/${cap}`;
    const barCells = Math.max(0, w - label.length - 2); // "[" + cells + "]"
    const filled = Math.min(barCells, Math.round((Math.min(r, cap) / cap) * barCells));
    // Build colored, keep track of visible width == w exactly.
    const open = fg("dim", "[");
    const fillPart = filled > 0 ? fg(stateColor, G.full.repeat(filled)) : "";
    const emptyPart = barCells - filled > 0 ? fg("dim", G.empty.repeat(barCells - filled)) : "";
    const close = fg("dim", "]");
    const labelPart = fg(stateColor, label);
    return open + fillPart + emptyPart + close + labelPart;
  };

  /**
   * A section divider that fills `width`: `LABEL ─────────── meta`. `label` is bold/muted, the rule is
   * `border`-colored, `meta` (optional, right side) is `dim`. Visible width === `width`.
   */
  const divider = (label, meta, width) => {
    const w = Math.max(4, Math.trunc(width) || 4);
    // MEASURED THE WAY IT IS PRINTED, like `cell`: an SGR-bearing label spent its budget on bytes nobody
    // sees. And when the two together do not fit, the META is clipped first and the LABEL after it -- below
    // about 46 columns the rule length was clamped to 1 and the line ran over its own width, which the
    // frame then had to paper over.
    const lab = scrubControls(stripAnsi(String(label ?? ""))).toUpperCase();
    let met = scrubControls(stripAnsi(String(meta ?? "")));
    // The rule is at least one column, so the two labels have `w - 3` between them with a meta and `w - 2`
    // without: clip the META first, and the LABEL only if it alone still does not fit. Getting this wrong by
    // one is why the clamp existed in the first place -- `Math.max(1, ...)` hid the overflow instead of
    // preventing it, and the line ran over its own width.
    met = sliceColumns(met, Math.max(0, w - columnsOf(lab) - 3));
    const labClipped = sliceColumns(lab, Math.max(0, w - columnsOf(met) - (met ? 3 : 2)));
    const ruleLen = Math.max(1, w - columnsOf(labClipped) - columnsOf(met) - (met ? 2 : 1));
    const labPart = labClipped ? bold(fg("muted", labClipped)) + " " : "";
    const rulePart = fg("border", G.h.repeat(ruleLen));
    const metPart = met ? " " + fg("dim", met) : "";
    return labPart + rulePart + metPart;
  };

  /**
   * Join pre-built cells (each already exactly its width) with a plain separator. The separator is plain
   * (its width counts); cells carry their own color. Visible width === sum(cellWidths) + sep widths.
   */
  const joinCells = (cells, sep = "  ") => cells.join(sep);

  /**
   * Colored twin of panel's `sparkline`: the SAME function composes the plain cells (so the geometry
   * cannot drift), and color arrives as its per-cell `paint` hook, applied after quantization. Cells
   * at/above `opts.warnAbove` take "warning", the rest "accent", gaps "dim". Under PLAIN_THEME the
   * output is byte-identical to the plain sparkline.
   */
  const sparkline = (values, width, opts = {}) => {
    const { warnAbove, ...rest } = opts ?? {};
    const warn = Number.isFinite(warnAbove) ? warnAbove : null;
    const paint = (text, v) => (v === null ? fg("dim", text) : fg(warn !== null && v >= warn ? "warning" : "accent", text));
    return plainSparkline(values, width, { ...rest, paint });
  };

  /**
   * Colored twin of panel's `fmtCost`: the plain renderer owns the shape, this only colors it per class
   * (unknown/malformed share "dim"). With a `width` the result is a fixed `cell` of exactly that visible
   * width; without one the visible width equals the plain string's length.
   */
  const fmtCost = (cost, width) => {
    const plain = plainFmtCost(cost);
    const color = (cost && typeof cost === "object" && COST_COLORS[cost.class]) || "dim";
    return width == null ? fg(color, plain) : cell(plain, width, { color });
  };

  /**
   * Render a `makeLineInput` at `width` with the cursor cell in inverse video. panel's focused render
   * marks the cursor by wrapping one cell in the C0 `LINE_INPUT_CURSOR` pair; here that pair becomes an
   * inverse-video cell, and the visible width is exactly `width`. `clip` DELETES that pair, which is the
   * pin `panel.mjs` keeps it deleting for -- but no production path clips a focused render, so this
   * docblock no longer claims a monochrome caller that funnels one through it.
   */
  const lineInput = (input, width) => {
    const raw = input.render(width, { focused: true });
    const [open, close] = LINE_INPUT_CURSOR;
    const i = raw.indexOf(open);
    const j = raw.indexOf(close, i + 1);
    if (i < 0 || j < 0) return raw;
    const cursorCell = raw.slice(i + 1, j);
    const inverse = typeof th.inverse === "function" ? th.inverse(cursorCell) : cursorCell;
    return raw.slice(0, i) + inverse + raw.slice(j + 1);
  };

  // NO `link`. The styler used to wrap a run target in an OSC-8 hyperlink; issue #382 withdrew it, and the
  // function is gone rather than merely uncalled, so the hazard cannot be reintroduced by a caller who did
  // not read why. The gate over finished pane lines allowlists a SHAPE, and a hyperlink written into a
  // trigger field has the same shape as one written here: keeping ours kept theirs, with their URL under
  // their display text. `stripAnsi` still recognises OSC-8, because data can still contain one.

  return { theme: th, glyphs: G, fg, bold, cell, badge, meter, divider, joinCells, sparkline, fmtCost, lineInput, stripAnsi, visibleLen };
}

/**
 * Frame `lines` (each already EXACTLY `inner = width-4` visible columns) into a titled box with colored
 * borders. `title` is bold; `footer` (optional) is set off by a rule. Returns `string[]`; each line's
 * visible width === `width`. The border glyphs are `border`-colored; the caller owns the inner content's
 * color. Mirrors panel.mjs `box`'s geometry so widths line up, but colored and overlay-only.
 */
export function frame(styler, { title = "", width = 40, lines = [], footer = null } = {}) {
  const w = Math.max(8, Math.trunc(width) || 8);
  const inner = w - 4;
  const G = styler.glyphs ?? OVERLAY_GLYPHS;
  const B = (s) => styler.fg("border", s);
  const out = [];

  const titleText = title ? ` ${clipPlain(title, Math.max(0, inner - 2), G.ellipsis)} ` : "";
  // THE TOP RULE IS FILLED IN COLUMNS, not code units (issue #401). A CJK title is half as many code units
  // as the terminal draws columns, so `.length` here over-filled the rule by the title's own width: a
  // 20-column pane came out 23 wide on its FIRST line only, with every body line correct, which is the
  // shape that hides such a bug. `titleText` is plain by construction (`clipPlain` strips), so the plain
  // column count is the whole measurement and no ANSI-aware pass is needed.
  const topFill = Math.max(0, w - 2 - 1 - styler.visibleLen(titleText));
  out.push(B(G.tl + G.h) + styler.bold(styler.fg("accent", titleText)) + B(G.h.repeat(topFill) + G.tr));

  const side = (content) => B(G.v) + " " + content + " " + B(G.v);
  const rule = () => B(G.ml + G.h.repeat(w - 2) + G.mr);

  for (const line of lines) {
    if (line === RULE) out.push(rule());
    else out.push(side(padVisible(styler, line, inner)));
  }

  if (footer !== null && footer !== undefined) {
    out.push(rule());
    out.push(side(padVisible(styler, footer, inner)));
  }

  out.push(B(G.bl + G.h.repeat(w - 2) + G.br));
  return out;
}

/** Sentinel a caller can push into `frame`'s `lines` to emit a `├──┤` separator rule. */
export const RULE = Symbol("rule");

/** Right-pad a possibly-colored line with plain spaces to `width` visible columns (never truncates up-front). */
function padVisible(styler, line, width) {
  // THE GATE, and the reason it is here rather than at thirty call sites: every framed body line and every
  // footer passes through this one function, whatever pane built it and whoever wrote the values in it.
  // `scrubKeepingStyle` keeps the styler's own SGR and substitutes everything else -- an OSC-8 link
  // included, which is why this panel no longer writes one. It runs BEFORE the measurement, for two
  // reasons: a byte that became a space is a column the frame has to account for, and `stripAnsi` still
  // recognises a link shape the gate does not, so the other order measured 36 where the terminal paints 46.
  line = scrubKeepingStyle(line);
  const vis = styler.visibleLen(line);
  // STRICTLY GREATER, then clip: the frame promises every body line is exactly `inner` columns, and an
  // over-wide one broke the right border instead -- the spend "off" rows at narrow widths never fitted.
  // `>=` here would strip colour from every line that already fits, which is why the comparison is strict.
  if (vis > width) return styler.cell(line, width);
  if (vis === width) return line;
  return line + " ".repeat(width - vis);
}

/**
 * Plain clip to `width` columns with an ellipsis (used for the title only; content is pre-sized).
 *
 * The title is STRIPPED of control bytes here rather than at each call site (issue #337). Two of the five
 * frame titles are built from a record's job id, this function clips without stripping, and fixing one
 * caller left the other carrying what the lines inside the frame no longer did. `panel.mjs`'s own `box`
 * already titles through the same operation now, so the two frame builders agree on the CLASS -- which
 * lives in `panel.mjs` and is imported, not respelled here (issue #382) -- AND on what to do with a match.
 * Both SUBSTITUTE a space, because `frame` computes its top rule from the title's own width at the call
 * site and a deleting strip would silently change that arithmetic.
 */
function clipPlain(s, width, ellipsis = "…") {
  const plain = scrubControls(s);
  if (columnsOf(plain) <= width) return plain;
  return width <= columnsOf(ellipsis) ? sliceColumns(plain, width) : sliceColumns(plain, width - columnsOf(ellipsis)) + ellipsis;
}
