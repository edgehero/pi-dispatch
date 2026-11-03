<p align="center">
  <img src="docs/images/banner.png?v=2026-11-03" alt="pi-dispatch: hand software work to an AI coding agent, and decide how closely you watch it" width="880">
</p>

# pi-dispatch

**Hand routine software work to an AI coding agent, and decide for yourself how closely you watch it.**

pi-dispatch runs the [pi](https://github.com/earendil-works/pi) coding agent for you in the background, on your own
computer or server. You say what it should work on and when. Each job happens in a sealed box that is thrown away
afterwards, stops at the spending limit you set, and shows up live on one web page. When it works on a project on GitHub
or GitLab, you get back a proposed change to review. pi-dispatch never merges anything, so what ships stays a person's
decision.

It is free and open source. You pay your AI provider for what the agent uses, or use a subscription you already have.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/console/console-overview-dark.png?v=2026-11-03">
  <img src="docs/images/console/console-overview.png?v=2026-11-03" alt="The console's overview page: one question and two jobs that need you, five jobs waiting and why, four running, 15 dollars spent of a 25 dollar daily limit, and a timeline of every project's runs with the jobs in line after the now line">
</picture>

<sub>The overview: what needs you, what is waiting, what is running and what today has cost. Every screen on this page shows sample data.</sub>

## Install in four steps

**1. Have these ready.** A computer or server that stays on (on a Mac or Windows machine, jobs run only while you are logged in),
[Docker](https://www.docker.com/products/docker-desktop/) and [Node.js](https://nodejs.org) 22.19 or newer, and a key from an AI
provider or a [subscription](docs/subscription-auth.md). Steps 1 and 2 are for someone comfortable in a terminal.

**2. Install it.** If you already use pi, run this, type `/dispatch` inside pi, and choose **Finish setup in browser**:

```bash
pi install npm:@edgehero/pi-dispatch-admin
```

Without pi, install into a folder that will stay there:

```bash
mkdir my-dispatch && cd my-dispatch
npm install --save-exact @edgehero/pi-dispatch@4.3.1 @edgehero/pi-dispatch-admin@4.3.1 @earendil-works/pi-coding-agent@1.5.0 --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
./node_modules/.bin/pi-dispatch up --console
```

It asks before it starts anything, then prints a sign in link that works for 60 seconds.

**3. Finish the checklist in your browser.** The link opens a live list of what is ready and what is not: the queue, a worker, the
network rules, your provider key and a first trigger. It offers recipes: fix an issue when it gets a label, tidy every night, or
answer a comment.

![The setup page: each step of a new deployment marked ready, starting, not yet or to do, with a button for the next action and recipes for a first trigger](docs/images/console/console-setup.png?v=2026-11-03)

<details>
<summary>Prefer the terminal? What <code>pi-dispatch doctor</code> checks</summary>

![pi-dispatch doctor: one line per check, two warnings with their fixes, and the ready verdict](docs/images/cli-doctor.svg?v=2026-11-03)

</details>

**4. Bring your own pi setup, if you have one** ([below](#bring-your-own-pi-setup)), and [run a first job](#how-to-use-it). Running it on a
server for good has [its own steps](#set-up-a-host).

## Why: from in the loop to out of the loop

Working with a coding agent usually means sitting next to it. You type, it works, you check, you type again. That is
the right way to start, but one person can only watch so much. pi-dispatch lets you step back at your own pace, one kind
of work at a time, and it never asks you to trust more than you have seen.

### 1. In the loop: watch it work and step in

You start a job and follow it live: what it is doing, which step of its plan it is on, what it said. If it heads the
wrong way you tell it, and it reads your message before its next step. You do not have to start over and pay for the
same work twice. ([Steering](docs/steering.md), [chat](docs/chat.md))

![A running job in the console: its progress through the phases of its plan, the agent's note that three of ten tables are migrated, a box for sending it a message, the message it already received, and its live transcript](docs/images/console/console-run-live.png?v=2026-11-03)

### 2. Near the loop: it comes to you when it needs you

Now it works alone, and you hear from it only when it has a question or needs permission. A job with a question stops
and waits. Nothing runs and no model is paid for while it waits, and your answer picks the work up where it stopped. A
gate can make it ask before a named action, and a rule you write can have an answer drafted for you to read and send. A
question is the agent's own words, so your instructions decide how it asks: what it found, your options, what it recommends.
([Parked questions](docs/sessions.md#parked-jobs-the-agent-asks-then-waits), [approval gates](docs/approval-gates.md),
[answer rules](docs/answer-rules.md))

![A run that stopped to ask: what it found, three options with what each costs, what it recommends, and a box for your answer](docs/images/console/console-question.png?v=2026-11-03)

### 3. Out of the loop: you review what comes back

Now the work starts without you: on a schedule, when someone labels an issue or comments on it, or (as a read only
investigation) when an alert comes in. You read the results when it suits you. **Zero touch** tells you how far you have
come: how often runs needed a person, per project, over the last 7, 30 or 90 days.
([Triggers](docs/triggers.md), [watching alerts](docs/watch.md), [Zero touch](docs/zero-touch.md))

![The Zero touch page: how often runs needed a person, what the cause was, and which projects run without help](docs/images/console/console-zero-touch.png?v=2026-11-03)

Out of the loop does not mean out of control. The spending limits hold with nobody watching, every job stays in its
box, and a person still merges.

## Is this for you?

It works on code: a project on GitHub, GitLab, Forgejo or Azure DevOps, or a folder under git on your own machine. It fits
when the same kind of software work keeps coming back and you would rather not sit through it:

- a nightly job that tidies a code base, updates a report or sorts new issues;
- "label an issue and a proposed fix appears", for small everyday fixes;
- answering review comments on the changes the agent proposed;
- several projects sharing one queue, one budget and one page.

For a one off task on your own machine, plain pi is enough.

## Common worries

**Do I need to be a developer?** To use it day to day, mostly not: the web page is where you read what happened, answer
questions, approve, add a schedule and change limits, and you describe a recurring job in plain sentences. To set it up
you need someone comfortable in a terminal, and now and then for a setting the page does not offer. And what it hands you
is code, so someone should be able to judge it before it ships.

**Can it run up a bill?** You set limits in dollars and in jobs, per day, week and month, for everything or per project. A
job over a limit is refused before it starts, and a job with its own cap is stopped before any model call that could
take it past that cap. Also set a spending limit at your AI provider, as a last line
([costs](docs/costs.md), [limits](docs/scoped-limits.md)).

**Can it break my project?** On GitHub, GitLab, Forgejo or Azure DevOps a job works on a fresh copy and comes back with a
pull request for you to review, and on GitHub pi-dispatch refuses a repository whose default branch is not protected. A job
on a folder on your own machine edits that folder directly, with no undo, so it refuses a folder with uncommitted
changes unless you force it.

**Can it reach my passwords or my other files?** A job sees only its own project, inside its box, and can reach only the
internet addresses you allow. Two secrets do go in, and the agent can read them: your AI provider key and your GitHub or
GitLab token. That is why the provider limit above matters, and why a narrow token beats your whole login
([`SECURITY.md`](SECURITY.md) says plainly what is and is not defended).

**What if the machine restarts or a job dies?** The queue is kept on disk, so waiting jobs are still there. A job that
was running is lost or started over, unless its trigger opts into continuing from its last checkpoint
([durable runs](docs/durable-runs.md)).

**What does it cost?** pi-dispatch is free, under the MIT license. You pay your AI provider and for the machine it runs on.
There is no typical figure, because a job's cost depends on your model and on the work, so start with a low daily limit and
read what it spent. The console shows what each project, job type, model and day cost, and whether a subscription would
pay off ([insights](docs/insights.md)).

**Can I use a subscription I already pay for?** Yes, if you set it up on purpose: ChatGPT sign in, or Claude through a
community bridge (an extension that connects your subscription to pi). It never falls back to spending an API key behind your
back, and the console shows how much of your subscription's limit is left. Read your provider's terms first: whether they
allow this is theirs to say, not ours ([subscriptions](docs/subscription-auth.md)).

**What if my AI provider is down, or I hit its limit?** You can list fallback models in the order you prefer. A job that
is rate limited, out of quota or hitting an overloaded provider tries the next model on its next attempt, and that model
rests for a while before it is tried again ([fallback models](docs/model-failover.md)). With no fallback, the job waits or
fails with a reason you can read, and nothing is spent on it in the meantime.

## What else it does

**Spend:** today, this week and this month against your limits, and where the money went
([insights](docs/insights.md)).

![The Spend page: spend against the daily, weekly and monthly limits, a chart of daily spend, and what each flow, model and project cost](docs/images/console/console-spend.png?v=2026-11-03)

**Fleet:** every machine and what it is doing, with one switch that stops new work everywhere
([several machines](docs/multi-host.md)).

![The Fleet page: the switch that pauses everything, each queue, what is running, what failed and what is waiting](docs/images/console/console-fleet.png?v=2026-11-03)

**Models and fallbacks:** name a job for what it needs (a planner, an editor) and choose the model per project, with fallbacks in
order. The page shows which model is resting and why, and suggests a cheaper model with the numbers to compare
([model roles](docs/model-roles.md), [fallback models](docs/model-failover.md), [canaries](docs/canary.md)).

![The Models page: each role with its model and its fallbacks in order, a model cooling down after a rate limit, which models are in use, and proposals with their comparisons](docs/images/console/console-models.png?v=2026-11-03)

**Your subscription's limits:** how much of its five hour and seven day windows is used, and when each resets
([subscriptions](docs/subscription-auth.md)).

![A subscription on the Models page: the account windows, how much of each is used and when it resets, and that jobs wait rather than spend beyond it](docs/images/console/console-subscription.png?v=2026-11-03)

**Approvals:** a job can ask permission before a named action, such as spending more. It stops and costs nothing until you decide
([approval gates](docs/approval-gates.md)).

![An approval on the Parked page: what the job asks to do, with buttons to approve or decline with a reason, and a box to ask a question back](docs/images/console/console-approval.png?v=2026-11-03)

**Drafted answers:** a rule you write can have the agent draft an answer to a question from sources it read. You read it, and only
you send it ([answer rules](docs/answer-rules.md)).

![A drafted answer on the Parked page, with the sources it cites and why it was allowed to draft, beside the rule that started it](docs/images/console/console-draft.png?v=2026-11-03)

**Picking up where it stopped:** if a machine restarts or a job's box dies, a job that opted in continues from its last checkpoint
instead of paying for everything again ([durable runs](docs/durable-runs.md)).

![A run that lost its first attempt and continues as a recovery job, with what it had done and what carries over](docs/images/console/console-recovery.png?v=2026-11-03)

**Trying it yourself:** reopen a finished job's workspace in a fresh box with no keys, or prepare one from scratch, and open it in your
own terminal or your browser ([sandboxes](docs/sandbox.md), [browser terminal](docs/sandbox-gateway.md)).

![The Sandboxes page: choose a kept workspace or start from a repository, see what opens and what it holds, and open it in your terminal](docs/images/console/console-sandboxes.png?v=2026-11-03)

**Updates:** which version of pi and which extensions your jobs run, what is newer, a capped trial on a real job, and Adopt. Nothing
updates by itself ([updates](docs/console.md#updates)).

![The Updates page: what jobs run now, what is newer, a button to run a canary, and which version each host holds](docs/images/console/console-updates.png?v=2026-11-03)

**Projects:** group your repositories into a project, with its own limits, share of the budget and history
([projects](docs/projects.md), [budget split](docs/allocation.md)).

![One project: its members, its limits, what it has spent and its recent runs](docs/images/console/console-project.png?v=2026-11-03)

**A trigger:** what starts it, what it runs and what it has cost. A schedule also gets a button that fires it now
([triggers](docs/triggers.md)).

![One trigger's page: what starts it, the flow it runs, its limits and what it has cost so far](docs/images/console/console-trigger.png?v=2026-11-03)

**Your phone:** every page fits, for answering a question from wherever you are. The console listens only on its own machine
unless you set it up otherwise, so reaching it from a phone takes a private tunnel
([from another machine](docs/console.md#from-another-machine)).

<img src="docs/images/console/console-overview-phone.png?v=2026-11-03" alt="The overview page on a phone, one column, with the questions that need you at the top" width="320">

## Bring your own pi setup

Already use pi? Your models, skills, persona and extensions come along, so jobs work the way your own sessions do. Run this in the
folder you installed into, whenever your setup changes:

```bash
./node_modules/.bin/pi-dispatch import-pi --with-packages
# then, in that folder's .env, point at the copy it made:
PI_GLOBAL_PI_DIR=/absolute/path/to/my-dispatch/pi-global
./node_modules/.bin/pi-dispatch doctor     # checks that the copy holds no credential
```

| What comes along | What never does |
|---|---|
| Your custom models, as definitions only | `auth.json`, and any key written into a file (the import refuses it) |
| Your skills and persona | Your sessions, themes and settings |
| Your extensions, each listed by name as it copies them | The `/dispatch` extension itself, and any extension you have turned off in pi |
| The packages you installed with `pi install`, pinned at the version you have | Anything a project asks to install: only you choose what gets installed |
| Your MCP servers, with credentials as references only | Secrets of any kind: the copy is read by jobs, so it holds none |

**Read the list it prints.** An extension is code, and it runs in every job, beside work that may come from a stranger's issue text. Skip
extensions with `--no-extensions`, or keep one trigger's jobs out of your packages with `"packages": false`.

Your projects still win. A job layers your setup under the project's own `.pi/` folder, so a project's skill replaces yours of the same
name, and a small safety floor sits under both, which neither can remove. To add a language or a system tool rather than a pi setting, build
your own [job image](docs/job-image.md). The details are in [`docs/global-pi-overlay.md`](docs/global-pi-overlay.md).

## How to use it

Once it is installed, this is the path through the three stages.

**1. Run a first job and watch it.** Start the worker from the checklist. Give it a folder that is a git repository, with your
work committed, because a job on a folder edits it directly. Then open **Runs** in the console and read along. You are in
the loop.

```bash
./node_modules/.bin/pi-dispatch run ./my-project --task "add type hints" --flow tidy
```

A flow is a short text file of instructions in your project, such as `.pi/skills/tidy/SKILL.md`. The
[`examples/`](examples/) folder has one to copy.

**2. Give it a schedule or a label.** On **Triggers**, add a rule: every night at three, or whenever an issue gets the label
`pi:fix`. Turn on **steer** in the form, so you can also tell its jobs what to do while they work. To let a job stop and ask you,
add `resume` and `awaitInput` to the rule in `triggers.json`, which is a job for your technical person. You are near the loop.

**3. Step back when the numbers say you can.** Read **Zero touch** under Runs. When a kind of work rarely needs you, let
it run and review what comes back. You are out of the loop for that work, and still in charge of what ships.

To open the console again later, type `/dispatch console` in pi. A sign in lasts up to 12 hours, and an hour with nothing
happening ends it sooner. After that, you need your token or a new link, which `/dispatch console --link` or
`pi-dispatch-console link --name <you>` makes ([everything about the console](docs/console.md)).

## Words used here

| Word | What it means |
|---|---|
| **Agent** | A program that uses an AI model to read code, change it and run it |
| **pi** | The open source coding agent that does the work here. pi-dispatch runs it, and adds no agent of its own |
| **Job**, or **run** | One piece of work, from start to finish |
| **Trigger** | A rule for what starts a job: a schedule, a label, a comment |
| **Flow** | A short text file in your project with the standing instructions for a kind of job |
| **Container** | The sealed box a job runs in, thrown away afterwards |
| **Forge** | The place your code lives: GitHub, GitLab, Forgejo or Azure DevOps |
| **Repository** | A project's code and its history, on a forge or in a folder (a "git repository") |
| **Pull request** | A proposed change to a repository, for a person to review |
| **Merge** | Accepting a pull request into the project. pi-dispatch never does this |
| **Issue**, **label** | A note about work to do on a forge, and a tag you can put on it |
| **Worker** | The part of pi-dispatch that takes jobs from the queue and runs them |
| **Terminal** | The window where a developer types commands |
| **Provider key** | The password-like key your AI provider gives you, which pays for what the agent uses |
| **Console** | The web page shown here |
| **Panel** | The same information inside pi, as `/dispatch` |

## For engineers

Everything above in the terms you would run it by. pi has no job queue, no concurrency control, no spend limit and, by its
own README, no permission system. pi-dispatch adds exactly that layer and nothing else. It is not another agent to
compare with the one you use: it is the queue, the budget and the box around the pi you already run, steered by the
`.pi/` setup your repo already has.

> **Naming heads up.** The published packages are scoped: `@edgehero/pi-dispatch` (the `pi-dispatch` command). The bare npm
> name `pi-dispatch` belongs to an unrelated package (see [License](#license)), so outside a checkout always use the scoped
> name.

## Where it can run

pi-dispatch is a long running worker that starts containers, so it runs on a machine where it can do both: Node 22.19 or
newer beside a container runtime, on the same host.

| Where | Works? |
|---|---|
| A Linux server or VM you control (a VPS, a cloud VM, a home server) | **Yes.** The main target. Run the worker as a service ([Run as a service](#run-as-a-service)). |
| Your own Mac or Windows machine with Docker Desktop | **Yes**, while you are logged in, because Docker Desktop is. |
| Several machines sharing one queue | **Yes** ([`docs/multi-host.md`](docs/multi-host.md)). |
| Serverless and app platforms (Vercel functions, Netlify, Cloudflare Workers, a PaaS without a container runtime) | **No.** There is no container runtime to start jobs in, and nowhere for a worker that never stops. |
| Hosted sandbox services as the place jobs run (Vercel Sandbox, E2B, Modal, Daytona and similar) | **Not yet.** A new venue needs an adapter, and [`docs/backends.md`](docs/backends.md) is the contract it would implement. |
| A Docker or Podman daemon on another machine (`DOCKER_HOST=ssh://...`) | **No.** Job files are mounted from the worker's own disk, which that machine does not have, and it would receive every job's provider key and forge token. |

Only the receiver needs to be reachable from the internet, and only for webhooks. Behind a firewall, use the receiver's
`poll` mode instead, which needs no public URL ([`docs/polling.md`](docs/polling.md)).

- **`local`**, the default: the Docker daemon, or rootful Podman through its Docker API. Easiest to set up, and the only
  choice on macOS and Windows. The worker needs the daemon's socket, and that access is equivalent to root on the host.
- **`podman`**: rootless Podman as the worker's own account, on Linux. No daemon runs as root, each job runs as the
  worker's own uid, and Valkey, the egress proxy and the worker run as systemd user units. Pick it for a shared or security
  sensitive server ([`docs/podman.md`](docs/podman.md)).
- **`openshell`**: one NVIDIA OpenShell sandbox per job on a gateway on this host, in copy mode, so nothing of the job is
  mounted into the sandbox. The gateway's policy is the egress control, so no egress proxy starts. A provider made for each job
  holds its secrets, one per endpoint, so the agent sees placeholders rather than the values, with no secrets manager
  needed. `openshell-bind` runs the same policy with the job's folders bind mounted. `pi-dispatch doctor --openshell` checks the gateway first, and both
  [`up`](docs/backends.md#the-openshell-venue) and `service install` set it up. Pinned to OpenShell 0.1.4, since its
  interfaces are marked experimental.

Each job gets the memory and CPUs its project's row sets (4 GB and 2 CPUs by default), and starts only when its size fits
beside what already runs on that machine ([`docs/sizing.md`](docs/sizing.md)).

## Set up a host

A machine that runs jobs for good, rather than while you watch. As an ordinary account, not root, with Docker or rootless Podman and Node
22.19 or newer installed, install into a folder that stays ([step 2 of Install](#install-in-four-steps)), then:

```bash
./node_modules/.bin/pi-dispatch up --console     # asks before each action: job image, Valkey, egress proxy, config, the console's service
./node_modules/.bin/pi-dispatch doctor --live    # checks the setup and reads its isolation back from real containers
./node_modules/.bin/pi-dispatch service install  # keeps the worker running, restarted at boot
sudo loginctl enable-linger "$USER"              # on Linux: user services start with no one logged in
```

**Reach the console from your own machine.** It listens on the host's loopback only. Forward a port, and make a sign in link for that port on
the host ([more](docs/console.md#from-another-machine)):

```bash
ssh -L 4790:127.0.0.1:4790 yourhost              # on your own machine; then, on the host:
./node_modules/.bin/pi-dispatch-console link --name you --port 4790
```

**Connect a forge.** `pi-dispatch setup github --webhook-url '<receiver URL>'` creates a GitHub App in one browser click, or `--no-webhook`
if the host has no public address, and `pi-dispatch service install --receiver` keeps the receiver running. GitLab, Forgejo and Azure DevOps
have a [setup page each](#other-forges).

**Before it runs unattended:**

- Set a spend limit at your provider, and caps here ([costs](docs/costs.md)).
- Protect the default branch of every repository it may touch: the worker refuses a GitHub repository without it.
- On a shared server, prefer `PI_BACKENDS=podman`: access to the Docker socket is equivalent to root ([Podman](docs/podman.md)).
- List the hosts jobs may reach, since everything else is denied ([egress](docs/egress.md)).
- Use the GitHub App rather than the default `gh` source, which forwards your whole login ([GitHub](docs/github.md)).
- Take the [backup](docs/backup.md) seriously, and read [`SECURITY.md`](SECURITY.md).

**Add a second machine.** Point it at the same Valkey and give every worker a name with `PI_WORKER_NAME`. Each host keeps its own logs, jobs and
sandbox folders ([several machines](docs/multi-host.md)). Run one worker per container daemon.

**Keep it working.** `pi-dispatch service restart --drain` restarts after running jobs finish, and `/config/updates` in the console shows what is
newer ([service](docs/service.md)).

## Providers and models

**pi-dispatch itself needs no AI key.** The queue, the caps, the containers, the console and the panel run no model. The key
is for pi, inside each job. pi-dispatch works with most providers pi supports. Pick the default in `.env`:

```bash
PI_PROVIDER=anthropic
# an exact model version keeps cost predictable
PI_MODEL=claude-sonnet-5-5
ANTHROPIC_API_KEY=...
```

Override them for one job with `--provider` and `--model`. The worker asks pi which variable your provider reads, and
`doctor` checks that it is set. If you are logged into pi with an API key, leave it blank: the worker reads it from
`~/.pi/agent/auth.json`. Providers without a single key variable (an AWS profile for Bedrock, for example) are refused before anything is
spent. A trigger's `run.models`, or `PI_ALLOWED_MODELS`, names the models a job may call, and the job is stopped before it calls another.

### Subscriptions

A subscription you already pay for works through an explicit connection in `PI_AUTH_CONNECTIONS_FILE`, one per provider:

- **OpenAI** through Sign in with ChatGPT (`openai-chatgpt`), on the direct Responses route.
- **Claude** through a community bridge you select and stage: `pi-anthropic-oauth@0.3.6` or `@gotgenes/pi-anthropic-auth@3.4.3`, each pinned and
  checked against its published source. These are community extensions with tested compatibility, not vendor endorsed. Anthropic's
  [terms](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) separate native applications from third party
  integrations, so read them first. Whether they permit your deployment is not something this project can tell you.

```bash
pi-dispatch auth login chatgpt-main    # on the owning host: the browser sign in, and the worker keeps the renewal
pi-dispatch auth status
pi-dispatch auth usage chatgpt-main
```

The owning host keeps the refresh credentials, and a job gets only a short lived access credential. A binding owns its provider: when it is
disconnected or exhausted it never silently spends an API key, picks another account or changes the billing route. A known exhausted window holds
jobs until its reset, and the Models page shows each window. Subscription jobs need a finite `models` list and do not run on OpenShell
([`docs/subscription-auth.md`](docs/subscription-auth.md)).

### Roles and fallback models

A **role** is a name a trigger selects (`planner`, `editor`), which you map to a model per project in `triggers.json`, so moving a project to another
model is one reviewed edit ([`docs/model-roles.md`](docs/model-roles.md)).

```json
{ "run": { "kind": "github", "flow": "fix", "provider": "anthropic", "model": "claude-sonnet-5-5",
           "models": ["anthropic/claude-sonnet-5-5", "openai/gpt-4o"],
           "fallbackModels": ["openai/gpt-4o"] } }
```

**Fallbacks** are tried in order on the job's next attempt when a provider is rate limited, out of quota or overloaded. Each is chosen at pickup,
before a credential is minted, a repository cloned or budget reserved, and must pass the same checks as the primary: on `run.models`, in the pinned
catalog with a cost bound and a credential, allowed by egress, with endpoint room. A failed model cools down for a while. An attempt may call only
its selected model, so a flow that means to use several keeps its own setup ([`docs/model-failover.md`](docs/model-failover.md)).

**Proposals and canaries.** Doctor suggests a change, `pi-dispatch canary` replays up to three retained jobs on the candidate in disposable workspaces
under one cap, and the Models page shows the comparison. A person adopts it, and no model can ([`docs/model-proposals.md`](docs/model-proposals.md),
[`docs/canary.md`](docs/canary.md)).

## Triggers

**A trigger is what starts a job.** All standing triggers live in one `triggers.json`, which the worker and the receiver read
live, and which the console and the panel can edit. Each entry is an `{ on, run }` pair: **`on` says what fires it**, and
**`run` says what it runs**.

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

| `on.type` | Fires when | The agent's task |
|---|---|---|
| `cron` | your schedule | `run.task` from the file |
| `label` | a label is added to an issue (or an Azure work item) | the issue title and body |
| `comment` | a comment contains your phrase, such as `@pi` | the comment plus the issue |
| `pull_request` | a PR or MR event, a submitted GitHub review, or a close | the PR title and body |
| `issue` | an issue closes | the issue title and body |

`run` names a `flow` or a registered pi `command`. **Who may fire a trigger is decided by your forge, not by pi-dispatch**:
[`SECURITY.md`](SECURITY.md) states each forge's rule. Each optional `run` field, in a line:

- `steer`: a running job takes messages ([steering](docs/steering.md)).
- `resume`, `awaitInput`: follow up jobs continue the session, and the agent can ask and wait ([sessions](docs/sessions.md)).
- `recover`: a lost run continues from its last checkpoint ([durable runs](docs/durable-runs.md)).
- `progress`, `statusComment`: the agent names its phase, and one comment on the issue keeps the numbers ([triggers](docs/triggers.md#optional-run-fields)).
- `image`: this trigger's own job image ([job image](docs/job-image.md)).
- `secrets`, `secretsProfile`, `secretBundle`: vault references, and a project's one shared environment ([secrets](docs/secrets.md#recipe-d-one-environment-for-a-whole-project)).
- `mcp`, `forge`: MCP servers for its jobs ([MCP](docs/mcp.md)).
- `excludeTools`: removes named built in tools ([excluded tools](docs/exclude-tools.md)).
- `packages`: opts out of the staged pi packages ([workflows](docs/workflows.md)).
- `models`, `maxCostUsd`: the models a job may call, and its own dollar cap ([triggers](docs/triggers.md#optional-run-fields)).
- `replicas`: races independent sandboxes on one event ([replicas](docs/replicas.md)).
- `waitFor`: holds a job, unstarted and unbilled, until a time or your own check ([waiting](docs/wait-for.md)).
- `instructions`, `skillsDir`, `github`, `portfolio`: the rest are in [`docs/triggers.md`](docs/triggers.md#optional-run-fields).

A whole project can get one environment from your secrets manager, granted once and read fresh at each job start. Quiet
hours pause a repo or folder by weekday and timezone ([`docs/pause-windows.md`](docs/pause-windows.md)). The
portfolio manager example plans a budget split for the week and reports what it asked for
([`docs/portfolio-manager.md`](docs/portfolio-manager.md)).

## Flows: the custom prompt a trigger runs

A **flow** is a pi skill, a Markdown instruction file, committed to the target repo at `.pi/skills/<flow>/SKILL.md`. That file
is the prompt. A trigger only names the flow, so each repo can define the same flow name its own way.

```markdown
<!-- .pi/skills/tidy/SKILL.md -->
---
name: tidy
description: Format, fix lint, and tighten types across the repo.
ai-trigger: allow        # opt-in for AI-INITIATED runs only (the dispatch_run tool, job chaining). Default deny.
---

Run the formatter and linter and fix what they report; tighten obvious type holes.
Keep the diff minimal and open a PR titled "tidy: <what changed>". Do not change behavior.
```

The flow holds the standing instructions. The **task** is the one off request: your `--task`, a trigger's `task`, or the issue
or comment text. Flows are read from the **default branch**, so a flow must be merged before a trigger can use it. That merge
is the repo's consent. `ai-trigger` only decides which flows a model may start. It does not decide who may fire a job: a cron
or forge trigger in your reviewed `triggers.json` runs its flow either way
([flows in detail](docs/triggers.md#flows-in-detail), [multi stage workflows](docs/workflows.md)).

## What runs, and what protects you

```mermaid
flowchart LR
  CLI["pi-dispatch run"] -->|enqueue| Q
  CRON["a schedule"] -->|enqueue| Q
  FORGE["GitHub, GitLab, Forgejo, Azure"] --> R["receiver: webhook or poll"] -->|enqueue| Q
  Q[("Valkey + BullMQ<br/>the queue")] --> B{"under every cap,<br/>the project's share<br/>and the turn budget?"}
  B -->|no| STOP["refused before any spend"]
  B -->|yes| C["one container, removed after the job<br/>all capabilities dropped, non-root, no-new-privileges<br/>/job read-only"]
  C --> PI["pi + git + gh + Playwright<br/>guardrails + your .pi/"]
  PI --> OUT[("your folder, or a pull request")]
  PI -->|"checkpoints, when recover is on"| DISK[("disk, up to 7 days")]
  PI -->|"progress and live transcript"| Q
  Q --> CON["console and /dispatch panel<br/>watch, steer, answer, approve"]
  CON -->|"a person's message"| PI
```

Every trigger takes this path: spend is checked before the container starts, and nothing is dropped. Read
[`SECURITY.md`](SECURITY.md) before you rely on it.

- **Network egress is denied by default.** Each job gets its own network behind an allowlist proxy, and a job the policy cannot
  serve is refused before it spends. The allowed hosts are yours to list ([`docs/egress.md`](docs/egress.md)).
- **Token and cost records cover the whole job**, including subagent sessions and `pi` child processes, and the per job token
  budget is enforced against that same total ([`docs/costs.md`](docs/costs.md#pi-child-processes)).
- **The container runtime is a named backend** that declares what it guarantees. `pi-dispatch doctor` prints the declaration, and
  `pi-dispatch doctor --live` reads eight of those properties back from real containers ([`docs/backends.md`](docs/backends.md)).
- **Credentials.** On Docker and Podman the provider key and the forge token go in as environment values, and **the agent can read both**. The
  guardrails tell it never to print or send them, but that is prompt text, not enforcement. Bound the key with a **spend limit at
  your provider**. On GitHub the token is one hour for one repo with the App, or **your whole login, full scope and never
  expiring**, with the default `gh` source. Anything in `PI_FORWARD_ENV` has the same exposure. The limit is on the damage, not
  on the leak. None of these have to sit in a file ([`docs/secrets.md`](docs/secrets.md)).

## Costs, projects and capacity

**Costs.** A turn limit per job, job and token caps for the whole deployment, dollar caps per day, week and month, and a dollar
cap per job. Caps can apply per repo, folder, model or project. Every job writes a durable record with ids only, never issue or
comment text, with a usage ledger per model that the insights page prices ([`docs/costs.md`](docs/costs.md),
[`docs/insights.md`](docs/insights.md)). A zero rate run with no declared plan reads `$0 (unrated)`, never "free".

**Projects and split.** Group repos and folders into projects and cap each as one. Set a dollar total with a floor per project, and a
flow can move money between projects inside it, never above the total or below a floor. Every move is logged and can be reverted
([`docs/projects.md`](docs/projects.md), [`docs/allocation.md`](docs/allocation.md)).

![The budget split page: the weekly total, each project's floor, weight, share and spend, and the history of moves](docs/images/console/console-budget-split.png?v=2026-11-03)

**Capacity.** Each machine keeps its own memory and CPU budget, and room is kept for a waiting big job so small ones cannot starve it.
The console, `pi-dispatch capacity` and `doctor` report how busy each host was. They count jobs only: a machine busy with other work
reads as idle ([`docs/sizing.md`](docs/sizing.md), [`docs/insights.md`](docs/insights.md)).

![The Capacity page: each host's busy share, jobs at once against its slots, waits and the projects that used it most](docs/images/console/console-capacity.png?v=2026-11-03)

**Flows map.** Which triggers start which flows, what chained to what, and what each cost ([`docs/graph.md`](docs/graph.md)).

![The flows map: triggers wired to the flows they start, grouped by repository, with how often each ran](docs/images/console/console-flows.png?v=2026-11-03)

The console also has [Models](docs/console.md#the-screens), [Watch](docs/watch.md), an [audit log](docs/console.md#the-audit-log)
of every write, and Configuration. Each write is a preview and a confirm, and paid and destructive ones look different.

![The two step preview of a steer: what will be sent, what it costs, how to undo it, and Confirm](docs/images/console/console-steer-confirm.png?v=2026-11-03)

![The Watch page: sources, rules and findings with their outcomes](docs/images/console/console-watch.png?v=2026-11-03)

![The audit log: every write, who made it and how far its hash chain is verified](docs/images/console/console-audit.png?v=2026-11-03)

![The Configuration page: triggers, settings, pause windows, scoped limits and projects, each edited through a preview](docs/images/console/console-config.png?v=2026-11-03)

## Reuse your existing pi setup

[Above](#bring-your-own-pi-setup) is how. Below it, four trust levels layer, most trusted first: the image's baked safety floor, the global overlay
(mounted read only at `/opt/pi-global`) with its staged packages and a trigger's `run.skillsDir`, the repo's `.pi/`, and the task text, which is never
instructions ([`docs/global-pi-overlay.md`](docs/global-pi-overlay.md)).

- **Nothing installs at job time.** Every job runs with `PI_OFFLINE=1`, so pi's resolver cannot shell out to npm. A package is staged on the host, at an
  exact version, always with `--ignore-scripts` ([`docs/workflows.md`](docs/workflows.md)).
- **A repo's own `.pi/extensions` do run**, because the checkout is the default branch and merging is the gate. Nothing installs packages because a repo asks.
- **MCP servers are yours, not the repo's.** A repo's `.pi/mcp.json` is never read for a job, and a trigger names the servers its jobs connect
  ([`docs/mcp.md`](docs/mcp.md)).
- **Sessions save the full transcript to disk**, which is a real disclosure: read [`docs/sessions.md`](docs/sessions.md) before you turn them on.

## Run as a service

```bash
pi-dispatch service render    # show the unit it would install, with the real paths
pi-dispatch service install   # LaunchAgent (macOS), systemctl --user (Linux), nssm (Windows, a machine service)
pi-dispatch service status    # which unit exists, where, and whether it runs
pi-dispatch service restart --drain   # pause, wait for running jobs, restart, resume
```

`install` renders the [`deploy/`](deploy/) templates without sudo (`--system` on Linux prints the sudo commands instead, for a manual
`sudo cp`). `--receiver` and `--console` install those units instead, and `--env-setup <path>` wraps the worker in your secrets
manager's setup script. Run one worker per container daemon. The details, and the limits on macOS and Windows, are in
[`docs/service.md`](docs/service.md).

### Control the worker

From any terminal: `pi-dispatch pause` stops taking new jobs and survives restarts, `resume` takes them again, `status` prints counts,
`cancel <jobId>` stops one job in any state, `run --trigger <id>` runs one cron trigger now, and `capacity` says how busy each host was.
These read only what they need, so a broken forge setting cannot stand between you and the stop
([`docs/service.md`](docs/service.md#control-the-worker)).

## The pi panel

`/dispatch` is the same information inside your own pi session, as a **pi extension**: no daemon, no network port. Install it with
`pi install npm:@edgehero/pi-dispatch-admin`. It writes a small pointer file, paths only and never credentials, so the panel finds
your deployment from any directory.

![The /dispatch panel: live queue state, job meters, the dollar windows, triggers, pause windows, scoped limits, and the runs list, in one framed terminal view](docs/images/dispatch-dashboard.svg?v=2026-11-03)

Its keys, its plain commands and the `operate-pi-dispatch` skill, which lets you ask your assistant in plain words with every change
confirmed by you in a prompt the model cannot answer, are in [`docs/panel.md`](docs/panel.md).

## GitHub automation

Label an issue, and a container works on a fresh clone, opens a PR and comments back.

- **Only a collaborator's label, `@pi` comment or formal review starts a job.** A PR from a stranger's fork never starts a job on its
  own. A review is gated on the **reviewer**, so a collaborator reviewing that fork PR does start one.
- **The token can merge.** GitHub puts push and merge behind the same permission, so under every auth source the job's token could
  merge. pi-dispatch never does, and **branch protection on your default branch is the real control**. The worker refuses a repo
  without it, before any spend.
- **Which token a job holds depends on the auth source.** The GitHub App mints one per job, for one repo, valid for an hour. The default
  `gh` source forwards **your own login, full scope and never expiring**, and `pi-dispatch doctor` warns about that.
- **The checkout is always the base repo at its default branch**, never a PR branch. A commit that lands on your default branch can run
  code in a job. Issue and comment text never can; it stays data.

`pi-dispatch setup github` creates a GitHub App in one browser click, shows every `.env` line before you agree, and never prints a secret.
Run the part that takes in forge events as a webhook receiver on the host or in a container, or in `poll` mode with no public URL
([`docs/github.md`](docs/github.md), [`docs/polling.md`](docs/polling.md)).

## Other forges

| Forge | Webhook | Who may fire a job | Doc |
|---|---|---|---|
| GitLab, 17.4 or newer, self hosted through `GITLAB_URL` | `/gitlab` | Developer or higher, checked on every trigger | [`docs/gitlab.md`](docs/gitlab.md) |
| Forgejo and Gitea | `/forgejo` | Permission on that repository, read with a separate token no job sees | [`docs/forgejo.md`](docs/forgejo.md) |
| Azure DevOps | `/azure`, a Service Hook | The weakest transport of the four (no HMAC signature, no signed timestamp), so read the doc first | [`docs/azure-devops.md`](docs/azure-devops.md) |

These forges have one auth source each, a token you create, so setting theirs to `app` gets a clear refusal at boot.

## Docs

**Getting started and running it:** [console](docs/console.md), [panel](docs/panel.md), [service](docs/service.md),
[backup](docs/backup.md), [multi host](docs/multi-host.md), [polling](docs/polling.md), [notifications](docs/notifications.md).

**Watching and steering:** [steering](docs/steering.md), [chat](docs/chat.md), [sessions](docs/sessions.md),
[durable runs](docs/durable-runs.md), [approval gates](docs/approval-gates.md), [answer rules](docs/answer-rules.md),
[Zero touch](docs/zero-touch.md), [watch](docs/watch.md), [watch decisions](docs/watch-decisions.md),
[reasons](docs/reasons.md).

**Triggers and flows:** [triggers](docs/triggers.md), [workflows](docs/workflows.md), [wait for](docs/wait-for.md),
[pause windows](docs/pause-windows.md), [replicas](docs/replicas.md), [canary](docs/canary.md),
[excluded tools](docs/exclude-tools.md), [MCP](docs/mcp.md), [global pi overlay](docs/global-pi-overlay.md).

**Money and machines:** [costs](docs/costs.md), [insights](docs/insights.md), [graph](docs/graph.md),
[scoped limits](docs/scoped-limits.md), [projects](docs/projects.md), [allocation](docs/allocation.md),
[portfolio manager](docs/portfolio-manager.md), [sizing](docs/sizing.md).

**Models and keys:** [provider keys](docs/provider-keys.md), [subscription auth](docs/subscription-auth.md),
[model roles](docs/model-roles.md), [model failover](docs/model-failover.md), [model proposals](docs/model-proposals.md),
[secrets](docs/secrets.md).

**Isolation:** [backends](docs/backends.md), [Podman](docs/podman.md), [egress](docs/egress.md),
[job image](docs/job-image.md), [sandbox](docs/sandbox.md), [sandbox gateway](docs/sandbox-gateway.md).

**Forges:** [GitHub](docs/github.md), [GitLab](docs/gitlab.md), [Forgejo](docs/forgejo.md),
[Azure DevOps](docs/azure-devops.md).

## How it compares

**vs the Claude Code GitHub Action**: for GitHub only automation the
[action](https://github.com/anthropics/claude-code-action) handles label triggered issues with a tenth of the setup. pi-dispatch is for
running pi on your own hardware with a real queue, a container boundary, and flows against **local folders** as well as repos.

**vs hosted routines and `/loop`**: for "run a prompt on a schedule" they are simpler, with nothing to host. pi-dispatch's cron trigger is
for recurring work that needs a project's exact toolchain, or the built in Playwright and Chromium that let a flow build a frontend and
check how it renders.

## Status

Everything on this page is built and running, on all four forges and on Docker and Podman.

The design lives in [`specs/`](specs/), and the specs are the source of truth, not a summary of the code. Start with
[`specs/constitution.md`](specs/constitution.md) for the rules that never bend, [`specs/design.md`](specs/design.md) for the decisions and
what was rejected, and [`specs/interfaces.md`](specs/interfaces.md) for the file and container contracts. Every spec file ends with a
revision history, corrections included.

## For developers

To work on pi-dispatch itself, or to build a custom job image:

```bash
git clone https://github.com/edgehero/pi-dispatch && cd pi-dispatch
npm ci
node admin/build.mjs                                # the panel and console bundle, gitignored
valkey-server --port 6379 --save '' --daemonize yes
VALKEY_TEST_URL=redis://127.0.0.1:6379 PI_DISPATCH_REQUIRE_LOADER_TESTS=1 PI_DISPATCH_REQUIRE_WORKER_TESTS=1 \
  PI_DISPATCH_REQUIRE_RECEIVER_TESTS=1 npm test
```

Run the tests with an empty `HOME` outside the temp folder and a short `TMPDIR`: some load the real `~/.pi` setup, and unix sockets have a path limit.
They use `node:test` with hand written, injected fakes, and no network or Docker. A job image comes from `docker build -f image/Dockerfile -t pi-job:latest .`.
Jobs start with `--pull=never`, so build or pull every image first ([job image](docs/job-image.md)).

| Path | What it is |
|---|---|
| `worker/` | the queue consumer, the CLI (`pi-dispatch`), the forge hosts, doctor, the service installer |
| `receiver/` | the always on trigger edge (`pi-dispatch-receiver`): webhook routes and the poller |
| `admin/` | the `/dispatch` panel and the web console (`pi-dispatch-console`) |
| `gateway/` | the optional browser terminal for a sandbox |
| `image/` | the job image, and the runner inside it |
| `deploy/` | service units, wrappers and the compose file |
| `specs/` | constitution, requirements, design and interfaces: the source of truth |
| `docs/` | the operator's reference, one file per feature or forge |
| `design/` | the console's design system: `system/` the cards and tokens, `tools/` the generators that build them |
| `launch/` | the recipes that render every image here |

**What a change needs.** The specs change in the same pull request as the code, with a revision row. A pull request that breaks a `CONST-*` entry is
asked to justify changing the rule first, not the code. pi and its packages stay on exact pins. Nothing in this project merges anything, and CI greps
for it. Sign off your commits with `git commit -s`: this project uses the [DCO](https://developercertificate.org/), not a CLA.

**The look.** A change to the console lands in `design/` first and is pasted into the console by hash. `python3 design/tools/build.py` rebuilds and checks
the cards, and `node launch/render-images.mjs --console --only <golden>` draws any state of any page, so you can look at it. [`AGENTS.md`](AGENTS.md) is the
short version of what matters here.

## License

MIT. See [LICENSE](LICENSE). Built on [pi](https://github.com/earendil-works/pi) by Mario Zechner, which does the actual hard part.

> **Not affiliated with** the unrelated npm package `pi-dispatch`, a pi extension for rotating ChatGPT Codex OAuth accounts. Same name,
> different thing. This project publishes scoped packages only:
> [`@edgehero/pi-dispatch`](https://www.npmjs.com/package/@edgehero/pi-dispatch) (worker and CLI),
> [`@edgehero/pi-dispatch-receiver`](https://www.npmjs.com/package/@edgehero/pi-dispatch-receiver), and
> [`@edgehero/pi-dispatch-admin`](https://www.npmjs.com/package/@edgehero/pi-dispatch-admin) (the console and the panel). The bare name is theirs.
