/**
 * Operator-declared subscription plans (issue #53): the one place a flat-rate plan's real price can be
 * stated. pi-ai's rate table for a subscription-backed provider does not state the plan's price: at 0.80.7
 * kimi-coding and zai-coding-cn shipped all-zero tables, so their runs recorded cost 0 and read as FREE
 * when they were PREPAID; at the 0.99.1 pin most of their models carry an implied API-equivalent rate
 * instead (issue #509), so the same prepaid runs now record a POSITIVE cost and read as METERED spend.
 * Either way the table is the wrong price, and a zero rate is no longer even a hint that a plan exists
 * (the qwen-token-plan family is all-zero, and so are free models of metered providers). And the env
 * boundary REFUSES OAuth/subscription logins on purpose (env-allowlist.mjs: an expiring token cannot power an
 * unattended service), so no credential ever reaches the worker that could name the plan. An operator-side
 * declaration is therefore the only honest price source, and `subscriptions.json` is that declaration.
 *
 * This file feeds COUNTERFACTUAL ARITHMETIC ONLY (DES-SUBSCRIPTIONS-ARE-COUNTERFACTUAL-ONLY): the admin
 * extension prices runs that already happened against the plans declared here. It never touches job
 * execution, routing, or auth -- the worker exports this validator and reads nothing at job time. The
 * parser lives in the worker purely for the shared-validator anti-drift idiom: the admin imports it the
 * same way it imports parseTriggers/parsePauseWindows, so the two sides cannot drift on the schema.
 *
 * Two rules carry the file's whole posture:
 *   - `version` is REQUIRED and a version this build does not understand fails LOUD, naming both
 *     versions. Fail-loud-on-newer is the one thing that cannot be retrofitted: a v1 reader that
 *     shrugged at v2 would misprice silently forever.
 *   - `null` is FIRST-CLASS for a window's `unit`/`limit`: vendors mostly do not disclose them, and a
 *     declared "undisclosed" must stay distinguishable from a number someone invented.
 *
 * Pure and fs-free (mirrors triggers.mjs): takes the file TEXT, returns `{ version, subscriptions }`
 * normalized (unknown fields dropped -- the operator-file policy, per triggers.mjs), throws `configError`
 * fail-loud on any invalid known field. `path` is for error messages only.
 *
 * Custom: subscriptions validated inline per triggers.mjs/pause-windows.mjs precedent; zod not in deps
 */

import { configError } from "./config.mjs";

/** The schema version this build reads and writes. A file declaring a higher one is refused loudly. */
export const SUBSCRIPTIONS_VERSION = 1;

/** The window sizes vendors actually publish limits in; "month" is the calendar billing month. */
const WINDOW_PERS = new Set(["5h", "7d", "30d", "month"]);
/** What a window's limit counts. `null` (vendor undisclosed) is deliberately not in this set -- it is
 * handled as its own first-class value, never as a fifth unit. */
const WINDOW_UNITS = new Set(["tokens", "requests", "prompts", "credits"]);

/** A model glob is operator-authored but still bounded: the charset of real model ids plus `*`. */
const MODEL_GLOB_RE = /^[A-Za-z0-9*._:/-]{1,64}$/;

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

/** Validate a non-empty array of bounded model globs; returns the trimmed list. */
function normalizeGlobs(value, label, at, path) {
	if (!Array.isArray(value) || value.length === 0) {
		throw configError(`${at}: ${label} must be a non-empty array of model globs: ${path}`);
	}
	return value.map((glob) => {
		if (typeof glob !== "string" || !MODEL_GLOB_RE.test(glob.trim())) {
			throw configError(`${at}: ${label} glob ${JSON.stringify(glob)} must match ${MODEL_GLOB_RE} (model-id charset plus "*", max 64 chars): ${path}`);
		}
		return glob.trim();
	});
}

/** A boolean-or-absent field; absent takes `fallback`, anything non-boolean is refused. */
function normalizeBool(value, label, at, path, fallback) {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw configError(`${at}: ${label} must be a boolean: ${path}`);
	return value;
}

/**
 * Parse, validate, and normalize the subscriptions file TEXT. Returns `{ version, subscriptions }` with
 * every subscription and window rebuilt as an explicit literal (defaults applied, unknown fields
 * dropped). Throws `configError` (fail-loud) on any problem, with a positional label naming the offending
 * entry. `path` is for error messages only -- this function touches no filesystem.
 */
export function parseSubscriptions(text, path) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw configError(`subscriptions file is not valid JSON: ${path} (${error.message})`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw configError(`subscriptions file must be a JSON object: ${path}`);
	}

	// Version first, before the array shape: a newer file may not even carry a shape this build can read,
	// and the refusal must name both versions rather than degenerate into a field-level error.
	const version = parsed.version;
	if (!Number.isInteger(version) || version < 1) {
		throw configError(`subscriptions file must declare an integer "version" >= 1 (got ${JSON.stringify(version)}): ${path}`);
	}
	if (version > SUBSCRIPTIONS_VERSION) {
		throw configError(`subscriptions file written by a newer pi-dispatch (version ${version}; this build understands ${SUBSCRIPTIONS_VERSION}): ${path}`);
	}

	const entries = parsed.subscriptions;
	if (!Array.isArray(entries)) {
		throw configError(`subscriptions file must have a "subscriptions" array: ${path}`);
	}

	const seenIds = new Map();
	return { version, subscriptions: entries.map((entry, index) => normalizeSubscription(entry, index, path, seenIds)) };
}

function normalizeSubscription(entry, index, path, seenIds) {
	const at = `subscription at index ${index}`;
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
		throw configError(`${at}: must be an object: ${path}`);
	}

	if (!isNonEmptyString(entry.id)) throw configError(`${at}: id must be a non-empty string: ${path}`);
	const id = entry.id.trim();
	if (seenIds.has(id)) {
		throw configError(`${at}: id ${JSON.stringify(id)} is already used by the subscription at index ${seenIds.get(id)}: ${path}`);
	}
	seenIds.set(id, index);

	if (!isNonEmptyString(entry.vendor)) throw configError(`${at}: vendor must be a non-empty string: ${path}`);
	if (!isNonEmptyString(entry.provider)) throw configError(`${at}: provider must be a non-empty string (the pi-ai provider id this plan covers): ${path}`);

	const models = entry.models === undefined ? ["*"] : normalizeGlobs(entry.models, "models", at, path);

	const price = entry.price;
	if (price === null || typeof price !== "object" || Array.isArray(price)) {
		throw configError(`${at}: price must be an object { amount, currency, per }: ${path}`);
	}
	if (typeof price.amount !== "number" || !Number.isFinite(price.amount) || price.amount <= 0) {
		throw configError(`${at}: price.amount must be a number > 0: ${path}`);
	}
	if (typeof price.currency !== "string" || !/^[A-Z]{3}$/.test(price.currency)) {
		throw configError(`${at}: price.currency must be a 3-letter uppercase code (e.g. "USD"): ${path}`);
	}
	if (price.per !== "month") {
		throw configError(`${at}: price.per must be "month" (got ${JSON.stringify(price.per)}): ${path}`);
	}

	const sharedWithOtherProducts = normalizeBool(entry.sharedWithOtherProducts, "sharedWithOtherProducts", at, path, false);
	const hypothetical = normalizeBool(entry.hypothetical, "hypothetical", at, path, false);

	// Absent and explicit null both mean "no counterfactual declared" -- null is what the normalizer below
	// emits, so the parser must accept its own output (the admin re-validates normalized entries on write).
	let counterfactualModel = null;
	if (entry.counterfactualModel !== undefined && entry.counterfactualModel !== null) {
		const cm = entry.counterfactualModel;
		if (typeof cm !== "object" || Array.isArray(cm) || !isNonEmptyString(cm.provider) || !isNonEmptyString(cm.id)) {
			throw configError(`${at}: counterfactualModel must be { provider, id } with non-empty strings (a PRICED pi-ai model to re-price covered runs at API rates): ${path}`);
		}
		counterfactualModel = { provider: cm.provider.trim(), id: cm.id.trim() };
	}

	let windows = [];
	if (entry.windows !== undefined) {
		if (!Array.isArray(entry.windows)) throw configError(`${at}: windows must be an array: ${path}`);
		windows = entry.windows.map((w, windowIndex) => normalizeWindow(w, windowIndex, index, path));
	}

	return {
		id,
		vendor: entry.vendor.trim(),
		provider: entry.provider.trim(),
		models,
		price: { amount: price.amount, currency: price.currency, per: "month" },
		sharedWithOtherProducts,
		hypothetical,
		counterfactualModel,
		windows,
	};
}

function normalizeWindow(w, windowIndex, subIndex, path) {
	const at = `window at index ${windowIndex} of subscription at index ${subIndex}`;
	if (w === null || typeof w !== "object" || Array.isArray(w)) {
		throw configError(`${at}: must be an object: ${path}`);
	}

	if (!WINDOW_PERS.has(w.per)) {
		throw configError(`${at}: per must be one of 5h|7d|30d|month (got ${JSON.stringify(w.per)}): ${path}`);
	}
	const rolling = normalizeBool(w.rolling, "rolling", at, path, false);

	// `null` means the vendor did not disclose -- first-class, never coerced into a number or a unit.
	let unit = null;
	if (w.unit !== undefined && w.unit !== null) {
		if (!WINDOW_UNITS.has(w.unit)) {
			throw configError(`${at}: unit must be one of tokens|requests|prompts|credits, or null (vendor undisclosed): ${path}`);
		}
		unit = w.unit;
	}

	let limit = null;
	if (w.limit !== undefined && w.limit !== null) {
		if (typeof w.limit === "number") {
			if (!Number.isFinite(w.limit) || w.limit <= 0) throw configError(`${at}: limit must be a number > 0, [min, max], or null (vendor undisclosed): ${path}`);
			limit = w.limit;
		} else if (Array.isArray(w.limit)) {
			const [min, max] = w.limit;
			if (w.limit.length !== 2 || typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0 || min >= max) {
				throw configError(`${at}: limit range must be [min, max] with both > 0 and min < max: ${path}`);
			}
			limit = [min, max];
		} else {
			throw configError(`${at}: limit must be a number > 0, [min, max], or null (vendor undisclosed): ${path}`);
		}
	}

	// Same absent-or-null rule as counterfactualModel: null is the normalizer's own "covers all models".
	const scope = w.scope === undefined || w.scope === null ? null : normalizeGlobs(w.scope, "scope", at, path);

	return { per: w.per, rolling, unit, limit, scope };
}
