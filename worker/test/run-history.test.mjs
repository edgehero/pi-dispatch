import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { test } from "node:test";
import { buildRecord, makeFindPreviousRun, makeLogReaper, makeLogSink, makeRecordWriter, parseExitContext, parseExitSession, parseExitTokens, parseExitTurns, parseExitUsage, sanitizeJobId } from "../src/run-history.mjs";
import { FORGE_KINDS } from "../src/forges.mjs";

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
];

test("parseExitTurns never throws across the full corpus", () => {
	for (const input of HOSTILE_CORPUS) {
		assert.doesNotThrow(() => parseExitTurns(input), `input=${JSON.stringify(input)}`);
	}
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
	for (const input of ['{"event":"exit","context":{"tokens":1,"window":10}}', '{"event":"exi', "", undefined, null, 42, "null"]) {
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
});

test("parseExitUsage numerics: absent rebuilds as 0, but a negative, a null, or an Infinity nulls the block", () => {
	// Absent is an honest zero and the 12-key row shape stays stable regardless of what was emitted.
	const bare = parseExitUsage(usageLine({ v: 1, models: [{ provider: "a", model: "m" }] }));
	assert.deepEqual(bare, { v: 1, piAi: null, truncated: 0, models: [{ provider: "a", model: "m", calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 0, cost: 0, unpriced: 0 }] });
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
		assert.match(row.provider, /^[a-z0-9][a-z0-9._:/-]{0,63}$/, "every stored ledger id passed the allowlist");
		assert.match(row.model, /^[a-z0-9][a-z0-9._:/-]{0,63}$/);
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
	assert.equal(record.attempt, 0);
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
	assert.equal(record.attempt, 0); // attemptsMade absent -> 0

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
	assert.equal(record.attempt, 1);
	assert.equal(record.turns, null);
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
