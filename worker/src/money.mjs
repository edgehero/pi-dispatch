/**
 * The money type (issue #501): every dollar amount pi-dispatch stores, compares or sends is an INTEGER number
 * of micro-dollars (1 USD = 1,000,000). Integers add exactly, in JavaScript and in Valkey's INCRBY alike; a
 * float total drifts, and a cap compared against a drifted total is a cap that admits one call too many.
 *
 * PURE and import-free, on `model-ref.mjs`'s rule: `triggers.mjs` (which the receiver loads and the admin
 * bundle inlines) and `runtime-settings.mjs` (which the admin imports) both validate with it, and neither may
 * drag config.mjs's fs and os in with it.
 */

/** Micro-dollars in one dollar. */
export const MICROS_PER_USD = 1_000_000;

/** The largest amount a setting may name: 1,000,000 USD. Far above any real cap, and it keeps every sum safe. */
export const MAX_USD_MICROS = 1_000_000 * MICROS_PER_USD;

// At most 7 integer digits (the range check below does the real bounding), at most 6 decimals, no sign, no
// exponent, no leading zeros, no whitespace. The integer part is limited so the arithmetic below stays far
// inside Number.MAX_SAFE_INTEGER whatever it is handed.
const USD_PATTERN = /^(0|[1-9]\d{0,6})(\.\d{1,6})?$/;

/** The dollar keys a deployment can set, in the order the settings list them. */
export const DOLLAR_SETTING_KEYS = Object.freeze(["maxCostUsd", "dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd"]);
/** Each dollar key's environment variable: one table for config.mjs, doctor and the console. */
export const DOLLAR_ENV_NAMES = Object.freeze({ maxCostUsd: "PI_MAX_COST_USD", dailyCostUsd: "PI_DAILY_COST_USD", weeklyCostUsd: "PI_WEEKLY_COST_USD", monthlyCostUsd: "PI_MONTHLY_COST_USD" });
/** The three dollar WINDOWS, each of which needs a per-job cap to reserve (`checkDollarInvariant`). */
export const DOLLAR_WINDOW_KEYS = Object.freeze(["dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd"]);

// config.mjs's `configError` shape, built here so this module stays import-free (model-ref.mjs does the same).
function configError(message) {
	return Object.assign(new Error(message), { piDispatchConfig: true });
}

/**
 * Parse a dollar amount into integer micro-dollars, or throw a tagged config error naming `key`.
 *
 A STRING is read exactly as written, and that is the form to recommend: the pattern below is applied to
 * the operator's own characters, so `"1e3"`, `"0.1234567"` and `" 2"` are refused.
 *
 * A NUMBER is read by its VALUE, as `String(n)`, the decimal JavaScript prints for it. JSON has already
 * turned the operator's characters into a float before this runs, so what they typed is gone: `1e2` in a
 * JSON file is the number 100 and passes as $100, `0.5e1` passes as $5, and `1.00000000000000001` has lost
 * its last digits to the float and passes as $1. Only a value whose PRINTED form breaks the pattern is
 * refused: `1e-7` prints "1e-7", `0.1 + 0.2` prints "0.30000000000000004", `1e21` prints "1e+21". So "never
 * rounded, no exponents" holds for strings; for a number it holds for the value JavaScript prints.
 *
 * The conversion is INTEGER-ONLY: the whole part times 1,000,000 plus the decimals padded to six digits.
 * `Math.round(n * 1e6)` WITHOUT the pattern was the obvious alternative and is wrong, because it would quietly
 * accept a value with seven decimals and pick a cap the operator never wrote. (With the pattern in front, it
 * would compute the same integer; the integer form keeps the rule visible.)
 *
 * Above 0 and at most 1,000,000 USD. Zero is refused on purpose: a setting of 0 would read as "no cap" to
 * anyone skimming a file, while the runner reads it as "no priced call at all". The error names the key, never
 * the value: a value an operator typed into the wrong field could be anything.
 */
export function parseUsdMicros(value, key) {
	const text = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
	const match = text === null ? null : USD_PATTERN.exec(text);
	if (match) {
		const whole = Number(match[1]);
		const fraction = Number((match[2] ?? ".").slice(1).padEnd(6, "0"));
		const micros = whole * MICROS_PER_USD + fraction;
		if (micros > 0 && micros <= MAX_USD_MICROS) return micros;
	}
	throw configError(`${key} must be a dollar amount above 0 and at most 1000000, with at most 6 decimals, written as a plain decimal (a string or a number)`);
}

/**
 * The same parse, for a value that may be absent: `null` and `undefined` are `null` (no cap), anything else is
 * `parseUsdMicros`. Absence is how every dollar setting is switched off; 0 is not (see above).
 */
export function optionalUsdMicros(value, key) {
	return value === null || value === undefined ? null : parseUsdMicros(value, key);
}

/**
 * Integer micro-dollars as a plain dollar decimal, at least two decimals and no trailing zeros past them:
 * 2500000 is "2.50", 1 is "0.000001". For messages and displays; never parsed back by anything that enforces.
 */
export function formatMicros(micros) {
	if (!Number.isSafeInteger(micros) || micros < 0) throw new TypeError("formatMicros: want a non-negative safe integer");
	const whole = Math.floor(micros / MICROS_PER_USD);
	const fraction = String(micros % MICROS_PER_USD).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
	return `${whole}.${fraction}`;
}

/**
 * The cross-key rule (issue #501): a dollar window without `maxCostUsd` is invalid, because a window reserves
 * each job's per-job cap before the container starts, and without a cap there is no amount to reserve.
 *
 * It runs on MERGED values, never per key: an env `PI_MAX_COST_USD` with an overlay `dailyCostUsd` is valid,
 * and a per-key check of the overlay alone would refuse it. `settings` holds the four keys as they were set
 * (any value but `null`/`undefined` counts as set). Returns `null`, or `{ invalid }` naming the first window
 * that lacks a cap.
 */
export function checkDollarInvariant(settings) {
	const set = (key) => settings?.[key] !== null && settings?.[key] !== undefined;
	if (set("maxCostUsd")) return null;
	const window = DOLLAR_WINDOW_KEYS.find(set);
	return window === undefined ? null : { invalid: `${window} needs maxCostUsd: a dollar window reserves each job's per-job cost cap before it starts, so it cannot be set without one` };
}

/**
 * The per-job cost cap a job runs under, in micro-dollars, or `null` for none (issue #501): the SMALLER of the
 * trigger's `run.maxCostUsd` and the deployment's `maxCostUsd`, each counted only when set.
 *
 * A trigger can only NARROW. Where both are set the smaller wins, so a trigger can never lift a job above the
 * deployment's cap (and a value above the env cap refuses the worker's load of the file too, `loadSchedules`). Where only the trigger sets one, it
 * applies: a deployment that set no cap asked for none, and a trigger that asks for one is still a narrowing.
 *
 * The deployment value is validated before it gets here (config.mjs at boot, `validateOverlay` per job). The
 * trigger value is validated by the loader in both services, so a malformed one reaches this only from a
 * hand-built queue entry. That one does not throw (this runs at pickup, where a throw is a retry) and does not
 * fall back to the deployment cap either, which would quietly drop a cap that was asked for: it reads as 0,
 * the cap that refuses every priced call, and the run stops with `cost-cap`. `onMalformed(key)` is called
 * when that happens, so the worker logs it rather than leaving a $0 cap unexplained.
 */
export function effectiveCostCapMicros(triggerValue, deploymentValue, onMalformed = () => {}) {
	let trigger;
	try {
		trigger = optionalUsdMicros(triggerValue, "run.maxCostUsd");
	} catch {
		// Fail closed, and say so: `onMalformed` is told the KEY (never the value), so the caller can log it.
		trigger = 0;
		onMalformed("maxCostUsd");
	}
	const deployment = optionalUsdMicros(deploymentValue, "maxCostUsd");
	if (trigger === null) return deployment;
	if (deployment === null) return trigger;
	return Math.min(trigger, deployment);
}

/**
 * The first parsed trigger whose `run.maxCostUsd` is above the deployment's `maxCostUsd`, as its index in
 * `triggers`, or -1 (issue #501). A trigger may only narrow the per-job cap, so a value above it can only be a
 * mistake: the job would run under the deployment's cap anyway, while the file reads as allowing more. Pure,
 * so `triggers.mjs` stays env-free and the worker's trigger load and doctor ask the same question. An unset
 * deployment cap has nothing to be above.
 */
export function triggerCapAboveDeployment(triggers, deploymentValue) {
	const deployment = optionalUsdMicros(deploymentValue, "maxCostUsd");
	if (deployment === null) return -1;
	return triggers.findIndex((t) => t?.run?.maxCostUsd !== undefined && t.run.maxCostUsd !== null && parseUsdMicros(t.run.maxCostUsd, "run.maxCostUsd") > deployment);
}
