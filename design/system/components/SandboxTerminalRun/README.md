The gateway's terminal tab when it knows its run: the run in one line under the title, and the way back to it.

**How a person uses it.**
- **The title** names the sandbox and its host; the line under it says the run's outcome, project, target, flow and when it ended.
- **The terminal** is SandboxTerminal's: one attachment, idle logout, Disconnect, nothing recorded, only new output.
- **Back to gh-9575** in the header replaces the generic return, and the line under the terminal says where a finding goes: the run's page, where the next run sees it.
- On a phone, no terminal opens, as on SandboxTerminal; the tab sends the person back to gh-9575 to copy the command.

**Panels.** `p-gateway-run`, `p-gateway-terminal`.

**The server provides.** The console adds the run's id, outcome, project, target, flow and end time to the one-use grant it already makes, and the gateway shows them only after authorization. They are run record facts: no transcript, question or issue text crosses.

**Who sees what.** The operator who opened it, as on SandboxTerminal.

**Why it works this way.** A prompt says only `gh-9575`; the run's target and outcome say whether this is the change about to be merged or a run that failed. The way back goes to the run, because the next useful step after a look is there.

**Fixture note.** gh-9575 and its facts are the fixture. Sample: the terminal output and the commit line.
