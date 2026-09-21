import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BOOT_REFUSING_JOB_USER_CAUSES, JOB_USER_FIX } from "../src/job-user.mjs";
import { jobUserBootRefusal } from "../src/start.mjs";

// `docs/backends.md` names WHEN each job-user refusal fires, which is a restatement of a derivable source, so it is
// BOLTED to that source (CLAUDE.md: a hand-written table is derived or pinned, never trusted). Until this file there
// was NO test reading that page at all, which is why its own refusal sentence had drifted to six causes when the code
// has eight, and omitted `runtime-unreadable` entirely.
//
// The bolt is `jobUserBootRefusal(decision, defaultBackend)` rather than `BOOT_REFUSING_JOB_USER_CAUSES` itself, and
// that is deliberate: the page's claim is not "these four names are in a Set", it is "these stop a boot, and only
// while `local` is the default venue". Only the function carries the second half, and it is exported (`start.mjs`)
// precisely so the branch a one-venue build cannot reach stays pinned.
//
// What is NOT pinned is the prose around the two lists, and `worker/test/podman-doc.test.mjs`'s header records why
// at length: a regex over prose pins a claim's shape and never its truth. The lesson that page paid for four review
// rounds to learn is the reason this file bolts the LISTS to a function instead.

const doc = readFileSync(new URL("../../docs/backends.md", import.meta.url), "utf8");

/**
 * The two cause lists, read from between the markers. Each list is the backticked names BEFORE the first full stop,
 * so the prose after it (which mentions `--user`, `local` and file paths) is out of range by construction rather
 * than by a filter that would have to be kept in step with the wording.
 */
function timingLists() {
	const start = doc.indexOf("<!-- BACKENDS-JOB-USER-TIMING -->");
	const end = doc.indexOf("<!-- /BACKENDS-JOB-USER-TIMING -->");
	assert.ok(start >= 0 && end > start, "the two lists are between their markers");
	const block = doc.slice(start, end);
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
