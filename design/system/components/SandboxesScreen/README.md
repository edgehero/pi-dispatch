The operator-only Sandboxes tab on Runs opens a kept workspace in the person’s own terminal, or prepares a fresh clone without a run. The shell has a job’s image, isolation and network, no credentials and no agent.

**How a person uses it.**
- Pick a kept workspace under **From a run**, inspect its image, read-only job inputs, host, venue and deadline, then choose **Open in Terminal** or copy the command.
- The opener, installed once with `pi-dispatch opener install --config sandbox-hosts.json`, checks its own imported host configuration and opens the terminal with the command typed in. It waits for Enter. The link carries an `open` or `attach` verb, id and host, no command or credential.
- On a phone, the opener links are hidden and unfocusable. Copy the command or select its text. With JavaScript off, navigation and Review settings still work; writes explain that Preview and Confirm require JavaScript.
- Under **Without a run**, enter a repository, select a trigger and host, and enter HEAD (the default branch), a branch, tag, commit SHA or `pr:42`. Choose that host’s retention or pin window, then Review settings.
- The preview shows the resolved image, size, venue, network and retention. Confirm queues one host preparation request. The worker rechecks the trigger digest and host plan before cloning; changed settings are refused before a credential is minted.
- The worker clones with a repository-scoped credential, drops it, and keeps the result under an `sb-` id. No container starts, no model runs, no dollars are spent and no run slot is taken. Open the prepared workspace from the terminal after it is ready.
- **Open now** shows the host, opening account and opening time. Attach opens the existing shell. End previews and confirms a request to the terminal that opened that exact shell; it cannot end a replacement shell. The workspace remains kept.
- **Kept workspaces** shows each host’s published list, pin and deadline. Pin previews the host’s configured pin window. Stale, missing, unreadable and truncated publications are stated; none means an empty fleet.
- Fleet’s host page edits a credential-free SSH target and explicit executable/deployment paths. Download and inspect the file, then import it into the opener on the person’s computer. A link cannot enroll a host or change this config.
- **In this browser** is an off/proposed note linking #754. It opens no terminal, pty or WebSocket.

**Panels.** `p-sb-run`, `p-sb-new`, `p-sb-open`, `p-sb-kept`, `p-sb-browser`.

**The server provides.**
- Host-published kept workspaces with their identity, venue, deadline, pin, manifest generation and shell capability; a separate, credential-free host settings projection supports exact previews.
- Short-lived shell registrations renewed by the terminal process, with exact-incarnation End requests and acknowledgements. The console never asks Docker for this list.
- Durable bounded preparation/pin requests and results, separate from paid jobs and their run slots.
- Operator-only reads and preview/Confirm/audit writes. The private inventory and opener host configuration never join `/api/state` or viewer page data.

**Why it works this way.**
- The container boundary is the existing sandbox launcher, with read-only `/job`, a non-root user, no capabilities, no new privileges, resource limits and the host’s job network. The original run venue must support reopening; openshell and openshell-bind do not.
- A kept workspace holds issue text and stays on its host. Sweeping, pinning and idle logout keep their existing lifecycle rules. Retention defaults to 24 hours, pinning to seven days and idle logout to 30 minutes, but the screen reads the selected host’s actual configuration.
- A hostile page can only ask the locally configured opener to show a command that waits for Enter. No credentials or arbitrary executable string travel in the URI.
- The browser-terminal rejection remains while #754 / OQ-050 is open.

**Fixture note.** The pictured hosts, runs, paths, image tag and times are sample data. Its 24-hour retention and seven-day pin are the sample host’s settings. The implementation reads real publications and reports exceptional states instead of substituting these values.
