import assert from "node:assert/strict";
import { test } from "node:test";
import { billedModelRows, candidateWindowReservation, notionalConnection, notionalProvidersOf, notionalSnapshotProviders, reserveVerdict, zeroRatedFor } from "../src/reserve-estimate.mjs";
import { billedFloorCount, dollarSettlement, FLOOR_COUNTERS, modelDollarSettlement, NOTIONAL_FLOOR_PARTS, notionalMicros } from "../src/dollar-budget.mjs";
import { makeSubscriptionRuntime, subscriptionRoutes } from "../src/subscription-runtime.mjs";
import { subscriptionRoutes as leafRoutes } from "../src/model-ref.mjs";
import { buildContainerEnv } from "../src/env-allowlist.mjs";
import { buildRecord, NOTIONAL_PROVIDERS, parseExitTokens, TOKEN_KEYS } from "../src/run-history.mjs";
import { COMMUNITY_AUTH_ADAPTERS } from "../src/community-auth-metadata.mjs";
import { selectFailoverJob } from "../src/model-failover.mjs";
import { selectRandomModelJob } from "../src/model-selection.mjs";

// Issue #1008: the per-job cost cap and the dollar windows count only billed calls. A subscription connection with no
// paid extra usage is notional: the worker marks its snapshot, a job that reaches no billed route reserves nothing but
// keeps its cap, notional providers' model rows leave the ledgers, and the settlement charges the billed part only.

const USD = 1_000_000;
const instant = 1_800_000_000_000;
/** One declared endpoint serving `local-ollama/q` at zero cost (reserve-estimate.test.mjs's fixture). */
const modelEndpoints = { endpoints: [{ id: "mac-ollama", host: "host.docker.internal", port: 11434, slots: 2, keyless: true }], models: { providers: { "local-ollama": { api: "openai-completions", baseUrl: "http://host.docker.internal:11434/v1", apiKey: "$PI_DISPATCH_KEYLESS", models: [{ id: "q" }] } } } };
const claude = { provider: "anthropic", model: "claude-opus-5-5", models: ["anthropic/claude-opus-5-5"], maxCostMicros: 150 * USD };

test("a connection is notional only with no paid extra usage; the check and snapshot readers keep any doubt billed", () => {
	for (const credit of [undefined, null, 0, -1, 1.5, "400000", Number.MAX_SAFE_INTEGER + 1]) assert.equal(notionalConnection({ provider: "anthropic", extraUsageCreditMicros: credit }), true, String(credit));
	assert.equal(notionalConnection({ provider: "anthropic", extraUsageCreditMicros: 400_000 }), false, "paid extra usage may bill any call");
	assert.equal(notionalConnection(null), false);
	const checked = { ok: true, managed: [{ provider: "anthropic" }, { provider: "openai", extraUsageCreditMicros: 1 }] };
	assert.deepEqual([...notionalProvidersOf(checked)], ["anthropic"]);
	for (const doubt of [null, undefined, { ok: false, managed: true, reason: "auth-credit-cap-required" }, { ok: true, managed: false }, { ok: true }, { ...checked, ok: undefined }]) assert.equal(notionalProvidersOf(doubt).size, 0, JSON.stringify(doubt));
	assert.deepEqual([...notionalSnapshotProviders([{ provider: "anthropic", notional: true }, { provider: "openai" }, { provider: "openai", notional: "true" }])], ["anthropic"]);
	assert.equal(notionalSnapshotProviders(null).size, 0);
	assert.deepEqual(leafRoutes({ ...claude, auxiliaryModels: ["openrouter/x"], models: [...claude.models, "openrouter/x"] }), subscriptionRoutes({ ...claude, auxiliaryModels: ["openrouter/x"], models: [...claude.models, "openrouter/x"] }), "one routes rule, re-exported");
});

test("reserveVerdict: subscription-only reserves nothing and keeps its cap; a billed route, paid overage or doubt reserves the cap", () => {
	const notional = new Set(["anthropic"]);
	assert.deepEqual(reserveVerdict(claude, { notional, modelEndpoints }), { reserve: "none", zeroRated: false }, "every route notional");
	// Mixed: an API-key auxiliary (the issue's OpenRouter) is a billed route, so the cap is reserved and bounds it.
	const mixed = { ...claude, models: [...claude.models, "openrouter/vendor/aux"], auxiliaryModels: ["openrouter/vendor/aux"] };
	assert.deepEqual(reserveVerdict(mixed, { notional, modelEndpoints }), { reserve: "cap", zeroRated: false });
	// Paid overage: the worker never marks it, so it is not in the set and its calls are billed.
	assert.deepEqual(reserveVerdict(claude, { notional: new Set(), modelEndpoints }), { reserve: "cap", zeroRated: false });
	assert.deepEqual(reserveVerdict(claude, { modelEndpoints }), { reserve: "cap", zeroRated: false }, "no set at all: today's rule");
	// Zero-rated beside the subscription: nothing billed either, and the cap stays (it is no zero-rated job).
	assert.deepEqual(reserveVerdict({ ...claude, models: [...claude.models, "local-ollama/q"] }, { notional, modelEndpoints }), { reserve: "none", zeroRated: false });
	// A decision role on an API provider is a route too, outside the model list.
	assert.deepEqual(reserveVerdict({ ...claude, watchDecisionModel: { provider: "openrouter", id: "judge" } }, { notional, modelEndpoints }), { reserve: "cap", zeroRated: false });
	// A list entry that does not split is billed (fail closed), and so is a job with no list: it may switch to any model.
	assert.deepEqual(reserveVerdict({ ...claude, models: [...claude.models, "no-slash"] }, { notional, modelEndpoints }), { reserve: "cap", zeroRated: false });
	for (const models of [undefined, null, []]) assert.deepEqual(reserveVerdict({ ...claude, models }, { notional, modelEndpoints }), { reserve: "cap", zeroRated: false }, JSON.stringify(models));
	// The zero-rated rule comes first and is unchanged: a cap of 0, or every callable model zero-rated.
	assert.deepEqual(reserveVerdict({ ...claude, maxCostMicros: 0 }, { notional, modelEndpoints }), { reserve: "none", zeroRated: true });
	const local = { provider: "local-ollama", model: "q", models: ["local-ollama/q"], maxCostMicros: USD };
	assert.deepEqual(reserveVerdict(local, { modelEndpoints }), { reserve: "none", zeroRated: true });
	assert.equal(zeroRatedFor(local, { modelEndpoints }).zeroRated, true);
});

test("notional providers' model rows leave the ledgers; billed providers' rows stay", () => {
	const rows = [{ ref: "anthropic/claude-opus-5-5", keyPrefix: "a", caps: {} }, { ref: "openrouter/vendor/aux", keyPrefix: "b", caps: {} }, { ref: "openai/gpt-5.5", keyPrefix: "c", caps: {} }];
	assert.deepEqual(billedModelRows(rows, new Set(["anthropic"])).map((row) => row.keyPrefix), ["b", "c"]);
	assert.deepEqual(billedModelRows(rows, new Set()).map((row) => row.keyPrefix), ["a", "b", "c"]);
	assert.deepEqual(billedModelRows(rows, null).map((row) => row.keyPrefix), ["a", "b", "c"]);
	assert.deepEqual(billedModelRows(null, new Set(["anthropic"])), []);
	// A pickup candidate's model windows: skipped for a notional connection the candidate's own check admitted.
	const candidate = { provider: "anthropic", model: "claude-opus-5-5", maxCostMicros: 3 * USD };
	assert.equal(candidateWindowReservation(candidate, { ok: true, managed: [{ provider: "anthropic" }] }), 0);
	assert.equal(candidateWindowReservation(candidate, { ok: true, managed: [{ provider: "anthropic", extraUsageCreditMicros: 5 * USD }] }), 3 * USD, "paid extra usage keeps its window");
	assert.equal(candidateWindowReservation(candidate, { ok: true, managed: [{ provider: "openai" }] }), 3 * USD, "an auxiliary's notional connection is not the candidate's");
	assert.equal(candidateWindowReservation(candidate, null), 3 * USD, "no check, no exemption");
});

test("settlement charges the billed part: present, absent (older image), inconsistent, malformed and untrusted costNotional", () => {
	const complete = { metered: true, calls: 2, costCapMicros: 5 * USD, ...Object.fromEntries(FLOOR_COUNTERS.map((key) => [key, 0])) };
	const usage = { v: 1, truncated: 0, models: [] };
	const settle = (tokens, trusted = true) => dollarSettlement({ tokens: { ...complete, ...tokens }, usage, reservedMicros: 5 * USD, trusted });
	assert.deepEqual(settle({ cost: 3.25, costNotional: 3 }), { settledMicros: 250_000, basis: "metered" }, "$3.25 metered, $3.00 notional: $0.25 billed");
	assert.deepEqual(settle({ cost: 3.25 }), { settledMicros: 3_250_000, basis: "metered" }, "no costNotional: an older image, all billed");
	assert.deepEqual(settle({ cost: 3.25, costNotional: 0 }), { settledMicros: 3_250_000, basis: "metered" });
	assert.deepEqual(settle({ cost: 1.5, costNotional: 1.5 }), { settledMicros: 0, basis: "metered" }, "all notional: nothing billed");
	// Rounded the money-safe way: the cost up, the notional part down.
	assert.deepEqual(settle({ cost: 0.1 + 0.2, costNotional: 0.0000019 }), { settledMicros: 300_000, basis: "metered" }, "300,001 up less 1 down");
	assert.deepEqual(settle({ cost: 3.25, costNotional: 3.26 }), { settledMicros: 5 * USD, basis: "floor" }, "above the cost: the floor, on the whole cost");
	assert.deepEqual(settle({ cost: 9, costNotional: 9.5 }), { settledMicros: 9 * USD, basis: "floor" }, "the floor keeps a known whole cost above the reservation");
	for (const bad of [-1, Number.MAX_VALUE, "3", null, Infinity]) assert.equal(settle({ cost: 3.25, costNotional: bad }).basis, "floor", String(bad));
	// Untrusted: never read, so a forged costNotional cannot lower the floor below the whole cost.
	assert.deepEqual(settle({ cost: 9, costNotional: 9 }, false), { settledMicros: 9 * USD, basis: "floor" });
	// A floor counter on a trusted line floors at the billed part, since the notional part is known.
	assert.deepEqual(settle({ cost: 9, costNotional: 8, unpriced: 1 }), { settledMicros: 5 * USD, basis: "floor" });
	assert.deepEqual(settle({ cost: 9, costNotional: 2, unpriced: 1 }), { settledMicros: 7 * USD, basis: "floor" });
	// The fallback meter's line is never read for it.
	assert.deepEqual(settle({ metered: false, cost: 9, costNotional: 9 }), { settledMicros: 9 * USD, basis: "floor" });
	assert.equal(notionalMicros({ cost: 1 }, USD), 0);
	assert.equal(notionalMicros({ costNotional: 0.5 }, null), null, "a cost that does not convert cannot carry a notional part");
	assert.equal(notionalMicros(null, USD), 0);
});

test("issue #1058: unpriced and costUnreported floor by their billed part, read only beside a valid costNotional on a trusted metered line", () => {
	const complete = { metered: true, calls: 4, costCapMicros: 5 * USD, ...Object.fromEntries(FLOOR_COUNTERS.map((key) => [key, 0])) };
	const usage = { v: 1, truncated: 0, models: [] };
	const settle = (tokens, trusted = true) => dollarSettlement({ tokens: { ...complete, ...tokens }, usage, reservedMicros: 5 * USD, trusted });
	const metered = { settledMicros: 250_000, basis: "metered" };
	const floor = { settledMicros: 5 * USD, basis: "floor" };
	const mixed = { cost: 3.25, costNotional: 3, unpriced: 1, unpricedNotional: 1, costUnreported: 2, costUnreportedNotional: 2 };
	assert.deepEqual(settle(mixed), metered, "every unknown cost on a subscription: metered at the billed $0.25");
	assert.deepEqual(settle({ ...mixed, unpriced: 2 }), floor, "one billed unpriced call: the floor");
	assert.deepEqual(settle({ ...mixed, costUnreported: 3 }), floor, "one billed broken-usage call: the floor");
	const { unpricedNotional: _u, costUnreportedNotional: _c, ...older } = mixed;
	assert.deepEqual(settle(older), floor, "an image from before the keys: every such call billed, the floor");
	assert.deepEqual(settle({ ...older, costUnreported: 0 }), floor, "one key absent is 0 for that counter alone");
	assert.deepEqual(settle({ ...mixed, unpricedNotional: 2 }), floor, "a count above its total");
	for (const bad of [0.5, -1, "1", null, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
		assert.deepEqual(settle({ ...mixed, unpricedNotional: bad }), floor, `unpricedNotional ${String(bad)}`);
		assert.deepEqual(settle({ ...mixed, costUnreportedNotional: bad }), floor, `costUnreportedNotional ${String(bad)}`);
	}
	assert.deepEqual(settle({ ...mixed, unpriced: 1.5, unpricedNotional: 1 }), floor, "a total that is not a count");
	// A count that is not a safe integer at or above 0 beside a valid part and a valid costNotional: the floor, never the
	// part taken off a value that only coerces to a number ("1" - 1 is 0).
	for (const bad of ["1", true, [1], 1.5, -1]) {
		assert.deepEqual(settle({ ...mixed, unpriced: bad, unpricedNotional: 1 }), floor, `unpriced ${JSON.stringify(bad)}`);
		assert.deepEqual(settle({ ...mixed, costUnreported: bad, costUnreportedNotional: 1 }), floor, `costUnreported ${JSON.stringify(bad)}`);
	}
	// Never read where costNotional is not: an untrusted line, the fallback meter, no costNotional, or a malformed one.
	assert.deepEqual(settle(mixed, false), { settledMicros: 5 * USD, basis: "floor" }, "an untrusted line: forged counts lower nothing");
	assert.deepEqual(settle({ ...mixed, metered: false }), floor);
	const { costNotional: _n, ...noNotional } = mixed;
	assert.deepEqual(settle(noNotional), floor, "counts without costNotional are not the meter's: every call billed");
	assert.deepEqual(settle({ ...mixed, costNotional: "3" }), floor);
	// The other six counters count every call, a notional part or not.
	for (const key of FLOOR_COUNTERS.filter((k) => !Object.hasOwn(NOTIONAL_FLOOR_PARTS, k))) assert.deepEqual(settle({ ...mixed, [key]: 1, [`${key}Notional`]: 1 }), floor, key);
	assert.deepEqual(Object.entries(NOTIONAL_FLOOR_PARTS), [["unpriced", "unpricedNotional"], ["costUnreported", "costUnreportedNotional"]]);
	// The billed model's window settles from its own row, as on any metered line.
	const rows = { v: 1, truncated: 0, models: [{ provider: "anthropic", model: "claude-opus-5-5", cost: 0.25 }, { provider: "openai-codex", model: "gpt-6.1-sol", cost: 3 }] };
	const job = dollarSettlement({ tokens: { ...complete, ...mixed }, usage: rows, reservedMicros: 5 * USD, trusted: true });
	assert.deepEqual(job, metered);
	assert.deepEqual(modelDollarSettlement({ ref: "anthropic/claude-opus-5-5", basis: job.basis, tokens: { ...complete, ...mixed }, usage: rows, reservedMicros: 5 * USD, trusted: true }), metered);
	// billedFloorCount itself: the count less its part, or the count as it is when the part is not read.
	assert.equal(billedFloorCount({ unpriced: 3, unpricedNotional: 2 }, "unpriced", true), 1);
	assert.equal(billedFloorCount({ unpriced: 3, unpricedNotional: 2 }, "unpriced", false), 3);
	assert.equal(billedFloorCount({ unpriced: 3 }, "unpriced", true), 3);
	assert.equal(billedFloorCount({ unpriced: 3, unpricedNotional: 4 }, "unpriced", true), null);
	assert.equal(billedFloorCount({ unresolved: 3, unresolvedNotional: 3 }, "unresolved", true), 3);
	assert.equal(billedFloorCount({}, "unpriced", true), undefined, "absent stays absent, so the caller floors");
});

test("issue #1058: the record keeps unpricedNotional and costUnreportedNotional right after costNotional, numbers only", () => {
	const line = { input: 1, output: 2, total: 3, cost: 3.25, metered: true, rootTotal: 3, otherTotal: 0, looseTotal: 0, sessions: 1, calls: 3, unresolved: 0, unpriced: 1, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, costUnreported: 1, costNotional: 3, unpricedNotional: 1, costUnreportedNotional: 1, costCapMicros: 5 * USD };
	assert.equal(JSON.stringify(parseExitTokens(`{"event":"exit","tokens":${JSON.stringify(line)}}`)), JSON.stringify(line), "byte-identical round trip");
	const at = TOKEN_KEYS.indexOf("costNotional");
	assert.deepEqual(TOKEN_KEYS.slice(at, at + 3), ["costNotional", "unpricedNotional", "costUnreportedNotional"]);
	const words = parseExitTokens('{"event":"exit","tokens":{"total":1,"unpricedNotional":"1","costUnreportedNotional":[1]}}');
	assert.deepEqual([Object.hasOwn(words, "unpricedNotional"), Object.hasOwn(words, "costUnreportedNotional")], [false, false], "numbers only");
	assert.equal(FLOOR_COUNTERS.includes("unpricedNotional") || FLOOR_COUNTERS.includes("costUnreportedNotional"), false, "parts, never counters of their own");
});

test("the worker marks a snapshot notional only for a connection with no paid extra usage, prepared from the row it checked", async () => {
	const connection = { id: "claude", connectionId: "claude", provider: "anthropic", ownerHost: "owner", adapter: "pi-anthropic-oauth@0.3.6", accountGroup: "opaque-group", generation: 2 };
	const job = { provider: "anthropic", model: "sonnet", models: ["anthropic/sonnet"], maxCostMicros: 500_000 };
	// `paidAtSnapshot` sets a credit between the check and prepareSnapshot (the auth layer's bindingSignature hashes
	// the whole connection, credit included, so the snapshot then carries the paid row's signature).
	const prepared = async (row, { snapshotExtra = {}, paidAtSnapshot = false } = {}) => {
		let current = { ...row };
		const signed = () => ({ ...current, bindingSignature: Number.isSafeInteger(current.extraUsageCreditMicros) ? "sig-paid" : "sig-unpaid" });
		const runtime = makeSubscriptionRuntime({
			auth: {
				check: async (provider) => (provider === row.provider ? { ok: true, managed: true, ...signed() } : { ok: true, managed: false }),
				prepareSnapshot: async () => {
					if (paidAtSnapshot) current = { ...current, extraUsageCreditMicros: 400_000 };
					return { ok: true, snapshot: { kind: "subscription", provider: row.provider, connectionId: row.connectionId, adapter: row.adapter, accountGroup: row.accountGroup, generation: row.generation, expiresAt: instant + 4_000_000, deadlineAt: instant + 1_800_000, bindingSignature: signed().bindingSignature, env: { ANTHROPIC_OAUTH_TOKEN: "private-access" }, ...snapshotExtra } };
				},
				validateSnapshot: async (snapshot) => signed().bindingSignature === snapshot.bindingSignature,
				status: async () => [signed()],
			},
			quota: { admit: async () => ({ ok: true }), record: async () => ({ ok: true }), read: async () => ({ state: "unknown" }) },
			now: () => instant,
			lookup: () => ({ api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }),
			packageRootFor: () => ({ root: "/opt/pi-global/packages/claude", digest: "a".repeat(64) }),
		});
		const result = await runtime.prepare(job, { deadlineAt: instant + 1_800_000, attemptId: "delivery-1" });
		assert.equal(result.ok, true);
		assert.equal(await runtime.validate(result.snapshots), true, "and the snapshot still validates before the container starts");
		return result.snapshots[0];
	};
	assert.equal((await prepared(connection)).notional, true);
	const paid = await prepared({ ...connection, extraUsageCreditMicros: 500_000 });
	assert.equal(Object.hasOwn(paid, "notional"), false, "paid extra usage: no marker, so every call counts");
	assert.equal(Object.hasOwn(await prepared({ ...connection, extraUsageCreditMicros: 500_000 }, { snapshotExtra: { notional: true } }), "notional"), false, "a marker from the auth layer is not taken");
	// A credit set after the check: the row said no paid extra usage, the snapshot is the paid binding. No marker.
	assert.equal(Object.hasOwn(await prepared(connection, { paidAtSnapshot: true }), "notional"), false, "a snapshot not prepared from the checked row is never marked");
});

test("PI_SUBSCRIPTION_AUTH carries notional: true only when the snapshot was marked, byte-identical otherwise", () => {
	const snapshot = { provider: "anthropic", connectionId: "claude", adapter: "pi-anthropic-oauth@0.3.6", generation: 1, expiresAt: 1_900_010_000_000, deadlineAt: 1_900_000_000_000, root: "/opt/pi-global/packages/claude", digest: "a".repeat(64), env: { ANTHROPIC_OAUTH_TOKEN: "access-only" } };
	const entries = (extra) => JSON.parse(buildContainerEnv({ provider: "anthropic", model: "m", maxTurns: 2, hostEnv: {}, subscriptionAuth: [{ ...snapshot, ...extra }] }).PI_SUBSCRIPTION_AUTH);
	assert.deepEqual(entries({ notional: true }), [{ provider: "anthropic", connectionId: "claude", adapter: "pi-anthropic-oauth@0.3.6", generation: 1, expiresAt: 1_900_010_000_000, deadlineAt: 1_900_000_000_000, root: "/opt/pi-global/packages/claude", digest: "a".repeat(64), notional: true }]);
	for (const extra of [{}, { notional: "true" }, { notional: 1 }, { notional: false }]) assert.equal(Object.hasOwn(entries(extra)[0], "notional"), false, JSON.stringify(extra));
	assert.equal(JSON.stringify(entries({})), JSON.stringify([{ provider: "anthropic", connectionId: "claude", adapter: "pi-anthropic-oauth@0.3.6", generation: 1, expiresAt: 1_900_010_000_000, deadlineAt: 1_900_000_000_000, root: "/opt/pi-global/packages/claude", digest: "a".repeat(64) }]), "an unmarked entry is the one an older worker wrote");
});

test("costNotional survives the exit-line rebuild after costUnreported, and the record names the notional providers from a closed list", () => {
	const at = TOKEN_KEYS.indexOf("costUnreported");
	assert.deepEqual(TOKEN_KEYS.slice(at + 1, at + 5), ["costNotional", "unpricedNotional", "costUnreportedNotional", "costCapMicros"], "the meter writes it after costUnreported (issue #1058's two after it), the guard's fields follow");
	const line = { input: 1, output: 2, total: 3, cost: 3.25, metered: true, rootTotal: 3, otherTotal: 0, looseTotal: 0, sessions: 1, calls: 1, unresolved: 0, unpriced: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, costUnreported: 0, costNotional: 3, costCapMicros: 5 * USD };
	assert.equal(JSON.stringify(parseExitTokens(`{"event":"exit","tokens":${JSON.stringify(line)}}`)), JSON.stringify(line), "byte-identical round trip");
	assert.equal(parseExitTokens('{"event":"exit","tokens":{"total":1,"costNotional":"3"}}').costNotional, undefined, "numbers only");
	// The closed list is the subscription adapters' providers.
	assert.deepEqual([...NOTIONAL_PROVIDERS].sort(), [...new Set(Object.values(COMMUNITY_AUTH_ADAPTERS).map((adapter) => adapter.provider))].sort());
	const job = { id: "gh-1", name: "github", attemptsMade: 0, data: { kind: "github", repo: "acme/web", target: { number: 7 } } };
	const rec = (result) => buildRecord({ job, result: { outcome: "completed", exitCode: 0, ...result } });
	assert.deepEqual(rec({ notionalProviders: ["openai", "anthropic", "openai"] }).notionalProviders, ["anthropic", "openai"]);
	assert.deepEqual(rec({ notionalProviders: ["anthropic", "/Users/rob"] }).notionalProviders, ["anthropic"], "anything outside the list is dropped");
	for (const absent of [undefined, null, [], ["openrouter"], "anthropic"]) assert.equal(Object.hasOwn(rec({ notionalProviders: absent }), "notionalProviders"), false, JSON.stringify(absent));
	const keys = Object.keys(rec({ notionalProviders: ["anthropic"] }));
	assert.equal(keys.at(-2), "notionalProviders", "the last conditional key before `v`");
	assert.equal(buildRecord({ job, error: Object.assign(new Error("x"), { notionalProviders: ["anthropic"] }) }).notionalProviders[0], "anthropic", "read off a throw too");
});

test("pickup hands each candidate's own subscription check to reservationFor, so a notional candidate's model window is skipped", async () => {
	const NOW = Date.parse("2026-10-28T12:00:00Z");
	const redis = { get: async () => null, set: async () => "OK", eval: async () => 1, incr: async () => 1, decr: async () => 0, expire: async () => 1 };
	const seen = [];
	const checkOf = (candidate) => ({ ok: true, managed: [{ provider: candidate.provider }], binding: "b".repeat(64) });
	const reservationFor = (candidate, checked) => (seen.push([candidate.provider, checked]), candidate.maxCostMicros);
	const failover = { kind: "github", repo: "org/repo", provider: "anthropic", model: "primary", models: ["anthropic/primary", "anthropic/fallback"], fallbackModels: ["anthropic/fallback"], maxCostMicros: 100 };
	await selectFailoverJob(failover, { redis, id: "queue:j", now: () => NOW, checkCandidate: async () => null, subscriptionCheck: async (candidate) => checkOf(candidate), reservationFor });
	assert.deepEqual(seen[0], ["anthropic", checkOf({ provider: "anthropic" })], "failover: the candidate's own check");
	seen.length = 0;
	await selectFailoverJob(failover, { redis, id: "queue:j", now: () => NOW, checkCandidate: async () => null, reservationFor });
	assert.deepEqual(seen[0], ["anthropic", null], "no subscription seam: null, which keeps the window");
	seen.length = 0;
	const pool = { kind: "github", repo: "org/repo", models: ["anthropic/a"], modelSelection: { strategy: "random", candidates: ["anthropic/a"] }, maxCostMicros: 100, maxCostUsd: "0.0001" };
	const stored = new Map();
	const poolRedis = { ...redis, get: async (key) => stored.get(key) ?? null, set: async (key, value) => (stored.set(key, value), "OK"), eval: async (_s, _n, key, ...args) => (stored.set(key, args.at(-2) ?? args[0]), 1) };
	await selectRandomModelJob(pool, { redis: poolRedis, id: "queue:p", now: () => NOW, randomInt: () => 0, checkCandidate: async () => null, subscriptionCheck: async (candidate) => checkOf(candidate), reservationFor }).catch(() => null);
	assert.deepEqual(seen[0], ["anthropic", checkOf({ provider: "anthropic" })], "random pool: the candidate's own check");
});

test("pickup: a failover primary on a notional subscription is taken past its full model window; one with paid extra usage falls over", async () => {
	const { makeProcessor } = await import("../src/index.mjs");
	const { modelDollarRows, parseScopedLimits } = await import("../src/scoped-limits.mjs");
	const { dayKey } = await import("../src/budget.mjs");
	const NOW = Date.parse("2026-10-28T12:00:00Z");
	const primary = "anthropic/primary";
	const fallback = "anthropic/fallback";
	const limits = parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: `model:${primary}`, dayUsd: "0.0001" }] }), "limits.json");
	const pick = async (row) => {
		const store = new Map([[dayKey(new Date(NOW), modelDollarRows(limits, [primary])[0].keyPrefix), "100"]]);
		const redis = {
			get: async (key) => store.get(key) ?? null,
			set: async (key, value) => (store.set(key, value), "OK"),
			incr: async (key) => { const n = Number(store.get(key) ?? 0) + 1; store.set(key, String(n)); return n; },
			decr: async (key) => { const n = Number(store.get(key) ?? 0) - 1; store.set(key, String(n)); return n; },
			expire: async () => 1,
			eval: async (_script, _count, key, until, value) => { const old = JSON.parse(store.get(key) ?? "null"); if (old?.until > Number(until)) return 0; store.set(key, value); return 1; },
		};
		const seen = [];
		const connection = { ok: true, managed: true, provider: "anthropic", connectionId: "claude", ...row };
		const processor = makeProcessor({
			redis, cancelJob: () => {}, stopContainer: () => {}, now: () => NOW, scopedLimits: () => limits,
			getSettings: () => ({ provider: "anthropic", model: "primary", maxTurns: 5, dailyCap: 10, concurrency: 3, softHoldPct: null }),
			modelEndpoints: () => [], overlayModels: () => null,
			deps: {
				imagePreflight: async () => ({ ok: true, capabilities: ["exitAuth", "modelPolicy", "modelFailover", "costCap"] }), now: new Date(NOW),
				checkFailoverCandidate: async () => null, mintToken: async () => "token", isDefaultBranchProtected: async () => true, prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }), cleanup: async () => {}, comment: async () => {}, log: () => {},
				subscriptionRuntime: {
					check: async () => ({ ok: true, managed: [connection] }),
					prepare: async () => ({ ok: true, snapshots: [{ provider: "anthropic", connectionId: "claude", ...(row.extraUsageCreditMicros ? {} : { notional: true }) }] }),
					validate: async () => true,
					observe: async () => undefined,
				},
				runContainer: async (ctx) => { seen.push(ctx.job.model); return { code: 0, aborted: false }; },
			},
		});
		const queueJob = { id: "j", attemptsMade: 0, name: "github", data: { kind: "github", repo: "org/repo", provider: "anthropic", model: "primary", models: [primary, fallback], fallbackModels: [fallback], maxCostMicros: 100 }, moveToDelayed: async () => {} };
		await processor(queueJob, "lock", new AbortController().signal);
		return seen;
	};
	assert.deepEqual(await pick({}), ["primary"], "notional: its model window is not judged, and its row leaves the reservation");
	assert.deepEqual(await pick({ extraUsageCreditMicros: 1_000 }), ["fallback"], "paid extra usage: the full window passes it over");
});
