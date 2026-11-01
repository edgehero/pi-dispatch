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
 * whose refresh waits for a gate released after the test returns, then writes on the next immediate. The root
 * cleanup waits for that gate too, so an untracked write lands after removal without a timing race. Tracked, the directory is gone when the
 * child exits; untracked (`PI_DISPATCH_TRACK=0`, the regression), the late write recreates it.
 */
const helpers = join(import.meta.dirname, "helpers");

function runChild(track, { scripted = false } = {}) {
	const work = tempDir("pi-dispatch-settle-");
	const reportPath = join(work, "dir.txt");
	const writtenPath = join(work, "written.txt");
	const fixture = join(work, "child.test.mjs");
	writeFileSync(
		fixture,
		`import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir, settleBeforeCleanup } from ${JSON.stringify(pathToFileURL(join(helpers, "temp-dir.mjs")).href)};
import { trackPiRefreshes } from ${JSON.stringify(pathToFileURL(join(helpers, "track-pi-refreshes.mjs")).href)};
import { scriptedRuntime } from ${JSON.stringify(pathToFileURL(join(helpers, "recover-session.mjs")).href)};

let release;
let written = false;
const gate = settleBeforeCleanup(new Promise((resolve) => { release = resolve; }));

class FakeRuntime {
	constructor(dir) { this.dir = dir; }
	refresh() {
		this.refreshes = (this.refreshes ?? 0) + 1;
		if (this.refreshes > 1) return Promise.resolve();
		return gate.then(() => new Promise((resolve) => setImmediate(() => {
			mkdirSync(this.dir, { recursive: true });
			writeFileSync(join(this.dir, "auth.json"), "{}");
			written = true;
			writeFileSync(${JSON.stringify(writtenPath)}, "written");
			resolve();
		})));
	}
	registerProvider() { void this.refresh(); }
	getModel(provider, id) { return { provider, id }; }
}
if (process.env.PI_DISPATCH_TRACK === "1" && !${JSON.stringify(scripted)}) trackPiRefreshes(FakeRuntime);

test("a runtime whose refresh lands after the test returns", async () => {
	const dir = tempDir("pi-dispatch-settle-agent-");
	writeFileSync(${JSON.stringify(reportPath)}, dir);
	if (${JSON.stringify(scripted)}) {
		await scriptedRuntime({ pi: { ModelRuntime: FakeRuntime }, piAi: {}, createJobModelRuntime: async ({ ModelRuntime, agentDir }) => new ModelRuntime(agentDir) }, dir, "fake", []);
		assert.equal(written, false, "the helper returns while the registration refresh is still gated");
	} else new FakeRuntime(dir).registerProvider();
	setImmediate(release);
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
	return { status: child.status, survived, written: existsSync(writtenPath) };
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

test("scriptedRuntime tracks its unawaited registration refresh before the temporary directory is removed", () => {
	const { status, survived, written } = runChild(false, { scripted: true });
	assert.equal(status, 0);
	assert.equal(written, true, "the gated auth write actually ran after the scripted helper returned");
	assert.equal(survived, false, "scriptedRuntime left its late auth write outside the cleanup wait");
});
