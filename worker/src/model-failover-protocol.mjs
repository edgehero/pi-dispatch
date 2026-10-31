export const PROVIDER_FAILURE_KINDS = Object.freeze(["rate-limited", "quota-exhausted", "overloaded", "context-overflow"]);
export const MODEL_WHY = Object.freeze(["primary", "fallback-cooldown", "fallback-window", "fallback-unavailable", "fallback-context"]);

export function providerFailureOf(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) || !PROVIDER_FAILURE_KINDS.includes(value.kind)) return null;
	if (value.resetAt !== undefined && (!Number.isSafeInteger(value.resetAt) || value.resetAt < 0 || value.resetAt > 253_402_300_799_999)) return null;
	if (value.subscriptionCode !== undefined && !["usage_limit_reached", "usage_not_included", "rate_limit_exceeded", "quota_exhausted"].includes(value.subscriptionCode)) return null;
	if (value.subscriptionCode !== undefined && !["openai", "anthropic"].includes(value.subscriptionProvider)) return null;
	if (value.subscriptionProvider !== undefined && !["openai", "anthropic"].includes(value.subscriptionProvider)) return null;
	return { kind: value.kind, ...(value.resetAt !== undefined ? { resetAt: value.resetAt } : {}), ...(value.subscriptionCode ? { subscriptionCode: value.subscriptionCode } : {}), ...(value.subscriptionProvider ? { subscriptionProvider: value.subscriptionProvider } : {}) };
}
