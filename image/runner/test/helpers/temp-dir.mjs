/**
 * One OS temp directory per test, removed when the file ends (issue #351).
 *
 * WHY A HELPER RATHER THAN A HABIT. Before this, 30 test files made about 200 `mkdtempSync` calls and
 * most never removed them: one local `npm test` left about a thousand new entries in `$TMPDIR`, and
 * `contract-tests` runs the suite three times per job, so a CI run left several thousand. On a runner
 * the temp dir dies with the job; on a maintainer's machine it stays until something cleans it, and
 * several gated rounds in one day filled about 7 GB.
 *
 * REGISTERED PER CALL, not per file, and that is load-bearing: `doctor.test.mjs`'s `liveEnv()` makes
 * its directory inside a DEFAULT-ARGUMENT expression, so a file-level "make one, clean one" shape
 * would miss every call after the first.
 *
 * The `after()` hook is registered once at import, before any test is declared, which is exactly when
 * `node:test` wants a root hook. It runs in both runners -- the child-process one `node --test` uses
 * and the in-process one `.github/scripts/test-count-check.mjs` compares against -- so nothing here
 * depends on which is driving.
 *
 * `rmSync` is `force` as well as `recursive`: a test that already removed its own directory is not a
 * teardown failure, and a teardown that throws would turn a green file red for a directory nobody
 * wanted anyway.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const made = [];

after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** `mkdtempSync(join(tmpdir(), prefix))`, remembered so the file's `after()` can remove it. */
export function tempDir(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}
