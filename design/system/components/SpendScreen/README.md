Spend shows money and tokens against every cap, where they went, and what the same work would cost on another model.

**How a person uses it.**
- **Views.** A tab row under the title switches between Spend (this view), Budget split, Capacity, Breakdown and the Flows map. They are links, and the current one is filled.
- **Range and project.** The range (7 days, 30 days, month to date) and the project chips scope everything below.
- **Four big numbers:** this week against its cap; today against its cap, split into metered and held; tokens today; and the average cost per run.
- **Spend over time.** Daily bars against the $25.00 daily cap and its $20.00 soft hold. Today's bar shows the money held for running jobs as a dashed top: it is released when they settle.
- **Where it went.** Cost by flow, by model and by project, in one hue with values written out.
- **Job sizes.** A histogram of cost per run against the $2.00 job cap, with how much the largest run used.
- **Right column:**
  - *Caps*: every window, with the 80% tick;
  - *What if*: pick another model and see the same runs' estimated cost;
  - *Metered and plan*: claude-sonnet-5-5 per run, kimi-for-coding on plan:kimi;
  - *Budget split*: written weekly by pm-weekly, with who wrote it and when.

**Panels.** `p-week`, `p-today`, `p-tokens`, `p-avg`, `p-over`, `p-byflow`, `p-bymodel`, `p-byproject`, `p-sizes`, `p-caps`, `p-whatif`, `p-plan`, `p-split`.

**The server provides.**
- Per-day metered and held totals.
- The cap windows with spent and held amounts.
- Cost and tokens per run, with flow, model and project.
- The budget split file.
- For the what-if: the runs' token counts and the chosen model's list price. Charts are inline SVG with percent widths, so they stretch from 390 to 1440.

**Why it works this way.**
- Every run reserves the whole job cap before it starts, so a lower `maxCostUsd` holds less money while jobs run. The job sizes chart is there to show how far below the cap runs really land.
- The budget split is weights only: it never changes a cap.
- The what-if is an estimate from token counts and list prices. Outcomes may differ, because a cheaper model can take more turns or fail more often, which is why the screen points at a canary in Models.
- Plan runs count against the job and token caps, never the dollar windows.

**Fixture note.**
- **From the fixture:** the caps, today's $15.04 and the week's $33.07. Today's $5.23 metered and Wednesday's $5.25 are sums of the Runs list; the held $9.81 is the difference.
- **Computed from the Runs list:** cost by flow, model and project, and the job sizes, over the 46 metered runs listed since Tue 6 Oct, 15:11 UTC.
- **Sample:**
  - the daily bars for Fri 2 to Tue 6 (Mon and Tue add up to the week total);
  - the claude-haiku-5-5 run, the budget-split percentages and the other projects' used amounts;
  - the what-if estimate of $1.90.
