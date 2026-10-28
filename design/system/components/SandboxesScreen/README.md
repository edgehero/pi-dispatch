The Sandboxes tab on Runs. It opens a shell next to a run's kept workspace, or prepares a fresh one for a repository with no run behind it. Either way the shell gets the job image and a job's isolation, with no credentials and no agent. The person does the typing.

**How a person uses it.**
- **From a run.**
  - Pick a finished run that is still kept (here `gh-9575`), and see what opens:
    - the image its manifest records;
    - the clone it worked in, with `/job` read only;
    - no processes and no credentials;
    - a job's network.
  - Then choose how it opens:
    - *In your terminal* (recommended). The console fires a `pi-dispatch-open://` link. The opener on this computer, installed once with `pi-dispatch opener install`, opens the terminal with `pi-dispatch sandbox gh-9575` typed in, through `ssh -t mini1` when the workspace is on another host. It waits for Enter.
    - *Copy the command.* The same command for the host, and the `ssh -t` form for another computer.
    - *In this browser.* Shown as off, with a link to the proposal.
  - *Pin for 7 days* is the console form of `--pin`.
  - A port on the host is refused while egress is on, as the CLI refuses `--publish`.
- **Without a run.** Choose:
  - a repository, and the trigger whose jobs it should look like (its image, size and egress, since a project's triggers can differ);
  - where to start: a branch (the default branch unless changed), a pull request, or a commit or tag;
  - one of the hosts where that trigger's runs may go;
  - how long to keep it.

  The image, size, network and the no-credentials rule come from the trigger and are shown, not chosen. *Prepare sandbox* is a safe write with a preview:
  - The worker clones the repository with a read-only token for that one repository, and drops the token. No container starts: the console never starts one, and the shell starts when the person opens it from their terminal.
  - It costs no dollars and takes no run slot.
  - The sandbox shows up as `sb-3c1f` and opens like a run's. The CLI form is `pi-dispatch sandbox --new acme/web --ref main --as 3`.
- **Open now.** The sandboxes with a shell running: where, who opened them and since when (not how idle: the CLI hands the terminal straight to docker and never sees what is typed), with *Open in Terminal* (attach) and *End*. One sandbox per run at a time.
- **Kept workspaces.** What can still open, with the time left or the pin. A run from openshell-bind is listed as not reopenable, because that venue has no sandbox shell.
- **In this browser** (proposed, off). A preview of the terminal tab it would open, marked *Needs a decision*, with a link to #754.

**Panels.** `p-sb-run`, `p-sb-new`, `p-sb-open`, `p-sb-kept`, `p-sb-browser`.

**The server provides.**
- **From today's record.** Kept runs with their deadline, pin, host, venue and whether they can reopen (`pi-dispatch sandbox --list`), and the egress posture of each host.
- **New.**
  - A sandbox with no run: an `sb-` id, made by a safe write. The worker clones it, keeps it and sweeps it like a run's.
  - The list of open sandbox shells, with who opened each and how idle it is. The `pi-dispatch sandbox` that opened a shell registers it in Valkey with a short expiry it renews while the shell is open, so the console reads the list without asking docker. *End* writes a request that process polls, the way a cancel works.
  - Kept workspaces for every host, which each worker publishes the way it publishes its doctor results. Today the console reads a run's sandbox manifest for its own host only.
  - An SSH target per host in Fleet, and a remote command that loads the deployment's sandbox settings (the CLI reads them from its own environment, which an SSH command usually lacks).
  - The `pi-dispatch-open://` opener. The link holds no secret. The opener only builds commands from a fixed list (`sandbox`, `sandbox --new`) with ids and host names it checks, and shows the command before it runs. So a page that fires the link can at most show a prompt the person declines.
- **Proposed, not planned.** The sandbox gateway for the browser terminal.

**Who sees what.** The whole tab is operator only. A kept workspace holds issue text, and every control here opens a shell. A viewer does not see the Sandboxes tab.

**Why it works this way.**
- **What a sandbox is.** The run's exact image (or, for a prepared one, the image of the trigger it was prepared as), a job's isolation (no capabilities, no new privileges, its limits, not root) and a job's network: the egress allowlist, or the open bridge where egress is off.
- **No credentials.** On purpose. `gh auth login` is in the image for a person who wants to push as themself.
- **Idle logout.** After 30 minutes (`PI_SANDBOX_IDLE_MINUTES`).
- **It needs a real terminal.** From a pipe or CI it refuses.
- **Not on every venue.** openshell runs, and runs from a venue this host does not run, cannot reopen.
- **Kept workspaces stay on the host.** They hold issue text. A run's workspace is kept 24 hours after it ends (`PI_SANDBOX_RETENTION_HOURS`).
- **One sandbox per run at a time.** Opening a second points at the one running. *End* asks the terminal that opened it to close the shell.
- **The console never starts a container.** A prepared sandbox starts when the person opens it from their terminal.
- **Why the browser terminal is off.** specs/design.md rejected a terminal in the browser (#642), and WebSockets for the console (#641), which a terminal needs: a pty and a two way channel in the process that holds operator power is an interactive shell one stolen session away from anyone.
- **What turning it on would take** (#754, OQ-050):
  - a separate sandbox gateway process on the host, in its own tab at its own address, so the console keeps its CSP and gets no pty or WebSocket;
  - it only attaches to a `pi-sandbox` container the console gave it a ticket for;
  - one ticket per open, good once, for 60 seconds, for one operator session, after signing in again;
  - off by default, operator only, one window per sandbox, never on a phone; what is typed is not recorded, and opening and ending are audited;
  - the real cost: it still talks to Docker, which is root on that host.

**Fixture note.** Proposed in issue #753 (REQ-SANDBOX-FROM-THE-CONSOLE); the browser terminal is #754 (OQ-050). Sample: `sb-3c1f`, the open shells, the times left, the opener, the SSH target and the gateway. The `pi-dispatch sandbox` commands and flags, the 24 hour window, the 7 day pin, the 30 minute idle logout, the publish refusal, the one-sandbox-per-run rule and the openshell exception are the repo's (docs/sandbox.md). So is the rejection quoted from specs/design.md.
