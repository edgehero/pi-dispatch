# Run as a service

```bash
pi-dispatch service render    # show the unit it would install, with the real paths
pi-dispatch service install   # LaunchAgent (macOS), systemctl --user (Linux), nssm (Windows, a machine service)
pi-dispatch service status    # which unit exists, where, and whether it runs
pi-dispatch service restart --drain   # pause this host's queues, wait for their running jobs, restart, resume
```

`install` renders the [`deploy/`](../deploy/) templates without sudo (`--system` on Linux prints the sudo commands instead). A unit uses
the folder you run `install` from as its working directory and reads that folder's `.env`. The other switches:

- `--receiver` installs the receiver's unit instead of the worker's. The receiver package must be installed beside the worker.
- `--console` installs the operator console's (`pi-dispatch-console serve`), once the admin package is installed and a console token with
  the operator role exists ([console](console.md#keep-it-running-as-a-service)).
- `--env-setup <path>` wraps the worker in your secrets manager's setup script ([secrets](secrets.md)).

On rootless Podman (`PI_BACKENDS=podman`) it also installs Valkey, the egress proxy and the proxy's network keeper as systemd units
(Podman's Quadlet format), and `up` offers the same ([Podman](podman.md)).

Run one worker per container daemon. `install` refuses a second worker unit in the other scope, because each worker's startup cleanup stops
every job container it did not start, including the other worker's live jobs.

On Windows, `service render` prints the nssm commands it would run, so you can check them first:

![pi-dispatch service render on Windows: the nssm install sequence for the worker, with the real node and package paths](images/cli-service-windows.svg?v=2.0.0)

Two limits. On macOS and Windows the service runs only while you are logged in, because Docker Desktop does too. A policy refusal (exit 2)
never restarts the service, on any OS, so no supervisor keeps retrying against a paid provider.

## Control the worker

From any terminal:

- `pi-dispatch pause` stops taking new jobs. It is stored in the queue, so it survives restarts. Jobs still queue up and wait.
  `pi-dispatch resume` takes jobs again, and `pi-dispatch status` prints counts and [waiting details](#status-output). Both reach every
  queue the host registry and a look for queues name, and this host's own (`pi-jobs@<name>`) when the deployment's `.env` sets
  `PI_WORKER_NAME`, only on the deployment's Valkey: the `.env`'s `VALKEY_URL` when it and the shell's differ, else the one the command
  reaches with no `--valkey-url`. A resume reaches that queue only once it exists, and looks for it itself when the look for queues
  did not name it, on a connection of its own, so a look for queues that stalls does not hold it up. When that look fails too
  (no answer, or an error from Valkey), the report names the queue as not resumed and the command exits 1. When the shell sets another name, or sets one the
  `.env` does not, or the `.env` cannot be read, the line says so (`[this host's queue not added: ...]`) and leaves that queue out. When the registry or the look could not be read
  (`[registry unreadable: ...]`, `[queue scan incomplete]`), or some of the registry's host rows were not read in time
  (`[registry incomplete: 2 of 3 host rows not read]`), a second line says the list of queues may be short and to pause (or resume)
  again once Valkey answers; the exit code stays 0. A host row Valkey answered with an error (its key is not a hash) is one of
  those rows, and the words name it with what Valkey answered: `[registry incomplete: 1 of 3 host rows not read, of which
  Valkey answered with an error: hostw (WRONGTYPE)]`. Waiting does not read such a row: `pi-dispatch doctor` names the key
  to remove or repair. The registry's rows are read side by side within one bound, so a
  Valkey that holds them costs that bound once, however many hosts are registered, and leaves the rest of the five
  seconds for the writes.
  Both wait about five seconds on a Valkey, as `status` does. When a queue is not confirmed, the command exits 1
  and says of each queue whether it was paused (or resumed), sent but not confirmed, refused by Valkey before the write
  ran (unchanged: an ACL that denies it, a read-only replica, a Valkey still loading or busy), answered with another
  error, or not sent. A queue sent but not confirmed may still change when Valkey answers: a pause sent to a Valkey that
  stopped answering applied once it was back, after the command had given up. Any other error can come after the queue
  already switched (the queue's events stream holding the wrong type of value, say), so the command reads the queue back
  and says whether it is paused or running now, or that it may have partly applied when that read does not tell.
  "nothing changed" is said only when no write was sent or every one was refused before it ran. A pause goes to every
  queue at once; a resume goes one queue after another and sends none after one that is not confirmed, since a resume
  that lands later starts jobs. When the host registry or the look for queues could not be read whole too, the report's first
  line names it and the report says the list of queues may be short. Then run `pi-dispatch status` (once Valkey
  answers, when it did not) to see each queue, put right what Valkey refused or failed on, and run the same command
  again: pausing a paused queue or resuming a running one is harmless.
- `pi-dispatch service restart --drain` restarts the worker without stopping a job halfway. It pauses the queues this host's worker takes
  jobs from: the shared one and, when `PI_WORKER_NAME` is set, the host's own (`pi-jobs@<name>`, where its cron, chained and manual runs and
  the forge deliveries [routed to it](multi-host.md#a-forge-delivery-that-needs-one-particular-machine) wait). It waits until none of them has
  a running job (600 seconds, or `--drain-timeout <seconds>`), restarts the worker, and resumes the queues it paused. A queue you paused
  before stays paused. It reads `PI_WORKER_NAME` as `pi-dispatch run` does, from the shell or else the `.env`, and refuses when the two
  disagree. That is the name the next worker will run, not the running worker's: rename or remove `PI_WORKER_NAME` in the `.env` just
  before `--drain` and the old `pi-jobs@<name>` is not watched, and a name your `--env-setup` script sets is not seen, as `pi-dispatch run`
  does not see it. It is not the fleet's pause: while it waits, no host takes a job from the shared queue, and every other host's own queue
  keeps running ([several machines](multi-host.md)). If the wait times out or the restart fails, it names the queues it left paused, and says
  that `pi-dispatch resume` resumes every queue, one you paused before included.
- `pi-dispatch cancel <jobId>` stops one job in any state. A queued or held job is removed. A running job is stopped on whichever host runs
  it, and its run record says `operator-cancel`. If no reachable worker owns the job (its host is down, or its worker is older than this
  command), the command says so and changes nothing. Like `pause`, it reads only `VALKEY_URL`, so a broken forge setting cannot stand
  between you and the stop ([held jobs and retries](wait-for.md)).
- `pi-dispatch run --trigger <id>` runs one cron trigger from the triggers file now, once, as its schedule would
  ([firing a cron trigger by hand](triggers.md#firing-a-cron-trigger-by-hand)).
- `pi-dispatch triggers check [file]` judges a triggers file before you move it over the one the services run, and names the worker,
  receiver, poller or watch collector that would refuse to start on it, and why. It changes nothing
  ([check a file before you swap it in](triggers.md#check-a-file-before-you-swap-it-in)).
- `pi-dispatch capacity` says how busy each host was over the last day, week or thirty days: busy and idle time, jobs at once, memory and CPU
  promised and used, waits and projects, read from the run records. It never loads the full config: it reads only `VALKEY_URL` (or
  `--valkey-url`), `PI_LOGS_DIR`, `PI_LOG_RETENTION_DAYS` and `PI_WORKER_NAME`, from the shell or the `.env` of the folder you run it in (the
  logs directory defaults to `~/.pi-dispatch/logs`, the worker name to this machine's hostname as the worker names itself: lowercased, with
  any other character a dash), so a broken forge setting cannot stop it. It counts jobs only, so a machine busy with other work reads as idle
  ([capacity](insights.md)).

## Status output

`pi-dispatch status` prints JSON for the shared queue and the named hosts' queues. The existing `waiting`, `active`,
`paused`, `delayed` and `failed` fields are queue counts; `pausedState` says whether every queue is paused, with
`pausedPartial` and `pausedQueues` when only some are.

`status` waits about five seconds on a Valkey, its first check of that Valkey included, so a Valkey that takes the
connection and answers nothing (a frozen server, a stopped container behind a live port) no longer holds the command
open. Every read ends by then; a port that takes no connection at all can hold the command up to a second and a half
longer while the connection's own reachability check ends. A queue whose paused state or counts did not answer in time
is named in `unavailableQueues`, with `partial: true`. So is a queue one of whose reads Valkey answered with an error
(its `bull:<queue>:meta` key holding a string fails its paused state, say): `queueErrors` names it with Valkey's error
code alone, such as `{"pi-jobs@hostb":"WRONGTYPE"}`, the read that got the error is left out while its other read
(its counts, here) is still summed, the `error:` line says Valkey answered a read with an error, the line under it
names the queue with that code, and every other queue is read and summed as usual. Counts that did not answer are left out of the sums, never read as zero (with no
queue answering there are no count fields at all), and `pausedState` is `null` when the queues that answered are all
paused, since the one that did not may be running. The line is still printed, then an `error:` line naming what it
leaves out of each such queue (its paused state, its counts, or both), with the connection's own error where one was
seen, such as "nothing answers VALKEY_URL (127.0.0.1:6379)", and "could not reach Valkey" with "is it running?" only
when nothing answered at all.
The exit code is then 1, as for a Valkey that refuses the connection. The other parts say what they could not read in
their own words: `fleet` for the registry, `waitingDetails.partial`, `pollers.complete: false`, and a consumer whose
queue's demand did not answer is never called stalled. With two Valkeys (this shell's and the `.env`'s disagree), each
gets its own five seconds. `status --target` waits the same way; a queue that did not answer is in its own
`unavailableQueues` with `complete: false`, and its exit code stays 0.

When the host registry or the look for queues could not be read whole, the list of queues may be short: a queue it did not
find is in none of the sums. The line then has `queuesMayBeShort: true`, and a `warning:` line under it says so and to run
`pi-dispatch status` again once Valkey answers. Registry rows that were not read in time count the same, and the line
names them in `fleetIncomplete` ("2 of 3 host rows not read"), as `fleet` names a registry that could not be read. That alone does not change the exit code; a queue it found that did not
answer still does. `status --target` says the same. A host row Valkey answered with an error is one of them: `fleetIncomplete`
names it, and `hostErrors` gives each such host with the code of Valkey's reply (`{"hostw":"WRONGTYPE"}`), on both lines. That
row is not read on the next run either, until its key (`host:h:<name>`) is removed or repaired.

`waitingDetails.rows` explains a bounded sample of delayed entries. A row contains `jobId`, `queue`, `dueAt`,
`bucket`, `why` and `until`; the two times are epoch milliseconds, and absent reason fields are `null`. For example,
`why: "subscription-auth"` and `until` identify a remaining [authentication hold](subscription-auth.md#admission-and-renewal).
The reader asks only for queue membership and the worker's defer record, never the queued task or webhook payload.
Future scheduled runs can appear with no recorded reason. A stale record is ignored; a delayed entry more than
10 seconds past its due time has `bucket: "due"`, whatever reason was recorded before.

The details inspect at most 64 queues and 100 delayed entries per queue, with a concurrent two-second read budget.
`partial` is true when the sample is incomplete. `truncated` and `skippedQueues` name the limits, `unavailableQueues`
names reads that failed or timed out, and `invalidEntries` counts malformed members left out. A row whose membership
was read but whose record could not be read carries `unavailable: true`. `discoveryIncomplete: true` means queue
discovery itself was incomplete. An empty partial sample does not mean that no job is held. These details do not
replace or reduce the queue counts.

`consumers` reports each worker's queue consumers ([queue consumer health](multi-host.md#queue-consumer-health)), and
`pollers` the GitHub poller, from the heartbeat a running poller publishes in Valkey: `expected` (whether this
deployment runs a poller: `GITHUB_INGEST=poll` or `both`, or with it unset a `POLL_REPOS` that names repositories), `hosts` (each poller's heartbeat: `triggers` is `kept` when it runs on the
last triggers file that loaded because it refused the current one), `complete`, and a `note` where something needs
saying, such as "poller: running on the previous triggers.json, the current file is invalid: <reason>", with the reason
`pi-dispatch triggers check` gives for this folder's file, or that no poller has published a heartbeat while the
deployment polls. Run it in the deployment folder: `GITHUB_INGEST`, `POLL_REPOS` and the triggers file are read from
this shell, else its `.env`, and what cannot be read is named in `local`. The exit code does not change
([is it running](polling.md#is-it-running)).
