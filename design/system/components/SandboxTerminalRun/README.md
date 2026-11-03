The gateway's terminal tab when it knows its run: the run in one line under the title, and the way back to it.

**How a person uses it.**
- **The title** names the sandbox and its host; the line under it says the run's outcome, project, target, flow and when it ended.
- **The terminal** uses the shared workbench: tabs and splits preserve the same attachment, driver idle logout, Disconnect, nothing recorded and only new output.
- **Back to gh-9575** in the header replaces the generic return, and the line under the terminal says where a finding goes: the run's page, where the next run sees it.
- **Let operators watch** (observer mode, #792), off by default. On, other operators can watch from the run page or Sandboxes. A line under the toolbar names each watcher with **Remove**, and says they see what is typed. Turning it off ends every watch at once.
- On a phone, no terminal opens. The console provides the native command; a generic arrival exposes no private run context.

**Panels.** `p-gateway-run`, `p-gateway-terminal`.

**The server provides.** The console adds the run's id, outcome, project, target, flow and end time to the one-use grant it already makes, and the gateway shows them only after authorization. They are run record facts: no transcript, question or issue text crosses.

**Who sees what.** The operator who opened it, as on SandboxTerminal.

**Why it works this way.**
- **Know what you type into.** A prompt says only `gh-9575`; the run's target and outcome say whether this is the change about to be merged or a run that failed. The way back goes to the run, because the next useful step after a look is there.
- **Watching is the driver's choice, and always on their screen.** A watcher sees everything the shell prints, including what is typed, such as a pasted token. So it is off until the person typing turns it on, and they see who watches.

**Fixture note.** gh-9575 and its facts are the fixture. Sample: the terminal output and the commit line, and lee watching.
