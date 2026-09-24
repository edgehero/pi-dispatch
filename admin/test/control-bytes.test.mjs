import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { box, clip, clipData, columnsOf, hasControls, scrubControls } from "../src/panel.mjs";
import { frame, makeStyler, PLAIN_THEME, stripAnsi, visibleLen } from "../src/style.mjs";
import { renderRuns, renderTriggers } from "../src/render.mjs";

/** The TypeScript dashboard, through the loader the other suites use: `dashboard.ts` is not plain ESM. */
async function tsLoader() {
	const { createRequire } = await import("node:module");
	const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const { createJiti } = piRequire("jiti");
	return createJiti(import.meta.url);
}

// ONE CLASS, ONE OPERATION, and this file is where that claim is held (issue #382, item 1).
//
// Five copies of `[\u0000-\u001f\u007f-\u009f]` lived across four modules and did not agree about what to
// DO with a match: `cell` (render.mjs) and `cellOf` (dashboard.ts) SUBSTITUTE a space so a framed pane and a
// plain one clip identically -- and `cell`'s docblock says deleting instead "would make the panes clip
// differently" -- while the unframed degrade composed with `clip`, which DELETES. So it did. Two mutants
// flipping `cell` and `cellOf` to deletion were killed by the suite; nothing noticed a third renderer
// already deleting.

test("the class IS its rule, swept over every code point there is (#402)", () => {
	// A SWEEP BY THE RULE, and the rule is stated in terms of what the module says it DRAWS rather than by
	// restating the class's own expression. That distinction is the correction a review pass forced twice.
	// The first version was a hand-written list of 98, where this holds 4,024. The second stated the
	// rule as the same four Unicode categories the implementation used, which a reviewer pointed out can
	// only catch a typo, never a wrong rule -- and it was still wrong, leaving U+FFF0-U+FFF8 and U+2800,
	// which draws a blank cell. A third round found the largest miss of all, 3,760 code points, by noticing
	// that asking the width table alone is not asking the renderer: that table GUESSES one column for an
	// unassigned code point, which is the safe direction for a width and a miss for membership.
	//
	// `columnsOf` is the oracle here, and using it is not circular: issue #401 bolts it to the pinned
	// renderer over every code point there is, so it is an independently held answer to "what does this
	// draw", which is the only question this class actually asks.
	// EVERY mark, spacing marks included: issue #401 made those zero columns, so a narrower spelling here
	// would put the Indic vowel signs in the class.
	const composes = (ch) => ch === "\u200c" || ch === "\u200d" || /\p{M}/u.test(ch);
	const blankLike = (ch) => /\p{Zs}|\u2800/u.test(ch);
	const breaks = (ch) => /\p{Zl}|\p{Zp}/u.test(ch);
	const executes = (cp) => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
	let drawsNothing = 0;
	let blanks = 0;
	for (let cp = 0; cp <= 0x10ffff; cp++) {
		if (cp >= 0xd800 && cp <= 0xdfff) continue;
		// A TAG is settled by its SEQUENCE rather than by its code point, and is swept in its own test.
		if (cp >= 0xe0020 && cp <= 0xe007f) continue;
		const ch = String.fromCodePoint(cp);
		// Where the width table GUESSES. It answers one column for an unassigned code point, deliberately and
		// safely for a width, and that guess is a MISS for membership: the renderer draws U+2065 and the
		// special-purpose plane as nothing. Stated here as its own clause so the rule and the code agree
		// about why, not just about which.
		const invisibleUnassigned = cp === 0x2065 || (cp >= 0xe0000 && cp <= 0xe0fff);
		let inClass = executes(cp);
		if (!inClass && ch !== " " && !composes(ch)) {
			// A break is read as a break whatever it draws, which is why it is not a width question.
			if (breaks(ch)) {
				inClass = true;
			} else if (columnsOf(ch) === 0 || invisibleUnassigned) {
				inClass = true;
				drawsNothing += 1;
			} else if (blankLike(ch) && columnsOf(ch) === 1) {
				inClass = true;
				blanks += 1;
			}
		}
		assert.equal(hasControls(`a${ch}b`), inClass, `U+${cp.toString(16).toUpperCase().padStart(4, "0")}: membership`);
		assert.equal(scrubControls(`a${ch}b`), inClass ? "a b" : `a${ch}b`, `U+${cp.toString(16).toUpperCase().padStart(4, "0")}: what is done with it`);
	}
	// Both non-executing arms are real, so neither clause is quietly dead.
	// Both counts are pinned rather than merely non-zero, so the class cannot quietly grow or shrink: 85
	// code points draw as nothing: the format characters, the bidi controls, the fillers, and the two
	// unassigned regions the renderer draws as nothing where the width table guesses one column. 16 are
	// blanks a reader cannot tell from a space. With the 65 a terminal executes and the two line breaks
	// that is 3,928, and the tag block adds 96 more, settled by sequence below.
	assert.equal(drawsNothing, 3845, `the draws-nothing arm covers ${drawsNothing} code points`);
	assert.equal(blanks, 16, `the blank-like arm covers ${blanks}`);
	// U+3000 is the stated exclusion: a full-width space is TWO columns and ordinary Japanese text.
	assert.equal(hasControls("a\u3000b"), false, "an ideographic space is content, not a control");
	// `hasControls` must answer the same twice: the old implementation was a `/g` regex carrying lastIndex.
	const dirty = "a\u0007b";
	assert.equal(hasControls(dirty), true);
	assert.equal(hasControls(dirty), true, "and it answers the same the second time");
});

test("a tag composes a subdivision flag and deceives anywhere else (#402)", () => {
	// THE ONE CODE POINT CLASS THAT IS BOTH, so it is the one the class settles by SEQUENCE. After U+1F3F4
	// a tag builds a flag; anywhere else it is invisible text, and a run of them is a whole ASCII message
	// at zero columns.
	const flag = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
	assert.equal(scrubControls(flag), flag, "a flag sequence survives whole");
	assert.equal(scrubControls(`job${flag}id`), `job${flag}id`, "including inside other text");
	assert.equal(scrubControls("job\u{e0041}\u{e0042}id"), "job  id", "and a bare tag run is substituted");
	assert.equal(scrubControls(`${flag}\u200b`), `${flag} `, "a flag does not exempt what follows it");
	for (let cp = 0xe0020; cp <= 0xe007f; cp++) {
		const ch = String.fromCodePoint(cp);
		assert.equal(hasControls(`a${ch}b`), true, `U+${cp.toString(16).toUpperCase()} outside a flag`);
	}

	// THE EXEMPTION IS A VALIDITY CHECK, NOT A PREFIX, and this is the assertion that says so. A first
	// version exempted "a tag preceded by the base and any number of tags", which exempts every tag FOREVER
	// AFTER a flag -- cancel tag included -- so one legitimate flag emoji anywhere in a model-writable field
	// restored the whole hazard. A review pass recovered `rm -rf /` verbatim from a drawn line that way.
	const hide = (msg) => [...msg].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
	const payload = hide("rm -rf /");
	assert.notEqual(scrubControls(`\u{1f3f4}${payload}`), `\u{1f3f4}${payload}`, "a base plus a tag run is not a flag, so the run is substituted");
	assert.notEqual(scrubControls(`${flag}${payload}`), `${flag}${payload}`, "and a COMPLETE flag does not exempt the run after it");
	assert.ok(scrubControls(`${flag}${payload}`).startsWith(flag), "while the flag itself still survives");
	// A run longer than any real subdivision is not a flag either.
	const tooLong = `\u{1f3f4}${hide("abcdefgh")}\u{e007f}`;
	assert.notEqual(scrubControls(tooLong), tooLong, "a tag run longer than a subdivision code is not a flag");

	// EVERY TAG OUTSIDE A COMPLETE SEQUENCE GOES, asserted rather than "the result differs". A review pass
	// showed what `notEqual` alone buys: making the cancel tag optional left a SIX-character hidden message
	// whole, and the assertion above was satisfied by the eight-character one being partly substituted.
	for (const around of [`\u{1f3f4}${payload}`, `${flag}${payload}`, `${payload}${flag}`, `a${payload}b`]) {
		const scrubbed = scrubControls(around);
		const tags = [...scrubbed].filter((c) => c.codePointAt(0) >= 0xe0020 && c.codePointAt(0) <= 0xe007f);
		const kept = around.includes(flag) ? 6 : 0; // the six a complete flag is allowed to keep
		assert.equal(tags.length, kept, `tags surviving in ${JSON.stringify(around)}`);
	}
	// AND A FLAG IS NOT DUPLICATED OR ALLOWED TO EAT WHAT SITS BETWEEN TWO OF THEM, which is what dropping
	// the match-at-this-position guard did: `base tagA tagB base tagC cancel` came back as the second flag
	// twice, with the bytes between them gone.
	const twoBases = `\u{1f3f4}${hide("ab")}\u{1f3f4}${hide("gbeng")}\u{e007f}`;
	const out = scrubControls(twoBases);
	assert.equal([...out].filter((c) => c.codePointAt(0) === 0x1f3f4).length, 2, "both bases survive as themselves");
	assert.ok(out.endsWith(`\u{1f3f4}${hide("gbeng")}\u{e007f}`), "the valid flag is kept whole at the end");
	assert.equal([...out].filter((c) => c.codePointAt(0) >= 0xe0020 && c.codePointAt(0) <= 0xe007f).length, 6, "and only its own tags survive");
});

test("the width table's guess is not the class's answer (#402)", () => {
	// THE THIRD ROUND'S BLOCKER. Asking `columnsOf` alone reads like "ask the renderer" and is not: issue
	// #401 pins that table as never NARROWER than the renderer and it deliberately answers ONE for an
	// unassigned code point, which is the safe direction for a width and a MISS for membership. 3,760 code
	// points the renderer draws as nothing were outside the class, a hidden-ASCII channel 39 times the size
	// of the tag block this file builds a sequence matcher for.
	const hidden = [...("rm -rf /")].map((c) => String.fromCodePoint(0xe0080 + c.charCodeAt(0) - 32)).join("");
	assert.equal(columnsOf(hidden), 8, "the width table guesses one column each, which is why it cannot decide this");
	assert.equal(scrubControls(`job${hidden}id`), `job${"        "}id`, "and every one of them is substituted anyway");
	for (const cp of [0x2065, 0xe0000, 0xe0002, 0xe001f, 0xe0080, 0xe00ff, 0xe01f0, 0xe0fff]) {
		const ch = String.fromCodePoint(cp);
		assert.equal(hasControls(`a${ch}b`), true, `U+${cp.toString(16).toUpperCase()} is invisible at the renderer`);
	}
	// The variation selectors inside the same plane are MARKS, and stay out for the composing reason.
	assert.equal(hasControls("a\u{e0100}b"), false, "a variation selector composes, even in that plane");
});

test("clipData substitutes and then clips, so width is what the operator sees", () => {
	assert.equal(clipData("a\u0001b", 10), "a b", "one byte, one column");
	assert.equal(clip("a\u0001b", 10), "ab", "while clip itself still deletes, which panel.test.mjs pins");
	assert.equal(clipData("abcdefghij", 5), "abcd…", "and it still clips");
});

test("the plain `renderRuns` pane substitutes a record's bytes rather than deleting them", () => {
	// ONE of the three renderers, named as such: the framed and degraded twins of this record are driven in
	// dashboard.test.mjs, where the dashboard lives. The defect was that the same record rendered three
	// ways -- framed "a b . c d", degraded "ab . cd", plain "a b     c d".
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

test("a divider fits its width even when its meta cannot", () => {
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

test("a frame's title SUBSTITUTES, and so does the monochrome box's", () => {
	// `frame` (coloured) and `box` (monochrome) draw the same geometry for the same pane, and their titles
	// went through different operations: `clipPlain` substituted, `clip` deleted. The same dirty title then
	// sat one column narrower in one of them. Both live: `box` draws the tail's capability-absent and
	// missing-log frames.
	const styler = makeStyler(PLAIN_THEME);
	const title = "run Q\u0001Z";
	const framed = frame(styler, { title, width: 40, lines: ["x"], footer: "f" })[0];
	const boxed = box({ title, sections: [["x"]], width: 40 })[0];
	assert.match(framed, /run Q Z/, "the coloured frame substitutes");
	assert.match(boxed, /run Q Z/, "and the monochrome box now does too, instead of deleting");
	assert.doesNotMatch(boxed, /run QZ/);
});

test("a divider cuts its META first, keeping the LABEL, and measures what it prints", () => {
	// Two rules, and each hid the other: with the label cut first a narrow divider still fits its width, so
	// a width-only assertion passes while the operator loses the name of the section. And the meta is
	// measured after the strip, so a label carrying a control byte used to mis-measure by a column.
	const styler = makeStyler(PLAIN_THEME);
	for (const w of [20, 30, 46]) {
		const out = styler.divider("SPEND", "x".repeat(60), w);
		assert.ok(visibleLen(out) <= w, `width ${w}: ${visibleLen(out)} columns`);
		assert.match(out, /SPEND/, `width ${w}: the label survives; the meta is what gets cut`);
	}
	// WIDTH AND BYTES, for the reason the frame assertion gives: the substitution is 1:1, so a divider that
	// never scrubbed still measures the same -- it just prints the byte. Width alone cannot see that.
	const dirty = styler.divider("S\u0007PEND", "m\u009bx", 40);
	assert.equal(visibleLen(dirty), visibleLen(styler.divider("S PEND", "m x", 40)), "a dirty label measures as what it prints");
	assert.doesNotMatch(dirty, /[\u0000-\u001f\u007f-\u009f]/, "and prints no control byte, in the label or the meta");
});

test("every migrated cell asks the theme for its colour instead of pre-colouring its text", () => {
	// `cell` strips ANSI before measuring now, so a site reverted to `cell(fg("dim", x), w)` still comes out
	// the right WIDTH -- it just comes out uncoloured. Width tests cannot see that, so the theme is a spy.
	const asked = [];
	const styler = makeStyler({ ...PLAIN_THEME, fg: (c, t) => { asked.push(c); return t; } });
	styler.cell("text", 10, { color: "dim" });
	assert.deepEqual(asked, ["dim"], "the cell asks the theme for the colour, AFTER laying the text out");

	// And the five migrated sites, by SHAPE. Stated as the limit it is: this reads the source, so it catches
	// the reversion it names and nothing subtler. The behavioural half cannot see it -- a reverted site is
	// still exactly `width` columns, because `cell` strips the colour it was handed, so every width
	// assertion in this file passes while the pane quietly loses its dim.
	const src = readFileSync(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)), "utf8");
	assert.equal(/styler\.cell\(\s*styler\.fg\(/.test(src), false, "no site hands `cell` pre-coloured text");
});

test("a cut never leaves half a surrogate pair behind", () => {
	// `clip` slices UTF-16 CODE UNITS, so a cut that lands between the halves of an astral character used to
	// emit a lone high surrogate -- not a character at all, and U+FFFD at best on the way to the terminal.
	// Measured through the real `/dispatch logs` viewer on a log of emoji. Dropping the orphan costs one
	// column; widening the cut instead would break the width promise.
	const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
	const line = "a".repeat(3) + "\u{1f600}".repeat(40);
	for (let w = 1; w <= 30; w++) {
		for (const out of [clip(line, w), clipData(line, w)]) {
			assert.doesNotMatch(out, lone, `width ${w}: a half pair reached the output`);
			assert.ok(out.length <= w, `width ${w}: and the bound still holds`);
		}
	}
});

test("a framed line is EXACTLY the frame's width, dirty content included", () => {
	// The measurement and the substitution have to happen in that order, and this is the assertion that
	// says so: a control byte becomes a SPACE, which is a column, while `stripAnsi` counts it as nothing.
	// Scrubbing after the frame measured would make a dirty line one column wider than its own border.
	// WIDTH AND BYTES TOGETHER, because either alone is satisfied by the wrong code: the substitution is
	// 1:1, so a line scrubbed after being measured still comes out the right width -- it just comes out
	// carrying a live escape. `frame` is the gate for its own body lines, and this is the claim.
	const styleTokens = /\u001b\[[0-9;]*m/g;
	const styler = makeStyler(PLAIN_THEME);
	const dirty = "job \u0007id \u001b[2J and \u009b more";
	for (const w of [20, 40, 80]) {
		for (const line of frame(styler, { title: dirty, width: w, lines: [dirty, styler.cell(dirty, w - 4)], footer: dirty })) {
			assert.equal(visibleLen(line), w, `width ${w}: ${JSON.stringify(line)}`);
			assert.doesNotMatch(String(line).replace(styleTokens, ""), /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/, `width ${w}: a live escape survived the frame`);
		}
	}
});

test("a frame measures AFTER it substitutes, which an OSC-8-shaped run is the only way to see", () => {
	// The two orders differ only for a sequence the MEASURER and the GATE disagree about. `stripAnsi` still
	// recognises an OSC-8 shape and counts it as zero columns; the gate substitutes it, so it becomes real
	// columns. Scrub after measuring and the frame believes a line is 36 columns while the terminal paints
	// 46. Every other dirty fixture is 1:1 under both orders, which is why this mutation survived a sweep
	// that had no link-shaped payload in it.
	const styler = makeStyler(PLAIN_THEME);
	const link = "\u001b]8;;a\u001bZb\u0007";
	for (const w of [40, 60]) {
		for (const line of frame(styler, { title: "t", width: w, lines: ["x" + link], footer: "f" })) {
			assert.equal(visibleLen(line), w, `width ${w}: ${JSON.stringify(line)}`);
		}
	}
});

test("every cutter drops a half surrogate, not just `clip`", () => {
	// `clip` was repaired first and three other cutters slice the same UTF-16 units: `styler.cell`,
	// `styler.divider`'s two halves and the frame title's `clipPlain`. Through the real framed LIST that was
	// 89 lines printing a lone high surrogate from a target of emoji.
	const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
	const styler = makeStyler(PLAIN_THEME);
	const text = "aaa" + "\u{1f600}".repeat(20);
	for (let w = 2; w <= 30; w++) {
		assert.doesNotMatch(styler.cell(text, w), lone, `cell at ${w}`);
		// The two halves are cut by different arithmetic and the meta is cut FIRST, so a fixture that makes
		// both halves long lets the label clip hide whatever the meta clip did. One short, one long, both ways.
		assert.doesNotMatch(styler.divider("S", text, w), lone, `divider meta at ${w}`);
		assert.doesNotMatch(styler.divider(text, "m", w), lone, `divider label at ${w}`);
		assert.doesNotMatch(styler.divider(text, text, w), lone, `divider both at ${w}`);
		for (const line of frame(styler, { title: text, width: w, lines: ["x"], footer: "f" })) {
			assert.doesNotMatch(line, lone, `frame title at ${w}`);
		}
	}
});

test("the class draws its line at INTERPRETED against COMPOSING (#402)", () => {
	// THE RULE, not the list, because a list is what the carve-out in #382 was and it was wrong twice. A code
	// point is in the class when a terminal or a reader INTERPRETS it -- as an escape, a reordering, or a
	// break -- and out of it when it COMPOSES the character beside it.
	const INTERPRETED = [
		["U+202E right-to-left override", "‮"],
		["U+202D left-to-right override", "‭"],
		["U+2066 left-to-right isolate", "⁦"],
		["U+2069 pop directional isolate", "⁩"],
		["U+061C arabic letter mark", "؜"],
		["U+200E left-to-right mark", "‎"],
		["U+200F right-to-left mark", "‏"],
		["U+200B zero width space", "​"],
		["U+2060 word joiner", "⁠"],
		["U+FEFF byte order mark", "﻿"],
		["U+00AD soft hyphen", "­"],
		["U+180E mongolian vowel separator", "᠎"],
		["U+2028 line separator", " "],
		["U+2029 paragraph separator", " "],
		["U+FFF9 interlinear annotation anchor", "￹"],
		["U+FFF0 noncharacter, which this file's own width table calls invisible", "￰"],
		["U+2800 braille blank, which draws a blank cell", "⠀"],
		["U+00A0 no-break space", " "],
		["U+2007 figure space", " "],
	];
	const COMPOSING = [
		["U+200D zero width joiner", "‍"],
		["U+200C zero width non-joiner", "‌"],
		["U+FE0F variation selector-16", "️"],
		["U+FE0E variation selector-15", "︎"],
		["U+0301 combining acute", "́"],
		["U+3000 ideographic space, two columns and ordinary Japanese text", "　"],
	];
	for (const [name, ch] of INTERPRETED) {
		assert.equal(hasControls(`a${ch}b`), true, `${name} is interpreted, so it is in the class`);
		assert.equal(scrubControls(`a${ch}b`), "a b", `${name} becomes one space`);
	}
	for (const [name, ch] of COMPOSING) {
		assert.equal(hasControls(`a${ch}b`), false, `${name} composes, so it is not in the class`);
		assert.equal(scrubControls(`a${ch}b`), `a${ch}b`, `${name} passes through untouched`);
	}
});

test("widening the class does not break a glyph it was not meant to touch (#402)", () => {
	// THE COST OF GETTING THE BOUNDARY WRONG, asserted from the other side. A class that swept up every
	// zero-width code point would split a family emoji into three and drop the emoji form of a heart, which
	// is changing a CHARACTER rather than revealing a CONTROL.
	const family = "\u{1f468}‍\u{1f469}‍\u{1f466}";
	assert.equal(scrubControls(family), family, "a family emoji survives whole");
	assert.equal(scrubControls("❤️"), "❤️", "and so does the emoji form of a heart");
	assert.equal(columnsOf(scrubControls("❤️")), 2, "which still measures as the glyph it is");
	// Persian orthography, where the non-joiner is the spelling rather than a control.
	assert.equal(scrubControls("می‌خواهم"), "می‌خواهم", "a non-joiner inside a word is content");
});

test("a bidi override cannot make a record read as something else (#402)", () => {
	// THE REPRODUCTION FROM THE ISSUE. A target ending in an override plus `gnp.txt` is drawn as a name
	// ending in `.png`, and a run record is what an operator reads before deciding what to do about it.
	const target = "acme/repo‮gnp.txt";
	assert.equal(scrubControls(target), "acme/repo gnp.txt", "the override becomes a space and the tail reads forwards");
	assert.doesNotMatch(clipData(target, 40), /[‪-‮⁦-⁩]/u, "and no reordering control reaches the pane");
});

test("two identifiers that draw alike cannot stay distinct through the gate (#402)", () => {
	// THE SELECTION HAZARD. `deploy-prod` and `deploy` + U+200B + `-prod` are eleven columns each and are
	// not the same string, so a picker that selects by the string can act on the row the operator did not
	// mean. Substituting makes the difference visible, which is the only honest answer available: the panel
	// cannot know which of the two was intended.
	const plain = "deploy-prod";
	const hidden = "deploy​-prod";
	assert.notEqual(plain, hidden, "the fixture is two different strings");
	assert.equal(columnsOf(plain), columnsOf(hidden), "which today draw the same width");
	assert.notEqual(scrubControls(plain), scrubControls(hidden), "and after the gate they no longer look alike");
});

test("the tail search finds the line the pane draws (#402)", async () => {
	// A REGRESSION THIS CHANGE INTRODUCED AND A REVIEW PASS MEASURED. The pane substitutes the class, the
	// search box DELETES it from what the operator types, and the haystack used to be the raw bytes. Once
	// the class held the invisible characters that real log output carries, a line drawn as `repo -prod`
	// could be found by NO query: what is on screen missed the raw byte, and the original missed because
	// the box had dropped it. Both sides are scrubbed now, so what is read is what can be searched.
	const { makeLineInput } = await import("../src/panel.mjs");
	const jiti = await tsLoader();
	const { tailMatches } = await jiti.import("../src/dashboard.ts");
	const lines = ["pulled:acme/repo​-prod:ok", "unrelated line", "pulled:acme/other:ok"];
	// What the operator sees, typed back in. The editor drops the invisible byte from the query, exactly as
	// it does for anything an operator pastes.
	const typed = makeLineInput("");
	typed.insert("repo -prod");
	assert.deepEqual(tailMatches(lines, typed.value()), [0], "typing what is drawn finds it");
	// And the original bytes, pasted, still find it: the haystack is scrubbed, so both spellings land.
	const pasted = makeLineInput("");
	pasted.insert("repo​-prod");
	assert.deepEqual(tailMatches(lines, pasted.value()), [0], "pasting the original finds it too");
	assert.deepEqual(tailMatches(lines, "nothing here"), [], "and a miss is still a miss");
});
