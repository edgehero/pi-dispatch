Watch shows the findings that logs and alerts send in, what they started, and what was suppressed or refused, with a person in charge of any code change.

**How a person uses it.**
- **Four counts:** findings delivered, jobs started, suppressed by cooldown, and capped or unmatched (both refused before spend).
- **Finding.** The newest finding, as a card:
  - service, error type and top frame, with the count (37×);
  - first and last seen, severity, project and cooldown left;
  - 8 redacted samples shown as escaped plain text;
  - what it started: the read-only triage job, the follow-up that waits for a person, and the forge issue filed in issue mode.
- **Active fingerprints.** Each fingerprint's count, last seen, cooldown left and jobs.
- **Right column:** *Sources*, each with its signature check, secret name and last delivery (doctor flags a missing secret), and *Triggers*, each with its match, fingerprint fields, threshold, cooldown, daily cap, mode, flow and job cap.

**Panels.** `p-delivered`, `p-started`, `p-suppressed`, `p-refused`, `p-finding`, `p-fingerprints`, `p-sources`, `p-wtriggers`.

**The server provides.**
- Counters per window.
- Fingerprints with counts and cooldown expiry.
- Redacted samples, never stored in run history.
- The jobs and issues each finding started.
- Sources with signature and secret status.
- The watch triggers from triggers.json.

**Why it works this way.**
- Rules decide what starts a job, never a model: a finding never picks the flow, model, tools or secrets.
- Watch jobs are read-only, with edit and write excluded. A fix starts only after someone with write access labels the issue `pi:fix`. The ordinary label trigger then opens a pull request, which a person merges.
- A source's signature is checked before any field of a delivery is read.
- The same fingerprint stays quiet for its cooldown (6 hours here) after it starts a job, so a noisy error starts one job, not hundreds.
- Samples are redacted on the host before they reach the queue, shown as plain text, and never kept in run history. Fingerprints use structured fields only, never message text.

**Fixture note.** This is a planned screen (#735), and all of it is sample, built from the example in the issue: prod-alerts, shop-5xx, checkout/TimeoutError/db.pool.acquire, 37 events and 8 redacted samples.
