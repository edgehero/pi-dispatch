# Durable runs

A run that dies part way is normally lost or started over. If the worker is killed, the machine reboots or the
job's container dies on an infrastructure fault, the queue either fails the job (a crashed worker) or retries it
from scratch: a fresh clone, an empty conversation, and every turn paid for again. A retry can also repeat a push or
a comment the first attempt already made.

A trigger can opt into continuing such a run from where it got to instead.

```jsonc
{ "on": { "type": "label", "any": ["pi"] },
  "run": { "kind": "github", "flow": "fix", "recover": true } }
```

With `"recover": true` the worker takes **checkpoints** of each running job: a copy of its workspace and of its
conversation, taken together. When the run is lost, the worker queues a **recovery** that restores the last
checkpoint into a new container and carries on with the same conversation. It is checkpointed, not exactly once:
the agent is told which tool calls were cut off, and it checks before it repeats anything outside the workspace.

Off by default. A trigger without `recover` behaves exactly as before.

**A repository with pi extensions is not recovered.** If the commit a run starts from has anything under
`.pi/extensions/`, that run is not armed: it runs exactly as before, and its record says
`recoverSkipped: "workspace-extensions"`. An extension is code, and it can load files from elsewhere in the
workspace or from `node_modules`; in a restored workspace those were written by the agent, and pi-dispatch cannot
tell which files an extension will load.

## Turn it on

You need four things.

1. **The trigger field.** `"recover": true` on a webhook trigger (github, gitlab, forgejo or azure). A cron trigger
   is refused when the file loads, because its job edits your folder in place and a continuation would replay over
   changes the lost run already made. It is also refused beside `"command"`, because continuing a command job would
   run the command a second time. See [`triggers.md`](triggers.md).
2. **A checkpoint store.** Set `PI_SESSIONS_DIR` (the checkpoints then go to `<PI_SESSIONS_DIR>/.checkpoints`), or
   set `PI_CHECKPOINTS_DIR` to a directory of its own. Without either, a job of that
   trigger is refused before it costs anything (`recover-store-unset`) and the issue gets a comment saying how to
   fix it. The store holds transcripts and whole workspaces, so treat it like the session store: mode `0700`, the
   worker's own account, not under the temp directory.

   ```bash
   mkdir -p ~/.pi-dispatch/sessions && chmod 700 ~/.pi-dispatch/sessions
   PI_SESSIONS_DIR=/home/you/.pi-dispatch/sessions
   # or, separately:
   # PI_CHECKPOINTS_DIR=/home/you/.pi-dispatch/checkpoints
   ```
3. **A job image with the `recover` capability.** The image this repository builds declares it. An image without it
   is refused before anything is spent (`job-image-recover-unsupported`), because its runner would ignore the
   recovery and resume into a conversation with unanswered tool calls. See [`job-image.md`](job-image.md).
4. **On a fleet, a name for every worker.** Set `PI_WORKER_NAME` on each machine. A checkpoint lives on the machine
   that took it, and a recovery is sent to that machine's own queue. Without names, the recovery goes to the shared
   queue, and if another machine picks it up it cannot find the checkpoint and the run fails
   (`recovery-checkpoint-absent`). `pi-dispatch doctor` warns about this. See [`multi-host.md`](multi-host.md).

Git 2.32 or newer is needed on the worker for the store's own git.

## What happens while the job runs

- **The tools run one at a time.** Normally pi runs the tool calls of one model reply side by side and saves their
  results together at the end. A recovering job must know which call was running when it was lost, so a
  `recover` job runs them one after another and each result is saved as it lands. That costs wall time on a reply
  with several independent calls, which is why it is opt-in.
- **Checkpoints are taken at quiet points.** When every tool call of the agent's last reply has its result, and at
  least a minute after the previous checkpoint, the worker freezes the container for a moment (`docker pause` or
  `podman pause`), copies the conversation up to that instant and the workspace, and unfreezes it. The freeze is
  usually short; a copy that would take longer than 20 seconds is abandoned and the job unfrozen, and a freeze longer
  than 15 seconds makes the next checkpoint wait longer. At most two checkpoints run at once on a machine. If checkpoints
  keep failing, the job stops taking them and goes on unprotected.
- **A venue that cannot freeze** (rootless Podman on cgroup v1) takes no checkpoints while the job runs. It still
  takes one when the container dies on an infrastructure fault, so those are recovered, but a worker crash mid-run
  is not.
- **What a checkpoint skips.** Every `.git` folder (the worker keeps its own copy of the base commit), sockets and
  devices, and files the worker cannot read (the checkpoint is then marked partial). A conversation over 256 MiB is
  not checkpointed. Only the newest checkpoint and the one before it are kept. Past 512 MiB of new bytes,
  200,000 files or 64 MiB for one file it drops ignored files (build output) first, and if it is still too big it
  skips that checkpoint and keeps the previous one. A checkpoint holding the job's forge token or one of its
  `run.secrets` values is refused whole.

## When the container dies

A container that ends on an infrastructure exit (exit 1, an unknown exit code, a container that outlived its
`docker run`) is not retried from scratch. The worker takes one last checkpoint of the dead container, queues a
recovery, and records the lost attempt as `failed` with reason `recovery-enqueued`. No failure comment is posted and
no `on_failure` hook fires, because the run is continuing. A status comment (`statusComment`) says the attempt ended
and is being retried, and the recovery edits the same comment.

These are never recovered: a policy stop (exit 2), a completed run, a stop the worker made itself (the timeout, a
cancel, a graceful shutdown), an out-of-memory kill the image confirmed, and a container that never started. They
end exactly as before.

## When the worker crashes

A worker that dies mid-run leaves its job stalled, and the queue fails it when it is next looked at (pi-dispatch
never lets the queue re-run a stalled job on its own). Any worker that sees that failure checks whether the run has
a checkpoint. If it has, it queues the recovery to the machine holding the checkpoint, writes the lost attempt's
record (`recovery-enqueued`) and posts nothing. If it has none (the worker died in the first minute, or on a venue
that cannot freeze), the run fails as before, with the usual comment.

When the recovery lands on the machine that crashed, it first looks for the lost attempt's job folder. If it is
still there, one more checkpoint is taken from it (a **salvage**), so the recovery continues from where the run
really got to rather than from the last minute's checkpoint. At boot the worker also removes job folders a crash left
behind, once they are older than the job timeout, keeping any a recovery still needs.

A recovery that cannot start yet for a passing reason (Valkey did not answer, a file was locked) waits a minute and
tries again; it has one attempt and does not spend it on that. A recovery whose run has meanwhile finished (its
record says completed or stopped) is dropped without a comment.

If the machine holding the checkpoint has not taken the recovery within six hours, any worker checks whether that
machine is still alive. While it is (it still reports in), or the queue is paused, or the check cannot be made, the
wait is extended an hour at a time, for at most seven days. Once the machine is gone, or after seven days, the
recovery is taken off the queue, recorded as `recovery-host-lost`, commented on the issue and `on_failure` fires.

## What the agent sees

The recovery restores the workspace (the run's own base commit, with the lost attempt's changes on top) and the
conversation, then answers every tool call the loss cut off before the model is asked anything:

- **replayed**: a builtin file tool (`read`, `ls`, `grep`, `find`, `edit`, `write`) or `report_progress` is run
  again, through the same extension hooks as any call, because its effect stays in the restored workspace;
- **interrupted**: the first call that was cut off and is not safe to run again (any `bash` command, an MCP or
  forge call, an extension's tool). It may or may not have taken effect;
- **not started**: every call after that one. It never ran.

Then, instead of the task again, the agent gets a fixed message: the job was interrupted and restored, `.pi/`,
`.agents/` and the root `AGENTS.override.md`, `AGENTS.md` and `CLAUDE.md` were reset to the commit the run started
from (so it must re-apply any change it made there), interrupted calls may or may not have happened, and before repeating anything outside the
workspace it should check: `git fetch` and compare, push with `--force-with-lease`, run `gh pr list --head <branch>`
(or the forge's equivalent) before opening a pull request, and read the issue's comments before posting.

The reset of `.pi/`, `.agents/` and the context files is not optional. Those are what pi loads as the repository's
own code and instructions, and the restored tree was written by the agent.

## Costs and caps

- **A run is continued at most twice.** If a recovery's own container is lost and no further recovery can be queued,
  the run ends as `recovery-failed`, with a comment and one `on_failure` call.
- **Each container reserves its own budget.** A recovery takes no second job-count slot (it carries the run's), but
  it reserves its own dollar hold up to the per-job cap before it starts, like any job. The hold of the container
  that was lost stays charged in full: its real spend is unknown, and the conversation's own usage figures are
  written inside the container, so they are not trusted to lower it. So one run can hold at most four full per-job
  caps: the two queue attempts of a forge job plus two recoveries.
- **The agent can cause a recovery.** Killing its own runner reads as an infrastructure exit. The cap above is what
  bounds that.
- **What it saves.** A recovery pays only for what comes after the checkpoint, where a retry pays for the whole run
  again.
- **Disk.** The store is capped at 20 GiB in total, and a run's checkpoints are removed when the run ends, or 7
  days after its last checkpoint when it never does.

## What is not covered

- **Another machine.** A recovery runs only on the machine that holds the checkpoint. A shared `PI_SESSIONS_DIR`
  does not change that today: a recovery refuses a checkpoint another machine took. A forge mirror of the
  workspace was considered and declined: it could not carry the transcript (`OQ-045` in `specs/open-questions.md`).
- **Local folders.** A local job is not armed: it runs as before, and its record says `recoverSkipped: "local"`.
- **Exactly once side effects.** A push, comment or forge call that was running when the run was lost is not undone
  or confirmed by pi-dispatch. The agent is told and checks; the forge's own rules (a branch that already exists, a
  pull request that is already open) do the rest.
- **A graceful stop.** Stopping or restarting the worker cleanly stops its jobs as a worker abort, which is not
  recovered. Use `pi-dispatch service restart --drain` to let running jobs finish first.

## Doctor

`pi-dispatch doctor` reports the checkpoint store when one is configured:

- where it is, whether it exists (or can be created), and whether it is a private `0700` directory of the worker's
  account;
- a warning when it is a symbolic link, is not a directory, or sits under the OS temp directory;
- a failure when `PI_CHECKPOINTS_DIR` collides with `PI_SESSIONS_DIR` (the same directory, the session store inside
  the checkpoint store, or the checkpoint store inside one of the session store's key folders), because the session
  reaper and the checkpoint sweep would delete each other's folders; the worker refuses to start with that setting.
  The default `.checkpoints` inside `PI_SESSIONS_DIR` is fine;
- the git version (2.32 or newer);
- a warning when a trigger sets `recover` on a worker that has peers but no `PI_WORKER_NAME`;
- for each venue, whether it can freeze a job (and so take checkpoints while the job runs) or gets exit checkpoints
  only.

At boot the worker logs one `durable_runs` line with the store's path and whether it takes checkpoints.

## In the run record

A job that never set `recover` has none of these fields.

| Field | What it says |
|---|---|
| `recoveryOf` | on a recovery's own record (job id `<runId>.r1` or `.r2`): the run it continues |
| `recovered.from` | where the checkpoint came from: `live` (taken while the job ran), `exit` (after its container died) or `salvage` (from a crashed attempt's folder) |
| `recovered.n` | which recovery, 1 or 2 |
| `recovered.fromAttempt`, `recovered.checkpointSeq` | the lost container's number in the run and the checkpoint's number |
| `recovered.orphans`, `replayed`, `interrupted`, `notStarted` | the cut off calls and how each was answered |
| `recovered.countsFrom` | where those counts came from: `exit-line` (the runner's last line, used whenever it carries them) or `transcript` (the last line was missing, as when the recovery's container was killed, or carried no counts, so they were read off its transcript, which the agent can write to) |
| `recoverSkipped` | why a job that set `recover` ran without it: `local`, `no-run-id`, `base-unprimed` (the store could not take the base, so the run went on unprotected) or `workspace-extensions` (the repository has pi extensions) |
| `checkpoints` | how many checkpoints this attempt `written`, `failed` and `skipped` |

The reasons a durable run can end with:

| Reason | Outcome | When |
|---|---|---|
| `recovery-enqueued` | failed | the attempt was lost and its recovery was queued; nothing is posted |
| `recovery-failed` | failed | a recovery's container was lost too and no further recovery could be queued; commented and paged |
| `recovery-host-lost` | failed | the machine holding the checkpoint is gone (or seven days passed); commented and paged |
| `recovery-unsafe-extensions` | policy | the recovery's repository has pi extensions; commented |
| `recovery-checkpoint-absent` | policy | the checkpoint is missing, damaged, or from another machine, pi version or venue; commented |
| `recovery-cap` | policy | a recovery numbered past the cap; commented |
| `recovery-superseded` | policy | the run had already finished when its recovery ran; silent |
| `recover-store-unset` | policy | no checkpoint store on this worker; commented, nothing spent |
| `job-image-recover-unsupported` | policy | the image lacks `recover`; commented, nothing spent |

The console and the `/dispatch` panel call a run that ended `recovery-unsafe-extensions`, `recovery-checkpoint-absent`
or `recovery-cap` **failed**, though its record says `policy`: the run was lost and could not be continued, which is no
rule's refusal. Each keeps its reason beside the word, counts among the day's failures on the overview, and is found by
`/runs?outcome=failed` (and still by `outcome=policy`, the record's own value). The other `policy` reasons above keep
the word refused.

The run's live transcript, progress and status comment carry on through a recovery: they belong to the run, not to
one attempt. In progress, a replayed call counts as `replayed`, and an interrupted or not started one as
`interrupted`.

The record of an attempt whose worker died (`recovery-enqueued`, written when the stall is noticed) takes its start
time and its progress counts from the run's progress key, as it stood when the worker died, when that key was written
after the job was queued. With progress off, the key gone, or a key an earlier attempt left (a recovery that died
before writing its own), its `startedAt` is empty rather than the time the queue noticed the stall.

On the console, the page of an attempt that was continued shows that attempt's own progress and a link to the
recovery job ("This run continues as ..."); the recovery's page shows the run's live progress.
