The top line of each run's Loaded card, run by run, and the two places the same record is repeated: a sandbox and a trigger.

**How a person uses it.**
- **Everything loaded** (gh-9575): one green line, nothing to do.
- **Left out, as the trigger asks** (gh-8251-r2): trigger 2 removes bash and withholds the staged packages. Still green: what a trigger turns off is not a problem.
- **Ran without its flow** (gh-03a9): the trigger names fix, and neither the repository at its base commit nor a skills folder nor a staged package ships it. *Open trigger 3*. The outcome says *Completed, without its flow*.
- **An extension failed to load** (gh-444c): one of the repository's own extensions threw while loading. *Open the base commit*, where it is fixed.
- **An MCP server did not connect** (gh-2f6a): *Open Connections*.
- **A host differs** (gh-ebd7): build3's overlay adds an extension the other hosts lack. *Open build3*.
- **Running** (gh-b3d7): shown when it ends, from its record.
- **No record** (gh-c3f8): an older release wrote it. **Refused** (gh-e9a0): nothing loaded.
- **In a sandbox,** What opens gains one row: what the run loaded, linked to it. A fresh sandbox says what its trigger would load on that host now.
- **On a trigger,** each run field the record covers gains *Its last run*: what the trigger asks for, beside what its last run had.

**Panels.** `p-loaded`, `p-loaded-sandbox`, `p-loaded-trigger`.

**The server provides.** The run record's new `loaded` field (RunLoaded). For a fresh sandbox, what the host's overlay and staged packages hold now, which the doctor record already carries. For a trigger, its last run's record.

**Who sees what.** As RunLoaded: viewers see the lines; the buttons are operator actions.

**Why it works this way.**
- **The problem goes where the next step is.** A missing flow is fixed on the trigger or in the repository, an MCP server in Connections, a host's overlay on its host page.
- **The outcome says it too,** so a run list read at a glance does not show a run that lacked its flow as plainly completed.
- **Shown when it ends.** The record is written from the exit line; a live line would need the worker to trust a second line during the run.

**Fixture note.** From the fixture: every run with its outcome and host (gh-8251-r2, gh-03a9 and gh-444c on mini2, gh-2f6a and gh-b3d7 on mini1, gh-ebd7 and gh-c3f8 on build3). Sample: trigger 2's removed bash and withheld packages, acme/api's missing fix skill and failed extension, linear as trigger 7's MCP server and its timeout, and build3's overlay extension git-guard (as on ProjectLoads).
