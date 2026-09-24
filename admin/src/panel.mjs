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

/**
 * THE CLASS, and the line it draws is INTERPRETED against COMPOSING (issue #402).
 *
 * It used to stop at what a terminal EXECUTES: C0, DEL and C1, with U+009B in it because a CSI introducer
 * needs no ESC in front. That left every code point which changes what a reader SEES without executing
 * anything, and two of those are worth naming:
 *
 *   - a bidi override or isolate REORDERS the text after it, so `repo/safe` plus U+202E plus `gnp.txt`
 *     is drawn as a name ending in `.png`. The job id, the target and the branch are all attacker- or
 *     model-writable, and a run record is what an operator reads before deciding what to do about it.
 *   - an invisible break character makes two DIFFERENT strings draw identically: `deploy-prod` and
 *     `deploy` plus U+200B plus `-prod` are 11 columns each and are not the same trigger. The panel's
 *     pickers select by the string, so the operator can edit or delete the row they did not mean.
 *
 * Issue #401 answered the OTHER half of that issue's argument: these code points are zero columns now,
 * which is what the renderer draws, so they no longer corrupt the geometry. What was left was the reading,
 * which is why the class moves rather than the width table.
 *
 * WHAT IS DELIBERATELY NOT IN IT: a code point that COMPOSES the character beside it. U+200D joins an
 * emoji sequence into one glyph, U+200C is orthography in Persian and the Indic scripts, and a variation
 * selector chooses a character's form and carries a column with it under #401. Substituting those changes
 * a CHARACTER, where substituting the rest reveals a CONTROL, and a gate that cannot tell those apart is
 * one that corrupts the text it was added to protect.
 *
 * THE WORKER ANSWERS THE SAME QUESTION DIFFERENTLY, and the difference is not an inconsistency to fix.
 * `endpointShown` ESCAPES rather than substitutes, because its gate is an allowlist of printable ASCII: an
 * endpoint is a DNS name or a socket path, so anything else is suspect there. This panel renders a CJK
 * repository name as a matter of course, and #401 was largely about drawing it correctly, so the same
 * allowlist here would escape the content it just learned to measure.
 */
// eslint-disable-next-line no-control-regex -- the C0/C1 half of the class above
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2028\u2029\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

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
 * THE COLUMN COUNT OF A STRING, which is not its `.length` (issue #401).
 *
 * Every width promise in this panel was a UTF-16 code-unit count: `clip`, `pad`, `styler.cell`, `divider`,
 * `clipPlain`, `visibleLen`, both frame builders' top rules and the line editor's window all sized
 * themselves by `.length`. Measured against the pinned renderer's own `visibleWidth`:
 *
 *   a CJK job id `ジョブ番号`   .length 5    drawn 10
 *   fullwidth `ＪＯＢ`          .length 3    drawn 6
 *   Hangul `한글테스트`         .length 5    drawn 10
 *   combining marks `jób́`      .length 5    drawn 3
 *
 * So a run whose target is a CJK repository name drew a frame whose right border sat past the one above
 * it, and a combining mark left it ragged the other way.
 *
 * ONE RULE, NOT TWO. The obvious alternative was to import pi-tui's `visibleWidth` in `style.mjs`, which
 * is overlay-only and already depends on pi. It was rejected: `panel.mjs` owns `clip` and the monochrome
 * renderer, its purity pin forbids it reaching the world at all (that pin names the renderer's own scope
 * among the things this file may not mention), and the two renderers draw the same geometry -- a width rule that holds in the framed pane
 * and not in the plain one is the "holds on one branch of an if" shape three issues in this round have now
 * been about. So the table lives here and the styler comes to it.
 *
 * THE TABLE IS TRANSCRIBED FROM THE RENDERER, NOT FROM UAX #11, and that is the correction that matters.
 * A first version of this was written out of the standard by hand and checked against ten strings. It
 * passed, and it UNDER-counted 139,820 code points: all of CJK Extension B through H, Tangut, the Kana
 * supplement, the Hangul Jamo extensions and every emoji block added since Unicode 13. CJK Extension B is
 * exactly the "CJK repository name" this issue is about, so the fix carried the defect it was fixing, and
 * in two classes (astral characters, and an emoji-presentation sequence) it was WORSE than the `.length`
 * it replaced -- an astral character is two code units and two columns, so `.length` had been right there
 * by accident. The renderer draws these panes, so the renderer, not the standard, is the authority.
 *
 * WHAT IT COUNTS:
 *
 *   - zero for a mark (`\p{M}`) and for a format character (`\p{Cf}`), plus the fillers and
 *     noncharacters the renderer also draws as nothing;
 *   - two for every code point in `WIDE`, which is that renderer's own double-width set;
 *   - two for a narrow character followed by U+FE0F, which asks for its emoji form, and two for a keycap,
 *     which is one of twelve bases plus U+FE0F plus U+20E3 drawn as a single key;
 *   - one for everything else, including an unassigned code point, because guessing wider on an unknown is
 *     how a rule starts breaking the panes it was added to fix.
 *
 * WHAT IT IS HELD TO, in `width.test.mjs`: two sweeps, one of every code point there is and one of every
 * character followed by U+FE0F and by a keycap, asserting that this never measures NARROWER than the
 * renderer and that every place it measures wider is a declared departure. The pair sweep is there because
 * a first version CLAIMED it and shipped a six-entry list instead, and the hole was one selector further
 * along: a keycap measured 1 against the renderer's 2.
 *
 * THE DIRECTION IS THE WHOLE POINT, and stating it as "over-counting is harmless" would be too kind: BOTH
 * directions rag a frame, and they rag it differently. An over-count pads a body line as though it were
 * wider than it is, so the line comes out SHORT and the right border sits left of the one above it --
 * ugly, bounded, and contained by the pane. An under-count runs the line PAST the pane and past the
 * terminal, where it wraps and takes the border with it, which is the defect this issue names. So the
 * sweep is one-sided on purpose, and the residual below is the safer of two bad shapes, not a harmless
 * one.
 *
 * WHAT IS LEFT, and it is a CLASS rather than one shape: this sums steps, and the renderer collapses some
 * runs of them into a single glyph. An emoji ZWJ sequence counts every member (6 here against 2 there), and
 * so do a skin-tone modifier, a regional-indicator flag pair, a Hangul jamo cluster and a Devanagari
 * cluster. A first version of this paragraph named the ZWJ sequence as the ONLY case; a review pass
 * measured four more, and found the one case that went the other way -- a keycap, at 1 against 2 -- which
 * is fixed above rather than listed here, because an under-count is the direction that overflows a pane.
 *
 * Every remaining case over-counts, so every one draws SHORT inside its border rather than through it.
 * Terminals disagree with each other on all of them, which is why no width table in this project will
 * settle them; a grapheme-aware count needs `Intl.Segmenter` and a terminal that agrees.
 */
export function columnsOf(s) {
  let n = 0;
  for (const step of widthSteps(s)) n += step.cols;
  return n;
}

/**
 * THE STRING AS `{ text, cols }` STEPS, and the reason it exists rather than a per-character width call.
 *
 * Two shapes are WIDER THAN THEIR PARTS, so no function that asks "how wide is this character" can size
 * them: U+FE0F asks for the emoji form of the character before it, and a keycap is a base, U+FE0F and
 * U+20E3 drawn as one two-column glyph. A first repair put that state inside `columnsOf` alone, and a
 * review pass found what that leaves: `sliceColumns` and the line editor call `columnsOf` ONE CHARACTER AT
 * A TIME, where the base is 1 and the selector is 0, so the cut spent a budget of 2 on a glyph the terminal
 * draws 3 wide and the pane overflowed. Counting and cutting now walk the same steps, so they cannot
 * disagree: the count sums `cols`, and the cut takes whole `text` chunks or none of them, which is also why
 * it can no longer strand a selector without its base.
 */
function* widthSteps(s) {
  // HALF A PAIR IS NOT A CHARACTER, and it is removed HERE, once, before anything is measured. A first
  // version made it a step of its own and let each consumer drop it, which a review pass showed is the same
  // defect one level down: dropping it SPLICES ITS NEIGHBOURS TOGETHER, so a base and the selector on the
  // other side of it become one emoji-form sequence, and the cut emitted two columns for a budget of one.
  // Measured through the real pane: a 24-column box drew at 43, by this module's own count.
  //
  // Normalising first also makes the count describe WHAT WILL BE DRAWN rather than what arrived, which is
  // the property every consumer actually needs. It costs an over-count of one against the renderer on the
  // raw input, in the safe direction, because the renderer measures the orphan as a sequence break and we
  // measure the text we are about to hand it.
  const chars = dropOrphans([...String(s ?? "")]);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ZERO_WIDTH.test(ch)) {
      yield { text: ch, cols: 0 };
      continue;
    }
    if (WIDE.test(ch)) {
      yield { text: ch, cols: 2 };
      continue;
    }
    // A NARROW BASE, which is narrow by having reached this line: a code point the renderer already draws
    // wide took the branch above. Only here can a following selector change anything.
    if (chars[i + 1] === VS16) {
      // THE KEYCAP IS THE CASE A FIRST REPAIR GOT BACKWARDS. It excluded ASCII from promotion, correctly,
      // because `#`, `*` and the digits stay one column under U+FE0F alone -- and then said so in a comment
      // that named the keycap as the reason, while the keycap itself went on measuring 1 against the
      // renderer's 2. It takes all three code points, and only these twelve bases.
      if (KEYCAP_BASE.test(ch) && chars[i + 2] === KEYCAP) {
        yield { text: ch + VS16 + KEYCAP, cols: 2 };
        i += 2;
        continue;
      }
      if (ch.codePointAt(0) > 0x7f && TEXT_EMOJI.test(ch)) {
        yield { text: ch + VS16, cols: 2 };
        i += 1;
        continue;
      }
    }
    yield { text: ch, cols: 1 };
  }
}

/** Drop every unpaired surrogate from a character array. Half a pair reaches a terminal as U+FFFD at best. */
function dropOrphans(chars) {
  return chars.filter((c) => !(c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff));
}

/** VARIATION SELECTOR-16 asks for the emoji form; U+20E3 encloses the keycap bases below in a key. */
const KEYCAP = "\u20e3";
const KEYCAP_BASE = /[#*0-9]/;

/** VARIATION SELECTOR-16, which asks for the emoji form of the character before it. */
const VS16 = "\ufe0f";

// ZERO COLUMNS. `\p{M}` is every mark, SPACING MARKS INCLUDED, and that is deliberate: two earlier versions
// of this comment said the opposite, that Mc is excluded because it occupies a column, and both were false
// when written. The argument for excluding it came from Unicode; the renderer that draws this pane gives Mc
// zero, and between a standard and the thing painting the characters the painter wins. Cf covers the
// zero-width and bidi format characters, and the bracketed tail is the Hangul fillers and the noncharacters
// the renderer also draws as nothing.
const ZERO_WIDTH = /\p{M}|\p{Cf}|[ᅟᅠ᠎ㅤﾠ￰-￻]/u;

// A TEXT-PRESENTATION EMOJI: one that draws narrow on its own and WIDE once U+FE0F asks for the emoji
// form. There are 201 of them and they are the reason this table cannot be purely per-character.
const TEXT_EMOJI = /\p{Emoji}/u;

// TWO COLUMNS: every code point the PINNED renderer draws double-width, transcribed FROM that renderer
// rather than written out of UAX #11 by hand, and held to it by an exhaustive sweep in `width.test.mjs`.
// Regenerate it from the pin, never edit a range by hand.
const WIDE = new RegExp(
  "[" +
    "\\u1100-\\u115e\\u231a-\\u231b\\u2329-\\u232a\\u23e9-\\u23ec\\u23f0\\u23f3\\u25fd-\\u25fe\\u2614-\\u2615\\u2630-\\u2637" +
    "\\u2648-\\u2653\\u267f\\u268a-\\u268f\\u2693\\u26a1\\u26aa-\\u26ab\\u26bd-\\u26be\\u26c4-\\u26c5\\u26ce\\u26d4\\u26ea" +
    "\\u26f2-\\u26f3\\u26f5\\u26fa\\u26fd\\u2705\\u270a-\\u270b\\u2728\\u274c\\u274e\\u2753-\\u2755\\u2757\\u2795-\\u2797\\u27b0" +
    "\\u27bf\\u2b1b-\\u2b1c\\u2b50\\u2b55\\u2e80-\\u2e99\\u2e9b-\\u2ef3\\u2f00-\\u2fd5\\u2ff0-\\u3029\\u3030-\\u303e" +
    "\\u3041-\\u3096\\u309b-\\u30ff\\u3105-\\u312f\\u3131-\\u3163\\u3165-\\u318e\\u3190-\\u31e5\\u31ef-\\u321e\\u3220-\\u3247" +
    "\\u3250-\\ua48c\\ua490-\\ua4c6\\ua960-\\ua97c\\uac00-\\ud7a3\\uf900-\\ufaff\\ufe10-\\ufe19\\ufe30-\\ufe52\\ufe54-\\ufe66" +
    "\\ufe68-\\ufe6b\\uff01-\\uff60\\uffe0-\\uffe6\\u{16fe0}-\\u{16fe3}\\u{16ff2}-\\u{16ff6}\\u{17000}-\\u{18cd5}" +
    "\\u{18cff}-\\u{18d1e}\\u{18d80}-\\u{18df2}\\u{1aff0}-\\u{1aff3}\\u{1aff5}-\\u{1affb}\\u{1affd}-\\u{1affe}" +
    "\\u{1b000}-\\u{1b122}\\u{1b132}\\u{1b150}-\\u{1b152}\\u{1b155}\\u{1b164}-\\u{1b167}\\u{1b170}-\\u{1b2fb}" +
    "\\u{1d300}-\\u{1d356}\\u{1d360}-\\u{1d376}\\u{1f004}\\u{1f0cf}\\u{1f18e}\\u{1f191}-\\u{1f19a}\\u{1f1e6}-\\u{1f202}" +
    "\\u{1f210}-\\u{1f23b}\\u{1f240}-\\u{1f248}\\u{1f250}-\\u{1f251}\\u{1f260}-\\u{1f265}\\u{1f300}-\\u{1f320}" +
    "\\u{1f32d}-\\u{1f335}\\u{1f337}-\\u{1f37c}\\u{1f37e}-\\u{1f393}\\u{1f3a0}-\\u{1f3ca}\\u{1f3cf}-\\u{1f3d3}" +
    "\\u{1f3e0}-\\u{1f3f0}\\u{1f3f4}\\u{1f3f8}-\\u{1f43e}\\u{1f440}\\u{1f442}-\\u{1f4fc}\\u{1f4ff}-\\u{1f53d}" +
    "\\u{1f54b}-\\u{1f54e}\\u{1f550}-\\u{1f567}\\u{1f57a}\\u{1f595}-\\u{1f596}\\u{1f5a4}\\u{1f5fb}-\\u{1f64f}" +
    "\\u{1f680}-\\u{1f6c5}\\u{1f6cc}\\u{1f6d0}-\\u{1f6d2}\\u{1f6d5}-\\u{1f6d8}\\u{1f6dc}-\\u{1f6df}\\u{1f6eb}-\\u{1f6ec}" +
    "\\u{1f6f4}-\\u{1f6fc}\\u{1f7e0}-\\u{1f7eb}\\u{1f7f0}\\u{1f90c}-\\u{1f93a}\\u{1f93c}-\\u{1f945}\\u{1f947}-\\u{1f9ff}" +
    "\\u{1fa70}-\\u{1fa7c}\\u{1fa80}-\\u{1fa8a}\\u{1fa8e}-\\u{1fac6}\\u{1fac8}\\u{1facd}-\\u{1fadc}\\u{1fadf}-\\u{1faea}" +
    "\\u{1faef}-\\u{1faf8}\\u{20000}-\\u{2fffd}\\u{30000}-\\u{3fffd}" +
    "]",
  "u",
);

/**
 * Truncate `line` to `w` display columns, appending an ellipsis glyph when content is cut. Control
 * characters (including escape sequences) are stripped first so untrusted input cannot crash or mis-size.
 *
 * The cut is by COLUMNS, through `sliceColumns`, and this docblock used to claim instead that "content is
 * ASCII/box-drawing, so post-strip `String.length` is a safe column proxy". It is not (issue #401): the
 * content includes repository names, job ids and branch names, and a forge accepts whatever the forge
 * accepts.
 */
export function clip(line, w) {
  const width = Math.max(0, Math.trunc(w) || 0);
  // THE TEXT, NOT THE INPUT, on both paths. Returning the input unchanged when it fits left a lone
  // surrogate in the DRAWN line, and the renderer treats one as a cluster break: it then computes the next
  // cluster's base after skipping it and counts that base twice, so `\ud800\uff9f` repeated twelve times
  // measured 12 here and 24 there, and a 24-column pane drew at 36. Stepping the fitted line too makes the
  // rule this module already states -- half a character is removed where text ENTERS -- true of the text
  // rather than only of the count.
  const clean = sliceColumns(stripControls(line), Number.MAX_SAFE_INTEGER);
  if (columnsOf(clean) <= width) return clean;
  const ell = active.ellipsis;
  if (width <= columnsOf(ell)) return sliceColumns(ell, width);
  return sliceColumns(clean, width - columnsOf(ell)) + ell;
}

/**
 * The first `w` COLUMNS of a string, never half of a wide character.
 *
 * A cut by code units splits an astral pair (`dropLoneSurrogate`'s problem) and, once widths are counted,
 * can also stop in the middle of a two-column character -- which a terminal renders as one column of
 * nothing and one column of overflow, so the line is both wrong and ragged. Walking code points and
 * stopping BEFORE the budget is passed means the result is always at most `w` columns and always a whole
 * character, and it makes `dropLoneSurrogate` unnecessary on this path: a surrogate pair is one step here.
 */
export function sliceColumns(s, w) {
  const budget = Math.max(0, Math.trunc(w) || 0);
  // NO BUDGET, NO CONTENT. Without this a zero-column step passes the test below and a cut to zero
  // returned a floating accent with nothing to attach to.
  if (budget === 0) return "";
  let out = "";
  let used = 0;
  for (const step of widthSteps(s)) {
      // Orphans are already gone: `widthSteps` removes them before it steps, so this loop cannot drop a step
    // and splice its neighbours together. `clip` steps its fitted line through here too, so a cut is no
    // longer the only path that removes one.
    if (used + step.cols > budget) break;
    out += step.text;
    used += step.cols;
  }
  // A TRAILING JOINER IS DANGLING: it joins this character to the next one, and the next one is what was
  // just cut away. Left in place it reaches the terminal ahead of the ellipsis and asks it to join a glyph
  // to a horizontal bar. A selector cannot be stranded here any more, because a promoted base carries its
  // selector inside one step, but a ZWJ is a step of its own and is exactly what this strips.
  return out.replace(/\u200d+$/u, "");
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

/** `clip` to `w`, then right-pad with spaces to exactly `w` COLUMNS (issue #401: not `.length`). */
export function pad(line, w) {
  const width = Math.max(0, Math.trunc(w) || 0);
  const cut = clip(line, width);
  return cut + " ".repeat(Math.max(0, width - columnsOf(cut)));
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
  // COLUMNS, not code units (issue #401), the same repair as `frame`'s top rule and for the same reason: a
  // CJK title made this rule over-fill by the title's own width, so the pane's FIRST line was wider than
  // every line under it. `clipData` has already substituted, so `titleText` is plain and `columnsOf` is the
  // whole measurement.
  const topFill = Math.max(0, w - 2 - 1 - columnsOf(titleText)); // corners + one leading `h`
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
 *
 * ITS LABEL IS MEASURED BY `.length` AND THAT IS CORRECT HERE, which is worth saying in a file whose whole
 * subject is that `.length` is not a column count (issue #401). Every character of the label comes from two
 * integers and a word out of a closed set, so it is digits and ASCII by construction and no caller can put
 * anything else in it. `styler.meter`'s label is built the same way and is exempt for the same reason.
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

/** Code units in the character ending at `at`, so a cursor move never lands between the halves of a pair. */
function charBefore(s, at) {
  const lo = s.charCodeAt(at - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && at >= 2) {
    const hi = s.charCodeAt(at - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return 2;
  }
  return 1;
}

/** Code units in the character starting at `at`, the forward twin of `charBefore`. */
function charAfter(s, at) {
  const hi = s.charCodeAt(at);
  if (hi >= 0xd800 && hi <= 0xdbff && at + 1 < s.length) {
    const lo = s.charCodeAt(at + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return 2;
  }
  return 1;
}

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
  // THE SAME RULE AT THE VALUE'S OWN DOORS. `backspace` and `del` were fixed to step by character, and a
  // review pass pointed out that the constructor, `insert` (which takes a whole PASTE) and `setValue` were
  // left open: `stripControls` removes C0 and C1, not half a character. The argument that made the edit-side
  // fix necessary applies unchanged here, because `value()` is what gets SAVED, and it also keeps `render`
  // honest -- `cursor` is an index into this string, so a value with no orphans in it means the window's
  // offsets and the cursor cannot disagree about what they are counting.
  const enter = (text) => dropOrphans([...stripControls(text)]).join("");
  let value = enter(initial);
  let cursor = value.length;
  return {
    value: () => value,
    cursor: () => cursor,
    /** Insert a printable char -- or a whole pasted string -- at the cursor; control chars are stripped first. */
    insert(ch) {
      const clean = enter(ch);
      if (clean.length === 0) return;
      value = value.slice(0, cursor) + clean + value.slice(cursor);
      cursor += clean.length;
    },
    // ONE CHARACTER, NOT ONE CODE UNIT, in all four (issue #401). These moved and deleted by code unit, so
    // two `left`s put the cursor between the halves of an astral pair and the next `backspace` deleted ONE
    // HALF: the surviving half stayed in `value`, which is what `value()` hands to whatever saves it, so
    // the broken character outlived the session. Rendering cannot repair that -- the damage is in the
    // stored string, not in the view -- which is why the fix is here rather than in `render`.
    backspace() {
      if (cursor === 0) return;
      const step = charBefore(value, cursor);
      value = value.slice(0, cursor - step) + value.slice(cursor);
      cursor -= step;
    },
    del() {
      if (cursor < value.length) value = value.slice(0, cursor) + value.slice(cursor + charAfter(value, cursor));
    },
    left() {
      if (cursor > 0) cursor -= charBefore(value, cursor);
    },
    right() {
      if (cursor < value.length) cursor += charAfter(value, cursor);
    },
    home() {
      cursor = 0;
    },
    end() {
      cursor = value.length;
    },
    setValue(s) {
      value = enter(s);
      cursor = value.length;
    },
    render(width, { focused = true } = {}) {
      const w = Math.max(1, Math.trunc(width) || 1);
      // THE WINDOW IS CHOSEN IN COLUMNS AND ITS EDGES ARE WHOLE STEPS (issue #401). This was
      // `value.slice(start, start + w).padEnd(w)` on UTF-16 indices, so it measured a CJK value at half
      // what the terminal draws, and a window edge landing between the halves of an astral pair emitted a
      // BARE LOW SURROGATE into the live trigger editor. It walks `widthSteps` rather than characters for
      // the reason that function exists: a per-character measure is one column short on an emoji-form
      // sequence, so a window built from one overflowed its own pane.
      const steps = [...widthSteps(value)];
      const offs = [];
      let at = 0;
      for (const step of steps) {
        offs.push(at);
        at += step.text.length;
      }
      offs.push(at);
      // `cursor` is a code-unit index and the edit methods keep it on a character boundary, but a step can
      // span three of them, so it is resolved to a step rather than trusted to name one. It rounds FORWARD:
      // a cursor inside a keycap names the step after it, never a position inside a glyph.
      let ci = offs.findIndex((o) => o >= cursor);
      if (ci < 0) ci = steps.length;
      // THE RESERVED CELL MOVES THE WINDOW'S START, not its length: the window is `w` columns wide, and
      // the cursor is kept at most `w - 1` columns past the start so its own cell is always inside it.
      let start = ci;
      let back = 0;
      while (start > 0 && back + steps[start - 1].cols <= w - 1) {
        start -= 1;
        back += steps[start].cols;
      }
      let end = start;
      let used = 0;
      while (end < steps.length && used + steps[end].cols <= w) {
        used += steps[end].cols;
        end += 1;
      }
      const textOf = (a, b) => steps.slice(a, b).map((step) => step.text).join("");
      const head = textOf(start, Math.min(ci, end));
      if (!focused) return pad(textOf(start, end), w);
      // The cursor wraps a WHOLE step, never one half of a pair and never half a keycap, and sits on a
      // space once it is past the last step the window shows.
      const onStep = ci < end;
      const under = onStep ? steps[ci].text : " ";
      const tail = onStep ? textOf(ci + 1, end) : "";
      const fill = Math.max(0, w - columnsOf(head + (onStep ? under : "") + tail) - (onStep ? 0 : 1));
      return head + LINE_INPUT_CURSOR[0] + under + LINE_INPUT_CURSOR[1] + tail + " ".repeat(fill);
    },
  };
}
