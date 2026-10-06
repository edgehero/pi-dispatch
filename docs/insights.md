# Insights

One page that answers the two questions the terminal answers separately: **what is this deployment
wired to do** (the trigger/flow topology, [`graph.md`](graph.md)) and **what is it costing**
(the cost analytics, [`costs.md`](costs.md)). The insights artifact puts the charts a human reads
fastest next to the topology those numbers came from — spend per day, per flow, per trigger, per
model, per repo, plan verdicts, and the graph with spend badged onto the triggers that earned it.

```
/dispatch insights [7d|30d|mtd] [--no-open] [--full-paths]
```

writes **one self-contained HTML file** to `<graph dir>/insights.html` (the same directory
`PI_GRAPH_DIR` names, defaulting to `<OS temp dir>/pi-dispatch-<uid>/graph`, one per account), prints its `file://` URL, and opens your
browser. No server, no
port, no external requests: the page is inline SVG/CSS/JS and works from the file system, over
`scp`, or attached to a ticket. Re-running the command overwrites the same path atomically, so a
tab you keep open picks the new fold up through its Reload/auto-reload controls.

## Reading the page

- **Header**: the spend window you asked for (`30d` by default, deliberately matching the topology's
  fixed 30-day record window) and the "generated N ago" staleness stamp.
- **KPI tiles**: window spend, runs, how many runs were fully ledgered, plans declared, top flow.
- **Plan verdict cards**: one per declared subscription — SAVING/LOSING against API rates (or
  WOULD SAVE/WOULD LOSE for hypothetical plans), the amortized $/run, the API-equivalent, and the
  observed peak per vendor window. A vendor that discloses no limit gets facts, never an invented
  burn-down. No counterfactual declared reads exactly that.
- **Daily spend**: a column per UTC day. Quiet days render as quiet baseline ticks, never compressed
  away. A dashed, translucent column is an estimate; a `≥` marks a floor.
- **Budget**: the operator's one real lever on cost, beside the spend it limits — reserved vs cap
  for the day/week/month job-slot windows and the daily token counter, states as words
  (`soft-hold`, `over`), an overlay-unset cap shown as unknown or off with no bar and no invented
  denominator, and the lever named (`/dispatch set …`, the panel's `s` key). Under them, one line per
  `scoped-limits.json` row: its job counts against their caps, and its dollar windows as spent and held
  against the cap ([scoped limits](scoped-limits.md)).
- **Budget split**: with an allocation envelope ([allocation](allocation.md)), the envelope, one bar per
  project (its share, its spend in the envelope's window and an amber tick at its floor), the headroom, the plan
  in force (who wrote it, when, until when, and whether the step clamped it), and the newest 20 outcomes of the
  split's history. Under it, two counts over the spend window from this host's run records: jobs refused for a
  reason of the split (`allocation-cap`, `envelope-mismatch`, `portfolio-no-envelope`,
  `portfolio-snapshot-oversize`), and what each portfolio run's plan came to. No host name and no plan reason
  reaches the page. With no envelope the section says so; when Valkey cannot be read it says that and shows no
  number.
- **Trend lines**: a cumulative window-spend line under the daily columns (dashed from the first
  estimated day onward — once an estimate enters a running total it never leaves), and per-flow
  daily spend as small panels on one shared scale, dashed wherever an estimated day touches.
- **Breakdowns**: five, spend by flow, by trigger, by model, by repo and by project, drawn as bars. Clicking a trigger
  row highlights its node in the topology below. The by-project bars carry the id each run recorded, and runs
  outside every project, or from before projects existed, are `(no project)` ([projects](projects.md)).
- **Topology**: the trigger/flow graph, pan/zoom/hover and all ([`graph.md`](graph.md) explains
  every edge and badge), with spend badged under every trigger that spent in the window and each
  cron's next fire or overdue state in its tip. A `run.command` trigger renders as its `/name` with
  no flow edge — by design, not as a defect — and earns its by-trigger spend row like any other entry.
- **Footer**: the provenance ledger — which pi-ai priced the numbers, what was unmetered,
  unledgered, truncated, or drifted — plus the graph's own honesty counters in the legend.

## The money never lies about itself

Every dollar keeps the class discipline of [`costs.md`](costs.md), visually: solid means metered,
dashed and translucent means estimated (`~ … est.`), `≥` means a floor, a plan-covered bucket draws
a `plan:<id>` chip and **no dollar bar** (prepaid is not free, and $0.00 would be a lie), an
uncovered zero-rate bucket reads `$0 (unrated)`, and the word "free" appears nowhere. An undeclared plan
whose provider pi prices at an API-equivalent rate (`kimi-coding`, `zai`, `zai-coding-cn`) draws that rate
as metered spend, so declare it (see [`costs.md`](costs.md#declaring-subscriptions)). Color
reinforces these markers; it never replaces them.

## Two windows, stated

The spend half answers the window you asked for (`7d`, `30d`, or month-to-date). The topology half
always describes the fixed 30-day record window its run counts and observed edges are folded over.
The header states both, and every spend badge's tooltip names its window, so a screenshot cannot
conflate them.

## Flags

- `--no-open`: write and print the URL only (scripting, SSH).
- `--full-paths`: name local folders by their full paths instead of basenames. Off by default
  because the artifact is a durable, shareable file.

Over SSH or without a display the browser spawn is skipped and the skip is stated; the URL is
always printed first. `scp` the file to your desktop and open it there.

## What-if: re-price a flow before you switch

The estimator answers "what would this flow have cost on another model" from the same ledger the page
draws — history is never re-priced, the counterfactual is:

```
/dispatch insights whatif <provider/model> --flow <flow>
```

The target splits on the **first** `/` (model ids carry dots and colons, never the provider separator),
`--flow` is required because the estimate scores **one flow's median run**, not a portfolio, and tab
completion offers the full priced catalog. Worked question: nightly `build-report` runs cost real money
on the deployment default; before pinning the trigger's `model` to something cheaper, ask

```
/dispatch insights whatif anthropic/claude-haiku-4-5 --flow build-report
```

```
What-if build-report @ anthropic/claude-haiku-4-5:
  estimate ~$4.87 est. total · ~$0.16 est. per run
  coverage 87% of observed runs ledgered · excluded 4 (no ledger)
  rates pi-ai 1.0.3
```

How to read it, class markers on ([`costs.md`](costs.md)): the flow's **median ledgered run** is
re-priced at the target's rates, then multiplied across **every observed run** — the un-ledgered ones
presumably cost something too, and the coverage line states how much of that extrapolation is measured.
There is no window argument: the estimate wants every ledgered run it can see, so the scan runs at its
own 92-day ceiling rather than a display window. A flow with no ledgered run at all answers with a
seeded band, marked as such, never a confident number; an unknown model answers with the closest priced
ids instead of an estimate. The output is an argument for an edit, not an edit: the lever stays the
trigger's own `model`/`provider` fields or the `/dispatch set` knobs.

## What each run records about resources

Every run record carries `resources`: what the job's container used, read from its own cgroup just before the
runner's last line (issue #596). It is not drawn on this page yet; it is in each `<logsDir>/<jobId>.json`.

| Field | What it is |
|---|---|
| `memPeak` | the most memory the container held at once, in bytes (page cache included) |
| `swapPeak` | the most it held in swap at once, in bytes. `memPeak` does not count swap. Today a job's container may swap as much as its memory (the runtime's default), so a job at its memory limit swaps before it is killed: a run that fit shows little or none here, one that needed more shows a lot |
| `oomKills` | processes the kernel killed for memory |
| `memSomeUsec`, `memFullUsec` | microseconds some or all of its tasks waited on memory |
| `cpuUsec` | CPU time used, in microseconds |
| `throttledUsec`, `throttled` | time and periods the CPU limit held it back |
| `pidsPeak` | the most processes at once |

- Each field is a whole number, or null when the venue did not expose it. The whole block is null for a run on an
  older job image, or on a venue that hides the cgroup. A runner killed before its last line still has one: the
  image's supervisor reads the cgroup when it reports the death, so a job killed for memory carries the numbers that
  show it.
- **These numbers are advisory.** They are produced inside the job's container, which runs code the job controls, so
  a job can inflate any of them (or report less). Anything that suggests a size from them (the later phases of issue
  #596) must clamp them to the container's own bounds and must never apply a size by itself: an operator decides.
- A job whose container ran out of memory ends `oom-killed`, outcome `policy`, and is not retried. The worker reads it
  so only when the image's supervisor reported it on a signed line, the container exited 137 without the worker
  stopping it, and `memPeak` reached 90% of the container's memory limit: the kernel counts a kill by the HOST's
  out-of-memory killer the same way, and a machine short of memory says nothing about the job's size, so such a run
  retries. A job where only a child process was killed keeps its own outcome, and `oomKills` above 0 shows it.
- Every job still runs at 4 GB and 2 CPUs. These numbers are for choosing sizes later, not limits.
- Disk I/O, disk space and network are not measured or isolated.

## Honest limits

- The page is a snapshot: it re-renders when you re-run the command, not by itself. The auto-reload
  control re-reads the file so an open tab follows your re-runs.
- Everything the [`costs.md`](costs.md) honest-limits section says holds here too: totals are
  floors, pre-ledger runs are counted rather than guessed at, and history is never re-priced.
- The topology's tier visibility depends on this session's environment: the overlay and
  staged-package skill tiers enumerate only when `PI_GLOBAL_PI_DIR` is set for the session running
  `/dispatch insights` (the deployment pointer deliberately cannot carry it), and a flow the visible
  tiers miss renders the amber `[not at HEAD]` state rather than a red claim — see
  [`graph.md`](graph.md).
