/**
 * Assert that `node --test` reports every test a file actually declares (issue #266).
 *
 * THE FAILURE THIS EXISTS FOR IS SILENT. `node --test` runs each file in a CHILD PROCESS that serialises
 * its own results over `process.stdout`. Anything that writes to that stream out of band -- most sharply, a
 * test helper that replaces `process.stdout.write` and holds the replacement across an `await` -- destroys
 * whatever result frames flush inside that window. The parent then renumbers what it did receive, so the
 * output is a clean contiguous `1..N` with `fail 0`, `skipped 0`, `cancelled 0` and exit code 0. Three
 * tests in `worker/test/start-wiring.test.mjs` were invisible this way, and the suite reported success.
 *
 * WHY THIS COMPARES TWO RUNNERS RATHER THAN COUNTING SOURCE. The obvious guard is to grep `^test(` and
 * compare, and it is wrong twice over: `image/runner/test/sources-parse.test.mjs` and
 * `worker/test/env-file.test.mjs` generate their cases in `for` loops (24 and 37 real tests from 1 and 9
 * literal declarations), so a grep guard needs an allowlist, and an allowlist is a thing that erodes.
 * Running the file WITHOUT `--test` uses the in-process runner, which has no child stdout channel and
 * therefore cannot lose frames. Comparing the two counts is exact for every file, loops included, and it
 * catches any future cause of lost frames rather than only the one already found.
 *
 * A mismatch is a REPORTING failure, not a test failure: the tests themselves ran. What is lost is which
 * ones, which is precisely what makes a red build unreadable.
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const DIRS = ["image/runner/test", "worker/test", "receiver/test", "admin/test"];

/**
 * `worker/test/wiring.test.mjs` leaves a handle alive for ~30s, so at a 30s cap its FILE wrapper trips and
 * reports a spurious `cancelled 1`. That is a property of the file, not of this check, and 60s clears it.
 */
const TIMEOUT_MS = 90_000;

/** How many files run at once. The suite is ~55s wall clock; this runs it twice, so keep it parallel. */
const CONCURRENCY = 8;

function run(args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", () => {});
		child.on("close", () => resolve(out));
	});
}

/** The `# tests N` / `# skipped N` line the TAP reporter prints, or null when the run produced neither. */
function counts(tap) {
	const n = (key) => {
		const m = tap.match(new RegExp(`^# ${key} (\\d+)$`, "m"));
		return m ? Number(m[1]) : null;
	};
	return { tests: n("tests"), skipped: n("skipped") };
}

const files = DIRS.flatMap((d) => {
	let names = [];
	try {
		names = readdirSync(d);
	} catch {
		return []; // a workspace that is not present is not a failure
	}
	return names.filter((f) => f.endsWith(".test.mjs")).map((f) => join(d, f));
}).sort();

const mismatches = [];
let checked = 0;

for (let i = 0; i < files.length; i += CONCURRENCY) {
	const batch = files.slice(i, i + CONCURRENCY);
	const results = await Promise.all(
		batch.map(async (file) => {
			const [childTap, inProcTap] = await Promise.all([
				run(["--test", "--test-reporter=tap", `--test-timeout=${TIMEOUT_MS}`, file]),
				run(["--test-reporter=tap", `--test-timeout=${TIMEOUT_MS}`, file]),
			]);
			return { file, child: counts(childTap), inProc: counts(inProcTap) };
		}),
	);
	for (const { file, child, inProc } of results) {
		checked++;
		// A file that reported nothing either way is a harness problem of its own, and it is louder to say
		// so here than to let a null compare equal to a null.
		if (child.tests === null || inProc.tests === null) {
			mismatches.push(`${file}: no test count reported (child=${child.tests}, in-process=${inProc.tests})`);
			continue;
		}
		if (child.tests !== inProc.tests) {
			mismatches.push(`${file}: \`node --test\` reported ${child.tests}, the in-process runner ran ${inProc.tests} -- ${inProc.tests - child.tests} lost`);
		}
	}
}

if (mismatches.length > 0) {
	process.stderr.write(`test-count-check: ${mismatches.length} file(s) lost test results\n\n`);
	for (const m of mismatches) process.stderr.write(`  ${m}\n`);
	process.stderr.write(
		"\nThe tests RAN; their result frames never reached the parent. The usual cause is something writing\n" +
			"to the child's stdout out of band -- most often a test helper that reassigns `process.stdout.write`\n" +
			"across an `await`. Inject a writer seam into the code under test instead (issue #266).\n",
	);
	process.exit(1);
}

process.stdout.write(`test-count-check: ${checked} files, every declared test reported\n`);
