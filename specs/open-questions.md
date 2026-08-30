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
- **What ships against it, 2026-08-26 (issue #186), and what it does NOT answer**: `PI_SESSION_MAX_CONTEXT_PCT`
  refuses to resume a session whose stored context is already at or above a share of the model's window,
  so a lineage can be stopped BEFORE it reaches pi's compaction threshold rather than after. This does not
  resolve this row and does not shorten it. The question here is whether the prefix survives compaction
  byte-identically, and nothing above measures that; the bound only reduces how often a resumed job is
  past the point where it would matter. Two things about it belong on the record. It is deliberately a
  SEPARATE line from pi's own threshold and reads none of pi's settings: pi's is settable in a serviced
  repo's `.pi/settings.json`, so it is a line the repository can move, and a host bound that derived
  itself from a repo-movable number would inherit that. And the measurement is **container-reported**
  (pi's `getContextUsage()` on the exit line), which puts it at the same trust level as `turns` and
  `tokens` — an agent able to forge an exit line could under-report occupancy and keep its own lineage
  resumable. That is not closable from the host: the only other candidate numerator is the transcript,
  which the agent writes, and a bytes-derived estimate has no calibration here and over-reads precisely
  past the compaction point this bound exists for. The bound raises the cost of a long lineage; it does
  not make the measurement trustworthy, and this row is where that is written down.
  Two corrections to that residual, both measured rather than reasoned about. **Forging it needs no race.**
  Every exit-line parser scans backwards for the last PARSEABLE line and skips what does not parse, so one
  byte with no trailing newline immediately before the runner's genuine line glues the two together and a
  forged line placed earlier wins uncontested. **And it was never scoped to occupancy.** The same line
  carries `turns`, `tokens`, `usage` and `session`, so the same trick under-reports the daily token counter
  and the turn count, neither of which this bound introduced. The accidental half is worth as much as the
  adversarial one: an un-newlined write from anything sharing the container's stdout loses all five values
  at once, silently. What issue #186 changed is that it does not rest on that line for the bound an
  operator would lean on hardest -- the resume chain counts the HOST's own deliveries, precisely because
  everything the container says about a session is influenceable by what runs inside it.
  **What ships against the corrections, 2026-08-28 (issue #224): the accidental half is CLOSED, on both
  edges, and the adversarial half is not.** Both runner writers now newline-DELIMIT (a leading `\n`
  closes whatever un-newlined write another process left dangling), and every exit-line parser repairs a
  glued line before skipping it, re-anchoring on `{"event":"` -- collision-free because `event` is the
  first key both writers serialise and JSON.stringify escapes every quote inside a string value, so
  those raw bytes cannot occur inside a runner line, only where one starts. Either edge alone suffices;
  both ship because the writer fix reaches only deployments that pull a new image while the reader fix
  reaches logs the old image already wrote. The no-race forgery above is closed with it: the glued
  genuine line now parses, so the backward scan finds it before any earlier forged line. What stays OPEN
  is the adversarial residual proper, and one candidate fix is REJECTED on the record rather than left
  looking untried: a reader that accepted only the FINAL line ("stop scanning backwards") would not
  close it -- the worker runs the container under `--init`, so the runner is not PID 1, and an agent
  subprocess can emit a forged line and then kill the runner before the genuine line exists, leaving the
  forged line final and alone -- and it would convert trailing teardown noise the backward scan
  deliberately tolerates into lost telemetry. On a channel the agent shares, no reader policy can
  distinguish the runner's bytes from an imitation of them; only an accounting channel the agent cannot
  write (a descriptor or file outside the container user's reach, a materially larger change) closes
  this half, and this row is where that stays written down. One boundary condition on the accidental
  half, recorded so the close is not read as unconditional: the leading newline closes a dangling write
  only because the runner emits its own line in a single `write()` that lands atomically, which holds
  because the success exit line (the one carrying all five values) is well under a pipe's atomic-write
  size; the catch-path line can in principle exceed it and interleave mid-line, but it carries none of
  the five values, so nothing measured is at risk there.

## OQ-004 — Egress from the job container is unrestricted in v1

- **Status**: **CLOSED 2026-08-25 — graduated to `CONST-EGRESS-POLICY-IN-THE-ARGV`.** The close condition
  this row set is met: an allowlist proxy on a dedicated Docker network, applied by the worker's own argv,
  **on by default**, with the constraint written. What follows is the row's history, kept because the
  answer is the durable half and because two of its findings were corrected rather than confirmed.
- **Answer**: Egress from a job container is bounded by default. Every job runs on its own `--internal`
  network whose only other member is a hostname allowlist proxy, and a job whose policy cannot serve it is
  refused **before it spends** (`REQ-EGRESS-ALLOWLIST`, `INT-EGRESS-POLICY-CONTRACT`,
  `DES-EGRESS-DENY-ON-A-DEDICATED-NETWORK`). An operator may still open it with `PI_EGRESS=0`, and that
  posture is what `OQ-026` now carries. **Closing this row does not retire the disclosure**: an allowlist
  bounds *where* an induced agent can send the environment and does not prevent it, because the forge is on
  the list by necessity and a repository is a perfectly good place to write a secret to.
  `CONST-TOKEN-SCOPED-PER-JOB` remains what actually bounds the damage.
- **Superseded status**: **ACCEPTED RISK — RATIFIED 2026-08-25, and SCOPED.** Accepted as the **default**
  posture,
  on the condition the row was really waiting on: that the policy `SECURITY.md` tells an operator to apply
  is written down rather than left to be derived. That condition is now met (issue #199) — `docs/sandbox.md`
  carries a recipe that has been **run**, in both directions, with the failure costs measured. The verdict
  is scoped to a deployment whose operator has set the provider-side spend limit `SECURITY.md` already
  requires; a deployment servicing repositories whose issue-opening population the operator does not
  control should apply the recipe rather than rely on the credential bound alone.
- **Position**: v1 ships without an allowlist proxy. A job container can reach the internet. The bound
  on exfiltration is `CONST-TOKEN-SCOPED-PER-JOB`'s short-lived, minimally-permissioned credential, not network policy.
- **Why it is a risk row and not a constraint**: the source design doc listed egress allowlisting as
  security "layer 4" while also saying v1 ships without it. **A constraint that ships unenforced is worse
  than an honest open risk** — it teaches readers that the constitution is aspirational, which corrodes
  every other entry in it. So it lives here, and `SECURITY.md` states it plainly under "what is NOT
  defended".
- **Why the verdict is scoped rather than blanket, which is the substance of the ratification**: the
  argument above justifies *not lying in the constitution*; it never justified leaving the operator with an
  instruction and no recipe, which is the state this row was actually in for a year. Ratifying the risk and
  shipping the recipe are the same decision, and either alone is the dishonest half: a documented control
  nobody enabled is still an accepted risk, and an accepted risk nobody can act on is a disclosure with a
  dead end at the end of it.
- **Corroboration, external**: independent review of v1.0.0 asked for "some secrets injecting egress proxy
  added to the setup" unprompted, from the README alone, arriving at this row's close condition in almost
  its own words. Note where it points: a *secrets-injecting* proxy is `OQ-011`'s TLS-terminating mechanism,
  not this row's allowlist, and the two must not be conflated when the graduation is designed.
- **What the recipe changes, and what it deliberately does not**: it is an operator control, applied around
  the container on the host. The job argv is untouched, so `INT-CONTAINER-RUNTIME-CONTRACT`'s pinned flag
  list is **UNCHANGED, checked**. Two findings from running it belong on this row because they change the
  shape of any future default: the runner's **provider call does not follow `HTTPS_PROXY`** (verified
  against the pinned pi in the shipped image, with `NODE_USE_ENV_PROXY=1` set and the proxy dead), so a
  proxy-only design cannot carry provider traffic and the provider needs a network-layer rule; and a
  **too-tight allowlist spends two job-count slots per job and refunds neither** (exit `1` is retryable,
  `attempts: 2`, and `releaseBudget` covers only `container-never-started`), which is why a shipped default
  must refuse pre-spend rather than fail mid-run.
- **Update (2026-08-25, issue #202) -- the first of those two findings is REFUTED, and the correction
  matters more than the finding did.** The observation was real: with `HTTPS_PROXY` at a dead port and
  `NODE_USE_ENV_PROXY=1` "set", a job reached the provider and returned its `401`. The **cause was not pi's
  client**. `@anthropic-ai/sdk` resolves `globalThis.fetch` at construction and pi-ai passes it no
  dispatcher, so the provider call follows whatever the process's global dispatcher is -- and the pinned
  image's Node 22.23.1 installs a proxy-aware one when that flag is set. Measured in that image: the same
  SDK client, built exactly as pi-ai builds it, follows a dead proxy to `ECONNREFUSED` **with** the flag and
  goes straight to DNS **without** it. What actually happened is two paragraphs above the trap
  `docs/sandbox.md` recorded: **the container env is a closed allowlist**, and the recipe's own line is
  `PI_FORWARD_ENV=HTTPS_PROXY,HTTP_PROXY,NO_PROXY` -- three names, not four. `NODE_USE_ENV_PROXY` was set on
  the host and never reached the runner. So a proxy **can** carry provider traffic, the provider needs no
  network-layer rule, and the shipped control is a pure hostname allowlist: the mechanism this row's close
  condition actually names. The second finding stands unchanged and is the reason the shipped control
  refuses pre-spend. `docs/sandbox.md`'s egress section is replaced by `docs/egress.md`, which carries the
  correction and the measurements.
- **What would close it**: an allowlist proxy (`api.anthropic.com`, `github.com`,
  `registry.npmjs.org`) on a dedicated Docker network. At that point it graduates to a `CONST-`. Owned by
  **issue #202**, whose mechanism has landed (`REQ-EGRESS-ALLOWLIST`, `INT-EGRESS-POLICY-CONTRACT`,
  `DES-EGRESS-DENY-ON-A-DEDICATED-NETWORK`) and is **off by default**; the row closes with the release that
  makes it the default, not with the one that builds it.
- **What would REOPEN it**: a documented exfiltration that the recipe would have stopped and the credential
  bound did not; the recipe going stale against the image (a new client in the container, or a provider that
  stops resolving to a stable address); or the graduation landing, at which point this row closes rather
  than reopens.

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
- **Amended 2026-08-28 (issue #231), not reversed.** Two sentences above have aged and one is now
  deliberately widened. *"The file is the single write target"* **holds and is strengthened**: the
  one-shot disarm writes the same file — no second store, no Redis flag the boot reconcile would fight,
  which is exactly the failure mode this entry exists to refuse. *"No LLM tool reaches `writeTriggers`"*
  was already superseded when the `dispatch_trigger_*` tools landed behind `confirmedWrite`'s dialog (the
  human keypress is the approval, so the principle held). *"Writes stay operator-typed"* is now
  **amended**: the WORKER is a second author, and its write authority is **monotonically disarming** — it
  may only add `on.disarmed` to an entry the operator armed `once: true`, verified against the item
  number the job actually matched; it can never create, delete, or reorder entries, and never touch
  `run`. So the property `CONST-TRIGGER-AUTHOR-GATE` actually needs — a human decision behind every
  ARMING — survives intact: no machine path can arm anything, and the machine's one verb makes a trigger
  fire less, never more. Both authors serialize through the one shared, locked writer
  (`DES-ONE-SHOT-DISARM-IN-THE-FILE`), moved into the worker package for the purpose.
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
- **What would close it**: a container-level egress proxy that **terminates TLS** and accounts provider
  traffic per container rather than per process. Reading usage off a subprocess needs to read its HTTP, and
  reading its HTTP needs TLS termination; there is no cheaper version of this for **accounting**. Worth
  adding, because it is the strongest argument for the eventual mechanism and nobody had written it down: a
  header cannot be injected into a `CONNECT` tunnel without terminating it either, so the secrets-injecting
  proxy that would take the provider key **out** of the container entirely is necessarily the same one.
- **Corrected (2026-08-25, issue #202) — this row used to claim TLS termination was "the same mechanism
  `OQ-004` names", and it never was.** `OQ-004`'s close condition was a **hostname allowlist** proxy;
  `docs/sandbox.md` said in terms that such a proxy *never* terminates TLS; and `OQ-004` itself warned that
  the two "must not be conflated when the graduation is designed". The claim entered this register in
  #199's own pass, whose revision row records the coupling standing "byte-unchanged" while the sibling row
  three lines up was being rewritten around it. So the **closes-with-`OQ-004`** coupling is struck.
- **What the graduation actually changed for this row: nothing, on the accounting axis.** A subprocess `pi`
  spends against the **provider host**, which is on the allowlist by necessity because every job needs it,
  so the allowlist cannot bound whether it spends, how much, or record that it did. The child-process
  sampler below is still the only detection and still detects went-wide rather than went-wide-and-spent.
  What it **did** change is the cost of closing this row: with the network and the proxy shipped, the
  terminating variant is a mode change on components that already exist rather than new plumbing. So this
  closes **on top of** `OQ-004`'s mechanism rather than with it.
- **What bounds it meanwhile**: the job-count caps (`CONST-BUDGET-BEFORE-TOKENS`), `maxTurns` on the root
  session, the 30-minute container timeout (`REQ-JOB-TIMEOUT-30M`), and the provider-side spend limit
  `SECURITY.md` tells every operator to set. Also the four gates in front of a staged package at all: an
  operator declares it, pins it, stages it, and arms it per trigger.
- **Related risk**: `OQ-004` (egress), **CLOSED 2026-08-25** by issue #202. That does not touch this row's
  facts: a hostname allowlist applied around the traffic accounts for nothing, and the provider does not
  even become unreachable, because it must be on the list. This row stays **ACCEPTED RISK** and still wants
  explicit ratification, on the precedent #199 set by leaving `OQ-012`, `OQ-013` and `OQ-015` all wanting
  it rather than ratifying three rows in passing.
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
- **Two corrections, both surfaced by issue #187.** First, this row is **not** reached only through a
  `pull_request` trigger: a **comment** trigger routes to a merge/pull-request target too
  (`filter-gitlab.mjs`, `filter-azure.mjs`, and github's own inference from `issue.pull_request`), and the
  loader permits at most one comment rule per forge — so arming `replicas` on that single rule necessarily
  arms both the bounded issue path and this unbounded one, with no way to separate them. Second, the scope
  is now **four forges**: a GitLab MR's *source* branch, a Forgejo PR's *head* branch and an Azure PR's
  *source* branch are the same hazard in different nouns. Widening tripled the blast radius and changed
  none of the argument, which is why this is a scope note rather than a reopening.
- **Why it is allowed rather than refused**: the common and useful case is a **review** flow, where two
  independent reviews of one pull request are exactly the second opinion the feature exists to buy and
  nothing is written at all. Refusing the whole target type to bound a pushing flow would remove the
  safest use of the feature to guard against its least common one.
- **What bounds it meanwhile**: three things, none of them a boundary and all of them stated as such. The
  replica paragraph in the prompt names the index and says plainly that a sibling is running the same flow
  on the same branch, in each forge's own nouns. `--force-with-lease` is genuinely mechanical: it
  **refuses** when a sibling has pushed since the ref was read, so a collision surfaces as a failed push
  rather than as lost work. **What this row used to claim, and no longer does**: that `HARD_RULES` rule 3
  supplies that lease. Rule 3 scopes its permission to *"your own `pi/issue-*` branch"*, and a
  pull_request-target replica is not pushing to a `pi/issue-*` branch at all — read literally, rule 3
  forbids that push rather than bounding it. The lease is real when the agent uses it; the rule is not what
  makes it so. Relatedly, `verify-image.sh` proves the `replicas` capability by grepping rule 3's *issue*
  clause, so the image label attests to the bounded half of this feature only. And the replicas share `PI_CONCURRENCY`
  with every other job, so on a busy worker they often serialise anyway — which this row recorded as
  luck, not a control, until issue #242: a `concurrent: 1` row on the repo (`REQ-SCOPED-LIMITS`) now
  serialises a same-repo replica set as a CONTROL, by deferral. The residual this row exists for is
  narrower but stands — serialisation orders the pushes, it does not make two replicas on one human head
  branch a sound shape, and no scoped limit is on by default for forge scopes.
- **What would reopen it**: the first report of a replica pair overwriting each other's commits on a PR
  head, **on any of the four forges**; a flow that force-pushes as a matter of course; or any move to
  per-replica branches for pull_request targets, which would need a name the harness can mint without
  owning the human's branch. A forge-specific report reopens it for that forge rather than for all four:
  the lease is git's and is shared, but protected-branch and approval semantics are not.
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
- **Calibrated once already, on the day it was written**: the canary's first run fired against pi 0.84.1,
  and the drift was **not** real. 0.84.1 extracted `readPiManifest` into its own module without changing
  what it means, and a needle pinned to its old body reported a behaviour change that had not happened —
  while the fallthrough the mirror actually depends on was intact. The needle now anchors that fallthrough
  instead. The lesson generalises and is the reason this row exists rather than a comment: **a needle
  pinned to an incidental line reports refactors as breakage**, and a canary that cries wolf is one people
  stop reading, which costs more than the drift it was watching for. When this fires, check the needle
  before believing the verdict.
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
  `extensions/` runs code in every job container. The other three kinds are data. PARTIALLY CLOSED by
  issue #189: prompt templates now get the skills treatment in-container -- the overlay's `prompts/`
  loads (it had no channel at all), "repo wins on conflict" is enforced through `promptsOverride`, and
  package prompts and themes are counted per root on the `packages_loaded` line, with registered
  commands counted post-session (`commands_registered`). Themes stay count-only, deliberately: a theme
  cannot start work in a headless container, so precedence enforcement there would be machinery without
  a failure mode to prevent. The ENABLEMENT mirror (what import-pi copies from the host) is unchanged --
  that half of (b) still stands on OQ-018's argument.
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

## OQ-020 — A review trigger widens who may spend, in two ways the bot-loop guard cannot see

- **Status**: `ACCEPTED RISK`
- **Position**: `review_submitted` (issue #66) is the first GitHub trigger with **no second gate**. A
  comment trigger needs the phrase, a label trigger needs the label, and both of those are things a human
  types on purpose. A review needs only that the reviewer clears `author_association`, so arming the action
  arms every submitted review from everyone with write access, including a one-word "lgtm". `on.reviewState`
  narrows *which verdicts* count and is the recommended arming, but it narrows verdicts, not actors.
  **The sharper half is other people's bots.** The bot-loop guard compares `sender.id` against **our own**
  identity and nothing else, which is exactly right for the recursion it was built for (our flow pushes,
  `synchronize` fires, the guard breaks the loop). A third-party review bot — CI, a security scanner, a
  code-review SaaS — is a different actor holding, very often, `author_association: MEMBER`. If it reviews
  on every push and the armed flow pushes, the two form a recursion **neither guard can see**, because each
  only knows itself. No comparable vector exists on the other triggers: bots do not apply trigger labels
  and do not type `@pi`.
- **Why it is accepted rather than closed**: the obvious fix, refusing any sender GitHub marks as a bot,
  needs `sender.type` in `INT-WEBHOOK-PAYLOAD-SUBSET` and a new clause in `CONST-TRIGGER-AUTHOR-GATE`, and
  it would refuse a legitimate arrangement — an operator whose own review bot is *meant* to start jobs. It
  is also not obviously the right shape: the general problem is a spend loop between two automated actors,
  and `sender.type` is one narrow instrument for it. What bounds the risk meanwhile is real but partial:
  the spend caps (`REQ-SPEND-CAPS-MULTI-WINDOW`) put a ceiling on any runaway, dedup bounds re-delivery of
  the *same* review, and the trigger is opt-in — a deployment that never writes `review_submitted` has
  none of this. Stated in `SECURITY.md` so an operator meets it before arming, not on the bill.
- **What would close it**: evidence of the loop happening in practice, or a decision on the general shape
  (a bot-actor refusal, an operator allowlist of automated reviewers, or a per-trigger rate ceiling).

## OQ-021 — A review made only of line comments never fires, and the gate cannot tell why

- **Status**: `ACCEPTED RISK`
- **Position**: a Comment-type review submitted with inline comments and no summary arrives as
  `state: "commented"` with an empty `body`, which `no-review-body` refuses (issue #66). That is
  indistinguishable, inside the filter, from a genuinely empty review: the inline comments ride
  `pull_request_review_comment`, an event this project does not ingest, and the `pull_request_review`
  payload carries no count of them. `filter.mjs` is pure by contract, so it cannot ask.
- **Why it is accepted**: the alternative is paying for a container whose only instruction is an empty
  string, on every empty review, to serve a case that a maintainer can trigger deliberately by typing one
  line of summary. The narrower fix — refuse only when there are also no line comments — needs an API call
  from inside the gate, which would cost the purity that makes the security decision unit-testable
  offline (`REQ-TRIGGER-AUTHOR-GATE`). Note that `approved` and `changes_requested` reviews with inline
  comments **do** fire regardless of body, so this affects the neutral Comment verdict only, and
  `review.id` rides the job precisely so a flow can fetch the line comments in those cases.
- **What would close it**: ingesting `pull_request_review_comment` (explicitly out of scope in #66, one
  delivery per line comment), or upstream adding a comment count to the review payload.

## OQ-022 — injected skills are deliberately not AI-reachable

- **Question**: A trigger may inject skills from the worker host (`REQ-PER-TRIGGER-SKILLS`). Those flows
  can be started by the trigger, but never by a model: `DES-AI-TRIGGER-FLOW-GATE` reads the target repo's
  committed `.pi/skills` at a pinned sha, and an injected skill is not there, so a chain request or a
  `dispatch_run` naming one is refused as `no-skill`. Should that asymmetry ever close?
- **Status**: ACCEPTED, and it is the fail-CLOSED direction, so the risk of leaving it is nil. What it
  costs is an operator surprise rather than a hole, and the surprise has a sharp edge: an injected
  `SKILL.md` carrying `ai-trigger: allow` is never read, so the operator writes the opt-in and nothing
  honours it. Three surfaces now say so: `doctor` warns when it finds one (originally the only thing
  that would have told them), the topology badges the skill `injected-ai-trigger` (issue #54), and
  since issue #188 the config edge of a trigger naming an injected-only flow lands on the injected
  node itself — whose tip carries "never AI-reachable" — instead of a false red `no-skill`.
- **The sibling asymmetry, with the inversion stated** (issue #189): `run.command` triggers are ALSO
  trigger-reachable and never AI-reachable — a chain request carrying a `command` key refuses outright
  (`chain-command-refused`, before the charset check) and `dispatch_run` cannot express one — but where
  the injected-skill asymmetry FELL OUT of the gate's object-store read, the command one is BUILT at the
  two producers, because a command has no committed artifact a gate could read at all: its dispatch line
  is constructed from the reviewed `triggers.json`, not read from a `SKILL.md`, so default-deny cannot be
  a frontmatter read and must be a refusal (`DES-COMMAND-ENTRY-POINT`, `INT-OUTBOX-CONTRACT`). The
  closing shape below covers both asymmetries unchanged in spirit: an explicit allowlist in the reviewed
  `triggers.json` is the right form for either, and frontmatter is the right form for neither.
- **If it closes, NOT this way**: not by reading `ai-trigger: allow` out of the injected tree. That
  frontmatter is meaningful in a repo because a merge gated it; in a directory the operator can edit at
  runtime it gates nothing, and it would put the opt-in inside the very content the gate exists to
  authorize. The right shape would be an explicit allowlist in the reviewed `triggers.json` — the same
  reasoning `REQ-GLOBAL-PI-OVERLAY` gives for refusing repo-declared packages.
- **What would reopen it**: an operator wanting a chained follow-up to run an injected flow, which today
  requires committing that flow to the serviced repo.
- **Raised by**: issue #60.


## OQ-023 — a prepare-stage refusal is silent on the issue

- **Question**: `unprotected-branch` and the spend refusals post a comment saying why nothing ran. A
  refusal raised inside `prepareWorkspace` does not: `sha-gone` has been silent since it shipped, and
  issue #60 added five more (`pi-too-large` and friends, `skills-dir-empty`). The requester sees a label
  applied, or a comment posted, and then nothing at all.
- **Status**: ACCEPTED for now, and noticed rather than designed: the ordering that makes these refusals
  free is what puts them past the point the processor's `comment` seam is wired for, so the silence is a
  consequence of `CONST-BUDGET-BEFORE-TOKENS` rather than a judgement about what is worth saying.
- **What bounds it**: every one of them is in the run record with its own reason token, and `doctor` now
  reports the `skills-dir-*` causes BEFORE anything fires, which is the earlier and better place to catch
  the misconfiguration. The `pi-*` ones need a repo change to trigger and are visible in the record.
- **What would close it**: threading the processor's `comment` seam into the policy branch at
  `processor.mjs`, which is a small change with one real question attached — a repo whose `.pi/` breaches
  a cap would then comment on EVERY delivery, so it wants the dedup the spend refusals already have.
- **Raised by**: issue #60, while adding the cap refusals that made the existing silence load-bearing.

---

## OQ-024 — the insights export's browser spawn is verified by reading, not by running everywhere

- **Question**: `/dispatch insights` (originally `graph html`, whose artifact issue #181 folded into
  the insights page) best-effort spawns the platform opener (`open`/`xdg-open`/`cmd start`)
  through the worker's shared `open-browser` module. The argv table is pinned per platform by unit
  test and the module is the same one `setup github` has shipped since issue #81 — but no CI runs a
  desktop session on all three platforms, so "the browser actually appears" is verified by reading
  and by field use, not by an automated end-to-end.
- **Status**: WATCH, on the `OQ-016` precedent (the sandbox `docker run -it` spawn carries the same
  shape of residual): the failure mode is cosmetic and self-announcing — the printed `file://` URL is
  the contract, the spawn a convenience, and a missing opener is swallowed by design with the URL
  already on screen.
- **What bounds it**: the spawn is skipped entirely (and said) over SSH and on display-less linux;
  `--no-open` removes it; a swallowed spawn failure costs the operator one manual click on a URL they
  already have.
- **What would close it**: a per-platform desktop CI job, which this project will not buy for a
  convenience spawn.
- **Raised by**: issue #54, while landing `REQ-GRAPH-HTML-EXPORT`; rescoped to the insights export
  by issue #181, which superseded that entry into `REQ-INSIGHTS-HTML-EXPORT`.

---

## OQ-025 — the topology's tier resolution carries the host-side approximation's residuals

- **Question**: Issue #188 made config-edge resolution tier-aware (`REQ-TOPOLOGY-GRAPH` (a2)): the
  graph now probes injected, overlay and staged tiers where this session can read them, softens to
  `skill-not-at-head` where it cannot, and reserves red `no-skill` for every-tier-checked misses. The
  probes are host-side approximations of what the loader will do in a container. Which residuals were
  accepted, and what would move each?
- **Status**: ACCEPTED, itemised, all display-only — the runner's `flow_not_loaded` line
  (`DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS`) is exact where every entry below approximates, so each
  residual is bounded by a later, authoritative layer:
  (1) **dir-basename naming**: every non-repo probe names a skill by its directory, and pi names it
  `frontmatter.name || parentDirName` at the pin — a frontmatter rename can turn a would-be tier hit
  into a softened or red claim, never mint a false hit (the one direction that matters). Closing it
  means parsing frontmatter in three readers for a rename nobody has shipped; the runner line already
  catches the real thing.
  (2) **pointer blindness**: `POINTER_ENV_ALLOWLIST` deliberately excludes `PI_GLOBAL_PI_DIR`, so a
  wizard-launched console softens every overlay/staged question — including on a deployment that has
  no overlay at all, whose genuinely deleted flows now render amber rather than red. Deliberate: the
  session cannot distinguish the two nulls, and a false red on a wizard+overlay deployment is the bug
  class #188 exists to kill. Widening the allowlist is the close, and it is a reviewed policy edit
  (the pointer is wizard-written; adding a path var lets it aim the console's fs reads), not a bug fix
  to slip in.
  (3) **overlay/staged `ai-trigger: allow` is unbadged**: the readers are existence-only, so the
  OQ-022-shaped silent no-op in those two tiers gets no orange badge — the tier tips carry the
  categorical "never AI-reachable" instead, which is the user-facing truth. A badge would need either
  frontmatter parsing plus a reused flag whose name says "injected", or a new flag the closed
  vocabulary forbids. Doctor stays the deeper surface.
  (4) **forge flows in non-repo tiers stay unverified**: a forge trigger's repo is unreadable from
  this host and outranks every readable tier, so even an overlay hit renders dim-unverified — the
  issue's own NOT-proposed list, restated here as accepted.
  (5) **malformed stage manifest reads as nothing-staged**: `readStageManifest` yields null for
  absent and malformed alike, and the display treats both as an empty tier, while the worker's job
  path keeps last-known-good on a torn read — a transient window where the graph is redder than the
  jobs. Bounded by the manifest being operator-written and the window being one re-stage.
  (6) **repo-tier truncation predates**: a folder listing over `maxSkillsPerFolder` can still red a
  flow past the cap — the pre-#188 behaviour, banner-covered ("skill enumeration truncated"), while
  the three NEW tiers' truncated listings read as unknown and soften. Aligning the repo tier is a
  one-line change waiting on anyone actually running 64+ top-level skills in one folder.
- **What would reopen it**: a real deployment hitting (2) hard enough that operators ask for the
  pointer to carry the overlay path — that is the allowlist review, not a topology change.
- **Raised by**: issue #188.

---

---

## OQ-026 — An allowlist cannot enumerate what a flow reaches

- **Status**: **ACCEPTED RISK** — the successor to `OQ-004`'s residual, opened by closing it.
- **Position**: `CONST-EGRESS-POLICY-IN-THE-ARGV` bounds a job to a list of hostnames. The list ships with
  the three a job cannot work without (the provider, the forge, the registry) and is otherwise the
  operator's. **What a job actually reaches is a property of the flows an operator wrote**, and nothing in
  this project can enumerate it: a flow that browses, calls an API someone added, or installs from a private
  registry reaches hosts nobody listed. `docs/egress.md` says so in those words rather than implying
  coverage.
- **Why it is a risk row and not a constraint**: the same reason `OQ-004` was one. A constraint promising
  that the allowlist is complete would ship unenforced, and there is no mechanism by which this project
  could enforce it -- "which hosts do your flows need" is not a question a worker can ask. Naming it here
  is honest; naming it in the constitution would teach readers that the constitution is aspirational.
- **What it costs when it bites**: a job that reaches an unlisted host is refused **by the proxy, mid-run**,
  not pre-spend. The gate in front of the container proves the policy is *present*, never that it is
  *sufficient*, and the distinction is stated in `REQ-EGRESS-ALLOWLIST` rather than left to be discovered.
  So this is the one egress failure that still costs a budget slot, and a browsing flow is the case most
  likely to find it.
- **What bounds it meanwhile**: `doctor` proves both directions of the policy on demand and names the
  provider and the forge specifically; the proxy's own log records every `TCP_DENIED`, which is where the
  missing host appears by name; and `PI_EGRESS=0` is a one-line, fully-documented way back to the prior
  posture while an operator works out what a flow needs.
- **What would close it**: a per-trigger declaration of the hosts a flow needs, checked pre-spend against
  the running policy -- which needs a place for a flow to declare them that is not the serviced repo (a
  repo naming where the agent may send the operator's credentials is `DES-AI-TRIGGER-FLOW-GATE`'s refusal,
  one layer over). Until then, an operator reading their own deny log is the mechanism.
- **What would REOPEN `OQ-004` rather than this row**: a documented exfiltration the allowlist would have
  stopped and the credential bound did not.
- **Raised by**: issue #202, on closing `OQ-004`.

## OQ-027 — A resolver's exit code is a convention we cannot enforce

- **Status**: **ACCEPTED RISK** — opened by `REQ-TRIGGER-SECRETS`.
- **Position**: A secret resolver is an operator-written script, and `INT-RUNNER-EXIT-CODE-PROTOCOL` asks it
  to distinguish "the reference is wrong" (exit 2, refuse) from "I could not reach my manager" (exit 1,
  retry). Nothing enforces that. Most CLIs exit 1 for everything, so the common resolver
  (`exec op read --no-newline "$1"`) reports a genuine typo as retryable.
- **Why it is a risk row and not a defect**: the failure is bounded and cheap. A wrong reference under an
  exit-1-for-everything resolver costs ONE extra attempt (`attempts: 2`, 60s backoff, one further vault
  read) and then refuses with the same message. The alternative default, treating every nonzero exit as
  determinate, loses a delivery outright whenever a vault blips, and a webhook does not redeliver itself.
  One wasted vault read beats one dropped job.
- **What it costs when it bites**: a doubled resolver call and a delayed refusal, never a wrong value: exit
  0 is still the only path that yields one.
- **What bounds it meanwhile**: `docs/secrets.md` states the two codes in the worked example's own comments,
  which is where an operator writing their first resolver actually reads.
- **What would close it**: nothing this project can do alone. A probe that distinguished the two without
  trusting the exit code would have to interpret the resolver's stderr, which `image-preflight.mjs` refuses
  for its own reasons ("the wording differs across CLI versions and platforms, and a mismatch would turn a
  transient daemon blip into a permanent un-retried refusal").
- **Raised by**: issue #225.

## OQ-028 — Every container env value is in the HOST's argv

- **Status**: **ACCEPTED RISK** — pre-existing, and named here because `REQ-TRIGGER-SECRETS` makes it matter
  more.
- **Position**: `buildDockerRunArgs` passes each variable as `-e NAME=VALUE`, so under a default `hidepid`
  any local user can read the provider key, the minted forge token and now a resolved vault value from
  `/proc/<pid>/cmdline` for the container's lifetime.
- **Why it is a risk row and not a constraint**: it is a property of `docker run`, not a choice this project
  made, and the alternatives all trade it for something worse. `--env-file` writes the same values to disk;
  passing them on the container's stdin would require the runner to read them before pi starts and would put
  them somewhere a compromised runner could re-read.
- **What it costs when it bites**: a local user on the worker host reads a credential. That user can already
  read `/proc/<worker-pid>/environ`, so the marginal exposure is the per-job values rather than the
  deployment's own.
- **What bounds it meanwhile**: the worker host is trusted by construction (`SECURITY.md`'s "Who this is
  for"), and `CONST-TOKEN-SCOPED-PER-JOB`'s Acceptance now scopes its "never written to argv" clause to the
  CONTAINER's argv rather than claiming what is not true of the host's.
- **What would close it**: `OQ-011`'s secrets-injecting proxy, which would take the provider key out of the
  container entirely and could take resolved secrets with it.
- **Raised by**: issue #225.

## OQ-029 — A held job's WAKE has no authorizing actor, and the moment picks the commit

- **Status**: **ACCEPTED RISK** — opened by `REQ-WAIT-FOR`.
- **Position**: `CONST-TRIGGER-AUTHOR-GATE` requires a job to start "only on the say-so of an actor with
  write access or above". Until `run.waitFor`, the say-so and the start were the same moment, so gating the
  first gated the second. A held job separates them: a maintainer's label authorizes the run, and whoever
  clears the condition chooses when it begins. That person may hold no permission on the repository — the
  obvious case is a Jira user moving a ticket to Done — and the moment is a capability rather than a
  detail, because `prepare-github.mjs` resolves the default-branch SHA **fresh at run**. Choosing the
  instant chooses the commit that gets cloned, which may include merges the approver never saw.
- **Why it is a risk row and not a defect**: what a third party supplies is a MOMENT, not a job. Nothing
  about a wait widens who may cause a job to exist; the author gate runs, unchanged, before the field is
  ever read. The condition itself is operator-authored in the reviewed file, a payload cannot supply one,
  no model-callable tool can write one, and a `profile` selects only among executables the operator
  declared in their own environment. So the person who authored the waiting always had write access.
- **What it costs when it bites**: a job that was approved against `main@abc` runs against `main@def`, up
  to the maximum hold later. For the motivating uses (wait for a deploy, wait for a ticket) that is
  usually the POINT — the operator wants the newer commit. It is wrong when the approval was of a specific
  state rather than of the work.
- **What bounds it meanwhile**: the ceiling on the condition -- `PI_WAIT_AFTER_MAX_MS` (30 days by default)
  for an instant, `PI_WAIT_MAX_MS` (24 hours) for a polled hold. They are deliberately different numbers,
  so the bound on this residual is whichever applies to the condition an operator actually wrote, and for
  the free tier it is the LARGER of the two. Also: the poller and the webhook paths share this gate, so no
  path is worse than the others.
- **What would close it**: pinning the SHA at enqueue for a job that can be held. `queue.mjs` refuses a
  `sha` field today because "baking a possibly-stale sha here would only race the branch head" — true for
  a queue measured in seconds, and inverted for a hold measured in days. Closing it means making that
  refusal conditional on the job being holdable, and deciding what a pinned SHA that has since been
  force-pushed away should do.
- **Raised by**: issue #230.

## OQ-030 — A wait profile's exit code is a convention we cannot enforce, and its checks are a cost nothing meters

- **Status**: **ACCEPTED RISK** — opened by `REQ-WAIT-FOR`. `OQ-027`'s twin, one participant over.
- **Position**: `INT-RUNNER-EXIT-CODE-PROTOCOL` asks an operator's wait check to distinguish four answers:
  cleared (`0`), never (`2`), not yet (`3`) and could-not-tell (`1`). Nothing enforces that, and `OQ-027`
  already records why the three-code version is unenforceable — most CLIs exit `1` for everything.
  Four codes is a wider convention to get wrong, and `3` in particular is a code almost no tool emits, so
  the honest expectation is that most checks will only ever produce `0` and `1`.
- **Why it is a risk row and not a defect**: the default mapping is the safe one, and it is safe by
  accident in the operator's favour. The naive one-liner (`... | grep -q ...`) exits `1` when its pattern
  is absent, which this protocol reads as could-not-tell and therefore HOLDS — the same behaviour a correct
  `3` would have produced. A check that never learns to emit `3` still works; it is merely counted as
  faulting while it does.
- **What it costs when it bites**: a check that is permanently broken rather than merely unanswerable looks
  identical for `PI_WAIT_MAX_FAULTS` consecutive attempts. After that it terminates as `wait-unanswerable`
  naming the profile, which is the difference from `OQ-027`: there, a wrong code costs one extra vault read;
  here, without the fault bound, it would have cost a full maximum hold and a message blaming the condition
  rather than the script. The bound is what keeps this a risk row.
- **What bounds it meanwhile**: the fault count and its terminal reason; the per-job check count; and
  `docs/wait-for.md` stating the four codes in the worked example's own comments, which is where an
  operator writing their first check actually reads.
- **The capacity half, which is this row's other face.** A check costs wall-clock a worker would otherwise
  spend running jobs, and nothing in the spend system can see it: `CONST-BUDGET-BEFORE-TOKENS` counts
  container starts, so a gate that starts none is invisible to every ceiling this project has. The lease
  bounds it — one check at a time by default, held below `PI_CONCURRENCY` — but a bound being HIT is not the
  same as a bound being enough. At the shipped defaults (one slot, a 10s timeout) capacity is about 0.1
  checks per second, while N held jobs at the 15-minute backoff ceiling demand N/900 per second: demand
  overtakes capacity near **N = 90**. Past that the effective re-check period stretches, and the stretch is
  invisible everywhere except the `wait_capacity_exceeded` log line the lease raises once per run of
  denials. It is a degradation rather than a hang — a starved job stamps its hold clock on the first denial
  and terminates at the maximum wait naming the deployment's capacity rather than the condition — which is
  why this is a risk row and not a defect.
- **What would close it**: nothing this project can do alone, for `OQ-027`'s stated reason — the
  alternative is interpreting the check's stderr, which `image-preflight.mjs` refuses for its own reasons
  and which this contract refuses more strongly still, since a check's output is a third party's text. The
  capacity half would close differently: by metering checks the way container starts are metered, which is
  a spend-system change rather than a wait-system one.
- **Raised by**: issue #230.

## Revision History

| Date | Change |
|---|---|
| 2026-08-30 | Issue #230. **NEW `OQ-029`**: a held job's WAKE has no authorizing actor. `CONST-TRIGGER-AUTHOR-GATE` gates the enqueue and nothing gates the moment, so a Jira user with no repository permission can choose when an authorized job begins — and because the default-branch SHA is resolved fresh at run, choosing the instant chooses the commit. Recorded as a risk rather than a defect because what a third party supplies is a moment and not a job, bounded by the maximum hold, and closed by pinning the SHA at enqueue, which `queue.mjs` refuses today for a reason that is true of a seconds-long queue and inverted for a day-long hold. **NEW `OQ-030`**: `OQ-027`'s twin one participant over, now across four codes rather than three. The mapping is safe by accident in the operator's favour — the naive one-liner exits `1`, which reads as could-not-tell and therefore holds, exactly as a correct `3` would — and the difference from `OQ-027` is the fault bound: without it a permanently broken check would cost a full maximum hold and a message blaming the condition rather than the script. **`OQ-027` UNCHANGED, checked**: the secret resolver's three codes and its unenforceable convention are untouched; the new row is a sibling, not a replacement. **`OQ-008` UNCHANGED, checked**: the `wait:` keyspace is not the two-sources-of-truth failure that row refuses — it describes DELAYED JOBS, which Redis already persists, rather than claiming a container the reaper may have killed, every key is TTL'd to the hold it names, and the supersede path verifies the holder is still queued before it refuses anyone -- a review found that claim ahead of the code and the liveness probe now backs it. There is deliberately no index SET: a set cannot expire its members, so it would be the one structure here that leaks permanently. **`OQ-017` UNCHANGED, checked**: `run.waitFor` is refused beside `run.replicas`, so the replica residual gains no case. **`OQ-030` AMENDED in the polled slice**: it now carries the CAPACITY residual as well as the exit-code one, with the arithmetic stated -- about 0.1 checks per second of capacity at the defaults against N/900 of demand, so demand overtakes capacity near N=90 -- rather than left for an operator to derive from a log line. **Code evidence**: worker/src/wait-state.mjs -> makeWaitState (claim, the supersede lease and its liveness check; noteThrottle, the capacity signal). |
| 2026-08-29 | Issue #242, enforcement slice. **`OQ-017` AMENDED, narrowed not closed**: "replicas often serialise — which is luck, not a control" is no longer the whole truth — a `concurrent: 1` scoped-limit row on the repo now serialises a same-repo replica set as a control, by deferral (`REQ-SCOPED-LIMITS`); the row's residual stands (serialisation orders pushes, it does not make two replicas on one human head branch sound, and no forge scope is limited by default). **`OQ-008` UNCHANGED, checked**: the scoped-limits file has ONE author (the admin console) and the worker only reads it — no second write authority, no Redis state the boot would fight; the in-flight count is process memory precisely to honor this row's two-sources-of-truth refusal. **`OQ-002` UNCHANGED, checked**: `PI_CONCURRENCY`'s own value and its unmeasured RAM input are untouched; the new axis bounds WHERE jobs run, not how many. |
| 2026-08-28 | Issue #231, second slice (writer). **`OQ-008` AMENDED, not reversed**: "the file is the single write target" holds and is strengthened (the one-shot disarm writes the same file, no second store); "no LLM tool reaches `writeTriggers`" was already superseded by the confirm-gated `dispatch_trigger_*` tools and is corrected in place; "writes stay operator-typed" is widened -- the worker is a second author whose authority is monotonically disarming (may only add `on.disarmed` to an operator-armed entry, verified against the matched item number), so no machine path can ARM anything. **`OQ-004`, `OQ-022` UNCHANGED, checked**: neither the egress posture nor chain refusal vocabulary is touched by a host-side file write. |
| 2026-08-28 | Issue #224 (the exit line lost to one un-newlined write). **`OQ-003` AMENDED, status stays `OPEN`** -- the residual's accidental half is CLOSED on both edges: both runner writers newline-DELIMIT (a leading `\n` closes whatever un-newlined write another process left dangling), and every exit-line parser repairs a glued line by re-anchoring on the writers' own first-key bytes (`{"event":"`), collision-free because JSON.stringify escapes every quote inside a string value. The no-race forgery closes with it, since the glued genuine line now parses and the backward scan finds it before any earlier forged line. The adversarial half stays OPEN, and the entry now records why the cheap candidate is rejected rather than leaving it looking untried: a take-only-the-final-line reader closes nothing (the container runs under `--init`, so the runner is not PID 1 and an agent subprocess can forge a line then kill the runner before the genuine one exists, leaving the forged line final) and converts trailing teardown noise the backward scan deliberately tolerates into lost telemetry. On a shared channel no reader policy distinguishes the runner's bytes from an imitation; only an accounting channel the agent cannot write closes that half. **`OQ-014` UNCHANGED, checked**: its detection bullet leans on `session.{resumed, reason}` reaching the record, which the repair makes more reliable while moving nothing about what the row accepts or what would close it. **`OQ-028` UNCHANGED, checked**: the exit line travels stdout, not argv, and no env value moves. |
| 2026-08-26 | **NEW `OQ-027`** (a resolver's exit code is a convention we cannot enforce) and **NEW `OQ-028`** (every container env value is in the HOST's argv, pre-existing and named because issue #225 makes it matter more). **`OQ-011` UNCHANGED, checked**: its secrets-injecting proxy is what would close `OQ-028`, and is now cross-referenced from it. **`OQ-026` UNCHANGED, checked**: its mid-run-refusal cost is the argument for resolving pre-spend rather than in the container, and this feature takes the pre-spend side of it. |
| 2026-08-26 | Issue #186 (resume eligibility bounds). **`OQ-003` AMENDED, status stays `OPEN`** -- a new bullet recording what ships against it and, more importantly, what that does NOT answer. `PI_SESSION_MAX_CONTEXT_PCT` can stop a lineage BEFORE it reaches pi's compaction threshold rather than after, which reduces how often a resumed job is past the point where this row matters; it measures nothing about whether the prefix survives compaction byte-identically, which is the actual question, so the row is neither closed nor narrowed. Two properties of the bound are recorded there rather than left in the code: it is a SEPARATE line from pi's own threshold and reads none of pi's settings, because pi's is settable in a serviced repo's `.pi/settings.json` and a host bound deriving itself from a repo-movable number would inherit that movability; and the measurement is CONTAINER-REPORTED, at the same trust level as `turns` and `tokens`, so an agent able to forge an exit line could under-report occupancy and keep its own lineage resumable. That residual is not closable from the host and the entry says so rather than implying a mitigation exists: the only other candidate numerator is the transcript, which the agent also writes, and a bytes-derived estimate has no calibration here and over-reads precisely past the compaction point the bound exists for. An adversarial pass then corrected the residual itself, twice, and both corrections are in the entry: forging that line needs **no race**, because every parser scans backwards for the last PARSEABLE line and one un-newlined byte before the runner's genuine line glues the two together so an earlier forged line wins uncontested; and it was never scoped to occupancy, since the same line carries `turns`, `tokens`, `usage` and `session`. The accidental half matters as much as the adversarial one: an un-newlined write from anything sharing the container's stdout loses all five values at once, silently. The entry also now records what #186 did about it, which is not a fix but a design consequence -- the resume chain deliberately does not read that line at all. **`OQ-014` UNCHANGED, checked**, and the check is the substantive one: its *"What would close it"* bullet already said the honest improvements were narrower, *"shorten `PI_SESSIONS_TTL_DAYS`, and keep the refusals loud"*, and all three bounds are exactly that -- narrower knobs and louder refusals -- so they move nothing about what the row accepts or what would close it. Its detection bullet naming `session.{resumed, reason, bytes}` is now more true than it was, since a refused gate finally reaches that `reason`. **`OQ-007` UNCHANGED, checked**: its session-store half was answered by the age gate running at OPEN as well as at boot, and the conversation-age bound runs at OPEN in exactly the same place, so it adds a second clock at that gate without moving what was decided about the first. |
| 2026-08-26 | Issue #187 (`run.replicas` on every forge). **`OQ-017` AMENDED, status stays `WATCH`** — a scope note, not a reopening, because widening tripled the blast radius and changed none of the argument. Two corrections the widening surfaced, both wrong before this issue. Its Position framed the hazard as reached through a `pull_request` TRIGGER; a **comment** trigger routes to a merge/pull-request target as well, and the loader allows at most one comment rule per forge, so arming `replicas` there arms the bounded and unbounded paths together with no way to separate them. And its "what bounds it" cited `HARD_RULES` rule 3 as the source of the `--force-with-lease` permission, which rule 3 scopes to *"your own `pi/issue-*` branch"* — a pull_request-target replica pushes to a human's branch, which is not that, so read literally the rule forbids the push rather than bounding it. The lease stays mechanically real; the attribution was false. Scope now covers a GitLab MR source branch, a Forgejo PR head branch and an Azure PR source branch, and a forge-specific report reopens it for that forge alone. **`OQ-013` UNCHANGED, checked**: GitLab's approval gate decides whether a trigger fires, not which branch a replica pushes to. **`OQ-012` UNCHANGED, checked**: the `replicas` capability grep is forge-neutral, so a non-GitHub replica changes nothing about what an operator-built image escapes. **`OQ-004`/`OQ-026` UNCHANGED, checked**: the per-job egress network follows the container name, which already ends `-r<i>`, so N replicas get N `--internal` networks rather than sharing one. **`OQ-018` UNCHANGED, checked**: nothing here touches the host-pi mirrors. |
| 2026-08-25 | Issue #202 (the default flip, and the close). **OQ-004 CLOSED** -- graduated to `CONST-EGRESS-POLICY-IN-THE-ARGV`, on the criterion the row itself set: an allowlist proxy on a dedicated Docker network, applied by the worker's argv, **on by default**. The Answer states plainly what closing does NOT mean, because a row titled "egress is unrestricted in v1" closing while an operator can still open it would be exactly the quiet divergence this register exists to prevent: `PI_EGRESS=0` still exists, the forge is on the allowlist by necessity, and `CONST-TOKEN-SCOPED-PER-JOB` remains what actually bounds the damage. The superseded status is kept rather than deleted, because the answer is the durable half. **NEW `OQ-026`** -- an allowlist cannot enumerate what a flow reaches: the successor to this row's residual, opened by closing it. A job that reaches an unlisted host is refused by the proxy **mid-run**, not pre-spend, so it is the one egress failure that still costs a budget slot, and a browsing flow is the case most likely to find it. Recorded as an ACCEPTED RISK rather than a constraint on this register's own principle: "which hosts do your flows need" is not a question a worker can ask, and a constraint promising the allowlist is complete would ship unenforced. **OQ-011 CORRECTED, and this is the substance of the row.** It claimed TLS termination was "the same mechanism `OQ-004` names" and that it therefore closes **with** `OQ-004`. That was false and had been since `OQ-004` was ratified: that row's close condition was a **hostname allowlist**, `docs/sandbox.md` said in terms that such a proxy never terminates TLS, and `OQ-004` itself warned the two must not be conflated. It entered this register in #199's own pass, whose revision row records the coupling standing "byte-unchanged" while the sibling row three lines up was rewritten around it. The coupling is struck; what the graduation actually bought this row is recorded in both directions (nothing on the accounting axis, because a subprocess spends against the provider host which is on the allowlist by necessity; a materially cheaper close, because the terminating variant is now a mode change on components that already exist). Its `Needs` **stays** -- ratification is a maintainer's act on evidence and this issue produces none for it. One argument is added because it is the strongest case for the eventual mechanism and nobody had written it: a header cannot be injected into a `CONNECT` tunnel without terminating it either, so the secrets-injecting proxy is necessarily the same one. **OQ-012, OQ-013, OQ-014, OQ-015 UNCHANGED, checked** -- `OQ-014`'s in particular is not a formality: an allowlist does not narrow a resumed session's exfiltration reach, because the forge is on the list and a transcript pushed to a branch is exfiltration through an allowed host. |
| 2026-08-25 | Issue #202 (the graduation `OQ-004` named). **OQ-004 AMENDED, not yet closed.** The mechanism its close condition names has landed -- an allowlist proxy on a dedicated Docker network (`REQ-EGRESS-ALLOWLIST`, `INT-EGRESS-POLICY-CONTRACT`, `DES-EGRESS-DENY-ON-A-DEDICATED-NETWORK`) -- and it ships **off**, so the row's Position is still literally true and closing it here would be the quiet divergence this register exists to prevent. It closes with the release that makes it the default. **The first of its two design findings is REFUTED**, and recording that is the substance of this row. `OQ-004:95-97` and `docs/sandbox.md` held that the runner's provider call does not follow `HTTPS_PROXY` even with `NODE_USE_ENV_PROXY=1`, and concluded the provider needed a network-layer rule by address. The observation was real and the cause was not pi: `@anthropic-ai/sdk` resolves `globalThis.fetch` at construction, pi-ai passes it no dispatcher, and the pinned image's Node 22.23.1 installs a proxy-aware one when that flag is set -- measured, the same client follows a dead proxy to `ECONNREFUSED` with it and goes to DNS without it. What actually happened is two paragraphs above the trap the doc recorded: the container env is a **closed allowlist**, and the recipe's own `PI_FORWARD_ENV` line named three variables, not four, so the flag was set on the host and never reached the runner. A proxy therefore CAN carry provider traffic, the provider is an ordinary hostname entry, and there is no address rule anywhere -- which is a better answer than the row asked for. The second finding stands and is why the shipped control refuses pre-spend. **OQ-011 UNCHANGED in substance, checked, and it gains NOTHING here** -- worth stating because the naive reading is the opposite: a subprocess `pi` spends against the provider host, which is on the allowlist by necessity, so the allowlist cannot bound whether it spends, how much, or record that it did, and the Linux-only child sampler is still the only detection. Its `Needs` stays: ratification is a maintainer's act on evidence and this issue produces none for that row. **OQ-012 UNCHANGED, checked**: an operator-built image inherits the network from the worker's argv, so its residual does not widen. **OQ-014 UNCHANGED, checked, and not a formality**: an allowlist does not narrow a resumed session's exfiltration reach, because the forge is on the list and a transcript pushed to a branch is exfiltration through an allowed host. **OQ-013, OQ-015 UNCHANGED, checked** -- neither is downstream of egress. |
| 2026-08-25 | Issue #199 (the egress recipe `SECURITY.md` promised, and the ratification it was waiting on). **OQ-004 RATIFIED, and SCOPED** — accepted as the default posture on the condition that the operator-applied policy is documented rather than derived, which `docs/sandbox.md` now satisfies with a recipe that was run in both directions. Per the `OQ-014` precedent the `Needs` field is replaced by **what would REOPEN it**, and the entry gains a scoped-verdict field, the external corroboration (v1.0.0 review, which asks for the *secrets-injecting* proxy and therefore points at `OQ-011`, not at this row's allowlist), and the two findings from running the recipe that constrain any future default: the runner's provider call does not follow `HTTPS_PROXY` (so a proxy-only design cannot carry provider traffic), and a too-tight allowlist spends two job-count slots per job and refunds neither (so a shipped default must refuse pre-spend). Graduation to a `CONST-` is unchanged as the close condition and is now owned by issue #202. **OQ-011 AMENDED**, one clause: its `Related risk` gloss records that `OQ-004` is ratified while this row is not, because a recipe applied around the container accounts for nothing; the closes-**with**-`OQ-004` coupling stands byte-unchanged. `INT-CONTAINER-RUNTIME-CONTRACT` **UNCHANGED, checked** — no flag was added to the job argv, which is what makes the recipe an operator control rather than a shipped one. **OQ-012, OQ-013 and OQ-015 UNCHANGED, checked** — all three still want explicit ratification, and none is downstream of egress. |
| 2026-08-13 | Issue #188 (topology tier resolution). Added **OQ-025** (ACCEPTED, itemised): the six display-side residuals of probing skill tiers from the host — dir-basename naming (false soft possible, false hit impossible), deployment-pointer blindness to `PI_GLOBAL_PI_DIR` (wizard sessions soften rather than lie red; widening the allowlist is a reviewed policy edit, deliberately not done here), overlay/staged `ai-trigger: allow` unbadged (existence-only readers; the closed flag vocabulary stays closed and the tier tips carry the categorical truth), forge flows in non-repo tiers staying unverified (the remote repo outranks every readable tier), malformed stage manifest reading as nothing-staged where the job path keeps last-known-good, and the pre-existing repo-tier truncation false-red (banner-covered; the three new tiers soften on truncation instead). Each bounded by the runner's exact `flow_not_loaded` layer. **OQ-022 AMENDED** (prose correction): doctor's warn is no longer "the only thing that would have told them" — the topology badges `injected-ai-trigger` since issue #54, and since #188 the config edge itself lands on the injected node with its never-AI-reachable tip. **OQ-008 UNCHANGED, checked** — the graph still re-reads the live triggers file per build; tier reads added no cache. **OQ-009 UNCHANGED, checked** — tier nodes join config edges only; no chain edge gained a source or crossed a folder. |
| 2026-08-13 | Issue #189 (closing pass). **OQ-019 AMENDED**: deferral (b) partially closed -- in-container prompt templates get the skills treatment (overlay channel, enforced precedence, per-root counting; commands counted post-session), themes stay count-only with the no-failure-mode-to-prevent reason stated, and the host-side ENABLEMENT mirror half of (b) still stands on OQ-018's argument. **OQ-018 UNCHANGED, checked** -- no new pi internal is mirrored; the enforcement rides declared loader seams. **OQ-022 UNCHANGED, checked**. |
| 2026-08-13 | Issue #189 (Gap 2, producer half: `run.command`). **OQ-022 AMENDED**: the command asymmetry joins the row as the built-not-fallen-out sibling — a `run.command` trigger is trigger-reachable and never AI-reachable, refused at both model-reachable producers (`chain-command-refused` before the charset check; `dispatch_run` structurally incapable, its params `{folder, flow, task}` and a slash-leading flow refusing with a readable message) rather than falling out of an object-store miss, because a command has no committed artifact a gate could read: its dispatch line is BUILT from the reviewed `triggers.json`, so default-deny cannot be a frontmatter read and must be a refusal. The row's closing shape ("an explicit allowlist in the reviewed `triggers.json`") is unchanged in spirit and now covers both asymmetries. **OQ-008 UNCHANGED, checked** — command triggers reach the file through the same operator-typed, `parseTriggers`-validated, live-reloaded write path its resolution rests on, and no LLM tool gained a write (`dispatch_trigger_add`/`_edit` carry no `command` parameter). **OQ-019 UNCHANGED, checked, and its (b) stays open** — extension enablement mirroring is untouched by commands: a package the operator disabled registers no command, which now surfaces as the runner's pre-spend `command-unregistered` refusal instead of a job silently modelling the line as prose, so the row's cost/benefit call is if anything cheaper to leave; the skills/prompts/themes half remains deferred on its own terms. **OQ-009 UNCHANGED, checked** — a forge command job gets no `/outbox`, exactly as no forge job does; commands changed what a parent may BE, never who may chain. |
| 2026-08-12 | Issue #181. **OQ-024 RESCOPED** from the graph export to the insights export: `graph html` is gone (REQ-GRAPH-HTML-EXPORT superseded into REQ-INSIGHTS-HTML-EXPORT) and the bare `/dispatch insights` is now the one command carrying the browser spawn; the question, the WATCH posture, the bounds (`--no-open`, the SSH/display skip, the printed URL as the contract) and what-would-close-it are all unchanged — only the surface name moved. |
| 2026-08-11 | Issue #54 (`REQ-GRAPH-HTML-EXPORT`). Added **OQ-024** (`WATCH`, the `OQ-016` shape): the graph export's browser spawn is verified by reading and by the pinned per-platform argv table, not by a desktop CI on three platforms this project will not buy for a convenience spawn; the printed `file://` URL is the contract and the failure mode is one manual click. **OQ-008 and OQ-009 pointers already in place from the earlier #54 slices, UNCHANGED, checked**: the export re-reads the triggers file per run like every other graph consumer, and draws no forge-parent or cross-folder chain edge because the model it renders cannot contain one. |
| 2026-08-09 | Follow-up audit after issue #60. Added **`OQ-023`**: a prepare-stage refusal posts no comment on the issue, so a requester sees a label applied and then nothing. True of `sha-gone` since it shipped and now true of six reasons, because #60 added five. Recorded rather than fixed, and recorded as NOTICED rather than designed: the ordering that makes these refusals free is what puts them past the point the processor's `comment` seam is wired for, so the silence is a consequence of `CONST-BUDGET-BEFORE-TOKENS` rather than a judgement about what is worth saying. What bounds it is that every one is in the run record with its own reason token and that `doctor` reports the `skills-dir-*` causes before anything fires. What would close it is threading the `comment` seam into the policy branch, which carries one real question: a repo over a cap would then comment on every delivery, so it wants the dedup the spend refusals already have. This entry exists because the #60 plan said it was worth an OQ and then did not write one. |
| 2026-08-09 | Issue #60 (Gap 2). Added **`OQ-022`**: injected skills are deliberately not AI-reachable, because `DES-AI-TRIGGER-FLOW-GATE` reads the target repo's committed `.pi/skills` at a pinned sha and an injected skill is not there. Recorded as ACCEPTED rather than as a risk row, because it is the fail-CLOSED direction and the residual is an operator SURPRISE rather than a hole: an injected `SKILL.md` carrying `ai-trigger: allow` is never read, so the opt-in is written and nothing honours it, which is why `doctor` now warns. Records what would NOT be an acceptable close -- reading the frontmatter out of the injected tree, since that opt-in is meaningful in a repo only because a merge gated it, and in a runtime-editable directory it would put the authorization inside the content being authorized. `OQ-012` **UNCHANGED, checked**: an operator-built image is unaffected, since the injected root is a worker-side copy into `/job` and needs nothing of the image. `OQ-004` **UNCHANGED in kind**: the injected tier adds instructions, not egress. |
| 2026-08-08 | Issue #66 (ingest `pull_request_review`). Added **`OQ-020`** (`ACCEPTED RISK`): a review trigger is the first GitHub trigger with no second gate — a comment needs its phrase and a label needs its label, both typed on purpose, while a review needs only that the reviewer clears `author_association` — and the sharper half is that the bot-loop guard compares `sender.id` against **our own** identity alone, so a third-party review bot holding `MEMBER` sits outside it and, if it reviews every push while the armed flow pushes, forms a recursion neither party's guard can see. Accepted rather than closed because the obvious fix (refuse any `sender.type: "Bot"`) needs a new subset field and a new constitutional clause, would refuse an operator whose own review bot is *meant* to start jobs, and is one narrow instrument for the general problem of a spend loop between two automated actors; what bounds it meanwhile is the spend caps, dedup, and the fact that the trigger is opt-in. Added **`OQ-021`** (`ACCEPTED RISK`): a Comment-type review of inline comments only arrives with an empty body and is refused as `no-review-body`, indistinguishable inside a pure filter from a genuinely empty review, because the line comments ride `pull_request_review_comment` (not ingested) and the payload carries no count of them — the narrower fix would need an API call from inside the gate and cost the purity that makes the security decision testable offline. Both rows are named in `SECURITY.md` so an operator meets them before arming rather than on the bill. **`OQ-017` UNCHANGED, checked** — a review-triggered replica set shares the PR head branch exactly as any other pull_request-typed target does, so the row's scope is unchanged by a new way of reaching it. **`OQ-013` UNCHANGED, checked** — GitLab's approval gate is an API lookup and is untouched by GitHub gaining a review action. |
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
