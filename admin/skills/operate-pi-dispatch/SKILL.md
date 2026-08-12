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

## The forge a trigger listens to — `run.kind`

A webhook trigger names its forge: `"kind": "github"` or `"kind": "gitlab"`. Everything else about the
trigger is the same — the `on.type`, the `{any, all, none}` label predicate, `flow`, `packages`, `image`.

Two things are NOT the same, and both refuse at load rather than misbehaving quietly:

- **`pull_request` actions are the forge's own words.** GitHub takes
  `labeled | opened | synchronize | reopened | review_submitted`; GitLab takes
  `open | update | reopen | approved`. A word
  from the wrong forge is refused when the file is written. It would not break anything otherwise — it
  would simply never match an event, and the trigger would look configured while doing nothing.
  `review_submitted` is GitHub's `pull_request_review` event: it fires on **every** submitted review, so
  add `reviewState` (`approved | changes_requested | commented`) to narrow which verdicts are worth paying
  for. That field is github-only and legal only beside `review_submitted`; anywhere else it refuses at
  load, because a narrowing that cannot apply reads as one that does.
- **One `comment` trigger per forge.** Two GitHub comment triggers are refused; one GitHub and one GitLab
  are fine.

`dispatch_trigger_add` takes an optional `forge` parameter, defaulting to `github`. Unlike `image`, this
one IS offered to the model — a model that can already add a GitHub trigger can already arm a paid run,
and naming GitLab instead does not widen that. Both paths stay behind the same operator confirm.

If you are asked why a GitLab trigger did not fire, the usual answers in order:

1. **The actor was not a Developer.** Every GitLab trigger is gated on the actor's project access level,
   including label triggers — a GitLab label is not an approval the way a GitHub one is.
2. **No label was added by that event.** GitLab has no `labeled` action; the trigger fires on the labels
   an event *added*, so editing an already-labelled issue does nothing. This is deliberate.
3. **The action word belongs to the other forge.** See above.
