# Allocation envelope

The envelope is the outer limit you set once: a dollar total for one window and a floor per project. Inside it, a
priorities plan moves headroom between projects with no keypress. The plan holds weights, never dollars, and
pi-dispatch does the arithmetic. A job over its project's share is refused before anything is spent.

This page covers the file, how the worker applies and enforces the split, what it refuses, and the operator's
surfaces: the tools, `/dispatch priorities`, the panel's `b` view, and the guard on pi's own file tools.

## Enable it

```sh
# .env
PI_ENVELOPE_FILE=/absolute/path/to/envelope.json
PI_MAX_COST_USD=2
```

Unset means no envelope and no delegation: every dollar cap is exactly what your rows and windows set.
`pi-dispatch init` and `pi-dispatch up` never set this key, so delegation stays off until you turn it on. Once a
split has been applied, unsetting the key is not enough: delete the split too (see "Several hosts"), or every host
without an envelope refuses its jobs.

An EMPTY value is NOT unset. The worker keeps an empty `PI_ENVELOPE_FILE`, tries to load it and refuses to start,
so fill the line in or delete it. Doctor fails on it.

The envelope needs a per-job cost cap (`PI_MAX_COST_USD`). Each governed job reserves its whole cap against its
project's share, so without one every such job would be refused.

A file that does not load refuses worker startup. A live edit that does not load keeps the last good envelope, and
the worker logs `envelope_reload_invalid`.

## The file

```json
{ "version": 1, "window": "week", "totalUsd": 100,
  "floorsUsd": { "shop": 10, "platform": 10, "_other": 0 },
  "defaultWeights": { "shop": 1, "platform": 1, "_other": 1 },
  "delegation": { "enabled": true, "writers": ["operator-session", "portfolio-job"],
                  "maxStepPct": 25, "minIntervalHours": 24, "maxPlanDays": 14 } }
```

- `window`: `day`, `week` (from Monday) or `month`, in UTC, the same windows as the dollar caps.
- `floorsUsd`: a project id from `projects.json`, or `_other` (every job in no listed project). The floors may not add
  up to more than the total.
- `defaultWeights`: the neutral split, used with no plan, after a plan expires, and with delegation off.
- `delegation`: who may send a plan, the largest move per plan (`maxStepPct` of the total), the shortest time
  between plans, and the longest a plan lives.
- A project in `projects.json` that the envelope does not name counts in `_other`. Doctor names such projects.
- A project's `scoped-limits.json` dollar row for the same window, or a longer one, below its floor refuses the file.
- Unknown keys are refused. The full rules are `INT-ENVELOPE-FILE-CONTRACT`.

## Where it may live

- The path must be its own canonical path: absolute, with no symlink, `.` or `..` on the way. The refusal names the
  path to write instead.
- It must be a regular file with one hard link.
- It must lie outside every path a job container can see: each cron trigger's `run.folder`, each
  `PI_DISPATCH_RUN_ROOTS` root, each `run.skillsDir` and `PI_GLOBAL_PI_DIR`. A job that could write the envelope
  could write its own bounds.
- The worker checks this with every successful load: at boot, on every reload of the envelope, and after a reload of
  `projects.json` or `scoped-limits.json`. A reload that puts the file inside a job path keeps the last good envelope.
  A triggers edit that adds a job path around it logs `envelope_inside_job_path`.
- A local job's folder is resolved when the job is prepared, and the resolved folder is what is mounted. A folder
  named inside a run root or a cron folder that now resolves outside it is refused as `local-folder-escaped` (a case
  variant of the root's name counts as inside it). A job can write inside its job path, so a link planted there must
  not carry another job's folder out of it. That also refuses a run root used as a symlink farm (`root/x` linking to
  `/elsewhere`): list the real folder as a run root, or as a cron trigger's `run.folder`, instead.
- A folder that resolves to the envelope's folder or a folder above it is refused as `local-folder-holds-envelope`.
- A folder that resolves into ANOTHER project's member than the project its name belongs to, or into any project when
  its written path is in none, is refused as `local-folder-project-changed`, with or without an envelope, so a link
  cannot bill one project's work to another.
- A chained child runs on the folder as its parent named it, and is resolved and judged again when it is prepared.

### When another file changes

An edit to `projects.json`, `scoped-limits.json` or the per-job cap can leave the envelope invalid: a floored project
removed, a row lowered below a floor, the cap removed. Each such edit is taken on its own. The worker keeps the last
good envelope and logs `envelope_reload_invalid`, doctor fails on the file, and the next start refuses until the files
agree again. Edit the envelope in the same change.

## How the split is applied

- The applied split lives in Valkey (`alloc:plan`), shared by every host. With no plan, the first host writes the
  neutral split there, so every host enforces one split.
- If Valkey cannot be read when a job is picked up, the job is retried later. Nothing is spent.
- A plan is applied by its weights: every project gets its floor, the rest is split by weight, and no project moves
  by more than `maxStepPct` of the total from the split applied now. A plan is refused, and nothing changes, when
  delegation is off, its writer is not allowed, this host's envelope is not the applied one, it repeats the applied
  plan, its `basis` is not the applied plan's id, it comes sooner than `minIntervalHours`, it leaves out a project,
  or another apply is running.
- A plan past its life gives way to the neutral split. Turning delegation off does too.
- An envelope edit re-bases the split at once, with no step: each project keeps its current share above its floor,
  in proportion. Money already reserved is never taken back, and a running job runs on.

## Enforcement

For the envelope's window:

- a project's dollar cap is the smaller of its `scoped-limits.json` row and its share. A project with no row reserves
  against its share alone;
- a repo's cap, when a plan gives repo shares, is the smaller of its row and its repo share;
- `_other`'s share caps the jobs in no project;
- the deployment window is the smaller of your `PI_WEEKLY_COST_USD` (or day or month) and the envelope total.

A job that does not fit is refused before any container starts. The reason is `allocation-cap` when the number that
bound came from the split or the envelope total, and `dollar-cap` when it was your own row or window (a tie is
yours). Neither is retried.

A portfolio job (a cron trigger with `"portfolio": true`, see [triggers](triggers.md)) is refused as
`portfolio-no-envelope` before anything is spent when this worker has no envelope, `delegation.enabled` is false, or
`portfolio-job` is not in `delegation.writers`. Its plan could never apply there, so it is not paid for. Not retried.
A worker with no envelope gets that refusal only while the fleet has no applied split. Once a split exists
(`alloc:plan`), removing the envelope from a worker refuses every job there as `envelope-mismatch` first (see
[Several hosts](#several-hosts)).

## Portfolio jobs

A portfolio job runs a flow that reads the budget and proposes a split, with no keypress.

- **What it reads.** The worker writes `/job/portfolio.json` for it: the envelope's numbers, the applied plan (its id is
  the next plan's `basis`, or `null` when no plan applied), the trigger's last attempt, and for each project its floor,
  weight, allocation, what it has spent in the window, and its runs of the last 7 days. Money is in micro-dollars.
  The file holds ids, numbers and operator labels (a project member as `github:acme/web` or `local:<folder name>`): no issue text, no titles, no plan reasons and no paths. Spending is read from
  the counters every host shares; run counts cover the whole fleet only when `PI_WORKER_NAME` is set (the run
  mirror), and `fleet.runsComplete` says which. A snapshot over 64 KiB refuses the job as
  `portfolio-snapshot-oversize` before it costs anything.
- **What it writes.** `/outbox/priorities.json`, the plan format of the operator's own tool. The worker reads it
  after the container completes and applies it under the same rules: the step, the interval, the floors.
- **When it writes nothing.** A portfolio job that completes without a `/outbox/priorities.json` is recorded as
  refused, `plan-absent`, and the applied split stays as it was. It is a line in the audit file and in `alloc:log`
  like the refusals below, so the panel and the next snapshot's `lastAttempt` show that the run wrote no plan. A run
  that stops before it completes (a policy exit, a timeout, a cancel, an infrastructure failure, a refusal before
  start) records nothing, and `lastAttempt` still shows the earlier attempt. A job that is not a portfolio job (or
  whose flag was removed while it ran) and writes no plan records only `plan: null`.
- **When it is refused.** The plan is refused, and the job stays completed, when the job is not a portfolio job any
  more (`plan-not-portfolio`: the flag was removed from the triggers file, or the job was a manual run or a chained
  child), when the file is over 16 KiB, is a link or is not a regular file, is not JSON, or fails the plan rules
  (`plan-invalid`), and for every reason the operator's own plan can be refused (`plan-stale`, `plan-too-soon`,
  `plan-duplicate` and the rest). The run record's `plan` field names every refusal. A refusal of a portfolio job is
  also a line in the audit file and in `alloc:log`, and the next snapshot shows it as `lastAttempt`, except
  `plan-collect-error` (below), which is only in the run record and the worker log. A file left by a
  job that was never a portfolio job (a manual run, a chained child, an unflagged cron job) is refused in its run
  record and the worker log only, so stray files cannot push the panel's history out of `alloc:log`.
  `plan-collect-error` means the worker could not tell what happened (the plan may have applied), so it writes no
  row of its own: look at the panel's current plan and the audit file.
- **The job log** shows `plan_precheck` from inside the container (what the plan is likely to meet, a hint only) and
  `plan_collected` from the worker (what happened).
- **The manager pays from a share too.** Its own job is governed like any other: its folder's project, or `_other`
  when the folder is in no project. Give that share a floor of at least `PI_MAX_COST_USD`, or the manager itself is
  refused as `allocation-cap` once a plan (or the default weights) leaves it nothing. `_other` with floor 0 and weight
  0 refuses it from the first run.
- **Two plans at once.** A run fired by hand waits for a scheduled run of the same trigger to end (one job per folder
  at a time), so its plan meets the first one's and is refused as `plan-too-soon`. The operator can apply a plan while
  a job runs: the first plan to apply wins, and the other is refused as `plan-stale` or `plan-busy`. Nothing merges two
  plans.

## Several hosts

Every host of one fleet must carry the same envelope. Each host publishes a digest of its envelope in the host
registry (`fpEnvelope`, or `none`). A host whose digest is not the one the applied split was made for refuses every
job as `envelope-mismatch`, before anything is spent. A host with no envelope refuses its jobs the same way while the
fleet has an applied split. `pi-dispatch doctor` prints the applied split's digest, names the hosts that match it,
and fails for each host that does not.

To turn delegation off for the whole fleet, remove `PI_ENVELOPE_FILE` from every host, then delete the split and the
digest it was made for:

```sh
valkey-cli DEL alloc:plan alloc:envelope:expected
```

**The first host to look defines the split.** At a first start, or after the keys were deleted or Valkey was flushed,
the first host to reconcile writes the neutral split from ITS envelope and sets `alloc:envelope:expected` to that
envelope's digest in the same step. If that host carried a stale copy, its envelope is the fleet's from then on, and
every other host refuses with `envelope-mismatch`. Doctor names every host whose envelope is not the applied split's,
so run it after such a start.

Once a split exists, `alloc:envelope:expected` names the envelope it was made for, and only an envelope with that
digest moves the fleet. A host with another envelope that finds the key empty sets it to the applied split's digest,
not its own. So after the first start, a stale copy or a hand edit on one host is the host that refuses.

An envelope edit re-bases the fleet only when its digest matches `alloc:envelope:expected`, which the admin's envelope
tool writes before it writes the file. A hand edit on one host does not move the fleet: that host refuses jobs with
`envelope-mismatch`, its log and the audit file say `envelope-changed-externally`, and the panel's `b` view shows
the banner "changed outside the panel". Change the envelope with `dispatch_envelope_set` (below) and none of this
happens. To accept a hand edit:

1. Install the new file on every host. Until a host has it, and until step 2, the hosts that differ refuse their jobs
   as `envelope-mismatch`, and those refusals are not retried, so make the change at a quiet time.
2. Set the key to the new digest (the worker logs it as `envelope_loaded` at start and `envelope_reloaded` on a
   change, and doctor prints it):

```sh
valkey-cli SET alloc:envelope:expected <digest>
```

The next job on each host re-bases the split.

## Set a plan

A plan is weights, an integer from 0 to 1000 per project. From the console:

```text
/dispatch priorities set shop=3 platform=1
```

or from a model, `dispatch_priorities_set`. Neither asks for a confirm, and both work with no operator present (a
headless `pi -p` included): a plan can only move money inside the envelope. The writer is `operator-session`, so
`delegation.writers` must list it. The plan's `basis` is filled in from the applied plan. A plan that leaves `_other`
out keeps `_other`'s current weight; any other project left out is refused as `plan-incomplete`.

Worked numbers, for the envelope above with `defaultWeights` of shop 1, platform 1 and `_other` 0 (and the floors
$10, $10 and $0):

- neutral: the $80 above the floors splits 1:1, so shop $50, platform $50, `_other` $0;
- `shop=3 platform=1`: shop $70, platform $30. Each moves $20, inside the 25% step ($25), so it is not clamped;
- the same again at once: refused as `plan-too-soon` (24 hours between plans), and nothing changes.

With the file's own example weights (`_other` at 1), neutral is about shop $36.67, platform $36.67 and `_other`
$26.67, and 3:1:0 from there is clamped by the step. A weight of 0 on `_other` can starve the jobs in no project,
within the step, so give it a floor if they matter.

The result names the outcome (`applied`, `duplicate`, `refused`, `apply-failed`), the refusal's reason, the plan id,
whether the step clamped it, and each project's micro-dollars before and after. It never carries a plan's reason
text: that is agent text, shown only in the panel.

`/dispatch priorities` shows the envelope, each project's floor, weight, share and spend this window, the applied
plan and the last outcomes, with no reasons. `dispatch_allocations` returns the same to a model, plus each spend
key's name.

## Change the envelope

`dispatch_envelope_set` changes any of `window`, `totalUsd`, `floorsUsd` (merged per id), `defaultWeights` (merged),
`enabled`, `writers`, `maxStepPct`, `minIntervalHours` and `maxPlanDays`. The worker's own parser judges the result
before the confirm, which shows each field before and after. It is refused with no operator present. After the
confirm it stores the new digest as `alloc:envelope:expected` in Valkey, then writes the file (tmp and rename, its
mode and owner kept), so every host re-bases onto it instead of refusing it as a hand edit. If the file cannot be
written, the key is put back. If Valkey cannot be reached, nothing is written.

The other admin writers check the envelope too. A project delete that removes a floored project, a scoped-limits
row below a project's floor, and a `maxCostUsd` change that removes the per-job cap are refused before the confirm,
naming the conflict. An envelope that already does not load does not block them.

## The panel

Press `b` in the panel list (`p` and `r` are pause and resume there). The view shows the envelope, each project's
floor, weight, share and spend this window with the Valkey key it counts under, the applied plan with the reason it
gave per project, and the newest 20 outcomes from `alloc:log`. Reasons are shown escaped: an invisible or
direction-changing character prints as `\u{...}`.

`r` on a history row asks, in the panel, whether to revert to it. `y` applies that row's weights as
`operator-revert`: an operator act, so it skips the interval and the step, but it is still refused while delegation
is off, while this host's envelope is not the applied one, or while another apply runs. A refused row has no split
to go back to.

A revert does not stop the manager. The interval restarts at the revert, and the next plan that is due may move the
split again. With `minIntervalHours` 0, the next run of the trigger can undo a revert at once. To keep a revert, turn
delegation off or remove the trigger's `run.portfolio` flag.

While an `envelope-changed-externally` outcome is newer than the last re-base or applied plan, the view opens with
the banner "changed outside the panel".

## The guard on pi's file tools

In your pi session the admin extension blocks pi's own `write` and `edit` tools when the file they would write is the
envelope, `projects.json`, `scoped-limits.json`, `triggers.json`, the settings file, the deployment's `.env` (which
names those files) or the deployment pointer. Which files those are:

- with a pointer (`/dispatch setup` writes one), the paths it and its folder's `.env` set;
- with no pointer, the paths your environment sets, every one of those files the `.env` in the folder you started pi
  in names (that `.env` is guarded too, and it is never read for anything else), and, when that folder is an `init`
  folder (its `.env`, `triggers.json`, `pause-windows.json` and `subscriptions.json` are all there), its
  `triggers.json`, `scoped-limits.json` and `projects.json`;
- in any other folder, a repository's own `triggers.json` or `projects.json` is left alone.

A deployment the panel cannot see at all (no pointer, no key set, and not the folder pi started in) is not guarded.
The set only grows within a session: pointing `.env` at another file does not unguard the one guarded before.

The path is resolved the way pi resolves it (`~`, an `@` prefix, Unicode spaces, `file://`, relative to the session's
folder) and compared by file identity, so a symlink, a hard link or a case variant counts (a not yet existing name is
compared fully case-folded, so a long s or a Kelvin sign does not slip past). A call made from inside another tool (a
codemode script) is blocked too. A `powershell` command that names one of the files is blocked.

What it cannot see, named in [`SECURITY.md`](../SECURITY.md): `bash`, a `powershell` command that builds the name
at run time or uses an 8.3 short name (`PROJEC~1.JSO`), your own `!` commands, a later extension that rewrites a tool's path after the guard ran, and a link
planted by `bash` in the same message as the write. An envelope edit made that way is still detected by its digest.

## Audit

- Every plan, refusal, expiry and re-base is a line in `PI_LOGS_DIR/allocations/YYYY-MM.jsonl` on the host that acted.
  It holds the weights, the micro-dollars before and after, and the outcome and its reason. An applied row also holds
  the plan's reasons.
- Valkey `alloc:log` keeps the last 500 outcomes across hosts, with no plan reasons (agent text).
- If the disk refuses the row of a change the worker made itself (the neutral split, an expiry, a re-base), the
  change stands, the worker logs `allocation_audit_row_lost`, and that row is kept only in `alloc:log`.
- The files follow `PI_LOG_RETENTION_DAYS`.

## Reference

| Piece | Value |
|---|---|
| Env var | `PI_ENVELOPE_FILE` (absolute, canonical path; unset = no envelope. An EMPTY value is NOT unset: the worker keeps it and refuses to start, so fill the line in or delete it, and doctor fails on it) |
| Needs | `PI_MAX_COST_USD` |
| Refusal reasons | `allocation-cap`, `envelope-mismatch`, `portfolio-no-envelope`, `portfolio-snapshot-oversize`, `local-folder-escaped`, `local-folder-holds-envelope`, `local-folder-project-changed` |
| Plan reasons (run record `plan`) | `plan-absent`, `plan-not-portfolio`, `plan-oversize`, `plan-not-regular-file`, `plan-unreadable`, `plan-parse-error`, `plan-collect-error`, `plan-invalid`, and the apply ladder |
| Job files | `/job/portfolio.json` (in), `/outbox/priorities.json` (out) |
| Valkey | `alloc:plan`, `alloc:lock`, `alloc:log`, `alloc:envelope:expected` |
| Tools | `dispatch_allocations` (read), `dispatch_priorities_set` (no confirm), `dispatch_envelope_set` (confirm) |
| Commands | `/dispatch priorities`, `/dispatch priorities set <id>=<weight> ...` |
| Panel | `b` in the list; `r` on a history row reverts |
| Audit file | `PI_LOGS_DIR/allocations/YYYY-MM.jsonl` |
| Host registry | `fpEnvelope`: the envelope digest, or `none`; doctor fails for a host whose digest is not the applied split's |
| Spec | `REQ-DELEGATED-ALLOCATION`, `DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE`, `INT-ENVELOPE-FILE-CONTRACT`, `INT-PRIORITIES-PLAN-CONTRACT`, `INT-OUTBOX-CONTRACT`, `INT-CONTAINER-JOB-INPUTS` |
