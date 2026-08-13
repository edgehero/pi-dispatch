import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTAINER_PACKAGES_ROOT, containerPackagePaths, mergeHostPackages, normalizeDiscoveredPackage, parsePackagesFile, readStagedSkills, readStageManifest, stagedDirName } from "../src/packages.mjs";

// parsePackagesFile is pure over the file TEXT -- no fs (mirrors triggers.test.mjs).
const PATH = "/pi-packages.json";
const parse = (packages) => parsePackagesFile(JSON.stringify({ packages }), PATH);
const isConfigError = (e) => e.piDispatchConfig === true;

const OK = { name: "@quintinshaw/pi-dynamic-workflows", version: "0.1.0" };

// --- stagedDirName ---

test("stagedDirName flattens a scope into one path segment and leaves a plain name alone", () => {
	assert.equal(stagedDirName("@quintinshaw/pi-dynamic-workflows"), "quintinshaw__pi-dynamic-workflows");
	assert.equal(stagedDirName("pi-widgets"), "pi-widgets");
	assert.equal(stagedDirName("@a/b"), "a__b");
	assert.equal(stagedDirName("@scope.io/name_2.x"), "scope.io__name_2.x");
	assert.equal(stagedDirName("a/b").includes("/"), false, "the staged dir is ONE segment -- never a nested path");
});

// --- parsePackagesFile: the happy path ---

test("a valid packages file normalizes to {name, version, dir}, dir defaulting from the name", () => {
	const parsed = parse([OK, { name: "pi-widgets", version: "1.4.2-rc.1+build.9", dir: "widgets" }]);
	assert.deepEqual(parsed, [
		{ name: "@quintinshaw/pi-dynamic-workflows", version: "0.1.0", dir: "quintinshaw__pi-dynamic-workflows" },
		{ name: "pi-widgets", version: "1.4.2-rc.1+build.9", dir: "widgets" },
	]);
});

test("an empty packages array is valid -> []", () => {
	assert.deepEqual(parse([]), []);
});

test("invalid JSON and a missing packages array are config errors naming the path", () => {
	assert.throws(() => parsePackagesFile("{ not json", PATH), (e) => isConfigError(e) && e.message.includes(PATH));
	assert.throws(() => parsePackagesFile(JSON.stringify({ nope: [] }), PATH), (e) => isConfigError(e) && e.message.includes(PATH));
	assert.throws(() => parsePackagesFile(JSON.stringify({ packages: {} }), PATH), isConfigError);
});

// --- parsePackagesFile: refusals ---

test("a non-object entry is a config error", () => {
	assert.throws(() => parse([7]), isConfigError);
	assert.throws(() => parse(["@scope/name"]), isConfigError);
	assert.throws(() => parse([null]), isConfigError);
	assert.throws(() => parse([["@scope/name", "1.0.0"]]), isConfigError);
});

test("a missing or malformed name is refused", () => {
	assert.throws(() => parse([{ version: "1.0.0" }]), (e) => isConfigError(e) && /name/.test(e.message));
	assert.throws(() => parse([{ name: "", version: "1.0.0" }]), isConfigError);
	assert.throws(() => parse([{ name: "Has Spaces", version: "1.0.0" }]), (e) => isConfigError(e) && /npm package name/.test(e.message));
	assert.throws(() => parse([{ name: "../escape", version: "1.0.0" }]), isConfigError);
	assert.throws(() => parse([{ name: `a${"b".repeat(220)}`, version: "1.0.0" }]), (e) => isConfigError(e) && /214/.test(e.message));
});

test("the admin package is refused by name and by dir -- it can enqueue paid jobs", () => {
	assert.throws(() => parse([{ name: "@edgehero/pi-dispatch-admin", version: "1.0.0" }]), (e) => isConfigError(e) && /admin/.test(e.message));
	assert.throws(() => parse([{ name: "dispatch-admin", version: "1.0.0" }]), isConfigError);
	assert.throws(() => parse([{ name: "pi-widgets", version: "1.0.0", dir: "pi-dispatch" }]), (e) => isConfigError(e) && /admin/.test(e.message));
});

test("a missing version is refused", () => {
	assert.throws(() => parse([{ name: "pi-widgets" }]), (e) => isConfigError(e) && /version/.test(e.message));
	assert.throws(() => parse([{ name: "pi-widgets", version: "" }]), isConfigError);
	assert.throws(() => parse([{ name: "pi-widgets", version: 1 }]), isConfigError);
});

test("a RANGE, tag, or wildcard version is refused, and the message explains the silent-no-op failure", () => {
	for (const version of ["^1.0.0", "~1.0.0", "latest", "1.x", "*", ">=1.0.0", "1.0", "next"]) {
		assert.throws(
			() => parse([{ name: "pi-widgets", version }]),
			(e) => isConfigError(e) && /EXACT/.test(e.message) && /no-op/.test(e.message) && /CONST-PI-VERSION-PINNED/.test(e.message),
			`version ${version} must be refused`,
		);
	}
});

test("a dir that is not a plain, contained segment is refused, pointing at an explicit dir", () => {
	assert.throws(() => parse([{ ...OK, dir: "../escape" }]), (e) => isConfigError(e) && /dir/.test(e.message));
	assert.throws(() => parse([{ ...OK, dir: ".." }]), isConfigError);
	assert.throws(() => parse([{ ...OK, dir: "nested/dir" }]), isConfigError);
	assert.throws(() => parse([{ ...OK, dir: "/abs" }]), isConfigError);
	assert.throws(() => parse([{ ...OK, dir: "" }]), isConfigError);
	assert.throws(() => parse([{ ...OK, dir: 7 }]), isConfigError);
});

test("a dir over 64 characters is refused (including one DERIVED from a long name)", () => {
	assert.throws(() => parse([{ ...OK, dir: "d".repeat(65) }]), (e) => isConfigError(e) && /64/.test(e.message) && /"dir"/.test(e.message));
	const longName = `@${"s".repeat(30)}/${"n".repeat(40)}`;
	assert.throws(() => parse([{ name: longName, version: "1.0.0" }]), (e) => isConfigError(e) && /64/.test(e.message));
	assert.deepEqual(parse([{ name: longName, version: "1.0.0", dir: "short" }])[0].dir, "short", "an explicit dir is the fix");
});

test("two packages sharing one staged dir are refused, naming BOTH", () => {
	assert.throws(
		() => parse([{ name: "@a/widgets", version: "1.0.0", dir: "widgets" }, { name: "@b/widgets", version: "2.0.0", dir: "widgets" }]),
		(e) => isConfigError(e) && e.message.includes("@a/widgets") && e.message.includes("@b/widgets"),
	);
});

// --- readStageManifest: the never-throws direction ---

test("readStageManifest returns the manifest when the staged receipt is well-formed", () => {
	const manifest = { stagedAt: "2026-07-28T00:00:00.000Z", packages: [{ name: "@a/b", version: "1.0.0", dir: "a__b", extra: "dropped" }] };
	const got = readStageManifest({
		globalPiDir: "/opt/overlay",
		fileExists: () => true,
		readFile: () => JSON.stringify(manifest),
	});
	// `from` is reconstructed from a closed enum and defaults to declared, so a pre-#102 receipt (no `from`
	// at all, as here) still reads correctly. Every OTHER unknown key is still dropped -- that is what keeps
	// an older worker safe against a receipt a newer one wrote.
	assert.deepEqual(got, { stagedAt: "2026-07-28T00:00:00.000Z", packages: [{ name: "@a/b", version: "1.0.0", dir: "a__b", from: "pi-packages" }] });
});

test("readStageManifest carries provenance as a closed enum, never a pass-through", () => {
	const read = (packages) => readStageManifest({ globalPiDir: "/opt/overlay", fileExists: () => true, readFile: () => JSON.stringify({ stagedAt: null, packages }) });
	const base = { name: "@a/b", version: "1.0.0", dir: "a__b" };

	assert.equal(read([{ ...base, from: "host" }]).packages[0].from, "host", "a discovered entry survives the round trip");
	assert.equal(read([base]).packages[0].from, "pi-packages", "a receipt written before #102 reads as declared");
	assert.equal(
		read([{ ...base, from: "<b>whatever an editor typed</b>" }]).packages[0].from,
		"pi-packages",
		"a hand-edited receipt cannot inject a string that reaches a printed doctor line",
	);
});

test("readStageManifest returns null and NEVER throws on missing, unreadable, or garbage input", () => {
	const read = (text, fileExists = () => true) => readStageManifest({ globalPiDir: "/opt/overlay", fileExists, readFile: () => text });
	assert.equal(readStageManifest({ globalPiDir: null }), null, "overlay off");
	assert.equal(readStageManifest({}), null);
	assert.equal(read("{}", () => false), null, "missing file");
	assert.equal(read("{ not json"), null);
	assert.equal(read("null"), null);
	assert.equal(read(JSON.stringify({ packages: "nope" })), null);
	assert.equal(read(JSON.stringify({ packages: [7] })), null);
	assert.equal(read(JSON.stringify({ packages: [{ name: "@a/b", version: "1.0.0" }] })), null, "an entry without a dir is garbage");
	assert.equal(read(JSON.stringify({ packages: [{ name: "@a/b", version: "1.0.0", dir: "../escape" }] })), null, "a dir that escapes is garbage");
	assert.equal(
		readStageManifest({
			globalPiDir: "/opt/overlay",
			fileExists: () => true,
			readFile: () => {
				throw new Error("EACCES");
			},
		}),
		null,
		"an unreadable manifest degrades to nothing staged, it does not crash the worker",
	);
	assert.deepEqual(read(JSON.stringify({ packages: [] })), { stagedAt: null, packages: [] });
});

// --- containerPackagePaths: the Windows path.join trap ---

test("containerPackagePaths builds POSIX container paths -- forward slashes even on Windows", () => {
	const paths = containerPackagePaths({ packages: [{ name: "@a/b", version: "1.0.0", dir: "a__b" }, { name: "w", version: "1.0.0", dir: "widgets" }] });
	// The LITERAL strings: these are paths INSIDE the Linux container, so path.join (backslashes on a
	// Windows worker host) would produce a spec pi cannot resolve.
	assert.deepEqual(paths, ["/opt/pi-global/packages/a__b", "/opt/pi-global/packages/widgets"]);
	assert.equal(paths.some((p) => p.includes("\\")), false, "never a backslash");
	assert.equal(CONTAINER_PACKAGES_ROOT, "/opt/pi-global/packages");
});

test("containerPackagePaths is empty for a null/garbage manifest (the overlay simply has nothing staged)", () => {
	assert.deepEqual(containerPackagePaths(null), []);
	assert.deepEqual(containerPackagePaths(undefined), []);
	assert.deepEqual(containerPackagePaths({}), []);
	assert.deepEqual(containerPackagePaths({ packages: [] }), []);
	assert.deepEqual(containerPackagePaths({ packages: [{ name: "x", version: "1.0.0" }] }), []);
});

// --- mergeHostPackages: declared beats discovered (issue #102) ----------------------------------------
//
// The rule these pin is that discovery reaches the SAME validator the declared path uses. That is what
// keeps the admin block, the exact-version rule and the dir-collision refusal true through a road the
// operator never typed, without a second implementation that would eventually drift.

// mergeHostPackages takes entries parsePackagesFile has ALREADY normalized, so `dir` is always present on
// the declared side. Discovered candidates are raw and get normalized by the merge itself.
const declared = (name, version, dir) => ({ name, version, dir: dir ?? stagedDirName(name) });

test("mergeHostPackages: a declared entry wins by NAME, keeps its place, and reports the version it shadowed", () => {
	const { entries, overrides, dropped } = mergeHostPackages([declared("pi-widgets", "2.0.1")], [{ name: "pi-widgets", version: "2.3.0" }, { name: "other", version: "1.0.0" }]);

	assert.deepEqual(entries, [
		{ name: "pi-widgets", version: "2.0.1", dir: "pi-widgets", from: "pi-packages" },
		{ name: "other", version: "1.0.0", dir: "other", from: "host" },
	]);
	// Pinning OLDER than the host runs is the reason pi-packages.json survives as a layer at all, so the
	// shadowed version is reported rather than silently discarded.
	assert.deepEqual(overrides, [{ name: "pi-widgets", declared: "2.0.1", host: "2.3.0" }]);
	assert.deepEqual(dropped, []);
});

test("mergeHostPackages: matching versions produce no override note, because nothing was overridden", () => {
	const { overrides } = mergeHostPackages([declared("pi-widgets", "2.0.1")], [{ name: "pi-widgets", version: "2.0.1" }]);
	assert.deepEqual(overrides, []);
});

test("mergeHostPackages: a discovered admin package is DROPPED with a reason, never thrown", () => {
	// A declared admin entry refuses the whole run (asserted above). An operator running the panel normally
	// has it installed, so the discovered case must degrade instead of zeroing their overlay refresh.
	const { entries, dropped } = mergeHostPackages([], [{ name: "pi-dispatch-admin", version: "0.5.0" }, { name: "fine", version: "1.0.0" }]);
	assert.deepEqual(entries.map((e) => e.name), ["fine"]);
	assert.equal(dropped.length, 1);
	assert.match(dropped[0].reason, /recursion vector/);
	assert.equal(/: your pi setup$/.test(dropped[0].reason), false, "the synthetic path is stripped from the printed reason");
});

test("mergeHostPackages: a discovered entry colliding with a declared dir loses, and the declared one survives", () => {
	const { entries, dropped } = mergeHostPackages([declared("@a/widgets", "1.0.0", "widgets")], [{ name: "widgets", version: "2.0.0" }]);
	assert.deepEqual(entries.map((e) => e.name), ["@a/widgets"]);
	assert.match(dropped[0].reason, /already used by/);
});

test("mergeHostPackages: a discovered version that is not exact is dropped by the SAME rule declared ones face", () => {
	const { entries, dropped } = mergeHostPackages([], [{ name: "loose", version: "^1.0.0" }]);
	assert.deepEqual(entries, []);
	assert.match(dropped[0].reason, /CONST-PI-VERSION-PINNED/);
});

test("normalizeDiscoveredPackage returns a reason instead of throwing, and never pollutes seenDirs on failure", () => {
	const seen = new Map();
	assert.match(normalizeDiscoveredPackage({ name: "x", version: "not-exact" }, seen).reason, /EXACT version/);
	assert.equal(seen.size, 0, "a refused candidate must not reserve a dir the next one could have used");
	assert.deepEqual(normalizeDiscoveredPackage({ name: "x", version: "1.0.0" }, seen).entry, { name: "x", version: "1.0.0", dir: "x" });
	assert.equal(seen.get("x"), "x");
});

// --- readStagedSkills: what a stage would contribute (issue #189) ---

const OVERLAY = "/opt/overlay";
const WF_MANIFEST = JSON.stringify({ stagedAt: null, packages: [{ name: "@a/wf", version: "1.0.0", dir: "a__wf" }] });
const WF_ROOT = "/opt/overlay/packages/a__wf";

/** An in-memory tree for the reader's three seams: `files` maps absolute paths to text. */
function stagedFs(files) {
	const dirSet = new Set();
	for (const f of Object.keys(files)) {
		let d = f;
		while ((d = d.slice(0, d.lastIndexOf("/"))) && d.length > 1) dirSet.add(d);
	}
	return {
		globalPiDir: OVERLAY,
		readFile: (p) => {
			if (p in files) return files[p];
			throw new Error(`ENOENT: ${p}`);
		},
		fileExists: (p) => p in files || dirSet.has(p),
		readDir: (p) => {
			if (!dirSet.has(p)) throw new Error(`ENOENT: ${p}`);
			const children = new Map();
			for (const f of [...Object.keys(files), ...dirSet]) {
				if (f !== p && f.startsWith(`${p}/`)) {
					const name = f.slice(p.length + 1).split("/")[0];
					children.set(name, dirSet.has(`${p}/${name}`));
				}
			}
			return [...children.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
		},
	};
}

test("readStagedSkills enumerates the convention skills/ dir when there is no pi manifest", () => {
	const got = readStagedSkills(stagedFs({
		[`${OVERLAY}/packages/packages.json`]: WF_MANIFEST,
		[`${WF_ROOT}/package.json`]: JSON.stringify({ name: "@a/wf", version: "1.0.0" }),
		[`${WF_ROOT}/skills/review/SKILL.md`]: "---\ndescription: r\n---\n",
		[`${WF_ROOT}/skills/deploy/SKILL.md`]: "---\ndescription: d\n---\n",
	}));
	assert.deepEqual(got.unenumerable, []);
	assert.deepEqual(
		got.skills.map((s) => s.name).sort(),
		["deploy", "review"],
	);
	assert.equal(got.skills[0].package, "@a/wf", "the hit is attributed to the package, for the doctor line");
});

test("readStagedSkills follows pi manifest entries: a dir of skills, and a SKILL.md file directly", () => {
	const got = readStagedSkills(stagedFs({
		[`${OVERLAY}/packages/packages.json`]: WF_MANIFEST,
		[`${WF_ROOT}/package.json`]: JSON.stringify({ name: "@a/wf", version: "1.0.0", pi: { skills: ["lib/skills", "extra/one/SKILL.md"] } }),
		[`${WF_ROOT}/lib/skills/wf/SKILL.md`]: "---\ndescription: w\n---\n",
		[`${WF_ROOT}/extra/one/SKILL.md`]: "---\ndescription: o\n---\n",
	}));
	assert.deepEqual(got.skills.map((s) => s.name).sort(), ["one", "wf"]);
});

test("a pi manifest WITHOUT a skills key contributes NO skills and gets NO convention fallback", () => {
	// The pin's exact behaviour (collectPackageResources short-circuits on readPiManifest): the
	// convention dir is only consulted when there is no manifest AT ALL. An enumerator that fell back
	// anyway would print a ✓ for a skill pi never loads -- the wrong direction for an advisory line.
	const got = readStagedSkills(stagedFs({
		[`${OVERLAY}/packages/packages.json`]: WF_MANIFEST,
		[`${WF_ROOT}/package.json`]: JSON.stringify({ name: "@a/wf", version: "1.0.0", pi: { extensions: ["ext/index.js"] } }),
		[`${WF_ROOT}/skills/review/SKILL.md`]: "---\ndescription: r\n---\n",
	}));
	assert.deepEqual(got.skills, []);
	assert.deepEqual(got.unenumerable, []);
});

test("a glob or override pattern makes the package unenumerable, reported rather than guessed", () => {
	// Patterns can DISABLE files too (the `!`/`+`/`-` forms), so enumerating the plain entries around
	// them could report a skill pi filters out. The whole package is declared unreadable instead.
	for (const entry of ["skills/*", "!skills/internal", "+skills/extra", "-skills/old", "skills/a?c"]) {
		const got = readStagedSkills(stagedFs({
			[`${OVERLAY}/packages/packages.json`]: WF_MANIFEST,
			[`${WF_ROOT}/package.json`]: JSON.stringify({ name: "@a/wf", version: "1.0.0", pi: { skills: [entry, "skills/plain"] } }),
			[`${WF_ROOT}/skills/plain/SKILL.md`]: "---\ndescription: p\n---\n",
		}));
		assert.deepEqual(got.skills, [], `entry ${JSON.stringify(entry)} must not be enumerated around`);
		assert.deepEqual(got.unenumerable, ["@a/wf"], `entry ${JSON.stringify(entry)} must mark the package unenumerable`);
	}
});

test("a ..-carrying manifest entry is dropped, never followed out of the staged tree", () => {
	const got = readStagedSkills(stagedFs({
		[`${OVERLAY}/packages/packages.json`]: WF_MANIFEST,
		[`${WF_ROOT}/package.json`]: JSON.stringify({ name: "@a/wf", version: "1.0.0", pi: { skills: ["../../../etc"] } }),
	}));
	assert.deepEqual(got.skills, []);
	assert.deepEqual(got.unenumerable, [], "an escape is dropped, not reported as a pattern");
});

test("a package with no readable package.json is skipped -- pi would skip it too", () => {
	const got = readStagedSkills(stagedFs({
		[`${OVERLAY}/packages/packages.json`]: WF_MANIFEST,
		[`${WF_ROOT}/skills/review/SKILL.md`]: "---\ndescription: r\n---\n",
	}));
	assert.deepEqual(got, { skills: [], unenumerable: [] });
});

test("garbage package.json is a skipped package; a missing or garbage manifest is an empty stage; nothing throws", () => {
	assert.deepEqual(
		readStagedSkills(stagedFs({
			[`${OVERLAY}/packages/packages.json`]: WF_MANIFEST,
			[`${WF_ROOT}/package.json`]: "not json {",
		})),
		{ skills: [], unenumerable: [] },
	);
	assert.deepEqual(readStagedSkills(stagedFs({})), { skills: [], unenumerable: [] });
	assert.deepEqual(readStagedSkills({ globalPiDir: null }), { skills: [], unenumerable: [] });
	assert.deepEqual(readStagedSkills(), { skills: [], unenumerable: [] });
});
