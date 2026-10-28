Fleet when it is part paused: two of four queues are paused, the console and the service read different Valkeys, and an operator works out what is stuck and what to start again.

**How a person uses it.**
- **The fleet bar.** It is ringed yellow and says *Part paused* with which queues start nothing new and which keep going. Its counts add *in paused queues*. Both switches are offered: *Resume the fleet* (paid, amber outline, because queued jobs start spending) and *Pause the fleet* (danger).
- **Two Valkeys.** When `VALKEY_URL` differs between the console's environment and the deployment's `.env`, a yellow line says so in the repo's words. A pause reaches both; a resume is refused, and the refusal opens where the preview would, with the command that resumes one Valkey on purpose. Nothing was changed.
- **Queues.** Paused rows are tinted and say *Paused* with the pause glyph. Their sub-line says the host still takes shared jobs. *Resume* on a row is paid; its preview names how many jobs wait in it and why no single reserve figure applies.
- **Failed jobs.** Each row quotes its run record's sentence. The bulk editor filters by queue or repository; *Retry all* opens a preview that lists each job with its reserve, then the bulk reserve, including the case where one job's reserve is unknown. *Why each failed* shows the queue's own text in a collapsed row per job.
- **Held.** Each held job's condition label as the worker writes it (`after … + ci-green`), how long it has waited and how many of its 96 checks it has used.
- **Delayed.** The delayed count is one number. The card splits out what can be counted (cron next occurrences, held jobs) and calls the rest *undifferentiated*. A folded list explains every deferral and how often it asks again. Jobs waiting for a host budget link to the host.
- **Other states.** Running, paused (kill switch on), a pause that did not reach every queue, an unreadable host registry, a held set too large to read, and the per-job results after a bulk retry with *Reload*.

**Panels.** `p-fleetbar`, `p-queues`, `p-failed`, `p-held`, `p-delayed`.

**The server provides.**
- The paused state: running, part paused or paused.
- The kill switch's plan: Valkey URLs as shown (never with credentials), the disagreement sentence, or the refusal.
- Per queue: counts and paused flag.
- Failed jobs with queue, attempts, failed time, target, run record reason, and the scrubbed queue text (operators only).
- Held rows (job, target, label, waited, checks).
- The delayed total with the counted cron and held parts.
- Host waiters.
- Every preview's summary lines and reserve text come from the server, not the page.

**Viewers** see the bar, counts, queues, held and failed rows and the delayed split. They do not see any button or preview. In place of *Why each failed* they see "Failure reasons are shown to operators only."

**Fixture note.** Queue names, hosts, `redis://127.0.0.1:6399/0`, gh-77c1, gh-5d10 and the schedules come from the fixture. These are sample data:
- the paused queues and every count;
- the second Valkey `redis://127.0.0.1:6379/0`;
- gh-91a0, gh-6e21 and their texts;
- the reserves.
