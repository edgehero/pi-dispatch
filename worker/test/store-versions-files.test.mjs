import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ANSWER_CATEGORIES } from "../src/answerer.mjs";
import { makeCheckApprovalPolicy } from "../src/approval-policy.mjs";
import { BACKEND_NAMES } from "../src/backends.mjs";
import { FORK_THINKING_LEVELS } from "../src/fork-job.mjs";
import { FORGE_KINDS, RUN_KINDS, forgeSpec } from "../src/forges.mjs";
import { JOB_DATA_FIELD_VERSIONS, JOB_DATA_VALUE_VERSIONS, jobDataVersionFor } from "../src/job-data-version.mjs";
import { FORGE_MCP_KINDS } from "../src/mcp-config.mjs";
import { DAYS, PAUSE_WINDOWS_VERSION, PAUSE_WINDOW_FIELDS, PAUSE_WINDOW_FIELD_VERSIONS, PAUSE_WINDOW_VALUE_VERSIONS, parsePauseWindows, pauseWindowsText, pauseWindowsVersionFor, pauseWindowsVersionRefusal } from "../src/pause-windows.mjs";
import { KNOWN_KEYS, OPERATOR_ONLY_KEYS, SETTINGS_KEY_VERSIONS, SETTINGS_VALUE_VERSIONS, SETTINGS_VERSION, readOverlayDocument, settingsVersionFor, validateOverlay, writeOverlay } from "../src/runtime-settings.mjs";
import { sandboxSyncRefusal } from "../src/sandbox-policy.mjs";
import { createSandboxPinHandler } from "../src/sandbox-prepare.mjs";
import { SANDBOX_MANIFEST, SANDBOX_MANIFEST_FIELD_VERSIONS, SANDBOX_MANIFEST_VERSION, makeSandboxReaper, pinSandbox, retainJobDir, sandboxManifestNewer, sandboxManifestVersionFor, withManifestVersion } from "../src/sandbox-store.mjs";
import { BUNDLE_FORMATS } from "../src/secret-profiles.mjs";
import { valueNeededVersion, valueTableProblems, versionTableProblems } from "../src/store-version.mjs";
import { AUTHORED_NARROWING_FIELDS, disarmTrigger, makeCheckOnceSpent, makeCheckWaitSkew, readDisarmState, writeTriggers } from "../src/triggers-file.mjs";
import { EXCLUDABLE_TOOL_NAMES, ISSUE_ACTIONS, MCP_EXCLUDABLE_TOOL_NAMES, ON_TYPES, PR_ACTIONS, REVIEW_STATES, TRIGGERS_BLOCK_VALUE_VERSIONS, TRIGGERS_BLOCK_VERSIONS, TRIGGERS_FILE_VERSION, TRIGGER_RUN_FIELD_VERSIONS, TRIGGER_RUN_VALUE_VERSIONS, TRIGGER_VALUE_VERSIONS, parseTriggers, parseTriggersDocument, triggersFileNewer, triggersFileVersionFor, triggersFileVersionProblem } from "../src/triggers.mjs";
import { WAIT_CONDITION_KEYS } from "../src/wait-for.mjs";
import { WATCH_SEVERITIES } from "../src/watch-contract.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #761, item 9: the optional version of the overlay, the pause windows file, the triggers file and the sandbox
// manifest. Every shipped table is empty, so nothing is stamped in this release; each store's machinery is run here with
// an INJECTED table, as a later release will run it: the writer stamps the lowest version needed, unsetting the field
// drops the stamp, the same build reads the file, and a build that reads less calls it newer.

const src = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
/** The body of the top-level function `name` in `text`, up to its closing brace at column 0. */
const bodyOf = (text, name) => {
	const start = text.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `${name} is in the source`);
	return text.slice(start, text.indexOf("\n}\n", start));
};
const AT = "2026-08-28T09:00:00.000Z";
const T0 = Date.parse("2026-08-28T09:00:00.000Z");
const HOUR = 3_600_000;

// ── settings overlay ───────────────────────────────────────────────────────────────────────────────────────────────

test("settings: the shipped tables hold the rule, and version is never a settable key", () => {
	assert.equal(SETTINGS_VERSION, 1);
	assert.deepEqual(versionTableProblems(SETTINGS_KEY_VERSIONS, { known: [...KNOWN_KEYS, ...OPERATOR_ONLY_KEYS], version: SETTINGS_VERSION }), []);
	assert.deepEqual(valueTableProblems(SETTINGS_VALUE_VERSIONS, { known: [...KNOWN_KEYS, ...OPERATOR_ONLY_KEYS], version: SETTINGS_VERSION }), []);
	// A value rule can raise the version with no key-table row, which versionTableProblems cannot see. While there is
	// none, the version is the key table's; the first value rule must extend this assertion with the versions it returns.
	assert.deepEqual(Object.keys(SETTINGS_VALUE_VERSIONS), []);
	assert.equal(KNOWN_KEYS.includes("version"), false, "no tool, command or dialog can set it");
	assert.equal(OPERATOR_ONLY_KEYS.includes("version"), false);
});

test("settings: with an injected key table the writer stamps the lowest version, a lower build calls it newer, and an unset drops the stamp", () => {
	const versions = { table: Object.freeze({ softHoldPct: 2 }), supported: 2 };
	const path = join(tempDir("store-versions-"), "settings.json");
	assert.deepEqual(writeOverlay(path, { dailyCap: 1, softHoldPct: 50 }, versions), { ok: true });
	assert.equal(readFileSync(path, "utf8"), '{\n  "version": 2,\n  "dailyCap": 1,\n  "softHoldPct": 50\n}\n');
	const read = readOverlayDocument(path, versions);
	assert.deepEqual(read.overlay, { dailyCap: 1, softHoldPct: 50 }, "the same build reads it");
	assert.deepEqual(readOverlayDocument(path, { table: versions.table }), { invalid: "settings file written by a newer pi-dispatch (version 2; this build understands 1)", newer: true });
	// Unset the key that needed it, carrying the file: the stamp goes with it.
	const { softHoldPct: _unset, ...rest } = read.overlay;
	assert.deepEqual(writeOverlay(path, rest, { ...versions, carry: read.carry }), { ok: true });
	assert.equal(readFileSync(path, "utf8"), '{\n  "dailyCap": 1\n}\n');
	// A key that needs a version the file does not declare: written by hand, refused by name.
	writeFileSync(path, '{ "softHoldPct": 50 }');
	assert.deepEqual(readOverlayDocument(path, versions), { invalid: "softHoldPct needs settings version 2, and the file declares 1" });
	// A writer whose build cannot read what it would stamp refuses rather than leave a file it cannot read.
	assert.match(writeOverlay(path, { softHoldPct: 50 }, { table: versions.table }).invalid, /written by a newer pi-dispatch \(version 2; this build understands 1\)/);
	assert.equal(readFileSync(path, "utf8"), '{ "softHoldPct": 50 }');
});

test("settings: a value rule stamps exactly the values that need it (a range a later release widened)", () => {
	const versions = { valueTable: Object.freeze({ concurrency: (v) => (v > 5 ? 2 : 1) }), supported: 2 };
	assert.equal(settingsVersionFor({ concurrency: 3 }, versions), 1);
	assert.equal(settingsVersionFor({ concurrency: 7 }, versions), 2);
	const path = join(tempDir("store-versions-"), "settings.json");
	assert.deepEqual(writeOverlay(path, { concurrency: 7 }, versions), { ok: true });
	assert.equal(readFileSync(path, "utf8"), '{\n  "version": 2,\n  "concurrency": 7\n}\n');
	assert.deepEqual(writeOverlay(path, { concurrency: 3 }, versions), { ok: true });
	assert.equal(readFileSync(path, "utf8"), '{\n  "concurrency": 3\n}\n');
	writeFileSync(path, '{ "concurrency": 7 }');
	assert.deepEqual(readOverlayDocument(path, versions), { invalid: "concurrency holds a value that needs settings version 2, and the file declares 1" });
});

// ── pause windows ──────────────────────────────────────────────────────────────────────────────────────────────────

const WINDOW = { scope: "*", from: "01:00", to: "02:00" };

test("pause windows: PAUSE_WINDOW_FIELDS is exactly what the normalizer reads, and each listed field is read", () => {
	const reads = [...new Set([...bodyOf(src("pause-windows.mjs"), "normalizeWindow").matchAll(/\bw\.(\w+)/g)].map((m) => m[1]))];
	assert.deepEqual([...PAUSE_WINDOW_FIELDS].sort(), reads.sort());
	assert.ok(Object.isFrozen(PAUSE_WINDOW_FIELDS));
	const bad = { scope: "", from: "25:00", to: "x", tz: "Mars/Olympus", days: [], dateFrom: "soon", dateTo: "later" };
	for (const field of PAUSE_WINDOW_FIELDS) {
		assert.throws(() => parsePauseWindows(JSON.stringify({ windows: [{ ...WINDOW, [field]: bad[field] }] }), "/p"), new RegExp(`\\b${field}\\b`), field);
	}
	assert.equal(PAUSE_WINDOWS_VERSION, 1);
	assert.deepEqual(versionTableProblems(PAUSE_WINDOW_FIELD_VERSIONS, { known: PAUSE_WINDOW_FIELDS, version: PAUSE_WINDOWS_VERSION }), []);
	assert.deepEqual(valueTableProblems(PAUSE_WINDOW_VALUE_VERSIONS, { known: PAUSE_WINDOW_FIELDS, version: PAUSE_WINDOWS_VERSION }), []);
	// A value rule can raise the version with no field-table row, which neither check can see. While there is none, the
	// version is the field table's; the first value rule must extend this assertion with the versions it answers.
	assert.deepEqual(Object.keys(PAUSE_WINDOW_VALUE_VERSIONS), []);
});

test("pause windows: the writer's text carries every other top-level key in place, and a windows-only file is today's exact bytes", () => {
	const windows = [{ ...WINDOW, tz: "Europe/Amsterdam" }];
	const today = `${JSON.stringify({ windows }, null, 2)}\n`;
	assert.equal(pauseWindowsText({ windows: [] }, windows), today);
	assert.equal(pauseWindowsText(null, windows), today, "the repair-from-empty shape");
	assert.equal(pauseWindowsText({ windows: [], version: 1 }, windows), today, "a hand-written version 1 is dropped");
	assert.equal(
		pauseWindowsText({ note: "kept", windows: [], later: { on: true } }, [WINDOW]),
		'{\n  "note": "kept",\n  "windows": [\n    {\n      "scope": "*",\n      "from": "01:00",\n      "to": "02:00"\n    }\n  ],\n  "later": {\n    "on": true\n  }\n}\n',
	);
	assert.equal(pauseWindowsText({ later: 1 }, []), '{\n  "windows": [],\n  "later": 1\n}\n', "windows leads when the file had none");
	const proto = JSON.parse('{"__proto__": {"x": 1}, "windows": []}');
	const text = pauseWindowsText(proto, []);
	assert.equal(text, '{\n  "__proto__": {\n    "x": 1\n  },\n  "windows": []\n}\n', "a key named __proto__ stays data");
});

test("pause windows: with an injected table the stamp is written and dropped, the same build reads it, and a lower one calls it newer", () => {
	const table = Object.freeze({ dateTo: 2 });
	const dated = [{ ...WINDOW, dateTo: "2026-12-31" }];
	assert.equal(pauseWindowsVersionFor(dated, { table }), 2);
	assert.equal(pauseWindowsVersionFor([WINDOW], { table }), 1);
	const text = pauseWindowsText({ note: 1, windows: [] }, dated, { table });
	assert.ok(text.startsWith('{\n  "version": 2,\n  "note": 1,\n  "windows": ['), text);
	assert.equal(parsePauseWindows(text, "/p", { supported: 2, table }).length, 1, "the same build reads it");
	assert.throws(() => parsePauseWindows(text, "/p", { table }), (error) => error.piDispatchConfig === true && error.newer === true && error.message === "pause-windows file written by a newer pi-dispatch (version 2; this build understands 1): /p");
	assert.deepEqual(pauseWindowsVersionRefusal(JSON.parse(text)), { newer: true, message: "pause-windows file written by a newer pi-dispatch (version 2; this build understands 1)" });
	assert.equal(pauseWindowsVersionRefusal(JSON.parse(text), { supported: 2 }), null);
	// Unset: the window without the field, over the stamped document, loses the stamp.
	assert.equal(pauseWindowsText(JSON.parse(text), [WINDOW], { table }), `${JSON.stringify({ note: 1, windows: [WINDOW] }, null, 2)}\n`);
	// A window using the field without the version is refused by its index and field, as an ordinary config error.
	assert.throws(() => parsePauseWindows(JSON.stringify({ windows: [WINDOW, dated[0]] }), "/p", { supported: 2, table }), (error) => error.newer === undefined && error.message === "pause window at index 1: dateTo needs pause-windows file version 2, and the file declares 1: /p");
});

test("pause windows: the highest version among several windows wins, in either order", () => {
	const table = Object.freeze({ dateTo: 2, tz: 3 });
	const dated = { ...WINDOW, dateTo: "2026-12-31" };
	const zoned = { ...WINDOW, tz: "Europe/Amsterdam" };
	assert.equal(pauseWindowsVersionFor([zoned, dated], { table }), 3);
	assert.equal(pauseWindowsVersionFor([dated, zoned], { table }), 3);
	assert.equal(pauseWindowsVersionFor([dated, WINDOW], { table }), 2, "a later window that needs nothing does not lower it");
	assert.ok(pauseWindowsText(null, [zoned, dated, WINDOW], { table }).startsWith('{\n  "version": 3,\n'));
	// The same for a value rule beside a field rule.
	const valueTable = Object.freeze({ days: (days) => (Array.isArray(days) && days.some((d) => String(d).length > 3) ? 4 : 1) });
	const spelled = { ...WINDOW, days: ["monday"] };
	assert.equal(pauseWindowsVersionFor([spelled, zoned], { table, valueTable }), 4);
	assert.equal(pauseWindowsVersionFor([zoned, spelled], { table, valueTable }), 4);
});

test("pause windows: with an injected value table a wider value is stamped, an ordinary one is today's bytes, and a lower build calls it newer", () => {
	// A spelled-out weekday (which this build already reads as its first three letters) stands in for a `days` form a
	// later release adds; a new scope form would be ruled the same way.
	const valueTable = Object.freeze({ days: (days) => (Array.isArray(days) && days.some((d) => String(d).length > 3) ? 2 : 1) });
	const spelled = [{ ...WINDOW, days: ["monday"] }];
	const short = [{ ...WINDOW, days: ["mon"] }];
	assert.equal(pauseWindowsText({ windows: [] }, short, { valueTable }), `${JSON.stringify({ windows: short }, null, 2)}\n`, "an ordinary value is today's exact bytes");
	const text = pauseWindowsText({ note: 1, windows: [] }, spelled, { valueTable });
	assert.ok(text.startsWith('{\n  "version": 2,\n  "note": 1,\n  "windows": ['), text);
	assert.deepEqual(parsePauseWindows(text, "/p", { supported: 2, valueTable })[0].days, ["mon"], "the same build reads it");
	assert.throws(() => parsePauseWindows(text, "/p", { valueTable }), (error) => error.piDispatchConfig === true && error.newer === true && error.message === "pause-windows file written by a newer pi-dispatch (version 2; this build understands 1): /p");
	// Unset: the plain value over the stamped document loses the stamp.
	assert.equal(pauseWindowsText(JSON.parse(text), short, { valueTable }), `${JSON.stringify({ note: 1, windows: short }, null, 2)}\n`);
	// Written by hand without the version: refused by the window's index and field, as an ordinary config error.
	assert.throws(() => parsePauseWindows(JSON.stringify({ windows: [WINDOW, spelled[0]] }), "/p", { supported: 2, valueTable }), (error) => error.newer === undefined && error.message === "pause window at index 1: days holds a value that needs pause-windows file version 2, and the file declares 1: /p");
});

test("pause windows: a broken version is an ordinary config error, judged before the windows; a newer one is newer even when its windows would not parse", () => {
	for (const version of ["2", 0, 1.5]) {
		assert.throws(() => parsePauseWindows(JSON.stringify({ version, windows: [] }), "/p"), (error) => error.newer === undefined && error.message === 'pause-windows file "version" must be an integer of 1 or more: /p');
		assert.equal(pauseWindowsVersionRefusal({ version }).newer, false);
	}
	assert.throws(() => parsePauseWindows(JSON.stringify({ version: 3, windows: "reshaped" }), "/p"), (error) => error.newer === true);
	assert.equal(pauseWindowsVersionRefusal({ windows: [] }), null);
	assert.equal(pauseWindowsVersionRefusal(null), null);
});

// ── triggers file ──────────────────────────────────────────────────────────────────────────────────────────────────

const label = () => ({ on: { type: "label", any: ["dispatch"] }, run: { kind: "github", flow: "fix" } });
const once = () => ({ on: { type: "issue", action: ["closed"], number: 40, once: true }, run: { kind: "github", flow: "deploy" } });
const triggersPathWith = (doc) => {
	const path = join(tempDir("store-versions-"), "triggers.json");
	writeFileSync(path, typeof doc === "string" ? doc : `${JSON.stringify(doc, null, 2)}\n`);
	return path;
};

test("triggers: the shipped tables hold the rule, against the run keys and blocks the loader reads", () => {
	assert.equal(TRIGGERS_FILE_VERSION, 1);
	// Every `run.<key>` any worker module reads: a lenient superset (comments add names), which is enough to refuse a
	// table row naming a key nothing reads.
	const runKeys = new Set();
	for (const name of readdirSync(new URL("../src/", import.meta.url))) {
		if (!name.endsWith(".mjs")) continue;
		for (const m of src(name).matchAll(/\brun\??\.(\w+)/g)) runKeys.add(m[1]);
	}
	assert.deepEqual(versionTableProblems(TRIGGER_RUN_FIELD_VERSIONS, { known: [...runKeys], version: TRIGGERS_FILE_VERSION }), []);
	const blocks = [...new Set([...bodyOf(src("triggers.mjs"), "parseTriggersDocument").matchAll(/\bparsed\??\.(\w+)/g)].map((m) => m[1]))].filter((key) => key !== "version");
	assert.ok(blocks.includes("secretBundles") && blocks.includes("triggers"), blocks.join(","));
	assert.deepEqual(versionTableProblems(TRIGGERS_BLOCK_VERSIONS, { known: blocks, version: TRIGGERS_FILE_VERSION }), []);
	assert.deepEqual(valueTableProblems(TRIGGERS_BLOCK_VALUE_VERSIONS, { known: blocks, version: TRIGGERS_FILE_VERSION }), []);
	// The value tables: an entry's own fields (every `entry.<key>` the loader reads), and the same `run` keys as above.
	const entryKeys = [...new Set([...src("triggers.mjs").matchAll(/\bentry\??\.(\w+)/g)].map((m) => m[1]))];
	assert.ok(entryKeys.includes("on") && entryKeys.includes("run"), entryKeys.join(","));
	assert.deepEqual(valueTableProblems(TRIGGER_VALUE_VERSIONS, { known: entryKeys, version: TRIGGERS_FILE_VERSION }), []);
	assert.deepEqual(valueTableProblems(TRIGGER_RUN_VALUE_VERSIONS, { known: [...runKeys], version: TRIGGERS_FILE_VERSION }), []);
	// A value rule can raise the version with no field-table row, which neither check can see. While there is none, the
	// version is the field tables'; the first value rule must extend this assertion with the versions it answers.
	assert.deepEqual([...Object.keys(TRIGGER_VALUE_VERSIONS), ...Object.keys(TRIGGER_RUN_VALUE_VERSIONS), ...Object.keys(TRIGGERS_BLOCK_VALUE_VERSIONS)], []);
});

// ── closed domains ─────────────────────────────────────────────────────────────────────────────────────────────────
// A field whose value an older build checks against a closed list refuses a wider value as BROKEN (a job refused
// `wait-unreadable`, a pause or triggers file that no longer loads, a settings overlay every job is refused on) where a
// version would make it defer as NEWER. So each
// list is pinned at what it held when issue #761 gave these stores their versions, and a member added later needs a value
// rule, in the store(s) that carry the field, that answers 2 or more for it. The rule is probed with one condition or
// scope of the new kind; it must answer for at least one of a few plausible values.
const PROBES = [true, "x", 1, {}, [], null];
const anyProbe = (needs) => Math.max(...PROBES.map(needs));
const WAIT_KINDS_BASELINE = ["after", "profile"];
const FORGE_KINDS_BASELINE = ["github", "gitlab", "forgejo", "azure"];
const DAYS_BASELINE = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const RUN_KINDS_BASELINE = ["local", "github", "gitlab", "forgejo", "azure"];
const ON_TYPES_BASELINE = ["cron", "label", "comment", "pull_request", "issue", "watch"];
const BUNDLE_FORMATS_BASELINE = ["dotenv", "json"];
const waitProblems = (kinds, { jobTable = JOB_DATA_VALUE_VERSIONS, runTable = TRIGGER_RUN_VALUE_VERSIONS } = {}) =>
	kinds
		.filter((kind) => !WAIT_KINDS_BASELINE.includes(kind))
		.filter((kind) => anyProbe((p) => valueNeededVersion({ waitFor: [{ [kind]: p }] }, jobTable)) < 2 || anyProbe((p) => valueNeededVersion({ waitFor: [{ [kind]: p }] }, runTable)) < 2)
		.map((kind) => `the wait condition ${JSON.stringify(kind)} is newer than issue #761's list: an older worker refuses a job carrying it as wait-unreadable and an older loader refuses the triggers file, so JOB_DATA_VALUE_VERSIONS.waitFor and TRIGGER_RUN_VALUE_VERSIONS.waitFor each need a rule answering 2 or more for it`);
const scopeProblems = (kinds, { table = PAUSE_WINDOW_VALUE_VERSIONS } = {}) =>
	kinds
		.filter((kind) => !FORGE_KINDS_BASELINE.includes(kind))
		.filter((kind) => valueNeededVersion({ scope: `${kind}:acme/web` }, table) < 2)
		.map((kind) => `the forge kind ${JSON.stringify(kind)} is newer than issue #761's list: an older build refuses a pause windows file holding the scope "${kind}:owner/name" as broken, so PAUSE_WINDOW_VALUE_VERSIONS.scope needs a rule answering 2 or more for it`);
const dayProblems = (days, { table = PAUSE_WINDOW_VALUE_VERSIONS } = {}) =>
	days
		.filter((day) => !DAYS_BASELINE.includes(day))
		.filter((day) => valueNeededVersion({ days: [day] }, table) < 2)
		.map((day) => `the weekday ${JSON.stringify(day)} is newer than issue #761's list: an older build refuses a pause windows file whose days name it as broken, so PAUSE_WINDOW_VALUE_VERSIONS.days needs a rule answering 2 or more for it`);
// A job of a kind this build does not know is refused `config-refused` at the token mint (no forge credentials for
// that kind): recorded, commented on, its one-shot disarmed. So a new kind needs the job data stamped as well as the
// triggers file, which turns that refusal into a deferral.
const runKindProblems = (kinds, { runTable = TRIGGER_RUN_VALUE_VERSIONS, jobTable = JOB_DATA_VALUE_VERSIONS } = {}) =>
	kinds
		.filter((kind) => !RUN_KINDS_BASELINE.includes(kind))
		.filter((kind) => valueNeededVersion({ kind }, runTable) < 2 || valueNeededVersion({ kind }, jobTable) < 2)
		.map((kind) => `the run kind ${JSON.stringify(kind)} is newer than issue #761's list: an older loader refuses the triggers file as broken and an older worker refuses its jobs as config-refused, so TRIGGER_RUN_VALUE_VERSIONS.kind and JOB_DATA_VALUE_VERSIONS.kind each need a rule answering 2 or more for it`);
const onProblems = (types, { table = TRIGGER_VALUE_VERSIONS } = {}) =>
	types
		.filter((type) => !ON_TYPES_BASELINE.includes(type))
		.filter((type) => valueNeededVersion({ on: { type } }, table) < 2)
		.map((type) => `the on.type ${JSON.stringify(type)} is newer than issue #761's list: an older loader refuses the whole triggers file as broken, so TRIGGER_VALUE_VERSIONS.on needs a rule answering 2 or more for it`);
// The overlay refuses an invalid key WHOLE, so a bundle format an older build does not know refuses every job as
// `settings-overlay-invalid`, the widest refusal any widened value has. Only the overlay carries a bundle's format (a
// triggers file's `secretBundles` names a profile, never a format), so one table needs the rule.
const bundleFormatProblems = (formats, { table = SETTINGS_VALUE_VERSIONS } = {}) =>
	formats
		.filter((format) => !BUNDLE_FORMATS_BASELINE.includes(format))
		.filter((format) => valueNeededVersion({ secretBundles: { shop: { path: "/opt/secrets/shop.sh", format } } }, table) < 2)
		.map((format) => `the bundle format ${JSON.stringify(format)} is newer than issue #761's list: an older build refuses the whole settings overlay holding a secretBundles entry of that format as broken (every job settings-overlay-invalid), so SETTINGS_VALUE_VERSIONS.secretBundles needs a rule answering 2 or more for it`);

test("closed domains: a wait condition, a forge kind a pause scope names, a weekday, a run kind, an on.type or a bundle format added after issue #761 needs a value rule", () => {
	const domains = [["WAIT_CONDITION_KEYS", WAIT_CONDITION_KEYS, WAIT_KINDS_BASELINE], ["FORGE_KINDS", FORGE_KINDS, FORGE_KINDS_BASELINE], ["DAYS", DAYS, DAYS_BASELINE], ["RUN_KINDS", RUN_KINDS, RUN_KINDS_BASELINE], ["ON_TYPES", [...ON_TYPES], ON_TYPES_BASELINE], ["BUNDLE_FORMATS", BUNDLE_FORMATS, BUNDLE_FORMATS_BASELINE]];
	for (const [name, domain, baseline] of domains) {
		for (const member of baseline) assert.ok(domain.includes(member), `${member} is still in ${name}`);
	}
	assert.ok(Object.isFrozen(DAYS));
	assert.ok(Object.isFrozen(BUNDLE_FORMATS));
	assert.deepEqual(waitProblems(WAIT_CONDITION_KEYS), []);
	assert.deepEqual(scopeProblems(FORGE_KINDS), []);
	assert.deepEqual(dayProblems(DAYS), []);
	assert.deepEqual(runKindProblems(RUN_KINDS), []);
	assert.deepEqual(onProblems([...ON_TYPES]), []);
	assert.deepEqual(bundleFormatProblems(BUNDLE_FORMATS), []);
});

test("closed domains: the weekdays are the ones the normalizer accepts, read by their first three letters", () => {
	for (const day of DAYS) assert.deepEqual(parsePauseWindows(JSON.stringify({ windows: [{ ...WINDOW, days: [day.toUpperCase(), `${day}x`] }] }), "/p")[0].days, [day, day]);
	assert.throws(() => parsePauseWindows(JSON.stringify({ windows: [{ ...WINDOW, days: ["hol"] }] }), "/p"), /unknown weekday "hol"/);
});

test("closed domains: the bundle formats are the ones the overlay accepts, any other refuses it whole, and a stamp turns that into newer", () => {
	const bundle = (format) => ({ secretBundles: { shop: { path: "/opt/secrets/shop.sh", format } } });
	for (const format of BUNDLE_FORMATS) assert.deepEqual(validateOverlay(bundle(format)).overlay, bundle(format));
	assert.deepEqual(validateOverlay(bundle("yaml")), { invalid: `secretBundles.shop.format must be ${BUNDLE_FORMATS.join(" or ")}` });
	// The version is judged before the format, so the same entry in a stamped file reads as an upgrade, never as broken.
	assert.deepEqual(validateOverlay({ version: 2, ...bundle("yaml") }), { invalid: "settings file written by a newer pi-dispatch (version 2; this build understands 1)", newer: true });
});

test("closed domains: the check refuses a widened list without a rule, and accepts it with one", () => {
	const holds = (key, kind) => (list) => (Array.isArray(list) && list.some((c) => c !== null && typeof c === "object" && Object.hasOwn(c, key)) ? 2 : 1);
	assert.deepEqual(waitProblems([...WAIT_CONDITION_KEYS, "issueClosed"]), [
		'the wait condition "issueClosed" is newer than issue #761\'s list: an older worker refuses a job carrying it as wait-unreadable and an older loader refuses the triggers file, so JOB_DATA_VALUE_VERSIONS.waitFor and TRIGGER_RUN_VALUE_VERSIONS.waitFor each need a rule answering 2 or more for it',
	]);
	const waitRule = Object.freeze({ waitFor: holds("issueClosed") });
	assert.equal(waitProblems([...WAIT_CONDITION_KEYS, "issueClosed"], { jobTable: waitRule }).length, 1, "both stores carry the field, so both need the rule");
	assert.deepEqual(waitProblems([...WAIT_CONDITION_KEYS, "issueClosed"], { jobTable: waitRule, runTable: waitRule }), []);
	assert.equal(scopeProblems([...FORGE_KINDS, "bitbucket"]).length, 1);
	assert.deepEqual(scopeProblems([...FORGE_KINDS, "bitbucket"], { table: Object.freeze({ scope: (scope) => (String(scope).startsWith("bitbucket:") ? 2 : 1) }) }), []);
	assert.equal(dayProblems([...DAYS, "hol"]).length, 1);
	assert.deepEqual(dayProblems([...DAYS, "hol"], { table: Object.freeze({ days: (days) => (Array.isArray(days) && days.includes("hol") ? 2 : 1) }) }), []);
	assert.deepEqual(runKindProblems([...RUN_KINDS, "bitbucket"]), [
		'the run kind "bitbucket" is newer than issue #761\'s list: an older loader refuses the triggers file as broken and an older worker refuses its jobs as config-refused, so TRIGGER_RUN_VALUE_VERSIONS.kind and JOB_DATA_VALUE_VERSIONS.kind each need a rule answering 2 or more for it',
	]);
	const kindRule = Object.freeze({ kind: (kind) => (kind === "bitbucket" ? 2 : 1) });
	assert.equal(runKindProblems([...RUN_KINDS, "bitbucket"], { runTable: kindRule }).length, 1, "the triggers file and the job data both carry the kind, so both need the rule");
	assert.deepEqual(runKindProblems([...RUN_KINDS, "bitbucket"], { runTable: kindRule, jobTable: kindRule }), []);
	assert.equal(onProblems([...ON_TYPES, "release"]).length, 1);
	assert.deepEqual(onProblems([...ON_TYPES, "release"], { table: Object.freeze({ on: (on) => (on?.type === "release" ? 2 : 1) }) }), []);
	assert.deepEqual(bundleFormatProblems([...BUNDLE_FORMATS, "yaml"]), [
		'the bundle format "yaml" is newer than issue #761\'s list: an older build refuses the whole settings overlay holding a secretBundles entry of that format as broken (every job settings-overlay-invalid), so SETTINGS_VALUE_VERSIONS.secretBundles needs a rule answering 2 or more for it',
	]);
	const formatRule = Object.freeze({ secretBundles: (bundles) => (Object.values(bundles ?? {}).some((b) => b?.format === "yaml") ? 2 : 1) });
	assert.deepEqual(bundleFormatProblems([...BUNDLE_FORMATS, "yaml"], { table: formatRule }), []);
});

// The loader's other exported closed lists, and the processor's. Each new member is probed with a one-trigger (or
// one-block) document holding it, judged by the file's whole need (`triggersFileVersionFor`), so a rule in whichever
// table can see the value satisfies the bolt; the message names the narrowest table that sees it. A forge's actions are
// probed on that forge, so a new forge's whole row is covered by the `kind` rule `RUN_KINDS` already requires. Where
// the worker refuses the value in a queued job (a recorded, commented refusal), the job data needs the rule too, probed
// with the job's fields through `jobDataVersionFor`.
const TABLE_NAMES = Object.freeze({ entryValueTable: "TRIGGER_VALUE_VERSIONS", runValueTable: "TRIGGER_RUN_VALUE_VERSIONS", blockValueTable: "TRIGGERS_BLOCK_VALUE_VERSIONS", jobTable: "JOB_DATA_VALUE_VERSIONS" });
const LABEL_ON = Object.freeze({ type: "label", any: ["dispatch"] });
const oneTrigger = (on, run) => ({ triggers: [{ on, run }] });
const perForge = (table) => Object.entries(table).flatMap(([kind, actions]) => [...actions].map((action) => `${kind}:${action}`));
const forgeAction = (member) => member.split(":");
const LOADER_REFUSES = "an older loader refuses the whole triggers file as broken";
const OTHER_DOMAINS = Object.freeze([
	{
		name: "PR_ACTIONS",
		refused: "pull_request on.action has an unsupported",
		members: () => perForge(PR_ACTIONS),
		baseline: perForge({ github: ["labeled", "opened", "synchronize", "reopened", "review_submitted", "closed"], gitlab: ["open", "update", "reopen", "approved", "close"], forgejo: ["label_updated", "opened", "synchronized", "reopened", "closed"], azure: ["created", "updated"] }),
		what: (m) => `the ${forgeAction(m)[0]} pull_request action ${JSON.stringify(forgeAction(m)[1])}`,
		refusal: LOADER_REFUSES,
		// The forge's label action needs a label to wait for; every other action is refused one.
		probes: [{ table: "entryValueTable", field: "on", doc: (m) => { const [kind, action] = forgeAction(m); return oneTrigger({ type: "pull_request", action: [action], ...(action === forgeSpec(kind)?.prLabelAction ? { any: ["dispatch"] } : {}) }, { kind, flow: "fix" }); } }],
		widened: "github:edited",
	},
	{
		name: "ISSUE_ACTIONS",
		refused: "issue on.action has an unsupported",
		members: () => perForge(ISSUE_ACTIONS),
		baseline: perForge({ github: ["closed"], gitlab: ["close"], forgejo: ["closed"] }),
		what: (m) => `the ${forgeAction(m)[0]} issue action ${JSON.stringify(forgeAction(m)[1])}`,
		refusal: LOADER_REFUSES,
		probes: [{ table: "entryValueTable", field: "on", doc: (m) => oneTrigger({ type: "issue", action: [forgeAction(m)[1]], number: 40 }, { kind: forgeAction(m)[0], flow: "deploy" }) }],
		widened: "github:reopened",
	},
	{
		name: "REVIEW_STATES",
		refused: "has an unsupported review state",
		members: () => [...REVIEW_STATES],
		baseline: ["approved", "changes_requested", "commented"],
		what: (m) => `the review state ${JSON.stringify(m)}`,
		refusal: LOADER_REFUSES,
		probes: [{ table: "entryValueTable", field: "on", doc: (m) => oneTrigger({ type: "pull_request", action: ["review_submitted"], reviewState: [m] }, { kind: "github", flow: "fix" }) }],
		widened: "dismissed",
	},
	{
		name: "EXCLUDABLE_TOOL_NAMES",
		refused: "is not a tool the pinned pi knows",
		members: () => [...EXCLUDABLE_TOOL_NAMES],
		baseline: ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"],
		what: (m) => `the pi tool ${JSON.stringify(m)}`,
		refusal: `${LOADER_REFUSES} when a run.excludeTools names it (a pi bump that adds a built-in tool grows this list through .github/scripts/pi-derived.mjs)`,
		probes: [{ table: "runValueTable", field: "excludeTools", doc: (m) => oneTrigger(LABEL_ON, { kind: "github", flow: "fix", excludeTools: [m] }) }],
		widened: "web_fetch",
	},
	{
		name: "MCP_EXCLUDABLE_TOOL_NAMES",
		refused: "is not a tool the pinned pi knows",
		members: () => [...MCP_EXCLUDABLE_TOOL_NAMES],
		baseline: ["codemode", "tool_search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"],
		what: (m) => `the MCP tool ${JSON.stringify(m)}`,
		refusal: `${LOADER_REFUSES} when a run.excludeTools beside run.mcp names it`,
		probes: [{ table: "runValueTable", field: "excludeTools", doc: (m) => oneTrigger(LABEL_ON, { kind: "github", flow: "fix", mcp: ["docs"], excludeTools: [m] }) }],
		widened: "list_mcp_prompts",
	},
	{
		name: "BACKEND_NAMES",
		refused: "is not a backend this build knows",
		members: () => [...BACKEND_NAMES],
		baseline: ["local", "podman", "openshell", "openshell-bind"],
		what: (m) => `the venue ${JSON.stringify(m)}`,
		// An older worker's PI_BACKENDS can name only its own venues, so its blessed list never holds the new one.
		refusal: `${LOADER_REFUSES} when a run.backend names it, and an older worker refuses its jobs as backend-unblessed`,
		probes: [
			{ table: "runValueTable", field: "backend", doc: (m) => oneTrigger(LABEL_ON, { kind: "github", flow: "fix", backend: m }) },
			{ table: "jobTable", field: "backend", doc: (m) => ({ kind: "github", flow: "fix", backend: m }) },
		],
		widened: "firecracker",
	},
	{
		name: "FORGE_MCP_KINDS",
		refused: "which a github or gitlab trigger may name",
		members: () => [...FORGE_MCP_KINDS],
		baseline: ["github", "gitlab"],
		what: (m) => `the forge MCP kind ${JSON.stringify(m)}`,
		// The kind and the server list are two `run` keys, so only a rule on the whole `run` sees both. A job's fields are
		// judged one at a time, so its rule sits on `mcp` and stamps every job that names the forge server.
		refusal: `${LOADER_REFUSES} when a trigger of that kind names the forge MCP server, and an older worker refuses such a job as mcp-server-unknown`,
		probes: [
			{ table: "entryValueTable", field: "run", doc: (m) => oneTrigger(LABEL_ON, { kind: m, flow: "fix", mcp: ["forge"] }) },
			{ table: "jobTable", field: "mcp", doc: (m) => ({ kind: m, flow: "fix", mcp: ["forge"] }), rule: () => (mcp) => (Array.isArray(mcp) && mcp.includes("forge") ? 2 : 1) },
		],
		widened: "forgejo",
	},
	{
		name: "ANSWER_CATEGORIES",
		refused: "answerRules categories are",
		members: () => [...ANSWER_CATEGORIES],
		baseline: ["convention", "how-to", "decided"],
		what: (m) => `the answer category ${JSON.stringify(m)}`,
		refusal: `${LOADER_REFUSES} when an answerRules entry names it`,
		probes: [{ table: "blockValueTable", field: "answerRules", doc: (m) => ({ triggers: [], answerRules: [{ id: "docs", projects: ["web"], categories: [m], confidence: 0.9, mode: "draft", flow: "answer", model: "anthropic/claude-sonnet-4-5", decisionModel: "anthropic/claude-sonnet-4-5", maxCostUsd: "1" }] }) }],
		widened: "policy",
	},
	{
		name: "WATCH_SEVERITIES",
		refused: "severity",
		members: () => [...WATCH_SEVERITIES],
		baseline: ["debug", "info", "warning", "error", "critical"],
		what: (m) => `the watch severity ${JSON.stringify(m)}`,
		refusal: `${LOADER_REFUSES} when a watch source's pull or a watch trigger's match names it`,
		probes: [
			{ table: "blockValueTable", field: "watchSources", doc: (m) => ({ triggers: [], watchSources: { app: { verify: "hmac-sha256", secretEnv: "WATCH_SECRET", pull: { kind: "file", path: "/var/log/app.log", fields: { msg: "message" }, severity: m } } } }) },
			{ table: "entryValueTable", field: "on", doc: (m) => ({ watchSources: { app: { verify: "hmac-sha256", secretEnv: "WATCH_SECRET" } }, ...oneTrigger({ type: "watch", id: "errors", source: "app", fingerprint: ["msg"], match: { severity: [m] }, window: "10m", cooldown: "1h", minCount: 1, maxPerDay: 10, maxFingerprints: 10 }, { kind: "local", folder: "/srv/app", flow: "triage", task: "Investigate the error.", maxCostUsd: "1" }) }) },
		],
		widened: "fatal",
	},
	{
		name: "FORK_THINKING_LEVELS",
		refused: null,
		members: () => [...FORK_THINKING_LEVELS],
		baseline: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		what: (m) => `the thinking level ${JSON.stringify(m)}`,
		// Only a queued fork job carries it (the console's); no triggers file does.
		refusal: "an older worker refuses a job carrying it as thinking-level-unsupported",
		probes: [{ table: "jobTable", field: "thinkingLevel", doc: (m) => ({ kind: "github", flow: "fix", thinkingLevel: m }) }],
		widened: "ultra",
	},
]);
const probeNeeds = ({ table, doc }, member, tables) => (table === "jobTable" ? jobDataVersionFor(doc(member), { valueTable: tables.jobTable ?? JOB_DATA_VALUE_VERSIONS }) : triggersFileVersionFor(doc(member), tables));
const domainProblems = (domain, members, tables = {}) =>
	members
		.filter((member) => !domain.baseline.includes(member))
		.filter((member) => domain.probes.some((probe) => probeNeeds(probe, member, tables) < 2))
		.map((member) => `${domain.what(member)} is newer than issue #761's list: ${domain.refusal}, so ${domain.probes.map(({ table, field }) => `${TABLE_NAMES[table]}.${field}`).join(" and ")} ${domain.probes.length > 1 ? "each need" : "needs"} a rule answering 2 or more for it`);
/** The injected tables a rule in each of `probes` makes: the probe's own, else one answering 2 for a value holding `needle`. */
const rulesFor = (probes, needle) => {
	const tables = {};
	for (const { table, field, rule } of probes) tables[table] = Object.freeze({ ...tables[table], [field]: rule ? rule(needle) : (value) => (JSON.stringify(value ?? null).includes(JSON.stringify(needle)) ? 2 : 1) });
	return tables;
};

test("closed domains: every other exported list the triggers loader or the processor refuses a new member of is pinned at issue #761's members, and a new member needs a value rule", () => {
	for (const domain of OTHER_DOMAINS) {
		const members = domain.members();
		for (const member of domain.baseline) assert.ok(members.includes(member), `${member} is still in ${domain.name}`);
		assert.deepEqual(domainProblems(domain, members), [], domain.name);
	}
	for (const frozen of [BACKEND_NAMES, FORGE_MCP_KINDS, ANSWER_CATEGORIES, FORK_THINKING_LEVELS, WAIT_CONDITION_KEYS, WATCH_SEVERITIES]) assert.ok(Object.isFrozen(frozen));
});

test("closed domains: each of those checks refuses a widened list without a rule, and accepts it with one in every table it names", () => {
	for (const domain of OTHER_DOMAINS) {
		const widened = [...domain.members(), domain.widened];
		const needle = domain.widened.split(":").pop();
		assert.equal(domainProblems(domain, widened).length, 1, domain.name);
		assert.deepEqual(domainProblems(domain, widened, rulesFor(domain.probes, needle)), [], domain.name);
		if (domain.probes.length > 1) assert.equal(domainProblems(domain, widened, rulesFor(domain.probes.slice(1), needle)).length, 1, `${domain.name}: every store that carries it needs the rule`);
	}
	assert.deepEqual(domainProblems(OTHER_DOMAINS.find((d) => d.name === "PR_ACTIONS"), [...perForge(PR_ACTIONS), "github:edited"]), [
		'the github pull_request action "edited" is newer than issue #761\'s list: an older loader refuses the whole triggers file as broken, so TRIGGER_VALUE_VERSIONS.on needs a rule answering 2 or more for it',
	]);
	assert.deepEqual(domainProblems(OTHER_DOMAINS.find((d) => d.name === "WATCH_SEVERITIES"), [...WATCH_SEVERITIES, "fatal"]), [
		'the watch severity "fatal" is newer than issue #761\'s list: an older loader refuses the whole triggers file as broken when a watch source\'s pull or a watch trigger\'s match names it, so TRIGGERS_BLOCK_VALUE_VERSIONS.watchSources and TRIGGER_VALUE_VERSIONS.on each need a rule answering 2 or more for it',
	]);
	assert.deepEqual(domainProblems(OTHER_DOMAINS.find((d) => d.name === "BACKEND_NAMES"), [...BACKEND_NAMES, "firecracker"]), [
		'the venue "firecracker" is newer than issue #761\'s list: an older loader refuses the whole triggers file as broken when a run.backend names it, and an older worker refuses its jobs as backend-unblessed, so TRIGGER_RUN_VALUE_VERSIONS.backend and JOB_DATA_VALUE_VERSIONS.backend each need a rule answering 2 or more for it',
	]);
});

test("closed domains: each probe is a document the loader accepts with a member of the list and refuses with the widened one", () => {
	// So the probe holds the value where the real check reads it, and a rule written to answer for the probe answers for
	// the file an operator writes.
	const load = (doc) => parseTriggersDocument(JSON.stringify(doc), "/t");
	for (const domain of OTHER_DOMAINS) {
		for (const probe of domain.probes.filter(({ table }) => table !== "jobTable")) {
			for (const member of domain.baseline) assert.doesNotThrow(() => load(probe.doc(member)), `${domain.name} probe with ${member}`);
			assert.throws(() => load(probe.doc(domain.widened)), (e) => e.newer !== true && e.message.includes(domain.refused), `${domain.name} probe with ${domain.widened}`);
		}
	}
});

test("triggers: the nine narrowing fields are the baseline, and a row added later needs a version in both the trigger and the job data tables", () => {
	// The nine rows `AUTHORED_NARROWING_FIELDS` held when issue #761 gave the triggers file and job data their versions.
	// A later row is a field an older receiver or worker drops, so it must make both stores say an upgrade is needed.
	const BASELINE = ["models", "fallbackModels", "maxCostUsd", "mcp", "awaitInput", "progress", "statusComment", "recover", "steer"];
	const rows = AUTHORED_NARROWING_FIELDS.map((row) => row.key);
	for (const key of BASELINE) assert.ok(rows.includes(key), `${key} is still a narrowing row`);
	for (const key of rows.filter((k) => !BASELINE.includes(k))) {
		assert.ok(Object.hasOwn(TRIGGER_RUN_FIELD_VERSIONS, key) && TRIGGER_RUN_FIELD_VERSIONS[key] >= 2, `run.${key} needs a TRIGGER_RUN_FIELD_VERSIONS row at 2 or above`);
		assert.ok(Object.hasOwn(JOB_DATA_FIELD_VERSIONS, key) && JOB_DATA_FIELD_VERSIONS[key] >= 2, `${key} needs a JOB_DATA_FIELD_VERSIONS row at 2 or above`);
	}
});

test("triggers: the version is judged after the duplicate check and before the array, newer apart from broken", () => {
	assert.throws(() => parseTriggersDocument('{"version": 2, "triggers": "reshaped"}', "/t"), (error) => error.piDispatchConfig === true && error.newer === true && error.message === "triggers file written by a newer pi-dispatch (version 2; this build understands 1): /t");
	assert.throws(() => parseTriggersDocument('{"version": 2, "version": 2, "triggers": []}', "/t"), /duplicate key "version"/);
	assert.throws(() => parseTriggers('{"version": "1", "triggers": []}', "/t"), (error) => error.newer === undefined && error.message === 'triggers file "version" must be an integer of 1 or more: /t');
	assert.deepEqual(parseTriggersDocument('{"version": 1, "triggers": []}', "/t").triggers, []);
	assert.equal(triggersFileNewer('{"version": 2, "triggers": []}'), true);
	assert.equal(triggersFileNewer({ version: 2 }, { supported: 2 }), false);
	assert.equal(triggersFileNewer('{"version": "2"}'), false, "broken, not newer");
	assert.equal(triggersFileNewer("{ not json"), false);
	assert.equal(triggersFileVersionProblem({ triggers: [] }), null);
});

test("triggers: with an injected table the writer stamps the version first, keeps it in place, and removes it at 1", () => {
	const versions = { runTable: Object.freeze({ flow: 2 }), supported: 2 };
	assert.equal(triggersFileVersionFor({ triggers: [label()] }, versions), 2);
	assert.equal(triggersFileVersionFor({ triggers: [{ on: {}, run: { kind: "github" } }] }, versions), 1);
	assert.equal(triggersFileVersionFor({ triggers: [], later: {} }, { blockTable: { later: 3 } }), 3, "top-level blocks count too");
	const path = triggersPathWith({ triggers: [] });
	assert.deepEqual(writeTriggers({ triggersPath: path, mutate: () => [label()], ...versions }), { ok: true });
	const text = readFileSync(path, "utf8");
	assert.ok(text.startsWith('{\n  "version": 2,\n  "triggers": ['), text);
	assert.equal(parseTriggers(text, path, versions).length, 1, "the same build reads it");
	assert.throws(() => parseTriggers(text, path, { runTable: versions.runTable }), (error) => error.newer === true);
	// A stamp already in the file keeps its line.
	writeFileSync(path, `${JSON.stringify({ triggers: [], note: 1, version: 2 }, null, 2)}\n`);
	assert.deepEqual(writeTriggers({ triggersPath: path, mutate: () => [label()], ...versions }), { ok: true });
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))), ["triggers", "note", "version"]);
	// Unset: no entry needs it any more, and the writer deletes the stamp.
	assert.deepEqual(writeTriggers({ triggersPath: path, mutate: () => [], ...versions }), { ok: true });
	assert.equal(readFileSync(path, "utf8"), '{\n  "triggers": [],\n  "note": 1\n}\n');
	// Written by hand without the stamp: refused by the entry and the key.
	assert.throws(() => parseTriggers(JSON.stringify({ triggers: [label()] }), "/t", versions), (error) => error.newer === undefined && error.message === "trigger at index 0: run.flow needs triggers file version 2, and the file declares 1: /t");
});

test("triggers: with injected value tables a wider entry or run value is stamped, an ordinary one is today's bytes, and a lower build calls it newer", () => {
	// An `on.type` and a `run.waitFor` condition this build already reads stand in for ones a later release adds.
	const versions = {
		entryValueTable: Object.freeze({ on: (on) => (on?.type === "issue" ? 2 : 1) }),
		runValueTable: Object.freeze({ waitFor: (conditions) => (Array.isArray(conditions) && conditions.some((c) => Object.hasOwn(c ?? {}, "after")) ? 3 : 1) }),
		supported: 3,
	};
	const waiting = () => ({ on: { type: "label", any: ["dispatch"] }, run: { kind: "github", flow: "fix", waitFor: [{ after: "2026-09-01T09:00:00Z" }] } });
	assert.equal(triggersFileVersionFor({ triggers: [label()] }, versions), 1);
	assert.equal(triggersFileVersionFor({ triggers: [once()] }, versions), 2);
	assert.equal(triggersFileVersionFor({ triggers: [waiting(), once()] }, versions), 3);
	assert.equal(triggersFileVersionFor({ triggers: [once(), waiting()] }, versions), 3, "the highest entry wins, in either order");
	const path = triggersPathWith({ triggers: [] });
	const write = (mutate) => writeTriggers({ triggersPath: path, mutate, now: () => T0, ...versions });
	assert.deepEqual(write(() => [label()]), { ok: true });
	assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ triggers: [label()] }, null, 2)}\n`, "an ordinary value: today's exact bytes");
	assert.deepEqual(write((t) => [...t, once()]), { ok: true });
	const text = readFileSync(path, "utf8");
	assert.ok(text.startsWith('{\n  "version": 2,\n  "triggers": ['), text);
	assert.equal(parseTriggers(text, path, versions).length, 2, "the same build reads it");
	assert.throws(() => parseTriggers(text, path, { ...versions, supported: 1 }), (error) => error.newer === true && error.message === `triggers file written by a newer pi-dispatch (version 2; this build understands 1): ${path}`);
	assert.deepEqual(write((t) => [...t, waiting()]), { ok: true });
	assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 3, "a run value");
	// Unset: the entries that needed it go, and so does the stamp.
	assert.deepEqual(write((t) => t.slice(0, 1)), { ok: true });
	assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ triggers: [label()] }, null, 2)}\n`);
	// Written by hand without the version it needs: refused by the entry and the field, as an ordinary config error.
	assert.throws(() => parseTriggers(JSON.stringify({ triggers: [label(), once()] }), "/t", versions), (error) => error.newer === undefined && error.message === "trigger at index 1: on holds a value that needs triggers file version 2, and the file declares 1: /t");
	assert.throws(() => parseTriggers(JSON.stringify({ version: 2, triggers: [waiting()] }), "/t", versions), (error) => error.newer === undefined && error.message === "trigger at index 0: run.waitFor holds a value that needs triggers file version 3, and the file declares 2: /t");
});

test("triggers: a top-level block that needs a higher version than the file declares is refused by name", () => {
	const versions = { blockTable: Object.freeze({ later: 2 }), supported: 2 };
	assert.throws(() => parseTriggersDocument(JSON.stringify({ triggers: [], later: {} }), "/t", versions), (error) => error.piDispatchConfig === true && error.newer === undefined && error.message === 'triggers file: top-level "later" needs triggers file version 2, and the file declares 1: /t');
	assert.deepEqual(parseTriggersDocument(JSON.stringify({ version: 2, triggers: [], later: {} }), "/t", versions).triggers, []);
});

test("triggers: with an injected block value table a wider block is stamped, an ordinary one is today's bytes, and a lower build calls it newer", () => {
	// A bundle's optional `endpoints` stands in for a field a later release adds to a bundle, which this loader refuses by name.
	const versions = { blockValueTable: Object.freeze({ secretBundles: (bundles) => (Object.values(bundles ?? {}).some((b) => b !== null && typeof b === "object" && Object.hasOwn(b, "endpoints")) ? 2 : 1) }), supported: 2 };
	const plain = { shop: { profile: "shop-env", ref: "shop", project: "shop" } };
	const wider = { shop: { ...plain.shop, endpoints: { STRIPE_KEY: { host: "api.stripe.com", auth: "bearer" } } } };
	assert.equal(triggersFileVersionFor({ triggers: [], secretBundles: plain }, versions), 1);
	assert.equal(triggersFileVersionFor({ triggers: [], secretBundles: wider }, versions), 2);
	assert.equal(triggersFileVersionFor({ version: 9, triggers: [], secretBundles: plain }, { blockValueTable: Object.freeze({ version: () => 9 }) }), 1, "the version itself is never a block a rule judges");
	const path = triggersPathWith({ triggers: [], secretBundles: plain });
	const write = (mutateDocument) => writeTriggers({ triggersPath: path, mutate: (t) => t, mutateDocument, now: () => T0, ...versions });
	assert.deepEqual(write(null), { ok: true });
	assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ triggers: [], secretBundles: plain }, null, 2)}\n`, "an ordinary block: today's exact bytes");
	assert.deepEqual(write((doc) => ({ ...doc, secretBundles: wider })), { ok: true });
	const text = readFileSync(path, "utf8");
	assert.equal(text, `${JSON.stringify({ version: 2, triggers: [], secretBundles: wider }, null, 2)}\n`);
	assert.deepEqual(Object.keys(parseTriggersDocument(text, path, versions).secretBundles), ["shop"], "the same build reads it");
	assert.throws(() => parseTriggersDocument(text, path, { ...versions, supported: 1 }), (error) => error.newer === true && error.message === `triggers file written by a newer pi-dispatch (version 2; this build understands 1): ${path}`);
	// Unset: the block back to its plain form drops the stamp.
	assert.deepEqual(write((doc) => ({ ...doc, secretBundles: plain })), { ok: true });
	assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ triggers: [], secretBundles: plain }, null, 2)}\n`);
	// Written by hand without the version: refused by the block's name, as an ordinary config error.
	assert.throws(() => parseTriggersDocument(JSON.stringify({ triggers: [], secretBundles: wider }), "/t", versions), (error) => error.newer === undefined && error.message === 'triggers file: top-level "secretBundles" holds a value that needs triggers file version 2, and the file declares 1: /t');
});

test("triggers: a newer file is refused BEFORE mutate runs, newer:true, the file and its lock untouched", () => {
	const text = `${JSON.stringify({ version: 2, triggers: [label()], later: { x: 1 } }, null, 2)}\n`;
	const path = triggersPathWith(text);
	let called = 0;
	const res = writeTriggers({ triggersPath: path, mutate: () => { called++; return []; }, mutateDocument: (doc) => { called++; return doc; } });
	assert.equal(res.newer, true);
	assert.equal(res.invalid, `triggers file written by a newer pi-dispatch (version 2; this build understands 1), so nothing was written and nothing in it was lost; change it with that release: ${path}`);
	assert.equal(called, 0, "mutate and mutateDocument never ran");
	assert.equal(readFileSync(path, "utf8"), text);
	assert.equal(existsSync(`${path}.lock`), false, "the lock was released");
	// A BROKEN version is repaired like any broken file, never a reason to refuse: the writer owns the version.
	writeFileSync(path, '{\n  "version": "x",\n  "triggers": []\n}\n');
	assert.deepEqual(writeTriggers({ triggersPath: path, mutate: () => [label()] }), { ok: true });
	assert.equal(JSON.parse(readFileSync(path, "utf8")).version, undefined);
});

test("triggers: a file of today's content is written byte for byte as before", () => {
	const path = triggersPathWith({ triggers: [], secretBundles: {} });
	assert.deepEqual(writeTriggers({ triggersPath: path, mutate: () => [label()] }), { ok: true });
	assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ triggers: [label()], secretBundles: {} }, null, 2)}\n`);
});

test("triggers: the disarm carries the version unchanged", async () => {
	const path = triggersPathWith('{\n  "version": 1,\n  "triggers": [\n    ' + JSON.stringify(once()) + "\n  ]\n}\n");
	assert.deepEqual(await disarmTrigger({ triggersPath: path, index: 0, number: 40, flow: "deploy", jobId: "j1", at: AT }), { ok: true });
	const doc = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(Object.keys(doc), ["version", "triggers"], "the disarm owns one key, not the version");
	assert.deepEqual(doc.triggers[0].on.disarmed, { at: AT, jobId: "j1" });
});

test("triggers: the disarm writes its one key into a newer file and keeps every other byte of meaning, so the one-shot never fires again", async () => {
	// A file a later release wrote: a block, an entry field, an `on` field and a `run` field this build does not know.
	const future = { version: 2, triggers: [label(), { on: { ...once().on, futureOn: { x: [1, 2.5, null] } }, futureEntry: true, run: { ...once().run, futureRun: "narrow" } }], futureBlock: { nested: { deep: "kept" } } };
	const path = triggersPathWith(future);
	assert.deepEqual(await disarmTrigger({ triggersPath: path, index: 1, number: 40, flow: "deploy", jobId: "j1", at: AT }), { ok: true });
	const expected = structuredClone(future);
	expected.triggers[1].on.disarmed = { at: AT, jobId: "j1" };
	assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(expected, null, 2)}\n`, "every key in its place, the version included, and on.disarmed added last");
	assert.deepEqual(parseTriggers(readFileSync(path, "utf8"), path, { supported: 2 })[1], { on: { type: "disarmed" }, run: {} }, "a build that reads the file sees the one-shot spent");
	assert.deepEqual(await disarmTrigger({ triggersPath: path, index: 1, number: 40, flow: "deploy", jobId: "j2", at: AT }), { already: true });
	// The identity checks are the same on a newer file: a different item refuses, the file untouched.
	writeFileSync(path, `${JSON.stringify(future, null, 2)}\n`);
	const stranger = await disarmTrigger({ triggersPath: path, index: 1, number: 41, flow: "deploy", jobId: "j1", at: AT });
	assert.match(stranger.invalid, /names item #40, this job matched #41/);
	assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(future, null, 2)}\n`);
	// A MALFORMED file (not newer) keeps the validator's refusal, untouched.
	for (const broken of [{ version: "two", triggers: [once()] }, { triggers: [once(), { on: { type: "nope" }, run: { kind: "github" } }] }]) {
		const text = `${JSON.stringify(broken, null, 2)}\n`;
		writeFileSync(path, text);
		const res = await disarmTrigger({ triggersPath: path, index: 0, number: 40, flow: "deploy", jobId: "j1", at: AT });
		assert.ok(res.invalid, JSON.stringify(res));
		assert.equal(res.newer, undefined);
		assert.equal(readFileSync(path, "utf8"), text);
	}
});

test("triggers: a duplicate version key is broken to every reader, never newer", async () => {
	const text = `{"triggers": [${JSON.stringify(once())}], "version": 1, "version": 2}`;
	assert.equal(triggersFileNewer(text), false);
	assert.throws(() => parseTriggersDocument(text, "/t"), (error) => error.newer === undefined && /duplicate key "version"/.test(error.message));
	assert.equal(triggersFileNewer(JSON.parse(text)), true, "a parsed document cannot show the duplicate, which is why the readers pass the text");
	const path = triggersPathWith(text);
	// The one-shot and skew checks read it as they read any file that parses: the entry it names, so a run.
	assert.deepEqual(readDisarmState({ triggersPath: path, index: 0, number: 40, flow: "deploy" }), { state: "armed" });
	const job = { kind: "github", flow: "deploy", trigger: { matched: { index: 0, type: "issue", once: true, number: 40 } } };
	assert.deepEqual(await makeCheckOnceSpent({ triggersPath: path })(job, { queueJobId: "q1" }), { ok: true });
	assert.deepEqual(await makeCheckWaitSkew({ triggersPath: path })(job), { ok: true });
	// The disarm and the writer refuse to rewrite it, as they refuse any duplicate.
	assert.match((await disarmTrigger({ triggersPath: path, index: 0, number: 40, flow: "deploy", jobId: "j1", at: AT })).invalid, /duplicate key "version"/);
	assert.equal(readFileSync(path, "utf8"), text);
	// The approval digest check parses through the loader, which refuses the duplicate: unavailable, as for any broken file.
	const gated = { on: { type: "comment", phrase: "/fix" }, run: { kind: "github", flow: "fix", resume: true, gates: ["deploy"] } };
	writeFileSync(path, `{"triggers": [${JSON.stringify(gated)}], "version": 1, "version": 2}`);
	assert.deepEqual(makeCheckApprovalPolicy({ triggersPath: path, parseTriggers })({ kind: "github", gates: ["deploy"], trigger: { matched: { index: 0, type: "comment" } } }), { refused: "approval-policy-unavailable" });
});

test("triggers: the skew check keeps a newer answer for a second read of the same file, and reads an unreadable one as not newer", async () => {
	const newerText = JSON.stringify({ version: 2, triggers: [once()] });
	let reads = 0;
	let stat = { mtimeMs: 1000, size: newerText.length };
	let text = newerText;
	const fs = {
		statSync: () => stat,
		readFileSync: () => {
			reads++;
			if (text === null) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
			return text;
		},
	};
	const check = makeCheckWaitSkew({ triggersPath: "/t.json", fs });
	const job = { kind: "github", flow: "deploy", trigger: { matched: { index: 0, type: "issue", once: true, number: 40 } } };
	assert.deepEqual(await check(job), { newer: true });
	assert.deepEqual(await check(job), { newer: true }, "the same mtime and size: the cached answer");
	assert.equal(reads, 1, "the second answer came from the cache, not a read");
	// Unreadable, then unparseable: not newer, so the check's fail-open "run", like every other doubt it has.
	text = null;
	stat = { mtimeMs: 2000, size: 1 };
	assert.deepEqual(await check(job), { ok: true });
	text = "{ not json";
	stat = { mtimeMs: 3000, size: 10 };
	assert.deepEqual(await check(job), { ok: true });
	text = newerText;
	stat = { mtimeMs: 4000, size: newerText.length };
	assert.deepEqual(await check(job), { newer: true }, "and the file's own answer once it reads again");
});

test("triggers: the worker's live reads report a newer file as newer, never as a run (a one-shot would fire again)", async () => {
	const path = triggersPathWith({ version: 2, triggers: [once()] });
	assert.deepEqual(readDisarmState({ triggersPath: path, index: 0, number: 40, flow: "deploy" }), { state: "newer" });
	const job = { kind: "github", flow: "deploy", trigger: { matched: { index: 0, type: "issue", once: true, number: 40 } } };
	assert.deepEqual(await makeCheckOnceSpent({ triggersPath: path })(job, { queueJobId: "q1" }), { newer: true });
	// The skew check reads before its arrived-everything shortcut: a newer file may author a field no job can show missing.
	const everything = { ...job, waitFor: [{ profile: "jira" }], ...Object.fromEntries(AUTHORED_NARROWING_FIELDS.map((row) => [row.key, true])) };
	assert.deepEqual(await makeCheckWaitSkew({ triggersPath: path })(everything), { newer: true });
	assert.deepEqual(await makeCheckWaitSkew({ triggersPath: path })(job), { newer: true });
	assert.deepEqual(await makeCheckWaitSkew({ triggersPath: path })({ ...job, trigger: {} }), { ok: true }, "a cron or CLI job has no entry in the file to check");
	// And the readable file is what it always was.
	writeFileSync(path, JSON.stringify({ triggers: [once()] }));
	assert.deepEqual(await makeCheckOnceSpent({ triggersPath: path })(job, { queueJobId: "q1" }), { ok: true });
	assert.deepEqual(await makeCheckWaitSkew({ triggersPath: path })(everything), { ok: true });
});

test("approval: the live digest check says newer for a newer file and keeps its other answers", () => {
	const gated = { on: { type: "comment", phrase: "/fix" }, run: { kind: "github", flow: "fix", resume: true, gates: ["deploy"] } };
	const path = triggersPathWith({ version: 2, triggers: [gated] });
	const check = makeCheckApprovalPolicy({ triggersPath: path, parseTriggers });
	const job = { kind: "github", gates: ["deploy"], trigger: { matched: { index: 0, type: "comment" } } };
	assert.deepEqual(check(job), { newer: true });
	writeFileSync(path, "{ not json");
	assert.deepEqual(check(job), { refused: "approval-policy-unavailable" });
	writeFileSync(path, JSON.stringify({ triggers: [gated] }));
	assert.equal(check(job).ok, true);
});

// ── sandbox manifest ───────────────────────────────────────────────────────────────────────────────────────────────

test("sandbox: the shipped table holds the rule against the fields the writers write, and today's manifest carries no version", () => {
	assert.equal(SANDBOX_MANIFEST_VERSION, 1);
	const root = tempDir("store-versions-");
	const jobDir = join(root, "job");
	mkdirSync(jobDir);
	const written = retainJobDir({ jobDir, workspace: join(jobDir, "workspace"), sha: "a".repeat(40), sandbox: { jobId: "gh-1", kind: "github", image: "i", backend: "local", jobUser: null, podmanStore: "/s", size: { memMiB: 1 } } }, { sandboxDir: join(root, "sbx"), retentionHours: 24, now: () => T0 });
	const prepared = /withManifestVersion\(\{(.*)\}\);/.exec(src("sandbox-prepare.mjs"))?.[1] ?? "";
	const known = [...Object.keys(written), ...[...prepared.matchAll(/(\w+):/g)].map((m) => m[1])];
	assert.ok(known.includes("origin") && known.includes("sandboxEgress") && known.includes("prepared"), "the prepared manifest's own fields were found");
	assert.deepEqual(versionTableProblems(SANDBOX_MANIFEST_FIELD_VERSIONS, { known, version: SANDBOX_MANIFEST_VERSION }), []);
	// Today's manifest carries no version: its exact text, keys in their order (only the workspace path is the test's own).
	assert.equal(Object.hasOwn(written, "version"), false);
	assert.equal(
		readFileSync(join(root, "sbx", "gh-1", SANDBOX_MANIFEST), "utf8"),
		`{\n  "jobId": "gh-1",\n  "baseSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",\n  "kind": "github",\n  "image": "i",\n  "backend": "local",\n  "jobUser": null,\n  "podmanStore": "/s",\n  "size": {\n    "memMiB": 1\n  },\n  "workspace": ${JSON.stringify(join(root, "sbx", "gh-1", "workspace"))},\n  "createdAt": "2026-08-28T09:00:00.000Z",\n  "retainUntil": "2026-08-29T09:00:00.000Z",\n  "keepUntil": null\n}\n`,
	);
});

test("sandbox: with an injected table the stamp leads, is kept in place, and goes when nothing needs it", () => {
	const table = Object.freeze({ podmanStore: 2 });
	const plain = { jobId: "gh-1", image: "i" };
	assert.equal(withManifestVersion(plain, { table }), plain, "nothing needed: the very same object");
	assert.equal(sandboxManifestVersionFor({ ...plain, podmanStore: "/s" }, { table }), 2);
	assert.deepEqual(Object.keys(withManifestVersion({ ...plain, podmanStore: "/s" }, { table })), ["version", "jobId", "image", "podmanStore"]);
	assert.deepEqual(withManifestVersion({ jobId: "gh-1", version: 2, image: "i" }, { table }), { jobId: "gh-1", version: 2, image: "i" }, "a declared version is never lowered");
	assert.deepEqual(withManifestVersion({ jobId: "gh-1", version: 1, image: "i" }), plain, "a version of 1 is written as nothing");
	assert.equal(sandboxManifestNewer({ version: 2 }, { supported: 2 }), null);
	assert.deepEqual(sandboxManifestNewer({ version: 2 }), { version: 2 });
	assert.deepEqual(sandboxManifestNewer({ version: "2" }), { version: null });
	assert.equal(sandboxManifestNewer(plain), null);
});

test("sandbox: a newer manifest is refused FIRST, before the venue a newer release may have redefined", () => {
	const manifest = { jobId: "gh-1", version: 2, backend: "elsewhere", image: "i", workspace: "/w" };
	assert.deepEqual(sandboxSyncRefusal({ jobId: "gh-1", manifest, blessed: ["local"], fileExists: () => true }), {
		refused: "manifest-newer",
		message: "the retained workspace for gh-1 was kept by a newer pi-dispatch (manifest version 2; this build understands 1); open it with that release",
	});
	assert.equal(sandboxSyncRefusal({ jobId: "gh-1", manifest, blessed: ["local"], fileExists: () => true, supported: 2 }).refused, "venue-unreachable", "a build that reads it judges the venue as ever");
	const broken = sandboxSyncRefusal({ jobId: "gh-1", manifest: { ...manifest, version: "two" }, blessed: ["local"], fileExists: () => true });
	assert.equal(broken.refused, "manifest-newer");
	assert.equal(broken.message, 'the manifest for gh-1 carries a "version" that is not an integer of 1 or more, which no pi-dispatch writes, so this host cannot tell how to read it');
	assert.equal(sandboxSyncRefusal({ jobId: "gh-1", manifest: { jobId: "gh-1", backend: "local", image: "i", workspace: "/w" }, blessed: ["local"], fileExists: () => true }), null);
});

test("sandbox: a pin refuses a newer manifest without rewriting it, and the console's pin says why", async () => {
	const sandboxDir = join(tempDir("store-versions-"), "sbx");
	mkdirSync(join(sandboxDir, "gh-1"), { recursive: true });
	const file = join(sandboxDir, "gh-1", SANDBOX_MANIFEST);
	const text = `${JSON.stringify({ jobId: "gh-1", version: 2, createdAt: new Date(T0).toISOString(), retainUntil: null, keepUntil: null }, null, 2)}\n`;
	writeFileSync(file, text);
	assert.deepEqual(pinSandbox({ sandboxDir, jobId: "gh-1", pinDays: 7, now: () => T0 }), { pinned: false, reason: "manifest-newer" });
	assert.equal(readFileSync(file, "utf8"), text);
	assert.deepEqual(readdirSync(join(sandboxDir, "gh-1")), [SANDBOX_MANIFEST], "no temp file");
	const handler = createSandboxPinHandler({ config: { workerName: "h1", sandboxDir, sandboxRetentionHours: 24, sandboxPinDays: 7 }, now: () => T0 });
	assert.deepEqual(await handler({ host: "h1", runId: "gh-1" }), { refused: "manifest-newer", message: "the kept workspace was kept by a newer pi-dispatch, so this host does not rewrite it; pin it with that release" });
	// A build that reads it pins it and keeps its stamp in place.
	assert.equal(pinSandbox({ sandboxDir, jobId: "gh-1", pinDays: 7, now: () => T0, supported: 2 }).pinned, true);
	const pinned = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(Object.keys(pinned), ["jobId", "version", "createdAt", "retainUntil", "keepUntil"]);
	assert.equal(pinned.keepUntil, new Date(T0 + 7 * 24 * HOUR).toISOString());
});

test("sandbox: the sweep is unchanged, so a newer manifest past its deadline is still swept on time", async () => {
	const sandboxDir = join(tempDir("store-versions-"), "sbx");
	for (const [id, ageHours] of [["old", 30], ["fresh", 2]]) {
		mkdirSync(join(sandboxDir, id), { recursive: true });
		writeFileSync(join(sandboxDir, id, SANDBOX_MANIFEST), JSON.stringify({ jobId: id, version: 9, laterField: { x: 1 }, createdAt: new Date(T0 - ageHours * HOUR).toISOString() }));
	}
	await makeSandboxReaper({ sandboxDir, retentionHours: 24, now: () => T0 })();
	assert.deepEqual(readdirSync(sandboxDir), ["fresh"], "the deadline fields keep their meaning in every version");
});
