A guide card: what happens when a run stops to ask a question, step by step, from the Overview to Zero touch. Each step is a thumbnail of the real card it comes from, with that screen's design status.

**How a person uses it.**
- Read the six steps in order:
  1. Overview's Needs you;
  2. the Parked card with a draft ready;
  3. the run page with the answer box;
  4. the answer's preview;
  5. the run carrying on;
  6. Zero touch counting the answer.
- Under each step, the next line says who moves it on: *you* (an action on the screen), *pi-dispatch* (what the system does next), or *or* (another route).
- The ribbon on each step says whether that screen is built, planned or proposed, and its issue. Open the named card for the full screen.

**Panels.** The strip of steps (`j-strip`); there are no console panels on a guide card.

**Fixture note.** The thumbnails are cut from the named cards each time `gen_journeys.py` runs, by panel (`#p-needs`, `#p-drafted`, `#p-chat`, `#p-chat .confirm`, `#p-progress`, `#p-zt-handled`), in both themes. The steps follow gh-2f6a's question; the draft step and the live step show gh-6e1d and gh-b3d7, the runs those cards draw.
