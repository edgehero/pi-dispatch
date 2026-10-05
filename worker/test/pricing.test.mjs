/**
 * PINNED-ARTIFACT PRICING-SURFACE GUARD (pi-ai 0.99.1; re-pinned from 0.80.7 in issue #509). These tests
 * pin the exact pieces of pi-ai's pricing surface the façade (and through it the admin's cost analytics) depends on: the providers/all
 * enumeration shape, specific rate tables, the tier-selection key, the 1h-cache premium formula, and
 * calculateCost's mutate-in-place contract. A pi-ai pin bump that reshapes any of this must fail the
 * BUILD, not the screen -- a silently changed rate table would misprice every counterfactual with no
 * error anywhere. When a bump fails here, re-verify the façade against the new dist and update the
 * pins consciously.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { calculateCost } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

import { getPricedModel, isZeroRated, listPricedModels, piAiVersion, reprice } from "../src/pricing.mjs";

/** The pi-ai release worker/package.json pins: what every price here is read from. */
const PINNED_PI_AI = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies["@earendil-works/pi-ai"];

/** A full zeroed quad with overrides -- reprice's input shape. */
const quad = (overrides = {}) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...overrides });

/** A fresh pi-ai Usage with the cost skeleton calculateCost requires (it mutates cost in place). */
const freshUsage = (q) => ({
	...q,
	totalTokens: q.input + q.output + q.cacheRead + q.cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const OPUS = { provider: "anthropic", id: "claude-opus-4-6" };
// openai/gpt-5.4, not openai-codex/gpt-5.4: the pi 0.99.1 catalog dropped the codex entry and kept this
// one with the same rates and the same single tier (issue #509; the removal is pinned below).
const GPT54 = { provider: "openai", id: "gpt-5.4" };

// ── providers/all enumeration shape ─────────────────────────────────────────────────────────────────────

test("getBuiltinProviders includes the providers the cost analytics reason about", () => {
	const providers = getBuiltinProviders();
	for (const p of ["anthropic", "openai", "openai-codex", "kimi-coding", "zai-coding-cn", "qwen-token-plan"]) {
		assert.ok(providers.includes(p), `builtin providers must include ${p}`);
	}
});

test("listPricedModels flattens the whole builtin catalog to { provider, id, cost }", () => {
	const models = listPricedModels();
	assert.ok(models.length > 500, `expected >500 builtin models, got ${models.length}`);
	for (const entry of models) {
		assert.equal(typeof entry.provider, "string");
		assert.equal(typeof entry.id, "string");
		assert.ok(entry.cost !== null && typeof entry.cost === "object", `${entry.provider}/${entry.id} must carry a cost table`);
	}
});

// ── pinned rate tables ──────────────────────────────────────────────────────────────────────────────────

test("claude-opus-4-6 rates are pinned exactly (USD per 1M tokens, no tiers)", () => {
	const model = getPricedModel("anthropic", "claude-opus-4-6");
	assert.ok(model);
	// deepEqual pins the WHOLE table: a bump that adds tiers to opus must land here first.
	assert.deepEqual(model.cost, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
});

test("gpt-5.4 base rates and the single 272000 tier are pinned exactly", () => {
	const model = getPricedModel("openai", "gpt-5.4");
	assert.ok(model);
	assert.deepEqual(model.cost, {
		input: 2.5,
		output: 15,
		cacheRead: 0.25,
		cacheWrite: 0,
		tiers: [{ inputTokensAbove: 272000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }],
	});
});

test("openai-codex/gpt-5.4 is gone from the 0.99.1 catalog, which is why the tier pins moved to openai/gpt-5.4", () => {
	assert.equal(getPricedModel("openai-codex", "gpt-5.4"), null);
	assert.ok(listPricedModels().some((m) => m.provider === "openai-codex"), "the provider itself is still there");
});

test("every qwen-token-plan* model is zero-rated: the all-zero subscription providers at the 0.99.1 pin", () => {
	for (const provider of ["qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual"]) {
		const models = listPricedModels().filter((m) => m.provider === provider);
		assert.ok(models.length > 0, `${provider} must ship models`);
		for (const m of models) {
			assert.ok(isZeroRated(m), `${provider}/${m.id} must be all-zero rated`);
		}
	}
});

test("kimi-coding and zai-coding-cn now carry API-equivalent rates, so zero-rated no longer means subscription", () => {
	// At 0.80.7 every model of both providers was all-zero and this file pinned that as "correct data:
	// subscription providers". At 0.99.1 (issue #509) most of them carry an implied API-equivalent price
	// although the plan is still prepaid, so a run on them records a POSITIVE stream-time cost, and
	// `isZeroRated` is no longer a subscription signal. Pinned exactly on one model of each, so a catalog
	// that moves these numbers again fails here rather than on the cost screen.
	assert.deepEqual(getPricedModel("kimi-coding", "kimi-for-coding").cost, { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 });
	assert.deepEqual(getPricedModel("zai-coding-cn", "glm-5.3").cost, { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
	for (const provider of ["kimi-coding", "zai-coding-cn"]) {
		const models = listPricedModels().filter((m) => m.provider === provider);
		assert.ok(models.some((m) => !isZeroRated(m)), `${provider}: at least one model is priced`);
	}
});

// ── calculateCost's mutation contract (what reprice defends against) ────────────────────────────────────

test("calculateCost mutates usage.cost in place and returns that same object", () => {
	const opus = getPricedModel("anthropic", "claude-opus-4-6");
	const usage = freshUsage(quad({ input: 1000, output: 1000 }));
	const returned = calculateCost(opus, usage);
	assert.equal(returned, usage.cost, "the returned cost IS the argument's cost object");
	// Mirror pi-ai's operand order ((rate / 1e6) * tokens) so the comparison is bit-exact.
	assert.equal(usage.cost.input, (5 / 1e6) * 1000);
	assert.equal(usage.cost.output, (25 / 1e6) * 1000);
	assert.equal(usage.cost.total, (5 / 1e6) * 1000 + (25 / 1e6) * 1000);
});

test("calculateCost throws without the cost skeleton -- why reprice always builds a fresh Usage", () => {
	const opus = getPricedModel("anthropic", "claude-opus-4-6");
	const noSkeleton = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, totalTokens: 1 };
	assert.throws(() => calculateCost(opus, noSkeleton), TypeError);
});

// ── tier boundary (whole-request rates, key = input + cacheRead + cacheWrite) ───────────────────────────

test("reprice at 300k input on gpt-5.4 prices the WHOLE request at tier rates", () => {
	const result = reprice(quad({ input: 300000, output: 10000 }), GPT54);
	// 300000 > 272000 -> tier {5, 22.5}. Expected mirrors pi-ai's operand order for bit-exactness.
	assert.equal(result.usd, (5 / 1e6) * 300000 + (22.5 / 1e6) * 10000);
	assert.equal(result.ratesVersion, PINNED_PI_AI, "stamped with the pinned release");
});

test("reprice at 100k input on gpt-5.4 stays on base rates", () => {
	const result = reprice(quad({ input: 100000, output: 10000 }), GPT54);
	assert.equal(result.usd, (2.5 / 1e6) * 100000 + (15 / 1e6) * 10000); // 0.25 + 0.15
});

test("the tier key includes cacheRead: 100k input + 200k cacheRead crosses 272k", () => {
	const result = reprice(quad({ input: 100000, cacheRead: 200000 }), GPT54);
	// Tier rates {input 5, cacheRead 0.5}: 0.5 + 0.1 -- NOT base's 0.25 + 0.05.
	assert.equal(result.usd, (5 / 1e6) * 100000 + (0.5 / 1e6) * 200000);
	assert.notEqual(result.usd, (2.5 / 1e6) * 100000 + (0.25 / 1e6) * 200000);
});

// ── the 1h-cache rule: Anthropic's premium, folded short everywhere else ────────────────────────────────

test("an anthropic target prices the 1h split: short writes at cacheWrite, 1h writes at 2x input", () => {
	const result = reprice(quad({ cacheWrite: 10000, cacheWrite1h: 4000 }), OPUS);
	// pi-ai's formula: (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1e6.
	assert.equal(result.usd, (6.25 * 6000 + 5 * 2 * 4000) / 1e6);
	assert.equal(result.usd, 0.0775);
});

test("a non-anthropic target folds the same quad short: all 10000 writes at its cacheWrite rate", () => {
	const result = reprice(quad({ cacheWrite: 10000, cacheWrite1h: 4000 }), GPT54);
	// gpt-5.4's cacheWrite rate is 0, so the whole write is free -- and specifically NOT the invented
	// premium (2.5 * 2 * 4000) / 1e6 that forwarding the source profile's 1h split would produce.
	assert.equal(result.usd, 0);
});

test("a quad claiming more 1h writes than writes is clamped, not priced negative-short", () => {
	const result = reprice(quad({ cacheWrite: 100, cacheWrite1h: 500 }), OPUS);
	// Clamped to 100 1h writes, 0 short: (6.25 * 0 + 5 * 2 * 100) / 1e6.
	assert.equal(result.usd, (5 * 2 * 100) / 1e6);
});

// ── reprice input hygiene ───────────────────────────────────────────────────────────────────────────────

test("reprice returns null on unknown or garbage targets, never throws", () => {
	const q = quad({ input: 1000 });
	assert.equal(reprice(q, { provider: "anthropic", id: "claude-not-a-model" }), null);
	assert.equal(reprice(q, { provider: "not-a-provider", id: "gpt-5.4" }), null);
	assert.equal(reprice(q, { provider: "__proto__", id: "toString" }), null, "prototype keys are not models");
	assert.equal(reprice(q, {}), null);
	assert.equal(reprice(q, null), null);
	assert.equal(reprice(q, undefined), null);
});

test("reprice treats non-finite and negative counts as 0", () => {
	const result = reprice({ input: -5, output: NaN, cacheRead: Infinity, cacheWrite: -10, cacheWrite1h: 8 }, OPUS);
	assert.equal(result.usd, 0);
});

test("reprice never mutates the caller's quad", () => {
	// Frozen object: in strict mode any write throws, so completing at all proves hands-off.
	const frozen = Object.freeze(quad({ input: 300000, output: 10000, cacheWrite: 500, cacheWrite1h: 200 }));
	const result = reprice(frozen, OPUS);
	assert.ok(result.usd > 0);
	assert.deepEqual(frozen, { input: 300000, output: 10000, cacheRead: 0, cacheWrite: 500, cacheWrite1h: 200 });
});

// ── getPricedModel lookups ──────────────────────────────────────────────────────────────────────────────

test("getPricedModel returns the pi-ai model for known pairs and null for everything else", () => {
	const model = getPricedModel("openai", "gpt-5.4");
	assert.equal(model.id, "gpt-5.4");
	assert.equal(model.provider, "openai");
	assert.equal(getPricedModel("anthropic", "claude-not-a-model"), null);
	assert.equal(getPricedModel(123, "gpt-5.4"), null);
	assert.equal(getPricedModel("anthropic", {}), null);
	assert.equal(getPricedModel("__proto__", "toString"), null, "the catalog is a plain object literal; prototype keys must not resolve");
	assert.equal(getPricedModel("anthropic", "constructor"), null);
});

// ── isZeroRated ─────────────────────────────────────────────────────────────────────────────────────────

test("isZeroRated: opus false, qwen-token-plan true, kimi-for-coding false, null/{}/costless false", () => {
	assert.equal(isZeroRated(getPricedModel("anthropic", "claude-opus-4-6")), false);
	const qwen = listPricedModels().find((m) => m.provider === "qwen-token-plan");
	assert.ok(qwen);
	assert.equal(isZeroRated(qwen), true);
	// A subscription provider whose table carries an implied price at 0.99.1 (issue #509).
	assert.equal(isZeroRated(getPricedModel("kimi-coding", "kimi-for-coding")), false);
	assert.equal(isZeroRated(null), false);
	assert.equal(isZeroRated({}), false);
	assert.equal(isZeroRated({ cost: {} }), false, "a cost table missing its rates is malformed, not free");
	// All four base rates, not the two a reader would check first: a table with only a cache rate is priced.
	assert.equal(isZeroRated({ cost: { input: 0, output: 0, cacheRead: 0.1, cacheWrite: 0 } }), false);
	assert.equal(isZeroRated({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0.1 } }), false);
});

// ── piAiVersion ─────────────────────────────────────────────────────────────────────────────────────────

test("piAiVersion with an injected reader parses the canned package.json", () => {
	const readText = () => JSON.stringify({ name: "@earendil-works/pi-ai", version: "9.9.9" });
	assert.equal(piAiVersion({ readText }), "9.9.9");
});

test("piAiVersion with a throwing reader is null, never a throw", () => {
	const readText = () => {
		throw new Error("disk on fire");
	};
	assert.equal(piAiVersion({ readText }), null);
});

test("piAiVersion default path resolves the real pin, and the pricing surface is the file this façade was verified against", () => {
	// The real file, found the same way the façade finds it: from the resolved ESM entry (dist/index.js)
	// up to the package root. pi-ai's exports map has no ./package.json entry, so disk is the only way.
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
	const realPackage = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
	assert.equal(piAiVersion(), realPackage.version);
	assert.equal(realPackage.version, PINNED_PI_AI, "the installed pi-ai is not worker/package.json's pin");
	// The pricing surface by CONTENT, not by version (issue #587): calculateCost lives in dist/models.js, and a
	// version literal went red on every bump whether that file moved or not. Re-verified at 1.0.3: models.js
	// changed only in its OAuth refresh; calculateCost is byte-identical to 0.99.1's.
	const models = readFileSync(join(dirname(entry), "models.js"));
	assert.equal(createHash("sha256").update(models).digest("hex"), "633161a0067abbb20a434acc3605f8f25d2fa6d32f903cc7edcdcaa7e0ba7083", `pi-ai ${realPackage.version}'s dist/models.js changed: re-verify calculateCost and the pricing surface, then update this hash`);
	assert.equal(piAiVersion(), piAiVersion(), "cached: repeated calls agree");
});
