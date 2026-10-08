# Running on more than one machine

Two Mac minis, one queue, one budget, one panel. Sandboxes run on whichever host has capacity, and the
work that can only happen on one machine goes to that machine.

This is a deployment shape, not a feature you switch on per trigger. Most of it is already true: the
queue, the spend caps and the kill switch have been shared since the beginning. What this page is about
is the parts that quietly assumed one host, and what each of them now does instead.

## Turn it on

Give every worker a name, in that host's `.env`:

```bash
PI_WORKER_NAME=mini1
```

That is the whole switch. **Declaring a name is how you declare a fleet**, and it is deliberately not
inferred from "a second host appeared": which queue a job goes to is a routing decision, and a routing
decision must not flip underneath a deployment that is already running.

A worker without a declared name still has an identity (its hostname, lowercased and reduced to
`[A-Za-z0-9._-]`), still publishes itself, and still shows up in `doctor` and the panel. What it does
not do is route. `pi-dispatch doctor` warns when it can see peers and nobody has declared a name,
because in that state the routing that makes a fleet safe is simply off.

Point every host at the same Valkey, and give each one its own `PI_LOGS_DIR`, `PI_JOBS_DIR` and
`PI_SANDBOX_DIR` unless you have read the sharing section below. Set `PI_LOGS_DIR` explicitly on a fleet
rather than leaving it defaulted: the default is `~/.pi-dispatch/logs`, and whether that is per host or
shared depends on whether the home directory is, which is not a decision you want made by your mount
table. See trap 4 below.

## What is shared, and how

### Shared because it always was

The queue itself. The day, week and month spend windows and the daily token counter, which are atomic
increments on one key. The pause kill switch. The scheduler stall counters, one key per scheduler. Job deduplication and the
semantic window. Everything the `wait:` keyspace holds for `run.waitFor`: the hold clock, the per-job
check and fault counts, the supersede lease, and the panel's held-jobs list.

Pause windows are shared correctly too, and for a reason worth knowing: every window carries an explicit
`tz`, so `22:00` means one instant everywhere. Cron patterns do not, which is the next section.

### Shared because the fleet coordinates

Each worker publishes one small row about itself, refreshed every fifteen seconds and expiring after
ninety: its name, version, the image it runs, that image's digest, its timezone, its live concurrency,
a fingerprint of the cron triggers it can see, a fingerprint of its dollar caps, and the names of the secret
and wait profiles it declares.
Nothing in that row is an instruction to anybody. It is how a host is *seen*.

Profile **names** only, never the resolver paths or check scripts behind them. A path is operator topology
everywhere and carries the account name on Windows, and a reader only ever needs to know which host, not
what it runs to get there.

Four things read it. `doctor` and the panel, to tell you what your fleet looks like. The cron reconcile,
to refuse to act while hosts disagree. The pause switch and the panel, to find every queue. And the
receiver, to decide which queue a forge delivery belongs on.

The pause switch does not trust it alone. A registry row is a lease that expires ninety seconds after a
host stops writing, while that host's queue, and its paused flag, are permanent. So `pause`, `resume` and
`status` also enumerate the queues that *exist* from the queue keyspace itself, and act on the union. That
is what stops a resume from silently leaving a queue paused forever because its host happened to be down
when you ran it.

`pi-dispatch cancel <jobId>` spans the same union to *find* the job, because a host-affine job sits on
`pi-jobs@<name>` rather than the shared queue. Stopping an *active* job is then a request to whichever
worker owns it (a `cancel:req:` key that worker polls and acknowledges by name), since a running job's
abort can only be raised inside the process that holds its lock. No acknowledgment within the window is
reported as exactly that: the job may be on a host that is down, or on a worker predating the verb, and
nothing was changed.

### Not shared, on purpose

A job's raw log (`PI_CAPTURE_JOB_LOGS`) stays on the host that wrote it. It is the one artifact here that
holds issue text, comment text and tool output, and mirroring it would move that off the machine the
operator chose to keep it on.

`/dispatch logs <id>` for a job that ran elsewhere now says so by name, rather than reporting no captured
log as though none had been taken. The bytes are on that machine and this panel deliberately cannot reach
them.

**The run history is merged.** Each worker writes its record to its own disk as it always has, and also
mirrors it into Valkey, so every panel lists the whole deployment's runs and labels each one with the host
that produced it. The files stay the record; the mirror is a view of them, and it is never allowed to
outlive them: its retention is the shorter of your `PI_LOG_RETENTION_DAYS` and ninety-two days, so it can
never show a run whose file has already been reaped.

If Valkey is unreachable the panel shows this host's runs and says `RUNS · this host only` rather than
quietly presenting a third of your deployment as all of it. A worker below the version floor mirrors
nothing, so its runs are visible only on its own panel.

Local folders. That is the whole point of routing.

The boot reaper, which clears stray containers by name against the *local* docker daemon. Two hosts never
touch each other's containers, and that is what makes many hosts safe while two workers sharing one
daemon remains forbidden.

## Where work runs

A job that can only run on one machine is **enqueued to that machine's queue** (`pi-jobs@<name>`), by
whoever enqueues it. Everything else stays on the shared queue and any host can take it.

| Work | Goes to | Because |
|---|---|---|
| A cron trigger's job | the host whose filesystem has its `run.folder` | the folder is on one machine |
| A chained child | the host that ran its parent | it continues that working tree |
| `pi-dispatch run <folder>` | the host you ran the command on | it checked that folder against its own disk |
| `pi-dispatch run --trigger <id>` | the host you ran the command on, which must have the trigger's `run.folder` | the same placement as the trigger's schedule |
| `/dispatch run` from the panel | the host the panel is running beside | its `PI_DISPATCH_RUN_ROOTS` resolved the folder |
| A forge delivery | the shared queue | its workspace is a fresh clone, so any host can build it |
| A forge delivery binding a secret or wait profile | a host that declares that profile | the resolver or check script is on one machine's disk |

For both `pi-dispatch run` forms, which host queue is "this host's" follows the deployment: `PI_WORKER_NAME` comes from your shell, or else from the deployment `.env` in the folder you run the command from. The command refuses when the shell and the `.env` disagree, or when the `.env` cannot be read and the shell does not set it.

### A forge delivery that needs one particular machine

Most forge deliveries can run anywhere: the workspace is a fresh clone. Two trigger fields break that.
`run.secretsProfile` names a resolver on one host's disk, and a `run.waitFor` condition names a check
script on one host's disk. Before, whichever worker happened to pop the delivery decided whether it ran,
permanently and invisibly, and the refusal read like a configuration error rather than a placement one.

The receiver now reads the registry and enqueues such a delivery onto a host that declares the profile.
It **abstains** in four cases, and every one of them lands on exactly what happened before:

- the delivery binds neither field, which is nearly all of them
- **every** live host declares it, so the shared queue is better: it load-balances, and this is the shape
  the docs recommend
- **no** host declares it, so routing cannot help and the existing pre-spend refusal is the honest answer
- no capable host has a queue of its own, or the registry could not be read

A host has to be *beating* to attract routed work, not merely unexpired. The ninety second TTL answers
"has this host definitely gone" and is deliberately six missed beats so a blip cannot evict a working host
from the panel. Routing needs the opposite: a job sent to a stopped host's queue waits there for it to come
back, so a host stops attracting work after three missed beats, long before its row expires.

**Why routing at enqueue rather than a check at pickup.** The obvious alternative is to let any host take
the job and put it back if it cannot serve it. That does not work here. BullMQ promotes a delayed job on
each worker's own clock, and the first worker to ask takes it, so the host whose clock runs fastest wins
every attempt. If the host that *cannot* serve the job is the fast one, the job never reaches the one
that can, and adding randomness does not help: it changes when the attempt happens, not who wins it.

A cron trigger whose folder is on another machine is **unserved** here: this worker logs it, does not
install a scheduler for it, and boots and drains everything else. Before, a single missing folder
refused the whole worker, taking every unrelated trigger down with it.

## Two bounds that used to multiply

`PI_CONCURRENCY` bounds a **machine**, and it still does. A worker that drains two queues runs two BullMQ
workers, whose limits are per worker, so the total is capped again inside the worker itself. The excess
waits rather than being refused.

`PI_WAIT_CHECK_SLOTS` and a `scoped-limits.json` row's `concurrent` are now **fleet-wide** once a name is
declared. They were per process, which meant four hosts with a limit of one ran four things at once, and
you would not have been told: the only symptom either bound has is a denial, and multiplication produces
fewer denials per host, so scaling out made the signal quieter while the load grew.

A forge-qualified row such as `forgejo:acme/web` is one limit across the fleet, and that holds even if two hosts
point `FORGEJO_URL` at two different Forgejo instances: the scope names the forge kind, not the instance. Keep one
instance per forge kind across hosts that share a Valkey.

Upgrade every host before you write a forge-qualified scope. In `scoped-limits.json` a qualified row makes the file
version 2, which an older worker refuses loudly (at boot, or by keeping its last good file on a live edit and logging why). `pause-windows.json` has no version: an
older worker reads a qualified window as a name no job has and pauses nothing, without saying so.

`projects.json` is per host too. Each host decides which project a job belongs to from its own copy and writes that
id into the run record, so give every host the same file, or one repo is recorded under two projects depending on
which host ran it. Each host publishes a fingerprint of its projects (ids and member hashes, never a name), and
`pi-dispatch doctor` names a host whose projects differ. See [`docs/projects.md`](projects.md).

If you were relying on that accidental multiplication, raise the knob deliberately. The published
arithmetic in [`docs/wait-for.md`](wait-for.md) is now what it says: about one check every ten seconds
for the whole deployment, not per host.

## The host budget

How to choose sizes and read what doctor says about them, with a worked example, is in [sizing jobs](sizing.md).

`PI_CONCURRENCY` counts jobs, and a count cannot tell a 20g job from a 2g one. So each worker also keeps a
**budget** of memory and CPU for its jobs, and starts a job only when its size (its project's `memory` and `cpus`,
see [job sizes](scoped-limits.md#job-sizes-version-3)) fits beside the sizes of the jobs already running on that
machine, in both memory and CPU. `PI_CONCURRENCY` still caps the number of jobs, counted in the same budget, so the
room kept for a waiting job includes a job slot; whichever is reached first applies, and `pi-dispatch doctor` says
which. A job that does not fit yet waits and starts once room frees.

A job's `cpus` count as CPU set aside for it, although the runtime only uses them as a weight (a busy job may use idle
cores beyond them). So a job's `cpus` must fit in the CPU budget beside what already runs, even on an idle machine.

| Setting | Default | What it does |
|---|---|---|
| `PI_HOST_MEMORY_BUDGET` | `auto` | The memory this machine's jobs may hold together: `auto`, an amount (`64g`, `49152m`), or `off`. |
| `PI_HOST_CPU_BUDGET` | `auto` | The CPUs they may hold together: `auto`, a number (`12`, `3.5`), or `off`. |
| `PI_HOST_RESERVE_MEMORY` | `auto` | What `auto` leaves for the machine itself: 10% of its memory, at least 1g and at most 4g. |
| `PI_HOST_RESERVE_CPUS` | `auto` | The same for CPUs: 1 when the machine has 4 or more, else 0. |

`auto` reads the container runtime's own numbers (`docker info`, `podman info`; on Docker Desktop that is the VM's),
the smaller of the two when a worker runs both venues, and on rootless Podman also the limits set on the account's
systemd user service (`memory.max`, `cpu.max`). It takes the reserve off, and never goes below one job of the default
size (`PI_JOB_MEMORY`, `PI_JOB_CPUS`). An amount is the budget itself: the reserve is not taken from it. A value
below one default job, or one that does not parse, stops the worker at boot with the reason. The four settings are
read from `.env` only, not from the panel's settings.

**On a small machine the budget may run fewer jobs than before.** A 4 CPU machine has a CPU budget of 3, which holds
one job of the default 2 CPUs at a time. Lower `PI_JOB_CPUS` or a project's `cpus`, or set `PI_HOST_CPU_BUDGET`, if
you want more at once.

**A big job is not starved by small ones.** Room is kept for the oldest waiting job of each project that runs fewer
than its `minJobs` here, and then for the oldest waiting job of all, so a stream of small jobs cannot take every
core the moment it frees. A waiting job that something else is holding back (a full scope, a busy model server, a
pause window) keeps its place in line but keeps no room. A job that stops coming back (finished elsewhere, removed)
loses its place after a check of the queue.

**A size that can never fit this machine.** A job on this machine's own queue (`pi-jobs@<name>`: its folders, its
wait checks) can run nowhere else, so one larger than the budget is refused before anything is spent,
`job-size-exceeds-host`, and one larger than its project's `hostShare` of the budget, `job-size-exceeds-share`. That
happens before the job waits on any condition. A worker without `PI_WORKER_NAME` refuses every such job the same way,
whatever queue it is on: it has declared no fleet, so there is no other machine to wait for. On a worker with
`PI_WORKER_NAME`, a job on the shared queue is never refused for its size: another machine may have the room. It is put back for 60 seconds (`job_size_never_fits_here_deferred` in the log, with both
sizes) and picked up again by whichever worker asks first. `pi-dispatch doctor` warns about a project that fits on no
running worker; such a job waits until one is started (or the size is lowered). The worker log and the run record name
the job's size and the budget; the forge comment names neither.

Two things that follow. A job too big for some machines may be picked up by those a few times before one it fits on
gets it. And a job that fits several busy machines keeps room on each of them while it waits, though it runs on only
one; that room is given back within a minute of it starting elsewhere.

**A container that would not stop keeps its room** until the runtime says it is gone (or lists it as exited), so a
job past its time limit whose stop failed cannot make room for another while it may still be running. When the worker
starts, it removes every job container it can and then counts any that are still there at the size on their labels
until they are gone. If it cannot list them (the container runtime does not answer), it starts no job until it can,
and `pi-dispatch doctor` says so.

Every job container carries its size as two labels, `pi.dispatch.mem` (MiB) and `pi.dispatch.cpu` (hundredths of a
CPU), and every job's `--cpus` is the CPU budget, so no single job can use the reserve.

### The CPU reserve across all jobs

`--cpus` bounds one job at a time: several busy jobs together could still use every core. So every job container
(and every sandbox and doctor probe) runs inside one parent cgroup, `pidispatch.slice`, whose CPU quota is the CPU
budget. All jobs together then stay inside the budget, and the reserve stays free for the egress proxy, Valkey, the
worker and the rest of the host. Measured on Docker Desktop, Docker 29 on Ubuntu and Podman 4.9 and 5.8: three busy
jobs used 3.00 to 3.06 of 4 cores (12.95 to 13.02 of 14), and a busy program outside kept its core.

The parent helps even before it has a quota: a job's CPU weight then only competes with other jobs, so a large job can
no longer starve the egress proxy or Valkey. Inside the parent the weights still order the jobs (on Fedora's kernel
6.19 the ratio between sizes is smaller than the weights, the order holds).

Who sets the quota depends on the container runtime:

- **Rootless Podman**: the worker, when it starts and whenever the budget changes, through your account's own systemd
  user manager: `systemctl --user set-property pidispatch.slice CPUQuota=<budget x 100>%`. It survives a reboot.
- **Docker Desktop** (Docker's cgroupfs driver): the worker, when it starts, through a short helper container of the
  job image (no network, no capabilities, only the parent's own cgroup directory mounted) that writes the quota into
  the Docker Desktop VM. A Docker Desktop restart drops it; the worker checks it every ten minutes and writes it again.
- **Docker on a Linux host with systemd, and rootful Podman**: only root can set it. Run this once, as root, with your
  budget in place of 3 CPUs (it survives reboots); `pi-dispatch doctor` prints the exact command with your budget:

  ```sh
  sudo systemctl set-property pidispatch.slice CPUQuota=300%
  ```

On rootless Podman, Docker Desktop and Docker's cgroupfs driver, and Docker with systemd on this host, `pi-dispatch
doctor` reads the quota back and warns "no host CPU reserve across jobs" with the command when it is missing or
differs from the budget. On rootful Podman, rootless Docker and a Docker daemon on another machine nothing can read
it from here, so doctor's warning stays even after you ran the command, and the worker logs `cpu_reserve_fail_open`
with the status `unmanaged`. On a cgroup v1 host no quota is kept. Jobs run in every case, inside the parent. With
`PI_HOST_CPU_BUDGET=off` the worker clears the quota only where it sets it itself (rootless Podman, Docker's
cgroupfs driver); one set with `sudo` stays until you clear it with `sudo systemctl set-property pidispatch.slice
CPUQuota=`. Where rootless Podman uses the cgroupfs manager instead of systemd, jobs run without the parent and each
job's CPU weight is capped at the default: the proxy and Valkey then get a fair share of the CPU, not a reserve.

There is no memory limit across all jobs, on purpose: when a group of containers runs out of memory together, the
kernel kills the largest job in the group, not the one that grew (measured). The budget's admission keeps the jobs'
memory sizes inside the budget instead. If you want a last backstop anyway, set it yourself on the parent at the
host's memory minus a reserve (for example `sudo systemctl set-property pidispatch.slice MemoryMax=28G
MemorySwapMax=0`), knowing that it kills the largest job.

## The traps

### 1. A cron pattern carries no timezone

`"0 3 * * *"` means three in the morning *on the machine that runs it*. `triggers.json` has no timezone
field for a cron trigger, so two hosts in different zones read one pattern as two different instants.

The cron reconcile refuses while hosts disagree about the timezone, and `doctor` names both zones. Set the
same `TZ` on every host. Pause windows are unaffected, because those have always been explicit.

### 2. Divergent triggers files freeze cron rather than fighting over it

Two hosts with different `triggers.json` files used to delete each other's schedulers on every boot and
every file edit. Now neither installs and neither prunes: the resident schedules keep running, both hosts
log `cron_divergence_refused` naming the other, and cron resumes the moment the files agree.

Deleting the last cron trigger on one host used to prune the whole fleet's schedulers. It no longer can.

Syncing the file is yours to do. The workers detect the disagreement; they do not resolve it, because
resolving it means choosing whose file wins, and a stale file winning silently is worse than a stalemate
that names both hosts.

### 3. Do not share the sandbox directory

`PI_SANDBOX_DIR` must be per host. The sandbox reaper asks *this host's* container runtime (docker for a
`local` run, this account's Podman for a `podman` one) which sandboxes are live before deleting anything, so on a shared directory one host cannot see that another's sandbox is in use,
and will delete a directory an operator is working inside once it is past retention.

**Nothing detects this for you.** It is a rule you have to follow, and it is stated here rather than
enforced because the obvious detector does not work: a marker file written into that directory is exactly
what the sandbox reaper deletes. Of everything on this page it is the one sharing mistake that destroys
something rather than merely confusing something, which is why it gets a trap of its own.

### 4. Sharing the logs directory is a real option, with a real cost

If `PI_LOGS_DIR` is a shared mount, the run history is merged with no further machinery, and it is merged
more deeply than the Valkey mirror manages: the mirror holds at most ninety-two days and five thousand
runs, while a shared directory holds whatever your retention keeps. You also get every host's raw logs
readable from every panel, which the mirror deliberately never does.

What it costs: the raw job logs, which hold issue and comment text, then live on that mount too, and a
mount outage becomes a *lost record* rather than a missing panel row. Retention also becomes fleet-wide by
accident, because each host prunes by its own `PI_LOG_RETENTION_DAYS` and the shortest setting wins for
everybody.

**You can now arrive here without choosing it.** `PI_LOGS_DIR` and `PI_SETTINGS_FILE` default under the
home directory, so on a fleet whose home directories are one NFS or SMB mount, every host shares one run
history and one settings overlay by default, with all the costs above and none of the deliberation. The
settings overlay is the sharper half: it is read per job and written by whichever panel saved last, so a
cap set on one host silently becomes the cap everywhere. Set both variables per host, or decide to share
them on purpose.

### 5. A folder on two machines is not the same folder

`/srv/site` on mini1 and `/srv/site` on mini2 are usually two different checkouts. Nothing here treats
them as one, deliberately: the one-job-per-folder guard is per machine, and two hosts that genuinely share
one working tree over a network mount are outside what this supports.

### 6. Records name a host, and a hostname often names a person

Every run record carries the worker's name, and the default is your machine's hostname. On a laptop that
is frequently somebody's name. Set `PI_WORKER_NAME` to something you would not mind reading back in your
own run history.

### 7. One worker per docker daemon still holds

Multi-host means one worker per machine. Two workers sharing one docker daemon remains forbidden and is
still refused when installing a service unit: the boot reaper would treat the other's containers as
strays and kill a running job.

## What the panel and doctor show you

`pi-dispatch doctor` names the fleet, warns when peers exist and nobody declared a name, reports a job
image whose digest differs from the others, explains a timezone disagreement, flags a host row that
has gone stale, and names a host whose dollar caps differ from this one's. Every one of those lines is
absent on a single-host deployment.

**Dollar caps are per host, the dollar counters are shared.** Each host reads `PI_MAX_COST_USD`, the three
`PI_*_COST_USD` windows, the overlay's dollar keys, the scoped-limits file's dollar rows and `PI_ALLOWED_MODELS`
(which model rows a job without its own list reserves in) itself, so two
hosts can judge one counter against two caps, and the one with the larger cap admits a job the other would
refuse. Each host publishes a fingerprint of those values (numbers and hashes only, never a repo name or
folder), and doctor warns when a peer's differs (naming the per-job cap, the windows, the scoped-limits rows and
`PI_ALLOWED_MODELS` as what to align), or when a peer publishes none while dollar caps are in use. A dollar counter
on the shared Valkey counts as in use, best effort: an older capped host with a dollar window leaves counters, but
a host with only a per-job cap leaves none.
It never refuses a job over it. Set the same values on every host. An `.env` change needs a restart; an
overlay or scoped-limits edit shows within fifteen seconds.

**Each host's budget is its own.** Doctor shows this machine's [host budget](#the-host-budget), which of it and
`PI_CONCURRENCY` binds first, and warns about a project size it can never hold and about `minJobs` it cannot keep.
On a fleet it lists every host's budget, what its jobs hold and the largest project size that fits it, and for each
sized project the hosts it fits on, warning when it fits on none. It also checks this host's own count against the
size labels of the job containers that are running and warns when they differ.

**How busy each host was.** Doctor ends the fleet part with one line per host over the last 7 days, for example
`Host a: last 7d busy 63% (avg 2.1 of 4 slots, full 12%), promised 48% memory / 40% CPU, used 18% CPU of 8, wait
p50 40s p95 6m, most busy: web`. It is a fact, never a warning, and it shows on a single host too. After a `;` it says
what it cannot see: jobs running now that are not counted, history that starts later than the window (the run mirror
holds nothing older), or that only this host's files were read. A host without `PI_WORKER_NAME` writes no run mirror,
so another host's doctor says it has no history there. `pi-dispatch capacity` prints the same report in full, and
`dispatch_capacity` returns it in pi ([the capacity report](insights.md#pi-dispatch-capacity)).

To count the jobs running now, each worker's registry row carries three more fields: `jobs` (each running job's id,
project id, size and start, and an `o` flag on a container whose stop did not take, at most 32, oldest first),
`jobsMore` (how many it does not list) and `waiters` (jobs waiting for the host budget). Ids and numbers only: a job id
outside the usual characters is published as its hash, and a repository name never is. Nothing decides on them.

What it does **not** check yet: whether two hosts are sharing a directory they should not be. That one is
on you.

A cron trigger's `previousRunAt` needs no merging: cron jobs are routed to the host holding their folder,
so a scheduler's fires all land on one machine and its own files are the complete answer.

The panel's status line names the workers when it can. `RUN_DETAIL` names the host that ran a job.

A deployment where some queues are paused and some are not reads as `PART PAUSED` rather than being
rounded to one side, and `pi-dispatch status` names the paused queues. A pause or resume that fails partway
says which queues it changed and which one it failed at, because "could not reach Valkey" reads as
"nothing happened" and that is the one thing it must not be mistaken for.

An image digest that differs is **suspicious, not wrong**: two independent local builds of one Dockerfile
produce different digests legitimately. It means "check", not "broken".

## Reference

| Setting | Default | What it does |
|---|---|---|
| `PI_WORKER_NAME` | this machine's hostname, sanitized | Names this host. Declaring it turns on routing. |
| `PI_CONCURRENCY` | 3 | Containers at once **on this machine**, across every queue it drains. |
| `PI_HOST_MEMORY_BUDGET`, `PI_HOST_CPU_BUDGET` | `auto` | The memory and CPU this machine's jobs may hold together ([the host budget](#the-host-budget)). |
| `PI_WAIT_CHECK_SLOTS` | 1 | Wait checks at once, fleet-wide when a name is declared. |

| Key | What it holds |
|---|---|
| `host:live` | the set of live worker names |
| `host:h:<name>` | one host's own description, refreshed every 15s, expiring after 90s |
| `host:h:<name>` field `caps` | the secret and wait profile NAMES this host declares, comma separated |
| `host:h:<name>` field `fpUsd` | a fingerprint of this host's dollar caps, scoped-limits dollar rows and `PI_ALLOWED_MODELS` model rows |
| `host:h:<name>` fields `budgetMemMiB`, `budgetCpuCenti`, `usedMemMiB`, `usedCpuCenti`, `heldMemMiB`, `heldCpuCenti` | this host's budget, what its running jobs hold, and what it keeps for waiting jobs (MiB, hundredths of a CPU) |
| `wait:check:<i>` | the fleet-wide wait-check slots |
| `slot:s:<hash>:<i>` | the fleet-wide slots for a limited forge scope |
| `runs:index` | the merged run history's index, newest first |
| `runs:rec:<jobId>` | one run's record, a copy of the sidecar on its host's disk |
| `runs:horizon` | the fleet's history horizon: the newest instant before which any host's trim removed runs from `runs:index` (each host trims by its own `PI_LOG_RETENTION_DAYS`), read by `pi-dispatch capacity` so that time reads as missing, not idle |

Deleting the whole `host:*` keyspace while the fleet is running is safe: every host falls back to
behaving as a single host, which is the behaviour before any of this existed. The one decision that reads it, a
forge job refused as too big for every host, can only be delayed by that, never caused. The same is true of
`runs:*`: you lose the merged view until the next runs repopulate it, and never a record, because the
record is the file on disk. One thing goes with it: deleting `runs:horizon` loses where the hosts trimmed the index,
so until the next trim records it again, `pi-dispatch capacity` can read a gap a peer's shorter retention cut as idle
time.

**Version floor**: worker 1.7.0, admin 1.7.0. Every host must be on it. A worker below the floor does not
publish itself, so the others cannot see it, and it will not route its own work.

See also [`scoped-limits.md`](scoped-limits.md), [`wait-for.md`](wait-for.md) and
[`secrets.md`](secrets.md), each of which has a per-host consequence noted in it.
