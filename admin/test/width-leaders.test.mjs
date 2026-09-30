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
// The renderer finds a cluster's base after stripping its leading non-printing code points. Under pi-tui
// 0.80.7 it then walked the cluster again from its second code unit, adding a column for U+FF00-U+FFEF and
// U+0E33 / U+0EB3, so a base behind a leader was counted twice, and `panel.mjs` matched that. pi-tui 0.99.1
// (issue #509) walks from after the base instead, so NOTHING IS DOUBLED ANY MORE; and it gives 472 spacing
// marks a column of their own, which a cluster they LEAD does not draw. So the leader that matters moved from
// "any zero-width code point" to "a spacing mark", and the correction from wider to narrower. The arms below
// hold both to the renderer the only way a table can be held: by sweeping, with every count derived from the
// renderer alone and pinned as a literal. That is how this upgrade was found: the doubling pins went red at
// it, as this comment said they would, and now pin zero.

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

/** Every spacing mark: a mark this table, like the renderer, draws one column wide on its own. */
function spacingMarks() {
  const out = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (/\p{M}/u.test(ch) && columnsOf(ch) === 1) out.push(ch);
  }
  return out;
}

/** Every code point the renderer counts after a cluster's base without a mark in front of it: the tails. */
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
  // 2,684 under pi-tui 0.80.7, when every mark drew nothing; 0.99.1 moved the 472 spacing marks to one
  // column, and they are swept as leaders of their own below.
  assert.equal(Z.length, 2212, "every zero-width code point is a leader candidate");
  assert.equal(T.length, 242, "and every code point the renderer counts after a base is a tail");
  // EXACT, not one-sided, at the two positions a line actually offers: its first column, and after a
  // printing character. The DOUBLED count is the renderer's alone -- where its answer is not the sum of
  // its answers for the parts -- so it cannot restate this module's rule. Under pi-tui 0.80.7 it was
  // 13,545 at the start and 3,273 after a character. Under 0.99.1 it is ZERO at both: a zero-width
  // leader now draws nothing wherever it stands, which this sweep holds exactly.
  for (const [prefix, pinned] of [["", 0], ["a", 0]]) {
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
  // A SPACING MARK AS THE LEADER, the rule 0.99.1 brought (issue #509): alone it draws one column, and
  // leading a cluster it draws nothing, so the renderer's answer is NARROWER than the sum of its parts. It
  // is 1,888 forms at the start of a string (each of the 472 marks before the four tails that join a
  // cluster) and 124 after a character, where only the thirty-one marks that start a cluster anywhere are
  // left. Both counts are the renderer's alone; exactness is what holds the table to them.
  const S = spacingMarks();
  assert.equal(S.length, 472, "every spacing mark the renderer gives a column is a leader too");
  for (const [prefix, pinned] of [["", 1888], ["a", 124]]) {
    let narrower = 0;
    for (const m of S) {
      for (const t of T) {
        const s = prefix + m + t;
        const theirs = visibleWidth(s);
        assert.equal(columnsOf(s), theirs, `${JSON.stringify(s)}: we say ${columnsOf(s)}, the renderer draws ${theirs}`);
        if (theirs < visibleWidth(prefix) + visibleWidth(m) + visibleWidth(t)) narrower += 1;
      }
    }
    assert.equal(narrower, pinned, `the renderer draws ${pinned} spacing-mark forms as their base alone after ${JSON.stringify(prefix)}`);
  }
  // A WIDE BASE BEHIND A SPACING MARK. The five emoji modifiers are the only two-column code points that
  // join a cluster a spacing mark leads, and they are what shows the leader step keeps its base's own
  // width: at the start of a string each form is the modifier alone, two columns, exactly. After a letter
  // the thirty-one marks that start a cluster anywhere are exact too, and the rest join the letter's
  // cluster, where the renderer counts a modifier after a non-emoji base as nothing: the skin-tone
  // over-count `panel.mjs` already declares, so that half is one-sided.
  const MODIFIERS = ["\u{1f3fb}", "\u{1f3fc}", "\u{1f3fd}", "\u{1f3fe}", "\u{1f3ff}"];
  let exactAfter = 0;
  for (const m of S) {
    for (const mod of MODIFIERS) {
      assert.equal(columnsOf(m + mod), 2, `${JSON.stringify(m + mod)}: the modifier alone`);
      assert.equal(visibleWidth(m + mod), 2, `${JSON.stringify(m + mod)}: and the renderer agrees`);
      const s = "a" + m + mod;
      assert.ok(columnsOf(s) >= visibleWidth(s), `${JSON.stringify(s)}: we say ${columnsOf(s)}, the renderer draws ${visibleWidth(s)}`);
      if (columnsOf(s) === visibleWidth(s)) exactAfter += 1;
    }
  }
  assert.equal(exactAfter, 155, "exact after a letter for the thirty-one marks that start a cluster, with each modifier");
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
  // point form can be right there and wrong one character further along. U+102B is a spacing mark that
  // starts a cluster wherever it stands. U+FFA0 is here because pi-tui 0.80.7's second walk counted it
  // too, which nothing in the table would say on its own; 0.99.1 skips it as default-ignorable.
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
  // 576 forms per zero-width code point: 1,545,984 while the spacing marks were among them (0.80.7).
  assert.equal(forms, 1274112, "every form was measured");
});

test("a cut never separates a leader from the base it doubles (#417)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");
  // ONE STEP, so no cut can take the leader and leave the base: a spacing mark left behind on its own draws
  // the column its cluster did not (pi-tui 0.99.1), as a base cut from a doubling leader once drew two
  // for one (0.80.7). RAW input for `sliceColumns`: `clip` deletes the format characters first, so it would
  // test nothing for them.
  let stranded = 0;
  for (const z of [...zeroWidthCodePoints(), ...spacingMarks()]) {
    // A spacing mark that leads its base's cluster after a character is never left behind on its own: a
    // one-column cut after that character takes the character and nothing else.
    if (columnsOf("a" + z + "\uff9e") === 2 && columnsOf(z) === 1) {
      assert.equal(sliceColumns("a" + z + "\uff9ebc", 1), "a", `a cut of ${JSON.stringify("a" + z + "\uff9e")}`);
      stranded += 1;
    }
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
  assert.equal(stranded, 31, "the thirty-one spacing marks that start a cluster wherever they stand");
});

test("a pane holding leader clusters measures exactly its width, in our terms and the renderer's (#417)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");
  const styler = makeStyler(PLAIN_THEME);
  // THE MYANMAR REPEAT IS THE ONE THE ISSUE DID NOT SEE: U+102C is a mark that starts a cluster wherever it
  // stands, so the frame's own leading space does not absorb it, and a 24-column pane drew at 33 under
  // pi-tui 0.80.7. Under 0.99.1 the same cluster draws its base alone, one column NARROWER than the sum,
  // so the same line is the fixture for the opposite correction (issue #509). The
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
  // cells are joined by two spaces. Under pi-tui 0.99.1 `\u093e\uff9e` is 1 column at the start of a
  // string (the spacing mark leads the cluster and draws nothing) and 2 after a space (it joins the
  // space's cluster and draws its own column), so the first id draws ten columns where it stands and
  // counts nine at column 0. Under 0.80.7 the fixture was `\u0301\uff9e`, 2 at the start and 1 after a
  // space, the other direction; 0.99.1 draws that one 1 in both places, so it is kept as a control.
  const at = "2026-07-21T00:00:00.000Z";
  const base = { flow: "review", outcome: "completed", turns: 3, tokens: { total: 10 }, endedAt: at, target: "t" };
  const ids = ["\u093e\uff9egh-aaaa1", "\u0301\uff9egh-aaaa2", "gh-aaaa3"];
  assert.deepEqual(ids.map((id) => visibleWidth(" " + id) - 1), [10, 9, 8], "the fixture draws these widths after a space");
  assert.deepEqual(ids.map((id) => visibleWidth(id)), [9, 9, 8], "and these at column 0, the first narrower");
  const rows = renderRuns(ids.map((jobId) => ({ ...base, jobId }))).split("\n");
  // Measured at column 0 the first id counted nine, the column was nine wide, and its row drew one column
  // past it, so its flow cell started one column right of the others.
  const flowAt = rows.slice(1).map((r) => visibleWidth(" " + r.slice(0, r.indexOf("review"))) - 1);
  assert.equal(new Set(flowAt).size, 1, `the flow column starts at ${flowAt.join(", ")}`);
  // AND THE COLUMN IS NO WIDER THAN ITS WIDEST CELL DRAWS: the widest id is followed by exactly the
  // two-space gap, and every narrower one by the gap plus what it lacks of the widest.
  ids.forEach((id, i) => {
    const gap = 2 + 10 - (visibleWidth(" " + id) - 1);
    assert.ok(rows[i + 1].startsWith(id + " ".repeat(gap)) && !rows[i + 1].startsWith(id + " ".repeat(gap + 1)), `row ${i + 1}: ${JSON.stringify(rows[i + 1])}`);
  });
});

test("a styled line keeps its right border through the renderer's own cut (#417)", async () => {
  const tui = await loadRenderer();
  assert.ok(tui, "pi-tui must load");
  // THE COMPOSITOR SEGMENTS EACH PIECE BETWEEN TWO ESCAPE CODES ON ITS OWN, so a cluster a colour code
  // splits is measured as two there. Under pi-tui 0.80.7 that was a combining mark after the code doubling
  // its base; under 0.99.1 it is a spacing mark before the code, cut from the base it leads, drawing a
  // column the whole string does not. The line measured to fit, and the compositor's cut at the pane's
  // width dropped the border.
  const ESC = String.fromCharCode(27);
  const styler = makeStyler({ fg: (_c, t) => `${ESC}[31m${t}${ESC}[39m`, bold: (t) => t, bg: (_c, t) => t });
  for (const w of [12, 24, 40]) {
    const body = "id " + styler.fg("accent", "\u102c") + "\uff9exyz";
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
  // 100,000 under pi-tui 0.80.7, which doubled each pair's base; 0.99.1 draws each pair as its base alone.
  assert.equal(columnsOf(hostile), 50000, "every pair is a cluster its spacing mark leads");
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
  // The first is wider WHOLE (the spacing mark joins `a` and draws its column there, and leads the piece
  // it starts, where it draws none), the second wider in PIECES (the colour code cuts the mark from the
  // base it leads, so it draws its own column). Either reading alone under-counts one of them. Under
  // pi-tui 0.80.7 the fixtures were a combining acute and a doubled base; 0.99.1 draws both of those
  // the same whole and in pieces, which the inequality below would now refuse (issue #509).
  for (const line of ["a" + red("\u093e\uff9e") + "xyz", red("\u102c") + "\uff9exyz"]) {
    const whole = tui.visibleWidth(line);
    const pieces = line.split(/\u001b\[[0-9;]*m/).reduce((n, piece) => n + tui.visibleWidth(piece), 0);
    assert.notEqual(whole, pieces, `${JSON.stringify(line)}: the fixture must tell the two readings apart`);
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

// ISSUE #509's REVIEW: two cuts the spacing-mark rule left measuring text somewhere other than where it is
// drawn. Every character that could be misread in this file's source is built from its code point.
const ZWJ = String.fromCodePoint(0x200d);
const GRIN = String.fromCodePoint(0x1f600);

test("a cut that strips a dangling joiner measures what is left again (#509)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");
  // A SPACING MARK AND A JOINER ARE ONE CLUSTER THAT DRAWS NOTHING, and the mark alone draws a column. The
  // cut kept the pair for a budget of one and then stripped the joiner it was left dangling with, so
  // `x`, U+102C, ZWJ, an emoji padded to 2 drew 3.
  const repro = "x" + String.fromCodePoint(0x102c) + ZWJ + GRIN;
  for (const w of [1, 2, 3]) {
    assert.equal(visibleWidth(pad(repro, w)), w, `pad to ${w}`);
    assert.equal(columnsOf(pad(repro, w)), w, `pad to ${w}, our measure`);
  }
  // THE MARKS IT CAN HAPPEN TO, derived from the renderer: a spacing mark whose joiner, once stripped,
  // changes what the text before it draws. They are the thirty-one that start a cluster wherever they stand.
  const hit = spacingMarks().filter((m) => visibleWidth("x" + m + ZWJ) !== visibleWidth("x" + m));
  assert.equal(hit.length, 31, "the marks whose dangling joiner changes their cluster");
  for (const m of hit) {
    for (const base of ["", "x", "a "]) {
      const s = base + m + ZWJ + GRIN;
      for (let w = 0; w <= 5; w++) {
        const cut = sliceColumns(s, w);
        assert.ok(visibleWidth(cut) <= w, `sliceColumns(${JSON.stringify(s)}, ${w}) draws ${visibleWidth(cut)}`);
        assert.equal(columnsOf(cut), visibleWidth(cut), `and measures what it draws: ${JSON.stringify(cut)}`);
        assert.ok(visibleWidth(clip(s, w)) <= w, `clip(${JSON.stringify(s)}, ${w}) draws ${visibleWidth(clip(s, w))}`);
        assert.equal(visibleWidth(pad(s, w)), w, `pad(${JSON.stringify(s)}, ${w})`);
      }
    }
  }
});

test("a title and a divider are cut where they are drawn, after a space (#509)", async () => {
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");
  const styler = makeStyler(PLAIN_THEME);
  // U+065F and U+093E draw a column each after a space and, with U+302E, nothing at a string's start, so a
  // title clipped at column 0 fitted a budget it overran once drawn after the frame's space: an 8-column
  // box drew its top line at 9.
  const repro = String.fromCodePoint(0x065f, 0x093e, 0x302e, 0x1f1f8);
  for (const line of [...box({ title: repro, width: 8 }), ...frame(styler, { title: repro, width: 8, lines: [] })]) {
    assert.equal(visibleWidth(line), 8, JSON.stringify(line));
  }
  // Every spacing mark, leading a title and a divider's label and meta. The divider is a frame body line,
  // so it is drawn after the frame's space and is held to its width there.
  let dividers = 0;
  for (const m of spacingMarks()) {
    for (const t of [m + m + "ab", m + String.fromCodePoint(0x093e, 0x302e, 0x1f1f8)]) {
      for (const w of [8, 9, 12]) {
        const panes = [
          ["box", box({ title: t, sections: [{ title: t, lines: [t] }], footer: t, width: w })],
          ["frame", frame(styler, { title: t, width: w, lines: [t], footer: t })],
        ];
        for (const [name, pane] of panes) {
          for (const line of pane) {
            assert.equal(visibleWidth(line), w, `${name} at ${w}: ${JSON.stringify(line)}`);
            assert.equal(columnsOf(line), w, `${name} at ${w}, our measure: ${JSON.stringify(line)}`);
          }
        }
        const d = styler.divider(t, t, w);
        assert.equal(visibleWidth(" " + d) - 1, w, `divider at ${w}: ${JSON.stringify(d)}`);
        dividers += 1;
      }
    }
    // A LABEL OR META LONG ENOUGH TO BE CUT, which is the only place measuring at column 0 cuts differently:
    // it keeps a run that draws nothing there and two columns after the space.
    const long = m + String.fromCodePoint(0x093e, 0x302e) + "abcdefgh";
    for (const w of [8, 9, 12]) {
      const d = styler.divider(long, null, w);
      assert.equal(visibleWidth(" " + d) - 1, w, `divider at ${w}: ${JSON.stringify(d)}`);
      // The META gives way first: a label that fits on its own is kept whole beside it.
      const kept = styler.divider("ab", long, w);
      assert.ok(kept.startsWith("AB "), `the label survives a long meta at ${w}: ${JSON.stringify(kept)}`);
      assert.equal(visibleWidth(" " + kept) - 1, w, `and the line is its width: ${JSON.stringify(kept)}`);
    }
  }
  assert.equal(dividers, 2832, "every spacing mark in both title shapes at three widths");
});
