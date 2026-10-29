import { test } from "node:test";
import assert from "node:assert/strict";
import { activeProgressProblems, runVerdict, VIEWPORT, PROBE_WIDTH } from "../../.github/scripts/console-width-check.mjs";

const cell = { left: 32, right: 343, top: 100, bottom: 180 };
const part = (name, rect, clipped = false) => ({ name, rect, clipped });
const inside = { left: 32, right: 343, top: 100, bottom: 160 };
const action = { left: 280, right: 343, top: 190, bottom: 222 };

test("the browser progress oracle accepts a contained phase list above its separate action row", () => {
	assert.deepEqual(activeProgressProblems([{ row: 1, cell, action, parts: [part("progress", inside), part("phase bar", { left: 100, right: 180, top: 110, bottom: 122 })] }]), []);
});

test("a phase escaping its fitting parent and an orphan crossing its action both fail even with a fitting viewport", () => {
	const rows = [{ row: 2, cell, action: { left: 280, right: 343, top: 150, bottom: 182 }, parts: [part("progress", inside), part("phase bar", { left: 200, right: 365, top: 120, bottom: 132 })] }];
	const failures = activeProgressProblems(rows);
	assert.ok(failures.includes("Fleet Active row 2: phase bar leaves its progress cell"));
	assert.ok(failures.includes("Fleet Active row 2: progress overlaps its action"));
	const verdict = runVerdict({ csp: [], canvas: "#fff", want: "#fff", expect: "light", measured: { scrollWidth: VIEWPORT.width, clientWidth: VIEWPORT.width, elements: [], activeProgress: rows }, emulation: { mobile: true, probed: PROBE_WIDTH } });
	assert.equal(verdict.width.ok, true);
	assert.ok(verdict.failures.some((failure) => failure.includes("progress overlaps its action")), "the full browser command treats local overlaps as failures independently of viewport width");
});

test("clipped progress content fails, touching edges do not, and pages without progress are unaffected", () => {
	assert.deepEqual(activeProgressProblems(), []);
	assert.deepEqual(activeProgressProblems([{ row: 1, cell, action: { left: 343, right: 375, top: 100, bottom: 160 }, parts: [part("progress", inside)] }]), []);
	assert.match(activeProgressProblems([{ row: 1, cell, action, parts: [part("phase list", inside, true)] }])[0], /clips its progress content/);
});
