A completed run in an OpenShell sandbox, with a project secret bundle, a cost that is only a floor, per-model usage, and two chained children.

**How a person uses it.**
- The outcome says it finished and what it queued. Its actions open the children or preview a re-run (paid).
- *Run* covers:
  - the cron job id, which wraps rather than overflows;
  - the queued time and the wait for a slot;
  - steering and the live transcript, in words.
- *Sandbox* shows:
  - the policy (mode, credential providers, placeholders);
  - who holds the credentials;
  - that the workspace cannot be reopened;
  - the rule hosts as a list of names, with the rest counted behind a link.
- *Secrets* names the profile and the bundle, and lists the variables received, each marked placeholder or value. The shadowed name gets its own sentence.
- *Chain* gives the parent, depth and refused requests, and lists the children found among the newest runs, each with its outcome badge.
- *Actions* offers the re-run of a cron run, and says there is no sandbox shell and no terminal chat.
- The side column:
  - "≥$1.42" with its class ("metered, a floor") and why;
  - the settled basis;
  - the token split between this run, other sessions and subprocesses;
  - per-model usage rows;
  - resources, including memory pressure, swap and what the host offered at admission;
  - the session.

**Panels.** `p-outcome`, `p-run`, `p-sandbox`, `p-secrets`, `p-chain`, `p-actions`, `p-cost`, `p-models`, `p-resources`, `p-session`.

**The server provides.**
- The run record: `openshell {mode, ruleHosts, ruleHostCount, providers, placeholders}`, `secretsProfile`, `bundle {id, variables, shadowed, placeholders, plain}`, `bundleSkipped`, `liveSkipped`, `steerSkipped`.
- Tokens: the split keys, `unmeteredChildren`, `usage.models[]` and `dollars {reservedMicros, settledMicros, basis}`.
- `resources`, `size`, `capacity`, `session`, `plan`, `parentJobId`, `chainDepth` and `chainRefused`.
- The children, from a search of the newest runs.

**Why it works this way.**
- Secret names only: no secret value reaches a log, a record or this page.
- The session is fresh because the trigger does not set run.resume, so the job did not continue a saved conversation.
- On other runs the same Run rows say why a part was skipped, each with its token:
  - Live transcript, none (`venue-copies`): its venue copies the job's files and does not stream the transcript back.
  - Live transcript, none (`no-capability`): its venue streams the transcript only from a job image that declares transcriptStderr, and this one does not.
  - Steering, skipped (`venue-copies`): its venue copies the job's files (no /inbox mount) and its job image does not declare steerStdin, so no message could reach the run.
  - Steering, skipped (`no-exit-key`): its job image does not declare exitAuth, so no delivery could be verified.
  - Bundle skipped (`fork`): a pull request from another repository, and the bundle does not set forkReviews.
  - Bundle skipped (`chained`): a chained /outbox child, so it got no bundle: the grant was to the trigger, not to what its job queues.
  - Rule hosts, no rule host: the sandbox reaches nothing.

**Fixture note.** All of it is sample: the billing-sweep cron trigger, the billing-jobs folder as a billing member, the variable names, the rule hosts, the token and cost figures, and the two chain children. The skip sentences and the chain cap (2 per job) are the repo's.
