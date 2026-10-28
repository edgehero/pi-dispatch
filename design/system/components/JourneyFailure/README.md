A guide card: what a person does when a run is refused or goes wrong. Find out why, fix the cause, re-run it, or open what it built. Each step is a thumbnail of the real card it comes from, with that screen's design status.

**How a person uses it.**
- Read the five steps in order:
  1. the refused row on Runs;
  2. the run page's outcome;
  3. the egress proxy that is missing on build3, on Connections;
  4. the re-run preview;
  5. the other route: open a run's workspace in your terminal.
- Under each step, the next line says who moves it on: *you*, *pi-dispatch*, or *or* for the other route.
- The ribbon on each step says whether that screen is built, planned or proposed, and its issue.

**Panels.** The strip of steps (`j-strip`); there are no console panels on a guide card.

**Fixture note.** The thumbnails are cut from the named cards each time `gen_journeys.py` runs, by panel (`#p-runs` around gh-e9a0's row, `#p-outcome`, `#p-egress` around build3's row, `#p-actions .confirm`, `#p-sb-run`), in both themes. The refusal is gh-e9a0's; the re-run preview and the workspace are gh-9575's, the run those cards draw.
