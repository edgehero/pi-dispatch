# Cost analytics

Every run records what it spent (`docs`: run history; `specs`: `REQ-TOKEN-ACCOUNTING-AND-CAPS`). The
cost analytics make that history analyzable: what a flow costs, what a month costs per model, what a
subscription is actually saving, and what a flow *would* cost on a different model. It informs; it
changes nothing — no auto-switching, no vendor API calls, no database (`REQ-COST-ANALYTICS`,
`DES-COST-FOLD-BY-SCAN`).

The surface is the **insights page** ([`insights.md`](insights.md)): `/dispatch insights` writes and
opens one self-contained file with the plan verdicts, the daily and cumulative spend charts, the
per-flow trend panels, and the four breakdowns (by flow, by trigger, by model, by repo) — beside the
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
`local:<folder>` targets as their own rows.

## How to read the numbers

Every dollar carries its class, rendered by one shared formatter — these markers are contractual
(`REQ-COST-ANALYTICS`), not decoration:

| rendering        | meaning |
|---|---|
| `$4.12`          | metered — the stream-time price pi-ai computed when the run happened |
| `≥$4.12`         | a floor — some spend was unpriced/unresolved, the run fell back to the in-session meter (which cannot see subagent spend), or the run pre-dates the meter |
| `plan:kimi`      | covered by a declared subscription — prepaid, **never shown as $0.00** |
| `$0 (unrated)`   | a model the rate table prices at $0, with **no** declared subscription covering it: unrated, never "free" |
| `~$4.12 est.`    | an estimate (what-if, API-equivalent, or a sum containing any estimate) |
| `~~$4 seeded`    | seeded from no history — a band, never a point |
| `—`              | there is no number behind this cell: a null typed value, such as a flow with no plan-covered rows (no api-equivalent) or a plan with no attributed runs (no amortized figure) |

A run whose container died before reporting tokens contributes no row of its own: it makes its bucket a
floor and demotes it to `est.` with coverage, so nothing renders as an unclassified dollar.

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
   the job is refused `dollar-cap`, everything it added is given back, and no container starts. A job whose every
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
    `longContext`, `costUnjudged` and `costUnanswered`;
  - a per-model usage ledger is present, unless the run made no model call at all.
- `floor`: the cost was not fully known. The windows keep at least the whole hold, and more when the measured
  part already costs more.
- `refunded`: no container ran (it never started, or the job was refused), so the hold was given back.
- `unreserved`: the job could not spend, so nothing was held.

Some cases worth knowing:

- **A run that called no model** (for example one whose first call the cap refused) settles metered at $0. A
  command job is not one by itself: the extension command it runs may call models like any other job.
- **A 401 before any answer settles at the floor.** The failed call counts as `costUnanswered`, because a request
  that got no answer may still have been billed. A bad key therefore costs one per-job cap in each window.
- **A run the worker stopped** (timeout, cancel, shutdown) settles at the floor: its exit line is not believed.
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
  fit. Beside it, from the run records: what settled, how many runs settled each way, and the `boundExceeded`
  count. A folder or model row says `records n/a`: a record names a folder by its basename only, and does not say
  which model windows its job reserved in. The records side counts only the records this host can read
  (`PI_LOGS_DIR`), so on a fleet without shared logs it is this host's share. The panel reads the deployment's
  caps from the settings overlay and the deployment's `.env`, so a cap set only in the worker's service unit
  shows no deployment row.
- **`dispatch_costs`** returns the same windows under `dollars.windows`, and each run's `dollars` under
  `dollars.runs`. Amounts are integer micro-dollars (1 USD is 1000000).
- **`dispatch_limits`** gives each scoped-limits row its caps in words and, for a dollar row, each window's cap
  and counter.

A non-zero `boundExceeded` anywhere means a call cost more than the bound said it could. The bound assumes one
token is at least one byte for every tokenizer pi prices; that count is the evidence that would reopen it.

### What the caps do not cover

These are known gaps. Most are named in the specs ([DES](../specs/design.md#des-dollar-reserve-and-settle)); #544
is an open issue.

- **A `pi` subprocess** that a package starts inside a job spends outside the runner's meter (issue #500,
  `OQ-011`). Neither the per-job cap nor the windows see it, so a window can undercount such jobs.
- **No project windows yet** (issue #499). You cannot cap a group of repos and folders as one. The key space
  `budget:usd:p:` and the `project:` scope are reserved for it.
- **Scopes collide across forges** (issue #498). A GitHub `acme/web` and a Forgejo `acme/web` share one repo row
  and one counter.
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
- **A failed stream** counts at its bound only against the per-job cap during the run. The windows settle from
  pi's partial cost, which can be below what the provider billed: an undercount, not an overcharge.
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

## Honest limits

- Totals are **floors**: a `pi` subprocess spawned by a staged package is unmetered (`OQ-011`), and a
  retried job's sidecar keeps only the last attempt's spend.
- Runs recorded before the per-model ledger landed cannot be re-priced; they are counted and named in
  the provenance line, never guessed at.
- A run that fans out past the meter's 8-row ledger cap folds the overflow into an `other/other` row:
  its per-model attribution is partly anonymous, the provenance line counts it ("ledgers truncated"),
  and the overflow row is never offered as a what-if target — it is an aggregation artifact, not a
  model anything can re-price.
- Rates provenance is pinned: each ledgered run remembers the pi-ai version that priced it, and a later
  pin bump shows up as "priced under older rates" — history is never silently repriced.
