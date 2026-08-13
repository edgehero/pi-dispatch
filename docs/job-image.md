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

**Pin the base if you would rather not track `latest`.** Every published build also carries the **product
version** as a tag (`ghcr.io/edgehero/pi-job:0.8.0`) and the git `sha`, and neither ever moves, while
`latest` follows `main`. The receiver image is tagged the same way. A pinned base is the honest choice for a
derived image whose layer assumes something about the base; the cost is that a pin does not pick up a
security rebuild, so bump it deliberately.

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
| Non-root runtime user with a **writable `~/.pi/agent`** | pi cannot write `auth.json`; EACCES inside the container, at run time, on a path no Dockerfile hints at | late, and cryptic |
| `ENTRYPOINT` is the pi-dispatch runner | An image that runs *something else* and exits 0 is recorded by the queue as a **completed job** that never started an agent | **silent** |
| Runner honours the exit-code protocol (0 done / 1 infra / 2 policy) | Node's default exit 1 on a policy failure makes the queue pay to retry work that can never succeed | late, and expensive |
| The **pinned pi version** (`CONST-PI-VERSION-PINNED`) | A stale pi turns every job into a no-op that reports success | **silent** |
| Guardrails at `/opt/pi-dispatch/HARD_RULES.md`, root-owned and agent-unwritable | An agent that can rewrite its own safety floor has none | **silent** |
| `PLAYWRIGHT_BROWSERS_PATH`, `PLAYWRIGHT_MCP_BROWSER`, `PLAYWRIGHT_MCP_SANDBOX` baked in | Frontend flows fail to launch a browser, or launch the wrong one | mixed |
| Fonts installed | Chromium renders tofu boxes: screenshots look plausible and contain no legible text | **silent** |
| The loader flags in `image/runner/src/loader.mjs` | **Security posture is per-image.** A deployment that turned repo-file discovery off for multi-tenancy in one image **has not turned it off in another** | **silent** |
| Label `dev.pi-dispatch.pi-version` = the pi the image actually carries | The worker reads it pre-spend and treats an absent one as **"never resume"**, the safe direction. Every `run.resume` job then cold-starts: correct, paid for in full, and invisible | **silent** (deliberately) |
| Label `dev.pi-dispatch.forges` = the forges this image can serve | An **exclusion** list. A label that omits a forge refuses that forge's jobs pre-spend (`job-image-forge-unsupported`); a label naming a forge whose CLI is *not* installed is worse than none, turning that refusal into a paid container that fails at step 3 | loud, pre-spend |
| Label `dev.pi-dispatch.capabilities` = the optional features it honours (`replicas`, `commands`) | An **inclusion** list. An image without the label is refused **every** replica job pre-spend (`job-image-replicas-unsupported`), because a floor that hard-codes `pi/issue-<n>` would make both replicas converge on one branch — and **every** `run.command` job pre-spend (`job-image-commands-unsupported`), because a runner that does not understand `PI_COMMAND` would feed `/name args` to the model as prose or die retryable on `no-terminal-message` | loud, pre-spend |

The two list labels have **opposite polarities**, deliberately: `forges` excludes, so no claim excludes
nothing and an unlabelled image is admitted everywhere; `capabilities` includes, so no claim includes nothing
and an unlabelled image is refused every replica or command job. One rule underlies both, that an image declaring
nothing gets no benefit of the doubt about what it contains, and neither costs an ordinary job anything.
`image/Dockerfile` declares all three, so a layer built on top of it inherits all three.

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
actually installed, and that `dev.pi-dispatch.capabilities` matches the baked guardrails. Those last two are
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

## Wire it up

1. **Build or pull it on the machine running the worker.** Jobs launch with `--pull=never`, so the worker
   will **never** fetch an image at job time. This is on purpose: an image name is per-trigger config, and
   a typo must not become a silent pull-and-execute of whatever answers to that name in a registry.
   `pi-dispatch up` will do the pull and the re-tag for you (consent prompted per action), but **only for the
   deployment default**: `ghcr.io/edgehero/pi-job:latest`, tagged `pi-job:latest`. It never pulls a
   trigger-named `run.image`, and `doctor --fix` does not offer to either. Each custom image is a per-flow
   trust posture you chose, so fetching it stays yours.
2. **Name it** in `triggers.json` as `run.image`.
3. **Check it**: `pi-dispatch doctor` lists every distinct image your triggers name, fails on one that is
   not present, and warns on one whose entrypoint does not look like the runner.

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
