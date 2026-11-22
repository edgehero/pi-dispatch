import { SUBSCRIPTION_QUOTA_BYTES } from "./subscription-limits.mjs";
import { SUBSCRIPTION_QUOTA_CODES } from "./model-failover-protocol.mjs";
import { MODEL_COOLDOWN_MAX_MS } from "./model-cooldowns.mjs";
/** Subscription evidence is account policy, separate from model cooldowns and dollar reservations. */
import { createHash, randomUUID } from "node:crypto";

// One list with the signed wire's validator, so a code the protocol carries is always a code this store records.
export { SUBSCRIPTION_QUOTA_CODES };
export const SUBSCRIPTION_QUOTA_REASONS = Object.freeze(["subscription-unknown", "subscription-available", "subscription-trial", "subscription-quota", "subscription-extra-usage", "subscription-stale-evidence", "subscription-stale-state", "subscription-stale-binding", "subscription-observation-required"]);
export const SUBSCRIPTION_QUOTA_LIMITS = Object.freeze({ payloadBytes: SUBSCRIPTION_QUOTA_BYTES, windows: 64, limits: 32, freshMs: 300_000, casAttempts: 8, resetFutureMs: 32 * 86_400_000 });
/**
 * How long after an exhaustion that named no reset the connection is tried again with one job (issue #960). Before it,
 * such a block lasted until a person's `auth trial` or a usage read. Equal to the model cooldown's ceiling on purpose:
 * the same refusal cools the model down for exactly that long (model-failover.mjs), so the retest falls due when the
 * model's cooldown ends (the worker records the refusal a moment before it writes the cooldown, index.mjs, so the retest
 * is due at most that moment earlier).
 */
export const SUBSCRIPTION_RETEST_MS = MODEL_COOLDOWN_MAX_MS;
const WINDOWS = ["five-hour", "seven-day", "other"];
const SOURCES = ["claude-community", "openai", "provider-error"];
const hash = value => createHash("sha256").update(value).digest("hex");
const token = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const instant = value => Number.isSafeInteger(value) && value >= 0 && value <= 253_402_300_799_999;
const percent = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000 ? value : null;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const emptyExtra = () => ({ enabled: null, usedPercent: null, usedCredits: null, monthlyLimit: null, currency: null, decimalPlaces: null });
function quotaError(code) { return Object.assign(new Error(code), { code }); }
function boundedObject(raw) {
	try {
		const text = typeof raw === "string" ? raw : JSON.stringify(raw);
		if (typeof text !== "string" || Buffer.byteLength(text) > SUBSCRIPTION_QUOTA_LIMITS.payloadBytes) return null;
		const parsed = JSON.parse(text);
		return object(parsed) ? parsed : null;
	} catch { return null; }
}
function atOf(options) {
	if (!instant(options?.observedAt)) throw quotaError("subscription-invalid-observation");
	return options.observedAt;
}
function reset(value, at, seconds = false) {
	const timestamp = typeof value === "string" ? /^(?:\d{4}-\d\d-\d\dT\d\d:\d\d)(?::\d\d(?:\.(\d{1,9}))?)?(?:Z|[+-]\d\d:\d\d)$/.exec(value) : null;
	const parsed = timestamp ? Date.parse(value) : seconds && Number.isSafeInteger(value) ? value * 1000 : null;
	// Claude supplies microseconds. Date.parse truncates them; round UP so admission never precedes the reset.
	const rounded = timestamp && /[1-9]/.test(timestamp[1]?.slice(3) ?? "") ? parsed + 1 : parsed;
	return instant(rounded) && rounded <= at + SUBSCRIPTION_QUOTA_LIMITS.resetFutureMs ? rounded : null;
}
function row(id, window, scope, usedPercent, resetAt, exhausted = false) {
	return { id, window, scope, usedPercent, resetAt, state: exhausted || usedPercent !== null && usedPercent >= 100 ? "exhausted" : usedPercent === null ? "unknown" : "available" };
}
function strongerRow(old, next) {
	if (old.usedPercent === null || next.usedPercent !== null && next.usedPercent > old.usedPercent) return next;
	if (next.usedPercent !== old.usedPercent) return old;
	return { ...old, resetAt: old.resetAt === null || next.resetAt === null ? null : Math.max(old.resetAt, next.resetAt) };
}
function extraOf(raw) {
	const extra = object(raw) ? raw : {};
	const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
	return { enabled: typeof extra.is_enabled === "boolean" ? extra.is_enabled : null, usedPercent: percent(extra.utilization), usedCredits: number(extra.used_credits), monthlyLimit: number(extra.monthly_limit), currency: typeof extra.currency === "string" && /^[A-Z]{3}$/.test(extra.currency) ? extra.currency : null, decimalPlaces: Number.isInteger(extra.decimal_places) && extra.decimal_places >= 0 && extra.decimal_places <= 4 ? extra.decimal_places : null };
}
function completeOf(windows) {
	return windows.length > 0 && windows.every(value => value.state !== "unknown") && ["five-hour", "seven-day"].every(window => windows.some(value => value.id === window && value.state !== "unknown"));
}
function observation(source, at, windows, extraUsage = emptyExtra()) {
	return { version: 1, source, observedAt: at, complete: completeOf(windows), windows, extraUsage };
}

/** Fixed fields only. Display labels from the community endpoint are not public identity or authority. */
export function normalizeClaudeQuota(raw, options) {
	const at = atOf(options), parsed = boundedObject(raw);
	const base = new Map(["five-hour", "seven-day"].map(window => [window, row(window, window, "account", null, null)]));
	const scoped = [];
	if (!parsed || parsed.limits !== undefined && parsed.limits !== null && (!Array.isArray(parsed.limits) || parsed.limits.length > SUBSCRIPTION_QUOTA_LIMITS.limits)) return observation("claude-community", at, [...base.values()]);
	for (const [key, window] of [["five_hour", "five-hour"], ["seven_day", "seven-day"]]) {
		const value = parsed[key];
		if (object(value)) base.set(window, row(window, window, "account", percent(value.utilization), reset(value.resets_at, at)));
	}
	for (const value of parsed.limits ?? []) {
		if (!object(value)) continue;
		const window = value.kind === "session" ? "five-hour" : value.group === "weekly" || typeof value.kind === "string" && value.kind.startsWith("weekly") ? "seven-day" : "other";
		// Unknown model/surface names do not imply a physical model mapping. Their identity is opaque;
		// without a reviewed mapping, an exhausted scoped limit conservatively blocks this application bucket.
		const scope = object(value.scope) && (object(value.scope.model) || value.scope.surface !== undefined) || value.kind === "weekly_scoped" ? "scoped" : "account";
		const id = scope === "account" && window !== "other" ? window : `${window}:${hash(JSON.stringify([value.kind ?? null, value.group ?? null, value.scope ?? null]))}`;
		const next = row(id, window, scope, percent(value.percent ?? value.utilization), reset(value.resets_at, at));
		if (scope === "account" && window !== "other") {
			const old = base.get(window);
			base.set(window, strongerRow(old, next));
		} else if (!scoped.some(entry => entry.id === id)) scoped.push(next);
	}
	for (const [key, value] of Object.entries(parsed)) {
		if (!(key === "iguana_necktie" || /^seven_day_[a-z0-9_]{1,64}$/.test(key)) || !object(value)) continue;
		const id = `seven-day:${hash(key)}`;
		if (scoped.length >= SUBSCRIPTION_QUOTA_LIMITS.windows - 2) return observation("claude-community", at, [...base.values()]);
		scoped.push(row(id, "seven-day", "scoped", percent(value.utilization), reset(value.resets_at, at)));
	}
	return observation("claude-community", at, [...base.values(), ...scoped], extraOf(parsed.extra_usage));
}

/** OpenAI App Server's typed rate-limit fields, without interpreting diagnostic prose. */
export function normalizeOpenAIQuota(raw, options) {
	const at = atOf(options), parsed = boundedObject(raw);
	const limits = object(parsed?.rateLimits) ? parsed.rateLimits : parsed;
	const rows = new Map(["five-hour", "seven-day"].map(window => [window, row(window, window, "account", null, null)]));
	for (const [key, value] of Object.entries(limits ?? {})) {
		if (!["primary", "secondary"].includes(key) || !object(value)) continue;
		const window = value.windowDurationMins === 300 ? "five-hour" : value.windowDurationMins === 10_080 ? "seven-day" : "other";
		const id = window === "other" ? `other:${key}` : window;
		const next = row(id, window, "account", percent(value.usedPercent), reset(value.resetsAt, at, true));
		rows.set(id, rows.has(id) ? strongerRow(rows.get(id), next) : next);
	}
	return observation("openai", at, [...rows.values()]);
}

/** Only a verified transport's closed code/status may establish quota exhaustion. */
export function normalizeSubscriptionQuotaError(value, options) {
	const at = atOf(options);
	if (!object(value) || !["anthropic", "openai", "openai-codex"].includes(value.provider) || !SUBSCRIPTION_QUOTA_CODES.includes(value.code) || value.status === 401 || value.status === 403 || value.status !== undefined && value.status !== 429) return null;
	const window = WINDOWS.includes(value.window) ? value.window : "other";
	const resetAt = instant(value.resetAt) && value.resetAt <= at + SUBSCRIPTION_QUOTA_LIMITS.resetFutureMs ? value.resetAt : null;
	const result = observation("provider-error", at, [row(window === "other" ? "provider-error" : window, window, "account", null, resetAt, true)]);
	return { ...result, complete: false, code: value.code };
}

function identityOf(value) {
	if (!object(value) || !token(value.connectionId) || !token(value.owner) || !token(value.bucket) || typeof value.accountDigest !== "string" || !/^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(value.accountDigest) || !Number.isSafeInteger(value.generation) || value.generation < 1) throw quotaError("subscription-invalid-binding");
	return { connectionId: value.connectionId, owner: value.owner, accountDigest: value.accountDigest, bucket: value.bucket, generation: value.generation };
}
export function subscriptionQuotaKey(value) {
	const identity = identityOf(value);
	return `dispatch:subscription-quota:${hash(JSON.stringify([identity.connectionId, identity.accountDigest, identity.bucket]))}`;
}
function cleanObservation(value) {
	const parsed = boundedObject(value);
	if (!parsed || parsed.version !== 1 || !SOURCES.includes(parsed.source) || !instant(parsed.observedAt) || !Array.isArray(parsed.windows) || parsed.windows.length > SUBSCRIPTION_QUOTA_LIMITS.windows || typeof parsed.complete !== "boolean") throw quotaError("subscription-invalid-observation");
	const ids = new Set();
	const windows = parsed.windows.map(value => {
		if (!object(value) || !token(value.id) || ids.has(value.id) || !WINDOWS.includes(value.window) || !["account", "scoped"].includes(value.scope) || value.usedPercent !== null && percent(value.usedPercent) === null || value.resetAt !== null && (!instant(value.resetAt) || value.resetAt > parsed.observedAt + SUBSCRIPTION_QUOTA_LIMITS.resetFutureMs) || !["unknown", "available", "exhausted"].includes(value.state)) throw quotaError("subscription-invalid-observation");
		ids.add(value.id);
		if (value.state === "available" && (value.usedPercent === null || value.usedPercent >= 100) || value.state === "unknown" && value.usedPercent !== null || value.state === "exhausted" && value.usedPercent !== null && value.usedPercent < 100) throw quotaError("subscription-invalid-observation");
		return row(value.id, value.window, value.scope, value.usedPercent, value.resetAt, value.state === "exhausted");
	});
	const extra = parsed.extraUsage;
	if (!object(extra)) throw quotaError("subscription-invalid-observation");
	const normalized = observation(parsed.source, parsed.observedAt, windows, extraOf({ is_enabled: extra.enabled, utilization: extra.usedPercent, used_credits: extra.usedCredits, monthly_limit: extra.monthlyLimit, currency: extra.currency, decimal_places: extra.decimalPlaces }));
	if (parsed.complete !== normalized.complete) throw quotaError("subscription-invalid-observation");
	return { ...normalized, ...(parsed.source === "provider-error" && SUBSCRIPTION_QUOTA_CODES.includes(parsed.code) ? { code: parsed.code } : {}) };
}
/**
 * A stored trial: a person's grant `{ id, usedBy }` (usedBy null until a pickup claims it), or, since issue #960, an
 * automatic retest `{ id, usedBy, auto: true, claimedAt }`. A claim by this build stamps `claimedAt` on a person's trial
 * too; a used trial without it was claimed by an older build and reads as a person's, whose claim time is not known.
 */
function trialOf(value) {
	if (value === null) return null;
	if (!object(value) || !/^[a-f0-9-]{36}$/.test(value.id) || value.usedBy !== null && !/^[a-f0-9]{64}$/.test(value.usedBy)) throw new Error();
	if (value.auto !== undefined && value.auto !== true || value.claimedAt !== undefined && (!instant(value.claimedAt) || value.usedBy === null) || value.auto === true && value.claimedAt === undefined) throw new Error();
	return { id: value.id, usedBy: value.usedBy, ...(value.auto === true ? { auto: true } : {}), ...(value.claimedAt !== undefined ? { claimedAt: value.claimedAt } : {}) };
}
/**
 * When an exhaustion with no reset admits its one retest (issue #960), or null when it never does on its own. Only rows
 * a provider's refusal wrote (`provider-error`, the id normalizeSubscriptionQuotaError gives a row with no window) and
 * none with a reset: a usage read's exhausted row, Claude's included, keeps blocking until its reset or a newer read. Not
 * while a person's trial waits unused (that trial admits the next pickup itself), nor while a probe is required. Six
 * hours after the newest such refusal or the last trial's claim, whichever is later, so a retest that failed for another
 * cause is tried again six hours on, and one that met the limit again re-latches through `record`.
 */
function retestAtOf(state, blocked) {
	if (state.probeRequired || blocked.length === 0 || !blocked.every(row => row.id === "provider-error" && row.resetAt === null)) return null;
	if (state.trial !== null && state.trial.usedBy === null) return null;
	return Math.max(...blocked.map(row => row.observedAt), state.trial?.claimedAt ?? 0) + SUBSCRIPTION_RETEST_MS;
}
function trialClaimant(attemptId) {
	if (typeof attemptId !== "string" || attemptId.length === 0 || attemptId.length > 256) throw quotaError("subscription-invalid-trial");
	return hash(attemptId);
}
/** Why a settlement of the trial `usedBy` names may not touch it, or null: the guards the clear and the release share. */
function heldTrialRefusal(state, status, usedBy) {
	const trial = state.trial;
	if (trial === null || trial.usedBy !== usedBy || trial.claimedAt === undefined || state.probeRequired) return { ok: false, reason: "subscription-stale-state", status };
	if (state.windows.some(row => row.id === "provider-error" && row.resetAt === null && row.observedAt > trial.claimedAt)) return { ok: false, reason: "subscription-stale-evidence", status };
	return null;
}
function emptyState(identity) { return { version: 0, identity, source: null, observedAt: null, windows: [], extraUsage: emptyExtra(), trial: null, probeRequired: false, invalidatedAt: null }; }
function parseState(raw, identity) {
	if (raw === null || raw === undefined) return emptyState(identity);
	const value = boundedObject(raw);
	if (!value || !Number.isSafeInteger(value.version) || value.version < 1 || !instant(value.observedAt) || !Array.isArray(value.windows) || value.windows.length > SUBSCRIPTION_QUOTA_LIMITS.windows || !SOURCES.includes(value.source)) throw quotaError("subscription-store-invalid");
	try {
		const bound = identityOf(value.identity);
		if (subscriptionQuotaKey(bound) !== subscriptionQuotaKey(identity)) throw new Error();
		const clean = cleanObservation({ version: 1, source: value.source, observedAt: value.observedAt, complete: completeOf(value.windows), windows: value.windows, extraUsage: value.extraUsage });
		// Stored rows retain their individual observation times when a later partial read omits them.
		const windows = clean.windows.map((row, index) => {
			if (!instant(value.windows[index].observedAt) || value.windows[index].observedAt > value.observedAt) throw new Error();
			return { ...row, observedAt: value.windows[index].observedAt };
		});
		const trial = trialOf(value.trial);
		if (value.probeRequired !== undefined && typeof value.probeRequired !== "boolean" || value.probeRequired === true && !instant(value.invalidatedAt)) throw new Error();
		return { version: value.version, identity: bound, source: value.source, observedAt: value.observedAt, windows, extraUsage: clean.extraUsage, trial, probeRequired: value.probeRequired === true, invalidatedAt: value.probeRequired === true ? value.invalidatedAt : null };
	} catch { throw quotaError("subscription-store-invalid"); }
}
function bindingValid(state, identity) { return identity.generation > state.identity.generation || identity.generation === state.identity.generation && identity.owner === state.identity.owner; }
function statusOf(state, identity, at) {
	const windows = state.windows.map(value => ({ ...value, fresh: !state.probeRequired && at - value.observedAt <= SUBSCRIPTION_QUOTA_LIMITS.freshMs && value.observedAt <= at, state: value.state === "exhausted" && (value.resetAt === null || value.resetAt > at) ? "exhausted" : !state.probeRequired && value.state === "available" && value.observedAt <= at && at - value.observedAt <= SUBSCRIPTION_QUOTA_LIMITS.freshMs && (value.resetAt === null || value.resetAt > at) ? "available" : "unknown" }));
	const blocked = windows.filter(value => value.state === "exhausted");
	return { connectionId: identity.connectionId, accountDigest: identity.accountDigest, bucket: identity.bucket, generation: state.identity.generation, version: state.version, observedAt: state.observedAt, source: state.source, fresh: !state.probeRequired && state.observedAt !== null && at - state.observedAt <= SUBSCRIPTION_QUOTA_LIMITS.freshMs, bindingValid: bindingValid(state, identity), state: blocked.length ? "exhausted" : windows.length && windows.every(value => value.state === "available") ? "available" : "unknown", until: blocked.length && blocked.every(value => value.resetAt !== null) ? Math.max(...blocked.map(value => value.resetAt)) : null, blockedUnknownReset: blocked.some(value => value.resetAt === null), trialAvailable: state.trial !== null && state.trial.usedBy === null, trialClaimedAt: state.trial?.claimedAt ?? null, retestAt: retestAtOf(state, blocked), probeRequired: state.probeRequired, invalidatedAt: state.invalidatedAt, windows, extraUsage: state.probeRequired ? emptyExtra() : state.extraUsage };
}
// Reviewed provider evidence: Fable has a separate weekly allowance; other models remain usable.
// https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan
// Only the measured, closed Fable scope and exact Opus 5.5 route are mapped. Preserve the existing
// opaque IDs (including JSON key order), so previously stored exhaustion needs no rewrite. Unknown
// labels, model IDs, surfaces, routes and extra scope fields still block conservatively.
const FABLE_WEEKLY_IDS = new Set([
	{ id: null, display_name: "Fable" }, { display_name: "Fable", id: null },
].flatMap(model => [{ model, surface: null }, { surface: null, model }])
	.map(scope => `seven-day:${hash(JSON.stringify(["weekly_scoped", "weekly", scope]))}`));
function statusForModel(status, modelRef) {
	if (modelRef !== "anthropic/claude-opus-5-5" || status.bucket !== "anthropic:subscription") return status;
	const windows = status.windows.filter(row => !(row.window === "seven-day" && row.scope === "scoped" && FABLE_WEEKLY_IDS.has(row.id)));
	const blocked = windows.filter(row => row.state === "exhausted");
	return { ...status, windows, state: blocked.length ? "exhausted" : windows.length && windows.every(row => row.state === "available") ? "available" : "unknown", until: blocked.length && blocked.every(row => row.resetAt !== null) ? Math.max(...blocked.map(row => row.resetAt)) : null, blockedUnknownReset: blocked.some(row => row.resetAt === null) };
}
const CAS = `local old = redis.call('GET', KEYS[1]); if (old or '') ~= ARGV[1] then return 0 end; redis.call('SET', KEYS[1], ARGV[2]); return 1`;

/** Bounded GET/CAS only. Exhaustion without a reset has no TTL and cannot disappear through expiry. */
export function makeSubscriptionQuotaStore({ redis, now = Date.now } = {}) {
	if (typeof redis?.get !== "function" || typeof redis?.eval !== "function") throw quotaError("subscription-store-unavailable");
	const readRaw = async identity => {
		const raw = await redis.get(subscriptionQuotaKey(identity));
		if (raw !== null && raw !== undefined && (typeof raw !== "string" || Buffer.byteLength(raw) > SUBSCRIPTION_QUOTA_LIMITS.payloadBytes)) throw quotaError("subscription-store-invalid");
		return { raw: raw ?? "", state: parseState(raw, identity) };
	};
	async function mutate(value, fn, { bind = false } = {}) {
		const identity = identityOf(value);
		for (let attempt = 0; attempt < SUBSCRIPTION_QUOTA_LIMITS.casAttempts; attempt++) {
			const { raw, state } = await readRaw(identity), at = now();
			if (!instant(at)) throw quotaError("subscription-invalid-clock");
			const status = statusOf(state, identity, at);
			if (!status.bindingValid) return { ok: false, reason: "subscription-stale-binding", status };
			let result = fn(state, status, at);
			// A selected prepare publishes the newer owner/generation even when quota refuses it. Merely
			// considering a fallback must remain read-only and cannot claim a binding or a person's trial.
			if (bind && state.version > 0 && identity.generation > state.identity.generation && !result.next) result = { ...result, next: state };
			if (!result.next) return result;
			const next = { ...result.next, version: state.version + 1, identity };
			const serialized = JSON.stringify(next);
			if (Buffer.byteLength(serialized) > SUBSCRIPTION_QUOTA_LIMITS.payloadBytes) throw quotaError("subscription-store-capacity");
			if (await redis.eval(CAS, 1, subscriptionQuotaKey(identity), raw, serialized) === 1) {
				const { next: _next, ...returned } = result;
				return { ...returned, status: statusOf(next, identity, at) };
			}
		}
		throw quotaError("subscription-store-conflict");
	}
	return {
		async read(value) { const identity = identityOf(value); return statusOf((await readRaw(identity)).state, identity, now()); },
		async invalidate(value, { observedAt } = {}) {
			if (!instant(observedAt)) throw quotaError("subscription-invalid-observation");
			return mutate(value, (state, status, at) => {
				if (observedAt > at || state.observedAt !== null && observedAt < state.observedAt || state.invalidatedAt !== null && observedAt < state.invalidatedAt) return { ok: false, reason: "subscription-stale-evidence", status };
				return { ok: true, next: { ...state, source: state.source ?? "provider-error", observedAt: state.observedAt ?? observedAt, probeRequired: true, invalidatedAt: observedAt } };
			});
		},
		async record(value, evidence, { expectedVersion } = {}) {
			const incoming = cleanObservation(evidence);
			return mutate(value, (state, status, at) => {
				if (expectedVersion !== undefined && expectedVersion !== state.version) return { ok: false, reason: "subscription-stale-state", status };
				const clearsProbe = state.probeRequired && incoming.source !== "provider-error" && expectedVersion === state.version && incoming.observedAt >= state.invalidatedAt;
				if (state.probeRequired && incoming.source !== "provider-error" && !clearsProbe) return { ok: false, reason: "subscription-stale-state", status };
				if (incoming.observedAt > at || state.observedAt !== null && incoming.observedAt < state.observedAt) return { ok: false, reason: "subscription-stale-evidence", status };
				const tied = incoming.observedAt === state.observedAt;
				if (tied && !clearsProbe && !incoming.windows.some(row => {
					const old = state.windows.find(value => value.id === row.id);
					return row.state === "exhausted" && (old?.state !== "exhausted" || old.resetAt !== null && (row.resetAt === null || row.resetAt > old.resetAt));
				})) return { ok: false, reason: "subscription-stale-evidence", status };
				const rows = new Map(state.windows.map(row => [row.id, row]));
				if (incoming.complete && (!tied || clearsProbe)) rows.delete("provider-error");
				for (const row of incoming.windows) {
					const old = rows.get(row.id);
					if (tied && !clearsProbe && row.state !== "exhausted") continue;
					if (tied && !clearsProbe && old?.state === "exhausted") {
						rows.set(row.id, { ...row, resetAt: old.resetAt === null || row.resetAt === null ? null : Math.max(old.resetAt, row.resetAt), observedAt: incoming.observedAt });
						continue;
					}
					if (row.state === "unknown" && old?.state === "exhausted") continue;
					rows.set(row.id, { ...row, observedAt: incoming.observedAt });
				}
				if (rows.size > SUBSCRIPTION_QUOTA_LIMITS.windows) throw quotaError("subscription-store-capacity");
				return { ok: true, next: { ...state, source: incoming.source, observedAt: incoming.observedAt, windows: [...rows.values()], extraUsage: incoming.source === "provider-error" ? state.extraUsage : incoming.extraUsage, trial: null, ...(clearsProbe ? { probeRequired: false, invalidatedAt: null } : {}) } };
			});
		},
		async admit(value, { modelRef = null, windows = ["five-hour", "seven-day"], attemptId, consumeTrial = true, allowExtraUsage = false, maxCreditMicros = null, requireExtraUsageKnownDisabled = false } = {}) {
			if (!Array.isArray(windows) || windows.some(value => !["five-hour", "seven-day"].includes(value)) || new Set(windows).size !== windows.length || allowExtraUsage && (!Number.isSafeInteger(maxCreditMicros) || maxCreditMicros <= 0)) throw quotaError("subscription-invalid-policy");
			const result = await mutate(value, (state, fullStatus, at) => {
				const status = statusForModel(fullStatus, modelRef);
				if (state.probeRequired) {
					if (status.state === "exhausted") return { ok: false, reason: "subscription-quota", until: status.until, status };
					return { ok: consumeTrial === false, reason: "subscription-observation-required", requiresUsage: true, status };
				}
				if (requireExtraUsageKnownDisabled && status.extraUsage.enabled !== false && !allowExtraUsage) return { ok: false, reason: "subscription-extra-usage", until: null, status };
				// Monitoring preferences do not authorize spending against any observed exhausted bucket.
				const blocked = status.windows.filter(row => row.state === "exhausted");
				if (blocked.length === 0) return { ok: true, reason: status.state === "unknown" ? "subscription-unknown" : "subscription-available", ...(allowExtraUsage ? { creditCapMicros: maxCreditMicros } : {}), status };
				if (allowExtraUsage && status.extraUsage.enabled === true) return { ok: true, reason: "subscription-available", creditCapMicros: maxCreditMicros, status };
				const claimant = () => trialClaimant(attemptId);
				if (blocked.every(row => row.resetAt === null) && state.trial !== null) {
					// A preview claims nothing. A trial another attempt already holds refuses it below, like any block,
					// rather than asking a preview, which names no attempt, for one.
					if (consumeTrial === false) {
						if (state.trial.usedBy === null) return { ok: true, reason: "subscription-trial", status };
					} else {
						const usedBy = claimant();
						if (state.trial.usedBy === usedBy) return { ok: true, reason: "subscription-trial", status };
						// The claim time lets a clean run of this trial clear the block (clearTrialEvidence).
						if (state.trial.usedBy === null) return { ok: true, reason: "subscription-trial", next: { ...state, trial: { ...state.trial, usedBy, claimedAt: at } } };
					}
				}
				// Issue #960: an exhaustion that named no reset is tried again by ONE attempt once SUBSCRIPTION_RETEST_MS has
				// passed. The claim is this compare-and-set, so of two hosts reading the same state one writes and the other
				// reads the claim on its retry and is refused; until the trial records again or clears, it holds.
				// The connection's retest, the one `auth status` and the console show (provider refusals are connection-wide).
				if (fullStatus.retestAt !== null && at >= fullStatus.retestAt) {
					if (consumeTrial === false) return { ok: true, reason: "subscription-trial", status };
					return { ok: true, reason: "subscription-trial", next: { ...state, trial: { id: randomUUID(), usedBy: claimant(), auto: true, claimedAt: at } } };
				}
				return { ok: false, reason: "subscription-quota", until: blocked.every(row => row.resetAt !== null) ? Math.max(...blocked.map(row => row.resetAt)) : null, status };
			}, { bind: consumeTrial !== false });
			// A selected admission may publish a newer binding through CAS, which returns the full connection view.
			return result.status ? { ...result, status: statusForModel(result.status, modelRef) } : result;
		},
		/**
		 * A trial whose run reached the provider and was answered clears the refusals it was trying (issue #960): without
		 * this, a connection whose limit reset would run one job per SUBSCRIPTION_RETEST_MS. Only the attempt holding the
		 * trial (`attemptId`, hashed as admit hashed it), only `provider-error` rows with no reset (a usage read's rows,
		 * Claude's, stay), and only when none is newer than the trial's claim: a refusal recorded after the claim drops
		 * the trial (`record`), so its rows are never cleared by an older answer. A used trial with no claim time (claimed
		 * by an older build) clears nothing, since nothing says its rows predate the run; the next retest or a person's
		 * trial settles it. Probe-required state is left alone, and `observedAt` must lie between the claim and now.
		 */
		async clearTrialEvidence(value, { attemptId, observedAt } = {}) {
			if (!instant(observedAt)) throw quotaError("subscription-invalid-observation");
			const usedBy = trialClaimant(attemptId);
			return mutate(value, (state, status, at) => {
				const refused = heldTrialRefusal(state, status, usedBy);
				if (refused) return refused;
				if (observedAt > at || observedAt < state.trial.claimedAt) return { ok: false, reason: "subscription-stale-state", status };
				const rows = state.windows.filter(row => row.id === "provider-error" && row.resetAt === null);
				return { ok: true, next: { ...state, windows: state.windows.filter(row => !rows.includes(row)), trial: null } };
			});
		},
		/**
		 * A trial whose run never reached the provider gives the trial back (issue #960): the run proved nothing about the
		 * limit, so it must not hold the connection shut for another SUBSCRIPTION_RETEST_MS. Under the same guards as the
		 * clear. An automatic trial is dropped, so the retest is due again at once (`retestAtOf` then reads only the
		 * refusals); a person's trial is unused again, so the next pickup takes it, as the person authorized.
		 */
		async releaseTrial(value, { attemptId } = {}) {
			const usedBy = trialClaimant(attemptId);
			return mutate(value, (state, status) => {
				const refused = heldTrialRefusal(state, status, usedBy);
				if (refused) return refused;
				return { ok: true, next: { ...state, trial: state.trial.auto === true ? null : { id: state.trial.id, usedBy: null } } };
			});
		},
		async grantOneTrial(value, { expectedVersion, actorKind } = {}) {
			if (actorKind !== "person" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw quotaError("subscription-trial-person-required");
			return mutate(value, (state, status) => {
				if (state.version !== expectedVersion) return { ok: false, reason: "subscription-stale-state", status };
				if (!status.blockedUnknownReset || status.windows.some(row => row.state === "exhausted" && row.resetAt !== null) || status.trialAvailable) return { ok: false, reason: "subscription-stale-state", status };
				return { ok: true, next: { ...state, trial: { id: randomUUID(), usedBy: null } } };
			});
		},
	};
}
