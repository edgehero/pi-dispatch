Fleet on a phone. The question on a phone is "is it running, and is anything stuck", so the kill switch and the counts come first, and every list is one tap away.

**How a person uses it.**
- **The fleet bar**: whether the fleet runs, the waiting, active, delayed, held and retry counts, and *Pause the fleet* as the one action, outlined red as on desktop. Its preview opens under it, as on desktop.
- **Hosts** as compact rows: the lamp, the venues, the slots as dots, and the heartbeat age. A late heartbeat says so in words.
- **Active jobs**: each run's id, project, host and time running, with the orphaned hold flagged.
- **Queues and waiting jobs** as counts with a line each: queues, delayed, held (with what it waits for), failed (with its attempts) and the doctor checks that need a look. Each opens its list on the full page.

**Panels.** `p-fleetbar`, `p-hosts`, `p-active`, `p-queues`.

**Who sees what.** A viewer gets the same card without *Pause the fleet*, and the failed row without a reason, as on FleetViewer.

**Fixture note.** The same fixture as FleetScreen, from the same rows (`QROWS`, `ACTIVE_ROWS`, `HOST_ROWS`).
