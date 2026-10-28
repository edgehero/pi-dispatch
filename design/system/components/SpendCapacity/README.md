Capacity shows how busy each host was, how full, how long jobs waited for a slot, and where there is no data, so a person can tell whether to add slots or move work.

**How a person uses it.**
- **Window.** 24 hours, 7 days or 30 days. At 7 days each bar is one hour.
- **Four big numbers:** busy share of slot time across the fleet, the peak, the wait for a slot (p95 and median), and promised memory at the busiest hour.
- **One card per host:**
  - busy, idle and no data as words with numbers;
  - a chart: the bar is jobs at once (average for the hour), the tick the most at once, the dashed line the slot count, hatching is no data and empty is idle;
  - facts: average and peak of the slots, how often full, promised memory and CPU, CPU used, wait for a slot, and projects by run time.
- **Always said:** "Jobs only: a machine busy with other work reads as idle."
- **Truncated history** is drawn hatched and named, never drawn as idle.
- **Right column:** how to read the chart, *Coverage* (runs counted, refused before a slot, retried, without a size, live runs not counted), and *Other states* (no time in this window yet, capacity not read, hosts not drawn past 20).
- The tab row under the title (Spend, Budget split, Capacity, Breakdown, Flows map) is shared by all five Spend views; the current one is filled. They are server-rendered links (`/insights`, `/insights/budget-split`, `/insights/capacity`, `/insights/breakdown`, `/insights/flows`, proposed routes) and on a phone the row scrolls inside itself.

**Viewers** see the same view; it holds no reasons and no actions.

**Panels.** `p-cap-busy`, `p-cap-peak`, `p-cap-wait`, `p-cap-mem`, `p-cap-build3`, `p-cap-mini1`, `p-cap-mini2`, `p-cap-key`, `p-cap-coverage`, `p-cap-states`.

**The server provides.** The capacity report per host: slots and budget, covered, missing, busy, idle and full time, peak, average, promised memory and CPU, CPU used, wait p50 and p95, projects by run time, buckets, and coverage. Every chart is inline SVG with percent positions; the hatch is an SVG pattern.

**Why it works this way.**
- The numbers come from the run mirror and this host's run records, never from the machine: a machine busy with other work reads as idle. The *Jobs only* banner says so on the page because it is the one misreading that would change a decision.
- Missing history is never idle. Where the run mirror holds nothing older for a host, that time is hatched and counted as neither busy nor idle, and the card names the gap.
- The peak is the most jobs at once in one hour with every host added up.
- The wait for a slot is measured from when a job could start to when it held a slot.
- Promised memory is what the running jobs were promised, as a share of every host's budget.

**Fixture note.** The hosts, venues and slot counts (build3 3, mini1 4, mini2 2) match Fleet. The hourly bars are sample data from a fixed seed, and the busy, idle, no-data, average, peak and full figures are computed from them. The promised memory and CPU, CPU used, waits, projects by run time, coverage counts and the two truncated histories are sample.
