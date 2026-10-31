import { SUBSCRIPTION_QUOTA_BYTES } from "./subscription-limits.mjs";
/** Subscription evidence is account policy, separate from model cooldowns and dollar reservations. */
import { createHash, randomUUID } from "node:crypto";

export const SUBSCRIPTION_QUOTA_CODES = Object.freeze(["usage_limit_reached", "usage_not_included", "rate_limit_exceeded", "quota_exhausted"]);
export const SUBSCRIPTION_QUOTA_REASONS = Object.freeze(["subscription-unknown", "subscription-available", "subscription-trial", "subscription-quota", "subscription-extra-usage", "subscription-stale-evidence", "subscription-stale-state", "subscription-stale-binding", "subscription-observation-required"]);
export const SUBSCRIPTION_QUOTA_LIMITS = Object.freeze({ payloadBytes: SUBSCRIPTION_QUOTA_BYTES, windows: 64, limits: 32, freshMs: 300_000, casAttempts: 8, resetFutureMs: 32 * 86_400_000 });
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
	const parsed = typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : seconds && Number.isSafeInteger(value) ? value * 1000 : null;
	return instant(parsed) && parsed <= at + SUBSCRIPTION_QUOTA_LIMITS.resetFutureMs ? parsed : null;
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
		if (value.trial !== null && (!object(value.trial) || !/^[a-f0-9-]{36}$/.test(value.trial.id) || value.trial.usedBy !== null && !/^[a-f0-9]{64}$/.test(value.trial.usedBy))) throw new Error();
		if (value.probeRequired !== undefined && typeof value.probeRequired !== "boolean" || value.probeRequired === true && !instant(value.invalidatedAt)) throw new Error();
		return { version: value.version, identity: bound, source: value.source, observedAt: value.observedAt, windows, extraUsage: clean.extraUsage, trial: value.trial === null ? null : { id: value.trial.id, usedBy: value.trial.usedBy }, probeRequired: value.probeRequired === true, invalidatedAt: value.probeRequired === true ? value.invalidatedAt : null };
	} catch { throw quotaError("subscription-store-invalid"); }
}
function bindingValid(state, identity) { return identity.generation > state.identity.generation || identity.generation === state.identity.generation && identity.owner === state.identity.owner; }
function statusOf(state, identity, at) {
	const windows = state.windows.map(value => ({ ...value, fresh: !state.probeRequired && at - value.observedAt <= SUBSCRIPTION_QUOTA_LIMITS.freshMs && value.observedAt <= at, state: value.state === "exhausted" && (value.resetAt === null || value.resetAt > at) ? "exhausted" : !state.probeRequired && value.state === "available" && value.observedAt <= at && at - value.observedAt <= SUBSCRIPTION_QUOTA_LIMITS.freshMs && (value.resetAt === null || value.resetAt > at) ? "available" : "unknown" }));
	const blocked = windows.filter(value => value.state === "exhausted");
	return { connectionId: identity.connectionId, accountDigest: identity.accountDigest, bucket: identity.bucket, generation: state.identity.generation, version: state.version, observedAt: state.observedAt, source: state.source, fresh: !state.probeRequired && state.observedAt !== null && at - state.observedAt <= SUBSCRIPTION_QUOTA_LIMITS.freshMs, bindingValid: bindingValid(state, identity), state: blocked.length ? "exhausted" : windows.length && windows.every(value => value.state === "available") ? "available" : "unknown", until: blocked.length && blocked.every(value => value.resetAt !== null) ? Math.max(...blocked.map(value => value.resetAt)) : null, blockedUnknownReset: blocked.some(value => value.resetAt === null), trialAvailable: state.trial !== null && state.trial.usedBy === null, probeRequired: state.probeRequired, invalidatedAt: state.invalidatedAt, windows, extraUsage: state.probeRequired ? emptyExtra() : state.extraUsage };
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
		async admit(value, { windows = ["five-hour", "seven-day"], attemptId, consumeTrial = true, allowExtraUsage = false, maxCreditMicros = null, requireExtraUsageKnownDisabled = false } = {}) {
			if (!Array.isArray(windows) || windows.some(value => !["five-hour", "seven-day"].includes(value)) || new Set(windows).size !== windows.length || allowExtraUsage && (!Number.isSafeInteger(maxCreditMicros) || maxCreditMicros <= 0)) throw quotaError("subscription-invalid-policy");
			return mutate(value, (state, status) => {
				if (state.probeRequired) {
					if (status.state === "exhausted") return { ok: false, reason: "subscription-quota", until: status.until, status };
					return { ok: consumeTrial === false, reason: "subscription-observation-required", requiresUsage: true, status };
				}
				if (requireExtraUsageKnownDisabled && status.extraUsage.enabled !== false && !allowExtraUsage) return { ok: false, reason: "subscription-extra-usage", until: null, status };
				// Monitoring preferences do not authorize spending against any observed exhausted bucket.
				const blocked = status.windows.filter(row => row.state === "exhausted");
				if (blocked.length === 0) return { ok: true, reason: status.state === "unknown" ? "subscription-unknown" : "subscription-available", ...(allowExtraUsage ? { creditCapMicros: maxCreditMicros } : {}), status };
				if (allowExtraUsage && status.extraUsage.enabled === true) return { ok: true, reason: "subscription-available", creditCapMicros: maxCreditMicros, status };
				if (blocked.every(row => row.resetAt === null) && state.trial !== null) {
					if (consumeTrial === false && state.trial.usedBy === null) return { ok: true, reason: "subscription-trial", status };
					if (typeof attemptId !== "string" || attemptId.length === 0 || attemptId.length > 256) throw quotaError("subscription-invalid-trial");
					const usedBy = hash(attemptId);
					if (state.trial.usedBy === usedBy) return { ok: true, reason: "subscription-trial", status };
					if (state.trial.usedBy === null) return { ok: true, reason: "subscription-trial", next: { ...state, trial: { ...state.trial, usedBy } } };
				}
				return { ok: false, reason: "subscription-quota", until: blocked.every(row => row.resetAt !== null) ? Math.max(...blocked.map(row => row.resetAt)) : null, status };
			}, { bind: consumeTrial !== false });
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
