/**
 * Pricing façade over pi-ai (issue #53). pi-dispatch holds NO pricing table and computes NOTHING of
 * its own -- pricing is pi-ai's (`calculateCost` over its per-provider model tables). The admin
 * extension needs to re-price recorded token profiles (what-if: "this run's tokens at that model's
 * rates") and to enumerate priced models, and it must NOT grow its own pi-ai dependency -- that would
 * be a fourth exact pin and a second drift axis between the recorded truth and the screen. So the
 * admin imports this worker export instead: the same anti-drift idiom as `budget`'s dayKey and
 * `subscriptions`' parser -- one side owns the artifact, the other imports it, and the two cannot
 * drift.
 *
 * Stream-time cost on the usage-ledger record stays the METERED truth; this façade prices
 * COUNTERFACTUALS only (same posture as DES-SUBSCRIPTIONS-ARE-COUNTERFACTUAL-ONLY). Nothing here
 * touches job execution, routing, or the record path.
 *
 * Import discipline: enumeration comes from "@earendil-works/pi-ai/providers/all" and the arithmetic
 * from the root "@earendil-works/pi-ai" -- both declared side-effect-free in pi-ai's package.json
 * (`sideEffects` names only compat/images registration modules). NEVER import
 * "@earendil-works/pi-ai/compat" here: it registers providers at module scope, and a pricing lookup
 * must not mutate global registries as a side effect of being asked a question.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { calculateCost } from "@earendil-works/pi-ai";
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

/**
 * Every builtin pi-ai model, flattened to `{ provider, id, cost }`. `cost` is pi-ai's ModelCost
 * object passed BY REFERENCE -- it is pi-ai's data, callers treat it read-only. Rates are USD per
 * 1M tokens. An all-zero table is pi-ai's data, not missing data: at the 0.99.1 pin the all-zero
 * providers include the qwen-token-plan family. It is NOT a subscription signal any more (issue #509):
 * kimi-coding and zai-coding-cn, all-zero at 0.80.7, now carry implied API-equivalent rates on most
 * models although their plans are prepaid, and plenty of pay-per-token providers list a free model.
 */
export function listPricedModels() {
	const out = [];
	for (const provider of getBuiltinProviders()) {
		for (const model of getBuiltinModels(provider)) {
			out.push({ provider, id: model.id, cost: model.cost });
		}
	}
	return out;
}

/**
 * Look up one builtin model; the pi-ai Model or null. Never throws on garbage: non-string args are
 * refused, and because pi-ai's generated catalog is a plain object literal, keys like "__proto__"
 * or "constructor" would resolve THROUGH the prototype chain to real objects -- so the provider must
 * be an own catalog key and the hit must actually be a model (carrying its own id and a cost table).
 */
export function getPricedModel(provider, id) {
	if (typeof provider !== "string" || typeof id !== "string") return null;
	if (!getBuiltinProviders().includes(provider)) return null;
	const model = getBuiltinModel(provider, id);
	if (model === null || model === undefined || typeof model !== "object") return null;
	if (model.id !== id || model.cost === null || typeof model.cost !== "object") return null;
	return model;
}

/**
 * True when all four base rates are zero: pi-ai rated the model at $0, which is a fact about the table
 * and nothing more. It USED to be read as the signature of a subscription-backed provider; at the 0.99.1
 * pin it is not (issue #509: kimi-coding and zai-coding-cn carry implied prices, and free models of
 * metered providers are zero too), so a subscription is known only from subscriptions.json. Tiers are
 * deliberately ignored: a zero-rate provider ships no tiers, and a priced provider
 * with a zero base rate somewhere does not become "free" by it. Null/malformed input is false --
 * "not zero-rated" is the safe answer for a thing that is not a model.
 */
export function isZeroRated(model) {
	const cost = model?.cost;
	if (cost === null || cost === undefined || typeof cost !== "object") return false;
	return cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0;
}

/** Default reader for piAiVersion; injectable so tests never depend on disk layout. */
function readTextFromDisk(path) {
	return readFileSync(path, "utf8");
}

/**
 * Resolve the pinned pi-ai's version from its package.json on disk. pi-ai's exports map has NO
 * "./package.json" entry, so the file cannot be imported or require.resolved directly -- and the map
 * carries only the "import" condition, so createRequire().resolve() on the bare specifier throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED too. import.meta.resolve is the resolution that works: it yields the
 * ESM entry (dist/index.js), and from there we walk parent directories until a package.json names
 * the package. Bounded walk, every step forgiving: any read/parse/mismatch just keeps climbing, and
 * any failure overall is null, never a throw.
 */
function readPiAiVersion(readText) {
	try {
		let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
		for (let hops = 0; hops < 8; hops++) {
			try {
				const parsed = JSON.parse(readText(join(dir, "package.json")));
				if (parsed !== null && parsed.name === "@earendil-works/pi-ai") {
					const match = /^(\d+\.\d+\.\d+)/.exec(String(parsed.version ?? ""));
					return match === null ? null : match[1];
				}
			} catch {
				// dist/ has no package.json (ENOENT), or the injected reader refused -- keep climbing.
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		// import.meta.resolve failed: pi-ai is not installed where we run. null says so quietly.
	}
	return null;
}

let defaultVersionCache;

/**
 * The pinned pi-ai's "<major.minor.patch>", or null. Lazy and cached (a null miss is cached too --
 * the answer will not change within a process), and it never throws: the version tags counterfactual
 * prices as `ratesVersion`, and a cosmetic label must never take the pricing path down. An injected
 * `readText` bypasses the cache and reads fresh -- that path exists for tests.
 */
export function piAiVersion({ readText } = {}) {
	if (readText !== undefined) return readPiAiVersion(readText);
	if (defaultVersionCache === undefined) defaultVersionCache = readPiAiVersion(readTextFromDisk);
	return defaultVersionCache;
}

/** A token count from an untrusted profile: finite and positive, or 0. */
function tokenCount(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Price a recorded token profile at another model's rates: `{ usd, ratesVersion }`, or null when the
 * target is not a builtin model. `quad` is `{ input, output, cacheRead, cacheWrite, cacheWrite1h }`;
 * non-finite/negative counts are treated as 0, and the caller's object is never touched.
 *
 * The one judgment this façade makes is the 1h cache split. pi-ai's `calculateCost` applies the
 * 2x-base-input premium for ANY model when `cacheWrite1h > 0`, but the premium is an ANTHROPIC
 * billing rule -- only Anthropic ever reports the field. Carrying a source profile's 1h split onto a
 * target that never bills it would invent cost out of thin air, so the split is forwarded only when
 * the TARGET is anthropic; everywhere else every write is priced short. (And a profile claiming more
 * 1h writes than writes is malformed: clamped, so pi-ai's short-write term cannot go negative.)
 */
export function reprice(quad, target, { readText } = {}) {
	const model = getPricedModel(target?.provider, target?.id);
	if (model === null) return null;

	const input = tokenCount(quad?.input);
	const output = tokenCount(quad?.output);
	const cacheRead = tokenCount(quad?.cacheRead);
	const cacheWrite = tokenCount(quad?.cacheWrite);
	const cacheWrite1h = model.provider === "anthropic"
		? Math.min(tokenCount(quad?.cacheWrite1h), cacheWrite)
		: 0;

	// A FRESH Usage every call, never a shared or caller-owned object: calculateCost MUTATES its
	// argument in place (usage.cost.* is assigned, not returned fresh) and REQUIRES the cost skeleton
	// to already exist -- handing it a shared object would leak one caller's price into the next, and
	// omitting the skeleton is a TypeError (both pinned in pricing.test.mjs).
	const usage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		cacheWrite1h,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return { usd: usage.cost.total, ratesVersion: piAiVersion({ readText }) };
}
