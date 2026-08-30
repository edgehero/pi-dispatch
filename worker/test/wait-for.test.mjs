import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT_HOLD, decideRetry, decideWait } from "../src/exit-code.mjs";
import { parseTriggers } from "../src/triggers.mjs";
import { WAIT_CONDITION_MAX, WAIT_INTERVAL_FLOOR_MS, WAIT_INTERVAL_MAX_MS, afterInstantMs, afterMs, parseAfterInstant, parseWaitProfiles, waitArmed, waitBackoffMs, waitLabel, waitProfileNames } from "../src/wait-for.mjs";

// Issue #230. The grammar half is exercised through the REAL parseTriggers rather than the validator
// directly: the validator is not exported, and what an operator actually meets is the loader.
const PATH = "/triggers.json";
const parse = (triggers) => parseTriggers(JSON.stringify({ triggers }), PATH);
const isConfigError = (e) => e.piDispatchConfig === true;
const refuses = (entry, needle) =>
	assert.throws(
		() => parse([entry]),
		(e) => isConfigError(e) && e.message.includes(needle) && e.message.includes(PATH),
		`expected a config error naming ${JSON.stringify(needle)}`,
	);

const label = (waitFor, extra = {}) => ({ on: { type: "label", any: ["pi:deploy"], ...extra.on }, run: { kind: "github", flow: "deploy", ...(waitFor !== undefined && { waitFor }), ...extra.run } });

// --- the after instant ------------------------------------------------------------------------------

test("an after instant must carry its own zone -- a floating local time is refused", () => {
	assert.equal(afterInstantMs("2026-09-01T09:00:00Z"), Date.parse("2026-09-01T09:00:00Z"));
	assert.equal(afterInstantMs("2026-09-01t09:00z"), Date.parse("2026-09-01T09:00:00Z"), "lowercase t/z is legal ISO");
	assert.equal(afterInstantMs("2026-09-01T11:00:00+02:00"), Date.parse("2026-09-01T09:00:00Z"));
	assert.equal(afterInstantMs("2026-09-01T04:00:00-05:00"), Date.parse("2026-09-01T09:00:00Z"));
	assert.equal(afterInstantMs("2026-09-01T09:00:00.500Z"), Date.parse("2026-09-01T09:00:00.500Z"), "fractional seconds survive");
	// The whole reason the regex exists rather than a bare Date.parse: this one PARSES, against whatever
	// zone the worker happens to sit in, so the same reviewed file would hold for a different instant on a
	// different host.
	assert.equal(afterInstantMs("2026-09-01T09:00:00"), null);
	assert.equal(Number.isNaN(Date.parse("2026-09-01T09:00:00")), false, "and it is a bare Date.parse that would have accepted it");
});

test("an impossible calendar date is refused, including the day-overflow Date.parse rolls forward", () => {
	assert.equal(afterInstantMs("2026-13-01T09:00:00Z"), null, "month 13 -- Date.parse rejects this one itself");
	// This is the one worth a test of its own: Date.parse ACCEPTS Feb 31st and silently answers March 3rd,
	// so without the calendar check an operator's typo becomes a hold ending on a day nobody wrote.
	assert.equal(Number.isNaN(Date.parse("2026-02-31T00:00:00Z")), false, "Date.parse alone accepts it");
	assert.equal(afterInstantMs("2026-02-31T00:00:00Z"), null);
	assert.equal(afterInstantMs("2026-04-31T00:00:00Z"), null, "and a 31st of a 30-day month");
	assert.equal(afterInstantMs("2028-02-29T00:00:00Z"), Date.parse("2028-02-29T00:00:00Z"), "a real leap day still passes");
	assert.equal(afterInstantMs("2026-02-29T00:00:00Z"), null, "a leap day in a non-leap year does not");
});

test("an hour of 24 is refused, because Date.parse reads it as the NEXT day", () => {
	// The same class as the Feb-31 roll, in the half the calendar probe does not cover: the probe validates
	// text.slice(0,10), so without a range-bounded pattern the time half is left to Date.parse.
	assert.equal(new Date(Date.parse("2026-09-01T24:00:00Z")).toISOString(), "2026-09-02T00:00:00.000Z", "Date.parse alone rolls it");
	assert.equal(afterInstantMs("2026-09-01T24:00:00Z"), null);
	assert.equal(afterInstantMs("2026-09-01T23:59:59Z"), Date.parse("2026-09-01T23:59:59Z"), "and the last legal instant of a day still passes");
	assert.equal(afterInstantMs("2026-09-01T09:60:00Z"), null, "minute 60");
	assert.equal(afterInstantMs("2026-09-01T09:00:60Z"), null, "second 60 -- there is no leap second to honour here");
});

test("a year below 100 is not refused by accident (Date.UTC maps two-digit years onto 19xx)", () => {
	assert.equal(afterInstantMs("0099-01-01T00:00:00Z"), Date.parse("0099-01-01T00:00:00Z"));
	assert.equal(afterInstantMs("0099-02-30T00:00:00Z"), null, "and the calendar check still bites there");
});

test("a refusal names the REAL reason, not the zone for everything", () => {
	// Three different failures used to collapse into one message blaming the zone -- including for values
	// that carry a perfectly good zone, which is the least actionable message available.
	assert.deepEqual(parseAfterInstant("2026-09-01T09:00:00"), { error: "shape" });
	assert.deepEqual(parseAfterInstant("2026-02-31T00:00:00Z"), { error: "calendar" });
	assert.deepEqual(parseAfterInstant("2026-13-01T00:00:00Z"), { error: "calendar" });
	assert.deepEqual(parseAfterInstant("2026-09-01T09:00:00Z"), { ms: Date.parse("2026-09-01T09:00:00Z") });
});

test("waitBackoffMs grows with elapsed, settles at the cap, and never clamps an operator DOWN", () => {
	const base = 60_000;
	assert.equal(waitBackoffMs(base, 0), base);
	assert.equal(waitBackoffMs(base, 9 * base), base, "still the base inside the first band");
	assert.equal(waitBackoffMs(base, 10 * base), 2 * base);
	assert.equal(waitBackoffMs(base, 30 * base), 8 * base);
	assert.equal(waitBackoffMs(base, 40 * base), WAIT_INTERVAL_MAX_MS, "16 base periods is already past the 15-minute ceiling");
	assert.equal(waitBackoffMs(base, 10_000 * base), WAIT_INTERVAL_MAX_MS, "and settles at the ceiling");
	// The one that costs money if it is ever "simplified" into a two-sided clamp: an operator who asked for
	// an hourly cadence to save money must not be quietly given a fifteen-minute one.
	const hourly = 3_600_000;
	assert.equal(waitBackoffMs(hourly, 0), hourly);
	assert.equal(waitBackoffMs(hourly, 10_000 * hourly), hourly, "the cap is max(ceiling, base), never a bare min");
	assert.equal(waitBackoffMs(0, 0), WAIT_INTERVAL_FLOOR_MS, "a nonsense base falls back to the floor rather than to NaN");
	assert.equal(waitBackoffMs(base, -1), base);
});

test("afterInstantMs is total over junk", () => {
	for (const junk of [undefined, null, 42, {}, [], "", "tomorrow", "2026-09-01", "2026-09-01T09Z"]) {
		assert.equal(afterInstantMs(junk), null, `expected null for ${JSON.stringify(junk)}`);
	}
});

// --- PI_WAIT_PROFILES -------------------------------------------------------------------------------

test("parseWaitProfiles reads name:/abs/path pairs and is empty when unset", () => {
	// Spread before comparing: the table is intentionally prototype-free (see the dedicated test below),
	// and deepEqual under node:assert/strict compares prototypes too.
	const t = (raw) => ({ ...parseWaitProfiles(raw) });
	assert.deepEqual(t(undefined), {});
	assert.deepEqual(t(null), {});
	assert.deepEqual(t("   "), {});
	assert.deepEqual(t("jira:/opt/pi/wait-jira.sh"), { jira: "/opt/pi/wait-jira.sh" });
	assert.deepEqual(t(" jira:/opt/a.sh , deploy:/opt/b.sh ,"), { jira: "/opt/a.sh", deploy: "/opt/b.sh" }, "whitespace and a trailing comma are typos, not declarations");
});

test("the profile table is prototype-free, so an inherited name cannot pass for a declared one", () => {
	// A profile named `toString` passes ID_CHARSET. On a plain `{}` table `profiles["toString"]` answers
	// with an inherited FUNCTION, so the gate's "is this declared?" check says yes for a name nobody wrote
	// -- with the variable unset entirely, which the contract calls fail-closed.
	const empty = parseWaitProfiles(undefined);
	const one = parseWaitProfiles("jira:/opt/pi/wait.sh");
	for (const table of [empty, one]) {
		for (const inherited of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
			assert.equal(table[inherited], undefined, `${inherited} must not resolve to an inherited member`);
		}
		assert.equal(Object.getPrototypeOf(table), null);
	}
	// And the duplicate check must not fire on a name that was never written.
	assert.deepEqual({ ...parseWaitProfiles("toString:/opt/a.sh") }, { toString: "/opt/a.sh" });
});

test("a near-miss spelling of run.waitFor is REFUSED -- the one field whose absence is destructive", () => {
	// `waitfor` loads clean, normalizes clean, enqueues clean, and produces a paid run byte-identical to
	// one that correctly waited. That is the gate silently doing nothing, which is the argument this
	// grammar already makes about an unknown key inside a condition, one level up.
	for (const key of ["waitfor", "WaitFor", "WAITFOR", "wait_for", "wait-for"]) {
		refuses({ on: { type: "label", any: ["pi:deploy"] }, run: { kind: "github", flow: "deploy", [key]: [{ profile: "jira" }] } }, "did you mean run.waitFor?");
	}
	// Including when it is put on the wrong half of the entry.
	refuses({ on: { type: "label", any: ["pi:deploy"], waitFor: [{ profile: "jira" }] }, run: { kind: "github", flow: "deploy" } }, "did you mean run.waitFor?");
	// An unrelated unknown key still drops silently: this is a near-miss guard, not an unknown-key sweep,
	// because tolerating unknown run keys is this file's documented forward-compatibility posture.
	assert.doesNotThrow(() => parse([{ on: { type: "label", any: ["pi:deploy"] }, run: { kind: "github", flow: "deploy", someFutureKey: 1 } }]));
});

test("a windows path parses because each entry splits on its FIRST colon", () => {
	assert.deepEqual({ ...parseWaitProfiles("prod:C:\\pi\\wait.cmd") }, { prod: "C:\\pi\\wait.cmd" });
	assert.deepEqual({ ...parseWaitProfiles("unc:\\\\host\\share\\wait.cmd") }, { unc: "\\\\host\\share\\wait.cmd" });
});

test("every malformed PI_WAIT_PROFILES entry fails LOUD, naming the variable", () => {
	const refusesEnv = (raw, needle) => assert.throws(() => parseWaitProfiles(raw), (e) => isConfigError(e) && e.message.includes("PI_WAIT_PROFILES") && e.message.includes(needle));
	refusesEnv("nocolon", "name:/absolute/path");
	refusesEnv(":/opt/a.sh", "name:/absolute/path"); // an empty name is cut <= 0, not a charset failure
	refusesEnv("has space:/opt/a.sh", "letters, digits, dot, dash and underscore");
	refusesEnv("jira:/opt/a.sh,jira:/opt/b.sh", "twice");
	refusesEnv("jira:relative/a.sh", "ABSOLUTE");
	refusesEnv("jira:", "ABSOLUTE");
});

// --- the runtime accessors --------------------------------------------------------------------------

test("the accessors are total, and an unflagged job answers no to all of them", () => {
	for (const job of [undefined, null, {}, { waitFor: [] }, { waitFor: "nope" }]) {
		assert.equal(waitArmed(job), false, `waitArmed ${JSON.stringify(job)}`);
		assert.equal(afterMs(job), null);
		assert.deepEqual(waitProfileNames(job), []);
		assert.equal(waitLabel(job), null);
	}
});

test("the accessors read a held job's conditions, keeping profile order", () => {
	const job = { waitFor: [{ after: "2026-09-01T09:00:00Z" }, { profile: "jira" }, { profile: "deploy" }] };
	assert.equal(waitArmed(job), true);
	assert.equal(afterMs(job), Date.parse("2026-09-01T09:00:00Z"));
	assert.deepEqual(waitProfileNames(job), ["jira", "deploy"], "the operator's writing order, which is what a held row reads back");
	assert.equal(waitLabel(job), "after 2026-09-01T09:00:00Z + jira + deploy");
});

test("the interval floor stays above the scope re-check, which is what tells the two deferrals apart", async () => {
	// No fallback on the import: a rename of SCOPE_BUSY_RECHECK_MS must break this test loudly rather than
	// let it compare against a hard-coded 5000 that no longer describes the gate.
	const idx = await import("../src/index.mjs");
	assert.equal(typeof idx.SCOPE_BUSY_RECHECK_MS, "number", "index.mjs must still export the scope re-check this floor is defined against");
	assert.ok(WAIT_INTERVAL_FLOOR_MS > idx.SCOPE_BUSY_RECHECK_MS, `wait floor ${WAIT_INTERVAL_FLOOR_MS} must exceed the scope re-check ${idx.SCOPE_BUSY_RECHECK_MS}`);
});

test("the wait-for subpath is exported, so a later phase importing it cannot fail at publish time", async () => {
	// Nothing imports `@edgehero/pi-dispatch/wait-for` until the admin does, so a typo in the subpath would
	// be invisible for three phases. The map is checked against the file the module actually lives in.
	const { readFileSync } = await import("node:fs");
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.exports["./wait-for"], "./src/wait-for.mjs");
	const resolved = new URL(`../${pkg.exports["./wait-for"].slice(2)}`, import.meta.url);
	assert.doesNotThrow(() => readFileSync(resolved), "the exported subpath must point at a file that exists");
	assert.ok(pkg.files.includes("src"), "and src must be in the published tarball");
});

// --- the grammar, through the loader ----------------------------------------------------------------

test("a webhook trigger carrying waitFor loads, and normalizes to a freshly built array", () => {
	const [t] = parse([label([{ after: "2026-09-01T09:00:00Z" }, { profile: "jira" }])]);
	assert.deepEqual(t.run.waitFor, [{ after: "2026-09-01T09:00:00Z" }, { profile: "jira" }]);
});

test("an unflagged trigger's normalized run is byte-identical -- the key is ABSENT, not undefined", () => {
	const [plain] = parse([label(undefined)]);
	assert.equal("waitFor" in plain.run, false);
	assert.deepEqual(Object.keys(plain.run), ["kind", "flow", "packages", "image", "resume", "replicas"]);
});

test("waitFor loads on every forge and every webhook on-type it is legal for", () => {
	const entries = [
		{ on: { type: "label", any: ["pi:deploy"] }, run: { kind: "github", flow: "deploy", waitFor: [{ profile: "jira" }] } },
		{ on: { type: "comment", phrase: "@pi" }, run: { kind: "gitlab", flow: "fix", waitFor: [{ profile: "jira" }] } },
		{ on: { type: "pull_request", action: ["label_updated"], any: ["pi:review"] }, run: { kind: "forgejo", flow: "review", waitFor: [{ after: "2026-09-01T09:00:00Z" }] } },
		{ on: { type: "label", any: ["pi:deploy"] }, run: { kind: "azure", flow: "deploy", repository: "repo", waitFor: [{ profile: "jira" }] } },
		{ on: { type: "issue", action: ["closed"] }, run: { kind: "github", flow: "followup", waitFor: [{ profile: "jira" }] } },
	];
	const parsed = parse(entries);
	assert.equal(parsed.length, 5);
	for (const t of parsed) assert.ok(Array.isArray(t.run.waitFor) && t.run.waitFor.length > 0, "every forge carries the field");
});

test("a condition must be an object naming EXACTLY ONE condition", () => {
	refuses(label("nope"), "must be a non-empty array");
	refuses(label([]), "must be a non-empty array");
	refuses(label([null]), "must be an object naming exactly one condition");
	refuses(label([["after"]]), "must be an object naming exactly one condition");
	refuses(label(["jira"]), "must be an object naming exactly one condition");
	refuses(label([{}]), "an empty object");
	refuses(label([{ after: "2026-09-01T09:00:00Z", profile: "jira" }]), "must name exactly one condition");
});

test("an unknown condition is REFUSED, not dropped -- a silent term is a gate that does nothing", () => {
	refuses(label([{ until: "2026-09-01T09:00:00Z" }]), "unsupported condition");
	refuses(label([{ until: "x" }]), "refused rather than dropped");
	// The inverse of this file's own posture for unknown keys, and the reason is in the message: everywhere
	// else a dropped key is a field that does nothing, here it is a TERM OF A GATE that does nothing.
	const [t] = parse([{ on: { type: "label", any: ["pi:deploy"] }, run: { kind: "github", flow: "deploy", nonsense: 1 } }]);
	assert.equal("nonsense" in t.run, false, "an unknown key at run level still drops silently");
});

test("exclusive is refused by name, pointing at the mutex that replaced it", () => {
	refuses(label([{ exclusive: "folder" }]), "exclusive is no longer a condition you write");
	refuses(label([{ exclusive: "folder" }]), "one local job per folder");
	refuses(label([{ exclusive: "folder" }]), "scoped-limits.json");
});

test("after is refused without a zone, twice over, or malformed", () => {
	refuses(label([{ after: "2026-09-01T09:00:00" }]), "carrying its own zone");
	refuses(label([{ after: "tomorrow" }]), "carrying its own zone");
	refuses(label([{ after: 42 }]), "carrying its own zone");
	refuses(label([{ after: "2026-09-01T09:00:00Z" }, { after: "2026-09-02T09:00:00Z" }]), "a second \"after\"");
});

test("a profile must be a declarable name, and naming one twice is refused", () => {
	refuses(label([{ profile: "" }]), "must be a non-empty string");
	refuses(label([{ profile: 7 }]), "must be a non-empty string");
	refuses(label([{ profile: "has space" }]), "letters, digits, dot, dash and underscore");
	refuses(label([{ profile: "a:b" }]), "cannot be declared");
	refuses(label([{ profile: "jira" }, { profile: "jira" }]), "twice");
});

test("the condition count is bounded, because each profile condition is a subprocess", () => {
	const many = Array.from({ length: WAIT_CONDITION_MAX + 1 }, (_, i) => ({ profile: `p${i}` }));
	refuses(label(many), `over the ${WAIT_CONDITION_MAX} cap`);
	assert.doesNotThrow(() => parse([label(many.slice(0, WAIT_CONDITION_MAX))]), "the cap itself loads");
});

// --- the three combination refusals -----------------------------------------------------------------

test("waitFor is refused on a cron trigger, naming BOTH mechanisms rather than the shape", () => {
	const cron = { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/proj", flow: "tidy", task: "tidy", waitFor: [{ profile: "jira" }] } };
	refuses(cron, "not yet covered on a cron trigger");
	refuses(cron, "outlives the teardown");
	refuses(cron, "scheduler id collision");
	refuses(cron, "a gap to close, not a limit");
	// The ordering pin: a cron entry whose waitFor is ALSO malformed must still hear the cron refusal, or
	// the operator fixes the array and meets the real answer on the next run (validateReplicas' lesson).
	refuses({ ...cron, run: { ...cron.run, waitFor: "garbage" } }, "not yet covered on a cron trigger");
});

test("waitFor is refused beside on.once -- a timed-out wait would spend a one-shot that never ran", () => {
	const once = { on: { type: "issue", action: ["closed"], number: 40, once: true }, run: { kind: "github", flow: "deploy", waitFor: [{ profile: "jira" }] } };
	refuses(once, "run.waitFor and on.once cannot be combined");
	refuses(once, "disarms on every run record");
	// on.once: false is the documented default and still loads beside a wait.
	assert.doesNotThrow(() => parse([{ on: { type: "issue", action: ["closed"], number: 40, once: false }, run: { kind: "github", flow: "deploy", waitFor: [{ profile: "jira" }] } }]));
});

test("waitFor is refused beside run.replicas -- N replicas would poll one condition N times", () => {
	const rep = { on: { type: "label", any: ["pi:deploy"] }, run: { kind: "github", flow: "deploy", replicas: 2, waitFor: [{ profile: "jira" }] } };
	refuses(rep, "run.waitFor and run.replicas cannot be combined");
	refuses(rep, "multiplying the checks by 2");
});

// --- the exit-code protocol -------------------------------------------------------------------------

test("decideWait speaks four codes, and only 2 is terminal", () => {
	assert.deepEqual(decideWait(0), { verdict: "go", fault: false });
	assert.deepEqual(decideWait(EXIT_HOLD), { verdict: "hold", fault: false });
	assert.equal(EXIT_HOLD, 3);
	assert.deepEqual(decideWait(2), { verdict: "refuse", fault: false });
	assert.deepEqual(decideWait(1), { verdict: "hold", fault: true }, "cannot-tell HOLDS: an unreachable Jira has not said no");
	assert.deepEqual(decideWait(6), { verdict: "hold", fault: true }, "an unrecognised code folds into cannot-tell, which is this protocol's own rule");
	assert.deepEqual(decideWait(null), { verdict: "hold", fault: true }, "a killed child reports no code at all");
});

test("the wait participant's 3 does not leak into the container's vocabulary", () => {
	// decideRetry is the container/resolver classifier and must be untouched by the new code: a CONTAINER
	// exiting 3 is still something we cannot reason about, so it still retries.
	assert.deepEqual(decideRetry(3), { retry: true, outcome: "unknown-exit-3" });
	assert.deepEqual(decideRetry(0), { retry: false, outcome: "completed" });
	assert.deepEqual(decideRetry(1), { retry: true, outcome: "infra" });
	assert.deepEqual(decideRetry(2), { retry: false, outcome: "policy" });
});
