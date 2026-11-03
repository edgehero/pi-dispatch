import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { DOLLAR_KEY_PREFIX, deploymentWindowsOf, valkeyEndpointTag } from "../src/dollar-budget.mjs";
import { DOLLAR_WINDOWS_DOCTOR_TIMEOUT_MS, doctorDollarWindows, dollarWindowResetChecks } from "../src/doctor.mjs";
import { NAMED_CHECK_IDS } from "../src/doctor-results.mjs";
import { collectChecks } from "./helpers/doctor.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #761: doctor's `dollars.window-reset`, a deployment dollar window counter below what this host's own run records
// settled into it. Every instant is the injected NOW; the records and the counters come through the two seams, so no
// test reads a real logs directory or a real Valkey (the helper refuses both defaults).

const USD = 1_000_000;
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const DAY = "budget:usd:2026-11-03";
const WEEK = "budget:usd:w:2026-11-02";
const MONTH = "budget:usd:m:2026-11";
const URL = "redis://127.0.0.1:6379/0";
const TAG = valkeyEndpointTag(URL);
const ENV = { PI_MAX_COST_USD: "2", PI_DAILY_COST_USD: "10", PI_WEEKLY_COST_USD: "50", PI_MONTHLY_COST_USD: "100", PI_LOGS_DIR: "/srv/logs", PI_SETTINGS_FILE: "/nonexistent/settings.json" };

const at = (windows, valkey = TAG) => ({ ...windows, valkey });
const NOV = at({ day: "2026-11-03", week: "2026-11-02", month: "2026-11" });
let n = 0;
const rec = (settledMicros, reservedIn, { host = "mini1", basis = "metered" } = {}) => ({ jobId: `j${++n}`, host, outcome: "completed", dollars: { reservedMicros: 2 * USD, settledMicros, basis, modelBasis: null, ...(reservedIn ? { reservedIn } : {}) } });

/** The check for these records and counters (`{ key: value }`, a missing key absent), and every read it made, in order. */
async function judge({ records = [], counters = {}, env = ENV, url = URL, localHost = "mini1", seams = {} } = {}) {
	const reads = [];
	const lines = await doctorDollarWindows({
		seams: {
			wallClock: () => NOW,
			dollarWindowsClock: () => 1_000,
			readDollarRecords: async (args) => (reads.push(["records", args]), { records }),
			readDollarCounters: async (args) => (reads.push(["counters", args]), args.keys.map((k) => (Object.hasOwn(counters, k) ? counters[k] : null))),
			...seams,
		},
		env,
		home: "/home/op",
		url,
		localHost,
		fileExists: () => false,
	});
	return { lines, reads };
}

test("an absent counter below this host's records: one warning, its exact words, and the shortfall to put back", async () => {
	const { lines, reads } = await judge({ records: [rec(12_400_000, at({ month: "2026-11" }))], counters: { [DAY]: "0", [WEEK]: "0" }, env: { ...ENV, PI_DAILY_COST_USD: "", PI_WEEKLY_COST_USD: "" } });
	assert.deepEqual(lines, [
		{
			id: "dollars.window-reset",
			ok: false,
			warn: true,
			label: "A dollar window counter is below what this host's own runs settled into it, so its history was lost (a flushed, replaced or restored Valkey, an evicted key, or a hand edit) and the cap can let at least that much more be spent: this month's (budget:usd:m:2026-11) is missing while this host's own run records settled $12.40 into it, so the $100.00 monthly cap counts at least $12.40 too little. Other hosts' runs are not counted here",
			fix: 'put back at least this host\'s share for the rest of the window: `valkey-cli INCRBY budget:usd:m:2026-11 12400000` then `valkey-cli EXPIRE budget:usd:m:2026-11 3456000` (on a fleet, run doctor on every host first, then `INCRBY` the sum, in micro-dollars, of what each says its records settled, less what the counter holds now), or lower the cap by what was already spent, or run `pi-dispatch pause` and resume once the window ends (this month\'s at 2026-12-01 00:00 UTC). A counter lowered on purpose is named here until its window ends (docs/costs.md, "When a counter resets")',
		},
	]);
	// The records first, from the start of the earliest active window; then only the counter whose sum is above 0.
	assert.deepEqual(reads, [
		["records", { logsDir: "/srv/logs", sinceMs: Date.parse("2026-11-01T00:00:00Z"), deadlineAt: 1_000 + DOLLAR_WINDOWS_DOCTOR_TIMEOUT_MS, clock: reads[0][1].clock }],
		["counters", { url: URL, keys: [MONTH], deadlineAt: 1_000 + DOLLAR_WINDOWS_DOCTOR_TIMEOUT_MS, clock: reads[0][1].clock }],
	]);
	assert.equal(reads[0][1].clock(), 1_000, "the bound's own clock, not the wall clock a test fixes");
	// On a fleet the amount is the sum of every host's share less the counter, never the sum of each host's shortfall
	// (each subtracts the counter, so adding them subtracts it once per host and puts back too little).
	assert.doesNotMatch(lines[0].fix, /add them all/);
	assert.equal(DOLLAR_WINDOWS_DOCTOR_TIMEOUT_MS, 5_000);
	assert.ok(NAMED_CHECK_IDS.includes("dollars.window-reset"));
});

test("a counter below the floor names what it holds; one at or above it says nothing", async () => {
	const records = [rec(3 * USD, NOV), rec(1 * USD, NOV)];
	const below = await judge({ records, counters: { [DAY]: "1500000", [WEEK]: "4000000", [MONTH]: "9000000" } });
	assert.equal(below.lines.length, 1);
	assert.match(below.lines[0].label, /: today's \(budget:usd:2026-11-03\) holds \$1\.50 while this host's own run records settled \$4\.00 into it, so the \$10\.00 daily cap counts at least \$2\.50 too little\. Other/);
	assert.match(below.lines[0].fix, /`valkey-cli INCRBY budget:usd:2026-11-03 2500000` then `valkey-cli EXPIRE budget:usd:2026-11-03 172800`/);
	assert.match(below.lines[0].fix, /\(today's at 2026-11-04 00:00 UTC\)/);
	for (const counters of [{ [DAY]: "4000000", [WEEK]: "4000000", [MONTH]: "4000000" }, { [DAY]: "9000000", [WEEK]: 4_000_001, [MONTH]: "40000000" }]) {
		assert.deepEqual((await judge({ records, counters })).lines, [], JSON.stringify(counters));
	}
});

test("every window found goes in the one check, day, week, month; a negative counter and a malformed one", async () => {
	const { lines, reads } = await judge({ records: [rec(3 * USD, NOV)], counters: { [DAY]: null, [WEEK]: "-1000000", [MONTH]: "lots" } });
	assert.deepEqual(reads[1][1].keys, [DAY, WEEK, MONTH]);
	assert.equal(lines.length, 1, "one literal site, one check");
	assert.match(lines[0].label, /^Dollar window counters are below what this host's own runs settled into them, so their history/);
	assert.match(lines[0].label, /today's \(budget:usd:2026-11-03\) is missing while .* \$3\.00 too little; this week's \(budget:usd:w:2026-11-02\) holds -\$1\.00 while .* \$50\.00 weekly cap counts at least \$4\.00 too little\. Other/);
	assert.doesNotMatch(lines[0].label, /month/, "a counter that is not an integer is skipped, never judged");
	assert.match(lines[0].fix, /INCRBY budget:usd:w:2026-11-02 4000000` then `valkey-cli EXPIRE budget:usd:w:2026-11-02 777600`/);
	assert.match(lines[0].fix, /\(today's at 2026-11-04 00:00 UTC; this week's at 2026-11-09 00:00 UTC\)/);
	for (const odd of ["1.5", "", " 1", "1e6", "99999999999999999"]) assert.deepEqual((await judge({ records: [rec(3 * USD, NOV)], counters: { [DAY]: odd, [WEEK]: "9000000", [MONTH]: "9000000" } })).lines, [], JSON.stringify(odd));
});

test("only this host's records on this Valkey in the CURRENT bucket count: the month boundary, another host, another Valkey, no reservedIn", async () => {
	const absent = {};
	const ignored = [
		// The previous month's last day: its money is in October's keys.
		rec(5 * USD, at({ day: "2026-10-31", week: "2026-10-26", month: "2026-10" })),
		// Another host sharing the logs directory.
		rec(5 * USD, NOV, { host: "mini2" }),
		// Another deployment's Valkey, same host, same logs directory.
		rec(5 * USD, at({ day: "2026-11-03", week: "2026-11-02", month: "2026-11" }, valkeyEndpointTag("redis://127.0.0.1:6380/0"))),
		// A record from before issue #761, and a refunded one.
		rec(5 * USD, null),
		rec(0, NOV, { basis: "refunded" }),
	];
	const { lines, reads } = await judge({ records: ignored, counters: absent });
	assert.deepEqual(lines, []);
	assert.deepEqual(reads.map((r) => r[0]), ["records"], "every sum is 0, so no counter is asked");
});

test("no false alarm where a step stopped part-way: an overshoot settle, a partial release, a retry, a cap set mid-month", async () => {
	// Each record's reservedIn is what the processor computes (`deploymentWindowsOf`), and each counter what the keys hold.
	const hold = { amountMicros: 2 * USD, keys: [DAY, WEEK, MONTH], ledgers: [{ keyPrefix: DOLLAR_KEY_PREFIX, keys: [DAY, WEEK, MONTH] }] };
	// A $3 overshoot settled into the day, the fault at the week: the day holds $3, the week and month $2.
	const overshoot = rec(3 * USD, deploymentWindowsOf(hold, { applied: 1, target: 3 * USD, recorded: 3 * USD, valkey: TAG }));
	assert.deepEqual((await judge({ records: [overshoot], counters: { [DAY]: "3000000", [WEEK]: "2000000", [MONTH]: "2000000" } })).lines, []);
	// A release that gave the day and week back, the fault at the month: the record states the floor, $2.
	const release = rec(2 * USD, deploymentWindowsOf(hold, { applied: 2, target: 0, recorded: 2 * USD, valkey: TAG }), { basis: "floor" });
	assert.deepEqual((await judge({ records: [release], counters: { [DAY]: "0", [WEEK]: "0", [MONTH]: "2000000" } })).lines, []);
	// A retry: the first attempt's $1 is in the counter, its record overwritten by the second's $0.50.
	assert.deepEqual((await judge({ records: [rec(500_000, NOV)], counters: { [DAY]: "1500000", [WEEK]: "1500000", [MONTH]: "1500000" } })).lines, []);
	// The month cap set today: the records before it reserved in no month window, so the month counter holds only today's.
	const before = rec(4 * USD, at({ day: "2026-11-02", week: "2026-11-02" }));
	const after = rec(1 * USD, NOV);
	assert.deepEqual((await judge({ records: [before, after], counters: { [DAY]: "1000000", [WEEK]: "5000000", [MONTH]: "1000000" } })).lines, []);
	// And the same overshoot record against a counter that DID lose its history still fires, on the window that holds it.
	assert.match((await judge({ records: [overshoot], counters: { [DAY]: null, [WEEK]: "0", [MONTH]: "0" } })).lines[0].label, /today's \(budget:usd:2026-11-03\) is missing/);
});

test("the records are read from the start of the EARLIEST active window: on 2026-12-01 the week began on Monday 2026-11-30", async () => {
	// Day and month begin on 2026-12-01, the week on the Monday before: a read from the latest start would miss the
	// week's records from 2026-11-30, and with them a reset of the weekly counter.
	const now = Date.parse("2026-12-01T09:00:00.000Z");
	const monday = rec(3 * USD, at({ day: "2026-11-30", week: "2026-11-30", month: "2026-11" }));
	const { lines, reads } = await judge({ records: [monday], counters: {}, seams: { wallClock: () => now } });
	assert.equal(reads[0][0], "records");
	assert.equal(reads[0][1].sinceMs, Date.parse("2026-11-30T00:00:00.000Z"));
	// That Monday's record holds the week's floor: the missing weekly counter is the one finding.
	assert.deepEqual(reads[1][1].keys, ["budget:usd:w:2026-11-30"]);
	assert.match(lines[0].label, /this week's \(budget:usd:w:2026-11-30\) is missing while this host's own run records settled \$3\.00 into it/);
});

test("the records are read BEFORE the counters, and a counter read cannot start until the records are in", async () => {
	let recordsDone = false;
	const { lines } = await judge({
		seams: {
			readDollarRecords: async () => {
				await new Promise((r) => setImmediate(r));
				recordsDone = true;
				return { records: [rec(2 * USD, NOV)] };
			},
			readDollarCounters: async ({ keys }) => {
				assert.equal(recordsDone, true, "a counter read before the records could see a counter older than a record");
				return keys.map(() => null);
			},
		},
	});
	assert.equal(lines.length, 1);
});

test("nothing is read without a dollar window, with a value the worker refuses, or without a Valkey this command may talk to", async () => {
	const never = { readDollarRecords: async () => assert.fail("no read"), readDollarCounters: async () => assert.fail("no read") };
	for (const env of [{ PI_LOGS_DIR: "/srv/logs", PI_MAX_COST_USD: "2", PI_SETTINGS_FILE: "/nonexistent/s.json" }, { ...ENV, PI_DAILY_COST_USD: "ten" }]) {
		assert.deepEqual((await judge({ env, seams: never })).lines, [], JSON.stringify(env));
	}
	assert.deepEqual((await judge({ url: null, seams: never })).lines, []);
	assert.deepEqual((await judge({ url: "not a url", seams: never })).lines, []);
});

test("a read that fails or answers something else says nothing: silence is never a claim", async () => {
	const records = [rec(2 * USD, NOV)];
	for (const readDollarCounters of [async () => null, async () => ["0"], async () => { throw new Error("down"); }]) {
		assert.deepEqual((await judge({ records, seams: { readDollarCounters } })).lines, []);
	}
	for (const readDollarRecords of [async () => null, async () => ({}), async () => { throw new Error("EACCES"); }]) {
		assert.deepEqual((await judge({ seams: { readDollarRecords } })).lines, []);
	}
});

test("in a test process both default reads are refused loudly, never run against the developer's own files or Valkey", async () => {
	await assert.rejects(doctorDollarWindows({ seams: { wallClock: () => NOW }, env: ENV, home: "/h", url: URL, localHost: "mini1", fileExists: () => false }), /real dollar window read in a test/);
	await assert.rejects(doctorDollarWindows({ seams: { wallClock: () => NOW, readDollarRecords: async () => ({ records: [rec(2 * USD, NOV)] }) }, env: ENV, home: "/h", url: URL, localHost: "mini1", fileExists: () => false }), /real dollar window read in a test/);
});

test("dollarWindowResetChecks: nothing for nothing found", () => {
	assert.deepEqual(dollarWindowResetChecks([]), []);
	assert.deepEqual(dollarWindowResetChecks(null), []);
});

// ---- through the real collection ----

function planSpawn(plan) {
	return (cmd, args) => {
		const line = [cmd, ...args].join(" ");
		const outcome = plan[Object.keys(plan).find((k) => line.startsWith(k))];
		const stream = () => ({ handlers: {}, on(ev, cb) { this.handlers[ev] = cb; return this; } });
		const handlers = {};
		const child = { stdout: stream(), stderr: stream(), stdin: { on() { return this; }, end() {} }, kill() {}, on(ev, cb) { handlers[ev] = cb; return this; } };
		queueMicrotask(() => {
			const { code, output } = typeof outcome === "object" && outcome !== null ? outcome : { code: outcome ?? 0, output: "" };
			if (output) child.stdout.handlers.data?.(output);
			handlers.close?.(code);
		});
		return child;
	};
}

function collect({ env = {}, seams = {} } = {}) {
	const dir = tempDir("pi-761-dollar-reset-");
	const base = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_SETTINGS_FILE: `${dir}/settings.json`, VALKEY_URL: "redis://localhost:6379", PI_WORKER_NAME: "mini1", PI_MAX_COST_USD: "2", PI_MONTHLY_COST_USD: "100", PI_LOGS_DIR: `${dir}/logs` };
	const capacity = async () => ({ records: [{ jobId: "c1", host: "mini1", startedAt: new Date(NOW - 7_200_000).toISOString(), endedAt: new Date(NOW - 3_600_000).toISOString(), capacity: { slots: 2 } }], coverage: { source: "local", reason: null, localHost: "mini1", localHosts: ["mini1"], local: { fromMs: NOW - 7 * 86_400_000 }, mirror: null } });
	return collectChecks({ ...base, ...env }, { cwd: dir, home: tempDir("pi-761-dollar-reset-home-"), out: () => {}, spawn: planSpawn({ "docker info": 0, "docker image": 0 }), probeValkey: async () => true, readHosts: async () => ({ hosts: [] }), dollarKeysExist: async () => false, fileExists: existsSync, readEnvFile: (path) => readFileSync(path), nodeVersion: "22.19.0", wallClock: () => NOW, readCapacity: capacity, ...seams });
}

test("through the collection: after the fleet lines and before the capacity ones, on the address the worker pins", async () => {
	const asked = [];
	const pinnedTag = valkeyEndpointTag("redis://127.0.0.1:6379");
	const seams = {
		// The owner judgement pins `localhost` to 127.0.0.1, as the worker's boot does on Linux.
		valkeyOwner: async () => ({ chosen: "127.0.0.1", heldBy: "this account" }),
		readDollarRecords: async () => ({ records: [rec(7 * USD, at({ month: "2026-11" }, pinnedTag)), rec(9 * USD, at({ month: "2026-11" }, valkeyEndpointTag("redis://localhost:6379")))] }),
		readDollarCounters: async (args) => (asked.push(args.url), args.keys.map(() => null)),
	};
	const checks = await collect({ seams });
	assert.deepEqual(asked, ["redis://127.0.0.1:6379"], "the judged address, the one the worker dials");
	const i = checks.findIndex((c) => c.id === "dollars.window-reset");
	assert.ok(i >= 0);
	assert.match(checks[i].label, /settled \$7\.00 into it/, "the records tagged with the pinned address only");
	const capacityAt = checks.findIndex((c) => typeof c.label === "string" && c.label.startsWith("Host mini1: last 7d"));
	const valkeyAt = checks.findIndex((c) => typeof c.label === "string" && c.label.includes("answers from a listener of this account"));
	assert.ok(valkeyAt >= 0 && valkeyAt < i && i < capacityAt, `${valkeyAt} < ${i} < ${capacityAt}`);
	assert.equal(checks.filter((c) => c.id === "dollars.window-reset").length, 1);
});

test("through the collection: a Valkey doctor may not talk to is never read, and a deployment with no dollar window prints nothing new", async () => {
	const never = { readDollarRecords: async () => assert.fail("no read"), readDollarCounters: async () => assert.fail("no read") };
	assert.equal((await collect({ env: { VALKEY_URL: "redis://127.0.0.1:6379/abc" }, seams: never })).some((c) => c.id === "dollars.window-reset"), false);
	assert.equal((await collect({ env: { PI_MONTHLY_COST_USD: "" }, seams: never })).some((c) => c.id === "dollars.window-reset"), false);
	// The helper's defaults: no records, so no counter is asked and no line is said.
	assert.equal((await collect()).some((c) => c.id === "dollars.window-reset"), false);
});
