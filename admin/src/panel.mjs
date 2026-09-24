/**
 * Pure text primitives for the admin dashboard: box-drawing frames, meters, and width-safe clipping.
 * No I/O, no clock, no process.env, no console, no pi API -- every input is a value the caller already
 * has, so these are testable with plain fixtures (asserted pure by panel.test.mjs).
 *
 * PII discipline (no-pii-in-logs, INT-RUN-HISTORY-FILE-CONTRACT): `clipData` is the width gate through
 * which dashboard.ts funnels untrusted, PII-bearing `.log` bytes before framing -- SUBSTITUTE, then clip,
 * so an escape sequence or a stray byte can neither crash the layout nor mis-size a row. `clip` itself
 * DELETES and is not that gate (issue #382); `scrubKeepingStyle` is its twin for a line that already
 * carries the styler's colour.
 */

// Custom: no box-drawing/meter primitive exists in deps -- ink/blessed/boxen are full TUI frameworks and
// this dashboard is a handful of monochrome frames, so a thin pure module is the right size (library-first).

/** Box-drawing + block glyphs. Swap to ASCII via `setGlyphs(true)` for glyph-width-hostile terminals. */
export const GLYPHS = {
  tl: "┌", // top-left corner
  tr: "┐", // top-right corner
  bl: "└", // bottom-left corner
  br: "┘", // bottom-right corner
  h: "─", //  horizontal rule
  v: "│", //  vertical edge
  ml: "├", // left tee (section separator start)
  mr: "┤", // right tee (section separator end)
  full: "█", // filled meter cell
  empty: "░", // empty meter cell
  ellipsis: "…", // truncation marker
  ramp: "▁▂▃▄▅▆▇█", // sparkline quantization ramp, lowest to full; all width-1 BMP so length == columns
  gap: "·", // sparkline cell for an absent (null) value
};

/** Parallel ASCII fallback: same keys, no glyph-width risk. Single point of substitution for `GLYPHS`. */
export const ASCII = {
  tl: "+",
  tr: "+",
  bl: "+",
  br: "+",
  h: "-",
  v: "|",
  ml: "+",
  mr: "+",
  full: "#",
  empty: ".",
  ellipsis: "...",
  ramp: "_.:-=+*#", // same length as GLYPHS.ramp so the quantization math never shifts between tables
  gap: ".",
};

// Custom: a runtime switch, not an environment read -- this module stays pure (asserted by the purity
// test), and whether a terminal is glyph-width-hostile is the caller's knowledge, not this module's.
// The extension entry point reads its own config once at startup and flips the switch; every renderer
// below reads the active table so the whole panel swaps together.
let active = GLYPHS;

/** Select the ASCII glyph table (`setGlyphs(true)`) or restore the box-drawing default (`setGlyphs(false)`). */
export function setGlyphs(ascii) {
  active = ascii ? ASCII : GLYPHS;
}

const MIN_WIDTH = 8;

// eslint-disable-next-line no-control-regex -- defensive strip of C0/C1 control chars from untrusted input
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

// The ONLY escape sequence a styled line may keep: an SGR run. Anything else that starts with ESC is data
// that reached a pane, not decoration this project wrote.
//
// AN OSC-8 HYPERLINK IS NOT ON THIS LIST, and that is the whole reason the panel no longer writes one. An
// allowlist can only recognise a SHAPE, and a hyperlink an attacker put in a trigger field has exactly the
// same shape as one the styler wrote -- so keeping the shape keeps theirs too, with their URL under their
// display text, which is phishing in the operator's terminal. The first version of this gate allowlisted
// OSC-8 and measured itself clean with a normaliser that removed OSC-8 before counting; against a counter
// that did not, 29 lines still carried an attacker's link. A sequence this module cannot attribute is a
// sequence it substitutes.
// eslint-disable-next-line no-control-regex -- the allowlist half of the class above
const STYLE_TOKENS = /\x1b\[[0-9;]*m/g;

/** Remove C0/C1 control characters (shared by `clip` and `makeLineInput`). */
function stripControls(s) {
  return String(s ?? "").replace(CONTROL_CHARS, "");
}

/**
 * THE CLASS IS WRITTEN ONCE, HERE, and every data path substitutes through this (issue #382, item 1).
 *
 * There were five copies of `[\u0000-\u001f\u007f-\u009f]` across four modules, and they did not agree
 * about what to DO with a match. `cell` in render.mjs and `cellOf` in the dashboard both map it to a SPACE,
 * deliberately, so a framed pane and a plain one clip identically -- and `cell`'s own docblock says that
 * deleting instead "would make the panes clip differently". The unframed degrade composed with `clip`,
 * which DELETES, so it did. One record with a control byte in two fields rendered three ways:
 *
 *   FRAMED    "a b . c d"     substituted
 *   DEGRADED  "ab . cd"       deleted
 *   PLAIN     "a b     c d"   substituted
 *
 * Two mutants flipping `cell` and `cellOf` to deletion were both killed by the suite; nothing noticed that a
 * third renderer already deleted.
 *
 * C1 is in the class as well as C0 and DEL, because U+009B is a CSI introducer that needs no ESC in front.
 *
 * This module has no imports today, which is why the class lives here and the callers come to it rather
 * than the other way round. Stated as a fact about the file and not as a pin: `panel.test.mjs`'s purity
 * test bans fs, `console`, `process.env` and the pi package by name, and a plain local import would pass
 * it. The first version of this comment claimed a pin that does not exist.
 */
export function scrubControls(s) {
  return String(s ?? "").replace(CONTROL_CHARS, " ");
}

/**
 * The same class and the same operation, on a line that ALREADY carries the styler's own colour.
 *
 * `scrubControls` cannot be used there: ESC is itself in the class, so it would eat every SGR run and the
 * pane would come out monochrome. The answer is an ALLOWLIST of the one sequence this project's styler
 * emits -- an SGR run -- with every other control character becoming a space, a bare ESC included. So
 * `ESC [ 2 J`, `ESC ] 52 ; c ; ...`, an OSC-8 hyperlink and a lone U+009B all survive as inert text, while
 * `ESC [ 31 m` passes through untouched.
 *
 * WHY A GATE AND NOT ANOTHER BELT. The first version of this change drew the line by PROVENANCE: the record
 * panes were scrubbed and the config panes were not, on the ground that they render what the operator typed.
 * An adversarial pass refuted that. `run.image`, `on.phrase` and `on.any` are accepted verbatim by the
 * project's own `writeTriggers` -- its one control-byte refusal covers `run.command` -- and `on.phrase` and
 * a label arrive there from the model-callable `dispatch_trigger_add` as well as from a dialog (`run.image`
 * does NOT: an `image` parameter on that tool is a recorded rejection). A trigger carrying an erase-display,
 * an OSC-8 link or an OSC-52 clipboard write rendered RAW into the overlay and into `sendMessage`. The design entry's rule has always been "whoever wrote that field", and a carve-out
 * with a list of exceptions is the shape that keeps being wrong here. So the rule is now: no exception, and
 * one place enforces it. The per-field scrubs stay, as belt-and-braces rather than as the boundary.
 */
export function scrubKeepingStyle(s) {
  const text = String(s ?? "");
  let out = "";
  let at = 0;
  STYLE_TOKENS.lastIndex = 0;
  for (let m = STYLE_TOKENS.exec(text); m !== null; m = STYLE_TOKENS.exec(text)) {
    out += scrubControls(text.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
  }
  return out + scrubControls(text.slice(at));
}

/**
 * The same class and the same operation, but PER LINE: a message written with newlines keeps them.
 *
 * Written once here because it is now the third caller of the same idiom (issue #404) -- the sandbox
 * session's suspended-terminal writes, the model-visible `send`, and pi's dialogs -- and #382's whole
 * lesson was five copies of one class across four modules that had quietly stopped agreeing. A composed
 * operation duplicated three times is the same shape one level up, and the copy that went untested was
 * where a mutation survived: scrubbing only the first line left every multi-line confirm body unguarded
 * below it.
 */
export function scrubControlsPerLine(s) {
  return String(s ?? "").split("\n").map((line) => scrubControls(line)).join("\n");
}

/** Does this string carry one? `search` rather than `.test`, because a `/g` regex carries `lastIndex`. */
export function hasControls(s) {
  return String(s ?? "").search(CONTROL_CHARS) !== -1;
}

/**
 * Untrusted DATA, clipped for a pane: substitute, then clip. The one call a renderer of `.log` lines or of
 * a record field should be making.
 *
 * `clip` itself still DELETES, and that is not an oversight. `LINE_INPUT_CURSOR` marks the cursor with
 * `\x01`/`\x02` sentinels -- the same byte class -- and `panel.test.mjs` pins that `clip` removes them, so
 * a substituting `clip` would widen every focused render by one column per sentinel. No production path
 * clips a focused render today (`styler.lineInput` replaces the sentinels first, and the degraded tail uses
 * `.value()`), so the reason to keep `clip` deleting is that pin and the defence it gives, not a live
 * caller. Said plainly because the first draft of this change claimed a caller that does not exist.
 */
export function clipData(line, w) {
  return clip(scrubControls(line), w);
}

/**
 * Truncate `line` to `w` display columns, appending an ellipsis glyph when content is cut. Control
 * characters (including escape sequences) are stripped first so untrusted input cannot crash or mis-size:
 * content is ASCII/box-drawing, so post-strip `String.length` is a safe column proxy.
 */
export function clip(line, w) {
  const width = Math.max(0, Math.trunc(w) || 0);
  const clean = stripControls(line);
  if (clean.length <= width) return clean;
  const ell = active.ellipsis;
  if (width <= ell.length) return ell.slice(0, width);
  return dropLoneSurrogate(clean.slice(0, width - ell.length)) + ell;
}

/**
 * A cut lands between the two halves of an astral character, and half a surrogate pair is not a character:
 * it reaches the terminal as U+FFFD at best. Measured through the real `/dispatch logs` viewer on a log of
 * emoji. Dropping the orphan costs one column of content and is the only bounded answer -- widening the cut
 * would break the width promise instead.
 */
export function dropLoneSurrogate(s) {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

/** `clip` to `w`, then right-pad with spaces to exactly `w` columns. */
export function pad(line, w) {
  const width = Math.max(0, Math.trunc(w) || 0);
  return clip(line, width).padEnd(width);
}

/**
 * Frame `sections` into a titled box, returning `string[]` where no line exceeds `width`. The inner
 * content width (`width - 4`) is computed once and is the single source of alignment truth: every inner
 * line is `pad`/`clip`ped to it. Below `MIN_WIDTH` the width is floored to `MIN_WIDTH` so a too-small
 * request degrades to a minimal frame rather than emitting ragged or over-width rows.
 */
export function box({ title = "", sections = [], footer, width = 40 } = {}) {
  const w = Math.max(MIN_WIDTH, Math.trunc(width) || MIN_WIDTH);
  const inner = w - 4; // "| " + content + " |"
  const lines = [];

  // Top border: `+- title -...-+`, title clipped so the border never overflows `w`.
  // `clipData`, not `clip`: `frame` substitutes in its own title (`clipPlain`), and a title that DELETES
  // here clipped one column narrower than the coloured twin for the same string.
  const titleText = title ? ` ${clipData(title, Math.max(0, inner - 2))} ` : "";
  const topFill = Math.max(0, w - 2 - 1 - titleText.length); // corners + one leading `h`
  lines.push(active.tl + active.h + titleText + active.h.repeat(topFill) + active.tr);

  const framed = (text) => `${active.v} ${pad(text, inner)} ${active.v}`;
  const rule = () => active.ml + active.h.repeat(w - 2) + active.mr;

  sections.forEach((section, i) => {
    if (i > 0) lines.push(rule());
    if (section?.title) lines.push(framed(section.title));
    for (const line of section?.lines ?? []) lines.push(framed(line));
  });

  if (footer !== undefined && footer !== null) {
    if (sections.length > 0) lines.push(rule());
    lines.push(framed(footer));
  }

  lines.push(active.bl + active.h.repeat(w - 2) + active.br);
  return lines;
}

/**
 * A block-char progress bar `[####....] reserved/cap` fitted to `width`. When `cap` is not a positive
 * integer the true cap is unknown to this process, so it renders `reserved / ? (cap unknown)` with no bar
 * rather than a bar against a guessed denominator.
 *
 * `state` ("ok" | "soft-hold" | "over") appends a textual marker to the label: the panel is monochrome and
 * `clip` strips ANSI, so the amber/red of a soft-hold or over-budget window is carried as a word, not a
 * color. "ok" (the default) adds nothing, so a plain call renders exactly as before.
 */
export function meter(reserved, cap, width = 24, state = "ok") {
  const r = Number.isFinite(reserved) ? Math.max(0, Math.trunc(reserved)) : 0;
  if (!Number.isInteger(cap) || cap <= 0) {
    return clip(`${r} / ? (cap unknown)`, width);
  }
  const tag = state === "soft-hold" ? " soft-hold" : state === "over" ? " over" : "";
  const label = ` ${r}/${cap}${tag}`;
  const barCells = Math.max(0, Math.trunc(width) - label.length - 2); // "[" + cells + "]" + label
  const filled = Math.min(barCells, Math.round((Math.min(r, cap) / cap) * barCells));
  const bar = `[${active.full.repeat(filled)}${active.empty.repeat(barCells - filled)}]`;
  return clip(bar + label, width);
}

/**
 * A one-line cost history: `values` (oldest -> newest, number|null) quantized onto the ramp glyphs and
 * fitted to `width` columns. Negatives clamp to 0 (a cost cannot be negative); null/non-finite entries
 * render the gap glyph. Returns a plain string of at most `width` columns: cells repeat
 * `max(1, floor(width / values.length))` times and the total never exceeds `width`.
 *
 * Custom: quantization is ZERO-BASED, never min-max -- min-max scaling exaggerates cheap-day noise into
 * full-height bars, and money proportions must stay truthful: half the ceiling reads as half a bar. The
 * ceiling is `opts.max` when finite and positive (a shared scale so sparklines are comparable across
 * rows), else the max of the finite values; with no positive ceiling there is nothing truthful to draw,
 * so the cell reads "no data".
 *
 * Custom: 0 renders `ramp[0]` and null renders the gap glyph -- a zero-cost day is a fact, an absent day
 * is unknown, and the two must never look alike. `ramp[0]` is reserved for exact zero: any positive value
 * starts at `ramp[1]`, so a tiny-but-nonzero day never collapses into the zero baseline either.
 *
 * `opts.paint(cellText, value)` (optional; value is null for gaps) wraps each cell run after
 * quantization. It exists so style.mjs can color cells without duplicating this geometry -- color stays
 * post-layout, and an identity paint returns byte-identical output.
 */
export function sparkline(values, width = 24, opts = {}) {
  const w = Math.max(0, Math.trunc(width) || 0);
  if (w === 0) return "";
  const norm = (Array.isArray(values) ? values : []).map((v) => (Number.isFinite(v) ? Math.max(0, v) : null));
  const finite = norm.filter((v) => v !== null);
  const ceiling = Number.isFinite(opts?.max) && opts.max > 0 ? opts.max : Math.max(0, ...finite);
  if (finite.length === 0 || ceiling <= 0) return clip("no data", w);

  // Custom: when there are more values than columns, each column takes its bucket's MAX, never an
  // average -- peaks matter for cost, and an averaged-away spike is exactly the day an operator
  // needs to see. A bucket with no finite value at all stays a gap.
  let cells = norm;
  if (norm.length > w) {
    cells = [];
    for (let i = 0; i < w; i++) {
      const bucket = norm.slice(Math.floor((i * norm.length) / w), Math.floor(((i + 1) * norm.length) / w));
      const present = bucket.filter((v) => v !== null);
      cells.push(present.length > 0 ? Math.max(...present) : null);
    }
  }

  const rep = Math.max(1, Math.floor(w / cells.length));
  const top = active.ramp.length - 1;
  const paint = typeof opts?.paint === "function" ? opts.paint : (text) => text;
  let out = "";
  let cols = 0;
  for (const v of cells) {
    const run = Math.min(rep, w - cols);
    if (run <= 0) break;
    const glyph = v === null ? active.gap : v === 0 ? active.ramp[0] : active.ramp[Math.min(top, Math.ceil((v / ceiling) * top))];
    out += paint(glyph.repeat(run), v);
    cols += run;
  }
  return out;
}

/**
 * Compact USD for tight cells, at most 7 characters at any magnitude: `$0.0042`, `$0.42`, `$4.12`,
 * `$41.20`, `$412`, `$4.1k`, `$412k`, `$4.1M`. Sub-cent costs are real money and render at four
 * decimals; below what four decimals can show meaningfully the honest fallback is `<1¢` -- never
 * `$0.00`, which would misread as free. Non-finite and negative input (this ladder renders costs;
 * a negative cost is malformed) degrade to `-`.
 */
export function fmtUsd(n) {
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n === 0) return "$0";
  if (n < 0.0005) return "<1¢";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${Math.round(n)}`;
  if (n < 100000) return `$${(n / 1000).toFixed(1)}k`;
  if (n < 1e6) return `$${Math.round(n / 1000)}k`;
  if (n < 1e8) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${Math.round(n / 1e6)}M`;
}

/**
 * THE single renderer of the typed cost value `{ usd, class, floor, coverage, planId }` -- every money
 * surface funnels here.
 *
 * Custom: the class system exists so an estimate CANNOT be mislabeled as truth by a rendering path.
 * Each class has a distinct, non-overlapping shape: metered is a bare dollar figure (`≥`-prefixed when
 * only a floor is known), plan is `plan:<planId>` and never a dollar amount (a covered run must never
 * read as $0.00), zero-rated is `$0 (unrated)` and never the word "free", estimated is `~` + figure +
 * ` est.`, seeded is `~~` + figure + ` seeded`, unknown is an em dash. Nullish or malformed input also
 * degrades to the em dash rather than guessing a class.
 */
export function fmtCost(cost) {
  if (!cost || typeof cost !== "object") return "—";
  const floor = cost.floor ? "≥" : "";
  switch (cost.class) {
    case "metered":
      return floor + fmtUsd(cost.usd);
    case "plan":
      return `plan:${cost.planId ?? "?"}`;
    case "zero-rated":
      return "$0 (unrated)";
    case "estimated":
      return `~${floor}${fmtUsd(cost.usd)} est.`;
    case "seeded":
      return `~~${fmtUsd(cost.usd)} seeded`;
    default:
      return "—";
  }
}

/**
 * Sentinel pair `render` wraps around the cursor cell when focused. Both are C0 control characters on
 * purpose: `clip`'s control strip drops them to nothing, so a plain box that clipped a focused render
 * would simply show no cursor, while style.mjs replaces the pair with an inverse-video cell. Either way
 * the result is exactly the render width in visible columns. Stated as a property of `clip` and not as a
 * live caller: no production path clips a focused render, which is why `clip` keeps DELETING for this
 * pin's sake rather than for a caller's (issue #382).
 */
export const LINE_INPUT_CURSOR = ["\x01", "\x02"];

/**
 * A pure single-line text-input state machine. No key decoding lives here -- the caller decodes raw
 * input (keys.mjs) and calls the edit methods, which keeps this module free of the pi-tui resolver and
 * keeps every transition a plain value-in/value-out step a test can drive directly.
 *
 * `render(width, { focused })` windows the value around the cursor when it outgrows `width - 1` (the
 * cursor needs one cell past the last character) and always returns exactly `width` visible columns;
 * when focused, the cursor cell is wrapped in `LINE_INPUT_CURSOR` (see above).
 */
export function makeLineInput(initial = "") {
  let value = stripControls(initial);
  let cursor = value.length;
  return {
    value: () => value,
    cursor: () => cursor,
    /** Insert a printable char -- or a whole pasted string -- at the cursor; control chars are stripped first. */
    insert(ch) {
      const clean = stripControls(ch);
      if (clean.length === 0) return;
      value = value.slice(0, cursor) + clean + value.slice(cursor);
      cursor += clean.length;
    },
    backspace() {
      if (cursor === 0) return;
      value = value.slice(0, cursor - 1) + value.slice(cursor);
      cursor -= 1;
    },
    del() {
      if (cursor < value.length) value = value.slice(0, cursor) + value.slice(cursor + 1);
    },
    left() {
      if (cursor > 0) cursor -= 1;
    },
    right() {
      if (cursor < value.length) cursor += 1;
    },
    home() {
      cursor = 0;
    },
    end() {
      cursor = value.length;
    },
    setValue(s) {
      value = stripControls(s);
      cursor = value.length;
    },
    render(width, { focused = true } = {}) {
      const w = Math.max(1, Math.trunc(width) || 1);
      const start = value.length > w - 1 ? Math.max(0, cursor - (w - 1)) : 0;
      const text = value.slice(start, start + w).padEnd(w);
      if (!focused) return text;
      const rel = cursor - start; // 0..w-1 by construction: the window never scrolls past the cursor
      return text.slice(0, rel) + LINE_INPUT_CURSOR[0] + text[rel] + LINE_INPUT_CURSOR[1] + text.slice(rel + 1);
    },
  };
}
