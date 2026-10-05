# Cost analytics

Every run records what it spent (`docs`: run history; `specs`: `REQ-TOKEN-ACCOUNTING-AND-CAPS`). The
cost analytics make that history analyzable: what a flow costs, what a month costs per model, what a
subscription is actually saving, and what a flow *would* cost on a different model. It informs; it
changes nothing — no auto-switching, no vendor API calls, no database (`REQ-COST-ANALYTICS`,
`DES-COST-FOLD-BY-SCAN`).

The surface is the **insights page** ([`insights.md`](insights.md)): `/dispatch insights` writes and
opens one self-contained file with the plan verdicts, the daily and cumulative spend charts, the
per-flow trend panels, and the five breakdowns (by flow, by trigger, by model, by repo, by project) beside the
trigger/flow topology those numbers come from. This document explains the semantics behind every
dollar that page draws.

The **by-trigger** breakdown answers "which trigger burns the most" and "what did its failures
cost": each row is a `triggers.json` entry (attributed by the persisted index-and-type join the
topology uses). Runs no trigger claims stay visible as their own rows, never blended in:
`(chained runs)` for children spawned by another run, `(manual/local)` for CLI dispatches,
`(unattributed)` for forge runs whose recorded trigger no longer matches the current file. A
`run.command` trigger is a `triggers.json` entry like any other: its row reads `/name` and its jobs'
spend folds the same way — dispatching a workflow extension is not cheaper by classification. The
**by-repo** breakdown groups spend by the target repository (issue and MR numbers stripped), with
`local:<folder>` targets as their own rows. A forge row is named with its forge, `github:acme/web`, so one repo
served by two forges is two rows. The `repo` filter of `dispatch_costs` takes either form: `acme/web` selects
that repo on every forge, `github:acme/web` one forge.

The **by-project** breakdown groups spend by the `project` id each run record carries
([projects](projects.md)). The worker writes that id when it picks the job up, so the fold never looks at
`projects.json` as it is today:

- A run outside every project is `(no project)`.
- A run recorded before projects existed is `(no project)` too, even if its repo is a member now. Records are
  never moved into a project after the fact.
- The page's bars carry the id. A project's display name sits under the list, escaped and isolated.
- The `project` filter of `dispatch_costs` takes an id (`shop`) and scopes every part of the fold to the runs
  recorded under it.

## How to read the numbers

Every dollar carries its class, rendered by one shared formatter — these markers are contractual
(`REQ-COST-ANALYTICS`), not decoration:

| rendering        | meaning |
|---|---|
| `$4.12`          | metered — the stream-time price pi-ai computed when the run happened |
| `≥$4.12`         | a floor: some spend was unpriced/unresolved, a `pi` child process could not be metered, a call was priced past a long-context threshold (`longContext`), legacy calls may have run unjudged (`costUnjudged`), a failed call may have been billed (`costUnanswered`), a call's answer reported no usage (`costUnreported`), the run fell back to the in-session meter (which cannot see subagent spend), or the run pre-dates the meter |
| `plan:kimi`      | covered by a declared subscription — prepaid, **never shown as $0.00** |
| `$0 (unrated)`   | a model the rate table prices at $0, with **no** declared subscription covering it: unrated, never "free" |
| `~$4.12 est.`    | an estimate (what-if, API-equivalent, or a sum containing any estimate) |
| `~~$4 seeded`    | seeded from no history — a band, never a point |
| `—`              | there is no number behind this cell: a null typed value, such as a flow with no plan-covered rows (no api-equivalent) or a plan with no attributed runs (no amortized figure) |

A run whose container died before reporting tokens contributes no row of its own: it makes its bucket a
floor and demotes it to `est.` with coverage, so nothing renders as an unclassified dollar.

Most runs refused before they could spend are an exact `$0` and never a floor. The record says so: no
tokens, no container exit, and `budgetReserved: false`. Such a run still counts as a run, but not as an
unmetered one, and it does not change a bucket's class or coverage. A record that lacks any of the three keeps
the floor, because a run that did start can lack the other two. So some refusals stay a floor: `over-budget`
and the soft hold keep the budget slot they took, so does any refusal whose job-count give-back failed, and a
container the runtime failed to start (often exit 125) carries that exit code.

A bucket (a trigger, flow, repo or day) whose every run one declared plan covers reads `plan:<id>`, and
`dispatch_costs` returns its typed value as class `"plan"` with that `planId`. A bucket that mixes plan
and billed runs, that two plans cover (an id may hold any character, so no separator could name both),
or that holds a floor reads as the estimate it is, `~$4.12 est.` or `~≥$0 est.`, with its coverage.

Metered numbers are pi-ai's computed prices, not invoices. The series is bounded by run-history
retention (`PI_LOG_RETENTION_DAYS`, default 30 days; the scan hard-caps at 92 days even when retention
is the keep-forever `0`), and the screen says which window it shows. Plan proration denominates on the
window you asked about, not on when the runs happened to land: a quiet fortnight does not shrink a
plan's share of the month, and verdicts do not read SAVING just because the deployment is young.

## Declaring subscriptions

The rate tables pi ships never state a subscription plan's price. Some subscription providers ship
all-zero tables (the `qwen-token-plan` and `xiaomi-token-plan` families), so their runs record `cost: 0`:
prepaid, not free, and undeclared they read `$0 (unrated)`. Others (`kimi-coding`, `zai` and `zai-coding-cn`
at the pinned pi; all three were all-zero before pi 0.99.1) carry an API-equivalent rate, so their runs
record a cost you did not pay per token, and undeclared they read as that metered dollar figure. A
declared plan reads `plan:<id>` either way, for runs recorded before the change and after it. The real
price can only come from you: declare each plan in
`subscriptions.json` (scaffolded by `pi-dispatch init` into the working directory; see
`subscriptions.example.json`). Three routes point the admin at that file: the working-directory default,
an explicit `PI_SUBSCRIPTIONS_FILE`, and the deployment pointer at
`~/.pi/agent/pi-dispatch-deployment.json`, whose env allowlist includes `PI_SUBSCRIPTIONS_FILE` so a
deployment built in some other folder is found from any cwd. `/dispatch setup` takes the third route for
you: it scaffolds the file and writes that pointer entry (a variable you exported yourself always wins
over the pointer). The file feeds arithmetic only — it never touches execution, routing, or auth
(`DES-SUBSCRIPTIONS-ARE-COUNTERFACTUAL-ONLY`).

- `counterfactualModel` names a *priced* pi-ai model used for the "this month at API rates" comparison —
  the verdict line. Without it the verdict honestly degrades to "no API-rate baseline declared".
- Quota `windows` take `unit`/`limit` **as far as the vendor states them** — `null` is first-class
  "undisclosed", and the screen then shows peak-usage facts instead of inventing a burn-down.
- `hypothetical: true` marks a plan you are *considering*: its verdict reads WOULD SAVE / WOULD LOSE,
  computed against what those runs actually cost you today.
- Editing the file re-classifies history retroactively — classification happens when the screen folds,
  not when the run was recorded.

## The what-if

"This flow, same token profile, on a different model." Estimates re-price the flow's *recorded*
per-model token ledgers (cache split included) through pi-ai's own `calculateCost` (tiers come along for
free), and are always marked `est.`, name the rates version, and report coverage (runs without a ledger
are excluded, never back-derived).

The 1h cache-write split is the one judgment the façade makes, and it changes how a cross-provider
what-if should be read. The 2x-base-input premium is an Anthropic billing rule and only Anthropic ever
reports the field, so `cacheWrite1h` is forwarded only when the *target* provider is `anthropic` (and is
clamped to `cacheWrite`, so a malformed profile cannot drive the price negative). Re-price an
Anthropic-recorded flow onto any other provider and every write is priced at the short rate: the estimate
is a floor on that side of the comparison, not a like-for-like. Cross-provider comparisons carry a
second caveat too: same token profile, different tokenizers — directional only. A flow with no ledgered
history gets one offer: the `$0.5–$5/job` band recorded at `OQ-002`, scaled by the flow's run count and
labeled `unmeasured (OQ-002)`.

## The surfaces

- `/dispatch insights [7d|30d|mtd]` — the page: the fold drawn as charts beside the trigger/flow
  topology, in one self-contained file your browser opens from disk ([`insights.md`](insights.md)).
  Over SSH the file still writes and its URL still prints.
- `/dispatch insights whatif <provider>/<model> --flow <flow>` — the what-if: re-prices a flow's
  recorded token profiles under another model. Unknown models get closest-match suggestions, and
  tab completion offers the full priced catalog. `--flow` is **required**: the estimate scores one
  flow's median run, not a portfolio, so the command refuses without it.
- The `dispatch_costs` tool returns the fold as JSON in which **every monetary value carries its
  `class`** — a model reading it can no more launder an estimate into a fact than the page can.
  Beside the fold, `dollars` holds the dollar caps' enforcement amounts (below): integer micro-dollars from the
  window counters and the run records, which are facts rather than classified estimates, so they carry
  no `class`. The key is present when a dollar window is set, a dollar setting cannot be read, or a run
  in the window carries `dollars`; its amounts are integer micro-dollars.

## Environment

| variable | default | effect |
|---|---|---|
| `PI_LOGS_DIR` | `~/.pi-dispatch/logs` | the run history this whole fold scans. The default is per user, and this fold runs in the PANEL's account: if your worker runs as a different one, set this explicitly on both sides or the numbers here are silently zero rather than wrong |
| `PI_SUBSCRIPTIONS_FILE` | `./subscriptions.json` | where the admin reads plan declarations (relative to its own working directory; the deployment pointer can set an absolute path instead) |
| `PI_DISPATCH_ASCII` | unset | `1` = ASCII glyphs (frames, meters, sparkline ramp) for glyph-hostile terminals |
| `PI_LOG_RETENTION_DAYS` | `30` | bounds the analyzable history (`0` = keep forever; scan still caps at 92 days) |

## Dollar caps

The rest of this page reports spend after the fact. The dollar caps act on it before the fact (issue #501). This
section follows one dollar from the setting to the run record.

### The settings

| setting | env | what it caps |
|---|---|---|
| `maxCostUsd` | `PI_MAX_COST_USD` | what one job may spend |
| `dailyCostUsd` | `PI_DAILY_COST_USD` | what all jobs may spend per UTC day |
| `weeklyCostUsd` | `PI_WEEKLY_COST_USD` | per week, Monday to Sunday, UTC |
| `monthlyCostUsd` | `PI_MONTHLY_COST_USD` | per calendar month, UTC |

Write each as a plain decimal string (`"2.50"`): above 0, at most 1000000, at most 6 decimals, no exponent. A JSON
number in the overlay is also accepted, read by its value (`1e2` is $100). Set them in `.env`, in the settings
overlay (`/dispatch set`), or with `dispatch_set`, which shows the effective value and its source, checks the
value, and asks you to confirm. A dollar window needs a per-job cap, because the window reserves that cap for
every job:

- a window in the overlay with no `maxCostUsd` anywhere: every job is refused `settings-overlay-invalid`;
- a window in the env with no `PI_MAX_COST_USD`: the worker refuses to start;
- a scoped-limits dollar row with no per-job cap: each job it applies to is refused `config-refused`, unless its
  trigger sets `run.maxCostUsd`.

`dispatch_set` warns before the first two; `pi-dispatch doctor` names all three.

A trigger may narrow the per-job cap with `run.maxCostUsd`, and limit its models with `run.models`
([triggers](triggers.md#a-dollar-cap-per-job)). No tool sets either: they are written by hand in the triggers
file. The trigger tools refuse a call that carries them, and an edit keeps the values the entry has.

`scoped-limits.json` version 2 adds the same windows per repo or folder (`dayUsd`, `weekUsd`, `monthUsd`) and per
model (`model:<provider>/<model>` rows) ([scoped limits](scoped-limits.md#dollar-windows-and-model-rows-version-2)).
`dispatch_limit_add` and `dispatch_limit_edit` take those fields behind their confirm, check them with the same
parser the worker uses before they ask, and write version 1 until a row needs version 2.

### One run, end to end

1. **Reserve.** Before the container starts, the worker adds the job's per-job cap to every active window: the
   deployment's, the job's repo or folder row, and each model row it may use. If any window would pass its cap,
   the job is refused `dollar-cap`, everything it added is given back, and no container starts. Under an
   allocation envelope the window may be the project's share of the split or the envelope total, and then the
   refusal is `allocation-cap` ([allocation](allocation.md)). A job whose every
   allowed model is a declared local endpoint priced at zero reserves nothing (`basis: unreserved`).
2. **Run.** The runner checks the per-job cap before every model call, against the most that call could cost.
   The call is refused (`cost-cap`) when it could pass the cap. So the reservation bounds what the runner
   meters, except for the gaps listed under "What the caps do not cover".
3. **Settle.** After the run, each window is charged what the job really cost, and the rest of the hold is given
   back. A model window is charged that model's own share, from the run's per-model usage.
4. **Record.** The run record says how it settled, under `dollars`
   ([run record](../specs/interfaces.md#int-run-history-file-contract)).

### How a run settles

`dollars.basis` is one of four words:

- `metered`: the cost was fully known, so the windows were charged exactly that, rounded up to the micro-dollar.
  All of these must hold:
  - a **trusted exit line**: the container ended on its own (no timeout, cancel, shutdown or detach) and the
    exit line's own `code` matches the container's real exit code. On an image that declares `exitAuth` the line
    must also carry the run's signature: a run with no verified line settles at the floor;
  - the runner's own meter counted the run (`tokens.metered` is `true`, not the fallback meter);
  - `tokens.costCapMicros` is present and not above the reservation;
  - every "not fully counted" counter is present and 0: `unresolved`, `unpriced`, `boundExceeded`,
    `longContext`, `costUnjudged`, `costUnanswered`, `costUnreported` and `unmeteredChildren`;
  - a per-model usage ledger is present, unless the run made no model call at all.
- `floor`: the cost was not fully known. The windows keep at least the whole hold, and more when the measured
  part already costs more.
- `refunded`: no container ran (it never started, or the job was refused), so the hold was given back.
- `unreserved`: the job could not spend, so nothing was held.

Some cases worth knowing:

- **A run that called no model** (for example one whose first call the cap refused) settles metered at $0. A
  command job is not one by itself: the extension command it runs may call models like any other job.
- **A 401 or 403 before any answer settles at the floor.** This is by design. The failed call counts as
  `costUnanswered`, because a request that got no answer may still have been billed. The worker cannot tell that
  apart from a label written inside the container, and such a label must never release money. A bad key therefore
  costs one per-job cap in each window.
- **A refusal whose dollar give-back failed** records `dollars.basis` `floor` with the whole hold. The window
  counter really holds that amount until it expires. The cost views still show the run as `$0`, because nothing
  ran.
- **A run the worker stopped** (timeout, cancel, shutdown) settles at the floor: its exit line is not believed.
- **A call whose answer reported no usage settles at the floor.** See [A call that reports no usage](#a-call-that-reports-no-usage).
- **A retried job** keeps only its last attempt's record. The window counters are the truth for every attempt.

`dollars.modelBasis` says how the model windows settled. It is `floor` when the per-model split is not known: the
usage ledger was folded, some spend was on no named model, there was no ledger, or the job's own basis was not
metered.

### Long context

Anthropic bills input above 200,000 tokens at a higher rate, and pi's rate tables have no such tier. So the
runner's bound adds a generic tier when a model's table has none, keyed on the API, not on the model: every model
served over `anthropic-messages` or `bedrock-converse-stream` gets it. Above 200,000 input tokens that is twice the
input and cache rates and 1.5 times the output rate. The runner counts such calls in `longContext` and charges
them at that tier during the run. pi meters them at base rates, so the metered cost is too low; a run with
`longContext` above 0 therefore settles at the floor. Because the tier follows the API, a gateway model or a
non-Anthropic Bedrock model on one of those APIs can floor this way too
([DES](../specs/design.md#des-dollar-reserve-and-settle)).

### A call that reports no usage

Some answers carry no usage numbers, or only part of them. pi then records the call as zero tokens and $0, or
with the part it saw, so the meter cannot tell it from a free call. The runner's meter counts such a call in
`costUnreported`, on every run, with or without a dollar cap, and in every `pi` child process. A run with
`costUnreported` above 0 settles at the floor, and the cost views show it as `≥`. Under a dollar cap the runner
also charges such a call its bound during the run.

The meter counts a call on a model that costs money when its answer has:

- no input at all, unless the call failed before anything came back;
- a failure after the answer had started (a stream cut after content arrived). Its usage is partial, even when
  the provider reported the input first, as Anthropic does;
- content but an output count of 0. On the Anthropic API an output count of 1 counts too: pi keeps the first
  event's count when a proxy drops the final one.

So a genuine one-token answer on the Anthropic API floors its run too, and so does a chat call there capped at
one output token (`maxTokens: 1`). Under a dollar cap such a call is also charged its bound during the run, so a
capped job of genuine one-token answers reaches its cap far sooner than its real cost would. That is the safe side:
the meter cannot tell such an answer from one whose count was dropped. A classify call has no answer content, so
this rule never applies to it.

A call that failed before anything came back is counted in `costUnanswered` instead, never in both. A model whose
rates are all zero is never counted: a free call costs nothing whatever it reports. A router or proxy provider
that passes a call on to another model is not counted for its own call: the call it passed on is metered.

**Local servers.** Many OpenAI-compatible servers send usage only when asked, and pi asks unless the model sets
`compat.supportsUsageInStreaming: false`. A model with that setting and a nonzero `cost` table reports no usage on
every call, so every job on it settles at the floor. `pi-dispatch doctor` warns about such a model in the overlay
`models.json`, including a builtin model whose provider `compat` or `modelOverrides` entry sets it. Remove the
setting if the server sends usage when asked, or set the model's `cost` to zeros if it is free to you.

**Upgrade order.** A worker that knows `costUnreported` reads it as missing on an exit line from an older image,
and settles every capped job at the floor. That overcharges and never undercharges. Upgrade the image before the
worker. An older worker with a new image drops the key, so ship them together.

### Prepaid plans

Prepaid coding plans that pi prices (`kimi-coding`, `zai`, `zai-coding-cn`) meter their API-equivalent price,
though the plan does not charge per token. A dollar cap or window on these providers caps that implied price,
not your bill. Declaring the plan in `subscriptions.json` changes how this page shows those runs; it does not
change what the windows are charged.

### Where to look

- **The panel** (`/dispatch`) shows a DOLLAR WINDOWS section when any window is set: one row per window, the
  deployment's first, then each scoped-limits row. Each row shows `spent+held / cap`, read from the window's
  counter in Valkey. That counter is what the next job is admitted against, and it includes the holds of jobs
  still running. The row turns amber and says `full` when a job at the deployment's per-job cap would no longer
  fit. Beside it, from the run records: what settled and how many runs settled each way (`13 metered, 1 floor`).
  A `boundExceeded` count shows, amber, only when it is above zero. The SCOPED LIMITS section shows each row's
  dollar windows the same way (`week $6.340917/$45.00`), and so does the insights page's budget panel. A folder
  or model row says `records n/a`: a record names a folder by its basename only, and does not say which model
  windows its job reserved in. A `project:<id>` row folds the records whose `project` is that id,
  local runs included. The records side counts only the records this host can read
  (`PI_LOGS_DIR`), so on a fleet without shared logs it is this host's share. The panel reads the deployment's
  caps from the settings overlay and the deployment's `.env`, so a cap set only in the worker's service unit
  shows no deployment row.
- **`dispatch_costs`** returns the same windows under `dollars.windows`, and each run's `dollars` under
  `dollars.runs`. Amounts are integer micro-dollars (1 USD is 1000000). `dollars.windows` lists the operator's
  caps only. With no dollar cap set it is empty, even while a budget split governs the jobs.
- **`dispatch_limits`** gives each scoped-limits row its caps in words and, for a dollar row, each window's cap
  and counter.

A non-zero `boundExceeded` anywhere means a call cost more than the bound said it could. The bound assumes one
token is at least one byte for every tokenizer pi prices; that count is the evidence that would reopen it.

### What the caps do not cover

These are known gaps. Most are named in the specs ([DES](../specs/design.md#des-dollar-reserve-and-settle)); #544
is an open issue.

- **A `pi` child process that hides from the meter** is not counted. A child that keeps the job's environment is
  metered and capped ([pi child processes](#pi-child-processes)). The gaps are listed there: for example a child
  that runs pi as a library with `NODE_OPTIONS` cleared, a client that is not pi, and a direct API call.
- **A new worker with an old image settles every capped job at the floor.** The worker reads `unmeteredChildren`
  and `costUnreported`, and an image built before issue #500 (or #571) does not write them. Upgrade the image before
  the worker ([upgrade order](#a-call-that-reports-no-usage)).
- **Usage that pi fills with plausible numbers** is not detected. The meter counts answers with no input, a cut
  stream, or content with no output count. A partial count above those marks reads as the whole cost. A call that
  passed another call on is trusted for its own usage, even when an extension's hook made that other call.
- **A Node older than 18.19 in a job does not start.** To meter `pi` child processes, the runner adds
  `--import=<child preload>` to `NODE_OPTIONS` for every process in the job (issue #500), and such a Node refuses that
  flag. The image ships Node 22. An agent that installs an older Node in a job must clear `NODE_OPTIONS` for it.
- **A forged exit line**, on an image that does not declare `exitAuth`, or a worker and image pair older than
  #545. The job's own tools can write a fake exit line, and a forgery after the real line, with the right code,
  is still read as the last one. The per-job cap bounds what such a run can have spent. With `exitAuth` on both
  sides only a line signed with the run's key is read ([job image](job-image.md)).
- **Loose files in the overlay's `extensions/` folder never load** (issue #544). An extension you expected to
  register a provider, or to guard spend, is not running, and nothing says so. Only `extensions/index.js` loads
  today.
- **Images are over-bounded.** The bound counts each image at its provider's per-image ceiling, so a run with many
  images can be refused by a cap it would have fit. An image an extension adds without pi's resize can exceed
  the ceiling.
- **A crash holds the reservation until the key expires.** A worker that dies between reserve and settle leaves
  the hold in every window it touched: 2 days for a day key, 9 for a week, 40 for a month.
- **Contention near a cap.** Each job holds its whole per-job cap while it runs. A window with $1 left refuses a
  $2-capped job that would have spent $0.30. The refusal is final for that delivery.
- **Hosts may disagree on caps.** The counters are shared, but each host judges them against its own cap values.
  Each host publishes a fingerprint of its dollar caps (`fpUsd`), and `pi-dispatch doctor` names a host whose
  fingerprint differs from this one's, or that publishes none while dollar caps are in use. Nothing refuses a job
  over it, so keep the dollar settings the same on every host.
- **Uncatalogued fees** (server-side tools, Bedrock regional pricing) are outside both the bound and pi's cost.
- **A failed stream** that had started counts at its bound against the per-job cap during the run, and counts in
  `costUnreported`, so the windows settle at the floor. A stream that failed before it started
  settles at the floor through `costUnanswered`.
- **A provider's server-side fallback** is billed on the requested model's row.
- **The bound trusts the api id** an overlay or extension model declares. A model that names a priced api but is
  billed differently is bounded by the table it declares.
- **Extension code can go around the meter**: pi-ai's per-api stream functions imported directly, the legacy
  `generateImages`, or a raw `fetch`. The meter bounds the agent's ordinary calls, not the code it runs beside.
- **A payload hook can raise a call's cost** after the guard judged it (an `onPayload` or `before_provider_request`
  rewrite of the output cap). `boundExceeded` is the evidence.
- **The compat re-arm window**: a legacy call made while the meter's compat half was displaced is not judged. Under
  a cap the job stops, and the run counts it in `costUnjudged`, which settles at the floor.
- **Calls that cannot be bounded are refused under a cap**: an api outside the priced set, `generateImages`,
  `streamDeferred`, a priced classifier, a virtual model outside `streamSimple`.
- **Old images are refused.** A job with a dollar cap on an image that does not declare `costCap` is refused before
  it spends (`job-image-cost-cap-unsupported`, [job image](job-image.md)).
- **A version 1 worker refuses a version 2 limits file**, so rolling a worker back past version 2 with dollar rows
  in place stops it at boot ([scoped limits](scoped-limits.md#dollar-windows-and-model-rows-version-2)).
- **Model refs over 64 characters cannot be named**, in `run.models`, `run.model` or a `model:` row
  ([triggers](triggers.md#choosing-the-model-and-the-turn-limit)).
- **A model only an extension defines** must also be declared in the overlay `models.json`, or the worker refuses
  it as `model-unknown` ([triggers](triggers.md#choosing-the-model-and-the-turn-limit)).
- **A floor charges every model row the job held**, whether it called that model or not: with N model rows, one
  such run charges N caps across them.
- **Clock skew at a window boundary**: each host builds its window keys from its own clock, so around midnight UTC
  two hosts can reserve into different days for one instant.
- **A counter deleted by hand** while a job holds it can let that job's settlement erase part of another job's
  hold (clamped at 0).
- **The runner's own `spent` is not on the exit line.** A floor charges at least the reservation and the metered
  cost; the cost guard's in-run charge, which can be higher, is not read.
- **A provider that forwards to another model is counted twice.** A passthrough proxy's own call and the call
  it forwards are both bounded and both counted, so its usage counts twice. That errs on the safe side for money,
  but such a proxy can reach a cost or token cap early.
- **A broken overlay `models.json` refuses every job.** If pi would drop the file, the worker refuses every job
  until it is fixed, rather than send a provider's models to its public endpoint. The same holds when the worker
  cannot read the file (no permission on it or its folder), and when `models.json` is a link: copy the file in
  instead. A read that fails for a moment retries the
  job once, then fails it ([global overlay](global-pi-overlay.md#custom-providers)).

`pi-dispatch doctor` checks a few things about these caps before a job finds them:

- **A cap too small for one call.** The runner refuses a call when the most it could cost would pass the cap.
  That bound includes the model's whole output limit, so a small cap can refuse a model's first call every time.
  Doctor warns when the per-job cap (the deployment's, or a trigger's smaller one) is below one full-output call of
  the job's main model or of a model on its list, and names the amount. The amount is a lower bound: the model's
  output limit at its output rate, plus a minimal first request, times the service-tier multiplier the runner
  applies on the OpenAI responses apis. On the default model it is $1.00608, so a $1 cap
  runs nothing. Raise the cap above the amount named, with room for the request itself.
- **Hosts with different caps.** On a fleet, doctor names a host whose dollar caps differ from this one's
  (the bullet above, and [multi-host](multi-host.md)).

Specs: [`REQ-SPEND-CAPS-MULTI-WINDOW`](../specs/requirements.md#req-spend-caps-multi-window),
[`REQ-TOKEN-ACCOUNTING-AND-CAPS`](../specs/requirements.md#req-token-accounting-and-caps),
[`REQ-MODEL-POLICY`](../specs/requirements.md#req-model-policy),
[`REQ-ADMIN-VIA-PI-EXTENSION`](../specs/requirements.md#req-admin-via-pi-extension),
[`DES-DOLLAR-RESERVE-AND-SETTLE`](../specs/design.md#des-dollar-reserve-and-settle),
[`INT-RUN-HISTORY-FILE-CONTRACT`](../specs/interfaces.md#int-run-history-file-contract),
[`INT-SCOPED-LIMITS-FILE-CONTRACT`](../specs/interfaces.md#int-scoped-limits-file-contract),
[`INT-CONFIG-OVERLAY-CONTRACT`](../specs/interfaces.md#int-config-overlay-contract),
[`OQ-010`](../specs/open-questions.md#oq-010--does-pinned-pi-0807-emit-per-turn-token-usage-on-the-subscribe-stream),
[`OQ-011`](../specs/open-questions.md#oq-011--a-package-that-spawns-a-pi-subprocess-is-unmetered).

## pi child processes

A staged package may start `pi` as a child process: pi's own subagent example does, and so does pi-subagents in
its background mode. Each child has its own copy of pi, so the runner's meter cannot see its calls from outside.
Since issue #500 the runner meters them from inside.

**What is metered.** The runner adds a small preload to `NODE_OPTIONS` and names a private ledger folder under
`/tmp`. Every Node child inherits both. In a `pi` child the preload loads a meter first, before any other
extension. That meter counts every call the child makes, writes it to the child's ledger file before the call
goes out, and applies the job's model list and cost cap. Every second, and when the job ends, the runner adds
all the ledgers to the job's own numbers. So the per-job token cap, the cost cap and the model list hold for the
job as a whole, and a stop reaches every child before its next call. This covers:

- a `pi` started from PATH or by path, in any of pi's session modes;
- pi's stock subagent example. In a job it starts the runner itself; that child now runs as a metered `pi` and
  never runs the job a second time;
- pi-subagents: its foreground runs happen inside the runner's own process and land in "other sessions"; its
  background runs are separate processes and land in "subprocesses".

**Where it shows.** The run record's `tokens` gains three numbers. `childTotal` is the children's tokens, already
inside `total`. `childProcesses` is how many children reported, plus any found without a report.
`unmeteredChildren` is how many could not be counted. The run detail in `/dispatch` shows "of which other
sessions" (subagents in the same process, and compaction) and "of which subprocesses" (`childTotal`), and names
any unmetered children. Their per-model spend is in the run's model rows like the parent's.

**The floor.** On Linux the runner also looks through the running processes for a `pi` that writes no ledger,
for example one started with an empty environment. Such a child counts in `unmeteredChildren`. Then:

- under a dollar cap the job stops with `cost-cap`, under a token cap with `token_budget`, under a model list
  alone with `model-not-allowed`. The job log says `unmetered_child`;
- with no cap the job runs on, and its record is a floor;
- a dollar window settles such a job at the floor: at least its reservation;
- the cost views show its dollar with `≥`.

**What is not covered.** This is honest accounting of code that cooperates. It is not a wall: the agent holds
the provider key and runs as the same user as the runner. Named gaps:

- a `pi` child whose spawner clears its environment and also hides every sign that it is `pi` (a renamed copy, a
  changed process title) is not seen. Nor is a client that is not `pi`, or a direct call to the provider's API;
- a child that runs pi as a library inside its own Node program (pi-subagents' background mode does), when its
  spawner clears `NODE_OPTIONS`. Its command line never names pi, so clearing that one variable is enough to hide
  it;
- a child with no working meter that finishes quickly is taken for one that ended before its meter started, and
  is not counted. Quickly means under 3 seconds of CPU and under 60 seconds, and before the job ends. Such a child
  can still make calls in that time;
- a `pi` child with no ledger that the runner first saw less than 2 seconds before the job ended is not counted:
  an honest child looks the same in its first moments;
- a child that lives and spends inside one second, and whose ledger is deleted before the runner reads it;
- a forged ledger that keeps reporting less than the child spent;
- several children can each start a call against the same headroom, up to a second old, so together they can pass
  a cap. That spend is still charged in full;
- off Linux there is no process scan, so only the ledgers count;
- a child whose meter is still starting when the job ends, and that started in the job's last 10 seconds, is not
  counted;
- a lot of output from a background child can push the job's exit line out of the part of the log the worker
  reads. The run then settles at the floor;
- children do not see the overlay `models.json` (issue #503).

**pi-subagents in a job.** It needs `PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT` set to pi's package folder, or it
fails before any child runs. Its children do not see the overlay `models.json` (issue #503), so a model defined
only there is not available to them.

**Cache warming.** The runner turns pi's cache warming off for its own session. A child builds its own pi
settings, and pi's default there is on (`streaming`), so a child's warm re-sends are paid. pi-dispatch does not
turn it off for children it did not start: the meter counts those calls, and a cost cap bounds them. pi reads this
setting only from the global `settings.json` in the agent folder the child uses. A project's `.pi/settings.json`
does not change it, and neither does the pi-dispatch overlay, which a job mounts somewhere else. In a job that agent
folder is part of the job image (`/home/pi/.pi/agent`). So turning warming off for children takes a custom job
image with `"cacheWarming": "off"` in that file, or a spawning package that sets it for the children it starts.

## Honest limits

- A `pi` child process that the runner could not meter makes its run a **floor**, and so does a run that
  pre-dates the meter. A child that hides from the meter entirely is not seen at all (`OQ-011`). A retried
  job's sidecar keeps only the last attempt's spend.
- Runs recorded before the per-model ledger landed cannot be re-priced; they are counted and named in
  the provenance line, never guessed at.
- A run that fans out past the meter's 8-row ledger cap folds the overflow into an `other/other` row:
  its per-model attribution is partly anonymous, the provenance line counts it ("ledgers truncated"),
  and the overflow row is never offered as a what-if target — it is an aggregation artifact, not a
  model anything can re-price.
- Rates provenance is pinned: each ledgered run remembers the pi-ai version that priced it, and a later
  pin bump shows up as "priced under older rates" — history is never silently repriced.
