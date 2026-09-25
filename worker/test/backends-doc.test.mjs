import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PODMAN_JOB_USER_FIX } from "../src/backend-podman.mjs";
import { DEFAULT_BACKEND, PODMAN_BACKEND } from "../src/backends.mjs";
import { JOB_USER_FIX } from "../src/job-user.mjs";
import { jobUserBootRefusal, podmanBootRefusal } from "../src/start.mjs";

// `docs/backends.md` names WHEN each job-user refusal fires, which is a restatement of a derivable source, so it is
// BOLTED to that source (CLAUDE.md: a hand-written table is derived or pinned, never trusted). Until this file there
// was NO test reading that page at all, which is why its own refusal sentence had drifted to naming seven of the
// code's eight causes in six clauses, omitting `runtime-unreadable` entirely.
//
// THIS FILE GENERATES THE LIST LINES AND REQUIRES THEM VERBATIM (two for `local`, two since issue #354 for
// `podman`). It does not parse them back out of the page, and
// that is the whole design rather than a detail. The first version did parse: it found a marked block, pulled the
// backticked names out of it and compared the sets. An adversarial review got ELEVEN wrong pages past it; the lists
// were genuinely derived, but nothing pinned WHICH TEXT was being read. It was hardened, and the second pass got ten
// more through, each one a new hiding place rather than a new idea: a correct copy inside an HTML comment, a comment
// closed by a plain `-->` in ordinary prose so the stripper ate the visible text around it, a link reference
// definition that renders as nothing, non-breaking hyphens that render identically, a decoy marker pair, a narrowed
// marker pair. Every repair bought one round. Generating the line ends that class by construction: there is one
// correct string and the page either contains it or does not, so a hiding place buys nothing once the comments a
// reader never sees are removed first.
//
// The bolt is `jobUserBootRefusal(decision, defaultBackend)` rather than `BOOT_REFUSING_JOB_USER_CAUSES`, and the
// distinction is the point: the page's claim is not that four names sit in a Set, it is that they stop a boot AND
// only while `local` is the default venue. Only the function carries the second half, and it is exported
// (`start.mjs`) precisely so the branch a one-venue build cannot reach stays pinned.
//
// WHAT REMAINS UNPINNED, stated rather than overstated, because two reviews in a row corrected an earlier claim
// about this file's reach. Only the two list lines and the cause names are derived. Every other sentence on that
// page is prose, and prose can move a claim without moving a name: a third bullet, a sentence saying the two
// headings were swapped in some release, a redefinition of "the boot" as the job container's, an invented promise
// that `pi-dispatch doctor` clears the boot-stopping causes. All of those were demonstrated green and none is
// reachable by a pattern. `worker/test/podman-doc.test.mjs` records the same limit and what it cost to learn: the
// answer to prose that keeps being wrong is fewer such sentences, never a bigger regex.
//
// One more thing the generator does NOT prove, since a residual that lists only the easy half is the same sin:
// the second line is the COMPLEMENT of the first, not an observed behaviour. `stopsBoot` asks about a synthetic
// `{ mode: "unmappable", cause }` for every `JOB_USER_FIX` key, and `any-uid-unsupported` never reaches
// `decideJobUser` as a decision at all -- `resolveImageUser` returns it as a refusal. So a cause added to
// `JOB_USER_FIX` for doctor's use alone would be filed under "Refuses each job" here and this test would then
// REQUIRE the page to say something false. What bounds that is `worker/test/job-user.test.mjs`, which pins the
// exact eight keys, so such an addition cannot be accidental.

const doc = readFileSync(new URL("../../docs/backends.md", import.meta.url), "utf8");

/**
 * The page as a READER sees it. Removing the extractor removed its comment strip with it, and a final review
 * showed what that cost: the generated line is matched against trimmed lines, and a line inside a multi-line
 * HTML comment is still a line beginning `- **`. Both lists could be moved into a comment while the visible
 * prose said the opposite, or deleted outright with a copy buried at the end of the file. The realistic one is
 * worse than either: deleting the ` -->` that closes this page's own instruction comment, one token directly
 * above the bullets, swallows them both and leaves this file green.
 *
 * Stripping here cannot reopen the arms race the extractor lost, and the direction is the whole reason it is
 * safe: a stripper can only REMOVE candidate lines, so its worst outcome is a false red on an honest page,
 * never a pass on a wrong one. The unclosed-comment assertion is what makes that true in both directions.
 */
const VISIBLE = doc.replace(/<!--[\s\S]*?-->/g, "");

const CAUSES = Object.keys(JOB_USER_FIX);
const stopsBoot = (cause) => jobUserBootRefusal({ mode: "unmappable", cause }, DEFAULT_BACKEND) !== null;
const listLine = (label, causes) => `- **${label}**: ${causes.map((cause) => `\`${cause}\``).join(", ")}.`;

/** The two lines this build says the page must carry, in `JOB_USER_FIX`'s own order so there is one canonical form. */
const EXPECTED = [listLine("Stops the boot", CAUSES.filter(stopsBoot)), listLine("Refuses each job", CAUSES.filter((cause) => !stopsBoot(cause)))];

// The `podman` venue's causes (issue #354), generated the same way and for the same reason: `PODMAN_JOB_USER_FIX` for
// the names, `podmanBootRefusal(decision, "podman")` for which heading each belongs under. Only the causes `local`'s two
// lines do not already name, so the page-wide count-once rule below still holds; the shared names get their own test,
// which checks what the page says about them (they fire at the same point on both venues) against both functions.
const PODMAN_ONLY = Object.keys(PODMAN_JOB_USER_FIX).filter((cause) => !Object.hasOwn(JOB_USER_FIX, cause));
const PODMAN_SHARED = Object.keys(PODMAN_JOB_USER_FIX).filter((cause) => Object.hasOwn(JOB_USER_FIX, cause));
const podmanStopsBoot = (cause) => podmanBootRefusal({ mode: "unmappable", cause }, PODMAN_BACKEND) !== null;
const PODMAN_EXPECTED = [
	listLine(`Stops the boot while \`${PODMAN_BACKEND}\` is the default venue`, PODMAN_ONLY.filter(podmanStopsBoot)),
	listLine(`Refuses each job on \`${PODMAN_BACKEND}\``, PODMAN_ONLY.filter((cause) => !podmanStopsBoot(cause))),
];

test("the page carries the two cause lists this build generates, verbatim (#357)", () => {
	// Matched against TRIMMED LINES of the visible page, which is what makes a hiding place useless: a link
	// reference definition or a table cell is not a line beginning `- **`, a name spelled with a non-breaking
	// hyphen is not this string, and a comment is not there at all by the time this runs. The bullet may carry
	// prose after the full stop.
	assert.ok(!VISIBLE.includes("<!--"), "docs/backends.md has an unclosed HTML comment, which hides what follows it");
	const lines = VISIBLE.split("\n").map((line) => line.trim());
	for (const want of [...EXPECTED, ...PODMAN_EXPECTED]) {
		const found = lines.filter((line) => line.startsWith(want));
		assert.equal(found.length, 1, `docs/backends.md must carry exactly this line, exactly once:\n${want}`);
	}
});

test("each cause is named once on the whole page, so no sentence can reassign one (#357)", () => {
	// PAGE-WIDE, not block-wide, and the earlier block-wide version is why: a contradicting copy of the two lists
	// somewhere else on the page passed it, and so did moving the block's own end marker. Counted in the BACKTICKED
	// form, which is what avoids the collision that made an honest page fail -- `job-image-any-uid-unsupported` is
	// the id the code uses for the per-image refusal and contains `any-uid-unsupported` as a bare substring.
	for (const cause of new Set([...CAUSES, ...PODMAN_ONLY])) {
		assert.equal(VISIBLE.split(`\`${cause}\``).length - 1, 1, `${cause} is named once on the page, in its own list`);
	}
});

// The page's one sentence about the causes the two venues SHARE says they "fire at the same point on `podman` as on
// `local`". That is a claim two functions can answer, so it is asked of them rather than trusted: each shared cause
// stops a boot on its venue exactly when it stops one on the other, each as its own default. The count is pinned too,
// because the sentence names them as three, in prose, without the backticked names the rule above counts.
test("the causes both venues name fire at the same point on each (#354)", () => {
	assert.equal(PODMAN_SHARED.length, 3, "the page names three shared causes");
	for (const cause of PODMAN_SHARED) {
		assert.equal(podmanStopsBoot(cause), stopsBoot(cause), cause);
	}
	// And neither function answers for the other's venue, which is what "with `podman` in `local`'s place" means.
	for (const cause of Object.keys(PODMAN_JOB_USER_FIX)) {
		assert.equal(podmanBootRefusal({ mode: "unmappable", cause }, DEFAULT_BACKEND), null, cause);
	}
});

// The page's conditional half, which no generation can reach: the function proves the BEHAVIOUR is conditional, and
// nothing derivable stops a page asserting the opposite in words. This catches a page that stops MENTIONING the
// condition, which is the drift that actually happened, and it does not catch one that mentions it in order to deny
// it (demonstrated). Named that precisely so nobody mistakes it for the others or adds a second like it.
test("the page still mentions the venue condition, not just a boot-refusing list (#357)", () => {
	const flat = doc.replace(/\s+/g, " ");
	assert.ok(flat.includes(`while \`${DEFAULT_BACKEND}\` is the default venue`), "the page says WHEN the boot exit applies");
});

// The teeth on the source side. A cause filed under the wrong heading dies in the generator above; these two pin the
// function the generator asks, so a change to the Set or to the venue condition cannot quietly redefine both at once.
test("the generated sets are what `jobUserBootRefusal` decides, cause by cause (#357)", () => {
	const boot = CAUSES.filter(stopsBoot);
	assert.deepEqual(boot, ["rootless", "userns-remap", "worker-is-root", "desktop-linux-userns"]);
	assert.equal(CAUSES.length - boot.length, 4, "and the rest refuse each job");
});

test("no cause stops a boot when `local` is not the default venue (#357)", () => {
	for (const cause of CAUSES) {
		assert.equal(jobUserBootRefusal({ mode: "unmappable", cause }, "other"), null, cause);
	}
	// And a decision that is not a refusal never stops a boot, whatever the venue: an unanswered daemon reads
	// `unknown`, which is the page's "in neither set" sentence and the reason a unit with
	// RestartPreventExitStatus=2 is not stranded by a daemon that is still starting.
	for (const decision of [{ mode: "unknown", reason: "no-daemon-facts" }, { mode: "worker", user: "1000:1000" }, { mode: "image", cause: "desktop-platform" }, null]) {
		assert.equal(jobUserBootRefusal(decision, DEFAULT_BACKEND), null, JSON.stringify(decision));
	}
});
