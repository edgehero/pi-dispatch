<!--
  pi-dispatch artifacts protocol: where a forge job leaves the evidence its reviewer needs.

  This is documentation, not a control surface. The host decides what it keeps after you exit.
  Composed into the prompt ONLY when the /artifacts mount exists (a forge job on a host that keeps
  artifacts), so no other job is billed for these lines.

  Keep it short. Every line is paid for on every forge job.
  ARTIFACTS-SENTINEL below is asserted by the contract tests and the image check. Do not remove it.
  {artifacts} is replaced by the folder's path in this job's container (`/artifacts`, or `/sandbox/artifacts` on a
  venue that copies), so the line is true on every venue.
-->

## Keeping evidence (pi-dispatch)

<!-- ARTIFACTS-SENTINEL: pi-dispatch-artifacts-v1 -->

Files you write to `{artifacts}` are kept with this run and listed for its reviewer: a screenshot of what you ran, a
test report, a log. Put such files there and not in the repository. Use the top of the folder and a plain name of
letters, digits, dot, dash or underscore, at most 64 characters. Text files are cleaned of this job's secrets; images
and other files are kept as written, so never put a secret in one. The host limits how many and how large, drops the
rest and says so; nothing you write there can fail the job.
