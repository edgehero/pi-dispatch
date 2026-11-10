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
