The page of a finished run leads with its outcome, what happened and the next step, then the facts, costs and resources, with the actions to run it again or continue it.

**How a person uses it.** Beside the run's id stands its short link, `/run/acme/web/490`, which opens the newest run on that issue; on the page of an older run it leads to the later one. The outcome banner says "Completed: finished in 22m on mini1" and reminds the reader that merges are never automatic. Its buttons open the issue and preview a re-run. *Run* lists the record's facts in plain words: trigger, turns against maxTurns, attempt, exit code and recovery. *Actions* explains each next step in a sentence:
- **Preview a re-run** (paid). Its confirm bar is shown open with the reservation against today's cap and an undo line.
- **Preview a fork** (paid) selects a saved entry boundary and optional provider, permitted model, thinking level and follow-up message. Its preview names the reservation and independent branch. Unavailable source state is named.
- **Terminal chat** and **sandbox** commands copy with one click.

*Artifacts* lists the files the job left in `/artifacts` (issue #920): each name opens it, an image is drawn small under its name, text opens as text (and says when the job's secrets were cleaned from it), anything else downloads. A file that was not kept is one line with its reason, and the note says when the files go. A viewer sees this panel too. When the files are gone it says they were removed after the retention of the host that kept them. Files another host keeps are read from that host and linked through it, and the note names it; when that host cannot be asked now, the card names it and says why (not running, no answer in time or an earlier version, or busy sending other files). A run that kept and dropped nothing has no panel.

The side column has tokens and dollars (job cap as a bar with the soft-hold line), resources (peak memory against the size given), session and plan, and the chain as one line.

**Panels.** `p-outcome`, `p-run`, `p-artifacts`, `p-actions`, `p-cost`, `p-resources`, `p-session`, `p-chain`.

**The server provides.** The run record: facts, outcome, reason and next-step sentences from the catalog, tokens, cost class and reservation, resource figures, session state in words (not raw tokens such as "fresh (absent)"), chain, whether a workspace was kept, and the run's artifacts: the record's counts and, from the artifacts store of the host that kept them (this host's, or another's over its artifacts channel), each kept file's name, size, kind and whether it was cleaned, what was dropped by reason and when the files go (or that they expired, or why another host could not be asked). It also says whether a re-run is allowed, so the button is hidden or disabled with its reason when the planner would refuse it. The short link is built from the record's forge target.

**Fixture note.** gh-9575's target, flow, host, venue, model, tokens, cost, cap and end time are the fixture. The start time (14:50), turns, trigger, token split, model calls, resources, session wording and transcript size are sample values.
