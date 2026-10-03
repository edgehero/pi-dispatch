import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * The CI leftover check (issue #351) failed once on main after #554: a `pi-dispatch-544-*` directory came back after
 * the file's cleanup, because pi's ModelRuntime starts refreshes it never awaits and a refresh writes `auth.json`
 * into its agent dir. `trackPiRefreshes` makes the temp-dir cleanup wait for every such refresh first.
 *
 * Proved in a child `node --test` run, since the cleanup is the child file's own `after()` hook: a fake runtime
 * whose refresh writes into its `tempDir()` 300 ms after the test returned. Tracked, the directory is gone when the
 * child exits; untracked (`PI_DISPATCH_TRACK=0`, the regression), the late write recreates it.
 */
const helpers = join(import.meta.dirname, "helpers");

function runChild(track) {
	const work = tempDir("pi-dispatch-settle-");
	const reportPath = join(work, "dir.txt");
	const fixture = join(work, "child.test.mjs");
	writeFileSync(
		fixture,
		`import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from ${JSON.stringify(pathToFileURL(join(helpers, "temp-dir.mjs")).href)};
import { trackPiRefreshes } from ${JSON.stringify(pathToFileURL(join(helpers, "track-pi-refreshes.mjs")).href)};

class FakeRuntime {
	constructor(dir) { this.dir = dir; }
	refresh() {
		return new Promise((resolve) => setTimeout(() => {
			mkdirSync(this.dir, { recursive: true });
			writeFileSync(join(this.dir, "auth.json"), "{}");
			resolve();
		}, 300));
	}
	registerProvider() { void this.refresh(); }
}
if (process.env.PI_DISPATCH_TRACK === "1") trackPiRefreshes(FakeRuntime);

test("a runtime whose refresh lands after the test returns", () => {
	const dir = tempDir("pi-dispatch-settle-agent-");
	writeFileSync(${JSON.stringify(reportPath)}, dir);
	new FakeRuntime(dir).registerProvider();
});
`,
	);
	// NODE_TEST_CONTEXT is how the parent runner marks its own child processes; inherited, it makes this child report
	// to a parent that is not listening instead of running the fixture. Drop it so the child is a plain run.
	const env = { ...process.env, PI_DISPATCH_TRACK: track ? "1" : "0" };
	delete env.NODE_TEST_CONTEXT;
	const child = spawnSync(process.execPath, ["--test", fixture], { env, encoding: "utf8", timeout: 30000 });
	const agentDir = readFileSync(reportPath, "utf8");
	const survived = existsSync(agentDir);
	rmSync(agentDir, { recursive: true, force: true });
	return { status: child.status, survived };
}

test("a tracked runtime's late refresh lands before the temp-dir cleanup, so no directory survives", () => {
	const { status, survived } = runChild(true);
	assert.equal(status, 0);
	assert.equal(survived, false, "the late refresh recreated the agent dir after cleanup");
});

test("without tracking, the same late refresh recreates the directory: the case the tracker exists for", () => {
	const { status, survived } = runChild(false);
	assert.equal(status, 0);
	assert.equal(survived, true, "the untracked control did not reproduce the leftover, so the tracked case proves nothing");
});
