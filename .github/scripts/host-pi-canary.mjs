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
 * EXIT CODES, and why drift does NOT fail the build:
 *   0  the mirror holds, OR it moved and that is reported as a `::warning::` annotation.
 *   1  the canary could not RUN (no pi installed) -- an infrastructure failure, which must be loud,
 *      because reading a canary that never executed as either verdict would be a guess (the same doctrine
 *      admin-pi-canary.mjs and release.yml's npm-view step follow).
 *
 * Drift is a warning rather than a failure, and the distinction is deliberate rather than a softening.
 * This canary and the admin one differ in KIND. A red admin canary means the PUBLISHED admin may already
 * be broken for anyone installing it against latest pi, because it declares a `*` peer -- a live,
 * user-facing problem. Drift here means a FUTURE pi bump will need work: nothing shipped is broken,
 * because the worker pins pi and `worker/test/host-pi.pinned.test.mjs` gates that pin as a hard build
 * failure. Failing every unrelated PR until someone does that future work would train people to ignore a
 * red check, which costs more than the signal is worth. The annotation, the weekly scheduled run and
 * `OQ-018` are what carry it instead.
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
	process.exit(1);
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

console.log(
	`::warning::pi ${version} moved ${misses.length} internal(s) that worker/src/host-pi.mjs mirrors. ADVANCE WARNING, and the build is green on purpose: the pinned version is unaffected until someone bumps it, and worker/test/host-pi.pinned.test.mjs is the hard gate on that pin. ` +
		"Before the next bump, re-verify in this order: (1) discoverHostPackages against pi's getNpmInstallPath, INCLUDING the precedence that honours the managed path before the global one; " +
		"(2) isEnabledByPatterns against isEnabledByOverrides, especially '-' beats '+' beats '!' and which patterns match exactly rather than by glob; " +
		"(3) the pi-package predicate against collectPackageResources' fallthrough to the convention dirs; (4) PINNED_PI_NEEDLES itself. " +
		"Check (4) FIRST and honestly: a needle that pinned an incidental line rather than the behaviour it stood for fires on a pure refactor, and a canary that cries wolf is one people stop reading. " +
		"If the behaviour really did move, a silently wrong mirror stages a package the operator disabled, which is the failure this feature exists to remove.",
);
for (const miss of misses) console.log(`  missing -- ${miss}`);
process.exit(0);
