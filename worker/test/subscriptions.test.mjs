import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSubscriptions, SUBSCRIPTIONS_VERSION } from "../src/subscriptions.mjs";

// parseSubscriptions is pure over the file TEXT -- no fs (mirrors pause-windows.test.mjs).
const PATH = "subs.json";
const wrap = (subscriptions, version = 1) => JSON.stringify({ version, subscriptions });
const parse = (subscriptions) => parseSubscriptions(wrap(subscriptions), PATH);
const isConfigError = (e) => e.piDispatchConfig === true;

const OK = {
	id: "kimi-for-coding",
	vendor: "Moonshot AI",
	provider: "kimi-coding",
	price: { amount: 99, currency: "USD", per: "month" },
};

// ── the committed example ───────────────────────────────────────────────────────────────────────────────

test("the committed subscriptions.example.json parses, with defaults applied per entry", () => {
	const examplePath = fileURLToPath(new URL("../../subscriptions.example.json", import.meta.url));
	const { version, subscriptions } = parseSubscriptions(readFileSync(examplePath, "utf8"), examplePath);
	assert.equal(version, SUBSCRIPTIONS_VERSION);
	assert.equal(subscriptions.length, 2);

	const [kimi, considered] = subscriptions;
	assert.equal(kimi.provider, "kimi-coding");
	assert.equal(kimi.sharedWithOtherProducts, true);
	assert.equal(kimi.hypothetical, false, "an owned plan defaults hypothetical off");
	assert.deepEqual(kimi.counterfactualModel, { provider: "anthropic", id: "claude-sonnet-5-5" });
	assert.deepEqual(kimi.windows[0], { per: "5h", rolling: true, unit: null, limit: null, scope: null });

	assert.equal(considered.hypothetical, true, "a plan being considered, not owned");
	assert.equal(considered.sharedWithOtherProducts, false, "default applied");
	assert.deepEqual(considered.models, ["claude-*"]);
	assert.equal(considered.counterfactualModel, null, "no counterfactual declared -> explicit null");
	assert.equal(considered.windows[1].rolling, false, "rolling defaults off");
	assert.deepEqual(considered.windows[1].scope, ["claude-opus-*"], "a window can cover a model subset");
});

// ── normalization: defaults + the operator-file unknown-field policy ────────────────────────────────────

test("a minimal subscription normalizes to an explicit literal with every default applied", () => {
	const { subscriptions } = parse([OK]);
	assert.deepEqual(subscriptions, [
		{
			id: "kimi-for-coding",
			vendor: "Moonshot AI",
			provider: "kimi-coding",
			models: ["*"],
			price: { amount: 99, currency: "USD", per: "month" },
			sharedWithOtherProducts: false,
			hypothetical: false,
			counterfactualModel: null,
			windows: [],
		},
	]);
});

test("unknown fields are silently dropped -- the normalizer rebuilds explicit objects", () => {
	const { subscriptions } = parse([
		{ ...OK, autoRenew: true, notes: "junk", windows: [{ per: "5h", burnRate: 9000 }] },
	]);
	assert.equal("autoRenew" in subscriptions[0], false, "an unknown subscription field vanishes");
	assert.equal("notes" in subscriptions[0], false);
	assert.equal("burnRate" in subscriptions[0].windows[0], false, "an unknown window field vanishes");
	assert.deepEqual(subscriptions[0].windows[0], { per: "5h", rolling: false, unit: null, limit: null, scope: null });
});

// ── version: required, and fail-loud on a newer file ────────────────────────────────────────────────────

test("version is required as an integer >= 1", () => {
	assert.throws(() => parseSubscriptions(JSON.stringify({ subscriptions: [] }), PATH), (e) => isConfigError(e) && /"version"/.test(e.message));
	assert.throws(() => parseSubscriptions(wrap([], 0), PATH), (e) => isConfigError(e) && /"version"/.test(e.message));
	assert.throws(() => parseSubscriptions(wrap([], "1"), PATH), (e) => isConfigError(e) && /"version"/.test(e.message), "a string version is not an integer");
	assert.throws(() => parseSubscriptions(wrap([], 1.5), PATH), isConfigError);
});

test("a version HIGHER than this build's is refused loudly, naming both versions", () => {
	assert.throws(
		() => parseSubscriptions(wrap([OK], 2), PATH),
		(e) => isConfigError(e) && /newer pi-dispatch/.test(e.message) && /version 2/.test(e.message) && /understands 1/.test(e.message) && e.message.includes(PATH),
		"fail-loud-on-newer cannot be retrofitted -- a silent partial read would misprice forever",
	);
});

// ── file-shape refusals ─────────────────────────────────────────────────────────────────────────────────

test("non-JSON text and a non-object top level are config errors naming the path", () => {
	assert.throws(() => parseSubscriptions("{ not json", PATH), (e) => isConfigError(e) && /not valid JSON/.test(e.message) && e.message.includes(PATH));
	assert.throws(() => parseSubscriptions("null", PATH), (e) => isConfigError(e) && /JSON object/.test(e.message));
	assert.throws(() => parseSubscriptions("[]", PATH), isConfigError);
	assert.throws(() => parseSubscriptions('"a plan"', PATH), isConfigError);
	assert.throws(() => parseSubscriptions(JSON.stringify({ version: 1 }), PATH), (e) => isConfigError(e) && /"subscriptions" array/.test(e.message));
	assert.throws(() => parseSubscriptions(JSON.stringify({ version: 1, subscriptions: {} }), PATH), isConfigError);
});

test("a non-object subscription entry is refused with its positional label", () => {
	for (const entry of ["nope", 7, null, ["a"]]) {
		assert.throws(() => parse([entry]), (e) => isConfigError(e) && /subscription at index 0: must be an object/.test(e.message), `entry ${JSON.stringify(entry)}`);
	}
});

// ── field refusals: id / vendor / provider / models ─────────────────────────────────────────────────────

test("id, vendor and provider must be non-empty strings", () => {
	assert.throws(() => parse([{ ...OK, id: "" }]), (e) => isConfigError(e) && /id must be a non-empty string/.test(e.message));
	assert.throws(() => parse([{ ...OK, id: undefined }]), isConfigError);
	assert.throws(() => parse([{ ...OK, vendor: "  " }]), (e) => isConfigError(e) && /vendor/.test(e.message));
	assert.throws(() => parse([{ ...OK, provider: 42 }]), (e) => isConfigError(e) && /provider/.test(e.message));
});

test("duplicate ids fail the whole file, naming both indexes", () => {
	assert.throws(
		() => parse([OK, { ...OK, vendor: "Someone Else" }]),
		(e) => isConfigError(e) && /subscription at index 1/.test(e.message) && /already used/.test(e.message) && /index 0/.test(e.message),
	);
});

test("model globs are bounded to the model-id charset plus *", () => {
	const { subscriptions } = parse([{ ...OK, models: ["claude-*", "kimi-k2:free", "a/b.c_d-1"] }]);
	assert.deepEqual(subscriptions[0].models, ["claude-*", "kimi-k2:free", "a/b.c_d-1"]);
	assert.throws(() => parse([{ ...OK, models: [] }]), (e) => isConfigError(e) && /non-empty array/.test(e.message), "an empty list would cover nothing");
	assert.throws(() => parse([{ ...OK, models: ["has space*"] }]), (e) => isConfigError(e) && /glob/.test(e.message));
	assert.throws(() => parse([{ ...OK, models: ["x".repeat(65)] }]), isConfigError, "a glob is bounded at 64 chars");
	assert.throws(() => parse([{ ...OK, models: [42] }]), isConfigError);
});

// ── field refusals: price ───────────────────────────────────────────────────────────────────────────────

test("price must be { amount > 0, 3-letter uppercase currency, per: month }", () => {
	assert.throws(() => parse([{ ...OK, price: undefined }]), (e) => isConfigError(e) && /price must be an object/.test(e.message));
	assert.throws(() => parse([{ ...OK, price: { ...OK.price, amount: 0 } }]), (e) => isConfigError(e) && /amount must be a number > 0/.test(e.message));
	assert.throws(() => parse([{ ...OK, price: { ...OK.price, amount: -5 } }]), isConfigError);
	assert.throws(() => parse([{ ...OK, price: { amount: 99, per: "month" } }]), (e) => isConfigError(e) && /currency/.test(e.message), "missing currency");
	assert.throws(() => parse([{ ...OK, price: { ...OK.price, currency: "usd" } }]), isConfigError, "lowercase is refused");
	assert.throws(() => parse([{ ...OK, price: { ...OK.price, per: "year" } }]), (e) => isConfigError(e) && /per must be "month"/.test(e.message));
});

// ── field refusals: booleans and counterfactualModel ────────────────────────────────────────────────────

test("sharedWithOtherProducts and hypothetical must be booleans when present", () => {
	assert.throws(() => parse([{ ...OK, sharedWithOtherProducts: "true" }]), (e) => isConfigError(e) && /sharedWithOtherProducts/.test(e.message));
	assert.throws(() => parse([{ ...OK, hypothetical: 1 }]), (e) => isConfigError(e) && /hypothetical/.test(e.message));
});

test("counterfactualModel must name a provider and a model id; null reads as none declared", () => {
	assert.throws(() => parse([{ ...OK, counterfactualModel: { provider: "anthropic" } }]), (e) => isConfigError(e) && /counterfactualModel/.test(e.message));
	assert.throws(() => parse([{ ...OK, counterfactualModel: "claude-sonnet-4-5" }]), isConfigError);
	// null is the normalizer's own output for "none", so the parser accepts it -- the round trip is what
	// lets the admin re-validate normalized entries on write.
	assert.equal(parse([{ ...OK, counterfactualModel: null }]).subscriptions[0].counterfactualModel, null);
});

test("the normalized output re-parses byte-identically (the admin writes what the parser emitted)", () => {
	const full = { ...OK, counterfactualModel: { provider: "anthropic", id: "claude-sonnet-4-5" }, windows: [{ per: "5h", rolling: true }, { per: "7d", scope: ["claude-opus-*"] }] };
	const once = parse([full]).subscriptions;
	const twice = parseSubscriptions(wrap(once), PATH).subscriptions;
	assert.deepEqual(twice, once);
});

// ── windows ─────────────────────────────────────────────────────────────────────────────────────────────

test("a window's per is one of 5h|7d|30d|month, and rolling must be a boolean", () => {
	assert.throws(() => parse([{ ...OK, windows: [{ per: "1h" }] }]), (e) => isConfigError(e) && /per must be one of 5h\|7d\|30d\|month/.test(e.message));
	assert.throws(() => parse([{ ...OK, windows: [{}] }]), isConfigError, "a window without per is refused");
	assert.throws(() => parse([{ ...OK, windows: [{ per: "5h", rolling: "true" }] }]), (e) => isConfigError(e) && /rolling/.test(e.message));
	assert.throws(() => parse([{ ...OK, windows: ["5h"] }]), (e) => isConfigError(e) && /must be an object/.test(e.message));
	assert.throws(() => parse([{ ...OK, windows: {} }]), (e) => isConfigError(e) && /windows must be an array/.test(e.message));
});

test("null unit and null limit are first-class -- vendor undisclosed, accepted as declared", () => {
	const { subscriptions } = parse([{ ...OK, windows: [{ per: "5h", rolling: true, unit: null, limit: null }] }]);
	assert.deepEqual(subscriptions[0].windows[0], { per: "5h", rolling: true, unit: null, limit: null, scope: null });
	const absent = parse([{ ...OK, windows: [{ per: "7d" }] }]).subscriptions[0].windows[0];
	assert.equal(absent.unit, null, "an absent unit normalizes to the same explicit null");
	assert.equal(absent.limit, null);
});

test("a disclosed unit/limit is validated: known units, positive numbers, ordered ranges", () => {
	const { subscriptions } = parse([{ ...OK, windows: [{ per: "7d", unit: "prompts", limit: 2000 }, { per: "month", unit: "credits", limit: [100, 200] }] }]);
	assert.equal(subscriptions[0].windows[0].limit, 2000);
	assert.deepEqual(subscriptions[0].windows[1].limit, [100, 200]);
	assert.throws(() => parse([{ ...OK, windows: [{ per: "5h", unit: "words" }] }]), (e) => isConfigError(e) && /unit must be one of/.test(e.message));
	assert.throws(() => parse([{ ...OK, windows: [{ per: "5h", limit: 0 }] }]), (e) => isConfigError(e) && /limit/.test(e.message));
	assert.throws(() => parse([{ ...OK, windows: [{ per: "5h", limit: "many" }] }]), isConfigError);
	assert.throws(() => parse([{ ...OK, windows: [{ per: "5h", limit: [200, 100] }] }]), (e) => isConfigError(e) && /min < max/.test(e.message));
	assert.throws(() => parse([{ ...OK, windows: [{ per: "5h", limit: [100, 100] }] }]), isConfigError, "min == max is not a range");
	assert.throws(() => parse([{ ...OK, windows: [{ per: "5h", limit: [0, 100] }] }]), isConfigError, "both bounds must be > 0");
	assert.throws(() => parse([{ ...OK, windows: [{ per: "5h", limit: [1, 2, 3] }] }]), isConfigError);
});

test("a window scope is globs under the same bounded charset", () => {
	assert.throws(() => parse([{ ...OK, windows: [{ per: "5h", scope: ["bad glob"] }] }]), (e) => isConfigError(e) && /scope glob/.test(e.message));
	assert.throws(() => parse([{ ...OK, windows: [{ per: "5h", scope: [] }] }]), isConfigError, "an empty scope would cover nothing");
});

// ── positional labels ───────────────────────────────────────────────────────────────────────────────────

test("errors carry the positional label of the entry and window at fault, plus the path", () => {
	assert.throws(
		() => parse([OK, { ...OK, id: "second", vendor: "" }]),
		(e) => isConfigError(e) && e.message.startsWith("subscription at index 1:") && e.message.includes(PATH),
	);
	assert.throws(
		() => parse([{ ...OK, windows: [{ per: "nope" }] }]),
		(e) => isConfigError(e) && e.message.startsWith("window at index 0 of subscription at index 0:") && e.message.includes(PATH),
	);
});
