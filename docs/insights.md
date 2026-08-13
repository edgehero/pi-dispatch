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
`PI_GRAPH_DIR` names, defaulting under the OS temp dir), prints its `file://` URL, and opens your
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
  denominator, and the lever named (`/dispatch set …`, the panel's `s` key).
- **Trend lines**: a cumulative window-spend line under the daily columns (dashed from the first
  estimated day onward — once an estimate enters a running total it never leaves), and per-flow
  daily spend as small panels on one shared scale, dashed wherever an estimated day touches.
- **Breakdowns**: spend by flow, by trigger, by model, by repo, drawn as bars. Clicking a trigger
  row highlights its node in the topology below.
- **Topology**: the trigger/flow graph, pan/zoom/hover and all ([`graph.md`](graph.md) explains
  every edge and badge), with spend badged under every trigger that spent in the window and each
  cron's next fire or overdue state in its tip.
- **Footer**: the provenance ledger — which pi-ai priced the numbers, what was unmetered,
  unledgered, truncated, or drifted — plus the graph's own honesty counters in the legend.

## The money never lies about itself

Every dollar keeps the class discipline of [`costs.md`](costs.md), visually: solid means metered,
dashed and translucent means estimated (`~ … est.`), `≥` means a floor, a plan-covered bucket draws
a `plan:<id>` chip and **no dollar bar** (prepaid is not free, and $0.00 would be a lie), an
uncovered zero-rate bucket reads `$0 (unrated)`, and the word "free" appears nowhere. Color
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
- The what-if is the `/dispatch insights whatif <provider/model> --flow <flow>` command: an
  estimate wants the full priced catalog, and tab completion offers it.
