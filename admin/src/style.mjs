/**
 * Overlay-only color + layout helpers for the /dispatch dashboard, built on pi's injected `Theme`.
 *
 * The invariant that keeps color safe (feasibility-verified against pi-tui):
 *   - COLOR IS APPLIED POST-LAYOUT. Every width/padding decision is made on PLAIN text; color is the last
 *     transform. pi's overlay host measures each returned line with the ANSI-aware `visibleWidth` and
 *     appends its own SGR reset, so post-layout color adds 0 to the measured width and cannot disturb
 *     framing or the `width:"75%"` overlay clamp.
 *   - This module is OVERLAY-ONLY. `render.mjs`/`panel.mjs` deliberately stay plain because they also feed
 *     `pi.sendMessage` (the model-visible channel) and the untrusted `.log` tail's `clip` escape-strip.
 *     Nothing here is imported by those paths; the dependency runs one way (this module imports panel's
 *     pure primitives to color them, never the reverse).
 *
 * `theme` is the instance pi hands the `ctx.ui.custom` factory. It is injected (pi-tui is not importable
 * from here — nested, non-hoisted), so every helper takes a styler bound to that instance. `makeStyler`
 * accepts a null theme (tests / no-TUI) and degrades to plain text with the SAME plain layout, so a test
 * can assert both the plain content and the width math without a real terminal.
 */

import { sparkline as plainSparkline, fmtCost as plainFmtCost, LINE_INPUT_CURSOR } from "./panel.mjs";

// Strip SGR (and OSC-8 hyperlink) escapes to recover the visible text / column count. Content is
// ASCII + box-drawing + a handful of width-1 glyphs, so post-strip `.length` is a safe column proxy.
const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;

export function stripAnsi(s) {
  return String(s ?? "").replace(ANSI, "");
}

/** Visible column count of a (possibly colored) string. */
export function visibleLen(s) {
  return stripAnsi(s).length;
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
   * A fixed-width cell: PLAIN text is clipped+padded to exactly `width` visible columns, THEN colored.
   * `align` is "left" | "right". `bold` bolds after coloring. Result's visible width === `width`.
   */
  const cell = (text, width, { color = null, align = "left", strong = false } = {}) => {
    const w = Math.max(0, Math.trunc(width) || 0);
    let plain = String(text ?? "");
    if (plain.length > w) plain = w <= G.ellipsis.length ? plain.slice(0, w) : plain.slice(0, w - G.ellipsis.length) + G.ellipsis;
    plain = align === "right" ? plain.padStart(w) : plain.padEnd(w);
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
    const lab = String(label ?? "").toUpperCase();
    const met = String(meta ?? "");
    const ruleLen = Math.max(1, w - lab.length - met.length - (met ? 2 : 1));
    const labPart = lab ? bold(fg("muted", lab)) + " " : "";
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
   * inverse-video cell (monochrome callers instead funnel the render through `clip`, which strips the
   * sentinels). Either way the visible width is exactly `width`.
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

  /**
   * Wrap `text` in an OSC-8 hyperlink to `url` when a real theme is attached. Under PLAIN_THEME the text
   * passes through unchanged -- plain output (tests, no-TUI) must carry no escape bytes. `stripAnsi` /
   * `visibleLen` already strip OSC-8 (the regex above), so a linked cell measures exactly its text width.
   */
  const link = (text, url) => {
    const t = String(text ?? "");
    if (th === PLAIN_THEME) return t;
    return `\x1b]8;;${String(url ?? "")}\x07${t}\x1b]8;;\x07`;
  };

  return { theme: th, glyphs: G, fg, bold, cell, badge, meter, divider, joinCells, sparkline, fmtCost, lineInput, link, stripAnsi, visibleLen };
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
  const topFill = Math.max(0, w - 2 - 1 - titleText.length);
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
  const vis = styler.visibleLen(line);
  if (vis >= width) return line;
  return line + " ".repeat(width - vis);
}

/** Plain clip to `width` columns with an ellipsis (used for the title only; content is pre-sized). */
function clipPlain(s, width, ellipsis = "…") {
  const plain = String(s ?? "");
  if (plain.length <= width) return plain;
  return width <= ellipsis.length ? plain.slice(0, width) : plain.slice(0, width - ellipsis.length) + ellipsis;
}
