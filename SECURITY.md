# Security Policy

pi-dispatch executes untrusted, adversarial input through an unrestricted coding agent, on purpose.
This document states plainly what that means, what is defended, and what is not.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository (Security → Report a
vulnerability). Please do not open a public issue for a security bug.

This is a solo-maintained project. Expect an acknowledgement within a week. There is no SLA and no bug
bounty. Fixes land on `main`; there is no backport branch.

## The threat model in one paragraph

Anyone on the internet can open a GitHub issue. Its text reaches a coding agent that runs with the
permissions of its process and holds credentials. pi has **no built-in permission system** — its own
README says so, and says to containerize it. Therefore: **the container is the security boundary**, and
every other control exists to keep that boundary meaningful or to bound what a successful attack gets.

Assume the issue body will eventually say *"ignore your previous instructions."* The design question is
not whether that happens, but what it costs when it does.

**Corrected 2026-07-16 — the answer is worse than this document previously claimed.** It said the cost
was *"one wasted job budget and one garbage pull request that a human declines to merge."* That assumed
the agent's token could not merge. **It can.** See *What is NOT defended*. On a repository whose default
branch is unprotected, one successful injection is a full compromise of that repository within the hour.

## Who this is for

pi-dispatch services **repositories you control**, and folders on your own machine. The trust model is
the same as `.github/workflows/`: **whoever can merge to your default branch can instruct the agent.**
It is not built to be installed on repositories you do not trust, and doing so is outside the model
below.

Jobs are a **trigger × target** matrix, and the triggers do not share a threat model:

| Trigger | Who can start a job | Undo |
|---|---|---|
| **GitHub webhook** — label, `@pi` comment, or PR activity | A collaborator. Applying a label is a permission **GitHub itself** restricts to collaborators, so the label doubles as the approval step; it is not a check we make. Comment and PR auto-action triggers are author-gated here. | Decline the PR |
| **GitLab webhook** — label, `@pi` comment, or MR activity | A project member with **Developer access or above**, resolved from the API on every delivery. The label is **not** the approval step — see below. | Decline the MR |
| **Forgejo webhook** — label, `@pi` comment, or PR activity | A collaborator with **admin or write** permission, resolved from the API on every delivery — labels included. | Decline the PR |
| **Azure DevOps service hook** — work-item tag, `@pi` comment, or PR activity | A **project member**, resolved from the Graph API on every delivery. A work item names the actor only by email address. | Decline the PR |
| **CLI** — manual run (`pi-dispatch run`) | Whoever has shell on the host / can run the CLI | Decline the PR, or **nothing** for a folder |
| **Cron** — a schedule | **Nobody, at the time it runs.** It fires unattended. | As above |
| **AI tool** — `dispatch_run` (operator session) | Whoever can prompt-inject the operator's model | **Nothing** — it enqueues a paid run that edits a folder in place |
| **Outbox chain** — a completed job container | A completed local job's agent, after host-side validation | As the folder row above — a same-folder follow-up, no undo |

## Trust boundaries

| Zone | Trust | Why |
|---|---|---|
| Issue/comment text | **None** | Anyone can write it |
| A serviced repo's `.pi/` on the **default branch** | **Maintainer-level** | It is read into the system prompt, from a pinned SHA, on purpose — same trust as `.github/workflows/`. Only someone who can merge can change it. |
| A serviced repo's contents on **any other branch** | **None** | A fork PR can contain anything. Never read for instructions. |
| A local folder's `.pi/` | **Whatever can write that folder** | No merge gate, no reviewer, no history |
| A trigger's `run.secrets` and `run.secretsProfile` | **Operator — the same trust as the triggers file, plus a host exec** | The references are named in the reviewed file; the resolver that reads them is a script the operator wrote and declared. The job receives VALUES and never a manager credential, so it cannot enumerate a vault, but it can spend what it was given. |
| A trigger's `run.skillsDir` and `run.instructions` | **Operator — the same trust as the triggers file** | Both are instructions, and both come from the reviewed `triggers.json` on the worker host rather than from any payload. Nothing reachable from a webhook, an issue or comment body, or `dispatch_run` can set either, and no panel key or AI tool writes them. The skills are copied per job into `/job` (adding no mount) and are layered UNDER the repo's own `.pi/`, so a serviced repo still wins a name collision; the instruction text lands in the user prompt above the issue text and never in the system prompt |
| The job image (`PI_JOB_IMAGE`, or a trigger's `run.image`) | **Operator — the same trust as baking it** | It *is* the code every job executes: the pi version, the runner and its exit codes, the guardrail floor, the loader's discovery posture and the non-root user all come from it. Nothing here verifies an image this project did not build. The isolation flags are applied by the worker's argv and hold for **any** image; the **contents** do not. |
| The job container | **None** — it is the untrusted side | It runs the agent |
| A job container's `/outbox` request file | **None** — agent-authored | An agent-initiated signal channel back to the host; validated host-side before anything is enqueued. **Local jobs only** — a github job has no `/outbox` mount at all |
| A job container's `/session` transcript | **None** — agent-authored | The **second** agent-initiated channel, and this row exists because the line above used to say "only". Written by the agent, read back host-side on a `completed` exit, `lstat`-checked and regular-files-only on both edges |
| A **resurrected sandbox**'s operator shell (`pi-dispatch sandbox`) | **Operator — the same trust as a terminal on this host** | A third channel, and the first the **operator** opens rather than the agent. Not a job container: no minted token, no provider key, no agent running, started only by a keypress. It re-mounts a finished run's workspace, which for a forge job holds attacker-influenced code — the same trust shape as checking out a stranger's pull request locally. Every isolation flag still applies; ports it publishes are `127.0.0.1`-only and last only while it does |
| The **venue** a job's container is built in (`run.backend`, `PI_BACKENDS`) | **Operator — the same trust as the daemon they point the worker at** | A different axis from every row above. Those ask *who wrote this*; this asks *who is holding the execution*. Today there is one venue, the Docker daemon on this host, so the answer is "the operator's own machine" and nothing changes. A venue that is not this host holds the container, the job's files, the provider key and the per-job forge token, and the isolation flags in **this worker's argv do not reach it**. What bounds it is a declaration an operator reads (`docs/backends.md`), a floor they can require of every blessed venue, and a boot refusal when the two disagree. |
| Receiver, worker, queue, admin extension | Trusted | They never execute agent-authored content — the admin extension feeds only PII-free, fixed-enum run records to the model; raw container output stays in the overlay viewer |

## What is defended

- **Who can trigger.** On GitHub, comment triggers require `author_association ∈ {OWNER, MEMBER,
  COLLABORATOR}`, and label triggers require an allowlisted label — since only collaborators can apply
  labels, **the label is the human approval step**, not a routing hint. A stranger's issue sits until a
  maintainer labels it.
  `pull_request` triggers split three ways, and the split is worth stating because one arm is not a check
  at all and another reads a *different field*. The **auto** actions (`opened`, `synchronize`, `reopened`)
  are hard-gated on the PR author's
  `author_association`, hard-coded and never config-optional, so a stranger's fork PR cannot launch a paid
  run. A `pull_request` + `labeled` trigger performs **no author check at all**, deliberately: the label
  predicate *is* the approval there, resting on the same GitHub permission the issue-label path rests on.
  And a `pull_request` + `review_submitted` trigger is gated on the **reviewer's**
  `review.author_association` — never the PR author's. That is not an inconsistency: the gate always asks
  whether the actor who caused the event has write access, and a submitted review is the first GitHub event
  where the actor and the PR author are different people. So a collaborator's review of a stranger's fork PR
  **does** start a job (the collaborator is the approving human), and a stranger's review of their own PR
  does not.
- **Who can trigger, and what a review trigger widens.** Arming `review_submitted` is a wider grant than
  any other GitHub trigger, and there are three things to know before you arm it.
  **It has no second gate.** A comment trigger needs its phrase and a label trigger needs its label, both
  typed on purpose by a human; a review needs only that the reviewer clears `author_association`. Every
  submitted review from anyone with write access starts a paid run, including a one-line "lgtm". Use
  `on.reviewState` (for example `["changes_requested"]`) to narrow which verdicts count. It narrows
  verdicts, not actors.
  **Other people's bots are outside the bot-loop guard.** That guard compares the sender against **our
  own** identity and nothing else, which is exactly right for the recursion it was built for: our flow
  pushes, `synchronize` fires, the guard breaks the loop. A third-party review bot — CI, a scanner, a
  code-review service — is a different actor, and such bots frequently hold `author_association: MEMBER`.
  If one reviews on every push while your armed flow pushes, the two form a spend loop **neither guard can
  see**, because each knows only itself. No comparable vector exists on the other triggers: bots do not
  apply your trigger labels and do not type `@pi`. The spend caps are what bound it; `OQ-020` records the
  residual and what would close it.
  **A Comment-type review of line comments only starts nothing.** Its remarks ride
  `pull_request_review_comment`, an event this service does not ingest, so the review arrives with an empty
  body and is refused as `no-review-body` rather than buying a container for an empty string. Approve and
  Request changes still fire with an empty body, since there the verdict is the signal, and `review.id`
  reaches the flow in `/job/event.json` so it can fetch the line comments itself. `OQ-021` records it.
- **Who can trigger, on GitLab — and why the rule is different there.** That reasoning does not hold on
  GitLab: the minimum role for managing labels has differed across versions, Ultimate's **custom roles**
  can grant it at any level, and **a Guest can set labels on an issue they are creating**, so a stranger
  can open an issue already carrying your trigger label. A GitLab label is therefore a routing hint and
  nothing more, and **every** GitLab trigger — labels included — is gated on the actor's API-resolved
  project `access_level >= 30` (Developer). Group-inherited membership counts; a lookup that cannot
  complete answers 503 and is redelivered rather than silently dropped. `OQ-013` records the residual:
  this gate depends on a network call, and on a role table that varies by version and edition.
- **Webhook authenticity, and what "authenticity" means per arm.** What holds **universally is the
  ordering**: the body is read as **raw** bytes, the delivery's credential is checked timing-safe, and only
  then is anything parsed. Without that ordering every other gate collapses, because the label and author
  checks would be reading fields from a body nobody authenticated.
  What the check *proves* differs by arm, and only two of the four authenticate the **bytes**. GitHub
  (`X-Hub-Signature-256`) and GitLab in `signature` mode (`webhook-signature`, 19.0+) **MAC the body**, so a
  modified body fails. GitLab in `token` mode (`X-Gitlab-Token`) and **both** Azure DevOps modes (HTTP Basic,
  or a static header) authenticate only the **sender**: they prove somebody knew a secret and say nothing at
  all about whether the body arrived as it was sent, so anyone holding that secret can compose an arbitrary
  delivery. On GitLab you declare which mode you accept and only that one is accepted, so a sender cannot
  choose the weaker gate: prefer `signature` where your instance supports it. Azure has no stronger mode to
  prefer (its own bullet below states the consequences). One implementation detail, recorded because the code
  records it: Azure's constant-time compare returns early on a length mismatch, so the secret's **length**
  leaks even though its content does not.
  The receiver may run **containerised** (`docker compose -f deploy/docker-compose.yml --profile receiver up`,
  issue #82; the `-f` is load-bearing, because that file's relative paths resolve against `deploy/` and not
  your cwd). That changes none of the
  verification above: it is the same code, the container mounts `triggers.json` read-only and **no docker
  socket**, and the worker stays a host process either way. It does change **where your secrets live**: the
  profile declares `env_file: ../.env`, so the operator's *whole* `.env` (every forge token and
  `WEBHOOK_SECRET`) is injected into that container.
  **Polling mode has no webhook surface at all** (`pi-dispatch-receiver poll`, issue #81): GitHub
  events are *fetched* over TLS with your own credential rather than delivered to a public port, so
  there is no signature to verify and nothing to forge against — the HMAC gate defends the webhook
  path; polling removes the path. Every author/label/bot-loop/dedup gate still runs, on the same
  fields, through the same pure filter. The cost is ~60s of trigger latency.
- **Isolation.** One ephemeral container per job: `--cap-drop=ALL`, `--security-opt no-new-privileges`,
  memory/CPU/pids limits, `--rm`, all from the worker's own argv, plus a non-root user which comes from the
  **image** and not the argv (see *What is NOT defended* for why that distinction matters). Per-job rather
  than per-session, so state cannot leak between mutually-untrusting issue authors.
  **An operator can re-open a finished run's sandbox** (`pi-dispatch sandbox`, `docs/sandbox.md`), and
  that does not weaken this: the *job* container is still single-use and still gone the moment it exits.
  A sandbox is a **new** container, built from the same argv builder so it carries every flag above by
  construction, holding **no credential of any kind**, started by an operator at a keyboard and never by
  a trigger, an agent or a model tool. What it re-mounts is the run's workspace, retained on the host for
  a bounded window (`PI_SANDBOX_RETENTION_HOURS`, 24h by default, `0` to disable). Its container name is
  outside the `pi-job-*` namespace the boot reaper clears, so a worker restart cannot kill it.
- **Credential scope.** A repo-scoped, short-lived token minted per job — a GitHub App installation
  token, or a single-owner fine-grained PAT. Its narrow scope and short expiry bound **where** and for
  **how long** an injected agent can act within that repo. See *What is NOT defended*.
- **CI integrity, on the App path or a narrowed PAT.** A GitHub App installation token grants `contents`
  and `pull_requests` write and **not** `workflows`, which is a separate scope; on a fine-grained PAT the
  same narrowing is an operator-set property. On those two sources an injected agent cannot rewrite
  `.github/workflows/` even though it can write code.
  **It does NOT hold under the shipped default.** `GITHUB_AUTH_SOURCE=gh` is the default, and it mints your
  own `gh auth token` **verbatim**: the whole operator login, which routinely carries the `workflow` scope.
  On that source an injected agent **can** rewrite your workflow files. `pi-dispatch doctor` lists
  `workflow` among the broad scopes it warns about by name, so that warning is your signal, and it is the
  only one you get. See *Operator responsibilities* for the same fact stated from the credential side.
  **What the App grants is also wider than `contents` + `pull_requests`.** The manifest this project mints
  asks for `contents: write`, `pull_requests: write`, `issues: write` and `metadata: read`. `issues: write`
  exists for the comment-back path (a job replies on the issue that triggered it), and it is real authority:
  with it an injected agent can close issues and edit or delete comments. The constitution's stated ideal
  (`CONST-TOKEN-SCOPED-PER-JOB`, "contents + pull-requests only") is **narrower than what ships**; this
  paragraph is that gap, written down.
  **It does NOT hold on GitLab.** A project access token needs `api` to post a note, and `api` grants full
  project API read/write; `write_repository` alone already permits pushing `.gitlab-ci.yml`. GitLab offers
  no contents-vs-CI split, so an injected agent on a GitLab job **can** rewrite your pipeline definition,
  bounded only by branch protection and by the human who reviews the merge request. If that matters to
  you, protect `.gitlab-ci.yml` with a CODEOWNERS-equivalent approval rule and keep the default branch
  protected.
- **Branch protection is required.** The worker refuses to run against a repository whose default branch
  is unprotected, checked before any money is spent. This is the control that makes human review real
  rather than customary — without it, nothing technical stops a merge.
- **System-prompt integrity, and the boundary that actually holds it.** A job's `/workspace` is **always
  the base repository at its default-branch SHA** — the worker resolves that SHA, fetches that one commit
  and checks it out detached. A pull request's branch is **never** checked out; its `head`/`base` travel
  as data. So everything in the workspace is **merge-gated**: only someone who can land a commit on your
  default branch can put it there. On that basis the repo's own `AGENTS.md` and `.pi/extensions` **are**
  loaded, which is pi's normal behaviour — see *What is NOT defended* for what that costs.
  Project instructions still arrive by a stricter route: the worker reads `.pi/` from the default branch
  at the pinned SHA, through git's object store (not the filesystem — a symlink would otherwise pull a
  host file into the prompt), and mounts it **read-only**, so the agent cannot rewrite mid-run the
  instructions it was given. Baked guardrails are read from a path the project cannot influence and are
  composed explicitly, so a repo's own `.pi/APPEND_SYSTEM.md` **cannot shadow the safety floor**. And the
  line that has not moved: **webhook issue, PR and comment text is data** — it goes in the user prompt,
  never the system prompt, whatever a repository's files say.
- **We never merge.** No code path in this project calls a merge API; grep is the test. Note carefully
  what that does and does not mean — see below.
- **Spend.** A daily cap checked *before* tokens are spent, a per-job turn budget enforced by our runner
  (pi has no turn limit of its own), and a 30-minute container wall-clock timeout. An agent that concluded
  "I can't fix this" is a success and is never blind-retried.
- **A policy refusal is never restarted into a second bill.** `pi-dispatch service` installs the worker as a
  user-level unit, and on all three platforms exit 2 (a determinate config or budget refusal) is excluded
  from restart: systemd's `RestartPreventExitStatus=2`, nssm's `AppExit 2 Exit`, and, because launchd's
  `KeepAlive` cannot exclude a single exit code, a wrapper that converts exit 2 into a clean exit so the unit
  stays stopped. Only infra failures are worth retrying; paying again for the same broken config is not. The
  `--system` scope **prints** a unit for you to install yourself: the command never executes a privileged one.

- **Azure DevOps webhook authenticity is weaker than every other arm's, and this is not a footnote.**
  Service Hooks offer no HMAC of any kind — only HTTP Basic or a static header — so the credential proves
  the sender knew a secret and says **nothing about whether the body arrived as it was sent**. Anyone
  holding it can compose an arbitrary delivery. Two things follow: the dedup key is read from the body
  (Azure sends no delivery-id header), and there is no signed timestamp and therefore no replay window, so
  a captured delivery replays as new paid work once the job key ages out. HTTPS is mandatory, the author
  gate still runs, and every money gate still applies — but if that trade is not acceptable to you, do not
  enable the Azure arm. `OQ-015` records the full reasoning.

## What is NOT defended (v1)

Stated openly rather than discovered later:

- **The agent's own token can merge, force-push, and delete branches — and no scope prevents it.**
  This is the sharpest thing on this page. Merging a pull request (`PUT /pulls/{n}/merge`), merging a
  branch directly (`POST /merges`), force-pushing (`PATCH /git/refs/{ref}`) and deleting a ref are **all
  gated by `contents: write`** — the *same* permission the agent needs to push the commit that is its
  entire job. GitHub offers no finer split. The container also ships `gh`. So "we never call merge" is
  true of *our* code and says nothing about what an injected agent does with a valid credential.
  **Branch protection on your default branch is the only technical barrier**, which is why the worker
  refuses to run without it. If you disable it, the honest worst case is: **one successful injection =
  full compromise of that repository within the hour**, including rewriting `.pi/` itself — which
  poisons every future job on that repo. That is standing compromise, not a one-shot.
- **Merge access to a serviced repo means code execution in its job containers.** This is the newest
  thing on this page and it is a deliberate trade. Because `/workspace` is merge-gated (above), jobs run
  with pi's normal discovery: the repo's `AGENTS.md` becomes part of the agent's context, and
  `/workspace/.pi/extensions` is **loaded and executed**. Anyone who can land a commit on your default
  branch can therefore run arbitrary code inside a job container — with the job's GitHub token and
  network egress bounded only by the allowlist you configured, which necessarily includes your forge —
  where previously they could only supply text the agent reads. What bounds
  it is the container, the token's narrow scope and short expiry, and your branch protection; **this
  layer bounds nothing**. The practical rule: a repository whose default branch you would not hand a
  shell to is not a repository to service. Note the population is the same one that could already write
  `.pi/`, which this harness has always read and obeyed — the escalation is from *instructions* to *code*,
  not from stranger to insider.
  **If you service repositories you do not control, turn this off.** There is no environment variable
  for it, deliberately: it is a two-line change in `image/runner/src/loader.mjs` (`buildResourceLoader`
  sets `noContextFiles` and `noExtensions` to `false`; set both to `true`) plus a rebuild **of every image
  you run** — with per-trigger `run.image`, this posture is per-image, so flipping it in one image does not
  flip it in another.
  `PI_GLOBAL_ALLOW_EXTENSIONS` is **not** this switch — it governs your own overlay's extensions and does
  not touch what the workspace discovers.
  One recursion case is closed rather than left to you: an extension that looks like this project's own
  admin surface — by name, or by registering a `dispatch_*` tool — is **dropped before the session sees
  it**, because a job that could call `dispatch_run` could enqueue paid jobs from inside a paid job. The
  honest limit is that the file has already been imported by the time it is dropped; the container is
  what bounds that. A side effect worth knowing: if a repo you service ships its own extension
  registering a `dispatch_*` tool, it will be dropped in job containers. The drop is logged; rename it.
- **A job image this project did not build is not verified, and per-trigger images make that reachable per
  flow.** A trigger's `run.image` names the container its jobs run in; absent, they run `PI_JOB_IMAGE`.
  Whichever it is, the *isolation* holds: `--cap-drop=ALL`, `--security-opt no-new-privileges`, the
  memory/CPU/pids limits, `/job` read-only, the closed env allowlist and the mount set (four mounts, five
  once `run.resume` is armed, and `run.skillsDir` adds none: its skills are copied into the per-job dir and
  ride the `/job` mount that already exists) are all built by the worker's `docker run` argv, so nothing an
  image contains can weaken them. **Non-root is not in that argv.** It is `USER pi` in the image itself, as the trust table
  above says, and that is exactly why an unconformant image can lose it: `docs/job-image.md` requires a
  non-root runtime user with a writable agent dir, and nothing here verifies that the image you named
  honours it. What is **not** checked is the image's contents, and every way that can be wrong fails
  **silently**: absent guardrails at `/opt/pi-dispatch/HARD_RULES.md` remove the safety floor with no error;
  a stale pi turns jobs into no-ops that report success; wrong exit codes make the queue pay to retry work
  that can never succeed; and the loader flags above are **per image**, so a multi-tenant deployment that
  turned discovery off in one image has **not** turned it off in another. What bounds it: only an operator
  editing `triggers.json` can name an image (no tool parameter, no panel key, no settings-overlay key), and
  jobs run with `--pull=never` behind a pre-spend presence check, so the only images that can run are ones
  you built or pulled onto that host yourself. `docs/job-image.md` is the conformance checklist; `OQ-012` in
  `specs/open-questions.md` is the honest statement of what nothing here can check.
- **`run.replicas` multiplies budget reservations by N, and the caps are the only ceiling.** A webhook
  trigger on any forge carrying `run.replicas: 2` turns one delivery into two independent paid jobs — two
  containers, two token bills, two review requests. Nothing about that is a bypass: each replica reserves its own slot
  before its own tokens, so the daily, weekly and monthly caps still bound the blast radius exactly as they
  did — they simply divide by N, and a cap sized for one job per delivery now covers half as many
  deliveries. The field is a **file edit only**: no tool parameter, no panel key, no settings-overlay key,
  so nothing a model can reach turns your spend into a multiple. It is refused on cron/local triggers and
  alongside `run.resume`. Two residuals are stated rather than defended. On a **pull_request**-typed target
  the replicas share the review request's branch (a head branch on GitHub and Forgejo, a source branch on
  GitLab and Azure), and only the prompt asks them not to collide (`OQ-017`) — a **comment** trigger reaches
  that same state, since a comment on a merge or pull request routes to that target. And on
  gitlab/forgejo/azure the replicas hold the **same** operator-supplied token rather than N per-job scoped
  ones: only the GitHub App path mints per job, so a replica set there is N concurrent attempts against one
  credential on one target. `PI_CONCURRENCY` bounds how many are ever live at once.
- **Local-folder jobs have no gate and no undo.** No merge, no reviewer, no pull request to decline. The
  bar for writing the agent's standing instructions drops from "can merge to default" to "can write a
  file in that folder" — which includes anything you ever downloaded into it. If the folder is not under
  version control there is **no recovery path** from a bad run. Point this at folders you would be
  willing to restore from backup.
- **Scheduled jobs run unattended, and the queue's double-spend protection does not cover them.** A job
  produced by a scheduler is **exempt** from BullMQ's stalled-job limit for as long as that scheduler
  exists: a wedged run is re-processed — and re-paid — on every stall, indefinitely. Our per-job turn
  budget is the real backstop there, not the queue. Cron multiplies every other risk on this page by
  removing the human who would have noticed.
- **An egress allowlist bounds where an induced agent can send your environment; it does not prevent it.**
  Egress is **denied by default** now: every job runs on its own `--internal` network behind a hostname
  allowlist proxy, and a job the policy cannot serve is refused before it spends (`docs/egress.md`). That
  is a real narrowing and it is **not** a fix for this row, for a reason worth reading twice: **your forge
  is on the allowlist, because a job that cannot push has nothing to do**, and a repository is a perfectly
  good place to write a secret to. A successful injection still has somewhere to send things; it has fewer
  places. What actually bounds the damage is unchanged and is what it always was: the token's short expiry
  and narrow scope (`CONST-TOKEN-SCOPED-PER-JOB`), and a provider-side spend limit on the key. The list of
  hosts is also **yours**, and nothing here can enumerate what your own flows reach (`OQ-026`). You can
  return to open egress with `PI_EGRESS=0`; run this on hardware where that is acceptable.
- **A resolved secret is a secret the agent can read, and this feature does not change where it can go.**
  `run.secrets` reduces the KIND and the QUANTITY of what an injection can reach: a job holds the two or
  three values its trigger named rather than a credential that can read every secret you own, and the
  reviewed file enumerates them by name so a capability review stays true as the vault grows. It does not
  reduce the paths. The value enters the model's context on the first turn after it is read, the agent
  holds a write-capable forge token, and your forge is on the egress allowlist by necessity. What bounds
  the damage is what it always was: how narrow the thing you named is, and what it can do if spent.
  Two further exposures are worth stating plainly. Every environment value reaches the container as
  `-e NAME=VALUE` in the worker's own `docker run` argv, so under a default `hidepid` any local user can
  read it from `/proc/<pid>/cmdline` for the container's lifetime; that is already true of the provider key
  and the forge token, and a vault-managed value arriving there is new in kind rather than in mechanism.
  And a container's output is teed to the worker's stdout unconditionally, independent of
  `PI_CAPTURE_JOB_LOGS`, so under systemd a value the agent echoes reaches journald. Set
  `StandardOutput=null` on the unit if that matters more to you than watching jobs run.
- **The provider API key is broad.** Unlike the GitHub token it cannot be meaningfully scoped per job —
  the agent needs it to function. It is the one broad secret inside the container. **Set a spend limit
  on it.**
- **Captured job logs can contain issue and comment text (PII).** By default the worker writes only an
  id-only status record per job — `logs/<jobId>.json`, keyed on stable ids (the delivery GUID,
  `repo#issue`) and never on issue or comment bodies. With `PI_CAPTURE_JOB_LOGS=1` (opt-in, **off by
  default**) it also tees the container's raw stdout/stderr to `logs/<jobId>.log`, and that stream **can**
  carry issue/comment text. Both live host-side under `PI_LOGS_DIR`, are **never mounted into the job
  container**, and are **gitignored**; a boot-time sweep prunes them (`PI_LOG_RETENTION_DAYS`, `0` = keep
  forever). Leave capture off unless you need it, and treat the log directory as personal data while it is on.
- **Prompt injection is not prevented, only bounded.** Untrusted text is kept out of the trusted region
  of the prompt by *placement*, not by filtering — content-filtering natural language is not a security
  boundary and this project does not pretend otherwise. The bound is the container, the scoped token,
  branch protection, and the human merge gate.
- **A project's own instructions can argue with the guardrails.** The baked safety floor cannot be
  *deleted* from the prompt — that is asserted by a test. It can be *contradicted* by a project persona,
  because prompt ordering is not an enforcement mechanism. This is the same honesty as the point above:
  what stops a merge is branch protection, not a sentence telling the agent not to.
- **The host Docker daemon is trusted, and so is the worker.** A container escape is a full compromise.
  The worker drives the Docker CLI, so a compromise of the worker process — or of its dependency tree —
  is root-equivalent on the host. The worker never reads issue text (that is the agent's job, in the
  container), so this is a supply-chain risk, not an injection one. Keep Docker patched; do not run this
  on a host you care about.
- **No multi-tenancy.** This is a single-operator tool. Nothing isolates one operator's jobs from
  another's, because there is only meant to be one. This is also the assumption the discovery posture
  above rests on: it is safe when the repositories you service are ones whose default branch you or your
  collaborators control. A deployment servicing repositories owned by mutually-distrusting third parties
  needs discovery turned back off **and** the GitHub App token path, neither of which is the default.
- **An agent that can write a folder can self-authorize a flow by committing to it.** Making a flow
  AI-triggerable is a committed `ai-trigger: allow` in the folder's `.pi/`, so an agent that can write the
  folder can commit that opt-in. Be precise about what that buys, because the obvious reading is wrong: the
  gate is read **only** by the AI-initiated paths (the `dispatch_run` tool, and a job's own outbox chain
  request), so what a planted opt-in buys an attacker is a **later AI-initiated run** of that flow, the kind
  a prompt injection in the operator's session could reach. The operator's own path skips the gate entirely,
  because typing the command *is* the approval, so an operator or CLI run of that flow never needed an opt-in
  at all. It is bounded by the local trust model ("whatever can write the folder can trigger it") and by the
  **pre-agent SHA** the gate reads at: the SHA forecloses self-authorization within the **same** job and
  its own children, but it does **not** stop a later AI-initiated run of the planted flow. Both halves
  hold; neither is undo.
- **A prompt injection in the operator's session can invoke `dispatch_run` — a paid run with no undo, and
  it is NOT money-safe.** `dispatch_run` is a **third** model-callable tool alongside reads and
  `pause`/`resume`, and unlike them it spends money editing a folder in place with no undo — an explicit
  break from the pause/resume "money-safe" framing that governs the other tools. It is bounded in
  blast-radius, not prevented, by **six** independent limits: the folder allowlist `PI_DISPATCH_RUN_ROOTS`
  (realpath + containment); the committed per-flow opt-in (default deny, read at a pre-agent SHA); the
  dirty-tree refusal (no force option); no spend-knob parameters on the tool; a per-hour rate limit; and
  the daily cap (`CONST-BUDGET-BEFORE-TOKENS`).
  One supporting fact about that allowlist, because `/dispatch setup` writes a file that could otherwise
  widen it: the **deployment pointer** resolves paths only, through an allowlist of exactly six path/URL
  keys. `PI_DISPATCH_RUN_ROOTS` is excluded **by construction**, as is every credential-shaped key, because a
  pointer that could widen the AI-run folder allowlist would be a second, unreviewed door to the very
  capability this bullet is bounding. Anything else in the file is dropped silently, and the pointer never
  overwrites a variable you exported yourself.
  Do not read `dispatch_run` as money-safe or reversible — it is neither.

- **A resumed session hands one job's transcript to the next job on the same key.** With
  `"resume": true` on a trigger, the agent's full working history — tool output, file contents, its own
  reasoning — is written to `PI_SESSIONS_DIR` and replayed into the next job for the same repository and
  head branch. It is **off by default**; turning it on is consent to persist that material. The key is a
  **branch name**, and branch names are chosen by anyone who can push to the base repository — so the
  population that can be handed a transcript is your repository's push-access population, not the issue's
  author. **A fork pull request never resumes anything**, which is what stops a stranger naming a branch
  `pi/issue-7` and being handed issue 7's history. Two consequences worth stating because they are not
  obvious. With egress bounded only by an allowlist that must include your forge (above), a single later
  job on that key can exfiltrate the whole
  accumulated history in one request, where before it could only exfiltrate its own view. And a review
  comment now arrives into a conversation that already contains the previous author's text in the
  assistant's own voice — an injection that failed the first time gets a second, better-placed attempt.
  **Do not arm `run.resume` on a multi-tenant deployment** — one servicing repositories whose push access
  you do not control. That is the same carve-out context discovery carries, for the same reason, and it is
  doctrine rather than a mechanism: nothing in the harness can tell a multi-tenant deployment from a
  single-tenant one. `OQ-014` ratifies the risk **only** for the case where you control, or trust, who can
  push to the repositories you service.
  Store transcripts on a disk you would put issue text on, mode `0700`, with the shortest
  `PI_SESSIONS_TTL_DAYS` you can work with, and **check that `PI_SESSIONS_DIR` is outside any repository
  you commit** — the shipped `.gitignore` covers the conventional layout and cannot cover a path it has
  never seen. `PI_SESSIONS_TTL_DAYS` alone does not bound a lineage an operator actually uses: it reads
  the transcript's mtime, which every **completed** run refreshes, so a pull request that keeps getting
  work done on it never ages out however far back its first turn goes. `PI_SESSION_MAX_AGE_DAYS` bounds
  the conversation itself.
  **Read what that bound is and is not.** It reads a timestamp on the transcript's first line, and the
  agent owns `/session`, so the value it judges is one the agent wrote. Against an ordinary long-running
  lineage it does what it says. Against an agent that wants its history to survive, it does not: the same
  agent can restamp the header every run, and can carry content across runs in the file regardless of
  what any of these bounds decide. Treat all three as operating limits on how much history accumulates by
  accident, not as controls on an adversary who already has code execution in the container. The bound
  that is not agent-writable is `PI_SESSION_MAX_RESUME_CHAIN`, which counts the host's own deliveries.

## Operator responsibilities

- **Protect your default branch.** Require a pull-request review, forbid force-pushes. This is not a
  suggestion — it is the only technical control standing between an injected agent and your `main`. The
  worker refuses to run without it, and you should not work around that.
- Set a provider spend limit and a daily job cap.
- Do not blanket-forward host environment into job containers. Pass only the variables the configured
  provider needs. In particular `ANTHROPIC_OAUTH_TOKEN` silently takes precedence over
  `ANTHROPIC_API_KEY`, so a stray variable in the host environment can quietly redirect which credential
  a job spends. Every minted-token name is refused in `PI_FORWARD_ENV` at config load, across all four
  forges: `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN`, `FORGEJO_TOKEN`, `GITEA_SERVER_TOKEN`,
  `AZURE_DEVOPS_EXT_PAT` and `SYSTEM_ACCESSTOKEN`. The worker sets them from the per-job mint, and a
  forwarded operator token would silently override it. That list is derived from one row per forge rather
  than hand-maintained, so a forge added to the mint cannot be missed here. If a secrets manager supplies
  the worker's environment, its own credential belongs on the host and never in `PI_FORWARD_ENV`: a token
  that can read every secret in your project is a worse thing to hand an agent than the two credentials a
  job already carries (`docs/secrets.md`).
- **An `--env-setup` script is a boot-time exec as the account that holds every credential this
  deployment has.** `pi-dispatch service render|install --env-setup <path>` records a file the service
  manager **sources at every boot**, as the service user, with the deployment's environment — so
  whoever can write that file, or the directory holding it, owns the worker. Keep it writable by
  nobody but the account the unit runs as, and keep it out of any repository you push: it holds no
  secret by design, but it holds the commands that fetch them, which is a map to all of them.
  `pi-dispatch doctor` warns on all three (gone; group- or world-writable; in a work tree that does
  not ignore it) and offers no `--fix` for any of them — it will not `chmod` your file and will not
  move it. The path can only ever be named by an operator typing the flag: never `.env`, never a
  trigger file, never the panel (`docs/secrets.md`). **That sentence is about the `--env-setup` script
  specifically**, and a second, narrower exec now exists: see the next bullet.
- **A secret resolver is a host exec of the same trust class, reached two ways this document once
  reserved for the flag alone.** `PI_SECRET_PROFILES` names resolver scripts in `.env`, and
  `/dispatch secrets add` can name one from the panel. Both run as the account the worker runs as, and
  that account holds every credential this deployment has, so the blast radius is the `--env-setup`
  script's and not a smaller one. Boot-time versus job-time is a difference in timing, not in power.
  What bounds it instead: the panel path is fail-CLOSED (`PI_SECRET_RESOLVER_ROOTS` is empty by default,
  so the panel can declare nothing at all until an operator names the directory), the worker re-checks
  every panel-declared path against those roots on the realpath rather than trusting the settings file,
  and a trigger names only a profile NAME, never a path. A deployment that never sets
  `PI_SECRET_RESOLVER_ROOTS` keeps the guarantee above intact, byte for byte.
- **With `GITHUB_AUTH_SOURCE=gh` (the default), your entire gh login reaches every token-carrying job.**
  The minted value is your own full-scope `gh auth token`, and `pi-dispatch doctor` warns and names the
  scopes it carries (calling out broad ones like `admin:org`, `delete_repo`, `workflow`). Prefer a
  fine-grained PAT — or an App — for real per-job scoping. Your `~/.config/gh` is never mounted into a
  container; the credential reaches jobs only as env values.
  **`pi-dispatch setup github` makes the App path the easy one** (issue #81): the GitHub App Manifest
  flow mints the app id, private key, and webhook secret in one browser click, against a throwaway
  listener on **your own loopback** — nothing crosses a maintainer-controlled service, the conversion
  code is single-use and expires in an hour, and the wizard shows every `.env` line before writing it,
  never prints a secret, writes the PEM `0600`, and refuses to overwrite an existing key file or an
  already-set `WEBHOOK_SECRET`. The credential minted is the narrowest this system supports
  (`contents`/`pull_requests`/`issues` write + `metadata` read, per-repo 1h installation tokens).
- **On GitLab there is no stronger option to prefer.** GitLab has no App equivalent and no short-expiry
  per-job token, so your project access token is what every GitLab job gets, for as long as you leave it
  valid. Use a **project** token rather than a group token (a group token reaches every project in the
  group), give it the shortest expiry you will tolerate re-minting, and rotate it — the expiry bound is
  yours to enforce, because nothing on GitLab's side enforces it for you. `pi-dispatch doctor` says so
  when your triggers name GitLab. A GitLab token is exported to containers only as `GITLAB_TOKEN` /
  `GL_TOKEN`, never under the GitHub names, and your `~/.config/glab` is never mounted.
- **By default the worker sources the provider key from pi's `~/.pi/agent/auth.json` when the env has none.**
  It is a host-side read env-injected into the container — never a credential file mounted in — and accepts
  **API-key** logins only; an OAuth/subscription login is refused. The env always wins when set; set
  `PI_AUTH_FROM_PI=0` to force env-only (fail loudly on a missing env key rather than fall back to a pi login).
  Prefer an API key with a provider-side spend limit for an unattended service; a subscription token is
  neither refreshable in the container nor intended for automation.
- **Treat `.pi/`, `AGENTS.md` and `.pi/extensions` on your default branch as production code**, because
  they are: `.pi/APPEND_SYSTEM.md` and `AGENTS.md` reach the agent's prompt, and `.pi/extensions` is
  **executed** in job containers. Review changes to them with the same care as `.github/workflows/` — and
  note the review *is* the gate, since landing a commit on the default branch is the only qualification
  any of it requires.
- **The global pi overlay (`PI_GLOBAL_PI_DIR`) is production code too**, and it must be credential-free. It
  is mounted `:ro` into every job — a container that runs adversarial input — so a secret in it is a secret
  in the box. Stage it with `pi-dispatch import-pi` (it refuses a `models.json` with a literal key and never
  copies `auth.json`) and let `pi-dispatch doctor` re-check it; the provider key belongs in the environment,
  never a mounted file. Overlay **extensions run arbitrary code against adversarial input, reaching
  whatever your egress allowlist permits** (which includes your forge), and are not scanned for secrets —
  and they are staged and loaded **by default**. `import-pi`
  copies `extensions/` unless you pass `--no-extensions`, and **prints every extension it staged**: read
  that list, because it is the vetting step. Anything you do not want in job containers should not be in
  the overlay; `PI_GLOBAL_ALLOW_EXTENSIONS=0` disables the whole directory if you want it staged but
  dormant. Any other value than `0` or `1` is refused at boot rather than guessed — a typo must not
  silently leave extensions loading. Never place the admin extension in the overlay (it can enqueue paid
  jobs — a recursion vector; `import-pi` blocks it).
- **Every image you name in `triggers.json` is production code, and you are its build gate.** Pull or build
  it yourself on the machine running the worker — jobs launch with `--pull=never`, so nothing is ever fetched
  at job time and a name this host does not have is refused before the job costs anything. Hold it to the
  conformance checklist in `docs/job-image.md` (non-root with a writable agent dir, the runner as entrypoint,
  the exit-code protocol, the pinned pi version, root-owned guardrails, fonts, the loader posture), and run
  the `image` CI job against your own tag. `PI_JOB_IMAGE` and each `run.image` are **separate security
  postures**, not one: a carve-out you made in one image is not inherited by another. `pi-dispatch doctor`
  lists every image your triggers name and warns when one's entrypoint does not look like the runner — that
  is presence and a hint, never conformance.
- **Staged pi packages are third-party code you are choosing to run against adversarial input.** They live
  inside the same overlay and pass four gates: an **exact** version, either declared in `pi-packages.json` or
  captured from what your host has installed (a floating
  range turns a silent upstream release into every queued job becoming a no-op that still reports success),
  host-side staging by `import-pi --with-packages`, a **per-trigger** `"packages"` switch — an **opt-OUT**,
  so once staged they load for every job and `"packages": false` on a trigger is how one flow declines
  them; there is deliberately no env flag deciding it fleet-wide — and runner-side validation: a
  package that did not mount is refused before any spend, and a package skill that takes the name of a repo
  or overlay skill loses — the repo's stays in force, and the attempt is logged. Two facts to hold on to.
  Staging runs
  `npm install --ignore-scripts`: **without that flag a package's — and every transitive dependency's —
  lifecycle scripts would run AS YOU, ON YOUR HOST**, at stage time, which is a host compromise and not a
  job one; the price is that a package needing a build step is staged INCOMPLETE and may fail at run time
  (`import-pi` warns by name). And a package whose name looks like the dispatch admin is refused outright,
  the same recursion block the admin extension gets. Jobs run with `PI_OFFLINE=1` set unconditionally, so a
  package source can never become a network install from inside a container. Vet each one and pin it; you
  are extending your own trust boundary to whoever publishes it.
  Since issue #102 `--with-packages` also **discovers** the packages you installed with `pi install`, which
  widens what one command stages. It does not widen what is *permitted*: every gate above runs on a
  discovered package exactly as it does on a declared one, discovery only ever adds candidates, and the
  printed list names each one with where it came from. Two consequences are worth stating plainly. The
  review surface moved: a version used to change only when you edited `pi-packages.json`, and now a
  `pi update` followed by a re-stage moves it with no diff anywhere, so the receipt's provenance field,
  `doctor`'s drift warning and that printed list are what stand in for the diff. And `doctor --fix`'s
  restage offer deliberately runs `--no-host-packages`: the only path that stages without you typing the
  command stays a repair, never a first-time import of your laptop into every job container.
- **A serviced repo's declared packages are NOT installed, and that is deliberate.** A repo's
  `.pi/extensions` execute (above), but nothing reads a repo's package list and installs it. Two independent
  reasons: a clone does not contain installed `node_modules` unless someone committed them, so honouring
  such a declaration would mean a job-time registry install, which `PI_OFFLINE=1` exists to make
  unreachable; and whoever can merge can already instruct the agent, while adding arbitrary npm packages
  would put third-party **install-time and load-time** code beside a live minted forge token in a container
  that can reach your forge. That is a materially bigger grant than editing a
  prompt. If it is ever wanted, the shape
  is an operator-held allowlist, not a per-repo opt-in, because the repo is the thing that is not trusted.
- **Token and cost accounting is process-wide, but it is not process-tree-wide.** The recorded totals cover
  every session inside the job container's Node process, including subagent sessions an extension spawns,
  and the per-job token budget is enforced against that total. A staged package that spawns a **`pi`
  subprocess** is outside it: those tokens are spent, billed, and absent from the run record and the daily
  token counter. `PI_MAX_TURNS` likewise bounds only the root session's turns. The backstops there are the
  30-minute container timeout, the job-count caps, and your provider-side spend limit — not the meter.
- **The admin surface is not a network service.** It is a pi extension in your own terminal session plus
  a `settings.json` file — it binds no port. Whoever can run pi with the extension loaded, or write
  `PI_SETTINGS_FILE`, holds operator power: the same trust as shell access on the host. Treat it that way.
  It is operator-present, processes no adversarial input, and holds no harness credentials — which is why
  pi running here is scoped out of the container-per-job constraint. Raw job logs are untrusted container
  output, and the extension never routes them into model context.
  **It does, however, install and execute host software.** `/dispatch setup` is the guided path and it is not
  read-only: it runs `npm install @edgehero/pi-dispatch@<pinned version> --ignore-scripts --omit=dev` into a
  directory you name, then spawns that runtime's own CLI (`up`, `service install`, `setup github`) attached to
  your terminal. Each of those sits behind a confirm showing the exact command and directory first, nothing
  is auto-accepted (the child's own y/N prompts still run), and the install is followed by a hard-stop
  assertion on the installed version, because npm has reported success over a wrong or absent install before.
  `--ignore-scripts` is load-bearing here exactly as it is for `import-pi`: **without it the lifecycle scripts
  of that package and every transitive dependency would run AS YOU, ON YOUR HOST**, at install time, which is
  a host compromise and not a job one. So: no port, no harness credential, and still the same trust as shell
  access, which is where `/dispatch setup` stops being theoretical.
- **The graph export writes one static HTML file, on your keystroke, to a temp path it names.** What
  crosses into it: trigger configuration you authored, skill names and frontmatter from the repos you
  service, and the PII-free run-record fields the panel already shows. What never does: raw job log
  bytes, issue or task text, session material, or a host path beyond a folder's basename unless you
  pass `--full-paths` yourself (your own reviewed `run.folder` config, on your keystroke). Nothing
  listens and nothing serves the file — opening it is a local browser reading local bytes, and the
  page makes no network request of any kind. The browser spawn is best-effort, skipped and announced
  over SSH or without a display; the printed `file://` URL is the contract.
- **The dashboard writes to your terminal's clipboard only on your keystroke.** The `y`/`Y` copy keys in
  the run drill-in emit an OSC 52 sequence — the standard way a terminal application hands text to the
  local clipboard, including over SSH. What crosses is a host-assigned job id or a target URL derived
  from id-only fields, never log bytes or issue text; nothing is ever read back from the clipboard; and
  the sequence is emitted only in direct response to the keypress, through the same injected seam
  discipline as every other side effect. Run-target hyperlinks (OSC 8) are display-only escapes carrying
  the same id-derived URLs.
- Review every PR. Automation opens them; it does not land them.
- Point local-folder jobs only at folders you can restore.
- Keep the pinned pi version current, and let the upgrade tests gate the bump.

- **With sessions enabled, "the credential reaches jobs only as env values" stops being the whole story.**
  An env value lives in container memory and dies with the container. A **session transcript is a file**,
  and any command the agent ran that echoed its own authorization header put your token into it,
  permanently, on your disk, where the next job on that key will read it. Under `GITHUB_AUTH_SOURCE=gh`
  — the shipped default — that token is your entire `gh` login and it does not expire. **Prefer the App
  path or a short-expiry fine-grained PAT before arming `run.resume`**, so the exposure is bounded by an
  expiry rather than by whether an agent ever ran a verbose curl. On GitLab there is no stronger option to
  prefer, so the same warning applies with no mitigation beyond rotating the token.
- **`PI_SESSIONS_DIR` is a PII store, and it has no default.** Unset means the feature is unavailable and
  a trigger that asked for it is refused before it costs anything — deliberately, so nobody ends up with
  transcripts in a temp directory they never chose. Put it on the same disk you would put
  `PI_CAPTURE_JOB_LOGS` output on, mode `0700`, outside every git repository, and set
  `PI_SESSIONS_TTL_DAYS` together with `PI_SESSION_MAX_AGE_DAYS`, which bound two different clocks: the
  first is time since the last run on a key, the second is the age of the conversation itself. Retention
  here is not disk hygiene: a stale transcript is a **live input to a future job**, so an old file is a
  correctness problem before it is a capacity problem.
  `pi-dispatch doctor` reports the store and warns whenever a trigger arms the flag.
