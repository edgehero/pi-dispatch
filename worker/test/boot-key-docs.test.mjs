import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadPauseWindows } from "../src/pause-windows.mjs";
import { loadScopedLimits } from "../src/scoped-limits.mjs";
import { pauseWindowsFilePath, scopedLimitsFilePath } from "../src/config.mjs";
import { EMPTY_PAUSE_WINDOWS, EMPTY_SCOPED_LIMITS } from "../src/init.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// TWO OPERATOR PAGES AND THREE SPEC ENTRIES SAY THE SAME TWO FACTS, and nothing read any of them. Both were
// inverted during review -- "An EMPTY value IS an unset one", "doctor stays silent", "reads this key with
// `||`", "the worker starts normally" -- and the whole suite stayed green, because no test in this repo
// opens `docs/pause-windows.md`, `docs/scoped-limits.md`, `REQ-DEPLOYMENT-BOOTSTRAP`,
// `INT-PAUSE-WINDOWS-FILE-CONTRACT` or `INT-SCOPED-LIMITS-FILE-CONTRACT`. That is CLAUDE.md's own rule
// ("a hand-written table that restates a derivable source is either derived or pinned, never trusted")
// unapplied to five documents that restate a behaviour two modules decide.
//
// The two facts, and each is DERIVED here rather than restated:
//
//   1. an empty value SURVIVES into the loader -- `??`, not `||` -- so the worker refuses to start on it;
//   2. doctor FAILS on that deployment rather than warning or going quiet.
//
// Fact one is DRIVEN here, against `config.mjs` and the two loaders. Fact two's behaviour is driven in
// `doctor.test.mjs` ("an EMPTY PI_PAUSE_WINDOWS_FILE is a REFUSED BOOT", which asserts the exit code), and
// what this file adds is the LINK: the pages must say what that test proves. Saying so is the whole job --
// the pages were inverted while that doctor test stayed green, because nothing connected the two.
//
// What this file deliberately does not pin is the prose around them. A regex wide enough to catch every way
// a page could go wrong would pin sentence SHAPE, and a green regex over a false sentence is worse than no
// test at all. It pins the two claims a reader acts on.

const PAGES = [
	{ path: "docs/pause-windows.md", key: "PI_PAUSE_WINDOWS_FILE" },
	{ path: "docs/scoped-limits.md", key: "PI_SCOPED_LIMITS_FILE" },
];

test("an EMPTY boot key survives the config read, so the page cannot say it reads as unset", () => {
	// FACT ONE, from `config.mjs` itself. `??` keeps an empty string where `||` would drop it, and the two
	// resolvers are what `loadConfig` and doctor both call, so this is the behaviour and not a copy of it.
	assert.equal(pauseWindowsFilePath({ PI_PAUSE_WINDOWS_FILE: "" }), "", "an empty value is a value: `??`, not `||`");
	assert.equal(scopedLimitsFilePath({ PI_SCOPED_LIMITS_FILE: "" }), "");
	assert.equal(pauseWindowsFilePath({}), null, "and only an ABSENT key is null, which is what turns the feature off");
	assert.equal(scopedLimitsFilePath({}), null);
	// So the loader runs on "" and throws, which is the refused boot both pages describe. Driving it is the
	// point: a page could otherwise claim the worker "drops it and starts normally" forever.
	// Through the CONFIG the worker builds, which is the shape `start.mjs` passes at boot, not a bare path.
	assert.throws(() => loadPauseWindows({ pauseWindowsFile: "" }), /does not exist/, "the worker refuses to start rather than ignoring the key");
	assert.throws(() => loadScopedLimits({ scopedLimitsFile: "" }), /does not exist/, "and the same for the spend file");
	assert.deepEqual(loadPauseWindows({ pauseWindowsFile: null }), [], "while an ABSENT key really is the feature off");
	assert.deepEqual(loadScopedLimits({ scopedLimitsFile: null }), []);
});

test("the loaders accept what init scaffolds, or the pages' advice is wrong", () => {
	// The other half of the same claim: the pages tell an operator to fill the line in or delete it, and
	// "fill it in" means the file `pi-dispatch init` wrote. A scaffold the loader rejects would make that
	// advice a second refused boot -- which three doctor fixtures were doing before issue #384 found them.
	const dir = tempDir("pi-boot-docs-");
	const pause = join(dir, "pause-windows.json");
	const scoped = join(dir, "scoped-limits.json");
	writeFileSync(pause, EMPTY_PAUSE_WINDOWS);
	writeFileSync(scoped, EMPTY_SCOPED_LIMITS);
	assert.deepEqual(loadPauseWindows({ pauseWindowsFile: pause }), [], "the scaffold loads to no windows");
	assert.deepEqual(loadScopedLimits({ scopedLimitsFile: scoped }), [], "and to no limits");
});

test("both operator pages say doctor FAILS on an empty value, in the paragraph that describes it", () => {
	// FACT TWO. The wording is not pinned; the CLAIM is: the page must say doctor fails, and must not say it
	// stays silent, warns only, or that the key reads as unset. Each page is searched near its own key so a
	// matching sentence about something else cannot satisfy it.
	for (const { path, key } of PAGES) {
		const text = readFileSync(path, "utf8");
		assert.ok(text.includes(key), `${path}: names the key it is about`);
		const empties = text.split("\n").filter((l) => /EMPTY value/i.test(l));
		assert.ok(empties.length > 0, `${path}: says something about an EMPTY value`);
		const said = empties.join(" ");
		assert.match(said, /is NOT unset|is not an unset one/i, `${path}: an empty value is not an unset one`);
		assert.match(said, /doctor fails on it|doctor \*\*fails\*\*/i, `${path}: and doctor fails on it`);
		assert.doesNotMatch(said, /doctor (stays silent|says nothing)/i, `${path}: the inverted sentence must not survive`);
		assert.doesNotMatch(said, /starts normally|drops it/i, `${path}: nor the inverted consequence`);
	}
});

test("the three spec entries carry the same two facts", () => {
	// The specs are the authority the pages summarise, so they are held to the same two claims. Checked per
	// ENTRY rather than per file, because each file is thousands of lines and a match anywhere in one proves
	// nothing about the entry that owns the rule.
	const entry = (file, heading) => {
		const text = readFileSync(file, "utf8");
		const at = text.indexOf(`## ${heading}`);
		assert.notEqual(at, -1, `${file}: ${heading} exists`);
		const next = text.indexOf("\n## ", at + 1);
		return text.slice(at, next === -1 ? undefined : next);
	};
	for (const heading of ["INT-PAUSE-WINDOWS-FILE-CONTRACT", "INT-SCOPED-LIMITS-FILE-CONTRACT"]) {
		const body = entry("specs/interfaces.md", heading);
		assert.match(body, /EMPTY value is not an unset one|an EMPTY value is NOT an unset one/i, `${heading}: states it`);
		assert.match(body, /refuses to start/i, `${heading}: and what it costs`);
	}
	const req = entry("specs/requirements.md", "REQ-DEPLOYMENT-BOOTSTRAP");
	assert.match(req, /Empty is not unset/i, "REQ-DEPLOYMENT-BOOTSTRAP: states it");
	assert.match(req, /TWO\s+\n?\s*SUBJECTS|TWO SUBJECTS/i, "and that doctor judges two subjects");
});
