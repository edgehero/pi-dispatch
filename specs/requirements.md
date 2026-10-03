# Requirements

What pi-dispatch must do. Design decisions live in `design.md`; non-negotiable constraints live in
`constitution.md`. This file is the acceptance surface.

Evidence convention as in `constitution.md`: `Evidence (upstream)` is authoritative, `Reference` is not.

## Scope

Run pi as a self-hosted harness that executes each job in an isolated container, follows a predefined
flow, supports frontend work with visual verification, and survives burst load without dropping work.

A job is a **trigger × target** (see `DES-CRON-VIA-BULLMQ-SCHEDULER`):

- **Targets**: a **local folder** on the operator's machine (edited in place — the primary self-hosted
  use, needs only a provider key), or a **repository on a forge** — GitHub, GitLab, Forgejo or Azure
  DevOps — cloned, worked, and opened as a pull or merge request. The four are not one tier, and the
  sentence says so rather than flattening them: GitHub and GitLab are what the harness was designed
  against; Forgejo is admitted as GitHub-shaped, needing no accommodation at all because it signs the
  raw body with GitHub's mechanism byte for byte (`CONST-HMAC-OVER-RAW-BODY`); Azure DevOps is serviced
  with one property it CANNOT have, body integrity of any kind on its deliveries, an accepted and now
  ratified risk (`CONST-HMAC-OVER-RAW-BODY`'s named exception; the ratification is `OQ-015`, and this
  sentence is its ratifying act). A forge target needs a credential for that forge
  (`CONST-TOKEN-SCOPED-PER-JOB`): on GitHub `gh`, a fine-grained PAT or an App; on GitLab a project access
  token; on Forgejo a repository-scoped token; on Azure DevOps a PAT for a dedicated identity.
  *(The old wording said a GitHub App was required. That has been false since `OQ-006` closed and
  `CONST-TOKEN-SCOPED-PER-JOB` was made mechanism-neutral on 2026-07-17; corrected then. It next said
  "GitHub or GitLab" while four forges shipped end to end; corrected 2026-09-09, issue #281, and pinned
  by a test deriving the forge list from `forges.mjs` so the sentence and the tree cannot disagree
  silently again.)*
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
- **What counts** (issue #449): every `turn_start` **except the one that opens pi's own auto-retry of a
  turn that made no progress**, meaning no tool ran and no reply completed. `auto_retry_start` arms a flag
  unless a `tool_execution_start` or an assistant `message_end` whose `stopReason` is not `"error"` was
  seen since the last `turn_start`; the next `turn_start` consumes it and is tallied as `retryTurns` instead of
  `turns`; `auto_retry_end` of either kind and `agent_settled` clear it. The `auto_retry_end` clear means a
  retry cancelled mid-sleep by `abort()` cannot exempt the threshold-compaction or queued-message
  continuation that may follow it. The `agent_settled` clear is a safeguard: an armed flag never outlives
  its prompt, although no path at the pin leaves one armed there. Before this, with `--max-turns 1` a single
  429 counted twice (the failed turn, then pi's retry of it) and the job ended `2` / `turn_budget`: policy,
  not retried, and paged, for a failure that is transient by definition.
  **Why the tool guard** (issue #455 gate round 1): pi turns ANY exception thrown inside its loop into an
  assistant `stopReason: "error"` message and retries it when the text matches its retry pattern ("fetch
  failed", a timeout, a 5xx). An exception AFTER a turn's tools ran (a listener throwing on the tool
  result's `message_end`, say) leaves the tool results in context, so pi's "retry" calls the model with
  fresh tool results: a genuinely new turn. A successful reply also resets pi's retry counter, so the
  unguarded exemption laundered turns without bound (9 paid calls measured at `--max-turns 1`).
  **Why a completed reply counts as progress too** (issue #455 gate round 2): a real provider error is the
  failed turn's ONLY assistant message, so a completed reply in the turn means the fault came after the
  work (a listener throwing at its `turn_end`, or ETIMEDOUT while persisting it). pi's retry then
  continues from that reply, and a queued follow-up or steering message runs as brand-new work in a
  `turn_start` no tool preceded (6 paid calls measured at `--max-turns 1`). With nothing queued the same
  fault makes `agent.continue()` throw "Cannot continue from message role: assistant", which rejects
  `session.prompt()` and exits `1`, retried, the right class for its likely cause (for example a
  session-store fault such as ETIMEDOUT on persist).
  **Auto-compaction continuations still count, deliberately, including the one that re-runs a turn.** An
  overflow error with `willRetry` compacts and then re-sends the SAME turn, once per streak. It counts
  even so: it is paid work on a rewritten context, and the issue is about pi's retries only. Under
  `--max-turns 1` a first turn that overflows the context therefore ends `2` / `turn_budget` (not
  retried), which is also the honest outcome, since the same prompt overflows the same context again.
  **Every `turn_start` past the cap aborts, not only the first** (a pre-existing defect, fixed with #449).
  One `session.abort()` ends only the run in flight: a queued follow-up makes pi start a new run with a
  fresh `AbortController`, and a budget that aborted once let that run go on (7 paid calls measured at
  `--max-turns 1`, on main too). The `turn_budget_exceeded` log line is still written once. The exit line
  carries `retryTurns` beside `turns` (`INT-RUNNER-EXIT-CODE-PROTOCOL`).
  **The bound this keeps.** (1) `turn_start` fires BEFORE the model call, so the failed first turn of every
  error streak was already counted when its error arrived. (2) Retries within one streak are capped at
  `PI_RETRY_MAX` (pi's `maxRetries`, pinned by the runner), and an exhausted streak emits no
  `auto_retry_start` at all. (3) A streak can be reset only by a completed reply, and the retry of a
  turn in which a reply completed or a tool ran is counted. So the counted turns still equal the real
  turns, and **at most `maxTurns * PI_RETRY_MAX` retry calls go uncounted by this exemption**, every one of them metered by the
  token budget (`REQ-TOKEN-ACCOUNTING-AND-CAPS`). Calls this budget never counted, before or after #449,
  stay uncounted: compaction and branch-summarisation calls, and a subagent session's turns (Scope above).
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
- **Evidence (pinned 0.80.7 dist, issue #449)**: pi-agent-core `dist/agent-loop.js:48-49` (a prompt) and
  `:66-67` (a continue) emit `agent_start` then `turn_start`, and `:89` every later turn's `turn_start`, all
  BEFORE the model call at `:105`; an error stop emits `turn_end` and `agent_end` and returns (`:107-110`) ·
  pi-coding-agent `dist/core/agent-session.js:732-733` loops `agent.continue()` while `_handlePostAgentRun`
  says so, and `:748` routes a retryable error to `_prepareRetry` · `:2067-2071` increments the attempt and
  returns false past `maxRetries` WITHOUT emitting, `:2074-2080` emits `auto_retry_start` only when it will
  retry · `:2090-2101` a sleep aborted by `abort()` (`:1147-1148` calls `abortRetry()`) emits
  `auto_retry_end{success:false}` and does not continue, after which `:760-765` may still continue for
  compaction or queued messages · `:351-358` an assistant `message_end` whose `stopReason` is anything but
  `"error"` (an `aborted` one included) emits `auto_retry_end{success:true}`, which is after the retry's own
  `turn_start` · `:739` emits `agent_settled` once the prompt's run chain is over · `:1507-1530` and
  `:1674-1681` an overflow with `willRetry` compacts and re-sends the same turn · `:763-765` a queued
  message starts a new run · pi-agent-core `dist/agent-loop.js:267/300/336` emit `tool_execution_start`
  before every tool path (truncated, sequential, parallel) · `:751-758` an exhausted
  streak's final `auto_retry_end{success:false}` · `image/runner/src/config.mjs:56` `PI_RETRY_MAX`
  (default 2). Pinned by `image/runner/test/turn-budget.test.mjs` and `image/runner/test/outcome.test.mjs`,
  driving that order (`image/runner/test/helpers/pi-retry-events.mjs`), and against the REAL pinned
  `AgentSession` by `image/runner/test/pinned-api.test.mjs`: a loopback Anthropic stub answers a 429 then a
  text reply, and the test requires `auto_retry_start` strictly before the retry's `agent_start` and
  `turn_start` and a budget of `turns: 1, retryTurns: 1`, so a pin bump that reorders them fails there.
  The same file drives, on the real session: a 429 forever (`turns: 1, retryTurns: 2`, no abort); a
  retry-shaped throw after a tool ran (counted, aborted, one request); the same throw after a completed reply
  with a follow-up queued (counted, aborted, one request); a queued follow-up after the abort (re-aborted, one
  request); and the fallback token budget's breach on a failed turn (re-aborted at the retry's `turn_start`,
  one request). At the 0.99.1 pin (issue #509) three of those premises moved and the test pins the new ones:
  the throw after a tool ran makes pi omit the failed attempt and `prompt()` reject (`Cannot continue from
  message role: assistant`), which the runner ends as `2` / `retry-unresumable` rather than a queue-retried
  `1` (`INT-RUNNER-EXIT-CODE-PROTOCOL`); a queued follow-up no longer starts a second run after the abort;
  and the token budget's abort at `turn_end` reaches pi before it decides to retry, so no `auto_retry_start`
  follows. Each still costs one request, and the recovered-429 order above is unchanged
- **Traces to**: `CONST-BUDGET-BEFORE-TOKENS`, `REQ-JOB-TIMEOUT-30M`, `REQ-UPSTREAM-CONTRACT-TESTS`
- **Acceptance**: Given a flow that would exceed the turn maximum, the runner aborts at the threshold and
  exits with the policy code, not the infra code. Given `--max-turns 1` and a provider 429 that pi's own
  retry recovers from with a reply that calls no tool, the job exits `0` with `retryTurns: 1`; given a 429
  that outlasts pi's retries, it exits `1` (infra, retried), not `2` / `turn_budget`. Given a retry-shaped
  failure AFTER a turn's tools ran, or after its reply completed, the turn pi runs next is a counted one;
  and given a follow-up queued when
  the budget aborts, the run pi starts for it is aborted too, before its model call.
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
  - Chromium launches as the non-root runtime user (the `PLAYWRIGHT_BROWSERS_PATH` collision), and, for an
    image declaring `anyUid`, as an arbitrary non-root uid given `HOME=/home/pi` (issue #341);
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
  **A semantic-window swallow is VISIBLE** (issue #289). The two layers answer differently at the pin's
  own Lua, and only one of them used to be readable: a GUID replay returns the SAME id (the shield
  working -- the delivery IS queued, so "queued" is its true answer and its silence is by design), while
  the semantic window returns the EXISTING job's DIFFERENT id. `enqueueForgeJob` now compares and
  returns `{ jobId, deduplicated, survivingJobId? }`; the receiver logs one `deduplicated` line per
  swallow (delivery id, computed id, surviving id -- all forge- or worker-minted, never payload text),
  logs `enqueued` only when something was CREATED with `replicas` meaning jobs that now exist, and a
  delivery that created nothing answers `202 {status:"deduplicated"}` -- still a 2xx (a non-2xx would
  trigger a redelivery storm for a handled delivery), but no longer "queued", because a receiver that
  logs the swallow while answering success on the wire would be an honest log behind a lying wire.
  Before this, re-labelling an issue inside the window did nothing, with no feedback anywhere.
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

## REQ-OPERATOR-JOB-CANCEL

- **Statement**: An operator shall be able to stop ONE job from a surface that needs no model: the CLI
  (`pi-dispatch cancel <jobId>`, VALKEY_URL-only like `pause`; on a shell/`.env` disagreement about VALKEY_URL it
  refuses until `--valkey-url` names which, before or after the id, issue #468) and the panel (`x` on the ACTIVE row; the
  held drill-in behind `h`). An active job is aborted on whichever host owns it and its run record says
  `outcome: "policy", reason: "operator-cancel"`; a queued, delayed or held job is removed and the cancel records
  NOTHING. What the CLI and the panel's footer say of the removed job's past is read off the job (issue #477): with no attempt made it never
  ran and has no record; with one or more (a job waiting to retry after a failed attempt) it made that many attempts,
  and whatever they recorded stays (most write a run record; a gate that fails above the processor's `try` writes
  none, so no record is promised). A cancel that no reachable worker acknowledges is a named refusal, never a silent no-op.
- **Why**: the abort machinery (`REQ-JOB-TIMEOUT-30M`) shipped complete with exactly two triggers, both
  automatic -- the kill timer and shutdown -- while the only human-shaped stop, `dispatch_wait_cancel`,
  reached held jobs only and was model-callable only. An operator watching a paid job misbehave had
  `docker stop` typed by hand or stopping the whole worker. Money is this project's other boundary, and
  spend already running had no human-operated bound short of the timer.
- **Traces to**: `REQ-JOB-TIMEOUT-30M`, `CONST-RETRY-INFRA-ONLY` (the cancel is policy, returned, never
  retried), `DES-CANCEL-VIA-REDIS-REQUEST-KEY`, `INT-CANCEL-CHANNEL-CONTRACT`
- **Acceptance**: one job stops without touching its neighbours; the record says an operator did it;
  `dispatch_wait_cancel` stops being the only door to a held job; a cancel of a job this host does not
  own says so instead of doing nothing.

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
- **Who authors which comment** (issue #288, closing the acceptance's paid half): the AGENT authors the
  exit-0 status comment (the prompt contract instructs it, including for "I looked and cannot fix
  this"); the WORKER authors every other terminal comment -- each pre-spend refusal (the ladder; a `model-unknown`
  refusal whose `why` starts `overlay-` posts its own sentence, "Refused before starting: the deployment's model
  settings file (models.json in the overlay) cannot be used for this job, so no container was started and nothing
  was spent. The operator needs to fix that file. Not run.", since the deployment's file is the problem and not the
  job's model; it names no path and no model), the
  worker-abort/operator-cancel/runner-policy/provider-auth-refused stops (fixed sentences keyed by the
  reason token; `provider-auth-refused`, issue #437, is the exit-2 stop whose runner named a provider's
  refusal of the credential or of access (an authentication or permission error, whatever its HTTP
  status), and its sentence tells the requester the operator must check the provider key and what it is
  allowed to use; and, since issues #501/#502, the four policy stops, each with its own fixed sentence:
  `cost-cap` ("Stopped: the next AI call could have taken this run past its cost limit, so it was not made. Partial work may exist. Not retried.") and `model-not-allowed` ("Stopped: the run tried to call an AI model this trigger does not allow, or to change an AI request in a way it does not allow, so the call was not made. Partial work may exist. Not retried."), `cost-cap` live on an image that declares `costCap` (its runner's pre-call cost guard stopped a call) and `model-not-allowed` live on an image that declares `modelPolicy` (its runner's pre-call model guard stopped a call to a model the list does not name; the same token is also the worker's FREE pre-spend refusal of a main model off the job's list, which posts its own refusal comment and pages nobody); and `cost-cap-unenforceable` ("Stopped: this run has a cost limit, and the job image could not enforce it before each AI call, so nothing was sent to the AI provider. The operator needs to update the job image. Not retried.") and `model-policy-unenforceable` ("Stopped: this run is limited to certain AI models, and the job image could not enforce that before each AI call, so nothing was sent to the AI provider. The operator needs to update the job image. Not retried."), live now, the runner having refused before any call a cost cap or a model list it cannot enforce before a call), and the final infrastructure failure.
  Once-ness for the infra class is BullMQ's own terminal decision
  (`finishedOn`, set only on the non-retry branch): a retried attempt comments nothing, so a flaky
  daemon cannot post three comments for one recovery, and the seam that reads it also covers the
  stall-killed job the processor never ran on. Every worker-authored sentence is fixed and path-free,
  because a local job's comment lands verbatim in a persistent service log.
- **Acceptance**: Given any forge-backed job reaching a terminal state, exactly one completion or failure
  comment exists on the issue — posted through that forge's own endpoint, which on GitLab means the merge
  request notes path for a merge-request target and the issue notes path for an issue.

## REQ-OPERATOR-FAILURE-NOTIFICATION

- **Statement**: The operator may name ONE command (`PI_ON_FAILURE`, absolute path, refused at boot
  otherwise) which the worker executes with id-only argv -- `<jobId> <outcome> <reason> <host>` -- when a
  paid job reaches a terminal failure: the final infrastructure failure, a worker abort, or an
  in-container policy stop. Fire and forget: at most once per job, fault-isolated so a hook failure can
  never change a job's outcome, all stdio ignored, exit code logged and unread. Unset, the deployment is
  byte-identical to one where the feature does not exist. This project ships NO transport, ever; the
  operator wires ntfy, Slack or mail themselves in one line.
- **Why**: the cheap failures announce themselves (every pre-spend refusal comments) while the expensive
  ones -- the only ones that already cost a container and tokens -- were the silent ones, visible only in
  a worker log nothing tails. A hook with id-only argv is the entire notification feature; a transport
  would be a dependency, a queue and a retry policy this operational layer has no business growing.
- **Excluded on purpose**: completions; every free pre-spend refusal (a delivery storm against a spent
  cap must not page anyone); retried attempts that may yet recover; and `operator-cancel`, because the
  operator initiated it.
- **Traces to**: `REQ-JOB-STATUS-COMMENTS`, `CONST-RETRY-INFRA-ONLY` (a hook fault flips no outcome),
  `CONST-ISSUE-TEXT-IS-DATA` (id-only argv), `INT-ON-FAILURE-HOOK-CONTRACT`
- **Acceptance**: a 30-minute kill comments on its issue; a final infra failure comments once; an
  operator with a one-line script gets a push when a job fails; no payload text crosses either channel;
  with `PI_ON_FAILURE` unset the HOOK is absent byte-identically (the comments have no knob on purpose --
  they discharge `REQ-JOB-STATUS-COMMENTS`' standing acceptance, so upgrading visibly adds them).

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
    the `maxStalledCount` carve-out. The counter is **per scheduler and windowed**: it lives under its own
    key with its own expiry, so one scheduler's stalls never extend another's window, and a scheduler that
    stops stalling for a full window drops back to zero. Stated here because it was previously claimed only
    in a source comment, and the comment was false while the counter shared one key (issue #267).
  - Given a worker that was down across one or more due ticks, when it restarts, then exactly one job is
    emitted (no backfill), and at most one UNSTARTED next occurrence exists for a schedule at any time.
    Two occurrences of one schedule CAN be in flight together when a slot is free — the false "no
    overlap" claim this line carried until issue #242 — except on one folder: two local jobs naming one
    `run.folder` (by resolved path, within one worker process) never run concurrently, the second
    deferred to the delayed set with its attempt count untouched (`REQ-SCOPED-LIMITS`, the mutex).
  - Given a scheduler resident in Redis but absent from the current config, when the worker performs its
    startup reconcile **or a live reload**, **and no other live worker publishes a schedule-set fingerprint
    differing from this worker's**, then the orphaned scheduler is removed.
  - **Given another live worker whose fingerprint differs, then no scheduler is upserted and none is
    pruned** -- the resident set is left exactly as it was, the refusal is RETURNED (never thrown) and
    logged as `cron_divergence_refused` naming every disagreeing host and its schedule count, and the
    worker still boots and drains. A divergence FREEZES the schedule set; it does not disable cron, and it
    must not take a host's forge capacity offline over a cron disagreement. Both halves are refused, and
    not for symmetry: `upsertJobScheduler` on an existing id is a REDEFINITION, so permitting the upsert
    alone would let two hosts flip one schedule between two definitions on every file change, unlogged.
  - **Given a worker with cron disabled (`PI_TRIGGERS_FILE` unset), then it publishes no fingerprint and is
    never a disagreeing party; given a worker whose triggers file declares ZERO cron entries, then it is
    one** -- "there should be no schedulers" is an opinion, and it is this failure's purest form, because
    the live-reload path has no empty-set guard and deleting the last cron trigger on one host therefore
    prunes the whole fleet's.
  - Given no other live worker, or a registry that cannot be read at all, then the rule is vacuous and the
    behaviour is byte-identical to the single-host original: absence of knowledge never refuses, so the
    rule only ever WITHHOLDS a permission and can never be a regression.
  - Given the host's IANA timezone differs from a peer's, then the fingerprints differ and the divergence
    is refused, because a cron pattern carries no timezone -- `triggers.json` has no `tz` field on a cron
    entry and the pattern resolves in each worker's local system time, so one pattern is two instants.
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
    runner preflights, then the job refuses as `command-unregistered` (exit 2, never retried) before its
    prompt is sent; a call an extension made while it loaded may already have spent, and the exit line
    carries it (`INT-RUNNER-EXIT-CODE-PROTOCOL`).

## REQ-DURABLE-RUN-HISTORY

- **Statement**: For each job reaching a terminal state — completed, policy refusal, or infra failure —
  the worker shall persist a durable, PII-free status record retrievable by job id, and — when raw
  capture is explicitly enabled (`PI_CAPTURE_JOB_LOGS`) — capture the container's output to
  `logs/<jobId>.log`. Records shall survive a worker restart AND a host reboot, and outlive BullMQ's
  job-hash eviction. No new datastore.
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
  exists only when `PI_CAPTURE_JOB_LOGS` is set and is gitignored. Given a host on which nothing sets
  `PI_LOGS_DIR` or `PI_SETTINGS_FILE` (which after issue #357 means a deployment where `pi-dispatch up`
  has not run in a folder that already had a `.env`, since `up` writes both as the resolved account
  default there and writes nothing at all where there is no file to fill),
  when the host reboots and the OS sweeps its temp directory, then
  the records and the settings overlay are still readable at the same paths — or `pi-dispatch doctor`
  names, on one line, the path that will not survive and why (issue #290; "survive a worker restart" was
  the weaker claim this entry made while both defaulted under the OS temp dir). Given an account with no home
  directory, then both default under its own per-account temp root, `<tmp>/pi-dispatch-<euid>` (issue #464; it was the
  shared `<tmp>/pi-dispatch`), which the worker at boot and the panel's overlay write make this account's (`0700`) or
  refuse, and doctor fails on it when another account owns it.

## REQ-ADMIN-VIA-PI-EXTENSION

- **Statement**: The admin surface shall ship as a pi extension in `admin/`, loaded into the operator's
  interactive pi session. It provides operator slash commands for observability (`status`, `runs`, `logs`,
  `budget`, `triggers`, and `insights` — the one analytics surface, writing and opening the artifact of
  `REQ-INSIGHTS-HTML-EXPORT`, with a `whatif` form per `REQ-COST-ANALYTICS`), queue on/off
  (`pause`/`resume`, backed by the same durable `queue.pause()`), and
  settings editing (`set`/`unset`, writing the `settings.json` overlay), plus **operator-typed trigger CRUD**
  from the overlay (add / edit-flow / delete, writing `triggers.json` — validated by the shared
  `parseTriggers`, atomic — and reloaded **live** by both services, `OQ-008`). The model-callable tools are
  the **reads** `dispatch_status`, `dispatch_runs`, `dispatch_costs`, `dispatch_triggers`,
  `dispatch_pauses`, `dispatch_limits`, `dispatch_waits`; the **queue controls** `dispatch_pause` and
  `dispatch_resume`; the **gated enqueue** `dispatch_run`; and the **confirm-gated writes** `dispatch_set`,
  `dispatch_trigger_add`, `dispatch_trigger_edit`, `dispatch_trigger_delete`, `dispatch_pause_add`,
  `dispatch_pause_edit`, `dispatch_pause_delete`, `dispatch_limit_add`, `dispatch_limit_edit`,
  `dispatch_limit_delete`, `dispatch_wait_cancel`. **This list is the pin**: `admin/test/wiring.test.mjs`
  reads this paragraph and fails the build if a registered tool is missing from it, or if a name here is
  registered nowhere — so every name is spelled in full, and a tool discussed as rejected belongs in
  **Why**, which the scan does not read. There is deliberately **no count word** beside the list: a number
  is a second claim the pin does not check, and this entry said "eleven" while twenty-one shipped.
  A write tool applies
  its change **only after a human operator approves a `ctx.ui.confirm` dialog showing the concrete
  before→after**, and **refuses — writing nothing — when no interactive operator is present** (`ctx.hasUI`
  false; print/headless). The operator-typed overlay CRUD and the confirm-gated tools reach the **same**
  validated, atomic `writeTriggers`/`writeSettings`. `dispatch_run` still takes **no spend-knob argument**
  (`model`/`maxTurns`/`dailyCap`/`concurrency`).
  Since issue #501's part 7 the dollar caps have operator surfaces. The panel shows each ACTIVE dollar window
  (the deployment's, then each scoped-limits dollar row) with its counter (spent and held) and, from the run
  records, what settled, how each run settled (`metered`, `floor`, `refunded`, `unreserved`) and the
  `boundExceeded` count; numbers and the operator's own scope and model names only. `dispatch_costs` returns the
  same windows and each run's `dollars`; `dispatch_limits` gives each row its dollar windows with their counters.
  The scoped-limit writers take `dayUsd`, `weekUsd` and `monthUsd`, and `dispatch_set` the four dollar keys, each
  judged by the worker's own parser before the confirm. Neither trigger write tool can set a trigger's
  `run.maxCostUsd` or `run.models`; the trigger read shows both.
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
  terminal-native operator, narrower than the superseded localhost panel. The daily cap, and the per-job
  dollar cap `maxCostUsd` (issue #501), can be raised only
  **with an operator's approval**: a settings write (dailyCap and maxCostUsd included) is either operator-typed or a
  confirm-gated tool the model **cannot self-approve** — the model emits the call, the human answers the
  confirm — so a prompt-injected session cannot raise the cap without a human keypress it cannot forge.
  The three dollar windows (`dailyCostUsd`, `weeklyCostUsd`, `monthlyCostUsd`) are settings keys too, behind the
  same operator-typed or confirm-gated write, and are enforced since issue #501's part 3. A trigger's
  `run.maxCostUsd` and `run.models` are not settable by any tool, confirm or no confirm: each decides what the
  trigger's jobs can spend or reach, so removing or raising one is a widening, and it is written by hand in the
  reviewed triggers file. A tool call that carries either is REFUSED rather than dropped, because a dropped field
  would let the model report a narrowing that never landed.
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
  the console's pin, then bare `/dispatch` surfaces one skew notice pointing at `/dispatch setup`;
  given a trigger write tool call carrying `maxCostUsd` or `models`, then it is refused before any confirm and
  nothing is written, and given an approved edit of a trigger that has them, then they are written back
  unchanged; given a malformed dollar amount for `dispatch_set` or a scoped-limit writer, then it is refused before
  the confirm, naming the key and not the value; given a scoped-limit write whose rows carry no dollar field and
  no model row, then the file is written as version 1; given a dollar window, then the panel and
  `dispatch_costs` show its counter as spent and held, never the records' sum, and a window whose counter cannot
  be read shows no number rather than 0.

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
  when `dispatch_run` fires, then it refuses with no force option; given a folder that is not a git
  repository's root with a commit at HEAD, when `dispatch_run` or `/dispatch run` fires, then it refuses
  with the sentence `pi-dispatch run` gives and enqueues nothing; given an identical run already queued in
  the same minute, when either fires, then it says so and does not report a new job; given a chain request exceeding
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
  **Dollar windows** (issue #501): beside the job count, a deployment MAY bound what its jobs spend in dollars
  per UTC day, Monday week and calendar month (`dailyCostUsd`, `weeklyCostUsd`, `monthlyCostUsd`;
  `PI_DAILY_COST_USD`, `PI_WEEKLY_COST_USD`, `PI_MONTHLY_COST_USD`), each optional, each disabled when unset, and
  each valid only with a per-job cost cap (`maxCostUsd`), which is the amount every job reserves. After both
  job-count reserves and before the container, the job's per-job cap is reserved in every active dollar window;
  a window it does not fit refuses it pre-container as `dollar-cap` (the window named in the comment and the
  log), its dollars and both job-count slots given back. After the run the reservation is replaced by the
  metered cost when the cost is fully known (a run that made no provider call meters 0), and kept whole (a floor,
  at least the reservation and never less than a reported metered cost) when it is not; a run that never started
  is refunded. Amounts are integer micro-dollars. A job whose every allowed model is local and zero-rated
  reserves nothing. The soft-hold band stays a job-count brake only.
- **Why**: A daily cap alone bounds a single day's blast radius but not a slow bleed — a flow that stays
  under 25/day every day still spends unboundedly across a month. The weekly and monthly ceilings close that
  gap on longer horizons. The soft-hold band is a distinct operator brake **before** the hard wall: crossing
  it pauses new starts (in-flight containers finish, since the reservation is pre-container) and turns the
  panel meter amber, so an operator is warned and can raise a cap or intervene rather than discovering the
  ceiling only when jobs start refusing. The three job-count windows remain **job-count** caps (container
  starts), not tokens (the thing knowable *before* a run), and their ordering under `CONST-BUDGET-BEFORE-TOKENS`
  is unchanged (the dollar windows join that constraint as its second ledger); the token controls are a
  separate, structurally lagging problem addressed by `REQ-TOKEN-ACCOUNTING-AND-CAPS` (`OQ-010`). The dollar
  windows answer what a job count cannot: 25 jobs a day is $2.50 on a small model and hundreds of dollars on a
  large one. They can be checked BEFORE the run because the per-job cost cap is enforced before every provider
  call, so a reservation of that cap is a true bound on the run (`DES-DOLLAR-RESERVE-AND-SETTLE`). A refused
  dollar reservation is given back at once, unlike a refused job-count slot: kept, five refused $2 reservations
  would empty a $10 window with nothing run.
- **Traces to**: `CONST-BUDGET-BEFORE-TOKENS`, `DES-RUNTIME-SETTINGS-FILE-OVERLAY`,
  `INT-CONFIG-OVERLAY-CONTRACT`, `REQ-RUNTIME-SETTINGS-PICKUP`, `DES-DOLLAR-RESERVE-AND-SETTLE`,
  `INT-RUN-HISTORY-FILE-CONTRACT`, `INT-MODEL-ENDPOINTS-FILE-CONTRACT`
- **Acceptance**: Given any active window over its cap, when a job starts, then it is refused `over-budget`
  before `reserveBudget` admits a container, and the refusal names the blocking window; given a reservation
  that lands inside the soft-hold band of any active window but under every hard cap, when a job starts, then
  it is refused `soft-hold` before any container while in-flight jobs continue; given an unset `weeklyCap`
  (and no `PI_WEEKLY_CAP`), when a job starts, then the weekly window is neither counted nor evaluated; given
  a `softHoldPct` set live in the overlay, when the next job starts, then the band takes effect with no
  restart; given a refused reservation, when the window rolls over, then its counter is reclaimed by TTL.
  Dollars: given a $10 week window and a $2 per-job cap, when twenty jobs reserve at once, then at most five are
  admitted, and a sixth is refused `dollar-cap` before its container starts with its job-count slots and dollars
  given back; given a finished job whose metered cost is complete, then its windows show that cost, not its
  reservation, and an overshoot above the reservation is charged in full; given a job with no exit line, or any of
  `unresolved`, `unpriced`, `boundExceeded`, `longContext`, `costUnjudged`, `costUnanswered` non-zero or absent,
  then it settles at the floor, `basis: "floor"`, charging its reservation or the reported metered cost, whichever is
  larger; given a run that made no provider call (the first call refused by the guard, a command job, an early
  exit), then it settles metered at 0; given a job reserved at 23:59:59 UTC that settles after
  midnight, then the settlement lands on the day it reserved; given a job whose container never started, then its
  reservation is refunded whole; given a job whose every allowed model is served by a declared endpoint and
  zero-rated, then no `budget:usd:*` key is written and it runs under a per-job cap of 0; given no dollar setting,
  then no `budget:usd:*` key is written and the job data and the exit line are unchanged.

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
  (`INT-SCOPED-LIMITS-FILE-CONTRACT`); the mutex alone is code.
- **Forge-separated scopes** (issue #498): a row may name one forge's repo as `<kind>:owner/name`
  (`github:acme/web`), while a bare `owner/name` row keeps naming that repo on every forge. A job matches its
  qualified row first, then its bare row; a file with both for one repo is refused. Every counter, slot and lease
  is keyed by the matched row, so a bare row keeps its pre-upgrade count and a GitHub and a Forgejo job for one
  repo under qualified rows never share a limit.
- **Dollar windows** (issues #501 part 5 and #502 part 6, file version 2): a repo or folder row may also cap
  what the scope's jobs spend per day, week and month in dollars (`dayUsd`, `weekUsd`, `monthUsd`), and a
  `model:<provider>/<model>` row caps what every job spends on that model, across every scope. Each is reserved
  before the container with the deployment's dollar windows, in one step that gives everything back on a
  refusal (`dollar-cap`), and settled after the run (`DES-DOLLAR-RESERVE-AND-SETTLE`). A version 1 file that uses
  either is refused naming version 2; a version 1 file without them keeps working unchanged.
- **Project rows** (issue #499 part B): a `project:<id>` row (file version 2) caps every member of a project
  (`INT-PROJECTS-FILE-CONTRACT`) as one, with `day`/`week`/`month` (refused pre-spend under the fixed reason
  `project-cap`), `concurrent` (a deferral, like a repo's) and, in version 2, `dayUsd`/`weekUsd`/`monthUsd` (refused
  `dollar-cap`). A job reserves narrowest first: its repo or folder row, then its project's row, then the global
  windows; a refusal by any ledger gives back the ones before it, and every path that refunds gives back every ledger
  still held. A row naming a project that does not exist refuses the worker's start, never caps nothing in silence.
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
  Given a repo row with `dayUsd` and a job whose cap does not fit, then the job is refused `dollar-cap` before
  any container, and the deployment's dollar reservation is given back. Given a version 1 file with a dollar
  field or a model row, then the file is refused naming version 2. Given a dollar row on a deployment with no
  per-job cap, then the worker and `doctor` warn, and a job its trigger does not cap is refused `config-refused`.
  Given a row window below the per-job cap, then `doctor` warns, and the refusal says the budget is smaller than
  the run's cost limit rather than that no room is left.
  Given qualified rows `github:acme/web` and `forgejo:acme/web` (issue #498), then a GitHub job and a Forgejo job
  for `acme/web` take separate counters and leases; given a bare `acme/web` row instead, then both share it and it
  keeps the count it had before the upgrade (no key moved). Given a bare and a qualified row for one repo, or an
  unknown forge prefix, then the file is refused naming both indexes or the known kinds. Given a qualified row in a
  version 1 file, then the file is refused naming version 2, so no build reads it as an inert repo string. Given a bare row and
  triggers on more than one forge kind, then `doctor` warns with the qualified spellings.
  Given a project of two folders and a `project:` row with `day: 2` (issue #499 part B), then the third member job
  that day is refused `project-cap` before any spend, its folder's slot is given back and the global ledger is not
  touched; given a full global window, then the project and folder slots are given back; given a container that never
  started or a config-refused job, then all three are. Given `concurrent: 1` on the project row, then a second member's
  job defers while the first runs. Given a project `dayUsd` window with no room, then the job is refused `dollar-cap`.
  Given a row naming a project the projects file does not define, then the worker refuses to start, a live edit that
  would create one is kept out, the admin refuses to write it and `doctor` fails naming it.

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
  wraps the model-calling methods of pi's `ModelRuntime` class (streamSimple, stream, streamDeferred,
  classify, generateImages) on its prototype, the one choke point every in-process session's model calls go
  through at the 0.99.1 pin, plus pi-ai's legacy api-provider registry for extensions that call it directly,
  and accumulates each provider call's `usage` into per-job totals
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
  `PI_MAX_TOKENS`) that the runner enforces in-run — once the running total exceeds it the meter answers
  every subsequent provider call **by any session** without reaching the provider (a synthetic **aborted**
  stream, or an aborted classify/images result) and the root session is
  aborted — exiting policy (`2`) with `reason: "token_budget"`; and (c) provide an **optional daily token
  cap** (`dailyTokenCap` / `PI_DAILY_TOKEN_CAP`) that refuses a new job pre-container once the day's recorded
  spend has reached it; and (d) enforce an **optional per-job cost cap** (`PI_MAX_COST_MICROS`, integer
  micro-dollars, issue #501) **before every provider call**: the runner bounds each call's worst-case cost from
  the model's catalog rates (`DES-DOLLAR-RESERVE-AND-SETTLE`) and refuses it, answering with the meter's hard
  stop and aborting the root session, when what settled calls cost plus the bounds of calls still in flight plus
  this call's bound would pass the cap, or when the call cannot be bounded; it exits policy (`2`) with
  `reason: "cost-cap"`. A runner that cannot enforce a cap before a call refuses the job before any call
  (`cost-cap-unenforceable`). Every cap is unset-means-disabled and the token caps resolve
  `job.data > overlay > env` per job; accounting is always on.
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
  **Why the cost cap is the opposite shape (d).** A token cap may lag by one call because one call's tokens are
  bounded by the cap's own scale; one call's DOLLARS are not. At the 0.99.1 pin one call on the default model
  can cost several dollars (about a million input tokens and 64,000 output tokens, priced at the cache-write
  rate), so a dollar cap checked after a call is a soft limit that one call can overshoot by more than the cap.
  So (d) is checked before the call, against a bound that is an upper bound by construction: the request's
  UTF-8 bytes plus 8,192 as input tokens (one token is at least one byte, checked by use through the
  `boundExceeded` counter), the call's output cap, the dearest table that could price it (tiers, fallback
  models, a 1h cache write, a generic Anthropic long-context tier) and the worst service tier. Calls the bound
  cannot cover (`pi-messages` and other self-priced apis, image generation, deferred fetches, a classifier
  with an output rate) are refused under a cap rather than guessed. With no cap set no guard is installed and
  no cost counters are emitted; the one change such a job can see is that a call whose result rejected now
  counts as unpriced.
  **Why the accounting is process-wide, and not per-session.**
  *Negative fact — this scope exists because of an upstream absence.* A session's event bus is **per
  instance**: `AgentSession._eventListeners` is an array on the instance and `Agent.listeners` a `Set` on
  the instance, `createAgentSession` builds a fresh `Agent` + `AgentSession` every call,
  `CreateAgentSessionOptions` carries **no parent or shared-bus option**, and **no event carries a
  `sessionId`**. So a subagent session an extension spawns emits **nothing** on the parent's bus, and a
  16-wide fanout registers there as roughly **one** turn — meaning a `subscribe()`-only meter understates
  spend precisely on the most expensive jobs, which is the opposite of what a spend control is for. The one
  choke point every in-process session shares is `ModelRuntime.prototype` (at 0.80.7 it was pi-ai's
  module-level api-provider registry, which a 0.99.1 session no longer touches): metering there counts
  **calls** rather than turns, and `options.sessionId` (a declared field on pi-ai's `StreamOptions`)
  reaches the provider, which is what makes the root/other split possible at all. If pi ever forwards a
  child session's events onto its parent's bus, this scope becomes deletable — the absence is named here so
  a future maintainer knows that, rather than leaving the meter as unexplained ballast.
  **Honest note — the numbers get bigger, not just better.** With the meter active, a plain job that loads
  no packages will report a `total` **greater than or equal to** the one the `subscribe()` sum reported,
  because the meter also sees compaction and summarisation calls that never surfaced as a root `turn_end`.
  The exit-line shape and every exit code are unchanged; the accounting is simply more complete. A daily
  token counter fed by it therefore fills faster than before at identical real spend — that is the
  correction, not a regression.
  At the 0.99.1 pin compaction and branch summaries are sent under a FRESH session id when the caller passes
  none (compaction.js completeSummarization), so they land in `otherTotal`, not `rootTotal`: `otherTotal > 0`
  alone no longer proves a fanout (`sessions` counts the distinct ids). Cache warming, which would add paid
  maxTokens-1 re-sends under the root id, is off in every job.
  **What the breach actually stops.** `session.abort()` on the root is **voluntary and does not propagate**
  to a child session, so aborting is not the brake. The forward brake is the meter: once breached, every
  subsequent provider call by **any** session is answered with a synthetic aborted stream before it reaches
  a provider (zero usage, `stopReason: "aborted"` so pi's own retry does not fire). The cap remains
  structurally **lagging** either way, and the ultimate backstop stays `REQ-JOB-TIMEOUT-30M`.
  **Child processes (issue #500).** A **`pi` subprocess** has its own copy of pi, so no in-process hook in the
  runner sees its calls; pi's own SDK example spawns one. Each pi child now meters itself and reports through a
  ledger file, and the runner folds those files into the job's totals every second and at teardown: the totals
  include the children, `childTotal` keeps `rootTotal + otherTotal + looseTotal + childTotal` equal to `total`, and
  the token cap, the cost cap and the model list are judged on the job as a whole (the parent's list, whatever a
  child's own environment says). A stop reaches the children through a `STOP` file they read before every call. A
  pi child that reports through no ledger (Linux: found in `/proc`) is UNMETERED: it is counted in
  `unmeteredChildren` (a floor) and, under any policy, stops the job (`cost-cap` under a dollar cap, else
  `token_budget`, else `model-not-allowed`); an uncapped job records the floor and runs on. Cooperative accounting,
  not a boundary: the agent holds the provider key and can call the API directly or tamper with the files, and
  the rules make that fail toward a floor or an overcharge (`DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY` names the
  residuals). Tracked at `OQ-011`.
- **Traces to**: `OQ-010`, `OQ-011`, `REQ-RUNNER-TURN-BUDGET`, `REQ-UPSTREAM-CONTRACT-TESTS`,
  `CONST-BUDGET-BEFORE-TOKENS`, `INT-RUNNER-EXIT-CODE-PROTOCOL`, `INT-RUN-HISTORY-FILE-CONTRACT`,
  `INT-CONFIG-OVERLAY-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`, `INT-SDK-SESSION-OPTIONS`,
  `REQ-SPEND-CAPS-MULTI-WINDOW`, `DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY`, `DES-DOLLAR-RESERVE-AND-SETTLE`
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
  **Cost-cap clauses (d).** Given a cost cap and an offline provider whose calls settle at a fixed cost, when
  the next call's bound would take the settled total past the cap, then that call never reaches the provider,
  the run exits `2` with `reason: "cost-cap"` and `costRefused: 1`, and the job's metered cost is at or under
  the cap; given two sessions calling at once, then each is judged against the other's bound while it is in
  flight; given `session.compact()` as the call that would pass the cap, then it is refused the same way; given
  a cap of `0`, then a zero-rated model runs and a priced one is refused before its first call; given no cap,
  then no guard is installed and the exit line carries none of the cost counters. Given a per-job cap below one full-output
  call of a job's main model or of a model on its list (the model's output limit at its output rate, plus the
  runner's 8,192-token overhead and a 4,096-byte first request at its dearest input rate, times the runner's
  service-tier multiplier, a lower bound of the runner's own bound), then `pi-dispatch doctor` warns, naming the model, the amount and the cap; with the default
  model and a $1 cap it says $1.00608 (issue #501's open question).

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
  path, human or model-facing (`dispatch_costs` carries the class on every value of its `fold`), can launder an
  estimate into a fact. The `dollars` block beside the fold (issue #501, part 7) is not analysis: it holds the
  dollar caps' enforcement amounts, integer micro-dollars read from the window counters and the run records'
  `dollars`, facts with no estimate among them, so it carries no class. Attribution and re-pricing are possible at all because the ledger records what
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
  `dispatch_costs`, then every monetary value in the returned `fold`
  carries its `class`, and its `dollars` block (present when a dollar window is set, a dollar setting cannot be
  read, or a run in the window carries `dollars`) holds integer micro-dollars only; given a run recorded under an older pi-ai pin, then it is counted as
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
  the shared cost formatter so a plan-covered trigger never reads `$0.00` (the fold keeps a bucket's
  `plan:<id>` when one declared plan covers every run in it and no run is a floor, issue #492: it had
  demoted such a bucket to `~$0 est.`, which is that `$0.00` with a tilde; a floor keeps its `≥` under
  `REQ-COST-ANALYTICS` (d), and a bucket two plans cover stays estimated, since an id may hold any
  character and no separator could name both), and the badge fits its chip, cut with the whole text in
  a tooltip; a close rule narrowed to one item leads its label with
  the `#<n>`, so a chip that cuts its label from the end keeps what tells it from every rule on that
  action; and a one-shot trigger says so on its chip in the panel's words, `[once]` in the accent while
  armed and `[spent]` dim once fired, beside the tooltip's own words; spend and schedule are
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
  matches a job's `repo` (any forge) or `folder` (local), a forge-qualified `<kind>:owner/name` matches that
  repo on that forge only (issue #498), and `"*"` matches all. A job whose scope is inside an
  active window is **deferred** to the window's end via BullMQ's delayed set (`job.moveToDelayed`), **not
  dropped** — it keeps its jobId/dedup, survives restart, and resumes automatically when re-picked. The gate
  runs **before the budget reservation**, so a deferred job reserves no slot and spends nothing. Windows
  recur daily (`from`–`to`, overnight when `from > to`), optionally restricted to weekdays (`days`) and a
  date range (`dateFrom`/`dateTo`), interpreted in the window's IANA `tz` (default UTC). The file is
  validated fail-loud at boot and **live-reloaded** (a bad edit keeps the last-good windows). Pause windows
  are managed operator-typed (`/dispatch` overlay) and via **confirm-gated** model tools
  (`dispatch_pauses` to list, `dispatch_pause_add`, `dispatch_pause_edit` and `dispatch_pause_delete` to
  change), the same human-approval gate as the trigger/setting writes (`REQ-ADMIN-VIA-PI-EXTENSION`).
  Spelled in full rather than elided: `dispatch_pause_edit` appeared in no spec file at all until issue
  #280, and an elision is how a sibling goes missing without any sentence being wrong.
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
  nothing; given an approved confirm, it writes exactly the shown window. Given a window `github:acme/web`
  covering now (issue #498), then the GitHub job for `acme/web` is deferred and the Forgejo job for it is not;
  given a bare `acme/web` window, then both are deferred, as before; given `gitub:acme/web`, then the file is
  refused naming the forge kinds.

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

## REQ-PER-TRIGGER-TOOL-EXCLUSIONS

- **Statement**: A trigger may name built-in pi tools its jobs' sessions shall NOT have
  (`run.excludeTools`), and the exclusion shall be ENFORCED by the session -- pi's tool registry lacks
  the named tools, so no extension call and no refresh can restore them -- never merely asked for in
  prompt text. Absent, a job is byte-identical to one before this existed.
- **Scope**: All five run kinds (cron included: what the container's agent may do is orthogonal to what
  triggered it). Narrowing only; the built-in set of the pinned pi only. Operator-authored config from
  the reviewed `triggers.json` only: no panel key, no model-callable tool can set or widen it, a chained
  job's request file can neither set nor drop it (the child inherits the parent's exclusions), and
  `dispatch_run` and non-trigger local enqueues carry none -- absent means today's full default set.
- **Why**: The pinned pi scopes tools per session and this project never used it, so every job got the
  full built-in set and a "read-only triage" flow's read-onlyness was guardrail prose the README itself
  discloses as "prompt text, not enforcement". One field on an options object that already exists turns
  that into the first enforced in-container permission. The hazard class is the SILENT half, and it is
  refused at every layer it can arise in: pi ignores unknown exclusion names without a diagnostic, so
  the loader validates members against the pinned set, misspellings of the key refuse as near-misses,
  an image whose runner predates the field is refused pre-spend via its capability label, and the
  runner re-asserts membership in-container and logs the session's active tool list read back.
- **Traces to**: `DES-PER-TRIGGER-TOOL-EXCLUSIONS`, `INT-TRIGGERS-FILE-CONTRACT`,
  `INT-CONTAINER-JOB-INPUTS`, `INT-CONTAINER-RUNTIME-CONTRACT`, `INT-SDK-SESSION-OPTIONS`,
  `INT-OUTBOX-CONTRACT`, `CONST-PI-VERSION-PINNED`
- **Acceptance**: Given a trigger excluding `edit` and `bash`, a job of that trigger produces a session
  whose active tool list, read back from the session, lacks both, whose full tool registry lacks both,
  and on which a by-name re-enable of either is a no-op. Given a name the pinned set does not know, the
  file refuses at load naming the known set. Given any model-callable surface, none can set or widen
  the field. Given a trigger without the field, its normalized entry, its job data and its container
  argv are byte-identical to today's. Given a job carrying exclusions and an image whose capability
  label does not declare `excludeTools`, the job is refused pre-spend with
  `job-image-exclude-tools-unsupported`, no token minted and no budget reserved. Given a chained child
  of a parent carrying exclusions, the child's data carries them verbatim regardless of the request
  file's contents.

## REQ-MODEL-POLICY

- **Statement**: A trigger may name the models its jobs may call (`run.models`, an allowed-model list),
  a deployment may name a default list (`PI_ALLOWED_MODELS`), and a job's models shall be known to exist
  before anything is spent. The worker half (issue #502 parts 2, 3 and 5): a job whose main model or any
  listed model is in neither pi's builtin catalog at the pin nor the overlay `models.json` is refused
  pre-spend (`model-unknown`); a job whose main model is not on its effective list is refused pre-spend
  (`model-not-allowed`), and so is a job with a list that names a model whose declared server-side fallbacks
  (`compat.allowedFallbackModels`, builtin catalog or overlay) are not all listed under its provider (`model-not-allowed`,
  logged `why: fallback-unlisted`); the effective list reaches the container as `PI_ALLOWED_MODELS`, only on an image
  that declares it can enforce one (`modelPolicy`); and a chained child keeps its parent's provider, model
  and list. The runner half (part 4): a job limited by a list never sends a call to a model outside it.
  Every provider call the job makes is checked before it is sent, and a call whose requested provider and
  model are not on the list, or whose request would name another model, is not sent; the job stops with exit
  `2` / `model-not-allowed`. Absent
  everywhere, a trigger's job data and its container environment are byte-identical to before; the free
  model-exists gate is the one thing every job now passes through, and an outbox child now carries its
  parent's trigger provider and model (absent when the parent's trigger named none).
- **Scope**: All five run kinds. The effective list is the trigger's if present, else the deployment's,
  else unrestricted (today's behaviour); the trigger's REPLACES the deployment's. Operator-authored config
  only: the deployment list is read from the environment, never the settings overlay, and no model-callable
  tool can set or widen either list. Only the main provider's credential is checked pre-spend; another
  listed provider's key may legitimately arrive through `run.secrets`, resolved later. Models an extension
  defines inside the job (`pi.registerProvider`, a virtual model) cannot be seen by the worker, so a list
  naming one is refused as unknown: a flow that needs one declares the physical models in the overlay
  `models.json` and lists those. The overlay is judged as pi 0.99.1 judges it, at its loader (a file pi
  would drop, for any reason, refuses EVERY job until the operator fixes it, since pi drops every entry with
  the file and would run even a builtin model against its provider's public endpoint, and which providers a
  broken file meant to route cannot be read from it; a file the worker cannot read is one the job loads none of
  too, unless the error is one a moment can clear (EIO, EAGAIN, EMFILE, ENFILE), which retries every job once;
  a `models.json` that is a link of any kind, dangling included, refuses every job, since the job's read-only
  mount does not resolve links the way the host does; so does one that is a named pipe, socket or device,
  never opened; a missing file, or a folder path that loops or runs
  through a file, is no overlay, as in the job; a file pi accepts is read) and at its provider composition (a model under a
  provider pi would not compose is unknown, and so is a builtin model of that provider, which would
  otherwise run without the overlay's endpoint), held to pi's own code at the pin by a differential test. A list the receiver dropped (version skew, or a stale single-file
  mount) is refused as `trigger-skew` when the worker can read the triggers file itself.
  The runner half covers every model call made in the job's runner process: the session's own turns,
  compaction and branch summaries, a model switched to mid-run, a second in-process session, an extension's
  direct model call (its `ctx.modelRegistry`, or pi-ai's legacy global functions), classifiers and image
  models. A virtual model is judged by the physical model each request is routed to. Matching is exact and
  case-sensitive on both the provider and the model id. A listed call is still refused when its request would
  name another model: a routing key (`model`, `modelId`, `models`, `fallbacks`, `providerOptions`) in samplingParams
  (any other samplingParams key passes under a list), a per-call Azure deployment, a caller's own `fetch`, or an
  Anthropic fallback (`compat.allowedFallbackModels`, sent with every anthropic-messages call) that is not itself on
  the list under the model's provider. A payload hook (an extension's `before_provider_request`, or a call's
  `onPayload`) is DENY BY DEFAULT: it may change only the top-level messages, system prompt and sampling settings,
  and any other change to the request, at any depth, refuses the call before it is sent (a field set to `undefined`
  counts as absent). A listed fallback that answers is logged.
  Out of scope, named as residuals in `DES-MODEL-POLICY-AT-THE-PROVIDER-WRAPPER`: code that reaches a provider
  around pi's model runtime, a listed model sent to another `baseUrl` (the egress proxy's job), and a `pi`
  subprocess.
- **Why**: An unknown model used to cost a container and a budget slot to discover (the runner asked pi,
  after both reserves, and exited 2). A model choice that is only a preference lets a cheap triage trigger
  chain a child on the deployment's dearest model, and a deployment that must never reach a model had no
  way to say so short of a separate deployment. The hazard is the SILENT half again: a list an old image
  ignores runs every model it forbids on a clean exit, so the image capability refuses first; a list the
  overlay could carry is one a model-callable tool could widen, so it is env-only. And a list that is only
  checked when a job starts is a preference: a flow can switch model, start a second session or call a model
  directly, and each would run, and bill, a model the operator ruled out, with a clean exit. So the runner
  checks where every call passes, and a runner that cannot enforce the list before each call refuses the job
  before any call (`model-policy-unenforceable`) rather than run it unenforced.
- **Traces to**: `DES-MODEL-POLICY-AT-THE-PROVIDER-WRAPPER`, `INT-TRIGGERS-FILE-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`,
  `INT-RUN-HISTORY-FILE-CONTRACT`, `INT-OUTBOX-CONTRACT`, `INT-MODEL-ENDPOINTS-FILE-CONTRACT`,
  `INT-RUNNER-EXIT-CODE-PROTOCOL`, `CONST-BUDGET-BEFORE-TOKENS`, `CONST-RETRY-INFRA-ONLY`
- **Acceptance**: Given a malformed, empty, oversized or duplicate-carrying `run.models`, or one that omits
  the trigger's own `run.provider`/`run.model`, the file refuses at load in every service. Given a trigger
  of any kind, cron included, whose own model or listed model the worker's gate would refuse (unknown, or a
  listed model whose fallbacks are unlisted), then `pi-dispatch doctor` warns, naming the trigger, the model and
  the reason; given the deployment's own default model or a `PI_ALLOWED_MODELS` entry the gate would refuse, then
  doctor warns once, naming the settings, since every job whose trigger names none is refused. Given a listed provider other than the main one for which neither the trigger's `run.secrets` nor
  `PI_FORWARD_ENV` (named and set) carries a variable pi reads for it, or that its overlay `apiKey` references,
  then doctor warns, naming the provider and the variables it looked for. Given an overlay `models.json`, then
  doctor asks pi's own loader (the pi-coding-agent installed beside the worker, and only when it is the worker's
  pinned pi; said when there is none or it is another version) whether it loads the file and which declared models it has, and warns on any answer the worker's
  catalog does not share. Given a job whose
  main model or a listed model is unknown, the job is refused `model-unknown` with no token minted, no clone
  and no reservation. Given `PI_ALLOWED_MODELS` without the deployment's default model, or a
  `dispatch_set model` that moves a trigger's default off its list, the job is refused `model-not-allowed`
  pre-spend, and the failure hook stays silent. Given an overlay `models.json` that cannot be read for a
  transient reason (EIO, EAGAIN, EMFILE, ENFILE), every job is retried once as infra, then failed, never
  refused, a job of builtin models only with no list included. Given one the worker cannot read for any other
  reason (EACCES or EPERM on the file or its folder, any errno not listed), every job is refused
  `model-unknown` pre-spend (`overlay-unreadable`), since pi in the job loads none of the file (the existence check in image/runner/run-job.mjs, or pi's own read, fails), and `doctor` says ✗ that every job is
  refused until the worker's user can read it. Given a `models.json` that is a link of any kind (an absolute or
  relative target, inside or outside the folder, or dangling), every job is refused `model-unknown` pre-spend
  (`overlay-link`), and `doctor` says ✗ to replace it with the file itself; the overlay folder itself may be a
  link. Given a `models.json` that is a named pipe, a socket or a device, every job is refused `model-unknown`
  pre-spend (`overlay-not-a-file`) without the worker or `doctor` opening it, so a pipe with no writer blocks
  neither, and `doctor` says ✗. Given any `overlay-*` refusal, its comment says the deployment's model settings file
  cannot be used, naming no path and no model, instead of the unknown-model sentence, and the run record carries
  the `why`. Given a `PI_GLOBAL_PI_DIR` that is not an absolute path, the worker refuses to boot naming the
  variable, and `doctor` says ✗. Given an overlay `models.json` pi would drop (a wrong-typed field anywhere, a block comment,
  a truncated write, a misnamed or misshapen `providers`, a UTF-16 save, an empty file) or one that is a
  directory, every job is refused `model-unknown` pre-spend, whichever models it runs or lists; given one pi
  accepts with comments or a BOM, the model is known. Given a trigger whose authored `run.models` the job
  arrived without, the job is refused `trigger-skew` pre-spend, also when the field was added after the job
  was queued (strict, because any later write of the file would otherwise defeat the check; the comment says
  to re-run it). Given an image or classifier model as the
  main model, the job is refused `model-unknown`. Given a job with a list on an image that does
  not declare `modelPolicy`, it is refused `job-image-model-policy-unsupported` pre-spend. Given a chained
  child of a listed parent, the child's data carries the parent's provider, model and list whatever the
  request file says. Given a job with a list whose models are served by declared model endpoints, it holds
  one slot of every such endpoint. Given no list anywhere, a trigger's job data and the container argv are
  byte-identical to before; an outbox child differs only by inheriting its parent's trigger provider and model.
  Given a list naming `anthropic/claude-fable-5` (the one builtin model with server-side fallbacks) without both
  `anthropic/claude-opus-4-8` and `anthropic/claude-opus-5`, the job is refused `model-not-allowed` pre-spend, its
  comment naming no model; with both listed it runs.
  Runner half: given a list without the job's model, on the image that declares `modelPolicy`, with a fake key
  and no network, the job exits `2` / `model-not-allowed` with `modelRefused: 1` and dials nothing. Given a list
  naming model A and not model B, each of `setModel(B)`, a second in-process session on B, an extension's
  `ctx.modelRegistry.streamSimple(B)` and a virtual router routing to B ends the job `2` / `model-not-allowed`
  with no call reaching B and no ledger row for it, while calls on A are admitted. Given a listed call whose
  samplingParams name another model (while `min_p` passes), or whose call option `onPayload` or session
  `before_provider_request` hook
  rewrites the model, nothing reaches the provider and the job ends `2` / `model-not-allowed`. Given a list and a
  cost cap, a call to an unlisted model is `model-not-allowed`, never `cost-cap`. Given a list on a runner that
  cannot enforce it before a call, the job is refused `model-policy-unenforceable` before any call. Given no
  list, the exit line is byte-identical to before.
  Per-model dollar windows (part 6): given a `scoped-limits.json` version 2 row `model:<provider>/<model>` with
  `dayUsd`, every job that may reach that model reserves its per-job cap in that model's window: a job with a
  list when the model is on it, and a job with NO list always, since it may switch to any model (fail closed).
  Given a window with room for one job, the second such job is refused `dollar-cap` pre-spend, its other
  dollar reservations given back. After a run, the window settles to that model's own cost from the exit line's
  usage ledger; it keeps at least its reservation when the ledger cannot say what the model spent (a folded
  ledger, spend on no model, no ledger, an untrusted exit line, or a job-wide floor). The record's
  `dollars.modelBasis` says which (`INT-RUN-HISTORY-FILE-CONTRACT`).

## REQ-GLOBAL-PI-OVERLAY

- **Statement**: An operator shall be able to reuse their existing host `pi` setup in every job. A single
  **global overlay dir** (`PI_GLOBAL_PI_DIR`, an absolute path: a relative value refuses the worker's boot,
  since it is resolved differently by the worker and the container runtime) is bind-mounted `/opt/pi-global:ro` into each
  container (both job kinds) and layered **UNDER** each repo's own `.pi/`: custom models (`models.json`) become resolvable,
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
  given either, over the admin extension, it is not copied. Given a loose `extensions/foo.js` (or `*.ts`, or a
  `sub/index.js`) in the overlay, it **loads** in a job, by pi's own discovery rule for `~/.pi/agent/extensions`
  (issue #544); given one that fails to load, the job runs without it and logs `extension_load_failed` naming
  it by its path inside `extensions/`, never its content or the error text; given a layout that loaded as a
  package before (an `extensions/skills/` subfolder, or a root `pi.extensions` glob), the job logs
  `overlay_extensions_layout` naming it.
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
  member is an allowlist proxy, reaching listed hosts by name and nothing else beyond this host, and a listed
  host only through a `CONNECT` tunnel to port 443 or a plain request to port 80 (issue #508); and a job
  whose policy cannot serve it shall be **refused before it spends**, with a reason naming what is wrong and no budget
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
  sandbox joins the same kind of network (`INT-SANDBOX-CONTRACT`), whether it is opened from the CLI or the
  admin panel, and is **not** preflighted, because it spends nothing. **On by default**, and deliberately not per trigger: there is no `run.network`, no
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
  half-work, and `PI_FORWARD_ENV` refuses those names at boot while it is armed. **And the runner restores the
  proxy after loading pi (issue #427)**: those measurements were of the SDK on its own, and the pinned pi's
  npm `undici` replaces the flag's dispatcher when it loads, so in the runner the call went direct and every
  egress-armed job died at its first turn. The runner re-installs an env-proxy dispatcher from pi's own
  `undici` once pi is loaded, before auth and any spend, whenever `NODE_USE_ENV_PROXY=1`.
- **What is checked pre-spend, and what deliberately is not.** One determinate host-side fact: the proxy is
  running. That is one `docker inspect` when armed and **zero spawns** when not. Reachability is **not**
  probed per job: it would convert a determinate gate into a flaky one, and a flaky pre-spend gate has no
  good class (as POLICY it drops real work on a blip, as INFRA it retries and burns the second slot this
  requirement exists to save), it doubles the container starts a deployment makes, and the only
  credential-free way to prove it is an unauthenticated request to a third party before every job.
  **Honest gap**: an allowlist missing a host the flows need is not pre-spend detectable, and that job pays
  the two slots. `doctor` proves the whole path once, when a human asks, using the job image's own node and
  its runner's own route to the network (pi loaded, then the runner's restore; issue #427) -- which also proves
  that image's runner module routes a request through the proxy, the property a stale one would silently lack.
  A plain `fetch` proved only the flag, and stayed green while every job failed. That the entrypoint actually
  calls the module, early enough, is proved in CI instead (the job image contract job runs it). On the native
  `podman` venue the same proof runs under the worker account's own Podman, where that venue's proxy is, from
  `doctor --live`, with its probe containers built as a podman job's (issue #431).
- **Traces to**: `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-BUDGET-BEFORE-TOKENS`, `CONST-RETRY-INFRA-ONLY`,
  `CONST-TOKEN-SCOPED-PER-JOB`, `INT-EGRESS-POLICY-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`,
  `INT-SANDBOX-CONTRACT`, `REQ-DEPLOYMENT-BOOTSTRAP`, `DES-EGRESS-DENY-ON-A-DEDICATED-NETWORK`,
  `OQ-004`, `OQ-011`
- **Acceptance**: Given `PI_EGRESS=0`, a job's docker argv and container env are byte-identical to ones
  built before this requirement existed and the preflight spawns nothing. Given any other accepted value and
  a running proxy, every job's argv carries `--network=pi-job-<jobId>-net` and its env carries all four proxy
  variables; a job reaching a listed host succeeds and one reaching an unlisted host is refused by the proxy
  rather than by the agent, as is one reaching a listed name that resolves to one of this host's fixed loopback
  or link-local addresses (issue #428), and a plain (untunnelled) request to a listed host on any port but 80
  (issue #508), while a request the proxy refuses as unlisted costs no DNS query at all,
  forward for a name or reverse for an IP literal; and the network is removed when the container exits, or, where a worker died
  before it could, by the next boot's reaper, which detaches what is still attached and otherwise names the
  network it could not remove in the log rather than leaving it silently forever (issue #357). Given a proxy that is
  absent or stopped, the job returns `outcome: "policy"` with `budgetReserved: false` and reason
  `egress-proxy-missing` or `egress-proxy-stopped`, `docker run` is never spawned, and the queue does not
  retry it. Given a daemon that does not answer, the job throws and IS retried. Given a configured
  deployment, `pi-dispatch doctor` reports the proxy's state and proves both directions of the policy, and that
  plain HTTP to a listed host off port 80 is refused (issue #508), without spending a token, and no check it emits
  carries a `fixAction`; on the `podman` venue `doctor --live` proves the same three under this account's Podman and
  spawns no `docker` command (issue #431). Given a declared model
  endpoint (issue #503, `INT-MODEL-ENDPOINTS-FILE-CONTRACT`) rendered by `pi-dispatch egress render` and the proxy
  reloaded with `squid -k reconfigure`, a CONNECT to exactly that host and port is allowed, a CONNECT to the same host
  on another port and a plain forward request to the declared port are refused, and a declared name that resolves to
  loopback is refused; given no declaration, the include is its header alone and the proxy's rules are those before
  #503. Given the include missing from a deployment folder, `up`, `service install` and `doctor` each name it and no
  proxy is started without it, since squid would not start. Given a declared endpoint under rules that include it,
  `doctor` proves it through the proxy (on the `podman` venue `doctor --live`): a `GET /v1/models` by the runner's
  tunnelled route answers 200, a CONNECT to the next port gets the proxy's 403, and a plain forward request to the
  declared port gets squid's 403, each line naming the endpoint id and the proxy's status; it fails an include
  inside the running proxy that differs from the declaration's render, and a route from the proxy that the measured
  table refutes on this runtime; it warns on an overlay model whose baseUrl is loopback and on an allowlist naming
  a host alias (`INT-MODEL-ENDPOINTS-FILE-CONTRACT`). Given no declaration, `doctor` prints and runs exactly what it
  did before. Given a declared endpoint with `slots: 2` serving the main model of three concurrent jobs, local or
  forge, the third is deferred before any spend, never refused, and runs when a slot frees, across every host that declares a worker name and the same id for it (per host
  without one, and per host always for a `host.docker.internal` or `host.containers.internal` host, which names a
  different server on each machine; every address, link-local included, is shared); given no
  declared endpoint, no slot is taken and the job's argv and record are unchanged. Given a job whose main provider is
  one pi does not know, defined in the overlay `models.json` with `"apiKey": "$PI_DISPATCH_KEYLESS"`, with at least one
  model, and every one of its models served by a declared endpoint marked `"keyless": true`, the free credential gate
  passes with no credential and the container env carries `PI_DISPATCH_KEYLESS=keyless`; one model off every declared
  endpoint, an endpoint not marked keyless, any other `apiKey`, or a provider pi knows is refused or keyed exactly as
  before, before any spend, and the refusal names both ways in (a key, or a keyless endpoint). With `PI_EGRESS=0` such
  a job dials its endpoint directly and its argv gains no `--add-host` and no network.

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
- **Fail OPEN, and say so.** A missing, expired, oversized, unparseable, locked or foreign transcript, one
  written in another venue, one holding a compaction with an empty summary, one whose key directory in
  the store is not a directory at all, a
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
- **A transcript SWAPPED under a reader cold-starts.** The read and the copy are not under the promotion
  lock, so a promotion can land between them. The copy is re-checked against the identity the gates judged
  (`INT-SESSION-STORE-CONTRACT`), and a job that would otherwise resume a transcript no gate has seen runs
  cold with `transcript-replaced` instead. It is a SWAP that is caught, which is what a promotion performs:
  a rewrite in place that restored the file's size and mtime would not be, and that bound is stated in the
  contract rather than implied here. Fail-open, like every other eligibility arm: one cold start, and
  the next run resumes.
- **One writer per key, and a dead writer does not keep it.** Promotion takes an exclusive per-key lock; a
  job that cannot take it runs cold with no persistence, never queued and never failed. A lock older than
  any plausible promotion is a crashed writer's and is taken over, so a promotion killed inside the lock
  costs the key one run rather than every future run on it until an operator removes a file by hand. Two jobs on one pull request inside one runtime is
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
  lets the lineage start again. Given a transcript holding a compaction whose summary is empty, the job
  runs cold with `compaction-summary-empty` and never resumes without that summary. Given every bound
  unset, the read path stages the same file and the
  container is handed the same mount set as a pre-bounds run. Two things are deliberately NOT identical: a
  completed promotion also writes the chain counter, so that setting a bound later is honest immediately
  rather than N runs later; a run whose host gate refused records the gate's own token where it used to
  record the container's `absent`; and a completed promotion also stamps the venue beside the transcript.
  Given a promotion by another job on the SAME venue landing between this job's gate read and its copy, the
  job cold-starts with `transcript-replaced` and the staged file is 0 bytes, while a transcript nothing
  touched still resumes. Given a key whose directory in the store is a symlink, a regular file or a
  dangling link, the job cold-starts with `key-not-a-directory`, a completed run promotes nothing, and
  what stands at that name is left untouched rather than swept. Given a trigger moved from one venue to
  another, its next job cold-starts with `venue-changed` and never stages the transcript the other venue
  wrote; given a key promoted before venues were recorded, it resumes for a job resolving to `local` and for
  no other venue.

## REQ-RESURRECTABLE-SANDBOX

- **Statement**: A finished run's per-job directory shall be retained for a bounded window, and
  `pi-dispatch sandbox <jobId>` shall start a **new** container from that run's image with that run's
  mounts as an interactive operator shell holding **no credentials**. The job container is unchanged:
  still `--rm`, still no TTY, still no published port. With the window at `0` nothing is retained and
  teardown is the `rm -rf` it always was.
- **Scope**: Every job kind. A forge job's clone travels with its directory; a local job's workspace is
  the operator's own folder and is never moved, so only its `/job` inputs and `/outbox` are retained.
  Available from the CLI and from the admin panel's RUN_DETAIL screen, and from either only for a run whose
  venue this host holds (issue #277); never from a trigger, an `/outbox` chain request, or a model tool.
- **Why**: Perhaps 5% of runs end on a question the run record cannot answer — *does the thing it built
  actually work?* Three separate facts make that unanswerable today: `--rm` disposes the container at
  exit, stdin is `ignore`, or on an `exitAuth` image a pipe the worker closes after one key line, and never a TTY, so nothing can be typed into a live run either, and for a forge
  job `cleanup` deletes the directory the clone lives in. The first two are load-bearing and must not
  move; only the third is incidental. So the container is not kept alive — it is made reproducible, and
  the *only* thing that had to change is how long its inputs survive it.
- **What is NOT preserved, and the contract says so.** Process state and every filesystem change outside
  `/workspace`. Same image plus same workspace, fresh processes. That covers "start the app and click
  through it"; anything a run installed outside the workspace belongs in the image. A `docker commit`
  snapshot would preserve more and is rejected in `DES-SANDBOX-IS-A-FRESH-CONTAINER` — gigabytes per run
  to serve a case image+workspace already serves.
- **No credential, and it is not a knob.** No minted forge token, no provider key, no forwarded host
  variable; the container env is `TERM` and `TMOUT` (plus the proxy variables when egress is armed, and
  `HOME=/home/pi` beside `--user` when the run had a job user, issue #341). `buildContainerEnv` is deliberately
  not reused: it writes the mint into that forge's variable names and throws when no provider credential resolves,
  so a credential-free container cannot be produced from it. An operator who needs to push authenticates
  themselves inside the shell.
- **Bounded, and swept like every other artifact.** `PI_SANDBOX_RETENTION_HOURS` (default 24) with a
  sweep at boot and then every `PI_SWEEP_INTERVAL_HOURS` while the worker runs (`0` = boot-only), `--pin`
  extending ONE run to `now + PI_SANDBOX_PIN_DAYS`. **The window bounds the run's session NETWORK as well
  as its directory** (issue #337): the same sweep removes a `pi-sandbox-<id>-net` whose id is absent from
  the retained directories (both the listing that pass began with and a fresh one), is not running, carries
  no `pi-sandbox-` container, and has no container of its own in any state but `exited` or `dead`. That last
  condition is not redundant and `INT-SANDBOX-CONTRACT` carries the measurement: a container mid-launch is
  invisible to every other check, and removing its network leaves it unable to start at all. Until
  then the network is retained with the directory, because a retained run is re-openable and an open is what
  the network is for. It outlives the directory by one pass: the pass that deletes a directory still counts
  that run as retained, so the network goes on the pass after. A pin is a timestamp, never a
  boolean: there is no keep-forever value, because a repository clone per run with no ceiling is
  unbounded growth wearing a feature's clothing. `0` means the feature is OFF (the OPPOSITE of
  `PI_LOG_RETENTION_DAYS` and `PI_SESSIONS_TTL_DAYS`, where `0` means keep forever), and nothing new is
  retained from then on, and it sweeps what an earlier setting retained, so turning it off turns it off; a
  lowered window likewise applies to runs already retained. Since issue #446 the worker also writes each run's
  deadline into its manifest (`retainUntil`), and an unpinned run ends at the EARLIER of that and `createdAt` plus
  the current window, so a reader with a longer window than the worker's (the panel) ends it where the worker
  does, and raising the window does not extend a run already retained. **A run at the end of its window opens
  only with `--pin`**, whose deadline is written before anything starts; the one open this cannot refuse (a worker
  window lowered below the opener's) is held by the sweep's re-ask of the run's runtime, and otherwise reported:
  removed as swept when the session starts, or said when the shell exits and never removed once the operator may
  have work in it (`INT-SANDBOX-CONTRACT`).
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
  `capsh --print` shows no capabilities. Given `PI_EGRESS=0` and `--publish 3000`, the port is reachable at `127.0.0.1`;
  given the armed default, `--publish` is REFUSED before anything is created, naming `PI_EGRESS=0` as the
  opt-out, because a container joined only to an `--internal` network publishes nothing while docker still
  accepts `-p` and exits 0
  An explicit non-loopback bind is refused in both postures, which is a property of the flag rather than of
  the policy. Given a worker restart while a sandbox runs, the
  container survives (`docker ps --filter name=pi-job-` never matches it) and its directory is not
  swept. Given a run whose window has closed, the refusal names the window, and once the sweep AFTER the one
  that removed its directory has run, `docker network ls` no longer lists that run's session network; given
  a run whose container exists but has never started, that network is kept and the worker log names it. Given a job that persisted a
  session, no transcript exists anywhere under the retention root. Given a run whose manifest names a venue
  the sandbox has no launcher for (any but `local` and `podman`), or one the opener's own `PI_BACKENDS` does not
  bless, both the CLI and the panel refuse to open it, naming the venue, and `--list` does not show it as
  re-openable; given a run retained before venues were recorded, it opens as a `local` run does. Given a `podman`
  run on a host whose `PI_BACKENDS` names podman, it opens through the `podman` CLI and nothing else, as the
  opening account's uid under `--userns=keep-id` (issue #429). Given a run past the deadline its manifest records,
  or within five minutes of it, `pi-dispatch sandbox <jobId>` is refused naming `--pin`, also from a shell whose
  own `PI_SANDBOX_RETENTION_HOURS` is larger than the worker's, and the panel does not offer `b` for it; with
  `--pin` it opens, the pin on disk before any container runtime is asked, and a pin that cannot be written
  refuses the open. Given a worker whose window is lowered or set to `0`, unpinned runs retained under the longer
  window are swept on the next pass. Given a pin fired while the sweep is deleting a large retained run, the pin reports the run
  gone, never pinned; given a worker killed between the sweep's rename and its delete, the next pass removes the
  leftover; given a retained run holding files the worker cannot delete, it is no longer re-openable and
  `pi-dispatch doctor` names it (issue #446).

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
  or the closed map's own `PI_*`/`PLAYWRIGHT_*`), when a key is one **pi or its provider SDK reads to
  configure a provider** (`PROVIDER_STEERING_VARS`, issue #314: derived from the pinned artifacts, with
  two named exceptions pinned by tests, the scan-unreachable residuals and, since issue #509,
  `ANTHROPIC_AUTH_TOKEN` retained after pi made it a key variable; since issue #511 the derivation reads
  both copies of pi-ai two dependency hops deep, reserves every name it finds by EXACT match, lowercase
  twins such as `google_application_credentials` included, and adds pi's own `PI_*` reads such as
  `PI_CODING_AGENT_DIR`, minus the names the worker and the runner write), when `run.secretsProfile` names nothing
  resolvable, and
  when `run.secrets` appears beside `run.resume: true`. **Pre-spend, per delivery**, the job is refused with
  `budgetReserved: false`, no token minted and no clone, as `secret-profile-unknown` when no declared profile
  matches or its resolver is absent, not executable or outside `PI_SECRET_RESOLVER_ROOTS`; as
  `secret-profile-ambiguous` when one name is declared in both the environment and the overlay; as
  `secret-name-reserved` when a key is one the loader refuses at load (issue #511: a job queued before the
  set widened, a stored scheduler template or an older receiver never passed the current validator), or
  collides with **any variable pi reads the resolved
  provider's key from, set on this host or not** (issue #309: the presence-filtered form reserved
  nothing whenever the credential came from pi's `auth.json`, which is the default fallback) or a
  `PI_FORWARD_ENV` name; and as `secret-unresolved` when the resolver exits 2, returns nothing, overruns the
  size cap or returns a value containing a NUL. A resolver that exits 1, exits with an unrecognised code, or
  times out is INFRASTRUCTURE and the job is retried as `secret-resolver-unreachable`. A refusal names the
  field or the variable and never the reference, the resolver's path or its standard error. The whole job
  refuses rather than injecting a partial set. A resurrected sandbox carries no secret (its env is `TERM`,
  `TMOUT`, the proxy variables and, beside `--user`, `HOME`), and `doctor` fails when a trigger names a profile
  no deployment entry declares.

## REQ-DEPLOYMENT-BOOTSTRAP

- **Statement**: The CLI shall take a fresh machine to a preflighted deployment through **create-only
  scaffolds and per-action consented host mutations** — `pi-dispatch init` (scaffold), `pi-dispatch
  doctor [--fix] [--live]` (preflight; offered fixes; the backend declarations read back off short-lived real
  containers), `pi-dispatch up [--yes]` (the consented sequence: default-image pull+tag, loopback Valkey start,
  scaffold, preflight) — and shall never perform an unshown host mutation, never touch an existing config
  value, and never spend a token. **On the native `podman` venue** (issue #430) the same sequence puts the image
  into the account's own Podman store and starts Valkey, the egress proxy and (while the policy is armed) the proxy's
  rootless network keeper (issue #458) as Quadlet units through the installer
  `service install` uses, shown line for line before consent, and runs no docker command at all when `PI_BACKENDS`
  does not list `local` (`DES-PODMAN-STACK-AS-QUADLET-UNITS`). On either venue the image step checks only the image
  the worker will run (issue #523): `PI_JOB_IMAGE` by the worker's own rule (`||` to `pi-job:latest`, then the image
  rule), from this shell where it sets it and otherwise from `.env` (doctor's resolver). Unset, that is the default,
  pulled from `ghcr.io/edgehero/pi-job:latest` and tagged `pi-job:latest` when absent; set, it is that name, left
  alone when present and, when absent, pulled under that name with no tag only if the name is registry-qualified (its
  first path segment holds a `.` or a `:`, or is `localhost`, as the docker reference grammar reads it): an absent
  short name is never pulled, under `--yes` too, since the runtime would resolve it on a public registry where anyone
  may publish it, nor a `localhost/` name, a locally built one with no registry behind it, and `up` says how to
  provide it instead; and where `up` cannot tell (the two mean different images,
  a line is one the loader reads differently, the file cannot be read, or the worker refuses the value) it checks and
  pulls nothing and says why. The image it checked is named in its output, and a value only this shell sets is said
  to be one an installed service, which reads `.env`, does not run. doctor's fix line for a missing job image, on
  either venue, is the same text (`jobImageFix`): the default's pull and tag, a qualified name's own pull, or for a
  short or `localhost/` name how to build or tag it, under a lead-in that says build or load, never pull. `up` reads `PI_BACKENDS`, `PI_EGRESS` and
  `PI_EGRESS_PROXY` from this shell where it sets them and otherwise from the deployment's `.env`, the file
  `service install` reads, refuses when the two set one differently, and never replaces a container it did not
  start without showing that it does and asking: on the podman venue not at all, and on the docker venue only the
  shipped proxy's name, as below (issue #453). On the docker venue `up` counts the egress proxy as present only while
  it is RUNNING (`{{.State.Status}}` is `running`, which a paused or crash-looping container is not) and CURRENT (the
  pinned squid with its own entrypoint and command, with this deployment folder's `deploy/egress-proxy.conf` and
  `egress-allowlist.conf` mounted and no other mount but the image's volumes; mounts whose sources do not resolve on
  this host are unknown, said, and never a reason to replace it, though a proxy whose image, entrypoint or command
  differs is still offered the replace while one is unknown; how Docker Desktop reports those three fields is not
  measured). A current shipped proxy that is stopped is offered `docker start` of that same container (a paused one
  `docker unpause`), never a `docker run` on its taken name; a stale one, running or not, is offered `docker rm -f`
  and the shipped run, every line shown before consent and each one a command (the network's create is shown only when
  that network is missing, a read-only inspect deciding it first; the one exception is at run time, where a network
  removed while the question waited is created anyway, under `--yes` too, and announced with its command before it
  runs, since the shipped run cannot start without it), with the job networks the removal would cut off
  named, and `--yes` never covering the removal of a RUNNING proxy that job networks are attached to (the lines are
  printed and a person must answer); a container `PI_EGRESS_PROXY` names is the operator's, reported and never
  started. Neither is offered from a folder that lacks either file, which a start would mount as a
  directory. **`init` and `doctor` decide the venue as `up` does** (issue #453): this shell where it sets a venue key,
  else the deployment's `.env` read as `service install` reads it, and a disagreement between the two is said
  (doctor's ✗; init shows no steps). `init`'s next steps follow that venue: with podman the only venue, on Linux,
  the podman ladder (linger named first, then the job image into this account's store, `.env`, `up`, `doctor`,
  `service install`, `doctor --live`); off Linux a line saying the venue refuses the host; otherwise the docker text,
  whose steps name no file the folder `init` leaves does not have (issue #480: its step 2 is `pi-dispatch up`, which
  starts Valkey and the egress proxy, where it was a compose command naming a `deploy/docker-compose.yml` only a clone
  carries). They are printed text: `init` still runs nothing and remains create-only. **`init` scaffolds
  `deploy/egress-proxy.conf`** (issue #480), the package's own copy byte for byte, create-only like every other file it
  writes, so a folder made without a clone holds both files the docker proxy mounts and `up` starts that proxy there.
  `up` runs `init` with its file list and without its next steps, since `up` is that ladder.
  **That copy goes stale on an upgrade, and is said to** (issue #484): `init` never rewrites it, so `doctor` compares
  it with the installed package's file and warns when they differ (⚠, naming the file, `diff` and the refresh; silent
  when identical or absent; the shipped proxy only, the policy armed), and does the same for the podman venue's
  account-owned copy, whose refresh is `service install --force`. `up` offers to replace a differing folder copy,
  shown and asked, and `--yes` does NOT accept it (every other action `--yes` accepts creates, starts or replaces
  something this project made; this file may hold the operator's own edit, which nothing can tell from an old
  version's): the old bytes are kept as `deploy/egress-proxy.conf.bak-<UTC stamp>`, the new file is written beside
  it and renamed over it, a copy or a `deploy/` that is a symlink is refused with nothing written, and a declined
  offer changes nothing. The refresh runs before the proxy step, so a proxy started or replaced there reads it; a
  running current proxy is offered `docker restart` (squid reads its rules only at start), a paused one `docker
  unpause` then `docker restart` (an unpause alone resumes it on the old file), which `--yes` accepts unless job
  networks are attached to it.
  `up` also refuses, as `service install` and the setup wizard do, a `.env` that spells a venue key where a
  loader could read it and has a line systemd's `EnvironmentFile=` splits differently from its reader (issue #447):
  a lone CR, a quote reopened after a value's closing quote, a quoted value under a key that is not a variable name,
  a trailing backslash the reader does not see as a continuation, or a quoted value whose extent the reader's model
  gets wrong; any `.env` systemd will not load (a NUL, or a key or value that is not valid UTF-8 or holds a Unicode
  noncharacter, or an environment too large for systemd to exec the service with), read from its bytes; and a
  venue-key value over 4096 bytes, the project's own cap. The refusal names the line, what systemd does with it and
  what to change, and comes before anything is written. Every `.env` key `up` or the wizard writes is read back
  from the new text first and is not written where the service's loader would not read it as written, and a key
  that loader already reads as set is never overwritten: where the loader is a sourcing shell, a file with a line
  that shell reads differently is not edited at all, and on Linux a key only a shell reads (an `export` line) is
  named with its line rather than reported as set.
  **`up` also fills EMPTY keys in an existing `.env`** (issue #357), which
  is the one mutation it makes without a prompt and is bounded to exactly that: the file must already
  exist, so `init`'s create-only rule is untouched; a key with any value is left alone, so "never touch an
  existing config value" holds key by key; and no value it writes is a capability, a credential or a
  policy. Today that is `WEBHOOK_SECRET` and the four paths four shipped files have promised for a year
  (`PI_PAUSE_WINDOWS_FILE`, `PI_SCOPED_LIMITS_FILE`, `PI_LOGS_DIR`, `PI_SETTINGS_FILE`), plus `PI_PROJECTS_FILE`
  since issue #499. The first two and the projects key get
  this folder, which is where `init` scaffolds them and where the panel looks; the last two get what the
  account default RESOLVES to, and a value this shell exported that is relative or inside the deployment
  folder is refused rather than written, because `makeLogReaper` unlinks every `.log` and
  `.json` in `PI_LOGS_DIR` past the window with no name shape and no ownership check, so a deployment
  folder there would eat `triggers.json` and its siblings a month in, silently. Writing the default makes
  the value explicit rather than changing it, which is the whole point: a worker under another `User=` and
  the panel can no longer resolve two different directories without anyone saying so. **Both durable keys
  resolve `env` first**, so a value this shell exports passes through, and `up` therefore REFUSES to write
  one THIS SHELL SUPPLIED that is relative or inside the deployment folder, and says where it came from. A
  relative value is the sharper of the two: it resolves against the unit's `WorkingDirectory`, which is that
  folder, and all three deploy templates document the key as absolute for exactly that reason. The refusal
  lives in `up` rather than in the resolver, because the worker SHOULD honour an exported path at run time;
  what must not happen is `up` copying one into config that outlives the shell that set it. It is scoped to
  a shell-supplied value both ways: a COMPUTED default that sits under the folder (a deployment folder that
  is the service account's home makes `<home>/.pi-dispatch/logs` "inside" it) is the path the worker
  resolves anyway and is written without comment. **A value is rendered so that every loader of this file reads
  it back**, and there are THREE with different rules, which is what makes this a contract rather than a
  formatting choice. Bare is split at a space and truncated at a `#` by the shells the wrapper scripts use;
  a double-quoted `$` is expanded there; single quotes are exact for them and for systemd's
  `EnvironmentFile=`. `deploy/worker-env-wrapper.cmd` is the third and says so in its own header: cmd's
  `set` keeps surrounding quotes as part of the value, so NOTHING is ever quoted for it and its bare set
  is derived from that loader rather than borrowed from the POSIX one. That loader is the quoted
  `set "%%A=%%B"` form, which preserves spaces exactly, so a space is fine there and reusing the POSIX
  predicate would have refused every key on `C:\Program Files\...`. What it cannot be shown to carry is
  refused rather than written (issue #470): a line break or another control character, a double quote, `%`,
  `!` (delayed expansion, on whenever the registry says so), `^`, a character outside ASCII (for /f decodes
  the file in the console code page) and an `=` at the start of the value (for /f drops it), and an empty
  value, which `set` turns into removing the key. On Windows the writer also judges the FILE as the wrapper
  reads it and refuses, naming the line, one that names the key other than as a plain `KEY=` line (a
  different case, which `set` ignores; an indent or a blank before the `=`, which for /f keeps in the name; a
  bare `KEY`, which removes it; a leading `=`, which for /f skips) and bytes or names it cannot vouch for. Windows paths are written with forward slashes, which Node accepts and which
  also keeps them readable by the POSIX shells if that file is ever shared. **The rule is derived inside
  the writer rather than passed by each caller**, because the first version took it as an argument, `up`
  passed it and `pi-dispatch setup github` did not, so a PEM path was quoted on Windows and the cmd
  wrapper kept the quotes: a rendering rule every writer must remember is one that a writer will forget. So is one carrying a single quote on any platform: the shells want `'\''` and systemd does not
  understand it, so no one rendering serves both. **The writer also refuses a `.env` it would hand to
  another account or group** (issue #522), because it replaces the file with a new one renamed over it: one owned by
  another uid is refused, and so is one whose group the new file would not have. That group is MEASURED on the new
  file, never predicted from this process's: a folder gives new files its own group on macOS (and on Linux when it is
  setgid), so a `.env` that `init` made in a `wheel` folder is written, and where the groups differ the new file is
  given the old group wherever this account is in it. Each refusal says its own fix: for the group, the group's name,
  adding this account to it (and logging in again), or `chgrp` to this account's group where nothing reads the file
  through the present one; running as another account is no fix, since any other account meets the owner refusal
  first. The advice about a value (set it by hand, or a path without that character) follows only a refused value.
  The new file (`.env.tmp`) is created by the writer exclusively at 0600, never through a link, and given its group
  and mode through its descriptor; one that already exists, left over or planted by another account that can write
  the folder, is refused and left alone. The writer's own new file is removed on every failure after its create (a refusal, a flush or a rename that throws), so it never blocks the next edit, and where it cannot be removed the error names where it was left. **`doctor --live` adds a mutation that is shown rather than consented**
  (issue #278), beside the throwaway network and probe containers plain `doctor`'s egress canary already
  makes and removes unprompted -- and which, since issue #350, also cover **what an EARLIER canary left
  behind**. **THE RULE, rather than a list of ways it happens** (issue #379, item 4): every canary object is
  removed in that run's own `finally` OR reported in the same run, and the next run sweeps only what a run
  that was KILLED left behind. Naming the producers instead was a list nothing derived and a third producer
  would not have failed anything; this is a property the code holds. Making it true cost one repair: the
  `finally`'s `rm -f` of a probe that would not go dropped its result, so that probe went unnamed until the
  next run swept it, and it is now reported immediately in the same words the sweep would use. Reported on
  the next run and named in a line saying what went: still the
  canary's own objects, named after the doctor PROCESS, touched only for a pid no longer alive and only on a
  daemon this host owns, so it is the same unprompted tier rather than a new one: typing the flag is the
  approval, as it is for `sandbox`; on the `podman` venue the egress canary is one of the things `--live` runs
  (issue #431), under the same rule, its network and probe containers named before any exists; its containers, the peer
  networks it makes when the egress policy is armed, and its fixture directory are named before any exists; and
  all are removed when the read ends, or by the next `--live` when that run was interrupted, which names what it
  removed (`INT-LIVE-PROBE-CONTRACT`). Nothing else reaches it: not `up`, not `--fix`, not the panel.
- **`doctor` reads the deployment's `.env` for two named keys, to decide what to say AND whether to fail**
  (issues #357 and #384), **and, since issue #453, for the three venue keys `up` and `service install` already read**
  (`PI_BACKENDS`, `PI_EGRESS`, `PI_EGRESS_PROXY`, through the same `readStackKeys` and the same shell-wins,
  disagreement-is-a-✗ rule as `up`), **and for the service's own `VALKEY_URL`, `PI_PROVIDER` and the provider's key**
  (its presence, and whether it is whitespace or an OAuth token; never its value), **and, since PR #466's gate round
  2, for `GITHUB_AUTH_SOURCE` and the four `GITHUB_APP_*` keys** (the ids, printed as before, and the key's path or
  inline value, judged for presence and a PEM header only, never printed), so the app-auth ✗ lines judge the file the
  worker loads, **and, since issue #464, its `PI_JOBS_DIR` and `PI_SANDBOX_DIR`** (whose owner the jobs dir check
  judges), **and, since issue #471, every other key the worker or the receiver reads that doctor judges**
  (`WORKER_SERVICE_KEYS`, `RECEIVER_SERVICE_KEYS`: the job image, the triggers file, the logs and settings paths, the
  session store and its bounds, the overlay and its extensions knob, the forwarded names, the backend floor, the
  secret and wait profiles, the retention window, the PAT variable and the PAT it names, and the forge and receiver
  settings), each taken from a plain line with
  the service's loader only where this shell does not set it, and each said with its source. **Since issue #481 an EMPTY value is left
  off a line that says the file set a key only where every reader of that key is PROVEN to take empty as unset**
  (`EMPTY_READ_AS_UNSET`, an allowlist, some entries also covering a whitespace-only value where the reader trims): a
  worker or receiver key only where the real loaders (`loadConfig`, `loadReceiverConfig`) answer the same for it empty
  as absent, which a test checks per key and per value shape, and a CLI key only where its tool's cited source compares
  with the empty string (docker's `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`; gh's `GH_TOKEN`, `GITHUB_TOKEN`,
  `GH_HOST`, `GH_CONFIG_DIR`; Podman's `CONTAINERS_CONF` and `CONTAINERS_CONF_OVERRIDE`). Every other empty key is
  still named, because its empty value is a value somewhere (`GITLAB_URL` becomes the API base, `CONTAINER_HOST` sends
  podman remote, an empty `HOME` is the home `os.homedir()` returns). The rule decides the settings line and its GitHub
  auth twin (so the empty optional keys `init` scaffolds from `.env.example` are not listed), the venue keys line, the
  ⚠ on each CLI variable the file sets, and whether the closing line says doctor took a value from the file. Three
  boot refusals doctor had passed in silence are each a ✗ of their own: a `GITHUB_AUTH_SOURCE` that is empty or none of
  `pat`, `gh` and `app` (its value shown only when short and plain), `GITHUB_AUTH_SOURCE=pat` with its PAT unset, empty
  or whitespace, or with `GITHUB_PAT_VAR` empty, and a `PI_TRIGGERS_FILE` that is set, empty included, and names no
  file; the worker and the receiver both refuse to start on each (exit 2), while an unset `PI_TRIGGERS_FILE` keeps each
  process's own default. A credential those presence checks find missing from this shell and the `.env` (the PAT, the
  App ids and key, the provider key) is a ⚠ naming the `--env-setup` script, rather than a ✗, ONLY where every service
  installed for this folder that reads it (the worker's unit, plist or nssm service for a worker credential, and the
  receiver's too for one both read) names a USABLE script (a regular file, after symlinks, this account can read), and
  the worker's service is installed: what that script exports is invisible to doctor by design. `PI_ENV_SETUP` in
  doctor's own shell softens nothing, since the service does not run what this shell names; where it is set and no
  such service names a script, the ✗ stands and its fix line says to install with `pi-dispatch service install
  --env-setup <that script>`. Where doctor finds no service installed for this folder at all it cannot tell, so the ✗
  stands and its fix line says an `--env-setup` deployment may ignore it. The same rule decides the empty or unloadable
  `PI_PAUSE_WINDOWS_FILE` and `PI_SCOPED_LIMITS_FILE` downgrade, which CHANGES what that downgrade did before: it read
  this shell's `PI_ENV_SETUP`, so a deployment whose unit names no script passed doctor and then refused to boot. Where
  doctor accepted a credential as expected from the worker service's script, its closing ready line points at the
  service, which runs that script, and says a worker started by hand runs none. **Since issue #471 each
  is RESOLVED ONCE** (`resolveServiceEnv`, one module shared with the admin panel) and every check judges that
  resolution: a bolt test fails when doctor reads a service key from its own environment anywhere else. A key this
  shell and the file set DIFFERENTLY is a ✗ naming both values (a credential by name only, a URL without its
  credentials) and doctor judges this shell's, since it cannot tell a service, which never sees its shell, from a
  worker started by hand from that shell; a line the loaders read differently is a ✗ naming the line, its value
  unused. A worker started by hand (`pi-dispatch worker`) reads its shell and no `.env`, so where doctor took any value
  from the file its closing "ready" line names the worker that reads it, the service, by the command that starts it
  (`pi-dispatch service install`; for one installed for the folder, `pi-dispatch service restart` for a user unit and
  the root command itself for a system one, `sudo systemctl restart <unit>` or `sudo launchctl kickstart -k
  system/<label>`, since `service restart` drives only a user unit; on Windows, where the nssm service has no file to
  read, both commands), and says a hand-started worker runs without those values unless its shell exports them; where
  it took none, the line still says `pi-dispatch worker` (issue #477). A `VALKEY_URL` whose path is not a database
  number (`/abc`; leading zeros are the number they spell, so `/01` stays database 1), or whose scheme is not `redis:`
  or `rediss:` or their aliases `valkey:` and `valkeys:` (`unix:` had dialled 127.0.0.1), is a ✗ of its own, and doctor contacts no Valkey; every client refuses
  it where it is made, so the worker, the receiver and each CLI verb refuse it at start (the worker with exit 2) rather
  than dying on an unhandled rejection. **A database the server does not have** (`/16` on a default Valkey) is refused
  the same way, never used as database 0: ioredis applied it with a SELECT whose failure it only reported, and every
  client then went on on database 0, possibly another deployment's queue (measured). Every client stops on that failure
  before it goes ready, the start judgements and doctor name the index and the server's `databases` count, and the
  panel's reads fail open with the sentence (PR #478's gate rounds 1 and 2). A value that steers what doctor spawns, connects to or writes is judged as the worker judges it before
  doctor follows it (`STEERING_SERVICE_KEYS`): `PI_JOB_IMAGE` by the worker's `||` default and its `run.image`
  refusals (a blank, padded, dash-leading or control-character value is named and never handed to a runtime),
  `VALKEY_URL` by the owner rule, the PAT the in-image probe carries by the worker's own lookup, and a session store
  named only in `.env` is offered at the prompt tier rather than created silently. **Since PR #474's round cap no program
  doctor starts is handed anything from `.env`**: every child runs with this shell's own environment, as before #471.
  The CLI variables the service's own podman, docker and gh read from `.env` (`CLI_SERVICE_KEYS`) are resolved, and a
  disagreement on one is said, but each the file sets is a ⚠ naming it (its value only when it is a path, escaped):
  doctor's probes through that CLI describe this shell's view, not the service's. Where the service's setting decides
  an IN-PROCESS judgement, the file's value is used: the containers.conf chain check reads the chain
  `CONTAINERS_CONF`, `CONTAINERS_CONF_OVERRIDE` and `XDG_CONFIG_HOME` select, as the worker does, and fails on one the
  worker refuses; so do #448's rootful Podman readers (`observeHost`, `observeRootfulConf`), whose chain also takes
  the service's `HOME`, itself a CLI variable here, named like the rest when the file sets it. A PAT, or the `GITHUB_PAT_VAR` naming it, only the file holds means the in-image probe is not run,
  and is said. Three rounds of rules for handing these on safely (trust by owner and mode, then by resolved path and
  endpoint) each left a hole; this rule has none to leave. A relative `PI_TRIGGERS_FILE` is the deployment folder's,
  as the worker's read resolves it; the operator's pi setup the overlay is compared with stays this shell's, the one
  `import-pi` stages from. `PI_ENV_SETUP`, `XDG_DATA_HOME` and `DOCKER_CONTENT_TRUST` stay this shell's on purpose
  (`DOCTOR_SHELL_KEYS`). The worker refuses to boot (exit 2) on a `PI_JOB_IMAGE` its image rule refuses, the rule
  `run.image` has, and `pi-dispatch run --image` and a queued job's image are held to it too. **Doctor takes NO value
  from a `.env` another account can change** (PR #474's gate rounds 1 and 2): the file is opened once and judged by
  `fstat` of that descriptor, and it, its folder, its real folder and every directory above them must be this
  account's or root's and writable by nobody else (a root-owned sticky directory is the one exception); otherwise
  doctor fails naming the owner, mode and, for a group-writable one, its group, truthfully for a user-private group,
  and judges this shell's values. Where a worker unit is installed for the folder, the service keys only this shell
  sets are named, never their values, since the service runs without them. The residual is stated, not closed: a
  deployment folder is trusted exactly as far as the service trusts it, so the job image this account's own `.env`
  names is run by doctor's canary and probes, in containers pinned as a job's are, as the service runs it. Every such key passes
  ONE structural allowlist (`SERVICE_ENV_KEYS` plus pi's own key names for the provider) and one platform-to-loader
  mapping, beside the two-key `ENV_FILE_READABLE_KEYS`; unlike those two, these values STEER doctor: which venue it
  judges and so which runtime it spawns, which Valkey it connects to, and which fixes it offers. A URL doctor prints
  is printed as scheme, host, port and database only (`<no host>` without one, `<unparseable URL>` when it does not
  parse), and the fleet host names a chosen Valkey returns are printed with C0 and C1 controls blanked. That widening is the review this paragraph asks for: without it the plain `doctor` a podman-only
  deployment's own ladder runs judged docker while its service ran podman, and reported "✗ Provider key set" and the
  default Valkey URL for a deployment whose `.env` held both (both measured). The file is read once per run, a
  regular file only; one that is there and unreadable is said, as `up` says it.
  The
  new precedent in this entry, and it is narrow on purpose because the project's stance is that nothing
  parses `.env`. `up` writes `PI_PAUSE_WINDOWS_FILE` and `PI_SCOPED_LIMITS_FILE` into `<cwd>/.env`, which
  configures the SERVICE through `EnvironmentFile=` and the wrappers and configures nothing about a shell
  an operator later runs `doctor` in; unqualified, the two warnings would then fire hardest at the
  deployments that had just been converged, and this module's own rule is that a check nobody can silence
  must never cry wolf. So doctor reads that file for exactly the keys those two checks name, and judges TWO
  SUBJECTS from it (issue #384). **The SERVICE** is judged whenever `<cwd>/.env` assigns the key, WHATEVER
  this shell says, because the shell never reaches it: `deploy/worker.service` is `EnvironmentFile=` plus
  `ExecStart` with no `Environment=`, the launchd plist carries only `PATH` and `PI_ENV_SETUP`, and the
  wrappers source `.env` inside the child, so the file wins there too. **This SHELL** is judged whenever the
  shell sets the key. A refusal on EITHER fails the command and the label names which subject it is about;
  a shell-first rule exits 0 on a deployment whose service cannot start, which is the shape that made this
  normative. The loader is the PLATFORM's, derived from what `service.mjs` renders: systemd's
  `EnvironmentFile=` on linux, the sourcing wrapper on darwin, the cmd wrapper on win32. A `{systemd,
  wrapper}` pair asked on every POSIX host gives wrong verdicts in both directions, since `export KEY=`
  alone is invisible to systemd and an empty value to the only loader macOS has. Compose's `env_file:` is a
  fourth parser, named as a limit rather than modelled. **The reader claims only what every loader reads the
  same way AND can be shown back**: an empty value, a single-quoted value, a double-quoted value without
  `$`, `\`, a backtick or `"`, and a bare value from a conservative unquoted set (an `=` inside it included, which
  systemd 259, the four shells and the cmd wrapper all keep as written, so the documented
  `PI_BACKEND_FLOOR=isolation=enforced` is judged; never at its start or after a `:`, which zsh expands, issue #477;
  the writer shares that one set, so it quotes exactly what the reader would refuse bare, and refuses a value holding a
  character the reader never vouches for, so doctor reads back every line `up` writes), none of them carrying a
  control character, a bidi control or a line separator. The second condition is the reader's rather than
  each caller's, because a quoted ESC is read IDENTICALLY by every loader and printing it rewrites the
  operator's terminal, and a caller that has to remember to escape is a caller that will forget. An accented
  or CJK path is ordinary and stays plain. THREE ANSWERS, not one: what a LINE assigns, whether it can be
  shown back, and whether the loader ends up with it are three questions; collapsing any two of them produced
  a wrong verdict under review -- a stray `unset FOO` hid a key assigned nothing, and a value outside the
  printable grammar hid `KEY=""''`, which is empty to every loader.
  **WHAT ONE LINE DOES TO ANOTHER IS PER LOADER**, measured on systemd 252 against the four shells rather
  than assumed. systemd continues a trailing backslash outside quotes, and a value that OPENS with a quote
  runs to that quote's close (measured on systemd 259, issues #430 and #447), so a key line inside such a value
  is part of it and not an assignment; a quote in the middle of a value does NOT carry to the next line, and a
  line it cannot parse -- `unset K`, a heredoc body, a block, `OTHER=${NOPE?boom}`, `OTHER=(` -- is IGNORED.
  Where systemd splits the file into lines differently from the reader (a lone CR, a reopened quote, a quoted
  value under a non-identifier key, a continuation the reader misses, or any line where its quote state and the
  reader's region model disagree), the file is refused for systemd, and doctor names that line and its shape
  instead of a reading; a file systemd will not LOAD at all (a NUL, invalid UTF-8 in a key or value) is read from
  its bytes and FAILS doctor, since the service cannot start. A comment line never continues, for systemd (254
  and later) or a shell, so a `#` comment ending in a backslash leaves the next line an ordinary line to both
  readings. A sourcing shell continues both, RUNS every one of those lines, and dies outright on several,
  taking every key in the file with it. So the reader refuses such a file for the shells and refuses almost
  nothing for systemd; judging a linux deployment by the shells' rules made an ordinary `unset FOO` hide an
  empty boot key that systemd reads perfectly well. Where a file IS refused, doctor names that line and makes
  no claim about the SERVICE -- and still judges this shell, which never reads that file. Outside that grammar doctor names
  the key, the file and the LINE NUMBER, says the service may read something other than what the line
  appears to say, and NEVER PRINTS THE VALUE, which is also what keeps a control byte in a `.env` out of the
  operator's terminal. Nothing read this way reaches a config, an argv, a container env or a fix that
  writes; a file that is not there changes no message, while one that IS there and cannot be read (a
  directory, a pipe, a mode this account cannot open) gets a line saying exactly that, because "the key is
  unset, so the worker ignores it" is a positive claim about a file nobody opened; and `PI_ENV_SETUP` inside
  a `./.env` is
  still deliberately not honoured, which is what keeps `docs/secrets.md`'s opening sentence true. **Doctor
  is not the worker.** The set of readable keys is FROZEN in the module rather than chosen per call, so a
  later check that wants the same softening cannot reach a credential by adding one to its own list; and the
  reader agrees with the CONSUMER rather than with the writer, taking the last assignment as every loader
  does. **A `.env` VALUE now reaches read-only file I/O**, which is the one widening of "reads to decide
  what to SAY": doctor runs the worker's own loader on the path the file names, behind a `statSync().isFile()`
  guard so a FIFO or a device cannot hang the command, and resolves a relative value against doctor's own
  working directory. It still configures nothing, writes nothing and runs nothing. **An env-setup script THE SERVICE RUNS
  downgrades a service refusal to a WARNING naming it**, because on all three platforms that script runs
  after `.env` and can override the key; without the downgrade doctor and `up` would fail a working
  `--env-setup` deployment, and without the usable condition doctor softens a refusal on the strength of
  a script it has just reported missing. Since issue #481 (PR #485's final review) that is the script the worker's
  service installed for this folder names, when it is a regular file this account can read, and no longer
  `PI_ENV_SETUP` in doctor's own shell, which the service does not run and which had passed deployments that then
  refused to boot. A whitespace-only value is configured, not unset, because the
  wrapper tests `[ -n ]` and then refuses to start on the file it names. **Three states, not two**: a key assigned only with an `export ` prefix is read
  by the wrapper scripts and NOT by systemd's `EnvironmentFile=` (measured on systemd 252 and 257.13), so it
  is neither set nor unset and gets a sentence of its own; collapsing it into either neighbour makes doctor
  claim the service reads what systemd does not, or tell an operator to write a line already there moments
  after `up` reported that key as already set. A FOURTH SIGNAL, derived from the same two readings (issue
  #365): a file carrying BOTH forms is not export-only and the three states said nothing about it, while the
  two readings can DISAGREE about the value -- one loader takes the bare line and another takes the last
  assignment -- in which case the two deployment shapes load different files and doctor named only one of
  them. It fires only when they differ, because both forms holding one value is tidiness rather than a fact
  about the deployment, and it is order-sensitive for the same reason: an `export` line BEFORE the bare one
  is overridden for both consumers and is not a finding. And `up` NAMES AN EMPTY VALUE: `KEY=""` is SET to
  the never-clobber rule and EMPTY to every consumer that reads the key at all, two true sentences three
  lines apart in one `up` run, so the summary says the line is there and its value is empty rather than only
  "already set". **Empty is not unset**, and the correction matters because doctor said it was (issue #384):
  the config reads these two keys with `??`, so an empty string survives, and the worker then refuses to
  start on a path that is nothing. Not a fourth doctor STATE, deliberately: a state carries a decision, and
  this is a wording overlap.
- **`doctor` says who a local job runs as** (issue #341). From the same facts and the same resolver the worker
  uses, and without starting a container: the image's own user, the `<uid>:<gid>` it passes as `--user` with its
  HOME, or the refusal and its fix. It fails only for what stops the worker booting and warns for what refuses jobs
  one by one, and it warns when this shell's uid is not the account a system unit's `User=` runs the worker as
  (an explicit `User=` only; drop-ins are not read), since the answer is then this shell's and MAY NOT BE the
  service's -- under a host-level refusal (a userns-remapped daemon, Docker Desktop on Linux, an unreadable
  answer, a rootless daemon) every account on the host gets the identical verdict, so the answer above IS the
  service's too and re-running as that account changes nothing (issue #370). `doctor --live` reads that decision back.
- **`doctor` reports a bound that is set and asleep.** A knob an operator sets, doctor stays silent about,
  and nothing enforces is this project's own believed-on-while-off failure by another route, so where a
  feature's control CAN be inert for a reason the operator cannot see from their own configuration,
  `doctor` says so. `PI_SESSION_MAX_CONTEXT_PCT` is the case that made this normative: its measurement is
  produced by the job image's runner, an older image reports none, a bound with no measurement passes by
  design, and there is deliberately no image capability to check it against. The resume bounds are also
  printed as a plain fact line, because three of the four are off by default and silent when unset, which
  leaves no way to tell a deliberate "no bound" from a forgotten one. Neither line carries a `fixAction`:
  how long a lineage may run is an operator's decision, not a mechanical remainder.
- **`doctor` never reports green on a credential the worker cannot spend.** The clause above makes a
  knob that is set and asleep normative; this is the same failure with the sign flipped, and it was not
  hypothetical. `doctor` carried its own provider-to-variable table while the worker derived the answer
  from pi, and the copy had drifted: `PI_PROVIDER=google` with only `GOOGLE_API_KEY` passed, and
  `PI_PROVIDER=gemini` passed, while every job of either deployment was refused pre-spend. The refusal
  costs nothing, which is the point -- what it costs is the thing `doctor` is for, because an operator
  following its output has no way to discover that the variable they set is not the one the worker reads,
  and the refusal they eventually meet names the provider rather than the variable. So: the provider
  credential line is **derived from pi and never from a local table**, it distinguishes "known provider,
  no key here" from "known provider, no key variable at all" from "not a provider pi has", it names the
  OAuth precedence rather than passing over it in silence, and like the two lines above it carries no
  `fixAction` -- `doctor` cannot know which provider an operator meant, and never mints a credential. A provider pi
  does not know is ✓ ("keyless: served by declared endpoint <id>") exactly when the worker's own keyless verdict
  passes it on the same declaration and overlay `models.json` (issue #503, `REQ-EGRESS-ALLOWLIST`); otherwise its ✗
  names the keyless way in beside the provider ids, and why this provider is not keyless when the overlay defines it.
- **One account's deployment never takes another account's state on a shared host** (issue #464, measured on
  Fedora 44 and Ubuntu 24.04 with several accounts on one machine). Four rules. (1) The DEFAULT jobs dir is per
  account, `<tmp>/pi-dispatch-<euid>/jobs` (the plain `<tmp>/pi-dispatch/jobs` where the platform has no uid), and the
  default sandbox and graph dirs sit under the same per-account root, as do the run history and the settings overlay
  on an account with no home directory (`REQ-DURABLE-RUN-HISTORY`); the old shared default was created by whichever
  account ran a job first and failed every other account's jobs with `EACCES` while doctor said ready. The worker
  creates that root `0700` and refuses, at boot as a `configError` (exit 2) and again before every job (config-refused),
  a root that is a symlink or another account's, judged by `lstat` before anything is created so a symlink squat is
  this refusal and never a raw `EACCES`; any jobs dir another account owns; and a sandbox dir (`PI_SANDBOX_DIR`) that
  exists and is another account's, which is also asked again at each retention (a run is then deleted, not kept
  there). `doctor` reads `PI_JOBS_DIR`, `PI_SANDBOX_DIR` and `TMPDIR` as the service does and fails on the same
  conditions with the fix, says ✓ otherwise, prints no retained-workspace ✓ after such a ✗, and warns (⚠, with the
  move) when the OLD shared default still holds retained workspaces this account owns, which this version neither
  re-opens nor sweeps. (2) On Linux a Valkey that already answers `VALKEY_URL` is this deployment's only when it is
  this account's, or root's where root may hold it: every address the URL's host resolves to (as the worker's client dials them, so
  `localhost` is `::1` and `127.0.0.1`) that answers is judged by the owner of its listening socket in
  `/proc/net/tcp` and `/proc/net/tcp6`, and only this account's uid or one of its subordinate uids (`/etc/subuid`)
  count, with root's (docker-proxy; an owner no row names is counted as root's, since only the kernel's NAT answers
  with no socket) allowed only where the deployment's venue is not `podman` alone. Gate round 3 made this one rule for
  every client, whatever its venue and whatever directory it runs from: another account's listener (a system account
  included) is refused by the worker, the CLI, the receiver, the admin panel and doctor on the `local` venue as on
  `podman`, and root's is refused only where the deployment's `PI_BACKENDS` (this environment's, else its `.env`'s)
  names `podman` without `local`. Such a listener is refused, by name, with two ways out:
  `VALKEY_URL=redis://127.0.0.1:<port>` in `.env`, at which port the Quadlet Valkey is then published, or
  `PI_VALKEY_SHARED=1` in `.env` for a Valkey shared on purpose (read from `.env` only; a shell value is ignored and
  said; with no `.env` found, never from the environment either, so a shell opt-in cannot send jobs into a queue the
  worker refuses). The `.env` is read as bytes through the hardened reader this requirement states for the service's `.env` (issue #447): a line the
  service's loader reads differently or refuses (a lone CR, a NUL, invalid UTF-8, an unquoted `[`) is named, and then
  only this account's own listener is taken. Gate round 2 moved the rule to where the connection is made: the WORKER judges it at every start, before any
  Valkey contact, and exits 2 with the refusal; an unspecified address (`0.0.0.0/8`, `::`) is this host's loopback;
  a name that does not resolve, or a lookup that does not answer, is a judgement to retry, never another host; every
  Valkey client of the worker connects to the judged literal address (a `rediss:` name kept for TLS), the first
  answering one this account holds, so another account's listener on another address of the name is named, never
  dialled. Every other Valkey client (the CLI's `run`, `pause`, `resume`, `status` and `cancel`, the receiver, the
  admin panel, doctor) connects through the same judge-and-pin, built into the one module that makes every connection,
  and a test refuses any file that constructs a Valkey client another way (or names ioredis or bullmq in any string
  literal, or uses `createRequire`, outside the files allowed each). A judgement that fails while the Valkey restarts
  fails that connect attempt and the client retries it, so the worker keeps working after a Valkey restart. The
  receiver judges at start, before its queue and before it listens, and exits 2 on a refusal (1 when nothing answers
  within its wait). One function decides it for the worker, `service install` (which
  refuses before writing, `--force` or not), `up` (which adds and adopts nothing and exits non-zero) and `doctor`
  (a ✗ for such a `VALKEY_URL`, and for a `VALKEY_URL` line in `.env` it cannot read the way the service's loader
  will, after which it contacts no Valkey at all); `up` and `service install` read `VALKEY_URL` and `PI_VALKEY_SHARED` from `.env` as the service does (`up`
  takes this shell's only where the file sets none, and stops when they disagree).
  (3) `service install` and `up` write every file before they run any command, and a failed write puts back every
  file that run wrote (a new one removed, a replaced one given its old bytes), naming any it could not; a command that
  fails after that leaves only the stack files its units already run from, named (`service install` also puts its
  worker unit back).
  (4) `doctor` names the rootless Podman whose run directory `/run/user/<uid>` is gone (linger switched off after
  Podman first ran under it), from three facts rather than Podman's stderr, which it never reads: `podman info` failed
  with an exit status, that directory does not exist, and Podman's own database records a run root under it (the
  evidence that Podman ran there, which an account that never had a session lacks). Its fix is linger (measured to bring Podman back on 5.8.1
  and 4.9.3); `podman system migrate` is named as NOT a fix, since it fails the same way (measured).
  (5) The Valkey a deployment starts has a password of its own (issue #468): every account on a host shares
  loopback, and rule (2) stops only an accident, not an account that connects on purpose to read, enqueue or delete
  another's jobs. It is `VALKEY_PASSWORD` in `.env`, a key of its own and never part of `VALKEY_URL`, which doctor
  prints, the admin's pointer stores and refusals quote. `init` writes a new one (32 random bytes, hex) into the `.env`
  it creates, and creates that file with mode 0600; `service install` (where it installs the Quadlet Valkey) and `up`
  (the Valkey it starts, on docker or as a Quadlet unit) add one to a `.env` that has none, never over a value, and
  narrow that file to its owner. None is generated for a shared Valkey (`PI_VALKEY_SHARED=1`: it takes its owner's
  password) or for a `VALKEY_URL` that names another host or carries its own credentials, which is left as it is. A
  value outside base64url characters, or shorter than 16 or longer than 512, is refused by both, and by doctor. The
  value is never printed or logged: a line says only whether one is set. The Valkey receives it in its container's
  environment and reads it as configuration on stdin; never on a command line, where the image's PID 1 keeps it
  readable by every account for the life of the container (measured on Podman 5.8.1 and 4.9.3); with none set it
  starts without one, as before, so an older `.env` keeps working. Every client sends it through the one connection
  function of rule (2): the URL's own password first, then `VALKEY_PASSWORD` from the environment, then from the
  deployment `.env` (the one the admin's pointer names, for the panel) for a loopback host only. A Valkey that refuses
  the credential (`NOAUTH`, `WRONGPASS`) is a configuration refusal naming the key and where it came from: the worker
  exits 2 at boot, `run`, `pause`, `resume`, `status`, `cancel`, the receiver and its poller refuse at start, doctor
  prints a ✗. A loopback Valkey that answers a client sending none is a doctor warning naming the upgrade:
  `service install --force` on the podman venue, which restarts the Valkey with the new password (its volume, and
  the queue, kept) and then the worker and receiver units that were running; `up` on docker, which offers to stop,
  remove and run `pi-dispatch-valkey` again with its volume kept; compose's own recreate with `--env-file .env`.
  `up`'s docker Valkey is probed and published on `VALKEY_URL`'s port, read as the service reads it (it was always
  6379); a `VALKEY_URL` naming another host adds none, and an IPv6 literal, which a Valkey published on `127.0.0.1`
  cannot serve, is refused with the fix.
  `VALKEY_PASSWORD` never reaches a job container: `PI_FORWARD_ENV` refuses it and a trigger's `run.secrets` may not
  bind the name. Nor a log: no error a client emits, and no command it rejects, keeps the failed command's arguments
  (a failed AUTH carried the password there, through a listener, a listener-less client and every waiting command
  alike), every Queue, Worker and the worker's shared client writes an error as its message alone, and the worker, CLI
  and receiver entry points print an unhandled rejection as its message alone and exit 1. Nor a terminal: every URL
  the CLI prints goes through `urlShown`. The CLI verbs and `service restart --drain` read `VALKEY_URL` as they read the
  password: this shell's, else the deployment `.env`'s, or the one `--valkey-url` names. When the shell's and the
  `.env`'s disagree, `pause` pauses BOTH and says so (a stale export must not make "paused" true of the wrong Valkey),
  `status` shows both, `resume` and `cancel` refuse until `--valkey-url` names which, and `run` and the drain use the
  shell's and name the disagreement. The panel's `/dispatch pause|resume` (and its pause and resume tools) take the
  same rule from the same resolver, the pointed-at deployment's `.env` against this process's `VALKEY_URL`, and print
  every URL through `urlShown`. `--valkey-url` is a flag of the verb in any position, and one carrying a password (or
  a user) is refused, naming `VALKEY_PASSWORD`, since a command line is readable by every account in `/proc`; one that
  names neither the shell's nor the `.env`'s URL is used and said. The compose file publishes its Valkey on
  `PI_VALKEY_PORT` (6379 unset); where VALKEY_URL's port is not 6379, `up` and the setup wizard write it into `.env`
  (never over a different value, which they name, as doctor does) and pass it to every compose run, so no compose path
  moves the queue off the worker's port; in a folder the wizard handed to compose, `up` starts compose's Valkey with
  the folder's project and the override, never one of its own beside it. A Valkey container or volume is this
  deployment's only when it is provably so: `up` labels the container it starts with the deployment
  folder, a compose Valkey is the folder's by compose's own working-dir label, and an unlabelled `pi-dispatch-valkey`
  from before the label only when it publishes this deployment's VALKEY_URL port. `up`, its password restart and the
  wizard's hand-over never stop, remove, reuse or start beside a container that fails this, and nothing
  starts a Valkey on `pi-dispatch-valkey-data` while a container that is not this deployment's mounts it (two Valkeys
  on one AOF, measured); each refusal names the container and the way out, and `up` exits non-zero on it. The volume
  has an owner of its own: `up` creates it labelled with the deployment folder, a volume labelled for
  another folder is never used, and an unlabelled one (made before the label) is used only after a question that
  `--yes` does not answer, naming that its queue cannot be attributed to a folder (doctor starts no Valkey at all: its fix line names `pi-dispatch up`; the
  wizard names `up` too; the upgrade restart of this deployment's own container needs none). The owner marker of an
  adopted volume is read before any Valkey on it is published, by one with no network, and the adoption is recorded
  in the deployment folder by the volume's `CreatedAt`, so that volume is not asked about again. Since a volume label cannot be
  added later, the queue records its owner inside it (`pi-dispatch:owner`, set once), and every start on the volume
  checks it: another folder's stops what that start began, at once, and fails the step. `up`'s offer
  to restart a Valkey with its password says that a running job is interrupted and that the worker gets NOAUTH until
  it restarts.
- **Every environment variable a loader reads is discoverable, or is marked as not being a key.** The
  scaffold is the operator's whole view of what this system can be told: `init` copies `.env.example` (filling in only
  `VALKEY_PASSWORD`, issue #468)
  verbatim, so a variable absent from it is a variable an operator has no way to learn exists, and the
  refusal that eventually names it is met as an error rather than as documentation. That is the same
  believed-on-while-off failure the clause above makes normative for `doctor`, one step earlier. So:
  a variable read by `worker/`, `receiver/`, `admin/` or the in-container runner is either a key in
  `.env.example` (commented out is fine, and is the right shape for anything optional), or it carries a
  comment at its own read site naming it internal and saying why it cannot be a key. The comment rides
  the read rather than a list, because a list is a second thing to keep true and drifts from the code it
  describes; `worker/src/reserved-env.mjs` states that rule for the reserved-name sets and it holds here
  for the same reason. Four reasons carry a marker today and each is stated rather than assumed: the
  worker writes the value into the container per job, so a deployment's value is overwritten before
  anything reads it; the variable is unit configuration a wrapper captures before it sources `./.env`,
  which is what stops file content naming a script the wrapper runs; the variable belongs to the
  surrounding system rather than to this project; or nothing on the host writes it at all, so a value in
  `.env` reaches no container. Two more are named in `.env.example` and carry no marker, because neither
  is read from these trees: the test seams, which live in `test/`, and the provider keys, which cannot be
  enumerated at all because pi names them per provider. The file says that rather than pretending to a
  closed list.
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
  before they source `./.env` precisely so file content cannot name it, and assign their own variables
  only after the load, from values no `.env` line reaches, so neither a `PI_ENV_SETUP=` line nor one naming
  the wrapper's own copy (`env_setup=`, `ENV_SETUP=`) can (issue #470); such a line is named by `up`, the
  wizard and doctor. (2) A missing or failing setup
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
  scaffolds + `mkdir` of env-declared paths; prompted = the deployment's own default image (into this
  account's Podman store instead of docker's on a deployment without `local`, issue #433), the
  loopback Valkey (while `local` is listed), an overlay `auth.json` delete, an `import-pi` restage under its own gates; never =
  malformed-config rewrites, triggers/pause-windows/scoped-limits content, trigger-named images,
  semantic env guesses, an env-setup script's mode or location. `up` may set `WEBHOOK_SECRET` in a scaffolded
  `.env` **only when the key is empty** — a generated secret is never printed and an operator's value
  is never replaced.
- **Traces to**: `DES-CLI-SURFACE`, `CONST-BUDGET-BEFORE-TOKENS`, `SECURITY.md` (pull-it-yourself),
  `REQ-GLOBAL-PI-OVERLAY` (doctor's existing obligations), `INT-LIVE-PROBE-CONTRACT`
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
  presence checks. Given the source trees the three services and the runner are built from, when every
  environment variable read in them is collected, then each one is either a key in `.env.example` or
  carries an internal marker at its read site, and neither list is hand-maintained beside the code.
  Given `doctor --live`, then a line names every container, the image, any peer network and the fixture location
  before the first docker command after the endpoint re-read, no check it renders carries a fix action, and afterwards no container, peer
  network or fixture remains; given `doctor` without `--live`, or `up`, then no probe container is started and no
  read-back
  line appears. Given a native Linux daemon and a shell uid other than 1001 with an `anyUid` image, then doctor
  names the `<uid>:<gid>` it passes as `--user` and `doctor --live` runs its probe with that `--user` and reads
  that uid back; given a rootless daemon while `local` is the default venue, then doctor fails with the worker's
  own refusal text and `--live` runs no container. Given two accounts on one host with no `PI_JOBS_DIR`, then each
  account's jobs run from its own `<tmp>/pi-dispatch-<uid>/jobs` and neither can fail the other's; given that root
  created first by another account, or a symlink there, then the worker refuses to boot (exit 2) and `doctor` fails,
  each naming the owner and the fix; given a `PI_SANDBOX_DIR` another account owns, the same. Given a Valkey that is
  not this account's at every answering address `VALKEY_URL` reaches (`0.0.0.0` included) (root's where the venue is `podman` without `local`, a system service's or another account's, on
  `127.0.0.1` or on `::1` for a `localhost` URL), then the worker refuses to start (exit 2), `service install` refuses before writing anything, `up` adds and
  adopts nothing and exits non-zero, and `doctor` fails without talking to it, each naming the owner; with
  `PI_VALKEY_SHARED=1` in `.env` (never the shell), each takes it and says whose it is. Given this account's Valkey on
  one address and another account's on another address of the same name, then the worker connects to its own. Given another account's Valkey and a deployment whose venue is `local`, or `pi-dispatch run` or the receiver started from a directory with no `.env`, then each refuses it (the receiver before it listens, exit 2); given root's docker-proxy on the `local` venue, then it is taken; given a Valkey restart under a running worker, then its next job completes. Given a write that fails part way through `service install` or `up`'s Quadlet
  step, then no file that run wrote remains, or the refusal names each one that does; given a command that fails
  after the writes, then `service uninstall` still removes the files that run left. Given rootless Podman after linger
  was switched off, with Podman's database recording a run root under `/run/user/<uid>`, then doctor names the missing
  directory and linger as the fix. Given a service key that only the deployment's `.env` sets (`PI_JOB_IMAGE`, say),
  then doctor judges that value and says it read it from the file; given this shell and the file setting it
  differently, then doctor fails with one ✗ naming both values, or naming a credential without either; given a
  `PI_JOB_IMAGE` starting with `-`, then no docker or podman argv carries it; given a `.env` holding a secret doctor
  does not pass by name, then no process doctor starts is handed it.

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
- Given two hosts on one Valkey whose dollar caps differ (the four dollar settings as a job resolves them, or
  the scoped-limits file's dollar rows), when `pi-dispatch doctor` runs on either, then it warns and names the
  other host, never a cap; given a peer that publishes no dollar fingerprint while dollar caps are in use on
  this host or a peer, or while a dollar counter is found on the Valkey (best effort: an old capped host leaves its
  counters, a host with only a per-job cap leaves none), then doctor names it. Two hosts whose `PI_ALLOWED_MODELS` makes jobs without their own list reserve in different
  model rows differ too. The fingerprint carries numbers and counter hashes only
  (`INT-HOST-REGISTRY-CONTRACT`), and nothing refuses on it.

- **Host-affine work goes to a host queue** (`pi-jobs@<name>`), decided by whoever ENQUEUES it rather
  than by whoever pops it. A cron trigger's folder, a local job's folder and a chained child's working
  tree are all facts about one machine, and the enqueuer knows which machine it is.
- **A cron trigger whose folder is not on this host is UNSERVED, not a boot refusal.** It is logged per
  trigger and the worker boots and drains everything else. A folder that no host serves is a trigger that
  silently never fires, which `doctor` reports, because it can ask the registry and the boot path cannot.
- **`PI_CONCURRENCY` bounds the HOST, not each queue.** A worker draining two queues runs two BullMQ
  Workers, whose concurrency is per Worker.

**Acceptance**

- Given `PI_WORKER_NAME` is unset, then no host queue exists, cron and local jobs are enqueued exactly
  where they are today, a missing cron folder still refuses boot with its existing message, and the
  processor never reaches the host-wide acquire.
- Given a declared name and a cron trigger whose `run.folder` is absent here, when the worker boots, then
  `schedule_unserved` names that trigger, `schedules_installed` counts it, no scheduler is upserted for
  it, and every other trigger installs.
- Given an unserved trigger, then its `run.skillsDir` is not validated here -- `isAbsolute` is
  OS-dependent, and judging another host's path on this platform is the mistake the shared validator
  refuses to make. The host that owns the folder still refuses a bad one at its own boot.
- Given two queues and `PI_CONCURRENCY` of N, then at most N containers run on that machine; the excess
  DEFERS at the scope gate's cadence and reserves no budget.

- **Traces to**: `INT-HOST-REGISTRY-CONTRACT`, `DES-HOST-REGISTRY`, `INT-RUN-HISTORY-FILE-CONTRACT`,
  `DES-CONCURRENCY-3`, `INT-TRIGGERS-FILE-CONTRACT`, `OQ-008`, `OQ-012`


## Revision History

| Date | Change |
|---|---|
| 2026-10-03 | Issue #499, part B (project rows). **`REQ-SCOPED-LIMITS` AMENDED**: a Project rows bullet (a `project:<id>` row, version 2 in every field, caps every member of a project as one, with job counts refused `project-cap`, `concurrent` deferring, and dollar windows refused `dollar-cap`; reserve narrowest first, repo or folder row, project row, global, and every refund gives back every ledger still held; a row naming a missing project refuses the start) and the matching Acceptance. UNCHANGED, checked: `REQ-ADMIN-VIA-PI-EXTENSION` (no tool added; `dispatch_limit_add`'s description names project rows and `project-cap`), `REQ-COST-ANALYTICS` (the per-project fold is part C). Code evidence: `worker/src/scoped-limits.mjs`, `worker/src/budget.mjs`, `worker/src/processor.mjs`, `worker/src/index.mjs`, `worker/src/start.mjs`; tests `worker/test/processor-projects.test.mjs`, `scope-mutex.test.mjs`, `start-wiring.test.mjs`. |
| 2026-10-03 | Issue #500, part E: the parent's fold, STOP and detector. **`REQ-TOKEN-ACCOUNTING-AND-CAPS` AMENDED**, the residual-gap paragraph becomes Child processes: a pi child's ledger is folded into the job's totals every second and at teardown (`childTotal` keeps the four-part split equal to `total`), the token cap, the cost cap and the PARENT's model list are judged on the job as a whole, a stop reaches children through `STOP`, and a pi child with no ledger is unmetered: a floor (`unmeteredChildren`), and under any policy a stop (`cost-cap`, else `token_budget`, else `model-not-allowed`); an uncapped job records the floor only. The old sentence (diagnostic sampling, a fix that needs TLS termination) is withdrawn. The compaction sentence (`otherTotal`, fresh session id) is UNCHANGED, checked. **Code evidence**: image/runner/src/child-watch.mjs -> createChildWatch, linuxProc, isPiProcess; image/runner/run-job.mjs; image/runner/test/child-watch.test.mjs; image/runner/test/child-watch.integration.test.mjs. |
| 2026-10-03 | Issue #499, part A. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, the `up` bullet: `up` also fills `PI_PROJECTS_FILE` with this folder's `projects.json`, which `init` now scaffolds empty, under the same never-clobber rule; an empty value refuses the boot, as for the scoped-limits key. **`REQ-SCOPED-LIMITS` UNCHANGED, checked**: projects are recorded per run in this part and capped in part B. **Code evidence**: worker/src/up.mjs; worker/src/init.mjs -> EMPTY_PROJECTS; worker/test/up.test.mjs. |
| 2026-10-03 | Issue #498, forge-qualified scopes. **`REQ-SCOPED-LIMITS` AMENDED**: Statement and Acceptance, a row may name one forge's repo as `<kind>:owner/name`, a job matches its qualified row before its bare row, a file with both for one repo is refused, and every counter, slot and lease is keyed by the matched row, so a bare row keeps its pre-upgrade count; doctor warns about a bare row when triggers name more than one forge kind. **`REQ-SCOPED-PAUSE-WINDOWS` AMENDED**: Statement and Acceptance, a qualified window pauses one forge's repo while a bare window still pauses it on every forge, and an unknown prefix is refused. A qualified row needs file version 2, and a qualified repo must have a forge repo's shape. **Code evidence**: worker/src/scoped-limits.mjs -> limitFor, rowScopeFor, refuseMixedForms; worker/src/pause-windows.mjs -> qualifiedScopeOf, parseScopeString, pauseUntilMs; worker/src/doctor.mjs; admin/src/costs.mjs -> repoKeyOf, recordInRepo; worker/test/scope-mutex.test.mjs; worker/test/processor.test.mjs. |
| 2026-10-03 | The leftovers of the #501 and #502 round's reviews. **`REQ-JOB-STATUS-COMMENTS` AMENDED**, the `model-not-allowed` stop sentence now also names a request change the trigger does not allow ("...this trigger does not allow, or to change an AI request in a way it does not allow..."), since the runner's model guard also stops a call whose request a hook rewrote or whose sampling settings route it, and the old sentence read as a model swap in those cases. **Code evidence**: worker/src/processor.mjs -> TERMINAL_COMMENTS. |
| 2026-10-03 | PR #558, the end-of-round check of #501 and #502. **`REQ-JOB-STATUS-COMMENTS` AMENDED**, Who authors which comment: a `model-unknown` refusal whose `why` starts `overlay-` posts its own fixed sentence saying the deployment's model settings file cannot be used, naming no path and no model, since the old sentence sent the author to the trigger's model settings when the operator's file was the problem. **`REQ-MODEL-POLICY` AMENDED**, Acceptance: that comment, and the run record's `why`. **Code evidence**: worker/src/processor.mjs -> OVERLAY_REFUSED_COMMENT, runJob; worker/src/run-history.mjs -> buildRecord; worker/test/model-policy.test.mjs; worker/test/run-history.test.mjs. |
| 2026-10-03 | Issue #501 part 6 and the doctor recommendations of #501 and #502. **`REQ-MULTI-HOST-COORDINATION` AMENDED**, the Acceptance: two hosts whose dollar caps (or whose `PI_ALLOWED_MODELS` choice of model rows) differ are named by doctor, and so is a peer publishing no dollar fingerprint while dollar caps are in use, a dollar counter on the Valkey counting as in use, best effort; the fingerprint is numbers and counter hashes only and nothing refuses on it. **`REQ-TOKEN-ACCOUNTING-AND-CAPS` AMENDED**, the cost-cap clauses (d): doctor warns when the per-job cap is below one full-output call of the main or a listed model, a stated lower bound of the runner's own bound that carries its service-tier multiplier ($1.00608 for the default model). **`REQ-MODEL-POLICY` AMENDED**, the Acceptance: doctor names a trigger of any kind whose model the worker's gate would refuse, and the deployment's own default model or `PI_ALLOWED_MODELS` entry, a listed non-main provider with no credential source, and any disagreement between pi's own loader and the worker's catalog on the overlay `models.json` (the pinned pi beside the worker, compared only at the pin, in doctor's process, not the job image: the two share one lockfile, and a probe container would need the canary's venue, user and SELinux handling on every run). **`REQ-SPEND-CAPS-MULTI-WINDOW` and `REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked**: no window moves, and every new doctor line is a warning that never fails a run. **Code evidence**: worker/src/dollar-fingerprint.mjs; worker/src/doctor.mjs -> fleetDollarChecks, costCapFitChecks, unknownModelChecks, listedProviderCredentialChecks, overlayLoaderParityChecks; worker/src/pi-model-loader.mjs -> loadPiModelLoader. |
| 2026-10-03 | Issue #556. **`REQ-MODEL-POLICY` AMENDED**, Scope and Acceptance: a `models.json` that is a named pipe, a socket or a device refuses every job `model-unknown` pre-spend (`overlay-not-a-file`). It is judged from the reader's `lstat` and never opened, so a pipe with no writer blocks neither the worker's read on every pickup nor `doctor`, which says ✗. A folder keeps its own refusal (`overlay-is-a-directory`). **Code evidence**: worker/src/model-endpoints.mjs -> readOverlayModels; worker/src/model-catalog.mjs -> checkModelsKnown; worker/src/doctor.mjs; worker/test/model-endpoints.test.mjs; worker/test/model-catalog.test.mjs; worker/test/doctor.test.mjs. |
| 2026-10-03 | Issue #552, with PR #553's review rounds 1 to 3 folded in. **`REQ-MODEL-POLICY` AMENDED**, Scope and Acceptance. An overlay `models.json` the worker cannot read was a transient read, so a builtin job with no list ran while the job, reading the file through the same read-only mount, loaded none of it (the existence check in image/runner/run-job.mjs, or pi's own read, fails) and sent a builtin provider the file routes to its public endpoint. Now only EIO, EAGAIN, EMFILE and ENFILE are transient, and they retry EVERY job once, a builtin one with no list included, then fail it; EACCES, EPERM and every errno not listed refuse every job `model-unknown` (`overlay-unreadable`) pre-spend, and `doctor` says ✗. Measured in the job image: the mount does not resolve a `models.json` link the way the host does (an absolute target, one outside the folder, a trailing slash, a `..` through a file), so after two rounds of following links as the mount does, the simpler rule: a `models.json` that is a link of any kind, dangling included, refuses every job (`overlay-link`); the folder may be a link. A missing file, or a folder path that loops or runs through a file, stays no overlay, as in the job. Upgrade: a `models.json` that is a symlink is now refused; copy the file in. **`REQ-GLOBAL-PI-OVERLAY` AMENDED**, the Statement: `PI_GLOBAL_PI_DIR` must be an absolute path, and a relative one refuses the worker's boot, since it is resolved differently by the worker and the container runtime, and `pi-dispatch import-pi` prints the absolute path to set. **Code evidence**: worker/src/model-catalog.mjs -> checkModelsKnown, isTransientOverlayRead; worker/src/model-endpoints.mjs -> readOverlayModels; worker/src/config.mjs -> resolveGlobalPiDir; worker/src/import-pi.mjs; worker/src/doctor.mjs; worker/test/model-catalog.test.mjs; worker/test/model-endpoints.test.mjs; worker/test/models-json.test.mjs; worker/test/doctor.test.mjs; worker/test/config.test.mjs; worker/test/import-pi.test.mjs. |
| 2026-10-03 | Issue #544. **`REQ-GLOBAL-PI-OVERLAY` AMENDED**, Acceptance: a loose `extensions/foo.js` in the overlay loads in a job, and a failed load is logged as `extension_load_failed` by its path inside `extensions/`. Before, the runner handed pi the folder, which pi read as one extension at the folder; it failed to import, and nothing read the error, so only `extensions/index.js` ever loaded. The overlay's entries are now listed by pi's own rule for `~/.pi/agent/extensions`. `REQ-AI-TRIGGERED-RUNS` **UNCHANGED, checked**: an identical run in the same minute still dedups; a run that differs only in its model fields is no longer identical (`DES-CLI-TRIGGER-FOR-LOCAL`). **Code evidence**: image/runner/src/loader.mjs -> discoverExtensionEntries, reportExtensionLoadErrors; worker/src/job-id.mjs -> localJobId. |
| 2026-10-03 | Issue #501, part 7 (the operator surfaces). **`REQ-ADMIN-VIA-PI-EXTENSION` AMENDED**: the Statement says what the panel, `dispatch_costs`, `dispatch_limits`, the scoped-limit writers and `dispatch_set` now do with the dollar caps (the counter as spent and held beside the records' settled amount, basis counts and `boundExceeded`; dollar fields judged before the confirm); the Why says neither `run.maxCostUsd` nor `run.models` is settable by any tool, and why a call carrying one is refused rather than dropped; the Acceptance gains six clauses for those. Review round 1 (PR #550): the trigger tools refuse a near miss of either field too (the loader's own sweep, now exported as `runModelFieldNearMiss`); with no dollar setting the tool results are byte-identical to before; a dollar field the model sends as a number reaches the tool as a string through pi's own validation and is judged by its value. The tool list is UNCHANGED (no tool was added or removed; the wiring scan still holds). **`REQ-COST-ANALYTICS` AMENDED** (PR #550's review): the class rule is scoped to the `fold`; the Why and the Acceptance say the `dollars` block beside it holds the caps' enforcement amounts in integer micro-dollars with no class, present when a dollar window is set, a dollar setting cannot be read, or a run in the window carries `dollars`. **`REQ-SCOPED-LIMITS` AMENDED**, one stale clause dropped: the admin surface it said "lands in a later slice of issue #242" has landed; the file contract is the same, and the tools now write the fields it already accepted. **`REQ-SPEND-CAPS-MULTI-WINDOW` UNCHANGED, checked**: enforcement did not move. **`REQ-MODEL-POLICY` UNCHANGED, checked**: `run.models` was already tool-proof by omission; it is now refused by name. **Code evidence**: admin/src/index.ts -> refuseWideningFields, dollarFieldsOf, dispatch_set; admin/src/dollar-windows.mjs; admin/src/dashboard.ts -> dollarSection. |
| 2026-10-03 | Issue #545 (PR #555's review). **`REQ-RESURRECTABLE-SANDBOX` AMENDED**, one clause in Why: stdin is `ignore`, or on an image declaring `exitAuth` a pipe the worker writes one key line to and closes at once (`INT-RUNNER-EXIT-CODE-PROTOCOL`), and never a TTY. Nothing can be typed into a live run either way, so the load-bearing fact is UNCHANGED; only its wording was too narrow. |
| 2026-10-03 | Issue #543 (PR #547's review, round 2). **`REQ-CRON-SCHEDULED-JOBS` AMENDED**, one acceptance line: an unregistered command is refused before the job's prompt is sent, no longer "before any model call", because a call an extension made while it loaded may already have spent; the exit line carries it. |
| 2026-10-02 | Issue #539, follow-ups from PR #536's review. **`REQ-MODEL-POLICY` AMENDED**, Scope and Acceptance, two overstatements corrected. "A file pi would drop is refused" held only for a job needing an overlay model: the rule now refuses EVERY job while the file is one pi drops, whatever broke it (a schema error, a block comment, a truncation, a UTF-16 save, an empty file, a directory), until the operator fixes it, since pi drops every entry with the file and would run even a builtin model against its provider's public endpoint. PR #546's review tried reading which providers a broken file names, and each round found a case that reading missed, so the simpler rule was chosen. "A transient read is retried as infra" is narrowed to a job that needs the overlay, an overlay model or (since #502 part 4) a list whose fallbacks it could change; a job of builtin models only with no list runs. **Code evidence**: worker/src/models-json.mjs -> parseModelsJson, stripJsonComments; worker/src/model-catalog.mjs -> checkModelsKnown; worker/src/doctor.mjs; worker/test/model-catalog.test.mjs; worker/test/models-json.test.mjs; worker/test/doctor.test.mjs. |
| 2026-10-02 | Issues #501 part 5 and #502 part 6 (scoped-limits version 2). **`REQ-SCOPED-LIMITS` AMENDED**: a new Dollar windows bullet (repo and folder rows gain `dayUsd`, `weekUsd`, `monthUsd`; `model:` rows cap a model across scopes; reserved with the deployment's dollar windows in one step that gives everything back, settled after the run; a version 1 file using either is refused naming version 2), and the Acceptance gains the scope dollar refusal, the version clause, and (PR #549's review) the no-cap and cap-below-job warnings; the job-count, concurrency and mutex clauses are UNCHANGED, checked. **`REQ-MODEL-POLICY` AMENDED**, the Acceptance: per-model dollar windows (part 6), with the unrestricted job reserving in every model row, the second-job refusal, and the per-model settlement with its floor. **`REQ-SPEND-CAPS-MULTI-WINDOW` UNCHANGED, checked**: the deployment windows did not move. **Code evidence**: worker/src/scoped-limits.mjs; worker/src/dollar-budget.mjs -> modelDollarSettlement; worker/src/processor.mjs -> runJob. |
| 2026-10-02 | Issue #501, parts 3 and 4, and #503 part 7 (dollar windows, reserved before the run and settled after it). **`REQ-SPEND-CAPS-MULTI-WINDOW` AMENDED**: the Statement gains the optional dollar windows (`dailyCostUsd`, `weeklyCostUsd`, `monthlyCostUsd` and their `PI_*_COST_USD` variables), each needing `maxCostUsd`, reserved after both job-count reserves and before the container, refused pre-container as `dollar-cap` with both job-count slots and the dollars given back, settled after the run to the metered cost when it is fully known and kept whole when it is not, refunded when no container ran, in integer micro-dollars, and nothing reserved for a job whose every allowed model is local and zero-rated; the soft-hold band stays a job-count brake. The Why says why the windows can be check-before (the per-job cap is enforced before every call) and why a refused dollar reservation is given back. The Acceptance gains the concurrent-reservation, metered, floor, 23:59:59, never-started, zero-rated and nothing-set clauses; the job-count clauses are UNCHANGED, checked. **`REQ-ADMIN-VIA-PI-EXTENSION` AMENDED**, the Why: the three dollar windows are settings keys behind the same operator-typed or confirm-gated write, no longer refused at the write. **`REQ-TOKEN-ACCOUNTING-AND-CAPS` UNCHANGED, checked**: (d), the per-job cap, is what the windows reserve, and its enforcement did not move. **`REQ-JOB-STATUS-COMMENTS` UNCHANGED, checked**: `dollar-cap` is a free refusal with its own refusal comment, like `over-budget`, not a terminal sentence. **Code evidence**: worker/src/dollar-budget.mjs; worker/src/processor.mjs -> runJob; worker/src/model-endpoints.mjs -> zeroRatedVerdict. PR #542's review, folded in: the Statement and Acceptance say a run that made no provider call meters 0 and a floor charges at least the reservation and never less than a reported metered cost; the Why's "`CONST-BUDGET-BEFORE-TOKENS` is unchanged" is limited to the job-count windows, since the dollar windows join that constraint as its second ledger. |
| 2026-10-02 | Issue #502, part 4 (the runner's model guard). **`REQ-MODEL-POLICY` AMENDED**, the runner half: a job limited by a list never sends a call to a model outside it; every call in the runner process is checked before it is sent (a mid-run `setModel`, a second in-process session, an extension's direct call, classifiers and image models, a virtual model by its routed physical model), exact and case-sensitive on provider and model, and a miss ends the job `2` / `model-not-allowed`. PR #538's review: a listed call is also refused when its request would name another model (a routing key in samplingParams, `providerOptions` included, any other key passing, a payload hook, which is deny by default: it may change only the top-level messages, system prompt and sampling settings, a per-call Azure deployment, a caller's own `fetch`, an unlisted Anthropic fallback); a listed fallback that answers is logged; the worker half refuses, before any spend, a list naming a model whose declared fallbacks are not all listed (`why: fallback-unlisted`), which at the pin is `anthropic/claude-fable-5` without both opus fallbacks, and retries rather than refuses when the overlay cannot be read just then; a runner that cannot enforce the list refuses before any call. The Scope, Why, Traces and Acceptance gain the runner clauses. **`REQ-JOB-STATUS-COMMENTS` AMENDED**, the who-authors clause: `model-not-allowed` is live as the runner's paid stop on an image that declares `modelPolicy`, beside the worker's free refusal; the sentences themselves are unchanged. **`REQ-TOKEN-ACCOUNTING-AND-CAPS` UNCHANGED, checked**: the cost cap's rules stand; an unlisted call under a cap is refused by the list before the cap is asked. **Code evidence**: image/runner/src/usage-meter.mjs -> createModelGuard, createPolicyGuard; image/runner/run-job.mjs; worker/src/model-catalog.mjs -> declaredFallbacks; worker/src/processor.mjs. |
| 2026-10-02 | Issue #535. **`REQ-RESUMABLE-SESSION` AMENDED**: a transcript holding a compaction with an empty summary is one more fail-open cause, a cold start named `compaction-summary-empty`, and the Acceptance says so. It is not an opt-in bound: a session resumed on such a summary would carry on without the turns it replaced, and nothing would say so. **Code evidence**: worker/src/session-store.mjs -> readCanonical, hasEmptyCompaction; worker/test/session-store.test.mjs; image/runner/test/compaction-refused.integration.test.mjs. |
| 2026-10-02 | Issue #501 part 1. **`REQ-ADMIN-VIA-PI-EXTENSION` AMENDED**, the Why: the sentence on raising the daily cap names the per-job dollar cap `maxCostUsd` too (a settings key behind the same operator-typed or confirm-gated write), says the three dollar windows are settings keys refused at the write until they are enforced, and that no tool sets a trigger's `run.maxCostUsd`. `REQ-TOKEN-ACCOUNTING-AND-CAPS` and `REQ-SPEND-CAPS-MULTI-WINDOW` UNCHANGED, checked: the runner's enforcement and the windows land in later changes of #501. `CONST-BUDGET-BEFORE-TOKENS` UNCHANGED, checked: the new image refusal is free and runs before the mint, the clone and every reservation. |
| 2026-10-02 | Issue #502 parts 2, 3 and 5. **NEW `REQ-MODEL-POLICY`** (the worker half; the runner half lands with part 4): a trigger's `run.models` and the deployment's env-only `PI_ALLOWED_MODELS` name the models a job may call, the trigger's replacing the deployment's, unrestricted when neither is set; a job whose main or listed model is unknown to pi's catalog and the overlay `models.json` is refused `model-unknown` pre-spend; a main model off the effective list is refused `model-not-allowed` pre-spend and pages nobody; a list reaches only an image declaring `modelPolicy`; a chained child keeps its parent's provider, model and list; a listed job holds every listed model's endpoint slot. **`REQ-PER-TRIGGER-TOOL-EXCLUSIONS` UNCHANGED, checked** (its inheritance rule is the precedent, not changed). **`REQ-OPERATOR-FAILURE-NOTIFICATION` UNCHANGED, checked**: its Excluded clause already names every free pre-spend refusal; the hook now honours it for the one reason that is both. **`CONST-BUDGET-BEFORE-TOKENS` UNCHANGED, checked**: both new gates are free and sit with the free gates, before the mint, the clone, the token-cap read and every reservation. PR #536's review, folded in: a list the receiver dropped is refused `trigger-skew` where the worker can read the triggers file; the overlay is read as pi reads it; the main model must be a chat model; the Statement's byte-identical claim is narrowed to job data and container env, since the free model-exists gate now runs for every job. Review round 2: the overlay claim is narrowed to pi 0.99.1's loader and provider composition, both held by the differential test; the byte-identical claim names the outbox child's inherited provider and model; the skew check stays strict, a job queued before the field was added included; a builtin model whose provider has an overlay entry pi would not compose is refused, since pi would drop that entry's endpoint. **`REQ-WAIT-FOR` UNCHANGED, checked**: its skew stays strict, and `models` joins it on the same terms. **`REQ-JOB-STATUS-COMMENTS` AMENDED**: `model-not-allowed`'s sentence says the token is live as the worker's free refusal while the runner's stop stays reserved for #502 part 4. |
| 2026-10-02 | Issue #501, part 2 (the runner's cost guard). **`REQ-TOKEN-ACCOUNTING-AND-CAPS` AMENDED**: a new (d), the optional per-job cost cap `PI_MAX_COST_MICROS`, enforced by the runner before every provider call against a worst-case bound (`DES-DOLLAR-RESERVE-AND-SETTLE`), exit `2` / `cost-cap`, and refused before any call by a runner that cannot enforce it; the Why says why a dollar cap cannot lag the way a token cap does, and the Acceptance gains the offline sequential, parallel, compaction, cap-of-0 and no-cap clauses. (a), (b) and (c) are UNCHANGED, checked, except that a call whose result rejected now counts as unpriced. **`REQ-COST-ANALYTICS` UNCHANGED, checked**: its floor rule (d) already renders any run with `unpriced > 0` as a floor, so the widened `unpriced` only marks more runs as floors, the honest direction, and no label or fold changes. **`REQ-JOB-STATUS-COMMENTS` AMENDED**, the who-authors clause: `cost-cap` is live on an image that declares `costCap` and only `model-not-allowed` stays reserved; the sentences themselves are unchanged. **Code evidence**: image/runner/src/usage-meter.mjs -> callCostBound, createCostGuard; image/runner/run-job.mjs. |
| 2026-10-02 | Issues #501 and #502, the shared seams for policy stops. **`REQ-JOB-STATUS-COMMENTS` AMENDED**, the who-authors clause: the worker's fixed terminal sentences gain the four policy stops, `cost-cap` and `model-not-allowed` (reserved, enforced by later changes) and `cost-cap-unenforceable` and `model-policy-unenforceable` (live: a job image that cannot enforce a cost cap or a model list before a call refuses before any call). Each is fixed and path-free and names neither the amount nor the model. The Statement and the Acceptance are UNCHANGED, checked: exactly one completion or failure comment per job, still. **Code evidence**: worker/src/processor.mjs -> TERMINAL_COMMENTS; worker/src/run-history.mjs -> RUNNER_POLICY_REASONS. |
| 2026-10-02 | Issue #524. **`REQ-AI-TRIGGERED-RUNS` AMENDED**, the Acceptance: `dispatch_run` and `/dispatch run` refuse a folder that is not a repository's root with a commit, with the CLI's own sentence, and say when the one-minute dedup swallowed a run instead of reporting a new job. The Statement, Scope and gate are UNCHANGED, checked: both checks are free and run before the enqueue, and neither path gains a force option. |
| 2026-10-02 | Issue #503, part 5 of the build list (keyless providers pass the credential gate). **`REQ-EGRESS-ALLOWLIST` AMENDED**, the Acceptance: a provider pi does not know, defined in the overlay `models.json` with `"apiKey": "$PI_DISPATCH_KEYLESS"` and every one of its models on a declared `keyless` endpoint, passes the free credential gate with no credential and gets `PI_DISPATCH_KEYLESS=keyless`; every other case is refused or keyed as before, and the refusal names both ways in; with `PI_EGRESS=0` the argv gains nothing. Every model and not some, because the agent can switch to any model of its provider. The exact `apiKey` is required because any other value is refused for what it is (a literal key in a mounted file, an unset `$VAR` that fails after the container started, or a `!cmd` shell), and (PR #520 round 1) a keyless provider carries no other credential of any kind (no `headers`, `oauth` or baseUrl userinfo) and no model entry without a string `id`; a transient overlay read at pickup is retried as infra, never refused. A provider pi knows stays keyed even with its baseUrl on a keyless endpoint, a named residual. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, the doctor credential clause: a keyless provider is ✓ exactly when the worker's verdict passes it, from the same function on the same declaration, and the ✗ for an unknown provider names the keyless way in. **`CONST-BUDGET-BEFORE-TOKENS` UNCHANGED, checked**: the keyless branch is a pure read of the pickup's snapshot inside the same free gate, after the image and job-user preflights and before the egress probe, the mint, the clone, the token-cap read and both reserves, so a refused keyless provider spends nothing (pinned in worker/test/scope-mutex.test.mjs). **`REQ-SPEND-CAPS-MULTI-WINDOW` UNCHANGED, checked**: the keyless branch reserves as any job does; part 7 (no dollar reservation for a zero-rated local job) moved to #501. **Code evidence**: worker/src/model-endpoints.mjs -> keylessVerdict, KEYLESS_HOW; worker/src/env-allowlist.mjs -> resolveProviderCredential, keylessEndpointsFor; worker/src/processor.mjs; worker/src/run-container.mjs; worker/src/start.mjs; worker/src/doctor.mjs -> noKeyVariableCheck; worker/test/env-allowlist.test.mjs; worker/test/scope-mutex.test.mjs; worker/test/doctor.test.mjs; worker/test/run-container.test.mjs. |
| 2026-10-02 | Issue #522. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**: the `.env` writer's ownership refusals are stated, and the group refusal is corrected. It compared the file's group with this process's, so on macOS, where a new file takes its folder's group, `up` refused every write into a `.env` that `init` had just made in a `wheel` folder (`/private/tmp`), and each path row ended with a value refusal's advice ("move the deployment somewhere without that character in its path") about a path with no such character. Now the group is measured on the new file, kept where this account is in the old group, and refused only where it would change; each refusal names its own fix (for the group: join it and log in again, or chgrp to this account's group, since another account meets the owner refusal first), and the value advice follows only a refused value (its errors carry `ENV_VALUE_UNWRITABLE`). The review added: `.env.tmp` is created exclusively (`O_EXCL`, `O_NOFOLLOW` where the platform has it) and chowned and chmodded through its descriptor, because a planted `.env.tmp` link in a folder another account can write was followed by the write, the chown and the chmod; an existing one is refused and left; this writer's own tmp is removed on any failure after its create (a flush or rename that throws, such as EPERM from a Windows scanner, had left it to block every later edit), the original error rethrown, and where it cannot be removed the error says where the content was left. The descriptor calls are optional on the writer's seam (test fakes have none), so every production seam spreads one list, `ENV_WRITER_FS`, and a test reads all four defaults: a seam that dropped one would quietly go back to calls by path. `init` is UNCHANGED, checked: setting this account's group on the new `.env` was considered and rejected, since it would undo a setgid folder's shared group. `DES-PODMAN-STACK-AS-QUADLET-UNITS` UNCHANGED, checked: its writer paragraph states the loader rules, which this does not touch. |
| 2026-10-02 | Issue #523 (`up` pulled `pi-job:latest` while `PI_JOB_IMAGE` named another image that was present). **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, one sentence in the Statement: on either venue `up`'s image step checks only the image the worker will run, `PI_JOB_IMAGE` by the worker's own rule (`jobImageFrom`) from this shell, else from `.env` through doctor's resolver (`resolveServiceEnv`). Unset keeps today's pull of `ghcr.io/edgehero/pi-job:latest` and its re-tag, which is load-bearing because the worker's default `pi-job:latest` has no registry behind it; set, the named image is checked by its own name and, only when absent and registry-qualified (first path segment holding a `.` or a `:`, or `localhost`), pulled under that name with no tag, while an absent short name is never pulled (a public registry would resolve it), nor a `localhost/` name (a locally built one, though `localhost:<port>/` is a registry and is pulled), and `up` says how to build or tag it; a `.env` the service's loader reads differently somewhere that spells the key is cannot-tell even where this shell sets it; doctor's missing-image fix line on both venues is that same text (one helper, `jobImageFix`), where it had offered ghcr's latest for any name on docker and a pull of a short name on podman; a shell and file meaning the same image (an empty value and `pi-job:latest`) are not a disagreement; a value only this shell sets is said to be one an installed service does not run; a shell and file disagreement, an unreadable line or file, or a value the worker refuses at boot checks and pulls nothing and says why. UNCHANGED, checked: which image the worker runs (`DES-PER-TRIGGER-JOB-IMAGE`, `--pull=never` in `INT-CONTAINER-RUNTIME-CONTRACT`); `up` still never pulls a trigger-named `run.image`; `doctor --fix` still offers the pull for the default only (`DES-CLI-SURFACE`). |
| 2026-10-02 | Issue #503, part 4 (slot leases). **`REQ-EGRESS-ALLOWLIST` AMENDED**, the Acceptance: a declared endpoint with `slots: 2` defers the third concurrent job whose main model it serves, local or forge, before any spend and never as a refusal, and runs it when a slot frees, fleet-wide with a declared worker name and one id per server, per host without, and per host always for a host alias name (a different server on each machine), never for an address; no declared endpoint takes no slot and changes no argv or record. **`REQ-SCOPED-LIMITS` UNCHANGED, checked**: an endpoint is not a scope, and the scope caps, the scope concurrency and the folder mutex are what they were; the endpoint gate runs after them and releases their slots when it defers. |
| 2026-10-02 | Issue #503, part 6 (doctor probes for declared model endpoints). **`REQ-EGRESS-ALLOWLIST` AMENDED**, acceptance only: with an endpoint declared under rules that include it, `doctor` proves it through the proxy with three probes (200 from `/v1/models` through the runner's tunnel, the proxy's 403 to a CONNECT on the next port, squid's own 403 to a plain forward request), each line naming the id and the proxy's status, which a job never sees; it fails an include inside the running proxy that differs from the render, read in the container because a renamed file leaves the container on the old one, and a mounted file (the proxy's own bind source) that differs from the proxy's copy, which is that replacement, and a refuted route; and it warns on a loopback overlay baseUrl and an allowlisted host alias. No declaration changes nothing. The Statement, Scope and the pre-spend reasoning are UNCHANGED, checked: every new check is doctor's, none is pre-spend, and the worker's argv and preflight are untouched. `CONST-BUDGET-BEFORE-TOKENS` UNCHANGED, checked: doctor spends nothing. |
| 2026-09-30 | Issue #511 (the steering scan misses lowercase twins, a second SDK hop and pi's own reads), folding its PR #513 gate rounds 1 and 2. **`REQ-TRIGGER-SECRETS` AMENDED**, the load-time clause: the steering set's derivation now reads both copies of pi-ai (hoisted, and the one nested under pi-coding-agent that the runner uses), follows each SDK's declared dependencies one hop further (google-auth-library, `@smithy/core`, the AWS credential chain), counts every occurrence that can reach the environment, pinned per file with a count, rather than matching accessor spellings, and adds pi's own `PI_*` reads minus `CONTAINER_ENV_NAMES` and the runner's own writes. Every name found is reserved, matched exactly, so `google_application_credentials`, `gcloud_project`, `google_cloud_project`, `GOOGLE_CLOUD_QUOTA_PROJECT`, `CLOUDFLARE_ACCOUNT_ID` and `PI_CODING_AGENT_DIR` refuse at load while `openai_base_url` stays bindable. The pre-spend clause gains one case: a job binding a load-time reserved name (queued before the set widened, a stored scheduler template, an older receiver) is refused as `secret-name-reserved` before the secrets resolver is called. UNCHANGED, checked: the per-provider reservation, the key-variable bound (another provider's key stays bindable), the refusal codes. |
| 2026-09-30 | Issue #503 (declared model endpoints), the second change. **`REQ-EGRESS-ALLOWLIST` AMENDED**, acceptance: a declared endpoint, rendered and reloaded, is a CONNECT tunnel to exactly that host and port; another port of the same host, a plain forward request to the declared port and a declared name resolving to loopback are refused; with nothing declared the include is its header alone; a missing include is named by `up`, `service install` and `doctor`, and no proxy starts without it. The opt-out, the per-job network and the pre-spend gate are UNCHANGED, checked. |
| 2026-09-30 | Issue #508 (plain HTTP reached every port of a listed host). **`REQ-EGRESS-ALLOWLIST` AMENDED**, the Statement and the Acceptance: a listed host is reached only through a `CONNECT` tunnel to port 443 or a plain request to port 80, and a plain request to a listed host on any other port is refused by the proxy; `doctor` proves that refusal beside both directions, on the `podman` venue under `--live`. Port 80 stays open, not HTTPS only, because some package mirrors and redirects still use it (the owner's decision). A forge a job pushes to must still be `https://` on 443, which `doctor` warns about, because git ignores the job's `HTTP_PROXY` for `http://`. |
| 2026-09-30 | Issue #509, the pi 0.80.7 -> 0.99.1 bump, one row for the runner and worker halves. **`REQ-TOKEN-ACCOUNTING-AND-CAPS` AMENDED** (mechanism, not contract): the process-wide meter's choke point moved from pi-ai's api-provider registry (no longer on a session's path) to ModelRuntime.prototype, with the registry kept for legacy extension calls; the brake covers classify/generateImages too; compaction now lands in otherTotal, and cache warming is off in every job. **`REQ-RUNNER-TURN-BUDGET` AMENDED**, evidence only: three loopback premises moved at 0.99.1 and are re-pinned (the throw after a tool ran now ends `2` / `retry-unresumable`, a queued follow-up starts no second run, the token budget's abort suppresses pi's retry); the bound and every count are UNCHANGED. **`REQ-TRIGGER-SECRETS` AMENDED**, the load-time clause: the steering set is re-derived against 0.99.1 and keeps `ANTHROPIC_AUTH_TOKEN` by name after pi made it anthropic's first key variable, so a version bump did not widen what a trigger may bind. UNCHANGED, checked: the exit-line `tokens` shape, the `usage` ledger shape and every exit code (INT-RUN-HISTORY-FILE-CONTRACT); the pre-spend per-provider reservation (it now reserves `ANTHROPIC_AUTH_TOKEN` for anthropic jobs through pi's own list); `REQ-DEPLOYMENT-BOOTSTRAP` (a host bearer token is a warning, like an OAuth token); `REQ-COST-ANALYTICS` (b) (an uncovered zero-rate run still renders `$0 (unrated)`; which providers are zero-rate changed, not the rule). |
| 2026-09-29 | Issue #492, with PR #493's review folded in. **`REQ-TOPOLOGY-GRAPH` AMENDED**, clause (h): the plan-covered spend badge now holds, because the fold keeps `plan:<id>` for a bucket every run of which ONE declared plan covers with no run a floor (it had returned only metered or estimated, so the badge read `~$0 est.` beside a by-model table saying `plan:kimi`); the badge fits its chip, cut with the whole text in a tooltip (a long plan id ran onto the wires); a narrowed close rule's label leads with its `#<n>` (the chip cut `action[closed]…` and dropped `#40`); a one-shot trigger carries `[once]` or `[spent]` on its chip. **`REQ-COST-ANALYTICS` UNCHANGED, checked**: its (b) is the rule this makes true; its (c) still demotes any bucket mixing plan and billed runs to estimated with coverage; its (d) holds because a plan bucket holding a floor stays estimated with its `≥` (the review found the first cut dropped it: a fallback-metered run cannot see subagent spend, and `plan:<id>` has no place for `≥`). A bucket two plans cover stays estimated too: the subscriptions validator accepts any non-empty id, so no separator could join two unambiguously (pinned against the parser). **`REQ-INSIGHTS-HTML-EXPORT` UNCHANGED, checked**: its (b) (a plan bucket draws a chip, no dollar bar) now applies to the trigger, flow and repo tables whenever a plan covers the whole bucket, which it always required. **Code evidence**: admin/src/costs.mjs (combineContributions); admin/src/graph-model.mjs (triggerMatchLabel); admin/src/graph-html.mjs (the status line); admin/test/costs.test.mjs, graph-html.test.mjs, insights-html.test.mjs (the issue #492 pins). |
| 2026-09-29 | Issue #484 (the folder's `egress-proxy.conf` went stale after an upgrade, and nothing said so). **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, one clause after the #480 scaffold: `doctor` warns (⚠) when the folder's `deploy/egress-proxy.conf`, or the podman venue's account-owned copy, differs from the installed package's file, for the shipped proxy with the policy armed, and is silent for an identical or absent copy; `up` offers the folder copy's refresh before its proxy step, asked even under `--yes` (the one action `--yes` does not accept, since the difference may be the operator's own edit), keeping a timestamped backup, writing through a same-directory temp file and a rename, refusing a symlinked copy or `deploy/`, and then offers `docker restart` of a running current proxy, and `docker unpause` then `docker restart` of a paused one (PR #491's review: an unpause alone resumed squid on the old file while `up` had said the rules were replaced), which `--yes` accepts unless job networks are attached. A copy that differs only in its line endings is said to. A declined refresh changes nothing. **UNCHANGED, checked**: `init` (still create-only; it never refreshes), `REQ-EGRESS-ALLOWLIST` (the rules' content and the policy), the consent contract for every other `up` action, and `service install`, which already compared the account copy and replaced it only under `--force`. |
| 2026-09-29 | Issue #480 (the no-clone quickstart started no egress proxy). **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, three clauses. (1) `init` scaffolds `deploy/egress-proxy.conf`, create-only, from the package's own copy (resolved from the module as `service.mjs` resolves its templates), and lists it. `up` needs that file and the allowlist in the folder before it starts the docker proxy, and a folder made by `npx @edgehero/pi-dispatch up` got the allowlist alone, so on the default policy `up` declined the proxy and every job was refused before it spent, while its own advice (run `init`, then `up`) could not help. (2) The docker next steps no longer name `deploy/docker-compose.yml`: step 2 is `pi-dispatch up`, which starts Valkey and the proxy (the compose line started no proxy either), and step 1's note no longer names `image/Dockerfile`; the sentence calling the docker text unchanged byte for byte is replaced by what is now true. (3) `up` runs `init` without its "Next:" ladder, which used to print mid-pass the steps `up` was performing; the created and kept lines stay, and init's name column is as wide as its longest name. The podman ladder's first line names the Podman guide by its URL rather than `docs/podman.md`, which a folder made without a clone has no copy of. The operator-facing remedies follow the same rule, revised by PR #488's review round 1: the egress-proxy refusal comment, the sandbox's network-failure message and doctor's proxy fix name `pi-dispatch up` from the deployment folder and no compose line at all (only `up` knows the folder, and a compose line printed without it would, in a folder `/dispatch setup` laid out, start a second Valkey under project `deploy`), and a proxy `PI_EGRESS_PROXY` names is the operator's to start; every later or fallback compose line `up` prints is printed only where the folder holds `deploy/docker-compose.yml`; the Valkey-unreachable hints of the CLI, `cancel`, `service` and the panel name `pi-dispatch up` only for a loopback `VALKEY_URL` (the only Valkey `up` starts) and otherwise ask about the Valkey at its host; the worker unit template's Valkey comment names `pi-dispatch up`; and a static test requires `--env-file` on every compose command in the sources, names each prose mention, and `composeArgs` is pinned to carry `--env-file .env`. Every `init` scaffold is written `wx` (never through an existing path, a dangling symlink included, which is reported kept), and `init` refuses, writing nothing into it and exiting 1, a `deploy/` that is a symlink or not a directory, and a directory where any scaffold's file belongs, listing every other file it wrote beside the refusal. `up` goes on past an `init` that refused or threw (said, and named in its summary) instead of aborting after the image pull, and neither `up` nor `doctor` treats a directory at either proxy file as the file: `up` starts no proxy on it and `doctor` fails naming it. Refusal reasons, log events and the run record are unchanged (only human text moved). **UNCHANGED, checked**: the consent contract (`init` still runs nothing and writes only create-only scaffolds; the proxy start is shown and asked as before), `REQ-EGRESS-ALLOWLIST` (the rules file's content, the allowlist scaffold and the policy are untouched), the podman ladder's steps and the podman venue (its unit mounts an account-owned copy `service install` writes, never the folder's). |
| 2026-09-29 | Issue #489. **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED in text, now true in fact**: its npm route (`npx @edgehero/pi-dispatch up`, a local `.bin`, a global install, `npx pi-dispatch-receiver`) never ran anything. npm installs a bin as a symlink, node puts the link in `process.argv[1]` and the resolved file in `import.meta.url`, and all three entry guards (`worker/src/cli.mjs`, `receiver/src/cli.mjs`, `receiver/src/start.mjs`) compared the two as strings or tested that argv[1] ended in the file's own name, so every such run exited 0 having printed nothing. `/dispatch setup` and the rendered service units call the files by path, which is why nothing shipped noticed. One exported helper, `isEntryModule` (`worker/src/entry.mjs`, `@edgehero/pi-dispatch/entry`), compares the real paths, and all three guards use it; `start.mjs` still does not boot when `cli.mjs` imports it. Also: `pi-dispatch --help` and `-h` now exit 0 as the receiver's already did. Pinned by tests that run each bin through a symlink. `INT-*` UNCHANGED, checked. |
| 2026-09-29 | Issue #481, with PR #485's review rounds 1 to 3 and its final review. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, the doctor `.env` bullet. On a fresh `init` the "service settings read from" line named sixteen keys, twelve of them blank. An empty value is now left off that line, its GitHub auth twin, the venue keys line and the ⚠ on each CLI variable the file sets, and it no longer counts toward the closing line's "doctor took a value from the file", but ONLY for a key on a proven allowlist (`EMPTY_READ_AS_UNSET`). CORRECTION of this row's first version: the first rule was a denylist (empty is unset, save `HOME`), and review round 1 showed it hid keys whose empty value is a value, `PI_TRIGGERS_FILE` (both processes refuse to start) and `GITLAB_URL` among them, and it claimed Podman reads `CONTAINER_HOST` and `CONTAINER_CONNECTION` with `os.Getenv(...) != ""`, which is false (it asks `os.LookupEnv`, and an empty one sends it remote). The allowlist holds a worker or receiver key only where the real loaders answer the same for it empty as absent (a test checks each, per value shape), and a CLI key only where its tool's source is cited. Three boot refusals that had no ✗ now have one: an empty or unknown `GITHUB_AUTH_SOURCE` (its value not shown unless short and plain, since a pasted token would print), `GITHUB_AUTH_SOURCE=pat` without a usable PAT or with an empty `GITHUB_PAT_VAR`, and a set `PI_TRIGGERS_FILE` naming no file. Review rounds 2 and 3, as settled by the final review: a credential those checks find missing from this shell and the `.env` (the PAT, the App ids and key, the provider key) is a ⚠ naming the `--env-setup` script only where every service installed for this folder that reads it names a usable script (a regular file after symlinks, readable by this account) and the worker's service is installed. This shell's `PI_ENV_SETUP` softens nothing (the first version of this rule fell back to it, so a unit rendered without `--env-setup`, or no unit at all, turned a boot refusal into a ⚠ and exit 0); where it is set and no such service names a script, the fix line says to install with `--env-setup`, and where no service is installed for this folder at all, that an `--env-setup` deployment may ignore the ✗. CHANGED behaviour, beyond this issue: the empty or unloadable `PI_PAUSE_WINDOWS_FILE` / `PI_SCOPED_LIMITS_FILE` downgrade follows the same rule, and no longer softens on this shell's `PI_ENV_SETUP` (issue #384 had it do so). The App id line says "unset or empty", as `loadGitHubAuth` refuses both. Where a credential was accepted as expected from the worker service's script, the ready line points at the service, which runs it, never at a hand-started worker, which runs none. The resolution (`resolveServiceEnv`) still carries every empty value, so each check that judges one is unchanged. The `local` backend's `nonRoot` asserter sentence, which doctor prints, gains the separators it was missing (same facts). **Every other requirement UNCHANGED, checked**, and `DES-CONTAINER-BACKEND-REGISTRY` UNCHANGED, checked: it paraphrases who asserts `nonRoot` and quotes no sentence, and no spec or doc quoted the old one. |
| 2026-09-29 | Issue #477, three findings of the round-446 final verification on pd-fedora, with PR #478's gate rounds 1 and 2. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**. (1) The `.env` reader's bare grammar takes an `=` inside a value: systemd 259 (measured on pd-fedora with `systemd-run -p EnvironmentFile=`), `/bin/sh`, bash, dash and zsh (E2 oracle rows, each run in every shell present) and the cmd wrapper's `tokens=1,*` keep `K=isolation=enforced`, `K=a=b=c`, `K=a==b`, `K=a=` and `K=a=:b` as written, so doctor judges the documented `PI_BACKEND_FLOOR=isolation=enforced` instead of calling it unread and reporting no floor; a leading `=` and an `=` after a `:` stay refused, as does every other shape, and the floor was the only documented `KEY=...=...` value (a test holds every uncommented `.env.example` line and each documented floor form plain to all three loaders). The writer shares that set, so it quotes exactly what the reader refuses bare (it had written a leading `=` or a `:=` bare), and refuses a value with a control or invisible character, which the reader never vouches for even quoted; over 600000 seeded writes only those shapes change, on Linux and macOS, Windows is unchanged, and every written value reads back plain. A refused line names the character refused, gives a leading `=` and a `:=` their own cause, and says to remove a control or invisible character. (2) Doctor's closing ready line: a foreground `pi-dispatch worker` reads its shell and no `.env`, so where doctor took any value from the file the line names the service by the command that starts its scope (`service install`; for an installed unit `pi-dispatch service restart` for a user one, `sudo systemctl restart <unit>` or `sudo launchctl kickstart -k system/<label>` for a system one; both commands on Windows) and says what a hand-started worker lacks, instead of "Start the worker with `pi-dispatch worker`" (the lab's worker dialled 127.0.0.1:6379 while doctor had judged the file's Valkey). Chosen over a foreground worker that reads `.env`: only VALKEY_URL would drain the deployment's queue under this shell's venue, provider and floor, and every service key would make the worker a `.env` loader whose spawned CLIs could disagree with its in-process readings, against `docs/secrets.md`. (3) `VALKEY_URL`: a path that is not a database number, or a scheme other than `redis:`/`rediss:` and their aliases `valkey:`/`valkeys:` (which connected before and still do, TLS for `valkeys:`, measured against Valkey), is refused where every client is made and a doctor ✗ (it had ended doctor and every client with an unhandled rejection); leading zeros spell the number; and a database the server does not have (`/16` on a default Valkey) is refused by every client, naming the index and the server's `databases` count, never used as database 0 (measured: ioredis went on on database 0). **`REQ-OPERATOR-JOB-CANCEL` AMENDED**: a removed job's past is read off BullMQ's `attemptsMade` (not `attemptsStarted`, which a hold's `moveToDelayed` increments), in the CLI and the panel's held-cancel footer alike (`ranBefore`): none is "it never ran; no record written", one or more is "it made N attempts ... whatever they recorded stays", no record promised, since a gate failing above the processor's `try` counts an attempt and writes none; the help text, skill, `docs/wait-for.md` and the `dispatch_wait_cancel` description no longer say a held job never ran or has spent nothing. **`REQ-ADMIN-VIA-PI-EXTENSION` UNCHANGED, checked**: `dispatch_wait_cancel` keeps its confirm dialog and writes no record. |
| 2026-09-29 | Issue #476 (the netns keeper judged too young on every stack start). **No requirement changed.** **`REQ-EGRESS-ALLOWLIST` UNCHANGED, checked**: no job runs on a keeper that does not hold by every rule of issue #458; a keeper whose only fault is its age now delays the job without an attempt (`INT-EGRESS-POLICY-CONTRACT`), and a crash loop is still not run, now named `netns-keeper-crash-loop`. **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked**: `service install` and `up` install and start the keeper as before; only the worker's boot line changed, which a fresh install no longer emits (measured on 4.9.3). **`REQ-OPERATOR-JOB-CANCEL` UNCHANGED, checked** (PR #479's gate): an active job whose cancel was acknowledged before the processor held it or handed it to a retry ran later; it now ends as the Statement says, `operator-cancel`, recorded, never retried. A cancel that lands after the worker stopped its poll to ask is not acknowledged and stays a named refusal, now worded by the job's re-read state: back in the queue (cancel it again to remove it), finished, or no longer in the queue. A cancel the worker acknowledged is recorded as `operator-cancel` whatever followed (an error, a container that exited in the same moment, a pre-spend refusal), and the worker acknowledges nothing once a run's outcome is being decided, so the ack's promise always holds. |
| 2026-09-28 | Issue #468. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**: clause (5) of the shared-host rule, a per-deployment Valkey password. `VALKEY_PASSWORD` in `.env` (a key of its own, not inside `VALKEY_URL`); `init` generates it into the `.env` it creates at mode 0600, `service install` and `up` add a missing one to the Valkey they start (never over a value, the file narrowed to its owner), none for a shared or operator-owned Valkey; the Valkey gets it through its environment and stdin, never a command line (measured: the image's PID 1, tini, kept `--requirepass <value>` readable by another account in `/proc/<pid>/cmdline` on Podman 5.8.1 and 4.9.3); every client sends it through the one connection function (URL userinfo, then environment, then the `.env` for a loopback host); a refused credential is a configuration refusal at every start and a ✗ in doctor; a Valkey without one is a doctor warning naming the upgrade step, which keeps the queue; the key is refused in `PI_FORWARD_ENV` and `run.secrets`; `up`'s docker Valkey is probed and published on `VALKEY_URL`'s port, not always 6379 (a follow-up in the same round); PR #475's review added the error scrub, the CLI's `VALKEY_URL` from the `.env`, and the restart offer's cost; its round 2 the scrub at every path (silentEmit, each command's reject), the rejection printer, `urlShown` for CLI URLs, the kill switch acting on both Valkeys of a disagreement (`--valkey-url` to name one), `PI_VALKEY_PORT`, and `up` starting compose's Valkey in a handed-over folder; its round 3 the ownership rule (a Valkey container or volume is this deployment's only by `up`'s label, compose's working dir, or a legacy container's port; nothing stops, removes, reuses or starts beside one that fails it, the volume asked before any start), `PI_VALKEY_PORT` written into `.env` and flagged by doctor on a disagreement, `--valkey-url` parsed as a flag and refused with a password, and the panel's pause and resume on the CLI's rule; and the volume gap it named (a volume with no container on it was used by a second deployment, measured): the volume labelled by its creator, another folder's never used, an unlabelled one adopted only on a question `--yes` does not answer, and the `pi-dispatch:owner` marker recorded and checked at every start. **`REQ-OPERATOR-JOB-CANCEL` AMENDED**: `cancel` refuses on a VALKEY_URL disagreement until `--valkey-url` names which, in either position (round 3). **`REQ-ADMIN-VIA-PI-EXTENSION` UNCHANGED, checked** (round 3): the pause and resume tools stay the only mutating model tools; which Valkey they act on is clause (5)'s rule. The discoverability bullet notes that `init` fills in that one key. `REQ-QUEUE-BURST-NO-DROP` UNCHANGED, checked: AOF stays on in all three carriers of the Valkey start, and the upgrade's restart keeps the volume (measured on both VMs). `REQ-TRIGGER-SECRETS` UNCHANGED, checked: `run.secrets` refuses the name through the reserved set it already derives from `WORKER_ONLY_SECRET_VARS`. Rebased over issue #471 (PR #474), whose rule is that doctor hands no program anything from `.env`: doctor starts NO Valkey any more (its `--fix` offer for an unreachable loopback Valkey is removed, since after this issue that `docker run` needed the deployment's VALKEY_PASSWORD in the docker CLI's environment), and the fix line names `pi-dispatch up`; doctor's own in-process AUTH check (its own client, no spawn) uses the resolved password; `VALKEY_PASSWORD` and `PI_VALKEY_PORT` join `SERVICE_ENV_KEYS`, the password in the secret set (named, never shown); the panel's Valkey clients and kill switch read the pointer's `.env` only, through #471's one reader (`readDeploymentEnv`), and the pointer module no longer aims a second reader. Round-cap re-review: an adopted volume's owner marker is read by an unpublished Valkey (`--network none`) before any Valkey on it is published, the adoption is recorded in the folder by the volume's `CreatedAt` (0600, create-only), the wizard adopts nothing and names `up`, and the wizard's compose steps no longer carry a shell-exported VALKEY_PASSWORD, which compose preferred over `--env-file .env`. |
| 2026-09-28 | Issue #471. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, the doctor `.env` bullet and one Acceptance sentence. doctor judged about thirty keys from its own shell while the service read them from `.env`, so a ✓ could describe a setting the worker never used (and a `.env` value the worker refuses to boot on got no line). Every key the worker or the receiver reads that doctor judges now joins the allowlist and is resolved ONCE by one module shared with the admin panel, by the rule doctor already applied to the venue keys and `PI_WORKER_NAME`: this shell's value, else the file's plain line; a disagreement is a ✗ naming both values (a credential by name only, a URL without its credentials) and doctor judges this shell's; a line the loaders read differently is a ✗ naming the line, its value unused. doctor cannot tell a service from a worker started by hand from its shell and does not guess: agreeing sources need no answer, differing ones fail. A value that steers a spawn, a connection or a write is judged as the worker judges it first (the job image by the worker's empty-means-default rule and its `run.image` refusals, which also fixes doctor inspecting an image named "" where the worker takes the default; the Valkey by the owner rule; the in-image probe's PAT by the worker's own lookup; a `.env`-only session store offered at the prompt tier), a child process gets this shell's environment and never the file's values, and a forge URL is printed without its credentials. A bolt test fails when doctor reads a service key from its environment outside the resolver, generalising #464's `PI_WORKER_NAME` bolt. `PI_ENV_SETUP`, `XDG_DATA_HOME` and `DOCKER_CONTENT_TRUST` stay this shell's, as the issue asked. Follow-ups in the same PR: the worker now refuses to boot (exit 2) on a `PI_JOB_IMAGE` the shared image rule refuses (a leading dash booted before); a relative `PI_TRIGGERS_FILE` resolves against the deployment folder, as the worker's own read does; the session store's path and bounds reach the terminal escaped; the overlay comparison's host pi setup is confirmed as this shell's (the worker never reads it for the overlay; `import-pi` does, from this shell); and the podman, docker and gh variables a `.env` sets reach doctor's own spawns of that CLI and its conf-chain check, since the worker's inherit them, a disagreement on one reported like any key. PR #474 gate rounds 1 to 3, ending at the round cap: a `.env` another account can change (the file, its folder or any directory above them, read through one descriptor) gives doctor and the panel no value at all (a containers.conf it named made doctor's `podman info` run a program, measured), and the refusal names the owner, mode and group truthfully; no program doctor starts is handed anything from `.env` (three rounds of rules for handing CLI variables on safely each left a hole: a flipped link, a missing tail under `/tmp` created in time, a socket wrongly held back), each CLI variable the file sets is one ⚠, and the containers.conf chain check still judges the file's chain in-process; the service keys only this shell sets are named where a worker unit for the folder is installed; the panel reads the pointer's `.env` only (a cwd scaffold, which a repository can commit, was dropped); `run --image` and a queued job's image follow the one image rule; a refused `PI_JOB_IMAGE`'s substituted default no longer says it came from `.env`; and the residual (a deployment folder is trusted exactly as far as the service trusts it) is stated. The rest of the requirement UNCHANGED, checked: the `ENV_FILE_READABLE_KEYS` two-subject rule for `PI_PAUSE_WINDOWS_FILE` and `PI_SCOPED_LIMITS_FILE`, the consent contract and the `--fix` tiers other than that one store. |
| 2026-09-28 | Issue #448 (containers.conf keys that reach a job, rootful `local` and the rootless `podman` venue), with gate rounds 1 to 3 of PR #473 folded in. **No requirement changed.** **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked**: `up`, the wizard and `service install` read no containers.conf; doctor carries the new lines; a stock host's chain on either venue (the vendor's `default_sysctls` block and the empty `[engine.runtimes]` header included) passes, so a stock deployment boots as before. **`REQ-RESURRECTABLE-SANDBOX` UNCHANGED, checked**: a sandbox is refused for what a job is refused for (`INT-SANDBOX-CONTRACT`), which its Acceptance leaves to the contract. **`REQ-EGRESS-ALLOWLIST` UNCHANGED, checked**: the refused keys are refused whatever `PI_EGRESS` says, and the inert network keys change nothing either network reaches. |
| 2026-09-28 | Issue #464. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**: a new clause, one account's deployment never takes another account's state on a shared host, with four rules: the per-account default jobs dir (`<tmp>/pi-dispatch-<euid>/jobs`, the sandbox and graph defaults under the same root, created `0700`, another account's root or jobs dir refused at boot as exit 2 and before each job, the root judged by `lstat` before anything is created so a symlink squat is that refusal and not a raw `EACCES` (gate round 1), an explicit sandbox dir another account owns refused the same way and at each retention (gate round 1), and doctor's ✓/✗ line for it, judged with the `.env`'s `PI_JOBS_DIR`, `PI_SANDBOX_DIR` and `TMPDIR` and with no retained ✓ after a ✗, plus a ⚠ for this account's retained workspaces left under the old shared default, whose move names the root in its `mkdir -m 700`); `service install`, `up` and doctor on the podman venue taking a Valkey that answers `VALKEY_URL` only when it is this account's (gate round 1: every address the URL's host resolves to, IPv4 and IPv6, judged by the owner of its socket in `/proc/net/tcp` and `tcp6`; gate round 2: every Valkey client in the repo (the worker's, the CLI's, the receiver's, the admin's, doctor's) built through connection.mjs' judging connector with a bolt test refusing any other construction, judged by the worker itself at boot, exit 2 on a refusal, and every worker client pinned to the judged literal address with the TLS name kept, unspecified addresses as this host's loopback, this account's first answering address chosen and another's elsewhere named, subuid ranges from `getsubids` where installed, `PI_VALKEY_SHARED` from `.env` only, the lookup bounded, and doctor talking to no refused Valkey; this account's uid or a subordinate uid from `/etc/subuid` only, root, system and other accounts refused by name with no uid range deciding it; `PI_VALKEY_SHARED=1` in `.env` the one named opt-in; `install --force` no longer takes it; `up` exits non-zero on the refusal and reads `VALKEY_URL` from `.env`, stopping on a shell/.env disagreement; doctor ✗ by the same function; gate round 3: one rule for every client whatever its cwd or venue, another account's listener refused on the local venue too, root's (and an owner no row names) refused only where the deployment's venue is podman without local, `PI_VALKEY_SHARED` never from the environment even with no `.env`, the `.env` read as bytes through the hardened reader with any hazard named, an unresolved or unanswered lookup retryable rather than another host, a failed judgement retried by the client rather than ending it (a Valkey restart stopped the worker), the receiver judging before it listens and exiting 2 on a refusal, and the bolt test matching any string literal naming ioredis or bullmq and `createRequire`), with `VALKEY_URL`'s port as the way out and the Quadlet Valkey published there; `service install` writing every file before any command and putting back what it wrote when a write fails, naming what remains otherwise; and doctor naming rootless Podman whose `/run/user/<uid>` is gone after linger was switched off, only when Podman's database records a run root there (gate round 1: an account that never had a session was misnamed), with `podman system migrate` named as not a fix (measured). Acceptance gains one sentence per rule. `doctor`'s `SERVICE_ENV_KEYS` gains `PI_JOBS_DIR`, `PI_SANDBOX_DIR`, `TMPDIR`, `PI_VALKEY_SHARED` and `PI_WORKER_NAME` (resolved once, this shell's else the `.env`'s, and every reader uses that value: the fleet line and its routing warning, the per-host backend wording, and which cron triggers count as scheduled here), read under the existing clause's rules; a `VALKEY_URL` line doctor cannot read makes it contact no Valkey (it pinged the default 6379, another account's on a shared host). `.env.example` gains `PI_VALKEY_SHARED`, commented out. Follow-ups in the same round: the per-account root also holds the run history and the settings overlay on an account with no home (secured at boot and by the overlay write, doctor ✗ when another account owns it), and `up`'s Quadlet writes gained the same journal and put-back as `service install`. **`REQ-DURABLE-RUN-HISTORY` AMENDED**, one Acceptance sentence for that no-home fallback. Nothing else in either requirement changed, checked. |
| 2026-09-28 | Issue #470, with PR #472's gate round 1. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, two clauses. (1) The `.env` rendering bullet: on Windows the list of what the cmd wrapper cannot take (`%`, a double quote, a line break) becomes what the writer refuses because the wrapper cannot be shown to carry it (a line break or another control character, a double quote, `%`, `!`, `^`, a character outside ASCII, an `=` at the start of the value, and an empty value, which removes the key there), and the writer now judges the whole file as `deploy/worker-env-wrapper.cmd` reads it, refusing by name a line that names the key in another case, with an indent or a blank before the `=`, bare, or after a leading `=`, and file-wide a name holding a `!`, a `^` or a character outside ASCII. Linux and macOS verdicts of that change are byte-identical (100000 seeded files against a892408). (2) Clause (1) of the env-setup passage: the wrappers captured `PI_ENV_SETUP` before the load, but a `.env` line naming their own copy (`env_setup=` in sh, `ENV_SETUP=` in cmd, in any case) replaced it and named a script they ran. Every variable a wrapper reads is now assigned after the load from a value no `.env` assignment line reaches, the worker gets the unit's `PI_ENV_SETUP` rather than the file's, and `up`, the wizard and doctor name a line assigning a wrapper's own variable on macOS and Windows; Linux, which runs no wrapper, is unchanged. The rest of the requirement UNCHANGED, checked. |
| 2026-09-27 | Issue #447, folding its gate rounds 1 to 4. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, two passages. The Statement: `up` (with `service install` and the wizard) refuses, before writing anything, a `.env` that spells a venue key where a loader could read it and has a line systemd splits differently from the reader (a lone CR, a reopened quote, a quoted value under a non-identifier key, a missed continuation, a quoted value whose extent the reader's model gets wrong), any `.env` systemd will not load (a NUL, or a key or value that is not valid UTF-8 or holds a Unicode noncharacter; round 2 added the noncharacters), an environment too large for systemd to exec the service with (round 3), and a venue value over 4096 bytes (round 2, worded in round 3 as the project's own cap), naming the line, the shape and the change; and every key `up` or the wizard writes is read back from the new text first (round 2), so a key that would land inside a continuation or an open quote is never reported written, and a key the service's loader already reads as set is never overwritten (round 3: `up` had replaced an operator's WEBHOOK_SECRET that only a shell read as quoted; round 4: on macOS a file with a shell hazard is not edited, and on Linux an `export`-only key is named with its line instead of "already set"). The doctor bullet: its claim that systemd continues "a trailing backslash and nothing else" and that "a quote does NOT carry" was wrong for a value that opens with a quote (measured on systemd 259); it now says so, that doctor's systemd reading treats a key line inside such a value as part of it, names the same shapes as a file it cannot read, and FAILS on a file systemd will not load; and that a `#` comment ending in a backslash continues nothing, for systemd (measured on 259) or a shell (sh, bash, dash, zsh), where the reader used to refuse the next line. The consent contract is UNCHANGED, checked: a refusal runs nothing, and `up`'s own `.env` writer refuses rather than rewrite bytes or write a key its loader would not read. |
| 2026-09-28 | Issue #462 and three ledger items from PR #456's final check. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, two clauses. (1) `up`'s consent lines are each a command: the proxy network's create was shown as `docker network create pi-dispatch-egress-out   (only if it does not exist yet)`, which is not one, while `--yes` "runs exactly the lines shown"; a read-only `docker network inspect` now runs before the question, and the create is shown, and run, only when the network is missing; and since it can be removed while the question waits (PR #466 gate round 1, measured: `docker run` then failed "network not found"), it is asked again at run time and made when missing, said with its command when its line was not shown. (2) A shipped proxy whose image, entrypoint or command differs is offered the replace even while one of its mounts cannot be compared on this host (Docker Desktop reports every bind source as a path of its VM, so such a proxy was never replaced; how Desktop reports those three fields is not measured, and the offer is shown and asked either way); one stale on its mounts alone is still not, and doctor's fix now names the commands for that case rather than an offer `up` would not make. Doctor's rendering (issue #462): twelve checks returned `ok: true, warn: true`, which `render` prints as a ✓ with no fix, since it reads `ok` first; each is now a warning (`ok: false, warn: true`, ⚠ with its fix, never failing the run or the exit code) or a fact line with its advice in the label, pinned through `render`. `--fix`'s re-check line counts in the same tiers ("N pass, M warning(s), K failing"), where "N of M pass" counted every ⚠ as not passing (PR #466 gate round 1). With `GITHUB_AUTH_SOURCE=app`, an unset or non-numeric `GITHUB_APP_ID` or `GITHUB_APP_INSTALLATION_ID` is now ✗, not ⚠ (gate round 1): unset, the worker refuses to boot, and non-numeric, no github job can mint its token; so are the three key lines `loadGitHubAuth` also refuses the boot on (no key set, both key forms set, a key path that does not exist), each now saying "the worker will refuse to boot"; only the key's hygiene lines (mode, PEM shape) keep the github block's mid-setup ⚠. Round 2: those keys, and `GITHUB_AUTH_SOURCE`, are read from the deployment's `.env` where this shell sets none, through the same `SERVICE_ENV_KEYS` allowlist (the doctor `.env` bullet is amended to say so, with the key never printed), and a blank `GITHUB_APP_PRIVATE_KEY_PATH` counts as unset as `loadGitHubAuth` trims it. `up`'s one run-time exception, a network removed while the question waited created anyway and announced, is now in the Statement too. The ✓/⚠/✗ tiers and "a ⚠ never fails doctor" are UNCHANGED, checked. **UNCHANGED, checked**: `REQ-EGRESS-ALLOWLIST` (the worker's preflight still retries through Podman's `stopped` once; only doctor's line for it changed, to ✗), `REQ-RESURRECTABLE-SANDBOX` (the sandbox banner now prints after the last refusal, `INT-SANDBOX-CONTRACT`; what opens and when is unchanged). |
| 2026-09-27 | Issue #458 (PR #463, gate round 1). **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, one clause of the podman sentence: `up` starts the proxy's rootless network keeper beside Valkey and the proxy, while the egress policy is armed, through the same installer (`DES-PODMAN-STACK-AS-QUADLET-UNITS`). Nothing else in the requirement changed, checked. `REQ-EGRESS-ALLOWLIST` UNCHANGED, checked. |
| 2026-09-27 | Issue #453. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, three clauses, the first two revised by the PR's gate rounds 1 to 3 and the round-cap re-review. (1) `up`'s docker egress step counts the proxy present only while it is running (`{{.State.Status}}` `running`, the word that names a paused or crash-looping container) and current (the pinned squid with its own entrypoint and command, this folder's two files mounted and no other mount but its volumes; mounts whose sources do not resolve on this host are unknown and never a reason to replace it). A current stopped one is offered `docker start` (a paused one `docker unpause`), a stale one, running or not, `docker rm -f` and the shipped run, naming the job networks the removal would cut off, which `--yes` does not cover for a running proxy carrying them (round 3); an operator's `PI_EGRESS_PROXY` container is reported and never started; and neither is offered from a folder lacking `deploy/egress-proxy.conf` or the allowlist, which a start would mount as a directory (measured). The "never replaces a container it did not start" sentence is CORRECTED to what is true: never without showing it and asking, never at all on the podman venue, and on docker only the shipped proxy's name. (2) `init` and `doctor` decide the venue exactly as `up` does, from this shell or the deployment's `.env`, and a disagreement is said (doctor ✗, init no steps); doctor used to read its shell alone, so the ladder's own `doctor` step judged docker on a podman-only deployment (measured). The paragraph on doctor's narrow `.env` read gains those three keys and, in gate round 2, `VALKEY_URL`, `PI_PROVIDER` and the provider key's presence (the ladder's own `doctor` step failed on a key and a Valkey URL the service did read, measured), each said with its source and no secret printed, stated as the review it asks for; round 3 put every one of those reads behind one allowlist and one loader mapping and blanked control bytes in the fleet host names a chosen Valkey returns, and the re-review has doctor print a URL as scheme, host, port and database only (no userinfo, query or fragment; `<no host>`, `<unparseable URL>`) and blank C1 controls too. (3) `init` prints the podman ladder, linger named first and `doctor --live` last, when podman is the only venue on Linux, a refusal line off Linux, and the docker text otherwise, byte for byte. The consent contract is UNCHANGED, checked: `start`, `unpause`, `rm -f` and the run are each shown before they run and `--yes` runs exactly those lines, and `init` still mutates nothing but its own create-only scaffolds. **UNCHANGED, checked**: `REQ-EGRESS-ALLOWLIST` (the policy, its proxy image and its per-job networks are untouched; a stopped proxy was already a pre-spend refusal, and the worker's own preflight now reads the same Status rule). |
| 2026-09-27 | Issue #446 (the two windows left after #429), folding its PR #457 gate rounds 1 to 3 into this one row. **`REQ-RESURRECTABLE-SANDBOX` AMENDED**, the Bounded bullet and the Acceptance. The bullet keeps its promise that `0` sweeps what an earlier setting retained and adds that a lowered window applies to retained runs too (decided under #446: shortening applies) while a raised one does not extend them; it records the manifest's new `retainUntil`, the earlier-of rule that lets a reader with a longer window end a run where the worker does, that a run at the end of its window opens only with `--pin`, and that the one open the refusal cannot see is held by the sweep's re-ask or reported: removed as swept at the launch check, or said after the shell exits and never removed later. The Acceptance gains the #446 clauses: the past-window refusal (also for an opener whose window is larger than the worker's), the pin first and a failed pin refusing, a lowered or zero window sweeping retained runs, a pin during a large delete reporting the run gone, a crash between rename and delete recovered by the next pass, and a stuck delete named by doctor. The Statement and the Scope are UNCHANGED, checked: nothing about who may open a run, or from where, moved. **`REQ-EGRESS-ALLOWLIST` UNCHANGED, checked**: the session network is created and removed as before. |
| 2026-09-27 | Issue #451 (the Google, Vertex and Bedrock refusal shapes). **`REQ-OPERATOR-FAILURE-NOTIFICATION` UNCHANGED, checked**: the new shapes end as the existing `provider-auth-refused` token, which the hook already pages once per paid policy terminal; no reason is added. **`REQ-LOCAL-JOB-VISIBILITY` UNCHANGED, checked**: the same token rides the same fixed-enum field. **`REQ-JOB-STATUS-COMMENTS` AMENDED**, its #437 clause and the stop's sentence: the parenthetical "(HTTP 401 or 403)" becomes "(an authentication or permission error)", because a bogus Google AI Studio key is HTTP 400 `API_KEY_INVALID` and now ends as `provider-auth-refused` (`INT-RUNNER-EXIT-CODE-PROTOCOL`); the sentence stays fixed and path-free, and exactly one completion or failure comment still holds. **Code evidence**: worker/src/processor.mjs -> TERMINAL_COMMENTS (pinned by worker/test/processor.test.mjs); docs/notifications.md. |
| 2026-09-27 | Issue #449 (a retry turn is not a budget turn), with PR #455's gate rounds 1 and 2 folded in. **`REQ-RUNNER-TURN-BUDGET` AMENDED**: a new **What counts** bullet (every `turn_start` except the one opening pi's own auto-retry of a turn that made NO progress, meaning no tool ran and no reply completed, tallied as `retryTurns`; the flag clears on `auto_retry_end` and on `agent_settled`), the tool guard's reason (a retry-shaped throw after a turn's tools ran is a new turn, and exempting it laundered 9 paid calls at `--max-turns 1`) and the completed-reply guard's (round 2: a fault after a clean reply let a queued follow-up run as exempt new work, 6 paid calls at `--max-turns 1`; with nothing queued the same fault rejects `session.prompt()` as exit `1`, retried, the right class for its likely cause, such as a session-store fault; the `agent_settled` clear is kept as a safeguard), the plain statement that compaction continuations still count including the overflow one that re-runs a turn and what that means under `--max-turns 1`, the bound restated as at most `maxTurns * PI_RETRY_MAX` retry calls uncounted BY THIS EXEMPTION (calls never counted before stay so), an evidence bullet citing the pinned 0.80.7 dist line by line and naming the real-`AgentSession` loopback pins in `pinned-api.test.mjs`, and two Acceptance sentences (a recovered 429 under `--max-turns 1` exits `0`; an unrecovered one exits `1`, not `turn_budget`). **Pre-existing defect fixed in the same entry**: every `turn_start` past the cap re-aborts (one abort ended only the run in flight, and a queued follow-up's new run went on, 7 paid calls at `--max-turns 1` on main); the fallback per-session token budget (`REQ-TOKEN-ACCOUNTING-AND-CAPS`, `image/runner/src/token-budget.mjs`) re-aborts every `turn_start` after its breach for the same reason, since pi retries a failed breaching turn with a fresh signal; the statement of that requirement is UNCHANGED, checked, and the process-wide meter's own brake already answered every later call. |
| 2026-09-27 | Issue #431 (the `podman` venue reads `egress` back). **`REQ-EGRESS-ALLOWLIST` AMENDED**, the Why and the Acceptance: the proof that the policy works both ways, through the runner's own route, now also runs on the native `podman` venue, from `doctor --live` under the worker account's own Podman (where that venue's proxy is), with its probe containers built as a podman job's, and spawns no `docker` command there. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, one clause of the `--live` mutation sentence: on the podman venue the egress canary is among what `--live` runs, named before it starts and removed in the same run or by the next `--live`, the same shown tier. **UNCHANGED, checked**: `REQ-RESUMABLE-SESSION`, `REQ-RESURRECTABLE-SANDBOX` (no session or sandbox path is touched) and every job's pre-spend gate (the worker's egress preflight is untouched; the canary is doctor's). |
| 2026-09-27 | Issue #430, review round 2. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, one clause: `up` refuses when this shell and the deployment's `.env` set a venue key differently, where round 1 only warned, since it would otherwise stand up one venue while the service ran the other. A refusal still runs nothing, so the consent contract is UNCHANGED, checked. |
| 2026-09-27 | Issue #430, review round 1. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, one sentence: `up` decides the venue from this shell where it sets a venue key and otherwise from the deployment's `.env` (the file `service install` reads), and never replaces a container it did not start. The consent contract is UNCHANGED, checked: every host mutation is still shown first, and a refusal runs nothing. |
| 2026-09-27 | Issue #430. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, one sentence: on the native `podman` venue `up` pulls the default image into the account's own Podman store and starts Valkey and the egress proxy as Quadlet units through the installer `service install` uses, showing every write and command before consent and never running docker for a list without `local`. The contract is unchanged in kind: every host mutation is shown first, `--yes` waives consent and never visibility, a declined step continues, and `.env` is filled only where empty (the wizard's `PI_BACKENDS=podman` line goes through the same never-clobber writer). **`REQ-EGRESS-ALLOWLIST` UNCHANGED, checked**: the podman proxy is the compose digest (a test holds them equal) with the same two mounts. |
| 2026-09-27 | Issue #433. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, the Why's prompted tier: on a deployment whose `PI_BACKENDS` does not list `local`, `doctor --fix` offers the deployment's own default image as a podman pull and tag into this account's store (the store the podman venue's jobs start from, and the line that is that deployment's image check), and does not offer the loopback Valkey's `docker run`, since doctor spawns no docker there at all. The tiers themselves are unchanged: the image is still only the deployment default, never a trigger-named one, and still prompted with a default of No. Statement and Acceptance UNCHANGED, checked: `up` is untouched by this change, and no acceptance names a docker line of doctor's. |
| 2026-09-26 | Issue #429. **`REQ-RESURRECTABLE-SANDBOX` AMENDED**, the Acceptance only: a run is refused when its venue has no sandbox launcher or when the opener's own `PI_BACKENDS` does not bless it, where it used to be refused for any venue but `local`; a `podman` run on a host that blesses podman opens through the `podman` CLI only, as the opening account under keep-id. The Scope's "a venue this host holds" is UNCHANGED, checked: it already said held rather than local, and "held" is now the launcher and the blessing. **`REQ-EGRESS-ALLOWLIST` UNCHANGED, checked**: a podman sandbox joins the same kind of `--internal` session network with egress on, created in podman, and names `--network=private` with it off. |
| 2026-09-26 | Issue #428, review round 2. **`REQ-EGRESS-ALLOWLIST` AMENDED**, the Acceptance again: an unlisted request costs no DNS query, REVERSE included. The allowlist ACL did a PTR lookup for every unlisted IP-literal request (measured), a second DNS channel out of the same class as round 1's; it is now `dstdomain -n`. The Statement is UNCHANGED, checked. |
| 2026-09-26 | Issue #428, review round 1. **`REQ-EGRESS-ALLOWLIST` AMENDED**, the Acceptance again: the address deny covers this host's FIXED loopback and link-local addresses (a host mapped elsewhere is the podman venue's refusal to close, not the proxy's), and the proxy resolves no unlisted name, since the first form of the rule resolved every name asked for (measured), a DNS channel out. The Statement is UNCHANGED, checked. |
| 2026-09-26 | Issue #428. **`REQ-EGRESS-ALLOWLIST` AMENDED**, the Acceptance only: a listed name that resolves to this host's loopback or link-local addresses is refused by the proxy too. The proxy's first rule now denies those destinations (and slirp4netns's `10.0.2.2`), because on rootless Podman an account's containers.conf can map the host's loopback into the proxy's own network (measured). The Statement is UNCHANGED, checked: "nothing else beyond this host" bounds what lies OUTSIDE this host, and what a job reaches on the host itself stays the residual `DES-EGRESS-DENY-ON-A-DEDICATED-NETWORK` names; the deny narrows the proxy's side of it, and the podman venue's refusal of a widening containers.conf (`DES-PODMAN-NATIVE-ROOTLESS-BACKEND`) is the closure. No other requirement names the podman venue, so none changes. |
| 2026-09-26 | Issue #437, review round 1. **`REQ-JOB-STATUS-COMMENTS` AMENDED** in its #437 clause: the `provider-auth-refused` sentence covers a refusal of access as well as of the credential ("Stopped: the AI provider refused this worker's credentials or access (HTTP 401 or 403). The operator needs to check the provider key and what it is allowed to use. Not retried."), since a 403 is often a key that works but may not use that model or route. Still fixed and path-free. **`REQ-OPERATOR-FAILURE-NOTIFICATION` UNCHANGED, checked**: the hook still fires once per paid policy terminal; its reason set is now derived from the runner's named reasons, which changes no member. |
| 2026-09-26 | Issue #437. **`REQ-JOB-STATUS-COMMENTS` AMENDED**, one clause: the worker-authored stops gain `provider-auth-refused`, the exit-2 stop whose runner named a provider's 401/403 refusal of the credential, with its own fixed, path-free sentence telling the requester the operator must check the provider key (before it, such a job was recorded as an infra failure, retried, and commented as the generic failure). The acceptance ("exactly one completion or failure comment") is unaffected: the new row replaces the runner-policy sentence for that stop, it does not add one. **`REQ-OPERATOR-FAILURE-NOTIFICATION` UNCHANGED, checked**: "an in-container policy stop" already covers it; the hook now names it `provider-auth-refused` in argv rather than `runner-policy`. **`REQ-LOCAL-JOB-VISIBILITY` UNCHANGED, checked**: the `job_completed` line carries the new reason token through the same fixed-enum field. **Code evidence**: image/runner/src/outcome.mjs -> providerAuthRefused; worker/src/run-history.mjs -> RUNNER_POLICY_REASONS, parseExitReason; worker/src/processor.mjs -> TERMINAL_COMMENTS; worker/src/start.mjs -> HOOK_POLICY_REASONS. |
| 2026-09-25 | Issue #427. **`REQ-EGRESS-ALLOWLIST` AMENDED** in two bullets. The provider bullet gains the runner's restore: the #202 measurements were of the SDK on its own, and loading the pinned pi (0.80.7, npm `undici` 8.5.0) replaces the dispatcher `NODE_USE_ENV_PROXY=1` installs, so with egress armed every job's provider call went direct and died at its first turn (measured in the job image: `401` through the proxy before the import, `ENOTFOUND` after it). The runner now re-installs an env-proxy dispatcher from pi's own `undici` once pi is loaded, before auth and any spend. The doctor bullet: the canary loads pi and takes the runner's own module, because a plain `fetch` proved only the flag and stayed green throughout, and on an image whose runner predates the fix it says so instead of reading either direction as the policy. The per-job pre-spend checks are UNCHANGED, checked. |
| 2026-09-23 | Issue #394. **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked**, and it is the entry the change had to be measured against rather than one that moves: `up` still fills only a key with no value, still never creates the file, and still writes nothing a loader reads differently. What moved is one line of its output. `setEnvKeyIfEmpty` kept the line it replaced as a comment above the new value, to preserve the INLINE documentation `.env.example` used to carry on each key's own line; issue #392 moved that documentation to comment lines ABOVE the key, where this transform never touches it, so the kept line became a bare `# KEY=` stub whose only purpose was to carry text it no longer carries -- four of them in every `up` deployment. A bare commented key is dropped now and anything else is still kept, because a hand-written `.env` may carry an operator's own note on that line and deleting it was the defect the keeping exists for. **The three consumers of a `.env` disagree about `$`, and the file now says so**: `PI_JOBS_DIR=$HOME/jobs` is literal characters under systemd 252 and an expansion under a sourcing shell and compose v2.33, so one file puts the jobs in two places on the two deployments this repo ships. The reader already declines to vouch for such a value on both POSIX loaders (`$` is outside `UNQUOTED_PLAIN`, the reader's own bare-value set -- not the writer's `UNQUOTED_SAFE`, which has no part in reading), so doctor names the line for the two keys it reads; the header states the rule for every other key, which is the part no reader covers. Refusing `$` at load was rejected as needing its own measurement of what operators already have in the field. |
| 2026-09-23 | Issue #388. **No entry changed.** Two revision rows in this file rendered TRUNCATED: a row's Change cell ends at its first unescaped `\|`, the table declares two columns, and GitHub discards every cell after the second, so the rest of the row was never on the page. The 2026-08-12 row lost about 1,100 characters after `/dispatch insights html [7d`, and the 2026-07-31 row about 2,800 after `{ authorized }`. Both are repaired in place, one by escaping the pipes inside the code span and one by writing the alternation as prose, and neither row's claims are altered. A guard now derives the rule rather than trusting it: `.github/scripts/revision-row-check.mjs` requires every row of every spec's revision table to split into exactly two cells on unescaped pipes, which is the one property of such a row that a reviewer CANNOT see in a diff. |
| 2026-09-23 | Issue #379, the reaper's two questions and three bounds. **`REQ-EGRESS-ALLOWLIST` AMENDED**, the canary leftovers clause: a RULE replaces the list of producers. Every canary object is removed in that run's own `finally` or reported in the same run, so what a later run finds is what a KILLED run left. Naming producers instead was a list nothing derived, and a third producer would not have failed anything. Making the rule true cost one repair: the `finally`'s `rm -f` of a probe that would not go dropped its result, so that probe went unnamed until the next run swept it; it is reported immediately now, in the words the sweep would have used. **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked**: doctor's tiers, its never-tier fixActions and what it may mutate unprompted are untouched -- what moved is when a line is printed, not what doctor is allowed to do. **Code evidence**: worker/src/doctor.mjs -> egressChecks, CANARY_LINES; worker/src/backend-local.mjs -> reapNetwork. |
| 2026-09-23 | Issue #384, and the boot defect it uncovered (#392). **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, the `.env` bullet rewritten around TWO SUBJECTS and one measured grammar. (1) The service is judged whenever the file assigns the key, whatever this shell says, because the shell never reaches it; this shell is judged whenever it sets the key; a refusal on either fails the command. The shell-first rule it replaces exited 0 on a deployment whose service cannot start, which is the defect. (2) The loader is the PLATFORM's, derived from what `service.mjs` renders, rather than a systemd-plus-wrapper pair asked everywhere: `export KEY=` alone is invisible to systemd and an empty value to the only loader macOS has, so the pair was wrong in both directions. Compose's `env_file:` is named as a fourth parser rather than modelled. (3) The reader now CLAIMS ONLY the shapes every loader reads the same way, measured against systemd 252 in a privileged container and against sh, bash, dash and zsh over a corpus of more than a hundred shapes; outside that grammar doctor names the key, the file and the LINE NUMBER, says the service may read something else, and never prints the value, which also keeps a control byte in a `.env` out of the operator's terminal. One line elsewhere in the file that leaves a quote open, ends in a backslash or is not an assignment takes the claim off the WHOLE file, in both directions: the shells swallow the next line into an open quote where systemd 252 reads `ab'` and carries on, and the shells honour an `unset K` BELOW an assignment where systemd ignores it. (4) A `.env` value now reaches read-only file I/O, behind a `statSync().isFile()` guard so a FIFO cannot hang doctor, resolved against doctor's own cwd; this is stated because "never configures" is the licence for reading the file at all. (5) `PI_ENV_SETUP` downgrades a service refusal to a warning naming the script, or doctor would fail a working `--env-setup` deployment. **CORRECTION**: the 2026-09-22 row's "`KEY=""` is UNSET to every consumer" is false and was load-bearing. Both POSIX loaders SET the key to an empty string, `config.mjs` keeps it through `??`, and the worker refuses to start, so blank is a deployment that is DOWN rather than a feature that is off. The cmd wrapper is the one loader that genuinely unsets. **`REQ-SCOPED-PAUSE-WINDOWS` and `REQ-SCOPED-LIMITS` UNCHANGED, checked**: no key, path or default moves; only what doctor SAYS about them does. **Code evidence**: worker/src/env-file.mjs -> readEnvAssignments; worker/src/doctor.mjs -> BOOT_FILES; worker/src/up.mjs -> runUp. |
| 2026-09-22 | Issue #375. **`REQ-RESUMABLE-SESSION` AMENDED**, one fail-open clause and one Acceptance clause: a key whose own directory in the store is not a directory is a named cold start (`key-not-a-directory`) rather than a path followed to wherever it points. Measured before the fix, a symlink pre-created at the derived key path made a resolve return `resumed` from a transcript outside the store and a promotion write four files through it. The entry is refused, never removed, because this store creates key directories and nothing else. **`REQ-QUEUE-BURST-NO-DROP` UNCHANGED, checked**: the one-writer rule is about the lock, not about what the name is. **Code evidence**: `worker/src/session-store.mjs` -> `inspectKeyDir`, `ensureKeyDir`, `reapSessions`; `worker/test/session-store.test.mjs` -> the read-edge and write-edge tables. |
| 2026-09-22 | Issues #365 and #370. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, two clauses on the `.env` reading, neither of which moves a grammar. A FOURTH SIGNAL beside the three states: a file carrying both a bare and an `export` assignment is not export-only, so the three states said nothing about it, and when the two readings disagree about the value the two deployment shapes load different files while doctor named only the bare one. It fires only on disagreement (both forms holding one value is tidiness) and is order-sensitive (an `export` line before the bare one is overridden for both consumers). And `up` now NAMES AN EMPTY VALUE, because `KEY=""` is SET to the never-clobber rule and UNSET to every consumer, which is two true sentences three lines apart in one `up` run; a fourth doctor state was rejected, since a state carries a decision and this is a wording overlap. **`REQ-RESUMABLE-SESSION` and `REQ-DURABLE-RUN-HISTORY` UNCHANGED, checked**: no key, path or window moves. **Code evidence**: worker/src/doctor.mjs -> envFileKeys; worker/src/up.mjs -> runUp. |
| 2026-09-22 | Issue #362. **`REQ-RESURRECTABLE-SANDBOX` AMENDED**, one Acceptance clause, and it is a correction rather than an addition: the clause promised that `--publish 3000` makes the port reachable at `127.0.0.1`, which was true only with `PI_EGRESS=0`. An armed policy, the default, puts the sandbox on its own `--internal` network, where docker ACCEPTS `-p`, exits 0 and binds nothing (measured on docker 27.4.0: `docker ps` shows no ports and `docker port` prints nothing), so the one case the flag exists for did not work on a default deployment and the CLI printed `published: ...` as though it had. The flag is now REFUSED on the armed posture, naming `PI_EGRESS=0`, rather than accepted and ignored. Attaching the bridge to a running sandbox was checked as a rescue and the answer is PLATFORM-DEPENDENT, which is why it is recorded rather than asserted: on native Linux docker 27.5.1 it does rescue the port, since the DNAT rule is installed at attach and removed again at detach; on Docker Desktop for macOS 27.4.0 it does not, and `docker port` reports a binding that carries no traffic. The issue named that exact hazard ("Docker Desktop on macOS only. Native Linux docker and Podman are unchecked"), and a first version of this change generalised the macOS reading to both platforms, including into the operator-facing refusal string. The REFUSAL rests only on the half that holds on both daemons: `-p` on an `--internal` network binds nothing. Podman remains unmeasured. |
| 2026-09-21 | Issue #336, part 3b. **`REQ-RESUMABLE-SESSION` AMENDED**, the one-writer bullet: a promotion lock left by a killed writer is taken over once it is older than any plausible promotion, so such a kill costs the key one run rather than every future run on it until an operator removes a file by hand. The refusal itself is unchanged -- a job that cannot take a LIVE lock still runs cold with no persistence, never queued and never failed. **Code evidence**: worker/src/session-store.mjs -> takeLock. |
| 2026-09-21 | Issue #336, part 2: the unguarded resolve/promote race. **`REQ-RESUMABLE-SESSION` AMENDED**, one bullet and one acceptance clause. The read and the copy are not under the promotion lock, and until now only the cross-VENUE half of that window was closed: a promotion by a job on the same venue left the stamp matching before and after, so the reader resumed a transcript no gate had judged, which could be past its TTL, past the age bound, chain-exhausted or written by another pi. The copy is now re-checked against the IDENTITY the gates were computed from and such a job runs cold with the new `transcript-replaced` token, fail-open like every other eligibility arm: one cold start, and the next run resumes. **`REQ-QUEUE-BURST-NO-DROP` UNCHANGED, checked**: two jobs on one pull request inside one runtime is still the shape this protects, and nothing about queueing or dropping moves; what changes is only what the loser of that race RECORDS. **Code evidence**: worker/src/session-store.mjs -> resolveSession, identityOf, readIdentity, inspectFile. |
| 2026-09-21 | Issue #357, item 2: the four env lines four shipped files promised and `up` never wrote. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED TWICE.** (1) The Statement's ladder gains `up` filling EMPTY keys in an EXISTING `.env`, the one mutation it makes without a prompt, bounded so it cannot destroy anything an operator chose: the file must already exist (`init`'s create-only rule untouched), a key with any value is left alone (never-clobber at key granularity), and no value written is a capability, a credential or a policy. `PI_PAUSE_WINDOWS_FILE` and `PI_SCOPED_LIMITS_FILE` get this folder; `PI_LOGS_DIR` and `PI_SETTINGS_FILE` get what the account default RESOLVES to, with a shell-exported value that is relative or inside the deployment folder refused rather than written, because `makeLogReaper` unlinks every `.log` and `.json` in `PI_LOGS_DIR` past the window with no name shape and no ownership check, so a deployment folder there eats `triggers.json` and its siblings a month in, silently. Writing the default makes the value explicit rather than changing it. (2) A NEW BULLET for the precedent this sets: **doctor reads the deployment's `.env` for two named keys, to decide what to SAY.** The premise the issue stated was false and verification found it: nothing in this project loads `.env` into an environment, so writing a line configures the SERVICE and silences nothing in the shell doctor runs in, including `up`'s own doctor step (fixed by layering what was written over `env` for that call). Unqualified, the two warnings would fire hardest at deployments that had just been converged. The read is to reword a message, never to configure; it covers only the keys those checks name; a missing or unreadable file restores the full warning; and `PI_ENV_SETUP` in a `./.env` is still not honoured, which is what keeps `docs/secrets.md`'s opening sentence true. **`REQ-DURABLE-RUN-HISTORY` AMENDED**, one clause of its Acceptance: "a host on which nothing sets `PI_LOGS_DIR` or `PI_SETTINGS_FILE`" now means a deployment where `up` has not run. **`REQ-SCOPED-PAUSE-WINDOWS` and `REQ-TRIGGER-SECRETS` UNCHANGED, checked**: no window, limit, secret or refusal rule moved, and the worker's fail-closed default for both files is deliberately untouched. `up` also treats `export KEY=value` as SET, which is a never-clobber decision rather than dotenv pedantry: the wrapper scripts source this file, so that line is a value the operator wrote, and reading it as absent appends a second assignment the shell then prefers. The two durable keys are refused rather than written when THIS SHELL supplied a relative path or one inside the deployment folder, and every written value is rendered so all three loaders of this file read it back: the shells the wrapper scripts use, systemd's `EnvironmentFile=`, and `worker-env-wrapper.cmd`, whose quoted `set` keeps surrounding quotes as part of the value while preserving spaces, so nothing is quoted there and its bare set is derived from that loader. The rule is derived inside `updateEnvFile` rather than passed per call, and `updateEnvFile` now also refuses a file whose uid or gid is not this process's, because `renameSync` makes a new inode and a 0640 `.env` read by the service through its group would stop being readable. **Code evidence**: worker/src/up.mjs -> runUp, underFolder; worker/src/env-file.mjs -> readEnvKeys, replacementLines; worker/src/doctor.mjs -> envFileKeys, ENV_FILE_READABLE_KEYS, collectChecks. |
| 2026-09-21 | Issue #337, item 1: the session network nothing swept. **`REQ-RESURRECTABLE-SANDBOX` AMENDED**, in its retention bullet and its Acceptance: the window now bounds the run's session NETWORK as well as its directory, and the same reaper removes a `pi-sandbox-<id>-net` whose id is absent from the retained directories, is not running, carries no `pi-sandbox-` container, and has no container of its own in any state but `exited` or `dead`. Retained means re-openable, and an open is what the network is for, so the network is kept as long as the directory is and then one pass longer, because the pass that deletes a directory still counts that run as retained. **That is a deliberate NARROWING of the issue's own acceptance line**, which asks for a leftover "with no sandbox attached" to be swept: a leftover on a run that is still re-openable survives its window, and until then the next open of that run refuses with `egress-network-exists` and the two commands, which is shipped behaviour unchanged. The stricter reading is what reopens the #277 race the refusal exists for. **`REQ-EGRESS-ALLOWLIST` UNCHANGED, checked**: no job network, no argv, no proxy and no pre-spend gate moved; a session network is `INT-SANDBOX-CONTRACT`'s object. **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked**: no doctor check and no `up` step. **`REQ-LOCAL-JOB-VISIBILITY` UNCHANGED, checked**: two new log events, no run-record field. **Code evidence**: worker/src/sandbox.mjs -> makeSandboxNetworkSweeper; worker/src/sandbox-store.mjs -> makeSandboxReaper; worker/src/start.mjs -> startWorker. |
| 2026-09-21 | Issues #357 and #350, the networks nothing removed. **`REQ-EGRESS-ALLOWLIST` AMENDED** (Acceptance): "the network is removed when the container exits" gains the crash path, which is the only path the boot reaper's sweep exists for and the one it was silently failing. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**: the Statement's canary already named the throwaway network and probe containers `doctor` makes and removes unprompted; it now also covers removing what an EARLIER canary left when its run did not finish, and doctor saying which it removed. That is the same unprompted tier, not a new one: the objects are doctor's own, named after the doctor PROCESS, and only a dead pid's are touched. **`REQ-RESURRECTABLE-SANDBOX` UNCHANGED, checked**: session networks are `INT-SANDBOX-CONTRACT`'s and are not swept here. **`REQ-LOCAL-JOB-VISIBILITY` UNCHANGED, checked**: two new log events, no run-record field. **Code evidence**: worker/src/backend-local.mjs -> reapNetwork; worker/src/doctor.mjs -> sweepStaleCanaryNetworks, egressChecks. |
| 2026-09-21 | Issue #345, while verifying the Podman page. **`REQ-EGRESS-ALLOWLIST` AMENDED**, three words in the Statement: the bound is "listed hosts by name and nothing else **beyond this host**". An `--internal` network's gateway is the host, so a host service bound to `0.0.0.0` answers a job container while one bound to `127.0.0.1` does not, measured on Docker 27.5.1 and rootful Podman 5.8.2 alike; `DES-EGRESS-DENY-ON-A-DEDICATED-NETWORK` carries the residual and `docs/egress.md` now says what bounds it. No behaviour changes: the requirement is scoped to what it always did. **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked**: doctor's checks and their tiers are untouched by the Podman route. |
| 2026-09-15 | Issue #344. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**, in the Statement and the Acceptance: `doctor --live` reads the declarations back off short-lived real containers rather than one, and what it names before it starts and removes when it ends now includes the peer networks it makes with the egress policy armed. The shown-rather-than-consented tier is UNCHANGED, checked: typing the flag is still the approval, and nothing it makes outlives the run. |
| 2026-09-14 | Issue #341, part 3. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED**: a bullet saying `doctor` names who a local job runs as, from the worker's own resolver and with no container, failing only for what stops the worker booting and warning when this shell is not the account a system unit runs the worker as; Acceptance gains the native-Linux and rootless cases, for `doctor` and `doctor --live`. Its no-unshown-mutation clause is UNCHANGED, checked: deciding starts nothing. |
| 2026-09-14 | Issue #341, part 2 (the wiring). **`REQ-RESURRECTABLE-SANDBOX` and `REQ-TRIGGER-SECRETS` AMENDED**, one clause each: the sandbox env they list as exactly `TERM` and `TMOUT` also carries the proxy variables when egress is armed (true since #202 and never written here) and `HOME=/home/pi` beside `--user` when the run had a job user. Neither is a credential, and the no-credential clause of both is UNCHANGED, checked. |
| 2026-09-14 | Issue #341, part 1. **`REQ-UPSTREAM-CONTRACT-TESTS` AMENDED**: the Chromium assertion gains its arbitrary-uid half for an image declaring `anyUid` -- measured in a native-Linux lab, today's image renders as `pi` and fails as uid 4242 with or without `HOME`, so a label claiming the capability without the render would lie about the one tool that fails loudest. `image/verify-image.sh` runs both, and CI's image job runs the script. **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked**: nothing doctor or `up` does moves in this part. |
| 2026-09-14 | Issue #278, part 2: `doctor --live`. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED, in the Statement**: `doctor [--fix] [--live]`, and the "never perform an unshown host mutation" clause now names what `--live` adds -- a probe container and a fixture, shown before they exist and removed when the read ends, approved by typing the flag, beside the egress canary's existing unprompted network and probes -- rather than leaving a live read-back to contradict it. Acceptance gains the `--live` case and the case that nothing else starts a probe. **`REQ-RESURRECTABLE-SANDBOX` UNCHANGED, checked**: the probe shares the builder, not the sandbox's launcher, names or reaper. |
| 2026-09-14 | Issue #277, part 4. **`REQ-EGRESS-ALLOWLIST` AMENDED**, a correction of scope rather than of intent: its Scope said a resurrected sandbox joins the same kind of network, and that was true only of the CLI. A sandbox opened from the admin panel's RUN_DETAIL passed no network and ran on docker's default bridge with the policy armed. Both entry points now share one launcher, and the Scope says both. **`REQ-RESURRECTABLE-SANDBOX` UNCHANGED, checked**: no credential, mount or retention rule moved. **Code evidence**: worker/src/sandbox.mjs -> openSandbox, sandboxEgress; worker/src/egress.mjs -> egressProxyName; worker/src/sandbox-cli.mjs -> runSandbox; admin/src/index.ts -> openSandboxSession. |
| 2026-09-14 | Issue #277, part 3: the sandbox refuses by the venue a run was in. **`REQ-RESURRECTABLE-SANDBOX` AMENDED**: its scope now says both entry points serve only a run whose venue this host holds, and its acceptance gains the refusal for both, the `--list` marking, and a pre-venue run opening as before. **Code evidence**: worker/src/sandbox.mjs -> sandboxVenueRefusal, resolveSandbox; worker/src/sandbox-store.mjs -> retainJobDir; worker/src/prepare.mjs -> makePrepareWorkspace; worker/src/sandbox-cli.mjs -> runSandbox, renderList; admin/src/index.ts -> readSandboxInfo. |
| 2026-09-14 | Issue #277, part 2: resume is gated on venue. **`REQ-RESUMABLE-SESSION` AMENDED**: a transcript written in another venue joins the fail-open list as a named cold start (`venue-changed`), and the acceptance gains the moved-trigger and pre-venue-key cases plus the venue stamp among the writes a completed promotion makes. **`REQ-DURABLE-RUN-HISTORY` UNCHANGED, checked**: `venue-changed` is a fixed token like its siblings. **Code evidence**: worker/src/session-store.mjs -> makeSessionStore (resolveSession, promoteSession, readCanonical, readVenue, replaceSidecar); worker/src/run-history.mjs -> SESSION_REASONS; worker/src/start.mjs -> startWorker (the store's defaultBackend). |
| 2026-09-14 | Issue #277, part 1: the record names its venue. **`REQ-DURABLE-RUN-HISTORY` UNCHANGED, checked**, and the check is the substantive one it was for `host`: its acceptance says a record carries no issue or comment body, title or username, and the new `backend` field satisfies it -- a backend name is operator-authored configuration validated against a charset at load, and no path from any payload reaches it. **Code evidence**: worker/src/backend-registry.mjs -> resolveBackendName; worker/src/run-history.mjs -> buildRecord; worker/src/start.mjs -> startWorker (recordRun); worker/src/index.mjs -> makeProcessor (the container-name refusal caught at pickup); admin/src/dashboard.ts -> renderRunDetail. |
| 2026-09-09 | Issue #289, the queue stops rounding distinctions it can make. **`REQ-DEDUP-BY-DELIVERY-GUID` AMENDED**: the semantic-window swallow becomes VISIBLE -- `enqueueForgeJob` compares `queue.add`'s returned id against the computed one (the window returns the survivor's DIFFERENT id at the pin's own Lua; a GUID replay returns the SAME id and stays silent by design, its true answer being "queued"), the receiver logs one `deduplicated` line per swallow with the surviving id, logs `enqueued` only for jobs actually created, and answers `202 {status:"deduplicated"}` when a delivery created nothing. Before this, re-labelling inside the window did nothing with no feedback anywhere. **`REQ-ADMIN-VIA-PI-EXTENSION` UNCHANGED, checked**: the FAILED section and `f` view add NO tool and NO subcommand, so the enumeration and its pin stand untouched (the DES entry records both as Rejected). **`REQ-WAIT-FOR` UNCHANGED, checked**: hold semantics untouched; the status area's breakdown counts holds from the wait index without touching it. **`REQ-JOB-STATUS-COMMENTS` UNCHANGED, checked**: no comment surface moves. **Code evidence**: worker/src/queue.mjs; receiver/src/receiver.mjs; receiver/src/poller.mjs; admin/src/dashboard.ts; admin/src/render.mjs; admin/src/read-model.mjs; worker/src/branch.mjs; worker/src/prepare-local.mjs; worker/src/service.mjs. |
| 2026-09-09 | Issue #288, telling someone when a paid job dies. **NEW `REQ-OPERATOR-FAILURE-NOTIFICATION`**: one operator command, id-only argv, fired on the paid terminals only (final infra failure, worker abort, in-container policy stop), at most once per job, fault-isolated, byte-identical when unset, and the project ships no transport ever. **`REQ-JOB-STATUS-COMMENTS` AMENDED**: the acceptance's paid half is now discharged -- a who-authors-which clause records that the agent owns the exit-0 status comment (the prompt contract) and the worker owns every other terminal comment, with once-ness for the infra class read off BullMQ's own `finishedOn` rather than re-derived attempts math, which also covers the stall-killed job the processor never ran on. The prepare-stage silence (`sha-gone`, the `.pi/` caps) stays OUTSIDE: that is `OQ-023`'s ratified accepted risk, boundary restated there, not here. **`REQ-LOCAL-JOB-VISIBILITY` UNCHANGED, checked**: the stdout line stays the local terminal signal; the new fixed sentences ride the same adapter fallthrough, which is why they are path-free. **Code evidence**: worker/src/processor.mjs -> TERMINAL_COMMENTS; worker/src/start.mjs -> the hoisted comment adapter, the two listener bodies, makeOnFailure wiring; worker/src/on-failure.mjs; worker/src/config.mjs -> parseOnFailure. |
| 2026-09-09 | Issue #287, the operator cancel. **NEW `REQ-OPERATOR-JOB-CANCEL`**: one job stops from a model-free surface -- the CLI's `cancel` verb (VALKEY_URL-only, the kill switch's own doctrine) and the panel's `x`/held drill-in -- with the active case recorded as `operator-cancel` beside `worker-abort` and the never-ran cases recording nothing (the #230 rule). The unowned case is a NAMED refusal: `cancelJob` is process-local and nothing maps a jobId to a host, so the active path is a request/ack keyspace (`INT-CANCEL-CHANNEL-CONTRACT`) whose timeout the operator watches, never a silent no-op. **`REQ-JOB-TIMEOUT-30M` UNCHANGED, checked**: the timer, its bound and its classification stand; the cancel RIDES the same abort machinery and the discrimination is a closed exact-match on the signal's reason, so the timer's abort cannot reclassify. **`REQ-WAIT-FOR` UNCHANGED, checked**: hold semantics untouched; the held cancel is the existing sequence extracted to one shared body. **`REQ-ADMIN-VIA-PI-EXTENSION` UNCHANGED, checked**: no tool added or removed (the wiring pin stands untouched); `dispatch_wait_cancel`'s description alone stops claiming to be the only door. **Code evidence**: worker/src/cancel-state.mjs; worker/src/cancel-cli.mjs; worker/src/index.mjs; worker/src/processor.mjs; admin/src/dashboard.ts; admin/src/read-model.mjs. |
| 2026-09-09 | Issue #281. **Scope AMENDED, third de-GitHub-ification, and the last of its kind**: the Targets bullet named two forges while four shipped end to end (the 2026-07-29 row opened the closed list and closed it again at two members; docs/forgejo.md and docs/azure-devops.md had shipped since). It now names all four, TIERED honestly rather than flattened -- GitHub/GitLab designed-for, Forgejo admitted as GitHub-shaped needing no accommodation (`CONST-HMAC-OVER-RAW-BODY`'s own sentence), Azure DevOps serviced with the one property it cannot have, pointing at the constraint's named exception and at `OQ-015` rather than restating either -- and the credential clause extends in `CONST-TOKEN-SCOPED-PER-JOB`'s mechanism-neutral terms (Forgejo: a repository-scoped token; Azure: a PAT for a dedicated identity). **This row is the ratifying act `OQ-015` cited**: a scope statement that names the forge with its missing property IS the explicit acceptance the register was waiting for; the row's own status moves in the same commit. The invariant the issue was after is PINNED, not promised: `worker/test/forges.test.mjs` derives the forge list from `FORGE_KINDS` and greps this file's Scope region for each display name, with an unmapped kind a loud failure rather than a silent skip -- a new forge cannot ship without touching the sentence. **`REQ-DEDUP-BY-DELIVERY-GUID` UNCHANGED, checked** (OQ-015's clause (b) still describes its Azure arm); **`REQ-REPLICA-RUNS` UNCHANGED, checked** (#187's Azure widening is cited as the accretion evidence, not amended). **Code evidence**: worker/src/forges.mjs -> FORGE_KINDS; worker/test/forges.test.mjs -> the Scope pin. |
| 2026-09-09 | Issue #279, the code catching up with `REQ-GRAPH-HTML-EXPORT`'s own SUPERSEDED text. The entry needed no change -- it already said the topology-only artifact and its command were removed and that the discipline lives on in `REQ-INSIGHTS-HTML-EXPORT` -- but the page BUILDER outlived the page by four issues: `buildGraphHtml` had no caller outside its own test file since #181, and 573 test lines pinned byte-determinism, escaping and redaction on an artifact nothing could emit. Deleted now, with its test-only layout wrapper and its orphaned page CSS, on the #309 `providerKeyVars` precedent: an exported helper with no caller left does not stay uncalled. Every pin that guarded a property the LIVE page still has was retargeted onto `buildInsightsHtml` (where it was not already an exact duplicate of that suite's own pin), so the escaping, redaction, tier, one-shot and honesty-counter guarantees are now asserted on the surface that ships. **`REQ-INSIGHTS-HTML-EXPORT` UNCHANGED, checked**: the artifact, its clauses and its suite are the beneficiaries, not the subject. **Code evidence**: admin/src/graph-html.mjs; admin/test/graph-html.test.mjs (rewritten around buildGraphScene and the live page); admin/test/insights-html.test.mjs -> the reload-contract test's two folded-in clauses. |
| 2026-09-09 | Issue #291, the first enforced in-container permission. **NEW `REQ-PER-TRIGGER-TOOL-EXCLUSIONS`**: a trigger may structurally remove named built-in pi tools from its jobs' sessions (`run.excludeTools` -- narrowing only, file only, all five kinds); the exclusion filters pi's tool REGISTRY, so a by-name re-enable is a no-op and a "read-only triage" trigger stops being prompt text (the README's own disclosure priced the old state). The silent half is refused at every layer it can arise in: membership against the pinned built-in set at load, because pi ignores unknown exclusion names without a diagnostic; a near-miss sweep on the key itself; the `excludeTools` image-capability gate pre-spend, because an older baked runner reads no `PI_EXCLUDE_TOOLS` and would fail open; an in-container membership re-assert for skew and hand-run containers; and a `tools_excluded` log line carrying the session's active tool list READ BACK. `dispatch_run` and chained requests gain no path to it; a chained child inherits the parent's exclusions because dropping that inheritance would WIDEN the child. **`REQ-GLOBAL-PI-OVERLAY` UNCHANGED, checked** (extension loading is a different switch, and deliberately not excludable); **`REQ-AI-TRIGGERED-RUNS` UNCHANGED, checked** (no model-callable surface gains a parameter). **Code evidence**: worker/src/triggers.mjs -> validateExcludeTools, EXCLUDABLE_TOOL_NAMES; image/runner/src/tools.mjs; image/runner/run-job.mjs; worker/src/image-preflight.mjs; image/runner/test/loader.test.mjs (the read-back acceptance, with its control session). |
| 2026-09-08 | Issue #314, the provider-steering variables. **`REQ-TRIGGER-SECRETS` AMENDED**: the load-time refusal list gains the names pi or its provider SDK reads to CONFIGURE a provider, beside the ones the worker writes itself. The distinction is the point: the existing refusals are about whose key pays for the job, this one is about where the job's request goes and with which credentials attached, and only the first was gated. Refused at LOAD rather than pre-spend because these are static names, knowable without deployment state, so the refusal is free and `doctor` reports it for nothing. **The provider KEY variables are deliberately left in the derived set rather than subtracted**, which closes a gap of its own: `providerKeyCandidates("amazon-bedrock")` is empty, so the pre-spend gate reserved NOTHING for a bedrock deployment and a trigger could bind `AWS_SECRET_ACCESS_KEY` outright. **The set EXCLUDES a provider's key variables, which is what keeps this entry's own bound true**: an `anthropic` job may still bind `OPENAI_API_KEY`, refused pre-spend only for the job's own provider. An early draft included them and broke that bound for exactly four names out of thirty-one, being the four that happen to appear as literals in a scanned artifact -- and `worker/test/secrets.test.mjs`'s pin of the bound stayed GREEN throughout, because it drives `makeSecretsResolver` with a hand-built job and never passes through `parseTriggers`. The loader now has its own test for it. **ONE existing configuration is still deliberately broken, and it is named rather than left for an operator to discover** (the precedent is #309's row): a trigger can no longer carry AWS or Google CLOUD credentials from a vault for a NON-provider step, an S3 push or a `gcloud` call, because those are read by the SDKs as provider configuration and pi's key table has no `amazon-bedrock` entry to reserve them any other way. That refuses on every deployment, including ones using neither Bedrock nor Vertex. The substitute is `PI_FORWARD_ENV`, which `forwardEnvList` does not refuse for any of these names, but it is not equivalent: one host value for the whole deployment where `run.secrets` carried a per-trigger value from a vault. **`REQ-AI-TRIGGERED-RUNS` UNCHANGED, checked**: there is still no model-callable path to `run.secrets`, so no tool gains a way to name one of these. **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked**: doctor gains no check, because a bound steering name now refuses the whole file and doctor already reports that. **Code evidence**: worker/src/provider-steering.mjs -> PROVIDER_STEERING_VARS; worker/src/triggers.mjs -> validateSecrets; worker/test/provider-steering.test.mjs. |
| 2026-09-08 | Issue #310, closing the SECOND and last of the two consequences #286's revision row recorded and deferred (its own words: "Neither is filed yet"; #309 closed the first). The third defect in this cluster, #311, was not one of them: it was a sentence in that row that had been false when written, which #311's own entry records. That row said "a provider misconfiguration currently retries rather than returning, which is `CONST-RETRY-INFRA-ONLY`'s shape"; **the shape was right and the word "retries" was wrong**, and it is corrected here rather than left to mislead a later reader: `index.mjs` wraps every non-`InfraRetry` throw in BullMQ's `UnrecoverableError`, so such a job failed exactly once. What it actually did was keep its budget reserve, on a fault that recurs on every delivery, and record `outcome: "failed"` with a null reason. **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked, and its clause now has a second half**: "`doctor` never reports green on a credential the worker cannot spend" was about the diagnosis; the worker's own refusal is now determinate, free and legible, so the two agree on the same fact from both ends. **`REQ-SPEND-CAPS-MULTI-WINDOW` UNCHANGED, checked**: no window, cap or soft-hold band moves, and the release uses the same `caps` and `now` as its reserve, which is what makes a `DECR` land on the key the `INCR` created. **`REQ-AI-TRIGGERED-RUNS` UNCHANGED, checked**: no gate changes when a run is permitted, only what happens when this deployment cannot run one at all. **`REQ-TRIGGER-SECRETS` UNCHANGED, checked**: its own pre-spend refusals were already returns and already free; they are the shape this class was missing. **Code evidence**: worker/src/processor.mjs -> the credential gate and the catch's config arm; worker/src/start.mjs; worker/test/processor.test.mjs; worker/test/start-wiring.test.mjs. |
| 2026-09-08 | Issue #309, the reserved-name gate that reserved nothing. **`REQ-TRIGGER-SECRETS` AMENDED** (acceptance) and **no longer KNOWN-INCOMPLETE**: its `secret-name-reserved` clause promised a refusal "when a key collides with the resolved provider's credential variables", and that held only when the credential sat in the ENVIRONMENT. The gate built its set from the presence-filtered `providerKeyVars`, whose `undefined` arrived as `?? []`, so under `PI_AUTH_FROM_PI` -- **ON BY DEFAULT** -- a deployment whose key lives in pi's `auth.json` reserved NOTHING, silently. A trigger could then bind `ANTHROPIC_API_KEY`, `buildContainerEnv` writes the credential first and the trigger's value second with no guard, and every job of that trigger spent the trigger author's key: verbatim the failure `secrets.mjs`'s own header says the gate exists to prevent, through the one door it did not watch. The set now comes from `providerKeyCandidates`, which is what a reserved-name question wants: what a trigger may not NAME is a property of the provider, not of what this host happens to hold today. **A second hole closed with it, which never needed `auth.json`**: `ANTHROPIC_OAUTH_TOKEN` is set on no ordinary host, so a presence filter never held it, and pi reads it BEFORE `ANTHROPIC_API_KEY` -- a trigger binding it outranked the operator's own key on the pure-env path too. **The widening is bounded and that bound is tested**: only the job's OWN provider's variables are reserved, so an `anthropic` job may still bind `OPENAI_API_KEY` for a flow that talks to OpenAI itself; refusing that would be this project claiming a namespace it does not own. **The `resolved.reserved` branch had NO test before this change**, which is how a gate that reserved nothing on the default deployment stayed green, and `worker/test/processor.test.mjs` now covers it end to end (determinate return, nothing minted or cloned, `incrCalls === 0`, the variable named and no reference published). **`providerKeyVars` is DELETED**, not re-documented: it had no caller left, every caller it ever had was asking it the wrong question, and an exported helper that answers a subtly wrong question does not stay uncalled -- both defects in this cluster were somebody reaching for it. pi's own behaviour is still pinned, against `findEnvKeys` directly. **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked**: `doctor` reports on credentials and reserves no names. **`REQ-SPEND-CAPS-MULTI-WINDOW` UNCHANGED, checked**: the refusal was already pre-spend and stays there. **ONE existing configuration is deliberately broken, and it is named rather than left for an operator to discover**: a deployment that had a working host or `auth.json` credential AND overrode it per trigger from a vault, which is per-trigger provider billing. It never worked on the env path (the gate refused it there already); it worked only where the gate was empty, which is the defect. There is no escape hatch, because an escape hatch is the hole. `doctor` is the mitigation: it now reports the clash at setup, which the presence-filtered version could not do because its answer changed with the machine `doctor` ran on. **Found by the review pass and fixed in the same PR**: the public refusal text asserted "the worker sets that variable itself" for BOTH cases, which is exactly backwards for the OAuth half, where the worker writes nothing and the trigger's value would have WON; the three new regression tests went green against the OLD code on any machine exporting a provider key, because pi answers presence from the real `process.env`, so a mutation check on them was decided by the developer's shell; and `__proto__` passed every check, spawned the resolver against the operator's vault, and was then swallowed by the prototype setter on assignment, so the container ran without the variable on a clean exit. All three are pinned. **Code evidence**: worker/src/secrets.mjs -> makeSecretsResolver; worker/src/env-allowlist.mjs; worker/src/doctor.mjs -> the trigger-secret clash check; worker/src/triggers.mjs -> validateSecrets; worker/src/start.mjs -> makeSecretsResolverFn hostEnv; worker/test/secrets.test.mjs; worker/test/processor.test.mjs; worker/test/doctor.test.mjs; worker/test/triggers.test.mjs; worker/test/start-wiring.test.mjs; docs/secrets.md. |
| 2026-09-08 | Issue #311, the `auth.json` credential variable. **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked, and now true on both sides**: its clause that `doctor` never reports green on a credential the worker cannot spend was written about `doctor`'s half, and the worker's half had the mirror-image defect. `doctor` derived its answer from pi while `resolveEnvName` fed pi a convention it had invented (`<PROVIDER>_API_KEY`/`_KEY`), so on 13 of the 34 provider ids that have a key variable, `google`, `huggingface`, `moonshotai`, `github-copilot` and `radius` among them, a valid `pi login` refused every job; the convention was right for the other 21, `anthropic` and `openai` included, which is why nobody hit it sooner. The two now share one selection, `apiKeyVariable`, in an import-free module, which is the only shape that makes "the line doctor prints is the variable the worker writes" a fact rather than a habit. The full argument, the rejected `providerKeyCandidates(provider)[0]` fix and the env-path value filter are on `INT-CONTAINER-RUNTIME-CONTRACT`. **`REQ-TRIGGER-SECRETS` still KNOWN-INCOMPLETE, checked**: its `secret-name-reserved` clause reads the presence-filtered `providerKeyVars` and is untouched here; issue #309 owns it. **Code evidence**: worker/src/provider-key.mjs; worker/src/env-allowlist.mjs -> resolveEnvName; worker/src/doctor.mjs -> providerKeyCheck. |
| 2026-09-07 | Issue #280, the model-callable enumeration. **`REQ-ADMIN-VIA-PI-EXTENSION` AMENDED**: its Statement enumerated eleven model-callable tools against twenty-one registered, and the count was not the defect. Seven of the ten missing are **confirm-gated writes** (the pause-window and scoped-limit CRUD, and `dispatch_wait_cancel`), so the Statement understated the confirm-gated surface by 7 of 11 -- and that enumeration is the sentence the prompt-injection argument stands on, "what can a compromised operator model reach", answered by a list two thirds complete. Each of the ten was checked at its own registration in `admin/src/index.ts` before being added here: `dispatch_pauses`, `dispatch_limits` and `dispatch_waits` reach no writer at all, and the other seven each route through `confirmedWrite` with `executionMode: "sequential"`. Their headless-refusal coverage is stated as it actually is rather than rounded up: `admin/test/crud.test.mjs` asserts the `ctx.hasUI` refusal directly for `dispatch_set`, `dispatch_pause_add`, `dispatch_pause_edit` and `dispatch_limit_add`, and the remaining three (`dispatch_pause_delete`, `dispatch_limit_edit`, `dispatch_limit_delete`) plus `dispatch_wait_cancel` inherit it structurally from the single `confirmedWrite` funnel they all pass through, which is fail-closed -- a weaker claim than a per-tool assertion, and the residual is recorded here rather than asserted away. **So the correction changes the enumeration and not the argument**: the surface did not widen, the entry describing it was wrong. **The list is now the pin, rather than prose promising to stay true**: `admin/test/wiring.test.mjs` reads the Statement region and set-compares `dispatch_[a-z_]+` against the registrations, in both directions, and fails loudly when the region cannot be found rather than scanning an empty string. It is the first test in this repo to read a spec file; the delimiter is the entry's own `- **Field**:` structure rather than marker comments, because `specs/` holds no HTML comments and a marker pair would be a second thing to keep true -- the exact failure being fixed. The COUNT WORD is deliberately gone from both entries: a number beside the list is a second claim the pin does not check, and "eleven" is what this entry said while twenty-one shipped. **`REQ-SCOPED-PAUSE-WINDOWS` AMENDED**, an independent instance of the same drift found while fixing this one: it named three of the four pause tools as `dispatch_pause_add`/`_delete`, and `dispatch_pause_edit` appeared in NO spec file anywhere, though `docs/pause-windows.md` had it right all along -- a specs-only drift, and elision is how the sibling went missing without any sentence being wrong. **`REQ-SCOPED-LIMITS` UNCHANGED, checked**: it names no `dispatch_*` tool at all, so it could not be wrong. **`REQ-WAIT-FOR` UNCHANGED, checked**, and for a narrower reason than that: its Scope does name `dispatch_run`, among the things that cannot supply a wait, and that sentence is still true -- neither `dispatch_trigger_add` nor `dispatch_trigger_edit` exposes a `waitFor` parameter, checked at their schemas, so "no model-callable tool can write it" holds even though the model-callable surface turned out to be twice the size this row started with. **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked**: no `doctor` check moves. **Code evidence**: admin/src/index.ts -> registerTools (the `dispatch_pauses` description, which told a model that `dispatch_pause_edit` does not exist); admin/test/wiring.test.mjs -> specEnumerationRegion, SPEC_ENUMERATIONS. |
| 2026-09-07 | Issue #286, `doctor`'s provider-key check. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED** with the clause the defect needed and did not have: `doctor` never reports green on a credential the worker cannot spend. It is `REQ-DEPLOYMENT-BOOTSTRAP`'s own "reports a bound that is set and asleep" with the sign flipped -- a credential rather than a bound -- and the entry's closing paragraph had already argued the general case, that the provider keys "cannot be enumerated at all because pi names them per provider" and the file "says that rather than pretending to a closed list". `worker/src/doctor.mjs` was pretending: a hand-written table listing `GOOGLE_API_KEY`, which is not a name pi reads for `google` or for anything, and a `gemini` provider pi has never had, so two deployments passed `doctor` and had every job refused pre-spend. Two further defects the issue did not name were found and fixed with it: the table had `anthropic`'s precedence INVERTED against pi's (`ANTHROPIC_OAUTH_TOKEN` first), so the `fix:` line printing the first candidate would have told an operator to set their subscription login; and an OAuth token in the environment PASSED IN SILENCE, as though a subscription login were a service credential. The check now asks pi, through `providerKeyCandidates` and `piProviders` in the module the worker already derives from, so `doctor` and the job path cannot disagree by construction. **The never tier is untouched and checked**: the rewritten check carries no `fixAction` and is pinned by name in the `--fix` doctrine test, and `carried.length === 6` is unchanged. **`REQ-AI-TRIGGERED-RUNS` UNCHANGED, checked**: no gate, refusal or ordering moved -- this changes only what `doctor` reports about a credential, never when one is required or what is done with it. **`REQ-SPEND-CAPS-MULTI-WINDOW` UNCHANGED, checked**: nothing here reserves, releases or reads a budget. **Recorded rather than fixed, because a fix belongs in its own change**: the identical `undefined` conflation makes `worker/src/secrets.mjs`'s reserved-name gate reserve nothing under the `auth.json` credential path, so **`REQ-TRIGGER-SECRETS` is KNOWN-INCOMPLETE rather than amended here** -- its acceptance promises `secret-name-reserved` "when a key collides with the resolved provider's credential variables", and that holds only when the credential is in the ENV, because the gate reads the presence-filtered `providerKeyVars`; and a provider misconfiguration currently retries rather than returning, which is `CONST-RETRY-INFRA-ONLY`'s shape. Neither is filed yet; each needs its own issue, because each is a different module with its own test surface and neither is reachable from this check. **Code evidence**: worker/src/env-allowlist.mjs -> providerKeyCandidates, piProviders, EVERY_VAR_SET; worker/src/doctor.mjs -> providerKeyCheck, noKeyVariableCheck, defaultProviderOracle, OAUTH_KEY_RE; docs/secrets.md. |
| 2026-09-07 | Issue #292, resolving `OQ-007`. **`REQ-RESURRECTABLE-SANDBOX` AMENDED**: its retention bullet said "with a boot sweep", and a boot sweep is exactly what the supported deployment never re-runs, since `service install` renders a unit that restarts only on failure. Retention is now swept at boot AND every `PI_SWEEP_INTERVAL_HOURS` (default 24, `0` = boot-only and byte-identical to before). The same correction applies to the run history and the session store, which had the identical shape and no entry of their own saying so -- `OQ-007` is resolved WIDENED to all three rather than answered only for the logs it was written about. **`REQ-DURABLE-RUN-HISTORY` UNCHANGED in substance, checked**: the record, its PII-free construction and its survival across a restart are untouched; only the cadence of the prune that bounds the directory moved. **`REQ-RESUMABLE-SESSION` UNCHANGED, checked**: no eligibility bound and no read-path gate moved, and the age check at OPEN is still what refuses a stale transcript -- until this change it was silently carrying the disk half too. **`REQ-LOCAL-JOB-VISIBILITY` UNCHANGED, checked**: the console line and the live stream are untouched. **Code evidence**: worker/src/retention-sweep.mjs; worker/src/start.mjs -> startWorker; worker/src/config.mjs -> sweepIntervalHours. |
| 2026-09-07 | Issue #290, the durable substrate. **`REQ-DURABLE-RUN-HISTORY` AMENDED**: its acceptance said records survive a WORKER restart, which was the strongest claim it could make while `PI_LOGS_DIR` defaulted under the OS temp dir; it now also claims survival across a HOST reboot, or a `doctor` line naming the path that will not. That gap was not theoretical. Linux leaves `TMPDIR` unset, so the default resolved to `/tmp/pi-dispatch/logs`, and on the distributions where `/tmp` is tmpfs that is RAM: the record this entry promises, and every cap the operator tuned from the panel, were gone on the next boot, while the queue beside them survived on Valkey's AOF volume. Both defaults move to `~/.pi-dispatch`, chosen over a per-platform state dir because this project has exactly one home-dir pattern, `docs/sessions.md` already teaches `~/.pi-dispatch/sessions`, `~/Library/Application Support` carries a space into every copy-pasteable fix line `doctor` prints, and `XDG_STATE_HOME`/`LOCALAPPDATA` would each be a new env read needing its own `env-internal` marker where `homedir()` is invisible to that scan. `PI_JOBS_DIR`, `PI_SANDBOX_DIR` and `PI_GRAPH_DIR` stay under temp deliberately, being per-run, retention-bounded and regenerable: warning about a directory that is SUPPOSED to be swept is how an operator learns to skim the section. **The move's own hazard is recorded rather than discovered later**: `<OS temp>/pi-dispatch` was a GLOBAL path on Linux, so a worker under `User=pi` and a panel in the operator's session agreed by construction, and a per-account default splits them silently -- an empty run list, and panel-set caps written to a file the worker reads as an empty overlay and replaces with the `.env` defaults. `pi-dispatch up` therefore pins both into the deployment's `.env` (what the worker reads) and the setup wizard writes the same two paths into the deployment pointer (what the panel reads). **`REQ-RESURRECTABLE-SANDBOX` and `REQ-RESUMABLE-SESSION` UNCHANGED, checked**: the sandbox root stays under temp on its own retention argument, and `PI_SESSIONS_DIR` still has no default at all, for a reason independent of this one -- unset means the feature is unavailable and an armed trigger refuses pre-spend. **`REQ-DEPLOYMENT-BOOTSTRAP` UNCHANGED, checked**: the new `doctor` checks carry no `fixAction`, so the never-tier ladder is untouched. **Code evidence**: worker/src/config.mjs -> defaultStateDir, defaultLogsDir, defaultSettingsFile, logsDirPath, settingsFilePath, legacyTempStateDir, underOsTempDir, safeHomeDir; worker/src/doctor.mjs -> collectChecks (the durable-state block), recordCount, sharedDirectory; worker/src/up.mjs -> runUp; admin/src/setup-wizard.ts -> runSetupWizard (the pointer); docs/backup.md. |
| 2026-09-07 | Issue #295, the live-edit watches now die with the worker that armed them. **`REQ-CRON-SCHEDULED-JOBS` UNCHANGED, checked**, **`REQ-SCOPED-PAUSE-WINDOWS` UNCHANGED, checked**, **`REQ-SCOPED-LIMITS` UNCHANGED, checked**: all three require the file to be LIVE-RELOADED and all three are satisfied byte for byte -- an edit still takes effect on the next job with no restart, a bad edit still keeps the last-good set, and `pause_windows_reload_invalid` is still logged where `REQ-SCOPED-PAUSE-WINDOWS`'s acceptance names it. Only that one of the three also states the fail-loud boot-load in its own words; for the other two the boot-load lives in their INT contracts, which are checked in the interfaces row. What changed is only when the watch STOPS, which no requirement had ever stated in either direction, and that omission is why the defect could exist without contradicting anything. It is stated now in `DES-WATCHERS-CLOSE-WITH-THE-WORKER` rather than added as a shall here, because "a worker releases what it acquired" is a property of the composition root and not a capability an operator can observe or configure. **Code evidence**: worker/src/start.mjs -> makeWatchCloser, watchTriggersFile, watchPauseWindowsFile, watchScopedLimitsFile, startWorker (the hoisted extraClosers); worker/src/index.mjs -> createWorker (shutdown). |
| 2026-09-07 | Issue #282, the undiscoverable configuration. **`REQ-DEPLOYMENT-BOOTSTRAP` AMENDED** with the rule the issue asks for, placed here rather than in `design.md` because it is a shall and that file says so itself: every environment variable a loader reads is either a key in `.env.example` or carries a marker at its own READ SITE naming it internal. The marker rides the read rather than a list, on `worker/src/reserved-env.mjs`'s own stated rule that those sets are imported beside the validator and never copied into it: a list is a second thing to keep true and drifts from the code it describes. Measured before and after, by the scanner that became `worker/test/env-docs.test.mjs` so that the prose and the test cannot disagree: 106 names read across `worker/src`, `receiver/src`, `admin/src` and `image/runner`; `.env.example` named 82, of which 80 were among the 106; and 26 of the names read were discoverable nowhere. The issue's own "roughly seventy read, about fifty documented" turned out to describe `worker/src/config.mjs` in isolation, where the same scanner counts 73, and is corrected here rather than repeated. Nine of the 26 became keys (`GITHUB_PAT_VAR`, the three one-value `*_AUTH_SOURCE`s, `POLL_REPOS`, `POLL_INTERVAL_SECONDS`, `PI_CODING_AGENT_DIR`, `PI_GRAPH_DIR`, `PI_DISPATCH_DEPLOYMENT_FILE`) and 17 got markers. Two decisions are worth reading back. `PI_ENV_SETUP` is named ONLY in prose and never as a key, because `worker/test/service.test.mjs` pins that a line inside `./.env` is deliberately not honoured and `init` copies the example verbatim, so a commented key would land in every scaffold one uncomment away from the silent no-op this entry exists to forbid. And `GOOGLE_API_KEY` was NOT documented, because measuring it against the pin showed it is not a key pi reads at all: that is `doctor` making a claim the worker cannot honour, filed as issue #286 rather than written down as true. **`INT-CONFIG-OVERLAY-CONTRACT` UNCHANGED, checked**: this is about the environment, and no overlay key or `KNOWN_KEYS` entry moves. **`INT-CONTAINER-RUNTIME-CONTRACT` UNCHANGED, checked**: the six container-side names gain a comment and not one flag, mount or assignment changes. **`INT-DEPLOYMENT-POINTER-CONTRACT` UNCHANGED, checked**: `PI_DISPATCH_DEPLOYMENT_FILE` becoming documented does not widen `POINTER_ENV_ALLOWLIST`. **Code evidence**: worker/test/env-docs.test.mjs -> scanEnvReads, markedInternal, declaredInEnvExample; .env.example -> the polling section and the closing what-is-not-a-key block. |
| 2026-08-30 | Issue #57, the placement slice. **`REQ-MULTI-HOST-COORDINATION` AMENDED**: host-affine work goes to `pi-jobs@<name>`, decided by whoever ENQUEUES it. Routing at enqueue rather than at pickup is not a preference: BullMQ has no selective pop, and the put-it-back alternative does not work, because promotion out of the delayed set is gated on each worker's OWN `Date.now()` in two places, so the host whose clock runs fastest wins every hop deterministically and a job that had to reach another host might never arrive. Jitter cannot fix that -- it randomises WHEN the wake is, not WHO wins it. A cron trigger whose folder is absent here becomes UNSERVED rather than a boot refusal, which is this issue's own acceptance line; the arming predicate is `PI_WORKER_NAME` being DECLARED rather than a registry read, and that choice fixes two failures at once -- a registry read would make a fleet-wide restart into a fleet-wide boot refusal, and it would have to happen below the four destructive boot sweeps, so a single-host deployment with one typo'd folder would reap containers, prune history and delete sandboxes on every restart before refusing. An unserved trigger's `skillsDir` is deliberately NOT judged here, on the shared validator's own reasoning about OS-dependent path checks. **`REQ-CRON-SCHEDULED-JOBS` UNCHANGED, checked**: the reconcile contract is untouched -- and per-host queues make its pruning correct by construction, since a host queue's resident schedulers are only ever that host's. **`REQ-SCOPED-LIMITS` UNCHANGED in substance, checked**: the folder mutex and per-scope ceilings are the same in-process counts, and routing is what keeps the folder mutex complete across hosts, since a local folder exists on exactly one machine. **`REQ-QUEUE-BURST-NO-DROP` UNCHANGED, checked**: a host-affine job is deferred by the host bound, never dropped. **Code evidence**: worker/src/queue.mjs -> hostQueueName, makeQueue; worker/src/index.mjs -> createWorker, makeProcessor (the host bound); worker/src/schedules.mjs -> loadSchedules, servedSchedules; worker/src/start.mjs -> startWorker; worker/src/cli.mjs; admin/src/read-model.mjs -> dispatchRun. |
| 2026-08-30 | Issue #57, the divergence slice. **`REQ-CRON-SCHEDULED-JOBS` AMENDED**, and the amendment does two different things worth separating. It NARROWS the existing startup mandate, which taken literally REQUIRED the multi-host bug: `reconcile` prunes every resident scheduler not named in THIS worker's config, so two workers with different triggers files delete each other's on every boot. And it BROADENS the clause to the live-reload path, which this entry never covered -- honestly the sharper half, because `start.mjs` guards the boot reconcile with `schedules.length > 0` while `reloadSchedules` has no such guard, so deleting the last cron trigger on one host prunes the whole fleet's schedulers and always could. Agreement rather than an elected owner, argued on `DES-CRON-VIA-BULLMQ-SCHEDULER`: election's failure mode is a stale-file owner silently reverting an edit with a log line that reads like success, which is `OQ-008`'s own verdict arriving through a new door. The abstain/opine distinction is spelled out because conflating them would leave the bug in place -- cron disabled is no opinion, zero cron entries IS one. The timezone clause is new ground: a cron pattern carries no zone and resolves in each worker's local time, unlike `pause-windows.json`, which has been zone-explicit since it shipped. **`REQ-MULTI-HOST-COORDINATION` UNCHANGED, checked**: identity and the registry are what this slice consumes, and neither moved. **`REQ-SCOPED-LIMITS` UNCHANGED, checked**: the in-flight count and the scoped money windows are untouched by a cron gate. **`REQ-WAIT-FOR` UNCHANGED, checked**: no wait bound moves. **Code evidence**: worker/src/cron.mjs -> reconcileGated, reloadSchedules; worker/src/fingerprint.mjs -> cronFingerprint, fingerprint; worker/src/start.mjs -> startWorker (the schedules ref, the boot gate, the beat's fpCron thunk). |
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
| 2026-08-12 | Issue #175 (the insights artifact, the fourth slice). **NEW `REQ-INSIGHTS-HTML-EXPORT`**: `/dispatch insights html [7d\|30d\|mtd]` writes `<graphDir>/insights.html` — the topology scene (spend-badged per REQ-TOPOLOGY-GRAPH (h)) beside the cost fold drawn as hand-rolled inline SVG charts, under REQ-GRAPH-HTML-EXPORT's write/open/headless discipline verbatim and REQ-COST-ANALYTICS' labeling rules verbatim, plus the visual clauses (dashed/translucent = estimated with hue never the sole encoding; a plan-covered bucket draws a chip and NO dollar bar; `≥` on charts; both windows stated; gap days present; null byTrigger renders "not computed"). Default window 30d, deliberately not costs' mtd — the topology half is pinned at a 30d record window and one page's halves should agree. No port, no served page, no new model-callable tool, no charting dependency (a supply chain riding a security posture). **REQ-COST-ANALYTICS AMENDED**, one sentence: the insights artifact joins the named surfaces; rules (a)-(g) unchanged. **REQ-GRAPH-HTML-EXPORT UNCHANGED, checked** — `graph html` stays the lighter topology-only export, not an alias. **REQ-TOPOLOGY-GRAPH UNCHANGED, checked** (its Scope's no-tool clause now covers two commands). |
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
| 2026-07-31 | Issues #43 + #61. `REQ-DEDUP-BY-DELIVERY-GUID` **amended**: `fj-` and `az-` join the prefix set that keeps every forge's id space disjoint. Forgejo inherits the guarantee **unchanged** -- it sends `X-GitHub-Delivery` and keeps it stable across its own retries -- while Azure's key is **body-derived**, because it sends no delivery-id header at all, and a delivery carrying no top-level `id` is refused with 400 rather than run undeduplicated. The semantic window gains Azure's work-item/pull-request discriminator for the reason GitLab needed `!` vs `#`: they are separate id sequences, so `project/repo#123` and `project/repo!123` are different objects. `REQ-TRIGGER-AUTHOR-GATE` **amended**: the resolver-outside-the-gate rule written for GitLab is now the GENERAL rule with three customers, and the verdict type is named -- `{ authorized }` or `{ indeterminate }`, normalised across forges because the integer did not generalise (Forgejo answers with a string enum, Azure with a group membership) while the two-armed shape did. Indeterminate is still **503, never 204**. `REQ-BRANCH-PROTECTION-PRECONDITION` **amended, and this one DISCHARGES a debt**: the entry already cited issue #61 by number as the recorded failure its ordering exists to avoid. Forgejo is queried on `/branch_protections` and never on GitHub's `/branches/{b}/protection` adapted by 404 -- and the fix is not simply "call the other endpoint", because Forgejo's rules are GLOB patterns, so the rules are LISTED and matched (reusing `gitlab-host`'s `matchesBranch` rather than writing a second globber) and the deprecated `branch_name` field is read alongside `rule_name`, since reading only the current one reports every branch on an older instance unprotected. Azure has no protected flag at all: "protected" is a POLICY list, and three clauses are each independently load-bearing -- a policy counts only when `isEnabled` **and** `isBlocking` (advisory does not stop a push), `matchKind: Prefix` means `refs/heads/releases/` protects `refs/heads/releases/1.0` **without naming it**, and `repositoryId: null` means every repository in the project, which is how most default-branch policies are written. On both forges a non-2xx is retryable and **never `false`**. `REQ-JOB-STATUS-COMMENTS` **amended**: scope widens to four forges, and Azure's asymmetry is named -- a pull-request comment is a **thread** (`POST .../threads`), a work-item comment is `POST .../wit/workItems/{id}/comments` on a pinned preview api-version. Forgejo needs no such split: a pull request IS an issue with the same index, as on GitHub. `REQ-DURABLE-RUN-HISTORY` **amended by implementation rather than by wording**: `targetFor` enumerated github and returned `null` for everything else, so every GitLab run since #42 recorded `target: null` while `INT-RUN-HISTORY-FILE-CONTRACT` documented `<project>!<iid>` -- the docstring was right and nothing implemented it. Also recorded: an Azure work-item actor reaches the run record as a **SHA-256 prefix**, never as the email address the payload carries, so the record stays PII-free by construction. `REQ-GLOBAL-PI-OVERLAY`, `REQ-SCOPED-PAUSE-WINDOWS`, `REQ-QUEUE-BURST-NO-DROP`, `REQ-CRON-SCHEDULED-JOBS`, `REQ-RESUMABLE-SESSION` **UNCHANGED, checked**: `scopeOf` is keyed on *not local* so a new forge is scoped by its `repo` automatically, and `session-key.mjs`'s enumeration -- which WAS a silent fail-open, resolving no key for any forge it did not name -- is now keyed the same way. `REQ-UPSTREAM-CONTRACT-TESTS` **UNCHANGED, checked**: neither new forge pins an upstream SDK; both are plain HTTP against documented endpoints. |
