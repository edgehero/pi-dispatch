# Backing up a deployment

This service keeps state in three places: a Valkey volume, a handful of files in your deployment
folder, and a durable directory and a file under your home. Nothing here is a database, so a backup is a
copy, and the only hard part is the order you stop things in.

If you read one section, read [Stop, copy, start](#stop-copy-start) and the two bolded rules in it.
Both exist because getting them wrong is silent.

## What is stateful

| Store | Default location | Moved by | What you lose without it |
|---|---|---|---|
| Run history | `~/.pi-dispatch/logs` | `PI_LOGS_DIR` | Every past run: the panel's history, the insights page, `dispatch_costs`, the what-if repricing, and cron's "since last run" |
| Settings overlay | `~/.pi-dispatch/settings.json` | `PI_SETTINGS_FILE` | Every cap you tuned from the panel. **Losing it does not stop jobs, it widens them.** See below |
| Triggers | `./triggers.json` | `PI_TRIGGERS_FILE` | The trigger set, **and the one-shot disarm marks** (`on.disarmed`). Two processes write this file: the panel and the worker |
| Pause windows | `./pause-windows.json` | `PI_PAUSE_WINDOWS_FILE` | Quiet hours |
| Scoped limits | `./scoped-limits.json` | `PI_SCOPED_LIMITS_FILE` | Per repo and per folder caps, and per scope concurrency |
| Subscriptions | `./subscriptions.json` | `PI_SUBSCRIPTIONS_FILE` | The plan prices the cost analytics read. Nothing about routing or spend enforcement |
| Staged pi packages | `./pi-packages.json` | `PI_PACKAGES_FILE` | Which packages a job may load |
| Egress allowlist | `./egress-allowlist.conf` | (path is passed to the proxy) | The egress policy |
| Credentials | `./.env` | (read by your service manager) | Every secret and every path. Back this up separately and encrypted, and never into a repository |
| Session transcripts | **no default** | `PI_SESSIONS_DIR` | Resumable sessions. The most PII bearing thing here: issue text, file contents, tool output, the agent's own reasoning. Back it up only if you accept that |
| GitHub App key | `./github-app-<slug>.pem` | `GITHUB_APP_PRIVATE_KEY_PATH` | Forge authentication |
| Queue and counters | Docker volume | `VALKEY_URL` | The waiting queue, the day, week and month spend counters, the pause flag, delivery dedup, held jobs, the host registry and the run mirror |

The Valkey volume is `pi-dispatch-valkey-data` when you started it with `pi-dispatch up`, and
`valkey-data` (Compose prefixes it with the project name) when you started it with
`deploy/docker-compose.yml`. Both run with `--appendonly yes`, so the queue already survives a
reboot on its own.

### The settings overlay is the one that fails quietly

A missing overlay is not an error. The worker reads a missing file as an **empty** overlay, so every
cap you set from the panel falls back to `.env` and the built in defaults. A `dailyCap` of 5 becomes
25. Restoring the run history without the overlay gives you a deployment that looks right and spends
more than you told it to, so treat the two as one unit.

The same asymmetry runs the other way. The overlay is a file and the **pause flag is in Valkey**, so
restoring files without the volume can leave you running with caps you never set, and restoring the
volume without the files can leave you paused with nothing on disk explaining why.

## What is deliberately not backed up

These are all regenerated or bounded, and copying them buys nothing:

- `PI_JOBS_DIR` (default under your OS temp dir): the read only `/job` inputs, rebuilt from scratch for
  every job.
- `PI_SANDBOX_DIR` (default `<PI_JOBS_DIR>/sandboxes`): a finished run's workspace, kept for
  `PI_SANDBOX_RETENTION_HOURS` (24 by default) so you can re-open it, and disposable by design.
- `PI_GRAPH_DIR` (default under your OS temp dir): the insights HTML artifact, rewritten by the next
  `/dispatch insights`.
- `<deployment>/logs/worker.out.log` and `worker.err.log`: your service manager's capture of the
  worker's stdout and stderr. **This is not the run history**, and `PI_LOGS_DIR` must never be pointed
  at that directory: the retention sweep deletes any `.log` or `.json` older than the window, and it
  would eat the daemon's own logs.

## Stop, copy, start

Stop writers before you copy, outermost first. Each individual file is safe to copy on its own:
`settings.json` and `triggers.json` are both written with a temp file and a rename, and `triggers.json`
takes a lock as well because it has two writers. What you cannot get while things are running is a
consistent snapshot of the SET, and a run record is written at a job's terminal state with no lock at
all, so a copy taken mid-run can catch a partial one. Stopping first is what buys the group.

1. **Stop the worker.** It owns the record writer, the retention sweep and one of the two
   `triggers.json` writers. If you installed it with `pi-dispatch service install`, use this project's
   own wrapper, which knows the scope it installed into:
   ```bash
   pi-dispatch service stop
   ```
   For a hand-rolled unit, stop it however you started it.
2. **Stop the receiver**, if you run one. It enqueues while you copy.
3. **Close any `/dispatch` panel.** It is the other writer of `triggers.json` and the only writer of
   `settings.json`.
4. **Copy the Valkey volume.** A live `BGSAVE` is not enough with AOF on, so stop the container first.
   Which names to use depends on how you started it. For `pi-dispatch up`:
   ```bash
   docker stop pi-dispatch-valkey
   docker run --rm -v pi-dispatch-valkey-data:/data -v "$PWD":/backup alpine \
     tar czf /backup/valkey.tgz -C /data .
   ```
   For `deploy/docker-compose.yml`, the service has no fixed container name and Compose prefixes the
   volume with the project name, so ask it:
   ```bash
   docker compose -f deploy/docker-compose.yml stop valkey
   docker volume ls --filter name=valkey-data          # the prefixed name is what you tar
   ```
5. **Copy the files with `cp -a`.** The session store is listed separately and on purpose: it is the
   most PII bearing thing here, so it is never swept up by a wildcard. If yours lives under
   `~/.pi-dispatch/sessions`, which is what `docs/sessions.md` suggests, then copying that whole
   directory takes the transcripts with it. Decide that deliberately.
   ```bash
   cp -a ~/.pi-dispatch/logs            /backup/run-history
   cp -a ~/.pi-dispatch/settings.json   /backup/settings.json
   cp -a /path/to/deployment            /backup/deployment      # includes .env and the *.pem
   cp -a "$PI_SESSIONS_DIR"             /backup/sessions        # ONLY if you accept holding transcripts
   ```
   **Use `cp -a`, or an archive that preserves timestamps.** The retention sweep decides a run
   record's age from its `mtime` and never from anything in its filename, so a copy that resets
   timestamps resurrects records the retention window had already retired, and they then live a
   second full window.
6. **Start again in reverse**: Valkey, worker, receiver, panel.

## Restoring

Same order reversed. Two things are worth knowing before you do it.

Run records are keyed by job id and the writer is last write wins, so a newer file store over an older
Valkey does not corrupt the history. What an older Valkey *does* restore is an older wait list and older
spend counters (`budget:*`), so caps under count for the rest of that window and held jobs come back.
Nothing about the file store gates a re-run: dedup and the wait list live entirely in Valkey.

**Restoring an old `triggers.json` over a newer one re-arms spent one-shots.** A trigger with
`"once": true` (and the `"number"` naming the item it watches) records that it fired by rewriting its
own entry in that file, so an older copy is a copy from before it fired. Restore it and the one-shot fires again, which costs a real job against
a real provider. If you are restoring triggers from a backup, diff it against the current file first
and keep the newer `on.disarmed` marks.

## Upgrading from a version that kept state in the OS temp directory

Run history and the settings overlay used to default under your OS temp directory. They now default to
`~/.pi-dispatch`. Nothing is moved for you, and the ORDER matters, because the thing that tells you where
your old records are turns itself off once you have moved on.

1. **Run `pi-dispatch doctor` before you restart anything.** It prints one line per store while the old
   path still holds files and the new one is empty, naming both paths and the command.
2. **Act on those lines, or decide you do not care about the old records.** Anything older than
   `PI_LOG_RETENTION_DAYS` is swept on the next worker start whichever directory it is in, because `mv`
   keeps timestamps and the sweep ages a record by its mtime. Moving old records does not preserve them
   past their window; it just puts them where the panel can see them until then.
3. **Then restart.** Both hints retire themselves, deliberately, and both retire on things you are about
   to do: the run history hint goes as soon as one new record lands, and the settings hint goes as soon
   as the panel writes an overlay for any reason. That is what keeps a permanent warning off a healthy
   deployment, and it is why step 1 comes first.

Two more things worth knowing:

- **`pi-dispatch up` does not migrate anything.** It scaffolds and checks; it never moves a file.
- **If your worker runs as a different account than your `/dispatch` panel**, set `PI_LOGS_DIR` and
  `PI_SETTINGS_FILE` explicitly in the deployment's `.env`. The default sits under a home directory, so
  two accounts resolve two different directories, and the symptom is not an error: the panel shows an
  empty run list and reports no spend, while caps set from the panel land in a file the worker never
  opens. Everything `pi-dispatch service install` sets up runs the worker as the account that installed
  it, so this only bites a hand-rolled unit whose `User=` you chose. All three templates under `deploy/`
  say so at the top.

## About permissions

`~/.pi-dispatch` and the run history inside it are created with your default umask, so on a typical
POSIX host they are readable by other local accounts. That is a large improvement on the old default,
which was a directory anyone could write to, and the run records are PII free by construction. The raw
container logs are not: with `PI_CAPTURE_JOB_LOGS=1` that directory holds issue and comment text. If
that matters on your host, `chmod 700 ~/.pi-dispatch`, the same thing `docs/sessions.md` tells you to do
for the transcript store.

## Moving a deployment, or changing where state lives

Set `PI_LOGS_DIR` and `PI_SETTINGS_FILE` to the new paths, move the files, restart. An explicit value
always wins over the default. Do not point `PI_LOGS_DIR` at your deployment's `logs/` directory, for
the reason in [What is deliberately not backed up](#what-is-deliberately-not-backed-up).

On more than one machine, give each host its own `PI_LOGS_DIR` unless you have read the sharing
section of [`docs/multi-host.md`](multi-host.md). One caution that is new: the default now sits under
your home directory, so if that home is on a network mount shared between hosts, the fleet shares one
run history by accident. That is a supported shape, but it should be a decision.

## What `doctor` tells you

`pi-dispatch doctor` reports on this directly:

```
✓ Durable state: run history /home/you/.pi-dispatch/logs, settings /home/you/.pi-dispatch/settings.json — both survive a reboot (docs/backup.md)
```

(doctor prints the expanded absolute paths, never a `~`.)

If either path resolves under your OS temp directory, which the OS may sweep on its own schedule, it
says so instead and keeps going. It is a warning, not a failure, and doctor still exits 0. You will
also see a one line hint while an older deployment's records are still sitting at the previous
default and the new location is still empty, and that hint retires itself once anything lands there.
