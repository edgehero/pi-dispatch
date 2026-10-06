/**
 * Moves every pi pin to one version, as the commit .github/workflows/pi-bump.yml pushes (issue #587,
 * CONST-PI-VERSION-PINNED). It never merges, and it never runs pi's code.
 *
 * CONST-PI-VERSION-PINNED makes a pi upgrade an explicit commit, and before this script that commit was made by hand:
 * the last one touched 82 files. This makes the mechanical part, the pins and the lockfile, so the workflow can open a
 * draft pull request for every new pi release. Everything that needs pi's code to judge (the suite, the derived pi
 * tables, the zero-spend smoke) is left to that pull request's own required checks, which run it the way they run
 * any pull request. That split is the security design, and a simpler one than it replaced: the job holding the write
 * token runs only this repository's code and npm's resolver, and executes nothing it downloads. An earlier design ran
 * the suite and the generators in a token-free job and carried their diff to the publishing job; checking a diff that
 * untrusted code wrote turned out to be a filter to get wrong, so no such diff exists any more.
 *
 * What it does, in order:
 *   1. Rewrites every exact pi pin from ONE table, PI_PIN_SITES (worker/test/pi-bump.test.mjs holds it to the sites
 *      .github/scripts/pi-pin-check.mjs checks, in both directions), and every `@earendil-works` entry in the root
 *      `overrides`.
 *   2. Prunes pi's tree from package-lock.json, then `npm install --package-lock-only --ignore-scripts`: npm reads
 *      registry metadata and writes the lockfile, and extracts and runs nothing. The prune is not tidiness. Measured on
 *      the 0.99.1 to 1.0.3 bump: with the old lockfile as the base, npm kept pi-coding-agent NESTED once per workspace
 *      instead of hoisting it, because the old tree had it there. A pi package the new release adds is pinned in the
 *      overrides and resolved again, so pi-pin-check holds it too.
 *   3. Refuses a result it cannot vouch for: a lockfile entry not resolved from the npm registry with an integrity
 *      hash, a key npm would not make, a workspace or link entry that changed beyond its pi pins, a package whose
 *      registry metadata gains an install script (it cannot see a binding.gyp, which npm builds at install; the pull
 *      request's review and CI are the real check), a package.json that changed beyond its pin, a pin pi-pin-check
 *      rejects, or any file in the working tree other than the pin files and the lockfile.
 *
 * WHAT IT DOES NOT DO, deliberately: regenerate the derived pi tables (that runs pi's code; a person runs
 * `node .github/scripts/pi-derived.mjs --write` on the branch when worker/test/pi-derived.test.mjs goes red), or
 * move a content hash (a red hash test tells a person which copied logic to re-verify; moving it would turn the
 * review prompt into a rubber stamp).
 *
 * Idempotent: at the current pin it changes nothing (the pruned tree resolves back to the same lockfile).
 *
 * A PERSON'S FIXES ARE NEVER OVERWRITTEN. `decide` rebuilds the branch only while it carries nothing but the
 * workflow's own commit (fixupsOn), or a closed pull request keeps its tip; otherwise the open pull request gets one
 * comment per new version and waits for a person to merge or close it. The push is leased to the tip `decide` saw.
 *
 * Usage: node .github/scripts/pi-bump.mjs <version> [--summary <file>] [--npm <npm command>]
 *        node .github/scripts/pi-bump.mjs tip                      reads REFS (a file); prints the branch's tip, or nothing
 *        node .github/scripts/pi-bump.mjs decide                   reads TARGET and the files PULLS, REFS, AHEAD, BEHIND;
 *                                                                  prints skip=, reason=, level=, and lease= or held=
 *                                                                  (writing the held pull request's comment to NOTICE)
 *        node .github/scripts/pi-bump.mjs noticed <comments> <notice>   prints noticed=true when a comment holds it
 *        node .github/scripts/pi-bump.mjs render <summary> <versions.json> <out dir>   writes title.txt, body.md, commit.txt
 *        node .github/scripts/pi-bump.mjs paths                    prints the paths a bump commit may hold, one per line
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { piPinProblems, repositoryPins } from "./pi-pin-check.mjs";

export const SCOPE = "@earendil-works/";
export const LOCKFILE = "package-lock.json";
export const ROOT_PACKAGE = "package.json";
export const BRANCH = "chore/pi-bump";
export const REGISTRY = "https://registry.npmjs.org/";
export const PI_RELEASES = "https://github.com/earendil-works/pi/releases/tag/v";
/** Exact, no leading zeros, and no prerelease: a prerelease is not a release a job may run on. */
export const EXACT_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Every hand-written pi pin. `json` is a path into a package.json; `line` a pattern whose group 1 is the version. The
 * root `overrides` and the lockfile are not rows: they hold every pi package, not one, and are handled below.
 */
export const PI_PIN_SITES = Object.freeze([
	{ path: "image/runner/package.json", json: ["dependencies", `${SCOPE}pi-coding-agent`] },
	{ path: "worker/package.json", json: ["dependencies", `${SCOPE}pi-ai`] },
	{ path: "admin/package.json", json: ["devDependencies", `${SCOPE}pi-coding-agent`] },
	{ path: "admin/src/index.ts", line: /^export const SUPPORTED_PI_VERSION = "([^"]*)";$/m },
	{ path: "image/Dockerfile", line: /^ARG PI_VERSION=(\S*)$/m },
]);

/** Every path a bump commit may hold. The workflow stages exactly these, and refuses a tree that changed anything else. */
export const BUMP_PATHS = Object.freeze([...PI_PIN_SITES.map((site) => site.path), ROOT_PACKAGE, LOCKFILE]);

export const titleFor = (version) => `chore(pi): run on pi ${version}`;

/** Who the workflow commits as. The workflow's `git config` lines are held to this by worker/test/pi-bump.test.mjs. */
export const BUMP_AUTHOR = Object.freeze({ name: "Rob Boerman", email: "robboerman@live.nl" });
/**
 * The committer the workflow alone commits as. Amending, rebasing, squashing, cherry-picking and GitHub's "update
 * branch" all rewrite the committer, so a bump commit a person reworked no longer reads as the workflow's own.
 */
export const BUMP_COMMITTER = Object.freeze({ name: "Rob Boerman", email: "robboerman+pi-bump@live.nl" });
/** The subject of the workflow's own bump commit: titleFor of an exact version, and nothing else. */
const BUMP_SUBJECT_RE = /^chore\(pi\): run on pi (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA_RE = /^[0-9a-f]{40}$/;

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const parts = (version) => version.split(".").map(Number);

/** -1, 0 or 1 for two exact versions. */
export function compareVersions(a, b) {
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
	return 0;
}

/** The exact releases after `from` up to and including `to`, oldest first. */
export function versionsBetween(all, from, to) {
	return all.filter((v) => typeof v === "string" && EXACT_VERSION_RE.test(v) && compareVersions(v, from) > 0 && compareVersions(v, to) <= 0).sort(compareVersions);
}

/** The version a site holds now. Throws when the site is missing, which means the table no longer matches the file. */
export function siteVersion(site, text) {
	if (site.json) {
		const value = site.json.reduce((node, key) => node?.[key], JSON.parse(text));
		if (typeof value !== "string") throw new Error(`${site.path}: no ${site.json.join(".")} to bump`);
		return value;
	}
	const match = site.line.exec(text);
	if (!match) throw new Error(`${site.path}: no line matching ${site.line} to bump`);
	return match[1];
}

/**
 * One site's text at `version`. A package.json is edited as TEXT (one of them does not round-trip through
 * JSON.stringify), and the edit is then checked by parsing: exactly the one value changed.
 */
export function rewriteSite(site, text, version) {
	const old = siteVersion(site, text);
	if (!site.json) return text.replace(site.line, (line, value) => line.replace(value, version));
	const key = site.json[site.json.length - 1];
	const re = new RegExp(`("${escapeRe(key)}"\\s*:\\s*)"${escapeRe(old)}"`, "g");
	const hits = text.match(re) ?? [];
	if (hits.length !== 1) throw new Error(`${site.path}: ${hits.length} entries read ${JSON.stringify(key)}: ${JSON.stringify(old)}, want exactly one to rewrite`);
	const next = text.replace(re, (_, head) => `${head}${JSON.stringify(version)}`);
	const want = JSON.parse(text);
	site.json.slice(0, -1).reduce((node, part) => node[part], want)[key] = version;
	if (JSON.stringify(JSON.parse(next)) !== JSON.stringify(want)) throw new Error(`${site.path}: the rewrite changed more than ${site.json.join(".")}`);
	return next;
}

/** The root package.json with every pi override, plus `add` (pi packages only), at `version`. It must round-trip. */
export function rewriteOverrides(text, version, add = []) {
	for (const name of add) if (!name.startsWith(SCOPE) || name.split("/").length !== 2) throw new Error(`${JSON.stringify(name)} is not a pi package; a bump adds only ${SCOPE}* overrides`);
	const root = JSON.parse(text);
	if (`${JSON.stringify(root, null, 2)}\n` !== text) throw new Error(`${ROOT_PACKAGE} does not round-trip through JSON.stringify, so its overrides cannot be rewritten safely`);
	const overrides = { ...(root.overrides ?? {}) };
	for (const name of [...Object.keys(overrides).filter((name) => name.startsWith(SCOPE)), ...add]) overrides[name] = version;
	root.overrides = overrides;
	return `${JSON.stringify(root, null, 2)}\n`;
}

/** The package name a lockfile path installs, or null for the root and the workspace entries. */
const nameAt = (path) => {
	const at = path.lastIndexOf("node_modules/");
	return at < 0 ? null : path.slice(at + "node_modules/".length);
};

/** The pi package names a lockfile holds, at any depth. */
export function lockedPiNames(lock) {
	const names = new Set();
	for (const path of Object.keys(lock.packages ?? {})) {
		const name = nameAt(path);
		if (name?.startsWith(SCOPE) && name.split("/").length === 2) names.add(name);
	}
	return [...names].sort();
}

/** The lockfile without pi's tree: every entry at or under a pi package, at any depth and in any workspace. */
export function prunePiTree(text) {
	const lock = JSON.parse(text);
	lock.packages = Object.fromEntries(Object.entries(lock.packages ?? {}).filter(([path]) => !path.includes(`node_modules/${SCOPE}`)));
	return `${JSON.stringify(lock, null, 2)}\n`;
}

/** A lockfile key below the root: `node_modules/<name>` segments, each name scoped or not, never `.`-led. */
const INSTALL_PATH_RE = /^(node_modules\/(@[^/]+\/)?[^/.][^/]*\/)*node_modules\/(@[^/]+\/)?[^/.][^/]*$/;

/** An entry with every pi dependency spec blanked, so two entries can be compared on everything else. */
function withoutPiSpecs(entry) {
	const copy = structuredClone(entry ?? null);
	for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		for (const name of Object.keys(copy?.[field] ?? {})) if (name.startsWith(SCOPE)) copy[field][name] = "<pi>";
	}
	return JSON.stringify(copy);
}

/**
 * Why a resolved lockfile is not one a bump may commit, or []. npm resolved it from the registry's metadata, and the
 * pull request's checks will `npm ci` it, so it is held to what a pi bump can honestly change:
 *   - every installed entry comes from the npm registry, with an integrity hash;
 *   - the root, workspace and link entries are unchanged except for their pi dependency specs;
 *   - no package (by its real name, so an alias cannot borrow another package's standing) gains an install script
 *     its registry metadata did not declare before. That is the metadata's `hasInstallScript` and nothing more: it
 *     cannot see a tarball's binding.gyp, which npm builds with node-gyp at install whatever the metadata says. The
 *     pull request's review and its own CI are the real check on what a package runs. Versions of pi's own
 *     dependencies DO move (pi-ai pins its SDKs exactly: the 1.0.3 bump moved @anthropic-ai/sdk and esbuild), so a
 *     changed entry is allowed when it obeys the rest;
 *   - every key is an install path npm makes: the root, a workspace, or a chain of `node_modules/<name>` segments,
 *     optionally under a workspace. No `..`, no dot-led name, nothing npm would write outside node_modules.
 */
export function lockfileProblems(beforeText, afterText) {
	const { packages: before = {}, ...beforeTop } = JSON.parse(beforeText);
	const { packages: after = {}, ...afterTop } = JSON.parse(afterText);
	const problems = [];
	if (JSON.stringify(afterTop) !== JSON.stringify(beforeTop)) problems.push("package-lock.json's top level changed beyond its packages");
	const realName = (path, entry) => (typeof entry?.name === "string" ? entry.name : nameAt(path));
	const scripted = new Set(Object.entries(before).filter(([, entry]) => entry?.hasInstallScript).map(([path, entry]) => realName(path, entry)));
	const workspaces = Object.keys(before).filter((path) => path !== "" && nameAt(path) === null);
	for (const [path, entry] of Object.entries(after)) {
		const name = nameAt(path);
		if (path !== "" && !workspaces.includes(path)) {
			const local = workspaces.find((ws) => path.startsWith(`${ws}/node_modules/`));
			if (!INSTALL_PATH_RE.test(local ? path.slice(local.length + 1) : path)) problems.push(`package-lock.json's key ${JSON.stringify(path)} is not an install path npm makes`);
		}
		if (name === null || entry?.link || before[path]?.link) {
			if (withoutPiSpecs(entry) !== withoutPiSpecs(before[path])) problems.push(`package-lock.json's ${JSON.stringify(path)} changed beyond its pi pins`);
			continue;
		}
		if (typeof entry?.resolved !== "string" || !entry.resolved.startsWith(REGISTRY)) problems.push(`package-lock.json's ${path} is not resolved from ${REGISTRY}`);
		if (typeof entry?.integrity !== "string" || !/^sha512-/.test(entry.integrity)) problems.push(`package-lock.json's ${path} has no sha512 integrity`);
		if (entry?.hasInstallScript && !scripted.has(realName(path, entry))) problems.push(`package-lock.json's ${path} gains an install script`);
	}
	for (const path of Object.keys(before)) if ((nameAt(path) === null || before[path]?.link) && !(path in after)) problems.push(`package-lock.json's ${JSON.stringify(path)} is gone`);
	return problems;
}

/**
 * Why the package.json files after a bump are not just the pin moved, or []. Each must equal its old self with the
 * pin at `version` (and the root's pi overrides at `version`, new pi names allowed): no script, no dependency, no
 * field a bump has no business touching.
 */
export function packageProblems(before, after, version) {
	const problems = [];
	for (const site of PI_PIN_SITES.filter((s) => s.json)) {
		const want = JSON.parse(before[site.path]);
		site.json.slice(0, -1).reduce((node, part) => node[part], want)[site.json.at(-1)] = version;
		if (JSON.stringify(JSON.parse(after[site.path])) !== JSON.stringify(want)) problems.push(`${site.path} changed beyond its pi pin`);
	}
	const root = JSON.parse(before[ROOT_PACKAGE]);
	const next = JSON.parse(after[ROOT_PACKAGE]);
	for (const [name, value] of Object.entries(next.overrides ?? {})) if (name.startsWith(SCOPE) && name.split("/").length === 2 && value === version) (root.overrides ??= {})[name] = version;
	if (JSON.stringify(next) !== JSON.stringify(root)) problems.push(`${ROOT_PACKAGE} changed beyond its pi overrides`);
	return problems;
}

/**
 * Why the working tree is not a bump commit, or []: `git status --porcelain=v1 -z --untracked-files=all` must list
 * only modified BUMP_PATHS. An untracked, added, deleted or renamed file, or any other modified one, is refused, so
 * what the workflow stages is exactly what this script wrote.
 */
export function treeProblems(porcelain) {
	const problems = [];
	const allowed = new Set(BUMP_PATHS);
	const records = porcelain.split("\0").filter(Boolean);
	for (let i = 0; i < records.length; i += 1) {
		const status = records[i].slice(0, 2);
		const path = records[i].slice(3);
		if (status[0] === "R" || status[0] === "C") i += 1;
		if (status !== " M" || !allowed.has(path)) problems.push(`the working tree holds ${JSON.stringify(status)} ${path}; a pi bump only modifies ${BUMP_PATHS.join(", ")}`);
	}
	return problems;
}

/** The pull requests whose head is BRANCH in THIS repository, into any base. */
const ownPulls = (pulls, repo) => (Array.isArray(pulls) ? pulls : []).filter((pull) => pull?.head?.ref === BRANCH && pull?.head?.repo?.full_name === repo);

/**
 * The rolling pull request among a `GET /repos/{repo}/pulls?head=...` answer: the one whose head is BRANCH in THIS
 * repository and whose base is the branch this run bumps. A fork's pull request can carry a branch of the same name,
 * and must not count. Neither may one into another base: a run on main once took a pull request into a scratch
 * branch for its own and rewrote it, and a pull request closed there would have stopped main's bump for good.
 */
export function rollingPulls(pulls, repo, base) {
	return ownPulls(pulls, repo).filter((pull) => pull?.base?.repo?.full_name === repo && pull?.base?.ref === base);
}

/**
 * Why this run commits nothing, or null when it should. `open` and `closed` are the rolling pull requests' titles. A
 * downgrade is a person's decision, and a version a person closed unmerged is not reopened every morning.
 */
export function skipReason({ pinned, target, openTitles = [], closedTitles = [] }) {
	if (!EXACT_VERSION_RE.test(target ?? "")) return `the target ${JSON.stringify(target)} is not an exact release version`;
	if (compareVersions(target, pinned) === 0) return `pi ${target} is already the pin`;
	if (compareVersions(target, pinned) < 0) return `pi ${target} is older than the pin ${pinned}; a downgrade is a person's decision`;
	if (openTitles.includes(titleFor(target))) return `the open ${BRANCH} pull request already carries pi ${target}`;
	if (closedTitles.includes(titleFor(target))) return `a ${BRANCH} pull request for pi ${target} was closed unmerged; bump it by hand to try again`;
	return null;
}

/**
 * The tip of BRANCH from a `GET /repos/{repo}/git/matching-refs/heads/chore/pi-bump` answer, or null when there is no
 * such branch. matching-refs matches a PREFIX, so `chore/pi-bump-x` is in the answer too and must not count.
 */
export function branchTip(refs) {
	const ref = (Array.isArray(refs) ? refs : []).find((r) => r?.ref === `refs/heads/${BRANCH}`);
	if (!ref) return null;
	if (!SHA_RE.test(ref.object?.sha ?? "")) throw new Error(`${BRANCH} points at ${JSON.stringify(ref.object?.sha)}, not a commit`);
	return ref.object.sha;
}

/**
 * What BRANCH carries beyond the workflow's own bump commit, or [] when it carries only that commit. `ahead` is a
 * `GET /repos/{repo}/compare/{base}...{tip}` answer: the commits on the branch since its merge base with the base, and
 * the files they change. The workflow's commit is exactly one commit on that merge base, with the subject titleFor
 * makes, by BUMP_AUTHOR, committed as BUMP_COMMITTER, changing only BUMP_PATHS. Anything else is a person's work (a fix, a merge of the base, a
 * regenerated table), and the workflow does not overwrite it.
 */
export function fixupsOn(ahead) {
	const commits = Array.isArray(ahead?.commits) ? ahead.commits : [];
	const files = Array.isArray(ahead?.files) ? ahead.files : [];
	const found = [];
	if (ahead?.ahead_by !== 1 || ahead?.total_commits !== 1 || commits.length !== 1) found.push(`${BRANCH} is ${ahead?.ahead_by} commits on its base, not the one bump commit`);
	for (const commit of commits) {
		const subject = String(commit?.commit?.message ?? "").split("\n")[0];
		const author = commit?.commit?.author ?? {};
		if (!BUMP_SUBJECT_RE.test(subject)) found.push(`a commit on ${BRANCH} is not a bump commit by its subject`);
		if (author.name !== BUMP_AUTHOR.name || author.email !== BUMP_AUTHOR.email) found.push(`a commit on ${BRANCH} is not by the bump's author`);
		const committer = commit?.commit?.committer ?? {};
		if (committer.name !== BUMP_COMMITTER.name || committer.email !== BUMP_COMMITTER.email) found.push(`a commit on ${BRANCH} was not committed by the workflow`);
	}
	if (files.length === 0) found.push(`${BRANCH} lists no changed file`);
	for (const file of files) if (file?.status !== "modified" || !BUMP_PATHS.includes(file?.filename)) found.push(`${BRANCH} changes a file a bump does not write`);
	return [...new Set(found)];
}

/**
 * Whether the base changed a file the bump commit writes since the branch was made. `behind` is a
 * `GET /repos/{repo}/compare/{tip}...{base}` answer. Then the bump commit is stale (the lockfile it re-resolved is not
 * the base's any more, and the pull request shows a conflict), so a branch without fixes is rebuilt on the base even
 * when it already carries the target. The compare API lists at most 300 files, so a list that long counts as stale.
 */
export function baseMovedUnder(behind) {
	const files = Array.isArray(behind?.files) ? behind.files : [];
	return files.length >= 300 || files.some((file) => BUMP_PATHS.includes(file?.filename) || BUMP_PATHS.includes(file?.previous_filename));
}

/** The comment a held pull request gets, from a validated version only. */
export function heldNotice(version) {
	if (!EXACT_VERSION_RE.test(version ?? "")) throw new Error(`${JSON.stringify(version)} is not an exact version`);
	return `pi ${version} is out. This pull request carries fixes, so the workflow did not rebuild it. Merge or close it, and the next run bumps to ${version}.\n`;
}

/** Whether a pull request's comments (one `GET .../issues/{n}/comments` page, or a slurped list of pages) hold `notice`. */
export function alreadyNoticed(comments, notice) {
	return (Array.isArray(comments) ? comments.flat() : []).some((comment) => typeof comment?.body === "string" && comment.body.trim() === notice.trim());
}

/**
 * The whole decision of one run. Returns `skip` and `reason`; `level` (notice or warning) for the annotation; `lease`,
 * the tip the push may replace ("" when the branch must not exist yet); and `held` and `notice` when a pull request
 * waits on a person and gets that comment.
 *
 * The rule that keeps a person's work: the branch is rebuilt only when it carries nothing but the workflow's own
 * commit (fixupsOn), or when a closed pull request still holds its tip (GitHub keeps a closed pull request's commits
 * under refs/pull/N/head, so nothing is lost). Otherwise nothing is pushed: an open pull request into this base gets
 * the comment, and a branch no pull request holds is left for a person, with a warning. No input overrides this. A
 * person closes the pull request or deletes the branch.
 */
export function decide({ pinned, target, repo, base, pulls, tip, ahead, behind }) {
	if (tip !== null && !SHA_RE.test(tip ?? "")) throw new Error(`${JSON.stringify(tip)} is not a commit`);
	const own = ownPulls(pulls, repo);
	const rolling = rollingPulls(pulls, repo, base);
	const open = rolling.filter((p) => p.state === "open");
	const fixups = tip ? fixupsOn(ahead) : [];
	const stale = tip !== null && fixups.length === 0 && baseMovedUnder(behind);
	const reason = skipReason({
		pinned,
		target,
		// A carried target is not a reason to stop when the base moved a bump file under the branch: it is rebuilt.
		openTitles: stale ? [] : open.map((p) => p.title),
		closedTitles: rolling.filter((p) => p.state === "closed" && !p.merged_at).map((p) => p.title),
	});
	if (reason) return { skip: true, reason, level: "notice", lease: null, held: null, notice: null };
	const keptByClosed = !own.some((p) => p.state === "open") && own.some((p) => p.state === "closed" && p.head?.sha === tip);
	if (fixups.length > 0 && !keptByClosed) {
		const pull = open.find((p) => Number.isInteger(p.number) && p.number > 0);
		if (pull) return { skip: true, reason: `pull request #${pull.number} carries fixes, so it is not rebuilt for pi ${target} until it is merged or closed (${fixups.join("; ")})`, level: "notice", lease: null, held: pull.number, notice: heldNotice(target) };
		return { skip: true, reason: `${BRANCH} carries commits no pull request into ${base} keeps, so it is not rebuilt for pi ${target}. Open a pull request for it, or delete the branch (${fixups.join("; ")})`, level: "warning", lease: null, held: null, notice: null };
	}
	const why = stale ? `the base changed a file the bump writes, so ${BRANCH} is rebuilt on it` : `pi ${target} is newer than the pin ${pinned}`;
	return { skip: false, reason: why, level: "notice", lease: tip ?? "", held: null, notice: null };
}

/** The pull request's title and body, and the commit message, from validated versions only: no text from outside. */
export function renderPullRequest({ from, to, versions }) {
	for (const v of [from, to]) if (!EXACT_VERSION_RE.test(v)) throw new Error(`${JSON.stringify(v)} is not an exact version`);
	const links = versionsBetween(versions, from, to);
	if (!links.includes(to)) links.push(to);
	const body = [
		`Moves every pi pin from ${from} to ${to} and re-resolves pi's tree in \`package-lock.json\`. Prepared by the pi bump workflow; a person reviews, makes it ready and merges it. Nothing here merges on its own (\`CONST-MERGE-NEVER-AUTOMATIC\`).`,
		"",
		"**Always opened as a draft.** The workflow runs no pi code, so it cannot say whether the bump holds. This pull request's own required checks do: the suite on the new pi, the pinned-assumption and derived-table tests, and the image job's zero-spend smoke. Each red check names what broke.",
		"",
		"## pi releases in this bump",
		"",
		"Read each one before merging. They are linked, not copied here.",
		"",
		...links.map((v) => `- [v${v}](${PI_RELEASES}${v})`),
		"",
		"## How to review",
		"",
		"- If `worker/test/pi-derived.test.mjs` is red, run `node .github/scripts/pi-derived.mjs --write` on this branch and commit the result. Read the hosts it reports added: **a new catalog host widens the cost guard** (a capped call there is bounded by the output field pi picks for it).",
		"- Every other red test is a pinned assumption about pi that no longer holds. Fix the code or the copy against the new release, never the assertion. A red content-hash test names the pi file that changed: re-verify the copy against it, then move the hash (`CLAUDE.md`, \"pi bumps\").",
		"- Fixes go on this branch as signed-off commits. Once it carries one, the workflow never rebuilds it: a newer pi waits, with a comment here, until this pull request is merged or closed. Without fixes, a run for a newer pi, or after the base changed a pin file or the lockfile, rebuilds the branch on the base.",
		"",
		"## Review checklist (OQ-005)",
		"",
		...[
			"Read each release above for a change to what pi reads from the environment, the model or auth wiring, the tools, or the package layout.",
			"`dist/core/sdk.d.ts` in the new tarball: `createAgentSession`'s options, how `model` is obtained, `excludeTools` still `string[]`.",
			"`EXCLUDABLE_TOOL_NAMES` matches `allToolNames`. If it moved, grow `image/runner/src/tools.mjs`, `docs/exclude-tools.md` and `triggers.example.json` with it, and check pi still ignores an unknown name silently.",
			"Every catalog host added: which output field pi sends there.",
			"The human-judged copies (provider steering variables, pricing pins, the admin's width table): their tests name what changed.",
			"Each red content-hash test: re-verify the copied logic against the named pi file, then update the hash in the same commit.",
			"The image job's zero-spend smoke passed: a fake key reaches the provider, gets a 401, is metered, and costs $0.",
			"The release notes name the new pi version.",
		].map((item) => `- [ ] ${item}`),
		"",
	].join("\n");
	const commit = [titleFor(to), "", `Moves every pi pin from ${from} to ${to} (the runner, the worker's pi-ai, the admin`, "devDependency and SUPPORTED_PI_VERSION, the image's PI_VERSION, the root overrides) and resolves", "pi's tree in package-lock.json again.", "", "Prepared by .github/workflows/pi-bump.yml. CONST-PI-VERSION-PINNED, REQ-UPSTREAM-CONTRACT-TESTS.", ""].join("\n");
	return { title: titleFor(to), body, commit };
}

/** Runs a command in the repository, inheriting stderr; throws with its name when it fails. */
function defaultRun(cmd, args, { cwd }) {
	const result = spawnSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", shell: false });
	if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${result.status ?? result.signal}`);
	return result.stdout;
}

/**
 * The bump itself. `repo` is a file URL ending in "/". `run(cmd, args, { cwd })` is the process seam: the test hands
 * in a fake that plays npm and git. Returns a summary whose `problems` must be empty for the result to be committed.
 */
export function bump({ repo, version, npm = "npm", run = defaultRun, log = (line) => console.error(line) }) {
	if (!EXACT_VERSION_RE.test(version)) throw new Error(`${JSON.stringify(version)} is not an exact release version (CONST-PI-VERSION-PINNED)`);
	const path = (p) => new URL(p, repo);
	const read = (p) => readFileSync(path(p), "utf8");
	const write = (p, text) => writeFileSync(path(p), text);
	const cwd = fileURLToPath(repo);
	const before = Object.fromEntries(BUMP_PATHS.map((p) => [p, read(p)]));
	const from = siteVersion(PI_PIN_SITES[0], before[PI_PIN_SITES[0].path]);

	for (const site of PI_PIN_SITES) write(site.path, rewriteSite(site, read(site.path), version));
	const overridesBefore = Object.keys(JSON.parse(read(ROOT_PACKAGE)).overrides ?? {}).filter((name) => name.startsWith(SCOPE));
	write(ROOT_PACKAGE, rewriteOverrides(read(ROOT_PACKAGE), version));
	write(LOCKFILE, prunePiTree(read(LOCKFILE)));
	const npmArgs = npm.split(" ");
	// --git=/usr/bin/false: a dependency from a git URL would make npm run git (and that repository's prepare script)
	// to resolve it. The tree has none, and a bump that brings one fails here instead of fetching it.
	const lockOnly = () => run(npmArgs[0], [...npmArgs.slice(1), "install", "--package-lock-only", "--ignore-scripts", "--git=/usr/bin/false", "--no-audit", "--no-fund"], { cwd });
	log(`pi-bump: ${from} -> ${version}: resolving the lockfile (metadata only, no package code runs)`);
	lockOnly();
	// A pi package the new release brings in is pinned too, then resolved again: once is enough, since an override adds
	// no package of its own.
	const unpinned = lockedPiNames(JSON.parse(read(LOCKFILE))).filter((name) => !JSON.parse(read(ROOT_PACKAGE)).overrides?.[name]);
	if (unpinned.length > 0) {
		log(`pi-bump: pinning ${unpinned.join(", ")} in the overrides, then resolving again`);
		write(ROOT_PACKAGE, rewriteOverrides(read(ROOT_PACKAGE), version, unpinned));
		write(LOCKFILE, prunePiTree(read(LOCKFILE)));
		lockOnly();
	}
	const after = Object.fromEntries(BUMP_PATHS.map((p) => [p, read(p)]));
	const problems = [
		...lockfileProblems(before[LOCKFILE], after[LOCKFILE]),
		...packageProblems(before, after, version),
		...piPinProblems(repositoryPins(repo)),
		...treeProblems(run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd })),
	];
	const overridesAfter = Object.keys(JSON.parse(after[ROOT_PACKAGE]).overrides ?? {}).filter((name) => name.startsWith(SCOPE));
	return {
		from,
		to: version,
		changed: BUMP_PATHS.filter((p) => after[p] !== before[p]),
		overrides: { added: overridesAfter.filter((name) => !overridesBefore.includes(name)) },
		problems,
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const option = (name) => {
		const at = args.indexOf(name);
		if (at < 0) return undefined;
		const [, value] = args.splice(at, 2);
		return value;
	};
	const repo = new URL("../../", import.meta.url);
	const json = (file) => JSON.parse(readFileSync(file, "utf8"));
	if (args[0] === "paths") {
		for (const p of BUMP_PATHS) console.log(p);
	} else if (args[0] === "decide") {
		const pinned = siteVersion(PI_PIN_SITES[0], readFileSync(new URL(PI_PIN_SITES[0].path, repo), "utf8"));
		const tip = branchTip(json(process.env.REFS));
		const verdict = decide({
			pinned,
			target: process.env.TARGET,
			repo: process.env.GITHUB_REPOSITORY,
			base: process.env.BASE_BRANCH,
			pulls: json(process.env.PULLS),
			tip,
			ahead: tip ? json(process.env.AHEAD) : null,
			behind: tip ? json(process.env.BEHIND) : null,
		});
		console.log(`skip=${verdict.skip}`);
		console.log(`reason=${verdict.reason}`);
		console.log(`level=${verdict.level}`);
		if (verdict.lease !== null) console.log(`lease=${verdict.lease}`);
		if (verdict.held !== null) {
			console.log(`held=${verdict.held}`);
			writeFileSync(process.env.NOTICE, verdict.notice);
		}
	} else if (args[0] === "tip") {
		console.log(branchTip(json(process.env.REFS)) ?? "");
	} else if (args[0] === "noticed") {
		console.log(`noticed=${alreadyNoticed(json(args[1]), readFileSync(args[2], "utf8"))}`);
	} else if (args[0] === "render") {
		const [, summaryFile, versionsFile, dir] = args;
		const { from, to } = json(summaryFile);
		const pr = renderPullRequest({ from, to, versions: json(versionsFile) });
		writeFileSync(join(dir, "title.txt"), `${pr.title}\n`);
		writeFileSync(join(dir, "body.md"), pr.body);
		writeFileSync(join(dir, "commit.txt"), pr.commit);
	} else {
		const summaryFile = option("--summary");
		const npm = option("--npm") ?? "npm";
		const [version] = args;
		if (!version) {
			console.error("usage: node .github/scripts/pi-bump.mjs <version> [--summary <file>] [--npm <npm command>] | decide | tip | noticed <comments> <notice> | render <summary> <versions> <dir> | paths");
			process.exit(2);
		}
		const summary = bump({ repo, version, npm });
		const text = `${JSON.stringify(summary, null, 2)}\n`;
		if (summaryFile) writeFileSync(summaryFile, text);
		process.stdout.write(text);
		for (const problem of summary.problems) console.error(`::error::${problem}`);
		if (summary.problems.length > 0) process.exit(1);
	}
}
