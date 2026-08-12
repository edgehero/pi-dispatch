# Cost analytics

Every run records what it spent (`docs`: run history; `specs`: `REQ-TOKEN-ACCOUNTING-AND-CAPS`). The
costs surface makes that history analyzable: what a flow costs, what a month costs per model, what a
subscription is actually saving, and what a flow *would* cost on a different model. It informs; it
changes nothing — no auto-switching, no vendor API calls, no database (`REQ-COST-ANALYTICS`,
`DES-COST-FOLD-BY-SCAN`).

## The COSTS view

Press `c` on the dashboard (`/dispatch`). The view is verdict-first:

```
┌ pi-dispatch ── COSTS · Aug 2026 (mtd) ──────────────────────────────────────────┐
│ VERDICT  kimi-allegro is SAVING ~$4.89 est. this month                          │
│   plan price (prorated) $99.00 → $39.60 · plan runs @ API ~$44.49 est.          │
│ daily  ▁▁▂▃▂▅▇▃▂▁·▁▂▂▃█▄▂▁▁▂▃▂▁▁▂▄▃▂▁  Σ ≥$12.41 · max $3.10/d                  │
│   FLOW              RUNS  TOKENS  COST           API-EQUIV                      │
│ › triage             41   12.4M  ≥$8.02         —                               │
│   nightly-sync       28    6.1M  plan:kimi      ~$3.90 est.                     │
│ plans   kimi-allegro $99/mo · 28 runs · ~$3.54 est./run amortized               │
│         peak 5h rolling window: 9 runs, 12.4M tok — limit undisclosed by vendor │
│ ~ estimates at pi-ai 0.80.7 · 2 runs unmetered · 3 not repriceable              │
│ [↑↓] row [f] flow/model [t] 7d/30d/mtd [w] what-if [esc] back                   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Keys: `t` cycles the window (7d / 30d / month-to-date), `f` toggles the by-flow / by-model table,
`w` opens the what-if on the selected flow (press again to cycle candidate models; `/` type-to-filters
the full priced catalog), `Esc` backs out one layer at a time.

## How to read the numbers

Every dollar carries its class, rendered by one shared formatter — these markers are contractual
(`REQ-COST-ANALYTICS`), not decoration:

| rendering        | meaning |
|---|---|
| `$4.12`          | metered — the stream-time price pi-ai computed when the run happened |
| `≥$4.12`         | a floor — some spend was unpriced/unresolved, the run fell back to the in-session meter (which cannot see subagent spend), or the run pre-dates the meter |
| `plan:kimi`      | covered by a declared subscription — prepaid, **never shown as $0.00** |
| `$0 (unrated)`   | a zero-rate provider with **no** declared subscription — unrated, never "free" |
| `~$4.12 est.`    | an estimate (what-if, API-equivalent, or a sum containing any estimate) |
| `~~$4 seeded`    | seeded from no history — a band, never a point |
| `—`              | there is no number behind this cell: a null typed value, such as a flow with no plan-covered rows (no api-equivalent) or a plan with no attributed runs (no amortized figure) |

A run whose container died before reporting tokens contributes no row of its own: it makes its bucket a
floor and demotes it to `est.` with coverage, so nothing renders as an unclassified dollar.

Metered numbers are pi-ai's computed prices, not invoices. The series is bounded by run-history
retention (`PI_LOG_RETENTION_DAYS`, default 30 days; the scan hard-caps at 92 days even when retention
is the keep-forever `0`), and the screen says which window it shows. Plan proration denominates on the
window you asked about, not on when the runs happened to land: a quiet fortnight does not shrink a
plan's share of the month, and verdicts do not read SAVING just because the deployment is young.

## Declaring subscriptions

Subscription-backed providers (`kimi-coding`, `zai-coding-cn`, …) ship all-zero rate tables, so their
runs record `cost: 0` — prepaid, not free. The real price can only come from you: declare each plan in
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

## Without the TUI

- `/dispatch costs [7d|30d|mtd]` — the same fold, plain text, same labels.
- `/dispatch costs whatif <provider>/<model> --flow <flow>` — scripting-friendly what-if; unknown
  models get closest-match suggestions (this is the full-catalog path). `--flow` is **required**: the
  estimate scores one flow's median run, not a portfolio, so the command refuses without it.
- The `dispatch_costs` tool returns the fold as JSON in which **every monetary value carries its
  `class`** — a model reading it can no more launder an estimate into a fact than the screen can.

## Environment

| variable | default | effect |
|---|---|---|
| `PI_LOGS_DIR` | `<OS temp>/pi-dispatch/logs` | the run history this whole fold scans |
| `PI_SUBSCRIPTIONS_FILE` | `./subscriptions.json` | where the admin reads plan declarations (relative to its own working directory; the deployment pointer can set an absolute path instead) |
| `PI_DISPATCH_ASCII` | unset | `1` = ASCII glyphs (frames, meters, sparkline ramp) for glyph-hostile terminals |
| `PI_LOG_RETENTION_DAYS` | `30` | bounds the analyzable history (`0` = keep forever; scan still caps at 92 days) |

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
