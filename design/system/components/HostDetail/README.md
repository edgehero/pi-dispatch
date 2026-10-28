One host in full, opened from a host row on Fleet or Overview: is it alive, what it promised, what runs and waits on it, how busy it has been, and what doctor last said.

**How a person uses it.**
- **State first.** A stale host leads with a yellow card: no beat for 3 minutes, what that means for routing, and *Pause pi-jobs@build3* (danger). A healthy host shows no card here.
- **Jobs on build3.** Running, orphaned and waiting jobs with project and size.
  - An orphaned job is tinted and says what it still holds, with *Free the slot*.
  - A job waiting for the host budget says which dimension, that it asks again about every 9 seconds, and that it keeps its place.
- **Slots and budget.** Slot dots, then memory and CPU bars split into promised to running jobs (solid), held by an orphan (hatched) and free. Facts cover:
  - how the budget was set;
  - who waits for it, and the room kept for the oldest waiter;
  - project rules (`hostShare`, `minJobs`);
  - the CPU reserve;
  - whether old containers were listed.
  The words a budget can show instead are listed.
- **Last 7 days.** Busy, idle and no-history shares, average and peak slots, time full, and wait p50 and p95, then a 6-hour bar chart. Each bar has a tick at the most at once, a dashed slot line, and hatched no-history time, which counts as neither busy nor idle. It also shows promised and used shares, projects by run time, the "Jobs only" caveat and any truncation.
- **Registry row.** Version, start, image and digest, pi, time zone, queues, venues and floor, the profiles that route jobs here, the fingerprints that match the fleet, and the last beat.
- **Doctor.** The head line in the console's words, red when a check fails, then:
  - the stale warning;
  - 33 section chips (passing, failing, or not run);
  - failing then warning checks, each with its fix, and the command;
  - every other doctor state: replaced by a hand run, more than 8, all passing, unreadable, never published.

**Panels.** `p-hoststate`, `p-hostjobs`, `p-hostbudget`, `p-hostcap`, `p-hostrow`, `p-hostdoctor`.

**The server provides.**
- The host registry row: name, version, start, pid, concurrency, image and digest, pi version, time zone, caps, fingerprints, and budget used, held and waiters. It also carries the jobs list with sizes and orphan flags, the seed, and the beat time.
- The host's slice of the capacity report.
- The host's published doctor result, with checks redacted at the source.

**Viewers** see everything here except the Pause, Cancel and Free the slot buttons. Doctor results are visible to both roles.

**Fixture note.** build3, podman, the floor, the 3-minute late beat, gh-e802, gh-4a7e (cancelled 10:59), the 16 of 24 GiB and 8 of 12 cores, and doctor checks docker.39 and docker.40 come from the fixture. These are sample data:
- gh-91d2;
- the job sizes;
- pid, digest, pi version and profiles;
- the 7-day figures and chart;
- the sections that did not run;
- the hand-run uid.
