Fresh sign-in for one sandbox attachment, drawn in the console before returning to the separate gateway tab. The original console session and launch tab must both survive the rendezvous.

**How a person uses it.**
- Check the sandbox, host, operator identity and enrolled gateway destination. Enter the same operator token used by the current session, then authorize this terminal or cancel.
- The console validates the token without replacing the session. A different operator token, changed session, missing launch proof or expired intent refuses with a reason.
- Authorization lasts 60 seconds, works once, and remains server side. Public request ids in navigation confer no authority. Browser and console proofs never become URLs.
- With JavaScript unavailable, token submission is disabled and the page explains how to return to Sandboxes and copy the command.

**Panels.** `p-gateway-signin`.

**The server provides.** The original live session’s closed identity and the exact shell/gateway context, only after same-origin initialization. A generic cross-site arrival contains no private metadata.

**Fixture note.** ops, mini1, gh-9575 and sandbox.example.test are sample. No real token is shown or embedded.
