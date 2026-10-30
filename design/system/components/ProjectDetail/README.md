One project on its own page: what it spent against its share, its members, its job size against what its runs use, and the rows that govern it.

**How a person uses it.**
- **Big numbers.** Three cards answer the first questions:
  - this week's spend against the allocation share;
  - the last 24 hours of runs, with the worst one named;
  - the job size, flagged when the runs use far less.
- **Members.** Each member repository or folder, with its runs and last run. Editing an unbound project previews the projects file as a diff; joining counts from the next pickup, leaving widens what it may spend, and written records keep their project. Billing has a bundle, so its planner's refusal appears before any press and no edit form is drawn.
- **Job size.** Each run's peak memory as a dot against the size given (solid) and the suggestion (dashed); an out-of-memory kill would be a red dot. Visible GiB units and numeric/date axes keep readable screen-sized type on a phone as the SVG scales. Under the chart:
  - the memory and CPU verdicts in words;
  - the exact `dispatch_limit_edit` call, with Copy;
  - Preview this size, which goes through the normal confirm.
- **Recent runs.** The last five runs of the project, linked to Runs filtered to it.
- **Side.**
  - Allocation: weight, floor, share and the plan in force.
  - Limits: its scoped rows.
  - Secret bundle: variable names only.
  - The triggers that ran here.
  - Delete, which shows the planner's refusal while a limits row, bundle or envelope floor names the project, otherwise a red confirmed action.

A viewer sees the numbers, chart and facts, with no forms or Delete.

**Panels.** `p-proj-spend`, `p-proj-runs`, `p-proj-size`, `p-proj-members`, `p-proj-sizing`, `p-proj-recent`, `p-proj-alloc`, `p-proj-limits`, `p-proj-bundle`, `p-proj-triggers`, `p-proj-delete`.

**The server provides.**
- The project's members and runs.
- Spend and held amounts for the window, and the allocation share, weight, floor and plan.
- The scoped-limit rows that name it.
- Per-run peak memory and OOM kills for the last 30 days (at most 50), the size suggestion with its reason and call, and the CPU-ceiling figure.
- The bundle facts, and the reasons a delete would be refused.

**Why it works this way.**
- **Members.** Runs of a member record the project when a worker picks them up, and a record keeps the project it was written with.
- **Sizes are advisory.** Peaks are measured inside the jobs, and nothing changes until a person confirms the call.
- **Triggers.** Forge triggers fire on any member that sends events. A cron trigger runs here when its folder is a member.

**Fixture note.**
- **From the fixture:** the billing members, scoped limits row 2 (8 GiB, 4 CPUs) and the runs gh-e9a0, gh-ebd7, gl-9a2c, gh-7cdf and gh-4a7e.
- **Sample:** the spend and share, the weights and plan, the peaks and suggestion, the bundle, and the run counts per member. An unbound project provides the member edit and confirmed preview; billing's bundle refuses that edit.
