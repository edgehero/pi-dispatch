import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFER_BUCKETS, DEFER_BUCKET_WORDS, DEFER_DUE_SENTENCE, DEFER_ENDPOINT_RE, DEFER_FIELDS, DEFER_HOST_RE, DEFER_ID_RE, DEFER_KEY, DEFER_N_RE, DEFER_PROJECT_RE, DEFER_TIME_MAX_MS, DEFER_TTL_SLACK_MS, DEFER_WHYS, DEFER_WHY_RE, DELAYED_SCORE_SHIFT, deferHsetArgs, deferKey, deferTtlMs, dueOfScore, isSchedulerNext, parseDefer } from "../src/defer-reasons.mjs";
import { MODEL_ENDPOINT_ID_RE } from "../src/model-endpoints.mjs";
import { PROJECT_ID_RE } from "../src/project-id.mjs";
import { WORKER_NAME_RE } from "../src/worker-name.mjs";

// Why a job waits (issue #737): the vocabulary the worker writes into `defer:job:<id>` and the rules the console reads
// it by. The console imports this leaf, so its tables are the one source both sides agree on; these tests hold the
// tables closed and the rules hostile-proof.

/** An HMGET reply in DEFER_FIELDS order, from an object. */
const reply = (fields) => DEFER_FIELDS.map((f) => (Object.hasOwn(fields, f) ? fields[f] : null));

const GOOD = { why: "host-slot", at: "1761400000000", until: "1761400005000", project: "shop", host: "build3", holder: "gh-1.r2", endpoint: "lan-ollama", budgetWhy: "budget", trigger: "4", attempt: "2", attempts: "3", n: "0123456789abcdef" };

test("the tables are closed: every reason's bucket is a bucket, every bucket has its words, every placeholder is a field", () => {
	assert.deepEqual(DEFER_BUCKETS, ["slot", "run", "check", "retry", "pause", "ready", "paused", "due", "unknown", "none"]);
	assert.deepEqual(Object.keys(DEFER_BUCKET_WORDS), DEFER_BUCKETS, "words for every bucket, in the buckets' order");
	for (const [bucket, words] of Object.entries(DEFER_BUCKET_WORDS)) {
		assert.ok(typeof words.title === "string" && words.title.length > 0 && typeof words.short === "string" && words.short.length > 0, bucket);
		assert.ok(Object.isFrozen(words), `${bucket}'s words are frozen`);
	}
	const shown = new Set(DEFER_FIELDS.filter((f) => f !== "n"));
	for (const [why, entry] of Object.entries(DEFER_WHYS)) {
		assert.match(why, DEFER_WHY_RE, `${why} passes the reason charset, so a reader takes it as a reason`);
		assert.ok(DEFER_BUCKETS.includes(entry.bucket), `${why}'s bucket ${entry.bucket} is a bucket`);
		assert.ok(!["paused", "due", "unknown", "none"].includes(entry.bucket), `${why}: paused, due, unknown and none are the reader's own (a paused list, a due time passed, a reason not in the table, no record), never written`);
		assert.ok(Object.isFrozen(entry), `${why} is frozen`);
		for (const [, name] of entry.sentence.matchAll(/\{([^}]*)\}/g)) assert.ok(shown.has(name), `${why}'s {${name}} is a field the record carries`);
		assert.doesNotMatch(entry.sentence, /[\u0000-\u001f\u007f\u2014]/, `${why}'s sentence has no control byte and no em dash`);
	}
	for (const table of [DEFER_BUCKETS, DEFER_BUCKET_WORDS, DEFER_WHYS, DEFER_FIELDS]) assert.ok(Object.isFrozen(table));
	// Every bucket a console groups by is reached by a written reason, except the four the reader assigns itself.
	const written = new Set(Object.values(DEFER_WHYS).map((e) => e.bucket));
	assert.deepEqual(DEFER_BUCKETS.filter((b) => !written.has(b)), ["paused", "due", "unknown", "none"]);
	// A reason the console does not know is a bucket apart from no record: each title must be true of every job in it.
	assert.deepEqual(DEFER_BUCKET_WORDS.unknown, { title: "A reason this console does not know", short: "Unknown reason" });
	assert.equal(DEFER_BUCKETS.indexOf("unknown"), DEFER_BUCKETS.indexOf("none") - 1, "shown just before the jobs with no reason");
	// The due bucket's line names the one value it needs, and no record field: the reader judges it, no worker writes it.
	assert.deepEqual([...DEFER_DUE_SENTENCE.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]), ["due"]);
	assert.doesNotMatch(DEFER_DUE_SENTENCE, /[\u0000-\u001f\u007f\u2014]/);
	assert.equal(DEFER_FIELDS.at(-1), "n", "the nonce is the last field, never shown");
	assert.equal(new Set(DEFER_FIELDS).size, DEFER_FIELDS.length);
});

test("the leaf imports nothing, so the console's bundle takes it without the worker's dependencies", () => {
	const src = readFileSync(new URL("../src/defer-reasons.mjs", import.meta.url), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/[^\n]*/g, "");
	assert.doesNotMatch(src, /^\s*import\b/m);
	assert.doesNotMatch(src, /\bimport\s*\(/);
	assert.doesNotMatch(src, /\brequire\s*\(/);
	assert.equal(DEFER_KEY, "defer:job:");
	assert.equal(deferKey("repeat:nightly:1761400000000"), "defer:job:repeat:nightly:1761400000000");
});

test("the four copied rules are their sources' rules, byte for byte", async () => {
	// The leaf imports nothing, so it carries copies; the test imports the sources, so a source that changes its rule
	// fails here rather than leaving the console to accept what the worker refuses (or the other way round).
	const { RUN_ID_RE } = await import("../../admin/src/read-model.mjs");
	for (const [name, copy, source] of [
		["DEFER_ID_RE", DEFER_ID_RE, RUN_ID_RE],
		["DEFER_PROJECT_RE", DEFER_PROJECT_RE, PROJECT_ID_RE],
		["DEFER_HOST_RE", DEFER_HOST_RE, WORKER_NAME_RE],
		["DEFER_ENDPOINT_RE", DEFER_ENDPOINT_RE, MODEL_ENDPOINT_ID_RE],
	]) {
		assert.ok(source instanceof RegExp, `${name}'s source exists`);
		assert.equal(copy.source, source.source, name);
		assert.equal(copy.flags, source.flags, name);
	}
});

test("parseDefer reads a whole record, never returns the nonce, and reads no record as null", () => {
	assert.deepEqual(parseDefer(reply(GOOD)), { why: "host-slot", known: true, bucket: "slot", at: 1761400000000, until: 1761400005000, project: "shop", host: "build3", holder: "gh-1.r2", endpoint: "lan-ollama", budgetWhy: "budget", trigger: 4, attempt: 2, attempts: 3 });
	for (const none of [null, undefined, "why", {}, 7]) assert.equal(parseDefer(none), null, `not an HMGET reply: ${JSON.stringify(none)}`);
	for (const why of [null, undefined, ""]) assert.equal(parseDefer(reply({ ...GOOD, why })), null, `no why: ${JSON.stringify(why)}`);
	assert.equal(parseDefer([]), null);
	assert.equal(Object.hasOwn(parseDefer(reply(GOOD)), "n"), false);
	// Extra entries (a newer reader asking for more) are ignored, missing ones read as absent.
	assert.equal(parseDefer([...reply(GOOD), "extra"]).why, "host-slot");
	assert.deepEqual(parseDefer(["retry"]), { why: "retry", known: true, bucket: "retry", at: null, until: null, project: null, host: null, holder: null, endpoint: null, budgetWhy: null, trigger: null, attempt: null, attempts: null });
});

test("parseDefer refuses every hostile value field by field, and an unknown reason reads as unknown, never as a known one", () => {
	// The hash lives in a Valkey anything with its URL can write.
	const unknown = parseDefer(reply({ ...GOOD, why: "quota-exhausted" }));
	assert.deepEqual([unknown.why, unknown.known, unknown.bucket], ["quota-exhausted", false, "unknown"], "a newer worker's reason: shown as a token, in the bucket of reasons this console does not know");
	assert.equal(unknown.project, "shop", "the other fields are still read");
	const proto = parseDefer(reply({ ...GOOD, why: "constructor" }));
	assert.deepEqual([proto.why, proto.known, proto.bucket], ["constructor", false, "unknown"], "a prototype name that passes the charset is never a table entry");
	for (const why of ["__proto__", "toString", "hasOwnProperty", "Host-slot", "host slot", "host-slot\n", "-host", "1slot", "a".repeat(33), "host_slot", "<b>x</b>", 7, true]) {
		const r = parseDefer(reply({ ...GOOD, why }));
		assert.deepEqual([r.why, r.known, r.bucket], [null, false, "none"], `outside the charset: ${JSON.stringify(why)}`);
		assert.equal(r.project, "shop", "the other fields are still read");
	}
	const bad = {
		at: ["-1", "1e3", "01", " 5", "5 ", "0x10", "Infinity", "NaN", "9007199254740993", "12345678901234567", "1.5", "", "five"],
		until: ["-5", "1e12", "007"],
		trigger: ["10000", "-1", "4.0", "x"],
		attempt: ["0", "1001", "-2", "2.5"],
		attempts: ["0", "1001"],
		project: ["Shop", "-shop", "a".repeat(33), "shop/web", "shop\u0000"],
		host: [".build3", "-x", "a".repeat(65), "build 3", "build3\n"],
		holder: ["gh 1", "a".repeat(201), "gh/1", "", "<script>"],
		endpoint: ["LAN", "a".repeat(33), "lan.ollama", "lan_ollama"],
		budgetWhy: ["Budget", "a".repeat(33), "budget!"],
	};
	for (const [field, values] of Object.entries(bad)) {
		for (const value of values) assert.equal(parseDefer(reply({ ...GOOD, [field]: value }))[field], null, `${field} ${JSON.stringify(value)}`);
	}
	// The bounds themselves are taken.
	const edges = parseDefer(reply({ ...GOOD, at: "0", trigger: "0", attempt: "1", attempts: "1000", holder: "a".repeat(200), project: "a".repeat(32), host: "A".repeat(64), endpoint: "a".repeat(32) }));
	assert.deepEqual([edges.at, edges.trigger, edges.attempt, edges.attempts], [0, 0, 1, 1000]);
	assert.equal(parseDefer(reply({ ...GOOD, trigger: "9999" })).trigger, 9999);
	// An instant is one a console can draw as a date: up to the last millisecond a four-digit year writes; one past is none.
	assert.equal(DEFER_TIME_MAX_MS, 253402300799999);
	assert.equal(new Date(DEFER_TIME_MAX_MS).toISOString(), "9999-12-31T23:59:59.999Z");
	assert.equal(new Date(DEFER_TIME_MAX_MS + 1).toISOString(), "+010000-01-01T00:00:00.000Z", "the next instant's year is six digits with a sign");
	const last = parseDefer(reply({ ...GOOD, at: "253402300799999", until: "253402300799999" }));
	assert.deepEqual([last.at, last.until], [DEFER_TIME_MAX_MS, DEFER_TIME_MAX_MS]);
	// A Date holds instants up to 8.64e15 ms, in the year 275760, and none of those past the edge is taken.
	for (const field of ["at", "until"]) for (const value of ["253402300800000", "8640000000000000", "9007199254740991"]) assert.equal(parseDefer(reply({ ...GOOD, [field]: value }))[field], null, `${field} ${value}`);
	assert.deepEqual(deferHsetArgs({ why: "retry", at: DEFER_TIME_MAX_MS, until: DEFER_TIME_MAX_MS }), ["why", "retry", "at", "253402300799999", "until", "253402300799999"], "the writer writes the edge");
	assert.deepEqual(deferHsetArgs({ why: "retry", at: DEFER_TIME_MAX_MS + 1, until: 8.64e15 }), ["why", "retry"], "and leaves out an instant past it");
	// Every instant the leaf takes is written with a four-digit year, the form a console draws (`YYYY-MM-DD HH:MM`).
	for (const ms of [0, 1761400000000, DEFER_TIME_MAX_MS - 1, DEFER_TIME_MAX_MS]) assert.match(new Date(ms).toISOString(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, String(ms));
});

test("deferHsetArgs writes every passing field in the readers' order, leaves out every failing one, and throws on a reason outside the table", () => {
	const args = deferHsetArgs({ why: "endpoint", at: 1761400000000, until: 1761400007000, project: "shop", host: "mini1", endpoint: "lan-ollama", trigger: 0, n: "0123456789abcdef" });
	assert.deepEqual(args, ["why", "endpoint", "at", "1761400000000", "until", "1761400007000", "project", "shop", "host", "mini1", "endpoint", "lan-ollama", "trigger", "0", "n", "0123456789abcdef"]);
	// Round trip: what the writer writes, the reader reads.
	const written = Object.fromEntries(args.reduce((pairs, v, i) => (i % 2 ? pairs : [...pairs, [v, args[i + 1]]]), []));
	assert.deepEqual(parseDefer(reply(written)), { why: "endpoint", known: true, bucket: "slot", at: 1761400000000, until: 1761400007000, project: "shop", host: "mini1", holder: null, endpoint: "lan-ollama", budgetWhy: null, trigger: 0, attempt: null, attempts: null });
	// A wrong field is left out rather than failing the record, or trusted.
	assert.deepEqual(deferHsetArgs({ why: "host-slot", at: 1.5, until: "soon", project: "Shop", host: "", holder: "a b", trigger: 1.5, attempt: 0, n: "xyz" }), ["why", "host-slot"]);
	for (const why of ["nope", "", null, undefined, "constructor", 7]) assert.throws(() => deferHsetArgs({ why }), RangeError, `${JSON.stringify(why)} is a programming error`);
	assert.throws(() => deferHsetArgs(null), RangeError);
	assert.match("0123456789abcdef", DEFER_N_RE);
	assert.doesNotMatch("0123456789ABCDEF", DEFER_N_RE);
});

test("a record lives until its job is due plus a minute's slack, and never less than the slack", () => {
	assert.equal(DEFER_TTL_SLACK_MS, 60_000);
	assert.equal(deferTtlMs(1_000_000 + 5_000, 1_000_000), 65_000);
	assert.equal(deferTtlMs(1_000_000, 1_000_000), 60_000);
	assert.equal(deferTtlMs(1_000_000 - 30_000, 1_000_000), 60_000, "a due time already past still leaves the slack");
});

test("dueOfScore decodes BullMQ's delayed score (due * 4096 + a counter), and refuses anything else", () => {
	assert.equal(DELAYED_SCORE_SHIFT, 4096);
	const due = 1761400005000;
	assert.equal(dueOfScore(due * 4096), due);
	assert.equal(dueOfScore(due * 4096 + 4095), due, "the counter never reaches the next millisecond");
	assert.equal(dueOfScore(String(due * 4096 + 17)), due, "a ZSCORE reply is a string");
	assert.equal(dueOfScore("0"), 0);
	assert.equal(dueOfScore("7.214592020480000e+15"), 1761375005000, "a score in exponent form");
	// A ZSCORE of a missing member is null: no due time, never one at the epoch (Number(null) is 0).
	for (const bad of [null, "", "  ", false, true, [4096], "-4096", "x", undefined, "Infinity", {}, Number.NaN, -1]) assert.equal(dueOfScore(bad), null, JSON.stringify(bad));
	// A score anything with the URL wrote can be any double: a due time a console cannot draw is none, never a huge number.
	assert.equal(dueOfScore(DEFER_TIME_MAX_MS * 4096), DEFER_TIME_MAX_MS, "the last instant a four-digit year writes");
	assert.equal(dueOfScore(String(DEFER_TIME_MAX_MS * 4096)), DEFER_TIME_MAX_MS, "as a ZSCORE reply spells it");
	for (const huge of [(DEFER_TIME_MAX_MS + 1) * 4096, String((DEFER_TIME_MAX_MS + 1) * 4096), 8.64e15 * 4096, "1e300", 1e300, Number.MAX_VALUE, "1.7976931348623157e308"]) assert.equal(dueOfScore(huge), null, String(huge));
});

test("isSchedulerNext is true only for the scheduler's CURRENT next run, never for a gate-deferred repeat: job", () => {
	// BullMQ names a scheduler's run `repeat:<key>:<next>`, `<next>` its score in the repeat zset (isJobSchedulerJob.lua).
	assert.equal(isSchedulerNext("repeat:nightly:1761400000000", "nightly", "1761400000000"), true);
	assert.equal(isSchedulerNext("repeat:nightly:1761400000000", "nightly", 1761400000000), true, "a numeric score");
	// The scheduler minted its successor at this run's pickup, so a deferred earlier run is a real run, in line.
	assert.equal(isSchedulerNext("repeat:nightly:1761400000000", "nightly", "1761486400000"), false);
	assert.equal(isSchedulerNext("repeat:nightly:1761400000000", "other", "1761400000000"), false);
	// Each id is the one the case would match if its own guard were gone (`repeat::<next>`, `repeat:nightly:NaN`,
	// `repeat:nightly:`, ...), so only the guard can answer false: an id that matched nothing would pass without it.
	for (const [rjk, next] of [["", "1761400000000"], [null, "1"], [undefined, "1"], ["nightly", ""], ["nightly", null], ["nightly", undefined], ["nightly", Number.NaN], ["nightly", Number.POSITIVE_INFINITY], ["nightly", Number.NEGATIVE_INFINITY], ["nightly", {}]]) {
		assert.equal(isSchedulerNext(`repeat:${rjk}:${next}`, rjk, next), false, `rjk=${String(rjk)} next=${String(next)}`);
	}
	assert.equal(isSchedulerNext(null, "nightly", "1"), false);
	assert.equal(isSchedulerNext("gh-1", "nightly", "1"), false);
});

// --- the spec's hand-written copies of the leaf's tables ------------------------------------------------------------
//
// `INT-DEFER-REASON-KEY` restates three of the leaf's lists by hand: the reason table (each reason with its bucket), the
// fields block (DEFER_FIELDS, in the readers' order) and the bucket list (DEFER_BUCKETS, in a console's order), with
// the buckets no reason reaches. Each is read as the spec has it and held two-way to the leaf, so a reason, a field or a
// bucket added, dropped or moved on either side fails here until the other says the same. Every needle throws when it is
// gone, so the test cannot pass on nothing. What it does not read: the gate column (prose about the processor) and any
// sentence outside these four places.

const SPEC_URL = new URL("../../specs/interfaces.md", import.meta.url);

/** The lines of `INT-DEFER-REASON-KEY`, from its heading to the next `## ` heading. */
function deferSpecLines(spec) {
	const lines = spec.split("\n");
	const from = lines.indexOf("## INT-DEFER-REASON-KEY");
	if (from < 0) throw new Error("specs/interfaces.md has no INT-DEFER-REASON-KEY section");
	const to = lines.findIndex((line, i) => i > from && line.startsWith("## "));
	return lines.slice(from + 1, to < 0 ? lines.length : to);
}

/**
 * The fields block: the section's first fenced block, whose first line names the key and whose every other line is a
 * field (four spaces, the name, its description) or a wrapped description (indented deeper). Any other line throws,
 * so a field written some other way is never silently dropped.
 */
function specFields(lines) {
	const open = lines.indexOf("```");
	if (open < 0) throw new Error("INT-DEFER-REASON-KEY has no fields block");
	const close = lines.indexOf("```", open + 1);
	if (close < 0) throw new Error("INT-DEFER-REASON-KEY's fields block is not closed");
	const [keyLine, ...rest] = lines.slice(open + 1, close);
	const fields = [];
	for (const line of rest) {
		const field = /^ {4}([A-Za-z]+) {2,}\S/.exec(line);
		if (field) fields.push(field[1]);
		else if (!/^ {5,}\S/.test(line)) throw new Error(`a line of the fields block that is neither a field nor a wrapped description: ${JSON.stringify(line)}`);
	}
	return { keyLine, fields };
}

/**
 * The reason table, `| Reason | Bucket | The gate |`: each row's reasons (one or more, each in backticks, separated by
 * ", ", as the `scope-folder`, `scope-repo` row has two) and its bucket. A first cell with anything else in it throws.
 */
function specReasonRows(lines) {
	const at = lines.findIndex((line) => line.trim() === "| Reason | Bucket | The gate |");
	if (at < 0) throw new Error("INT-DEFER-REASON-KEY has no reason table");
	if (lines[at + 1]?.trim() !== "|---|---|---|") throw new Error("the reason table's header is not followed by its rule line");
	const rows = [];
	for (const line of lines.slice(at + 2)) {
		const row = line.trim();
		if (!row.startsWith("|")) break;
		const cells = row.slice(1, -1).split("|").map((cell) => cell.trim());
		if (cells.length !== 3) throw new Error(`a reason row without exactly three cells: ${JSON.stringify(row)}`);
		const [first, bucket] = cells;
		const whys = [...first.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
		if (whys.length === 0 || first !== whys.map((why) => `\`${why}\``).join(", ")) throw new Error(`a reason cell that is not backticked reasons separated by commas: ${JSON.stringify(first)}`);
		rows.push({ whys, bucket });
	}
	if (rows.length === 0) throw new Error("the reason table has no rows");
	return rows;
}

/** The backticked words of a list the spec writes as "`a`, `b` and `c`" (or "`a` or `b`", or "`a`"): null when it is not one. */
function listWords(text, last) {
	const m = new RegExp(`^(?:((?:\`[a-z-]+\`, )*\`[a-z-]+\`) ${last} )?\`([a-z-]+)\`$`).exec(text);
	if (!m) return null;
	return [...(m[1] ?? "").matchAll(/`([a-z-]+)`/g)].map((w) => w[1]).concat(m[2]);
}

test("INT-DEFER-REASON-KEY restates the leaf: its reason table is DEFER_WHYS with each bucket, its fields block DEFER_FIELDS, its bucket lists DEFER_BUCKETS", () => {
	const lines = deferSpecLines(readFileSync(SPEC_URL, "utf8"));

	const { keyLine, fields } = specFields(lines);
	assert.ok(keyLine.trimStart().startsWith(`${DEFER_KEY}<jobId> `), `the fields block opens with the key, ${DEFER_KEY}<jobId>`);
	assert.deepEqual(fields, [...DEFER_FIELDS], "the fields block names DEFER_FIELDS, in the readers' HMGET order");

	// The table's rows follow the gates, not the leaf's order, so its order is not held: every reason once, and its bucket.
	const rows = specReasonRows(lines);
	const named = rows.flatMap((row) => row.whys);
	assert.equal(new Set(named).size, named.length, "each reason in one row only");
	assert.deepEqual([...named].sort(), Object.keys(DEFER_WHYS).sort(), "the table names every reason of DEFER_WHYS, and nothing else");
	for (const { whys, bucket } of rows) for (const why of whys) assert.equal(bucket, DEFER_WHYS[why]?.bucket, `${why}'s bucket`);

	const text = lines.join("\n").replace(/\s+/g, " ");
	const order = /The buckets are `DEFER_BUCKETS`, in the order a console shows them: (.*?), each with a title and a short form/.exec(text);
	assert.ok(order, "the section lists the buckets in a console's order");
	assert.deepEqual(listWords(order[1], "and"), [...DEFER_BUCKETS], "the bucket list is DEFER_BUCKETS, in its order");
	// The buckets no reason reaches are the reader's own, and the spec names them: the same set, in the buckets' order.
	const unreached = /No reason is (.*?): a reader gives/.exec(text);
	assert.ok(unreached, "the section names the buckets no reason reaches");
	const written = new Set(Object.values(DEFER_WHYS).map((entry) => entry.bucket));
	assert.deepEqual(listWords(unreached[1], "or"), DEFER_BUCKETS.filter((bucket) => !written.has(bucket)), "the buckets no reason is in, as the spec names them");
});

test("budget deferrals preserve each limiting dimension and the legacy verdict during a rolling upgrade (#748)", () => {
	for (const budgetWhy of ["memory", "cpu", "count", "share", "running-here", "unseeded", "budget"]) {
		const args = deferHsetArgs({ ...GOOD, why: "host-budget", budgetWhy });
		const fields = {};
		for (let i = 0; i < args.length; i += 2) fields[args[i]] = args[i + 1];
		const parsed = parseDefer(reply(fields));
		assert.equal(parsed.budgetWhy, budgetWhy);
		assert.equal(parsed.bucket, "slot");
	}
});
