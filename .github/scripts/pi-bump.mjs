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
 *   3. Refuses a result it cannot vouch for (`bumpProblems`): a lockfile entry not resolved from the npm registry
 *      with an integrity hash, a workspace or link entry that changed beyond its pi pins, a package that gains an
 *      install script, a package.json that changed beyond its pin, a pin pi-pin-check rejects, or any file in the
 *      working tree other than the pin files and the lockfile.
 *
 * WHAT IT DOES NOT DO, deliberately: regenerate the derived pi tables (that runs pi's code; a person runs
 * `node .github/scripts/pi-derived.mjs --write` on the branch when worker/test/pi-derived.test.mjs goes red), or
 * move a content hash (a red hash test tells a person which copied logic to re-verify; moving it would turn the
 * review prompt into a rubber stamp).
 *
 * Idempotent: at the current pin it changes nothing (the pruned tree resolves back to the same lockfile).
 *
 * Usage: node .github/scripts/pi-bump.mjs <version> [--summary <file>] [--npm <npm command>]
 *        node .github/scripts/pi-bump.mjs decide                   reads TARGET, PULLS (a file); prints skip= and reason=
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
/** Exact, and no prerelease: a prerelease is not a release a job may run on. */
export const EXACT_VERSION_RE = /^\d+\.\d+\.\d+$/;

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
 *   - no package gains an install script it did not have. Versions of pi's own dependencies DO move (pi-ai pins its
 *     SDKs exactly: the 1.0.3 bump moved @anthropic-ai/sdk and esbuild), so a changed entry is allowed when it obeys
 *     the rest.
 */
export function lockfileProblems(beforeText, afterText) {
	const before = JSON.parse(beforeText).packages ?? {};
	const after = JSON.parse(afterText).packages ?? {};
	const problems = [];
	const scripted = new Set(Object.entries(before).filter(([, entry]) => entry?.hasInstallScript).map(([path]) => nameAt(path)));
	for (const [path, entry] of Object.entries(after)) {
		const name = nameAt(path);
		if (name === null || entry?.link) {
			if (withoutPiSpecs(entry) !== withoutPiSpecs(before[path])) problems.push(`package-lock.json's ${JSON.stringify(path)} changed beyond its pi pins`);
			continue;
		}
		if (typeof entry?.resolved !== "string" || !entry.resolved.startsWith(REGISTRY)) problems.push(`package-lock.json's ${path} is not resolved from ${REGISTRY}`);
		if (typeof entry?.integrity !== "string" || !/^sha512-/.test(entry.integrity)) problems.push(`package-lock.json's ${path} has no sha512 integrity`);
		if (entry?.hasInstallScript && !scripted.has(name)) problems.push(`package-lock.json's ${path} gains an install script`);
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

/**
 * The rolling pull request among a `GET /repos/{repo}/pulls?head=...` answer: the one whose head is BRANCH in THIS
 * repository. A fork's pull request can carry a branch of the same name, and must not count.
 */
export function rollingPulls(pulls, repo) {
	return (Array.isArray(pulls) ? pulls : []).filter((pull) => pull?.head?.ref === BRANCH && pull?.head?.repo?.full_name === repo && pull?.base?.repo?.full_name === repo);
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
		"- Fixes go on this branch as signed-off commits. A later run for a newer pi rebuilds the branch and drops them.",
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
	const lockOnly = () => run(npmArgs[0], [...npmArgs.slice(1), "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd });
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
		const pulls = rollingPulls(json(process.env.PULLS), process.env.GITHUB_REPOSITORY);
		const reason = skipReason({
			pinned,
			target: process.env.TARGET,
			openTitles: pulls.filter((p) => p.state === "open").map((p) => p.title),
			closedTitles: pulls.filter((p) => p.state === "closed" && !p.merged_at).map((p) => p.title),
		});
		console.log(`skip=${reason ? "true" : "false"}`);
		console.log(`reason=${reason ?? `pi ${process.env.TARGET} is newer than the pin ${pinned}`}`);
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
			console.error("usage: node .github/scripts/pi-bump.mjs <version> [--summary <file>] [--npm <npm command>] | decide | render <summary> <versions> <dir> | paths");
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
