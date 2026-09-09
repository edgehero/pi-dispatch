import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT_POLICY } from "../src/outcome.mjs";

// tools.mjs imports pi STATICALLY, so it is loaded dynamically inside each test and the whole file is
// gated the pinned-api way: on a checkout without the pinned package the import itself would throw,
// and a skip is not a pass -- CI runs with the dependency present.
const piInstalled = existsSync(fileURLToPath(new URL("../../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url)));
const skip = piInstalled ? false : "pi is not installed (run npm install at the repo root); CI runs these";

test("excludableToolNames derives the pinned built-in set off the root-exported factories", { skip }, async () => {
	// A DERIVATION, never a hand-written list: pi does not export `allToolNames` from the package root
	// (pinned-api.test.mjs pins that), so the factories' own `.name` fields are the artifact-backed
	// answer, and a pin bump that renames a tool moves this set with it instead of leaving a copy lying.
	const { excludableToolNames } = await import("../src/tools.mjs");
	assert.deepEqual(excludableToolNames(), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
});

test("assertExcludeToolsKnown refuses an unknown entry VERBATIM, exit 2, naming the known set", { skip }, async () => {
	const { assertExcludeToolsKnown } = await import("../src/tools.mjs");
	// " bash" rather than "flarp", deliberately: parseExcludeTools does not trim, so the padded form is
	// the realistic miss, and the refusal must show the entry as written or the operator hunts a ghost.
	try {
		assertExcludeToolsKnown([" bash"]);
		assert.fail("a padded entry must refuse -- pi would silently ignore it and the tool would stay on");
	} catch (error) {
		assert.equal(error.piDispatchExit, EXIT_POLICY, "a bad exclusion is config: exit 2, never retried");
		assert.match(error.message, /" bash"/, "the entry is reported verbatim, padding included");
		assert.match(error.message, /read, bash, edit, write, grep, find, ls/, "the refusal names the whole known set");
		assert.match(error.message, /ignores unknown names silently/, "and says WHY refusing beats passing it through");
	}
	// Every real name passes, unordered and repeated calls included (the memoized set is stable).
	assertExcludeToolsKnown(["ls", "bash", "edit", "write", "grep", "find", "read"]);
	assertExcludeToolsKnown([]);
});
