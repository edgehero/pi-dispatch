# Open Questions

A **register**, not a work queue. A row records the question *and*, once answered, the answer — which
is the durable half. GitHub issues are for scheduling work; an issue closes and takes its answer with
it into a place nobody greps. Rows may link to an issue; the issue may close; the row does not.

Status values: `OPEN` (unanswered) · `WATCH` (not a question — a known-incoming change to monitor) ·
`ACCEPTED RISK` (decided, shipping anyway) · `CLOSED` (answered; the answer stays here).

---

## OQ-001 — Do concurrent `createAgentSession` instances safely coexist in one Node process?

- **Status**: **CLOSED — MOOT BY DESIGN**
- **Answer**: Unreachable. `CONST-ISOLATION-CONTAINER-PER-JOB` means one agent per container per job, so
  two sessions never share a process. The source design doc said this outright: container-per-job
  *"sidesteps an open question from the research… We never find out the hard way."*
- **What would reopen it**: abandoning container-per-job. Nothing else. If that is ever proposed, this
  question comes back with it, and it is unanswered — pi's SDK documentation contains no concurrency,
  thread-safety, or parallel-session guidance, and no upstream issue addresses it. Note also that pi's
  `[Unreleased]` `modelRuntime` refactor touches shared auth/catalog state, so in-process concurrency
  should not be assumed even if it happens to work on a given day.

## OQ-002 — What is the real RAM footprint per job?

- **Status**: **OPEN**
- **Question**: Actual resident memory of pi + a dev server + headless Chromium, under a representative
  frontend job.
- **Why it matters**: `DES-CONCURRENCY-3` currently rests on a ~1.5–2.5 GB/job estimate that **nobody
  measured** — the source design doc says "measure!" and notes no published figures exist. Until this is
  answered, the concurrency default is a guess wearing a number's clothing. Note the answer may not even
  bind: the provider's rate limits likely throttle concurrent streams before Docker exhausts memory, in
  which case RAM is the wrong axis entirely and that itself is the finding.
- **Blocks**: `DES-CONCURRENCY-3` being evidenced rather than assumed. Blocks nothing from shipping.
- **How to answer**: run a representative frontend job; measure peak RSS of the container.
- **May also get an issue**: yes — this is schedulable work. The row stays regardless.
- **Update (2026-08-01, issue #53)**: the row's *cost* twin — the `$0.5–$5/job` figure recorded beside
  the RAM estimate in requirements.md's Notes — is now load-bearing in exactly one place: the cost
  what-if's **seeding fallback of last resort**, offered only for a flow with zero ledgered history,
  always as a band, always labeled `unmeasured (OQ-002)` (`REQ-COST-ANALYTICS`). Every flow that has run
  since the per-model ledger landed seeds from its own **measured median** instead, so the band's reach
  shrinks as history accrues. Once a full retention cycle of ledgered runs exists, replace the band with
  measured per-flow distributions and narrow this row to the RAM question alone.

## OQ-003 — Does the assembled system prompt survive compaction and session reload byte-identically?

- **Status**: **OPEN**
- **Question**: When pi compacts context or reloads a session, is the cached prefix reproduced
  byte-for-byte?
- **Why it matters**: `CONST-PERSONA-IN-CACHED-PREFIX`'s economics assume the prefix is stable — a
  ~10× cost difference between a cache hit and a re-send. If compaction perturbs the prefix by even one
  byte, the cache misses and the assumed saving quietly evaporates. It would not break correctness, so
  nothing would alert us; it would just cost more than the design says.
- **Honest note**: no verification pass has tested this. It is listed as unknown rather than assumed
  safe.
- **Mitigating factor**: ~~jobs are short-lived and single-purpose, so compaction may never trigger in
  practice~~ — **STRUCK 2026-07-31 by `run.resume` (issue #48)**. A resumed session is by construction
  long-lived and multi-purpose, so the one thing that made this question theoretical is gone. `pi`'s own
  docs give the threshold: auto-compaction fires at `contextTokens > contextWindow - reserveTokens`
  (default reserve 16384) and keeps `keepRecentTokens` (default 20k), appending a `CompactionEntry`. Both
  are settable in `<project-dir>/.pi/settings.json`, which is **discovered** since
  `CONST-NO-CONTEXT-FILES-MANDATORY` was reversed, so a serviced repo can move them.
- **The question this row was never asked, and now must be**: past that threshold what a resumed job
  replays is not the transcript but a **model-generated summary of it**, written while that model was
  reading attacker-authored text. That makes this a safety row as well as an economics one (`OQ-014` (d)).

## OQ-004 — Egress from the job container is unrestricted in v1

- **Status**: **ACCEPTED RISK** — *wants explicit ratification*
- **Position**: v1 ships without an allowlist proxy. A job container can reach the internet. The bound
  on exfiltration is `CONST-TOKEN-SCOPED-PER-JOB`'s short-lived, minimally-permissioned credential, not network policy.
- **Why it is a risk row and not a constraint**: the source design doc listed egress allowlisting as
  security "layer 4" while also saying v1 ships without it. **A constraint that ships unenforced is worse
  than an honest open risk** — it teaches readers that the constitution is aspirational, which corrodes
  every other entry in it. So it lives here, and `SECURITY.md` states it plainly under "what is NOT
  defended".
- **What would close it**: an allowlist proxy (`api.anthropic.com`, `github.com`,
  `registry.npmjs.org`) on a dedicated Docker network. At that point it graduates to a `CONST-`.
- **Needs**: maintainer ratification that shipping v1 this way is acceptable.

## OQ-005 — pi's `modelRuntime` migration: NOT in the pin; lands when we bump

- **Status**: **WATCH — NOT IN THE PIN**
- **Not a question — a scheduled landmine.** pi's changelog carries the breaking change under
  `[Unreleased]`: `authStorage` and `modelRegistry` *replaced* by an async `modelRuntime`.
  `createAgentSession`'s option set changes with it. **It has not shipped.** At `0.80.7` the wiring is
  `AuthStorage.create(authPath)` + `ModelRegistry.create(authStorage, modelsPath)`, both synchronous,
  and `modelRegistry.find(provider, modelId)` is the lookup. The runner is written against **that**.
- **Retracted (2026-07-16)**: an earlier revision of this row asserted `modelRuntime` was "already
  present at the pin" and concluded **"the changelog is not a reliable signal"**. Both were wrong, and
  the second was wrong in a way worth keeping on the record. The claim came from reading
  `sdk.ts` at `5e336cf` — which is **HEAD, not the 0.80.7 release**. `ModelRuntime` does not exist in
  the published `0.80.7` at all: there is no `model-runtime` module in its `dist/`, and `dist/index.js`
  does not export the symbol. **The changelog said `[Unreleased]` and meant it.** The runner was then
  written against `modelRuntime`, the image built cleanly, and every job would have died on a missing
  export — caught only when CI actually ran a container.
  The lesson is not about this row; it is the evidence convention itself, now amended in
  `constitution.md`: **a sha is not a version, and verifying a moving branch does not verify a pinned
  artifact.** Reading source remains right. Reading the *wrong* source carefully is still wrong.
- **Why it cannot be a test**: `REQ-UPSTREAM-CONTRACT-TESTS` gates *our* assumptions against a *pinned*
  version and will fire the moment the pin moves — `pinned-api.test.mjs` asserts `ModelRuntime` is
  **absent**, so the migration shipping is a test failure with a message rather than a discovery. But
  you cannot test for a change that has not shipped. This row is what a human reads before a bump.
- **Action on bump**: re-verify `dist/core/sdk.d.ts` **in the new tarball** — not on `main` — before
  moving the pin. Specifically: whether `model` is still a `Model<any>`, how it is now obtained, and
  whether `authStorage`/`modelRegistry` are gone or merely deprecated.
- **Evidence (pinned artifact — authoritative)**: `npm @earendil-works/pi-coding-agent@0.80.7 →
  dist/core/sdk.d.ts` — `authStorage?: AuthStorage`, `modelRegistry?: ModelRegistry`, **no
  `modelRuntime`**; no `dist/**/model-runtime*` exists; `dist/index.js` exports `AuthStorage` and
  `ModelRegistry` as values and not `ModelRuntime`
- **Evidence (HEAD — the incoming change, not the current one)**:
  `earendil-works/pi @ 5e336cf → CHANGELOG.md:5-10` (`[Unreleased]`) · `→ sdk.ts:33-80`
  (`modelRuntime?: ModelRuntime` present **on main only**) · `→ sdk.ts:171` (async `ModelRuntime.create`)

## OQ-006 — Which GitHub auth mechanism is the default, and when is an App required?

- **Status**: **CLOSED — default `gh` / fine-grained PAT for single-owner; App for multi-tenant**
- **Answer**: The default `GITHUB_AUTH_SOURCE` is `gh` (or a repo-scoped, short-expiry fine-grained PAT)
  for a single-owner deployment. The GitHub App path is optional, strictly stronger on the token axis
  (true per-repo scoping, shorter expiry), and **mandatory for multi-tenant** deployments — a
  fine-grained PAT is per-account and cannot isolate mutually-distrusting owners. A broad or long-lived
  classic PAT is non-conformant either way. This is the property set `CONST-TOKEN-SCOPED-PER-JOB`
  enumerates; the App is no longer a hard prerequisite for running GitHub jobs.
- **Why it was an open question**: the original design assumed a GitHub App was mandatory. Research
  found no GitHub requirement forcing an App for a single-owner tool, and `@octokit/auth-app` shipped
  declared-but-unused — so the mechanism was undecided in practice while the docs implied App-only.
- **What closed it**: this plan (the pluggable `makeGitHubAuth(pat|gh|app)` resolver) plus the E1
  amendment of `CONST-TOKEN-SCOPED-PER-JOB` from App-mandatory/one-hour to mechanism-neutral required
  properties. Recorded here so the decision is durable and greppable rather than buried in a closed PR.
- **Related risk**: `OQ-004` (unrestricted egress) is the reason the credential mechanism matters — the
  token's short expiry, not network policy, is the exfiltration bound, so the mechanism must keep that
  expiry short and the scope narrow. `OQ-004` remains **ACCEPTED RISK** (unchanged by this entry).

## OQ-007 — Run-history log & record retention: periodic (non-boot) sweep

- **Status**: **OPEN**
- **Question**: Should the durable run-history sidecars (`logs/<jobId>.{json,log}`) be pruned by a
  periodic, timer-driven sweep, and if so at what cadence?
- **Why it matters**: sidecar retention is decoupled from BullMQ's queue eviction — the records are meant
  to outlive the queue entries. Pruning is a **boot-time** age sweep only (`makeLogReaper`, window
  `PI_LOG_RETENTION_DAYS`, `0` = keep forever). A worker that runs for a long time without restarting
  therefore never re-sweeps, so `logs/` can grow between restarts. The boot sweep is the shipped partial
  answer; the periodic sweep is the unresolved half.
- **How to answer**: decide whether a timer-driven sweep is warranted and pick a cadence, or ratify
  boot-only pruning as sufficient given the expected restart frequency.
- **Secondary note**: `sanitizeJobId` collapses filesystem-illegal characters (e.g. the colons in a
  `repeat:<sched>:<millis>` scheduler id) to `_`, so two distinct job ids could in principle map to one
  filename. Considered vanishingly unlikely given the `gh-` / `local-` / `repeat:` id grammars; revisit
  with a hash suffix only if it is ever observed.
- **Blocks**: nothing from shipping. The boot sweep bounds growth across restarts today.

## OQ-008 — Runtime trigger editing: RESOLVED (the file is the write target, applied live)

- **Status**: **RESOLVED** — the admin extension edits `triggers.json`, and both services reload it live.
- **Question**: Should the admin extension edit triggers — add / edit-flow / delete a cron, label, comment,
  or pull_request trigger — and via what mechanism that survives a worker or receiver restart?
- **Why it mattered**: A Redis-side scheduler toggle is overwritten by the worker's boot reconcile
  (`REQ-CRON-SCHEDULED-JOBS`: startup removes schedulers absent from the triggers file), so a runtime edit
  that silently reverts at the next boot is worse than no edit at all. Two sources of truth — a live toggle
  and a file the boot reconcile trusts — is the failure mode.
- **Resolution**: **The file is the single write target, and the file is what reloads.** The extension's
  operator-typed CRUD dialogs (`ctx.ui` `select`/`input`/`confirm`) write `triggers.json` through
  `writeTriggers` — validated by the SHARED `parseTriggers` (fail-closed: an off-diagonal or malformed edit
  is never written) and atomic (tmp+rename, so a watcher never sees a half-written file). Both services then
  **live-reload the same file**: the worker watches it and re-`reconcile`s the cron schedulers (idempotent —
  add installs, delete prunes, edit re-upserts); the receiver watches it and hot-swaps `cfg.triggers`. A bad
  edit **keeps the running config** and logs a kept-old notice — a live service is never taken down by a
  malformed trigger file. Because the file is the one source and the reload re-reads it, the boot reconcile
  and the live edit can never diverge. Writes stay **operator-typed** — no LLM tool reaches `writeTriggers` —
  so `CONST-TRIGGER-AUTHOR-GATE` holds.
- **Blocks**: Nothing. Shipped.

## OQ-009 — Chaining from a GitHub-job parent (and cross-folder chaining) is deferred

- **Status**: **OPEN**
- **Question**: Should a GitHub-job parent ever chain follow-up flows, and by what mechanism — given its
  task text is adversarial issue content (`CONST-ISSUE-TEXT-IS-DATA`)? And, as a related future slice,
  should an outbox request ever target a **different** folder than the parent's (cross-folder chaining),
  which would need its own guard stack (realpath + a containment allowlist)?
- **Why it matters**: This slice ships chaining as **same-folder-only, local-parent-only**:
  `DES-JOB-OUTBOX-CHAINING` creates no `/outbox` mount for a `kind:github` job, and the outbox `folder`
  field is forced to the parent's own folder. Both are deliberate deferrals already decided there and
  merely recorded here — this row is the register pointer, not a reconsideration of whether to drop them
  now. A GitHub parent that could nominate host folders would cross the webhook→local trust boundary — the
  same boundary the receiver's author-gate and the container hold — so it needs its own threat analysis and
  author-gate semantics for machine-initiated follow-ups before it can ship. Cross-folder chaining has the
  same shape: it reopens the arbitrary-host-path mount that forcing the child folder to the parent's own
  closes, and so wants the realpath + containment-allowlist guard stack in its own right.
- **How to answer**: Design the threat model and author-gate semantics for a machine-initiated
  GitHub-parent follow-up (who authorizes it, and how the adversarial task text stays DATA), plus the
  realpath + containment-allowlist guard for a cross-folder target; or ratify GitHub-parent and
  cross-folder chaining as permanently out of scope.
- **Blocks**: Nothing this slice — same-folder, local-parent-only chaining ships now.

## OQ-010 — Does pinned pi (0.80.7) emit per-turn token usage on the subscribe stream?

- **Status**: **CLOSED — YES: per-turn token usage rides `event.message.usage` on the `subscribe()` bus**
- **Answer**: Yes. `session.subscribe()` delivers the full `AgentEvent` union, and `turn_end` (plus
  `message_start`/`message_update`/`message_end` and `agent_end`) carries `message: AgentMessage`. An
  assistant message's `usage: Usage` field is **required** (non-optional) and holds `input`, `output`,
  `cacheRead`, `cacheWrite`, `cacheWrite1h?`, `reasoning?`, `totalTokens`, and a `cost` breakdown. Read it
  as `event.message.usage` when `event.type === "turn_end"` and `event.message.role === "assistant"`. The
  one caveat: usage is **nested inside the message payload, not a top-level event field** — the bare
  `turn_start` on this bus still carries nothing (that is why `REQ-RUNNER-TURN-BUDGET` counts turns
  itself). The cumulative, as-billed session total is separately available via `session.getSessionStats()`.
- **Scope correction (2026-07-28)**: the answer above is **true and root-session-scoped**, and the second
  half was never said. `session.subscribe()` delivers the events of **that session instance and no other**:
  `_eventListeners` is an array on the instance, `Agent.listeners` a `Set` on the instance,
  `CreateAgentSessionOptions` carries no parent/shared-bus option, and **no event carries a `sessionId`**.
  So "pi emits per-turn token usage on the subscribe stream" answers *"can we meter a session?"* and not
  *"can we meter a job?"* — a subagent session an extension spawns through `createAgentSession` emits
  nothing on the parent's bus, and a 16-wide fanout registers there as roughly **one** turn. Everything
  built on this row is unaffected in shape and was understating spend precisely on the most expensive jobs.
  Issue #58 moves the accounting to pi-ai's module-level api-provider registry — the one choke point every
  in-process session shares — and keeps this bus sum as the fallback
  (`REQ-TOKEN-ACCOUNTING-AND-CAPS`, `DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY`). The row is corrected in
  place rather than deleted, because the *question it asked* was answered correctly and the gap was in the
  question's reach, not in its answer — and a register that quietly widens a past answer teaches the next
  reader to trust its scope more than it deserves. The same correction bounds `REQ-RUNNER-TURN-BUDGET`,
  whose counter reads the same per-instance bus and is now explicitly scoped to root-session turns.
- **Why it mattered**: this gated the entire hypothetical token-cap chain (usage capture → per-job token
  budget → daily token counter → per-job token totals in run history). No usage on the stream = no token
  cap at all. pi-dispatch bounds **jobs** (`CONST-BUDGET-BEFORE-TOKENS`) and **turns**
  (`REQ-RUNNER-TURN-BUDGET`) but never tokens; the only $ ceiling today is provider-side
  (`CONST-TOKEN-SCOPED-PER-JOB`, the broad-key exception). This answer removes the blocker.
- **Design constraint (recorded)**: a token cap is structurally a **lagging** control — a job's token
  cost is known only *after* a turn runs, unlike a job *count*, which is knowable *before* and is exactly
  what makes `CONST-BUDGET-BEFORE-TOKENS` a proactive check. So even with usage data: a **daily** token
  cap can only stop the *next* job, and a **per-job** token budget can abort mid-run but only once earlier
  turns' tokens are already spent. `maxTurns` (`REQ-RUNNER-TURN-BUDGET`) therefore remains the one
  **proactive** per-job token lever; usage-exists does not by itself yield a before-the-spend token cap.
- **What closed it**: spike #21, verified against the pinned npm artifact (per the evidence convention in
  `constitution.md` — a sha is not a version; cf. `OQ-005`). Recorded here so the answer is durable and
  greppable rather than dying with the closed issue.
- **Unblocks**: the follow-up (#25), now **landed** as `REQ-TOKEN-ACCOUNTING-AND-CAPS` — per-job token/cost
  accounting in the run record + admin views, an optional in-run per-job token budget, and an optional daily
  token counter (check-after). The capture hook this OQ pointed at (`captureTerminal`,
  `image/runner/src/outcome.mjs`, reading `event.message` on `turn_end`) is now joined by a synchronous
  `attachTokenBudget` meter that sums `event.message.usage`; the lagging-control constraint recorded above is
  what shapes that REQ's check-after daily cap.
- **Evidence (pinned artifact — authoritative)**: `npm @earendil-works/pi-coding-agent@0.80.7 →
  dist/core/agent-session.d.ts:255` (`subscribe(listener)`), `:84` (`AgentSessionEventListener`), `:40-82`
  (`AgentSessionEvent` is the `AgentEvent` union plus session-only events) · `npm
  @earendil-works/pi-agent-core@0.80.7 → dist/types.d.ts:362-400` (`AgentEvent`; `turn_end` at `:370-372`
  carries `message: AgentMessage`) · `npm @earendil-works/pi-ai@0.80.7 → dist/types.d.ts:288` (`usage:
  Usage` required on `AssistantMessage`), `:251-272` (`Usage` shape) · runtime-confirmed `npm
  @earendil-works/pi-agent-core@0.80.7 → dist/agent-loop.js:108,130` (emits `turn_end` with the finalized
  message untouched). All three packages resolve to `0.80.7` under the lockfile.

## OQ-011 — A package that spawns a `pi` SUBPROCESS is unmetered

- **Status**: **ACCEPTED RISK** — *wants explicit ratification*
- **Position**: v1 ships with **in-process** token accounting. The process-wide meter
  (`REQ-TOKEN-ACCOUNTING-AND-CAPS`) covers every session created inside the runner's own Node process,
  which is the fanout an extension normally produces. It cannot see a **child process**: a staged package
  that shells out to the `pi` binary gets its own Node process, its own pi-ai module registry, and its own
  provider calls, none of which pass through anything the runner wrapped. Those tokens are spent, billed,
  and absent from both the exit line and the daily token counter. This is not hypothetical — **pi's own SDK
  example spawns a `pi` subprocess**, so it is the pattern a package author is most likely to copy.
- **Why it is a risk row and not a constraint**: no in-process hook can close it, in any language. A
  constraint that ships unenforced is worse than an honest open risk — it teaches readers that the
  constitution is aspirational, which corrodes every other entry in it. The same reasoning that put
  `OQ-004` here rather than in `constitution.md`.
- **What detection ships today**: a Linux-only child-process sampler (`/proc/self/task/*/children`),
  sampled on the meter's re-arm tick and logged at teardown as a distinct/peak child count. It is purely
  diagnostic — it degrades to nothing off Linux, swallows every error, and can never fail a job — and it
  detects only that a job **went wide**, never what that went-wide cost. Naming a number it cannot know
  would be worse than reporting none.
- **What would close it**: a container-level egress proxy that terminates TLS and accounts provider traffic
  per container rather than per process. That is the same mechanism `OQ-004` names, arriving for a
  different reason — which is why this closes **with** `OQ-004` rather than before it. Reading usage off a
  subprocess needs to read its HTTP, and reading its HTTP needs TLS termination; there is no cheaper
  version of this.
- **What bounds it meanwhile**: the job-count caps (`CONST-BUDGET-BEFORE-TOKENS`), `maxTurns` on the root
  session, the 30-minute container timeout (`REQ-JOB-TIMEOUT-30M`), and the provider-side spend limit
  `SECURITY.md` tells every operator to set. Also the four gates in front of a staged package at all: an
  operator declares it, pins it, stages it, and arms it per trigger.
- **Related risk**: `OQ-004` (unrestricted egress) — same fix, and it remains **ACCEPTED RISK**, unchanged
  by this entry.
- **Needs**: maintainer ratification that shipping staged packages with in-process-only metering is
  acceptable, given that the unmetered path requires an operator to have staged and armed a package that
  spawns `pi`.


## OQ-013 — GitLab's approval gate is weaker in kind than GitHub's, and depends on a lookup that can fail

- **Status**: **ACCEPTED RISK** — *wants explicit ratification*
- **Position**: GitLab triggers ship gated on an API-resolved project `access_level >= 30` (Developer),
  applied to every trigger type. That is the strongest gate GitLab makes available, and it is weaker than
  GitHub's in three ways that are worth naming rather than averaging away.
  **(a) It is a network call, not a payload field.** GitHub computes `author_association` and hands it
  over inside the signed body, so its gate is decidable from the delivery alone. GitLab computes nothing
  equivalent, so authority is established by asking — and asking can fail. It fails *closed* for a
  determinate answer (a 404 is level 0, refused) and *loudly* for an indeterminate one (503, redelivered),
  but a gate with a moving part is not the same object as a gate without one.
  **(b) The role table is not fixed.** The minimum role for label management has differed across GitLab
  versions, and Ultimate's **custom roles** let an operator grant individual permissions at any level. So
  `>= 30` is a claim about a number, and what that number *permits* is the operator's to know. This is
  precisely why the gate does not read the label as an approval the way the GitHub path does.
  **(c) A Guest can label an issue at creation.** That single fact is what forced (b)'s conclusion: a
  stranger can open an issue already carrying the trigger label, so on GitLab a label proves nothing at
  all about who approved anything.
- **Why it is a risk row and not a constraint**: `CONST-TRIGGER-AUTHOR-GATE` already states what the gate
  IS, per forge, and the code enforces it. What this row records is the residual after that enforcement —
  the shape of what is left, not an unimplemented intention. A constraint that promised parity between the
  two forges would be a constraint that shipped unenforced, which this project holds to be worse than an
  honest open risk (`OQ-004`, `OQ-012`).
- **What bounds it meanwhile**: The gate is `>= 30`, not `> 0` — Guest (10), Reporter (20) and GitLab's
  intermediate roles are all refused, so the population that can start a paid run is the population that
  could push a branch itself. The lookup uses `members/all`, so group-inherited access counts and a real
  maintainer is not refused for holding their role one level up. The bot-loop guard runs BEFORE the access
  gate, so the harness's own note cannot recurse even though its token IS a project member. Verification
  runs before the lookup, so an unauthenticated flood cannot make this project call GitLab at all. And
  every gate downstream is unchanged: budget, pause windows, branch protection, never-merge.
- **What detection ships today**: An indeterminate lookup logs `gitlab_access_lookup_failed` and answers
  503, so a broken or revoked token is loud rather than silent — the failure mode is "nothing runs and
  GitLab keeps retrying", never "everything runs". `doctor` reports whether `GITLAB_TOKEN` is set when the
  triggers file names gitlab, and names the `api`-scope trade-off.
- **What would close it**: A GitLab-side equivalent of `author_association` — a payload field stating the
  actor's relationship to the project, inside the signed body. None exists, and none is announced. Short
  of that, the honest improvement is narrower: cache nothing, and keep the refusal loud.
- **Related risks**: `OQ-004` (egress) is unchanged and now applies per forge. `CONST-TOKEN-SCOPED-PER-JOB`
  carries the *credential* half of GitLab's weakness — `api` scope, hand-minted expiry — which is a
  separate axis from this row's *authorisation* half.
- **Needs**: A maintainer's explicit ratification that a resolved Developer-or-above access level is an
  acceptable substitute for GitHub's collaborator gate, given (a), (b) and (c) above.

---

## OQ-014 — A resumed session is state crossing jobs, and its key is a name the base repo's push population can choose

- **Status**: **ACCEPTED RISK — RATIFIED 2026-07-31, and SCOPED.** Accepted for a deployment whose
  serviced repositories' **push-access population the operator controls, or trusts with the contents of a
  transcript**. A **multi-tenant** deployment — servicing repositories whose push access the operator does
  not control — **must not arm `run.resume`**, exactly as it must turn context discovery back off
  (`CONST-NO-CONTEXT-FILES-MANDATORY`).
- **Why the verdict is scoped rather than blanket, which is the substance of the ratification**: every
  part of the residual below is a function of **who holds push access to the serviced repository**, and
  that is a property of the deployment, not of this code. A single blanket "accepted" would be a
  statement about repositories this project has never seen. This register already answers that shape
  twice — `CONST-NO-CONTEXT-FILES-MANDATORY` is accepted for single-tenant and must be reversed for
  multi-tenant, and `CONST-TOKEN-SCOPED-PER-JOB` makes the App path **mandatory for multi-tenant** while
  a fine-grained PAT suffices for single-owner. This is the third instance of the same split, and it is
  the honest one here for the same reason.
- **What settles it for the in-scope case, and it is a comparison rather than an assurance**: the
  2026-07-28 reversal of `CONST-NO-CONTEXT-FILES-MANDATORY` deliberately granted the default-branch
  population **arbitrary code execution inside job containers, with the job token and open network
  egress**. This grants the push-access population **read access to a transcript**. The population is one
  step wider; the capability is dramatically narrower — and the wider population is not a stranger, it is
  someone who can already push code to the repository the agent is working in. Refusing a transcript to
  an account that can push to `main`'s neighbour branches, in a deployment that already hands that
  account's commits to an agent, would be a bound in the wrong place. **This change is a smaller
  concession than one this project has already made on purpose.**
- **What the scope condition costs, stated rather than glossed**: it is DOCTRINE, not a mechanism.
  Nothing refuses `run.resume` on a multi-tenant deployment, because nothing in this codebase can tell
  the two apart — "do you control who can push to the repositories you service" is not a question a
  worker can ask. It is enforced the same way its two precedents are: written here, in `SECURITY.md`, in
  `docs/sessions.md`, and warned about by `pi-dispatch doctor` whenever a trigger arms the flag. An
  operator who reads none of those gets no protection from any of them.
- **Position**: `run.resume` ships persisting the agent's session transcript per key and replaying it into
  the next job on that key. `CONST-ISOLATION-CONTAINER-PER-JOB` is **amended rather than reinterpreted**,
  and its Acceptance now enumerates a fifth mount. What remains after that enforcement is four things,
  worth naming rather than averaging away.
  **(a) The key is a name, not an identity.** `pi/issue-<n>` is asked for by a prompt and a hard rule and
  verified by nothing. Anyone who can push to the base repository can create a branch of any name, open a
  pull request from it, and — if they are in `AUTHOR_ALLOWLIST`, or a collaborator acts on it — receive the
  transcript keyed to that name. Issue numbers do not recycle; **branch names do**.
  **(b) The population is one step wider than the one already trusted.**
  `CONST-NO-CONTEXT-FILES-MANDATORY` trusts *"anyone who can land a commit on the default branch"*, which
  branch protection narrows. Push access to a side branch passes no gate. The delta is small and
  enumerable — the model's own reasoning, and whatever a credential-bearing command echoed — but "small"
  is a judgement someone has to make on the record.
  **(c) The transcript is a durable capture of everything the agent saw.** It is strictly more PII-bearing
  than `logs/<jobId>.log`, which `REQ-DURABLE-RUN-HISTORY` made opt-in and gitignored precisely because it
  *"may echo issue text"* — and unlike that log it **must exist for the feature to work at all**.
  **(d) Replay is a placement class this project has never had.** `CONST-ISSUE-TEXT-IS-DATA` is enforced
  by placement: rules above, payload below. A replayed transcript is neither — it is prior turns, some in
  the assistant's own voice, from a previous job's adversarial input. An injection that failed once
  because the guardrail floor held returns as *"the assistant previously did X."* And if pi compacted,
  what returns is not the transcript but a **model-generated summary of it**, written while that model was
  reading attacker text.
- **Why it is a risk row and not a constraint**: `CONST-ISOLATION-CONTAINER-PER-JOB` already states what
  the boundary is, now including its one exception, and the code enforces it. This row records the
  residual **after** that enforcement. A constraint promising a resumed transcript reaches only its own
  author would be a constraint shipped unenforced, which this project holds to be worse than an honest
  open risk (`OQ-004`, `OQ-011`, `OQ-012`, `OQ-013`).
- **What bounds it meanwhile**: The feature is **off by default and per trigger** — absent `run.resume`,
  not one byte is written and the docker argv is unchanged. A **fork is refused**, expressed as a missing
  key rather than a checked boolean, and the head repository is read from the forge API rather than from
  attacker-supplied payload fields. The **canonical store is never mounted**, so a compromised agent that
  computes another key cannot reach it — the mount is the capability and the hash is not one.
  **Completed-only promotion** means a failed or refused run leaves the canonical file byte-identical
  (`CONST-RETRY-INFRA-ONLY`). An **exclusive per-key lock** means one writer. The **directory name is a
  hash**, so a branch name never becomes a host path segment. **Age, size, shape and pi version are gated
  host-side at open**, with `lstat` and regular-files-only, so an agent cannot turn the store into a
  host-file-read or disk-exhaustion primitive. And every gate downstream is unchanged: budget, pause
  windows, branch protection, never-merge, the bot-loop guard.
  **One thing it deliberately does not bound**: the key does not include the flow. Two flows armed on one
  pull request share one transcript, because cross-flow continuity IS the feature — the issue flow opens
  the PR and the review flow continues it. `run.resume` being per trigger is how an operator decides which
  flows join that lineage.
- **What detection ships**: the run record carries `session.{resumed, reason, bytes}` — a boolean, a fixed
  enum and an integer, deliberately **not** the key or the branch name. Every non-resume is a named reason
  rather than a silent cold start. `pi-dispatch doctor` reports the store's presence and warns about its
  contents whenever a trigger arms the flag. What ships **undetected** is the CONTENT of a transcript:
  nothing scans it, and nothing will — see below.
- **What would close it**: a key the push population cannot choose — a forge-assigned identifier joining an
  issue to the pull request its job opened. `pull_request.number` is exactly that and is useless here,
  because nothing host-side knows which PR an issue's job created without **recording** it, and recording
  it is the index `DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED` refuses. Closing this row therefore means
  either accepting an index or GitHub surfacing the issue-to-PR link in a payload. Short of that the
  honest improvements are narrower: shorten `PI_SESSIONS_TTL_DAYS`, and keep the refusals loud.
  **A transcript redactor is explicitly NOT the answer** and should not be proposed as one: this project's
  own position is that content-filtering natural language is not a boundary (`CONST-ISSUE-TEXT-IS-DATA`),
  and a scrubber that rewrote a session file would corrupt the artifact it was protecting.
- **Related**: `OQ-003` is **amended by this change** rather than merely cited — its mitigating factor
  (short-lived, single-purpose jobs) is exactly what resume removes. `OQ-004` is unchanged in kind and
  **wider in reach**: exfiltration was bounded to one job's own view and is now bounded to the key's
  accumulated history, retrievable in one request. `OQ-007` stops being disk hygiene for this store and
  becomes a resume-window question, which is why the age gate runs at open as well as at boot. `OQ-009` is
  **not** resolved by the new mount — `/outbox` nominates host folders and enqueues paid jobs; `/session`
  returns bytes to one key, creates no job and names no host path.
- **What would REOPEN it** (the ratification above is not permanent): a mechanism that lets the harness
  distinguish single- from multi-tenant, which would turn the doctrine into a refusal; a report of a
  transcript reaching an account the operator did not expect, which would mean the push-access framing is
  wrong rather than merely wide; or `run.resume` becoming settable by anything other than an edit to the
  reviewed `triggers.json` — the model-callable write path is deliberately excluded today
  (`admin/src/index.ts`, `buildTriggerEntry`), and that exclusion is load-bearing for this verdict rather
  than incidental to it.

## Retired from the source design document

`DESIGN.md` v0.1 §10 carried a ten-item "verify-on-implementation checklist". It is not reproduced here,
because most of it is now **answered** — and answered items are not open questions, they are ordinary
spec content. They live in `constitution.md`, `requirements.md`, `design.md`, and `interfaces.md` with
their evidence, with no trace back to a checklist.

Seven of those answers were **corrections**: `pi --mode print` does not exist; the mode union has no
`tui`; no max-turns exists anywhere in pi; `AGENTS.md` is not trust-gated; the persona decisions #1 and
#2 were mutually exclusive; the Dockerfile was broken for non-root; the pinned version was stale on
arrival. One resolved in our favour: the "caches roll at midnight" caveat is obsolete — 0.80.7 removed
the date from the default system prompt.

**The recurring class that the checklist could not express** — "re-verify on every pi upgrade" — is not
a question at all and does not belong in a register. It became `REQ-UPSTREAM-CONTRACT-TESTS`: a CI gate,
because a prose checklist depends on a maintainer reading it at 11pm during an upgrade, and a failing
build does not.

## OQ-012 — An operator-built job image is outside every gate this repo has

- **Status**: **ACCEPTED RISK** — *wants explicit ratification*
- **Position**: A trigger's `run.image` (`INT-TRIGGERS-FILE-CONTRACT`) may name an image this repo did not
  build, did not assert, and cannot inspect. Such an image carries **its own pi version**
  (`CONST-PI-VERSION-PINNED` cannot reach it), **its own runner and exit-code behaviour**
  (`INT-RUNNER-EXIT-CODE-PROTOCOL`), **its own guardrails floor or none** (nothing requires
  `/opt/pi-dispatch/HARD_RULES.md` to exist or to be root-owned), **its own loader posture**
  (`CONST-NO-CONTEXT-FILES-MANDATORY`'s discovery switch is a source edit plus a rebuild, i.e. **per image**
  — a deployment that turned discovery off for multi-tenancy in one image has not turned it off in another),
  and its own baked env. `REQ-UPSTREAM-CONTRACT-TESTS`' *"No image publishes on a failed assertion"* is a
  statement about **our** publish step; an operator's image publishes on none.
- **Why it is a risk row and not a constraint**: there is no mechanism in this repo that can gate it. The
  worker drives the local `docker` CLI (`DES-WORKER-ON-HOST`) and can learn that a tag **exists**; existence
  is not conformance, and every non-conformance on the list above fails **silently** — a stale pi makes jobs
  no-ops that report success; an absent guardrails file removes the safety floor with no error; wrong exit
  codes make the queue pay to retry work that can never succeed; a flipped loader flag changes the security
  posture with no signal. A constraint that ships unenforced corrodes the ones that are enforced, which is
  the same reasoning that put `OQ-004` here.
- **What bounds it meanwhile**: the isolation surface is the **worker's argv**, not the image's —
  `--cap-drop=ALL`, `no-new-privileges`, the memory/cpu/pids/shm limits and the four mounts hold for any
  image, so a non-conformant image is a **worse agent**, not a wider blast radius; `run.image` is writable
  only by an operator editing a reviewed file (no tool parameter, no panel key, no overlay key, and no env
  allowlist to misconfigure — `DES-PER-TRIGGER-JOB-IMAGE`); the pre-spend `docker image inspect` plus
  `--pull=never` mean the only images that can run are ones the operator themselves built or pulled onto
  that host; and `PI_JOB_IMAGE` remains the default, so the risk exists only for deployments that opted in.
- **What detection ships today**: presence, and only presence. The worker's preflight and `pi-dispatch
  doctor` check that every image named across `triggers.json` (plus `PI_JOB_IMAGE`) resolves locally and
  refuse/report by name; doctor additionally **warns** when a named image's entrypoint does not look like
  the runner. Neither inspects the image's contents. Naming a conformance verdict that had not been computed
  would be worse than reporting none — the same honesty as `OQ-011`'s child-process sampler.
- **What would close it**: a worker-side gate at job start. Half the ingredients exist — `image/verify-image.sh`
  is the CORE checklist as one runnable definition, shared by CI and by the operator, and it runs **on the
  host that holds the image**, which is the only place it can (`--pull=never` means the runnable images are
  exactly the local ones, so a CI runner elsewhere could never verify them). What is missing is the harness
  running it. The honest
  difficulty is that the cheap version of the gate does not work: a required OCI label proves **intent**, not
  conformance, because an image can assert any label it likes. The only non-lying check is *running* the
  assertions, which costs a container start per distinct image — cacheable per image ID, but a real cost and
  a real complication, and not worth building before anyone runs a second image.
- **Related risks**: `OQ-004` (unrestricted egress) and `OQ-011` (unmetered `pi` subprocess) — both
  unchanged by this entry, and both now additionally **per-image**, since an operator's image could ship
  neither the meter nor `PI_OFFLINE`'s in-process re-assertion.
- **Needs**: maintainer ratification that shipping per-trigger images with presence-only verification is
  acceptable, given that every image nameable is one the operator built or pulled themselves onto the host
  running the worker.

---

## Known gap

`DESIGN.md`'s header records "50 claims adversarially verified: 48 confirmed, **2 refuted**". Only one
refutation is documented in it (the pi-caveman premise correction, §5.7). **The second is never
stated.** Refutations are anti-facts — they stop a wrong design being re-derived — and this one dies
with the uncommitted document. If the maintainer can recall it, it belongs in `design.md` as a rejected
alternative. Partly academic now: source-verification subsequently found seven more errors than both
adversarial passes did.

---

## OQ-015 — Azure DevOps deliveries are authenticated by a bearer secret that covers no bytes, and dedup keys off the body it cannot vouch for

- **Status**: `ACCEPTED RISK` — *wants explicit ratification*
- **Position**: Azure DevOps Service Hooks offer **no HMAC of any kind**. A subscription can carry HTTP
  Basic credentials or a static custom header, and nothing more. Three facts follow, and they compound:
  **(a)** the credential proves the sender knew a secret and says nothing about the body's integrity — the
  same weakness `X-Gitlab-Token` has, already admitted by name in `CONST-HMAC-OVER-RAW-BODY`; **(b)** Azure
  sends **no delivery-id header**, so `REQ-DEDUP-BY-DELIVERY-GUID`'s key is the body's own top-level `id`,
  which is inside the very payload the credential cannot vouch for; **(c)** Azure signs **no timestamp**, so
  unlike GitLab there is no replay window as a second line of defence. Anyone holding the secret can
  therefore compose an arbitrary delivery, and anyone who captured one can replay it as new paid work once
  the 31-day job key ages out.
- **Why it is a risk row and not a constraint**: A constraint promising body integrity on Azure would be a
  constraint that shipped unenforced, which this project holds to be worse than an honest open risk
  (`OQ-004`, `OQ-012`, `OQ-013`). The mechanism does not exist to enforce; Microsoft would have to add it.
- **What bounds it meanwhile**: HTTPS is mandatory and the docs say so — over plain HTTP the credential is
  on the wire in base64, which is not encryption. The secret is operator-held and per-endpoint, so it is
  not shared with any other forge's arm. The author gate still runs: a forged delivery must still name an
  actor who resolves to a project member, so holding the secret alone does not let a stranger name
  themselves an owner. And every downstream money gate is unchanged — the budget cap, the pause windows and
  the branch-policy precondition all apply to a forged delivery exactly as to a real one.
- **What detection ships today**: every drop and every enqueue is logged with the delivery id, so a replay
  shows as a second `enqueued` for an id that already ran — visible in the run history, though not alerted
  on.
- **What would close it**: an HMAC option on Azure Service Hooks, which does not exist. Short of that, a
  deployment can narrow the exposure by fronting the receiver with something that pins the sender (mutual
  TLS, or an IP allowlist against Azure's published ranges) — neither of which this project can enforce or
  verify, which is why they are advice in `docs/azure-devops.md` and not clauses here.
- **Related risks**: `OQ-013` (the gate depends on a lookup that can fail — and on Azure that lookup is
  *two* calls, so the indeterminate surface is wider, not merely repeated), `OQ-004`.
- **Needs**: explicit ratification, or a decision that Azure DevOps is not a forge this project services.

---

## OQ-016 — The admin panel suspends pi's TUI to hand the terminal to a sandbox, and that pair is verified by reading, not by running

- **Status**: `WATCH`
- **Position**: `b` on the RUN_DETAIL screen opens a run's sandbox **in place**: `tui.stop()`, spawn
  `docker run -it` with `stdio: "inherit"`, then `tui.start()` and a forced full re-render
  (`REQ-RESURRECTABLE-SANDBOX`). Nothing in pi's *extension* API offers this — `ExtensionUIContext` has
  `select`/`confirm`/`input`/`notify`/`onRawInput`/`custom` and nothing else, and `execCommand` captures
  stdout rather than inheriting it. What makes it work is that the `custom` factory hands the component
  the real `TUI`, whose `start`/`stop` are a symmetric suspend/resume pair: `stop()` clears the render
  timer, moves the cursor past the rendered content, restores the cursor, and calls `terminal.stop()`,
  which disables bracketed paste and the Kitty protocol, removes listeners, pauses stdin and restores the
  prior raw-mode state.
- **Why it is a WATCH row and not a claim**: this is verified **against the pinned artifact by reading
  it**, plus the strongest circumstantial evidence available — pi uses the same pair itself, for the same
  purpose, to launch `$EDITOR` (`modes/interactive/components/extension-editor.js`), and
  `ProcessTerminal.start`'s own comment says the dimensions refresh exists because *"SIGWINCH is lost
  while the process is stopped"*, which is a sentence about being suspended across an external program.
  It has **not** been run end-to-end here. `constitution.md`'s evidence rule is to verify against the
  pinned artifact rather than HEAD; it does not claim reading is the same as running, and neither does
  this row.
- **What bounds it meanwhile**: the failure mode is cosmetic and recoverable, not a security or
  correctness one — a panel that does not redraw cleanly is fixed by reopening `/dispatch`. `tui.start()`
  sits in a `finally`, so a launch that throws still resumes the panel, and a test pins that ordering.
  The CLI path (`pi-dispatch sandbox`) shares none of this: it owns its terminal outright.
- **What would reopen it**: any pi upgrade that changes `TUI.start`/`TUI.stop`, `ProcessTerminal`, or
  drops `tui` from the `custom` factory's arguments — the last of which would be a compile-time break
  rather than a silent one. Also: the first report of a panel that does not come back cleanly on a
  terminal we have not tried.
- **Related risks**: `OQ-012` (a conformance list this repo cannot enforce), `OQ-004`.

## OQ-017 — Two replicas on a pull_request-typed target share one head branch, and only the prompt asks them not to collide

- **Status**: `WATCH`
- **Position**: `run.replicas` (`REQ-REPLICA-RUNS`) is allowed on `pull_request` triggers as well as
  `label` and `comment` ones, per issue #56. On an **issue**-typed target that is fully bounded: the host
  mints `pi/issue-<n>-r1` and `-r2` and each replica is told to push only to its own. On a
  **pull_request**-typed target there is no branch to mint — the flow decides whether to review, comment
  or push, and if it pushes, it pushes to the PR's own head branch, which belongs to a human and which
  every replica sees identically. The harness bounds nothing here; the prompt asks.
- **Why it is allowed rather than refused**: the common and useful case is a **review** flow, where two
  independent reviews of one pull request are exactly the second opinion the feature exists to buy and
  nothing is written at all. Refusing the whole target type to bound a pushing flow would remove the
  safest use of the feature to guard against its least common one.
- **What bounds it meanwhile**: three things, none of them a boundary and all of them stated as such. The
  replica paragraph in the prompt names the index and says plainly that a sibling is running the same flow
  on the same branch. `HARD_RULES` rule 3 permits only `--force-with-lease`, never `--force`, and a lease
  is genuinely mechanical: it **refuses** when a sibling has pushed since the ref was read, so the
  collision surfaces as a failed push rather than as lost work. And the replicas share `PI_CONCURRENCY`
  with every other job, so on a busy worker they often serialise anyway — which is luck, not a control,
  and is recorded here as such.
- **What would reopen it**: the first report of a replica pair overwriting each other's commits on a PR
  head; a flow that force-pushes as a matter of course; or any move to per-replica branches for
  pull_request targets, which would need a name the harness can mint without owning the human's branch.
- **Related risks**: `OQ-014` (a session key is a name the base repo's push population can choose),
  `OQ-012` (an operator-built image is outside every gate this repo has — and it is the gate that would
  otherwise catch a stale safety floor here).

## OQ-018 — `host-pi.mjs` reimplements two unexported pi internals, and pi offers no public alternative

- **Status**: `ACCEPTED RISK`
- **Position**: `worker/src/host-pi.mjs` (issue #102) answers two questions pi exports no public API for.
  **Where a package the operator installed lives**: `getNpmInstallPath` for user scope, including the
  precedence that honours `<agentDir>/npm/node_modules/<name>` first and the global npm/pnpm/bun root
  **only** when that is absent. **Whether a resource is enabled**: `isEnabledByOverrides`'s grammar, where
  a `-path` exact force-exclude beats a `+path` exact force-include beats a `!glob` exclude, plus the
  `autoload` flag and per-kind pattern arrays that do the same job for a package's own resources. Both are
  read out of a dist bundle. Neither is reachable from `@earendil-works/pi-coding-agent`'s exports.
- **Why it is a risk row and not a constraint**: a constraint would promise the mirror stays true, and
  nothing here can enforce that — pi would have to publish the surface. The honest shape is the same one
  `OQ-012` and `OQ-013` take: state the gap rather than imply coverage.
- **Why it matters more than an ordinary upstream dependency**: the failure is **not** a crash, and that is
  the whole reason this row exists. If pi changes the grammar, the mirror keeps answering confidently and
  `import-pi` silently stages a package the operator turned off, or silently withholds one they did not.
  That is the silent-no-op class this project refuses, reached from a direction no runtime assertion sees:
  every downstream gate still passes, because the wrong answer is well-formed.
- **What bounds it meanwhile, and what detection ships today**: two pins, deliberately at different
  distances. `worker/test/host-pi.pinned.test.mjs` asserts the **resolved artifact** and rides the existing
  `contract-tests` job, so a pi bump that moves any mirrored internal fails the build rather than the
  operator's overlay. `.github/scripts/host-pi-canary.mjs` runs the same needles against `pi@latest` inside
  the `admin-extension-canary` job, so a release that will break the next bump is visible before anyone
  makes it. Both import `PINNED_PI_NEEDLES` from `host-pi.mjs` itself, so the gate and the canary cannot
  drift apart: a needle added to one is checked by both. Beyond the pins, the mirror is built to admit
  ignorance — a glob in an enablement pattern returns a **third** state rather than a guess, the extension
  is copied, and the command prints which ones it could not decide about.
- **What would close it**: pi exposing a supported way to ask "where is this package installed" and "is
  this resource enabled". Short of that the needle list **is** the contract, and it must grow whenever the
  mirror does — which is the standing argument for keeping the mirror small, and half the reason `OQ-019`
  leaves three parts of pi's setup unreached.
- **What would reopen it louder**: a pi release where the pinned test passes and the behaviour changed
  anyway — i.e. the needles turn out to be checking the wrong lines. That is the failure the two-distance
  split cannot catch, and the only remedy is re-deriving the mirror against the source, not the needles.
- **Related risks**: `OQ-005` (the upstream-drift row this is the same species as, and the one whose
  correction records that a sha is not a version), `OQ-011`.

## OQ-019 — Discovery reaches npm packages only, and the enablement mirror reaches extensions only

- **Status**: `WATCH`
- **Position**: `import-pi --with-packages` discovers what the operator installed in pi (issue #102), but
  three parts of their setup are deliberately out of its reach, and this row is the register pointer rather
  than a reconsideration of any of them.
  **(a) Git-sourced packages** are skipped by name, never staged. `pi-packages.json` validates an npm name
  plus an exact semver (`INT-PI-PACKAGES-FILE-CONTRACT`), and a git ref is neither, so staging one needs a
  second entry type in that contract **and** a fresh `CONST-PI-VERSION-PINNED` argument about whether a
  commit sha counts as a pin. That is a spec amendment wearing an implementation's clothes.
  **(b) Skills, prompts and themes enablement** is not mirrored; only `extensions/` is, because only
  `extensions/` runs code in every job container. The other three kinds are data.
  **(c) Project-local installs** (`pi install -l`, which land in `<cwd>/.pi/npm`) are not discovered.
- **Why each is deferred rather than dropped**: (a) is real work someone may want, and it is scoped above.
  (b) is a cost/benefit call that leans on `OQ-018`: every additional mirrored internal widens that risk,
  and the sharp edge is already covered. (c) is the uncomfortable one and worth stating plainly — those
  packages are the **operator's**, so the trust argument that bars a serviced repo's packages does not
  apply to them, and the reason to defer is that `<cwd>/.pi/` sits one character from a *serviced* repo's
  `.pi/`. Confusing the two would be a security bug rather than a feature gap, so the path deserves its own
  design pass rather than an extension of this one.
- **The reconciliation this row also carries**, because nothing else states it in one place: a serviced
  repo's declared **packages** are never installed, while its `.pi/extensions` **do** load, and that is not
  a contradiction. The extensions load because `/workspace` is the base repo's **default-branch sha**, so
  the content is merge-gated rather than fork-controlled. Installing what a repo declares would be
  different in kind: it would put third-party install-time and load-time code next to a live minted forge
  token in a container with open egress, on the say-so of anyone who can merge. If it is ever wanted, the
  shape is an operator-held allowlist, not a per-repo opt-in, because the repo is the thing not trusted.
- **What would close it**: (a) a decision on how a git ref is pinned, or a ratification that git-sourced
  packages are permanently out of scope; (b) evidence that a non-extension resource the operator disabled
  causing a job to behave differently is a real complaint rather than a hypothetical; (c) a design that
  cannot confuse the operator's own project dir with a serviced repo's.
- **Blocks**: nothing this slice — npm-sourced discovery and extension enablement ship now, and every
  unreached case is **printed by name** at stage time rather than passed over in silence.
- **May also get an issue**: (a), if someone intends to schedule it. The row stays regardless.

## Revision History

| Date | Change |
|---|---|
| 2026-08-07 | Issue #102 (auto-import pi packages from the global pi setup). Added **`OQ-018`** (`ACCEPTED RISK`): `worker/src/host-pi.mjs` reimplements two internals pi does not export — the user-scope install-path lookup with its managed-before-global precedence, and the `-` beats `+` beats `!` enablement grammar. Recorded rather than left as an implementation detail because the failure mode is not a crash: if pi changes the grammar the mirror keeps answering confidently and `import-pi` silently stages a package the operator turned off, which is the silent-no-op class this project refuses, reached from a direction no runtime assertion sees. What bounds it is two pins at deliberately different distances (a contract test against the resolved artifact, a canary against `latest`) sharing one needle list so they cannot drift, plus a mirror built to admit ignorance — a glob returns a third state and is printed, never guessed. Added **`OQ-019`** (`WATCH`): discovery reaches npm packages only and the enablement mirror reaches extensions only, with git-sourced staging, skills/prompts/themes enablement and project-local (`pi install -l`) installs each deferred **for a different reason** — a spec amendment about whether a sha is a pin, a cost/benefit call that leans on `OQ-018`, and a path that sits one character from a *serviced* repo's `.pi/` respectively. That row also carries the reconciliation nothing else stated in one place: a repo's declared packages are never installed while its `.pi/extensions` do load, and that is not a contradiction because `/workspace` is the default-branch sha. Neither row got a GitHub issue, per this file's own header: an issue schedules work, a row records the answer, and these are scoping decisions rather than scheduled work. **`OQ-005` UNCHANGED, checked** — it is the same species as `OQ-018` (upstream drift) but concerns an API the runner *calls*, not one it reimplements. **`OQ-011` UNCHANGED, checked** — a staged package spawning an unmetered `pi` subprocess is unaffected by where the package came from. |
| 2026-08-01 | Added **`OQ-017`** (`WATCH`, issue #56 / `REQ-REPLICA-RUNS`): two replicas on a **pull_request**-typed target share the pull request's head branch, and the harness bounds nothing — only the prompt asks. The asymmetry is the row's point: an **issue**-typed target is fully bounded, because the host mints `pi/issue-<n>-r1`/`-r2` and each replica is told to push only to its own; a pull_request target has no branch to mint, since the head branch belongs to a human and every replica sees the same one. It is allowed rather than refused because the common case is a **review** flow that writes nothing at all, and refusing the whole target type would remove the safest use of the feature to guard against its least common one. What bounds it meanwhile is stated honestly as three things that are not boundaries: the replica paragraph in the prompt, `--force-with-lease` (which genuinely **refuses** when a sibling has pushed, so a collision surfaces as a failed push rather than as lost work), and the fact that replicas share `PI_CONCURRENCY` with every other job and so often serialise — which is luck, not a control, and is recorded as such. |
| 2026-08-01 | Added **`OQ-016`** (`WATCH`) — the admin panel's `tui.stop()` → spawn → `tui.start()` handoff for `REQ-RESURRECTABLE-SANDBOX` is verified by reading the pinned pi and by pi's own `$EDITOR` use of the same pair, **not** by having been run. Recorded rather than left implicit because the mechanism reaches past the extension API (which has no terminal handoff) into the `TUI` object the `custom` factory happens to hand over, so it is exactly the class of assumption `REQ-UPSTREAM-CONTRACT-TESTS` exists to catch — with the difference, stated in the row, that this one fails cosmetically and recoverably rather than silently. |
| 2026-07-15 | Initial. Replaces `DESIGN.md` v0.1 §10. Collapsed from ~10 checklist items to 5 rows: source-verification at `earendil-works/pi @ 5e336cf` answered most of them. The register's value inverted in the process — from "holds ten unknowns" to "holds one known-incoming breaking change" (`OQ-005`). |
| 2026-07-16 | `OQ-005` **retracted and re-corrected** to `WATCH — NOT IN THE PIN`. The 2026-07-15 "correction" below was itself wrong: it read `sdk.ts` at `5e336cf` (**HEAD**) to describe npm `0.80.7` (**the pin**), concluded `modelRuntime` had already landed, and declared the changelog unreliable. `ModelRuntime` does not exist in `0.80.7` — no `model-runtime` in its `dist/`, not exported from `dist/index.js`. The changelog said `[Unreleased]` and was exactly right. The runner was written against the phantom API, the image built cleanly, and every job would have died on a missing export; CI caught it on the first real container run. `constitution.md`'s evidence convention now requires verification against the **published artifact**, and `pinned-api.test.mjs` asserts `ModelRuntime` is absent so the real migration fails a test instead of a job. |
| 2026-07-15 | ~~`OQ-005` corrected to **WATCH — PARTIALLY LANDED**~~ — **this entry was wrong; see above.** It claimed `modelRuntime` was already in `CreateAgentSessionOptions` at the pinned sha and that the changelog was not a reliable signal. Both false: the sha was HEAD, not the pin. Kept rather than deleted, because a spec that hides having been wrong teaches the next reader to trust it more than it deserves. |
| 2026-07-17 | Added OQ-006 recording the GitHub-auth-mechanism decision (default gh/fine-grained PAT single-owner; App mandatory multi-tenant), closed by this plan + the E1 CONST-TOKEN-SCOPED-PER-JOB amendment. |
| 2026-07-21 | Added OQ-007 (run-history retention: periodic sweep). |
| 2026-07-21 | Added OQ-008 (runtime trigger editing — cron toggle, label→flow — deferred; the admin extension ships triggers display-only). |
| 2026-07-22 | Added OQ-009 (chaining from a GitHub-job parent, and cross-folder chaining, deferred; this slice ships same-folder, local-parent-only chaining). |
| 2026-07-22 | Added OQ-010 — spike #21 closed **YES**: pinned pi `0.80.7` emits per-turn token usage on the `subscribe()` stream (nested `event.message.usage`), verified against the npm artifact. Records the lagging-control constraint and unblocks a follow-up for the token-cap chain. |
| 2026-07-28 | Issue #58. **OQ-010 scope-corrected in place** (kept, not rewritten): its CLOSED answer was **root-session-scoped** and never said so — `subscribe()` delivers one instance's events, `CreateAgentSessionOptions` has no parent/shared-bus option, and no event carries a `sessionId`, so a subagent fanout emits nothing on the parent's bus and registers as ~one turn. The answer to the question asked is unchanged; the gap was the question's reach. Accounting moved to pi-ai's module-level api-provider registry with the bus sum kept as the fallback, and `REQ-RUNNER-TURN-BUDGET` is now explicitly bounded to root-session turns by the same fact. Added **OQ-011** (`ACCEPTED RISK — wants explicit ratification`): a staged package that spawns a **`pi` subprocess** is invisible to any in-process hook — pi's own SDK example does exactly that — so its tokens miss the exit line and the daily counter. Records what detection ships today (Linux `/proc` child sampling, diagnostic only, logged at teardown), what bounds it meanwhile, and that it closes **with** `OQ-004`, because reading usage off a subprocess needs TLS termination and therefore the same container-level proxy. |
| 2026-07-22 | OQ-010 **Unblocks** retargeted: the #25 follow-up landed as `REQ-TOKEN-ACCOUNTING-AND-CAPS` (per-job token/cost accounting + optional in-run per-job token budget + optional check-after daily token cap). The recorded lagging-control constraint is what shapes that REQ's asymmetry with `CONST-BUDGET-BEFORE-TOKENS`. |
| 2026-07-29 | Issue #41. Added **OQ-012** (`ACCEPTED RISK — wants explicit ratification`): an operator-built job image named by a trigger's `run.image` is outside `REQ-UPSTREAM-CONTRACT-TESTS` — its own pi version, its own runner and exit codes, its own guardrails floor, its own **per-image** loader posture — and nothing in this repo can gate it. Records what bounds it (the isolation surface is the worker's argv, not the image's, so a non-conformant image is a **worse agent**, not a wider blast radius; an operator-only edit path; preflight + `--pull=never` mean only locally-present images run), what detection ships (presence of every named image in the preflight and `doctor`, plus an entrypoint **warning** — **not** conformance), and why the cheap close does not work: an OCI label proves intent, not conformance, and only running the assertions is non-lying. `OQ-004` and `OQ-011` unchanged, and noted as now additionally per-image. |
| 2026-07-29 | Issue #42. Added **OQ-013** (`ACCEPTED RISK — wants explicit ratification`): GitLab's approval gate is weaker in kind than GitHub's, three ways. It is a **network call rather than a signed payload field**, so authority is established by asking and asking can fail — closed for a determinate 404, loudly (503, redelivered) for an indeterminate answer, but a gate with a moving part is not the same object as one without. The **role table is not fixed** across versions or editions, and Ultimate custom roles can grant label management at any level, so `>= 30` is a claim about a number whose permissions are the operator's to know. And a **Guest can label an issue at creation**, which is the fact that forced the whole design: a stranger can open an issue already carrying the trigger label, so on GitLab a label proves nothing about who approved anything, and the access gate covers label triggers where on GitHub the label carries that weight itself. Records what bounds it (`>= 30` not `> 0`, so the population that can start a paid run is the population that could push the branch itself; `members/all` so group-inherited access is not mistaken for absence; the bot-loop guard ordered BEFORE the access gate, since the harness's own token IS a project member; verification before the lookup, so an unauthenticated flood cannot make this project call GitLab), what detection ships (`gitlab_access_lookup_failed` + 503, so a revoked token fails as "nothing runs" and never as "everything runs"; `doctor` naming the `api`-scope trade), and what would close it — a GitLab-side `author_association` equivalent inside the signed body, which does not exist and is not announced. `OQ-004` unchanged and now per-forge; `OQ-009` (chaining from a forge parent) inherited verbatim, since a gitlab job gets no `/outbox` for the same adversarial-text reason a github one does not. |
| 2026-07-31 | Issue #48. **NEW `OQ-014`** (`ACCEPTED RISK — wants ratification`): a resumed session is state crossing jobs, and its key is a name the base repo's push population can choose. Four parts stated rather than averaged: the key is a name and not an identity; the population is one step wider than the one already trusted; the transcript is a durable capture of everything the agent saw and is strictly more PII-bearing than the raw job log that `REQ-DURABLE-RUN-HISTORY` made opt-in for that reason; and replay is a placement class `CONST-ISSUE-TEXT-IS-DATA` has never described. Records what bounds it, what detection ships, what ships UNDETECTED (the content of a transcript — nothing scans it and nothing will), and that a **transcript redactor is explicitly not the answer**, since content-filtering is not a boundary by this project's own doctrine and a scrubber would corrupt the artifact. `OQ-003` **AMENDED — its mitigating factor is STRUCK, not rewritten** (the `OQ-010` precedent): *"jobs are short-lived and single-purpose, so compaction may never trigger in practice"* is exactly what resume deletes, and pi's own docs supply the threshold it now triggers at. It also gains the question it was never asked — past that threshold a resumed job replays a **model-generated summary** written while that model was reading attacker text — which makes it a safety row and not only an economics one. `OQ-007` **UNCHANGED, and answered for this store rather than deferred**: the age gate runs at OPEN as well as at boot, because a stale transcript is a live input to a future job rather than debris; its own question (a periodic sweep for the logs) stays open. `OQ-004` **UNCHANGED in kind and WIDER in reach**, said here rather than left implied: exfiltration was bounded to one job's own view and is now bounded to a key's accumulated history, retrievable in one request. `OQ-001` **UNCHANGED, checked**: its reopener is *"abandoning container-per-job. Nothing else"* — still true, and its concern was two sessions in one process, where this is two jobs on one file, answered by the lock. `OQ-009` **UNCHANGED, checked** — see `DES-JOB-OUTBOX-CHAINING`. `OQ-012` **UNCHANGED, checked**: an operator image that ignores `PI_SESSION_FILE` or omits the pi-version LABEL produces jobs that never resume; the LABEL case is the safe direction, the runner case is not, and both are named in the conformance checklist. |
| 2026-07-31 | `OQ-014` **RATIFIED, and SCOPED rather than blanket** — the scoping is the substance of the decision, not a hedge on it. Every part of the residual is a function of **who holds push access to the serviced repository**, which is a property of the deployment and not of this code, so a single unqualified "accepted" would have been a claim about repositories this project has never seen. Accepted for a deployment whose serviced repos' push-access population the operator controls or trusts with a transcript's contents; a **multi-tenant** deployment must not arm `run.resume`. That is the **third** instance of a split this register already makes twice — `CONST-NO-CONTEXT-FILES-MANDATORY` (accepted single-tenant, reversed multi-tenant) and `CONST-TOKEN-SCOPED-PER-JOB` (App mandatory for multi-tenant, fine-grained PAT sufficient for single-owner). What settles the in-scope case is a **comparison rather than an assurance**: the 2026-07-28 reversal deliberately granted the default-branch population arbitrary code execution in job containers with the job token and open egress; this grants a slightly wider population **read access to a transcript**. Wider population, dramatically narrower capability, and that population can already push code the agent will run — so refusing them a transcript would be a bound in the wrong place. **This is a smaller concession than one already made on purpose.** The cost of the scope condition is stated rather than glossed: it is **doctrine, not a mechanism**, because "do you control who can push to the repositories you service" is not a question a worker can ask — enforced only by being written in the constitution, `SECURITY.md`, `docs/sessions.md` and a `doctor` warning, exactly as its two precedents are. The `Needs` field is replaced by **what would REOPEN it**: a mechanism that could distinguish the two deployment shapes; a transcript reaching an account the operator did not expect (which would mean the push-access framing is wrong rather than merely wide); or `run.resume` becoming settable by anything other than an edit to the reviewed triggers file — the model-callable write path's exclusion is **load-bearing for this verdict**, not incidental to it. |
| 2026-07-31 | Issues #43 + #61. Added **OQ-015** -- Azure DevOps deliveries are authenticated by a bearer secret that covers no bytes, dedup keys off the body that secret cannot vouch for, and there is no signed timestamp and therefore no replay window as a second line. Recorded as an ACCEPTED RISK wanting ratification rather than as a constraint, on the `OQ-004`/`OQ-012`/`OQ-013` principle that a constraint promising what cannot be enforced is worse than an honest risk row: the mechanism does not exist for us to enforce, and Microsoft would have to add it. What bounds it is written out (mandatory HTTPS, a per-endpoint operator-held secret, and -- the part that is easy to miss -- the author gate still runs, so holding the secret does not let a stranger name themselves a project member), as is what would close it and what this project can only advise rather than verify. `OQ-013` **amended**: its subject was "GitLab's approval gate is weaker in kind than GitHub's, and depends on a lookup that can fail". That is now true of **three** forges, and Azure's lookup is *two* calls -- actor to descriptor, descriptor to membership -- so the indeterminate surface is genuinely wider rather than merely repeated. `OQ-012` **amended by one sentence**: an operator-built image may now also decline to declare `dev.pi-dispatch.forges`, which reads as "no claim" and admits every forge -- the compatible direction, and the one that means an operator image is never refused for a label it never knew to add. `OQ-003`, `OQ-004`, `OQ-007`, `OQ-009`, `OQ-014` **UNCHANGED, checked**: `OQ-004`'s exfiltration surface is unchanged in kind by a fourth forge (the same container, the same egress), and `OQ-014`'s scoping -- accepted where the operator controls or trusts the push-access population -- transfers to Forgejo and Azure without amendment, because it was written about a population rather than about a forge. |
