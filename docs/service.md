# Run as a service

```bash
pi-dispatch service render    # show the unit it would install, with the real paths
pi-dispatch service install   # LaunchAgent (macOS), systemctl --user (Linux), nssm (Windows, a machine service)
pi-dispatch service status    # which unit exists, where, and whether it runs
pi-dispatch service restart --drain   # pause, wait for running jobs, restart, resume
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
  `pi-dispatch resume` takes jobs again, and `pi-dispatch status` prints counts.
- `pi-dispatch cancel <jobId>` stops one job in any state. A queued or held job is removed. A running job is stopped on whichever host runs
  it, and its run record says `operator-cancel`. If no reachable worker owns the job (its host is down, or its worker is older than this
  command), the command says so and changes nothing. Like `pause`, it reads only `VALKEY_URL`, so a broken forge setting cannot stand
  between you and the stop ([held jobs and retries](wait-for.md)).
- `pi-dispatch run --trigger <id>` runs one cron trigger from the triggers file now, once, as its schedule would
  ([firing a cron trigger by hand](triggers.md#firing-a-cron-trigger-by-hand)).
- `pi-dispatch capacity` says how busy each host was over the last day, week or thirty days: busy and idle time, jobs at once, memory and CPU
  promised and used, waits and projects, read from the run records. It never loads the full config: it reads only `VALKEY_URL` (or
  `--valkey-url`), `PI_LOGS_DIR`, `PI_LOG_RETENTION_DAYS` and `PI_WORKER_NAME`, from the shell or the `.env` of the folder you run it in (the
  logs directory defaults to `~/.pi-dispatch/logs`, the worker name to this machine's hostname as the worker names itself: lowercased, with
  any other character a dash), so a broken forge setting cannot stop it. It counts jobs only, so a machine busy with other work reads as idle
  ([capacity](insights.md)).
