# Triggers: the full reference

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

## The five trigger types: what fires each one, and what it runs

pi-dispatch is the trigger layer. Every entry is one `{ on, run }` pair: **`on` is what fires it**, and
**`run` is what it runs**, either a flow or a registered command (`flow` names a `.pi/skills/<flow>` in
the target repo: see [Flows](../README.md#flows-the-custom-prompt-a-trigger-runs) for what that file is, and
[Multi-stage workflows](#multi-stage-workflows-and-third-party-pi-extensions) for chaining skills or
staging a workflow extension).

| `on.type` | Fires on | Required in `on` | What narrows it | What the agent gets as its task |
|---|---|---|---|---|
| `cron` | your schedule | `id` (unique, no `:`) · `pattern` (5 or 6 cron fields) | nothing: a schedule is its own condition | `run.task`, written in the file |
| `label` | a label on an **issue** (or an Azure work item), never a pull request | at least one positive selector, `any` or `all` | the label **predicate**: `any` (any of these) · `all` (all of them) · `none` (suppress-only, it can prevent a fire but never cause one) | the issue title and body |
| `comment` | a comment containing your phrase | `phrase`, for example `@pi` | the phrase, and **one comment trigger per forge** | the comment body plus the issue title and body |
| `pull_request` | a PR or MR event, including a submitted GitHub review, and including its close (the close word rides **alone**, never mixed with other actions; on GitHub and Forgejo a merged PR counts as closed, on GitLab only an explicit close fires it) | `action`, a non-empty array in your forge's own words | `action`, plus the same label predicate; where the forge has a label action and you name it, a positive selector becomes **required**; on a GitHub review, also `reviewState`; on a close-only rule, `number` and `once` instead of the predicate | the PR title and body, plus the review body when a review fired it |
| `issue` | an issue closing, and only that (labels have `label`, phrases have `comment`) | `action`, the close word in your forge's own words | `number` pins it to one issue (on GitLab, the iid); `once: true` makes it a one-shot and requires `number` | the issue title and body |

One variation changes that last column for every type. A trigger that names `run.command` instead of
`run.flow` gives the agent exactly `/command args` as its whole prompt. The issue, comment or PR text
waits in `/job/event.json` for the command's handler to read (see
[Multi-stage workflows](#multi-stage-workflows-and-third-party-pi-extensions)).

Every type also needs `run.kind` (`local` for cron, else the forge). You must pick exactly one of
`run.flow` or `run.command` (naming both, or neither, refuses to load in both services). Cron additionally
needs `folder` (a host path the worker checks exists when it loads the file; make it absolute, since a
relative path resolves against the worker's own directory) and, with `flow`, a `task`. Azure `label` and
`comment` triggers need `run.repository`, because a work item belongs to a project and names no repository.
The webhook types also charset check `run.flow` at load (skill names are lowercase). A flow that could
never name a repo skill is refused when the file loads, at no cost, instead of failing inside a paid
container.

Two matching behaviours to know before you turn on a paid trigger:

- **A comment can choose the flow.** `<phrase> <flow>` in the comment body overrides the trigger's
  `run.flow` whenever that word matches another trigger's flow in the same file. So `run.flow` is a
  default rather than a fixed pairing. On a rule that names `run.command` this channel is inert. Trailing
  words never retarget or suppress the command, and reach the job only as data in `/job/event.json`.
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

Two behaviours to know before you turn it on. A **Comment** type review whose remarks are all line comments
and whose summary box is empty starts nothing. Those remarks arrive on an event this service
does not read, so the review reaches us empty. Approve and Request changes still fire with an empty summary,
since there the verdict is the signal. The bot loop guard knows only **our own** identity. Another
bot that reviews (a CI bot, a review service) can start jobs if it holds write access.
[`SECURITY.md`](../SECURITY.md)
states both, and the flow gets `review.id` in `/job/event.json` so it can fetch the line comments itself.

**Who may fire a trigger is not ours to grant.** Your forge decides that, differently per forge.
[`SECURITY.md`](../SECURITY.md) states each one plainly (short version: on GitHub only collaborators can
apply a label, which is why the label *is* the approval there; GitLab, Forgejo and Azure resolve the
actor's permission through their APIs because a label proves less on those). The always-on gates that
every delivery passes are the signature check, the bot-loop guard, that permission check, dedup, quiet
hours, the image preflight, branch protection, and the spend caps. None of them are per-trigger.

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

Spending is written into the file itself. After the run record exists, the worker adds
`"disarmed": { "at": ..., "jobId": ... }` to the entry's `on`. The entry is never deleted, because run
history refers to triggers by their position in the file. A spent entry still shows in the panel with a
spent marker while
matching nothing. Deleting `on.disarmed` re-arms it; nothing else is needed. A one-shot whose
run **failed** still counts as fired. The record is the definition, so a failed run spends it too. The
fix is that same one key deletion.

Four deployment notes:

- Point both services at the **same** file (`PI_TRIGGERS_FILE`, absolute; `doctor` warns).
- In the shipped compose topology the receiver's read-only single file mount keeps serving the old
  bytes after a disarm until the container restarts. The worker's own check before any spend is what prevents
  a second run meanwhile.
- The polling transport carries closes too. The events feed includes them. A close trigger needs no
  public URL.
- A symlinked `triggers.json` is replaced by a real file on the first disarm. Keep the real file at
  the served path and symlink the other direction.

## Optional `run` fields

Each one is a deliberate edit to the file: neither the panel nor any AI tool can set it, because each one
changes what code runs or what it costs.

- `"command"` replaces `flow`. You can use exactly one of the two on any trigger type. The job runs a
  registered pi extension command headlessly, with no interactive session. The whole prompt is `/command
  args`. The arguments are fixed in the reviewed file. The event text reaches the handler only as
  `/job/event.json`, which it reads itself. A command is never AI-triggerable. Job chaining refuses any
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

- `"secrets": { "STRIPE_KEY": "op://ci-vault/stripe/api-key" }` names vault references this trigger's
  jobs receive as environment variables. Use `"secretsProfile"` to choose which of your declared
  resolvers reads them. The worker runs your one line script (`exec op read --no-newline "$1"`) on the
  host before the container starts. The job gets values. It never gets your manager's credential
  ([`docs/secrets.md`](secrets.md))

- `"waitFor": [{ "after": "2026-09-01T09:00:00Z" }, { "profile": "jira" }]` holds this trigger's job in
  the queue, unstarted and unbilled, until every condition clears. An instant costs nothing. A profile
  names one of your own check scripts. The worker runs it on the host and reads the exit code
  ([`docs/wait-for.md`](wait-for.md)).

- `"resume": true` continues the session that opened the PR ([`docs/sessions.md`](sessions.md)).

- `"github": true` on a cron trigger gets the same per-job GitHub token the webhook path gets. A
  scheduled flow can use `gh`.

- `"portfolio": true` on a cron trigger makes its jobs portfolio jobs: the one kind of job that may send a
  budget priorities plan back ([`docs/allocation.md`](allocation.md)). Cron only. The file refuses it on a webhook
  trigger, and beside `"command"`, because a plan should come from a flow you reviewed. It must be `true` or `false`.
  When such a job starts, the worker reads the triggers file again. If the flag is gone, or the entry with that
  id now has another folder, flow, command or task, the job runs as an ordinary cron job. If the flag is there and this worker's envelope does not let `portfolio-job` write a plan (no
  envelope, `delegation.enabled` false, or `portfolio-job` not in `delegation.writers`), the job is refused as
  `portfolio-no-envelope` before it costs anything. A chained child never inherits the flag. A working flow to
  copy is in [`docs/portfolio-manager.md`](portfolio-manager.md).

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

- `"provider"` is a pi provider id, such as `anthropic` or `openai`.
- `"model"` is that provider's model id. Case is kept as you wrote it.
- `"maxTurns"` is a whole number of 1 or more.

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

## Limiting which models a job may call

`"models"` lists the models a trigger's jobs may call, on any trigger type:

```json
{ "on": { "type": "label", "any": ["pi:triage"] },
  "run": { "kind": "github", "flow": "triage", "provider": "openai", "model": "gpt-5.4-mini",
           "models": ["openai/gpt-5.4-mini", "anthropic/claude-haiku-4-5"] } }
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
  `fallbacks` or `providerOptions` in `samplingParams`, an Azure deployment chosen per call, or a
  caller's own `fetch`. Other `samplingParams` keys, such as `min_p`, `reasoning_effort`,
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

No AI tool can set `models`. Edit the file. `dispatch_trigger_add` and `dispatch_trigger_edit` refuse a
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
refused as `trigger-skew` when that neighbour sets `models` or `maxCostUsd`. The comment says the trigger
changed after the job was queued. Re-run those jobs too. Upgrade the worker and the receiver together, and restart the
receiver after editing the file.

Everything else is editable from the panel (`a` adds kind-first, `e` edits the flow, `x` deletes) or via
the confirm-gated AI tools. Every write is validated. Both services reload it live. The worker itself
writes exactly one thing back, the `on.disarmed` mark. That mark spends a one-shot. Every local job also
receives a read-only `/job/event.json`. It contains source, folder, and HEAD sha. Cron adds its id,
pattern and schedule instants. A scheduled flow can triage only what changed since its last run.

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
- The runner checks it before every model call. A call that could take the job past the cap is not sent,
  and the run stops with reason `cost-cap`.
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
  carries it, and an edit leaves it as it is. `dispatch_triggers` and the panel show it.

**Upgrading, and services out of step.** The same as for `models` above: a receiver from before this
release drops `maxCostUsd`, and its job would run under the deployment's cap or none. The worker refuses
such a job before it spends (`trigger-skew`, naming the field), when it can read the triggers file. The
check is strict: adding `maxCostUsd` to a trigger refuses the jobs of it that were already queued
(`trigger-skew`). Re-run them. Upgrade the worker and the receiver together. `pi-dispatch doctor` reminds you
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
