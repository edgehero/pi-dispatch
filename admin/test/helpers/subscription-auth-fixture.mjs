import { subscriptionAuthView } from "../../src/subscription-auth-view.mjs";

export function consoleSubscriptionFixture(now, change = () => {}) {
  if (!Number.isSafeInteger(now)) throw new TypeError("subscription fixture needs its clock");
  const value = { state: "ready", partial: false, connections: [{
    id: "claude-work", provider: "anthropic", adapter: "pi-anthropic-oauth@0.3.6", ownerHost: "mini1",
    active: true, compatibility: "verified", state: "connected", expiresAt: now + 3_600_000,
    lastRefreshAt: now - 60_000, extraUsage: "disabled", quotaWindows: ["five-hour", "seven-day"],
    quota: { version: 1, observedAt: now - 10_000, fresh: true, state: "exhausted", until: now + 1_800_000,
      blockedUnknownReset: false, trialAvailable: false,
      windows: [
        { id: "five-hour", window: "five-hour", scope: "account", usedPercent: 100, resetAt: now + 1_800_000, state: "exhausted" },
        { id: "seven-day", window: "seven-day", scope: "account", usedPercent: 42, resetAt: now + 86_400_000, state: "available" },
      ], extraUsage: { enabled: false },
    },
  }] };
  change(value);
  return subscriptionAuthView(value, { now });
}
