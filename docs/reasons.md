# Run reasons

Every run ends with an outcome, and every run that did not simply complete also names a reason. The reason is a
fixed word, such as `scope-cap` or `oom-killed`. This page says what each one means and what to do about it.

The worker keeps one short explanation and one next step per reason in `worker/src/reason-catalog.mjs`, for the
console and the `/dispatch` panel to show beside a link to the entry here. Where the worker posts a fixed comment on
the issue for a reason, that comment is the explanation, word for word, so the issue and the explanation never
disagree.

## How to read a reason

The run record's `outcome` says how the run ended:

- `policy`: the worker refused the job, or stopped it on purpose. It is never retried, because a retry would meet the
  same answer. Most refusals happen before anything is spent; the entry says when that is not so.
- `failed`: something in the infrastructure went wrong. The queue retried it, and the record is the last attempt.
- `completed`: the run finished. Completed runs may carry `awaiting-input` or `awaiting-approval` while waiting for a person.

A record may also carry `why`, a second fixed word with more detail (for example `overlay-link` beside
`model-unknown`). Some records carry nested reasons as well: why a conversation did not continue, why a run was not
armed for recovery, or why a portfolio plan did not apply. Those are at the end of this page.

A reason this page does not list comes from a newer worker than the one that wrote these docs. The console then shows
the word as it is.

A failed record written by an older worker may name no reason, or may keep an error's own words where a reason belongs
(a container exit or a forge call that failed, before `container-infra-exit`, `container-exit-unknown` and
`worker-error` existed): the worker that ran it predates the reasons for infrastructure exits. The console's runs list
and the `/dispatch` panel (its list, its run detail and the REASON column of `/dispatch runs`) show those words to no
one: they read such a record as having no reason, and the runs list says "No reason was recorded". The console's run
page still shows the reason as it was recorded.

## Stopped while running

### worker-abort

The worker ended the run before it finished. That is the 30 minute job limit, or the worker shutting down. Partial
work may exist, and the run is not retried.

What to do: check the worker log for which one it was. Run the job again if its work is still wanted.

### operator-cancel

An operator cancelled the run (`pi-dispatch cancel`, the panel or the console). If it had started, partial work may
exist. If it was cancelled while it waited to start, nothing was spent.

What to do: nothing to fix. Run the job again if its work is still wanted.

### runner-policy

The run ended inside the container before it finished: it used up its turn or token budget, or the runner refused its
configuration. The model was called, so the run cost money.

What to do: read the job log for the budget it reached or the refusal, and adjust the trigger. See
[notifications.md](notifications.md).

### provider-auth-refused

The AI provider refused the worker's credentials. Either the key is wrong or revoked, or it may not use this model or
route.

What to do: check the provider key on the worker and what it is allowed to use, then run the job again. See
[notifications.md](notifications.md).

### cost-cap

The next AI call could have taken the run past its cost limit, so the runner did not make it. The record's `why` says
which rule refused: the call's cost could not be bounded (`unboundable`), its bound would have passed the cap
(`over-cap`), or the spend of the job's subprocesses could not be read (`external`).

What to do: raise the trigger's `run.maxCostUsd`, or the deployment's `PI_MAX_COST_USD`, if the work needs more. See
[costs.md](costs.md).

### model-not-allowed

A model this job would call is not on its list of allowed models, or the run tried to change an AI request in a way it
does not allow, so the call was not made. This happens in two places. Before the job starts, the worker refuses a job
whose main model is not on its list, or one of whose listed models declares a fallback that is not listed
(`why: fallback-unlisted`); nothing is spent. During the run, the runner refuses a call to a model off the list, or a
request changed in a way the list does not allow.

What to do: check the trigger's `run.models` and the deployment's `PI_ALLOWED_MODELS`, and list every model the job
may call, fallbacks included, or check the job log for a refused request. See [triggers.md](triggers.md).

### cost-cap-unenforceable

The run has a cost limit, and the job image could not enforce it before each AI call. So nothing was sent to the
provider.

What to do: update the job image to a release that enforces cost limits. See [job-image.md](job-image.md).

### model-policy-unenforceable

The run is limited to certain models, and the job image could not enforce that before each AI call. So nothing was sent
to the provider.

What to do: update the job image to a release that enforces model lists. See [job-image.md](job-image.md).

### oom-killed

The job's container ran out of memory and the kernel killed it. The same size would fail the same way, so it is not
retried. The worker only says this when the job's own memory peak reached its limit; a kill by the host's own
out of memory killer is retried instead.

What to do: raise the project's job memory size, or make the job use less memory. See [sizing.md](sizing.md).

### awaiting-input

The run asked a question and stopped to wait for the answer. This is a completed run: its work so far is saved, and
the next run continues from there. If a reply arrived while it was stopping, that reply was taken as the answer and the
run continues on its own.

What to do: if no reply was taken yet, answer the question. Reply on the issue or pull request (on a pull request, start the reply with the comment
phrase), or answer from the console. See [sessions.md](sessions.md).

### not-parked

A reply reached the worker as the answer to a waiting run, but no run on that issue was waiting. The worker checks the
saved session, not the label, so a label set by hand starts nothing. Nothing was spent, and the stale label was
removed.

What to do: nothing to fix. See [sessions.md](sessions.md).

## Budgets and caps

### over-budget

The deployment's cap on how many jobs may start in a day, week or month was already reached. The refused attempt still
counts in its window.

What to do: wait for the window to roll over, or raise the cap with `/dispatch set` if it is too low. See
[costs.md](costs.md).

### soft-hold

The jobs started in a window are inside the soft hold band just below its cap, so new starts are paused.

What to do: wait for the window to roll over, or raise the cap or narrow the hold band. See
[insights.md](insights.md).

### daily-token-cap

The tokens spent today had already reached the daily token cap. Token spend is only known after a run, so this cap
stops the next job, not the one that crossed it.

What to do: wait for the next day (UTC), or raise the daily token cap.

### dollar-cap

A dollar budget had no room left for this run's cost limit, or is smaller than the limit. The budget can be the
deployment's, a repository's or folder's, a project's, or a model's. Nothing was spent.

What to do: wait for the window to roll over, or raise that budget or lower the run's cost limit. See
[costs.md](costs.md) and [scoped-limits.md](scoped-limits.md).

### allocation-cap

The project's share of the budget split had no room left for this run's cost limit, or is smaller than it. The split
divides the envelope between projects, so raising a budget does not change it. Nothing was spent.

What to do: wait for the window to roll over, or for the next priorities plan. See [allocation.md](allocation.md).

### envelope-mismatch

This worker's budget envelope is missing, or it differs from the one the current budget split was made for. Judging a
split against the wrong envelope would be wrong both ways, so the job was refused. Nothing was spent.

What to do: run `pi-dispatch doctor` on each worker and make their envelopes agree, or turn delegated allocation off on
all of them. See [allocation.md](allocation.md).

### portfolio-no-envelope

A portfolio job writes a priorities plan, and this worker has no envelope that would let it apply one. The job would
have paid to write a plan that is then refused, so it was not run.

What to do: install the envelope with delegation on and `portfolio-job` among its writers, or remove the portfolio flag
from the trigger. See [portfolio-manager.md](portfolio-manager.md).

### portfolio-snapshot-oversize

The snapshot a portfolio job reads (the projects, their spend and their runs) was larger than a job may carry. Nothing
was spent.

What to do: govern fewer projects or members in the envelope. See [allocation.md](allocation.md).

### scope-cap

A repository's or folder's run cap for the window was already reached. The refused attempt still counts. Nothing was
spent.

What to do: wait for the window to roll over, or raise that row in `scoped-limits.json`. See
[scoped-limits.md](scoped-limits.md).

### project-cap

A project's run cap for the window was already reached. Nothing was spent.

What to do: wait for the window to roll over, or raise the project's row in `scoped-limits.json`. See
[projects.md](projects.md).

### job-size-exceeds-host

The job's size is larger than the worker host's whole job budget, so it could never start there. Nothing was spent.
The record names both sizes; the issue comment names neither.

What to do: lower the project's job size, or raise the host budget. `pi-dispatch doctor` shows both. See
[sizing.md](sizing.md).

### job-size-exceeds-share

The job's size is larger than the part of the host's job budget its project may use. Nothing was spent.

What to do: lower the project's job size, or raise its host share. See [sizing.md](sizing.md).

## Triggers and waits

### once-already-spent

The trigger is a one shot trigger, and an earlier run already spent it. A later close of the same issue does not start
another run. Nothing was spent.

What to do: delete `on.disarmed` from the trigger entry to arm it again. See [triggers.md](triggers.md).

### trigger-skew

The trigger sets a field (such as `run.models` or `run.maxCostUsd`) that the job reached the worker without. Run anyway,
it would have ignored that field. Either the trigger changed after the job was queued, or a service in the deployment
is older than the field, or still reads an older copy of the triggers file.

What to do: run the job again if the trigger changed. Otherwise update the old service, or restart the one reading the
old file. See [triggers.md](triggers.md).

### wait-skew

The trigger declares wait conditions, but the job reached the worker without them, so it would have run at once. The
causes are the same as for `trigger-skew`.

What to do: update the old service, or restart the one reading the old triggers file. See [wait-for.md](wait-for.md).

### wait-unreadable

The job carries wait conditions this worker cannot read, or its target cannot be handed to a check. The worker cannot
honour them, so it does not guess.

What to do: run the worker at the release of the service that queued the job, or fix the condition. See
[wait-for.md](wait-for.md).

### wait-profile-unknown

The job waits on a check that no wait profile on this deployment declares.

What to do: declare the wait profile on the worker, or fix its name in the trigger's `waitFor`. See
[wait-for.md](wait-for.md).

### wait-superseded

Another delivery for the same target is already waiting on the same conditions, or has already finished waiting. This
one would only repeat it.

What to do: nothing to fix. The other delivery carries the work.

### wait-after-beyond-max

The trigger's `after` time is further out than this deployment lets a job wait.

What to do: move the `after` time closer, or raise the maximum wait. See [wait-for.md](wait-for.md).

### wait-refused

The wait check answered that its condition will never clear.

What to do: read the check's answer in the worker log, then fix the condition or the check. See
[wait-for.md](wait-for.md).

### wait-unanswerable

The wait check could not answer several times in a row.

What to do: run the wait profile's check by hand on the worker to see why it fails. See [wait-for.md](wait-for.md).

### wait-expired

The job gave up waiting: its condition did not clear within the maximum wait or the maximum number of checks, or the
worker could not run the check often enough.

What to do: run the job again once the condition holds, or allow a longer wait. See [wait-for.md](wait-for.md).

## Models and providers

### model-unknown

The job names a model this deployment does not know: it is neither in pi's model catalog nor in the overlay
`models.json`. With a `why` starting `overlay-`, the overlay `models.json` itself cannot be used (a link, a folder, a
file the worker cannot read or parse), and the comment says so instead. Nothing was spent.

What to do: check the trigger's model and provider names, or fix the overlay file `pi-dispatch doctor` names. See
[triggers.md](triggers.md) and [costs.md](costs.md).

### provider-unconfigured

The deployment has no usable credential for the job's AI provider. Nothing was spent.

What to do: run `pi-dispatch doctor` on the worker. It names the variable to set. See
[global-pi-overlay.md](global-pi-overlay.md).

### model-failover-no-candidate

None of the job's reviewed model candidates can run safely. No container started and nothing was spent. Temporary
cooldowns, full model windows and busy endpoints defer instead; this refusal names a configuration or replay-safety
problem that waiting cannot resolve.

What to do: check `run.fallbackModels`, the effective allowed list, provider credentials, pricing and egress. The
worker log names each skipped configured model and its fixed reason. See [model-failover.md](model-failover.md).

## The job image

Each of these refusals happens before anything is spent. The image is present, but it lacks something this job needs.
The fix is the same for all the `job-image-*-unsupported` reasons: rebuild the job image from a release that declares
the feature, or set the trigger's `run.image` to an image that does. See [job-image.md](job-image.md) for the
capability labels.

### job-image-missing

The job image is not on the worker host. Jobs never pull images on their own, so the refusal is the whole diagnosis.

What to do: pull or build the image on the worker, or point `run.image` at one that is there. See
[job-image.md](job-image.md).

### job-image-forge-unsupported

The image ships no client for this job's forge. Most often the trigger forgot `run.image`.

What to do: set the trigger's `run.image` to an image that declares this forge.

### job-image-replicas-unsupported

The image does not declare replica support, so its guardrails would name the wrong branch. See
[replicas.md](replicas.md).

### job-image-commands-unsupported

The image does not declare command support, so its runner would not dispatch `run.command`.

### job-image-exclude-tools-unsupported

The image does not declare exclude tools support, so its runner would ignore `run.excludeTools` and keep every tool.
See [exclude-tools.md](exclude-tools.md).

### job-image-model-policy-unsupported

The image does not declare allowed model support, so its runner could not hold the job to its model list.

### job-image-model-failover-unsupported

The image does not declare `modelFailover`, so its runner cannot report the signed failure and replay-safety evidence
needed for a reviewed next-attempt fallback. Rebuild the image before enabling `run.fallbackModels`. See
[model-failover.md](model-failover.md).

### job-image-cost-cap-unsupported

The image does not declare cost cap support, so its runner would run the job with no dollar cap at all. See
[costs.md](costs.md).

### job-image-any-uid-unsupported

The image does not declare `anyUid`, so it cannot run as the worker's own uid, which this host's container runtime
requires. See [backends.md](backends.md).

### job-image-mcp-unsupported

The image does not declare MCP support, so its runner would not connect the servers `run.mcp` names. See
[mcp.md](mcp.md).

### job-image-forge-mcp-unsupported

The image does not carry the forge's own MCP server, which `run.mcp` names as `forge`. See [mcp.md](mcp.md).

### job-image-await-input-unsupported

The image cannot stop to wait for an answer, so its runner would ignore `run.awaitInput`. See
[sessions.md](sessions.md).

### job-image-progress-unsupported

The image cannot report progress, so its runner would ignore `run.progress`.

### job-image-recover-unsupported

The image cannot continue a lost run from a checkpoint, so its runner would ignore `run.recover`. See
[durable-runs.md](durable-runs.md).

### job-image-steer-unsupported

The image cannot receive messages while it runs, so its runner would ignore `run.steer`. See
[steering.md](steering.md).

### job-image-sandbox-layout-unsupported

The job runs on a venue that copies its files into a sandbox, and the image does not support that layout. Its runner
would not find the files.

### job-image-observable-runner-unsupported

The job runs on a venue whose sandbox must observe the runner before it lets it reach the network, and the image does
not support that. The job could reach neither its model nor anything else. See [backends.md](backends.md).

## The venue and the host

### backend-unblessed

The trigger asks for a venue (`run.backend`) that this deployment does not allow in `PI_BACKENDS`.

What to do: add the venue to `PI_BACKENDS` on the worker, or change the trigger's `run.backend`. See
[backends.md](backends.md).

### backend-floor-unobserved

`PI_BACKEND_FLOOR` asks for guarantees, and this host is not observed to give one of them right now. Examples: the
docker CLI does not send containers to a daemon on this host, the runtime does not apply a container's memory and
process limits, or it adds mounts of its own. The comment names which. Nothing was spent.

What to do: run `pi-dispatch doctor` on the worker to see which observation failed, then fix the runtime, or lower the
floor. See [backends.md](backends.md).

### venue-local-folders-unsupported

The job runs against a folder on this machine, and its venue copies a job's files into a sandbox instead of editing the
folder in place. Copying back afterwards would race every edit you make meanwhile, so it is refused.

What to do: run folder jobs on a venue that mounts folders (`local` or `podman`), with the trigger's `run.backend`. See
[backends.md](backends.md).

### job-user-unmappable

The host's container runtime cannot give the job a user that is not root and can still read and write its own files,
or it answered in a form the worker cannot read, so which user the job may run as is unknown. A rootless daemon, user
namespace remapping, a worker running as root, and a worker whose primary group is root or the Docker socket's all
cause the first, among others.

What to do: run `pi-dispatch doctor` on the worker: it names the cause. See [backends.md](backends.md).

### podman-conf-widens-job

The host's Podman configuration lets a job's container reach more than the venue allows: the host's own services, the
worker account's groups, or looser limits than the worker sets. It can be rootful Podman's configuration behind the
`local` venue, the `podman` venue's files, or its running rootless network. A configuration the worker could not read
in full is refused the same way.

What to do: run `pi-dispatch doctor` on the worker. It names the file and key to change, or the network to restart. See
[podman.md](podman.md).

### podman-service-restart-hold-expired

Rootful Podman's service kept running with a configuration older than its files for an hour. The job was held that
long and never ran. Nothing was spent.

What to do: restart the service while no local job runs (`sudo systemctl restart podman.service`), then run the job
again. See [podman.md](podman.md).

### netns-keeper-not-holding

On the `podman` venue, the egress proxy's network keeper (`pi-dispatch-netns-keeper`) did not pass its check before the
job started. The job was retried and never ran. Nothing was spent.

What to do: run `pi-dispatch doctor` on the worker for the exact fix. See [podman.md](podman.md).

### netns-keeper-crash-loop

The network keeper kept restarting while the job waited for it. The job never ran, and nothing was spent.

What to do: read the keeper's log (`journalctl --user -u pi-dispatch-netns-keeper.service`) and run
`pi-dispatch doctor`. See [podman.md](podman.md).

### egress-proxy-missing

The deployment runs jobs behind an egress policy, and its allowlist proxy is not on this host. The job could not have
reached its provider, and would have spent its budget proving it.

What to do: start the proxy with `pi-dispatch up` from the deployment folder (on the `podman` venue, as
[podman.md](podman.md) says), or set `PI_EGRESS=0` to run without a policy. See [egress.md](egress.md).

### egress-proxy-stopped

The same as `egress-proxy-missing`, except the proxy exists and is not running.

What to do: start it, or set `PI_EGRESS=0`. See [egress.md](egress.md).

### container-never-started

The container runtime never handed control to the job. It could not create or start the container, or a check before
it (an image probe, an egress probe, a secret read) could not run. Nothing was spent, and the job was retried.

What to do: run `pi-dispatch doctor` on the worker and check the container runtime. See
[notifications.md](notifications.md).

### container-detached

The job's container kept running after the command that started it had ended, usually after a lost connection to the
runtime. The worker could not see how the run ended, so it was retried.

What to do: check the worker's connection to its runtime, and stop any job container left running. See
[backends.md](backends.md).

### container-infra-exit

The job's container ended with the runner's infrastructure exit (exit code 1). The runner uses it for a fault that is
not the job's: an error or rate limit from the AI provider, a lost network, an MCP server it could not reach, or a crash
inside the container. The worker counted the attempt as an infrastructure fault and retried it while attempts were
left. The container ran, so its spend is counted and partial work may exist. A run armed for recovery (`run.recover`)
that has a checkpoint continues from it instead, and that attempt's record says `recovery-enqueued`.

What to do: read the `exit` line in the job log for what the runner met, then run the job again if every attempt was
used. See [durable-runs.md](durable-runs.md).

### container-exit-unknown

The job's container ended with an exit code the runner never uses, so the worker could not tell what happened. A
container stopped from outside the worker (a signal, or a memory kill the runtime did not confirm) ends this way, and so
can a job image older or newer than the worker. The worker retried it while attempts were left, and kept the spend
counted, since the container may have run. The record's `exitCode` is the code it ended with.

What to do: read the job log for how the container ended, and check that the job image matches the worker's release.
See [job-image.md](job-image.md).

### worker-error

The worker met an error it has no reason for: a forge or Valkey call that failed, or a fault in the worker itself. The
record names no cause of its own, because the error's words can carry an API path, a repository name or a library's
message, and the record holds fixed words only.

What to do: read the worker log's `job_failed` line for this job, which carries the start of the error's message, then
run the job again.

### config-refused

The deployment is configured in a way the worker cannot start this job with: for example a dollar row in
`scoped-limits.json` with no per job cap, or a provider credential that turned out unusable at the last step. Any job
count it reserved was given back.

What to do: run `pi-dispatch doctor` on the worker. It names the setting or file to fix. See
[scoped-limits.md](scoped-limits.md).

### settings-overlay-invalid

The settings file (the overlay `/dispatch set` writes) is present but invalid. The worker refuses every job rather
than run with settings nobody chose.

What to do: fix the key `pi-dispatch doctor` names, or delete the file to start from an empty overlay. See
[backup.md](backup.md).

## The OpenShell venues

The `openshell` and `openshell-bind` venues refuse a job before anything is spent when the gateway or the host cannot
give the guarantees they are built on. Each comment says what to change. See [backends.md](backends.md).

### openshell-gateway-not-local

The OpenShell gateway is not observed on this host. The venue keeps the job's credentials in the gateway, so it only
runs on a gateway the deployment runs itself.

What to do: run the gateway on this host, or run the job on another venue.

### openshell-global-policy

The gateway has a gateway wide policy in force, which would replace the policy the worker writes for the job.

What to do: remove that policy, or run the job on another venue.

### openshell-landlock-missing

The host's kernel does not offer Landlock, which the venue needs to confine the sandbox and keep its inputs read only.

What to do: run OpenShell jobs on a host with Landlock, or run the job on another venue.

### openshell-recover-unsupported

The trigger sets `run.recover`, and the OpenShell venue cannot checkpoint a run yet.

What to do: run the job on another venue, or drop `run.recover`.

### openshell-credential-reads-value

The job's model provider needs its key's real value inside the job (to sign requests, for example), and on this venue
the job only sees a placeholder.

What to do: run the job on another venue, or with a provider whose key is sent as it is.

### openshell-gateway-untested

The gateway runs a release other than the one this venue was measured on.

What to do: run the OpenShell release this pi-dispatch release names. `pi-dispatch doctor` says which.

### openshell-egress-untranslatable

The egress allowlist holds an entry the venue cannot turn into its network policy without widening it.

What to do: change the entry `pi-dispatch doctor` names, or run the job on another venue. See [egress.md](egress.md).

### openshell-bind-mounts-disabled

The `openshell-bind` venue mounts the job's files into the sandbox, and the gateway is not configured to allow that.

What to do: in the gateway's `gateway.toml`, allow driver config and bind mounts and turn resource admission off, then
restart the gateway.

### openshell-ptrace-scope-unprotected

The host's kernel lets a process read the memory of the process that started it (Yama `ptrace_scope` is 0, or cannot
be read). On this venue that is what keeps the job's tools away from the key that signs its result.

What to do: set `kernel.yama.ptrace_scope` to 1 on the host.

### openshell-ptrace-scope-too-strict

Yama `ptrace_scope` is 2 or 3. That also stops the sandbox from observing the job well enough to let it reach the
network, so the job would start and then fail.

What to do: set `kernel.yama.ptrace_scope` to exactly 1 on the host.

### openshell-bind-sandbox-lingering

A job on `openshell-bind` ran, and afterwards its sandbox could not be confirmed gone. Something in it may still be
changing the folder's files, so the run's result is not used and it is not run again. What it already changed stays.

What to do: check the sandbox on the gateway and remove it, then check the folder before running the job again.

### openshell-bundle-endpoint-not-allowed

The project's secret bundle names an endpoint host the job's network policy does not admit by that exact name. A bundle
may not widen what a job can reach.

What to do: add the host to `egress-allowlist.conf` as itself, or remove it from the bundle's endpoints. See
[secrets.md](secrets.md).

### openshell-bundle-endpoint-shared

The bundle names an endpoint host that the job's own forge, model or MCP credentials already go to. A host holds one
credential provider on this venue, so the job's own would stop working.

What to do: remove that host from the bundle's endpoints. See [secrets.md](secrets.md).

### openshell-bundle-endpoint-unknown

The bundle's endpoints name a variable its resolver did not deliver.

What to do: fix the name in the bundle's endpoints, or add the variable in the secrets manager. See
[secrets.md](secrets.md).

### openshell-bundle-name-taken

The bundle holds a variable the sandbox already sets itself, so one of the two would be lost.

What to do: rename the variable in the secrets manager. See [secrets.md](secrets.md).

### openshell-bundle-unpassable

The bundle holds a variable the venue cannot keep as a placeholder: a value over 8 KiB, or more endpoint variables or
hosts than a sandbox holds.

What to do: run the project on another venue, or change the bundle's endpoints. See [secrets.md](secrets.md).

### openshell-bundle-image-too-old

The bundle's variables reach the job as a file only a newer job image reads, so this image would run without them.

What to do: rebuild the job image from a release that declares `bundleEnvFile`. See [job-image.md](job-image.md).

## The repository or folder

### unprotected-branch

The repository's default branch is not protected. The job's token can merge, so branch protection is the only thing
that stops a job from merging its own work. Nothing was spent.

What to do: protect the default branch, then run the job again. See [SECURITY.md](../SECURITY.md).

### sha-gone

The default branch moved past the commit the job was resolved to, and the forge no longer serves that commit. Nothing
was spent.

What to do: run the job again. It resolves the default branch afresh.

### local-folder-not-a-repo

A folder job's folder has no `.git` at its root. It may have stopped being a repository after the job was queued, or a
cron trigger names a folder nobody checked.

What to do: run `git init` in the folder and commit once, or point the job at a repository. See
[triggers.md](triggers.md).

### local-folder-no-commit

The folder is a git repository, but it has no commit yet.

What to do: commit once in the folder, then run the job again.

### local-folder-unreadable-repo

git could not read the folder's repository: its `HEAD`, a branch or an object could not be resolved.

What to do: run `git status` in the folder to see what is wrong, and repair the repository.

### local-folder-escaped

The folder is named inside a run root or a cron trigger's folder, but it now resolves outside it through a link. A
job can write inside its folder, so a link planted there must not carry another job out of it.

What to do: list the real folder as a run root or as the trigger's `run.folder`, or remove the link. See
[allocation.md](allocation.md).

### local-folder-holds-envelope

The folder is the budget envelope's folder, or a folder above it. A job there could edit the envelope.

What to do: keep the envelope file outside every job's folder. See [allocation.md](allocation.md).

### local-folder-project-changed

The folder now leads, through a link, into another project's folder than the one the job was billed to.

What to do: check the links inside the run root, and list the folder under the project it really belongs to. See
[projects.md](projects.md).

### pi-too-many-files

The repository's `.pi/` folder holds more files than a job may carry, in all or in one skill. The limits are
`PI_LIMITS` in `worker/src/materialize.mjs`. Nothing was spent.

What to do: remove files from `.pi/` on the default branch.

### pi-file-too-large

The repository's `.pi/` holds a single file larger than a job may carry.

What to do: move the large file out of `.pi/` on the default branch.

### pi-too-large

The repository's `.pi/` holds more bytes in all than a job may carry.

What to do: trim `.pi/` on the default branch.

### pi-path-collision

The repository's `.pi/` holds two paths that differ only in letter case, or a file and a folder of the same name. A
host that ignores case would write them as one.

What to do: rename one of the two paths on the default branch.

### skills-dir-missing

The trigger sets `run.skillsDir`, and that path is not a directory on the worker host. The job would have run without
the skills its flow was written for.

What to do: create the directory on the worker, or fix `run.skillsDir`. See [triggers.md](triggers.md).

### skills-dir-empty

The skills directory holds no skill directory.

What to do: put the skills in it, or fix `run.skillsDir`.

### skills-dir-too-large

The skills directory holds more skill directories, or more bytes, than one trigger may inject. Every skill adds to
every job's prompt, so the limit is about the prompt, not the disk. The limits are `INJECT_LIMITS` in
`worker/src/copy-tree.mjs`.

What to do: remove the skills this trigger does not need, or split them across triggers.

### skills-dir-too-many-files

The skills directory holds more files than one trigger may inject.

What to do: remove files from the skills, or split them across triggers.

### skills-dir-too-deep

The skills directory nests folders deeper than one trigger may inject.

What to do: flatten the skills' folders.

### skills-dir-unreadable

The worker could not read the skills directory, or a file or folder inside it.

What to do: fix the permissions of the skills directory on the worker host.

## Sessions and secrets

### sessions-dir-unset

The trigger sets `run.resume`, and the worker has no session store (`PI_SESSIONS_DIR` is unset). The job would have run
with no session and still reported success.

What to do: set `PI_SESSIONS_DIR` to a private folder outside every repository, or drop `run.resume`. See
[sessions.md](sessions.md).

### secret-profile-unknown

The trigger sets `run.secrets`, and the resolver profile it names is not usable on this worker: none of that name is
declared, or its resolver is missing or not executable.

What to do: run `pi-dispatch doctor` on the worker to see which profiles it has, then declare the profile or fix the
name. See [secrets.md](secrets.md).

### secret-profile-ambiguous

The resolver profile is declared twice on this worker: once in the environment and once in the settings overlay.
Neither wins, on purpose.

What to do: remove one of the two. See [secrets.md](secrets.md).

### secret-name-reserved

A secret the job would receive uses a name the deployment already uses for the job's own credentials or configuration,
so one of the two values would be silently lost. The secret comes from the trigger's `run.secrets` or from the
project's bundle.

What to do: rename the variable in the triggers file, or in the secrets manager. The worker log names it. See
[secrets.md](secrets.md).

### secret-unresolved

A secret resolver refused the reference, printed nothing, or printed something unusable. That is final, so it is not
retried. The job would have started without the secret, and an agent that gets a 401 tends to write a plausible report
and exit cleanly.

What to do: run the resolver by hand on the worker against the reference to see why. See [secrets.md](secrets.md).

### secret-resolver-unreachable

A secret resolver could not answer: it could not reach its manager, timed out, or exited in a way it does not use for a
refusal. The job was retried and did not start.

What to do: check that the secrets manager is reachable from the worker. See [secrets.md](secrets.md).

### secret-bundle-profile-unknown

The project's secret bundle names a resolver profile that is not usable on this worker.

What to do: declare the bundle profile on the worker, or fix its name. See [secrets.md](secrets.md).

### secret-bundle-profile-ambiguous

The bundle's resolver profile is declared twice on this worker, once in the environment and once in the settings
overlay.

What to do: remove one of the two. See [secrets.md](secrets.md).

### secret-bundle-resume

The trigger sets `run.resume`, and its project has a secret bundle. A resumed job replays a saved conversation, and
anything the agent echoed from the bundle would be fed into every later job on that key.

What to do: set `"secretBundle": false` on the trigger, or drop `run.resume`. See [secrets.md](secrets.md).

### secret-bundle-trigger-changed

The trigger that queued this job is no longer in the triggers file as it was, so whether it opted out of the bundle is
unknown.

What to do: run the job again from the current trigger. See [secrets.md](secrets.md).

## MCP servers

The first group is refused by the worker before the job starts, and nothing is spent. The second group is stopped by
the runner inside the container, before the agent's prompt. None of the comments names the server's host or a
variable; the worker log does. See [mcp.md](mcp.md).

### mcp-list-invalid

The job's list of MCP servers is not one the triggers file's loader writes. A service in the deployment may be at
another release.

What to do: run every service of the deployment at the same release.

### mcp-config-invalid

The list of MCP servers could not be used. Before the job starts, this is the overlay `mcp.json`, which the worker cannot
read or use. Inside the container, it is the list the worker wrote for the job, which the job image does not accept.

What to do: fix the overlay `mcp.json` (`pi-dispatch doctor` checks it), and run a worker and a job image of the same
release.

### mcp-server-unknown

The trigger names a server the deployment does not offer.

What to do: declare the server in the overlay `mcp.json`, or fix the name in `run.mcp`.

### mcp-secret-unmapped

A credential the server needs is not passed by the trigger.

What to do: pass it in the trigger's `run.secrets`.

### mcp-secret-reserved

The server would be handed a credential the deployment keeps for the job itself.

What to do: give the server's credential a variable of its own.

### mcp-excluded

The trigger's `run.excludeTools` removes every way the job could reach the server. See
[exclude-tools.md](exclude-tools.md).

What to do: remove the server from `run.mcp`, or keep a tool that reaches it.

### mcp-egress-unreachable

The egress policy does not let a job reach the server.

What to do: add the server's host to the egress allowlist, or drop the server. See [egress.md](egress.md).

### mcp-package-runner

The egress policy does not let a job reach the package registry the server is fetched from.

What to do: allow the registry in the egress allowlist, or install the server in the job image.

### mcp-unavailable

A server did not start, failed its handshake, or refused the connection (an authentication error among them).

What to do: check that the server starts and accepts the job's credentials. The job log names it on the `exit` line.

### mcp-config-mismatch

The servers the worker wrote for the job are not the ones it named for it.

What to do: run a worker and a job image of the same release.

### mcp-secret-missing

A credential a server needs was not set inside the job.

What to do: check the secrets the trigger passes.

### mcp-command-missing

The job image does not have the program a server runs.

What to do: install the server in the job image or the overlay.

### mcp-shadowed

Another extension in the job registers a tool or command that only the job's MCP servers may.

What to do: remove that extension, or the trigger's MCP servers.

## Answers, progress and steering

### await-input-shadowed

Another extension in the job registers the tool a run uses to stop and wait for an answer. The run ended before the
agent started.

What to do: remove that extension, or the trigger's `run.awaitInput`. See [sessions.md](sessions.md).

### await-input-without-session

The run may stop to wait for an answer, but had nowhere to keep its work. This is a worker and job image of different
releases.

What to do: run a worker and a job image of the same release.

### report-progress-shadowed

Another extension in the job registers the tool a run uses to report its progress.

What to do: remove that extension, or the trigger's `run.progress`. See [triggers.md](triggers.md).

### steer-inbox-missing

The run may receive messages while it works, but could not read where they arrive. This is a worker and job image of
different releases.

What to do: run a worker and a job image of the same release. See [steering.md](steering.md).

### steer-no-exit-key

The run may receive messages, but had no key to confirm their delivery with. The cause is the same.

What to do: run a worker and a job image of the same release. See [steering.md](steering.md).

## Durable runs

These are the reasons of `run.recover`, which continues a run from its last checkpoint when a worker or container is
lost. See [durable-runs.md](durable-runs.md).

### recover-store-unset

The trigger sets `run.recover`, and the worker has no checkpoint store (neither `PI_CHECKPOINTS_DIR` nor
`PI_SESSIONS_DIR` is set). A lost run could not be continued while the job still looked protected. Nothing was spent.

What to do: set one of the two, or drop `run.recover`.

### recovery-enqueued

This attempt was lost to an infrastructure fault, and the run is continuing from its last checkpoint in a recovery
job. The record says `failed` for this attempt only. No failure comment is posted and no failure hook runs.

What to do: nothing yet. Follow the recovery's own run.

### recovery-host-lost

The run stopped on a worker that has not come back, and its checkpoint is on that worker. It could not be continued.

What to do: check that worker, then run the job again.

### recovery-cap

The run was lost and continued as many times as allowed, so it is not continued again. Partial work may exist.

What to do: read the worker log for why each attempt was lost, then run the job again.

### recovery-checkpoint-absent

The run was lost, and its checkpoint could not be used: it is missing, damaged, or was taken on another host, pi
release or venue. Partial work may exist.

What to do: read the worker log for why, then run the job again.

### recovery-superseded

The run this recovery would continue had already finished, so there was nothing left to continue. Nothing is posted.

What to do: nothing to fix.

### recovery-unsafe-extensions

The run was lost, and it is not continued because the repository's `.pi/extensions/` could load code the agent wrote.
Partial work may exist.

What to do: run the job again from the start. A repository with `.pi/extensions/` is never recovered.

### recovery-failed

The run was lost, continued from its checkpoint, and the continuation was lost too. It is not continued again.

What to do: read the worker log for why, then run the job again.

## Session reasons

A record's `session.reason` says whether a job continued its saved conversation (`run.resume`), and if not, why not.
Most values are a cold start: the job ran from the start, and that is a correct run. See [sessions.md](sessions.md).

| Reason | What happened | What to do |
|---|---|---|
| `resumed` | The job continued its saved conversation. | Nothing. |
| `absent` | No saved conversation: the first run on this key, or the last one saved nothing. | Nothing. |
| `expired` | The saved conversation was older than `PI_SESSIONS_TTL_DAYS`. | Raise it if conversations should last longer. |
| `conversation-too-old` | The conversation began longer ago than `PI_SESSION_MAX_AGE_DAYS`. | Raise it if conversations should run longer. |
| `resume-chain-too-long` | The conversation had been continued `PI_SESSION_MAX_RESUME_CHAIN` times in a row. | Raise it if longer chains are wanted. |
| `context-too-full` | The saved conversation already filled `PI_SESSION_MAX_CONTEXT_PCT` of its model's context window. | Raise it, or use a model with a larger window. |
| `compaction-summary-empty` | The saved conversation holds a compaction with an empty summary, so continuing would silently lose turns. | Check the cap that cut the summary call short. |
| `too-large` | The saved conversation was over `PI_SESSION_MAX_BYTES`. | Raise it if larger conversations are wanted. |
| `unparseable` | The saved file is not a pi session. It is rejected on every run until it is replaced or expires. | Remove the key's transcript from the store. |
| `not-a-regular-file` | The saved file is not a regular file (a link, for one). | Remove what stands at the transcript's name. |
| `key-not-a-directory` | The key's folder in the store is not a folder. | Remove what stands at the key's name. |
| `transcript-diverted` | The worker could not confirm the conversation was saved at its key. | Check what else writes into the store. |
| `venue-changed` | The conversation was written on another venue. | Run the trigger on one venue. |
| `pi-version-changed` | The job image runs another pi than wrote the conversation. | Nothing to fix. |
| `transcript-replaced` | The conversation changed while this job read it, usually another run saving a new one. | Nothing to fix. |
| `locked` | Another job was saving this key's conversation at the same moment, so this one was not saved. | Nothing to fix. |
| `promote-failed` | Saving the conversation failed: a full disk, or a permission change in the store. | Check the store's disk and permissions. |
| `disabled` | The trigger does not set `run.resume`. | Set it if runs should continue one conversation. |

## Recovery skipped reasons

A record's `recoverSkipped` says why a job whose trigger sets `run.recover` ran without recovery. The job still ran,
exactly as it would without the setting. See [durable-runs.md](durable-runs.md).

| Reason | What happened | What to do |
|---|---|---|
| `local` | A folder job is never recovered. | Nothing to fix: only forge jobs are. |
| `no-run-id` | The job's queue id could not be derived from its data. | Check the worker log. |
| `base-unprimed` | The checkpoint store could not take the run's base commit. | Check the store's disk and permissions. |
| `workspace-extensions` | The base commit holds `.pi/extensions/`, whose imports could load code the agent wrote. | Nothing to fix: such a repository is never recovered. |

## Plan reasons

A portfolio job's record carries `plan`: whether its priorities plan applied, and if not, why. See
[allocation.md](allocation.md) and [portfolio-manager.md](portfolio-manager.md).

| Reason | What happened | What to do |
|---|---|---|
| `plan-absent` | The job completed without writing a plan. | Check the flow, and the next report's first line. |
| `plan-not-portfolio` | A job that is not a portfolio job wrote a plan. | Run the plan from the flagged trigger. |
| `plan-oversize` | The plan file was too large. | Check the flow: a plan is a small file. |
| `plan-not-regular-file` | The plan was not a plain file. | Check the flow. |
| `plan-unreadable` | The plan file could not be read. | Check the worker log. |
| `plan-parse-error` | The plan file was not valid JSON. | Check the flow's output. |
| `plan-collect-error` | The worker could not tell what became of the plan; it may have applied. | Read the allocation audit file. |
| `plan-invalid` | The plan broke a rule of the plan format. | Read the audit file for the field and rule. |
| `delegation-off` | The envelope does not delegate allocation. | Turn delegation on if plans should apply. |
| `writer-not-allowed` | The envelope does not list this writer. | Add `portfolio-job` to its writers. |
| `envelope-mismatch` | This worker's envelope differs from the split's. | Make the workers' envelopes agree. |
| `plan-duplicate` | The same plan had already been applied. | Nothing to fix. |
| `plan-stale` | Another plan applied after the one this plan was written against. | Nothing to fix. |
| `plan-too-soon` | The plan came sooner than `minIntervalHours` after the last one. | Wait, or shorten the interval. |
| `plan-incomplete` | The plan left out a project or member it must name. | Read the audit file for what was missing. |
| `plan-busy` | Another plan or a revert was being applied at the same moment. | Run the portfolio job again if this plan should still apply. |

## Bundle skipped reasons

A record's `bundleSkipped` says why a job ran without its project's secret bundle. See [secrets.md](secrets.md).

| Reason | What happened |
|---|---|
| `manual` | A manual run: no trigger made it. |
| `chained` | A job queued by another job's `/outbox`. The grant was to the trigger, not to what its job queues. |
| `opted-out` | The trigger sets `run.secretBundle: false`. |
| `fork` | A pull request from another repository, and the bundle does not set `forkReviews`. |
| `head-unverified` | The forge would not say whose pull request this is, so it ran as a fork's. |

## Steering skipped reasons

A record's `steerSkipped` says why a job whose trigger sets `run.steer` could not receive messages. The job still ran.
See [steering.md](steering.md).

| Reason | What happened |
|---|---|
| `venue-copies` | The venue copies the job's files, and the job image cannot take messages another way. |
| `no-exit-key` | The job image cannot verify a delivery. |
| `no-transcript` | Nothing could read the delivery confirmations. |
| `no-inbox` | The run's inbox folder could not be made. |

## Live transcript skipped reasons

A record's `liveSkipped` says why a run had no live transcript, and so no live progress. See
[console.md](console.md).

| Reason | What happened |
|---|---|
| `venue-copies` | The venue copies the job's files and does not stream the transcript back. |
| `no-capability` | The venue streams the transcript only from a job image that declares it, and this one does not. |
| `no-exit-key` | The job image cannot verify a streamed transcript. |

### awaiting-approval

Approval requested. Reply /approve, /decline followed by an optional reason, or ask a question. Only an authorized reply can continue the saved run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-config-invalid

Stopped: the approval gate configuration is invalid. Check the trigger declarations and rebuild a matching worker and job image. Not retried.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-without-session

Stopped: approval gates need a persisted session. Check the session store and job image. Not retried.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-shadowed

Stopped: another extension registered the reserved approval tool. Remove the conflicting registration and run again. Not retried.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-decision-invalid

Stopped: the decision does not match the parked tool result. Check the retained session and request before starting another run. Not retried.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-author-missing

Refused: this approval reply has no authorized actor identifier. Reply through an authenticated operator surface or the forge. Not run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-expired

Refused: this approval expired. Its durable decline is continued by the expiry job. Not run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-expiry-invalid

Refused: the expiry job does not match a durable system decline. Check the approval store. Not run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-host-mismatch

Refused: the saved approval session belongs to another worker host. Route the reply to that host. Not run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-job-id-missing

Refused: the approval continuation has no queue identifier. Check the worker wiring. Not run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-park-invalid

The approval request did not match a declared gate and saved session. No approval is armed. Check the runner and trigger declaration.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-pending

Refused: this run is waiting for an approval decision. Approve, decline, or ask a question before starting more work. Not run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-policy-changed

Refused: the approval declaration changed. Start a new authorized run under the current trigger policy. Not run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-policy-unavailable

Refused: the current approval declaration could not be read. Check the triggers file before trying again. Not run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-request-conflict

The saved approval request conflicts with this conversation. No new approval is armed. Check the session and durable request.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-request-stale

Refused: this reply names an approval request that is no longer pending. Reload the current request before answering. Not run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-request-unbound

Refused: this reply is not bound to the pending approval request. Reply again after the approval is published. Not run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-state-conflict

Refused: the approval was already decided, consumed, or superseded. Check its recorded decision before starting another run. Not run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-state-unavailable

The approval could not be saved durably. No approval is armed. Check the session store and Valkey before starting another run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-store-unavailable

Refused: this worker has no durable approval store. Check the worker configuration. Not run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-finish-unavailable

The approval continuation ended but its durable completion could not be saved. Check Valkey and the request before starting another run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-session-not-saved

The approval conversation could not be saved. No approval is armed. Check the retained session before starting another run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### approval-session-unavailable

Refused: the approved session could not be resumed. No approval can be transferred to a new conversation. Check the retained session and its limits.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### job-image-approval-gates-unsupported

Refused: the job image does not declare approval gates. Rebuild the job image with approval support. Not run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### job-image-approval-auth-unsupported

Refused: approval gates need an image with authenticated runner exits (exitAuth). Rebuild the job image. Not run.

Check the current approval, its saved session, and the trigger declaration; reload before replying again.

### model-role-unknown

Refused: the requested model role is not declared in the reviewed role map. Nothing was spent.

What to do: Add or correct the role in triggers.json modelRoles, then run the trigger again.

### model-role-provider-conflict

Refused: the trigger's provider conflicts with its mapped role provider. Nothing was spent.

What to do: Remove run.provider or make it agree with modelRoles.

### model-agents-invalid

Refused: the base commit's agent definitions are invalid. Fix their frontmatter and retry. Not run.

What to do: Correct the base commit's .pi/agents frontmatter and run again.

### model-roles-invalid

Stopped: the job image could not read its reviewed model roles and agent definitions. Rebuild the image and check its job inputs. Not retried.

What to do: Check the reviewed role map, its effective 16-model ceiling, and the job image inputs.

### model-roles-shadowed

Stopped: another extension registered the reserved subagent tool, so reviewed model role resolution cannot be guaranteed. Remove the conflicting extension. Not retried.

What to do: Remove the conflicting subagent extension or staged package and run again.

### job-image-model-roles-unsupported

Refused: the job image does not declare modelRoles support. Rebuild it before running role-mapped jobs. Not run.

What to do: Rebuild the job image from a release that declares the feature, or set the trigger's `run.image` to one that does.

## Watch findings and investigations

### watch-cooldown

The finding arrived during its fingerprint cooldown. No additional investigation started.

What to do: Wait for cooldown to end or inspect the existing finding.

### watch-cap

The source, rule or active-fingerprint cap refused the finding before paid work.

What to do: Inspect the source and caps before changing the reviewed limits.

### watch-unmatched

The finding matched no reviewed watch rule. No investigation started.

What to do: Check the source and structured match fields.

### watch-ignored

The reviewed decision selected ignore. Only the decision was charged.

What to do: Inspect its probabilities and thresholds if the outcome was unexpected.

### decide-refused

The decision model or its bounded price was refused.

What to do: Use a known input-only priced decision model and a sufficient reviewed cap.

### decide-unanswered

The decision did not produce a usable answer; its reviewed human fallback applies.

What to do: Inspect the decision trace and the fallback issue.

### watch-reference-invalid

The queued watch reference does not identify the reviewed finding. No investigation started.

What to do: Check the producer and worker versions and submit a new authenticated finding.

### watch-config-changed

The reviewed watch rule changed or disappeared before pickup. No investigation started.

What to do: Review the current configuration and submit the finding again if still wanted.

### watch-window-pending

The digest window is still open. No investigation started.

What to do: Wait until the finding is due and inspect delayed queue health.

### watch-threshold

The completed digest did not reach its minimum count. No investigation started.

What to do: Inspect the digest counts and review the configured threshold.

### watch-evidence-expired

The private finding evidence expired or is unavailable. No investigation started.

What to do: Check evidence retention and queue delay before submitting a new finding.

### watch-issue-target-missing

The selected action needs a reviewed issue target that is unavailable.

What to do: Configure an explicit supported forge issue target.

### watch-trace-unavailable

The investigation trace could not be collected completely.

What to do: Check the trace store and collector; treat the investigation record as incomplete.

### watch-output-unavailable

The completed investigation output could not be collected safely.

What to do: Check the output files, schema and store before retrying.

### watch-project-mismatch

The watch source project differs from the resolved investigation folder project. Nothing was spent.

What to do: Correct the reviewed source and folder project pairing.

### watch-config-invalid

The job image refused its watch isolation marker or incompatible integrations.

What to do: Use a current watch-capable image and read-only reviewed configuration.

### watch-issue-cap

The source reached its durable watch issue identity limit before calling the forge.

What to do: Inspect existing issue mappings and reduce fingerprint cardinality.

### watch-issue-uncertain

An earlier issue creation has an uncertain result; another issue was not created.

What to do: Reconcile its stable marker on the forge before retrying or changing the mapping.

### watch-issue-close-policy-changed

The quiet-close policy changed before the issue could be closed.

What to do: Inspect the current reviewed rule and issue status.

### watch-issue-close-raced

A new finding arrived during issue closure; the host reopened the issue.

What to do: Inspect the ongoing incident and its latest count.

### watch-issue-close-uncertain

The forge outcome of quiet closure is uncertain.

What to do: Inspect the issue on the forge and retry reconciliation.

### job-image-watch-unsupported

The job image does not declare read-only watch isolation. The investigation was refused.

What to do: Rebuild the image from a watch-capable release or select a compatible reviewed image.

### watch-board-invalid

The proposed watch board failed its inert block schema or trace provenance checks. The previous board remains.

What to do: Inspect the proposal and produce a schema-valid board with trace references.

### watch-board-oversize

The proposed watch board exceeded 16 KiB. The previous board remains.

What to do: Reduce the proposal before producing another board.

### watch-unavailable

The worker could not resolve the watch reference safely. No investigation started.

What to do: check watch runtime configuration and worker availability.

### watch-query-credential-missing

A reviewed log query requires a host credential that is unavailable. No investigation started.

What to do: configure the named read-only query credential on the worker host.

## Question grouping

### question-group-unavailable

Question grouping is not configured on this worker.

What to do: Check the Zero touch grouping status and reviewed configuration before trying again.

### question-group-config-changed

The reviewed question grouping settings changed.

What to do: Check the Zero touch grouping status and reviewed configuration before trying again.

### question-group-source-expired

The private source for this question expired.

What to do: Check the Zero touch grouping status and reviewed configuration before trying again.

### question-group-source-unavailable

The private source for this question could not be read.

What to do: Check the Zero touch grouping status and reviewed configuration before trying again.

### question-group-source-oversize

The private source exceeds the grouping input limit.

What to do: Check the Zero touch grouping status and reviewed configuration before trying again.

### question-group-candidates-expired

A group exemplar expired, so matching would be incomplete.

What to do: Check the Zero touch grouping status and reviewed configuration before trying again.

### question-group-limit

The repository has reached the bounded candidate group limit.

What to do: Check the Zero touch grouping status and reviewed configuration before trying again.

### question-group-stale

The question groups changed while a job was being prepared.

What to do: Check the Zero touch grouping status and reviewed configuration before trying again.

### question-group-refused

Stopped: the reviewed grouping model or private input could not be used. Check Zero touch status. Not retried.

What to do: Check the Zero touch grouping status and reviewed configuration before trying again.

### question-group-unanswered

Stopped: the classifier returned no confident grouping. Check Zero touch status. Not retried.

What to do: Check the Zero touch grouping status and reviewed configuration before trying again.

### question-group-output-invalid

The grouping result did not satisfy the closed result contract.

What to do: Check the Zero touch grouping status and reviewed configuration before trying again.

### job-image-question-grouping-unsupported

The job image does not declare isolated question grouping.

What to do: Check the Zero touch grouping status and reviewed configuration before trying again.
