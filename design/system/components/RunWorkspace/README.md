A completed run's page with a shell open on its kept workspace. One rule keeps it simple: the run page says one line about its workspace and offers one thing to do.

**How a person uses it.**
- **The outcome** offers *Try it in its workspace* beside the pull request, since trying a change before merging it is the main reason to open a run's workspace.
- **Workspace** (`p-workspace`) is one row: where it is kept and until when, who has a shell open (opening it joins that shell), and Open in browser or Open in Terminal. Copying the command and End fold under one line.
- **Found something?** One line with two links: add it to trigger 3's instructions (the usual trigger edit, with its preview and Confirm), or fork it with a message (#648).
- The run's facts, Actions and the side column are RunEnded's.

With no shell open, the row offers Open in Terminal; RunWorkspaceStates draws each outcome's row. On a phone the open buttons hide and the command is there to copy.

**Panels.** `p-outcome`, `p-workspace`, `p-run`, `p-actions`, `p-cost`, `p-resources`, `p-session`, `p-chain`.

**The server provides.** All of it today: whether the workspace was kept and until when (the run page's sandbox check), the shells open now with who opened each and when (#771's registry), and the gateway's enrollment (#754).

**Who sees what.** Operator only, like the Sandboxes tab. A viewer's run page has no Workspace panel.

**Why it works this way.**
- **One line, one button.** The run page is for deciding what to do next; the details of what a sandbox is live in Sandboxes and in this README.
- **Who has a shell open.** A terminal and the browser can attach to the same shell at once, so a second person would type into the first one's prompt. The row says so before anyone opens it.
- **Found something?** Nothing typed in the shell reaches this run or the next one. A sentence in the trigger's instructions does, which is how runs come to need nobody (Zero touch).
- **No new authority.** Every control exists today. The browser only attaches to a shell that is open; starting one from here is a separate decision.

**Fixture note.** gh-9575, acme/web#490, fix on mini1, local, ended 15:12 UTC and trigger 3 are the fixture, as on RunEnded. Sample: the shell ops opened at 15:20 UTC, as on SandboxesScreen.
