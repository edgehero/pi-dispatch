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

## Environment

| variable | default | effect |
|---|---|---|
| `PI_LOGS_DIR` | `~/.pi-dispatch/logs` | the run history this whole fold scans. The default is per user, and this fold runs in the PANEL's account: if your worker runs as a different one, set this explicitly on both sides or the numbers here are silently zero rather than wrong |
| `PI_SUBSCRIPTIONS_FILE` | `./subscriptions.json` | where the admin reads plan declarations (relative to its own working directory; the deployment pointer can set an absolute path instead) |
| `PI_DISPATCH_ASCII` | unset | `1` = ASCII glyphs (frames, meters, sparkline ramp) for glyph-hostile terminals |
| `PI_LOG_RETENTION_DAYS` | `30` | bounds the analyzable history (`0` = keep forever; scan still caps at 92 days) |

## Dollar caps

This page reports spend after the fact. Two settings act on it before the fact (issue #501):

- `PI_MAX_COST_USD`: the most one job may spend. The runner checks it before every model call.
- `PI_DAILY_COST_USD`, `PI_WEEKLY_COST_USD`, `PI_MONTHLY_COST_USD`: what all jobs may spend per UTC day,
  Monday week and month. Each job holds its per-job cap in every window before it starts, and is refused
  (`dollar-cap`) when one has no room. After the run the hold becomes the metered cost, or at least the whole hold
  when the cost is not fully known. Each run record says which, under `dollars.basis`: `metered`, `floor`, `refunded`
  or `unreserved`.

A job that calls no model (a command job, or one whose first call the cap refused) is charged $0. A job whose
cost is not fully known is charged at least its cap, and more when the part that was measured already costs more.

A `pi` subprocess that a package starts inside a job (issue #500) spends outside the runner's meter, so neither
the per-job cap nor the windows see it: a window can undercount such jobs.

Prepaid coding plans that pi prices (`kimi-coding`, `zai`, `zai-coding-cn`) meter their API-equivalent price,
so a dollar window on them caps that implied price, not your bill.

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
