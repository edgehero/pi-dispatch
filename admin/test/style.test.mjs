import assert from "node:assert/strict";
import { test } from "node:test";
import { makeStyler, frame, RULE, PLAIN_THEME, stripAnsi, visibleLen } from "../src/style.mjs";
import { sparkline, fmtCost, makeLineInput, LINE_INPUT_CURSOR, GLYPHS } from "../src/panel.mjs";

// A theme whose fg/bold/inverse emit REAL SGR (so the module's stripAnsi recovers the visible text) and
// RECORD every (color,text) request, so we can assert both the width invariant and the color choices.
function spyTheme() {
  const calls = [];
  return {
    calls,
    fg(color, text) {
      calls.push({ color, text });
      return `\x1b[38;5;42m${text}\x1b[39m`;
    },
    bold(text) {
      return `\x1b[1m${text}\x1b[22m`;
    },
    inverse(text) {
      return `\x1b[7m${text}\x1b[27m`;
    },
    bg: (_c, t) => t,
  };
}

test("stripAnsi / visibleLen recover the visible column count through SGR", () => {
  const colored = "\x1b[38;5;42mhi\x1b[39m";
  assert.equal(stripAnsi(colored), "hi");
  assert.equal(visibleLen(colored), 2);
});

test("cell pads plain text to exactly `width` columns; color does NOT change the visible width", () => {
  const plainStyler = makeStyler(PLAIN_THEME);
  assert.equal(plainStyler.cell("hi", 6), "hi    "); // padEnd on plain text
  assert.equal(visibleLen(plainStyler.cell("hi", 6)), 6);

  const colorStyler = makeStyler(spyTheme());
  const c = colorStyler.cell("hi", 6, { color: "accent" });
  assert.equal(visibleLen(c), 6, "colored cell still measures 6 visible columns");
  assert.equal(stripAnsi(c), "hi    ", "plain content and padding are unchanged under color");
  assert.notEqual(c, "hi    ", "color was actually applied");
});

test("cell clips over-long text with an ellipsis, still exactly `width`", () => {
  const s = makeStyler(PLAIN_THEME);
  assert.equal(s.cell("abcdefgh", 5), "abcd…");
  assert.equal(visibleLen(s.cell("abcdefgh", 5)), 5);
});

test("cell right-aligns when asked", () => {
  const s = makeStyler(PLAIN_THEME);
  assert.equal(s.cell("7", 4, { align: "right" }), "   7");
});

test("meter is exactly `width` columns, colored by state, with the bar + label", () => {
  const s = makeStyler(spyTheme());
  for (const [reserved, cap, state] of [[6, 25, "ok"], [18, 20, "soft-hold"], [30, 25, "over"]]) {
    const m = s.meter(reserved, cap, 40, state);
    assert.equal(visibleLen(m), 40, `meter ${reserved}/${cap} must be 40 columns`);
    assert.match(stripAnsi(m), new RegExp(`${reserved}/${cap}`));
    assert.match(stripAnsi(m), /\[█*░*\]/);
  }
  // the state color drives the fill/label color: over -> error, soft-hold -> warning, ok -> success
  const spy = spyTheme();
  makeStyler(spy).meter(30, 25, 40, "over");
  assert.ok(spy.calls.some((c) => c.color === "error"), "over-budget meter uses the error color");
});

test("meter with an unknown cap renders the 'cap unknown' note at `width`", () => {
  const s = makeStyler(PLAIN_THEME);
  const m = s.meter(5, null, 40, "ok");
  assert.equal(visibleLen(m), 40);
  assert.match(stripAnsi(m), /5 \/ \? \(cap unknown\)/);
});

test("divider fills exactly `width` with a rule and optional right-side meta", () => {
  const s = makeStyler(PLAIN_THEME);
  const d = s.divider("spend", "jobs started", 50);
  assert.equal(visibleLen(d), 50);
  const plain = stripAnsi(d);
  assert.match(plain, /^SPEND ─+ jobs started$/);
});

test("frame: every line is exactly `width` visible columns, borders included", () => {
  const s = makeStyler(spyTheme());
  const inner = 40 - 4;
  const lines = [s.cell("STATUS", inner, { color: "muted", strong: true }), RULE, s.cell("Queue: running", inner)];
  const framed = frame(s, { title: "pi-dispatch", width: 40, lines, footer: s.cell("[q]uit", inner) });
  for (const line of framed) {
    assert.equal(visibleLen(line), 40, `framed line must be 40 columns: ${JSON.stringify(stripAnsi(line))}`);
  }
  // top/bottom corners + a separator rule present (after stripping color)
  assert.match(stripAnsi(framed[0]), /^┌─ pi-dispatch ─+┐$/);
  assert.match(stripAnsi(framed.at(-1)), /^└─+┘$/);
  assert.ok(framed.some((l) => /^├─+┤$/.test(stripAnsi(l))), "a separator rule is present");
});

test("frame degrades to plain glyphs under PLAIN_THEME but keeps the same geometry", () => {
  const s = makeStyler(PLAIN_THEME);
  const inner = 30 - 4;
  const framed = frame(s, { title: "x", width: 30, lines: [s.cell("hi", inner)] });
  for (const line of framed) assert.equal(line.length, 30); // no ANSI, so .length === visible width
});

test("makeStyler ascii option swaps frame/meter/divider glyphs with identical geometry", () => {
  const s = makeStyler(PLAIN_THEME, { ascii: true });
  const framed = frame(s, { title: "x", width: 30, lines: [s.cell("hi", 26)], footer: s.cell("f", 26) });
  for (const line of framed) assert.equal(line.length, 30, "the ASCII frame keeps the exact geometry");
  assert.match(framed[0], /^\+- x -+\+$/);
  assert.match(framed.at(-1), /^\+-+\+$/);
  assert.doesNotMatch(framed.join("\n"), /[─│┌┐├┤└┘]/, "no box-drawing glyph leaks through");
  assert.match(s.meter(3, 10, 24), /#/);
  assert.doesNotMatch(s.meter(3, 10, 24), new RegExp(GLYPHS.full));
  assert.equal(visibleLen(s.divider("a", "", 20)), 20);
  assert.doesNotMatch(s.divider("a", "", 20), new RegExp(GLYPHS.h));
  assert.equal(s.cell("abcdefgh", 5), "ab...", "the 3-char ellipsis still lands on exactly width");
});

test("the graph glyphs (issue #54) keep key parity and identical widths across both tables", () => {
  // Width-identical twins are the contract: a graph row's padding math must not depend on which
  // table is active, or the 80-col invariant breaks only for ASCII terminals -- the least debuggable
  // place for it to break.
  const box = makeStyler(PLAIN_THEME).glyphs;
  const ascii = makeStyler(PLAIN_THEME, { ascii: true }).glyphs;
  assert.deepEqual(Object.keys(ascii).sort(), Object.keys(box).sort(), "key parity between the twin tables");
  for (const key of ["arrowRight", "foldOpen", "foldClosed", "rearm"]) {
    assert.ok(typeof box[key] === "string" && box[key].length > 0, key);
    assert.equal(ascii[key].length, box[key].length, `${key}: twin widths must match`);
  }
  assert.doesNotMatch(Object.values(ascii).join(""), /[─│┌┐├┤└┘▾▸↻▶]/, "no non-ASCII glyph leaks into the ascii table");
});

test("styler.sparkline under PLAIN_THEME is byte-identical to the plain sparkline", () => {
  const s = makeStyler(PLAIN_THEME);
  const values = [0, 1, null, 4, 2];
  assert.equal(s.sparkline(values, 10), sparkline(values, 10));
  assert.equal(s.sparkline(values, 10, { max: 8 }), sparkline(values, 10, { max: 8 }));
  assert.equal(s.sparkline(values, 10, { max: 8, warnAbove: 2 }), sparkline(values, 10, { max: 8 }), "warnAbove is color-only, never geometry");
  assert.equal(s.sparkline([null, null], 10), sparkline([null, null], 10), "the no-data path stays plain");
});

test("styler.sparkline colors cells by warnAbove without touching the geometry", () => {
  const spy = spyTheme();
  const s = makeStyler(spy);
  const values = [1, 5, null];
  const out = s.sparkline(values, 6, { max: 5, warnAbove: 4 });
  const plain = sparkline(values, 6, { max: 5 });
  assert.equal(visibleLen(out), plain.length, "color adds nothing to the visible width");
  assert.equal(stripAnsi(out), plain, "the plain cells are unchanged under color");
  assert.ok(spy.calls.some((c) => c.color === "warning"), "the cell at/above warnAbove is a warning");
  assert.ok(spy.calls.some((c) => c.color === "accent"), "the cell below warnAbove is accent");
  assert.ok(spy.calls.some((c) => c.color === "dim"), "the gap is dim");
});

test("styler.fmtCost colors per class and keeps the plain twin's geometry", () => {
  const metered = { usd: 4.12, class: "metered" };
  assert.equal(makeStyler(PLAIN_THEME).fmtCost(metered), fmtCost(metered), "PLAIN passthrough is byte-identical");
  const spy = spyTheme();
  const colored = makeStyler(spy).fmtCost(metered);
  assert.equal(stripAnsi(colored), fmtCost(metered));
  assert.equal(visibleLen(colored), fmtCost(metered).length);
  for (const [cost, color] of [
    [metered, "text"],
    [{ class: "plan", planId: "max-5x" }, "accent"],
    [{ usd: 0, class: "zero-rated" }, "dim"],
    [{ usd: 1, class: "estimated" }, "warning"],
    [{ usd: 1, class: "seeded" }, "warning"],
    [{ class: "unknown" }, "dim"],
    [null, "dim"],
  ]) {
    const perSpy = spyTheme();
    makeStyler(perSpy).fmtCost(cost);
    assert.ok(perSpy.calls.some((c) => c.color === color), `${cost?.class ?? "malformed"} colors ${color}`);
  }
  const celled = makeStyler(spy).fmtCost(metered, 12);
  assert.equal(visibleLen(celled), 12, "an explicit width renders as a fixed cell");
  assert.equal(stripAnsi(celled), fmtCost(metered).padEnd(12));
});

test("styler.lineInput paints the cursor cell inverse at exactly the render width", () => {
  const spy = spyTheme();
  const li = makeLineInput("abc");
  const out = makeStyler(spy).lineInput(li, 6);
  assert.equal(visibleLen(out), 6);
  assert.match(out, /\x1b\[7m/, "the cursor cell is inverse video");
  assert.equal(stripAnsi(out), "abc   ", "plain content and padding are unchanged");
  assert.ok(!out.includes(LINE_INPUT_CURSOR[0]) && !out.includes(LINE_INPUT_CURSOR[1]), "no sentinel byte survives into the colored render");
  const plain = makeStyler(PLAIN_THEME).lineInput(li, 6);
  assert.equal(plain, "abc   ", "PLAIN_THEME degrades to the sentinel-free plain render");
  const windowed = makeStyler(spy).lineInput(makeLineInput("abcdefghij"), 6);
  assert.equal(visibleLen(windowed), 6, "a scrolled window keeps the exact width");
});

test("styler.link is a plain passthrough under PLAIN_THEME and an OSC-8 hyperlink under a real theme", () => {
  const plain = makeStyler(PLAIN_THEME);
  assert.equal(plain.link("runs", "https://example.test/runs"), "runs", "no escape bytes in plain output");
  const linked = makeStyler(spyTheme()).link("runs", "https://example.test/runs");
  assert.equal(linked, "\x1b]8;;https://example.test/runs\x07runs\x1b]8;;\x07");
  assert.equal(visibleLen(linked), 4, "the OSC-8 wrapper is invisible to width math");
  assert.equal(stripAnsi(linked), "runs");
});
