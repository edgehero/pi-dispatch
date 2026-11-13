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

test("the specs that name the libuv or the Node the rule was read at name the pinned ones", () => {
	// The entries that explain the rule restate both versions in prose; a hand-written copy is held to its source
	// (AGENTS.md). libuv to SEEN_CPUS_LIBUV, which the image job holds the built image to; Node to the Dockerfile's own
	// note of what its pinned base resolves to. A later release named on purpose (1.52.0, where the rule moved) is
	// written without the "libuv" before it, so it is not read as a claim about the image.
	const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
	const section = (text, id) => {
		const at = text.indexOf(`\n## ${id}\n`);
		assert.ok(at >= 0, id);
		const end = text.indexOf("\n## ", at + 4);
		return text.slice(at, end < 0 ? undefined : end);
	};
	const node = /it resolves to node (\d+\.\d+\.\d+)/.exec(read("image/Dockerfile"))?.[1];
	assert.ok(node, "image/Dockerfile notes the Node its base resolves to");
	const design = read("specs/design.md");
	const entries = { "DES-JOB-SIZE-IN-THE-ENV": section(design, "DES-JOB-SIZE-IN-THE-ENV"), "DES-SIZE-SUGGESTIONS": section(design, "DES-SIZE-SUGGESTIONS"), "INT-CONTAINER-RUNTIME-CONTRACT": section(read("specs/interfaces.md"), "INT-CONTAINER-RUNTIME-CONTRACT") };
	for (const [id, text] of Object.entries(entries)) {
		const libuvs = [...text.matchAll(/\blibuv\s+(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
		const nodes = [...text.matchAll(/\bNode\s+(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
		assert.ok(libuvs.length > 0, `${id} names the libuv it read`);
		for (const v of libuvs) assert.equal(v, SEEN_CPUS_LIBUV, `${id} names libuv ${v}`);
		for (const v of nodes) assert.equal(v, node, `${id} names Node ${v}`);
	}
	assert.ok(Object.values(entries).some((text) => /\bNode\s+\d/.test(text)), "and at least one names the Node");
});
