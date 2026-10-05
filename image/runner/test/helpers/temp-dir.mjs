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
 * THE ROOT HOOK CAN RUN TOO EARLY, so process exit is the backstop (issue #507, measured on Node 22.19
 * and 23.5). In a file with a top-level await, `node:test` runs the root `after()` hooks as soon as the
 * tests declared BEFORE the await have finished, while the module is still suspended on it; a test
 * declared after the await still runs, but after those hooks. Its directory was never removed:
 * `output-cap.test.mjs` left one per run and carried its own `t.after()` to make up for it. So the
 * same removal also runs on the process `exit` event, synchronously, which comes after every test
 * and every hook in both runners. Each pass takes what it removes off the list, so the exit pass removes
 * only what the hook never saw. It deliberately does not sweep again: a directory that late work
 * recreated after the hook is the image runner's `settleBeforeCleanup` case, and its test's control
 * must keep showing that. The hook stays: in the usual file it removes the directories at the file's
 * end, not the process's.
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

/** Remove every directory made so far and take it off the list. The hook and the exit backstop both call it. */
function removeMade() {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

after(async () => {
	// Work a test started and did not await (pi's ModelRuntime fires refreshes it never awaits, and a refresh writes
	// auth.json into its agent dir) must land BEFORE the directories go, or it recreates one after this hook and the
	// suite's TMPDIR check names it. `settleBeforeCleanup` registers such work; nothing else waits here.
	while (pending.size > 0) await Promise.allSettled([...pending]);
	removeMade();
});
process.on("exit", removeMade);

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
