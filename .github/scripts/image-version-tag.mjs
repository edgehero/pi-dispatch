/**
 * Decide whether an image.yml run may publish the PRODUCT VERSION tag (ghcr.io/edgehero/pi-job:<version>).
 *
 * `latest` and the sha tag move on every image push; the version tag is the one operators pin, and docs promise
 * it never moves once a release cut it. Before this script, every image/** merge re-pushed the unchanged root
 * version, so unreleased contents overwrote the released tag (it happened on the #291 merge). Issue #341.
 *
 * The version tag is published only when BOTH hold:
 *   (a) this run is a release: a push that CHANGED the root package.json version (compared with the pushed-over
 *       commit), or a manual dispatch that explicitly asks for it;
 *   (b) the tag is not on the registry yet.
 * (a) alone would republish over a tag an earlier run of the same bump already pushed; (b) alone would let a
 * later unreleased push publish as the version whenever a bump's own run was cancelled or failed. A git tag is
 * not used for either half: repo-release.yml creates `v<version>` on the same push and would race this job.
 *
 * FAILS CLOSED on anything it cannot read: an inspect that neither found the tag nor clearly said "not found"
 * (network, 5xx, rate limit, auth) fails the step rather than guessing. An unknowable previous version (a first
 * push, an unfetchable sha) is "not a release".
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const IMAGE = "ghcr.io/edgehero/pi-job";
const NOT_FOUND = /: not found\b|MANIFEST_UNKNOWN/i;

/** Pure. `inspect` is `{ code, output }` of `docker buildx imagetools inspect <image>:<version>`, or null if not asked. */
export function decideVersionTag({ event, dispatchWantsTag, versionBefore, versionNow, inspect }) {
	if (typeof versionNow !== "string" || versionNow === "") throw new Error("image-version-tag: no current version");
	const release = event === "workflow_dispatch" ? dispatchWantsTag === true : typeof versionBefore === "string" && versionBefore !== versionNow;
	if (!release) return { push: false, reason: event === "workflow_dispatch" ? "dispatch did not ask for the version tag" : "this push did not change the version" };
	if (!inspect) return { push: false, reason: "registry not asked", ask: true };
	if (inspect.code === 0) return { push: false, reason: `${IMAGE}:${versionNow} already exists; a released tag never moves` };
	if (NOT_FOUND.test(inspect.output ?? "")) return { push: true, reason: `${IMAGE}:${versionNow} is not on the registry yet` };
	throw new Error(`image-version-tag: could not tell whether ${IMAGE}:${versionNow} exists (exit ${inspect.code}); refusing to guess`);
}

function sh(cmd, args) {
	try {
		return { code: 0, output: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
	} catch (err) {
		return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

export function main({ env = process.env, run = sh, writeOutput = (line) => appendFileSync(env.GITHUB_OUTPUT, `${line}\n`), log = console.log } = {}) {
	const versionNow = env.VERSION;
	let versionBefore = null;
	const before = env.BEFORE_SHA ?? "";
	if (env.EVENT_NAME === "push" && /^[0-9a-f]{40}$/.test(before) && !/^0+$/.test(before)) {
		run("git", ["fetch", "--depth=1", "origin", before]);
		const shown = run("git", ["show", `${before}:package.json`]);
		if (shown.code === 0) {
			try {
				versionBefore = JSON.parse(shown.output).version ?? null;
			} catch {
				versionBefore = null;
			}
		}
	}
	const input = { event: env.EVENT_NAME, dispatchWantsTag: env.DISPATCH_PUSH_VERSION_TAG === "true", versionBefore, versionNow, inspect: null };
	let decision = decideVersionTag(input);
	if (decision.ask) decision = decideVersionTag({ ...input, inspect: run("docker", ["buildx", "imagetools", "inspect", `${IMAGE}:${versionNow}`]) });
	log(`version tag ${versionNow}: ${decision.push ? "push" : "skip"} (${decision.reason}; previous version ${versionBefore ?? "unknown"})`);
	writeOutput(`push=${decision.push}`);
	return decision;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
