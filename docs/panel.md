# The `/dispatch` panel

The panel is a **pi extension**: the same deployment as the [web console](console.md), inside your own pi session. It loads
into pi and adds no daemon and no network port. Both read the same files and the same queue, and both write through the same
validated functions, so neither can do anything the other would refuse.

Install it with `pi install npm:@edgehero/pi-dispatch-admin` and type `/dispatch`. If no deployment exists yet, `/dispatch setup`
builds one. It writes a small pointer file (`~/.pi/agent/pi-dispatch-deployment.json`, paths only, never credentials) so the panel
finds the deployment from any directory, and your own environment variables always win over it. When the deployed version falls
behind the panel's, a notice points you back at `/dispatch setup`.

![The /dispatch panel: live queue state, day, week and month job meters with a daily token counter, the dollar windows, the triggers pane with a portfolio trigger, pause windows, scoped limits with a project row and a model row showing their dollar caps, held and failed jobs, and the interactive runs list with each run's project and the u hosts key on its divider, in one framed terminal view](images/dispatch-dashboard.svg?v=2026-10-22-710)

## Keys

| Key | Does |
|---|---|
| `↑↓` `Enter` | open a trigger or a run |
| `a` | add a trigger (checked, saved atomically, reloaded live) |
| `Enter` then `e` `x` | change a trigger's flow, delete it (asks first) |
| `p` `r` | pause and resume the queue |
| `s` | set a limit |
| `w` `m` | manage quiet hours, manage scoped limits |
| `j` | show the projects, their members and spend; `Enter` on one filters the runs list |
| `b` | show the budget split (the list's `b`; in an opened run, `b` reopens its workspace) |
| `u` | show each host: its slots, budget and running jobs now, and how busy it was over the last 7 days |
| `h` `f` `k` | show held jobs, failed jobs and parked runs |
| `z` | show Watch findings and outcome counters |
| `l` `o` | open the running job's live log, change the runs sort |
| `t` `T` on a running job | steer it, or send a follow-up ([steering](steering.md)) |
| `x` on a running job | cancel it (asks first) |
| `i` | show the address of the console's insights page |

`Enter` on a run opens its full record. In that view, `b` reopens the run's workspace, which is not the list's `b`, and `y` and
`Y` copy its job id and its target's address.

![The run detail view of a parked triage run: awaiting input, with the reason's sentence and next step, its issue and flow, timing, host and venue, its project, the dollars it settled, turns, tokens and cost, the chain line, and the retained sandbox with its egress setting](images/dispatch-run-detail.svg?v=2026-10-22-710)

## Commands

The same data is there as plain commands, all local, with no model involved: `/dispatch status | pause | resume | run | runs | logs |
chat | budget | insights | console | triggers | settings | set | unset | priorities | setup | secrets`.

`/dispatch console` opens the web console or prints how to reach it ([console](console.md#from-pi-dispatch-console)), and
`/dispatch chat` opens a run's conversation ([chat](chat.md#in-pi-dispatch-chat)).

![Transcript of /dispatch status, budget, runs, triggers and priorities: queue counts and budget, the scoped limits with their dollar rows, the run history table with tokens, cost, chain and replica per job and a run awaiting input, the triggers list with a portfolio trigger and a trigger with an MCP server, and the budget split with its history](images/dispatch-commands.svg?v=2026-10-22-710)

## Asking your assistant

The package also ships the `operate-pi-dispatch` **skill**, so you can ask in plain words: "raise the daily cap to 30", "cap acme/web at
ten runs a day", "add a nightly tidy trigger for /srv/site". Reading needs no confirmation. Every config change asks **you** to confirm in
a prompt the model cannot answer, and is refused when no operator is present, so a prompt injected session cannot raise your cap or add a
paid trigger. Raw job logs show in the panel only and never reach the model.

One tool is deliberately not money safe: `dispatch_run` queues a paid run without asking. Six separate limits bound it instead: a folder
allowlist, the committed `ai-trigger: allow` opt in, the dirty tree refusal, no spend settings, a rate limit and the daily cap.
