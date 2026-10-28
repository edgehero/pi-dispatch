Fleet is where an operator keeps the fleet healthy and unsticks the queue: the kill switch, queues, active, held and failed jobs, hosts, doctor results, venues and schedules.

**How a person uses it.**
- **The fleet bar.** It says in one line whether the fleet runs and how many jobs wait, run, are delayed, held or await retry. *Pause the fleet* is the kill switch. It is outlined in red, and its preview opens under it, naming every queue, what keeps running, the Valkey address and the undo ("Resume the fleet"), with a ticket that expires in 5 minutes. Only the confirm button is filled red.
- **Queues.** Each queue's state with waiting, active, delayed, paused and failed counts, and a Pause per queue.
- **Active jobs.** Every running job with its project, target, host, start, run time and progress (phases or turns where reported, stripes where the worker reports none). An orphaned hold such as gh-4a7e is flagged in yellow with what it costs ("build3 runs 1 job where it could run 2") and *Free the slot*.
- **Held.** Each held job with its conditions as a checklist (time, CI green) and whether each is met.
- **Failed jobs.** The reason sentence and next step inline; Retry is a paid act (amber outline), Remove is destructive (red outline); both also come in bulk.
- **Hosts.** Slots as dots, memory in GiB and CPU in cores as bars, heartbeat (late beyond 1 minute), venues and routes.
- **Doctor.** Failing, warning and passing counts per host, each check with its fix; a stale result is flagged; a host with no result says how to get one.
- **Venues.** One row per venue: where it is blessed and the default, two of its properties (egress, local folders) as enforced, asserted or absent, what it serves (steering, live transcript, recovery) as yes, no or with the image, and who holds the credentials. Each value is a word with a glyph, never colour alone. The footer names build3's floor and links to all 14 properties on the venue's own page.

**Panels.** `p-fleetbar`, `p-queues`, `p-active`, `p-held`, `p-failed`, `p-schedules`, `p-hosts`, `p-doctor`, `p-venues`.

**The server provides.**
- Queue counts per queue.
- Active jobs with project, target (once known), host, start and progress.
- Held jobs with each condition and its state.
- Failed jobs with attempts and the reason token, which the reason catalog turns into a sentence and next step.
- Per host: slots, memory and CPU (or none), last beat, venues and routes.
- Doctor results with version, age and checks.
- The venue table from the build, plus each host's published floor.
- Schedules with next run, overdue and stalls.

**Why it works this way.**
- The venue words are a closed set, and the table carries no legend: *enforced* means the worker makes it so and reads it back; *asserted* means someone else provides it and the worker cannot check; *absent* means it is not offered.
- *With the image* means a venue serves the feature only when the job image supports it.
- The venue table is what each host's worker published when it started; nothing in it is read live.

**Fixture note.** Queues, active, held and failed jobs, hosts, doctor checks and schedules come from the fixture. These are sample data:
- the projects of gh-e802, gh-c41f and local-9e20;
- maxTurns 40 for gh-e802's turn bar;
- gh-5d10's reason sentence;
- the venue property values;
- mini2 blessing openshell-bind beside openshell, where RunSandboxed's run is;
- the `pi-dispatch doctor` command.
