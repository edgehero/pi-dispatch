"""Component cards for the Pulse system: each shows one family in its states, built from the shared kit."""
from pulse import *
import gen_overview as ov

G = "Components"
def comp(name, height, title, body, style="", width=960, subtitle=""):
    return write(name, card_marker(G, height, width, subtitle or title), title,
                 f'<main class="page cmp">{body}</main>', ".cmp { padding: var(--space-4); } .cmp-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; } .cmp-l { font-size: 12px; font-weight: 650; color: var(--ink-muted); margin: 6px 0 -4px; }" + style)

def L(t): return f'<p class="cmp-l">{t}</p>'

# 1 Shell
comp("Shell", 470, "Shell", f"""
{L('Top bar, operator, live')}{topbar('Runs', 1, 'operator', 'live')}
{L('Top bar, viewer, reconnecting: no Audit, no actions')}{topbar('Overview', 1, 'viewer', 'retry')}
{L('Title bar with filters')}{titlebar('Runs', '', ov.projseg() + '<button class="fpill" type="button">Outcome: <b>Any</b>' + ic('chev', 'ic ic--sm') + '</button>')}
""", width=1440, subtitle="Top bar with pill nav, live state and the person; title bar with filters")

# 2 Status
OUTS = ["running", "awaiting", "approval", "completed", "failed", "refused", "attention", "cancelled", "held", "delayed", "ok"]
comp("Status", 520, "Status", f"""
{card('Outcome and state badges', '<div class="cmp-row">' + ''.join(badge(k) for k in OUTS) + '</div>', sub='glyph and word always, colour third')}
{card('Tags', '<div class="cmp-row">' + ''.join(tag(p) for p in ['web', 'api', 'billing', 'ops']) + ''.join(venue(v) for v in ['local', 'podman', 'openshell', 'openshell-bind']) + '</div>', sub='project tags are names, venue tags are outlined')}
{card('Chips, counts, dots, slots, tiles', '<div class="cmp-row">' + chip('60% of cap', 'ok') + chip('longest 2h 14m') + chip('live', 'running', 'running') + '<span class="count tone-parked">1</span><span class="count tone-attention">4</span><span class="dot tone-ok"></span><span class="dot tone-attention"></span><span class="dot tone-failed"></span><span class="sls">' + slots('rhf') + '</span>' + ''.join(f'<span class="tile tone-{t}">{ic(i)}</span>' for t, i in [('parked', 'parked'), ('failed', 'failed'), ('refused', 'refused'), ('attention', 'fleet'), ('ok', 'spend'), ('idle', 'clock')]) + '</div>')}
""", subtitle="Badges, project and venue tags, chips, counts, dots, slots and icon tiles")

# 3 Actions and confirm
comp("Actions", 820, "Actions and confirm", f"""
{card('Buttons', '<div class="cmp-row">' + btn('Open Fleet', 'primary', sm=False) + btn('Spend', sm=False) + btn('Answer', 'answer', 'parked', sm=False) + btn('Re-run', 'paid', 'rerun', sm=False) + btn('Pause fleet', 'danger', 'pause', sm=False) + btn('See why', 'ghost', sm=False) + '<button class="btn" type="button" disabled>Re-run</button></div>', sub='one solid pill per card; paid and destructive are outlined until confirm')}
<div class="cards-3">
{confirm('safe', 'Set maxTurns to 40', ['maxTurns: <b>30</b> to <b>40</b>', 'Applies to jobs that start after you confirm'], 'Set maxTurns back to 30', 'Confirm')}
{confirm('paid', 'Re-run gh-f0c2', ['Starts a new run of acme/web#491, flow fix, on mini1', 'Reserves up to <b>$2.00</b> before it spends'], 'Cancel the new run', 'Re-run for up to $2.00')}
{confirm('danger', 'Pause the fleet', ['Pauses every queue: nothing new starts', 'Running jobs finish', 'Valkey <span class="code">redis://127.0.0.1:6399/0</span>'], 'Resume the fleet', 'Pause the fleet')}
</div>
""", subtitle="Buttons by kind of act, and the confirm bar in its safe, paid and destructive forms")

# 4 Cards, banners, empty
comp("CardsAndBanners", 1060, "Cards, banners and empty states", f"""
<div class="cards-3">{ov.needs_card()}{ov.inline_card()}{ov.spend_card()}</div>
{outcome('refused', 'Refused', 'Refused: the egress proxy is not running on build3.', 'Start the egress proxy, then re-run. <b>Nothing was spent.</b>', btn('Open Fleet', 'primary', sm=False) + btn('Preview a re-run', 'paid', 'rerun', sm=False))}
{banner('ok', 'done', 'Changed maxTurns from 30 to 40', 'Audit row 7. <b>Undo:</b> set maxTurns back to 30.', btn('Undo', 'ghost'))}
{banner('attention', 'beat', 'Console not reachable, retrying', 'The page stays as it was. Live panels resume when the console answers.', '', True)}
{banner('failed', 'fleet', 'No worker online', 'No host has sent a heartbeat for 2 minutes, so nothing will start.', btn('Open Fleet'), True)}
<div class="cards-2">{card('Empty state', '<div class="empty"><span class="tile tone-ok">' + ic('done') + '</span><b>All clear</b><span>No questions, failures or refusals in the last 24 hours.</span></div>')}
<div class="stack"><p class="collapsed">{ic('runs', 'ic ic--sm')}<b>Chain</b> no parent, no children</p><p class="collapsed">{ic('queue', 'ic ic--sm')}<b>Run record, tokens and resources</b> are written when the run ends</p></div></div>
""", subtitle="KPI cards, the outcome banner, notice banners, empty states and one-line collapsed sections")

# 5 Data table
RUNS = [("15:30", "gh-e9a0", "acme/billing#260", "billing", "fix", "build3", "podman", "refused", "Refused: the egress proxy is not running on build3.", "-", "not metered"),
        ("15:25", "gh-a91e", "acme/web#422", "web", "fix", "mini2", "openshell", "completed", "", "85,577", "$0.17"),
        ("15:13", "gh-2f6a", "acme/api#131", "api", "triage", "mini1", "local", "awaiting", "Waiting for an answer on acme/api#131.", "125,448", "$0.21"),
        ("15:10", "gh-f0c2", "acme/web#491", "web", "fix", "mini1", "local", "failed", "Failed: the container runtime never handed control to the job.", "85,577", "$0.17"),
        ("14:48", "gh-ebd7", "acme/billing#259", "billing", "fix", "build3", "podman", "completed", "", "186,938", "$0.36")]
rows = "".join(f'<tr><td class="when" data-l="">{w}</td><td class="id"><a href="#">{j}</a></td><td class="tgt wide"><a href="#">{t}</a></td><td>{tag(p)}</td><td>{f}</td><td>{h}</td><td>{venue(v)}</td><td class="wide">{badge(o)}{f"<span class=reason>{r}</span>" if r else ""}</td><td class="num">{tk}</td><td class="num">{c}</td></tr>' for w, j, t, p, f, h, v, o, r, tk, c in RUNS)
comp("DataTable", 470, "Data table", card("Runs", f'<div class="tbl-wrap"><table class="tbl tbl--stack"><thead><tr><th>When</th><th>Job</th><th>Target</th><th>Project</th><th>Flow</th><th>Host</th><th>Venue</th><th>Outcome</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>{rows}</tbody></table></div><p class="tbl-foot">5 of 27 runs<span class="pager">{btn("Newer", "ghost")}{btn("Older")}</span></p>', flush=True),
     subtitle="Table in a flush card: ids whole, outcome badge with its reason; it becomes stacked rows on a phone")

# 6 Facts and levels
comp("FactsAndLevels", 760, "Facts and levels", f"""
{card('Fact grid', facts([('Job', '<span class="code">gh-b3d7</span>'), ('Target', '<a class="link" href="#">acme/web#415</a>'), ('Project', tag('web')), ('Venue', venue('local')), ('Host', 'mini1'), ('Model', 'anthropic / claude-sonnet-5-5'), ('Started', '15:27 UTC'), ('Size', '2,048 MiB, 1 CPU')]))}
<div class="cards-2">
{card('Meters against caps', meterrow('Jobs', 'today', 25/40, '25', '40') + meterrow('Dollars', 'deployment today', .86, '$21.50', '$25.00') + meterrow('Tokens', 'today', 1.0, '8.00M', '8.00M'), sub='the tick is the 80% soft hold')}
{card('Phases', phases(['survey', 'migrate the schema', 'verify', 'report'], 1, 3, 10) + '<p class="card__sub" style-x="">Where a worker reports no progress, the bar is striped:</p><span class="pnone"></span>'.replace(' style-x=""', ''))}
</div>
<div class="cards-2">{card('Capsules', '<div class="capbars">' + ''.join(capsule(*c) for c in ov.CAPS[:5]) + '</div>')}
{card('Rings and spend dots', '<div class="cmp-row">' + ring(.6, 'ok', label='60%') + ring(.86, 'attention', label='86%') + ring(1, 'failed', label='100%') + '</div>' + spend_dots())}</div>
""", subtitle="Fact grid, meters with the soft-hold tick, phases, capsules, rings and the spend dots")

# 7 Timeline and waitlists
comp("TimelineAndWaitlists", 900, "Timeline and waitlists", f"""
{ov.tl_card(ov.ROWS_PROBLEM[4:])}
{ov.waitlists()}
""", width=1100, subtitle="Runs by project with waiting jobs after the now line, and the waitlists card")

# 8 Transcript
comp("Transcript", 820, "Transcript", card("Live transcript", '<ol class="tx">' + "".join([
    tx("user", "15:27:31", "Issue acme/web#415: the checkout page double-charges when the user presses Pay twice. Labels: pi, bug"),
    tx("assistant", "15:27:38", "I'll start by surveying the checkout flow and the payment handler to find where a second submit is not guarded."),
    tx("call", "15:27:48", '<details><summary>arguments</summary><pre>{"path":"src/checkout/PayButton.tsx"}</pre></details>', label="read"),
    tx("result", "15:27:49", '<details><summary>result, 212 lines</summary><pre>export function PayButton(...)</pre></details>', label="read", trunc=True),
    tx("error", "15:29:10", '<details open><summary>result</summary><pre>FAIL checkout.test.ts: expected 1 charge, received 2</pre></details>', label="bash"),
    tx("steer", "15:31:02", "From ops: keep the idempotency key in the existing payments table."),
    tx("compaction", "15:33:40", "Context compacted: 48,210 tokens summarised."),
    tx("restart", "15:34:02", "Recovered from checkpoint 3 after the worker restarted. Attempt 2."),
    tx("note", "15:35:10", "Phase 2 of 4: migrate the schema."),
    tx("skipped", "15:36:00", "Tool call skipped on replay: already applied."),
    tx("end", "15:41:12", "Run ended: completed."),
]) + "</ol>", end=chip("live", "running", "running")), subtitle="Every entry kind, with times, folded arguments and results, and the truncated flag")

# 9 Fields, diff, command
comp("FieldsDiffCommand", 640, "Fields, diff and command", f"""
<div class="cards-2">
{card('Fields', '<div class="stack"><div class="field"><label for="f1">Key</label><select id="f1" class="select"><option>maxTurns</option></select></div><div class="field"><label for="f2">Value</label><input id="f2" class="input" value="40"></div><div class="field field--err"><label for="f3">Key</label><input id="f3" class="input input--code" value="colour"><p class="field__err">' + ic('failed', 'ic ic--sm') + 'Unknown key colour. Valid keys: model, provider, maxTurns, dailyCap, weeklyCap, monthlyCap, maxTokens, dailyTokenCap, concurrency, softHoldPct, maxCostUsd, dailyCostUsd, weeklyCostUsd, monthlyCostUsd.</p></div><div class="field"><label for="f4">Your answer</label><textarea id="f4" class="textarea" placeholder="Write your answer"></textarea></div></div>')}
<div class="stack">{card('Diff preview', diff('settings.json', [('gap', '…'), ('ctx', '  "model": "claude-sonnet-5-5",'), ('ctx', '  "provider": "anthropic",'), ('del', '  "maxTurns": 30,'), ('add', '  "maxTurns": 40,'), ('ctx', '  "maxTokens": 400000,'), ('gap', '…')]))}
{card('Command copy box', cmd('pi-dispatch chat gh-b3d7') + '<p class="card__sub">Run this on a host that holds the session store.</p>' + cmd('pi-dispatch sandbox gh-e9a0'))}</div>
</div>
""", subtitle="Fields with a refusal by name, the diff preview and the command copy box")

READMES = {
 "Shell": "The shell every page shares: a top bar with the pi-dispatch pill, pill navigation, the live state and the signed-in person, then a title bar with the page's filters.\n\nUse `shell(active, inner, title, sub, end)` from the kit. Navigation order is Overview, Runs, Parked, Triggers, Fleet, Spend, Configuration, then More (Models, and Audit for operators). The delivered compact Watch screen is linked from Configuration; this planned Triggers screen will give it a tab. The Parked count is violet and counts questions and approvals together. The live pill says Live, Reconnecting or Not live. A viewer sees no Audit and no action buttons. At 390 the nav becomes a pill row that scrolls inside itself.",
 "Status": "The status vocabulary: one glyph, one word and one tone for every state, plus project tags, venue tags, chips, counts, slot dots and icon tiles.\n\nUse `badge(kind)` for outcomes and states, never colour alone. Project tags are the project's name on a neutral pill; venue tags are outlined. Slot dots: filled blue for running, yellow ring for held, empty ring for free.",
 "Actions": "Buttons by kind of act, and the two-step confirm bar.\n\nOne solid pill per card for the step forward. Answer is violet and only for parked runs. Paid acts (re-run, retry, adopt a model) are outlined in yellow, destructive acts (pause, cancel, remove, decline) in red, until the confirm bar, where the confirm button fills. Every confirm bar lists what will happen, an Undo line and the preview ticket's expiry, and opens below the card that asked, never inside a table cell.",
 "CardsAndBanners": "Cards are the one container; banners and empty states say what happened and what to do.\n\nKPI cards lead with one big number. The outcome banner leads every run page that has ended, with the outcome word, the reason sentence and the next step. Notice banners cover after-write success (with Undo), reconnecting, and no worker online. Sections with nothing to show collapse to one line.",
 "DataTable": "Tables sit in a flush card, scroll inside their own box, and become stacked rows on a phone.\n\nIds never break. The outcome cell is a badge plus its reason sentence. Numbers are right-aligned with separators. Every run row carries its project tag. Mark cells `wide` to span the full row and give each a `data-l` label for the phone layout.",
 "FactsAndLevels": "Facts and levels: the fact grid, meters with the soft-hold tick, phases with item ticks, capsules, rings and the spend dots.\n\nA meter turns yellow at the 80% soft hold (new jobs wait) and red at the cap (new jobs are refused). Phases show done phases filled, the current phase outlined with one tick per item, and later phases empty. A striped bar means the worker reports no progress.",
 "TimelineAndWaitlists": "The pill timeline groups runs by project. Waiting jobs sit after the now line as dashed pills, next to what they wait for, and the Waitlists card counts them by reason and by queue.\n\nCompleted runs are quiet grey pills. Only running, parked and failed runs carry colour and labels. An arrow means \"after this run\" or \"needs this slot\". A dotted gap means a delay.",
 "Transcript": "Transcript entries for every kind: user, assistant, tool call, tool result, steer, compaction, note, restart, skipped and end.\n\nEach entry has its time on the right and a kind label with an icon on the left. Arguments and results fold. A truncated entry says so. In fork mode, each entry offers Fork from here.",
 "FieldsDiffCommand": "Form fields, the diff preview and the command copy box.\n\nFields refuse unknown input by name and list what is valid. Closed lists are selects. Every configuration edit previews as a diff with - and + lines before Confirm. Commands come in a copy box, with the host they must run on said in a line below.",
}
for k, v in READMES.items():
    open(f"{ROOT}/{k}/README.md", "w").write(v + "\n")
print("components written")
