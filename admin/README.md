<p align="center">
  <img src="https://raw.githubusercontent.com/edgehero/pi-dispatch/main/docs/images/banner.png?v=0.5.0" alt="pi-dispatch: run the pi coding agent as a self-hosted service" width="880">
</p>

# pi-dispatch: run the pi coding agent as a self-hosted service

**Let a coding agent work on your repositories while you are not watching, without surprise bills and without giving it the keys to your machine.** [pi](https://github.com/earendil-works/pi) is a superb coding agent, but it has no job queue, no spend limit, and, by its own README, no permission system. pi-dispatch adds exactly those, so you can run pi unattended and safely: on a cron schedule, on your repo's issues and PRs, or straight from the CLI. Every job runs in an isolated container, spend is bounded before a single token is spent (per deployment and per-repo or per-folder), and everything the agent did (and what it cost) is recorded, graphed and priced for you. On a forge you stay in the loop at both ends: a job starts only when someone with write access to the repo asks for one, by a label, an `@pi` comment or a review, and what comes back is a pull request you review and land, because pi-dispatch never merges anything. This is not another agent to weigh against the one you already use; it is the queue, the budget and the box for the pi you already run.

> This npm package, **`@edgehero/pi-dispatch-admin`**, is the **operator console** (a pi extension). The service itself is `@edgehero/pi-dispatch` (worker + CLI) and `@edgehero/pi-dispatch-receiver` (the webhook edge); the [main repo](https://github.com/edgehero/pi-dispatch) has the container image, docs, and SECURITY.md.

## How it works

Every trigger produces the same job, through the same path: one queue, one container, one budget.

```
   CLI · cron · label / comment / PR on GitHub, GitLab, Forgejo or Azure DevOps
                │  enqueue
                ▼
        Valkey + BullMQ            durable queue: survives reboots, absorbs bursts
                │
                ▼
     under the daily cap +         if not: refused here, before any spend
       per-job turn budget?
                │  yes
                ▼
        docker run --rm            one ephemeral container per job: --cap-drop=ALL,
                                   --security-opt no-new-privileges, memory/CPU/pids
                                   limits, /job mounted read-only
                │
                ▼
     pi + your .pi/skills          edits your code in place, opens a PR or MR, comments back
```

The container is the boundary (pi's missing permission system, enforced by Docker). Those isolation flags are built by the worker's own `docker run` argv, so nothing an image contains can weaken them; the non-root user is a property of the **image**, which is why an image has to meet the conformance checklist in [`docs/job-image.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/job-image.md). Spend is checked before a container starts, so a runaway or a junk trigger costs a refusal, not a surprise bill. The job image is yours to shape, per deployment or per trigger, and it ships Playwright and Chromium so a flow can build a frontend, screenshot it, and iterate on the render.

## Triggers: what starts a job

Every trigger is one `{ on, run }` entry in a single `triggers.json`, read live by the worker (cron) and the receiver (forge webhooks), and editable from the console. **`on` is what fires it; `run` is the skill it runs.**

| `on.type` | Fires on | What narrows it | What the agent gets as its task |
|---|---|---|---|
| `cron` | your schedule | nothing: a schedule is its own condition | the `task` written in the file |
| `label` | a label on an **issue** (or an Azure work item), never a pull request | a label predicate: `any`, `all`, or `none` (which can suppress a fire, never cause one) | the issue title and body |
| `comment` | a comment containing your phrase, for example `@pi` | the phrase, and one comment trigger per forge | the comment body, plus the issue title and body |
| `pull_request` | a PR or MR event, including its close (the close word rides alone, never mixed with other actions; on GitHub and Forgejo a merged PR counts as closed, on GitLab only an explicit close fires it) | `action`, in your forge's own words, plus the same label predicate; on a close-only rule, `number` and `once` instead | the PR title and body |
| `issue` | an issue closing | `action` (the forge's close word), `number` to pin one issue, `once: true` for a one-shot that spends itself after a single run | the issue title and body |

Four forges: GitHub, GitLab, Forgejo (and Gitea), Azure DevOps. **Who may fire a trigger is your forge's decision, not this service's**: on GitHub the label *is* the approval, because only collaborators can apply one, while GitLab, Forgejo and Azure resolve the actor's permission through their APIs. A close trigger is gated on the actor who **closed** the item, resolved the same way (Azure has no close trigger yet: it refuses at load rather than never matching). Each forge's action vocabulary is validated when the file loads, so a word from the wrong forge is refused instead of silently never matching.

**Flows, and workflows.** `run.flow` names a skill committed to the target repo at `.pi/skills/<flow>/SKILL.md`, read from the **default branch**, so the repo owns the prompt and merging it is the repo's consent. A skill may call other skills, which is already a workflow. For typed multi-stage ones, a pi extension such as `@juicesharp/rpiv-workflow` can be staged into the deployment: pinned to an exact version, installed on your host (never at job time, since jobs run offline), loaded in every container, and declinable per trigger. Anything you already installed with `pi install` is staged automatically, at the version your host has, so there is nothing to declare twice. `run.command` is the second entry point: instead of a flow, a trigger may name a registered command a staged extension provides (`"command": "wf run nightly"`), and the job's whole prompt is that dispatch line, handled by the extension with no model turn in between. It picks which vetted command dispatches, never what code runs, and it is never AI-triggerable: job chaining refuses any request naming one, and `dispatch_run` cannot express one.

**How a workflow gets triggered, in one line:** `label / comment / PR / cron` fires **one job in one container**, that job runs `run.flow` or `run.command`, and the entry point drives whatever stages follow. Four consequences worth knowing before you build on it. A trigger names a **flow or a registered command, never a workflow**, so which stages run is decided by what that entry point does. A job is **not an interactive session** (the container hands pi one assembled prompt and reads the exit line), and that one prompt can be the command itself: `run.command` dispatches a workflow extension's slash command headlessly, while in a flow job the flow's instructions drive the workflow, or a small extension you also staged calls its API from a lifecycle hook. One trigger is **one job, one budget slot and one turn budget**, so ten stages share the same `PI_MAX_TURNS` and per-job token budget, and exhausting either ends the job as a policy refusal that is never retried. And whether the workflow's own state survives depends on the trigger kind: a cron or CLI job has your folder mounted read-write so state persists between runs, while a forge job gets a fresh clone that is discarded with the container. Full reference: [`docs/workflows.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/workflows.md).

## The console: `/dispatch`

One command puts a live TUI over the whole deployment:

<p align="center">
  <img src="https://raw.githubusercontent.com/edgehero/pi-dispatch/main/docs/images/dispatch-dashboard.png?v=1.0.0" alt="The /dispatch panel: status, spend meters, triggers (including a command trigger shown as its /name), pause windows, scoped limits, runs, and settings" width="820">
</p>

- **Status and spend.** Queue and worker state, day/week/month spend meters, a daily token counter, and a run-history table with per-job tokens and cost.
- **Insights, the one analytics page.** Press `i` on the panel (or type `/dispatch insights`) and a single self contained page opens in your browser: the budget dials (the one lever that actually changes what all of this costs), per-plan verdicts against API rates, daily, cumulative and per-flow spend charts, the four breakdowns (flow, trigger, model, repo), and the whole trigger and flow topology with spend badged onto the triggers that earned it. Every dollar carries its class: a plan-covered run never renders as $0.00, and an estimate is always marked as one. Design your agent loops as triggers and skills, see the loops you actually built, and see what each one costs, all in one place ([`docs/insights.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/insights.md)).

<p align="center">
  <img src="https://raw.githubusercontent.com/edgehero/pi-dispatch/main/docs/images/insights-view.png?v=1.0.0" alt="The insights page: KPI tiles, a plan verdict card, the daily spend chart, the four breakdowns with plan-covered buckets drawn as chips instead of dollar bars, and the topology with spend badges and tier-resolved flows" width="820">
</p>

- **Triggers, editable live.** cron, label, comment, pull_request and issue triggers with colored drill-ins showing what fires each one, what it runs, and its trust model. Added, edited and deleted without a restart. A one-shot (`once: true`) shows armed or spent in its drill-in: a spent entry stays in the list, matches nothing, and re-arms when the operator deletes its `on.disarmed` mark from the file. Triggers that run third-party code or a custom image are badged; opting in or out of either stays an edit to the reviewed `triggers.json`, which neither the console nor a model-callable tool will make for you.
- **Quiet hours.** Scheduled pause windows per folder or repo: defer runs between certain times, timezone-aware, and resume automatically. Deferred, never dropped, at zero budget cost.
- **Scoped limits.** Per-repo or per-folder job caps (day, week, month) refused before any spend, plus a per-scope concurrency ceiling enforced by deferral. Local jobs also hold a one-job-per-folder guard that is always on and has no switch (it lives in the worker process, and one worker per docker daemon is the supported shape), because two agents editing one working tree race each other with no gate and no undo.
- **Held jobs, with what they are waiting for.** A trigger carrying `run.waitFor` holds its job in the queue, unstarted and unbilled, until an instant passes or a check script the operator wrote exits 0. The panel grows a **held** section while anything waits (the target, the condition, and how long it has waited) and hides it again when nothing does, so a wait stops being an anonymous entry in the delayed count. `dispatch_waits` lists them and `dispatch_wait_cancel` stops one behind the operator confirm, which is the only way to cancel a held job short of editing redis by hand ([`docs/wait-for.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/wait-for.md)).
- **AI-operable, with a human gate.** Model-callable tools let an agent change limits (global and scoped) and manage triggers and pause windows, and every **config** write pops an operator confirmation the model cannot answer, refusing outright when no operator is present. Two tools sit outside that gate on purpose: `dispatch_pause` and `dispatch_resume` write durable queue state but are reversible and spend nothing, so they carry no confirm. One more sits outside it and is **not** money-safe: `dispatch_run` enqueues a **paid** run that edits a local folder in place with no undo, bounded instead by six independent limits (the `PI_DISPATCH_RUN_ROOTS` folder allowlist, a committed per-flow `ai-trigger: allow` opt-in read at a pre-agent SHA, a dirty-tree refusal with no force option, no spend knobs on the tool, a per-hour rate limit, and the worker's daily cap). Commands sit outside its reach entirely: `dispatch_run` speaks flows only, and a chained job's request naming a `command` is refused outright, with no opt-in. Read [`SECURITY.md`](https://github.com/edgehero/pi-dispatch/blob/main/SECURITY.md) on that one before you enable it. The bundled `operate-pi-dispatch` skill teaches the agent those gates.
- **Logs stay put.** Raw container output renders only in the overlay viewer, never into model context.

## Install

```bash
pi install npm:@edgehero/pi-dispatch-admin   # then, in pi:  /dispatch
```

**This is the default way to set up pi-dispatch.** With nothing configured, `/dispatch` takes you straight into guided setup, in this order: an opening choice, a deployment folder, a Docker check with per-OS pointers if it is missing, a consented npm install of the pinned runtime (Docker is checked **first** on purpose, so no bandwidth is spent on a host where `up` cannot work anyway), `pi-dispatch up` running its own prompts in your terminal, the deployment pointer that lets `/dispatch` find this deployment from any directory, a notice naming the file your provider key belongs in, an optional worker service, optional GitHub App credentials (`setup github`, the one step that mints a private key), an optional trigger edge (receiver service, docker compose profile, or the polling command), and an optional first **cron** trigger for the repo you are sitting in. Every step shows what it will do, asks first, and can be declined; nothing is written into your repo and no credential passes through a dialog. A deployment whose queue is merely down keeps the unreachable banner instead: setup appears when there is nothing, never over an outage.

Already have a deployment? The panel finds it through the deployment pointer setup writes, or through the same env vars your worker uses (`VALKEY_URL`, `PI_LOGS_DIR`, `PI_SETTINGS_FILE`, `PI_TRIGGERS_FILE`, `PI_PAUSE_WINDOWS_FILE`, `PI_SUBSCRIPTIONS_FILE`). Your env always wins.

`dispatch_run` is inert until you set one more variable yourself: `PI_DISPATCH_RUN_ROOTS` defaults to empty, and an empty allowlist refuses every folder. The deployment pointer deliberately cannot set it (the pointer carries paths, never capability grants), so widening that allowlist is always your own env edit. No allowlist reaches commands either: a `run.command` fires from the reviewed triggers file only.

## Get the whole thing

### → **https://github.com/edgehero/pi-dispatch**

MIT, self-hosted. Read [`SECURITY.md`](https://github.com/edgehero/pi-dispatch/blob/main/SECURITY.md) before you rely on it; it states plainly what is and is not defended. Short version: the trust model is a GitHub Action's, so whoever can merge to your default branch can instruct the agent.
