import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { SUBSCRIPTION_ADAPTERS, subscriptionAuthView } from "../../subscription-auth-view.mjs";

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
  return html`<div class="sa-commands"><p class="sa-note">Run in a terminal on ${row.ownerHost ?? "the owning host"}. Sign-in and refresh never run in this browser. ${row.quota.blockedUnknownReset ? row.quota.trialAvailable ? "One quota trial is already authorized. It does not clear account exhaustion or start a job here." : "Trial authorizes one fresh, normally budgeted pickup check; it does not clear account exhaustion or start a job here." : null}</p>${commands.map(command => html`<div><p class="sa-note">${({ login: "Sign in or reauthenticate", logout: "Disconnect this connection", usage: "Refresh quota observations", trial: "Authorize one quota trial" })[command]}</p>${ui.cmd(["pi-dispatch", "auth", command, row.id])}</div>`)}</div>`;
}

const partial = data => data.connections.length && data.partial ? ui.banner({ status: "attention", sm: true, title: "Partial subscription observations", body: data.truncated ? "The display limit was reached. Additional connection records are not shown; missing observations are unknown." : "Some host observations are missing or incomplete. Published facts remain visible; missing observations are unknown." }) : null;

function empty(view) {
  if (view.state === "ready" && !view.partial) return html`<p>No subscription connection is configured.</p>`;
  return html`<p>${ui.badge("idle", "Subscription status not published")}</p><p class="sa-note">No credential or quota inference can be made from missing host observations.</p>`;
}

export function connectionsSubscriptionAuth(view) {
  const data = source(view, "connections");
  return ui.card({ title: "Subscription authentication", sub: "host-owned credentials, safe status only", body: html`${partial(data)}<div class="sa-accounts">${data.connections.map(row => {
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

function focusedWindows(row) {
  // A display preference cannot hide a known blocker. Scoped/other windows have no selectable policy token.
  return row.quota.windows.filter(window => window.state === "exhausted" || !outsideFocus(row, window));
}

function quotaState(quota) {
  if (quota.state === "exhausted") return ["attention", quota.fresh ? "Quota exhausted" : "Exhaustion retained"];
  return quota.fresh && quota.state === "available" ? ["ok", "Quota observed available"] : ["idle", "Quota unknown"];
}

export function modelsSubscriptionQuota(view) {
  const data = source(view, "models");
  return ui.card({ title: "Subscription quota", sub: "account windows, separate from dollar caps", body: html`${partial(data)}<div class="sa-accounts">${data.connections.map(row => html`<article class="sa-account">${title(row, quotaState(row.quota))}${facts([
    ["Provider", row.provider ?? "Unknown"], ["Owner host", owner(row)], ["Monitoring focus", monitoringFocus(row)],
    ["Observation", row.quota.observedAt === null ? "Not published" : `${row.quota.fresh ? "Fresh" : "Stale or freshness unknown"}, observed ${utc(row.quota.observedAt)}`],
    ["Pickup", row.quota.blockedUnknownReset ? row.quota.trialAvailable ? "Exhausted; reset unknown. One trial is authorized; other pickup gates still apply." : "Exhausted; reset unknown. A fresh observation or explicit host trial is needed." : row.quota.state === "exhausted" ? row.quota.until === null ? "Exhausted; reset not published" : `Waiting until ${utc(row.quota.until)}` : row.quota.fresh && row.quota.state === "available" ? "Quota observation permits checking other pickup gates" : "Quota availability is not known"],
    ["Extra usage", extra(row)], ["Paid overage ceiling", credit(row)],
  ])}<ul class="sa-windows">${focusedWindows(row).map(window => html`<li class="sa-window"><b>${windowTitle(window)}</b><span>${window.usedPercent === null ? "Usage unknown" : `${window.usedPercent}% used`}. ${window.resetAt === null ? "Reset unknown" : `Resets ${utc(window.resetAt)}`}. ${window.state === "exhausted" ? "Observed exhausted." : window.state === "unknown" ? "Window status unknown." : "Observed available."}</span>${outsideFocus(row, window) ? html`<p class="sa-note">Required exhaustion evidence outside the monitoring focus. This choice does not disable the cooldown.</p>` : null}</li>`)}</ul>${row.quota.extraUsage.usedCredits !== null && row.quota.extraUsage.monthlyLimit !== null ? html`<p class="sa-note">Extra usage: ${row.quota.extraUsage.usedCredits} of ${row.quota.extraUsage.monthlyLimit} provider credit units${row.quota.extraUsage.currency ? ` (${row.quota.extraUsage.currency}, decimal scale ${row.quota.extraUsage.decimalPlaces ?? "unknown"})` : " (currency unknown)"}. This is separate from deployment dollar spend.</p>` : null}<p class="sa-note">Known exhausted windows remain visible and still apply at pickup, even outside the monitoring focus. Quota is shared by jobs using this connection and application bucket. Unknown or stale observations are not remaining capacity; deployment dollar windows still apply. A fallback is checked separately at pickup.</p>${commands(view, row, true)}</article>`) }${data.connections.length ? null : empty(data)}</div>` });
}
