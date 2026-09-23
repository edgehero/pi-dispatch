import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, clipData, hasControls, scrubControls } from "../src/panel.mjs";
import { frame, makeStyler, PLAIN_THEME, stripAnsi, visibleLen } from "../src/style.mjs";
import { renderRuns, renderTriggers } from "../src/render.mjs";

// ONE CLASS, ONE OPERATION, and this file is where that claim is held (issue #382, item 1).
//
// Five copies of `[\u0000-\u001f\u007f-\u009f]` lived across three modules and did not agree about what to
// DO with a match: `cell` (render.mjs) and `cellOf` (dashboard.ts) SUBSTITUTE a space so a framed pane and a
// plain one clip identically -- and `cell`'s docblock says deleting instead "would make the panes clip
// differently" -- while the unframed degrade composed with `clip`, which DELETES. So it did. Two mutants
// flipping `cell` and `cellOf` to deletion were killed by the suite; nothing noticed a third renderer
// already deleting.

test("the class covers C0, DEL and C1, and nothing else", () => {
	// A SWEEP rather than a handful of examples, because the boundary is the whole point: U+009B is a CSI
	// introducer that needs no ESC in front of it, so a class that stops at DEL leaves a working escape.
	for (let cp = 0; cp <= 0x17f; cp++) {
		const ch = String.fromCodePoint(cp);
		const control = cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
		assert.equal(hasControls(`a${ch}b`), control, `U+${cp.toString(16).padStart(4, "0")}: hasControls`);
		assert.equal(scrubControls(`a${ch}b`), control ? "a b" : `a${ch}b`, `U+${cp.toString(16).padStart(4, "0")}: scrubControls`);
		assert.equal(clip(`a${ch}b`, 10), control ? "ab" : `a${ch}b`, `U+${cp.toString(16).padStart(4, "0")}: clip still DELETES`);
	}
	// `hasControls` uses `search`, not `.test`: a `/g` regex carries `lastIndex` between calls, so the same
	// string would answer differently on the second ask.
	const dirty = "a\u0007b";
	assert.equal(hasControls(dirty), true);
	assert.equal(hasControls(dirty), true, "and it answers the same the second time");
});

test("clipData substitutes and then clips, so width is what the operator sees", () => {
	assert.equal(clipData("a\u0001b", 10), "a b", "one byte, one column");
	assert.equal(clip("a\u0001b", 10), "ab", "while clip itself still deletes, which panel.test.mjs pins");
	assert.equal(clipData("abcdefghij", 5), "abcd…", "and it still clips");
});

test("every renderer of one record substitutes the same way", () => {
	// THE DEFECT, as a table. One record with a control byte in two fields used to render three ways:
	// framed "a b . c d", degraded "ab . cd", plain "a b     c d".
	const run = { jobId: "a\u0001b", target: "c\u0001d", flow: "f", outcome: "done", turns: 1, tokens: { total: 1 } };
	const plain = renderRuns([run]);
	assert.match(plain, /a b/, "the plain pane substitutes");
	assert.match(plain, /c d/);
	assert.doesNotMatch(plain, /ab/, "and never deletes");
	for (const line of plain.split("\n")) assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/, "no control byte survives any renderer");
});

test("a scheduler key read back from the queue goes through the belt too", () => {
	// Defence in depth, named as such: the worker restricts a cron `on.id` to `[A-Za-z0-9._-]+` before the
	// upsert, so a key arriving with a control byte came from a writer that is not the worker (issue #382,
	// item 2). The pane it lands in is a "config" pane, which is exactly why the carve-out had to be drawn
	// by PROVENANCE rather than by pane.
	const out = renderTriggers({ triggers: [], schedulers: [{ key: "cron\u0001evil", next: 0 }] });
	assert.match(out, /cron evil/, "substituted, not deleted and not raw");
	// PER LINE, because the joined output is multi-line and `\n` is itself in the class this checks for.
	for (const l of out.split("\n")) assert.doesNotMatch(l, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/, "no control byte reaches a line");
});

test("styler.cell measures what it will print, and never cuts its own escape", () => {
	// It sliced the RAW string, so pre-coloured text spent its budget on SGR bytes: a 16-column cell came
	// out 6 columns wide, and at the widths inside MIN_WIDTH the slice landed mid-sequence and emitted a
	// bare `ESC [ 3` with no terminator, which makes a terminal swallow the rest of the line as CSI
	// parameters (issue #382, item 3).
	const styler = makeStyler(PLAIN_THEME);
	const coloured = "\u001b[38;5;42msome text here\u001b[39m";
	for (const w of [4, 8, 10, 12, 16, 40]) {
		const out = styler.cell(coloured, w);
		assert.equal(visibleLen(out), w, `width ${w}: exactly ${w} visible columns`);
		assert.doesNotMatch(stripAnsi(out), /\u001b/, `width ${w}: no partial escape survives the strip`);
		assert.equal(/\u001b\[[0-9;]*$/.test(out), false, `width ${w}: nothing ends mid-sequence`);
	}
	// Colour already on the input is DROPPED, deliberately: keeping it needs an ANSI-aware slice and this
	// module does not import a TUI library to get one. Stated here so the trade is a pinned decision.
	assert.equal(stripAnsi(styler.cell(coloured, 40)).trimEnd(), "some text here");
});

test("a frame's body lines are exactly its inner width, even when one arrives too wide", () => {
	// `padVisible` only ever PADDED, so an over-wide line broke the right border instead of being clipped --
	// the spend "off" rows never fitted at narrow widths. The comparison is strictly greater, because `>=`
	// would send every already-fitting line through `cell` and strip its colour.
	const styler = makeStyler(PLAIN_THEME);
	for (const w of [24, 30, 46, 80]) {
		const out = styler.divider("SPEND", "x".repeat(60), w);
		assert.ok(visibleLen(out) <= w, `divider at ${w}: ${visibleLen(out)} columns`);
		assert.doesNotMatch(out, /\u001b\[[0-9;]*$/, "and never ends mid-sequence");
	}
});

test("a frame clips a body line that arrives wider than its inner width (#382)", () => {
	// `padVisible` only ever PADDED, so an over-wide line ran through the right border instead of being cut:
	// the spend "off" rows never fitted at narrow widths. Pinned here because the mutation that removes the
	// clip is invisible to every test that only feeds it lines which already fit.
	const styler = makeStyler(PLAIN_THEME);
	for (const w of [20, 32, 48]) {
		const out = frame(styler, { title: "T", width: w, lines: ["x".repeat(200)], footer: "f" });
		for (const line of out) assert.ok(visibleLen(line) <= w, `width ${w}: a body line ran to ${visibleLen(line)} columns`);
	}
});
