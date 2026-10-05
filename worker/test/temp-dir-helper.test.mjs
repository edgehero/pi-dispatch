import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #507: in a file with a top-level await, `node:test` runs the root `after()` hooks once the tests declared
 * BEFORE the await have finished, while the module is still suspended on it. A test declared after the await still
 * runs, but after those hooks, so the helper's hook never saw its directory: `output-cap.test.mjs` left one per run
 * under a TMPDIR of its own. The helper now also removes its directories on the process `exit` event.
 *
 * Proved in a child `node --test` run per workspace copy of the helper (each workspace carries its own, and all four
 * had the same hook). The fixture reports the order its own root hook and its late test ran in, so the test also
 * shows the hazard is real on this Node: if the hook ever ran after the late test, the fixture would prove nothing.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const HELPERS = ["worker", "receiver", "admin", "image/runner"].map((ws) => join(root, ws, "test", "helpers", "temp-dir.mjs"));

function runChild(helper) {
	const work = tempDir("pi-dispatch-tla-");
	const reportPath = join(work, "order.txt");
	const fixture = join(work, "child.test.mjs");
	writeFileSync(
		fixture,
		`import { appendFileSync } from "node:fs";
import { after, test } from "node:test";
import { tempDir } from ${JSON.stringify(pathToFileURL(helper).href)};

after(() => appendFileSync(${JSON.stringify(reportPath)}, "hook\\n"));
test("declared before the await", () => {});
await new Promise((resolve) => setTimeout(resolve, 100));
test("declared after the await", () => {
	appendFileSync(${JSON.stringify(reportPath)}, "late " + tempDir("pi-dispatch-tla-late-") + "\\n");
});
`,
	);
	// NODE_TEST_CONTEXT marks the parent runner's own children; inherited, the child would report to a parent that is
	// not listening instead of running the fixture. Dropped so the child is a plain run.
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const child = spawnSync(process.execPath, ["--test", fixture], { env, encoding: "utf8", timeout: 30000 });
	const order = readFileSync(reportPath, "utf8").trim().split("\n");
	const late = order.find((line) => line.startsWith("late "))?.slice("late ".length) ?? null;
	const survived = late !== null && existsSync(late);
	if (late !== null) rmSync(late, { recursive: true, force: true });
	return { status: child.status, order: order.map((line) => line.split(" ")[0]), survived };
}

for (const helper of HELPERS) {
	const name = helper.slice(root.length);
	test(`${name}: a directory made by a test declared after a top-level await is removed, though the root hook ran before that test (#507)`, () => {
		const { status, order, survived } = runChild(helper);
		assert.equal(status, 0);
		assert.deepEqual(order, ["hook", "late"], "the root hook ran before the late test: the case the exit backstop exists for");
		assert.equal(survived, false, "the late test's directory survived the file");
	});
}
