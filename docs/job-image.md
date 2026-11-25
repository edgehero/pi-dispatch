# Building your own job image

Every job runs in a container. By default that is one image for the whole deployment — `PI_JOB_IMAGE`,
usually `pi-job:latest`. A trigger can name its own instead:

```jsonc
{ "on": { "type": "cron", "id": "nightly", "pattern": "0 3 * * *" },
  "run": { "kind": "local", "folder": "/srv/api", "flow": "tidy", "task": "…",
           "image": "my-python:1.2.0" } }
```

`run.image` works on all four trigger kinds. Absent means the deployment default.

## When you need this — and when you don't

You do **not** need a second image for pi *configuration*. Custom models, global skills, a global persona
and staged third-party pi packages all ride the read-only `/opt/pi-global` mount and work with the pulled
prebuilt image — see [global-pi-overlay.md](global-pi-overlay.md).

You need a second image for a **toolchain**: apt packages, a language runtime, system libraries. A
read-only mount cannot deliver those. That is the whole boundary:

> **overlay = pi configuration, mounted, one per deployment.
> image = the operating system the flow needs, built, per flow.**

If two flows want different toolchains, the alternative is one image holding the *union* of both — which
only ever grows, because removing anything might break the other flow.

## Three starting points

**`FROM ghcr.io/edgehero/pi-job:latest` and add a layer.** The cheapest and the most common, and the one to
reach for first: the pinned base, the pinned pi, the runner, the entrypoint, the guardrails floor and the
`dev.pi-dispatch.*` labels are all **inherited** rather than restated, so a second copy of those pins is not
a second thing to forget to bump. Re-declare only a label whose truth your layer changed.
`image/Dockerfile.azure` is exactly this shape: `ARG BASE` plus `FROM ${BASE}`, one Azure CLI layer, and a
single re-declared `dev.pi-dispatch.forges` with `azure` appended (see
[azure-devops.md](azure-devops.md), which also names the `--build-arg BASE=…` you need).

**Pin the base if you would rather not track `latest`.** Every published build carries the git `sha` as a
tag, and a release build also carries the **product version** (`ghcr.io/edgehero/pi-job:0.8.0`). Neither
ever moves, while `latest` follows `main`: the version tag is published only by the push that bumps the
version (or a manual run that asks for it) and only while that tag is not on the registry yet, so an
unreleased merge moves `latest` and never a released version. The receiver image is tagged the same way. A
pinned base is the honest choice for a derived image whose layer assumes something about the base; the cost
is that a pin does not pick up a security rebuild, so bump it deliberately.

**A layer that adds anything under `/home/pi` must keep it writable by any uid**, or re-declare
`dev.pi-dispatch.capabilities` without `anyUid`: the label is inherited, and a `0755` directory your layer
creates there breaks a job that runs as another uid while the label still claims it works.

**Copy `image/Dockerfile` and add to it.** You inherit every property in the checklist below for free, and
the only thing you own is your own `RUN apt-get install …` layer. Prefer this over the layer above only when
you need to change something *inside* the base build (a different base distro, a different pi pin).

**Start from scratch.** Then the next section is a contract, not advice.

## The conformance checklist

The worker verifies exactly **three declarations** an image makes about itself (the three
`dev.pi-dispatch.*` labels at the bottom of the table, all read off one `docker image inspect` before the job
spends anything) and **assumes everything else**. Every assumed item fails silently or late, which is why the
list exists.

| What | What breaks without it | Loud or silent |
|---|---|---|
| Non-root runtime user with a **writable home** (`~/.pi/agent` and the tool caches), writable by **any** non-root uid if the image claims `anyUid` | The job does NOT fail at the credential write (pi swallows it); playwright, npm or gh fail later on a path no Dockerfile hints at. The runner logs `home_not_writable` or `agent_dir_not_writable` first | late, and cryptic |
| `ENTRYPOINT` is the pi-dispatch runner | An image that runs *something else* and exits 0 is recorded by the queue as a **completed job** that never started an agent | **silent** |
| Runner honours the exit-code protocol (0 done / 1 infra / 2 policy) | Node's default exit 1 on a policy failure makes the queue pay to retry work that can never succeed | late, and expensive |
| The **pinned pi version** (`CONST-PI-VERSION-PINNED`) | A stale pi turns every job into a no-op that reports success | **silent** |
| Guardrails at `/opt/pi-dispatch/HARD_RULES.md`, root-owned and agent-unwritable | An agent that can rewrite its own safety floor has none | **silent** |
| `PLAYWRIGHT_BROWSERS_PATH`, `PLAYWRIGHT_MCP_BROWSER`, `PLAYWRIGHT_MCP_SANDBOX` baked in | Frontend flows fail to launch a browser, or launch the wrong one | mixed |
| Fonts installed | Chromium renders tofu boxes: screenshots look plausible and contain no legible text | **silent** |
| The loader flags in `image/runner/src/loader.mjs` | **Security posture is per-image.** A deployment that turned repo-file discovery off for multi-tenancy in one image **has not turned it off in another** | **silent** |
| Label `dev.pi-dispatch.pi-version` = the pi the image actually carries | The worker reads it pre-spend and treats an absent one as **"never resume"**, the safe direction. Every `run.resume` job then cold-starts: correct, paid for in full, and invisible | **silent** (deliberately) |
| Label `dev.pi-dispatch.forges` = the forges this image can serve | An **exclusion** list. A label that omits a forge refuses that forge's jobs pre-spend (`job-image-forge-unsupported`); a label naming a forge whose CLI is *not* installed is worse than none, turning that refusal into a paid container that fails at step 3 | loud, pre-spend |
| Label `dev.pi-dispatch.capabilities` = the optional features it honours (`replicas`, `commands`, `excludeTools`, `anyUid`, `costCap`, `modelPolicy`, `modelRoles`, `modelFailover`, `exitAuth`, `mcp`, `forgeMcp`, `awaitInput`, `approvalGates`, `reportProgress`, `recover`, `steer`, `sandboxLayout`, `transcriptStderr`, `steerStdin`, `bundleEnvFile`, `observableRunner`, `fork`, `watch`, `questionGrouping`, `answerDraft`, `subscriptionAuth`, `loadExclusions`, `packageCanary`, `idleWatch`, `credentialRefresh`, `subscriptionLease`, `mergePolicy`, `secretFiles`, `subscriptionAllowance`, `subscriptionRoles`, `subscriptionChildren`) | An **inclusion** list. An image without the label is refused **every** replica job pre-spend (`job-image-replicas-unsupported`), because a floor that hard-codes `pi/issue-<n>` would make both replicas converge on one branch; **every** `run.command` job pre-spend (`job-image-commands-unsupported`), because a runner that does not understand `PI_COMMAND` would feed `/name args` to the model as prose or die retryable on `no-terminal-message`; and **every** `run.excludeTools` job pre-spend (`job-image-exclude-tools-unsupported`), because a runner that does not read `PI_EXCLUDE_TOOLS` would run a "read-only" trigger with every tool the file says to remove and record a clean exit. `modelRoles` says the runner loads immutable reviewed role/agent inputs and resolves child roles before spawn, proved by an offline input-reader/tool smoke in `verify-image.sh`; an older image refuses role-mapped jobs pre-spend (`job-image-model-roles-unsupported`). `anyUid` says the image runs correctly as an arbitrary non-root uid with `HOME=/home/pi`, which is what a job needs on a daemon that enforces bind-mount ownership (native Linux Docker, rootful Podman): `chown -R pi:pi /home/pi && chmod 0777 /home/pi /home/pi/.pi /home/pi/.pi/agent` and no `ENV HOME`. On such a daemon a worker whose uid is not 1001 refuses a job on an image without it pre-spend (`job-image-any-uid-unsupported`); a uid-1001 worker runs the image as its own user and does not need it. `costCap` (issue #501) says the runner reads `PI_MAX_COST_MICROS` and stops a job before any provider call whose worst-case cost could take it past that cap; a runner without it would ignore the variable and spend with no cap, so the worker refuses **every** job with a dollar cap on an image without it, pre-spend (`job-image-cost-cap-unsupported`). `modelPolicy` (issue #502) says the runner reads `PI_ALLOWED_MODELS` and stops a job before any provider call to a model the list does not name; a runner without it would ignore the variable and call any model, so a job with an allowed-model list needs it (`job-image-model-policy-unsupported`). `modelFailover` says the runner emits signed provider-failure, tool-start and replay-safety evidence; a job with `run.fallbackModels` needs it (`job-image-model-failover-unsupported`). The offline conformance job verifies the signature and fields on a real runner 429 ([model-failover.md](model-failover.md)). `mcp` says the runner reads `/job/mcp.json` and connects the MCP servers a trigger names ([mcp.md](mcp.md)); a runner without it would run such a job without them, so the worker refuses it pre-spend (`job-image-mcp-unsupported`). `forgeMcp` says the image carries the forge's own MCP servers at the versions [mcp.md](mcp.md#the-forges-own-server) names, behind the wrappers `/usr/local/bin/forge-mcp-github` and `/usr/local/bin/forge-mcp-gitlab` that withhold their merge and approval tools; a job whose `run.mcp` names `forge` needs it (`job-image-forge-mcp-unsupported`). `awaitInput` says the runner reads `PI_AWAIT_INPUT` and offers the `await_human_input` tool; a job armed with `run.awaitInput` needs it (`job-image-await-input-unsupported`). `reportProgress` (issue #644) says the runner reads `PI_REPORT_PROGRESS` and offers the `report_progress` tool; a job armed with `run.progress` needs it (`job-image-progress-unsupported`), because an older runner would ignore the variable and the trigger's phases would never appear. `recover` (issue #645) says the runner reads `PI_RECOVER` and `PI_RECOVERING`, runs an armed job's tools one at a time and answers a recovered run's interrupted tool calls ([durable-runs.md](durable-runs.md)); a job armed with `run.recover` needs it (`job-image-recover-unsupported`), because an older runner would resume a lost run into unanswered calls and the agent could repeat a push or a comment. `steer` (issue #646) says the runner reads `PI_STEER`, reads the messages the worker writes into the read-only `/inbox` mount and hands each to the running agent once, as framed data, with a delivery ack signed with the exit key ([steering.md](steering.md)); a job armed with `run.steer` needs it (`job-image-steer-unsupported`), because an older runner would never read the messages while every one of them was accepted. A derived image also needs `exitAuth` for steering to work: without it the job runs unsteered (`steerSkipped: "no-exit-key"`). `transcriptStderr` (issue #686) says the runner reads `PI_TRANSCRIPT=stderr` and mirrors its session file's lines over stderr as records signed with the exit key, which is how a venue that copies the job's files (`openshell`) serves the live transcript, run progress and the status comment. It refuses nothing: on that venue an image without it (or without `exitAuth`) runs without them, and the worker logs `live_transcript_skipped` with reason `no-capability` (or `no-exit-key`); a binding venue never reads it. `steerStdin` (issue #686) says the runner reads `PI_EXIT_AUTH=stdin-frames`: the exit key as frame 1 of a length-prefixed frame stream on stdin, read before pi loads, then each steer message as a frame signed with that key, the stream moved off fd 0 so a tool child gets `/dev/null` there ([steering.md](steering.md)). It is how a venue that copies the job's files (`openshell`) steers a running job. It refuses nothing: on that venue an image without it runs unsteered (`steerSkipped: "venue-copies"`), and a binding venue never reads it (it keeps the read-only `/inbox` mount). `bundleEnvFile` (issue #704) says the runner reads `PI_BUNDLE_ENV=1`: a project secret bundle's plain variables as one JSON object in `bundle-env.json` in the job directory, put into the runner's own environment (which pi and its tools inherit) before pi's runtime exists. A name under `PI_`/`OPENSHELL_`, one the runtime or the sandbox sets (`HOME`, `USER`, `SHELL`, `TERM`, `PATH`, the CA and proxy variables, the git helper's) or one holding a credential placeholder is refused (exit 2); any other name the image's own `ENV` set is replaced, as `-e` replaces it on `local`. It is how an OpenShell venue hands those values to a job without the exec's argv, which the gateway logs ([secrets.md](secrets.md#on-an-openshell-venue-placeholders-for-the-variables-you-bind-to-a-host)); on those venues a job that would carry plain bundle variables on an image without it is refused pre-spend (`openshell-bundle-image-too-old`), and every other venue never reads it. `observableRunner` (issue #730) says the image carries `/opt/pi-dispatch/runner-observable`, a readable copy of the runner's node with `runner-node`'s exact bytes (installed 0755, 0555 at runtime once `/opt` is made read-only), and an entrypoint that starts the supervisor and the runner from it on `PI_RUNNER_OBSERVABLE=1`. An OpenShell sandbox mediates every connection through a broker that reads the connecting process's memory, which a process started from the exec-only (non-dumpable) `runner-node` refuses, so without this copy a job there reaches neither its model nor the network; the worker sets the variable on both OpenShell venues and refuses an image without the capability pre-spend (`job-image-observable-runner-unsupported`). What keeps the exit key from the job's tools there is not the file mode but the sandbox: OpenShell's workload seccomp denies `process_vm_readv`, `ptrace` and `pidfd_getfd`, and Yama (`kernel.yama.ptrace_scope` exactly 1, which the worker requires before spend) refuses a tool `/proc/<pid>/mem` of its ancestor, and `ulimit -c 0` in the entrypoint stops a tool's `SIGABRT` from dropping a core that holds the key. Every other venue keeps the exec-only `runner-node`. `exitAuth` (issue #545) says the runner signs its exit line with a key the worker writes to its stdin, writes a real exit line when it is stopped, and is started by the entrypoint under the exec-only `/opt/pi-dispatch/runner-node` with `--disable-sigusr1` (so a tool's SIGUSR1 cannot open the inspector of a process holding the key). It refuses nothing: on an image without it the worker reads the exit line as before, and a line the job's own tools forged can still be read as the runner's. Keep this repo's `ENTRYPOINT` in a derived image that keeps the label. Since issue #596 that entrypoint starts a small supervisor (`image/runner/supervise.mjs`) under the same node, which starts the runner: when the kernel kills the runner for memory, the supervisor writes the signed exit line saying `oom-killed`, and the worker stops the job without a retry. An image whose entrypoint runs the runner directly still works in the worker, and its out-of-memory kills are retried as infrastructure, as before, but `verify-image.sh` fails it while it keeps the label: its inspector probe finds every process running under `/opt/pi-dispatch/runner-node` and wants at least two (the supervisor and the runner), each with its inspector shut. The supervisor itself uses about 8 MB of anonymous memory inside the job's own memory limit (its RSS reads about 46 MB, but the node binary's text is shared with the runner), so a job has slightly less headroom than before it: on Docker Desktop the smallest limit at which the offline smoke job still reached its own exit moved up by 8 to 16 MB, from about 72 MB. The image runs that node as a separate copy, which adds about 120 MB. `idleWatch` (issue #888) says the runner reads `PI_JOB_IDLE_MS` and `PI_JOB_STALL_MS`, stops a job itself when nothing happens for the idle limit or the agent takes no step for the stall limit (exit 2, reason `idle` or `stalled`), and writes its activity counters beside the session file, or as a signed record on the stderr transcript. It refuses nothing: the worker keeps the 30-minute wall clock for a job on an image without it, and the run record says so. A derived image built before 5.3.0 lacks it until it is rebuilt. `credentialRefresh` (issue #888) says the runner reads `PI_CREDENTIAL_REFRESH` and applies the renewed credentials the worker drops in `/run/pi-dispatch/credentials`, mounted read-only: a GitHub App token into the environment every tool process started afterwards inherits, and a subscription sign-in's new snapshot into its guard. It refuses nothing: a job holding a credential that expires while it runs, on an image without it, keeps the 30-minute limit, and its record says why. `subscriptionLease` (issue #895), together with `idleWatch` and `credentialRefresh`, supports shorter renewable subscription leases on binding venues; an older image keeps full-deadline coverage. `subscriptionAllowance` (issue #1008) says the runner reads `PI_SUBSCRIPTION_ALLOWANCE_MICROS`, a trigger's `run.maxSubscriptionUsd`, and stops a job (exit 2, reason `subscription-allowance`) before a subscription call once the settled list price of its subscription calls reached it; a runner without it would ignore the variable and run those calls with no dollar limit, so the worker refuses every job with an allowance on an image without it, pre-spend (`job-image-subscription-allowance-unsupported`). `verify-image.sh` runs the baked runner's allowance offline and a real job handed a malformed value. `subscriptionRoles` (issue #946) says the runner runs a subscription job's role child inside itself, on the runtime it admitted, rather than as a separate pi process, which the subscription refuses ([model roles](model-roles.md#on-a-subscription)); a worker refuses a subscription job with a role map on an image without it, pre-spend (`job-image-subscription-roles-unsupported`). `verify-image.sh` runs the baked runner's guards, meter, role tool and in-process child offline, with a stand-in adapter that answers locally. `subscriptionChildren` (issue #1098) says a separate pi process a job starts on a subscription holds an admission of its own, run by the child meter the image loads first in every pi child, and that the runner counts its calls as the job's own subscription calls ([subscription authentication](subscription-auth.md#supported-jobs-and-visibility)). It refuses nothing: on an image without it such a child's subscription calls are refused before they are sent, as before. `verify-image.sh` starts a real pi child through the baked preload on an OpenAI subscription offline. | loud, pre-spend (`exitAuth` alone is **silent**: it refuses nothing, and a missing one only means the exit line is read unsigned) |
| Label `dev.pi-dispatch.net-binaries` = the binaries that may need the network, at their real paths (issue #683) | Read by a venue whose egress policy names executables rather than hosts alone (OpenShell, issue #684). Each entry must be a regular file at its own real path: a policy naming a symlink or a moved binary matches nothing, and the job loses the network with no word why. `verify-image.sh` checks every entry. An image without it is refused on such a venue | loud |

The two list labels have **opposite polarities**, deliberately: `forges` excludes, so no claim excludes
nothing and an unlabelled image is admitted everywhere; `capabilities` includes, so no claim includes nothing
and an unlabelled image is refused every replica, command or tool-excluding job. One rule underlies both, that an image declaring
nothing gets no benefit of the doubt about what it contains, and neither costs an ordinary job anything.
`image/Dockerfile` declares all of them, so a layer built on top of it inherits them.
The derived recipe below adds the separate [`display`](#graphical-applications) capability for live graphical
verification. The shipped image does not declare it, and it adds no job admission requirement.

**`mergePolicy` (issue #908).** An enabled `run.mayMerge` job needs this capability. It proves that the runner
reads the worker-written `merge-policy.json` input before loading project code and selects the fixed standing-rule
variant that permits landing the job's own change through the forge's requirements. Without it, the worker refuses
that job before spending (`job-image-merge-policy-unsupported`). A job without the opt-in keeps the original
`HARD_RULES.md` bytes and needs no new capability. The image verification exercises both modes through the actual
pinned loader, and malformed input must refuse. Rebuild derived images before enabling the setting, following
[the upgrade guide](upgrading.md#533-trigger-merge-permission).

**`sandboxLayout` and the WORKDIR (issue #683).** `sandboxLayout` says the runner reads `PI_JOB_LAYOUT` and, under
`sandbox`, finds every job path under `/sandbox`, and that the image carries `/opt/pi-dispatch/pi-landlock`, the write
confinement a venue that copies the job's files starts the runner through. Only such a venue (OpenShell) needs it;
there an image without it is refused pre-spend (`job-image-sandbox-layout-unsupported`). The shipped image's WORKDIR
is `/sandbox` for that venue's sake. On Docker and Podman the worker's argv carries `--workdir=/workspace`, so a job
there starts in its workspace whatever your image's WORKDIR says. An image built `FROM` this one keeps both.

The isolation itself is *not* on this list, and deliberately so: `--cap-drop=ALL`, `no-new-privileges`, the
memory/cpu/pids/shm limits and the mounts (up to five: `/job:ro`, `/workspace`, `/outbox` on local jobs,
`/session` on an armed resume, `/opt/pi-global:ro` when an overlay is configured) are all applied by the
**worker's `docker run` argv**, so they hold for any image you name. Nothing an image contains can weaken
them. What an image decides is what is *inside* the box, not what the box can do.

## Verify it

```bash
./image/verify-image.sh my-python:1.2.0
```

That script is a **superset** of this checklist, and it is the same definition CI runs against the image this
repo builds, so the script and the gate cannot drift apart. Beyond the rows above it also asserts that `bash`
is present (`pi-dispatch sandbox` re-opens a finished run with `--entrypoint bash`, and `TMOUT` is a bash
feature), that `gh`, `glab` and `tea` are on PATH, that the `dev.pi-dispatch.forges` label matches the CLIs
actually installed, and that `dev.pi-dispatch.capabilities` matches what the image bakes (for `anyUid`, by running as uid 4242; for `costCap`, by running a job with a fake key and no network under a cap of 0, which must stop with `cost-cap` before its first call; for `modelPolicy`, by running the same kind of job with a model list that lacks its model, which must stop with `model-not-allowed` before its first call; for `exitAuth`, by handing that job a key on stdin and checking the MAC on its exit line, checking the entrypoint runs `/opt/pi-dispatch/runner-node`, and checking that a child of that node cannot read its `/proc` entries; for `mcp`, by running the same kind of job with a stub stdio server in `/job/mcp.json`, which must connect before the job stops with `cost-cap`; for `forgeMcp`, by running both wrappers as the job user with no network, where each must answer an MCP `initialize` and `tools/list` showing no merge or approval tool and refuse a call to each withheld one, and github-mcp-server must print its release version; for `steer`, besides finding `PI_STEER` and the inbox module in the baked runner, by mounting a fixture directory at `/inbox`, where a write must succeed without `:ro` and a planted file and a delete must both leave the directory unchanged with `:ro`). Those run-based proofs are
the ones worth knowing about: **a label must not lie**, because the worker trusts it pre-spend.

**Run it on the machine that holds the image.** That is not a limitation to work around, it is the only
place the check means anything: jobs launch with `--pull=never`, so the images pi-dispatch can actually run
are exactly the ones on the worker's own host. A CI runner somewhere else has no access to them, which is
why this is a script rather than a button in the Actions tab.

It checks the **CORE** half — what any image must satisfy to be nameable in `run.image`. CI adds **RUNNER**
assertions on top, and those are deliberately *not* in the script: they pin properties of the runner this
repo ships (its exact refusal strings, a path under `/app`) and a conformant image built another way has no
reason to satisfy them.

Three rows of the table above it deliberately **cannot** check, and it says so when it finishes: that the pi
version inside matches the pin, that the entrypoint honours the exit-code protocol on every path, and that
the loader flags carry the posture you expect. Running a container can observe behaviour, not intent.

## Graphical applications

A job can run a headed Chromium application on a virtual display, including browser automation and screenshots.
The optional `display` image capability means **headed Chromium with Xvfb and a deterministic rendering probe**.
It does not promise GPU acceleration, a desktop session, or compatibility with every Electron application.
Ordinary headless Playwright already works in the shipped image and needs no virtual display.

The shipped image already contains Chromium, its pinned Playwright, Xvfb and fonts. It does not include `xauth`,
which `xvfb-run` normally requires. This recipe uses Xvfb's `-displayfd` readiness pipe instead: `pi-display`
allocates a private display, waits until it is listening, sets `DISPLAY` for its child, and removes the display
and the child's process group afterwards. Xvfb listens on no TCP port. The job's entrypoint stays the runner;
the flow or repository's test command calls the wrapper when it needs a display.

From a checkout of pi-dispatch, with the base already present on the worker's machine:

```sh
node image/build-display.mjs ghcr.io/edgehero/pi-job:5.3.3 pi-job:display
node .github/scripts/display-smoke.mjs pi-job:display ./display-chromium.png
./image/verify-image.sh pi-job:display
```

`image/Dockerfile.display` is the complete derived-image recipe. The builder inspects the base, builds through
a temporary local tag of that exact image ID, preserves its capability labels and appends `display`. It removes
the temporary tag afterwards. It installs no package at job time. On rootless Podman, run the builder **as the
worker account**, adding `podman` as its third argument, with the base in that account's store. Use `podman` as
the smoke command's third argument too. Build a named product release or digest deliberately; a rebuild is how
the derived image picks up base fixes.

Select it with the existing `run.image`. Inside the job, a typical command is:

```sh
pi-display npm run test:e2e
# Or inspect the known fixture independently of your own suite:
pi-display-probe /workspace/display.png
```

For Playwright API code, use `chromium.launch({ headless: false, chromiumSandbox: false })`. The CLI's
`PLAYWRIGHT_MCP_SANDBOX=false` setting is already baked into the base, but that CLI environment variable is not
a substitute for an API launch option. Direct Chromium and Electron launches need `--no-sandbox`. This disables
the application's inner sandbox: compromised rendered content has the job user's access inside the container.
The container remains the boundary. Keep capabilities dropped, no-new-privileges, the runtime's seccomp policy,
non-root execution and the existing resource bounds. No host display mount, published port, GPU device,
`--ipc=host`, extra capability or per-trigger security exception is needed for the measured Docker recipe.

**Electron variant.** The separate example adds GTK 3 and Electron **39.2.7**. It inherits `display`; doctor
still checks Chromium, so run the Electron fixture too when changing that runtime:

```sh
docker build --pull=false -f image/Dockerfile.display-electron \
  --build-arg BASE=pi-job:display -t pi-job:display-electron .
node .github/scripts/display-smoke.mjs pi-job:display-electron ./display-electron.png local electron
```

For your application's own Electron version, pin it in your build and test it separately. The fixture launches
through Playwright's `_electron.launch({ chromiumSandbox: false, ... })`; a direct launch is
`pi-display /path/to/electron --no-sandbox /path/to/app`. Keep application-specific test orchestration in the
flow or repository. The wrapper returns the application's status, 70 when the display cannot start or dies,
127 when the requested command cannot start, and 143 when interrupted.

**Size and rendering.** Start with the default job size, **4 GiB and CPU size 2**, and one browser at a time.
Docker and Podman use CPU size as a weight, not a two-core ceiling. The fixed pid limit is 512; `/dev/shm` is
half the job's memory, at most 1 GiB, and counts toward the same memory limit. On Docker 29.8.2 / Linux arm64,
the offline Chromium fixture peaked at 878 MiB and 135 tasks; Electron at 260 MiB and 115 tasks (cgroup v2
`memory.peak` and `pids.peak`, including cache and the probe, without pi or your dev server). These are observations,
not minimum sizes or a guarantee for a suite. Size the project for the runner, dev server and browser together;
limit test parallelism explicitly using `PI_JOB_SIZE_CPUS` where appropriate ([sizing.md](sizing.md)).

The pinned Playwright adds `--disable-dev-shm-usage` for both Chromium and Electron. These measurements therefore
use its `/tmp` fallback and **do not prove** a suite using `/dev/shm` fits. Increasing memory above 2 GiB does not
increase `/dev/shm` above 1 GiB. Reduce concurrent pages, use the tested fallback, or measure the workload. No GPU
is passed through; the fixture proves software-rendered text and page interaction, not WebGL or video acceleration.

**Doctor.** `pi-dispatch doctor --live` checks every distinct configured image/venue pair declaring `display`,
including `run.image` overrides, in that venue's image store. It runs at the **deployment default size**, printed
with the result, not every project's size. Its job-user decision is made for that image. It uses the worker's
container builder, fixture mounts, an empty host-provided environment and no network or credentials. It clicks a
local page, waits for the changed state, checks decoded PNG colors and text-region contrast, and verifies the PNG's
size and digest on the host after stopping the container's writers. A browser exiting zero or a nonempty file is insufficient. This detects a blank image;
it does not perform OCR or certify the appearance of your own application. The image remains trusted code.

Plain doctor starts no display probe. An image without the capability is not probed. A declared display that
fails makes doctor exit 1; an unavailable venue is explicitly unverified. Doctor removes the PNG with its fixture;
the smoke commands above save a copy for you to inspect, and CI uploads its screenshots as artifacts. The default
image does not advertise `display`, so enabling the recipe is an explicit image choice.

| Venue | Evidence and limits |
|---|---|
| Docker (`local`) | Chromium and Electron verified on Docker 29.8.2, Linux arm64 (OrbStack), and on the Linux amd64 [required image CI lane](https://github.com/edgehero/pi-dispatch/actions/runs/44182259226/job/134389555366). Both PNG artifacts were inspected for legible text. Removing Xvfb produces the named failure. |
| Native rootless Podman (`podman`) | Headed Chromium verified on Podman 4.9.3, Linux amd64, with a worker uid of 1234 ([CI measurement](https://github.com/edgehero/pi-dispatch/actions/runs/44182259244/job/134389381228)). The same doctor probe uses `buildPodmanRunArgs`, the decided uid, keep-id, resource bounds and private mount relabelling. The PNG artifact was inspected for legible text. Electron is not measured on this venue. |
| Rootful Podman through its Docker API (`local`) | Uses the local builder and doctor probe. Not measured for graphical applications here; run doctor on that host. |
| OpenShell (`openshell`, `openshell-bind`) | **Unsupported on pinned OpenShell 0.1.4.** Both actual adapters fail with `display-start-failed` and Xvfb's `XKB: Failed to compile keymap` ([CI measurement](https://github.com/edgehero/pi-dispatch/actions/runs/44182259319/job/134389382798)). The advisory lane checks this specific restriction in both modes. Doctor reports `venue-not-probed` for a declaring image; a Docker result does not attest to OpenShell. |

OpenShell 0.1.4's [child seccomp filter](https://github.com/NVIDIA/OpenShell/blob/v0.1.4/crates/openshell-sandbox/src/linux/child_seccomp.rs)
unconditionally denies `setgid` and `setuid`, including calls that keep the current identity. Xvfb's keymap
compiler launcher calls both before executing `xkbcomp`, and exits when either is denied. Reproducing those two
denials locally gives the same XKB failure; the CI fixture also checks the identity-preserving calls return
`EPERM`. This is a vendor restriction, not a missing font, CPU limit or writable-directory setting. There is no
per-trigger setting that lifts it. A vendor change permitting safe identity-preserving calls would need a fresh
graphical measurement; disabling seccomp is not part of this recipe. OpenShell also does not use the
Docker/Podman argv builder, so their shared-memory and pid figures cannot be assumed there.

| Symptom or probe reason | What to check |
|---|---|
| `display-start-failed`, or wrapper exit 70 | Xvfb is present and executable, its display socket can be created under `/tmp`, and the job has process/memory headroom. The wrapper waits for readiness for at most ten seconds. |
| `probe-missing` | The image declares `display` but lacks the executable `pi-display-probe`; rebuild the complete recipe. |
| `browser-start-failed` | Browser binary and shared libraries, readable browser cache, writable home and launch options. Sandbox errors require the inner `--no-sandbox` option, not changes to container privileges. |
| `page-check-failed` | The browser started but page interaction or viewport setup failed. Test the deterministic fixture before the application's suite. |
| `screenshot-invalid`, `probe-result-invalid` | The PNG or bounded result is missing, malformed, too large or inconsistent. A successful process exit is not a rendering pass. |
| `screenshot-blank`, `text-not-rendered` | The expected rendered regions or text contrast are absent. Check fonts and rendering; inspect the saved smoke image for tofu glyphs or unreadable text. |
| `probe-timeout` | Display/browser hung or the job lacked resources. Check task and memory pressure before increasing a timeout. |
| Browser crash, SIGBUS or page closed under load | Possible shared-memory exhaustion, but not proof of it. Check `/dev/shm` usage and whether the application's flags use Playwright's `/tmp` fallback. |
| Exit 137, OOM evidence, or process/thread creation refused | Check the container's memory events and pid bound. Increase the existing project memory size or reduce suite parallelism; do not remove the bounds. Exit 137 alone does not prove OOM. |
| `container-start-failed`, `probe-infrastructure-failed`, `venue-not-local` | No rendering verdict was obtained. Check runtime availability, job-user eligibility and fixture access on the worker's own host. |
| `probe-cleanup-failed` | The container could not be removed. The host does not read its screenshot and retains the fixture until the container is gone; follow the printed cleanup command. |

## Wire it up

1. **Build or pull it on the machine running the worker.** Jobs launch with `--pull=never`, so the worker
   will **never** fetch an image at job time. This is on purpose: an image name is per-trigger config, and
   a typo must not become a silent pull-and-execute of whatever answers to that name in a registry.
   `pi-dispatch up` will do the pull for you (consent prompted per action), but **only for the deployment
   default**, and only when it is absent. With `PI_JOB_IMAGE` unset that is `ghcr.io/edgehero/pi-job:latest`,
   tagged `pi-job:latest`. With `PI_JOB_IMAGE` set (in your shell or in `.env`), it is exactly the image that
   names, pulled under that name with no tag, and `up` prints which image it checked. A short name with no
   registry host (`pi-job:2.1.0`, `my-job:dev`) is never pulled, since a public registry would answer for it,
   and neither is a `localhost/` name, which is one built on the host: build or `docker tag` it on the host, or
   set `PI_JOB_IMAGE` to a registry-qualified name. It never pulls a
   trigger-named `run.image`, and `doctor --fix` does not offer to either. Each custom image is a per-flow
   trust posture you chose, so fetching it stays yours.
2. **Name it** in `triggers.json` as `run.image`.
3. **Check it**: `pi-dispatch doctor` lists every distinct image your triggers name, fails on one that is
   not present, and warns on one whose entrypoint does not look like the runner. It looks in the store the
   trigger's jobs start from: the Docker daemon's for `local`, and this account's own Podman store for the
   `podman` venue ([podman.md](podman.md)).

If the image is missing when a job is picked up, the job is refused **before** it costs anything — no
credential minted, no repo cloned, no budget slot burned — and the refusal names the tag.

Naming an image is an edit to the reviewed `triggers.json`. Neither the `/dispatch` panel nor any
model-callable tool will make that edit for you; the panel shows which image a trigger runs and nothing
more.

## What this project does not check for you

Presence, plus the three declarations an image makes about itself. Nothing computes a conformance **verdict**
from an image's contents at job time, and existence is not conformance. The exceptions are narrow and worth
naming so the boundary is legible: the pre-spend preflight reads those three labels, `doctor` sniffs an
image's entrypoint and warns when it does not look like the runner's `entrypoint.sh`, and `verify-image.sh`
(which you run yourself, on the host, deliberately) does start containers and grep the baked `HARD_RULES.md`.
Only the first of those three is on the job path, and it reads **labels**, not contents. An image you build
carries its own pi version, its own runner, its own guardrails floor and its own loader posture, and a label
is the image's **claim** about the first three, never a measurement of them. See `OQ-012` in
[`specs/open-questions.md`](../specs/open-questions.md) for the honest statement of that gap and what would
close it. Reporting a conformance verdict that had not actually been computed would be worse than reporting
none.

Managed forks require the `fork` image capability. The worker refuses an older image before spend as `job-image-fork-unsupported`. This capability covers `PI_FORK_ENTRY`, `PI_FORK_POSITION` and `PI_THINKING_LEVEL`; the image verification runs the baked branching module against an offline session fixture.

`approvalGates` declares the terminating `request_approval` tool and persisted decision replay. Gate jobs also require `exitAuth` so only authenticated runner metadata can park an approval. See [approval gates](approval-gates.md).

## pi 1.5.0 upgrade (issue #796)

This image pins pi 1.5.0. Deploy a job image built with pi 1.5.0 together with the updated worker, the image first
([the order](upgrading.md#the-order)); updating host pi alone does not change queued jobs' image. Three things change with pi 1.5.0:

- **Tool arguments are converted.** pi 1.5.0 validates a plain JSON Schema tool with TypeBox's full conversion, so a wrong
  type is quietly changed: `2.7` to `2`, `null` to `"null"`, one object to a one-item array. Every tool the runner defines
  refuses a wrong type before that happens and tells the model, so it can try again (`image/runner/src/exact-arguments.mjs`).
  **MCP tools are not guarded:** their schemas belong to their servers, so a job's MCP tool now receives the converted value.
- **OpenRouter costs are billed totals.** See [costs](costs.md#how-to-read-the-numbers). A job on a BYOK key now counts its
  upstream inference against the cost cap.
- **59 catalog models are gone and 58 are new.** A trigger whose `watch.decide` names a removed model now refuses the
  triggers file, and a job asking for one fails as for any unknown model. Check triggers and agents naming: Radius `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`; OpenRouter
  `openai/o1`, `openai/o3-mini`, `openai/o4-mini`, their `-high` variants, `openai/gpt-3.5-turbo` and `openai/gpt-4-turbo`.
  The rest are on Azure, Google, Hugging Face, Mistral, NVIDIA, OpenAI (`gpt-realtime-2.1`), OpenCode, the Vercel AI Gateway
  and other OpenRouter entries. `pi --list-models` on the image lists what is left.

A staged package whose `pi` object holds only metadata (`changelogPath`, a gallery image) now loads its `extensions/`,
`skills/`, `prompts/` and `themes/` folders; before 1.5.0 it loaded nothing. Doctor's skill lines follow the same rule.

A person who opens pi by hand in a sandbox runs it without `PI_OFFLINE`, as on 1.4.0: pi's model catalog refresh, version
and package checks and install ping are attempted, inside whatever the sandbox's [egress](sandbox.md#egress) allows. Set
`PI_OFFLINE=1` in that shell to turn them off. Jobs always run with it set, so nothing in a job installs or updates anything.

## pi 1.4.0 upgrade (issue #693)

Deploy a job image built with pi 1.4.0 together with the updated worker;
updating host pi alone does not change queued jobs' image. Verify the image digest and its conformance
checks before replacing your deployment's pinned image. The release notes must name pi 1.4.0.

The worker sets `PI_CODEMODE_MAX_WORKERS` from each job's resolved memory: one worker per 512 MiB,
rounded down, with a minimum of one. The default 4 GiB job gets eight; project memory overrides change
that count. Doctor displays the deployment default. This reserves at least half the memory outside
codemode's 256 MiB QuickJS heaps as a sizing heuristic; worker RSS can be larger, child pi processes have
separate pools, and the container remains the hard memory limit. Scripts can wait up to 60 seconds for
a worker, counted against their timeout. Trigger secrets and forwarded host settings cannot override
the count.

Beside it, every job carries its own size: `PI_JOB_SIZE_CPUS` (its CPUs rounded up to a whole number) and
`PI_JOB_SIZE_MEMORY_MIB` (issue #865). A CPU count read inside the container is not the job's size:
`nproc` reads the whole runtime on every venue, and with the job image's Node, on cgroup v2,
`os.availableParallelism()` reads the container's CPU limit rounded down, which on Docker and Podman is
the host's CPU ceiling (the same for every job) and on OpenShell is the size itself. Under one CPU (`0.25`
to `0.99`, which on OpenShell is the size) or on cgroup v1 it reads the whole runtime too. So an image or
a flow that sizes a worker pool (jest's `--maxWorkers`, vitest's `VITEST_MAX_FORKS`, `make -j`) should
read `PI_JOB_SIZE_CPUS` instead
([sizing](sizing.md#how-many-cpus-a-jobs-tools-see)). Both are information: the container's limits are
the bound, and trigger secrets and forwarded host settings cannot set either.

The overlay validator also accepts pi 1.4.0's `compat.imageInput` (`assets`, `images`, or
`state-image-urls`) and boolean `compat.sendImageOptInHeader`, and pi 1.5.2's booleans
`compat.requiresNonNullAssistantContent`, `compat.requiresToolsWithToolHistory` and `compat.supportsMessageThreads`
and `compat.promptCacheKeyMode` (`auto`, `enabled`, or `disabled`), with the types pi checks. Summary cost-cap behavior and Radius's
named refusal are documented in [costs](costs.md#pi-140-summaries-and-radius); resumed tool loadouts are
in [sessions](sessions.md#tools-on-resume).


## Watch isolation capability

`watch` declares the stricter watch loader, explicit read-only tool registry and deterministic classifier path. A
watch job on an image without it refuses before spend. `verify-image.sh` checks the real image with network disabled
and a zero dollar cap: a workspace extension's module body must never execute, only read/grep/find/ls and the trusted
board proposal tool are active, and a deterministic classifier writes its aborted result after the cost guard refuses
its first call. Neither probe calls a provider. The worker separately owns the read-only workspace mount. See
[Watch findings](watch.md).


## Isolated question grouping

`questionGrouping` declares the classifier-only job mode used by Zero touch. The worker refuses an image without
it before reserving a job or dollars. Its private `question-grouping.json` input is worker-staged, bounded and
read-only; the classifier returns a candidate slot and confidence in `question-group.json`, never a name, answer or
summary. The runner installs the normal model and cost guards before the call and returns before loading extensions
or creating an agent session. Its workspace is read-only. The capability's conformance smoke uses no network and a
zero cap, and verifies that no tool or extension executes.


`answerDraft` declares the restricted cited-draft profile: read-only workspace, trusted data readers/classifier,
no builtin or executable context, no posting or parent transcript promotion, and an authenticated structured-output
receipt. The offline image smoke proves input, tools and hostile/no-source refusal; an older image refuses such a
job before spend (`job-image-answer-draft-unsupported`). See [Answer rules](answer-rules.md).

`subscriptionAuth` declares access-only subscription snapshots, verified community adapters and final shaped
request guards. The worker requires it only for a provider owned by an explicit subscription binding; an older
image refuses before credentials, mint, clone or reservations (`job-image-subscription-auth-unsupported`). Its
offline image proof rejects an unverified adapter receipt, validates snapshot expiry and direct endpoints,
and exercises the final payload cost guard before any provider call. It also stages each pinned community
artifact and runs all three supported profiles through the image's normal entrypoint: a valid binding must
reach an initial cost refusal without dispatch, then a synthetic 429 transport verifies authoritative auth,
request shaping, bounded retry and signed subscription evidence. Every probe has networking disabled.
See [Subscription authentication](subscription-auth.md).

`subscriptionLease` (issue #895) declares that the runner accepts renewable subscription leases with a 60-second
expiry margin, instead of the earlier five-minute request cutoff. It is distinct from `credentialRefresh`: images
from before this change can apply replacements but cannot safely use the shorter lease contract. On `local` and
`podman`, the worker requires all three of `subscriptionLease`, `idleWatch` and `credentialRefresh`, a working renewal
path and a read-only drop before it uses a short lease. An image without the new capability keeps full-deadline
coverage. Update the job image with the worker and rebuild derived images on that base; an image label alone does
not update its runner. The offline proof checks a near-expiry request against the declared margin.

## File secrets

A derived image declaring `secretFiles` must verify `PI_SECRET_FILES` before discovering extensions or starting
pi. The comma-separated names point through environment variables to `/run/secrets/<NAME>` (OpenShell copy layout:
`/sandbox/secrets/<NAME>`). The directory must be owned by the job uid with mode `0700`; every file must be regular,
non-symlink, single-linked, owned by that uid, `0600`, and 1 to 65,536 bytes. Consume the flag before tools start.
Unsafe or missing delivery exits 2 with `secret-files-unusable`. Do not read values into the environment or normalize
newlines. The public verifier checks exact content, owner, mode, read-only delivery and early refusal using the
real runner, offline at a zero cost cap. An older image is refused before spend for jobs requiring this capability.
