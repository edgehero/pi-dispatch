Observer mode (#792): another operator watches a browser shell, read only, when the person typing allows it. For pairing, review and teaching.

**How a person uses it.**
- On the run page or in Sandboxes, an operator sees *lee is driving, and lets operators watch* and **Watch**. It asks for their own token again, as opening does, and opens this tab.
- **The title** says whose shell and which run: Watching gh-9575, with the run's line under it.
- **The terminal** shows the same new output as the driver's, at the driver's size (120 × 36 here), with an internal scroll viewport when it does not fit. The toolbar says *Read only: you cannot type*. There is no Tab-focus switch and no Disconnect; **Stop watching** closes the tab's watch.
- Watching ends when the driver disconnects, turns watching off or removes the watcher, when the shell ends, or when the watcher's own session ends.
- On a phone, no terminal opens.

**Panels.** `p-gateway-run`, `p-gateway-watch`.

**The server provides.**
- A `watch` grant: one use, 60 seconds, after the watcher's fresh sign-in with their own token, for that exact sandbox, only while its driver allows watching.
- The driver's terminal size as it changes, and new output. No history, input or resize from a watcher.

**Who sees what.** Operators only, at most three at a time. A viewer, an agent and a read-only console cannot watch: terminal output can hold issue text and anything typed.

**Why it works this way.**
- **Read only by construction.** The watcher's attach has no input stream, and the gateway drops any input or resize a watcher sends before it reaches the runtime. The tab's read-only look is not what stops typing.
- **The driver decides.** A watcher sees what is typed, a pasted token included, so watching is off by default, turned on by the person typing, and every watcher is listed on their screen with Remove.
- **Audited, not recorded.** Each watch's start and end are audited with who watched whom. What is shown is not kept, as for the driver.
- **One driver.** A watcher never types. Two people typing into one prompt is what a native terminal joining a shell already allows; the browser does not add a second way.

**Fixture note.** gh-9575 and its facts are the fixture. Sample: lee as a second operator (added to `fixture.py`), the terminal output and the 120 × 36 size.
