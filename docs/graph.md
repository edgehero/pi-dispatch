# The trigger/flow graph

Triggers, flows and chained flows form a graph, and every edge already exists somewhere in data: the
triggers file declares trigger → flow, the run records hold what actually chained to what, and the
serviced repo's `.pi/skills/` tree holds what exists and what opts into being chained. The graph
surface assembles that topology in one place (`REQ-TOPOLOGY-GRAPH`, `DES-GRAPH-EDGE-DERIVATION`). It
informs; it changes nothing — no port, no database, no new dependency.

## Where it renders

![The topology pane: triggers wired to their flows Node-RED style, an observed chain edge with its count and recency, a potential mention, cron re-arm loops, an orphan skill dimmed, and the legend](images/graph-view.png?v=0.12.0)

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
| `[no-skill: flow absent at HEAD]` | the trigger names a flow that does not exist in the folder's committed `.pi/skills/` |
| `[invalid flow name: can never materialise]` | the flow name fails the skill charset; no commit can ever satisfy it |
| `[chainable]` | the skill's `SKILL.md` carries `ai-trigger: allow` at HEAD |
| `[AI-reachable, no trigger]` | no trigger names it, but chaining and `dispatch_run` can reach it; not an orphan |
| `[orphan: …]` | no trigger, no `ai-trigger`, no mention: dead by every path the system has |
| `[sub-skill of <group>]` | loadable by pi, but the gate's path shape means it can never be a flow |
| `[SKILL.md unread]` | the enumeration could not read it; the gate is reported closed, not guessed |
| `[spend-loop risk]` | a `pull_request` trigger on `opened`/`synchronize`: a flow that pushes can loop with another bot (`OQ-020`) |
| injected skills section | `run.skillsDir` skills are trigger-reachable and never AI-reachable; an injected `ai-trigger: allow` is a silent no-op and says so (`OQ-022`) |

## Honesty at the edges of the data

The enumeration reads the git **object store at HEAD**, the same read the worker trusts, never the
working tree. A folder that cannot be read renders `unverified` and produces **no** dangling flags: a
read that never happened proves nothing. Forge repos are not on the admin host at all, so their flows
render under `skills unverifiable from the admin host`. Every cap and truncation states itself: a
folder scan stopped at its cap says the unlisted folders are unscanned, not empty.

The display is advisory. The chain gate's truth is read at each run's own pinned commit, before the
agent runs; the graph shows what the *next* run would see.
