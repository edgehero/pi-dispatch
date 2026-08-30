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
`PI_SANDBOX_DIR` unless you have read the sharing section below.

## What is shared, and how

### Shared because it always was

The queue itself. The day, week and month spend windows and the daily token counter, which are atomic
increments on one key. The pause kill switch. The scheduler stall counters. Job deduplication and the
semantic window. Everything the `wait:` keyspace holds for `run.waitFor`: the hold clock, the per-job
check and fault counts, the supersede lease, and the panel's held-jobs list.

Pause windows are shared correctly too, and for a reason worth knowing: every window carries an explicit
`tz`, so `22:00` means one instant everywhere. Cron patterns do not, which is the next section.

### Shared because the fleet coordinates

Each worker publishes one small row about itself, refreshed every fifteen seconds and expiring after
ninety: its name, version, the image it runs, that image's digest, its timezone, its live concurrency,
and a fingerprint of the cron triggers it can see. Nothing in that row is an instruction to anybody. It
is how a host is *seen*.

Three things read it. `doctor` and the panel, to tell you what your fleet looks like. The cron reconcile,
to refuse to act while hosts disagree. And the pause switch and the panel, to find every queue.

### Not shared, on purpose

A job's raw log (`PI_CAPTURE_JOB_LOGS`) stays on the host that wrote it. It is the one artifact here that
holds issue text, comment text and tool output, and mirroring it would move that off the machine the
operator chose to keep it on. The panel names the host instead of showing bytes it should not have.

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
| `/dispatch run` from the panel | the host the panel is running beside | its `PI_DISPATCH_RUN_ROOTS` resolved the folder |
| A forge delivery | the shared queue | its workspace is a fresh clone, so any host can build it |

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

If you were relying on that accidental multiplication, raise the knob deliberately. The published
arithmetic in [`docs/wait-for.md`](wait-for.md) is now what it says: about one check every ten seconds
for the whole deployment, not per host.

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

`PI_SANDBOX_DIR` must be per host. The sandbox reaper asks the *local* docker which sandboxes are live
before deleting anything, so on a shared directory one host cannot see that another's sandbox is in use,
and will delete a directory an operator is working inside once it is past retention.

`doctor` reports this as a failure rather than a warning. It is the one sharing mistake that destroys
something.

### 4. Sharing the logs directory is a real option, with a real cost

If `PI_LOGS_DIR` is a shared mount, the run history is merged with no further machinery, and a cron job's
`previousRunAt` is correct across hosts for free.

What it costs: the raw job logs, which hold issue and comment text, then live on that mount too, and a
mount outage becomes a *lost record* rather than a missing panel row. Retention also becomes fleet-wide by
accident, because each host prunes by its own `PI_LOG_RETENTION_DAYS` and the shortest setting wins for
everybody.

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
image whose digest differs from the others, explains a timezone disagreement, and flags a host row that
has gone stale. Every one of those lines is absent on a single-host deployment.

The panel's status line names the workers when it can. `RUN_DETAIL` names the host that ran a job.

An image digest that differs is **suspicious, not wrong**: two independent local builds of one Dockerfile
produce different digests legitimately. It means "check", not "broken".

## Reference

| Setting | Default | What it does |
|---|---|---|
| `PI_WORKER_NAME` | this machine's hostname, sanitized | Names this host. Declaring it turns on routing. |
| `PI_CONCURRENCY` | 3 | Containers at once **on this machine**, across every queue it drains. |
| `PI_WAIT_CHECK_SLOTS` | 1 | Wait checks at once, fleet-wide when a name is declared. |

| Key | What it holds |
|---|---|
| `host:live` | the set of live worker names |
| `host:h:<name>` | one host's own description, refreshed every 15s, expiring after 90s |
| `wait:check:<i>` | the fleet-wide wait-check slots |
| `slot:s:<hash>:<i>` | the fleet-wide slots for a limited forge scope |

Deleting the whole `host:*` keyspace while the fleet is running is safe: every host falls back to
behaving as a single host, which is the behaviour before any of this existed.

**Version floor**: worker 1.7.0, admin 1.7.0. Every host must be on it. A worker below the floor does not
publish itself, so the others cannot see it, and it will not route its own work.

See also [`scoped-limits.md`](scoped-limits.md), [`wait-for.md`](wait-for.md) and
[`secrets.md`](secrets.md), each of which has a per-host consequence noted in it.
