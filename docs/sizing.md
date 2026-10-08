# Sizing jobs

Every job runs in its own container, and every container has a **size**: the memory it may hold and the CPU weight
it gets (its **weight** is its share of the CPU when jobs compete for it, not a cap). Every worker also keeps a
**host budget**: how much memory and CPU its running jobs may hold together. A job starts only when its size fits
beside what already runs on that machine.

Out of the box every job is `4g` and `2` CPUs, and the budget is read from the machine. That is a sane start, and
this page is how you go from there to sizes that match your projects:

1. [Measure first](#1-measure-first): let the runs record what they use.
2. [Set a size per project](#2-set-a-size-per-project).
3. [The host budget](#3-the-host-budget): what a machine offers, and when a job waits or is refused.
4. [Fairness](#4-fairness-minjobs-and-hostshare): `minJobs`, `hostShare` and the room kept for a big job.
5. [The CPU reserve across all jobs](#5-the-cpu-reserve-across-all-jobs).
6. [Reading the suggestions](#6-reading-the-suggestions).

Then [a worked example](#a-worked-example) on one 64 GB machine with three projects. The reference for each setting
lives with its feature: [job sizes](scoped-limits.md#job-sizes-version-3) in scoped limits, [the host
budget](multi-host.md#the-host-budget) in multi host, and [what each run
records](insights.md#what-each-run-records-about-resources) in insights.

## What is isolated, and what is not

A size isolates **memory and CPU**, and nothing else.

- **Memory is a hard limit.** A job holds at most its `memory`, with no swap beyond it, and a job that needs more is
  stopped alone (`oom-killed`) while its neighbours keep running. Docker with `SwapLimit` false cannot hold the swap
  part; doctor warns there.
- **CPU is shared by weight, inside a ceiling.** Under contention a job with more `cpus` gets more CPU than one with
  fewer. No single job may use more than the host's CPU budget, and all jobs together stay inside it where the
  [CPU reserve](#5-the-cpu-reserve-across-all-jobs) is in place.
- **Processes** are capped at 512 per job, the same for every size.
- **Disk I/O bandwidth is not isolated.** Jobs share the disk: one job that reads or writes a lot slows the others.
- **Disk space is not isolated.** A job's clone, its build output and its container's writable layer all land on the
  machine's disk, and one job can fill it for everyone.
- **Network bandwidth is not isolated.** Jobs share the machine's link and the egress proxy in front of it.
- **The page cache counts toward a job's memory.** The page cache is the kernel's copy, in memory, of files read or
  written recently. Files a job reads fill the cache, and that cache is charged to the
  job. So a job that reads many files shows a memory peak at its limit even when it was never short: the kernel gives
  cache back before it kills anything (measured: a `512m` container reading 1.2 GB of files peaked at exactly `512m`,
  with no kill). That is why a peak at the limit raises no suggestion, and only a confirmed out of memory kill does.

## 1. Measure first

Change nothing yet. Every run already records what it was given and what it used:

- **`size`**: the memory and CPUs the job got (`memMiB`, `cpuCenti` in hundredths of a CPU) and where they came from
  (`project`, `env` or `default`).
- **`resources`**: what its container used, read from its own cgroup (the kernel's group that holds a container's
  processes and keeps count of, and limits, what they use) at the end of the run: the memory peak, CPU time,
  how long the CPU ceiling held it back, out of memory kills, memory pressure and the process peak. The fields are
  listed in [insights](insights.md#what-each-run-records-about-resources). A run on a job image from before sizes
  records `null` here, so pull or rebuild the job image first.

Where to see them:

- **The run record** itself, `<PI_LOGS_DIR>/<jobId>.json`.
- **The insights page** (`/dispatch insights`): its job sizes section draws each project's memory peaks over the last
  30 days against its size line, with every `oom-killed` run in red ([insights](insights.md#the-job-sizes-section)).
- **The panel's PROJECTS view** (`j` in `/dispatch`): each project's size and the p95 of its runs' memory peaks and
  cores used (the p95 is the value 95 of every 100 runs stay at or below, so one odd run does not move it).
- **`pi-dispatch doctor`**: one line per project with its size and what its runs suggest.

Only runs that carry both `size` and `resources` count, which means runs of an upgraded worker with an upgraded job
image: the count starts when you upgrade, not before. A lowering needs at least 10 such runs of the project in the
last 30 days (until then doctor says "not enough runs to suggest a size yet"), and a raise needs one confirmed out of
memory kill. These numbers are produced inside the job's container, which runs code the job controls, so read them
as advisory: a job can inflate them or report less.

## 2. Set a size per project

A size lives on a project's row in the scoped-limits file, so first group the repos and folders into projects
([projects](projects.md)). Then give the row a `memory`, a `cpus`, or both:

```json
{
  "version": 3,
  "limits": [
    { "scope": "project:shop", "memory": "8g", "cpus": 4 },
    { "scope": "project:docs", "memory": "1g", "cpus": 0.5 }
  ]
}
```

- **`memory`** is a whole number of megabytes or gigabytes: `"512m"`, `"1536m"`, `"8g"`. At least `512m`.
- **`cpus`** is a number with at most two decimals, at least `0.25`. It is a weight, not a cap: it decides how CPU is
  split when jobs compete, and an idle machine lets any job use the free cores up to the host's CPU budget.
- **Everything else gets the default:** `PI_JOB_MEMORY` and `PI_JOB_CPUS` in `.env`, `4g` and `2` unless you set
  them. A row that sets only one of the two takes the other from there. A bad value stops the worker at boot.
- **No swap beyond memory.** A job that needs more memory needs a bigger size, not swap.
- **`/dev/shm`** is half the job's memory, at most `1g`. Nothing sets it separately, and what a job writes there
  counts toward its memory.
- **Processes** stay at 512 per job whatever the size.
- **A size needs `"version": 3`,** and only a `project:<id>` row may carry one. The tools (`dispatch_limit_add`,
  `dispatch_limit_edit`) write the version for you, behind your confirm. The panel's limit dialogs (`m`) keep a row's
  size as it is and cannot set one.
- **Upgrade and restart every worker before you write a size.** An older worker refuses a version 3 file when it
  starts, and one already running keeps its last good file, so neither the size nor any later edit applies on it.
  Doctor warns about such a worker on a fleet.
- **An edit applies to the next pickup.** A running job keeps its size. A retry or a deferred job is a new pickup and
  takes the size in force then.

The full rules are in [job sizes](scoped-limits.md#job-sizes-version-3).

## 3. The host budget

`PI_CONCURRENCY` counts jobs, and a count cannot tell a `20g` job from a `2g` one. So each worker also keeps a budget
in memory and in CPU, set by four `.env` settings ([the full table](multi-host.md#the-host-budget)):

- **`PI_HOST_MEMORY_BUDGET` and `PI_HOST_CPU_BUDGET`** default to `auto`. `auto` reads the container runtime's own
  memory and CPU count (on Docker Desktop that is the VM's; on rootless Podman also the limits on the account's
  systemd user service), takes a reserve off for the machine itself, and never goes below one job of the default
  size.
- **The reserve** (`PI_HOST_RESERVE_MEMORY`, `PI_HOST_RESERVE_CPUS`, default `auto`) is 10% of the memory, at least
  `1g` and at most `4g`, and 1 CPU on a machine with 4 or more (else none). It is left for the system, the egress
  proxy, Valkey and the worker.
- **A value** (`64g`, `49152m`, `12`, `3.5`) is the budget itself: no reserve is taken from it. A value below one
  default job stops the worker at boot.
- **`off`** puts no limit on that resource. Only `PI_CONCURRENCY` then bounds it.
- The four budget settings are read from `.env` only, never from the panel's settings, and only when the worker
  starts, so a budget never moves under running jobs. Restart the worker after you change one.

To turn the budget off, so that only `PI_CONCURRENCY` bounds the jobs, put these lines in `.env` and restart the
worker:

```sh
PI_HOST_MEMORY_BUDGET=off
PI_HOST_CPU_BUDGET=off
```

To keep `auto` but change what it leaves for the machine, give a reserve a value: a memory amount such as `2g` or
`1536m`, a number of CPUs such as `0.5`, or `0` for none (`0g` is refused):

```sh
PI_HOST_RESERVE_MEMORY=2g
PI_HOST_RESERVE_CPUS=0.5
```

**On Docker Desktop the budget is the VM's,** not your computer's. To give jobs more, raise the memory and CPUs of
the VM in Docker Desktop's settings (Resources), then restart the worker so it reads the new size at once.

**`PI_CONCURRENCY` is the third dimension.** The budget counts it beside memory and CPU, and whichever is reached
first applies. Doctor says which one binds on this machine. On a small machine the budget may run fewer jobs than
`PI_CONCURRENCY` allows: a 4 CPU machine has a CPU budget of 3, which holds one default job of 2 CPUs at a time.

**A job's `cpus` count as CPU set aside for it**, although the runtime only uses them as a weight. So a job's `cpus`
must fit the CPU budget beside what already runs, even on an idle machine.

**A job waits** when its size could fit this machine but does not fit right now. It goes back to the queue, asks
again about every nine seconds, keeps its place in line, and is never dropped or billed while it waits.

**A job is refused** when its size can never fit: larger than the budget (`job-size-exceeds-host`), or larger than its
project's `hostShare` of it (`job-size-exceeds-share`). It is refused before anything is spent, no container starts,
and the forge comment names neither size (the worker log and the run record do). When that happens depends on the
setup:

- **A single machine** (no `PI_WORKER_NAME`) refuses every such job: there is no other machine to wait for.
- **A fleet** (`PI_WORKER_NAME` set) refuses only a job on this machine's own queue (its folders, its wait checks),
  which can run nowhere else. A job on the shared queue is never refused for its size: it is put back for 60 seconds
  for a machine it fits on, and doctor warns about a project that fits on no live machine. See [the host
  budget](multi-host.md#the-host-budget).

## 4. Fairness: `minJobs` and `hostShare`

Without anything more, a stream of small jobs could take every core the moment it frees, and a big job behind them
would wait forever. Two optional fields on a project row, and one rule that needs no setting, prevent that.

- **Room kept for the oldest waiting job.** The worker keeps room for the oldest job that waits for the budget, in
  memory, CPU and a job slot, so a smaller job that arrives later cannot take it. While that room is kept the machine
  may run below full for a moment: that is the price of not starving the big job.
- **`minJobs`** (an integer, at least 1) is a soft minimum per machine. While the project runs fewer than that many
  jobs here, its oldest waiting job has room kept for it ahead of the oldest waiting job of all. It never stops a job
  that is already running. It needs a `memory` or `cpus` on the same row and may not be above the row's
  `concurrent`.
- **`hostShare`** (a whole percentage, 1 to 100) caps how much of one machine's budget the project's running jobs may
  hold together, in memory and in CPU (not in job slots). A job that would take its project past it waits, and keeps
  no room while it does.
- **Room is not kept for a job something else holds back.** A job deferred by another gate (a full scope, a busy model
  server, a pause window) keeps its place in line but no room. A job that stops coming back (finished elsewhere,
  removed) loses its place after a check of the queue.

Whether a machine can keep every minimum depends on its budget, so the file accepts any `minJobs`, and doctor warns
when a project's `minJobs` times its size is more than its `hostShare` of the budget, or when all projects' minimums
together are more than the budget.

## 5. The CPU reserve across all jobs

A job's `--cpus` ceiling bounds that one job. Several busy jobs together could still use every core, the reserved one
included. So every job container, sandbox and doctor probe runs inside one parent cgroup, `pidispatch.slice`, whose
CPU quota is the CPU budget. All jobs together then stay inside the budget, and the reserve stays free for the egress
proxy, Valkey, the worker and the rest of the machine.

Who sets that quota, and whether doctor can read it back, depends on the container runtime:

| Runtime | Who sets the quota | Does doctor read it back |
|---|---|---|
| Rootless Podman | The worker, at start and whenever the budget changes, through your account's systemd user manager. It survives a reboot. | Yes |
| Docker Desktop, and Docker with the `cgroupfs` driver | The worker, at start, through a short helper container of the job image. A Docker Desktop restart drops it; the worker checks it every ten minutes and writes it again. | Yes |
| Docker with systemd on this machine | You, once, as root. It survives a reboot. Doctor prints the exact command with your budget. | Yes |
| Rootful Podman, and a Docker daemon with systemd on another machine | You, once, as root on the machine the containers run on. It survives a reboot. Doctor prints the command. | No |
| Rootless Docker | You, once, as the daemon's account, with `systemctl --user`. Doctor prints the command. | No |

For a CPU budget of 15 the root command is:

```sh
sudo systemctl set-property pidispatch.slice CPUQuota=1500%
```

**What that command does.** It puts a CPU limit on `pidispatch.slice`, the systemd group every job container runs
in: all jobs together may use at most 15 CPUs (`1500%` is 15 times one CPU). systemd saves the setting, so it
survives a reboot, and you run it once. When the CPU budget changes (a bigger machine, a new `PI_HOST_CPU_BUDGET`),
run it again with the new number; on Docker with systemd doctor tells you when the quota differs from the budget. To
remove it, run the same command with nothing after the `=`:

```sh
sudo systemctl set-property pidispatch.slice CPUQuota=
```

**Where doctor reads the quota back** (rootless Podman, Docker Desktop and Docker's `cgroupfs` driver, Docker with
systemd on this machine), it warns "no host CPU reserve across jobs" with the command when the quota is missing or
differs from the budget, and the warning goes away once the quota is right. **Where it cannot** (rootful Podman,
rootless Docker, a Docker daemon on another machine), nothing can read the quota from here: doctor always warns "no
host CPU reserve across jobs" and says why (the worker does not manage that slice, or it cannot be read from here),
even after you ran the command, and the worker logs `cpu_reserve_fail_open` with the status `unmanaged`. On a host
with cgroup v1 no quota is kept at all. Jobs run in every case, inside the parent. Where rootless Podman uses the
`cgroupfs` cgroup manager, jobs run without the parent and each job's CPU weight is capped at the default, so the
proxy and Valkey get a fair share of the CPU, not a reserve.

On Docker Desktop and Docker's `cgroupfs` driver the helper is a container of the job image, so the job image must be
present: without it doctor says "the quota of pidispatch.slice was not readable (job-image-absent)", and the worker
cannot write the quota either. Pull or build the job image, then restart the worker.

**With `PI_HOST_CPU_BUDGET=off`** the worker clears the quota only where it sets it itself (rootless Podman, Docker
Desktop and Docker's `cgroupfs` driver). A quota set with `sudo` stays, and keeps all jobs together under it, until
you clear it with `sudo systemctl set-property pidispatch.slice CPUQuota=`. On Docker with systemd doctor warns about
it: "the CPU budget is off, but pidispatch.slice still has a quota of 15 CPUs, so jobs together are held to it".

There is no memory limit across all jobs, on purpose: when a group of containers runs out of memory together, the
kernel kills the largest job in the group, not the one that grew. The budget keeps the sizes inside the memory budget
instead. The details per runtime are in [the CPU reserve across all
jobs](multi-host.md#the-cpu-reserve-across-all-jobs) and, for Podman, [the CPU reserve on this
venue](podman.md#the-cpu-reserve-on-this-venue).

## 6. Reading the suggestions

pi-dispatch suggests a size for each project from its measured runs of the last 30 days (the newest 50 at most).
It reads the run records of this machine only (`PI_LOGS_DIR`), so on a fleet each machine suggests from its own runs
unless the machines share that directory. The same runs and the same rules show in four places:

- **`pi-dispatch doctor`**: one line per project, with the exact call that applies it.
- **The panel's PROJECTS view** (`j`): the size, the p95 peaks, the suggestion and the call.
- **The insights page**: the suggestion above each project's chart of peaks against its size.
- **`dispatch_limit_edit`**: when you change a project row's `memory` or `cpus`, its confirm shows the project's
  peaks and what they suggest.

How to read one:

- **Memory is raised only after a confirmed out of memory kill** at the current size or larger (a kill at a smaller
  size, from before an earlier raise, does not raise it again). A run that ended `oom-killed` suggests 1.5 times
  the larger of the size and the largest size killed in the window. A peak at the limit raises nothing (the page
  cache, above); when such runs were also stalled for memory, the line says so as a fact, with no call.
- **Memory is lowered** when 1.25 times the p95 peak is at most 0.75 times the size, never below 1.25 times the
  largest peak in the window, nor 1.5 times the largest size killed, nor `512m`.
- **CPUs are only ever lowered**, when the p95 of the cores used is below 0.4 times the size. Raising `cpus` cannot
  help a job the ceiling holds back: the ceiling is the host's CPU budget, the same for every job. When the median run
  was held back more than 25% of its time, the line says so as a fact about the host.
- **A suggestion is capped at what the host offers:** the budget, or the project's `hostShare` of it. Where the runs
  ask for more, the line says "this project's runs need more than this host offers". Nothing ever suggests growing
  the host's budget: that budget is what the machine promised every other project.
- **A call is offered exactly when the suggested size could ever start on this host.** Where it could not, the line
  names what does not fit and offers no call.
- **Nothing is applied automatically.** The numbers come from inside the job, so a job could make them up. You apply
  a suggestion with the call it names, `dispatch_limit_edit` (or `dispatch_limit_add` for a project without a row),
  behind your confirm.

**How to apply a call.** Open pi with the admin extension (the one that gives you `/dispatch`) and ask it to run the
call, for example "run dispatch_limit_edit {"index":1,"memory":"12g"}". It shows you the row before and after, with
the project's peaks, and asks you to confirm; nothing is written until you do, and it refuses where nobody can
confirm. The panel's limit dialogs (`m` in `/dispatch`) cannot do this: they edit a row's counts and keep its size.

The rules in full, with their rounding steps, are in [choosing a size from the
runs](scoped-limits.md#choosing-a-size-from-the-runs).

**How busy each host is** is a separate report, from the same run records plus the jobs running now: busy and idle
time, jobs at once, the memory and CPU promised against the budget and the CPU used. It shows in three places:

- **`pi-dispatch capacity`** (`--since 24h|7d|30d`, `--host`, `--json`).
- **`pi-dispatch doctor`**: one line per host for the last 7 days, never a warning.
- **`dispatch_capacity`**: the same report to a model in pi.

It counts this deployment's jobs only, so a machine busy with other work reads as idle; see
[the capacity report](insights.md#pi-dispatch-capacity).

## A worked example

One Linux machine with 64 GB of memory and 16 CPUs, Docker with systemd, a single worker (no `PI_WORKER_NAME`), and
three projects:

| Project | Size | Why |
|---|---|---|
| `heavy` | `20g`, 4 CPUs | a monorepo whose test suite needs the memory |
| `medium` | `8g`, 2 CPUs | an API service |
| `light` | `2g`, 1 CPU | docs and a static site, many small jobs |

`projects.json`:

```json
{
  "version": 1,
  "projects": [
    { "id": "heavy", "members": ["github:acme/monorepo"] },
    { "id": "medium", "members": ["github:acme/api"] },
    { "id": "light", "members": ["github:acme/docs", "github:acme/site"] }
  ]
}
```

`scoped-limits.json`:

```json
{
  "version": 3,
  "limits": [
    { "scope": "project:heavy", "memory": "20g", "cpus": 4, "minJobs": 1, "concurrent": 2 },
    { "scope": "project:medium", "memory": "8g", "cpus": 2, "minJobs": 1 },
    { "scope": "project:light", "memory": "2g", "cpus": 1, "hostShare": 50 }
  ]
}
```

`.env` (the budget settings are left unset, so all four are `auto`):

```sh
PI_PROJECTS_FILE=/srv/pi-dispatch/projects.json
PI_SCOPED_LIMITS_FILE=/srv/pi-dispatch/scoped-limits.json
PI_CONCURRENCY=10
```

### What doctor shows

Say `docker info` reports 64204m of memory (the kernel keeps part of the 64 GB for itself) and 16 CPUs. The reserve
is then `4g` (10% would be more than the `4g` maximum) and 1 CPU, so the budget is 60108m and 15 CPUs. Doctor's sizing
lines, before any run and before the CPU quota is set:

```text
✓ Job size: 4g of memory with no swap beyond it, and the CPU weight of 2 CPUs, per job (the built-in default; a project row's memory and cpus override it, docs/scoped-limits.md)
✓ local: any one job may use at most 15 of this runtime's 16 CPUs (--cpus); under contention a larger size gets more CPU than a smaller one (--cpu-shares)
✓ Host budget: memory 60108m (auto: 64204m here, 4g kept for the host), CPUs 15 (auto: 16 here, 1 kept for the host); a job starts only when its size fits beside what already runs on this host
✓ The budget counts each job's cpus as CPU reserved for it, although the runtime uses them as a weight (a busy job may use idle cores beyond them): so a job's cpus must fit the CPU budget beside what runs, even on an idle host
✓ The host budget binds first: it holds 7 jobs of the default size (4g, 2 CPUs) at once, fewer than PI_CONCURRENCY (10); bigger sizes fit fewer
✓ project heavy: size 20g, 4 CPUs: not enough runs to suggest a size yet (0 of the 10 runs with measurements it needs in the last 30 days)
✓ project medium: size 8g, 2 CPUs: not enough runs to suggest a size yet (0 of the 10 runs with measurements it needs in the last 30 days)
✓ project light: size 2g, 1 CPU: not enough runs to suggest a size yet (0 of the 10 runs with measurements it needs in the last 30 days)
⚠ local: no host CPU reserve across jobs: pidispatch.slice has no CPU quota, not the CPU budget of 15 CPUs
    → run once, as root (persistent across reboots): `sudo systemctl set-property pidispatch.slice CPUQuota=1500%`
```

No size is larger than the budget, no `minJobs` is out of reach, and the two minimums together (`28g`, 6 CPUs) fit,
so doctor warns about none of them. Run the `sudo` command once, and the last line becomes:

```text
✓ local: every job runs under pidispatch.slice, whose quota is 15 CPUs, the host's CPU budget, so all jobs together leave the reserve free (set by the operator with systemctl, and kept across reboots)
```

### What happens under a flood

**Thirty `light` jobs arrive at once.** Seven start: `light`'s `hostShare` of 50% allows 7.5 CPUs, and each job counts
1 CPU. The other 23 wait and keep no room, because their own project's share is what stops them. Then a `heavy` and a
`medium` job arrive, and both start at once: 7 light jobs (`14g`, 7 CPUs) plus `20g` and 4 CPUs plus `8g` and 2 CPUs
is `42g`, 13 CPUs and 9 jobs, all inside the budget. Without the share, the light jobs would have taken every job
slot, and the `heavy` job would have waited for the first of them to end.

**A stream of `medium` jobs arrives.** Seven start, which fills the budget in both memory (`56g` of 60108m) and CPU
(14 of 15). Then a `heavy` job arrives. It does not fit, so it waits. The `medium` jobs still queued arrived before
it, but `heavy` runs fewer jobs here than its `minJobs` (1), so the room is kept for the `heavy` job first. When one
`medium` job ends, the next `medium` job does not start, because that would take the room kept for the `heavy` one.
When three have ended, 4 medium jobs (`32g`, 8 CPUs) leave room for `20g` and 4 CPUs, and the `heavy` job starts at
its next check, within about nine seconds. From then on the `medium` jobs start again as others end. Without
`minJobs` it would not starve either, but it would wait its turn: room is kept for the oldest waiting job, so every
`medium` job queued before it would start first.

**A size that can never fit.** If `heavy` were set to `64g`, it would be larger than this machine's budget of 60108m.
On this single worker its jobs would be refused before anything is spent (`job-size-exceeds-host`), and doctor would
warn about the project before any job arrives. With `PI_WORKER_NAME` set and a bigger machine in the fleet, a job of
it on the shared queue would wait for that machine instead.

**A week later** the runs have something to say. Say one `medium` run ended `oom-killed` at `8g`, and its other runs
peaked well below. Doctor's line for it:

```text
⚠ project medium: size 8g, 2 CPUs; its runs in the last 30 days suggest memory 12g (oom-killed: 1 run ended oom-killed (the largest size killed 8g))
    → apply it in the admin panel with dispatch_limit_edit {"index":1,"memory":"12g"} (an operator confirms it; nothing applies a size by itself)
```

The index is the row's place in the file, counted from 0. Nothing changes until you run that call and confirm it,
and the next `medium` job picked up after that gets `12g`.
