The access states that are not the sign-in form itself: the one-time link page, and what an operator, a viewer and a read-only console each see on the same page.

**How a person uses it.**
- **One-time link.** `/login/code#<code>` shows "Signing in with a one-time link" while it posts the code, after taking the code out of the browser history. If the link was used, has expired or is unknown, it says so, gives the command for a new link, and offers "Sign in with a token instead". A link with no code says so too. Without JavaScript the page says only "The console needs JavaScript to sign in."
- **Operator.** Sees reasons, transcripts, phase names, chat, Audit and every action, each as preview then Confirm.
- **Viewer.** Sees the same rows and numbers. In place of a hidden detail, the viewer gets the repo's sentence, such as "Failure reasons are shown to operators only.", "Phase names and the run's note are shown to operators only.", "Transcripts are shown to operators only." or "Chat is for operators; a viewer sees the run's status only." There are no action buttons, and no Audit in the nav.
- **Read-only console.** A console started with `PI_CONSOLE_READ_ONLY=1` shows a "Read-only console" chip in the top bar and a banner. Operators keep every detail, but no page has a form, and talking to a run points to the terminal command.

**Panels.** `p-link-wait`, `p-link-used`, `p-link-nocode`, `p-role-operator`, `p-role-viewer`, `p-role-read-only`.

**The server provides.** The signed-in token's name and role, the read-only flag, and for the link page a closed answer: signing in, used/expired/unknown, or no code. A role decides on the server which panels and fields are sent at all. A viewer's page never carries the hidden text.

**Fixture note.** gh-f0c2 (failed on mini1) and gh-b3d7 (running, phase 2 of 4) are fixture runs. The failure text and the phase name are sample copy.
