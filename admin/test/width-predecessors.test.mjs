import assert from "node:assert/strict";
import { test } from "node:test";
import { columnsOf } from "../src/panel.mjs";
import { loadVisibleWidth } from "./helpers/renderer.mjs";

// The predecessor sweep of issue #417, alone in its file: it asks the renderer about every character
// there is in four shapes, the longest single test in this workspace, and the test-count check caps each
// file.

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
