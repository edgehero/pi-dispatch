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
| **Forgejo webhook** — label, `@pi` comment, or PR activity | A collaborator with **owner, admin or write** permission, resolved from the API on every delivery — labels included. | Decline the PR |
| **Azure DevOps service hook** — work-item tag, `@pi` comment, or PR activity | A **project member**, resolved from the Graph API on every delivery. A work item names the actor only by email address. | Decline the PR |
| **CLI** — manual run (`pi-dispatch run`) | Whoever has shell on the host / can run the CLI | Decline the PR, or **nothing** for a folder |
| **Cron** — a schedule | **Nobody, at the time it runs.** It fires unattended. | As above |
| **AI tool** — `dispatch_run` (operator session) | Whoever can prompt-inject the operator's model | **Nothing** — it enqueues a paid run that edits a folder in place |
| **Outbox chain** — a completed job container | A completed local job's agent, after host-side validation | As the folder row above — a same-folder follow-up, no undo |
| **Priorities plan** (operator session tool or portfolio job) | Whoever can prompt-inject either | Revert in the panel. A plan starts no job: it moves spend between projects inside the operator's envelope, at most `maxStepPct` of the total per interval, never below a floor and never above the total |
| **Portfolio plan** (`/outbox/priorities.json`) | A completed portfolio cron job's agent: a cron trigger the operator flagged `run.portfolio` in the reviewed file, still flagged at pickup, at prepare and again when the plan is collected. A manual run, a chained child or a forge job is refused | Revert in the panel. The same bounds as the row above, and the same ladder; a refusal is recorded, never a failed job |

## Trust boundaries

| Zone | Trust | Why |
|---|---|---|
| Issue/comment text | **None** | Anyone can write it |
| A serviced repo's `.pi/` on the **default branch** | **Maintainer-level** | It is read into the system prompt, from a pinned SHA, on purpose — same trust as `.github/workflows/`. Only someone who can merge can change it. |
| A serviced repo's contents on **any other branch** | **None** | A fork PR can contain anything. Never read for instructions. |
| A local folder's `.pi/` | **Whatever can write that folder** | No merge gate, no reviewer, no history |
| A local folder's `.git/` (config, attributes, index, exclude list) | **Whatever can write that folder**, which includes the local job's own agent | The host reads the folder's dirty state before a local run (`pi-dispatch run`, the console, `/dispatch run`). That read never uses the folder's own git config, `info/attributes` or `info/exclude`, and clears the index's assume-unchanged and skip-worktree bits in a copy, so nothing in that directory runs on the host or hides uncommitted work from the guard. The operator's own global git config still applies |
| A trigger's `run.secrets` and `run.secretsProfile` | **Operator — the same trust as the triggers file, plus a host exec** | The references are named in the reviewed file; the resolver that reads them is a script the operator wrote and declared. The job receives VALUES and never a manager credential, so it cannot enumerate a vault, but it can spend what it was given. |
| A project's `secretBundles` entry and its bundle resolver (issue #704) | **Operator, the same trust as the triggers file, plus a host exec, plus whoever can write the manager the resolver reads** | The binding (project, profile, reference) is in the reviewed file; the variables are NOT. The resolver prints whatever the manager (or file) holds at each job start, so a variable added there reaches the next job of the project with no review of `triggers.json`. The job still receives values and never the manager's credential. Trigger-made jobs only: never a chained child, a manual run or a fork pull request (unless `forkReviews`), and every run record lists the variable NAMES it received. |
| A trigger's `run.skillsDir` and `run.instructions` | **Operator — the same trust as the triggers file** | Both are instructions, and both come from the reviewed `triggers.json` on the worker host rather than from any payload. Nothing reachable from a webhook, an issue or comment body, or `dispatch_run` can set either, and no panel key or AI tool writes them. The skills are copied per job into `/job` (adding no mount) and are layered UNDER the repo's own `.pi/`, so a serviced repo still wins a name collision; the instruction text lands in the user prompt above the issue text and never in the system prompt |
| The job image (`PI_JOB_IMAGE`, or a trigger's `run.image`) | **Operator, the same trust as baking it** | It *is* the code every job executes: the pi version, the runner and its exit codes, the guardrail floor, the loader's discovery posture and, where the argv carries no `--user` (Docker Desktop, or a worker running as uid 1001), the non-root user all come from it. Nothing here verifies an image this project did not build. The isolation flags are applied by the worker's argv and hold for **any** image; the **contents** do not. |
| The allocation envelope (`PI_ENVELOPE_FILE`) | **Operator, the same trust as the scoped-limits file** | It bounds what a priorities plan may move: the total, the floors and the step. The worker refuses to boot when the file lies inside any path a job container can see, and re-checks that at every reload, keeping the last good envelope when it fails; a local job's folder is re-judged at prepare and refused when it resolves to the envelope's folder or above it. The plan itself, which is agent text, gets no trust |
| The job container | **None** — it is the untrusted side | It runs the agent |
| A job container's `/outbox` request file | **None** — agent-authored | An agent-initiated signal channel back to the host; validated host-side before anything is enqueued. **Local jobs only** — a github job has no `/outbox` mount at all |
| A job container's `/outbox/priorities.json` | **None**, agent-authored | A portfolio job's plan. Read host-side on a `completed` exit only, `lstat`-checked, opened with `O_NOFOLLOW` and `fstat`ed, at most 16 KiB, and judged by the same parser and ladder as the operator's own plan. Its `reason` text is never logged and never enters the run record |
| A portfolio job's `/job/portfolio.json` | **Host-written, read-only** | The facts the manager plans with. Ids, digests, integers, instants, enum tokens and operator labels (project ids and member labels as projects.json names them, a folder by its basename) only: no issue text, title, plan reason or path, because the next run reads it as facts |
| A job container's `/session` transcript | **None**, agent-authored | The **second** agent-initiated channel, and this row exists because the line above used to say "only". Written by the agent, read back host-side on a `completed` exit, `lstat`-checked and regular-files-only on both edges. Since #643 every job has one unless the worker sets `PI_LIVE_TRANSCRIPTS=0` (a non-resume job's is an empty live file in its own job folder, never promoted), and the worker also tails it during the run to publish a redacted copy to Valkey: parsed as data, redacted, escaped and capped before it leaves, never executed or fed to a model. Since #644 the worker also reads run progress from it (turns, steps, the tool running, and the phases a `report_progress` call names): display only, never trusted, since the agent can write any line into it ([Run progress](#what-is-not-defended-v1)) |
| The **checkpoint store** (`PI_CHECKPOINTS_DIR`, else `<PI_SESSIONS_DIR>/.checkpoints`) | **None** for its contents (agent-authored trees and transcripts); **Operator** for the directory | Since #645 a trigger with `run.recover` has its running jobs checkpointed into it: the job's whole workspace and its transcript, written by the worker from the host side, never mounted into any container. A recovery writes those bytes back into a new job's workspace, so a restore re-checks every path with the snapshot's own rules and then resets `.pi/`, `.agents/` and the root `AGENTS.md`/`CLAUDE.md` to the run's base commit, so nothing the agent wrote there loads as the repository's own; a repository with `.pi/extensions/` gets no recovery, because an extension's imports cannot be reset ([Durable runs](#what-is-not-defended-v1)) |
| A steer-armed job's **inbox** (`run.steer`, `pi-dispatch steer`, a phrase comment) | **Operator** for who may send from the host (whoever can run `pi-dispatch steer` against the deployment's Valkey, which is the queue's own trust); **Collaborator** (write access) for a comment, whose author passes the same forge author gate that starting a job takes, on a comment trigger that also set `run.steer`; **None** for the text, which reaches the agent as data | Since #646 a trigger with `run.steer` lets a message reach its running agent. The worker writes it into a per-job directory mounted **read-only** at `/inbox` (the agent can neither plant nor withdraw a message), framed as data with the same fence the issue text gets and with no operator authority, and the agent's receipt is counted only under a MAC keyed by a per-attempt key the agent cannot read. A collaborator's phrase comment on the job's issue or pull request is routed there instead of starting a job; an operator also sends from the console (the operator role, behind its session rules, the text never listed or audited) and from the `/dispatch` panel ([Steering](#what-is-not-defended-v1)) |
| A **resurrected sandbox**'s operator shell (`pi-dispatch sandbox`) | **Operator — the same trust as a terminal on this host** | A third channel, and the first the **operator** opens rather than the agent. Not a job container: no minted token, no provider key, no agent running, started only by a keypress. It re-mounts a finished run's workspace, which for a forge job holds attacker-influenced code — the same trust shape as checking out a stranger's pull request locally. Every isolation flag still applies; ports it publishes are `127.0.0.1`-only and last only while it does |
| The **venue** a job's container is built in (`run.backend`, `PI_BACKENDS`) | **Operator — the same trust as the daemon they point the worker at** | A different axis from every row above. Those ask *who wrote this*; this asks *who is holding the execution*. Today there is one venue, the Docker daemon the worker's docker CLI resolves, which is the operator's own machine unless `DOCKER_HOST` or a docker context points it elsewhere; the worker reads that answer at boot and before each job, logs a redirect, and a floor asking `credentialTransit=enforced` refuses one. It judges the endpoint's form, so a unix socket or loopback port that is really a tunnel to another machine still reads as this host. A venue that is not this host holds the container, the job's files, the provider key and the per-job forge token, and the isolation flags in **this worker's argv do not reach it**. What bounds it is a declaration an operator reads (`docs/backends.md`), a floor they can require of every blessed venue, and a boot refusal when the two disagree. |
| The **`openshell` venue's supervisor**, which holds a job's credentials (`credentialCustody: layer`, issue #684) | **Vendor code on this host, `asserted`, never `enforced`** | On `local` and `podman` the provider key, the forge token and a trigger's resolved secrets are in the job container's environment, where the agent reads them. On `openshell` they are not: per job the worker creates an OpenShell provider holding them (the values reach the `openshell` CLI through its own environment, never an argv or a file), and the agent's environment holds placeholders (`openshell:resolve:env:v<rev>_NAME`). OpenShell's supervisor, beside the sandbox, terminates TLS and swaps the real value in only in a request to a host the job's policy admits, a policy the worker generates from your allowlist and model endpoints and reads back. An injected agent that dumps its environment dumps placeholders, and `OQ-028`'s host-argv exposure is closed on this venue. The price: the values and the provider and forge plaintext now live in a vendor process, so a compromised supervisor holds everything the job held, bounded by the token's scope and expiry and your provider spend limit, not by trusting its code (`OQ-047`). Its gateway must be on this host (loopback or a unix socket), refused per job otherwise; `PI_EGRESS=0` refuses the boot with it, because its policy is the only path the credentials resolve through. A credential rotated mid-run does not reach a running job (jobs are bounded at 30 minutes). Since issue #730 the runner there runs under a READABLE node (the supervisor's broker must read the runner's memory to let it connect, which a non-dumpable one refuses), so the exit-line key the runner holds is kept from the job's tools not by the node's mode but by three things: OpenShell's workload seccomp (`process_vm_readv`, `ptrace`, `pidfd_getfd` denied), Yama for `/proc/<pid>/mem` (the worker refusing the venue before spend unless the host's `kernel.yama.ptrace_scope` is exactly 1, so the protection is never silently absent: 0 or unreadable and 2 or 3 are each refused by name), and `ulimit -c 0` in the entrypoint so a holder's core cannot carry the key (a file `core_pattern` writes nothing; a pipe `core_pattern` goes to a host-root handler outside the sandbox, which a tool cannot read). A tool can reopen a holder's steer-frame pipe and its stdout and so break or garble a steered job's messages or the worker's exit-line read, never forge a signed line without the key nor read the key (`OQ-047`) |
| The **`openshell-bind` venue's binds** (bind mode, issue #686) | **Worker-built read-only binds plus the sandbox policy, applied by vendor code, `asserted`** | Upstream says it plainly: "Bind mounts expose gateway-host files to the sandbox and can bypass workspace isolation and filesystem policy." So on this venue OpenShell's own filesystem isolation does NOT keep the agent off the job's host directories. What holds is the worker's side: `/job`, `/inbox` and the overlay are bound read-only (a write fails with EROFS, measured), every bind target is listed in the sandbox's filesystem policy (`read_only` or `read_write`, read back before the job starts), and no other host path of the job's is bound; the compute driver still mounts its own runtime and the supervisor's socket beside them, as it does for every OpenShell sandbox (vendor code, `asserted`). Because a sandbox outlives its exec, the worker deletes it and waits until the gateway no longer lists it before it reads the job's tree (60 s at most; a sandbox still listed then is named in the log, the run takes no recovery snapshot, and a completed run or a folder job is not run again), and a salvage of a lost attempt's tree waits the same way. `/workspace`, `/session` and `/outbox` are the job's to write, exactly as on `local`, and a folder job edits the operator's folder in place. The credentials, the network policy and the placeholders are the `openshell` row's, unchanged. Opt-in per host: the gateway refuses every bind until its gateway.toml allows them, and the worker refuses each job before it spends while it does |
| The operator console process (`pi-dispatch-console serve`) | **Operator, the same trust as the admin extension** | It runs as the deployment's account and writes through the same read-model funnels as the panel. It renders untrusted text (issue titles, and from #641 on run text) but only escaped, after the control-byte scrub, under a strict CSP and behind the operator role; it executes none of it and feeds none of it to a model. It listens on loopback or a 0600 unix socket, never on the receiver ([The operator console](#the-operator-console)) |
| The operator's browser | **Operator, while it holds a session** | A signed-in browser acts as the token's person. Every other page that browser opens, including one on another `localhost` port, is **None**: the console refuses its writes by origin, not by trust in the browser |
| The console tokens file (`PI_CONSOLE_TOKENS_FILE`) | **Operator, the same trust as the deployment's `.env`** | It says who may sign in. It holds sha256 hashes only, so a copy signs no one in, but whoever can WRITE it can add a person. The console refuses to start on one that is group or world accessible, a symlink or another account's; the pi extension guards it from its own session's `write` and `edit`; doctor fails it inside any path a job container can see (a local trigger's `run.folder` or `run.skillsDir`, a `PI_DISPATCH_RUN_ROOTS` root, `PI_GLOBAL_PI_DIR`) |
| The login-code drop directory (`console-login-codes/` beside the tokens file) | **Operator, the same trust as the tokens file** | `pi-dispatch-console link` and, since issue #708, `/dispatch console --link` write a one-time code's hash there (directory 0700, file 0600, 60 seconds, consumed by the first `unlink` that wins; the panel appends its audit row first). Whoever can write it can mint a login, which is why it must be the deployment account's alone, and why the pi extension guards the directory, every path under it, from its own session's `write` and `edit`, as it guards the tokens file |
| Receiver, worker, queue, admin extension, operator console | Trusted | They never execute agent-authored content: the admin extension feeds only PII-free, fixed-enum run records to the model; raw container output stays in the overlay viewer. The operator console renders untrusted text as data only: escaped, behind the operator role, and never in a list view |

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
- **What a trigger's agent can do, structurally (`run.excludeTools`).** A trigger may remove named
  built-in pi tools from its jobs' sessions, and unlike every behavioural line in the guardrails this
  one is **enforced by the session**: the excluded tools are filtered out of pi's tool registry at
  construction, so no extension call and no refresh inside the job can restore them, and every flagged
  job logs the active tool list read back so the fact is observable rather than assumed. The boundary
  is stated as plainly as the grant: this removes pi **tools**, never container capabilities (excluding
  `bash` does not remove the shell from the image; the isolation flags were always the worker's own
  `docker run` argv), and extension or custom tools are not excludable, so a genuinely read-only
  trigger also declines the staged packages (`"packages": false`). It is file-only like every
  capability field, no panel key and no AI tool, a chained child inherits its parent's exclusions, and
  a job carrying exclusions is refused pre-spend on an image too old to honour them
  (`job-image-exclude-tools-unsupported`) rather than allowed to fail open
  ([`docs/exclude-tools.md`](docs/exclude-tools.md)).
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
  The receiver may run **containerised** (`docker compose --env-file .env -f deploy/docker-compose.yml --profile receiver up`,
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
  memory/CPU/pids limits, `--rm`, all from the worker's own argv, plus a non-root user: on Docker Desktop, and
  for a worker running as uid 1001, the image's own `USER`; on a daemon that enforces bind-mount ownership the
  worker's own non-root uid otherwise, passed as `--user` so the job can use its own files (issue #341; see
  *What is NOT defended* for what each costs). Per-job rather
  than per-session, so state cannot leak between mutually-untrusting issue authors.
  **An operator can re-open a finished run's sandbox** (`pi-dispatch sandbox`, `docs/sandbox.md`), and
  that does not weaken this: the *job* container is still single-use and still gone the moment it exits.
  A sandbox is a **new** container, built from the same argv builder so it carries every flag above by
  construction, holding **no credential of any kind**, started by an operator at a keyboard and never by
  a trigger, an agent or a model tool. What it re-mounts is the run's workspace, retained on the host for
  a bounded window (`PI_SANDBOX_RETENTION_HOURS`, 24h by default, `0` to disable). Its container name is
  outside the `pi-job-*` namespace the boot reaper clears — containers *and* their networks, by the one
  prefix test both halves of that sweep now ask (issue #360; see *What is NOT defended*) — so a worker
  restart cannot kill it. The
  sandbox retention reaper does reach into the `pi-sandbox-*` namespace since issue #337, and only for the
  run's egress NETWORK, never a container: it takes one only when that run has no retained directory left,
  no running container and no container being created, which is what keeps it away from a session that is
  open or still starting.
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
- **A message into a running job is data, one way, and bounded** (issue #646, `run.steer`). A trigger must opt in,
  and only an attempt the worker could fully arm listens: a venue that binds mounts, an image declaring `steer` (a job
  on an image without it is refused before it spends) and `exitAuth`, and a Valkey client.
  - **Framed as data, with no authority.** The worker, not the job, builds the words the agent reads: a heading saying
    the message is data and not instructions, who sent it (a console token's name, the command line or the dispatch
    panel; a forge author only by user id and association, each held to a closed charset: a number, or on Azure
    DevOps a GUID or an `azid-` digest, never a login or display name), and the text verbatim inside the same fence the issue
    text gets, so a body holding backticks cannot close it. An operator's message carries no more authority than a
    comment: standing operator instructions live in the reviewed triggers file (`run.instructions`), so a leaked
    console token or a shell cannot rewrite a run's rules in flight. It is handed to pi as a custom message, never
    through pi's input path, so a message starting with `/name` does not run a prompt template or a skill. Before it
    is stored, characters a model reads and a reviewer cannot see are removed (the Unicode tag block, the zero width
    characters, the byte order mark), backtick look-alikes become real backticks so the fence grows past them, and
    malformed text (an unpaired surrogate) is refused.
  - **Read-only and one way.** The messages arrive as files in a per-job directory beside the job folder, mounted
    read-only at `/inbox`; the image check proves a write from inside is refused. The container gets no network
    path, credential or new process channel: the worker reads Valkey and writes files.
  - **Receipts the agent cannot forge.** The transcript is agent-writable, so a delivery counts only when its entry
    carries an HMAC under the exit key the worker minted for that attempt and handed to the runner on stdin (issue
    #545). A forged entry is ignored and logged once. The runner's signed exit line names the messages it delivered
    as a second witness, so an agent that breaks its own transcript (a symlink swapped in) cannot make delivered
    messages count as late. And it hands a message over only while pi says a run is actually in progress, so an
    aborted run cannot record a delivery the model never saw.
  - **Caps.** At most 16 messages, 64 KiB of text and 8 KiB per message per run, refused rather than cut, withdrawn
    messages still counted. Every turn a message causes counts against the job's turn budget and its cost and token
    caps, and the job reserves nothing extra.
  - **No text in logs or the record.** The CLI prints the message id and its state, never the text; logs carry ids,
    modes and counts; the run record gains only `steered` (three integers) and `steerSkipped` (an enum).
  - **A comment steers only through the author gate** (issue #646 part 2). A phrase comment is routed into a running
    job only after the receiver's unchanged author gate admitted it (GitHub's association, or the resolved write
    access on GitLab, Forgejo and Azure DevOps), only when the comment trigger itself set `run.steer`, and only into
    a steer-armed run of the same issue or pull request. A stranger's comment is dropped exactly as before and never
    reaches an inbox. The comment is scrubbed and bounded by the same rule and caps as an operator's message before
    any Valkey call, and a comment that cannot be steered falls back to the job it would always have started, so
    steering never loses a delivery. A comment that arrives after the run ended starts at most one job per run end,
    the one the same admitted comment would have started (only when the trigger resumes, and never after an
    operator's cancel); every other late comment gets one fixed reply that quotes nothing and mentions nobody.

- **Azure DevOps webhook authenticity is weaker than every other arm's, and this is not a footnote.**
  Service Hooks offer no HMAC of any kind — only HTTP Basic or a static header — so the credential proves
  the sender knew a secret and says **nothing about whether the body arrived as it was sent**. Anyone
  holding it can compose an arbitrary delivery. Two things follow: the dedup key is read from the body
  (Azure sends no delivery-id header), and there is no signed timestamp and therefore no replay window, so
  a captured delivery replays as new paid work once the job key ages out. HTTPS is mandatory, the author
  gate still runs, and every money gate still applies — but if that trade is not acceptable to you, do not
  enable the Azure arm. `OQ-015` records the full reasoning.

## The operator console

The admin extension binds no port. The operator console does: `pi-dispatch-console serve` is a separate process
that serves a web page to manage the deployment ([`docs/console.md`](docs/console.md), `DES-OPERATOR-CONSOLE`,
`REQ-CONSOLE-SECURITY`, `REQ-OPERATOR-CONSOLE-ACTIONS`). It never runs on the receiver, which faces the internet. It listens on `127.0.0.1:4790` by
default, or on a unix socket at mode 0600, and refuses any other address unless you set `PI_CONSOLE_BIND_PUBLIC=1`
(doctor then warns). It terminates no TLS: reach it from another machine through `ssh -L`.

The threat model, and what answers each part:

- **A local user on the host.** Any account on the machine can connect to a loopback port. Every request but
  `/healthz`, an empty `/favicon.ico`, the sign-in pages, sign-out (which ends only the sessions its own cookies name)
  and the console's script and stylesheet needs a session, and a session needs a named token (256 random bits) or a
  one-time login code that only the deployment's account can mint. Login attempts are rate limited and every failure is
  audited. In unix-socket mode the socket is 0600 in a directory only the deployment's account can enter, so another
  account cannot connect at all.
- **The job container reaching loopback through the host gateway.** On Docker Desktop `host.docker.internal`
  reaches the host's loopback listeners, so a job may be able to open a connection to the console. The console
  refuses every request whose Host is `host.docker.internal`, `host.containers.internal` or
  `gateway.docker.internal` before any route runs (but the three public files below, which hold no data), refuses to
  start when `PI_CONSOLE_ALLOWED_HOSTS` names one, and
  still needs a token; a job holds none. The Host refusal stops a browser and any client that keeps the name it
  dialled; a program in the job can send `Host: localhost` instead, so against a job the token is the barrier, and
  failed sign-ins are rate limited. Unix-socket mode removes the path, because no job mounts the socket, and is the
  recommended mode on Docker Desktop.
- **A hostile page on another localhost port.** Browsers treat `localhost:3000` and the console as the same SITE (a
  site ignores ports), so a page there would ride a `SameSite=Strict` cookie. Every write needs
  `Sec-Fetch-Site: same-origin` exactly (`same-site` is refused), or, from a browser that does not send that header,
  an `Origin` equal to the console's own, and a JSON body, which no cross-origin page can send without a CORS
  preflight that the console never answers. A write is two requests, a preview and a confirm that carries a
  single-use ticket bound to that session and that diff.
- **DNS rebinding.** A hostile name that resolves to `127.0.0.1` reaches the port, but its requests carry the hostile
  name in `Host`. The console accepts only `127.0.0.1`, `localhost`, `[::1]` and names you list in
  `PI_CONSOLE_ALLOWED_HOSTS`, whatever the port (so an SSH tunnel on any local port works), and answers anything else
  421. Since issue #737 three files answer on any name, by GET or HEAD alone: the console's script, its stylesheet and
  its empty favicon. They are public bytes, the same for everyone, needing no session and holding no data, and the
  421 page loads them to draw itself; every other path, one that exists or not, and every write still meets the Host
  check first, so a rebound name learns nothing about this deployment (the script names the console's page paths,
  which are this release's, the same on every console that runs it).
- **Hostile run text rendered in the page.** Issue titles, comments, tool output and transcripts are attacker text.
  Every value the console renders is scrubbed of control bytes and HTML-escaped by one template, so raw insertion is
  impossible by construction; the CSP allows scripts only from the console's own files and no inline script; run text
  reaches a page only for the operator role and never in a list view; no response carries an
  `Access-Control-*` header.
- **The theme cookie is a preference, and the CSP is unchanged** (issue #737). The theme button keeps a person's
  choice in the cookie `pd_theme`, which is not a credential: it signs nobody in and opens nothing. The console reads
  it as a closed set (only an exact `light` or `dark` counts; anything else, or a second copy, means the system's
  theme), puts its own constant in the page and never the cookie's bytes, never sets it (the console's script writes
  it in the browser), and logs and audits nothing of it. It is `SameSite=Lax` (so a cross-site link to the sign-in page
  or a one-time sign-in link draws the chosen theme; every other page needs the `Strict` session cookie, so it is a
  redirect to sign-in from another site anyway) and not `HttpOnly` (the script writes it), so any page on the
  console's host name, whatever its port, can read it, overwrite it or plant a second copy for a path of its own,
  which holds the pages under that path to the system's theme, and the browser sends it to other services on that
  host name. On a console served under a domain name, a copy planted with a `Domain` attribute (or one a sibling host
  set for the parent domain) is a second copy on EVERY page, which holds every page to the system's theme until it
  expires (on `localhost` or an IP address such a copy replaces the person's instead, measured in Chrome). All of it
  is cosmetic, since the cookie reaches no session, no page content and no write. The redesign left
  the CSP exactly as it was: one stylesheet and one script, both the console's own files, no inline style or script,
  no external resource, and a check in CI loads every page in a real browser, at a phone's width and its top bar at
  two phone widths and eighteen desktop widths, and fails on any violation it reports.
- **A leaked tokens file grants nothing.** The file stores sha256 hashes, never a token; a token is shown once, at
  `token add` or `token rotate`, and appears in no log, audit row or page. Revoking or rotating a token, or
  `sessions end-all`, ends the affected sessions on their next request.
- **Why a session ended is told, and tells nothing else** (issue #737). A session that ends leaves a tombstone in
  the console's memory: its 256-bit session id and one word from a closed list (idle, max, revoked, role, all,
  elsewhere), so the next page request that presents that cookie is sent to `/login?ended=<word>` and the sign-in page
  says why in the console's own sentence (an API request gets the word in its 401). The tombstone is kept under the session's own id, and its word describes that
  session's own token, so it tells a browser nothing about any other token or session; a browser learns only why its
  own sign-in stopped working, which signing in again would show it anyway. Only an id that was a live session gets
  one (an unknown or planted cookie leaves none), at most 1024 are kept, oldest first out, and they die with the
  process. A well-formed cookie the console never held may be told "it may have restarted", worded as a possibility
  because a planted cookie looks the same, and only while the process has been up for less than a session's longest
  life and has forgotten no tombstone. The sign-in page draws a notice only for exactly one word of the list and
  echoes nothing from its address, so a crafted link can show only the console's own sentences; the browser script
  navigates to `?ended=` only with a word of that list. A sign-out ends every session the browser presents and their
  other tabs' streams at once (each session the console holds, so a second session cookie another local page planted
  beside yours cannot make the sign-out end nothing); a sign-in over a cookie that was still live ends the old one
  once that sign-in has succeeded (one refused because its audit row could not be written leaves the old session and
  its tabs as they were) and its streams once the sign-in's answer has gone out. Such a tab then asks the console who this browser is,
  and reloads only when the answer is the person the page was drawn for. **A page acts only as the person it was drawn
  for.** A one-time link opened in this browser signs it in as that link's person, and a sign-in in another tab can
  do the same, so every page says who it was drawn for when it opens its live updates and with every preview and
  confirm, and the console refuses the request when that is not the person the browser's cookie now names: a live
  stream that opens or reconnects for another person is refused, and the page goes to the sign-in page, which says
  this browser is now signed in as someone else (a word of the list, which only the page uses: no session ends for
  it), and a preview or confirm is refused with nothing changed and an audit row, its Look again going to that same
  sign-in page rather than reloading into the other person's console. So a page drawn for you can neither
  show another person's live data nor change anything as them, even a page that is not live. A request that says no
  person (the terminal chat, a script) is held to its cookie alone, as before. Two costs are accepted. A client with
  no token learns two things from the "it may have restarted" answer to a well-formed cookie: that the console
  process is younger than `PI_CONSOLE_MAX_HOURS`, and that it has not yet forgotten an ended session (no reason has
  been dropped), which is worth little. And a token holder can flush the 1024 remembered reasons with about 1024
  sign-ins (each over the last one's cookie ends that session; about three and a half hours
  at the sign-in limit of 5 a minute): the dropped reasons are lost, those sessions' next page goes to the sign-in
  page with no notice, and the console never says "it may have restarted" again until it restarts. Nobody can plant
  a reason for another person's session: one is written only under the id of a session the console held, in its own
  word.
- **A tokens file the console cannot read signs nobody out** (issue #737). While the file cannot be read (a permission
  mistake, say), a request that carries a session cookie is answered 503 with no Set-Cookie and
  nothing ended, so the browser keeps its session for when the file reads again, and every open live page is kept
  connected and sent no data, only its pings and a `stale` that says the tokens file could not be read: no session is
  judged, so no data goes to one. Signing out is the exception that still works: it judges nothing, so it needs no
  tokens file, and ends every session its cookies name. Before, the same moment cleared every cookie and ended every
  stream.
- **Live pages hold connections, so streams are capped and end with their session.** A live page keeps one event
  stream open. A token may hold `PI_CONSOLE_MAX_STREAMS` of them (default 4) across all its sign-ins, and the whole
  console 32, half of its 64 connections, of which 8 are kept for operators, so open dashboards can never keep page
  loads or sign in out and a viewer token cannot take every live slot; past a cap a stream is refused (429). Every second the console re-checks each stream's session, without counting that as activity: logout ends a
  session's streams at once, and a revoked or rotated token, a changed role, `sessions end-all` or an expired session
  ends them within a second. An open tab never keeps a session alive, so an unattended screen still signs out at the
  idle limit. A browser that stops reading is dropped once 2 MiB are waiting for it, so a slow reader cannot make
  the console buffer without bound. The console polls Valkey once a second for all streams together, and not at all
  while none is open, so tabs do not multiply the load on the deployment. Since issue #737 a stream's end names why,
  with the same closed list as the sign-in page (and `shutdown` when the console stops, which the page and the terminal
  chat wait out rather than treat as a sign-out); a word outside that list is never sent.
- **Query strings are bounded before anything is read.** Every filter, cursor, range and id a page takes is checked
  against a fixed character set and length, and a bad one is refused by name, never echoed back. A run page reads at
  most 100 runs and examines at most 2000 records before it answers with what it found, so a filter that matches
  nothing costs a bounded read of the mirror, not a walk of its whole history. This host's own run files are read
  into one shared index at most every 15 seconds, whatever the filter, and the newest 5000 kept; a live runs page
  refreshes every few seconds rather than every second, and one token's streams share one budget, so distinct
  filters cannot multiply the load past a fixed bound. The parked page reads whether each run can be answered here
  for at most 20 runs a load, each answer kept 15 seconds whether or not it could be read, all of them sharing one
  look for the fleet's queues that is itself kept a minute, and the ones that do not find their job in it sharing one
  more look, made after they asked, so a job on a newer queue is not called gone; it refreshes at most every 5
  seconds, and reads no such check at all for a viewer or a read-only console, which draw no answer form. The
  overview's timeline choices (`rows`, `zoom`, `project`, each a closed value) only regroup one read, so every overview
  stream shares it whatever they say. A
  run id outside the shapes the worker mints is
  refused before any file path or Valkey key is built from it. No page read writes: the console's reader is built
  read-only, so it reads the run mirror without pruning it and leaves the held-jobs set as it finds it (the panel's
  own reader still tidies both, as it always did), and a test records every Valkey command a snapshot sends. The one
  write left is BullMQ's own: opening a queue client sets that queue's metadata (its library version and event cap)
  to the values every worker already writes, so it changes nothing a reader sees.
- **Who sees what.** Run records hold no attacker-chosen text by construction, so both roles see them; their job id,
  target and parent job id can still be shaped by whoever opened an issue, and are escaped like every value. **Since
  #737 a record's reason is a fixed word by construction too**: an older worker recorded an infrastructure error's own
  message there, which can name a forge API path and a repository, and the worker now records a fixed word for every
  failure (`worker-error` where it has none of its own). The runs list and the `/dispatch` panel's list, run detail
  and `/dispatch runs` table show a reason only when it is such a word, for both roles, and so do `/api/run`,
  `/api/state` and the model's `dispatch_runs` tool, so an older record's text reaches no script and no model; the
  console's run page still shows its own record's reason as it was recorded, escaped. The parked page shows no question
  text: the question is the run's own words, which the console shows only in the run page's transcript, to operators.
  The one free text the screens show, a failed job's reason from BullMQ, is shown to the operator role alone, on a
  detail page alone, never in a list, and is absent from a viewer's `/api/state`. The audit page is the operator's
  alone. Secret profiles appear by name; no page shows a resolver, a reference or a value. No page shows a job's `.log`.
  **Since #737 the overview says why each job that has not started waits**, from the worker's own record of it in
  Valkey, which anything holding the Valkey URL could also write: so it is said only in the worker's vocabulary, a
  reason word this console has no words for shown as that word (it passes the reason charset, at most 32 lowercase
  letters, digits and hyphens, no wider than an id either role reads anyway) and escaped, while a wait check's
  profile names, the operator's own configuration, are left out for a viewer. The first-run checklist says Valkey
  answers, never its address, and names the deployment folder by its last part alone. A host the registry lists,
  which anything holding the Valkey URL could also write, is shown only under a name in the worker name charset
  (`WORKER_NAME_RE`: a letter or a digit, then letters, digits, `.`, `_` and `-`, at most 64 characters; looser than
  the boot rule for `PI_WORKER_NAME`, which also refuses a `.json` or `.log` tail so that no file a worker names after
  itself passes for a run record); any other is no host to any reader of the registry, the console's among them, and
  no reader removes it. A job scheduler, which the same URL could also add, is named by the admin's surfaces (the
  console, the `/dispatch` panel and its tools) only by an id and a job name in the cron trigger id's characters
  (`[A-Za-z0-9._-]`) and at most 176 of them, the longest cron id the triggers file takes (`SCHEDULER_NAME_MAX` is
  `CRON_ID_MAX`, `mapSchedulers`); any other is read as no name, never cut to one, and no other name stands in for
  it: the schedule is still shown by its pattern and next run, every surface takes a trigger's scheduler by its id
  alone (never by its job name or its pattern), and a planted id can neither widen a page nor pass for another
  trigger's.
  **Since #643 the run page shows a running job's live transcript, to the operator role alone** (`OQ-044`,
  `REQ-LIVE-TRANSCRIPT`): what the agent said, the tools it called with their arguments, and what they returned, as
  the worker published it to Valkey, redacted (see [Live transcripts are in Valkey](#what-is-not-defended-v1)).
  A viewer gets a sentence instead and the transcript route refuses a viewer outright; the text is escaped after the
  control-byte scrub, inside a `<pre>`, only on the run page, never in a list, never in `/api/state` and never in a
  live panel. A transcript tab holds one of its token's stream slots, like any live page.
  **Since #644 the pages show run progress.** The counts (turn, steps, failed steps, the running tool's name held to a
  fixed character set) are shown to both roles, in lists too, because they are integers and a checked name. The phase
  names and the note an agent reports with `report_progress` are model text, and follow the transcript's rule: the
  operator role alone, escaped, on the run page only, never in a list or `/api/state`.
- **Error pages are pages under the same rules, and say less than they could** (issue #737). A refused or failed
  navigation by a browser (a GET or HEAD outside `/api/` and `/static/` whose Accept asks for HTML) gets an error page;
  everything else, every script, stream and write included, gets the JSON it always got. Every error page carries the
  same security headers as every response, its CSP included, is built by the same escaping template, and holds no
  inline script or style. It says only its kind's fixed sentences: a 404 never repeats the path it was asked for, so a
  crafted link cannot make a console page show words of its choosing, and the run-not-found 404 (a run page for an id
  that this host's history, the run mirror, every queue, the live transcript and the progress were each read for and
  found none of, the queues over a scan started after the question; anything that could not be read keeps the run
  page, answered 503 and naming the places it could not read, never a cause, so a run is never called gone because a
  read failed or a kept list of queues was older than the run) puts the asked id only in its search field, as the
  value of the person's own search, and only when the runs search takes it whole, never in a sentence; a 400 names
  the parameter it refused, never the value; a 500 never shows the error's text. A 421 (a Host the console does not
  answer to) reads no session and draws no navigation, names the refused hostname escaped and cut to 64 characters,
  and gives an SSH tunnel command for the address and port that connection reached, which the requester already
  knows; it never lists the extra names
  `PI_CONSOLE_ALLOWED_HOSTS` allows, nor anything else of where the console listens. A 404's navigation reads the
  session without counting it as activity, so a 404 neither extends nor ends one.
- **Forge links are never guessed.** A run's link points at `github.com` for GitHub and, for GitLab, Forgejo and
  Azure DevOps, at the instance URL the deployment itself is configured with, http or https only. When there is no
  such URL, or the target does not parse as that forge's repository and number, no link is drawn: a link to a host
  the console made up is a phishing aid, and a missing link costs a copy and paste.
- **Every write is a previewed, confirmed table entry** (issue #642). The console's writes (cancel, retry, remove,
  re-run, answer a parked run, pause a queue or the fleet, every configuration edit, and the bulk actions) are one
  table, and each one's preview and confirm routes are generated from it, so every write passes the same guards in
  the same order: the Host check, `Sec-Fetch-Site: same-origin` (or an exact `Origin`), a JSON body, the operator role,
  a console that is not read-only, then the session. A cross-site page, a form post, a viewer and a read-only console
  are refused for every action, and the tests loop over the table rather than a hand list. The confirm carries only a
  single-use ticket bound to the session and the action; the ticket, not the request body, holds what will be done,
  the file snapshots it was built from and the jobs it names, so a confirm applies the change the operator saw or is
  refused (a file another session wrote, a job that was retried, removed or failed again since the preview).
  Every write goes through the same validators and funnels as the `/dispatch` panel, with the same refusal words.
  Since issue #737 every action takes only the body keys its preview reads and refuses any other by name before
  anything is planned (a key that is not a plain identifier is called "a field it was sent"; a value is never
  repeated), and the pi tool that adds a trigger (`dispatch_trigger_add`) refuses a field its trigger type does not
  take the same way, before the operator is asked, where both used to drop such a field in silence. The banner a page shows after a write
  names the change, who made it and its audit row; its Undo button is a form that PREVIEWS the way back like any
  write, and no Undo carries a secret reference or a resolver path (a delete and a secret removal have none).
- **Bulk actions are bounded and bound.** A bulk retry, remove or held-cancel previews at most 100 jobs, and its
  ticket binds that exact list and each job's state; the confirm re-checks every job alone, acts only on those still
  as previewed, and reports per job. A hostile request cannot widen the list after the preview, because the confirm
  takes no list. One audit row is written per job.
- **Paid actions show their reserve.** A re-run and an answer to a parked run start a paid job, so their preview shows
  what the worker will hold, computed by the worker's own rule (the per-job dollar cap, or nothing for a job that
  cannot spend), and the audit row records it. The worker still reserves at pickup, after every free gate, and still
  refuses a job its caps do not admit: the console shows the reserve, it does not grant it.
- **An answer to a parked run is data, cannot ping anyone, and is posted only by the worker.** The console never posts on a
  forge itself. It queues the reply job a forge reply would have queued, with the answer as the
  comment text, which the job's prompt fences as data below the delimiter like any comment. The text has control
  characters and bidirectional overrides removed and is at most 8 KiB, refused rather than cut. The worker accepts it
  only when the issue really is parked (`not-parked` otherwise, nothing posted, nothing spent), and once every
  pre-spend check and reserve has passed, just before the container starts, posts one trail comment as the deployment, "Answered from the operator console by <name>:" with the answer quoted. Every `@`
  in it is followed by a zero-width space and `&`, `<` and `>` are written as entities, so the answer cannot mention a person or a team, and no HTML comment or tag can hide part of it on the forge; the comment is posted at most once per job, even across retries; the name is a console
  token's name, whose characters cannot form a mention or markdown, and a job carrying any other name is refused when
  it is queued. The receiver drops the trail as the deployment's own comment, so it never starts a job. The audit
  log records the answer's sha256, never its text.
- **Who did what.** Every write, every write refused by a guard and every sign-in is appended to
  `PI_LOGS_DIR/console-audit/YYYY-MM.jsonl` as a hash chain (`pi-dispatch-console audit verify` names the first
  broken link). Since issue #642 the same chain holds the `/dispatch` panel's writes and the pi extension's tools'
  writes, as actor role `panel` with the account's login name, so a change made from a terminal is recorded like one
  made from a browser. For both, the row is appended BEFORE the write and a write whose row cannot be appended does
  not happen. Refusals of requests with no session are written one row each up to 60 a minute and counted past
  that, so a flood cannot grow the log without bound. The chain makes an edit evident, not impossible: whoever can write that file can also rewrite every
  row after the one they changed. Nothing vouches for the newest row, and an edit to it is never seen: the next row
  the console writes links to the newest row as it then is on disk, edit included. A last line cut short by a crash
  leaves the row before it not verified.
- **No terminal in the browser.** The run page shows the `pi-dispatch sandbox <job>` command to copy; the console
  never starts a container or a shell.

## What is NOT defended (v1)

Stated openly rather than discovered later:

- **An MCP server is input, and a stdio one is code.** A job connects only the servers the operator lists in
  the overlay's `mcp.json` and its trigger names (`run.mcp`, [`docs/mcp.md`](docs/mcp.md)): never a repository's
  `.pi/mcp.json`, never one an extension registers, never one a pi the job starts reads (it gets `--no-mcp`;
  `pi mcp`, the subcommand, is the residual OQ-011 records). But what a connected server returns (its tools'
  results, its instructions, its resources) is text the model reads, as untrusted as an issue's body, and a
  stdio server runs code inside the job's container with the variables its entry names. Its credentials are
  `${NAME}` references the trigger maps; a reference to a credential the job itself spends with, the forge
  token or the egress variables is refused before the job starts, and a stdio server never inherits the job's
  environment.

- **The forge's own MCP server holds the job's forge token.** A github or gitlab trigger that names `forge` in
  `run.mcp` gives its job github-mcp-server or mcp-gitlab, started with the token the worker minted for that job
  ([`docs/mcp.md`](docs/mcp.md#the-forges-own-server)). It is the one server the pickup hands a forge token, and it
  holds no power the job's `gh` or `glab` lacks with that token. The image's wrapper withholds each server's
  dedicated merge and approval tools, so the harness does not hand the agent a ready made one
  (`CONST-MERGE-NEVER-AUTOMATIC`), but that is not a boundary: GitLab runs a `/merge` or `/approve` quick action
  written in a note or a description the listed tools post, and the job's CLI, or the server started from the
  job's shell, act with the token's full role. The boundary is the one in the paragraph below: the token's role and
  the branch's protection (on GitLab, a Developer token, never Maintainer, which could unprotect a branch or change
  who may merge, through the server's settings tools as through `glab`). A GitHub installation token lives one hour,
  and the server cannot outlive the job anyway. GitHub's lockdown mode is on, and it is best effort: it withholds
  some content written by people without push access on a public repository, and it is not an authorization
  boundary. Issue, pull request and comment text the server's tools return is untrusted prompt content, exactly like
  the issue text that started the job.

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
  image contains can weaken them. **Non-root is in that argv only where the daemon needs it.** On a daemon that
  enforces bind-mount ownership (native Linux Docker, rootful Podman) the worker runs a job as its own non-root
  uid (`--user`, refusing uid 0 and gid 0), unless that uid is 1001, the image's own. On Docker Desktop, and for a
  uid-1001 worker on any daemon, the argv has no `--user` and non-root is `USER pi` in the image itself, as the
  trust table above says, which is exactly why an unconformant image (`USER root`) can lose it
  there. Running a job as the worker's uid has a price, recorded in `OQ-036`: a container escape that
  keeps its uid lands as the worker's own account, files the job creates (setuid and setgid included) carry the
  worker's uid and primary group, and the worker's `0600` files inside a mounted local folder are readable to
  the job (as they already are on Docker Desktop); run the worker as a dedicated service account, as
  `deploy/worker.service` does. On rootful Podman without an empty `/etc/containers/mounts.conf`, every job
  container also gets a `/run/secrets` mount carrying the host's subscription files where they exist, so the
  worker does not credit `mountSet` there: doctor says it is asserted, a `PI_BACKEND_FLOOR` asking for it refuses,
  and `doctor --live` fails it by reading the container's own mount table (issue #345). Where the image provides non-root:
  `docs/job-image.md` requires a
  non-root runtime user with a writable home, and nothing here verifies that the image you named
  honours it. What is **not** checked is the image's contents, and every way that can be wrong fails
  **silently**: absent guardrails at `/opt/pi-dispatch/HARD_RULES.md` remove the safety floor with no error;
  a stale pi turns jobs into no-ops that report success; wrong exit codes make the queue pay to retry work
  that can never succeed; and the loader flags above are **per image**, so a multi-tenant deployment that
  turned discovery off in one image has **not** turned it off in another. What bounds it: only an operator
  editing `triggers.json` can name an image (no tool parameter, no panel key, no settings-overlay key), and
  jobs run with `--pull=never` behind a pre-spend presence check, so the only images that can run are ones
  you built or pulled onto that host yourself. `docs/job-image.md` is the conformance checklist; `OQ-012` in
  `specs/open-questions.md` is the honest statement of what nothing here can check.
- **`pi-job-*` is a name, not a claim, so a boot reaper will clear your object that happens to use it.**
  The namespace is the string, and nothing checks whether this deployment made the thing. On start, the
  worker removes every **running** container whose name begins `pi-job-` (it lists with `docker ps`, so a
  stopped one is left), and then, for every network whose name begins `pi-job-`, detaches what is attached
  and removes it. That is what lets it recover a job a crashed worker left running, because after a crash
  nothing else distinguishes one. A `pi-job-runner_default` network, or a `pi-job-mine-net-backup` copy of
  one, is inside the namespace and goes with the rest.
  **The likely way to meet this is `docker compose`**: a project named `pi-job-anything` gets a network
  `pi-job-anything_default`, and its services are named `pi-job-anything-<service>-1` unless you set
  `container_name:`.
  **A stopped member now keeps its network** (since the #379 round). The sweep asks the daemon twice: which
  endpoints it lists as attached, and then `docker ps -a --filter network=` for members in ANY state. A
  member that is `created`, `exited`, `dead` or in a state this project has not measured keeps the network,
  and the sweep says so. Before that, such a member was invisible to both halves and its network went, after
  which it could never start again: `docker start` answers `network ... not found`.
  One exception, and it is this deployment's own object rather than yours: a stopped
  `pi-dispatch-egress-proxy` is detached and the network removed anyway. Protecting it would leave every
  leftover job network standing forever on a deployment whose proxy is off, and the network it loses is a
  dead job's.
  So a stack whose services you stopped survives. What still does not: a stack whose services are RUNNING
  and are themselves under the prefix, because the container loop `rm -f`'d them one loop earlier and there
  is nothing left attached by the time the network loop asks. Under default compose naming that is the
  normal case, and it is the reason the prefix is worth avoiding rather than working around.
  **What recovery costs, measured on docker 27.4.0 and compose v2.31.0, with no comfortable answer.** The
  network is GONE, not merely detached, so `docker network connect` answers `network not found`. For a
  compose stack, `docker compose up -d` from the project directory does restore the network with its labels,
  the service aliases and working service-name DNS, but it RECREATES the service containers to do it, so
  anything written inside them since they started is discarded. That is the same loss the container half
  causes outright, which is the honest reading: the two halves cost about the same, and this widening is
  not defensible on the ground that its half is cheap. It is defensible because the old rule destroyed
  a `pi-job-*` project's containers and spared its network, which protected nothing at all.
  For a network **not** made by compose there is no single command: a hand-made one loses its subnet,
  gateway, driver options and labels with it, and a compose `external:` network is worse, because
  `docker compose up -d` then refuses outright (`network ... declared as external, but could not be found`)
  and leaves the containers running attached to nothing until you recreate it yourself.
  Until issue #360 the two halves disagreed — the container was taken and the network was not — which was
  not a protection so much as an inconsistency that spared half of an object by an accident of suffix.
  Docker labels would be unambiguous and are **not** used: a label cannot be on what a worker that crashed
  before this change already created, so the migration is the real content of that choice and it has not
  been made. Keep your own objects out of the prefix. A sandbox is safe by construction: `pi-sandbox-*` is
  outside it, deliberately.
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
  **A project secret bundle (issue #704) does not reduce the kind or the quantity the way `run.secrets` does.**
  It hands every trigger-made job of the project the whole environment its resolver prints, and the reviewed file
  names no field of it, so a capability review of `triggers.json` no longer says what a job holds: the record's
  `bundle.variables` does, after the fact. That is the trade the feature makes on purpose (`DES-PROJECT-SECRET-BUNDLES`).
  A prompt injection in one issue can reach every variable of the bundle. Keep bundles small and per project, keep
  `forkReviews` off, and keep a credential only one trigger needs in that trigger's `run.secrets`. On `local` and
  `podman` every bundle variable is one more `-e NAME=VALUE` in the argv the next sentences describe (`OQ-028`).
  Two further exposures are worth stating plainly. Every environment value reaches the container as
  `-e NAME=VALUE` in the worker's own `docker run` argv, sent to whichever daemon the docker CLI resolves, so under a default `hidepid` any local user can
  read it from `/proc/<pid>/cmdline` for the container's lifetime; that is already true of the provider key
  and the forge token, and a vault-managed value arriving there is new in kind rather than in mechanism.
  (Not on the `openshell` venue, issue #684: there every secret value goes into the job's OpenShell provider and the
  agent holds a placeholder, so neither the sandbox nor any argv carries it; see the venue's row under Trust
  boundaries.)
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
  container**, and default to `~/.pi-dispatch/logs`, outside any repository (they are **gitignored** as
  well, for the deployments that keep them in one); an age sweep prunes them at boot and on the retention timer
  (`PI_LOG_RETENTION_DAYS`, `0` = keep forever; `PI_SWEEP_INTERVAL_HOURS` sets the cadence). Leave capture off unless you need it, and treat the log directory as personal data while it is on.
  The raw log never leaves its host. The live transcript is a separate, structured and redacted copy that does
  (the next bullet).
- **Live transcripts are in Valkey (PII), redacted but not secret-proof.** This reverses what this file and
  `docs/multi-host.md` said until #643, that transcripts stay on the host that ran the job. Unless you set
  `PI_LIVE_TRANSCRIPTS=0`, every worker publishes each running job's transcript to the deployment's Valkey (one
  stream per job, `run:live:<job id>`), so the console and the `/dispatch` panel on any host can show it live.
  - **What the worker reads**: only the job's own transcript file, as a regular file. The agent can replace that
    file inside its container, so the worker refuses a symlink, a FIFO or a different file swapped in (it checks
    before and after opening, and opens without following links), publishes one fixed note, and stops reading it,
    so a job cannot make the worker publish a host file such as another job's stored transcript.
  - **What it holds**: what the agent said, the tools it called with their arguments, and what they returned, so
    issue and comment text, file contents and command output. Never the raw `.log` (that stays on its host, as
    above), never the model's thinking, never a provider's error message.
  - **How long**: at most 2,000 entries per job, removed 24 hours after the run ends; a run whose worker died before
    the end keeps its stream for 7 days from its first entry.
  - **Next to what**: Valkey already held personal data. A forge job's BullMQ data carries the issue or comment
    title, body and author for 31 days. The transcript adds tool output and the agent's own text, redacted, for a
    day.
  - **Who can read it**: anyone with access to your Valkey (its password, its port, its volume or a backup of it),
    the console's operator role, and anyone who runs the `/dispatch` panel against the deployment. A console viewer
    cannot.
  - **What is redacted**: every value the worker handed the job's container except the structural ones (paths,
    flags, model names, counts), so the forge token, the provider key, every forwarded variable, every resolved
    secret and every model-endpoint key, plus the exit key, each in its plain, JSON-escaped and URL-encoded
    spelling when it is at least 8 characters; and known token shapes the job was never handed (GitHub, GitLab,
    Anthropic and OpenAI style keys, Slack tokens, console tokens, AWS access key ids, `Authorization` and `Bearer`
    credentials). Control and bidi characters are written out.
  - **What is not**: a secret the agent transforms (base64, reversed, split across two tool calls, one character a
    line, or with an invisible character such as a zero-width joiner inside it, which also stays invisible on the
    page) is not caught, and cannot be by any rule that does not know the transformation. Nor is a secret shorter
    than 8 characters, or a credential the job found that matches no known shape, or personal data, which is not a
    secret and is shown on purpose. Redaction bounds an accident; it is not a barrier against an agent trying to
    leak: an agent that can echo a secret can also send it out through whatever network access it has.
  - **When the tail is lost**: a cancelled or timed-out job whose container does not stop within the abort grace is
    given up on, and the worker then makes its last read and publishes the end marker before cleanup (since #644).
    Only when that last read itself runs out of time (10 seconds) are the last lines and the end marker lost.
  - Set `PI_LIVE_TRANSCRIPTS=0` on every worker if transcript text must not reach Valkey; any value but `0`, `1` or
    empty refuses to boot, so a typo cannot read as off. Treat a Valkey backup as personal data either way.
- **Run progress is advisory, and the agent can forge it.** Since #644 the worker reads where each running job is
  (the turn, the steps done and failed, the tool running, and on a trigger with `run.progress` the phase the agent
  names through its `report_progress` tool) from the same transcript file, which the agent can write. So an operator
  can be shown a phase or a step count that did not happen. Nothing trusts it: no classification, budget, exit outcome,
  retry or alert reads it, and every field is capped, so a forged file can only mislead a display.
  - **What reaches Valkey**: one key per job, `run:progress:<job id>`, with counts, checked tool names and, for a job
    whose trigger set `run.progress`, the phase names and the latest note, redacted like the transcript and with
    the transcript's residual (a secret the agent transforms is not caught). It is removed 24 hours after the run
    ends, and at most 7 days after its first write when the worker died first. A running job's key is rewritten at
    least every 30 seconds, so the console and the panel mark a key that has not changed for 3 minutes as stale (the
    worker may be gone) instead of showing the job as still running. Every id in the file is capped at 128 characters
    before the worker keeps it, so a forged line cannot make the worker hold a large id in memory. With `PI_LIVE_TRANSCRIPTS=0` and progress
    on, no transcript text reaches Valkey, but those phase names and notes still do.
  - **Who sees the phase names and notes**: the console's operator role and anyone who can read your Valkey. Never
    the run record, which gains a `progress` summary of integers under fixed keys only, and never the forge.
  - **The status comment is opt-in and carries no model text.** A forge trigger with `run.statusComment: true` gets
    one comment from the worker on its issue or pull request, edited as the run goes. Its text is fixed words, the job
    id and numbers, never a phase name, note or tool name, so nothing the agent writes reaches the public thread
    through it. It is still a public record of the run's pace (how long it took, how many turns and steps, whether
    steps failed) for everyone who can read the issue, which is why it is off by default.
  - **It cannot start a job.** Every edit is a comment event the receiver drops: the editor is the harness's own
    identity, and on GitHub, GitLab and Forgejo an edited comment never routes. The worker also skips the comment
    (logged as `status_comment_skipped`, `phrase-collision`) when the phrase that started the job could appear in any
    text it can hold, the retry's words included. The other skips are logged the same way: `progress-off`,
    `no-transcript` and `no-forge-target`.
  - **The same identity, one new kind of call**: the comment is posted and edited with the token the worker already
    mints for its other comments, through each forge's comment edit endpoint (GitHub and Forgejo `PATCH` an issue
    comment, GitLab `PUT`s a note, Azure DevOps `PATCH`es a pull request thread comment or a work item comment). It
    edits only the comment it posted, by an id it checks before building a URL; a 403, 404 or 429 stops the editing.
    The last edit, with the outcome from the run record, is still made after a 429 and tried once more a second later,
    so the comment does not say "running" after the run; a 403 or 404 stops that one too.
  - Set `PI_RUN_PROGRESS=0` on every worker to stop reading progress: no key, no record field and no status comment.
- **Durable runs keep transcripts and whole workspaces on disk, and a crash loop costs real money.** Since #645 a
  forge trigger with `run.recover: true` has its running jobs checkpointed, so a run the worker loses (a crash, a kill,
  a lost host, a container that dies on an infrastructure fault) continues from its last checkpoint instead of
  starting over ([`docs/durable-runs.md`](docs/durable-runs.md)).
  - **The checkpoint store is the session store's PII class.** Each checkpoint holds the job's transcript (issue
    text, tool output, the agent's own text) and its whole workspace tree, for up to 7 days after its last checkpoint
    (removed earlier when the run ends). It lives in `PI_CHECKPOINTS_DIR`, by default `.checkpoints` inside
    `PI_SESSIONS_DIR`, mode `0700`, owned by the worker's account, and is never mounted into a container. Put it on
    a disk you would put transcripts on, outside the temp directory and every git repository; doctor checks the
    owner and the mode and warns under the temp directory.
  - **What a recovery trusts in the restored tree.** The tree was written by the agent, so a recovery resets `.pi/`,
    `.agents/` and the root `AGENTS.override.md`, `AGENTS.md` and `CLAUDE.md` files (in every casing) to their content
    at the commit the run started from before its container starts, and does not start when that reset fails. Without
    it an agent could plant an extension or rewrite the instructions, crash itself, and have the recovery load them as
    the repository's own. Every other path is restored as the agent left it, which is the point: it is the work.
    The reset cannot see what an extension imports (a file outside `.pi/`, a package from `node_modules`), so a
    repository whose default branch has anything under `.pi/extensions/` gets no recovery at all: its runs are not
    armed (`recoverSkipped: "workspace-extensions"`) and run as before.
  - **The secret scan and its limits.** A checkpoint that holds the job's minted forge token or a resolved
    `run.secrets` value, in a file's bytes, a file or directory name or a link target, is refused whole and the run
    keeps the checkpoint it had. The match is literal: a value the agent encoded or split is not caught. The
    transcript copy is not scanned (it has the transcript's exposure, as with `run.resume`). A salvage checkpoint,
    taken from a crashed attempt's job folder after that attempt died, has no secret values to match, so it is stored
    unscanned; the store is host-private and a forge token from a minted App installation is dead within the hour.
  - **Self-induced recoveries are capped.** The agent can end its own container (kill its runner) and that reads as
    an infrastructure exit, which a `run.recover` run continues. Each run is continued at most twice, and each
    container reserves its own dollar hold up to the per-job cap before it starts, so a crash loop costs at most
    (1 + retries + recoveries) per-job caps for one run: for a forge job, two queue attempts plus two recoveries, at
    most four. A crashed container's hold stays charged in full (it is never settled down from the transcript's usage,
    which the agent can write). The third loss ends the run (`recovery-failed`, commented and paged).
  - **Pause grants nothing.** A live checkpoint freezes the container with the runtime's `pause` (the cgroup freezer)
    for at most a few seconds while the host reads the workspace. It adds no capability, mount, exec or network path;
    the job only sees time jump. A container that cannot be unpaused is killed, and the run is recovered.
  - **Interrupted side effects are not undone.** A push, a comment or an MCP call that was running when the run was
    lost may or may not have happened. The recovery tells the agent so and how to check (fetch first, push with
    `--force-with-lease`, look for an existing pull request, read the comments), and never re-runs anything but the
    builtin file tools on its own. It is checkpointed, not exactly once.
    Any value but `0`, `1` or empty refuses to boot.
- **Steering is a second way to put text in front of a running agent** (issue #646). With `run.steer` on a
  trigger, whoever can send a message can add words to a run while it works ([`docs/steering.md`](docs/steering.md)).
  - **Who can send.** An operator, from the command line on a host that reaches the deployment's Valkey
    (`pi-dispatch steer`), and, on a comment trigger that set `run.steer`, anyone that trigger's author gate admits,
    by commenting with its phrase on the issue or pull request a steer-armed job is running on. **Arming a comment
    trigger with `run.steer` widens what a collaborator can do**: from starting a job to adding words to one that is
    already running, possibly one a different trigger started (a label job on the same issue). Anyone who holds the
    Valkey URL and its credential can push into an open run's inbox directly, as they can already enqueue jobs, cancel
    them and edit the queue: Valkey is the deployment's own trust, so protect it as such. Since issue #646 part 3 an
    operator also sends from the console, behind its session rules (the operator role, a same-origin JSON write, a
    single-use ticket bound to the previewed message, an audit row holding the message's sha256 and never its text),
    and from the `/dispatch` panel, whose push is audited as the panel. A console viewer sees a run's inbox without
    any text and cannot send. No model-callable tool sends a message, so the operator's own model cannot steer a run.
  - **What is not defended for comments.** The gate judges write access, not intent: a collaborator can steer a run
    toward anything they could have written in the issue. Several comments can each cost a turn, up to the inbox's
    16 messages, and a late comment can start one more paid job per run end when the trigger resumes (each still
    reserved against the caps like any job). The forge author is named to the agent by id and gate role only, so the
    agent cannot tell two collaborators apart by name. Nothing is posted when a comment steers, so the other people
    on the issue learn of it from the run's work, not from a reply. A finishing run stays reachable for 15 minutes
    after its container exits, so a comment then lands late rather than being coalesced away; it can still be lost to
    the ten minute window in the rare case where another run on the same issue died and took the finishing run's
    reachability with it. Replicas each post the late reply. A steered comment is remembered for 31 days by delivery
    id, so a redelivery never starts the job the steer replaced; a webhook and the poller serving the same repository
    see one comment under two ids and can each act on it. On Azure DevOps the gate itself is the weaker one described below.
  - **The text is not filtered.** It is framed and fenced as data, which is placement, not a guarantee: a message is
    exactly as able to talk the agent into something as the issue text is (the point below), and an operator's
    message gets no extra standing to do so. Everything that bounds an issue's text bounds a message's.
  - **A message can reach a recovered run twice.** A message delivered just before a crash is handed over again by
    the recovery when the receipt in the restored transcript was signed by the lost attempt, whose key is gone.
    Receipts that cannot be verified are deliberately not trusted, because the agent could plant them; a framed
    duplicate is the cheaper error.
  - **A withdrawal is guaranteed only before the worker writes the message.** Once it is in the run's `/inbox` the
    agent may already have read it; the CLI says "best effort", and the transcript says whether it was delivered.
  - **The live transcript shows the message.** A delivered message appears in the run's live stream as a note with
    its full framed text (redacted and capped like any line), so it has the live transcript's exposure.
  - **Not interrupting.** A message waits for the current turn's tool calls; it cannot stop a tool that is running.
    Cancel is still the way to stop a run.
- **Prompt injection is not prevented, only bounded.** Untrusted text is kept out of the trusted region
  of the prompt by *placement*, not by filtering — content-filtering natural language is not a security
  boundary and this project does not pretend otherwise. The bound is the container, the scoped token,
  branch protection, and the human merge gate.
- **A project's own instructions can argue with the guardrails.** The baked safety floor cannot be
  *deleted* from the prompt — that is asserted by a test. It can be *contradicted* by a project persona,
  because prompt ordering is not an enforcement mechanism. This is the same honesty as the point above:
  what stops a merge is branch protection, not a sentence telling the agent not to.
- **The host Docker daemon is trusted, and so is the worker.** A container escape is a full compromise. "The host" means the daemon the docker CLI resolves: a CLI pointed at another machine sends that machine every job's provider key and forge token. The worker logs a redirect it can see and a `credentialTransit=enforced` floor refuses one, but it sees the endpoint's form only: a tunnel behind a local socket or loopback port is not caught.
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
  it is NOT money-safe.** `dispatch_run` is an *enqueue*, a third kind of model-callable tool beside the
  reads and the queue controls, and unlike either it spends money editing a folder in place with no undo —
  an explicit break from the "money-safe" framing that governs `pause`/`resume`. It is bounded in
  blast-radius, not prevented, by **six** independent limits: the folder allowlist `PI_DISPATCH_RUN_ROOTS`
  (realpath + containment, judged again at prepare on the resolved folder, which is what is mounted:
  `local-folder-escaped`); the committed per-flow opt-in (default deny, read at a pre-agent SHA); the
  dirty-tree refusal (no force option); no spend-knob parameters on the tool; a per-hour rate limit; and
  the daily cap (`CONST-BUDGET-BEFORE-TOKENS`).
  One supporting fact about that allowlist, because `/dispatch setup` writes a file that could otherwise
  widen it: the **deployment pointer** resolves paths only, through an allowlist of exactly six path/URL
  keys. `PI_DISPATCH_RUN_ROOTS` is excluded **by construction**, as is every credential-shaped key, because a
  pointer that could widen the AI-run folder allowlist would be a second, unreviewed door to the very
  capability this bullet is bounding. Anything else in the file is dropped silently, and the pointer never
  overwrites a variable you exported yourself.
  Do not read `dispatch_run` as money-safe or reversible — it is neither.

- **The model can also reach a set of confirm-gated WRITE tools, and some of them move spend limits.**
  Named here because this page previously described the model-callable surface as reads plus
  `pause`/`resume` plus `dispatch_run`, which stopped being true when the trigger, pause-window and
  scoped-limit CRUD shipped (issue #280). The full inventory lives in `REQ-ADMIN-VIA-PI-EXTENSION` and is
  scanned against the code by `admin/test/wiring.test.mjs`, so it is not re-listed here: a second copy on
  this page is exactly how the first claim went stale. What matters for a threat model is the shape. These
  tools can raise a spend cap, add a paid trigger, open or move a pause window, set a per-scope limit, or
  cancel a held job, so **"money-safe" does not describe them either** — only `pause`/`resume` earns that
  word. What bounds them is not reversibility and not structure but a **human keypress**: each routes
  through one `confirmedWrite` funnel that refuses unless an interactive operator is present (`ctx.hasUI`)
  **and** approves a dialog showing the concrete before/after. A prompt-injected session emits the *call*;
  it cannot forge the *approval*, and in a print or headless session the write is refused rather than
  silently applied. The residual is therefore an operator who approves a dialog without reading it, which
  is a real residual and is named rather than argued away.

- **One model-callable write needs no keypress, and it moves money between projects.** The priorities write
  (`dispatch_priorities_set`, issue #504) applies a plan of weights with no confirm, also headless, and a
  portfolio job's plan (issue #505) does the same with no session at all. It cannot change the envelope, a floor,
  a cap, a trigger or a setting, so it raises no ceiling. What it can do is shift spend between projects, and that
  is bounded by arithmetic, not by a keypress: no project below its floor, no total above the envelope's, and no
  project moved by more than `maxStepPct` of the total per `minIntervalHours`. Worked: with $100 a week, floors of
  $10, a 25% step and a 24-hour interval, a prompt injection can push one project to $90 and the other to $10 in
  four days, and total spend stays at or under $100. A Valkey flush resets the interval, which buys one extra step.
  A compromised portfolio flow (a malicious skill in its folder) has the same bound, and it cannot write the
  envelope: the worker refuses to boot when the envelope lies inside any path a job container can see, re-checks that
  at every reload (keeping the last good envelope when it fails), and re-judges a local job's folder at prepare, so a
  link a job planted cannot mount the envelope's folder (`local-folder-holds-envelope`) or carry a folder out of its
  job path (`local-folder-escaped`). The session
  tool is for your own instructions. A model that reads issue text in your session breaks the premise that the
  operator's session processes no adversarial input; that judgement belongs in a portfolio job (issue #505), whose
  plan meets the same rules. Reasons in a plan are agent text: they show in the panel only, escaped, and never reach
  a tool result, a record or a log line. Every attempt, applied or refused, is in the audit log, and the panel
  reverts to any of the newest 20 rows of that history (`REQ-DELEGATED-ALLOCATION`,
  `DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE`).

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

- **The operator console cannot defend against the host or the operator's own machine.** Root on the host reads
  the tokens file, the audit log and the console's memory, and can rewrite the audit chain end to end. A compromised
  operator browser or machine acts with the operator's session, which is what a session is. A compromised tunnel
  endpoint (the machine running `ssh -L`, or anything that can connect to its forwarded local port) is a local user
  on the host from the console's point of view: it still needs a token, but it sees whatever a signed-in browser
  sends through it. And the login rate limit is one global bucket, because every peer is loopback: a local user can
  spend it and slow the operator's own login (never lock them out). The same holds for availability: whoever can
  connect can hold the console's 64 connections open (each is cut after ten seconds without a full request, so a
  client must keep reconnecting), which keeps the operator out while it lasts; it gains nothing else. On Docker
  Desktop a job container is such a client on a TCP listen. Unix-socket mode removes both paths for other accounts and
  for jobs. Live streams are capped below that, but a token holder (a viewer too) who signs in eight times can hold
  all 32 stream slots: other people's pages still load, but stay static until those streams close or that token is
  revoked or rotated. Since issue #737: a page on a hostile name that resolves to loopback can read the 421 it gets,
  which holds only the name it sent and the address and port it reached, and the console's script and stylesheet,
  which are the same public bytes for everyone; whoever plants a cookie of a session's shape is shown the "it may
  have restarted" sentence while it could be true, which is why it is worded as a possibility, and learns from it that
  the console process is younger than `PI_CONSOLE_MAX_HOURS`; a token holder can flush the remembered reasons why
  sessions ended (above); and a page on another loopback port is the same site as the console, so it can make the
  browser fetch a console page with the session cookie (`SameSite=Strict` does not stop it) and so take the banner a
  write left for the next page, which is cosmetic: that page cannot read the answer, and the audit log keeps the row.
- **An operator token speaks on the forge as the deployment** (issue #642). Answering a parked run makes the worker
  quote the operator's text on that issue under the deployment's identity, naming the token. Mentions are
  neutralised and the text is fenced as data for the agent, but what the words say is the operator's: whoever holds
  an operator token (or a signed-in operator browser) can put text on any parked issue the deployment can comment
  on, and can start paid runs (a re-run, an answer, up to 100 retries in one bulk confirm) within the caps. Give
  operator tokens only to people you would give the deployment's forge identity and budget, and the viewer role to
  everyone else.
- **A panel row names an account the host vouches for, and an unwritable log stops the panel's writes.** A `panel` row names the OS login of whoever ran
  pi, which the host, not the console, vouches for; anyone who can write `PI_LOGS_DIR` can also rewrite the chain, as
  above. A full or unwritable logs directory refuses the panel's and the tools' writes until it is fixed: refusing is
  the chosen failure, because a write the log never saw is the outcome the log exists to rule out.

## Operator responsibilities

- **Protect your default branch.** Require a pull-request review, forbid force-pushes. This is not a
  suggestion — it is the only technical control standing between an injected agent and your `main`. The
  worker refuses to run without it, and you should not work around that.
- Set a provider spend limit and a daily job cap.
- Do not blanket-forward host environment into job containers. Pass only the variables the configured
  provider needs. In particular `ANTHROPIC_OAUTH_TOKEN`, and at the pinned pi `ANTHROPIC_AUTH_TOKEN` ahead
  of it, silently take precedence over `ANTHROPIC_API_KEY`, so a stray variable in the host environment can quietly redirect which credential
  a job spends. Every minted-token name is refused in `PI_FORWARD_ENV` at config load, across all four
  forges: `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN`, `FORGEJO_TOKEN`, `GITEA_TOKEN`,
  `GITEA_SERVER_TOKEN`, `AZURE_DEVOPS_EXT_PAT` and `SYSTEM_ACCESSTOKEN`. The worker sets them from the per-job mint, and a
  forwarded operator token would silently override it. That list is derived from one row per forge rather
  than hand-maintained, so a forge added to the mint cannot be missed here. `FORGEJO_PERMISSION_TOKEN` is refused too, for another reason:
  it is an admin account's token that only the receiver's author gate reads, and no job may hold it. If a secrets manager supplies
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
  conformance checklist in `docs/job-image.md` (non-root with a writable home, the runner as entrypoint,
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
- **Token and cost accounting covers `pi` child processes that cooperate, and it is not a wall.** The recorded
  totals cover every session inside the job container's Node process, including subagent sessions an extension
  spawns, and, since issue #500, every **`pi` child process** that keeps the job's environment: each child meters
  itself into a ledger the runner folds into the job's totals and caps. A pi child the runner finds with no
  ledger (on Linux) stops a capped job and makes an uncapped one's record a floor. The agent holds the provider
  key and runs as the runner's user, so a child that hides from both, a client that is not pi, or a direct API
  call is still absent from the run record and the daily token counter (`OQ-011`). `PI_MAX_TURNS` likewise bounds
  only the root session's turns. The backstops there are the 30-minute container timeout, the job-count caps, and
  your provider-side spend limit, not the meter.
- **The admin surface is not a network service.** It is a pi extension in your own terminal session plus
  a `settings.json` file, and it binds no port. The operator console is the exception you start yourself: a separate
  process that listens on loopback or a private socket, under the rules in [The operator console](#the-operator-console). Whoever can run pi with the extension loaded, or write
  `PI_SETTINGS_FILE` (default `~/.pi-dispatch/settings.json`, whose permissions are therefore part of your
  threat model), holds operator power: the same trust as shell access on the host. Treat it that way.
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
  **The model in that session has a shell too, and the write guard cannot see it.** The admin extension blocks
  pi's `write` and `edit` tools (a call nested through `ctx.executeTool` or a codemode script included) whose
  target is the envelope file, `projects.json`, `scoped-limits.json`, `triggers.json`, the settings overlay, the
  deployment's `.env`, the deployment pointer (issue #504), the console tokens file (issue #640) or anything in the
  console's login-codes directory beside it (issue #708). The `.env` and the pointer are guarded because they
  NAME the other files: the panel reads `.env` on every call, and a session that could point it at a decoy could
  unguard the real file, write it, and point it back; the guarded set also never shrinks within a session. With no
  pointer, the `.env` of the folder pi started in may only add to the set (every guarded file it names, and itself),
  and an `init` folder's own `triggers.json`, `scoped-limits.json` and `projects.json` are guarded. A deployment the
  panel cannot see at all (no pointer, no key set, not the folder pi started in) is not guarded. The target
  is resolved as pi resolves it (`~`, an `@` prefix, Unicode spaces, `file://`, against the session's working
  directory) and compared by file identity, so a symlink, a hard link or a case variant is the file it names (a
  name not yet created is compared fully case-folded); a target it cannot resolve is blocked. A `powershell`
  command (a built-in tool since pi 0.99.1, registered but not active by default) that names one of those files is
  blocked by its text, which is a best effort: a glob, a backtick escape, an environment variable
  (`$env:PI_PROJECTS_FILE`) or an 8.3 short name (`PROJEC~1.JSO`) passes, while an ordinary read of another folder's
  `settings.json` is blocked for naming it. `bash`, your own `!` commands, and a later extension that rewrites a
  tool's path after the guard ran can write any file your account can, and none of them can be filtered reliably.
  Nor can a `bash` command in the same message as a `write`: pi runs every `tool_call` hook of a parallel batch
  before it executes any call of it, so an `ln -s` there can repoint a path the guard already judged (this needs
  `bash`, which is the residual already). That residual is named, not closed: an edit of the envelope outside the
  panel is detected by its digest and shown as a banner and an `envelope-changed-externally` audit row.
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
  discipline as every other side effect. The panel emits no OSC 8 hyperlink at all: it used to link a run
  target, and that was withdrawn under issue #382, because the gate that keeps a stored field's escapes off
  the terminal can recognise a SHAPE and not an author, so allowing the panel's own link allowed an
  identically-shaped one written into a trigger field.
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
- **On Docker Desktop, "dies with the container" is not true either.** Docker Desktop for macOS writes each
  container create request, environment included, in plain text to
  `~/Library/Containers/com.docker.docker/Data/log/host/com.docker.backend.log` (rotated to `.0` to `.8`
  beside it). Every job's forge token rests there. pi-dispatch cannot stop that and does not scrub it. A
  minted App installation token expires in about an hour, so its copy is dead soon after; a long-lived PAT,
  a `gh` login, a GitLab or a Forgejo token stays usable there for as long as the token does. The provider
  API key, every `run.secretsProfile` value, every project secret bundle value and every `PI_FORWARD_ENV` value a job carries rest there too, as the same `-e NAME=VALUE`
  the paragraph on secret profiles describes, and those have no expiry at all; the provider key can spend
  money. The App path does not close that. Set a spend limit on the provider key, rotate any key or secret
  you suspect, and treat that folder as a secret store. Outside jobs, the same log gets the Valkey password
  (`pi-dispatch up`, and the `docker run` doctor's Valkey fix shows, pass `-e VALKEY_PASSWORD`; the compose
  file's Valkey sets it in `environment:`) and, on a compose deployment, the receiver's whole `.env`
  (`env_file: ../.env`: webhook secrets and forge credentials). doctor's in-image `gh` check passes your
  token on stdin, so doctor itself adds no copy. See `docs/backends.md`.
- **`PI_SESSIONS_DIR` is a PII store, and it has no default.** Unset means the feature is unavailable and
  a trigger that asked for it is refused before it costs anything — deliberately, because a default would
  turn that refusal into a silent success, writing the most PII-bearing thing this system holds to a path
  nobody chose. That reasoning is its own, and does not rest on where anything else defaults. Put it on
  the same disk you would put
  `PI_CAPTURE_JOB_LOGS` output on, mode `0700`, outside every git repository, and set
  `PI_SESSIONS_TTL_DAYS` together with `PI_SESSION_MAX_AGE_DAYS`, which bound two different clocks: the
  first is time since the last run on a key, the second is the age of the conversation itself. Retention
  here is not disk hygiene: a stale transcript is a **live input to a future job**, so an old file is a
  correctness problem before it is a capacity problem.
  Since #643 a job that does not resume also writes a transcript file while it runs (unless `PI_LIVE_TRANSCRIPTS=0`), in its own job folder under the
  temp directory (`<jobDir>/session/current.jsonl`, mode `0700`), so the worker can publish it live. That file is
  never copied into `PI_SESSIONS_DIR`, never handed to another job, removed before a sandbox is kept, and deleted with
  the job folder when the run ends. While the run lasts it is as sensitive as a stored transcript.
  `pi-dispatch doctor` reports the store and warns whenever a trigger arms the flag.
- **`run.recover` keeps a second PII store beside the sessions.** The checkpoint store (`PI_CHECKPOINTS_DIR`, by
  default `<PI_SESSIONS_DIR>/.checkpoints`) holds whole workspaces as well as transcripts, for up to 7 days. Give it
  the same disk and mode as `PI_SESSIONS_DIR`, leave room for it (its cap is 20 GiB), and on a fleet name every worker
  (`PI_WORKER_NAME`) so a lost run's recovery goes to the machine holding its checkpoint.
