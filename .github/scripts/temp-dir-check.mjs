/**
 * Assert that no test file makes an OS temp directory without registering it for cleanup (issue #351).
 *
 * THE DEFECT THIS EXISTS FOR IS SLOW, NOT LOUD. Thirty test files made about two hundred
 * `mkdtempSync(join(tmpdir(), ...))` calls and most never removed them. One local `npm test` left
 * about a thousand new entries in `$TMPDIR`; `contract-tests` runs the suite three times per job, so
 * a CI run left several thousand. On a runner the temp dir dies with the job. On a maintainer's
 * machine it stays, and several gated rounds in one day filled about 7 GB and pushed the disk under
 * the threshold the nested labs need.
 *
 * WHY THIS IS A GREP AND WHY THAT IS NOT ENOUGH. This check sees a call SHAPE. The defect is a
 * missing cleanup, which no grep can see: delete an `after()` hook and this stays green. So it ships
 * beside an oracle -- the same job runs the suite under a `TMPDIR` of its own and fails if anything is
 * left in it -- exactly as `dated-fixture-check.mjs` ships beside the clock-shifted run. They catch different things on
 * purpose and neither subsumes the other. What this one buys is the second: an author hears about a
 * bare call in a second, rather than after a full suite run, and the message names the fix.
 *
 * NO ALLOWLIST, on `test-count-check.mjs`'s own stated ground that an allowlist is a thing that
 * erodes. The workspace helper is always the right answer here, so there is no exception to carve.
 *
 * WHAT IS DELIBERATELY NOT FLAGGED. A `mkdtempSync` rooted somewhere other than the OS temp dir --
 * `mkdtempSync(join(jobsDir, "job-"))` in `prepare.test.mjs`, `mkdtempSync(join(root, "job-"))` in
 * `session-store.test.mjs` -- is already inside a directory the helper registered, so removing the
 * root removes it too. And an injected fake whose `mkdtempSync` throws is a property, not a call.
 * Both shapes exist in the tree today and both are correct.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The four test trees, matching the root package.json test glob. Non-recursive, so `helpers/` is not scanned. */
const TEST_DIRS = ["image/runner/test", "worker/test", "receiver/test", "admin/test"];

/**
 * A `mkdtemp` or `mkdtempSync` whose argument reaches `tmpdir()` textually: `join(tmpdir(), ...)`,
 * `join(os.tmpdir(), ...)` or any namespace alias, a template literal, and plain concatenation. The
 * async `node:fs/promises` spelling counts too -- an adversarial pass found it missing from the first
 * draft, and it is the promises API rather than an exotic dodge. Bounded to 200 characters and stopped
 * at a newline or `;` so the match cannot run past its own call.
 *
 * WHAT THIS CANNOT SEE, stated rather than implied, because the oracle beside it is what covers each:
 *   - `const t = tmpdir(); mkdtempSync(join(t, ...))`. Following a value through a variable is dataflow,
 *     not a grep, and pretending otherwise would be a check nobody could trust.
 *   - a directory made OUTSIDE `tmpdir()` -- a hardcoded `/var/tmp`, or a child process spawned with a
 *     scrubbed env that drops `TMPDIR` and falls back to `/tmp`. Measured on this tree: no test does
 *     either today (a full CI-posture run under an isolated `TMPDIR` added nothing to `/tmp` or
 *     `/var/tmp`), which is why this is a bound worth writing down rather than a defect worth chasing.
 *   - `worker/src` making its own temp directories (`prepare-github.mjs`'s `pi-askpass-`,
 *     `doctor.mjs`'s `pi-doctor-skills-`). Only `*.test.mjs` is scanned, so a test driving those paths
 *     leaks through production code and the oracle is the sole detector.
 *   - a test that TIMES OUT. `node --test` kills the file wrapper before root `after()` hooks run, so
 *     the directory survives (measured). Nothing in this tree sets a per-test timeout except
 *     `test-count-check.mjs`, whose runs are not the measured ones.
 * Since it is textual, it also matches inside a string literal or a comment. A false positive costs one
 * rename; the alternative is parsing, which `dated-fixture-check.mjs` already records as a four-round trap.
 */
const BARE_TEMP_DIR = /\bmkdtemp(?:Sync)?\s*\([^;\n]{0,200}?\btmpdir\s*\(\s*\)/g;

function listTestFiles() {
	const files = [];
	for (const dir of TEST_DIRS) {
		let names;
		try {
			names = readdirSync(dir);
		} catch {
			continue; // a workspace that is not present is not a failure
		}
		for (const name of names) {
			if (name.endsWith(".test.mjs")) files.push(join(dir, name));
		}
	}
	return files;
}

const files = listTestFiles();
if (files.length === 0) {
	process.stderr.write("temp-dir-check: found NO test files, which means the scan is broken, not that the tree is clean\n");
	process.exit(1);
}

const findings = [];
for (const file of files) {
	const src = readFileSync(file, "utf8");
	for (const match of src.matchAll(BARE_TEMP_DIR)) {
		const line = src.slice(0, match.index).split("\n").length;
		findings.push(`${file}:${line}`);
	}
}

if (findings.length > 0) {
	process.stderr.write(
		`temp-dir-check: ${findings.length} test directory/directories are made in the OS temp dir without being registered for cleanup:\n` +
			findings.map((f) => `  ${f}\n`).join("") +
			"\nUse the workspace helper instead, which removes every directory the file made when the file ends:\n" +
			'  import { tempDir } from "./helpers/temp-dir.mjs";\n' +
			'  const dir = tempDir("my-prefix-");\n' +
			"\nA directory rooted somewhere the helper already made is fine and is not matched here (issue #351).\n",
	);
	process.exit(1);
}

process.stdout.write(`temp-dir-check: ${files.length} test files, every OS temp directory is registered for cleanup\n`);
