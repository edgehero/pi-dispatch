import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_BACKEND } from "../src/backends.mjs";
import { BOOT_REFUSING_JOB_USER_CAUSES, JOB_USER_FIX } from "../src/job-user.mjs";
import { jobUserBootRefusal } from "../src/start.mjs";

// `docs/backends.md` names WHEN each job-user refusal fires, which is a restatement of a derivable source, so it is
// BOLTED to that source (CLAUDE.md: a hand-written table is derived or pinned, never trusted). Until this file there
// was NO test reading that page at all, which is why its own refusal sentence had drifted to naming seven of
// the code's eight causes in six clauses, omitting `runtime-unreadable` entirely.
//
// The bolt is `jobUserBootRefusal(decision, defaultBackend)` rather than `BOOT_REFUSING_JOB_USER_CAUSES` itself, and
// that is deliberate: the page's claim is not "these four names are in a Set", it is "these stop a boot, and only
// while `local` is the default venue". Only the function carries the second half, and it is exported (`start.mjs`)
// precisely so the branch a one-venue build cannot reach stays pinned.
//
// What is NOT pinned is the prose around the two lists, and `worker/test/podman-doc.test.mjs`'s header records why
// at length: a regex over prose pins a claim's shape and never its truth. The lesson that page paid for four review
// rounds to learn is the reason this file bolts the LISTS to a function instead.
//
// THE RESIDUAL, stated because an adversarial review found it and nothing below closes it: a sentence that names no
// cause at all is invisible to every rule here. "`pi-dispatch doctor` clears all four boot-stopping causes, so run
// it once and the worker is guaranteed to start" would be false and green. The markers were widened to enclose the
// whole passage so that anything NAMING a cause is caught, which is as far as a derivation reaches. The rest is a
// limit this file states rather than a gap it papers over with a bigger pattern.

const doc = readFileSync(new URL("../../docs/backends.md", import.meta.url), "utf8");

const OPEN = "<!-- BACKENDS-JOB-USER-TIMING -->";
const CLOSE = "<!-- /BACKENDS-JOB-USER-TIMING -->";

/**
 * The block between the markers, with HTML comments removed. Three defences, and every one of them is here
 * because an adversarial review got a WRONG page past an earlier version of this file:
 *
 *   - Exactly one marker of each kind. `indexOf` takes the first, so a decoy pair pasted higher up the page
 *     made the test read a correct copy while the real block below it said the opposite.
 *   - The slice starts AFTER the opening marker and comments are stripped. Markdown hides HTML comments from
 *     the reader but not from `indexOf`, so a correct list in a comment satisfied every assertion while the
 *     rendered bullets were inverted. The same trick hid one cause mid-list from the reader alone.
 *   - The reader sees rendered markdown, so anything the extractor can see and the reader cannot is a lie
 *     this file would otherwise certify.
 */
function timingBlock() {
	assert.equal(doc.split(OPEN).length, 2, "exactly one opening marker");
	assert.equal(doc.split(CLOSE).length, 2, "exactly one closing marker");
	const start = doc.indexOf(OPEN);
	const end = doc.indexOf(CLOSE);
	assert.ok(start >= 0 && end > start, "the two lists are between their markers");
	return doc.slice(start + OPEN.length, end).replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * The two cause lists. Each list is the backticked names BEFORE the first full stop, so the prose after it
 * (which mentions `--user`, `local` and file paths) is out of range by construction rather than by a filter
 * that would have to be kept in step with the wording.
 */
function timingLists() {
	const block = timingBlock();
	const listFor = (label) => {
		const at = block.indexOf(`**${label}**:`);
		assert.ok(at >= 0, `the page names a "${label}" set`);
		const head = block.slice(at + `**${label}**:`.length);
		const stop = head.indexOf(".");
		assert.ok(stop > 0, `${label}: the list ends in a full stop`);
		return [...head.slice(0, stop).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
	};
	return { boot: listFor("Stops the boot"), perJob: listFor("Refuses each job") };
}

test("every cause the page lists is a cause the worker actually has (#357)", () => {
	const { boot, perJob } = timingLists();
	for (const cause of [...boot, ...perJob]) {
		assert.ok(Object.hasOwn(JOB_USER_FIX, cause), `not a cause this worker can refuse with: ${cause}`);
	}
	// Together, exactly the causes -- so a cause cannot be dropped from the page, and cannot be in both sets.
	assert.deepEqual([...boot, ...perJob].sort(), Object.keys(JOB_USER_FIX).sort());
	assert.equal(new Set([...boot, ...perJob]).size, boot.length + perJob.length, "no cause is in both sets");
});

// EXACTLY ONCE EACH, ANYWHERE IN THE BLOCK, and this is the assertion that makes the two lists mean something
// rather than merely exist. The extractor reads up to each bullet's first full stop, so without this the prose
// AFTER it was free to reassign a cause ("`worker-is-root` no longer stops the boot; it refuses each job"), to
// add one to the wrong set, or to name one with no backticks at all, where the regex cannot see it. All three
// passed an earlier version of this file. The constraint it imposes on the page is deliberate: a cause is named
// in its list and nowhere else in the block, so there is exactly one place for a reader to look and exactly one
// place for a future edit to be wrong in.
test("each cause is named exactly once in the block, so prose cannot reassign one (#357)", () => {
	const block = timingBlock();
	for (const cause of Object.keys(JOB_USER_FIX)) {
		assert.equal(block.split(cause).length - 1, 1, `${cause} is named once in the block, in its own list`);
	}
});

// The teeth. A cause the page files under the wrong heading dies here, in either direction, and so does a change to
// the Set that the page was not updated for.
test("the page's two sets are what `jobUserBootRefusal` decides, cause by cause (#357)", () => {
	const { boot, perJob } = timingLists();
	for (const cause of Object.keys(JOB_USER_FIX)) {
		const refused = jobUserBootRefusal({ mode: "unmappable", cause }, "local") !== null;
		assert.equal(refused, boot.includes(cause), `${cause}: the page files it under ${boot.includes(cause) ? "the boot" : "the per-job"} set`);
		assert.equal(!refused, perJob.includes(cause), `${cause}: it belongs to exactly one of the two sets`);
	}
	assert.deepEqual(boot.slice().sort(), [...BOOT_REFUSING_JOB_USER_CAUSES].sort(), "and the boot set is that Set, in full");
});

// The conditional half of the page's claim, which the Set alone cannot carry: "while `local` is the default venue".
// A build with one venue never reaches the other branch, so without this the sentence would be prose nobody checks.
// The page's conditional half, which no derivation can reach: the function proves the BEHAVIOUR is conditional,
// and nothing else stops the page asserting the opposite in words. Replacing the sentence with "that exit is
// unconditional, whatever the default venue is" passed everything above. So the phrase is required, with the venue
// name derived from `DEFAULT_BACKEND` rather than typed, which is the most this can be without pinning prose for
// its own sake. It is the weakest assertion in the file and is kept because the alternative is a page free to
// contradict a behaviour its own test proves.
test("the page states the venue condition, not just a boot-refusing list (#357)", () => {
	const flat = timingBlock().replace(/\s+/g, " ");
	assert.ok(flat.includes(`while \`${DEFAULT_BACKEND}\` is the default venue`), "the page says WHEN the boot exit applies");
});

test("no cause stops a boot when `local` is not the default venue (#357)", () => {
	for (const cause of Object.keys(JOB_USER_FIX)) {
		assert.equal(jobUserBootRefusal({ mode: "unmappable", cause }, "other"), null, cause);
	}
	// And a decision that is not a refusal never stops a boot, whatever the venue: an unanswered daemon reads as
	// `unknown`, which is the page's "in neither set" sentence and the reason a unit with
	// RestartPreventExitStatus=2 is not stranded by a daemon that is still starting.
	for (const decision of [{ mode: "unknown", reason: "no-daemon-facts" }, { mode: "worker", user: "1000:1000" }, { mode: "image", cause: "desktop-platform" }, null]) {
		assert.equal(jobUserBootRefusal(decision, "local"), null, JSON.stringify(decision));
	}
});
