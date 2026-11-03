# Upgrading a deployment

A deployment is several programs that share one Valkey and a few files: the worker on each host, the receiver, the
console service and every operator's `/dispatch` (both from `@edgehero/pi-dispatch-admin`), the job image, and the
Valkey itself. An upgrade moves all of them, and for a while some run the new release and some the old one. This page
says in which order to move them so that nothing is lost or paid for twice in between, what each release changed in
what they store, and how to go back.

Each guide keeps the notes about its own feature. [The last sections](#notes-kept-in-each-guide) link them.

## Before you start

1. **Read what changed** between your release and the target: the rows below for each release in between
   ([What each release changed in stored state](#what-each-release-changed-in-stored-state)), and their release notes.
   From 5.0.0 on, every release note links this page.
2. **Back up**, with everything stopped ([backup.md](backup.md)). A copy from before the upgrade is the way back for a
   file a newer release has written.
3. **Run `pi-dispatch doctor` on every host** and clear what it fails on, so that a failure afterwards is the
   upgrade's and not one that was already there.
4. **Pick one version for everything.** The packages of one release share its number: `@edgehero/pi-dispatch` (the
   worker and the CLI), `@edgehero/pi-dispatch-receiver`, `@edgehero/pi-dispatch-admin` (the console and `/dispatch`),
   and `@edgehero/pi-dispatch-sandbox-gateway` if you run one. Install them with `npm install --save-exact`, never a
   range, and use the job image of the same release, `ghcr.io/edgehero/pi-job:<version>` ([job-image.md](job-image.md)).
   A receiver you run from `deploy/docker-compose.yml` takes `ghcr.io/edgehero/pi-dispatch-receiver:<version>`, never
   `:latest`, which can run ahead of the workers.
5. **Before 5.0.0** in particular:
   - Shorten every cron trigger's `on.id` that is longer than 176 characters. 5.0.0 refuses a triggers file that holds
     one, and the worker and the receiver do not start on it. Earlier releases accepted any length. A renamed id is a
     new schedule.
   - Remove a top-level `version` you added by hand to the settings file, `pause-windows.json` or `triggers.json`:
     5.0.0 reads it ([backup.md](backup.md#a-key-or-a-file-from-a-newer-release)).

## The order

1. **Pause.** `pi-dispatch pause` stops every worker from taking a job. It is stored in the queue, so it holds for the
   whole fleet and across restarts. Deliveries still queue up and wait.
2. **Wait for the running jobs**, until `pi-dispatch status` shows no active job. Parked, held and recovering runs may
   stay where they are: none of them holds a container.
3. **Upgrade the job image.** Pull the release's image and point `PI_JOB_IMAGE` at it. The image goes before the
   worker ([why](#why-this-order)).
4. **Upgrade and restart every worker.** In each deployment folder, `npm install --save-exact` the release's packages,
   then `pi-dispatch service restart`. On rootless Podman, run `pi-dispatch service install --force` before that
   restart: it rewrites the units this release changed and restarts Valkey when its unit changed
   ([Valkey and BullMQ](#valkey-and-bullmq)).
5. **Upgrade the receivers**, in the same `npm install` as the worker on that host, then
   `pi-dispatch service restart --receiver`. A receiver run from `deploy/docker-compose.yml` (its `receiver` profile)
   moves by its image instead: change the `receiver` service's `image:` line from
   `ghcr.io/edgehero/pi-dispatch-receiver:latest` to `ghcr.io/edgehero/pi-dispatch-receiver:<version>`, then, in the
   deployment folder:

   ```bash
   docker compose --env-file .env -f deploy/docker-compose.yml --profile receiver pull receiver
   docker compose --env-file .env -f deploy/docker-compose.yml --profile receiver up -d --no-deps receiver
   ```

   In a folder `/dispatch setup` laid out, add `-p <project>` after `compose`, and `-f deploy/docker-compose.valkey.yml`
   where setup wrote that override. `--no-deps` recreates the receiver alone and leaves the Valkey it depends on as it
   is.
6. **Upgrade the console and every `/dispatch`.** The console service takes the admin package from the same
   `npm install`, then `pi-dispatch service restart --console`. Each operator runs
   `pi install npm:@edgehero/pi-dispatch-admin@<version>` and starts pi again. A sandbox gateway goes now too.
7. **Run `pi-dispatch doctor` on every host.** `fleet.versions` should be quiet, or say that the workers with a live
   row report one version. Act on `state.older` and `dollars.window-reset` if either shows
   ([below](#valkey-and-bullmq), and [costs.md](costs.md#when-a-counter-resets)).
8. **Resume.** `pi-dispatch resume`. Then look for jobs refused as `trigger-skew` or `wait-skew` and run them again:
   an older receiver queued them during the window, without a field the upgraded worker expected.

**On one host**, with the services `pi-dispatch service install` made, steps 1 to 6 shrink to this:

```bash
docker pull ghcr.io/edgehero/pi-job:<version>   # then set PI_JOB_IMAGE=ghcr.io/edgehero/pi-job:<version> in .env
npm install --save-exact @edgehero/pi-dispatch@<version> @edgehero/pi-dispatch-receiver@<version> @edgehero/pi-dispatch-admin@<version>
pi-dispatch service restart --drain   # pause the shared queue, wait for its running jobs, restart the worker, resume it
pi-dispatch service restart --receiver
pi-dispatch service restart --console
pi install npm:@edgehero/pi-dispatch-admin@<version>   # then start pi again, for /dispatch
pi-dispatch doctor
```

The worker resumes a few seconds before the receiver restarts. A delivery in between is queued by the old receiver,
and if it needs a field the old one drops, the worker refuses it before it spends (`trigger-skew`): run it again.
A receiver run from compose moves as step 5 says.

`--drain` pauses, watches and resumes the shared queue only. Two hosts need the whole pause instead. A host that sets
`PI_WORKER_NAME` also runs jobs from a queue of its own (cron, chained and manual runs), which `--drain` neither
pauses, waits for nor resumes. On rootless Podman, `service install --force` restarts Valkey when its unit changed,
under any job still running. There, after the `docker pull` and the `npm install`:

```bash
pi-dispatch pause                     # every queue, this host's own included
pi-dispatch status                    # again, until it shows no active job
pi-dispatch service install --force   # rootless Podman only
pi-dispatch service restart
pi-dispatch service restart --receiver
pi-dispatch service restart --console
pi-dispatch resume                    # every queue, this host's own included
```

Then `pi install` and `pi-dispatch doctor` as above.

In both blocks doctor runs after the queue has resumed. A `state.older` move that recreates or restarts Valkey is made
while paused, so run `pi-dispatch pause` again first, wait until `pi-dispatch status` shows no active job, make the
move, then `pi-dispatch resume`.

## Why this order

Several guides say to upgrade some parts "together". This is what that means: one window, in this order, and nothing
new used (a key, a field, a role) until every part runs the new release.

- **Workers first**, because the receiver routes a delivery when it queues it, by what each worker says it can serve,
  and a worker says nothing about a feature it predates. An older worker does not offer a secret profile declared
  through the panel, so a newer receiver can send a job that binds one to a host that refuses it
  ([secrets.md](secrets.md)). An upgraded worker also refuses, before it spends, a job whose fields an older receiver
  dropped (`trigger-skew`, `wait-skew`), where an older worker would have run it without them.
- **The receivers right after**, in the same `npm install` as the worker, because a receiver drops every `run` field it
  does not know. The worker catches that for the fields that narrow a job, when it can read the triggers file
  ([triggers.md](triggers.md#limiting-which-models-a-job-may-call), [mcp.md](mcp.md#naming-servers-in-a-trigger),
  [sessions.md](sessions.md#parked-jobs-the-agent-asks-then-waits),
  [wait-for.md](wait-for.md#1-a-receiver-below-the-floor-drops-the-field-and-the-job-runs)). For `run.secrets` it
  cannot, and a job a stale receiver queued runs with the variable unset
  ([secrets.md](secrets.md#six-things-worth-knowing-before-you-wire-one)).
- **The console and every `/dispatch` in the same window**, because they write the files the others read. A `/dispatch`
  from 4.3.1 or earlier drops every settings key it does not know when it writes the file
  ([backup.md](backup.md#a-key-or-a-file-from-a-newer-release)), and an older admin bundles an older trigger
  validator, so it can refuse every trigger edit ([replicas.md](replicas.md#upgrading-and-rolling-back)). When
  backup.md says to upgrade every panel and console first, it means before anyone writes something only the new
  release knows.
- **The job image before the worker**, because a worker reads the counters an older image does not write as missing,
  and settles every capped job at the floor until the image moves ([costs.md](costs.md#a-call-that-reports-no-usage)).
  That overcharges and never undercharges.

**If you cannot pause.** Upgrade in the same order without step 1, and restart each worker only while it runs no
job. A worker restarted while it runs a job stops that job as a worker abort, which is not recovered, not even for a
durable run ([durable-runs.md](durable-runs.md#what-is-not-covered)). Expect `trigger-skew` and `wait-skew` refusals
for what an older receiver queued, and run those jobs again.

## Mixed versions: what is safe

| Running at the same time | What happens | So |
|---|---|---|
| A newer worker, an older job image | The worker reads `costUnreported` and `unmeteredChildren` as missing and settles every capped job at the floor: an overcharge, never an undercharge | Upgrade the image first ([costs.md](costs.md#a-call-that-reports-no-usage)) |
| An older worker, a newer job image | The worker drops what the image added to its exit line | Ship them in one window |
| An older worker, a newer receiver or console | An older worker does not offer a secret profile declared through the panel, so the receiver can route a job that binds it to a host that refuses it | Workers first ([secrets.md](secrets.md)) |
| A newer worker, an older receiver | The receiver drops a `run` field it does not know; the worker refuses such a job before it spends (`trigger-skew`, `wait-skew`) when it can read the triggers file | Receivers right after the workers, in the same `npm install`; run refused jobs again |
| A receiver older than the triggers file | From 5.0.0 on, a receiver refuses a triggers file whose `version` is above what it reads: it does not start on one, and on a live edit it keeps the triggers it had. Deliveries in between match nothing, and a forge does not send them again on its own | Upgrade every receiver before any trigger uses a field that needs version 2. No field needs one yet |
| A worker older than the settings file, `pause-windows.json` or `triggers.json` | From 5.0.0 on, the worker defers jobs as `newer-release` ("Queued or configured by a newer pi-dispatch: waits for this host's upgrade") and looks again every ten minutes. A 4.x worker ignores `version` and drops what it does not know | No file needs more than version 1 yet. Doctor's `fleet.store-versions` names the hosts ([multi-host.md](multi-host.md#what-the-panel-and-doctor-show-you)) |
| A job queued by a newer release, on an older worker | From 5.0.0 on, the job waits (`newer-release`). A 4.x worker has no such gate and runs a job by the fields it knows. A canary from the console's Updates page queues job data version 2, which a 4.x worker would run as the trigger's ordinary job, without the candidate package | Every worker on 5.0.0 before anyone runs a canary from the Updates page ([console.md](console.md#updates)) |
| An older `/dispatch` or console writing the settings file | A `/dispatch` from 4.3.1 or earlier drops every key it does not know (`secretBundles` included). From 5.0.0 on, an unknown key is kept | Write no setting a newer release added until every panel and console is upgraded |
| An older console, a newer tokens file or audit log | 5.0.0 is the first release with the web console. From it on, a console keeps a token of a role it does not know (it signs in nowhere) and reads an audit row with an action it does not know as unknown, not as a broken chain | Upgrade every console before you mint a token of a new role ([console.md](console.md#managing-tokens)) |
| Run records from different releases | From 5.0.0 on, a record carries `"v": 1`, and a reader shows a record a newer release wrote by its core facts only and leaves it out of totals. A 4.x reader reads a newer record in full and ignores fields it does not know | Nothing to do |
| Workers of different releases on one Valkey | Doctor warns: `fleet.versions` names each version the workers with a live row report ("pi-dispatch versions differ", or "pi-dispatch versions cannot all be read" when the only other group is a worker whose version is unknown), and says "this doctor X, this host's worker row reports Y" when the doctor you ran is not the release this host's worker row reports (a worker not restarted since its `npm install`, a doctor from another install, or, for up to 90 seconds, the row a killed worker left) | Finish the window: the same version on every host, each worker restarted while it runs no job, then `pi-dispatch resume` ([multi-host.md](multi-host.md#what-the-panel-and-doctor-show-you)) |
| Workers with different `PI_RUN_MIRROR_MAX_RUNS` | Each trims the shared run mirror to its own cap, so the lowest wins. A 4.x worker trims at 5000 | Set the same value on every host |
| Workers sharing `PI_LOGS_DIR` with different `PI_CONSOLE_AUDIT_RETENTION_DAYS` | Each host's sweep prunes the one `console-audit/` folder, so the shortest wins. A 4.x worker never touches that folder | Set the same value on every host ([console.md](console.md#the-audit-log)) |
| A recovery on a worker older than its checkpoint | The recovery waits for a worker that reads the checkpoint, for up to seven days. Each release reads two checkpoint versions | Let durable runs finish before you skip a release ([durable-runs.md](durable-runs.md#across-versions)) |
| A model role canary on a fleet with older workers | An older worker does not check the canary's exclusive lease | Upgrade every queue consumer before a canary ([canary.md](canary.md#enforced-execution-boundary)) |

Doctor reads only workers. A receiver publishes its version for the console's Connections page instead (from 5.0.0
on; an older receiver publishes nothing), so check the receivers there ([multi-host.md](multi-host.md#receiver-observations)).

## Valkey and BullMQ

**Valkey is pinned to a minor.** Since 5.0.0 every place pi-dispatch starts Valkey names one image, `valkey/valkey:8.1`
(`VALKEY_IMAGE`): `pi-dispatch up`, `deploy/docker-compose.yml` and the rootless Podman Quadlet. Earlier releases named
`valkey/valkey:8`, which moves to each new 8.x minor as it ships. The pin has four reasons: the specs make measured
claims about the Valkey a deployment runs, hosts drift apart across minors, a newer minor's data may not load on an
older one, and an upgrade needs a known starting point. `:8.1` still takes 8.1 patch releases. A later minor is a
release of pi-dispatch, never a pull on your host. On 2026-11-03 `valkey/valkey:8` and `valkey/valkey:8.1` pulled the
same image, Valkey 8.1.11. A host whose `:8` is older than 8.1.11 (it last pulled `:8` before then) moves a patch or a
minor when it takes the pin.

What moves an existing deployment:

- **`pi-dispatch up` (Docker).** `up` leaves a running `pi-dispatch-valkey` container alone, so it keeps the image it
  was made from. While that is `valkey/valkey:8`, doctor's `state.older` names it, and so does `up`'s summary, in a
  `valkey image` row, whenever `up` leaves that container as it is. Both name only a container this deployment's `up`
  started and still runs itself: never one another deployment owns, and never in a folder `/dispatch setup` handed to
  compose, where compose runs the Valkey (the next item). To move it, pause and wait for the running jobs, then run
  this in the deployment folder:

  ```bash
  docker stop pi-dispatch-valkey && docker rm pi-dispatch-valkey && pi-dispatch up
  ```

  Stop it before you remove it, never `docker rm -f`: the normal stop is what makes Valkey write its AOF out and save
  a final snapshot, so the last writes to the queue are kept. `up` then starts `valkey/valkey:8.1` on the same volume,
  `pi-dispatch-valkey-data`, and the queue in it is kept.
- **Compose.** In a folder `/dispatch setup` laid out, `deploy/docker-compose.yml` is a copy no upgrade refreshes.
  Doctor's `state.older` names it while the `valkey` service's `image:` line says `valkey/valkey:8`. Change that line to
  `image: valkey/valkey:8.1` (the installed package's `deploy/docker-compose.yml` has it). Then ask compose, from the
  folder, whether it runs this deployment's Valkey:

  ```bash
  docker compose -p <project> --env-file .env -f deploy/docker-compose.yml ps valkey
  ```

  Where that lists a container, recreate it with the command doctor prints:

  ```bash
  docker compose -p <project> --env-file .env -f deploy/docker-compose.yml up -d valkey
  ```

  Add `-f deploy/docker-compose.valkey.yml` to both where setup wrote that override (doctor's command has it); leave out
  `-p <project>` if you run the file without it. Compose stops the old container first, so it writes its AOF out, and
  keeps the volume and the queue in it. Where `ps` lists nothing, compose does not run this deployment's Valkey (the
  `pi-dispatch-valkey` container `pi-dispatch up` started, above, or one you run yourself does): change the line only,
  since `up -d valkey` would start a second Valkey beside it, on a new and empty volume. Doctor sees the file and not
  the container compose made, so once the file says `8.1`, run `ps`, and the recreate where it lists a container, even
  if no line asks for it. An earlier setup put its copy at the folder's top,
  `docker-compose.yml`, and doctor names that one too while it says `valkey/valkey:8`. Setup no longer runs it: move
  any edits of yours to `deploy/docker-compose.yml` and remove it, or, if you still run it, change its line the same
  way.
- **Rootless Podman.** `pi-dispatch service install --force` rewrites the Quadlet and restarts Valkey on the new image,
  stopped first so it writes its AOF out, on the same volume. Pause first. It restarts the worker and receiver units
  only when the Valkey's password file changed too, so restart them yourself, as steps 4 and 5 of
  [the order](#the-order) say. `pi-dispatch up` leaves a changed unit file as it is, so until the install runs,
  doctor's `state.older` names the installed unit.
- **The console's service setup** refuses with `unsafe-dependencies` while the Podman units on the host differ from
  what this release renders. Run `pi-dispatch service install --force` from a terminal first.

**Where doctor looks.** At the `valkey` service's `image:` line in the compose file in `deploy/` and in the one at the
top of the folder it runs in (another service you added there on `valkey/valkey:8` is yours, and left alone), at the
installed Quadlet unit, and at the `pi-dispatch-valkey` container. It asks docker about the container only where
`local` is in `PI_BACKENDS`, `docker info` answered and `VALKEY_URL` names this host, as read from the service's `.env`
or this shell, and only where `up`'s own reader reads that `.env` without an error and, if the file sets `VALKEY_URL`,
finds the value doctor judges. So not when the file holds a byte systemd refuses to load (on Linux, a NUL or invalid
UTF-8 anywhere in it), nor when it names `VALKEY_URL`, `PI_VALKEY_SHARED` or `VALKEY_PASSWORD` and has a line the
service's loader reads differently or one of those three on a line that reader cannot read, whether this shell sets
`VALKEY_URL` or not, nor when the shell's `VALKEY_URL` and the `.env`'s disagree. `up` refuses each of these on Linux,
and the last everywhere. It names the container only when this deployment's `up` started it and still runs it itself,
the rule `up`'s `valkey image` row follows too (not in a folder handed to compose, never another deployment's). Where
that rule says `up`'s container is this deployment's Valkey, the compose file's fix says to change its `image:` line
and nothing more, without the recreate; where compose runs the Valkey, or doctor cannot tell, the fix keeps the
recreate. Each finding is a `state.older` line of its own, with the step that moves it. Only the exact old name is one
(`valkey/valkey:8`, or `docker.io/valkey/valkey:8` in the unit): an image you chose, such as `valkey/valkey:8.1-alpine`
or a digest, is left alone. A merge left unresolved in the `valkey` service counts both sides: its conflict marker
lines read as blank, and so does the merge base that git's diff3 and zdiff3 styles add between `|||||||` and `=======`,
so an `image:` line on `valkey/valkey:8` on either side is a finding, and one in the merge base alone is not.

**Data across the minors.** Measured on 2026-11-03: Valkey 8.0.2 and 8.1.11 each loaded a data volume the other had
written, through the AOF and through the RDB file alone, with every key, every TTL and the last writes intact. So the
queue survives a move between 8.0 and 8.1 in either direction. That says nothing about a later minor, whose files need
not load in an older one, which is one of the reasons for the pin: before you move Valkey back across a minor nobody
measured, take a copy of its volume ([backup.md](backup.md#stop-copy-start)).

**BullMQ** keeps the queue in Valkey in its own format. pi-dispatch pins it exactly, and 5.0.0 stays on 5.80.4, the
version 4.3.1 runs. From 5.0.0 every BullMQ fact pi-dispatch reads past BullMQ's public API (key names, job fields, the
pause flag, the delayed score, the run ids of a cron trigger) is in one module, `@edgehero/pi-dispatch/bullmq-internals`,
checked against that version by its tests. Never roll back across a release that moved the BullMQ pin while jobs are
queued: an older BullMQ need not read what a newer one wrote. The release notes name such a bump.

## What each release changed in stored state

Release numbers come from the git tags. The next release is 5.0.0.

### 5.0.0

| Store | What changed, and what an older release does with it | Guide |
|---|---|---|
| Settings file (`PI_SETTINGS_FILE`) | Every writer keeps a key it does not know. An optional top-level `version`, written only when a key needs it (none does yet). A `version` you added by hand is now read. A 4.x `/dispatch` drops every key it does not know when it writes, and a 4.x worker ignores `version` | [backup.md](backup.md#a-key-or-a-file-from-a-newer-release) |
| `pause-windows.json` | An optional `version`, as above. The writer keeps top-level keys it does not own. A 4.x writer drops them and `version`; a 4.x worker reads a newer file and drops what it does not know | [pause-windows.md](pause-windows.md#the-files-version) |
| `triggers.json` | An optional `version`, as above. A cron `on.id` longer than 176 characters is refused. A 4.x writer (the panel, and the worker's one-shot disarm) writes `triggers` alone, dropping `version` and every other top-level block, `secretBundles` among them; a 4.x worker or receiver reads a newer file and drops what it does not know | [triggers.md](triggers.md#the-files-version) |
| Queued jobs and the sandbox manifest | An optional version. A canary from the Updates page queues job data version 2 (issue #796), which a 4.x worker would run as the trigger's ordinary job, without the candidate package: every worker on 5.0.0 before anyone runs one. A worker defers a job or a file a newer release wrote as `newer-release`; a 4.x worker runs a job by the fields it knows | [console.md](console.md#updates), [sandbox.md](sandbox.md) |
| Run records (`PI_LOGS_DIR`) | Written to a temporary file and renamed into place, with `"v": 1`. A record that reserved in the deployment's dollar windows says which ones (`dollars.reservedIn`: dates and a hash of the Valkey's address, never the address). Doctor's `dollars.window-reset` counts only such records, so it sees nothing of the runs before 5.0.0. A 4.x reader ignores fields it does not know, and its sweep leaves a crash leftover `<job id>.json.<pid>.<12 hex>.tmp`, which is harmless | [backup.md](backup.md#stop-copy-start), [costs.md](costs.md#when-a-counter-resets) |
| The web console | New: `console-tokens.json`, `console-login-codes/` and `<PI_LOGS_DIR>/console-audit/`. A token of a role a console does not know is kept and signs in nowhere. An audit row with an action or outcome a console does not know reads as unknown, not as damage. `PI_CONSOLE_AUDIT_RETENTION_DAYS` keeps the audit for its own number of days. 4.x has no console and leaves these files alone | [console.md](console.md#managing-tokens), [console.md](console.md#the-audit-log) |
| Durable runs, steering, approvals, live transcripts, watch, zero-touch, Updates, the sandbox gateway, model failover | New Valkey keys and new files, listed in [backup.md](backup.md#what-the-valkey-volume-holds). A 4.x worker knows none of them, so a run held for an approval or waiting for its recovery is not continued | [durable-runs.md](durable-runs.md#across-versions) |
| Workspace checkpoints | The boot sweep keeps the job folder of a checkpoint pointer of any version. A recovery whose checkpoint a newer release wrote waits for an upgraded worker instead of being refused | [durable-runs.md](durable-runs.md#across-versions) |
| Run mirror (`runs:*`) | `PI_RUN_MIRROR_MAX_RUNS` (5000 by default, 1000 to 20000) caps it; the lowest setting in a fleet wins. A 4.x worker trims at 5000 | [multi-host.md](multi-host.md#what-the-panel-and-doctor-show-you) |
| Valkey image | Pinned to `valkey/valkey:8.1`. Doctor's `state.older` names each of these still on `valkey/valkey:8`: a compose file's `valkey` service, a Quadlet, and a container this deployment's `up` started and still runs. `up`'s summary names that container too | [Valkey and BullMQ](#valkey-and-bullmq) |
| Cron run ids | One reader for `repeat:<id>:<time>` and `manual:<id>:<time>` everywhere. A run record's cron id is read whatever its length, and the console and `/dispatch` name a schedule whose id is 177 to 200 characters long, which an earlier release made and showed with no id, so you can find and remove it. An id no release makes (a time with a leading 0, a `:` in the id) no longer counts as a cron run | [triggers.md](triggers.md#trigger-types-what-fires-each-one-and-what-it-runs) |
| Model ids | A model id defined in the overlay can be the deployment's default only in the shape a trigger's `run.model` takes (issue #673). Outside it `PI_MODEL` stops the worker at boot, and a settings file holding one refuses every job | [global-pi-overlay.md](global-pi-overlay.md#custom-providers) |
| The job image's pi | pi 1.4.0 (issue #693) and then 1.5.0 (issue #796). 59 catalog models are gone, and a trigger whose `watch.decide` names one refuses the triggers file. Each session key starts cold once, as after every pi change | [job-image.md](job-image.md#pi-150-upgrade-issue-796), [sessions.md](sessions.md#when-it-silently-doesnt-resume) |
| Console tokens | A token may carry the `agent` role (issue #766) | [console.md](console.md#managing-tokens) |
| The `@edgehero/pi-dispatch/defer-reasons` subpath | `dueOfScore`, `isSchedulerNext` and `DELAYED_SCORE_SHIFT` now live in `@edgehero/pi-dispatch/bullmq-internals` and are exported from both, so an import keeps working | |

### Earlier releases

| Release | Store | What changed | Guide |
|---|---|---|---|
| 4.3.0 | `triggers.json`, the session store (`PI_SESSIONS_DIR`) | Parked runs (issue #625): a trigger's `run.awaitInput`, and a `parked` mark in a session key's folder while its last run waits for an answer. A 4.2 worker drops `awaitInput` and runs the job without the tool that asks, and never reads or clears a `parked` mark; a 4.3 worker refuses a job a 4.2 receiver queued without the field (`trigger-skew`), and a 4.2 receiver does not route a reply that lacks the comment trigger's phrase | [sessions.md](sessions.md#parked-jobs-the-agent-asks-then-waits) |
| 4.0.0 | `scoped-limits.json`, run records | Job sizes per project need version 3 (issue #596), and each record keeps the run's memory and CPU use. A 3.x worker refuses a version 3 file at start, and one already running keeps its last good file | [sizing.md](sizing.md#2-set-a-size-per-project), [scoped-limits.md](scoped-limits.md#job-sizes-version-3) |
| 3.1.0 | `triggers.json`, `PI_PROVIDER`, `PI_ALLOWED_MODELS`, scoped limits, `subscriptions.json`, the overlay `models.json` | pi 1.0.3 (issue #587): the provider `azure-openai-responses` is now `azure`. A job on the old id is refused before it spends | [triggers.md](triggers.md#choosing-the-model-and-the-turn-limit) |
| 3.0.0 | `scoped-limits.json`, `pause-windows.json`, `projects.json` | Forge-qualified scopes and counters keyed by their row (issue #498), and projects (issue #499). A qualified row needs version 2, which a 2.x worker refuses; a 2.x worker reads a qualified pause window as a name no job has | [scoped-limits.md](scoped-limits.md#the-limit-schema), [multi-host.md](multi-host.md#two-bounds-that-used-to-multiply), [projects.md](projects.md) |
| 3.0.0 | Settings file, `scoped-limits.json`, Valkey `budget:usd:*` | Dollar caps and windows (issue #501). A settings file with a key written twice is refused, and so is a misspelled dollar key | [costs.md](costs.md#dollar-caps), [backup.md](backup.md#an-overlay-that-does-not-load-stops-every-job) |
| 3.0.0 | The overlay's `models.json` and `extensions/` | Models are checked before a job spends, a `models.json` link is refused and `PI_GLOBAL_PI_DIR` must be absolute (issue #502). Loose files in `extensions/` load, and some package layouts there now load nothing (issue #544) | [global-pi-overlay.md](global-pi-overlay.md#custom-providers) |
| 3.0.0 | `model-endpoints.json`, the egress rules | Declared model servers; the proxy mounts `model-endpoints.conf` (issue #503) | [egress.md](egress.md#upgrading-a-deployment-from-before-503) |
| 2.0.0 | Run history, settings file | The defaults moved from the OS temp directory to `~/.pi-dispatch` (issue #290). Doctor names records still at the old place | [backup.md](backup.md#upgrading-from-a-version-that-kept-state-in-the-os-temp-directory) |
| 2.0.0 | Jobs and kept workspaces | One temp root per account, `<OS temp dir>/pi-dispatch-<uid>` (issue #464). Workspaces kept under the old shared path are no longer opened or swept, and doctor names them | [sandbox.md](sandbox.md#read-this-before-you-leave-it-on) |
| 2.0.0 | Valkey, `.env` | A password per deployment, `VALKEY_PASSWORD` (issue #468) | [podman.md](podman.md#setup), [secrets.md](secrets.md) |
| 2.0.0 | `egress-proxy.conf` copies | Doctor names a copy that differs from the package's, and `up` refreshes it (issue #484) | [egress.md](egress.md#lines-about-leftovers) |
| 2.0.0 | Podman units | The rootless network keeper (issue #458) | [podman.md](podman.md#setup) |

## Rolling back

1. **Pause and wait** for the running jobs, as for an upgrade. Let durable runs finish, and answer or cancel parked runs
   and pending approvals: a release from before a feature does not continue it.
2. **Install the older exact version** of every package, and its job image, on every host, and restart every service.
3. **Fix what the older release refuses.** Its doctor names most of it. The known cases:
   - `scoped-limits.json` with a size (version 3) is refused before 4.0.0, and one with qualified or dollar rows
     (version 2) before 3.0.0;
   - a triggers file with `replicas` on a trigger that is not GitHub is refused before 1.1.0, and only a hand edit
     removes the field ([replicas.md](replicas.md#upgrading-and-rolling-back));
   - a `version` above 1 in the settings file, `pause-windows.json` or `triggers.json` makes a 5.0.0 or later worker
     wait; a 4.x worker ignores it and drops what it does not know. No release writes one yet;
   - a console token of a role the older console does not know is kept and signs in nowhere (5.0.0 and later).
   Fix those by hand, or restore the copy you took before the upgrade. Restoring `triggers.json` re-arms the one-shots
   that fired since: keep the newer `on.disarmed` marks ([backup.md](backup.md#restoring)).
4. **What stays harmless.** An older release ignores the run record fields it does not know. A 4.x worker leaves crash
   leftovers `<job id>.json.<pid>.<12 hex>.tmp` in the logs folder: delete them by hand. Every earlier release leaves
   `console-audit/` alone: a 4.x worker's sweep reads only the top of the logs folder
   ([console.md](console.md#the-audit-log)).
5. **Valkey stays on `valkey/valkey:8.1`** unless you recreate it. A 4.x `up` and compose file name `valkey/valkey:8`,
   which pulled the same 8.1 image on 2026-11-03, and 8.0.2 loaded an 8.1.11 volume when measured. Move it back
   across any other minor only with a copy of its volume from before the upgrade.
6. **Resume** with `pi-dispatch resume` once the older release's `pi-dispatch doctor` is clean on every host. The pause
   from step 1 is kept in Valkey, so it outlives every restart, and no worker takes a job until you resume.

## Notes kept in each guide

- [backup.md](backup.md#a-key-or-a-file-from-a-newer-release): keys and files a newer release wrote, the `version` you
  may have added by hand, and [state from before #290](backup.md#upgrading-from-a-version-that-kept-state-in-the-os-temp-directory).
- [costs.md](costs.md#a-call-that-reports-no-usage): the image before the worker, and
  [when a counter resets](costs.md#when-a-counter-resets).
- [egress.md](egress.md): turning the proxy on, [the #503 rules](egress.md#upgrading-a-deployment-from-before-503) and
  [a copy older than the package's](egress.md#lines-about-leftovers).
- [global-pi-overlay.md](global-pi-overlay.md#custom-providers): models the worker can see, links refused, model ids,
  and the [extensions layout](global-pi-overlay.md#extensions-the-sharp-edge--staged-and-loaded-by-default).
- [job-image.md](job-image.md#pi-150-upgrade-issue-796): pi 1.5.0, and [pi 1.4.0](job-image.md#pi-140-upgrade-issue-693).
- [replicas.md](replicas.md#upgrading-and-rolling-back): the admin's bundled validator, and rolling back.
- [secrets.md](secrets.md): workers before the receiver and the console, and the
  [floor for `run.secrets`](secrets.md#six-things-worth-knowing-before-you-wire-one).
- [scoped-limits.md](scoped-limits.md#job-sizes-version-3) and [sizing.md](sizing.md#2-set-a-size-per-project): every
  worker before you write a size.
- [multi-host.md](multi-host.md#what-the-panel-and-doctor-show-you): mixed releases, `fleet.store-versions`,
  `fleet.versions`, and [the forge-qualified scopes](multi-host.md#two-bounds-that-used-to-multiply).
- [triggers.md](triggers.md#the-files-version): the file's version, and the receiver for
  [`models`](triggers.md#limiting-which-models-a-job-may-call) and [`maxCostUsd`](triggers.md#a-dollar-cap-per-job).
- [wait-for.md](wait-for.md#1-a-receiver-below-the-floor-drops-the-field-and-the-job-runs): a receiver below the floor.
- [mcp.md](mcp.md#naming-servers-in-a-trigger) and [sessions.md](sessions.md#parked-jobs-the-agent-asks-then-waits):
  the receiver with the worker.
- [sessions.md](sessions.md#when-it-silently-doesnt-resume): each new job image starts every session key cold once.
- [durable-runs.md](durable-runs.md#across-versions): checkpoints across versions.
- [pause-windows.md](pause-windows.md#the-files-version): the file's version.
- [podman.md](podman.md#setup): the keeper, the Valkey password and the Valkey image on the rootless venue.
- [sandbox.md](sandbox.md#read-this-before-you-leave-it-on): workspaces kept under the old shared path.
- [canary.md](canary.md#enforced-execution-boundary): every queue consumer before a canary.
- [console.md](console.md#managing-tokens): tokens of an unknown role, the [audit log](console.md#the-audit-log), and
  [Updates](console.md#updates).
- [zero-touch.md](zero-touch.md#what-the-numbers-can-prove): tracking starts with the release that records it.
- [notifications.md](notifications.md): what changes with nothing configured.

## For maintainers

A pull request that changes what pi-dispatch stores (a file, a run record, job data, a Valkey key, the Valkey image or
the BullMQ pin) adds its row here, under the release it will ship in. When the older shape stays readable, it also
registers a detector in `worker/src/older-state.mjs`, which doctor reports as `state.older`, gated so that it retires
itself once nothing is left in the older shape. Release numbers on this page come from `git tag --contains <commit>`
in a clone with the tags; CI has no tags, so no test can check them. `worker/test/upgrading-doc.test.mjs` checks the
rest: that every release note links this page, that the guides with upgrade notes link it, and that every link here
resolves.
