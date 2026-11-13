/**
 * Issue #865: the job image's Node is the one image/Dockerfile notes, and bundles the libuv the size suggestion's
 * CPU-count rule was read at.
 *
 *   node .github/scripts/libuv-pin-check.mjs <image-ref>
 *
 * The OOM suggestion says how many CPUs a killed run's tools counted at least (worker/src/size-suggest.mjs
 * `seenCpusOf`), and that rule is libuv's own arithmetic, read at `SEEN_CPUS_LIBUV`: under one CPU, the release it was
 * read at skips a quota of 0 and Node's `os.availableParallelism()` answers the whole runtime, where libuv 1.52.0
 * answers 1. A Node bump in image/Dockerfile can move libuv with nothing else in the repository noticing, and the
 * suggestion would then name a count the tools never read. So the image job runs one `node -p` inside the BUILT image
 * for both `process.versions.uv` and `process.versions.node`, and compares them here:
 *   - libuv against `SEEN_CPUS_LIBUV`, failing with the step that has to come first: read the rule again;
 *   - Node against image/Dockerfile's own note of what its pinned base resolves to (`dockerfileNode`), which the
 *     specs' prose is held to (worker/test/libuv-pin.test.mjs, through the same reader), so that note is checked
 *     against the image itself and is not just another hand-written copy.
 *
 * Exact, never a range: libuv's minor releases are where this rule moved, and a patch release is still a release
 * nobody read. Exits 0 when both match, 1 on a difference or on an image whose Node did not answer.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SEEN_CPUS_LIBUV } from "../../worker/src/size-suggest.mjs";

const VERSION = /^\d+\.\d+\.\d+$/;

/** The Node version image/Dockerfile notes its pinned base resolves to (`it resolves to node X.Y.Z`), or null. */
export function dockerfileNode(text) {
	return /\bit resolves to node (\d+\.\d+\.\d+)\b/.exec(String(text ?? ""))?.[1] ?? null;
}

/** The Dockerfile this repository builds the job image from. */
export function readDockerfile(read = (url) => readFileSync(url, "utf8")) {
	return read(new URL("../../image/Dockerfile", import.meta.url));
}

/** The problem with an image's libuv version, or null when it is the one the rule was read at. */
export function libuvPinProblem(imageUv, want = SEEN_CPUS_LIBUV) {
	const got = typeof imageUv === "string" ? imageUv.trim() : "";
	if (!VERSION.test(got)) return `the job image's Node did not report a libuv version (process.versions.uv answered ${JSON.stringify(got)})`;
	if (got === want) return null;
	return `the job image's Node bundles libuv ${got}, but worker/src/size-suggest.mjs read its CPU-count rule (seenCpusOf) at libuv ${want}. Read uv__get_constrained_cpu (src/unix/linux.c) and uv_available_parallelism (src/unix/core.c) at libuv ${got}, correct seenCpusOf and its tests where the rule moved (libuv 1.52.0 answers 1 under one CPU where ${want} skips it), then set SEEN_CPUS_LIBUV to ${got}.`;
}

/** The problem with an image's Node version against image/Dockerfile's note (`dockerfileNode`), or null when they agree. */
export function nodePinProblem(imageNode, noted) {
	const got = typeof imageNode === "string" ? imageNode.trim() : "";
	if (!VERSION.test(got)) return `the job image's Node did not report its version (process.versions.node answered ${JSON.stringify(got)})`;
	if (typeof noted !== "string" || !VERSION.test(noted)) return 'image/Dockerfile no longer notes the Node its base resolves to ("it resolves to node X.Y.Z"), which the specs\' versions are held to (worker/test/libuv-pin.test.mjs): put the note back';
	if (got === noted) return null;
	return `the job image's Node is ${got}, but image/Dockerfile notes its base resolves to node ${noted}. Set that note to ${got}, then the "Node ${noted}" in DES-JOB-SIZE-IN-THE-ENV, DES-SIZE-SUGGESTIONS and INT-CONTAINER-RUNTIME-CONTRACT (worker/test/libuv-pin.test.mjs fails until they agree), and check the libuv that Node bundles against SEEN_CPUS_LIBUV.`;
}

/** `{ uv, node }` of the Node inside `image`, from ONE `docker run`, never a pull. */
export function imageVersions(image, run = (args) => execFileSync("docker", args, { encoding: "utf8" })) {
	const [uv = "", node = ""] = String(run(["run", "--rm", "--pull=never", "--entrypoint", "node", image, "-p", "process.versions.uv + ' ' + process.versions.node"]) ?? "").trim().split(/\s+/);
	return { uv, node };
}

/** Every problem with `image`, in the order to fix them: the image's own answer, then the note, then the rule. */
export function pinProblems(versions, dockerfileText, want = SEEN_CPUS_LIBUV) {
	return [nodePinProblem(versions?.node, dockerfileNode(dockerfileText)), libuvPinProblem(versions?.uv, want)].filter((p) => p !== null);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const image = process.argv[2];
	if (!image) {
		console.error("usage: node .github/scripts/libuv-pin-check.mjs <image-ref>");
		process.exit(2);
	}
	let versions = { uv: "", node: "" };
	try {
		versions = imageVersions(image);
	} catch (error) {
		console.error(`docker could not run node in ${image}: ${error.message}`);
	}
	const problems = pinProblems(versions, readDockerfile());
	for (const problem of problems) console.error(`::error::${problem}`);
	if (problems.length > 0) process.exit(1);
	console.log(`OK: the job image's Node ${versions.node} is the one image/Dockerfile notes, and bundles libuv ${SEEN_CPUS_LIBUV}, the one seenCpusOf was read at`);
}
