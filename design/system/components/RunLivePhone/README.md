The live run page laid out for a phone: what the run is doing now comes first, and the one action is Steer.

**How a person uses it.**
- **Progress.** The elapsed timecode, turn 7 of 40, 12 steps with 1 failed, the tool running now and for how long, phase 2 of 4 with 3 of 10 ticks, and the run's own note. The recent steps are left to the transcript below.
- **Spend so far.** $0.14 metered against the $2.00 job cap, as a bar with the soft-hold line, and what was reserved at the start.
- **Live transcript.** The newest two entries (the edit result and the bash call still running), with *Show all 10 entries* to open the rest.
- **Steer this run.** The steer box and **Preview steer**, the one solid button on the page, and the inbox in one line.
- **The run**: venue, host, model and start, with **Cancel run**, outlined until its confirm; then the run record's one line.

**Panels.** `p-progress`, `p-cost`, `p-transcript`, `p-chat`, `p-run`, `p-record` (one line).

**The server provides.** RunLive's reads, plus the run's metered spend so far, which the live run page does not show today (the design asks for a per-run spend so long runs read the same as short ones).

**Who sees what.** An operator's phone. A viewer's phone shows RunViewer's content: numbers and tool names, no transcript text and no Steer.

**Fixture note.** gh-b3d7, acme/web#415, fix on mini1, the progress and the transcript entries are the fixture, as on RunLive. The $0.14 spent so far is sample.
