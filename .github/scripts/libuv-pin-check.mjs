/**
 * Issue #865: the job image's Node bundles the libuv the size suggestion's CPU-count rule was read at.
 *
 *   node .github/scripts/libuv-pin-check.mjs <image-ref>
 *
 * The OOM suggestion says how many CPUs a killed run's tools counted at least (worker/src/size-suggest.mjs
 * `seenCpusOf`), and that rule is libuv's own arithmetic, read at `SEEN_CPUS_LIBUV`: under one CPU, libuv 1.51.0 skips
 * a quota of 0 and Node's `os.availableParallelism()` answers the whole runtime, where libuv 1.52.0 answers 1. A Node
 * bump in image/Dockerfile can move libuv with nothing else in the repository noticing, and the suggestion would then
 * name a count the tools never read. So the image job runs `node -p process.versions.uv` inside the BUILT image and
 * compares it here, failing with the step that has to come first: read the rule again at the new libuv.
 *
 * Exact, never a range: libuv's minor releases are where this rule moved, and a patch release is still a release
 * nobody read. Exits 0 when they match, 1 on a difference or on an image whose Node did not answer.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SEEN_CPUS_LIBUV } from "../../worker/src/size-suggest.mjs";

/** The problem with an image's libuv version, or null when it is the one the rule was read at. */
export function libuvPinProblem(imageUv, want = SEEN_CPUS_LIBUV) {
	const got = typeof imageUv === "string" ? imageUv.trim() : "";
	if (!/^\d+\.\d+\.\d+$/.test(got)) return `the job image's Node did not report a libuv version (process.versions.uv answered ${JSON.stringify(got)})`;
	if (got === want) return null;
	return `the job image's Node bundles libuv ${got}, but worker/src/size-suggest.mjs read its CPU-count rule (seenCpusOf) at libuv ${want}. Read uv__get_constrained_cpu (src/unix/linux.c) and uv_available_parallelism (src/unix/core.c) at libuv ${got}, correct seenCpusOf and its tests where the rule moved (libuv 1.52.0 answers 1 under one CPU where ${want} skips it), then set SEEN_CPUS_LIBUV to ${got}.`;
}

/** `process.versions.uv` of the Node inside `image`, through docker. */
export function imageLibuv(image, run = (args) => execFileSync("docker", args, { encoding: "utf8" })) {
	return run(["run", "--rm", "--pull=never", "--entrypoint", "node", image, "-p", "process.versions.uv"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const image = process.argv[2];
	if (!image) {
		console.error("usage: node .github/scripts/libuv-pin-check.mjs <image-ref>");
		process.exit(2);
	}
	let answer = "";
	try {
		answer = imageLibuv(image);
	} catch (error) {
		answer = "";
		console.error(`docker could not run node in ${image}: ${error.message}`);
	}
	const problem = libuvPinProblem(answer);
	if (problem !== null) {
		console.error(`::error::${problem}`);
		process.exit(1);
	}
	console.log(`OK: the job image's Node bundles libuv ${SEEN_CPUS_LIBUV}, the one seenCpusOf was read at`);
}
