A completed run's page with a shell open on its kept workspace. The run page says who is in the workspace, how to open it, and where a finding goes, so what one person learns in the shell reaches the next run.

**How a person uses it.**
- **The outcome** says merges are never automatic, and offers *Try it in its workspace* beside the pull request. Trying a change before merging it is the main reason to open a run's workspace.
- **Workspace** (`p-workspace`):
  - where it is kept and for how long, and what opens: the run's image and files, a job's isolation and network, no credentials;
  - **who is in it now**: ops opened a shell in a terminal at 15:20 UTC. Opening it again, in a browser or a terminal, joins that same shell, so two people would type into one prompt;
  - Open in browser (#754's, offered because a shell is open), Open in Terminal, Copy the command, and Preview End. With no shell open, the panel offers Open in Terminal first (RunWorkspaceStates draws that).
- **What you found** (`p-found`), shown once a shell has been opened on this run. Three ways to keep a finding:
  - *Tell the next runs*: add a sentence to trigger 3's instructions, through the usual preview and Confirm;
  - *Tell this run's agent*: fork from its last saved point with a message (paid, #648);
  - *Push it yourself*: from the shell after `gh auth login`.
  - Then one line: nothing typed in the shell reaches this run or the next one, only what is written here.
- The run's facts, Actions (re-run, terminal chat) and the side column (tokens and dollars, resources, session, chain) are RunEnded's.

**Panels.** `p-outcome`, `p-workspace`, `p-found`, `p-run`, `p-actions`, `p-cost`, `p-resources`, `p-session`, `p-chain`.

**The server provides.**
- **Today:** whether the workspace was kept, until when, and why not where it was not (the run page's sandbox check); the shells open now, with who opened each and when (the sandbox registry, #771); whether a browser holds the one attachment (the gateway's exclusive window, #754); the gateway's enrollment per host.
- **New:** whether a shell was ever opened on this run, so *What you found* shows only then. The instructions edit is the existing trigger edit with its preview and Confirm; the fork is #648's.

**Who sees what.** Operator only, like the Sandboxes tab: a viewer's run page has no Workspace or What you found panel.

**Why it works this way.**
- **The terminal is for checking a result and finding a cause,** not for finishing the agent's work by hand. A finding that stays in one person's shell helps once; a sentence in the trigger's instructions helps every later run, which is how runs come to need nobody (Zero touch).
- **Who is in it, on the run page.** A native terminal and the browser can attach to the same shell at once, so a second person would type into the first one's prompt. The page says so before anyone opens it.
- **No new authority.** Every control here exists today: Open in Terminal, copy, End, the trigger edit and the fork. The browser still only attaches to a shell that is open.

**Fixture note.** gh-9575, acme/web#490, fix on mini1, local, ended 15:12 UTC, trigger 3 and the tokens are the fixture, as on RunEnded. Sample: the shell ops opened at 15:20 UTC (as on SandboxesScreen) and the sentence in the instructions box.
