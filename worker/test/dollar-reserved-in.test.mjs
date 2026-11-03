import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_TTL_SECONDS, MONTH_TTL_SECONDS, WEEK_TTL_SECONDS, dayKey, monthKey, weekKey } from "../src/budget.mjs";
import { parseConnection } from "../src/connection.mjs";
import { DEPLOYMENT_WINDOWS, DOLLAR_KEY_PREFIX, VALKEY_TAG_RE, deploymentWindowOfKey, deploymentWindowsAt, deploymentWindowsOf, dollarWindowFloors, dollarsRecord, reservedInOf, valkeyEndpointTag } from "../src/dollar-budget.mjs";
import { buildRecord } from "../src/run-history.mjs";

// Issue #761: which deployment dollar windows a run record's money is in (`dollars.reservedIn`), and the sum doctor's
// reset check compares each counter with. Every instant is a fixed one handed in; nothing here reads the clock.

const USD = 1_000_000;
const TAG = "0123456789abcdef";
const OTHER = "fedcba9876543210";
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const DAY = "budget:usd:2026-11-03";
const WEEK = "budget:usd:w:2026-11-02";
const MONTH = "budget:usd:m:2026-11";
const SCOPE = "budget:usd:s:00112233aabbccdd";
const MODEL = "budget:usd:mdl:8899aabbccddeeff";

/** A hold as `reserveDollars` returns it: the deployment's ledger first, then a scope's and a model's. */
function hold({ deployment = [DAY, WEEK, MONTH], scope = [], model = [], amount = 2 * USD } = {}) {
	const ledgers = [];
	if (deployment.length > 0) ledgers.push({ keyPrefix: DOLLAR_KEY_PREFIX, keys: deployment });
	if (scope.length > 0) ledgers.push({ keyPrefix: "budget:usd:s:00112233aabbccdd", keys: scope });
	if (model.length > 0) ledgers.push({ keyPrefix: "budget:usd:mdl:8899aabbccddeeff", keys: model });
	return { amountMicros: amount, keys: ledgers.flatMap((l) => l.keys), ledgers };
}

// ---- the endpoint tag ----

test("valkeyEndpointTag: 16 hex of host:port/db, the same from a URL and from the options parseConnection reads off it", () => {
	const urls = ["redis://127.0.0.1:6379", "redis://127.0.0.1:6379/0", "redis://127.0.0.1", "redis://LocalHost:6380/2", "rediss://valkey.example:6390/01", "redis://[::1]:6379/3", "valkey://10.0.0.5:7000", "redis://:secret@127.0.0.1:6379/0", "redis://user:pw@valkey.example:6390/1"];
	for (const url of urls) {
		const tag = valkeyEndpointTag(url);
		assert.match(tag, VALKEY_TAG_RE, url);
		const options = parseConnection(url, { context: { shared: false, rootRefused: false, envPath: ".env", error: null, password: { environment: null, file: null }, url: { environment: null, file: null } } });
		assert.equal(valkeyEndpointTag(options), tag, `${url}: the worker's connection options give the doctor's tag`);
	}
	// The defaults are the client's: no port is 6379, no database is 0, no host is 127.0.0.1.
	assert.equal(valkeyEndpointTag("redis://127.0.0.1"), valkeyEndpointTag("redis://127.0.0.1:6379/0"));
	assert.equal(valkeyEndpointTag({}), valkeyEndpointTag("redis://127.0.0.1:6379/0"));
	assert.equal(valkeyEndpointTag("redis://127.0.0.1:6379/01"), valkeyEndpointTag("redis://127.0.0.1:6379/1"));
	// A name is case-insensitive; the scheme and any credential are never part of it.
	assert.equal(valkeyEndpointTag("redis://LOCALHOST:6379"), valkeyEndpointTag("redis://localhost:6379"));
	assert.equal(valkeyEndpointTag("rediss://h:1/2"), valkeyEndpointTag("redis://h:1/2"));
	assert.equal(valkeyEndpointTag("redis://:one@h:1/2"), valkeyEndpointTag("redis://:two@h:1/2"));
	// A different host, port or database is a different Valkey.
	const base = valkeyEndpointTag("redis://127.0.0.1:6379/0");
	for (const other of ["redis://127.0.0.1:6380/0", "redis://127.0.0.1:6379/1", "redis://127.0.0.2:6379/0"]) assert.notEqual(valkeyEndpointTag(other), base, other);
	// A unix socket is tagged by its path (no client builds one today), and never collides with a host.
	assert.match(valkeyEndpointTag({ path: "/run/valkey.sock" }), VALKEY_TAG_RE);
	assert.notEqual(valkeyEndpointTag({ path: "/run/valkey.sock" }), valkeyEndpointTag({ path: "/run/other.sock" }));
	for (const bad of [null, undefined, 42, "not a url", "redis://h:1/abc", { host: "h", db: -1 }, { host: "h", port: "x" }]) assert.equal(valkeyEndpointTag(bad), null, String(bad));
});

// ---- the window keys ----

test("deploymentWindowOfKey is the inverse of dayKey, weekKey and monthKey under the deployment's prefix, and of nothing else", () => {
	for (const iso of ["2026-01-01T00:00:00Z", "2026-02-28T23:59:59Z", "2028-02-29T12:00:00Z", "2026-11-03T12:00:00Z", "2027-01-03T23:00:00Z"]) {
		const at = new Date(iso);
		assert.deepEqual(deploymentWindowOfKey(dayKey(at, DOLLAR_KEY_PREFIX)), { window: "day", bucket: at.toISOString().slice(0, 10) }, iso);
		assert.deepEqual(deploymentWindowOfKey(monthKey(at, DOLLAR_KEY_PREFIX)), { window: "month", bucket: at.toISOString().slice(0, 7) }, iso);
		const week = deploymentWindowOfKey(weekKey(at, DOLLAR_KEY_PREFIX));
		assert.equal(week.window, "week");
		assert.equal(new Date(`${week.bucket}T00:00:00Z`).getUTCDay(), 1, `${iso}: a week is named by its Monday`);
		assert.equal(weekKey(at, DOLLAR_KEY_PREFIX), `${DOLLAR_KEY_PREFIX}:w:${week.bucket}`);
	}
	// A scoped, model or job-count key starts with a dollar or budget prefix too, and is none of them.
	for (const key of [SCOPE, MODEL, "budget:2026-11-03", "budget:w:2026-11-02", "budget:usd:t:2026-11-03", "budget:usd:2026-11-03:x", "xbudget:usd:2026-11-03", null]) assert.equal(deploymentWindowOfKey(key), null, String(key));
});

test("deploymentWindowsAt: each window's key, bucket, UTC start and end, and the TTL the worker sets", () => {
	const at = deploymentWindowsAt(NOW);
	assert.deepEqual(Object.keys(at), [...DEPLOYMENT_WINDOWS]);
	assert.deepEqual(at.day, { key: DAY, bucket: "2026-11-03", startMs: Date.parse("2026-11-03T00:00:00Z"), endMs: Date.parse("2026-11-04T00:00:00Z"), ttlSeconds: DAY_TTL_SECONDS });
	assert.deepEqual(at.week, { key: WEEK, bucket: "2026-11-02", startMs: Date.parse("2026-11-02T00:00:00Z"), endMs: Date.parse("2026-11-09T00:00:00Z"), ttlSeconds: WEEK_TTL_SECONDS });
	assert.deepEqual(at.month, { key: MONTH, bucket: "2026-11", startMs: Date.parse("2026-11-01T00:00:00Z"), endMs: Date.parse("2026-12-01T00:00:00Z"), ttlSeconds: MONTH_TTL_SECONDS });
	// A Sunday belongs to the week of the Monday before it; December ends at the next year's first day.
	const sunday = deploymentWindowsAt(Date.parse("2026-12-06T23:59:59.999Z"));
	assert.equal(sunday.week.bucket, "2026-11-30");
	assert.equal(sunday.week.endMs, Date.parse("2026-12-07T00:00:00Z"));
	assert.equal(sunday.month.endMs, Date.parse("2027-01-01T00:00:00Z"));
	// Each TTL outlives the longest bucket of its window, so a key cannot expire inside its own bucket.
	assert.ok(DAY_TTL_SECONDS * 1000 > 86_400_000 && WEEK_TTL_SECONDS * 1000 > 7 * 86_400_000 && MONTH_TTL_SECONDS * 1000 > 31 * 86_400_000);
});

// ---- the record fact ----

test("deploymentWindowsOf: a settle that moved every key keeps every deployment window, with the tag", () => {
	const h = hold({ scope: [SCOPE] });
	assert.deepEqual(deploymentWindowsOf(h, { applied: 4, target: 300_000, recorded: 300_000, valkey: TAG }), { day: "2026-11-03", week: "2026-11-02", month: "2026-11", valkey: TAG });
	// Untouched (the reservation still standing, a floor): every key holds the whole reservation.
	assert.deepEqual(deploymentWindowsOf(h, { applied: 0, target: 2 * USD, recorded: 2 * USD, valkey: TAG }), { day: "2026-11-03", week: "2026-11-02", month: "2026-11", valkey: TAG });
	// Only the windows the hold reserved in, in day, week, month order.
	assert.deepEqual(deploymentWindowsOf(hold({ deployment: [MONTH] }), { applied: 1, target: 1, recorded: 1, valkey: TAG }), { month: "2026-11", valkey: TAG });
});

test("deploymentWindowsOf: a partial settle with an OVERSHOOT leaves out the windows still at the reservation", () => {
	// Metered $3 under a $2 hold, the fault after the first key: the day holds $3, the week and month $2, the record $3.
	const h = hold();
	assert.deepEqual(deploymentWindowsOf(h, { applied: 1, target: 3 * USD, recorded: 3 * USD, valkey: TAG }), { day: "2026-11-03", valkey: TAG });
	// A downward partial settle keeps them all: the reservation is above what the record states.
	assert.deepEqual(deploymentWindowsOf(h, { applied: 1, target: 500_000, recorded: 500_000, valkey: TAG }), { day: "2026-11-03", week: "2026-11-02", month: "2026-11", valkey: TAG });
	// The fault before any key: the record says floor, every key holds the reservation.
	assert.deepEqual(deploymentWindowsOf(h, { applied: 0, target: 3 * USD, recorded: 2 * USD, valkey: TAG }), { day: "2026-11-03", week: "2026-11-02", month: "2026-11", valkey: TAG });
	// No key holds an overshoot when none was moved and the record states it: nothing to say.
	assert.equal(deploymentWindowsOf(h, { applied: 0, target: 3 * USD, recorded: 3 * USD, valkey: TAG }), null);
});

test("deploymentWindowsOf: a release that stopped part-way leaves out the windows it already gave back", () => {
	// The whole hold walked, the deployment's keys first: day and week given back, the fault at month.
	const h = hold({ scope: [SCOPE] });
	assert.deepEqual(deploymentWindowsOf(h, { applied: 2, target: 0, recorded: 2 * USD, valkey: TAG }), { month: "2026-11", valkey: TAG });
	// Given back everywhere (refunded, 0): every window holds 0 of this job's money, which is what the record states.
	assert.deepEqual(deploymentWindowsOf(h, { applied: 4, target: 0, recorded: 0, valkey: TAG }), { day: "2026-11-03", week: "2026-11-02", month: "2026-11", valkey: TAG });
	// Every deployment key given back and the fault on the scope's: no window holds the floor the record states.
	assert.equal(deploymentWindowsOf(h, { applied: 3, target: 0, recorded: 2 * USD, valkey: TAG }), null);
});

test("deploymentWindowsOf: the deployment ledger by its exact prefix, and null where there is none or no tag", () => {
	// A zero hold (no ledgers), a scope or model hold alone, and a hand-built hold carry no deployment window.
	assert.equal(deploymentWindowsOf({ amountMicros: 0, keys: [] }, { applied: 0, target: 0, recorded: 0, valkey: TAG }), null);
	assert.equal(deploymentWindowsOf(hold({ deployment: [], scope: [SCOPE], model: [MODEL] }), { applied: 2, target: 1, recorded: 1, valkey: TAG }), null);
	assert.equal(deploymentWindowsOf({ amountMicros: 2 * USD, keys: [DAY] }, { applied: 1, target: 1, recorded: 1, valkey: TAG }), null);
	// A scoped ledger whose prefix STARTS with the deployment's is not the deployment's.
	assert.equal(deploymentWindowsOf({ amountMicros: 1, keys: [DAY], ledgers: [{ keyPrefix: `${DOLLAR_KEY_PREFIX}:s:00`, keys: [DAY] }] }, { applied: 1, target: 1, recorded: 1, valkey: TAG }), null);
	for (const valkey of [null, undefined, "", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0"]) assert.equal(deploymentWindowsOf(hold(), { applied: 3, target: 1, recorded: 1, valkey }), null, String(valkey));
});

test("dollarsRecord carries reservedIn only when there is one, after the fields it always had", () => {
	assert.deepEqual(dollarsRecord({ reservedMicros: 2, settledMicros: 1, basis: "metered" }), { reservedMicros: 2, settledMicros: 1, basis: "metered", modelBasis: null });
	assert.deepEqual(Object.keys(dollarsRecord({ reservedMicros: 2, settledMicros: 1, basis: "metered", reservedIn: { day: "2026-11-03", valkey: TAG } })), ["reservedMicros", "settledMicros", "basis", "modelBasis", "reservedIn"]);
	assert.equal(Object.hasOwn(dollarsRecord({ reservedMicros: 2, settledMicros: 1, basis: "metered", reservedIn: null }), "reservedIn"), false);
});

// ---- the reader's rule ----

test("reservedInOf: real dates, a Monday week, a real month, at least one window and a tag, or null as a whole", () => {
	assert.deepEqual(reservedInOf({ day: "2026-11-03", week: "2026-11-02", month: "2026-11", valkey: TAG }), { day: "2026-11-03", week: "2026-11-02", month: "2026-11", valkey: TAG });
	assert.deepEqual(reservedInOf({ valkey: TAG, month: "2026-11", day: "2028-02-29" }), { day: "2028-02-29", month: "2026-11", valkey: TAG }, "rebuilt in its own order");
	assert.deepEqual(reservedInOf({ day: "2026-11-03", valkey: TAG, note: "x", host: "a" }), { day: "2026-11-03", valkey: TAG }, "anything else is not carried");
	for (const bad of [
		null,
		[],
		"2026-11-03",
		{ day: "2026-11-03" },
		{ valkey: TAG },
		{ day: "2026-02-30", valkey: TAG },
		{ day: "2026-11-3", valkey: TAG },
		{ day: "2026-11-03T00:00:00Z", valkey: TAG },
		{ week: "2026-11-03", valkey: TAG },
		{ week: "2026-13-02", valkey: TAG },
		{ month: "2026-13", valkey: TAG },
		{ month: "2026-00", valkey: TAG },
		{ month: "2026-1", valkey: TAG },
		{ day: 20261103, valkey: TAG },
		{ day: "2026-11-03", valkey: "0123456789ABCDEF" },
		{ day: "2026-11-03", valkey: "zz23456789abcdef" },
		{ day: "2026-11-03", week: "2026-11-03", valkey: TAG },
	]) assert.equal(reservedInOf(bad), null, JSON.stringify(bad));
	// Only OWN keys: an inherited member is no member.
	const inherited = Object.create({ day: "2026-11-03", valkey: TAG });
	assert.equal(reservedInOf(inherited), null);
	assert.equal(reservedInOf(Object.assign(Object.create({ week: "2026-11-03" }), { day: "2026-11-03", valkey: TAG })).week, undefined);
});

test("the record keeps reservedIn through its validator, and drops a malformed one without dropping the rest of dollars", () => {
	const record = (dollars) => buildRecord({ job: { id: "j", data: { kind: "github" } }, result: { outcome: "completed", dollars } }).dollars;
	const base = { reservedMicros: 2 * USD, settledMicros: 300_000, basis: "metered", modelBasis: null };
	assert.deepEqual(record({ ...base, reservedIn: { day: "2026-11-03", week: "2026-11-02", month: "2026-11", valkey: TAG } }), { ...base, reservedIn: { day: "2026-11-03", week: "2026-11-02", month: "2026-11", valkey: TAG } });
	assert.deepEqual(record({ ...base, reservedIn: { day: "2026-11-03", valkey: "not a tag" } }), base);
	assert.deepEqual(record({ ...base, reservedIn: { day: "2026-11-03", valkey: TAG, path: "/home/op" } }), { ...base, reservedIn: { day: "2026-11-03", valkey: TAG } });
	assert.deepEqual(record(base), base, "a record without it keeps the shape it had");
	assert.equal(JSON.stringify(record({ ...base, reservedIn: { day: "2026-11-03", valkey: TAG } })).includes("reservedIn"), true);
});

// ---- the floor ----

const rec = (host, settledMicros, reservedIn, extra = {}) => ({ jobId: `j-${Math.random()}`, host, dollars: { reservedMicros: 2 * USD, settledMicros, basis: "metered", modelBasis: null, ...(reservedIn === undefined ? {} : { reservedIn }) }, ...extra });
const CURRENT = { day: "2026-11-03", week: "2026-11-02", month: "2026-11" };

test("dollarWindowFloors sums this host's settled micro-dollars per current bucket, on this Valkey only", () => {
	const records = [
		rec("a", 1 * USD, { day: "2026-11-03", week: "2026-11-02", month: "2026-11", valkey: TAG }),
		rec("a", 2 * USD, { month: "2026-11", valkey: TAG }),
		rec("a", 4 * USD, { day: "2026-11-02", week: "2026-11-02", month: "2026-11", valkey: TAG }),
		// The previous month's last day: its money is in October's key, not November's.
		rec("a", 8 * USD, { day: "2026-10-31", week: "2026-10-26", month: "2026-10", valkey: TAG }),
		// Another host's, another Valkey's (a second deployment sharing this logs directory), none at all, malformed.
		rec("b", 16 * USD, { day: "2026-11-03", week: "2026-11-02", month: "2026-11", valkey: TAG }),
		rec("a", 32 * USD, { day: "2026-11-03", week: "2026-11-02", month: "2026-11", valkey: OTHER }),
		rec("a", 64 * USD, undefined),
		rec("a", 128 * USD, { day: "2026-11-03", valkey: "bad" }),
		rec("a", -1, { day: "2026-11-03", valkey: TAG }),
		rec("a", 1.5, { day: "2026-11-03", valkey: TAG }),
		// A refunded record states 0.
		rec("a", 0, { day: "2026-11-03", week: "2026-11-02", month: "2026-11", valkey: TAG }),
		{ jobId: "no-dollars", host: "a", dollars: null },
		null,
		"x",
	];
	assert.deepEqual(dollarWindowFloors(records, { host: "a", valkey: TAG, buckets: CURRENT }), { day: 1 * USD, week: 5 * USD, month: 7 * USD });
	// Only the windows asked for.
	assert.deepEqual(dollarWindowFloors(records, { host: "a", valkey: TAG, buckets: { month: "2026-11" } }), { month: 7 * USD });
	assert.deepEqual(dollarWindowFloors([], { host: "a", valkey: TAG, buckets: CURRENT }), { day: 0, week: 0, month: 0 });
	assert.deepEqual(dollarWindowFloors(null, { host: "a", valkey: TAG, buckets: {} }), {});
	// A record with no host (before v1.7.0) is no one's.
	assert.deepEqual(dollarWindowFloors([rec(undefined, USD, { day: "2026-11-03", valkey: TAG })], { host: undefined, valkey: TAG, buckets: { day: "2026-11-03" } }).day, USD, "the host is compared as given");
	assert.equal(dollarWindowFloors([rec(undefined, USD, { day: "2026-11-03", valkey: TAG })], { host: "a", valkey: TAG, buckets: { day: "2026-11-03" } }).day, 0);
});

test("dollarWindowFloors never overflows: a sum past a safe integer skips the record, which only lowers the floor", () => {
	const big = Number.MAX_SAFE_INTEGER - 1;
	const floors = dollarWindowFloors([rec("a", big, { day: "2026-11-03", valkey: TAG }), rec("a", 10, { day: "2026-11-03", valkey: TAG })], { host: "a", valkey: TAG, buckets: { day: "2026-11-03" } });
	assert.equal(floors.day, big);
});
