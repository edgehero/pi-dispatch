# Job limits

A running job is stopped when it stops doing anything, never because it is old. A job that keeps working for eight
hours runs for eight hours. A job that hangs is stopped within minutes.

Money is bounded separately, as before: the turn limit (`PI_MAX_TURNS`, `run.maxTurns`) and the cost caps
(`PI_MAX_COST_USD`, `run.maxCostUsd`) end a job that spends too much, whatever its limits below say.

## The three limits

| Limit | Stops a job when | Default | Deployment setting | Trigger field |
|---|---|---|---|---|
| idle | nothing happened for this many minutes | 15 | `PI_JOB_IDLE_MINUTES` (1 to 1440) | `run.idleTimeoutMinutes` |
| stalled | the AI took no step for this many minutes, however busy the container was | 240 | `PI_JOB_STALL_MINUTES` (0 turns it off) | `run.stallTimeoutMinutes` |
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

The idle limit needs neither a step nor activity for its whole length. The stall limit needs no step for its whole
length, however busy the container is: a test stuck in an endless loop keeps the CPU busy for ever, and the stall limit
is what ends it.

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

`max-minutes` is the worker's own timer, from the moment the job took its slot.

## When the 30-minute limit still applies

A job keeps a fixed 30-minute limit when nothing else can bound it, and its run record says why (`limits.basis` is
`wall-clock`, `limits.why` names the cause):

- `image`: the job image does not declare the `idleWatch` capability. A derived image built on a base from before
  5.3.0 lacks it until it is rebuilt ([job image](job-image.md)).
- `subscription`: the job calls a model through a subscription sign-in, whose credential is handed to the job for 30
  minutes ([subscription auth](subscription-auth.md)).
- `forge-token`: the job's GitHub token comes from a GitHub App, and an App's token lives one hour.
- a venue with no channel for the counters (a copying venue whose image cannot sign its transcript, for example):
  `limits.unavailable` names it.

The idle and stall limits still apply to such a job: it is stopped sooner when it stops working.

## What the run record says

Every job that took a slot carries `limits` in its record: the three limits it ran under, `basis` (`activity` or
`wall-clock`), `why` and `unavailable` when they apply, and from the worker's backstop the last step and the last
activity it saw. ([`INT-RUN-HISTORY-FILE-CONTRACT`](../specs/interfaces.md))

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
