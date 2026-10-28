Budget split shows how the allocation envelope is shared between projects this week, which plan is in force and who wrote it, and lets an operator set priorities or go back to an earlier split.

**How a person uses it.**
- **Four big numbers:** the envelope ($120.00 per week, delegation on), what is allocated (with what is left unallocated), what was spent this week, and how long the plan in force has left.
- **Budget split.** One row per project: the allocation as an outlined bar, the spend (held included) as a solid bar, and the floor as a tick, with the amounts written out and "over" with a glyph when spend passes the allocation. Above the rows: the plan id, its writer, when it was applied, until when, whether the 25% step clamped it, and whether every host has the same envelope.
- **History.** Every plan any host recorded, newest first, numbered from 1 like every other list in the console. Each row has its writer (`operator-session`, `portfolio-job`, `operator-revert`, `envelope-change`), outcome with a glyph and word, refusal reason, and plan. **Revert** opens a safe confirm bar with what the old split was and that the envelope's rules still bound it.
- **Set priorities.** A weight per project (0 to 1000) and how many days the plan holds, previewed before anything is written.
- **Right column:** the *Envelope* (window, total, floors, default weights, delegation, step, interval, plan length, file by its last folder, digest per host), *Why the plan says so* (the portfolio job's reasons, agent text shown as written and escaped), *Refusals and plans* counted in this host's run records, and *Other states*.
- **Other states.** What the view says instead when the envelope changed outside the console, a host has another envelope, there is no envelope, no split exists yet, a newer pi-dispatch wrote it, or the queue did not answer.
- The tab row under the title (Spend, Budget split, Capacity, Breakdown, Flows map) is shared by all five Spend views; the current one is filled. They are server-rendered links (`/insights`, `/insights/budget-split`, `/insights/capacity`, `/insights/breakdown`, `/insights/flows`, proposed routes) and on a phone the row scrolls inside itself.

**Viewers** see the numbers, the bars and the history, but not the plan reasons, Revert, Set priorities or Edit envelope.

**Panels.** `p-env-kpi`, `p-alloc-kpi`, `p-spent-kpi`, `p-plan-kpi`, `p-split`, `p-split-history`, `p-priorities`, `p-envelope`, `p-plan-reasons`, `p-split-counts`, `p-split-states`.

**The server provides.**
- The envelope file and its digest per host.
- The applied split (`alloc:plan`) and its history (`alloc:log`, every host).
- Spend and held per project in the envelope's window.
- Refusal and plan counts from this host's run records.
- Plan reasons from the allocations log, operator role only.

**Why it works this way.**
- A project may spend up to the smaller of its allocation and its own scoped limit. A job refused by the split says `allocation-cap`; one refused by the project's own limit says `dollar-cap`, so the two are never confused.
- Floors come first, the rest is split by weight, and a change moves each share by at most 25% per step. That is why the plan in force says it was clamped by the 25% step.
- A new envelope re-bases the split with no step. A host whose envelope differs refuses its governed jobs until it has the new one, which is why the card says whether every host agrees.
- The plan's reasons are agent text. They are shown as written and escaped, never as markup, and to operators only.

**Fixture note.** The spend per project ($11.78, $14.20, $6.65, $0.44, together this week's $33.07), the $120.00 weekly cap, the 40/35/20/5 weights and the pm-weekly writer on Mon 5 Oct match the Spend view. These are sample: the envelope floors, plan ids, history rows, plan reasons, digests and every state banner.
