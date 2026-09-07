# Backing up a deployment

This service keeps state in three places: a Valkey volume, a handful of files in your deployment
folder, and two durable directories under your home. Nothing here is a database, so a backup is a
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

Stop writers before you copy, outermost first. None of these files is snapshot atomic: `settings.json`
is written with a temp file and a rename and is safe on its own, but `triggers.json` has two writers,
and a run record is written when a job reaches a terminal state with no lock at all.

1. **Stop the worker.** It owns the record writer, the retention sweep and one of the two
   `triggers.json` writers.
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.pi-dispatch.worker.plist   # macOS
   systemctl --user stop pi-dispatch-worker                               # Linux
   ```
2. **Stop the receiver**, if you run one. It enqueues while you copy.
3. **Close any `/dispatch` panel.** It is the other writer of `triggers.json` and the only writer of
   `settings.json`.
4. **Copy the Valkey volume.** A live `BGSAVE` is not enough with AOF on, so stop the container first:
   ```bash
   docker stop pi-dispatch-valkey
   docker run --rm -v pi-dispatch-valkey-data:/data -v "$PWD":/backup alpine \
     tar czf /backup/valkey.tgz -C /data .
   ```
5. **Copy the files with `cp -a`.**
   ```bash
   cp -a ~/.pi-dispatch                 /backup/pi-dispatch-state
   cp -a /path/to/deployment            /backup/deployment      # includes .env and the *.pem
   cp -a "$PI_SESSIONS_DIR"             /backup/sessions        # only if you run resumable sessions
   ```
   **Use `cp -a`, or an archive that preserves timestamps.** The retention sweep decides a run
   record's age from its `mtime` and never from anything in its filename, so a copy that resets
   timestamps resurrects records the retention window had already retired, and they then live a
   second full window.
6. **Start again in reverse**: Valkey, worker, receiver, panel.

## Restoring

Same order reversed. Two things are worth knowing before you do it.

Run records are keyed by job id and the writer is last write wins, so restoring a newer file store
over an older Valkey re-runs nothing. That direction is safe.

**Restoring an old `triggers.json` over a newer one re-arms spent one-shots.** A trigger with
`"once": <number>` records that it fired by rewriting its own entry in that file, so an older copy is
a copy from before it fired. Restore it and the one-shot fires again, which costs a real job against
a real provider. If you are restoring triggers from a backup, diff it against the current file first
and keep the newer `on.disarmed` marks.

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
✓ Durable state: run history ~/.pi-dispatch/logs, settings ~/.pi-dispatch/settings.json — both survive a reboot (docs/backup.md)
```

If either path resolves under your OS temp directory, which the OS may sweep on its own schedule, it
says so instead and keeps going. It is a warning, not a failure, and doctor still exits 0. You will
also see a one line hint while an older deployment's records are still sitting at the previous
default and the new location is still empty, and that hint retires itself once anything lands there.
