The gateway's terminal tab when it knows its run: the run's facts above the shell, and the way back to the run instead of a generic return page.

**How a person uses it.**
- **The run** (`p-gateway-run`) says what the shell belongs to: gh-9575, Completed, acme/web#490 in `web`, flow fix from trigger 3, ended 15:12 UTC after 22m, mini1 local, kept until 15:12 UTC tomorrow, and that the pull request was opened and merging is the person's.
- **The terminal** is SandboxTerminal's: one attachment, idle logout, Disconnect, nothing recorded, only new output.
- **When you are done** (`p-gateway-next`): one line on where a finding goes, and **Back to gh-9575**, which opens the run page with its *What you found* panel. The header's return link goes to the run too.
- On a phone, no terminal opens, as on SandboxTerminal; the tab sends the person back to gh-9575 to copy the command.

**Panels.** `p-gateway-run`, `p-gateway-terminal`, `p-gateway-next`.

**The server provides.** The console adds the run's id, outcome, target, project, flow, trigger, host, venue, end time and keep-until to the one-use server-side grant, and the gateway shows them only after authorization. They are run record facts: no transcript text, question or issue text crosses.

**Who sees what.** The operator who opened it, as on SandboxTerminal.

**Why it works this way.**
- **Know what you type into.** A shell prompt says only `gh-9575`. The run's target and outcome say whether this is the change about to be merged or a run that failed.
- **Back to the run, not to the console.** The next useful thing after a look is on the run page: the finding, a fork or End.
- **Record facts only.** The gateway stays a separate origin with a narrow job. It gets no new read of its own: the facts ride in the grant the console already makes.

**Fixture note.** gh-9575 and its facts are the fixture. Sample: the terminal output and the commit line.
