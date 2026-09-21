import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_BACKEND } from "../src/backends.mjs";
import { JOB_USER_FIX } from "../src/job-user.mjs";
import { jobUserBootRefusal } from "../src/start.mjs";

// `docs/backends.md` names WHEN each job-user refusal fires, which is a restatement of a derivable source, so it is
// BOLTED to that source (CLAUDE.md: a hand-written table is derived or pinned, never trusted). Until this file there
// was NO test reading that page at all, which is why its own refusal sentence had drifted to naming seven of the
// code's eight causes in six clauses, omitting `runtime-unreadable` entirely.
//
// THIS FILE GENERATES THE TWO LINES AND REQUIRES THEM VERBATIM. It does not parse them back out of the page, and
// that is the whole design rather than a detail. The first version did parse: it found a marked block, pulled the
// backticked names out of it and compared the sets. An adversarial review got ELEVEN wrong pages past it; the lists
// were genuinely derived, but nothing pinned WHICH TEXT was being read. It was hardened, and the second pass got ten
// more through, each one a new hiding place rather than a new idea: a correct copy inside an HTML comment, a comment
// closed by a plain `-->` in ordinary prose so the stripper ate the visible text around it, a link reference
// definition that renders as nothing, non-breaking hyphens that render identically, a decoy marker pair, a narrowed
// marker pair. Every repair bought one round. Generating the line ends that class by construction: there is one
// correct string, the page either contains it or does not, and no hiding place helps because nothing is extracted.
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

const doc = readFileSync(new URL("../../docs/backends.md", import.meta.url), "utf8");

const CAUSES = Object.keys(JOB_USER_FIX);
const stopsBoot = (cause) => jobUserBootRefusal({ mode: "unmappable", cause }, DEFAULT_BACKEND) !== null;
const listLine = (label, causes) => `- **${label}**: ${causes.map((cause) => `\`${cause}\``).join(", ")}.`;

/** The two lines this build says the page must carry, in `JOB_USER_FIX`'s own order so there is one canonical form. */
const EXPECTED = [listLine("Stops the boot", CAUSES.filter(stopsBoot)), listLine("Refuses each job", CAUSES.filter((cause) => !stopsBoot(cause)))];

test("the page carries the two cause lists this build generates, verbatim (#357)", () => {
	// Matched against TRIMMED LINES rather than the whole document, which is what makes a hiding place useless: a
	// copy inside an HTML comment, a link reference definition or a table cell is not a line beginning `- **`, and
	// a name spelled with a non-breaking hyphen is not this string. The bullet may carry prose after the full stop.
	const lines = doc.split("\n").map((line) => line.trim());
	for (const want of EXPECTED) {
		const found = lines.filter((line) => line.startsWith(want));
		assert.equal(found.length, 1, `docs/backends.md must carry exactly this line, exactly once:\n${want}`);
	}
});

test("each cause is named once on the whole page, so no sentence can reassign one (#357)", () => {
	// PAGE-WIDE, not block-wide, and the earlier block-wide version is why: a contradicting copy of the two lists
	// somewhere else on the page passed it, and so did moving the block's own end marker. Counted in the BACKTICKED
	// form, which is what avoids the collision that made an honest page fail -- `job-image-any-uid-unsupported` is
	// the id the code uses for the per-image refusal and contains `any-uid-unsupported` as a bare substring.
	for (const cause of CAUSES) {
		assert.equal(doc.split(`\`${cause}\``).length - 1, 1, `${cause} is named once on the page, in its own list`);
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
