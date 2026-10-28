A durable run whose first attempt was lost: the outcome says it goes on, a track shows the attempt, its checkpoints and the recovery, and the side column keeps the facts and what each attempt spent.

**How a person uses it.**
- The outcome reads "Failed, continuing" with the running glyph, because the run is not over. Its one action opens the recovery job.
- *Recovery* draws the run on one track (15:00 to 15:45 UTC):
  - attempt 1 as a red pill;
  - its checkpoints as markers above it: live, exit, and the skipped one;
  - the wait for a slot as a dotted gap;
  - recovery 1 running up to the now line.
- Under the track:
  - three tiles: checkpoints written, failed and skipped; which checkpoint it resumed from; recovery 1 of at most 2;
  - what happened to the calls that were open at the checkpoint: replayed, interrupted (may or may not have happened), not started;
  - one line saying the agent was told it restarts from checkpoint 4.
- *Progress* starts with "This run continues as gh-5d10-r2.r1." It then sets attempt 1's record beside the recovery's live numbers, and shows steps by tool.
- *Run* adds the record fields the old page did not show:
  - replica 2 of 2 with its sibling;
  - queued time and the wait for a slot;
  - stalled re-pick;
  - checkpoints.
- *Tokens and dollars* lists each attempt's cost or hold.
- *Chain* is one line: no parent and no child runs.

**Panels.** `p-outcome`, `p-recovery`, `p-progress`, `p-run`, `p-cost`, `p-chain` (one line).

**The server provides.**
- From the run record: `recovered {from, n, fromAttempt, checkpointSeq, replayed, interrupted, notStarted}`, `checkpoints {written, failed, skipped}`, `recoveryOf`, `replica` and `replicas`, `queuedAt`, `stalledRepick` and `earlier[]`.
- The recovery job's id and state from the queue.
- Live progress, including `replayed`.
- The tool name of each call that was open at the checkpoint, from the transcript, for operators only.
- The catalog sentences for `recovery-*` and the recovery-skipped reasons.

**Why it works this way.**
- The agent is told what was restored: the workspace at checkpoint 4, with `.pi/`, `.agents/` and the root context files reset to the base commit. It checks before repeating anything with outside effects.
- A durable run can hold up to four per-job caps: two queue attempts and two recoveries. Each settles on its own.
- A forge run has no /outbox, so it has no parent and no child runs.
- The same outcome banner and Run facts read differently on other durable runs. Each sentence is the catalog's:
  - Failed, `recovery-failed`: "Failed: this run was lost, continued from its checkpoint, and the continuation was lost too, so it is not continued again. Partial work may exist."
  - Failed, `recovery-host-lost`: "Failed: this run stopped on a worker that has not come back, and its checkpoint lives on that worker, so it could not be continued and will not be retried further."
  - Refused, `recovery-cap`: "Failed: this run was lost and continued from its checkpoint as many times as allowed, so it is not continued again."
  - Refused, `recovery-checkpoint-absent`: "Failed: this run was lost, and its checkpoint could not be used to continue it (absent, damaged, or taken on another host, pi version or venue)."
  - Refused, `recovery-unsafe-extensions`: "Failed: this run was lost, and it is not continued from its checkpoint because the repository's `.pi/extensions/` could load code the agent wrote."
  - Not run, `recovery-superseded`: "Not run: the run this recovery would continue had already reached its final outcome, so there was nothing left to continue."
  - Recovery skipped, `workspace-extensions`: "Recovery: skipped (workspace-extensions): the repository's base commit holds `.pi/extensions/`, whose imports could load code the agent wrote, so the run was not armed for recovery."
  - Recovery queued: "This run goes on as a recovery job that is queued and has not started yet. It waits for its checkpoint's host for 6 hours, longer while that host is alive, and 7 days at most."
  - Retried: "An earlier attempt of this run ended (failed); this is the attempt after it. Earlier attempt: mini1, 14:10 to 14:12 UTC."
  - Re-picked: "The first attempt stalled (its worker stopped answering), and this pickup ran it again. Stalled re-pick: yes."

**Fixture note.** All of it is sample: gh-5d10-r2, its sibling gh-5d10-r1, acme/api#140, trigger 7 (pi:triage, which the fixture gives two replicas and recovery), the times, the checkpoint markers, the costs, and the earlier attempt on mini1. The sentences are the catalog's (`recovery-enqueued`, `recovery-failed`, `recovery-host-lost`, `recovery-cap`, `recovery-checkpoint-absent`, `recovery-unsafe-extensions`, `recovery-superseded`, `workspace-extensions`). The checkpoint markers' times are illustrative: the record keeps only counts.
