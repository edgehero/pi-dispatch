import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { alreadyNoticed, baseMovedUnder, branchTip, bump, BUMP_AUTHOR, BUMP_COMMITTER, BUMP_PATHS, compareVersions, decide, fixupsOn, heldNotice, LOCKFILE, lockedPiNames, lockfileProblems, packageProblems, PI_PIN_SITES, prunePiTree, renderPullRequest, rewriteOverrides, rewriteSite, rollingPulls, ROOT_PACKAGE, siteVersion, skipReason, titleFor, treeProblems, versionsBetween } from "../../.github/scripts/pi-bump.mjs";
import { piPinProblems, repositoryPins } from "../../.github/scripts/pi-pin-check.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #587: the automated pi bump rewrites every pin from ONE table and re-resolves the lockfile, runs no pi code,
// and refuses any result it cannot vouch for. This holds the table to pi-pin-check in both directions, the refusals,
// and the bump's steps on a scratch copy with npm and git played by a fake.

const repo = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repo), "utf8");
const PIN = siteVersion(PI_PIN_SITES[0], read(PI_PIN_SITES[0].path));
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

/** A scratch repository holding this repository's bump files, as a file URL ending in "/". */
function scratch(files = Object.fromEntries(BUMP_PATHS.map((path) => [path, read(path)]))) {
	const dir = tempDir("pi-bump-");
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return pathToFileURL(`${dir}/`);
}

/** A lockfile with every pi entry at `version`, as npm would leave it under overrides at that version. */
function lockAt(text, version) {
	const lock = JSON.parse(text);
	for (const [path, entry] of Object.entries(lock.packages)) if (path.includes("node_modules/@earendil-works/")) entry.version = version;
	return `${JSON.stringify(lock, null, 2)}\n`;
}

const entry = (name, version = "1.0.0", extra = {}) => ({ version, resolved: `https://registry.npmjs.org/${name}/-/x-${version}.tgz`, integrity: "sha512-abc", ...extra });

test("the bump's table covers every pin pi-pin-check checks, and pi-pin-check checks every row of the table", () => {
	const all = (skip) => {
		const files = Object.fromEntries(BUMP_PATHS.map((path) => [path, read(path)]));
		for (const site of PI_PIN_SITES) if (site.path !== skip) files[site.path] = rewriteSite(site, files[site.path], "9.9.9");
		if (skip !== ROOT_PACKAGE) files[ROOT_PACKAGE] = rewriteOverrides(files[ROOT_PACKAGE], "9.9.9");
		if (skip !== LOCKFILE) files[LOCKFILE] = lockAt(files[LOCKFILE], "9.9.9");
		return piPinProblems(repositoryPins(scratch(files)));
	};
	assert.deepEqual(all(null), [], "every site the table rewrites is every site pi-pin-check reads: none is left at the old pin");
	for (const path of BUMP_PATHS.slice(1)) {
		const problems = all(path);
		const named = { [ROOT_PACKAGE]: "overrides", [LOCKFILE]: "package-lock.json" }[path] ?? path;
		assert.ok(problems.length > 0 && problems.every((p) => p.includes(named)), `${path}: left behind, pi-pin-check names it (${problems.join("; ")})`);
	}
	assert.ok(all(PI_PIN_SITES[0].path).length >= PI_PIN_SITES.length - 1, "the runner's pin is the one the others are held to");
});

test("a package.json site rewrites exactly its one value, leaving a wildcard peer of the same package alone", () => {
	const admin = PI_PIN_SITES.find((site) => site.path === "admin/package.json");
	const text = '{\n  "peerDependencies": {\n    "@earendil-works/pi-coding-agent": "*"\n  },\n  "devDependencies": {\n    "@earendil-works/pi-coding-agent": "1.0.3"\n  }\n}\n';
	assert.equal(rewriteSite(admin, text, "1.0.4"), text.replace('"1.0.3"', '"1.0.4"'));
	assert.throws(() => rewriteSite(admin, text.replace('"*"', '"1.0.3"'), "1.0.4"), /2 entries read/, "two entries at the old value: which one is the pin is not guessed");
	assert.throws(() => siteVersion(admin, '{"devDependencies":{}}'), /admin\/package\.json: no devDependencies\.@earendil-works\/pi-coding-agent/);
	const docker = PI_PIN_SITES.find((site) => site.path === "image/Dockerfile");
	assert.equal(rewriteSite(docker, "FROM x\nARG PI_VERSION=1.0.3\nLABEL v=${PI_VERSION}\n", "1.0.4"), "FROM x\nARG PI_VERSION=1.0.4\nLABEL v=${PI_VERSION}\n");
	assert.throws(() => siteVersion(docker, "ARG PI_VERSION\n"), /image\/Dockerfile: no line/);
});

test("the overrides move every pi package and may add only pi packages, and only a package.json that round-trips is rewritten", () => {
	const root = `${JSON.stringify({ name: "x", overrides: { "@earendil-works/pi-ai": "1.0.3", other: "2.0.0" } }, null, 2)}\n`;
	assert.deepEqual(JSON.parse(rewriteOverrides(root, "1.0.4", ["@earendil-works/pi-new"])).overrides, { "@earendil-works/pi-ai": "1.0.4", other: "2.0.0", "@earendil-works/pi-new": "1.0.4" });
	assert.throws(() => rewriteOverrides(root, "1.0.4", ["left-pad"]), /is not a pi package/);
	assert.throws(() => rewriteOverrides(root, "1.0.4", ["@earendil-works/x/y"]), /is not a pi package/);
	assert.throws(() => rewriteOverrides(root.replace(/\n {2}/g, "\n\t"), "1.0.4"), /does not round-trip/);
});

test("the prune takes pi's whole tree, at any depth and in any workspace, and nothing else", () => {
	const lock = { lockfileVersion: 3, packages: { "": {}, "node_modules/undici": { version: "8.10.2" }, "node_modules/@earendil-works/pi-ai": {}, "admin/node_modules/@earendil-works/pi-coding-agent": {}, "node_modules/@earendil-works/pi-coding-agent/node_modules/lru-cache": {}, "node_modules/@earendil-works-not/x": {} } };
	assert.deepEqual(Object.keys(JSON.parse(prunePiTree(JSON.stringify(lock))).packages), ["", "node_modules/undici", "node_modules/@earendil-works-not/x"]);
	assert.deepEqual(lockedPiNames(lock), ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]);
});

test("a resolved lockfile is refused unless every entry is from the registry with integrity, the workspaces moved only their pi pins, and no package gained an install script", () => {
	const lock = (packages) => JSON.stringify({ lockfileVersion: 3, packages });
	const before = {
		"": { name: "root", workspaces: ["worker"] },
		worker: { name: "w", dependencies: { "@earendil-works/pi-ai": "1.0.3", bullmq: "5.80.4" } },
		"node_modules/@edgehero/w": { resolved: "worker", link: true },
		"node_modules/@earendil-works/pi-ai": entry("@earendil-works/pi-ai", "1.0.3"),
		"node_modules/esbuild": entry("esbuild", "0.28.1", { hasInstallScript: true }),
		"node_modules/bullmq": entry("bullmq", "5.80.4"),
	};
	const bumped = () => ({ ...structuredClone(before), worker: { name: "w", dependencies: { "@earendil-works/pi-ai": "1.0.4", bullmq: "5.80.4" } }, "node_modules/@earendil-works/pi-ai": entry("@earendil-works/pi-ai", "1.0.4"), "node_modules/esbuild": entry("esbuild", "0.28.2", { hasInstallScript: true }), "node_modules/new-dep": entry("new-dep") });
	assert.deepEqual(lockfileProblems(lock(before), lock(bumped())), [], "pi's own dependencies may move and arrive, from the registry, with scripts only where they were");
	const refused = (edit, want) => {
		const after = bumped();
		edit(after);
		assert.deepEqual(lockfileProblems(lock(before), lock(after)), [want]);
	};
	refused((a) => (a["node_modules/new-dep"].resolved = "https://evil.example/new-dep.tgz"), "package-lock.json's node_modules/new-dep is not resolved from https://registry.npmjs.org/");
	refused((a) => (a["node_modules/new-dep"].resolved = "git+ssh://git@github.com/x/y.git"), "package-lock.json's node_modules/new-dep is not resolved from https://registry.npmjs.org/");
	refused((a) => delete a["node_modules/bullmq"].integrity, "package-lock.json's node_modules/bullmq has no sha512 integrity");
	refused((a) => (a["node_modules/new-dep"].hasInstallScript = true), "package-lock.json's node_modules/new-dep gains an install script");
	refused((a) => (a.worker.dependencies.bullmq = "5.81.0"), 'package-lock.json\'s "worker" changed beyond its pi pins');
	refused((a) => (a[""].workspaces = ["worker", "evil"]), 'package-lock.json\'s "" changed beyond its pi pins');
	refused((a) => (a["node_modules/@edgehero/w"].resolved = "evil"), 'package-lock.json\'s "node_modules/@edgehero/w" changed beyond its pi pins');
	refused((a) => delete a.worker, 'package-lock.json\'s "worker" is gone');
	assert.deepEqual(lockfileProblems(lock(before), JSON.stringify({ lockfileVersion: 3, evil: 1, packages: bumped() })), ["package-lock.json's top level changed beyond its packages"]);
	refused((a) => (a["node_modules/esbuild-alias"] = entry("evil", "1.0.0", { name: "evil", hasInstallScript: true })), "package-lock.json's node_modules/esbuild-alias gains an install script");
	refused((a) => (a["node_modules/bullmq"] = { ...a["node_modules/bullmq"], name: "evil", hasInstallScript: true }), "package-lock.json's node_modules/bullmq gains an install script");
	refused((a) => (a["node_modules/@edgehero/w"] = entry("@edgehero/w")), 'package-lock.json\'s "node_modules/@edgehero/w" changed beyond its pi pins');
	refused((a) => (a["node_modules/@earendil-works/pi-ai/node_modules/../../../../evil"] = entry("evil")), 'package-lock.json\'s key "node_modules/@earendil-works/pi-ai/node_modules/../../../../evil" is not an install path npm makes');
	refused((a) => (a["node_modules/.bin"] = entry("x")), 'package-lock.json\'s key "node_modules/.bin" is not an install path npm makes');
	refused((a) => (a["node_modules/x/lib"] = entry("x")), 'package-lock.json\'s key "node_modules/x/lib" is not an install path npm makes');
	const nested = bumped();
	nested["worker/node_modules/@earendil-works/pi-ai"] = entry("@earendil-works/pi-ai", "1.0.4");
	nested["node_modules/@scope/a/node_modules/b"] = entry("b");
	assert.deepEqual(lockfileProblems(lock(before), lock(nested)), [], "a workspace's own node_modules and a nested scoped install are paths npm makes");
	const realScripted = structuredClone(before);
	realScripted["node_modules/genai"] = entry("genai", "1.0.0", { name: "@google/genai", hasInstallScript: true });
	const moved = { ...bumped(), "node_modules/@google/genai": entry("@google/genai", "1.1.0", { hasInstallScript: true }) };
	assert.deepEqual(lockfileProblems(lock(realScripted), lock({ ...moved, "node_modules/genai": realScripted["node_modules/genai"] })), [], "standing follows the real name, wherever it is installed");
});

test("a package.json may change only by its pin, and the root only by its pi overrides", () => {
	const before = Object.fromEntries(BUMP_PATHS.filter((p) => p.endsWith("package.json")).map((p) => [p, read(p)]));
	const after = { ...before };
	for (const site of PI_PIN_SITES.filter((s) => s.json)) after[site.path] = rewriteSite(site, before[site.path], "9.9.9");
	after[ROOT_PACKAGE] = rewriteOverrides(before[ROOT_PACKAGE], "9.9.9", ["@earendil-works/pi-new"]);
	assert.deepEqual(packageProblems(before, after, "9.9.9"), []);
	const withScript = (text) => {
		const pkg = JSON.parse(text);
		pkg.scripts = { ...pkg.scripts, postinstall: "node x.js" };
		return JSON.stringify(pkg, null, 2);
	};
	assert.deepEqual(packageProblems(before, { ...after, "worker/package.json": withScript(after["worker/package.json"]) }, "9.9.9"), ["worker/package.json changed beyond its pi pin"]);
	assert.deepEqual(packageProblems(before, { ...after, [ROOT_PACKAGE]: withScript(after[ROOT_PACKAGE]) }, "9.9.9"), [`${ROOT_PACKAGE} changed beyond its pi overrides`]);
	const root = JSON.parse(after[ROOT_PACKAGE]);
	root.overrides["left-pad"] = "1.0.0";
	assert.deepEqual(packageProblems(before, { ...after, [ROOT_PACKAGE]: JSON.stringify(root) }, "9.9.9"), [`${ROOT_PACKAGE} changed beyond its pi overrides`], "a non-pi override is not a bump's to add");
});

test("the tree a bump commits holds only modified pin files and the lockfile", () => {
	const z = (...records) => `${records.join("\0")}\0`;
	assert.deepEqual(treeProblems(z(...BUMP_PATHS.map((p) => ` M ${p}`))), []);
	assert.deepEqual(treeProblems(""), []);
	assert.deepEqual(treeProblems(z(" M package.json", " M .github/workflows/release.yml")), ['the working tree holds " M" .github/workflows/release.yml; a pi bump only modifies ' + BUMP_PATHS.join(", ")]);
	assert.equal(treeProblems(z("?? image/runner/evil.mjs")).length, 1, "an untracked file");
	assert.equal(treeProblems(z(" D image/Dockerfile")).length, 1, "a deleted pin file");
	assert.equal(treeProblems(z("M  package.json")).length, 1, "anything already staged");
	assert.equal(treeProblems(z("R  package.json", "x.json")).length, 1, "a rename, whose second record is the old name");
});

test("only this repository's own rolling branch counts as the rolling pull request, never a fork's of the same name", () => {
	const pull = (owner, extra = {}) => ({ title: titleFor("1.0.4"), state: "open", head: { ref: "chore/pi-bump", repo: { full_name: `${owner}/pi-dispatch` } }, base: { ref: "main", repo: { full_name: "edgehero/pi-dispatch" } }, ...extra });
	assert.equal(rollingPulls([pull("edgehero"), pull("mallory")], "edgehero/pi-dispatch", "main").length, 1);
	assert.deepEqual(rollingPulls([pull("mallory")], "edgehero/pi-dispatch", "main"), []);
	assert.deepEqual(rollingPulls([pull("edgehero", { head: { ref: "other", repo: { full_name: "edgehero/pi-dispatch" } } })], "edgehero/pi-dispatch", "main"), []);
	assert.deepEqual(rollingPulls({ message: "Not Found" }, "edgehero/pi-dispatch", "main"), []);
	// A rolling pull request into another base is not this run's: a closed one there must not stop main's bump.
	const scratch = pull("edgehero", { state: "closed", merged_at: null, base: { ref: "scratch/pi-bump-proof", repo: { full_name: "edgehero/pi-dispatch" } } });
	assert.deepEqual(rollingPulls([scratch], "edgehero/pi-dispatch", "main"), []);
	assert.equal(rollingPulls([scratch], "edgehero/pi-dispatch", "scratch/pi-bump-proof").length, 1);
});

test("only an exact newer release is bumped to, once: not a prerelease, a downgrade, the pin, or a version already carried or closed", () => {
	assert.equal(skipReason({ pinned: "1.0.3", target: "1.0.4" }), null);
	assert.match(skipReason({ pinned: "1.0.3", target: "1.0.3" }), /already the pin/);
	assert.match(skipReason({ pinned: "1.0.3", target: "1.0.2" }), /older than the pin 1\.0\.3/);
	assert.match(skipReason({ pinned: "0.99.10", target: "0.99.9" }), /older/, "numeric, not string, order");
	for (const bad of ["latest", "1.0.4-rc.1", "^1.0.4", "1.0", " 1.0.4", "1.0.4\nx", "01.0.4", "1.00.4", "1.0.04", undefined]) assert.match(skipReason({ pinned: "1.0.3", target: bad }), /not an exact release version/, String(bad));
	assert.match(skipReason({ pinned: "1.0.3", target: "1.0.4", openTitles: [titleFor("1.0.4")] }), /already carries pi 1\.0\.4/);
	assert.equal(skipReason({ pinned: "1.0.3", target: "1.0.5", openTitles: [titleFor("1.0.4")] }), null, "a newer release replaces the open one");
	assert.match(skipReason({ pinned: "1.0.3", target: "1.0.4", closedTitles: [titleFor("1.0.4")] }), /closed unmerged/);
	assert.throws(() => bump({ repo: scratch(), version: "1.0.4-rc.1", run: () => "", log: () => {} }), /not an exact release version/);
	assert.throws(() => bump({ repo: scratch(), version: "latest", run: () => "", log: () => {} }), /not an exact release version/);
	assert.deepEqual(versionsBetween(["0.99.1", "1.0.0", "0.99.2", "1.0.1-rc.1", "1.0.3", "1.0.2", "1.0.1", "1.0.4", 7], "0.99.1", "1.0.3"), ["0.99.2", "1.0.0", "1.0.1", "1.0.2", "1.0.3"]);
	assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
});

test("the pull request is always a draft built only from validated versions, linking every release between them", () => {
	const pr = renderPullRequest({ from: "1.0.3", to: "1.0.5", versions: ["1.0.3", "1.0.4", "1.0.5", "1.0.6", "evil](x)"] });
	assert.equal(pr.title, "chore(pi): run on pi 1.0.5");
	assert.match(pr.body, /\*\*Always opened as a draft\.\*\*/);
	assert.match(pr.body, /^- \[v1\.0\.4\]\(https:\/\/github\.com\/earendil-works\/pi\/releases\/tag\/v1\.0\.4\)\n- \[v1\.0\.5\]\(https:\/\/github\.com\/earendil-works\/pi\/releases\/tag\/v1\.0\.5\)\n\n/m);
	assert.doesNotMatch(pr.body, /1\.0\.6|evil/);
	assert.match(pr.body, /node \.github\/scripts\/pi-derived\.mjs --write/);
	assert.match(pr.body, /## Review checklist \(OQ-005\)/);
	assert.match(pr.body, /Once it carries one, the workflow never rebuilds it: a newer pi waits, with a comment here, until this pull request is merged or closed\./, "fixes on the branch are kept");
	assert.doesNotMatch(pr.body, LONG_DASHES);
	assert.match(pr.commit, /^chore\(pi\): run on pi 1\.0\.5\n\nMoves every pi pin from 1\.0\.3 to 1\.0\.5 /);
	assert.match(renderPullRequest({ from: "1.0.3", to: "1.0.4", versions: [] }).body, /^- \[v1\.0\.4\]/m, "the target is linked even when the release list is empty");
	assert.throws(() => renderPullRequest({ from: "1.0.3", to: "1.0.4\n- [x](y)", versions: [] }), /not an exact version/);
});

/** npm and git, played: npm's lockfile run gives every overridden pi package a registry entry, git reports the tree. */
function fakeTools(at, { newPackage = false, extraFile = null, offRegistry = false } = {}) {
	const calls = [];
	const original = Object.fromEntries(BUMP_PATHS.map((p) => [p, read(p)]));
	let round = 0;
	const run = (cmd, args, { cwd }) => {
		calls.push([cmd, ...args].join(" "));
		if (cmd === "git") {
			const records = BUMP_PATHS.filter((p) => readFileSync(join(cwd, p), "utf8") !== original[p]).map((p) => ` M ${p}`);
			if (extraFile) records.push(` M ${extraFile}`);
			return records.map((r) => `${r}\0`).join("");
		}
		const lockPath = join(cwd, LOCKFILE);
		const lock = JSON.parse(readFileSync(lockPath, "utf8"));
		assert.deepEqual(lockedPiNames(lock), [], "npm sees the lockfile without pi's tree");
		const overrides = JSON.parse(readFileSync(join(cwd, ROOT_PACKAGE), "utf8")).overrides;
		for (const [name, version] of Object.entries(overrides)) lock.packages[`node_modules/${name}`] = entry(name, version);
		if ((round += 1) === 1 && newPackage) lock.packages["node_modules/@earendil-works/pi-new"] = entry("@earendil-works/pi-new");
		if (offRegistry) lock.packages["node_modules/sneaky"] = { version: "1.0.0", resolved: "https://evil.example/sneaky.tgz", integrity: "sha512-x" };
		for (const ws of ["image/runner", "worker", "admin"]) {
			for (const field of ["dependencies", "devDependencies"]) for (const name of Object.keys(lock.packages[ws][field] ?? {})) if (name.startsWith("@earendil-works/") && lock.packages[ws][field][name] !== "*") lock.packages[ws][field][name] = overrides[name];
		}
		writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
		return "";
	};
	return { run, calls };
}

test("a bump rewrites the pins, resolves the pruned tree metadata-only, pins a new pi package and resolves again", () => {
	const at = scratch();
	const { run, calls } = fakeTools(at, { newPackage: true });
	const summary = bump({ repo: at, version: "9.9.9", npm: "npx npm@10.9.3", run, log: () => {} });
	const lockRun = "npx npm@10.9.3 install --package-lock-only --ignore-scripts --git=/usr/bin/false --no-audit --no-fund";
	assert.deepEqual(calls, [lockRun, lockRun, "git status --porcelain=v1 -z --untracked-files=all"]);
	assert.equal(summary.from, PIN);
	assert.equal(summary.to, "9.9.9");
	assert.deepEqual(summary.changed, BUMP_PATHS);
	assert.deepEqual(summary.overrides, { added: ["@earendil-works/pi-new"] });
	assert.deepEqual(summary.problems, []);
});

test("a bump whose working tree holds anything else is refused", () => {
	const at = scratch();
	const { run } = fakeTools(at, { extraFile: ".github/workflows/release.yml" });
	const summary = bump({ repo: at, version: "9.9.9", run, log: () => {} });
	assert.deepEqual(summary.problems, [`the working tree holds " M" .github/workflows/release.yml; a pi bump only modifies ${BUMP_PATHS.join(", ")}`]);
});

test("a bump whose resolved lockfile holds an entry from outside the registry is refused", () => {
	const at = scratch();
	const { run } = fakeTools(at, { offRegistry: true });
	assert.deepEqual(bump({ repo: at, version: "9.9.9", run, log: () => {} }).problems, ["package-lock.json's node_modules/sneaky is not resolved from https://registry.npmjs.org/"]);
});

test("a bump at the pin changes nothing", () => {
	const at = scratch();
	const lock = read(LOCKFILE);
	const summary = bump({ repo: at, version: PIN, run: (cmd, args, { cwd }) => (cmd === "git" ? "" : writeFileSync(join(cwd, LOCKFILE), lock)), log: () => {} });
	assert.deepEqual(summary.changed, []);
	assert.deepEqual(summary.problems, []);
});

// Issue #587, the fixes a person pushes onto the bump's pull request. The workflow rebuilds the branch only while it
// holds nothing but its own commit; anything else holds the branch, and the open pull request gets one comment.

const REPO = "edgehero/pi-dispatch";
const TIP = "a".repeat(40);
const NEXT = PIN.replace(/\d+$/, (n) => String(Number(n) + 1));
const LATER = PIN.replace(/\d+$/, (n) => String(Number(n) + 2));
const commitOf = (subject = titleFor(NEXT), author = BUMP_AUTHOR, committer = BUMP_COMMITTER) => ({ sha: "b".repeat(40), commit: { message: `${subject}\n\nMoves every pi pin.\n\nSigned-off-by: ${author.name} <${author.email}>`, author: { ...author, date: "2026-10-06T07:23:40Z" }, committer: { ...committer, date: "2026-10-06T07:23:40Z" } } });
const botAhead = (edit = (a) => a) => edit({ status: "ahead", ahead_by: 1, total_commits: 1, commits: [commitOf()], files: BUMP_PATHS.map((filename) => ({ filename, status: "modified" })) });
const pullOf = (number, extra = {}) => ({ number, title: titleFor(NEXT), state: "open", merged_at: null, head: { ref: "chore/pi-bump", sha: TIP, repo: { full_name: REPO } }, base: { ref: "main", repo: { full_name: REPO } }, ...extra });
const decideFor = (over = {}) => decide({ pinned: PIN, target: LATER, repo: REPO, base: "main", pulls: [pullOf(594)], tip: TIP, ahead: botAhead(), behind: { files: [] }, ...over });

test("a branch holding only the workflow's own commit may be rebuilt; any other commit, path or author is a fix", () => {
	assert.deepEqual(fixupsOn(botAhead()), [], "one bump commit by the bump's author over the pin files and the lockfile");
	assert.deepEqual(fixupsOn(botAhead((a) => ({ ...a, files: a.files.slice(0, 2) }))), [], "a bump that moved fewer files is still the workflow's");
	const fix = { ...commitOf("fix(pi): the derived tables for pi 1.0.4"), sha: "c".repeat(40) };
	assert.deepEqual(fixupsOn(botAhead((a) => ({ ...a, ahead_by: 2, total_commits: 2, commits: [...a.commits, fix] }))), ["chore/pi-bump is 2 commits on its base, not the one bump commit", "a commit on chore/pi-bump is not a bump commit by its subject"], "an extra commit");
	assert.deepEqual(fixupsOn(botAhead((a) => ({ ...a, ahead_by: 2, total_commits: 2 }))), ["chore/pi-bump is 2 commits on its base, not the one bump commit"], "a count beyond the listed commits");
	assert.deepEqual(fixupsOn(botAhead((a) => ({ ...a, files: [...a.files, { filename: "worker/src/pricing.mjs", status: "modified" }] }))), ["chore/pi-bump changes a file a bump does not write"], "the bump's commit amended with another path");
	assert.deepEqual(fixupsOn(botAhead((a) => ({ ...a, files: [{ filename: "image/Dockerfile", status: "added" }] }))), ["chore/pi-bump changes a file a bump does not write"], "a pin file the bump would only modify");
	assert.deepEqual(fixupsOn(botAhead((a) => ({ ...a, files: [] }))), ["chore/pi-bump lists no changed file"]);
	for (const author of [{ name: "Someone Else", email: BUMP_AUTHOR.email }, { name: BUMP_AUTHOR.name, email: "someone@example.com" }]) {
		assert.deepEqual(fixupsOn(botAhead((a) => ({ ...a, commits: [commitOf(titleFor(NEXT), author)] }))), ["a commit on chore/pi-bump is not by the bump's author"], JSON.stringify(author));
	}
	assert.deepEqual(fixupsOn(botAhead((a) => ({ ...a, commits: [commitOf(titleFor(NEXT), BUMP_AUTHOR, BUMP_AUTHOR)] }))), ["a commit on chore/pi-bump was not committed by the workflow"], "the bump commit amended, rebased or squashed by a person: its committer is theirs");
	assert.deepEqual(fixupsOn(botAhead((a) => ({ ...a, commits: [commitOf(titleFor(NEXT), BUMP_AUTHOR, { name: "GitHub", email: BUMP_COMMITTER.email })] }))), ["a commit on chore/pi-bump was not committed by the workflow"], "the committer's name counts too");
	assert.notEqual(BUMP_COMMITTER.email, BUMP_AUTHOR.email, "a person committing as the author is not the workflow");
	for (const subject of [`${titleFor(NEXT)} and a fix`, "fix: x", titleFor("1.0.4-rc.1")]) assert.deepEqual(fixupsOn(botAhead((a) => ({ ...a, commits: [commitOf(subject)] }))), ["a commit on chore/pi-bump is not a bump commit by its subject"], subject);
	assert.notDeepEqual(fixupsOn(null), [], "an answer that is not a comparison is never read as the workflow's own commit");
});

test("the branch tip is read from the exact ref, and the base moving a bump file under it is seen", () => {
	const ref = (name, sha = TIP) => ({ ref: `refs/heads/${name}`, object: { sha } });
	assert.equal(branchTip([ref("chore/pi-bump-x", "c".repeat(40)), ref("chore/pi-bump")]), TIP);
	assert.equal(branchTip([ref("chore/pi-bump-x")]), null, "matching-refs matches a prefix");
	assert.equal(branchTip([]), null);
	assert.throws(() => branchTip([ref("chore/pi-bump", "x; rm -rf /")]), /not a commit/);
	assert.equal(baseMovedUnder({ files: [{ filename: "worker/src/x.mjs" }] }), false);
	assert.equal(baseMovedUnder({ files: [{ filename: "package-lock.json" }] }), true);
	assert.equal(baseMovedUnder({ files: [{ filename: "x.json", previous_filename: "worker/package.json" }] }), true);
	assert.equal(baseMovedUnder({ files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })) }), true, "a list the API cut short");
});

test("a newer pi rebuilds a branch without fixes, and holds one with fixes, commenting on its open pull request", () => {
	assert.deepEqual(decideFor({ tip: null, ahead: null, behind: null, pulls: [] }), { skip: false, reason: `pi ${LATER} is newer than the pin ${PIN}`, level: "notice", lease: "", held: null, notice: null }, "no branch: the push must find none");
	assert.deepEqual(decideFor(), { skip: false, reason: `pi ${LATER} is newer than the pin ${PIN}`, level: "notice", lease: TIP, held: null, notice: null }, "only the bump commit: rebuilt, leased to its tip");
	const fixed = botAhead((a) => ({ ...a, ahead_by: 2, total_commits: 2, commits: [...a.commits, commitOf("fix(pi): x")] }));
	const held = decideFor({ ahead: fixed });
	assert.equal(held.skip, true);
	assert.equal(held.held, 594);
	assert.equal(held.level, "notice", "held is the rule working, not a failure");
	assert.equal(held.lease, null);
	assert.equal(held.notice, heldNotice(LATER));
	assert.match(held.reason, /^pull request #594 carries fixes/);
	const carried = decideFor({ ahead: fixed, target: NEXT });
	assert.deepEqual([carried.skip, carried.held], [true, null], "the version it already carries: the plain skip, no comment");
	assert.match(carried.reason, /already carries/);
	assert.match(decideFor({ target: NEXT }).reason, /already carries/, "carried and the base moved nothing a bump writes");
	assert.match(decideFor({ ahead: fixed, target: "latest" }).reason, /not an exact release version/, "an input is refused before anything else");
});

test("a branch with fixes no open pull request holds is rebuilt only when a closed pull request keeps its tip", () => {
	const fixed = botAhead((a) => ({ ...a, commits: [commitOf("fix(pi): x")] }));
	const closed = (extra) => pullOf(594, { state: "closed", ...extra });
	const orphan = decideFor({ ahead: fixed, pulls: [] });
	assert.deepEqual([orphan.skip, orphan.level, orphan.held], [true, "warning", null], "a deleted pull request: its branch is a person's to resolve");
	assert.match(orphan.reason, /carries commits no pull request into main keeps/);
	assert.deepEqual([decideFor({ ahead: fixed, pulls: [closed()] }).skip, decideFor({ ahead: fixed, pulls: [closed()] }).lease], [false, TIP], "closed unmerged: GitHub keeps its commits");
	assert.equal(decideFor({ ahead: fixed, pulls: [closed({ merged_at: "2026-10-06T08:00:00Z" })] }).skip, false, "merged, the branch left");
	assert.equal(decideFor({ ahead: fixed, pulls: [closed({ head: { ...pullOf(1).head, sha: "c".repeat(40) } })] }).level, "warning", "pushed to after the close: nothing keeps that");
	assert.equal(decideFor({ ahead: fixed, pulls: [closed(), pullOf(600, { title: titleFor(NEXT) })] }).held, 600, "an open pull request on the same tip is still held");
	assert.equal(decideFor({ ahead: fixed, pulls: [closed(), pullOf(600, { base: { ref: "scratch", repo: { full_name: REPO } } })] }).level, "warning", "open into another base: not rebuilt from here");
	assert.match(decideFor({ ahead: fixed, target: NEXT, pulls: [closed({ title: titleFor(NEXT) })] }).reason, /closed unmerged/, "the closed version itself still is not retried");
});

test("a branch without fixes is rebuilt for the version it carries once the base changed a file the bump writes", () => {
	const moved = decideFor({ target: NEXT, behind: { files: [{ filename: "package-lock.json" }] } });
	assert.deepEqual([moved.skip, moved.lease], [false, TIP]);
	assert.match(moved.reason, /base changed a file the bump writes/);
	const fixed = botAhead((a) => ({ ...a, commits: [commitOf(titleFor(NEXT), { name: "Someone Else", email: "x@example.com" })] }));
	assert.match(decideFor({ ahead: fixed, target: NEXT, behind: { files: [{ filename: "package-lock.json" }] } }).reason, /already carries/, "with fixes, the conflict is a person's");
});

test("the comment on a held pull request is a fixed text from a validated version, posted once per version", () => {
	assert.equal(heldNotice("1.0.5"), "pi 1.0.5 is out. This pull request carries fixes, so the workflow did not rebuild it. Merge or close it, and the next run bumps to 1.0.5.\n");
	for (const bad of ["1.0.5\n@everyone", "latest", "1.0.5-rc.1", undefined]) assert.throws(() => heldNotice(bad), /not an exact version/, String(bad));
	assert.doesNotMatch(heldNotice("1.0.5"), LONG_DASHES);
	const pages = [[{ body: "looks fine" }], [{ body: heldNotice("1.0.5").trim() }]];
	assert.equal(alreadyNoticed(pages, heldNotice("1.0.5")), true, "a slurped listing, in any page");
	assert.equal(alreadyNoticed(pages, heldNotice("1.0.6")), false, "one comment per version");
	assert.equal(alreadyNoticed([{ body: `> ${heldNotice("1.0.5")}` }], heldNotice("1.0.5")), false, "a quote of it is not it");
	assert.equal(alreadyNoticed({ message: "Not Found" }, heldNotice("1.0.5")), false);
});

const WORKFLOW = read(".github/workflows/pi-bump.yml");

/** The `run:` block of the workflow step named `name`, dedented. */
function stepRun(name) {
	const lines = WORKFLOW.split("\n");
	const at = lines.findIndex((line) => line.trim() === `- name: ${name}`);
	assert.ok(at >= 0, `no step named ${name}`);
	const runAt = lines.findIndex((line, i) => i > at && /^\s+run: \|$/.test(line));
	const indent = lines[runAt + 1].match(/^ */)[0];
	const body = [];
	for (const line of lines.slice(runAt + 1)) {
		if (line.trim() !== "" && !line.startsWith(indent)) break;
		body.push(line.slice(indent.length));
	}
	return body.join("\n");
}

/** Runs a step with `gh` played by a script that answers from `answers` and logs every call. */
function runStep(name, { answers = {}, env = {}, temp = {} }) {
	const dir = tempDir("pi-bump-step-");
	mkdirSync(join(dir, "bin"));
	mkdirSync(join(dir, "temp"));
	for (const [file, value] of Object.entries(answers)) writeFileSync(join(dir, file), JSON.stringify(value));
	for (const [file, text] of Object.entries(temp)) writeFileSync(join(dir, "temp", file), text);
	const gh = [
		"#!/bin/bash",
		`printf '%s\\n' "$*" >> "${dir}/gh.log"`,
		`d="${dir}"`,
		'case "$*" in',
		'  *"pulls?state=all"*) cat "$d/pulls.json" ;;',
		'  *matching-refs*) cat "$d/refs.json" ;;',
		'  *"compare/$GITHUB_SHA..."*) cat "$d/ahead.json" ;;',
		'  *compare/*) cat "$d/behind.json" ;;',
		'  *"/comments"*) cat "$d/comments.json" ;;',
		'  "pr comment"*) echo "token=$GH_TOKEN" >> "$d/gh.log" ;;',
		'  *) exit 9 ;;',
		"esac",
		"",
	].join("\n");
	writeFileSync(join(dir, "bin", "gh"), gh);
	chmodSync(join(dir, "bin", "gh"), 0o755);
	writeFileSync(join(dir, "output"), "");
	const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", stepRun(name)], {
		cwd: fileURLToPath(repo),
		encoding: "utf8",
		env: { PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`, GITHUB_OUTPUT: join(dir, "output"), RUNNER_TEMP: join(dir, "temp"), GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_OWNER: "edgehero", GITHUB_SHA: "d".repeat(40), GH_TOKEN: "read-token", ...env },
	});
	const log = existsSync(join(dir, "gh.log")) ? readFileSync(join(dir, "gh.log"), "utf8") : "";
	return { ...result, dir, log, output: readFileSync(join(dir, "output"), "utf8") };
}

const DECIDE = "Resolve the target and decide whether there is a bump to make";
const NOTICE = "Tell a pull request with fixes that a newer pi waits for it";

test("the workflow's decide step reads the branch and its comparisons, and holds a branch with fixes", () => {
	const env = { INPUT_VERSION: LATER, BASE_BRANCH: "main" };
	const refs = [{ ref: "refs/heads/chore/pi-bump", object: { sha: TIP } }];
	const fixed = botAhead((a) => ({ ...a, ahead_by: 2, total_commits: 2, commits: [...a.commits, commitOf("fix(pi): x")] }));
	const held = runStep(DECIDE, { env, answers: { "pulls.json": [pullOf(594)], "refs.json": refs, "ahead.json": fixed, "behind.json": { files: [] } } });
	assert.equal(held.status, 0, held.stderr);
	assert.match(held.output, /^skip=true$/m);
	assert.match(held.output, /^held=594$/m);
	assert.doesNotMatch(held.output, /^(target|lease)=/m, "nothing is pushed");
	assert.equal(readFileSync(join(held.dir, "temp", "notice.md"), "utf8"), heldNotice(LATER));
	assert.match(held.log, new RegExp(`compare/${"d".repeat(40)}\\.\\.\\.${TIP}\n.*compare/${TIP}\\.\\.\\.${"d".repeat(40)}`), "ahead of and behind this run's own base");
	const rebuilt = runStep(DECIDE, { env, answers: { "pulls.json": [pullOf(594)], "refs.json": refs, "ahead.json": botAhead(), "behind.json": { files: [] } } });
	assert.equal(rebuilt.status, 0, rebuilt.stderr);
	assert.match(rebuilt.output, /^skip=false$/m);
	assert.match(rebuilt.output, new RegExp(`^lease=${TIP}$`, "m"));
	assert.match(rebuilt.output, new RegExp(`^target=${LATER.replaceAll(".", "\\.")}$`, "m"));
	const fresh = runStep(DECIDE, { env, answers: { "pulls.json": [], "refs.json": [] } });
	assert.equal(fresh.status, 0, fresh.stderr);
	assert.match(fresh.output, /^lease=$/m, "no branch: the lease says none may exist");
	assert.doesNotMatch(fresh.log, /compare/, "nothing to compare");
	const orphan = runStep(DECIDE, { env, answers: { "pulls.json": [], "refs.json": refs, "ahead.json": fixed, "behind.json": { files: [] } } });
	assert.match(orphan.stdout, /^::warning::chore\/pi-bump carries commits/m);
});

test("the workflow comments once per version, with the bump token, and pushes only over the tip it judged", () => {
	const notice = heldNotice(LATER);
	const comment = (comments) => runStep(NOTICE, { env: { HELD: "594", PI_BUMP_TOKEN: "bump-token" }, answers: { "comments.json": comments }, temp: { "notice.md": notice } });
	const first = comment([[{ body: "on it" }, { body: heldNotice(NEXT) }]]);
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.log, /^api --paginate --slurp repos\/edgehero\/pi-dispatch\/issues\/594\/comments\?per_page=100$/m, "read with the job's token");
	assert.match(first.log, new RegExp(`^pr comment 594 --repo edgehero/pi-dispatch --body-file ${first.dir}/temp/notice\\.md\ntoken=bump-token$`, "m"));
	const again = comment([[{ body: "on it" }], [{ body: notice }]]);
	assert.equal(again.status, 0, again.stderr);
	assert.doesNotMatch(again.log, /pr comment/, "already said for this version");
	assert.match(WORKFLOW, /^ {8}if: steps\.decide\.outputs\.held != ''$/m);
	const push = stepRun("Commit as Rob Boerman, signed off, and push the rolling branch");
	assert.match(push, /push "--force-with-lease=refs\/heads\/chore\/pi-bump:\$LEASE" /);
	assert.doesNotMatch(push, /--force(?!-with-lease)/, "never a bare force");
	assert.match(WORKFLOW, /LEASE: \$\{\{ steps\.decide\.outputs\.lease \}\}/);
	assert.match(push, new RegExp(`git config user\\.name "${BUMP_AUTHOR.name}"\ngit config user\\.email "${BUMP_AUTHOR.email.replaceAll(".", "\\.")}"`), "the workflow commits as the author fixupsOn recognises");
	assert.match(WORKFLOW, new RegExp(`LEASE: .*\n(?: {10}#.*\n)* {10}GIT_COMMITTER_NAME: "${BUMP_COMMITTER.name}"\n {10}GIT_COMMITTER_EMAIL: "${BUMP_COMMITTER.email.replaceAll(".", "\\.").replaceAll("+", "\\+")}"\n {8}run: \\|\n {10}mapfile`), "the push step commits as the committer fixupsOn recognises");
	const inputs = WORKFLOW.match(/^ {4}inputs:\n((?: {6}.*\n)+)/m)[1];
	assert.deepEqual(inputs.split("\n").filter((line) => /^ {6}\S/.test(line)), ["      version:"], "a manual run has no input that overrides the hold");
});
