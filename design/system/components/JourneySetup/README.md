A guide card: setting up a new deployment, from the one command in a terminal to the first run on Runs. Each step is a thumbnail of the real card it comes from, with that screen's design status.

**How a person uses it.**
- Read the five steps in order:
  1. the one command;
  2. Getting ready, run from the page;
  3. the first trigger and its preview;
  4. the first run on the Overview;
  5. its result on Runs.
- Under each step, the next line says who moves it on: *you* or *pi-dispatch*.
- The ribbon on each step says whether that screen is built, planned or proposed, and its issue. Supported browser setup is built by PR #784 (#774); GitHub App creation remains open.

**Panels.** The strip of steps (`j-strip`); there are no console panels on a guide card.

**Fixture note.** The thumbnails are cut from the named cards each time `gen_journeys.py` runs, by panel (`#p-setup-start`, `#p-setup`, `#p-trigger-preview`, `#p-active`, `#p-runs` around gh-9575's row), in both themes. The first run shown is gh-9575, the run those cards draw.
