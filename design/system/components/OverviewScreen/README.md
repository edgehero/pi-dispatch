The Overview with problems: what needs you, what is in line and what each waiting job waits for, runs by project on a timeline, caps and hosts.

**How a person uses it.**
- **Big numbers.** Four cards answer the first questions: *Needs you* (1 question, 3 to fix, each with its project and one action), *In line* (5 jobs waiting to start, by reason), *Running* (4 in 5 of 9 slots, slot dots per host, the held slot called out) and *Spend today* ($15.04 of $25.00 with metered spend per hour).
- **Runs by project.** Left of the now line is what ran; right of the now line is what is in line, as dashed pills on the row of what blocks them:
  - an arrow means "after this run" or "needs this slot";
  - a dotted gap means a delay.
- **Waitlists.** The same waiting jobs grouped by reason, each with one action, plus every queue's count and what is scheduled next.
- **Caps.** Capsules with the 80% soft hold.
- **Hosts.** Heartbeat, doctor, queue counts, a pause per host, and Pause fleet.

**Panels.** `p-needs`, `p-waiting`, `p-active`, `p-spend`, `p-timeline`, `p-waitlists`, `p-caps`, `p-hosts`.

**The server provides.**
- Per run: project, target, host, start, end and outcome.
- Per waiting job: project, reason, and the blocker or due time.
- Queue counts, cap windows, host heartbeats and doctor summaries.

**Fixture note.** Counts, runs, caps and hosts come from the 2026-10-08 fixture. The waiting jobs gh-c9e1, gh-d4f0, gh-71b2 and gh-38aa are sample jobs that show each kind of wait. Clip durations of completed runs are estimated from their end times. The projects of gh-e802 (billing) and local-9e20 (ops) are assumed.
