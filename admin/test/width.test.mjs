import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { LINE_INPUT_CURSOR, box, clip, columnsOf, makeLineInput, pad, sliceColumns } from "../src/panel.mjs";
import { frame, makeStyler, PLAIN_THEME, visibleLen } from "../src/style.mjs";
import { renderRuns } from "../src/render.mjs";

// EVERY WIDTH PROMISE IN THIS PANEL WAS A UTF-16 COUNT (issue #401), and this file is where the repair is
// held against the only authority available: pi's own renderer, which is what actually draws these lines.
//
// `clip`, `pad`, `styler.cell`, `divider` and `frame` all sized themselves with `.length`, so a framed pane
// this module reported as exactly 80 columns came out at 90 in the terminal for a CJK job id, and ragged
// the other way for a combining mark. The table lives in `panel.mjs` rather than in the overlay-only
// `style.mjs`, because the two renderers draw the same geometry and a width rule that holds in one and not
// the other is the "holds on one branch of an if" shape this round kept finding.

/**
 * pi-tui's own `visibleWidth`, the oracle.
 *
 * Resolved from the pinned pi installation rather than declared as a dependency: `admin` does not depend on
 * pi-tui directly, it is nested under `pi-coding-agent`, and `CONST-PI-VERSION-PINNED` says to verify
 * against the pinned artifact rather than a range. A hard-coded nested path would break on a flat install.
 *
 * THE TWO RESOLVERS ARE BOTH NEEDED, and each fails where the other works:
 *   - `import.meta.resolve` finds pi itself. The CJS `require.resolve` does NOT: pi's export map carries no
 *     `require` condition, so it throws ERR_PACKAGE_PATH_NOT_EXPORTED. This is why `dashboard.test.mjs:14`
 *     builds its own `createRequire` from `import.meta.resolve` rather than from a package.json URL.
 *   - `require.resolve` then finds pi-tui NESTED under pi. `import.meta.resolve` with pi's entry as the
 *     parent does not, because the ESM resolver reads pi's own dependency graph rather than walking
 *     `node_modules` upward, and pi-tui is not one of `admin`'s dependencies.
 * It returns the file PATH, and pi-tui is ESM, so the path is imported rather than required.
 */
async function loadVisibleWidth() {
  return (await loadRenderer())?.visibleWidth ?? null;
}

/** The pinned renderer's module, or null: `visibleWidth` above, and `sliceByColumn` for the compositor's cut. */
async function loadRenderer() {
  try {
    const pi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const entry = pi.resolve("@earendil-works/pi-tui");
    // WHICH COPY, asserted rather than assumed. pi depends on pi-tui by a RANGE, so a resolve that is not
    // the lockfile's would answer any 0.80.x, and a hoisted layout could put a different copy above this
    // one. `CONST-PI-VERSION-PINNED` says to verify against the pinned artifact rather than a range, and
    // an oracle measured against the wrong artifact is a table pinned to the wrong renderer.
    const version = pi("@earendil-works/pi-tui/package.json").version;
    if (version !== PI_TUI_VERSION) return null;
    const tui = await import(pathToFileURL(entry).href);
    return typeof tui.visibleWidth === "function" && typeof tui.sliceByColumn === "function" ? tui : null;
  } catch {
    return null;
  }
}

/** The pin, from `package-lock.json`. A mismatch fails the tests below rather than measuring silently. */
const PI_TUI_VERSION = "0.80.7";

/** `[name, string, what pi and we must agree it is]` -- the cases a review pass measured as broken. */
const AGREE = [
  ["ascii", "hello world", 11],
  ["a CJK job id", "ジョブ番号", 10],
  ["a CJK repo target", "会社/製品#5", 11],
  ["fullwidth latin", "ＪＯＢ", 6],
  ["hangul", "한글테스트", 10],
  ["combining marks", "jo\u0301b\u0301", 3],
  ["a zero-width space", "a\u200bb\u200bc", 3],
  ["a bidi override", "a\u202eb", 2],
  ["box drawing", "┌─┐", 3],
  ["one emoji", "\u{1f600}", 2],
];

test("the measured cases agree with the renderer, and the ZWJ disagreement is pinned as one (#401)", async () => {
  const visibleWidth = await loadVisibleWidth();
  // NOT SKIPPED SILENTLY: an oracle that quietly vanishes is an oracle that stops being one, and this
  // module's sibling pin (`keys.mjs`) made exactly that mistake once.
  assert.equal(typeof visibleWidth, "function", "pi-tui's visibleWidth must load, or this test is checking nothing");

  for (const [name, s, expected] of AGREE) {
    assert.equal(columnsOf(s), expected, `${name}: our count`);
    assert.equal(visibleWidth(s), expected, `${name}: pi's count`);
  }

  // THE ONE DISAGREEMENT, asserted so it cannot drift into a surprise. We sum CODE POINTS, so an emoji ZWJ
  // sequence counts every member; pi collapses it to one glyph. Terminals disagree with each other here
  // too, which is why no table in this project settles it. Over-counting cuts EARLY, so the cost is a short
  // line rather than a broken border -- which is the direction to be wrong in.
  const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f466}";
  assert.equal(columnsOf(family), 6, "we count each member of the family");
  assert.equal(visibleWidth(family), 2, "pi counts the glyph -- recorded, not fixed");
});

test("a cut never lands inside a wide character, and never leaves half a pair (#401)", () => {
  // Cutting by code units splits an astral pair; cutting by columns without walking characters splits a
  // TWO-COLUMN one, which a terminal draws as one blank column plus one of overflow -- wrong and ragged.
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  for (const s of ["ジョブ番号", "aジbョc", "\u{1f600}\u{1f600}\u{1f600}", "ＪＯＢ"]) {
    for (let w = 0; w <= 12; w++) {
      const cut = sliceColumns(s, w);
      assert.ok(columnsOf(cut) <= w, `sliceColumns(${JSON.stringify(s)}, ${w}) came to ${columnsOf(cut)} columns`);
      assert.doesNotMatch(cut, lone, `width ${w}: half a surrogate pair survived`);
      // Only where the string HAS that many columns to give: past its end there is nothing to lose.
      if (columnsOf(s) >= w) assert.ok(columnsOf(cut) >= w - 1, `width ${w}: a two-column character may cost one column, never more`);
    }
  }
});

test("clip and pad measure and fill in columns, not code units (#401)", () => {
  const cjk = "ジョブ番号"; // 5 characters, 10 columns
  assert.equal(columnsOf(clip(cjk, 10)), 10, "a string that fits is untouched");
  assert.ok(columnsOf(clip(cjk, 6)) <= 6, "and one that does not is cut to the budget");
  for (const w of [1, 2, 3, 7, 11, 20]) {
    assert.equal(columnsOf(pad(cjk, w)), w, `pad to exactly ${w} columns`);
  }
  // The old bug, as an assertion: by `.length` this string is 5, so a 10-column pad added five spaces and
  // the line came out 15 columns wide.
  assert.notEqual(pad(cjk, 10).length, 10, "the code-unit length is NOT the column count, which is the point");
});

test("the monochrome pane measures exactly its width too, title row included (#401)", () => {
  // BOTH RENDERERS, because the mutation that survived while only `frame` was pinned was `box`'s own top
  // rule reverted to `.length`. `box` and `frame` draw the same geometry from two different files, and this
  // round keeps finding the shape where a rule holds on one branch and not the other. The overshoot lands on
  // the FIRST line only, with every body row correct, which is what made it easy to miss by eye.
  const sections = [{ title: "ジョブ", lines: ["会社/製品#5 のジョブ", "plain ascii row", "jób\u0301 marks"] }];
  for (const w of [24, 40, 80]) {
    for (const line of box({ title: "ジョブ番号", sections, footer: "Ｆ", width: w })) {
      assert.equal(columnsOf(line), w, `width ${w}: ${JSON.stringify(line)}`);
    }
  }
});

test("a frame holding CJK still measures exactly its width, in our terms and pi's (#401)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");
  const styler = makeStyler(PLAIN_THEME);
  const lines = ["会社/製品#5 のジョブ", "plain ascii row", "jo\u0301b\u0301 with combining marks"];
  for (const w of [20, 40, 80]) {
    for (const line of frame(styler, { title: "ジョブ", width: w, lines: lines.map((l) => styler.cell(l, w - 4)), footer: "Ｆ" })) {
      assert.equal(visibleLen(line), w, `width ${w}: our own measure`);
      assert.equal(visibleWidth(line), w, `width ${w}: and pi's, which is the one the terminal uses`);
    }
  }
});

test("the table is held to the renderer on every code point there is (#401)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function", "pi-tui's visibleWidth must load, or this test is checking nothing");

  // THE BOLT A HAND-WRITTEN TABLE NEEDS, and the reason it sweeps rather than lists examples. The first
  // version of this table was written out of UAX #11 by hand and checked against ten strings. It passed,
  // and it UNDER-counted 139,820 code points: CJK Extension B through H, Tangut, the Kana supplement, the
  // Hangul Jamo extensions and every emoji block added since Unicode 13. Ten examples cannot see that.
  // CLAUDE.md already says a hand-written table restating a derivable source is either derived or pinned.
  //
  // THE DIRECTION IS THE WHOLE POINT, so the hard assertion is one-sided. Over-counting cuts EARLY: the
  // line comes out short and the border holds. Under-counting cuts LATE: the line runs past the border,
  // which is the defect this issue names.
  const OVER = [];
  let swept = 0;
  let wide = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    // A surrogate on its own is not a character and neither side promises anything about it.
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    // THE CONTROL CLASS IS OUTSIDE THE TABLE'S PROMISE, for a reason no per-character table can fix: a
    // TAB's width depends on the cursor's column, not on the character (the renderer answers 3 for one at
    // column 0). Every renderer here substitutes the whole class before measuring, which is what issue
    // #382 put in front of every path, so the table is never asked.
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) continue;
    const ch = String.fromCodePoint(cp);
    const ours = columnsOf(ch);
    const theirs = visibleWidth(ch);
    swept += 1;
    if (theirs === 2) wide += 1;
    assert.ok(ours >= theirs, `U+${cp.toString(16).toUpperCase().padStart(4, "0")}: we say ${ours}, the renderer draws ${theirs}`);
    if (ours !== theirs) OVER.push(cp);
  }

  // Every over-count is the one departure the table declares, and nothing else. Without this half the
  // assertion above is satisfied by a table that answers 2 for everything.
  for (const cp of OVER) {
    assert.ok(
      !/\p{Assigned}/u.test(String.fromCodePoint(cp)),
      `U+${cp.toString(16).toUpperCase().padStart(4, "0")} is assigned, so the table over-counts a real character for no stated reason`,
    );
  }
  assert.ok(OVER.length > 0, "the unassigned departure is real, not a dead clause");

  // THE SWEEP'S OWN SCOPE IS PINNED, because a sweep is only a bolt while it actually sweeps. A review pass
  // showed that narrowing the loop bound to `0xffff` -- dropping the whole astral plane, which is exactly
  // where the 139,820-code-point hole was -- left the suite green, as did widening the control skip and
  // weakening the assertion above. These two counts fail on any of those.
  assert.equal(swept, 1111999, "the sweep covers every code point outside the surrogates and the control class");
  assert.equal(wide, 182889, "and the renderer's double-width set is transcribed whole");

  // WHAT THESE TWO COUNTS ARE FOR, and what they cannot do. They pin the sweep's SCOPE: narrowing the loop
  // bound to the BMP -- which is exactly where the 139,820-code-point hole was -- or widening the control
  // skip now fails here, where before it left the suite green. They do NOT make the two assertions above
  // mutation-detectable, and nothing can: weakening a guard is unobservable while the thing it guards
  // against is absent, so on a correct table `ours >= theirs` and `ours >= 0` pass the same inputs. Those
  // assertions are shown to be live the only way a guard can be, by mutating the SOURCE: reverting one
  // range of `WIDE` fails the first, and making the zero rule stop zeroing format characters fails the
  // second.

});

test("every character-with-U+FE0F pair, and every keycap, agrees with the renderer (#401)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");

  // THE SWEEP THE FIRST REPAIR SAID IT DID AND DID NOT. Its commit, its docblock and its spec row all
  // claimed "every code point, plus every character-with-U+FE0F pair"; the pair half was a six-entry list.
  // A review pass found the hole one selector further along: a KEYCAP is a base, U+FE0F and U+20E3 drawn
  // as one two-column glyph, and it measured 1 against the renderer's 2 -- an UNDER-count, the direction
  // that runs a line past its pane. So both sequence shapes are swept, and the keycap one is why.
  let pairs = 0;
  let keycaps = 0;
  for (let cp = 0x20; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) continue;
    const base = String.fromCodePoint(cp);
    for (const seq of [base + "\ufe0f", base + "\ufe0f\u20e3"]) {
      const ours = columnsOf(seq);
      const theirs = visibleWidth(seq);
      assert.ok(ours >= theirs, `${JSON.stringify(seq)}: we say ${ours}, the renderer draws ${theirs}`);
      // THE TWO STATED DEPARTURES, and nothing else. An unassigned base is the table's declared guess of
      // one column. The other is a keycap applied to a base that HAS no keycap form -- a heart in a key --
      // which the renderer collapses to one column and we count as the promoted base plus an enclosing
      // mark. It is an over-count, so it draws short rather than overflowing, and it is a sequence no
      // writer produces: the twelve real keycap bases are asserted exactly, just below.
      const degenerateKeycap = seq.endsWith("\u20e3") && !/[#*0-9]/.test(base);
      if (ours !== theirs) {
        assert.ok(!/\p{Assigned}/u.test(base) || degenerateKeycap, `${JSON.stringify(seq)} over-counts an assigned base for no stated reason`);
      }
    }
    pairs += 1;
    // The keycap RULE, isolated: a base the selector alone leaves narrow and the enclosing key widens. A
    // looser count would also catch the 201 the selector promotes on its own and prove nothing about it.
    if (columnsOf(base) === 1 && columnsOf(base + "\ufe0f") === 1 && columnsOf(base + "\ufe0f\u20e3") === 2) keycaps += 1;
  }
  assert.equal(pairs, 1111999, "the pair sweep covers every base there is");
  assert.equal(keycaps, 12, "and exactly the twelve keycap bases are promoted, which is what the renderer does");
});

test("U+FE0F asks for the emoji form, and the table follows the renderer there too (#401)", () => {
  // A PER-CHARACTER TABLE CANNOT DO THIS, which is why `columnsOf` carries one piece of state. U+FE0F
  // makes the character BEFORE it draw in its emoji form, two columns wide, for the 201 code points that
  // have a text form and an emoji form. Reverting that clause is the mutation that matters: it restores a
  // count the code-unit `.length` had right by accident, since such a sequence is two code units.
  for (const [name, s, expected] of [
    ["a heart", "❤\ufe0f", 2],
    ["a warning sign", "⚠\ufe0f", 2],
    ["a bare heart", "❤", 1],
    ["an already-wide emoji", "\u{1f600}\ufe0f", 2],
    ["a letter, which VS16 does not promote", "A\ufe0f", 1],
    ["a digit, whose emoji form is a keycap", "1\ufe0f", 1],
  ]) {
    assert.equal(columnsOf(s), expected, name);
  }
});

test("a cut leaves no dangling joiner and no content at all at zero (#401)", () => {
  const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f466}";
  for (let w = 0; w <= 8; w++) {
    assert.doesNotMatch(sliceColumns(family, w), /[\u200d\ufe0e\ufe0f]$/u, `width ${w}: a joiner survived the cut it was joining across`);
  }
  // A zero-column character passes a `used + cols > budget` test, so a cut to nothing used to return a
  // combining mark with nothing left to attach to.
  assert.equal(sliceColumns("\u0301abc", 0), "", "no budget, no content");
});

test("the line editor's window is columns and whole characters (#401)", () => {
  // THE CUTTER THE FIRST REPAIR MISSED. `render` windowed with `value.slice(start, start + w).padEnd(w)`,
  // so a CJK value measured half what the terminal drew and an edge landing between the halves of an
  // astral pair put a BARE LOW SURROGATE into the live trigger editor.
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  for (const [name, value] of [
    ["ascii", "hello world"],
    ["a CJK target", "会社/製品#5"],
    ["fullwidth", "ＪＯＢＡＢ"],
    ["emoji", "\u{1f600}\u{1f600}\u{1f600}\u{1f600}"],
    ["combining marks", "jo\u0301b\u0301marks"],
    ["mixed", "a会b\u{1f600}c"],
  ]) {
    for (const w of [1, 2, 3, 5, 8, 12, 20]) {
      for (const focused of [true, false]) {
        const out = makeLineInput(value).render(w, { focused });
        const plain = out.split(LINE_INPUT_CURSOR[0]).join("").split(LINE_INPUT_CURSOR[1]).join("");
        assert.equal(columnsOf(plain), w, `${name} at ${w}${focused ? " focused" : ""}`);
        assert.doesNotMatch(out, lone, `${name} at ${w}${focused ? " focused" : ""}: half a surrogate pair`);
      }
    }
  }
});

test("divider and clipPlain measure in columns, which only a wide title can show (#401)", () => {
  // BOTH OF THESE SURVIVED a mutation back to `.length` while the suite was green, because every fixture
  // that reached them was ASCII. `frame` clips an over-wide line now, so a reverted `divider` is invisible
  // in a framed render: it has to be measured on its own.
  const styler = makeStyler(PLAIN_THEME);
  for (const w of [20, 40, 80]) {
    assert.equal(visibleLen(styler.divider("ジョブ番号", "会社/製品", w)), w, `divider at ${w}`);
    assert.equal(visibleLen(styler.divider("ascii label", "ＭＥＴＡ", w)), w, `divider with a wide meta at ${w}`);
  }
  // `clipPlain` is reached only through a frame title, so this drives it there and measures the rule it
  // computes: the top line is exactly the frame's width.
  for (const w of [12, 20, 40]) {
    const top = frame(styler, { title: "ジョブ番号のタイトル", width: w, lines: [] })[0];
    assert.equal(visibleLen(top), w, `a title clipped to ${w}`);
  }
});

test("a fitted body line keeps its colour, and only an over-wide one is clipped (#401)", () => {
  // THE STRICT COMPARISON IN `padVisible`, pinned where it is observable. Under the PLAIN theme `>=` and
  // `>` render identically, so every existing fixture missed it: an adversarial pass showed the mutant is
  // only visible under a REAL theme, where the loosened comparison sends a line that already fits through
  // `styler.cell` and `cell` strips the styler's own SGR before measuring. The line then still measures
  // right and has silently lost its colour, which is the shape this whole round keeps finding.
  const ESC = String.fromCharCode(27);
  // THE ACCENT AND THE BORDER GET DIFFERENT CODES ON PURPOSE. A first version of this test asked whether
  // the line contained any ESC at all, and `frame` draws its own `│` through `fg("border", ...)`, so the
  // assertion was true however much colour the body had lost. The mutant survived it.
  const ACCENT = `${ESC}[38;5;42m`;
  const styler = makeStyler({
    fg: (c, t) => (c === "border" ? `${ESC}[38;5;99m${t}${ESC}[39m` : `${ACCENT}${t}${ESC}[39m`),
    bold: (t) => `${ESC}[1m${t}${ESC}[22m`,
    bg: (_c, t) => t,
  });
  // THE LINE MUST FIT EXACTLY, or the mutant is not even reached: `>=` and `>` differ only on a line whose
  // visible width EQUALS the pane's inner width, and a shorter line takes neither branch. A first version
  // of this test used a 20-column line inside a 36-column pane and the mutant survived it.
  const inner = 40 - 4;
  const plain = sliceColumns("\u4f1a\u793e/\u88fd\u54c1 ".repeat(6), inner);
  const body = styler.fg("accent", plain + " ".repeat(inner - columnsOf(plain)));
  assert.equal(visibleLen(body), inner, "the fixture is exactly the inner width, which is what makes it a test");
  const [top, line] = frame(styler, { title: "ジョブ", width: 40, lines: [body] });
  assert.ok(line.includes(ACCENT), "a line that fits keeps the colour it arrived with, not just the border's");
  assert.equal(visibleLen(line), 40, "and is still exactly the width");
  assert.equal(visibleLen(top), 40, "as is the rule above it");
  // The other half of the same comparison: one that does NOT fit is cut to the pane rather than breaking it.
  const tooWide = styler.fg("accent", "会社/製品#5 のジョブ".repeat(6));
  assert.equal(visibleLen(frame(styler, { title: "t", width: 40, lines: [tooWide] })[1]), 40, "an over-wide line is clipped");
});

test("a cut drops a lone surrogate rather than passing it on (#401)", () => {
  // PARITY WITH WHAT THE CODE-UNIT CUT DID. Walking characters means the cut cannot CREATE half a pair,
  // which is not the same as dropping one that was already in the input: a review pass measured `clip`
  // passing a lone high surrogate on where the old slice-then-`dropLoneSurrogate` had removed it.
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  // THE FIXTURES MUST ACTUALLY BE CUT. `clip` returns early when the string fits, and an orphan measures 0
  // columns (which is what the renderer draws), so a fixture that fits keeps its orphan and this test would
  // be asserting the #402 case instead of the #401 one. Each of these is far wider than any budget below.
  for (const s of ["\ud83dabcdefghijkl", "ab\ud83dcd\u{1f600}efghijkl", "\udc00abcdefghijkl"]) {
    for (let w = 1; w <= 6; w++) {
      assert.ok(columnsOf(s) > w, `the fixture has to be cut at ${w} or this proves nothing`);
      assert.doesNotMatch(clip(s, w), lone, `clip(${JSON.stringify(s)}, ${w})`);
    }
  }
});

test("the model-visible runs table lines its columns up in columns (#401)", () => {
  // THE CHANNEL THE PANE GATES DO NOT REACH. `renderRuns` answers `/dispatch runs`, so its output goes to
  // the model and to the operator's scrollback rather than through a frame, and it sized its columns with
  // `.length`. A `target` is `local:<basename>` for a local run, so an operator's own folder name lands in
  // it, and one CJK character there shifted every later column of that row against the rows around it.
  const at = "2026-07-21T00:00:00.000Z";
  const base = { flow: "review", outcome: "completed", turns: 3, tokens: { total: 10 }, endedAt: at };
  const rows = renderRuns([
    { ...base, jobId: "gh-aaaa1", target: "local:プロジェクト" },
    { ...base, jobId: "gh-aaaa2", target: "local:project" },
    { ...base, jobId: "gh-aaaa3", target: "local:한글" },
  ]).split("\n");
  // Every row starts its FLOW cell at the same column, which is the only thing a reader of this table
  // needs and the only thing `.length` got wrong.
  const flowAt = rows.slice(1).map((r) => columnsOf(r.slice(0, r.indexOf("review"))));
  assert.equal(new Set(flowAt).size, 1, `the flow column starts at ${[...new Set(flowAt)].join(", ")}`);
  // AND THE CELL IS NOT CUT TO REACH THAT, which alignment alone does not say. A width computed by
  // `.length` is too SMALL for a wide cell, and `pad` then clips every target to it: the columns line up
  // beautifully and the operator's folder name has lost its tail. Both halves are needed or the mutant
  // satisfies the test by truncating.
  assert.match(rows[1], /local:プロジェクト/u, "the CJK target survives whole");
  assert.match(rows[3], /local:한글/u, "and so does the Hangul one");
});

test("the graph's hostile-string caps never leave half a character (#401)", async () => {
  // A CHARACTER CAP, NOT A WIDTH, and that is why it is here rather than left alone: the cut is still a
  // cut, and `clipName`'s own comment calls its input "arbitrary (possibly hostile)". A code-unit slice at
  // 64 lands between the halves of an astral pair whenever the 64th unit is a high surrogate, and the
  // repair that used to catch that downstream now has no caller on this path.
  const { buildGraphModel } = await import("../src/graph-model.mjs");
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  // THE PREFIX HAS TO BE ODD, which is the whole trick and the reason a first version of this test passed
  // against the unfixed code: an astral character is two code units, so a cut at 64 through a run of them
  // lands BETWEEN pairs and splits nothing. An odd number of ASCII characters in front moves the boundary
  // into the middle of a pair, which is the only arrangement that breaks.
  for (const n of [1, 3, 5]) {
    const flow = "x".repeat(n) + "\u{1f600}".repeat(40);
    // THE SHAPE IS THE LOADER'S FLAT ONE, taken from the canned input the graph tests already use, and it
    // is worth a line because getting it wrong is silent: `triggers` must be the FILE shape
    // `{ triggers: [...] }` and each row is flat (`type`, `flow`, `folder`), not the `{on, run}` pair the
    // file itself carries. A wrong shape reads as zero triggers, and every assertion below then holds
    // vacuously against an empty model.
    const model = buildGraphModel({
      triggers: { triggers: [{ type: "cron", index: 0, id: "nightly", pattern: "0 3 * * *", folder: "/srv/site", flow, packages: true }] },
      folderSkills: { "/srv/site": { head: "abc123", truncated: false, unreachable: null, skills: [] } },
      overlaySkills: { skills: [], truncated: false, unreachable: null },
      stagedSkills: { skills: [], unenumerable: [], truncated: false },
    });
    // EVERY STRING IN THE MODEL, walked rather than `JSON.stringify`d: that escapes a lone surrogate to the
    // TEXT `\\ud83d`, so a test reading the serialised form cannot see the defect at all. A first version of
    // this test did exactly that and the mutation survived it.
    const strings = [];
    const walk = (v) => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(model);
    for (const s of strings) {
      assert.doesNotMatch(s, lone, `a flow name with a ${n}-character prefix left half a pair in ${JSON.stringify(s.slice(0, 40))}`);
    }
  }
});

test("the divider clips the meta before the label, measured in columns (#401)", () => {
  // TOTAL WIDTH IS NOT ENOUGH, which is why this asserts the CONTENT. `divider` has four column measures
  // and two of them survived a revert to `.length` while the suite was green: `Math.max(1, ...)` absorbs
  // the error into the rule length, so the line stays exactly its width and only the PRIORITY changes.
  // That priority is the documented behaviour ("clip the META first, and the LABEL only if it alone still
  // does not fit"), so it is what gets asserted.
  const styler = makeStyler(PLAIN_THEME);
  const wide = styler.divider("ジョブ番号", "会社/製品", 20);
  assert.equal(visibleLen(wide), 20, "still exactly the width");
  assert.ok(wide.includes("ジョブ番号"), "the label is kept whole while the meta still has room to give");
  // A meta measured by `.length` is under-sized, so the label gets clipped in its place.
  const marks = styler.divider("operator label here", "jób́márks", 28);
  assert.equal(visibleLen(marks), 28, "still exactly the width");
  assert.ok(marks.includes("OPERATOR LABEL HERE"), "a combining-mark meta does not cost the label its tail");
});

test("the line editor keeps the cursor on the step the caller moved it to (#401)", () => {
  // THE SNAP THE REPAIR ADDED, pinned. Every earlier case built a fresh editor, so the cursor always sat
  // past the end and the snap was never exercised: a mutation using the code-unit index as a step index
  // survived the whole suite. These move the cursor with the object's own methods.
  const li = makeLineInput("\u{1f600}\u{1f600}\u{1f600}");
  li.home();
  li.right();
  const out = li.render(10);
  const before = out.slice(0, out.indexOf(LINE_INPUT_CURSOR[0]));
  // ONE `right` IS ONE CHARACTER, so the cursor sits on the second emoji. Reading `cursor` as a step index
  // would put it on the third, because an astral character is two code units.
  assert.equal(columnsOf(before), 2, "the cursor sits on the second emoji, not the third");
  // And the promise still holds from every position the caller can reach.
  for (const value of ["\u{1f600}\u{1f600}\u{1f600}", "会社/製品", "❤️❤️ab", "1️⃣1️⃣"]) {
    const ed = makeLineInput(value);
    ed.home();
    for (let i = 0; i <= value.length; i++) {
      for (const w of [1, 2, 4, 8, 16]) {
        const r = ed.render(w);
        const plain = r.split(LINE_INPUT_CURSOR[0]).join("").split(LINE_INPUT_CURSOR[1]).join("");
        assert.equal(columnsOf(plain), w, `${JSON.stringify(value)} cursor ${i} width ${w}`);
      }
      ed.right();
    }
  }
});

test("an edit never leaves half a character in the value itself (#401)", () => {
  // THE STATE MACHINE, not the render. `cursor` moves one CODE UNIT at a time, so a backspace with the
  // cursor between the halves of an astral pair used to delete one half and leave the other IN THE STORED
  // VALUE -- which `value()` hands back to whatever saves it, so the half-character outlives the session.
  // The render-side repair cannot reach that; this is the edit-side half of the same promise.
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  for (const value of ["ab\u{1f600}cd", "\u{1f600}\u{1f600}", "a\u{1f600}"]) {
    for (let steps = 0; steps <= value.length; steps++) {
      const back = makeLineInput(value);
      back.end();
      for (let i = 0; i < steps; i++) back.left();
      back.backspace();
      assert.doesNotMatch(back.value(), lone, `backspace after ${steps} lefts on ${JSON.stringify(value)}`);
      const fwd = makeLineInput(value);
      fwd.home();
      for (let i = 0; i < steps; i++) fwd.right();
      fwd.del();
      assert.doesNotMatch(fwd.value(), lone, `delete after ${steps} rights on ${JSON.stringify(value)}`);
    }
  }
});

test("the skill frontmatter cap never leaves half a character either (#401)", async () => {
  // THE SECOND of the two graph caps. `clipName` is pinned above; this one was repaired in the same commit
  // and nothing drove it, so a revert survived. The prefix is odd for the same reason as there: a cut
  // through a run of astral characters at an even offset splits nothing.
  const { parseSkillMeta } = await import("../src/graph-model.mjs");
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  for (const n of [1, 3, 5]) {
    const description = "x".repeat(n) + "\u{1f600}".repeat(120);
    const meta = parseSkillMeta(`---\nname: s\ndescription: ${description}\n---\n`);
    assert.doesNotMatch(String(meta?.description ?? ""), lone, `a description with a ${n}-character prefix left half a pair`);
  }
});

test("a cut cannot splice its input into something wider than the budget (#401)", () => {
  // THE DEFECT CLASS, ONE LEVEL DOWN, and the reason `widthSteps` normalises before it steps rather than
  // letting each consumer drop an orphan. A lone surrogate BREAKS a sequence: the renderer measures
  // `heart + orphan + selector` as one column, because the selector no longer follows its base. Dropping
  // the orphan and re-joining puts them back together as a two-column glyph, so the cut emitted two columns
  // for a budget of one and a 24-column pane drew at 43 by this module's own count.
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const SPLICERS = ["❤\udc00️", "1\udc00️⃣", "❤️\udc00❤️", "a\ud800\u{1f600}b"];
  for (const s of SPLICERS) {
    for (let w = 0; w <= 8; w++) {
      const cut = sliceColumns(s, w);
      assert.ok(columnsOf(cut) <= w, `sliceColumns(${JSON.stringify(s)}, ${w}) came to ${columnsOf(cut)} columns`);
      assert.doesNotMatch(cut, lone, `width ${w}: an orphan survived the cut`);
    }
  }
  // And through the real panes, which is where it was measured.
  for (const w of [12, 24, 40]) {
    for (const line of box({ title: "runs", sections: [{ lines: ["❤\udc00️".repeat(40)] }], width: w })) {
      assert.equal(columnsOf(line), w, `box at ${w}: ${JSON.stringify(line)}`);
    }
  }
});

test("a keycap is consumed whole, and never duplicates its own enclosing mark (#401)", () => {
  // THE ADVANCE, which is the half of the keycap rule no width assertion can see: the enclosing mark is
  // zero columns, so a step that yields the keycap and then advances by one instead of two emits U+20E3
  // AGAIN as its own step. The count is unchanged and the glyph is corrupt, which is exactly the shape that
  // survived a suite pinning only the count.
  const cut = sliceColumns("1️⃣ab", 4);
  assert.equal([...cut].filter((c) => c === "⃣").length, 1, "one enclosing mark, not two");
  assert.equal(cut, "1️⃣ab", "and the keycap is followed by what followed it");
  assert.equal(columnsOf(clip("1️⃣abcdef", 5)), 5, "the clipped form is still exactly the budget");
  assert.equal([...clip("1️⃣abcdef", 5)].filter((c) => c === "⃣").length, 1, "and still one mark");
});

test("the editor's value never admits half a character, through any door (#401)", () => {
  // `backspace` and `del` were fixed to step by character; a review pass found the three doors left open.
  // `stripControls` removes the whole class, and it removes half a character too, and `insert` takes a whole PASTE. The argument
  // that made the edit-side fix necessary is that `value()` is the string that gets SAVED, and it applies
  // here unchanged.
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const pasted = makeLineInput("ok");
  pasted.insert("\ud83dbroken\udc00");
  assert.doesNotMatch(pasted.value(), lone, "a paste");
  const set = makeLineInput("");
  set.setValue("x\udc00y");
  assert.doesNotMatch(set.value(), lone, "setValue");
  assert.doesNotMatch(makeLineInput("a\ud800b").value(), lone, "the constructor");
  // A whole pair still survives all three: this drops half a character, not every astral one.
  const kept = makeLineInput("");
  kept.insert("a\u{1f600}b");
  assert.equal(kept.value(), "a\u{1f600}b", "a whole pair is content, not damage");
  // And the render can no longer emit one either, because the value cannot hold one.
  const ed = makeLineInput("ab\ud800cd");
  for (const w of [1, 3, 6, 10]) assert.doesNotMatch(ed.render(w), lone, `render at ${w}`);
});

test("a lone surrogate cannot reach the drawn line and break a cluster (#401)", async () => {
  // THE LAST VARIANT, and it is the same mechanism as #417 (now matched) with a different leader. The renderer
  // treats a lone surrogate as a cluster BREAK, then computes the next cluster's base after skipping it and
  // counts that base twice. So an orphan the count had already removed was still in the text handed to the
  // renderer, and it made the renderer measure a line wider than we did: measured at 12 columns here and 24
  // there, with a 24-column pane drawing at 36.
  //
  // `clip` used to return its input unchanged when it fitted. It steps the fitted line too now, which makes
  // the rule this module states -- half a character is removed where text ENTERS -- true of the text rather
  // than only of the count.
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const leader = "\ud800ﾟ".repeat(12);
  assert.equal(columnsOf(clip(leader, 80)), visibleWidth(clip(leader, 80)), "a fitted line measures the same on both sides");
  assert.doesNotMatch(clip(leader, 80), lone, "and carries no half character");
  for (const w of [12, 24, 40, 80]) {
    for (const line of box({ title: "t", sections: [{ lines: [leader] }], width: w })) {
      assert.equal(columnsOf(line), w, `box at ${w}, our measure`);
      assert.equal(visibleWidth(line), w, `box at ${w}, the renderer's`);
    }
  }
});

// ISSUE #417: A CLUSTER THAT BEGINS WITH SOMETHING THAT DRAWS NOTHING.
//
// The renderer finds a cluster's base after stripping its leading non-printing code points, then walks the
// cluster again from its second code unit adding a column for U+FF00-U+FFEF and U+0E33 / U+0EB3, so a base
// behind a leader is counted twice. `panel.mjs` now MATCHES that rather than bounding it, and the arms below
// hold it to the renderer the only way a table can be held: by sweeping, with every count derived from the
// renderer alone and pinned as a literal. A pi release that stops double counting turns these red at the
// upgrade, which is the point: the table then over-counts, and the pins say so instead of drifting.

/** Every code point this table draws as nothing: the leaders. Derived, then pinned. */
function zeroWidthCodePoints() {
  const out = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (columnsOf(ch) === 0) out.push(ch);
  }
  return out;
}

/** Every code point the renderer's second walk counts: the tails. */
function doubledTails() {
  const out = [];
  for (let cp = 0xff00; cp <= 0xffef; cp++) out.push(String.fromCodePoint(cp));
  return [...out, "\u0e33", "\u0eb3"];
}

test("a leader cluster measures what the renderer draws, at a string's start and after a character (#417)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function", "pi-tui's visibleWidth must load, or this test is checking nothing");
  const Z = zeroWidthCodePoints();
  const T = doubledTails();
  assert.equal(Z.length, 2684, "every zero-width code point is a leader candidate");
  assert.equal(T.length, 242, "and every code point the renderer's second walk counts is a tail");
  // EXACT, not one-sided, at the two positions a line actually offers: its first column, and after a
  // printing character. The DOUBLED count is the renderer's alone -- where its answer is not the sum of
  // its answers for the parts -- so it cannot restate this module's rule. It is 13,545 at the start
  // (2,616 leaders take the four joining tails, and thirteen prepended format characters take 237 more)
  // and 3,273 after a character, where only the thirty-one marks that start a cluster anywhere and the
  // thirteen prepended characters are left.
  for (const [prefix, pinned] of [["", 13545], ["a", 3273]]) {
    let doubled = 0;
    for (const z of Z) {
      for (const t of T) {
        const s = prefix + z + t;
        const theirs = visibleWidth(s);
        assert.equal(columnsOf(s), theirs, `${JSON.stringify(s)}: we say ${columnsOf(s)}, the renderer draws ${theirs}`);
        if (theirs !== visibleWidth(prefix) + visibleWidth(z) + visibleWidth(t)) doubled += 1;
      }
    }
    assert.equal(doubled, pinned, `the renderer doubles ${pinned} forms after ${JSON.stringify(prefix)}`);
  }
  // AFTER AN EMOJI FORM OR A KEYCAP, which end in a zero-width code point themselves. Asking whether the
  // PREVIOUS character drew nothing skipped every leader run behind one: `\u00a9\ufe0f\u0600\uff01` was 4
  // here and 6 there. One-sided, because the renderer drops the emoji form once a cluster extends past it
  // and this table does not, an over-count that predates #417 and draws short.
  for (const prefix of ["\u00a9\ufe0f", "#\ufe0f\u20e3"]) {
    for (const z of Z) {
      for (const t of ["\uff9e", "\u0e33", "\uff01"]) {
        const s = prefix + z + t;
        assert.ok(columnsOf(s) >= visibleWidth(s), `${JSON.stringify(s)}: we say ${columnsOf(s)}, the renderer draws ${visibleWidth(s)}`);
      }
    }
  }
});

test("whatever stands in front of a leader cluster, the table never measures it narrower (#417)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");
  // EVERY PREDECESSOR, because whether a leader starts a cluster is a question about the code point in
  // front of it, and a list of the ones that matter is the shape this module has stopped trusting.
  let swept = 0;
  let breakers = 0;
  let flags = 0;
  for (let cp = 0x20; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) continue;
    const p = String.fromCodePoint(cp);
    swept += 1;
    // FOUR LEADER SHAPES, one per way a predecessor can matter: a mark that joins anything printing, a
    // mark that starts a cluster wherever it stands, a prepended format character, and a Hangul filler,
    // which joins a Hangul jamo in front of it and nothing else. `panel.mjs` asks the segmenter about a
    // STAND-IN for most predecessors, so this is the sweep that shows the stand-in is never narrower: a
    // character wrongly stood in for fails here, by name.
    for (const leader of ["\u0301\uff9e", "\u102c\uff9e", "\u0600\uff01", "\u1160\uff9e"]) {
      const s = p + leader;
      const ours = columnsOf(s);
      const theirs = visibleWidth(s);
      assert.ok(ours >= theirs, `${JSON.stringify(s)}: we say ${ours}, the renderer draws ${theirs}`);
      // THE TWO DECLARED OVER-COUNTS: an unassigned predecessor (the table's one-column guess), and a
      // regional indicator, which the renderer draws as two columns WHATEVER follows it in its cluster.
      if (ours !== theirs) {
        const flag = cp >= 0x1f1e6 && cp <= 0x1f1ff;
        if (flag && leader === "\u0301\uff9e") flags += 1;
        assert.ok(flag || !/\p{Assigned}/u.test(p), `${JSON.stringify(s)} over-counts after an assigned character for no stated reason`);
      }
      if (leader === "\u0301\uff9e" && theirs === visibleWidth(p) + 2) breakers += 1;
    }
  }
  assert.equal(swept, 1111999, "every predecessor there is");
  assert.equal(breakers, 6446, "the predecessors after which the renderer starts a doubled cluster");
  assert.equal(flags, 26, "and every regional indicator is the declared over-count");
});

test("longer leader runs and longer tails agree with the renderer too (#417)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");
  // A SECOND LEADER on either side of each one, and a second tail, because a rule fitted to the two-code-
  // point form can be right there and wrong one character further along. U+FFA0 is here because the
  // renderer's second walk counts it too, which nothing in the table would say on its own.
  const Z = zeroWidthCodePoints();
  let forms = 0;
  for (const z of Z) {
    for (const other of ["\u0301", "\u200d", "\u102b", "\u200b", "\u0600", "\uffa0"]) {
      for (const run of [z + other, other + z]) {
        for (const t of ["\uff9e", "\u0e33", "\uff01"]) {
          for (const after of ["", "\uff9f", "a", "\u0301\uff9e"]) {
            // The last two put a zero-width character that doubles nothing, and then a printing one, in
            // front: a run flag that the printing character failed to reset under-counted both.
            for (const prefix of ["", "a", "\u0301a", "e\u0301 x"]) {
              const s = prefix + run + t + after;
              assert.equal(columnsOf(s), visibleWidth(s), `${JSON.stringify(s)}: we say ${columnsOf(s)}, the renderer draws ${visibleWidth(s)}`);
              forms += 1;
            }
          }
        }
      }
    }
  }
  assert.equal(forms, 1545984, "every form was measured");
});

test("a cut never separates a leader from the base it doubles (#417)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");
  // ONE STEP, so no cut can take the leader and leave the base, or take the base at the price of one
  // column when it draws two. RAW input for `sliceColumns`: `clip` deletes the format characters first,
  // so it would test nothing for them.
  for (const z of zeroWidthCodePoints()) {
    for (const s of [z + "\uff9e\uff9fbc", "a" + z + "\u0e33x", z + "\uff01z"]) {
      for (let w = 0; w <= 6; w++) {
        const cut = sliceColumns(s, w);
        assert.ok(visibleWidth(cut) <= w, `sliceColumns(${JSON.stringify(s)}, ${w}) draws ${visibleWidth(cut)}`);
        assert.equal(columnsOf(cut), visibleWidth(cut), `and measures what it draws: ${JSON.stringify(cut)}`);
        const clipped = clip(s, w);
        assert.ok(visibleWidth(clipped) <= w, `clip(${JSON.stringify(s)}, ${w}) draws ${visibleWidth(clipped)}`);
      }
    }
  }
});

test("a pane holding leader clusters measures exactly its width, in our terms and the renderer's (#417)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");
  const styler = makeStyler(PLAIN_THEME);
  // THE MYANMAR REPEAT IS THE ONE THE ISSUE DID NOT SEE: U+102C is a mark that starts a cluster wherever it
  // stands, so the frame's own leading space does not absorb it, and a 24-column pane drew at 33. The
  // emoji-form repeat is the shape the first repair got wrong. The leader-led line is the frame's first
  // column, which the frame's space now absorbs exactly rather than being padded as though it were not there.
  const lines = [
    "a\u102c\uff9e".repeat(20),
    "\u00a9\ufe0f\u102c\uff9e".repeat(10),
    "\u0301\uff9exyz",
    "\u0e48\u0e33 and more",
    "plain ascii line",
  ];
  for (const w of [8, 9, 10, 24, 40, 80]) {
    const footer = "\u0301\uff9exyz";
    const panes = [
      ["box", box({ title: "t", sections: [{ lines }], footer, width: w })],
      ["frame", frame(styler, { title: "t", width: w, lines, footer })],
    ];
    for (const [name, pane] of panes) {
      for (const line of pane) {
        assert.equal(columnsOf(line), w, `${name} at ${w}, our measure: ${JSON.stringify(line)}`);
        assert.equal(visibleWidth(line), w, `${name} at ${w}, the renderer's: ${JSON.stringify(line)}`);
      }
    }
  }
});

test("the line editor's window draws exactly its width after the prompt, whole and piece by piece (#417)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");
  // TWO READINGS, because the editor is drawn two ways at once. The terminal reads the whole line after the
  // `/ ` prompt, and the overlay compositor reads each run between two colour codes on its own -- the
  // styler colours the prompt and wraps the cursor cell in inverse video -- so the head, the cursor cell and
  // the tail are each measured from their own first column there. Neither may pass the width, and the
  // larger is exactly the width. The third value is the one whole-value step sums get wrong (U+0D4E is a
  // prepended letter, so windowing it away makes the Myanmar mark lead a cluster of its own), and the fifth
  // is ordinary Thai, whose tail after a cursor on its first letter begins with a tone mark.
  const values = ["ab\u0301\uff9ecd\u102c\uffe0ef", "\u102c\uff9e".repeat(6), "\u0d4e\u102c\uff9exy", "\u0301\uff9e\u0e48\u0e33gh", "\u0e19\u0e49\u0e33abc"];
  const [open, close] = LINE_INPUT_CURSOR;
  for (const v of values) {
    const ed = makeLineInput(v);
    ed.home();
    for (let pos = 0; pos <= v.length; pos++) {
      for (let w = 1; w <= 16; w++) {
        for (const focused of [true, false]) {
          const out = ed.render(w, { focused });
          const where = `${JSON.stringify(v)} cursor ${ed.cursor()} width ${w} focused ${focused}: ${JSON.stringify(out)}`;
          const plain = out.split(open).join("").split(close).join("");
          const whole = visibleWidth("/ " + plain) - 2;
          const pieces = focused
            ? out.split(open).flatMap((part) => part.split(close)).reduce((n, part) => n + visibleWidth(part), 0)
            : visibleWidth(plain);
          assert.ok(whole <= w && pieces <= w, `${where} draws ${whole} whole and ${pieces} in pieces`);
          assert.equal(Math.max(whole, pieces), w, where);
          // AND THE CURSOR CELL IS THE CURSOR'S CHARACTER: trimming gives up the tail first and the head
          // second, never the cell the caller moved the cursor to. A cursor inside a step names the step
          // after it (a step is at most three code units), which is the editor's own rounding rule.
          if (focused && ed.cursor() < ed.value().length && w >= 2) {
            const under = out.slice(out.indexOf(open) + 1, out.indexOf(close));
            // Inside the LAST step it rounds to the end of the value, where the cursor is a blank cell.
            const rest = ed.value().slice(ed.cursor());
            const ok = under === " " ? rest.length <= 2 : rest.indexOf(under) >= 0 && rest.indexOf(under) < 3;
            assert.ok(ok, `${where}: the cursor sits on ${JSON.stringify(under)}`);
          }
        }
      }
      ed.right();
    }
  }
});

test("the runs table measures a cell where it is drawn, after a space (#417)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");
  // NO CELL OF THIS TABLE IS AT COLUMN 0: pi draws the message in a box with a column of padding, and the
  // cells are joined by two spaces. `\u0301\uff9e` is 2 columns at the start of a string and 1 after a
  // space, and a Myanmar vowel sign with a halfwidth mark is 2 in both places.
  const at = "2026-07-21T00:00:00.000Z";
  const base = { flow: "review", outcome: "completed", turns: 3, tokens: { total: 10 }, endedAt: at, target: "t" };
  const ids = ["\u0301\uff9egh-aaaa1", "\u102c\uff9egh-aaa2", "gh-aaaa33"];
  const rows = renderRuns(ids.map((jobId) => ({ ...base, jobId }))).split("\n");
  const flowAt = rows.slice(1).map((r) => visibleWidth(" " + r.slice(0, r.indexOf("review"))) - 1);
  assert.equal(new Set(flowAt).size, 1, `the flow column starts at ${flowAt.join(", ")}`);
  // AND THE COLUMN IS NO WIDER THAN ITS WIDEST CELL DRAWS. All three ids draw nine columns after a space,
  // so each is followed by exactly the two-space gap: measured at column 0 the first counted ten, and the
  // whole column widened by one for a cell that never draws that wide.
  ids.forEach((id, i) => assert.ok(rows[i + 1].startsWith(id + "  ") && !rows[i + 1].startsWith(id + "   "), `row ${i + 1}: ${JSON.stringify(rows[i + 1])}`));
});

test("a styled line keeps its right border through the renderer's own cut (#417)", async () => {
  const tui = await loadRenderer();
  assert.ok(tui, "pi-tui must load");
  // THE COMPOSITOR SEGMENTS EACH PIECE BETWEEN TWO ESCAPE CODES ON ITS OWN, so a mark right after a colour
  // code leads a cluster there even when it does not in the whole string. The line measured to fit, and the
  // compositor's cut at the pane's width dropped the border.
  const ESC = String.fromCharCode(27);
  const styler = makeStyler({ fg: (_c, t) => `${ESC}[31m${t}${ESC}[39m`, bold: (t) => t, bg: (_c, t) => t });
  for (const w of [12, 24, 40]) {
    const body = "id " + styler.fg("accent", "\u0301\uff9exyz");
    for (const line of frame(styler, { title: "t", width: w, lines: [body] })) {
      const kept = tui.sliceByColumn(line, 0, w, true);
      assert.equal(styler.stripAnsi(kept), styler.stripAnsi(line), `at ${w} the compositor keeps the whole line: ${JSON.stringify(line)}`);
    }
  }
});

test("an adversarial line of leader clusters is still cheap to count and cut (#417)", () => {
  // EVERY CHARACTER A LEADER RUN THAT DEFEATS THE FAST PATH, which is what the memo is for: without it each
  // pair asks the segmenter, and a live tail of such lines went from about a second to render to about six.
  // A RATIO against a plain line of the same length, best of three, rather than a ceiling in milliseconds:
  // a slow runner moves both sides, and a ceiling generous enough never to flake was also generous enough
  // to pass with the memo removed. Measured at about 2 with the memo and about 15 without it.
  const best = (f) => {
    let b = Infinity;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      f();
      b = Math.min(b, performance.now() - t0);
    }
    return b;
  };
  const hostile = "\u102c\uff9e".repeat(50000);
  const plain = "a\uff9e".repeat(50000);
  assert.equal(columnsOf(hostile), 100000, "every pair is a doubled cluster");
  const ratio = best(() => { columnsOf(hostile); clip(hostile, 80); }) / best(() => { columnsOf(plain); clip(plain, 80); });
  assert.ok(ratio < 6, `the hostile line costs ${ratio.toFixed(1)} times a plain one`);
});

test("the leader memo answers each context for itself, whichever is measured first (#417)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");
  // A POISONED MEMO, measured by a review pass. After an emoji form the character in front of a run is
  // U+FE0F, and a run can also BEGIN with U+FE0F at the start of a string; the first memo keyed both the
  // same, so the first one measured answered for the other, and the start-of-string shape came out one
  // column short. Both orders, both zero-width tails of a step (an emoji form and a keycap).
  for (const [after, start] of [
    ["\u00a9\ufe0f\u0903\uff9e", "\ufe0f\u0903\uff9e"],
    ["#\ufe0f\u20e3\u093f\u0e33", "\u20e3\u093f\u0e33"],
  ]) {
    for (const order of [[after, start], [start, after]]) {
      for (const s of order) assert.ok(columnsOf(s) >= visibleWidth(s), `${JSON.stringify(s)}: we say ${columnsOf(s)}, the renderer draws ${visibleWidth(s)}`);
    }
    assert.equal(columnsOf(start), visibleWidth(start), `${JSON.stringify(start)} at the start of a string is exact`);
  }
});

test("a styled line measures the larger of its whole and its pieces, never the smaller (#417)", async () => {
  const tui = await loadRenderer();
  assert.ok(tui, "pi-tui must load");
  const ESC = String.fromCharCode(27);
  const red = (t) => `${ESC}[31m${t}${ESC}[39m`;
  // The first is wider WHOLE (the leading mark is its own cluster there and a piece's first column is not
  // where it stands), the second wider in PIECES (the colour code makes the mark lead a cluster). Either
  // reading alone under-counts one of them.
  for (const line of ["\u0301" + red("\uff9e") + "xyz", "id " + red("\u0301\uff9exyz")]) {
    const whole = tui.visibleWidth(line);
    const pieces = line.split(/\u001b\[[0-9;]*m/).reduce((n, piece) => n + tui.visibleWidth(piece), 0);
    assert.equal(visibleLen(line), Math.max(whole, pieces), `${JSON.stringify(line)}: whole ${whole}, pieces ${pieces}`);
  }
});

test("the line editor stays linear on a pasted run of marks behind the cursor (#417)", () => {
  // THE TRIM LOOP RE-MEASURED THE WINDOW ONCE PER STEP IT GAVE UP, and a mark gives up no width, so a
  // run of them behind the cursor made each render quadratic: 16,000 marks took ten seconds, measured.
  // Now about 5 ms; a ceiling of half a second cannot flake and still catches the quadratic shape.
  const ed = makeLineInput("\u0d4e\u102c\uff9ebb" + "\u0301".repeat(16000));
  ed.home();
  for (let k = 0; k < 4; k++) ed.right();
  const t0 = performance.now();
  ed.render(3);
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `rendered in ${Math.round(ms)} ms`);
});
