"""Remembered browsers: which browsers stay signed in without a token or a link, and how a person ends that (issue #849).

A browser is remembered only when a person asks, at sign-in or on the first page after a link signed them in. This page is
where that is seen and undone: this browser, every remembered browser, and signing everyone out. Nothing here is live: the
list changes only when someone remembers, signs out or removes a browser."""
from pulse import *
from gen_config2 import table, code, COMMON_CSS


def readme(name, text):
    open(f"{ROOT}/{name}/README.md", "w").write(text.strip() + "\n")


CSS = COMMON_CSS + """
.dev-what, .dev-who { display: grid; gap: 2px; min-width: 0; }
.dev-what b, .dev-who b { font-weight: 650; }
.dev-what small, .dev-who small { font-size: 12px; color: var(--ink-muted); }
.dev-what .chip { justify-self: start; }
.dev-act { text-align: right; white-space: nowrap; }
.dev-foot { display: flex; gap: 8px; align-items: flex-start; padding: var(--space-3) var(--space-5) var(--space-4); font-size: 12px; line-height: 18px; color: var(--ink-muted); border-top: 1px solid var(--line); }
.dev-foot .ic { flex: none; margin-top: 2px; }
.dev-offer { margin-bottom: var(--space-4); }
/* This browser is remembered: the top bar's avatar wears a ring, which a phone shows where it hides the role and the word. */
.top .avatar { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--ink); }
@media (max-width: 760px) { .dev-act { text-align: left; } }
"""


def browser(label, ident, here=False):
    mark = chip("This browser", "ok") if here else ""
    return f'<span class="dev-what"><b>{E(label)}</b>{mark}<small class="code">{ident}</small></span>'


def person(name, role):
    return f'<span class="dev-who"><b>{E(name)}</b><small>{role}</small></span>'


def this_browser():
    body = ('<p>This browser is remembered. It stays signed in across idle time and restarts until you sign out here or it is removed below.</p>'
            f'<p class="note">Its id is {code("3f9a1c0b7d2e")}.</p>')
    return card("This browser", body, end=chip("Remembered", "ok", "shield"))


def list_card():
    remove = f'<div class="dev-act">{btn("Remove", "danger", "cancel")}</div>'
    rows = [
        [(browser("Chrome on macOS", "3f9a1c0b7d2e", here=True), ""), (person("ops", "operator"), ""), ("2026-09-15", ""), ("2026-10-08", ""), (remove, "wide")],
        [(browser("Safari on iPhone", "8b2e4d6f1a90"), ""), (person("ops", "operator"), ""), ("2026-09-29", ""), ("2026-10-06", ""), (remove, "wide")],
        [(browser("Firefox on Linux", "c71d0e5a9b34"), ""), (person("watcher", "viewer"), ""), ("2026-09-24", ""), ("2026-10-07", ""), (remove, "wide")],
    ]
    foot = f'<p class="dev-foot">{ic("info", "ic ic--sm")}<span>A remembered browser also ends when its token is revoked or rotated, its role changes, or everyone is signed out.</span></p>'
    return card("Remembered browsers", table([("Browser", ""), ("Person", ""), ("Remembered", ""), ("Last used", ""), ("", "")], rows, stack=True) + foot, sub="every person’s", flush=True)


def end_all():
    body = ('<p>Ends every session now, forgets every remembered browser and stops every sign-in link not opened yet, including viewer invitations. '
            f'Every token still works. You are signed out too: sign in again with your token, or run {code("./pi-dispatch console")} on the host.</p>'
            + btn("Sign everyone out", "danger", "logout"))
    return card("Sign everyone out", body)


def offer():
    return ('<div class="dev-offer">' + banner("idle", "shield", "Remember this browser?",
                                              "Stay signed in here across idle time and restarts, until you sign out. Only on a browser that is yours alone.",
                                              act=btn("Remember this browser", "primary") + btn("Not now", "ghost")) + '</div>')


def page():
    inner = (offer()
             + f'<section id="p-dev-this" data-panel>{this_browser()}</section>'
             + f'<section id="p-dev-list" data-panel>{list_card()}</section>'
             + f'<section id="p-dev-all" data-panel>{end_all()}</section>')
    return shell("Configuration", inner, "Remembered browsers",
                 sub="Which browsers stay signed in without a token or a link. A remembered browser ends when it signs out, when it is removed here, or when its token changes.",
                 back="Configuration")


README = """
Remembered browsers: which browsers stay signed in without a token or a link, and how a person ends that. A browser is remembered only when a person asks, so this page is where that is seen and undone. It is drawn on demand, never live.

**How a person uses it.**
- **The offer.** The first page after a fresh sign-in that did not ask to be remembered, a one-time link's above all, offers it once: *Remember this browser* or *Not now*. Ignoring it leaves an ordinary sign-in, and it is never offered to an `agent` token or a viewer invitation.
- **This browser** (`p-dev-this`): whether it is remembered. The top bar says so too, beside the role, and with a ring round the avatar, which a phone shows where it hides the words. To remember a browser later, sign out and sign in again with the box ticked.
- **Remembered browsers** (`p-dev-list`), one row each: the browser, whose it is, when it was remembered and when it was last used. *Remove* is an operator's, with a preview; a viewer sees their own browsers, and signing out forgets one.
- **Sign everyone out** (`p-dev-all`), an operator's, with a preview: every session ends, every remembered browser is forgotten and every sign-in link not opened yet stops working. Every token still works.

**Panels.** `p-dev-this`, `p-dev-list`, `p-dev-all`.

**The server provides.**
- **New:** the remembered-device store's listing (a short id, name, role, a browser label from a closed list, when remembered, last use), never a secret or a whole hash.
- **New:** a one-time offer per fresh sign-in, shown on its next page while it can still be remembered (10 minutes).
- **New:** removing one browser and signing everyone out as audited, previewed writes that need no tokens file change.

**Why it works this way.**
- **A person's decision.** Remembering is never ticked for you, and no agent token can be remembered, remove a browser or sign everyone out.
- **No secret leaves the host.** The page names a browser by a 12-character id; the cookie's secret is only ever in the browser and its hash only on the host.

**Fixture note.** The three browsers, their ids and their dates are sample values; ops and watcher are the sample deployment's operator and viewer.
"""

if __name__ == "__main__":
    write("DevicesScreen", card_marker("Configuration", 1240, 1440, "Remembered browsers: this browser, every browser that stays signed in, and signing everyone out"),
          "Remembered browsers", page(), CSS)
    readme("DevicesScreen", README)
    print("devices card written")
