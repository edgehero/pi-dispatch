# Scoped limits — budget caps and concurrency per repo or folder

Every other spend control is deployment-global: the daily/weekly/monthly caps bound the whole worker, and
`PI_CONCURRENCY` is one integer. Scoped limits attach a bound to a **scope** — the folder for a local job,
the repo for a forge one — so one noisy repo can be capped without touching everything else.

Three mechanisms, and they behave differently on purpose:

- **`day` / `week` / `month`** cap how many jobs a scope may run per window. Over the cap, the job is
  **refused before any spend** (reason `scope-cap`, a policy refusal, never retried). The scope's counter
  keeps the refused attempt, exactly as the global windows do.
- **`concurrent`** caps how many of a scope's jobs run at once. Over the ceiling, the job is **deferred**
  to the queue's delayed set and re-checks every few seconds — never dropped, never refused, no budget
  spent while waiting.
- **The folder mutex needs no file.** Local jobs bind-mount your real directory read-write, so the worker
  holds at most **one local job per folder** in flight — always on, no configuration, no tool, no panel
  key, no off switch. The guard lives inside the worker process; one worker per docker daemon is the
  supported shape, so that is the whole deployment. Two agents editing one working tree race each other
  with no gate and no undo; an off switch's only use would be re-opening that race. A `concurrent` value
  on a folder scope is inert — it can never raise the mutex's one-at-a-time, and a resolved folder scope
  matches no forge job.


**On more than one machine** ([`multi-host.md`](multi-host.md)): the one-job-per-folder guard is still
per worker process, and that stays correct because a local folder lives on one machine and its jobs are
routed there. A `concurrent` limit on a **repository** is different: any host can run a forge job, so
that ceiling was per process and multiplied by host count until it became fleet-wide. It is shared now,
once a worker name is declared. The day/week/month caps on the same row were always shared.

## Enable it

```sh
# .env
PI_SCOPED_LIMITS_FILE=/absolute/path/to/scoped-limits.json
```

Unset means the worker enforces no scoped caps and no scoped concurrency (the folder mutex holds
regardless — it is code, not configuration). A configured file that does not parse **refuses worker
startup**, deliberately: this is money enforcement, and a silently dropped file would be a silently
unbounded deployment.

### Set the variable, even though two other things behave as if you had

The same trap quiet hours documents, scoped-limits edition:

| Who | What it uses when `PI_SCOPED_LIMITS_FILE` is unset |
|---|---|
| **The worker**, the only thing that enforces | nothing: **no scoped caps or concurrency are loaded** |
| `pi-dispatch init` | **scaffolds** `./scoped-limits.json` and leaves the variable **commented out** in `.env` |
| **The `/dispatch` panel** (and the `dispatch_limit_*` tools) | defaults to `./scoped-limits.json` in **the panel's own cwd** |

Run `init`, manage limits through the panel, and you are editing a file the worker never reads — the
panel answers `scoped limit added (live)` while the worker enforces nothing. `pi-dispatch doctor` warns
about exactly this state, and the wizard's deployment pointer carries the path so a pointed panel and the
worker agree.

## The limit schema

The committed `scoped-limits.example.json` is the template to copy rows out of; `pi-dispatch init`
scaffolds the empty form.

```json
{
  "version": 1,
  "limits": [
    { "scope": "acme/web", "day": 10, "week": 40, "concurrent": 1 },
    { "scope": "/srv/site", "month": 60 }
  ]
}
```

- `version` — required, `1`. A file stamped by a newer pi-dispatch refuses loudly on both sides rather
  than being read with its new fields silently dropped (a dropped cap field would be a silently widened
  spend limit). The tools refuse to write over a newer or version-less file for the same reason.
- `scope` — a forge `"owner/name"` or a local folder path, matched **exactly** against the job's scope.
  No globs (a scope containing `*` is refused at parse), no prefixes, no org-level matching. Write local
  folder scopes as **absolute paths**: the worker resolves a job's folder before matching, so a relative
  row can never match a local job (doctor flags dead folder scopes, when `PI_SCOPED_LIMITS_FILE` is
  set). Spelling variants of one directory (trailing slash, `..` segments) collapse onto one scope.
- `day` / `week` / `month` — optional integers, each at least 1: max jobs per UTC day, per Monday-start
  UTC week, per calendar month. Counted beside the global windows; whichever refuses first refuses the
  job.
- `concurrent` — optional integer, at least 1: the scope's in-flight ceiling, enforced by deferral.
- At least one of the four is required per row; duplicate scopes refuse the file.

## How it works

A job's scoped windows reserve **first**, before the global reserve, so a capped repo's refusals never
consume global slots — and when the *global* window refuses after a scoped reserve, the scoped slot is
given back, so a storm against a spent global cap cannot drain a scope's week or month. A refund for a
container that never started (docker fault) releases both ledgers or neither.

Deferral re-checks on a fixed short interval. There is no per-scope queue: a newer job can take a freed
scope ahead of an older deferred one, and the only promise is that a deferred job is never dropped and
never billed while it waits. Edits apply live — the worker watches the file and keeps the last good
version on a bad edit (`scoped_limits_reload_invalid` in the log).

## Managing limits

Three doors, same as quiet hours:

- **The panel**: press `m` in `/dispatch` to add, edit or delete a limit through dialogs. The section
  shows each row's used/cap per window; `≤N at once` is configuration (per-scope in-flight lives inside
  the worker process and is not displayed anywhere).
- **The tools**: `dispatch_limits` lists rows with their indexes and used counts;
  `dispatch_limit_add` / `dispatch_limit_edit` / `dispatch_limit_delete` change them behind the same
  operator confirm dialog as every config write.
- **By hand**: edit the file; the worker hot-reloads it.

## Caveats

- A `scope-cap` refusal is final for that window. No tool resets a counter; the window rolls over on its
  own (UTC), and the counters expire from redis like the global ones.
- A scope deferral is visible only as the queue's delayed count (the panel's status line shows it when
  nonzero). That count also includes cron next-occurrences, retry backoff, quiet-hours deferrals and jobs
  held on [`run.waitFor`](wait-for.md), so a nonzero value is normal on any deployment with schedules.
  Only the last of those has a section of its own, because a wait is a per-trigger condition an operator
  wrote and a scope deferral is a ceiling that clears in seconds without anyone acting; a row per scope
  deferral would be a panel that redraws itself every few seconds saying nothing has gone wrong.
- The counters live under hashed keys (`budget:s:<16 hex>`) so scopes containing `:` or `/` cannot
  collide with the global key namespace; the panel and `dispatch_limits` recompute the hash from the
  configured scope to display used counts.
- Symlinked spellings of one folder, and case variants on a case-insensitive filesystem, are distinct
  scopes — the matcher resolves paths but does not consult the filesystem.

## Reference

| Piece | Value |
|---|---|
| Env var | `PI_SCOPED_LIMITS_FILE` (absolute path; unset = no scoped limits) |
| File | `{ "version": 1, "limits": [ { scope, day?, week?, month?, concurrent? } ] }` |
| Refusal reason | `scope-cap` (pre-spend, never retried) |
| Deferral | delayed set, fixed re-check, never dropped |
| Panel key | `m` |
| Tools | `dispatch_limits`, `dispatch_limit_add`, `dispatch_limit_edit`, `dispatch_limit_delete` |
| The folder mutex | always on for local jobs, max 1 per folder, no configuration anywhere |
