# Workflows: flows, skills, and staged pi extensions

Three different things get called a workflow, and mixing them up is how a deployment ends up running
third-party code it never vetted. This file separates them.

pi-dispatch is the **trigger and the box**. It decides *when* a job runs, *what image* it runs in, and
*what it may spend*. What the agent actually does inside is pi's business, and pi's unit of instruction is
the **skill**. So a workflow here is never a pi-dispatch feature: it is either a skill that calls other
skills, or a pi extension that orchestrates them.

| Term | What it is | Who owns it |
|---|---|---|
| **trigger** | one `{ on, run }` entry in `triggers.json`: what fires, and which flow or command it runs | you, in a reviewed file |
| **flow** | the skill a trigger names, at `.pi/skills/<flow>/SKILL.md` on the target repo's **default branch** | the target repo |
| **command trigger** | a trigger whose `run.command` names a registered extension command instead of a flow; the job's whole prompt is the dispatch line `/command args` | you, in a reviewed file |
| **skill** | pi's unit of instruction; a flow is just the entry one. The whole directory travels, not only `SKILL.md` | the target repo, or the overlay |
| **workflow extension** | a pi extension that chains skills into stages, with its own state and routing | a third party, staged by you |
| **staged package** | the pinned directory a workflow extension lives in, inside the global overlay | `import-pi --with-packages` |
| **injected skills** | a directory of skills on the worker host that one trigger's jobs load, via `run.skillsDir` | you, in a reviewed file |

## How a workflow gets triggered

Nothing in a workflow fires itself. A pi-dispatch trigger is the only thing that starts work, and it always
produces the same shape:

```text
label / comment / PR / cron        one delivery, one dedup key
        |
        v
one job, one container            one budget slot, one turn budget, one transcript
        |
        v
run.flow | run.command            the skill the trigger names, read from the default branch --
        |                         or the registered command it dispatches, as `/command args`
        v
the skills it calls, or a staged workflow extension
```

Five properties of that chain decide what is possible inside it.

**`run.flow` and `run.command` are the two entry points.** There is still no `run.workflow`: which stages
run is a property of what the entry point does, which the repo changes by merging a skill or you change by
staging an extension, and the trigger stays a reviewed pairing of an event with one name. `run.command` is
worth being precise about in the same way `run.skillsDir` is: it supplies **which registered command
dispatches**, never new code. The extension that registers the command still arrives the way extensions
arrive -- staged into the overlay, committed to the serviced repo, or shipped in the image -- and every
trust gate on that path is unchanged; the trigger picks a command from what the deployment already vetted,
exactly as `run.flow` picks a skill from what the repo already merged. Its arguments are static too: they
come from the reviewed file, and the delivery (which issue, which comment) waits in `/job/event.json` for
the handler to read, so nothing from the event ever rides the dispatch line. That split is the same one the
whole trigger schema rests on: this service decides *when* and *in what box*, the entry point decides
*what*.

**A job is not an interactive session, and a slash command does not need one.** The runner assembles one
prompt, calls pi once, and reads the exit line — and `session.prompt()` dispatches a whole-text `/name`
to the extension handler itself, before any model or auth work, so the one prompt a job gets can *be*
the command. (The obvious counterargument, that an extension's slash command has nobody to type it
inside a job, is wrong at the pin: dispatch happens in `prompt()`, not in a terminal.) `@juicesharp/rpiv-workflow` names the distinction in its own
trigger taxonomy: `command` for a typed `/wf`, `programmatic` for an embedder that calls the API,
`external` for a webhook or cron source. **A pi-dispatch flow job is the programmatic case, and a
`run.command` job is the command case, reached headlessly**: `"command": "wf run nightly"` on a trigger
dispatches the registered command with those exact args, no model turn deciding anything. The two
flow-side routes remain as alternatives:

- the flow's `SKILL.md` tells the agent to use the workflow's skills, which needs nothing but prose, and
  leaves the decision to start a workflow with the model; or
- you stage a second small extension of your own that imports the package and starts a run from a lifecycle
  hook. That is the embedding route the package documents; reach for it only when the dispatch must depend
  on something a reviewed trigger line cannot express — `run.command` covers the static case with no code
  of your own.

**One trigger is one job, one budget slot, and one turn budget.** Every stage runs inside the container that
one delivery produced, so ten stages share the `PI_MAX_TURNS` ceiling and the per-job token budget, and
exhausting either aborts the job as a **policy** refusal that is never retried. A many-stage workflow is
therefore a turn-budget question before it is anything else: raise `PI_MAX_TURNS` for the deployment, or keep
stages coarse. Nothing about a workflow multiplies the daily cap either, which is the one thing an operator
usually wants to hear: a workflow costs one container start, however many stages it has.

**Concurrency is gated for you on local jobs.** Each job is its own container, so two jobs never share
a pi session. What they can share is a **directory**: a `cron` or CLI job bind-mounts your folder
read-write. The worker therefore holds at most **one local job per folder** in flight (within the worker
process; one worker per docker daemon is the supported shape) — always on, no configuration, no off
switch — and defers the rest to the delayed set: a second job targeting the same
folder runs when the first finishes, never concurrently and never dropped. `@juicesharp/rpiv-workflow`
says as much about its own run-name claim, which is atomic per write but holds no cross-process lock;
the mutex is what closes that gap. To bound a scope further (jobs per day/week/month, or a concurrency
ceiling on a repo), see [`docs/scoped-limits.md`](scoped-limits.md). Forge jobs are immune to the
working-tree race by construction, since each one gets its own clone.

**The delivery decides when the job is enqueued; `run.waitFor` decides when it starts.** The one thing the
chain above cannot express is a *dependency*: stage 1 needs the Jira parent accepted, or the deploy window
open, or last night's pipeline green, and none of those is an event a forge will send you.
[`run.waitFor`](wait-for.md) holds the whole job in the delayed set, unstarted and unbilled, until an
instant passes or a check script you wrote exits 0. It is deliberately not a stage inside the container:
a stage that waits burns the turn budget, holds a concurrency slot, and pays for a container to sleep,
while a job held at the gate costs nothing and survives a restart. So the ordering to reach for is a wait
in front of the job, not a sleep inside it — and if the thing you are waiting for is another pi-dispatch
job, prefer a check that reads that job's own output over one that guesses from elapsed time.

## The simple case: a flow that calls skills

Nothing to configure. A flow is a skill, and a skill may call other skills, so a two-stage or five-stage
sequence written as prose in `SKILL.md` is already a working workflow. It costs one job, one container and
one budget slot, and the whole chain is visible in that job's transcript.

Reach for more only when you need what prose cannot give you: typed hand-offs between stages, validation
that a stage produced what the next one expects, resumability, or an audit trail separate from the
transcript.

**The skill's own supporting files come with it.** `references/`, checklists, templates and scripts
committed beside `SKILL.md` are materialised into the container from the same pinned sha, so a stage that
says "follow `references/review-checklist.md`" finds the file. Three things to know: scripts arrive non
executable (everything under `/job` is read only, so use `bash scripts/x.sh`), dotfiles are skipped the
same way pi's own loader skips them, and a directory that ships no `SKILL.md` anywhere beneath it is not
copied at all, because pi would register no skill for it. A skill past the size caps (256 files, 8 MiB)
refuses the job with the cap named, which is deliberate: a partly copied skill is a skill whose
instructions point at files that are not there.

## A standing instruction, and what it is not

`run.instructions` on a forge trigger attaches one line of your own text to every job that trigger
starts. It reaches the prompt above the issue or pull request text, labelled as coming from you, so the
agent can tell it apart from whatever a stranger wrote in the issue.

It is the smallest of three places instructions can live, and picking the right one matters more than the
feature does:

| Where | Scope | Reviewed by | Reach for it when |
|---|---|---|---|
| `run.instructions` | one trigger | your edit to `triggers.json` | a sentence or two, specific to this pairing of event and flow |
| the flow's `SKILL.md` | every job that runs that flow, on that repo | a merge on the target repo | the instructions ARE the procedure |
| the overlay's `APPEND_SYSTEM.md` | every job, every repo, every flow | `import-pi`, at deploy time | house style that outlives any one trigger |

The 2000 character cap is there to keep the first row from quietly becoming the second. If your standing
text no longer fits on a screen, it is a flow, and it belongs in a file someone reviews.

Cron triggers do not take it, and use `task` instead. That is not an omission: a scheduled job's whole
prompt IS its `task`, so a second field would write the same region with no defined order between them.

A command trigger takes neither. Its whole prompt is the dispatch line `/command args`, so there is no
envelope for `instructions` and no task region for `task`, and both are refused when the file loads rather
than accepted where they would do nothing. `"resume": true` is refused at load too — what a resumed
session should do with a re-dispatched command is undesigned, a gap to close rather than a limit — so a
command trigger always starts a fresh session.

## The structured case: stage a workflow extension

**Nothing installs at job time.** Job containers run with `PI_OFFLINE=1` and, on the shipped image, no
package manager reachable path to the registry — a job that tried to `npm install` a workflow package
would fail on every delivery. So third-party pi packages are installed **on the host, once**, into the
global overlay, and mounted into every job read-only. That is what staging is.

There are two ways in, and you probably already used the first. If you ran
`pi install npm:@juicesharp/rpiv-workflow` on your host, `--with-packages` **discovers it** and stages the
exact version you have, with no second declaration anywhere. `pi-packages.json` remains for pinning a
different version than your host runs, and for declaring a package your host does not have:

```jsonc
// pi-packages.json, beside your .env — optional now, and an entry here wins over what your host has
{ "packages": [
  { "name": "@juicesharp/rpiv-workflow", "version": "2.4.0" }
] }
```

```bash
pi-dispatch import-pi --with-packages     # stage your pi packages, plus any pins, into ./pi-global/packages/
pi-dispatch doctor                        # confirms what is staged, what drifted, and that it is credential-free
```

Each package is printed with where it came from, and `--no-host-packages` stages only what the file
declares. A git-sourced package cannot be staged (an exact npm version is the pin, and a ref is not one) and
is skipped by name rather than in silence.

Versions are **exact** — no `^`, `~`, `*` or `latest`, refused at load. A floating range is the worst
failure this project has: an upstream minor lands, every queued job quietly loses a tool, and the queue
still reports success. Pinning turns that into an edit you make on purpose.

What `--with-packages` does, per entry:

1. `npm install <name>@<version>` in a private staging dir, with `--ignore-scripts` (so no lifecycle script
   of the package or of any dependency runs as you, on your host), `--omit=peer`, and a nested install
   strategy.
2. **Asserts the result rather than trusting the flags**: the staged `package.json` must carry the exact
   pinned version, and every declared dependency must sit inside the package directory. A dependency npm
   hoisted out is a refusal, not a warning, because the staged copy could never import it at run time.
3. Renames the staging dir into place as `packages/<dir>`, defaulting to `scope__name`.
4. Writes `packages/packages.json`, the receipt: what is staged, at which version, in which directory, and
   whether it came from your pi setup or from `pi-packages.json`.

**No restart.** The receipt is read at each job start, so `pi install` something, re-run the stager, and the
next job has it. A re-stage that *removes* a package takes effect immediately too, and that is the point of
the per-job read: under a boot-time read, every job after a removing re-stage refuses at container start
with its budget slot already reserved, and keeps doing so until the worker restarts — a daily-cap slot
burned per fire.

Set `PI_GLOBAL_PI_DIR` to the overlay and the staged set lands at `/opt/pi-global/packages/<dir>` in every
container, named by `PI_PACKAGES`. No new mount and no new trust boundary: staged packages ride the same
`:ro` overlay mount the feature already had.

## A worked example, staged and inspected

`@juicesharp/rpiv-workflow@2.4.0` describes itself as chaining skills into typed multi-stage workflows with
audited JSONL state, predicate routing and per-stage output validation. It is a useful example precisely
because pi-dispatch does **nothing special** for it. Staged against this repo's own tooling, the result is:

| What | Result |
|---|---|
| staged directory | `packages/juicesharp__rpiv-workflow`, 8.7 MB |
| `pi` manifest | `{ "extensions": ["./extension.ts"] }`, so it contributes one extension and no skills |
| entry format | TypeScript, which pi loads through jiti; the staged copy carries its own `jiti` |
| dependencies | all three (`@juicesharp/rpiv-config`, `jiti`, `typebox`) nested **inside** the package dir, so the completeness assertion passes and it resolves with no install at job time |
| lifecycle scripts | none beyond `test`, so `--ignore-scripts` left nothing unbuilt |
| peers | `@earendil-works/pi-coding-agent` and `@standard-schema/spec`, both omitted by staging, and both referenced only as `import type` in the package, so nothing imports them at run time |
| `dispatch_*` tools | none, so the recursion guard below leaves it alone |

What that establishes is the **staging and loading path**, which is the part this repo owns. It is not a
claim that the extension's own workflows have been run end to end in a job container here, and it is not an
endorsement: it is third-party code that will load in every job. Read its source, or pin an older version
you have read. The list `import-pi` prints is the vetting step.

Any package with a `pi` manifest works the same way, and one staged directory may contribute **extensions,
skills, prompts and themes** at once.

### Wire it to a trigger

Staged, the extension's `/wf` is dispatchable from any trigger kind via `run.command` — the name without
the leading slash (the runner prepends it), arguments verbatim:

```jsonc
// triggers.json -- a schedule dispatches /wf run nightly, headlessly
{ "on": { "type": "cron", "id": "nightly-workflow", "pattern": "30 3 * * *" },
  "run": { "kind": "local", "folder": "/srv/site", "command": "wf run nightly" } }

// ...or a collaborator's comment dispatches /wf run; the comment itself never rides the
// dispatch line -- it waits in /job/event.json for the handler to read as data
{ "on": { "type": "comment", "phrase": "@pi wf" },
  "run": { "kind": "github", "command": "wf run" } }
```

The job's whole prompt is that `/wf …` line. The runner verifies the command is registered before any
model call and refuses with `command-unregistered` (exit 2, never retried) when it is not — a typo costs
nothing. The job image must declare the `commands` capability, and the worker refuses pre-spend when it
does not ([`job-image.md`](job-image.md)). On the graph, a command trigger renders as `/wf` with no flow
edge ([`graph.md`](graph.md)).

## What the loader does with a staged package

| Property | Behaviour | Why it is that way |
|---|---|---|
| **extension order** | staged package extensions load **last**, after the repo's and the overlay's | first-path-wins, so nothing a package ships can shadow something you wrote |
| **skill collisions** | the **repo's** skill wins a name collision against a package's | pi puts package skill paths first, so precedence is re-imposed after the load rather than merely asserted |
| **prompt collisions** | the repo's `.pi/prompts` template wins against a package's, and the overlay's `prompts/` now loads at all | same inversion, same fix: what a `/name` template means stays reviewed content, which also matters because `run.command` dispatches by `/name` |
| **counting** | the `packages_loaded` log line reports extensions, skills, prompts and themes per package, and `commands_registered` reports what each package actually registered | a package that contributed nothing is otherwise indistinguishable from one that worked |
| **the recursion guard** | any extension named like the admin console, or registering a `dispatch_*` tool, is **dropped** and logged | a staged package must not be able to hand the agent the deployment's own control surface |
| **the overlay is `:ro`** | a package that writes beside itself fails | the overlay is deploy-time config mounted into an adversarial-input container |
| **secrets** | the overlay must hold none; `doctor` fails if it does | `:ro` is not confidentiality, and job input is untrusted |
| **per-trigger withdrawal** | `"packages": false` on a trigger withholds the whole staged set from its jobs | changing which flows run third-party code is a reviewed file edit |

`doctor` reports the staged set by `name@version`, fails when a declared directory is missing, fails when a
trigger says `"packages": true` and nothing is staged (that flow would run without its tools and still
exit 0), and fails when a trigger requires packages while `PI_GLOBAL_PI_DIR` is unset. It also prints one
line per trigger flow naming the skill tier that resolves it (a staged package counts, by name), and warns
when a flow resolves in no tier visible on the worker host -- the same silent no-op, caught before the
trigger fires instead of after. Command triggers get a count and one advisory line instead: whether a
command is registered is only knowable inside the container, where the runner refuses an unregistered one
before any model call.

**One knob does not cover this, and the distinction matters.** `PI_GLOBAL_ALLOW_EXTENSIONS=0` makes the
overlay's own `extensions/` directory dormant. It is not the off switch for staged packages: those are
withheld per trigger with `"packages": false`. If you want neither, do both.

## Where a workflow's state lives

This is the part that decides whether a multi-job workflow is possible at all, and it depends on the
trigger kind. A workflow extension writes its state relative to the working directory, and in a job that
directory is `/workspace`:

| Trigger kind | `/workspace` is | So state | Watch out for |
|---|---|---|---|
| `cron` / CLI (`local`) | **your folder**, bind-mounted read-write | **persists** between runs, on your host | the agent edits in place, so a state directory shows up in your tree |
| forge (`github`, `gitlab`, `forgejo`, `azure`) | an **ephemeral clone** of the default-branch sha | **dies with the container** | it is untracked, so a flow told to commit everything can commit it into a pull request |

Add the extension's state directory to the repo's `.gitignore` before you arm a forge trigger. For
`@juicesharp/rpiv-workflow` that is `.rpiv/`.

Two supported ways to continue work **across** jobs:

- **`"resume": true`** on the trigger continues the pi session the previous job for the same key produced.
  It persists the whole transcript to host disk, which is a real disclosure and refuses to run at all when
  no store is configured. Read [`sessions.md`](sessions.md) first. Flow triggers only: a command trigger
  refuses `resume` when the file loads (see [the refusal list](#a-standing-instruction-and-what-it-is-not)).
- **Job chaining** through `/outbox`: a finished job may request a follow-up job. It is **local jobs only**
  (a forge parent gets no `/outbox` mount), depth-bounded, and gated on the target flow carrying
  `ai-trigger: allow`; a request naming a `command` is refused outright, with no opt-in.
  `/dispatch insights` shows the whole picture: configured trigger edges, observed
  chain edges from the run records, and potential ones a skill's text names ([`graph.md`](graph.md)).

## What is not supported

- **Installing anything at job time.** No network for the registry, by design.
- **A package that needs a build step.** `--ignore-scripts` means a `prepare`/`postinstall` never ran;
  `import-pi` warns that the staged copy is incomplete, and it may fail at run time. Stage a package that
  publishes its built output.
- **Runtime imports of omitted peers.** pi aliases its own package at load, so a pi peer is fine. Any other
  peer that is imported as a **value** will not resolve in the container. Type-only peers are erased and
  cost nothing.
- **Editing the packages flag from the panel or an AI tool.** Both deliberately refuse: the panel displays
  each trigger's packages state and the staged `name@version` set, and changing it stays a file edit.
- **A model starting a command.** Job chaining refuses any `/outbox` request naming a `command`, and
  `dispatch_run` cannot express one -- its parameters speak flows only. A command dispatches from the
  reviewed `triggers.json` alone, and unlike a flow there is no `ai-trigger`-style opt-in to widen that.
- **GitHub Actions, GitLab CI, Azure Pipelines.** pi-dispatch is the trigger and the box; CI stays your
  repo's business. If you meant a CI workflow rather than a pi workflow, nothing here applies.

The overlay itself, including how `import-pi` decides what is safe to copy, is
[`global-pi-overlay.md`](global-pi-overlay.md). The trust posture for third-party code in a job container
is in [`../SECURITY.md`](../SECURITY.md).
