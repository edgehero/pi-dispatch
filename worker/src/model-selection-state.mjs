/** Worker-owned random choice. The queue payload carries intent, never execution or replay authority. */
import { createHash } from "node:crypto";
import { modelSelectionProblem, splitModelEntry } from "./model-ref.mjs";
import { modelSelectionGenerationValid } from "./model-selection-generation.mjs";
import { MODEL_ATTEMPT_FINISHED_TTL_MS } from "./retention.mjs";
import { dropKey } from "./model-attempts.mjs";

export const MODEL_SELECTION_STATE_VERSION = 1;
export const MODEL_SELECTION_KEY_PREFIX = "dispatch:model-selection:v1:";
const digest = (value) => createHash("sha256").update(value).digest("hex");
export const modelSelectionKey = (id) => `${MODEL_SELECTION_KEY_PREFIX}${digest(id)}`;
export const modelSelectionPolicyDigest = (candidates) => digest(JSON.stringify([...candidates].sort()));
const rawState = Symbol("stored model selection");
const phases = ["selected", "execution-possible", "quota-reselectable", "finished"];
const fields = new Set(["version", "identityDigest", "policyDigest", "candidates", "ref", "modelWhy", "previous", "revision", "attempt", "phase", "phaseBeforeFinish", "selectedAt", "billing", "binding"]);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

/** Timestamp distinguishes scheduler occurrences; generation distinguishes a new enqueue reusing an id at that instant. */
export function identityForModelSelection(job, { queueName = null } = {}) {
	const queue = job?.queueName ?? queueName;
	if (!modelSelectionGenerationValid(job?.data?.modelSelectionGeneration) || typeof queue !== "string" || !queue || typeof job?.id !== "string" || !job.id || !Number.isSafeInteger(job.timestamp) || job.timestamp < 0) return null;
	return JSON.stringify([queue, job.id, job.data.modelSelectionGeneration, job.timestamp]);
}

function validState(row, id) {
	return row && typeof row === "object" && !Array.isArray(row) && Object.keys(row).every((key) => fields.has(key))
		&& row.version === MODEL_SELECTION_STATE_VERSION && row.identityDigest === digest(id)
		&& modelSelectionProblem({ strategy: "random", candidates: row.candidates }) === null
		&& row.policyDigest === modelSelectionPolicyDigest(row.candidates) && row.candidates.includes(row.ref)
		&& ["random", "random-subscription-limit"].includes(row.modelWhy)
		&& [null, "api", "subscription"].includes(row.billing) && (row.billing === "subscription" ? typeof row.binding === "string" && /^[a-f0-9]{64}$/.test(row.binding) : row.binding === null)
		&& (row.previous === undefined || !!splitModelEntry(row.previous)) && positive(row.revision) && positive(row.attempt)
		&& phases.includes(row.phase) && (row.phase === "finished" ? phases.slice(0, 3).includes(row.phaseBeforeFinish) : row.phaseBeforeFinish === undefined)
		&& Number.isSafeInteger(row.selectedAt) && row.selectedAt >= 0;
}

function token(row, raw = JSON.stringify(row)) {
	return Object.defineProperty(row, rawState, { value: raw });
}

export async function readModelSelection(redis, id) {
	if (typeof id !== "string" || !id) return { invalid: true };
	const raw = await redis.get(modelSelectionKey(id));
	if (raw === null || raw === undefined) return null;
	let row;
	try { row = JSON.parse(raw); } catch { return { invalid: true }; }
	if (Number.isSafeInteger(row?.version) && row.version > MODEL_SELECTION_STATE_VERSION) return { newer: true };
	return validState(row, id) ? token(row, raw) : { invalid: true };
}

// Compare the complete stored bytes, not just revision: no stale owner can rewrite or expire a newer choice.
const CAS = `local old = redis.call('GET', KEYS[1]); if ARGV[1] == '' then if old then return 0 end elseif old ~= ARGV[1] then return 0 end; redis.call('SET', KEYS[1], ARGV[2]); if tonumber(ARGV[3]) > 0 then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end; return 1`;
async function replace(redis, id, expected, next, ttl = 0) {
	if (!validState(next, id) || expected && !expected[rawState]) return { ok: false };
	const raw = JSON.stringify(next);
	const changed = await redis.eval(CAS, 1, modelSelectionKey(id), expected?.[rawState] ?? "", raw, ttl);
	return Number(changed) === 1 ? { ok: true, state: token(next, raw) } : { ok: false, conflict: true };
}

export async function commitModelSelection(redis, id, { expected = null, ref, candidates, modelWhy = "random", previous = null, attempt = 1, billing = null, binding = null, now = Date.now } = {}) {
	if (typeof id !== "string" || !id || expected && expected.phase !== "quota-reselectable") return { ok: false };
	return replace(redis, id, expected, { version: MODEL_SELECTION_STATE_VERSION, identityDigest: digest(id), policyDigest: modelSelectionPolicyDigest(candidates), candidates: [...candidates], ref, modelWhy, ...(previous ? { previous } : {}), revision: (expected?.revision ?? 0) + 1, attempt, phase: "selected", selectedAt: now(), billing, binding });
}

export async function armModelSelection(redis, id, state, { attempt = state?.attempt } = {}) {
	if (!state || !["selected", "execution-possible"].includes(state.phase) || !positive(attempt) || attempt < state.attempt) return { ok: false };
	return replace(redis, id, state, { ...state, revision: state.revision + 1, attempt, phase: "execution-possible" });
}

/** A queue retry claims its attempt without changing the physical choice or replay permission. */
export async function reuseModelSelection(redis, id, state, { attempt = state?.attempt, locked = false } = {}) {
	if (!state?.[rawState] || !positive(attempt) || attempt < state.attempt) return { ok: false };
	const prior = state.phase === "finished" ? state.phaseBeforeFinish : state.phase;
	const phase = locked && prior === "quota-reselectable" ? "selected" : prior;
	if (attempt === state.attempt && phase === state.phase) return { ok: true, state };
	const next = { ...state, revision: state.revision + 1, attempt, phase };
	delete next.phaseBeforeFinish;
	return replace(redis, id, state, next);
}

/**
 * Signed terminal proof AND a successfully persisted authoritative quota observation are required after spawn.
 *
 * Issue #968: only a subscription choice has an allowance to run out, so a choice committed as "api" (a random pool may
 * draw an API-key candidate beside subscription ones) is never made reselectable, whatever proof arrives. Every caller
 * already asks only on a subscription's quota, so this holds the rule where the state lives: an API draw keeps its class
 * and its candidate for the whole run.
 */
export async function allowModelSelectionQuotaReselection(redis, id, state, { beforeStart = false, result = null, quotaConfirmed = false } = {}) {
	if (!state || quotaConfirmed !== true || state.billing === "api") return { ok: false };
	const terminal = result?.code === 1 && result.exitLineCode === result.code && result.exitAuth === "verified" && result.aborted !== true && result.lingering !== true && result.toolsStarted === false && result.replaySafe === true && ["quota-exhausted", "rate-limited"].includes(result.providerFailure?.kind) && result.providerFailure?.subscriptionProvider === splitModelEntry(state.ref)?.provider;
	if (!(beforeStart === true && state.phase === "selected") && !(beforeStart !== true && state.phase === "execution-possible" && terminal)) return { ok: false };
	return replace(redis, id, state, { ...state, revision: state.revision + 1, phase: "quota-reselectable" });
}

/** Only the host boundary can prove that an armed attempt did not start a container. */
export async function markModelSelectionNeverStarted(redis, id, state, { proven = false } = {}) {
	if (proven !== true || state?.phase !== "execution-possible") return { ok: false };
	return replace(redis, id, state, { ...state, revision: state.revision + 1, phase: "selected" });
}

export async function finishModelSelection(redis, id, { attempt, expectedRevision = null } = {}) {
	const state = await readModelSelection(redis, id);
	if (!state?.[rawState] || !positive(attempt) || state.attempt !== attempt || expectedRevision !== null && state.revision !== expectedRevision) return false;
	const finished = state.phase === "finished" ? state : { ...state, revision: state.revision + 1, phase: "finished", phaseBeforeFinish: state.phase };
	return (await replace(redis, id, state, finished, MODEL_ATTEMPT_FINISHED_TTL_MS)).ok;
}

export async function keepModelSelection(redis, id) {
	const state = await readModelSelection(redis, id);
	if (!state?.[rawState]) return false;
	// A worker may already have picked up a console retry. Active states already have no TTL; changing their
	// revision here would invalidate the worker's spawn token after the console had released the queue job.
	if (state.phase !== "finished") return true;
	const next = { ...state, revision: state.revision + 1, phase: state.phase === "finished" ? state.phaseBeforeFinish : state.phase };
	delete next.phaseBeforeFinish;
	return (await replace(redis, id, state, next)).ok;
}

export function dropModelSelection(redis, id, timeoutMs = 2_000) {
	if (typeof id !== "string" || !id) return;
	return dropKey(redis, modelSelectionKey(id), timeoutMs);
}
