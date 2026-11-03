# Backing up a deployment

This service keeps state in a Valkey volume, in files in your deployment folder, and in files and folders under your
home (or wherever a `*_FILE` or `*_DIR` setting moves them). Nothing here is a database, so a backup is a copy, and the
only hard part is the order you stop things in.

If you read one section, read [Stop, copy, start](#stop-copy-start) and the two bolded rules in it.
Both exist because getting them wrong is silent.

## What is stateful

| Store | Default location | Moved by | What you lose without it |
|---|---|---|---|
| Run history | `~/.pi-dispatch/logs` | `PI_LOGS_DIR` | Every past run: the panel's history, the insights page, `dispatch_costs`, the what-if repricing, and cron's "since last run" |
| Console audit trail | `<PI_LOGS_DIR>/console-audit/` | `PI_LOGS_DIR` (kept for `PI_CONSOLE_AUDIT_RETENTION_DAYS`) | The hash-chained record of what was done in the console. Restore whole month files: one cut short reads as a broken chain |
| Allocation audit | `<PI_LOGS_DIR>/allocations/` | `PI_LOGS_DIR` | The record of each priorities plan applied. The plan in force is in Valkey (`alloc:plan`) |
| Touch outbox | `<PI_LOGS_DIR>/touch-outbox/` | `PI_LOGS_DIR` | Interventions (an answer, an approval, a re-run, a steer, a cancel) not yet published to Valkey for the [zero-touch](zero-touch.md) report |
| Settings overlay | `~/.pi-dispatch/settings.json` | `PI_SETTINGS_FILE` | Every cap you tuned from the panel. **Losing it does not stop jobs, it widens them.** See below |
| Subscription credentials | `subscription-auth/` beside the settings file | `PI_AUTH_STORE_DIR` | The subscription logins this host holds. Secret: back it up encrypted, like `.env` |
| Auth connections | (none: set it) | `PI_AUTH_CONNECTIONS_FILE` | Which subscription connections exist |
| Triggers | `./triggers.json` | `PI_TRIGGERS_FILE` | The trigger set, **and the one-shot disarm marks** (`on.disarmed`), and the file's other blocks: `secretBundles`, `modelRoles`, `answerRules`, `standingAnswers`, `zeroTouch` and `watchSources`. Two kinds of process write this file: the panel or the console, and the worker |
| Pause windows | `./pause-windows.json` | `PI_PAUSE_WINDOWS_FILE` | Quiet hours |
| Scoped limits | `./scoped-limits.json` | `PI_SCOPED_LIMITS_FILE` | Per repo and per folder caps, and per scope concurrency |
| Projects | `./projects.json` | `PI_PROJECTS_FILE` | Which repos and folders form a project. Run records keep the project id either way |
| Allocation envelope | (none: set it) | `PI_ENVELOPE_FILE` | The dollar total and the floors a priorities plan splits inside. **Losing it refuses the worker's start** while the key names it; unset, delegation is off. The applied split itself lives in Valkey (`alloc:plan`), the audit in `PI_LOGS_DIR/allocations/` |
| Subscriptions | `./subscriptions.json` | `PI_SUBSCRIPTIONS_FILE` | The plan prices the cost analytics read. Nothing about routing or spend enforcement |
| Staged pi packages | `./pi-packages.json` | `PI_PACKAGES_FILE` | Which packages a job may load |
| Global pi overlay | (none: set it) | `PI_GLOBAL_PI_DIR` | Every job's overlay: `models.json`, extensions, skills and the staged `packages/`, with each package's way back for Undo in `packages/.undo` |
| Egress allowlist | `./egress-allowlist.conf` | (path is passed to the proxy) | The egress policy |
| Model endpoints | `./model-endpoints.json` | `PI_MODEL_ENDPOINTS_FILE` | The local or LAN model servers a job may reach, and their slots. `model-endpoints.conf` beside it is rendered from it |
| Model proposals | `./model-proposals.json` | (fixed) | The model proposal settings |
| Valkey volume record | `./.pi-dispatch-valkey-volume.json` | (fixed) | Which unlabelled `pi-dispatch-valkey-data` volume this folder adopted: its name and creation time, no secret, written by `pi-dispatch up` (or `/dispatch setup`) when it adopted one. Lost, the next `up` asks to adopt the volume again, a question `--yes` does not answer |
| Credentials | `./.env` | (read by your service manager) | Every secret and every path. Back this up separately and encrypted, and never into a repository. On rootless Podman, `~/.config/pi-dispatch/valkey.env` holds the Valkey's password too, which `pi-dispatch service install` writes again from `.env` |
| Console tokens | `./console-tokens.json` | `PI_CONSOLE_TOKENS_FILE` | Every console sign-in and agent token. It holds hashes, never a token, so it cannot be rebuilt: lost, every token is minted again |
| Session transcripts | **no default** | `PI_SESSIONS_DIR` | Resumable sessions. The most PII bearing thing here: issue text, file contents, tool output, the agent's own reasoning. Back it up only if you accept that |
| Workspace checkpoints | `<PI_SESSIONS_DIR>/.checkpoints` | `PI_CHECKPOINTS_DIR` | Crash recovery of [durable runs](durable-runs.md). As PII bearing as the transcripts: back it up only with them |
| Fork sources | `<PI_SESSIONS_DIR>/.fork-sources` | follows `PI_SESSIONS_DIR` | Forking a finished run, for seven days. Transcripts too. A session key's own forks sit in its `forks/` folder |
| GitHub App key | `./github-app-<slug>.pem` | `GITHUB_APP_PRIVATE_KEY_PATH` | Forge authentication |
| Sandbox hosts | worker: `~/.config/pi-dispatch/sandbox-hosts.json`; console: `./sandbox-hosts.json` | `PI_SANDBOX_HOSTS_FILE` | The hosts approved for sandboxes. The worker and the console default to different paths, so set the variable |
| Sandbox gateways | `./sandbox-gateways.json`, on the console host | `PI_SANDBOX_GATEWAYS_FILE` | The browser gateways enrolled for [sandbox attachment](sandbox-gateway.md). Absent turns attachment off |
| Opener hosts | `~/.config/pi-dispatch/opener/hosts.json`, on each machine that opens sandboxes | `XDG_CONFIG_HOME` | The host configuration the native opener approved |
| Deployment pointer | `~/.pi/agent/pi-dispatch-deployment.json` | `PI_DISPATCH_DEPLOYMENT_FILE` (`PI_CODING_AGENT_DIR` moves its folder) | Which deployment folder `/dispatch` and the console manage. `/dispatch setup` writes it again |
| Queue and counters | Docker volume | `VALKEY_URL` | Every key family [listed below](#what-the-valkey-volume-holds): the waiting queue, the job, token and dollar counters, the pause flag, delivery dedup, held and parked runs, the host registry, the run mirror, and the live transcripts (redacted, gone 24 hours after each run, none with `PI_LIVE_TRANSCRIPTS=0`). A forge job's queue data holds issue text for 31 days, so a backup of this volume is personal data. **A reset or an older copy reopens every cap** for the rest of its window, and doctor notices that for the deployment's dollar windows only (`dollars.window-reset`) |

The Valkey volume is `pi-dispatch-valkey-data` when you started it with `pi-dispatch up`, and
`valkey-data` (Compose prefixes it with the project name) when you started it with
`deploy/docker-compose.yml`. Both run with `--appendonly yes`, so the queue already survives a
reboot on its own. On the rootless Podman venue the Quadlet unit (`pi-dispatch-valkey.service`) uses the same
`pi-dispatch-valkey-data` volume in that account's own store. The unit runs its container with `--rm`, so there is no
stopped container to `docker start` again; step 6 starts the unit instead. For step 4, as that account,
```bash
systemctl --user stop pi-dispatch-valkey
podman run --rm -v pi-dispatch-valkey-data:/data -v "$PWD":/backup:z docker.io/library/alpine \
  tar czf /backup/valkey.tgz -C /data .
```
The image name is fully qualified because rootless Podman may refuse or prompt on a short one, and `:z` lets the
container write into this directory on an SELinux-enforcing host.

### What the Valkey volume holds

Every key pi-dispatch writes, by family. A family marked as a display can be deleted while the fleet runs and every job
behaves as before; the rest is state that a lost or older volume takes with it.

| Keys | What they hold |
|---|---|
| `bull:*` | BullMQ's queue: every waiting, delayed and finished job (a forge job's data holds issue text for 31 days), the cron schedulers, the pause flag, and a delivery's job id, which is what refuses a redelivery |
| `budget:*` | The spend counters: jobs per day, week and month (`budget:<day>`, `budget:w:`, `budget:m:`, and `budget:s:` per scoped-limits row), tokens per day (`budget:t:`), and dollars (`budget:usd:`, with `budget:usd:s:` for a repo, folder or project row and `budget:usd:mdl:` for a model row) |
| `run:budget:*` | Each durable run's dollar holds, so a recovery never reserves, settles or gives back one twice |
| `run:approval:*` | Approval requests and their decisions |
| `run:checkpoint:*`, `run:recover:*` | Where each durable run's latest checkpoint is, and the recoveries queued or claimed |
| `run:steer:*`, `run:inbox:*`, `run:await:*`, `run:held:*` | Steering: each running job's inbox, the targets a comment can reach, and answers held for a run that is parking |
| `run:live:*`, `run:progress:*` | The live transcript (redacted, 24 hours) and the progress summary of each run. A display |
| `wait:*` | Jobs held on `run.waitFor`, their dedup keys and the check slots |
| `defer:job:*` | Why each deferred job waits. A display |
| `cancel:*` | Cancel requests and their acknowledgements |
| `slot:*` | Fleet-wide slots: a scoped-limits row's `concurrent`, and a model endpoint's slots |
| `watch:*` | Watch rules' findings, boards, fingerprints and daily counts |
| `answerer:*` | Answer drafts for parked questions |
| `touch:*`, `zero-touch:*` | Interventions for the zero-touch report, the grouped questions and the fixes |
| `alloc:*` | The priorities plan in force, its lock, its log and the envelope it expects |
| `dispatch:*` | Model failover attempts and cooldowns, subscription status and quota, and the model role canary's lease |
| `host:*`, `receiver:*`, `doctor:*`, `hook:*` | The host registry, the receivers' and doctor's published results, and the failure hook history (`hook:h:<host>`, with the hosts that have one in `hook:hosts`). A display, except that a host's registry row is how other hosts route to it |
| `runs:*` | The run mirror, a copy of every host's run records. The records on disk are the truth: a lost mirror fills again ([multi-host.md](multi-host.md#reference)) |
| `console:audit`, `console:trail:*` | The newest 500 console audit rows (the files in `console-audit/` are the record), and the claim that keeps a console answer to one trail comment |
| `sandbox:*`, `sandbox-gateway:*` | Kept workspaces per host, open shells, preparation requests, and the sandbox gateway's leases. A display, except pending requests |
| `updates:*` | What the Updates page found and applied per host, and the canaries run. Any `updates:*` key may be deleted while the fleet runs |
| `poll:*`, `steer:steered:*`, `trigger-fire:*` | The poller's cursors per repository, the marker that keeps a steered comment from also starting a job, and the guard that refuses firing one cron trigger by hand twice in a minute |
| `pi-dispatch:owner`, `pi-dispatch:sched-stalls` | Which deployment owns this Valkey, and the cron stall counter |

A reset (a flushed, replaced or newly made Valkey) or a restore of an older copy loses or rolls back all of this.
**Every cap reopens** for the rest of its window: the job counts, the token counter and every dollar window. Doctor
notices it for the deployment's own day, week and month dollar windows only (`dollars.window-reset`, see
[When a counter resets](costs.md#when-a-counter-resets)). The job, token, scoped and model windows reset in silence.

### The settings overlay is the one that fails quietly

A missing overlay is not an error. The worker reads a missing file as an **empty** overlay, so every
cap you set from the panel falls back to `.env` and the built in defaults. A `dailyCap` of 5 becomes
25. Restoring the run history without the overlay gives you a deployment that looks right and spends
more than you told it to, so treat the two as one unit.

The same asymmetry runs the other way. The overlay is a file and the **pause flag is in Valkey**, so
restoring files without the volume can leave you running with caps you never set, and restoring the
volume without the files can leave you paused with nothing on disk explaining why.

### An overlay that does not load stops every job

A settings file that is present but invalid is the opposite case: the worker refuses every job with
`settings-overlay-invalid` rather than guess. The panel and `dispatch_set` also refuse to write over
it, so a later `set` cannot erase the keys it still holds (it used to rebuild the file from nothing).
Fix the key the message names, or delete the file to start from an empty overlay. `pi-dispatch doctor`
reports such a file, with the reason, and never prints a value.

**Upgrading.** Since issue #501 a settings file with the same key twice is refused. Before, the last
value silently won. A hand-edited file that loaded before can stop every job after the upgrade. Run
`pi-dispatch doctor` after upgrading to find one. A misspelled dollar key (`maxcostusd`, `max_cost_usd`,
`PI_MAX_COST_USD` written into the file) is refused by name too, rather than ignored.

### A key or a file from a newer release

During an upgrade the panel, the console and the workers can run different releases, and they all share this file.
Since issue #761 none of them deletes what it cannot read:

- **A key this release does not know is kept.** The worker ignores it, as before, but every write (`/dispatch set`,
  `dispatch_set`, the console, `/dispatch secrets`) now writes it back as it was, in its place. A key that a later
  release added survives an edit from a console of issue #761's release or later. An earlier `/dispatch` panel (4.3.1
  included; 4.3.1 had no web console) or an earlier console build still drops every key it does not know when it
  writes the file, `secretBundles` included, so **upgrade
  every panel and console before anyone sets a key only the new release knows** (the whole order is in
  [upgrading.md](upgrading.md#the-order)). `pi-dispatch doctor` names such keys (names only, never a value) in one warning,
  so a typo stands out too: a misspelt key is kept the same way, so remove it if it is one.
- **A file written by a newer pi-dispatch is not a broken file.** It says so in a `version` key, which a release writes
  only when the file uses something an older release would misread (no release does yet). A worker that meets one waits
  instead of refusing: when the file is newer as a job starts, that job, of whatever kind, is deferred with the reason
  "Queued or configured by a newer pi-dispatch: waits for this host's upgrade" (`newer-release`) before any check that
  could refuse it, and looked at again every ten minutes. A file that turns newer while a job is already past that
  point is caught when the job reads its settings, but a check before that which does not read them (a `waitFor` it
  cannot read, a job too big for the host) can still refuse the job as it would with today's file. The panel and the
  console refuse to write over such a file, and say that nothing was written and no
  key was lost. Doctor fails on it with the upgrade as the fix. **Upgrade; do not edit or delete the file**, which would
  lose what that release wrote. The one exception is a `version` you added yourself: no release wrote that file, so
  remove the key (see Upgrading, below).
- **Each write checks that nobody wrote in between.** An edit compares the file with what it read just before it
  renames its own over it, and refuses (nothing written) when another session changed it. Look again and retry.

**Upgrading.** Earlier releases ignored a top-level `version` in this file, in `pause-windows.json` and in
`triggers.json`; since issue #761 it is read. If you put one there yourself (a revision number of your own, say),
remove it before you upgrade. A `version` that is not a whole number of 1 or more makes the settings file invalid, so
every job is refused `settings-overlay-invalid`, and stops a worker from starting on either of the other two; one above
1 reads as a file a newer release wrote, so jobs wait for an upgrade as described above. `pi-dispatch doctor` after
upgrading shows either.

The pause windows and triggers files follow the same rule ([`docs/pause-windows.md`](pause-windows.md),
[`docs/triggers.md`](triggers.md#the-files-version)).

## What is deliberately not backed up

These are all regenerated or bounded, and copying them buys nothing:

- `PI_JOBS_DIR` (default `<OS temp dir>/pi-dispatch-<uid>/jobs`, one per account): the read only `/job`
  inputs, rebuilt from scratch for every job.
- `PI_SANDBOX_DIR` (default `<PI_JOBS_DIR>/sandboxes`): a finished run's workspace, kept for
  `PI_SANDBOX_RETENTION_HOURS` (24 by default) so you can re-open it, and disposable by design.
- `<deployment>/logs/worker.out.log` and `worker.err.log`: your service manager's capture of the
  worker's stdout and stderr. **This is not the run history**, and `PI_LOGS_DIR` must never be pointed
  at that directory: the retention sweep deletes any `.log` or `.json` older than the window, and it
  would eat the daemon's own logs.
- A run record's temporary file in the run history, `<job id>.json.<pid>.<12 hex characters>.tmp`: the worker writes
  each record there first and renames it into place, so one is left behind only when the worker died in between. The
  sweep removes one that is more than an hour old, also when retention is `0` (keep forever), and never touches a
  `.tmp` of any other shape. Most other files pi-dispatch writes with a temp file and a rename (the settings file,
  the console's tokens, and the pause windows, projects, scoped-limits and subscriptions files the panel and the
  console write) use the same shape, so if you keep one of them in the run history folder, a temp file it left behind
  goes the same way after an hour.
- `console-login-codes/` beside the tokens file: one-time sign-in codes, each gone 60 seconds after it was made.
- `<PI_LOGS_DIR>/sandbox-gateway-active/`: the sandbox gateway's journal of the attachments open right now, named by
  their process ids, so that a restarted gateway can close their audit rows. A copy describes processes that no longer
  exist.
- `.staging-*`, `.stage.lock` and `.retired.json` inside the overlay's `packages/`: a package stage that was running,
  and the stager's own bookkeeping. They come along when you copy `PI_GLOBAL_PI_DIR` whole, which is fine.

## Stop, copy, start

Stop writers before you copy, outermost first. Each individual file is safe to copy on its own: `settings.json` and
`triggers.json` are both written with a temp file and a rename, and `triggers.json` takes a lock as well because it has
two writers. Since issue #761 a run record is written the same way, to a temp file beside it and renamed into place, so
a copy taken mid-run, or a worker that dies mid-write, finds the previous record or the new one, never a cut one. The
one exception is a host where that rename failed: the worker then writes the record in place, the old way, and logs
`run_record_in_place` with the job and an error code, so `grep` the worker's log for it if a copy matters. When that
error code is `ELOOP`, a symbolic link sat at the record's name and nothing was written: the worker never writes a
record through a link (except on Windows). What you cannot get while things are running is a consistent snapshot of the
SET. Stopping first is what buys the group.

1. **Stop the worker.** It owns the record writer, the retention sweep and one of the two
   `triggers.json` writers. If you installed it with `pi-dispatch service install`, use this project's
   own wrapper, which knows the scope it installed into:
   ```bash
   pi-dispatch service stop
   ```
   For a hand-rolled unit, stop it however you started it.
2. **Stop the receiver**, if you run one. It enqueues while you copy.
3. **Stop the console and close any `/dispatch` panel.** They are the other writers of `triggers.json` and the only
   writers of `settings.json`, and the console writes the tokens file and the audit trail. A console you installed as
   a service stops with `pi-dispatch service stop --console`. Stop a sandbox gateway too, if you run one: it writes
   audit rows.
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
   docker compose --env-file .env -f deploy/docker-compose.yml stop valkey
   docker volume ls --filter name=valkey-data          # the prefixed name is what you tar
   ```
   In a folder `/dispatch setup` laid out, add `-p <folder name>` after `compose` (and
   `-f deploy/docker-compose.valkey.yml` when setup wrote that file): without it compose names the project `deploy`
   and stops nothing of this folder's. Where that file exists, the Valkey's volume is `pi-dispatch-valkey-data`,
   as for `pi-dispatch up` above.
5. **Copy the files with `cp -a`.** The session store is listed separately and on purpose: it is the
   most PII bearing thing here, so it is never swept up by a wildcard. If yours lives under
   `~/.pi-dispatch/sessions`, which is what `docs/sessions.md` suggests, then copying that whole
   directory takes the transcripts with it. Decide that deliberately.
   ```bash
   cp -a ~/.pi-dispatch/logs            /backup/run-history     # with console-audit/, allocations/ and touch-outbox/
   cp -a ~/.pi-dispatch/settings.json   /backup/settings.json
   cp -a ~/.pi-dispatch/subscription-auth /backup/subscription-auth  # secret: keep the backup encrypted
   cp -a /path/to/deployment            /backup/deployment      # includes .env, the *.pem and console-tokens.json
   cp -a ~/.config/pi-dispatch          /backup/config-pi-dispatch   # sandbox and opener hosts; on Podman valkey.env (secret)
   cp -a "$PI_GLOBAL_PI_DIR"            /backup/global-pi       # the overlay and its staged packages
   cp -a ~/.pi/agent/pi-dispatch-deployment.json /backup/deployment-pointer.json
   cp -a "$PI_SESSIONS_DIR"             /backup/sessions        # ONLY if you accept holding transcripts
   ```
   The workspace checkpoints sit inside `PI_SESSIONS_DIR` unless `PI_CHECKPOINTS_DIR` moves them, and they hold the
   same kind of text: copy them only when you copy the sessions. Paths that a `*_FILE` or `*_DIR` setting moves are
   wherever you set them.
   **Use `cp -a`, or an archive that preserves timestamps.** The retention sweep decides a run
   record's age from its `mtime` and never from anything in its filename, so a copy that resets
   timestamps resurrects records the retention window had already retired, and they then live a
   second full window.
6. **Start again in reverse**: Valkey, worker, receiver, console and panel. On the rootless Podman venue Valkey is
   `systemctl --user start pi-dispatch-valkey` (the unit makes a new container on the same volume).

## Restoring

Same order reversed. Two things are worth knowing before you do it.

Run records are keyed by job id and the writer is last write wins, so a newer file store over an older
Valkey does not corrupt the history. What an older Valkey *does* restore is an older wait list and older
spend counters (`budget:*`), so caps under count for the rest of that window and held jobs come back.
Nothing about the file store gates a re-run: dedup and the wait list live entirely in Valkey. `pi-dispatch doctor`
notices a dollar counter that is now below what this host's own run records settled into its window
(`dollars.window-reset`), and says how to put it back ([When a counter resets](costs.md#when-a-counter-resets)). It
cannot see the job, token, scoped or model windows.

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

- **`pi-dispatch up` does not migrate anything.** It scaffolds, checks, and fills in `.env` lines that
  have no value yet; it never moves a file and never replaces a value you set.
- **If your worker runs as a different account than your `/dispatch` panel**, set `PI_LOGS_DIR` and
  `PI_SETTINGS_FILE` explicitly in the deployment's `.env`. `pi-dispatch up` now writes both, as the
  account default resolved by whoever ran it, which is the same answer you would have typed and is
  worth checking against the account the service runs as. It refuses, and says so, if your own shell
  already sets either to a relative path or to one inside the deployment folder: the retention sweep
  would then delete the deployment's own files. The default sits under a home directory, so
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
says so instead and keeps going. It is a warning, not a failure, and doctor still exits 0. An account with
no home directory gets its own temp root, `<OS temp dir>/pi-dispatch-<uid>` (issue #464; it used to be the
`<OS temp dir>/pi-dispatch` every account shared), created mode 0700; if another account made that directory
first, the worker refuses to start and doctor fails, naming the owner. You will
also see a one line hint while an older deployment's records are still sitting at the previous
default and the new location is still empty, and that hint retires itself once anything lands there.

Two more lines speak about what this page covers:

- **`state.older`** names a store still in a shape an older release left behind, with the step that moves it. Today
  that is the Valkey image, wherever it still says `valkey/valkey:8` rather than the pinned `valkey/valkey:8.1`: a
  compose file's `valkey` service, a Podman unit, or a `pi-dispatch-valkey` container this deployment's `up` started
  and still runs itself ([upgrading.md](upgrading.md#valkey-and-bullmq)). Each such store gets a line of its own.
- **`dollars.window-reset`** warns when a dollar window's counter in Valkey is missing, or below what this host's own
  run records settled into it, which is what a flushed, replaced or restored Valkey looks like
  ([When a counter resets](costs.md#when-a-counter-resets)).
