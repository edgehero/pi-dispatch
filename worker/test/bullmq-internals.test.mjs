import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BULLMQ_VERIFIED_VERSION,
	BULL_PREFIX,
	DELAYED_SCORE_SHIFT,
	JOB_FIELD,
	MANUAL_JOB_PREFIX,
	META_FIELD,
	QUEUE_KEY,
	SCHEDULER_ID_MAX,
	SCHEDULER_ID_RE,
	SCHEDULER_JOB_ID_OVERHEAD,
	SCHEDULER_JOB_PREFIX,
	SCORE_DUE_MAX_MS,
	SLOT_DIGITS_MAX,
	cronRunOf,
	cronRunPrefixes,
	customJobIdAllowed,
	dueOfScore,
	isPausedFlag,
	isSchedulerJobId,
	isSchedulerNext,
	jobKeyOf,
	metaKeyPattern,
	metaVersionOf,
	queueKey,
	queueKeyOf,
	queueNameOfMetaKey,
	scheduledForMillis,
	schedulerJobId,
} from "../src/bullmq-internals.mjs";
import { DEFER_TIME_MAX_MS } from "../src/defer-reasons.mjs";
import { manualCanaryJobId, manualTriggerJobId } from "../src/job-id.mjs";
import { CRON_ID_MAX, parseTriggers } from "../src/triggers.mjs";

// BullMQ's internals live in one leaf (issue #761). These tests hold that leaf to the installed BullMQ's own text, hold
// every pin of bullmq and its two runtime dependencies to one another, hold the cron run grammar both ways, and refuse a
// second spelling of any of it in the source trees. The real-Valkey half is bullmq-internals.integration.test.mjs.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_PATH = "worker/src/bullmq-internals.mjs";
const read = (path) => readFileSync(join(REPO_ROOT, path), "utf8");

/** Code without comments, each comment's line breaks kept so a hit names its real line. */
function stripComments(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, "")).replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

// The installed bullmq, for the text pins: skipped where it is not installed (below the node floor), required in CI.
let BULLMQ_ROOT = null;
try {
	BULLMQ_ROOT = dirname(createRequire(import.meta.url).resolve("bullmq/package.json"));
} catch (error) {
	if (process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error(`the BullMQ text pins are REQUIRED here but bullmq is not installed.\n${error}`);
}
const skip = BULLMQ_ROOT ? false : `bullmq not installed (node ${process.version}); CI runs these`;
const bullmqFile = (path) => readFileSync(join(BULLMQ_ROOT, "dist/esm", path), "utf8");

test("the module is a leaf: no import, no require, and no string naming the library", () => {
	const code = stripComments(read(MODULE_PATH));
	assert.doesNotMatch(code, /^\s*import\b/m);
	assert.doesNotMatch(code, /\bimport\s*\(/);
	assert.doesNotMatch(code, /\brequire\s*\(/);
	assert.doesNotMatch(code, /\bfrom\s*["'`]/);
	// valkey-clients.test.mjs allows a quoted library name only where its classes are built; `"bullmq:"` is not one.
	assert.doesNotMatch(code, /["'`]bullmq(?:\/[^"'`]*)?["'`]/);
	assert.ok(JSON.parse(read("worker/package.json")).exports["./bullmq-internals"] === "./src/bullmq-internals.mjs", "published as a subpath, so the receiver and the console import it");
});

test("the installed BullMQ's text says what the module says (a bump that moves one fails here)", { skip }, () => {
	// The delayed score (getDelayedScore.lua), and the scheduler's next run test it is read against.
	assert.ok(bullmqFile("commands/includes/getDelayedScore.lua").includes("local minScore = delayedTimestamp * 0x1000"), "getDelayedScore.lua: due * 0x1000");
	assert.equal(0x1000, DELAYED_SCORE_SHIFT);
	// The scheduler's run id, minted in Lua and in JavaScript, and BullMQ's own test of the scheduler's next run.
	assert.equal(`${SCHEDULER_JOB_PREFIX}:`, "repeat:");
	assert.ok(bullmqFile("commands/addJobScheduler-11.lua").includes('local jobId = "repeat:" .. jobSchedulerId .. ":" .. nextMillis'), "addJobScheduler-11.lua");
	assert.ok(bullmqFile("classes/job-scheduler.js").includes("return `repeat:${jobSchedulerId}:${nextMillis}`;"), "job-scheduler.js getSchedulerNextJobId");
	const isNext = bullmqFile("commands/includes/isJobSchedulerJob.lua");
	assert.ok(isNext.includes('local repeatJobKey = rcall("HGET", jobKey, "rjk")'), "isJobSchedulerJob.lua reads the job's rjk");
	assert.ok(isNext.includes('local currentDelayedJobId = "repeat:" .. repeatJobKey .. ":" .. prevMillis'), "isJobSchedulerJob.lua builds the next run's id");
	// The two custom id rules, and the job hash fields fromJSON reads.
	const job = bullmqFile("classes/job.js");
	assert.ok(job.includes("throw new Error('Custom Id cannot be integers');"), "job.js: the integer rule");
	assert.ok(job.includes("if (`${parseInt(this.opts.jobId, 10)}` === "), "job.js: an integer's own spelling");
	assert.ok(job.includes(".split(':').length) !== 3) {"), "job.js: three parts on ':'");
	assert.ok(job.includes("throw new Error('Custom Id cannot contain :');"), "job.js: the colon rule");
	for (const line of ["const data = JSON.parse(json.data || '{}');", "const job = new this(queue, json.name, data, opts, json.id || jobId);", "job.timestamp = parseInt(json.timestamp);", "job.repeatJobKey = json.rjk;", "job.deduplicationId = json.deid;", "job.attemptsMade = parseInt(json.attemptsMade || json.atm || '0');", "job.stalledCounter = parseInt(json.stc || '0');"]) {
		assert.ok(job.includes(line), `job.js fromJSON: ${line}`);
	}
	assert.deepEqual(Object.values(JOB_FIELD).sort(), ["atm", "attemptsMade", "data", "deid", "name", "rjk", "stc", "timestamp"]);
	// The keys: `${prefix}:${name}:${type}`, prefix `bull`, and every key type the module names is one getKeys lists.
	const keys = bullmqFile("classes/queue-keys.js");
	assert.ok(keys.includes("constructor(prefix = 'bull') {"), "queue-keys.js: the default prefix");
	assert.equal(BULL_PREFIX, "bull");
	assert.ok(keys.includes("return `${this.getQueueQualifiedName(name)}:${type}`;"), "queue-keys.js toKey");
	assert.ok(keys.includes("return `${this.prefix}:${name}`;"), "queue-keys.js getQueueQualifiedName");
	for (const type of Object.values(QUEUE_KEY)) assert.match(keys, new RegExp(`^\\s+'${type}',`, "m"), `queue-keys.js getKeys lists '${type}'`);
	assert.ok(bullmqFile("classes/queue-base.js").includes("throw new Error('Queue name cannot contain :');"), "queue-base.js: a queue's name holds no ':'");
	// The meta hash: its version field and the pause flag BullMQ reads by presence.
	const queue = bullmqFile("classes/queue.js");
	assert.ok(queue.includes("this.libName = 'bullmq';"), "queue.js libName");
	assert.ok(queue.includes("version: `${this.libName}:${version}`,"), "queue.js metaValues");
	assert.equal(META_FIELD.version, "version");
	assert.ok(bullmqFile("commands/includes/isQueuePaused.lua").includes('return rcall("HEXISTS", queueMetaKey, "paused") == 1'), "isQueuePaused.lua: presence");
	const target = bullmqFile("commands/includes/getTargetQueueList.lua");
	assert.ok(target.includes('local queueAttributes = rcall("HMGET", queueMetaKey, "paused",') && target.includes("if queueAttributes[1] then"), "getTargetQueueList.lua: any value is paused");
	const pause = bullmqFile("commands/pause-7.lua");
	assert.ok(pause.includes('rcall("HSET", KEYS[3], "paused", 1)') && pause.includes('rcall("HDEL", KEYS[3], "paused")'), "pause-7.lua writes 1 and deletes the field");
	assert.equal(META_FIELD.paused, "paused");
	assert.equal(QUEUE_KEY.meta, "meta");
});

test("customJobIdAllowed answers as BullMQ's own validateOptions does, id for id", { skip }, async () => {
	const { Job } = await import("bullmq");
	// The method reads `this.opts` and the job's name and data only, so it runs on a plain object, offline.
	const bullmqTakes = (jobId) => {
		try {
			Job.prototype.validateOptions.call({ opts: { jobId }, name: "local" }, { data: "{}" });
			return true;
		} catch (error) {
			assert.match(error.message, /^Custom Id cannot (?:be integers|contain :)$/, `${jobId}: refused by a custom id rule, not another`);
			return false;
		}
	};
	const ids = ["gh-1", "local-0123456789abcdef", "repeat:nightly:1761400000000", "manual:nightly:60000", "manual:x:60001", "a:b:c", "gh-1.r1", "repeat:a:1.r2", "a:b", "a:b:c:d", ":", "::", ":::", "a::", "123", "0", "-1", "NaN", "007", "1e3", " 1", "1 ", "12a", "Infinity", "0x10"];
	for (const id of ids) assert.equal(customJobIdAllowed(id), bullmqTakes(id), JSON.stringify(id));
	// Both refusals are reached, so the comparison above is not one-sided.
	assert.deepEqual(ids.filter((id) => !customJobIdAllowed(id)), ["a:b", "a:b:c:d", ":", ":::", "123", "0", "-1", "NaN"]);
	// No custom id at all: BullMQ mints its own for an empty one, so it is never a usable custom id.
	for (const none of ["", null, undefined, 7, {}]) assert.equal(customJobIdAllowed(none), false, JSON.stringify(none));
});

test("every pin of bullmq, ioredis and cron-parser agrees, exactly, and the installed bullmq is the verified one", () => {
	const pkg = (ws) => JSON.parse(read(`${ws}/package.json`));
	const exact = /^\d+\.\d+\.\d+$/;
	const bullmqPins = ["worker", "receiver", "admin"].map((ws) => [ws, pkg(ws).dependencies?.bullmq]);
	const ioredisPins = ["worker", "receiver", "admin", "gateway"].map((ws) => [ws, pkg(ws).dependencies?.ioredis]);
	for (const [ws, pin] of [...bullmqPins, ...ioredisPins]) assert.match(String(pin), exact, `${ws}: an exact pin, never a range`);
	assert.deepEqual(new Set(bullmqPins.map(([, pin]) => pin)).size, 1, `every workspace runs one bullmq: ${JSON.stringify(bullmqPins)}`);
	assert.deepEqual(new Set(ioredisPins.map(([, pin]) => pin)).size, 1, `every workspace runs one ioredis: ${JSON.stringify(ioredisPins)}`);
	const bullmq = bullmqPins[0][1];
	const ioredis = ioredisPins[0][1];
	const cronParser = pkg("admin").dependencies?.["cron-parser"];
	assert.match(String(cronParser), exact, "admin's cron-parser is exact: it mirrors the scheduler's next fire, so it must be bullmq's own");
	assert.equal(bullmq, BULLMQ_VERIFIED_VERSION, "the pin is the release the module was verified against; a bump re-reads what the module cites, then moves both");

	// The lockfile resolves exactly those, with bullmq's own ioredis and cron-parser the same copies, never nested ones.
	const lock = JSON.parse(read("package-lock.json")).packages;
	const top = lock["node_modules/bullmq"];
	assert.equal(top?.version, bullmq, "the lockfile's bullmq");
	assert.equal(top.dependencies?.ioredis, ioredis, "bullmq's own ioredis is the workspaces' pin");
	assert.equal(top.dependencies?.["cron-parser"], cronParser, "bullmq's own cron-parser is admin's pin");
	assert.equal(lock["node_modules/ioredis"]?.version, ioredis);
	assert.equal(lock["node_modules/cron-parser"]?.version, cronParser);
	for (const [ws, pin] of bullmqPins) assert.equal(lock[ws]?.dependencies?.bullmq, pin, `the lockfile's ${ws} entry`);
	for (const [ws, pin] of ioredisPins) assert.equal(lock[ws]?.dependencies?.ioredis, pin, `the lockfile's ${ws} entry`);
	assert.equal(lock.admin?.dependencies?.["cron-parser"], cronParser);
	const nested = Object.keys(lock).filter((k) => /\/node_modules\/(?:bullmq|ioredis|cron-parser)$/.test(k) && k.split("/node_modules/").length > 2);
	assert.deepEqual(nested, [], "no second copy of bullmq, ioredis or cron-parser anywhere in the tree");
	assert.equal(existsSync(join(REPO_ROOT, "node_modules/bullmq/node_modules")), false, "the installed bullmq carries no nested dependency");

	if (BULLMQ_ROOT) assert.equal(JSON.parse(readFileSync(join(BULLMQ_ROOT, "package.json"), "utf8")).version, BULLMQ_VERIFIED_VERSION, "the installed bullmq");
});

test("the copied and derived bounds: the due bound is defer-reasons', and a cron id leaves room for its run's frame", () => {
	assert.equal(SCORE_DUE_MAX_MS, DEFER_TIME_MAX_MS);
	assert.equal(SLOT_DIGITS_MAX, String(8.64e15).length, "a Date's last instant, in ms, is the longest slot");
	assert.equal(SCHEDULER_JOB_ID_OVERHEAD, "repeat::".length + 16);
	assert.equal(CRON_ID_MAX, 200 - SCHEDULER_JOB_ID_OVERHEAD);
	assert.equal(CRON_ID_MAX, 176, "an unchanged bound: a longer cron id refuses the triggers file");
	assert.ok(SCHEDULER_ID_MAX >= CRON_ID_MAX, "every id the loader takes is a key every Valkey reader takes");
	assert.equal(schedulerJobId("x".repeat(CRON_ID_MAX), 8.64e15).length, 200, "the longest legal id's latest run is a 200-character job id");
	assert.ok(SCHEDULER_ID_RE.test("x".repeat(SCHEDULER_ID_MAX)) && !SCHEDULER_ID_RE.test("x".repeat(SCHEDULER_ID_MAX + 1)));
});

test("a cron run's id charset is the triggers loader's, character for character", () => {
	// The grammar copies the loader's `ID_CHARSET` (this module imports nothing), so every printable ASCII character is
	// asked of both: one the loader takes is one the readers take, and one it refuses is no cron run.
	const loaderTakes = (id) => {
		try {
			parseTriggers(JSON.stringify({ triggers: [{ on: { type: "cron", id, pattern: "0 3 * * *" }, run: { kind: "local", folder: "/proj", flow: "tidy", task: "t" } }] }), "/x/triggers.json");
			return true;
		} catch {
			return false;
		}
	};
	let taken = 0;
	for (let code = 0x20; code < 0x7f; code++) {
		const id = `a${String.fromCharCode(code)}b`;
		const takes = loaderTakes(id);
		taken += takes ? 1 : 0;
		assert.equal(cronRunOf(`repeat:${id}:1`) !== null, takes, `${JSON.stringify(id)}: the grammar`);
		assert.equal(SCHEDULER_ID_RE.test(id), takes, `${JSON.stringify(id)}: the Valkey readers' bound`);
	}
	assert.equal(taken, 65, "letters, digits and . _ -");
});

test("the keys: a queue's key, its job's, a meta key's pattern and the queue a meta key names", () => {
	assert.equal(queueKey("pi-jobs", QUEUE_KEY.meta), "bull:pi-jobs:meta");
	assert.equal(queueKey("pi-jobs", "x", "other"), "other:pi-jobs:x");
	assert.equal(queueKeyOf({ name: "pi-jobs" }, QUEUE_KEY.repeat), "bull:pi-jobs:repeat");
	assert.equal(queueKeyOf({ name: "q", toKey: (t) => `own:q:${t}` }, QUEUE_KEY.delayed), "own:q:delayed", "the queue's own toKey wins: it knows its prefix");
	assert.equal(jobKeyOf({ name: "pi-jobs" }, "repeat:a:1"), "bull:pi-jobs:repeat:a:1");
	assert.equal(metaKeyPattern("pi-jobs@"), "bull:pi-jobs@*:meta");
	assert.ok(Object.isFrozen(QUEUE_KEY) && Object.isFrozen(JOB_FIELD) && Object.isFrozen(META_FIELD));
	for (const name of ["pi-jobs", "pi-jobs@build3", "pi-jobs@a.b_c-d"]) assert.equal(queueNameOfMetaKey(queueKey(name, QUEUE_KEY.meta)), name, name);
	// A key the pattern's `*` matched that is no queue's meta key: a job's hash whose three-part id ends in `meta`.
	for (const key of ["bull:pi-jobs:a:b:meta", "bull::meta", "bull:meta", "other:pi-jobs:meta", "bull:pi-jobs:metas", "bull:pi-jobs", null, 7, Buffer.from("bull:pi-jobs:meta")]) {
		assert.equal(queueNameOfMetaKey(key), null, String(key));
	}
});

test("the pause flag is read by presence, whatever the field holds", () => {
	for (const [cmd, value, paused] of [["hexists", 1, true], ["hexists", "1", true], ["hexists", 0, false], ["hexists", null, false], ["hget", "1", true], ["hget", "0", true], ["hget", "", true], ["hget", null, false], ["hget", undefined, false]]) {
		assert.equal(isPausedFlag(cmd, value), paused, `${cmd} ${JSON.stringify(value)}`);
	}
});

test("metaVersionOf reads `bullmq:<version>` and nothing else", () => {
	assert.equal(metaVersionOf(`bullmq:${BULLMQ_VERIFIED_VERSION}`), BULLMQ_VERIFIED_VERSION);
	for (const bad of ["5.80.4", "bullmq:", "bullmq:5.80", "bullmq:5.80.4 ", "bull:5.80.4", "bullmq:5.80.4-beta.1", null, 5]) assert.equal(metaVersionOf(bad), null, String(bad));
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
	// A hand-fired run is never its scheduler's next run, whatever the score.
	assert.equal(isSchedulerNext("manual:nightly:1761400000000", "nightly", "1761400000000"), false);
});

test("cronRunOf reads both cron run shapes, round-trips every builder, and refuses everything else", () => {
	const longest = "a".repeat(SCHEDULER_ID_MAX);
	const slot16 = 1000000000000000;
	assert.deepEqual(cronRunOf(schedulerJobId(longest, slot16)), { kind: "repeat", id: longest, ms: slot16 });
	assert.equal(schedulerJobId("nightly.tidy_2-a", 1761400000000), "repeat:nightly.tidy_2-a:1761400000000");
	assert.deepEqual(cronRunOf("repeat:nightly.tidy_2-a:1761400000000"), { kind: "repeat", id: "nightly.tidy_2-a", ms: 1761400000000 });
	assert.deepEqual(cronRunOf("repeat:a:0"), { kind: "repeat", id: "a", ms: 0 });
	// Both manual builders: the hand fire, and a canary one millisecond past the minute (issue #796).
	const now = new Date(1761400012345);
	const fire = manualTriggerJobId({ triggerId: "nightly", now });
	const canary = manualCanaryJobId({ triggerId: "nightly", now });
	assert.deepEqual(cronRunOf(fire), { kind: "manual", id: "nightly", ms: 1761399960000 });
	assert.deepEqual(cronRunOf(canary), { kind: "manual", id: "nightly", ms: 1761399960001 });
	assert.ok(fire.startsWith(`${MANUAL_JOB_PREFIX}:`) && customJobIdAllowed(fire) && customJobIdAllowed(canary));
	for (const id of [fire, canary, schedulerJobId(longest, slot16)]) {
		const run = cronRunOf(id);
		assert.ok(cronRunPrefixes(run.id).some((prefix) => id === `${prefix}${run.ms}`), `${id}: a prefix scan finds it`);
	}
	assert.deepEqual(cronRunPrefixes("nightly"), ["repeat:nightly:", "manual:nightly:"]);
	// A middle `:`, an empty id or slot, a leading zero, a space, a fourth part, a foreign prefix, 17 digits, non-strings.
	for (const bad of ["repeat::1", "repeat:a:", "repeat:a:01", "repeat:a b:1", "repeat:a:1:2", "repeat:a:b:1", "repeat:1", "foo:a:1", "Repeat:a:1", "manual:a:-1", "manual:a:1.5", "manual:a:1e3", `repeat:a:${"1".repeat(SLOT_DIGITS_MAX + 1)}`, " repeat:a:1", "repeat:a:1\n", "repeat:aé:1", 1, null, undefined, {}, ["repeat:a:1"]]) {
		assert.equal(cronRunOf(bad), null, JSON.stringify(bad));
	}
	assert.deepEqual(cronRunOf(`repeat:a:${"9".repeat(SLOT_DIGITS_MAX)}`)?.id, "a", "16 digits is a slot's widest");
});

test("a run record's cron id is read at any length; a Valkey reader or a surface bounds it with idMax", () => {
	// Every release before issue #761 took a cron id of any length, so a record's id may be longer than any bound now.
	const long = "x".repeat(5000);
	assert.deepEqual(cronRunOf(`repeat:${long}:1761400000000`), { kind: "repeat", id: long, ms: 1761400000000 });
	assert.deepEqual(cronRunOf(`manual:${long}:60000`), { kind: "manual", id: long, ms: 60000 });
	assert.equal(cronRunOf(`repeat:${long}:1761400000000`, { idMax: SCHEDULER_ID_MAX }), null);
	assert.equal(cronRunOf(`repeat:${"x".repeat(SCHEDULER_ID_MAX + 1)}:1`, { idMax: SCHEDULER_ID_MAX }), null);
	assert.equal(cronRunOf(`repeat:${"x".repeat(SCHEDULER_ID_MAX)}:1`, { idMax: SCHEDULER_ID_MAX })?.id.length, SCHEDULER_ID_MAX);
	assert.equal(scheduledForMillis(`repeat:${long}:1761400000000`), 1761400000000);
});

test("the repeat-only readers keep a manual: run's answer: no scheduled instant, not a scheduler's job", () => {
	assert.equal(scheduledForMillis("repeat:nightly:1761400000000"), 1761400000000);
	assert.equal(scheduledForMillis("manual:nightly:1761400000000"), null, "a hand fire has no scheduled instant");
	assert.equal(scheduledForMillis(manualCanaryJobId({ triggerId: "nightly", now: new Date(1761400012345) })), null);
	for (const bad of ["repeat:nightly:", "repeat:nightly:x", "repeat::5", "repeat:5", "gh-1", null, undefined, 5]) assert.equal(scheduledForMillis(bad), null, String(bad));
	assert.equal(isSchedulerJobId("repeat:nightly:1"), true);
	assert.equal(isSchedulerJobId("repeat:unparsed"), true, "in the scheduler's namespace, parsed or not: the stall guard logs it");
	for (const not of ["manual:nightly:1", "gh-1", "local-1", "", null, 7]) assert.equal(isSchedulerJobId(not), false, String(not));
});

// --- one owner ------------------------------------------------------------------------------------------------------
//
// Every BullMQ fact above has ONE spelling, here. A second spelling of a key, a field, the score or the cron run grammar
// anywhere in the source trees is the drift this module exists to end, so the scan below refuses one outside the module.
// It reads code with comments stripped, a line at a time, so it catches the shapes the trees have used (each pattern is
// one found in them before issue #761) and misses a spelling built across lines or from variables; review catches
// those. An exemption names the file and the line's text, and must match exactly one hit, so a stale one fails too.

const SCAN_TREES = ["worker/src", "receiver/src", "admin/src", "image/runner", "gateway/src"];
const SCAN_SKIP = new Set(["test", "node_modules", "dist"]);
const SCAN_EXTS = new Set([".mjs", ".js", ".cjs", ".ts", ".mts"]);

const OWNER_PATTERNS = Object.freeze({
	"a quoted bull:, repeat: or manual: prefix": /["'`](?:bull|repeat|manual):/,
	"a cron run parser": /\^\(?(?:\?:)?(?:repeat|manual)\b/,
	"a quoted :meta suffix": /:meta["'`]/,
	"a quoted job hash field": /["'`](?:rjk|deid|atm|stc|attemptsMade)["'`]/,
	"a queue key built from a literal type": /\b(?:toKey|queueKeyOf|queueKey|jobKeyOf)\((?:[^,()]*,\s*)?["'`]/,
	"the delayed score's shift": /\bDELAYED_SCORE_SHIFT\s*=|[*/]\s*(?:4096|0x1000)\b/,
	"BullMQ's three-part custom id rule": /split\(\s*["'`]:["'`]\s*\)\.length\s*[!=]==?\s*3/,
	"a scheduler key's bound": /\[A-Za-z0-9\._-\]\{1,200\}/,
});

// Each one a hit the patterns make that is not a BullMQ fact.
const OWNER_EXEMPTIONS = Object.freeze([
	{ path: "worker/src/touch-state.mjs", line: 'export const TOUCH_META = "touch:meta";', why: "the touch store's own meta key, not a queue's" },
	{ path: "worker/src/workspace-checkpoint.mjs", line: "const RUN_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;", why: "a sanitized run id's charset for a directory name, not a scheduler key" },
	{ path: "admin/src/read-model.mjs", line: 'if (id !== null) return { project: id, from: "deid" };', why: "the name of the source a waiting row's project came from, not a field read" },
]);

/** Every source file of the scanned trees, comments stripped. */
function ownerScanSources() {
	const out = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) {
				if (!SCAN_SKIP.has(name)) walk(p);
			} else if (SCAN_EXTS.has(extname(name))) out.push(p);
		}
	};
	for (const tree of SCAN_TREES) walk(join(REPO_ROOT, tree));
	return out.map((p) => ({ path: relative(REPO_ROOT, p), code: stripComments(readFileSync(p, "utf8")) }));
}

/** Every line of `files` a pattern matches, as `{ path, line, what, text }`. */
function ownerHits(files) {
	const hits = [];
	for (const file of files) {
		file.code.split("\n").forEach((text, i) => {
			for (const [what, re] of Object.entries(OWNER_PATTERNS)) if (re.test(text)) hits.push({ path: file.path, line: i + 1, what, text: text.trim() });
		});
	}
	return hits;
}

test("BullMQ's internals have one owner: no other source file spells a key, a field, the score or the cron run grammar", () => {
	const files = ownerScanSources();
	for (const tree of SCAN_TREES) assert.ok(files.some((f) => f.path.startsWith(`${tree}/`)), `the scan reaches ${tree}`);
	const hits = ownerHits(files);
	const used = OWNER_EXEMPTIONS.map(() => 0);
	const offending = hits.filter((hit) => {
		if (hit.path === MODULE_PATH) return false;
		const at = OWNER_EXEMPTIONS.findIndex((e) => e.path === hit.path && e.line === hit.text);
		if (at === -1) return true;
		used[at]++;
		return false;
	});
	assert.deepEqual(offending.map((h) => `${h.path}:${h.line}: ${h.what}: ${h.text}`), [], `import the fact from ${MODULE_PATH} (@edgehero/pi-dispatch/bullmq-internals) instead of spelling it again; a hit that is no BullMQ fact goes in OWNER_EXEMPTIONS with its reason`);
	OWNER_EXEMPTIONS.forEach((e, i) => assert.equal(used[i], 1, `${e.path}: the exemption "${e.line}" matches exactly one hit (${e.why})`));
	// The owner itself is seen, so the walk reached it and the module carries the shapes the scan is looking for.
	const own = new Set(hits.filter((h) => h.path === MODULE_PATH).map((h) => h.what));
	for (const what of ["a cron run parser", "a quoted job hash field", "the delayed score's shift", "BullMQ's three-part custom id rule", "a scheduler key's bound"]) assert.ok(own.has(what), `the module itself matches ${what}`);
});

test("the one-owner scan is not vacuous: each pattern catches a spelling the source trees once had", () => {
	const planted = {
		"a quoted bull:, repeat: or manual: prefix": ['if (!jobId.startsWith("repeat:")) return;', "const prefix = `bull:${QUEUE}@`;", "return `manual:${triggerId}:${millis}`;", "const key = 'bull:' + name;"],
		"a cron run parser": ["const m = /^(?:repeat|manual):(.+):\\d+$/.exec(jobId);", "const RE = /^repeat:([A-Za-z0-9._-]{1,200}):(0|[1-9][0-9]{0,15})$/;", "const re = new RegExp(`^(?:repeat|manual):${id}:(\\\\d+)$`);", "const RE = /^(repeat|manual):(x):(1)$/;"],
		"a quoted :meta suffix": ['redis.scan(cursor, "MATCH", "bull:pi-jobs*:meta");', 'const name = key.slice(prefix.length, -":meta".length);'],
		"a quoted job hash field": ['const FIELDS = ["name", "deid", "rjk", "atm", "attemptsMade", "stc"];', "pipe.hmget(key, 'rjk');"],
		"a queue key built from a literal type": ['q.toKey("repeat")', 'queueKeyOf(q, "delayed")', "queueKey(name, 'meta')", 'jobKeyOf(q, "x")'],
		"the delayed score's shift": ["export const DELAYED_SCORE_SHIFT = 4096;", "const due = Math.floor(n / 4096);", "const score = due * 0x1000;"],
		"BullMQ's three-part custom id rule": ['if (id.includes(":") && id.split(":").length !== 3) return null;', "return id.split(':').length === 3;"],
		"a scheduler key's bound": ["const SCHEDULER_KEY_RE = /^[A-Za-z0-9._-]{1,200}$/;"],
	};
	assert.deepEqual(Object.keys(planted), Object.keys(OWNER_PATTERNS), "every pattern has its planted spellings");
	for (const [what, lines] of Object.entries(planted)) {
		for (const text of lines) {
			const hits = ownerHits([{ path: "admin/src/planted.mjs", code: text }]);
			assert.ok(hits.some((h) => h.what === what), `${what}: ${text}`);
		}
	}
	// And a comment is no spelling: the scan reads code alone.
	assert.deepEqual(ownerHits([{ path: "admin/src/planted.mjs", code: stripComments('/** `repeat:<id>:<ms>` and "bull:x:meta" */\n// q.toKey("repeat")\nconst x = 1;') }]), []);
});
