# Triggers: the full reference

For an operator-reviewed next-attempt model fallback list, see [Model failover](model-failover.md).

This page is the detail behind the [Triggers](../README.md#triggers) section of the README. A trigger is
one entry in `triggers.json`. It says what starts a job and what that job runs.

```jsonc
{ "triggers": [
  { "on": { "type": "cron", "id": "nightly", "pattern": "0 3 * * *" },
    "run": { "kind": "local", "folder": "/srv/site", "flow": "tidy", "task": "run the nightly tidy" } },
  { "on": { "type": "label", "any": ["pi:frontend"] },              "run": { "kind": "github", "flow": "frontend-fix" } },
  { "on": { "type": "comment", "phrase": "@pi" },                   "run": { "kind": "github", "flow": "fix" } },
  { "on": { "type": "pull_request", "action": ["labeled"], "any": ["pi:review"] }, "run": { "kind": "github", "flow": "review" } },
  { "on": { "type": "label", "any": ["pi:fix"] },                   "run": { "kind": "gitlab", "flow": "fix" } }
] }
```

Watch is the additional collector trigger, configured by hand with `watchSources` and `on.type: "watch"`.
Its signed finding schema, limits, read-only investigation and issue modes are described in [Watch findings](watch.md);
optional shadow/active decisions and board proposals are in [Watch decisions](watch-decisions.md).
The forge and cron reference below keeps their existing behavior.

## Editing and firing from the console

The [Configuration page](console.md#configuration-and-trigger-pages) has Edit and Delete on each row,
a page per trigger and a structured add editor. Human row labels count from 1; tool indexes remain zero-based.
The add editor and its JSON fallback write the add tool's entry, including `run.secretBundle: false`.

A trigger's page has two editors, and no key has both:

- **What its jobs get** changes `flow`, `provider`, `model`, `maxCostUsd`, `maxSubscriptionUsd`, `models`, `fallbackModels`, `modelSelection`, `mcp`, `packages`,
  `excludeTools`, `excludeExtensions` and `excludeExtensionTools`, with one preview that says each change in words and one Confirm. Only a person can use this form, and no `dispatch_*` tool
  reaches it. Of those fields, `dispatch_trigger_edit` can still set the first three, and no `dispatch_*` tool can set the other ten
  ([what a trigger's jobs get](console.md#what-a-triggers-jobs-get)).
- **Edit** changes the venue (`backend`), `maxTurns`, `progress`, `statusComment`, `steer` and `recover`. Cron cannot enable
  statusComment or recover.

`dispatch_trigger_edit` takes flow, venue, provider, model, `maxTurns` and those four flags, behind a confirm, except that a headless
call with the process's write grant can turn an existing flag off unattended. Omitted fields
keep their existing values; unrelated hand-written bounds are preserved. Everything else in a trigger, such as `image`, `secrets`
and `skillsDir`, changes in the file.

**Editing the file stays the same.** Every field can still be written by hand, and the same parser reads the file whoever wrote
it. An edit of this trigger's entry made after the page drew it refuses the preview, and any edit of the file made after a preview
refuses its Confirm.

**On a fleet where each host keeps its own file**, the page writes this host's file and no other. "A host with its own copy of this
file keeps what it has until that copy changes." So make the same change on each, and while the copies differ on a schedule, no
host installs a change to one ([multi-host](multi-host.md#2-divergent-triggers-files-freeze-cron-rather-than-fighting-over-it)).

Fire now and `dispatch_trigger_fire(index)` start a served cron schedule after a person's confirmation.
They apply the folder allowlist, clean-tree check, committed flow opt-in and hourly attempt count of
`dispatch_run`, refuse command and portfolio triggers, and refuse a duplicate in the same minute.
These extra gates do not change ordinary scheduled ticks or the CLI's `run --trigger` behavior.

## Reading and checking rules in the browser

The [Triggers page](console.md#the-rules-page-and-event-checker) groups rules by schedule and forge,
with their selectors, option chips, latest outcomes, retained run counts and metered spend. The schedule
view plots UTC instants using each worker's published timezone; it says when a projection or history is
unknown. Forge/repository quiet windows do not hold local cron runs, while folder/global windows can.

The event checker is a hypothetical read available to viewers too. It uses the receiver's actual filters
and explains first-wins precedence, comment flow overrides, spent rules and special steering/parked routes.
Entered permissions are assumptions. The check verifies no delivery signature, makes no forge request,
starts no job and reserves no money. It saves and logs no comment text. Normal receiver and worker gates
remain authoritative when an event arrives.

The JSON checker accepts `closeActor` for a GitHub closed issue or PR, using an exact lowercase login
such as `reconciliation-app[bot]`, to test a local `on.closeActors` grant. The browser form does not
supply that login; its result says when the grant could not be tested. Entered identity and permission
remain hypothetical and cannot authorize a real job.

## Trigger types: what fires each one, and what it runs

pi-dispatch is the trigger layer. Every entry is one `{ on, run }` pair: **`on` is what fires it**, and
**`run` is what it runs**, either a flow or a registered command (`flow` names a `.pi/skills/<flow>` in
the target repo: see [Flows](../README.md#flows-the-custom-prompt-a-trigger-runs) for what that file is, and
[Multi-stage workflows](#multi-stage-workflows-and-third-party-pi-extensions) for chaining skills or
staging a workflow extension).

| `on.type` | Fires on | Required in `on` | What narrows it | What the agent gets as its task |
|---|---|---|---|---|
| `cron` | your schedule | `id` (unique, letters, digits, `.`, `_` and `-`, at most 176 characters) · `pattern` (5 or 6 cron fields) | nothing: a schedule is its own condition | `run.task`, written in the file |
| `label` | a label on an **issue** (or an Azure work item), never a pull request | at least one positive selector, `any` or `all` | the label **predicate**: `any` (any of these) · `all` (all of them) · `none` (suppress-only, it can prevent a fire but never cause one) | the issue title and body |
| `comment` | a comment containing your phrase | `phrase`, for example `@pi` | the phrase, and **one comment trigger per forge** | the comment body plus the issue title and body |
| `pull_request` | a PR or MR event, including a submitted GitHub review, and including its close (the close word rides **alone**, never mixed with other actions; on GitHub and Forgejo a merged PR counts as closed, on GitLab only an explicit close fires it) | `action`, a non-empty array in your forge's own words | `action`, plus the same label predicate; where the forge has a label action and you name it, a positive selector becomes **required**; on a GitHub review, also `reviewState`; on a close-only rule, `number` and `once` instead of the predicate | the PR title and body, plus the review body when a review fired it |
| `issue` | an issue closing, and only that (labels have `label`, phrases have `comment`) | `action`, the close word in your forge's own words | `number` pins it to one issue (on GitLab, the iid); `once: true` makes it a one-shot and requires `number` | the issue title and body |

One variation changes that last column for every type. A trigger that names `run.command` instead of
`run.flow` gives the agent exactly `/command args` as its whole prompt. For a forge job, the issue, comment or PR text
waits in `/job/event.json` for the command's handler to read. An event-started local command receives no event text (see
[Multi-stage workflows](#multi-stage-workflows-and-third-party-pi-extensions)).

Every type also needs `run.kind` (`local` for cron, or the forge for a forge job). A forge event can instead
start a local command using the additional fields below. You must pick exactly one of
`run.flow` or `run.command` (naming both, or neither, refuses to load in both services). Cron additionally
needs `folder` (a host path the worker checks exists when it loads the file; make it absolute, since a
relative path resolves against the worker's own directory) and, with `flow`, a `task`. Azure `label` and
`comment` forge jobs need `run.repository`, because a work item belongs to a project and names no repository.
The webhook types also charset check `run.flow` at load (skill names are lowercase). A flow that could
never name a repo skill is refused when the file loads, at no cost, instead of failing inside a paid
container. A cron `id` longer than 176 characters refuses the file too: each run its schedule starts is the job
`repeat:<id>:<time>`, and the console and the panel read a job id of at most 200 characters, so a longer one would
run with nothing able to name its runs. Earlier releases took an id of any length: the console and the panel still
name a schedule whose id is up to 200 characters long, so you can find one an earlier release made and remove it,
and a run record is read whatever its id's length.

Two matching behaviours to know before you turn on a paid trigger:

- **A comment can choose the flow.** `<phrase> <flow>` in the comment body overrides the trigger's
  `run.flow` whenever that word matches another forge trigger's flow in the same file (a schedule's, a watch
  rule's or a local event listener's flow does not count). So `run.flow` is a
  default rather than a fixed pairing. On a rule that names `run.command` this channel is inert. Trailing
  words never retarget or suppress the command. They reach a forge job only as data in `/job/event.json`,
  and never reach a local event command.
- **Label triggers match differently per forge.** GitHub and Forgejo match the issue's **whole current
  label set**. Reopening an already-labelled issue, or adding an unrelated label to one, fires
  again. GitLab and Azure match only the labels **that event added**. This is exactly why they do not
  re-fire that way.

`action` words are each forge's own vocabulary. They are validated at load so a word from the wrong forge is
refused rather than silently never matching:

| `run.kind` | `pull_request` actions | Its label action | Notes |
|---|---|---|---|
| `github` | `labeled` `opened` `synchronize` `reopened` `review_submitted` `closed` | `labeled` | `review_submitted` is the `pull_request_review` event's `submitted` action. A formal Approve or Request changes starts a job. It is gated on the **reviewer's** permission, never the PR author's. A collaborator reviewing a stranger's fork PR runs and a stranger reviewing their own PR does not |
| `gitlab` | `open` `update` `reopen` `approved` `close` | none | a label add arrives as `update` carrying a label diff. A predicate here matches the labels that update added. `approved` is one verdict where GitHub's `review_submitted` is every verdict |
| `forgejo` | `label_updated` `opened` `synchronized` `reopened` `closed` | `label_updated` | `label_cleared` fires nothing, ever. Removing a label must never start a paid run |
| `azure` | `created` `updated` | none | a label predicate on an Azure PR is refused at load. Azure tags work items, never pull requests. A close trigger (`issue`, or a close-only `pull_request` rule) is refused at load too. It is not yet covered, because a work item's close is a state transition the payload subset cannot see |

**A review trigger is wider than it looks, so narrow it.** `review_submitted` fires on every submitted
review: an Approve, a Request changes, and a one-word "lgtm thanks" alike. Unlike a comment trigger there
is no phrase in the way and unlike a label trigger there is no label. Arming it means anyone with write
access starts a paid run by reviewing. Add `reviewState` (GitHub only, and only beside `review_submitted`)
to pick the verdicts worth paying for:

```jsonc
{ "on": { "type": "pull_request", "action": ["review_submitted"], "reviewState": ["changes_requested"] },
  "run": { "kind": "github", "flow": "address-review" } }
```

The AI tool `dispatch_trigger_add` sets `reviewState` too, behind the operator's confirm, and the write checks it like
the file's own (GitHub only, beside `review_submitted`, a non-empty list of `approved`, `changes_requested` and
`commented`). **Upgrading:** before this release the tool's description offered `reviewState` but the tool dropped it
without a word, so a review trigger added that way fired on every verdict. Check the review triggers you added with
the tool, and add the narrowing by hand, or add them again.

Two behaviours to know before you turn it on. A **Comment** type review whose remarks are all line comments
and whose summary box is empty starts nothing. Those remarks arrive on an event this service
does not read, so the review reaches us empty. Approve and Request changes still fire with an empty summary,
since there the verdict is the signal. The bot loop guard knows only **our own** identity. Another
bot that reviews (a CI bot, a review service) can start jobs if it holds write access.
[`SECURITY.md`](../SECURITY.md)
states both, and the flow gets `review.id` in `/job/event.json` so it can fetch the line comments itself.

**The source forge's permission rules still apply.** Your forge decides those permissions, differently per forge.
[`SECURITY.md`](../SECURITY.md) states each one plainly (short version: on GitHub only collaborators can
apply a label, which is why the label *is* the approval there; GitLab, Forgejo and Azure resolve the
actor's permission through their APIs because a label proves less on those). The always-on gates that
every delivery passes are the signature check, the bot-loop guard, that permission check, dedup, quiet
hours, the applicable image and branch-protection preflights, and the spend caps. The explicit local-review
allowlist below is the one additional actor authorization; it does not change ordinary forge jobs.

## A forge event running a local command

A label, comment, pull-request event or supported close event can wake a command in an operator-owned folder.
This uses the same registered pi extension command as a cron trigger. It still runs inside a job container;
`run.command` is not a shell command. A handler can do its work without calling a model, but command jobs retain
their normal model/provider configuration, image checks and spend controls. This setting does not guarantee zero spend.

```json
{
  "version": 5,
  "triggers": [
    {
      "on": {
        "type": "pull_request",
        "forge": "github",
        "id": "pr-sweep",
        "action": ["review_submitted", "synchronize", "labeled"],
        "any": ["ready"],
        "debounceSeconds": 10,
        "reviewAuthors": ["review-app[bot]"]
      },
      "run": {
        "kind": "local",
        "worker": "runner-a",
        "folder": "/srv/automation",
        "command": "sweep"
      }
    }
  ]
}
```

Set `PI_WORKER_NAME=runner-a` on that worker. The source is `on.forge`; `run.kind` describes the local execution.
`on.id` is a stable, unique local-event id, at most 64 letters, digits, dots, underscores or dashes, starting with
a letter or digit. The folder, command and its arguments come entirely from this reviewed file. The command
receives no source title, body, comment, review, labels, actor, branch, repository or item number, even in
`/job/event.json`. That file identifies the configured local trigger; the command reads any current forge state
it needs itself. A burst can cover several repositories, so there is no misleading "last event" target.

`on.debounceSeconds` is an integer from 0 to 300, default 10. Matching events postpone the pending run until the
quiet interval ends, capped at five minutes from the first event so continuous activity cannot postpone it forever.
Five events in that interval produce one run. Once execution starts, further events produce at most one successor;
it becomes eligible after the first run finishes and its own quiet interval has elapsed. Pauses, unavailable workers,
folder contention and spend controls can delay either run further. The five-minute limit is a debounce limit,
not a promise that a worker will be available then.

Coalescing is per trigger, across its source repositories and item numbers. Different triggers pointing at the same
folder and command can cause separate sequential runs. They do not run in that folder concurrently. Give a paired
cron trigger the same `run.worker` and `run.folder`; cron without `run.worker` keeps its existing folder-based placement.
Every matching local listener is considered independently, alongside the existing first matching forge rule.
Several local comment listeners can therefore coexist with the forge's one comment rule. Close-only action lists
remain separate from other pull-request actions.

For a GitHub `review_submitted` local command, `on.reviewAuthors` adds 1 to 32 distinct, exact lowercase GitHub
logins, including App names ending in `[bot]`. The reviewer's login is compared without case; no wildcard or display
name matches. A listed reviewer may wake this command even when their association is `NONE`. The ordinary
collaborator gate still works, and the deployment's own identity is always refused. `reviewState`, label predicates
and the empty Comment-review rule still apply. Other event types and forge jobs cannot use this exception.

For a GitHub local command on `issue` or `pull_request` with `"action": ["closed"]`, `on.closeActors`
adds the same bounded list of exact lowercase logins to the closer-permission gate. For example,
`"closeActors": ["reconciliation-app[bot]"]` lets that App wake the command when it closes or merges an
item, even if GitHub's collaborator API reports its permission as `none`. The authenticated sender's
login is compared without case. Unlisted actors still need ordinary write permission; the self guard
and any configured item number still apply. The grant cannot authorize a forge job, and a merged flag
alone grants nothing. Only name actors whose close events should execute this reviewed command under
its existing credentials and budget. Upgrade all workers, receivers and consoles before adding this
version-10 field. Removing or changing the list invalidates its pending command definition.

The receiver reports `accepted` once the signal is durable, with accepted and coalesced counts. It does not claim
a container has started or a queue job already exists. A store failure returns 503; polling leaves its cursor before
the failed signal. Duplicate deliveries do not reset the quiet interval, and restarts preserve pending work.
The worker checks the current trigger definition before execution, so a queued signal cannot silently use a changed
command or destination. A fresh matching delivery replaces an unclaimed generation whose definition or worker
changed, or whose cancellation was recorded. It gets a new generation; an old queue entry refuses before spend.
An active generation keeps its ownership, with at most one successor. Production admission and state transitions
use Valkey's clock, so different machine clocks do not reset the quiet interval. Upgrade every reader before using
the version-5 local event fields or version-10 `closeActors`; see [Upgrading](upgrading.md).

Cancelling a local event generation clears the successor present when cancellation is accepted. A later new
delivery remains eligible. If cancellation times out, the CLI, panel and console say that cancellation may have
been stored and pending signals cleared: no acknowledgment is not proof that nothing changed. Check both the
trigger and run before cancelling again. If queue removal was not confirmed, retry cancellation to remove or stop
that job; the repeated cancellation cannot clear signals accepted after its first successful write.

### Recovering a blocked local event

A finished local event generation cannot be retried by hand. Send a fresh matching event or use a reviewed cron
fallback. Removing its failed queue entry first settles the signal, then removes the entry, so a waiting successor
is not stranded. If either operation is uncertain, the console reports a partial outcome and whether the successor
may already be ready; inspect the trigger before repeating the action.

`queue-job-missing` means a generation was active but its BullMQ entry disappeared. The worker cannot establish
whether its container is still running, so it preserves the block. It does not start that generation again.

First pause the deployment from its deployment folder with `pi-dispatch pause` (or pause the named worker's queue
in the console). A pause stops new pickups; it does not stop a running container. Keep it paused throughout recovery.
Inspect the blocked job using the read-only command below, then use the named worker's actual container runtime
and socket to locate any container for that job and folder. Positively establish that it has stopped and is gone.
An empty queue, a missing worker heartbeat or an unacknowledged cancel is insufficient. If the runtime is unavailable
or its ownership is uncertain, leave the generation blocked.

Save this as `local-event-recovery.mjs` in the deployment folder. Set the identity to the configured trigger. It
loads the installed worker's exported APIs and uses the same deployment Valkey settings as the CLI; it prints no
execution configuration or credentials.

```js
import { createRequire } from "node:module";
import { resolve } from "node:path";

const identity = { forge: "github", id: "pr-sweep" };
const mode = process.argv[2];
const expectedJobId = process.argv[3];
if (!process.env.DISPATCH_MODULES || !["inspect", "finish"].includes(mode)) {
  throw new Error("Set DISPATCH_MODULES and choose inspect or finish.");
}
const require = createRequire(resolve(process.env.DISPATCH_MODULES, "@edgehero/pi-dispatch/package.json"));
const { makeRedisClient, cliValkeyUrl } = await import(require.resolve("@edgehero/pi-dispatch/connection"));
const { makeLocalEventStore } = await import(require.resolve("@edgehero/pi-dispatch/local-event-store"));
const { localEventJobId } = await import(require.resolve("@edgehero/pi-dispatch/local-event"));
const redis = makeRedisClient(cliValkeyUrl(process.env), {
  failFast: true, lazyConnect: true, commandTimeoutMs: 5000, disconnectTimeoutMs: 0,
});
redis.on("error", () => {});
try {
  await redis.connect();
  const store = makeLocalEventStore({ redis });
  const state = await store.read(identity);
  const current = state?.current;
  const jobId = current ? localEventJobId(current.generation) : null;
  if (mode === "inspect") {
    console.log(JSON.stringify({ jobId, worker: current?.data.localEvent.worker ?? null,
      phase: current?.phase ?? null, blocked: current?.blocked ?? null }));
  } else if (!current || current.phase !== "active" || current.blocked !== "queue-job-missing"
      || expectedJobId !== jobId) {
    console.error("The inspected blocked active generation does not match; inspect again. Nothing changed.");
    process.exitCode = 1;
  } else {
    const result = await store.finish(current.data.localEvent, { owner: current.owner ?? "" });
    console.log(result.ok ? "Inspected generation retired; any successor is now eligible."
      : "Generation changed; inspect again. This retirement did not apply.");
    if (!result.ok) process.exitCode = 1;
  }
} catch {
  console.error(mode === "finish"
    ? "Retirement was not confirmed and may have completed. Inspect again before any further change."
    : "Inspection failed; no recovery was attempted.");
  process.exitCode = 1;
} finally {
  redis.disconnect();
}
```

For a global npm installation, inspect first:

```sh
DISPATCH_MODULES="$(npm root -g)" node ./local-event-recovery.mjs inspect
```

For a local npm installation, use that installation's absolute `node_modules` path instead. After proving the
reported job's container is gone, copy its complete job id into this separate mutation command:

```sh
DISPATCH_MODULES="$(npm root -g)" node ./local-event-recovery.mjs finish local-event-REPLACE_WITH_ID_FROM_INSPECT
```

The finish operation compares the generation atomically. It retires that blocked generation and promotes any
successor, preserving delivery receipts; it does not assert success or write a run record. Inspect again if the
command's answer is uncertain. Resume with `pi-dispatch resume` only when recovery is complete and the runtime is
known to be safe. Do not delete the state or receipt keys to recover: that loses execution and replay evidence.

## Keeping no sandbox for a local command

Every run keeps its job directory for `PI_SANDBOX_RETENTION_HOURS` (24 unless you change it), so that you can reopen
it with `pi-dispatch sandbox <job id>` ([sandboxes](sandbox.md)). A local command that runs every few minutes makes
hundreds of those a day that nobody opens, and the worker then has to delete them beside your jobs. A local command
trigger can say its runs keep none:

```json
{ "on": { "type": "cron", "id": "sync", "pattern": "*/5 * * * *" },
  "run": { "kind": "local", "folder": "/srv/app", "command": "sync", "retainSandbox": false } }
```

- **What it does.** When a run of this trigger ends, the worker removes the run's job directory where it would have
  kept it, and writes `sandbox_not_kept` with the job id to its log. That holds on every outcome: a run that
  completed, failed, timed out or was stopped keeps nothing. To look at a failing command, take the flag off, or set
  it to `true`, and let it run again. If the directory cannot be removed, the line is not written and the directory
  stays under `PI_JOBS_DIR`. Nothing removes it while the worker runs. The worker's next start does, with the job
  folders a crashed worker left behind ([job limits](job-limits.md#claims-and-cleanup-follow-the-job)): once the
  folder has been still for long enough, and only if it can be removed then (`job_dir_sweep_failed` in the log when
  it cannot, and it stays).
- **When to use it.** On a short local command that runs often and that you never reopen.
- **What you lose.** `pi-dispatch sandbox <job id>` has nothing to reopen for these runs, and says so. Nothing on
  the host tells such a run from one whose sandbox was swept, so the views name both: the panel (`/dispatch`) shows
  `sandbox  swept, or never kept` for the run, and the Sandbox section of the run's page in the console says its
  workspace was swept after its retention window, or never kept. The Workspace card on that page says "Workspace
  gone." What stays is everything that is not in that directory: the run's record and its page, the worker's log
  lines, the live transcript and progress for as long as they are kept, and any artifacts the run saved. Your folder
  is your own and is never touched either way.
- **Where it is allowed.** Only on a local command trigger: `"kind": "local"` with `"command"`, on a cron trigger
  or on [a forge event that starts a local command](#a-forge-event-running-a-local-command). The file refuses it
  everywhere else when it loads (a flow on a schedule, a forge job, a watch rule), because a kept sandbox is what
  lets those runs be reopened and continued. It is `true` or `false`; anything else, such as `"false"`, is refused.
  Absent and `true` both mean the default: kept.
- **Check that it took.** A key in the wrong place or misspelled (`retainSandbox` under `on` or beside `run`,
  `retainsandbox`, `retainSandboxes`) is ignored like any key the file does not know: the file loads,
  `pi-dispatch triggers check` says nothing, and the sandbox is kept. So look at the trigger's page for the line
  "Sandbox: not kept after a run".
- **When it is read.** When the run ends, by the worker that ran it, from its own triggers file (`PI_TRIGGERS_FILE`,
  else `./triggers.json` where it runs). So an edit takes effect for every run that ends after it, one that was
  already queued or running included. The worker sees an edit by the file's modification time and size: one that
  changes neither is not seen until a later edit does, or the worker restarts.
- **When in doubt the worker keeps the sandbox.** That is: the file cannot be read or does not load, the trigger is
  gone, or it changed after the job was queued in what the worker finds it by. That is the folder or command of a
  trigger on a schedule, and the id, forge, folder, command or worker of one a forge event starts. A trigger on a
  schedule whose `worker` changed is still the same trigger, and its flag is followed. A kept directory is swept at
  the end of its window, and a removed one cannot be brought back.
- **Which runs follow it.** The trigger's own: each scheduled or event-started run, every retry of one, and a run
  you fire by hand with `pi-dispatch run --trigger`. A job you queue with `pi-dispatch run <folder>` belongs to no
  trigger and is kept, and so is a job that a run chains through its outbox.
- **Versions.** It needs no `version` and does not raise the file's, and no receiver reads it. A worker from before
  this release that can read the file ignores the key and keeps the sandbox ([upgrading](upgrading.md)).
- **No tool can set it.** `dispatch_trigger_add` refuses a call that carries it and `dispatch_trigger_edit` leaves
  it as it is. The trigger's page shows "Sandbox: not kept after a run" and has no field for it. Write it in the
  file by hand.

## When another event starts a job

Ordinary forge jobs have two duplicate checks. Sending the same delivery again finds its original job while that job
is retained. Different deliveries for the same target and flow normally share a ten-minute window, so rapidly
removing and adding a label does not start several copies of the same work.

A job that finishes with a policy refusal or a cancellation releases that second window. Fix the cause, then send a
**new event**, such as removing and adding the label again: it can start a job immediately, without waiting ten
minutes. This applies to a refusal before the container starts, such as `secret-bundle-trigger-changed`, and to a job
you cancel after it starts. Wait until the worker records the cancellation; acceptance of the stop request alone
does not release the window. The new job still passes every permission, configuration and spend check. A refusal
before the container starts always says why on the item: its own comment, or, where it has none, the same words
[reasons.md](reasons.md) gives for its reason (issue #969). The label that started the job stays on: once the
cause is fixed, remove it and add it again to start a new job. On GitHub and Forgejo another label event on the item
(an unrelated label, a reopen) can also start one, as described under the label matching above. If the worker
logs `stop_did_not_take` or `run_client_killed`, inspect the runtime before starting more work: cancellation was
recorded, but the old container's exit could not be confirmed and its existing resource holds remain.

The receiver and poller also repair a window left by a completed policy job when they see the next event. A running
or waiting job keeps its normal window, as does an ordinary successful run. Sending the original delivery again
still finds its retained original job; releasing the window does not replay it. A parked run's answer and steering
keep their existing behavior ([sessions](sessions.md), [steering](steering.md)).

The window counts from the first request, also when its job has already finished. So removing and adding a label
again within ten minutes of a run that ended starts nothing. The item then gets a comment saying that no job was
started, which job took the same request, and at what time (UTC) the ten minutes end, so a person, or a tool watching
the item, can tell a dropped request from one that is still waiting (issue #932). A request that arrives while the
first job is still waiting or running gets no comment: that job is doing the work. The comment is posted by the worker
and recorded as `duplicate-request` in the runs list. It needs the workers at the release that carries it, or the
comment waits as `newer-release` until they are ([upgrading](upgrading.md#the-order)).

On the worker's host, `pi-dispatch status --target owner/repo#12` (or `group/project!7` for a GitLab merge request or
an Azure DevOps pull request) prints, as one JSON line, the jobs queued, held or running for that item and, for each
flow with an open window, the job holding it, when it closes, and what asking again would do: `joined` to a job that is
still going, or `dropped` against one that has ended. A tool on the same host can read it before asking again. A job
queued with no window (a notice, or the job a late reply resumes) is not found by its item, and `complete: false`
means part of the queue was not read, so an empty list then is not an all-clear.

**Upgrading:** move the workers and the receiver/poller to 5.3.2 or later (issue #899), following the
[upgrade order](upgrading.md#the-order). The [rollout note](upgrading.md#532-refused-and-cancelled-jobs)
explains which half of the fix each component supplies.

## Close triggers and one-shots

"When this closes, run that, once." An `issue` trigger fires when an issue closes. A PR close uses
`pull_request` with the close word as the only action in the rule. A close is gated on a different
actor than every other PR action, so the words never mix. On GitHub and Forgejo a merged PR emits
closed and fires the rule. GitLab reports a merge as its own action, which no rule takes, so only an
explicit close fires there. `number` narrows the rule to one item. `once: true` spends it after a
single run. `once` requires `number`, and never sits beside `run.replicas`:

```json
{ "on": { "type": "issue", "action": ["closed"], "number": 40, "once": true },
  "run": { "kind": "github", "flow": "deploy" } }
```

The gate is the closer's. The actor who closed the item must hold write access. On GitHub that is
resolved through the collaborator permission API, because the payload names only the author, and an
issue's own
author can close it with no access at all. On GitLab and Forgejo the existing member lookup already
checks the sender, who is the closer.

A GitHub local command can explicitly add named close actors as described under
[local event commands](#a-forge-event-running-a-local-command). That exception does not apply to the
ordinary forge jobs in these examples.

Spending is written into the file itself. After the run record exists, the worker adds
`"disarmed": { "at": ..., "jobId": ... }` to the entry's `on`. The entry is never deleted, because run
history refers to triggers by their position in the file. A spent entry still shows in the panel with a
spent marker while
matching nothing. Deleting `on.disarmed` re-arms it; nothing else is needed. A one-shot whose
run **failed** still counts as fired. The record is the definition, so a failed run spends it too. The
fix is that same one key deletion.
For a local event one-shot, an authority refusal whose reason starts with `local-event-` does not spend the
trigger: a stale or invalid queued generation must not disarm the current reviewed definition. An actual run's
ordinary terminal record keeps the existing spending rule.

Four deployment notes:

- Point both services at the **same** file (`PI_TRIGGERS_FILE`, absolute; `doctor` warns).
- In the shipped compose topology the receiver's read-only single file mount keeps serving the old
  bytes after a disarm until the container restarts. The worker's own check before any spend is what prevents
  a second run meanwhile.
- The polling transport carries closes too. The events feed includes them. A close trigger needs no
  public URL.
- A symlinked `triggers.json` is replaced by a real file on the first disarm. Keep the real file at
  the served path and symlink the other direction.

## The file's version

`triggers.json` may carry a top-level `version` (issue #761). Absent means `1`. You never need to write it: every
writer (the panel, the console and the trigger tools) writes it, first in the file, only when an entry uses a `run`
field, a top-level block or a value (a new `on.type`, a new `waitFor` condition, a new `run.kind`) that an older
release would misread (a field whose absence would let a job run wider than the file says, or a value it would refuse
as broken). `run.excludeExtensions` or `run.excludeExtensionTools` needs version 2; `idleTimeoutMinutes`,
`stallTimeoutMinutes` or `maxMinutes` needs version 3; `mayMerge` needs version 4; local event commands and
`run.worker` need version 5; `modelSelection` needs version 6; `privateEndpoints` needs version 7;
`secretFiles` and file bundles need version 8; `auxiliaryModels` needs version 9; local `on.closeActors`
needs version 10; `maxSubscriptionUsd` needs version 11; `weights` in a `modelSelection` pool, and `secrets`
or `secretsProfile` on an answer rule or on the `zeroTouch` section, need version 12. A file without a field or value
needing a newer version still needs only version 1. A
file that uses such a field or value with a lower `version`, or with none, is refused like any malformed file.

**A file written by a newer pi-dispatch** names the versions in its refusal ("triggers file written by a newer
pi-dispatch (version 3; this build understands 2)"):

- A worker or receiver refuses to start on it, as on any file that does not load.
- A running worker keeps its schedules and logs `triggers_reload_newer`, and from then on defers EVERY job, cron runs
  included, with "Queued or configured by a newer pi-dispatch: waits for this host's upgrade" (`newer-release`,
  re-checked every ten minutes), until it is upgraded or the file loads again. Its schedules are no longer what you
  wrote, and many checks read this file while a job runs.
- A job whose one-shot, `waitFor`, narrowing field, approval check, answer draft or question grouping reads such a
  file waits the same way, also on a worker that does not watch the file: a one-shot is never fired because this
  release could not read its disarm.
- The panel, the console and the trigger tools refuse to write over it ("nothing was written and nothing in it was
  lost; change it with that release"), and the console's lists show it as unreadable.
- The worker still spends a one-shot that ran: its disarm adds `on.disarmed` to the entry and keeps every other key of
  the file, `version` included, so a one-shot whose file turned newer while it ran is not fired again by the release
  that reads the file next. Like every write of this file, it writes the values back as JSON reads them: a number
  beyond 2^53 loses precision, `1e400` becomes `null`, `-0` becomes `0`, and keys named by an integer move to the
  front of their object.

Upgrade the hosts that refuse it; do not edit the `version` away, which would hide fields this release drops. The one
exception is a `version` you wrote yourself (below): no release wrote that file, so remove the key. `pi-dispatch
doctor` says so in its fix ("unless you added `version` to it yourself: then remove that key"). The services refuse a
file that is merely broken (bad JSON, a bad entry, `version` written twice). A panel or console write refuses one that
is not valid JSON, is not a JSON object, or has a `triggers` that is not a list, with nothing written, because it could
not keep what the file holds: fix the file, or move it aside to start from an empty one. Earlier releases rebuilt an
unparseable file from empty at the next panel write, which dropped every trigger in it. No reader, the console's triggers view included,
reads a `version` written twice as newer: the services refuse the file as broken, and the console's view calls it
broken when its last value reads newer and otherwise shows the file as it did before.

**Upgrading.** Earlier releases ignored a top-level `version` in this file; since issue #761 it is read. If you put one
there yourself, remove it before you upgrade: one that is not a whole number of 1 or more makes the file broken, so the
worker and the receiver refuse to start on it (a running worker keeps its schedules, and the next panel write drops
it), and one above what this release reads (2) is taken for a file a newer release wrote, so every job waits.

Every top-level key beside `triggers`, and every `run` key of an entry, including ones this release does not know, is
kept by every write of 5.0.0 or later. A `/dispatch` panel or worker from before it (4.3.1
included, which had no web console) or an earlier console build writes `triggers` alone, dropping `version` and every
other top-level block, `secretBundles` among them, so upgrade them first.

## Optional `run` fields

Most of these change what code runs or what it costs, so each is a deliberate edit to the file that neither the panel nor any
`dispatch_*` tool can set. `packages`, `excludeTools`, `excludeExtensions`, `excludeExtensionTools` and `mcp` can also be changed by a person on the
[trigger's page](console.md#what-a-triggers-jobs-get), which no tool reaches. `progress`, `statusComment`, `steer` and `recover` change
how a run is followed or picked up, and that page's Edit form and `dispatch_trigger_edit` take them too.

- `"command"` replaces `flow`. You can use exactly one of the two on any trigger type. The job runs a
  registered pi extension command headlessly, with no interactive session. The whole prompt is `/command
  args`. The arguments are fixed in the reviewed file. A forge job's event text reaches the handler only as
  `/job/event.json`, which it reads itself; a local event command receives none of it. A command is never AI-triggerable. Job chaining refuses any
  request that names one. `dispatch_run` cannot express one ([`docs/workflows.md`](workflows.md)). The
  job image must declare the `commands` capability. The shipped image does. A command job on an image
  that does not declare it is refused before it costs anything.

- `"image"` names the container image for that trigger's jobs. Without it, jobs use `PI_JOB_IMAGE`. The
  image decides what is in the box, never what the box can do: the worker sets the isolation flags itself
  ([`docs/job-image.md`](job-image.md)).

- `"packages": false` opts one trigger out of the staged third-party pi packages. This is also how a
  workflow extension is withheld from one flow ([`docs/workflows.md`](workflows.md)).

- `"excludeTools": ["bash", "powershell", "edit", "write"]` removes named built-in pi tools from that trigger's
  sessions. The session itself enforces this, not the prompt text. The excluded tools are gone from the
  tool registry. Nothing running inside the job can switch them back on. This only narrows tools. Only
  the pinned pi's built-ins can be excluded: `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`. A
  misspelled name is refused when the file loads. Pi would otherwise ignore it silently. The job image
  must declare the `excludeTools` capability. The shipped image does. A job carrying exclusions on an
  older image is refused before it costs anything. That image's runner would run the job with every tool
  you removed ([`docs/exclude-tools.md`](exclude-tools.md)).

- `"excludeExtensions": ["@acme/deploy-tools", "git-guard"]` leaves named extensions out of that trigger's jobs: a staged package by
  its manifest name, with its skills, prompts and themes, or an overlay extension by its file stem or folder name, before any of
  its code runs. `"excludeExtensionTools": ["deploy_preview"]` removes named tools an extension brings. Neither takes a watch rule.
  Either makes the file `"version": 2`, which a writer that reads that version stamps, and needs every host on a release that reads it
  ([what a fleet needs](upgrading.md#what-a-fleet-needs-before-a-trigger-leaves-something-out)). A name not on a host is no refusal there, and a tool name
  no staged package or overlay extension brought can stop a job before its prompt. Removing a tool does not stop its extension's code from running, and
  neither key stops what an agent that can write or edit files, or run commands, can reach ([what exclusion does not stop](exclude-tools.md#what-exclusion-does-not-stop)).

- `"mcp": ["docs", "files"]` names MCP servers from the overlay's `mcp.json` for that trigger's jobs to
  connect ([`docs/mcp.md`](mcp.md)). Names only: the servers themselves, and the credentials they take, are the
  operator's, in the overlay. A job that names a server it cannot use is refused before it costs anything: a name
  the overlay does not offer, a credential the job will not have (passed neither in `secrets` nor by
  `PI_FORWARD_ENV`), or, with the egress policy on, a server the proxy would not let the job reach. The job image
  must declare the `mcp` capability. A chained child does not inherit `run.mcp`, and the admin's tools cannot set it.
  Like `models`, adding `run.mcp` to a trigger refuses its jobs that were already queued (`trigger-skew`): re-run
  them. A key under `run` or `on` that is not plain ASCII and holds no plain letter outside `mcpservers` is refused,
  since one in another script can be drawn exactly like `mcp`. On a github or gitlab trigger the list may also name
  `forge`: the job's own GitHub or GitLab through that forge's MCP server, as the token the job already holds, with
  no overlay entry ([`docs/mcp.md`](mcp.md#the-forges-own-server)). A cron, forgejo or azure trigger naming `forge`
  is refused at load, and an image without the `forgeMcp` capability refuses its jobs before they cost anything.

- `"privateEndpoints": ["bench-device"]` lets this trigger's jobs reach the private endpoints it names from
  `private-endpoints.json`, a test device's SSH say, which every other job is refused
  ([private endpoints](egress.md#private-endpoints)). 1 to 8 ids, on any trigger but a watch rule; it makes the file
  `"version": 7`. Each granted endpoint's host and port reach the job as `PI_DISPATCH_ENDPOINT_<ID>_HOST` and
  `_PORT`. The worker confirms the grant against this file before every attempt, so removing an id withdraws it from
  the jobs already queued, which are refused rather than run without it. Adding the field to a forge trigger refuses
  its jobs that were already queued (`trigger-skew`), and a local event trigger's (`local-event-trigger-changed`):
  re-run them. A cron run queued before the edit runs without it instead, because the worker builds a cron job from
  the file itself and has nothing to compare. The admin's tools cannot set it.

- `"skillsDir"` points at a directory of skills on the worker host. The layout is the same as your own
  `~/.pi/agent/skills`, which uses `<name>/SKILL.md`. They are copied into that trigger's jobs. They are
  layered under the repo's own `.pi/skills` and over the global overlay. A repo skill of the same name
  still wins. Use it to run a flow against a repo that has not adopted `.pi/skills/` at all. Use it to
  A/B two versions of a flow across two triggers. Use it to keep a private flow out of a public repo's
  history ([`docs/global-pi-overlay.md`](global-pi-overlay.md)).

- `"replicas": 2` races independent sandboxes on one event and opens one review request per replica, on
  any forge. Webhook triggers only: the poller does not fan out. Each replica spends its own budget slot
  ([`docs/replicas.md`](replicas.md)).

- `"instructions"` attaches one line of standing text to that trigger (forge triggers only, up to 2000
  characters). It reaches the job's prompt above the issue or PR text, labelled as coming from you and
  not from the issue. So "the tests run with pnpm here" applies to every run of that trigger without being
  committed to the repo or added to the deployment wide persona. Cron triggers use `task` instead, which
  is the same text in the same place.

- `"mayMerge": true` permits this trigger's agent to land its own pull or merge request when its flow or
  `instructions` asks it to, subject to the forge's checks, approvals and token permissions. Absent or false
  keeps the original rule that a human lands the change. This setting belongs in the reviewed file, on a forge
  flow trigger; it is refused on local, cron, Watch and command jobs. See [the policy and prerequisites](#allowing-a-job-to-land-its-change).

- `"secrets": { "STRIPE_KEY": "op://ci-vault/stripe/api-key" }` names vault references this trigger's
  jobs receive as environment variables. Use `"secretsProfile"` to choose which of your declared
  resolvers reads them. The worker runs your one line script (`exec op read --no-newline "$1"`) on the
  host before the container starts. The job gets values. It never gets your manager's credential
  ([`docs/secrets.md`](secrets.md)). When one of them is the API key of the provider the job runs on, it is that
  model's key, and the run record says so (`mainCredential`, the variable's name, never its value; the run page's
  [Credential row](console.md#which-key-a-run-spent))

- `"secretBundle": false` keeps this trigger's jobs out of their project's secret bundle, the one environment
  `secretBundles` at the top of this file grants a whole project
  ([`docs/secrets.md`](secrets.md#recipe-d-one-environment-for-a-whole-project)). The worker reads it from its own
  copy of this file, so no receiver has to carry it

- `"waitFor": [{ "after": "2026-09-01T09:00:00Z" }, { "profile": "jira" }]` holds this trigger's job in
  the queue, unstarted and unbilled, until every condition clears. An instant costs nothing. A profile
  names one of your own check scripts. The worker runs it on the host and reads the exit code
  ([`docs/wait-for.md`](wait-for.md)).

- `"resume": true` continues the session that opened the PR ([`docs/sessions.md`](sessions.md)).

- `"github": true` on a local trigger gets the same per-job GitHub token the webhook path gets. A
  scheduled flow or local event command can use `gh` with this explicit credential setting.

- `"worker": "runner-a"` selects a named worker for a local trigger. It is required for event-started local
  commands and optional for cron. Use the same worker for a cron and event trigger sharing a folder. A forge
  job cannot name it; its existing routing rules apply. See [multi-host placement](multi-host.md#where-work-runs).

- `"retainSandbox": false` on a local command trigger keeps no sandbox for its runs: the worker removes a run's
  job directory when the run ends, whatever its outcome. Only a cron trigger that runs a `command`, or a forge event
  that starts a local command, takes it. See [keeping no sandbox](#keeping-no-sandbox-for-a-local-command).

- `"portfolio": true` on a cron trigger makes its jobs portfolio jobs: the one kind of job that may send a
  budget priorities plan back ([`docs/allocation.md`](allocation.md)). Cron only. The file refuses it on a webhook
  trigger, and beside `"command"`, because a plan should come from a flow you reviewed. It must be `true` or `false`.
  When such a job starts, the worker reads the triggers file again. If the flag is gone, or the entry with that
  id now has another folder, flow, command or task, the job runs as an ordinary cron job. If the flag is there and this worker's envelope does not let `portfolio-job` write a plan (no
  envelope, `delegation.enabled` false, or `portfolio-job` not in `delegation.writers`), the job is refused as
  `portfolio-no-envelope` before it costs anything. A chained child never inherits the flag. A working flow to
  copy is in [`docs/portfolio-manager.md`](portfolio-manager.md).

Two more fields change what you see of a run, not what it can do, so the AI tools that add and edit a trigger
(`dispatch_trigger_add`, `dispatch_trigger_edit`) can set them too, behind the operator's confirm:

- `"progress": true` gives that trigger's jobs one more tool, `report_progress`, with which the agent names the phase
  of its plan it is in (up to 64 characters), optionally how far through it is (`done` of `total`) and a short note
  (up to 200 characters). The console's run page and the `/dispatch` panel show the phases; the turns, steps and the
  tool running show for every job without this field. The tool only records: it changes nothing and the run goes on.
  Any trigger type, cron included. The phase names and notes are the agent's words, so they are redacted and shown to
  operators only, never on the forge and never in the run record. The job image must declare the `reportProgress`
  capability. The shipped image does. A job on an older image is refused before it costs anything. A job where another
  extension registers a tool of the same name stops before its prompt (`report-progress-shadowed`).

- `"statusComment": true` makes the worker post one comment on the issue or pull request when the job's container
  starts, and edit it as the run goes, about every 30 seconds at most, ending with the outcome the run record gives
  (`finished: completed`, `finished: policy` and so on), or `attempt ended, retrying` when an infrastructure failure
  will be retried (the next attempt then ends it, also when that attempt is refused before it starts; a retry you
  cancel with `pi-dispatch cancel` while it waits is the exception, and its comment keeps saying retrying): ``pi-dispatch job `<id>`: running. Turn 7, 12 steps (1 failed). Phase 2 of 4 (3/10).`` It holds numbers only, never
  the agent's words, and it does not replace the agent's own comment or the worker's other comments. A retry edits the
  same comment. Webhook triggers only: a cron trigger has nothing to comment on and is refused. It needs
  `PI_RUN_PROGRESS` on (the default); with that at `0` the job runs without the comment, and the worker log says so
  (`status_comment_skipped`, reason `progress-off`). When the comment's text could
  contain the trigger phrase that started the job, the worker leaves the comment out rather than risk starting a job
  of its own (reason `phrase-collision`). The same log line names the two rarer skips: `no-transcript` (the job had
  no transcript to read progress from) and `no-forge-target` (no forge the worker can post to and edit on). Anyone who can read the issue can see how long the run took and how many steps it made, so it is off
  by default.

Both must be `true` or `false`. Like `models`, adding either to a trigger refuses its jobs that were already queued
(`trigger-skew`): re-run them.

`"recover": true` opts a trigger into durable runs: when the worker loses one of its runs part way (a crash, a
kill, a host that went away, or a container that died on an infrastructure fault), the run continues from its last
checkpoint instead of failing or starting over, at most twice. A graceful stop of the worker is not a loss: it stops
the run as before. It needs a checkpoint store (`PI_SESSIONS_DIR`, whose `.checkpoints` folder holds them, or
`PI_CHECKPOINTS_DIR`), or its jobs are refused before they cost anything (`recover-store-unset`), and a job image
that declares the `recover` capability; a job on an image without it is refused the same way
(`job-image-recover-unsupported`). On a fleet, name every worker (`PI_WORKER_NAME`) so a recovery reaches the
machine holding the checkpoint. A repository whose default branch has `.pi/extensions/` is not recovered: its runs
run as before.
Webhook triggers only: a cron trigger is refused, because its job edits your folder in place and a continuation
would replay over changes the lost run already made. It is also refused beside `"command"`, because continuing a
command job would dispatch the command a second time. It must be `true` or `false`, the AI tools that add and edit
a trigger can set it behind the operator's confirm, and like `models`, adding it refuses the trigger's jobs that
were already queued (`trigger-skew`). How a run is checkpointed and continued is in
[`docs/durable-runs.md`](durable-runs.md).

`"steer": true` opts a trigger into steering: while one of its jobs runs, operators (from the command line) and the
people your comment trigger accepts (with its phrase, on the job's issue or pull request) can send it messages, which
the agent reads between its steps. On a **comment** trigger it also decides whether a phrase comment may steer a
running job of the target instead of starting a new one, so set it on the comment trigger too if comments should
steer; `<phrase> later ...` sends a follow-up. A comment that arrives after the run ended starts a resumed job when
the comment trigger has `"resume": true`, or gets one fixed reply. It is off by default. It needs a job image that declares the `steer` capability, or its jobs are refused before they cost
anything (`job-image-steer-unsupported`), and a venue that bind-mounts. Every trigger type may set it, cron
included; it is refused beside `"command"`. It must be `true` or `false`, the AI tools that add and edit a trigger
can set it behind the operator's confirm, and like `models`, adding it refuses the trigger's jobs that were already
queued (`trigger-skew`). How messages reach a running job is in [`docs/steering.md`](steering.md).

## Allowing a job to land its change

By default, both the job prompt and the image's standing rules say never to merge, and that a human reviews and
lands the change. `run.mayMerge: true` removes that prohibition from both layers for this trigger's jobs. It gives
permission; it does not tell the agent to merge every change. Put the requested behavior in the flow or in
`run.instructions`, for example:

```json
{
  "version": 4,
  "triggers": [
    {
      "on": { "type": "label", "any": ["reviewed-fix"] },
      "run": {
        "kind": "github",
        "flow": "fix",
        "mayMerge": true,
        "instructions": "After the independent review succeeds, enable auto-merge for the pull request you open. Keep every required check and approval in force."
      }
    }
  ]
}
```

The setting applies to forge flow jobs on GitHub, GitLab, Forgejo and Azure, including resumed jobs. The job still
must not push directly to the default or a protected branch, change branch protection or repository settings,
approve its own change, or bypass checks and approvals. A managed fork may land its own new request, never the
original attempt's. False or absent leaves the existing user and system prompts byte for byte unchanged.

**Permissions still decide what can happen.** The setting changes instructions, not credentials or forge policy.
The harness starts no merge itself, and the bundled forge MCP servers still withhold their dedicated merge and
approval tools. The agent can use the CLI it already has, if its token permits it. The existing branch-protection
check still runs: on GitHub, a classic rule qualifies, but a ruleset-only branch needs an active pull-request rule
requiring an approval, so required status checks alone do not qualify. On GitLab, a Developer token cannot merge
into a branch whose Allowed to merge setting is Maintainers. See [GitHub protection](github.md#which-branches-count-as-protected)
and [GitLab credentials](gitlab.md). Choose the required checks, independent approvals and token scope deliberately;
an agent can edit tests in the same repository, so green tests alone are not an independent review.

**The current trigger must still authorize the job.** The queued job carries the opt-in and a digest of the whole
normalized trigger. Before each container, the worker compares them with the current trigger file. Editing the
trigger, removing the permission or replacing its entry refuses the old enabled job before spending; run it again
against the new entry. A retry of a one-shot excuses only that same queue job's own disarm mark, as the existing
one-shot gate does. An older unflagged job never gains permission because the file was changed later. Polling,
webhooks, replicas, parked answers, reruns, forks and recovery all carry the same policy. A comment or message into
a running job cannot grant it.

Removing the setting takes effect at the next container start. It does not change a running job's snapshot, undo
a completed merge, or cancel a pending auto-merge request already accepted by the forge. Cancel the job or the
forge's pending request separately when needed. Project or flow instructions may still impose stricter rules;
the setting removes the harness's blanket prohibition, not rules written elsewhere.

**Upgrade order.** Upgrade the image, every worker, the receivers and every console before adding the field, as
described in [the upgrade guide](upgrading.md#533-trigger-merge-permission). The image needs the
`mergePolicy` capability; an older image refuses an enabled job before spending. The file needs version 4 and its
enabled jobs use data version 5. Do not lower either version to make an older service accept them. Triggers that
omit the setting keep their previous behavior and image requirements.

## Firing a cron trigger by hand

`pi-dispatch run --trigger <id>` runs one cron trigger now, once, exactly as its schedule would. Its folder,
flow, task and every other field come from the triggers file, so the command takes no other flag. This is how
you test a `portfolio` trigger without waiting for its schedule. `pi-dispatch run <folder>` makes a manual job,
which never carries the flag.

- It reads `PI_TRIGGERS_FILE`, `PI_WORKER_NAME` and `PI_MAX_COST_USD` from your shell, or else from the `.env` in
  the folder you run it from, as it reads `VALKEY_URL`. With no `PI_TRIGGERS_FILE` anywhere it reads
  `./triggers.json` there. That is the file the worker checks the `portfolio` flag in, so run it from the deployment
  folder. It refuses when your shell and the `.env` disagree on one of them, or when the `.env` cannot be read and
  your shell does not set it. `PI_MAX_COST_USD` is read so that a trigger whose `maxCostUsd` the worker refuses is
  refused here too. `pi-dispatch run <folder>` reads `PI_WORKER_NAME` the same way.
- It refuses an id that is not a cron trigger in that file, and it refuses a file the worker would refuse.
- The trigger's folder must be a git repository with a commit, as for `pi-dispatch run <folder>`. Uncommitted
  changes are fine, as they are for a scheduled run.
- The job id is `manual:<id>:<minute>`. A second call in the same minute queues nothing and says so. A later
  minute queues a new run.
- The job's `/job/event.json` says `"source": "cron"` with the trigger's id and pattern, and `scheduledFor` and
  `previousRunAt` are `null`. It counts as a run of the trigger: the next scheduled run's `previousRunAt` can name it.
- On a fleet it queues on this host's own queue, because the trigger's folder is here. If the folder is on
  another machine, it refuses and tells you to run it there.

## Check a file before you swap it in

The worker, the receiver, the poller and the watch collector each keep the last copy of `triggers.json` that loaded
when an edit breaks it, and each logs that it kept the last good copy. But each refuses to start on a file it cannot load (exit 2, and its service
manager does not restart it). So a bad edit costs nothing until a restart, and then takes that one process down while
the others go on with their old copies. That is how one invalid entry left polling down for good while the worker
looked healthy.

`pi-dispatch triggers check` judges a file by the rules each of them loads it by, before any of them sees it. Write the
change to a copy next to the file, check the copy, then move it over the file:

```sh
cp triggers.json triggers.json.new
$EDITOR triggers.json.new
pi-dispatch triggers check triggers.json.new && mv triggers.json.new triggers.json
```

- Run it from the deployment folder. With no file named it checks the deployment's own (`PI_TRIGGERS_FILE`, else
  `./triggers.json` there). It reads the settings it judges by from your shell, else from the `.env` there, as
  `run --trigger` does: `PI_TRIGGERS_FILE`, `PI_WORKER_NAME`, `PI_MAX_COST_USD`, `PI_DISPATCH_RUN_ROOTS`,
  `PI_GLOBAL_PI_DIR`, `PI_ENVELOPE_FILE`, `GITHUB_INGEST` and `GITHUB_AUTH_SOURCE`. It refuses when your shell and the
  `.env` disagree on one of them, when a secret it asks about is set in one and empty or blank in the other, and when your
  shell sets one of these settings or secrets and the `.env` has no line for it: the services read the `.env`, so what
  only your shell has, they do not (an empty value in your shell counts as unset, as it is for them). It names the variable and never shows its value. With no `.env` in the folder, your
  shell's settings are the deployment's.
- A refused file gets one `error:` line per refusal, naming who refuses it and why, then what a start on it would do,
  and exit 1. A refusal your deployment's settings cause whatever the file holds says so. A file every one of them
  takes gets one line with its counts and who takes it, and exit 0. A `note:` line says what refuses nothing: a cron
  trigger another host schedules, a cron pattern with no next run (an existing schedule of that id then keeps its old
  pattern, and a new one is never made), and a job path the worker cannot read when it looks for its private endpoint
  folders, which it logs and starts anyway. The check writes nothing and tells no service anything: a running one
  reloads the file itself once you move it in. `pi-dispatch triggers` with no `check` prints its usage and exits 1, so
  a script that forgot the word moves nothing.
- The worker is judged only where `PI_TRIGGERS_FILE` is set: without it the worker reads no triggers file and schedules
  no cron. It refuses what its start refuses: a `run.maxCostUsd` above `PI_MAX_COST_USD`; a cron trigger's folder or
  `skillsDir` missing from this machine; a cron pattern BullMQ will not schedule (`0 99 * * *`, `0 0 31 2 *`: the file
  only checks that it has five or six fields); a job path that holds the envelope file (`PI_ENVELOPE_FILE`) or the
  deployment folder's `egress-private/` or `egress-grants/`; and, with an envelope set, any job path or envelope path
  its check cannot judge (one it cannot read, a link, a relative path). A job path from `PI_DISPATCH_RUN_ROOTS` or
  `PI_GLOBAL_PI_DIR` is the deployment's, and its refusal says so. On a fleet (`PI_WORKER_NAME` set) a cron trigger
  whose folder is not here is another host's, and the check says so in a note.
- A watch source whose signing secret (its `secretEnv`) is unset or blank refuses the receiver (`serve`), which
  verifies the source's pushes with it. The poller and the watch collector never read it, and take the file. The secret
  is read for whether it is set, never for its value, which is not printed.
- With `GITHUB_INGEST` and `GITHUB_AUTH_SOURCE` unset, the file decides whether `serve` takes GitHub webhooks: one
  GitHub rule is enough, and then `serve` needs `WEBHOOK_SECRET`. So adding the first GitHub rule to a deployment with
  no `WEBHOOK_SECRET`, or one of spaces, is refused for the receiver. The poller and the watch collector never read
  it. Set `GITHUB_INGEST=poll` if the poller brings GitHub's events. Where `GITHUB_INGEST` or `GITHUB_AUTH_SOURCE` already says GitHub, the same refusal is named
  as the deployment's.
- The watch collector is named only where a pull source is known: in the file, or, for a file that does not parse, in
  the deployment's current file. A file that removes the last pull source gets a note: a watch collector started on it
  refuses to start.
- It does not judge the rest of the environment (a forge's own webhook settings and `RECEIVER_PORT`, which only
  `serve` reads, `POLL_REPOS`, `GITHUB_INGEST=webhook` against a
  poller, Valkey), the other files a service loads at start (the envelope's own content, the pause windows, the scoped
  limits, the projects, the model endpoints), nor what only a live fleet can say (whether the hosts agree on the cron
  set). `pi-dispatch doctor` does. Nor does it know which of the services run on this host: it answers for each one
  that would load the file here.
- Move the copy in one step, with `mv` in the same folder. A file written in place can be read half written, and the
  poller then refuses that read once and goes on with its last good copy. A single-file bind mount (compose's
  `triggers.json:ro`) keeps the file it started with, whatever you move over it, until the container restarts.

## Local folders behind a link

A local job's folder is resolved when the job is prepared, and the container mounts the resolved folder, not the
spelling you wrote. A folder named inside a job path (a cron trigger's `run.folder` or a `PI_DISPATCH_RUN_ROOTS` root)
must still resolve inside one. If it does not, the job is refused as `local-folder-escaped`, and nothing is spent.

The reason is that a job can write inside its own folder. A link planted there could otherwise send a later job, a
chained child or a `dispatch_run` job, to a folder nobody checked, mounted read-write.

So a run root used as a symlink farm (`root/shop` linking to `/srv/shop`) is refused. List the real folder instead:
add `/srv/shop` to `PI_DISPATCH_RUN_ROOTS`, or name it as the cron trigger's `run.folder`. A folder named outside every
job path, as in your own `pi-dispatch run`, is not held to them. See [allocation](allocation.md) for the two related
refusals, `local-folder-holds-envelope` and `local-folder-project-changed`.

## Choosing the model and the turn limit

Any trigger type can name the model its jobs run on, and how many turns a job may take:

```json
{ "on": { "type": "label", "any": ["pi:triage"] },
  "run": { "kind": "github", "flow": "triage", "provider": "openai", "model": "gpt-5.4-mini", "maxTurns": 10 } }
```

- `"provider"` is a pi provider id, such as `anthropic` or `openai`. Since pi 1.0.3 the Azure OpenAI
  provider is `azure`, no longer `azure-openai-responses`. Rename it everywhere it appears: here, in
  `"models"` lists and `PI_ALLOWED_MODELS` (`azure/gpt-5.4`), in `PI_PROVIDER`, in `model:` rows of your
  scoped limits, in `provider` in `subscriptions.json`, and in the overlay `models.json`. A job on the old id
  is refused before it spends, and the refusal names `azure`. An allowed-models entry on the old id matches
  nothing, and a `model:` row on the old id caps nothing. If the worker takes the Azure key from the host's pi
  login, rename the `azure-openai-responses` key in that `auth.json` to `azure`, or log in again; otherwise the
  job is refused as `provider-unconfigured`. A thread job that resumes an older session is safe:
  a session written by another pi version is never resumed, the job starts fresh.
- A pi bump can also remove models from pi's catalog. A trigger, an allowed-models entry or `PI_MODEL` that
  names a model the new pi does not have is refused before it spends (`model-unknown`), and `doctor` names it.
  A `model:` row in your scoped limits that names such a model caps nothing.
  pi 1.0.3 removed these ids (besides the Azure rename):
  - `cloudflare-ai-gateway`: `claude-fable-5.1`, `claude-haiku-4.5`, `claude-opus-4.5`, `claude-opus-4.6`,
    `claude-opus-4.7`, `claude-opus-4.8`, `claude-opus-5.5`, `claude-sonnet-4.5` and `claude-sonnet-4.6`. Each
    is now spelled with dashes (`claude-opus-4-8`).
  - `openrouter`: `openai/gpt-6.1-sol:batch` and `openai/gpt-6.1-sol-pro:batch`.
  - `together`: `deepseek-ai/DeepSeek-V4-Pro`, `google/gemma-4-31B-it` and `openai/gpt-oss-20b`.
  - `vercel-ai-gateway`: `inclusionai/ling-3.0-flash-sante-free`.

  `opencode-go/qwen3.7-plus` and `opencode-go/qwen3.8-max` keep their ids and moved from openai-completions to
  anthropic-messages. 57 models changed price; a run is priced at the rates of the pi it ran on.

  pi 1.0.4 removed two more ids, both on `openrouter`: `qwen/qwen3.8-27b:free` and `stealth/space-bunny-alpha`.
  14 models changed price (12 on `openrouter`, 2 on `vercel-ai-gateway`).

  pi 1.1.0 removed these ids:
  - `opencode-go`: `space-bunny-free` (`space-bunny` is new).
  - `openrouter`: `kwaipilot/kat-coder-pro-v2.5`, and the classifier `perplexity/pplx-decider-v1-27b`
    (`perplexity/pplx-decider-v1.1-27b` is new).
  - `vercel-ai-gateway`: `deepseek/deepseek-v3.1-terminus`, `moonshotai/kimi-k2-thinking` and
    `stepfun/step-3.5-flash`.

  180 models changed price, most of them on `openrouter` (101) and `vercel-ai-gateway` (48).

  pi 1.2.0 removed these ids:
  - `google-vertex`: `gemini-flash-latest` and `gemini-flash-lite-latest`.
  - `opencode`: `fledge-alpha-free`.
  - `openrouter`: `inclusionai/ling-3.0-flash-sante:free` (`inclusionai/ling-3.0-flash-sante` is new),
    `qwen/qwen-plus-2025-07-28`, `qwen/qwen3-235b-a22b`, `qwen/qwen3-30b-a3b-thinking-2507`, `qwen/qwen3-8b`,
    `qwen/qwen3-coder-plus`, `qwen/qwen3-max`, `qwen/qwen3-max-thinking`, `qwen/qwen3-vl-235b-a22b-thinking`,
    `qwen/qwen3-vl-32b-instruct`, `qwen/qwen3-vl-8b-thinking`, `qwen/qwen3.6-max-preview` and
    `sao10k/l3.1-euryale-70b`.
  - `vercel-ai-gateway`: `alibaba/qwen-3.6-max-preview`, `alibaba/qwen3-235b-a22b-thinking`,
    `alibaba/qwen3-coder-plus`, `alibaba/qwen3-max`, `alibaba/qwen3-max-preview`,
    `alibaba/qwen3-vl-235b-a22b-instruct`, `alibaba/qwen3-vl-thinking`, `anthropic/claude-3-haiku` and
    `anthropic/claude-opus-4`.

  54 models changed price, most of them on `openrouter` (42); on `anthropic`, `claude-sonnet-5-5`'s cache read
  halved. `anthropic/claude-sonnet-4-5` (and its dated id) now has a context window of 200k tokens, down from 1M.
- `"model"` is that provider's model id. Case is kept as you wrote it.
- `"maxTurns"` is a whole number of 1 or more. The job is warned once at 70% of it
  ([the warnings before the limits](job-limits.md#warnings-before-the-limits)).

Each one is optional. A field you leave out is not written into the job. The job then takes the value
from the settings overlay, else from the environment (`PI_PROVIDER`, `PI_MODEL`, `PI_MAX_TURNS`), when it
starts. A trigger that names only a model runs on the deployment's provider, so name both when they
belong together.

The file is checked when it loads, in the worker and in the receiver:

- A provider is 1 to 64 characters: letters, digits, `.`, `_` and `-`, starting with a letter or digit.
- A model is 1 to 64 characters: letters, digits and `.` `_` `-` `:` `/` `@`, starting with a letter or
  digit, or with `~` or `@` and then one. This is the same rule the run history uses for the model rows it
  keeps, so any model a trigger can name is one whose usage can be recorded.
- A number, an empty string, a space, a 65th character or a non-ASCII character is refused. The message
  names the trigger and the field. It does not repeat the value.
- A near miss of a field name is refused too: `providerId`, `providers`, `modelId`, `modelName`,
  `model_id`, `maxTurn`, `max_turns`, `allowedModels` and other case or separator variants. A misspelled key would otherwise be dropped,
  and the job would run on the default model while the file reads as though it chose one. The same
  keys under `on` are refused in every spelling.

The load check does not ask whether the model exists, because the answer depends on each worker's
pi version and overlay. The worker asks instead, when a job starts and before it spends anything: a
model that is in neither pi's model catalog nor the overlay `models.json` is refused as `model-unknown`.
No token is minted, nothing is cloned and no budget slot is taken. The model a job runs on must be a
chat model; an image or classifier model can only be a list entry (below). The overlay `models.json` is
read the way pi reads it: `//` comments, a byte order mark and trailing commas are fine. One wrong-typed
field anywhere, a `/* */` comment, a truncated write, a misspelled `providers`, a file saved as UTF-16, or an
empty file makes pi drop the whole file. pi then also loses the file's entries for builtin providers, such
as a `baseUrl` for `openai`, and would run their models against the provider's public endpoint. So while
the overlay `models.json` is broken, the worker refuses every job (`model-unknown`, with
`overlay-unparseable` in the worker log), whichever model it runs or lists. The same holds when
`models.json` is a directory (`overlay-is-a-directory`), and when the worker cannot read it because of the
permissions on the file or its folder (`overlay-unreadable`): pi in the job then loads none of the file,
because the runner's existence check, or pi's own read, fails. It also holds when `models.json` is a link
(`overlay-link`), since the job's read-only mount does not follow links the way your host does: replace the
link with the file itself. The same holds when `models.json` is a named pipe, a socket or a device
(`overlay-not-a-file`): the worker never opens it. `pi-dispatch doctor` says so. Fix the file, make it
readable by the account the worker runs as, or remove it: a missing `models.json` is no overlay, and jobs run.
A read that fails for a moment (a disk error, too many open files) is not a refusal: the job is retried once,
then failed. pi also drops a provider it cannot put
together: a model with no `api` or `baseUrl` to be found, a `contextWindow` or `maxTokens` of zero or less, or
`oauth` without a `baseUrl`. pi then ignores that provider's whole entry, its `baseUrl` and headers
included. So every job that runs or lists a model of that provider is refused (`overlay-provider-invalid`),
also a job that only lists one and never calls it: an overlay model of it does not exist, and a builtin one
would quietly run against the provider's public endpoint instead of yours. `pi-dispatch doctor` names each
such entry.

**Upgrading: the model check.** It covers the deployment default too (`PI_MODEL`, or the settings overlay), not
only a trigger's own model. A main model that only an extension defines inside the job
(`pi.registerProvider`) was already refused before this release, inside the container and after the job
had taken its budget slot. It is now refused before anything is spent. Declare such a model in the overlay
`models.json`. A virtual model (`pi.registerVirtualModel`) cannot be the main model: set `PI_MODEL` or
`run.model` to a physical one.

`dispatch_trigger_add` and `dispatch_trigger_edit` can set `provider` and `model`, behind the same
operator confirm as every other trigger write. Both check the value with the same rule before they ask.
The panel's drill-in and `dispatch_triggers` show a trigger's own model, provider and turn limit on every
trigger type.

**Upgrading.** Before this release a webhook trigger's `provider`, `model` and `maxTurns` were ignored, and
its jobs ran on the deployment default. If your file already sets them on a label, comment, pull request
or issue trigger, they now take effect. A value that loaded before but breaks the rule above (a number, a
space, more than 64 characters) now refuses the whole file, in the worker and in the receiver alike, as
does a misspelled key such as `modelId`. A `null` value is still accepted on every trigger type and
means the deployment default, as it did before. Run `pi-dispatch doctor` after upgrading to see any such
line.

## Choosing randomly from a reviewed pool

A person can choose **Random model pool** on a trigger's **What its jobs get** card, preview the change and confirm it. The existing fixed model and ordered fallback modes remain available. By hand, put this inside an ordinary AI trigger's `run`:

```json
"modelSelection": {
  "strategy": "random",
  "candidates": ["anthropic/claude-haiku-4-5", "openai/gpt-5.5"]
},
"models": ["anthropic/claude-haiku-4-5", "openai/gpt-5.5"]
```

Remove `provider`, `model` and `fallbackModels` when using the pool. Use 1 to 16 unique exact catalog references. The pool chooses; `models` authorizes. If `models` is absent the deployment's finite allowed-model ceiling must supply it. A pool without either ceiling refuses, and the deployment's default model is never an extra candidate. Role names, command jobs and package canaries are not accepted. No model-callable tool can write this policy.

A fresh run draws among the candidates that pass the current free gates, each with an equal chance, or by the pool's [weights](#weighting-the-pool). Its in-process children use that selected model too. A queued outbox child is a new run and draws from the inherited reviewed pool. Retry retains the choice; fresh Re-run draws again. The Models page shows the configured pool and observed blockers without guessing what will be selected. Run history shows the actual model, **Chosen at random**, or **Changed after subscription limit**, with the previous model when it changed.

An exhausted subscription excludes all candidates sharing that account/application allowance. If every candidate is temporarily blocked, the job waits without starting a container. A displayed recheck time is not a promise that the provider has reset the allowance; an unknown reset stays unknown. One model name never creates another account allowance. A pool never switches accounts or enables paid extra usage on its own.

A pool may hold subscription models and API-key models together. Which class a candidate is in depends on the worker's host: a model whose provider is bound to a [subscription connection](subscription-auth.md) there is a subscription candidate, also while that connection cannot sign in, and every other model spends an API key. Each draw bills its own candidate's class: a job that draws the subscription model runs on the subscription, and one that draws the API-key model runs on the key. The first draw passes over a subscription model that cannot take the job now (its allowance exhausted or at or above the [quota reserve](#using-the-subscription-quota-reserve), its connection signed out, or its paid extra usage below the cap) and may land on an API-key model. After that the class never changes: a retry, a parked answer, an approval or a recovery stays on it, and a replacement after a subscription limit picks only another subscription model, or waits when all of them are blocked.

A pool that mixes the two classes on a host needs a positive `run.maxCostUsd` on its own trigger; the deployment's `maxCostUsd` alone does not count. Without one, every job of the trigger is refused as `auth-route-unbounded` when a worker picks it up, before anything is drawn or spent, and `pi-dispatch doctor` names the trigger on that host. The cap bounds the API-key draws, and a draw on a subscription connection that allows paid extra usage: the runner prices each such call from pi's model catalog and the overlay `models.json` as they were when the job started, so a long run there can stop as `cost-cap`. A model priced at zero there is not bounded by the cap; pi's own Claude and OpenAI models are all priced. A draw on a subscription without paid extra usage bills nothing, so its calls do not count against the cap or any dollar window: the subscription's quota, the job's turn and time limits and, when the trigger sets one, its [subscription allowance](#a-subscription-allowance-per-job) bound it (see [what the cap counts](costs.md#what-the-cap-counts)). An image from before this release still counts those calls against the cap. A pool of API-key models alone, or of subscription models alone, needs no cap. That is judged on each host at each pickup: if a host later binds one candidate's provider to a connection, the pool becomes mixed there, and its jobs, retries and continuations included, are refused as `auth-route-unbounded` until the trigger sets a cap.

An API-key draw takes its key from the worker's environment or from the trigger's own `run.secrets` ([the provider key as a run secret](secrets.md#the-provider-key-as-a-run-secret)). Either way the key reaches only the draws whose model, or a model in the trigger's `run.auxiliaryModels`, is on a provider that reads it (a variable named in `PI_FORWARD_ENV` reaches every job), and then pi spends it under the cap. A subscription draw does not get it, so no tool or script the job runs can spend it outside the cost meter; the worker logs `run_secret_withheld` naming the run secret it kept out. A project bundle's variable of that name is kept out the same way. Run secrets that are no candidate's API key reach every draw. Upgrade every worker before a pool mixes the classes: an older worker refuses such a job as `auth-mixed-billing`, spending nothing.

A replacement is allowed only when authoritative exhaustion is found before execution, or on an already-authorized retry after a signed failure proves that no tool started and replay is safe, and the host successfully records the exhausted allowance. A generic 429, authentication trouble, a crash or uncertain/tool execution keeps the choice. Already-spent usage remains charged. Recovery, parked answers and approval continuations keep their original exact model; missing or changed saved-session binding refuses safely.

Upgrade every worker, receiver and console before enabling this field: trigger files require version 6 and queued jobs version 7. See [the upgrade guide](upgrading.md) and [backup state](backup.md).

### Weighting the pool

To give some candidates more of the draws than others, add `weights` inside `modelSelection`, by hand in the file:

```json
"modelSelection": {
  "strategy": "random",
  "candidates": ["anthropic/claude-haiku-4-5", "openai/gpt-5.5"],
  "weights": { "anthropic/claude-haiku-4-5": 3 }
}
```

Each key is one of `candidates`, spelled exactly the same, and each weight a whole number from 1 to 100. A candidate
`weights` does not name weighs 1, so here the Haiku model gets 75% of the draws and the GPT one 25%. Leave `weights` out for
equal shares: an empty `weights` is refused, as is a key that names no candidate (or differs from one only in case),
a weight outside 1 to 100, and `weights` written beside the pool rather than inside it. A candidate's share is its
weight over the sum of the pool's weights. A candidate that cannot run at pickup (blocked, cooling down, refused by
its check) leaves that draw, and the others keep their relative shares: with the GPT model cooling down, the Haiku
model gets the draw. A replacement after a subscription limit chooses among the other subscription candidates by
their weights. `pi-dispatch doctor` names each candidate's share on one line per weighted pool, by billing class when
the pool mixes them on that host; the trigger's page and **Models** show the shares too.

The trigger's page has no weight input. A pool edited there keeps the weight of each candidate that stays, drops the
weight of one taken off, and adds a candidate with none, so it weighs 1. Changing only the weights refuses no queued
job: a job draws with the weights it carried when it was queued, and its stored choice and run record do not hold
them. Like any change to the pool, a weight edit gives a cron trigger's scheduler a new template with a new
selection generation, and gives a local job a new id, so one queued with other weights in the same minute is not taken
as a duplicate of one queued before.

A pool with `weights` needs triggers file version 12, and its jobs are queued at job data version 13; a pool without
them needs 6 and 7 as before. Upgrade every worker, receiver and console host first: an older receiver or worker
refuses to load such a file, and an older worker holds such a job (`newer-release`) without spending. The trigger's
page refuses the edit while a live host reads less. See [mixed versions](upgrading.md#mixed-versions-what-is-safe).

## Limiting which models a job may call

`"models"` lists the models a trigger's jobs may call, on any trigger type:

```json
{ "on": { "type": "label", "any": ["pi:triage"] },
  "run": { "kind": "github", "flow": "triage", "provider": "openai", "model": "gpt-5.4-mini",
           "models": ["openai/gpt-5.4-mini", "anthropic/claude-haiku-5-5"] } }
```

- Each entry is `provider/model`. It is split at the first `/`, so a model id may carry more slashes
  (`openrouter/~anthropic/claude-sonnet-latest`). Each half follows the rules above.
- A list has 1 to 16 entries. An empty list is refused: leave the field out for no limit.
- An entry that repeats another, ignoring case, is refused.
- When the trigger names `provider`, `model` and `models` together, the main model must be on the list,
  spelled exactly as in the list. Otherwise the file is refused, because every job would be.

A deployment can set a default list with `PI_ALLOWED_MODELS` in `.env`, in the same form, comma
separated, with no spaces (a shell that sources `.env` cuts the value at a space and leaves it unset, so
the worker refuses a spaced value at boot, and `pi-dispatch doctor` names it). A trigger's own `models` replaces it for that trigger's jobs. With neither, a job may call any
model, as before. The default list is read from the environment only. The settings overlay cannot set
it, so no AI tool can widen it.

Before a job spends anything, the worker checks every model on its list exists (`model-unknown`), and
that the model the job runs on is on the list (`model-not-allowed`). The second catches a default model
that is not on `PI_ALLOWED_MODELS`, and a `dispatch_set model` that moves the default off a trigger's list.

`pi-dispatch doctor` asks the same questions of the triggers file before any job does:

- It names a trigger, of any kind, whose own model or a model on its list would be refused, with the reason,
  and the deployment's own default model or a `PI_ALLOWED_MODELS` entry that would be (a typo there refuses
  every job that names no model of its own).
- Only the job's main provider gets its key automatically. Doctor warns when another provider on a list has
  no key the job can receive: none of pi's variables for it is bound by the trigger's `run.secrets`, or named in
  `PI_FORWARD_ENV` and set. Such a job starts, then fails its first call to that provider.
- It asks pi's own loader how it reads the overlay `models.json` and warns where pi and the worker disagree
  about the file or about one of its models. It runs only where the pinned pi is installed beside the worker,
  which is a checkout of this repository after `npm ci` (the same pi the job image is built with). Otherwise it
  says the comparison was not made: no pi, or a pi of another version, such as a global `pi` install.

Inside the container the runner checks every call before it is sent:

- The first call to a model that is not on the list stops the whole job (`model-not-allowed`). The
  call is not sent.
- Matching is exact and case-sensitive, on both the provider and the model id.
- A classifier or image model a flow uses must be on the list like a chat model.
- A virtual model (a router an extension registers) is judged by the model it routes each request to.
- A model can declare server-side fallbacks (`compat.allowedFallbackModels`, in pi's builtin catalog or
  set in `models.json`). Each must be on the list too, under the model's own provider. In the builtin
  catalog only `anthropic/claude-fable-5` has any: a list naming it must also name
  `anthropic/claude-opus-4-8` and `anthropic/claude-opus-5`. The worker refuses a list that misses one
  before the job spends anything (`model-not-allowed`), on any api. Only the `anthropic-messages` api
  sends fallbacks with a call, and there the provider may answer with any of them, so the runner refuses
  such a call too. A listed fallback that answers is logged as `model_fallback`.
- A hook that changes the request (an extension's `before_provider_request`, or an `onPayload` option)
  is denied by default. It may change only these TOP-LEVEL fields of the request: the messages
  (`messages`, `input`, `contents`), the system prompt (`system`, `systemInstruction`, `instructions`)
  and the sampling settings `temperature`, `top_p`, `top_k`, `min_p`, `stop`, `seed`,
  `presence_penalty`, `frequency_penalty`, `max_tokens`, `max_output_tokens` and
  `max_completion_tokens`; for Google, also the sampling fields and system instruction inside `config`.
  Any other change refuses the call before it is sent: a new model, a fallback list, Google's
  `config.httpOptions`, a gateway's `providerOptions`, `prompt`, `metadata`, or any field added, removed
  or changed. That includes sampling settings an api keeps somewhere else, such as Bedrock's
  `inferenceConfig`, Mistral's `maxTokens` or pi-messages' `context` and `options`: they are refused,
  not translated. A field set to nothing (`undefined`) counts as absent, so a hook that copies the
  request through JSON passes.
- A call that would name another model some other way is refused too: `model`, `modelId`, `models`,
  `fallbacks` or `providerOptions` in `samplingParams` or in any level of `samplingParamsByThinkingLevel`
  (pi picks the level per call, so every level counts), an Azure deployment chosen per call (on any
  model of the `azure` provider), or a caller's own `fetch`. Other `samplingParams` keys, such as `min_p`, `reasoning_effort`,
  `chat_template_kwargs` or `service_tier`, change how a model answers, not which one, and pass. A hook
  that edits those same settings is refused, because hooks are denied by default: `samplingParams` is
  checked against a short list of keys that route, a hook against a short list of keys it may change.

Two things about a hook that changes the model, which an operator reading the usage ledger should know:

- With no list, nothing judges the hook. A `before_provider_request` hook that rewrites the request's model
  sends the call to that other model, but the ledger records it under the model the job asked for. A list
  refuses the same rewrite before it is sent.
- A rewrite the list refuses still counts as 1 call with 0 tokens on the requested model's usage row,
  though nothing was sent. The call reached the provider function, which then refused it.

The list reaches the container only on a job image that declares the `modelPolicy` capability. On an
older image a job with a list is refused before it spends (`job-image-model-policy-unsupported`), never
run without its limit.

A chained job (`/outbox`) keeps its parent's provider, model and list. A request file cannot change them.

If a listed model is served by a declared model endpoint ([`docs/egress.md`](egress.md)), the job holds
a slot on that endpoint too, not only on its main model's.

No AI tool can set `models`. Edit the file, or change it on the [trigger's page](console.md#what-a-triggers-jobs-get), which
judges the list before it writes. `dispatch_trigger_add` and `dispatch_trigger_edit` refuse a
call that carries `models`, and an edit keeps the list the entry has. `dispatch_trigger_edit` also refuses,
before it asks, a new provider or model that is not on the trigger's own list. `dispatch_triggers` and the
panel show the list.

**Upgrading, and services out of step.** A receiver from before this release does not know `models` and
drops it, and so does a current one that still reads an old copy of the triggers file (compose's
single-file `:ro` mount keeps the old file until the receiver restarts). The job would then run on the
deployment's list, or on none. The worker reads the triggers file itself and refuses such a job before it
spends (`trigger-skew`, naming the field), the way it refuses a job that lost its `waitFor`. It can only do
that when it can read the file: `PI_TRIGGERS_FILE`, else `triggers.json` in the worker's folder. A worker
that cannot read it cannot see the gap. The check is strict: adding `models` to a trigger refuses the jobs of
it that were already queued (`trigger-skew`), and the comment says so. Re-run them. The worker finds a job's
trigger by its position in the file. Inserting a trigger with the same flow, kind and type ahead of others
moves the ones after it down. A queued job of a moved trigger can then be checked against its neighbour, and
refused as `trigger-skew` when that neighbour sets `models`, `maxCostUsd`, `mcp`, `awaitInput`, `progress`,
`statusComment`, `recover` or `steer`. The comment says the trigger
changed after the job was queued. Re-run those jobs too. Upgrade the worker and the receiver together
([the order](upgrading.md#the-order)), and restart the receiver after editing the file.

Everything else is editable from the panel (`a` adds kind-first, `e` edits the flow, `x` deletes) or via the
confirm-gated AI tools. Every write is validated. The worker, the receiver, the poller and the watch collector reload it
live, with one exception: the receiver arms GitHub's webhook route only when it starts. A GitHub trigger added where it
started without one (no GitHub rule, `GITHUB_AUTH_SOURCE` or `GITHUB_INGEST` said GitHub then, as on a new deployment)
is reloaded, but its deliveries are answered 404 until the receiver restarts, and GitHub does not resend them. The
receiver logs `github_rules_unserved` on each such reload, and the console's trigger form says to restart before you add
one. Under `GITHUB_INGEST=poll` the poller takes the new trigger at its next cycle or event and no restart is needed: it
reads the file again at the start of each cycle and before it judges each event. A bad edit leaves each of them on the
last copy that loaded, and each logs why (`schedules_reload_invalid` from the worker, `triggers_reload_invalid` from the
receiver on each change to the file it refuses, and from the poller and the watch collector once each time the text
they refuse changes). A restart on that file fails, so check an edit before you move it in ([Check a file before you swap it
in](#check-a-file-before-you-swap-it-in)).

`dispatch_trigger_add` takes only the fields its trigger type uses. A field the type does not take is refused before
the operator is asked to confirm, by its name and with the list the type does take, for example: "dispatch_trigger_add
does not take repository for a pull_request trigger; it takes kind, action, reviewState, labels, any, number, once,
flow, forge, backend, model, provider, maxTurns, progress, statusComment, recover, steer. Nothing was changed". A
field whose name is not a plain word is called "a field it was sent", and the value is never repeated. Before this
release such a field was dropped without a word (`repository` on a pull request or issue trigger, for one), and the
operator approved an entry without it. The console's trigger form refuses the same way, in the same words, naming
itself where the tool's name stands ("this form does not take repository for a pull_request trigger; ..."). The fields
that decide what a trigger's jobs may spend, reach or hold (`maxCostUsd`, `models`, `mcp`, `secretBundle`) are
refused first, as before: no AI tool sets them.

The worker itself
writes exactly one thing back, the `on.disarmed` mark. That mark spends a one-shot. Every local job also
receives a read-only `/job/event.json`. It contains source, folder, and HEAD sha. Cron adds its id,
pattern and schedule instants. A scheduled flow can triage only what changed since its last run.

## How long a trigger's jobs may run

A job is stopped when it stops doing anything, not when it is old ([job limits](job-limits.md)). Any trigger type but a
watch's can set its own limits, in whole minutes:

```json
{ "on": { "type": "label", "any": ["pi:refactor"] },
  "run": { "kind": "github", "flow": "refactor", "idleTimeoutMinutes": 30, "maxMinutes": 480 } }
```

- `"idleTimeoutMinutes"` (1 to 1440): how long nothing may happen before the job is stopped. Replaces
  `PI_JOB_IDLE_MINUTES` for this trigger's jobs, longer or shorter.
- `"stallTimeoutMinutes"` (0 to 43200, 0 for off): how long the AI may take no step, however busy the container is.
  Replaces `PI_JOB_STALL_MINUTES`, which is off by default.
- `"maxMinutes"` (1 to 43200): a wall-clock ceiling. When the deployment sets `PI_JOB_MAX_MINUTES` too, the smaller wins.
  The job is warned once at 70% of it ([the warnings before the limits](job-limits.md#warnings-before-the-limits)).

A value that is not a whole number in range, a near miss of a name (`idleTimeout`, `max_minutes`), or one of these
names under `on` is refused when the file loads. A file that uses one is stamped version 3, which an older release
refuses, so move every host first ([upgrading](upgrading.md)). Like `maxCostUsd`, a job that arrived without a limit its
trigger sets is refused as `trigger-skew`, and no AI tool sets them: the console shows them under By hand.

## Auxiliary models for panels

`run.auxiliaryModels` is a hand-authored list of 1–16 exact physical `provider/model` references, without
wildcards, roles or duplicates. Each must also appear in an explicit finite `run.models` allowlist, and the run
must set a positive `maxCostUsd`. For example, an ordinary flow can keep two subscription root candidates in
`modelSelection.candidates` and list its subscription and paid API panel members in `auxiliaryModels`.
Selection retains the chosen root plus these members under the same model and cost guards; the auxiliary list
does not add root candidates or paid fallback authority. All declared auxiliary authentication and quota routes
must pass before any container starts. See [subscription authentication](subscription-auth.md) for credential
sources and whole-panel admission, and [upgrading](upgrading.md) before enabling this field across a fleet.

## A dollar cap per job

Any trigger type can set the most one of its jobs may spend, in US dollars:

```json
{ "on": { "type": "label", "any": ["pi:triage"] },
  "run": { "kind": "github", "flow": "triage", "maxCostUsd": "0.50" } }
```

- `"maxCostUsd"` is a plain decimal: above 0, at most 1000000, with at most 6 decimals. Write it as a
  string, such as `"0.50"`. A string is checked exactly as you typed it, so `"0"`, `"-1"`, `"1e3"` and
  `"0.1234567"` are refused when the file loads, in the worker and in the receiver. The message names the
  trigger and the field, never the value.
- A JSON number also works (`0.5`, `2`), but it is read by its value, not by what you typed. JSON turns
  `1e3` into 1000 before anything sees it, so `1e3` unquoted loads as $1000, and digits past what a float
  can hold are lost. Quote the amount to have it checked as written.
- The runner checks it before every model call that can be billed. A call that could take the job past the cap
  is not sent, and the run stops with reason `cost-cap`. A call on a subscription connection without paid extra
  usage bills nothing, so the cap does not count it ([what the cap counts](costs.md#what-the-cap-counts)), and
  `pi-dispatch doctor` warns when a trigger's cap bounds nothing on its host for that reason.
- It can only lower the cap. The job runs under the smaller of this value and the deployment's
  `PI_MAX_COST_USD` (or the panel's `maxCostUsd`). When the deployment sets no cap, the trigger's applies on
  its own.
- A value above `PI_MAX_COST_USD` is a mistake. When the worker reads the triggers file (`PI_TRIGGERS_FILE`
  is set for it), it refuses to load such a file: at startup it will not start, and on a live edit it keeps
  the cron triggers it had. The receiver reloads webhook triggers on its own and does not know the worker's
  cap, so it still serves an edited webhook trigger. Its jobs then run under the smaller of the two caps,
  never the trigger's higher one. `pi-dispatch doctor` names the trigger either way.
- A job with a cap needs a job image that declares the `costCap` capability. The shipped image does. On an
  older image the job is refused before it costs anything, with reason `job-image-cost-cap-unsupported`.
  That image's runner would ignore the cap. A deployment that sets no dollar cap anywhere needs no new image.
- A chained job (job chaining) keeps its parent's cap.
- No AI tool can set or change it. `dispatch_trigger_add` and `dispatch_trigger_edit` refuse a call that
  carries it, and an edit leaves it as it is. `dispatch_triggers` and the panel show it. A person can change it in the file
  or on the [trigger's page](console.md#what-a-triggers-jobs-get), which refuses a cap above the deployment's and one too
  small for the first call of the model a job starts on, and warns on one too small for a short task's, or for another
  model it names ([costs](costs.md#a-job-cap-on-a-trigger)).

**Upgrading, and services out of step.** The same as for `models` above: a receiver from before this
release drops `maxCostUsd`, and its job would run under the deployment's cap or none. The worker refuses
such a job before it spends (`trigger-skew`, naming the field), when it can read the triggers file. The
check is strict: adding `maxCostUsd` to a trigger refuses the jobs of it that were already queued
(`trigger-skew`). Re-run them. Upgrade the worker and the receiver together ([the order](upgrading.md#the-order)).
`pi-dispatch doctor` reminds you
of this once when a trigger sets `maxCostUsd`, as it does for `models`.

**Dollar windows.** A deployment can also cap what all its jobs spend per UTC day, Monday week and month:
`PI_DAILY_COST_USD`, `PI_WEEKLY_COST_USD` and `PI_MONTHLY_COST_USD` (or `dailyCostUsd`, `weeklyCostUsd` and
`monthlyCostUsd` in the panel). Each needs `PI_MAX_COST_USD`.

- Before a job starts, its cap (the smaller of the trigger's `maxCostUsd` and the deployment's) is held in
  every window that is set. A job that does not fit is refused with reason `dollar-cap`, and nothing is spent.
  Under an allocation envelope a window bound by the project's share or the envelope total refuses with
  `allocation-cap` instead ([allocation](allocation.md)).
- After the run, the hold is replaced by what the job really cost. When that cost is not fully known (the job
  died before it reported, or some calls could not be priced), the window is charged at least the whole hold,
  and the measured cost when that is higher.
- A lower `maxCostUsd` on a trigger holds less, so more of its jobs fit in a window.
- A job whose every allowed model runs on a declared local model server and costs nothing holds nothing
  (`docs/egress.md`, "Local model servers").
- `scoped-limits.json` version 2 adds the same windows per repo or folder, and per model. A trigger's `models`
  list (or `PI_ALLOWED_MODELS`) decides which model windows its jobs hold their cap in: the listed models only.
  A job with no list holds its cap in every model window, since it may switch to any model. See
  [scoped limits](scoped-limits.md#dollar-windows-and-model-rows-version-2).

## A subscription allowance per job

A call on a subscription connection without paid extra usage bills nothing per call, so the dollar cap does not count
it ([what the cap counts](costs.md#what-the-cap-counts)). Without anything else, such a job's subscription calls have no
dollar limit at all: only the account's quota and the job's turn and time limits stop it. A trigger can give them one:

```json
{ "on": { "type": "label", "any": ["pi:triage"] },
  "run": { "kind": "github", "flow": "triage", "maxCostUsd": "1", "maxSubscriptionUsd": "40" } }
```

- `"maxSubscriptionUsd"` is a plain decimal, read exactly as `maxCostUsd` is: above 0, at most 1000000, with at most 6
  decimals, best quoted. A value the loader refuses is named by the trigger and the field, never the value.
- It counts the **list price** of the job's subscription calls: each call's price from pi's model catalog (and the
  overlay `models.json`) as the run record shows it, the `costNotional` part of the run's cost. That is the catalog
  price and nothing more: for an Anthropic call past 200,000 input tokens on a model the catalog does not tier, the cap
  charges a long-context surcharge on top (2 times the input side, 1.5 times the output), and the allowance does not.
  The runner checks it between calls, against what the calls so far settled at,
  and holds nothing for a call still running. So the calls already running when the allowance is reached finish and
  count, and a job with parallel subagents can end above it by what those calls cost. The next subscription call is not
  sent, and the whole run stops with reason `subscription-allowance` (exit 2, not retried).
- It never counts a call that can be billed. An API-key call, or a call on a connection with paid extra usage, is
  judged by the dollar cap alone, as before; the allowance can neither let one pass the cap nor stop one.
- No deployment value stands behind it. Absent means no allowance. There is no panel or environment setting.
- At 70% of it the run is warned once, as for the cap ([the warnings before the limits](job-limits.md#warnings-before-the-limits)).
- It is counted per attempt, as the cap is: each container starts again at 0, so a durable run's recovery, or a retry
  of a local job, can spend a further allowance.
- A watch rule refuses the field (`watch: unsupported run field`), as its jobs are built by name.
- A subscription call whose cost cannot be read (no cost at all, a cost that is not a number, or a negative one) leaves
  the total unknown, so the next subscription call is refused and the run stops with `subscription-allowance`. An answer
  whose counts are zero but whose price is a number adds that price. A model priced at zero adds nothing, so it is not
  bounded by the allowance, as it is not bounded by the cap either.
- A job with an allowance needs a job image that declares `subscriptionAllowance`. The shipped image does. On an older
  image the job is refused before it costs anything, with reason `job-image-subscription-allowance-unsupported`.
- It needs triggers file version 11, which the writers stamp, and a job of it is queued at job data version 12. A
  worker that reads less holds such a job (`newer-release`) until a worker that reads it picks it up, so nothing runs
  with the allowance dropped. A receiver or worker that dropped it anyway is caught as `trigger-skew`, naming the field,
  as for `maxCostUsd`. A value that does not parse on a queued job (a hand-built one) reads as 0, so the job's first
  subscription call is refused.
- A chained job keeps its parent's allowance. A console re-run of a forge or cron job takes the allowance its trigger
  sets now, as every other field of the re-run does; a re-run of an ad-hoc local job keeps the one that job carried.
- No AI tool can set or change it, in any spelling. A person can change it in the file or on the
  [trigger's page](console.md#what-a-triggers-jobs-get), which says raising or removing it is a widening.
- `pi-dispatch doctor` names it on a random pool that mixes billing classes, as what bounds its subscription draws.

The allowance is not a quota share: the account's five-hour and seven-day windows are shared by every job on it and read
only when a job starts, so no per-job share of them can be measured. See [subscription authentication](subscription-auth.md).

## Using the subscription quota reserve

A deployment can hold back the top of a Claude subscription window with `PI_QUOTA_RESERVE_PERCENT` on the host that
owns the connection ([the quota reserve](subscription-auth.md#quota-reserve)). At or above it, only jobs whose
trigger sets `quotaReserve` start:

```json
{ "on": { "type": "label", "any": ["pi:deploy"] },
  "run": { "kind": "github", "flow": "deploy", "quotaReserve": true } }
```

- Use it on the triggers that finish work already under way (the next pass on an open pull request, a fix, a deploy),
  so new first jobs wait while those still run.
- It is `true` or `false`; anything else, such as `"true"`, is refused when the file loads. Absent is `false`.
- Every trigger type takes it but a watch rule, which refuses it when the file loads.
- Every other job waits, and is never refused: it shows as `subscription-reserve` on the console's waitlists and starts
  when the window drops below the reserve or resets. It asks again at the reset or after five minutes, whichever is
  sooner, or after a minute when a random pool's or a fallback list's choice found every candidate held (the waitlist
  then names the earliest reset any blocked candidate knows, and the first blocked candidate's reason). A job of a
  trigger you mark meanwhile starts at its next ask; one of a trigger you unmark waits, even if it was queued before.
- A job with no trigger never passes the reserve: an ad hoc `pi-dispatch run` job, a job a run chains through its
  outbox, a watch investigation and an answer draft always wait above it.
- The worker on the host that owns the connection reads it from its own triggers file (`PI_TRIGGERS_FILE`, else
  `./triggers.json` where it runs) when the reserve would hold a job, so that host needs the file. Without it, or when
  the trigger that queued the job has changed or is gone, the job waits as if unmarked.
- No receiver carries it, so receivers and pollers of any release are fine. A worker from before this release holds no
  job on the reserve at all, so upgrade every host that owns a connection ([upgrading](upgrading.md)).
- It only matters for jobs on a Claude subscription. A ChatGPT connection publishes no percentages and is never held.
- No tool can set it: `dispatch_trigger_add` and `dispatch_trigger_edit` refuse a call that carries it, and an edit
  leaves it as it is. The trigger's page has no field for it. Write it in the file by hand.

## Flows in detail

**A skill arrives whole.** Put `references/`, templates or scripts next to your `SKILL.md`. They are
copied into the job container with it. A relative path in your skill will find a file that is actually
there. Three limits matter. Scripts arrive **non executable**. Everything under `/job` is read only.
Invoke them as `bash scripts/build.sh` instead of `./scripts/build.sh`. Files that start with a dot are
skipped. This matches how pi's own loader works. A skill directory has a size limit: 256 files, 8 MiB
total, 1 MiB per file, 4 levels deep. A repo that exceeds any of these limits refuses its jobs and
gives a reason naming the cap. This happens before anything is spent. The skill is not quietly copied
in part.

**`ai-trigger` controls a different choice.** It answers
which flows a model may fire. It does not answer who may fire a job. Only two paths read it. One is
the model-callable `dispatch_run` tool. The other is job chaining, which happens when a finished job
requests a follow-up. A cron entry or forge trigger in your reviewed `triggers.json` runs its flow
either way, because a human already approved that pairing by writing the file. Omitting the line does
**not** stop a label or comment trigger from firing. Who may fire a forge trigger is a separate gate
entirely. See [the five trigger types](#the-five-trigger-types-what-fires-each-one-and-what-it-runs)
above for details.

## Multi-stage workflows, and third-party pi extensions

A flow is one skill. A skill may call other skills. The simplest workflow is just that chain running
inside one job. For something more structured, **pi extensions stage into the deployment and load in every
job container**. They are pinned to an exact version and present offline.

**How a workflow gets triggered: nothing new fires it.** The chain is always the same. Every stage runs
inside the one job the trigger produced:

```text
label / comment / PR / cron  ->  one job, one container  ->  run.flow | run.command  ->  the skills it calls,
                                                                                         or a workflow extension
```

Four basics follow from that shape:

- **`run.flow` and `run.command` are the two entry points.** A trigger names a flow or a registered
  command, never a workflow. In a flow job, which stages run is decided inside the job by that skill. In
  a command job, the named command dispatches directly. Its arguments are fixed in the reviewed file.
- **A job is not an interactive session.** The container hands pi one assembled prompt and reads the exit
  line. That one prompt can be a slash command. `"command": "wf"` on a trigger dispatches a workflow
  extension's `/wf` (in the example below) exactly as a typed one would. There is no model turn in
  between. In a flow job a workflow starts because the flow's instructions drive it. Or it starts because
  you also staged a small extension that calls the workflow API from a lifecycle hook.
- **One trigger is one job, one budget slot, one turn budget.** Ten stages share the same
  `PI_MAX_TURNS` and the same per-job token budget. Exhausting either aborts the job as a policy refusal
  that is never retried. Budget for the whole chain, not per stage.
- **Whether state survives depends on the trigger kind.** A cron or CLI job has your folder mounted
  read-write. A workflow's own state persists between runs. A forge job gets a fresh clone, so its state
  does not survive.

Staging is the setup. It happens once on the host. If you already installed the package in pi, that is
the whole setup. The stager finds it and pins the exact version your host has.

```bash
pi install npm:@juicesharp/rpiv-workflow
pi-dispatch import-pi --with-packages   # installs on the host, always --ignore-scripts, into ./pi-global/packages/
```

Declaring a package by hand is still available. You can pin a version different from your host's. Or you
can add one your host does not have. An entry here wins over what was discovered:

```jsonc
// pi-packages.json (optional)
{ "packages": [ { "name": "@juicesharp/rpiv-workflow", "version": "2.4.0" } ] }
```

That example is a real pi extension. It chains skills into typed multi-stage workflows with per-stage
output validation and append-only JSONL state. pi-dispatch does not integrate it specially. That is the
point. **Any package whose `package.json` carries a `pi` manifest stages the same way**. One staged
directory can contribute extensions, skills, prompts and themes at once.

What the deployment provides is the plumbing and the limits. No package installs at job time. pi's
resolver runs offline in every job, which is why staging exists. Only exact versions are allowed.
Package code loads **last** so it can never shadow your repo's own skills. Any extension that tries to
register a `dispatch_*` tool is dropped. Set `"packages": false` on any trigger that must not load them. Every
package is printed by name with where it came from. Read that list before you rely on it: it is
everything that runs in every job.

Read where a workflow's own state lives before you build on it. It differs between
a cron job and a forge job. See [`docs/workflows.md`](workflows.md).

Resumable forge flows may declare typed approval gates with `run.gates`, an optional `run.gateTimeout`, and a bounded `run.gateBudgetRaiseUsd` for budget raises. See [approval gates](approval-gates.md) for configuration, decision surfaces and enforcement limits.

## Reviewed model roles

Use `run.model: "role:editor"` with an operator-reviewed `modelRoles` block to move all jobs of a role with one edit. See [model-roles.md](model-roles.md) for deployment/project precedence, agent inheritance and policy checks, [model-proposals.md](model-proposals.md) for catalog and retirement notices, and [canary.md](canary.md) for capped replay comparisons before adopting a candidate.


## Zero touch grouping configuration

The optional top-level `zeroTouch` section enables bounded private question capture and declares the classifier,
cap, confidence threshold and human-written group names. It never sends an answer. Grouping is an operator-confirmed
job through every normal budget/model/credential gate. See [Zero touch](zero-touch.md#group-repeated-questions) for
the schema, limits and privacy boundaries. It is separate from answer rules (#772). Like an answer rule
([a key of the rule's own](answer-rules.md#a-key-of-the-rules-own)), it may name its models' provider keys in
`secrets` and `secretsProfile`, which need file version 12.
