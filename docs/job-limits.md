# Job limits

A regular job has no time ceiling by default while it keeps doing work, including a tool that runs for hours without
another AI step. It stops after 15 minutes of inactivity. An operator can explicitly set a stall limit or time ceiling;
Watch jobs retain their separate 30-minute ceiling.

Money is bounded separately, as before: the turn limit (`PI_MAX_TURNS`, `run.maxTurns`) and the cost caps
(`PI_MAX_COST_USD`, `run.maxCostUsd`) end a job that spends too much, whatever its limits below say. A job is warned
before the turn limit, the cost cap and a time ceiling stop it ([warnings before the limits](#warnings-before-the-limits)).

## The three limits

| Limit | Stops a job when | Default | Deployment setting | Trigger field |
|---|---|---|---|---|
| idle | nothing happened for this many minutes | 15 | `PI_JOB_IDLE_MINUTES` (1 to 1440) | `run.idleTimeoutMinutes` |
| stalled | the AI took no step for this many minutes, however busy the container was | off (0) | `PI_JOB_STALL_MINUTES` (0 turns it off) | `run.stallTimeoutMinutes` |
| max-minutes | the job has run this long, whatever it was doing | none | `PI_JOB_MAX_MINUTES` | `run.maxMinutes` |

A trigger's idle and stall limits replace the deployment's for its jobs, longer or shorter. Its `run.maxMinutes` can
only lower the deployment's ceiling: when both are set, the smaller wins. Every value is a whole number of minutes.

A job stopped by a limit is not retried. Its run record names the limit (`idle`, `stalled` or `max-minutes`), and the
trigger's issue or pull request gets one comment saying so ([reasons](reasons.md)).

## What counts as something happening

Two kinds of progress, because "the AI is working" and "something the AI waits on is working" are different questions.

A **step** is the AI itself moving: a reply from the model (while it streams, too), a tool call starting or ending,
and a call by a subagent or a child pi process the job started.

**Activity** is anything the AI may be waiting on:

- output from a running tool, such as a test suite printing its progress;
- CPU used in the container by any process other than pi-dispatch's own runner, such as a build started in the
  background that the AI waits on with `sleep`;
- network traffic in the container, such as `gh run watch` polling a remote CI.

The idle limit needs neither a step nor activity for its whole length. An explicitly configured stall limit needs no
step for its whole length, however busy the container is. It can bound an endless loop, but it can also end a long build,
so it is off by default. Continuing CPU use, network traffic or tool output keeps a regular job alive without a step.

Two things pause the clocks. pi's own wait before it retries a model call does not count, and neither does a moment the
container was paused (a checkpoint of a durable run, [durable runs](durable-runs.md)).

Waits that happen before a container exists never count against a limit: a job held by `run.waitFor`
([wait for](wait-for.md)), a run parked on a question, and an approval gate start a fresh container when they resume.

## Waiting on slow work

The job's rules tell the AI to wait on slow work with a command that prints as it goes. A loop that prints a line every
minute while it waits is activity. One `sleep 3600` with nothing running behind it is not, and the job is stopped at the
idle limit with `idle`.

When a known step of a flow really is silent for longer (a large image build with no output, say), raise that trigger's
`run.idleTimeoutMinutes` rather than the deployment's.

## How it is enforced

The job's runner watches the job from inside the container, where it sees pi's events and the container's CPU and
network, and stops the job itself the moment a limit is reached. It writes two counters for the worker as it goes
(`activity.json` beside the session file, or a signed record on the stderr transcript of a venue that copies the job's
files). The worker reads them every 15 seconds and stops the container itself two minutes after the runner should have,
which only happens when the runner is stuck too badly to stop its own job.

`max-minutes` is the worker's own timer, from the moment the job took its slot. The job's runner is told the
ceiling's length and what was left of it, for the warning at 70% ([warnings before the limits](#warnings-before-the-limits)),
but only the timer stops the job.

### When the runtime does not answer

A limit stops a job by asking its runtime to stop the container (`docker stop -t 5`). A runtime that stopped answering
(a wedged Docker daemon, a paused VM) answers neither that nor the `docker run` that was starting the container, which
then never returns. The worker does not wait on it:

- 10 seconds after the stop, the worker kills its own `docker run` command and logs `run_client_killed`. That ends the
  job inside the worker: its credential renewals, its activity checks and its live transcript stop, and the job is
  recorded and leaves the queue's active jobs. The stop itself is given 10 seconds too, and then killed.
- The run is recorded as `container-never-started`, with nothing charged, when all of these hold: the job image watches
  the job's activity (`idleWatch`, which writes its first line before its first call to a model), the container wrote
  nothing, a time limit stopped it (not a cancel or a shutdown), nobody asked to cancel the job meanwhile, the worker
  was not shutting down, and the worker has a host budget and counts itself the only host that can pick the job up
  again: the job is on this host's own queue, or the worker declares no fleet (no `PI_WORKER_NAME`). Several workers
  draining the shared queue with no `PI_WORKER_NAME` are an undeclared fleet, which `pi-dispatch doctor` already warns
  about ("host routing is OFF here"); each of them counts itself the only host, so give every worker its name.
- A job with attempts left then runs again: a forge job, or a folder run started with `pi-dispatch run <folder>`. A
  scheduled cron run has none, and neither has a trigger run started by hand (`pi-dispatch run --trigger`, or the
  console's run of a trigger), which takes the schedule's options: it ends there, and the trigger's next run waits as
  below. Any other such stop is recorded as the limit that stopped it, as always.
- The container may still be started once the runtime answers again, so the worker keeps its room on the host (its
  memory, its CPU and one job slot) as an orphan (`host_budget_orphan` with `killedClient`). The first time the runtime
  answers, the worker removes the container by its exact name, whatever its state, through the job's own runtime. Until
  then the job's next attempt and every other job on that folder wait (`running-here` or `workspace-orphan`).

What to do: restart the runtime (or its VM). The worker removes the leftover container within a minute of the runtime
answering, and the waiting jobs run. Nothing needs to be cleaned up by hand.

## When the 30-minute limit still applies

A job keeps a fixed 30-minute limit when nothing else can bound it, and its run record says why (`limits.basis` is
`wall-clock`, `limits.why` names the cause):

- `image`: the job image does not declare the `idleWatch` capability. A derived image built on a base from before
  5.3.0 lacks it until it is rebuilt ([job image](job-image.md)).
- `subscription` or `forge-token`: the job holds a credential that expires while it runs (below), and it cannot be
  renewed here: the job image does not declare `credentialRefresh`, or the venue copies the job's files instead of
  binding them (`openshell`).
- a venue with no channel for the counters (a copying venue whose image cannot sign its transcript, for example):
  `limits.unavailable` names it.

The idle and stall limits still apply to such a job: it is stopped sooner when it stops working.

## Credentials that expire while a job runs

Two credentials a job is handed do not last as long as a job may now run:

- a GitHub token from a GitHub App (`GITHUB_AUTH_SOURCE=app`) lives one hour;
- a model sign-in through a subscription ([subscription auth](subscription-auth.md)) is handed to the job with a
  lease ending at most 30 minutes ahead, possibly sooner to fit the current token's remaining life.

The worker renews both while the job runs: a new App token, for the same one repository, 15 minutes before the old one
runs out, and a subscription lease reconsidered 10 minutes before its deadline. For a subscription on `local` or
`podman`, the image must declare `subscriptionLease`, `idleWatch` and `credentialRefresh` to use a shorter lease:
the worker requests 30 minutes ahead, capped to end more than 60 seconds before the access token expires. More than
four minutes of lease must remain when the job starts. The host may extend the lease with the existing token,
then rotates it only once the provider permits renewal. An older image keeps the full deadline plus six-minute
coverage requirement; rebuild derived images on the updated base to use short leases.

Each new value is dropped in a folder beside the job's folder, mounted read-only in the job. The runner applies it:
`git`, `gh` and every other command started afterwards get the new token, and the next model call uses the new
sign-in. The host registers replacement values for literal redaction before publishing them.

A renewal that fails is tried again every minute while there is time. A provider's future refresh instant is an
expected wait and does not produce `credential_renew_failed`. If a forge token, or the subscription's last published
lease, is two minutes from its end with nothing newer published, the worker stops the job as `credential-expired`.
It checks that deadline independently of pending renewal calls, so one hung provider cannot prevent the stop.
The worker log has `credential_renew_failed` lines saying which kind actually failed. A local subscription lease
does not shorten the token's provider-side expiry.

Two things keep the old token: a process the job started before the renewal (a server left running in the background),
and the forge's own MCP server ([MCP](mcp.md)), which reads its token when it starts. After the token's hour such a
process's GitHub calls fail, while new commands keep working.

## Warnings before the limits

A job that reaches its cost cap, its turn limit or its time limit is stopped, and what it had not pushed or reported by
then is lost. So a job is told once, when it reaches 70% of each of those limits, to write its report now and, if its
flow pushes, to commit and push its work, and to start no new parallel work. Each message is a fixed sentence naming
its limit, the same for every job. The rules listed under the cost cap, all but what counts, apply to each of them.

**The cost cap**: a job with a cost cap above 0 is told when what it has spent reaches 70% of the cap.

- **What counts** is what the cap has charged for calls that finished, the job's and its pi child processes'
  ([what the cap charges](costs.md#what-the-cap-charges)). What calls still running hold does not count: it is the most
  they could cost, and they usually finish far below it.
- **When it arrives**: at the end of the AI's next step that ran tools, before its next model call, so it costs no call
  of its own. It is not sent after a step with no tool calls (the AI is finishing), nor to a run parked on a question or
  an approval, nor to a subagent's session.
- **It waits for a clear queue**: while a steer for the AI is queued (a message to the run), it waits for the next
  step's end, so it does not arrive after a later step's tool results, such as a question or an approval request. A
  queued follow-up does not hold it back, and after three steps held in a row it is sent anyway.
- **The record** says whether it was queued for the AI: `tokens.costWarned` is 1 or 0 on a capped run, and the run page
  shows it. 1 means it was handed over; a run stopped right after that step's end never read it.
- **A jump** from under 70% to a refusal within one step gets no warning: what has been spent is read at step ends.
- **A resumed or recovered run** reads an earlier attempt's warning in its transcript, though its own cap starts afresh,
  and can be warned again at its own 70%.

**The subscription allowance** (`run.maxSubscriptionUsd`, issue #1008) has the same warning, with its own fixed
sentence: a job with an allowance above 0 is told once, when the settled list price of its subscription calls reaches 70%
of it, the same advice, under the same rules. What counts is the run record's `tokens.costNotional`, the calls that
finished; a subscription call whose cost could not be read warns nothing, since the next subscription call is refused
anyway. The record's `costWarned` stays the cap's ([a subscription allowance](triggers.md#a-subscription-allowance-per-job)).

**The turn limit** (`PI_MAX_TURNS`, `run.maxTurns`): every job has one, so every job is told when it has used 70% of
its turns, counted as the limit counts them (pi's own retries of a step that made no progress do not count). The
default of 30 warns at the end of step 21 and leaves nine. A limit of 1 or 2 warns at the end of the last step it allows,
so the AI may never read it. The record's `tokens.turnsWarned` is 1 or 0.

**The time limit** (`max-minutes`: `PI_JOB_MAX_MINUTES`, `run.maxMinutes`): a job with a ceiling is told when 70% of it
has passed, counted from the moment the job took its slot, as the ceiling is. The worker tells the job's runner the
ceiling's length and how much of it was left when it built the container's environment, and the runner adds what its
own clock has seen since; no clock time crosses into the container, so a container whose clock is wrong warns at the
right time. The container's own start is not counted, so the warning comes that many seconds late. Time is read at
step ends, so one long tool run can take a job past 70% and past the ceiling with no warning. The 30-minute limit
([below](#when-the-30-minute-limit-still-applies)) has no warning, and an older job image sends none. The record's
`tokens.timeWarned` is 1 or 0 on a run with a ceiling.

A warning is not a stop: the cap still stops the job when the next call could pass it, the turn limit at the start of
the step past it, and the worker's timer at the ceiling. The idle and stall limits have no warning: a job that is idle or
stalled is taking no steps, so there is no step end to tell it at.

## What the run record says

Every job that took a slot carries `limits` in its record: the three limits it ran under, `basis` (`activity` or
`wall-clock`), `why` and `unavailable` when they apply, and from the worker's backstop the last step and the last
activity it saw. Its `tokens` say whether the warnings were queued: `turnsWarned`, and `timeWarned` on a run with a
ceiling; the run page shows them as Turn warning and Time warning. ([`INT-RUN-HISTORY-FILE-CONTRACT`](../specs/interfaces.md))

## Claims and cleanup follow the job

A job running in a limited scope (a project's `concurrent`, a model endpoint's `slots`) holds a fleet-wide claim. The
worker renews each claim every 5 minutes while the job runs, so a long job never loses its claim and a worker that died
gives it up within 35 minutes.

At start, the worker removes job folders a crashed worker left behind. A folder counts as left behind only when its
activity counters and the folder itself have been still for longer than the idle limit plus the backstop's grace, and
never less than 35 minutes.

## Watch jobs

A watch's decision and investigation jobs keep a 30-minute ceiling of their own ([watch](watch.md)): each is a fresh,
bounded job by design.
