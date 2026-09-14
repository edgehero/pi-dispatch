/**
 * Decide whether an image workflow run may publish the PRODUCT VERSION tag (`<image>:<version>`). image.yml
 * (ghcr.io/edgehero/pi-job) and receiver-image.yml (ghcr.io/edgehero/pi-dispatch-receiver) both call it, each
 * passing its own `IMAGE`.
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
 * (network, 5xx, rate limit, auth) fails the step rather than guessing, and so does a pushed-over commit that
 * could not be fetched or read, because skipping there would silently drop a real release's tag. Only a push with
 * no previous commit at all (an all-zero or absent sha) is "not a release".
 *
 * RECOVERY: both workflows run under `concurrency` with `cancel-in-progress: false`, which still CANCELS a pending
 * run when a newer one queues, so a bump's run can be lost. Every later push that is not a release therefore
 * checks the registry anyway and WARNS when the released tag is missing. The fix is a manual dispatch with
 * `push_version_tag` on the release tag itself (`gh workflow run <workflow> --ref v<version> -f
 * push_version_tag=true`): a dispatch asking for the version tag is refused unless the commit it builds IS the
 * one `v<version>` names, so recovery cannot publish unreleased main under a released version, and that dispatch
 * does not move `latest` (the workflows gate it). `gh run rerun` of the lost run is NOT the fix: it would move
 * `latest` back to the release commit.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_IMAGE = "ghcr.io/edgehero/pi-job";
const NOT_FOUND = /: not found\b|MANIFEST_UNKNOWN/i;

/** Pure. `inspect` is `{ code, output }` of `docker buildx imagetools inspect <image>:<version>`, or null if not asked. */
export function decideVersionTag({ event, dispatchWantsTag, versionBefore, versionNow, inspect, image = DEFAULT_IMAGE }) {
	if (typeof versionNow !== "string" || versionNow === "") throw new Error("image-version-tag: no current version");
	const release = event === "workflow_dispatch" ? dispatchWantsTag === true : typeof versionBefore === "string" && versionBefore !== versionNow;
	if (!release) return { push: false, reason: event === "workflow_dispatch" ? "dispatch did not ask for the version tag" : "this push did not change the version" };
	if (!inspect) return { push: false, reason: "registry not asked", ask: true };
	if (inspect.code === 0) return { push: false, reason: `${image}:${versionNow} already exists; a released tag never moves` };
	if (NOT_FOUND.test(inspect.output ?? "")) return { push: true, reason: `${image}:${versionNow} is not on the registry yet` };
	throw new Error(`image-version-tag: could not tell whether ${image}:${versionNow} exists (exit ${inspect.code}); refusing to guess`);
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
	const image = env.IMAGE || DEFAULT_IMAGE;
	let versionBefore = null;
	const before = env.BEFORE_SHA ?? "";
	if (env.EVENT_NAME === "push" && /^[0-9a-f]{40}$/.test(before) && !/^0+$/.test(before)) {
		const fetched = run("git", ["fetch", "--depth=1", "origin", before]);
		const shown = fetched.code === 0 ? run("git", ["show", `${before}:package.json`]) : fetched;
		try {
			if (shown.code !== 0) throw new Error(`exit ${shown.code}`);
			versionBefore = JSON.parse(shown.output).version;
			if (typeof versionBefore !== "string") throw new Error("no version field");
		} catch (err) {
			throw new Error(`image-version-tag: could not read the root version at the pushed-over commit ${before} (${err.message}); refusing to guess whether this push is a release`);
		}
	}
	const dispatchWantsTag = env.DISPATCH_PUSH_VERSION_TAG === "true";
	if (env.EVENT_NAME === "workflow_dispatch" && dispatchWantsTag) {
		const tagged = releaseTagCommit(run("git", ["ls-remote", "--tags", "origin", `refs/tags/v${versionNow}`, `refs/tags/v${versionNow}^{}`]));
		if (!tagged || tagged !== env.GITHUB_SHA) {
			throw new Error(
				`image-version-tag: a dispatch that publishes ${image}:${versionNow} must build the commit v${versionNow} names (${tagged ?? "no such tag"}), not ${env.GITHUB_SHA}; run it with --ref v${versionNow}`,
			);
		}
	}
	const input = { event: env.EVENT_NAME, dispatchWantsTag, versionBefore, versionNow, inspect: null, image };
	let decision = decideVersionTag(input);
	if (decision.ask) decision = decideVersionTag({ ...input, inspect: run("docker", ["buildx", "imagetools", "inspect", `${image}:${versionNow}`]) });
	else if (env.EVENT_NAME === "push") {
		// Not a release, but still worth one look: a bump whose own run was cancelled leaves a released version with
		// no tag, and nothing else would ever say so. A warning, never a failure: this push's own tags are unaffected.
		const seen = run("docker", ["buildx", "imagetools", "inspect", `${image}:${versionNow}`]);
		if (seen.code !== 0 && NOT_FOUND.test(seen.output ?? "")) {
			log(`::warning::${image}:${versionNow} is not on the registry although v${versionNow} is the current version; publish it with: gh workflow run --ref v${versionNow} -f push_version_tag=true`);
		}
	}
	log(`version tag ${versionNow}: ${decision.push ? "push" : "skip"} (${decision.reason}; previous version ${versionBefore ?? "unknown"})`);
	writeOutput(`push=${decision.push}`);
	return decision;
}

/** The commit a `git ls-remote` of `v<version>` and its peeled form names (the peeled one wins, for an annotated tag). */
export function releaseTagCommit(result) {
	if (result?.code !== 0) return null;
	let direct = null;
	let peeled = null;
	for (const line of String(result.output ?? "").split("\n")) {
		const [sha, ref] = line.trim().split(/\s+/);
		if (!/^[0-9a-f]{40}$/.test(sha ?? "")) continue;
		if (ref?.endsWith("^{}")) peeled = sha;
		else direct = sha;
	}
	return peeled ?? direct;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
