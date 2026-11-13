import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { imageLibuv, libuvPinProblem } from "../../.github/scripts/libuv-pin-check.mjs";
import { SEEN_CPUS_LIBUV } from "../src/size-suggest.mjs";

// Issue #865: the size suggestion's CPU-count rule (`seenCpusOf`) is libuv's arithmetic at one release, and the image
// job holds the built image's libuv to it. The comparison is tested here with injected answers: the host's own Node is
// no witness (Homebrew's node@22 links the system libuv, 1.53.0 at the time of writing), only the image's is.

test("the libuv the rule was read at is an exact release", () => {
	assert.match(SEEN_CPUS_LIBUV, /^\d+\.\d+\.\d+$/);
	assert.equal(SEEN_CPUS_LIBUV, "1.51.0", "the release read for #865, the one Node 22.23.1 bundles");
});

test("an image whose Node bundles that libuv passes, and any other release fails saying to read the rule again", () => {
	assert.equal(libuvPinProblem(SEEN_CPUS_LIBUV), null);
	assert.equal(libuvPinProblem(`${SEEN_CPUS_LIBUV}\n`), null, "node -p prints a newline");
	for (const other of ["1.52.0", "1.52.1", "1.53.0", "1.51.1", "1.50.2"]) {
		const problem = libuvPinProblem(other);
		assert.ok(problem.includes(`bundles libuv ${other}`) && problem.includes(`at libuv ${SEEN_CPUS_LIBUV}`), problem);
		assert.match(problem, /seenCpusOf/);
		assert.match(problem, /Read uv__get_constrained_cpu .* and uv_available_parallelism .* at libuv/);
		assert.ok(problem.endsWith(`then set SEEN_CPUS_LIBUV to ${other}.`), problem);
	}
	for (const nothing of ["", "undefined", "v1.51.0", "1.51", null, undefined]) assert.match(libuvPinProblem(nothing), /did not report a libuv version/, String(nothing));
});

test("the image's version is read from the image's own Node, never pulled", () => {
	const calls = [];
	assert.equal(imageLibuv("pi-job:ci", (args) => (calls.push(args), "1.51.0\n")), "1.51.0\n");
	assert.deepEqual(calls, [["run", "--rm", "--pull=never", "--entrypoint", "node", "pi-job:ci", "-p", "process.versions.uv"]]);
});

test("the image job runs the check against the image it built", () => {
	const workflow = readFileSync(new URL("../../.github/workflows/pi-upgrade-check.yml", import.meta.url), "utf8");
	const start = workflow.indexOf("    name: the job image holds its contract\n");
	assert.ok(start >= 0, "the required image job");
	const next = workflow.slice(start + 1).search(/\n  [a-z0-9-]+:\n/);
	const job = next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
	assert.ok(job.includes('run: node .github/scripts/libuv-pin-check.mjs "$IMAGE_REF"'), "the step is in that job");
	assert.ok(job.includes("IMAGE_REF: pi-job:ci") && job.indexOf("docker build -f image/Dockerfile -t pi-job:ci .") < job.indexOf("libuv-pin-check.mjs"), "after the build of that image");
});
