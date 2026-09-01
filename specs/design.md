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

- **Decision**: Keep the name `pi-dispatch`. Do not publish under the **bare npm name** — it is
  taken. Scoped `@edgehero/*` publishing is the sanctioned channel (amended 2026-08-02, issue #80;
  the original Decision line read "Do not publish to npm" unqualified, and practice had already
  diverged: `@edgehero/pi-dispatch-admin` shipped 2026-07 without this entry recording it).
  Published artifacts: `@edgehero/pi-dispatch-admin` (the console), `@edgehero/pi-dispatch` (the
  worker + CLI — the "management CLI" this entry's change trigger named), and
  `@edgehero/pi-dispatch-receiver`. The bin name stays `pi-dispatch`, which shadows nothing locally;
  the README warns that **bare** `npx pi-dispatch` outside a checkout resolves to the unrelated
  squatted package, so docs always use the scoped form.
- **Why**: `pi-dispatch` **is** taken on npm — `pi-dispatch@1.0.3`, a pi *extension* that rotates
  ChatGPT Codex OAuth accounts to maximise quota. It does not bind us: it is functionally unrelated
  (it runs *inside* a pi session; this project runs pi inside *itself*), it was published once on
  2026-04-06 with no release since, and its GitHub repository returns 404. **We do not need the npm
  name** — the *bare* name, that is: scoped `@edgehero/*` names have no collision at all, which is
  what made the 2026-08-02 amendment a scoping of this entry rather than a reversal. GitHub
  namespaces by owner, so there is no conflict there either.
  Recorded because the collision is real and the question will otherwise return every time someone
  searches npm.
- **What would change this**: wanting to publish *any* npm artifact under this name — a management CLI,
  a client library. At that point rename; `pi-foreman` and `pi-onduty` were verified available.
  **The trigger fired** (issue #80: the worker CLI is exactly "a management CLI") and the resolution
  chosen was **scoped publishing, not the rename**: the collision only ever bound the bare name, the
  `@edgehero` scope was already shipping the admin console, and renaming a documented project to route
  around a squatter's dead package is cost without benefit. A *bare-name* artifact would still require
  the rename this entry prescribes.
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
- **Every forge arm is conditional, including GitHub** (amended, issue #99). The receiver mounts a
  forge's route, resolves that forge's own identity for the bot-loop guard, and requires that forge's
  credentials **only when the deployment serves it**. GitHub was the exception: its identity resolution
  and `WEBHOOK_SECRET` were unconditional while the other three arms were already gated, so a
  GitLab-only, Forgejo-only or Azure-only deployment could not boot without `gh` logged in and a webhook
  secret it would never use. The gate is now uniform, and **the coupling is the safety property**:
  skipping identity resolution is sound only because the route is absent too. An unconfigured forge
  answers **404, not 401** — an endpoint that answers is an endpoint an operator can believe is armed —
  and if `/` is ever mounted unconditionally again, the guard must return with it.
- **Evidence (upstream)**: `earendil-works/pi @ 5e336cf → packages/coding-agent/docs/extensions.md`
  (event type union; no external-trigger types)
- **Rejected**: webhook listener inside a pi extension — session-bound lifetime.
- **Traces to**: `REQ-QUEUE-BURST-NO-DROP`, `CONST-HMAC-OVER-RAW-BODY`

## DES-QUEUE-BULLMQ-OVER-CUSTOM

- **Decision**: Redis + BullMQ.
- **Why**: BullMQ supplies priorities, a rate limiter, a dedup window, and stalled-job recovery with a
  retry policy — each of which is an independent requirement here, not a bonus. Building four mechanisms
  to avoid one dependency is precisely how a solo-maintainer project drowns in maintenance. Its Bull
  Board dashboard was a fifth draw; `DES-ADMIN-VIA-PI-EXTENSION` drops the **served** web surface
  entirely (the insights HTML artifact is a static file the operator's own browser opens — nothing serves
  it, nothing listens), so the case now stands on the four queue mechanisms alone. Redis persistence (AOF) is what makes
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
  Since issue #80 the invariant is *enforced* where units are minted: `pi-dispatch service install`
  refuses to install a worker unit when one exists in the other scope (user vs system LaunchAgent/
  LaunchDaemon, `systemctl --user` vs `/etc/systemd/system`) — before this, the paragraph above was the
  only thing standing between an operator and two workers sharing one daemon. `pi-dispatch worker` run
  by hand holds no lock, so the enforcement covers installed units only; two hand-run workers are
  already catastrophic (the second one's reaper kills the first's live containers) and stay unsupported.
- **A second axis since issue #242 — per-SCOPE concurrency, by deferral**: the global knob bounds how
  many jobs run at once; it says nothing about WHERE they run. The pickup gate now also holds an
  in-process in-flight count per scope (`scopeOf`'s folder-or-repo, resolved for local paths): a job
  over its scope's ceiling is deferred through the delayed set on a fixed re-check (`moveToDelayed` +
  `DelayedError`, the pause-gate seam), never refused — a busy scope is transient state
  (`CONST-RETRY-INFRA-ONLY`). Local folders carry a structural ceiling of ONE with no configuration and
  no off-switch (the working-tree race `run.replicas` is already refused for); forge scopes are
  unbounded unless a `scoped-limits.json` row lowers them. The count lives in PROCESS MEMORY
  deliberately, on this entry's own invariant: one worker per daemon means no second process holds
  containers the map cannot see, the boot reaper clears survivors before draining starts (so a fresh
  empty map is never wrong about a live container, except on `reaper_skipped` where no new container
  can start either), and a Redis-held count would survive a crash WRONGLY — a claim for a container the
  reaper just killed, the two-sources-of-truth failure mode `OQ-008` exists to refuse. See
  `DES-SCOPED-LIMITS-AND-FOLDER-MUTEX` for the file, the money windows and the rejected alternatives.
  Issue #57 adds a `host:` keyspace and does NOT reopen this: the object that refusal is about is a
  claim whose truth-maker (a running container) lives on the host while the claim lives in Redis, so
  the two can disagree with nothing to notice. A registry row's truth-maker is the worker PROCESS and
  its refresh IS the claim, so the claim dies with the process -- no reaper, no third party. Where the
  argument does not transfer is named rather than glossed: the wait-check lease and a per-scope
  in-flight count ARE claims of this entry's kind, and this keyspace closes neither.
- **Traces to**: `OQ-002`, `REQ-QUEUE-BURST-NO-DROP`, `REQ-SCOPED-LIMITS`, `DES-SCOPED-LIMITS-AND-FOLDER-MUTEX`

## DES-CRON-VIA-BULLMQ-SCHEDULER

- **Decision**: Scheduled triggers use BullMQ **Job Schedulers** (`upsertJobScheduler`). We do not build a
  cron, and we do not use the deprecated `repeat:` API. **A schedule is a trigger, not a job kind** — it
  produces an ordinary job aimed at either a GitHub repo or a local folder.
- **Why**: pi has no cron (`DES-TRIGGER-OUTSIDE-PI`), and hand-rolling one means reimplementing cron
  parsing, persistence, missed-tick policy and overlap control — four mechanisms, the exact drowning
  `DES-QUEUE-BULLMQ-OVER-CUSTOM` refused. BullMQ's scheduler is a **Redis object, not a JS timer**
  (`ZADD repeat <nextMillis> <id>` + `HMSET`), so it survives a worker restart with nothing to lose and a
  Redis restart under the AOF we already require. Three of its properties matter to a money-spending
  harness, and each is verified rather than assumed — the second one was verified WRONG and corrected
  (issue #242; the original claim shipped unevidenced and stood for a month):
  - **No backfill.** Six hours down with an hourly schedule costs **one** paid run on restart, not six —
    the `every` path aligns forward to a single next slot; the `pattern` path asks cron-parser for one
    `next`. Neither loops. This is the difference between a reboot and a bill.
  - **At most one UNSTARTED occurrence — which is NOT no-overlap.** The scheduler mints the next
    occurrence when the current one is PICKED UP (`bullmq → worker.js → nextJobFromJobData →
    jobScheduler.upsertJobScheduler`, `override: false`), it lands in the delayed set, and promotion is
    on time alone (`bullmq → commands/includes/promoteDelayedJobs.lua`, a ZRANGEBYSCORE by timestamp
    that consults nothing about active jobs). So a 30-minute flow on a 10-minute schedule DOES run
    concurrently with its own successor whenever `PI_CONCURRENCY` has a free slot — this entry used to
    claim the opposite ("no overlap, structurally"), and the claim was false at every version that
    carried it. What holds structurally is the weaker bound: at most one unstarted next occurrence
    exists at a time, so the queue cannot flood. Same-FOLDER no-overlap is real again as of issue #242,
    supplied by the worker's one-job-per-folder mutex at the pickup gate, keyed on the RESOLVED folder
    path so spelling variants converge — and it is the mutex's property, holding within one worker
    process (the one-worker-per-daemon boundary this design already assumes above), never the
    scheduler's. A deferral consumes no attempt (`bullmq → job.js → moveToDelayed → skipAttempt: true`),
    so the scheduled path's single-attempt posture survives any number of deferrals.
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
  - **A host's own schedulers live on its own queue since issue #57.** `upsertJobScheduler` targets
    `pi-jobs@<name>` when the deployment declares a worker name, which makes the prune correct by
    CONSTRUCTION rather than by agreement: a host queue's resident schedulers are only ever that host's,
    so "resident minus my config" means what it always meant. The fingerprint gate below stays, because it
    catches the divergence ITSELF -- including a timezone disagreement, which no queue split can see.
  - **Reconcile is gated on fleet AGREEMENT since issue #57.** `reconcile` prunes every resident scheduler
    not named in this worker's config, which is idempotent for one worker and mutual teardown for two: each
    deletes the other's on every boot and every file-watch reload. A worker now publishes a fingerprint of
    its NORMALIZED schedule set (plus its IANA zone, since a cron pattern carries none) and reconciles only
    when no other live worker publishes a differing one. **Agreement rather than an elected owner**, and
    the bad case is why: an elected owner reconciles from ITS file, so a stale one -- the operator edited on
    the other host, or a compose `:ro` single-file mount pinned a dead inode -- silently converges the fleet
    on the wrong set and reverts the edit with a log line that reads like success, which is `OQ-008`'s own
    verdict through a new door. Agreement never picks a winner, so it cannot pick the wrong one, and it
    needs no lease because it grants no authority: the rule only ever WITHHOLDS a permission, so absence of
    knowledge proceeds and a Valkey blip cannot wedge a single host. The honest cost is that agreement can
    stalemate and needs an operator, where election resolves automatically and possibly wrongly.
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
  `@edgehero/pi-dispatch/triggers` — `@pi-dispatch/worker/triggers` before the issue-#80 rename) parses and validates the whole file; the worker selects `on.type:"cron"`
  and the receiver selects `on.type ∈ {label, comment, pull_request, issue}` for whichever forge each entry's `run.kind` names. Both validate everything; each
  evaluates only its own subset. This replaces the two prior files (`PI_SCHEDULES_FILE` and
  `receiver.flows.json`) with **no compatibility shim** — a clean cutover.
- **Why**: The schema unifies the operator's *view* of triggers; it does **not** merge the engines. The
  `receiver`/`worker`, adversarial/trusted boundary is untouched: a `label` `on` is never scheduled (no
  delivery GUID to dedup on, no fresh collaborator approval), and a `cron` `on` never receives a webhook.
  The `on × run` matrix pairs `cron ↔ local` and webhook ↔ a **forge** (`github`|`gitlab`|`forgejo`|`azure`),
  and that pairing **is** the trust boundary, encoded as a fail-loud validation rule
  (`INT-TRIGGERS-FILE-CONTRACT`). One validator means a malformed file fails identically wherever it is read.
  The shared module lives in the worker package because `receiver` and `admin` already depend on it (today
  `@edgehero/pi-dispatch`); the dependency is one-way, so no cycle.
- **There are THREE readers, and the third holds a FROZEN COPY.** This entry said "one validator, run by
  both … the two cannot drift", which was true when there were two. `admin` is the third, and it does not
  resolve the validator at runtime: `admin/build.mjs` runs esbuild with `bundle: true` and the worker is not
  in `external`, so `parseTriggers` is INLINED into the published console at build time (a devDependency,
  `files: ["dist","skills"]`). `writeTriggers` validates the whole post-mutate file through that inlined
  copy before writing. Two independent validators is what the Rejected list below refuses, and a frozen
  build-time copy is that, separated by time rather than by code. It is recorded here rather than removed
  because the alternative — a runtime dependency from the console on the worker package — is a heavier
  coupling than the one it would fix.
- **Widening is forward-safe; relaxing a refusal is not**, and #187 is the first change in this file's
  history to do the second. Every prior field (`run.skillsDir`, `run.instructions`, `run.command`,
  `run.resume`) ADDED an optional key, and unknown keys drop, so an old parser meeting a new file is a
  silent no-op. Relaxing a refusal on a key both sides already know means an old parser meeting a new file
  hits an explicit `throw`. The consequence is a release-ordering constraint rather than a code one: the
  console must be republished with the loaders, or an operator's `/dispatch trigger add` refuses a file the
  deployed services accept, citing a limit the runtime no longer has.
  **#231 adds the third case: a new `on.type` (or action word) is the LOUD-skew widening.** The unknown-key
  silence above is exactly what a one-shot could not afford — an old parser silently dropping `on.once`
  keeps firing a trigger the operator believes disarmed — and the vocabulary decision is what closes it:
  `issue` fails an old parser's closed `on.type` check and `closed`/`close` fail its action tables, so an
  old service meeting a #231 file refuses at boot (or keeps last-good on live reload) instead of silently
  half-reading it. The dangerous direction is unreachable by construction **for files the new schema
  accepts** — a hand-written `on.once` on a shape the new schema refuses (a label rule, say) was always
  invalid, is authorable by no #231 admin, and an old parser drops it silently, which is the one skew
  corner an operator can still build by hand. The price is the same release-ordering constraint as #187. `run.flow`'s charset check is the file's second true NARROWING, and
  a safe one: a webhook flow outside the skill charset could never materialise, so the load refusal can
  only reject files that already failed post-budget.
- **Rejected**: a compat union accepting both old shapes (the repo bans backwards-compat shims,
  `.claude/rules/legacy-removal.md`) · two independent validators (they drift) · a third shared package
  (unnecessary — the one-way worker dependency already exists).
- **Traces to**: `INT-TRIGGERS-FILE-CONTRACT`, `REQ-CRON-SCHEDULED-JOBS`, `REQ-TRIGGER-AUTHOR-GATE`

## DES-ONE-SHOT-DISARM-IN-THE-FILE

- **Decision**: A spent one-shot (issue #231) is recorded **in the triggers file itself**, by the WORKER,
  as one added key: `on.disarmed = { at, jobId }` on the exact entry the job matched, written after the
  run record exists. The entry is never deleted (its raw index is the attribution identity for every
  historical run record) and its authored fields are never rewritten (`once: true` stays as the operator
  typed it; the machine only adds). The shared validator collapses a disarmed entry to the sentinel
  `INT-TRIGGERS-FILE-CONTRACT` specifies, so "spent cannot match" is the parser's guarantee, not a
  consumer discipline. Both authors — the console's CRUD and the worker's disarm — serialize through ONE
  shared writer (`worker` package, `./triggers-file`, re-exported by the admin), which takes `<path>.lock`
  by exclusive create around every read-modify-write.
- **The lock, and its one new mechanism.** The session store's promotion lock supplies the doctrine
  (EEXIST is the only failure that means locked; unlink in `finally`; a leaked lock is logged, never
  thrown) and the two postures split by caller: the console's sync writer **gives up immediately** on
  contention with `{ invalid }` naming the lock (its callers sit on the pi TUI event loop, where a
  bounded-retry sleep is a frozen panel; the operator re-presses), while the worker's async
  `disarmTrigger` retries ~5 times with 100-300ms jitter (nobody is at the keyboard, and what it races
  clears in milliseconds). NEW, with no in-repo precedent and stated as such: a lock whose mtime is older
  than 10s is **unlinked and retaken once**. The session store can discard on contention and let its
  reaper sweep a leak; this file has no reaper, and a crashed writer's lock would otherwise wedge every
  trigger add/edit/delete/disarm on the deployment forever. The residual is the classic
  unlink-then-create window, milliseconds wide, replacing the always-open window two writers had before
  the lock existed; the loser's write still validates through the shared parser, so the file stays
  loadable and the lost update is one edit or one disarm — the disarm retries, the operator re-presses.
  A rename-based write REPLACES a symlink at the destination with a regular file — true of the
  console's writer since it existed, newly reachable UNATTENDED by the worker's disarm: an operator
  who symlinks `triggers.json` into a repo has the link severed by the first one-shot fire, the live
  file and the repo copy silently diverging. Keep the real file at the served path and symlink the
  OTHER direction, or point PI_TRIGGERS_FILE at the real file.
  Each write stages through a **per-writer tmp name** (pid + sequence), never a shared `.tmp`: with one
  author a fixed tmp was self-cleaning and harmless, with two it would void the tmp+rename atomicity in
  exactly the double-take window (renaming a rival's half-flushed tmp over the destination), and the
  atomicity claim must hold precisely when the lock does not.
- **The disarm verifies identity before it writes — every field the job knows.** `index` is positional
  and the file can change between enqueue and disarm, so the writer refuses unless the entry at
  `index` is still an armed one-shot naming the exact item number AND dispatching the exact flow or
  command the job carried. What that confirms is the matched **item and target, not the trigger
  instance**: an operator who deletes an in-flight one-shot and re-arms an IDENTICAL one (same index,
  number, and flow) inside the job's run window has re-armed something the writer cannot tell from
  the original, and the earlier job's disarm will spend it — a residual named rather than closed,
  because a per-trigger id is the thing this design rejects (the raw index IS the identity), and
  every DIFFERING re-arm refuses loudly. Already-disarmed is `{ already }`, an idempotent success (a
  sibling replica of the same delivery, or a redelivery, lost the race by design). An unreadable file
  refuses WITHOUT repair: the CRUD writer's repair-from-empty posture (missing file + "add trigger" =
  scaffold) would here overwrite a trigger set the worker failed to read, to record one disarm.
  One collateral both writers share, stated because the disarm makes it fire AUTONOMOUSLY: the file
  is re-emitted canonical (2-space, JSON-normalized), so a hand-formatted file's first one-shot fire
  produces a whole-file reformat in the operator's diff — the write's content delta is one key, its
  byte delta is canonicalization, and canonical 2-space has been the written contract since OQ-008.
- **What disarms, and when** (landed with the worker slice): the hook sits strictly AFTER the
  run-record write at the worker's one recordRun
  funnel — "fired" means "produced a run record", the issue's own definition — and fires for every
  record, per-attempt failure records included; the pre-spend check that closes the re-fire window
  excuses the job's OWN `jobId` (so BullMQ's second attempt of the same delivery still runs — without
  that exception, disarm-on-attempt-one's-failure silently turns `attempts: 2` into `attempts: 1` for
  every once job) and refuses only on POSITIVE foreign disarmed evidence. A crash between the record and
  the disarm leaves the chosen failure direction: an armed one-shot with a record, which may fire again
  on a NEW close — bounded by the delivery-GUID dedup, the semantic window, and the pre-spend check —
  and never a disarm without a record. Its mirror is narrower than it reads: the disarm
  follows writeRecord's RETURN, and the record writer swallows fs errors by contract — so a full disk
  spends the one-shot behind a `run_record_failed` line, which is chosen too, because skipping the
  disarm on a failed record write would re-fire it unbounded.
- **No implicit `mkdir`**, a deliberate divergence from `writeOverlay`: the overlay's directory is
  worker-managed state, while `triggers.json`'s location is operator-authored config — creating a typo'd
  directory would succeed into a file no service reads (the split-host hazard), where a loud `ENOENT` is
  the honest answer.
- **Rejected**: deleting the fired entry (shifts `triggerIndex`, re-attributes history — the issue's own
  refusal) · rewriting `once` to a `"fired"` value (the schema stays strictly boolean, the operator's
  authored intent is never edited, and the `{ at, jobId }` object is the only provenance that outlives
  run-record retention) · the receiver as writer (its compose mount is `:ro`, and it knows a job was
  enqueued, not that it ran) · a held/delayed queue job as the one-shot state (authorization in Redis;
  `docker compose down -v` deletes it silently — the OQ-008 failure mode) · a separate archive file (a
  second retention policy and a second panel view; the flag plus `git log` is the archive) · a blocking
  sync retry in the console writer (freezes the panel) · a lockfile dependency with lease/renewal
  machinery (two writers whose critical section is two syscalls do not need a daemon).
- **The compose topology makes the pre-spend check load-bearing, not optional.** The shipped compose
  file bind-mounts `triggers.json` as a single FILE, `:ro`, and the disarm's tmp+rename swaps the
  inode -- so the container keeps reading the old bytes and the receiver stays armed until restart
  (its directory watcher watches `/config`, which never changes). In that topology the worker's
  pre-spend check is the once-enforcement layer; the compose comment says so beside the mount, and a
  container restart picks up the current file. Native (service-unit) deployments reload live as
  designed.
- **Code evidence**: `worker/src/triggers-file.mjs` → `writeTriggers`, `disarmTrigger`,
  `readDisarmState`, `makeDisarmOnce`, `makeCheckOnceSpent`; `worker/src/start.mjs` → the recordRun
  wrap and the `PI_TRIGGERS_FILE ?? ./triggers.json` resolution; `worker/src/processor.mjs` → the
  `once-already-spent` gate at the top of the pre-spend ladder; `admin/src/read-model.mjs` → the
  re-export; `worker/src/session-store.mjs` → the lock idiom inherited.
- **Traces to**: `INT-TRIGGERS-FILE-CONTRACT`, `OQ-008`, `CONST-TRIGGER-AUTHOR-GATE`,
  `REQ-DEDUP-BY-DELIVERY-GUID`

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
- **A submitted review routes through this same decision** (issue #66). `review_submitted` is an action on
  this trigger type rather than a type of its own, and it changes nothing about the clone ref, the target
  shape or who decides what to do: the harness hands the flow the PR context plus the review's own
  `{ id, body, state, author_association }` and the flow decides whether that means push, comment or
  nothing. Two consequences follow from routing rather than interpreting. The `state` reaches the flow as
  data, so "only act on changes_requested" is a **flow** decision, while `on.reviewState` is the operator's
  separate, cheaper control over what is worth paying for at all — the same split as a label predicate
  versus what the skill does once it runs. And `review.id` is carried because the review's inline comments
  ride an event this project does not ingest, so fetching them is the flow's job and the id is what it
  needs to do it.
- **Rejected**: cloning the PR head ref in the worker (executes fork code on the host clone path, and a
  base-scoped token cannot push to a fork branch anyway) · harness-side review/push logic (reimplements pi) ·
  auto-firing on any PR open (unbounded paid runs from fork PRs — `CONST-TRIGGER-AUTHOR-GATE`) · a fifth
  `on.type` for reviews (GitLab's `approved` already rides `pull_request`, so a new type would make one
  forge's review a type and the other's an action) · ingesting `pull_request_review_comment` (one delivery
  per line comment, a volume characteristic nothing else here has; the empty-body refusal plus `review.id`
  is the cheap answer until there is a reason to do more).
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

## DES-CLI-SURFACE

- **Decision**: The workspace CLI (`pi-dispatch`, bin of the worker package) is the deployment's
  operator surface, and its subcommands sit on an explicit gate ladder. **Read-only / always safe**:
  `doctor`, `status`. **Operator-typed, ungated**: `run`, `pause`, `resume`, `sandbox`, `import-pi`
  (each is its own gate — typing it is the approval, `REQ-ADMIN-VIA-PI-EXTENSION`'s ladder top).
  **Create-only, contractually non-destructive**: `init` (idempotent scaffolds; an existing file is
  never touched). **Consented host mutations**: `up` and `doctor --fix` — each concrete action (a
  docker pull of the deployment's *own default* image, a loopback Valkey start, an overlay
  `auth.json` delete, an `import-pi` restage) is shown verbatim and runs only on an explicit y/N
  accept, defaulting to No, including on non-TTY stdin. The receiver's `pi-dispatch-receiver` bin is
  a sibling on the same ladder (serve = the operator typed it). `service render|install --env-setup
  <path>` is **operator-typed** too, and it is the sharpest thing on that tier: the named script runs as
  the service user at every boot, with the deployment's environment.
- **Why**: `init` and `doctor` grew organically with no recorded surface; issue #80 adds subcommands
  that *mutate the host*, and an unrecorded gate ladder is how a later "helpful" flag erodes a trust
  property nobody wrote down. Recording which tier each subcommand sits on makes "may this be
  automated?" a lookup instead of a debate.
- **The never-tier is load-bearing**: no subcommand, flag, or fix path may rewrite malformed config
  (fail-loud/keep-last-good is doctrine), write triggers/pause-windows/scoped-limits *content*, pull a
  trigger-named `run.image` (each image is a separate per-flow trust posture — only the deployment's
  default is ever offered, and the consent keypress is the "pulled it onto this host yourself" act
  `SECURITY.md` requires), guess a semantic env value, touch branch protection on a forge, or **name an
  env-setup script from anywhere but an operator-typed flag** — not from `.env`, not from a trigger
  file, not from the panel, not from the deployment pointer. The wrappers enforce their half by
  capturing `PI_ENV_SETUP` *before* they source `./.env`, so no file they read can name a file they run.
- **Traces to**: `REQ-DEPLOYMENT-BOOTSTRAP`, `DES-CLI-TRIGGER-FOR-LOCAL`, `CONST-BUDGET-BEFORE-TOKENS`

## DES-PER-TRIGGER-SECRET-PROFILE

- **Decision**: A trigger names secret REFERENCES and a resolver PROFILE NAME. The operator declares
  profiles as `name -> absolute path` in `PI_SECRET_PROFILES` or through the operator-typed
  `/dispatch secrets` command; the worker runs the selected script once per reference, host-side, before
  anything spends, and injects the values into the closed container environment.

- **Why**: A deployment-wide `PI_FORWARD_ENV` entry is the only way a job can hold a secret of its own
  today, and it gives that secret to every job on the host. The unit of choice an operator actually wants
  is the trigger: this repository's `pi:deploy` label holding a Stripe key while `pi:fix` holds none.

  **A trigger names a NAME, never a path, and that distinction is the whole reason this is allowed.**
  `DES-SERVICE-ENV-SETUP-SEAM` rejected "making this reachable from configuration, which would turn a
  boot-time root-adjacent exec into something a trigger file could name". A profile name SELECTS among execs
  the operator already declared. It cannot introduce one, cannot name a path, and cannot reach a script
  nobody wired. The rejected thing is a trigger file naming an exec; this is a trigger file choosing between
  the operator's.

  **What that argument does NOT establish, stated because the first draft of this entry claimed it.** It is
  tempting to add that a resolver is safer than `--env-setup` because it runs mid-life as the worker's own
  user rather than root-adjacent at boot. That does not survive `SECURITY.md`'s own words: the blast radius
  named there is "the account that holds every credential this deployment has", which IS the worker's user,
  and a resolver inherits the worker's whole environment including `GITHUB_APP_PRIVATE_KEY`. Boot-time
  versus job-time is a difference in timing, not in power. What actually bounds the new surface is the
  fail-closed default below, not a weaker blast radius.

  **The panel may declare a manager, and `PI_SECRET_RESOLVER_ROOTS` is what makes that safe.** Declaring a
  profile means naming an absolute host path the worker executes, so it is reachable only from the
  operator-typed command surface (`registerCommand` has no LLM-facing surface at all) and every
  panel-declared path must realpath inside an operator-named root. The default is empty, so a deployment
  that never opts in behaves exactly as though the panel path did not exist. This is
  `DES-PER-TRIGGER-JOB-IMAGE`'s own prediction arriving: "If a future tool ever takes an image parameter,
  the allowlist arrives with that tool, and this row is the reason it must."

  **The bound is enforced in the WORKER, not only where a profile is written.** The settings overlay
  defaults into the OS temp directory, so on a multi-user host a check that lived in the panel alone would
  be cosmetic. Re-checking at resolution time caps a tampered overlay at "choose among scripts the operator
  allowlisted" rather than "name any executable on the host".

  **Neither source wins a name collision.** `DES-RUNTIME-SETTINGS-FILE-OVERLAY` gives the overlay
  precedence over env, and inverting that for one key would leave two rules disagreeing about what an
  overlay is; honouring it would let a file in a world-writable default directory redirect a profile the
  operator wrote in `.env`. So a name declared in both refuses per delivery, which is the posture `PI_EGRESS`
  already takes toward an ambiguous value.

  **The resolver's exit code is `INT-RUNNER-EXIT-CODE-PROTOCOL`'s, reused rather than invented.** Folding
  every nonzero exit into a refusal is the obvious design and it breaks `CONST-RETRY-INFRA-ONLY` in the
  expensive direction: a vault unreachable for twenty seconds would permanently burn a delivery that
  `attempts: 2` would have recovered, and a webhook does not redeliver itself.

- **Rejected**:
  - ***A trigger naming the resolver path directly*** — this is the thing `DES-SERVICE-ENV-SETUP-SEAM`
    refused, and no bound recovers it: `triggers.json` is operator-authored but the whole design of the
    name/path split is that the file which says WHICH job reaches a vault need not also be the file that
    says WHAT runs to reach it.
  - ***A flow declaring a profile*** — `.pi/skills/<flow>/SKILL.md` is merge-gated, not operator-authored.
    `DES-AI-TRIGGER-FLOW-GATE` reads a BOOLEAN from that file precisely because a boolean is all it is
    willing to take from there, and `DES-PER-TRIGGER-JOB-IMAGE` calls a flow-declared image its sharpest
    rejection. A flow-declared vault profile is that with a credential attached.
  - ***A vault name as the unit of grant*** — a trigger enumerating fields stays true as the vault grows;
    a trigger naming a vault silently widens every time someone adds an item to it. Naming a vault is how a
    capability review decays without anyone editing the file it lives in.
  - ***A model-callable `secretsProfile` picker*** — considered, and it cannot exist coherently: a profile
    that resolves nothing is refused at load and no tool can write `run.secrets`, so the picker could never
    produce a valid trigger. A control that looks like a grant and is only ever an error.
  - ***A manager's client inside the job image*** — nothing in this design runs in the container, which is
    what keeps the image free of a vendor and the job free of a credential.
  - ***A per-trigger egress relaxation to reach a vault*** — `run.network` was already refused
    (the deployment configures egress; a trigger never does), and nothing here needs one: the resolver runs
    on the host, outside the job's network entirely.

- **Traces to**: `REQ-TRIGGER-SECRETS`, `INT-TRIGGERS-FILE-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`,
  `INT-RUNNER-EXIT-CODE-PROTOCOL`, `DES-SERVICE-ENV-SETUP-SEAM`, `DES-PER-TRIGGER-JOB-IMAGE`,
  `DES-RUNTIME-SETTINGS-FILE-OVERLAY`, `CONST-TOKEN-SCOPED-PER-JOB`

## DES-SERVICE-ENV-SETUP-SEAM

- **Decision**: `pi-dispatch service render|install --env-setup <absolute path>` is the supported way to
  run a secrets manager in front of the worker. The operator writes a script that sets up the
  **environment only**; the renderer composes everything else. On systemd that is one line,
  `ExecStart=/bin/sh -c 'set -a; . "<setup>" || exit 1; set +a; exec "<node>" "<cli>" worker'`. On
  launchd and nssm the path rides the unit as `PI_ENV_SETUP` (the plist's `EnvironmentVariables` dict,
  `nssm set … AppEnvironmentExtra`) and the existing `worker-env-wrapper.sh` / `.cmd` sources it after
  `./.env`; `ProgramArguments` and `AppParameters` do not change at all, and with the variable set
  `./.env` becomes optional. With no flag, every rendered artifact is byte-identical to what shipped
  before.
- **Why**: The command already composed the whole `ExecStart`, so an operator running a manager had one
  option: hand-edit the rendered unit. The obvious hand-edit is wrong in a way that costs money.
  Measured against Infisical's CLI: `infisical run -- <cmd>` collapses every nonzero child exit to `1`,
  and exit `2` is `INT-RUNNER-EXIT-CODE-PROTOCOL`'s policy refusal — the code
  `RestartPreventExitStatus=2`, nssm's `AppExit 2 Exit` and the wrapper's own exit-2 conversion all key
  on. Wrapped that way a determinate refusal reads as a crash and the supervisor relaunches it in front
  of a paid provider, which is the exact failure the wrapper gave up its own `exec` to prevent. **The
  renderer owning the `exec` is the whole value**: an operator supplying only the setup half cannot get
  the exit code wrong.
- **A path, not a command**: systemd expands `$VAR` inside `Exec` lines whatever the quoting, a plist is
  XML, and nssm's argv is neither, so an inline command would need three separate escaping stories and
  would still be the shape `docs/secrets.md` tells operators not to write. A path collapses that to one
  validation, per platform, of characters that would change what the line *means* (`$` and quotes on
  Linux, `<>&` on macOS, `%` on Windows). Absolute and never resolved, because POSIX `.` searches
  `$PATH` for an operand with no slash in it.
- **A failed setup is exit 1, never 2**: an expired token or an unreachable manager is infrastructure,
  worth a retry inside the existing `StartLimit` bound; the determinate refusal that must stay stopped
  is a different fact. The worker never starts on a half-filled environment. A setup script that calls
  `exit 2` itself still exits 2, since sourcing cannot intercept that, which is why the docs say not to.
- **The setup runs after `./.env` and after `EnvironmentFile=`**, so the manager wins over a stale key
  left in the file. That asymmetry used to be a documented trap with no fix on macOS and Windows.
- **The preparation window belongs to the seam** (issue #221): the seam's whole value is that an
  operator's script runs *before* the worker, which means the wrapper now spends measurable time — a
  network round trip to a secrets manager — started and with nothing yet to stop. What happens to a stop
  that lands there is `DES-WRAPPER-STOPS-WHAT-IT-STARTED`: the handler is armed above the sourcing,
  re-asserted below it because `.` can replace it, and the command is never launched at all.
- **Rejected**: depending on, or blessing, any particular manager (the seam is a file; `docs/secrets.md`
  names the shapes); a shipped launcher script for systemd (a third wrapper file to mirror and pin, for
  a line the render can compose); composing a command line into the plist and the nssm argv (quoting for
  two more formats to deliver a value the unit can simply carry); and making this reachable from
  configuration, which would turn a boot-time root-adjacent exec into something a trigger file could
  name (`DES-CLI-SURFACE`'s never-tier).
- **The unit is the record** (issue #216): `--env-setup` is a render-time flag, so once the unit is
  written that file is the only place the path exists. A preflight that wants to check the script has to
  read it back out — the `ExecStart` line, the plist's `EnvironmentVariables` dict, `nssm get …
  AppEnvironmentExtra` — which is why the reader (`ENV_SETUP_READERS`, `readUnitSeam`) lives in
  `service.mjs` beside the composer that emits those shapes, and why every render in the suite is
  round-tripped through it. Two things follow. The renderer must substitute the template's per-host
  placeholders **before** it composes anything, never after: doing it after rewrote the operator's own
  path (`--env-setup /opt/pi-dispatch/setup-env.sh` on a deployment at `/srv/pi-deploy` became
  `. "/srv/pi-deploy/setup-env.sh"`, a file `resolveEnvSetup` never checked, with the banner comment
  above still naming the one that was typed). And doctor matches a unit to this deployment by its
  `WorkingDirectory` before believing it, because a host may run two.
- **Windows is weaker on purpose, and says so**: `worker-env-wrapper.cmd` has no `exec`, so a wrapper
  process always sits in the middle there. What the seam guarantees on Windows is that the setup runs in
  the same process tree, that a missing or failing setup exits 1, and that the existing exit-2
  conversion is untouched. It has no `trap` either, so the preparation window has no wrapper-level
  handling at all there; nssm stops with a console event to the process group, which reaches the worker
  directly rather than through this file.
- **Traces to**: `REQ-DEPLOYMENT-BOOTSTRAP`, `DES-CLI-SURFACE`, `DES-WORKER-ON-HOST`,
  `INT-RUNNER-EXIT-CODE-PROTOCOL`, `docs/secrets.md`

## DES-WRAPPER-STOPS-WHAT-IT-STARTED

- **Decision**: `worker-env-wrapper.sh` arms its `TERM`/`INT` handler **before it sources anything**,
  **re-asserts** it after the sourcing, **refuses to launch** the command at all when a stop arrived first
  (exit 0, with the reason on stderr), and **re-sends** the signal immediately after `child=$!` when the
  handler fired before the pid was knowable. Together those cover every instant from process start to
  `wait`, which is the property the file did not have.
- **Why**: this wrapper gave up `exec` so it could outlive the worker and convert exit 2
  (`DES-SERVICE-ENV-SETUP-SEAM`, and the `exec` cannot come back for the same reason). The cost of that
  trade is that forwarding a stop is now hand-written, and hand-written forwarding had two holes, both
  silent. Everything before the trap ran with `TERM` at its **default disposition**, so a stop landing
  during the sourcing killed the shell mid-preparation with nothing said anywhere; and `$!` is readable
  only **after** the fork, so a stop landing between `"$@" &` and `child=$!` ran the handler with no pid,
  forwarded to nothing, set a flag nobody read again, and left the wrapper waiting out the command's
  entire natural lifetime while the service manager believed it had asked the process to stop. A launcher
  that accepts a stop and then does not stop is the silent no-op this project treats as its worst
  available outcome, and it is reachable from this project's own CLI: `pi-dispatch service stop` on macOS
  is `launchctl kill SIGTERM` at that pid.
- **Refusing to launch, rather than launching and then stopping**: a worker started after its stop has
  already arrived reserves a budget slot and takes a job, and then needs a drain nobody is waiting for.
  Exit **0** because 0 is the only code launchd's `KeepAlive`/`SuccessfulExit=false` leaves stopped — the
  same reasoning as the exit-2 conversion. Not 2, because nothing was refused; not 1, because nothing
  failed; the manager's own instruction was carried out, and the wrapper says so rather than exiting mute.
- **The re-assert, and the one thing it cannot undo**: `.` runs in the wrapper's own shell, so a setup
  script's `trap … TERM` **replaces** the handler and the drain silently disappears; worse, `trap '' TERM`
  leaves the signal ignored, and a child forked from such a shell inherits `SIG_IGN` and cannot trap
  `TERM` at all. Re-installing a real handler before the fork restores `SIG_DFL` for the child and covers
  both shapes. What it cannot recover is a signal delivered **while** the script had it ignored: that one
  is already discarded, which is why `docs/secrets.md` tells operators not to touch signals in a setup
  script at all.
- **launchd and nssm only, checked rather than assumed**: with `--env-setup` systemd does put an untrapped
  `sh -c` in the same window, but `KillMode` is unset everywhere so the default `control-group` signals the
  whole tree, no worker has been launched yet, and `Restart=on-failure` treats death by `SIGTERM` as a
  clean exit. The same stop stops the same unit either way. On Windows `worker-env-wrapper.cmd` has no
  `trap` and cmd has no equivalent, so the preparation window there is whatever nssm's stop does to the
  tree; the asymmetry is named in the file and here, and is not closed.
- **Rejected**: **a readiness handshake** — a marker the wrapper writes once it can forward, waited on
  before signalling, which is what the issue proposed. It would make the TEST reliable and leave the
  PRODUCT dropping the signal, and no marker written by the child can close a window that exists before
  the child does. **Blocking the signal around the fork**: POSIX `sh` has no `sigprocmask`, and the
  reachable spelling, `trap '' TERM`, is inherited by the child as `SIG_IGN` — the exact failure the
  re-assert exists to undo. **Exiting 143 for a pre-launch stop**: nonzero relaunches the service the
  operator just stopped, into the half-built environment the setup script never finished. **Skipping or
  retrying the tests that caught it**: they pin real behaviour, and four reruns across two tests are what
  bought the misdiagnosis.
- **Traces to**: `REQ-DEPLOYMENT-BOOTSTRAP`, `DES-SERVICE-ENV-SETUP-SEAM`, `DES-WORKER-ON-HOST`,
  `INT-RUNNER-EXIT-CODE-PROTOCOL`, `docs/secrets.md`

## DES-GH-APP-MANIFEST-SETUP

- **Decision**: `pi-dispatch setup github` mints GitHub App credentials via the **App Manifest flow**:
  a throwaway loopback HTTP listener serves a self-submitting form that POSTs the manifest to
  `github.com/settings/apps/new` (or the `--org` variant), the browser redirect delivers a single-use
  code (1h validity), and the unauthenticated `POST /app-manifests/{code}/conversions` returns the app
  id, private-key PEM, and webhook secret in one response. The wizard then shows the exact `.env`
  lines and writes them only on one explicit consent; the PEM lands beside `.env` with mode `0600`
  (an existing key file refuses — never clobbered); an already-set `WEBHOOK_SECRET` is kept
  (`setEnvKeyIfEmpty` — replacing it would invalidate working deliveries); the installation id is
  discovered via an app JWT against `GET /app/installations` after the operator confirms installing.
  `--no-webhook` creates the App with `hook_attributes.active:false` — the no-public-URL shape the
  polling transport consumes.
- **Why**: The App source is the strongest credential this system supports (SECURITY.md prefers it),
  but acquiring it was the most manual mile in the whole setup: five settings pages, a hand-invented
  webhook secret, and an installation id hunted from URLs. The manifest flow compresses all of it into
  one click **without changing whose infrastructure is trusted**: the listener is the operator's own
  loopback, GitHub is the only remote party, and no maintainer-controlled service ever sees a
  credential. The JWT for installation discovery is ~15 lines of `node:crypto` RS256 on purpose —
  auditable, dependency-light, and used once at setup time (job-time minting stays `@octokit/auth-app`
  in `get-token.mjs`, unchanged).
- **Gate ladder fit** (`DES-CLI-SURFACE`): operator-typed, and every write individually consented with
  the content shown first; secrets never printed, redacted in every error path. There is deliberately
  no `--yes` here — unlike `up`'s docker actions, these writes carry credentials.
- **Rejected**: shipping a maintainer-registered OAuth client for device flow (inserts a maintainer
  dependency into a self-hosted trust chain); auto-installing the App (the install page is a GitHub
  consent screen — automating a consent screen defeats it).
- **Traces to**: `DES-CLI-SURFACE`, `REQ-DEPLOYMENT-BOOTSTRAP`, `CONST-TOKEN-SCOPED-PER-JOB`,
  `SECURITY.md` (auth-source ladder)

## DES-GH-POLLING-TRANSPORT

- **Decision**: `pi-dispatch-receiver poll` is an **alternative producer** for GitHub triggers that
  needs no public URL: it polls issue events, issue comments, open PRs, and the reviews on those open
  PRs per serviced repo (ETag
  conditional requests, ~60s cadence honoring `x-poll-interval`), synthesizes the exact
  `INT-WEBHOOK-PAYLOAD-SUBSET` shapes, and feeds the **unchanged** pure `filter()` and the shared
  enqueue path with `poll-*` delivery ids. **The webhook receiver stays the default and the
  documented low-latency path** — polling is for hosts that cannot (or should not) expose a port.
  Repos come from an explicit `POLL_REPOS` allowlist or, under App auth, the installation's repo
  list. A fresh poller initializes cursors to *now* and never replays history — a label applied
  months ago was an approval for a different moment. One repo's API failure skips that repo for the
  cycle, never the loop. `WEBHOOK_SECRET` is not required in poll mode (there is no inbound delivery
  to verify); `serve` still hard-requires it.
- **Why**: The public HTTPS endpoint was the single hardest setup mile for home deployments (tunnel
  or DNS, both punted to the operator), and it defends a surface polling simply does not have: TLS
  with the operator's own credential against api.github.com replaces HMAC-over-raw-body because the
  authentication points the other way. Every author/label/bot-loop/dedup/spend gate evaluates
  identically — parity is pinned by tests running webhook-shaped and REST-synthesized subsets through
  the same gate. The accepted cost is ~60s trigger latency, cheap against jobs that run for minutes.
  Conditional 304s are rate-limit-free, so a handful of repos polls within a fraction of the 5000/hr
  budget.
  **The reviews source is per-PR, and that shapes its cost model** (issue #66). `GET /pulls/{n}/reviews`
  has no repo-wide form, so a cycle would otherwise spend one request per open PR forever. The validators
  therefore live in one hash keyed by PR number rather than a key per PR — an unbounded key family would
  break the "refresh the cursor family as a unit" TTL argument this design rests on — and the idle steady
  state is one 304 per open PR, which costs no quota. The sweep is bounded and says so in a log line when
  it truncates. It also runs when the open-PR list itself answers 304: whether submitting a review
  perturbs that list is GitHub's business, and betting correctness on it would mean review triggers that
  fire only when something else happens to touch the PR. The cursor is persisted **once per sweep**, not
  per review, because many endpoints' ids interleave — advancing per item would either re-enqueue or
  strand, and a mid-sweep failure retrying the whole sweep is idempotent on the `poll-rv<id>` jobIds.
  Reviews on closed PRs are never synthesized: the open list is the sweep set, and a job started by a
  review of a merged PR has nothing left to act on. This source exists because the alternative was a
  `review_submitted` trigger that loads clean and can never fire under polling, which is the silently dead
  config this project refuses everywhere else.
  **The polling credential is not a job token.** Under App auth the poller mints an *unscoped*
  installation token for itself — it must call `GET /installation/repositories` and read every
  serviced repo, which a per-repo-scoped mint cannot. That token never reaches a job:
  `CONST-TOKEN-SCOPED-PER-JOB` governs what jobs receive, and the worker's per-repo mint is untouched.
- **Rejected**: **a GitHub Actions self-hosted runner as the transport** — outbound-only networking,
  yes, but it executes merge-gated workflow code on the worker's host, converting merge-to-default
  into host-level code execution *outside the container boundary*; the one transport that removes the
  same friction while making the trust model strictly worse. Also rejected: polling as the default
  (latency and rate-limit budgets are real; the receiver remains first), and any body interpretation
  in the poller (`CONST-ISSUE-TEXT-IS-DATA` — text stays data all the way through).
- **Traces to**: `DES-GH-APP-MANIFEST-SETUP` (`--no-webhook` mints the hook-inactive App this mode
  pairs with), `INT-WEBHOOK-PAYLOAD-SUBSET`, `REQ-DEDUP-BY-DELIVERY-GUID`, `DES-TRIGGER-OUTSIDE-PI`

## DES-FIRST-RUN-SETUP-WIZARD

- **Decision**: `/dispatch setup` is **the default setup route** (issue #96): when bare `/dispatch`
  detects no deployment anywhere, it lands **directly in the wizard's opening choice** — the select
  (Guided setup / Open the panel anyway / Cancel) *is* the consent, replacing the earlier yes/no
  offer; a configured deployment with a down queue still never enters the wizard (the unreachable
  banner rule is load-bearing and unchanged). The flow: choose a deployment dir (default
  `~/pi-dispatch`, never the repo) → **Docker pre-check** (a capture probe distinguishing
  not-on-PATH from daemon-down; on failure a Re-check / Continue anyway / Stop loop with per-OS
  pointers — never a piped installer; `up`'s own hard refusal stays as defense in depth) → consented
  `npm install @edgehero/pi-dispatch@<RUNTIME_VERSION>` into it → hand the terminal to
  `npx pi-dispatch up` → optional `service install` → write the deployment pointer
  (`INT-DEPLOYMENT-POINTER-CONTRACT`, JSON shown verbatim) → provider key **printed, never
  written** → optional `setup github` hand-off → **trigger-edge choice** (install the webhook
  receiver as a service — a consented `npm install @edgehero/pi-dispatch-receiver@<RECEIVER_VERSION>`
  then `service install --receiver`; or run it with docker compose — the compose file ships in the
  runtime package and is copied create-only into the deployment dir before a consented
  `--profile receiver up -d`; or show the polling command; or skip) → optional first trigger for the
  repo the session sits in (cron pre-filled with the folder, flow picked from its `.pi/skills/` via
  the shared `SKILL_NAME_RE`, the in-place-edit warning printed, the `ai-trigger: allow` line
  **printed, never written** — repo files stay the operator's, and the gate reads committed HEAD
  anyway) → the panel.
  A once-ever `session_start` nudge (`reason: "startup"`, notify-only, marker-file latch) points at
  the command, and a once-per-process **skew notice** on bare `/dispatch` says when the deployed
  runtime is older than the console's pin ("run /dispatch setup to upgrade" — re-running setup is
  the upgrade path, made safe by the post-install version assertion). Both version pins carry
  anti-drift tests (`RUNTIME_VERSION` ↔ worker, `RECEIVER_VERSION` ↔ receiver). Every step is
  individually declinable and declines continue converge-style.
- **Mechanics, chosen for pi's real constraints**: dialogs-first, **overlay-per-handoff** — the
  wizard is a plain `ui.select/input/confirm` chain, and each terminal-needing child runs inside a
  short-lived `ctx.ui.custom` overlay that exists only to hold the `tui` handle for the
  suspend bracket (`tui.stop()` → `stdio:"inherit"` spawn → `finally` restore), because the handle
  exists nowhere else, dialogs cannot run while an overlay captures focus, and stdin is unreadable
  while suspended — the child's own prompts (up's y/N gates) own the terminal, which is exactly
  right: **the child's consent gates are the host-mutation consents, and the wizard never forwards
  `--yes` to anything**. The npm step follows import-pi's spawn doctrine (bare `npm`, win32
  `npm.cmd`+`shell:true` only there, no filesystem path in argv — the dir rides in `cwd:`,
  `--ignore-scripts`, post-install version assertion). `--ignore-scripts` on our *own* runtime is
  safe by inspection: bullmq/ioredis are pure JS and msgpackr's native accelerator is an optional
  dep (`--omit=optional`) with a JS fallback.
- **Gate-ladder fit** (`DES-CLI-SURFACE`): the wizard adds **no new tier and no new powers** — it
  sequences existing consented commands through their own gates, writes deployment config through
  the same validated atomic writers the panel uses, and its only novel artifact is the pointer file,
  which resolves paths and grants nothing. Operator-typed only: there is deliberately no
  model-callable setup tool — the bundled skill tells the model to ask the operator to type it.
- **Rejected**: a long-lived wizard overlay with hand-rolled input (reimplements dialogs, fights the
  focus model); reusing a clone as the runtime (the persona has none; two code-delivery paths double
  the matrix); a detached background worker (an unsupervised long-lived process nobody consented to
  manage — the service step or a printed command instead); credential-entry dialogs (secrets never
  transit the extension); auto-writing `ai-trigger: allow` into the operator's repo (the two-key
  property — repo consent and operator trigger — must stay two keys).
- **Traces to**: `INT-DEPLOYMENT-POINTER-CONTRACT`, `REQ-DEPLOYMENT-BOOTSTRAP`, `DES-CLI-SURFACE`,
  `DES-GH-APP-MANIFEST-SETUP`, `DES-TRIGGER-OUTSIDE-PI` (the wizard bootstraps host processes; it
  never hosts them)

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
  Since issue #80, `pi-dispatch up` *sequences* the surrounding chores (image pull+tag, Valkey start,
  scaffold, preflight) behind explicit per-action consent — the price above is unchanged (the worker is
  still a host process the operator runs); only the amount of typing shrank
  (`REQ-DEPLOYMENT-BOOTSTRAP`).
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
  (`/dispatch status|pause|resume|runs|logs|budget|triggers|insights|settings|set|unset`) and one
  self-refreshing TUI overlay component with **four in-component views**: **LIST** — a framed,
  **theme-colored** panel (color via pi's injected `Theme`, applied post-layout so pi's ANSI-aware
  `visibleWidth` still frames it) carrying a status header, day/week/month **SPEND meters** (colored by the
  same `windowState` the worker enforces) plus a daily **token** counter, a unified **TRIGGERS** pane whose
  `{on, run}` rows are **selectable and editable** (a cron row carries an amber `⚠ overdue`/`⚠ stalled`
  badge joined from its resident scheduler — health is a LIST-level fact, not only a drill-in one), and an
  interactive runs list rendered as a **cursor-following viewport** (10 rows over the read model's
  50-record window, `↑/↓ N more` edge markers) — navigated with `↑↓`, `Tab` jumping between the trigger
  and run section heads, `o` cycling the runs order (time → tokens → cost → outcome; absent numbers sort
  last, the active order is named in the runs divider, and Enter opens the row the *sorted* list shows),
  and `l` jumping straight to the live tail of the active job (inert without one — the key the footer
  always advertised);
  **TRIGGER_DETAIL** — Enter on a trigger opens its filter and a per-kind **trust model** (who authorizes it,
  how it dedups, which service owns it), with `e` edit-flow and `x` delete, the delete armed as an
  **in-frame y/n**: only `y` closes the overlay, carrying `confirmed: true` so the command loop skips the
  duplicate `ctx.ui.confirm` while the write still goes through the shared validate-then-rename
  `writeTriggers` — the question costs a keystroke, not a dispose/reopen cycle; **RUN_DETAIL** — a drill-in
  dump of the selected run's PII-free `.json` run-record fields, walked in place with `←`/`→` (one sandbox
  read per record through the seam; the LIST cursor follows so Esc lands on the record being read); and
  **LIVE_TAIL** — a view that tails a running
  job's `.log` **inside the overlay** through an injected `deps.tailLog` seam whose `fs` read lives in
  `index.ts` (the log CONTENT stays `clip`-stripped and uncolored — only the chrome is themed), opening
  **pinned to the bottom in follow mode**: scrolling up pauses following, reaching the bottom re-arms it,
  and the footer names the state (`follow`/`paused`) so stale lines cannot pass as live. Analytics
  live on the **insights artifact** (`REQ-INSIGHTS-HTML-EXPORT`, issue #181), the ONE surface for
  "what is this deployment wired to do and what does it cost": bare `/dispatch insights` (and the
  overlay's `i` key, which resolves the overlay with a done-action so `index.ts` writes and opens
  the page between overlays — the addTrigger route, no dep seam, no TUI suspend bracket) writes the
  self-contained page **atomically to the stable path** `<graphDir>/insights.html` (tmp+rename —
  stable so re-running updates an already-open tab through the page's own Reload/auto-reload
  controls, atomic so that tab's reload never reads half a file), prints the `file://` URL **first**
  and best-effort opens the platform browser through the worker's shared opener — skipped and said
  over SSH or without a display, `--no-open` always; `insights whatif` keeps the re-pricing
  estimator as a command (its reply goes through the admin channel like every read). The dashboard
  itself carries **no analytics fetch paths at all** anymore: the two per-view refresh policies the
  removed COSTS/GRAPH views needed (the stale-gated tick piggyback; entry-plus-`r`-only around the
  git-spawning enumeration) left with them, and the overlay is back to one snapshot poll plus the
  tail read. The
  extension still **binds no network port at all**: a file with no server is not a surface — nothing
  listens, nothing off-machine gained reachability — so this stays strictly narrower than the
  superseded `127.0.0.1` panel. The artifact carries **run-record fields and operator-authored
  trigger/skill strings only, never `.log` bytes and never a host path beyond the folder's basename**
  — the same placement boundary as everything else here, applied to a file that outlives the session. The
  LLM-callable tools are reads (`status`/`runs`/`triggers`/`costs` — `dispatch_costs` returns the fold as
  JSON whose every monetary value carries its `class`, so a model consuming it cannot launder an estimate
  into a fact), `pause`/`resume`, the gated `dispatch_run`
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
  is dropped. Since issue #54 the read-model additionally carries the graph's data surface: it enumerates
  a cron folder's committed skills from the git object store at HEAD (`readFolderSkills` — the worker's
  own `selectEntries`/`keepOnlyDeclaredSkills` over one hardened `ls-tree`, plus one bounded `cat-file`
  per SKILL.md), lists a trigger's injected skills dir advisorily (`readInjectedSkills`), and folds
  already-scanned run records into the per-trigger and flow→flow joins (`cronRunStats`,
  `joinRunsToTriggers`, `observedChainEdges`) — all never-throw, degrading per folder, bounded by the
  literal-pinned `GRAPH_LIMITS`, and all inside `read-model.mjs`, so the dashboard's fs ban and the
  `.log` placement boundary are untouched. Issue #188 grew the same surface by the two deployment-wide
  tiers, in the same posture: `readOverlaySkills` (a working-tree readdir of the overlay `skills/`,
  existence-only — no frontmatter read, because the flag vocabulary is closed and "never AI-reachable"
  already rides the tip; ENOENT is a legal models-only overlay, so it reads known-empty, while any
  other failure reads unknown) and `readStagedSkillsList` (the worker's own `readStagedSkills` behind
  the `readStagedPackages` wrapper doctrine, manifest order preserved because it is the loader's
  shadowing order), both null — "not checkable from this session", never "empty" — when
  `PI_GLOBAL_PI_DIR` is not visible, one read each per graph build, capped by the same literal-pinned
  `GRAPH_LIMITS`. The enumeration is **display-advisory**: the chain gate's
  truth stays `readFlowGate` at a pre-agent sha (`DES-AI-TRIGGER-FLOW-GATE`), and no graph badge is a
  gate decision.
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
  - *A served graph page (a localhost listener for the HTML view, or live data via a socket)* — the
    exact surface this entry removed, re-proposed with a prettier face; the socket→file substitution
    `DES-JOB-OUTBOX-CHAINING` canonised applies symmetrically here, so the browser view is a written
    artifact and refresh is the page reloading a re-written file, never a connection.
  - *Raw `.log` bytes in the HTML artifact* — the `.log` is untrusted, PII-bearing text whose boundary
    is placement (overlay-viewer-only), not filtering; an escaped copy in a durable file outside the
    overlay would trade that structural defence for an HTML-escaping promise, the one trade this
    design refuses everywhere else.
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

## DES-SUBSCRIPTIONS-ARE-COUNTERFACTUAL-ONLY

- **Decision**: Subscription plan prices live in an **operator-authored file**, `subscriptions.json`
  (`INT-SUBSCRIPTIONS-FILE-CONTRACT`), and feed **counterfactual arithmetic only**: the admin extension
  prices runs that already happened against the declared plans (what did the flat rate really cost, what
  would the same runs have cost at the `counterfactualModel`'s API rates, what would a `hypothetical`
  plan under consideration have cost). The file **never touches auth, routing, or model selection** — no
  declared plan changes which provider a job uses, which credential it carries, or whether it runs. The
  worker exports the shared `parseSubscriptions` validator (the `parseTriggers`/`parsePauseWindows`
  anti-drift idiom) and **reads nothing at job time**; the admin extension is the only reader.
- **Why**:
  - **Zero-rate tables make prepaid look free.** Subscription-backed providers (pi-ai's `kimi-coding`,
    `zai-coding-cn`) ship all-zero rate tables, so every covered run records cost 0 and the spend meters
    report a paid-for plan as a free lunch. The declaration is what turns "cost 0" back into "prepaid at
    a price somebody is actually paying".
  - **The env boundary refuses subscription logins by design.** `env-allowlist.mjs` rejects an
    OAuth/subscription credential deliberately (it expires; an unattended service cannot refresh it), so
    no credential that could name the plan ever reaches the worker — the operator declaration is the
    **only honest price source**, not merely the most convenient one.
  - **Declaring a plan must never become a way to route to it.** A file the admin reads for arithmetic is
    harmless; the same file consulted at job time would be a second model-selection channel that bypasses
    the overlay's precedence and the env boundary's refusal. Keeping the worker out of the file entirely
    makes that misuse unrepresentable rather than merely discouraged.
- **Rejected**:
  - *Vendor usage-API polling* — a new network surface, credentials, and failure modes for numbers
    vendors barely publish; the file's `null`-means-undisclosed unit/limit is the honest version of the
    same ignorance.
  - *Auto-detecting plans from zero-rate tables* — a rate card is not a purchase; a provider whose table
    is zeros says nothing about whether this operator pays for it, at what price, or shared with what.
  - *Overlay keys instead of a file* — the overlay is runtime tuning with fail-closed job-start semantics
    (`DES-RUNTIME-SETTINGS-FILE-OVERLAY`); prices are bookkeeping that no job start should ever refuse
    on, and a versioned, diffable operator file is the right trust class for a declaration.
  - *Routing/auth integration* — reopens the env-allowlist decision this design exists to respect: the
    refusal of subscription logins is the reason the file exists, so the file must never become the
    workaround for it.
- **Traces to**: `DES-ADMIN-VIA-PI-EXTENSION`, `INT-SUBSCRIPTIONS-FILE-CONTRACT`,
  `REQ-TOKEN-ACCOUNTING-AND-CAPS`

## DES-COST-FOLD-BY-SCAN

- **Decision**: Cost aggregation is a **read-only, filename-keyed scan** of the run-history sidecars
  (`scanRunRecords` in the admin read-model — `listRuns`' sibling without the 50-record clamp), bounded by
  `PI_LOG_RETENTION_DAYS` and hard-capped at **92 days** even when retention is the keep-forever `0`, folded
  by a **pure, fs-free module** (`admin/src/costs.mjs`) into per-day/per-flow/per-model aggregates and plan
  verdicts. Classification — metered / plan / zero-rated / estimated / seeded / unknown — happens **at fold
  time and is never stored**: the sidecars hold immutable **facts** (what ran, what it spent, at which
  rates-version), and everything derived from the operator's opinions (`subscriptions.json`, the pinned
  rate tables reached through the worker's `./pricing` export) is recomputed on every fold, so editing a
  subscription retroactively reclassifies history — correctly, because facts and opinions never share a
  file. Every dollar the fold emits is a **typed value** `{ usd, class, floor, coverage }` rendered only by
  the panel's `fmtCost`; a sum stays `metered` only when every addend is, and one estimated addend demotes
  the whole sum visibly. The fold's `window.days` — the denominator every plan proration scales by — comes
  from the **requested** window (`sinceMs`, the same instant the caller cut the scan at, minted by the one
  `costsSinceMs` beside the fold), never from the span the records happen to cover; `firstRunMs` rides
  beside it for renderers that want the observed left edge, and a caller folding an arbitrary record set
  with no window to ask about (`sinceMs: null`) keeps the observed-span derivation.
- **Why**: The records are already the durable store (`DES-RUN-HISTORY-FLAT-FILES-NO-DB`), retention
  already bounds them, and a retention-bounded directory of ≤2KB single-line files folds in milliseconds —
  aggregation earns no second store. Fold-time classification is what keeps the one promise the whole
  screen rests on: an estimate can never be mislabeled as truth, because the label is computed where the
  comparison is made, not persisted where it could go stale.
- **Rejected**:
  - *An embedded analytics store (sqlite / lowdb) or a query layer* — re-refused for exactly
    `DES-RUN-HISTORY-FLAT-FILES-NO-DB`'s reasons: a native build, a second retention authority, query
    power that nothing needs at this size.
  - *Rollup / index files beside the sidecars* — a second source of truth that must be invalidated on
    every retention sweep, every retry overwrite, and every `subscriptions.json` edit; the failure mode is
    a stale rollup silently disagreeing with the records it summarizes, and the win is milliseconds that
    were never being lost.
  - *A redis cost series beside `budget:t:*`* — the budget keys are TTL'd **enforcement state**, not
    history; parking analytics in them couples the screen to counter TTLs and adds a write path to what is
    deliberately a read-only feature.
  - *Storing the classification on the record* — a record written under one subscriptions file lies under
    the next; the fact/opinion split is the design.
  - *Deriving `window.days` from the first observed run* — shipped that way once and refuted (issue #175):
    on a sparse window the proration denominator shrank to the observed span (two runs early in a
    month-to-date question prorated a $99 plan to pocket change), so verdicts read SAVING far too easily.
    The observed span is a fact about the records; the denominator is a fact about the question asked.
  - *The fold re-deriving the trigger join itself* — the per-trigger rollup (issue #175) takes the
    read-model's `attributeRunsToTriggers` result as an ARGUMENT (`triggerJoin`), the injected-pricing
    pattern: the index+type agreement doctrine and the raw `repeat:<id>:<millis>` grammar were
    adversarial-review-hardened once in `read-model.mjs`, and a second implementation inside the fold is
    a fork of that doctrine waiting to drift. The fold stays fs-free and worker-import-free; `byTrigger`
    is null (not empty) when no join was wired, because "not computed" and "nothing attributed" are
    different sentences.
- **Traces to**: `DES-RUN-HISTORY-FLAT-FILES-NO-DB`, `DES-SUBSCRIPTIONS-ARE-COUNTERFACTUAL-ONLY`,
  `INT-PRICING-EXPORT-CONTRACT`, `REQ-TOKEN-ACCOUNTING-AND-CAPS`; implemented in
  `admin/src/read-model.mjs` (`scanRunRecords`) and `admin/src/costs.mjs`.

## DES-GRAPH-EDGE-DERIVATION

- **Decision**: The trigger/flow graph (issue #54) is assembled by **one pure fold**
  (`buildGraphModel`, `admin/src/graph-model.mjs`) over the read-model's outputs, and every edge it
  emits is labelled by its **evidence class**, drawn from a closed, test-pinned vocabulary:
  - **`config`** — trigger → flow, from the live triggers file. Every trigger naming a `run.flow`
    gets exactly one, **always** — dangling, unverifiable and charset-invalid included. Resolution is
    **tier-aware** (issue #188): the repo enumeration first, then — for a cron trigger whose folder
    read succeeded — the trigger's injected `run.skillsDir`, the overlay `skills/` and the staged
    packages, in the loader's own precedence order, so a flow legally living below the repo lands its
    edge on the `injected`/`overlay`/`staged` node that tier enumerates instead of a red twin. A
    target no checkable tier holds exists as a `skill-missing` (every applicable tier checked and
    missed), `skill-not-at-head` (absent at HEAD, some tier not checkable from this session — amber,
    `tiersUnknown` named in the tip) or `skill-unverified` (forge repo / unreachable folder) node so
    the edge has a visible end.
  - **`observed`** — flow → flow, from run records only (`parentJobId` joins), folded per flow pair
    with its **count and last occurrence**. An observed edge exists because a run actually spawned
    another, never because one could. Same-target only; an edge that cannot be hung on exactly one
    enumerated folder is **dropped and counted** (`meta.droppedObservedEdges`), never guessed onto a
    basename that merely matches.
  - **`potential`** — flow → flow, from a **text mention** of a sibling skill's name in a SKILL.md,
    labelled `strong` (near the outbox vocabulary) and `eligible` (the target's own
    `ai-trigger: allow`, the exact static half of the edge). Gate-eligibility alone draws **no
    edge**: it is a node badge, because an all-pairs "could chain" fabric among allow-listed skills
    would bury the informative edges under a combinatorial lie.
  - **`cron-rearm`** — the one self-edge every cron trigger carries by definition, labelled with its
    pattern: config, not history.
  Two structural prohibitions, from `OQ-009`: **no chain edge is ever drawn out of a forge
  trigger's flow** (a forge job gets no `/outbox` mount), and **no chain edge ever crosses
  folders** (the child folder is forced to the parent's own) — the harness makes both
  unrepresentable, so the graph never renders either. Dangling is precise: `no-skill` flags only
  where **every applicable tier was checked and missed** (issue #188 widened the gate's own token
  from one enumeration to the whole ladder, and the detail names the tiers checked — a trigger's
  `run.packages: false` withholds the staged tier as a known miss, worded as such); an
  unreachable or remote folder renders **unverified**, never dangling, and a `run.flow` failing
  `SKILL_NAME_RE` is its own `charset-invalid` flag — the gate would answer `deny` for it, and
  deny proves nothing about existence. The ladder **stops at an unknown tier**, deliberately
  diverging from doctor: doctor answers the existential "does the name resolve anywhere", which a
  hit below an unknown tier satisfies regardless of what shadows it, so doctor probes past unknowns
  (`DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS`); a config edge asserts node **identity** — "the job
  loads THIS file" — and claiming a lower-tier node under an unknown higher tier is exactly the
  wrong tick that spec forbids. An unknown tier (a session without `PI_GLOBAL_PI_DIR` — the
  deployment pointer deliberately cannot carry it — an unreadable listing, a truncated one whose
  miss may sit past the cap, a pattern-manifest package) therefore softens the claim to
  `skill-not-at-head`, never resolves and never flags. Orphanhood is three distinct facts, not one: `orphan` (no
  trigger, no `ai-trigger`, no incoming mention), `ai-reachable-no-trigger` (deliberately
  chain/dispatch_run-reachable), and `injected-ai-trigger` (the `OQ-022` silent no-op, badged
  loudly). Sub-skills are never orphan candidates — the gate's path template has no room for them.
  Every model carries the chain caps (`chainDepthMax`, `chainMaxPerJob`, same-folder-only, the
  record window) and every consumer must render them; the honesty counters (`unattributedRuns`,
  refusals, truncation, dropped edges) ride `meta` for the same reason.
- **Why**: The four gaps issue #54 names are all failures of *assembly*, not of data — every edge
  already exists somewhere in triggers.json, the records, or the object store. What a graph adds is
  precisely the temptation to blur evidence classes: a mention rendered like an observation, a
  gate-eligibility fabric rendered like config, a stale index landing on today's row. So the
  derivation rules are the design, they live in exactly one pure function, and the negative claims
  ("an observed edge never comes from potential-only evidence", "an unreachable folder produces
  zero dangling flags", "a potential edge never carries a count") are asserted as tests, the
  zero-cost-day-versus-absent-day discipline applied to topology.
- **Rejected**:
  - *Declared chain topology in config* — chains are agent-requested at runtime by design
    (`DES-JOB-OUTBOX-CHAINING`); the graph reports what happened and what could, it does not promise
    what will. Issue #54 refuses this explicitly.
  - *An all-pairs "could chain" edge set from gate eligibility* — with N allow-listed skills that is
    N×(N−1) identical arrows; eligibility becomes a badge and a mention becomes the edge, or the
    graph is noise.
  - *Treating `deny` as dangling* — `deny` conflates a missing gate opt-in, a bad sha, and a git
    failure; only `no-skill` means "absent", and a graph that flags `deny` as dangling tells an
    operator to delete a trigger whose skill exists.
  - *Resolving ambiguous observed-edge targets by first match* — pins real history onto the wrong
    folder's skills; dropped-and-counted is honest, guessed is not.
  - *Claiming a lower-tier node under an unknown higher tier* (issue #188) — doctor's existential ✓
    survives an unknown above a hit; an identity edge does not, because the unknown tier may shadow
    the hit at load time and the edge would point at content the job never runs. Softened, not
    resolved.
  - *A new flag or edge kind for tier resolution* (issue #188) — `REQ-TOPOLOGY-GRAPH` (h) promises
    the closed vocabularies stay closed, and resolution honesty fits in node kinds and node facts;
    the kinds themselves became the third closed pinned set instead of staying an informal literal
    scatter.
- **Traces to**: `DES-ADMIN-VIA-PI-EXTENSION`, `DES-JOB-OUTBOX-CHAINING`, `DES-AI-TRIGGER-FLOW-GATE`,
  `DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS`, `REQ-GLOBAL-PI-OVERLAY`, `REQ-PER-TRIGGER-SKILLS`,
  `OQ-008`, `OQ-009`, `OQ-022`, `INT-RUN-HISTORY-FILE-CONTRACT`; implemented in
  `admin/src/graph-model.mjs` (`buildGraphModel`) over `admin/src/read-model.mjs`'s graph readers.

## DES-RUNTIME-SETTINGS-FILE-OVERLAY

- **Decision**: Runtime-tunable settings are a flat `settings.json` **overlay** — path `PI_SETTINGS_FILE`,
  default `<OS temp>/pi-dispatch/settings.json` — written **atomically** (tmp + rename) by the admin
  extension and **re-read by the worker at each job start**. The keys are exactly `model`, `provider`
  (non-empty strings), `maxTurns`, `dailyCap`, `weeklyCap`, `monthlyCap`, `maxTokens`, `dailyTokenCap`
  (int ≥1), `concurrency` (int 1–10), and `softHoldPct` (int 1–99) — plus `secretProfiles`, which rides
  the same file operator-only, deliberately outside `KNOWN_KEYS` (`INT-CONFIG-OVERLAY-CONTRACT`).
  `weeklyCap`/`monthlyCap`/`softHoldPct` are optional ceilings/band that
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
    enqueue and run is not re-checked for the in-flight job. The window is bounded by both producers being
    **host-trusted** — the operator (`dispatch_run`) or the worker (outbox), not the adversarial container —
    and, for an ordinary job, by the daily cap (`CONST-BUDGET-BEFORE-TOKENS`), since a queue that cannot
    start jobs cannot widen this window either.

    **That second bound does NOT hold for a held job** (`REQ-WAIT-FOR`, issue #230), and the correction is
    recorded rather than left to be discovered: a job waiting on `run.waitFor` consumes no budget while it
    waits — the gate sits above `reserveBudget` precisely so it does not — so the daily cap is not a ceiling
    on how long the window can stay open. What bounds it instead is the ceiling on the condition itself:
    `PI_WAIT_AFTER_MAX_MS` for an instant, `PI_WAIT_MAX_MS` for a polled hold. A revocation merged during
    that window still does not stop the job it was written to stop, which is the same residual this bullet
    always described, now with an honest number attached. Re-reading the gate at fire time is the closure
    and is host-side and free; it is deferred because it would add a run-path read for every job to fix a
    window only held jobs can widen. `OQ-029` carries the neighbouring residual about WHO chooses the moment.
  - **A local agent can commit `ai-trigger: allow`.** An agent that can write a folder can commit the
    opt-in to it, after which a **later** operator or CLI action could run that flow. This is bounded by the
    local trust model — "whatever can write the folder can trigger it" (`SECURITY.md`) — and is not a
    self-authorization within the same job, which the pre-agent SHA forecloses.
- **Rejected**: reading the **working tree** rather than the object store — it reintroduces exactly the two
  holes the pinned-SHA read closes: an agent self-opening the gate by writing `SKILL.md` mid-run, and a
  symlink bypass that a blob-only object-store read cannot follow.
- **Injected skills are trigger-reachable and NEVER AI-reachable, and that falls out rather than being
  built** (`REQ-PER-TRIGGER-SKILLS`, issue #60). This gate reads `.pi/skills/<flow>/SKILL.md` from the
  serviced repo's git OBJECT STORE at a pre-agent sha. A skill injected from the worker host has no
  object-store presence at all, so the read finds nothing, the gate returns `no-skill`, and both callers
  refuse. No new code, and the fail-closed direction is the right one: an operator's own reviewed
  `triggers.json` entry is the authorization for a TRIGGER to run an injected flow, and that is a
  different question from which flows a MODEL may fire.
  The corollary is the part an operator cannot discover unaided, so it is stated rather than left implicit:
  an injected `SKILL.md` carrying `ai-trigger: allow` is **never read**, and writing one is a silent no-op.
  `doctor` warns when it finds one. Making injected skills AI-reachable was considered and refused for v1:
  the opt-in would live in a tree the operator can edit at runtime, outside the merge gate that makes the
  frontmatter meaningful, so the right shape would be an operator allowlist rather than frontmatter — the
  same reasoning `REQ-GLOBAL-PI-OVERLAY` gives for refusing repo-declared packages. Residual `OQ-022`.
- **Commands are never AI-reachable either, and unlike injected skills that is BUILT rather than falling
  out** (issue #189, `DES-COMMAND-ENTRY-POINT`). The injected-skill asymmetry above costs no code because
  the gate's object-store read finds nothing; a command CANNOT be left to that mechanism, because there is
  no committed artifact for the gate to read at all — the dispatch line is built at the two producers
  from the reviewed `triggers.json`, not read from a reviewed `SKILL.md`, so default-deny cannot be a
  frontmatter read and is a refusal instead. The outbox collector refuses any request carrying a
  `command` key outright (`chain-command-refused`, before the charset check, with no opt-in —
  `INT-OUTBOX-CONTRACT`), and `dispatch_run` is structurally incapable (its params are
  `{folder, flow, task}`; a slash-leading `flow` refuses with a message naming the distinction rather
  than falling through to a confusing `no-skill`). `dispatch_trigger_add`/`_edit` carry no `command`
  parameter. If the asymmetry ever closes, `OQ-022`'s closing shape — an explicit allowlist in the
  reviewed `triggers.json` — is the right form here too, and frontmatter is the right form for neither.
- **Traces to**: `CONST-TRIGGER-AUTHOR-GATE`, `CONST-NO-CONTEXT-FILES-MANDATORY`,
  `CONST-BUDGET-BEFORE-TOKENS`, `DES-ADMIN-VIA-PI-EXTENSION`, `DES-COMMAND-ENTRY-POINT`, `OQ-022`

## DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS

- **Decision** (issue #189): whether a trigger's `run.flow` actually resolves to a skill is verified at two
  **advisory** layers, and refused at neither. The **runner** is the exact layer: the worker forwards the
  flow name structurally (`PI_FLOW`, `INT-CONTAINER-JOB-INPUTS`), and after the resource loader builds —
  before any session or spend — the runner compares it against the **loaded** skill names and emits one
  `flow_not_loaded` line on a miss (`isFlowLoaded`, exact name equality; a `disableModelInvocation` skill
  counts, it is invocable even though uncatalogued). **Doctor** is the approximate host-side layer: one
  line per distinct (flow, folder, skillsDir, packages) question, probing the tiers in the loader's own
  precedence order — repo `.pi/skills` at HEAD (the gate's ls-tree read and 100644-blob rule, but
  HEAD-resolved by doctor itself and degrading to "unknown" on git failure, because the gate's
  fail-closed catch would print a confident wrong answer on an advisory line, and its no-ref rule
  defends against an agent that a host-side preflight does not have), injected `run.skillsDir`, overlay
  `skills/`, then staged packages via `readStagedSkills` (pi's manifest-vs-convention rule at the pin;
  glob/override manifests make a package "not enumerable" rather than guessed at, because patterns can
  also DISABLE files and a wrong ✓ is the one direction an advisory may not err in). ⚠ never ✗, no fix
  action, zero triggers add zero lines; a staged-package-only ✓ is deliberate (legal steady state). The
  job itself proceeds.
- **Why**: the flow reaches the model only as prompt prose (`Use the "X" skill`), and pi never matches
  prose against loaded skill names — so a flow that materialised in no tier ran to a clean exit 0 without
  the procedure it was written for, reporting success for work it could not have done. That is this
  project's branded worst outcome ("a silent no-op"), already refused pre-spend for its sibling
  (an unmounted package root, `assertPackagePathsExist`). The runner layer is exact where every host-side
  answer is an approximation: pi names a skill `frontmatter.name || parentDirName` at the pin, so only the
  loaded set is authoritative — which is also why the check needs `PI_FLOW` rather than re-deriving
  anything, and why `getSkills()` is read unconditionally rather than only for packaged jobs.
- **Why report rather than refuse, deliberately**: `run.flow` is by long doctrine a prompt *hint*
  (`prepare.mjs`), and deployments legitimately run flows as loose hints over repos with no `.pi/skills` —
  the runner cannot distinguish that steady state from breakage, and a refusal shipped in an image
  upgrade would fail yesterday's jobs for a value the reviewed file has carried all along (it would also
  burn the reserved budget slot per refusal, paying for zero work on every delivery of a misconfigured
  trigger). The check sits at the pre-spend moment anyway, so flipping report to refusal is a one-line
  change plus a row here. The residual is stated: an advisory line at 03:00 helps only an operator who
  reads logs; doctor's per-trigger lines are the layer that reaches them earlier, and (issue #188) the
  topology renders the same host-side approximation as a third advisory surface — with one deliberate
  divergence recorded on `DES-GRAPH-EDGE-DERIVATION`: doctor's ✓ is existential and probes past an
  unknown tier, while a config edge claims node identity and therefore stops at one.
- **Rejected**: failing worker/receiver **boot** on an unresolved flow (`parseTriggers` is pure and
  fs-free by `DES-TRIGGERS-UNIFIED-FILE`, the receiver may run on a host with no repo, and overlay and
  package tiers make "absent at HEAD" a legal steady state); carrying the flow in `event.json` (an
  execution knob is not a fact about the delivery — `run.replicas` precedent); a new top-level outcome
  for the miss (admin surfaces bucket outcomes into a closed set and silently drop unknowns, so new
  vocabulary must ride a `reason`, and an advisory line needs neither).
- **Traces to**: `INT-CONTAINER-JOB-INPUTS`, `REQ-PER-TRIGGER-SKILLS`, `REQ-GLOBAL-PI-OVERLAY`,
  `DES-AI-TRIGGER-FLOW-GATE` (a WHAT-exists question, deliberately distinct from its WHO-may-fire gate),
  `CONST-BUDGET-BEFORE-TOKENS`

## DES-COMMAND-ENTRY-POINT

- **Decision** (issue #189, Gap 2): a trigger may name a **registered pi extension command** instead of a
  flow — `run.command` (this entry records the runner's dispatch protocol, which shipped first; the
  producer-half bullet below completes it). The worker forwards the command line as `PI_COMMAND`;
  the runner rebuilds the prompt as `/<command>` — **the whole prompt, not a first line**, because pi's
  dispatch grammar at the pin fires only when the entire text starts with `/`, parses the name to the
  first space, and hands everything after (newlines included) to the handler as args verbatim. Before
  prompting, the runner verifies the name via `session.extensionRunner.getCommand()` and refuses an
  unregistered one as `command-unregistered` (exit 2, pre-spend). A handler throw — which pi SWALLOWS,
  resolving `prompt()` cleanly — is observed via the public `extensionRunner.onError` channel, the only
  place it surfaces at the pin, and classified `command-error`. A clean headless return is
  `command-completed`, exit 0. The docs' old premise ("an extension that registers a slash command has
  nobody to type it inside a job") is contradicted by the pinned contract itself: `session.prompt()`
  "Handles extension commands immediately", and the pinned-contract test drives a REAL session through
  all of it, keylessly — dispatch happens before any model or auth validation.
- **Why env-authoritative rather than prompt.md-authoritative**: one in-container authority. If the
  runner read `prompt.md` and classified by `PI_COMMAND`, a worker bug writing mismatched halves would
  classify a flow job as `command-completed` — a wrong exit 0. Rebuilt from the env var, the prompt and
  the classification cannot disagree; `prompt.md` stays the byte-identical human record.
- **Why `command-error` is retryable (exit 1), by explicit choice**: pi hands the runner a message
  string, so transient-vs-deterministic is undecidable at the only observation point that exists. The
  chosen direction pays to retry a deterministic extension bug until the queue's attempts run out; the
  alternative (policy, no retry) silently drops work on a transient fault a retry would have absorbed.
  Recorded rather than argued around: `CONST-RETRY-INFRA-ONLY` classifies by failure MODE, and an
  unattributable failure was ruled to default to the retryable side. Genuinely transient provider
  errors inside a handler-driven turn never depended on this choice — they surface as
  `stopReason: "error"` on a real terminal message and stay retryable through the ordinary path.
- **Documented residual**: a handler that fires async work and returns without `waitForIdle()`
  classifies `command-completed` at return and the session is disposed — that is `prompt()`'s own
  contract, not this project's to repair.
- **The template half of the fall-through hazard** (issue #189, closing pass): `getCommand()`
  verification forecloses an UNREGISTERED `/name` reaching a same-named prompt template, but a package
  template that shadows a REPO template of the same name was invisible to it — the command dispatches
  nothing, yet what `/name` means as a template has silently changed owner. `promptsOverride`
  (`INT-SDK-SESSION-OPTIONS`) closes that half: repo and overlay templates are protected against
  package shadowing exactly as skills are, so both halves of "what does /name run" are now pinned to
  reviewed content.
- **The `commands` image capability** is what makes shipping the runner ahead of the trigger field safe
  in both directions: an older runner handed `PI_COMMAND` would ignore it, read `prompt.md`, and either
  feed `/name args` to the model as prose or die retryable on `no-terminal-message` — so the worker
  refuses a command job on a non-declaring image pre-spend, the `replicas` pattern verbatim.
  `verify-image.sh` asserts the label against the baked runner source, so the claim cannot lie.
- **Producer half (issue #189, Gap 2 — the trigger-schema half, landing second)**: `run.command` is legal
  on **all four** trigger kinds — a label, comment or PR event may dispatch a command exactly as cron may,
  on `run.skillsDir`'s reasoning (a command is a capability of the deployment's vetted extensions, and a
  webhook trigger runs what a cron trigger runs) — with EXACTLY ONE of `run.flow`/`run.command` enforced
  at parse in both services by the shared validator (`INT-TRIGGERS-FILE-CONTRACT` holds the field's full
  contract: value validation mirroring the runner's, the `task`/`instructions`/`resume` refusals, the
  static-args doctrine). The prompt is **exactly `/<command> [args]` for forge jobs too**: the envelope is
  bypassed whole, and the delivery reaches the handler only as `/job/event.json` — which answers
  `DES-TRIGGER-INSTRUCTION-IN-THE-ENVELOPE`'s byte-for-byte objection head-on. That entry refused an
  envelope change because it would rewrite every EXISTING cron job's `prompt.md`; a command prompt is a
  NEW prompt for a NEW trigger shape, and every existing flow trigger's `prompt.md` stays byte-identical,
  so the objection's premise is honoured rather than argued around. The forge semantic-dedup key carries
  the **`cmd:`-prefixed command in the flow slot**, so a command rule and a flow rule spelling the same
  name never coalesce inside the dedup TTL. The `commands` capability gate is now **enforced worker-side
  pre-spend** (`job-image-commands-unsupported`, budget unreserved — the second direction the label was
  built for). The comment trigger's trailing-word override is **INERT on a command rule**: the channel
  that lets a collaborator retarget a flow must not let one retarget or SUPPRESS a command, so trailing
  text is data via `event.json`. And commands are **never AI-reachable, stricter than flows** — built at
  the producers, refused at both model-reachable ones (`DES-AI-TRIGGER-FLOW-GATE` records the mechanism
  and the `OQ-022` inversion).
- **Rejected**: the command as the first line of a larger prompt (impossible at the pin — the remainder
  becomes handler args); retrying nothing / policy on handler throws (above); `prompt.md` as the
  in-container authority (above); skipping pre-verification and letting pi's fall-through handle typos
  (an unregistered `/name` is NOT an error to pi — it rides template expansion into a paid model call,
  or into a same-named prompt template if one is staged, both silent).
- **Traces to**: `INT-RUNNER-EXIT-CODE-PROTOCOL`, `INT-CONTAINER-JOB-INPUTS`,
  `INT-TRIGGERS-FILE-CONTRACT`, `INT-OUTBOX-CONTRACT`, `CONST-RETRY-INFRA-ONLY`,
  `CONST-BUDGET-BEFORE-TOKENS`, `CONST-ISSUE-TEXT-IS-DATA`, `REQ-UPSTREAM-CONTRACT-TESTS`,
  `DES-PER-TRIGGER-JOB-IMAGE` (the capability-label pattern), `DES-AI-TRIGGER-FLOW-GATE`,
  `DES-TRIGGER-INSTRUCTION-IN-THE-ENVELOPE`

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
  - **A `command` key refuses outright, and the refusal is explicit rather than ignored** (issue #189):
    the validation ladder gains `chain-command-refused`, ordered before the flow-name charset check.
    Commands may chain OUT — a local command job keeps its `/outbox`, and its requests name flows under
    the same gate — but nothing chains INTO a command: there is no committed artifact the `ai-trigger`
    gate could read for one, and dropping the key under the unknown-keys rule would enqueue a flow the
    agent did not request. `DES-AI-TRIGGER-FLOW-GATE` records why this is built rather than fallen out.
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

## DES-TRIGGER-INSTRUCTION-IN-THE-ENVELOPE

- **Decision**: `run.instructions` is rendered into the USER prompt's **envelope** -- above the fenced
  data region, below the harness's numbered steps, and **before** the never-merge paragraph -- as a
  provenance-labelled block with no `##` heading and no fence. One shared `instructionBlock` serves all
  four forge builders. `dataRegion` is untouched.
- **Why**: `CONST-ISSUE-TEXT-IS-DATA` governs event PAYLOADS. This is operator text from a reviewed,
  git-tracked file, which passes the same mutability test `DES-FLOWS-ARE-DATA-PERSONA-IS-CODE` already
  applies to the overlay persona: "Mutability, not the persona/flow label, is the boundary." So it may be
  read as instruction. It goes **before** the never-merge paragraph because later text reads as more
  specific, and the harness's non-negotiables must be the last thing before the data region rather than
  something an operator instruction appears to qualify -- that costs nothing and forecloses the argument.
  Putting it in the envelope is also what leaves `dataRegion` alone: the shared export keeps its
  signature, so the "new parameters go LAST" rule is honoured without threading a hole through three
  sibling forges.
- **Command jobs (issue #189) have no envelope at all, and the field is refused beside `run.command`
  rather than left inert**: a command job's prompt is exactly the dispatch line
  (`DES-COMMAND-ENTRY-POINT`), so the region this entry places text into never exists for one — the same
  accepted-where-it-does-nothing hazard the cron refusal answers, arriving through a bypassed envelope
  instead of a missing one. The byte-for-byte reasoning recorded under Rejected below ("giving local jobs
  an envelope…") is untouched by the bypass: a command prompt is a NEW prompt for a NEW trigger shape, and
  every existing flow trigger's `prompt.md` stays byte-identical.
- **Rejected**:
  - *Inside the fenced data region* — self-defeating. `dataRegion` tells the model that everything below
    its heading is data and that anything in it trying to give new rules must be reported rather than
    obeyed. A standing instruction placed there is a field documented to be ignored, which is the
    accepted-where-it-does-nothing hazard `validateReplicas`' docstring exists to prevent.
  - *The system prompt, as a `/job` file in `appendSystemPromptOverride`* — it would work and would be
    marginally cheaper per turn, and it is still wrong. Every other member of that layer is read from a
    FIXED FILE PATH once at loader build, which is the shape `CONST-PERSONA-IN-CACHED-PREFIX`'s acceptance
    leans on; and `run.task`, the existing operator free-text field, is already contracted user-prompt-only
    (`INT-TRIGGERS-FILE-CONTRACT`). Two operator text fields with two different placements would be an
    incoherence the next reader has to resolve.
  - *Reusing `run.task` on webhook triggers* — `run.task` is contracted as DATA landing in `prompt.md`
    below the delimiter, and a webhook job's data is the issue text. Overloading it would give one field
    two placements depending on `on.type`.
  - *Giving local jobs an envelope so cron could take the field too* — it would change every existing
    cron job's `prompt.md` byte-for-byte, a behaviour change unrelated to this feature and one that
    `INT-TRIGGERS-FILE-CONTRACT`'s byte-match acceptance would have to be amended for. Cron is refused
    instead, pointing at `run.task`.
  - *Content-filtering the operator's text* — the module docstring already refuses this reasoning for the
    payload and it applies here too: placement is the boundary, the delimiter is defence in depth. An
    operator who writes a fake data heading into their own instruction has forged nothing, because the
    real heading is emitted after theirs and still opens the real region.
- **Traces to**: `REQ-PER-TRIGGER-INSTRUCTION`, `CONST-ISSUE-TEXT-IS-DATA`,
  `CONST-PERSONA-IN-CACHED-PREFIX`, `INT-CONTAINER-JOB-INPUTS`, `DES-FLOWS-ARE-DATA-PERSONA-IS-CODE`

## DES-TRIGGER-SKILLS-COPIED-NOT-MOUNTED

- **Decision**: A trigger's `run.skillsDir` is **copied**, per job, into `<jobDir>/trigger-skills`, and
  reaches the container at `/job/trigger-skills` on the `/job:ro` bind that already exists. No mount is
  added. The copier is `worker/src/copy-tree.mjs`, shared with `import-pi`. Precedence is repo > injected
  > overlay, in `additionalSkillPaths` and again in `skillsOverride`'s protected roots.
- **Why**: Three reasons, and the mount-count one is the weakest of them.
  **The copy is the pin.** `:ro` bounds the CONTAINER, not the host. pi reads a skill's body on demand
  through the read tool, so under a live bind an operator editing their skills directory would change the
  instructions of a job already running. Copying gives the injected tier exactly the property
  `INT-CONTAINER-JOB-INPUTS` cites for materialising `.pi/` rather than letting pi discover it: the agent
  cannot be handed a moving target.
  **Symlinks get answered once, on the side that can answer them.** `loadSkillsFromDirInternal` follows
  both file and directory symlinks. Under a mount, a directory symlink pointing at `/` would turn skill
  discovery into a walk of the container filesystem, and one pointing into `/workspace` would alias
  repo-controlled content into the operator-trusted tier. The host-side copier refuses links outright, so
  the tree pi walks contains none.
  **And it adds no mount.** `CONST-ISOLATION-CONTAINER-PER-JOB`'s acceptance ENUMERATES the mounts, and
  this entry's sibling already refused a mount for staged packages on exactly that trade. A per-trigger
  mount would be a worse case than the one the 2026-07-31 `/session` row argues for: `/session` is at
  least worker-created and per-job, whereas this source is operator-named and shared across every job of
  the trigger.
  A fourth, smaller: `retainJobDir` renames the whole job dir and `buildSandboxRunArgs` re-mounts it, so a
  resurrected sandbox sees the skills the run actually saw, rather than re-reading a host directory that
  may have changed since.
- **Rejected**:
  - *A per-trigger `:ro` bind of the operator's directory* — the shape the issue originally sketched. It
    costs an amendment to a constitutional enumeration for zero capability the copy lacks, and it is
    weaker on three counts (the source can change under a running agent, the tree pi walks keeps whatever
    symlinks the operator's tree has, and a resurrected sandbox re-mounts a moving target). The one thing
    it buys, no per-job copy cost, is bought back by the caps. Honestly qualified: a bind's source path is
    also legible from inside the container via `/proc/self/mountinfo`, which is host-layout disclosure the
    design otherwise avoids — an increment rather than a new class, since `/job` and `/workspace` already
    bind host paths.
  - *Copy into the existing `/job/pi/skills`* — it would make repo skills and injected skills
    indistinguishable, so precedence between them would be decided by copy order rather than a stated
    rule, and it would put host-filesystem bytes into the tree whose acceptance promises "no host file
    content anywhere in `/job`", making that clause ambiguous exactly where it must not be.
  - *A host-side cache or hardlink farm shared across jobs* — cross-job host state is what
    `CONST-ISOLATION-CONTAINER-PER-JOB`'s "none host-wide" clause excludes, and a hardlink is the same
    inode the operator can rewrite mid-run, which forfeits the pin the copy exists to provide.
  - *An env var telling the runner where the injected root is* — a second source of truth that can
    disagree with the filesystem, silently and in the expensive direction (a variable set, a directory
    that did not land, a job running without the skills its flow was written for). The worker creates the
    directory only when the trigger set the field, so PRESENCE is the signal and `existsSync` is the whole
    detection. `CONST-NO-CONTEXT-FILES-MANDATORY`'s "no env knob for this, deliberately" is the same
    instinct, and `PI_PACKAGES` is not a counter-example: package paths are operator-chosen and variable
    in count, so they must be told; this root is a fixed constant whose only variable is existence.
- **Traces to**: `REQ-PER-TRIGGER-SKILLS`, `INT-CONTAINER-JOB-INPUTS`, `INT-TRIGGERS-FILE-CONTRACT`,
  `CONST-ISOLATION-CONTAINER-PER-JOB`, `DES-OPERATOR-GLOBAL-OVERLAY`

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
- **Discovery of the host's own packages (issue #102), and the four calls it turned on**:
  - *Read pi's `settings.json`, do not walk `<agentDir>/npm/node_modules`.* pi installs with plain npm and
    default hoisting, so in that tree an installed package and a transitive dependency are
    **indistinguishable**; a walk would stage third-party code into every job container because it happened
    to be hoisted next to something the operator did ask for. Settings carries intent, git sources and
    enablement. The one thing it lacks is a trustworthy version — it stores the spec verbatim, which may be
    a range — so the pin is read off the installed `package.json`, the same field pi itself reads. We
    **capture** a version, never inherit one, which is how `CONST-PI-VERSION-PINNED` survives a road the
    operator did not type. When settings is absent or malformed, discovery yields nothing and explicitly
    does **not** fall back to the walk: inferring intent from a hoisted tree would be worst exactly when
    the operator's config is already broken.
  - *A package with no `pi` key but a convention dir IS a pi package.* The issue proposed requiring the
    `pi` key. At the 0.80.7 pin `collectPackageResources` falls through to `extensions/ skills/ prompts/
    themes/` when the manifest is absent, so requiring the key would have silently dropped a legitimate
    class. The stager already had the right predicate; discovery reuses it rather than restating it.
  - *On by default inside `--with-packages`, rather than an opt-in flag for one release.* A flagless
    `import-pi` still stages no packages, before and after, so the only run whose behaviour moves is one
    that already asked for "the packages" and until now silently got a subset excluding exactly what
    `pi install` had put there. An opt-in release was **rejected** for the reason this entry already
    records for extensions: an overlay that is present but dormant is a deployment silently missing the
    setup its flows were written against, and it costs two behaviour changes instead of one. What makes
    that defensible is that the printed list now carries provenance per entry, and that `doctor --fix`'s
    restage offer was narrowed to `--no-host-packages` in the same change — the one automated path stays a
    **repair**, so importing is always something the operator typed.
  - *All-or-nothing scoped to the declared set.* A declared pin that fails still refuses everything. A
    discovered one is dropped with a printed reason, because discovery multiplies the entry count from two
    pins to twenty and one bad host package must not zero an overlay that was working. This does not
    weaken the original rule, which was about **silence**: a named drop is not a silent skip.
  - Rejected here too: *reproducing pi's enablement state for skills, prompts and themes.* Only
    `extensions/` is the sharp edge (it runs code in every job), and every additional mirrored internal is
    another thing that can drift out from under us. A glob in an enablement pattern is **not evaluated** at
    all — we carry no matcher — so the extension is copied and the command says it could not honour the
    pattern. Fail open, and say which. That reach, together with git-sourced packages and project-local
    installs, is `OQ-019`, recorded rather than glossed.
  - **What this design buys with an unexported dependency, stated as a cost.** `worker/src/host-pi.mjs`
    reimplements two pi internals that have no public equivalent: the user-scope install-path lookup and
    the enablement grammar. Two pins at different distances bound it — a contract test against the resolved
    artifact, a canary against `latest`, sharing one needle list — but neither catches a mirror that was
    reading the wrong lines from the start. The residual is `OQ-018`, and it is the reason the bullet above
    resists widening the mirror further.
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

## DES-SCOPED-LIMITS-AND-FOLDER-MUTEX

- **Decision** (issue #242): Per-scope run caps and per-scope concurrency live in a watched operator
  file, `scoped-limits.json` (`INT-SCOPED-LIMITS-FILE-CONTRACT`), on the pause-windows pattern: shared
  parser, boot-load fail-loud, directory watcher keeping last-good, one mutable ref read once per
  pickup. The money windows reserve through `reserveBudget`'s existing `keyPrefix` seam under
  `budget:s:<16-hex sha256 of the canonical scope>` — SCOPED FIRST, so a noisy scope's refusals never
  consume a global slot, with the compensating release when the GLOBAL window refuses after a scoped
  reserve committed (either order has a victim: scoped-second lets a scope's storm burn global slots,
  scoped-first-without-the-release lets a spent global cap drain every arriving scope's week and month
  with zero runs; the release eliminates the second victim while refused-still-counts stays intact for
  the scope's OWN refusals). Concurrency is a DEFERRAL at the pickup gate (fixed re-check,
  `SCOPE_BUSY_RECHECK_MS`), never a refusal. The one-job-per-folder mutex for local jobs is CODE —
  structural ceiling 1, `min()`-composed with any configured value, no file, no tool, no off-switch —
  because two agents in one bind-mounted working tree is the race `run.replicas` is refused for, and a
  cron trigger reaches it with no operator mistake at all (`DES-CRON-VIA-BULLMQ-SCHEDULER`, corrected).
- **Why a file and not the overlay**: the deferral gate runs ABOVE the per-job settings read, so
  gate-read config must come from a watched mutable ref; and `KNOWN_KEYS` is a flat scalar list whose
  one map-shaped resident (`secretProfiles`) is deliberately model-unreachable — the opposite of the
  editability these limits require.
- **Why the count is process memory**: recorded on `DES-CONCURRENCY-3`'s second axis — one worker per
  daemon, reaper-before-drain, and the `OQ-008` two-sources-of-truth refusal of a Redis-held claim.
- **Deferral economics**: 5s re-check ⇒ at most ~360 wakes across a worst-case 30-minute hold, each
  ~1ms of synchronous predicate; a same-folder chained child (enqueued before its parent's release)
  pays exactly one re-check. No per-scope FIFO is promised — deferral is a gate, not a queue, and a
  sustained same-scope arrival rate can starve an individual waiter. Each wake's re-delay is one more
  transient-redis exposure; `attempts: 2` absorbs a single blip.
- **The admin surface** (issue #242's third slice): the pause-windows stack copied — confirm-gated
  `dispatch_limit_*` tools plus the panel's `m` key. The `m` hint lives in the section DIVIDER, not the
  footer: the footer's own width arithmetic (its review-gate comment) has no headroom for another hint,
  and `s`/`o`/Tab already use the divider route. The panel's status line shows the queue's `delayed`
  count only when nonzero and NEUTRAL — the delayed set is dominated by cron next-occurrences (one
  permanent entry per scheduler), so an amber-on-any would be always-on noise. Concurrency displays as
  configuration only, on the no-invented-numbers doctrine.
- **Rejected**:
  - *BullMQ Pro group concurrency/rate limits* — a paid dependency for exactly this feature, and it
    moves scope enforcement into the queue layer where a group-held job's budget semantics are
    undefined against `CONST-BUDGET-BEFORE-TOKENS`.
  - *The dead `limiter` option* — BullMQ's limiter is global, not per-key (recorded further up this
    file), and a rate is not a concurrency.
  - *`PI_CONCURRENCY=1`* — serializes the world to fix one folder, and an overlay edit can silently
    raise it again; the corrected cron claim must not depend on a setting.
  - *Per-trigger `run.*` fields* — many triggers feed one repo, so the scope is the wrong shape; and
    limits are runtime controls, not reviewed trigger content.
  - *An overlay map key* — see "why a file" above.
  - *Redis in-flight counters* — see "why process memory" above, and see
    `DES-FLEET-LEASES-FOR-SHARED-BOUNDS` for the two cases issue #57 carved out of it. That refusal is
    narrowed rather than reversed: it holds for the LOCAL folder mutex, where routing makes the
    in-process count complete anyway, and it is answered for the two bounds that describe a
    deployment rather than a process.
- **Traces to**: `REQ-SCOPED-LIMITS`, `INT-SCOPED-LIMITS-FILE-CONTRACT`, `DES-CONCURRENCY-3`,
  `DES-SCOPED-PAUSE-VIA-MOVE-TO-DELAYED` (the seam), `CONST-BUDGET-BEFORE-TOKENS`, `CONST-RETRY-INFRA-ONLY`

---

## DES-WAIT-FOR-HOLDS-AND-WAIT-PROFILES

- **Decision** (issue #230): `run.waitFor` holds a job at the PICKUP GATE, third in the stack — after the
  pause gate, before the scope acquire — using `DES-SCOPED-PAUSE-VIA-MOVE-TO-DELAYED`'s seam unchanged
  (`moveToDelayed` + `DelayedError`, strictly above the processor's `try`). An `after` defers once to the
  operator's own instant and polls nothing. A `profile` is answered by an operator-declared executable run
  HOST-SIDE, pre-spend, on the secret resolver's model and with its shape reduced: argv array, `shell:
  false`, stdin ignored, both streams byte-counted rather than read, SIGTERM then SIGKILL, its own timeout,
  and the processor's own abort signal. Verdicts speak `INT-RUNNER-EXIT-CODE-PROTOCOL`'s wait-profile
  table, which is where the fourth code lives.

- **Why the gate and not `runJob`**: the issue proposed running the check where the secrets resolver sits
  and threading a "hold me until T" answer back to the wrapper. That is strictly worse and unnecessary.
  `runJob` is below the `try`, so nothing there can defer, and a hold threaded back would mint a `runJob`
  outcome the enum does not have. Both of the stated blockers dissolve at the gate: the abort `signal` is
  the processor's own THIRD PARAMETER, in scope on line one, and a check brings its own timeout, which is
  tighter than the 30-minute kill timer it was said to need.

- **Why the order within the gate is refusals-then-holds**: `CONST-BUDGET-BEFORE-TOKENS`' shape applied to
  time. A condition this deployment cannot answer must be refused now, not after a day of waiting, so the
  determinate refusals run before the free hold and the free hold runs before the expensive check.

- **Why the position is between pause and scope**: a paused job must not burn a wait evaluation (the scope
  gate's own argument for sitting second), and a job that will sit until tomorrow must not hold the folder
  mutex while it does.

- **Why wait profiles are env-only**: `getSettings` is read INSIDE the `try`, below this gate, so an
  overlay-declared profile could not be seen by the gate that would run it. A key that cannot be honoured
  must not be offerable, which is also why none joins `KNOWN_KEYS` and why there is no
  `PI_WAIT_RESOLVER_ROOTS` twin: `PI_SECRET_RESOLVER_ROOTS` exists to bound paths arriving from the
  overlay, and here there is no overlay half to bound.

- **Why a small `wait:` keyspace and not `job.timestamp`**: `job.timestamp` is the ENQUEUE instant, so it
  counts pause-window, scope-mutex and backoff time as "waited" — a job enqueued into a quiet window would
  burn ten hours of its budget before the first check existed, and the panel would report the same wrong
  number. The keyspace also carries the supersede lease, without which two deliveries for one target would
  both hold and both be paid. This is NOT the Redis state `OQ-008` refused: that was a claim that would
  survive a crash wrongly; this describes delayed jobs, which are Redis-persisted already, every key is
  TTL'd to the hold it names, and the supersede path verifies before it refuses.

- **Where the skew detector lives, and why not at the gate**: as a pre-spend check inside `runJob`, beside
  the one-shot check rather than as a fourth gate arm. It never DEFERS, so it needs nothing the gate
  provides, and there it joins the free-refusal ladder that already runs before the mint, the clone and the
  reservation. The cost of the placement is stated rather than discovered: a skewed job takes and releases
  the folder mutex and arms the kill timer before refusing, which is wasted but not incorrect. The relative
  order of the two is unobservable, because a skewed job carries no `waitFor` and the gate is skipped for it.
- **Why the version skew is detected rather than documented**: `DES-TRIGGERS-UNIFIED-FILE` records that a
  widening drops silently on an old parser, which for every previous field was harmless. `waitFor` is the
  first field whose ABSENCE is destructive — the resulting run is byte-identical to a correct one in the
  record, the panel and the log, and success is the least detectable failure available. `docs/secrets.md`'s
  answer (a documented version floor) is not enough here, and `doctor` cannot close it either: it cannot
  see the receiver's installed version from the worker host, so its warning would fire on every deployment
  using the feature forever, which is the always-on amber the panel's own design rejects. So the worker
  compares the AUTHORED entry against the job it was handed, fail-open on anything it cannot answer.

- **Rejected**:
  - ***Widening the queue's dedup window for a held job*** — the obvious way to coalesce repeat deliveries,
    and wrong three times over: the key carries no trigger identity (so it would suppress an unflagged
    sibling on the same target and flow), it OUTLIVES completion when a ttl is set (so it would go on
    suppressing for the rest of the window after the job finished), and there is no public API to reset it.
  - ***`deduplication.replace`*** — it does key on the delayed state, and that is exactly why it is wrong:
    the replacement is a new job with a new timestamp, so a repeatedly re-labelled issue would reset its
    own wait clock and never reach the maximum.
  - ***`keepLastIfActive`*** — coalesces against an ACTIVE job; a held job is delayed, so it would never
    see one.
  - ***Reinterpreting exit `2` as "not yet"*** — it would contradict the Queue-behaviour column's own words
    in the one place a reader checks them, and `2` already means determinate-and-never-retried to two other
    participants.
  - ***A general unknown-key sweep on `run`*** — it would close the misspelling hole, and it would refuse
    files that load today; tolerating unknown keys is this file's documented forward-compatibility posture.
    A near-miss guard on this one field buys the safety without the breakage.
  - ***A `blocked` run-record outcome*** — the outcome enum is closed and the admin surfaces drop unknowns.
  - ***BullMQ Flows*** — `moveToWaitingChildren` requires the job to be ACTIVE, so it is a mid-processing
    yield, not a pre-spend gate, and it models job-to-job rather than job-to-world dependencies.
  - ***An index of blocker to held jobs*** — refused twice before: an index is a query surface, a query
    surface is the database, and the delayed set is enumerable and already persisted.

- **Named residuals**: a held job's WAKE has no authorizing actor (`OQ-029`), and a check's exit code is a
  convention this project cannot enforce (`OQ-030`). Three more are recorded here rather than closed:
  a check's GRANDCHILDREN outlive the kill ladder, because `child.kill` reaches the direct child only and
  killing a process group means spawning detached, which changes what the check inherits; the byte counts
  are a FLOOR rather than a total, since the verdict is taken on `exit` rather than waiting for stdio EOF
  (which a backgrounded grandchild can hold open indefinitely, turning a correct `exit 0` into a false
  timeout — the trade is deliberate and this direction is the cheap one, because the counts are advisory
  and the verdict is not); and a worker outage longer than a hold's own TTL loses that job's `since` and
  check count, so its budget silently restarts from the next granted check.

- **Traces to**: `REQ-WAIT-FOR`, `INT-WAIT-PROFILES-CONTRACT`, `INT-RUNNER-EXIT-CODE-PROTOCOL`,
  `INT-TRIGGERS-FILE-CONTRACT`, `DES-SCOPED-PAUSE-VIA-MOVE-TO-DELAYED`, `DES-PER-TRIGGER-SECRET-PROFILE`,
  `DES-TRIGGERS-UNIFIED-FILE`, `CONST-TRIGGER-AUTHOR-GATE`, `CONST-BUDGET-BEFORE-TOKENS`

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
  - *Counting a key's resume chain from the run records* — the shape this entry refuses, reached from a
    new direction and worth writing down because it looks like reading rather than indexing. It is not
    available at any price: the record deliberately carries no session key
    (`INT-RUN-HISTORY-FILE-CONTRACT`, and that absence is what keeps it PII-free by construction), forge
    job ids are delivery GUIDs, so a lineage on one key leaves records with unrelated filenames, and
    joining them would mean recording the key against each — the index, again. The counter that ships
    instead is one integer **inside the key directory**, written under the promotion lock beside the
    transcript it counts. That is not this entry's refusal: it is keyed state stored where the key already
    is, answering one question rather than offering a query surface, and it survives the store being
    deleted in the only way that matters, by degrading to a cold start like everything else there.
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

## DES-EGRESS-DENY-ON-A-DEDICATED-NETWORK

- **Decision**: Ship the egress control as **one `--internal` Docker network per job, named in the worker's
  own `docker run` argv**, plus **one long-lived allowlist proxy** attached to each of those networks for the
  life of that run, filtering `CONNECT` by hostname and never terminating TLS. The provider is an ordinary
  entry on the allowlist. A **pre-spend check** on the proxy refuses a job the policy cannot serve. Off
  unless `PI_EGRESS=0`, and on every job with no per-trigger opt-out (`REQ-EGRESS-ALLOWLIST`,
  `INT-EGRESS-POLICY-CONTRACT`).
- **Why**: The rules were already written down and already run (`docs/sandbox.md`, issue #199, which touched
  zero code files). What was missing was not the mechanism but **the worker knowing about it**. Every
  property this project relies on -- reporting a refusal an operator can act on, checking a control in
  `doctor`, refusing before money is spent -- needs the policy to be an object the worker names. That is
  what makes this an argv change rather than a documentation change, and it is why the network and not the
  proxy is the load-bearing half.
- **Rejected**:
  - *The `DOCKER-USER` host recipe as the shipped form.* It works. What it cannot be is **known**: the
    worker cannot report it in the run record, `doctor` cannot check it, a Docker upgrade that rewrites the
    chain removes it with no signal, and a second worker on the host inherits it without asking. An
    operator who believes they have a control they cannot verify is in a **worse** position than one who
    knows they have none, because the belief displaces the credential bound that is actually holding it.
    Shipping it as code is worse still: a host process that deliberately refuses to mount `docker.sock`
    because "a socket mount is root-equivalent access to the host" would instead take root directly, to
    write firewall rules, on Linux only, for a worker whose own `service.mjs` also renders launchd plists
    and nssm services. It survives as an appendix in `docs/egress.md`, for an operator who wants a layer
    *underneath* docker's rules rather than instead of them.
  - *One shared network with `com.docker.network.bridge.enable_icc=false`.* This was the design until it was
    measured. ICC governs **every** container pair on that bridge and the proxy is a container, so the
    option blocks job-to-proxy along with job-to-job: the control defeats itself. Verified in both
    directions against a control network where the same connection succeeds. Without the option, a shared
    network is a shared L2 segment for `DES-CONCURRENCY-3` mutually-untrusting issue authors -- and worth
    stating precisely, because the tempting overclaim is available: two job containers on docker's default
    bridge can already reach each other **by IP** today, so a shared network would not create that
    adjacency, only make it resolvable **by name**. Per-job networks remove it outright.
  - *A network-layer rule permitting the provider by address*, which is what the recipe does and what
    `OQ-004` recorded as forced. Refuted by measurement rather than preference (see the requirement): the
    provider follows the proxy once `NODE_USE_ENV_PROXY` actually reaches the runner, and the flag was
    missing from the recipe's `PI_FORWARD_ENV` line, not unavailable. An address rule permits whatever
    answers on that address and goes stale silently when the provider re-resolves; it also cannot be
    expressed inside a docker internal network at all, so adopting it would have dragged the whole design
    back to host firewall rules.
  - *A TLS-terminating, secrets-injecting proxy.* `OQ-011`'s mechanism, and not merely larger: a
    **different security object**, in which the provider key stops living in the container and starts living
    in a host process that reads provider plaintext, needing its own constitution entry and its own story
    for the proxy's own compromise. Named here so this design is never mistaken for a down payment on it,
    and so the conflation `OQ-004:89-92` warned about does not happen at the one moment it was warning
    about.
  - *The worker starting the proxy at boot.* Today the worker starts only ephemeral `--rm` containers it
    reaps by a name filter. A long-lived, network-attached, restart-policied component is a different
    lifecycle object, and making the worker responsible for a security control's **uptime** creates the one
    failure this whole feature exists to prevent: a control that is believed up while it is down. It is a
    compose profile, and `up` offers it behind the same consent gate every other host mutation gets.
  - *A `run.network` trigger field.* A per-trigger egress relaxation is a per-trigger security downgrade,
    and it would need a model-callable exclusion maintained in perpetuity. The deployment configures egress;
    a trigger never does.
  - *An allowlist read from the serviced repo's `.pi/`.* Merge-gated content, and `DES-AI-TRIGGER-FLOW-GATE`
    takes only a **boolean** from that file for precisely this reason: an egress allowlist from a repo is
    the repo naming where the agent may send the operator's credentials.
  - *A denylist.* It fails open on everything nobody thought of, which is the failure mode this exists to
    remove.
  - *Handing the operator a `squid.conf` to edit*, which is what the recipe does. A misordered `http_access`
    silently allows everything, so the ordering ships and the operator's file is a list of hostnames with no
    ordering in it at all.
  - *Caching the preflight's answer across jobs.* `image-preflight.mjs` caches nothing on purpose, and a
    stale "the proxy is fine" is wrong in the direction that costs a budget slot.
  - *A per-job reachability probe.* It would prove what the presence check cannot, and it costs a throwaway
    container start on the money path before every job, converts a determinate gate into a flaky one, and
    means every job on every deployment makes an unauthenticated request to a third party before it starts.
    That belongs in `doctor`, once, when a human asks for it.
- **Traces to**: `REQ-EGRESS-ALLOWLIST`, `INT-EGRESS-POLICY-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`,
  `INT-SANDBOX-CONTRACT`, `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-BUDGET-BEFORE-TOKENS`,
  `CONST-RETRY-INFRA-ONLY`, `DES-WORKER-ON-HOST`, `DES-CONCURRENCY-3`, `DES-PER-TRIGGER-JOB-IMAGE`,
  `OQ-004`, `OQ-011`

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
- **The PROMPT layer is four builders, not one** (#187). The index reaches the branch, the jobId and the
  dedup key through code with no forge in it, and reaches the prompt through `github-`, `gitlab-`,
  `forgejo-` and `azure-prompt.mjs` separately. Only `siblings()` is shared out of the github builder: pure
  arithmetic over two host integers, which is the test each sibling's header already sets for what may
  travel ("None of the three is a fact about GitHub"). The paragraphs are written out per forge because
  their nouns are forge facts — a merge request is not a pull request, a work item is not an issue, and
  Azure's source branch is not a head branch. Rejected: parameterising one paragraph over a noun table
  (it puts GitLab's and Azure's vocabulary inside the file whose stated reason for existing is `gh` prose,
  which `forgejo-prompt.mjs` names as the trap: its nouns being GitHub's is "exactly the reason sharing
  would have been most tempting and most wrong"); and four independent copies including `siblings()` (four
  places for one index-arithmetic bug, which is `queue.mjs`'s own argument for collapsing its wrappers).
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
  deploy/         # docker-compose runs Valkey by default; `--profile receiver` adds the containerised
                  #   receiver (issue #82 — it has zero docker dependency and is the internet-facing
                  #   piece). The WORKER is always a host Node process (DES-WORKER-ON-HOST); no service
                  #   mounts docker.sock. Unit templates: systemd verified-structure; launchd/nssm
                  #   worked examples — all render-installable via `pi-dispatch service` (issue #80).
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

## DES-HOST-REGISTRY

- **Decision** (issue #57): every worker publishes one TTL'd, heartbeated row about ITSELF into a `host:`
  keyspace (`INT-HOST-REGISTRY-CONTRACT`), and reads its peers' rows. One structure, because every gap in
  the multi-host issue wants the same missing fact -- which hosts exist, and what is each one -- and six
  gaps each growing their own answer is how a fleet ends up with six disagreeing ones.
- **Why a registry rather than `CLIENT LIST`**: naming the BullMQ `Worker` does make `getWorkers()` rows
  distinguishable, and it ships for its own sake -- it also stamps `processedBy` on every active job's
  hash for free. But BullMQ's own doc-comment on that method says *"GCP does not support SETNAME, so this
  call will not work"*, which is the same degradation `readWorkerCount`'s `"unknown"` fallback already
  exists for. A host list that silently empties on some providers cannot be what a routing decision reads.
  Ordinary keys can. So `getWorkers()` is a nicety and the registry is the source of truth.
- **Why this is not the Redis state `OQ-008` and `DES-CONCURRENCY-3` refused**: that refusal is about a
  claim whose truth-maker lives on the host while the claim lives in Redis, with no way for the two to
  notice they disagree -- an in-flight count asserting a container the boot reaper had just killed. Here
  the truth-maker IS the process and the refresh IS the claim, so when the process dies the claim stops
  being renewed. There is no reaper to contradict and no second authority to drift from. The falsification
  test, which anything added later must also pass: delete the whole `host:*` keyspace while the fleet runs
  and every host behaves exactly as it did before. A Redis-side toggle fails it; this does not.
- **Boot never waits on it**, and that is a correctness property rather than an optimisation.
  `makeRedisClient` sets `maxRetriesPerRequest: null` -- required for BullMQ's blocking connections --
  which means a command issued against an unreachable server QUEUES FOREVER instead of rejecting. Awaiting
  the first beat would hang boot indefinitely on a deployment whose Valkey is down, turning telemetry into
  a boot dependency with no timeout. The heartbeat is started and not awaited; a worker that comes up
  before its own row does is correct.
- **The name is validated, not hashed.** `scopeKeyPrefix` hashes a folder path because that path was never
  chosen for key-safety and cannot be refused; a worker name is DECLARED, so it can be refused at boot
  instead -- and the whole value of the structure is that `HGETALL host:h:mac-mini-1` is readable by a
  human. Hashing would destroy the property it exists for. The asymmetry between the two halves is the
  design: a DEFAULT (the machine's hostname) is repaired silently, because a value the operator did not
  choose must never refuse boot; a DECLARED name is refused loudly, because a value they typed must never
  be silently altered into a different machine's name.
- **Rejected**:
  - *One HASH keyed by name, with per-field TTLs.* Verified unavailable: `HEXPIRE` does not exist on the
    pinned `valkey/valkey:8` (`ERR unknown command`), so the retention window would become the writer's
    bookkeeping and a worker dying mid-sweep would leak fields nothing removes.
  - *A `SCAN host:h:*` instead of an index SET.* Refused for `wait:held`'s measured reason: the panel
    reads every second, and a keyspace scan walks hardest precisely when nothing is registered.
  - *Publishing paths* (`logsDir`, a resolver path, a folder). The content rule refuses them; a value that
    must be carried is hashed first.
- **Traces to**: `INT-HOST-REGISTRY-CONTRACT`, `REQ-MULTI-HOST-COORDINATION`, `DES-CONCURRENCY-3`,
  `OQ-008`, `OQ-012`


## DES-FLEET-LEASES-FOR-SHARED-BOUNDS

- **Decision** (issue #57): the two bounds enforced by an in-process `makeInFlight()` that describe a
  DEPLOYMENT rather than a process -- `PI_WAIT_CHECK_SLOTS` and a `scoped-limits.json` row's `concurrent`
  for a FORGE scope -- gain a fleet-wide layer of N independent `SET NX PX` keys beneath the unchanged
  in-process one. The local map stays and stays correct as the per-host duty-cycle bound; the lease is
  what stops the ceiling multiplying by host count.
- **Why they had to move**: one worker per docker daemon made a per-process count correct, and two hosts
  make it *a bound that multiplies by the operator's deployment shape*, which is not a bound. Four hosts
  with `PI_WAIT_CHECK_SLOTS=1` run four concurrent checks against one third party; four hosts with
  `concurrent: 1` run four paid containers on one repository. The second is worse in kind: a
  `scoped-limits.json` row's day/week/month caps are already shared INCRs, so ONE ROW had one bound that
  was fleet-correct and one that was silently widened -- which is the class of failure that file's own
  version rule exists to prevent.
- **What this owes `OQ-008` and `DES-CONCURRENCY-3`**, whose refusal of a Redis-held in-flight count is
  about a claim whose truth-maker lives on the host while the claim lives in Redis. The two leases answer
  it differently, and the difference is the whole entry:
  - The CHECK lease **claims no container**. It claims a subprocess this same process spawned, bounded by
    `PI_WAIT_CHECK_TIMEOUT_MS`, holding no folder and spending nothing. Three properties invert. What a
    stale claim costs: a folder mutex nobody holds and a job that never runs, versus one check deferred by
    at most a TTL. What contradicts it: the reaper is a second source of truth about containers and runs
    at boot with authority, while nothing enumerates, inspects or reaps a check. And how long it can be
    wrong: a container has no natural expiry, while a check has a hard configured timeout, so the TTL is
    DERIVED rather than guessed.
  - The SCOPE claim **really is for a container**, so the refusal lands squarely, and the answer is the
    boot reaper. It establishes at boot that this host holds no `pi-job-*` containers, so a claim naming
    this host is a claim for one that no longer exists, and deleting it is not a second source of truth:
    it is the same source writing down what it just established. **The precondition is load-bearing and
    is checked**: `makeReaper` catches its own `docker ps` failure, and on that path nothing was
    enumerated -- so the sweep is skipped, because freeing those slots would let ANOTHER host start
    containers alongside ones that may still be running. `makeInFlight`'s own escape ("a state where no
    NEW container can start either") does not transfer, precisely because the sweep frees slots for a
    different machine.
- **LOCAL scopes never take a fleet claim, and the reason is not economy.** The key would be a hash of a
  PATH STRING, which carries no identity: `/srv/site` on two machines is, in the common case, two
  different repositories sharing a layout convention. A shared claim keyed on that would serialise two
  independent working trees and break exactly the deployments this feature enables. Local folders are
  answered by ROUTING instead -- a folder exists on one host, so its in-process mutex already spans
  everything it needs to.
- **N independent keys, never one counter**: a counter with one TTL loses every claim when it expires and
  leaks a permanent `+1` on a crash, while N keys mean a lost release costs one slot for one TTL and never
  the whole semaphore. Probing rotates from `hash(id) mod slots`, or every host tries index 0 first and
  starves behind a busy slot while a free one sits two along -- a starvation indistinguishable from the
  capacity shortage the bound exists to report.
- **Release is idempotent here, which the in-process map is not.** It deletes only a key whose value is
  still ours; `makeInFlight().release` clamps at zero but a double release on a `concurrent: 2` scope
  frees the other holder's slot.
- **A fault GRANTS.** The in-process bound is still underneath, so failing open degrades the fleet ceiling
  to the per-host one -- the behaviour before this existed. Failing closed would turn a Valkey blip into
  "no wait in this deployment can be answered", which is the wedge every other gate here refuses.
- **Traces to**: `DES-CONCURRENCY-3`, `DES-SCOPED-LIMITS-AND-FOLDER-MUTEX`, `INT-SCOPED-LIMITS-FILE-CONTRACT`,
  `INT-WAIT-PROFILES-CONTRACT`, `OQ-008`, `OQ-030`


## DES-CONTAINER-BACKEND-REGISTRY

- **Decision** (issue #227): where a job's container is built is a NAMED backend, declared in a table
  (`worker/src/backends.mjs`) that is separate from the code implementing it (`worker/src/backend-local.mjs`).
  Today there is exactly one, `local`, the Docker daemon on the worker's own host, which is what every
  deployment has always run. The table exists so a second can be added without reading the worker's source,
  and so that adding one cannot quietly weaken a control.
- **Why the table declares and does not construct**: the obvious shape is one entry per backend carrying its
  own `make()`, and it cannot work. `backends.mjs` imports NOTHING on purpose, because `doctor`, the config
  loader and the receiver all need to read what a backend guarantees without pulling the Docker
  implementation into their graph. A factory per entry is an import edge from the leaf to every adapter,
  which is that property gone. So the two halves are joined by NAME, which is the split `forges.mjs`
  already uses against the forge hosts.
- **A declaration is a CAPABILITY, not a posture**, and the first draft of this entry got that backwards in
  a way worth recording. It declared `egress: enforced` flat, which restates in one word the entry
  `CONST-EGRESS-POLICY-IN-THE-ARGV` names and rejects: `CONST-EGRESS-DENIED-BY-DEFAULT`, refused because
  "an operator can set `PI_EGRESS=0`" and a *shall* over something an operator disables is the
  constraint-that-ships-unenforced `OQ-004` refused for. With `PI_EGRESS=0` there is no `--network` flag
  and the job sits on docker's default bridge, where `egress.mjs` records two jobs can already reach each
  other by IP. So a property a deployment switch gates carries `armedBy` naming that switch, and
  `declarationOf` is the one definition of the join, because `declares` is a bare `{property: word}` map
  and a consumer printing the word without its qualifier reintroduces exactly this defect.
- **Why capability is the right axis** rather than a convenience: it is the axis a floor compares against.
  The refusal to be produced is "this deployment ARMED egress and the backend it selected cannot do egress
  at all", and a posture word could not express it, because a deployment that armed nothing needs no
  refusal.
- **Three words, and declaring is not claiming.** `enforced` means this worker can build it in its own code
  and a test in this repo reads it back; `asserted` means something outside the worker provides it,
  unverifiable from here; `absent` means a deployment needing it is refused rather than downgraded. `OQ-012`
  draws the same line for images ("a required OCI label proves INTENT, not conformance"). The value is not
  that a vendor is verified; it is that a MISMATCH becomes a refusal instead of a silent downgrade.
- **The property list is CLOSED, so it had to be complete.** The rule "a backend that omits one is not
  admitted for it" is only sound if nothing an operator cares about is missing, so the list is derived from
  what the specs say the boundary provides rather than from what the local implementation has flags for.
  `ephemeral`, `mountSet`, `jobToJobIsolation`, `abortable` and `credentialTransit` were added after an
  adversarial pass: without them a backend could declare every other word `enforced`, be fully conformant,
  and still reuse one container across mutually untrusting issue authors, bind-mount the docker socket, put
  every job on one segment, have no way to stop a runaway job, or ship the per-job token to a daemon this
  deployment does not own.
- **Two `local` declarations are `asserted`, and both were `enforced` in a draft.** `nonRoot`, because
  `USER pi` is the image's and `SECURITY.md` says "Non-root is not in that argv". `credentialTransit`,
  because every spawn is `docker` with the worker's environment inherited and `DOCKER_HOST` redirects that
  connection to another machine with the provider key and the forge token riding along -- and `DOCKER_HOST`
  appears nowhere in this repository, so no code builds the property and no test reads it back. A boot check
  on it would earn `enforced`.
- **Nothing is verified against behaviour yet.** A backend can declare all of this and do none of it. Only a
  conformance suite that drives a backend's own `runContainer` and reads each property back off what it
  produced closes that, and until it exists these words are a contract rather than a finding. The module
  says so in its own header.
- **The configuration surface is `PI_BACKENDS` and `PI_BACKEND_FLOOR`, both ENV-ONLY** (issue #227,
  slice 2). Env-only on `secretResolverRoots`' rule -- "a bound that can be widened from the surface it
  bounds is not a bound" -- and the deployment pointer needs no edit to enforce it, because
  `POINTER_ENV_ALLOWLIST` is an ALLOWLIST (of the path and URL variables `resolvePaths` reads), so a name absent from it is refused by omission, and a capability grant is never added. Both parse
  in the leaf (`parseBackendList`, `parseBackendFloor`), which is `egressArmed`'s arrangement and its
  reason: `doctor` reads the environment directly, so a second copy of the grammar is a second answer.
  `config.mjs` re-tags the thrown Error as a config error and nothing else.
- **Every malformed part refuses rather than being skipped.** An unknown backend name, a floor pair with no
  `=`, an unknown property NAME, an unknown word, a property named twice: each throws. The reason is that
  `shortfall` returning `[]` is indistinguishable from a satisfied floor, so a floor the parser cannot read
  must never become one it reads as asking for nothing -- the same hazard `PI_EGRESS` refuses a third value
  for. A property named twice throws rather than last-wins, because both halves are something an operator
  wrote down deliberately.
- **A FLOOR IS NOT MET BY CAPABILITY ALONE, and reading it that way was this slice's sharpest defect.**
  `local` declares `egress: enforced` whether or not `PI_EGRESS` is armed, so `PI_BACKEND_FLOOR=egress=enforced`
  on a `PI_EGRESS=0` deployment passed, booted, and `doctor` printed "this deployment is not getting it"
  three lines above "PI_BACKEND_FLOOR holds" -- both with a pass glyph. The operator had asked, in writing,
  for exactly the thing they were not getting, which is the believed-in control arriving through the
  mechanism added to discharge it. `unarmedFloor` closes it: anything above `absent` on a gated property
  requires the switch to be ON. A floor asking for `absent` asks for nothing and is met.
- **The boot refusal has three ladders, and they are different questions.** The FLOOR is what the operator
  asked for explicitly, and it is checked against EVERY blessed backend rather than the default alone: any
  blessed backend is somewhere this deployment's jobs may run, so checking only the default would let a
  trigger reach a backend the floor was meant to exclude. The second is implied rather than written -- a
  deployment that ARMED egress has asked for egress whatever its floor says, so running it on a backend
  declaring `egress: absent` would arm a control that cannot exist there and report nothing. `local`
  declares it `enforced`, so that ladder cannot fire on a real deployment today.
- **The rules live in the LEAF, not in `config.mjs`, and that is a testability decision with teeth.** A rule
  reachable only through `loadConfig` can be exercised only with backend names `parseBackendList` accepts --
  exactly one today -- so three of these rules survived a mutation pass unprotected while they lived there:
  deleting the armed-egress ladder outright, and slicing the every-backend loop to its first element, both
  left the suite green. As a pure function over an explicit list (`backendRefusals`), each rule can be
  driven against a backend that fails it, using an unknown name as a stand-in for a backend that provides
  nothing. `config.mjs` re-tags the first message as a config error and does nothing else.
- **`PI_BACKENDS` must contain the backend that actually runs jobs.** Nothing SELECTS a backend yet:
  `start.mjs` builds `local` unconditionally, so a set excluding it would tell an operator their jobs run
  somewhere they do not AND skip the backend actually running them from the floor check. `doctor` says so
  in the line itself rather than printing a bare "Jobs run on", which would be true today only by the
  coincidence that `local` is the sole entry. Both come out in the slice that wires selection.
- **`doctor` is what makes the declaration admissible at all.** A table of guarantees nothing ever prints is
  precisely the believed-in control `CONST-EGRESS-POLICY-IN-THE-ARGV` says is worse than a known-absent one,
  so the three words must stay told apart ON THE SCREEN: `enforced` is quiet, `asserted` renders as a
  warning that NAMES its asserter (`asserts` on the backend entry -- "not us" without "them" leaves an
  operator nothing to go and check), and `absent` renders as a failure. `absent` OUTRANKS the gate, because
  a control that does not exist is a different fact from one that is unarmed.
- **The warning shape is `ok: false, warn: true`, and a draft of this got it backwards.** `render` reads
  `c.ok` FIRST, so `ok: true, warn: true` prints the plain pass glyph and drops the `fix` line with it. The
  first version of this section used that shape, and every asserted property rendered as a green tick --
  the section said the opposite of what it exists to say, while a test asserting `c.warn === true` on the
  OBJECT passed. The lesson is recorded because the test was the failure: a promise about what an operator
  SEES has to be tested through the renderer, not through a field the renderer ignores.
- **A gated property is printed with its SWITCH AND the switch's position when that switch is off**, never
  the bare capability word: "local CAN enforce egress" and "this deployment is not getting it" are two
  different sentences. Armed, the property is the quiet good case. A switch that does not PARSE is reported
  as a failure and the gated properties abstain, rather than falling through to the good case.
- **The floor line is unconditional, including "not set".** `PI_BACKENDS_FLOOR` is a plausible
  one-character-off spelling and nothing in this project warns on an unknown `PI_*` name, so silence would
  make a misnamed variable look exactly like a floor that holds -- the belief the strict in-string parsing
  exists to prevent, arriving from outside the string. A floor whose every entry is `absent` is reported as
  bounding nothing rather than as holding: `meets(have, absent)` is true for every value, which makes it the
  one READABLE word that reproduces the outcome `isDeclaration` refuses a typo for.
- **Rejected**: putting `make()` in the table (kills the leaf property above). Rejected: spreading the
  bundle into the processor's `deps`, which would put a backend's `name` into a namespace the processor is
  free to mean something else by. Rejected: a `backends/` directory, since `worker/src` is flat. Rejected:
  letting the floor live in the settings overlay beside the other panel-editable knobs, which is the same
  widen-from-inside move `PI_DISPATCH_RUN_ROOTS` is env-only to prevent.
- **Code evidence**: `worker/src/backends.mjs` -> `BACKENDS`, `PROPERTIES`, `shortfall`, `declarationOf`,
  `parseBackendList`, `parseBackendFloor`, `floorShortfall`
  · `worker/src/backends.mjs` -> `backendRefusals`, `unarmedFloor`
  · `worker/src/config.mjs` -> `backendSet`, `backendFloorOf`, `refuseBackendShortfall`
  · `worker/src/doctor.mjs` -> `backendChecks`
  · `worker/src/backend-local.mjs` -> `makeLocalBackend`, `jobContainerName`
  · `worker/src/container-spec.mjs` -> `containerSpec`
  · `worker/src/docker-run.mjs` -> `dockerArgsFromSpec`, `DOCKER_EXTRA_FORBIDDEN`

## Revision History

| Date | Change |
|---|---|
| 2026-08-30 | Issue #57, the shared-bounds slice. **NEW `DES-FLEET-LEASES-FOR-SHARED-BOUNDS`**: the two ceilings that describe a DEPLOYMENT rather than a process gain a fleet-wide layer beneath the unchanged in-process one. The entry's substance is what it owes `OQ-008` and this file's own refusal of Redis-held in-flight counts, and the two halves answer it differently. The check lease claims no container at all -- a subprocess this process spawned, bounded by a configured timeout, holding no folder and spending nothing -- so all three properties that made the container count wrong invert, and its TTL is derived rather than guessed. The scope claim really is for a container, so the refusal lands, and the answer is the boot reaper: it establishes that this host holds no containers, so deleting a claim that names this host is the same source of truth writing down what it just established. That argument has a PRECONDITION and the precondition is checked -- `makeReaper` catches its own `docker ps` failure, and on that path nothing was enumerated, so the sweep is skipped rather than freeing slots for containers that may still be running on a machine that would then be joined by another. Local scopes deliberately never claim, because the key would be a hash of a path string and `/srv/site` on two machines is usually two different repositories. **`DES-SCOPED-LIMITS-AND-FOLDER-MUTEX` AMENDED**: its rejection of Redis in-flight counters is NARROWED rather than reversed, and the narrowing is stated in the Rejected list itself so a reader meets it where the refusal is. **`DES-CONCURRENCY-3` UNCHANGED, checked**: the one-worker-per-daemon invariant and the process-memory argument for the folder mutex are untouched. **Code evidence**: worker/src/fleet-lease.mjs -> makeFleetLease, makeScopeClaimSweeper; worker/src/index.mjs -> makeProcessor (the check and scope arms); worker/src/start.mjs -> startWorker, makeReaper. |
| 2026-08-30 | Issue #57, the placement slice. **`DES-CONCURRENCY-3` AMENDED**: `PI_CONCURRENCY` is restored as a bound on the MACHINE. A worker that drains a host-affine queue as well as the shared one runs two BullMQ Workers, and BullMQ's concurrency is per Worker, so two at 3 would run six containers and break the RAM and provider-throttle reasoning this entry rests on. An in-process semaphore at the pickup gate caps the sum, deferring the excess at the scope gate's cadence -- and process memory is still the CORRECT store for this entry's own unchanged reason, since it counts this host's containers and the boot reaper clears survivors before draining. The one-worker-per-docker-daemon invariant is untouched; multi-host means one worker per host, never two per daemon. **`DES-CRON-VIA-BULLMQ-SCHEDULER` AMENDED**: a host's schedulers live on its own queue, which makes the orphan prune correct by construction rather than by agreement. **`DES-SCOPED-LIMITS-AND-FOLDER-MUTEX` UNCHANGED, checked, and the check is the interesting one**: the folder mutex stays an in-process count, and ROUTING is what keeps it complete across hosts -- a local folder exists on exactly one machine, so only that machine's worker ever runs jobs for it. Affinity preserves the mutex rather than being bolted beside it. The residual is a folder present on two hosts through a shared mount, which the registry can detect and nothing yet does. **`DES-WORKER-ON-HOST` UNCHANGED, checked**: the worker is still a host process shelling out to a local docker, and every bind mount is still a path on its own filesystem -- which is precisely why placement is a routing problem rather than a scheduling one. **Code evidence**: worker/src/index.mjs -> createWorker, makeProcessor; worker/src/queue.mjs -> hostQueueName; worker/src/schedules.mjs -> loadSchedules, servedSchedules. |
| 2026-08-30 | Issue #57, the identity slice. **NEW `DES-HOST-REGISTRY`**: one TTL'd heartbeated row per worker, about itself, because six gaps wanting the same missing fact would otherwise grow six disagreeing answers. Three decisions carry their reasons. A registry rather than `CLIENT LIST`, because BullMQ's own doc-comment says `getWorkers()` does not work where CLIENT SETNAME is unsupported, and a host list that silently empties cannot be what a decision reads -- the Worker is named anyway, for the `processedBy` stamp it buys free. Boot never AWAITS the registry, which is correctness rather than speed: `maxRetriesPerRequest: null` (required by BullMQ's blocking connections) means a command against an unreachable server queues forever instead of rejecting, so awaiting the first beat would hang boot with no timeout on a deployment whose Valkey is down. And the name is validated rather than hashed, inverting `scopeKeyPrefix`'s call for a reason that is stated: a folder path was never chosen for key-safety and cannot be refused, while a declared name can -- and hashing would destroy the readability the structure exists for. **`DES-CONCURRENCY-3` UNCHANGED, checked**, plus one sentence saying why: the refused object is a claim whose truth-maker lives on the host while the claim lives in Redis, and a registry row's truth-maker is the process whose refresh IS the claim. The sentence also names where the argument does NOT transfer, because the naive reading is that #57 has retired this entry -- the wait-check lease and the per-scope in-flight count are claims of exactly this kind, and nothing here closes either. **`DES-RUN-HISTORY-FLAT-FILES-NO-DB` UNCHANGED, checked**: the sidecars remain the durable record and nothing about where they live has moved; the record gained one nullable field and no new store. **`DES-SCOPED-LIMITS-AND-FOLDER-MUTEX` UNCHANGED, checked**: the in-flight map is untouched and still process memory. **Code evidence**: worker/src/host-registry.mjs -> makeHostRegistry, readLiveHosts; worker/src/start.mjs -> startWorker; worker/src/config.mjs -> WORKER_NAME_RE, sanitizeWorkerName. |
| 2026-08-30 | Issue #230, the doctor and docs slice. **`DES-CLI-SURFACE` UNCHANGED, checked**: `doctor` stays read-only and always-safe, and the four new wait checks carry no `fixAction` -- they report and never repair, which is the property that keeps the command in its tier. **`DES-WAIT-FOR-HOLDS-AND-WAIT-PROFILES` UNCHANGED, checked**: no gate moved, no bound changed and no rejected alternative was revisited; this slice adds the load-time reporting of decisions that entry already made, plus the operator reference for them. Two of the checks did come from testing the entry's claims rather than from the plan, and both are recorded here because each is a state the entry implies is impossible to reach quietly: a garbled `PI_WAIT_PROFILES` is parsed by `loadConfig` on EVERY boot, holding triggers or not, so the parse check had to come out from behind the `waiting > 0` gate -- otherwise the one operator it exists for, the one whose worker refused to boot on that line before any trigger was written, was told nothing at all; and an `after` beyond `PI_WAIT_AFTER_MAX_MS` refuses every delivery at first pickup, which doctor can see before anything is enqueued because it holds both the instant and the ceiling. A third is a deliberate NARROWING: a declared profile no trigger names now warns instead of failing, because nothing looks it up and failing the command on a retired `.env` entry is the always-on advisory the `waiting > 0` gate exists to prevent. **`DES-PER-TRIGGER-SECRET-PROFILE` UNCHANGED, checked**, and re-checked deliberately: the doctor half of that entry gains no term, but the shared defect its parser copy carried is fixed on both sides (see `INT-WAIT-PROFILES-CONTRACT`'s row in interfaces.md) -- doctor was failing to ask its question, not answering it differently. **Code evidence**: worker/src/doctor.mjs -> collectChecks (the wait block), readTriggerFacts (waiting, waitProfiles, waitAfters), statPath, parseWaitProfilesSafe, parseSecretProfilesSafe. |
| 2026-08-30 | Issue #230, the polled tier. **`DES-WAIT-FOR-HOLDS-AND-WAIT-PROFILES` AMENDED**: its Status marker is gone because the spawner it described is now built. The entry gains the two bounds that are not obvious from the issue's own economics table: the check LEASE (one check at a time per worker process, clamped against the LIVE concurrency rather than the boot value, because the overlay can lower it through `dispatch_set` and a check must never take the last free slot from a paid job) and the per-job CHECK COUNT, which exists because nothing in the spend system can see a check at all -- `CONST-BUDGET-BEFORE-TOKENS` counts container starts, so a gate that starts none is invisible to every ceiling this project has. A denied lease re-asks at a QUARTER of the cadence with jitter, rather than the full backoff (one lost coin-flip should not cost fifteen minutes) or a flat few seconds (which at scale is the herd the floor exists to prevent). **`DES-PER-TRIGGER-SECRET-PROFILE` UNCHANGED, checked**, and re-checked against the built spawner: the shape is borrowed whole (argv array, `shell: false`, stdin ignored, SIGTERM then SIGKILL, own timeout, abort signal) and every difference is a SUBTRACTION -- no size cap, no NUL check, no newline stripping, no dedup by reference, and stdout demoted to a byte counter, because a check's output is a third party's words arriving through an operator's script rather than a value anything consumes. **`DES-AI-TRIGGER-FLOW-GATE` AMENDED**, and this one is a CORRECTION rather than an addition: its enqueue-to-run residual bounded the window by "the daily cap", which a held job does not consume -- the wait gate sits above `reserveBudget` precisely so it does not -- so for the case this issue introduces that bound was simply false. The bullet now bounds it by the ceiling on the condition instead (`PI_WAIT_AFTER_MAX_MS` or `PI_WAIT_MAX_MS`), keeps the residual it always described, and names re-reading the gate at fire time as the deferred closure, with the reason it is deferred: it would add a run-path read for every job to fix a window only held jobs can widen. **Code evidence**: worker/src/wait-check.mjs -> makeWaitChecker, runCheck; worker/src/wait-state.mjs -> makeWaitState (noteThrottle). |
| 2026-08-30 | Issue #230, enforcement slice for the free tier. **NEW `DES-WAIT-FOR-HOLDS-AND-WAIT-PROFILES`**: the gate position (third, after pause and before the scope acquire, with the reason each neighbour gives for its own place), the refusals-then-holds ordering, and a CORRECTION to the issue's own proposal — it wanted the check inside `runJob` with a hold threaded back to the wrapper, which is unnecessary and worse, since `runJob` sits below the `try` where nothing can defer, while the abort signal the check was said to need is the processor's own third parameter and its timeout is tighter than the kill timer. Records why wait profiles are env-only (the gate reads its config above the per-job settings read, so an overlay-declared profile could not be seen by the gate that would run it), why a small `wait:` keyspace exists rather than reusing `job.timestamp` (which is the ENQUEUE instant and counts pause and backoff time as waiting), and why the version skew is DETECTED rather than documented. Rejected, with the pinned reason for each: widening the queue's dedup window (the key carries no trigger identity and outlives completion), `deduplication.replace` (the replacement resets the wait clock, so a re-labelled issue could never reach its maximum), `keepLastIfActive` (it coalesces against an ACTIVE job and a held job is delayed), reinterpreting exit `2`, a general unknown-key sweep, a `blocked` outcome, BullMQ Flows, and an index of blocker to held jobs. **`DES-SCOPED-PAUSE-VIA-MOVE-TO-DELAYED` UNCHANGED, checked**: its seam is reused byte-for-byte and its own gate is untouched — the new gate sits after it and adds no case to it. **`DES-TRIGGERS-UNIFIED-FILE` UNCHANGED, checked**, and the check is the point: its widening-drops-silently rule is still exactly right, and this issue is the first field for which the resulting no-op is destructive rather than harmless, which is why the answer is a worker-side detector rather than an amendment here. **`DES-PER-TRIGGER-SECRET-PROFILE` UNCHANGED, checked**: the resolver's shape is borrowed, not shared. **`DES-SCOPED-LIMITS-AND-FOLDER-MUTEX` UNCHANGED, checked**, and it is the entry a reviewer would expect to have moved: its Rejected list refuses *per-trigger `run.*` fields* for limits, on two grounds, and the FIRST is what keeps a wait outside it — "many triggers feed one repo, so the scope is the wrong shape" is exactly false of a wait, which is per-trigger by nature, since two triggers on one repo legitimately wait on different things. The second ground (limits are runtime controls, not reviewed trigger content) is what keeps `waitFor` file-only with no model-callable path, so this entry's reasoning is followed rather than excepted. **Code evidence**: worker/src/index.mjs -> makeProcessor; worker/src/wait-state.mjs -> makeWaitState; worker/src/triggers-file.mjs -> makeCheckWaitSkew. |
| 2026-08-29 | Issue #242, admin slice. **`DES-SCOPED-LIMITS-AND-FOLDER-MUTEX` AMENDED**: gains the admin-surface paragraph — the pause-windows stack copied (confirm-gated trio + the panel's `m` key), the divider-not-footer hint decision with the footer arithmetic as the reason, the neutral render-only-when-nonzero `delayed` count (the delayed set is dominated by cron next-occurrences, pinned upstream by the cron integration test), and config-only concurrency display on the no-invented-numbers doctrine. **`DES-ADMIN-VIA-PI-EXTENSION` UNCHANGED, checked**: the new tools ride the same registerTool/confirm plumbing every write tool uses; nothing new reaches the model without the operator confirm. |
| 2026-08-29 | Issue #242, enforcement slice, one CORRECTION and one new entry. **`DES-CRON-VIA-BULLMQ-SCHEDULER` CORRECTED**: the "No overlap, structurally" bullet was FALSE at every version that carried it — the next occurrence is minted at pickup (`worker.js → nextJobFromJobData → upsertJobScheduler`, `override: false`) and promoted on time alone (`promoteDelayedJobs.lua`), so a slow run overlaps its own successor whenever a slot is free (measured: 301ms of live same-folder container overlap through the real processor). Rewritten to the true bound (at most one UNSTARTED occurrence) with the same-folder no-overlap now supplied, structurally, by the folder mutex landing in this slice — the correction and its mechanism arrive together. **NEW `DES-SCOPED-LIMITS-AND-FOLDER-MUTEX`**: the watched `scoped-limits.json`, scoped-reserves-first with the compensating release on a global refusal, deferral-never-refusal concurrency at a fixed 5s re-check, the unconditional folder mutex on canonical paths, process-memory in-flight counts, and the rejected alternatives (BullMQ Pro groups, the dead global `limiter`, `PI_CONCURRENCY=1`, per-trigger fields, an overlay map, Redis in-flight counters). **`DES-CONCURRENCY-3` AMENDED**: gains the per-scope deferral axis, the hand-run-worker qualifier on the daemon invariant, and the process-memory reasoning. **`DES-CLI-SURFACE` AMENDED**: the never-tier enumeration gains scoped-limits content. **`DES-RUNTIME-SETTINGS-FILE-OVERLAY` CORRECTED in passing**: its key enumeration had drifted from `KNOWN_KEYS` (missing `maxTokens`, `dailyTokenCap`; `secretProfiles` now named as the operator-only resident) — pre-existing drift, unrelated to this issue, fixed while touching the file. **`DES-SCOPED-PAUSE-VIA-MOVE-TO-DELAYED` UNCHANGED, checked**: the pause gate, its window-end semantics and its raw-scope matcher are byte-identical; the new gate sits AFTER it and reuses only the seam. |
| 2026-08-29 | Issue #231, worker slice. **`DES-ONE-SHOT-DISARM-IN-THE-FILE` AMENDED**: the lifecycle paragraph is now landed code (recordRun wrap, all records disarm, the own-jobId pre-spend exception via the injected queue jobId); NEW compose-topology paragraph -- the single-file :ro bind mount pins a dead inode across the disarm's rename, so the worker's `once-already-spent` pre-spend gate is the once-enforcement layer there, stated beside the mount in BOTH compose copies; the disarm path resolves `PI_TRIGGERS_FILE ?? ./triggers.json` on doctor's precedent, never the cron-off `triggersFile` knob. **`DES-CRON-VIA-BULLMQ-SCHEDULER` UNCHANGED, checked**: the hook no-ops on any job without `matched.once`, cron included. |
| 2026-08-28 | Issue #231, second slice (writer). **NEW `DES-ONE-SHOT-DISARM-IN-THE-FILE`**: the shared locked triggers-file writer moves to the worker package (`./triggers-file`, admin re-exports), both authors serialize through `<path>.lock` (session-store idiom, plus the one new mechanism -- stale takeover at 10s, argued from this file having no reaper), the disarm verifies index+number identity before writing and never repairs an unreadable file, and the worker-slice lifecycle contract (record-first, all records disarm, own-jobId pre-spend exception) is stated once here. **`DES-TRIGGERS-UNIFIED-FILE` UNCHANGED, checked**: the parser stays where it was; only the writer moved in beside it. **`DES-RUNTIME-SETTINGS-FILE-OVERLAY` UNCHANGED, checked**: `writeOverlay` keeps its own mkdir posture, and the divergence (no implicit mkdir for triggers.json) is argued in the new entry. |
| 2026-08-28 | Issue #231, first slice (schema). **`DES-TRIGGERS-UNIFIED-FILE` AMENDED**: the receiver's type set gains `issue`, and the widening-vs-narrowing row gains the third case -- a new `on.type` or action word is the LOUD-skew widening (an old parser throws at its closed vocabulary instead of silently dropping `on.once` and keeping a "disarmed" trigger firing), bought at #187's release-ordering price; `run.flow`'s webhook charset check is recorded as the file's second true narrowing and argued safe (such a flow could never materialise, so the refusal only reaches files that already failed post-budget). **`DES-PR-TRIGGER-ROUTES-TO-FLOW` UNCHANGED, checked**: close routing lands with the receiver slice; nothing in this slice touches PR routing. **`DES-CRON-VIA-BULLMQ-SCHEDULER` UNCHANGED, checked**: `on.once`/`on.number`/`on.disarmed` are refused on cron precisely so the scheduler's identity model (id, not index) stays untouched. |
| 2026-08-26 | **NEW `DES-PER-TRIGGER-SECRET-PROFILE`** (issue #225). **`DES-SERVICE-ENV-SETUP-SEAM` AMENDED by scope, not reversed**: its Rejected row refuses "making this reachable from configuration, which would turn a boot-time root-adjacent exec into something a trigger file could name", and that still holds -- a trigger names a profile NAME, never a path, so it selects among execs the operator already declared and cannot introduce one. A first draft of the new entry also argued the resolver's blast radius is smaller because it runs mid-life as the worker's user rather than root-adjacent at boot; that claim was WITHDRAWN before merge, because `SECURITY.md` names the `--env-setup` radius as "the account that holds every credential this deployment has", which IS the worker's user. What bounds the new surface is the fail-closed `PI_SECRET_RESOLVER_ROOTS`, not a weaker radius. **`DES-PER-TRIGGER-JOB-IMAGE` UNCHANGED, checked**: its "if a future tool ever takes an image parameter, the allowlist arrives with that tool" row is the reason the roots allowlist exists, and it predicted this correctly. **`DES-RUNTIME-SETTINGS-FILE-OVERLAY` UNCHANGED, checked**: `secretProfiles` is validated by the overlay but kept out of `KNOWN_KEYS`, and it takes no `overlay > env` precedence -- a name declared in both sources refuses. **`DES-AI-TRIGGER-FLOW-GATE` UNCHANGED, checked**: a flow still supplies only a boolean, and a flow-declared profile is in the new entry's Rejected list. |
| 2026-08-26 | Issue #186 (resume eligibility bounds). **DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED AMENDED**: one rejected alternative, *counting a key's resume chain from the run records*. It is worth refusing in writing because it looks like reading rather than indexing, and because it is not available at any price: the record deliberately carries no session key (that absence is what keeps it PII-free by construction), forge job ids are delivery GUIDs so one key's lineage leaves records with unrelated filenames, and joining them would mean recording the key against each, which is the index this entry already refused. The counter that ships instead is one integer INSIDE the key directory, written under the promotion lock beside the transcript it counts, and the entry states why that is not the same thing: it is keyed state stored where the key already is, it answers one question rather than offering a query surface, and it degrades to a cold start like everything else there when the store is deleted. **DES-RUN-HISTORY-FLAT-FILES-NO-DB UNCHANGED, checked**, and it is the entry the alternative above would have violated: a cross-record content query is the database by another name. **DES-JOB-OUTBOX-CHAINING UNCHANGED, checked** despite the name collision an unwary reader will make -- `PI_CHAIN_DEPTH_MAX` bounds how far one job may spawn another, and `PI_SESSION_MAX_RESUME_CHAIN` bounds how many times one key may be resumed; they share a word and nothing else, which is why the reason token is `resume-chain-too-long` rather than anything shorter. |
| 2026-08-26 | Issue #221 (the wrapper accepted a stop and then went on as if it had not). **NEW `DES-WRAPPER-STOPS-WHAT-IT-STARTED`**: the handler is armed above the sourcing, re-asserted below it, the command is not launched at all when a stop arrived first (exit 0, reason on stderr), and the signal is re-sent immediately after `child=$!` when the handler fired before the pid was knowable. The entry exists because the wrapper's signal contract had no home: it lived in that file's own comments and in the 2026-08-02 row below, whose sentence "SIGTERM still reaches node via the trap" was true of every case anyone had looked at and false of the two that fire under load. Its Rejected list is where the value is. **A readiness handshake** — a marker the wrapper writes once it can forward, which is what the issue proposed — would have made the TEST reliable and left the PRODUCT dropping the signal, and no marker written by the child can close a window that exists before the child does. **Blocking the signal around the fork** is unreachable in POSIX sh, and its one spelling, `trap '' TERM`, is inherited by the child as SIG_IGN, which is the exact failure the re-assert exists to undo. **Exiting 143** relaunches the service the operator just stopped, into the half-built environment the setup script never finished. **DES-SERVICE-ENV-SETUP-SEAM AMENDED**: the preparation window belongs to the seam, since the seam is what made it long, and the Windows bullet now says the `.cmd` twin has no `trap` either. **DES-CLI-SURFACE UNCHANGED, checked** — no tier moves, and the never-tier's wrapper clause (capture `PI_ENV_SETUP` before sourcing `./.env`) is byte-identical: arming a handler earlier changes when signals are handled, never what may name a script. **DES-WORKER-ON-HOST UNCHANGED, checked** — the worker is still a host process; only when its parent handles signals moved. **DES-CONCURRENCY-3 UNCHANGED, checked** — one wrapper, one daemon, unchanged. |
| 2026-08-26 | Issue #187 (`run.replicas` on every forge). **DES-TRIGGERS-UNIFIED-FILE AMENDED**, and the amendment corrects a safety claim this entry has carried since it was written: *"One validator, run by both, means a malformed file fails both services identically — the two cannot drift."* There are THREE readers. `admin` bundles `parseTriggers` into its published console at build time (`admin/build.mjs`, esbuild `bundle: true`, the worker absent from `external`) and validates the whole file through that frozen copy in `writeTriggers`, which is the "two independent validators" its own Rejected list refuses, separated by time rather than by code. Recorded rather than fixed: the alternative is a runtime dependency from the console on the worker package, a heavier coupling than the one it would remove. The entry also gains the **widening-vs-narrowing** rule this issue is the first instance of — every prior field ADDED an optional key and unknown keys drop, so an old parser meeting a new file was a silent no-op; relaxing a refusal on a known key makes it an explicit throw, which is a release-ordering constraint rather than a code one. **DES-REPLICA-INDEX-REACHES-THE-BRANCH AMENDED**: the four layers are unchanged, but the PROMPT layer is recorded as four builders rather than one, with `siblings()` the only shared part and both alternatives (a parameterised noun table, four independent copies) in Rejected with their reasons. The local/cron rejection is byte-unchanged and is now the only kind gate the validator has. **DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED UNCHANGED, checked**: `keyParts` gates on `isForgeKind` rather than on github, so widening changed nothing about what it derives — what widened with it is the blindness the `resume`×`replicas` refusal makes harmless, now pinned per forge. **DES-JOB-OUTBOX-CHAINING UNCHANGED, checked**: the `local`-only guard bounds fanout from a replica on any forge. **DES-CONCURRENCY-3 UNCHANGED, checked**: `REPLICAS_MAX` still derives from `PI_CONCURRENCY`'s default and no forge enters that reasoning. |
| 2026-08-25 | Issue #202 (the egress default). **DES-EGRESS-DENY-ON-A-DEDICATED-NETWORK UNCHANGED, checked** -- the mechanism it records is unaffected by which way the default points, and the default itself is a requirement (`REQ-EGRESS-ALLOWLIST`) and a constraint (`CONST-EGRESS-POLICY-IN-THE-ARGV`) rather than a design decision. Recorded here rather than left silent because the entry's "Off unless `PI_EGRESS=1`" sentence would otherwise read as stale against a shipped opt-out. **DES-CONCURRENCY-3 UNCHANGED, checked**, and still the reason the network is per-job. |
| 2026-08-25 | Issue #202 (egress). **NEW `DES-EGRESS-DENY-ON-A-DEDICATED-NETWORK`**: a per-job `--internal` network named in the worker's own argv, one long-lived allowlist proxy attached to each for the life of a run, hostname filtering with no TLS termination, the provider as an ordinary entry, and a pre-spend check on the proxy. The `Rejected` list is where the value is, and two entries were reached by measurement rather than argument. **A shared network with `enable_icc=false`** was the design until it was run: ICC governs every container pair on the bridge and the proxy is a container, so the option blocks job-to-proxy along with job-to-job and the control defeats itself. **A network-layer rule permitting the provider by address** -- what the recipe does and what `OQ-004` recorded as forced -- is refuted: the provider follows the proxy once `NODE_USE_ENV_PROXY` actually reaches the runner, and it was missing from the recipe's own `PI_FORWARD_ENV` line rather than unavailable. Also rejected: shipping the `DOCKER-USER` recipe as code (a process that refuses `docker.sock` because a socket mount is root-equivalent would instead take root directly, on Linux only); the worker starting the proxy at boot (it would own a security control's UPTIME, which is the believed-up-while-down failure this feature exists to prevent); a TLS-terminating secrets-injecting proxy (`OQ-011`'s mechanism and a DIFFERENT security object, named so this is never mistaken for a down payment on it); a `run.network` trigger field; a repo-declared allowlist; a denylist; handing the operator a `squid.conf` to edit; caching the preflight; and a per-job reachability probe. **DES-CONCURRENCY-3 UNCHANGED, checked, and newly load-bearing**: three concurrent jobs are the reason the network is per-job. **DES-WORKER-ON-HOST UNCHANGED, checked** -- the worker driving the local docker CLI is what makes any of this readable back at all. **DES-PER-TRIGGER-JOB-IMAGE UNCHANGED, checked**, gaining an instance of its own sentence: an operator-built image inherits the network the way it inherits `--cap-drop=ALL`, so `OQ-012`'s residual does not widen. **DES-SANDBOX-IS-A-FRESH-CONTAINER UNCHANGED, checked**: same image, same workspace, and now the same network, which is a narrowing of what that shell can reach rather than a change to what it preserves. |
| 2026-08-25 | Issue #216 (nothing checked the `--env-setup` script after render time). **DES-SERVICE-ENV-SETUP-SEAM AMENDED**: new bullet *the unit is the record* — the flag is render-time, so the rendered unit is the only place the path lives and a preflight has to read it back (`ENV_SETUP_READERS`/`readUnitSeam`, deliberately in `service.mjs` beside the composer that emits those shapes, with every render round-tripped through the reader so the two cannot drift). Two consequences recorded with it: the renderer substitutes the template's per-host placeholders BEFORE composing rather than after, because substituting after rewrote the operator's own `--env-setup` path into a file `resolveEnvSetup` never checked while the unit's banner still named the typed one; and doctor matches a unit to this deployment by `WorkingDirectory` before believing it, since a host may run two. **DES-CLI-SURFACE UNCHANGED, checked** — doctor stays on the read-only/always-safe tier: it reports the script's absence, its group/world writability and a non-ignoring work tree, offers no `fixAction` for any of them, and never opens the file. The never-tier clause "never name an env-setup script from anywhere but an operator-typed flag" is untouched — reading a path back out of a unit this tool wrote is not naming one. **DES-WORKER-ON-HOST UNCHANGED, checked** — no change to what the worker is or where it runs. **DES-CONCURRENCY-3 UNCHANGED, checked** — the unit scan reads both daemons in both scopes and installs nothing. |
| 2026-08-25 | Issue #209 (the service render env seam). **NEW `DES-SERVICE-ENV-SETUP-SEAM`**: `service render|install --env-setup <absolute path>` sources an operator-written env-only script and then `exec`s the worker, composed as one `sh -c` word on systemd and delivered as `PI_ENV_SETUP` (the plist's `EnvironmentVariables` dict, `nssm set … AppEnvironmentExtra`) on launchd and nssm, where the existing wrappers source it after `./.env` and `ProgramArguments`/`AppParameters` do not change at all. The renderer owns the `exec` because the hand-edit it replaces (`<manager> run -- <worker>`) reports the child's exit 2 as 1, and exit 2 is the determinate refusal `RestartPreventExitStatus=2`, `AppExit 2 Exit` and the wrapper's own conversion all key on; a failed setup is exit 1, never 2, and the worker never starts on a half-filled environment. A PATH and not a command (three unit formats, three escaping stories, one of which systemd expands `$VAR` inside whatever the quoting), absolute and never resolved (POSIX `.` searches `$PATH`). Rejected: a shipped launcher script for systemd, composing a command line into the plist and the nssm argv, blessing any particular manager, and any route to this seam from configuration. **DES-CLI-SURFACE AMENDED**: the flag joins the operator-typed tier as the sharpest thing on it, and the never-tier gains "never name an env-setup script from anywhere but an operator-typed flag" — enforced in the wrappers by capturing `PI_ENV_SETUP` before sourcing `./.env`, so no file they read can name a file they run. **DES-WORKER-ON-HOST UNCHANGED, checked** — the worker is still a host process driving the docker CLI; only what prepares its environment moved. **DES-CONCURRENCY-3 UNCHANGED, checked** — the seam adds no daemon and the cross-scope install refusal is untouched. |
| 2026-08-13 | Issue #188 (topology: tier-aware config-edge resolution). **DES-GRAPH-EDGE-DERIVATION AMENDED**: the config bullet's edge-end fallback set grows the tier nodes and the amber `skill-not-at-head` state; the dangling doctrine is rewritten around the per-trigger precedence ladder (repo > injected > overlay > staged) with `no-skill` demanding every applicable tier checked-and-missed; the stop-at-unknown rule is recorded WITH its doctor divergence (existential ✓ probes past an unknown, identity edge stops at one) as the load-bearing why; Rejected grows *claiming a lower-tier node under an unknown higher tier* and *a new flag or edge kind for tier resolution* (the closed vocabularies stay closed; node kinds became the third closed pinned set instead). **DES-ADMIN-VIA-PI-EXTENSION AMENDED**: the graph data surface gains `readOverlaySkills` (existence-only, ENOENT = legal models-only overlay = known-empty, other failures = unknown) and `readStagedSkillsList` (the worker's own reader behind the `readStagedPackages` wrapper doctrine, manifest order preserved as loader shadowing order), both null-means-not-checkable when `PI_GLOBAL_PI_DIR` is invisible (the deployment pointer deliberately cannot supply it), same never-throw/`GRAPH_LIMITS`/display-advisory posture. **DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS AMENDED** (one sentence): the topology joins doctor as the residual's third advisory surface, divergence cross-referenced. **DES-AI-TRIGGER-FLOW-GATE UNCHANGED, checked** -- AI-reachability stays committed-repo-only; tier nodes carry no `aiTrigger` and no chainable badge, and `potential`-edge eligibility still reads only the repo enumeration. |
| 2026-08-13 | Issue #189 (closing pass: package prompt templates, OQ-019 deferral (b)). **DES-COMMAND-ENTRY-POINT AMENDED**: the template half of the /name fall-through hazard recorded and closed -- `getCommand()` forecloses the unregistered case, `promptsOverride` forecloses a package template shadowing a protected one, so both halves of what /name runs are pinned to reviewed content. **DES-OPERATOR-GLOBAL-OVERLAY UNCHANGED, checked** -- the overlay's trust class and mount are untouched; it gained a resource kind through the existing mount. **DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS UNCHANGED, checked** -- skills-tier resolution is untouched by the prompts work. |
| 2026-08-13 | Issue #189 (Gap 2, producer half: `run.command` in the triggers file). **DES-COMMAND-ENTRY-POINT AMENDED** with the producer-half decisions: legal on ALL FOUR trigger kinds (`run.skillsDir`'s capability-of-the-deployment reasoning — a webhook trigger runs what a cron trigger runs), exactly one of `flow`/`command` enforced at parse by the shared validator; forge command prompts are the same bare `/<command> [args]` — the envelope bypassed whole, delivery context handler-read from `event.json`, `CONST-ISSUE-TEXT-IS-DATA` held and arguably strengthened since nothing payload-authored renders into a command prompt; the `cmd:`-prefixed dedup slot so a command rule never coalesces with a same-named flow rule; the `commands` capability gate now enforced worker-side pre-spend (`job-image-commands-unsupported`, the label's second direction); the comment trailing-word override INERT on a command rule; and `DES-TRIGGER-INSTRUCTION-IN-THE-ENVELOPE`'s byte-for-byte objection answered head-on — command prompts are NEW prompts, every existing flow trigger's `prompt.md` stays byte-identical. **DES-AI-TRIGGER-FLOW-GATE AMENDED**: the command clause joins the injected-skills paragraph's neighborhood — never AI-reachable, and BUILT at the two producers rather than falling out, because no committed artifact exists for the gate to read (`chain-command-refused` before the charset check, no opt-in; `dispatch_run` structurally incapable plus a readable slash-leading-flow refusal; `OQ-022`'s allowlist closing shape unchanged in spirit, with the inversion stated on that row). **DES-JOB-OUTBOX-CHAINING AMENDED**: the explicit refusal token joins the validation ladder; commands may chain OUT, nothing chains INTO a command — ignoring the key under unknown-keys would enqueue a flow the agent did not request. **DES-TRIGGER-INSTRUCTION-IN-THE-ENVELOPE AMENDED**: command jobs have no envelope, and `run.instructions` is refused beside `run.command` rather than left inert — the cron refusal's accepted-where-it-does-nothing hazard, arriving through a bypassed envelope; the entry's byte-for-byte reasoning survives because no existing prompt changes. **DES-TRIGGERS-UNIFIED-FILE UNCHANGED, checked** — the shared validator gains a field, and the one-validator doctrine is exactly what makes the mutual exclusion fail both services identically; no engine merges, and the on × run matrix is untouched. |
| 2026-08-13 | Issue #189 (Gap 2, runner half). **NEW `DES-COMMAND-ENTRY-POINT`**: a trigger may dispatch a registered pi extension command; the runner's protocol ships first (env-authoritative `/command` prompt because pi's grammar fires only on a whole-text slash and a worker mismatch must not misclassify a flow job; pre-prompt `getCommand()` verification because an unregistered `/name` is not an error to pi and rides into a paid model call; handler throws observed via `extensionRunner.onError`, the pin's only channel, and classified retryable `command-error` by explicit user choice with the accepted cost stated; the fire-and-forget residual stated as pi's own contract; the `commands` image capability as the two-direction rollout gate, `replicas` pattern). The old docs premise ("nobody to type it inside a job") is recorded as contradicted by the pinned `session.prompt()` contract, proven by a keyless real-session pinned-contract test. **DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS UNCHANGED, checked** — flows keep their advisory posture; a command's registration check is a REFUSAL because unlike a flow there is no hint-style steady state in which an unregistered command is legitimate. **DES-PER-TRIGGER-JOB-IMAGE UNCHANGED, checked** — the capability label mechanism is reused, not changed. **DES-TRIGGER-INSTRUCTION-IN-THE-ENVELOPE UNCHANGED, checked** — envelope semantics move with the producer half. |
| 2026-08-13 | Issue #189 (Gap 1, doctor half). **DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS AMENDED**: the doctor layer is now specified in full — per-tuple lines in loader precedence order; repo tier read with the gate's ls-tree mechanics but HEAD-resolved by doctor and degrading to unknown on git failure (readFlowGate was considered and REJECTED for this read: its fail-closed catch turns a broken folder into deny, and "deny implies the file exists" would print a confident wrong ✓; the gate's no-ref rule guards against an agent self-authorizing, which a host preflight does not face); staged tier via the new `readStagedSkills` whose pattern-manifest packages read as not-enumerable because manifest patterns can DISABLE files and a wrong ✓ is the one inadmissible error direction. **DES-AI-TRIGGER-FLOW-GATE UNCHANGED, checked** — the gate itself is untouched; doctor copies its read mechanics rather than calling it, precisely so gate semantics stay pure WHO-may-fire. **DES-CLI-SURFACE UNCHANGED, checked** — doctor stays read-only/always-safe; the new checks carry no fixAction. |
| 2026-08-13 | Issue #189 (Gap 1, runner half). **NEW `DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS`**: flow resolution is verified at two advisory layers and refused at neither — the runner compares `PI_FLOW` against the LOADED skill names post-load, pre-session, pre-spend (`isFlowLoaded`, exact equality, `disableModelInvocation` counts) and reports a miss as one `flow_not_loaded` line; doctor is the approximate host-side layer, landing with the companion change. Records why report-not-refuse (flow is by doctrine a prompt hint; a refusal shipped in an image upgrade fails yesterday's jobs and burns a budget slot per delivery), why the runner layer is the exact one (pi names a skill `frontmatter.name \|\| parentDirName` at the pin, so only the loaded set is authoritative), and the rejected alternatives (boot-time failure — `parseTriggers` stays pure and absent-at-HEAD is a legal steady state; `event.json` carriage — execution knob, not a delivery fact; a new top-level outcome — admin surfaces drop unknown outcomes, new vocabulary rides a `reason`). **DES-AI-TRIGGER-FLOW-GATE UNCHANGED, checked** — the gate answers WHO may fire a flow and keeps its pinned-sha object-store read; the new entry answers whether the flow EXISTS in the box, and neither consults the other. **DES-TRIGGERS-UNIFIED-FILE UNCHANGED, checked** — the shared validator gains nothing; the flow travels as job data the queue already carried. |
| 2026-08-12 | Issue #181 (the budget lever and the trend lines). **DES-COST-FOLD-BY-SCAN AMENDED**: the fold gains `dailyByFlow` — the composite (day, flow) fold at the same loop `buildDaily` and `buildByFlow` already walk separately, gap-padded per flow over the SHARED span (small multiples are only comparable on one x-domain) with the machine-key/display-label split held (`flowLabelOf` extracted so the two flow folds cannot drift on what a flow is called). The series shares `daily`'s first-run origin for the same sparkline-density reason recorded on the `sinceMs` row. **CONST-BUDGET-BEFORE-TOKENS UNCHANGED, checked** — `readBudget`'s GET-only posture now covers the token counter too, and the new junk-URL parse guard degrades synchronously (the `readSchedulers` failFast posture; without it a canned "not-a-url" fixture burns the full timeout per test). **DES-ADMIN-VIA-PI-EXTENSION UNCHANGED, checked** (the dashboard's budget meters and `/dispatch budget` are untouched; the page ADDS a display, replaces nothing — the "no replacement on that" ruling). |
| 2026-08-12 | Issue #181 (insights becomes the ONE analytics surface). **DES-ADMIN-VIA-PI-EXTENSION AMENDED**: six in-component views become FOUR — the COSTS and GRAPH views leave the overlay for the insights artifact, taking their two per-view refresh policies with them (the stale-gated tick piggyback and the entry-plus-`r`-only posture existed for those fetch paths; the overlay is back to one snapshot poll plus the tail read); the slash-command list drops `costs` and `graph` for `insights`; the graph-html paragraph re-homes onto the bare `insights` command; the LIST footer's `c costs`/`g graph` pair becomes `i insights` (51+18=69 of 76 columns, the arithmetic comment re-run), and the `i` key resolves the overlay with a done-action so index.ts writes and opens the page between overlays — the addTrigger route, deliberately not a dep seam and not a TUI suspend bracket, and deliberately BEFORE the dialog guard (the action needs no dialogs, and an older pi without them must still reach the one analytics surface). `DES-QUEUE-BULLMQ-OVER-CUSTOM`'s parenthetical names the insights artifact now. The dashboard's fs ban is UNCHANGED, checked, and dashboard.ts drops its pricing/costs/graph-model imports entirely. **DES-COST-FOLD-BY-SCAN UNCHANGED, checked** (the fold and its joins are what the page is made of; nothing about them moved). **DES-GRAPH-EDGE-DERIVATION UNCHANGED, checked** (the edge rules' one home; the model gained no vocabulary). |
| 2026-08-12 | Issue #175 (the insights artifact, the fourth slice). **DES-ADMIN-VIA-PI-EXTENSION AMENDED**: `insights html` joins the slash-command list (bare `insights` answers usage — the artifact IS the feature), completion covers `insights html <window>`, and the artifact lands beside `graph.html` under the one `graphDir` (a second directory would churn resolvePaths and the wizard for zero capability). The no-port property (:913) and the served-page rejection (the #54 row) are not reopened: this is a second `file://` artifact, same socket-to-file substitution. The factoring facts are load-bearing and recorded here: `graph-html.mjs` may be a source of exports for a sibling pure emitter, it may never load one itself — its purity pin is substring-level and directional, which is exactly what makes the reuse safe — so `buildGraphScene` (the normalize+layout+SVG-emission half of `buildGraphHtml`, a behavior-preserving extraction) is what `insights-html.mjs` composes, and the money strings come from the REAL `panel.mjs` formatter (zero own module loads there), not a hand-copied twin. Rejected: a shared third emitter module (impossible under the substring ban without weakening it); duplicating the layout/escaping (an escapeHtml drift between two artifacts is an XSS waiting); folding costs into `graph.html` in place (an operator sharing topology should not be forced to share spend); a charting library (the file:// posture forbids external requests, and hand-rolled rectangles need no supply chain). **DES-GRAPH-EDGE-DERIVATION UNCHANGED, checked. DES-COST-FOLD-BY-SCAN UNCHANGED, checked** (the artifact consumes the fold; the fold learned nothing new). |
| 2026-08-12 | Issue #175 (spend and schedule on the graph, the third insights slice). **DES-GRAPH-EDGE-DERIVATION AMENDED**, one clause: a trigger node may carry `cost` (the typed spend `foldTriggerCosts` mapped onto its node id) — spend is a node fact beside runs/lastOutcome, NOT a new edge kind and NOT a flag, so the closed vocabularies and their pins stand byte-identical; the assemblers wire it with one extra file read (subscriptions) and two pure folds over the scan they already paid for, which is why the GRAPH view's entry-plus-`r`-only refresh policy is untouched (the real-poll pin proves it). **DES-ADMIN-VIA-PI-EXTENSION AMENDED**: gtrigger rows phrase `next` as a countdown against the model's own `generatedAt`, never a live clock — a stale model shows its stale countdown honestly, and render() stays a pure read of state. graph.html's normalizeModel allowlist gains `meta.chainRefusals`, `meta.injectedUnreachable` and observed-edge `lastEndedAt`; node `cost` is deliberately NOT allowlisted there (the page cannot use the `from` clause, and a hand-copied money formatter pinned by parity test is a cost the insights artifact avoids by taking the real formatter). **DES-COST-FOLD-BY-SCAN UNCHANGED, checked.** |
| 2026-08-12 | Issue #175 (per-trigger and per-repo spend, the second insights slice). **DES-COST-FOLD-BY-SCAN AMENDED**: the fold gains `byTrigger`/`byRepo` rollups and the `foldTriggerCosts` node-id-keyed spend map, with the join passed IN (`attributeRunsToTriggers`, new in the read-model beside `joinRunsToTriggers`, whose index+type doctrine and cron jobId grammar it reuses verbatim — `triggerMatchLabel` is now exported from graph-model so the label vocabulary has one home); "the fold re-deriving the join" joins the Rejected list. `repoOfTarget` moves the target-stripping grammar into costs.mjs and `forgeRepoTargets` now calls it, so the graph's repo list and the cost fold's repo table can never disagree on what a repo is. **DES-ADMIN-VIA-PI-EXTENSION AMENDED**: the COSTS view's `f` cycles four tables; the trigger join adds one FILE read (readTriggers) to fetchCosts — no spawn, so the 10s stale-gated poll piggyback policy stands and the GRAPH view's entry-plus-`r` posture is untouched. **DES-GRAPH-EDGE-DERIVATION UNCHANGED, checked.** |
| 2026-08-12 | Issue #175 (cost-fold correctness, the first insights slice). **DES-COST-FOLD-BY-SCAN AMENDED**: `window.days` — the proration denominator — now comes from the requested window (`sinceMs`, the same instant the caller cut the scan at), with `firstRunMs` riding beside it for renderers that want the observed left edge and the observed-span derivation kept for window-less callers; the first-observed-run derivation moves to Rejected as a refuted correction (a sparse window shrank the denominator and flipped verdicts to SAVING). `COSTS_WINDOWS`/`costsSinceMs` move INTO `costs.mjs` beside the fold so the scan cutoff and the denominator cannot drift — the dayKey-import reasoning at day grain, applied at window grain. Daily buckets still start at the first observed run, deliberately: a month of leading zero cells on a young deployment would compress the sparkline's visible history to nothing. **DES-SUBSCRIPTIONS-ARE-COUNTERFACTUAL-ONLY UNCHANGED, checked. DES-ADMIN-VIA-PI-EXTENSION UNCHANGED, checked** (no new view, no key change — the COSTS view's refresh policy and layers are untouched). |
| 2026-08-11 | Issue #54 (the HTML export — the slice #54's own text ruled out, landed by narrowing what was actually ruled out). **DES-ADMIN-VIA-PI-EXTENSION AMENDED**: `graph html` writes a self-contained HTML artifact (inline SVG/CSS/JS, `file://`, zero external requests) atomically to the stable `<graphDir>/graph.html` and best-effort opens the browser via the worker's shared opener, printed-URL-first, skip-and-say over SSH/headless. The Why this row exists: issue #54 said "no web/HTML surface — the admin binds no port; that property is load-bearing", and the property survives INTACT, because the property was always the **port**. A file with no server is not a surface: nothing listens, nothing off-machine gained reachability, and the socket→file substitution is the same one `DES-JOB-OUTBOX-CHAINING` canonised for the outbox. `DES-QUEUE-BULLMQ-OVER-CUSTOM`'s "drops the web surface entirely" line — the one a reviewer would quote against this — is REWORDED to "drops the SERVED web surface" rather than argued around. Two new Rejected entries record the real lines: a served graph page (the removed surface re-proposed with a prettier face) and raw `.log` bytes in the artifact (the placement boundary does not become an escaping promise in a durable file). Content rule: run-record fields and operator-authored strings only; folder basenames, never host paths. The write is the writeTriggers idiom (atomic, named path, fail-loud); the spawn seam is `index.ts`'s, the dashboard stays I/O-free, USED_API stays four members. New `OQ-024` records the opener-spawn WATCH residual. |
| 2026-08-11 | Issue #54 (the GRAPH view). **DES-ADMIN-VIA-PI-EXTENSION AMENDED**: the overlay gains its sixth view, **GRAPH** (`g`) — the topology from the same assembled model as `/dispatch graph`, so the two surfaces cannot disagree (`DES-GRAPH-EDGE-DERIVATION` stays the one home of the edge rules). The data path is stricter than COSTS on purpose: fetch on entry and on `r` only, never on the poll tick, because `fetchGraph` spawns git per enumerated folder — pinned by a test that runs a real 10ms poll and counts fetches. The LIST footer absorbed `g graph` by merging the pause/resume pair into one `p/r pause` hint and dropping `↵` from the nav hint — still exactly 76 visible columns at width 80, ellipsis-free, pinned. Two overdue postures landed with the view: `PI_DISPATCH_ASCII=1` now flips the OVERLAY styler too (`makeStyler`'s per-instance `ascii`, threaded from the same resolved paths as the `setGlyphs` funnel — the half-ASCII gap the 2026-08-01 row's "at extension load" phrasing papered over), and the graph rows' glyphs (`arrowRight`/`foldOpen`/`foldClosed`/`rearm`) join the styler twin tables width-identical, so the 80-col invariant holds on ASCII terminals. The unframed degrade reuses `renderGraph` whole (uncollapsed, the everything-else-failed rendering). The fs ban UNCHANGED, checked — `fetchGraph` is a `createDashboardDeps` seam over read-model functions like every other byte the overlay renders. The tool surface UNCHANGED, checked (no `dispatch_graph`; the count pin stands). |
| 2026-08-11 | Issue #54 (`/dispatch graph`). **DES-ADMIN-VIA-PI-EXTENSION AMENDED**: `graph` joins the slash-command list — an operator-typed, ungated read on the `runs`/`costs` tier, rendering `renderGraph(assembleGraph(...))` into the admin channel with `triggerTurn` never set. The subcommand is deliberately NOT an LLM-callable tool (the enumeration spawns git per folder; the tool-count pin stands). The USAGE string and KNOWN_SUBCOMMANDS array are now pinned to agree member-for-member by a wiring test, closing a drift class this amendment would otherwise have widened. The dashboard's source-regex fs ban UNCHANGED, checked; the five-views count UNCHANGED for now (the GRAPH view is the next slice and will amend the Decision when it lands). |
| 2026-08-11 | Issue #54 (the model assembler). **NEW `DES-GRAPH-EDGE-DERIVATION`**: the graph's edge honesty rules, in one pure fold (`buildGraphModel`). Four evidence classes (`config`/`observed`/`potential`/`cron-rearm`, a closed test-pinned vocabulary), the two OQ-009 structural prohibitions (no forge-parent chain edges, no cross-folder chain edges — the harness makes both unrepresentable, so drawing either would draw a lie), precise dangling (`no-skill` only where enumeration succeeded; unverified is not dangling; `charset-invalid` is its own flag because the gate's `deny` proves nothing about existence), three-way orphanhood, caps and honesty counters on every model. The interesting rejections are recorded: an all-pairs gate-eligibility fabric (eligibility is a node badge, a mention is the edge, or the graph is noise) and first-match resolution of ambiguous observed-edge targets (dropped-and-counted beats pinning real history onto the wrong folder). **DES-JOB-OUTBOX-CHAINING UNCHANGED, checked** (the graph consumes its record fields and caps; nothing about collection moves). **DES-COST-FOLD-BY-SCAN UNCHANGED, checked** (same scan, second consumer, still fold-time-derived and never stored). |
| 2026-08-11 | Issue #54 (the data layer under the trigger/flow graph). **DES-ADMIN-VIA-PI-EXTENSION AMENDED**, and this row says out loud what the last three dashboard rows certified as unchanged, because this time it DID change: a new read-model surface and new fs/git access. `readFolderSkills` enumerates a cron folder's committed skills from the git OBJECT STORE at HEAD via the worker's own `selectEntries`/`keepOnlyDeclaredSkills` (a `./materialize` exports-map subpath added for exactly this — re-deriving the listing parse admin-side is how the graph would show a skill the job path never materialises), one hardened `ls-tree` plus one bounded `cat-file` per top-level SKILL.md, with the frontmatter read through the gate's own newly exported `aiTriggerAllows`. `readInjectedSkills` lists a `run.skillsDir` from the working tree and is labelled advisory (the doctor precedent; host files have no object store to prefer). `cronRunStats`/`joinRunsToTriggers`/`observedChainEdges` fold already-scanned records into the joins the graph will draw; `collectGraphInputs` is the one dedupe/caps funnel over the folder spawns. Everything is never-throw, degrades per folder to a discriminated `unreachable`, and is bounded by the frozen, literal-pinned `GRAPH_LIMITS`. Three properties re-affirmed rather than assumed: the enumeration is DISPLAY-ADVISORY and never a gate decision (`DES-AI-TRIGGER-FLOW-GATE`'s pre-agent-sha truth untouched; HEAD-at-display-time answers what the NEXT run will see, a different question, and an unreadable SKILL.md reads as NOT chainable); the dashboard's source-regex fs ban UNCHANGED, checked (every new spawn and read lives in read-model.mjs); the `.log` placement boundary UNCHANGED, checked (the folds read `.json` records only). `resolvePaths` mirrors the chain caps with defaults IMPORTED from the worker (new `CHAIN_DEPTH_MAX_DEFAULT`/`CHAIN_MAX_PER_JOB_DEFAULT` exports) so the graph can never state a cap the worker does not enforce, and `readTriggers` display records now carry the RAW triggers-array index — the identity `matched.index` counts, cron entries and unusable rows included, so a dropped row leaves a hole rather than renumbering every attribution below it. The graph VIEW itself is a later slice; this row is only its data. |
| 2026-08-09 | Issue #60 (Gap 3). **NEW `DES-TRIGGER-INSTRUCTION-IN-THE-ENVELOPE`**: the operator's text goes in the user prompt's envelope, above the fenced data region and BEFORE the never-merge paragraph, because later text reads as more specific and the harness's non-negotiables must not look like something an operator instruction is qualifying. Five rejected alternatives recorded, and two of them are the interesting ones. Inside the fenced data region it would be DOCUMENTED TO BE IGNORED, since `dataRegion` tells the model everything below its heading must be reported rather than obeyed -- the accepted-where-it-does-nothing hazard. In the system prompt it would work and be marginally cheaper per turn, and is still refused: every other member of that layer is read from a fixed file path once at loader build, which is the shape `CONST-PERSONA-IN-CACHED-PREFIX`'s acceptance leans on, and `run.task` is already contracted user-prompt-only, so two operator text fields with two placements would be an incoherence. Also rejected: reusing `run.task` on webhook triggers, giving local jobs an envelope so cron could take the field, and content-filtering the operator's text (placement is the boundary; the delimiter is defence in depth, and this module's docstring already refuses that reasoning for the payload). Putting it in the envelope is what leaves `dataRegion` UNCHANGED, so the shared export keeps its signature and the new-parameters-go-last rule is honoured without threading a hole through three sibling forges. **DES-FLOWS-ARE-DATA-PERSONA-IS-CODE UNCHANGED, checked**: its clarification already admits operator-authored deploy-time config, and the reviewed `triggers.json` is that; the admin-editable runtime channel it actually bars is untouched, since no `dispatch_trigger_*` parameter was added. |
| 2026-08-09 | Issue #60 (Gap 2). **NEW `DES-TRIGGER-SKILLS-COPIED-NOT-MOUNTED`**: the injected skills are COPIED into the per-job dir rather than bind-mounted, and the mount-count argument is deliberately recorded as the WEAKEST of the three reasons. The copy is the PIN: `:ro` bounds the container and not the host, and pi reads a skill's body on demand, so under a live bind an operator editing their directory would change the instructions of a job already running. It also answers symlinks once on the host side, where `loadSkillsFromDirInternal` would otherwise follow both file and directory links -- a directory symlink at `/` would have turned skill discovery into a walk of the container filesystem. And it adds no mount, so this entry CAN borrow the argument the 2026-07-31 `/session` row explicitly could not. Four rejected alternatives recorded, including the per-trigger `:ro` bind the issue originally sketched (with the honest qualification that a bind's source path is legible via `/proc/self/mountinfo`) and an env var naming the injected root (a second source of truth that can disagree with the filesystem, silently and in the expensive direction). **DES-AI-TRIGGER-FLOW-GATE AMENDED**: injected skills are trigger-reachable and never AI-reachable, and it FALLS OUT rather than being built -- the gate reads the object store at a pre-agent sha and an injected skill has no object-store presence, so `no-skill` and both callers refuse. The corollary is stated because an operator cannot discover it: an injected `ai-trigger: allow` is never read, `doctor` warns, and the residual is `OQ-022`. **DES-OPERATOR-GLOBAL-OVERLAY UNCHANGED, checked** -- its own rejected `/opt/pi-packages:ro` mount is the precedent the new entry cites, and the overlay's tier is unmoved. |
| 2026-08-08 | Issue #66 (ingest `pull_request_review`). **DES-PR-TRIGGER-ROUTES-TO-FLOW AMENDED**: a submitted review routes through this same decision rather than getting one of its own — the harness still implements no review behaviour, does not change the clone ref, and hands the flow the PR context plus the review's four fields. Two consequences recorded because they are the shape of the decision rather than details of it: `review.state` reaches the flow as DATA, so "only act on changes_requested" is a flow decision, while `on.reviewState` is the operator's separate and cheaper control over what is worth paying for at all (the same split as a label predicate versus what the skill does once it runs); and `review.id` is carried because the review's inline comments ride an event this project does not ingest, so fetching them is the flow's job. Rejected gains two entries: a fifth `on.type` for reviews (GitLab's `approved` already rides `pull_request`), and ingesting `pull_request_review_comment` (one delivery per line comment, a volume characteristic nothing else here has). **DES-GH-POLLING-TRANSPORT AMENDED**: a fourth source, `GET /pulls/{n}/reviews` over the OPEN pull requests the PR feed already fetched, so a polled deployment can arm a review trigger at all — without it the trigger loads clean and can never fire, which is the silently dead config this project refuses everywhere else. Its cost model is written down because it is the first per-entity source: validators live in ONE hash keyed by PR number rather than a key per PR, since an unbounded key family would break the "refresh the cursor family as a unit" TTL argument this entry rests on; the idle steady state is one quota-free 304 per open PR; the sweep is bounded and LOGS when it truncates. Two correctness calls stated rather than assumed: the sweep runs even when the open-PR list itself answers 304, because whether a review perturbs that list is GitHub's business and betting on it would mean review triggers that fire only when something else touches the PR; and the cursor is persisted ONCE per sweep rather than per review, because many endpoints' ids interleave, so per-item advance would either re-enqueue or strand — a mid-sweep failure retries the whole sweep and dedups on `poll-rv<id>`. **DES-TRIGGERS-UNIFIED-FILE UNCHANGED, checked** — `review_submitted` and `on.reviewState` are an action word and a narrowing inside the existing `pull_request` type, so the file's on × run matrix is untouched. **DES-GH-APP-MANIFEST-SETUP UNCHANGED in shape, checked** — `default_events` gains `pull_request_review` for every new App, armed or not, the same posture `pull_request` already has for a label-only deployment; existing Apps must add the subscription by hand. |
| 2026-08-07 | Issue #102: **DES-OPERATOR-GLOBAL-OVERLAY** gains the discovery design and the four calls behind it — read pi's `settings.json` rather than walking its hoisted `node_modules` (where an installed package and a transitive dependency are indistinguishable, so a walk would stage code nobody asked for) while capturing the version off disk; treat a convention dir as sufficient, correcting the issue's `pi`-key predicate against the pinned source; default ON inside `--with-packages` with the opt-in-for-one-release alternative rejected and recorded; and scope all-or-nothing to the DECLARED set so one bad host package cannot zero a working overlay. Also records the boot-read to per-job-read change and why the original was right at the time, and that skills/prompts/themes enablement plus glob evaluation were deliberately left out. **DES-CLI-SURFACE UNCHANGED, checked** — `--no-host-packages` is a flag on an existing command, and the never-tier it defines is what kept the new doctor checks free of a `fixAction`. |
| 2026-08-04 | A docs audit found six code defects; these are the two that changed a recorded decision (issue #99). **DES-TRIGGER-OUTSIDE-PI amended**: every forge arm is conditional now, GitHub included. Its identity resolution and `WEBHOOK_SECRET` requirement were unconditional while the other three arms were gated, so a forge-only deployment could not boot the receiver without `gh` logged in and a webhook secret it would never use; all three forge docs described a setup that stops at that wall. The uniform gate keeps the property that mattered: skipping identity resolution is sound only because the route is absent too, an unconfigured forge answers 404 rather than 401, and the guard must return if `/` is ever mounted unconditionally again. **REQ-RESUMABLE-SESSION amended** (requirements.md): its "one case fails CLOSED" clause was specified and never implemented, so an armed `run.resume` with no `PI_SESSIONS_DIR` ran cold and exited green, which is the exact failure the clause exists to prevent; the pre-spend refusal now exists, which also makes two `session-store.mjs` comments and doctor's fix text true. Cron `run.resume` moves from accepted-and-silently-ignored to refused at load, on `run.replicas`' precedent and for its reason. **CONST-HMAC-OVER-RAW-BODY UNCHANGED, checked**: the secret is still required wherever a GitHub endpoint exists to verify. **CONST-BUDGET-BEFORE-TOKENS UNCHANGED, checked**: the new session gate is a free pre-spend refusal that reserves no slot. |
| 2026-08-04 | The front door becomes the default route (issue #96). **DES-FIRST-RUN-SETUP-WIZARD amended**: bare `/dispatch` with nothing configured lands directly in the wizard's opening select — the select is the consent, replacing the yes/no offer; the outage rule is restated load-bearing (a configured deployment with a down queue keeps the banner, never the wizard). Two steps join the flow: a Docker pre-check (capture probe, Re-check/Continue/Stop loop, per-OS pointers, never a piped installer) and a trigger-edge choice (receiver as a service via a consented pinned `@edgehero/pi-dispatch-receiver` install + `service install --receiver`; compose profile with the compose file now shipped in the runtime package and copied create-only; or the polling command printed). A once-per-process skew notice makes re-running setup the visible upgrade path. **Fixed in the same change, recorded plainly**: `service` units were broken for every npm deployment — the renderer derived a "repo root" two directories above its module, which in an npm install is the scope directory, so ExecStart/EnvironmentFile/wrapper paths all pointed at nothing; units now anchor on the deployment dir (WorkingDirectory, `.env`, logs) and resolved script paths (the CLI beside the service module; the receiver via `import.meta.resolve`), the wrapper execs the argv the render substituted instead of guessing, and npm-layout fixtures now exist so the seam that masked this cannot mask it again. **CONST-RETRY-INFRA-ONLY UNCHANGED, checked**: the exit-2 conversion survives the wrapper contract change, asserted against the real shipped wrapper. pi compatibility becomes strategy instead of luck: the peer widens to the `"*"` range pi's own packages doc prescribes for host-provided packages (the exact devDep pin stays the tested marker), a runtime advisory names an untested pi version on first `/dispatch` (never a refusal — the capability probe stays the only hard gate), and a weekly canary installs latest pi into a scratch dir (never the repo root — the pinned assertions must keep asserting the pin) and fails CI when any used API member or type needle disappears. |
| 2026-08-04 | The console becomes the front door (issue #92). Added **DES-FIRST-RUN-SETUP-WIZARD**: `/dispatch setup` + the bare-`/dispatch` no-deployment offer + a once-ever startup nudge, built as dialogs-first with **overlay-per-handoff** (the `tui` suspend handle exists only inside a `ctx.ui.custom` factory; dialogs cannot run under a capturing overlay; stdin is unreadable while suspended — so each attached child gets its own short-lived overlay, and the child's OWN consent gates are the host-mutation consents: the wizard forwards `--yes` to nothing). npm step under import-pi's spawn doctrine, with the recorded reasoning for `--ignore-scripts` on our own runtime (pure-JS deps; msgpackr's native accel is optional with a JS fallback). No new tier, no new powers, no model-callable tool; the only novel artifact is the pointer file (INT-DEPLOYMENT-POINTER-CONTRACT). Rejected on the record: long-lived wizard overlay, clone reuse, detached worker, credential dialogs, auto-writing `ai-trigger: allow` (two keys stay two keys). **DES-TRIGGER-OUTSIDE-PI UNCHANGED, checked**: the wizard bootstraps host processes, never hosts them. **DES-CLI-SURFACE UNCHANGED, checked**: every tier the wizard drives is entered through that entry's own gates. |
| 2026-08-02 | The public URL becomes optional (issue #81, second half). Added **DES-GH-POLLING-TRANSPORT**: `pi-dispatch-receiver poll` synthesizes INT-WEBHOOK-PAYLOAD-SUBSET shapes from REST responses (issue events / comments / open PRs; ETag 304s are rate-limit-free; first boot never replays history; per-repo failures never kill the loop) and feeds the unchanged pure `filter()` + shared enqueue with `poll-*` delivery ids — the receiver stays the default and the low-latency path. Trust framing recorded: TLS with the operator's own credential replaces HMAC because authentication points the other way; `WEBHOOK_SECRET` is not required in poll mode, still hard-required for `serve`. The Actions-runner transport is rejected on the record (merge-gated workflow code executing on the worker host = merge-to-default becomes host code execution outside the container boundary). **DES-TRIGGER-OUTSIDE-PI UNCHANGED, checked**: the poller is the same always-on process class, just a different transport. **CONST-ISSUE-TEXT-IS-DATA UNCHANGED, checked**: the poller never interprets bodies. |
| 2026-08-02 | The App path becomes the easy path (issue #81). Added **DES-GH-APP-MANIFEST-SETUP**: `pi-dispatch setup github` runs GitHub's App Manifest flow against a throwaway loopback listener — one browser click returns app id + PEM + webhook secret via the unauthenticated single-use conversion endpoint; every `.env` line is shown before one explicit consent, the PEM lands 0600 and never clobbers, an existing `WEBHOOK_SECRET` is kept (replacing it would invalidate working deliveries), installation-id discovery uses a deliberately hand-rolled ~15-line `node:crypto` RS256 JWT (auditable, once-at-setup; job-time minting stays `@octokit/auth-app`, unchanged), and `--no-webhook` creates the hook-inactive shape the polling transport will consume. No `--yes` on this wizard — these writes carry credentials. Rejected on the record: a maintainer-registered device-flow client (maintainer dependency in a self-hosted trust chain) and auto-installing the App (automating a consent screen defeats it). **CONST-TOKEN-SCOPED-PER-JOB UNCHANGED, checked**: the wizard changes how credentials are *acquired*, not how job tokens are minted or scoped. **CONST-HMAC-OVER-RAW-BODY UNCHANGED, checked**: the webhook secret the flow mints feeds the same verify path. |
| 2026-08-02 | The receiver gets a container story (issue #82). Repo-layout `deploy/` line updated: `docker compose --profile receiver up` runs the receiver beside Valkey from a prebuilt `ghcr.io/edgehero/pi-dispatch-receiver` image (multi-arch, GITHUB_TOKEN-published like pi-job); the default `docker compose up` stays Valkey-only. The receiver was the natural candidate — `grep docker receiver/src` is empty, it is the only internet-facing process, and containerising it costs nothing the trust model cares about. **DES-WORKER-ON-HOST UNCHANGED, checked**: the worker remains a host process — no service in the compose file mounts docker.sock, and the profile's existence changes nothing about why the worker cannot be containerised (client-side path translation, local-folder bind mounts). SECURITY.md's trusted-components row holds verbatim: a containerised receiver still never executes agent-authored content, and HMAC-before-parse is unchanged. |
| 2026-08-02 | The clone stops being the only distribution (issue #80). **DES-NAME-KEEP-PI-DISPATCH amended, on its own terms**: its change trigger ("wanting to publish *any* npm artifact under this name — a management CLI") fired, and the resolution is scoped publishing (`@edgehero/pi-dispatch` = worker + CLI, `@edgehero/pi-dispatch-receiver`), not the rename — the collision only ever bound the bare name. The amendment also retro-records `@edgehero/pi-dispatch-admin`, which shipped 2026-07 without a row here: practice had diverged from the entry's unqualified "Do not publish to npm" line, and a constitution that quietly diverges from what ships is worse than none. The two checkout-relative runtime escapes are closed package-relative (worker/.env.example, worker/deploy/ mirrors with byte-equality sync tests against the root copies — the root files stay the documented, edited source). Bare `npx pi-dispatch` outside a checkout resolves to the squatter's package; docs use scoped forms everywhere. **DES-WORKER-ON-HOST UNCHANGED, checked**: npm-on-host is the architecturally correct distribution for a worker that must drive the host docker CLI. **CONST-PI-VERSION-PINNED UNCHANGED, checked**: the pins travel into the published packages byte-identical. |
| 2026-08-02 | Durable running becomes a subcommand (issue #80). **DES-CONCURRENCY-3 amended**: the one-worker-per-docker-daemon boot-reaper invariant is now *enforced* at unit-mint time — `pi-dispatch service install` refuses a worker unit when one exists in the other scope; previously the invariant was one unenforced paragraph. `service` renders the shipped deploy/ templates by substituting their documented literals (`/usr/bin/node` → `process.execPath`, `/opt/pi-dispatch` → the real repo root) rather than introducing marker syntax, so the templates stay byte-usable examples and deploy-lint keeps checking exactly what ships; a pin test asserts every substitution literal is still present, making template drift a build failure instead of a broken render. The launchd gap is closed in the wrapper, not the plist: `KeepAlive/SuccessfulExit=false` cannot express exit-code-conditional restart, so `worker-env-wrapper.sh`/`.cmd` convert EXIT_POLICY (2) to a clean exit with a loud refusal note — launchd never relaunches a determinate policy refusal, mirroring systemd's `RestartPreventExitStatus=2` and nssm's `AppExit 2 Exit` (**CONST-RETRY-INFRA-ONLY UNCHANGED, checked**: the conversion is where the *supervisor* learns what the exit space already meant; the exit protocol itself is untouched). The wrapper's `exec` gave way to a trap/double-wait form because exit-2 interception needs a live parent — SIGTERM still reaches node via the trap. **DES-WORKER-ON-HOST UNCHANGED, checked**: `service` supervises the host process the entry mandates; nothing moves into a container. |
| 2026-08-02 | The CLI surface gets a recorded gate ladder (issue #80). Added **DES-CLI-SURFACE**: read-only (`doctor`, `status`) / operator-typed-ungated (`run`, `pause`, `resume`, `sandbox`, `import-pi`) / create-only (`init`) / consented host mutations (`up`, `doctor --fix` — each action shown verbatim, y/N default No incl. non-TTY), plus the load-bearing never-tier (no malformed-config rewrites, no triggers/pause-windows content, no trigger-named `run.image` pulls — only the deployment default, where the consent keypress is SECURITY.md's "pulled it yourself" act). `init`/`doctor` had no recorded surface at all, and the ladder makes "may this be automated?" a lookup. **DES-WORKER-ON-HOST amended** (Accepted cost): `up` sequences the surrounding chores behind consent; the price — the worker is a host process the operator runs — is unchanged, only the typing shrank. **DES-CLI-TRIGGER-FOR-LOCAL UNCHANGED, checked**: `up` is not a producer; it enqueues nothing. **INT-CONFIG-OVERLAY-CONTRACT UNCHANGED, checked**: its repair-write precedent is cited by the fix-tier reasoning, not extended — `--fix` never rewrites an invalid overlay; that stays the admin write path's documented repair. |
| 2026-08-01 | **`DES-ADMIN-VIA-PI-EXTENSION` amended** (dashboard polish): run targets render as OSC-8 hyperlinks **only when the URL is derivable from id-only fields** (github `repo#N`; other forges' instance hosts are unknowable from the record, so no URL is ever guessed) — display-only escapes, byte-identical passthrough under the plain theme, and `visibleLen` already strips OSC-8. `y`/`Y` in RUN_DETAIL copy the job id / target URL via a new injected `copyText` seam whose OSC-52 emission lives in index.ts (the dashboard stays I/O-free); operator-initiated, id-only strings, nothing read back — recorded in SECURITY.md. LIVE_TAIL gains `/` search over the captured tail (a line-input layer above the view, popping on the established one-Esc-per-layer discipline; matches jump and suspend follow exactly as manual scrolling does; **untrusted bytes still pass only through `clip`** — the match highlight colors post-clip). The LIST and COSTS frames become height-aware through an injected `terminalRows` seam: sections collapse to their divider-plus-count by fixed priority (pause windows → settings → triggers → spend; COSTS: by-model → plans → daily), the cursor's section and the verdict block never collapse, and an absent seam renders byte-identically to before. The fs ban and every width invariant **UNCHANGED, checked**. |
| 2026-08-01 | **`DES-ADMIN-VIA-PI-EXTENSION` amended** (issue #53, `REQ-COST-ANALYTICS`): the overlay gains its fifth view, **COSTS** (`c`) — verdict-first analytics over one `DES-COST-FOLD-BY-SCAN` fold: per-plan verdicts with the API-rate comparison line, a daily sparkline, by-flow/by-model tables whose money cells all funnel through the typed-cost formatter, plan blocks with amortized $/run and peak-window facts (never burn-down), a provenance footer naming the pi-ai pin, and the keyboard what-if (`w` shortlist cycle; `/` type-to-filter over the full priced catalog via the line-input primitive — the long tail lives in the TUI now that the primitive exists, and in `/dispatch costs whatif` for scripting). The costs data path is lazy and throttled (view entry + window change + stale-tick refresh): the fold is cheap, but a per-second full-directory scan is the quiet load a dashboard must not add. `/dispatch costs [7d\|30d\|mtd]` renders the same fold plain for the degraded path; `dispatch_costs` returns it as JSON with `class` on every monetary value, so the model-facing surface cannot launder an estimate any more than the human-facing one. `PI_DISPATCH_ASCII=1` flips every panel/overlay glyph table to the ASCII twins at extension load (the switch the primitives shipped; the env decision lives at the entry point, keeping panel.mjs pure). The dashboard's source-regex fs ban is **UNCHANGED, checked** — the costs data arrives through `createDashboardDeps` seams over the read-model, like every other byte the overlay renders. |
| 2026-08-01 | **`DES-ADMIN-VIA-PI-EXTENSION` amended** (issue #71, dashboard usability): the LIST runs list becomes a cursor-following 10-row viewport over the read model's 50-record window with `↑/↓ N more` edge markers (raising the fetch from 10 to 50 without growing the frame); `Tab` jumps between the trigger and run section heads; `o` cycles the runs sort (time → tokens → cost → outcome — absent numbers sort last because a pre-metering record is unknown, not cheap, and Enter opens the row the sorted list shows because cursor and renderer share one rows model); the long-advertised-but-unbound `l` now opens the live tail of the active job and stays inert without one; LIVE_TAIL opens pinned to the bottom in follow mode (scroll-up pauses, bottom re-arms, footer names the state — it previously opened ~180 lines behind the head at the top of the tail window); RUN_DETAIL gains `←`/`→` in-place record walking with the LIST cursor following; a cron trigger row in LIST carries the amber `⚠ overdue`/`⚠ stalled` badge previously visible only in TRIGGER_DETAIL; and `x` delete arms an in-frame y/n whose `y` alone signals `deleteTrigger` with `confirmed: true`, letting `deleteTriggerEntry` skip the duplicate `ctx.ui.confirm` while still writing through the shared validator — the dialog path is unchanged for the model-initiated `dispatch_trigger_delete` tool, whose `confirmedWrite` gate is **UNCHANGED, checked**. The fallback `matchesKey` in `keys.mjs` learned `left`/`right`/`home`/`end`/`backspace` so the overlays' new keys cannot be silently eaten when pi-tui is unresolvable. No new read-model surface, no new fs access; the dashboard's source-regex fs ban is **UNCHANGED, checked**. |
| 2026-08-01 | Added **`DES-COST-FOLD-BY-SCAN`** (issue #53, gap 4): cost aggregation is a read-only, filename-keyed scan of the run-history sidecars (`scanRunRecords`, `listRuns`' sibling without the 50-clamp; retention-bounded, hard-capped at 92 days even under keep-forever) folded by a pure fs-free `admin/src/costs.mjs`. The load-bearing decision: **classification happens at fold time and is never stored** — sidecars hold immutable facts, subscriptions/rates are opinions recomputed per fold, so editing `subscriptions.json` retroactively reclassifies history correctly. Every emitted dollar is a typed `{usd, class, floor, coverage}` value; one estimated addend demotes a sum visibly. Rejected, each with its reason: an embedded analytics store (re-refused under `DES-RUN-HISTORY-FLAT-FILES-NO-DB`); rollup/index files beside the sidecars (a second source of truth that goes stale on every sweep, retry overwrite, and subscriptions edit, to win milliseconds that were never being lost); a redis cost series beside `budget:t:*` (TTL'd enforcement state is not history); storing the classification on the record (a record written under one subscriptions file lies under the next). **`DES-RUN-HISTORY-FLAT-FILES-NO-DB` UNCHANGED, checked and leaned on** — the fold is exactly the bounded, not-a-query-surface scan that entry reserves. |
| 2026-08-01 | Added **`DES-SUBSCRIPTIONS-ARE-COUNTERFACTUAL-ONLY`** (issue #53): subscription plan prices live in an operator-authored `subscriptions.json` and feed counterfactual arithmetic only — never auth, routing, or model selection; the worker exports the shared validator and reads nothing at job time. Why: subscription-backed providers ship all-zero rate tables, so prepaid runs record cost 0 and read as free; the env boundary REFUSES subscription logins by design, making the operator declaration the only honest price source; and declaring a plan must never become a way to route to it. Rejected: vendor usage-API polling (a new network surface for numbers vendors barely publish), auto-detecting plans from zero-rate tables (a rate card is not a purchase), overlay keys instead of a file (the overlay is runtime tuning with fail-closed job-start semantics; prices are bookkeeping), and routing/auth integration (reopens the env-allowlist decision this design exists to respect). |
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
| 2026-08-30 | Issue #57, corrections found by an adversarial pass over the placement and kill-switch slices, all of them defects in code written earlier in this same PR. `DES-HOST-REGISTRY` **CORRECTED**: the registry is a LEASE and a kill switch must not be derived from one alone. A host whose registry writes fail for ninety seconds loses its row while its BullMQ worker -- a separate connection carrying `maxRetriesPerRequest: null` precisely to ride out blips -- keeps draining; a booting worker drains for up to one beat before its first row lands; and a clean `service restart` DELs the row outright. In all three a registry-derived pause misses that host and reports success. The unrecoverable direction is resume: pause with a host live durably pauses its queue, and a resume while that host is down never enumerates it, so the queue stays paused permanently with no surface able to name it. `pause`/`resume`/`status` now act on the UNION of what is live (the registry) and what EXISTS (BullMQ's own `bull:<queue>:meta` keys, which outlive their worker), which also RESTORES this entry's own stated test -- delete the whole `host:*` keyspace while the fleet runs and nothing decides differently -- that the registry-derived switch had quietly made false. The scan is bounded per call for the `maxRetriesPerRequest: null` reason above, is deliberately NOT on the panel's per-tick path, and fails open to the registry's answer. `INT-HOST-REGISTRY-CONTRACT` **AMENDED**: a new `routes` field carrying whether the worker DECLARED a name. Every worker publishes a row, named or not -- that is what lets an unnamed fleet be seen at all -- so deriving queue names from a row's mere existence invented `pi-jobs@<hostname>` for a queue nothing drains, gave a plain single-host deployment a phantom queue to pause and count, and falsified the byte-identity claim outright. Queue names are additionally VALIDATED against the worker-name charset and deduped, because they are re-derived from peer-written data: an unvalidated name containing `:` makes `new Queue` throw mid-enumeration and takes the kill switch out entirely, and a duplicated row double-counts one host's jobs. `DES-CRON-RECONCILE-GATED-ON-AGREEMENT` **CORRECTED ×3**: the fingerprint must be over the AUTHORED file on every path, and the live-reload path -- the one an operator actually takes when editing a trigger -- still hashed the placement-resolved set, so two hosts running an identical file refused each other on every edit, forever, which is the one outcome placement exists to make impossible. The projection was also blind to the whole `run` payload (it listed the keys of a NORMALIZED schedule, every one `undefined` on an authored entry), so a folder, flow, task or image changed on one host only passed the gate silently -- a divergence gate that could not see the divergence it exists for. And a host that cannot read its OWN file now refuses under a distinct `own-triggers-unreadable` token rather than comparing a null opinion against every peer and pruning on a comparison that never happened. Operator surfaces **CORRECTED**: the interactive panel built its own single queue and did its own pausing, counting and scheduler listing, so the fix to the read model had not reached it -- pressing `p` paused the shared queue alone while every named host kept spending, the header printed PAUSED for having done half of it, and the triggers section showed zero schedulers while cron ran. That is this slice's own named anti-pattern committed inside the commit naming it. A half-switched deployment now reads as `PART PAUSED` in the panel and carries `pausedPartial` plus the paused queue names out of `status`, a mid-loop failure names the queues it changed and the one it failed at, and an unreadable registry is reported rather than being silently indistinguishable from single-host success. |
| 2026-08-31 | Issue #57, forge placement. **NEW `DES-FORGE-ROUTING-AT-ENQUEUE`** in spirit, recorded against `DES-HOST-REGISTRY` rather than as a separate id because it adds no structure: it is one more READER of the row that already exists. Two trigger fields bind a forge job to a MACHINE rather than a repository -- `run.secretsProfile` names a resolver on one host's disk, a `run.waitFor` condition names a check script on one host's disk -- and #57's Gap 2 exempted forge jobs on the grounds that a fresh clone is portable, which issues #225 and #230 had already retracted without saying so. Decided at ENQUEUE and therefore in the RECEIVER, for the reason the pickup-gate alternative was rejected fleet-wide: BullMQ promotes a delayed job on each worker's own `Date.now()`, so the fastest clock wins every attempt deterministically and a job cannot be handed from a host that will not serve it to one that will. The rule lives in `worker/src/capabilities.mjs`, imported by both services, so the worker's pre-spend refusal and the receiver's routing read the same definition of what a job needs -- two copies would be two places for one to be quietly weakened while every test stayed green. Hosts advertise profile NAMES only: the registry's content rule is names, integers and digests, and a resolver path is operator topology everywhere and carries the OS account name on Windows. Rejected: routing on `run.resume`, because a session key is `sha256(kind, repo, ref)` and `session-store.mjs` itself records that anyone who knows the repository and branch can compute it, so publishing keys to route on would disclose which repositories and branches a deployment works on -- more than everything else in the registry combined. Rejected: a `run.host` field on the trigger, which duplicates a fact the host already knows, goes stale when a profile moves, and would thread a new field through all four receiver filter modules. `DES-CONCURRENCY-3`, `DES-SCOPED-LIMITS-AND-FOLDER-MUTEX`, `DES-CRON-RECONCILE-GATED-ON-AGREEMENT` **UNCHANGED, checked**: routing chooses a queue and changes no bound, no mutex and no reconcile. **Code evidence**: worker/src/capabilities.mjs -> routeForgeJob; receiver/src/route.mjs -> makeForgeRouter; receiver/src/receiver.mjs -> the four fanout arms. |
| 2026-08-31 | Issue #57, Gap 3, the merged run history. **`DES-RUN-HISTORY-FLAT-FILES-NO-DB` AMENDED, not reversed**: the flat files remain the record and the only durable store; what is added is a VIEW of them in Valkey so a fleet's panels can see each other's runs. The entry's objection is answered clause by clause rather than waved past. `DES-COST-FOLD-BY-SCAN` rejects "rollup / index files beside the sidecars -- a second source of truth that must be invalidated on every retention sweep, every retry overwrite, and every `subscriptions.json` edit", and the mirror stores NO DERIVED VALUE: it holds the sidecar's own bytes, so there is nothing to be stale relative to; a retry overwrites the same key exactly as it overwrites the same file; classification is still computed at fold time from `subscriptions.json` rather than frozen; and the TTL is strictly the shorter of the operator's retention and the deepest window any reader asks for, so the mirror can never show a run whose file is already gone. The clause the objection is RIGHT about is admitted rather than defeated: at the index cap a fold over mirrored records becomes a FLOOR, which is why the reader reports `truncated` as a distinct state. Shared storage is recorded as the FIRST alternative rather than an afterthought -- on a shared `PI_LOGS_DIR` the local read already IS the merged read and `mergeRuns(local, [])` is the identity function, which is why no second code path exists for that shape and why the docs present both. Rejected: mirroring the raw `.log`, which is the one artifact holding issue text, comment text and tool output, so a pointer travels and the bytes do not; and a projection instead of the whole record, because the record is PII-free BY CONSTRUCTION and copying it whole inherits that property where a projection would re-derive it at a second serialiser. **`DES-CRON-VIA-BULLMQ-SCHEDULER` UNCHANGED, checked, and the check is load-bearing**: an earlier draft of this slice planned a second `runs:cron:` index so `previousRunAt` could span hosts, and it is unnecessary -- cron schedulers are installed on the host queue, so a scheduler's fires all land on one machine and `makeFindPreviousRun` reading local files is already correct. One key not built because routing made it moot. **Code evidence**: worker/src/run-mirror.mjs -> makeRunMirror, readMirroredRuns, mergeRuns; worker/src/start.mjs -> recordRun; admin/src/read-model.mjs -> mergedRunsOn, listRunsMerged. |
| 2026-08-31 | Issue #261, ahead of any backend work. **`DES-SANDBOX-IS-A-FRESH-CONTAINER` and `CONST-ISOLATION-CONTAINER-PER-JOB` UNCHANGED, checked, and the check is the point of the change.** `buildDockerRunArgs` now composes two halves -- `containerSpec` (WHAT the box is: image, name, limits, network, structured `{host, container, readOnly}` mounts, env, and a `dockerExtra` field named for the raw Docker flags it carries) and `dockerArgsFromSpec` (HOW Docker spells it). The public function keeps its name, its signature and its argv BYTE FOR BYTE, verified against the pre-change implementation across nine input shapes and all three throws, which is why every existing caller and assertion is untouched. Kept as a name rather than replaced because `CONST-EGRESS-POLICY-IN-THE-ARGV` cites the symbol in its Code evidence. **Isolation became unfalsifiable rather than merely unconditional**: `containerSpec` sets `isolated: true` with no parameter able to unset it, and `dockerArgsFromSpec` REFUSES a spec that is not isolated, so the description of a container can no longer express one without the boundary and a hand-built spec that forgot the field fails loudly instead of quietly emitting no isolation flags. `ISOLATION_FLAGS` is untouched -- still a flat exported array, still spread unconditionally, still asserted member-by-member against the IMPORTED array by the two loops in `worker/test/sandbox.test.mjs`, which passed byte-untouched and were the acceptance test for the whole change. Rejected: expressing isolation as semantic spec fields (`dropCapabilities`, `pidsLimit`), which is more portable and would have retired `docker-run.test.mjs`'s `deepEqual` on the array's exact members and order -- the same move `interfaces.md`'s 2026-08-25 row already refused for issue #202. Rejected: a separate `container-spec.mjs`, which would have moved the container-side path constants, cost `docker-run.mjs` the dependency-free property `packages.mjs` states and relies on, and added an import edge before a second consumer exists; the split here is by function, and the move to its own module belongs to the PR that adds one. Also rejected: collapsing `-v host:container` into a single `--volume=` token, which reads tidier and would make this suite's adjacency-based mount extractors return nothing, turning several exact-array assertions vacuously green. **`INT-SANDBOX-CONTRACT` UNCHANGED, checked**: the sandbox argv is still built by the same builder through the same `extraFlags` seam, so the isolation flags still reach it by construction. **`INT-CONTAINER-RUNTIME-CONTRACT` UNCHANGED, checked**: identical flags, identical mounts, identical order. **Code evidence**: worker/src/docker-run.mjs -> containerSpec, dockerArgsFromSpec, buildDockerRunArgs. |
| 2026-08-31 | Issue #266, a test-harness defect with no product behaviour change. Every entry point that writes operator-facing output gains an INJECTED `write`, defaulting to `process.stdout.write` so production is byte-identical: `worker/src/start.mjs -> startWorker` (the boot `log` closure), `worker/src/cli.mjs -> main`, `receiver/src/cli.mjs -> main`, `receiver/src/start.mjs -> startReceiver`. `receiver/src/poller.mjs` already had the equivalent `out` seam and needed no change; its test simply was not using it. The reason is not style. `node --test` runs each file in a CHILD PROCESS that serialises its own results over `process.stdout`, so a test helper that replaces `process.stdout.write` and holds the replacement across an `await` destroys whatever result frames flush inside that window -- three tests in `worker/test/start-wiring.test.mjs` were reported as never existing at all, with `fail 0`, `skipped 0`, `cancelled 0` and exit code 0, and the repo-wide reported total was three short of the declared one. Measured, not inferred: the child protocol shows `ok` numbers with gaps at exactly the missing indices, so the tests RAN and only their bytes were lost; running the same file without `--test`, which has no child channel, reports all 40. The severity is narrower than it first looks and is recorded because it is easy to overstate -- a failure in a swallowed test still exits 1, as `not ok <file>` with no test name, so what was lost was the ability to read a red build rather than the coverage itself. CLAUDE.md's *"Inject a seam rather than reaching for a global"* already forbade the pattern; nothing enforced it. Two CI guards now do: a grep forbidding `process.stdout.write =` in any test directory, on `CONST-MERGE-NEVER-AUTOMATIC`'s "grep is the test" precedent and with no allowlist because there is no longer a legitimate use, and `.github/scripts/test-count-check.mjs`, which compares each file's `node --test` count against the in-process runner's. That comparison is deliberately not a `grep -c '^test('`: two files generate cases in `for` loops (24 and 37 real tests from 1 and 9 literal declarations), so a source-counting guard would need an allowlist, and it would only catch this one cause rather than any future loss of frames. **`CONST-ISOLATION-CONTAINER-PER-JOB`, `INT-CONTAINER-RUNTIME-CONTRACT`, `INT-RUN-HISTORY-FILE-CONTRACT` UNCHANGED, checked**: the seam changes WHERE log bytes go and never what they contain, so the no-PII-in-logs property and every record field are untouched. **Code evidence**: worker/src/start.mjs -> startWorker (`write`); .github/scripts/test-count-check.mjs; .github/workflows/pi-upgrade-check.yml -> the two guard steps. |
| 2026-08-31 | Issue #267, two defects in the cron money backstop, one of which had disabled it entirely. **`DES-CRON-VIA-BULLMQ-SCHEDULER` AMENDED.** First: `start.mjs` registered `(jobId) => void guard.onStalled(jobId)` while `makeStallGuard` returns the LISTENER, so every `stalled` event threw `TypeError: guard.onStalled is not a function` and no stall was ever counted -- since the day it was wired, 2026-07-17, the module written returning a bare function in one phase and called as a property in the next. `CONST-RETRY-INFRA-ONLY` exists because BullMQ's `moveStalledJobsToWait` exempts scheduler jobs from `maxStalledCount`, so a wedged scheduled run is re-processed and PAID on every stall indefinitely, and it says "BullMQ will never do this for us". This listener is the whole of our answer and it was not running. Nothing caught it because the only wiring test asserted `typeof registered.stalled === "function"`, which cannot fail -- the registered arrow is a function whatever its body does -- while the live-Valkey test called the factory's return value correctly and directly, proving the guard's logic and never touching the wiring. The test now INVOKES the listener; verified in the honest order, failing against the old wiring with the TypeError. Second: the counter was one HASH with a single `EXPIRE` on the whole key, so any scheduler's stall pushed every other scheduler's window forward and the guard degraded from "sustained stalling inside one window" to "cumulative stalling ever" on any deployment where anything stalled regularly -- measured over a simulated clock, three stalls ninety days apart tore a scheduler down with a neighbour stalling twice a day and did not without one. Each scheduler now counts under `pi-dispatch:sched-stalls:<schedulerId>` with its own `EXPIRE`. Per-field TTLs were not available: `HEXPIRE` does not exist on the pinned `valkey/valkey:8`, already verified and recorded under `DES-HOST-REGISTRY`. The expiry still ROLLS, and that is not `budget.mjs`'s set-once rule being broken: a budget window is a CALENDAR window that must not be pushed forward by traffic, while this is a STREAK detector where quiet for a day genuinely should forget -- `poll:<repo>:close-gate:<deliveryId>` is the in-repo precedent, a bounded consecutive-failure counter given its own key and TTL so it decays with the thing it measures rather than with a larger family. The prefix is unchanged so `KEYS pi-dispatch:sched-stalls*` still shows an operator the whole feature, and the id is validated rather than hashed because it is operator-declared and `triggers.mjs` already refuses a `:` in it to protect this parse. The panel reads the counters with ONE `MGET` over the cron ids it derives from the triggers file it already reads that tick -- config-driven recompute through the shared key builder, which is the doctrine `fleet-lease.mjs` states as "no KEYS, no SCAN, and no index set to leak", and a keyspace scan was measured and refused for `wait:held` and `host:h:*` because the panel reads every second. **`CONST-RETRY-INFRA-ONLY` and `REQ-CRON-SCHEDULED-JOBS` UNCHANGED, checked**: neither needed amending -- the code simply did not do what they already require. **Code evidence**: worker/src/scheduler-stall-guard.mjs -> stallKey, makeStallGuard; worker/src/start.mjs -> the `stalled` registration; admin/src/dashboard.ts -> the cron-id MGET. |
| 2026-09-01 | Issue #227, slice 1 of the container-backend registry: the contract and `local` as its first implementation. **NEW `DES-CONTAINER-BACKEND-REGISTRY`** (`DES-HOST-REGISTRY` is taken and means FLEET HOSTS, a different axis: which machine drains a queue, not which runtime builds the box). A backend is declared in `worker/src/backends.mjs`, a LEAF importing nothing, so `doctor`, the config loader and the receiver can read a declaration without pulling the Docker implementation into their graph. **That leaf property is why the table holds no `make()`**, which is the shape the issue proposed: a factory per entry is an import edge from the leaf to every adapter. The table declares, `worker/src/backend-local.mjs` implements, and the two are joined by NAME -- `forges.mjs`'s split. **The 2026-08-31 row for issue #261 is DISCHARGED, not overridden**: it rejected a separate `container-spec.mjs` "before a second consumer exists" and said "the move to its own module belongs to the PR that adds one". This is that PR, and the second consumer is a backend that consumes a spec and never produces a Docker argv. Its second objection is answered rather than ignored -- the move would "cost `docker-run.mjs` the dependency-free property `packages.mjs` states and relies on", and it does, so `packages.mjs` now imports `CONTAINER_GLOBAL_PI_DIR` from the spec module, which is itself a leaf and is pinned as one by a test. That row's **Code evidence is CORRECTED**: `containerSpec` now lives in `worker/src/container-spec.mjs` and is re-exported through `docker-run.mjs`, so every existing call site and assertion is untouched; `dockerArgsFromSpec` and `buildDockerRunArgs` did not move. **A DECLARATION IS A CAPABILITY, NOT A POSTURE, and the first draft of this slice got that wrong in a way worth recording.** It declared `egress: enforced` flat, which re-proposes in one word the entry `CONST-EGRESS-POLICY-IN-THE-ARGV`'s own 2026-08-25 row names and rejects: `CONST-EGRESS-DENIED-BY-DEFAULT`, refused because "an operator can set `PI_EGRESS=0`" and a "shall" over something an operator disables is the constraint-that-ships-unenforced `OQ-004` refused for. With `PI_EGRESS=0` the `--network` flag is absent and the job sits on docker's default bridge, where `egress.mjs` records two jobs can already reach each other by IP. So a property a deployment switch gates now carries `armedBy` naming that switch, and the capability word is never printed where it could be read as the posture. Capability is the right axis because it is the one a floor compares against: the refusal to be produced is "this deployment ARMED egress and its backend cannot do egress at all". **The property list is CLOSED, and was completed rather than inherited**: the closed-list rule ("a backend that omits one is not admitted for it") is only sound if the list is complete, so `ephemeral`, `mountSet`, `jobToJobIsolation`, `abortable` and `credentialTransit` were added after an adversarial pass found that without them a backend could declare every other word `enforced`, be fully conformant, and still reuse one container across mutually untrusting issue authors, bind-mount the docker socket, put every job on one segment, have no way to stop a runaway job, or ship the per-job token to a daemon this deployment does not own. `exitCodes` was **narrowed**: it claimed "un-interleaved stdout arrives undistorted", which this project does not have (two pipes tee'd into one sink, an 8KB tail cap, and `OQ-003`'s partial-write hazard), so it now claims only the integer, which is what every retry decision rests on. `secretsCustody` was **restated** as what a test can read back -- no value in a log, a record or a forge comment, and none crossing a network -- rather than as a topological fact about `remote: false`. `nonRoot` is `asserted`, not `enforced`: `USER pi` is the image's, and SECURITY.md says "Non-root is not in that argv". **`dockerArgsFromSpec` now refuses a `dockerExtra` flag that would supersede the boundary**, because that array lands AFTER `ISOLATION_FLAGS` and docker resolves a repeat last-wins, so `--privileged` would leave every member present in the argv and no boundary in effect -- membership is what the two standing assertions test, and membership is not effectiveness. `--user` is deliberately NOT refused: it is the documented Linux-only `uid:gid` for a bind-mounted local folder, it changes which uid runs rather than what that uid may do, and the property it bears on is already `asserted`. Rejected: verifying a declaration against behaviour in this slice, which needs a conformance suite that drives a backend's own `runContainer` and reads each property back -- until it exists these words are a contract and not a finding, and the module says so. Also rejected: spreading the bundle into the processor's `deps`, which would put a backend's `name` into a namespace the processor is free to mean something else by. **`CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-EGRESS-POLICY-IN-THE-ARGV`, `INT-CONTAINER-RUNTIME-CONTRACT`, `INT-CONTAINER-JOB-INPUTS`, `INT-SANDBOX-CONTRACT`, `DES-WORKER-ON-HOST` UNCHANGED, checked**: no flag, mount, path or guarantee moved, and the argv was verified byte-identical to `main` across every conditional mount, the network flag, `dockerExtra`, the env skip rules and all three refusal messages. `ISOLATION_FLAGS` is untouched and the standing assertions against the imported array passed with no edit, which is the check that the split stayed a move. **Code evidence**: worker/src/backends.mjs -> BACKENDS, PROPERTIES, shortfall, meets, isDeclaration · worker/src/backend-local.mjs -> makeLocalBackend, jobContainerName · worker/src/container-spec.mjs -> containerSpec · worker/src/docker-run.mjs -> dockerArgsFromSpec, DOCKER_EXTRA_FORBIDDEN. |
| 2026-09-01 | Issue #227, slice 2: the declaration read back, and the refusal ladder. **`DES-CONTAINER-BACKEND-REGISTRY` AMENDED** with its configuration surface -- `PI_BACKENDS` (which backends this deployment blesses) and `PI_BACKEND_FLOOR` (the minimum every one of them must declare, as `property=word` pairs). Both **ENV-ONLY**, on `secretResolverRoots`' rule that "a bound that can be widened from the surface it bounds is not a bound", and the deployment pointer needs no edit: `POINTER_ENV_ALLOWLIST` is an ALLOWLIST (of the path and URL variables `resolvePaths` reads), so a name absent from it is refused by omission. Both parse in the LEAF (`backends.mjs`), which is `egressArmed`'s arrangement and its reason -- `doctor` reads the environment directly, so a second copy of the grammar would be a second answer about what an operator's floor says, and `config.mjs` only re-tags the thrown Error. **Every malformed part refuses instead of being skipped**: an unknown backend name, a pair with no `=`, an unknown property NAME, an unknown word, a property named twice. That strictness is the feature, not politeness about typos -- `shortfall` returning `[]` is indistinguishable from a satisfied floor, so a floor the parser cannot read must never become one it reads as asking for nothing, which is exactly the third value `PI_EGRESS` refuses. Named twice throws rather than last-wins, because both halves are something an operator wrote down deliberately. **The boot refusal has three ladders.** A floor is NOT met by capability alone -- `local` declares `egress: enforced` whether or not `PI_EGRESS` is armed, so `egress=enforced` under `PI_EGRESS=0` passed and booted while doctor said the floor held; `unarmedFloor` refuses anything above `absent` on a gated property whose switch is off. The floor is checked against EVERY blessed backend rather than the default alone, because any blessed backend is somewhere this deployment's jobs may run and checking only the default would let a trigger reach a backend the floor was meant to exclude. The second is implied: a deployment that ARMED egress has asked for egress whatever its floor says, so a backend declaring `egress: absent` is refused with `PI_EGRESS` armed -- it cannot fire while `local` is the only entry, and it is written now because the slice that adds a second backend is the slice where forgetting it costs something. **`doctor` is what makes the whole table admissible**, and this is the slice that discharges `CONST-EGRESS-POLICY-IN-THE-ARGV`'s central objection rather than restating it: a table of guarantees nothing ever prints IS the believed-in control that entry says is worse than a known-absent one. So `enforced` prints quietly, `asserted` prints as a WARNING NAMING ITS ASSERTER (the `asserts` map on the backend entry), `absent` prints as a failure and OUTRANKS the gate, and a gated property whose switch is off prints that switch and its position -- "local CAN enforce egress" and "this deployment is not getting it" are two different sentences and collapsing them is the defect the vocabulary was rewritten for. A backend configuration the worker would refuse to boot on is a doctor FAILURE, never a warning, or doctor would report green on a deployment that cannot start. **`INT-CONFIG-OVERLAY-CONTRACT` UNCHANGED, checked, and the check is the point**: neither variable is overlay-readable and neither is pointer-carryable, so the panel cannot widen the bound it is bounded by. **`INT-EGRESS-POLICY-CONTRACT` UNCHANGED, checked**: `PI_EGRESS` keeps its exact two values and its meaning; the new ladder READS it and adds nothing to it. **`CONST-EGRESS-POLICY-IN-THE-ARGV`, `CONST-ISOLATION-CONTAINER-PER-JOB`, `CONST-BUDGET-BEFORE-TOKENS` UNCHANGED, checked**: no container flag, mount or gate order moved, and the refusal is at boot rather than on a spend path. The warning shape is `ok: false, warn: true`: `render` tests `c.ok` first, so the `ok: true, warn: true` a draft used printed the pass glyph and swallowed the `fix` line, and a test asserting `c.warn === true` on the OBJECT passed while every asserted property rendered green. The tests now drive `runDoctor` and read its output. `PI_BACKENDS` and `PI_BACKEND_FLOOR` are documented in both mirrored `.env.example` files, which stay byte-identical, in their own section rather than inside the egress block. **Code evidence**: worker/src/backends.mjs -> parseBackendList, parseBackendFloor, floorShortfall · worker/src/config.mjs -> refuseBackendShortfall · worker/src/doctor.mjs -> backendChecks. |
