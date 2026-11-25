/** Closed subscription DTO (#781). Credential documents and provider payloads never cross this boundary. */
import { notionalConnection } from "@edgehero/pi-dispatch/reserve-estimate";
export const SUBSCRIPTION_ADAPTERS = Object.freeze({
  "openai-chatgpt": Object.freeze({ provider: "openai", package: null, version: null, community: false, usage: false }),
  "pi-anthropic-oauth@0.3.6": Object.freeze({ provider: "anthropic", package: "pi-anthropic-oauth", version: "0.3.6", community: true, usage: true }),
  "pi-anthropic-oauth@0.3.11": Object.freeze({ provider: "anthropic", package: "pi-anthropic-oauth", version: "0.3.11", community: true, usage: true }),
  "@gotgenes/pi-anthropic-auth@3.4.3": Object.freeze({ provider: "anthropic", package: "@gotgenes/pi-anthropic-auth", version: "3.4.3", community: true, usage: true }),
});
export const SUBSCRIPTION_VIEW_LIMITS = Object.freeze({ windows: 64, connections: 128, freshMs: 300_000, maxInstant: 253_402_300_799_999 });
const STATES = new Set(["connected", "disconnected", "reauth-required", "refresh-uncertain", "other-host", "adapter-unavailable"]);
const COMPATIBILITY = new Set(["verified", "disabled", "unstaged", "unpinned", "conflicting", "version-mismatch", "unavailable", "unknown"]);
const id = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value) ? value : null;
const instant = value => Number.isSafeInteger(value) && value >= 0 && value <= SUBSCRIPTION_VIEW_LIMITS.maxInstant ? value : null;
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const percent = value => number(value) !== null && value <= 10_000 ? value : null;
const bool = value => typeof value === "boolean" ? value : null;
const list = value => Array.isArray(value) ? value : [];

function extraUsage(value) {
  return {
    enabled: bool(value?.enabled), usedPercent: percent(value?.usedPercent),
    usedCredits: number(value?.usedCredits), monthlyLimit: number(value?.monthlyLimit),
    currency: typeof value?.currency === "string" && /^[A-Z]{3}$/.test(value.currency) ? value.currency : null,
    decimalPlaces: Number.isInteger(value?.decimalPlaces) && value.decimalPlaces >= 0 && value.decimalPlaces <= 4 ? value.decimalPlaces : null,
  };
}

function quotaOf(value, now) {
  const observedAt = instant(value?.observedAt);
  // The published freshness flag is evidence only until its five-minute bound. Future observations are unknown.
  const fresh = value?.fresh === true && observedAt !== null && observedAt <= now && now - observedAt <= SUBSCRIPTION_VIEW_LIMITS.freshMs;
  const windows = list(value?.windows).slice(0, SUBSCRIPTION_VIEW_LIMITS.windows).map(row => ({
    id: id(row?.id), window: ["five-hour", "seven-day", "other"].includes(row?.window) ? row.window : "other",
    scope: row?.scope === "account" ? "account" : row?.scope === "scoped" ? "scoped" : "unknown",
    usedPercent: percent(row?.usedPercent), resetAt: instant(row?.resetAt),
    state: ["available", "exhausted"].includes(row?.state) ? row.state : "unknown",
  }));
  for (const window of ["five-hour", "seven-day"]) if (!windows.some(row => row.window === window && row.scope === "account")) windows.push({ id: null, window, scope: "account", usedPercent: null, resetAt: null, state: "unknown" });
  return {
    observedAt, fresh, state: ["available", "exhausted"].includes(value?.state) ? value.state : "unknown",
    until: instant(value?.until), blockedUnknownReset: value?.blockedUnknownReset === true,
    trialAvailable: value?.trialAvailable === true, retestAt: instant(value?.retestAt), trialClaimedAt: instant(value?.trialClaimedAt), windows, extraUsage: extraUsage(value?.extraUsage),
  };
}

/** @returns {{state:string,partial:boolean,now:number,connections:Array<object>}} */
export function subscriptionAuthView(value, { now = Date.now() } = {}) {
  now = typeof now === "function" ? now() : now;
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("subscription view needs a valid clock");
  const rows = list(Array.isArray(value) ? value : value?.connections);
  const truncated = rows.length > SUBSCRIPTION_VIEW_LIMITS.connections;
  const connections = rows.slice(0, SUBSCRIPTION_VIEW_LIMITS.connections).flatMap(row => {
    const connectionId = id(row?.id);
    if (!connectionId) return [];
    const adapter = typeof row.adapter === "string" && Object.hasOwn(SUBSCRIPTION_ADAPTERS, row.adapter) ? row.adapter : null;
    const provider = ["openai", "anthropic"].includes(row.provider) ? row.provider : null;
    const metadata = adapter ? SUBSCRIPTION_ADAPTERS[adapter] : null;
    const compatibility = COMPATIBILITY.has(row.compatibility) ? row.compatibility : "unknown";
    const quotaWindows = Array.isArray(row.quotaWindows) && row.quotaWindows.length <= 2 && new Set(row.quotaWindows).size === row.quotaWindows.length && row.quotaWindows.every(window => ["five-hour", "seven-day"].includes(window)) ? [...row.quotaWindows] : null;
    const expiresAt = instant(row.expiresAt), expired = expiresAt !== null && expiresAt <= now;
    const state = STATES.has(row.state) ? row.state : "unknown";
    return [{
      id: connectionId, provider, adapter, ownerHost: id(row.ownerHost), active: bool(row.active), state,
      compatibility: metadata && metadata.provider === provider ? compatibility : "unavailable",
      expiresAt, expired, lastRefreshAt: instant(row.lastRefreshAt),
      extraUsageCreditMicros: Number.isSafeInteger(row.extraUsageCreditMicros) && row.extraUsageCreditMicros >= 0 ? row.extraUsageCreditMicros : null,
      extraUsage: ["enabled", "disabled"].includes(row.extraUsage) ? row.extraUsage : "unknown",
      quotaWindows, quota: quotaOf(row.quota, now),
      // Issue #1008: the owner host's quota reserve, a whole percent 1-99, published on a Claude connection it owns; null
      // when it publishes none (no reserve set, or a host older than the reserve, which holds nothing either way).
      reservePercent: Number.isInteger(row.reservePercent) && row.reservePercent >= 1 && row.reservePercent <= 99 ? row.reservePercent : null,
    }];
  });
  return { now, state: value && (Array.isArray(value) || value.state === "ready") ? "ready" : "unknown", partial: value?.partial !== false || truncated || connections.length < Math.min(rows.length, SUBSCRIPTION_VIEW_LIMITS.connections), truncated: value?.truncated === true || truncated, connections };
}

/**
 * The providers the published status says a subscription with no paid extra usage carries (issue #1008): each provider
 * with a bound (`active`) connection whose `extraUsageCreditMicros` is unset, the worker's own rule
 * (`notionalConnection`), as any live host publishes it: the union of the hosts' bindings. Where it holds: on a host
 * whose own connections file binds that provider, a current worker marks its calls notional and a current image leaves
 * them out of the job cap, and a bound provider never falls back to an API key whatever its connection's state. Where it
 * does not: a host without that binding (each host reads its own file) runs the provider on an API key under the cap, a
 * worker from before issue #1008 never marks a connection, and an image from before it counts every subscription call,
 * so a preview read from this set can say less than such a host does (docs/upgrading.md, mixed versions). A Set; empty
 * for a status that is missing or names none, so a doubt keeps every model under the cap. `value` is raw published
 * status, normalized here.
 */
export function notionalBoundProviders(value, { now = Date.now() } = {}) {
  let view;
  try {
    view = subscriptionAuthView(value, { now });
  } catch {
    return new Set();
  }
  return new Set(view.connections.filter((row) => row.active === true && row.provider !== null && notionalConnection(row)).map((row) => row.provider));
}

/** Optional reader seam: the console observes published safe status and never opens a host credential file. */
export async function readSubscriptionAuthView({ snapshot = null, read = null, now = Date.now() } = {}) {
  try { return subscriptionAuthView(typeof read === "function" ? await read() : snapshot?.subscriptionAuth, { now }); }
  catch { return subscriptionAuthView(null, { now }); }
}

/** Repeat the same allowlist for model context; never spread a DTO supplied by a caller. */
export function subscriptionAuthForAgent(view) {
  return subscriptionAuthView(view, { now: instant(view?.now) ?? 0 });
}
