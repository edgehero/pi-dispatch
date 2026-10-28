The pi-dispatch console in the Pulse style. Bold numbers come first, then pill navigation and filters, rounded cards, and a timeline where each project is a row and waiting jobs sit after the now line, next to what they wait for. A person opens the console to do one of seven things, in this order of urgency:
1. Answer a parked run or an approval.
2. Recover a run that failed or was refused.
3. See what is in line and why.
4. Watch what is running.
5. Know what starts work: the triggers.
6. Check the fleet.
7. Check spend.

Every page leads with whichever applies, offers one clear action for it, and folds away what is fine.

## Screens in this system

Every screen card opens with a dashed **design status** ribbon. It is a note on the card, not part of the console:
- **Built**: the screen is in main, with the pull request that shipped it.
- **Planned**: an open issue will build it, named on the ribbon.
- **Proposed**: drawn so it can be discussed, with its issue if there is one. Nothing is decided.
- **Needs a decision**: it reverses or extends a recorded decision, and waits for that issue first.

A card shows the screen as it would be built. Why it works the way it does is in the card's README, under *Why it works this way*, not in the screen. Component cards carry no ribbon: they are the kit, built in #740. Neither do the *Start here* cards, which are guides.

Start with **Start here**: the concept map shows how the pieces connect, the glossary gives every word the cards use, the journeys walk through three tasks screen by screen, and the sample story is the one deployment every card draws.

| Group | Screens |
|---|---|
| Start here | How pi-dispatch fits together (concept map), Glossary, The sample deployment, Journeys: a run asks a question, a run fails, set up a new deployment |
| Overview | Overview, Overview all clear, First run setup (in the browser, after one command) |
| Runs | Runs, Run live, Run ended, Run refused, Run parked, Run recovered (durable run), Run in a sandbox (openshell-bind), Run chat states, Run as a viewer |
| Fleet | Fleet, Fleet part paused (bulk actions, held, delayed), Host detail (registry row, budget, capacity, doctor), Venue detail (14 properties), Fleet as a viewer |
| Spend | Spend, Budget split, Capacity, Breakdown, Flows map, as tabs of one page |
| Triggers | Triggers (every rule as "when this happens, run that", a week of schedules, and which rule an event would start), Trigger detail, Add a trigger, Triggers as a viewer |
| Configuration | Configuration, Secrets, Connections, Project detail |
| Access and audit | Sign-in, Access states (one-time link, operator, viewer, read-only), Audit, Error |
| Phone | Overview, Runs, Parked, Spend, Run live, Fleet, Triggers, Parked with a draft, Zero touch |
| Planned and proposed | Approval request (#649), Fork a run (#648), Models: roles, cooldowns and canary (#716, #717, #693), Watch and a finding (#735, a tab of Triggers), Watch board: why each finding did what it did, every query and decision, Jev in the job and in shadow at the gate, and a board jobs propose and you adopt (#735, #743), Dispatchers: many sandboxes at once, each with its own purpose, what each did today, where they read the same input and how they stay bounded together; Dispatcher: one in full, reading git changes and infra streams and only starting jobs and proposing triggers, as a Jev loop or an LLM flow; Sandboxes: open a run's kept workspace in your own terminal from the console, or a fresh sandbox for a repository with no run, with a browser terminal shown as an off-by-default proposal; Zero touch: how often runs needed a person, per project and repository, why, the questions they keep asking and the fixes that worked; Parked with an answer rule: a draft job per parked question that drafts from what a person already decided, for the person to send; Zero touch and Parked with a draft as a viewer sees them |
| Components | Shell, Status, Actions and confirm, Cards and banners, Data table, Facts and levels, Timeline and waitlists, Transcript, Fields, diff and command, Confirm states, Live states |

Each screen is built only from `components/bundle.css`, the page kit's helpers and a small page style. Its README says how a person uses it, which panels it has, what the server provides, what a viewer sees, and which data is sample.

## Workflows

| A person wants to | They see first | The one action |
|---|---|---|
| Answer a parked run | The question, its project and target, how long it has waited | **Answer**, then Confirm |
| Decide an approval | The action, its arguments, the risk, who asked | **Approve**, or **Decline** with a reason |
| Recover a failed run | "Failed:" sentence plus the next step | **Re-run** (paid, previews the cost) |
| Understand a refusal | "Refused:" sentence plus the rule that said no; "Nothing was spent" | **Open Fleet** or **Open run** |
| See why work is waiting | In line by reason: a free slot, another run, a time or check, retry backoff | **Free slot**, **Edit**, **Cancel** |
| Watch a run | Phases with item ticks, the running tool and its timer, the live transcript | **Steer** or **Follow up** |
| Know what starts work | Each rule as a sentence: the event and who may cause it, the flow it runs, what it adds (costs more, reaches, writes, asks, narrows), its last run and next fire | **Check** an event against the rules, **Add a trigger** |
| Fix the fleet | The host, what is wrong, how stale the doctor result is, the fix | **Open Fleet**, **Pause** |
| Check spend | Today against its cap, the soft hold, cost by flow, model and project | **Spend**, the what-if |
| Look inside a run's workspace | What opens, where, and until when it is kept | **Open in Terminal** (or copy the command) |
| Make a project zero touch | Its touch rate against the goal, the causes, the questions it keeps asking | **Add to the trigger's instructions** or **Save as a standing answer** |
| Use a drafted answer | The draft on the run page, the sources it cites, why it may draft | **Preview answer**, then Confirm, as for any answer |

## Coverage of the console in the repo

Every page, panel, state and write of the console at `ce5338f`, plus the 5.0.0 issues, has a place here.

| In the repo | Where it is designed |
|---|---|
| `/`: fleet state, spend against caps, hosts online, parked, failures in 24 hours, active jobs | Overview, Overview all clear, Overview on a phone |
| First run: no worker, no egress proxy, no provider key, no triggers, `/dispatch setup`, `pi-dispatch setup github` | First run setup, every step from the browser |
| `/runs`: filters, outcome words, reason sentences, "no explanation yet", mirror and 2,000-run notes, pager | Runs, Runs on a phone |
| `/run`: outcome, progress and phases, live transcript, chat, inbox, steer and follow-up, re-run with its reserve, sandbox command | Run live, Run ended, Run refused, Run parked, Run chat states |
| `/run` for durable runs: continues as, recovery facts, checkpoints, replayed, interrupted and not started calls, earlier attempts, replicas, stalled re-pick | Run recovered |
| `/run` on OpenShell: sandbox policy, rule hosts, secret bundle variables, shadowed names, bundle skipped, cost floor and settled basis, per-model usage, resources, chain | Run in a sandbox |
| `/run` for a viewer: numbers and tool names only, the operator-only sentences | Run as a viewer, Access states |
| `/parked`: waiting, being answered, unknown, the answer and its reserve | Run parked, Parked on a phone, Approval request, Parked with an answer rule |
| `pi-dispatch sandbox`: kept runs and their deadline, `--list`, `--pin`, the `--publish` refusal, one sandbox per run, venues that cannot reopen | Sandboxes |
| Run records: outcomes, reasons, awaiting input, operator cancels, steers, re-runs | Zero touch |
| `/insights`: windows, tiles, budget and soft hold, job sizes, what-if | Spend |
| `/insights`: envelope, plan, allocation against spend, floors, history and revert, priorities, refusal counts | Budget split |
| `/insights`: capacity per host, busy, idle and no data, peak and slots, waits, coverage | Capacity |
| `/insights`: daily and cumulative spend, by flow, trigger, repository and model, plan verdicts, money legend, provenance, what-if answers | Breakdown |
| `/insights`: topology of triggers, flows, groups, wires, flags and the legend | Flows map |
| `/fleet`: kill switch, queues, active, held, failed, schedules, hosts, doctor, venues | Fleet |
| `/fleet`: partly paused, two Valkeys that disagree, resume and its reserve, bulk retry and remove, cancel every held job, the delayed split | Fleet part paused |
| Host registry row, host budget, waiters, orphans, the doctor result in full | Host detail |
| The 14 venue properties, serves, custody, floors, OpenShell engine, mode and gateway | Venue detail |
| `/config`: settings, triggers, pause windows, scoped limits, projects, MCP servers, packages | Configuration |
| Every trigger rule: kind, selectors, forge, flow, options, last run, next fire, one-shot state, pause windows | Triggers |
| A trigger's fields, trust model, cron health, one-shots, edit and delete | Trigger detail |
| `trigger-add` for all five kinds, with the fields only the file can set | Add a trigger |
| Secret profiles and bundles, resolver roots, add and remove | Secrets |
| Forges, egress per host, model endpoints, provider keys by name, notifications, MCP, staged packages | Connections |
| Projects: members, spend, limits, allocation, size suggestions with the exact call | Project detail |
| `/audit`: rows, roles, digests, reserve, bulk count, damaged rows | Audit |
| `/login`, `/login/code`, session ends, roles, read-only console | Sign-in, Access states |
| HTML error pages: 404, 421 | Error |
| Every write: preview, reserve sentences, ticket expiry, refusals, bulk results, audit row, undo | Actions and confirm, Confirm states |
| Live updates: the live pill, panels kept still while in use, read failures, stale data, the transcript stream, stream limits | Live states |

What this design asks the repo for, because the repo cannot do it yet:
- why a session ended on `/login` (#711);
- setup from the browser after one command (`up --console`): a supervisor limited to starting, stopping and restarting pi-dispatch's own services, doctor runs, write-only `.env` fields for a closed list of key names, viewer tokens, and GitHub's app-manifest flow;
- tabs and sub-routes for the Spend views;
- a list view of the flows map;
- "Fire now" for a cron trigger in the console (today: `pi-dispatch run --trigger`);
- a read-only check that matches a described event against the triggers file, as the receiver would;
- Jev or another decision model as a `decide` tool in watch jobs, and in shadow at the gate, its record shown beside what happened (#743);
- board proposals from watch jobs that a person adopts as reviewed config, drawn by the console's own blocks, never agent HTML (#743);
- per-run spend rate and cap projection, context use and mid-run proposals, so long jobs read the same as short ones;
- dispatchers: a trigger whose job reads git changes and infra streams and may only start listed jobs and propose triggers, with wider outbox chaining than today (other folders and repositories, more than 2 requests) and a Jev loop engine that runs like the GitHub poller;
- Triggers as a page of its own, with Watch as its second tab;
- delivery health for webhooks, which the receiver does not publish;
- sandboxes from the console:
  - a `pi-dispatch-open://` opener on the person's computer that types the sandbox command into their terminal and waits for Enter;
  - a sandbox with no run (`pi-dispatch sandbox --new <repo> --ref <ref>`), cloned with a read-only token that is dropped before the shell starts;
  - the list of open sandbox shells, and an SSH target per host;
- a touch record per run (who touched it and why), with question themes and standing answers, for Zero touch;
- answer rules: a hand-written rule that starts a draft job when a run parks, which classifies the question and drafts an answer from cited sources for a person to send;

These are issue #753, with the specs as proposed entries (`REQ-SANDBOX-FROM-THE-CONSOLE`, `REQ-ZERO-TOUCH-RATE`, `REQ-PARKED-ANSWERER`).

Proposed only, not asked for: a browser terminal through a separate sandbox gateway. It reverses a recorded decision (specs/design.md, #642 and #641), so issue #754 decides it first, recorded as `OQ-050`.

## Sample data

- Every card draws one deployment: Thursday 8 October 2026 at 15:39 UTC, three hosts, five projects, seven triggers. `tools/fixture.py` holds it, and the *sample deployment* card draws it.
- `tools/check_fixture.py` reads every built card and names any run drawn with another target, host or venue than the fixture's, or a venue its host does not run. Run it after the generators; it is 0 today.
- GitLab merge requests are written project!iid, as the run record writes them. build3 runs podman only; mini2 runs local, openshell and openshell-bind.

## Projects

- Every run, waiting job and needs-you row shows its project as a `ptag`: the name written out ("web", "api", "billing", "ops"). Colour stays reserved for status.
- Timelines group rows by project by default, with the repositories under the name; Host is the other grouping.
- The project filter is a row of chips with run counts.

## Waiting

- *In line* means a job that has not started. Every waiting job says what it waits for, in one of these reasons:
  - **a free slot**: names the host, and what holds the slot if something does;
  - **another run to finish**: a chained job, named after its parent;
  - **a time or a check**: a held job, such as "after 07:00 UTC, then CI green";
  - **retry backoff**: the attempt and when it is due;
  - **a pause window** or **the soft hold on a cap**, when one applies.
- On a timeline, waiting jobs sit right of the now line as dashed pills on the row of what blocks them:
  - an arrow means "after this run" or "needs this slot";
  - a dotted gap means a delay.
- The Waitlists card counts them by reason and by queue (the shared `pi-jobs`, then each host's queue).
- Parked runs and approvals are not in line. They wait for a person, so they live in *Needs you* and on the Parked page. On a timeline they show as a violet dotted "waiting for you" tail.

## Zero touch and sandboxes

- Runs gets two more tabs: *Zero touch* and *Sandboxes*.
- **Zero touch.** A project's touch rate is the share of its ended runs that needed a person:
  - a person answered a question, decided an approval, re-ran after a failure or a refusal, changed config because of a refusal, steered, or cancelled;
  - a run counts once, however often a person stepped in;
  - merging a pull request is always the person's and never counts, and neither does reading a run or starting one by label.
- The goal is under 5%, drawn as a tick on every meter. A rate above it says *Above goal*, and 30% or more says *High*, so the word carries it and not only the colour.
- Each cause links to the fix that removes it: a sentence in a trigger's instructions, a standing answer, or a config fix. *Fixes that worked* shows the before and after, so the person sees which fixes paid off.
- A parked question, and a draft, are the run's own text, so they show on the run page and nowhere else, as the shipped Parked page already does. Zero touch groups questions by meaning, a person names each group, and the page links to the runs.
- **Answer rules.** When a run of a listed project parks, a draft job classifies the question and drafts an answer from cited sources, only in the categories the person allowed. The person sends it through the usual preview and Confirm, edits it, or answers otherwise. Product decisions, security, money, scope and approvals are never drafted.
- A draft the person sends is still a touch, shown apart as a quicker one. Nothing answers a run without a person: the repo's constitution has no door for that, so it is an open question (`OQ-051`), not a design.
- **Sandboxes.** The console opens a run's kept workspace, or a fresh one with no run, in the person's own terminal. The command is always there to copy. A terminal inside the browser is shown only as a proposal, off by default, because the repo's design rejected it.

## Triggers

- A trigger reads as a rule: **when** something happens (the event first, then who may cause it and where), it **runs** a flow (a dark pill, with the model and venue under it).
- Chips say what a rule adds, each with a glyph and a word: *costs more*, *reaches* and *writes* in yellow, *asks* in violet, *narrows* in blue, and *spent* in grey for a one-shot that fired.
- The forge rules that surprise people get a "good to know" line under the rule:
  - GitHub fires a label rule again on a re-label or a reopen;
  - a comment can pick another rule's flow;
  - on GitLab, adding a label is an update.
- Every rule has one number, the same in the list, the editor, previews and the audit log.
- Triggers is its own page in the nav, with three tabs: Rules, Watch and Dispatchers. Watch rules and dispatchers are triggers too.
- Many dispatchers can run at once, each with its own purpose, inputs, list and caps. The Dispatchers tab leads with each one's purpose, shows one lane per dispatcher for today, a table of which dispatcher reads which input, and the rules that bound them as a group.
- A dispatcher has two powers only: start a job from its list (flow and model), and propose a trigger that a person adopts. It reads git changes and infra streams, and runs as a Jev loop (no model context, every decision priced first) or as an LLM flow (a bounded job today; its own loop once long runs exist).
- A watch rule has a board page:
  - the chain from stream to rules to job to outcome, so every finding says why;
  - a log of every query and decision, kept as records so long runs keep their start;
  - a board that jobs propose changes to and a person adopts. Only adopted blocks carry over, and agent text never does.
  - Decision models such as Jev act inside the read-only job and run in shadow at the gate until their record earns more. They show the state they saw, the question and options, and the probabilities, because they give no reasons.

## Voice

- Write status first and detail after, in plain, quiet sentences. A page headline is a count of what needs the person, or "All clear".
- Every outcome says what happened, why, and what to do. Use the shared prefixes: "Refused:", "Failed:", "Stopped:", "Not run:", "Failed before it started:". An unknown reason shows raw, followed by "no explanation yet".
- Use the shared words: completed, refused, failed, awaiting input, cancelled; venue (local, podman, openshell, openshell-bind); enforced, asserted, absent; spend; held; parked; steer; follow-up.
- Use sentence case everywhere. No all-caps labels, no exclamation marks, no emoji.
- A button names its act ("Answer", "Re-run", "Free slot", "Pause fleet"). The confirm step repeats it with the object and any cost: "Re-run for up to $2.00", "Pause the fleet".
- Numbers:
  - money has 2 decimals ($15.04), with full precision on hover;
  - tokens use separators (125,448), or M with 2 decimals in summaries;
  - CPUs are cores, memory is GiB;
  - durations read 12m, 1h 20m, or 00:12:19 as elapsed time;
  - times are UTC with the zone named, until local time with UTC on hover ships.
- Repository, issue and agent text is untrusted. Escape it, show it plain, and truncate it with an ellipsis. Secrets appear as names only; local paths by their last folder.

## Colour

- **Grounds:** `canvas` for the page, `surface` for cards, `surface-2` for rows and insets inside a card, and `surface-3` for secondary pills and completed timeline pills. Cards are flat.
- **Ink:** `ink`, `ink-muted` and `ink-faint`. Use `ink-faint` only for axes and hints.
- **Primary:** `primary` with `on-primary`: the one solid action per card, the active nav pill and the selected filter. A black pill in light, a white pill in dark.
- **Status:** each status has four tokens. The mark is `<status>`. Text and glyphs use `<status>-ink`. The pastel ground is `<status>-tint`. Text on a solid fill is `on-<status>`. Apply them with a tone class.

| Status | Glyph | Means |
|---|---|---|
| `running` (blue) | dot | In a slot now; the now line |
| `parked` (violet) | speech bubble with ?, or shield for approvals | Waiting for a person. The only violet on a page |
| `failed` (red) | cross | Broke |
| `refused` (orange) | no-entry circle | A rule said no before spend |
| `attention` (yellow) | triangle | A warning: late heartbeat, doctor warning, a held slot, the soft hold |
| `ok` (green) | check | Completed, healthy, under the soft hold |
| `idle` (grey) | clock, hourglass, stop | Held, delayed, cancelled, free, in line |

- Colour is never the only cue: every badge, tag and row carries a glyph and a word.
- Caps follow one rule. Under the 80% soft hold they are `ok`. From the soft hold they are `attention`, and new jobs wait. At the cap they are `failed`, and new jobs are refused.
- Charts by category (flow, model, project) use one hue with labels, never a rainbow.

## Type

- Use the system stack only: `--font-sans` for text and `--font-mono` for ids, commands and config keys. No web fonts (CSP).
- Styles:
  - 44px/800 for page titles;
  - 40px/800 for big numbers (`t-kpi` family);
  - `t-title` (17/24) for card titles;
  - `t-lead` (16/24) for quoted questions;
  - `t-body` (14/20) as the default;
  - `t-small` (12/16) for meta;
  - `t-code` (13 mono) for identifiers.
- Set numbers in tabular figures, and only numbers: counts, money, times and table figures (`.kpi b`, `.count`, `.num`, `.tnum` and the like). On running text, tabular figures also widen hyphens, so an id like gh-2f6a reads "gh - 2f6a".

## Shape and space

- Radius:
  - `radius-lg` (26px) for cards;
  - `radius-xl` (32px) for the sign-in card;
  - `radius-md` (14px) for rows, inputs, quotes and the confirm bar;
  - `radius-pill` for every button, nav item, filter, chip, timeline pill and bar.
- Space: `space-5` inside cards, `space-4` between cards, and `space-6` page gutters at desktop (`space-4` on a phone).
- Layout:
  - `control-h` (48px) is the height of nav pills, filter pills and round buttons;
  - `side-w` (470px) is the right column beside a page's main card;
  - at 390px every page is one column, the nav, project chips, timelines and wide tables scroll inside themselves, and the page never scrolls sideways.

## Components (in `components/bundle.css`)

| Component | Classes |
|---|---|
| Shell | `page`, `top`, `brandpill`, `pillnav`, `roundbtn`, `live` (`--retry`, `--off`), `who`, `titlebar`, `back` |
| Filters | `fpill` (`--on`), `projseg`, `search`, `filterbar` (`--collapsible`, `__toggle`) |
| Card | `card` (`--flush`, `--tint`, `--ring`), `card__head`, `card__sub`, `cards-2/3/4`, `cols`, `stack` |
| Big numbers | `kpi`, `bigpair`, `big`, `tri`, `rows`, `rowpill` |
| Status | `badge`, `chip`, `ptag`, `vtag`, `dot`, `count`, `tile`, `sls` / `sl` |
| Actions | `btn` (`--primary`, `--answer`, `--paid`, `--danger`, `--confirm`, `--confirm-paid`, `--confirm-danger`, `--ghost`, `--sm`, `--lg`, `--round`) |
| Write flow | `diff`, `confirm` (`--paid`, `--danger`), `ticket` |
| Feedback | `outcome`, `banner` (`--sm`), `empty`, `collapsed` |
| Data | `tbl` (`--stack`), `tbl-wrap`, `tbl-foot`, `pager`, `facts` (`--1`, `--3`), `fact` |
| Levels | `meterrow`, `pbar`, `capbars` / `cap`, `ring`, `sd`, `phases`, `pnone` |
| Timeline | `tl-wrap`, `tl`, `tl__h`, `tl__r` and the SVG classes `tp--*`, `tnow`, `tl-future`, `dep`, `gapline`, `tail` |
| Waitlists and hosts | `wl`, `wl__g`, `wbar`, `qrow`, `qp`, `hosts`, `hostrow` |
| Transcript | `tx`, `tx__e` (`--user`, `--assistant`, `--error`, `--note`, `--compaction`, `--restart`, `--skipped`, `--end`, `--forkpoint`), `tx__fork` |
| Fields | `field` (`--err`), `input` (`--code`), `select`, `textarea`, `cmd`, `seg`, `tabs` |
| States | the Confirm states and Live states cards: previewing, no change, reserve sentences, refusals, bulk results, live, reconnecting, not live, kept still while in use, shown as last seen |

- Every write is two steps: preview, then Confirm.
  - The preview opens in a `confirm` bar below the card that asked, never inside a table cell.
  - It lists what will happen, an Undo line, and when the preview ticket expires.
  - Paid confirms fill yellow; destructive confirms fill red.
- After a write, a `banner` names the change, links its audit row and offers Undo.

## Built for the CSP

- No `style=` attributes and no inline scripts, in one stylesheet.
- Each preview keeps its page-only rules in a small `<style>` block so the card renders on its own. In the console they join `bundle.css`, prefixed by page, so the CSP's `style-src 'self'` holds.
- Positions and levels are SVG attributes: timeline pill `x` and `width` in percent, bar widths, ring dash lengths.
- Tones are classes that set `--tone`, `--tone-ink`, `--tone-tint` and `--on-tone`.
- Panels stay `section#p-<name>[data-panel]` and are self-contained, so live updates can swap them whole.

## Iconography

- Glyphs are inline SVG symbols on a 24px grid in one sprite per page: a 1.8px stroke with round caps, or a solid fill for the running dot, the stop square and the pause bars. Reference them with `<use href="#i-name">` and size them with `ic`, `ic--sm` or `ic--lg`. They take `currentColor`.
- No Unicode symbols in the UI. The terminal panel's ● ✔ ⚠ ✘ map to the running, done, attention and failed glyphs.

## Accessibility

- Every text pair meets WCAG AA in both themes.
- Use a skip link, `role="status"` on the live pill, `role="meter"` or an `aria-label` on every bar, ring, capsule and timeline row, and `aria-live` on confirm previews.
- Focus is a 2px `focus` ring, offset 2px.
- Viewers never see reasons, transcripts, phase names, chat, the audit log or action buttons.
- Reduced motion: only the live dot pulses, and only when motion is allowed.
