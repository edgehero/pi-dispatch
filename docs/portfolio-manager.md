# Portfolio manager

A portfolio manager is a weekly flow that decides how your budget is split between projects. It reads the
budget, reads your goals, writes a plan of weights, and reports what it asked for. pi-dispatch does the
arithmetic and decides whether the plan applies. Deciding what matters this week is judgement, so it lives in a
flow you own, not in pi-dispatch.

[`examples/portfolio-manager/`](../examples/portfolio-manager/) is a working one to copy. This page says what
the harness guarantees, what the flow must not rely on, and how to test it without spending.

## How the pieces fit

1. You set the envelope: a dollar total per window and a floor per project ([allocation](allocation.md)).
2. A cron trigger with `"portfolio": true` runs the flow each Monday ([triggers](triggers.md)).
3. The worker writes `/job/portfolio.json` into the job: the budget's numbers, with no text.
4. The flow reads it and your `priorities.md`, and writes `/outbox/priorities.json`: one weight per project.
5. The flow posts a report to your channel with its own tools. pi-dispatch sends no notification of its own.
6. After the job completes, the worker judges the plan and applies it, clamps it or refuses it. The next run's
   snapshot says which, and the next report opens with it.

## Set it up

Copy the example to a folder of its own, make it a git repository with a commit, and edit `priorities.md`.
The [example's README](../examples/portfolio-manager/README.md) has the commands.

Put the manager's folder in a project with a floor. Its own job is governed like any other: it pays from its
folder's project, or from `_other` when the folder is in no project. A plan can give `_other` weight 0, and then
the manager is refused as `allocation-cap` at its next run. A floor of at least `PI_MAX_COST_USD` keeps it
running. The example uses a project `ops`:

```json
{ "version": 1, "projects": [
  { "id": "shop", "members": ["github:acme/shop"] },
  { "id": "platform", "members": ["github:acme/platform"] },
  { "id": "ops", "members": ["/home/me/pm"] } ] }
```

```json
{ "version": 1, "window": "week", "totalUsd": 100,
  "floorsUsd": { "shop": 10, "platform": 10, "ops": 5, "_other": 0 },
  "defaultWeights": { "shop": 1, "platform": 1, "ops": 1, "_other": 1 },
  "delegation": { "enabled": true, "writers": ["operator-session", "portfolio-job"],
                  "maxStepPct": 25, "minIntervalHours": 24, "maxPlanDays": 14 } }
```

With `PI_MAX_COST_USD=2`, the `ops` floor of $5 admits the manager's weekly job even when a plan gives `ops`
weight 0.

### What these numbers give

The floors take $25 of the $100. The other $75 is split by weight.

| Project | Floor | Neutral (weights 1, 1, 1, 1) | After the fixture plan (3, 2, 1, 0) |
|---|---:|---:|---:|
| shop | $10.00 | $28.75 | $47.50 |
| platform | $10.00 | $28.75 | $35.00 |
| ops | $5.00 | $23.75 | $17.50 |
| `_other` | $0.00 | $18.75 | $0.00 |

The neutral split does not give `shop` and `platform` half of the $75 each: `ops` and `_other` have a default
weight of 1 too, so each of the four takes a quarter.

The fixture plan moves no project by more than $18.75, under the $25.00 step (25% of $100), so it applies
whole. A next plan of 1, 6, 1, 0 aims platform at $66.25, a move of $31.25, so it is clamped: every project
moves 25/31.25 of the way, to shop $25.00, platform $60.00 and ops $15.00.

### The trigger

```json
{ "on": { "type": "cron", "id": "pm-weekly", "pattern": "0 6 * * 1" },
  "run": { "kind": "local", "folder": "/home/me/pm",
           "flow": "portfolio-manager",
           "task": "Plan this week's budget split and report it. Follow the steps of the flow in order.",
           "portfolio": true, "model": "claude-haiku-4-5", "maxTurns": 15,
           "excludeTools": ["edit"],
           "secrets": { "REPORT_GH_TOKEN": "op://ops/pm-report/token",
                        "REPORT_WEBHOOK_URL": "op://ops/pm-report/webhook" } } }
```

- The panel's trigger list and `/dispatch triggers` mark it `[portfolio]`. After a run, the run's detail shows
  the plan's outcome and id, and the panel's `b` view and the insights page show the split it led to.
- It runs Monday at 06:00 UTC, at the start of the week window. The flow writes no `validUntil`, so its plan
  stays in force for `maxPlanDays` (14 in the example) unless a newer plan replaces it, which outlives a
  weekly run.
- Pick the cheapest model that follows the flow's steps, and try it before you rely on it. The model id
  above is an example. The flow spells out each command for that reason. A plan the model gets wrong is
  refused (`plan-parse-error`, `plan-invalid`) and the job still completes. In a test, a 3B local model ran
  only the one command fixture flow. A 7B model (qwen2.5:7b) ran this flow: its plan followed
  `priorities.md`, applied, and raised a project's weight from 1 to 3 once that project was marked "on fire".
  It did not on every run: some runs wrote no plan, and one wrote `"basis": "null"`, which was refused. A run
  that completes without a plan is recorded as `plan-absent`, and the next report opens with
  `Last plan: refused (plan-absent)`. A run that stops before it completes (a timeout, a cancel, a failure)
  records nothing, and the next report still shows the earlier attempt.
  Give a local model a context of 16k tokens or more: Ollama often defaults to 4096, too small for this flow.
- It does **not** set `"github": true`. That flag hands the job the deployment's GitHub credential: under the
  default `GITHUB_AUTH_SOURCE=gh` that is your whole gh login, and a job that reads issue text must not hold a
  token that can merge. Under a GitHub App the mint refuses a local job anyway.
- The report token comes through `run.secrets` instead ([secrets](secrets.md)): a fine grained token with
  Issues read on the project repos and Issues write on one tracking repo. Its name is `REPORT_GH_TOKEN`
  because `GH_TOKEN` and `GITHUB_TOKEN` are reserved for minted forge tokens. Keep only the secret of the
  channel you use: a reference the resolver cannot read refuses the job.

### The report channel

The report goes to the first channel that is set:

- **GitHub**: `REPORT_GH_TOKEN`, plus `report-repo` and `report-issue` in the front matter of
  `priorities.md`. The script runs `gh issue comment <n> --repo <owner/name> --body-file -`.
- **A webhook**: `REPORT_WEBHOOK_URL`. The script POSTs `{ "text": "<markdown>" }`, which Slack, Mattermost
  and Discord's Slack compatible endpoint accept. For another shape, change `webhookBody` in `report.mjs`.

A failed post prints `report-not-sent: <reason>` and the script still exits 0. The job must complete, because
the plan in `/outbox` is collected only after a completed exit.

The example reads milestones from GitHub only. On GitLab or Forgejo, change step 3 of the flow to use `glab`
or `tea`, which the job image also has, and bind that forge's token the same way.

### Egress

With the egress policy on, add the hosts the job talks to in `egress-allowlist.conf`:

```text
api.github.com
hooks.slack.com
```

`api.github.com` is for the GitHub channel and step 3. The second line is your webhook's host. The webhook
must be `https` on port 443, the only port the proxy tunnels to for a listed name. A webhook sink on the
worker's own machine is a poor test: the proxy refuses the host's loopback addresses ([egress](egress.md)).

## What the harness enforces

The flow proposes. The host decides, after the job exits, by the rules in `INT-PRIORITIES-PLAN-CONTRACT` and
`DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE`:

- **The envelope.** The total is never exceeded, and no project goes below its floor.
- **The step.** One plan moves a project by at most `maxStepPct` of the total. A larger move is clamped.
- **The interval.** A plan sooner than `minIntervalHours` after the last one is refused as `plan-too-soon`.
- **The basis.** A plan must name the plan it saw. If another applied since, it is refused as `plan-stale`.
- **Validity.** A plan lives until its `validUntil`, at most `maxPlanDays`. Then the neutral split returns.
- **Writers.** `portfolio-job` must be in `delegation.writers`, or the job is refused before it costs anything.
- **The audit log and revert.** Every plan the job sends, applied or refused, is a row in the audit file and
  in `alloc:log` ([allocation](allocation.md#portfolio-jobs) names the one exception). The panel's ALLOCATION
  view (`b`) shows the history, and `r` on a row reverts to it.

The full rules are `REQ-DELEGATED-ALLOCATION`, `INT-ENVELOPE-FILE-CONTRACT` and `INT-OUTBOX-CONTRACT`.

## Turn it off

- **Stop the manager only.** Delete its trigger to stop its runs. Removing only `"portfolio": true` leaves a
  weekly job that still runs and costs: any plan it writes is refused as `plan-not-portfolio`, and the split
  stays as it is.
- **Stop every plan.** Set `enabled` to false with `dispatch_envelope_set`. The neutral split returns, and a
  portfolio job is refused as `portfolio-no-envelope` before it costs anything. An operator plan is refused too.
- **Remove the split.** Follow "Several hosts" in [allocation](allocation.md#several-hosts): remove
  `PI_ENVELOPE_FILE` from every host, then delete the split and its digest:
  `valkey-cli DEL alloc:plan alloc:envelope:expected`.

## What the snapshot holds

`/job/portfolio.json` holds ids, numbers and operator labels: the envelope's numbers, the plan in force, this
trigger's last attempt, and per project its floor, weight, allocation, spend in the window and runs of the last
7 days. A project member shows as its label, `github:acme/shop` or `local:<folder name>`. Money is in
micro-dollars (1000000 is one dollar). The shape is `INT-CONTAINER-JOB-INPUTS`.

It holds no issue text, no titles, no plan reasons and no paths. The next run reads the file as facts, so text
that someone else wrote must never reach it. A reason your last plan gave is agent text too, so it is not there.

## What the flow must not rely on

- **That its plan applied.** The host judges it after the job ends. The report says "requested", and the next
  run learns the outcome from `lastAttempt`.
- **That `lastAttempt` shows a revert.** It holds only this trigger's own plans. A revert in the panel shows in the
  snapshot's `plan`: its `writer` is then `operator-revert`, and the report's "In force" line names it. A revert to
  the neutral split leaves `plan` null, and the line says so.
- **That the numbers are exact to the cent mid run.** Spend counters include what running jobs still hold, and
  other jobs settle while the manager runs.
- **That run counts cover the whole fleet.** They do only with a run mirror (`PI_WORKER_NAME` set on every
  host). `fleet.runsComplete` says which.
- **That its reasons reach you unaltered.** A reason holding a control or format character refuses the whole
  plan, the panel shows the rest escaped, and the snapshot never shows them.
- **That it can compute dollars.** It writes weights. The host ignores any dollar amount, and models misjudge
  shared budgets.

## Threat model

The manager reads text other people wrote, so assume a prompt injection can steer its weights. That is bounded
by arithmetic, not by trust: a plan cannot raise the total, break a floor or move more than one step per
interval, and you can revert it ([SECURITY.md](../SECURITY.md), `CONST-ISSUE-TEXT-IS-DATA`).

## Test it with zero spend

Use a local model with a nonzero price in your overlay `models.json`, so the meter and the caps run as they
would for a paid model ([local model servers](egress.md#local-model-servers)). Give it
`"compat": {"maxTokensField": "max_tokens"}`, or the dollar cap refuses every call to it: Ollama ignores the field
pi sends otherwise, so nothing would stop the answer at the output cap.

```json
{"providers":{"local-ollama":{"api":"openai-completions","baseUrl":"http://host.docker.internal:11434/v1","apiKey":"$PI_DISPATCH_KEYLESS","compat":{"maxTokensField":"max_tokens"},"models":[{"id":"qwen2.5:3b","contextWindow":32768,"maxTokens":256,"cost":{"input":10,"output":6000,"cacheRead":0,"cacheWrite":0}}]}}}
```

1. Copy the example to `~/pm`, then `git init`, `git add -A`, `git commit -m init`.
2. Set up the envelope above, with `~/pm` a member of `ops`, and `minIntervalHours` 0 while you test, so
   one run can follow another.
3. Set the trigger's `"model"` to the local model, and drop `secrets`.
4. Set `"flow": "portfolio-fixture"`, which copies `plan.fixture.json` with no judgement. Its `"basis": null`
   matches a deployment where no plan has applied yet. A small local model may answer without running the
   flow at all, so put the flow's one command in the task as well (the `task` line below). Run
   `pi-dispatch run --trigger pm-weekly`. The worker logs `plan_collected` with outcome `applied`, and the
   ALLOCATION view shows the fixture's split (shop $47.50, platform $35.00, ops $17.50) with writer
   `portfolio-job`.
5. Set `"flow": "portfolio-manager"` and the task back, and run again. The report opens with
   `Last plan: applied`, and the new plan follows `priorities.md`. Mark a project "on fire", commit, and run
   again: its weight rises, or the step clamps it.
6. Revert in the panel: `b`, then `r` on the first row. The next report shows the reverted split under
   "In force".

```text
"task": "Call the bash tool once with this command: cat /job/portfolio.json && cp /workspace/plan.fixture.json /outbox/priorities.json; node /job/pi/skills/portfolio-manager/report.mjs . Then reply DONE."
```

The job log holds the runner's events, not what a command printed inside the job, so the report is not in
it. To read it, run the script with `--dry-run` (it posts nothing) on the files the job left in its retained
sandbox: `PI_SANDBOX_DIR/<run>`, where `<run>` is the job id with each `:` written as `_`.
`PI_SANDBOX_DIR` defaults to `<PI_JOBS_DIR>/sandboxes` ([sandbox](sandbox.md)).

```sh
node ~/pm/.pi/skills/portfolio-manager/report.mjs --dry-run --priorities ~/pm/priorities.md \
  --snapshot "$PI_SANDBOX_DIR/<run>/portfolio.json" --plan "$PI_SANDBOX_DIR/<run>/outbox/priorities.json"
```

Put `minIntervalHours` back afterwards. A hand edit of the envelope needs the digest step in
[allocation](allocation.md#several-hosts), or the host refuses its jobs as `envelope-mismatch`.

## Reference

| Piece | Value |
|---|---|
| Example | `examples/portfolio-manager/` |
| Trigger field | `run.portfolio` (`INT-TRIGGERS-FILE-CONTRACT`) |
| Job files | `/job/portfolio.json` (in), `/outbox/priorities.json` (out) |
| Report script | `/job/pi/skills/portfolio-manager/report.mjs`, with `--dry-run` |
| Report secrets | `REPORT_GH_TOKEN`, `REPORT_WEBHOOK_URL` |
| Report output | `report-sent: <channel>` or `report-not-sent: <reason>`, exit code 0 always |
| Panel | ALLOCATION view, key `b`; `r` on a history row reverts |
