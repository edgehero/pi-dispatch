Remembered browsers: which browsers stay signed in without a token or a link, and how a person ends that. A browser that a link or a code from the host signed in is remembered at once, and one signed in with a token when its box is ticked, so this page is where that is seen and undone. It is drawn on demand, never live.

**How a person uses it.**
- **The offer.** The first page after a token sign-in whose Remember box was unticked offers it once: *Remember this browser* or *Not now*. Ignoring it leaves an ordinary sign-in, and it is never offered to an `agent` token or a viewer invitation. A link or a code needs no offer: it remembers the browser itself.
- **This browser** (`p-dev-this`): whether it is remembered. The top bar says so too, beside the role, and with a ring round the avatar, which a phone shows where it hides the words. To remember a browser later, sign out and sign in again with a link, a code, or a token with its box ticked.
- **Remembered browsers** (`p-dev-list`), one row each: the browser, whose it is, when it was remembered and when it was last used. *Remove* is an operator's, with a preview; a viewer sees their own browsers, and signing out forgets one.
- **Sign everyone out** (`p-dev-all`), an operator's, with a preview: every session ends, every remembered browser is forgotten and every sign-in link not opened yet stops working. Every token still works.

**Panels.** `p-dev-this`, `p-dev-list`, `p-dev-all`.

**The server provides.**
- **New:** the remembered-device store's listing (a short id, name, role, a browser label from a closed list, when remembered, last use), never a secret or a whole hash.
- **New:** a one-time offer per token sign-in that did not ask, shown on its next page while it can still be remembered (10 minutes).
- **New:** removing one browser and signing everyone out as audited, previewed writes that need no tokens file change.

**Why it works this way.**
- **Remembered by default.** A link or a code the host made remembers the browser it signs in, and the token form's box starts ticked: whoever ran the command on the host has already vouched for this browser, and asking again was the step people missed. Untick the box, or sign out, on a browser that is not yours alone. No agent token can be remembered, remove a browser or sign everyone out.
- **No secret leaves the host.** The page names a browser by a 12-character id; the cookie's secret is only ever in the browser and its hash only on the host.

**Fixture note.** The three browsers, their ids and their dates are sample values; ops and watcher are the sample deployment's operator and viewer.
