export const PROVIDER_FAILURE_KINDS = Object.freeze(["rate-limited", "quota-exhausted", "overloaded", "context-overflow"]);
export const MODEL_WHY = Object.freeze(["primary", "fallback-cooldown", "fallback-window", "fallback-unavailable", "fallback-context", "random", "random-subscription-limit"]);
/**
 * The closed subscription quota codes a signed `providerFailure` may name, and the only ones subscription-quota.mjs
 * records. The runner's SUBSCRIPTION_QUOTA_CODES (image/runner/src/provider-failure.mjs), which a worker cannot import at
 * run time, is pinned equal to this list by worker/test/model-failover.test.mjs. Issue #960 added ChatGPT's two
 * non-retryable usage limits.
 */
export const SUBSCRIPTION_QUOTA_CODES = Object.freeze(["usage_limit_reached", "usage_not_included", "rate_limit_exceeded", "quota_exhausted", "subscription_sharing_usage_limit_exceeded", "subscription_sharing_workplace_individual_usage_limit_exceeded"]);

export function providerFailureOf(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) || !PROVIDER_FAILURE_KINDS.includes(value.kind)) return null;
	if (value.resetAt !== undefined && (!Number.isSafeInteger(value.resetAt) || value.resetAt < 0 || value.resetAt > 253_402_300_799_999)) return null;
	if (value.subscriptionCode !== undefined && !SUBSCRIPTION_QUOTA_CODES.includes(value.subscriptionCode)) return null;
	if (value.subscriptionCode !== undefined && !["openai", "anthropic"].includes(value.subscriptionProvider)) return null;
	if (value.subscriptionProvider !== undefined && !["openai", "anthropic"].includes(value.subscriptionProvider)) return null;
	return { kind: value.kind, ...(value.resetAt !== undefined ? { resetAt: value.resetAt } : {}), ...(value.subscriptionCode ? { subscriptionCode: value.subscriptionCode } : {}), ...(value.subscriptionProvider ? { subscriptionProvider: value.subscriptionProvider } : {}) };
}
