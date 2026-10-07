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
| `pi-dispatch up` | **sets the variable** in `.env` to the `scoped-limits.json` in the folder it runs in, if `.env` does not already give it a value |

Run `init`, manage limits through the panel, and you are editing a file the worker never reads — the
panel answers `scoped limit added (live)` while the worker enforces nothing. `pi-dispatch doctor` warns
about exactly this state, and the wizard's deployment pointer carries the path so a pointed panel and the
worker agree. `pi-dispatch up` sets the variable for you in a deployment folder, and doctor reads
the `.env` in its own cwd for this key: where that file configures the service, the line says so rather than
reporting the shell's view of it, and where that file would stop the service starting, doctor fails. The same
rule `docs/pause-windows.md` describes, for the same reason.

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

- `version`: required, `1` (or `2` for the dollar fields below, or `3` for a project's job size). A file stamped by a newer pi-dispatch refuses loudly on both sides rather
  than being read with its new fields silently dropped (a dropped cap field would be a silently widened
  spend limit). The tools refuse to write over a newer or version-less file for the same reason.
- `scope` — a forge `"owner/name"` or a local folder path, matched **exactly** against the job's scope.
  No globs (a scope containing `*` is refused at parse), no org-level matching. A bare `"acme/web"` covers that
  repo on every forge as one shared limit. To limit one forge's repo, qualify it: `"github:acme/web"`,
  `"gitlab:..."`, `"forgejo:..."` or `"azure:..."`. Then a GitHub job and a Forgejo job for `acme/web` count
  separately. An unknown prefix such as `"gitub:acme/web"` refuses the file, and so does a bare row beside a
  qualified row for the same repo: keep one form. The repo after the prefix is written as the forge shows it:
  `owner/name`, `group/sub/project` on GitLab or `project/repo` on Azure DevOps, with no trailing `/`, no `#12` and
  no space at the start or end of a part (a space inside one, as Azure allows, is fine). A qualified row needs
  `"version": 2`, which the panel and the tools write for you; an older worker then refuses the file instead of
  silently ignoring the row. A bare row keeps the count it had before qualified scopes existed. Rewriting a row's
  scope (bare to qualified, or any rename) starts a new count; the old one expires on its own. Jobs already running
  keep their slot under the old scope until they finish, and the new row counts from zero, so with `concurrent: N`
  up to 2N jobs can run until then. Doctor warns about a bare row when your triggers use more than one forge. Write local
  folder scopes as **absolute paths**: the worker resolves a job's folder before matching, so a relative
  row can never match a local job (doctor flags dead folder scopes, when `PI_SCOPED_LIMITS_FILE` is
  set). Spelling variants of one directory (trailing slash, `..` segments) collapse onto one scope.
- `day` / `week` / `month` — optional integers, each at least 1: max jobs per UTC day, per Monday-start
  UTC week, per calendar month. Counted beside the global windows; whichever refuses first refuses the
  job.
- `concurrent` — optional integer, at least 1: the scope's in-flight ceiling, enforced by deferral.
- At least one limit field is required per row; duplicate scopes refuse the file.

### Dollar windows and model rows (version 2)

Version 2 adds dollar caps (issues #501 and #502). Set `"version": 2` to use them:

```json
{
  "version": 2,
  "limits": [
    { "scope": "acme/web", "day": 10, "dayUsd": "5", "monthUsd": "60" },
    { "scope": "model:openai/gpt-5.4", "weekUsd": "25" }
  ]
}
```

- `dayUsd` / `weekUsd` / `monthUsd` on a repo or folder row: what that scope's jobs may spend per UTC day,
  Monday week and month, in dollars. Write them as strings (`"2.50"`). The rules are the overlay's: above 0,
  at most 1000000, at most 6 decimals, no exponent.
- A `model:<provider>/<model>` row caps what every job spends on that model, in every scope. It carries only
  the three dollar fields. `day`, `week`, `month` and `concurrent` are refused on it.
- A version 1 file that uses either is refused, and the error names version 2. A version 1 file without them
  works as before, with one exception: a row whose scope starts with `model:` in any spelling (`Models:x`,
  `model :x`) is refused at load, so the worker will not start. Such a row never matched any job, so fix it or
  remove it. The panel and the tools write version 1 until a row needs version 2.
- Each job reserves its per-job cost cap (`maxCostUsd`) in every window that applies, together with the
  deployment's dollar windows. If any window has no room, the job is refused (`dollar-cap`) and everything it
  reserved is given back. Under an allocation envelope the job's project share, its repo share or the envelope
  total can be smaller than the row or the window, and a window bound by one of those is refused `allocation-cap`
  ([allocation.md](allocation.md)). So a dollar row needs a per-job cap: a job with none is refused
  `config-refused`.
- Which model rows a job reserves in: a job with an allowed-model list (`run.models` or `PI_ALLOWED_MODELS`)
  reserves only in the rows of its listed models. A job with **no list** reserves in **every** model row,
  because it can switch to any model while it runs. Give such triggers a list if a full model window should
  not stop them.
- After the run, a repo or folder window is charged what the job cost, like the deployment's. A model window
  is charged what that model cost, from the run's per-model usage. When that split is not known (a folded usage
  ledger, spend on no named model, no ledger, or a cost that is not fully known), the model window keeps at
  least the whole hold. The run record says which under `dollars.modelBasis`.
- The dollar counters live under `budget:usd:s:<16 hex>` (a scope or a project) and `budget:usd:mdl:<16 hex>`
  (a model, hashed in lowercase).
- A scope must be written exactly. `Model:openai/x`, `models:openai/x` and `model :openai/x` are refused rather
  than read as a repo name, and so are `Project:shop`, `projects:shop` and `project :shop`.

### Project rows

A `project:<id>` row caps every repo and folder of one project as one. The id is a project in
[`projects.json`](projects.md).

```json
{
  "version": 2,
  "limits": [
    { "scope": "github:acme/web", "day": 10 },
    { "scope": "project:shop", "day": 20, "concurrent": 2, "dayUsd": "15" }
  ]
}
```

- `day` / `week` / `month` count every member's jobs together. Over the cap, the job is refused before any
  spend with reason `project-cap`. A project row needs `"version": 2`, even with counts only, because the
  previous release would read it as a repo name and ignore it. The panel and the tools write version 2 for you.
- `concurrent` bounds how many of the project's jobs run at once, across every member and every host. The
  excess is deferred, like a repo's.
- `dayUsd` / `weekUsd` / `monthUsd` cap what the project's jobs spend. A job that does not fit is refused `dollar-cap`, and the comment says "this project".
  Under an allocation envelope the cap for the envelope's window is the smaller of the row and the project's share; a
  job refused by the share is `allocation-cap`. The limit tools refuse a row below the project's envelope floor
  before the confirm, naming both ([allocation.md](allocation.md)).
- A job is counted narrowest first: its repo or folder row, then its project's row, then the global caps. A
  refusal gives back the slots taken before it, so a full project does not use up its repos' counts, and a full
  global cap uses up neither.
- The id must be in `projects.json`. A row whose id is not there stops the worker from starting, and doctor
  fails naming it. A live edit that would create one is kept out (the worker keeps the last good file and logs
  it, naming the row and both files). The worker judges the two files together, so you can save them in either
  order: adding a project with its row, or renaming a project in both files, applies once both are saved. The
  panel and the tools refuse to write such a row. They check the projects file the worker reads, so with
  `PI_PROJECTS_FILE` unset there are no projects. If a row already dangles, they still let you delete it or edit
  other rows, and say the worker applies the change once its live projects define that id. The worker's live
  projects usually still do, because it kept out the projects edit that dropped it. Run `pi-dispatch doctor`.
- The counters live under the same hashed keys as every other row, built from `project:<id>`. Renaming a
  project starts a new count.
- The panel's limits view shows a project row with its counters and how many members it caps, or
  `not in projects.json` when its project is missing. The DOLLAR WINDOWS section folds a project row's records by
  the `project` id each record carries.
- `dispatch_project_delete` refuses while a row names the project. Delete or change the row first.
- The panel and the tools refuse to write this file when it is a symlink (edit the real file, or set
  `PI_SCOPED_LIMITS_FILE` to its path), keep its mode, owner and group (or refuse when they cannot), refuse a file
  they cannot read, and refuse a write when this file or `projects.json` changed after the change was built from
  them, the confirm dialog included.

Things to know before you add a model row:

- **One model row can block jobs that never use it.** An unrestricted job (no list) holds its cap in every model
  row, so a full row for one model refuses unrestricted jobs that only call another. Give such triggers a
  `models` list, or set `PI_ALLOWED_MODELS`.
- **A window below the per-job cap refuses every job that reaches it, every time.** A job holds its whole cap,
  so a `dayUsd` of 1 with a `maxCostUsd` of 2 never admits one. The refusal says the budget is smaller than the
  run's cost limit (not "no room left"), and `pi-dispatch doctor` warns about such a row. A trigger with a
  smaller `run.maxCostUsd` still fits.
- **A dollar row needs a per-job cap.** With no `maxCostUsd` set (env or overlay), every job a dollar row applies
  to is refused `config-refused`, unless its trigger sets `run.maxCostUsd`. The worker logs
  `scoped_limits_dollar_rows_without_cap` at boot and on each reload, and doctor warns.
- **A floor charges every model row it held.** When a run's cost is not fully known (for example a 401 before
  any answer, or a run the worker stopped), each model window it held keeps at least the whole cap, whether the
  job called that model or not. With N model rows, one such run charges N caps across them.
- **A listed fallback is charged to the requested model.** When a provider answers with one of the model's
  allowed fallbacks, the usage ledger names the requested model, so its window pays.
- **An extension can dodge a model window.** A provider or alias an extension registers inside the job gets
  its own ledger row, which matches no model row. A model row bounds the ids it names; a `models` list is what
  stops a job from reaching others.

### Job sizes (version 3)

A `project:<id>` row can also say how big each of the project's job containers is. Heavy projects get more
memory, light ones less. This section is the reference for the four fields; [sizing jobs](sizing.md) walks through
measuring, setting sizes and the host budget, with a worked example.

```json
{
  "version": 3,
  "limits": [
    { "scope": "project:shop", "memory": "8g", "cpus": 4 },
    { "scope": "project:docs", "memory": "1g", "cpus": 0.5, "concurrent": 2 }
  ]
}
```

- `memory`: the memory each job gets, a whole number of megabytes or gigabytes in lower case: `"512m"`,
  `"1536m"`, `"8g"`. At least `512m`, at most `1024g`. The file keeps one spelling: `"1024m"` is written back as
  `"1g"`. A job gets **no swap beyond its memory** wherever the runtime enforces swap limits: a job that needs more
  needs a bigger size. Docker with `SwapLimit` false (no swap accounting in the kernel) drops that bound; doctor
  warns, and the worker logs `size_bound_unenforced` for each job it runs there. When a job runs out, it ends
  `oom-killed` and is not retried ([insights](insights.md)).
- `cpus`: a number with at most two decimals, at least `0.25`: `0.5`, `2`, `1.25`. It is a **weight, not a cap**.
  When jobs compete for CPU, a job with more `cpus` gets more CPU than one with fewer. The split is exactly in
  proportion only on older container runtimes (runc 1.1, crun 1.14: sizes 3:1 got about 3:1, measured); current
  ones compress it (runc 1.5, crun 1.27: sizes 3:1 got about 2.4:1). When the host is idle, any job may use the
  idle cores. No single job may use more than the host's CPU budget (by default the host's cores minus one, when it
  has four or more; see [the host budget](multi-host.md#the-host-budget)). That bound is per job; what keeps the
  reserve free across all jobs together is the parent cgroup they share
  ([the CPU reserve across all jobs](multi-host.md#the-cpu-reserve-across-all-jobs)), inside which the weights still
  order the jobs.
- A row may set only a size, only one of the two, or a size beside its caps. A field the row does not set comes
  from `PI_JOB_MEMORY` and `PI_JOB_CPUS` in `.env`, which default to `4g` and `2`. A bad value there stops the
  worker at boot with the reason.
- A size is only allowed on a `project:<id>` row. On a repo, folder or model row it refuses the file.
- `hostShare` (a whole percentage from 1 to 100) is the most of one host's [budget](multi-host.md#the-host-budget)
  the project's running jobs may hold together, in memory and in CPU. A job that would take the project past it
  waits, and holds no room while it does. A size larger than the share of a host's budget can never start there: a
  job on that host's own queue, or any job on a host without `PI_WORKER_NAME`, is refused before anything is spent
  (`job-size-exceeds-share`), and a job on the shared queue of a host with `PI_WORKER_NAME` waits for a host whose
  share fits it.
- `minJobs` (an integer, at least 1) is how many of the project's jobs a host makes room for first. While the project
  runs fewer than that on a host, its oldest waiting job holds room there that no newer job may take. It is a soft
  minimum: it never stops a job that is already running. `minJobs` needs `memory` or `cpus` on the same row and may
  not be above its `concurrent`.
- Whether a host's budget can hold a project's `minJobs` times its size inside its `hostShare`, and every project's
  minimum together, depends on that host, so the file accepts it and `pi-dispatch doctor` warns where it cannot.
- A size needs `"version": 3`. The panel and the tools write it for you, and only when a row has a size. A
  version 3 row refuses a key it does not know (a misspelled `Memory` or `cpu`), so a typo cannot silently drop a
  size.
- **Upgrade and restart every worker before you write a size.** An older worker refuses a version 3 file only when
  it starts. One that is already running keeps its last good file when the file changes (it logs
  `scoped_limits_reload_invalid`), so neither the size nor any later edit to the file (job counts, `concurrent`,
  dollar caps) applies on it until it is upgraded and restarted, and nothing on its jobs says so. On a fleet, doctor
  warns about each worker that predates sizes once this host's file is version 3, including a file that only
  declares `"version": 3` with no size in it.
- The worker reads the size when it picks a job up, so an edit applies to the project's next jobs. A running job
  keeps its size. A retry or a deferred job is a new pickup: it takes the size in force then, not the size of its
  first attempt. Each run record says the size the job got and where it came from (`size` in the record).
- A reopened [sandbox](sandbox.md) gets the size its run had. A run whose recorded size is damaged does not open.

What a size does not cover: disk I/O, disk space and the network are not limited per job.

#### Choosing a size from the runs

pi-dispatch suggests a size for each project from what its recent runs used. It never applies one: you do, with the
call it names.

- **Where you see it.** `pi-dispatch doctor` prints one line per project. The panel's PROJECTS view (`j`) shows each
  project's size, the p95 of its runs' memory peaks and cores used, the suggestion, and the exact call that applies it
  (wrapped onto as many lines as it needs, never cut and never broken inside a quoted value; join the lines before
  running it, as the line under it says). When you edit a project row's `memory` or `cpus` with `dispatch_limit_edit`,
  its confirm shows the project's peaks and what they suggest. The [insights
  page](insights.md#what-each-run-records-about-resources) draws each run's peak against its size.
- **What it reads.** The project's runs of the last 30 days, at most the newest 50, that recorded both what they used
  (`resources`) and what they were given (`size`). Runs from before those fields are ignored, and so are refusals (a
  job refused before its container started records neither, and never pushes a measured run out of the 50), and so is
  a record file larger than 256 KiB (doctor and the panel say how many they skipped). In each of memory and CPUs, the
  runs given at least the current size decide, so a raise you just made is not asked for again by the run that caused
  it.
- **Memory is raised only after an OOM kill.** A run that ended `oom-killed` at the current size or larger suggests
  1.5x the larger of the size and the largest size in the window that was killed. One step per kill: the run that
  caused a raise does not count once the raise is applied.
- **A peak at the limit raises nothing.** `memory.peak` counts the page cache, and a job that only reads files fills
  it up to its limit with no harm (measured: a 512m container reading 1.2 GB of files peaked at exactly 512m, with no
  OOM kill). When runs at the limit were also stalled for memory (the kernel's memory pressure, above 1% of their
  time), the line says so as a fact. It is information, with no call.
- **Memory is lowered** with at least 10 runs when 1.25x the p95 peak is at most 0.75x the size, to that, but never
  below 1.25x the largest peak in the window, nor 1.5x the largest size in the window that was killed, nor 512m. So
  two heavy runs among fifty still hold the size up, and a size an OOM caused is not lowered back to it.
  Sizes are rounded up: to 256m steps up to 2g, 512m steps up to 8g, then whole gigabytes.
- **CPUs are only ever lowered.** With at least 10 runs, when the p95 of the cores used is below 0.4x the size, to
  1.25x that p95, but never below 1.25x the busiest run in the window, nor 0.25. Steps of 0.25. A job's `--cpus` is
  this host's CPU ceiling, the same for every job, and its size is only its weight, so a job held back by the ceiling
  is held back the same at any size (measured: the same throttled time at 1024 and 4096 shares). When the median run
  was held back more than 25% of its time, the line says so as a fact about the host, with no call. A run's time is
  counted from pickup, clone included, so cores used read a little low.
- **What this host offers caps every suggestion.** A raise never goes past this host's budget in that dimension
  (`PI_HOST_MEMORY_BUDGET`), or the project's `hostShare` of it when its row has one (50% of a 10g budget caps it at
  5g, the most a job of it may take here), or, where the budget is `off` or not yet known, past the host's own memory.
  Where the runs ask for more, the suggestion is that cap and says "this project's runs need more than this host
  offers". Where the size already is the cap, doctor warns "already at the largest size this host offers" (or "already
  above" it, naming the cap, when the size was set larger) and offers no call. Where nothing about the host is known,
  a raise offers no call at all; the panel says whether no host budget was read as a number, no live host's budget holds the project's
  size, or every live host's budget is off. Nothing ever suggests growing the host's budget: that budget is what the
  host promised every other project. The panel and the insights page cap per live host, each judged on its own pair of
  budgets (a host with lots of memory and too few CPUs for the project does not count), and the edit's confirm reads
  no budget and says so.
- **One rule decides whether a call is offered: exactly when the worker would admit the suggested job.** The job is
  the size the call would leave (the suggested memory and CPUs, or the current ones where nothing is suggested).
  Doctor offers no call when this host's budget is a number and the job is above it, or above the project's
  `hostShare` of it; with the budget `off` or unknown the worker refuses nothing, so the call is offered, and a size
  above the host's own memory is noted beside it. The panel and the insights page offer no call only when every live
  host that publishes a numeric budget would refuse the job. Where no call is offered, the line names what does not
  fit, for example "its 4 CPUs are above its hostShare (40%) of this host's budget (3.2 CPUs)".
- **When the scoped-limits file does not load,** doctor prints no size lines, only "size suggestions: off until the
  scoped-limits file loads": a size read without the file would be the default, not the project's.
- **The call.** `dispatch_limit_edit {"index":1,"memory":"6g"}` changes the project's row (the index is its place in
  this file); a project with no row gets `dispatch_limit_add {"scope":"project:shop","memory":"6g"}`. Either one asks
  you to confirm before it writes.
- **Why it is only a suggestion.** The numbers are measured inside the job's container, which runs code the job
  controls, so a job can make them up. Values that cannot be real are clamped or ignored, a raise needs a kill the
  worker confirmed, and no suggestion passes what the host offers. You decide.

## How it works

A job's scoped windows reserve **first**: its repo or folder row, then its project row, then the global
windows. So a capped repo's refusals never consume project or global slots. When a later window refuses, every
slot taken before it is given back, so a storm against a spent global cap cannot drain a scope's or a project's
week or month. A refund for a container that never started (docker fault), or for a job refused as
misconfigured, gives back every slot the job took.

Deferral re-checks on a fixed short interval. There is no per-scope queue: a newer job can take a freed
scope ahead of an older deferred one, and the only promise is that a deferred job is never dropped and
never billed while it waits. Edits apply live — the worker watches the file and keeps the last good
version on a bad edit (`scoped_limits_reload_invalid` in the log).

## Managing limits

Three doors, same as quiet hours:

- **The panel**: press `m` in `/dispatch` to add, edit or delete a limit through dialogs. The section
  shows each row's used/cap per window; `≤N at once` is configuration (per-scope in-flight lives inside
  the worker process and is not displayed anywhere).
- **The tools**: `dispatch_limits` lists rows with their indexes and used counts, and for a dollar row each
  window's cap and its counter (spent and held, in micro-dollars);
  `dispatch_limit_add` / `dispatch_limit_edit` / `dispatch_limit_delete` change them behind the same
  operator confirm dialog as every config write. The add and edit tools take `dayUsd`, `weekUsd` and
  `monthUsd` as decimal strings (`"2.50"`) and check them before they ask, with the worker's own rules. They
  write version 1 until a row needs version 2, and drop back to version 1 when the last dollar row goes. On a
  project row they also take `memory`, `cpus`, `hostShare` and `minJobs`, checked the same way and shown in the
  spelling the file will hold, and write version 3 only while a row has one. An edit keeps every field it is not
  sent. The panel's SCOPED LIMITS section shows a row's size beside its caps.
- **The dollar windows** of every row, with the deployment's, are in the panel's DOLLAR WINDOWS section and in
  `dispatch_costs` ([costs](costs.md#where-to-look)). A row's own dollar windows also show on its line in the
  panel's SCOPED LIMITS section and in the budget panel of the insights page, as spent and held over the cap.
- **By hand**: edit the file; the worker hot-reloads it.

## Caveats

- A `scope-cap` or `project-cap` refusal is final for that window. No tool resets a counter; the window rolls over on its
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
| Env var | `PI_SCOPED_LIMITS_FILE` (absolute path; unset = no scoped limits. An EMPTY value is NOT unset: the worker keeps it and refuses to start, so fill the line in or delete it, and doctor fails on it) |
| File | `{ "version": 1, "limits": [ { scope, day?, week?, month?, concurrent? } ] }`; version 2 adds `dayUsd?`, `weekUsd?`, `monthUsd?`, `model:` rows and `project:<id>` rows; version 3 adds `memory?`, `cpus?`, `hostShare?` and `minJobs?` on a project row |
| Job size | `PI_JOB_MEMORY` and `PI_JOB_CPUS` (default `4g` and `2`), unless the job's project row sets its own |
| Refusal reason | `scope-cap` (pre-spend, never retried); `project-cap` for a project row; `dollar-cap` for a dollar window; `allocation-cap` when an allocation envelope's split bound the window |
| Deferral | delayed set, fixed re-check, never dropped |
| Panel key | `m` |
| Tools | `dispatch_limits`, `dispatch_limit_add`, `dispatch_limit_edit`, `dispatch_limit_delete` |
| Projects | `PI_PROJECTS_FILE` groups repos and folders into a project, recorded per run and capped by a `project:<id>` row. It is wired like this key. See [projects.md](projects.md) |
| Allocation envelope | `PI_ENVELOPE_FILE`: a dollar total and a floor per project, split between projects by a priorities plan. See [allocation.md](allocation.md) |
| The folder mutex | always on for local jobs, max 1 per folder, no configuration anywhere |
