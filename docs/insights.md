# Spend and insights

Spend has five views on the [operator console](console.md), all readable by operators and viewers. Each is drawn once per load. The tabs preserve the range, project and path choices the destination supports.

- `/insights`: weekly and daily money, tokens today, average metered cost over 24 hours, settled daily spend with today's actual running-job holds, cost by flow/model/project, job-cost histogram, caps, run-set what-if, metered and plan runs, and a budget split summary.
- `/insights/budget-split`: the envelope, allocation, spent amount, current plan, project rows, history and host envelope digests. The amounts and refusal counts use the envelope's window; the range is carried for navigation. Operators can preview and confirm priorities, envelope changes and history reverts here.
- `/insights/capacity`: fleet utilization, simultaneous peak, wait percentiles and promised memory, followed by each host's charts and coverage. Choose 24 hours, 7 days or 30 days; a carried `mtd` link is supported too. Project memory/CPU sizing remains here until the project page replaces it.
- `/insights/breakdown`: settled window spend, ledger coverage, plan comparisons, daily charts, trigger/repository/model breakdowns and per-flow what-if estimates.
- `/insights/flows`: the graph and its selected-node details, or a server-rendered list with `view=list`. The map's runs cover 30 days; its spend follows the selected spend range. Both windows are named.

## Ranges and projects

Spend and Breakdown offer 7 days, 30 days (the default) and month to date. Project chips filter the records and charts. Headline cards explicitly name their own week, today or 24-hour windows. Project money uses its own configured dollar windows where available, otherwise the deployment's, identified on the page. Budget split's project filter narrows rows; its headline totals and history remain for the whole envelope. Capacity always covers the fleet.

History is bounded by log retention and the 92-day scan cap. A missing read, truncated history or unknown amount is named rather than shown as zero. Reload to refresh.

## Settled, held and caps

Today's settled amount comes from run records. An enforcement record marked `unreserved` with zero dollars means no dollar window was charged; a paid run still shows its recorded metered cost. The view names counter-charged settlement separately when it differs. Missing prices remain unknown, and partial or estimated totals keep their marks. Held money comes from the live workers' actual reservations and their reservation times, never from the difference between a counter and the records. Older workers or incomplete job lists leave the hold total incomplete and are named. Any remaining difference from the enforcement counter is named separately. Past daily bars show settled money only.

Dollar counters include settled charges and reservations. A dollar window can be full before the displayed counter reaches its cap because another job's per-job reservation would not fit. Only global job-count windows have a soft hold; scoped job-count windows have hard caps. At that hold the worker refuses new starts; it does not leave them waiting. Tokens are refused at their cap alone.

A prepaid plan changes reporting, not enforcement: its runs count against every cap, including dollar windows at API-equivalent price. See [cost accounting](costs.md).

## What-if estimates

On Spend, choose a model and the last 24 hours or this week. Each eligible run's ledgered tokens are repriced and summed; excluded runs are counted. The estimate names plan coverage beside API-equivalent cost. Outcomes can differ because a cheaper model can take more turns or fail more often.

Breakdown estimates one flow's median ledgered run at another model's rates, then multiplies by that flow's run count in the selected window. It names coverage, exclusions and the pricing version. A flow without ledgered history has a seeded band, not a measured price.

`/dispatch insights [7d|30d|mtd]` prints Spend's URL. `/dispatch insights whatif <provider>/<model> --flow <flow>` prints Breakdown's answer URL. Existing `/insights?whatif=<provider>/<model>&flow=<flow>` links redirect to Breakdown.

## Budget split actions

Operators use structured fields rather than JSON. Every change uses the existing preview, five-minute single-use confirmation ticket, audit and worker validators. Viewers see neither controls nor plan reasons. Plan reasons are escaped, including visible escapes for invisible or direction-changing characters.

History row numbers start at 1. Revert previews the target weights and writer `operator-revert`. It skips the interval and step limits, but remains bounded by the envelope and refuses while delegation is off or this host has a different envelope. A row without a plan restores today's neutral split. The portfolio job continues and may move the split again. Undo identifies the previous plan by id because history row numbers move.

Changing the envelope writes this host's file and re-bases the split without a step. Other hosts must receive the same file or their governed jobs refuse with `envelope-mismatch`.

## Flows map and paths

Drag to pan, use the wheel or zoom buttons, and choose Fit to reset the view. Tab reaches chips, Enter selects one and Escape clears selection. A Breakdown trigger opens `/insights/flows?select=<index>` with that chip selected by its stable trigger index. A spent one-shot links to its run. Selection and the list are usable without JavaScript.

Charts fit the phone viewport. Tabs, project chips and the map scroll inside their own containers. Both themes retain readable labels and keyboard focus.

Local folders are shown by their last folder. Only an operator asking for `paths=full` receives full local paths; a viewer always receives basenames. No inline script or style is used. Chart tooltips and map node data are escaped hidden lists, and list view carries no map node data.

## What each run records about resources

Every run record carries `resources`: what the job's container used, read from its own cgroup just before the
runner's last line (issue #596). It is in each `<logsDir>/<jobId>.json`, and Capacity's **Memory and CPU sizing** section draws the memory part of it.

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
