import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { bump, BUMP_PATHS, compareVersions, LOCKFILE, lockedPiNames, lockfileProblems, packageProblems, PI_PIN_SITES, prunePiTree, renderPullRequest, rewriteOverrides, rewriteSite, rollingPulls, ROOT_PACKAGE, siteVersion, skipReason, titleFor, treeProblems, versionsBetween } from "../../.github/scripts/pi-bump.mjs";
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
	const pull = (owner, extra = {}) => ({ title: titleFor("1.0.4"), state: "open", head: { ref: "chore/pi-bump", repo: { full_name: `${owner}/pi-dispatch` } }, base: { repo: { full_name: "edgehero/pi-dispatch" } }, ...extra });
	assert.equal(rollingPulls([pull("edgehero"), pull("mallory")], "edgehero/pi-dispatch").length, 1);
	assert.deepEqual(rollingPulls([pull("mallory")], "edgehero/pi-dispatch"), []);
	assert.deepEqual(rollingPulls([pull("edgehero", { head: { ref: "other", repo: { full_name: "edgehero/pi-dispatch" } } })], "edgehero/pi-dispatch"), []);
	assert.deepEqual(rollingPulls({ message: "Not Found" }, "edgehero/pi-dispatch"), []);
});

test("only an exact newer release is bumped to, once: not a prerelease, a downgrade, the pin, or a version already carried or closed", () => {
	assert.equal(skipReason({ pinned: "1.0.3", target: "1.0.4" }), null);
	assert.match(skipReason({ pinned: "1.0.3", target: "1.0.3" }), /already the pin/);
	assert.match(skipReason({ pinned: "1.0.3", target: "1.0.2" }), /older than the pin 1\.0\.3/);
	assert.match(skipReason({ pinned: "0.99.10", target: "0.99.9" }), /older/, "numeric, not string, order");
	for (const bad of ["latest", "1.0.4-rc.1", "^1.0.4", "1.0", " 1.0.4", "1.0.4\nx", undefined]) assert.match(skipReason({ pinned: "1.0.3", target: bad }), /not an exact release version/, String(bad));
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
	const lockRun = "npx npm@10.9.3 install --package-lock-only --ignore-scripts --no-audit --no-fund";
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
