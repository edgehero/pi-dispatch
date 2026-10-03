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
 *
 * ONE HAZARD, MEASURED, for whoever writes the next teardown here. ES imports hoist, so this hook is
 * registered before any statement in the importing file, and `node:test` runs root hooks in
 * registration order. This one therefore always runs FIRST, and a file's own `after()` that inspects a
 * `tempDir()` directory will find it already gone. Read what you need inside the test, not in a hook.
 *
 * AND ONE LIMIT THIS CANNOT COVER: a test that TIMES OUT under `node --test` has its file wrapper
 * killed before root hooks run, so its directory survives. Nothing in this tree sets a per-test
 * timeout today; the CI leftover count is what would catch it if something did.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const made = [];
const pending = new Set();

after(async () => {
	// Work a test started and did not await (pi's ModelRuntime fires refreshes it never awaits, and a refresh writes
	// auth.json into its agent dir) must land BEFORE the directories go, or it recreates one after this hook and the
	// suite's TMPDIR check names it. `settleBeforeCleanup` registers such work; nothing else waits here.
	while (pending.size > 0) await Promise.allSettled([...pending]);
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** Register a promise this file's cleanup must wait for before it removes any `tempDir()` directory. */
export function settleBeforeCleanup(promise) {
	pending.add(promise);
	Promise.resolve(promise).then(
		() => pending.delete(promise),
		() => pending.delete(promise),
	);
	return promise;
}

/** `mkdtempSync(join(tmpdir(), prefix))`, remembered so the file's `after()` can remove it. */
export function tempDir(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}
