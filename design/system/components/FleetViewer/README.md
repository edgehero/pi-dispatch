Fleet as a viewer sees it: whether the fleet runs, what is in its queues, what runs where, and each host's health. Nothing on it acts.

**How a person uses it.**
- **The fleet bar** says the fleet is running, with the waiting, active, delayed, held and awaiting-retry counts. There is no *Pause the fleet*.
- **Active jobs**, **Queues**, **Held**, **Failed jobs**, **Schedules**, **Hosts**, **Doctor** and **Venues**, read as on the operator's page.
- One line under the bar says what is the operator's.

**Panels.** `p-fleetbar`, `p-fl-viewer`, `p-active`, `p-queues`, `p-held`, `p-failed`, `p-schedules`, `p-hosts`, `p-doctor`, `p-venues`.

**Who sees what.** Left out for a viewer:
- every action: *Pause the fleet*, each queue's *Pause*, *Cancel*, *Free the slot*, *Cancel all held*, *Retry*, *Remove* and their bulk forms, and each host's pause;
- the Valkey address (the bar says "Valkey answers", as the overview's first run does);
- a failed job's reason and next step (`failedReason` is the operator's, in a detail view only);
- a held job's check name (the waiting reason is said in the worker's vocabulary, as on the overview);
- the doctor checks' text and fixes, which name paths and settings; the counts and the stale warning stay.

**Fixture note.** The same fixture as FleetScreen: queues, active, held and failed jobs, hosts, doctor counts, venues and schedules.
