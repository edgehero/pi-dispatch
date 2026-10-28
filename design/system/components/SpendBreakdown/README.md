Breakdown shows settled spend from run records: per day, per flow over time, per trigger, repository and model, how plans compare with API rates, the what-if per flow, and where the numbers come from.

**How a person uses it.**
- **Four big numbers:** window spend (≥ when a run could not be fully priced), runs and how many are fully ledgered, plans declared, and the top flow.
- **Daily spend.** Solid is metered, a dashed top is estimated (~), a bar line marks a floor (≥), and a day with no runs is a hairline. Every value is written with its marks. Below it is the cumulative line, dashed from the first estimated day.
- **Daily spend by flow.** The top four flows on one shared scale, and what the rest add up to.
- **Breakdown.** By trigger, with the tail rows *chained*, *manual* and *unattributed*; by repository, with a *no project* bucket and local folders by their last folder; by model. A plan row shows `plan:<id>` instead of a dollar and a dashed bar for what it would cost at API rates. The *Last folder / Full paths* switch is the operator's opt-in for full local paths. Choosing a trigger selects its chip on the Flows map.
- **What if, per flow** (right column). A model and a flow give an estimate per run and for the window, with coverage and the rates' version. The other answers: an unknown model with the closest priced ids as links, and a flow with no ledgered runs as a seeded band.
- **Right column:** *Plans* (each subscription saving, losing, would save or would lose, as a glyph and words, or no baseline), the *What if, per flow*, and *Other states*.
- **The line under the tabs** names the spend window and the counts that limit it: unmetered runs, runs with no ledger that cannot be re-priced, drifted rates and truncated ledgers.
- The tab row under the title (Spend, Budget split, Capacity, Breakdown, Flows map) is shared by all five Spend views; the current one is filled. They are server-rendered links (`/insights`, `/insights/budget-split`, `/insights/capacity`, `/insights/breakdown`, `/insights/flows`, proposed routes) and on a phone the row scrolls inside itself.

**Viewers** see the same view with local paths always by last folder and no full-paths switch.

**Panels.** `p-bk-spend`, `p-bk-runs`, `p-bk-plans`, `p-bk-top`, `p-daily`, `p-daily-flow`, `p-breakdown`, `p-whatif-flow`, `p-plans`, `p-bk-states`.

**The server provides.** The cost fold for the window: daily totals with their money class, daily by flow, by flow, trigger, model, repository and project, plans with their verdicts, provenance (pi-ai pin, unmetered and unledgered counts), and the what-if answer. This view is drawn once per load; it is not live.

**Why it works this way.**
- **How money is shown.** Each amount carries its class, everywhere in the console:
  - `$4.12` metered: pi-ai computed the price;
  - `~$4.12` estimated: partly measured;
  - `plan:kimi`: covered by a subscription, never a dollar, so a plan is never shown as $0.00;
  - `$0 (unrated)`: a rate table priced it at zero;
  - `—`: unknown, not measured and not guessed;
  - `≥$4.12`: a floor, because the window holds spend the meter could not fully price;
  - `~~$4`: seeded, a band of $0.50 to $5.00 a run before any run of the flow is ledgered. The band narrows once one is.
- **Where the numbers come from.** Run records, re-priced with pi-ai's tables (1.0.3 here). Metered means pi-ai computed the price, not an invoice. Series are bounded by log retention and the 92-day scan cap. Money held for running jobs is not in run records yet; the Spend view shows it.
- **The what-if per flow** is the median of the flow's ledgered runs over the last 92 days, re-priced at the chosen model's rates.
- **Daily spend by flow** uses one scale for all four flows, so the bars compare.
- By flow and by project are on the Spend view, so this view does not repeat them.

**Fixture note.** The day totals for Fri 2 to Thu 8 and the flow names match the Spend view, and Thursday is today's metered $5.23 (held money is not in run records yet). The split by flow, trigger, repository and model, the run counts, the estimated and floor marks, the three plans and their verdicts, and the what-if answers are sample.
