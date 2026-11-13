import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dockerfileNode, imageVersions, libuvPinProblem, nodePinProblem, pinProblems, readDockerfile } from "../../.github/scripts/libuv-pin-check.mjs";
import { SEEN_CPUS_LIBUV } from "../src/size-suggest.mjs";

// Issue #865: the size suggestion's CPU-count rule (`seenCpusOf`) is libuv's arithmetic at one release, and the image
// job holds the built image's libuv to it and its Node to image/Dockerfile's note. The comparisons are tested here with
// injected answers: the host's own Node is no witness (Homebrew's node@22 links the system libuv, 1.53.0 at the time of
// writing), only the image's is.

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("the libuv the rule was read at is an exact release, and the Dockerfile notes the Node its base resolves to", () => {
	assert.match(SEEN_CPUS_LIBUV, /^\d+\.\d+\.\d+$/);
	assert.equal(SEEN_CPUS_LIBUV, "1.51.0", "the release read for #865");
	assert.match(dockerfileNode(readDockerfile()), /^\d+\.\d+\.\d+$/, "image/Dockerfile's note, read by the check's own reader");
	assert.equal(readDockerfile(), read("image/Dockerfile"));
	for (const text of ["", "# it resolves to node 22", "# resolves to node 22.23.1", null]) assert.equal(dockerfileNode(text), null, String(text));
	assert.equal(dockerfileNode("# multi-arch); it resolves to node 24.1.0 and carries"), "24.1.0");
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

test("an image whose Node is not the one the Dockerfile notes fails, saying what to update", () => {
	assert.equal(nodePinProblem("22.23.1", "22.23.1"), null);
	const problem = nodePinProblem("22.24.0", "22.23.1");
	assert.ok(problem.includes("Node is 22.24.0") && problem.includes("resolves to node 22.23.1"), problem);
	assert.match(problem, /Set that note to 22\.24\.0, then the "Node 22\.23\.1" in DES-JOB-SIZE-IN-THE-ENV, DES-SIZE-SUGGESTIONS and INT-CONTAINER-RUNTIME-CONTRACT/);
	assert.match(problem, /SEEN_CPUS_LIBUV/);
	assert.match(nodePinProblem("22.23.1", null), /no longer notes the Node its base resolves to/);
	for (const nothing of ["", "v22.23.1", null]) assert.match(nodePinProblem(nothing, "22.23.1"), /did not report its version/, String(nothing));
	// both are asked of one answer, the Node first: a wrong note says so before the libuv it may explain
	const dockerfile = "# it resolves to node 22.23.1 and";
	assert.deepEqual(pinProblems({ uv: SEEN_CPUS_LIBUV, node: "22.23.1" }, dockerfile), []);
	assert.equal(pinProblems({ uv: "1.52.1", node: "22.24.0" }, dockerfile).length, 2);
	assert.match(pinProblems({ uv: "1.52.1", node: "22.24.0" }, dockerfile)[0], /Node is 22\.24\.0/);
});

test("both versions come from one run of the image's own Node, never pulled", () => {
	const calls = [];
	assert.deepEqual(imageVersions("pi-job:ci", (args) => (calls.push(args), "1.51.0 22.23.1\n")), { uv: "1.51.0", node: "22.23.1" });
	assert.deepEqual(calls, [["run", "--rm", "--pull=never", "--entrypoint", "node", "pi-job:ci", "-p", "process.versions.uv + ' ' + process.versions.node"]]);
	assert.deepEqual(imageVersions("x", () => ""), { uv: "", node: "" }, "no answer reads as no versions, which both checks refuse");
});

test("the image job runs the check against the image it built", () => {
	const workflow = read(".github/workflows/pi-upgrade-check.yml");
	const start = workflow.indexOf("    name: the job image holds its contract\n");
	assert.ok(start >= 0, "the required image job");
	const next = workflow.slice(start + 1).search(/\n  [a-z0-9-]+:\n/);
	const job = next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
	assert.ok(job.includes('run: node .github/scripts/libuv-pin-check.mjs "$IMAGE_REF"'), "the step is in that job");
	assert.ok(job.includes("IMAGE_REF: pi-job:ci") && job.indexOf("docker build -f image/Dockerfile -t pi-job:ci .") < job.indexOf("libuv-pin-check.mjs"), "after the build of that image");
});

/** Every libuv and Node version a text names, in the spellings a person writes them. */
const LIBUV_NAMED = /\blibuv(?:'s)?\s+(?:release\s+)?v?(\d+\.\d+\.\d+)/gi;
const NODE_NAMED = /\bNode(?:\.js)?(?:'s)?\s+v?(\d+\.\d+\.\d+)/gi;
const named = (text, re) => [...text.matchAll(re)].map((m) => m[1]);

test("the version patterns catch every spelling, and not the later release named on purpose", () => {
	for (const text of ["libuv 1.52.0", "libuv v1.52.0", "libuv's 1.52.0", "libuv release 1.52.0", "LIBUV 1.52.0", "libuv\n  1.52.0"]) assert.deepEqual(named(text, LIBUV_NAMED), ["1.52.0"], text);
	for (const text of ["Node 22.24.0", "Node.js 22.24.0", "node 22.24.0", "Node v22.24.0", "Node's 22.24.0", "Node\n    22.24.0"]) assert.deepEqual(named(text, NODE_NAMED), ["22.24.0"], text);
	assert.deepEqual(named("holds at one libuv release, `SEEN_CPUS_LIBUV` (the next minor release, 1.52.0, answers 1", LIBUV_NAMED), []);
});

test("the specs and code comments that name the libuv or the Node the rule was read at name the pinned ones", () => {
	// The entries that explain the rule restate both versions in prose; a hand-written copy is held to its source
	// (AGENTS.md). libuv to SEEN_CPUS_LIBUV, Node to image/Dockerfile's note, and both of those to the built image by
	// .github/scripts/libuv-pin-check.mjs. A later release named on purpose (1.52.0, where the rule moved) is written
	// without "libuv" before it, so it is not read as a claim about the image. Out of scope: the host-pi entries, which
	// name the operator's own Node.
	const section = (text, id) => {
		const at = text.indexOf(`\n## ${id}\n`);
		assert.ok(at >= 0, id);
		const end = text.indexOf("\n## ", at + 4);
		return text.slice(at, end < 0 ? undefined : end);
	};
	const node = dockerfileNode(readDockerfile());
	const design = read("specs/design.md");
	const sources = {
		"DES-JOB-SIZE-IN-THE-ENV": section(design, "DES-JOB-SIZE-IN-THE-ENV"),
		"DES-SIZE-SUGGESTIONS": section(design, "DES-SIZE-SUGGESTIONS"),
		"INT-CONTAINER-RUNTIME-CONTRACT": section(read("specs/interfaces.md"), "INT-CONTAINER-RUNTIME-CONTRACT"),
		"worker/src/size-suggest.mjs": read("worker/src/size-suggest.mjs"),
		"worker/test/size-suggest.test.mjs": read("worker/test/size-suggest.test.mjs"),
	};
	for (const [where, text] of Object.entries(sources)) {
		for (const v of named(text, LIBUV_NAMED)) assert.equal(v, SEEN_CPUS_LIBUV, `${where} names libuv ${v}`);
		for (const v of named(text, NODE_NAMED)) assert.equal(v, node, `${where} names Node ${v}`);
	}
	assert.ok(["DES-JOB-SIZE-IN-THE-ENV", "INT-CONTAINER-RUNTIME-CONTRACT"].every((id) => named(sources[id], LIBUV_NAMED).length > 0), "the entries do name the libuv, so the check is not vacuous");
	assert.ok(Object.values(sources).some((text) => named(text, NODE_NAMED).length > 0), "and at least one names the Node");
});
