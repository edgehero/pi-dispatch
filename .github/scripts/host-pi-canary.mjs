/**
 * Advance warning that pi@latest still reads the way worker/src/host-pi.mjs assumes (issue #102).
 *
 * host-pi.mjs mirrors two things pi exports no public API for: where a package the operator installed with
 * `pi install` lives on disk, and whether a resource they configured is enabled. The mirror is pinned as a
 * BUILD GATE by worker/test/host-pi.pinned.test.mjs, against the version the lockfile resolved. This script
 * is the other half: the same needles against `latest`, so a pi release that moves one is a warning here
 * before it is a surprise at the next version bump.
 *
 * The needle list is IMPORTED from host-pi.mjs, never re-typed, so the gate and the canary cannot drift
 * apart -- a needle added to one is a needle checked by both.
 *
 * Usage: node .github/scripts/host-pi-canary.mjs <scratchDir>
 * where <scratchDir> holds a `npm install @earendil-works/pi-coding-agent@latest`.
 *
 * Exit 0 = the mirror still holds. Exit 1 = it moved, with the file and needle named. A missing install is
 * an INFRASTRUCTURE failure and exits 2, because reading it as either verdict would be a guess (the same
 * doctrine admin-pi-canary.mjs and release.yml's npm-view step follow).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PINNED_PI_NEEDLES } from "../../worker/src/host-pi.mjs";

const scratch = process.argv[2];
if (!scratch) {
	console.error("usage: node .github/scripts/host-pi-canary.mjs <scratchDir>");
	process.exit(2);
}

const piRoot = join(scratch, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(piRoot, "package.json"))) {
	console.error(`::error::no pi installed at ${piRoot} -- an infrastructure failure, not a drift verdict. Re-run before reading anything into it.`);
	process.exit(2);
}
const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version;

const misses = [];
for (const [file, needles] of Object.entries(PINNED_PI_NEEDLES)) {
	const path = join(piRoot, file);
	if (!existsSync(path)) {
		misses.push(`${file}: the whole file is gone`);
		continue;
	}
	const src = readFileSync(path, "utf8");
	for (const needle of needles) {
		if (!src.includes(needle)) misses.push(`${file}: ${JSON.stringify(needle)}`);
	}
}

if (misses.length === 0) {
	console.log(`host-pi canary: pi ${version} still matches every internal worker/src/host-pi.mjs mirrors (${Object.values(PINNED_PI_NEEDLES).flat().length} needles).`);
	process.exit(0);
}

console.error(
	`::error::pi ${version} moved ${misses.length} internal(s) that worker/src/host-pi.mjs mirrors. This is ADVANCE WARNING, not a build break: the pinned version is unaffected until someone bumps it. ` +
		"Before that bump, re-verify in this order: (1) discoverHostPackages against pi's getNpmInstallPath, INCLUDING the precedence that honours the managed path before the global one; " +
		"(2) isEnabledByPatterns against isEnabledByOverrides, especially '-' beats '+' beats '!' and which patterns match exactly rather than by glob; " +
		"(3) the pi-package predicate against collectPackageResources' fallthrough to the convention dirs; (4) PINNED_PI_NEEDLES itself. " +
		"A silently wrong mirror stages a package the operator disabled, which is the failure this feature exists to remove.",
);
for (const miss of misses) console.error(`  missing -- ${miss}`);
process.exit(1);
