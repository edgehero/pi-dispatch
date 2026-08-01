# Design

Decisions and their rationale. Non-negotiables live in `constitution.md`; what the system must do lives
in `requirements.md`. Each entry records what was chosen, **why**, and what was rejected — so the
question does not come back.

Evidence convention as in `constitution.md`: `Evidence (upstream)` is authoritative, `Reference` is not.

## Architecture

```
GitHub repo(s)
  │  webhooks: issues [opened, labeled], issue_comment [created]   (HMAC-signed)
  ▼   ── PUBLIC EDGE ──────────────────────────────────────────────
┌──────────────────────────────┐
│ receiver  (always-on, tiny)  │  verify signature → filter (label allowlist,
│ Node + Express               │  trusted-sender check) → enqueue job
│ binds 0.0.0.0 — MUST be      │  NO dashboard, NO admin surface here.
│ internet-reachable           │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ Valkey + BullMQ  "pi-jobs"   │◀──────▶│ operator terminal (on host)  │
│ THE WAIT-LIST: 50 triggers   │        │ pi + admin extension         │
│ = 50 pending jobs, drained   │        │ /dispatch pause|resume,      │
│ at fixed concurrency; dedup  │        │ status runs logs budget,     │
│ by delivery GUID; retries;   │        │ settings via TUI overlay     │
│ daily budget cap             │        │ ── no network bind at all    │
└──────────────┬───────────────┘        └──────────────┬───────────────┘
               ▼  one job per worker slot              │ reads/writes
┌──────────────────────────────┐        ┌──────────────▼───────────────┐
│ worker (BullMQ Worker proc)  │───────▶│ data volume                  │
│ fresh clone → docker run     │  reads │ settings.json + flows/*.md   │
└──────────────┬───────────────┘        └──────────────────────────────┘
               ▼
┌─────────────────────────────────────────────┐
│ pi-job container (ephemeral, per job)       │
│  • pi (SDK runner) + git + gh               │
│  • Playwright + headless Chromium           │
│  • /job:ro  = flow + issue payload          │
│  • persona BAKED INTO THE IMAGE             │
│    (hard rules; unreachable from the        │
│     admin surface or from /job — see        │
│     INT-CONTAINER-JOB-INPUTS)               │
│  edit → screenshot → iterate → commit →     │
│  push branch → gh pr create → issue comment │
└─────────────────────────────────────────────┘
```

Everything above the container is a few hundred lines of TypeScript. Everything below is pi.

**Architectural style: a queue-worker pipeline with a hard isolation boundary.** Explicitly **not
MACH** — that model scores 0/4 here and adopting its vocabulary would mislead every future reader.
Not *microservices*: three processes on one box is a pipeline, and splitting a few hundred lines into
independently-deployable services would be parody. Not *API-first*: there is no public API; the only
inbound contract is a webhook whose shape GitHub owns. Not *cloud-native*: actively rejected —
systemd on owned hardware, hosted runners declined (see `DES-BUILD-NOT-EXTEND-PI-ROUTINES` and the
rejected alternatives below). *Headless* only vacuously, which is not a commitment.

Everything follows from two constraints, both of which exist because pi provides neither: the agent is
unrestricted against adversarial input (`CONST-ISOLATION-CONTAINER-PER-JOB`), and every job spends real
money with no upstream turn limit (`REQ-RUNNER-TURN-BUDGET`).

---

## DES-NAME-KEEP-PI-DISPATCH

- **Decision**: Keep the name `pi-dispatch`. Do not publish to npm.
- **Why**: `pi-dispatch` **is** taken on npm — `pi-dispatch@1.0.3`, a pi *extension* that rotates
  ChatGPT Codex OAuth accounts to maximise quota. It does not bind us: it is functionally unrelated
  (it runs *inside* a pi session; this project runs pi inside *itself*), it was published once on
  2026-04-06 with no release since, and its GitHub repository returns 404. **We do not need the npm
  name** — distribution is docker-compose and container images, not `pi install npm:`, because this is
  not a pi package. GitHub namespaces by owner, so there is no conflict there either.
  Recorded because the collision is real and the question will otherwise return every time someone
  searches npm.
- **What would change this**: wanting to publish *any* npm artifact under this name — a management CLI,
  a client library. At that point rename; `pi-foreman` and `pi-onduty` were verified available.
- **Evidence (upstream)**: `registry.npmjs.org/pi-dispatch` — versions 1.0.2 and 1.0.3 both published
  2026-04-06; `time.modified` 2026-07-06 is a metadata touch, not a release; `repository.url` →
  `github.com/vincenthopf/pi-dispatch` → HTTP 404
- **Traces to**: `README.md` (disambiguation note)

## DES-TRIGGER-OUTSIDE-PI

- **Decision**: The trigger layer is a separate always-on process. It is not a pi extension.
- **Why**: pi's event system observes a *running session* — `session_start`, `before_agent_start`,
  `tool_call`, and so on. There are **no cron, webhook, or external-trigger event types**. An extension
  *can* drive turns programmatically (`pi.sendUserMessage()` always triggers a turn), so a webhook
  listener inside an extension is technically possible — but **the triggers would die with the
  session**, which contradicts the always-on goal outright and reproduces the exact structural flaw that
  made the closest existing tool unusable ("always-on / laptop closed: no"). This decision is why the
  repository exists at all; without it there is nothing to build.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → packages/coding-agent/docs/extensions.md`
  (event type union; no external-trigger types)
- **Rejected**: webhook listener inside a pi extension — session-bound lifetime.
- **Traces to**: `REQ-QUEUE-BURST-NO-DROP`

## DES-QUEUE-BULLMQ-OVER-CUSTOM

- **Decision**: Redis + BullMQ.
- **Why**: BullMQ supplies priorities, a rate limiter, a dedup window, and stalled-job recovery with a
  retry policy — each of which is an independent requirement here, not a bonus. Building four mechanisms
  to avoid one dependency is precisely how a solo-maintainer project drowns in maintenance. Its Bull
  Board dashboard was a fifth draw; `DES-ADMIN-VIA-PI-EXTENSION` drops the web surface entirely, so the
  case now stands on the four queue mechanisms alone. Redis persistence (AOF) is what makes
  `REQ-QUEUE-BURST-NO-DROP` survive a reboot; an in-memory queue would lose the wait-list on the first
  restart.
- **Evidence (upstream)**: BullMQ is MIT (`taskforcesh/bullmq → LICENSE`, © BullForce Labs AB)
- **Rejected**:
  - *Hand-rolled Redis list* — reimplements the five mechanisms above, badly, forever.
  - *GitHub Actions `concurrency:` groups* — claude-code-action's own docs concede the action has no
    queue either; concurrency groups cancel or serialise, they do not hold a wait-list.
  - *The existing tool's depth-3 FIFO* — see `DES-BUILD-NOT-EXTEND-PI-ROUTINES`.
- **Deployment note**: default the compose file to **Valkey** (BSD-3, Linux Foundation) rather than
  Redis. Redis ≥8.0 is tri-licensed AGPLv3 / SSPLv1 / RSALv2; the AGPL does not reach this project —
  we speak RESP over a socket and do not link Redis — but Valkey means the conversation never happens
  for downstream self-hosters either.
  **Valkey status — good enough to proceed, not proven.** BullMQ's own marketing page lists Valkey among
  supported backends, but its compatibility *documentation* commits only to *"full Redis™ compliant with
  version 6.2.0 or newer… not all the alternatives are going to work properly"*. The widely-repeated
  claim that BullMQ's test suite runs against Valkey is **UNVERIFIED** — it traces to secondary sources,
  not to BullMQ, and must not be cited as fact. What *is* solid: BullMQ talks RESP through ioredis with no
  Redis-specific handshake, and the only Valkey-related upstream issues are feature requests for a
  Valkey **Glide** adapter — not bug reports about basic compatibility. No Lua incompatibility reports
  exist, which matters because BullMQ is Lua-heavy. Proceed on Valkey; **keep Redis 8 as the documented
  fallback** and treat any queue weirdness as a Valkey suspect first.
- **Consequences worth knowing before sizing anything** — all source- or doc-verified:
  - **The rate limiter is global, not per worker.** *"The rate limiter is global, so if you have for
    example 10 workers for one queue with the above settings, still only 10 jobs will be processed by
    second."* Do **not** multiply `limiter.max` by worker count. `concurrency` is the opposite — it is
    per-Worker-instance. Two adjacent options with opposite scoping is a trap worth writing down.
  - **`queue.pause()` is durable and global**, implemented as a Redis-side rename of the `wait` key to
    `paused` — so it survives a restart, which is what makes it usable as the admin extension's on/off
    switch (`/dispatch pause` / `/dispatch resume`, still `queue.pause()` / `queue.resume()`, still
    durable). New jobs are still accepted while paused (they land in `paused`); in-flight jobs run to
    completion. That is the correct semantics for `DES-ADMIN-VIA-PI-EXTENSION`'s switch: **off means
    "stop starting work", not "start dropping work"** — dropping would violate `REQ-QUEUE-BURST-NO-DROP`.
  - **Stalled-job recovery re-runs paid jobs by default** — see `CONST-RETRY-INFRA-ONLY`.
- **Reference** (no authority): `docs.bullmq.io/guide/rate-limiting`, `/guide/workers/pausing-queues`,
  `/guide/redis-tm-compatibility`.

## DES-RUN-HISTORY-FLAT-FILES-NO-DB

- **Decision**: The per-job run history is a flat `node:fs` sidecar keyed by job id — an id-only status
  record at `logs/<jobId>.json` (written with `fs.writeFileSync`) plus an optional append-only
  `logs/<jobId>.log` of raw container output (`fs.createWriteStream`). No database, no logging framework.
  Retention is a boot-time age sweep (`makeLogReaper`, window `PI_LOG_RETENTION_DAYS`), not a rotation
  library.
- **Why**: The record must **outlive the queue entry**. BullMQ evicts completed and failed jobs by age
  (`removeOnComplete` / `removeOnFail`), so the retained job cannot be the durable store — and it never
  carries `exitCode`, `turns`, or `budgetReserved` in the first place. The sidecar is justified precisely
  by what BullMQ lacks: a record that survives eviction and holds the run's outcome fields. Those records
  are immutable, filename-keyed, and never queried across each other, so a store with query power earns
  nothing. This is `DES-QUEUE-BULLMQ-OVER-CUSTOM`'s library-first ethos one file down, and the design
  home for the `document-build-decision` rule that the sidecar's inline `Custom:` comment cites.
- **Rejected**:
  - *Querying BullMQ's retained job instead of a sidecar* — BullMQ evicts by age, so it is not the
    *durable* store, and it never carries `exitCode` / `turns` / `budgetReserved`. It cannot be the
    record.
  - *An embedded database (lowdb / better-sqlite3) or a structured-logging library (pino / winston)* —
    the records are immutable, filename-keyed, with no cross-record query in scope, so neither earns its
    keep. A DB adds a native build (the ARM / musl / glibc pain the job image exists to avoid) and a
    second retention authority beside the reaper for zero query benefit; a logging library brings its own
    rotation as that same second authority. Both violate the deliberate "no database" thinness
    (`interfaces.md` preamble) and the library-first ethos — the same reasoning as
    `DES-QUEUE-BULLMQ-OVER-CUSTOM`.
- **Traces to**: `DES-QUEUE-BULLMQ-OVER-CUSTOM`; implemented in `worker/src/run-history.mjs`.

## DES-PERSONA-VIA-APPEND-SYSTEM-MD

- **Decision**: Bake the persona into the image at `~/.pi/agent/APPEND_SYSTEM.md`, **and** pass per-flow
  additions via **`appendSystemPromptOverride`** — never via bare `appendSystemPrompt`.
- **Why**: The obvious reading of these two mechanisms is that they compose. **They do not.** Passing
  `appendSystemPrompt` **replaces** file discovery — the `??` means the baked `APPEND_SYSTEM.md` is
  never looked for. The persona vanishes with **no error, no warning, and a job that completes
  successfully**. `appendSystemPromptOverride` receives the *discovered* content as `base`, so
  `(base) => [...base, perFlowText]` preserves both. This is the single most dangerous trap in the
  integration and is why `REQ-UPSTREAM-CONTRACT-TESTS` asserts both strings reach the assembled prompt:
  no other mechanism would ever tell us.
  The **global** path is chosen over the project path because `~/.pi/agent/` has **no trust gate**,
  while project `.pi/*` resources are gated by `isProjectTrusted()` and headless modes ignore them
  absent saved trust — nondeterministic inside a container is unacceptable for the file that carries our
  standing rules. Requires coding-agent ≥ v0.46.0; confirmed present at the pin.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → resource-loader.ts:480-482` —
  `const appendSources = this.appendSystemPromptSource ?? (this.discoverAppendSystemPromptFile() ? [...] : [])`
  · `→ resource-loader.ts:156 → appendSystemPromptOverride?: (base: string[]) => string[]` ·
  `→ resource-loader.ts:979-991 → discoverAppendSystemPromptFile` (global path ungated) ·
  `→ CHANGELOG.md [0.46.0] - 2026-01-15` ("Support `APPEND_SYSTEM.md`…")
- **Rejected**:
  - *`SYSTEM.md`* — replaces pi's default prompt entirely, losing its built-in tool guidance. We want to
    add to pi's behaviour, not supplant it.
  - *Project-level `.pi/APPEND_SYSTEM.md`* — trust-gated; headless ignores it without `--approve`.
  - *`AGENTS.md`* — not the persona channel, though it **does** now load
    (`CONST-NO-CONTEXT-FILES-MANDATORY`, amended: `/workspace` is the base repo's default-branch sha, so
    it is merge-gated). It is rejected here for placement, not trust: pi emits context files into
    `<project_context>` **after** the append block, so a repo's `AGENTS.md` carries its conventions and
    can never *be* the floor. That ordering is what lets both ship.
  - *Extension returning `systemPrompt` from `before_agent_start`* — genuinely works and is
    cache-friendly when deterministic (the original pi-caveman demonstrates this). Rejected for moving
    parts: load-order chaining, per-prompt re-return, extension loading in headless mode. Reserve for
    prompt logic that cannot be expressed as a file.
  - *Per-message injection* — see `CONST-PERSONA-IN-CACHED-PREFIX`.
- **Traces to**: `CONST-PERSONA-IN-CACHED-PREFIX`, `INT-SDK-SESSION-OPTIONS`, `REQ-UPSTREAM-CONTRACT-TESTS`

## DES-BUILD-NOT-EXTEND-PI-ROUTINES

- **Decision**: Build fresh rather than extend the existing `pi-routines` community project.
- **Why**: Adding the missing GitHub event types to its poller would be a small PR — but the blockers
  are **structural, not featural**: execution is session-bound (routines run as turns inside a live
  interactive session, single-flighted), the overflow queue is depth 3, and the trigger server hard-binds
  to `127.0.0.1` with no config. Fixing those means replacing the core while inheriting the name and its
  users' expectations. Two of its ideas were adopted instead of its code: **budget-before-tokens**
  (`CONST-BUDGET-BEFORE-TOKENS`) and **fire dedup** (`REQ-DEDUP-BY-DELIVERY-GUID`).
- **Evidence (upstream)**: `Davidcreador/pi-routines @ 6d2aa64 (v0.5.1) → src/types.ts:105` (event union:
  `pull_request.opened|closed`, `issues.opened`, `push` — no `issues.labeled`, no `issue_comment`) ·
  `→ src/types.ts:423 → MAX_QUEUE_DEPTH = 3` · `→ src/guard.ts → isRoutineTurnActive` ·
  `→ src/server.ts` (hard `127.0.0.1:7424` bind)

## DES-CONCURRENCY-3

- **Decision**: Default worker concurrency 3, exposed as `PI_CONCURRENCY`.
- **Why**: Two soft limits, and 3 is their conservative intersection. RAM (~1.5–2.5 GB/job against a
  16 GB box) suggests 3 — but RAM is probably **not** the binding constraint: the provider's tier
  throttles concurrent streams and tokens-per-minute long before Docker runs out of memory. A **config
  knob rather than a constant** because one of the two inputs is an unmeasured guess (`OQ-002`), so
  re-tuning after measurement should be a deploy, not a code change.
- **Boot-reaper invariant — single worker per docker daemon**: The knob is parallelism *within* one worker
  process; the design assumes exactly one worker per docker daemon. The boot reaper clears every stray
  `pi-job-*` container on start (a leaked container keeps spending, so it must go before any new job
  launches) — a co-located second worker sharing the daemon would read the first's in-flight container as
  its own to remove and kill a live job. Per-host is the common case, but the docker daemon, not the host,
  is the true boundary.
- **Traces to**: `OQ-002`, `REQ-QUEUE-BURST-NO-DROP`

## DES-CRON-VIA-BULLMQ-SCHEDULER

- **Decision**: Scheduled triggers use BullMQ **Job Schedulers** (`upsertJobScheduler`). We do not build a
  cron, and we do not use the deprecated `repeat:` API. **A schedule is a trigger, not a job kind** — it
  produces an ordinary job aimed at either a GitHub repo or a local folder.
- **Why**: pi has no cron (`DES-TRIGGER-OUTSIDE-PI`), and hand-rolling one means reimplementing cron
  parsing, persistence, missed-tick policy and overlap control — four mechanisms, the exact drowning
  `DES-QUEUE-BULLMQ-OVER-CUSTOM` refused. BullMQ's scheduler is a **Redis object, not a JS timer**
  (`ZADD repeat <nextMillis> <id>` + `HMSET`), so it survives a worker restart with nothing to lose and a
  Redis restart under the AOF we already require. Three of its properties are exactly what a
  money-spending harness needs, and all three are verified rather than assumed:
  - **No backfill.** Six hours down with an hourly schedule costs **one** paid run on restart, not six —
    the `every` path aligns forward to a single next slot; the `pattern` path asks cron-parser for one
    `next`. Neither loops. This is the difference between a reboot and a bill.
  - **No overlap, structurally.** The next job is only created when the current one *starts processing*,
    so a 30-minute flow on a 10-minute schedule yields one job every 30 minutes rather than three
    concurrent agent runs. The cost is silent under-firing — actual cadence degrades below the configured
    one under load, so the admin extension should surface `next` drift rather than let it look healthy.
  - **Deterministic `jobId`** — `repeat:<schedulerId>:<nextMillis>` — so scheduler jobs get
    `REQ-DEDUP-BY-DELIVERY-GUID`-equivalent dedup for free, with no GUID to supply.
  - **Local-only this slice.** The on × run diagonal rejects a `cron → github` trigger at load
    (`INT-TRIGGERS-FILE-CONTRACT`, `DES-TRIGGERS-UNIFIED-FILE`). A scheduled job on any forge has no webhook
    delivery, issue/PR number, title, or body to supply, and post-integration the github path would perform
    a real host clone and per-job token mint before failing every tick — spend and side effects for a
    trigger that cannot complete. GitHub scheduling is deferred to a later slice.
  - **Two distinct enqueue paths, not duplication.** The interactive `enqueueLocalJob` sets `attempts: 2`
    with backoff; the scheduled path (`upsertJobScheduler`) passes retention-only opts with a single
    attempt. For an unattended recurring trigger the **cadence is the retry**, so a failing tick must not
    multiply spend within one tick — two distinct triggers with different retry semantics, not two
    implementations of one thing.
  **Legacy `repeat:` is deprecated and slated for removal in v6** — starting on it would be adopting a
  known-dead API.
- **Evidence (upstream)**: `taskforcesh/bullmq @ v5.80.4 → src/classes/queue.ts:468-495 → upsertJobScheduler`
  · `→ queue.ts:651` — `@deprecated … will be removed in v6. Use removeJobScheduler instead` ·
  `→ src/commands/includes/getJobSchedulerEveryNextMillis.lua` — `nextMillis = prevMillis + every` then,
  verbatim, `-- check if we may have missed some iterations`, resolving to a **single** aligned slot ·
  `→ src/commands/addJobScheduler-11.lua:144` — `local jobId = "repeat:" .. jobSchedulerId .. ":" .. nextMillis`
  · `→ addJobScheduler-11.lua:164,191` — returns `-11` `SchedulerJobSlotsBusy` / `-10`
  `SchedulerJobIdCollision` · `→ src/commands/includes/storeJobScheduler.lua` (Redis-resident schedule) ·
  `→ src/classes/queue.ts:603-696` — `getJobScheduler` / `getJobSchedulers(start,end,asc)` /
  `getJobSchedulersCount` / `removeJobScheduler`
- **Rejected**: a hand-rolled cron (four mechanisms, see above) · the legacy `repeat:` API (deprecated,
  v6 removal) · an in-process timer (dies with the process; the flaw that made the closest existing tool
  unusable — `DES-BUILD-NOT-EXTEND-PI-ROUTINES`)
- **Must handle**: `-10` / `-11` return codes. Swallowing them makes a schedule edit **silently no-op**,
  which looks identical to success.
- **Carve-out that is not optional**: scheduler jobs **bypass `maxStalledCount`** — see
  `CONST-RETRY-INFRA-ONLY`. This is the one place BullMQ's stall protection does not hold, and it is
  precisely the trigger that runs while nobody is watching.
- **Traces to**: `CONST-RETRY-INFRA-ONLY`, `CONST-BUDGET-BEFORE-TOKENS`, `REQ-RUNNER-TURN-BUDGET`,
  `REQ-QUEUE-BURST-NO-DROP`

## DES-FORGE-IS-A-PER-JOB-DEPENDENCY

- **Decision**: A job's forge is resolved **per job**, from `job.kind`, at exactly one place: the worker's
  composition root holds a `forges` map of `{ auth, host }`, and the four dependencies that used to be
  bound to one forge — `mintToken`, `comment`, `isDefaultBranchProtected`, `prepareWorkspace` — look their
  forge up from the job they were handed. The interface is the one that already existed: `get-token`'s
  `{ mintToken, selfId, source }` and `github-host`'s three methods. The receiver routes **by path**
  (`/gitlab`, with `/` remaining GitHub), so each source has its own secret and its own trust regime,
  chosen before a byte of the body is read.
- **Why**: `processor.mjs` already consumed those four as independently injected functions rather than as
  one `github` object, so it was written against a de-facto interface and merely called it behind
  `job.kind === "github"` guards. Making the lookup per job removed the guards without inventing anything:
  no abstraction was designed ahead of its second user, because the shapes were already there and the
  second user only revealed which *parameters* were wrong — a repo string where a job belonged. What the
  processor gained is that "forge-backed" is now the negation of local rather than a list of forges; an
  enumeration that forgot a forge would let it silently skip a money gate.
- **Rejected**:
  - *A generic "any forge" plugin framework.* Three named forges are wanted (#42, #43, #61), and one seam
    discovered from a real second one beats a shape guessed from none. **Still rejected at four forges,
    and now on evidence rather than on principle**: #43 and #61 landed together precisely so the seam
    would be sized against the two extremes at once — Forgejo's transport is byte-identical to GitHub's
    and all its work is semantic, Azure shares almost nothing — and what held without change was the
    `{ auth, host }` pair and `makeForgePreparers`. What did NOT hold was everything written down
    *elsewhere*: nine places said which forges exist, and the ones that mattered were the ones that failed
    SILENTLY (a missing receiver trigger group throws inside a reload that keeps yesterday's rules; a
    missing token-variable name is simply not refused in `PI_FORWARD_ENV`). The answer was a table those
    are derived from — `worker/src/forges.mjs`, which imports nothing so it can be the leaf of both
    services' graphs — not an interface for a forge to implement.
  - *Routing by header rather than by path.* Forgejo emits `X-GitHub-*` on every delivery (#61), so
    headers cannot reliably tell forges apart — and worse, a request able to select which gate it faced
    would select the weakest available. A path is chosen by the operator when they configure the webhook,
    not by the sender at delivery time.
  - *Negotiating the verification mechanism from what the request carries.* The same reason one layer
    down: `CONST-HMAC-OVER-RAW-BODY`'s mode is config-declared, and a delivery presenting the other mode's
    header is refused even when that header is correct.
  - *A filter that performs its own membership lookup.* `filter.mjs` and `filter-gitlab.mjs` import
    nothing side-effecting, do no I/O and never throw, and that purity is exactly what makes the
    security-critical decision testable offline. The lookup runs in the receiver, between verification and
    the gate, and arrives as a plain number.
  - *Adapting GitHub's "404 means unprotected" to GitLab.* It has no such 404, and #61 records what
    carrying that assumption across a forge boundary costs: every branch reports unprotected and the
    never-merge backstop is silently disarmed. GitLab reads the protected-branches **list** instead.
  - *Inferring approval from label-application on GitLab.* The premise that makes it work on GitHub is
    false there (`CONST-TRIGGER-AUTHOR-GATE`), so the actor's access level is resolved for every trigger
    type rather than only for comments.
  - *Forking the clone path per forge.* The askpass helper, the hardening flags, the gone-SHA markers and
    the pinned detached checkout are facts about git and this project, not about GitHub; only the remote
    URL and the agent's envelope differ, and both are injected. A second copy would be a second place to
    fix a clone bug, and the copy that did not get fixed would be the one nobody was looking at.
  - *One shared `postStatusComment(repo, number, …)`.* GitLab's issues and merge requests are separate
    endpoints AND separate number sequences, so the method takes the discriminated target. GitHub reads
    `target.type` not at all — but a host method that cannot be called uniformly is not a seam.
- **Traces to**: `CONST-TRIGGER-AUTHOR-GATE`, `CONST-HMAC-OVER-RAW-BODY`, `CONST-TOKEN-SCOPED-PER-JOB`,
  `INT-GITLAB-PAYLOAD-SUBSET`, `INT-TRIGGERS-FILE-CONTRACT`, `OQ-013`

## DES-IMAGE-DECLARES-ITS-FORGES

- **Decision**: A job image declares which forges it can serve, as the label `dev.pi-dispatch.forges`, and
  the worker's **pre-spend** image preflight refuses a job whose forge the label excludes. The label rides
  the `docker image inspect` the preflight already runs for `dev.pi-dispatch.pi-version`, so the happy path
  still costs exactly one spawn. **An absent label ALLOWS everything**; only a label that is present and
  excludes the job's forge refuses. `image/verify-image.sh` checks the declared list against the CLIs
  actually installed, so the label cannot lie.
- **Why**: `run.image` is optional (`INT-TRIGGERS-FILE-CONTRACT`), and the Azure DevOps arm made that a
  money problem rather than a cosmetic one. Azure's only CLI is the Azure CLI plus its devops extension —
  roughly a gigabyte, with a Python runtime — so it ships in a separate image variant rather than in the
  lean, digest-pinned default. An azure trigger that forgets `run.image` therefore runs on the default
  image, finds no `az`, and fails at step 3 **inside a paid container**, on every single delivery, looking
  exactly like a bad agent run rather than a missing tool.
  This is not a new idea so much as an existing one moved to where it helps: `verify-image.sh` already
  looped over the forge CLIs, and its comment already named this failure — *"a MISSING one fails the same
  silent way: the agent follows an envelope naming a command"*. That check runs at image BUILD; the label
  moves the same guarantee to RUN TIME, per job, which is the only place it can catch an operator's own
  image (`OQ-012`).
- **The polarity is the opposite of what "declare your capabilities" suggests, and that is deliberate.**
  The pi-version label degrades safely when missing — no label means "never resume". A forges label that
  *refused* when missing would invert that on the same parse and break every operator-built image predating
  it, with no warning first. A label that is present but parses to nothing usable is treated as absent
  rather than as "serves no forge": refusing every job over a mistyped label is a worse failure than the
  one the label exists to prevent.
- **Rejected**:
  - *Refusing at trigger load.* The loader would have to know which images exist on which host, and
    `run.image` may legitimately name an image built later. A trigger file is reviewed once; the image set
    changes without it.
  - *Probing for the binary inside the container.* That is post-spend by construction — the budget slot is
    taken and the container is running, which is the exact cost this avoids.
  - *One fat image.* Putting a gigabyte and a second language runtime into every job container, so that the
    minority of deployments serving Azure need not name an image, inverts who pays.
  - *Refusing when the label is absent.* Safer-sounding and wrong: see the polarity paragraph.
- **Traces to**: `INT-CONTAINER-RUNTIME-CONTRACT`, `INT-TRIGGERS-FILE-CONTRACT`, `DES-PER-TRIGGER-JOB-IMAGE`,
  `OQ-012`

## DES-TRIGGERS-UNIFIED-FILE

- **Decision**: One `triggers.json` of `{ on, run }` entries is the single source of standing triggers for
  **both** services. A shared validator (`worker/src/triggers.mjs`, exported as
  `@pi-dispatch/worker/triggers`) parses and validates the whole file; the worker selects `on.type:"cron"`
  and the receiver selects `on.type ∈ {label, comment, pull_request}` for whichever forge each entry's `run.kind` names. Both validate everything; each
  evaluates only its own subset. This replaces the two prior files (`PI_SCHEDULES_FILE` and
  `receiver.flows.json`) with **no compatibility shim** — a clean cutover.
- **Why**: The schema unifies the operator's *view* of triggers; it does **not** merge the engines. The
  `receiver`/`worker`, adversarial/trusted boundary is untouched: a `label` `on` is never scheduled (no
  delivery GUID to dedup on, no fresh collaborator approval), and a `cron` `on` never receives a webhook.
  The `on × run` matrix pairs `cron ↔ local` and webhook ↔ a **forge** (`github`|`gitlab`), and that
  pairing **is** the trust boundary, encoded as a fail-loud validation rule (`INT-TRIGGERS-FILE-CONTRACT`). One validator, run
  by both, means a malformed file fails both services identically — the two cannot drift. The shared module
  lives in the worker package because `receiver` and `admin` already depend on `@pi-dispatch/worker`; the
  dependency is one-way, so no cycle.
- **Rejected**: a compat union accepting both old shapes (the repo bans backwards-compat shims,
  `.claude/rules/legacy-removal.md`) · two independent validators (they drift) · a third shared package
  (unnecessary — the one-way worker dependency already exists).
- **Traces to**: `INT-TRIGGERS-FILE-CONTRACT`, `REQ-CRON-SCHEDULED-JOBS`, `REQ-TRIGGER-AUTHOR-GATE`

## DES-PER-TRIGGER-JOB-IMAGE

- **Decision**: The job image is resolved **per job** — `job.image ?? PI_JOB_IMAGE` — from an optional
  `run.image` on all four trigger kinds. `PI_JOB_IMAGE` remains the deployment default and the only value a
  deployment needs. The field is operator-authored in the reviewed `triggers.json` and is reachable from
  **no** model-callable tool, **no** panel key, and **not** the settings overlay. A named image must be
  present on the host: a pre-spend `docker image inspect` refuses the job before `reserveBudget` with a
  policy reason, and `--pull=never` joins `ISOLATION_FLAGS`.
- **Why**:
  - *The toolchain is a property of the flow, not of the deployment.* Verbatim the `run.packages` argument:
    a flow needing a Python toolchain and one needing Node + Playwright belong to the same deployment, and
    one image means the **union** of every toolchain in one tag, growing monotonically, with nothing ever
    removable because some other flow might need it. And a label/comment/PR trigger runs the same flows a
    cron trigger does — hence all four kinds, not cron only.
  - *It changes what is in the box, never what the box can do.* The argv is built by the worker:
    `ISOLATION_FLAGS` + the closed env map + the four mounts, none of them influenced by the image.
    `--cap-drop=ALL` bounds *what runs*; the image decides *which code runs*.
    `CONST-ISOLATION-CONTAINER-PER-JOB`'s enumerated acceptance is untouched, and was checked rather than
    assumed.
  - *The trust class is the file, not the field.* An operator who can edit `triggers.json` can already point
    a cron trigger at any folder on the host and run any flow in it. "…and in this image" does not cross a
    boundary they were on the far side of. `REQ-GLOBAL-PI-OVERLAY` already names this class: *"operator
    deploy-time config — the same trust class as baking the image"*.
  - *Two mechanisms for a missing image, doing different jobs.* The preflight is readable, pre-spend and
    non-retryable — a bare docker failure would read as infra and `CONST-RETRY-INFRA-ONLY` would have the
    queue pay for the retry (it did: exit 125 fell through as "unknown container exit", kept the slot, and
    burned a second one on the retry). `--pull=never` takes the registry out of the picture entirely.
    Neither is sufficient alone: the check is raceable, the flag is silent.
  - *What this deliberately does not do: verify the image.* `INT-CONTAINER-RUNTIME-CONTRACT` states the
    checklist, `docs/job-image.md` is its operator form, the check is the operator's, and the residual is
    `OQ-012` rather than a claim.
- **Rejected**:
  - ***`PI_JOB_IMAGE_ALLOWLIST`, mirroring `PI_DISPATCH_RUN_ROOTS`*** — **there is nothing model-callable to
    bound.** `PI_DISPATCH_RUN_ROOTS` exists because `dispatch_run` takes a folder *from the model*; an
    allowlist is what converts a model-supplied path into a bounded one. `run.image` is never model-supplied:
    no tool parameter, no panel key, one writer — an operator editing a reviewed file. An allowlist over a
    field only an operator can write is a second operator-authored file constraining the first: its only
    failure mode is refusing the operator's own edit, its only success mode is redundancy, and its *presence*
    would advertise a threat model this design forecloses. **If a future tool ever takes an image parameter,
    the allowlist arrives with that tool, and this row is the reason it must.**
  - *`image` as a runtime settings overlay key (`dispatch_set`)* — that is the admin-editable runtime channel,
    bendable by a prompt injection in the operator's session behind a confirm. Changing *which code every
    subsequent job executes* from that channel is strictly worse than changing the daily cap, which
    `DES-RUNTIME-SETTINGS-FILE-OVERLAY` already treats as needing an operator confirm.
  - *An `image` parameter on `dispatch_trigger_add`/`_edit`* — same channel, one level down. A confirm reading
    "add trigger with image `my-python:latest`" gives the operator no way to distinguish a benign tag from a
    hostile lookalike; the property that makes `folder` confirmable (it names a path the operator recognises)
    does not transfer to a ref that may be a registry, tag, digest, or typosquat. `run.packages` set the
    precedent and it is followed exactly.
  - ***A flow-declared image, read from the serviced repo*** — the sharpest rejection here.
    `.pi/skills/<flow>/SKILL.md` is **merge-gated, not operator-authored**, so this would hand anyone who can
    land a commit on a serviced repo's default branch the choice of container. That population can already
    execute code **inside** a job container (`CONST-NO-CONTEXT-FILES-MANDATORY`, as amended) — but choosing
    the container is different in kind: it hands them the loader flags, the guardrail floor, the pinned pi
    version and the non-root user, i.e. **every property `SECURITY.md` names as what bounds them**.
    `DES-AI-TRIGGER-FLOW-GATE` reads a **boolean** from that file, at a pinned SHA, precisely because a
    boolean is all it is willing to take from there. An image reference is not a boolean.
  - *A second mount, or pulling the image at job time* — the mount list is a constitutional enumeration and
    widening it for zero new capability is the trade `DES-OPERATOR-GLOBAL-OVERLAY` already refused for staged
    packages. A job-time pull is worse: a network fetch of executable code, at job time, keyed on a name that
    just became per-trigger data — the shape `PI_OFFLINE=1` exists to make unreachable one layer up. Hence
    `--pull=never`.
  - *Keep baking every flow's toolchain into the one image* — the status quo and the fat-image trap.
    **`DES-OPERATOR-GLOBAL-OVERLAY`'s "Bake the overlay into the image" rejection still stands and is not
    re-opened**: models, skills, persona and staged packages ride a `:ro` mount and need no rebuild, and
    nothing that was a mount becomes a bake here. What `run.image` admits is the case that rejection never
    covered — a **toolchain** (apt packages, language runtimes, system libraries), which a read-only mount
    cannot deliver at all, and for which "build your own" was always the answer the README gave. **The
    boundary: overlay = pi *configuration*, one copy per deployment, mounted; image = the *operating system*
    the flow needs, per flow, built.** The pulled prebuilt image stays the default and the only thing a
    deployment needs.
- **Traces to**: `INT-TRIGGERS-FILE-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`,
  `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-PI-VERSION-PINNED`, `CONST-RETRY-INFRA-ONLY`,
  `REQ-UPSTREAM-CONTRACT-TESTS`, `DES-RUNTIME-SETTINGS-FILE-OVERLAY`, `DES-OPERATOR-GLOBAL-OVERLAY`,
  `OQ-012`

## DES-PR-TRIGGER-ROUTES-TO-FLOW

- **Decision**: A `pull_request` trigger **routes the event to the configured flow**; the harness does not
  implement review-vs-push behaviour and does not change the clone ref. The worker still clones the base
  repo's default-branch SHA (fork-safe, `INT-CONTAINER-JOB-INPUTS`), delivers the PR context — number,
  head/base refs — as DATA in `/job/event.json`, and the flow (a repo skill) decides what to do with the PR
  via `gh` (review, comment, or push to the PR head branch).
- **Why**: pi is the agent; this repo is the trigger, the queue, and the box (`no-reimplementing-pi`,
  `library-first.md`). Encoding "fix the PR" vs "review the PR" in the harness would rebuild pi badly and
  fork the prompt per intent; naming the flow and handing it the PR context keeps the harness thin and lets
  the same machinery serve any PR workflow. Keeping the clone ref at the base default-branch SHA preserves
  the fork-safety property the isolation design already relies on — attacker-controlled head bytes are never
  executed by the host or baked into the system prompt. The job-data carries a discriminated
  `target: { type: "issue" | "pull_request", number, title, body, head?, base? }` rather than a compat union
  of flat fields.
- **Rejected**: cloning the PR head ref in the worker (executes fork code on the host clone path, and a
  base-scoped token cannot push to a fork branch anyway) · harness-side review/push logic (reimplements pi) ·
  auto-firing on any PR open (unbounded paid runs from fork PRs — `CONST-TRIGGER-AUTHOR-GATE`).
- **Traces to**: `CONST-TRIGGER-AUTHOR-GATE`, `INT-WEBHOOK-PAYLOAD-SUBSET`, `INT-CONTAINER-JOB-INPUTS`,
  `CONST-ISOLATION-CONTAINER-PER-JOB`

## DES-CLI-TRIGGER-FOR-LOCAL

- **Decision**: Local-folder jobs are triggered through **three producers**, each calling
  `enqueueLocalJob` directly: the **CLI** (`pi-dispatch run <folder> --task … [--flow …]`), the first and
  operator-typed interface; the admin **`dispatch_run`** tool/command (`DES-ADMIN-VIA-PI-EXTENSION`); and
  the **worker's outbox collector** (`DES-JOB-OUTBOX-CHAINING`). The CLI is the terminal entry point a
  local operator reaches for first; the other two are the AI-triggered paths, gated by
  `DES-AI-TRIGGER-FLOW-GATE`.
- **Why**: For a self-hosted tool that mostly runs on people's own machines, the terminal is the natural
  first interface — no web server, no bigger build before anything runs — and it is what makes the local
  path usable early, without the GitHub-webhook receiver a local user does not need.
- **Consistency check** (this was verified, not assumed): no producer violates a constraint.
  `CONST-TRIGGER-AUTHOR-GATE` is webhook/comment-scoped by construction, and local jobs are ungated by
  design (`SECURITY.md`: local CLI access *is* the trust boundary for local). Critically,
  **`CONST-BUDGET-BEFORE-TOKENS` still holds**: the cap is checked and incremented in the *worker's
  processor*, immediately before the container starts — never in a trigger. A producer that enqueues a
  job cannot bypass the budget, because the budget gate lives on the consumer side, after prepare and
  before `runContainer`. All three producers are only producers; they spend nothing. The depth/count/rate
  caps on the AI-triggered producers (`PI_CHAIN_DEPTH_MAX`, `PI_CHAIN_MAX_PER_JOB`, the `dispatch_run`
  per-hour rate limit) are **additional producer-side defense-in-depth**, never a substitute for the
  consumer-side cap that is the actual money bound.
- **Safety**: a local job edits the folder in place with no undo, so a producer refuses a **dirty git
  working tree**. The guard is mirrored at each producer: the CLI honours `--force`; the `dispatch_run`
  tool/command has **no force option**, so an injected call cannot wave the guard away. The **outbox
  collector** carries a single **same-folder-chain exception**: a chained job continuing on the **parent's
  own folder** skips the guard, because there the "dirty" tree is the parent agent's deliberate output —
  the handoff the child builds on — not a human's uncommitted work. A chain targeting a **different**
  folder is out of this slice and would still enforce the guard; the exception is scoped to same-folder
  chaining only.
- **Traces to**: `CONST-BUDGET-BEFORE-TOKENS`, `DES-ADMIN-VIA-PI-EXTENSION`, `DES-AI-TRIGGER-FLOW-GATE`,
  `DES-JOB-OUTBOX-CHAINING`, `REQ-LOCAL-JOB-VISIBILITY`

## DES-WORKER-ON-HOST

- **Decision**: The worker runs **on the host** (a Node process, `pi-dispatch worker` / `npm start`), not
  in a container. It launches job containers by shelling out to the real `docker` CLI.
  `docker-compose` runs **only Valkey**; the worker is a host process alongside it.
- **Why**: This is the reversal of `DES-JOB-FILES-VIA-VOLUME-SUBPATH` (below, superseded), forced by two
  findings and the local-first target.
  **(1) The `docker` CLI translates host paths; the daemon does not.** On Docker Desktop the daemon is a
  *Linux* daemon behind a Windows named pipe (`docker context` shows `npipe://…` with `docker info`
  reporting `linux/x86_64`), so `C:\Users\…` is not a path a Linux kernel can bind-mount. Translation is
  client-side — corroborated by compose's `COMPOSE_CONVERT_WINDOWS_PATHS` rewriting paths even against a
  remote non-Windows daemon. So a **containerised** worker calling the Engine API must construct the
  VM-internal path itself, and **that prefix has already moved between Docker Desktop versions**
  (`/host_mnt/c/…` → `/run/desktop/mnt/host/c/…`). Pinning bespoke path math to an undocumented,
  *moving* internal is `CONST-PI-VERSION-PINNED`'s failure class with a different vendor — it would break
  on a silent Docker Desktop auto-update. A host worker shelling out to `docker` inherits Docker's own
  cross-platform-tested translation for free. This is `library-first` one level up: do not reimplement
  Docker Desktop's path translation.
  **(2) Local-folder jobs *require* a host bind mount.** The named-volume trick in the superseded entry
  dissolves the path problem only because no host path crosses the boundary — which is exactly what a
  local-folder job cannot do: the operator's own folder must be bind-mounted as `/workspace`, edited in
  place. There is no volume to hide behind. Since local folders are the primary self-hosted experience,
  the deployment model must support the bind mount, and the host worker does so with zero path math.
  **Isolation is unaffected.** `CONST-ISOLATION-CONTAINER-PER-JOB` is about the **job** container being
  the boundary — the harness still never runs pi on the host. And a container holding `/var/run/docker.sock` is
  already root-equivalent on the host, so containerising the worker bought *no* isolation; it only bought
  deployment tidiness, which is what this trades away.
- **What this deletes**: the named-volume + `volume-subpath` machinery, the `≥26.1.0` Engine floor, the
  socket mount, and the `docker-socket-proxy`. The worker binds `/job:ro` and `/workspace` (the folder)
  directly.
- **Accepted cost, stated plainly**: Node on the host, not only Docker. `docker compose up` alone no
  longer runs everything; the operator also runs `pi-dispatch worker`. That is the honest price of
  local-folder jobs working on Windows/macOS/Linux without fragile path math. The receiver is Node too,
  so it is one install story (`npm ci`), with Docker running Valkey and the job containers.
- **Evidence**: verified first-hand this session — `docker context` (`npipe` endpoint, `linux/x86_64`
  daemon) · `moby/for-win#14271` (VM prefix `/run/desktop/mnt/host/…`) and `docker/compose#5563`
  (older `/host_mnt/…`), i.e. the prefix moved · `docker/compose#4240`
  (`COMPOSE_CONVERT_WINDOWS_PATHS` is unconditional client-side rewriting) · a constructed `docker run`
  argv launched the real job image with a host-native folder path, cross-platform, with no translation.
- **Rejected**: containerised worker + `volume-subpath` (cannot bind-mount a local folder; pins moving
  path math) — see the superseded entry for its full reasoning, kept as the record of why it was tried.
- **Traces to**: `INT-CONTAINER-JOB-INPUTS`, `INT-CONTAINER-RUNTIME-CONTRACT`,
  `CONST-ISOLATION-CONTAINER-PER-JOB`

## DES-JOB-FILES-VIA-VOLUME-SUBPATH

- **Status**: **SUPERSEDED by `DES-WORKER-ON-HOST`.** Kept in place because IDs are permanent and its
  research (subpath semantics, the socket-proxy hardening) stays relevant if a GitHub-only deployment
  ever re-containerises the worker. The decision below is **not** what the code does: the worker runs on
  the host and bind-mounts directly.
- **Decision**: The worker hands `/workspace` and `/job` to the job container via a **plain named volume
  per job** plus `--mount type=volume,…,volume-subpath=…`. Never a host bind mount. Docker Engine
  **≥26.1.0**. A `tecnativa/docker-socket-proxy` sits between the worker and the Docker socket.
- **Why**: The worker is containerised and launches **sibling** containers through the Docker socket, so
  every bind-mount path it passes to `docker run` is resolved in the **daemon's** filesystem namespace,
  not its own. `-v ${JOB_DIR}/workspace:/workspace` therefore mounts an empty directory or the wrong one
  — silently. This is the classic docker-out-of-docker footgun and it was this project's largest named
  unknown for cross-platform support.
  **A named volume dissolves the problem rather than managing it**: a volume is a daemon-side handle, so
  no host path string ever crosses the boundary and there is nothing to translate. Every competing option
  manages the mismatch per-platform instead of removing it, and each breaks somewhere: *same-path bind
  mounts* work on Linux and mostly on macOS but **break on native Windows**, where the daemon lives in a
  VM with a POSIX namespace and drive-letter paths are translated rather than passed through — they only
  hold if the whole stack runs inside WSL2, which is a discipline, not a guarantee. *Worker on the host*
  is technically fine but abandons the compose deployment model and reintroduces "install Node correctly
  on three operating systems" as a support burden. *`docker cp`* avoids paths too but cannot give `/job`
  a kernel-enforced read-only mount, which `INT-CONTAINER-JOB-INPUTS` depends on — it is the viable
  fallback, not the default.
  **Two constraints are not optional.** The volume must be **plain**: a "parameterized" named volume that
  is a disguised bind (`driver_opts: {type: local, o: bind, device: …}`) mis-concatenates the subpath into
  the mount options and fails. And the subpath **must already exist inside the volume** before the
  container starts — there is no auto-create; the worker creates `workspace/` and `job/` as job prep.
  The socket makes the **worker** the root-equivalent asset — not the agent, which never receives it. That
  residual risk is supply-chain, not injection (worker code never reads issue text, per
  `CONST-ISSUE-TEXT-IS-DATA`), and the socket proxy bounds it: allowlist `CONTAINERS`/`IMAGES`/`POST`,
  leave `EXEC`, `SECRETS`, `SWARM`, `PLUGINS` denied by default.
- **Evidence (upstream)**: `moby/moby#45687` ("volumes: Implement subpath mount", Engine **26.0.0**;
  symlinks cannot escape the volume base; TOCTOU-protected) · `docker/cli#4331` (CLI flag) ·
  `moby/moby#47842` (subpath **must pre-exist**; fails `lstat …: no such file or directory`) ·
  `moby/moby#47711` (subpath dropped in Swarm; fixed **26.1.0** — hence the ≥26.1.0 floor even though we
  do not use Swarm) · `forums.docker.com/t/volume-subpath-in-docker-compose/143463` (bind-backed named
  volume breaks subpath: `invalid mode: rw,nocopy,tftp`; reproduced on 26.0.1–27.1.2) ·
  Docker Desktop FAQ: *"Mac and Windows WSL 2 users can connect via Unix socket at
  `unix:///var/run/docker.sock`"* · `Tecnativa/docker-socket-proxy` README (per-API-section allowlist;
  `POST`/`AUTH`/`SECRETS` revoked by default)
- **Rejected** *(at the time of this superseded entry)*: same-path bind mount (breaks on native Windows) ·
  worker-on-host — **this rejection was itself reversed by `DES-WORKER-ON-HOST`**, which found that
  local-folder jobs make a host bind mount unavoidable and that the containerised alternative pins moving
  path math · `docker cp` (cannot enforce read-only `/job`; kept as fallback)
- **Open**: `readonly` combined with `volume-subpath` is documented as an orthogonal field but **no worked
  example was found combining them** — smoke-test it in CI before relying on it, because
  `INT-CONTAINER-JOB-INPUTS` is a security boundary, not a convenience. Likewise `--rm` is believed not to
  touch named volumes (it removes only *anonymous* ones) — inferred, not verified.
- **Traces to**: `INT-CONTAINER-JOB-INPUTS`, `INT-CONTAINER-RUNTIME-CONTRACT`,
  `CONST-ISOLATION-CONTAINER-PER-JOB`

## DES-PANEL-SEPARATE-FROM-RECEIVER

- **Status**: **SUPERSEDED by `DES-ADMIN-VIA-PI-EXTENSION`.** The port-separation reasoning below was
  correct for a **networked** admin panel — the panel and the internet-facing receiver have opposite
  reachability requirements and cannot share a port — but the successor removes the network surface
  entirely: the admin surface is a pi extension in the operator's own session, binding no port at all.
  Kept in place because IDs are permanent and inbound `Traces to` references remain valid.
- **Decision**: The admin panel is a **separate process on a separate port**, binding `127.0.0.1` by
  default. Bull Board mounts on the panel. The receiver carries **no** dashboard and no admin surface.
- **Why**: The panel sets the model, the budgets, and what the agent is told to do — it is the most
  dangerous surface in the system, and a compromise of it is a compromise of everything downstream of it.
  The receiver is the one process that **must** bind `0.0.0.0`, because GitHub has to POST to it from the
  internet. **Mounting the panel on the receiver therefore publishes the admin surface to the internet**
  — the two processes have exactly opposite reachability requirements, so they cannot share a port.
  This is a **correction**: the source design document mounted Bull Board on the receiver behind basic
  auth. That was defensible when the dashboard was read-only; it is not once the same surface can change
  the model and rewrite flows. Basic auth on a public port is not the control that should stand between
  the internet and "edit the agent's instructions".
  Note the deliberate asymmetry with `DES-BUILD-NOT-EXTEND-PI-ROUTINES`, which criticises that project
  for hard-binding `127.0.0.1`. That criticism was of a **webhook trigger endpoint**, which is useless if
  unreachable. For an **admin panel** the same bind is correct. The lesson is that reachability is a
  per-surface decision, not a project-wide default — which is exactly why they are different processes.
- **Rejected**:
  - *Panel mounted on the receiver behind basic auth* — publishes admin to the internet; see above.
  - *Panel on the same process, different port* — one crash, one dependency upgrade, or one unhandled
    rejection takes down webhook ingress with the admin UI. The wait-list should not depend on the UI.
- **Traces to**: `CONST-TRIGGER-AUTHOR-GATE`, `CONST-BUDGET-BEFORE-TOKENS`, `REQ-JOB-STATUS-COMMENTS`

## DES-ADMIN-VIA-PI-EXTENSION

- **Decision**: The admin surface is a **pi extension** shipped in an `admin/` workspace, loaded into the
  operator's own interactive pi session (via `-e`, `~/.pi/agent/extensions`, or a trust-gated
  `.pi/extensions`). It provides operator-only slash commands
  (`/dispatch status|pause|resume|runs|logs|budget|triggers|settings|set|unset`) and one
  self-refreshing TUI overlay component with **four in-component views**: **LIST** — a framed,
  **theme-colored** panel (color via pi's injected `Theme`, applied post-layout so pi's ANSI-aware
  `visibleWidth` still frames it) carrying a status header, day/week/month **SPEND meters** (colored by the
  same `windowState` the worker enforces) plus a daily **token** counter, a unified **TRIGGERS** pane whose
  `{on, run}` rows are **selectable and editable**, and an interactive runs list — all navigated with `↑↓`;
  **TRIGGER_DETAIL** — Enter on a trigger opens its filter and a per-kind **trust model** (who authorizes it,
  how it dedups, which service owns it), with `e` edit-flow / `x` delete; **RUN_DETAIL** — a drill-in dump of
  the selected run's PII-free `.json` run-record fields; and **LIVE_TAIL** — a view that tails a running
  job's `.log` **inside the overlay** through an injected `deps.tailLog` seam whose `fs` read lives in
  `index.ts` (the log CONTENT stays `clip`-stripped and uncolored — only the chrome is themed). The
  LLM-callable tools are reads (`status`/`runs`/`triggers`), `pause`/`resume`, the gated `dispatch_run`
  enqueue, and the **confirm-gated writes** `dispatch_set` and `dispatch_trigger_add`/`_edit`/`_delete`. A
  write can be **operator-typed** (`ctx.ui` `select`/`input`/`confirm` dialogs from the overlay, or a
  `/dispatch set` command) **or model-initiated but operator-approved**: a write tool routes through
  `confirmedWrite`, which applies the change only after the operator approves a `ctx.ui.confirm` showing the
  concrete before/after, and **refuses — writing nothing — when no interactive operator is present**
  (`ctx.hasUI` false). The model emits the call; the human answers the confirm. Both paths reach the same
  `writeTriggers`/`writeSettings` (validated by the shared `parseTriggers`/`writeOverlay`, atomic tmp+rename,
  fail-closed) and both services **live-reload** `triggers.json`/`settings.json`, so a change takes effect
  without a restart (`OQ-008`), keeping the running config on an invalid edit. The extension also ships an
  `operate-pi-dispatch` skill (advertised via the `resources_discover` event) that recommends how to use
  those human confirm gates. The extension talks to the same Valkey
  (`VALKEY_URL`) and reads the run-history sidecar files; it **binds no network port at all**. Bull Board
  is dropped.
- **Why**:
  - **The receiver still carries no admin surface — ever.** The superseded panel narrowed that surface to
    a `127.0.0.1` bind; a surface with **no port at all** is strictly narrower still. Nothing reachable
    from the network gained a control here — it lost one.
  - **Reconciliation with the amended `CONST-ISOLATION-CONTAINER-PER-JOB`.** pi **does** run on the host
    here, as the operator's own interactive tool — which the amended constraint scopes out: this session
    is not a harness invocation, processes no adversarial input, is operator-present, and holds no harness
    credentials. This mirrors `DES-WORKER-ON-HOST`'s "isolation is unaffected" reasoning and clears the
    higher bar explicitly rather than by omission — the harness still never invokes pi on the host, and
    `.claude/rules/agent-isolation.md`'s `no-pi-outside-container` targets `receiver`/`worker`/`image`
    paths, none of which the `admin/` extension is, so that rule is untouched.
  - **The asymmetry with `DES-TRIGGER-OUTSIDE-PI`.** That entry rejects a pi-extension *trigger* because
    a session-bound lifetime contradicts an always-on trigger. The admin surface has the opposite lifetime
    requirement: it is useful only while the operator is present, so a session-bound lifetime is correct
    for it and disqualifying for a trigger. Reachability, and now lifetime, are per-surface decisions.
  - **The injection boundary holds by placement, not by filtering.** Raw container `.log` output is
    untrusted agent-adjacent text and **never enters LLM context** — only the fixed-enum, PII-free `.json`
    run records may; the `.log` is overlay-viewer-only. The LIVE_TAIL view **preserves** exactly this
    boundary: the injected `deps.tailLog` seam renders `.log` bytes in-overlay only — never a tool result,
    never model context — and the USED_API surface stays the three pi members, because `tailLog` is an
    internal overlay dependency injected through the existing `custom` seam, not a pi member. This is the
    same structural defence as `CONST-ISSUE-TEXT-IS-DATA`, one layer down: the boundary is where the data
    is placed, not a filter over its content. One residual is named and accepted: a prompt injection in the operator's session
    can invoke `dispatch_pause`/`dispatch_resume`, accepted because the outcome is durable-but-reversible
    and money-safe — neither tool spends tokens nor raises the cap (`CONST-BUDGET-BEFORE-TOKENS`), so the
    worst case is a queue stall the operator observes and undoes.
    A **second residual is named but is NOT money-safe**, and is bounded by structure rather than by
    reversibility: a prompt injection in the operator's session can invoke **`dispatch_run`**, which
    enqueues a **paid** run that edits a folder in place with no undo. This **supersedes the Decision's
    "reads plus `pause`/`resume` only" categorical** — `dispatch_run` is a **third** model-callable tool,
    an enqueue, admitted under `DES-AI-TRIGGER-FLOW-GATE` and its companion requirement (the
    `requirements.md` amendment lands in a sibling task). `dispatch_run` still takes no spend knobs. The
    injected call is bounded by six independent limits, not by
    undo: (1) the operator-preconfigured **folder allowlist** (`PI_DISPATCH_RUN_ROOTS`, realpath +
    containment) — the tool can fire only inside folders the operator chose; (2) the **per-flow committed
    opt-in** (default deny, read at a pre-agent SHA, `DES-AI-TRIGGER-FLOW-GATE`); (3) the final
    **dirty-tree refusal** — the tool has no force option (`DES-CLI-TRIGGER-FOR-LOCAL`); (4) **no spend-knob
    params on the tool** — `model`, `maxTurns`, `dailyCap`, and `concurrency` are **not** tool arguments;
    they resolve from the overlay/env per `DES-RUNTIME-SETTINGS-FILE-OVERLAY`, so an injected call cannot
    widen per-job spend; (5) a **per-hour rate limit** on `dispatch_run`; and (6) the **daily cap**
    (`CONST-BUDGET-BEFORE-TOKENS`), the ultimate money bound, resolved consumer-side in the processor. The
    money-safe framing therefore applies only to `dispatch_pause`/`dispatch_resume`, not to `dispatch_run`.
    A **third residual is named and bounded by a human confirm, not by structure**: the model-callable write
    tools `dispatch_set` and `dispatch_trigger_add`/`_edit`/`_delete` can change a limit (the daily cap
    included) or add a paid trigger. Each routes through `confirmedWrite`, which **refuses unless the operator
    is present** (`ctx.hasUI`) **and approves a `ctx.ui.confirm` dialog showing the concrete before/after** —
    so a prompt-injected session emits only the *call*; the *approval* is a human keypress it cannot forge,
    and with no interactive UI (print/headless) the write is refused, not silently applied. This is the same
    human-approval gate the operator-typed `/dispatch set` and overlay CRUD already were; it does not weaken
    `CONST-BUDGET-BEFORE-TOKENS` (the cap is still checked before tokens — only its *value* changes, under an
    operator confirm, exactly as a typed `set` would) or `CONST-TRIGGER-AUTHOR-GATE` (whose webhook
    author-gating is untouched; the confirm is the human approval for a locally-configured trigger). The
    residual that remains is an inattentive operator rubber-stamping a confirm; the dialog defaults to deny
    and shows the concrete change to make that a deliberate act, and the `operate-pi-dispatch` skill tells the
    model to state the change plainly and to accept a decline rather than retry it. Strictly, tool absence was
    safer than a confirm — that trade is taken deliberately to make the surface AI-operable, and the write
    tools are `sequential` so two writes cannot interleave.
  - **The operator's pi version is uncontrolled**, so the extension runs a **load-time capability probe**
    of the exact API surface it uses and, on any miss, registers **nothing** — all-or-nothing rather than
    half-loading. The supported version is the pin, `0.80.7` (`CONST-PI-VERSION-PINNED`). Residual risk,
    named: an operator on a divergent pi version gets no admin surface and falls back to direct Valkey and
    file inspection, rather than a silently degraded one.
- **Rejected**:
  - *The web panel + Bull Board* — an entire localhost web app for a solo, terminal-native operator. The
    superseded `DES-PANEL-SEPARATE-FROM-RECEIVER` holds the full original reasoning; it was correct for a
    networked panel and is removed because the network surface is removed.
  - *Mounting admin on the receiver* — unchanged rejection: the receiver must bind `0.0.0.0`, so any admin
    surface on it is published to the internet.
  - *The extension spawning pi as a subprocess* — would violate `no-pi-outside-container` and the amended
    constraint's harness-invocation scope. The extension runs *inside* the operator's session; it does not
    launch an agent.
- **Evidence (upstream)**: read from the **published pinned artifact** `@earendil-works/pi-coding-agent@0.80.7`
  (npm), **not HEAD** — `dist/core/extensions/types.d.ts` (`registerCommand` :876, `registerTool` :874,
  `ExtensionUIContext.custom` :116-126) · `docs/extensions.md` (extension commands run without model
  involvement; loading via `-e` / `~/.pi/agent/extensions` / trust-gated `.pi/extensions`) ·
  `examples/extensions/` (doom-overlay, an interactive TUI overlay; the with-deps example resolves its own
  `node_modules` via jiti). The load-time capability probe exists precisely because these are asserted
  against the pin, not against a moving HEAD.
- **Traces to**: `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-BUDGET-BEFORE-TOKENS`,
  `CONST-ISSUE-TEXT-IS-DATA`, `DES-RUNTIME-SETTINGS-FILE-OVERLAY`, `DES-AI-TRIGGER-FLOW-GATE`,
  `DES-JOB-OUTBOX-CHAINING`, `REQ-DURABLE-RUN-HISTORY`

## DES-RUNTIME-SETTINGS-FILE-OVERLAY

- **Decision**: Runtime-tunable settings are a flat `settings.json` **overlay** — path `PI_SETTINGS_FILE`,
  default `<OS temp>/pi-dispatch/settings.json` — written **atomically** (tmp + rename) by the admin
  extension and **re-read by the worker at each job start**. The keys are exactly `model`, `provider`
  (non-empty strings), `maxTurns`, `dailyCap`, `weeklyCap`, `monthlyCap` (int ≥1), `concurrency` (int 1–10),
  and `softHoldPct` (int 1–99). `weeklyCap`/`monthlyCap`/`softHoldPct` are optional ceilings/band that
  default to **disabled** when unset (the mandatory daily cap is always the primary bound —
  `REQ-SPEND-CAPS-MULTI-WINDOW`). Resolution precedence is **`job.data > overlay > env > default`**;
  producers stop baking env defaults into job data, so an unset job field falls through to the overlay
  rather than to a value frozen at enqueue time.
- **Why**:
  - **Per-job re-read needs no watcher and no IPC.** The worker already opens each job in its processor;
    reading one small file there costs a `stat` + parse and removes any need for `fs.watch`, a pub/sub
    channel, or a reload signal between the extension and the worker.
  - **`CONST-BUDGET-BEFORE-TOKENS` is untouched.** The cap is resolved at the **existing** check point —
    in the processor, before the container starts — so the overlay changes *which value* the cap takes,
    never *when* it is checked. The ordering that is the mechanism stays exactly where it was.
  - **Fail-closed on a present-but-invalid file.** A settings file that exists but does not parse, or
    violates the key contract, **refuses the job start** with policy reason `settings-overlay-invalid`,
    **before `reserveBudget`**, so it burns no budget slot. Fail-open would fall back to env and could
    silently **restore a higher daily cap** than the operator last set — money fails closed, matching the
    `config.mjs` posture where a cap of `0` fails closed rather than meaning "unlimited".
  - **The overlay may never carry persona or hard rules.** It tunes task/config knobs only; the immutable
    rules stay baked. This is the `DES-FLOWS-ARE-DATA-PERSONA-IS-CODE` boundary applied to settings:
    mutable = task/config tuning, immutable = hard rules, and the split falls on the risk, not on the
    filesystem. This bar is on **this admin-editable runtime channel** — the one an admin-surface compromise
    can bend. It does not constrain deploy-time operator config: the global pi overlay
    (`DES-OPERATOR-GLOBAL-OVERLAY`) *may* carry a persona layer, because it is operator-authored `:ro` config
    at the same trust level as baking, not a runtime-mutable knob.
  - **A file, not Redis**, so the live configuration is inspectable, hand-editable with an editor,
    survives a Valkey flush, and does not become a second opaque state store. The shared-filesystem
    assumption it relies on is true by construction: `DES-WORKER-ON-HOST` puts the worker and the admin
    extension on one box.
- **Rejected**:
  - *Redis-resident settings* — matches the `queue.pause()` precedent but is opaque, dies with a Valkey
    flush, and both issue #5 and the maintainer decision specify a file.
  - *`fs.watch` / pub-sub hot-reload* — more moving parts for a job cadence measured in minutes.
    `concurrency` is the one key a live reload would help, and it takes effect at the next pickup anyway —
    a named limitation, not a defect.
  - *Per-message env mutation* — configuration is boot-only by design for identity keys (`valkeyUrl`,
    `jobImage`, auth); those stay env-only and out of the overlay.
    **Still rejected, and `run.image` is not an exception to it** (`DES-PER-TRIGGER-JOB-IMAGE`). A trigger
    may name its own job image, but `image` is **not** an overlay key, `dispatch_set` cannot set one, and the
    key list is **unchanged**. The two are different trust classes, and this entry already says which one it
    bounds: this overlay is the **admin-editable runtime** channel — the one an admin-surface compromise or a
    prompt injection in the operator's session can bend, which is exactly why the *"may never carry persona
    or hard rules"* bar above is scoped to it and explicitly not to deploy-time operator config.
    `triggers.json` is the other kind: operator-authored, reviewed, diffable, git-trackable, in the trust
    class `REQ-GLOBAL-PI-OVERLAY` names as *"operator deploy-time config — the same trust class as baking the
    image"*. Naming an image there **is literally that act**, per flow instead of per deployment.
    `PI_JOB_IMAGE` survives unchanged as the deployment default and stays env-only. What moved is that a
    **reviewed file** may override it per trigger; not that a **runtime knob** may.
- **Traces to**: `CONST-BUDGET-BEFORE-TOKENS`, `DES-ADMIN-VIA-PI-EXTENSION`,
  `DES-FLOWS-ARE-DATA-PERSONA-IS-CODE`, `DES-WORKER-ON-HOST`

## DES-AI-TRIGGER-FLOW-GATE

- **Decision**: A flow is **AI-triggerable only if** its `.pi/skills/<flow>/SKILL.md` YAML frontmatter
  carries **`ai-trigger: allow`**, read from the **git object store at the SHA the job was prepared from** —
  the SHA captured **before** the in-container agent runs, and **never** any commit the agent authors
  during its run. Default deny: absent frontmatter, an absent key, any other value, or a flowless AI
  trigger is **refused**. This gate governs both AI-triggered producers — the admin `dispatch_run`
  tool/command (`DES-ADMIN-VIA-PI-EXTENSION`) and the worker's outbox collector
  (`DES-JOB-OUTBOX-CHAINING`). The operator-typed CLI (`DES-CLI-TRIGGER-FOR-LOCAL`) is not model-callable
  and is not gated by this opt-in.
- **Why**:
  - **The SHA is pre-agent and agent-uninfluenceable — this is the load-bearing property.** The opt-in is
    read from the object store at the commit the job was prepared from, fixed before the agent starts, so
    an agent **cannot self-authorize by committing its own `SKILL.md`**: any `ai-trigger: allow` the agent
    writes lands in a commit later than the pinned SHA and is never consulted for that job. Reading
    committed, reviewed content at a pinned SHA rather than the working tree is the **same trust doctrine**
    as `CONST-NO-CONTEXT-FILES-MANDATORY` (which, as amended, admits merge-gated repo files precisely
    *because* they are merge-gated — and still reads them at a fixed SHA, never from the live tree) and
    `DES-PERSONA-VIA-APPEND-SYSTEM-MD` (the persona is baked, not taken from the working tree), applied
    one layer down to the trigger opt-in. Object-store reads are also **symlink-safe**: reading the blob by
    object id (`git cat-file blob <oid>`, blobs only, mode `100644`) mirrors the
    `worker/src/materialize.mjs` blob-only discipline, so an `ai-trigger` frontmatter symlinked at a token
    file cannot escape the tree.
  - **Author-controlled and versioned.** The opt-in lives in the project's committed `.pi/`, reviewed like
    everything else there. Making a flow AI-triggerable is a reviewed commit, not a runtime toggle — the
    same reviewability that keeps flows as reviewed repo markdown (`DES-FLOWS-ARE-DATA-PERSONA-IS-CODE`).
  - **Relationship to `CONST-TRIGGER-AUTHOR-GATE`, stated carefully.** That constraint is
    **webhook/comment-scoped** and governs **WHO** may start a job (on GitHub, only a collaborator can
    apply the allowlisted label; on GitLab that premise is false and the actor's resolved access level is
    the gate instead — `CONST-TRIGGER-AUTHOR-GATE`). It is **unaffected** here. The frontmatter opt-in governs **WHICH** flows a
    model-callable tool may fire — a **different axis, WHAT not WHO**. It is an **additional** local defense,
    justified because the `dispatch_run` tool and the outbox collector are **prompt-injection-reachable**
    where the operator-typed CLI is not. It does **not** "satisfy" or "extend" the author-gate — treating a
    WHAT-gate as a WHO-gate would be a category error; the two are orthogonal axes and both hold.
  - **Default-deny is fail-closed.** An unreadable, absent, or malformed opt-in refuses the trigger rather
    than admitting it. A flow becomes AI-triggerable only by an explicit, committed, reviewed `allow`.
- **Named residuals**:
  - **The enqueue→run TOCTOU window.** The frontmatter is read at prepare time; a later flip between
    enqueue and run is not re-checked for the in-flight job. The window is bounded by the daily cap
    (`CONST-BUDGET-BEFORE-TOKENS`) and by both producers being **host-trusted** — the operator
    (`dispatch_run`) or the worker (outbox), not the adversarial container.
  - **A local agent can commit `ai-trigger: allow`.** An agent that can write a folder can commit the
    opt-in to it, after which a **later** operator or CLI action could run that flow. This is bounded by the
    local trust model — "whatever can write the folder can trigger it" (`SECURITY.md`) — and is not a
    self-authorization within the same job, which the pre-agent SHA forecloses.
- **Rejected**: reading the **working tree** rather than the object store — it reintroduces exactly the two
  holes the pinned-SHA read closes: an agent self-opening the gate by writing `SKILL.md` mid-run, and a
  symlink bypass that a blob-only object-store read cannot follow.
- **Traces to**: `CONST-TRIGGER-AUTHOR-GATE`, `CONST-NO-CONTEXT-FILES-MANDATORY`,
  `CONST-BUDGET-BEFORE-TOKENS`, `DES-ADMIN-VIA-PI-EXTENSION`

## DES-JOB-OUTBOX-CHAINING

- **Decision**: An agent inside a local job requests follow-up flows by writing `request-<n>.json` to a
  read-write **`/outbox`** mount. The **worker is the only enqueuer**: it collects `/outbox` **only after a
  completed container exit** and enqueues **ordinary local jobs** (`enqueueLocalJob`, the same producer
  path as the CLI). The container never enqueues and never learns the queue exists.
- **Why**:
  - **Containers stay queue-blind.** No `VALKEY_URL` — or any queue credential — **ever** crosses the
    container boundary (`CONST-ISOLATION-CONTAINER-PER-JOB` preserved). The `/outbox` file is the
    container's **only** signal channel back to the host; being agent-authored it is **untrusted** and is
    validated host-side before anything is enqueued.
  - **The outbox host dir is NOT under `/workspace`.** It is a **separate per-job mount**, so agent-authored
    task text is never swept into the operator's folder, committed, or pushed to a PR branch — the same
    property `no-token-in-agent-reachable-file` protects for credentials, here keeping the operator's tree
    clear of agent-authored request data.
  - **Completed-only collection.** `/outbox` is read **only** on a completed container exit. A **policy**
    parent — the agent concluded "can't", a worker-side abort, or an over-budget refusal — spawns **no**
    paid follow-ups, and an **infra-thrown** parent is retried (`CONST-RETRY-INFRA-ONLY`); collecting at any
    other point would **double-chain across attempts**.
  - **Control-vs-data split.** Structured fields are **allowlist-validated**: the flow name is checked
    against the skill charset **and** the frontmatter gate (`DES-AI-TRIGGER-FLOW-GATE`), and the child
    folder is **forced to the parent's own folder** — the outbox `folder` field is **ignored** — so this
    slice is **same-folder-only**, with no arbitrary host-path mount. The freeform **task text is DATA**: it
    lands in the child's `prompt.md`, never as instructions to the harness (`CONST-ISSUE-TEXT-IS-DATA`, one
    layer down — the same payload-subset discipline the receiver applies to issue text).
  - **Forge-parent outboxes are dropped.** A forge job is driven by adversarial issue text, so **no
    `/outbox` mount is created for any forge kind** (`github`, `gitlab`) — an untrusted issue author cannot chain. This is a
    deliberate **deferral**, recorded inline here; the open-questions register row is a sibling task's job.
  - **Budget is unchanged.** Chained jobs are ordinary local jobs; they pass `reserveBudget` consumer-side
    in the processor before `runContainer` (`CONST-BUDGET-BEFORE-TOKENS`). The depth/count caps
    (`PI_CHAIN_DEPTH_MAX=1`, `PI_CHAIN_MAX_PER_JOB=2`) and the `dispatch_run` per-hour rate limit are
    **additional producer-side** bounds, never a substitute for the consumer-side cap.
  - **Retry-idempotent child ids.** A child job id is derived from the **parent id plus a content hash** of
    the request, so a retried parent re-enqueues **identical** ids and BullMQ dedups them — a retry cannot
    fan out duplicate follow-ups (the `REQ-DEDUP-BY-DELIVERY-GUID` dedup property, applied to chaining).
  - **Chain depth is host-computed.** Depth is `parent.chainDepth + 1`, computed on the host, **never read
    from the outbox**, so the container cannot forge a shallow depth to evade the cap.
  - **The agent learns the protocol from a baked persona file.** `guardrails/OUTBOX_PROTOCOL.md` is baked
    into the image immutable (`chmod a-w`, alongside `HARD_RULES.md`) and composed into
    `appendSystemPromptOverride` **only when `/outbox` exists** — so a `kind:github` job, which has no mount,
    is never billed for it, and the compose is evaluated **once** at loader build so the prompt is
    byte-identical across turns (`CONST-PERSONA-IN-CACHED-PREFIX`). It is a **separate file, not folded into
    `HARD_RULES.md`**, whose charter is the always-billed safety floor. The persona is **documentation**: it
    describes the request channel, while the caps and the `ai-trigger` gate are host-enforced after the agent
    exits — the text controls nothing, so it can neither promise a confirmation the host does not give nor
    widen what the host will honor.
- **Rejected**:
  - **`VALKEY_URL` into the container** — an env-allowlist **BLOCKER** (`no-host-env-passthrough`): it hands
    the adversarial side a producer credential, collapsing every enqueue gate at once.
  - **A host HTTP broker** — a new network surface, exactly what the port-less admin design
    (`DES-ADMIN-VIA-PI-EXTENSION`) deliberately removed; the same reasoning applies symmetrically, so the
    signal channel is a file mount, not a socket.
- **Traces to**: `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-BUDGET-BEFORE-TOKENS`,
  `CONST-ISSUE-TEXT-IS-DATA`, `DES-WORKER-ON-HOST`, `DES-CLI-TRIGGER-FOR-LOCAL`, `DES-AI-TRIGGER-FLOW-GATE`

## DES-FLOWS-ARE-DATA-PERSONA-IS-CODE

- **Decision**: Split the agent's instructions by mutability. **The persona is baked into the image** and
  carries the *hard rules* — never merge, issue text is data, work only in `/workspace`. **Flows are user
  data** in a mounted volume, seeded from repo defaults on first run, and carry the *task recipe* —
  screenshot, iterate, open a PR. The admin surface may edit flows in principle; it may never touch the
  persona. **Flow display and editing are deferred, out of this slice** — the mutable/immutable split is
  the boundary the design fixes now, for the admin surface to exercise later.
- **Why**: The admin requirement ("set prompts and which flow runs") collides head-on with
  this project's earlier decision to keep flows as reviewed repo markdown — *versioned, reviewable,
  pi-version-proof*. The resolution is not a compromise between the two; it is the observation that
  **those two properties were being asked of one file that was doing two jobs.**
  The rules the agent must not be talked out of need immutability, and `INT-CONTAINER-JOB-INPUTS` already
  mounts `/job` read-only and bakes the persona *precisely* so that a total compromise of `/job` cannot
  reach the system prompt. That same reasoning extends one step: an admin-surface compromise must not
  reach it either. Meanwhile the task recipe is genuinely configuration — the thing an operator
  legitimately wants to tune at 11pm without a rebuild — and gains nothing from being immutable.
  So the security property survives *and* the admin surface can gain real power over flows when editing
  lands, because the boundary now falls where the risk actually changes rather than where the filesystem
  happened to.
  **Accepted cost**: edited flows lose git review and versioning. That is the honest trade for runtime
  editability, and it is bounded — a flow cannot revoke a hard rule, because the hard rules are not in it.
- **Rejected**:
  - *Admin surface edits `flows/` in the repo* — two sources of truth between a git checkout and a running
    system, and the classic "why did my change vanish on redeploy".
  - *Everything baked, admin surface read-only* — satisfies the specs and not the user; a surface that
    cannot change anything is a dashboard.
  - *Everything admin-editable including hard rules* — makes `CONST-MERGE-NEVER-AUTOMATIC` and
    `CONST-ISSUE-TEXT-IS-DATA` runtime-mutable state. They are constitutional precisely because they are
    not negotiable at runtime.
- **Clarification (operator deploy-time overlay)**: "The admin surface may never touch the persona" governs
  the **admin-editable runtime channel** — the settings overlay (`DES-RUNTIME-SETTINGS-FILE-OVERLAY`) — which
  an attacker who reaches the admin surface could bend. It does **not** bar the operator from supplying a
  persona at deploy time. The global pi overlay (`DES-OPERATOR-GLOBAL-OVERLAY`) is operator-authored,
  `:ro`-mounted deploy-time config — the **same trust class as baking `~/.pi/agent/APPEND_SYSTEM.md` into the
  image** — and may carry a persona layer *under* the immutable floor. Mutability, not the persona/flow label,
  is the boundary: the baked `HARD_RULES.md` stays first and unremovable regardless.
- **Traces to**: `CONST-ISSUE-TEXT-IS-DATA`, `CONST-MERGE-NEVER-AUTOMATIC`, `INT-CONTAINER-JOB-INPUTS`,
  `DES-PERSONA-VIA-APPEND-SYSTEM-MD`, `DES-OPERATOR-GLOBAL-OVERLAY`, `DES-PANEL-SEPARATE-FROM-RECEIVER`

## DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY

- **Decision**: Meter token usage **process-wide**, at pi-ai's **module-level api-provider registry** — not
  on an `AgentSession`'s event bus. The runner wraps every registered api id with a `{ streamSimple }` that
  dispatches exactly as compat would and then *observes* the returned stream (`stream.result()` is a
  memoised promise resolved from the terminal event, so awaiting it accounts for a call **without consuming
  it**; the stream object is returned untouched, no proxy, so identity and `instanceof` still work
  downstream). Registration goes **through `modelRegistry.registerProvider`**, so `ModelRegistry.refresh()`
  re-applies it, plus an unref'd re-arm interval and a deterministic `arm()` after `createAgentSession`.
  `options.sessionId` gives the root/other attribution for free. The `subscribe()` per-turn accumulator
  (`attachTokenBudget`) survives as the **fallback**, attached only when the meter could not install, so
  exactly one accumulator is ever live.
- **Why**: The bus is **per instance** and no event carries a session id, so a subagent session an extension
  spawns is invisible to it — a 16-wide fanout registers as roughly **one** turn, and both the cap and the
  run record then understate spend on exactly the most expensive jobs. The registry is the one choke point
  every in-process session funnels through: pi-coding-agent's session calls compat's `streamSimple`, compat
  resolves the provider for `model.api` out of that registry, and root and subagent alike pass through it.
  Metering there counts **calls** rather than turns, which is the honest unit anyway — a turn is a bundle of
  calls whose count we do not control. Two properties fall out for free and are worth naming: per-session
  attribution (so `otherTotal > 0` **is** the evidence of subagent spend), and a **forward brake** that the
  bus could never give — `session.abort()` is voluntary and does not propagate to a child, whereas after a
  breach every subsequent call by any session is answered with a synthetic aborted stream before it reaches
  a provider. The cap stays structurally **lagging** (`OQ-010`) either way; `REQ-JOB-TIMEOUT-30M` is still
  the ultimate backstop.
- **Rejected**:
  - *Keep the `subscribe()`-only meter* — the mechanism this replaces. It is correct about the session it
    subscribed to and blind to every other one, which is the whole defect; it stays as the fallback so a
    job still gets totals when the registry cannot be reached.
  - *`session.getSessionStats()`* — the cumulative as-billed total is **session-scoped**, so it has exactly
    the blind spot the bus has, with the added cost of being a poll rather than a hook.
  - *Parse the provider SSE stream (an `undici` interceptor or a fetch shim)* — would reimplement usage
    extraction for ~30 provider wire formats, break silently whenever one changes a field name, and be
    wrong by construction for any provider that does not go through the intercepted transport. It is also
    the exact reinvention `no-reimplementing-pi` forbids: pi already parses usage and hands it to us.
  - *An `after_provider_response` extension hook* — an extension handler is registered on **an**
    `AgentSession`'s own extension runtime, so it inherits the same per-instance scope that disqualifies
    the bus, and it would place the harness's accounting **inside** the untrusted extension surface the
    meter exists to watch.
  - *Patch or vendor pi* — a monkey-patch of `dist/` turns `CONST-PI-VERSION-PINNED`'s "upgrading is one
    version string" into "upgrading is a fork". The registry is a supported, exported seam; use it.
- **Must handle** (each verified by runtime probe, none by reading source — this is the part that bites):
  - **Two module instances.** pi-ai is installed twice (hoisted, and nested under pi-coding-agent) with
    **separate** module-level registries, and pi-coding-agent uses the nested one. A bare-specifier import
    from runner code binds the hoisted copy and is a **silent no-op** — it registers, reports success, and
    counts nothing — and `import.meta.resolve` reports the wrong path convincingly. Acceptance is decided
    **only** by a mutation probe: register an inert provider through the `ModelRegistry`, then ask the
    candidate module whether it can see it. The probe is never unregistered, because
    `unregisterProvider` → `refresh()` → `resetApiProviders()` would wipe every wrapper.
  - **`resetApiProviders()` wipes the registry.** It is what `AgentSession.reload()` calls, so the meter
    cannot be install-once. Registering through the `ModelRegistry` covers the `refresh()` path (it
    re-applies stored configs); the unref'd interval covers the bare-reset path, which re-applies nothing.
    That leaves a **re-arm gap** — a call landing between a wipe and the next poll is unmetered, and the
    only symptom is a total that reads like a cheap job — so the count of displaced api ids, the number
    armed, and the poll interval are reported at teardown, which is the only evidence such a window existed.
  - **Displacement, in both directions.** An extension may register its own provider for an api id after we
    armed, and `refresh()` re-applies our stored config as a **fresh** object — so a wrapper chain can form
    that `arm()` cannot tell from a third party's override. Wrapped entries are therefore tracked by
    **object identity**, one provider name per api id (so a re-arm upserts rather than piles up), and every
    observed stream is remembered in a `WeakSet` — every link of such a chain hands us the **same** stream
    object, which makes a double count impossible rather than merely unlikely.
  - **Builtin-auth fidelity.** Overriding a builtin api id flips compat's `shouldUseBuiltinModels` to
    false, so compat stops consulting its own model catalog and calls us instead. The wrapper therefore
    reproduces that branch against the catalog loaded as a **sibling of the accepted compat module** (never
    by specifier — that would reopen the two-instance trap): 2 of the 35 builtin providers substitute
    baseUrl placeholders and inject headers in that layer, and bypassing it breaks exactly those. If the
    catalog cannot be loaded the meter degrades to delegating to the registry entry — still metering, and
    correct for the other 33. **Both silent degradations are reported on the install line** rather than
    hidden behind a bare "ok": whether the catalog loaded (and why not), and whether a pre-dispatch brake
    exists at all — the latter alongside whether the job is capped, since an uncapped job has no brake by
    design and `capped` without a brake is the alarm.
- **Traces to**: `REQ-TOKEN-ACCOUNTING-AND-CAPS`, `REQ-RUNNER-TURN-BUDGET`, `CONST-BUDGET-BEFORE-TOKENS`,
  `CONST-PI-VERSION-PINNED`, `INT-SDK-SESSION-OPTIONS`, `INT-RUNNER-EXIT-CODE-PROTOCOL`,
  `INT-RUN-HISTORY-FILE-CONTRACT`, `OQ-010`, `OQ-011`

## DES-OPERATOR-GLOBAL-OVERLAY

- **Decision**: Reuse an operator's existing host `pi` setup across every job through a single **global
  overlay dir** (`PI_GLOBAL_PI_DIR`), bind-mounted `/opt/pi-global:ro` into each container and layered as a
  new trust **tier 2** between the baked floor and the per-repo `.pi/`. It supplies custom models
  (`models.json`), global skills, and a global persona; the runner reads them (models path selection,
  `additionalSkillPaths` with the repo path first, a global persona entry in `appendSystemPromptOverride`).
  A host-side `pi-dispatch import-pi` stages the **credential-free** subset of `~/.pi/agent` and `doctor`
  re-verifies it. Extensions are staged and loaded **by default** — `--no-extensions` is the escape hatch,
  every staged extension is **printed by name**, and `PI_GLOBAL_ALLOW_EXTENSIONS` survives as an opt-OUT
  (`"0"`) — with the admin extension hard-blocked. A runtime **mount**, not a rebuild, so it works with the
  pulled image.
  The overlay carries a fourth thing: **operator-staged pi packages** at `packages/<dir>/`, installed on the
  host by `import-pi --with-packages` from an exact-pinned `pi-packages.json` and handed to the runner as
  `PI_PACKAGES` — absolute container paths, appended **last** to `additionalExtensionPaths`, for every job
  except one whose trigger set `run.packages: false`.
- **Why**: Four trust tiers, each refining but never removing the one above — baked floor (immutable) →
  operator overlay (deploy-time, operator-authored) → per-repo `.pi/` (trusted-by-merge) → adversarial input.
  The overlay sits at the operator's own trust level, which is why it may carry a persona (unlike the
  admin-editable settings overlay) yet must stay `:ro` and credential-free (it rides into an adversarial-input
  container: `CONST-TOKEN-SCOPED-PER-JOB`). Skills are **first-path-wins** in pi, so listing the repo path
  first makes repo skills override global ones — the "project refines global" semantics operators expect.
  **The packages tier is a fifth tier inside tier 2, and it carries gates the overlay's own extensions do
  not.** Overlay extensions are the operator's *own* code, vetted by having been run in their `~/.pi/agent`
  and staged from a printed list, so they load by default and `PI_GLOBAL_ALLOW_EXTENSIONS=0` is the
  opt-out. A staged package is *someone else's* code, so it adds an exact version pin at declaration time,
  an all-or-nothing host-side stage, runner-side path validation, and a **per-trigger** `run.packages`
  switch that no env flag can express — a deployment can run one flow without a package while every other
  flow has it. That per-trigger switch is finer-grained than any env flag on purpose: the decision belongs
  to the capability-consumer, not to the host. It defaults **open** for the same reason the overlay's
  extensions do — the operator pinned and staged the thing deliberately — which makes it a withdrawal
  rather than an arming, and leaves the pin, the stage and the runner's refusal as the gates that still
  refuse by default. Staging happens on the **host** because pi resolves a
  non-`npm:`/`git:` spec as a **local path**, in place, with no install, no network and no writes — which is
  the only shape that loads under `PI_OFFLINE=1` inside a container with adversarial input.
  **The finding, and where it is actually fixed: on the raw load a staged skill beats the repo's.** pi
  builds `skillPaths` as `mergePaths(cliEnabledSkills, additionalSkillPaths)` — the **package-contributed
  paths first**, ours after — and `loadSkills` is first-path-wins, so a package's `deploy` is the one pi
  keeps and the repo's is dropped to a `{type:"collision"}` diagnostic nothing reads. That would **invert**
  `REQ-GLOBAL-PI-OVERLAY`'s documented "repo wins on conflict", and **path order cannot fix it**:
  `additionalSkillPaths` cannot be placed ahead of the package paths. (Ordering *does* work for extensions,
  which is why the package paths are listed last there.)
  **The ordering is pi's; the result is ours.** `DefaultResourceLoaderOptions.skillsOverride` is a declared
  option on the pinned loader, invoked with `{skills, diagnostics}` the moment `loadSkills` returns and
  before the loader stores anything — so precedence is re-imposed on the *result*: any kept skill under a
  package root whose name also exists under `/job/pi/skills` or `/opt/pi-global/skills` is replaced by the
  protected one, protected roots consulted in order so the repo still beats the overlay. The substitute is
  produced by pi's own public `loadSkillsFromDir` with `source: "path"` — the loader that `loadSkills` would
  itself have used — rather than by parsing `SKILL.md` here, which would be a second, divergent reader of a
  format we do not own. This is not a workaround for a missing lever; **it is the lever**, and using it is
  what makes the requirement true rather than merely asserted.
  **So a name collision is reported, not refused.** An earlier draft of this entry refused the job on the
  grounds that there was no reordering lever; that premise was **false**, and refusing a conflict we have
  already resolved the documented way would have cost an operator a run for nothing. What survives is the
  *visibility* half: pi's unmodified collision diagnostic is read after load and logged (the winning root,
  never a file path), because a package whose flow was written against a procedure that is not the one now
  running may quietly do less than it claims — and the operator should learn that from a log line rather
  than from behaviour. That detector doubles as the tripwire on the pin: a future pi that reorders
  `skillPaths` so the repo already wins makes it go quiet at exactly the moment the override becomes a
  no-op.
- **Rejected**:
  - *Copy `~/.pi` wholesale* — drags `auth.json` and MCP-credentialed extensions into the box. The curated
    subset is the point: what reaches a job should be a list someone chose and `import-pi` printed, not
    whatever accumulated in an operator's home directory.
  - *Bake the overlay into the image* — a per-operator image defeats the pulled prebuilt image; the mount
    delivers the same content without a rebuild.
  - *Keep overlay extensions dormant until a second env flag arms them* — **superseded**; this is what
    shipped first and it was the wrong default. The arming flag was a third gate behind two the operator
    had already passed (running the code in their own `~/.pi/agent`, then staging it from a list
    `import-pi` prints), and its failure mode was silent in the expensive direction: an overlay present but
    dormant is a deployment quietly missing the setup its flows were written against, with no error to
    read. It survives inverted, as `PI_GLOBAL_ALLOW_EXTENSIONS=0`. The admin extension must still never be
    among them, and that is enforced by a refusal at stage time rather than by a default.
  - *A separate `/opt/pi-packages:ro` mount for staged packages* — it would buy nothing the overlay does not
    already carry, and it would cost an amendment to `CONST-ISOLATION-CONTAINER-PER-JOB`, whose acceptance
    **enumerates** the mounts a job may see. Widening a constitutional enumeration for zero new capability
    is the wrong trade; `packages/` rides the mount that already exists, and the mount list is unchanged.
  - *A third env flag (`PI_GLOBAL_ALLOW_PACKAGES`) for them* — redundant and coarser than what ships.
    Three gates already refuse by default between an npm package and a job (the exact pin, the
    all-or-nothing host stage, the runner's pre-spend path check), and the per-trigger `run.packages`
    switch is **finer** than any env flag could be: an env flag decides for the whole deployment, which is
    precisely the granularity a third-party-code switch should not have.
  - *Route packages through pi's own `settings.packages`* — that is the supported path for an interactive
    pi, and taking it would mean giving the runner a `SettingsManager` that reads a project file. The
    runner uses `SettingsManager.inMemory()` **deliberately**, so a serviced project's `.pi/settings.json`
    can never override our spend controls (`INT-SDK-SESSION-OPTIONS`); re-opening that to carry a package
    list would trade a real protection for a cosmetic one.
  - *`npm:` sources resolved in-container* — a live network install of third-party code, at agent runtime,
    inside an adversarial-input container, on **every** run, into a writable `~/.pi/agent`. `PI_OFFLINE=1`
    exists to make that branch unreachable rather than merely unused.
- **Traces to**: `REQ-GLOBAL-PI-OVERLAY`, `INT-CONTAINER-RUNTIME-CONTRACT`, `INT-SDK-SESSION-OPTIONS`,
  `INT-PI-PACKAGES-FILE-CONTRACT`, `INT-TRIGGERS-FILE-CONTRACT`, `INT-CONTAINER-JOB-INPUTS`,
  `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-TOKEN-SCOPED-PER-JOB`, `CONST-PI-VERSION-PINNED`,
  `DES-FLOWS-ARE-DATA-PERSONA-IS-CODE`

## DES-PLAYWRIGHT-CLI-NOT-CHROME-DEVTOOLS

- **Decision**: `@playwright/cli` with Chromium bundled in the job image, with
  `PLAYWRIGHT_BROWSERS_PATH` set at **both** build and run.
- **Why**: `@playwright/cli` is headless by default and built for agents, so it works in a container
  with no display server. The `PLAYWRIGHT_BROWSERS_PATH` detail is not incidental — it resolves a direct
  collision between two of our own constraints. Installing Chromium as root at build time puts it in
  `/root/.cache/ms-playwright`; the non-root runtime user that `CONST-ISOLATION-CONTAINER-PER-JOB`
  requires has a different `$HOME` and **cannot see it**. Setting the variable at both stages makes
  install and lookup agree. Note pi-playwright itself has no browser-resolution logic — it delegates
  entirely to standard Playwright resolution — so this is ours to get right.
  **`@playwright/cli` does not install browsers.** Verified from the published tarball: it is a 115-line
  wrapper with `bin: {"playwright-cli": …}` and no browser-fetch code; its own `install` subcommand
  installs *agent skill files*, not binaries. Browsers come from the standard installer —
  `npx playwright install --with-deps chromium`. Note it depends on `playwright@1.62.0-alpha-1783623505000`
  — **an alpha, pinned exactly by the package itself**; treat that as another upstream pin to watch.
  **Chromium must run `--no-sandbox`** — see `INT-CONTAINER-RUNTIME-CONTRACT`. The alternative is
  re-granting `CAP_SYS_ADMIN` or widening seccomp, which trades the container boundary for Chromium's
  internal one against adversarial input. The container is the sandbox.
- **Evidence (upstream)**: `guwidoe/pi-playwright @ 7d3eeeda` — `PLAYWRIGHT_BROWSERS_PATH` appears
  nowhere in the repo; `scripts/pw.js` is a passthrough to `@playwright/cli` ·
  `npm @playwright/cli@0.1.17` — `bin: {"playwright-cli": "playwright-cli.js"}`, deps pin
  `playwright@1.62.0-alpha-1783623505000`; no installer code in the tarball
- **Reference** (no authority): Playwright docs — default Linux browser path `~/.cache/ms-playwright`;
  Chromium sandbox needs custom seccomp (`clone`/`setns`/`unshare`) or `SYS_ADMIN` when non-root;
  Chromium download ~281 MB, with `--only-shell` documented as a smaller headless-only variant (a real
  trade with feature gaps, not a free win — evaluate against `REQ-FRONTEND-VISUAL-VERIFY` before taking).
- **Rejected**: *pi-chrome-dev-tools* — drives the **system Chrome with a persistent profile**. There is
  no system Chrome in the container, and a persistent profile contradicts
  `CONST-ISOLATION-CONTAINER-PER-JOB` directly. It is a desktop tool.
- **Traces to**: `REQ-FRONTEND-VISUAL-VERIFY`, `INT-CONTAINER-RUNTIME-CONTRACT`

---

## DES-SCOPED-PAUSE-VIA-MOVE-TO-DELAYED

- **Decision**: A per-folder/repo scheduled pause (`REQ-SCOPED-PAUSE-WINDOWS`) is enforced by **deferring**
  the job, not dropping it: in the processor, before any spend, `pauseUntilMs(windows, job.data, now)` returns
  the window-end ms for a scope-matching active window, and the worker calls `job.moveToDelayed(end, token)`
  then throws `DelayedError` (BullMQ's own recognise-as-delayed signal). Windows live in a validated
  `pause-windows.json`, boot-loaded fail-loud and live-reloaded through a directory watch — the exact
  `triggers.json` machinery (shared validator, atomic write, keep-last-good-on-bad-edit). The predicate
  `pauseUntilMs` and its timezone helpers are pure and injected-`now` testable; timezones use the built-in
  `Intl` (a one-pass offset correction, DST-correct outside the ~1h transition seam).
- **Why**:
  - **Defer, not drop.** A `{ outcome: "policy" }` return (the existing refusal shape) would *drop* the job —
    fine for over-budget, wrong for "pause then run after": a github issue job has no re-trigger, so dropping
    loses it. `moveToDelayed` keeps the job's identity/dedup (the delivery-GUID jobId), survives restart
    (Redis-persisted delayed set), and **auto-resumes** with no explicit unpause when BullMQ re-picks it.
  - **Not the global pause.** BullMQ's `queue.pause()` is whole-queue, untimed, and has no per-job worker
    hook to scope by folder/repo. The scoped gate is a separate check inside the pickup path; the two compose.
  - **Before `reserveBudget`.** The gate sits first in the processor wrapper — before the kill timer, the
    settings read, and the budget reservation — so a deferred job arms no timer, reserves no slot, and spends
    nothing. Same placement discipline as the branch-protection and token-cap gates; consistent with
    `CONST-BUDGET-BEFORE-TOKENS` (a deferred job is not a job start).
  - **Library-first + no new dependency.** BullMQ owns the delay; `Intl` owns the timezone math. Keyed on
    `job.data.repo` (github) / `job.data.folder` (local) by `job.data.kind`, `"*"` matching all.
- **Traces to**: `REQ-SCOPED-PAUSE-WINDOWS`, `INT-PAUSE-WINDOWS-FILE-CONTRACT`, `CONST-BUDGET-BEFORE-TOKENS`,
  `DES-CRON-VIA-BULLMQ-SCHEDULER` (the live-reload template), `DES-ADMIN-VIA-PI-EXTENSION` (the confirm-gated CRUD)

---

## DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED

- **Decision**: Which transcript a job resumes is **computed from the job**, never looked up. A forge job
  keys on `(repository, head branch)`; a cron job on its scheduler id; everything else resolves no key and
  cold-starts. There is no index, no manifest, and no `sessions.json`.
- **Why**: The issue that asked for this proposed recording the session id and head branch in the run
  record and scanning back for the producing run. That is the obvious design and it is the wrong one here,
  for a reason this file has already settled once: an index is a **query surface**, a query surface is the
  database `DES-RUN-HISTORY-FLAT-FILES-NO-DB` and the `interfaces.md` preamble both refuse, and it would
  arrive as a second retention authority beside the reaper.
  The derived key also buys the safety property the issue asked for separately. "A session must only ever
  be resumable by a job for the same repo and PR" becomes **unrepresentable rather than merely unlikely**:
  the key is built from the base repository and a ref, so there is no expressible way to name another
  repository's transcript, and a fork resolves nothing at all.
  What makes it possible is that the join already exists and nobody had to write it down. An
  issue-triggered job is *told* to push to `pi/issue-<n>`, so the pull request's head ref IS the issue's
  branch, and both sides are host-computable. That single fact is the entire case for a branch-shaped key,
  and it is why `branch.mjs` exists: the prompt and the key must name one string.
- **Rejected**:
  - *An index or manifest mapping jobs to sessions* — the database, refused above. It would also be the
    first cross-record content query in the project.
  - *Keying on the job id* — a new job has a new id; there is nothing to look up.
  - *Keying on the PULL REQUEST number* — the tempting one, and it fails for the reason that matters. The
    number is forge-assigned and **not** attacker-chosen, which is strictly better than a branch name. But
    nothing host-side joins issue `#7` to the pull request `#8` its job opened without **recording** it,
    and recording it is the index. The branch is the only host-computable join, and its name-forgeability
    is the price (`OQ-014`).
  - *`SessionManager.continueRecent`* — it scans a directory and resumes whatever ran last there. One
    call, looks exactly like what this feature wants, and is the cross-author leak in its purest form.
  - *Mounting the shared store into the container* — one job could then read and rewrite every other
    repository's transcripts. Not a weakening of container-per-job but its inversion.
  - *Readable per-key directory names* — a branch ref is attacker-influenced free text, and using it as a
    host path segment moves the whole problem into a validator. Hashing makes traversal unreachable and
    keeps the store listing PII-free by construction, the same property `local:<basename>` gives the run
    record. The cost — an operator cannot eyeball which directory is which — is answered by `keyParts`.
- **Traces to**: `REQ-RESUMABLE-SESSION`, `INT-SESSION-STORE-CONTRACT`, `DES-RUN-HISTORY-FLAT-FILES-NO-DB`;
  implemented in `worker/src/session-key.mjs`.

## DES-SANDBOX-IS-A-FRESH-CONTAINER

- **Decision**: To let an operator inspect what a run built, **retain the run's inputs and start a new
  container**, rather than preserving the original one in any form. The job container stays single-use,
  `--rm`, TTY-less and port-less; `pi-dispatch sandbox <jobId>` launches a second, differently-named
  container from the same image with the same mounts and no credentials
  (`REQ-RESURRECTABLE-SANDBOX`, `INT-SANDBOX-CONTRACT`).
- **Why**: The thing an operator actually wants is *the app running against the files the agent wrote*.
  That needs the image and the workspace — both of which already exist and are already cheap to keep. It
  does not need the original process tree, and every design that tries to keep one trades away a property
  the whole security model rests on. Framing it as "make it reproducible" rather than "make it survive"
  is what keeps the change confined to how long a directory lives.
- **Rejected**:
  - *Keep the job container alive and `docker exec` into it.* A job container with an open operator
    channel is a different security object from the one every isolation flag was chosen for: it is alive
    while adversarial code has run in it, it still holds the minted forge token and the provider key in
    its environment, and `--rm` — the flag that makes leakage between mutually-untrusting issue authors
    structurally impossible rather than merely unlikely — has to go. The convenience is real and it is
    not worth reopening `CONST-ISOLATION-CONTAINER-PER-JOB` for.
  - *A stdin channel to the running agent.* Same objection plus a worse one: it makes the operator an
    input to a session whose prompt already carries untrusted issue text, so the two trust classes meet
    inside a running agent rather than at a boundary.
  - *`docker commit` the container at exit.* This preserves strictly more — installed packages, process
    residue — and costs gigabytes per run to do it. It serves a 5% case that image+workspace already
    serves, and the extra it preserves is mostly the part that should have been in the image. The honest
    version of the contract ("same image, same workspace, fresh processes") is the one that stays cheap.
  - *Publish a port on job containers, gated by config.* An always-available network surface on the
    untrusted side, live for every run, to serve the runs an operator is watching. The publish flag
    exists only on an operator-started sandbox and only while it is up, bound to `127.0.0.1`.
  - *Exempt `pi-sandbox-*` from the boot reaper by editing its filter.* The reaper's `name=pi-job-`
    filter is a substring match, so a **separate namespace** already achieves this with no change to the
    reaper at all. Editing the filter would put the guarantee in the reaper's code; keeping the names
    disjoint puts it in the names, where a test can pin it.
  - *Widen `makeLogReaper` to sweep retained directories too.* Its `.log`/`.json` filter and `logsDir`
    scope are a documented contract, and these directories have a different retention policy, a
    different PII class, and one requirement neither sibling has — asking docker what is live before
    deleting. `session-store.mjs`'s `reapSessions` already set this precedent for the same reasons.
- **Traces to**: `REQ-RESURRECTABLE-SANDBOX`, `CONST-ISOLATION-CONTAINER-PER-JOB`,
  `CONST-TOKEN-SCOPED-PER-JOB`, `INT-SANDBOX-CONTRACT`, `DES-RUN-HISTORY-FLAT-FILES-NO-DB`

## DES-REPLICA-INDEX-REACHES-THE-BRANCH

- **Decision**: Implement replica runs (`REQ-REPLICA-RUNS`) by threading a single host-assigned integer —
  the 1-based `replica` index — through the four layers that would otherwise collapse N attempts into one,
  and **changing nothing else**. The index reaches the BullMQ job id, the semantic dedup key, the minted
  branch, and the prompt. It deliberately does **not** reach the session key, `/job/event.json`, the
  budget, or any container flag.
- **Why**: The layers that prevent this are not obstacles to route around; each is a control someone chose
  and each stays exactly as strong for an unflagged run. The cheapest way to keep that true is to make the
  discriminator **one value with one owner** and let everything keyed off a job id inherit it for free —
  the container name (`index.mjs`), `PI_JOB_ID` (`run-container.mjs`), and the `.log`/`.json` sidecars
  (`run-history.mjs`) all become replica-distinct without being told. The work then reduces to four
  deliberate additions rather than a feature flag threaded through the worker.
- **The branch is the load-bearing one, and `issueBranch` is where it belongs.** `branch.mjs` exists
  because the prompt and the session key must not each spell `pi/issue-${n}` — a second copy would not
  fail, it would key a session on a branch the agent was never told to push to. A replica adds a **third**
  fact to that same argument: `session-key.mjs` calls `issueBranch` with one argument and must keep doing
  so, which is safe **only** because `triggers.mjs` refuses `replicas` beside `resume`. The coupling is
  written into all three files, because it is invisible from any one of them.
- **Where the index deliberately stops.**
  - *Not the session key.* Adding it would be the wrong fix for a problem the refusal already prevents,
    and it would create a second, silently-diverging notion of which transcript a job continues.
  - *Not `/job/event.json`.* That literal is the webhook's own body plus one decision record
    (`INT-CONTAINER-JOB-INPUTS`, `INT-WEBHOOK-PAYLOAD-SUBSET`); an execution knob is not a fact about the
    delivery. The agent learns its index from the prompt, and `PI_JOB_ID` already ends `-r2`.
  - *Not the budget.* N reservations is the honest count (`CONST-BUDGET-BEFORE-TOKENS`).
- **Rejected**:
  - *First-finished-wins with sibling cancellation.* Half a cancelled run has already spent its tokens, so
    the saving is illusory — and it destroys the comparison the feature exists to produce. There is also
    no cancellation machinery to reuse; building one to make the feature worse is a poor trade.
  - *Auto-judging the two pull requests.* A third paid agent, ranking two agents, to save a human one
    diff read. Two pull requests, one human, done.
  - *An asymmetric branch scheme where replica 1 keeps `pi/issue-<n>`.* It reads as an original and a
    copy, which is precisely the framing that makes an operator stop comparing them. Suffixing **every**
    replica costs one string and keeps the pair symmetric; an unflagged run is unaffected either way.
  - *Replicas for `local`/cron triggers.* A local job's `/workspace` IS the operator's folder, bind-mounted
    read-write. Two replicas would edit one working tree with no gate and no undo — the hazard is the
    reason, not the scope of v1 effort.
  - *A `PI_REPLICA` environment variable.* The env allowlist is closed by design
    (`INT-CONTAINER-RUNTIME-CONTRACT`), and nothing inside the container needs to branch on the index: the
    prompt names the branch, and the runner treats every job identically. A variable would be a second
    place for the index to live and a second place for it to disagree with the branch.
  - *A `replica` field in `event.json`.* See above — recorded here as a rejected alternative rather than
    left as an omission, because it is the first thing a reader will propose.
  - *Deriving the cap from `PI_CONCURRENCY` at load.* `parseTriggers` is pure and fs-free and does not read
    the deployment's settings; a literal `3` beside the reason (the default concurrency) is honest and
    reviewable, and the operator who raises concurrency can raise it in the same commit.
- **Traces to**: `REQ-REPLICA-RUNS`, `REQ-DEDUP-BY-DELIVERY-GUID`, `REQ-RESUMABLE-SESSION`,
  `CONST-BUDGET-BEFORE-TOKENS`, `DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED`, `INT-TRIGGERS-FILE-CONTRACT`,
  `INT-CONTAINER-JOB-INPUTS`, `INT-CONTAINER-RUNTIME-CONTRACT`, `OQ-017`

## Rejected alternatives (whole-project)

Considered and declined. Recorded so they are not re-proposed.

- **Claude Code GitHub Action** — MIT, ~8.4k stars, GA. Already does this trigger spec: `issues:
  [opened, assigned, labeled]` with a dedicated label trigger, `issue_comment`, cron, and skill
  invocation from a prompt. **It remains the honest 90%-for-10%-effort fallback and the README says so.**
  Declined because it ties execution to GitHub-hosted runners and their minutes, gives less control over
  the browser environment and model choice, and — the actual point — this project is about running *pi*.
  Note it validates every pattern here, including having no queue of its own.
- **OpenHands resolver** — a second proof of the label-trigger pattern (`fix-me` label → agent attempts
  the issue). Different agent; documented reliability issues.
- **GitHub Actions + a self-hosted runner invoking pi headlessly** — genuinely attractive: GitHub absorbs
  the burst, our hardware runs the work, zero queue infrastructure. A legitimate v2 direction. Declined
  for v1 because webhook→BullMQ is easier to debug than runner plumbing, and because the queue semantics
  we want (priorities, budget cap, dashboard, dedup) are exactly what Actions does not give.
- **`pi-harness`** (`zosmaai/openzosma`) — the closest prior art: *"the top-level harness for the Pi
  ecosystem… run pi-coding-agent headlessly as a background HTTP/SSE server."* It solves the
  run-pi-headlessly half and nothing else — no triggers, no queue, no container-per-job. It is a server;
  this is a job system. Single publish at 0.1.1 (2026-04-26), no releases since.
- **`pi-sentry`** — an in-process permission/impact gate extension for pi, classifying tool calls
  low/medium/high. Does **not** change `CONST-ISOLATION-CONTAINER-PER-JOB`: it runs inside the agent
  process, custom extension tools execute on the host regardless, and it documents a "YOLO" level that
  bypasses classification. It is a useful interactive UX guard, not a boundary against adversarial
  input.
- **Gondolin micro-VM** — see `CONST-ISOLATION-CONTAINER-PER-JOB`. Routes only built-in tools.

## Repo layout

```
pi-dispatch/
  specs/          ← this directory: the source of truth
  receiver/       # Express webhook ingress. Public edge. No dashboard.
  admin/          # pi-extension admin surface (slash commands + TUI). See DES-ADMIN-VIA-PI-EXTENSION
  worker/         # BullMQ worker, docker orchestration, GitHub token minting
  image/          # Dockerfile + entrypoint + /runner (SDK job runner)
  flows/          # frontend-fix.md, bug-fix.md, triage.md — DEFAULTS, seeded into the data volume
  persona/        # hard rules; baked into the image. Not runtime-editable
  deploy/         # docker-compose runs Valkey only; worker/receiver are host Node processes
                  #   (DES-WORKER-ON-HOST). The systemd unit is a verified-structure per-host template;
                  #   launchd (.plist) and Windows (nssm) units are added as untested examples.
  .env.example    # provider key, spend/concurrency knobs, VALKEY_URL, PI_JOB_IMAGE
  docs/
```

**`flows/`, not `skills/`.** "Skill" already means three different things in this ecosystem: pi's
installable packages (`pi install npm:…`), a package's *registered* skill (pi-playwright's
`playwright-browser`), and our per-label job definitions. Renaming the one we control costs nothing and
removes the ambiguity at its root — the alternative is a glossary that explains a collision we could
simply not have.

**Build order**: image + runner + persona (headless pi proven in isolation) → worker → receiver → flows
→ admin extension → deploy + hardening. The first step is deliberately the one that needs no queue and no GitHub:
it is where the SDK traps in `INT-SDK-SESSION-OPTIONS` live, and they are cheapest to find with nothing
else in the frame.

**Platform**: Windows, macOS and Linux, wherever Docker runs. `docker-compose` is the supported
deployment; the systemd unit is a verified-structure per-host template — its structure statically checked
by `systemd-analyze`, its placeholders unresolved, so it is neither turnkey nor end-to-end tested — and
the launchd (`.plist`) and Windows (nssm) units are added as untested examples. Two consequences are not
incidental and are tracked where they bite: a containerised worker talking to the Docker socket resolves
bind-mount paths in the
*daemon's* namespace, not its own; and a home machine behind NAT cannot receive GitHub webhooks without
a tunnel.

---

## Revision History

| Date | Change |
|---|---|
| 2026-08-01 | Added **`DES-REPLICA-INDEX-REACHES-THE-BRANCH`** (issue #56, `REQ-REPLICA-RUNS`): implement replica runs by threading ONE host-assigned integer through the four layers that collapse N attempts into one — the BullMQ job id, the semantic dedup key, the minted branch, and the prompt — and changing nothing else. The framing is deliberate: those layers are controls someone chose, not obstacles, and each stays exactly as strong for an unflagged run; making the discriminator one value with one owner is what lets the container name, `PI_JOB_ID` and the `.log`/`.json` sidecars become replica-distinct **without being told**. The branch is the load-bearing addition, and it lands in `issueBranch` because that function exists precisely so the prompt and the session key cannot each spell `pi/issue-${n}` — a replica adds a THIRD fact to that argument, namely that `session-key.mjs` calls it with one argument and may keep doing so only because `triggers.mjs` refuses `replicas` beside `resume`. Where the index deliberately STOPS is recorded as decision rather than omission: not the session key (the refusal already prevents the problem, and a second notion of which transcript a job continues would silently diverge), not `event.json` (an execution knob is not a fact about the delivery), not the budget (N reservations is the honest count). Rejected, with reasons: first-finished-wins with sibling cancellation (a half-cancelled run has already spent its tokens, so the saving is illusory and the comparison is destroyed); auto-judging the two pull requests (a third paid agent ranking two agents to save a human one diff read); an asymmetric scheme where replica 1 keeps `pi/issue-<n>` (it reads as an original and a copy, which is the framing that makes an operator stop comparing them); replicas for local/cron triggers (the shared working tree is a hazard, not a scope decision); a `PI_REPLICA` env var (the allowlist is closed by design and nothing in the container branches on the index — it would be a second place for it to disagree with the branch); a `replica` field in `event.json`; and deriving the cap from `PI_CONCURRENCY` at load (`parseTriggers` is pure and fs-free). `DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED` **UNCHANGED, checked**: the key is still derived from what the job carries, and replicas add no index. `DES-JOB-OUTBOX-CHAINING` **UNCHANGED, checked**: the `local`-only guard already bounds fanout from a replica. |
| 2026-08-01 | Added **`DES-SANDBOX-IS-A-FRESH-CONTAINER`** (issue #55, `REQ-RESURRECTABLE-SANDBOX`): to let an operator inspect what a run built, retain the run's inputs and start a **new** container, never preserve the original. Six rejected alternatives recorded, and the first three are the ones that would otherwise be re-proposed — keeping the job container alive for `docker exec`, a stdin channel to the running agent, and `docker commit` snapshots. The first two reopen `CONST-ISOLATION-CONTAINER-PER-JOB` (a live container that has run adversarial code, still holding the minted token, with `--rm` removed); the third costs gigabytes per run to preserve mostly what belonged in the image. The other three are the smaller near-misses that each looked cheaper than the shipped answer and were not: publishing a port on job containers, editing the boot reaper's filter instead of using a disjoint name namespace, and widening `makeLogReaper` instead of adding a sibling. `DES-RUN-HISTORY-FLAT-FILES-NO-DB` **UNCHANGED, and checked** — the sandbox lookup is a filename-keyed read of one directory, adding no index and no query surface. |
| 2026-07-28 | **The pi-normal discovery posture** (`CONST-NO-CONTEXT-FILES-MANDATORY`, amended). `DES-OPERATOR-GLOBAL-OVERLAY`: overlay extensions are staged and loaded **by default** — `--no-extensions` is the escape hatch, every staged extension is **printed by name**, and `PI_GLOBAL_ALLOW_EXTENSIONS` survives inverted as the `"0"` opt-out — and staged packages load for every job except one whose trigger set `run.packages: false`. The "gated four times, not two" framing is restated honestly as **three gates that refuse by default** (exact pin, all-or-nothing host stage, runner pre-spend path check) **plus one withdrawal**, since the per-trigger switch now defaults open. The *Rejected* entry "load overlay extensions by default" is **superseded rather than deleted**: it is rewritten in place to record that this is what shipped first, that the arming flag sat behind two gates the operator had already passed, and that its failure mode was silent in the expensive direction — a present-but-dormant overlay is a deployment quietly missing the setup its flows were written against. The "copy `~/.pi` wholesale" rejection lost its stale justification (it argued host-global discovery was off anyway) and now rests on the curated-subset argument, which is the one that was always doing the work. Two cross-references de-staled elsewhere in the file: `DES-PERSONA-VIA-APPEND-SYSTEM-MD`'s *Rejected* `AGENTS.md` bullet said **"forbidden"** and now records that it loads but is rejected as the *persona channel* on **placement** (pi emits context files into `<project_context>` after the append block, so it can never be the floor); and `DES-AI-TRIGGER-FLOW-GATE`'s trust-doctrine parenthetical, which cited the constraint as "a cloned repo's `AGENTS.md` … must not load", now cites it as amended — the doctrine it was actually appealing to, reading committed content at a **fixed SHA** rather than the live tree, is unchanged. `DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY` was **checked and needed no change**: it asserts nothing about the discovery flags. |
| 2026-07-15 | Initial. Extracted from `DESIGN.md` v0.1 (2026-07-14, local, uncommitted) §2, §3, §4, §5, §9, §11. That document recorded "50 claims adversarially verified: 48 confirmed, 2 refuted" — **verified against documentation**. Source-verification at `earendil-works/pi @ 5e336cf` subsequently corrected ~7 points. `DES-PERSONA-VIA-APPEND-SYSTEM-MD` is materially rewritten: the source doc's decisions #1 and #2 were mutually exclusive as written. `DES-NAME-KEEP-PI-DISPATCH` is new. `pi-harness` and `pi-sentry` were absent from the source doc's alternatives and are added. §5.7's "caches roll at midnight" caveat is **dropped** — 0.80.7 removed the date from the default system prompt. |
| 2026-07-15 | An admin panel and cross-platform (Windows/macOS/Linux + Docker) added to scope. Two new decisions and one **security correction**. `DES-PANEL-SEPARATE-FROM-RECEIVER`: the source doc mounted Bull Board on the receiver — defensible for a read-only dashboard, **not** once the same surface sets the model and rewrites flows, because the receiver is the one process that must be internet-reachable. The panel and the receiver have opposite reachability requirements and cannot share a port. `DES-FLOWS-ARE-DATA-PERSONA-IS-CODE`: the panel requirement collided with keeping flows as reviewed repo markdown; resolved by observing that one file was carrying two jobs — hard rules need immutability, task recipes need editability. Architecture diagram and repo layout updated; the public edge is now drawn explicitly. Build order extended with panel and deploy. |
| 2026-07-16 | **Resolved a spec/code contradiction.** `DES-WORKER-ON-HOST` added and `DES-JOB-FILES-VIA-VOLUME-SUBPATH` marked SUPERSEDED: the worker runs on the host (the `docker` CLI translates host paths, the daemon does not, and the VM prefix moved between Docker Desktop versions; local-folder jobs also *require* a host bind mount a named volume cannot give). The committed spec had rejected worker-on-host while the code already did it -- caught by a spec-conformance scan. `DES-CLI-TRIGGER-FOR-LOCAL` added: the CLI producer was built (user-directed) but unspecified; recorded with the check that `CONST-BUDGET-BEFORE-TOKENS` still holds because the cap is enforced in the processor, not the trigger. Repo-layout `deploy/` line corrected (compose runs Valkey only). |
| 2026-07-21 | Added DES-RUN-HISTORY-FLAT-FILES-NO-DB (flat node:fs sidecar over a DB / BullMQ-query for run history). |
| 2026-07-21 | `DES-ADMIN-VIA-PI-EXTENSION` injection-boundary bullet records the accepted residual: a prompt injection in the operator's session can invoke `dispatch_pause`/`dispatch_resume`, accepted as durable-but-reversible and money-safe (neither tool spends tokens nor raises the cap), so the worst case is an operator-observable, operator-undoable queue stall. |
| 2026-07-21 | `DES-PANEL-SEPARATE-FROM-RECEIVER` superseded by `DES-ADMIN-VIA-PI-EXTENSION`: the admin surface becomes a pi extension in the operator's own interactive session (slash commands + TUI overlay), binding no network port; Bull Board dropped. `DES-RUNTIME-SETTINGS-FILE-OVERLAY` added: a flat `settings.json` overlay (`PI_SETTINGS_FILE`), written atomically by the extension and re-read by the worker per job, precedence `job.data > overlay > env > default`, fail-closed on an invalid file before `reserveBudget`. Panel/dashboard wording cascaded across the architecture diagram, `DES-QUEUE-BULLMQ-OVER-CUSTOM` (four queue mechanisms, dashboard dropped), `DES-CRON-VIA-BULLMQ-SCHEDULER`, `DES-CLI-TRIGGER-FOR-LOCAL`, `DES-WORKER-ON-HOST`, `DES-FLOWS-ARE-DATA-PERSONA-IS-CODE` (flow editing deferred out of this slice), and the repo layout / build order. Paired with `CONST-ISOLATION-CONTAINER-PER-JOB` scoped to harness invocations in `constitution.md`. |
| 2026-07-22 | **AI-triggered flows.** Two new entries: `DES-AI-TRIGGER-FLOW-GATE` (a flow is AI-triggerable only if its `.pi/skills/<flow>/SKILL.md` frontmatter carries `ai-trigger: allow`, read from the git object store at the pre-agent SHA, default deny — an agent cannot self-authorize by committing its own `SKILL.md`) and `DES-JOB-OUTBOX-CHAINING` (an in-container agent writes `request-<n>.json` to a rw `/outbox` mount outside `/workspace`; the worker is the only enqueuer, collecting completed-only and forcing same-folder local jobs, `VALKEY_URL` never crossing the container boundary; GitHub-parent outboxes dropped). Two amendments: `DES-CLI-TRIGGER-FOR-LOCAL` now names **three** producers of local jobs (CLI, `dispatch_run`, outbox collector), retargets its superseded `DES-PANEL-SEPARATE-FROM-RECEIVER` trace to `DES-ADMIN-VIA-PI-EXTENSION`, and states the dirty-guard's same-folder-chain exception; `DES-ADMIN-VIA-PI-EXTENSION` adds a second named injection residual for the paid, not-money-safe `dispatch_run` tool (bounded by folder allowlist, per-flow opt-in, no-force, no spend-knob params, per-hour rate limit, daily cap), superseding the "reads plus pause/resume only" categorical. Reason: local jobs gain two prompt-injection-reachable producers, which need a WHAT-axis opt-in distinct from `CONST-TRIGGER-AUTHOR-GATE`'s WHO-axis webhook gate. Companion `requirements.md`/`interfaces.md`/`open-questions.md` amendments land in sibling tasks. |
| 2026-07-22 | `DES-JOB-OUTBOX-CHAINING` records how the agent learns the outbox protocol: a **separate baked persona file** (`guardrails/OUTBOX_PROTOCOL.md`, immutable `chmod a-w`), composed into `appendSystemPromptOverride` **only when `/outbox` is mounted** (a github job is never billed for it) and evaluated once at loader build per `CONST-PERSONA-IN-CACHED-PREFIX`; kept out of `HARD_RULES.md` (the always-billed safety floor) and framed as documentation — the caps and `ai-trigger` gate are host-enforced, the persona controls nothing. |
| 2026-07-22 | Coherence fix: reworded the `DES-ADMIN-VIA-PI-EXTENSION` `Decision` line — "reads plus `pause`/`resume` only" now reads "reads, `pause`/`resume`, and the gated `dispatch_run` enqueue", resolving the self-contradiction with the same entry's second injection residual (every settings write stays operator-typed). |
| 2026-07-22 | `DES-ADMIN-VIA-PI-EXTENSION` dashboard amended to three in-component views — LIST (framed monochrome panel with unified TRIGGERS pane + `↑↓` runs selection), RUN_DETAIL (PII-free `.json` fields), and LIVE_TAIL — in one self-refreshing overlay. LIVE_TAIL renders raw `.log` bytes through an injected `deps.tailLog` seam whose `fs` read lives in `index.ts`, preserving the overlay-only `.log` boundary (never a tool result, never model context); USED_API stays the three pi members, `tailLog` being an internal `custom`-seam dependency, not a pi member. |
| 2026-07-28 | Issue #58. Added **`DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY`**: token usage is metered at pi-ai's module-level api-provider registry — the one choke point every in-process session shares — instead of on a per-instance `AgentSession` bus that cannot see a subagent fanout, with the `subscribe()` accumulator kept as the fallback. Records the rejected alternatives (the subscribe-only meter, `getSessionStats`, undici/SSE parsing, an `after_provider_response` extension hook, patching pi) and the four things any implementation must handle, all found by runtime probe rather than by reading source: the dual pi-ai module instance, `resetApiProviders()` wiping raw registrations, wrapper displacement in both directions (identity tracking + a `WeakSet` of observed streams), and builtin-auth fidelity through the sibling-loaded fallback catalog. `DES-OPERATOR-GLOBAL-OVERLAY` amended: the overlay gains a **packages tier** (host-staged, exact-pinned, per-trigger armed, appended last to `additionalExtensionPaths`) and records the skill-ordering finding — pi puts package skill paths FIRST and `loadSkills` is first-path-wins, so on the raw load a staged skill beats the repo's, which would invert this entry's own "repo wins on conflict". Path order cannot fix it, but `DefaultResourceLoaderOptions.skillsOverride` (a declared option on the pinned loader, plus the public `loadSkillsFromDir`) can and does: precedence is re-imposed on the loaded result, repo before overlay before package, so the requirement holds by enforcement. **Correction on the way in**: an earlier draft of this row and entry said there was "no reordering lever" and resolved the finding by refusing the job — the premise was false and the refusal is gone; what remains is the collision *report* (visibility, and the tripwire that goes quiet if a future pi reorders `skillPaths`). Four new Rejected entries: a separate `/opt/pi-packages:ro` mount (would amend `CONST-ISOLATION-CONTAINER-PER-JOB`'s enumerated acceptance for no capability the overlay lacks), a third env arming flag (redundant, and coarser than the per-trigger gate), routing packages through pi's `settings.packages` (would re-open the `SettingsManager.inMemory` protection), and `npm:` sources resolved in-container (a live network install of third-party code in an adversarial-input container, every run). |
| 2026-07-23 | `DES-ADMIN-VIA-PI-EXTENSION` amended for **AI-operable, confirm-gated writes**: the model-callable surface gains `dispatch_triggers` (read) and the write tools `dispatch_set` + `dispatch_trigger_add`/`_edit`/`_delete`, each routed through `confirmedWrite` — applied only after an operator approves a `ctx.ui.confirm` showing the concrete before/after, refused (writing nothing) when `ctx.hasUI` is false. Adds a **third named injection residual** bounded by that human confirm rather than by structure; supersedes the "every settings write is operator-typed, never a model tool" clause. Both `CONST-BUDGET-BEFORE-TOKENS` (check-before-tokens ordering) and `CONST-TRIGGER-AUTHOR-GATE` (webhook author-gating) are unchanged — the confirm is the human approval, and both write paths reach the same validated/atomic `writeTriggers`/`writeSettings`. Extension also ships an `operate-pi-dispatch` skill (advertised via `resources_discover`) recommending how to use the gates. `USED_API` gains `on`. Companion `requirements.md`/`constitution.md` amendments land with it. |
| 2026-07-29 | Issue #41. Added **`DES-PER-TRIGGER-JOB-IMAGE`**: the job image resolves per job (`job.image ?? PI_JOB_IMAGE`) from an optional operator-authored `run.image`, present on no model-callable tool, no panel key and not the settings overlay; a missing tag is refused pre-spend by `docker image inspect` and `--pull=never` joins `ISOLATION_FLAGS`. Rejected, with reasons on the record: **`PI_JOB_IMAGE_ALLOWLIST`** (the issue floats it — rejected because there is **nothing model-callable to bound**; `PI_DISPATCH_RUN_ROOTS` exists to bound a **model-supplied** folder, and an allowlist over a field only an operator can write can only refuse the operator's own edit while advertising a threat model this design forecloses — it arrives **with** the first tool that ever takes an image parameter, and that row is why it must); `image` in the runtime settings overlay; an `image` parameter on `dispatch_trigger_add`/`_edit`; **a flow-declared image read from the serviced repo** (the issue's second option — rejected hardest: that file is merge-gated, not operator-authored, and `DES-AI-TRIGGER-FLOW-GATE` takes only a **boolean** from it precisely because an image ref would hand that population the loader flags, the guardrail floor, the pinned pi version and the non-root user); a second mount or a job-time pull; and keeping every toolchain baked into one image. **`DES-RUNTIME-SETTINGS-FILE-OVERLAY` is amended, not reversed**: its *Per-message env mutation* rejection stands verbatim and `image` is **not** an exception to it — the overlay key list is unchanged and `dispatch_set` cannot set an image. The distinction is stated where it was previously only implied: that overlay is the **admin-editable runtime** channel (which is why its "never persona or hard rules" bar is scoped to it), while `triggers.json` is reviewed deploy-time operator config in the trust class `REQ-GLOBAL-PI-OVERLAY` calls *"the same trust class as baking the image"*. **`DES-OPERATOR-GLOBAL-OVERLAY`'s "Bake the overlay into the image" rejection is UNCHANGED and was checked**: nothing that was a mount becomes a bake, the overlay still rides `:ro` into whichever image runs, and the boundary is now written down — overlay = pi *configuration*, mounted, one per deployment; image = the *operating system* a flow needs, built, per flow. |
| 2026-07-29 | Issue #42. Added **`DES-FORGE-IS-A-PER-JOB-DEPENDENCY`**: a job's forge is resolved per job from `job.kind` at exactly one place — a `forges` map of `{ auth, host }` in the worker's composition root — and the four deps that were bound to one forge (`mintToken`, `comment`, `isDefaultBranchProtected`, `prepareWorkspace`) look theirs up from the job. **No abstraction was invented ahead of its second user**: `processor.mjs` already consumed those four as independently injected functions rather than as one `github` object, so it was written against a de-facto interface and merely called it behind `job.kind === "github"` guards; the second forge revealed which *parameters* were wrong — a repo string where a job belonged — not that a new interface was needed. Rejected, with reasons on the record: a generic any-forge plugin framework; **routing by header** (Forgejo emits `X-GitHub-*` on every delivery per #61, so headers cannot tell forges apart — and a request able to select which gate it faced would select the weakest, where a path is chosen by the operator at configuration time and not by the sender at delivery time); negotiating the verification mechanism from the request, for the same reason one layer down; **a filter that does its own membership lookup** (both filters are pure, total and I/O-free, and that is exactly what makes the security-critical decision testable offline — so the lookup runs in the receiver and arrives as a plain number); **adapting GitHub's 404-means-unprotected** (#61 records the cost: every branch reports unprotected and the never-merge backstop is silently disarmed); inferring approval from label-application on GitLab; **forking the clone path** (the askpass helper, hardening flags, gone-SHA markers and pinned detached checkout are git and this project, not GitHub — only the remote URL and the envelope differ, and a second copy is a second place to fix a clone bug); and one shared `postStatusComment(repo, number, …)`, since GitLab's issues and merge requests are separate endpoints AND separate sequences, and a host method that cannot be called uniformly is not a seam. `DES-TRIGGERS-UNIFIED-FILE` amended: the near-diagonal becomes `cron ↔ local`, webhook ↔ a forge. `DES-PR-TRIGGER-ROUTES-TO-FLOW` amended to say its `target` union is the **shared** vocabulary and not GitHub's — a GitLab merge request is a `pull_request` target carrying its `iid`, so the job shape does not fork per forge even though the two forges' nouns differ. `DES-AI-TRIGGER-FLOW-GATE` amended in one parenthetical that carried the broken premise into a WHO/WHAT passage. `DES-JOB-OUTBOX-CHAINING` generalised from `kind:github` to any forge kind — the adversarial-text reasoning was never GitHub-specific. `DES-CRON-VIA-BULLMQ-SCHEDULER` amended in one sentence for the same reason. `DES-OPERATOR-GLOBAL-OVERLAY` and `DES-PER-TRIGGER-JOB-IMAGE` are **UNCHANGED and were checked**: the overlay is a mount and the image is a tag, and neither is a property of which forge triggered the job — a gitlab trigger carries `run.packages` and `run.image` on exactly the same terms as a github one. |
| 2026-07-31 | Issue #48. **NEW `DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED`**: which transcript a job resumes is computed from the job, never looked up. The issue proposed recording the session id and head branch and scanning back for the producing run; that is refused because an index is a query surface and a query surface is the database this file already declined. The derived key also makes the issue's own cross-repo/cross-PR safety ask **unrepresentable rather than merely unlikely**. Six rejected alternatives, and the one worth reading is **keying on the pull-request number** — forge-assigned and NOT attacker-chosen, so strictly better on the axis that matters, and useless anyway because nothing host-side joins issue `#7` to the PR `#8` its job opened without recording it, and recording it is the index. The branch is the only host-computable join; its name-forgeability is the price, paid in `OQ-014`. Also rejected: `SessionManager.continueRecent`, which scans a directory and resumes whatever ran last — one call, looks exactly right, and is the cross-author leak in its purest form. `DES-RUN-HISTORY-FLAT-FILES-NO-DB` **UNCHANGED, and preserved deliberately rather than by luck**: the derived key is *what* preserves it. `DES-JOB-OUTBOX-CHAINING` **UNCHANGED, checked, and the comparison is written down** because a reader who sees a second writable mount on a github job would otherwise conclude `OQ-009` was resolved by the back door: `/outbox` lets a parent nominate host folders and enqueue paid jobs, `/session` returns bytes to one key, creates no job and names no host path. `DES-PR-TRIGGER-ROUTES-TO-FLOW`, `DES-TRIGGERS-UNIFIED-FILE` **UNCHANGED, checked**: no new trigger type and no new route ship here — `run.resume` is a `run.*` field on the four kinds that already exist. |
| 2026-07-31 | Issues #43 + #61. `DES-FORGE-IS-A-PER-JOB-DEPENDENCY` **amended, and its own deferral is what this PR discharged**: its `Rejected` list named #43 and #61 by number as the event a seam should be discovered from. They landed TOGETHER on purpose -- one example cannot show you a seam, and these two are the extremes of the space (Forgejo's transport is byte-identical to GitHub's and all its work is semantic; Azure shares almost nothing) so the shape was sized against both at once. What HELD without change: the `{ auth, host }` pair, the four host methods, and `makeForgePreparers`, where a whole forge arm is five lines and two injections. What did NOT hold was everything written down *elsewhere* -- nine places said which forges exist, and the ones that mattered were the ones that failed **silently**: a missing receiver trigger group throws inside a reload that catches everything and keeps yesterday's rules, so an operator edits their file, sees one message, and the old rules go on firing; a missing token-variable name is simply not refused in `PI_FORWARD_ENV`, so a long-lived host token can be forwarded into every container of every forge. The answer is a TABLE those are derived from (`worker/src/forges.mjs`, which imports nothing so it can be the leaf of both services' graphs), not an interface for a forge to implement -- so the plugin-framework rejection **still stands at four forges**, now on evidence rather than on principle. Added **DES-IMAGE-DECLARES-ITS-FORGES**: `run.image` is optional, and Azure's CLI is ~1 GB of Python that belongs in a separate image variant, so a trigger that forgets `run.image` would fail at step 3 inside a paid container on every delivery. The image declares what it can serve and the pre-spend preflight refuses otherwise -- with the polarity written out, because it is the opposite of what "declare your capabilities" suggests: an **absent** label allows everything, since every operator-built image predating it declares nothing and refusing those would break working deployments with no warning. `DES-TRIGGERS-UNIFIED-FILE` and `DES-PR-TRIGGER-ROUTES-TO-FLOW` **amended**: two more forges in the matrix and the target vocabulary. `DES-RUN-HISTORY-FLAT-FILES-NO-DB`, `DES-JOB-OUTBOX-CHAINING`, `DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED`, `DES-PER-TRIGGER-JOB-IMAGE`, `DES-OPERATOR-GLOBAL-OVERLAY` **UNCHANGED, checked**: no new forge introduces a query surface, a writable mount, or an index. The ASCII architecture diagram and the repo layout at the foot of this file still say "GitHub" where they mean "a forge" -- noted rather than fixed, because they were already stale after #42 and a drive-by rewrite would bury the two entries above. |
