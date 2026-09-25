import assert from "node:assert/strict";
import { test } from "node:test";
import { LINE_INPUT_CURSOR, box, clip, columnsOf, makeLineInput, pad, sliceColumns } from "../src/panel.mjs";
import { frame, makeStyler, PLAIN_THEME, visibleLen } from "../src/style.mjs";
import { renderRuns } from "../src/render.mjs";
import { loadRenderer, loadVisibleWidth } from "./helpers/renderer.mjs";

// Issue #417's arms, split out of `width.test.mjs` so that no one file runs past the per-file cap the
// test-count check allows; the renderer oracle is shared in `helpers/renderer.mjs`.

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
    // A leader that doubles a base is never left behind on its own: a one-column cut of one takes nothing.
    if (columnsOf(z + "\uff9e") === 2) assert.equal(sliceColumns(z + "\uff9ebc", 1), "", `a cut of ${JSON.stringify(z + "\uff9e")}`);
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
  // The sixth has a cursor inside a bundle, which rounding forward drew on the step after it; the seventh
  // is a mark after its base that trimming must not drop; the last is Thai whose final letter carries a
  // tone mark, which trimming took away when the cursor sat on that letter and only its mark followed.
  const values = ["ab\u0301\uff9ecd\u102c\uffe0ef", "\u102c\uff9e".repeat(6), "\u0d4e\u102c\uff9exy", "\u0301\uff9e\u0e48\u0e33gh", "\u0e19\u0e49\u0e33abc", "x\u0301\u102c\u102c\u102c\u102c\u0e33y", "a\u0301\uff9e", "\u0e19\u0e49\u0e33\u0e01\u0e48".repeat(3)];
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
          // A NONSPACING MARK GOES WITH ITS BASE: trimming the window from the end took a Thai tone mark
          // away and kept the letter it sits on, a character that is not in the value.
          const shown = plain.replace(/ +$/u, "");
          const from = ed.value().indexOf(shown);
          if (shown !== "" && from >= 0) assert.doesNotMatch(ed.value().slice(from + shown.length, from + shown.length + 1), /\p{Mn}/u, `${where}: a mark was cut from its base`);
          // AND THE CURSOR CELL HOLDS THE CURSOR'S CHARACTER: trimming gives up the tail first and the
          // head second, never the cell the caller moved the cursor to. A cursor inside a step names that
          // step. Four columns is the widest step here (a prepended character doubling a wide base).
          if (focused && ed.cursor() < ed.value().length && w >= 4) {
            const under = out.slice(out.indexOf(open) + 1, out.indexOf(close));
            const c = ed.cursor();
            let holds = false;
            for (let k = 0; k < under.length && !holds; k++) holds = c - k >= 0 && ed.value().startsWith(under, c - k);
            assert.ok(under !== " " && holds, `${where}: the cursor sits on ${JSON.stringify(under)}`);
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
  // AND WITH THE CHARACTER IN FRONT OF EACH RUN VARIED, which defeated a memo keyed on that character:
  // CJK ideographs, every Hangul syllable, which a first cut of the stand-in kept as themselves, and
  // private-use characters, which it did not stand in at all.
  let cjk = "";
  let hangul = "";
  let pua = "";
  for (let k = 0; k < 33000; k++) {
    cjk += String.fromCodePoint(0x4e00 + k) + "\u102c\uff9e";
    hangul += String.fromCodePoint(0xac00 + (k % 11172)) + "\u102c\uff9e";
    pua += String.fromCodePoint(0xe000 + (k % 6400)) + "\u102c\uff9e";
  }
  const base = best(() => { columnsOf(plain); clip(plain, 80); });
  for (const [name, line] of [["repeated", hostile], ["varied CJK", cjk], ["varied Hangul", hangul], ["varied private-use", pua]]) {
    const ratio = best(() => { columnsOf(line); clip(line, 80); }) / base;
    assert.ok(ratio < 6, `the ${name} hostile line costs ${ratio.toFixed(1)} times a plain one`);
  }
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

test("the line editor stays linear on a pasted run of marks on either side of the cursor (#417)", () => {
  // THE TRIM LOOP RE-MEASURED THE WINDOW ONCE PER STEP IT GAVE UP, and a mark gives up no width, so a
  // run of them past the cursor made each render quadratic: 16,000 marks took ten seconds, measured, and
  // the same run IN FRONT of the cursor took twenty-six once the other end was fixed. Now a few ms each;
  // a ceiling of half a second cannot flake and still catches the quadratic shape.
  const after = makeLineInput("\u0d4e\u102c\uff9ebb" + "\u0301".repeat(16000));
  after.home();
  for (let k = 0; k < 4; k++) after.right();
  const before = makeLineInput("a" + "\u0301".repeat(16000) + "\uff9e");
  before.end();
  for (const [name, ed, w] of [["after", after, 3], ["before", before, 2]]) {
    const t0 = performance.now();
    ed.render(w);
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `marks ${name} the cursor: rendered in ${Math.round(ms)} ms`);
  }
});

test("a narrow window keeps the cursor on its own character, not on a blank (#417)", () => {
  // Trimming the end one step too far gave up the cursor's own cell: with the cursor on `x`, a two-column
  // window drew the cursor as a blank after the halfwidth mark.
  const ed = makeLineInput("\u0d4e\u102c\uff9ex\u0301\u0301yz");
  ed.home();
  for (let k = 0; k < 3; k++) ed.right();
  const out = ed.render(2);
  assert.equal(out.slice(out.indexOf(LINE_INPUT_CURSOR[0]) + 1, out.indexOf(LINE_INPUT_CURSOR[1]))[0], "x", JSON.stringify(out));
});

test("a null body line is a blank line, in both frame builders (#417)", () => {
  // The frames now pad `" " + line`, and a null or undefined line would have drawn as the word.
  const styler = makeStyler(PLAIN_THEME);
  for (const line of [null, undefined]) {
    assert.equal(box({ sections: [{ lines: [line] }], width: 12 })[1], `${"|"} ${" ".repeat(8)} ${"|"}`.replace(/\|/g, box({ sections: [{ lines: [""] }], width: 12 })[1][0]));
    assert.equal(frame(styler, { width: 12, lines: [line] })[1], frame(styler, { width: 12, lines: [""] })[1]);
  }
});
