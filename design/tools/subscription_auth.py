"""Subscription cards share the existing Pulse facts, badges and command component."""
from pulse import badge, card, cmd, E

def code(value):
    return f'<span class="code">{E(value)}</span>'

def subscription_commands(quota_only=False, blocked_unknown_reset=False, trial_available=False):
    actions = ["usage"] if quota_only else ["login", "logout", "usage"]
    if blocked_unknown_reset and not trial_available:
        actions.append("trial")
    labels = {"login": "Sign in or reauthenticate", "logout": "Disconnect this connection",
              "usage": "Refresh quota observations", "trial": "Authorize one quota trial"}
    note = "Run in a terminal on mini1. Sign-in and refresh never run in this browser."
    if blocked_unknown_reset:
        note += " One quota trial is already authorized. It does not clear account exhaustion or start a job here." if trial_available else " Trial authorizes one fresh, normally budgeted pickup check; it does not clear account exhaustion or start a job here."
    groups = []
    for action in actions:
        words = ["pi-dispatch", "auth", action, "claude-work"]
        text = " ".join(words)
        arguments = " ".join(f"<span>{E(word)}</span>" for word in words)
        box = cmd(text).replace(f"<code>{E(text)}</code>", f"<code>{arguments}</code>", 1)
        groups.append(f'<div><p class="sa-note">{labels[action]}</p>{box}</div>')
    groups = "".join(groups)
    return f'<div class="sa-commands"><p class="sa-note">{note}</p>{groups}</div>'

SUBSCRIPTION_AUTH_CSS = """
.sa-accounts { display: grid; gap: var(--space-5); }
.sa-account { min-width: 0; }
.sa-account + .sa-account { padding-top: var(--space-4); border-top: 1px solid var(--line); }
.sa-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.sa-title h3 { margin: 0; font-size: 15px; }
.sa-facts { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 8px 14px; font-size: 13px; line-height: 20px; }
.sa-facts dt { color: var(--ink-muted); }
.sa-facts .badge { max-width: 100%; height: auto; min-height: 24px; padding-top: 3px; padding-bottom: 3px; white-space: normal; line-height: 18px; align-items: flex-start; }
.sa-facts .badge .ic { margin-top: 2px; }
.sa-facts dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.sa-account .code, .sa-account code { white-space: normal; overflow-wrap: anywhere; }
.sa-note { margin-top: 12px; color: var(--ink-muted); font-size: 13px; line-height: 19px; overflow-wrap: anywhere; }
.sa-commands { margin-top: 16px; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.sa-commands > * { min-width: 0; max-width: 100%; }
.sa-commands .cmd { min-width: 0; }
.sa-commands .cmd code { overflow-wrap: anywhere; white-space: normal; }
.sa-windows { list-style: none; padding: 0; display: grid; gap: 10px; margin-top: 12px; }
.sa-window { padding: 12px; background: var(--surface-2); border-radius: var(--radius-md); min-width: 0; }
.sa-window b { display: block; margin-bottom: 5px; }
@media (max-width: 600px) {
  .sa-facts { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .sa-facts dd { margin-bottom: 8px; }
}
"""

# These rules already ship in console/page-css.mjs and connections-css.mjs. The static card needs the same
# account-heading spacing, argv wrapping and padding; otherwise its controls differ from the actual console.
SUBSCRIPTION_REFERENCE_CSS = """
#p-subscription-auth .sa-title h3 { font-size: 13px; margin-top: 20px; }
.sa-commands .cmd { align-items: flex-start; }
.sa-commands .cmd code { padding: 6px 0; }
.sa-commands .cmd code > span { display: inline-block; max-width: 100%; }
"""

def subscription_auth_card():
    body = f'''<div class="sa-accounts"><article class="sa-account"><div class="sa-title"><h3>{code("claude-work")}</h3>{badge("ok", "Connected")}</div>
      <dl class="sa-facts"><dt>Provider</dt><dd>anthropic, selected</dd><dt>Adapter</dt><dd>{code("pi-anthropic-oauth@0.3.6")} (community)</dd><dt>Owner host</dt><dd><a href="/fleet/host?name=mini1">mini1</a></dd><dt>Compatibility</dt><dd>{badge("ok", "Pinned artifact verified; job checks remain")}</dd><dt>Access token expiry</dt><dd>2026-10-31 16:00:00 UTC</dd><dt>Last refresh</dt><dd>2026-10-31 15:00:00 UTC</dd><dt>Extra usage</dt><dd>Disabled</dd><dt>Paid overage ceiling</dt><dd>Not authorized for paid overage</dd></dl>
      <p class="sa-note">Credentials stay on the owning host. Connected describes the credential record, not a successful paid request.</p>
      {subscription_commands()}</article></div>'''
    return card("Subscription authentication", body, sub="host-owned credentials, safe status only", id_="p-subscription-auth")

def subscription_quota_card(blocked_unknown_reset=False, trial_available=False):
    pickup = "Waiting until 2026-10-31 16:00:00 UTC"
    five_hour_reset = "Resets 2026-10-31 16:00:00 UTC"
    if blocked_unknown_reset:
        pickup = "Exhausted; reset unknown. One trial is authorized; other pickup gates still apply." if trial_available else "Exhausted; reset unknown. A fresh observation or explicit host trial is needed."
        five_hour_reset = "Reset unknown"
    body = f'''<div class="sa-accounts"><article class="sa-account"><div class="sa-title"><h3>{code("claude-work")}</h3>{badge("attention", "Quota exhausted")}</div>
      <dl class="sa-facts"><dt>Provider</dt><dd>anthropic</dd><dt>Owner host</dt><dd><a href="/fleet/host?name=mini1">mini1</a></dd><dt>Monitoring focus</dt><dd>Five-hour and seven-day account windows</dd><dt>Observation</dt><dd>Fresh, observed 2026-10-31 15:39:00 UTC</dd><dt>Pickup</dt><dd>{pickup}</dd><dt>Extra usage</dt><dd>Disabled</dd><dt>Paid overage ceiling</dt><dd>Not authorized for paid overage</dd></dl>
      <ul class="sa-windows"><li class="sa-window"><b>Five-hour account window</b><span>100% used. {five_hour_reset}. Observed exhausted.</span></li><li class="sa-window"><b>Seven-day account window</b><span>42% used. Resets 2026-11-02 00:00:00 UTC. Observed available.</span></li></ul>
      <p class="sa-note">Known exhausted windows remain visible and still apply at pickup, even outside the monitoring focus. Quota is shared by jobs using this connection and application bucket. Unknown or stale observations are not remaining capacity; deployment dollar windows still apply. A fallback is checked separately at pickup.</p>
      {subscription_commands(quota_only=True, blocked_unknown_reset=blocked_unknown_reset, trial_available=trial_available)}</article></div>'''
    return card("Subscription quota", body, sub="account windows, separate from dollar caps", id_="p-subscription-quota")
