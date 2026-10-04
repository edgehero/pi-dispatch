# Allocation envelope

The envelope is the outer limit you set once: a dollar total for one window and a floor per project. Inside it, a
priorities plan moves headroom between projects with no keypress. The plan holds weights, never dollars, and
pi-dispatch does the arithmetic. A job over its project's share is refused before anything is spent.

The tools that write a plan, and the panel view that shows the split, come with the next part of issue #504. This
page covers the file, how the worker applies and enforces the split, and what it refuses.

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
`envelope-mismatch`, and its log and the audit file say `envelope-changed-externally`. To accept a hand edit before
the admin tool exists:

1. Install the new file on every host. Until a host has it, and until step 2, the hosts that differ refuse their jobs
   as `envelope-mismatch`, and those refusals are not retried, so make the change at a quiet time.
2. Set the key to the new digest (the worker logs it as `envelope_loaded` at start and `envelope_reloaded` on a
   change, and doctor prints it):

```sh
valkey-cli SET alloc:envelope:expected <digest>
```

The next job on each host re-bases the split.

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
| Refusal reasons | `allocation-cap`, `envelope-mismatch`, `local-folder-escaped`, `local-folder-holds-envelope`, `local-folder-project-changed` |
| Valkey | `alloc:plan`, `alloc:lock`, `alloc:log`, `alloc:envelope:expected` |
| Audit file | `PI_LOGS_DIR/allocations/YYYY-MM.jsonl` |
| Host registry | `fpEnvelope`: the envelope digest, or `none`; doctor fails for a host whose digest is not the applied split's |
| Spec | `REQ-DELEGATED-ALLOCATION`, `DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE`, `INT-ENVELOPE-FILE-CONTRACT`, `INT-PRIORITIES-PLAN-CONTRACT` |
