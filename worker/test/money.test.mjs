import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DOLLAR_SETTING_KEYS, DOLLAR_WINDOW_KEYS, MAX_USD_MICROS, checkDollarInvariant, effectiveCostCapMicros, formatMicros, optionalUsdMicros, parseUsdMicros, triggerCapAboveDeployment } from "../src/money.mjs";

// The money type (issue #501). Every amount is an integer number of micro-dollars, converted from the
// operator's decimal without any floating-point multiplication.

test("parseUsdMicros: decimal strings and numbers become exact integer micro-dollars", () => {
	const cases = [
		["2.50", 2_500_000],
		["2.5", 2_500_000],
		["2", 2_000_000],
		["0.000001", 1],
		["0.1", 100_000],
		["1.005", 1_005_000], // 1.005 * 1e6 is 1004999.9999999999 in floating point; the integer conversion is exact
		["0.29", 290_000],
		["1.123456", 1_123_456],
		["1000000", 1_000_000_000_000],
		["999999.999999", 999_999_999_999],
		[2.5, 2_500_000],
		[2, 2_000_000],
		[0.29, 290_000],
		[1.005, 1_005_000],
		[0.000001, 1],
		[1000000, 1_000_000_000_000],
	];
	for (const [value, micros] of cases) {
		const got = parseUsdMicros(value, "k");
		assert.equal(got, micros, JSON.stringify(value));
		assert.ok(Number.isSafeInteger(got), `${JSON.stringify(value)} is an integer`);
	}
});

test("parseUsdMicros: everything that is not a plain positive decimal with at most 6 decimals is refused", () => {
	const refused = [
		"0", "0.0", "0.000000", 0, // zero is not "no cap" and not a cap anyone means by writing it
		"0.0000001", "1.1234567", 1.1234567, // seven decimals: refused, never rounded
		0.1 + 0.2, // "0.30000000000000004"
		1e-7, // "1e-7"
		1e21, "1e3", "1E3", // exponents
		"1000000.000001", 1000000.000001, "1000001", "9999999", // above 1,000,000 USD
		"-1", -1, "+1", // signs
		"01", "00.5", ".5", "5.", "1,5", "1_000", "$2", "2 ", " 2", "2\n", "", " ", // shapes
		"Infinity", Infinity, Number.NaN, "NaN",
		null, undefined, true, false, {}, [], ["2"], 2n,
	];
	for (const value of refused) {
		assert.throws(() => parseUsdMicros(value, "run.maxCostUsd"), (e) => e.piDispatchConfig === true && e.message.startsWith("run.maxCostUsd must be a dollar amount"), `${String(value)} must be refused`);
	}
});

test("parseUsdMicros: a NUMBER is read by its value, as JavaScript prints it (documented: quote the amount)", () => {
	// JSON has already parsed these before parseUsdMicros sees them, so the operator's characters are gone.
	assert.equal(parseUsdMicros(JSON.parse("1e2"), "k"), 100_000_000, "1e2 unquoted is the number 100");
	assert.equal(parseUsdMicros(JSON.parse("0.5e1"), "k"), 5_000_000);
	assert.equal(parseUsdMicros(JSON.parse("1.00000000000000001"), "k"), 1_000_000, "digits past a float are lost first");
	// The same characters as a STRING are checked as written, and refused.
	for (const text of ["1e2", "0.5e1", "1.00000000000000001"]) assert.throws(() => parseUsdMicros(text, "k"), /k must be/);
});

test("parseUsdMicros: the refusal names the key and never echoes the value", () => {
	const secretish = "sk-ant-api03-pasted-into-the-wrong-field";
	assert.throws(() => parseUsdMicros(secretish, "PI_MAX_COST_USD"), (e) => e.message.includes("PI_MAX_COST_USD") && !e.message.includes(secretish) && !e.message.includes("pasted"));
	assert.throws(() => parseUsdMicros("1.1234567", "maxCostUsd"), (e) => !e.message.includes("1.1234567"));
});

test("optionalUsdMicros: null and undefined are absent, everything else is parseUsdMicros", () => {
	assert.equal(optionalUsdMicros(null, "k"), null);
	assert.equal(optionalUsdMicros(undefined, "k"), null);
	assert.equal(optionalUsdMicros("3", "k"), 3_000_000);
	assert.throws(() => optionalUsdMicros("", "k"), /k must be/);
	assert.equal(MAX_USD_MICROS, 1e12);
});

test("formatMicros prints dollars with at least two decimals and no float", () => {
	assert.equal(formatMicros(2_500_000), "2.50");
	assert.equal(formatMicros(2_000_000), "2.00");
	assert.equal(formatMicros(1), "0.000001");
	assert.equal(formatMicros(1_123_456), "1.123456");
	assert.equal(formatMicros(0), "0.00");
	assert.equal(formatMicros(1_000_000_000_000), "1000000.00");
	for (const bad of [-1, 1.5, "1", null, Number.NaN]) assert.throws(() => formatMicros(bad), TypeError);
	// Round trip over a spread of values, so the two halves of the type agree.
	for (const micros of [1, 10, 999_999, 1_000_001, 123_456_789, 999_999_999_999]) assert.equal(parseUsdMicros(formatMicros(micros), "k"), micros);
});

test("checkDollarInvariant: each window without maxCostUsd is invalid, by name; with it, all are valid", () => {
	assert.deepEqual([...DOLLAR_SETTING_KEYS], ["maxCostUsd", "dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd"]);
	assert.equal(checkDollarInvariant({}), null, "nothing set");
	assert.equal(checkDollarInvariant({ maxCostUsd: "2" }), null, "a cap alone is fine");
	for (const window of DOLLAR_WINDOW_KEYS) {
		const res = checkDollarInvariant({ [window]: "10", maxCostUsd: null });
		assert.ok(res?.invalid, `${window} without a cap`);
		assert.match(res.invalid, new RegExp(`^${window} needs maxCostUsd`));
		assert.equal(checkDollarInvariant({ [window]: "10", maxCostUsd: "2" }), null, `${window} with a cap`);
	}
	assert.equal(checkDollarInvariant({ dailyCostUsd: "10", weeklyCostUsd: "50", monthlyCostUsd: "100", maxCostUsd: 2 }), null);
	assert.equal(checkDollarInvariant(undefined), null);
});

test("effectiveCostCapMicros: the smaller of trigger and deployment, each only when set; a trigger can only narrow", () => {
	assert.equal(effectiveCostCapMicros(undefined, null), null, "neither: no cap, the job carries none");
	assert.equal(effectiveCostCapMicros(null, undefined), null);
	assert.equal(effectiveCostCapMicros(undefined, "5"), 5_000_000, "deployment only");
	assert.equal(effectiveCostCapMicros("1.5", null), 1_500_000, "trigger only: it applies, a deployment with no cap asked for none");
	assert.equal(effectiveCostCapMicros("1.5", "5"), 1_500_000, "trigger below: the trigger narrows");
	assert.equal(effectiveCostCapMicros("9", "5"), 5_000_000, "trigger above: the deployment wins, never the larger");
	assert.equal(effectiveCostCapMicros(5, "5.000000"), 5_000_000, "equal");
	assert.equal(effectiveCostCapMicros(0.000001, 1000000), 1);
});

test("effectiveCostCapMicros: a malformed trigger value (a hand-built queue entry) reads as 0, never as the deployment cap or none", () => {
	for (const bad of ["lots", -1, "1.1234567", 0, {}]) {
		assert.equal(effectiveCostCapMicros(bad, "5"), 0, `${JSON.stringify(bad)} with a deployment cap`);
		assert.equal(effectiveCostCapMicros(bad, null), 0, `${JSON.stringify(bad)} without one`);
	}
});

test("triggerCapAboveDeployment: the first trigger whose cap is above the deployment's, by index", () => {
	const t = (maxCostUsd) => ({ on: { type: "label" }, run: { kind: "github", ...(maxCostUsd !== undefined && { maxCostUsd }) } });
	const triggers = [t(undefined), t("2"), t(5), t("5.000001"), t("9")];
	assert.equal(triggerCapAboveDeployment(triggers, "5"), 3, "equal is not above; one micro-dollar more is");
	assert.equal(triggerCapAboveDeployment(triggers, "9"), -1);
	assert.equal(triggerCapAboveDeployment(triggers, null), -1, "no deployment cap: nothing to be above");
	assert.equal(triggerCapAboveDeployment(triggers, undefined), -1);
	assert.equal(triggerCapAboveDeployment([], "1"), -1);
});

test("money.mjs is import-free and exported, so the receiver and the console can use it without dragging fs in", () => {
	const src = readFileSync(new URL("../src/money.mjs", import.meta.url), "utf8");
	assert.equal(/^\s*import\s/m.test(src), false, "no import statement");
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.exports["./money"], "./src/money.mjs");
});
