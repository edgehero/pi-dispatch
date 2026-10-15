/**
 * What a job will hold when the worker reserves for it (issue #642): the figure the operator console shows before a
 * paid action (a re-run, an answer to a parked run) is confirmed. CONST-BUDGET-BEFORE-TOKENS is unchanged: the worker
 * still reserves at pickup, and this only SAYS beforehand what that reserve will be.
 *
 * The rule is the worker's, imported rather than restated, which is the whole point of this module:
 *   - the per-job dollar cap is `effectiveCostCapMicros(trigger's maxCostUsd, deployment's maxCostUsd)` (money.mjs),
 *     the smaller of the two, each counted only when set: exactly what `effectiveJobOf` (index.mjs) gives `runJob`;
 *   - a job that cannot spend reserves nothing: `zeroRatedFor` below is the processor's own test (its reserve step
 *     calls it), a cap of 0 or every callable model served by a declared endpoint and zero-rated (model-endpoints.mjs);
 *   - every job takes one job-count slot in each window that applies.
 *
 * The deployment's settings resolve as the worker's do, `overlay > env > default` per key (runtime-settings.mjs over
 * config.mjs), with an empty env value unset (`usdSetting`).
 */

import { effectiveCostCapMicros } from "./money.mjs";
import { splitModelEntry } from "./model-ref.mjs";
import { zeroRatedVerdict } from "./model-endpoints.mjs";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, allowedModelsFrom } from "./config.mjs";

/**
 * The models a job may call (issue #501, #503 part 7), as `{ provider, id }` refs: its main model, and every entry of
 * its effective allowed-model list when it has one. A list entry that does not split is kept as `null`, which the
 * zero-rated check reads as "not zero-rated" (fail closed). Moved here from processor.mjs (issue #642), which imports
 * it, so the estimate and the reserve judge the same refs.
 */
export function callableModelRefs(job) {
	const refs = [{ provider: job.provider, id: job.model }];
	for (const entry of Array.isArray(job.models) ? job.models : []) {
		const ref = splitModelEntry(entry);
		refs.push(ref === null ? null : { provider: ref.provider, id: ref.model });
	}
	return refs;
}

/**
 * Can this EFFECTIVE job (provider, model, models and `maxCostMicros` resolved) spend nothing? `{ zeroRated: true }`
 * for a cap that is already 0 (nothing to reserve), else `zeroRatedVerdict` over its callable models and the pickup's
 * endpoint snapshot `{ models, endpoints }` (null: none, so never zero-rated). The processor's reserve step and the
 * console's estimate both call this, so the two cannot disagree on the rule.
 */
export function zeroRatedFor(job, { modelEndpoints = null, builtinModel = () => null } = {}) {
	if (job.maxCostMicros === 0) return { zeroRated: true };
	return zeroRatedVerdict({ models: modelEndpoints?.models ?? null, endpoints: modelEndpoints?.endpoints ?? [], refs: callableModelRefs(job), builtinModel });
}

/** An env dollar value as config.mjs's `usdSetting` reads it: unset or empty is null. Validated by the cap below. */
function envUsd(raw) {
	return raw === undefined || raw === "" ? null : raw;
}

/**
 * The reserve for `jobData` (the job's data as it will be queued), against the deployment's settings overlay and env:
 * `{ slots: 1, dollarsMicros, capMicros, zeroRated }`, or `{ invalid }` when the deployment's own dollar setting does
 * not parse (the worker refuses every job then, `settings-overlay-invalid`).
 *
 *   - `capMicros`: the per-job cap the runner enforces before every priced call, or null for none.
 *   - `dollarsMicros`: what the worker holds in each dollar window that applies (the deployment's, a scoped or model
 *     row's): 0 for a zero-rated job, else the cap; null when there is no cap (then no window can be set either, the
 *     dollar invariant). With no dollar window set the worker holds nothing in dollars, and the runner still stops
 *     the job at `capMicros`.
 *   - `zeroRated`: whether the job can spend nothing at all.
 *
 * `modelEndpoints` (`{ models, endpoints }`, the worker's pickup snapshot) and `builtinModel` are the zero-rated
 * check's inputs; without them a job is judged not zero-rated, the fail-closed direction (the estimate then names the
 * larger figure, never a smaller one than the worker holds).
 */
export function estimateReserve(jobData, { overlay = {}, env = {}, modelEndpoints = null, builtinModel = () => null } = {}) {
	const data = jobData ?? {};
	const o = overlay ?? {};
	// The deployment's allowed-model list (PI_ALLOWED_MODELS, env only, never the overlay), the worker's `effectiveJobOf`
	// fallback when the job names none: with it, every listed model must be zero-rated too, since the job may switch to
	// any of them. An env list the worker would refuse at boot cannot be judged at all, and judging it as "no list" would
	// NARROW the refs to the main model alone (a smaller figure than a list could give), so it is judged not zero-rated:
	// the estimate then names the cap, never less than a worker could hold.
	let allowed = null;
	let allowedInvalid = false;
	try {
		allowed = allowedModelsFrom(env ?? {});
	} catch {
		allowedInvalid = true;
	}
	const models = data.models ?? allowed ?? null;
	let capMicros;
	try {
		capMicros = effectiveCostCapMicros(data.maxCostUsd, o.maxCostUsd ?? envUsd(env?.PI_MAX_COST_USD));
	} catch (e) {
		return { invalid: e?.message ?? String(e) };
	}
	const job = {
		...data,
		provider: data.provider ?? o.provider ?? env?.PI_PROVIDER ?? DEFAULT_PROVIDER,
		model: data.model ?? o.model ?? env?.PI_MODEL ?? DEFAULT_MODEL,
		...(models !== null ? { models } : {}),
		maxCostMicros: capMicros,
	};
	if (capMicros === null) return { slots: 1, dollarsMicros: null, capMicros: null, zeroRated: false };
	const zero = allowedInvalid && (data.models ?? null) === null ? { zeroRated: false } : zeroRatedFor(job, { modelEndpoints, builtinModel });
	return { slots: 1, dollarsMicros: zero.zeroRated ? 0 : capMicros, capMicros, zeroRated: zero.zeroRated === true };
}
