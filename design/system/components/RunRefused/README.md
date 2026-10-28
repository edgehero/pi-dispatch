The run page for a run refused before it started: the outcome banner leads with the reason sentence and the next step, and everything that did not happen folds into one line.

## How a person uses it
- The banner says what happened ("Refused: …"), why (the egress proxy on build3 is not running), what to do (start the proxy, then re-run) and that nothing was spent.
- The one primary action is **Open Fleet**, where the proxy and doctor live. **Preview a re-run** is shown but disabled, with the reason beside it, so the person knows it exists and why it waits.
- Progress, transcript, tokens and chain do not apply, so they collapse into one line instead of five empty panels.
- The sandbox command is hidden because the run kept no workspace (#710), and a small line says there is none to open.
- *Why it was refused* names the rule in one sentence, counts the same reason in 24 hours and links the reason's docs.

## Panels
`p-outcome`, `p-run`, `p-rest` (the collapsed line), `p-why`, `p-host`.

## The server provides
The run record (target, project, flow, host, venue, trigger, model, attempt, times, reason token), the reason catalog's sentence and next step for the token, whether a re-run would be refused again and why, whether a workspace was kept, the count of the same reason in 24 hours, and the host's doctor summary.

## Why it works this way
- The egress floor exists so a job can reach the hosts on its allowlist and nothing else. With the proxy down, no job on build3 may start.

## Fixture note
From the fixture: gh-e9a0, acme/billing#260, fix, build3, podman, trigger 3 (index 2 in the fixture file), claude-sonnet-5-5, attempt 1, 15:30 UTC, 0s, not metered, no dollar window, `egress-proxy-missing`. The fixture record says project `api`; the page follows the project config, which maps acme/billing to `billing`. The rule text, the doctor link and "same reason in 24 hours" are sample copy.
