import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { box, clip, columnsOf, pad, sliceColumns } from "../src/panel.mjs";
import { frame, makeStyler, PLAIN_THEME, visibleLen } from "../src/style.mjs";

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
  try {
    const pi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { visibleWidth } = await import(pathToFileURL(pi.resolve("@earendil-works/pi-tui")).href);
    return typeof visibleWidth === "function" ? visibleWidth : null;
  } catch {
    return null;
  }
}

/** `[name, string, what pi and we must agree it is]` -- the cases a review pass measured as broken. */
const AGREE = [
  ["ascii", "hello world", 11],
  ["a CJK job id", "ジョブ番号", 10],
  ["a CJK repo target", "会社/製品#5", 11],
  ["fullwidth latin", "ＪＯＢ", 6],
  ["hangul", "한글테스트", 10],
  ["combining marks", "jób́", 3],
  ["a zero-width space", "a​b​c", 3],
  ["a bidi override", "a‮b", 2],
  ["box drawing", "┌─┐", 3],
  ["one emoji", "\u{1f600}", 2],
];

test("the column count agrees with pi's own renderer on everything but a ZWJ sequence (#401)", async () => {
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
  const family = "\u{1f468}‍\u{1f469}‍\u{1f466}";
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
  const sections = [{ title: "ジョブ", lines: ["会社/製品#5 のジョブ", "plain ascii row", "jób́ marks"] }];
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
  const lines = ["会社/製品#5 のジョブ", "plain ascii row", "jób́ with combining marks"];
  for (const w of [20, 40, 80]) {
    for (const line of frame(styler, { title: "ジョブ", width: w, lines: lines.map((l) => styler.cell(l, w - 4)), footer: "Ｆ" })) {
      assert.equal(visibleLen(line), w, `width ${w}: our own measure`);
      assert.equal(visibleWidth(line), w, `width ${w}: and pi's, which is the one the terminal uses`);
    }
  }
});
