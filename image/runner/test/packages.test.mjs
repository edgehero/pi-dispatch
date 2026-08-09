import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ADMIN_EXTENSION_RE,
	adminExtensionReason,
	countPackageResources,
	extensionEntryName,
	findShadowedSkills,
	isUnderAnyRoot,
	owningRoot,
	partitionAdminExtensions,
	PROTECTED_SKILL_ROOTS,
} from "../src/packages.mjs";

/**
 * Pure unit tests for the staged-package decisions (INT-CONTAINER-JOB-INPUTS). These take pi's
 * diagnostic shape as plain objects, so they run everywhere -- the loader contract tests pin the same
 * finding against the REAL pi, and this file pins what we DO about it.
 *
 * What we do about it changed: the shadowing is now REVERSED by loader.mjs through the loader's
 * declared skillsOverride option (REQ-GLOBAL-PI-OVERLAY, "repo wins on conflict"), so findShadowedSkills
 * reports the ATTEMPT rather than justifying a refusal. Its inputs and its answers are unchanged --
 * pi's diagnostic is left exactly as pi wrote it -- which is precisely why the same cases still hold.
 */

const PACKAGE_ROOT = "/opt/pi-global/packages/tools";
const OTHER_PACKAGE_ROOT = "/opt/pi-global/packages/review";

/** pi's own collision diagnostic: winnerPath is the skill it KEPT, loserPath the one it dropped. */
function collision({ name, winnerPath, loserPath }) {
	return {
		type: "collision",
		message: `name "${name}" collision`,
		path: loserPath,
		collision: { resourceType: "skill", name, winnerPath, loserPath },
	};
}

test("a package skill that shadows a repo skill is flagged", () => {
	// The finding: pi puts package skill paths FIRST in skillPaths and loadSkills is first-path-wins,
	// so on the raw load the package's "deploy" wins and the repo's is dropped with only this
	// diagnostic to show for it. loader.mjs puts the repo's back in force through skillsOverride, so
	// this is no longer grounds for refusal -- it is what gets the attempt into the run log, because a
	// package whose flow was written around its own "deploy" is now running against the repo's.
	const diagnostics = [
		collision({
			name: "deploy",
			winnerPath: `${PACKAGE_ROOT}/skills/deploy/SKILL.md`,
			loserPath: "/job/pi/skills/deploy/SKILL.md",
		}),
	];
	const shadowed = findShadowedSkills(diagnostics, { packageRoots: [PACKAGE_ROOT] });
	assert.equal(shadowed.length, 1);
	assert.equal(shadowed[0].name, "deploy");
	assert.equal(shadowed[0].winnerPath, `${PACKAGE_ROOT}/skills/deploy/SKILL.md`);
	assert.equal(shadowed[0].loserPath, "/job/pi/skills/deploy/SKILL.md");
});

test("a package skill that shadows an OPERATOR OVERLAY skill is flagged too", () => {
	// /opt/pi-global/skills is operator deploy-time config, the same trust class as the baked floor.
	// A package silently replacing one of those is the same inversion.
	const diagnostics = [
		collision({
			name: "house-style",
			winnerPath: `${PACKAGE_ROOT}/skills/house-style/SKILL.md`,
			loserPath: "/opt/pi-global/skills/house-style/SKILL.md",
		}),
	];
	assert.equal(findShadowedSkills(diagnostics, { packageRoots: [PACKAGE_ROOT] }).length, 1);
});

test("the ALLOWED direction -- the repo wins -- is not flagged", () => {
	// Two ways to reach this shape, and neither is a problem to report: pi reorders skillPaths so our
	// paths come first, or the enforcement diagnostic loader.mjs appends after a swap. Flagging it
	// would put a line in every packaged job's log claiming a conflict that resolved as documented.
	const diagnostics = [
		collision({
			name: "deploy",
			winnerPath: "/job/pi/skills/deploy/SKILL.md",
			loserPath: `${PACKAGE_ROOT}/skills/deploy/SKILL.md`,
		}),
	];
	assert.deepEqual(findShadowedSkills(diagnostics, { packageRoots: [PACKAGE_ROOT] }), []);
});

test("a repo skill shadowing an overlay skill is not flagged -- that is the documented overlay", () => {
	// REQ-GLOBAL-PI-OVERLAY: the repo's .pi/skills layer OVER the operator overlay's, and a name
	// collision between the two is expected, not a refusal.
	const diagnostics = [
		collision({
			name: "bug-fix",
			winnerPath: "/job/pi/skills/bug-fix/SKILL.md",
			loserPath: "/opt/pi-global/skills/bug-fix/SKILL.md",
		}),
	];
	assert.deepEqual(findShadowedSkills(diagnostics, { packageRoots: [PACKAGE_ROOT] }), []);
	assert.deepEqual(findShadowedSkills(diagnostics, { packageRoots: [] }), []);
});

test("non-collision diagnostics and non-skill collisions are ignored", () => {
	// getSkills().diagnostics also carries plain warnings and errors (a missing skill path, a broken
	// frontmatter). Treating those as shadowing would report skill conflicts that never happened, and
	// a warning that cries wolf is a warning nobody reads when the real one lands.
	const diagnostics = [
		{ type: "error", message: "Skill path does not exist", path: "/job/pi/skills" },
		{ type: "warning", message: "not a directory", path: `${PACKAGE_ROOT}/skills` },
		{
			type: "collision",
			message: 'name "fmt" collision',
			collision: {
				resourceType: "prompt",
				name: "fmt",
				winnerPath: `${PACKAGE_ROOT}/prompts/fmt.md`,
				loserPath: "/job/pi/prompts/fmt.md",
			},
		},
	];
	assert.deepEqual(findShadowedSkills(diagnostics, { packageRoots: [PACKAGE_ROOT] }), []);
	assert.deepEqual(findShadowedSkills(undefined, { packageRoots: [PACKAGE_ROOT] }), []);
});

test("root matching is by path segment, so a sibling root cannot claim another's skill", () => {
	// "/opt/pi-global/packages/tool" must not match a path under ".../tools". A prefix test would flag
	// -- or miss -- the wrong package, and the log line would name the wrong dir. loader.mjs decides
	// skill PRECEDENCE with this same containment test, so a boundary bug here does not merely
	// misreport: it swaps the wrong skill, or fails to swap the right one.
	const diagnostics = [
		collision({
			name: "deploy",
			winnerPath: `${PACKAGE_ROOT}/skills/deploy/SKILL.md`,
			loserPath: "/job/pi/skills/deploy/SKILL.md",
		}),
	];
	assert.deepEqual(findShadowedSkills(diagnostics, { packageRoots: ["/opt/pi-global/packages/tool"] }), []);
	assert.equal(findShadowedSkills(diagnostics, { packageRoots: [`${PACKAGE_ROOT}/`] }).length, 1, "a trailing slash still matches");
	// Exact on purpose (issue #60 added the middle entry): a root that quietly leaves this list stops
	// being defended against a staged package, with no other test noticing.
	assert.deepEqual(PROTECTED_SKILL_ROOTS, ["/job/pi/skills", "/job/trigger-skills", "/opt/pi-global/skills"]);
});

test("isUnderAnyRoot and owningRoot share the segment boundary, and owningRoot names the FIRST match", () => {
	// Exported because loader.mjs decides precedence against the same roots and run-job.mjs names the
	// winning root in the log. Asserted directly so the boundary is pinned once, where it lives.
	assert.equal(isUnderAnyRoot(`${PACKAGE_ROOT}/skills/deploy/SKILL.md`, [PACKAGE_ROOT]), true);
	assert.equal(isUnderAnyRoot(`${PACKAGE_ROOT}/skills/deploy/SKILL.md`, ["/opt/pi-global/packages/tool"]), false);
	assert.equal(isUnderAnyRoot(PACKAGE_ROOT, [PACKAGE_ROOT]), true, "the root itself is under itself");
	assert.equal(isUnderAnyRoot(undefined, [PACKAGE_ROOT]), false, "an unloaded skill has no path to place");
	assert.equal(isUnderAnyRoot(`${PACKAGE_ROOT}/x`, undefined), false);

	assert.equal(owningRoot("/job/pi/skills/deploy/SKILL.md", ["/job/pi/skills", PACKAGE_ROOT]), "/job/pi/skills");
	assert.equal(
		owningRoot(`${PACKAGE_ROOT}/skills/deploy/SKILL.md`, ["/job/pi/skills", PACKAGE_ROOT]),
		PACKAGE_ROOT,
	);
	// null rather than a guess: a log line that invents a root is worse than one that admits it has none.
	assert.equal(owningRoot("/somewhere/else/SKILL.md", ["/job/pi/skills"]), null);
	assert.equal(owningRoot(undefined, ["/job/pi/skills"]), null);
});

test("countPackageResources attributes each loaded path to the root that shipped it", () => {
	const counts = countPackageResources({
		packageRoots: [PACKAGE_ROOT, OTHER_PACKAGE_ROOT],
		extensionPaths: [
			"/job/pi/extensions/repo-ext.js", // not a package -- counted for nobody
			`${PACKAGE_ROOT}/ext/one.js`,
			`${PACKAGE_ROOT}/ext/two.js`,
			`${OTHER_PACKAGE_ROOT}/index.js`,
		],
		skillPaths: [
			"/job/pi/skills/bug-fix/SKILL.md",
			`${PACKAGE_ROOT}/skills/pkg-skill/SKILL.md`,
		],
	});

	assert.deepEqual(counts, [
		{ root: PACKAGE_ROOT, extensions: 2, skills: 1 },
		{ root: OTHER_PACKAGE_ROOT, extensions: 1, skills: 0 },
	]);
});

test("a root that contributed nothing still reports 0 rather than vanishing", () => {
	// The whole reason the log line is per-root: a package that mounted but resolved to no resources
	// at all (unbuilt extension, manifest pointing at files that are not there) is otherwise
	// indistinguishable from one that worked.
	assert.deepEqual(
		countPackageResources({
			packageRoots: [PACKAGE_ROOT],
			extensionPaths: ["/job/pi/extensions/repo-ext.js"],
			skillPaths: ["/opt/pi-global/skills/house-style/SKILL.md"],
		}),
		[{ root: PACKAGE_ROOT, extensions: 0, skills: 0 }],
	);

	assert.deepEqual(countPackageResources({}), []);
});

// --- REQ-ADMIN-VIA-PI-EXTENSION Scope: the admin-extension recursion guard ---
//
// Native extension discovery is ON (noExtensions:false), so a serviced repo's /workspace/.pi/extensions
// loads -- and this repo ships one, a two-line re-export of the admin extension. Loaded into a job, it
// hands the model `dispatch_run` (enqueue a PAID job from inside a paid job) and `dispatch_set` (move
// the daily cap). These pin the decision; loader.test.mjs pins that the decision is actually WIRED.

/** A loaded extension as pi reports one: `path` plus the tools its factory registered, in a Map. */
function loaded(path, toolNames = []) {
	return { path, tools: new Map(toolNames.map((name) => [name, { definition: { name } }])) };
}

const WORKSPACE_EXT = "/workspace/.pi/extensions/index.js";

test("the runner's ADMIN_EXTENSION_RE is character-for-character the worker's ADMIN_RE", () => {
	// The duplication is forced -- the image installs the runner's dependencies, not the worker's source,
	// so import-pi.mjs cannot be imported here. This asserts the SHAPE the worker refuses to stage, so a
	// widening on that side that is not mirrored here shows up as a failing test rather than as a hole
	// nothing reports. worker/src/import-pi.mjs is the original.
	assert.equal(String(ADMIN_EXTENSION_RE), "/pi-dispatch|dispatch-admin/i");
});

test("an admin-NAMED extension is dropped, and an ordinary repo extension is kept", () => {
	const { kept, dropped } = partitionAdminExtensions([
		loaded(WORKSPACE_EXT),
		loaded("/opt/pi-global/extensions/pi-dispatch-admin.js"),
	]);
	assert.deepEqual(kept.map((e) => e.path), [WORKSPACE_EXT], "a repo extension must survive the guard");
	assert.deepEqual(dropped, [{ name: "pi-dispatch-admin.js", root: null, reason: "admin-name" }]);
});

test("the name is matched case-insensitively, and on the DIRECTORY when the entry is an index", () => {
	// pi resolves a directory to <dir>/index.ts|js, so the file name says nothing and the directory is
	// the entry's name. Both forms are how an admin extension actually lands: a loose file, or a dir.
	const { kept, dropped } = partitionAdminExtensions([
		loaded("/opt/pi-global/extensions/PI-Dispatch-Admin.ts"),
		loaded("/opt/pi-global/packages/dispatch-admin/index.js"),
		loaded("/opt/pi-global/packages/tools/index.js"),
	]);
	assert.deepEqual(kept.map((e) => e.path), ["/opt/pi-global/packages/tools/index.js"]);
	assert.deepEqual(dropped.map((d) => d.name), ["PI-Dispatch-Admin.ts", "dispatch-admin/index.js"]);
	assert.deepEqual([...new Set(dropped.map((d) => d.reason))], ["admin-name"]);
});

test("the ENTRY name is matched, never the whole path -- an ancestor directory is not the extension", () => {
	// The over-match that would fail OPEN into "the serviced repo loads nothing". A checkout under a
	// directory called pi-dispatch (this repo on the operator's host; the tmpdir the loader tests run in)
	// puts the pattern in every one of its extensions' paths without any of them being the admin
	// extension. In the container the roots are fixed anyway (/workspace, /job/pi, /opt/pi-global), so
	// testing the whole path buys nothing and costs exactly this.
	const inCheckout = "/Users/op/src/pi-dispatch/.pi/extensions/lint.js";
	assert.equal(adminExtensionReason(loaded(inCheckout)), null);
	assert.equal(extensionEntryName(inCheckout), "lint.js");
	assert.equal(extensionEntryName("/tmp/pi-dispatch-test-a1/workspace/.pi/extensions/index.js"), "extensions/index.js");
	assert.equal(extensionEntryName(""), "", "no path is not a name");
	assert.equal(extensionEntryName(undefined), "");
});

test("an admin re-export under ANY name is dropped -- the tools are the identity, not the file name", () => {
	// THE case this repo is: `.pi/extensions/dispatch.ts`, two lines, re-exporting admin/src/index.ts.
	// Its entry name matches no admin pattern (and could not -- a repo may name the file anything), so
	// the name signal alone would hand a job container the paid-enqueue tools. What is being defended is
	// the surface, so the surface is what the second signal reads.
	const shim = "/workspace/.pi/extensions/dispatch.ts";
	const { kept, dropped } = partitionAdminExtensions(
		[loaded(WORKSPACE_EXT, ["review_diff"]), loaded(shim, ["dispatch_status", "dispatch_run", "dispatch_set"])],
		{ roots: ["/workspace"] },
	);
	assert.equal(adminExtensionReason(loaded(shim)), null, "by name alone it is invisible -- that is the point");
	assert.deepEqual(kept.map((e) => e.path), [WORKSPACE_EXT], "an unrelated repo tool is not admin-like");
	assert.deepEqual(dropped, [{ name: "dispatch.ts", root: "/workspace", reason: "admin-tools" }]);
});

test("the dropped record is built to be logged: entry name and root, never a path or file content", () => {
	// The log line is assembled from THIS record, so what the record cannot carry, the log cannot leak.
	// Roots are the container's own mount constants and are listed most-specific first -- a staged
	// package lives under the overlay, and reporting it as the operator's overlay would name the wrong
	// owner in the one line an operator gets.
	const roots = ["/opt/pi-global/packages/tools", "/opt/pi-global", "/workspace"];
	const [record] = partitionAdminExtensions(
		[loaded("/opt/pi-global/packages/tools/ext/dispatch-admin.js")],
		{ roots },
	).dropped;
	assert.deepEqual(record, {
		name: "dispatch-admin.js",
		root: "/opt/pi-global/packages/tools",
		reason: "admin-name",
	});
	assert.equal(JSON.stringify(record).includes("/ext/"), false, "no path component of the file may survive");
	// An extension from a root nobody declared is reported with root null rather than a guess.
	assert.equal(partitionAdminExtensions([loaded("/elsewhere/pi-dispatch.js")]).dropped[0].root, null);
});

test("kept extensions come back as the SAME objects, in load order", () => {
	// Extension resolution is first-path-wins, so the array's ORDER is the trust ordering (repo, then
	// overlay, then packages, then discovery). A guard that rebuilt or reordered the survivors would
	// silently reshuffle which extension wins a name -- and pi needs the real objects, not copies.
	const first = loaded("/job/pi/extensions");
	const second = loaded("/opt/pi-global/extensions/index.js");
	const third = loaded(WORKSPACE_EXT);
	const { kept, dropped } = partitionAdminExtensions([first, loaded("/x/pi-dispatch.js"), second, third]);
	assert.deepEqual(dropped.length, 1);
	assert.equal(kept.length, 3);
	assert.ok(kept[0] === first && kept[1] === second && kept[2] === third);
});

test("nothing admin-like means nothing dropped, and no input shape throws", () => {
	// The overwhelmingly common job. It must also survive an extension pi loaded with no tools at all
	// (a subscriber-only extension) and the empty/absent cases, because a guard that throws inside
	// extensionsOverride takes the whole job down with it.
	assert.deepEqual(partitionAdminExtensions([loaded(WORKSPACE_EXT, ["review_diff"])]).dropped, []);
	assert.deepEqual(partitionAdminExtensions([]), { kept: [], dropped: [] });
	assert.deepEqual(partitionAdminExtensions(), { kept: [], dropped: [] });
	assert.deepEqual(partitionAdminExtensions(undefined, { roots: undefined }), { kept: [], dropped: [] });
	assert.deepEqual(partitionAdminExtensions([{ path: WORKSPACE_EXT }]).dropped, [], "no tools map is not a match");
	assert.equal(adminExtensionReason(undefined), null);
	// Tools may arrive as plain names too -- the decision must not depend on pi's container type.
	assert.equal(adminExtensionReason({ path: WORKSPACE_EXT, tools: ["dispatch_run"] }), "admin-tools");
});
