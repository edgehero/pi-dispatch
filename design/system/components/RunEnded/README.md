The page of a finished run leads with its outcome, what happened and the next step, then the facts, costs and resources, with the actions to run it again or continue it.

**How a person uses it.** The outcome banner says "Completed: finished in 22m on mini1" and reminds the reader that merges are never automatic. Its buttons open the issue and preview a re-run. *Run* lists the record's facts in plain words: trigger, turns against maxTurns, attempt, exit code and recovery. *Actions* explains each next step in a sentence:
- **Preview a re-run** (paid). Its confirm bar is shown open with the reservation against today's cap and an undo line.
- **Fork from a point** links to the fork view.
- **Terminal chat** and **sandbox** commands copy with one click.

The side column has tokens and dollars (job cap as a bar with the soft-hold line), resources (peak memory against the size given), session and plan, and the chain as one line.

**Panels.** `p-outcome`, `p-run`, `p-actions`, `p-cost`, `p-resources`, `p-session`, `p-chain`.

**The server provides.** The run record: facts, outcome, reason and next-step sentences from the catalog, tokens, cost class and reservation, resource figures, session state in words (not raw tokens such as "fresh (absent)"), chain, and whether a workspace was kept. It also says whether a re-run is allowed, so the button is hidden or disabled with its reason when the planner would refuse it.

**Fixture note.** gh-9575's target, flow, host, venue, model, tokens, cost, cap and end time are the fixture. The start time (14:50), turns, trigger, token split, model calls, resources, session wording and transcript size are sample values.
