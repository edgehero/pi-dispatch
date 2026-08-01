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
| **GitHub webhook** — label or `@pi` comment | A collaborator. The label *is* the approval step. | Decline the PR |
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
| The job image (`PI_JOB_IMAGE`, or a trigger's `run.image`) | **Operator — the same trust as baking it** | It *is* the code every job executes: the pi version, the runner and its exit codes, the guardrail floor, the loader's discovery posture and the non-root user all come from it. Nothing here verifies an image this project did not build. The isolation flags are applied by the worker's argv and hold for **any** image; the **contents** do not. |
| The job container | **None** — it is the untrusted side | It runs the agent |
| A job container's `/outbox` request file | **None** — agent-authored | An agent-initiated signal channel back to the host; validated host-side before anything is enqueued. **Local jobs only** — a github job has no `/outbox` mount at all |
| A job container's `/session` transcript | **None** — agent-authored | The **second** agent-initiated channel, and this row exists because the line above used to say "only". Written by the agent, read back host-side on a `completed` exit, `lstat`-checked and regular-files-only on both edges |
| A **resurrected sandbox**'s operator shell (`pi-dispatch sandbox`) | **Operator — the same trust as a terminal on this host** | A third channel, and the first the **operator** opens rather than the agent. Not a job container: no minted token, no provider key, no agent running, started only by a keypress. It re-mounts a finished run's workspace, which for a forge job holds attacker-influenced code — the same trust shape as checking out a stranger's pull request locally. Every isolation flag still applies; ports it publishes are `127.0.0.1`-only and last only while it does |
| Receiver, worker, queue, admin extension | Trusted | They never execute agent-authored content — the admin extension feeds only PII-free, fixed-enum run records to the model; raw container output stays in the overlay viewer |

## What is defended

- **Who can trigger.** On GitHub, comment triggers require `author_association ∈ {OWNER, MEMBER,
  COLLABORATOR}`, and label triggers require an allowlisted label — since only collaborators can apply
  labels, **the label is the human approval step**, not a routing hint. A stranger's issue sits until a
  maintainer labels it.
- **Who can trigger, on GitLab — and why the rule is different there.** That reasoning does not hold on
  GitLab: the minimum role for managing labels has differed across versions, Ultimate's **custom roles**
  can grant it at any level, and **a Guest can set labels on an issue they are creating**, so a stranger
  can open an issue already carrying your trigger label. A GitLab label is therefore a routing hint and
  nothing more, and **every** GitLab trigger — labels included — is gated on the actor's API-resolved
  project `access_level >= 30` (Developer). Group-inherited membership counts; a lookup that cannot
  complete answers 503 and is redelivered rather than silently dropped. `OQ-013` records the residual:
  this gate depends on a network call, and on a role table that varies by version and edition.
- **Webhook authenticity.** Every source is verified over the **raw** body, timing-safe, before parsing.
  Without this every other gate collapses, because the label and author checks would be reading fields
  from a body nobody authenticated. GitHub: the `X-Hub-Signature-256` HMAC. GitLab: either the
  `webhook-signature` HMAC (19.0+) or an `X-Gitlab-Token` compare — you declare which, and only that one
  is accepted, so a sender cannot choose the weaker gate. **Token mode is genuinely weaker**: it proves
  the sender knew a secret, and nothing at all about whether the body arrived as it was sent. Prefer
  `signature` where your instance supports it.
- **Isolation.** One ephemeral container per job: `--cap-drop=ALL`, `--security-opt no-new-privileges`,
  memory/CPU/pids limits, non-root, `--rm`. Per-job rather than per-session, so state cannot leak
  between mutually-untrusting issue authors.
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
- **CI integrity — on GitHub.** The token is minimally-permissioned — `contents` and `pull-requests`,
  **not** `workflows`, which is a separate scope. For a fine-grained PAT this is an operator-set property.
  An injected agent therefore cannot rewrite `.github/workflows/` even though it can write code. This one
  holds.
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
  unrestricted network egress — where previously they could only supply text the agent reads. What bounds
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
  Whichever it is, the *isolation* holds — `--cap-drop=ALL`, non-root, `/job` read-only, the closed env
  allowlist and the four mounts are all built by the worker's `docker run` argv, so nothing an image contains
  can weaken them. What is **not** checked is the image's contents, and every way that can be wrong fails
  **silently**: absent guardrails at `/opt/pi-dispatch/HARD_RULES.md` remove the safety floor with no error;
  a stale pi turns jobs into no-ops that report success; wrong exit codes make the queue pay to retry work
  that can never succeed; and the loader flags above are **per image**, so a multi-tenant deployment that
  turned discovery off in one image has **not** turned it off in another. What bounds it: only an operator
  editing `triggers.json` can name an image (no tool parameter, no panel key, no settings-overlay key), and
  jobs run with `--pull=never` behind a pre-spend presence check, so the only images that can run are ones
  you built or pulled onto that host yourself. `docs/job-image.md` is the conformance checklist; `OQ-012` in
  `specs/open-questions.md` is the honest statement of what nothing here can check.
- **`run.replicas` multiplies budget reservations by N, and the caps are the only ceiling.** A github
  trigger carrying `run.replicas: 2` turns one delivery into two independent paid jobs — two containers,
  two token bills, two pull requests. Nothing about that is a bypass: each replica reserves its own slot
  before its own tokens, so the daily, weekly and monthly caps still bound the blast radius exactly as they
  did — they simply divide by N, and a cap sized for one job per delivery now covers half as many
  deliveries. The field is a **file edit only**: no tool parameter, no panel key, no settings-overlay key,
  so nothing a model can reach turns your spend into a multiple. It is refused on cron/local triggers and
  alongside `run.resume`. One residual is stated rather than defended: on a **pull_request**-typed target
  the replicas share the pull request's head branch, and only the prompt asks them not to collide
  (`OQ-017`).
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
- **Network egress from the job container is unrestricted.** There is no allowlist proxy in v1. A job
  can reach the internet. If an agent is successfully induced to exfiltrate its environment, egress
  filtering will not stop it — the token's short expiry and narrow scope are what bound the damage. Run this on
  hardware where that is acceptable, or put an egress policy on the Docker network yourself.
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
  folder can commit that opt-in, after which a **later** operator or CLI action could run that flow. This
  is bounded by the local trust model — "whatever can write the folder can trigger it" — and by the
  **pre-agent SHA** the gate reads at: the SHA forecloses self-authorization within the **same** job and
  its own children, but it does **not** stop a later operator or CLI run of the planted flow. Both halves
  hold; neither is undo.
- **A prompt injection in the operator's session can invoke `dispatch_run` — a paid run with no undo, and
  it is NOT money-safe.** `dispatch_run` is a **third** model-callable tool alongside reads and
  `pause`/`resume`, and unlike them it spends money editing a folder in place with no undo — an explicit
  break from the pause/resume "money-safe" framing that governs the other tools. It is bounded in
  blast-radius, not prevented, by **six** independent limits: the folder allowlist `PI_DISPATCH_RUN_ROOTS`
  (realpath + containment); the committed per-flow opt-in (default deny, read at a pre-agent SHA); the
  dirty-tree refusal (no force option); no spend-knob parameters on the tool; a per-hour rate limit; and
  the daily cap (`CONST-BUDGET-BEFORE-TOKENS`). Do not read it as money-safe or reversible — it is neither.

- **A resumed session hands one job's transcript to the next job on the same key.** With
  `"resume": true` on a trigger, the agent's full working history — tool output, file contents, its own
  reasoning — is written to `PI_SESSIONS_DIR` and replayed into the next job for the same repository and
  head branch. It is **off by default**; turning it on is consent to persist that material. The key is a
  **branch name**, and branch names are chosen by anyone who can push to the base repository — so the
  population that can be handed a transcript is your repository's push-access population, not the issue's
  author. **A fork pull request never resumes anything**, which is what stops a stranger naming a branch
  `pi/issue-7` and being handed issue 7's history. Two consequences worth stating because they are not
  obvious. With unrestricted egress (above), a single later job on that key can exfiltrate the whole
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
  never seen.

## Operator responsibilities

- **Protect your default branch.** Require a pull-request review, forbid force-pushes. This is not a
  suggestion — it is the only technical control standing between an injected agent and your `main`. The
  worker refuses to run without it, and you should not work around that.
- Set a provider spend limit and a daily job cap.
- Do not blanket-forward host environment into job containers. Pass only the variables the configured
  provider needs. In particular `ANTHROPIC_OAUTH_TOKEN` silently takes precedence over
  `ANTHROPIC_API_KEY`, so a stray variable in the host environment can quietly redirect which credential
  a job spends. Every minted-token name — `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN` — is
  refused in `PI_FORWARD_ENV` at config load: the worker sets them from the per-job mint, and a forwarded
  operator token would silently override it.
- **With `GITHUB_AUTH_SOURCE=gh` (the default), your entire gh login reaches every token-carrying job.**
  The minted value is your own full-scope `gh auth token`, and `pi-dispatch doctor` warns and names the
  scopes it carries (calling out broad ones like `admin:org`, `delete_repo`, `workflow`). Prefer a
  fine-grained PAT — or an App — for real per-job scoping. Your `~/.config/gh` is never mounted into a
  container; the credential reaches jobs only as env values.
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
  never a mounted file. Overlay **extensions run arbitrary code against adversarial input with open network
  egress** and are not scanned for secrets — and they are staged and loaded **by default**. `import-pi`
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
  inside the same overlay and pass four gates: an **exact** version in `pi-packages.json` (a floating
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
  `PI_SESSIONS_TTL_DAYS`. Retention here is not disk hygiene: a stale transcript is a **live input to a
  future job**, so an old file is a correctness problem before it is a capacity problem.
  `pi-dispatch doctor` reports the store and warns whenever a trigger arms the flag.
