# The trigger/flow graph

Triggers, flows and chained flows form a graph, and every edge already exists somewhere in data: the
triggers file declares trigger → flow, the run records hold what actually chained to what, and the
serviced repo's `.pi/skills/` tree holds what exists and what opts into being chained. The graph
surface assembles that topology in one place (`REQ-TOPOLOGY-GRAPH`, `DES-GRAPH-EDGE-DERIVATION`). It
informs; it changes nothing — no port, no database, no new dependency.

## Where it renders

![The topology pane: triggers wired to their flows Node-RED style across the four skill tiers, a /wf command trigger with no flow edge, an amber not-at-HEAD flow, an observed chain edge with its count and recency, a potential mention, cron re-arm loops, an orphan skill dimmed, and the legend](images/graph-view.png?v=1.0.0)

The topology is the lower half of the **insights page** ([`insights.md`](insights.md)):
`/dispatch insights` writes one self-contained HTML file and opens your browser, and the topology
renders there as a Node-RED-style diagram — trigger nodes wired to their flows, observed chain edges
with their counts and recency, potential (mentioned) edges dashed, folders as group boxes, orphans
dimmed and dashed, dangling triggers flagged, spend badged onto the triggers that earned it. Pan by
dragging, zoom with the wheel, hover a node for its details (a cron's tip counts down to its next
fire, or says how overdue it is), click one to highlight what it triggers and what reaches it. The
page is a snapshot with its own refresh loop, overwritten atomically at a stable path, so the
workflow is: keep the tab open, re-run `/dispatch insights` after editing triggers or skills, and
the tab picks up the new topology within the auto-reload interval.

This document explains the semantics behind what that pane draws.

## How to read an edge

Every edge is labelled by its **evidence class**, and the classes never mix:

| edge | evidence |
|---|---|
| `->` on a trigger line | configuration: the triggers file names this flow, today |
| `observed xN` | history: N runs in the window actually chained here (`parentJobId` joins); the browser view adds how recently, when the records say |
| `mention (potential …)` | text: this skill's `SKILL.md` names a sibling skill; whether it *could* fire depends on the target's own `ai-trigger: allow`, which the line states |

One trigger shape draws **no config edge at all, on purpose**: a `run.command` trigger. It names a
registered extension command, not a skill, so there is no `SKILL.md` for an edge to land on — the node
renders alone, labelled `/name`, with the full `command: /name args` line in its tip. That is not the
dangling-trigger state: dangling means a *flow* failed to resolve in every checkable tier, while a
command's existence is only knowable inside the container, where the runner refuses an unregistered one
before any model call (`command-unregistered`). What the command does when it dispatches is the workflow
extension's business, not the graph's — see [`workflows.md`](workflows.md).

A trigger row also states its schedule and its money, when the model knows them: a cron trigger
shows `next 4h` (counted from the moment the model was assembled) or `overdue 2h` (from the resident
scheduler, the money backstop's own signal), and any trigger that spent in the window shows its
typed spend through the costs formatter, so a plan-covered trigger reads `plan:<id>` here too, never
`$0.00`. See [`costs.md`](costs.md) for what the spend classes mean.

A mention is not a promise: chains are agent-requested at runtime, so a potential edge says "the
skill talks about it", never "this happens". An observed edge says "this happened N times", never
"this will happen again". The caps line renders on every output because the chain fabric is bounded
by design: depth ≤ `PI_CHAIN_DEPTH_MAX` (default 1), width ≤ `PI_CHAIN_MAX_PER_JOB` (default 2),
same folder only, and a forge-triggered run never chains at all (`OQ-009`).

## Loops inside a skill

There is no structured loop construct anywhere in this system: a "loop inside a skill" is a sentence
in `SKILL.md` telling the agent to iterate ("iterate until it renders right", "for each page…").
The graph scans each skill's body for that vocabulary and shows what it finds **inside the skill's
own node**, because everything a loop does happens inside that one job, one container, one budget
slot. A skill with loop hints becomes a group box: the skill chip, a `⟳` marker
per detected phrase, and the loop wire, all visibly contained in the skill. Like potential edges, a hint is text
evidence, not a promise; the frontmatter is excluded from the scan so a `description: repeat daily`
never reads as a loop. The other two loop shapes have their own visuals: a cron trigger's re-arm is
the dashed self-loop labelled with its schedule, and a flow that chained to itself shows as an
observed self-edge with its count.

## Which repos and folders

A local folder group is headed by its `run.folder`, shown as a basename unless you pass
`--full-paths` — the file is durable and shareable, and full host paths are the operator's explicit
opt-in. A forge group's triggers name no repository in
`triggers.json` (routing belongs to the forge app installation), so the group instead lists the
repositories its **recorded runs** actually hit in the window, labelled as record-derived: history
answering a question configuration cannot.

## Run attribution

A cron trigger's run counts are exact: its scheduler id is embedded in every `repeat:<id>:<millis>`
job id, so the join works over the whole retention window. A forge trigger's runs join only through
the `triggerIndex` persisted on the run record (issue #54); two triggers pointing at the same flow
stay distinguishable. When the triggers file changes, records whose index no longer matches any row
count under `runs unattributed`, and never land on whatever entry now occupies that row.

## Badges

| badge | meaning |
|---|---|
| `[no-skill]`, red dashed | the flow is absent in **every tier the session could check** — the folder's committed `.pi/skills/` at HEAD, the trigger's own `run.skillsDir`, the overlay `skills/`, the staged packages — and the detail names the tiers checked |
| `[not at HEAD]`, amber dashed | absent at HEAD, but at least one tier was **not checkable from this session** (no `PI_GLOBAL_PI_DIR` in this session's env, an unreadable listing, a pattern-manifest package); the tip names what went unchecked |
| `[invalid flow name: can never materialise]` | the flow name fails the skill charset; no commit can ever satisfy it |
| `[chainable]` | the skill's `SKILL.md` carries `ai-trigger: allow` at HEAD |
| `[AI-reachable, no trigger]` | no trigger names it, but chaining and `dispatch_run` can reach it; not an orphan |
| `[orphan: …]` | no trigger, no `ai-trigger`, no mention: dead by every path the system has |
| `[sub-skill of <group>]` | loadable by pi, but the gate's path shape means it can never be a flow |
| `[SKILL.md unread]` | the enumeration could not read it; the gate is reported closed, not guessed |
| `[spend-loop risk]` | a `pull_request` trigger on `opened`/`synchronize`: a flow that pushes can loop with another bot (`OQ-020`) |
| injected skills section | `run.skillsDir` skills are trigger-reachable and never AI-reachable; an injected `ai-trigger: allow` is a silent no-op and says so (`OQ-022`) |
| overlay / staged package sections | the deployment overlay's `skills/` and each staged package's skills, when the session can see `PI_GLOBAL_PI_DIR`; same trigger-reachable, never-AI-reachable truth as injected |

## Where a flow resolves

`run.flow` is resolved by the container's loader across four tiers — the serviced repo's committed
`.pi/skills` at HEAD, the trigger's injected `run.skillsDir`, the overlay `skills/`, the staged
packages, in that precedence order — and the graph resolves each config edge the same way, per
trigger. A flow living below the repo lands its edge on the tier node that holds it (no flag; the
flow runs fine), which is why an injected-only or overlay-only flow no longer renders as a red
missing node. A tier node is claimed only when every tier above it was checked and missed: an edge
asserts *which file the job loads*, and where a higher tier is unknowable the claim softens to
`[not at HEAD]` instead of guessing. `doctor` answers the same question more deeply, per trigger and
per tier, on the worker host; the runner's `flow_not_loaded` log line is the exact in-container
answer both surfaces approximate.

## A worked example

The screenshot at the top of this file draws exactly the deployment below: two reviewed files, one
committed `.pi/skills` tree, and thirty days of run records produce every node, edge and badge in it.
Read the files, then the picture.

`triggers.json` — five local cron triggers and two forge triggers:

```jsonc
{ "triggers": [
  { "on": { "type": "cron", "id": "nightly", "pattern": "0 3 * * *" },
    "run": { "kind": "local", "folder": "/srv/site", "flow": "build-report",
             "task": "build the report, screenshot it, iterate until it renders right" } },
  { "on": { "type": "cron", "id": "inject-tidy", "pattern": "30 4 * * *" },
    "run": { "kind": "local", "folder": "/srv/site", "flow": "tidy",
             "skillsDir": "/srv/skills", "task": "tidy the tree" } },
  { "on": { "type": "cron", "id": "weekly-overlay", "pattern": "0 6 * * mon" },
    "run": { "kind": "local", "folder": "/srv/site", "flow": "overlay-report",
             "task": "write the weekly overlay report" } },
  { "on": { "type": "cron", "id": "audit", "pattern": "0 5 * * fri" },
    "run": { "kind": "local", "folder": "/srv/site", "flow": "house-audit",
             "task": "run the house audit" } },
  { "on": { "type": "cron", "id": "reaper", "pattern": "0 7 1 * *" },
    "run": { "kind": "local", "folder": "/srv/site", "flow": "prune-stale",
             "task": "prune stale branches and artifacts" } },
  { "on": { "type": "comment", "phrase": "@pi wf" },
    "run": { "kind": "github", "command": "wf run" } },
  { "on": { "type": "label", "any": ["ai"] },
    "run": { "kind": "github", "flow": "fix" } }
] }
```

`pi-packages.json` — two staged packages, one shipping skills, one shipping a workflow extension
([`workflows.md`](workflows.md) explains staging):

```jsonc
{ "packages": [
  { "name": "@acme/pi-house-skills",      "version": "1.4.2" },
  { "name": "@juicesharp/rpiv-workflow",  "version": "2.4.0" }
] }
```

The folder's committed `.pi/skills` holds three skills: `build-report`, `notify` (whose `SKILL.md`
carries `ai-trigger: allow`), and `old-import` (which nothing references). What the pane draws, trigger
by trigger — each line below is one flow resolution from the [tier ladder](#where-a-flow-resolves):

- **`nightly` ◷ → ƒ `build-report` (repo tier).** The flow is committed at `/srv/site`'s HEAD, so the
  config edge lands on a plain skill chip. The skill's body says *"iterate until it renders right"*, so
  it renders as a group box with a `⟳` marker and the loop wire visibly contained inside it — the loop
  costs one job, one container, one budget slot. Its text also names `notify`: a dashed **potential**
  edge, drawn strong because the wording sits near chain vocabulary. The records go further — the flow
  actually chained, so an **`observed ×3`** edge runs beside the mention, with its recency. `notify`
  itself wears **`[chainable]`**: `ai-trigger: allow` at HEAD. The trigger's tip counts down to its
  03:00 fire, and its spend badge reads `plan:<id>` — a prepaid chip, never `$0.00`.
- **`inject-tidy` ◷ → `tidy` under *injected skills (run.skillsDir)*.** `tidy` is absent at HEAD, but
  the trigger carries `skillsDir`, so the edge lands on the injected node that already exists — no red,
  no `[no-skill]`. The tip keeps the other half of the story: trigger-reachable, **never AI-reachable**
  (an injected `ai-trigger: allow` is a silent no-op, and the tip says so).
- **`weekly-overlay` ◷ → ◎ `overlay-report` under *overlay skills (global pi dir)*.** Absent at HEAD,
  not injected; the deployment overlay's `skills/` holds it. Renders only when the session running
  `/dispatch insights` can see `PI_GLOBAL_PI_DIR`.
- **`audit` ◷ → ▣ `house-audit` under *staged package skills*.** Resolves in `@acme/pi-house-skills` —
  and the tier is claimed only because every tier above it (repo, injected, overlay) is a **known**
  miss. An edge is an identity claim about which file the job loads, so a hit below an unknowable tier
  would soften instead of claiming.
- **`reaper` ◷ → ⋯ `prune-stale` `[not at HEAD]`.** The flow resolves in no tier this session can see —
  but a staged package that declares its skills as a manifest *pattern* cannot be enumerated from the
  console, so the claim softens to the amber not-committed-at-HEAD state and the tip names the tier
  that went unchecked. Red would assert "this can never run", which is exactly what the graph does not
  know; `doctor` answers the same question per tier on the worker host, and the runner's
  `flow_not_loaded` line is the in-container truth both approximate.
- **`@pi wf` ❝ → nothing, by design.** The command trigger: labelled `/wf`, **no config edge** (it names
  a registered extension command — here `@juicesharp/rpiv-workflow`'s — not a skill), the full
  `command: /wf run` line in its tip, and an estimated spend badge (`~ … est.`, amber). Never
  AI-reachable: a chain request naming a command refuses outright, and `dispatch_run` cannot express
  one.
- **`ai` ◈ → ? `fix` (unverified), in the forge group.** The group lists `acme/website` and `acme/api`
  record-derived. The remote repo outranks every tier this host can read, so even a staged skill named
  `fix` would not claim this edge — dim-with-no-claim is the honest state.
- **`old-import`, dimmed.** `[orphan: …]` — no trigger, no `ai-trigger`, no mention: dead by every path
  the system has.

Below it all, the legend states the chain fabric's bounds — `chains: depth ≤ 1 · ≤ 2 per job · same
folder only · window 30d` — and the honesty counters for anything truncated, unread or unattributed.

## Honesty at the edges of the data

The repo enumeration reads the git **object store at HEAD**, the same read the worker trusts, never
the working tree; the injected, overlay and staged tiers are host-side directory reads, labelled by
their sections. A folder that cannot be read renders `unverified` and produces **no** dangling flags:
a read that never happened proves nothing — the same rule that softens a dangling claim to
`[not at HEAD]` when a tier is unreadable, truncated, or simply not visible from the session
(a wizard-launched console has no `PI_GLOBAL_PI_DIR`; export it to the session if you want the graph
to see the overlay and staged tiers). Forge repos are not on the admin host at all, so their flows
render under `skills unverifiable from the admin host` even when an overlay or staged skill shares
the name: the remote repo outranks every tier this host can read. Every cap and truncation states
itself: a folder scan stopped at its cap says the unlisted folders are unscanned, not empty, an
unreadable overlay or a pattern-manifest package banners in the legend.

The display is advisory. The chain gate's truth is read at each run's own pinned commit, before the
agent runs; the graph shows what the *next* run would see.
