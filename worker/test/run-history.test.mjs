import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { authenticExitLines, buildRecord, COST_CAP_WHYS, makeFindPreviousRun, makeLogReaper, makeLogSink, makeReadRecord, makeRecordWriter, makeSettledRecord, RECORD_CLOCK_SKEW_MS, recordVerdict, UNREADABLE_RECORD, parseExitCode, parseExitContext, parseExitReason, parseExitSession, parseExitTokens, parseExitTurns, parseExitUsage, parseExitWhy, parseExitResources, parseExitOomKilled, EXIT_OOM_KILLED, RESOURCE_KEYS, PLAN_RECORD_REASONS, recordSettlesAttempt, RUNNER_POLICY_REASONS, sanitizeJobId, TOKEN_KEYS } from "../src/run-history.mjs";
import { MODEL_REF_PATTERN } from "../src/model-ref.mjs";
import { FORGE_KINDS } from "../src/forges.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { RESOURCE_KEYS as RUNNER_RESOURCE_KEYS } from "../../image/runner/src/cgroup-usage.mjs";

/**
 * A fake writable that records chunks and lets a test drive `finish`/`error` timing.
 * `emitOn` controls what `end()` emits: "finish" (normal flush), "error" (broken flush), or "none"
 * (never settles -- exercises the bounded close timeout). `writeThrows` makes `write` throw
 * synchronously; `emitError` makes `write` also schedule an async 'error' event.
 */
function makeFakeStream({ emitOn = "finish", writeThrows = false, emitError = false } = {}) {
	const listeners = new Map();
	const chunks = [];
	const stream = {
		chunks,
		writeCalls: 0,
		on(event, cb) {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event).push(cb);
			return stream;
		},
		once(event, cb) {
			return stream.on(event, cb);
		},
		emit(event, ...args) {
			for (const cb of [...(listeners.get(event) ?? [])]) cb(...args);
		},
		write(chunk) {
			stream.writeCalls++;
			chunks.push(chunk);
			if (emitError) queueMicrotask(() => stream.emit("error", new Error("write error")));
			if (writeThrows) throw new Error("write threw");
		},
		end() {
			if (emitOn === "finish") queueMicrotask(() => stream.emit("finish"));
			else if (emitOn === "error") queueMicrotask(() => stream.emit("error", new Error("end error")));
			// emitOn === "none": never settles -- close must fall back to its timeout.
		},
	};
	return stream;
}

/**
 * A fake fs exposing only what the sink, the record writer, and the log reaper touch, with call
 * counters for the assertions. `writes` records every `writeFileSync({path, data})`; `writeThrows`
 * makes it throw so the writer's never-throw posture can be exercised.
 *
 * Reaper surface: `readdirNames` is the directory listing `readdirSync` returns; `readdirThrows` makes
 * it throw (first-boot ENOENT). `stats` maps a filename to `{ isFile, mtimeMs }` -- `statSync` looks the
 * entry up by `basename(path)` and returns a real `{ isFile: () => bool, mtimeMs }`. `statThrowsFor` and
 * `unlinkThrowsFor` are name lists that make `statSync`/`unlinkSync` throw for those specific entries.
 * `calls.readdir` counts listings and `unlinked` records every unlinked path.
 */
function makeFakeFs({
	stream,
	mkdirThrows = false,
	writeThrows = false,
	readdirNames = [],
	readdirThrows = false,
	stats = {},
	statThrowsFor = [],
	unlinkThrowsFor = [],
} = {}) {
	const calls = { mkdir: 0, createWriteStream: 0, paths: [], readdir: 0, stat: [] };
	const writes = [];
	const unlinked = [];
	return {
		calls,
		writes,
		unlinked,
		mkdirSync() {
			calls.mkdir++;
			if (mkdirThrows) throw new Error("mkdir failed");
		},
		createWriteStream(path) {
			calls.createWriteStream++;
			calls.paths.push(path);
			return stream;
		},
		writeFileSync(path, data) {
			if (writeThrows) throw new Error("writeFileSync failed");
			writes.push({ path, data });
		},
		readdirSync() {
			calls.readdir++;
			if (readdirThrows) throw new Error("ENOENT: no such file or directory");
			return readdirNames;
		},
		statSync(path) {
			calls.stat.push(path);
			const name = basename(path);
			if (statThrowsFor.includes(name)) throw new Error(`stat failed: ${name}`);
			const entry = stats[name] ?? { isFile: true, mtimeMs: 0 };
			return { isFile: () => entry.isFile, mtimeMs: entry.mtimeMs };
		},
		unlinkSync(path) {
			const name = basename(path);
			if (unlinkThrowsFor.includes(name)) throw new Error(`unlink failed: ${name}`);
			unlinked.push(path);
		},
	};
}

test("sanitizeJobId strips colons from BullMQ scheduled ids", () => {
	assert.equal(sanitizeJobId("repeat:a:1"), "repeat_a_1");
});

test("sanitizeJobId leaves an already-legal id unchanged", () => {
	assert.equal(sanitizeJobId("gh-abc-123"), "gh-abc-123");
});

test("sanitizeJobId maps empty/nullish to a fixed sentinel", () => {
	assert.equal(sanitizeJobId(""), "unknown-job");
	assert.equal(sanitizeJobId(undefined), "unknown-job");
	assert.equal(sanitizeJobId(null), "unknown-job");
});

test("sanitizeJobId collapses path separators to underscore", () => {
	assert.equal(sanitizeJobId("a/b"), "a_b");
	assert.equal(sanitizeJobId("a\\b"), "a_b");
});

test("parseExitTurns reads turns off the success exit line", () => {
	assert.equal(parseExitTurns('{"event":"exit","code":0,"turns":7}\n'), 7);
});

test("parseExitTurns ignores pi_auto_retry noise before the exit line", () => {
	const text = [
		'{"event":"pi_auto_retry","attempt":1,"maxAttempts":3}',
		'{"event":"pi_auto_retry","attempt":2,"maxAttempts":3}',
		'{"event":"exit","code":0,"turns":12}',
	].join("\n");
	assert.equal(parseExitTurns(text), 12);
});

test("parseExitTurns returns null for the catch-path exit line that omits turns", () => {
	assert.equal(parseExitTurns('{"event":"exit","code":2,"reason":"config"}'), null);
});

test("parseExitTurns skips non-JSON noise and finds the exit line", () => {
	assert.equal(parseExitTurns('garbage not json\n{"event":"exit","turns":3}'), 3);
});

test("parseExitTurns returns null on a partial/truncated final line", () => {
	assert.equal(parseExitTurns('{"event":"exi'), null);
});

test("parseExitTurns returns the LAST exit line's turns when two are present", () => {
	assert.equal(parseExitTurns('{"event":"exit","turns":2}\n{"event":"exit","turns":9}'), 9);
});

test("parseExitTurns returns null for empty input", () => {
	assert.equal(parseExitTurns(""), null);
});

/** The hostile corpus every parseExit* helper must survive: noise, truncation, non-strings, scalar
 *  JSON. Shared so a new parser inherits the whole sweep rather than a hand-picked subset; the
 *  usage-bearing lines (one valid, one mangled) joined it when the ledger parser landed. */
const HOSTILE_CORPUS = [
	'{"event":"exit","code":0,"turns":7}\n',
	'{"event":"exit","code":2,"reason":"config"}',
	'garbage not json\n{"event":"exit","turns":3}',
	'{"event":"exi',
	'{"event":"exit","turns":2}\n{"event":"exit","turns":9}',
	"",
	undefined,
	null,
	42,
	"null",
	"123",
	'{"event":"exit","usage":{"v":1,"piAi":"0.80.7","truncated":0,"models":[{"provider":"anthropic","model":"m","total":9}]}}',
	'{"event":"exit","usage":{"v":"1","models":"nope"}}',
	'stray{"event":"exit","turns":5}',
	'{"event":"exit","turns":99{"event":"exit","turns":4}',
	'{"event":"exit","turns":99}{"event":"exit","turns":6}',
	'x{"event":"',
	'stray{"event":"exit","turns":7',
];

test("parseExitTurns never throws across the full corpus", () => {
	for (const input of HOSTILE_CORPUS) {
		assert.doesNotThrow(() => parseExitTurns(input), `input=${JSON.stringify(input)}`);
	}
});

// ---- glued-line repair (issue #224): one un-newlined write before the runner's exit line used to
// lose all five exit-line values at once, or hand the scan to a forged line placed earlier ----

const GLUED_FULL_EXIT =
	'un-newlined stray{"event":"exit","code":0,"turns":5,' +
	'"tokens":{"input":10,"output":2,"total":12,"cost":0.5},' +
	'"usage":{"v":1,"piAi":"0.80.7","truncated":0,"models":[{"provider":"anthropic","model":"m","calls":1,"total":12,"cost":0.5}]},' +
	'"session":{"resumed":true,"reason":"resumed"},"context":{"tokens":900,"window":2000}}';

test("a glued exit line is repaired: all five values survive one un-newlined write", () => {
	assert.equal(parseExitTurns(GLUED_FULL_EXIT), 5);
	assert.equal(parseExitTokens(GLUED_FULL_EXIT)?.total, 12);
	assert.deepEqual(parseExitSession(GLUED_FULL_EXIT), { resumed: true, reason: "resumed" });
	assert.deepEqual(parseExitContext(GLUED_FULL_EXIT), { tokens: 900, window: 2000 });
	assert.equal(parseExitUsage(GLUED_FULL_EXIT)?.models?.[0]?.model, "m");
});

test("a glued genuine line beats a forged exit line placed earlier -- the no-race forgery is closed", () => {
	const text = '{"event":"exit","turns":99,"tokens":{"total":9999}}\nstray{"event":"exit","turns":3,"tokens":{"total":12}}';
	assert.equal(parseExitTurns(text), 3);
	assert.deepEqual(parseExitTokens(text), { total: 12 });
});

test("a stray prefix that itself opens a runner-shaped line cannot win the repair", () => {
	// The prefix is an UNTERMINATED forged line: a parse from its anchor cannot reach the line's
	// end (nothing closes a JSON container after bytes the runner appended later), so the scan
	// advances to the complete object -- the suffix the runner wrote last.
	assert.equal(parseExitTurns('{"event":"exit","turns":99{"event":"exit","turns":4}'), 4);
});

test("a stray COMPLETE forged object glued before the genuine line loses to the suffix", () => {
	assert.equal(parseExitTurns('{"event":"exit","turns":99}{"event":"exit","turns":6}'), 6);
});

test("the repair ADVANCES past an unparseable earlier anchor -- it is a loop, not one attempt", () => {
	// stray prefix + two complete objects on one line. The first surviving anchor's slice spans BOTH
	// objects and fails to parse, so the loop MUST advance to the second anchor. A degraded repair that
	// tried the first anchor once and gave up on failure returns null here; the shipped loop returns 6.
	// (The no-stray sibling above does NOT pin this: there the index-1 start skips straight to the
	// second, parseable anchor on the first attempt.)
	assert.equal(parseExitTurns('stray{"event":"exit","turns":99}{"event":"exit","turns":6}'), 6);
});

test("a trailing anchorless fragment is skipped, and the real line's values survive intact", () => {
	// A mid-write death or noise leaves a fragment with no {"event":" anchor as the LAST line. It fails
	// to parse, is not repairable, and the scan walks back to the intact exit line. The intact line
	// carries its OWN tokens so the assertion is not vacuous: the fragment's 123 must never leak.
	const text = '{"event":"exit","turns":8,"tokens":{"total":50}}\nokens":{"total":123}}';
	assert.equal(parseExitTurns(text), 8);
	assert.deepEqual(parseExitTokens(text), { total: 50 });
});

test("a head-cut fragment (the cap sliced its opening bytes) carries no anchor and is skipped", () => {
	// The capped tail can BEGIN mid-line. A first line whose {"event":" anchor did not survive the cut
	// is skipped and the intact exit line below it wins -- the fragment's 123 must not be misread as a
	// value. (A cut landing in a GLUED line's stray PREFIX instead leaves the anchor intact and
	// correctly repairs the genuine object; that direction is covered by the repair tests above.)
	const text = 'urns":8,"tokens":{"total":123}}\n{"event":"exit","turns":9,"tokens":{"total":50}}';
	assert.equal(parseExitTurns(text), 9);
	assert.deepEqual(parseExitTokens(text), { total: 50 });
});

test("a glued line truncated at the END (a mid-write death) stays skipped", () => {
	assert.equal(parseExitTurns('stray{"event":"exit","turns":7'), null);
});

// ---- parseExitTokens (issue #25): mirrors parseExitTurns, reads the usage object off the exit line ----

test("parseExitTokens reads the tokens object off the success exit line", () => {
	const tokens = { input: 300, output: 50, total: 350, cost: 0.02 };
	assert.deepEqual(parseExitTokens(`{"event":"exit","code":0,"turns":7,"tokens":${JSON.stringify(tokens)}}`), tokens);
});

test("parseExitTokens returns null for the catch-path exit line that omits tokens", () => {
	assert.equal(parseExitTokens('{"event":"exit","code":2,"reason":"config"}'), null);
});

test("parseExitTokens returns the LAST exit line's tokens when two are present", () => {
	const text = '{"event":"exit","tokens":{"total":1}}\n{"event":"exit","tokens":{"total":9}}';
	assert.deepEqual(parseExitTokens(text), { total: 9 });
});

test("the record carries a host, in tail position, and null when nobody named one", () => {
	const job = { id: "gh-1", name: "github", attemptsMade: 0, data: { kind: "github", repo: "acme/web", target: { number: 7 }, flow: "deploy" } };
	const args = { job, result: { outcome: "completed", exitCode: 0 }, startedAt: "2026-08-30T12:00:00.000Z", endedAt: "2026-08-30T12:00:01.000Z" };

	const withHost = buildRecord({ ...args, host: "mac-mini-1" });
	const keys = Object.keys(withHost);
	// `host` was the tail when it landed; `backend` (#277) took the tail after it, `dollars` (#501) after that, and
	// `why` after that, `project` (#499) after that, `plan` (#505) after that, `resources` (#596) after that, and `size`
	// (#596, phase 1) after that, `hostBudget` (#596, phase 2) after that, and `queuedAt` and `capacity` (#599) after that.
	assert.equal(keys.at(-11), "host", "tail position when it landed: field order is the contract");
	assert.equal(keys.length, 35);
	assert.equal(withHost.host, "mac-mini-1");

	// UNCONDITIONAL. `tokens`/`usage`/`session` set the precedent that null-with-the-key-present is this
	// record's normal case, and "field order is the serialisation order" is what makes a sometimes-absent
	// key a shape change rather than a value change.
	const without = buildRecord(args);
	assert.ok("host" in without, "the key is always present");
	assert.equal(without.host, null);
	assert.deepEqual(Object.keys(without), keys, "and the key SET does not depend on whether a host was passed");

	// The admissibility argument in one assertion: this value cannot be path-shaped, so it cannot carry
	// the OS account name that `targetFor` drops a local folder to a basename to avoid.
	assert.ok(!/[\\/]/.test(String(withHost.host)));
});

test("the record names the RESOLVED venue in tail position, read from the job DATA (#277)", () => {
	const data = { kind: "github", repo: "acme/web", target: { number: 7 }, flow: "deploy" };
	const at = { startedAt: "2026-08-30T12:00:00.000Z", endedAt: "2026-08-30T12:00:01.000Z" };
	const wrap = (d, extra = {}) => ({ id: "gh-1", name: "github", attemptsMade: 0, data: d, ...extra });
	const record = (job, over = {}) => buildRecord({ job, result: { outcome: "completed", exitCode: 0 }, ...at, ...over });

	const unflagged = record(wrap(data), { defaultBackend: "local" });
	assert.equal(Object.keys(unflagged).at(-10), "backend", "tail position when it landed; `dollars` (#501), `why`, `project` (#499), `plan` (#505), `resources`, `size`, `hostBudget` (#596), `queuedAt` and `capacity` (#599) took the tail after it");
	assert.equal(unflagged.backend, "local", "a trigger that names no venue records the default it resolved to, never an absent key");
	assert.equal(record(wrap({ ...data, backend: "far" }), { defaultBackend: "local" }).backend, "far", "a named venue wins over the default");
	assert.equal(
		record(wrap(data, { backend: "far" }), { defaultBackend: "local" }).backend,
		"local",
		"read from job.data: a key on the BullMQ wrapper is not the trigger's venue, and reading it there is the bug index.mjs records",
	);
	// An explicit null is a name the processor's gate refuses, not a request for the default, so the record
	// does not claim the default for it.
	assert.equal(record(wrap({ ...data, backend: null }), { defaultBackend: "local" }).backend, null);
	// No default passed is a dependency-injection seam, and it records nothing rather than guessing `local`.
	const seam = record(wrap(data));
	assert.ok("backend" in seam, "the key is always present");
	assert.equal(seam.backend, null);
	assert.deepEqual(Object.keys(seam), Object.keys(unflagged), "the key SET does not depend on whether a default was passed");
});

test("a deployment that never names a backend keeps the first twenty-five fields exactly as they were", () => {
	const job = { id: "gh-1", name: "github", attemptsMade: 0, data: { kind: "github", repo: "acme/web", target: { number: 7 }, flow: "deploy" } };
	const rec = buildRecord({ job, result: { outcome: "completed", exitCode: 0 }, startedAt: "2026-08-30T12:00:00.000Z", endedAt: "2026-08-30T12:00:01.000Z", host: "mac-mini-1", defaultBackend: "local" });
	assert.deepEqual(Object.keys(rec).slice(0, 25), [
		"jobId", "kind", "target", "flow", "startedAt", "endedAt", "outcome", "reason", "exitCode", "turns", "tokens", "usage",
		"provider", "model", "budgetReserved", "attempt", "parentJobId", "chainDepth", "chainRefused", "replica", "replicas",
		"triggerIndex", "triggerType", "session", "host",
	]);
	// Byte-level: everything a pre-#277 reader parsed serialises identically, and the new fields are appended.
	const { backend, dollars, why, project, plan, resources, size, hostBudget, queuedAt, capacity, ...before } = rec;
	assert.equal(backend, "local");
	assert.equal(dollars, null);
	assert.equal(why, null);
	assert.equal(project, null, "no projects file: the new key is present and null");
	assert.equal(plan, null, "no priorities.json: the new key (#505) is present and null");
	assert.equal(resources, null, "no exit line: the new key (#596) is present and null");
	assert.equal(size, null, "no size passed: the new key (#596, phase 1) is present and null");
	assert.equal(hostBudget, null, "no never-fits refusal: the new key (#596, phase 2) is present and null");
	assert.equal(queuedAt, null, "a job wrapper with no timestamp: the new key (#599) is present and null");
	assert.equal(capacity, null, "no capacity passed: the new key (#599) is present and null");
	assert.equal(JSON.stringify(rec), `${JSON.stringify(before).slice(0, -1)},"backend":"local","dollars":null,"why":null,"project":null,"plan":null,"resources":null,"size":null,"hostBudget":null,"queuedAt":null,"capacity":null}`);
});

test("parseExitTokens REBUILDS: a key the runner never had no reach into the record", () => {
	// The container owns this object. Passing it through put whatever it invented -- a path, a branch
	// name, a credential it read -- into a record whose PII-free property rests on holding none, while
	// this module's comment promised "integer token counts and numeric cost only".
	const hostile = '{"event":"exit","tokens":{"total":5,"input":2,"leaked":"ghp_x /Users/rob/secret","nested":{"branch":"feature/customer"}}}';
	const out = parseExitTokens(hostile);
	assert.deepEqual(out, { input: 2, total: 5 }, "only the closed key list survives");
	const json = JSON.stringify(out);
	assert.ok(!json.includes("ghp_x"), "no attacker-chosen string");
	assert.ok(!json.includes("/Users/rob/"), "and nothing path-shaped");
	assert.ok(!json.includes("feature/customer"), "nesting is not a way around the list either");
	// A string in a KNOWN slot is dropped too: the list closes which keys survive, the type check closes
	// what may sit in them.
	assert.deepEqual(parseExitTokens('{"event":"exit","tokens":{"total":5,"cost":"free"}}'), { total: 5 });
});

test("parseExitTokens round-trips a conformant runner's object BYTE-IDENTICALLY", () => {
	// The rebuild must cost a real image nothing, key order included -- the record's bytes are a contract.
	// Both shapes the runner emits: usage-meter.mjs -> snapshot, and run-job.mjs -> pickTotals.
	const metered = { input: 1, output: 2, total: 3, cost: 0.5, metered: true, rootTotal: 3, otherTotal: 0, looseTotal: 0, sessions: 1, calls: 4, unresolved: 0, unpriced: 0 };
	assert.equal(JSON.stringify(parseExitTokens(`{"event":"exit","tokens":${JSON.stringify(metered)}}`)), JSON.stringify(metered));
	const fallback = { input: 1, output: 2, total: 3, cost: 0.5, metered: false };
	assert.equal(JSON.stringify(parseExitTokens(`{"event":"exit","tokens":${JSON.stringify(fallback)}}`)), JSON.stringify(fallback));
	// An omitted key stays OMITTED rather than becoming null: the fallback carries five of the twenty-two, and
	// a null would read as "measured zero" for a number nobody measured.
	assert.ok(!("otherTotal" in parseExitTokens(`{"event":"exit","tokens":${JSON.stringify(fallback)}}`)));
});

test("the policy counters (issues #501, #502) survive the rebuild, in emission order, and only as numbers", () => {
	// The cost guard writes the first six under a cap and the model guard modelRefused under a list; a key missing from
	// TOKEN_KEYS is DROPPED, and the dollar
	// settlement reads these to decide whether a metered cost is complete, so a dropped counter would read as
	// an honest zero. Each one asserted by name, so dropping any single entry fails here.
	const policy = { costCapMicros: 2_000_000, costRefused: 1, boundExceeded: 0, longContext: 2, costUnjudged: 4, costUnanswered: 5, modelRefused: 3 };
	assert.deepEqual(TOKEN_KEYS.slice(-7), Object.keys(policy), "appended after unpriced, in the runner's emission order");
	const metered = { input: 1, output: 2, total: 3, cost: 0.5, metered: true, rootTotal: 3, otherTotal: 0, looseTotal: 0, sessions: 1, calls: 4, unresolved: 0, unpriced: 0, ...policy };
	const out = parseExitTokens(`{"event":"exit","tokens":${JSON.stringify(metered)}}`);
	assert.equal(JSON.stringify(out), JSON.stringify(metered), "byte-identical round trip, key order included");
	for (const key of Object.keys(policy)) assert.equal(out[key], policy[key], key);
	assert.equal(parseExitTokens('{"event":"exit","tokens":{"total":1,"costRefused":"many"}}').costRefused, undefined, "a string in a policy slot is dropped like any other");
	assert.ok(Object.isFrozen(TOKEN_KEYS));
});

test("costUnreported (issue #571) survives the rebuild after the child keys and before the policy counters, on a line with or without a cap", () => {
	const at = TOKEN_KEYS.indexOf("unmeteredChildren");
	assert.deepEqual(TOKEN_KEYS.slice(at + 1, at + 3), ["costUnreported", "costCapMicros"], "the meter writes it last, the guard's fields follow");
	const uncapped = { input: 1, output: 2, total: 3, cost: 0, metered: true, rootTotal: 3, otherTotal: 0, looseTotal: 0, sessions: 1, calls: 1, unresolved: 0, unpriced: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, costUnreported: 1 };
	const out = parseExitTokens(`{"event":"exit","tokens":${JSON.stringify(uncapped)}}`);
	assert.equal(JSON.stringify(out), JSON.stringify(uncapped), "byte-identical round trip on an uncapped line");
	const capped = { ...uncapped, costCapMicros: 2_000_000, costRefused: 0, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0 };
	assert.equal(JSON.stringify(parseExitTokens(`{"event":"exit","tokens":${JSON.stringify(capped)}}`)), JSON.stringify(capped), "and on a capped one");
	assert.equal(parseExitTokens('{"event":"exit","tokens":{"total":1,"costUnreported":"one"}}').costUnreported, undefined, "numbers only");
});

test("the child keys (issue #500 part F) survive the rebuild, between unpriced and the policy counters, each by name", () => {
	// A metered runner from issue #500 part E on writes all three on every line, zeros with no children. A key missing
	// from TOKEN_KEYS is DROPPED, and `unmeteredChildren` is a floor counter: dropped, it would read as an honest zero.
	const child = { childTotal: 700, childProcesses: 2, unmeteredChildren: 1 };
	const at = TOKEN_KEYS.indexOf("unpriced");
	assert.deepEqual(TOKEN_KEYS.slice(at + 1, at + 4), Object.keys(child), "after unpriced, in the runner's emission order");
	const metered = { input: 1, output: 2, total: 703, cost: 0.5, metered: true, rootTotal: 3, otherTotal: 0, looseTotal: 0, sessions: 3, calls: 4, unresolved: 0, unpriced: 0, ...child, costCapMicros: 2_000_000, costRefused: 0 };
	const out = parseExitTokens(`{"event":"exit","tokens":${JSON.stringify(metered)}}`);
	assert.equal(JSON.stringify(out), JSON.stringify(metered), "byte-identical round trip, key order included");
	for (const key of Object.keys(child)) assert.equal(out[key], child[key], key);
	assert.equal(out.rootTotal + out.otherTotal + out.looseTotal + out.childTotal, out.total);
	assert.equal(parseExitTokens('{"event":"exit","tokens":{"total":1,"unmeteredChildren":"none"}}').unmeteredChildren, undefined, "numbers only");
});

test("parseExitSession refuses a reason outside the CLOSED enum", () => {
	// The enum is documented closed in INT-RUN-HISTORY-FILE-CONTRACT; until this check it was enforced by
	// nothing, so the container could write any string into the record.
	assert.deepEqual(parseExitSession('{"event":"exit","session":{"resumed":false,"reason":"attacker /path/ string"}}'), { resumed: false, reason: null });
	assert.deepEqual(parseExitSession('{"event":"exit","session":{"resumed":true,"reason":"resumed"}}'), { resumed: true, reason: "resumed" });
	// Every token the contract lists must survive, or this check would silently narrow the enum.
	for (const reason of ["resumed", "absent", "expired", "conversation-too-old", "resume-chain-too-long", "context-too-full", "compaction-summary-empty", "too-large", "unparseable", "not-a-regular-file", "key-not-a-directory", "transcript-diverted", "venue-changed", "pi-version-changed", "transcript-replaced", "locked", "promote-failed", "disabled"]) {
		assert.equal(parseExitSession(`{"event":"exit","session":{"resumed":false,"reason":${JSON.stringify(reason)}}}`).reason, reason, reason);
	}
});

test("parseExitTokens rejects a malformed tokens value rather than storing a partial", () => {
	// A non-object, an array, or an object missing a numeric total must not poison the daily counter.
	assert.equal(parseExitTokens('{"event":"exit","tokens":42}'), null);
	assert.equal(parseExitTokens('{"event":"exit","tokens":[1,2]}'), null);
	assert.equal(parseExitTokens('{"event":"exit","tokens":{"input":10}}'), null, "no numeric total -> null");
});

test("parseExitTokens never throws across the same corpus that stresses parseExitTurns", () => {
	for (const input of ['{"event":"exit","tokens":{"total":1}}', '{"event":"exi', "", undefined, null, 42, "null"]) {
		assert.doesNotThrow(() => parseExitTokens(input), `input=${JSON.stringify(input)}`);
	}
});

// ---- parseExitSession: the container's own verdict on the transcript it was handed ----

test("parseExitSession reads the session object off the success exit line", () => {
	assert.deepEqual(parseExitSession('{"event":"exit","code":0,"session":{"resumed":true,"reason":"resumed"}}'), { resumed: true, reason: "resumed" });
	assert.deepEqual(parseExitSession('{"event":"exit","code":0,"session":{"resumed":false,"reason":"absent"}}'), { resumed: false, reason: "absent" });
});

test("parseExitSession returns null when the container gave no verdict", () => {
	// The catch-path exit line carries {code, reason, message} and no session, and a runner image
	// predating the field emits none either. Both mean "the host's own reason stands" downstream, so this
	// null is load-bearing rather than merely defensive.
	assert.equal(parseExitSession('{"event":"exit","code":2,"reason":"config"}'), null);
	assert.equal(parseExitSession('{"event":"exit","code":0,"turns":3}'), null);
});

test("parseExitSession returns the LAST exit line's session when two are present", () => {
	const text = '{"event":"exit","session":{"resumed":true,"reason":"resumed"}}\n{"event":"exit","session":{"resumed":false,"reason":"unparseable"}}';
	assert.deepEqual(parseExitSession(text), { resumed: false, reason: "unparseable" });
});

test("parseExitSession refuses a malformed session rather than storing a partial", () => {
	// `resumed` is the required field: without a boolean there is no verdict, whatever else is present.
	assert.equal(parseExitSession('{"event":"exit","session":42}'), null);
	assert.equal(parseExitSession('{"event":"exit","session":[true]}'), null);
	assert.equal(parseExitSession('{"event":"exit","session":{"reason":"resumed"}}'), null, "no boolean resumed -> no verdict");
	assert.equal(parseExitSession('{"event":"exit","session":{"resumed":"yes"}}'), null);
	// A non-string reason is dropped to null while the verdict survives: the boolean is the fact.
	assert.deepEqual(parseExitSession('{"event":"exit","session":{"resumed":false,"reason":7}}'), { resumed: false, reason: null });
});

test("parseExitSession never throws across the same corpus that stresses parseExitTurns", () => {
	for (const input of ['{"event":"exit","session":{"resumed":true}}', '{"event":"exi', "", undefined, null, 42, "null"]) {
		assert.doesNotThrow(() => parseExitSession(input), `input=${JSON.stringify(input)}`);
	}
});

// ---- parseExitContext (issue #186): how full the context was when the run ended ----

test("parseExitContext reads the context object off the success exit line", () => {
	assert.deepEqual(parseExitContext('{"event":"exit","code":0,"context":{"tokens":12345,"window":200000}}'), { tokens: 12345, window: 200000 });
	assert.deepEqual(parseExitContext('{"event":"exit","code":0,"context":{"tokens":0,"window":200000}}'), { tokens: 0, window: 200000 }, "an empty context is a measurement, not an absent one");
});

test("parseExitContext returns null when there is no measurement to read", () => {
	// A runner predating the field, a run pi could give no context window for, and a compaction that left
	// the count unknown all omit the key. The store reads that null as "no measurement" and passes, so
	// this must never come back as a zero.
	assert.equal(parseExitContext('{"event":"exit","code":0,"turns":3}'), null);
	assert.equal(parseExitContext('{"event":"exit","code":2,"reason":"config"}'), null);
});

test("parseExitContext refuses a measurement that is not one", () => {
	assert.equal(parseExitContext('{"event":"exit","context":42}'), null);
	assert.equal(parseExitContext('{"event":"exit","context":[1,2]}'), null);
	assert.equal(parseExitContext('{"event":"exit","context":{"tokens":100}}'), null, "no window is no denominator");
	assert.equal(parseExitContext('{"event":"exit","context":{"tokens":100,"window":0}}'), null, "a zero window is not a denominator either");
	assert.equal(parseExitContext('{"event":"exit","context":{"tokens":-1,"window":200000}}'), null);
	assert.equal(parseExitContext('{"event":"exit","context":{"tokens":1.5,"window":200000}}'), null);
	assert.equal(parseExitContext('{"event":"exit","context":{"tokens":"100","window":"200000"}}'), null);
	// Beyond the safe range a number stringifies to exponential notation, which the session store's
	// decimal round-trip rejects on read -- so accepting it here would write a measurement into the store
	// that nothing can ever read back, and the gate would fail open on a context reported as full.
	assert.equal(parseExitContext('{"event":"exit","context":{"tokens":1e21,"window":1e22}}'), null);
	assert.equal(parseExitContext('{"event":"exit","context":{"tokens":1e308,"window":1e308}}'), null);
	assert.deepEqual(parseExitContext('{"event":"exit","context":{"tokens":9007199254740991,"window":9007199254740991}}'), { tokens: 9007199254740991, window: 9007199254740991 }, "the top of the safe range still round-trips");
});

test("parseExitContext returns the LAST exit line's context and never throws", () => {
	assert.deepEqual(parseExitContext('{"event":"exit","context":{"tokens":1,"window":10}}\n{"event":"exit","context":{"tokens":9,"window":10}}'), { tokens: 9, window: 10 });
	// The SHARED corpus, not a hand-picked subset -- the glued/truncated shapes must sweep this parser
	// too, which is the reason HOSTILE_CORPUS exists (see its comment).
	for (const input of HOSTILE_CORPUS) {
		assert.doesNotThrow(() => parseExitContext(input), `input=${JSON.stringify(input)}`);
	}
});

// ---- parseExitUsage (usage ledger): mirrors parseExitTokens, but REBUILDS the per-model ledger off the exit line ----

/** A fully-populated valid row, in the rebuilt 12-key shape. Tests spread over it to inject one bad field. */
const GOOD_ROW = { provider: "anthropic", model: "claude-sonnet-4", calls: 2, input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cacheWrite1h: 0, reasoning: 3, total: 168, cost: 0.02, unpriced: 0 };
const usageLine = (usage) => `{"event":"exit","code":0,"usage":${JSON.stringify(usage)}}`;

test("parseExitUsage reads the usage block off the success exit line and REBUILDS it", () => {
	// The rebuild is the whole point, not a nicety: provider/model are container-emitted strings, so
	// nothing rides through verbatim. Uppercase arrives lowercased, and an unknown row key is dropped
	// on the floor by never being read into the explicit 12-key literal.
	const emitted = { v: 1, piAi: "0.80.7", truncated: 0, models: [{ ...GOOD_ROW, provider: "Anthropic", smuggled: "SECRET_EXTRA" }] };
	const usage = parseExitUsage(usageLine(emitted));
	assert.deepEqual(usage, { v: 1, piAi: "0.80.7", truncated: 0, models: [GOOD_ROW] });
	assert.equal(JSON.stringify(usage).includes("SECRET_EXTRA"), false, "an unknown row key never survives the rebuild");
});

test("parseExitUsage returns null for the catch-path exit line that omits usage", () => {
	assert.equal(parseExitUsage('{"event":"exit","code":2,"reason":"config"}'), null);
	// The metered:false fallback line carries tokens but no ledger -- absent is NORMAL, not an error.
	assert.equal(parseExitUsage('{"event":"exit","code":0,"turns":3,"tokens":{"total":9}}'), null);
});

test("parseExitUsage returns the LAST exit line's usage when two are present", () => {
	const text = `${usageLine({ v: 1, models: [{ provider: "first", model: "m" }] })}\n${usageLine({ v: 1, models: [{ provider: "last", model: "m" }] })}`;
	assert.equal(parseExitUsage(text)?.models[0].provider, "last");
});

test("parseExitUsage rejects a malformed block rather than storing a partial -- one bad row nulls the WHOLE block", () => {
	// The malformed->null rule from parseExitTokens, block-wide: a valid sibling row must not survive a
	// bad one, because a partial ledger is how the rows stop summing to anything an operator can trust.
	assert.equal(parseExitUsage(usageLine({ v: 1, models: [GOOD_ROW, { ...GOOD_ROW, provider: "bad provider!" }] })), null);
	assert.equal(parseExitUsage(usageLine({ v: 0, models: [GOOD_ROW] })), null, "v must be an integer >= 1");
	assert.equal(parseExitUsage(usageLine({ v: 1.5, models: [GOOD_ROW] })), null);
	assert.equal(parseExitUsage(usageLine({ v: 1, piAi: "evil-string", models: [GOOD_ROW] })), null, "piAi is a plain semver or null, nothing else");
	assert.equal(parseExitUsage(usageLine({ v: 1, truncated: -1, models: [GOOD_ROW] })), null);
	assert.equal(parseExitUsage(usageLine({ v: 1, models: [] })), null, "an empty models array is not a ledger");
	assert.equal(parseExitUsage(usageLine({ v: 1, models: [42] })), null, "a non-object row nulls the block");
	assert.equal(parseExitUsage('{"event":"exit","usage":[1,2]}'), null, "an array is not a usage block");
	assert.equal(parseExitUsage('{"event":"exit","usage":42}'), null);
});

test("parseExitUsage charset: the id allowlist rejects length, symbols and a leading dot", () => {
	const withProvider = (provider) => usageLine({ v: 1, models: [{ ...GOOD_ROW, provider }] });
	assert.equal(parseExitUsage(withProvider("a".repeat(65))), null, "a 65-char id is over the cap");
	assert.notEqual(parseExitUsage(withProvider("a".repeat(64))), null, "64 IS the cap: 1 first-class char + 63 tail");
	assert.equal(parseExitUsage(withProvider("bad provider!")), null, "space and ! are outside the class");
	assert.equal(parseExitUsage(withProvider("../etc")), null, "a leading dot fails the first-char class -- no path shapes");
	// Issues #501/#502: the shapes the old pattern refused on real catalog ids, which nulled the whole block.
	const withModel = (model) => usageLine({ v: 1, models: [{ ...GOOD_ROW, provider: "cloudflare-workers-ai", model }] });
	assert.equal(parseExitUsage(withModel("@cf/meta/llama-4-scout-17b-16e-instruct"))?.models[0].model, "@cf/meta/llama-4-scout-17b-16e-instruct");
	assert.notEqual(parseExitUsage(withModel("~anthropic/claude-sonnet-latest")), null);
	assert.notEqual(parseExitUsage(withModel("qwen2.5:0.5b-instruct-q4_K_M")), null, "an Ollama tag's underscore, lowercased first");
});

test("parseExitUsage numerics: absent rebuilds as 0, but a negative, a null, or an Infinity nulls the block", () => {
	// Absent is an honest zero and the 12-key row shape stays stable regardless of what was emitted.
	const bare = parseExitUsage(usageLine({ v: 1, models: [{ provider: "a", model: "m" }] }));
	// ...but an absent `truncated` is null, not 0 (PR #549's review): nobody measured it, and the model dollar
	// windows floor on it.
	assert.deepEqual(bare, { v: 1, piAi: null, truncated: null, models: [{ provider: "a", model: "m", calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 0, cost: 0, unpriced: 0 }] });
	assert.equal(parseExitUsage(usageLine({ v: 1, models: [{ ...GOOD_ROW, input: -1 }] })), null, "a negative count nulls the block");
	assert.equal(parseExitUsage(usageLine({ v: 1, models: [{ ...GOOD_ROW, cost: null }] })), null, "null is present-and-wrong, not absent");
	// JSON.parse cannot produce NaN, but it CAN produce Infinity -- 1e999 overflows to it -- so the
	// finite check is the guard that actually fires on hostile input, not a decorative one.
	assert.equal(parseExitUsage('{"event":"exit","usage":{"v":1,"models":[{"provider":"a","model":"m","total":1e999}]}}'), null);
});

test("parseExitUsage never throws across the shared hostile corpus", () => {
	for (const input of HOSTILE_CORPUS) {
		assert.doesNotThrow(() => parseExitUsage(input), `input=${JSON.stringify(input)}`);
	}
});

test("parseExitUsage rejects a ten-row models array -- 8 named rows plus one 'other' is the whole envelope", () => {
	const rows = (n) => Array.from({ length: n }, (_, i) => ({ provider: "p", model: `m${i}` }));
	assert.equal(parseExitUsage(usageLine({ v: 1, models: rows(10) })), null, "a tenth row is a broken emitter, not a bigger ledger");
	assert.notEqual(parseExitUsage(usageLine({ v: 1, models: rows(9) })), null, "nine rows is the documented cap");
});

test("buildRecord stores a completed run's tokens object as an explicit field", () => {
	const tokens = { input: 1000, output: 200, total: 1200, cost: 0.05 };
	const record = buildRecord({
		job: { id: "gh-t", attemptsMade: 0, name: "github", data: { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } } },
		result: { outcome: "completed", turns: 4, tokens },
		startedAt: "2026-07-18T00:00:00.000Z",
		endedAt: "2026-07-18T00:01:00.000Z",
	});
	assert.deepEqual(record.tokens, tokens);
	assert.equal(record.turns, 4);
});

test("buildRecord stores usage/provider/model explicitly from a completed source", () => {
	// The trio lands like tokens does: explicit literals off the RESULT, no spread. provider/model are
	// what the host dispatched with; usage is the rebuilt ledger the sink recovered from the exit line.
	const usage = { v: 1, piAi: "0.80.7", truncated: 0, models: [GOOD_ROW] };
	const record = buildRecord({
		job: { id: "gh-u", attemptsMade: 0, name: "github", data: { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } } },
		result: { outcome: "completed", provider: "anthropic", model: "claude-sonnet-4", usage },
		startedAt: "2026-08-01T00:00:00.000Z",
		endedAt: "2026-08-01T00:01:00.000Z",
	});
	assert.deepEqual(record.usage, usage);
	assert.equal(record.provider, "anthropic");
	assert.equal(record.model, "claude-sonnet-4");
});

test("the usage trio keeps the record PII-free: host-fact provider/model, charset-validated ledger ids", () => {
	// The record's provider/model come from the RESULT -- the effectiveJob's overlay-resolved values --
	// never from anything the container printed. Container strings enter only through parseExitUsage's
	// rebuild, so by the time a ledger id can reach this literal it has already passed the lowercased
	// allowlist. This test drives the real parser, not a hand-built block, to pin that composition.
	const usage = parseExitUsage('{"event":"exit","usage":{"v":1,"models":[{"provider":"Anthropic","model":"Claude-X","total":9}]}}');
	const record = buildRecord({
		job: {
			id: "gh-u2",
			attemptsMade: 0,
			name: "github",
			data: { kind: "github", repo: "o/r", flow: "fix", target: { type: "issue", number: 3, title: "SECRET_T", body: "SECRET_B" } },
		},
		result: { outcome: "completed", provider: "anthropic", model: "claude-x", usage },
		startedAt: "2026-08-01T00:00:00.000Z",
		endedAt: "2026-08-01T00:01:00.000Z",
	});
	assert.equal(record.provider, "anthropic", "the host fact, not a container string");
	assert.equal(record.model, "claude-x");
	for (const row of record.usage.models) {
		assert.match(row.provider, MODEL_REF_PATTERN, "every stored ledger id passed the allowlist");
		assert.match(row.model, MODEL_REF_PATTERN);
	}
	const json = JSON.stringify(record);
	assert.ok(!json.includes("SECRET_T"), "title must not leak past the trio either");
	assert.ok(!json.includes("SECRET_B"), "body must not leak past the trio either");
});

test("a gitlab run records project!iid for an MR and project#iid for an issue, never null", () => {
	// INT-RUN-HISTORY-FILE-CONTRACT documented `<project>!<iid>` from the day the GitLab arm landed, and
	// `targetFor` enumerated github only -- so every GitLab run since #42 wrote `target: null`, silently,
	// with no test in this file mentioning gitlab at all. The notation is the forge's own, and the two
	// target types must not collapse onto one label: GitLab numbers issues and MRs separately, so
	// `project#5` and `project!5` name different objects.
	const record = (target) =>
		buildRecord({
			job: { id: "gl-x", attemptsMade: 0, name: "gitlab", data: { kind: "gitlab", repo: "grp/sub/proj", projectId: 42, flow: "fix", target } },
			result: { outcome: "completed" },
			startedAt: "2026-07-18T00:00:00.000Z",
			endedAt: "2026-07-18T00:01:00.000Z",
		}).target;

	assert.equal(record({ type: "pull_request", number: 5 }), "grp/sub/proj!5", "a merge request is ! on GitLab");
	assert.equal(record({ type: "issue", number: 5 }), "grp/sub/proj#5", "an issue is # on every forge");
});

test("every forge the table knows records a target label -- none of them inherits null", () => {
	// Written as a loop so a forge added to FORGES and missed by targetFor fails HERE. The old shape
	// returned null for anything it did not enumerate, which is invisible: the record is still written,
	// still valid against the contract's `| null`, and simply never says what the job was about.
	for (const kind of FORGE_KINDS) {
		const record = buildRecord({
			job: { id: `${kind}-1`, attemptsMade: 0, name: kind, data: { kind, repo: "o/r", flow: "fix", target: { type: "issue", number: 7 } } },
			result: { outcome: "completed" },
			startedAt: "2026-07-18T00:00:00.000Z",
			endedAt: "2026-07-18T00:01:00.000Z",
		});
		assert.equal(record.target, "o/r#7", `${kind}: a forge job's durable record must name its target`);
	}
});

test("a job kind that is neither a forge nor local still records target null rather than throwing", () => {
	// The contract admits null, and a chained/CLI job genuinely has no forge target. What must not happen
	// is a throw on the record path -- writing history is not allowed to fail a run.
	const record = buildRecord({
		job: { id: "chain-1", attemptsMade: 0, name: "chained", data: { kind: "chained", flow: "fix" } },
		result: { outcome: "completed" },
		startedAt: "2026-07-18T00:00:00.000Z",
		endedAt: "2026-07-18T00:01:00.000Z",
	});
	assert.equal(record.target, null);
});

test("buildRecord for a github job keeps id-only fields and admits no PII", () => {
	const job = {
		id: "gh-x",
		attemptsMade: 0,
		name: "github",
		data: { kind: "github", repo: "o/r", flow: "fix", target: { type: "issue", number: 5, title: "SECRET_T", body: "SECRET_B" } },
	};
	const record = buildRecord({
		job,
		result: { outcome: "completed" },
		startedAt: "2026-07-18T00:00:00.000Z",
		endedAt: "2026-07-18T00:01:00.000Z",
	});
	assert.equal(record.target, "o/r#5");
	assert.equal(record.outcome, "completed");
	assert.equal(record.attempt, 1, "attemptsMade 0 while processing is the first attempt");
	assert.equal(record.kind, "github");
	assert.equal(record.flow, "fix");
	assert.equal(record.turns, null);
	assert.equal(record.tokens, null, "a result without tokens defaults the field to null");
	assert.equal(record.usage, null, "a result without a ledger defaults the field to null");
	assert.equal(record.provider, null, "the dispatch facts default null when the source omits them");
	assert.equal(record.model, null);
	assert.equal(record.exitCode, null);
	assert.equal(record.budgetReserved, null);
	assert.equal(record.reason, null);
	assert.equal(record.triggerIndex, null, "a job whose data carries no trigger.matched records null attribution");
	assert.equal(record.triggerType, null);

	const json = JSON.stringify(record);
	assert.ok(!json.includes("SECRET_T"), "title must not leak");
	assert.ok(!json.includes("SECRET_B"), "body must not leak");
});

test("buildRecord for a local job keeps only the folder basename and no task text", () => {
	const job = {
		id: "local-abc",
		name: "local",
		data: { kind: "local", folder: "C:/Users/rob/proj", flow: "x", task: "SECRET_TASK" },
	};
	const record = buildRecord({
		job,
		result: { outcome: "completed" },
		startedAt: "2026-07-18T00:00:00.000Z",
		endedAt: "2026-07-18T00:01:00.000Z",
	});
	assert.equal(record.target, "local:proj");
	assert.equal(record.attempt, 1); // attemptsMade absent -> the first attempt, numbered 1

	const json = JSON.stringify(record);
	assert.ok(!json.includes("SECRET_TASK"), "task must not leak");
	assert.ok(!json.includes("C:/Users/rob/proj"), "full folder path must not leak");
	assert.ok(!json.includes("/Users/rob/"), "OS account path must not leak");
});

test("buildRecord throw-path maps a present error and no result to a failed outcome", () => {
	const job = { id: "gh-y", attemptsMade: 1, name: "github", data: { kind: "github", repo: "o/r", target: { type: "issue", number: 9 } } };
	const record = buildRecord({
		job,
		error: { reason: "error" },
		startedAt: "2026-07-18T00:00:00.000Z",
		endedAt: "2026-07-18T00:00:30.000Z",
	});
	assert.equal(record.outcome, "failed");
	assert.equal(record.reason, "error");
	assert.equal(record.attempt, 2, "attemptsMade 1 while processing is the second attempt");
	assert.equal(record.turns, null);
});

test("the record's attempt is the 1-based attempt number, from BullMQ's attemptsMade while processing (ledger, #464 round)", () => {
	// attemptsMade counts FINISHED attempts and the record is written before this one finishes, so the first of the
	// queue's two attempts reads 0 there and the second 1. The record says 1 and 2, what the panel's "attempt N" means.
	const at = (attemptsMade) => buildRecord({ job: { id: "gh-a", attemptsMade, name: "github", data: { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } } }, result: { outcome: "completed" }, startedAt: "2026-09-28T00:00:00.000Z", endedAt: "2026-09-28T00:00:01.000Z" }).attempt;
	assert.deepEqual([at(0), at(1), at(undefined), at("1"), at(-0.5), at(-1)], [1, 2, 1, 1, 1, 1]);
});

test("buildRecord throw-path admits no PII for either job kind", () => {
	const startedAt = "2026-07-18T00:00:00.000Z";
	const endedAt = "2026-07-18T00:00:30.000Z";

	const githubRecord = buildRecord({
		job: {
			id: "gh-err",
			attemptsMade: 1,
			name: "github",
			data: { kind: "github", repo: "o/r", flow: "fix", target: { type: "issue", number: 9, title: "SECRET_T", body: "SECRET_B" } },
		},
		error: { reason: "error" },
		startedAt,
		endedAt,
	});
	assert.equal(githubRecord.outcome, "failed");
	const githubJson = JSON.stringify(githubRecord);
	assert.ok(!githubJson.includes("SECRET_T"), "github title must not leak on the error branch");
	assert.ok(!githubJson.includes("SECRET_B"), "github body must not leak on the error branch");

	const localRecord = buildRecord({
		job: {
			id: "local-err",
			attemptsMade: 1,
			name: "local",
			data: { kind: "local", folder: "C:/Users/rob/proj", flow: "x", task: "SECRET_TASK" },
		},
		error: { reason: "error" },
		startedAt,
		endedAt,
	});
	assert.equal(localRecord.outcome, "failed");
	const localJson = JSON.stringify(localRecord);
	assert.ok(!localJson.includes("SECRET_TASK"), "local task must not leak on the error branch");
	assert.ok(!localJson.includes("C:/Users/rob/proj"), "full folder path must not leak on the error branch");
	assert.ok(!localJson.includes("/Users/rob/"), "OS account path must not leak on the error branch");
});

test("buildRecord: the chain fields default null on a non-chain record and chainEnqueued is never stored", () => {
	const job = { id: "gh-x", name: "github", data: { kind: "github", repo: "o/r", target: { type: "issue", number: 5 } } };
	const record = buildRecord({
		job,
		result: { outcome: "completed" },
		startedAt: "2026-07-22T00:00:00.000Z",
		endedAt: "2026-07-22T00:01:00.000Z",
	});
	assert.equal(record.parentJobId, null);
	assert.equal(record.chainDepth, null);
	assert.equal(record.chainRefused, null);
	assert.equal("chainEnqueued" in record, false, "chainEnqueued is derivable from children and is never stored on the record");
});

test("buildRecord: a chained child's parentJobId and chainDepth come from job.data", () => {
	const job = {
		id: "chain-abc",
		name: "local",
		data: { kind: "local", folder: "C:/Users/rob/proj", flow: "tidy", parentJobId: "local-parent", chainDepth: 2 },
	};
	const record = buildRecord({
		job,
		result: { outcome: "completed" },
		startedAt: "2026-07-22T00:00:00.000Z",
		endedAt: "2026-07-22T00:01:00.000Z",
	});
	assert.equal(record.parentJobId, "local-parent");
	assert.equal(record.chainDepth, 2);
});

test("buildRecord: chainRefused lands from a completed parent's result", () => {
	const job = { id: "local-parent", name: "local", data: { kind: "local", folder: "C:/Users/rob/proj" } };
	const record = buildRecord({
		job,
		result: { outcome: "completed", chainRefused: 1 },
		startedAt: "2026-07-22T00:00:00.000Z",
		endedAt: "2026-07-22T00:01:00.000Z",
	});
	assert.equal(record.chainRefused, 1);
	// parentJobId/chainDepth are absent from a top-level parent's own data -> null.
	assert.equal(record.parentJobId, null);
	assert.equal(record.chainDepth, null);
});

test("makeLogSink enabled appends chunks in order and returns turns from the exit line", async () => {
	const stream = makeFakeStream({ emitOn: "finish" });
	const fs = makeFakeFs({ stream });
	const openJobLog = makeLogSink({ logsDir: "/logs", enabled: true, fs });
	const jobLog = openJobLog("gh-1");

	const c1 = Buffer.from('{"event":"start"}\n');
	const c2 = Buffer.from('{"event":"exit","turns":5}\n');
	jobLog.write(c1);
	jobLog.write(c2);
	const { turns } = await jobLog.close();

	assert.equal(turns, 5);
	assert.equal(stream.chunks.length, 2);
	assert.equal(stream.chunks[0].toString(), c1.toString());
	assert.equal(stream.chunks[1].toString(), c2.toString());
	assert.equal(fs.calls.createWriteStream, 1); // opened lazily, once per job
	assert.equal(fs.calls.paths[0], join("/logs", "gh-1.log"));
});

test("makeLogSink disabled never opens a stream but still returns turns", async () => {
	const fs = makeFakeFs({ stream: makeFakeStream() });
	const openJobLog = makeLogSink({ logsDir: "/logs", enabled: false, fs });
	const jobLog = openJobLog("gh-2");

	jobLog.write(Buffer.from('{"event":"exit","turns":8}\n'));
	const { turns } = await jobLog.close();

	assert.equal(turns, 8);
	assert.equal(fs.calls.createWriteStream, 0); // the raw .log is opt-in; nothing opened
});

test("makeLogSink close returns the parsed usage beside turns/tokens/session", async () => {
	// Captured from the same bounded tail, before the flush, for the same reason the other three are:
	// telemetry must survive a flush that errors or times out.
	const fs = makeFakeFs({ stream: makeFakeStream() });
	const openJobLog = makeLogSink({ logsDir: "/logs", enabled: false, fs });
	const jobLog = openJobLog("gh-usage");

	jobLog.write(Buffer.from('{"event":"exit","turns":3,"tokens":{"total":9},"usage":{"v":1,"models":[{"provider":"Anthropic","model":"m","total":9}]}}\n'));
	const { turns, tokens, usage } = await jobLog.close();

	assert.equal(turns, 3);
	assert.deepEqual(tokens, { total: 9 });
	assert.equal(usage.models[0].provider, "anthropic", "the sink hands back the REBUILT block, ids already lowercased");
});

test("makeLogSink close returns usage null for a tail without a ledger", async () => {
	const fs = makeFakeFs({ stream: makeFakeStream() });
	const openJobLog = makeLogSink({ logsDir: "/logs", enabled: false, fs });
	const jobLog = openJobLog("gh-no-usage");

	jobLog.write(Buffer.from('{"event":"exit","turns":8,"tokens":{"total":5}}\n'));
	const { usage } = await jobLog.close();

	assert.equal(usage, null, "a pre-ledger exit line yields null, and null is normal, not an error");
});

test("makeLogSink swallows a stream that throws on write and emits error, still returning turns", async () => {
	const stream = makeFakeStream({ emitOn: "finish", writeThrows: true, emitError: true });
	const logs = [];
	const fs = makeFakeFs({ stream });
	const openJobLog = makeLogSink({ logsDir: "/logs", enabled: true, fs, log: (event, fields) => logs.push({ event, fields }) });
	const jobLog = openJobLog("gh-3");

	assert.doesNotThrow(() => jobLog.write(Buffer.from('{"event":"exit","turns":4}\n')));
	const res = await jobLog.close();

	assert.equal(res.turns, 4);
	assert.ok(logs.some((l) => l.event === "log_sink_error"), "a swallowed error is reported, not thrown");
});

test("makeLogSink close resolves within the timeout when finish never fires", async () => {
	const stream = makeFakeStream({ emitOn: "none" });
	const fs = makeFakeFs({ stream });
	const openJobLog = makeLogSink({ logsDir: "/logs", enabled: true, fs });
	const jobLog = openJobLog("gh-4");

	jobLog.write(Buffer.from('{"event":"exit","turns":2}\n'));
	const start = Date.now();
	const { turns } = await jobLog.close({ timeoutMs: 50 });
	const elapsed = Date.now() - start;

	assert.equal(turns, 2);
	assert.ok(elapsed < 2000, `close must not hang, resolved in ${elapsed}ms`);
});

test("makeLogSink bounds the tail: an exit line older than the cap is evicted", async () => {
	const fs = makeFakeFs({ stream: makeFakeStream() });
	const openJobLog = makeLogSink({ logsDir: "/logs", enabled: false, fs });
	const jobLog = openJobLog("gh-5");

	jobLog.write(Buffer.from('{"event":"exit","turns":9}\n')); // early -- must fall out of the tail window
	const noise = `${"x".repeat(1000)}\n`;
	for (let i = 0; i < 20; i++) jobLog.write(Buffer.from(noise)); // ~20KB > 8KB cap
	const { turns } = await jobLog.close();

	assert.equal(turns, null); // the old exit line was dropped -> buffer is bounded
});

test("makeLogSink bounded tail retains the most recent exit line", async () => {
	const fs = makeFakeFs({ stream: makeFakeStream() });
	const openJobLog = makeLogSink({ logsDir: "/logs", enabled: false, fs });
	const jobLog = openJobLog("gh-6");

	const noise = `${"x".repeat(1000)}\n`;
	for (let i = 0; i < 20; i++) jobLog.write(Buffer.from(noise));
	jobLog.write(Buffer.from('{"event":"exit","turns":11}\n')); // last -- stays in the window
	const { turns } = await jobLog.close();

	assert.equal(turns, 11);
});

test("makeLogSink never throws from the factory when mkdirSync fails", () => {
	const logs = [];
	const fs = makeFakeFs({ stream: makeFakeStream(), mkdirThrows: true });
	assert.doesNotThrow(() => makeLogSink({ logsDir: "/logs", enabled: true, fs, log: (event, fields) => logs.push({ event, fields }) }));
	assert.ok(logs.some((l) => l.event === "logs_dir_error"), "a logs-dir failure is reported, not thrown");
});

test("makeRecordWriter writes one truncating JSON sidecar whose content round-trips the record", () => {
	const fs = makeFakeFs({ stream: makeFakeStream() });
	const writeRecord = makeRecordWriter({ logsDir: "/logs", fs });
	const record = { jobId: "gh-x", target: "o/r#5", outcome: "completed" };

	writeRecord(record);

	assert.equal(fs.writes.length, 1);
	assert.equal(fs.writes[0].path, join("/logs", "gh-x.json"));
	assert.deepEqual(JSON.parse(fs.writes[0].data), record);
});

test("makeRecordWriter sanitizes the job id at the filename boundary only", () => {
	const fs = makeFakeFs({ stream: makeFakeStream() });
	const writeRecord = makeRecordWriter({ logsDir: "/logs", fs });

	writeRecord({ jobId: "repeat:a:1", target: "o/r#5", outcome: "completed" });

	assert.equal(basename(fs.writes[0].path), "repeat_a_1.json");
	// The record body keeps the raw id; only the filename is sanitized.
	assert.equal(JSON.parse(fs.writes[0].data).jobId, "repeat:a:1");
});

test("makeRecordWriter swallows an fs failure and logs jobId + reason with no record content", () => {
	const logs = [];
	const fs = makeFakeFs({ stream: makeFakeStream(), writeThrows: true });
	const writeRecord = makeRecordWriter({ logsDir: "/logs", fs, log: (event, fields) => logs.push({ event, fields }) });

	assert.doesNotThrow(() => writeRecord({ jobId: "gh-x", target: "o/r#5", outcome: "completed" }));

	const failed = logs.find((l) => l.event === "run_record_failed");
	assert.ok(failed, "an fs failure is reported, not thrown");
	assert.equal(failed.fields.jobId, "gh-x");
	assert.equal(typeof failed.fields.reason, "string");
	const loggedKeys = Object.keys(failed.fields).sort();
	assert.deepEqual(loggedKeys, ["jobId", "reason"]);
	const loggedJson = JSON.stringify(failed.fields);
	assert.ok(!loggedJson.includes("o/r#5"), "target must not leak into the failure log");
	assert.ok(!loggedJson.includes("completed"), "outcome must not leak into the failure log");
});

test("makeRecordWriter swallows a JSON.stringify failure and never touches the fs", () => {
	const logs = [];
	const fs = makeFakeFs({ stream: makeFakeStream() });
	const writeRecord = makeRecordWriter({ logsDir: "/logs", fs, log: (event, fields) => logs.push({ event, fields }) });
	const circular = { jobId: "gh-circ", target: "o/r#5" };
	circular.self = circular; // JSON.stringify throws on a circular reference

	assert.doesNotThrow(() => writeRecord(circular));

	assert.ok(logs.some((l) => l.event === "run_record_failed"), "a serialize failure is reported, not thrown");
	assert.equal(fs.writes.length, 0, "no partial write reaches the fs when serialization fails");
});

test("makeRecordWriter overwrites on a re-run: two same-id writes are truncating writeFileSync, not append", () => {
	const fs = makeFakeFs({ stream: makeFakeStream() });
	const writeRecord = makeRecordWriter({ logsDir: "/logs", fs });

	writeRecord({ jobId: "gh-x", target: "o/r#5", outcome: "failed", attempt: 0 });
	writeRecord({ jobId: "gh-x", target: "o/r#5", outcome: "completed", attempt: 1 });

	assert.equal(fs.writes.length, 2);
	assert.equal(fs.writes[0].path, fs.writes[1].path); // same job id -> same sidecar, last write wins
	assert.equal(fs.calls.createWriteStream, 0); // truncating writeFileSync, never an append stream
	assert.equal(JSON.parse(fs.writes[1].data).outcome, "completed");
});

// ---- makeFindPreviousRun: reads a scheduler's prior run back from the per-job sidecars ----

/**
 * A fake fs exposing only what findPreviousRun touches: `names` is the directory listing, `files` maps
 * a sidecar filename to its raw content. `readdirThrows` models a missing logs dir (first boot);
 * `readThrows` models an unreadable sidecar.
 */
function makeHistoryFs({ names = [], files = {}, readdirThrows = false, readThrows = false } = {}) {
	return {
		readdirSync() {
			if (readdirThrows) throw new Error("ENOENT: no such file or directory");
			return names;
		},
		readFileSync(path) {
			if (readThrows) throw new Error("EACCES: permission denied");
			const name = basename(path);
			if (!(name in files)) throw new Error(`ENOENT: ${name}`);
			return files[name];
		},
	};
}

test("makeFindPreviousRun picks the max-millis run strictly below beforeMillis and returns its endedAt", () => {
	const fs = makeHistoryFs({
		names: ["repeat_t_100.json", "repeat_t_300.json", "repeat_t_500.json", "repeat_t_700.json"],
		files: {
			"repeat_t_300.json": '{"endedAt":"WRONG-not-the-max"}',
			"repeat_t_500.json": '{"startedAt":"2026-07-26T03:00:00.000Z","endedAt":"2026-07-26T03:05:00.000Z"}',
		},
	});
	const findPreviousRun = makeFindPreviousRun({ logsDir: "/logs", fs });
	// 700 is >= beforeMillis (excluded: it is this very fire), 500 is the max below.
	assert.equal(findPreviousRun({ schedulerId: "t", beforeMillis: 700 }), "2026-07-26T03:05:00.000Z");
});

test("makeFindPreviousRun ignores other schedulers, including the underscore collision (a vs a_1)", () => {
	const fs = makeHistoryFs({
		names: ["repeat_a_100.json", "repeat_a_1_100.json", "repeat_b_150.json", "a_100.json", "repeat_a_100.log"],
		files: {
			"repeat_a_100.json": '{"endedAt":"2026-07-26T01:00:00.000Z"}',
			"repeat_a_1_100.json": '{"endedAt":"WRONG-scheduler-a_1"}',
			"repeat_b_150.json": '{"endedAt":"WRONG-scheduler-b"}',
		},
	});
	const findPreviousRun = makeFindPreviousRun({ logsDir: "/logs", fs });
	// Scheduler "a": only repeat_a_<digits>.json qualifies -- repeat_a_1_100.json has a non-digit tail
	// after the "repeat_a_" prefix, so scheduler "a_1"'s files can never shadow scheduler "a"'s.
	assert.equal(findPreviousRun({ schedulerId: "a", beforeMillis: 999 }), "2026-07-26T01:00:00.000Z");
	// And the converse: scheduler "a_1" resolves its own file, not "a"'s.
	assert.equal(findPreviousRun({ schedulerId: "a_1", beforeMillis: 999 }), "WRONG-scheduler-a_1");
});

test("makeFindPreviousRun falls back to startedAt when the prior record has no endedAt (crashed run)", () => {
	const fs = makeHistoryFs({
		names: ["repeat_t_100.json"],
		files: { "repeat_t_100.json": '{"startedAt":"2026-07-26T02:00:00.000Z"}' },
	});
	const findPreviousRun = makeFindPreviousRun({ logsDir: "/logs", fs });
	assert.equal(findPreviousRun({ schedulerId: "t", beforeMillis: 999 }), "2026-07-26T02:00:00.000Z");
});

test("makeFindPreviousRun returns null when the logs dir is missing (readdir throws)", () => {
	const findPreviousRun = makeFindPreviousRun({ logsDir: "/logs", fs: makeHistoryFs({ readdirThrows: true }) });
	assert.equal(findPreviousRun({ schedulerId: "t", beforeMillis: 999 }), null);
});

test("makeFindPreviousRun returns null when the scheduler has no prior run at all", () => {
	const fs = makeHistoryFs({ names: ["local-abc.json", "repeat_other_100.json"] });
	const findPreviousRun = makeFindPreviousRun({ logsDir: "/logs", fs });
	assert.equal(findPreviousRun({ schedulerId: "t", beforeMillis: 999 }), null);
});

test("makeFindPreviousRun returns null when every candidate is at or above beforeMillis", () => {
	const fs = makeHistoryFs({
		names: ["repeat_t_500.json", "repeat_t_700.json"],
		files: { "repeat_t_500.json": '{"endedAt":"WRONG"}', "repeat_t_700.json": '{"endedAt":"WRONG"}' },
	});
	const findPreviousRun = makeFindPreviousRun({ logsDir: "/logs", fs });
	assert.equal(findPreviousRun({ schedulerId: "t", beforeMillis: 500 }), null, "strictly below: 500 itself is excluded");
});

test("makeFindPreviousRun returns null on an unreadable or malformed sidecar", () => {
	const unreadable = makeFindPreviousRun({
		logsDir: "/logs",
		fs: makeHistoryFs({ names: ["repeat_t_100.json"], readThrows: true }),
	});
	assert.equal(unreadable({ schedulerId: "t", beforeMillis: 999 }), null);

	const malformed = makeFindPreviousRun({
		logsDir: "/logs",
		fs: makeHistoryFs({ names: ["repeat_t_100.json"], files: { "repeat_t_100.json": "{ not json" } }),
	});
	assert.equal(malformed({ schedulerId: "t", beforeMillis: 999 }), null);
});

test("makeFindPreviousRun NEVER throws: a throwing fs and hostile arguments all yield null", () => {
	const throwing = makeFindPreviousRun({
		logsDir: "/logs",
		fs: {
			readdirSync() {
				throw new Error("boom");
			},
			readFileSync() {
				throw new Error("boom");
			},
		},
	});
	const inputs = [
		{ schedulerId: "t", beforeMillis: 999 },
		{ schedulerId: undefined, beforeMillis: 999 },
		{ schedulerId: "t", beforeMillis: null },
		{ schedulerId: "t", beforeMillis: NaN },
		{},
	];
	for (const input of inputs) {
		assert.doesNotThrow(() => throwing(input), `input=${JSON.stringify(input)}`);
		assert.equal(throwing(input), null);
	}
	// Nullish beforeMillis is refused even over a healthy fs -- no lookup without a fire instant.
	const healthy = makeFindPreviousRun({
		logsDir: "/logs",
		fs: makeHistoryFs({ names: ["repeat_t_100.json"], files: { "repeat_t_100.json": '{"endedAt":"X"}' } }),
	});
	assert.equal(healthy({ schedulerId: "t", beforeMillis: null }), null);
});

// A fixed clock so the reaper's cutoff is deterministic: day 1000, in ms.
const NOW = 1000 * 86400000;

test("makeLogReaper unlinks files older than the window and keeps newer ones, logging one reaped_log per unlink", () => {
	const logs = [];
	const fs = makeFakeFs({
		stream: makeFakeStream(),
		readdirNames: ["old.log", "old.json", "new.log", "new.json"],
		stats: {
			"old.log": { isFile: true, mtimeMs: 990 * 86400000 }, // < cutoff (993d) -> reaped
			"old.json": { isFile: true, mtimeMs: 990 * 86400000 },
			"new.log": { isFile: true, mtimeMs: 999 * 86400000 }, // > cutoff -> kept
			"new.json": { isFile: true, mtimeMs: 999 * 86400000 },
		},
	});
	const reapLogs = makeLogReaper({
		logsDir: "/logs",
		retentionDays: 7,
		fs,
		now: () => NOW,
		log: (event, fields) => logs.push({ event, fields }),
	});

	assert.doesNotThrow(reapLogs);

	assert.deepEqual(fs.unlinked.sort(), [join("/logs", "old.json"), join("/logs", "old.log")]);
	const reaped = logs.filter((l) => l.event === "reaped_log").map((l) => l.fields.file).sort();
	assert.deepEqual(reaped, ["old.json", "old.log"]);
});

test("makeLogReaper with retentionDays 0 keeps forever: nothing is read or unlinked", () => {
	const fs = makeFakeFs({
		stream: makeFakeStream(),
		readdirNames: ["old.log"],
		stats: { "old.log": { isFile: true, mtimeMs: 0 } },
	});
	const reapLogs = makeLogReaper({ logsDir: "/logs", retentionDays: 0, fs, now: () => NOW });

	reapLogs();

	assert.equal(fs.calls.readdir, 0); // keep-forever sentinel: the directory is never listed
	assert.equal(fs.unlinked.length, 0);
});

test("makeLogReaper isolates a per-file failure: one statSync throw does not abort the sweep", () => {
	const logs = [];
	const fs = makeFakeFs({
		stream: makeFakeStream(),
		readdirNames: ["bad.log", "good.log"],
		stats: {
			"good.log": { isFile: true, mtimeMs: 990 * 86400000 },
		},
		statThrowsFor: ["bad.log"],
	});
	const reapLogs = makeLogReaper({
		logsDir: "/logs",
		retentionDays: 7,
		fs,
		now: () => NOW,
		log: (event, fields) => logs.push({ event, fields }),
	});

	assert.doesNotThrow(reapLogs);

	assert.deepEqual(fs.unlinked, [join("/logs", "good.log")]); // the sweep continued past the bad entry
	const skipped = logs.find((l) => l.event === "log_reaper_skipped");
	assert.equal(skipped.fields.file, "bad.log");
});

test("makeLogReaper does not throw and logs log_reaper_skipped when the logs dir is missing", () => {
	const logs = [];
	const fs = makeFakeFs({ stream: makeFakeStream(), readdirThrows: true });
	const reapLogs = makeLogReaper({
		logsDir: "/logs",
		retentionDays: 7,
		fs,
		now: () => NOW,
		log: (event, fields) => logs.push({ event, fields }),
	});

	assert.doesNotThrow(reapLogs);

	assert.equal(fs.unlinked.length, 0);
	assert.ok(logs.some((l) => l.event === "log_reaper_skipped"), "a missing dir is reported, not thrown");
});

test("makeLogReaper considers only .log/.json: other extensions are never statted or unlinked", () => {
	const fs = makeFakeFs({
		stream: makeFakeStream(),
		readdirNames: ["notes.txt", "worker.out", "keep.log"],
		stats: { "keep.log": { isFile: true, mtimeMs: 990 * 86400000 } },
	});
	const reapLogs = makeLogReaper({ logsDir: "/logs", retentionDays: 7, fs, now: () => NOW });

	reapLogs();

	const statted = fs.calls.stat.map((p) => basename(p));
	assert.ok(!statted.includes("notes.txt"), "a non-matching extension is never statted");
	assert.ok(!statted.includes("worker.out"), "a non-matching extension is never statted");
	assert.deepEqual(fs.unlinked, [join("/logs", "keep.log")]); // only the .log was swept
});

test("makeLogReaper skips a directory entry: an aged name whose isFile() is false is not unlinked", () => {
	const logs = [];
	const fs = makeFakeFs({
		stream: makeFakeStream(),
		readdirNames: ["dir.log"],
		stats: { "dir.log": { isFile: false, mtimeMs: 990 * 86400000 } }, // aged, but a directory
	});
	const reapLogs = makeLogReaper({
		logsDir: "/logs",
		retentionDays: 7,
		fs,
		now: () => NOW,
		log: (event, fields) => logs.push({ event, fields }),
	});

	reapLogs();

	assert.equal(fs.calls.stat.length, 1); // it was statted...
	assert.equal(fs.unlinked.length, 0); // ...but the isFile() guard skipped the unlink
	assert.ok(!logs.some((l) => l.event === "reaped_log"), "a directory is never reaped");
});

test("buildRecord carries the replica index and set size from job.data, and nulls them when absent", () => {
	// Additive and nullable, exactly like the chain fields beside them (INT-RUN-HISTORY-FILE-CONTRACT).
	// Without these the runs list shows two rows that look like an accidental double-run rather than the
	// pair an operator asked for.
	const rec = buildRecord({
		job: { id: "gh-guid-r2", name: "github", data: { kind: "github", repo: "o/r", target: { type: "issue", number: 7 }, flow: "fix", replica: 2, replicas: 2 } },
		result: { outcome: "completed" },
		startedAt: "2026-08-01T00:00:00.000Z",
		endedAt: "2026-08-01T00:01:00.000Z",
	});
	assert.equal(rec.replica, 2);
	assert.equal(rec.replicas, 2);

	const plain = buildRecord({
		job: { id: "gh-guid", name: "github", data: { kind: "github", repo: "o/r", target: { type: "issue", number: 7 }, flow: "fix" } },
		result: { outcome: "completed" },
	});
	assert.equal(plain.replica, null, "an unreplicated run reads null, never 0 -- the record shape stays stable");
	assert.equal(plain.replicas, null);
});

test("the replica fields keep the record PII-free by construction -- integers only", () => {
	// The record's whole PII-free property rests on it holding no attacker-chosen string. A replica index is
	// a host-assigned integer, which is why it may be here at all; the BRANCH NAME it implies is not, and is
	// deliberately absent for the same reason `session` omits it.
	const rec = buildRecord({
		job: { id: "gh-guid-r1", name: "github", data: { kind: "github", repo: "o/r", target: { type: "issue", number: 7, title: "SECRET TITLE", body: "SECRET BODY" }, flow: "fix", replica: 1, replicas: 2 } },
		result: { outcome: "completed" },
	});
	const json = JSON.stringify(rec);
	assert.equal(json.includes("SECRET"), false);
	assert.equal(json.includes("pi/issue-"), false, "the record names no branch, replica or not");
	assert.equal(typeof rec.replica, "number");
	assert.equal(typeof rec.replicas, "number");
});

test("buildRecord persists triggerIndex and triggerType from trigger.matched, and index 0 is 0, never null", () => {
	// Additive and nullable on the replica fields' precedent (INT-RUN-HISTORY-FILE-CONTRACT, issue #54).
	// Index 0 is a LEGAL index -- the first triggers.json entry -- so the `?? null` default must not
	// swallow it; this is the assertion a `|| null` typo would turn red.
	const rec = buildRecord({
		job: {
			id: "gh-guid",
			name: "github",
			data: {
				kind: "github",
				repo: "o/r",
				target: { type: "issue", number: 7 },
				flow: "fix",
				trigger: { kind: "issues", matched: { index: 0, type: "label", label: "SECRET_LABEL" } },
			},
		},
		result: { outcome: "completed" },
	});
	assert.equal(rec.triggerIndex, 0, "index 0 persists as 0 -- the ?? default must not eat it");
	assert.equal(rec.triggerType, "label");
	assert.equal("matched" in rec, false, "the matched OBJECT is never stored -- only its two admissible fields");

	const json = JSON.stringify(rec);
	assert.equal(json.includes("SECRET_LABEL"), false, "the third matched key is collaborator-applied text and never persists");
});

test("triggerType persists each of the closed route set, and nothing else rides along", () => {
	// The set is minted by the receiver's filters (receiver/src/filter.mjs: label, comment, pull_request;
	// the review route reuses pull_request). A record consumer may switch on these three values exactly.
	for (const type of ["label", "comment", "pull_request"]) {
		const rec = buildRecord({
			job: {
				id: `gh-${type}`,
				name: "github",
				data: { kind: "github", repo: "o/r", target: { type: "issue", number: 1 }, flow: "fix", trigger: { matched: { index: 3, type, phrase: "SECRET_PHRASE" } } },
			},
			result: { outcome: "completed" },
		});
		assert.equal(rec.triggerType, type);
		assert.equal(rec.triggerIndex, 3);
		assert.equal(JSON.stringify(rec).includes("SECRET_PHRASE"), false);
	}
});

test("a cron-shaped trigger ({id, pattern}, no matched) records null attribution on purpose", () => {
	// Cron attribution is already exact via the repeat:<id>:<millis> jobId join (makeFindPreviousRun),
	// which also reaches records written before these fields existed. Persisting trigger.id here would
	// duplicate a fact the record's own jobId carries.
	const rec = buildRecord({
		job: {
			id: "repeat:nightly:1754870400000",
			name: "local",
			data: { kind: "local", folder: "/x/proj", flow: "tidy", trigger: { id: "nightly", pattern: "0 3 * * *" } },
		},
		result: { outcome: "completed" },
	});
	assert.equal(rec.triggerIndex, null);
	assert.equal(rec.triggerType, null);
	assert.equal(JSON.stringify(rec).includes("nightly"), true, "the id still reaches the record -- inside jobId, its canonical home");
});

test("a NON-github replica record carries replica/replicas AND the forge's own target notation (#187)", () => {
	// REQ-REPLICA-RUNS' acceptance clause "the run records carry replica/replicas" was proven on github
	// alone. It is not free elsewhere: `targetFor` composes the target through targetSeparator, so a gitlab
	// MR replica must read `grp/proj!7` where a github PR replica reads `o/r#7`. This file already carries
	// the scar that makes it worth asserting -- targetFor once enumerated github only and every GitLab run
	// silently wrote `target: null`.
	const rec = buildRecord({
		job: { id: "gl-wh1-r2", attemptsMade: 0, name: "gitlab", data: { kind: "gitlab", repo: "grp/proj", projectId: 42, flow: "fix", target: { type: "pull_request", number: 7 }, replica: 2, replicas: 2 } },
		result: { outcome: "completed" },
		startedAt: "2026-08-01T00:00:00.000Z",
		endedAt: "2026-08-01T00:01:00.000Z",
	});
	assert.equal(rec.replica, 2);
	assert.equal(rec.replicas, 2);
	assert.equal(rec.target, "grp/proj!7", "an MR is ! -- # is the issue sequence, and they are separate");
	assert.equal(rec.kind, "gitlab");

	// The unreplicated twin on the same forge stays null, not 0, so the record shape is stable.
	const plain = buildRecord({
		job: { id: "gl-wh1", attemptsMade: 0, name: "gitlab", data: { kind: "gitlab", repo: "grp/proj", projectId: 42, flow: "fix", target: { type: "pull_request", number: 7 } } },
		result: { outcome: "completed" },
	});
	assert.equal(plain.replica, null);
	assert.equal(plain.replicas, null);
});

// --- issue #437: the runner's exit-2 reason, a label inside exit 2 and never a class ---

const exitLine = (fields) => `${JSON.stringify({ event: "exit", jobId: "gh-1", ...fields })}\n`;

test("parseExitReason returns a closed-set reason only off a LAST exit line that itself says code 2", () => {
	assert.equal(parseExitReason(exitLine({ code: 2, reason: "provider-auth-refused", message: "401 x" })), "provider-auth-refused");
	// Noise after the exit line, and a docker prefix glued onto it, change nothing.
	assert.equal(parseExitReason(`noise\n${exitLine({ code: 2, reason: "provider-auth-refused" })}trailing docker noise\n`), "provider-auth-refused");
	assert.equal(parseExitReason(`2026-09-26T00:00:00Z ${exitLine({ code: 2, reason: "provider-auth-refused" })}`), "provider-auth-refused");
	// Any other code on the line: the runner said something other than a policy refusal in its own words.
	for (const code of [1, 0, "2", 2.5, null, undefined]) {
		assert.equal(parseExitReason(exitLine({ code, reason: "provider-auth-refused" })), null, `code ${JSON.stringify(code)}`);
	}
	// A reason outside the closed set is unrepresentable here, including the runner's other exit-2 words.
	for (const reason of ["turn_budget", "token_budget", "config", "aborted", "runner-policy", "Provider-Auth-Refused", "provider-auth-refused ", "", null, 2, { x: 1 }]) {
		assert.equal(parseExitReason(exitLine({ code: 2, reason })), null, `reason ${JSON.stringify(reason)}`);
	}
	// Only the LAST exit event counts: an earlier refusal line is not what the runner exited on.
	assert.equal(parseExitReason(exitLine({ code: 2, reason: "provider-auth-refused" }) + exitLine({ code: 2, reason: "turn_budget" })), null);
	assert.equal(parseExitReason(exitLine({ code: 2, reason: "turn_budget" }) + exitLine({ code: 2, reason: "provider-auth-refused" })), "provider-auth-refused");
});

test("parseExitReason never throws and reads absence as null", () => {
	for (const text of [undefined, null, 42, {}, "", "\n\n", "{not json", '{"event":"exit"', '{"event":"start","code":2,"reason":"provider-auth-refused"}']) {
		assert.doesNotThrow(() => parseExitReason(text));
		assert.equal(parseExitReason(text), null, JSON.stringify(text));
	}
});

test("makeLogSink close reports exitReason even with raw logs disabled -- the label must not depend on the PII switch", async () => {
	for (const enabled of [false, true]) {
		const fs = makeFakeFs({ stream: makeFakeStream({ emitOn: "finish" }) });
		const jobLog = makeLogSink({ logsDir: "/logs", enabled, fs })("gh-auth");
		jobLog.write(Buffer.from(exitLine({ code: 2, reason: "provider-auth-refused", message: "401 invalid x-api-key" })));
		const closed = await jobLog.close();
		assert.equal(closed.exitReason, "provider-auth-refused", `enabled=${enabled}`);
		assert.equal(fs.calls.createWriteStream, enabled ? 1 : 0);
	}
	const fs = makeFakeFs({ stream: makeFakeStream() });
	const quiet = makeLogSink({ logsDir: "/logs", enabled: false, fs })("gh-none");
	quiet.write(Buffer.from(exitLine({ code: 2, reason: "turn_budget" })));
	assert.equal((await quiet.close()).exitReason, null);
});

test("every RUNNER_POLICY_REASONS member is a literal the runner itself writes (the worker cannot import the runner)", () => {
	// The two packages ship separately: the runner lives in the job image, the worker on the host. A
	// member renamed on one side only would leave the worker waiting for a word the runner never says,
	// and every refusal would read as runner-policy again with nothing failing. So read the source.
	const runnerSrc = readFileSync(new URL("../../image/runner/src/outcome.mjs", import.meta.url), "utf8");
	assert.ok(RUNNER_POLICY_REASONS.size > 0);
	for (const reason of RUNNER_POLICY_REASONS) {
		// Either written inline, or (issues #501, #502) as an exported literal the runner's meter and policy
		// check emit through, `export const NAME = "reason";`, which is the one spelling those use.
		const exported = new RegExp(`export const [A-Z_]+ = "${reason}";`);
		assert.ok(runnerSrc.includes(`reason: "${reason}"`) || exported.test(runnerSrc), `image/runner/src/outcome.mjs no longer emits reason "${reason}"`);
	}
	for (const reason of ["cost-cap", "model-not-allowed", "cost-cap-unenforceable", "model-policy-unenforceable"]) {
		assert.ok(RUNNER_POLICY_REASONS.has(reason), `${reason} is a runner reason the worker keeps`);
	}
	assert.ok(runnerSrc.includes('reason: "provider-auth-refused"'), "the runner's issue #437 literal moved");
});

// Issue #507: a cost-cap stop said only `cost-cap` with $0, because which rule of the guard refused reached the job log
// alone (`cost_refused`), never the record.
test("parseExitWhy keeps a cost-cap line's why only from the closed set, only on code 2, and only beside cost-cap (#507)", () => {
	for (const why of COST_CAP_WHYS) assert.equal(parseExitWhy(exitLine({ code: 2, reason: "cost-cap", why })), why);
	for (const [fields, label] of [
		[{ code: 2, reason: "cost-cap" }, "no why: a stop the guard did not refuse"],
		[{ code: 2, reason: "cost-cap", why: "qwen2.5:3b" }, "a model id, or any other container-written string, never passes"],
		[{ code: 2, reason: "cost-cap", why: "Unboundable" }, "exact, case-sensitive"],
		[{ code: 2, reason: "cost-cap", why: ["unboundable"] }, "not a string"],
		[{ code: 2, reason: "model-not-allowed", why: "unboundable" }, "only beside cost-cap"],
		[{ code: 1, reason: "cost-cap", why: "unboundable" }, "only on a line that says code 2"],
	]) {
		assert.equal(parseExitWhy(exitLine(fields)), null, label);
	}
	// The LAST exit line decides, as for parseExitReason.
	assert.equal(parseExitWhy(exitLine({ code: 2, reason: "cost-cap", why: "unboundable" }) + exitLine({ code: 2, reason: "cost-cap" })), null);
	assert.equal(parseExitWhy(exitLine({ code: 2, reason: "cost-cap" }) + "agent noise\n" + exitLine({ code: 2, reason: "cost-cap", why: "over-cap" })), "over-cap");
	for (const text of [undefined, null, 42, "", "{not json", '{"event":"start","code":2,"reason":"cost-cap","why":"unboundable"}']) {
		assert.doesNotThrow(() => parseExitWhy(text));
		assert.equal(parseExitWhy(text), null, JSON.stringify(text));
	}
});

test("COST_CAP_WHYS is the runner's COST_REFUSALS, read from its source (the worker cannot import the runner) (#507)", () => {
	const runnerSrc = readFileSync(new URL("../../image/runner/src/outcome.mjs", import.meta.url), "utf8");
	const m = runnerSrc.match(/export const COST_REFUSALS = Object\.freeze\((\[[^\]]*\])\);/);
	assert.ok(m, "image/runner/src/outcome.mjs no longer declares COST_REFUSALS in a form this pin can read");
	assert.deepEqual([...COST_CAP_WHYS], JSON.parse(m[1]));
	for (const why of COST_CAP_WHYS) assert.match(why, /^[a-z][a-z0-9-]{0,63}$/, "every member passes the record's own `why` charset");
});

test("makeLogSink close carries exitWhy only when the line named one, so every other close returns the object it always did (#507)", async () => {
	const fs = makeFakeFs({ stream: makeFakeStream() });
	const named = makeLogSink({ logsDir: "/logs", enabled: false, fs })("gh-why");
	named.write(Buffer.from(exitLine({ code: 2, reason: "cost-cap", why: "unboundable" })));
	const closed = await named.close();
	assert.equal(closed.exitReason, "cost-cap");
	assert.equal(closed.exitWhy, "unboundable");
	const plain = makeLogSink({ logsDir: "/logs", enabled: false, fs })("gh-plain");
	plain.write(Buffer.from(exitLine({ code: 2, reason: "cost-cap" })));
	assert.equal(Object.hasOwn(await plain.close(), "exitWhy"), false);
	// Through to the record: the processor's result carries it as `why`, and buildRecord keeps it.
	const record = buildRecord({ job: { id: "gh-1", name: "github", data: { kind: "github" }, attemptsMade: 0 }, result: { outcome: "policy", reason: "cost-cap", why: "unboundable" }, startedAt: null, endedAt: null });
	assert.equal(record.reason, "cost-cap");
	assert.equal(record.why, "unboundable");
});

test("a 16 KB provider error body keeps the exit-2 label: the runner caps the exit line's message before the 8 KiB tail sees it", async () => {
	// Issue #437 review. The runner writes the terminal errorMessage onto the exit line, and the worker
	// reads that line from the LAST 8 KiB of stdout. An HTML 403 page is easily 15 KB; uncapped, the line's
	// head (where `code` and `reason` sit) falls out of the tail and the record says runner-policy. The
	// runner's own capExitMessage is imported here (outcome.mjs has no imports of its own), so this test
	// exercises the function run-job.mjs calls, through the real sink.
	const { capExitMessage, EXIT_MESSAGE_MAX_CHARS } = await import("../../image/runner/src/outcome.mjs");
	assert.equal(EXIT_MESSAGE_MAX_CHARS, 1800, "the literal is pinned here too: this test's margin is measured against it");

	// The rest of the line as run-job.mjs builds it, at its WORST CASE, so the budget is not flattered:
	// the maximal ledger usage-meter.test.mjs builds (8 named rows of 64-character provider and model ids
	// plus the folded "other" row, 8-digit counts everywhere), every tokens key at 8 digits, the context
	// block, the longest session reason, and the longest job-id shape (a cron id). `tokens` holds every TOKEN_KEYS key,
	// the child keys and the policy counters included (issue #571 added one).
	const wide = (prefix, i) => `${prefix}-${i}`.padEnd(64, "x");
	const N = 99_999_999;
	const row = (provider, model) => ({ provider, model, calls: N, input: N, output: N, cacheRead: N, cacheWrite: N, cacheWrite1h: N, reasoning: N, total: N, cost: 99_999.99, unpriced: N });
	const rest = {
		turns: 4096,
		retryTurns: 4096,
		tokens: Object.fromEntries(TOKEN_KEYS.map((key) => [key, key === "metered" ? true : key === "cost" ? 99_999.99 : N])),
		usage: { v: 1, piAi: "88.88.88", truncated: 1, models: [...Array.from({ length: 8 }, (_, i) => row(wide("provider", i), wide("model", i))), row("other", "other")] },
		context: { tokens: N, window: N },
		session: { resumed: false, reason: "resume-chain-too-long" },
		// Issue #596: every resources key at the largest safe integer, the most any one can serialise to.
		resources: Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Number.MAX_SAFE_INTEGER])),
	};
	const jobId = "repeat:very-long-schedule-name:1767225600000";
	// Every keyed line also ends in `,"auth":"<64 hex>"` (signExitLine): a 64-character field stands in for
	// it, because the budget is the SIGNED line's and a test of the unsigned one flattered it by 75 characters.
	const line = (fields) => `\n${JSON.stringify({ event: "exit", jobId, ...fields, ...rest, auth: "f".repeat(64) })}\n`;
	// The longest runner policy reason, so the label measured is the widest one that can head the line.
	const reason = [...RUNNER_POLICY_REASONS].reduce((a, b) => (b.length > a.length ? b : a));

	const drive = async (exitText) => {
		const fs = makeFakeFs({ stream: makeFakeStream() });
		const jobLog = makeLogSink({ logsDir: "/logs", enabled: false, fs })("gh-big");
		jobLog.write(Buffer.from("agent noise\n".repeat(200)));
		// Delivered in 4 KiB chunks, the way a pipe hands stdout over.
		const bytes = Buffer.from(exitText);
		for (let at = 0; at < bytes.length; at += 4096) jobLog.write(bytes.subarray(at, at + 4096));
		return (await jobLog.close()).exitReason;
	};

	// An HTML page, and the body that escapes worst: every control byte serializes to six characters.
	for (const body of [`<html><body>${'<p class="x">Forbidden.</p>\n'.repeat(600)}</body></html>`, "\u0001".repeat(16000)]) {
		const outcome = { code: 2, reason, message: `403 ${body}` };
		assert.ok(outcome.message.length > 16000);
		const capped = line(capExitMessage(outcome));
		// 8 KiB is the tail; the line must stay under 6 KiB of it, so a later field (a ledger column, a new
		// exit-line key) has 2 KiB to grow into before the label is at risk again.
		assert.ok(capped.length <= 6 * 1024, `the worst-case capped exit line is ${capped.length} characters`);
		assert.equal(await drive(capped), reason);
		// The premise, so this test cannot pass for a reason other than the cap: uncapped, the label is lost.
		assert.equal(await drive(line(outcome)), null);
	}
});

test("the record's dollars (#501) is REBUILT from named fields: four keys, integers and a fixed basis, else null", () => {
	const job = { id: "gh-1", name: "github", attemptsMade: 0, data: { kind: "github", repo: "acme/web", target: { number: 7 } } };
	const rec = (dollars) => buildRecord({ job, result: { outcome: "completed", exitCode: 0, dollars } }).dollars;
	assert.deepEqual(rec({ reservedMicros: 2_000_000, settledMicros: 300_001, basis: "metered", modelBasis: "x", leaked: "/Users/rob" }), { reservedMicros: 2_000_000, settledMicros: 300_001, basis: "metered", modelBasis: null });
	for (const basis of ["metered", "floor", "refunded", "unreserved"]) assert.equal(rec({ reservedMicros: 0, settledMicros: 0, basis }).basis, basis);
	// #502 part 6: modelBasis is one of three fixed tokens, else null.
	for (const modelBasis of ["metered", "floor", "refunded"]) assert.equal(rec({ reservedMicros: 1, settledMicros: 1, basis: "floor", modelBasis }).modelBasis, modelBasis);
	assert.equal(rec({ reservedMicros: 1, settledMicros: 1, basis: "floor", modelBasis: "unreserved" }).modelBasis, null);
	for (const bad of [undefined, null, "x", { reservedMicros: 1.5, settledMicros: 0, basis: "floor" }, { reservedMicros: 1, settledMicros: -1, basis: "floor" }, { reservedMicros: 1, settledMicros: 1, basis: "free" }]) assert.equal(rec(bad), null, JSON.stringify(bad));
	assert.equal(buildRecord({ job, error: Object.assign(new Error("x"), { dollars: { reservedMicros: 1, settledMicros: 1, basis: "floor" } }) }).dollars.basis, "floor", "read off a throw too");
	assert.equal(Object.keys(buildRecord({ job, result: { outcome: "completed" } })).at(-9), "dollars", "the tail when it landed; `why`, `project`, `plan`, `resources`, `size`, `hostBudget`, `queuedAt` and `capacity` took it after");
});

test("the record carries the refusal's why: a fixed token, in tail position, else null", () => {
	const job = { id: "gh-1", name: "github", attemptsMade: 0, data: { kind: "github", repo: "acme/web", target: { number: 7 } } };
	const rec = (result) => buildRecord({ job, result });
	const refused = rec({ outcome: "policy", reason: "model-unknown", why: "overlay-link", budgetReserved: false });
	assert.equal(Object.keys(refused).at(-8), "why", "the tail when it landed; `project` (#499), `plan` (#505), `resources`, `size`, `hostBudget` (#596), `queuedAt` and `capacity` (#599) took it after");
	assert.deepEqual([refused.reason, refused.why], ["model-unknown", "overlay-link"]);
	for (const why of ["overlay-not-a-file", "overlay-unreadable", "not-in-catalog", "fallback-unlisted"]) assert.equal(rec({ outcome: "policy", reason: "model-unknown", why }).why, why);
	// Never a free string: the record stays PII-free by construction.
	for (const bad of [undefined, null, 7, "", "Overlay", "/Users/rob/models.json", "a b", "x".repeat(65)]) assert.equal(rec({ outcome: "policy", reason: "model-unknown", why: bad }).why, null, JSON.stringify(bad));
	assert.equal(rec({ outcome: "completed", exitCode: 0 }).why, null, "a run with no refusal detail");
});

test("the record carries the job's project id in tail position after why, charset-checked, never a name (#499)", () => {
	const job = { id: "gh-1", name: "github", attemptsMade: 0, data: { kind: "github", repo: "acme/web", target: { number: 7 } } };
	const rec = (project) => buildRecord({ job, result: { outcome: "completed", exitCode: 0 }, ...(project === undefined ? {} : { project }) });
	const keys = Object.keys(rec("shop"));
	assert.deepEqual(keys.slice(-8, -6), ["why", "project"], "the tail when it landed, after why; `plan` (#505), `resources`, `size`, `hostBudget` (#596), `queuedAt` and `capacity` (#599) took it after");
	assert.equal(rec("shop").project, "shop");
	assert.equal(rec("0-a").project, "0-a");
	assert.equal(rec(undefined).project, null, "no project passed: the key is present and null");
	assert.deepEqual(Object.keys(rec(undefined)), keys, "the key SET does not depend on a project");
	// Only an id: a display name, a path, a forge scope or anything off the charset records null.
	for (const bad of [null, "", "Webshop", "Web Shop", "shop:x", "/srv/shop", "github:acme/web", "x".repeat(33), 7, { id: "shop" }]) {
		assert.equal(rec(bad).project, null, JSON.stringify(bad));
	}
	// buildRecord reads nothing off the job for it: a name riding on job data never reaches the record.
	const named = buildRecord({ job: { ...job, data: { ...job.data, project: "shop", projectName: "Webshop" } }, result: { outcome: "completed" } });
	assert.equal(named.project, null);
	assert.ok(!JSON.stringify(named).includes("Webshop"));
});

test("parseExitCode: the LAST exit line's own integer code, else null; the sink reports it as exitLineCode (#501, PR #542 round 3)", async () => {
	assert.equal(parseExitCode('{"event":"exit","code":2,"reason":"cost-cap"}'), 2);
	assert.equal(parseExitCode('{"event":"exit","code":0}\n{"event":"exit","code":1}'), 1, "the last line wins");
	assert.equal(parseExitCode('{"event":"exit","tokens":{"total":1}}'), null, "no code");
	assert.equal(parseExitCode('{"event":"exit","code":"0"}'), null, "a string is not a code");
	assert.equal(parseExitCode('{"event":"exit","code":1.5}'), null);
	assert.equal(parseExitCode("noise"), null);
	assert.equal(parseExitCode(null), null);
	const openJobLog = makeLogSink({ logsDir: "/logs", enabled: false, fs: makeFakeFs({ stream: makeFakeStream({ emitOn: "finish" }) }) });
	const jobLog = openJobLog("gh-1");
	jobLog.write(Buffer.from('{"event":"exit","code":0,"tokens":{"total":0,"cost":0,"metered":true,"calls":0}}\n'));
	assert.equal((await jobLog.close()).exitLineCode, 0);
});

test("the runner writes the code it exits with on BOTH exit lines (pinned: the settlement compares it with the container's)", () => {
	const src = readFileSync(new URL("../../image/runner/run-job.mjs", import.meta.url), "utf8");
	assert.match(src, /exitWriter\.writeExit\(\{ \.\.\.capExitMessage\(outcome\), \.\.\.costRefusalField\(outcome, costRefusalWhy\(\)\), turns: /, "the decided path spreads the outcome, whose `code` is the exit code");
	assert.match(src, /\n\treturn outcome\.code;\n\}/, "and returns that same code as the process exit code");
	assert.match(src, /exitWriter\.writeExit\(\{ code: capped\.code, reason: capped\.reason, \.\.\.costRefusalField\(outcome, costRefusalWhy\(\)\), message: capped\.message, \.\.\.meteredExitFields\(\) \}\)/, "the catch path writes its code too (and, after the meter installed, its counts: issue #543)");
});

// ---- issue #545: with a key, only the runner's signed exit line is read ----

const EXIT_KEY = "a1".repeat(32);
/** The runner's signing rule, restated here on purpose: the runner-side test checks the two against each other. */
const signLine = (obj, key = EXIT_KEY) => {
	const body = JSON.stringify(obj);
	return `${body.slice(0, -1)},"auth":"${createHmac("sha256", key).update(body).digest("hex")}"}`;
};
const GENUINE = { event: "exit", jobId: "j", code: 0, reason: "completed", turns: 4, tokens: { input: 9, output: 1, total: 10, cost: 1.5, metered: true, calls: 2, unresolved: 0, unpriced: 0 }, session: { resumed: false, reason: "absent" }, context: { tokens: 50, window: 100 } };
const FORGED_LINE = { event: "exit", jobId: "j", code: 0, reason: "completed", turns: 0, tokens: { input: 0, output: 0, total: 0, cost: 0, metered: true, calls: 0, unresolved: 0, unpriced: 0 } };

async function readKeyed(text, opts) {
	const sink = makeLogSink({ logsDir: "/logs", enabled: false, fs: makeFakeFs({ stream: makeFakeStream() }) })("gh-1", opts);
	sink.write(Buffer.from(text));
	return sink.close();
}

test("with a key, a forged line AFTER the genuine one is not read: every exit field comes from the signed line", async () => {
	const out = await readKeyed(`${signLine(GENUINE)}\n${JSON.stringify(FORGED_LINE)}\n`, { exitKey: EXIT_KEY });
	assert.equal(out.exitAuth, "verified");
	assert.equal(out.tokens.total, 10);
	assert.equal(out.tokens.cost, 1.5);
	assert.equal(out.turns, 4);
	assert.equal(out.exitLineCode, 0);
	assert.deepEqual(out.session, { resumed: false, reason: "absent" });
	assert.deepEqual(out.context, { tokens: 50, window: 100 });
});

test("with a key, a forged line signed with a made-up key, or no signed line at all, reads as NO exit line (unverified)", async () => {
	for (const text of [`${JSON.stringify(FORGED_LINE)}\n`, `${signLine(FORGED_LINE, "f".repeat(64))}\n`, "", `${signLine({ ...GENUINE, tokens: { ...GENUINE.tokens } }).replace('"total":10', '"total":1')}\n`]) {
		const out = await readKeyed(text, { exitKey: EXIT_KEY });
		assert.deepEqual(out, { turns: null, tokens: null, session: null, usage: null, context: null, exitReason: null, exitLineCode: null, exitAuth: "unverified" }, JSON.stringify(text));
	}
});

test("without a key the sink reads the whole tail exactly as before: the last line wins and no exitAuth is reported", async () => {
	const out = await readKeyed(`${signLine(GENUINE)}\n${JSON.stringify(FORGED_LINE)}\n`);
	assert.equal("exitAuth" in out, false);
	assert.equal(out.tokens.total, 0, "today's rule, kept for an image that does not sign (the #542 trust rule still applies downstream)");
});

test("authenticExitLines keeps every signed line in order and drops the auth key", () => {
	const second = { ...GENUINE, code: 143, reason: "terminated" };
	const text = `${signLine(GENUINE)}\nnoise\n${signLine(second)}\n`;
	assert.equal(authenticExitLines(text, EXIT_KEY), `${JSON.stringify(GENUINE)}\n${JSON.stringify(second)}`);
	assert.equal(parseExitCode(authenticExitLines(text, EXIT_KEY)), 143);
	assert.equal(authenticExitLines(text, "b2".repeat(32)), "");
});

test("the record module's import graph never reaches config.mjs: the admin loads it inside pi (#499 review)", () => {
	// Static relative imports, followed transitively. model-ref.mjs and project-id.mjs are import-free for this reason:
	// run-history.mjs imports both, and config.mjs would bring its fs, os and child_process reads into the panel.
	const seen = new Set();
	const walk = (url) => {
		if (seen.has(url.href)) return;
		seen.add(url.href);
		const src = readFileSync(url, "utf8");
		for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"/gm)) walk(new URL(m[1], url));
	};
	walk(new URL("../src/run-history.mjs", import.meta.url));
	const names = [...seen].map((h) => h.slice(h.lastIndexOf("/") + 1)).sort();
	assert.ok(names.includes("project-id.mjs"), `the walk reaches the id rule: ${names}`);
	for (const heavy of ["config.mjs", "projects.mjs", "scoped-limits.mjs", "pause-windows.mjs"]) assert.ok(!names.includes(heavy), `${heavy} is not in the record module's graph: ${names}`);
	assert.doesNotMatch(readFileSync(new URL("../src/project-id.mjs", import.meta.url), "utf8"), /^\s*import\s/m, "project-id.mjs imports nothing");
});

test("makeFindPreviousRun counts a hand fire (manual:<id>:<millis>) as a run of its trigger, and a same-minute tie takes the later end (#505)", () => {
	const fs = makeHistoryFs({
		names: ["repeat_pm_100.json", "manual_pm_300.json", "manual_pm_1_200.json", "manual_other_400.json", "repeat_pm_500.json", "manual_pm_500.json"],
		files: {
			"repeat_pm_100.json": '{"endedAt":"2026-10-05T01:00:00.000Z"}',
			"manual_pm_300.json": '{"endedAt":"2026-10-05T03:00:00.000Z"}',
			"manual_pm_1_200.json": '{"endedAt":"WRONG-another-trigger"}',
			"manual_other_400.json": '{"endedAt":"WRONG-another-trigger"}',
			"repeat_pm_500.json": '{"endedAt":"2026-10-05T05:01:00.000Z"}',
			"manual_pm_500.json": '{"endedAt":"2026-10-05T05:09:00.000Z"}',
		},
	});
	const findPreviousRun = makeFindPreviousRun({ logsDir: "/logs", fs });
	assert.equal(findPreviousRun({ schedulerId: "pm", beforeMillis: 400 }), "2026-10-05T03:00:00.000Z", "the hand fire is the previous run");
	assert.equal(findPreviousRun({ schedulerId: "pm", beforeMillis: 600 }), "2026-10-05T05:09:00.000Z", "a tick and a hand fire in one minute: the later end");
	assert.equal(findPreviousRun({ schedulerId: "pm", beforeMillis: 250 }), "2026-10-05T01:00:00.000Z", "manual_pm_1_200 is trigger pm_1's");
});

test("the record carries a collected plan in tail position after project: enums and a hash only, else null (#505)", () => {
	const job = { id: "repeat:pm:1", name: "local", attemptsMade: 0, data: { kind: "local", folder: "/srv/pm", trigger: { id: "pm", pattern: "0 6 * * 1" }, portfolio: true } };
	const rec = (plan) => buildRecord({ job, result: { outcome: "completed", exitCode: 0, ...(plan === undefined ? {} : { plan }) } });
	assert.deepEqual(Object.keys(rec(undefined)).slice(-7, -5), ["project", "plan"], "the tail when it landed; `resources`, `size`, `hostBudget` (#596), `queuedAt` and `capacity` (#599) took it after");
	assert.equal(rec(undefined).plan, null, "no plan file: present and null");
	assert.deepEqual(rec({ outcome: "applied", reason: null, planId: "0123456789abcdef", clamped: true }).plan, { outcome: "applied", reason: null, planId: "0123456789abcdef", clamped: true });
	assert.deepEqual(rec({ outcome: "duplicate", reason: "plan-duplicate", planId: "0123456789abcdef", clamped: false }).plan, { outcome: "duplicate", reason: "plan-duplicate", planId: "0123456789abcdef", clamped: false });
	for (const reason of PLAN_RECORD_REASONS) assert.equal(rec({ outcome: "refused", reason, planId: null, clamped: false }).plan.reason, reason);
	// Rebuilt from named fields: anything else in the source never reaches the record, and a malformed one is null.
	const leaky = rec({ outcome: "refused", reason: "plan-too-soon", planId: "Fix the login bug", clamped: "yes", weights: { shop: 3 }, reasons: { shop: "Fix the login bug" } });
	assert.deepEqual(leaky.plan, { outcome: "refused", reason: "plan-too-soon", planId: null, clamped: false });
	assert.ok(!JSON.stringify(leaky).includes("Fix the"));
	for (const bad of [null, "applied", { outcome: "won" }, { outcome: "refused", reason: "Fix the login bug" }, { outcome: "refused", reason: null }, { outcome: "applied", reason: "plan-stale" }]) assert.equal(rec(bad).plan, null, JSON.stringify(bad));
});

test("PLAN_RECORD_REASONS is the collector's rungs, plan-invalid, envelope-mismatch and the apply ladder, nothing else (#505)", async () => {
	const { PLAN_COLLECT_REASONS } = await import("../src/outbox-plan.mjs");
	const { PLAN_LADDER, PLAN_INVALID } = await import("../src/priorities.mjs");
	const { ENVELOPE_MISMATCH_REASON } = await import("../src/allocation.mjs");
	assert.deepEqual([...PLAN_RECORD_REASONS].sort(), [...new Set([...PLAN_COLLECT_REASONS, PLAN_INVALID, ENVELOPE_MISMATCH_REASON, ...PLAN_LADDER])].sort());
});

// ---- the lost-lock check reads a job's own record back (DES-TERMINAL-COMMENTS-AND-FAILURE-HOOK) ------------

test("makeReadRecord reads back exactly what makeRecordWriter wrote, by the same sanitized name", () => {
	const logsDir = tempDir("pi-read-record-");
	const job = { id: "repeat:nightly:1759572000000", name: "local", attemptsMade: 0, data: { kind: "local", folder: "/srv/proj", flow: "tidy" } };
	const record = buildRecord({ job, result: { outcome: "completed", exitCode: 0, budgetReserved: true }, startedAt: "2026-10-04T10:00:01.000Z", endedAt: "2026-10-04T10:03:00.000Z" });
	makeRecordWriter({ logsDir })(record);
	assert.deepEqual(makeReadRecord({ logsDir })(job.id), record);
	assert.equal(makeReadRecord({ logsDir })("repeat:nightly:1"), null, "another job has no record");
	// `repeat_nightly_1759572000000` sanitizes to the same file name; its record must not answer for it.
	// `repeat_nightly_1759572000000` sanitizes to the same file name: the read returns that file, and the verdict refuses it.
	const collided = makeReadRecord({ logsDir })("repeat_nightly_1759572000000");
	assert.equal(recordVerdict(collided, { jobId: "repeat_nightly_1759572000000", attempt: 1 }), "id-mismatch", "a colliding sanitized name is not this job's record");
});

test("makeReadRecord never throws: no file is null, a file that is not a record is UNREADABLE_RECORD", () => {
	const failing = (code) => ({ readFileSync: () => { throw Object.assign(new Error(code), { code }); } });
	assert.equal(makeReadRecord({ logsDir: "/nope", fs: failing("ENOENT") })("j1"), null, "no file");
	assert.equal(makeReadRecord({ logsDir: "/nope", fs: failing("ENOTDIR") })("j1"), null, "no directory");
	assert.equal(makeReadRecord({ logsDir: "/l", fs: failing("EACCES") })("j1"), UNREADABLE_RECORD, "a file this worker cannot read");
	for (const body of ["{nope", "null", "[1]", "7"]) {
		assert.equal(makeReadRecord({ logsDir: "/l", fs: { readFileSync: () => body } })("j1"), UNREADABLE_RECORD, body);
	}
	assert.equal(makeReadRecord({ logsDir: "/l", fs: { readFileSync: () => "{}" } })(), null, "no id");
	assert.equal(makeReadRecord({ logsDir: "/l", fs: { readFileSync: () => "{}" } })(null), null);
});

const SETTLED = { jobId: "j1", outcome: "completed", attempt: 1, startedAt: "2026-10-04T10:00:01.000Z" };
const SINCE = Date.parse("2026-10-04T10:00:00.000Z");

test("recordSettlesAttempt: this job, this attempt, not failed, started after the job existed", () => {
	const ok = (rec, over = {}) => recordSettlesAttempt(rec, { jobId: "j1", attempt: 1, since: SINCE, ...over });
	assert.equal(ok(SETTLED), true);
	assert.equal(ok({ ...SETTLED, outcome: "policy", reason: "runner-policy" }), true, "a policy stop also finished");
	assert.equal(ok({ ...SETTLED, outcome: "failed" }), false, "a failed record keeps the queue's verdict");
	assert.equal(ok({ ...SETTLED, outcome: null }), false);
	assert.equal(ok(SETTLED, { attempt: 2 }), false, "a record of attempt 1 does not answer for attempt 2");
	assert.equal(ok(SETTLED, { attempt: 0 }), false, "nor the other way");
	assert.equal(ok(SETTLED, { attempt: undefined }), false, "no attempt, no match");
	assert.equal(ok(SETTLED, { jobId: "j2" }), false);
	assert.equal(ok({ ...SETTLED, startedAt: new Date(SINCE - RECORD_CLOCK_SKEW_MS - 1).toISOString() }), false, "a record of an older job under a reused id");
	assert.equal(ok({ ...SETTLED, startedAt: new Date(SINCE - RECORD_CLOCK_SKEW_MS).toISOString() }), true, "a producer clock ahead of the worker's, within the tolerance, still matches");
	assert.equal(RECORD_CLOCK_SKEW_MS, 5 * 60 * 1000);
	assert.equal(ok({ ...SETTLED, startedAt: null }), false, "an undated record is not trusted when the job's age is known");
	assert.equal(ok(SETTLED, { since: undefined }), true, "no creation time: the id and attempt decide");
	assert.equal(ok(null), false);
	assert.equal(ok("j1"), false);
	assert.equal(recordSettlesAttempt(SETTLED), false, "no question, no match");
});

test("recordVerdict names why a record was refused, from a fixed set", () => {
	const v = (rec, over = {}) => recordVerdict(rec, { jobId: "j1", attempt: 1, since: SINCE, ...over });
	assert.equal(v(SETTLED), null);
	assert.equal(v(null), "absent");
	assert.equal(v(undefined), "absent");
	assert.equal(v(UNREADABLE_RECORD), "unreadable");
	assert.equal(v("j1"), "unreadable");
	assert.equal(v([SETTLED]), "unreadable");
	assert.equal(v({ ...SETTLED, jobId: "j2" }), "id-mismatch");
	assert.equal(v(SETTLED, { attempt: 2 }), "other-attempt");
	assert.equal(v({ ...SETTLED, outcome: "failed" }), "failed");
	assert.equal(v({ ...SETTLED, outcome: undefined }), "failed");
	assert.equal(v({ ...SETTLED, startedAt: "2026-10-04T09:00:00.000Z" }), "older-than-job");
	assert.equal(v({ ...SETTLED, startedAt: "garbage" }), "older-than-job");
});

test("makeSettledRecord: the local record first, the mirror only when the local one does not settle the attempt, and never a rejection", async () => {
	const at = { attempt: 1, since: SINCE };
	const mirrorAsked = [];
	const mirror = (rec) => async (id) => (mirrorAsked.push(id), rec);
	assert.deepEqual(await makeSettledRecord({ readRecord: () => SETTLED, readMirrored: mirror(null) })("j1", at), SETTLED);
	assert.deepEqual(mirrorAsked, [], "a local hit asks no mirror");
	assert.deepEqual(await makeSettledRecord({ readRecord: () => null, readMirrored: mirror(SETTLED) })("j1", at), SETTLED, "the host that meets the job need not be the one that ran it");
	assert.deepEqual(
		await makeSettledRecord({ readRecord: () => ({ ...SETTLED, outcome: "failed" }), readMirrored: mirror(SETTLED) })("j1", at),
		SETTLED,
		"this host holds an earlier failed attempt, another host ran the one that finished",
	);
	assert.equal(await makeSettledRecord({ readRecord: () => null, readMirrored: mirror({ ...SETTLED, attempt: 2 }) })("j1", at), null, "the mirror's record is held to the same test");
	assert.equal(await makeSettledRecord({ readRecord: () => null })("j1", at), null, "no mirror armed: a single host");
	assert.equal(await makeSettledRecord({ readRecord: () => null, readMirrored: async () => { throw new Error("ECONNREFUSED"); } })("j1", at), null, "a mirror fault is no record");
	assert.equal(await makeSettledRecord({ readRecord: () => { throw new Error("boom"); } })("j1", at), null, "a reader fault is no record");
});

test("an unreadable MIRROR value is reported as unreadable from mirror, and never accepted", async () => {
	const { readMirroredRecord } = await import("../src/run-mirror.mjs");
	const seen = [];
	const lookup = makeSettledRecord({ readRecord: () => null, readMirrored: (id) => readMirroredRecord({ get: async () => "{garbage" }, id) });
	assert.equal(await lookup("j1", { attempt: 1, since: SINCE, onReject: (reason, source) => seen.push([reason, source]) }), null);
	assert.deepEqual(seen, [["unreadable", "mirror"]]);
});

test("makeSettledRecord reports every record it found and refused, with its source, and never one it did not find", async () => {
	const seen = [];
	const onReject = (reason, source) => seen.push([reason, source]);
	const at = { attempt: 1, since: SINCE, onReject };
	await makeSettledRecord({ readRecord: () => ({ ...SETTLED, attempt: 2 }), readMirrored: async () => UNREADABLE_RECORD })("j1", at);
	assert.deepEqual(seen, [["other-attempt", "local"], ["unreadable", "mirror"]]);
	seen.length = 0;
	await makeSettledRecord({ readRecord: () => null, readMirrored: async () => null })("j1", at);
	assert.deepEqual(seen, [], "absent everywhere is not a refusal");
	assert.deepEqual(await makeSettledRecord({ readRecord: () => ({ ...SETTLED, outcome: "failed" }), readMirrored: async () => SETTLED })("j1", at), SETTLED);
	assert.deepEqual(seen, [["failed", "local"]], "a refused local record is reported even when the mirror then settles it");
	const throwing = makeSettledRecord({ readRecord: () => ({ ...SETTLED, attempt: 9 }) });
	assert.equal(await throwing("j1", { attempt: 1, since: SINCE, onReject: () => { throw new Error("log down"); } }), null, "a throwing reporter changes nothing");
});

// ---------------------------------------------------------------------------------------------
// Issue #596: what the container used, and the supervisor's out-of-memory report
// ---------------------------------------------------------------------------------------------

const FULL = { memPeak: 602259456, swapPeak: 0, oomKills: 1, memSomeUsec: 12, memFullUsec: 3, cpuUsec: 50062, throttledUsec: 0, throttled: 0, pidsPeak: 19 };
const exitWith = (fields) => `noise\n${JSON.stringify({ event: "exit", jobId: "j", code: 0, ...fields })}\n`;

test("RESOURCE_KEYS is the runner's own list, in its order (the worker cannot import the runner at run time)", () => {
	assert.deepEqual([...RESOURCE_KEYS], [...RUNNER_RESOURCE_KEYS]);
});

test("parseExitResources rebuilds the block in key order, drops what the runner never sends, and keeps null as null", () => {
	assert.deepEqual(parseExitResources(exitWith({ resources: FULL })), FULL);
	const shuffled = Object.fromEntries(Object.entries(FULL).reverse());
	assert.deepEqual(Object.keys(parseExitResources(exitWith({ resources: { ...shuffled, path: "/Users/rob", nested: { a: 1 } } }))), [...RESOURCE_KEYS], "explicit literal: no extra key reaches the record");
	const partial = parseExitResources(exitWith({ resources: { memPeak: 5, cpuUsec: null } }));
	assert.equal(partial.memPeak, 5);
	assert.equal(partial.cpuUsec, null, "a key the runner could not read stays null, never zero");
	assert.equal(partial.pidsPeak, null, "an absent key is null too");
});

test("parseExitResources: forged, huge, negative, fractional or string values null the WHOLE block", () => {
	for (const bad of [-1, 1.5, "5", 2 ** 53, 1e21, true, [], {}]) {
		assert.equal(parseExitResources(exitWith({ resources: { ...FULL, memPeak: bad } })), null, JSON.stringify(bad));
	}
	for (const bad of [null, "x", 7, [FULL], { memPeak: null, cpuUsec: null }]) assert.equal(parseExitResources(exitWith({ resources: bad })), null, JSON.stringify(bad));
	assert.equal(parseExitResources(exitWith({})), null, "an older image sends nothing: null");
	assert.equal(parseExitResources(undefined), null);
	assert.equal(parseExitResources(""), null);
});

test("parseExitResources reads the LAST exit line, and repairs a glued one as its siblings do", () => {
	const two = `${exitWith({ resources: { ...FULL, memPeak: 1 } })}${exitWith({ resources: { ...FULL, memPeak: 2 } })}`;
	assert.equal(parseExitResources(two).memPeak, 2);
	const glued = `stray bytes${JSON.stringify({ event: "exit", code: 0, resources: FULL })}\n`;
	assert.deepEqual(parseExitResources(glued), FULL);
	assert.equal(parseExitResources(`${exitWith({ resources: FULL })}${exitWith({})}`), null, "the last line has none, so none: an earlier line is not borrowed");
});

test("parseExitOomKilled: only the supervisor's 137 line saying oom-killed with oomKills above 0", () => {
	const line = (fields) => exitWith({ code: 137, reason: EXIT_OOM_KILLED, signal: "SIGKILL", by: "supervisor", resources: FULL, ...fields });
	assert.equal(EXIT_OOM_KILLED, "oom-killed");
	assert.equal(parseExitOomKilled(line({})), true);
	assert.equal(parseExitOomKilled(line({ by: undefined })), false, "the runner never writes oom-killed: a line without the marker is not the supervisor's");
	assert.equal(parseExitOomKilled(line({ by: "runner" })), false);
	assert.equal(parseExitOomKilled(line({ code: 0 })), false, "a runner that ended on its own code was not killed");
	assert.equal(parseExitOomKilled(line({ code: 143 })), false);
	assert.equal(parseExitOomKilled(line({ reason: "killed" })), false);
	assert.equal(parseExitOomKilled(line({ resources: { ...FULL, oomKills: 0 } })), false, "no kill in the cgroup: not memory");
	assert.equal(parseExitOomKilled(line({ resources: null })), false);
	assert.equal(parseExitOomKilled(line({ resources: { ...FULL, oomKills: -1 } })), false);
	assert.equal(parseExitOomKilled(`${line({})}${exitWith({ code: 0 })}`), false, "the LAST line decides");
	assert.equal(parseExitOomKilled(undefined), false);
});

test("the sink returns resources and the OOM report only when a line carried them, and only from signed lines under a key", async () => {
	const KEY = "ab".repeat(32);
	const sign = (body) => `${body.slice(0, -1)},"auth":"${createHmac("sha256", KEY).update(body, "utf8").digest("hex")}"}`;
	const oomBody = JSON.stringify({ event: "exit", jobId: "j", code: 137, reason: "oom-killed", signal: "SIGKILL", by: "supervisor", resources: FULL });
	const close = async (text, opts) => {
		const fs = makeFakeFs({ stream: makeFakeStream() });
		const jobLog = makeLogSink({ logsDir: "/logs", enabled: false, fs })("j", opts);
		jobLog.write(Buffer.from(text));
		return jobLog.close();
	};
	const signed = await close(`${sign(oomBody)}\n`, { exitKey: KEY });
	assert.deepEqual(signed.resources, FULL);
	assert.equal(signed.exitOomKilled, true);
	assert.equal(signed.exitAuth, "verified");
	const forged = await close(`${oomBody}\n`, { exitKey: KEY });
	assert.equal(forged.exitOomKilled, undefined, "an unsigned line under a key is a tool's, and is not read");
	assert.equal(forged.resources, undefined);
	const plain = await close(exitWith({}));
	assert.deepEqual(Object.keys(plain).includes("resources") || Object.keys(plain).includes("exitOomKilled"), false, "nothing to say: the object is the one it always was");
});

test("a supervisor line AFTER a line the runner wrote is ignored by every scanner: the runner's line decides (#596 review)", async () => {
	// The reviewer's exact scenario: the runner wrote its decided line (code 0, real tokens, usage, session, context,
	// resources), then was SIGKILLed (by a tool, or the kernel), and the supervisor reported the death, signed, as an OOM.
	// Before this rule the worker read the LAST line: the finished run became oom-killed and lost its tokens.
	const KEY = "cd".repeat(32);
	const sign = (o) => {
		const body = JSON.stringify(o);
		return `${body.slice(0, -1)},"auth":"${createHmac("sha256", KEY).update(body, "utf8").digest("hex")}"}`;
	};
	const usage = { v: 1, piAi: "0.80.7", truncated: 0, models: [GOOD_ROW] };
	const runnerLine = { event: "exit", jobId: "j", code: 0, reason: "completed", turns: 4, tokens: { input: 900000, output: 50000, total: 950000, cost: 1.5 }, usage, context: { tokens: 1000, window: 200000 }, session: { resumed: false, reason: "absent" }, resources: { ...FULL, oomKills: 0, memPeak: 100 } };
	const supervisorLine = { event: "exit", jobId: "j", code: 137, reason: "oom-killed", signal: "SIGKILL", by: "supervisor", resources: FULL };
	const tail = `\n${sign(runnerLine)}\n\n${sign(supervisorLine)}\n`;
	const text = authenticExitLines(tail, KEY);
	assert.equal(text.split("\n").length, 2, "both lines are authentic");
	assert.equal(parseExitOomKilled(text), false, "not an OOM: the runner finished");
	assert.equal(parseExitCode(text), 0);
	assert.equal(parseExitTurns(text), 4);
	assert.equal(parseExitTokens(text).total, 950000, "the tokens the runner counted, not none");
	assert.equal(parseExitSession(text).reason, "absent");
	assert.deepEqual(parseExitContext(text), { tokens: 1000, window: 200000 });
	assert.equal(parseExitResources(text).memPeak, 100, "the runner's block, not the supervisor's");
	assert.equal(parseExitReason(`${exitWith({ code: 2, reason: "cost-cap", why: "over-cap" })}${exitWith(supervisorLine)}`), "cost-cap");
	assert.equal(parseExitWhy(`${exitWith({ code: 2, reason: "cost-cap", why: "over-cap" })}${exitWith(supervisorLine)}`), "over-cap");
	assert.deepEqual(parseExitUsage(text), usage, "the usage ledger the dollar settlement reads");
	// Through the real sink, with the key: the result is the runner's line, and no OOM report.
	const fs = makeFakeFs({ stream: makeFakeStream() });
	const jobLog = makeLogSink({ logsDir: "/logs", enabled: false, fs })("j", { exitKey: KEY });
	jobLog.write(Buffer.from(tail));
	const closed = await jobLog.close();
	assert.equal(closed.exitLineCode, 0);
	assert.equal(closed.tokens.total, 950000);
	assert.equal(closed.exitOomKilled, undefined);
	assert.equal(closed.exitAuth, "verified");
	// The supervisor's line alone (the runner was killed before it wrote one) still decides.
	const alone = authenticExitLines(`noise\n${sign(supervisorLine)}\n`, KEY);
	assert.equal(parseExitOomKilled(alone), true);
	assert.equal(parseExitCode(alone), 137);
	assert.deepEqual(parseExitResources(alone), FULL);
	// Two supervisor lines and nothing from the runner: the last one, as before.
	assert.equal(parseExitCode(`${exitWith({ ...supervisorLine, code: 143, reason: "terminated" })}${exitWith(supervisorLine)}`), 137);
	// A runner line AFTER the supervisor's (not a shape the image writes) is simply the last line.
	assert.equal(parseExitCode(`${exitWith(supervisorLine)}${exitWith({ code: 1 })}`), 1);
});

test("the record carries resources at its TAIL, rebuilt, null when the run reported none (#596)", () => {
	const job = { id: "gh-1", name: "github", attemptsMade: 0, data: { kind: "github", repo: "acme/web", target: { number: 7 } } };
	const rec = (source, as = "result") => buildRecord({ job, [as]: source });
	const keys = Object.keys(rec({ outcome: "completed", exitCode: 0 }));
	assert.equal(keys.at(-5), "resources", "the tail when it landed; `size` (#596, phase 1), `hostBudget` (phase 2), `queuedAt` and `capacity` (#599) took it after");
	assert.deepEqual(rec({ outcome: "completed", exitCode: 0, resources: { ...FULL, leaked: "/home/x" } }).resources, FULL);
	assert.equal(rec({ outcome: "completed", exitCode: 0 }).resources, null, "an older image: null, key present");
	assert.equal(rec({ outcome: "completed", resources: { ...FULL, cpuUsec: -5 } }).resources, null, "rebuilt here too, not trusted from the source");
	assert.deepEqual(rec(Object.assign(new Error("x"), { resources: FULL }), "error").resources, FULL, "read off a throw too, so a retried attempt says what it used");
});

test("the record carries the job's size at its TAIL after resources, rebuilt, null when none was passed (#596)", () => {
	const job = { id: "gh-1", name: "github", attemptsMade: 0, data: { kind: "github", repo: "acme/web", target: { number: 7 }, size: { memMiB: 999999, cpuCenti: 1, source: "project" } } };
	const rec = (size) => buildRecord({ job, result: { outcome: "completed", exitCode: 0 }, ...(size === undefined ? {} : { size }) });
	const keys = Object.keys(rec({ memMiB: 2048, cpuCenti: 50, source: "project" }));
	assert.deepEqual(keys.slice(-5, -2), ["resources", "size", "hostBudget"], "the tail when they landed; `queuedAt` and `capacity` (#599) took it after: field order is the serialisation order");
	assert.deepEqual(rec({ memMiB: 2048, cpuCenti: 50, source: "project", leaked: "/home/x" }).size, { memMiB: 2048, cpuCenti: 50, source: "project" });
	assert.equal(rec(undefined).size, null, "a caller that passes no size (a record before the pickup gate): null, key present");
	assert.deepEqual(Object.keys(rec(undefined)), keys, "the key SET does not depend on a size");
	for (const bad of [{ memMiB: 2048, cpuCenti: 50, source: "trigger" }, { memMiB: 2048, cpuCenti: 50 }, { memMiB: 256, cpuCenti: 50, source: "env" }, "4g"]) assert.equal(rec(bad).size, null, JSON.stringify(bad));
	// Never off the job's data: a size a queued job carried is not what the worker gave it.
	assert.equal(rec(undefined).size, null);
});

test("issue #596, phase 2: a never-fits refusal's host budget is REBUILT into the record, integers, off or null, and absent elsewhere", async () => {
	const { recordedHostBudget } = await import("../src/run-history.mjs");
	const job = { id: "j", name: "local", attemptsMade: 0, data: { kind: "local", folder: "/srv/x" } };
	const refused = buildRecord({ job, result: { outcome: "policy", reason: "job-size-exceeds-host", hostBudget: { memMiB: 36864, cpuCenti: 800, hostShare: null, extra: "x" } } });
	assert.deepEqual(refused.hostBudget, { memMiB: 36864, cpuCenti: 800, hostShare: null });
	assert.equal(buildRecord({ job, result: { outcome: "completed" } }).hostBudget, null);
	assert.deepEqual(recordedHostBudget({ memMiB: 1.5, cpuCenti: -1, hostShare: "50" }), { memMiB: null, cpuCenti: null, hostShare: null });
	for (const bad of [null, undefined, [], "x", 7]) assert.equal(recordedHostBudget(bad), null);
	// a dimension switched off is recorded as "off", never as the null that means unknown.
	assert.deepEqual(recordedHostBudget({ memMiB: 32768, cpuCenti: Infinity, hostShare: 50 }), { memMiB: 32768, cpuCenti: "off", hostShare: 50 });
	assert.deepEqual(recordedHostBudget({ memMiB: "off", cpuCenti: null, hostShare: null }), { memMiB: "off", cpuCenti: null, hostShare: null });
	assert.deepEqual(recordedHostBudget({ memMiB: "on", cpuCenti: -Infinity, hostShare: Infinity }), { memMiB: null, cpuCenti: null, hostShare: null }, "only Infinity and the word itself are off");
	const offCpu = buildRecord({ job, result: { outcome: "policy", reason: "job-size-exceeds-host", hostBudget: { memMiB: 36864, cpuCenti: Infinity, hostShare: null } } });
	assert.equal(JSON.parse(JSON.stringify(offCpu)).hostBudget.cpuCenti, "off", "and survives the JSON line");
});

test("the record carries queuedAt and then capacity at its TAIL after hostBudget, explicit literals (#599)", () => {
	const job = { id: "gh-1", name: "github", attemptsMade: 0, timestamp: Date.parse("2026-08-30T11:59:00.000Z"), opts: {}, data: { kind: "github", repo: "acme/web", target: { number: 7 } } };
	const rec = (capacity) => buildRecord({ job, result: { outcome: "completed", exitCode: 0 }, ...(capacity === undefined ? {} : { capacity }) });
	const keys = Object.keys(rec({ slots: 3, memMiB: 8192, cpuCenti: 400, cpus: 8 }));
	assert.deepEqual(keys.slice(-3), ["hostBudget", "queuedAt", "capacity"], "the newest fields take the tail: field order is the serialisation order");
	assert.deepEqual(Object.keys(rec(undefined)), keys, "the key SET does not depend on a capacity");
	assert.equal(rec(undefined).capacity, null, "no capacity passed (a refusal before a slot): null, key present");
	assert.equal(rec(undefined).queuedAt, "2026-08-30T11:59:00.000Z");
	assert.deepEqual(Object.keys(rec({ slots: 3, memMiB: 8192, cpuCenti: 400, cpus: 8, path: "/Users/rob" }).capacity), ["slots", "memMiB", "cpuCenti", "cpus"], "rebuilt: no extra key reaches the record");
});

test("capacity is REBUILT: positive slots and cpus, each budget an integer, off or null (#599)", async () => {
	const { recordedCapacity } = await import("../src/run-history.mjs");
	assert.deepEqual(recordedCapacity({ slots: 3, memMiB: 8192, cpuCenti: 400, cpus: 8 }), { slots: 3, memMiB: 8192, cpuCenti: 400, cpus: 8 });
	assert.deepEqual(recordedCapacity({ slots: 3, memMiB: Infinity, cpuCenti: "off", cpus: 8 }), { slots: 3, memMiB: "off", cpuCenti: "off", cpus: 8 }, "a switched-off dimension is off, as hostBudget writes it");
	assert.deepEqual(recordedCapacity({ slots: 0, memMiB: null, cpuCenti: -1, cpus: 2.5 }), { slots: null, memMiB: null, cpuCenti: null, cpus: null }, "zero slots and a fractional CPU count are unknown, not a fact");
	assert.deepEqual(recordedCapacity({ slots: "3", memMiB: "8192", cpuCenti: undefined, cpus: null }), { slots: null, memMiB: null, cpuCenti: null, cpus: null }, "strings are not counted");
	for (const bad of [null, undefined, 3, "x", [3, 1, 1, 1]]) assert.equal(recordedCapacity(bad), null, JSON.stringify(bad));
	const job = { id: "gh-1", name: "github", attemptsMade: 0, data: { kind: "github", repo: "acme/web", target: { number: 7 } } };
	assert.equal(JSON.parse(JSON.stringify(buildRecord({ job, result: { outcome: "completed" }, capacity: { slots: 2, memMiB: Infinity, cpuCenti: 200, cpus: 4 } }))).capacity.memMiB, "off", "and survives the JSON line");
});

test("queuedAt is when the job became eligible: timestamp plus the delay it was added with (#599)", async () => {
	const { queuedAtOf } = await import("../src/run-history.mjs");
	// The shape BullMQ's job scheduler gives a cron job: stamped when the PREVIOUS run started it, delayed until its slot.
	// The timestamp alone would be a day of waiting for a daily trigger.
	const due = Date.parse("2026-08-31T06:00:00.000Z");
	const created = Date.parse("2026-08-30T06:00:00.250Z");
	const cron = { id: `repeat:daily:${due}`, timestamp: created, opts: { delay: due - created, repeat: { pattern: "0 6 * * *" } }, data: { kind: "local", folder: "/srv/x" } };
	assert.equal(queuedAtOf(cron), "2026-08-31T06:00:00.000Z");
	assert.equal(buildRecord({ job: cron, result: { outcome: "completed" } }).queuedAt, "2026-08-31T06:00:00.000Z");
	// A job added with no delay is eligible when it was added; a negative delay is no delay.
	assert.equal(queuedAtOf({ timestamp: created, opts: {} }), new Date(created).toISOString());
	assert.equal(queuedAtOf({ timestamp: created }), new Date(created).toISOString(), "no opts at all");
	assert.equal(queuedAtOf({ timestamp: created, opts: { delay: -5000 } }), new Date(created).toISOString());
	// Anything that is not a finite, representable instant is null, never a throw.
	for (const bad of [{}, { timestamp: "1" }, { timestamp: NaN }, { timestamp: -1 }, { timestamp: 1.5 }, { timestamp: created, opts: { delay: "5" } }, { timestamp: created, opts: { delay: Infinity } }, { timestamp: 8.64e15, opts: { delay: 1 } }, null, undefined]) {
		assert.equal(queuedAtOf(bad), null, JSON.stringify(bad));
	}
});

test("a job held on run.waitFor records queuedAt null: a wait its trigger asked for is not a wait for capacity (#599)", () => {
	const job = { id: "gh-1", name: "github", attemptsMade: 0, timestamp: Date.parse("2026-08-30T11:00:00.000Z"), opts: { delay: 0 }, data: { kind: "github", repo: "acme/web", target: { number: 7 }, waitFor: [{ after: "2026-08-30T12:00:00Z" }] } };
	assert.equal(buildRecord({ job, result: { outcome: "completed" } }).queuedAt, null);
	assert.equal(buildRecord({ job: { ...job, data: { ...job.data, waitFor: [] } }, result: { outcome: "completed" } }).queuedAt, "2026-08-30T11:00:00.000Z", "an empty list arms nothing");
});

test("a retry records queuedAt null: its wait would include the earlier attempt and its run (#599)", async () => {
	const { queuedAtOf } = await import("../src/run-history.mjs");
	const at = Date.parse("2026-08-30T11:00:00.000Z");
	assert.equal(queuedAtOf({ timestamp: at, attemptsMade: 0, opts: {} }), "2026-08-30T11:00:00.000Z");
	assert.equal(queuedAtOf({ timestamp: at, attemptsMade: 1, opts: {} }), null);
	const job = { id: "gh-1", name: "github", attemptsMade: 2, timestamp: at, opts: { delay: 0 }, data: { kind: "github", repo: "acme/web", target: { number: 7 } } };
	const rec = buildRecord({ job, result: { outcome: "completed" } });
	assert.deepEqual([rec.attempt, rec.queuedAt], [3, null]);
});

test("the refusals before a slot that the capacity report reads are the processor's own reasons (#599)", async () => {
	const { WAIT_REFUSAL_REASONS } = await import("../src/wait-for.mjs");
	const { SIZE_REFUSAL_REASONS } = await import("../src/job-size.mjs");
	const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
	const waits = new Set([...src.matchAll(/refuseWait\("([a-z-]+)"/g)].map((m) => m[1]));
	assert.deepEqual([...WAIT_REFUSAL_REASONS].sort(), [...waits].sort(), "every wait gate refusal, and nothing else");
	const sizes = src.slice(src.indexOf("export const SIZE_REFUSAL_COMMENTS"));
	const sized = [...sizes.slice(0, sizes.indexOf("});")).matchAll(/^\t"([a-z-]+)":/gm)].map((m) => m[1]);
	assert.deepEqual([...SIZE_REFUSAL_REASONS], sized);
});
