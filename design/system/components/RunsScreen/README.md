The Runs page lists every run that ended, newest first, with its outcome and the reason in one sentence, filtered by the closed lists people actually use.

**How a person uses it.** They narrow the list with the pills: project chips with counts, then Outcome, Reason, Flow, Trigger, Host, Venue, Forge and Model as closed lists, and one search pill for a repository, target or job id. Applied filters show as removable chips with Clear filters. The summary strip counts the window by outcome, and each count is a link that filters to it. In the table, completed runs are quiet: a grey badge and no sentence. Failed, refused, awaiting-input and cancelled runs carry their tone badge and a reason sentence with the shared prefixes. Only problems switches the table to those rows. Rows are grouped by day. Times are UTC.

**Panels.** `p-filters`, `p-summary`, `p-runs`.

**The server provides.** For each run record: when it ended, job id, target and forge link, project (from the projects config), flow, host, venue, outcome, the reason token turned into its catalog sentence, model, tokens, cost (or "not metered", or "plan:kimi") and job cap. It also provides counts per project and per outcome for the window, and pagination at 50 per page.

**Where the runs come from.** The footer names the source. The default is "read from 3 hosts through the fleet's run mirror". The other cases are the repo's notes:
- "Showing this host's runs: the fleet's run mirror is off."
- "Other hosts' runs could not be read; showing this host's."
- "Stopped after examining 2,000 runs; the next page continues from there."
- "The run history could not be read."
- "No run matches." (empty)
An unknown reason token shows as the token followed by "no explanation yet".

**Fixture note.** Rows are the fixture's runs list for the last 24 hours. The reason sentences come from the catalog style in #710. The cancelled sentence for gh-4a7e ("cancelled before the job spent anything") is sample copy. The fixture's run records put gh-e9a0 and gh-f0c2 in project api; this page follows the projects config instead (billing and web).
