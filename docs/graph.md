# The trigger/flow graph

Triggers, flows and chained flows form a graph, and every edge already exists somewhere in data: the
triggers file declares trigger → flow, the run records hold what actually chained to what, and the
serviced repo's `.pi/skills/` tree holds what exists and what opts into being chained. The graph
surface assembles that topology in one place (`REQ-TOPOLOGY-GRAPH`, `DES-GRAPH-EDGE-DERIVATION`). It
informs; it changes nothing — no port, no database, no new dependency.

## The GRAPH view

Press `g` on the dashboard (`/dispatch`). The view is a folder-grouped tree: each group header folds
with `↵`, trigger rows carry their joined run stats on the right, skill rows carry their badges, and
a skill's outgoing edges render as indented annotation rows labelled by evidence class. `↵` on a
trigger row opens the same trigger detail the LIST offers. `r` refreshes the model — the only
re-read besides entry, because assembling the graph enumerates each folder's committed skills with
git, and topology changes when you edit things, not per second. `Esc` returns to the LIST.

## `/dispatch graph`

```
Graph: triggers and flows

folder /srv/site, HEAD abc1234
  cron nightly 0 3 * * * -> build-report  (runs 41, last completed)
  skill build-report  [chainable]
    -> notify  observed x3
  skill notify  [chainable] [AI-reachable, no trigger]
  skill old-import  [orphan: no trigger, no ai-trigger, no mention]

forge github (skills unverifiable from the admin host)
  label any[ai] -> triage  (runs 12, last completed)

2 runs unattributed (triggers file changed since they ran, or they predate attribution)
edges: -> configured, observed xN (from records), mention (potential; a mention is not a promise)
caps: chain depth <= 1, <= 2 per job, same folder only, window 30d
```

## How to read an edge

Every edge is labelled by its **evidence class**, and the classes never mix:

| edge | evidence |
|---|---|
| `->` on a trigger line | configuration: the triggers file names this flow, today |
| `observed xN` | history: N runs in the window actually chained here (`parentJobId` joins) |
| `mention (potential …)` | text: this skill's `SKILL.md` names a sibling skill; whether it *could* fire depends on the target's own `ai-trigger: allow`, which the line states |

A mention is not a promise: chains are agent-requested at runtime, so a potential edge says "the
skill talks about it", never "this happens". An observed edge says "this happened N times", never
"this will happen again". The caps line renders on every output because the chain fabric is bounded
by design: depth ≤ `PI_CHAIN_DEPTH_MAX` (default 1), width ≤ `PI_CHAIN_MAX_PER_JOB` (default 2),
same folder only, and a forge-triggered run never chains at all (`OQ-009`).

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
