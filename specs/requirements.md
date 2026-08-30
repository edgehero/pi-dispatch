# Requirements

What pi-dispatch must do. Design decisions live in `design.md`; non-negotiable constraints live in
`constitution.md`. This file is the acceptance surface.

Evidence convention as in `constitution.md`: `Evidence (upstream)` is authoritative, `Reference` is not.

## Scope

Run pi as a self-hosted harness that executes each job in an isolated container, follows a predefined
flow, supports frontend work with visual verification, and survives burst load without dropping work.

A job is a **trigger × target** (see `DES-CRON-VIA-BULLMQ-SCHEDULER`):

- **Targets**: a **local folder** on the operator's machine (edited in place — the primary self-hosted
  use, needs only a provider key), or a **repository on a forge** — GitHub or GitLab — cloned, worked, and
  opened as a pull or merge request. A forge target needs a credential for that forge
  (`CONST-TOKEN-SCOPED-PER-JOB`): on GitHub `gh`, a fine-grained PAT or an App; on GitLab a project access
  token. *(The old wording said a GitHub App was required. That has been false since `OQ-006` closed and
  `CONST-TOKEN-SCOPED-PER-JOB` was made mechanism-neutral on 2026-07-17; corrected here.)*
- **Triggers**: the **CLI** (operator-initiated, `DES-CLI-TRIGGER-FOR-LOCAL`; the admin extension operates
  the queue and triggers no jobs except the gated `dispatch_run` enqueue), a **webhook** (issue, comment
  or pull/merge-request activity on a forge), or **cron** (a schedule).

Everything below the trigger is identical **in shape**: budget check → `/job:ro` inputs → one container →
the runner → an exit code — the same argv, the same isolation flags, the same env allowlist, the same
mounts. What differs is authz (a write-access gate for webhooks vs CLI access for
local), the credential (a scoped per-forge token for forge jobs vs none for local), the completion signal
(an issue comment or a GitLab note vs the console, or the admin extension's runs view — see `REQ-JOB-STATUS-COMMENTS` and `REQ-LOCAL-JOB-VISIBILITY`),
and — since `run.image` — **which image that one container is**, which changes the toolchain inside the box
and nothing about the box itself (`INT-CONTAINER-RUNTIME-CONTRACT`).

**Out of scope**: being a hosted service; multi-tenancy; merging anything.

---

## REQ-QUEUE-BURST-NO-DROP

- **Statement**: 50 deliveries arriving within 60 seconds shall produce 50 durably queued jobs. None
  dropped, none coalesced except by an explicit dedup key. All shall eventually execute.
- **Why**: This is the single differentiator and the reason the project exists. pi has no cross-session
  queue at all; the closest existing tool drops fires past a queue depth of 3 and does not coordinate
  across processes. 50 is the observed shape of label-spam and bulk-triage bursts, not an architectural
  bound — the real bound is Redis memory. Relax this and the harness is a toy that loses work silently,
  which is worse than not existing, because the requester believes it ran.
- **Evidence (upstream)**: `Davidcreador/pi-routines @ 6d2aa64 → src/types.ts:423 → MAX_QUEUE_DEPTH = 3`
  · `→ src/guard.ts → isRoutineTurnActive` (single-flight)
- **Traces to**: `DES-QUEUE-BULLMQ-OVER-CUSTOM`, `REQ-DEDUP-BY-DELIVERY-GUID`
- **Acceptance**: Given concurrency 3 and 50 distinct deliveries within 60s, queue depth reaches 50, all
  50 execute, zero are lost, and process memory stays flat.

## REQ-RUNNER-TURN-BUDGET

- **Statement**: The runner shall count agent turns and call `session.abort()` on exceeding a configured
  maximum. The maximum is a config knob with a conservative default.
- **Scope**: **Root-session turns only.** The counter subscribes to the root `AgentSession`'s bus, and that
  bus is per instance — a subagent session an extension spawns through `createAgentSession` emits no
  `turn_start` on it (`INT-SDK-SESSION-OPTIONS`), so a 16-wide fanout registers here as roughly **one** turn.
  This bound is per-session by construction and is not claimed to be process-wide; the process-wide spend
  control is the token meter in `REQ-TOKEN-ACCOUNTING-AND-CAPS`.
- **Why**: **pi has no max-turns, step-limit, or iteration cap of any kind.** The agent loop is a bare
  `while (true)` bounded only by an `AbortSignal`; the only control surface is `session.abort()`. The
  design document assumed pi provided this and listed it as "verify" — it does not, so we build it.
  Critically, `REQ-JOB-TIMEOUT-30M` does **not** substitute: that bounds *wall-clock*, and an agent can
  burn 200 turns of tokens in 29 minutes and exit "successfully" while blowing the money budget
  entirely. Time and spend are different axes and each needs its own bound.
  *Negative fact — this requirement exists because of an upstream absence.* If pi ships max-turns, this
  becomes deletable; the absence is named here so a future maintainer knows it is safe to delete rather
  than leaving it as unexplained ballast.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf` — repo-wide search of `packages/*/src` for
  `maxTurns|max_turns|maxSteps|max_steps|maxIterations|stepLimit|turnLimit` returns **zero hits** ·
  `→ packages/agent/src/agent-loop.ts:170 → while (true)` — an outer `while (true)` wrapping an inner
  `while (hasMoreToolCalls || pendingMessages.length > 0)`; both unbounded except by the `AbortSignal` ·
  `→ core/agent-session.ts:1530 → abort()` (the only control surface) ·
  `→ packages/agent/src/types.ts:420 → | { type: "turn_start" }` — **the event carries no turn index**,
  so the runner must keep its own counter. Note `agent-session.ts:706-712` builds a *different*
  `TurnStartEvent` **with** `turnIndex` — but that is emitted only to the **extension** runner, whereas
  `subscribe()` receives the bare `AgentEvent` (`agent-session.ts:136` —
  `AgentSessionEvent = Exclude<AgentEvent, {type:"agent_end"}> | …`). Counting `turn_start` off
  `subscribe()` is correct; expecting `turnIndex` there is not ·
  `→ agent-loop.ts:176` (first turn's `turn_start` is emitted before the loop, subsequent ones inside —
  so the count is the true turn count)
- **Traces to**: `CONST-BUDGET-BEFORE-TOKENS`, `REQ-JOB-TIMEOUT-30M`, `REQ-UPSTREAM-CONTRACT-TESTS`
- **Acceptance**: Given a flow that would exceed the turn maximum, the runner aborts at the threshold and
  exits with the policy code, not the infra code.
- **Open**: the default N is underived. It should come from `OQ-002`'s measurement plus a target
  cost-per-job. Until then it is a conservative knob, not an evidenced threshold.

## REQ-UPSTREAM-CONTRACT-TESTS

- **Statement**: The image build shall assert every pinned assumption about pi, and fail the build when
  one no longer holds. No image publishes on a failed assertion. **"The image" here means the image this
  repo builds and publishes.** A trigger's `run.image` (`INT-TRIGGERS-FILE-CONTRACT`) may name an image this
  repo never built, whose build ran **no assertion at all** — so *"no image publishes on a failed
  assertion"* is a statement about **our** publish step and is silent about an operator's. The gap is
  deliberate, is registered as `OQ-012` rather than papered over here, and has a partial answer: the
  assertions below are the checklist an operator-built image should be held to, and the `image` job is
  written so it can be pointed at an arbitrary tag (`docs/job-image.md`).
- **Why**: pi ships breaking changes between minors, and its HEAD moved within 24 hours of this
  project's design being written. `CONST-PI-VERSION-PINNED` makes an upgrade an explicit commit, so CI
  fires on it and these tests are the gate. A prose checklist depends on a maintainer reading it at 11pm
  during an upgrade; a failing build does not. **The assumptions worth asserting are exactly the ones
  that fail silently** — a crash is self-reporting and needs no test. Each assertion below maps to a
  point where the design document was wrong and nothing would have told us:
  - the baked `APPEND_SYSTEM.md` **and** a per-flow append both appear in the assembled prompt
    (the `??` trap drops the persona with no error, as does a forgotten `reload()`);
  - the repo's `AGENTS.md` fixture sentinel appears in `getAgentsFiles()` and **nowhere in the append
    block** — the *inverse* of what this bullet asserted while `CONST-NO-CONTEXT-FILES-MANDATORY`
    mandated `noContextFiles: true`, and the acceptance clause of the amendment that replaced it. The
    silent failure being guarded moved rather than vanished: it used to be "discovery was left on by
    omission", and is now "the repo's conventions stopped arriving, or arrived spliced into the safety
    floor". Both are invisible at runtime, which is why the assertion is still here;
  - a repo `.pi/extensions` entry's factory **ran**, while an admin-named or `dispatch_*`-registering one
    is **absent** from the loaded set — the recursion guard, pinned on outcome rather than on the flag,
    because project-resource discovery hangs on a pi default (`isProjectTrusted()`) that would take this
    whole path down without a word if it flipped;
  - a repo skill resolves **once**, from `/job/pi/skills` — `noSkills` staying `true` is what keeps the
    pinned-SHA read-only mount the copy in force, and a regression there is a silent swap to the writable
    working tree, not an error;
  - Chromium launches as the non-root runtime user (the `PLAYWRIGHT_BROWSERS_PATH` collision);
  - `pi -p` exits 0 (catches a flag rename);
  - the runner's turn budget fires at N **and exits 2** — not 0;
  - **a simulated provider error exits 1 — not 0.** Inside the agent loop pi does **not** throw: an
    abort, a 429, a 5xx and a dead network all resolve `prompt()` normally, so a `try`/`catch`-only
    runner reports success for every infra failure. This assertion is the only thing standing between us
    and a queue that cheerfully records success for jobs that did nothing.
  - **a missing API key exits 2 — not 1, and does not crash.** Preflight **does** throw (pi's own JSDoc
    says so), so a `stopReason`-only runner dies of an unhandled rejection and exits Node's default `1`
    — which this protocol defines as *retryable*, making the queue pay to retry a job that can never
    succeed. The two assertions above are deliberately a **pair**: each catches the failure the other's
    implementation causes. See `INT-RUNNER-EXIT-CODE-PROTOCOL`.
  - **`stopReason: "length"` exits 0 and is logged** — all five stop reasons are enumerated. A
    default-to-0 branch maps a truncated run to silent success.

  **Cost note — these are nearly all free.** The loader-boundary assertions are pure. The assembled-prompt
  assertions run through an inline extension on `before_agent_start`, which fires strictly before any
  provider HTTP call. No API key, no tokens, no flake. There is no excuse for not running them on every
  build.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → CHANGELOG.md:5-10` (`[Unreleased]` breaking
  change in flight)
- **Traces to**: `CONST-PI-VERSION-PINNED`, `CONST-NO-CONTEXT-FILES-MANDATORY`, `INT-SDK-SESSION-OPTIONS`,
  `OQ-005`
- **Acceptance**: Given a version bump where a pinned assumption breaks, the build fails and publishes
  nothing. Given an **operator-built** image named in `run.image`,
  **nothing in this repo gates it**; the same suite is runnable against that tag by the operator
  (`docs/job-image.md`), and the residual is `OQ-012`.

## REQ-DEDUP-BY-DELIVERY-GUID

- **Statement**: `jobId` shall be the forge's own per-delivery id — GitHub's `X-GitHub-Delivery` GUID
  (`gh-` prefixed), GitLab's `webhook-id` / `Idempotency-Key` (`gl-` prefixed) — giving exactly-once
  semantics per delivery **for as long as the job key is retained**. The prefixes keep the two id spaces
  disjoint, so a value that collided across forges could never suppress the other's job. `removeOnComplete` / `removeOnFail` retention
  shall therefore be set to meet or exceed GitHub's redelivery window.
- **Why**: GitHub redelivers on timeout. A redelivered job is a second paid agent run **and** a second
  pull request on one issue — visible, embarrassing, and billed. The GUID rather than `repo#issue`
  because it is exactly-per-delivery and GitHub-generated, so no coordination is needed and the queue
  can reject the duplicate without a lookup. Semantic dedup on `repo#issue:flow` is a separate, additive
  window for coalescing label-spam, not a replacement.
  **The guarantee is retention-bounded, not absolute** — this qualifier is load-bearing and was missing.
  BullMQ's dedup is literally `if rcall("EXISTS", jobIdKey) == 1 then return handleDuplicatedJob(...)`:
  it is a key-existence test and nothing more. Once `removeOnComplete` deletes the job hash, the same
  GUID is added **fresh**, with no memory that it ever ran. The source design document paired a 7-day
  `removeOnComplete` with a claim of exactly-once; GitHub retains deliveries for roughly 30 days and
  permits manual redelivery throughout, so days 8–30 were an unguarded gap. Retention is not
  housekeeping here — **it *is* the dedup window**, and shortening it silently shortens the guarantee.
  **GitLab keeps `webhook-id` constant across its own retries**, which is exactly the property this
  requirement needs, so the guarantee transfers unchanged — and so does the retention bound.
  `Idempotency-Key` is the same value under its original name and requires **GitLab 17.4 or later**; an
  older instance is **refused at the receiver with 400**, naming the version, rather than served on a key
  synthesised from the payload. A synthesised key — object id plus action, say — is not stable across a
  retry that changed nothing an operator can see, so it would dedup some redeliveries and bill for the
  rest: a weaker guarantee wearing this requirement's name, which is worse than a clear refusal.
  The **semantic** window's key gains a target-type discriminator on GitLab, where issues and merge
  requests are separate per-project sequences: `project#5` and `project!5` are different objects that one
  `repo#number` key would coalesce into a single window. On GitHub they share one sequence, which is why
  its key never needed one — a fact about GitHub, not about forges.
  **The semantic key's flow slot carries a `closed:` prefix for close-triggered jobs** (issue #231),
  derived from the matched rule (the `issue` type, or a matched PR close-action word from the shared
  table) and never from a job field. Without it, a label/comment/PR job on the same target and flow
  inside the window silently swallows the close job — and a swallowed close job writes no run record, so
  the once trigger it was meant to spend never disarms: a permanently dead one-shot. Every non-close
  job's key is byte-identical to before; the prefix cannot be spelled by a real flow because `:` is
  outside the skill-name charset the loader enforces on webhook flows, the same argument `cmd:` already
  stands on. The delivery-GUID layer above is UNCHANGED by #231, checked.
- **Evidence (upstream)**: `taskforcesh/bullmq @ v5.80.4 → src/commands/addStandardJob-9.lua:88-93`
  (`EXISTS jobIdKey` → `handleDuplicatedJob`; a duplicate add is a silent no-op, not a throw)
- **Traces to**: `REQ-QUEUE-BURST-NO-DROP`, `CONST-RETRY-INFRA-ONLY`
- **Acceptance**: Given the same delivery id twice **within the retention window** — on either forge —
  the second add is ignored and exactly one job runs. Given a GitLab delivery carrying neither
  `webhook-id` nor `Idempotency-Key`, the receiver returns 400 and enqueues nothing. Given a GitLab issue
  `#5` and a merge request `!5` in one project firing the same flow, both run. Given a redelivery after retention has expired, a new job runs — this
  is accepted and documented, not a defect, but it must be a *chosen* window rather than an inherited
  default.

## REQ-TRIGGER-AUTHOR-GATE

- **Statement**: The receiver shall enqueue only for: allowlisted issue labels; comments whose author
  clears the forge's write-access gate and which match the trigger phrase; and pull/merge-request events
  whose approval gate is satisfied. On **GitHub** the author gate is the payload's `author_association ∈
  {OWNER, MEMBER, COLLABORATOR}`; on **GitLab** it is an API-resolved project `access_level >= 30`
  (Developer), applied to **every** trigger type including labels, because a GitLab label is not an
  approval (`CONST-TRIGGER-AUTHOR-GATE`). Events sent by our own identity — the App's bot user, the PAT
  user, or the GitLab token's bot user — shall be ignored. The label
  allowlist is a `{any, all, none}` predicate over the label set: `any` is an OR requirement, `all` a
  stricter AND requirement, and `none` is **suppress-only** — it can never cause a trigger, only prevent
  one. A label rule (and a `labeled` PR rule) shall carry at least one positive selector (a non-empty
  `any` or `all`). For a `pull_request`: `action: labeled` is gated by the label predicate (a
  collaborator-applied label is the approval); `action ∈ {opened, synchronize, reopened}` is gated by the
  PR `author_association ∈ {OWNER, MEMBER, COLLABORATOR}`; and `action: review_submitted` (the
  `pull_request_review` event's `submitted` action) is gated by the **reviewer's**
  `review.author_association ∈ {OWNER, MEMBER, COLLABORATOR}`, never the PR author's. All three are
  hard-coded in the filter, never config-optional. A comment carrying `issue.pull_request` is a PR-context
  comment and enqueues a pull_request target. On a comment rule that names `run.command` (issue #189), the
  `<phrase> <flow>` trailing-word flow override is **inert**: trailing text neither retargets nor
  suppresses the command and reaches the job only as data (`/job/event.json`), and the receiver's
  known-flows set is built from flow-carrying rules only, so a command name is never summonable by
  comment (`INT-TRIGGERS-FILE-CONTRACT`). A `review_submitted` rule may carry an optional
  `on.reviewState` narrowing which verdicts fire (`INT-TRIGGERS-FILE-CONTRACT`); an unlisted verdict drops
  as `review-state-not-matched`. A `commented` review with an empty body drops as `no-review-body` rather
  than starting a run on nothing; an empty-bodied `approved` or `changes_requested` still fires.
- **Why**: The enforcement of `CONST-TRIGGER-AUTHOR-GATE`. The bot-loop guard matters independently: our
  own job comments on the issue — or pushes to a PR head branch, which fires `pull_request.synchronize` —
  an event that without the guard triggers another job, an unbounded paid recursion. The positive-selector
  requirement is what keeps a `none`-only rule — which would match every labeled event lacking the excluded
  labels, wider than a single-label OR — from ever loading. The PR auto-action author gate is
  load-bearing money control: without it, any fork PR opened by a stranger launches a paid agent run.
  The review arm reads a **different field** because a review is the first GitHub event whose actor is not
  the PR author, and reading the PR's field there fails in both directions at once — see
  `CONST-TRIGGER-AUTHOR-GATE` for the argument. Two acceptance cases below are therefore a pair: a
  delivery whose two associations agree passes against either field and pins nothing.
- **Where the GitLab lookup runs, and why it is not in the gate**: `filter.mjs` and `filter-gitlab.mjs`
  import nothing side-effecting, do no I/O and never throw. That purity is what makes the
  security-critical decision unit-testable without a server, a socket or a queue, so the access-level
  lookup happens in the **receiver** — after verification, before the gate — and its result is passed in
  as a plain number, occupying the slot `author_association` holds on the GitHub side. Its three outcomes
  are deliberately not two: a level (including 0 for a determinate 404) goes to the gate; an
  **indeterminate** lookup is a **503**, so GitLab redelivers and the stable `webhook-id` dedups the
  retry. Answering 204 there would drop real work during an outage and look identical on the wire to a
  stranger being correctly refused.
- **Traces to**: `CONST-TRIGGER-AUTHOR-GATE`, `CONST-HMAC-OVER-RAW-BODY`, `OQ-013`, `OQ-020`
- **Acceptance**: Given `@pi fix this` with `author_association: NONE`, 204 and zero jobs. Given a
  comment from our own App id, 204 and zero jobs. Given a GitLab issue opened by a Guest with the trigger
  label already applied, 204 and zero jobs. Given a GitLab access lookup that could not complete, 503 and
  zero jobs — never 204. Given a flow rule with no positive selector (`none`
  only, or empty), config load fails and the receiver does not boot. Given a `pull_request.opened` whose
  PR `author_association` is not a collaborator, 204 and zero jobs; given the same from a `COLLABORATOR`,
  exactly one job. Given a `pull_request.synchronize` whose `sender.id` is our own identity, 204 and zero
  jobs (the bot-loop guard). Given a `pull_request_review.submitted` with `review.author_association:
  COLLABORATOR` and `pull_request.author_association: NONE`, exactly one job; given the mirror
  (`review` `NONE`, `pull_request` `OWNER`), 204 and zero jobs — the two together are what catch a gate
  reading the wrong field. Given a `commented` review whose body is empty or whitespace, 204 and zero
  jobs; given an `approved` review whose body is empty, one job. Given a review whose verdict is outside a
  configured `on.reviewState`, 204 and zero jobs. Given a review whose `sender.id` is our own identity,
  204 and zero jobs. Given `@pi review` from a collaborator matching a comment rule that names
  `run.command`, exactly one job running that rule's own command, the trailing word carried as data and
  never as a flow override or a suppression.

## REQ-JOB-TIMEOUT-30M

- **Statement**: A container exceeding 30 minutes shall be stopped and the job failed.
- **Why**: Bounds *wall-clock*, which `REQ-RUNNER-TURN-BUDGET` does not. A wedged agent otherwise holds
  one of three worker slots indefinitely — a single runaway costs 33% of throughput. 30 minutes is ~3×
  headroom over the ~10-minutes-per-job working assumption. Note the design document framed this as the
  coarse control with pi's max-turns as the fine one; **pi has no fine one**, so this and the turn budget
  are both required and neither substitutes for the other.
- **Traces to**: `REQ-RUNNER-TURN-BUDGET`
- **Acceptance**: Given a job that hangs, the container is stopped at 30 minutes and the slot is freed.
- **Open**: 30 minutes is inherited unmeasured. Honest v1 default, not an evidenced threshold.

## REQ-FRONTEND-VISUAL-VERIFY

- **Statement**: A frontend flow shall start a dev server, screenshot the affected page, make changes,
  re-screenshot, and iterate to a maximum of 5 rounds, attaching before/after images to the PR.
- **Why**: The capability that motivates the project — precisely the limitation of hosted agent routines
  being worked around. Capped at 5 because each round is a full paid turn against an unbounded aesthetic
  goal ("make it look better" never terminates on its own); uncapped, this loop *is* the runaway.
- **Traces to**: `DES-PLAYWRIGHT-CLI-NOT-CHROME-DEVTOOLS`, `REQ-RUNNER-TURN-BUDGET`
- **Acceptance**: Given a `pi:frontend` job that changes a page, the PR body contains at least two image
  attachments.
- **Open**: 5 rounds is inherited unmeasured. Honest v1 default.

## REQ-JOB-STATUS-COMMENTS

- **Statement**: Each **forge-backed** job shall comment on its triggering issue, pull request or merge
  request at start, and on completion or failure.
- **Scope**: Forge-backed jobs (github, gitlab). A local-folder job has no issue to comment on; its
  equivalent is `REQ-LOCAL-JOB-VISIBILITY`. Stated explicitly because the original requirement assumed every job is a
  GitHub issue — it is not.
- **Why**: State must be visible where the human already is — the issue thread. An admin surface the
  operator must deliberately open (now the pi-extension session) does not change that; the issue thread is
  where the requester is already looking, and is the only surface a non-maintainer ever sees. It is also the **only** signal for
  `CONST-PI-VERSION-PINNED`'s silent-no-op failure mode: if an upstream break makes every job a no-op,
  the queue still reports success — a missing completion comment is what a human would actually notice.
- **Traces to**: `CONST-MERGE-NEVER-AUTOMATIC`, `CONST-PI-VERSION-PINNED`
- **Acceptance**: Given any forge-backed job reaching a terminal state, exactly one completion or failure
  comment exists on the issue — posted through that forge's own endpoint, which on GitLab means the merge
  request notes path for a merge-request target and the issue notes path for an issue.

## REQ-BRANCH-PROTECTION-PRECONDITION

- **Statement**: The worker shall refuse a **forge-backed** job whose default branch is unprotected,
  before reserving budget or starting a container.
- **Scope**: Forge-backed jobs (github, gitlab). A local-folder job has no remote branch to protect.
- **Why**: The per-job credential carries `contents:write`, which covers push **and** merge, so branch
  protection is the only technical barrier to a self-merge — the precondition is the operational
  backstop for `CONST-MERGE-NEVER-AUTOMATIC`. The check is consulted before any spend so a repo that
  cannot satisfy it costs nothing: a determinate "no protection" answer is a policy refusal, while any
  other error is retryable and must never be read as a silent "unprotected" that would bypass the
  backstop.
  **How "determinate" is established is per forge, and is not transferable.** On GitHub it is a `404`
  from the protection endpoint. GitLab has no such 404 to lean on, so the check reads the
  `protected_branches` **list**, which answers `200` with `[]` — and `[]` is determinate where a 404 would
  be indistinguishable from a project that does not exist or a token that cannot see it. The list is also
  what makes **wildcard** protections work: GitLab rules may be patterns (`release/*`, `*`), and an
  exact-name lookup would report a covered branch unprotected and refuse a job that should have run.
  Issue #61 records the failure this ordering exists to avoid: carrying one forge's 404 semantics to
  another made every branch report unprotected and silently disarmed the backstop.
  `pi-dispatch doctor` additionally states the enforcement point at setup time (issue #80): github
  triggers take their repository from each delivery, so per-repo protection **cannot be preflighted
  statically** — doctor says so, and says where the check actually runs (per job, before any spend).
  A read-only per-repo preflight helper exists (`gh api`, warn-never-fail, capped, never offers to
  enable protection — that control must stay the operator's on the forge) but is dormant until
  something statically names github repos to check; `run.repository` is an azure-only field today.
  The refusal itself stays in the worker pre-spend either way.
- **Traces to**: `CONST-MERGE-NEVER-AUTOMATIC`, `CONST-TOKEN-SCOPED-PER-JOB`, `CONST-BUDGET-BEFORE-TOKENS`
- **Acceptance**: Given a forge-backed job whose default branch has no protection, the worker returns a
  policy refusal before `reserveBudget` and before any container starts — no budget slot is consumed, no
  provider spend occurs, and a refusal comment is posted to the issue. A transient protection-API error is
  retried, not treated as unprotected — on GitHub any non-`404`, on GitLab **any** non-200, since there is
  no status there that may read as "unprotected". Given a GitLab default branch covered only by a wildcard
  rule, the job is admitted.

## REQ-LOCAL-JOB-VISIBILITY

- **Statement**: A local-folder job shall surface its outcome where the operator is already looking — the
  worker's console — at start and on completion or failure, and in the admin extension's `runs` view
  (`REQ-ADMIN-VIA-PI-EXTENSION`). The container's own output shall stream to that console during the run.
- **Why**: The local counterpart of `REQ-JOB-STATUS-COMMENTS`, and it carries the same load: it is the
  signal for `CONST-PI-VERSION-PINNED`'s silent-no-op failure mode. A local job has no issue thread, so
  without a console signal a broken run would still report success to the queue and a human would notice
  nothing. Streaming the container output is not a debug nicety — on the operator's own machine, watching
  the agent work on their own folder is the primary feedback surface, and a missing completion line is
  what tells them a run did nothing.
- **Note on logs**: in a terminal this is the operator's own console for their own folder, not a
  persistent multi-user log. **Under a service manager it becomes one**: the console is the manager's
  captured, persistent log (systemd's journald, launchd's `StandardOutPath`, nssm's `AppStdout`), so
  `no-pii-in-logs` applies to it directly — not only to hypothetical *stored* logs. Log the stable job id
  and outcome, not task bodies.
- **Traces to**: `CONST-PI-VERSION-PINNED`, `DES-CLI-TRIGGER-FOR-LOCAL`, `INT-RUNNER-EXIT-CODE-PROTOCOL`
- **Acceptance**: Given a local job reaching a terminal state, the worker console shows exactly one
  completion or failure line carrying the job id and outcome; during the run, the container's output is
  visible there.

## REQ-CRON-SCHEDULED-JOBS

- **Statement**: Scheduled jobs shall be driven by BullMQ **Job Schedulers** (`upsertJobScheduler`), one
  per configured schedule. A schedule is a **trigger, not a job kind**: on each tick it emits an ordinary
  `kind:"local"` job that flows through the **same** processor as an interactively-triggered local job.
- **Why**: An unattended recurring trigger spends real money against a paid provider with nobody watching,
  so every failure mode of the scheduler is a money-or-silence failure. Job Schedulers are a Redis-resident
  object (survives worker and Redis-under-AOF restart) and give no-backfill and an at-most-one-unstarted-
  occurrence bound for free — NOT no-overlap, which this entry falsely claimed until issue #242: the next
  occurrence is minted at pickup and promoted on time alone, so a slow run overlaps its successor whenever
  a concurrency slot is free, and same-folder serialization is supplied by the worker's folder mutex
  (`REQ-SCOPED-LIMITS`), not the scheduler. Reimplementing the scheduler's own properties is still the
  four-mechanism drowning `DES-CRON-VIA-BULLMQ-SCHEDULER` refused. The
  scheduler is also the one path that **bypasses `maxStalledCount`** (`CONST-RETRY-INFRA-ONLY`), so the
  stall backstop must be rebuilt explicitly; and because it fires while nobody watches, a `-10`/`-11`
  silent no-op or an in-tick retry storm would be invisible without the loud-surfacing and no-retry rules
  below.
- **Traces to**: `DES-CRON-VIA-BULLMQ-SCHEDULER`, `CONST-RETRY-INFRA-ONLY`, `CONST-BUDGET-BEFORE-TOKENS`,
  `REQ-RUNNER-TURN-BUDGET`
- **Acceptance**:
  - Given a config with N schedules, when the worker loads them, then it calls `upsertJobScheduler` once
    per schedule; a `-10` (`SchedulerJobIdCollision`) or `-11` (`SchedulerJobSlotsBusy`) result — whether
    thrown or returned — is surfaced loudly (logged and the load fails), never swallowed into a silent
    no-op.
  - Given a scheduler whose per-scheduler stall counter exceeds `PI_SCHEDULER_STALL_MAX`, when the next
    stall is observed, then the scheduler is torn down via `removeJobScheduler` — the explicit backstop for
    the `maxStalledCount` carve-out.
  - Given a worker that was down across one or more due ticks, when it restarts, then exactly one job is
    emitted (no backfill), and at most one UNSTARTED next occurrence exists for a schedule at any time.
    Two occurrences of one schedule CAN be in flight together when a slot is free — the false "no
    overlap" claim this line carried until issue #242 — except on one folder: two local jobs naming one
    `run.folder` (by resolved path, within one worker process) never run concurrently, the second
    deferred to the delayed set with its attempt count untouched (`REQ-SCOPED-LIMITS`, the mutex).
  - Given a scheduler resident in Redis but absent from the current config, when the worker performs its
    startup reconcile, then the orphaned scheduler is removed.
  - Given a schedule entry with `kind:"github"`, when the config loads, then the entry is rejected — a
    scheduled trigger supplies no webhook delivery, issue number, title, or body, so only `kind:"local"`
    is admissible.
  - Given a scheduled occurrence that fails (including an infra fault), when the tick concludes, then the
    occurrence is **not** retried within the tick — the schedule's own cadence is the retry.
  - Given a cron entry naming `run.command` instead of `run.flow` (issue #189), when the config loads,
    then it loads in **both services** (the shared validator, `DES-TRIGGERS-UNIFIED-FILE`), and when it
    fires, then the emitted job dispatches the command **headlessly** — the container prompt is exactly
    `/<command> [args]`, no model turn required for the dispatch (`DES-COMMAND-ENTRY-POINT`).
  - Given an entry carrying both `run.flow` and `run.command`, or neither, on any of the four kinds, when
    the config loads, then **both services** throw a parse-time `piDispatchConfig` error naming both
    fields (`INT-TRIGGERS-FILE-CONTRACT`).
  - Given a scheduled command job whose image's loaded extensions register no such command, when the
    runner preflights, then the job refuses as `command-unregistered` (exit 2, pre-work, never retried)
    before any model call (`INT-RUNNER-EXIT-CODE-PROTOCOL`).

## REQ-DURABLE-RUN-HISTORY

- **Statement**: For each job reaching a terminal state — completed, policy refusal, or infra failure —
  the worker shall persist a durable, PII-free status record retrievable by job id, and — when raw
  capture is explicitly enabled (`PI_CAPTURE_JOB_LOGS`) — capture the container's output to
  `logs/<jobId>.log`. Records shall survive a worker restart and outlive BullMQ's job-hash eviction. No
  new datastore.
- **Scope**: Both GitHub and local jobs. This is a **third, durable** surface — it complements, and does
  not replace, `REQ-LOCAL-JOB-VISIBILITY` (the ephemeral console line plus live stream) and
  `REQ-JOB-STATUS-COMMENTS` (the GitHub issue comment).
- **Why**: The admin extension and post-hoc debugging need a keyed, structured read-model that a scrolling
  console/journal cannot provide; the durable record is also a second, persistent signal for
  `CONST-PI-VERSION-PINNED`'s silent-no-op mode. The id-only record honours `no-pii-in-logs` — log the
  stable ids (the delivery GUID, `repo#issue`), never issue or comment bodies — while the raw
  `logs/<jobId>.log` is agent output that may echo issue text, so it is opt-in (default off) and
  gitignored. Assembled in `worker/src/run-history.mjs` and written at the terminal path in
  `worker/src/index.mjs`.
- **Traces to**: `REQ-LOCAL-JOB-VISIBILITY`, `REQ-JOB-STATUS-COMMENTS`, `INT-RUNNER-EXIT-CODE-PROTOCOL`,
  `INT-RUN-HISTORY-FILE-CONTRACT`, `CONST-PI-VERSION-PINNED`
- **Acceptance**: Given a job reaching a terminal state, a record keyed by its job id exists carrying the
  correct outcome and is present after a worker restart; the record contains no issue or comment body,
  title, or username (`target` is `repo#issue`, `project!iid` for a GitLab merge request, or `local:<basename>` — no other shape); the raw `logs/<jobId>.log`
  exists only when `PI_CAPTURE_JOB_LOGS` is set and is gitignored.

## REQ-ADMIN-VIA-PI-EXTENSION

- **Statement**: The admin surface shall ship as a pi extension in `admin/`, loaded into the operator's
  interactive pi session. It provides operator slash commands for observability (`status`, `runs`, `logs`,
  `budget`, `triggers`, and `insights` — the one analytics surface, writing and opening the artifact of
  `REQ-INSIGHTS-HTML-EXPORT`, with a `whatif` form per `REQ-COST-ANALYTICS`), queue on/off
  (`pause`/`resume`, backed by the same durable `queue.pause()`), and
  settings editing (`set`/`unset`, writing the `settings.json` overlay), plus **operator-typed trigger CRUD**
  from the overlay (add / edit-flow / delete, writing `triggers.json` — validated by the shared
  `parseTriggers`, atomic — and reloaded **live** by both services, `OQ-008`). The model-callable tools are
  **reads (`status`/`runs`/`triggers`/`costs`), `pause`/`resume`, `dispatch_run`** (a gated enqueue), and the
  **confirm-gated writes** `dispatch_set` and `dispatch_trigger_add`/`_edit`/`_delete`. A write tool applies
  its change **only after a human operator approves a `ctx.ui.confirm` dialog showing the concrete
  before→after**, and **refuses — writing nothing — when no interactive operator is present** (`ctx.hasUI`
  false; print/headless). The operator-typed overlay CRUD and the confirm-gated tools reach the **same**
  validated, atomic `writeTriggers`/`writeSettings`. `dispatch_run` still takes **no spend-knob argument**
  (`model`/`maxTurns`/`dailyCap`/`concurrency`).
  Since issue #92 the extension also carries the **first-run path**: `/dispatch setup`
  (operator-typed only — deliberately no model-callable tool; `DES-FIRST-RUN-SETUP-WIZARD`), a
  detection tree on bare `/dispatch` that offers setup **only** when no deployment exists anywhere
  (pointer, env, cwd scaffold all absent AND the queue unreachable — an ops outage on a configured
  deployment keeps the unreachable banner, never an offer), and a once-ever notify-only
  `session_start` nudge.
- **Scope**: The operator's interactive session on the worker host. The admin surface triggers no jobs
  except the gated `dispatch_run` enqueue, and is never materialised into a job's `/job` inputs —
  `INT-CONTAINER-JOB-INPUTS` mounts the serviced repo's own `.pi/` extensions, not this one.
- **Why**: See `DES-ADMIN-VIA-PI-EXTENSION` — a session-bound, port-less admin surface for a
  terminal-native operator, narrower than the superseded localhost panel. The daily cap can be raised only
  **with an operator's approval**: a settings write (dailyCap included) is either operator-typed or a
  confirm-gated tool the model **cannot self-approve** — the model emits the call, the human answers the
  confirm — so a prompt-injected session cannot raise the cap without a human keypress it cannot forge.
  `CONST-BUDGET-BEFORE-TOKENS`'s ordering is untouched (the cap is still checked before tokens; only its
  value changes, under human approval); `CONST-TRIGGER-AUTHOR-GATE`'s webhook author-gating is untouched (the
  confirm is the human approval for a locally-configured trigger). `dispatch_run` takes no spend-knob argument
  — values resolve from the overlay/env per `DES-RUNTIME-SETTINGS-FILE-OVERLAY`, and the paid run enqueues
  spends **within** the cap (`reserveBudget`, consumer-side), it does not widen it (`CONST-BUDGET-BEFORE-TOKENS`). The
  injected-`dispatch_run` residual is bounded by structure, not undo — folder allowlist, committed
  per-flow opt-in, dirty refusal, no spend knobs, per-hour rate limit, and the daily cap
  (`DES-ADMIN-VIA-PI-EXTENSION`). Raw `.log` output is overlay-only, so untrusted container text never
  enters model context (`CONST-ISSUE-TEXT-IS-DATA`, one layer down).
- **Traces to**: `DES-ADMIN-VIA-PI-EXTENSION`, `DES-AI-TRIGGER-FLOW-GATE`, `DES-JOB-OUTBOX-CHAINING`,
  `CONST-ISSUE-TEXT-IS-DATA`, `CONST-BUDGET-BEFORE-TOKENS`, `REQ-DURABLE-RUN-HISTORY`,
  `REQ-AI-TRIGGERED-RUNS`
- **Acceptance**: Given the extension is loaded, when the operator runs `/dispatch status`, then queue
  counts, paused state, and budget render with no model involvement; given a model-invoked settings OR
  trigger write tool, when no interactive operator is present (`ctx.hasUI` false), then it refuses and writes
  nothing; when an operator is present but declines the confirm, then it writes nothing and reports
  `applied:false`; when the operator approves, then it writes exactly the change the confirm showed; given an
  operator trigger edit through the overlay OR an approved write tool, when it is written, then it validates
  through the shared `parseTriggers` (a bad edit is rejected, the file untouched) and both services apply it
  without a restart; given `dispatch_run`, when
  it is invoked, then it exposes no `model`/`maxTurns`/`dailyCap`/`concurrency` argument, admits a run only
  for a folder within `PI_DISPATCH_RUN_ROOTS` and a flow whose pre-agent-SHA `SKILL.md` carries
  `ai-trigger: allow`, and the enqueued job's spend resolves from overlay/env and is bounded by the daily
  cap; given `/dispatch logs`, when
  the raw `.log` renders, then it renders in the overlay viewer and is never returned as a tool result or
  sent as a message into model context; given an operator pi whose API surface lacks any required member,
  when the extension loads, then it registers nothing and reports the unsupported version loudly;
  given an operator pi whose API surface is complete but whose version differs from the tested pin,
  then the extension loads normally and the first `/dispatch` surfaces one info-level advisory naming
  both versions — an untested pi is a notice, never a refusal (issue #96);
  given bare `/dispatch` with no deployment anywhere, then it lands directly in the wizard's opening
  select, and answering **Cancel** spawns nothing and writes nothing (the select is the consent —
  issue #96 made this the default route); given a configured deployment whose queue is down, then the
  panel opens with the unreachable banner and never the wizard; given a second pi startup after the
  nudge fired once, then no nudge renders; given a deployment whose installed runtime is older than
  the console's pin, then bare `/dispatch` surfaces one skew notice pointing at `/dispatch setup`.

## REQ-AI-TRIGGERED-RUNS

- **Statement**: The harness shall enqueue a local job on behalf of the AI from two sources — the
  model-callable `dispatch_run` tool (with its operator `/dispatch run` command) and a completed job's
  `/outbox`, collected by the worker — each subject to a **per-flow default-deny gate**: the flow's
  `.pi/skills/<flow>/SKILL.md` must carry `ai-trigger: allow` frontmatter read at a **pre-agent SHA**. A
  flowless AI trigger is refused. **Commands are never AI-triggerable, and there is no opt-in** (issue
  #189): an outbox request carrying a `command` key is refused outright (`chain-command-refused`, before
  the flow-name charset check), and `dispatch_run` speaks flows only — its parameters are
  `{folder, flow, task}`, and a slash-leading `flow` refuses with a message naming the distinction rather
  than falling through to `no-skill` (`DES-AI-TRIGGER-FLOW-GATE`, `DES-COMMAND-ENTRY-POINT`).
  The `dispatch_run` tool's folder is confined to `PI_DISPATCH_RUN_ROOTS`;
  chaining is bounded by depth, count, and rate caps (`PI_CHAIN_DEPTH_MAX`, `PI_CHAIN_MAX_PER_JOB`,
  `PI_DISPATCH_RUN_PER_HOUR`). Budget is unchanged: a chained or enqueued job passes `reserveBudget`
  consumer-side like any other local job.
- **Scope**: Local jobs only; same-folder chaining only in this slice (the outbox `folder` field is
  ignored — the child runs the parent's own folder). An operator-typed CLI (`pi-dispatch run`) or
  `/dispatch run` command is **ungated** — typing it is the approval.
- **Why**: The two model-reachable producers need a WHAT-gate the operator-typed CLI does not, because
  they are prompt-injection-reachable; the committed, pre-agent-SHA opt-in is agent-uninfluenceable. See
  `DES-AI-TRIGGER-FLOW-GATE` (the gate) and `DES-JOB-OUTBOX-CHAINING` (the outbox producer and its
  host-computed depth).
- **Traces to**: `DES-AI-TRIGGER-FLOW-GATE`, `DES-JOB-OUTBOX-CHAINING`, `DES-ADMIN-VIA-PI-EXTENSION`,
  `DES-CLI-TRIGGER-FOR-LOCAL`, `CONST-BUDGET-BEFORE-TOKENS`, `CONST-ISSUE-TEXT-IS-DATA`,
  `INT-OUTBOX-CONTRACT`
- **Acceptance**: Given a flow whose pre-agent-SHA `SKILL.md` lacks `ai-trigger: allow`, when a
  `dispatch_run` or outbox trigger names it, then it is refused, nothing is enqueued, and no budget is
  touched; given a flow whose `SKILL.md` carries `ai-trigger: allow` at that SHA, when triggered, then it
  is enqueued as an ordinary local job that passes `reserveBudget` consumer-side; given a `dispatch_run`
  folder outside `PI_DISPATCH_RUN_ROOTS`, when invoked, then it is refused; given a dirty working tree,
  when `dispatch_run` fires, then it refuses with no force option; given a chain request exceeding
  `PI_CHAIN_DEPTH_MAX` or `PI_CHAIN_MAX_PER_JOB`, when collected, then it is refused loudly and the
  parent's own outcome is unchanged; given a `request-<n>.json` carrying a `command` key (any value, even
  beside a valid flow), when collected, then it is refused as `chain-command-refused` before any charset
  or gate read, nothing is enqueued, and no budget is touched; given a `dispatch_run` whose `flow` begins
  with `/`, when invoked, then it refuses with a readable message and enqueues nothing; given an
  operator-typed `/dispatch run`, when invoked, then no gate
  applies.

## REQ-RUNTIME-SETTINGS-PICKUP

- **Statement**: The worker shall honour overlay changes without a restart: `model`, `provider`,
  `maxTurns`, `dailyCap`, `weeklyCap`, `monthlyCap`, `maxTokens`, `dailyTokenCap`, and `softHoldPct`
  resolve per job at job start, and `concurrency` is applied at the worker's next job pickup.
- **Why**: A settings edit at 11pm must not require a service restart. The worker re-reads the overlay in
  its processor at each job start — no watcher and no reload signal (see `DES-RUNTIME-SETTINGS-FILE-OVERLAY`).
- **Traces to**: `DES-RUNTIME-SETTINGS-FILE-OVERLAY`, `INT-CONFIG-OVERLAY-CONTRACT`,
  `CONST-BUDGET-BEFORE-TOKENS`
- **Acceptance**: Given a present-but-invalid overlay, when a job starts, then the processor returns a
  policy refusal `settings-overlay-invalid` before `reserveBudget` — no budget slot consumed, no container
  started, not retried; given a job whose data omits `model`/`provider`/`maxTurns`, when it starts, then
  the value falls to the overlay, then env, then default — not a value frozen at enqueue; given `dailyCap`
  lowered below today's reserved count, when the next job starts, then it is refused over-budget before any
  container.

## REQ-SPEND-CAPS-MULTI-WINDOW

- **Statement**: The pre-container budget check shall bound container starts across **three windows** — a
  **mandatory daily** cap plus **optional weekly and monthly** ceilings — and shall additionally refuse new
  starts inside a single **soft-hold band** expressed as a percentage of each active window's cap. A job is
  admitted only when **every** active window is within its cap **and** outside its soft-hold band; otherwise
  it is refused pre-container with a window-named reason (`over-budget` at the hard cap, `soft-hold` in the
  band). Week/month are disabled when their cap is unset; the soft-hold band is disabled when its percentage
  is unset. All three windows and the band are overlay/env tunable (`weeklyCap`, `monthlyCap`, `softHoldPct`;
  `PI_WEEKLY_CAP`, `PI_MONTHLY_CAP`, `PI_SOFT_HOLD_PCT`) and resolve `job.data > overlay > env` per job.
- **Why**: A daily cap alone bounds a single day's blast radius but not a slow bleed — a flow that stays
  under 25/day every day still spends unboundedly across a month. The weekly and monthly ceilings close that
  gap on longer horizons. The soft-hold band is a distinct operator brake **before** the hard wall: crossing
  it pauses new starts (in-flight containers finish, since the reservation is pre-container) and turns the
  panel meter amber, so an operator is warned and can raise a cap or intervene rather than discovering the
  ceiling only when jobs start refusing. These remain **job-count** caps (container starts), not tokens —
  the thing knowable *before* a run — so `CONST-BUDGET-BEFORE-TOKENS` is unchanged; the token controls are a
  separate, structurally lagging problem addressed by `REQ-TOKEN-ACCOUNTING-AND-CAPS` (`OQ-010`).
- **Traces to**: `CONST-BUDGET-BEFORE-TOKENS`, `DES-RUNTIME-SETTINGS-FILE-OVERLAY`,
  `INT-CONFIG-OVERLAY-CONTRACT`, `REQ-RUNTIME-SETTINGS-PICKUP`
- **Acceptance**: Given any active window over its cap, when a job starts, then it is refused `over-budget`
  before `reserveBudget` admits a container, and the refusal names the blocking window; given a reservation
  that lands inside the soft-hold band of any active window but under every hard cap, when a job starts, then
  it is refused `soft-hold` before any container while in-flight jobs continue; given an unset `weeklyCap`
  (and no `PI_WEEKLY_CAP`), when a job starts, then the weekly window is neither counted nor evaluated; given
  a `softHoldPct` set live in the overlay, when the next job starts, then the band takes effect with no
  restart; given a refused reservation, when the window rolls over, then its counter is reclaimed by TTL.

## REQ-SCOPED-LIMITS

- **Statement**: The worker shall enforce limits that attach to a **scope** — the resolved folder for a
  local job, the repo for a forge one — beside the deployment-global controls: per-scope day/week/month
  run caps refused **pre-spend** under the fixed reason `scope-cap` (the blocking window named in the
  forge comment and the `over_scope_budget` log, never in the reason token), per-scope concurrency
  enforced by **deferral** through the delayed set (never a refusal — a busy scope is transient state,
  `CONST-RETRY-INFRA-ONLY`), and an always-on **one-job-per-folder mutex** for local jobs: two local jobs
  naming one folder, by resolved path within one worker process, shall never run concurrently — including
  two occurrences of one cron trigger — with no configuration, no tool, and no off-switch. Caps and
  concurrency shall be operator-editable live via the confirm-gated tools and the `/dispatch` panel
  (`INT-SCOPED-LIMITS-FILE-CONTRACT`; that admin surface lands in a later slice of issue #242 — the
  file-and-watcher half is live now); the mutex alone is code.
- **Why**: Every prior limit was deployment-global: one noisy repo emptied the daily cap for every other
  scope with nothing naming the culprit, and nothing serialized a working tree — two same-folder jobs ran
  containers concurrently in one read-write bind mount, reachable by a single cron trigger with no
  operator mistake (`DES-CRON-VIA-BULLMQ-SCHEDULER`, corrected). A cap is a bound, not a capability, which
  is why live editability is allowed here while `run.image`/`run.packages`/`run.secrets` stay file-only:
  a limit only ever narrows what may spend.
- **Traces to**: `CONST-BUDGET-BEFORE-TOKENS`, `CONST-RETRY-INFRA-ONLY`, `REQ-SPEND-CAPS-MULTI-WINDOW`,
  `REQ-SCOPED-PAUSE-WINDOWS`, `DES-SCOPED-LIMITS-AND-FOLDER-MUTEX`, `DES-CONCURRENCY-3`,
  `INT-SCOPED-LIMITS-FILE-CONTRACT`
- **Acceptance**: Given a scoped daily cap of N on repo X, when X's N+1th job of the day starts, then it
  is refused `scope-cap` before any provider token is spent or slot reserved on the global ledger, X's own counter
  keeps the refused reservation, and every other scope keeps running under the global windows; given the
  GLOBAL window refusing after a scoped reserve committed, then the scoped reservation is released — a
  storm against a spent global cap drains no scope's week or month. Given a scope concurrency of K, when
  job K+1 arrives, then it is deferred pre-spend (no record, no mint, no budget key) and runs after a
  slot frees, its attempt count untouched. Given two local jobs naming one folder in ANY spelling
  (trailing slash, `..` segments, padding), when both are picked up, then their containers never overlap
  and the second defers on a fixed re-check — with no file configured. Given a deployment that configures
  nothing new, then it behaves byte-identically, key for key and record for record, except where the
  mutex serializes — which is the feature.

## REQ-WAIT-FOR

- **Statement**: A trigger MAY carry `run.waitFor`, a conjunction of one to four conditions that must all
  clear before its job starts. `{ "after": "<ISO instant>" }` is answered from the clock; `{ "profile":
  "<name>" }` is answered by an operator-declared executable (`INT-WAIT-PROFILES-CONTRACT`). A job whose
  conditions have not cleared is **HELD**: deferred through the delayed set, reserving no budget slot,
  arming no kill timer, consuming no retry attempt, surviving a worker restart, and keeping its
  delivery-GUID identity. When every condition clears it runs exactly **once**. Absent, a job's data,
  container environment and run record are byte-identical to one prepared before the field existed.

- **Scope**: The webhook trigger kinds, on every forge, whether the delivery arrived by webhook or by the
  poller. Operator-authored config from the reviewed `triggers.json` only — nothing reachable from a
  payload, an issue body, `dispatch_run` or a chained job's `/outbox` can supply it, and no model-callable
  tool can write it. Refused at load beside `on.once`, `run.replicas` and on `cron`
  (`INT-TRIGGERS-FILE-CONTRACT` gives each refusal its mechanism).

- **Why**: **A hold is a third thing, and the queue had only two.** `CONST-RETRY-INFRA-ONLY` splits every
  outcome into "retry now" and "stop", and neither is "not yet". A `{ outcome: "policy" }` return would
  DROP the job, which is right for over-budget and wrong for a dependency: a forge issue job has no
  re-trigger, so dropping it loses the work. `REQ-SCOPED-PAUSE-WINDOWS` already established the shape —
  defer, keep identity, auto-resume — and this widens what may be waited ON from a clock to anything an
  operator can write a script about.

  **The cheap tier exists because the expensive one cannot express it.** A one-shot "not before this
  instant" is structurally inexpressible in pause windows: `windowEndAt` derives every answer from a daily
  `to` time and `from == to` is refused at parse, precisely so a window cannot become an unbounded hold.
  An `after` is that missing shape, and it is free — one exact `moveToDelayed`, no polling at all.

  **Every bound exists because a wait is the one control that can cost nothing and still starve
  everything.** A held job spends no money, so the spend caps cannot see it: `CONST-BUDGET-BEFORE-TOKENS`
  counts container starts, and a check that starts no container is invisible to every ceiling this project
  has. That is why the profile tier carries a per-check timeout, a clamped interval with backoff, a
  concurrent-check lease kept below `PI_CONCURRENCY`, a maximum hold, a per-job check count and a
  consecutive-fault bound — and why every one of them logs its overflow rather than absorbing it silently.

  **The `after` ceiling is deliberately not the maximum hold.** An instant polls nothing and terminates
  itself, so bounding it by a budget meant for subprocesses would refuse the most obvious use of the field
  ("hold this until the maintenance window next month") for a reason that does not apply to it.

  **A wait gates STARTING, never merging.** `CONST-MERGE-NEVER-AUTOMATIC` forbids completing a pull request
  "on any condition", and "wait until CI is green" is one syntactic step from it. The distinction is that a
  wait decides WHEN this harness begins work a human already authorized; it never decides that a human's
  review is unnecessary.

- **Traces to**: `CONST-BUDGET-BEFORE-TOKENS`, `CONST-RETRY-INFRA-ONLY`, `CONST-TRIGGER-AUTHOR-GATE`,
  `CONST-MERGE-NEVER-AUTOMATIC`, `REQ-SCOPED-PAUSE-WINDOWS`, `REQ-SCOPED-LIMITS`, `REQ-TRIGGER-SECRETS`,
  `DES-WAIT-FOR-HOLDS-AND-WAIT-PROFILES`, `INT-WAIT-PROFILES-CONTRACT`, `INT-TRIGGERS-FILE-CONTRACT`,
  `INT-RUNNER-EXIT-CODE-PROTOCOL`, `INT-RUN-HISTORY-FILE-CONTRACT`, `OQ-029`, `OQ-030`

- **Acceptance**: Given a trigger carrying `waitFor`, it loads in all three loaders and an unflagged
  trigger's job data and run record are byte-identical to before the field existed. Given a future `after` more than a
  second away, the job is deferred to that exact instant, writes no run record, consumes no attempt,
  reserves no budget slot and starts no container, and runs when the instant passes; an instant already
  within that second runs now rather than busy-deferring to a moment already past, which is the pause
  gate's own boundary rule. Given an `after` already past, it runs.
  Given an `after` beyond the configured ceiling, it is refused at FIRST pickup as
  `wait-after-beyond-max` — never held toward a bound it cannot reach. Given a condition this deployment
  cannot answer, the job is refused pre-spend rather than run unchecked. Given a second delivery for a
  target already held, it is refused `wait-superseded` rather than held beside the first, so one intent
  produces one paid run; given a delivery after that hold has cleared, it is admitted. Given the authored
  trigger declares conditions the job arrived WITHOUT — a service below the version floor dropped the
  field — the job is refused `wait-skew` pre-spend rather than run immediately, and the refusal names both
  causes -- a service below the floor, or one still running against an older copy of the file. Given the
  MIRROR case, a job carrying a condition this worker cannot read, it is refused `wait-unreadable`: the
  same skew from the other side, given its own token because the remedy is the opposite one. Given a paused scope, the pause is honoured first and the wait burns nothing.

## REQ-TOKEN-ACCOUNTING-AND-CAPS

- **Statement**: The harness shall (a) **account** every job's token usage **process-wide** — the runner
  wraps every api id in pi-ai's module-level api-provider registry, the one choke point every in-process
  session funnels through, and accumulates each provider call's `usage` into per-job totals
  `{ input, output, total, cost }` plus the attribution split
  `{ metered, rootTotal, otherTotal, looseTotal, sessions, calls, unresolved, unpriced }`, emits them on the
  `exit` line, and the worker persists them in the run record and surfaces them in the admin run views. The
  per-turn sum off `session.subscribe()` (`OQ-010`) is the documented **fallback**, attached only when the
  process-wide meter could not install, so exactly one accumulator is ever live and a double count is
  impossible by construction. The meter additionally keeps a **per-(provider, model) ledger** of the same
  accumulation — the full cache split (`cacheRead`, `cacheWrite`, `cacheWrite1h`, `reasoning`) each call's
  `Usage` already carried but the flat totals collapse — emitted as the exit line's `usage` block (at most
  8 named rows plus an `other` row that absorbs overflow and model-less calls; rows sum to `total`), stamped
  with the pi-ai version that priced it, recovered host-side by a validating parser and persisted beside
  host-effective `provider`/`model` dispatch facts on every terminal path
  (`INT-RUN-HISTORY-FILE-CONTRACT`) — so "what did flow X on model Y cost" is reconstructable from history
  and a recorded run can later be re-priced under different rates. The fallback meter keeps **no** ledger:
  it reports five keys and `usage: null`, absence being the reader's signal, not an error; (b) provide an **optional per-job token budget** (`maxTokens` /
  `PI_MAX_TOKENS`) that the runner enforces in-run — once the running total exceeds it the meter returns a
  synthetic **aborted** stream for every subsequent provider call **by any session** and the root session is
  aborted — exiting policy (`2`) with `reason: "token_budget"`; and (c) provide an **optional daily token
  cap** (`dailyTokenCap` / `PI_DAILY_TOKEN_CAP`) that refuses a new job pre-container once the day's recorded
  spend has reached it. Both caps are unset-means-disabled and resolve `job.data > overlay > env` per job;
  accounting is always on.
- **Why**: pi bounds neither tokens nor money; before this, spend was visible only on the provider bill.
  Accounting is the high-value piece — per-job token/cost in the run history is what lets an operator tune the
  **proactive** levers (`maxTurns`, the job-count caps). The two token caps are **backstops**, and both are
  structurally **lagging** (`OQ-010`): a token's cost is knowable only *after* its turn runs. So `maxTokens`
  can only abort *after* the breaching turn is already paid for (finer-grained than `maxTurns`, since turns
  vary wildly in token cost), and `dailyTokenCap` can only stop the *next* job. This forces a deliberate
  **asymmetry** with `CONST-BUDGET-BEFORE-TOKENS`: the job-count cap is check-**before** (it can, a count is
  knowable pre-run); the daily token cap is check-**after** — a read-only check of prior recorded spend before
  the container (consuming no job-count slot) plus an `INCRBY` of the job's tokens after it. The constitution
  governs only the *job-count* cap's ordering and is unchanged; this is a differently-shaped control, not a
  relaxation of it. Under concurrency the daily counter is best-effort — N in-flight jobs each pass the check
  before any records, so the day can overshoot by up to N per-job budgets — which is acceptable for a lagging
  backstop and is not the job-count cap's atomic guarantee.
  **Why the accounting is process-wide, and not per-session.**
  *Negative fact — this scope exists because of an upstream absence.* A session's event bus is **per
  instance**: `AgentSession._eventListeners` is an array on the instance and `Agent.listeners` a `Set` on
  the instance, `createAgentSession` builds a fresh `Agent` + `AgentSession` every call,
  `CreateAgentSessionOptions` carries **no parent or shared-bus option**, and **no event carries a
  `sessionId`**. So a subagent session an extension spawns emits **nothing** on the parent's bus, and a
  16-wide fanout registers there as roughly **one** turn — meaning a `subscribe()`-only meter understates
  spend precisely on the most expensive jobs, which is the opposite of what a spend control is for. The one
  choke point every in-process session shares is pi-ai's module-level api-provider registry: metering there
  counts **calls** rather than turns, and `options.sessionId` (a declared field on pi-ai's `StreamOptions`)
  reaches the provider, which is what makes the root/other split possible at all. If pi ever forwards a
  child session's events onto its parent's bus, this scope becomes deletable — the absence is named here so
  a future maintainer knows that, rather than leaving the meter as unexplained ballast.
  **Honest note — the numbers get bigger, not just better.** With the meter active, a plain job that loads
  no packages will report a `total` **greater than or equal to** the one the `subscribe()` sum reported,
  because the meter also sees compaction and summarisation calls that never surfaced as a root `turn_end`.
  The exit-line shape and every exit code are unchanged; the accounting is simply more complete. A daily
  token counter fed by it therefore fills faster than before at identical real spend — that is the
  correction, not a regression.
  **What the breach actually stops.** `session.abort()` on the root is **voluntary and does not propagate**
  to a child session, so aborting is not the brake. The forward brake is the meter: once breached, every
  subsequent provider call by **any** session is answered with a synthetic aborted stream before it reaches
  a provider (zero usage, `stopReason: "aborted"` so pi's own retry does not fire). The cap remains
  structurally **lagging** either way, and the ultimate backstop stays `REQ-JOB-TIMEOUT-30M`.
  **Residual gap, recorded not hidden**: a package that spawns a **`pi` subprocess** is invisible to any
  in-process hook — pi's own SDK example does exactly that. Child-process sampling ships as diagnostics
  (Linux `/proc`, logged at teardown); the fix belongs with `OQ-004`'s container-level proxy, because
  reading usage off a subprocess needs TLS termination. Tracked at `OQ-011`.
- **Traces to**: `OQ-010`, `OQ-011`, `REQ-RUNNER-TURN-BUDGET`, `REQ-UPSTREAM-CONTRACT-TESTS`,
  `CONST-BUDGET-BEFORE-TOKENS`, `INT-RUNNER-EXIT-CODE-PROTOCOL`, `INT-RUN-HISTORY-FILE-CONTRACT`,
  `INT-CONFIG-OVERLAY-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`, `INT-SDK-SESSION-OPTIONS`,
  `REQ-SPEND-CAPS-MULTI-WINDOW`, `DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY`
- **Acceptance**: Given any completed job, when it ends, then its run record carries a `tokens`
  `{ input, output, total, cost }` object and the admin run views show its total and cost; given `maxTokens`
  set and a job whose cumulative usage exceeds it, when the budget is hit, then the runner aborts, exits `2`
  with `reason: "token_budget"`, and the queue does not retry it; given `dailyTokenCap` set and a day whose
  recorded spend has reached it, when the next job starts, then it is refused pre-container with
  `daily-token-cap`, spends zero provider tokens, and consumes no job-count slot; given a container that ran
  and spent, when it ends on any outcome, then its tokens are added to the daily counter; given both caps
  unset, then usage is still accounted and no job is ever refused or aborted for tokens; given a pin bump that
  drops or reshapes `Usage`, then `REQ-UPSTREAM-CONTRACT-TESTS` fails the build, not a live job.
  **Process-wide clauses.** Given **two concurrent sessions** in one process, one of them the root, when both
  have spent, then the meter's `total` is the sum of both, `otherTotal` is the non-root session's spend **in
  full**, `rootTotal + otherTotal + looseTotal === total`, and a control `attachTokenBudget` on the root sees
  **only** the root's half — the negative half is asserted alongside the positive one, because it is the
  undercount this scope exists to remove; given a **breach mid-fanout**, when the next provider call is made
  by **any** session, then it is stopped before it reaches a provider (asserted on the provider's own call
  log, not on the meter's totals) and the run exits `2` with `reason: "token_budget"`; given the meter
  **could not install**, then the `subscribe()` fallback is attached instead, the exit line reports
  `metered: false`, and the exit codes and record shape are unchanged.

## REQ-COST-ANALYTICS

- **Statement**: The harness shall make recorded spend **analyzable**: the browser surface
  `REQ-INSIGHTS-HTML-EXPORT` (the operator's one analytics view), the `dispatch_costs` read tool (the
  machine-readable path), and the `/dispatch insights whatif` command (the re-pricing estimator) — all
  rendering ONE retention-bounded fold (`DES-COST-FOLD-BY-SCAN`) of the run-history
  sidecars: spend per **flow**, per **model**, per **day**, per **trigger** (attributed under
  `REQ-TOPOLOGY-GRAPH` (b)'s index-and-type join, with chained/manual/unattributed runs as explicit
  buckets pinned to the table's tail, never blended into a trigger's number), and per **repository
  target** (the forge issue/MR tail stripped by the one shared grammar); subscription burn context from the
  operator's declarations (`INT-SUBSCRIPTIONS-FILE-CONTRACT`): amortized effective $/run, peak-window
  consumption, and the API-rate comparison line per plan; and a **what-if** that re-prices a flow's
  recorded token profiles under another model through the pricing façade
  (`INT-PRICING-EXPORT-CONTRACT`). The screen informs; it changes nothing — no auto-switching, no new
  network surface, no database. The **labeling rules are requirements, not conventions**:
  (a) every displayed dollar carries its class — metered, plan, zero-rated, estimated, seeded, or
  unknown — and is rendered only through the one shared formatter;
  (b) a run covered by a declared plan **never renders as `$0.00`**, and an uncovered zero-rate run
  renders `$0 (unrated)`, **never the word "free"**;
  (c) an estimate is **always visibly marked** (`~`/`est.`/`seeded`) and never silently mixes with
  metered numbers — a sum containing one estimated addend is itself marked estimated, with its coverage;
  (d) a floor (`unpriced`/`unresolved`/fallback-metered/pre-meter records) renders `≥`, and the marker is
  never dropped by aggregation;
  (e) a quota window whose vendor discloses no limit shows **facts only** (peak runs/tokens) — never an
  invented burn-down or "remaining";
  (f) what-if seeding uses the flow's own **measured median** first and the `OQ-002` `$0.5–$5/job` band
  **only as a clearly-labeled last resort** (`unmeasured (OQ-002)`), always as a band, never a point;
  (g) the surface states its window and that retention (`PI_LOG_RETENTION_DAYS`) bounds the series.
- **Why**: Metering existed; analysis did not (issue #53). Which model a flow should run on, and whether
  a subscription is saving money, are exactly the decisions this repo already got burned making from
  unmeasured guesses — the `$0.5–$5/job` non-requirement is *recorded as unmeasured* at `OQ-002` — so the
  screen's first duty is not more numbers but honest ones: the class system exists so that no rendering
  path, human or model-facing (`dispatch_costs` carries the class on every value), can launder an
  estimate into a fact. Attribution and re-pricing are possible at all because the ledger records what
  each model spent (`REQ-TOKEN-ACCOUNTING-AND-CAPS`) and pricing stays pi-ai's
  (`INT-PRICING-EXPORT-CONTRACT`) — pi-dispatch still owns no rate table.
- **Scope**: Read-only over the run history and operator declarations; bounded by retention and the
  92-day scan cap; the residual unmetered `pi`-subprocess spend (`OQ-011`) makes every total a floor and
  is surfaced, not hidden.
- **Traces to**: `REQ-TOKEN-ACCOUNTING-AND-CAPS`, `REQ-ADMIN-VIA-PI-EXTENSION`,
  `INT-RUN-HISTORY-FILE-CONTRACT`, `INT-SUBSCRIPTIONS-FILE-CONTRACT`, `INT-PRICING-EXPORT-CONTRACT`,
  `DES-COST-FOLD-BY-SCAN`, `DES-SUBSCRIPTIONS-ARE-COUNTERFACTUAL-ONLY`,
  `DES-RUN-HISTORY-FLAT-FILES-NO-DB`, `CONST-BUDGET-BEFORE-TOKENS`, `OQ-002`, `OQ-011`
- **Acceptance**: Given ledgered runs across two models and a declared plan, when the insights page
  renders, then per-flow and per-model spend render over the window, the plan's runs show `plan:<id>`
  (never `$0.00`), and the plan card shows amortized $/run and the API-equivalent comparison marked
  `~ est.`; given a window with `limit: null`, then no burn-down renders anywhere; given
  `insights whatif` on a flow with ledgered history, then the estimate derives from repriced recorded
  quads, is marked estimated, names its rates version, and reports coverage; given a flow with no
  ledgered history, then the only offer is the labeled `unmeasured (OQ-002)` band; given
  `dispatch_costs`, then every monetary value in the returned JSON
  carries its `class`; given a run recorded under an older pi-ai pin, then it is counted as
  rates-drifted, and its stored cost is never rewritten; given a sparse window, then plan proration
  denominates on the **requested** window, never the observed run span; given a run whose ledger folded
  rows into `other` past the meter's row cap (`usage.truncated`), then the provenance line counts it as
  a truncated ledger; given records whose flow is null, then the fold's what-if matches them by the
  null flow key, never by the `(no flow)` display label (pinned at the fold grain — the interactive
  layer that once exercised it left with the COSTS view); given the ledger's
  `other/other` overflow row, then it is never offered as a what-if target; given a forge run whose
  persisted index+type pair disagrees with the current triggers file, then its spend lands under an
  explicit `(unattributed)` bucket, never under a trigger and never under `(manual/local)`; given a
  fold assembled without a trigger join, then `byTrigger` is null and no surface renders an empty
  trigger table that looks exhaustive.

## REQ-TOPOLOGY-GRAPH

- **Statement**: The harness shall make the trigger/flow **topology** visible: the topology pane of the
  insights artifact (`REQ-INSIGHTS-HTML-EXPORT`, the one analytics surface) renders one assembled model
  (`DES-GRAPH-EDGE-DERIVATION`) of every trigger, every
  enumerated skill, and every edge between them, grouped by folder — and, since issue #188, the three
  non-repo skill tiers the loader legally resolves from (`REQ-PER-TRIGGER-SKILLS`,
  `REQ-GLOBAL-PI-OVERLAY`): injected `run.skillsDir` skills, the overlay's `skills/` and the staged
  packages' skills each render as their own tier-labelled group where this session can enumerate them.
  The surface informs; it changes
  nothing — no port, no database, no new dependency, all fs/redis access in the read-model. The
  **honesty rules are requirements, not conventions**:
  (a) every trigger naming a `run.flow` renders its config edge — dangling, unverifiable and
  charset-invalid included;
  (a2) config-edge **resolution is tier-aware** (issue #188), probing the loader's precedence order
  repo > injected > overlay > staged per trigger: a flow absent at HEAD but present in a lower tier
  lands its edge on that tier's node with **no flag** (the flow runs fine; the tier node's tip carries
  the never-AI-reachable half), a tier node is claimed only when every higher applicable tier is a
  **known** miss (a config edge asserts node identity, and a wrong tick is the one direction an
  advisory may not err in), a flow missing from every checkable tier while some applicable tier is
  not checkable from this session renders the **`skill-not-at-head`** state — amber, naming the
  unchecked tiers, never the red missing claim — and the red `no-skill` flag fires **only** when
  every applicable tier was checked and missed, its detail naming the tiers checked (a trigger's own
  `run.packages: false` withholds the staged tier as a known miss and the detail says so);
  (b) a cron trigger's run count and last outcome are **exact** over the stated window (the jobId
  join), and a forge trigger's come **only** from the persisted `triggerIndex` **and**
  `triggerType`, both of which must agree with the entry now at that index — a record whose index is
  out of range, whose row the display dropped, or whose type disagrees renders under an explicit
  `unattributed` count, never attributed across a type change. The one shift the persisted pair
  cannot see — two SAME-type entries reordered within range — is beneath an integer-and-enum's
  resolution, is pinned as a residual by test, and is why every attribution renders under the
  standing "as of the current triggers file" caveat; closing it would need a persisted entry
  identity string, which the record's no-attacker-chosen-string posture prices deliberately high;
  (c) an **observed** edge is always labelled with its count and source (records over the window);
  a **potential** edge is always labelled as a mention, with whether it could ever fire (the
  target's `ai-trigger`), and the two vocabularies never mix in one line;
  (d) no chain edge renders out of a forge trigger's flow or across folders (`OQ-009`);
  (e) orphan skills, `no-skill` triggers, charset-invalid flows, AI-reachable-without-trigger and
  injected-`ai-trigger` skills are visibly flagged, each by its own name;
  (e2) a skill whose text instructs iteration carries its **loop hints as node facts, grouped inside
  the skill** — a loop lives inside its one job, so it renders inside its one node, labelled as text
  evidence (the mention discipline), never as an edge; and a forge group names the repositories its
  window's **records** actually ran against, labelled as record-derived, because a forge trigger's
  config names none;
  (f) the chain caps and the record window render on **every** output, and every truncation or
  dropped edge says so — a capped scan must never read as complete coverage;
  (g) an unreachable folder renders **unverified** and produces no dangling flags;
  (h) a cron trigger's tip renders its resident scheduler's **next fire** as a countdown against
  the page's own generation instant (never a live clock — a stale page shows its stale countdown
  honestly) and its **overdue** state from the scheduler's `overdueMs`, and a trigger carries the
  window's **typed spend** badge (`foldTriggerCosts`, keyed by the node id), rendered only through
  the shared cost formatter so a plan-covered trigger never reads `$0.00`; spend and schedule are
  node **facts**: no new edge kind, no new flag, the closed vocabularies stay closed. Issue #188
  honours that sentence literally: the edge and flag vocabularies are byte-unchanged by tier
  resolution — what grew is the **node kinds** (`overlay`, `staged`, `skill-not-at-head`), which now
  form their own closed, test-pinned set (`GRAPH_NODE_KINDS`) with a glyph-parity pin so a kind
  without a renderer arm goes red in a unit test.
- **Scope**: Display only, from the operator's session. The graph triggers nothing, writes nothing,
  and is deliberately **not** a model-callable tool: the enumeration spawns git per folder, and the
  topology is for the operator's eyes (`DES-CLI-SURFACE`'s ungated operator-typed tier).
- **Why**: Every edge already exists somewhere in `triggers.json`, the run records, or the object
  store — issue #54's four gaps are failures of assembly, not of data. The labeling rules exist
  because a graph invites exactly one failure: blurring evidence classes until a mention reads like
  history (`REQ-COST-ANALYTICS`'s estimate-never-mislabeled-as-truth discipline, applied to
  topology).
- **Traces to**: `DES-GRAPH-EDGE-DERIVATION`, `DES-ADMIN-VIA-PI-EXTENSION`,
  `DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS`, `REQ-PER-TRIGGER-SKILLS`, `REQ-GLOBAL-PI-OVERLAY`,
  `INT-RUN-HISTORY-FILE-CONTRACT`, `OQ-008`, `OQ-009`, `OQ-022`
- **Acceptance**: Given a triggers file with a cron trigger whose folder enumeration succeeds and a
  label trigger, when the insights artifact renders, then the cron trigger shows exact run counts
  joined by jobId, the label trigger shows counts joined by `triggerIndex` only, and both config
  edges render;
  given a record whose `triggerIndex` exceeds the current file, then it counts as unattributed and
  attributes to no row; given a folder whose skills include one no trigger names, with no
  `ai-trigger` and no mention, then it flags `orphan`; given a cron trigger whose flow is absent at
  HEAD in an enumerated folder **and absent from every checkable applicable tier**, then it flags
  `no-skill` with the checked tiers in the detail, and given the folder is unreachable instead,
  then it renders unverified with no dangling flag;
  given a cron trigger whose flow exists only in its `run.skillsDir`, then the config edge lands on
  the existing `injected:<dir>:<name>` node, no `no-skill` flag is minted, no second node appears
  for the name, and the tip still says never AI-reachable; given a flow that resolves only in the
  overlay `skills/` or only in a staged package, then the edge lands on that tier's node likewise,
  a staged resolution naming the first manifest-order package (the loader's own shadowing order);
  given a session whose `PI_GLOBAL_PI_DIR` is not visible (the deployment pointer cannot carry it),
  an unreadable tier listing, a truncated one, or a pattern-manifest package, then a flow missing
  from the checkable tiers renders `skill-not-at-head` naming the unchecked tiers, never the red
  missing claim; given a forge trigger whose flow matches an overlay or staged name, then it still
  renders unverified — the remote repo outranks every tier this host can read;
  given any output, then the caps line
  (`chain depth`, `per job`, `same folder only`, window) is present; given an observed chain edge,
  then its line carries `observed x<count>`, and no potential line carries a count.

## REQ-GRAPH-HTML-EXPORT

- **SUPERSEDED** (2026-08-12, issue #181): the topology-only artifact and its `/dispatch graph html`
  command are removed; every normative clause this entry carried — the self-contained one-file
  posture, the atomic stable-path write, URL-before-spawn, the page's own refresh loop and hash view
  state, the no-port property, the `.log`/host-path content bans with the `--full-paths` opt-in, and
  the headless skip-and-say — now lives verbatim in `REQ-INSIGHTS-HTML-EXPORT`, whose artifact
  carries the same topology as one of its panes. The ID stays because spec IDs are permanent
  addresses; the history of what this entry required is in the Revision History rows that built it.

## REQ-INSIGHTS-HTML-EXPORT

- **Statement**: The harness shall render the **unified insights artifact** — the operator's ONE
  analytics surface — on the bare command: `/dispatch insights [7d|30d|mtd] [--no-open]
  [--full-paths]` writes one self-contained HTML file — inline SVG/CSS/JS, `file://`, **zero
  external requests** — atomically (tmp+rename) to the **stable path** `<graphDir>/insights.html`,
  prints its `file://` URL **before any spawn**, and best-effort opens the platform browser; the
  overlay's `i` key runs the same command between overlays. The page carries its own refresh: a
  Reload control, an off/5s/30s auto-reload, a live staleness stamp, and view state that survives
  its own reloads via the URL hash — so a re-run updates an already-open tab, and tmp+rename means
  the tab never reads half a file. Over SSH or without a display the spawn is skipped and the skip
  is stated; `--no-open` skips it unconditionally; a write failure notifies the path and never
  opens. The page unifies the
  assembled topology (`REQ-TOPOLOGY-GRAPH` — its honesty counters, edge recency, schedule tips and
  spend badges per its (h)) with the cost fold (`REQ-COST-ANALYTICS`) rendered as **hand-rolled
  inline SVG charts**: KPI tiles, a **budget panel** (the caps are the operator's one real lever on
  cost, so the page that prices everything shows the dial beside the spend: reserved-vs-cap facts
  for the day/week/month job-slot windows and the daily token counter, states computed by the
  worker's own classifier and carried in the payload as words, the lever named — `/dispatch set …`,
  the panel's `s`), plan verdict cards, a daily spend column chart with a **cumulative mini-chart**
  beneath it, **per-flow daily spend as small multiples** (top flows, one panel each), and the four
  breakdown bar lists (flow / trigger / model / repo). Every labeling rule of `REQ-COST-ANALYTICS`
  (a)-(g) applies to this surface verbatim, plus the visual clauses this surface adds:
  (a) an estimated figure renders dashed and translucent beside its `~ est.` text — hue is never
  the sole encoding of a cost class;
  (b) a plan-covered bucket draws a `plan:<id>` chip and **no dollar bar** — a zero-length bar is
  the `$0.00` lie in geometry;
  (c) a floored figure carries `≥` on the chart as in the text;
  (d) the page states **both windows** — the operator's spend window and the topology's fixed
  record window — and the retention/scan-cap sentence, so a screenshot cannot conflate them;
  (e) gap days render as zero entries, never compressed away;
  (f) a fold assembled without a trigger join renders "not computed", never an empty table;
  (g) the budget panel renders **used-vs-cap facts only**: an overlay-unset cap renders "cap
  unknown" (day) or "off" (week/month with nothing reserved) with **no bar and no percentage** —
  `REQ-COST-ANALYTICS` (e)'s no-invented-denominator rule applied to caps this process cannot read
  authoritatively — the window state is a WORD with color only reinforcing it, slots and tokens are
  counts that never route through the money formatter, and the display is GET-only: observing the
  budget never consumes a slot (`CONST-BUDGET-BEFORE-TOKENS`);
  (h) a line's estimated days render as **dashed segments** (the same honesty encoding as the
  columns — a segment touching an estimated day wears the estimate, and a cumulative line is
  demoted permanently from its first estimated day), and series identity is carried by **text**
  (the panel title), never by hue alone.
  Degrades are total: an unreachable cost scan still writes the page with its banner, an
  unreachable budget read leaves the caps as facts with the absence stated, and junk
  input yields a valid page, never a stack trace. **No port is ever bound; nothing serves the
  file; no new model-callable tool exists for it** (the topology assembly spawns git per folder,
  `REQ-TOPOLOGY-GRAPH` Scope).
- **Scope**: Display only. The artifact carries run-record fields and operator-authored
  trigger/skill strings only — never `.log` bytes, and a host path beyond a folder's basename only
  under the explicit `--full-paths` opt-in (the paths are the operator's own reviewed config; the
  default stays basename-only because the artifact is a durable, shareable file). The default
  window is **30d**, not the old costs mtd, because the topology half is pinned at a 30-day record
  window and one page's two halves should describe the same period unless the operator asks
  otherwise. The what-if is the `insights whatif` command; `seeded` dollars never render on the
  page. Zero new dependencies.
- **Why**: A terminal frame communicates 76 columns at a time; a human reading "what is this
  deployment doing and what does it cost" reads a chart faster than a table and a topology faster
  than either — and the two questions answer each other, so they belong on one page, and one page
  beats five overlapping surfaces answering it (issue #181). A static file keeps
  `DES-ADMIN-VIA-PI-EXTENSION`'s load-bearing no-port property intact — the socket→file
  substitution `DES-JOB-OUTBOX-CHAINING` canonised — and the chart grammar is hand-rolled for the
  same reason the topology layout is: the page must work over `file://` with zero external
  requests, and a charting dependency is a supply chain riding a security posture.
- **Traces to**: `REQ-COST-ANALYTICS`, `REQ-TOPOLOGY-GRAPH`, `REQ-GRAPH-HTML-EXPORT` (superseded
  into this entry), `DES-COST-FOLD-BY-SCAN`, `DES-ADMIN-VIA-PI-EXTENSION`, `OQ-024`
- **Acceptance**: Given `/dispatch insights`, then exactly one artifact lands at
  `<graphDir>/insights.html` via a `.tmp` rename with mode 0644, its URL notified before any
  opener spawn, and the rendered bytes contain no external `src`/`href`/`url()`/`@import`, no
  `fetch`/`XMLHttpRequest`, no `innerHTML`, no `.log` content, and no absolute host path unless
  `--full-paths` was passed; given a second run, the artifact lands at the **same** path; given
  `SSH_CONNECTION`/`SSH_TTY` (any platform) or linux without `DISPLAY`/`WAYLAND_DISPLAY`, the
  spawn is skipped and the reason notified; given `insights html` or any junk positional, then the
  command answers usage and writes nothing; given a plan-covered
  breakdown row, then the page shows `plan:<id>` and draws no bar, and `$0.00` appears nowhere;
  given an estimated day, then its column is dashed/translucent and its tooltip carries `~ est.`;
  given a window with `limit: null`, then the card says "limit undisclosed by vendor" and no
  burn-down renders; given a hostile flow name or plan id, then the page contains exactly one
  script element and the string renders entity-escaped; given the same payload and instant twice,
  then the bytes are identical, permuted input arrays included; given an unreachable cost scan,
  then the page still renders the topology with a cost banner; given an overlay-unset cap, then the
  budget row says unknown or off, draws no bar, and `/remaining/i` matches nowhere on the page;
  given a window past its soft-hold floor, then the row carries the word `soft-hold`; given a flow
  series whose day is estimated, then the segments touching it are dashed and its point tip carries
  `~ est.`; given a fold without the per-flow series, then the section is absent, never an empty
  grid.

## REQ-SCOPED-PAUSE-WINDOWS

- **Statement**: The worker shall support **per-scope scheduled pause windows**: a `pause-windows.json`
  (`PI_PAUSE_WINDOWS_FILE`) of `{ scope, from, to, tz?, days?, dateFrom?, dateTo? }` entries, where `scope`
  matches a job's `repo` (github) or `folder` (local), or `"*"` for all. A job whose scope is inside an
  active window is **deferred** to the window's end via BullMQ's delayed set (`job.moveToDelayed`), **not
  dropped** — it keeps its jobId/dedup, survives restart, and resumes automatically when re-picked. The gate
  runs **before the budget reservation**, so a deferred job reserves no slot and spends nothing. Windows
  recur daily (`from`–`to`, overnight when `from > to`), optionally restricted to weekdays (`days`) and a
  date range (`dateFrom`/`dateTo`), interpreted in the window's IANA `tz` (default UTC). The file is
  validated fail-loud at boot and **live-reloaded** (a bad edit keeps the last-good windows). Pause windows
  are managed operator-typed (`/dispatch` overlay) and via **confirm-gated** model tools
  (`dispatch_pause_add`/`_delete`, `dispatch_pauses`), the same human-approval gate as the trigger/setting
  writes (`REQ-ADMIN-VIA-PI-EXTENSION`).
- **Scope**: The worker's pickup path (the receiver is unaffected — a github job is deferred at pickup, not
  at enqueue). Distinct from the global `queue.pause()` (whole-queue, untimed) and additive to it.
- **Why**: "Pause runs for this repo/folder between certain times and resume after" is quiet-hours. Deferring
  (not dropping) is the point of "unpause after" — a github issue job paused at 22:00 runs after 06:00, not
  lost. Placing the gate before `reserveBudget` keeps it consistent with `CONST-BUDGET-BEFORE-TOKENS` (a
  deferred job costs nothing and does not count). BullMQ owns the delay (library-first); the timezone math
  uses the built-in `Intl` (no dependency).
- **Traces to**: `DES-SCOPED-PAUSE-VIA-MOVE-TO-DELAYED`, `INT-PAUSE-WINDOWS-FILE-CONTRACT`,
  `CONST-BUDGET-BEFORE-TOKENS`, `REQ-ADMIN-VIA-PI-EXTENSION`
- **Acceptance**: Given a window covering now for a job's scope, when the job is picked, then it is moved to
  delayed until the window end and reserves no budget slot; given the same job out of the window, it runs;
  given a malformed pause-windows edit at runtime, the worker logs `pause_windows_reload_invalid` and keeps
  the last-good windows; given `dispatch_pause_add` with no interactive operator, it refuses and writes
  nothing; given an approved confirm, it writes exactly the shown window.

---

## REQ-PER-TRIGGER-INSTRUCTION

- **Statement**: A webhook trigger may carry one line of operator standing text (`run.instructions`),
  rendered into the USER prompt's instruction region: above the fenced data region, below the harness's
  own steps, and before the never-merge paragraph. Absent, the prompt is byte-identical to before.
- **Scope**: The three webhook types, on all four forges. **Refused on cron**, which already has
  `run.task`. Operator-authored config only, and no model-callable tool may set it.
- **Why**: Label, comment and pull_request triggers carried no prompt text at all, so "for this trigger
  specifically: the tests run with X, this repo's convention is Y" had to be committed into the repo's
  `SKILL.md` or pushed into the deployment-wide persona, which applies it to every job everywhere.
  **Refused on cron rather than accepted**, and that is not a gap: a local job's prompt IS `run.task`,
  with no envelope, no data heading and no fence, so there is no standing region distinct from the task
  for a second field to occupy. Two fields writing one region with an undefined combination order is
  worse than a field that does nothing, because both would appear to work.
  **Capped at 2000 characters, and NOT for the caching reason.** The text is written once and
  `session.prompt()` is called once, so `CONST-PERSONA-IN-CACHED-PREFIX`'s named anti-pattern is not what
  this is; and at the pin, pi-ai attaches `cache_control` to the last user message as well as the system
  prompt, so after turn one it sits in the cached prefix at roughly the persona's rate anyway. What the
  cap is for is an unbounded field pasted with a style guide, which overflows context inside a **paid**
  container on every delivery with no pre-spend signal, and keeping the field in its lane, since anything
  longer belongs in the flow's `SKILL.md` or the overlay persona. The refusal names both destinations.
  Refused rather than truncated: the reviewed file must not disagree with what runs.
- **Traces to**: `CONST-ISSUE-TEXT-IS-DATA`, `INT-TRIGGERS-FILE-CONTRACT`, `INT-CONTAINER-JOB-INPUTS`,
  `DES-TRIGGER-INSTRUCTION-IN-THE-ENVELOPE`, `DES-FLOWS-ARE-DATA-PERSONA-IS-CODE`
- **Acceptance**: Given a trigger carrying `run.instructions`, the text appears in `/job/prompt.md` above
  the data heading and below the harness's steps, is never fenced, and the never-merge paragraph still
  follows it. The data region is byte-identical with and without it, on all three prompt shapes and all
  four forges, and a job without one produces a byte-identical prompt to before the feature. It never
  appears in `/job/event.json` or the run record. A cron trigger carrying it is refused at load with a
  message naming `run.task`; one over the cap is refused with a message naming both destinations.

## REQ-PER-TRIGGER-SKILLS

- **Statement**: A trigger may name a directory of operator-authored skills on the worker host
  (`run.skillsDir`). Its `<name>/SKILL.md` children shall be **copied** into that job's `/job` inputs and
  layered between the serviced repo's own `.pi/skills` and the deployment-wide overlay: **repo > injected
  > overlay**. Absent, a job is byte-identical to one prepared before this existed.
- **Scope**: All four run kinds. Operator-authored config from the reviewed `triggers.json` only. NOTHING
  reachable from a webhook payload, an issue or comment body, or `dispatch_run` can supply it, and no
  model-callable tool can set it: choosing which skills a job loads is choosing what the agent can do,
  which is `run.image`'s answer rather than `f.forge`'s.
- **Why**: `run.flow` could only name a flow that already existed, either committed to the serviced repo
  or baked into the deployment-wide overlay. So an operator could not run a flow against a repo that has
  not adopted `.pi/skills/`, A/B two versions of a flow across two triggers, or keep a private or
  in-development flow out of a public repo's history. The overlay is the only operator-side path and it is
  **per deployment**; this is the same capability at **per trigger** granularity, which is the granularity
  the decision actually has.
  **Copied, not mounted, and the copy is the point.** `:ro` bounds the container, not the host, and pi
  reads a skill's body on demand, so a live bind could change under a running agent mid-job. Copying gives
  the injected tier the property `INT-CONTAINER-JOB-INPUTS` gives `/job/pi`: the instruction set cannot
  move while the agent works. It also adds **no mount**, so `CONST-ISOLATION-CONTAINER-PER-JOB`'s
  enumeration is untouched, and a resurrected sandbox re-mounts the same job dir and sees the same skills
  for free rather than re-reading a host directory that may since have changed.
  **The middle tier is where it is because narrower wins.** "For THIS trigger" is a more specific operator
  statement than "for this deployment", so it refines the overlay; the repo's own `.pi/` is more specific
  still and refines both. That is the same most-specific-wins ordering the persona layers already use.
- **Traces to**: `INT-TRIGGERS-FILE-CONTRACT`, `INT-CONTAINER-JOB-INPUTS`, `INT-SDK-SESSION-OPTIONS`,
  `REQ-GLOBAL-PI-OVERLAY`, `DES-TRIGGER-SKILLS-COPIED-NOT-MOUNTED`, `DES-AI-TRIGGER-FLOW-GATE`
- **Acceptance**: Given a trigger naming a directory of skills, a job of that trigger loads them; a repo
  skill of the same name still wins; an overlay skill of the same name loses; and a staged package cannot
  take any of their names. Given no `run.skillsDir`, the docker argv, the `/job` tree and the job payload
  are byte-identical to before the feature. Given a path that is absent or not a directory, the job is
  refused **pre-spend** with `skills-dir-missing`, no token is minted and no budget slot is consumed.
  Given a directory that is empty or over a cap, the job is refused in prepare, before the budget, with
  the cap named. Given a flow that exists ONLY in an injected directory, a chain request or a
  `dispatch_run` for it is refused, `doctor` warns that an injected `ai-trigger: allow` is never read,
  and (issue #188) the topology lands the trigger's config edge on the injected skill's own node with
  no dangling flag — the never-AI-reachable badge stays, the false `no-skill` goes
  (`REQ-TOPOLOGY-GRAPH` (a2)).
  Given a job whose `run.flow` names a skill that NO loaded tier materialised — repo, injected, overlay
  or staged package — the runner emits one `flow_not_loaded` line (flow name and a loaded-skill count,
  never task content) before any session exists, so the silent-exit-0 shape is a failing test rather
  than a clean run; the job itself proceeds (`DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS`).
  Given a triggers file, `doctor` prints one line per distinct (flow, folder, skillsDir, packages)
  question naming the tier that resolves it — repo `.pi/skills` at HEAD of a cron trigger's folder
  (the gate's own ls-tree read, 100644-blob rule included, but HEAD-resolved and degrading to
  "unknown" on git failure rather than fail-closed), injected `run.skillsDir`, overlay `skills/`,
  staged packages — probing in the loader's precedence order; when none resolves it prints ⚠, never
  ✗ and never a fix action, naming the tiers checked and the ones not checkable on this host (a
  forge trigger's repo, a pattern-manifest package); a flow that fails the skill charset is its own
  ⚠; a comment trigger is checked on its **default** flow only (invoked alternates are some other
  trigger's own `run.flow` and get their own lines); zero triggers add zero lines.
  No mount is added to any container, and the host path appears in no container-readable file and no log
  line.

## REQ-GLOBAL-PI-OVERLAY

- **Statement**: An operator shall be able to reuse their existing host `pi` setup in every job. A single
  **global overlay dir** (`PI_GLOBAL_PI_DIR`) is bind-mounted `/opt/pi-global:ro` into each container (both
  job kinds) and layered **UNDER** each repo's own `.pi/`: custom models (`models.json`) become resolvable,
  global skills (`skills/`), global prompt templates (`prompts/`, issue #189) and a global persona
  (`APPEND_SYSTEM.md`) apply to every job. **Repo wins on
  conflict** — the repo skill path is listed first (pi is first-path-wins), the repo persona is appended
  last, and for prompt templates the same rule is ENFORCED post-load (`promptsOverride`, mirroring the
  skills enforcement, because pi merges package prompt paths first and path order alone cannot carry it);
  the baked `HARD_RULES.md` floor stays first and unremovable. The overlay is **credential-free by
  construction**: `pi-dispatch import-pi` stages the safe subset of `~/.pi/agent` (honoring
  `PI_CODING_AGENT_DIR`), **refusing** a `models.json` with a literal key and **never** copying `auth.json`
  or `settings.json`; `pi-dispatch doctor` re-verifies. Overlay **extensions are staged and loaded by
  DEFAULT**: `import-pi` copies `extensions/` unless the operator passes `--no-extensions`, **prints every
  extension it staged by name** (the vetting step is a list the operator can read, not a flag they can
  forget), and still **hard-blocks the admin extension**; they then load in every job unless
  `PI_GLOBAL_ALLOW_EXTENSIONS` is exactly `"0"`. The knob is an **opt-OUT**, and unset, `""` and the legacy
  `"1"` all mean load; **any other value is a loud `configError`** at all three enforcement points (worker
  config, env-allowlist, runner config) — the strict parse is unchanged but what it defends against
  flipped, since `=false` used to degrade safely to "dormant" and would now silently mean "on".
  A custom provider's key reaches the container through the explicit `PI_FORWARD_ENV` name allowlist,
  never a host pass-through.
  The overlay additionally carries **operator-staged pi packages** at `packages/<dir>/`, and they are the
  sharpest tier of all — third-party code, so they pass **four** gates, three of which refuse by default
  and the fourth of which is a withdrawal. (1) The operator declares
  each one in a pinned `pi-packages.json` at an **EXACT** version (`INT-PI-PACKAGES-FILE-CONTRACT`;
  `CONST-PI-VERSION-PINNED`'s reasoning, since a floating range makes every queued job a silent no-op that
  still reports success). (2) `pi-dispatch import-pi --with-packages` stages each one **on the host** into
  its own self-contained directory (`--omit=dev --omit=peer --omit=optional --ignore-scripts
  --install-strategy=nested`, all-or-nothing, plus a `packages.json` stage manifest), refusing a ranged
  version, an **admin-like name** (a package that can enqueue paid jobs from inside a job container is the
  same recursion vector the admin extension is blocked for), a package that contributes no pi resources, a
  manifest entry that leaves the package dir, a missing transitive dependency, or a colliding staged dir.
  (3) A **per-trigger** `run.packages` (all four trigger kinds; `INT-TRIGGERS-FILE-CONTRACT`) decides
  whether the worker emits `PI_PACKAGES` — an **opt-OUT**: absent or `true` loads what the operator staged,
  and only an explicit `false` withholds it, since staging is itself the deliberate act and the flag exists
  so one flow can decline what the deployment pinned. `parseTriggers` still refuses a non-boolean at load,
  which is now the *only* place that strictness lives. (4) The runner validates every
  path, **refuses the job pre-spend** when one did not mount, appends them **last** to
  `additionalExtensionPaths`, and re-imposes this requirement's own **"repo wins on conflict"** on skills
  through the loader's declared `skillsOverride` seam, so a staged package can never take the name of a repo
  or overlay skill (a collision that was attempted is *reported*, not refused).
  `PI_OFFLINE=1` is set on **every** job so a package source can never become a live job-time `npm install`.
- **Scope**: The container mount + env contract and the runner's resource loader; a new host-side CLI
  (`import-pi`) and `doctor` checks. Works with the **pulled** prebuilt image — a runtime mount, not a
  rebuild. Distinct from the per-repo `.pi/` (trusted-by-merge, materialized from a git SHA) and from the
  admin-editable runtime settings overlay (which still may never carry persona). Staged packages ride the
  **same** `/opt/pi-global:ro` mount — no new mount, no new trust boundary — and load for every job whose
  trigger did not set `run.packages: false`. The admin panel **displays** each trigger's packages state and
  the staged `name@version` set and deliberately **cannot set** the flag: changing which flows run
  third-party code is a reviewed file edit, not a keystroke.
- **Why**: Anyone who already runs pi has a configured `~/.pi/agent`; re-expressing it per-repo is friction
  the missing-layer pitch should remove. The overlay is **operator deploy-time config — the same trust class
  as baking the image** — so it may carry a persona layer, but it is mounted `:ro` into an adversarial-input
  container, so it must hold no secret (`CONST-TOKEN-SCOPED-PER-JOB`).
  **Why the overlay's extensions load by default.** An operator vetted this code twice before it ever
  reached the overlay: once by running it in their own `~/.pi/agent`, and once by staging it with
  `import-pi`, which prints every extension it copied. A third gate is friction, not safety — and the
  friction had a cost, because an overlay that is present but dormant is a deployment silently missing the
  setup its flows were written against, with no error to read. The setup the operator staged is the setup
  their jobs get. That relaxation stops at the overlay: it never touches the spend caps, the per-job token
  scoping, or the admin-extension block, and `PI_GLOBAL_ALLOW_EXTENSIONS=0` remains a one-line opt-out for
  a deployment that wants them dormant.
  **Why packages are staged on the host rather than installed in the job.** pi resolves any spec that is not
  `npm:`/`git:`/a URL as a **local path** — in place, with no install, no network and no writes — which is
  exactly what lets a job container load one with no job-time install and `--ignore-scripts` already behind it.
  The alternative, an `npm:` source resolved in-container, is a live network install of third-party code
  inside an adversarial-input container on **every** run. **`--ignore-scripts` cuts both ways and the honest
  half is stated at stage time**: lifecycle scripts would otherwise run as the operator, on the operator's
  host, so they are refused — and a package that declares one (or an `optionalDependencies`) is therefore
  staged **INCOMPLETE** and warned about, because it may fail at run time.
  **Every way this feature breaks is silent**, which is why the refusals are loud: pi **skips** a local
  package source that does not resolve with no error and no diagnostic, so an unmounted package would run
  the flow to a clean exit `0` without the tools it was written for. Hence `doctor` surfaces the staged set,
  its armed/dormant state, and the four silent-failure modes; and (issue #189) the overlay's `skills/` and
  the staged packages' skills are two of the four tiers doctor probes when it answers, per trigger, whether
  `run.flow` resolves anywhere -- a flow that resolves ONLY in a staged package is a plain ✓ naming the
  package, because staged-only resolution is legal steady state, and a package whose `pi` manifest uses
  glob or override patterns is reported as not enumerable rather than guessed at (`readStagedSkills`
  mirrors pi's own manifest-vs-convention rule at the pin, including that a `pi` manifest without a
  `skills` key contributes nothing). The topology is the same story's display half (issue #188,
  `REQ-TOPOLOGY-GRAPH` (a2)): where `PI_GLOBAL_PI_DIR` is visible to the console session, the overlay's
  `skills/` and the staged packages' skills enumerate as their own tier-labelled node groups (the staged
  reader shared with doctor, manifest order preserved because it is the loader's shadowing order), and
  where it is not — the deployment pointer deliberately cannot carry `PI_GLOBAL_PI_DIR` — a dangling
  claim softens to `skill-not-at-head` naming the unchecked tiers, never a false red.
- **A third skill tier sits between the overlay and the repo** (`REQ-PER-TRIGGER-SKILLS`, issue #60).
  "Repo wins on conflict" is unchanged and now reads in full as **repo > injected > overlay**: a trigger's
  own `run.skillsDir` refines this deployment-wide overlay, because "for THIS trigger" is the narrower
  operator statement, and is itself refined by the serviced repo's committed `.pi/`. Both halves are
  enforced rather than asserted -- by path order in `additionalSkillPaths`, and again by
  `skillsOverride`'s protected roots, which is what keeps a staged package from taking any of the three.
- **Traces to**: `DES-OPERATOR-GLOBAL-OVERLAY`, `INT-CONTAINER-RUNTIME-CONTRACT`, `INT-SDK-SESSION-OPTIONS`,
  `INT-CONTAINER-JOB-INPUTS`, `INT-PI-PACKAGES-FILE-CONTRACT`, `INT-TRIGGERS-FILE-CONTRACT`,
  `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-TOKEN-SCOPED-PER-JOB`, `CONST-PI-VERSION-PINNED`,
  `DES-PERSONA-VIA-APPEND-SYSTEM-MD`
- **Acceptance**: Given a configured overlay, a global skill is available to a job and a repo skill of the
  same name overrides it; the assembled prompt shows guardrails before the global persona before the repo
  persona; given a custom model in the overlay `models.json`, the runner resolves it; given `import-pi`
  against a `models.json` with a literal key, it refuses and writes nothing; given `auth.json` in the
  overlay, `doctor` fails; given overlay extensions with `PI_GLOBAL_ALLOW_EXTENSIONS` unset, empty, or
  `"1"`, they **load**; given exactly `"0"`, they do not; given any other value — `"false"`, `"yes"`,
  `"true"` — the worker **refuses to boot**, the env-allowlist and the runner both refuse, and `doctor`
  reports it as a hard failure rather than guessing a direction; given `import-pi` with no flags, the
  overlay's extensions **are** copied and every one is printed by name; given `--no-extensions`, none is;
  given either, over the admin extension, it is not copied.
  **Staged packages.** Given a `pi-packages.json` entry with a ranged version, an admin-like name, a `dir`
  that is not a plain segment, a duplicate `dir`, a package with no `pi` manifest and no resource dir, a
  `pi` manifest entry containing `..` or a leading `/`, or a dependency npm hoisted out of the package dir,
  when `import-pi --with-packages` runs, then it refuses and **nothing at all is staged** (all-or-nothing);
  given a staged set and a trigger **without** `run.packages`, then `PI_PACKAGES` **is** emitted and one
  staged dir contributes **both** extensions and skills — through the explicit `additionalExtensionPaths`
  channel, which `reload()` honours regardless of `noSkills` — and the extension paths sort **after** the
  repo's, the overlay's, and anything discovered under `/workspace`; given `run.packages: false`, then
  `PI_PACKAGES` is not emitted and no package loads;
  given a `PI_PACKAGES` entry that is relative, contains `..`, or does not exist in the container, then the
  runner refuses **before any provider call** with exit `2`; given a staged skill whose name collides with a
  repo or overlay skill, then the **repo (or overlay) skill is the one in force** — pi's raw load hands the
  name to the package, since it orders package skill paths first and is first-path-wins, and the runner
  takes it back through the loader's `skillsOverride` seam, so this entry's "repo wins on conflict" holds by
  enforcement rather than by assertion; the job **runs**, and the attempt is reported so the operator learns
  that a staged package shipped a name the repo had already published; given a repo skill and an overlay
  skill of the same name, then the repo's still wins; given any job at all, then `PI_OFFLINE=1` is set.
  **Discovery of the host's own pi packages (issue #102).** Given a package the operator installed with
  `pi install` and `import-pi --with-packages`, then it is staged at the **exact version the host has on
  disk** (captured, never inherited from the source string, which may hold a range), printed by name with
  its provenance, and loaded in the next job; given a `pi-packages.json` entry for the same name, then the
  **declared entry wins** and the shadowed host version is printed, so pinning older than the host runs
  stays possible; given `--no-host-packages`, then only declared entries stage; given a host package that
  contributes no pi resources — **no `pi` manifest AND none of `extensions/ skills/ prompts/ themes/`**,
  which is pi's own predicate, not a `pi`-key requirement — then it is not staged **and the reason is
  printed**; given one whose `autoload` is off in pi's settings with no `+` pattern re-adding anything, then
  it is not staged and says so; given one pi only partly loads, then it stages **whole** with a warning,
  because staging copies a directory and "the package minus one skill" is not expressible; given a
  git-sourced host package, then it is skipped with a named reason; given the admin package on the host,
  then it is dropped with a reason **and the rest of the stage still lands** — all-or-nothing is scoped to
  the DECLARED set, since a discovered failure is an inference of ours and must not take the operator's
  declared pins down with it; given a host package whose managed path is absent, then pi's legacy global
  lookup is honoured **only then**, matching pi's own precedence; given no `settings.json`, an unreadable
  one, or a probe that fails, then discovery yields nothing, the reason is printed, and the exit code is
  **0** — one bad file on the host must not block the models/skills/persona half of the import. The stage
  receipt records `from` per entry so `doctor` can tell a discovered package from a declared one.
  **Enablement of the copied extensions (issue #102).** Given an extension the operator disabled with
  `pi config`, then `import-pi` does **not** copy it and lists it as disabled rather than suffixing the
  vetting list; given a disable expressed as a glob, then the extension **is** copied and the command prints
  that it could not evaluate the pattern (fail open, and say which). Reading pi's `settings.json` is not
  copying it: no part of that file reaches the overlay.
  **Refresh.** Given a re-stage while the worker is running, then the **next job** loads the new set with no
  restart; given a manifest that becomes unreadable after boot, then the last-known-good set is kept and
  logged, never silently degraded to none.
- **Repo-declared packages are still refused**, and this is settled rather than open (consistent with the
  non-goals recorded when staging was designed). A clone does not contain `.pi/npm/node_modules` unless
  somebody committed `node_modules`, so "auto-import from a repo" means "install what the repo declares",
  and there is no job-time install path at all: `PI_OFFLINE=1` makes pi's resolver unable to shell out to
  `npm`. What that forecloses is the **resolver's** install, not the container's reach -- a job container
  reaches whatever the deployment's egress allowlist permits (`REQ-EGRESS-ALLOWLIST`). More importantly,
  whoever can merge to the default branch can already instruct the agent; letting them add arbitrary npm
  packages puts third-party install-time and load-time code next to a live minted forge token in a
  container that can reach the forge, which is a materially bigger grant than editing a
  prompt. A repo's own `.pi/extensions/**` **does** load, and
  that is not a reversal of the same reasoning: `/workspace` holds the base repo's default-branch sha, so it
  is merge-gated rather than fork-controlled. If repo-declared packages are ever wanted, the shape is an
  operator allowlist, not a per-repo opt-in, because the repo is the thing that is not trusted.

---

## REQ-EGRESS-ALLOWLIST

- **Statement**: What a job container reaches on the network shall be bounded **by default**, with a
  control pi-dispatch itself applies. Every job runs on its own `--internal` Docker network whose only other
  member is an allowlist proxy, reaching listed hosts by name and nothing else; and a job whose policy
  cannot serve it shall be **refused before it spends**, with a reason naming what is wrong and no budget
  slot consumed. `PI_EGRESS=0` is the opt-out and takes a deployment back to the prior behaviour exactly:
  no `--network`, no proxy variable, no preflight spawn, and a docker argv byte-identical to one built
  before this requirement existed. The polarity is an opt-OUT because a control that ships off is a control
  nobody enabled, which is the state `OQ-004` spent a year in: a disclosure with a dead end at the end of
  it. **The upgrade path is part of the requirement**: a deployment that upgrades and does nothing has every
  job refused pre-spend, naming the proxy and the command that starts it, at zero budget slots and zero
  tokens. That is loud, free and reversible in one line, which is the failure this project prefers to a
  control that quietly does not apply.
- **Scope**: Every job kind and every forge, and every image nameable in `run.image` -- the network is the
  worker's argv, so an operator-built image inherits it the way it inherits `--cap-drop=ALL`. A resurrected
  sandbox joins the same kind of network (`INT-SANDBOX-CONTRACT`) and is **not** preflighted, because it
  spends nothing. **On by default**, and deliberately not per trigger: there is no `run.network`, no
  runtime-settings key and no model-callable parameter, because a per-trigger egress relaxation is a
  per-trigger security downgrade and the population that would want one should be editing the deployment
  instead. `DES-PER-TRIGGER-JOB-IMAGE` already drew this line: the image decides what is *in* the box, never
  what the box can *do*.
- **Why the check is pre-spend, which is the whole shape of the feature**: a job that cannot reach its
  provider **starts the container, spends its budget slot, and produces nothing**. Measured against the real
  runner: three provider attempts, `Request timed out.`, exit `1`, ~40 seconds, **zero tokens**. Exit `1` is
  the retryable class (`INT-RUNNER-EXIT-CODE-PROTOCOL`), the queue is configured for two attempts, and
  `releaseBudget` refunds only `container-never-started` -- this container started. So a misconfigured
  policy spends **two job-count slots per job**, buys nothing with either, and a cron-driven deployment can
  empty its daily cap before anyone reads the first failure. That is `CONST-BUDGET-BEFORE-TOKENS` working
  exactly as specified, on jobs that were never going to succeed, and it is why the gate is a free
  determinate refusal in front of the paid ones rather than a doc.
- **Why one network per job rather than one shared one**: a shared network is a shared L2 segment, and at
  `DES-CONCURRENCY-3` that is three mutually-untrusting issue authors who can reach each other.
  `enable_icc=false` is the obvious mitigation and is not one: ICC governs **every** container pair on the
  bridge and the proxy is a container, so it blocks job-to-proxy along with job-to-job (verified in both
  directions against a control). Per-job networks make job-to-job **structurally impossible**, which is
  strictly stronger than what preceded it -- two job containers on docker's default bridge can reach each
  other by IP today, so this **removes** an adjacency rather than adding one. It costs ~190ms to build and
  ~260ms to tear down, against a container run of minutes.
- **The provider is an ordinary allowlist entry, and the record that said otherwise is corrected here.**
  `OQ-004` and `docs/sandbox.md` recorded that the runner's provider call does not follow `HTTPS_PROXY` even
  with `NODE_USE_ENV_PROXY=1`, and concluded a proxy could not carry provider traffic. The observation was
  real; the cause was not pi. The Anthropic SDK resolves `globalThis.fetch` at construction and pi passes it
  no dispatcher, so the call follows the process's global dispatcher, and the pinned image's Node installs a
  proxy-aware one when the flag is set (verified: the same client follows a dead proxy to `ECONNREFUSED`
  with it, and goes to DNS without it). What actually happened is that the container env is a **closed
  allowlist** and the recipe's `PI_FORWARD_ENV` line named three variables, not four -- the flag never
  reached the runner. The worker now emits all four itself, in the closed map, so arming the policy cannot
  half-work, and `PI_FORWARD_ENV` refuses those names at boot while it is armed.
- **What is checked pre-spend, and what deliberately is not.** One determinate host-side fact: the proxy is
  running. That is one `docker inspect` when armed and **zero spawns** when not. Reachability is **not**
  probed per job: it would convert a determinate gate into a flaky one, and a flaky pre-spend gate has no
  good class (as POLICY it drops real work on a blip, as INFRA it retries and burns the second slot this
  requirement exists to save), it doubles the container starts a deployment makes, and the only
  credential-free way to prove it is an unauthenticated request to a third party before every job.
  **Honest gap**: an allowlist missing a host the flows need is not pre-spend detectable, and that job pays
  the two slots. `doctor` proves the whole path once, when a human asks, using the job image's own node --
  which also proves that image honours `NODE_USE_ENV_PROXY`, the property a stale one would silently lack.
- **Traces to**: `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-BUDGET-BEFORE-TOKENS`, `CONST-RETRY-INFRA-ONLY`,
  `CONST-TOKEN-SCOPED-PER-JOB`, `INT-EGRESS-POLICY-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`,
  `INT-SANDBOX-CONTRACT`, `REQ-DEPLOYMENT-BOOTSTRAP`, `DES-EGRESS-DENY-ON-A-DEDICATED-NETWORK`,
  `OQ-004`, `OQ-011`
- **Acceptance**: Given `PI_EGRESS=0`, a job's docker argv and container env are byte-identical to ones
  built before this requirement existed and the preflight spawns nothing. Given any other accepted value and
  a running proxy, every job's argv carries `--network=pi-job-<jobId>-net` and its env carries all four proxy
  variables; a job reaching a listed host succeeds and one reaching an unlisted host is refused by the proxy
  rather than by the agent; and the network is removed when the container exits. Given a proxy that is
  absent or stopped, the job returns `outcome: "policy"` with `budgetReserved: false` and reason
  `egress-proxy-missing` or `egress-proxy-stopped`, `docker run` is never spawned, and the queue does not
  retry it. Given a daemon that does not answer, the job throws and IS retried. Given a configured
  deployment, `pi-dispatch doctor` reports the proxy's state and proves both directions of the policy
  without spending a token, and no check it emits carries a `fixAction`.

## REQ-RESUMABLE-SESSION

- **Statement**: A trigger may set `run.resume: true`, and a job whose **key** resolves shall then run on
  the session transcript the previous job for that key produced, instead of a fresh one. The key is
  derived, never looked up: `(forge, repository, head branch)` for a forge job, and the scheduler id for a
  cron job **once the local path is wired** (see Scope). Absent or `false` is today's behaviour exactly —
  no transcript is written, no mount is created, and the docker argv is byte-identical to one built before
  this feature existed.
- **Scope**: Forge triggers, all four forges. A CLI `pi-dispatch run` and a chained `/outbox` child have
  no trigger entry that could arm the flag and therefore never resume. **Cron is refused at load, not
  silently ignored** (issue #99): the session store is handed only to the forge preparers, so a `local`
  job would never resolve a key, and `run.resume` on a cron trigger is a fail-loud `configError` naming
  the field and the reason — `run.replicas`' precedent, for `run.replicas`' reason ("a field accepted
  where it does nothing is how an operator comes to trust one that does nothing"). The key material for a
  cron job exists in `session-key.mjs`, so this is a gap to close rather than a limit, and the refusal
  message says so.
- **Why**: A follow-up job on a pull request is a cold start today — new container, fresh clone, empty
  transcript — so the agent re-explores the repository and re-derives the decisions it made an hour ago
  before it can act on a two-line review comment. Nothing about that was wrong; resuming was never a case
  the design had to serve. What makes it affordable is that the join already exists: an issue-triggered
  job is told to push to `pi/issue-<n>`, so the pull request's head ref IS the issue's branch, and the
  host can compute both without recording anything.
- **Fail OPEN, and say so.** A missing, expired, oversized, unparseable, locked or foreign transcript, a
  conversation past its age bound, an unresolvable head ref, or a fork — every one degrades to a cold
  start and **never fails the job**. Each is a NAMED reason in the run record
  (`INT-RUN-HISTORY-FILE-CONTRACT`), because a feature that fails open is otherwise indistinguishable from
  a feature nobody switched on, which is how "we never resumed once in three months" goes unnoticed.
  **Naming it in the record is half the requirement, and for its first year only half was met**: a refused
  read stages a 0-byte transcript, the container is handed it regardless, pi finds no messages in it and
  reports `absent`, and the record took the container's word — so `expired` and `pi-version-changed`
  reached no completed record at all. A host gate that refused now outranks that one runner token, which
  is a restatement of the question rather than an answer to it. The container keeps every verdict it is
  the only one able to give.
- **Eligibility bounds are OPT-IN and measure their own quantity.** Beyond the file's own shape, an
  operator may bound how old the CONVERSATION is (the session header's timestamp, a different clock from
  the TTL: mtime is refreshed by every COMPLETED run, so a lineage that keeps finishing work never ages out
  however old its first turn is), how many times in a row the host has HANDED THE TRANSCRIPT OVER, and how
  full the saved context already is. Each bound is off unless set, each trip is a cold start with its own
  reason token, and an unset bound leaves the read path byte-identical. A bound that cannot obtain its
  measurement neither invents one nor guesses, and WHICH WAY it fails depends on what absence means. Where
  the quantity is on the transcript's own header it fails CLOSED, since a conversation that cannot say how
  old it is has not been shown to be young enough. Where it is reported by the container or kept as host
  bookkeeping it fails OPEN, since absence there means an image predating the field or a key older than the
  counter rather than a fact about the lineage, and reading it as a refusal would cold-start an operator's
  whole store on the day they set the bound.
- **What these bounds are, and what they are not.** They bound how much history accumulates. Two of the
  three read values the agent itself can write: the header's timestamp, and the occupancy the container
  reports. An agent with code execution in its own container can defeat those two, and can in any case
  carry content across runs inside the transcript it owns, whatever any bound decides. The one bound that
  rests on nothing inside the container is the resume chain, which counts the host's own deliveries and is
  why it counts those rather than what pi made of them. Stated here rather than left implicit, because the
  honest scope of a control belongs with the control (`OQ-003`, `OQ-014`).
- **One case fails CLOSED.** A trigger that armed `run.resume` while `PI_SESSIONS_DIR` is unset refuses
  **pre-spend** rather than running unpersisted. Running it silently would be the failure
  `validatePackagesFlag`'s own comment describes one flag over: an operator who believes a thing is on
  while it is off, with a green run to confirm the belief.
- **One writer per key.** Promotion takes an exclusive per-key lock; a job that cannot take it runs cold
  with no persistence, never queued and never failed. Two jobs on one pull request inside one runtime is
  an observed shape (`REQ-QUEUE-BURST-NO-DROP`), and last-write-wins there would interleave two agents'
  turns into one transcript and then resume whichever wrote last.
- **Traces to**: `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-RETRY-INFRA-ONLY`, `CONST-ISSUE-TEXT-IS-DATA`,
  `CONST-TOKEN-SCOPED-PER-JOB`, `INT-SESSION-STORE-CONTRACT`, `INT-RUN-HISTORY-FILE-CONTRACT`, `OQ-014`
- **Acceptance**: Given a trigger without `run.resume`, no file is written under `PI_SESSIONS_DIR`, no
  `/session` mount appears in the docker argv, and `PI_SESSION_FILE` is not in the container env. Given an
  armed trigger whose key resolves and whose previous run completed, the job's prompt is the resumed shape
  and the record reads `session.resumed: true`. Given a fork pull request, no key resolves. Given a
  non-completed exit, the canonical transcript is unchanged. Given an armed trigger with `PI_SESSIONS_DIR`
  unset, the job is refused before a budget slot is reserved. Given `PI_SESSION_MAX_AGE_DAYS` set and a
  transcript whose header timestamp predates it, the job runs cold with `session.reason:
  conversation-too-old` even though the file's mtime is fresh, and that token is what the record shows.
  Given `PI_SESSION_MAX_RESUME_CHAIN` set to 3, three consecutive deliveries make the fourth job cold with
  `resume-chain-too-long`, whatever the container reported about them, and that cold run's own completion
  lets the lineage start again. Given every bound unset, the read path stages the same file and the
  container is handed the same mount set as a pre-bounds run. Two things are deliberately NOT identical: a
  completed promotion also writes the chain counter, so that setting a bound later is honest immediately
  rather than N runs later; and a run whose host gate refused records the gate's own token where it used to
  record the container's `absent`.

## REQ-RESURRECTABLE-SANDBOX

- **Statement**: A finished run's per-job directory shall be retained for a bounded window, and
  `pi-dispatch sandbox <jobId>` shall start a **new** container from that run's image with that run's
  mounts as an interactive operator shell holding **no credentials**. The job container is unchanged:
  still `--rm`, still no TTY, still no published port. With the window at `0` nothing is retained and
  teardown is the `rm -rf` it always was.
- **Scope**: Every job kind. A forge job's clone travels with its directory; a local job's workspace is
  the operator's own folder and is never moved, so only its `/job` inputs and `/outbox` are retained.
  Available from the CLI and from the admin panel's RUN_DETAIL screen; never from a trigger, an
  `/outbox` chain request, or a model tool.
- **Why**: Perhaps 5% of runs end on a question the run record cannot answer — *does the thing it built
  actually work?* Three separate facts make that unanswerable today: `--rm` disposes the container at
  exit, stdin is `ignore` with no TTY so nothing can be typed into a live run either, and for a forge
  job `cleanup` deletes the directory the clone lives in. The first two are load-bearing and must not
  move; only the third is incidental. So the container is not kept alive — it is made reproducible, and
  the *only* thing that had to change is how long its inputs survive it.
- **What is NOT preserved, and the contract says so.** Process state and every filesystem change outside
  `/workspace`. Same image plus same workspace, fresh processes. That covers "start the app and click
  through it"; anything a run installed outside the workspace belongs in the image. A `docker commit`
  snapshot would preserve more and is rejected in `DES-SANDBOX-IS-A-FRESH-CONTAINER` — gigabytes per run
  to serve a case image+workspace already serves.
- **No credential, and it is not a knob.** No minted forge token, no provider key, no forwarded host
  variable; the container env is `TERM` and `TMOUT`. `buildContainerEnv` is deliberately not reused —
  it writes the mint into that forge's variable names and throws when no provider credential resolves,
  so a credential-free container cannot be produced from it. An operator who needs to push authenticates
  themselves inside the shell.
- **Bounded, and swept like every other artifact.** `PI_SANDBOX_RETENTION_HOURS` (default 24) with a
  boot sweep, `--pin` extending ONE run to `now + PI_SANDBOX_PIN_DAYS`. A pin is a timestamp, never a
  boolean: there is no keep-forever value, because a repository clone per run with no ceiling is
  unbounded growth wearing a feature's clothing. `0` means the feature is OFF — the OPPOSITE of
  `PI_LOG_RETENTION_DAYS` and `PI_SESSIONS_TTL_DAYS`, where `0` means keep forever — and it sweeps what
  an earlier setting retained, so turning it off turns it off.
- **The transcript is excluded by construction.** A retained directory may contain a job's `/session`
  copy, which is the most PII-bearing artifact this system holds and belongs to `PI_SESSIONS_DIR`'s own
  TTL (`INT-SESSION-STORE-CONTRACT`). It is deleted BEFORE the directory is retained. Carrying it along
  would not weaken the session policy so much as end-run it, since `--pin` can extend this window and
  cannot extend that one.
- **Traces to**: `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-TOKEN-SCOPED-PER-JOB`,
  `INT-SANDBOX-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`, `INT-SESSION-STORE-CONTRACT`,
  `DES-SANDBOX-IS-A-FRESH-CONTAINER`, `OQ-016`
- **Acceptance**: Given `PI_SANDBOX_RETENTION_HOURS=0`, a job's `docker run` argv is byte-identical to
  one built before this feature existed and its per-job directory is deleted at teardown. Given the
  default window, a finished run is listed by `pi-dispatch sandbox --list` and `pi-dispatch sandbox
  <jobId>` opens a shell in its workspace; inside it, no forge token and no provider key are set, and
  `capsh --print` shows no capabilities. Given `--publish 3000`, the port is reachable at `127.0.0.1`
  and an explicit non-loopback bind is refused. Given a worker restart while a sandbox runs, the
  container survives (`docker ps --filter name=pi-job-` never matches it) and its directory is not
  swept. Given a run whose window has closed, the refusal names the window. Given a job that persisted a
  session, no transcript exists anywhere under the retention root.

## REQ-REPLICA-RUNS

- **Statement**: A forge webhook trigger may set `run.replicas: <int 2..3>`, and one matching delivery
  shall then produce exactly that many **independent** jobs — distinct job ids, distinct semantic dedup
  keys, distinct sandboxes, distinct branches, and for a development flow distinct pull requests — each
  carrying its own 1-based replica index. Absent, a delivery's behaviour is **byte-identical** to before
  the field existed.
- **Scope**: `label`, `comment` and `pull_request` triggers on every forge — `github`, `gitlab`, `forgejo`
  and `azure` (issue #187). Refused at config load on `cron`/`local`, and refused beside `run.resume: true`.
  **Webhook only on the three non-GitHub forges**: the poller is GitHub-only by construction, so a replica
  set there is minted by a delivery and never by a poll, and this requirement claims no parity it does not
  have. Set from the reviewed triggers file only — never a model tool, never a settings-overlay key.
- **Why**: Some work is urgent enough that token cost stops mattering, and the useful thing to buy with it
  is not a longer run but a **second opinion**: two agents solving one issue independently, two pull
  requests, one human picking. Every layer of this system is built to prevent that, correctly, by default
  — the delivery-GUID job id, the 10-minute semantic window, the deterministic `pi/issue-<n>` branch, and
  the derived session key each collapse N attempts into one. So the requirement is not "add parallelism";
  it is **punch a replica discriminator through exactly those four layers, on purpose, without loosening
  any of them for an unflagged run**.
- **The four layers, and what each is given.** The BullMQ job id becomes `<prefix><id>-r<i>` — `gh-`, `gl-`,
  `fj-` or `az-` from the forge table — which makes the
  container name, `PI_JOB_ID`, and the `.log`/`.json` sidecars replica-distinct for free. The semantic
  dedup key gains `:r<i>` **only when a replica is set**, so re-deliveries of *each* replica still coalesce
  inside the window while replicas never coalesce against each other. The branch becomes
  `pi/issue-<n>-r<i>`, minted by the same `issueBranch` the session key derives from. The session key is
  left **unchanged**, which is safe only because of the refusal below.
- **`resume` and `replicas` are refused together, and that refusal is load-bearing.** A resumed run
  continues one lineage; replicas exist to fork it. Without the refusal, every replica of one issue would
  derive the **same** session key, share one transcript, and contend for the store's one-writer lock —
  and the resumed prompt envelope says *"Do not open a second pull request"*, which is the exact opposite
  of what a replica is for. The coupling is stated in `triggers.mjs`, `branch.mjs` and `session-key.mjs`,
  because it is invisible from any one of them.
- **Local and cron are out of scope for a hazard, not for tidiness.** A local job's `/workspace` *is* the
  operator's folder, bind-mounted read-write and edited in place, so two replicas would edit one working
  tree with no gate and no undo. A forge job gets its own `mkdtemp`'d clone, which is the whole reason it
  is safe there. Cron's own self-overlap turned out to be REAL (`DES-CRON-VIA-BULLMQ-SCHEDULER`,
  corrected in issue #242) and is closed for folders by the mutex `REQ-SCOPED-LIMITS` specifies — this
  entry's refusal of local replicas was the position that mutex generalizes.
- **Chain fanout is already bounded, and was checked rather than newly closed.** `outbox.mjs` returns
  early for any non-`local` job and a forge job has no `/outbox` mount at all, so a replica — always a
  forge job, on any of the four — can never chain. No new bound was needed; the existing guard covers it.
- **Budget is deliberately untouched, and that is the feature.** N replicas make N honest reservations,
  each before its own tokens in its own processor (`CONST-BUDGET-BEFORE-TOKENS`). The daily, weekly and
  monthly caps remain the ceiling and simply divide by N — and since issue #242 a repo's own scoped
  windows join those ceilings: N replicas are N reservations on ONE scope, so a scoped refusal truncates
  a replica set exactly as the global cap always could, now with a scope-naming reason (`scope-cap`).
  Softening them for replicas would have turned a cost multiplier into a cap bypass.
- **A stale image is refused pre-spend.** The feature is half prompt and half **safety floor**: a
  replica's user prompt names `pi/issue-<n>-r2`, while an image built before this change bakes a
  `HARD_RULES.md` whose rule 3 hard-codes `pi/issue-<n>` as a **system** rule — authoritative over the
  user prompt. Both replicas would converge on one branch, nothing would error, and the operator would
  pay twice for one pull request. So an image must declare `dev.pi-dispatch.capabilities: replicas`, and
  a replica job on one that does not is a policy refusal (`job-image-replicas-unsupported`) before any
  credential is minted or any slot reserved.
- **What is NOT delivered, by design.** No sibling cancellation — half a cancelled run still costs tokens
  and destroys the comparison the feature exists for. No auto-judging of the resulting pull requests: two
  pull requests, one human, done. And on a **pull_request-typed** target the two replicas share the PR's
  head branch, which the harness cannot bound; only the prompt asks them not to collide (`OQ-017`). The
  PR title marker `[r<i>/<n>]` is likewise agent-honored prompt text — **the branch name is the only
  host-enforced replica identity**, and this requirement says so rather than implying otherwise.
- **Traces to**: `CONST-BUDGET-BEFORE-TOKENS`, `CONST-ISOLATION-CONTAINER-PER-JOB`,
  `REQ-DEDUP-BY-DELIVERY-GUID`, `REQ-RESUMABLE-SESSION`, `REQ-DURABLE-RUN-HISTORY`,
  `INT-TRIGGERS-FILE-CONTRACT`, `INT-RUN-HISTORY-FILE-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`,
  `INT-OUTBOX-CONTRACT`, `DES-REPLICA-INDEX-REACHES-THE-BRANCH`, `OQ-017`
- **Acceptance**: Given a github label trigger with `"replicas": 2` and one matching delivery, then two
  containers run (`pi-job-gh-<guid>-r1` and `-r2`), two branches `pi/issue-<n>-r1`/`-r2` exist, two pull
  requests are opened, **two** budget slots are reserved, and two run records carry `replica`/`replicas`.
  Given a redelivery of that same webhook inside the 10-minute window, then **nothing further is
  enqueued** — both job ids are taken and both dedup ids are in-window. Given the same trigger without
  `replicas`, then exactly one container runs on `pi/issue-<n>`, and the enqueued `data` keys **and** the
  semantic dedup id byte-match a pre-feature run. Given `run.replicas: 2` on a **gitlab**, **forgejo** or
  **azure** `label`/`comment`/`pull_request` trigger and one matching delivery, then that forge's own
  prefixes and separators carry the discriminator: two jobs `gl-<id>-r1`/`-r2` with dedup ids
  `project!5:flow:r1`/`:r2` on a merge request, `project#5:…` on an issue. Given `replicas` on a cron
  trigger or beside `resume: true`, then config load fails in **all three** loaders — worker, receiver and
  the admin console's bundled copy — naming the field and the reason, and a running receiver keeps its
  previously loaded rules. Given a replica job whose image does not declare
  `replicas`, then it refuses pre-spend with `job-image-replicas-unsupported`, comments on the issue, and
  spends nothing. Given a failure enqueueing replica *k*, then the receiver answers 503 with replicas
  `1..k-1` queued, and the redelivery converges on exactly *n* jobs rather than *n + k − 1*.

## REQ-TRIGGER-SECRETS

- **Statement**: A trigger MAY carry `run.secrets`, a map of environment variable name to an opaque
  reference, and `run.secretsProfile`, the name of an operator-declared resolver profile. Before the job
  container starts, and before anything spends, the worker SHALL run the selected resolver once per
  reference with the reference as its first argument, take its standard output as the value, and inject the
  resolved values into the closed container environment. The job container SHALL receive values only: it
  never receives the operator's manager credential, never reaches a vault, and cannot enumerate one. Absent,
  a job's environment, its `docker run` argv and its run record are byte-identical to one prepared before
  this existed.

- **Scope**: All four trigger kinds, cron included. Operator-authored config from the reviewed
  `triggers.json` only. NOTHING reachable from a webhook payload, an issue or comment body, `dispatch_run`
  or a chained job's `/outbox` can supply either field, and no model-callable tool can set them: the trigger
  writers carry no `secrets` parameter and no `secretsProfile` parameter. The profile TABLE is deployment
  state, declared in `PI_SECRET_PROFILES` or through the operator-typed `/dispatch secrets` command, never
  by a tool. A chained child inherits neither field.

- **Why**: **The reference grammar belongs to the resolver, and never to this project.** `op://vault/item`,
  `secret/data/ci#stripe` and a bare name are all correct inputs, because what parses them is a script the
  operator wrote. This is `DES-SERVICE-ENV-SETUP-SEAM`'s posture moved from boot time to job time, and the
  same one #206 and #209 already recorded while refusing to endorse a vendor. A regex here that recognised
  one manager's notation would bless that manager.

  **A value crosses the container boundary; the thing that can fetch values does not.** `docs/secrets.md`
  already refuses to put `VAULT_TOKEN` or its kin into a job, on the ground that a credential which can read
  every secret in a project is strictly worse than the two a job already carries. Resolving host-side keeps
  that refusal intact while still letting one trigger hold one key: the exposure is bounded by what the
  operator named in a reviewed file, rather than by what a vault happens to contain.

  **The reviewed artifact names FIELDS, and that is the point.** A trigger enumerating
  `op://vault/item/field` stays true as the vault grows, which is the property a vault-name grant
  structurally cannot have: naming a vault is how a capability review decays silently.

  **Resolution is pre-spend because a refusal must be free.** A missing item, a wrong reference or an
  expired worker credential costs no token mint, no clone and no budget slot. The alternative, discovering
  it inside a paid container, is the failure `OQ-026` describes for egress and the one this design refuses
  to repeat.

- **Traces to**: `INT-TRIGGERS-FILE-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`, `INT-CONFIG-OVERLAY-CONTRACT`,
  `INT-RUNNER-EXIT-CODE-PROTOCOL`, `INT-RUN-HISTORY-FILE-CONTRACT`, `DES-PER-TRIGGER-SECRET-PROFILE`,
  `DES-SERVICE-ENV-SETUP-SEAM`, `CONST-TOKEN-SCOPED-PER-JOB`, `CONST-BUDGET-BEFORE-TOKENS`,
  `CONST-RETRY-INFRA-ONLY`

- **Acceptance**: Given a trigger carrying `run.secrets`, it loads in all three loaders (worker, receiver,
  and the admin extension's bundled copy) and an unflagged trigger's job data, container env and record are
  byte-identical to before the field existed. **At load**, the file is refused when a key is not an
  environment variable name, when a value is not a non-empty string, when a value has surrounding whitespace
  or starts with `-`, when more than sixteen references are named, when a key collides with a name the
  worker writes itself (`MINTED_TOKEN_VARS`, `FORGE_HOST_VARS`, `WORKER_ONLY_SECRET_VARS`, `EGRESS_ENV_VARS`
  or the closed map's own `PI_*`/`PLAYWRIGHT_*`), when `run.secretsProfile` names nothing resolvable, and
  when `run.secrets` appears beside `run.resume: true`. **Pre-spend, per delivery**, the job is refused with
  `budgetReserved: false`, no token minted and no clone, as `secret-profile-unknown` when no declared profile
  matches or its resolver is absent, not executable or outside `PI_SECRET_RESOLVER_ROOTS`; as
  `secret-profile-ambiguous` when one name is declared in both the environment and the overlay; as
  `secret-name-reserved` when a key collides with the resolved provider's credential variables or a
  `PI_FORWARD_ENV` name; and as `secret-unresolved` when the resolver exits 2, returns nothing, overruns the
  size cap or returns a value containing a NUL. A resolver that exits 1, exits with an unrecognised code, or
  times out is INFRASTRUCTURE and the job is retried as `secret-resolver-unreachable`. A refusal names the
  field or the variable and never the reference, the resolver's path or its standard error. The whole job
  refuses rather than injecting a partial set. A resurrected sandbox carries exactly `TERM` and `TMOUT`, and
  `doctor` fails when a trigger names a profile no deployment entry declares.

## REQ-DEPLOYMENT-BOOTSTRAP

- **Statement**: The CLI shall take a fresh machine to a preflighted deployment through **create-only
  scaffolds and per-action consented host mutations** — `pi-dispatch init` (scaffold), `pi-dispatch
  doctor [--fix]` (preflight; offered fixes), `pi-dispatch up [--yes]` (the consented sequence:
  default-image pull+tag, loopback Valkey start, scaffold, preflight) — and shall never perform an
  unshown host mutation, never touch an existing config value, and never spend a token.
- **`doctor` reports a bound that is set and asleep.** A knob an operator sets, doctor stays silent about,
  and nothing enforces is this project's own believed-on-while-off failure by another route, so where a
  feature's control CAN be inert for a reason the operator cannot see from their own configuration,
  `doctor` says so. `PI_SESSION_MAX_CONTEXT_PCT` is the case that made this normative: its measurement is
  produced by the job image's runner, an older image reports none, a bound with no measurement passes by
  design, and there is deliberately no image capability to check it against. The resume bounds are also
  printed as a plain fact line, because three of the four are off by default and silent when unset, which
  leaves no way to tell a deliberate "no bound" from a forgotten one. Neither line carries a `fixAction`:
  how long a lineage may run is an operator's decision, not a mechanical remainder.
- **Scope**: Deployment setup, repair, and process supervision on the operator's own host —
  `pi-dispatch service <render|install|uninstall|status|start|stop|restart [--drain]>` renders the
  shipped deploy/ templates with computed absolutes (`process.execPath`, the real repo root — the
  shipped `/usr/bin/node` literal does not exist on an nvm host) and installs **user-level** by
  default; system-wide stays a printed sudo command, never executed. `render` and `install` also take
  **`--env-setup <absolute path>`**, the one seam by which anything runs before the worker does: the
  renderer sources that script and then **`exec`s** the worker itself, so a determinate refusal still
  reaches the service manager as exit 2 (`DES-SERVICE-ENV-SETUP-SEAM`). Three clauses are normative.
  (1) The path is **operator-typed only** — a CLI argument, never read from `.env`, a trigger file, the
  panel, the deployment pointer, or anything a model can write; the wrappers capture `PI_ENV_SETUP`
  before they source `./.env` precisely so file content cannot name it. (2) A missing or failing setup
  is **exit 1**, the infrastructure code, never exit 2, so a transient manager failure retries and is
  never mistaken for the refusal that must stay stopped; the worker does not start on a half-filled
  environment. A stop that arrives *while* the environment is being prepared is honoured by the same
  rule and the same means: the wrappers trap `TERM`/`INT` **before** they source anything, re-assert
  after (a sourced script runs in their own shell and can replace or ignore the handler), and **refuse
  to launch the command at all** — exit **0**, the only code launchd's `KeepAlive` leaves stopped, with
  the reason on stderr. A stop arriving at any point after the launch reaches the worker, including the
  window in which the wrapper has forked and does not yet know the child's pid
  (`DES-WRAPPER-STOPS-WHAT-IT-STARTED`). (3) With no `--env-setup`, every rendered artifact is **byte-identical** to what this
  command produced before the seam existed, on all three platforms. Because that path exists nowhere
  but the rendered unit, **`doctor` reads the unit back** to check the script: the `ExecStart` line on
  systemd, the `EnvironmentVariables` dict on launchd, `nssm get … AppEnvironmentExtra` on Windows —
  and only for units whose `WorkingDirectory` is this deployment, with `PI_ENV_SETUP` in doctor's own
  environment answering only when no unit does. It reports existence, group/world **writability** of
  the script and of the non-sticky directory holding it, and a git work tree that does not ignore it;
  every one is warn-tier, none carries a fix action, and the script's contents are never read. With no
  seam configured doctor's output is byte-identical. `service status` names the same path, without a
  verdict. Not job execution, not
  forge-side configuration (webhooks, branch protection, App installation). The admin extension's
  `/dispatch setup` wizard (issue #92, `DES-FIRST-RUN-SETUP-WIZARD`) is **in scope as a driver, not
  as a power**: it reaches these same CLI actions through their own consent gates and adds only the
  deployment pointer (`INT-DEPLOYMENT-POINTER-CONTRACT`).
- **Why**: The quickstart was five hand-typed infra chores whose commands were already fixed strings —
  automation removes typing, not decisions. The decisions stay human: every mutating action is printed
  verbatim and runs only on an explicit accept (y/N, default No, No on non-TTY), because "pulled onto
  that host yourself" (`SECURITY.md`) is a trust property the consent keypress preserves and a silent
  bootstrap would erase. Fix tiers are closed sets (`DES-CLI-SURFACE`): silent = init's create-only
  scaffolds + `mkdir` of env-declared paths; prompted = the deployment's own default image, the
  loopback Valkey, an overlay `auth.json` delete, an `import-pi` restage under its own gates; never =
  malformed-config rewrites, triggers/pause-windows/scoped-limits content, trigger-named images,
  semantic env guesses, an env-setup script's mode or location. `up` may set `WEBHOOK_SECRET` in a scaffolded
  `.env` **only when the key is empty** — a generated secret is never printed and an operator's value
  is never replaced.
- **Traces to**: `DES-CLI-SURFACE`, `CONST-BUDGET-BEFORE-TOKENS`, `SECURITY.md` (pull-it-yourself),
  `REQ-GLOBAL-PI-OVERLAY` (doctor's existing obligations)
- **Acceptance**: Given `up` with every prompt declined, then no docker command runs, init reports its
  usual kept/written lines, doctor renders, and the summary names each skipped action. Given `--yes`,
  then exactly the shown commands run, in order. Given a `.env` whose `WEBHOOK_SECRET` has a value,
  then `up` leaves the byte untouched. Given `doctor --fix` on non-TTY stdin, then every prompt-tier
  fix is skipped as declined. Given a failing check with no fix action (malformed JSON, a missing
  trigger-named image), then `--fix` prints today's fix line and offers nothing. Given an installed unit
  for this deployment naming an `--env-setup` script, then doctor reports on that script by path and
  offers no fix for any finding; given no such unit and no `PI_ENV_SETUP`, then doctor's output gains
  not one line. Given a `TERM` delivered to the wrapper while `PI_ENV_SETUP` or `./.env` is still being
  sourced, then the command is never launched, the wrapper exits 0, and stderr names the stop; given a
  `TERM` delivered between the fork and the child's pid becoming knowable, then it is re-sent once the
  pid is known and the command still gets its full drain; given a setup script that installs or ignores
  a `TERM` trap, then the wrapper's own handler is the one that runs. Given any `up` run,
  then no path reserves budget, enqueues a job, or reads a provider key beyond doctor's existing
  presence checks.

## Notes (not requirements)

**Capacity and cost.** ~1.5–2.5 GB RAM per job (pi + dev server + headless Chromium) and roughly
$0.5–$5 per job are **unmeasured estimates** — the design document says "measure!" and notes no
published figures exist. A requirement needs a testable threshold; a guess is rationale at best. These
inform `DES-CONCURRENCY-3` and are tracked at `OQ-002`. Only the budget caps graduate to a constraint
(`CONST-BUDGET-BEFORE-TOKENS`), now spanning day/week/month windows plus a soft-hold band
(`REQ-SPEND-CAPS-MULTI-WINDOW`).

**Burst math.** 50 triggers at concurrency 3 and ~10 min/job drains in ≈2.8 hours. That is the
wait-list working as designed, not a failure — see `README.md`.

---

## REQ-MULTI-HOST-COORDINATION

**As** an operator running pi-dispatch on more than one machine, **I want** the workers to know about each
other, **so that** the things that silently assume one host either work across the fleet or refuse loudly
instead of drifting.

- Every worker has an IDENTITY: `PI_WORKER_NAME`, defaulting to this machine's sanitized hostname. It is
  always populated, so a fleet of two can be told apart before anyone has configured anything.
- Every worker PUBLISHES a row about itself and can READ its peers' (`INT-HOST-REGISTRY-CONTRACT`).
- The identity reaches the operator where they already look: on every worker log line, in every run
  record, on the boot line, and as the BullMQ worker name.
- **A single-host deployment is unchanged in every way that decides anything.** The registry runs, because
  a fleet must be detectable before it is configured, but nothing reads it to make a decision a single
  host makes differently, and no job path gains a Valkey round trip.
- **Nothing here may be able to refuse a job or block a boot.** The registry is telemetry plus, later, a
  source of refusals that are loud by design; a fault in it costs a panel row and never a run.

**Acceptance**

- Given no `PI_WORKER_NAME`, when the worker boots, then its name is this machine's hostname reduced to
  the name charset, and two spellings of one machine (`Robs-Mac-Mini.local`, `mac-mini`) do not become two
  identities.
- Given a `PI_WORKER_NAME` that is not in the charset, does not begin with a letter or digit, exceeds 64
  characters, or ends in `.json` or `.log`, when the worker boots, then it refuses with a message naming
  the variable -- a declared name is never silently repaired.
- Given a reachable Valkey, when the worker boots, then a row for this host exists and is refreshed; and
  when the worker shuts down cleanly, then the row is DELETED rather than left to expire.
- Given a Valkey that never answers, when the worker boots, then it still comes up and drains, because the
  first beat is not awaited.
- Given the whole `host:*` keyspace is deleted while the fleet runs, then every host behaves exactly as it
  did before the keyspace existed.

- **Traces to**: `INT-HOST-REGISTRY-CONTRACT`, `DES-HOST-REGISTRY`, `INT-RUN-HISTORY-FILE-CONTRACT`,
  `DES-CONCURRENCY-3`, `OQ-008`, `OQ-012`


## Revision History

| Date | Change |
|---|---|
| 2026-08-30 | Issue #57, the identity slice. **NEW `REQ-MULTI-HOST-COORDINATION`**: workers get an identity and a way to see each other, with the two properties that bound everything later in the issue stated as acceptance rather than left implied -- a single-host deployment is unchanged in every way that decides anything, and nothing in this layer may refuse a job or block a boot. The last acceptance line is the falsification test: delete the whole `host:*` keyspace while the fleet runs and every host must behave exactly as before. **`REQ-DURABLE-RUN-HISTORY` UNCHANGED, checked**, and the check is the substantive one: its acceptance says the record contains no issue or comment body, title, or username, and the new `host` field satisfies it -- no path from any payload reaches the value, it is fixed at boot from one environment variable, and its charset cannot express a path. What it is not is anonymous, since the default is a hostname; that is argued as operator-disclosed in `INT-RUN-HISTORY-FILE-CONTRACT` rather than waved past here, and `PI_WORKER_NAME` is the documented answer. No new datastore: the sidecars remain the durable record. **`REQ-LOCAL-JOB-VISIBILITY` UNCHANGED, checked**: its no-pii-in-logs note now covers one more field per line, and a worker name is deployment configuration rather than payload text. **Code evidence**: worker/src/config.mjs -> WORKER_NAME_RE, sanitizeWorkerName, defaultWorkerName; worker/src/host-registry.mjs -> makeHostRegistry. |
| 2026-08-30 | **NEW `REQ-WAIT-FOR`** (issue #230): a trigger may carry a conjunction of conditions that must clear before its job starts, and a job whose conditions have not cleared is HELD — deferred, spending nothing, consuming no attempt, surviving a restart, and running exactly once when they clear. The statement records why a hold had to be a third thing: `CONST-RETRY-INFRA-ONLY` splits outcomes into retry-now and stop, and a policy return would DROP a job that a forge will never re-trigger. It also records why the cheap tier exists at all — a one-shot instant is structurally inexpressible in pause windows, whose `from == to` refusal exists precisely so a window cannot become an unbounded hold — and why every bound in the expensive tier is mandatory rather than prudent: a held job spends no money, so `CONST-BUDGET-BEFORE-TOKENS` cannot see it, and no ceiling this project already has applies. **`REQ-SCOPED-PAUSE-WINDOWS` UNCHANGED, checked**: the pause gate keeps its position, its window-end semantics and its raw-scope matcher; the wait gate sits AFTER it and reuses only the seam, so a paused job burns no wait evaluation. **`REQ-SCOPED-LIMITS` UNCHANGED, checked**: the folder mutex and the scoped ledgers are untouched, and the wait gate sits BEFORE the scope acquire so a job waiting until tomorrow does not hold a folder while it waits. **`REQ-TRIGGER-SECRETS` UNCHANGED, checked**: the resolver seam is the model this borrows from and neither its table nor its position moved; the two are separate variables on purpose, so a resolver cannot be reached as a gate. **Code evidence**: worker/src/index.mjs -> makeProcessor; worker/src/wait-for.mjs -> afterInstantMs, unreadableConditions. |
| 2026-08-29 | Issue #242, enforcement slice, one CORRECTION and one new entry. **`REQ-CRON-SCHEDULED-JOBS` CORRECTED**: its Why and its restart acceptance claimed "structural no-overlap" — false since the entry was written (the scheduler mints the next occurrence at pickup and promotes on time alone); both now state the true at-most-one-unstarted bound, with same-folder serialization supplied by the mutex `REQ-SCOPED-LIMITS` specifies. **NEW `REQ-SCOPED-LIMITS`**: per-scope day/week/month run caps refused pre-spend as `scope-cap`, per-scope concurrency by deferral, and the always-on one-job-per-folder mutex on resolved paths — with the storm-drain acceptance (a global refusal releases the scoped reserve) and the byte-identity carve-out (identical except where the mutex serializes, which is the feature). **`REQ-REPLICA-RUNS` AMENDED**, two clauses: the local/cron hazard paragraph re-anchors to the corrected cron claim (the refusal of local replicas is the position the mutex generalizes), and the budget paragraph gains the scoped windows among the ceilings that divide by N (a scoped refusal truncates a replica set exactly as the global cap always could). **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**: the never-tier enumeration gains scoped-limits content. **`REQ-SPEND-CAPS-MULTI-WINDOW` UNCHANGED, checked**: the global windows keep their exact semantics; the scoped windows are a sibling ledger under their own keys, reserving first, never altering when or how the global reserve runs. **`CONST-BUDGET-BEFORE-TOKENS` UNCHANGED, checked**: "however many windows exist" is scope-agnostic and the scoped reserve is still check-and-increment before the container. **`CONST-RETRY-INFRA-ONLY` UNCHANGED, checked**: a deferral is neither a policy return nor a retry-throw — `moveToDelayed` passes `skipAttempt: true`, so the attempt ledger is untouched, the pause gate's own posture. |
| 2026-08-28 | Issue #231, receiver slice. **`REQ-DEDUP-BY-DELIVERY-GUID` AMENDED** (semantic layer only): close jobs' semantic key leads the flow slot with `closed:`, derived from the matched rule, so a same-target-same-flow label job inside the window can never swallow a close job -- a swallowed close writes no run record and its one-shot never disarms. Every non-close key byte-identical; the GUID layer UNCHANGED, checked. **`REQ-TRIGGER-AUTHOR-GATE` UNCHANGED, checked**: the close arm lives in `CONST-TRIGGER-AUTHOR-GATE`, and the offline-testable split (lookup in the receiver, verdict into the pure gate) is exactly the shape this requirement already mandates. |
| 2026-08-26 | **NEW `REQ-TRIGGER-SECRETS`** (issue #225): a trigger names secret REFERENCES and the worker resolves them host-side, pre-spend, through an operator-declared resolver. Legal on all four kinds INCLUDING cron, unlike `run.replicas`, whose local refusal turns on two agents sharing one bind-mounted working tree rather than on anything about a credential. **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked**: `--env-setup` still gives the WORKER an environment, and this gives one TRIGGER a value; the two seams do not overlap. **`REQ-GLOBAL-PI-OVERLAY` UNCHANGED, checked**: its "the overlay must hold no secret" clause is untouched, because nothing here is staged into the overlay. **`REQ-EGRESS-ALLOWLIST` UNCHANGED, checked**: the resolver runs on the HOST, outside the job's `--internal` network entirely, so no allowlist entry is needed and none was added. **`REQ-PER-TRIGGER-SKILLS`, `REQ-PER-TRIGGER-INSTRUCTION`, `REQ-REPLICA-RUNS`, `REQ-RESUMABLE-SESSION` UNCHANGED, checked** (`run.secrets` beside `run.resume` is refused at load, so the two features never co-exist on one trigger). |
| 2026-08-26 | Issue #186 (resume eligibility bounds: conversation age, context fullness, chain length). **REQ-RESUMABLE-SESSION AMENDED**, two edits. The fail-open list gains a conversation past its age bound, and its *"each is a NAMED reason in the run record"* half is restated as the requirement it always was, because for the feature's first year only half of it was met: a refused read stages a 0-byte transcript, the container is handed it regardless, pi finds no messages and reports `absent`, and the record took the container's word -- so `expired` and `pi-version-changed` reached no completed record at all while this clause promised they did. A host gate that refused now outranks that one runner token, which is a restatement of the question rather than an answer to it. The second edit is a **new bullet on opt-in eligibility bounds**, which exists to record the two polarity rules a later reader would otherwise re-litigate one bound at a time: a bound is off unless set and an unset bound leaves the read path byte-identical, and a bound that cannot obtain its measurement neither invents one nor guesses -- where the quantity is on the transcript's own header it fails CLOSED, since a conversation that cannot say how old it is has not been shown to be young enough, and where the quantity is reported by the container it fails OPEN, since absence there means an image that predates the field rather than a fact about the lineage. Acceptance gains the age case (a header timestamp past the bound refuses while mtime is fresh, and that token is what the record shows), the chain case, and an all-bounds-unset case that says what is and is NOT identical: the staged file and the mount set are, while a completed promotion also writes the chain counter and a refused host gate records the gate's own token where it used to record the container's `absent`. A second new bullet states what these bounds are and are not, because an adversarial review found the honest scope missing from the one place an operator would look: they bound how much history accumulates, two of the three read values the agent itself writes (the header timestamp; the reported occupancy), an agent with code execution can defeat those two and can carry content across runs in the transcript it owns regardless, and the one bound resting on nothing inside the container is the resume chain, which is why it counts the host's deliveries rather than what pi made of them. **REQ-DEPLOYMENT-BOOTSTRAP AMENDED**: `doctor` reports a bound that is set and asleep, made normative by `PI_SESSION_MAX_CONTEXT_PCT`, whose measurement comes from the job image's runner and which therefore does nothing at all on an older image with no capability label to check against; the four resume bounds are also printed as a fact line, since three are off by default and silent when unset. Neither line carries a `fixAction`: how long a lineage may run is an operator's decision, not a mechanical remainder. **REQ-TOKEN-ACCOUNTING-AND-CAPS UNCHANGED, checked**, and the check is the interesting one: the context bound reads pi's `getContextUsage()`, which is context OCCUPANCY, not billed tokens, and it feeds no cap, no counter and no classification -- reusing `tokens.total` for it would have been wrong twice over, since that total is cumulative across a run and counts every turn's re-sent prefix again. **REQ-QUEUE-BURST-NO-DROP UNCHANGED, checked**: both new per-key files are written inside the promotion lock that clause already governs, so one-writer-per-key covers them without a word moving. One correction this issue carries beyond its own scope, because it was propagated from the issue text into four files before anyone checked it: the TTL's mtime is refreshed by the PROMOTE rename and **not** by the resolve copy (`copyFileSync` stamps its destination, never its source, measured), so `expired` has always meant time since the last COMPLETED run rather than the last run. |
| 2026-08-26 | Issue #221 (a stop the wrapper had already accepted was a silent no-op; the flaky test was the symptom, and #207 fixed the symptom). **REQ-DEPLOYMENT-BOOTSTRAP AMENDED**: Scope's clause (2) gains its missing half and Acceptance gains three clauses. Everything that clause promised was about a setup that FAILS; nothing covered a setup still RUNNING, which is by far the longer window since `PI_ENV_SETUP` is a network round trip to a secrets manager. Two holes, both silent, both now closed. Until the trap was armed TERM carried its DEFAULT disposition, so a stop landing during the sourcing killed the wrapper mid-preparation with nothing said anywhere. And `$!` is readable only AFTER the fork, so a stop landing between `"$@" &` and `child=$!` ran the handler with no pid, forwarded to nothing, set a flag nobody read again, and left the wrapper waiting out the command's ENTIRE natural lifetime while the service manager believed it had asked the process to stop. Reproduced before it was fixed, by widening only that gap in a copy of the shipped file: the stub ready, the signal accepted, nothing forwarded, and the wrapper sitting out the stub's whole sleep. Reachable from this project's own CLI, since `pi-dispatch service stop` on macOS is `launchctl kill SIGTERM` at that pid. Exit 0 for a pre-launch stop because 0 is the only code `KeepAlive`/`SuccessfulExit=false` leaves stopped: nothing was refused (not 2), nothing failed (not 1). **launchd and nssm only, checked rather than assumed**: with `--env-setup` systemd DOES put an untrapped `sh -c` in the same window, but `KillMode` is unset repo-wide so the default `control-group` signals the whole tree, no worker has been launched, and `Restart=on-failure` treats death by SIGTERM as clean, so the same stop stops the same unit either way. **NEW `DES-WRAPPER-STOPS-WHAT-IT-STARTED`** and **DES-SERVICE-ENV-SETUP-SEAM AMENDED**. **CONST-RETRY-INFRA-ONLY UNCHANGED, checked**, and it is the one worth naming: it governs the QUEUE's retry decision through the runner's throw-versus-return, while this exit code is read by a different retrier, the service manager. The host-side analogue already lived in this wrapper (2 to 0 means never restart, any other nonzero means restart), and "stopped before it started" is neither of its categories: no job existed, no budget was reserved, nothing was retried. `exit 1` would have been the violation, because it relaunches a service the operator just stopped into the half-built environment the setup script never finished. **CONST-BUDGET-BEFORE-TOKENS UNCHANGED, checked** — the refusal happens before the process that would reserve anything exists. **INT-RUNNER-EXIT-CODE-PROTOCOL UNCHANGED, checked** — it governs the in-container runner's codes, and the exit-2 conversion is byte-unchanged (verified by running 0, 2 and 7 through the new tail in both shells). |
| 2026-08-26 | Issue #187 (`run.replicas` on every forge). **REQ-REPLICA-RUNS AMENDED**: Scope drops the `gitlab`/`forgejo`/`azure` refusal and gains the **webhook-only** clause, because the poller is GitHub-only by construction and a Scope that merely said "every forge" would have claimed a parity this feature does not have. The four-layers bullet generalises the jobId to `<prefix><id>-r<i>`; the chain bullet's *"a replica — always a github job"* becomes *always a forge job*, which leaves `outbox.mjs`'s `local`-only guard doing exactly the same work; acceptance gains the per-forge clause naming the separators, and its refusal list drops gitlab. The refusal it removed said *not yet covered* rather than impossible, and closing it is what that wording was for. **CONST-TOKEN-SCOPED-PER-JOB is NOT unchanged and is corrected in `constitution.md`** — the 2026-08-01 row cleared replicas on the grounds that "each replica mints its own scoped token", which is the GitHub **App** path's property alone. **CONST-BUDGET-BEFORE-TOKENS UNCHANGED, checked**: N replicas are still N honest reservations, each before its own tokens, on four forges instead of one. **CONST-ISOLATION-CONTAINER-PER-JOB UNCHANGED, checked**: every replica is an ordinary job container with its own `mkdtemp`'d clone and its own name, and the per-job egress network follows the container name, so N replicas get N networks rather than sharing one. **REQ-DEDUP-BY-DELIVERY-GUID UNCHANGED, checked**: the `:r<i>` suffix extends the id space on each forge's own separator rather than weakening the guarantee. **REQ-RESUMABLE-SESSION UNCHANGED, checked**: still refused in combination, now on four forges, which is the only reason `session-key.mjs` may keep calling `issueBranch` with one argument. **REQ-DEPLOYMENT-BOOTSTRAP AMENDED**: doctor gains a triggers-parse failure check — the swallow it replaces justified itself with "already fails LOUD at worker boot", which is false on a receiver-only deployment and left doctor reporting greener than a healthy one. |
| 2026-08-25 | Issue #202 (the egress default). **REQ-EGRESS-ALLOWLIST AMENDED**: `PI_EGRESS` becomes an opt-OUT, so the bounded posture is what a deployment gets by saying nothing. The polarity is the decision rather than a detail -- a control that ships off is a control nobody enabled, which is the state `OQ-004` spent a year in: a disclosure with a dead end at the end of it. The parse moves into `egress.mjs` because `doctor` and `up` read the environment directly and three copies of one default is two chances to flip it in the wrong number of places; that was not hypothetical, the flip initially left doctor silently reporting nothing about a policy that was on. The upgrade path is stated rather than left to be discovered: a deployment that upgrades and does nothing has every job **refused pre-spend**, naming the proxy and the one command that starts it, at zero budget slots and zero tokens, reversible in one line -- which is the failure this project prefers to a control that quietly does not apply. **REQ-GLOBAL-PI-OVERLAY AMENDED**, prose correction, and it is the twin #199 left standing: its why-repo-declared-packages-are-refused paragraph claimed "a job container has no registry access by design" four lines above "in a container with open egress", which cannot both be true and was not. Corrected to say what `PI_OFFLINE=1` actually forecloses (the resolver's install, not the container's reach), with the egress half made conditional in the same edit so the pair cannot drift apart again. **REQ-DEPLOYMENT-BOOTSTRAP UNCHANGED, checked**: the never tier still holds and `ALLOWED_FIXACTIONS` is byte-identical. **REQ-TOKEN-ACCOUNTING-AND-CAPS UNCHANGED, checked**, and it gains nothing here for the reason `OQ-011` now records. |
| 2026-08-25 | Issue #202 (egress). **NEW `REQ-EGRESS-ALLOWLIST`**: with `PI_EGRESS=1` every job runs on its own `--internal` network whose only other member is an allowlist proxy, and a job whose policy cannot serve it is refused before it spends. **Off by default**, and the pre-spend gate is the whole shape of the feature rather than a nicety beside it: a job that cannot reach its provider starts the container, spends its slot and produces nothing (three attempts, `Request timed out.`, exit `1`, ~40s, **zero tokens**), and exit `1` is retryable at `attempts: 2` while `releaseBudget` refunds only `container-never-started` -- two slots per job, neither refunded, faster than anyone reads the first failure. One network PER JOB rather than one shared: a shared network is a shared L2 segment at `DES-CONCURRENCY-3`, and `enable_icc=false` is not the fix because ICC governs every container pair and the proxy is a container, so it blocks the path the design depends on (verified against a control). The claim is stated precisely rather than overclaimed -- two job containers on docker's default bridge can already reach each other by IP, so per-job networks REMOVE an adjacency rather than adding one. Scope names what is deliberately absent: no `run.network`, no runtime-settings key, no model-callable parameter. Also records the honest gap the gate cannot close: an allowlist missing a host the flows need is not pre-spend detectable, and that job pays the two slots. **REQ-GLOBAL-PI-OVERLAY UNCHANGED, checked** -- `PI_OFFLINE=1` is a property of the runner and an allowlist that permits `registry.npmjs.org` does not put pi's resolver back on the network. **REQ-RESURRECTABLE-SANDBOX UNCHANGED, checked**: the network reaches a sandbox through the same builder seam its Scope already delegates to `INT-SANDBOX-CONTRACT`. **REQ-DEPLOYMENT-BOOTSTRAP UNCHANGED, checked, and it is the one worth naming**: doctor gains five checks and `up` gains a consented step, and **none of them carries a `fixAction`** -- the never tier holds. One candidate was considered and refused: a prompt-tier offer to start the proxy on the Valkey precedent, which starts a QUEUE whose failure mode is that nothing runs, where this would stand up a SECURITY CONTROL whose allowlist the operator has not written, turning "no policy" into "a policy that fails every job inside a paid container". **REQ-TOKEN-ACCOUNTING-AND-CAPS UNCHANGED, checked**, and it gains nothing: a subprocess `pi` spends against the provider host, which is on the allowlist by necessity, and a proxy that does not decrypt cannot count tokens. An egress control that does not touch metering is the finding, not an oversight. |
| 2026-08-25 | Issue #216 (the `--env-setup` seam had no preflight: nothing checked whether the script the service manager sources at every boot still existed, was still writable by nobody else, or had been committed). **REQ-DEPLOYMENT-BOOTSTRAP AMENDED**: Scope gains doctor's read-back — the path exists nowhere but the rendered unit, so doctor parses that unit (the `ExecStart` line, the plist's `EnvironmentVariables` dict, `nssm get … AppEnvironmentExtra`), matched to this deployment by `WorkingDirectory`, with `PI_ENV_SETUP` in doctor's own environment as the fallback when no unit names one — plus the three warn-tier findings it may report (missing; a group/world-writable script or non-sticky directory; a work tree that does not ignore it), none of which ever reads the script's contents. The `never` enumeration gains "an env-setup script's mode or location", and acceptance gains both the reporting clause and the byte-identical-when-unconfigured clause. The mask is `0o022` and deliberately not the App key's `0o077`: this file is EXECUTED by the account holding the provider key and the forge token, so writability is the risk and readability is not, and a sticky directory is exempt because a non-owner cannot replace a file there. A missing script stays a warning rather than a failure because it breaks the boot path and not `pi-dispatch worker` typed by hand, and `up` returns doctor's code verbatim. Fixed here too, since the read-back is what surfaces it: `service render` substituted `/opt/pi-dispatch` → the deployment folder AFTER composing the ExecStart and injecting `PI_ENV_SETUP`, so an operator's `--env-setup /opt/pi-dispatch/setup-env.sh` on a deployment elsewhere was silently rewritten into a file `resolveEnvSetup` never checked, while the unit's own banner still named the one that was typed. **DES-SERVICE-ENV-SETUP-SEAM AMENDED** (the unit is the record; substitute before composing). **DES-CLI-SURFACE UNCHANGED, checked** — doctor stays read-only/always-safe and the new checks carry no `fixAction`, so the tier ladder it defines is untouched. **INT-RUNNER-EXIT-CODE-PROTOCOL UNCHANGED, checked** — nothing here reads or maps an exit code. |
| 2026-08-25 | Issue #209 (`service render` had no seam for a secrets manager, and the obvious hand-edit ate the exit code). **REQ-DEPLOYMENT-BOOTSTRAP AMENDED**: Scope gains `--env-setup <absolute path>` on `render`/`install` and its three normative clauses — operator-typed only (never `.env`, a trigger file, the panel or anything a model can write; the wrappers capture `PI_ENV_SETUP` before sourcing `./.env` so file content cannot name a script they then run), a missing or failing setup is exit 1 and never exit 2 (with the worker not started on a half-filled environment), and a byte-identical default render on all three platforms. The seam exists because the hand-edit it replaces is wrong in a way that costs money: `infisical run -- <cmd>` reports a child's exit 2 as 1, and exit 2 is what `RestartPreventExitStatus=2`, nssm's `AppExit 2 Exit` and the wrapper's exit-2 conversion all key on, so a refusal read as a crash and the supervisor relaunched it in front of a paid provider. The renderer owning the `exec` is what forecloses that. Measured under systemd 252: `ExecMainStatus=2` with `NRestarts=0` for a refusal, `ExecMainStatus=1` with restarts for a failed setup. **DES-CLI-SURFACE AMENDED** (the flag's tier and one never-tier clause), **NEW `DES-SERVICE-ENV-SETUP-SEAM`** (a path and not a command, the renderer owning the exec, a variable rather than a composed command line on macOS/Windows, and the rejected alternatives). **DES-WORKER-ON-HOST UNCHANGED, checked** — the worker is still a host process; only what prepares its environment moved. **INT-RUNNER-EXIT-CODE-PROTOCOL UNCHANGED, checked** — the in-container protocol is untouched, and the new host-side mapping (setup failure = 1) is stated here rather than there. **CONST-BUDGET-BEFORE-TOKENS UNCHANGED, checked** — a failed setup refuses before the process that would reserve anything exists. |
| 2026-08-25 | Issue #199 (egress). Prose correction, no requirement change: `REQ-GLOBAL-PI-OVERLAY`'s why-packages-are-staged paragraph said a job container loads a staged package "with egress denied", which nothing enforces (`OQ-004`). It now says "with no job-time install", which is what `PI_OFFLINE=1` and host-side staging actually provide. |
| 2026-08-13 | Issue #188 (topology: flows resolved from injected, overlay or staged-package skills rendered as missing). **REQ-TOPOLOGY-GRAPH AMENDED**: the statement gains the three non-repo tier groups and new honesty clause (a2) — config-edge resolution is tier-aware in loader precedence order (repo > injected > overlay > staged, per trigger); a lower-tier resolution lands the edge on the tier node with NO flag; a tier node is claimed only when every higher applicable tier is a KNOWN miss (a config edge asserts node identity, and a wrong tick is the one forbidden direction); unknown tiers soften a dangling claim to the new amber `skill-not-at-head` state naming what this session could not check (the deployment pointer deliberately cannot carry `PI_GLOBAL_PI_DIR`, so wizard-launched sessions soften rather than lie red); red `no-skill` fires only when every applicable tier was checked and missed, its detail naming the tiers, with `run.packages: false` a known withheld miss. Clause (h)'s "the closed vocabularies stay closed" survives LITERALLY: edges and flags are byte-unchanged; node kinds grew (`overlay`, `staged`, `skill-not-at-head`) and became their own closed pinned set (`GRAPH_NODE_KINDS`) with a glyph-parity pin. Acceptance rows reworded/added accordingly, including forge-unchanged (a remote repo outranks every host-readable tier, so forge flows stay unverified). **REQ-PER-TRIGGER-SKILLS AMENDED** (one acceptance clause): an injected-only flow's config edge lands on the injected node, unflagged, badge kept. **REQ-GLOBAL-PI-OVERLAY AMENDED** (one Why clause): the topology is doctor's display half — tier groups where `PI_GLOBAL_PI_DIR` is visible (staged reader shared with doctor, manifest order preserved as loader shadowing order), softened claims where it is not. **REQ-DEPLOYMENT-BOOTSTRAP UNCHANGED, checked** — no doctor change; display only. **REQ-AI-TRIGGERED-RUNS UNCHANGED, checked** — tier nodes carry no `aiTrigger`/chainable claim, and `potential`-edge eligibility stays committed-repo-only. |
| 2026-08-13 | Issue #189 (closing pass: package prompt templates, OQ-019 deferral (b)). **REQ-GLOBAL-PI-OVERLAY AMENDED**: the overlay gains its `prompts/` channel (templates were the one resource kind with none), and "repo wins on conflict" is now stated as ENFORCED for prompt templates through `promptsOverride`, mirroring the skills enforcement, because pi merges package prompt paths first and path order alone cannot carry the promise. Themes stay count-only with the reason recorded on OQ-019. **REQ-PER-TRIGGER-SKILLS UNCHANGED, checked** -- injected skills are a skills-only tier; no prompt analog was added or implied. **REQ-DEPLOYMENT-BOOTSTRAP UNCHANGED, checked** -- no doctor change in this pass. |
| 2026-08-13 | Issue #189 (Gap 2, producer half: `run.command`, the second trigger entry point). **REQ-AI-TRIGGERED-RUNS AMENDED**: commands are never AI-triggerable and there is no opt-in — the statement gains the outbox `command`-key refusal (`chain-command-refused`, ordered before the charset check) and `dispatch_run`'s structural incapability (`{folder, flow, task}` params; a slash-leading flow refuses with a readable message naming the distinction rather than falling through to `no-skill`); acceptance pins both as free, nothing-enqueued, no-budget-touched refusals. **REQ-CRON-SCHEDULED-JOBS AMENDED**: acceptance gains the entry-point clauses it is the end-to-end home for — a `run.command` trigger loads in BOTH services (the shared validator) and its emitted job dispatches headlessly with the prompt exactly `/<command> [args]`; both-or-neither of `flow`/`command` is a parse-time `piDispatchConfig` error in both services; an unregistered command refuses `command-unregistered` (exit 2, pre-work, never retried) before any model call. **REQ-TRIGGER-AUTHOR-GATE AMENDED**: the comment `<phrase> <flow>` trailing-word override is INERT on a command rule — trailing text neither retargets nor suppresses the command, riding only as `event.json` data — and the known-flows set is built from flow-carrying rules only, so a command name is never summonable by comment; acceptance pins the collaborator `@pi review` case running the rule's own command. **REQ-DEPLOYMENT-BOOTSTRAP UNCHANGED, checked** — doctor REPORTS command triggers (a count plus one in-container-verifiability advisory line) and fixes nothing; the closed fix tiers are untouched. |
| 2026-08-13 | Issue #189 (Gap 1, doctor half: per-trigger flow-tier resolution lines). **REQ-PER-TRIGGER-SKILLS AMENDED**: acceptance gains the doctor clause — one line per distinct (flow, folder, skillsDir, packages) question naming the resolving tier, probed in loader precedence order (repo at HEAD via the gate's own ls-tree read but HEAD-resolved and degrading to unknown, injected dir, overlay `skills/`, staged packages), ⚠ never ✗ and never a fixAction when none resolves, tiers-checked vs not-checkable named, charset failures their own ⚠, comment triggers checked on the default flow only, zero triggers zero lines. **REQ-GLOBAL-PI-OVERLAY AMENDED**: the overlay `skills/` and staged-package tiers join doctor's obligations; staged-only resolution is a plain ✓ naming the package; `readStagedSkills` (worker/src/packages.mjs, never-throws, shared with issue #188's topology) mirrors pi's manifest-vs-convention rule at the pin including the manifest-without-skills-key null case, and pattern manifests read as not-enumerable rather than guessed. **REQ-DEPLOYMENT-BOOTSTRAP UNCHANGED, checked** — the new checks are warn-tier and carry no `fixAction`, so the tier ladder it defines is untouched. |
| 2026-08-13 | Issue #189 (Gap 1, runner half: a `run.flow` that resolves in no skill tier is a silent exit-0 no-op). **REQ-PER-TRIGGER-SKILLS AMENDED**: acceptance gains the runner clause — given a job whose `run.flow` names a skill no loaded tier materialised, the runner emits one `flow_not_loaded` line (flow name and a loaded-skill count, never task content) before any session exists, so the silent-exit-0 shape becomes a failing test; the job proceeds, and the report-not-refuse choice with its rejected alternatives is recorded on the new `DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS`. This entry owns the clause because its tier stack (repo > injected > overlay, packages barred from their names) is exactly the set the check verifies the union of. **REQ-GLOBAL-PI-OVERLAY UNCHANGED, checked** — tier precedence, staging and the overlay gates are untouched; the check reads the loader's OUTPUT after every tier and override has spoken. **REQ-DEPLOYMENT-BOOTSTRAP UNCHANGED, checked** — no doctor change in this half (the doctor layer is the companion change), and nothing here grows a fix tier. |
| 2026-08-12 | Issue #181 (the budget lever and the trend lines). **REQ-INSIGHTS-HTML-EXPORT AMENDED**: the page gains a **budget panel** — the caps are the operator's one real lever on cost, so the page that prices everything shows the dial beside the spend — with new clause (g): used-vs-cap FACTS only, an overlay-unset cap rendering as unknown/off with no bar and no percentage (the no-invented-denominator rule applied to caps this process cannot read authoritatively), states computed assembler-side by the worker's own `windowState` (and the token rule the old dashboard token line used) and carried in the payload as WORDS the page never derives — the artifact builder cannot load the worker, and duplicating threshold arithmetic behind a parity test would put policy in two places — and the lever named in the panel. Display stays GET-only: `readBudget` gains the token counter as a fourth plain GET plus a synchronous junk-URL parse guard, and never INCR/EXPIREs (CONST-BUDGET-BEFORE-TOKENS). And the page gains its **trend lines** with new clause (h): per-flow daily spend as SMALL MULTIPLES (one panel per top flow, one shared dollar scale, identity carried by the panel title — the palette has one non-reserved data hue and dashes already mean estimated, so overlaid lines could only be told apart by a channel the class system already spent) plus a cumulative mini-chart with its OWN scale under the daily columns (a running total dwarfs daily bars; a second axis on one plot is the dual-axis lie), dashed segments wherever an estimated day touches and a cumulative line demoted permanently from its first estimated day. **REQ-SPEND-CAPS-MULTI-WINDOW UNCHANGED, checked** (a display-only consumer of the same classifier its panel-meter-amber clause already names). **REQ-TOKEN-ACCOUNTING-AND-CAPS UNCHANGED, checked** (a new display of the daily counter; enforcement untouched). **REQ-COST-ANALYTICS UNCHANGED, checked** (the fold gained `dailyByFlow`, a series over facts it already held — recorded on DES-COST-FOLD-BY-SCAN). |
| 2026-08-12 | Issue #181 (insights becomes the ONE analytics surface). **REQ-INSIGHTS-HTML-EXPORT AMENDED**: the command is the bare `/dispatch insights [7d\|30d\|mtd] [--no-open] [--full-paths]` — no `html` verb to remember, and the removed verb answers usage on purpose (a dead verb that half-works is drift); the overlay's `i` key runs the same command between overlays; the entry absorbs, verbatim, every normative clause REQ-GRAPH-HTML-EXPORT carried (atomic stable path, URL-before-spawn, the page's own refresh loop and hash view state, headless skip-and-say, the content bans and the `--full-paths` opt-in, no port); the what-if sentence inverts to "the what-if is the `insights whatif` command". **REQ-GRAPH-HTML-EXPORT SUPERSEDED** — the ID stays as a permanent address, the artifact and its command are gone, the discipline lives on. **REQ-COST-ANALYTICS AMENDED**: the surfaces become the insights page, `dispatch_costs`, and `insights whatif`; the COSTS view (fifth view, `c`) and `/dispatch costs` leave the Statement; the lettered labeling rules (a)-(g) stand untouched; the `(no flow)` what-if acceptance row rewords to the fold grain (the null-key match stays pinned in costs.test.mjs — the interactive layer that exercised it is gone) and the no-TTY plain-text row leaves with the command (the artifact writes and prints its URL even headless, and `dispatch_costs` is the machine path). **REQ-TOPOLOGY-GRAPH AMENDED**: the surface is the insights artifact's topology pane; the GRAPH view (sixth view, `g`) and `/dispatch graph` leave the Statement; the honesty rules (a)-(h) stand, with (h) retargeted to the page's tips and badges — and the removal EXPOSED that (h)'s next/overdue facts had no artifact surface (the TUI and text renderers carried them alone), so the scene's trigger tips now render `next`/`overdue` against the page's own generation instant, landed in the same PR that removed their last other home. **REQ-ADMIN-VIA-PI-EXTENSION AMENDED**: the command list drops `costs` and `graph` for `insights`; the model-callable tool list is UNCHANGED, checked (`dispatch_costs` stays — it returns the cost fold only, and topology stays non-model-callable). **INT-* UNCHANGED, checked** (no interface names the removed commands; verified by grep). |
| 2026-08-12 | Issue #175 (the insights artifact, the fourth slice). **NEW `REQ-INSIGHTS-HTML-EXPORT`**: `/dispatch insights html [7d|30d|mtd]` writes `<graphDir>/insights.html` — the topology scene (spend-badged per REQ-TOPOLOGY-GRAPH (h)) beside the cost fold drawn as hand-rolled inline SVG charts, under REQ-GRAPH-HTML-EXPORT's write/open/headless discipline verbatim and REQ-COST-ANALYTICS' labeling rules verbatim, plus the visual clauses (dashed/translucent = estimated with hue never the sole encoding; a plan-covered bucket draws a chip and NO dollar bar; `≥` on charts; both windows stated; gap days present; null byTrigger renders "not computed"). Default window 30d, deliberately not costs' mtd — the topology half is pinned at a 30d record window and one page's halves should agree. No port, no served page, no new model-callable tool, no charting dependency (a supply chain riding a security posture). **REQ-COST-ANALYTICS AMENDED**, one sentence: the insights artifact joins the named surfaces; rules (a)-(g) unchanged. **REQ-GRAPH-HTML-EXPORT UNCHANGED, checked** — `graph html` stays the lighter topology-only export, not an alias. **REQ-TOPOLOGY-GRAPH UNCHANGED, checked** (its Scope's no-tool clause now covers two commands). |
| 2026-08-12 | Issue #175 (spend and schedule on the graph, the third insights slice). **REQ-TOPOLOGY-GRAPH AMENDED** with (h): cron rows render next-fire/overdue from the resident scheduler — `next` and `overdueMs` were computed by the model's first slice and rendered by nothing, a design-to-data gap of exactly the kind the #54 delivery lesson names — and trigger nodes may carry the window's typed spend (`foldTriggerCosts`, keyed by the node id), fmtCost-rendered so a plan-covered trigger never reads `$0.00`. Spend and schedule are node FACTS: the closed edge/flag vocabularies are unchanged on purpose, pinned by test. **REQ-GRAPH-HTML-EXPORT AMENDED**: the artifact now states the chain-refusal and injected-unreachable honesty counters the text and TUI surfaces always stated (the allowlist dropped them, so three surfaces of one model disagreed), and an observed edge's label carries its recency beside its count when the fold recorded one. Node spend deliberately does NOT ride graph.html: the page may not use the `from` clause, a duplicated money formatter is a parity liability, and the insights artifact (next slice) renders spend through the real shared formatter instead. **REQ-COST-ANALYTICS UNCHANGED, checked** (foldTriggerCosts gained consumers, not semantics). |
| 2026-08-12 | Issue #175 (per-trigger and per-repo spend, the second insights slice). **REQ-COST-ANALYTICS AMENDED**: the fold's rollup list gains per **trigger** and per **repository target**, and the COSTS view's `f` key cycles four tables (flow / model / trigger / repo) with the footer hint renamed to `[f] table` so it still fits width 80 whole. Trigger attribution is REQ-TOPOLOGY-GRAPH (b)'s own index-and-type join, produced by the read-model (`attributeRunsToTriggers`) and passed INTO the fold — the doctrine is not re-derived, and the fold stays fs-free. Chained runs are their own explicit bucket, deliberately NOT rolled up to the ancestor trigger: a parent chain walked across the retention boundary attributes partially, and a partial rollup wearing a trigger's name would lie. Two acceptance rows added (the disagreeing-pair bucket; null byTrigger renders as absence). The per-trigger spend map (`foldTriggerCosts`) is keyed by the graph node id `trigger:<index>` for the topology surfaces the next slices add. `dispatch_costs` returns the same fold, so its JSON gains the two arrays — additive, and every dollar still carries its class. **REQ-TOPOLOGY-GRAPH UNCHANGED, checked** (its join doctrine gained a second consumer, not a second definition). |
| 2026-08-12 | Issue #175 (cost-fold correctness, the first insights slice). **REQ-COST-ANALYTICS AMENDED**, acceptance only — the lettered labeling rules (a)-(g) stand untouched; four rows join the acceptance list because each was a way the surface could quietly say something false under rules it already claimed to keep. Proration now denominates on the **requested** window (`foldCosts` gains `sinceMs`, minted with the scan cutoff by the one `costsSinceMs` now exported beside the fold): the old first-observed-run denominator understated plan cost on sparse windows and flipped verdicts to SAVING, refuted with a pinned test that flips the same records to LOSING under the honest denominator. The provenance line counts **truncated ledgers** (`usage.truncated` was persisted per INT-RUN-HISTORY-FILE-CONTRACT and read by nothing — a fanout past the meter's 8-row cap lost per-model attribution silently). The what-if now filters by the **machine flow key** (`byFlow[].flowKey`, null for the no-flow bucket) instead of the `"(no flow)"` display label that matches no record, and the ledger's `other/other` overflow row leaves the target shortlist (unpriceable, so it silently degraded estimates to the seeded band). **REQ-TOKEN-ACCOUNTING-AND-CAPS UNCHANGED, checked** — `usage.truncated` was always in the contract; only the reader changed. **INT-RUN-HISTORY-FILE-CONTRACT UNCHANGED, checked.** |
| 2026-08-11 | Issue #54 (operator feedback: "not clear which repos/folders, and where are the skill loops"). **REQ-TOPOLOGY-GRAPH AMENDED** with (e2): prose-loop hints are node facts grouped INSIDE the skill (a loop lives inside its one job, one container, one budget slot, so it renders inside its one node — the original issue-#54 conversation's headline ask, which the first slices carried in design but not in data), and forge groups name the repositories their window's records ran against (record-derived and labelled as such, because a github trigger's config names no repository — the repo half of `target` is the same id-only string every runs view already shows). **REQ-GRAPH-HTML-EXPORT AMENDED**: `--full-paths`, an explicit operator opt-in that puts the configured `run.folder` paths (reviewed operator config) into the artifact; the default stays basename-only because the artifact is a durable, shareable file. The loop scanner (`findLoopHints`) reads the SKILL.md BODY only — a frontmatter `description: repeat daily` must not read as a loop — and its hints render with the mention discipline: text evidence, never a promise. |
| 2026-08-11 | Issue #54 (adversarial-review hardening). **REQ-TOPOLOGY-GRAPH (b) AMENDED to a promise the persisted fields can actually keep** — the review CONFIRMED the old sentence over-promised: `joinRunsToTriggers` guarded only the index RANGE, so deleting a cron above a comment trigger slid the comment's run history onto whatever entry occupied its row, exactly the lie the sentence forbade. The join now also requires TYPE agreement with the entry currently at that index (the persisted `triggerType` was sitting unused), which catches every cross-type shift; the same-type-reorder residual is named in the requirement, pinned by a test, and priced honestly (closing it needs a persisted identity string, against the record's posture). Also folder-scoped the `chainRefused` counters (same-folder-only chaining makes two folders' same-named flows different flows; a flat counter blurred 2+5 into one number nobody could place), dropped-and-counted observed edges whose folder is unreachable (they minted phantom "[missing at HEAD]" endpoints off a read that never happened), gave a folderless cron entry its config edge on a "(no folder)" group ("every trigger gets its edge, ALWAYS" admits no exception for the broken entries an operator most needs to see), surfaced unreadable injected dirs in meta (the OQ-022 badge must not silently vanish), wired `collectGraphInputs`' folder-cap flag into `meta.truncated.folders` (hardcoded false meant the cap banner could never fire), and made the mention heuristic test EVERY occurrence for vocabulary distance. |
| 2026-08-11 | Issue #54 (the HTML export). **NEW `REQ-GRAPH-HTML-EXPORT`**: the topology as a self-contained `file://` artifact with its own refresh loop (Reload, off/5s/30s auto-reload, hash-persisted view state), atomically overwritten at one stable path so an open tab stays current across re-runs. The acceptance pins the postures that make this spec-clean rather than spec-adjacent: no port, no server, no external requests, no `.log` bytes, no host paths, printed-URL-before-spawn, skip-and-say when headless. **REQ-TOPOLOGY-GRAPH AMENDED implicitly completed**: its "the HTML export remains a later slice" note is discharged by this row. **REQ-ADMIN-VIA-PI-EXTENSION UNCHANGED, checked** (`graph` was already in the command list; `html` is its sub-verb, the `costs whatif` shape). |
| 2026-08-11 | Issue #54 (the GRAPH view). **REQ-TOPOLOGY-GRAPH AMENDED** as its own prior row promised: the GRAPH dashboard view (sixth view, `g`) joins the Statement beside the command; the honesty rules bind both surfaces because both render the one assembled model. The refresh posture is part of the requirement's spirit made concrete: entry and `r` only, never the poll tick (the enumeration spawns git per folder). **REQ-ADMIN-VIA-PI-EXTENSION UNCHANGED, checked** (the command list already named `graph`; the view is the same surface's overlay half). The HTML export remains a later slice. |
| 2026-08-11 | Issue #54 (`/dispatch graph`). **NEW `REQ-TOPOLOGY-GRAPH`**: the trigger/flow topology as one assembled model with the honesty rules written as requirements, on the `REQ-COST-ANALYTICS` precedent — the estimate-never-mislabeled-as-truth discipline applied to topology (a mention must never read like history, a stale index must never land on today's row, a capped scan must never read as complete coverage, the chain caps render on every output). Display-only and deliberately NOT a model-callable tool: the enumeration spawns git per folder, and the topology is for the operator's eyes (`DES-CLI-SURFACE`'s operator-typed ungated tier; the registered-tool count is untouched, pinned by test). **REQ-ADMIN-VIA-PI-EXTENSION AMENDED**: `graph` joins the observability command list. **REQ-COST-ANALYTICS UNCHANGED, checked** (same scan, sibling consumer). The GRAPH dashboard view and the HTML export are later slices and will amend this entry when they land. |
| 2026-08-09 | Issue #60 (Gap 3). **NEW `REQ-PER-TRIGGER-INSTRUCTION`**: the three webhook types may carry one line of operator standing text, rendered into the user prompt's envelope above the fenced data region. Refused on cron, and that is a decision rather than a gap: a local job's prompt IS `run.task`, with no envelope and no fence, so there is no standing region distinct from the task for a second field to occupy, and two fields writing one region with an undefined order would both appear to work. Capped at 2000 characters and refused rather than truncated, with the reasoning recorded because the obvious one does not hold -- the cap is not about caching, it bounds a context overflow inside a PAID container that has no pre-spend signal, and keeps the field in its lane. **REQ-PER-TRIGGER-SKILLS UNCHANGED, checked**: the two fields are independent and a trigger may set either, neither or both. |
| 2026-08-09 | Issue #60 (Gap 2). **NEW `REQ-PER-TRIGGER-SKILLS`**: a trigger may name a worker-host directory of skills, copied per job into `/job/trigger-skills` and layered repo > injected > overlay. Operator-authored only: nothing reachable from a webhook payload, an issue or comment body, or `dispatch_run` can supply it, and no model-callable tool can set it, because choosing which skills a job loads is choosing what the agent can do -- `run.image`'s answer rather than `f.forge`'s. **REQ-GLOBAL-PI-OVERLAY AMENDED**: its "repo wins on conflict" now reads in full as repo > injected > overlay, with the middle tier justified on specificity ("for THIS trigger" is narrower than "for this deployment") rather than on trust, since both are the operator's own. **REQ-UPSTREAM-CONTRACT-TESTS UNCHANGED, checked**: "a repo skill resolves once, from `/job/pi/skills`" is still exactly true -- the injected tier adds a second SOURCE, never a second copy of the same skill, and a name collision resolves to exactly one winner by the ordering above. **REQ-RESURRECTABLE-SANDBOX UNCHANGED, checked**, and it is a dividend of copying rather than mounting: `retainJobDir` renames the whole job dir, so a resurrected sandbox sees the skills the run actually saw instead of re-reading a host directory that may since have changed. |
| 2026-08-08 | Issue #66 (ingest `pull_request_review`). **REQ-TRIGGER-AUTHOR-GATE AMENDED**: the Statement enumerated the gated PR actions (`opened, synchronize, reopened`) and named the PR `author_association`, so a review action inherited neither branch. It now carries the third arm gated on the REVIEWER's `review.author_association`, the optional `on.reviewState` narrowing with its `review-state-not-matched` drop, and the `no-review-body` refusal of an empty `commented` review (with an empty-bodied `approved` or `changes_requested` still firing, since there the verdict is the signal). Acceptance gains the two directional cases as an explicit PAIR, plus the empty-body, unlisted-verdict and self-review cases. The Why records why the field differs and points at `CONST-TRIGGER-AUTHOR-GATE` for the argument. **REQ-DEDUP-BY-DELIVERY-GUID UNCHANGED, checked** — a review delivery carries the same `X-GitHub-Delivery` GUID every other event does, and the polled form mints `poll-rv<reviewId>` inside the existing `gh-` space, so the dedup contract is exercised rather than extended. **REQ-RESUMABLE-SESSION UNCHANGED, checked** — a review-triggered job on a PR resolves its session key from target type and head ref exactly as a `synchronize` one does; what the change DID require was carrying the review into the resumed prompt's data region, since that envelope says "address the activity quoted below" and would otherwise have quoted nothing. **REQ-REPLICA-RUNS UNCHANGED, checked** — replicas on a review-triggered PR target inherit `OQ-017` unchanged. **REQ-SPEND-CAPS-MULTI-WINDOW UNCHANGED, checked**, and load-bearing: it is what bounds the widened trigger surface recorded in `OQ-020`. |
| 2026-08-07 | Issue #102 (auto-import pi packages from the global pi setup): **REQ-GLOBAL-PI-OVERLAY** acceptance gains the discovery cases (a host package stages at the exact version on disk; a declared entry wins and prints the version it shadowed; `--no-host-packages`; a package contributing no pi resources, an autoload-off one, a git source and the admin package are each skipped or dropped WITH A NAMED REASON; the legacy global lookup honoured only when the managed path is absent; a malformed `settings.json` discovers nothing at exit 0), the extension-enablement cases (an extension disabled with `pi config` is no longer copied, a glob pattern is copied and reported as unevaluated), the refresh case (a re-stage reaches the next job with no restart, a torn read keeps last-known-good), and the receipt's `from` field. Records that repo-declared packages stay refused, with the forge-token reason, and that a repo's `.pi/extensions` loading is not a reversal of it because `/workspace` is merge-gated. One CORRECTION carried from the issue: the issue's proposed predicate ("no `pi` key means not a pi package") is **wrong at the 0.80.7 pin** and would have silently dropped packages that ship only a convention dir. **REQ-DEPLOYMENT-BOOTSTRAP UNCHANGED, checked** — the new doctor checks are all warn-tier and carry no `fixAction`, so the tier ladder it defines is untouched. |
| 2026-08-04 | The audit's session findings (issue #99). **REQ-RESUMABLE-SESSION amended**: Statement and Scope now match the code. The "one case fails CLOSED" clause was specified and never built, so an armed `run.resume` with `PI_SESSIONS_DIR` unset ran cold and completed green, indistinguishable from a job that never set the flag, which is precisely the belief-confirming failure the clause was written to stop; the pre-spend policy refusal now exists, reserving no budget slot and starting no container. Cron moves out of Scope's "all four trigger kinds": the session store reaches only the forge preparers, so a local job could never resolve a key, and `run.resume` on a cron trigger is refused fail-loud at load rather than accepted and ignored (`run.replicas`' precedent and its reason). The key material for cron exists in `session-key.mjs`, so the refusal names it as a gap to close, not a limit. Key material spelled as `(forge, repository, head branch)` — the forge kind was always the first component. **CONST-BUDGET-BEFORE-TOKENS UNCHANGED, checked**: the new gate is free and pre-reserve, in the same band as the image and branch-protection refusals. |
| 2026-08-04 | The wizard becomes the default route (issue #96). **REQ-ADMIN-VIA-PI-EXTENSION Acceptance amended**: bare `/dispatch` with nothing configured lands directly in the wizard's opening select (Cancel spawns nothing, writes nothing — the select is the consent); an untested-but-complete pi version is one info advisory on first `/dispatch`, never a refusal; a runtime older than the console's pin is one skew notice pointing at `/dispatch setup`. The outage and nudge-latch clauses are unchanged in substance and restated. **CONST-BUDGET-BEFORE-TOKENS UNCHANGED, checked**: the new steps (Docker pre-check, trigger-edge choice) spawn only consented infrastructure commands; nothing reserves budget or enqueues. **REQ-DEPLOYMENT-BOOTSTRAP UNCHANGED, checked**: the wizard still drives the CLI's own gates; the service-unit re-anchoring fix (recorded in design.md) changes where units point, not what may be automated. |
| 2026-08-04 | First-run setup joins the admin surface (issue #92). **REQ-ADMIN-VIA-PI-EXTENSION amended**: `/dispatch setup` (operator-typed only — deliberately no model-callable tool), the bare-`/dispatch` detection tree (the offer appears ONLY when pointer, env, and cwd scaffold are all absent AND the queue is unreachable — a configured deployment with a down queue keeps the banner, never an offer), and a once-ever notify-only `session_start` nudge; Acceptance gains declined-offer-⇒-nothing-spawned-nothing-written, no-offer-over-an-outage, and the nudge latch. **REQ-DEPLOYMENT-BOOTSTRAP Scope amended**: "not the admin extension" becomes the carve-in — the wizard is a *driver, not a power*: it reaches the same CLI actions through their own consent gates and adds only the deployment pointer. **CONST-BUDGET-BEFORE-TOKENS UNCHANGED, checked**: no wizard path reserves budget, enqueues, or spends — setup ends at the panel, not at a job. |
| 2026-08-02 | Process supervision joins the bootstrap requirement (issue #80). **REQ-DEPLOYMENT-BOOTSTRAP Scope widened**: `pi-dispatch service` (render/install/uninstall/status/start/stop/restart `--drain`) — user-level by default, sudo commands printed never executed, per-OS honesty (macOS login-scoped because Docker Desktop is; Windows via operator-installed nssm, never Task Scheduler — its `TerminateProcess` hard-kill is the recorded rejection), `restart --drain` composing the durable pause → wait-idle → restart → resume ritual the README previously spelled out by hand, and a timed-out drain leaves the queue paused rather than un-pausing over a live job. **REQ-SPEND-CAPS-MULTI-WINDOW / CONST-BUDGET-BEFORE-TOKENS UNCHANGED, checked**: supervision changes when the worker runs, never what a run may spend. |
| 2026-08-02 | Consented bootstrap (issue #80). Added **REQ-DEPLOYMENT-BOOTSTRAP**: `pi-dispatch up [--yes]` and `doctor --fix` take a fresh machine to a preflighted deployment through create-only scaffolds and per-action consented host mutations — every mutating command printed verbatim, y/N default No (No on non-TTY), closed fix tiers with an explicit never-set (malformed-config rewrites, triggers/pause-windows content, trigger-named `run.image`, semantic env guesses), `WEBHOOK_SECRET` set only when empty and never printed. Automation removes typing, never decisions: the consent keypress preserves SECURITY.md's "pulled onto that host yourself" property that a silent bootstrap would erase. **CONST-BUDGET-BEFORE-TOKENS UNCHANGED, checked**: no bootstrap path reserves budget, enqueues, or spends — `up` ends at doctor, not at a job. **REQ-GLOBAL-PI-OVERLAY UNCHANGED, checked**: doctor's overlay obligations are cited by the new REQ, not moved; `--fix`'s overlay actions (auth.json delete, import-pi restage) re-execute existing gates. |
| 2026-08-02 | Doctor grows the missing receiver-side preflight (issue #80). **REQ-BRANCH-PROTECTION-PRECONDITION** amended: `doctor` now states at setup time that github branch protection cannot be preflighted statically (github triggers take their repo from each delivery — `run.repository` is azure-only) and names the actual enforcement point, per job pre-spend; a read-only capped `gh api` preflight helper ships for when repos are statically known, warn-never-fail, never offering to enable protection. Doctor also warns on the receiver-boot hard-requirements it previously ignored (WEBHOOK_SECRET; Forgejo and Azure credentials mirroring the existing GitLab block), gated on which forges the triggers file actually names, preserving warn-not-fail ("a deployment can legitimately be mid-setup") and presence-only secret checks. **REQ-TRIGGER-AUTHOR-GATE UNCHANGED, checked**: every new check reads state; none writes or gates anything. **CONST-MERGE-NEVER-AUTOMATIC UNCHANGED, checked**: the preflight surfaces the backstop's precondition earlier; the backstop itself is untouched. |
| 2026-08-01 | Added **`REQ-COST-ANALYTICS`** (issue #53): the COSTS view, `/dispatch costs` (+`whatif`), and the `dispatch_costs` read tool over one retention-bounded fold — per-flow/per-model/per-day spend, subscription verdicts with the API-rate comparison, and what-if re-pricing through the pricing façade. The **labeling rules are requirements, not conventions**: every dollar carries its class through one shared formatter; plan-covered runs never render `$0.00` and uncovered zero-rate runs render `$0 (unrated)`, never "free"; estimates are always marked and demote any sum they enter, with coverage; floors keep their `≥`; undisclosed quota limits produce facts only, never burn-down; seeding is measured-median-first with the `OQ-002` band as the labeled last resort, always a band; the surface names its window and retention bound. The screen informs and changes nothing — no auto-switching, no new network surface, no database. **`REQ-ADMIN-VIA-PI-EXTENSION` amended**: `costs` joins the command inventory and `dispatch_costs` the read tools; the confirm-gate posture is **UNCHANGED, checked** (costs is a read; the write gates neither grew nor moved). `CONST-BUDGET-BEFORE-TOKENS` **UNCHANGED, checked**: analytics reads what enforcement recorded and touches no reservation path. |
| 2026-08-01 | **`REQ-TOKEN-ACCOUNTING-AND-CAPS` amended** (issue #53, gap 1): obligation (a) grows the per-(provider,model) **ledger** — the meter keeps the full cache split (`cacheRead`/`cacheWrite`/`cacheWrite1h`/`reasoning`) per model that the flat totals collapse, emits it as the exit line's `usage` block (8 named rows max + an `other` row absorbing overflow and model-less calls; rows sum to `total`; stamped with the pricing pi-ai's version), and the worker persists it beside host-effective `provider`/`model` on every terminal path. The statement records the two honesty rules: a model-less call lands on `other`, **never guessed onto a model**, and the fallback meter keeps **no** ledger — `usage: null` is the reader's signal, not an error. Enforcement (`maxTokens`, `dailyTokenCap`) is **UNCHANGED, checked**: the ledger is accounting only, and the number `recordTokenSpend` charges is still the flat billed total. |
| 2026-08-01 | Added **`REQ-REPLICA-RUNS`** (issue #56): an opt-in `run.replicas: 2..3` on github webhook triggers turns one delivery into that many independent jobs, branches and pull requests. The entry is framed as **punching a replica discriminator through four layers that each correctly collapse N into 1** — the delivery-GUID job id, the 10-minute semantic window, the deterministic `pi/issue-<n>` branch, and the derived session key — rather than as "adding parallelism", because the layers are not obstacles and none of them is loosened for an unflagged run. Three things went on the record because a later reader would get them wrong. The **`resume` refusal is load-bearing, not tidiness**: it is the only reason `session-key.mjs` may keep deriving from the unsuffixed branch, and without it every replica of one issue resolves the SAME key, shares a transcript and contends for the one-writer lock — the resumed envelope even says *"Do not open a second pull request"*. The **semantic key gains `:r<i>` only when a replica is set**, which is what keeps re-deliveries of each replica coalescing while replicas never coalesce against each other; distinct job ids alone would not have sufficed, since a duplicate `queue.add` under a taken id is *silently ignored* and the second replica would simply vanish. And the **branch is the only host-enforced replica identity** — the PR title marker is agent-honored prompt text, and on a pull_request-typed target there is no second branch to hand out at all (`OQ-017`). `CONST-BUDGET-BEFORE-TOKENS` **UNCHANGED, and checked**: N replicas are N honest reservations, each before its own tokens in its own processor, so the caps stay the ceiling and simply divide by N — softening them would have turned a cost multiplier into a cap bypass. `REQ-RESUMABLE-SESSION` **UNCHANGED, checked**: refused in combination, so nothing about what resumes moved. `REQ-DEDUP-BY-DELIVERY-GUID` **UNCHANGED, checked**: the GUID is still the exact-per-delivery key; the suffix extends its id space rather than weakening the guarantee. `REQ-DURABLE-RUN-HISTORY` **UNCHANGED, checked**: the two new record fields are host-assigned integers, so the PII-free-by-construction property is untouched, and the branch name they imply is deliberately not stored. |
| 2026-08-01 | Added **`REQ-RESURRECTABLE-SANDBOX`** (issue #55): a finished run's per-job directory is retained for a bounded window and `pi-dispatch sandbox <jobId>` re-opens it as a credential-free operator shell. The job container is **UNCHANGED and was checked rather than assumed** — `--rm`, no TTY, no published port, and with `PI_SANDBOX_RETENTION_HOURS=0` the argv and the teardown are byte-identical to pre-feature. Three things went on the record because they are the ones a later reader would get wrong: retention covers **every job kind**, not just forge jobs, which is why the unit is the per-job *directory* rather than a workspace; `0` means **off** here, the inverse of `PI_LOG_RETENTION_DAYS`/`PI_SESSIONS_TTL_DAYS`, and there is deliberately no keep-forever value; and the per-job `/session` copy is **deleted before** retention, because `--pin` can extend this window and cannot extend `PI_SESSIONS_TTL_DAYS`, so carrying a transcript across would end-run that policy rather than merely weaken it. `REQ-RESUMABLE-SESSION` **UNCHANGED, and checked** — the retained directory holds no transcript, so nothing about what resumes moved. |
| 2026-07-28 | **The pi-normal discovery posture, and operator-staged code on by default** (`CONST-NO-CONTEXT-FILES-MANDATORY` amended in the same change). `REQ-UPSTREAM-CONTRACT-TESTS`: the `AGENTS.md` bullet is **inverted** — it asserted the sentinel appears **nowhere** in the assembled prompt (`-nc` holds) and now asserts it appears in `getAgentsFiles()` and **nowhere in the append block**, because the shipped loader sets `noContextFiles: false`. Two bullets added, both pinned on **outcome** rather than on a flag: a repo `.pi/extensions` factory ran while an admin-named or `dispatch_*`-registering one is absent (project-resource discovery hangs on pi's `isProjectTrusted()` default, which would take the path down silently if it flipped), and a repo skill resolves **once** from `/job/pi/skills`. The silent failure this REQ exists for did not vanish, it **moved**, and the entry says so. `REQ-GLOBAL-PI-OVERLAY`: overlay extensions are **staged and loaded by default** — `import-pi` copies `extensions/` unless `--no-extensions` and **prints every extension it staged by name** (the vetting step is a list, not a flag), the admin extension is still hard-blocked, and `PI_GLOBAL_ALLOW_EXTENSIONS` survives only as an **opt-OUT** where unset/`""`/legacy `"1"` load, exactly `"0"` disables, and **any other value is a loud `configError` at all three enforcement points** — the strict parse is unchanged but the damaging misreading flipped, since `=false` used to degrade safely to "dormant" and would now silently mean "on". A new `Why` paragraph records the reasoning: the operator vetted the code twice (running it in `~/.pi/agent`, staging it with a printed list), so a third gate is friction, and a present-but-dormant overlay is a deployment silently missing the setup its flows were written against. `run.packages` inverted to an **opt-OUT** on all four trigger kinds (absent or `true` load; only `false` withholds), with `parseTriggers`' load-time boolean validation now the only place that strictness lives; the four-gate framing restated honestly as three gates that refuse by default plus one withdrawal, and `Scope`'s "inert until a trigger arms them" corrected. Acceptance updated throughout for both inversions. |
| 2026-07-15 | Initial. Extracted from `DESIGN.md` v0.1 §1, §5.1–5.2, §5.6, §7, §8. `REQ-RUNNER-TURN-BUDGET` and `REQ-UPSTREAM-CONTRACT-TESTS` are **new** — both exist because source-verification refuted design assumptions the doc had marked "verify". §8's failure-mode table was the richest source; one of its rows ("verify: pi max-turns option") was wrong. |
| 2026-07-17 | Added REQ-BRANCH-PROTECTION-PRECONDITION, formalizing the branch-protection refusal already enforced in `processor.mjs`/`github-host.mjs` (was a dangling code citation). |
| 2026-07-17 | Added REQ-CRON-SCHEDULED-JOBS, formalizing the implemented BullMQ Job Scheduler cron path: `local`-only triggers, loud `-10`/`-11` handling, per-scheduler stall teardown, startup orphan reconcile, and no in-tick retry. |
| 2026-07-21 | Added REQ-DURABLE-RUN-HISTORY (durable per-job run record + opt-in raw log; read model for the panel). |
| 2026-07-16 | **Scope de-GitHub-ified.** It said "triggers on GitHub issue activity" and never mentioned local folders, the CLI/panel, or cron -- stale, since local is now first-class and built. Rewritten as trigger × target. `REQ-JOB-STATUS-COMMENTS` scoped to GitHub jobs explicitly (a local job has no issue). New `REQ-LOCAL-JOB-VISIBILITY`: local jobs surface their outcome on the worker console (and later the panel) -- the local counterpart of the issue comment and the same signal for `CONST-PI-VERSION-PINNED`'s silent-no-op mode. Code updated to match: startWorker now logs one terminal line per job. |
| 2026-07-21 | Added REQ-ADMIN-VIA-PI-EXTENSION (admin surface as a pi extension in `admin/`: operator observability/pause-resume/settings commands, reads-plus-pause/resume-only model tools, overlay-only raw logs) and REQ-RUNTIME-SETTINGS-PICKUP (per-job overlay re-read for model/provider/maxTurns/dailyCap; concurrency at next pickup). Rescoped panel references to the admin extension in Scope, `REQ-JOB-STATUS-COMMENTS`, `REQ-LOCAL-JOB-VISIBILITY`, and `REQ-DURABLE-RUN-HISTORY`. |
| 2026-07-22 | Added REQ-SPEND-CAPS-MULTI-WINDOW: the pre-container budget check now spans a mandatory daily cap plus optional weekly/monthly ceilings and a soft-hold percentage band (enforcing — refuses new starts in-band with a distinct `soft-hold` reason). Extended REQ-RUNTIME-SETTINGS-PICKUP's key list to include `weeklyCap`/`monthlyCap`/`softHoldPct`. `CONST-BUDGET-BEFORE-TOKENS` unchanged (still job-count, still check-before-start). |
| 2026-07-22 | Amended REQ-ADMIN-VIA-PI-EXTENSION to the three-tool framing — `dispatch_run` is a third, spend-knobless model-callable enqueue gated by `DES-AI-TRIGGER-FLOW-GATE`; the `Statement` and `Why` both drop the superseded reads-plus-pause/resume-only categorical, keeping the cap-integrity rationale on the new premise that no model tool carries a spend knob, and the `Acceptance` gains a `dispatch_run` clause. Added REQ-AI-TRIGGERED-RUNS (the two AI-triggered producers — the `dispatch_run` tool/command and the worker's `/outbox` collector — under a per-flow pre-agent-SHA `ai-trigger: allow` gate, folder-confined to `PI_DISPATCH_RUN_ROOTS`, depth/count/rate-capped, budget unchanged; operator-typed CLI/command ungated). |
| 2026-07-23 | Amended REQ-ADMIN-VIA-PI-EXTENSION: the admin surface is now AI-operable for writes via **confirm-gated** model tools — `dispatch_set` and `dispatch_trigger_add`/`_edit`/`_delete` (plus a `dispatch_triggers` read) — each applying its change only after a human operator approves a `ctx.ui.confirm` showing the concrete before→after, and refusing (writing nothing) with no interactive UI. Replaces the "every write is operator-typed, never a model tool" categorical in `Statement`/`Why`/`Acceptance`; the cap-integrity rationale now rests on the un-forgeable human confirm rather than tool absence. Both `CONST-BUDGET-BEFORE-TOKENS` (check-before-tokens ordering) and `CONST-TRIGGER-AUTHOR-GATE` (webhook author-gating) are unchanged. Added the bundled `operate-pi-dispatch` skill (advertised via `resources_discover`) that recommends how to use those human gates. |
| 2026-07-22 | Coherence fix: reworded the two live "triggers no jobs" admin claims — REQ-ADMIN-VIA-PI-EXTENSION `Scope` and the `Triggers` overview bullet — to "triggers no jobs except the gated `dispatch_run` enqueue", resolving the self-contradiction with the same entry's `Statement`/`Why` `dispatch_run` clauses (still never materialised into a job's `/job` inputs). |
| 2026-07-28 | Process-wide metering + operator-staged packages (issue #58). REQ-TOKEN-ACCOUNTING-AND-CAPS: accounting is now **process-wide** — the runner meters at pi-ai's module-level api-provider registry, the choke point every in-process session shares, and the `subscribe()` per-turn sum is the documented **fallback**, attached only when the meter could not install. Records the negative fact that forces it (the event bus is per `AgentSession` instance, `CreateAgentSessionOptions` has no parent/bus option, no event carries a `sessionId`, so a 16-wide fanout registers as ~one turn), the honest note that a plain job's `total` now reads **>=** today's because compaction/summarisation calls were never root `turn_end`s, what a breach actually stops (`session.abort()` does not propagate to children; the forward brake is the synthetic aborted stream for every later call by any session; the backstop stays REQ-JOB-TIMEOUT-30M), and the residual subprocess gap (OQ-011). Acceptance gains the two-concurrent-sessions, breach-mid-fanout and meter-unavailable clauses. REQ-RUNNER-TURN-BUDGET gains a **Scope**: root-session turns only — the same per-instance bus bounds it, and it does not claim otherwise. REQ-GLOBAL-PI-OVERLAY: the overlay now also carries `packages/` — operator-staged third-party pi packages, gated four times over (exact pin in `pi-packages.json`, host-side `--ignore-scripts` staging with an admin-name block, a per-trigger `run.packages` opt-in, and runner-side path validation plus skill-precedence enforcement through the loader's `skillsOverride` seam, which re-imposes this REQ's own "repo wins on conflict" over pi's package-paths-first ordering), with `PI_OFFLINE=1` on every job so a package source can never become a job-time install. |
| 2026-07-22 | Added REQ-TOKEN-ACCOUNTING-AND-CAPS (issue #25, unblocked by OQ-010): per-job token/cost accounting in the run record + admin views; an optional in-run per-job token budget (`maxTokens`/`PI_MAX_TOKENS`, exits policy `token_budget`); and an optional daily token cap (`dailyTokenCap`/`PI_DAILY_TOKEN_CAP`) enforced **check-AFTER** — the deliberate asymmetry with `CONST-BUDGET-BEFORE-TOKENS`, which is unchanged (still job-count, still check-before). Extended REQ-RUNTIME-SETTINGS-PICKUP's key list with `maxTokens`/`dailyTokenCap`; retargeted REQ-SPEND-CAPS-MULTI-WINDOW's OQ-010 forward-reference to the new REQ. |
| 2026-07-29 | Issue #41. **REQ-UPSTREAM-CONTRACT-TESTS** gains a **scope boundary, not a new assertion**: "The image build shall assert every pinned assumption… No image publishes on a failed assertion" is a statement about **our** publish step, and after `run.image` a trigger may name an image this repo never built, whose build ran **no assertion at all**. Stated in the Statement and repeated in the Acceptance, with the residual registered as `OQ-012` rather than left as an implication of coverage; the bullet list is otherwise untouched and becomes the checklist an operator-built image should be held to (`docs/job-image.md`, and the `image` CI job made runnable against an arbitrary tag). **REQ-GLOBAL-PI-OVERLAY is UNCHANGED and was checked**: its "Works with the **pulled** prebuilt image — a runtime mount, not a rebuild" is still true and is now true of *any* conformant image, because the overlay is a mount; what it never covered, and still does not, is a **toolchain**, which is exactly the gap `run.image` fills. **Scope** amended: "Everything below the trigger is identical" was a live contradiction with a per-trigger image and now reads "identical **in shape** — the same argv, isolation flags, env allowlist and mounts", with **which image** added to the list of what differs. |
| 2026-07-29 | Issue #42 (GitLab triggers). **Scope** de-GitHub-ified a second time (the 2026-07-16 row did it once): Targets was a closed two-member list and is now "a local folder, or a repository on a forge — GitHub or GitLab". **A pre-existing contradiction is fixed while in there and flagged inline rather than quietly**: Targets said a GitHub repo "needs a GitHub App", which has been false since `OQ-006` closed and `CONST-TOKEN-SCOPED-PER-JOB` was made mechanism-neutral on 2026-07-17. The authz and credential clauses generalise the same way ("a write-access gate", "a scoped per-forge token"). **REQ-DEDUP-BY-DELIVERY-GUID** amended: `jobId` is the forge's own per-delivery id, `gh-`/`gl-` prefixed so the two id spaces stay disjoint. GitLab's `webhook-id` (17.4+, originally `Idempotency-Key`) is **stable across its own retries**, which is exactly the property this REQ needs, so the guarantee and its retention bound transfer unchanged — and an instance too old for either header is **refused 400 naming the version** rather than served on a key synthesised from the payload, which would not be retry-stable and would therefore dedup some redeliveries and bill for the rest: a weaker guarantee wearing this REQ's name. The **semantic** window's key gains a target-type discriminator on GitLab, where issues and merge requests are separate per-project sequences and `project#5` / `project!5` are different objects; GitHub needs none because it shares one sequence, which is a fact about GitHub rather than about forges. **REQ-TRIGGER-AUTHOR-GATE** amended with the enforcement half of the constitution change, plus a new bullet stating **where the GitLab lookup runs and why it is not in the gate**: both filters import nothing side-effecting and never throw, and that purity is what makes the security-critical decision testable offline, so the access-level resolution happens in the receiver and arrives as a plain number. Its three outcomes are deliberately not two — a determinate level goes to the gate, an indeterminate lookup is a **503** so GitLab redelivers, because a 204 would drop real work during an outage while looking identical on the wire to a stranger being refused. **REQ-BRANCH-PROTECTION-PRECONDITION** amended where it mattered most: its load-bearing "a `404` is the determinate unprotected state" is **GitHub's fact and does not transfer**. GitLab has no such 404, so the check reads the `protected_branches` list — `200` with `[]` is determinate where a 404 would be indistinguishable from a missing project or a blind token — and that also makes **wildcard** protections work, which an exact-name lookup would report as unprotected, refusing a job that should have run. Issue #61 is cited for the failure this avoids: carrying one forge's 404 semantics to another made every branch report unprotected and silently disarmed the never-merge backstop. **REQ-JOB-STATUS-COMMENTS** Scope widened from "GitHub jobs only" to forge-backed jobs — the same class of correction its own Scope field already records having needed once. Enumerations opened in `REQ-GLOBAL-PI-OVERLAY` ("both job kinds" → every), `REQ-DURABLE-RUN-HISTORY` (the `target` grammar gains `project!iid`) and `REQ-SCOPED-PAUSE-WINDOWS` (a scope may be a multi-segment GitLab path). **REQ-QUEUE-BURST-NO-DROP** unchanged and checked: "deliveries" is forge-neutral in substance and the burst property is a queue property. **REQ-CRON-SCHEDULED-JOBS** unchanged and checked: its Acceptance rejects a non-`local` cron entry, and that stays true with a third kind — the reason sentence ("a scheduled trigger supplies no webhook delivery, issue number, title, or body") generalises to any forge rather than needing restatement. |
| 2026-07-31 | Issue #48. **NEW `REQ-RESUMABLE-SESSION`**: a trigger may set `run.resume`, and a job whose derived key resolves runs on the transcript the previous job for that key produced. Records the fail-**open** set (absent / expired / oversized / unparseable / locked / no key / fork → a NAMED cold start, never a failed job) and the single fail-**closed** case (armed with `PI_SESSIONS_DIR` unset → pre-spend refusal), because running unpersisted while looking like it worked is the failure `validatePackagesFlag`'s comment describes one flag over. Also the one-writer-per-key lock: two jobs on one PR inside one runtime is an observed shape (`REQ-QUEUE-BURST-NO-DROP`), and last-write-wins there interleaves two agents' turns. `REQ-DURABLE-RUN-HISTORY` **UNCHANGED, checked, and the check is the interesting part**: its Why draws the PII line at *"the raw log is agent output that may echo issue text, so it is opt-in and gitignored"* — a transcript is strictly MORE PII-bearing than that log and, unlike it, must exist for the feature to work at all. The record itself is untouched because the new `session` field is a boolean, a fixed enum and an integer, holding no attacker-chosen string. `REQ-BRANCH-PROTECTION-PRECONDITION`, `REQ-JOB-STATUS-COMMENTS`, `REQ-SCOPED-PAUSE-WINDOWS`, `REQ-QUEUE-BURST-NO-DROP` **UNCHANGED, checked**: a resumed job is an ordinary job at every one of those gates. `REQ-TRIGGER-AUTHOR-GATE` **UNCHANGED, checked**: resume decides how a job starts, never whether — no new event type ships in this change. |
| 2026-07-31 | Issues #43 + #61. `REQ-DEDUP-BY-DELIVERY-GUID` **amended**: `fj-` and `az-` join the prefix set that keeps every forge's id space disjoint. Forgejo inherits the guarantee **unchanged** -- it sends `X-GitHub-Delivery` and keeps it stable across its own retries -- while Azure's key is **body-derived**, because it sends no delivery-id header at all, and a delivery carrying no top-level `id` is refused with 400 rather than run undeduplicated. The semantic window gains Azure's work-item/pull-request discriminator for the reason GitLab needed `!` vs `#`: they are separate id sequences, so `project/repo#123` and `project/repo!123` are different objects. `REQ-TRIGGER-AUTHOR-GATE` **amended**: the resolver-outside-the-gate rule written for GitLab is now the GENERAL rule with three customers, and the verdict type is named -- `{ authorized } | { indeterminate }`, normalised across forges because the integer did not generalise (Forgejo answers with a string enum, Azure with a group membership) while the two-armed shape did. Indeterminate is still **503, never 204**. `REQ-BRANCH-PROTECTION-PRECONDITION` **amended, and this one DISCHARGES a debt**: the entry already cited issue #61 by number as the recorded failure its ordering exists to avoid. Forgejo is queried on `/branch_protections` and never on GitHub's `/branches/{b}/protection` adapted by 404 -- and the fix is not simply "call the other endpoint", because Forgejo's rules are GLOB patterns, so the rules are LISTED and matched (reusing `gitlab-host`'s `matchesBranch` rather than writing a second globber) and the deprecated `branch_name` field is read alongside `rule_name`, since reading only the current one reports every branch on an older instance unprotected. Azure has no protected flag at all: "protected" is a POLICY list, and three clauses are each independently load-bearing -- a policy counts only when `isEnabled` **and** `isBlocking` (advisory does not stop a push), `matchKind: Prefix` means `refs/heads/releases/` protects `refs/heads/releases/1.0` **without naming it**, and `repositoryId: null` means every repository in the project, which is how most default-branch policies are written. On both forges a non-2xx is retryable and **never `false`**. `REQ-JOB-STATUS-COMMENTS` **amended**: scope widens to four forges, and Azure's asymmetry is named -- a pull-request comment is a **thread** (`POST .../threads`), a work-item comment is `POST .../wit/workItems/{id}/comments` on a pinned preview api-version. Forgejo needs no such split: a pull request IS an issue with the same index, as on GitHub. `REQ-DURABLE-RUN-HISTORY` **amended by implementation rather than by wording**: `targetFor` enumerated github and returned `null` for everything else, so every GitLab run since #42 recorded `target: null` while `INT-RUN-HISTORY-FILE-CONTRACT` documented `<project>!<iid>` -- the docstring was right and nothing implemented it. Also recorded: an Azure work-item actor reaches the run record as a **SHA-256 prefix**, never as the email address the payload carries, so the record stays PII-free by construction. `REQ-GLOBAL-PI-OVERLAY`, `REQ-SCOPED-PAUSE-WINDOWS`, `REQ-QUEUE-BURST-NO-DROP`, `REQ-CRON-SCHEDULED-JOBS`, `REQ-RESUMABLE-SESSION` **UNCHANGED, checked**: `scopeOf` is keyed on *not local* so a new forge is scoped by its `repo` automatically, and `session-key.mjs`'s enumeration -- which WAS a silent fail-open, resolving no key for any forge it did not name -- is now keyed the same way. `REQ-UPSTREAM-CONTRACT-TESTS` **UNCHANGED, checked**: neither new forge pins an upstream SDK; both are plain HTTP against documented endpoints. |
