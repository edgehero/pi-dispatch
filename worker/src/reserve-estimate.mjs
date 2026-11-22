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
 * The processor's own reserve step goes one rule further (issue #1008, `reserveVerdict`): a job whose every route is
 * on a subscription with no paid extra usage reserves nothing and keeps its cap. The estimate below does not know this
 * host's connections, so for such a job it names the cap, the larger figure, never a smaller one than the worker holds.
 *
 * The deployment's settings resolve as the worker's do, `overlay > env > default` per key (runtime-settings.mjs over
 * config.mjs), with an empty env value unset (`usdSetting`).
 */

import { effectiveCostCapMicros } from "./money.mjs";
import { splitModelEntry, subscriptionRoutes } from "./model-ref.mjs";
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

/**
 * Issue #1008: whether a subscription connection's calls are NOTIONAL. One with no paid extra usage
 * (`extraUsageCreditMicros` unset: the provider bills no call on it, and for Claude the quota gate admits it only while
 * extra usage is known to be off) spends nothing per call, so its list price is not money. One WITH paid extra usage
 * may bill any call and nothing says which, so its calls are money: they stay under the cost cap and in the dollar
 * windows (`auth-credit-cap-required` still holds its cap to the credit). Anything but a positive safe integer of
 * micro-dollars reads as "none", the auth policy's own rule. A ChatGPT connection has no modelled overage, so it is
 * notional (an account with purchased credits is a residual), and Claude extra usage turned on at the provider during
 * a running job, with no credit edit, is billed past the quota with no dollar bound (the other residual). The one rule behind the worker's `notional: true` marker on a job's snapshot (subscription-runtime.mjs
 * `prepare`) and the pickup's skip of a notional candidate's model window (`notionalProvidersOf`).
 */
export function notionalConnection(row) {
	return row !== null && typeof row === "object" && !(Number.isSafeInteger(row.extraUsageCreditMicros) && row.extraUsageCreditMicros > 0);
}

/**
 * The providers whose connections a subscription check admitted (`check`'s `managed` rows) and that are notional, as a
 * Set. Empty for anything else: a refusal, a wait, an API-key route, or no check at all, so a doubt keeps the window.
 */
export function notionalProvidersOf(checked) {
	if (checked?.ok !== true || !Array.isArray(checked.managed)) return new Set();
	return new Set(checked.managed.filter((row) => notionalConnection(row) && typeof row.provider === "string").map((row) => row.provider));
}

/**
 * What a pickup candidate's model windows are judged against (index.mjs's `reservationFor`, model-selection.mjs and
 * model-failover.mjs `modelWindowHasRoom`): 0, so no window is checked, for a zero-rated candidate and (issue #1008)
 * for one whose own provider its subscription check admitted on a notional connection, since the reserve step drops
 * that provider's model rows (`billedModelRows`); its cap otherwise. `checked` is the candidate's `check` result, or
 * null when no subscription check ran, which keeps the window.
 */
export function candidateWindowReservation(candidate, checked = null, { modelEndpoints = null, builtinModel = () => null } = {}) {
	if (notionalProvidersOf(checked).has(candidate?.provider)) return 0;
	return zeroRatedFor(candidate, { modelEndpoints, builtinModel }).zeroRated ? 0 : candidate.maxCostMicros;
}

/** The providers a job's prepared subscription snapshots mark notional (subscription-runtime.mjs `prepare`), as a Set. */
export function notionalSnapshotProviders(snapshots) {
	return new Set((Array.isArray(snapshots) ? snapshots : []).filter((row) => row?.notional === true && typeof row.provider === "string").map((row) => row.provider));
}

/**
 * The model dollar rows (`modelDollarRows`, `{ ref, keyPrefix, caps }`, `ref` lowercased `provider/model`) a job reserves
 * and settles in (issue #1008): every row but those of a notional provider. A subscription call with no paid extra usage
 * bills nothing, so it leaves every dollar window, a model's included.
 */
export function billedModelRows(rows, notional) {
	const list = Array.isArray(rows) ? rows : [];
	if (!(notional instanceof Set) || notional.size === 0) return list;
	return list.filter((row) => !notional.has(String(row?.ref ?? "").split("/")[0]));
}

/**
 * How the worker reserves for an EFFECTIVE job at pickup (issue #1008), the processor's reserve step and the fork check:
 *   - `{ reserve: "none", zeroRated: true }`: the job cannot spend (`zeroRatedFor`). It runs under a per-job cap of 0
 *     and reserves nothing (issue #503 part 7);
 *   - `{ reserve: "none", zeroRated: false }`: the job reaches no BILLED route. Every route it may call (its callable
 *     models, its auxiliary models and its decision roles, `subscriptionRoutes`) is on a provider in `notional` (the
 *     providers its prepared snapshots mark notional, `notionalSnapshotProviders`) or is zero-rated. It reserves
 *     nothing, but KEEPS its real cap: an image from before issue #1008 still counts subscription calls at list price
 *     under it, and a cap of 0 would make such an image refuse every call;
 *   - `{ reserve: "cap", zeroRated: false }`: it reserves its cap, as every job did before.
 * A route whose entry does not split is billed (fail closed), and so is a job with no finite allowed-model list: it may
 * switch to any model mid-run, so its routes are not the ones it names (a subscription job always has one, the
 * subscription check refuses it otherwise). With no notional provider the answer is exactly the zero-rated rule's, so a
 * job without a subscription reserves as it always did.
 */
export function reserveVerdict(job, { notional = null, modelEndpoints = null, builtinModel = () => null } = {}) {
	if (zeroRatedFor(job, { modelEndpoints, builtinModel }).zeroRated) return { reserve: "none", zeroRated: true };
	if (!(notional instanceof Set) || notional.size === 0 || !Array.isArray(job.models) || job.models.length === 0) return { reserve: "cap", zeroRated: false };
	const zeroRated = (ref) => zeroRatedVerdict({ models: modelEndpoints?.models ?? null, endpoints: modelEndpoints?.endpoints ?? [], refs: [ref], builtinModel }).zeroRated;
	const billed = [...callableModelRefs(job), ...subscriptionRoutes(job)].some((ref) => ref === null || (!notional.has(ref.provider) && !zeroRated(ref)));
	return { reserve: billed ? "cap" : "none", zeroRated: false };
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
