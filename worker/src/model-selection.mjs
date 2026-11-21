import { randomInt as cryptoRandomInt } from "node:crypto";
import { modelSelectionProblem, modelListProblem, modelOnList, splitModelEntry } from "./model-ref.mjs";
import { modelWindowHasRoom } from "./model-failover.mjs";
import { modelDollarRows } from "./scoped-limits.mjs";
import { MODEL_RECHECK_MS, readModelCooldown } from "./model-cooldowns.mjs";
import { LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH } from "./private-store-boundary.mjs";
import { effectiveCostCapMicros } from "./money.mjs";
import { readModelSelection, commitModelSelection, reuseModelSelection, allowModelSelectionQuotaReselection, modelSelectionPolicyDigest } from "./model-selection-state.mjs";

/** An unbiased permutation makes the first eligible entry uniform without giving authored order a priority. */
export function shuffledModels(candidates, randomInt = cryptoRandomInt) {
	const order = [...candidates];
	for (let i = order.length - 1; i > 0; i--) {
		const j = randomInt(i + 1);
		if (!Number.isSafeInteger(j) || j < 0 || j > i) throw new Error("invalid random model draw");
		[order[i], order[j]] = [order[j], order[i]];
	}
	return order;
}

const managed = (result) => result?.rootManaged ?? (result?.managed === true || Array.isArray(result?.managed) && result.managed.length > 0);
const candidateJob = (job, ref) => {
	const { provider, model } = splitModelEntry(ref);
	return { ...job, provider, model, models: [...new Set([ref, ...(job.auxiliaryModels ?? [])])] };
};

/**
 * Issue #968: the trigger's OWN positive cap, the one a pool mixing billing classes needs. The deployment's cap alone
 * does not count: it is not a decision about this pool, and a trigger that drew API candidates under a deployment
 * default only would spend an API key nobody chose a bound for. `maxCostUsd` is the trigger's value as queued (a
 * malformed one reads as 0, `effectiveCostCapMicros`, so it fails closed), and `maxCostMicros` the cap the job runs
 * under, which must be a positive integer too.
 */
function triggerCapped(job) {
	return effectiveCostCapMicros(job.maxCostUsd, null) > 0 && Number.isSafeInteger(job.maxCostMicros) && job.maxCostMicros > 0;
}

/** Polling is bounded independently of reset evidence: an unknown provider reset must never become a fabricated time. */
function waiting(blockers, at) {
	const known = blockers.map((blocker) => blocker.resetAt).filter((value) => Number.isSafeInteger(value) && value > at);
	// An unknown alternative may clear earlier, but cannot erase another candidate's observed reset.
	const resetAt = known.length ? Math.min(...known) : null;
	return { wait: blockers[0].wait, until: Math.min(at + MODEL_RECHECK_MS, ...known), resetAt };
}

/** Read-only admission precedes endpoint leases and the durable CAS; a losing pickup releases its own leases. */
export async function selectRandomModelJob(job, { redis, id, retry = false, retryNeverStarted = false, lockedModel = null, recoveryModel = null, attempt = 1, limits = [], now = Date.now, randomInt = cryptoRandomInt, checkCandidate, subscriptionCheck = null, subscriptionPolicyCheck = null, reservationFor = (candidate) => candidate.maxCostMicros, acquireEndpoints = async () => true, releaseEndpoints = async () => {}, log = () => {} } = {}) {
	// Internal decision jobs and canaries have independently reviewed fixed routes, not this ordinary-flow policy.
	if (job?.command !== undefined || job?.canary === true || ["packageCanary", "watch", "answerDraft", "questionGrouping", "watchDecisionModel", "answerDecisionModel", "questionGroupModel"].some((field) => job?.[field] != null)) return { refused: "model-selection-no-candidate" };
	if (modelSelectionProblem(job?.modelSelection) !== null || modelListProblem(job.models) !== null) return { refused: "model-selection-no-candidate" };
	if (typeof id !== "string" || !id) return { refused: "model-selection-state-unavailable" };
	const candidates = job.modelSelection.candidates;
	const locked = lockedModel ?? recoveryModel;
	const continuity = job.modelSelectionContinuation ?? job.modelSelectionRecovery ?? null;
	// The complete ceiling is checked before any random draw, including candidates that happen to be unavailable.
	for (const ref of candidates) {
		const split = splitModelEntry(ref);
		if (!modelOnList(job.models, split.provider, split.model)) return { refused: "model-selection-policy-changed" };
	}
	if (locked && !candidates.includes(locked)) return { refused: "model-selection-policy-changed" };
	const subscriptions = new Map();
	// Issue #968: the billing class is each candidate's own (`classes[ref]`, "subscription" or "api"), decided by the
	// draw, never one class for the whole pool. A candidate bound to a connection that cannot authorize right now
	// (signed out, exhausted, unreadable) still classifies "subscription", so a failing subscription never reads as an
	// API-key route. No entry means an unwired seam, which pins nothing, as an unwired pool's null billing did.
	let classes = {};
	let bindings = {};
	if (subscriptionPolicyCheck) {
		const policy = await subscriptionPolicyCheck({ ...job, provider: undefined, model: undefined, models: [...new Set([...candidates, ...(job.auxiliaryModels ?? [])])] });
		if (policy.unavailable) throw new Error("subscription state unavailable");
		if (!policy.ok) return { refused: policy.reason ?? "model-selection-no-candidate" };
		classes = policy.classes ?? {};
		bindings = policy.bindings ?? {};
	} else if (subscriptionCheck) {
		// The fallback seam is useful for embedders/tests, and still inspects every route before choosing an order.
		for (const ref of candidates) {
			const checked = await subscriptionCheck(candidateJob(job, ref));
			if (checked.unavailable) throw new Error("subscription state unavailable");
			if (checked.reason === LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH || checked.reason === "auth-mixed-billing") return { refused: checked.reason };
			classes[ref] = managed(checked) ? "subscription" : "api";
			subscriptions.set(ref, checked);
			bindings[ref] = checked.binding ?? null;
		}
	}
	// Issue #968: a pool whose candidates fall in BOTH classes on this host may draw an API-key candidate, so it needs the
	// trigger's own positive cap, decided here, before continuity, the state, the shuffle, a lease or a commit, so it
	// costs nothing and refuses the same whatever a draw would have been. The loader cannot decide it: a candidate's
	// class depends on this host's connections, and the receiver and the poller load the same file without them. A
	// continuation and a recovery are refused alike, since their pool is the same pool. A pool of one class, API keys
	// alone included, needs no cap, as before.
	if (new Set(candidates.map((ref) => classes[ref]).filter((value) => value !== undefined)).size > 1 && !triggerCapped(job)) return { refused: "auth-route-unbounded" };
	if (continuity) {
		if (continuity.ref !== locked || ![null, "api", "subscription"].includes(continuity.billing) || continuity.billing !== (classes[locked] ?? null) || !(continuity.billing === "subscription" ? typeof continuity.binding === "string" && /^[a-f0-9]{64}$/.test(continuity.binding) : continuity.binding === null)) return { refused: "model-selection-continuation-unavailable" };
		if (Object.hasOwn(bindings, locked) && bindings[locked] !== continuity.binding) return { refused: "auth-binding-changed" };
	}
	for (let pass = 0; pass < 4; pass++) {
		let state = await readModelSelection(redis, id);
		if (state?.newer) return { newer: true };
		if (state?.invalid || !state && retry && !retryNeverStarted && !locked) return { refused: "model-selection-state-unavailable" };
		if (state && (state.policyDigest !== modelSelectionPolicyDigest(candidates) || !candidates.includes(state.ref) || locked && state.ref !== locked)) return { refused: "model-selection-policy-changed" };
		// The committed ref's CURRENT class against the one it was drawn under: a class change of a candidate the run never
		// drew is nothing to this run, and does not refuse it.
		if (state && (state.billing !== null && (classes[state.ref] ?? null) !== state.billing || state.binding && Object.hasOwn(bindings, state.ref) && bindings[state.ref] !== state.binding)) return { refused: "auth-binding-changed" };
		if (state && continuity && (state.billing !== continuity.billing || state.binding !== continuity.binding)) return { refused: "model-selection-continuation-unavailable" };
		if (state) {
			const reused = await reuseModelSelection(redis, id, state, { attempt, locked: !!locked });
			if (!reused.ok) continue;
			state = reused.state;
			// A prior run record cannot clear a newer armed token. The host's positive never-started result
			// resets only its own exact token at the failure boundary (markModelSelectionNeverStarted).
		}
		const reselect = state?.phase === "quota-reselectable" && !locked;
		const order = locked ? [locked] : state && !reselect ? [state.ref] : shuffledModels(candidates, randomInt);
		const blockers = [];
		let conflicted = false;
		for (const ref of order) {
			// Issue #968: a quota reselection stays in the class the first draw billed. A candidate of the other class is
			// passed over before any auth read of it, keeping the permutation (and so the number of random draws) as it
			// was; when every same-class candidate is blocked the job waits, and never crosses to the other class.
			if (reselect && state.billing !== null && classes[ref] !== state.billing) { log("model_candidate_skipped", { model: ref, reason: "auth-mixed-billing" }); continue; }
			// The class this attempt is pinned to: a continuation's, the committed choice's, or (a first draw or a
			// reselection) the candidate's own. `pinned` falls back to the candidate's class only for a choice an unwired
			// pickup committed with no class, as the whole pool's class did before.
			const expected = continuity ? continuity.billing : state && !reselect ? state.billing : classes[ref] ?? null;
			const pinned = expected ?? classes[ref] ?? null;
			const candidate = { ...candidateJob(job, ref), modelSelectionBilling: expected, modelSelectionBinding: bindings[ref] ?? null };
			if (continuity) candidate.modelSelectionBinding = continuity.binding;
			if (state && !reselect) candidate.modelSelectionBinding = state.binding;
			if (subscriptionCheck) {
				const subscription = subscriptions.get(ref) ?? await subscriptionCheck(candidate);
				if (subscription.unavailable) throw new Error("subscription state unavailable");
				// A live class other than the pinned one is a race with a binding change since the inspection, never a skip.
				if (pinned !== null && (managed(subscription) ? "subscription" : "api") !== pinned || candidate.modelSelectionBinding && subscription.ok && subscription.binding !== undefined && subscription.binding !== candidate.modelSelectionBinding) return { refused: "auth-binding-changed" };
				if ([LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH, "auth-mixed-billing", "auth-binding-changed"].includes(subscription.reason)) return { refused: subscription.reason };
				if (!subscription.ok) {
					if (subscription.wait) {
						const resetAt = subscription.status?.until ?? subscription.resetAt ?? null;
						const cooldown = await readModelCooldown(redis, ref, { now });
						blockers.push({ wait: subscription.wait, resetAt: resetAt === null ? null : Math.max(resetAt, cooldown?.until ?? 0) });
					}
					log("model_candidate_skipped", { model: ref, reason: subscription.wait ?? subscription.reason ?? "auth-unavailable" });
					if (!locked && state?.phase === "selected" && subscription.wait === "subscription-quota" && subscription.auxiliary !== true && subscription.status?.state === "exhausted" && subscription.status?.bindingValid !== false) {
						const allowed = await allowModelSelectionQuotaReselection(redis, id, state, { beforeStart: true, quotaConfirmed: true });
						if (allowed.ok || allowed.conflict) { conflicted = true; break; }
					}
					continue;
				}
				// A refresh-in-progress policy read may know the billing class before it can read the binding.
				// Once that candidate is ready, persist its authoritative identity with the first choice.
				if ((!state || reselect) && candidate.modelSelectionBinding === null && typeof subscription.binding === "string") candidate.modelSelectionBinding = subscription.binding;
			}
			if (pinned === "subscription" && !(typeof candidate.modelSelectionBinding === "string" && /^[a-f0-9]{64}$/.test(candidate.modelSelectionBinding))) return { refused: "auth-binding-changed" };
			const bad = await checkCandidate(candidate);
			if (bad) { log("model_candidate_skipped", { model: ref, reason: bad }); continue; }
			const cooldown = await readModelCooldown(redis, ref, { now });
			if (cooldown) { blockers.push({ wait: "model-cooldown", resetAt: cooldown.until }); log("model_candidate_skipped", { model: ref, reason: "cooldown" }); continue; }
			const reservationJob = { ...candidate, maxCostMicros: reservationFor(candidate) };
			if (modelDollarRows(limits, [ref]).length > 0 && !Number.isSafeInteger(reservationJob.maxCostMicros)) { log("model_candidate_skipped", { model: ref, reason: "model-cost-cap-missing" }); continue; }
			if (!(await modelWindowHasRoom(redis, ref, reservationJob, limits, now()))) { blockers.push({ wait: "model-window", resetAt: null }); log("model_candidate_skipped", { model: ref, reason: "model-window" }); continue; }
			let acquired = false;
			try {
				acquired = await acquireEndpoints(candidate);
				if (!acquired) { await releaseEndpoints(candidate); blockers.push({ wait: "endpoint", resetAt: null }); log("model_candidate_skipped", { model: ref, reason: "endpoint-busy" }); continue; }
				if (!state || reselect) {
					const committed = await commitModelSelection(redis, id, { expected: state, ref, candidates, modelWhy: reselect ? "random-subscription-limit" : "random", previous: reselect ? state.ref : null, attempt, billing: candidate.modelSelectionBilling, binding: candidate.modelSelectionBinding, now });
					if (!committed.ok) { await releaseEndpoints(candidate); acquired = false; conflicted = true; break; }
					state = committed.state;
				}
				const info = { strategy: "random", candidates: [...state.candidates], ...(state.previous ? { previous: state.previous } : {}) };
				return { job: { ...candidate, modelWhy: state.modelWhy, modelSelectionInfo: info }, ref, selection: state };
			} catch (error) {
				// Acquisition can fail after a partial hold; the owner seam releases everything it accumulated.
				await releaseEndpoints(candidate);
				throw error;
			}
		}
		if (conflicted) continue;
		return blockers.length ? waiting(blockers, now()) : { refused: "model-selection-no-candidate" };
	}
	return { wait: "model-selection", until: now() + MODEL_RECHECK_MS, resetAt: null };
}
