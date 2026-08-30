---
name: operate-pi-dispatch
description: How to operate a pi-dispatch deployment through its tools, and how to use the operator-confirm gates on the write tools (changing limits, adding/editing/deleting triggers).
---

# Operating pi-dispatch

pi-dispatch is a queue that runs paid autonomous agent jobs. The admin extension exposes tools to observe
and operate a deployment. Some tools only read; some turn processing on and off; some change money-affecting
configuration and are gated behind a human confirmation.

## The tools

Observe (no approval needed):
- `dispatch_status` — queue/worker state, today's budget, settings overlay, schedulers.
- `dispatch_runs` — recent run records (PII-free). Raw job logs are never available to tools.
- `dispatch_costs` — cost analytics folded from the run history: window totals (`window` = `7d`/`30d`/`mtd`),
  daily buckets, per-flow and per-model rollups, subscription plan verdicts, provenance (`flow` filters to
  one flow). Every dollar in the result is typed `{ usd, class, ... }` — quote the class with the number
  (`metered` is measured, `estimated`/`seeded` are not), and never present an estimate as an exact spend.
  The operator sees the same fold drawn as charts on the insights page (`/dispatch insights
  [7d|30d|mtd]` writes and opens it), and `/dispatch insights whatif <provider/model> --flow <flow>`
  estimates what a flow would cost per run on another model's rates.
- `dispatch_triggers` — the configured triggers with their array `index` (needed to edit/delete one).

Control (no approval needed — reversible and money-safe):
- `dispatch_pause` — stop starting new jobs (running ones finish). This is "turn dispatch off".
- `dispatch_resume` — re-enable processing. This is "turn dispatch on".

Start a run (paid, already gated producer-side):
- `dispatch_run` — enqueue one agent run against an allowlisted local folder.

## The human confirm gates — how to use them

These tools change money-affecting configuration and **each one asks the operator to approve a confirmation
dialog before it takes effect**:
- `dispatch_set` — change a limit/setting (e.g. `dailyCap`, `weeklyCap`, `maxTurns`, `model`). Omit `value`
  to unset.
- `dispatch_trigger_add` / `dispatch_trigger_edit` / `dispatch_trigger_delete` — manage triggers.
- `dispatch_pause_add` / `dispatch_pause_edit` / `dispatch_pause_delete` — manage scheduled pause windows
  (per folder/repo "quiet hours": runs for a scope are deferred between certain times and auto-resume after;
  `dispatch_pauses` lists them with their index). `dispatch_pause_edit` is a partial change — pass the index
  plus only the fields to alter. Deferring never drops a job and costs no budget.
- `dispatch_limit_add` / `dispatch_limit_edit` / `dispatch_limit_delete` — manage scoped limits (per
  repo/folder budget caps and concurrency: `day`/`week`/`month` job-count caps refuse a job pre-spend with
  reason `scope-cap`, never retried; `concurrent` defers the excess, never drops it; `dispatch_limits`
  lists them with their index and used counts). `dispatch_limit_edit` is a partial change — pass the index
  plus only the fields to alter. Scopes match exactly (a repo `owner/name` or an ABSOLUTE folder path, no
  globs).

Use them like this:

1. **State the change in plain language first**, with the concrete before→after, so the operator reading the
   confirm dialog knows exactly what they are approving (e.g. "I'll raise the daily cap from 25 to 30 — that
   allows more paid jobs per day").
2. **Call the tool.** The operator sees a confirm dialog with the exact change and approves or declines. You
   do not answer it — only the human does.
3. **Respect the answer.** If the result is `applied: false` (`reason: "operator declined"`), the operator
   said no. Accept it and stop — do **not** retry the same change, rephrase it to get a yes, or try to route
   around the confirm. If you believe the change is still needed, explain why and let the operator decide.
4. **If a tool is refused because no interactive operator is available** (headless/print mode), report that
   the change can't be made without an operator at the terminal — it is not a bug to work around.

The confirm is the approval step. Treat a decline as a final, legitimate answer.

## Setting up a deployment — `/dispatch setup`, and why you cannot run it

When the tools report no reachable deployment (queue unreachable, no configured paths), the fix is the
first-run wizard — and it is **operator-typed only**: there is no model-callable setup tool, on purpose.
Tell the operator to type `/dispatch setup`. It will, with a consent step per action: create a deployment
folder, npm-install the pinned runtime into it, hand the terminal to `pi-dispatch up` (whose own y/N
prompts gate the docker actions), optionally install the worker as a user-level service, write the
deployment pointer so the panel finds everything afterwards, and offer a first trigger for the repo the
session is in. What it will NOT do, ever: write into the operator's repo (the `ai-trigger: allow` line is
printed for them to commit), accept a credential through a dialog, or run anything with `--yes`.
Do not try to reproduce the wizard's steps through other tools or shell access — the sequencing exists
so each mutation carries its own human gate.

## Staged packages — `run.packages`, and why you cannot set it

When a trigger fires, the job loads the third-party **pi packages the operator staged** into their global
overlay dir (`PI_GLOBAL_PI_DIR`, under `packages/`, pinned by version). `run.packages` is an **opt-out**:
absent and `true` both load them, and only an explicit `run.packages: false` withholds them from that one
trigger. So the question to answer for a user is never "is this trigger armed" — it is "did this trigger
decline".

It matters because a loading trigger runs pinned third-party code against adversarial input (issue/PR/comment
text) with open network egress. So the panel makes it visible: a loading trigger is badged `[packages]` in
the trigger list, and its trust-model drill-in names the staged `name@version` set.

**Which packages are staged, and whether a trigger declines them, are both operator edits to reviewed files
— never a panel action and never a tool call.** This is deliberate, not a gap:

- `dispatch_triggers` shows you *whether* a trigger loads them. The `/dispatch` panel displays it too, and
  has no key that sets it.
- `dispatch_trigger_add` and `dispatch_trigger_edit` **have no `packages` parameter**. You can change it in
  neither direction — you cannot make a trigger load packages and you cannot make one decline them — the
  same reason `dispatch_run` withholds the provider and model from you.

So if a user asks you to change a trigger's packages flag, or to stage a package: **say plainly that you
cannot, and that it is an edit they make to `triggers.json` (and to their overlay dir) themselves.** Do not
attempt it through `dispatch_trigger_edit`, do not write the triggers file by another route, and do not treat
the missing parameter as a bug to work around. Reporting which triggers load the staged set and explaining
the change they would make is the whole of your part.

## The job image — `run.image`, and why you cannot set it

A trigger may carry `run.image`: the container image that trigger's jobs run in. Absent means the
deployment default (`PI_JOB_IMAGE`). It exists so one flow can have a Python toolchain and another Node +
Playwright, without one image carrying the union of both.

Report it when asked, and be precise about what it does and does not decide. **Which image a job runs is
which code it runs** — the pi version, the runner, the guardrail floor and the loader's discovery posture
all come from the image. What it does *not* decide is what the container may do: `--cap-drop=ALL`, the
non-root user, the read-only `/job` and the closed env allowlist are built by the worker for every image
alike. The panel shows the tag in the trigger list and states it in the drill-in either way.

**You cannot change it, in either direction.** `dispatch_trigger_add` and `dispatch_trigger_edit` have **no
`image` parameter**, `dispatch_run` has none, and there is no allowlist for you to consult — because there
is nothing model-callable to bound. Naming an image is an operator edit to the reviewed `triggers.json`,
exactly like `run.packages`.

So if a user asks you to point a trigger at a different image, or to build one: **say plainly that you
cannot, and that it is an edit they make to `triggers.json` themselves.** Do not route around it via
`dispatch_trigger_edit`, which changes the flow only. Two useful things you *can* say: the image must be
built or pulled on the worker's own host, because jobs run with `--pull=never` and nothing is fetched at
job time; and `pi-dispatch doctor` lists every image their triggers name and flags one that is missing.

## Vault secrets — `run.secrets`, and why you cannot set it

A trigger may carry `run.secrets`: a map of environment variable name to an opaque **reference**, plus
`run.secretsProfile` naming which of the operator's resolvers reads them. Before the container starts, the
worker runs that resolver once per reference on the HOST and injects the values into the job's environment.
It exists so one trigger can hold a deploy key while every other job on the deployment holds none.

Report it when asked, and be precise about the shape of the trade. **The job holds no vault credential.** It
receives values, never the thing that can fetch values, so it cannot enumerate the vault or reach anything
the operator did not name in a reviewed file. What that does *not* do is bound where a value can go once the
agent has it: the agent can read its own environment, and the forge is on the egress allowlist by necessity.
The panel shows the count and the profile name in the trigger list and in the drill-in, never the references.

**You cannot set it, in either direction.** No `dispatch_*` tool has a `secrets` parameter, and none has a
`secretsProfile` parameter either. The second absence is worth understanding rather than treating as an
oversight: a profile that resolves nothing is refused at load, and no tool can write `run.secrets`, so a
profile picker could never produce a valid trigger even once. It would be a control that looks like a grant
and is only ever an error.

You also cannot declare a **resolver profile**. That is `/dispatch secrets add`, which the operator types
themselves, because declaring one means naming an absolute host path the worker executes.

So if a user asks you to give a trigger access to a vault, or to wire up 1Password: **say plainly that you
cannot, and that both halves are theirs.** Three useful things you *can* say: declaring the manager is
`/dispatch secrets add`, and it is two questions (a name and the path to a one-line script such as
`exec op read --no-newline "$1"`); binding it to a trigger is an edit to `triggers.json` beside that
trigger's `flow`; and `pi-dispatch doctor` lists every declared profile, fails loudly when a trigger names
one that is not declared, and warns when a **local** trigger binds secrets, because a local job edits the
operator's own folder in place and a credential the agent writes into `.env` lands in their real repository.

## The forge a trigger listens to — `run.kind`

A webhook trigger names its forge: `"kind"` is `github`, `gitlab`, `forgejo` or `azure`. Everything else
about the trigger is the same — the `on.type`, the `{any, all, none}` label predicate, `flow`, `packages`,
`image`, `replicas`.

Three things are NOT the same, and all of them refuse at load rather than misbehaving quietly:

- **`pull_request` actions are the forge's own words.** GitHub takes
  `labeled | opened | synchronize | reopened | review_submitted | closed`; GitLab takes
  `open | update | reopen | approved | close`; Forgejo takes
  `label_updated | opened | synchronized | reopened | closed`; Azure takes `created | updated` and has
  no close word (a close trigger on azure is refused at load — not yet covered, not declined). A word
  from the wrong forge is refused when the file is written. It would not break anything otherwise — it
  would simply never match an event, and the trigger would look configured while doing nothing.
  The close word rides **alone**: a rule mixing it with other actions is refused, because a close is
  gated on the actor who closed the item where every other action gates on the author or a label.
  `review_submitted` is GitHub's `pull_request_review` event: it fires on **every** submitted review, so
  add `reviewState` (`approved | changes_requested | commented`) to narrow which verdicts are worth paying
  for. That field is github-only and legal only beside `review_submitted`; anywhere else it refuses at
  load, because a narrowing that cannot apply reads as one that does.
- **One `comment` trigger per forge.** Two GitHub comment triggers are refused; one GitHub and one GitLab
  are fine.
- **Azure names no repository.** A work item belongs to a project, so an azure `label` or `comment` trigger
  MUST set `run.repository` (the repo within the project to clone) and every other forge's must not. An
  azure `pull_request` trigger may not carry a label predicate at all: Azure tags work items, never pull
  requests, so `any`/`all`/`none` could never match and a rule that loads clean and never fires reads as a
  broken harness.

## Close triggers and one-shots — `on.once`, and the re-arm

Two shapes fire on a close: the `issue` trigger type (an issue closing, `on.action` in the forge's close
word), and a `pull_request` rule whose only action is the close word (on GitHub and Forgejo a merged PR
counts as closed; on GitLab only an explicit close fires it). Both
may carry `on.number` to pin one specific item, and `once: true` (which requires `number`) makes the rule
a **one-shot**: after one run the worker marks the entry spent by adding
`on.disarmed: { at, jobId }` to it in `triggers.json`. The entry is never deleted — run history
attributes by array position — so `dispatch_triggers` and the panel keep showing it, marked spent,
matching nothing.

Four things to say when an operator asks:

- **A failed run still spends it.** "Fired" means "produced a run record", so a one-shot whose job failed
  is spent too. The fix is the re-arm below, after they have read why it failed.
- **Re-arming is deleting `on.disarmed` from the entry** in `triggers.json`, nothing else. It is an
  operator file edit: no tool and no panel key writes or removes that mark, so say so plainly rather than
  reaching for `dispatch_trigger_edit` (which changes the flow only).
- **Authoring one**: `dispatch_trigger_add` takes `kind: issue` (plus `number` and `once`), behind the
  same confirm dialog as every trigger write, and a close-only `pull_request` rule accepts the same two
  fields. The shared validator refuses anything malformed, and `once` requires `number`.
- **Both services must read the same file.** The disarm is a worker write, so a receiver pointed at a
  different `triggers.json` stays armed; `PI_TRIGGERS_FILE` set to one absolute path is the fix, and
  `pi-dispatch doctor` warns about it. In the compose topology the receiver's read-only mount lags a
  disarm until restart, and the worker's own pre-spend check is what prevents a second run meanwhile.

## Racing two agents on one event — `run.replicas`

`"replicas": 2` on a `label`, `comment` or `pull_request` trigger turns one delivery into **two independent
paid jobs**: two containers, two branches (`pi/issue-7-r1` and `-r2`), two review requests, one human
picking. It works on every forge. Absent, nothing changes.

Three things to say when an operator asks about it:

- **It multiplies spend, and the caps are the only ceiling.** Each replica reserves its own budget slot
  before its own tokens, so a `replicas: 2` trigger firing ten times a day consumes twenty slots of the
  daily cap, not ten. Nothing is discounted; that is the feature, not an oversight.
- **You cannot set it from here.** There is no `replicas` parameter on `dispatch_trigger_add` or
  `_edit`, and no panel key. It is a reviewed edit to `triggers.json`, deliberately: a spend multiplier is
  plainly a capability a model should not gain. Say so rather than looking for a way around it.
- **It refuses on cron, beside `resume`, and beside `once: true`.** A local job's `/workspace` IS the
  operator's folder, so two replicas would edit one working tree with no gate and no undo. A resumed run
  continues one lineage where replicas exist to fork it. And a one-shot promises exactly one run, which N
  racing sandboxes contradict.

`dispatch_trigger_add` takes an optional `forge` parameter, defaulting to `github`. Unlike `image`, this
one IS offered to the model — a model that can already add a GitHub trigger can already arm a paid run,
and naming GitLab instead does not widen that. Both paths stay behind the same operator confirm.

If you are asked why a GitLab trigger did not fire, the usual answers in order:

1. **The actor was not a Developer.** Every GitLab trigger is gated on the actor's project access level,
   including label triggers — a GitLab label is not an approval the way a GitHub one is.
2. **No label was added by that event.** GitLab has no `labeled` action; the trigger fires on the labels
   an event *added*, so editing an already-labelled issue does nothing. This is deliberate.
3. **The action word belongs to the other forge.** See above.

## Scoped limits — and the folder mutex you cannot turn off

`scoped-limits.json` holds per-scope bounds beside the deployment-global ones: `day`/`week`/`month` cap
how many jobs a repo or folder may run per window (refused pre-spend, reason `scope-cap`, never retried,
the scope's own counter still counts the refusal), and `concurrent` caps how many run at once (the excess
is deferred to the delayed set and runs when a slot frees — never dropped, no budget spent while waiting).
Edits apply live: the worker hot-reloads the file and keeps the last good version on a bad edit.

Separate from all of that, **local jobs carry a built-in one-job-per-folder mutex: at most one job per
folder at a time, always on, with NO configuration, NO tool, and NO panel key.** If an operator asks to
disable it, say plainly that there is no switch, deliberately: two agents editing one working tree race
each other with no gate and no undo, and an off switch's only use is re-opening that race. A `concurrent`
value on a folder scope can never raise the mutex's one-at-a-time (the lower bound always wins).

Three more things to say when asked:

- **A `scope-cap` refusal is final for that window.** The counter is not resettable from any tool; the
  window rolls over on its own (day/week/month, UTC). Raising the cap via `dispatch_limit_edit` takes
  effect at the next job.
- **Deferrals are visible only as the queue's delayed count** (the panel's status line shows it when it
  is nonzero). That count also includes cron next-occurrences and retry backoff — a nonzero number is
  normal on any deployment with schedules.
- **Per-scope in-flight is not displayed anywhere.** The panel and `dispatch_limits` show `concurrent` as
  configuration only; the live count lives inside the worker process and no reader can see it.
