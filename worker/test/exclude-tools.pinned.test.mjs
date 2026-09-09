import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXCLUDABLE_TOOL_NAMES } from "../src/triggers.mjs";

/**
 * The bolt on `EXCLUDABLE_TOOL_NAMES` (issue #291; CLAUDE.md's rule: a hand-written table that restates
 * a derivable source is either derived or pinned, never trusted).
 *
 * The constant CANNOT be derived where it lives: triggers.mjs is pure and pi-free (the receiver loads
 * it, admin/build.mjs inlines it), and the worker does not depend on the agent package. So it is
 * hand-written there and pinned HERE against the artifact it restates -- pi's own `allToolNames` in the
 * pinned dist bundle, reached by file URL because pi's exports map is closed and does not expose it.
 * `image/runner/test/pinned-api.test.mjs` holds the second bolt (the factory-derived set the runner
 * actually enforces with), so the loader's set, the runner's set and pi's set must all move together.
 *
 * Assert the ARTIFACT, not HEAD: host-pi.pinned.test.mjs's rule, and the constitution behind it.
 */

const piRoot = new URL("../../node_modules/@earendil-works/pi-coding-agent/", import.meta.url);

// A skip rather than a silent pass when pi is not installed (a bare worker/ checkout). A skip is NOT a
// pass: CI runs with PI_DISPATCH_REQUIRE_WORKER_TESTS=1 and the dependency present.
const skip = existsSync(fileURLToPath(new URL("package.json", piRoot))) ? false : "pi is not installed (run npm install at the repo root)";

const PROTOCOL =
	"the pinned pi's built-in tool set moved. Do NOT relax this assertion. Grow (or shrink) these together, in one commit: " +
	"EXCLUDABLE_TOOL_NAMES in worker/src/triggers.mjs, the factory list in image/runner/src/tools.mjs, the sdk.d.ts and " +
	"allToolNames pins in image/runner/test/pinned-api.test.mjs, docs/exclude-tools.md's set, and the triggers.example.json " +
	"entry -- then re-verify pi still IGNORES unknown excludeTools names silently (that fact is why the loader validates at all).";

test("EXCLUDABLE_TOOL_NAMES is exactly the pinned pi's allToolNames", { skip }, async () => {
	// The exports map constrains bare specifiers only, so the file URL reaches the canonical set the
	// package root does not export -- the same route usage-meter's own resolver takes.
	const tools = await import(new URL("dist/core/tools/index.js", piRoot).href);
	assert.deepEqual([...EXCLUDABLE_TOOL_NAMES].sort(), [...tools.allToolNames].sort(), PROTOCOL);
});
