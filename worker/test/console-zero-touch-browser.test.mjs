import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { zeroTouchProblems, checkZeroTouchBrowser } from "../../.github/scripts/console-zero-touch-browser.mjs";

function measured(width = 1440, role = "operator") {
	const phone = width <= 760;
	return {
		css: true, fonts: "loaded", font: "system-ui, Arial", width, scrollWidth: width,
		rate: "18%", rateFont: 40, rateColor: "#111111", ink: "#111111", rateText: "38 of 214 runs; 2 stopped before they ran",
		spark: { label: "Rolling: 31%, 30%, 28%, 24%, 23%, 21%, 19%, 18%", height: 64, stroke: "#111111", ink: "#111111", goalColor: "#148749", goalExpected: "#148749", dashed: "4px, 4px" },
		legends: [17, 5, 7, 5, 3, 1].map((count) => ({ count, font: 13, height: 30 })),
		labels: [{ height: 14, color: "#111111", expected: "#111111" }],
		bars: [{ label: "Questions17: full scale38 touched runs", height: 28, rects: [{ color: "#8545ff", expected: "#8545ff", width: 280 }] }],
		meters: phone ? [] : [{ value: 16, goal: "12.5%", bed: 150, fill: 60, label: "16% of runs, goal under 5 percent" }],
		sections: (phone ? ["rate", "projects", "causes", "questions", "fixes"] : ["rate", "streak", "wait", "handled", "projects", "causes", "questions", "fixes"]).map((name, i) => ({ id: `p-zt-${name}`, top: i * 150 })),
		phoneProjects: phone, desktopProjects: !phone, phoneSummary: phone, project: { left: 24 }, fixes: { left: role === "viewer" ? 24 : 920, height: phone ? 150 : 400 },
		groups: role === "operator" ? Array.from({ length: 4 }, () => ({ actions: 1 })) : [], writeControls: role === "operator" ? 5 : 0,
		questionsText: role === "viewer" ? "Questions are for operators" : "Test command", actions: role === "operator" ? ["zero-touch-name"] : [],
		text: "Median wait for an answer34m; gh-2f6a; Answer rules #772",
	};
}

test("the Zero touch rendered verdict accepts complete phone/desktop reads for each role", () => {
	for (const role of ["operator", "viewer"]) for (const width of [320, 390, 800, 1024, 1440]) assert.deepEqual(zeroTouchProblems(measured(width, role), { width, role }), []);
});

test("visual counterexamples fail for chart labels, scale, colors, data, roles and complete phone sections", () => {
	const cases = [
		[(m) => m.labels[0].height = 7, "Chart count labels are too small or use the wrong foreground"],
		[(m) => m.labels[0].color = "#000000", "Chart count labels are too small or use the wrong foreground"],
		[(m) => m.bars[0].rects[0].color = "#ffffff", "Cause chart geometry, scale or palette changed"],
		[(m) => m.legends[0].count = 18, "The six readable causes no longer reconcile with 38 touched runs"],
		[(m) => m.spark.dashed = "none", "The rolling trend, its text equivalent or dashed goal is wrong"],
		[(m) => m.meters[0].goal = "5%", "Project meters lost their 40-percent scale or 5-percent goal tick"],
		[(m) => m.rate = "0%", "The rate's value, denominator or primary hierarchy changed"],
	];
	for (const [change, expected] of cases) { const m = measured(); change(m); assert.ok(zeroTouchProblems(m, { width: 1440, role: "operator" }).includes(expected), expected); }
	const phone = measured(390); phone.groups[0].actions = 2; phone.fixes.height = 800; [phone.sections[2], phone.sections[3]] = [phone.sections[3], phone.sections[2]]; phone.sections.forEach((r, i) => r.top = i * 150);
	const problems = zeroTouchProblems(phone, { width: 390, role: "operator" });
	assert.ok(problems.includes("Phone question rows expose several competing actions"));
	assert.ok(problems.includes("The phone's fixes summary is expanded into the desktop section"));
	assert.ok(problems.includes("Phone sections are not in rate, projects, causes, questions, fixes order"));
	const viewer = measured(1440, "viewer"); viewer.fixes.left = 920; viewer.writeControls = 1;
	assert.deepEqual(zeroTouchProblems(viewer, { width: 1440, role: "viewer" }), ["The viewer's fixes are outside the wide project column", "The viewer received question groups or write controls"]);
});

test("the helper fails loudly when a required fixture is missing, and the width run actually invokes it", async () => {
	const results = await checkZeroTouchBrowser({ docs: [], openPage: () => assert.fail("no page can be opened without its fixture") });
	assert.ok(results.length >= 20);
	assert.ok(results.every((r) => r.failures.length === 1 && r.failures[0].includes("fixture is absent")));
	const source = readFileSync(new URL("../../.github/scripts/console-width-check.mjs", import.meta.url), "utf8");
	assert.match(source, /import \{ checkZeroTouchBrowser \} from "\.\/console-zero-touch-browser\.mjs"/);
	assert.match(source, /results\.push\(\.\.\.await checkZeroTouchBrowser\(\{ browser, docs, origin, openPage, clockMs, shots \}\)\)/);
});
