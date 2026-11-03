# @edgehero/pi-dispatch

The worker and the `pi-dispatch` command line tool of
**[pi-dispatch](https://github.com/edgehero/pi-dispatch)**, which runs the
[pi](https://github.com/earendil-works/pi) coding agent for you in the background, in a sealed box for each job, up to the spending limit
you set, and shows it all on one web page. Most people want the
[main README](https://github.com/edgehero/pi-dispatch#readme) first: it explains why and how to use it.

The worker takes jobs from a durable queue (Valkey with BullMQ). Before anything is spent it checks every
cap that applies: job counts and a daily token count for the whole deployment, job counts per repo, folder
or project, and dollars per day, week or month for the deployment and per repo, folder, project or model,
plus each project's share of the budget split. It then starts one locked down container per job (Docker or
Podman), holds the job to its own dollar cap when one is set, gives the agent the job, records what it did
and what it cost, and removes the container. Jobs come from the command line, from cron triggers, or from
forge events that the
[receiver](https://www.npmjs.com/package/@edgehero/pi-dispatch-receiver) queues.

## Start

You need Docker or Podman and Node 22.19 or newer on one machine that stays on (a Linux server or VM, or
your own Mac or Windows machine with Docker Desktop), and an API key for a model provider that pi supports.
pi-dispatch itself needs no AI key: the key is for pi, inside each job.

```bash
mkdir my-dispatch && cd my-dispatch
npx @edgehero/pi-dispatch up        # job image, Valkey with a password, egress proxy, config files, doctor
#  edit .env and set your provider key
npx @edgehero/pi-dispatch worker    # run jobs
npx @edgehero/pi-dispatch run ./my-project --task "add type hints" --flow tidy
```

On the NVIDIA OpenShell venue (`PI_BACKENDS=openshell` in `.env`), `up` also checks its gateway, offers to start
and register it (it never installs OpenShell), and puts the job image into the gateway's engine
([backends](https://github.com/edgehero/pi-dispatch/blob/main/docs/backends.md#the-openshell-venue)).

A local job edits your folder **in place**, and there is no undo, so commit first. The worker refuses a
folder with uncommitted changes unless you pass `--force`. The folder must be the root of a git repository
with at least one commit, and `run` refuses any other folder before it queues anything.

## Commands

| Command | Does |
|---|---|
| `init` | write `.env` and the config files into this folder (never overwrites) |
| `up` | one pass that asks before each container action: image, Valkey, egress proxy, `init`, `doctor` |
| `doctor [--fix] [--live] [--openshell] [--secrets] [--no-publish]` | check the whole setup; `--live` reads the isolation guarantees back from real containers; each run publishes its checks (paths, URLs and secret values cut out) for the console and the panel, unless `--no-publish` |
| `worker` | run jobs from the queue |
| `run <folder> --task "..."` | queue one job against a local folder |
| `run --trigger <id>` | fire one cron trigger from the triggers file now, once, as its schedule would |
| `status`, `pause`, `resume`, `cancel <jobId>` | control the running worker from any terminal |
| `steer <jobId> "..."` | send a running job a message, which the agent reads between its steps (`--later` once it would otherwise stop) |
| `capacity` | how busy each host was over the last day, week or thirty days, read from the run records |
| `service render\|install\|uninstall\|status\|start\|stop\|restart` | run the worker (or `--receiver`, or `--console` for the operator console) as a service (user level on macOS and Linux, nssm on Windows) |
| `setup github` | create a GitHub App in one browser click |
| `auth` | manage host owned subscription authentication: `status`, `login`, `logout`, `usage`, `trial` |
| `canary` | replay up to three retained jobs on another model in disposable workspaces, under one experiment cap |
| `updates` | which pi and which extensions jobs run, what is newer, and adopting it |
| `opener install` | register `pi-dispatch-open`, so the console can open a sandbox in your own terminal |
| `import-pi` | stage your own pi setup (models, skills, persona) for every job, without credentials |
| `chat <jobId \| url \| key>` | follow and steer a running job, answer a parked one, or fork a finished one into your own pi (`--fork-as-job` to run it as a job), through the operator console |
| `sandbox <jobId>` | reopen a finished run's workspace in a fresh container with no credentials; `--list`, `--attach` and `--new` to see, return to or prepare one |
| `egress render` | write `model-endpoints.conf` from `model-endpoints.json`, then print the command that reloads the egress proxy |

Before you rely on it, read [`SECURITY.md`](https://github.com/edgehero/pi-dispatch/blob/main/SECURITY.md).
In short: the agent can read the provider key and the forge token inside its container, and the
guardrails that tell it not to leak them are prompt text. The default GitHub source (`gh`) forwards your
whole login, full scope and never expiring. pi-dispatch never merges anything, but the job's token can,
so branch protection on your default branch is the real control.

The full guide, with the console, triggers, providers, the panel and every forge, is the
[main README](https://github.com/edgehero/pi-dispatch#readme). MIT licensed.
