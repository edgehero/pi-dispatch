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
runner's last line (issue #596). It is in each `<logsDir>/<jobId>.json`, and the page's **job sizes** section draws
the memory part of it (below).

| Field | What it is |
|---|---|
| `memPeak` | the most memory the container held at once, in bytes (page cache included) |
| `swapPeak` | the most it held in swap at once, in bytes. `memPeak` does not count swap. Since job sizes a container gets no swap beyond its memory, so this is 0 on a current worker; a run from an older worker could swap as much as its memory |
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
  a job can inflate any of them (or report less). The size suggestions read them again as untrusted: a value that is
  not a whole number is ignored, one past the container's own bounds is clamped to them, and no suggestion is applied
  by anything but the call it names, which you confirm.
- A job whose container ran out of memory ends `oom-killed`, outcome `policy`, and is not retried. The worker reads it
  so only when the image's supervisor reported it on a signed line, the container exited 137 without the worker
  stopping it, and `memPeak` reached 90% of the container's memory limit: the kernel counts a kill by the HOST's
  out-of-memory killer the same way, and a machine short of memory says nothing about the job's size, so such a run
  retries. A job where only a child process was killed keeps its own outcome, and `oomKills` above 0 shows it.
- Each job runs at its size: its project's `memory` and `cpus`, else `PI_JOB_MEMORY` and `PI_JOB_CPUS` (default
  4 GB and 2 CPUs). Every record says which in `size` (`memMiB`, `cpuCenti` in hundredths of a CPU, and `source`:
  `project`, `env` or `default`). Compare `memPeak` with it to choose a size ([job sizes](scoped-limits.md#job-sizes-version-3),
  and [sizing jobs](sizing.md) for the whole path).
- Disk I/O, disk space and network are not measured or isolated.

### The job sizes section

- **Each host's budget in use**: every live host's memory and CPU budget, and what its running jobs hold now, as the
  hosts publish them. "unknown" while a host has not read its runtime yet, "off" for a budget switched off.
- **Per project, a chart of peak memory over time against the size line.** One dot per run (red for a run that ended
  `oom-killed`) at its peak, over the last 30 days. The line is each run's size from that run on, and it steps to the
  project's current size at the right edge. A dot on the line is a run that reached its limit, which page cache alone
  does (a red dot is a kill). A peak above its size is drawn at the size.
- **The suggestion** above each chart, and the exact call that applies it. These are the same runs and the same rules
  as `pi-dispatch doctor` and the panel's PROJECTS view use ([choosing a size from the
  runs](scoped-limits.md#choosing-a-size-from-the-runs)). A raise is capped at what a live host offers the project
  (its `hostShare` of a budget, where its row has one), each host judged on its own pair of memory and CPU budgets; a
  suggestion larger than any host offers says so and shows no call. A memory-pressure or CPU-ceiling fact shows below
  the call, as information. Nothing on this page changes a size.
- Only this host's run records are read for the sizes. A run another host recorded is counted only on a shared
  `PI_LOGS_DIR`.

## What each run records about capacity

Two more fields in every run record feed the capacity report (issue #599), which `pi-dispatch capacity`, doctor,
`dispatch_capacity` and the panel's HOSTS view show:

| Field | What it is |
|---|---|
| `queuedAt` | when the job became eligible to run, as an ISO time. `startedAt` minus `queuedAt` is how long it waited for a slot |
| `earlier` | on a retry, the slot time of the job's earlier attempts, whose record this one replaced: `host`, `startedAt`, `endedAt`, `memMiB`, `cpuCenti`, at most 4 (never their cost, so no cost total counts anything twice) |
| `stalledRepick` | true when the job's first attempt stalled (the worker running it died or lost its lock) and this pickup re-ran it; that first pickup's time no record holds |
| `capacity` | what the host offered when the job took its slot: `slots` (the live `PI_CONCURRENCY`), `memMiB` and `cpuCenti` (the host budget, a number, `"off"`, or null without one) and `cpus` (the CPUs the container runtime reports: on Docker Desktop the VM's, not the Mac's) |

- `queuedAt` is the moment the job was added plus the delay it was added with. A cron job is created ahead of its
  slot and delayed until it, so its `queuedAt` is the scheduled minute, not the moment before. A pause window, a
  deferral (a busy folder, a full budget) count as waiting, because the job was ready and did not run. A retry, and a
  pickup after a stall, records null: its wait would include the earlier pickup and its run. A job held on `run.waitFor` records null too: the wait
  its trigger asked for is not a wait for capacity.
- `capacity` is set when the worker admits the job, after every gate and before the clone, and is read then: a
  `PI_CONCURRENCY` or budget change while it runs does not change it. **It is null on every job refused before it
  held a slot** (a size that never fits, a wait gate refusal), so the record itself says whether the run used a slot.
  A record from before this field has no `capacity` key at all; the report reads its reason first (a wait or size
  refusal never used a slot), then counts it as having used one when it lasted at least a second or reported
  `resources`, and says how many it inferred each way.
- Both are numbers and fixed words, like the rest of the record.

### `pi-dispatch capacity`

`pi-dispatch capacity [--since 24h|7d|30d] [--host <name>] [--json] [--valkey-url <url>]` (default `7d`) prints, per
host: the share of the time it ran at least one job and the share it sat idle; the average and peak number of jobs at
once and how long every slot was taken; the memory and CPU its jobs were promised against its budget (CPU against all
its CPUs when the CPU budget is off); the CPU they used, as a share of the host's CPUs (never above 100% of them); the wait for a slot at p50 and p95; the projects by run
time; and where that host's history starts. Each moment is judged by the capacity in force then, so a budget you
lowered while jobs ran shows as an over-commit only for the time it was lower. `--json` prints the whole report. It
reads only `VALKEY_URL` (or the one `--valkey-url` names) and the logs directory, like `pi-dispatch status`, and writes
nothing. If a Valkey you named with `--valkey-url` refuses or does not answer, it exits 1; one taken from the
environment gives a report from this host's files, and says why.

The same report shows in three more places. `pi-dispatch doctor` prints one line per host for the last 7 days (busy
share, average and slots, promised memory and CPU, CPU used, the wait and the busiest project, then what the line
cannot see), never as a warning. The `dispatch_capacity` tool returns it to a model in pi (`window` `24h`, `7d` or
`30d`, and an optional `host`), as text and as the report `--json` prints. The panel's HOSTS view (`u` in
`/dispatch`) shows each host's last 7 days under its live slots, budget and running jobs, with the same caveats, and
reads the report when it opens and again on `u` ([what the panel shows](multi-host.md#what-the-panel-and-doctor-show-you)).

- **Jobs only.** No machine load is measured, so a machine busy with other work reads as idle.
- **Missing history is never idle.** It reads the run mirror where workers declare `PI_WORKER_NAME`, and this host's
  own files, and each host's history starts where its own sources do: this host's files to `PI_LOG_RETENTION_DAYS`,
  the mirror to what it still holds (a host both hold, such as a named host seen from itself, says "the run mirror and
  this host's files"). Every worker trims the shared mirror by its own retention, so a host with a
  shorter one cuts everyone's older runs; it records where it cut, and the report starts the mirrored hosts there.
  Time before a host's history, and a live host whose runs it cannot see (one without `PI_WORKER_NAME` writes no
  mirror), count as neither busy nor idle, and the report names them.
- **A job running now is counted as busy up to now.** Each worker's registry row lists the jobs it runs (with or
  without a host budget), and the report counts each from the moment it was admitted. A row that has not beaten for
  more than 30 seconds counts its jobs only up to its last beat. A running job the row does not list (it lists 32) is
  said as not counted, and so is one on a host whose history is not shared. A row whose list of running jobs cannot be read is named, and the number running now is then unknown. A container whose stop did not take (an
  orphan) is named, but its time after the failed stop is in no record and is not counted as busy.
- A retry replaces its earlier attempt's record, but carries that attempt's
  slot time in `earlier`, so it is counted; only an attempt whose record could not be read is not, and the report says
  how many runs were retries. A run whose first attempt stalled and was picked up again is counted too, and the report says the stalled
  pickup's own time is not. A stall of a later attempt is not counted at all: the run after it reads as an ordinary
  retry, and the stalled attempt's time is in no record. CPU used comes from `resources`, which the job's container
  produces: advisory, like every number there, and read at most at what the job's `--cpus` allows.

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
