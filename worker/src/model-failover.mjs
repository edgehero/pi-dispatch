import { createHash } from "node:crypto";
import { resolveBackendName } from "./backend-registry.mjs";
import { MODEL_WHY, providerFailureOf } from "./model-failover-protocol.mjs";
import { modelListProblem, modelOnList, splitModelEntry } from "./model-ref.mjs";
import { modelDollarRows } from "./scoped-limits.mjs";
import { dayKey, weekKey, monthKey } from "./budget.mjs";
import { builtinModel, checkModelsKnown } from "./model-catalog.mjs";
import { egressRefusalFor } from "./egress-allowlist.mjs";

export { MODEL_WHY, PROVIDER_FAILURE_KINDS, providerFailureOf } from "./model-failover-protocol.mjs";

export function failoverEgressRequired(job, { egress = false, defaultBackend = "local" } = {}) {
	return egress || ["openshell", "openshell-bind"].includes(resolveBackendName(job, defaultBackend));
}

import { MODEL_COOLDOWN_MAX_MS, MODEL_RECHECK_MS, modelCooldownKey, readModelCooldown, readModelCooldowns } from "./model-cooldowns.mjs";
import { FAILOVER_PRICED_APIS, failoverModelView, failoverPriceEligible } from "./model-status.mjs";
export { MODEL_COOLDOWN_MAX_MS, MODEL_RECHECK_MS, modelCooldownKey, readModelCooldown, readModelCooldowns };
export { FAILOVER_PRICED_APIS, failoverModelView };
const modelAttemptKey = (id) => `dispatch:model-attempt:${createHash("sha256").update(id).digest("hex")}`;
export { modelAttemptKey };

export async function markModelCooldown(redis, ref, failure, { now = () => Date.now() } = {}) {
	const signal = providerFailureOf(failure);
	if (!signal || signal.kind === "context-overflow") return null;
	const at = now();
	const delay = signal.resetAt === undefined ? (signal.kind === "quota-exhausted" ? MODEL_COOLDOWN_MAX_MS : MODEL_RECHECK_MS) : Math.max(1000, signal.resetAt - at);
	const ttl = Math.min(MODEL_COOLDOWN_MAX_MS, delay);
	const row = { kind: signal.kind, until: at + ttl };
	// Concurrent observations must never shorten an already published provider reset. One atomic script also
	// prevents two workers from both reading an old reset and then overwriting the longer one in reverse order.
	await redis.eval(`local old = redis.call('GET', KEYS[1]); if old then local ok, row = pcall(cjson.decode, old); if ok and type(row['until']) == 'number' and row['until'] > tonumber(ARGV[1]) then return 0 end end; redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]); return 1`, 1, modelCooldownKey(ref), row.until, JSON.stringify(row), ttl);
	return { ref, ...row };
}

export async function readModelAttempt(redis, id) {
	const raw = await redis.get(modelAttemptKey(id));
	if (raw === null || raw === undefined) return null;
	let row;
	try { row = JSON.parse(raw); } catch { throw new Error("invalid model attempt"); }
	if (!splitModelEntry(row?.ref) || typeof row.safe !== "boolean" || (row.safe && !providerFailureOf(row.failure))) throw new Error("invalid model attempt");
	return { ref: row.ref, safe: row.safe && providerFailureOf(row.failure) !== null, failure: providerFailureOf(row.failure), ...(MODEL_WHY.includes(row.modelWhy) ? { modelWhy: row.modelWhy } : {}) };
}

export async function writeModelAttempt(redis, id, { ref, safe = false, failure = null, modelWhy = null }) {
	if (!splitModelEntry(ref)) throw new Error("invalid model attempt ref");
	await redis.set(modelAttemptKey(id), JSON.stringify({ ref, safe: safe === true, failure: providerFailureOf(failure), ...(MODEL_WHY.includes(modelWhy) ? { modelWhy } : {}) }));
}

export async function checkFailoverCandidate(job, { models = null, endpoints = [], credential, egress = false, allowlist = [], lookup = builtinModel } = {}) {
	// The second ref makes the existing declared-provider-fallback check enforce this attempt's singleton too.
	const known = checkModelsKnown([{ provider: job.provider, id: job.model, main: true }, { provider: job.provider, id: job.model }], { readOverlay: () => models });
	if (known.unavailable) throw new Error("model catalog unavailable");
	if (known.unknown) return "model-unknown";
	if (known.fallbackUnlisted) return "model-not-allowed";
	const view = failoverModelView(`${job.provider}/${job.model}`, { models, lookup });
	if (!failoverPriceEligible(view)) return "model-unpriced";
	if (credential) {
		const checked = await credential(job, { modelEndpoints: { models, endpoints } });
		if (checked.unavailable) throw new Error("provider credential unavailable");
		if (!checked.ok) return "provider-unconfigured";
	}
	if (egress && egressRefusalFor(view.baseUrl, { allowlist, endpoints }) !== null) return "model-host-unlisted";
	return null;
}

async function modelWindowHasRoom(redis, ref, job, limits, at) {
	if (job.maxCostMicros === 0) return true;
	for (const row of modelDollarRows(limits, [ref])) {
		// reserveDollars remains the atomic authority. This read chooses a candidate without acquiring money;
		// its later reservation may lose a race, which must refuse rather than run with an uncovered window.
		if (!Number.isSafeInteger(job.maxCostMicros)) return false;
		for (const [window, key] of [["day", dayKey(new Date(at), row.keyPrefix)], ["week", weekKey(new Date(at), row.keyPrefix)], ["month", monthKey(new Date(at), row.keyPrefix)]]) {
			const cap = row.caps?.[window];
			if (cap === null || cap === undefined) continue;
			const raw = await redis.get(key);
			const spent = raw === null || raw === undefined ? 0 : Number(raw);
			if (!Number.isSafeInteger(spent) || spent < 0) throw new Error("invalid model window");
			if (spent + job.maxCostMicros > cap) return false;
		}
	}
	return true;
}

/** Only opt-in jobs enter here. Every candidate has a singleton executable policy beneath the reviewed ceiling. */
export async function selectFailoverJob(job, { redis, id, retry = false, recoveryModel = null, retryNeverStarted = false, models = null, limits = [], now = () => Date.now(), checkCandidate, reservationFor = (candidate) => candidate.maxCostMicros, acquireEndpoints = async () => true, modelView = (ref) => failoverModelView(ref, { models }), log = () => {} } = {}) {
	if (!Array.isArray(job.fallbackModels) || modelListProblem(job.fallbackModels) !== null || modelListProblem(job.models) !== null || !Array.isArray(job.models) || !job.fallbackModels.every((ref) => { const s = splitModelEntry(ref); return s && modelOnList(job.models, s.provider, s.model); })) return { refused: "model-failover-no-candidate" };
	const primary = `${job.provider}/${job.model}`;
	const previous = retry ? await readModelAttempt(redis, id) : null;
	if (retry && !previous && !retryNeverStarted && !recoveryModel) return { refused: "model-failover-no-candidate" };
	const locked = recoveryModel ?? (retry && previous?.safe !== true ? previous?.ref ?? primary : null);
	const needsLarger = !locked && previous?.failure?.kind === "context-overflow";
	const largerThan = needsLarger ? modelView(previous.ref)?.contextWindow : null;
	let why = previous?.failure?.kind === "context-overflow" ? "fallback-context" : "fallback-unavailable";
	let wait = null;
	for (const ref of [...new Set(locked ? [locked] : [primary, ...job.fallbackModels])]) {
		const split = splitModelEntry(ref);
		if (!split || !modelOnList(job.models, split.provider, split.model)) { log("model_candidate_skipped", { model: split ? ref : null, reason: "model-not-allowed" }); continue; }
		const candidate = { ...job, provider: split.provider, model: split.model, models: [ref] };
		const bad = await checkCandidate(candidate);
		if (bad) { log("model_candidate_skipped", { model: ref, reason: bad }); continue; }
		if (needsLarger && (!Number.isFinite(largerThan) || !(modelView(ref)?.contextWindow > largerThan))) { log("model_candidate_skipped", { model: ref, reason: "context-too-small" }); continue; }
		if (!locked) {
			const cooldown = await readModelCooldown(redis, ref, { now });
			const failedHere = previous?.safe === true && previous.ref === ref && previous.failure?.kind !== "context-overflow";
			if (cooldown || failedHere) { if (ref === primary) why = "fallback-cooldown"; if (!failedHere) wait ??= "model-cooldown"; log("model_candidate_skipped", { model: ref, reason: failedHere ? "previous-attempt" : "cooldown" }); continue; }
		}
		const reservationJob = { ...candidate, maxCostMicros: reservationFor(candidate) };
		if (modelDollarRows(limits, [ref]).length > 0 && !Number.isSafeInteger(reservationJob.maxCostMicros)) { log("model_candidate_skipped", { model: ref, reason: "model-cost-cap-missing" }); continue; }
		if (!(await modelWindowHasRoom(redis, ref, reservationJob, limits, now()))) { if (ref === primary) why = "fallback-window"; wait ??= "model-window"; log("model_candidate_skipped", { model: ref, reason: "model-window" }); continue; }
		if (!(await acquireEndpoints(candidate))) { wait ??= "endpoint"; log("model_candidate_skipped", { model: ref, reason: "endpoint-busy" }); continue; }
		return { job: { ...candidate, modelWhy: ref === primary ? "primary" : locked ? previous?.modelWhy ?? "fallback-unavailable" : why }, ref };
	}
	return wait ? { wait, until: now() + MODEL_RECHECK_MS } : { refused: "model-failover-no-candidate" };
}
