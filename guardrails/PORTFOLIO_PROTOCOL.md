<!--
  pi-dispatch portfolio protocol: how a portfolio job reads the budget and proposes a plan.

  This is documentation, not a control surface. The host decides what happens to a plan after you exit.
  Composed into the prompt ONLY when /job/portfolio.json exists (a cron trigger the operator flagged
  run.portfolio), so no other job is billed for these lines.

  Keep it short. Every line is paid for on every portfolio job.
  PORTFOLIO-SENTINEL below is asserted by the contract tests and the image check. Do not remove it.
-->

## Proposing budget priorities (pi-dispatch)

<!-- PORTFOLIO-SENTINEL: pi-dispatch-portfolio-v1 -->

1. `/job/portfolio.json` holds the facts: the envelope (`totalMicros`, `maxStepPct`, `minIntervalHours`,
   `maxPlanDays`, `planAllowedAfter`), the applied `plan` (null when none applied), your trigger's
   `lastAttempt`, and per project its floor, weight, allocation, spend in the window and runs of the last
   7 days. Money is in micro-dollars (1000000 is one dollar). It holds ids, numbers and
   operator labels only.
2. To propose a split, write `/outbox/priorities.json`:
   `{"version": 1, "basis": <plan.id, or null when plan is null>, "projects": [{"id": "<id>", "weight": <0 to 1000>}]}`.
   Name every project in the snapshot, `_other` included. Optional: `"validUntil"` (a UTC instant like
   `2026-10-12T00:00:00Z`), a short `"reason"` per project, and `"repos": [{"ref": "<member ref>", "weight": <n>}]`
   naming every member of that project. Unknown keys are refused. At most 16 KiB.
3. You write WEIGHTS, never dollars. The host splits the money: every project keeps its floor, and the rest is
   divided by weight.
4. `basis` must be the id of the plan you saw. If another plan applied since the snapshot, yours is refused as
   `plan-stale`. Nothing merges two plans.
5. The host judges the file AFTER you exit. You get no confirmation. Refusals are normal and recorded: too soon
   after the last plan (`plan-too-soon`), the same plan again (`plan-duplicate`), or a malformed file
   (`plan-invalid`). A plan may also be clamped: one step moves at most `maxStepPct` of the total.
6. Writing no file is a valid answer. Do not retry or write a second file to get around a refusal.
