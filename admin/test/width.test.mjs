import assert from "node:assert/strict";
import { test } from "node:test";
import { LINE_INPUT_CURSOR, box, clip, columnsOf, makeLineInput, pad, sliceColumns } from "../src/panel.mjs";
import { frame, makeStyler, PLAIN_THEME, visibleLen } from "../src/style.mjs";
import { renderRuns } from "../src/render.mjs";
import { loadVisibleWidth } from "./helpers/renderer.mjs";

// EVERY WIDTH PROMISE IN THIS PANEL WAS A UTF-16 COUNT (issue #401), and this file is where the repair is
// held against the only authority available: pi's own renderer, which is what actually draws these lines.
//
// `clip`, `pad`, `styler.cell`, `divider` and `frame` all sized themselves with `.length`, so a framed pane
// this module reported as exactly 80 columns came out at 90 in the terminal for a CJK job id, and ragged
// the other way for a combining mark. The table lives in `panel.mjs` rather than in the overlay-only
// `style.mjs`, because the two renderers draw the same geometry and a width rule that holds in one and not
// the other is the "holds on one branch of an if" shape this round kept finding.


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
