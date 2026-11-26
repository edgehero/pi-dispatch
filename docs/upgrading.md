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
6. **Before 5.2.0**, if you edit `pause-windows.json` by hand: check that no key is written twice
   anywhere in it, such as two `windows` keys or one field twice in a window. 5.2.0 refuses such a file and the
   worker does not start on it. Earlier releases kept the last value, so what applied was not what the file seemed to say.
7. **Before 5.2.1**, check that nothing you configure names `PI_JOB_SIZE_CPUS` or `PI_JOB_SIZE_MEMORY_MIB`: not a
   trigger's `run.secrets`, a secret bundle's `endpoints` or what its resolver returns, an overlay `mcp.json` server, or
   `PI_FORWARD_ENV`. From 5.2.1 the worker sets both in every job and refuses them anywhere else
   ([the 5.2.1 row](#521)).
8. **Before 5.3.0**, the same check for `PI_JOB_IDLE_MS`, `PI_JOB_STALL_MS` and `PI_CREDENTIAL_REFRESH`, which 5.3.0
   sets in jobs itself ([job limits](job-limits.md)). Then plan to rebuild every job image you derived from ours on
   the 5.3.0 image: until it is rebuilt, its jobs keep the 30-minute limit and their credentials are not renewed
   ([the 5.3.0 rows](#530)). The console moves to `http://pi-dispatch.localhost:4790/`, so each browser signs in once more.
9. **Before 5.4.3**, the same check for `PI_JOB_MAX_MS` and `PI_JOB_LEFT_MS`, which 5.4.3 sets in jobs itself
   ([the row](#warnings-before-the-turn-and-time-limits-1055)).

## The order

1. **Pause.** `pi-dispatch pause` stops every worker from taking a job. It is stored in the queue, so it holds for the
   whole fleet and across restarts. Deliveries still queue up and wait.
2. **Wait for the running jobs**, until `pi-dispatch status` shows no active job. Parked, held and recovering runs may
   stay where they are: none of them holds a container.
3. **Upgrade the job image.** Pull the release's image and point `PI_JOB_IMAGE` at it. An image a trigger names in
   `run.image` moves too, on every host that runs it: point the trigger at the release's image, or rebuild yours from it
   ([job-image.md](job-image.md)). The image goes before the worker ([why](#why-this-order)).
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
pi-dispatch service restart --drain   # pause this host's queues, wait for their running jobs, restart the worker, resume them
pi-dispatch service restart --receiver
pi-dispatch service restart --console
pi install npm:@edgehero/pi-dispatch-admin@<version>   # then start pi again, for /dispatch
pi-dispatch doctor
```

The worker resumes a few seconds before the receiver restarts. A delivery in between is queued by the old receiver,
and if it needs a field the old one drops, the worker refuses it before it spends (`trigger-skew`): run it again.
A receiver run from compose moves as step 5 says.

`--drain` pauses, watches and resumes this host's queues: the shared one and, on a host that sets `PI_WORKER_NAME`, its
own, where its cron, chained and manual runs wait, and the forge deliveries a secret or wait profile routes to it
([several machines](multi-host.md#a-forge-delivery-that-needs-one-particular-machine)). A queue paused before it stays
paused. It is not the fleet's pause, so two hosts need the whole pause instead. On rootless Podman,
`service install --force` restarts Valkey when its unit changed, under any job still running. There, after the
`docker pull` and the `npm install`:

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
| An older worker, a trigger whose `run.secrets` holds its provider's own API key | A worker from before the provider key could be a run secret refuses every job of that trigger before it spends: `provider-unconfigured` where it holds no key of its own for that provider, `secret-name-reserved` where it does. A random pool or a fallback list there passes over a candidate on that provider while the worker holds no key for it, and a job drawn onto it where the worker holds one is refused the same way. Nothing is stored differently, so nothing moves | Upgrade every worker before a trigger relies on it ([secrets.md](secrets.md#the-provider-key-as-a-run-secret)) |
| An older worker, a random pool mixing subscription and API-key candidates | A worker from before a draw could decide its own billing class refuses every job of such a pool as `auth-mixed-billing` before it starts: nothing is drawn, stored or spent. Where newer workers share its Valkey, a job one of them picks up runs, and one the older worker picks up is refused. Nothing is stored differently, so nothing moves | Upgrade every worker before a pool mixes the classes ([triggers.md](triggers.md#choosing-randomly-from-a-reviewed-pool)) |
| A newer worker, an older job image, a subscription connection without paid extra usage | The worker marks the connection's calls as notional; an image from before issue #1008 ignores the mark and counts every subscription call against the cost cap, as before. A job whose every model is on such a connection reserves nothing in the dollar windows yet runs under its real cap, so it can still stop as `cost-cap` at list price; a job mixing it with API-key calls settles its whole cost, since the image writes no `costNotional`: an overcharge, never an undercharge. Until the image is upgraded, every such subscription-only job logs `dollar_unreserved_spent` at its list price, with `missing: "costNotional"` | Upgrade the image to stop counting those calls ([costs.md](costs.md#what-the-cap-counts)) |
| An older worker, a newer job image, a subscription connection | A worker from before issue #1008 never marks a connection, so the image counts every subscription call against the cap and the windows charge it, as before | Upgrade the workers to stop counting them |
| Workers of different releases on one Valkey, subscription jobs | A worker from issue #1008 on reserves nothing for a job whose every model is on a subscription without paid extra usage and settles a mixed job's billed part only; an older worker reserves the cap and charges the whole metered cost. On one set of dollar windows the two charge differently until every worker is upgraded | Finish the window |
| A newer console, subscription bindings that differ between hosts, an older worker or an older job image | The console's trigger page and its paid previews read the bindings every live host publishes. A provider any host binds to a subscription without paid extra usage is taken as notional: its models skip the cap's first-call check, and a job that reaches only such models previews $0.00 in the dollar windows. A host whose own connections file does not bind that provider runs its calls on an API key under the cap, a worker from before issue #1008 never marks a connection notional, and an image from before it counts every subscription call against the cap, so on such a host the preview can say less than the host then reserves or refuses; the worker still checks every cap at pickup | Bind a provider the same way on every host that runs its jobs, and upgrade the workers and the image together |
| A newer worker, an older job image, a subscription job with a role map | The worker refuses each such job before it spends, `job-image-subscription-roles-unsupported`: that image's runner would start the role child as a separate pi process, which the subscription refuses, and the whole job would stop at the first child call. It refuses one whose role map holds only API-key models too, which would run there, since the worker does not tell the two apart | Upgrade the image before a subscription trigger's scope gets a role map |
| An older worker, a newer job image, a subscription job with a role map | The job runs and its role child runs inside the runner, as with a newer worker. An older worker does not know the refusal `subscription-child-unsupported`, so the record of a run that has one keeps none of its role refusals | Upgrade the workers to keep them |
| A newer worker, an older job image, a trigger with `run.maxSubscriptionUsd` | The worker refuses each job of it before it spends, `job-image-subscription-allowance-unsupported`: that image's runner would ignore the allowance and run the job's subscription calls with no dollar limit | Upgrade the image before a trigger sets an allowance |
| An older worker or receiver, a trigger with `run.maxSubscriptionUsd` | The field needs triggers file version 11, so an older receiver or worker refuses to load such a file, keeping the triggers it had on a live edit. A job of it is queued at job data version 12, which an older worker holds (`newer-release`) until a worker that reads it takes it, spending nothing. A service that dropped the field anyway is caught as `trigger-skew` by a newer worker that reads the triggers file | Upgrade every worker, receiver and console host before a trigger sets an allowance; the trigger's page refuses the edit while a live host reads less |
| An older worker or receiver, a random pool with `weights` | A pool's weights need triggers file version 12, so an older receiver or worker refuses to load such a file, keeping the triggers it had on a live edit. A job of it is queued at job data version 13, which an older worker holds (`newer-release`) until a worker that reads it takes it, spending nothing. A pool without weights keeps versions 6 and 7 | Upgrade every worker, receiver and console host before a pool sets weights; the trigger's page refuses an edit that keeps them while a live host reads less ([weighting the pool](triggers.md#weighting-the-pool)) |
| An older worker, a trigger with `run.auxiliaryModels` or a random pool, and `run.secrets` or a project bundle | A worker from before this change accepts an auxiliary model's `ANTHROPIC_OAUTH_TOKEN`, or a `github-copilot` or `google-vertex` auxiliary model's token, in `run.secrets` or a project bundle and gives that model the value, lets a bundle's `ANTHROPIC_API_KEY` replace the host's key for an `anthropic` auxiliary model, lets a host bearer or OAuth token outrank an auxiliary model's declared key, runs a declared key for an auxiliary provider bound to a subscription and drops it, and hands a pool candidate's API key from `run.secrets` or a project bundle to every draw, a subscription draw too, where a tool can spend it outside the cost meter. A newer worker refuses each of those bindings as `secret-name-reserved` before it spends, so after the upgrade a project bundle carrying any variable of an auxiliary model's provider refuses every job of a trigger that lists that model, and it keeps a pool's key out of draws that do not use it. Nothing is stored differently, so nothing moves | Upgrade every worker. Rename such a bundle variable in the secrets manager, or, for an API key a tool in the job reads under its usual name (`OPENAI_API_KEY` beside an `openai` auxiliary model), bind it in that trigger's own `run.secrets` instead: there it is that model's declared key and tools still see it. `pi-dispatch doctor` does not see this, since its bundle check judges the deployment's provider only: compare the variable names `pi-dispatch doctor --secrets` lists for each bundle with the providers in `run.auxiliaryModels` of the triggers in that bundle's project (`anthropic` reads `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN`) ([secrets.md](secrets.md#the-provider-key-as-a-run-secret)) |
| An older worker, a watch trigger whose `run.secrets` holds its investigation's or its `decide` model's provider's own API key | A worker from before a watch job could declare a key refuses every job of that trigger before it spends: `secret-name-reserved`, or `provider-unconfigured` where it holds no key of its own for that provider. Nothing is stored differently, so nothing moves | Upgrade every worker before a watch rule relies on it ([secrets.md](secrets.md#the-provider-key-as-a-run-secret)) |
| An older worker or receiver, an answer rule or the `zeroTouch` block with `secrets` or `secretsProfile` | The fields need triggers file version 12, so an older worker or receiver refuses to load such a file and keeps the triggers it had on a live edit. A newer worker hands a draft or grouping job its declared keys at pickup; nothing is queued with them, so no job data version moves. A draft or grouping already queued when its rule or the block gains or changes either field ends as `config-changed` (`question-group-config-changed`) and buys nothing | Upgrade every worker, receiver and console host before a rule or the block declares a key; declare its profile on every worker that runs drafts or groupings |
| A quota reserve, a host that owns a Claude connection and runs an older worker | A worker from before the reserve reads no `PI_QUOTA_RESERVE_PERCENT` and starts every job on the connections it owns, however full a window is; only that host's jobs are held or not, since jobs on a connection run only on its owner. `run.quotaReserve` is read by the owner's worker from its own triggers file, so no receiver or poller needs it, and every older loader drops it and loads the file | Upgrade every host that owns a Claude connection, set the reserve there, and give it the triggers file ([subscription-auth.md](subscription-auth.md#quota-reserve)) |
| A newer console, a run whose files an older worker kept | A worker from before issue #942 does not answer the console's request for a run's files, so the run page's Artifacts card says that host did not answer in time or runs an earlier version, and its files open only on a console that runs on that host. Nothing is stored differently, so nothing moves | Upgrade every worker, then reload the run page ([a run's artifacts](console.md#a-runs-artifacts)) |
| A newer worker, an older receiver | The receiver drops a `run` field it does not know; the worker refuses such a job before it spends (`trigger-skew`, `wait-skew`) when it can read the triggers file | Receivers right after the workers, in the same `npm install`; run refused jobs again |
| A receiver older than the triggers file | From 5.0.0 on, a receiver refuses a triggers file whose `version` is above what it reads. It does not start on one, and a forge does not send again what it misses while it is down. On a live edit it keeps the triggers it had, so a delivery still matches those and queues its job without what the file now adds. A worker that reads the added field refuses that job (`trigger-skew`) where it can read the file | Upgrade every receiver before any trigger uses a field that needs version 2 ([what a fleet needs](#what-a-fleet-needs-before-a-trigger-leaves-something-out)) |
| A worker older than the settings file, `pause-windows.json` or `triggers.json` | From 5.0.0 on, the worker defers jobs as `newer-release` ("Queued or configured by a newer pi-dispatch: waits for this host's upgrade") and looks again every ten minutes. A 4.x worker ignores `version` and drops what it does not know | Of these, only `triggers.json` needs more than version 1, for a trigger that leaves something out ([what a fleet needs](#what-a-fleet-needs-before-a-trigger-leaves-something-out)). Doctor's `fleet.store-versions` names the hosts ([multi-host.md](multi-host.md#what-the-panel-and-doctor-show-you)) |
| A job queued by a newer release, on an older worker | From 5.0.0 on, the job waits (`newer-release`). A 4.x worker has no such gate and runs a job by the fields it knows. A canary from the console's Updates page queues job data version 2, which a 4.x worker would run as the trigger's ordinary job, without the candidate package. A job of a trigger that leaves something out queues version 3, which a 4.x worker runs by the fields it knows, so wider than the file says | Every worker on 5.0.0 before anyone runs a canary from the Updates page ([console.md](console.md#updates)) or a trigger leaves something out ([below](#what-a-fleet-needs-before-a-trigger-leaves-something-out)) |
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

### What a fleet needs before a trigger leaves something out

`run.excludeExtensions` and `run.excludeExtensionTools` need `triggers.json` at version 2 and job data at version 3
([exclusions](exclude-tools.md#versions-and-older-hosts)). 5.0.0 is the first release that reads both. Move everything to it
before any trigger uses either. Until then leave both out of the file: `"packages": false` and `run.excludeTools` need neither version.
**Once either is used, no 4.3.1 writer may touch the file**: no `/dispatch` or panel of that release, and no worker of it that can disarm a one-shot.

| Program | On a release from before 5.0.0, 4.3.1 among them | So |
|---|---|---|
| Worker | Reads the file, drops both keys and runs the job wider than the file says, on a clean record | Every worker. Doctor's `fleet.versions` names each version the workers report, and `fleet.store-versions` names one that publishes no version once a 5.0.0 host's file needs version 2 |
| Receiver | Drops both keys from the jobs it queues. A worker that reads them refuses such a job (`trigger-skew`) where it can read the file, and runs it without them where it cannot | Every receiver. Check them on the console's Connections page: doctor cannot see them |
| Panel, console, `/dispatch` | `/dispatch` and its panel write `triggers` alone, so both keys stay and the stamp goes (below). No release this old has a console | Every one that writes this file |

**A file that lost its stamp.** A 4.3.1 `/dispatch` or panel writes `triggers` alone, and so does a 4.3.1 worker's one-shot disarm, and a hand edit can leave
the same shape: either key, with no `"version": 2`. 5.0.0 refuses that file (`run.excludeExtensions needs triggers file version 2`, or the other key's name): a receiver, and a worker with `PI_TRIGGERS_FILE` set, do not start
on it, and a running one keeps what it had. A write from the 5.0.0 console or `/dispatch` puts the stamp back. A 4.3.1 host loads it and drops both keys, and the job runs wider than the file says, on a clean record.

The console's trigger page refuses the change while a live worker reads less or publishes no version, and names it, and while it cannot read which workers are live. It reads live
workers alone: a receiver has no row in the worker registry and a stopped worker's row expires, so neither stops a change, whatever it reads. A hand edit is
not stopped: doctor warns once a host's own file needs the version.

**The job image.** A job with either key on an image whose `dev.pi-dispatch.capabilities` label does not list
`loadExclusions` is refused before it spends (`job-image-load-exclusions-unsupported`). A fleet from 4.3.1 has no role map ([model roles](model-roles.md)). Once a scope has one, an image from before 5.0.0 refuses
its jobs (`job-image-model-roles-unsupported`), and an image built with role maps but without this capability refuses a job there with `run.excludeTools`, even if its trigger never starts a child and no file uses either key: the map is the scope's, and that image would
start a child with every tool the trigger removes. Point `PI_JOB_IMAGE`, or the trigger's `run.image`, at an image from 5.0.0 or later. Pull the published image on each host. Nothing rebuilds an image you built, by `FROM` or from a copy of
`image/Dockerfile`: whoever maintains it rebuilds it from 5.0.0 or later and puts it on each host that runs it ([job-image.md](job-image.md)). A job with neither key, in a scope with no role map, runs on an older image as it did.

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

## CPU-reserve helpers left by 5.4.2 and earlier

On Docker's `cgroupfs` driver (Docker Desktop, OrbStack), the worker keeps the
[CPU reserve](multi-host.md#the-cpu-reserve-across-all-jobs) through short helper containers. Up to 5.4.2 they had no
name, and when the daemon was too slow to start one within 15 seconds the worker gave up on it and the container
stayed in `created` for good, so a slow daemon collected them (issue #978). 5.4.3 names every helper
(`pi-dispatch-cpu-reserve-<8 hex digits>`, labelled `pi.dispatch.helper=cpu-reserve`; doctor's has `-doctor-` before
the digits and its own process id after them, so no two doctors share one), so at most one is ever left per name, and
it is removed before the next try, and the worker waits longer between tries while the daemon stays slow. A doctor the
worker kills at its two-minute limit leaves at most its one helper, under its process id, and the worker removes it
right away. One left some other way (a doctor you stopped, or one stopped with the worker) is removed by the next
doctor once that process is gone, where the daemon runs on this host; on a daemon on another machine the worker's pass
below removes it, at the latest after the worker's next start. The digits come from `PI_WORKER_NAME`, so two workers
on one daemon (which is [not supported](multi-host.md#7-one-worker-per-docker-daemon-still-holds)) must declare
distinct names; otherwise they share one helper name, and each can remove the other's helper while it runs.

Its worker also removes the older helpers itself, after it reads the quota back as set, and again after each later
read (every ten minutes) until a pass has read every leftover it listed and left none it could still remove: a pass a
slow daemon cut short or that could not read a leftover's image, a leftover younger than ten minutes and one the `rm`
refused all wait for a later read. Containers that do not match the old helper stay, and a pass that kept only those
ends the passes too. It takes only containers that never started, are at least ten minutes old and match the old
helper exactly (its command, its one mount of `pidispatch.slice`, its flags, and no label beyond its image's), with a
plain `docker rm`, which never removes a running container. The same pass removes the last helper a worker left under
its old name after you changed its `PI_WORKER_NAME`, and a killed doctor's (the same match, plus exactly the helper
label), never the running worker's own. It logs `cpu_reserve_leftovers_removed` with what that pass listed, removed,
could not remove, left for being too young and kept for not matching: for every pass that removed something, and once
each for a pass that was cut short, could not remove one, or kept some.

On a host that stays on 5.4.2 or earlier for now, list them:

```sh
docker ps -a --filter status=created --no-trunc --format '{{.ID}} {{.CreatedAt}} {{.Command}}' | grep '/p/cpu.max'
```

Then remove the ones older than a few minutes whose command is `cat /p/cpu.max` or
`sh -c 'echo "<number> 100000" > /p/cpu.max'` with `docker rm <ID> ...`. They never ran, so removing them changes
nothing.

## 5.4.0: private endpoints

Issue #918 adds private endpoints: a host and one TCP port on your network that only the jobs of the triggers naming
it may reach through the egress proxy. The proxy gains two read-only folder mounts, `egress-private/` (the rendered
rules and the grant helper they run) and this runtime's `egress-grants/` folder, and its rules gain one `include`.
Follow [the normal order](#the-order), then in each deployment folder:

1. `pi-dispatch init` adds `private-endpoints.json`, `egress-private/` and `egress-grants/` (it never overwrites).
2. `pi-dispatch up` offers the rules refresh and the proxy's replacement as one step, asked once, as it did for the
   model endpoints' include. Replacing the proxy cuts off running jobs, so pause first. On the rootless Podman venue,
   `pi-dispatch service install --force` refreshes the account's rules and the unit together. With compose, use the
   new compose file, then `docker compose ... --profile egress up -d` recreates the proxy.

Until then, the proxy keeps the rules it has and nothing changes for any job; `pi-dispatch egress render` refuses to
write a private endpoint the running proxy cannot carry, and doctor names the step. A job whose trigger names a
private endpoint is refused before it spends (`private-endpoint-proxy-outdated`) until the proxy is replaced.

Before a trigger names one (`run.privateEndpoints`), upgrade every worker, receiver and console to 5.4.0: the field
needs `triggers.json` version 7 and its jobs carry data version 8, which an older service refuses or holds. An older
receiver that read the file at an older version would drop the field, and the worker refuses such a job
(`trigger-skew`) rather than run it without the device.

One more refusal: a name starting `PI_DISPATCH_ENDPOINT_` is now reserved for the worker. A `run.secrets` key with
that prefix refuses the triggers file, a project bundle variable with it refuses its jobs (`secret-name-reserved`),
and `PI_FORWARD_ENV` naming one refuses the boot. Rename any such variable before you upgrade. `up` puts the package's grant
helper back whenever this folder's copy differs, keeping the old one beside it. No existing file is rewritten, and
nothing older is detected: these are new stores.

One new boot refusal: the worker no longer starts while `egress-private/` or a folder in `egress-grants/` lies inside a
cron trigger's `run.folder`, a `PI_DISPATCH_RUN_ROOTS` root, a `run.skillsDir` or `PI_GLOBAL_PI_DIR` (a deployment
folder inside one of them, say), or is a symlink, because a job there could grant itself a private endpoint. Run
`pi-dispatch doctor` before you restart the worker: it names the folder and the path. See
[Private endpoints](egress.md#private-endpoints).

## 5.3.3: trigger merge permission

Issue #908 adds opt-in `run.mayMerge` to reviewed forge-flow triggers. Before adding it, follow
[the normal order](#the-order): image first, every worker, receivers, then every console and `/dispatch`.
The image must declare `mergePolicy`; rebuild derived images too. An enabled job on an older image refuses
before spending, because that image would retain an unconditional prohibition in its system prompt.

The trigger field needs file version 4. Enabled queued jobs carry `mayMerge: true` and a `mayMergePolicy` digest
at job data version 5. Older services refuse the newer file or defer the newer job, rather than silently dropping
the permission. A receiver retaining an older configuration cannot grant permission to a job; the upgraded worker
never promotes an unflagged job from the current file. Finish the upgrade before changing triggers, and rerun a
job refused because its trigger changed. See [the setting and its prerequisites](triggers.md#allowing-a-job-to-land-its-change).

No existing state is rewritten. Files and jobs without the new fields remain valid current shapes, so they are
not `state.older` findings. The per-container `merge-policy.json` selector is an ordinary temporary job input,
covered by the existing job-directory lifecycle, not a new persistent store. The run record gains the refusal
reasons `merge-policy-invalid`, `merge-policy-unavailable`, `merge-policy-changed` and
`job-image-merge-policy-unsupported`; its field shape is unchanged.

Before rolling back, pause and let active enabled jobs finish or cancel them, remove the setting from triggers
using a current writer, and finish or cancel queued, parked and recovering jobs carrying data version 5. Do not
lower a version by hand. A rollback does not undo completed merges or requests already accepted by the forge;
cancel pending automatic landing at the forge when that is intended. Existing unflagged jobs do not need a
migration, and the older behavior remains their default.

## 5.3.2: refused and cancelled jobs

Issue #899 changes the lifetime of a forge job's semantic duplicate window. A terminal policy refusal or an active
cancellation releases its owned window after the worker finishes processing and cleanup. A new event for the same
target and flow can then start a job inside the usual ten minutes. The original retained delivery still resolves to
its original job. A queued or held cancellation already removes its owned window with the job.

Follow [the normal order](#the-order): upgrade every worker, then the receiver/poller, using the release's matching
packages. New workers release windows as jobs end, including jobs an older receiver queued. New receiver/poller
processes repair a completed policy job's window on the next event, including one left by an older worker or a
failed completion cleanup. An old receiver with an old worker can still suppress that event until the window ends;
a mixed fleet therefore needs both upgrades. A cancellation still in progress, a live or deferred job, an ordinary
successful run, and recovery handoffs retain their existing window behavior.

No queued-job, run-record or key-format migration is needed, and no new persistent state is added. The duplicate
window remains ten minutes and delivery retention stays unchanged. Rolling back restores the old window-release
behavior; already released keys are not recreated. Fix the original refusal, wait for cancellation to finish when
applicable, then send a new event ([triggers](triggers.md#when-another-event-starts-a-job)).

## 5.3.1: subscription renewal

Issue #895 removes the recurring authentication wait and premature credential stops for subscription jobs. Move
the job image before the worker, following [the normal order](#the-order), and rebuild derived images. The image
must declare `subscriptionLease` beside `idleWatch` and `credentialRefresh`; the new worker deliberately retains
the earlier full-deadline coverage on an older image. The short-lease path is available on `local` and `podman`.

Regular jobs now default to idle-only time limits: `PI_JOB_STALL_MINUTES` defaults to 0 instead of 240, and there is
still no default `maxMinutes`. A busy tool can keep running without an AI step for as long as needed. Explicit stall
and maximum-time settings remain effective, and Watch jobs keep their 30-minute ceiling. To retain the former stall
behavior, set `PI_JOB_STALL_MINUTES=240`. Credential failures, spend limits and legacy-image fallbacks still apply.

No credential-store, queued-job or defer-record migration is needed. The same host-owned refresh grant stays in its
private store. `pi-dispatch status` gains additive `waitingDetails`, and a remaining authentication hold is logged
as `subscription_auth_hold`. See [subscription renewal](subscription-auth.md#admission-and-renewal),
[job limits](job-limits.md#credentials-that-expire-while-a-job-runs) and [status output](service.md#status-output).

## What each release changed in stored state

Release numbers come from the git tags.

### Unreleased: a job whose `docker run` never returns ends at its limit (#1104)

A worker from this release kills its own `docker run` 10 seconds after a limit's stop on a runtime that does not answer,
bounds that stop at 10 seconds, records a container that never wrote a line as `container-never-started` (refunded,
and retried only when the job has attempts left) under the conditions
[job limits](job-limits.md#when-the-runtime-does-not-answer) names, and removes the leftover container through its
runtime once the runtime answers, before anything else runs on that container's name or folder. The worker alone: the
job image, the receiver and the console are unchanged.

| Stored state | What changes and how to move it |
|---|---|
| Run record `reason` `container-never-started` | Same word, same meaning, one more case: a time limit's stop of a container that never wrote a line, on a runtime that did not answer. Such a record names no `mainCredential`, as for every container that never started. `v` stays 1, and every reader reads it as before. |
| Host budget (process memory) | An orphan may carry `killedClient`, which makes the sweep remove its container whatever its state. The ledger is not stored: a restart starts it again from the boot listing, as before. |
| Mixed versions | Nothing to order. An older worker keeps waiting on such a `docker run` as before; only workers from this release end it. |

### 5.4.3

#### A pi child on a subscription holds an admission of its own (#1098)

A job image from this release lets a separate pi process that the job starts, a staged package's own child among them,
use the job's subscription through an admission of its own, which the child meter the image loads first in every pi
child runs, as the job's runner does. Before, such a child's first call was refused and the job stopped as
`model-not-allowed`.

| Stored state | What changes and how to move it |
|---|---|
| Image capability `subscriptionChildren` | New, not a gate: an image without it refuses such a child's subscription calls before they are sent, as before, so no worker refuses anything for it. |
| Run record `tokens.costNotional` | Same key, same meaning, wider: it now also holds the list price of a child's calls on the job's notional subscription providers, so the dollar windows settle only the billed rest, as for the runner's own calls: only the calls the child's own admission let through, which its ledger marks. Nothing moves, and no older-state detector applies. |
| Child ledgers (in the job, never kept) | Version 4: each row may mark the part of its cost the child's admission let through. A runner and its children are always one image, so no job holds two versions. |
| Mixed versions | Any worker reads the image's `costNotional` as it reads it today. An older image refuses the child's calls, as before. |

See [subscription authentication](subscription-auth.md#supported-jobs-and-visibility).

#### A subagent on a subscription (#946)

A job image from this release runs a subscription job's role child inside the runner, on the subscription it admitted,
with pi's built-in tools and the job's skills but no extension tools. Before, the child was a separate pi process, which
the subscription refused, and the job stopped at its first child call.

| Stored state | What changes and how to move it |
|---|---|
| Image capability `subscriptionRoles` | New: the runner runs a subscription job's role child inside itself. A worker from this release refuses a subscription job with a role map on an image without it, before it spends (`job-image-subscription-roles-unsupported`). |
| Run record `modelRoles.refusals[].reason`, reason `job-image-subscription-roles-unsupported` | New, additive: `subscription-child-unsupported`, a role child on the subscription that the runner could not run inside itself, refused before it started; and the image refusal. `v` stays 1. An older reader shows the new run reason as its token, and keeps none of a run's role refusals when one of them is the new one. No migration or older-state detector is needed. |
| Mixed versions | See the two rows on a subscription job with a role map in [mixed versions](#mixed-versions-what-is-safe): ship the image and the workers together. |

See [model roles on a subscription](model-roles.md#on-a-subscription).

#### pi 1.6.1 and its decision models (#1094)

| Stored state | What changes and how to move it |
|---|---|
| Job image and workers | Both run pi 1.6.1. Upgrade the image first, then every worker, as [the order](#the-order) says: an image older than this release records no provider response id for a watch decision, and a worker older than it ignores one an upgraded image wrote. |
| Valkey watch traces (`watch:trace:<finding>`) | A watch decision's trace entry may carry two new optional fields: `responseId` (the provider's id for the classify call, operator only) and `billed` (the provider billed the cost). An older worker drops both when it imports a trace, and an older console does not show them. The durable finding record is unchanged, so nothing needs moving. |
| Triggers file | Unchanged in shape. A watch `decide` or the Zero touch grouping model on a Radius decision model, or on an overlay classifier whose protocol the cost bound does not price, is now refused before a container starts (it was refused inside one). `openai/gpt-6-luna` as a `decide` or grouping model now loads, where it was refused. |
| Forks | A fork asking for thinking `off` on a Claude 5.5 model served through Amazon Bedrock, GitHub Copilot, Cloudflare AI Gateway or Vercel AI Gateway is refused as `thinking-level-unsupported`, since pi 1.6.1 would run it at the lowest level instead ([chat.md](chat.md)). |

See [watch decisions](watch-decisions.md#which-decision-models).

#### Another host's artifacts on any console (#942)

A console now shows and serves the files a forge job kept on another host, by asking that host over the deployment's
Valkey (the artifacts channel), so the link in the job's comment works on whichever console it names. The files stay
in `PI_ARTIFACTS_DIR` on the host that ran the job, under that host's retention.

| Stored state | What changes and how to move it |
|---|---|
| `PI_ARTIFACTS_DIR`, run records, job data | Unchanged. Each worker reads its store as before, and answers for it on the channel. |
| Valkey | No key. Two pub/sub channel names, `artifacts:request:<host>` and `artifacts:reply:<id>`, carry the requests and the replies and keep nothing ([backup.md](backup.md)). |
| Mixed versions | A host shows its files on another host's console only once it runs this release: an older worker does not answer, and the card says the host did not answer in time or runs an earlier version. The console imports the channel from `@edgehero/pi-dispatch`, so install the console's and the worker's packages of the same release together, as [step 4](#before-you-start) says. |

See [a run's artifacts](console.md#a-runs-artifacts).

#### Weights in a random model pool (#996)

| Stored state | What changes and how to move it |
|---|---|
| Triggers file `run.modelSelection.weights` | New optional key inside a random pool: an exact candidate to a whole number from 1 to 100. A file that uses it is stamped version 12 by the writers; a file without it keeps its bytes and version. |
| Queued job data `modelSelection.weights` | New, at version 13, only on a job whose pool sets weights; every other job keeps its bytes and stamp. An older worker holds such a job (`newer-release`). |
| Valkey `dispatch:model-selection:v1:<digest>`, run records | Unchanged. The stored choice and the run record's pool carry no weights, so a weight-only edit refuses no queued job, and nothing needs moving. |
| Mixed versions | See the row on a random pool with `weights` in [mixed versions](#mixed-versions-what-is-safe). |

See [weighting the pool](triggers.md#weighting-the-pool).

#### Which key a run spent (#998)

| Stored state | What changes and how to move it |
|---|---|
| Run record `mainCredential` | New, additive: where the run's main model got its credential, `{ source, variable? }` (`host-env`, `pi-login`, `subscription`, `run-secret` with the declared variable's name, or `keyless`; never a value), a conditional key before `v`. `v` stays 1 and an older record without it shows no Credential row. An older console leaves it off its run page and `/api/run`, but its `dispatch_runs` passes the field to an agent whole, the declared variable's name included (a name, never a value), until the console is upgraded with the worker. No migration or older-state detector is needed. |

See [which key a run spent](console.md#which-key-a-run-spent).

#### Declared keys for the answer and grouping models (#1013)

| Stored state | What changes and how to move it |
|---|---|
| Triggers file `answerRules[].secrets`, `answerRules[].secretsProfile`, `zeroTouch.secrets`, `zeroTouch.secretsProfile` | New optional fields, the provider API keys an answer rule's models or the grouping job's models take, by reference. A file that uses one is stamped version 12 by the writers; a file without them keeps its bytes and version. A console save of a group name keeps the block's fields and its stamp. |
| Queued answer-draft and grouping jobs | Unchanged and unversioned: each is built from its rule or the block when it starts, and carries the declared names from there. One queued before a rule or the block gains or changes either field ends as `config-changed` (`question-group-config-changed`), buying nothing. |
| Mixed versions | See the row on answer rules and the `zeroTouch` block in [mixed versions](#mixed-versions-what-is-safe). |

See [a key of the rule's own](answer-rules.md#a-key-of-the-rules-own) and [secrets](secrets.md).

#### Quota reserve (#1008)

| Stored state | What changes and how to move it |
|---|---|
| Valkey `defer:job:<id>` | A new reason, `subscription-reserve`, for a job the quota reserve holds. The record expires with its wait, so nothing needs moving. A console from before this release lists such a job under "A reason this console does not know". |
| Valkey `dispatch:subscription-status:<host>` | A Claude connection the host owns carries `reservePercent` when the host sets `PI_QUOTA_RESERVE_PERCENT`. It expires within 90 seconds and is published again, so nothing needs moving; an older console ignores it. |
| `triggers.json` | `run.quotaReserve` is new and needs no `version`: every older loader drops it and loads the file. A watch rule refuses it. |

See [the quota reserve](subscription-auth.md#quota-reserve).

#### A local command trigger that keeps no sandbox (#1023)

| Stored state | What changes and how to move it |
|---|---|
| `triggers.json` | `run.retainSandbox` is new, needs no `version` and does not raise the file's. Only a local command trigger takes it; a watch rule and every other kind refuse it when the file loads. A worker or a receiver from before this release reads a file that has it on a local command trigger exactly when it reads that file without it, and drops the key (measured on 5.4.2). A file whose `version` is above what that release reads is refused by it whole, with or without the key: 5.4.2 reads up to 10. The receiver never needs it. An older worker keeps the sandbox, as it always did, so upgrade the worker on the host that runs the command for the flag to take effect. Nothing stored needs moving: a run that kept no sandbox simply has no directory under `PI_SANDBOX_DIR`. |

See [keeping no sandbox](triggers.md#keeping-no-sandbox-for-a-local-command).

#### Poller heartbeat (#970)

| Stored state | What changes and how to move it |
|---|---|
| Valkey `poller:live`, `poller:h:<name>` | New, a display: a running `pi-dispatch-receiver poll` publishes its heartbeat, which `pi-dispatch status` and Connections read. It expires on its own (five minutes past a beat in a cycle, the wait plus five minutes past the beat before a wait) and a stopped poller deletes it, so nothing needs moving, backing up or cleaning, and no older-state detector applies. Deleting it changes no polling. |
| Mixed versions | A poller older than this release publishes none, so a newer `status` says no poller has published and Connections says "no poller reported" while it runs: upgrade the receiver package where the poller runs. An older `status` or console reads none of it, and an older reader of the receiver records never sees it, since it has keys of its own. |

See [is it running](polling.md#is-it-running).

#### The cost cap counts billed calls only (#1008)

| Stored state | What changes and how to move it |
|---|---|
| Container `PI_SUBSCRIPTION_AUTH` | An entry gains `notional: true` for a connection with no paid extra usage, absent otherwise. A renewal keeps it, and an older image ignores it (it accepts extra keys). Not stored on the host, so nothing moves. |
| Run record `tokens.costNotional`, `notionalProviders` | New, additive: the notional part of `tokens.cost` (only for a job with subscription entries) and the providers whose calls were notional (a conditional key before `v`). `v` stays 1, an older reader ignores both, and an older record without them reads as all billed. No migration or older-state detector is needed. |
| Dollar window counters | Same keys and TTLs. From this release a worker charges a job's billed cost only, and reserves nothing for a job whose every model is on a subscription without paid extra usage, which also leaves its `model:<provider>/<model>` rows. Counters written before keep what they held. |
| Mixed versions | See the three rows on subscription jobs in [mixed versions](#mixed-versions-what-is-safe): the image and the workers each need this release before a subscription call stops counting. |
| Triggers file `run.maxSubscriptionUsd` | New optional field, the list-price allowance for a job's subscription calls. A file that uses it is stamped version 11 by the writers; a file without it keeps its bytes and version. |
| Jobs with an allowance | Told once, at 70% of the allowance by the settled list price of their subscription calls, to report and push, as for the cap. Nothing to set. |
| Queued job data `maxSubscriptionUsd` | New, at version 12, only on a job whose trigger set an allowance; every other job keeps its bytes and stamp. An older worker holds such a job (`newer-release`). |
| Container `PI_SUBSCRIPTION_ALLOWANCE_MICROS`, image capability `subscriptionAllowance` | Written only for a job with an allowance, only to an image that declares the capability; a job with one on an older image is refused before it spends. |
| Run record `tokens.allowanceMicros`, reasons `subscription-allowance` and `job-image-subscription-allowance-unsupported` | New, additive: the allowance a job ran under (only with one), a runner policy stop with its own comment, and the image refusal. An older reader shows an unknown reason as its token. |

See [what the cap counts](costs.md#what-the-cap-counts) and [a subscription allowance](triggers.md#a-subscription-allowance-per-job).

#### Waiting under the cost cap (#985)

| Stored state | What changes and how to move it |
|---|---|
| Run records | A `cost-cap` record's `why` can be `final-payload` or `turn` (a call that cannot wait refused while another process's call waited), each from the worker's closed list. A capped run's `tokens` gain `costChargedMicros`, `costLiftedMicros`, `costWaited` and `costWarned`, and a `cost-cap` record with a `why` gains `costRefusal`, the refusal's four numbers. Nothing moves: older records keep their values and show none of these rows on the run page. |
| Jobs | A job with a cost cap above 0 is told once, at 70% of the cap by what it has spent, to report and, if its flow pushes, to push ([job limits](job-limits.md#warnings-before-the-limits)). Nothing to set. |
| Mixed versions | A worker older than this release drops a `why` it does not know, so a newer job image's `turn` or `final-payload` stop is recorded as `cost-cap` with no `why`; the stop itself is the same. It also drops the four new `tokens` keys and `costRefusal`. An older job image writes none of them and sends no warning. The job image and the worker ship in one window ([the order](#the-order)). |

See [reasons.md](reasons.md#cost-cap) and [what the cap charges](costs.md#what-the-cap-charges).

#### Ended receipts for label jobs (#971)

Workers now post a fixed receipt, marked `pi-dispatch-ended:v1`, on a polled GitHub label job that was refused, stopped
or failed for good, after the comment that says why. It names the job, how it ended and the reason. Run records, job
data, queue keys and the completion receipt are unchanged; no migration, backup path or older-state detector is
needed. Older workers post none, so upgrade every worker. Jobs that ended before the upgrade get no receipt and are not
backfilled. See [ended receipts](github.md#ended-receipts).

#### Refusals before start say why (#969)

Workers now post a comment for every forge job refused before anything was spent whose refusal had no comment of its
own: the reason's explanation from [reasons.md](reasons.md), word for word. Before this, a refusal at the model
selection (`auth-mixed-billing`, `model-selection-policy-changed` and others), `settings-overlay-invalid`, the
subscription admission and the prepare stage (`sha-gone`, the `.pi/` caps, the `skills-dir-*` refusals) posted nothing,
and a label job's requester waited for a job that would never come. Run records, job data, queue keys and the trigger
label are unchanged; no migration, backup path or older-state detector is needed. An older worker keeps refusing these
in silence, so upgrade every worker for the comments to appear. See [when another event starts a job](triggers.md#when-another-event-starts-a-job).

#### The Zero touch page settles nothing by itself (#1076)

Opening the console's Zero touch page, or the touched runs list, no longer writes to Valkey. Before, each view settled
the accounting an earlier write had left unfinished (an action whose touch was not recorded, a fix whose completion
was lost). Now the page says how many wait, and an operator settles them with **Preview settling** and **Confirm**. The
worker's daily sweep still records unfinished touches on a host that shares the logs folder. Run records, job data,
queue keys and the accounting keys are unchanged; no migration, backup path or older-state detector is needed. An older
console keeps settling on a view. After upgrading, open the Zero touch page once as an operator and settle anything it
says is waiting. See [Zero touch](zero-touch.md).

#### The Zero touch fix history keeps its retention (#1072)

| Stored state | What changes and how to move it |
|---|---|
| Valkey `zero-touch:fixes:meta:<id>` | A settle, a refusal and an Undo now keep the expiry the record was given when its change was staged, where each gave it a new retention. Records written before keep the expiry they have. Nothing moves, and no older-state detector applies. |
| Valkey `zero-touch:fixes:index` | Each new fix now also removes the entries older than the retention. The page no longer reads an entry past the retention, so a fix whose record expired is no longer counted as missing and the page stops saying "Fix history is incomplete" for it. Nothing moves: the entries already there are trimmed with the next fix. |
| Mixed versions | An older console reads the whole index, so it says the history is incomplete whenever a fix's record has expired and no newer console has recorded a fix since. A settle or an Undo on an older console still gives the record a new retention; a newer console leaves such a fix out once its change is older than the retention. Upgrade every console. |

See [Zero touch](zero-touch.md).

#### The Zero touch fix history records how a change ended (#1072)

| Stored state | What changes and how to move it |
|---|---|
| `<PI_LOGS_DIR>/zero-touch-outcomes/<fix id>.json` | New folder, written by the console: one small file per fix whose change ended while its accounting in Valkey was not yet written, holding only the outcome (`applied` or `refused`) and its time. The console removes it once Valkey answers, a settle removes it once it settles the fix, and the worker's sweep removes one older than the history's retention. Nothing to move or create; back it up with the rest of the logs folder ([backup](backup.md)). No older-state detector applies. |
| Fixes staged before the upgrade | They have no such file, so a settle judges them by their file's bytes, as before. |
| Mixed versions | An older console neither writes nor reads the folder, so a fix it settles is judged by its bytes. An older worker does not sweep the folder; the console and a settle still remove what they wrote. |

See [Zero touch](zero-touch.md#fix-a-recurring-cause).

#### Warnings before the turn and time limits (#1055)

A job is now told once, at 70% of its turn limit (`run.maxTurns`) and at 70% of its time limit (`run.maxMinutes`,
`PI_JOB_MAX_MINUTES`), to write its report and, if its flow pushes, to commit and push, as it already was at 70% of its
cost cap ([job limits](job-limits.md#warnings-before-the-limits)).

| Stored state | What changes and how to move it |
|---|---|
| Run records | A run's `tokens` gain `turnsWarned` (on every run that watched its turn limit) and `timeWarned` (on a run with a time limit), each 1 when the warning was queued, else 0, after `costWarned`. `v` stays 1. Nothing moves: older records have neither and show no row for them on the run page. |
| Jobs | Every job now gets the turn warning when it reaches 70% of its turn limit: the default 30 warns at the end of turn 21. A job with a time limit gets the time warning at 70% of it. Nothing to set. |
| Configuration | The worker writes `PI_JOB_MAX_MS` and `PI_JOB_LEFT_MS` into a job with a time limit and refuses both names anywhere else: a trigger's `run.secrets`, a secret bundle's `endpoints` or what its resolver returns, an overlay `mcp.json` server, and `PI_FORWARD_ENV` ([before you start](#before-you-start), step 9). |
| Mixed versions | An older job image ignores both variables and sends neither warning, and writes neither key; the time limit still stops the job. An older worker sends no time limit, so a newer image sends the turn warning only, and drops both keys from the record. Upgrade the job image and the worker in one window ([the order](#the-order)). |

See [reasons.md](reasons.md#max-minutes) and [runner-policy](reasons.md#runner-policy) for the stops themselves.

#### A provider's refusal stop is not retried (#950)

A job image from this release exits 2 as `provider-stop-refusal` when the AI provider ends the reply with an explicit
refusal (Anthropic's `refusal` stop reason, read from pi-ai or from the Claude subscription adapter). Before, the run
exited 1 and the queue ran the whole paid job again. The worker gives the stop its own comment, a page through
`PI_ON_FAILURE` and a reason in the run record; a polled label job's ended receipt reads
`end=stopped reason=provider-stop-refusal`.

| Stored state | What changes and how to move it |
|---|---|
| Run records | A new reason, `provider-stop-refusal`, additive. `v` stays 1 and an older reader shows the token as it is. Nothing moves, and no older-state detector applies. |
| Mixed versions | A job image older than this release still exits 1 on a refusal, which the queue retries as before: upgrade the image for the stop to take effect. A worker older than this release reads the new exit line as `runner-policy`, which is not retried either, with that reason's comment. Upgrade both in one window ([the order](#the-order)). |

See [reasons.md](reasons.md#provider-stop-refusal).

#### The worker sweeps the held-jobs index (#1075)

Workers now remove the stale entries of the held-jobs index (`wait:held`, the jobs held on `run.waitFor`) on their
retention sweep, every `PI_SWEEP_INTERVAL_HOURS` (not at boot, and not at all at `0`). An entry is stale when its job's
hold record is gone or has no start time; before, only the `/dispatch` panel and `/dispatch status` removed one, so a
deployment run from the tools and the web console grew the index until `dispatch_waits` said its list was not
`complete`. The panel and `/dispatch status` now remove through the same one step as the sweep. The key, its members
and the hold records are unchanged; no migration, backup path or older-state detector is needed. The index is shared,
so one upgraded worker sweeps it for the whole fleet. An older panel or `/dispatch status` still prunes as before. See
[watching and cancelling](wait-for.md#watching-and-cancelling).

#### A receipt for every write in the audit log (#1072)

Every write that lands now appends a `write-applied` row to the console audit log after its `ok` row, on the same
ticket, for a person and the `/dispatch` panel as for an agent, whose writes had one already. The audit page reads a
write that has neither that receipt nor a `failed` row after it as **outcome unknown**: whatever made it stopped during
the write. It judges a write that way only from the first receipt of its own role on, so the rows written before this
release read as they did.

| Stored state | What changes and how to move it |
|---|---|
| `PI_LOGS_DIR/console-audit/` | One more row for each write a person or the panel makes: an existing action, `write-applied`, with no new field or outcome. The chain and its verification are unchanged; nothing moves, and no older-state detector applies. |
| Mixed versions | An older console's audit page shows a person's receipt as one more `ok` row, and its Agent writes today still counts agents' receipts alone. A pi session that still runs an older admin extension writes the panel's writes without a receipt: once a panel receipt has been written, its writes read **outcome unknown** on the audit page. Reload pi on every host that shares the logs folder after upgrading. |

See [the audit log](console.md#the-audit-log).

### 5.4.2

#### Completed label-job receipts (#920)

Workers now post a fixed scheduling-only receipt after BullMQ confirms an original GitHub polling label job
completed with exit 0, even with no artifacts. Upgrade the worker to 5.4.2 to produce these comments. Existing comments,
run records, job data and queue keys are unchanged; no migration, backup path or older-state detector is needed.
Older jobs without a receipt remain unknown and are not automatically backfilled. Consumers must continue to
require independent task verification and existing authority. See [GitHub completion receipts](github.md#completion-receipts-for-polled-label-jobs).

#### Append-file source hashes (#954)

| Stored state | What changes and how to move it |
|---|---|
| Run record `loaded.promptAdditions` | Optional `{overlay, repository}` source hashes, each lowercase SHA-256 or null, on full and compact reports. Minimal and older reports may omit it; omission means unknown. No record version, migration or older-state detector is needed because absence remains valid. Upgrade the image, worker and console to produce, validate and show it. Existing records remain readable. |
| Overlay and doctor | No new store, setting, key or backup path. Loader reloads retain their initial append text; restart the session to pick up a later staged edit. Doctor's append-file check uses its existing record and publication rules. Hashes identify loaded source text, not the complete provider prompt. |

See [the global overlay](global-pi-overlay.md#what-a-run-loaded-and-where-to-read-it) and
[the Loaded card](console.md#what-a-run-loaded).

#### Local close-actor grants (#951)

| Stored state | What changes and how to move it |
|---|---|
| Trigger `on.closeActors`, trigger version 10 | Optional exact actor grant for GitHub local close commands. Upgrade every worker, receiver and console to 5.4.2 before adding it. Older readers hold version 10 instead of silently dropping the grant. Configurations without it retain their existing minimum version. Changing or removing it invalidates pending local-event work through the existing complete-definition digest. |
| Local-event state and queued jobs | No shape, key, TTL, receipt or job-data version changes. No migration or older-state detector is needed: a listener without a grant remains a supported permission-based policy, not obsolete state. Before rollback, remove the grant with an upgraded writer and settle its pending work; restore a backup only if losing later edits is intended. |

See [local event commands](triggers.md#a-forge-event-running-a-local-command). A grant admits the named actor
only to its configured local close command; ordinary forge close jobs keep their existing permission gate.

#### Explicit auxiliary model routes (#949)

| Stored state | What changes and how to move it |
|---|---|
| Trigger `run.auxiliaryModels`, trigger version 9 | Optional, hand-authored finite model grant requiring explicit `models` and positive `maxCostUsd`. Move all workers, receivers and consoles to 5.4.2 first, then author the grant. Older readers hold version 9 instead of silently dropping it. Files without the field retain their existing version. |
| Queue job `auxiliaryModels`, job-data version 11 | Every supported producer and rerun preserves the grant. An old worker holds the new version; a new worker refuses a producer that dropped an authored grant. Existing jobs without it keep their behavior. No migration or older-state detector is needed: absence is still a current supported policy, not an obsolete representation. |
| Container inputs and accounting | Existing `PI_ALLOWED_MODELS`, subscription snapshots and cost guards carry the selected root plus auxiliary routes. No new image wire contract, ledger, backup path or provider credential store is introduced. Images still need the ordinary model-policy, cost-cap and subscription-auth capabilities for the routes requested. |

#### Claude adapter 0.3.11 and Opus quota admission (#948)

Upgrade the worker and job image together to 5.4.2 before selecting `pi-anthropic-oauth@0.3.11`. Stage the exact
package, then update the connection’s adapter, active staged root and digest and authenticate it as described
in [subscription authentication](subscription-auth.md#claude-community-compatibility). Old workers and images
refuse the new adapter identifier. The existing 0.3.6 and secondary profiles retain their approved receipt
revisions; no credential-store or run-record shape changes, state rewrite or older-state detector is needed.

The reviewed modern Fable weekly limit no longer blocks exact `anthropic/claude-opus-5-5`; older workers
remain conservative until upgraded. Existing opaque quota IDs and fields stay unchanged. Refresh usage with
`pi-dispatch auth usage claude-main` to retain the provider's fractional-second reset timestamps, formerly
shown as unknown. No quota deletion, store migration or older-state detector is needed: missing resets and
unknown scopes remain valid states, while ordinary fresh observations replace the affected reset values.

### 5.4.1

#### File secrets (#919)

Upgrade the job image, every worker and receiver, the console and every `/dispatch` to 5.4.1 before adding
`run.secretFiles` or a bundle binding's `files` selection. Follow [the order](#the-order); derived images must
advertise `secretFiles` too. Environment-only triggers keep their existing behavior and minimum store versions.

The triggers file requires version **8** when a trigger carries `run.secretFiles` or any `secretBundles` binding
carries `files`; the writer stamps it from the content. Queued jobs carrying direct file references require
`dataVersion: 9`. Older readers refuse the newer file or defer the newer job, rather than interpreting its grant
without file delivery. A new worker catches a stale producer that dropped an authored `run.secretFiles` as
`trigger-skew`; rerun that delivery after upgrading the producer. File-only grants route through their explicit
profile or `default`, so profiles must be available on the selected hosts.

Run records gain optional `secretFiles`, containing only names resolved for file delivery. The field can remain
when a later gate refuses or startup fails; it does not prove the container started or read a file. Old records
remain readable and no run-history rewrite is needed. Upgrade all readers first: an older reader may omit or pass
through unknown metadata, while this release projects file names to counts for models. The names are not evidence that an old
run lacking the field received files. No older-state warning is added for this optional field: its absence and
lower minimum file/job versions are still valid output of this release, so neither identifies an older writer.

Keep `PI_JOBS_DIR` disjoint from every local job folder, skill source and global overlay, in both directions.
This release refuses an overlapping source even on jobs without a file grant, since it could expose another
attempt's credentials. Move the jobs directory or narrow the source; symlink and directory aliases count too.

Active jobs stage credentials in sibling `job-*.secret-files` roots under the jobs directory, with `secrets` and
host-only `owner.json` children. These are temporary secret material, excluded from backups, checkpoints and
retained workspaces. Stop running jobs and let the upgraded worker clean them before rollback. The new boot sweep
uses owner identity and successful venue reaping; it preserves live or unknown owners and reports them. An older
worker does not know this staging shape, so inspect and remove any leftover root only after its owning worker and
container have stopped. Removing a retained workspace alone does not remove a sibling staging root.

Before rollback, remove file grants from the triggers file and let a current writer recompute its version;
drain or cancel queued version-9 jobs, because an older worker will defer them. Do not lower a version while
leaving file fields in place. Restore an older triggers backup only if losing later edits is intended. See
[secrets](secrets.md#file-secrets-a-key-file-with-a-path-in-the-environment) and [backup](backup.md).

#### Queue consumer health and retention (#924)

Restart workers after upgrading. New workers add version-1 `consumers` observations to their expiring host
registry row; doctor, status and the console must also be upgraded to show them. Older workers remain readable
but report unknown consumer health. An exact 5.3.3 or 5.4.0 row without observations produces a `state.older` warning;
it retires when the upgraded worker publishes or the old row expires. A retained observation from another
process generation is ignored. Older readers ignore the new field. No queue, job or run-record migration is needed.

Session and fork-source sweeps may leave `.retired-<pid>-<epoch-ms>-<sequence>` directories while deletion is
in progress or after interruption. These names mean deletion was committed; they are not recoverable sessions
and should not be restored under live keys. New workers retry removal. A rollback leaves these reserved names
untouched, so they may need removal by their exact paths after the worker stops. Sandbox `.reap-*` behavior and
pin restoration remain compatible. See [consumer health](multi-host.md#queue-consumer-health) and [backup.md](backup.md).

#### Dropped requests answered on the forge (#932)

Queued job data gains `duplicateOf` and `windowEndsAt`, at version 10, on a new kind of queued job: a notice that the
ten-minute window dropped a request against a job that had already ended. The receiver and the poller add it; the
worker answers it with one comment and a run record whose reason is `duplicate-request`, and never runs it. A worker
older than 5.4.1 holds a notice as `newer-release` instead of reading it as a forge job, so move the workers
first ([the order](#the-order)): a receiver upgraded first leaves its notices waiting until they are. No existing job,
record or key changes shape, and nothing older is detected. The read of the window's owner also asks BullMQ's failed
set and the key's remaining time, both read from the pinned BullMQ 5.80.4; the pin is unchanged.

#### Forge job artifacts (#920)

`PI_ARTIFACTS_DIR` (default `~/.pi-dispatch/artifacts`) is a new store: one folder per run holding what a forge job
left in `/artifacts`, with a version 1 `manifest.json`, kept for `PI_ARTIFACTS_RETENTION_DAYS` (default 14). The run
record gains an optional `artifacts: { kept, bytes, dropped }`, numbers and reason tokens only, which an older reader
ignores; its `v` stays 1. No existing file, record or key changes, and nothing older is detected. The job image gains
`/opt/pi-dispatch/ARTIFACTS_PROTOCOL.md`; rebuild derived images so their agents are told about the folder (a job on
an older image still gets it). To keep the old behaviour, set `PI_ARTIFACTS_MAX_FILES=0`. See [artifacts](artifacts.md).

### 5.4.0

#### Random model selection (#922)

Random pools require `triggers.json` version 6 and queued job-data version 7 (`modelSelection` and producer-owned `modelSelectionGeneration`). Upgrade every worker, receiver and console to 5.4.0 before enabling them; older readers hold newer work. Existing fixed/fallback configurations retain their previous minimum version.

Back up the new `dispatch:model-selection:v1:*` state with its BullMQ jobs. Active choices have no expiry; terminal choices use the existing finished model-state retention, and Retry preserves them. Do not delete a choice to force another draw: create a fresh run after checking the original. Saved parked sessions gain a bounded version-1 `model-selection` sidecar coupled to their exact transcript. Preserve it with the session and approval stores. Missing or mismatched binding refuses a random continuation.

Random checkpoints add a separate `cp-N/model-selection.json` annotation bound to the unchanged manifest bytes. Preserve it with the snapshot; random recovery refuses if the annotation is missing, and holds a newer version. No older version of these new stores exists to detect or migrate. The optional `resetAt` field on defer records preserves known availability separately from polling; older records omit it and newer readers report an unknown reset. This additive display field needs no state cleanup. Optional run-record selection facts are additive; historical records without them remain valid and do not need cleanup. A rollback must restore the corresponding queue/config/session backup or remove random policies only after their jobs and continuations are settled. Legacy failover state, subscription observations and approval request formats are unchanged. See [random pools](triggers.md#choosing-randomly-from-a-reviewed-pool) and [backup.md](backup.md).

#### Private endpoints (#918)

`private-endpoints.json` (`PI_PRIVATE_ENDPOINTS_FILE`) is a new store, version 1, which an older release never reads.
`egress-private/` holds what `egress render` and `init` write from it and from the package; `egress-grants/` holds
one grant per running job, written and removed by the worker, and is not backed up. `triggers.json` gains optional
`run.privateEndpoints` at version 7, and a job carrying it is stamped job data version 8; an older service refuses
the file or holds the job, and no existing file or job is migrated. The run record gains
`privateEndpoints: { ids, basis }` on a granted job's record only, which an older reader ignores. The fleet's
endpoint leases gain keys for a private endpoint's `slots`, hashed from `private:<id>`, under the model endpoints'
key family. The steps are [above](#540-private-endpoints).

### 5.3.3

#### Event-driven local commands (#911)

Event-local commands add `triggers.json` version 5 and queued job data version 6. The new trigger fields are
`on.forge`, `on.id`, `on.debounceSeconds`, `on.reviewAuthors` and `run.worker`; local queued jobs carry `worker`
and event-local jobs carry `localEvent`. Existing configurations keep their previous minimum version. Upgrade
all workers, receivers and operator consoles to 5.3.3 before enabling these fields; old workers defer newer jobs.

Valkey gains `local:event:*`: durable current/next command intents and delivery receipts. Keep this state and
BullMQ together when backing up or restoring. Do not remove active intent state to force a retry: first establish
that its container is gone. An active intent whose queue job disappeared remains blocked and is reported as
`local_event_queue_job_missing`; inspect the named worker and its runtime before restoring a consistent backup.
There is no older form of this new state to migrate or detect. Existing run records remain readable and unchanged;
new event-local records add `localEvent: { id, forge, type, digest }`. Records without it are ordinary older runs,
not stale state requiring cleanup. Local command queue retention stays unchanged; receipts outlive it so a late
redelivery cannot recreate a finished command. See [event-local triggers](triggers.md) and [backup.md](backup.md).

#### Trigger merge permission (#908)

`triggers.json` gains optional `run.mayMerge` at version 4, and enabled queued jobs carry `mayMerge` and
`mayMergePolicy` at data version 5. Older services refuse or defer these versions. The input selector and new
refusal reasons are described [above](#533-trigger-merge-permission); no existing file or job is migrated.

### 5.3.0

| Store | What changed, and what an older release does with it | Guide |
|---|---|---|
| `.env` | `GITHUB_INGEST` says which transport carries GitHub (#879): `poll` makes `pi-dispatch-receiver serve` mount no GitHub route and need no `WEBHOOK_SECRET`, `webhook` makes `poll` refuse to start, and `pi-dispatch setup github --no-webhook` writes `poll` (a later run with a webhook turns it into `both`). A receiver older than this release ignores the line and decides as before, so under `poll` its `serve` still refuses to start without `WEBHOOK_SECRET` wherever your triggers name github or `GITHUB_AUTH_SOURCE` is set: move the receiver with the workers. An existing `.env` keeps what it says and boots as before; where only a `GITHUB_AUTH_SOURCE=gh` line makes `serve` serve GitHub, `pi-dispatch doctor` says so and that the line may go. A new scaffold carries that line commented out, so a new deployment's receiver serves GitHub only once a GitHub rule exists when it starts: its first GitHub trigger, added while it runs, takes webhooks after a restart, and the receiver logs `github_rules_unserved` until then | [polling.md](polling.md) |
| `console-login-codes/` | `pi-dispatch-console link` and `/dispatch console --link` make a sign-in code to type beside the link (#882), filed under a slow salted hash with the salt in `.short-code-salt`. A console of an older release has no field to type it in and refuses its shape, so restart the console after the upgrade before you use a code. The link beside it works with either | [console.md](console.md#sign-in-without-pasting-the-token) |
| `console-devices/` | A link or a code from the host remembers the browser it signs in, and at 32 remembered browsers for one token the one used least recently is ended as `removed` to make room (#882). The record shape is unchanged; an older console reads every record as before | [console.md](console.md#remembered-browsers) |
| `sandbox-gateways.json` | Where it enrolls a `consoleOrigin`, every command now prints that origin, links and codes included (#882); before, they printed the listen address, which the console refused at sign-in unless the two were the same. Without enrollment they print `http://pi-dispatch.localhost:<port>/`, so a browser remembered at `localhost` or `127.0.0.1` signs in once more there | [sandbox-gateway.md](sandbox-gateway.md) |
| `triggers.json` and queued jobs | Three `run` fields bound a trigger's jobs (#888): `idleTimeoutMinutes`, `stallTimeoutMinutes` and `maxMinutes`. A file that uses one is stamped version 3, and a job that carries one version 4, so a host of an older release refuses such a file and leaves such a job waiting rather than run it under its own fixed 30 minutes. Move every host before you add one. Jobs stop being killed at 30 minutes: a job runs until it is idle (15 minutes by default), stalled (4 hours without a step by the AI) or at a ceiling you set (`PI_JOB_MAX_MINUTES`). A job image built before this release keeps the 30-minute limit, and so does a derived image until it is rebuilt on the new base | [job-limits.md](job-limits.md) |
| run records | A record of a job that took a slot carries `limits` (#888): what bounded it, and why when that was the 30-minute fallback. Its reasons gain `idle`, `stalled` and `max-minutes`; the 30-minute limit that was `worker-abort` is `max-minutes` now. An older console shows the reason as an unknown token and ignores the field | [job-limits.md](job-limits.md#what-the-run-record-says) |

### 5.2.1

| Store | What changed, and what an older release does with it | Guide |
|---|---|---|
| `triggers.json`, secret bundles, the overlay `mcp.json` and `PI_FORWARD_ENV` | The worker now writes `PI_JOB_SIZE_CPUS` and `PI_JOB_SIZE_MEMORY_MIB` into every job (#865), so both names are reserved: a `run.secrets` key or a bundle's `endpoints` key with either name is refused when the file loads, and `PI_FORWARD_ENV` naming either stops the worker at boot. A project secret bundle whose resolver returns a variable of either name is refused when each job of that project is picked up (`secret-name-reserved`, before anything is spent; the worker log names the variable, and `pi-dispatch doctor --secrets`, which resolves the bundles, fails its bundle line), so every job of the project refuses until it is renamed in the secrets manager. An overlay `mcp.json` server that references either name is refused for the jobs that name it (`mcp-secret-reserved`). Rename such a variable before you upgrade. An older worker sets neither name and passes such a value through | [sizing.md](sizing.md#how-many-cpus-a-jobs-tools-see) |
| `doctor:loads:<name>` in Valkey | Each flow row carries `basis`, a short digest of the trigger fields doctor judged its answer from (#869), and the trigger page and a fresh sandbox answer from a row only where it matches the triggers file they read. The record stays `"v": 1`. An older console drops the field and reads every row as before. A row an older doctor wrote has none and is read as before too, and a host keeps writing such rows until it runs this release | [console.md](console.md#what-a-triggers-jobs-get) |

### 5.2.0

| Store | What changed, and what an older release does with it | Guide |
|---|---|---|
| `pause-windows.json` | A key written twice is refused (#846): the worker does not start on such a file, a live reload keeps the last good windows, and doctor fails on it. The console and the panel have refused to write one since 5.0.0, so only a hand edit makes one. An older worker reads such a file as `JSON.parse` does and keeps the last value | [pause-windows.md](pause-windows.md#the-files-version) |

### 5.1.0

| Store | What changed, and what an older release does with it | Guide |
|---|---|---|
| `console-devices/`, beside the console tokens file | New: one owner-only file for each remembered browser (#849). Nothing is written until someone chooses to remember a device. An older console ignores the folder, so a browser remembered on the new release signs in again after going back. | [console.md](console.md#remembered-browsers) |

### 5.0.0

| Store | What changed, and what an older release does with it | Guide |
|---|---|---|
| Settings file (`PI_SETTINGS_FILE`) | Every writer keeps a key it does not know. An optional top-level `version`, written only when a key needs it (none does yet). A `version` you added by hand is now read. A 4.x `/dispatch` drops every key it does not know when it writes, and a 4.x worker ignores `version` | [backup.md](backup.md#a-key-or-a-file-from-a-newer-release) |
| `pause-windows.json` | An optional `version`, as above. The writer keeps top-level keys it does not own. A 4.x writer drops them and `version`; a 4.x worker reads a newer file and drops what it does not know | [pause-windows.md](pause-windows.md#the-files-version) |
| `triggers.json` | An optional `version`, as above. A trigger with `run.excludeExtensions` or `run.excludeExtensionTools` makes the file version 2, which a writer stamps. A cron `on.id` longer than 176 characters is refused. A 4.x writer (the panel, and the worker's one-shot disarm) writes `triggers` alone, dropping `version` and every other top-level block, `secretBundles` among them; 5.0.0 refuses a file that holds either key after that. A 4.x worker or receiver reads a newer file and drops what it does not know, so it runs those triggers' jobs wider than the file says | [triggers.md](triggers.md#the-files-version), [what a fleet needs](#what-a-fleet-needs-before-a-trigger-leaves-something-out) |
| Queued jobs and the sandbox manifest | An optional version. A canary from the Updates page queues job data version 2 (issue #796), which a 4.x worker would run as the trigger's ordinary job, without the candidate package: every worker on 5.0.0 before anyone runs one. A job of a trigger with either key above is job data version 3. A worker defers a job or a file a newer release wrote as `newer-release`; a 4.x worker runs a job by the fields it knows | [console.md](console.md#updates), [sandbox.md](sandbox.md), [what a fleet needs](#what-a-fleet-needs-before-a-trigger-leaves-something-out) |
| Follow-up jobs (`/outbox`) | A follow-up job now inherits its parent's `"packages": false`, so a follow-up job of such a trigger loses the staged packages it used to load: their extensions, tools, skills and prompts. Its flow is its repository's, as every follow-up job's is, so it still starts. A 4.x worker builds the follow-up without the key, as it always did | [exclude-tools.md](exclude-tools.md) |
| The job image's capabilities | The `loadExclusions` capability. A job with `run.excludeTools` whose scope has a role map needs it too | [what a fleet needs](#what-a-fleet-needs-before-a-trigger-leaves-something-out) |
| Run records (`PI_LOGS_DIR`) | Written to a temporary file and renamed into place, with `"v": 1`. A record that reserved in the deployment's dollar windows says which ones (`dollars.reservedIn`: dates and a hash of the Valkey's address, never the address). Doctor's `dollars.window-reset` counts only such records, so it sees nothing of the runs before 5.0.0. Each queue job's record says when its job was queued (`jobCreatedAt`), and the Zero touch view counts a touch against a run only from then on; a record without it sets no such start. A 4.x reader ignores fields it does not know, and its sweep leaves a crash leftover `<job id>.json.<pid>.<12 hex>.tmp`, which is harmless | [backup.md](backup.md#stop-copy-start), [costs.md](costs.md#when-a-counter-resets) |
| The web console | New: `console-tokens.json`, `console-login-codes/` and `<PI_LOGS_DIR>/console-audit/`. A token of a role a console does not know is kept and signs in nowhere. An audit row with an action or outcome a console does not know reads as unknown, not as damage. `PI_CONSOLE_AUDIT_RETENTION_DAYS` keeps the audit for its own number of days. 4.x has no console and leaves these files alone | [console.md](console.md#managing-tokens), [console.md](console.md#the-audit-log) |
| Durable runs, steering, approvals, live transcripts, watch, zero-touch, Updates, the sandbox gateway, model failover | New Valkey keys and new files, listed in [backup.md](backup.md#what-the-valkey-volume-holds). A 4.x worker knows none of them, so a run held for an approval or waiting for its recovery is not continued | [durable-runs.md](durable-runs.md#across-versions) |
| Workspace checkpoints | The boot sweep keeps the job folder of a checkpoint pointer of any version. A recovery whose checkpoint a newer release wrote waits for an upgraded worker instead of being refused | [durable-runs.md](durable-runs.md#across-versions) |
| Run mirror (`runs:*`) | `PI_RUN_MIRROR_MAX_RUNS` (5000 by default, 1000 to 20000) caps it; the lowest setting in a fleet wins. A 4.x worker trims at 5000 | [multi-host.md](multi-host.md#what-the-panel-and-doctor-show-you) |
| Valkey image | Pinned to `valkey/valkey:8.1`. Doctor's `state.older` names each of these still on `valkey/valkey:8`: a compose file's `valkey` service, a Quadlet, and a container this deployment's `up` started and still runs. `up`'s summary names that container too | [Valkey and BullMQ](#valkey-and-bullmq) |
| Cron run ids | One reader for `repeat:<id>:<time>` and `manual:<id>:<time>` everywhere. A run record's cron id is read whatever its length, and the console and `/dispatch` name a schedule whose id is 177 to 200 characters long, which an earlier release made and showed with no id, so you can find and remove it. An id no release makes (a time with a leading 0, a `:` in the id) no longer counts as a cron run | [triggers.md](triggers.md#trigger-types-what-fires-each-one-and-what-it-runs) |
| Model ids | A model id defined in the overlay can be the deployment's default only in the shape a trigger's `run.model` takes (issue #673). Outside it `PI_MODEL` stops the worker at boot, and a settings file holding one refuses every job | [global-pi-overlay.md](global-pi-overlay.md#custom-providers) |
| The job image's pi | From 4.3.1's pi 1.2.0 to 1.5.0 (issues #693 and #796). 129 catalog models are gone and 192 are new, and a trigger whose `watch.decide` names a removed one refuses the triggers file. Each session key starts cold once, as after every pi change | [job-image.md](job-image.md#pi-150-upgrade-issue-796), [sessions.md](sessions.md#when-it-silently-doesnt-resume) |
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
   - a `version` above what the older release reads, in the settings file, `pause-windows.json` or `triggers.json`, makes
     a 5.0.0 or later worker refuse `triggers.json` or `pause-windows.json` at its start, and defer jobs after a live edit or on a newer settings file; a 4.x worker ignores it and drops what it does not know. A release writes one into
     `triggers.json` only for a trigger with `run.excludeExtensions` or `run.excludeExtensionTools`, and no release writes one
     into the other two yet. So take both keys off every trigger before you go back to 4.x, which runs those triggers' jobs with what the keys
     took away;
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

- [answer-rules.md](answer-rules.md#a-key-of-the-rules-own): every worker, receiver and console before a rule declares
  a key.
- [artifacts.md](artifacts.md#upgrading): the new store, the record's optional field, and the image's instruction file.
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
