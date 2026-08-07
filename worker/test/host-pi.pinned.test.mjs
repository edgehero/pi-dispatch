import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PINNED_PI_NEEDLES } from "../src/host-pi.mjs";

/**
 * REQ-UPSTREAM-CONTRACT-TESTS for host-pi.mjs (issue #102).
 *
 * `host-pi.mjs` answers two questions pi exports no public API for: where a package the operator installed
 * lives on disk, and whether a resource they configured is enabled. Both answers are MIRRORS of private
 * internals in pi's dist bundle. The realistic failure of a mirror is not a crash -- it is that pi changes
 * the grammar and `import-pi` silently starts staging something the operator turned off, which is exactly
 * the silent-failure class this project exists to refuse. So the mirror is pinned.
 *
 * Assert the ARTIFACT, not HEAD (CLAUDE.md, and the constitution behind it): these read the bundle the
 * lockfile actually resolved. `.github/scripts/host-pi-canary.mjs` runs the same needle list against
 * pi@latest for advance warning; both import PINNED_PI_NEEDLES from the source so the gate and the canary
 * cannot drift apart. This test is a BUILD GATE, the canary is a heads-up -- do not confuse the two.
 *
 * Mirrors image/runner/test/pinned-api.test.mjs and admin/test/pinned-extension-api.test.mjs in philosophy.
 * pi is hoisted to the repo root by the image/runner workspace, so nothing here adds a dependency to
 * worker/.
 */

const piRoot = new URL("../../node_modules/@earendil-works/pi-coding-agent/", import.meta.url);

/**
 * A skip rather than a silent pass when pi is not installed (a bare `worker/` checkout with no root
 * install). A skip is NOT a pass: CI runs the full suite with the dependency present, which is where these
 * actually execute.
 */
const skip = existsSync(fileURLToPath(new URL("package.json", piRoot))) ? false : "pi is not installed (run npm install at the repo root)";

/** The failure protocol, spelled out once and attached to every assertion that can fail. */
const PROTOCOL =
	"pi moved an internal that worker/src/host-pi.mjs mirrors. Do NOT relax this assertion. Re-verify, in this order: " +
	"(1) the install-path resolution in host-pi.mjs's discoverHostPackages against pi's getNpmInstallPath, including the precedence " +
	"that honours the managed path BEFORE the global one; (2) isEnabledByPatterns against pi's isEnabledByOverrides, especially the " +
	"'-' beats '+' beats '!' order and which patterns are matched exactly rather than by glob; (3) the pi-package predicate against " +
	"collectPackageResources' fallthrough to the convention dirs; (4) PINNED_PI_NEEDLES itself, and .github/scripts/host-pi-canary.mjs " +
	"which shares it. If pi's behaviour genuinely changed, the mirror changes with it and REQ-GLOBAL-PI-OVERLAY records what moved.";

test("pi's package-install paths and enablement grammar are still the ones host-pi.mjs mirrors", { skip }, () => {
	for (const [file, needles] of Object.entries(PINNED_PI_NEEDLES)) {
		const path = fileURLToPath(new URL(file, piRoot));
		assert.ok(existsSync(path), `${file} is gone from the pinned pi. ${PROTOCOL}`);
		const src = readFileSync(path, "utf8");
		for (const needle of needles) {
			assert.ok(src.includes(needle), `${file} no longer contains ${JSON.stringify(needle)}. ${PROTOCOL}`);
		}
	}
});

/**
 * The single assumption the extension half rests on, and the one most likely to be wrong in a subtle way:
 * that what `pi config` WRITES when an operator disables an extension is a `-` plus the entry path relative
 * to the agent dir. If pi started writing an absolute path, or the directory rather than the entry, the
 * disable would still be recorded and we would still copy the extension: a silent regression to the exact
 * bug issue #102 reported.
 */
test("pi config still writes a disable as '-' plus the entry path relative to the base dir", { skip }, () => {
	const path = fileURLToPath(new URL("dist/modes/interactive/components/config-selector.js", piRoot));
	assert.ok(existsSync(path), `config-selector.js is gone from the pinned pi. ${PROTOCOL}`);
	const src = readFileSync(path, "utf8");
	assert.ok(src.includes("const disablePattern = `-${pattern}`;"), `pi no longer writes a '-' prefixed exclusion. ${PROTOCOL}`);
	assert.ok(src.includes("const enablePattern = `+${pattern}`;"), `pi no longer writes a '+' prefixed force-include. ${PROTOCOL}`);
	// The pattern is relative to the TOP-LEVEL base dir, which for user scope is the agent dir itself --
	// which is why isEnabledByPatterns compares against a path relative to the agent dir and not to
	// `<agentDir>/extensions`. If this became an absolute path, a disable would still be recorded and we
	// would still copy the extension: a silent regression to the exact bug issue #102 reported.
	assert.ok(src.includes("relative(baseDir, item.path)"), `pi no longer derives the pattern from a base-relative entry path. ${PROTOCOL}`);
	assert.ok(src.includes('return scope === "project" ? join(this.cwd, CONFIG_DIR_NAME) : this.agentDir;'), `pi's user-scope base dir is no longer the agent dir. ${PROTOCOL}`);
});
