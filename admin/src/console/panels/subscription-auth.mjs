import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { SUBSCRIPTION_ADAPTERS, subscriptionAuthView } from "../../subscription-auth-view.mjs";
import { PROVIDER_AUTH_GUIDES } from "../../provider-help.mjs";

const STATES = Object.freeze({
  connected: ["ok", "Connected"], disconnected: ["idle", "Disconnected"],
  "reauth-required": ["attention", "Sign-in required"], "refresh-uncertain": ["attention", "Refresh outcome uncertain"],
  "other-host": ["idle", "Owned by another host"], "adapter-unavailable": ["attention", "Adapter unavailable"], unknown: ["idle", "Credential status unknown"],
});
const COMPATIBILITY = Object.freeze({
  verified: ["ok", "Pinned artifact verified; job checks remain"], disabled: ["attention", "Extension disabled"],
  unstaged: ["attention", "Extension not staged"], unpinned: ["attention", "Exact version not pinned"],
  conflicting: ["attention", "Conflicting provider overrides"], "version-mismatch": ["attention", "Adapter version mismatch"],
  unavailable: ["attention", "Adapter unavailable"], unknown: ["idle", "Compatibility not published"],
});
const utc = value => value === null ? "Not published" : `${new Date(value).toISOString().replace("T", " ").slice(0, 19)} UTC`;
const code = value => html`<span class="code">${value}</span>`;
const facts = rows => html`<dl class="sa-facts">${rows.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>`;
const selected = value => value === true ? "selected" : value === false ? "not selected" : "selection unknown";
const owner = row => row.ownerHost ? html`<a href="${`/fleet/host?name=${encodeURIComponent(row.ownerHost)}`}">${row.ownerHost}</a>` : "Owner not published";
const extra = row => row.quota.extraUsage.enabled === true ? "Enabled" : row.quota.extraUsage.enabled === false ? "Disabled" : row.extraUsage === "enabled" ? "Enabled" : row.extraUsage === "disabled" ? "Disabled" : "Unknown";
const credit = row => row.extraUsageCreditMicros === null ? "Not authorized for paid overage" : `${row.extraUsageCreditMicros / 1_000_000} USD per job (conservative model-cost bound); deployment dollar caps still apply`;
const allowed = view => view.role === "operator" && !view.readOnly;
const source = (view, page) => subscriptionAuthView(view.data?.[page]?.subscriptionAuth ?? view.data?.subscriptionAuth, { now: view.now ?? view.data?.now ?? 0 });
const title = (row, status) => html`<div class="sa-title"><h3>${code(row.id)}</h3>${ui.badge(...status)}</div>`;

function commands(view, row, quotaOnly) {
  if (!allowed(view)) return null;
  const commands = quotaOnly ? ["usage", ...(row.quota.blockedUnknownReset && !row.quota.trialAvailable ? ["trial"] : [])] : ["login", "logout", "usage", ...(row.quota.blockedUnknownReset && !row.quota.trialAvailable ? ["trial"] : [])];
  return html`<div class="sa-commands"><p class="sa-note">Run in a terminal on ${row.ownerHost ?? "the owning host"}. Sign-in and refresh never run in this browser. ${row.quota.blockedUnknownReset ? row.quota.retestAt ? row.quota.trialAvailable ? "One quota trial is already authorized. It starts no job here; a trial job the provider answers clears the refusal." : "Trial authorizes one fresh, normally budgeted pickup check. It starts no job here; a trial job the provider answers clears the refusal." : row.quota.trialAvailable ? "One quota trial is already authorized. It does not clear account exhaustion or start a job here." : "Trial authorizes one fresh, normally budgeted pickup check; it does not clear account exhaustion or start a job here." : null}</p>${commands.map(command => html`<div><p class="sa-note">${({ login: "Sign in or reauthenticate", logout: "Disconnect this connection", usage: "Refresh quota observations", trial: "Authorize one quota trial" })[command]}</p>${ui.cmd(["pi-dispatch", "auth", command, row.id])}</div>`)}</div>`;
}

const partial = data => data.connections.length && data.partial ? ui.banner({ status: "attention", sm: true, title: "Partial subscription observations", body: data.truncated ? "The display limit was reached. Additional connection records are not shown; missing observations are unknown." : "Some host observations are missing or incomplete. Published facts remain visible; missing observations are unknown." }) : null;

function empty(view) {
  if (view.state === "ready" && !view.partial) return html`<p>No subscription connection is configured.</p>`;
  return html`<p>${ui.badge("idle", "Subscription status not published")}</p><p class="sa-note">No credential or quota inference can be made from missing host observations.</p>`;
}

export function subscriptionGuides(view) {
  return html`<div class="pk-help">${Object.entries(PROVIDER_AUTH_GUIDES).map(([provider, guide]) => html`<details class="pk-guide" data-subscription-help="${provider}"><summary>${guide.label}</summary><div class="pk-links">${ui.outLink({ href: guide.docsUrl, label: "Host connection guide", btn: "sm" })}${ui.outLink({ href: guide.officialUrl, label: "Official provider guidance" })}</div><ol>${guide.steps.map(step => html`<li>${step}</li>`)}</ol><p class="pk-note pk-notice">${guide.notice}</p>${allowed(view) && guide.command ? html`<p class="pk-note pk-notice">Replace &lt;connection-id&gt; with the configured connection name before running on its owning host.</p>${ui.cmd(guide.command.split(" "))}` : null}</details>`)}</div>`;
}

export function connectionsSubscriptionAuth(view) {
  const data = source(view, "connections");
  return ui.card({ title: "Subscription authentication", sub: "host-owned credentials, safe status only", body: html`<p class="pk-intro">Subscription credentials stay on the owning host. Use its supported sign-in flow, separately from API keys.</p>${subscriptionGuides(view)}${partial(data)}<div class="sa-accounts">${data.connections.map(row => {
    const metadata = row.adapter ? SUBSCRIPTION_ADAPTERS[row.adapter] : null;
    return html`<article class="sa-account">${title(row, STATES[row.state])}${facts([
      ["Provider", `${row.provider ?? "Unknown"}, ${selected(row.active)}`],
      ["Adapter", metadata ? html`${code(row.adapter)}${metadata.community ? " (community)" : " (pi-dispatch built-in)"}` : "Unsupported or unpublished adapter"],
      ["Owner host", owner(row)], ["Compatibility", ui.badge(...COMPATIBILITY[row.compatibility])],
      ["Access token expiry", html`${utc(row.expiresAt)}${row.expired ? " (access token expired; host refresh required)" : null}`],
      ["Last refresh", utc(row.lastRefreshAt)], ["Extra usage", extra(row)], ["Paid overage ceiling", credit(row)],
    ])}<p class="sa-note">Credentials stay on the owning host. Connected describes the credential record, not a successful paid request. ${row.state === "refresh-uncertain" ? "The refresh result could not be durably established. Sign in again on the owning host before retrying." : row.state === "other-host" ? "Only the owning host may refresh or sign in for this connection." : row.state === "adapter-unavailable" ? "Check the selected exact package, staged extension and provider override before signing in." : null}</p>${commands(view, row, false)}</article>`;
  })}${data.connections.length ? null : empty(data)}</div>` });
}

function windowTitle(window) {
  return `${window.window === "five-hour" ? "Five-hour" : window.window === "seven-day" ? "Seven-day" : "Other"} ${window.scope === "account" ? "account" : window.scope === "scoped" ? "scoped" : "quota"} window`;
}

function monitoringFocus(row) {
  if (row.quotaWindows === null) return "Not published; all windows shown";
  if (row.quotaWindows.length === 0) return "None selected";
  return row.quotaWindows.length === 2 ? "Five-hour and seven-day account windows" : row.quotaWindows[0] === "five-hour" ? "Five-hour account window" : "Seven-day account window";
}

function outsideFocus(row, window) {
  return row.quotaWindows !== null && window.scope === "account" && ["five-hour", "seven-day"].includes(window.window) && !row.quotaWindows.includes(window.window);
}

function focusedWindows(row, now) {
  // A display preference cannot hide a known blocker, the quota reserve's included. Scoped/other windows have no
  // selectable policy token.
  return row.quota.windows.filter(window => window.state === "exhausted" || atReserve(row, window, now) || !outsideFocus(row, window));
}

function quotaState(row, now) {
  const quota = row.quota;
  if (quota.state === "exhausted") return ["attention", quota.fresh ? "Quota exhausted" : "Exhaustion retained"];
  // Issue #1008: "available" would read as room while the reserve holds unmarked jobs.
  if (heldByReserve(row, now)) return ["attention", scopedOnly(row, now) ? "A scoped window is at or above the quota reserve" : "At or above the quota reserve"];
  return quota.fresh && quota.state === "available" ? ["ok", "Quota observed available"] : ["idle", "Quota unknown"];
}

/**
 * Issue #1008: the owner host's quota reserve, only where the host publishes one, so a connection without it reads as it
 * always did.
 */
function reserveFacts(row) {
  if (row.reservePercent === null) return [];
  return [["Quota reserve", html`${row.reservePercent}%. At or above it, only jobs of triggers with ${code("run.quotaReserve")} start; the others wait until the window drops below it or resets.`]];
}

/**
 * A window the reserve holds, by the worker's rule (`quotaReserveBlock`) as far as this page can see it: a measured
 * percentage at or above the reserve, with its reset still ahead, or with no reset on a fresh reading. A passed reset
 * opened a new window, which the worker no longer counts. The host publishes no freshness per window, so a window with
 * no reset is judged on its connection's reading. The worker decides at pickup; this is what the page can show of it.
 */
const atReserve = (row, window, now) => row.reservePercent !== null && window.usedPercent !== null && window.usedPercent >= row.reservePercent && (window.resetAt !== null ? window.resetAt > now : row.quota.fresh);

/** Whether the reserve holds this connection's unmarked jobs (exhaustion says its own words first). */
const heldByReserve = (row, now) => row.quota.state !== "exhausted" && row.quota.windows.some(window => atReserve(row, window, now));

/**
 * Whether only scoped windows hold: the worker counts a scoped window for every route it applies to, and the reviewed
 * Fable weekly scope does not apply to `anthropic/claude-opus-5-5` (`statusForModel`), so such a hold may leave some
 * models' jobs free. The page cannot tell which scope a window is, so it says so rather than claim every job waits.
 */
const scopedOnly = (row, now) => row.quota.windows.filter(window => atReserve(row, window, now)).every(window => window.scope === "scoped");

export function modelsSubscriptionQuota(view) {
  const data = source(view, "models");
  return ui.card({ title: "Subscription quota", sub: "account windows, separate from dollar caps", body: html`${partial(data)}<div class="sa-accounts">${data.connections.map(row => html`<article class="sa-account">${title(row, quotaState(row, data.now))}${facts([
    ["Provider", row.provider ?? "Unknown"], ["Owner host", owner(row)], ["Monitoring focus", monitoringFocus(row)],
    ["Observation", row.quota.observedAt === null ? "Not published" : `${row.quota.fresh ? "Fresh" : "Stale or freshness unknown"}, observed ${utc(row.quota.observedAt)}`],
    ["Pickup", row.quota.blockedUnknownReset ? row.quota.trialAvailable ? "Exhausted; reset unknown. One trial is authorized; other pickup gates still apply." : row.quota.retestAt === null ? "Exhausted; reset unknown. A fresh observation or explicit host trial is needed." : row.quota.trialClaimedAt !== null && data.now < row.quota.retestAt ? `Exhausted; reset unknown. One job is retesting the connection since ${utc(row.quota.trialClaimedAt)}; a retest the provider answers clears it.` : `Exhausted; reset unknown. One job retests the connection from ${utc(row.quota.retestAt)}; a retest the provider answers clears it; an explicit host trial can come sooner.` : row.quota.state === "exhausted" ? row.quota.until === null ? "Exhausted; reset not published" : `Waiting until ${utc(row.quota.until)}` : heldByReserve(row, data.now) ? scopedOnly(row, data.now) ? html`A scoped window is at or above the quota reserve: on the models it applies to, only jobs of triggers with ${code("run.quotaReserve")} start (the reviewed Fable weekly scope does not apply to ${code("anthropic/claude-opus-5-5")})` : html`Only jobs of triggers with ${code("run.quotaReserve")} start while a window is at or above the quota reserve; the others wait` : row.quota.fresh && row.quota.state === "available" ? "Quota observation permits checking other pickup gates" : "Quota availability is not known"],
    ...reserveFacts(row), ["Extra usage", extra(row)], ["Paid overage ceiling", credit(row)],
  ])}<ul class="sa-windows">${focusedWindows(row, data.now).map(window => html`<li class="sa-window"><b>${windowTitle(window)}</b><span>${window.usedPercent === null ? "Usage unknown" : `${window.usedPercent}% used`}. ${window.resetAt === null ? "Reset unknown" : `Resets ${utc(window.resetAt)}`}. ${window.state === "exhausted" ? "Observed exhausted." : window.state === "unknown" ? "Window status unknown." : "Observed available."}${atReserve(row, window, data.now) ? " At or above the quota reserve." : null}</span>${outsideFocus(row, window) ? html`<p class="sa-note">${window.state === "exhausted" ? "Required exhaustion evidence outside the monitoring focus. This choice does not disable the cooldown." : "Outside the monitoring focus, shown because the quota reserve holds jobs on it."}</p>` : null}</li>`)}</ul>${row.quota.extraUsage.usedCredits !== null && row.quota.extraUsage.monthlyLimit !== null ? html`<p class="sa-note">Extra usage: ${row.quota.extraUsage.usedCredits} of ${row.quota.extraUsage.monthlyLimit} provider credit units${row.quota.extraUsage.currency ? ` (${row.quota.extraUsage.currency}, decimal scale ${row.quota.extraUsage.decimalPlaces ?? "unknown"})` : " (currency unknown)"}. This is separate from deployment dollar spend.</p>` : null}<p class="sa-note">Known exhausted windows remain visible and still apply at pickup, even outside the monitoring focus. Quota is shared by jobs using this connection and application bucket. Unknown or stale observations are not remaining capacity; deployment dollar windows still apply. A fallback is checked separately at pickup.</p>${commands(view, row, true)}</article>`) }${data.connections.length ? null : empty(data)}</div>` });
}
