/**
 * One exact version of one staged package, for one job (issue #796, `REQ-PACKAGE-UPDATES`, `DES-PACKAGE-UPDATES-PREPARED-NOT-APPLIED`).
 *
 * The candidate REPLACES the staged copy in this job's `PI_PACKAGES`: loaded beside it, which of the two wins would be pi's business and the run would prove nothing. It is
 * installed under this job's own directory and never in the overlay, which every job mounts whole, so a job running beside this one cannot see it.
 *
 * THE SPENDING ORDER, stated exactly because `CONST-BUDGET-BEFORE-TOKENS` is about this. Every free determinate refusal, including that the exact version exists, runs before the
 * token mint (`check`). The install needs the job directory, which on a job with a forge token comes after the mint, so it runs before the budget reservation and not before the
 * mint (`install`). No money is spent before the candidate is proven installable. A token minted first simply expires, as on any refusal after the mint.
 */
import * as nodeFs from "node:fs";
import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { CONTAINER_PACKAGES_ROOT, readStageManifest, stagedDirName } from "./packages.mjs";
import { parsePackageCanary } from "./package-canary-record.mjs";
import { PackageStageError, SERVICE_NPM_TIMEOUT_MS, npmExecOptions, npmFailureKind, serviceNpmEnv, stagePackageTree, stagedStem, treeDigest } from "./package-stage.mjs";
import { isSubscriptionAdapter } from "./updates-reconcile.mjs";
import { changelogExcerpt } from "./updates.mjs";

export { CANARY_LOADS, CANARY_RECORD_LOADS, parsePackageCanary, recordedPackageCanary } from "./package-canary-record.mjs";
export const PACKAGE_CANARY_SUBDIR = "canary";
export const PACKAGE_CANARY_REASONS = Object.freeze(["package-canary-invalid", "package-canary-packages-off", "package-canary-resume", "package-canary-not-staged", "package-canary-adapter", "package-canary-version-missing", "package-canary-refused"]);

/** The most of a changelog read, so a huge one costs nothing. What is kept of it is `changelogExcerpt`'s. */
const CHANGELOG_READ_MAX = 64 * 1024;

/**
 * Whether this path in `PI_PACKAGES` is a stage of the package `replaces` is a stage of. Compared on what stays the same between stages, because an Adopt may have moved the
 * manifest on since the free check. A candidate loaded beside the staged copy it was meant to replace is the one thing this must never allow.
 */
function sameStagedPackage(path, replaces) {
	return typeof path === "string" && stagedStem(basename(path)) === stagedStem(replaces);
}

/** The job's package list with the candidate in place of the staged copy. In its place, not appended: package order is pi's load order. */
export function withCanaryPath(paths, { replaces, tree }, jobRoot) {
	const candidate = `${jobRoot}/${PACKAGE_CANARY_SUBDIR}/${tree}`;
	let placed = false;
	const out = [];
	for (const path of paths) {
		if (!sameStagedPackage(path, replaces)) out.push(path);
		else if (!placed) {
			out.push(candidate);
			placed = true;
		}
	}
	if (!placed) out.push(candidate);
	return { paths: out, candidate };
}

/** The first lines of a package's changelog, as pi finds it (`pi.changelogPath`, else CHANGELOG.md), kept inside the package and bounded. */
export function readChangelog(root, fs = nodeFs) {
	try {
		const pkg = JSON.parse(fs.readFileSync(join(root, "package.json"), "utf8"));
		const declared = typeof pkg?.pi?.changelogPath === "string" ? pkg.pi.changelogPath : "CHANGELOG.md";
		if (declared.startsWith("/") || declared.split(/[\\/]/).includes("..")) return null;
		const path = join(root, declared);
		// Where it really is, not where it says: a link anywhere along the path, not only its last part, could reach any file on this host, and this text goes to every viewer.
		const real = fs.realpathSync(path);
		if (!real.startsWith(`${fs.realpathSync(root)}/`) && !real.startsWith(`${fs.realpathSync(root)}\\`)) return null;
		const stat = fs.lstatSync(path);
		if (!stat.isFile()) return null;
		const handle = fs.openSync(path, "r");
		try {
			const buffer = Buffer.alloc(Math.min(stat.size, CHANGELOG_READ_MAX));
			const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
			return changelogExcerpt(buffer.subarray(0, read).toString("utf8"));
		} finally {
			fs.closeSync(handle);
		}
	} catch {
		return null;
	}
}

/**
 * The runtime the processor asks, built once by the worker. `check` runs before the mint and `install` before the reservation. Both return `{ refused: reason }` for a determinate
 * answer, and throw `PackageStageError("infra")` for a registry that could not be asked, which the processor turns into a retry (`CONST-RETRY-INFRA-ONLY`).
 */
export function makePackageCanaryRuntime({ globalPiDir, env = process.env, exec = promisify(execFile), fs = nodeFs, platform = process.platform, publishFacts = async () => {}, host = null, now = Date.now, log = () => {} }) {
	const npmBin = platform === "win32" ? "npm.cmd" : "npm";
	const npmEnv = serviceNpmEnv(env);
	return {
		async check(job) {
			const canary = parsePackageCanary(job.packageCanary);
			if (!canary) return { refused: "package-canary-invalid" };
			// A trigger that withholds staged packages has no staged copy to replace, and a run of it would prove nothing about the job this package goes into.
			if (job.packages === false) return { refused: "package-canary-packages-off" };
			// A resuming trigger's next tick continues the transcript this job writes, with the candidate's work in it, so its effects would outlive the one job a person agreed to.
			if (job.resume === true) return { refused: "package-canary-resume" };
			if (isSubscriptionAdapter(canary.name)) return { refused: "package-canary-adapter" };
			const manifest = globalPiDir ? readStageManifest({ globalPiDir, readFile: (p, e) => fs.readFileSync(p, e), fileExists: (p) => fs.existsSync(p) }) : null;
			const staged = manifest?.packages.find((p) => p.name === canary.name) ?? null;
			if (!staged) return { refused: "package-canary-not-staged" };
			try {
				// Metadata only: no tarball, and nothing the package wrote runs. npm prints nothing, or says E404, for a version that is not there.
				const { stdout } = await exec(npmBin, ["view", `${canary.name}@${canary.version}`, "version", "--json", "--no-audit", "--no-fund", "--loglevel=error"], { ...npmExecOptions(platform, undefined, { timeoutMs: 30_000, env: npmEnv }) });
				if (String(stdout ?? "").trim() === "") return { refused: "package-canary-version-missing" };
			} catch (error) {
				if (npmFailureKind(error) === "not-found") return { refused: "package-canary-version-missing" };
				throw new PackageStageError("infra", "the registry could not be asked");
			}
			return { ok: true, canary, replaces: staged.dir };
		},

		async install(job, jobDir, { replaces }) {
			const canary = parsePackageCanary(job.packageCanary);
			if (!canary) return { refused: "package-canary-invalid" };
			const packagesRoot = join(jobDir, PACKAGE_CANARY_SUBDIR);
			fs.mkdirSync(packagesRoot, { recursive: true });
			let tree;
			try {
				({ dir: tree } = await stagePackageTree({ fs, exec, entry: { ...canary, dir: stagedDirName(canary.name) }, packagesRoot, npmBin, platform, timeoutMs: SERVICE_NPM_TIMEOUT_MS, env: npmEnv }));
			} catch (error) {
				if (error instanceof PackageStageError && error.kind !== "infra") return { refused: error.kind === "not-found" ? "package-canary-version-missing" : "package-canary-refused" };
				throw error instanceof PackageStageError ? error : new PackageStageError("infra", "the candidate could not be installed");
			}
			const root = join(packagesRoot, tree);
			try {
				// The excerpt is a third party's text, so it goes beside the host's facts and never on the run record. Display only: a failure costs the page a line.
				await publishFacts({ ...canary, host, digest: await treeDigest(root, { fs }), excerpt: readChangelog(root, fs), at: now() });
			} catch {
				log("package_canary_facts_unpublished", {});
			}
			return { replaces, tree };
		},
	};
}

/** Where a staged package sits in a job on the plain layout. Exported for a test to name the path it replaces. */
export const stagedContainerPath = (dir) => `${CONTAINER_PACKAGES_ROOT}/${dir}`;
