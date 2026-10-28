The Runs page at 390px: the search stays visible and every other filter folds behind one Filters button, so the first screen is runs, not inputs.

**How a person uses it.** They search by repository, target or job id, or open Filters for the closed lists. The summary strip shows the four counts that matter. Each run is a stacked row:
- the job id and when it ended on top;
- the outcome badge and reason sentence across the full width;
- the target and project tag;
- the host and the cost.

Ids never break. Flow, venue, model, tokens and job cap are on the run page.

**Panels.** `p-filters`, `p-summary`, `p-runs`.

**The server provides.** The same data as the desktop page. The phone layout is CSS only (`tbl--stack`, `data-l` labels, `filterbar--collapsible`).

**Fixture note.** The same rows as RunsScreen.
