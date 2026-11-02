The run page's Workspace panel for each kind of run: where a kept workspace opens, what the page says when there is nothing to open, and *Prepare from this run* when the workspace cannot reopen.

**How a person uses it.**
- **Completed** (gh-4add): *Try it before you merge*. Open in Terminal first, with the command to copy. Open in browser appears only once a shell is open, because the browser attaches and never starts one.
- **Failed, workspace kept** (gh-d40e, out of memory): *Reproduce it in its workspace*. The reason leads, and the panel says the shell gets the run's memory limit, so the same command stops the same way.
- **Awaiting input** (gh-2f6a): *Look before you answer*. The answer starts a new job from the saved transcript, so the panel says that nothing changed in the shell reaches it, and to put the finding in the answer. A link goes back to the answer box.
- **Cannot reopen** (gh-a91e, on openshell): *Prepare from this run*. #771's preparation filled in from the run: the repository, its pull request as the starting point, the trigger it ran as, and a host where that trigger's runs go. It says it is a fresh clone of what the run pushed, not the run's own files. The same panel shows once a workspace is swept or past its window.
- **Failed before it started** (gh-f0c2) and **refused** (gh-e9a0): *Nothing to open*, with the reason in one line.
- **Running** (gh-b3d7): *Steer it instead*. Its workspace opens once it ends.

**Panels.** `p-workspace`, once per run page.

**The server provides.** The run page's sandbox check (kept, until when, or why not), the run's venue and whether it can reopen, the open shells, and for *Prepare from this run* the run's repository, its trigger and the pull request it opened where the record holds one. Without a pull request the preparation starts from the default branch.

**Who sees what.** Operator only. A viewer's run page has no Workspace panel.

**Why it works this way.**
- **One panel, one place.** The workspace sits on the run page because that is where a person decides what to do next, as CI tools put their debug shell on the job page.
- **Parked runs say what the shell cannot do.** The answer resumes from the transcript in a new job, so an edit in the shell would be lost without a word.
- **No terminal in a running job.** Its container holds the job's own token and spends from its reservation. Steering is the way to change a running run.
- **Prepare from this run** keeps a pull request reviewable after its workspace is gone. Workspaces are kept 24 hours by default; a review often takes longer.

**Fixture note.** From the fixture: gh-4add, gh-2f6a, gh-a91e, gh-f0c2, gh-e9a0 and gh-b3d7 with their targets, flows, hosts and venues, and the catalog sentences for the out-of-memory stop and a container that never started. Sample: gh-d40e (an out-of-memory stop on acme/web#484 at 09:12 UTC, added to `fixture.py` as a proposed run), the 2,048 MiB limit, the times left, and gh-a91e's pull request `pr:526`.
