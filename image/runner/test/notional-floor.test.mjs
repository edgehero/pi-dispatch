import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHILD_LEDGER_ROWS, CHILD_LEDGER_VERSION, childLedger, createCostGuard, createUsageMeter, foldChildLedgers, ledgerNotionalCounts, parseChildLedger } from "../src/usage-meter.mjs";
import { GPT_6_1_CODEX, SONNET_4_5 } from "./helpers/catalog-models.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #1058: the floor counters a dollar settlement reads count a notional call too (a subscription with no paid extra
 * usage, which bills nothing), so one subscription call with an unknown price floored every billed dollar window of a
 * mixed attempt. The meter now says how many of its `unpriced` and `costUnreported` calls were notional
 * (`unpricedNotional`, `costUnreportedNotional`), each part of its total, and a pi child's ledger rows carry the same per
 * row, which the parent counts only on its own verified set. The cost guard's own floor counters never counted a
 * notional call: the first test pins that.
 */

const NOTIONAL = new Set(["openai-codex"]);
const SUBSCRIPTION = GPT_6_1_CODEX;
const BILLED = SONNET_4_5;
const ctxOf = (model, extra = {}) => ({ sessionId: "root", provider: model.provider, modelId: model.id, model, forwarded: () => false, ...extra });
const answer = (usage, extra = {}) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage, ...extra });
const priced = (cost) => answer({ input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200, cost: { total: cost } });
// Broken usage (issue #571's unreportedUsage): a finite price but no input side at all.
const broken = () => answer({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } });
const resolved = (message) => ({ result: () => Promise.resolve(message) });
const rejected = () => ({ result: () => Promise.reject(new Error("stream failed")) });
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Every way a call's cost is unknown, on `model`: a rejected result, an answer with no cost block, broken usage. */
function unknowns(meter, model) {
	meter.observe(rejected(), ctxOf(model));
	meter.observe(resolved(answer({ input: 10, output: 1, totalTokens: 11 })), ctxOf(model));
	meter.observe(resolved(broken()), ctxOf(model));
}

/** The notional parts are part of their totals, never beside them. */
function parts(snap, at) {
	assert.ok(snap.unpricedNotional <= snap.unpriced, `${at}: unpricedNotional within unpriced`);
	assert.ok(snap.costUnreportedNotional <= snap.costUnreported, `${at}: costUnreportedNotional within costUnreported`);
}

test("the cost guard counts none of its floor counters for a notional call: a notional call takes no ticket (#1058)", async () => {
	// The same calls through a guard that holds the subscription notional and one that does not. Only the second counts.
	const call = (model) => ({ method: "streamSimple", model, args: [{ messages: [{ role: "user", content: "fixture" }] }, { maxTokens: 10 }] });
	const longContext = answer({ input: 250_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 250_010, cost: { input: 0.75, output: 0.00015, cacheRead: 0, cacheWrite: 0, total: 0.75015 } });
	const drive = async (guard, model) => {
		for (const result of [undefined, rejected(), resolved(priced(0.5)), resolved(longContext), resolved(answer({ input: 0, output: 0, totalTokens: 0, cost: { total: 0 } }, { stopReason: "error", content: [] }))]) {
			assert.equal(guard.admit(call(model)), null);
			guard.bind(result);
			await flush();
		}
		return guard.snapshot();
	};
	// An anthropic model on both sides, so the long-context rule applies; the set decides which one is notional.
	const notional = await drive(createCostGuard({ capMicros: 100_000_000, bound: () => 600, notional: new Set(["anthropic"]) }), BILLED);
	const billed = await drive(createCostGuard({ capMicros: 100_000_000, bound: () => 600 }), BILLED);
	assert.deepEqual([billed.costUnanswered, billed.boundExceeded > 0, billed.longContext], [2, true, 1], "the premise: the same calls billed count all three");
	assert.deepEqual([notional.boundExceeded, notional.longContext, notional.costUnjudged, notional.costUnanswered], [0, 0, 0, 0], "notional, none of the four");
});

test("the meter counts a notional call's unknown price and broken usage apart, each part of its total, after costNotional (#1058)", async () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root", notionalProviders: NOTIONAL });
	parts(meter.snapshot(), "start");
	unknowns(meter, SUBSCRIPTION);
	await flush();
	parts(meter.snapshot(), "notional");
	unknowns(meter, BILLED);
	// A provider outside the set: billed, as every call on a provider the runner does not hold notional is.
	unknowns(meter, { ...SUBSCRIPTION, provider: "openai" });
	meter.observe(resolved(priced(0.25)), ctxOf(SUBSCRIPTION));
	await flush();
	const snap = meter.snapshot();
	parts(snap, "mixed");
	assert.deepEqual([snap.unpriced, snap.unpricedNotional, snap.costUnreported, snap.costUnreportedNotional], [6, 2, 3, 1]);
	const keys = Object.keys(snap);
	assert.deepEqual(keys.slice(keys.indexOf("costNotional")), ["costNotional", "unpricedNotional", "costUnreportedNotional"], "right after costNotional, the worker's TOKEN_KEYS order");
	// The exit line's usage rows never carry them: the worker reads those by a closed key list.
	for (const row of meter.usageSnapshot().models) assert.deepEqual([Object.hasOwn(row, "unpricedNotional"), Object.hasOwn(row, "costUnreportedNotional")], [false, false]);
	// Subscription entries with none notional (paid extra usage): present and 0.
	const none = createUsageMeter({ maxTokens: null, notionalProviders: new Set() });
	unknowns(none, SUBSCRIPTION);
	await flush();
	assert.deepEqual([none.snapshot().unpricedNotional, none.snapshot().costUnreportedNotional], [0, 0]);
});

test("a meter with no notional set writes the snapshot it wrote before, byte for byte (#1058)", async () => {
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	unknowns(meter, SUBSCRIPTION);
	unknowns(meter, BILLED);
	await flush();
	assert.equal(JSON.stringify(meter.snapshot()), '{"input":20,"output":2,"total":22,"cost":0,"metered":true,"rootTotal":22,"otherTotal":0,"looseTotal":0,"sessions":1,"calls":6,"unresolved":0,"unpriced":4,"costUnreported":2}');
});

/** A child's ledger written as the preload writes it, in a real ledger directory, and the parent's fold over it. */
function childJob(child, { parentSet = NOTIONAL, name = "4242.0123456789abcdef.json" } = {}) {
	const dir = tempDir("pi-dispatch-notional-floor-");
	const ledger = childLedger({ state: "done", meter: child });
	writeFileSync(join(dir, name), JSON.stringify(ledger));
	return { ledger, dir, fold: foldChildLedgers({ dir, notional: parentSet }) };
}

test("a child's ledger rows carry its notional unpriced and broken-usage calls, and the parent counts them on its own set only (#1058)", async () => {
	const child = createUsageMeter({ maxTokens: null, notionalProviders: NOTIONAL });
	unknowns(child, SUBSCRIPTION);
	unknowns(child, BILLED);
	await flush();
	const { ledger, fold } = childJob(child);
	assert.equal(ledger.v, CHILD_LEDGER_VERSION);
	assert.equal(CHILD_LEDGER_VERSION, 5);
	const subscriptionRow = ledger.rows.find((row) => row.provider === SUBSCRIPTION.provider);
	const billedRow = ledger.rows.find((row) => row.provider === BILLED.provider);
	assert.deepEqual([subscriptionRow.unpricedNotional, subscriptionRow.costUnreportedNotional], [2, 1]);
	assert.deepEqual([Object.hasOwn(billedRow, "unpricedNotional"), Object.hasOwn(billedRow, "costUnreportedNotional")], [false, false], "written only when above 0");
	assert.deepEqual([fold.unmetered, fold.unpricedNotional, fold.costUnreportedNotional], [0, 2, 1]);
	// The parent adds them to its own, after the children's totals.
	const parent = createUsageMeter({ maxTokens: null, rootSessionId: "root", notionalProviders: NOTIONAL });
	parent.observe(rejected(), ctxOf(SUBSCRIPTION));
	await flush();
	parent.setChildren(fold);
	const snap = parent.snapshot();
	parts(snap, "parent");
	assert.deepEqual([snap.unpriced, snap.unpricedNotional, snap.costUnreported, snap.costUnreportedNotional], [5, 3, 2, 1]);
	for (const row of parent.usageSnapshot().models) assert.equal(Object.hasOwn(row, "unpricedNotional") || Object.hasOwn(row, "costUnreportedNotional"), false, "never on the exit line's usage rows");
	// A parent that does not hold the child's provider notional reads those calls as billed: a mark is not proof.
	for (const parentSet of [new Set(["anthropic"]), null]) {
		const other = childJob(child, { parentSet }).fold;
		assert.deepEqual([other.unmetered, other.unpricedNotional, other.costUnreportedNotional], [0, 0, 0], String(parentSet && [...parentSet]));
	}
	// A parent with no set writes no notional keys at all, whatever the fold counted.
	const plain = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	plain.setChildren(fold);
	assert.equal(Object.hasOwn(plain.snapshot(), "unpricedNotional"), false);
});

test("a ledger whose notional counts are past what a row or the file can carry, not counts, or on the model-less row, is malformed (#1058)", async () => {
	const child = createUsageMeter({ maxTokens: null, notionalProviders: NOTIONAL });
	unknowns(child, SUBSCRIPTION);
	child.observe(resolved(priced(0.25)), ctxOf(SUBSCRIPTION));
	await flush();
	const good = childLedger({ state: "running", meter: child });
	assert.notEqual(parseChildLedger(JSON.stringify(good)), null, "the premise: the meter's own ledger parses");
	const at = good.rows.findIndex((row) => row.provider === SUBSCRIPTION.provider);
	const withRow = (fields, rows = good.rows) => JSON.stringify({ ...good, rows: rows.map((row, i) => (i === at ? { ...row, ...fields } : row)) });
	const row = good.rows[at];
	const bad = {
		"unpricedNotional above the row's unpriced": withRow({ unpricedNotional: row.unpriced + 1 }),
		// The file's costUnreported raised to hold it, so only the row's own bound refuses it.
		"costUnreportedNotional above the row's priced calls": JSON.stringify({ ...JSON.parse(withRow({ costUnreportedNotional: row.calls - row.unpriced + 1 })), costUnreported: row.calls }),
		"costUnreportedNotional above the file's costUnreported": JSON.stringify({ ...JSON.parse(withRow({ costUnreportedNotional: 2 })), costUnreported: 1 }),
		"a string": withRow({ unpricedNotional: "1" }),
		"a negative count": withRow({ costUnreportedNotional: -1 }),
		"a fraction": withRow({ unpricedNotional: 0.5 }),
		"on the model-less row": JSON.stringify({ ...good, rows: [...good.rows.filter((r, i) => i !== at), { ...row, provider: null, model: null }] }),
		"version 4": JSON.stringify({ ...good, v: 4 }),
	};
	for (const [what, text] of Object.entries(bad)) {
		assert.equal(parseChildLedger(text), null, what);
		const dir = tempDir("pi-dispatch-notional-floor-");
		writeFileSync(join(dir, "4242.0123456789abcdef.json"), text);
		const fold = foldChildLedgers({ dir, notional: NOTIONAL });
		assert.deepEqual([fold.unmetered, fold.files.get("4242.0123456789abcdef.json").why, fold.unpricedNotional], [1, "malformed", 0], what);
	}
	// A count that only shrinks in a live child is a shrink, so the file counts as unmetered and keeps its mark.
	const dir = tempDir("pi-dispatch-notional-floor-");
	const name = "4242.0123456789abcdef.json";
	writeFileSync(join(dir, name), JSON.stringify(good));
	const first = foldChildLedgers({ dir, notional: NOTIONAL });
	writeFileSync(join(dir, name), withRow({ unpricedNotional: 1 }));
	const second = foldChildLedgers({ dir, notional: NOTIONAL, prev: first });
	assert.deepEqual([second.unmetered, second.files.get(name).why, second.unpricedNotional], [1, "shrank", first.unpricedNotional]);
});

test("the model-less bucket never carries a notional count: a notional call with no recordable pair is billed to the parent (#1058)", async () => {
	const child = createUsageMeter({ maxTokens: null, notionalProviders: NOTIONAL });
	// No model id, and a model id the worker's pattern refuses: both land in the bucket.
	child.observe(rejected(), ctxOf(SUBSCRIPTION, { modelId: undefined }));
	child.observe(rejected(), ctxOf(SUBSCRIPTION, { modelId: "has space" }));
	await flush();
	const ledger = childLedger({ state: "done", meter: child });
	assert.deepEqual(ledger.rows.map((row) => [row.provider, row.unpriced, Object.hasOwn(row, "unpricedNotional")]), [[null, 2, false]]);
	assert.equal(child.snapshot().unpricedNotional, 2, "the child's own line still counts them");
	const { fold } = childJob(child);
	assert.deepEqual([fold.unmetered, fold.totals.unpriced, fold.unpricedNotional], [0, 2, 0]);
	// Past the rows a child writes, a named row folds into the bucket and its counts go with it.
	const many = createUsageMeter({ maxTokens: null, notionalProviders: NOTIONAL });
	for (let i = 0; i < CHILD_LEDGER_ROWS; i += 1) many.observe(resolved(priced(0.001)), ctxOf({ ...SUBSCRIPTION, id: `m${i}` }));
	many.observe(rejected(), ctxOf({ ...SUBSCRIPTION, id: "late" }));
	await flush();
	const rows = childLedger({ state: "done", meter: many }).rows;
	assert.equal(rows.length, CHILD_LEDGER_ROWS);
	assert.deepEqual([rows.at(-1).provider, rows.at(-1).unpriced, Object.hasOwn(rows.at(-1), "unpricedNotional")], [null, 1, false]);
});

test("ledgerNotionalCounts caps each row by what it carries and each sum by the mark's own total (#1058)", () => {
	const row = (provider, fields) => ({ provider, model: "m", calls: 4, unpriced: 2, ...fields });
	const mark = (rows, extra = {}) => ({ totals: { unpriced: 2 }, costUnreported: 2, ...extra, rows: new Map(rows.map((r, i) => [String(i), r])) });
	assert.deepEqual(ledgerNotionalCounts(mark([row("openai-codex", { unpricedNotional: 2, costUnreportedNotional: 2 })]), NOTIONAL), { unpricedNotional: 2, costUnreportedNotional: 2 });
	assert.deepEqual(ledgerNotionalCounts(mark([row("openai-codex", { unpricedNotional: 9, costUnreportedNotional: 9 })]), NOTIONAL), { unpricedNotional: 2, costUnreportedNotional: 2 }, "a row's own counts");
	// A row past its own bound beside one at none, under totals that would hold both: only the row's cap says so.
	const roomy = { totals: { unpriced: 9 }, costUnreported: 9 };
	assert.deepEqual(ledgerNotionalCounts(mark([row("openai-codex", { unpriced: 1, unpricedNotional: 3, costUnreportedNotional: 5 }), row("openai-codex", { calls: 2, unpriced: 2 })], roomy), NOTIONAL), { unpricedNotional: 1, costUnreportedNotional: 3 }, "each row's cap, the mark's totals aside");
	assert.deepEqual(ledgerNotionalCounts(mark([row("openai-codex", { unpricedNotional: 2, costUnreportedNotional: 2 }), row("openai-codex", { unpricedNotional: 2, costUnreportedNotional: 2 })], { totals: { unpriced: 3 }, costUnreported: 1 }), NOTIONAL), { unpricedNotional: 3, costUnreportedNotional: 1 }, "the mark's totals");
	assert.deepEqual(ledgerNotionalCounts(mark([row("anthropic", { unpricedNotional: 2, costUnreportedNotional: 2 }), row(null, { unpricedNotional: 2 })]), NOTIONAL), { unpricedNotional: 0, costUnreportedNotional: 0 }, "off the set, or no provider");
	assert.deepEqual(ledgerNotionalCounts(mark([row("openai-codex", { unpricedNotional: "2", costUnreportedNotional: -1 })]), NOTIONAL), { unpricedNotional: 0, costUnreportedNotional: 0 }, "not counts");
	assert.deepEqual(ledgerNotionalCounts(mark([row("openai-codex", { unpricedNotional: 2 })]), null), { unpricedNotional: 0, costUnreportedNotional: 0 }, "no set");
});

test("a retired child's counts stay in the fold, on the pass that retires it and on every later one (#1058)", async () => {
	const child = createUsageMeter({ maxTokens: null, notionalProviders: NOTIONAL });
	unknowns(child, SUBSCRIPTION);
	await flush();
	const { dir } = childJob(child);
	const retire = () => true;
	const first = foldChildLedgers({ dir, notional: NOTIONAL, retire });
	assert.deepEqual([first.retired.count, first.files.size], [1, 0], "the premise: its process is gone, so its file retired");
	assert.deepEqual([first.unpricedNotional, first.costUnreportedNotional], [2, 1]);
	const later = foldChildLedgers({ dir, notional: NOTIONAL, retire, prev: first });
	assert.deepEqual([later.unpricedNotional, later.costUnreportedNotional, later.totals.unpriced], [2, 1, 2]);
});

test("the meter keeps the children's counts as high-water marks, and never above the totals they are part of (#1058)", () => {
	const fold = (unpriced, costUnreported, unpricedNotional, costUnreportedNotional) => ({ processes: 1, unmetered: 0, totals: { input: 0, output: 0, total: 0, cost: 0, calls: unpriced + costUnreported, unresolved: 0, unpriced, sessions: 1 }, rows: [], costUnreported, notionalCost: 0, unpricedNotional, costUnreportedNotional });
	const counts = (meter) => {
		const snap = meter.snapshot();
		parts(snap, "snapshot");
		return [snap.unpriced, snap.unpricedNotional, snap.costUnreported, snap.costUnreportedNotional];
	};
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root", notionalProviders: NOTIONAL });
	meter.setChildren(fold(2, 1, 2, 1));
	assert.deepEqual(counts(meter), [2, 2, 1, 1]);
	// A later fold that counts less (one that lost its `prev`) cannot take a counted part back.
	meter.setChildren(fold(2, 1, 0, 0));
	assert.deepEqual(counts(meter), [2, 2, 1, 1]);
	// A fold whose parts are above its totals is held to them: the snapshot's bound is written, not assumed.
	const over = createUsageMeter({ maxTokens: null, rootSessionId: "root", notionalProviders: NOTIONAL });
	over.setChildren(fold(1, 1, 5, 4));
	assert.deepEqual(counts(over), [1, 1, 1, 1]);
});

test("two rows of one pair in a ledger add their counts, as they add every other number (#1058)", async () => {
	const child = createUsageMeter({ maxTokens: null, notionalProviders: NOTIONAL });
	unknowns(child, SUBSCRIPTION);
	await flush();
	const good = childLedger({ state: "done", meter: child });
	const { unpricedNotional: _u, costUnreportedNotional: _c, ...whole } = good.rows[0];
	assert.deepEqual([whole.calls, whole.unpriced, _u, _c], [3, 2, 2, 1], "the premise: one row, both counts");
	// The same row written as two, the broken-usage call in one and the two unpriced ones in the other, in either order.
	const brokenRow = { ...whole, calls: 1, unpriced: 0, input: 0, output: 0, total: 0, costUnreportedNotional: 1 };
	const unpricedRow = { ...whole, calls: 2, unpriced: 2, unpricedNotional: 2 };
	for (const rows of [[brokenRow, unpricedRow], [unpricedRow, brokenRow]]) {
		const parsed = parseChildLedger(JSON.stringify({ ...good, rows }));
		assert.notEqual(parsed, null, "the rows still partition the totals");
		assert.equal(parsed.rows.size, 1);
		const dir = tempDir("pi-dispatch-notional-floor-");
		writeFileSync(join(dir, "4242.0123456789abcdef.json"), JSON.stringify({ ...good, rows }));
		const fold = foldChildLedgers({ dir, notional: NOTIONAL });
		assert.deepEqual([fold.unmetered, fold.unpricedNotional, fold.costUnreportedNotional], [0, 2, 1], rows[0] === brokenRow ? "broken first" : "unpriced first");
	}
});
