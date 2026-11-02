The run page's Workspace row for each kind of run, as one table: the outcome, the one line the page says, and the one button.

**How a person uses it.**
- **Completed** (gh-4add): *Try it before you merge*, with Open in Terminal.
- **Shared** (gh-9575, as another operator sees it): *lee is driving, and lets operators watch*, with **Watch** (observer mode, #792). Watching is read only; SandboxWatch draws the watcher's tab.
- **Failed, kept** (gh-d40e, out of memory): *Reproduce it*. The shell uses the run's recorded memory limit; reproduction is not guaranteed.
- **Awaiting input** (gh-2f6a): *Look before you answer*. The answer starts a new job from the saved transcript, so a change in the shell does not reach it; the finding goes in the answer.
- **Cannot reopen** (gh-a91e, on openshell): *Prepare from this run*, which opens #771's preparation filled in from the run: its verified repository, HEAD and an explicitly chosen compatible trigger and host. The same row shows once the host confirms a workspace is swept or past its window. Unreadable remote retention remains unknown, never inferred as swept.
- **Running** (gh-b3d7): *Opens when it ends*, with Steer this run.
- **Nothing to open** for a run whose container never started (gh-f0c2) or that was refused (gh-e9a0): no button.

Open in browser joins these buttons only once a shell is open, as on RunWorkspace.

**Panels.** `p-workspace`, once per run page.

**The server provides.** The run page's sandbox check (kept, until when, or why not) and the run's venue. *Prepare from this run* also needs the verified repository. It starts from HEAD and requires an explicit compatible trigger and host; a historical trigger index or issue target is not pull-request attribution.

**Who sees what.** Operator only. A viewer's run page has no Workspace panel.

**Why it works this way.**
- **The run page is where the next step is decided,** as CI tools put their debug shell on the job page.
- **A parked run says what the shell cannot do,** or an edit made there would be lost without a word.
- **No terminal in a running job.** Its container holds the job's own token and spends from its reservation; steering is the way to change a running run.
- **Prepare from this run** keeps a pull request checkable after its workspace is gone: workspaces are kept 24 hours by default, and a review often takes longer.

**Fixture note.** From the fixture: gh-4add, gh-9575, gh-2f6a, gh-a91e, gh-b3d7, gh-f0c2 and gh-e9a0 with their outcomes and venues. Sample: gh-d40e, an out-of-memory stop on acme/web#484 at 09:12 UTC, added to `fixture.py`.
