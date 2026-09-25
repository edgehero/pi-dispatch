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
 *   - a bidi override or isolate REORDERS the text after it, so `repo/safe` plus U+202E plus `gnp.txt` is
 *     drawn as a name ending in `.png`. The job id, the target and the branch are all attacker- or
 *     model-writable, and a run record is what an operator reads before deciding what to do about it.
 *   - a character that draws as NOTHING, or as a blank that is not a space, makes two DIFFERENT strings
 *     draw identically: `deploy-prod` against `deploy` plus U+200B plus `-prod`, and equally against a
 *     Hangul filler or a no-break space. Eleven columns each, and not the same trigger. The pickers select
 *     by the string, so the operator can edit or delete the row they did not mean.
 *
 * ASKED OF THE RENDERER, NOT LISTED AND NOT CATEGORISED, and it took two review rounds to get there. A
 * hand-written list of the shapes someone thought of covered 98 code points; this covers 4,024, and the
 * old list is a strict SUBSET of it -- nothing it held has been let go. Missing were
 * the fillers (one of which this project's own `env-file.mjs` already calls a deception character), the
 * tag block, the Arabic and Egyptian format controls, the musical controls, the reserved code points and every
 * blank a reader cannot tell from a space.
 *
 * A SECOND VERSION derived it from `\p{Cf}|\p{Zl}|\p{Zp}|\p{Zs}`, which is a different rule wearing this
 * one's clothes: it still left U+FFF0-U+FFF8, which THIS FILE's width table already treats as characters
 * the renderer draws as nothing, and U+2800, which draws a blank cell. A list is what the carve-out in
 * issue #382 was and it was wrong twice; four categories standing in for "what does this draw" is the same
 * shape a third time. So membership asks what a code point DRAWS, through `columnsOf` and through the one
 * place that table deliberately guesses, which the clause below the predicate explains.
 *
 * WHAT IS DELIBERATELY NOT IN IT: U+0020, which is the space this substitutes TO; and a code point that
 * COMPOSES the character beside it. U+200D joins an emoji sequence into one glyph, U+200C is orthography
 * in Persian and the Indic scripts, and a variation selector chooses a character's form (`Mn`, so no
 * property here reaches it anyway). Substituting those changes a CHARACTER where substituting the rest
 * reveals a CONTROL, and a gate that cannot tell them apart corrupts the text it was added to protect.
 *
 * ISSUE #401 ANSWERED THE OTHER HALF of that issue's argument, and saying it precisely took three goes.
 * None of these corrupts the geometry, because every measurement site scrubs BEFORE it measures. "They
 * measure zero columns now" was the claim, and by this module's own table it is false of 3,843 of the
 * 4,024: only 181 measure zero. The renderer reads it the other way round, drawing all but 19 of them as
 * nothing, and the gap between those two readings is the whole subject of the predicate below. What was
 * left was the reading, which is why the class moves and the width table does not.
 *
 * SUBSTITUTION IS THEREFORE NO LONGER COLUMN-PRESERVING, and it used to be free: every member of the old
 * class measured one column, so replacing it with a space changed no geometry. Most members of this one
 * measure zero, so a substituted line is WIDER than the line that arrived. Nothing breaks, because every
 * measurement site scrubs BEFORE it measures -- but that is an ordering those sites keep now, rather than
 * an identity the counts used to give for nothing.
 *
 * THE TAG BLOCK IS BOTH, which is why it is the one thing settled by SEQUENCE. A tag after U+1F3F4 composes a
 * subdivision flag, and a tag anywhere else is invisible text: a whole ASCII message at zero columns. So a
 * tag is kept inside a flag sequence and substituted outside one. Measured both ways.
 *
 * WHAT IT COSTS, measured rather than waved at, because this is a trade and not a free win:
 *
 *   - A CORRECTLY ISOLATED RTL NAME NOW DISPLAYS WORSE. `\u2067` + a Hebrew project name + `\u2069` +
 *     `/main` was isolating that name so it read correctly beside the LTR path, and it comes out as the
 *     name between two spaces with the isolation gone. The panel cannot tell that isolate from the one an
 *     attacker used, because they are the same code point doing the same thing, so this is the price of
 *     closing the deception rather than an oversight.
 *   - A soft-hyphenated word and a BOM-led log line each gain a space.
 *   - The gate closes the EXPLICIT deception only. The bidi algorithm reorders neutrals beside a strong
 *     RTL character with no control present at all, so `acme/repo` + a Hebrew letter + `gnp.txt` still
 *     reads differently from how it is stored. Substituting cannot reach that without refusing Hebrew.
 *   - THE COMPOSING CARVE-OUT IS ALSO A CHANNEL, and it is the one this file argues hardest for keeping:
 *     265 default-ignorable code points stay out because they compose, and the renderer draws every one of
 *     them as nothing. `deploy` plus U+E0100 plus `-prod` is eleven columns either way after the gate,
 *     which is the same collision the tag block gets a sequence matcher for, at about 2.8 times its size.
 *     Closing it would need the same sequence-awareness the flag has, per script rather than per block.
 *   - THE FAST PATH ONLY RESCUES ASCII. A tail of 200 lines of 100 KB costs about 200 ms a render at 0%
 *     non-ASCII and about 4 seconds at 100% CJK. That is not a regression, the branch only ever saves
 *     work, but this panel's own argument is that it renders CJK as a matter of course.
 *
 * THIS PROJECT NOW HAS THREE CLASSES FOR ONE QUESTION, and the differences are deliberate rather than
 * drift. `triggers.mjs`'s VALIDATOR is C0 + DEL and decides whether an operator's file is acceptable.
 * `env-file.mjs`'s `QUOTED_CONTROL` is this rule almost exactly -- its own docblock says "the bidi
 * controls and isolates, the zero-width characters, and the line and paragraph separators" -- and it also
 * holds U+200C, U+200D and the variation selectors, because a `.env` VALUE has no legitimate emoji
 * sequence in it and any invisible byte there is suspect. This panel renders a CJK repository name and a
 * container's log output as a matter of course, so it keeps what composes. `endpointShown` ESCAPES rather
 * than substituting, on an allowlist of printable ASCII, which is right for a DNS name or a socket path
 * and would escape the content issue #401 had just taught this module to measure.
 */
// A SUBDIVISION FLAG, matched as a WHOLE VALID SEQUENCE rather than guessed at from one end: the base,
// one to six tag letters, and the cancel tag that closes it. A first version exempted "a tag preceded by
// the base and any number of tags", which is not the same claim and is not a validity check at all -- it
// exempted every tag FOREVER AFTER a flag, cancel tag included, so one legitimate flag emoji anywhere in
// a model-writable field restored the entire hidden-message hazard this class exists to close. It was
// also a variable-length lookbehind, which rescans backwards at every position: 200 KB of tags in one
// `.log` line took 2.3 seconds, and `readLogTail` bounds the number of lines but not their length.
const FLAG_SEQUENCE = /\u{1f3f4}[\u{e0020}-\u{e007e}]{1,6}\u{e007f}/u;

// Composing, so never substituted: EVERY mark, spacing marks included. `\p{Mn}|\p{Me}` was the first
// spelling and it was wrong in a way only this class could expose: issue #401 made a spacing mark measure
// ZERO columns, agreeing with the renderer, so once membership started asking "does it draw nothing" the
// Mc vowel signs of the Indic scripts fell straight into it. `\u0915\u093f` would have been substituted
// to `\u0915 `, which is not revealing a control, it is deleting a vowel.
const COMPOSES = /\p{M}/u;
// A blank that is not U+0020 and draws in ONE column, so a reader cannot tell it from a space.
const BLANK_LIKE = /\p{Zs}|\u2800/u;
// A line or paragraph separator: it is read as a BREAK, whatever width it happens to draw.
const BREAKS = /\p{Zl}|\p{Zp}/u;
// The two places the pinned renderer draws an UNASSIGNED code point as nothing, where the width table
// guesses one column. Measured against the pin rather than reasoned from the standard.
const INVISIBLE_UNASSIGNED = /[\u2065]|[\u{e0000}-\u{e0fff}]/u;

/**
 * IS THIS CODE POINT ONE THE PANEL SUBSTITUTES? The rule, as a predicate, rather than a category list.
 *
 * A first version derived it from `\p{Cf}|\p{Zl}|\p{Zp}|\p{Zs}` and a review pass showed that is a
 * different rule wearing this one's clothes: it left U+FFF0-U+FFF8, which THIS FILE's own width table
 * already treats as code points the renderer draws as nothing, and U+2800, which draws a blank
 * cell. A test that restates the implementation's own expression cannot catch a wrong rule, which is what
 * the round before that got wrong. So membership is asked of the renderer's own answer -- what does this
 * DRAW -- and the categories are gone.
 */
function interpreted(ch) {
  const cp = ch.codePointAt(0);
  // What a terminal EXECUTES. U+009B is a CSI introducer needing no ESC, which is why C1 is here.
  if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return true;
  // PRINTABLE ASCII IS THE ANSWER FOR ALMOST EVERY CHARACTER A PANE EVER HOLDS, and saying so here rather
  // than reaching `columnsOf` below is what keeps this affordable: every caller runs it per character over
  // whole `.log` lines, and a review pass measured a search over a 200-line tail of 100 KB lines at 2.1
  // SECONDS per render without it. None of U+0021-U+007E is a mark, a blank or a separator.
  if (cp < 0x80) return false;
  // The space this substitutes TO, and the two joiners, which compose rather than hide.
  //
  // THE SPACE IS ALREADY COVERED by the ASCII line above, and both are kept on purpose: each makes the
  // other's mutation equivalent, which is worth saying so the next reader does not chase either as a gap.
  // The fast path exists for cost and the named check for legibility, and deleting the fast path alone
  // would silently put U+0020 into the class if this line ever went with it.
  if (ch === " " || ch === "\u200c" || ch === "\u200d") return false;
  if (COMPOSES.test(ch)) return false;
  // BREAKS A LINE, which is an interpretation rather than a drawing, and the one arm that is not about
  // what a code point looks like: U+2028 and U+2029 draw ONE column, so neither test below reaches them.
  if (BREAKS.test(ch)) return true;
  // Draws as NOTHING: the format characters, the bidi controls, the fillers, and the unassigned code
  // points the renderer blanks (U+FFF0-U+FFF8 among them, which are RESERVED rather than noncharacters --
  // the real noncharacters, U+FDD0-U+FDEF and the plane-enders, are not in this class and draw a glyph).
  //
  // THE SECOND TEST IS NOT REDUNDANT, and leaving it out is the defect a third review round found. Asking
  // `columnsOf` alone looked like "ask the renderer", and it is not: issue #401's sweep pins that table as
  // never NARROWER than the renderer, and its docblock says it deliberately answers ONE for an unassigned
  // code point, because guessing wider is the safe direction for a WIDTH. For MEMBERSHIP the safe
  // direction is the other one, so that guess is a MISS -- 3,760 of them, measured against the pin: U+2065
  // and the special-purpose plane, which is a hidden-ASCII channel 39 times the size of the tag block this
  // file builds a whole sequence matcher for. The variation selectors inside that plane are marks and have
  // already been kept above; the tags are settled by sequence.
  if (columnsOf(ch) === 0 || INVISIBLE_UNASSIGNED.test(ch)) return true;
  // Or draws as a blank a reader cannot tell from a space. U+3000 is deliberately excluded: it draws TWO
  // columns, it is an ordinary full-width space in Japanese text, and substituting it would narrow the
  // line as well as rewrite the content. The collision it can still make is a stated residual.
  return BLANK_LIKE.test(ch) && columnsOf(ch) === 1;
}

/**
 * Walk `s`, hand every substituted code point to `replace`, and keep everything else.
 *
 * A whole valid flag sequence is taken in one step, which is how a tag can be kept inside one and
 * substituted outside one without a lookbehind and without rescanning.
 */
function mapInterpreted(s, replace) {
  const text = String(s ?? "");
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.codePointAt(i) === 0x1f3f4) {
      const m = FLAG_SEQUENCE.exec(text.slice(i, i + 32));
      if (m && m.index === 0) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(text.codePointAt(i));
    out += interpreted(ch) ? replace : ch;
    i += ch.length;
  }
  return out;
}

/** Does `s` hold anything this panel would substitute? */
function anyInterpreted(s) {
  return mapInterpreted(s, "\u0000").indexOf("\u0000") !== -1;
}

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

/**
 * DELETE the class, where `scrubControls` substitutes (shared by `clip` and `makeLineInput`).
 *
 * Exported for the tail search, which has to compare against BOTH readings: the pane substitutes, the
 * search box deletes, and a query that finds nothing either way is the regression issue #402 introduced
 * and a review pass measured.
 */
export function stripControls(s) {
  return mapInterpreted(s, "");
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
  return mapInterpreted(s, " ");
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
  return anyInterpreted(s);
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
 *     reserved code points the renderer also draws as nothing;
 *   - two for every code point in `WIDE`, which is that renderer's own double-width set;
 *   - two for a narrow character followed by U+FE0F, which asks for its emoji form, and two for a keycap,
 *     which is one of twelve bases plus U+FE0F plus U+20E3 drawn as a single key;
 *   - one for everything else, including an unassigned code point, because guessing wider on an unknown is
 *     how a rule starts breaking the panes it was added to fix.
 *
 * WHAT IT IS HELD TO, in `width.test.mjs`: sweeps of every code point there is, of every character
 * followed by U+FE0F and by a keycap, and (issue #417) of every zero-width character followed by every code
 * point the renderer counts twice, asserting that this never measures NARROWER than the renderer and that
 * every place it measures wider is a declared departure. The pair sweep is there because
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
 * Every remaining case over-counts, so every one draws SHORT inside its border rather than through it, with
 * one exception stated at `leaderStep`: a prepended letter followed by U+FFA0, which no drawn path keeps.
 *
 * A COUNT IS A COUNT OF A LINE. Whether a cluster starts depends on what stands in front of it (issue #417),
 * so a string is measured as though it began a line, and a caller that draws it after something measures
 * it there: the frames pad from their own space, the line editor from its prompt's.
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
  // TRUE ONLY WHILE INSIDE A RUN OF PLAIN ZERO-WIDTH STEPS, so a leader run is judged once, at its first
  // member. It is a flag and not a look at `chars[i - 1]`, and a review pass measured why: an emoji-form
  // step and a keycap END in a zero-width code point (U+FE0F, U+20E3), so asking the previous character
  // skipped every leader run that followed one, and `("\u00a9\ufe0f\u102c\uff9e").repeat(10)` drew 30
  // columns in a 24-column box.
  let inRun = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ZERO_WIDTH.test(ch)) {
      const lead = inRun ? null : leaderStep(chars, i);
      if (lead) {
        // The part of the run that joins the character in front stays with it, as zero-width steps.
        for (const c of lead.before) yield { text: c, cols: 0 };
        yield lead.step;
        i = lead.next - 1;
        inRun = false;
        continue;
      }
      inRun = true;
      yield { text: ch, cols: 0 };
      continue;
    }
    inRun = false;
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

/**
 * A CLUSTER THAT BEGINS WITH SOMETHING THAT DRAWS NOTHING, which the pinned renderer counts WIDER than its
 * parts (issue #417). The renderer finds a cluster's base AFTER stripping its leading non-printing code
 * points, and then walks the cluster again from its second code unit adding a column for every code point
 * in U+FF00-U+FFEF and for U+0E33 / U+0EB3. When the cluster began with a mark or a format character, the
 * base is one of the code points that second walk visits, so it is counted twice: `\u0301\uff9e` draws 2,
 * and summing the steps said 1. An under-count is the direction that runs a line past its pane.
 *
 * MATCHED, NOT BOUNDED. The other answer was to substitute a leading mark with nothing to attach to, and it
 * needs a notion of POSITION the substitution class does not have: every cell and every piece between two
 * colour codes is scrubbed on its own, so "leading" there is not "leading" on the drawn line, and `clip`
 * deletes the class rather than substituting it. Matching changes no content. The cost is that a future
 * renderer which stops double counting makes this an OVER-count, the safe direction, and the literal counts
 * pinned in `width.test.mjs` go red at that upgrade rather than drifting.
 *
 * NOT ONLY AT THE START OF A STRING, which is what the issue first said. Thirty-one spacing marks (the
 * Myanmar vowel signs among them) are `\p{M}` but neither grapheme Extend nor SpacingMark, so each one
 * STARTS a cluster wherever it stands, and thirteen prepended format characters (U+0600 among them) take any
 * following character into their cluster, which can double a TWO-column base. So whether the run starts a
 * cluster is asked of `Intl.Segmenter`, with the renderer's own arguments, rather than of a list: the same
 * runtime segments both, so the two cannot disagree about where a cluster starts.
 *
 * Returns the part of the run inside the base's cluster and the base as ONE step, so no cut can separate
 * them, with the rest of the run (which joins the character in front) as `before`; or null when nothing is
 * doubled and the run steps as zero-width code points as before.
 */
function leaderStep(chars, i) {
  let k = i;
  while (k < chars.length && ZERO_WIDTH.test(chars[k])) k += 1;
  const base = chars[k];
  if (base === undefined || !DOUBLED.test(base)) return null;
  const run = chars.slice(i, k).join("");
  const prev = i > 0 ? chars[i - 1] : "";
  // THE ORDINARY CASE NEVER REACHES THE SEGMENTER: a nonspacing or enclosing mark, or a joiner, after a
  // character that is not a break always extends that character's cluster. `interpreted(prev)` is there
  // for U+2028 and U+2029, which ARE breaks and draw a column, so nothing else here would catch them.
  // Removing this check changes no answer, only the cost: it is a performance path, and a mutant that
  // deletes it is equivalent.
  //
  // ONE DOCUMENTED UNDER-COUNT SURVIVES THIS STEP, because no step can see it: one of the fifteen
  // prepended letters followed by U+FFA0 is a cluster the renderer counts one wider, with no leader in it.
  // No drawn path keeps U+FFA0 (the substitution class takes it), so it lives in raw text only.
  if (prev !== "" && JOINS.test(run) && !interpreted(prev)) return null;
  // ONE CODE POINT OF CONTEXT IS ENOUGH, and only its CLASS. Whether a break falls before the run depends on
  // the code point in front of it (no base here is a pictographic, a regional indicator or a conjunct
  // consonant, the rules that look further back). Controls keep their own class, and among printing
  // characters only a prepended letter, a Hangul leading or vowel jamo or LV syllable, and the Kirat Rai
  // vowel signs change the answer (see `contextOf`). Every other one is segmented as
  // `a`, which is what makes the memo below a memo: keyed on the character itself, a line that varied the
  // character in front of each run defeated it, 94 ms to count 100 KB against 6.5 ms before this step.
  const ctx = contextOf(prev);
  // THE START OF A STRING IS ITS OWN KEY. A review pass poisoned the first version, which keyed on
  // `prev + run + base`: after an emoji form `prev` is U+FE0F, so "U+FE0F in front of a run" and "a run
  // that begins with U+FE0F at the start of a string" were one key with opposite answers, and whichever
  // was measured first answered for both, an under-count by one after the other order.
  const key = (ctx === "" ? "^" : "~" + ctx) + run + base;
  let doubled = key.length <= LEADER_MEMO_KEY ? leaderMemo.get(key) : undefined;
  // `null` is a remembered "not doubled"; `undefined` is "not asked yet".
  if (doubled === undefined) {
    const probe = ctx + run + base;
    let last = "";
    for (const { segment } of GRAPHEMES.segment(probe)) last = segment;
    // Doubled when the base's cluster holds something IN FRONT of the base and does not reach back to
    // the context: the last segment is always a suffix of the probe, so both are length comparisons. The
    // memo holds the extra columns and HOW MUCH OF THE RUN is in the base's cluster, because only that part
    // is bundled with the base: a mark earlier in the run can still join the character in front (U+0301
    // before a Myanmar vowel sign does), and bundling it let a cut take it away from its own letter.
    doubled = last.length > base.length && last.length <= probe.length - ctx.length ? [countLater(last), last.length - base.length] : null;
    if (key.length <= LEADER_MEMO_KEY) {
      // A BOUNDED MEMO, because an adversarial line defeats the fast path above with a run per character:
      // `"\u102c\uff9e".repeat(50000)` took 101 ms to count without it and 16 ms with it (7 ms before this
      // step existed). Cleared rather than evicted: the keys are short and repeat within one line.
      if (leaderMemo.size >= LEADER_MEMO_SIZE) leaderMemo.clear();
      leaderMemo.set(key, doubled);
    }
  }
  if (doubled === null) return null;
  const [extra, inCluster] = doubled;
  const joined = run.slice(0, run.length - inCluster);
  return { before: [...joined], step: { text: run.slice(run.length - inCluster) + base, cols: 2 * (WIDE.test(base) ? 2 : 1) + extra }, next: k + 1 };
}

/**
 * The code point that stands in for `prev` when asking where a cluster starts: itself where its class
 * changes the answer, `a` for every other printing character.
 *
 * THE DIRECTION OF A WRONG ANSWER HERE IS SAFE, which is why a short list is acceptable: `a` breaks before
 * a run at least as often as any printing character does, so a character wrongly segmented as `a` can only
 * make a cluster START here that did not, and a start is what doubles a base. That is an over-count. The
 * characters that break MORE often than `a` (the controls and the line and paragraph separators) are kept
 * as themselves, and so are the ones that JOIN more often: the fifteen prepended letters, which take the
 * next character into their cluster whatever it is, the Hangul leading and vowel jamo and LV syllables,
 * which take the zero-width jamo fillers, and the five
 * Kirat Rai vowel signs Unicode 16 made vowel jamo for the same rule (the sweep found those). The
 * predecessor sweep in `width.test.mjs` runs every character there is through four leader shapes, so a
 * missing entry fails there as an over-count with a name.
 */
function contextOf(prev) {
  if (prev === "" || KEEPS_CONTEXT.test(prev) || isLvSyllable(prev) || !PRINTS.test(prev)) return prev;
  return "a";
}

// A Hangul LV syllable (every 28th from U+AC00) takes a vowel filler into its cluster; an LVT one does
// not, so the 10,773 of those are stood in for like any other letter. Keeping the whole syllable block
// kept the memo from working on a line of varied LVT syllables, measured at eleven times a plain line.
function isLvSyllable(ch) {
  const cp = ch.codePointAt(0);
  return cp >= 0xac00 && cp <= 0xd7a3 && (cp - 0xac00) % 28 === 0;
}
// What `a` may stand in for: every printing class, and the private-use and unassigned code points that are
// not default-ignorable (the segmenter treats those as plain characters too; the default-ignorable ones it
// treats as controls, which break more often than `a`, so they keep their own class).
const PRINTS = /^(?:[\p{L}\p{N}\p{P}\p{S}\p{Zs}\p{Co}]|(?!\p{Default_Ignorable_Code_Point})\p{Cn})$/u;
const KEEPS_CONTEXT = new RegExp(
  "^[\\u1100-\\u11a7\\ua960-\\ua97c\\ud7b0-\\ud7c6\\u0d4e\\u{111c2}\\u{111c3}\\u{113d1}" +
    "\\u{1193f}\\u{11941}\\u{11a3a}\\u{11a84}-\\u{11a89}\\u{11d46}\\u{11f02}\\u{16d63}\\u{16d67}-\\u{16d6a}]$",
  "u",
);

// The renderer's own add-set: the code points its second walk over a cluster counts again.
const DOUBLED = /[\uff00-\uffef\u0e33\u0eb3]/u;
// A run made ONLY of these always extends the cluster before it (every Mn and Me is grapheme Extend).
const JOINS = /^[\p{Mn}\p{Me}\u200c\u200d]+$/u;
// The renderer's segmenter, with the renderer's arguments. A global, not a dependency.
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const leaderMemo = new Map();
const LEADER_MEMO_SIZE = 4096;
const LEADER_MEMO_KEY = 16;

/**
 * U+FFA0 inside a doubled cluster, after its first code point, is one more column to the renderer's second
 * walk and nothing to this table's (it is a filler that draws alone as nothing).
 */
function countLater(segment) {
  let n = 0;
  let first = true;
  for (const c of segment) {
    if (!first && c === "\uffa0") n += 1;
    first = false;
  }
  return n;
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
// zero-width and bidi format characters, and the bracketed tail is the Hangul fillers and the reserved code points
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

/**
 * The longest start of `s` of at most `n` CODE UNITS that ends between grapheme clusters (issue #418).
 *
 * For a cap that is a character count rather than a width, the frontmatter's and a flow name's in
 * `graph-model.mjs`: `dropLoneSurrogate` after a code-unit slice repaired half a surrogate pair and still
 * left half a flag, a keycap without its key, or a family ending in a joiner.
 */
export function cutUnits(s, n) {
  let out = "";
  for (const { segment } of GRAPHEMES.segment(String(s))) {
    if (out.length + segment.length > n) break;
    out += segment;
  }
  return out;
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

  // MEASURED FROM THE FRAME'S OWN SPACE, because that is where it is drawn (issue #417). A body line that
  // begins with a cluster the renderer counts wider on its own -- `\u0301\uff9e` is 2 at the start of a
  // string and 1 after a space -- was padded as though it stood at column 0 and drew one column short.
  // Padding `" " + text` to one more column is byte-identical for every other line.
  const framed = (text) => `${active.v}${pad(" " + (text ?? ""), inner + 1)} ${active.v}`;
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
 * cursor needs one cell past the last character) and always returns exactly `width` visible columns when
 * drawn after a printing column, which is where the prompt puts it (issue #417);
 * when focused, the cursor cell is wrapped in `LINE_INPUT_CURSOR` (see above).
 */
export function makeLineInput(initial = "") {
  // THE SAME RULE AT THE VALUE'S OWN DOORS. `backspace` and `del` were fixed to step by character, and a
  // review pass pointed out that the constructor, `insert` (which takes a whole PASTE) and `setValue` were
  // left open: `stripControls` removes the whole class, and it removes half a character too. The argument that made the edit-side
  // fix necessary applies unchanged here, because `value()` is what gets SAVED, and it also keeps `render`
  // honest -- `cursor` is an index into this string, so a value with no orphans in it means the window's
  // offsets and the cursor cannot disagree about what they are counting.
  // SUBSTITUTE, NOT DELETE, so this value reads like the pane (issue #402). This box is the LIVE_TAIL
  // search, and the pane substitutes the class: deleting here meant an operator who pasted a log line's
  // own bytes produced a query matching NEITHER what is drawn nor what is stored. It is safe to substitute
  // because the cursor sentinels are added at RENDER, not held in the value, so nothing here depends on
  // them vanishing.
  //
  // `dropOrphans` is belt rather than braces on this path: `scrubControls` does not remove half a pair, it
  // substitutes the class, and a lone surrogate is not in the class -- it is removed by `widthSteps` when
  // anything measures or cuts this value. Keeping it here means the VALUE never holds one either, which is
  // what issue #401 needed of the string that gets saved.
  const enter = (text) => dropOrphans([...scrubControls(text)]).join("");
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
      // span many of them, so it is resolved to a step rather than trusted to name one. A cursor INSIDE a
      // step names that step, never a position inside a glyph. It used to round forward, which was harmless
      // while a step was at most a keycap; a leader run and its base are one step of any length since
      // issue #417, and rounding forward drew the cursor in one place for every position inside the run.
      let ci = offs.findIndex((o) => o > cursor) - 1;
      if (ci < 0) ci = steps.length;
      // THE RESERVED CELL MOVES THE WINDOW'S START, not its length: the window is `w` columns wide, and
      // the cursor is kept far enough from its start that its own cell is always inside it. The cell is as
      // wide as the step under the cursor, not one column: reserving one let a head of `w - 1` columns
      // push a two-column character under the cursor out of the window, and the cursor was drawn as a
      // blank after it (issue #417's review, which checked the cursor cell for the first time).
      const reserve = ci < steps.length ? Math.max(1, steps[ci].cols) : 1;
      let start = ci;
      let back = 0;
      while (start > 0 && back + steps[start - 1].cols <= w - reserve) {
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
      // THE WINDOW IS MEASURED WHERE IT IS DRAWN, after the prompt's space (issue #417). The steps above
      // were counted inside the WHOLE value, and a window can start where the whole value had no cluster
      // start: after a prepended letter such as U+0D4E, `\u102c\uff9e` is 1 column inside the value and 2
      // once the letter is outside the window. So the shown text is re-measured after a printing column.
      //
      // AND PIECE BY PIECE, because the styler colours the prompt and wraps the cursor cell in inverse
      // video, and the renderer's overlay compositor segments each run between two colour codes on its
      // own: a review pass measured ordinary Thai (`\u0e19\u0e49\u0e33`, the cursor on its first letter)
      // one column wider there, and the frame then stripped the colour to fit, cursor highlight included.
      // The larger of the two readings is the width, which draws short in the other one, never past it.
      const drawn = (a, b) => {
        const text = textOf(a, b);
        const joined = columnsOf(" " + text) - 1;
        if (!focused) return Math.max(joined, columnsOf(text));
        if (ci >= b) return Math.max(joined, columnsOf(text)) + 1;
        return Math.max(joined, columnsOf(textOf(a, ci)) + columnsOf(steps[ci].text) + columnsOf(textOf(ci + 1, b)));
      };
      // Trimmed until it fits: past the cursor first, then from the front, so the cursor's own cell is
      // never the one given up. A step that draws nothing is skipped rather than re-measured -- taking it
      // away cannot narrow anything, and re-measuring after each one made a pasted run of marks behind the
      // cursor QUADRATIC (16,000 of them took ten seconds to render).
      while (start < end && drawn(start, end) > w) {
        // Only while something past the cursor still DRAWS: when all that is left there is the cursor
        // letter's own marks, giving them up narrows nothing and strips the letter, so the front goes.
        let tailDraws = false;
        for (let k = ci + 1; k < end && !tailDraws; k++) tailDraws = steps[k].cols > 0;
        if (end - 1 > ci && tailDraws) {
          // A mark goes WITH the character in front of it: the trailing ones leave first, then their base.
          while (end - 2 > ci && steps[end - 1].cols === 0) end -= 1;
          end -= 1;
        } else {
          start += 1;
          while (start < ci && steps[start].cols === 0) start += 1;
        }
      }
      const head = textOf(start, Math.min(ci, end));
      if (!focused) return textOf(start, end) + " ".repeat(Math.max(0, w - drawn(start, end)));
      // The cursor wraps a WHOLE step, never one half of a pair and never half a keycap, and sits on a
      // space once it is past the last step the window shows.
      const onStep = ci < end;
      const under = onStep ? steps[ci].text : " ";
      const tail = onStep ? textOf(ci + 1, end) : "";
      const fill = Math.max(0, w - drawn(start, end));
      return head + LINE_INPUT_CURSOR[0] + under + LINE_INPUT_CURSOR[1] + tail + " ".repeat(fill);
    },
  };
}
